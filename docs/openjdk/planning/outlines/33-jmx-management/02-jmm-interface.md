# 02. JDK 怎么查询 JVM 内存状态？— JMM 接口 + JDK Management

> 🟡 Working | 2 KP 中的接口桥
> 读者处境: `ManagementFactory.getMemoryMXBean().getHeapMemoryUsage()` → Management Bean→JMM native call→jmm_GetMemoryUsage()→query MemoryService。

### 1. "jmm.h — JVM Management Interface"

场景: JDK 需要查询 JVM 内部状态——不能直接访问 C++ 对象——通过 JMM(JVM Management) 接口。

**jmm.h 接口** (`jmm.h:40-349`):
```cpp
jmm_GetVersion(JNIEnv*);
jmm_GetOptionalSupport(JNIEnv*, jmmOptionalSupport*);
jmm_GetInputArguments(JNIEnv*, char***);   // 获取 JVM 启动参数
jmm_GetMemoryUsage(JNIEnv*, jboolean heap, jmmMemoryUsage* usage);
jmm_GetThreadInfo(JNIEnv*, jlongArray ids, jint maxDepth, jobjectArray infoArray);
jmm_GetGCStat(JNIEnv*, jmmGCStat* stat);
// ... ~20 functions
```
- 源码: `jmm.h:40-349` 全部 JMM_* 声明 + `services/management.cpp:50-300` 实现
- 关键设计: JMM 是 JDK→JVM 的 management bridge——不同于 JNI(bridge for user native code)，JMM 是 JDK 专用。jmm_GetMemoryUsage → `MemoryService::memory_usage()` → return {init, used, committed, max}
- [C++: JMM 函数和 JNI 函数类似格式——`JNIEXPORT jint JNICALL jmm_GetVersion(JNIEnv*)`——但 jmm 函数不暴露给用户 native 代码——只在 JDK 内部通过 `JMM_Interface` struct of function pointers 访问]

### 2. "JDK C thin wrappers"

场景: `ManagementFactory.getMemoryMXBean()` → 内部通过 JMM_Interface 调 jmm_* 函数。

**java.management/ + jdk.management/** (`java.management/management.cpp:40-200 + jdk.management/`):
```
java.management/ (libmanagement):
  jmm_GetMemoryUsage → Java MemoryMXBean → ManagementFactory
jdk.management/ (libmanagement_ext):
  HotSpotDiagnosticMXBean: dumpHeap(), setVMOption()
  GCInfo composite data(multiple GC details)
```
- 源码: `java.management/management.cpp:40-200` + `jdk.management/management_ext.cpp:40-150`

---

### 核心悬念

**"JMM 接口通过 ~20 个 jmm_* 函数桥接 JDK→JVM。JDK C thin wrappers 暴露为 MXBean——Jconsole/JMC 通过它查询。"** — 下一篇: GC Notifier + Flags。

> → [03-gc-notifier-flags.md](03-gc-notifier-flags.md)
