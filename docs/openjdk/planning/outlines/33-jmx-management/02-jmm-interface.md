# 02. JDK 怎么查询 JVM 内存状态？— JMM 接口 + JDK Management

> 🟡 Working | 2 KP 中的接口桥
> 读者处境: `ManagementFactory.getMemoryMXBean().getHeapMemoryUsage()` → Management Bean→JMM native call→jmm_GetMemoryUsage()→query MemoryService。

> ⚠️ 写作期修正(2026-08-16,33-jmx/02 完成):
> - **"jmm.h:40-349 全部 JMM_* 声明" 错(重要)**: jmm.h 349 行,内容是**一份函数指针结构体** `struct jmmInterface_1_`(:221-343,typedef 名 JmmInterface)——**reserved1+37 个函数指针=38 槽**(不是"~20 个函数");版本常量 :46-55(JMM_VERSION_2=0x20020000,JDK 10 加,当前 JMM_VERSION)
> - **"jmm_GetInputArguments" 编造**: 零命中(JDK8 残留);**"jmm_GetGCStat" 名错**: 真实 **GetLastGCStat**; **"jmmMemoryUsage" 结构编造**: 真实=返回 jobject(MemoryUsage 对象,经 create_MemoryUsage_obj 构造)
> - **"JMM_Interface struct" 名字错**: 真实 typedef 名 **JmmInterface**;JMM 函数不像 JNI 那样 JNIEXPORT 声明——jmm.h 只声明函数指针,实现全在 management.cpp 的全局数组 jmm_interface(:2235-2273,38 槽与 jmm.h 一一对应)
> - **"management.cpp:50-300 实现" 错**: management.cpp **2282 行**;jmm_GetVersion :452 起,38 个 JVM_ENTRY/LEAF 实现分布在 :452-2200
> - **函数表交付机制(大纲漏,重要)**: JVM 侧 `JVM_GetManagement(jint version)`(jvm.cpp:3686)→`Management::get_jmm_interface`(management.cpp:2276-2282,**version==JMM_VERSION 才返回 &jmm_interface,否则 NULL**,INCLUDE_MANAGEMENT 条件编译);JDK 侧=**System.loadLibrary("management")**(ManagementFactory.java:1018-1020)→libmanagement 的 JNI_OnLoad(management.c:38-55)里 `JVM_GetManagement(JMM_VERSION)` 收表存全局 jmm_interface/jmm_version
> - **"java.management/management.cpp:40-200" 错**: 真实=java.management/share/native/libmanagement/**management.c**(62 行)+各 Impl.c(MemoryImpl.c:35-48 三兄弟一行一表调用)
> - **"jdk.management/management_ext.cpp:40-150" 错**: 真实=jdk.management/share/native/libmanagement_ext/**七个 .c/.h 文件**(management_ext.c/h+DiagnosticCommandImpl.c+Flag.c+GarbageCollectorExtImpl.c+GcInfoBuilder.c+HotSpotDiagnostic.c);libmanagement_ext 加载者=PlatformMBeanProviderImpl.java:53-59 静态块,同款 JNI_OnLoad(management_ext.c:31-54)
> - **GetLastGCStat 协议(大纲漏,重要)**: GcInfoBuilder.getLastGcInfo0(GcInfoBuilder.c:199-240)=**调用者先填 jmmGCStat 槽**(usage_before_gc/usage_after_gc/ext 数组,jmm.h:185-195 注释)→hotspot jmm_GetLastGCStat(management.cpp:1831-1892,get_last_gc_stat :1845 双缓冲读/gc_index==0 返回 null/survivor max 特例 :1874)→表调用返回后 jvalue 按类型写回(switch :255-282);实证 id=1 duration=7ms beforePools=8 afterPools=8
> - **JMM 的"写"接口(03 篇伏笔)**: SetPoolSensor(management.cpp:601-643,Java sun.management.Sensor 挂到 pool 传感器槽)/SetPoolThreshold(:644-703)/SetGCNotificationEnabled(:1893-1900,GCMemoryManager._notification_enabled 门)
> - **实证**: setVerbose(true)→jmm_SetBoolAttribute(:778 JMM_VERBOSE_GC→MemoryService::set_verbose→LogConfiguration 打出 gc 日志;getCurrentThreadAllocatedBytes 1MB delta=1048592(GetThreadAllocatedMemory :2126)
> - 素材: 33-jmx-jmm-demo.txt

### 1. "jmm.h — JVM Management Interface"

场景: JDK 需要查询 JVM 内部状态——不能直接访问 C++ 对象——通过 JMM(JVM Management) 接口。

**jmm.h 函数表契约** (`jmm.h:221-343`):
```cpp
typedef struct jmmInterface_1_ {   // typedef 名 JmmInterface
  void*        reserved1;
  jlong        (JNICALL *GetOneThreadAllocatedMemory)(JNIEnv*, jlong thread_id);
  jint         (JNICALL *GetVersion)(JNIEnv*);
  jint         (JNICALL *GetOptionalSupport)(JNIEnv*, jmmOptionalSupport*);
  jint         (JNICALL *GetThreadInfo)(JNIEnv*, jlongArray, jint, jobjectArray);
  jobjectArray (JNICALL *GetMemoryPools)(JNIEnv*, jobject);
  jobjectArray (JNICALL *GetMemoryManagers)(JNIEnv*, jobject);
  jobject      (JNICALL *GetMemoryPoolUsage)(JNIEnv*, jobject);
  jobject      (JNICALL *GetPeakMemoryPoolUsage)(JNIEnv*, jobject);
  jobject      (JNICALL *GetMemoryUsage)(JNIEnv*, jboolean heap);
  // ... 共 reserved1+37=38 槽,到 SetDiagnosticFrameworkNotificationEnabled(:223-342)
}
```
- 源码: `jmm.h:221-343` 函数表 + `services/management.cpp:2235-2273` 全局数组 + `jvm.cpp:3686` 交付
- 关键设计: JMM 是 JDK→JVM 的 management bridge——不同于 JNI(bridge for user native code)，JMM 是 JDK 专用。函数表=纯数据(指针数组),无注册/查找机制,整个表一次交付;版本不匹配(version!=JMM_VERSION)直接拒绝
- [C++: jmm 函数实现格式=JVM_ENTRY/JVM_LEAF 家族(management.cpp:452 起 38 个),实体在 jmm_interface 数组;JDK 侧通过 JmmInterface* 函数指针间接访问,不经 JNI 符号解析]

### 2. "JDK C thin wrappers"

场景: `ManagementFactory.getMemoryMXBean()` → 内部通过 JmmInterface 调 jmm_* 函数。

**java.management/ + jdk.management/** (`java.management/share/native/libmanagement/management.c:38-55 + jdk.management/share/native/libmanagement_ext/`):
```
java.management/ (libmanagement,ManagementFactory.java:1018-1020 加载):
  JNI_OnLoad(management.c:38-55)收表 → MemoryImpl.c:35-48 三兄弟一行一表调用
jdk.management/ (libmanagement_ext,PlatformMBeanProviderImpl.java:53-59 加载):
  HotSpotDiagnostic.c:35 dumpHeap0 / GcInfoBuilder.c:199 getLastGcInfo0 /
  DiagnosticCommandImpl.c:45 GetDiagnosticCommands / Flag.c:46 GetLongAttribute
```
- 源码: `management.c:38-55` + `MemoryImpl.c:35-48` + `GcInfoBuilder.c:199-240` 等
- 关键设计: 两个库共享同一张表(JMM 无版本分叉);薄封装——每个 native 方法就是一行表调用;GcInfo 走"调用者填槽"协议(jmmGCStat 由 Java 侧预先填 before/after 数组)

---

### 核心悬念

**"JMM 接口通过 38 槽函数指针表(jmm.h struct jmmInterface_1_)桥接 JDK→JVM;JVM_GetManagement+JNI_OnLoad 两次握手交付;JDK C thin wrappers 暴露为 MXBean——Jconsole/JMC 通过它查询。"** — 下一篇: GC Notifier + Flags。

> → [03-gc-notifier-flags.md](03-gc-notifier-flags.md)
