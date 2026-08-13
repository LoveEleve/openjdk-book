# 02. WhiteBox + Forte — JVM 开发的测试利器

> 🟡 Working | 2 KP 中的测试+诊断
> 读者处境: JVM 开发者需要测试 GC 内部——不能从 Java 代码直接访问。WhiteBox API 提供 `-XX:+WhiteBoxAPI` → 运行时 GC 内部查询。Forte 提供安全点外栈采样。

> ⚠️ 写作期修正(2026-08-13, vol-02/31-unsafe-whitebox/02 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **"WB_ENTRY 简化版 JVM_ENTRY 免 jniCheck" 错**: WB_ENTRY = **JNI_ENTRY + ClearPendingJniExcCheck**(whitebox.inline.hpp:33-37),标准 JNI 通道(ThreadInVMfromNative),不是"简化版"
> - **"Forte 提供安全点外栈采样——JFR 用" 错**: JDK11 的 JFR 采样器(jfrThreadSampler.cpp)**不用 AsyncGetCallTrace**(jfr 目录零引用),用 **os::SuspendedThreadTask 挂起线程 + ucontext**(jfrThreadSampler.cpp:114 OSThreadSampler extends os::SuspendedThreadTask;handshake 也零引用,后续版本才接入);AGCT 是给外部 profiler 的导出符号(jvm_sym.ver:6,async-profiler dlsym)
> - **行号全漂**: WhiteBoxAPI flag globals.hpp:2600(diagnostic bool);JVM_RegisterWhiteBoxMethods whitebox.cpp:2348-2361(双门控: flag 开启 + wbclass 由 null loader 加载);方法表 :2114-2342 共 **178 条**;WB_FullGC :1321-1330(soft_ref_policy 清软引用+collect(GCCause::_wb_full_gc)+G1 显式复位)、WB_G1IsHumongous :422-429(非 G1 抛 UnsupportedOperationException :429);forte.cpp 523 起 AsyncGetCallTrace
> - **AGCT 细节(大纲未提)**: 错误码体系 ticks_* (forte.cpp:50-60): -1 无 CLASS_LOAD 事件(要求 jmethodID 类加载时预分配,信号处理器不能拿锁)/-2 GC 活跃/-3/-4 非 Java 态不可得/不可遍历/-5/-6 Java 态/-7 未知态/-8 线程退出/-9 deopt handler;入口检查 :523-556;三族两路分派(Java 态/非 Java 态/新线程):570-628,pd_get_top_frame_for_signal_handler 取顶帧(thread_linux_x86.cpp:36 注释);find_initial_Java_frame :296-330(cb()==NULL 沿 sender 找,注释 JRT_LEAF 场景);vframeStreamForte forte_next :116;ThreadInAsgct(:559,类定义 thread.hpp:777,重入注释 :784)
> - **实证**: 08-whitebox-demo.txt(不开 flag→UnsatisfiedLinkError 注册被跳过;开 flag→heapOopSize 4/vmPageSize 4096/isGCSupported true/g1IsHumongous 4MB 数组 true/fullGC done;最小 WhiteBox 兼容类 -Xbootclasspath/a: 加载,方法表注册时对缺失方法打 NoSuchMethodError Warning 但不影响)


### 1. "WhiteBox — JVM 内部测试 API"

场景: 测试 G1 GC 的 Evacuation——WhiteBox `WB_FullGC()` 触发 Full GC → 检查 heap 状态→验证对象正确 promoted。

**WhiteBox API** (`whitebox.hpp:40-200 + whitebox.cpp:50-300`):
```cpp
WB_ENTRY(void, WB_FullGC(JNIEnv*, jobject))
  Universe::heap()->collect(GCCause::_wb_full_gc);
WB_END

WB_ENTRY(jboolean, WB_G1IsHumongous(JNIEnv*, jobject, jobject obj))
  return G1CollectedHeap::heap()->isHumongous(JNIHandles::resolve(obj));
WB_END
```
- 源码: `whitebox.hpp:40-200` + `whitebox.cpp:50-300` + `wbtestmethods/`
- 关键设计: 通过 `-XX:+UnlockDiagnosticVMOptions -XX:+WhiteBoxAPI` 才能访问——仅 test 和 debug JVM build。提供 GC/Compiler/CodeCache/Metaspace 的内部查询和操作
- [C++: `WB_ENTRY` 宏是简化版的 `JVM_ENTRY`——免去 JNI 检查(jniCheck)因为 WhiteBox 是 trusted internal API]

### 2. "Forte — AsyncGetCallTrace 安全点外栈采样"

场景: JFR 每 100ms 采一次栈——不能每次采样都触发 safepoint(影响性能)。AsyncGetCallTrace 在安全点外读栈——最多可能读到不一致的数据(因为线程在跑)。

**AsyncGetCallTrace** (`forte.cpp:40-200 + forte.hpp:30-80`):
```
AsyncGetCallTrace(trace, depth, ucontext):
  → read thread's stack frames(no safepoint)
  → for each frame:
    → find nmethod or interpreter frame
    → extract method/bci
  → if stack changed during walk→return partial/corrupt result marked UNSAFE
```
- 源码: `forte.cpp:40-200` + `forte.hpp:30-80`
- 关键设计: 非安全点读栈——x86 rbp 链可能在帧切换中间→读到的 bci/method 可能过时→caller 需要 tolerate partial results。JFR 接收后 mark trace as "truncated if inconsistent"

---

### 核心悬念

**"WhiteBox 通过 -XX:+WhiteBoxAPI 暴露 JVM 内部 API——GC/Compiler/CodeCache 测试。Forte AsyncGetCallTrace 在安全点外采栈——JFR 可能读到 partial trace。"** — 下一篇: 域32 JFR。

> → 域32 JFR
