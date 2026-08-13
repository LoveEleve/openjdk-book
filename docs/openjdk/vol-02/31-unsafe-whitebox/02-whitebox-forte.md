# 02. 测试与工具怎么拿到 JVM 内部？— WhiteBox 与 Forte

> **前置依赖**:[31-unsafe/01 — JVM 底层 API](01-unsafe-api.md):Unsafe 是给 JDK 内部的后门,本篇的两个后门分别给测试与 profiler;[17-threads/03 — Thread-SMR 与 Handshake](openjdk/vol-02/17-threads/03-thread-smr-handshake.md):线程安全机制是本章两个后门的前提;[24-frame/01 — Physical Frame](openjdk/vol-02/24-frame/01-physical-frame.md):AsyncGetCallTrace 遍历的正是帧链
> → **后续**:[32-jfr/03 — Periodic 采样](openjdk/vol-02/32-jfr/03-periodic-sampling.md):JFR 的采样器是 Forte 段结论的直接消费者
> 关联域: 24-frame(栈遍历)、17-threads(handshake)、08-interpreter(JNI 注册)、13-jit(编译查询)

## 两种"测试后门",服务两种用户

Unsafe 给 JDK 内部用;那"给测试和 profiler 用的后门"呢?HotSpot 有两个: **WhiteBox**——`-XX:+WhiteBoxAPI` 打开的测试接口,让 Java 测试代码直接查询/操纵 GC、编译器、CodeCache、Metaspace; **AsyncGetCallTrace**——Forte(性能分析工具)时代的信号安全栈采样 API,让外部 profiler 在安全点之外读线程栈。这一篇拆它们: WhiteBox 的门控与注册、AGCT 的错误码体系与线程状态分派,以及一个重要的澄清——**JFR 并不用 AGCT**。

[实证:] 最小 WhiteBox 兼容类(08-whitebox-demo.txt,Temurin 11): ①不开 `-XX:+WhiteBoxAPI` 时 `registerNatives` 的注册被跳过,调用 native 方法直接 `UnsatisfiedLinkError`——门控在注册层;②开启后 `heapOopSize=4`(压缩 oop)、`vmPageSize=4096`、`isGCSupported(1)=true`、`g1IsHumongous(4MB 数组)=true`、`fullGC()` 从 Java 侧触发 Full GC——测试代码确实拿到了 VM 内部。

## 1. WhiteBox: 测试专用 API

### 入口宏: WB_ENTRY = JNI_ENTRY + 异常检查清理

WhiteBox 的方法入口宏定义在 whitebox.inline.hpp:33-38(截取核心,逐字):

```cpp
// whitebox.inline.hpp:31-37(截取核心,逐字)
// Entry macro to transition from JNI to VM state.

#define WB_ENTRY(result_type, header) JNI_ENTRY(result_type, header) \
  ClearPendingJniExcCheck _clearCheck(env); \
  MACOS_AARCH64_ONLY(ThreadWXEnable _wx(WXWrite, thread));

#define WB_END JNI_END
```

大纲说 "WB_ENTRY 是简化版的 JVM_ENTRY——免去 JNI 检查(jniCheck)"——**错**: WB_ENTRY 就是标准 **JNI_ENTRY**(ThreadInVMfromNative 状态转换),外加一个 `ClearPendingJniExcCheck`(清除遗留的 JNI 异常检查标记)——WhiteBox 是 trusted 内部 API,省的是应用侧 JNI 该做的异常簿记,不是"免 jniCheck"。

### 门控: flag + 引导类加载器,双条件

`WhiteBoxAPI` 是 diagnostic flag(globals.hpp:2600-2601: `diagnostic(bool, WhiteBoxAPI, false, "Enable internal testing APIs")`),必须 `-XX:+UnlockDiagnosticVMOptions -XX:+WhiteBoxAPI` 打开。注册入口 JVM_RegisterWhiteBoxMethods 的双重门控(whitebox.cpp:2348-2362,截取核心,逐字):

```cpp
// whitebox.cpp:2348-2361(截取核心,逐字)
JVM_ENTRY(void, JVM_RegisterWhiteBoxMethods(JNIEnv* env, jclass wbclass))
  {
    if (WhiteBoxAPI) {
      // Make sure that wbclass is loaded by the null classloader
      InstanceKlass* ik = InstanceKlass::cast(JNIHandles::resolve(wbclass)->klass());
      Handle loader(THREAD, ik->class_loader());
      if (loader.is_null()) {
        WhiteBox::register_methods(env, wbclass, thread, methods, sizeof(methods) / sizeof(methods[0]));
        WhiteBox::set_used();
      }
    }
  }
JVM_END
```

两个条件缺一不可: **flag 开启**(否则注册直接跳过,测试类调用 native 方法得 UnsatisfiedLinkError——实证①)+ **类必须由引导类加载器加载**(null loader,测试代码要 `-Xbootclasspath/a:` 放进去)——所以 WhiteBox 天然只有测试环境可用,普通应用既拿不到类也开不了 flag。

### 方法家族: 150+ 个内部查询

方法表(whitebox.cpp:2114-2342,methods 数组,178 条)覆盖:

| 层面 | 例子 |
|---|---|
| GC | `fullGC`/`youngGC`(:2248)、`g1IsHumongous0`(:2141)、`g1StartConcMarkCycle`、`forceSafepoint` |
| 编译器 | `deoptimizeAll`(:2173)、`isMethodCompiled0`、`enqueueMethodForCompilation0`、`clearInlineCaches0` |
| CodeCache | `allocateCodeBlob`、`getCodeBlob`、`forceNMethodSweep` |
| Metaspace | `allocateMetaspace`、`metaspaceCapacityUntilGC` |
| VM 标志 | `setIntxVMFlag`/`getIntxVMFlag`(测试中改 flag) |
| 运行时 | `handshakeWalkStack`、`getObjectAddress`、`getConstantPool0` |

`WB_FullGC`(:1321-1330)展示典型模式: 先让软引用策略"全部清理"(`set_should_clear_all_soft_refs(true)`),`Universe::heap()->collect(GCCause::_wb_full_gc)` 触发,若是 G1 再显式复位——**测试想要的是一个确定性的 Full GC,真实业务代码绝不这么做**。`WB_G1IsHumongous`(:422-429)则在 G1 未启用时直接抛 UnsupportedOperationException(:429)。

**关键设计 (斜体)**: *WhiteBox 与 Unsafe 的差别在"信任模型": Unsafe 是 JDK 内部运行时依赖(必须总是可用),WhiteBox 是测试专用(flag 门控 + 引导加载器),缺一个条件就整体失效——它把"内部 API"和"测试 API"分成了两把不同的钥匙。*

## 2. Forte: AsyncGetCallTrace,信号处理器里的栈遍历

### 定位: 给外部 profiler 的导出符号

`AsyncGetCallTrace`(forte.cpp:523 起)是给**外部采样器**的 JVMTI 辅助 API——导出符号在 jvm_sym.ver:6,async-profiler 这类工具直接 dlsym 它。注释说明了它的定位与约束(forte.cpp:467-480,截取核心,逐字):

```cpp
// forte.cpp:467-480(截取核心,逐字)
// Forte Analyzer AsyncGetCallTrace() entry point. Currently supported
// on Linux X86, Solaris SPARC and Solaris X86.
//
// Async-safe version of GetCallTrace being called from a signal handler
// when a LWP gets interrupted by SIGPROF but the stack traces are filled
// with different content (see below).
//
// This function must only be called when JVM/TI
// CLASS_LOAD events have been enabled since agent startup. The enabled
// event will cause the jmethodIDs to be allocated at class load time.
// The jmethodIDs cannot be allocated in a signal handler because locks
// cannot be grabbed in a signal handler safely.
```

**信号处理器(async-safe)+ SIGPROF 中断**是其设计前提;CLASS_LOAD 事件要求是因为 **jmethodID 必须在类加载时预分配**——信号处理器里不能拿锁分配。

### 错误码: num_frames < 0 是一套细粒度编码

大纲说 "栈变化→partial/corrupt 结果标记 UNSAFE"——实际的编码体系更细(forte.cpp:50-60 与 :523-620):

| 值 | 含义 | 场景 |
|---|---|---|
| -1 | ticks_no_class_load | 未启用 CLASS_LOAD 事件 |
| -2 | ticks_GC_active | GC 正在进行(数据不安全) |
| -3 | ticks_unknown_not_Java | 非 Java 态且顶帧不可得 |
| -4 | ticks_not_walkable_not_Java | 非 Java 态,顶帧可得但不可遍历 |
| -5 | ticks_unknown_Java | Java 态顶帧不可得 |
| -6 | ticks_not_walkable_Java | Java 态不可遍历 |
| -7 | ticks_unknown_state | 未知线程状态 |
| -8 | ticks_thread_exit | 线程已退出/正在退出 |
| -9 | ticks_deopt | 线程在 deopt handler 里 |

入口检查依次执行: env_id 为 NULL/线程退出 → -8;在 deopt handler → -9;未启用 CLASS_LOAD → -1;`Universe::heap()->is_gc_active()` → -2(forte.cpp:548-556)。**调用者必须容忍这些负值**——采样数据本来就是尽力而为。

### 线程状态分派: 7 种状态两条路径

拿到 ucontext 后按线程状态分派(forte.cpp:570-628),三族两路: `_thread_in_native/_blocked/_in_vm`(及各自 trans 态)一族 → `pd_get_top_frame_for_signal_handler(&fr, ucontext, false)` 取顶帧后走 `forte_fill_call_trace_given_top`;`_thread_in_Java/_thread_in_Java_trans` 一族 → 同一填充函数带 isInJava=true;新线程(_thread_new 等)返回 0 帧;未知状态兜底 -7。填充逻辑(forte.cpp:416-458): `find_initial_Java_frame`(从给定帧沿 sender 链找第一个带 codeBlob 的 Java 帧,:296-330)→ `vframeStreamForte`(vframeStream 的变体,forte_next :116)逐帧取 method/bci → `find_jmethod_id_or_null` 填 method_id。`ThreadInAsgct`(:587)标记"正在 AGCT 中"以支持重入。

**关键设计 (斜体)**: *安全点外的栈遍历没有一致性保证——线程可能正走到帧切换中间,读到的 bci/method 可能过时(注释 :453-456: gc 线程可以让一个本来有效的解释器帧看起来无效,"small window but it does happen")。AGCT 的回应是"尽力而为+明确失败": 能走完填 num_frames=count,走不完给负数,调用者自己判断。*

## 3. JFR 不用它: 采样器是另一条路

大纲说 "Forte 提供安全点外栈采样——JFR 用"——**JDK 11 里 JFR 并不用 AsyncGetCallTrace**。JFR 的采样器是独立的(jfr/periodic/sampling/jfrThreadSampler.cpp): 采样线程通过 **`os::SuspendedThreadTask`** 挂起目标线程(平台线程挂起,JDK11 的 JFR 采样器里对 handshake 零引用——handshake 是后续版本才接入的)、`ucontext` 取顶帧、`JfrStackTrace` 走与 AGCT 相似但**属于 JFR 自己的**遍历路径(sample_thread_in_java/sample_thread_in_native,:247/:265)。两者都做"安全点外采样",但通道不同: AGCT 是给外部 profiler 的稳定 ABI(async-profiler 等 dlsym 它),JFR 是 VM 内建采样器。jdk11u 全树 grep: JFR 目录对 AsyncGetCallTrace 零引用。

[实证:] 对照实验成立的方式: jvm_sym.ver:6 的导出是给外部工具的;而 JFR 的 ExecutionSample 事件由 jfrThreadSampler 产生(metadata.xml 定义,jfrThreadSampler.cpp 实现)——两条采样通道在 JDK 11 里并存,互不调用。

## 核心悬念

两个测试后门拆完了: WhiteBox(flag + 引导加载器双门控、JNI_ENTRY 入口、150+ 个 GC/编译器/CodeCache/Metaspace 查询)、AsyncGetCallTrace(信号安全、-9..-1 错误码体系、7 态分派、jmethodID 预分配要求)——后者是外部 profiler 的 ABI,不是 JFR 的通道;JFR 有自己基于 handshake 的采样器。

WhiteBox 能"让测试代码看到 GC",Forte 能"让 profiler 看到栈"——都只是"看到"。下一域是真正把这些观测工业化的一方: JFR——事件的录制、采样、磁盘格式与 jcmd 界面,VM 内建的性能观测系统。

> → [32-jfr/03 — Periodic 采样](openjdk/vol-02/32-jfr/03-periodic-sampling.md)
