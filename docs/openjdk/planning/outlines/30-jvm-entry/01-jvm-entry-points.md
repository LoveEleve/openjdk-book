# 01. System.currentTimeMillis() 怎么进入 JVM？— JVM Entry Points

> 🔴 Deep | 2 KP 中的 JDK↔JVM 桥
> 读者处境: `System.currentTimeMillis()` 是纯 Java 代码——但它的 native 实现是 `JVM_CurrentTimeMillis()`。这是 JDK 和 JVM 之间的唯一接口——~200 个 JVM_* 函数。

> ⚠️ 写作期修正(2026-08-14, vol-02/30-jvm-entry/01 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **"jvm.h:40-1342" 微漂**: jvm.h 1342 行、**182 个 JNIEXPORT**(非 ~200 函数);版权 1-36、头注释 38-55、函数自 :59;JVM_INTERFACE_VERSION 6(:57)
> - **"dlsym 动态查找" 编造**: 真实=System.c:39 `(void *)&JVM_CurrentTimeMillis` **编译期取址** + libjava.so 以 ELF 链接期 UND 符号引用(nm 实证 131 个 `U JVM_*@SUNWprivate_1.1`)+ 运行时动态链接器解析;**导出名单=版本脚本 hotspot/jvm_sym.ver**(`JNI_*; JVM_*; jio_*; AsyncGetCallTrace; local: *;`,SUNWprivate_1.1 节点)
> - **"JVM_* 分五大类(Thread/Class/Memory/System/IO)" 编造**: 真实=jvm.h:38-55 头注释 **"three parts"**(①标准 API 的 native 库需要的 VM 函数(如 Object wait/notify)②字节码验证器/类文件格式检查器函数 ③标准 I/O 与网络 API);jvm.cpp(3793 行)非分节,按需排布(CurrentTimeMillis :271/IHashCode :605/GetCallerClass :706/DefineClass :949/FindLoadedClass :962/StartThread :2857)
> - **"jvm.cpp:100-2000" 漂**: 函数分布 :263-:3790
> - **缺机制(重要)**: ①**注册链**: System.java:396 native currentTimeMillis → System.c:25-48 注册表(注释 "Only register the performance-critical methods",仅 3 个: currentTimeMillis/nanoTime/arraycopy)→ Java_java_lang_System_registerNatives(:44-51)RegisterNatives;②**运行时解析**: NativeLookup::lookup(nativeLookup.cpp:527-546): has_native_function() 检查→lookup_base 动态解析(PrintJNIResolving,`-verbose:jni` 打印 "[Dynamic-linking native method ...]")→set_native_function;注册的方法不再动态解析(实证 [Registering JNI native method ...] 后无 Dynamic-linking);③**JVM_ENTRY vs JVM_LEAF 判据=碰不碰堆**: ENTRY(interfaceSupport.inline.hpp:558-565)=thread_from_jni_environment+ThreadInVMfromNative+VM_ENTRY_BASE;LEAF(:588-592)=VM_Exit::block_if_vm_exited+NoHandleMark,不转状态不碰堆(CurrentTimeMillis/NanoTime/GetInterfaceVersion/SupportsCX8 用 LEAF);JVM_ENTRY 与 JNI_ENTRY 差异=JNI_ENTRY 多 WeakPreserveExceptionMark;JVMWrapper(jvm.cpp:254-256,CountJNICalls 计数)
> - **悬念指向 02-java-calls ✓**(正确,保留)
> - **实证**: 30-jvm-entry-demo.txt(-verbose:jni 的 Dynamic-linking vs Registering 对照;nm libjava.so UND 符号;jvm.h 结构)

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
