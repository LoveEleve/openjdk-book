# 03. JNI 调用参数错了——JVM 怎么检测？— JNI Check + 平台层

> 🟡 Working | 2 KP 中的校验+辅助
> 读者处境: 开发时 JNI 调用 `FindClass(NULL)`→返回 NULL+挂起异常。jniCheck 在 DEBUG 模式检测这些参数——但 release 模式跳过检查 → 生产性能不受影响。

> ⚠️ 写作期修正(2026-08-14, vol-02/27-jni/03 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **"宏替换,release 展开为空" 半对**: 机制=**整表替换**——jni_functions()(jni.cpp:3876-3881)在 CheckJNICalls 时返回 checked 表;jni_functions_check(jniCheck.cpp:2304-2323)保存原始表(unchecked_jni_NativeInterface :2306,UNCHECKED() 回调)+断言两表结构一致(:2311-2314);CheckJNICalls product flag 默认 false(globals.hpp:913),-Xcheck:jni 置位(arguments.cpp:2868);release 零开销 ✓
> - **行号全漂**: jniCheck.cpp 共 **2323 行**;JNI_ENTRY_CHECKED 宏 :91-104(线程存在性/Java 线程/env 匹配,abort);functionEnter :222-228(critical 区+check_pending_exception :184-197);functionExit :239-252(**本地引用泄漏**: live>planned 警告 "JNI local refs: N, exceeds capacity: M");add_planned_handle_capacity :202-207(capacity+live+32,CHECK_JNI_LOCAL_REF_CAP_WARN_THRESHOLD=32 :47;PushLocalFrame :720-731/EnsureLocalCapacity :823-835 设置);validate_handle :443/validate_object :469;validate_jmethod_id :453-466→Method::checked_resolve_jmethod_id(method.cpp:2191-2202: NULL/free_method 标记/loader 存活)
> - **"方法签名匹配(release 跳过)" 编造/过度**: 实际=methodID 解析校验+类匹配(validate_call_object/validate_call_class),无"签名匹配"检查
> - **"jniPeriodicChecker 每 ~1 秒检查全局引用泄漏" 编造**: 20-02 已证=JniPeriodicCheckerTask 10ms,os::run_periodic_checks(DO_SIGNAL_CHECK 信号完整性,os_linux.cpp:5381-5394);**泄漏检查在 functionExit,不在周期任务**
> - **"jni.cpp:50-80 函数表" 错**: 结构 JNINativeInterface_ 在 JDK 侧 jni.h:214;实例 jni_NativeInterface 在 jni.cpp:3528-3806;jniExport.hpp 是 **JVMTI 接口导出器**(JniExportedInterface::GetExportedInterface :28-38),非 JNI 函数声明
> - **缺机制(重要)**: JNI_ENTRY_CHECKED **不含 ThreadInVMfromNative**(与 JNI_ENTRY 不同,不做整函数状态转换)——校验点用 IN_VM(:63-68,ThreadInVMfromNative 局部包装)摸堆;错误两级: fatal(ReportJNIFatalError hpp:36-40: 打印 JNI 栈+os::abort(true))/warning(NativeReportJNIWarning);_planned_capacity 字段用途落地(01 篇伏笔);INCLUDE_JNI_CHECK 编译条件
> - **悬念指向 28-jvmti 错**: 正确=**30-jvm-entry**(第 5 批,00-domain-writing-order.md:76)
> - **实证**: 27-jni-check-demo.txt(2000 个 NewLocalRef 泄漏→每 32 个警告 33/66/99...;FindClass 失败不查异常→"JNI call made with exception pending" 警告;无 -Xcheck:jni 0 条警告)

### 1. "jniCheck — DEBUG 模式校验器"

场景: DEBUG JVM 运行——每次 JNI 调用都经过 jniCheck 校验参数合法性。

**jniCheck 校验维度** (`jniCheck.cpp:40-300`):
```
check:
  1. JNIEnv* 匹配当前线程(不能跨线程用 JNIEnv)
  2. jobject is non-null (required params)
  3. jclass/jmethodID/jfieldID 是有效的
  4. 调用栈中没有 pending exception(不能忽略异常继续调 JNI)
  5. 方法签名匹配(release 模式跳过)
```
- 源码: `jniCheck.cpp:40-300` + `jniCheck.hpp:30-80` wrapper functions
- 关键设计: jniCheck 通过宏替换——每个 JNI 函数在 jniCheck.hpp 中被 `#define JNI_ENTRY_CHECKED` wrapper——先调 check→再调真实 JNI 函数。release 模式时这些宏展开为空→零开销
- [C++: `#ifdef ASSERT → JNI_ENTRY_CHECKED` 模式——debug JVM 所有 JNI 调用先检查后执行。每个 check 是 ~50-100 instructions→debug 模式下 JNI 慢 2-3x but catches bugs early]

### 2. "JNI 函数表 — 在哪里？"

**JNI 函数表结构** (`jni.cpp:50-80 + jniExport.hpp`):
```cpp
struct JNINativeInterface_ {
  jint (*GetVersion)(JNIEnv*);
  jclass (*FindClass)(JNIEnv*, const char*);
  // ... ~200 function pointers
};
// 每个 JVM 实例有一个函数表
```
- 源码: `jni.cpp:50-80` 函数表定义 + `jniExport.hpp` extern 声明
- 关键设计: Java 通过 `JNI_GetDefaultJavaVMInitArgs` 拿到函数表→调用任何 JNI 函数通过 `jenv->functions->FindClass(jenv, name)` 的两层间接指针→ JVM 可以在启动时动态填充函数表(支持 JVMTI agent 替换函数)

### 3. "jniPeriodicChecker — 定期检查"

场景: WatcherThread 定期运行 JNI 检查——防止 JNI 全局引用泄漏。

**jniPeriodicChecker** (`jniPeriodicChecker.cpp`):
```
每 ~1秒: check count of global refs → if > warning threshold → WARNING log
             → check thread safety → 确保没有跨线程 JNIEnv 使用
```
- 源码: `jniPeriodicChecker.cpp:40-100`

---

### 核心悬念

**"jniCheck 在 DEBUG 模式对所有 JNI 调用做参数/状态/签名校验——release 模式零开销。JNI 函数表通过两层指针允许 agent 替换。"** — 下一篇: 域28 JVMTI——JVM 的工具接口层。

> → 域28 JVMTI
