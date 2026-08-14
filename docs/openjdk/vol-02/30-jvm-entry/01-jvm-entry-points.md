# 01. System.currentTimeMillis() 怎么进入 JVM?— JVM Entry Points

> **前置依赖**:[27-jni/03 — JNI 调用参数错了——JVM 怎么检测?— JNI Check + 平台层](openjdk/vol-02/27-jni/03-jni-check-platform.md):JNI/JVM 入口宏家族与函数表;JVM_CurrentTimeMillis 所在的 jvm.cpp 用同一套 JNI_ENTRY 家族宏;[17-threads/04 — 线程从 Java 进入 VM——这一瞬间怎么保证安全?— interfaceSupport](openjdk/vol-02/17-threads/04-interface-support.md):ThreadInVMfromNative 状态转换的通道;[20-vm-operations/02 — 谁在后台周期性干活?— PeriodicTask、WatcherThread 与启动序列](openjdk/vol-02/20-vm-operations/02-background-init.md):JVM_StartThread 通向 Threads::add 的启动序列
> → **后续**:[30-jvm-entry/02 — C++ 怎么调用 Java 方法?— JavaCalls + NativeLookup](02-java-calls.md)
> 关联域: 42-core-native(libjava 的 native 实现)、27-jni(JNI 是另一张入口表)、01-os(os::javaTimeMillis)

## native 方法怎么"找到"JVM

`System.currentTimeMillis()` 是 Java 代码,但实现是 JVM 的——中间的桥是一族 **JVM_* 入口函数**(JVM_CurrentTimeMillis/JVM_StartThread/JVM_IHashCode...,jvm.h:59 起声明、jvm.cpp 实现)。JNI 是"用户 native 代码 ↔ JVM"的接口;JVM_* 是"JDK 自身 ↔ JVM"的接口——**JDK 的 libjava 编译时直接取 JVM_* 函数的地址**。这篇拆三条: 接口面长什么样(jvm.h:59 起)、JDK 侧怎么接到函数(System.c:39 的注册表与链接)、调用时 JVM 侧怎么进门(JVM_ENTRY 家族宏)。

## 1. 接口面: 入口的声明与实现

`jvm.h`(1342 行,位于 hotspot 的 share/include/ 下,函数自 :59 起)声明了 **182 个 JNIEXPORT 函数**([实证:](planning/outlines/00-jvm-tools/materials/commands/30-jvm-entry-demo.txt)),头注释(jvm.h:38-55)自己说明了组织结构——**"three parts"**,不是按功能域分类:

```cpp
// jvm.h:38-55(截取核心,逐字)
/*
 * This file contains additional functions exported from the VM.
 * These functions are complementary to the standard JNI support.
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

三段 = ①标准 Java API 的 native 库需要的 VM 函数(如 Object 的 wait/notify 要 VM 级监视器操作);②字节码验证器与类文件格式检查器需要的函数(让验证器可以独立于 VM 实现);③标准 I/O 与网络 API 需要的操作。接口版本号 `JVM_INTERFACE_VERSION 6`(:57)提醒 JDK 侧: 改 JVM_* 或 VM 与 Java 类的约定都要 bump。实现侧 jvm.cpp(3793 行)不是分节的——函数按需排布: 纯系统操作在头部(`JVM_CurrentTimeMillis` :271),类/对象操作在中部(`JVM_IHashCode` :605、`JVM_GetCallerClass` :706、`JVM_DefineClass` :949、`JVM_FindLoadedClass` :962),线程操作在尾部(`JVM_StartThread` :2857)。

## 2. JDK 侧怎么接上: 注册表 + 链接期符号

`System.currentTimeMillis` 的 native 声明(System.java:396)怎么连到 `JVM_CurrentTimeMillis`?看 **libjava 的 System.c:39**(注册表):

```cpp
// System.c:25-48(截取核心,逐字)
/* Only register the performance-critical methods */
static JNINativeMethod methods[] = {
    {"currentTimeMillis", "()J",              (void *)&JVM_CurrentTimeMillis},
    {"nanoTime",          "()J",              (void *)&JVM_NanoTime},
    {"arraycopy",     "(" OBJ "I" OBJ "II)V", (void *)&JVM_ArrayCopy},
};
```

`System.registerNatives` 的 C 实现(`Java_java_lang_System_registerNatives`,System.c:44-51)把这些方法 `RegisterNatives` 进 JVM——**`(void *)&JVM_CurrentTimeMillis` 是编译期取址**,不是字符串查找。注释 "Only register the performance-critical methods" 说明只有 3 个走这条捷径。

**链接方式**: [实证:](planning/outlines/00-jvm-tools/materials/commands/30-jvm-entry-demo.txt) `nm -D lib/libjava.so` 显示 `U JVM_CurrentTimeMillis@SUNWprivate_1.1` 等 **131 个 UND 符号**——libjava.so 在链接期引用 libjvm.so 导出的 JVM_* 符号,运行时由 ELF 动态链接器解析(这是编译期符号引用,不是大纲想象的 `dlsym` 查找)。导出名单来自**版本脚本** `hotspot/jvm_sym.ver`:

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

**`JNI_*; JVM_*; jio_*; AsyncGetCallTrace` 就是 libjvm.so 对 JDK 开出的全部接口面**——JNI 用户通道、JVM_* 专属通道、jio_* 控制台 IO 辅助、AGCT 剖析钩子(31-02 提过它在 jvm_sym.ver 导出)。版本节点 `SUNWprivate_1.1` 与 libjava 的 UND 引用严格对应。

## 3. 调用时: 动态解析 or 已注册

native 方法首次执行时要"解析"——`NativeLookup::lookup`(nativeLookup.cpp:527-546)先查 `has_native_function()`,没有才 `lookup_base` 动态查找(`-verbose:jni` 时打印,PrintJNIResolving):

```cpp
// nativeLookup.cpp:527-546(截取核心,逐字)
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

[实证:](planning/outlines/00-jvm-tools/materials/commands/30-jvm-entry-demo.txt) `-verbose:jni` 下完整链条摊开:

```
[Dynamic-linking native method java.lang.System.registerNatives ... JNI]
[Registering JNI native method java.lang.System.currentTimeMillis]
[Registering JNI native method java.lang.System.nanoTime]
[Registering JNI native method java.lang.System.arraycopy]
```

`registerNatives` 本身是动态解析的(System.c:44-51 的 `Java_java_lang_System_registerNatives` 走标准 JNI 表);它注册的 3 个方法之后**整次运行不再出现 Dynamic-linking**——`set_native_function` 把入口写进 Method,后续调用直达 JVM_* 地址。**"注册"的本质是: 把动态查找提前、并且把入口固定为编译期已知的 JVM_* 符号**。

## 4. 进门: JVM_ENTRY 家族

JVM_* 函数体第一行都是 `JVMWrapper`(jvm.cpp:254-256: `CountJNICalls` 时计数,否则空),然后按需选择入口宏(interfaceSupport.inline.hpp:558-592):

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

**`JVM_ENTRY` = 27 域 JNI_ENTRY 的同族**(差异: JNI_ENTRY 还带 `WeakPreserveExceptionMark` 保护挂起异常,jvm.cpp 的入口不需要;调试包装 `VMNativeEntryWrapper` 是 debug-only): `thread_from_jni_environment(env)` 从 JNIEnv 反查线程 + `ThreadInVMfromNative` 状态转换(native→VM,17-04 的通道)+ `VM_ENTRY_BASE` 建 HandleMark。绝大多数 JVM_* 用它——`JVM_StartThread`(jvm.cpp:2857)进来后创建 JavaThread、`JVM_DefineClass`(:949)进入类定义流程、`JVM_FindLoadedClass`(:962)查已加载类(11 域的 AppCDS 拦截点就是它)。少数**纯函数**用 `JVM_LEAF`(:588-592: `VM_Exit::block_if_vm_exited` + `VM_LEAF_BASE` 的 `NoHandleMark`,不做状态转换不碰堆)——`JVM_CurrentTimeMillis`(:271-274)正是 JVM_LEAF:

```cpp
// jvm.cpp:271-274(逐字)
JVM_LEAF(jlong, JVM_CurrentTimeMillis(JNIEnv *env, jclass ignored))
  JVMWrapper("JVM_CurrentTimeMillis");
  return os::javaTimeMillis();
JVM_END
```

三行: 不建 handle、不转状态,直接 `os::javaTimeMillis()`(01-os 域的时钟)。**为什么它能用 LEAF**: 它不读堆、不创建引用、不抛异常、不会阻塞——不需要 HandleMark,也不需要进入 VM 状态被 safepoint 管理,`block_if_vm_exited` 挡掉 VM 退出期就够。同族还有 `JVM_NanoTime`(:276)、`JVM_GetInterfaceVersion`(:263)、`JVM_SupportsCX8`(:3610)——一个 JVM_* 选哪个宏,主要判据就是"碰不碰堆"。

## 核心悬念

入口链拆完: 接口面是 jvm.h:59 起的 182 个 JNIEXPORT(三段: 标准 API 辅助/验证器格式检查/IO 网络),JDK 侧 libjava 用**编译期取址 + ELF 链接期符号**(`U JVM_*@SUNWprivate_1.1`)接住 libjvm.so 的导出(jvm_sym.ver 只开 `JNI_*/JVM_*/jio_*/AGCT` 四族);运行时首次调用走 `NativeLookup::lookup` 动态解析,registerNatives 注册的 3 个性能方法把入口提前固定;进门用 JVM_ENTRY 家族——碰堆的完整通道,不碰堆的 JVM_LEAF 三行完事。

但 `JVM_CurrentTimeMillis` 的调用方是**方法表里固定的地址**,而 JVM 内部要调 Java 方法(比如 `JVM_StartThread` 之后的线程体、`System.gc` 之前的 VM 操作)是另一回事: **C++ 侧怎么反过来调用 Java 方法**——参数怎么打包、异常怎么传递、状态怎么切?下一篇: JavaCalls。

> → [30-jvm-entry/02 — C++ 怎么调用 Java 方法?— JavaCalls + NativeLookup](02-java-calls.md)
