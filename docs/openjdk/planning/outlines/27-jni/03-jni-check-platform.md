# 03. JNI 调用参数错了——JVM 怎么检测？— JNI Check + 平台层

> 🟡 Working | 2 KP 中的校验+辅助
> 读者处境: 开发时 JNI 调用 `FindClass(NULL)`→返回 NULL+挂起异常。jniCheck 在 DEBUG 模式检测这些参数——但 release 模式跳过检查 → 生产性能不受影响。

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
