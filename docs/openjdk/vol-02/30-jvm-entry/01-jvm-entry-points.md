# 01. System.currentTimeMillis() 怎么进入 JVM?— JVM Entry Points

> **前置依赖**:[27-jni/03 — JNI 调用参数错了——JVM 怎么检测?— JNI Check + 平台层](openjdk/vol-02/27-jni/03-jni-check-platform.md):JNI/JVM 入口宏家族与函数表;JVM_CurrentTimeMillis 所在的 jvm.cpp 用同一套 JNI_ENTRY 家族宏;[17-threads/04 — 线程从 Java 进入 VM——这一瞬间怎么保证安全?— interfaceSupport](openjdk/vol-02/17-threads/04-interface-support.md):ThreadInVMfromNative 状态转换的通道;[20-vm-operations/02 — 谁在后台周期性干活?— PeriodicTask、WatcherThread 与启动序列](openjdk/vol-02/20-vm-operations/02-background-init.md):JVM_StartThread 通向 Threads::add 的启动序列
> → **后续**:[30-jvm-entry/02 — C++ 怎么调用 Java 方法?— JavaCalls + NativeLookup](02-java-calls.md)
> 关联域: 42-core-native(libjava 的 native 实现)、27-jni(JNI 是另一张入口表)、01-os(os::javaTimeMillis)

`System.currentTimeMillis()` 是 Java 代码,但实现是 C++。Java 方法怎么"跳"到 C++ 函数?这条链要回答三个问题:

1. 接口面长什么样——`JVM_*` 函数在哪里声明、怎么实现?
2. JDK 的 libjava 怎么接到 JVM 函数——是运行时查表,还是编译期就定好?
3. JVM 侧进门时用什么入口宏——为什么有的函数一行状态转换都不做?

答案会反复落到一句话:**这条链不是 JNI(用户 native 代码 ↔ JVM 的接口),而是 JDK 自身 ↔ JVM 的 `JVM_*` 通道——libjava 在编译期直接取 `&JVM_CurrentTimeMillis`,运行时由 ELF 动态链接器解析 libjvm.so 的导出符号;首次调用时 `NativeLookup::lookup` 做一次动态解析并把入口写进 Method,后续直达;进门时 `JVM_LEAF` 三行完事。**

---

## 1. 开场困惑——"Java 代码怎么跑到 C++"

`System.currentTimeMillis()` 在 Java 侧是一个 native 方法(`System.java` 里的声明),C 侧是 `JVM_CurrentTimeMillis`。中间的桥是一族 **`JVM_*` 入口函数**: `JVM_CurrentTimeMillis`/`JVM_StartThread`/`JVM_IHashCode`...——声明在 `jvm.h`,实现在 `jvm.cpp`。

要区分两类"native ↔ 虚拟机"的接口:

- **JNI**(27 域): 让用户自己的 native 代码调 JVM。用户代码运行时通过 `JNIEnv*->functions` 函数表间接调用。
- **JVM_***: 让 JDK 自带的 libjava 调 JVM。**libjava 编译时直接取 `JVM_*` 函数的地址**——不走函数表、不做运行时查找(除了首次解析)。这是 JVM 给自己人开的内门。

那么这条链的完整形态是: Java 方法表 → `JVM_CurrentTimeMillis` 函数地址。问题是这个地址怎么定下来、进门时 JVM 侧做什么。

---

## 2. 两个朴素方案为什么都不对

### 方案一: 每次调用都通过 JNI 函数表动态查找

既然 JNI 有函数表,那让 `System.currentTimeMillis` 也走 `JNIEnv->functions`,每次调用查表不就统一了?

问题: 函数表查找本身不贵,但 JNI 表查完还要从 `JNIEnv` 反查线程、做一次 `ThreadInVMfromNative` 状态转换(17-04)。`currentTimeMillis` 是极高频调用(时间戳、日志、测量都用它),每次为读一个时钟多做一整套状态转换,代价不可忽略。而且 JNI 函数表是"通用接口",JDK 内部函数走它等于绕远路。

### 方案二: 把 JVM 函数地址硬编码进 Java 运行时

反过来,如果编译 Java 运行时时直接把 `JVM_CurrentTimeMillis` 的地址写进代码,快是够快,但 JVM 和 JDK 被焊死——JDK 想换一个 JVM 实现(比如换 GC、换解释器),所有符号链接都得重编,失去模块独立性。

正确方案是两者折中:**libjava 在编译期取 `&JVM_CurrentTimeMillis`(符号引用),运行时由 ELF 动态链接器把符号解析成 libjvm.so 里的实际地址**。编译期定址保证快,ELF 链接保证版本隔离,首次调用的一次 `NativeLookup` 解析把入口固化进 Method 后,后续调用直达。

---

## 3. 接口面——jvm.h 的声明与 jvm.cpp 的实现

`jvm.h`(1342 行,hotspot 的 share/include/ 下,函数自 :68 起,第一个是 `JVM_GetInterfaceVersion`)声明了 **182 个 JNIEXPORT 函数**。它的头注释(jvm.h:38-55)自己说明了组织结构——**"three parts"**,不是按功能域分类:

```cpp
// jvm.h:38-55(截取核心,逐字)
/*
 * There are three parts to this file:
 *
 * First, this file contains the VM-related functions needed by native
 * libraries in the standard Java API. For example, the java.lang.Object
 * class needs VM-level functions that wait for and notify monitors.
 *
 * Second, this file contains the functions and constant definitions
 * needed by the byte code verifier and class file format checker.
 * These functions allow the verifier and format checker to be written
 * in a VM-independent way.
 *
 * Third, this file contains various I/O and network operations needed
 * by the standard Java I/O and network APIs.
 */
```

三段 = ①标准 Java API 的 native 库需要的 VM 函数(如 Object 的 wait/notify 要 VM 级监视器操作);②字节码验证器与类文件格式检查器需要的函数(让验证器可以独立于 VM 实现);③标准 I/O 与网络 API 需要的操作。接口版本号 `JVM_INTERFACE_VERSION 6`(jvm.h:66)提醒 JDK 侧: 改 `JVM_*` 或 VM 与 Java 类的约定都要 bump 版本。

实现侧 jvm.cpp(3793 行)不是按三段分节的——函数按需排布: 纯系统操作在头部(`JVM_CurrentTimeMillis` :271),类/对象操作在中部(`JVM_IHashCode` :605、`JVM_GetCallerClass` :706、`JVM_DefineClass` :949、`JVM_FindLoadedClass` :962),线程操作在尾部(`JVM_StartThread` :2857)。

---

## 4. JDK 侧怎么接上——编译期取址 + ELF 链接

### registerNatives 注册表

`System.currentTimeMillis` 的 native 声明怎么连到 `JVM_CurrentTimeMillis`?看 libjava 的 `System.c`(JDK 侧)的注册表:

```cpp
// System.c:25-48(截取核心,逐字)
/* Only register the performance-critical methods */
static JNINativeMethod methods[] = {
    {"currentTimeMillis", "()J",              (void *)&JVM_CurrentTimeMillis},
    {"nanoTime",          "()J",              (void *)&JVM_NanoTime},
    {"arraycopy",     "(" OBJ "I" OBJ "II)V", (void *)&JVM_ArrayCopy},
};
```

`System.registerNatives` 的 C 实现(`Java_java_lang_System_registerNatives`,System.c:44-51)把这些方法 `RegisterNatives` 进 JVM——**`(void *)&JVM_CurrentTimeMillis` 是编译期取址,不是字符串查找**。注释 "Only register the performance-critical methods" 说明只有 3 个走这条捷径,其余 native 方法走标准 JNI 命名解析。

### ELF 链接期符号

libjava.so 编译后,`nm -D lib/libjava.so` 会显示 `U JVM_CurrentTimeMillis@SUNWprivate_1.1` 等 **131 个 UND 符号**——libjava.so 在链接期引用 libjvm.so 导出的 `JVM_*` 符号,运行时由 ELF 动态链接器解析。这是编译期符号引用,不是 `dlsym` 运行时查找。

导出名单来自版本脚本 `hotspot/jvm_sym.ver`:

```
SUNWprivate_1.1 {
  global:
    JNI_*;
    JVM_*;
    jio_*;
    AsyncGetCallTrace;
  local:
    *;
};
```

**`JNI_*; JVM_*; jio_*; AsyncGetCallTrace` 就是 libjvm.so 对 JDK 开出的全部接口面**: JNI 用户通道、`JVM_*` 专属通道、jio_* 控制台 IO 辅助、AGCT 剖析钩子。版本节点 `SUNWprivate_1.1` 与 libjava 的 UND 引用严格对应。

---

## 5. 运行时解析——NativeLookup::lookup

### 首次调用的动态解析

native 方法首次执行时要"解析"——`NativeLookup::lookup`(nativeLookup.cpp:532-546)检查 `has_native_function()`,没有才走 `lookup_base` 动态查找:

```cpp
// nativeLookup.cpp:532-546(截取核心,逐字)
address NativeLookup::lookup(const methodHandle& method, bool& in_base_library, TRAPS) {
  if (!method->has_native_function()) {
    address entry = lookup_base(method, in_base_library, CHECK_NULL);
    method->set_native_function(entry,
      Method::native_bind_event_is_interesting);
    // -verbose:jni printing
    if (PrintJNIResolving) {
      ResourceMark rm(THREAD);
      tty->print_cr("[Dynamic-linking native method %s.%s ... JNI]",
        method->method_holder()->external_name(),
        method->name()->as_C_string());
    }
  }
  return method->native_function();
}
```

### "注册"的本质

`-verbose:jni` 下完整链条摊开:

```
[Dynamic-linking native method java.lang.System.registerNatives ... JNI]
[Registering JNI native method java.lang.System.currentTimeMillis]
[Registering JNI native method java.lang.System.nanoTime]
[Registering JNI native method java.lang.System.arraycopy]
```

`registerNatives` 本身是动态解析的(System.c 的 `Java_java_lang_System_registerNatives` 走标准 JNI 命名绑定);它注册的 3 个方法之后**整次运行不再出现 Dynamic-linking**——`set_native_function` 把入口写进 Method,后续调用直达 `JVM_*` 地址。**"注册"的本质是: 把动态查找提前、并且把入口固定为编译期已知的 JVM_* 符号。**

---

## 6. 进门——JVM_ENTRY 家族

`JVM_*` 函数体第一行都是 `JVMWrapper`(jvm.cpp:254-256: `CountJNICalls` 时计数,否则空),然后按需选择入口宏。三个常用宏(interfaceSupport.inline.hpp:558-592):

```cpp
// interfaceSupport.inline.hpp:558-565(截取核心,逐字)
#define JVM_ENTRY(result_type, header)                               \
extern "C" {                                                         \
  result_type JNICALL header {                                       \
    JavaThread* thread=JavaThread::thread_from_jni_environment(env); \
    MACOS_AARCH64_ONLY(ThreadWXEnable __wx(WXWrite, thread));        \
    ThreadInVMfromNative __tiv(thread);                              \
    debug_only(VMNativeEntryWrapper __vew;)                          \
    VM_ENTRY_BASE(result_type, header, thread)
```

```cpp
// interfaceSupport.inline.hpp:588-592(截取核心,逐字)
#define JVM_LEAF(result_type, header)                                \
extern "C" {                                                         \
  result_type JNICALL header {                                       \
    VM_Exit::block_if_vm_exited();                                   \
    VM_LEAF_BASE(result_type, header)
```

### JVM_ENTRY: 完整进 VM 通道

`JVM_ENTRY` = 27 域 `JNI_ENTRY` 的同族(差异: JNI_ENTRY 还带 `WeakPreserveExceptionMark`,JVM_ENTRY 没有;`VMNativeEntryWrapper` 是 debug-only)。它做三件事:

1. `thread_from_jni_environment(env)`:从 JNIEnv 反查当前线程;
2. `ThreadInVMfromNative`(17-04 的通道):状态转换 native→VM,伴随 safepoint 检查;
3. `VM_ENTRY_BASE`:建立 HandleMark。

绝大多数 `JVM_*` 用它——`JVM_StartThread`(jvm.cpp:2857)进来后创建 JavaThread、`JVM_DefineClass`(:949)进入类定义流程、`JVM_FindLoadedClass`(:962)查已加载类。

### JVM_LEAF: 不碰堆的三行完事

`JVM_CurrentTimeMillis`(jvm.cpp:271-274)正是 `JVM_LEAF`:

```cpp
// jvm.cpp:271-274(逐字)
JVM_LEAF(jlong, JVM_CurrentTimeMillis(JNIEnv *env, jclass ignored))
  JVMWrapper("JVM_CurrentTimeMillis");
  return os::javaTimeMillis();
JVM_END
```

三行: 不建 handle、不转状态,直接 `os::javaTimeMillis()`(01-os 域的时钟)。`JVM_LEAF` 的宏体只有 `VM_Exit::block_if_vm_exited()` + `VM_LEAF_BASE` 的 `NoHandleMark`——不做状态转换、不碰堆。

**为什么它能用 LEAF**: 它不读堆、不创建引用、不抛异常、不会阻塞——不需要 HandleMark,也不需要进入 VM 状态被 safepoint 管理,`block_if_vm_exited` 挡掉 VM 退出期就够。同族还有 `JVM_NanoTime`(:276)、`JVM_GetInterfaceVersion`(:263)。**一个 `JVM_*` 选哪个宏,主要判据就是"碰不碰堆"。**

---

## 7. 误解澄清与收网

1. **JVM_* 和 JNI 函数表是什么关系?** 两套不同的入口。JNI 是用户 native 代码通过 `env->functions` 函数表间接调用;JVM_* 是 JDK 的 libjava 编译期取址直接调用的函数,不走函数表。
2. **注册是不是每次启动都做?** 是启动时做一次(`System.registerNatives`),但注册的本质是"把动态查找提前、把入口固定为编译期已知的 JVM_* 符号";注册后 `set_native_function` 写进 Method,整次运行不再动态查找。
3. **JVM_LEAF 为什么不需要状态转换?** 因为它不碰堆、不建 handle、不抛异常、不会阻塞——LEAF 宏连 `ThreadInVMfromNative` 都没有,只做 `VM_Exit::block_if_vm_exited`。
4. **jvm_sym.ver 导出的是哪些族?** `JNI_*; JVM_*; jio_*; AsyncGetCallTrace` 四族,版本节点 `SUNWprivate_1.1`,libjava.so 的 UND 符号与之严格对应。
5. **JVM_ENTRY 和 JVM_QUICK_ENTRY 的差异?** `JVM_QUICK_ENTRY`(interfaceSupport.inline.hpp:578-585)用 `VM_QUICK_ENTRY_BASE`——debug 下用 `NoHandleMark` 而非完整 `HandleMark`,适合不创建本地引用的函数;`JVM_ENTRY` 用 `VM_ENTRY_BASE` 建 HandleMark。

把这一篇压成三句话:

- **JVM_* 是 JDK 自身 ↔ JVM 的内门**,libjava 编译期取址(`&JVM_CurrentTimeMillis`),ELF 链接期绑定 libjvm.so 导出符号。
- **首次调用做一次 `NativeLookup::lookup` 解析、`set_native_function` 固化入口**,后续直达。
- **进门宏看碰不碰堆**: 碰堆用 `JVM_ENTRY`(状态转换 + HandleMark),纯函数用 `JVM_LEAF`(三行完事)。

这条链是"Java 调 JVM"。但 JVM 内部还要**反过来**调 Java 方法——比如 `JVM_StartThread` 之后的线程体、`System.gc` 之前的 VM 操作。C++ 侧怎么调 Java 方法、参数怎么打包、异常怎么传、状态怎么切?下一篇: JavaCalls。

> → [30-jvm-entry/02 — C++ 怎么调用 Java 方法?— JavaCalls + NativeLookup](02-java-calls.md)