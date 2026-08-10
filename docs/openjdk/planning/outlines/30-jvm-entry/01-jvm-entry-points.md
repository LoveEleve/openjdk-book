# 01. System.currentTimeMillis() 怎么进入 JVM？— JVM Entry Points

> 🔴 Deep | 2 KP 中的 JDK↔JVM 桥
> 读者处境: `System.currentTimeMillis()` 是纯 Java 代码——但它的 native 实现是 `JVM_CurrentTimeMillis()`。这是 JDK 和 JVM 之间的唯一接口——~200 个 JVM_* 函数。

### 1. "jvm.h — 200 个入口的声明"

场景: JDK 编译时链接 `jvm.lib`——每个 `native` 方法的 JVM 侧实现在 jvm.cpp 中的对应 `JVM_*` 函数。

**jvm.h 接口** (`jvm.h:40-1342`):
```cpp
JNIEXPORT jlong JNICALL JVM_CurrentTimeMillis(JNIEnv*, jclass);
JNIEXPORT void  JNICALL JVM_StartThread(JNIEnv*, jobject);
JNIEXPORT jint  JNICALL JVM_IHashCode(JNIEnv*, jobject);
JNIEXPORT jint  JNICALL JVM_GetInterfaceVersion(void);
// ... ~200 functions
```
- 源码: `jvm.h:40-1342` 全部 JVM_* 声明 + `jvm.cpp:100-2000` 实现
- 关键设计: JVM_* 和 JNI_* 是不同层——JVM_* 是 JDK 专用入口(JDK 编译时硬链接)，JNI_* 是用户 Native 代码入口。`Thread.start()`→`JVM_StartThread()`→`os::create_thread`。`System.currentTimeMillis()`→`JVM_CurrentTimeMillis()`→`os::javaTimeMillis()`
- [C++: 每个 JVM_* 函数用 `JNIEXPORT` 导出——在 Linux 上是 `__attribute__((visibility("default")))`。JDK 的 `libjava.so` 通过 `dlsym(RTLD_DEFAULT, "JVM_CurrentTimeMillis")` 动态查找——不需要 link-time resolve]

### 2. "JVM_* 分类"

场景: 200 个入口函数不是随机命名的——它们按功能分五大类(Thread/Class/Memory/System/IO)，JVM 启动时动态注册每个 native 方法。

**五大类** (`jvm.cpp:50-2000`):
```
Thread:   JVM_StartThread/JVM_Sleep/JVM_Interrupt
Class:    JVM_DefineClass/JVM_FindLoadedClass/JVM_GetClassLoader
Memory:   JVM_TotalMemory/JVM_FreeMemory/JVM_MaxMemory
System:   JVM_CurrentTimeMillis/JVM_NanoTime/JVM_ArrayCopy
IO:       JVM_InitializeSocketLibrary/JVM_Available
```
- 源码: `jvm.cpp:50-2000` 分节实现
- 关键设计: JVM_* 大多数是 thin wrapper——`JVM_CurrentTimeMillis()` → `os::javaTimeMillis()`(域1)。少数有实质逻辑——`JVM_StartThread()` → `JavaThread` 创建 + `Threads::add()`

---

### 核心悬念

**"JVM_* Entry Points 是 JDK↔JVM 的桥梁——~200 个函数分 Thread/Class/Memory/System/IO 五大类。"** — 下一篇: JavaCalls + NativeLookup。

> → [02-java-calls.md](02-java-calls.md)
