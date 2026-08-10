# 02. WhiteBox + Forte — JVM 开发的测试利器

> 🟡 Working | 2 KP 中的测试+诊断
> 读者处境: JVM 开发者需要测试 GC 内部——不能从 Java 代码直接访问。WhiteBox API 提供 `-XX:+WhiteBoxAPI` → 运行时 GC 内部查询。Forte 提供安全点外栈采样——JFR 用。

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
