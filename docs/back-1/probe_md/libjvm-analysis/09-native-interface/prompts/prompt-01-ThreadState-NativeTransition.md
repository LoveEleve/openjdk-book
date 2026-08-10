# PROMPT: 请撰写 01-ThreadState-NativeTransition.md

## 一、任务

撰写一篇深度的 JVM 源码分析文档，主题：**JNI 线程状态转换与 safepoint 交互 — Java↔Native 边界上的每一次状态切换**

### 核心故事线（禁止做源码翻译机！）

[08-safepoint] 把 safepoint 的 begin/end 协议、polling 机制、VM_Operation 调度、GCLocker 双层门禁全部拆解清楚了。但所有这些分析都从 **VMThread 视角**出发——VMThread 怎么 arm polling、怎么 SPIN 等线程、怎么进入 `_synchronized`。

读者学完 08 后自然要问：**"那我从 JavaThread 视角看呢？一个线程从 Java 调 JNI、跑到 native 里、再返回 Java 的全过程中，它和 safepoint 协议的每一次互动是什么？"**

本文换到 JavaThread 视角，追踪一个线程从 `_thread_in_Java` 出发，穿越 Java↔Native 边界的每一次状态转换，回答：[08-01] 说 `_thread_in_native` 的线程被 `roll_forward(_at_safepoint)` 放行——但放行的代价是什么？线程从 native 返回时，在哪个精确点被 safepoint "追上"？追上的机制是 `poll()` 还是 `block_if_requested()`？poll 检测到 `_synchronizing` 之后、block() 真正挂起之前，线程还干了什么？

**本文是 09 阶段和 08 阶段的桥梁文档**。08 从 VMThread 视角看 safepoint，本文从 JavaThread 视角看同一条协议的另一面。

### 核心叙事线

1. **★ 为什么 Java→Native 不需要 safepoint check，但 Native→Java 需要？** — 这不只是一个"分别是什么"的问题，而是"为什么这样设计"的问题。`_thread_in_native` 的线程被 `examine_state_of_thread()` 检测到 → `safepoint_safe()` → `roll_forward(_at_safepoint)` 放行——[08-01] 已经解释过了。但"放行"不是免费的——线程从 native 返回时，必须在 `_thread_in_native_trans` 窗口内 poll，如果 poll 命中 → block。追问：**native 返回路径上的 poll 和 Java 编译代码中的 poll 是同一个 `test %eax, (%rip)` 吗？** 不是——Java 编译代码的 poll 是 JIT 插入的 safepoint check 指令，native 返回路径的 poll 是 `SafepointMechanism::poll(thread)` 函数调用。两者的触发点不同：前者在编译代码的循环回边/方法返回处，后者在 `transition_from_native()` 内部。追问：**如果 native 代码永不返回（如死循环在 C 库中），safepoint 能等到这个线程吗？** 能——`_thread_in_native` 被 `roll_forward(_at_safepoint)` 视为已到达，safepoint 不需要等它返回。但如果这个线程后来返回了，会在返回路径上被 block。这就是"放行"的设计精妙：先放你过，等你回来时再补票。

2. **★★★ `transition_from_native()` 逐行走读** — 这是全文最核心的代码。线程从 native 返回 JVM 的路径（注意 RAII 间接层）：
   ```
   JNI_ENTRY 宏展开 (interfaceSupport.inline.hpp:525)
     → ThreadInVMfromNative __tiv(thread);  ← ★ 在宏中自动构造，不在函数体中！
        → trans_from_native(_thread_in_vm)
           → transition_from_native(thread, _thread_in_vm) ← interfaceSupport.inline.hpp:158
     → jni_invoke_static / jni_invoke_nonstatic 函数体逻辑
     → JNI_END 宏 → ThreadInVMfromNative 析构
        → trans_and_fence(_thread_in_vm, _thread_in_native) ← L272
   ```
   ★ 关键：`transition_from_native` 不是 `jni_invoke_static` 函数体中手动调用的，而是 **JNI_ENTRY 宏**展开时自动构造 `ThreadInVMfromNative` RAII 对象（`interfaceSupport.inline.hpp:525`），由构造函数间接调用。去 `jni.cpp` 搜 `transition_from_native` 搜不到——因为它在**宏**里，不在函数体里。
   函数体内：先设 `_thread_state = _thread_in_native_trans` → `serialize_thread_state_with_handler()` → `poll()` → 如果 poll 命中 → `check_safepoint_and_suspend_for_native_trans()` → `block()` → 恢复后设 `_thread_state = _thread_in_vm`。追问：**`_thread_in_native_trans` 这个中间态为什么存在？** 如果线程直接设 `_thread_in_vm` 而不经过 native_trans，VMThread 在 SPIN 中看到 `_thread_in_vm` → `roll_forward(_call_back)` → 等线程在下次 `transition_and_fence` 时自行 `block_if_requested`。但 native 返回路径上的线程还没设好 Java 栈帧——如果此时 GC 需要扫描栈，栈是不完整的。`_thread_in_native_trans` 告诉 VMThread："我知道你在等 safepoint，但我还在穿越边界，请保持 `_running` 等我完成"。追问：**poll 和 block_if_requested 的关系是什么？** 两者在 native 返回路径上同时存在但角色不同：`poll()` 是**主动探测**—"现在有没有 safepoint 在进行？"（线程刚从 native 回来，一无所知）；`block_if_requested()` 在 `transition_and_fence()` 中检查**被动标记**—"VMThread 有没有在我的 poll flag 上设了标记？"

3. **★★ `transition_and_fence()` 和 `transition_from_native()` 的本质差异** — [08-02] §四 已经对比过两者的 fence 语义，但没讲清楚它们在**调用场景**上的区别。`transition_and_fence()` 用于 VM **内部**的状态转换——比如 ThreadInVMfromJava（进入 VM）→ 从 `_thread_in_Java` 经 `_thread_in_Java_trans` 到 `_thread_in_vm`；ThreadInVMfromNative（native 返回后进入 VM）→ 从 `_thread_in_native` 经 `_thread_in_native_trans` 到 `_thread_in_vm`。`transition_from_native()` 是 JNI 返回路径的**专用函数**——它比 `transition_and_fence()` 多了一个 `if (poll()) check_safepoint_and_suspend_for_native_trans()` 的分支。追问：**为什么 JNI 返回需要特殊的 poll 检查，而 VM 内部状态转换只需要 `block_if_requested`？** 因为时序不同：VM 内部的状态转换发生在已经进入 safepoint 同步之后（线程已经知道 `_state=_synchronizing`），所以只需要 `block_if_requested` 确认是否需要阻塞。JNI 返回路径上的线程可能完全不知道 safepoint 正在进行（一直在 native 中没 poll 过）——所以需要先 `poll()` 检测一次。

4. **★ JNI 调用的完整状态循环** — 一张图应该覆盖 5 个唯一状态的 8 步转换（_thread_in_Java 和 _thread_in_vm 出现两次）：
   ```
   _thread_in_Java          
      │ (1) transition_from_java → _thread_in_vm
      ▼                      
   _thread_in_vm             
      │ (2) ~ThreadInVMfromJava → _thread_in_Java_trans → _thread_in_Java
      ▼                      
   _thread_in_Java           
      │ (3) ThreadToNativeFromVM ctor → trans_and_fence(_thread_in_vm, _thread_in_native) → _thread_in_native
      │     (解释器 native 路径：interfaceSupport.inline.hpp:284)
      │     JNI 路径：ThreadInVMfromNative dtor → trans_and_fence → _thread_in_native (L272)
      ▼                      
   _thread_in_native         ← ★ safepoint 中被 roll_forward(_at_safepoint) 放行
      │ (4) transition_from_native → _thread_in_native_trans → poll → [block]
      ▼                      
   _thread_blocked (if safepoint)  ← end() 后恢复
      │ (5) → _thread_in_vm
      ▼
   _thread_in_vm             
      │ (6) ~ThreadInVMfromNative → _thread_in_Java
      ▼
   _thread_in_Java
   ```
   追问：**步骤(3)和步骤(4)中的 `_thread_in_native_trans` 是同一个概念吗？** 是同一个中间态——但它出现在两个方向：进入 native 和离开 native。VMThread 在 SPIN 中看到这个状态时，都保持 `_running` 等待。区别在于：进入方向上的 native_trans 通常很快（几十条指令），离开方向可能需要等待 safepoint（poll 命中 → block）。

5. **★ 和 GCLocker 的互动 — native 线程的双重身份** — JNI critical（`GetPrimitiveArrayCritical`/`ReleasePrimitiveArrayCritical`）期间的线程状态仍然是 `_thread_in_native`，但线程在 GCLocker 中也注册了（`jni_lock` 使 `_jni_lock_count++`）。safepoint 中看到这个线程 → `roll_forward(_at_safepoint)`（从 safepoint 角度看它已到达）→ 同时 `increment_jni_active_count()`（从 GCLocker 角度看它在 critical 中）。追问：**如果这个线程在 safepoint 期间退出 critical（jni_unlock → heap->collect），而 VMThread 正在 GC，会发生什么？** → [08-05] §七.2 已经回答过了。本文应该从这个线程的视角重新讲一遍这个场景：线程在 `_thread_in_native` 被 roll_forward 放行 → 继续执行 jni_unlock → `heap->collect()` 尝试 GC → `doit_prologue` 被第一个分配者线程持有的 Heap_lock 阻塞 → 等 end() 后获取 Heap_lock → 正常 GC。

6. **★ `sharedRuntime.cpp` 的 native wrapper 桩代码** — 不是整篇 sharedRuntime.cpp（5000+ 行），只聚焦 `SharedRuntime::generate_native_wrapper()`。这个函数生成一段适配器桩代码，位于每个 native 方法的前面，负责：保存 Java 寄存器 → 设置 JNI 环境 → 调用真正的 native 函数 → 处理返回值 → 恢复 Java 状态。追问：**这段桩代码中，safepoint 的 arm/disarm 在哪里？** 桩代码本身不 arm/disarm safepoint——它只是设置 `_thread_state = _thread_in_native`（通过 `transition_from_java` 的 RAII 包装）。polling 点在 native 返回后、桩代码恢复 Java 状态**之前**。这就是 [08-02] 说的"native 返回时需要 poll"的具体位置。

### 禁止行为

- ❌ 把 `transition_from_native()` 全文贴出来逐行翻译——这是源码翻译机
- ❌ 把 [08-01] 的 begin() 重新解释一遍——只引用，不重述
- ❌ 把 [08-02] 的 poll/block_if_requested 重新解释一遍——只引用，不重述
- ❌ 忽略 `_thread_in_native_trans` 的存在——它是"穿越边界窗口"的关键，不提它等于没讲清楚状态转换
- ❌ 和 [08-02] §四 的 fence 对比重复——只引用结论，不重新展开
- ❌ 遗漏 `sharedRuntime.cpp` 中的 native wrapper 桩代码——这是 native 方法调用的实际入口
- ❌ 不画状态转换图——全状态循环是本文的核心交付物
- ❌ 不区分 `poll()` 和 `block_if_requested()` 的使用场景——两者在 native 返回路径中同时存在但角色不同
- ❌ 不验证源码行号——所有行号必须对照实际源码确认
- ❌ 把 `jni_invoke_static` 的整个函数贴出来——只提"这里是 native 调用的入口和出口"

### 要求行为

- ✅ **★ 完整的状态循环 Mermaid 图**：展示 5 个唯一状态的 8 步循环（`_thread_in_Java` → `_thread_in_vm` → `_thread_in_Java` → `_thread_in_native_trans` → `_thread_in_native` → `_thread_in_native_trans` → `_thread_blocked` → `_thread_in_vm` → `_thread_in_Java`），每个转换标注触发函数 + 源文件:行号 + 是否触发 safepoint check
- ✅ **★ `transition_from_native()` 源码逐行走读**：`interfaceSupport.inline.hpp:158-177`，逐行分析每一步的语义，标注行号
- ✅ **★ `transition_and_fence()` 和 `transition_from_native()` 的对比表**：使用场景、fence 语义、poll 时机、是否调用 block_if_requested
- ✅ **★ Java→Native 和 Native→Java 的对称/非对称性分析**：为什么进入 native 不需要 poll（线程由 VMThread 的 SPIN 被动追踪），但返回时需要主动 poll（线程可能完全不知道 safepoint 在进行中）
- ✅ **★ native wrapper 桩代码的简化分析**：`SharedRuntime::generate_native_wrapper()` — 桩代码的结构（保存/恢复 → 调用 native → 返回后 poll），标注关键点
- ✅ **★ 和 [08-safepoint] 的双向引用**：本文不重复 [08] 的内容，但必须标注"详见 [08-01] §N" / "详见 [08-02] §N"
- ✅ **★ JNI critical 线程在 safepoint 中的双重身份**：既是"safepoint 已到达"（roll_forward_at_safepoint），又是"GC 被阻止"（increment_jni_active_count）。标注这种双重身份的精确含义
- ✅ **★ GDB 验证 ≥8 条**：重点在 `transition_from_native` 调用栈、poll 命中时的 `_thread_state` 值、`_thread_in_native_trans` 窗口期验证

## 二、标准环境

- OpenJDK 11 slowdebug build
- `-Xms8g -Xmx8g -XX:+UseG1GC`
- 64 位 Linux x86
- ★ GDB 在 slowdebug build 中验证（`#ifdef ASSERT` 全部生效）

## 三、聚焦源文件

| # | 文件 | 完整路径 | 模块 | 核心函数（需验证行号） | 本文角色 |
|---|------|---------|------|---------------------|---------|
| 1 | `interfaceSupport.inline.hpp` | `src/hotspot/share/runtime/interfaceSupport.inline.hpp` | runtime | `transition_from_native()`(:158-177), `transition_and_fence()`(:136-148), `ThreadInVMfromNative`(:266-274), `ThreadToNativeFromVM`(:277-294) | ★★★ 核心逐行走读 + 所有 RAII 类 |
| 2 | `safepointMechanism.inline.hpp` | `src/hotspot/share/runtime/safepointMechanism.inline.hpp` | runtime | `poll()`(:50), `block_if_requested()`(:58), `global_poll()`(:37) | ★★ poll/block 节点 |
| 3 | `safepoint.cpp` | `src/hotspot/share/runtime/safepoint.cpp` | runtime | `block()`(:859-958), `examine_state_of_thread()`(:1090), `check_for_lazy_critical_native()`(:824) | ★★ block 内部 + SPIN 视角 |
| 4 | `jni.cpp` | `src/hotspot/share/prims/jni.cpp` | prims | `jni_invoke_static`, `jni_invoke_nonstatic` — native 调用入口和出口 | ★★ JNI 调用桩 |
| 5 | `javaCalls.cpp` | `src/hotspot/share/runtime/javaCalls.cpp` | runtime | `JavaCallWrapper` RAII 构造/析构、`call_helper()` | ★★ JNI 调用包装层 |
| 6 | `templateInterpreterGenerator_x86.cpp` | `src/hotspot/cpu/x86/templateInterpreterGenerator_x86.cpp` | interpreter | `generate_native_entry()` — ★ 解释器路径：汇编直写 `_thread_state`（不经 RAII） | ★★ 解释器 native 入口 |
| 7 | `globalDefinitions.hpp` | `src/hotspot/share/utilities/globalDefinitions.hpp` | utilities | `enum JavaThreadState`(:890) — 状态枚举值与偶数=稳态/奇数=过渡态规律 | ★ 状态枚举定义 |
| 8 | `sharedRuntime.cpp` | `src/hotspot/share/runtime/sharedRuntime.cpp` | runtime | `generate_native_wrapper()` — JIT native 桩生成 | ★ JIT native wrapper |

**跨模块说明**：本文跨越 `prims/`（JNI 入口）和 `runtime/`（线程状态、safepoint、polling），是 09 阶段跨模块的典型代表。

## 四、必须深度走读的核心概念

> 以下不是答案——是必须从源码中挖掘答案的问题列表。每道题先定位源文件行号，再回答"为什么"，最后用 3-5 行关键源码做引证。禁止贴整段函数。

### 4.1 ★★★ `transition_from_native()` — 逐行走读

```
问题：
  ① 函数的完整参数列表和返回值是什么？
     → interfaceSupport.inline.hpp:158-177。入参：thread, to（目标状态）。
     无返回值（void）。副作用：修改 thread->_thread_state。

  ② 为什么先设 _thread_state = _thread_in_native_trans(:162)，再做 serialize(:164)？
     → 先设中间态，保证 VMThread 的 SPIN 看到"我在穿越边界"而不是"我还在 native"。
     serialize 之前设 trans 状态，之后 poll — 整个过程都处于 native_trans 窗口。

  ③ poll() 检测的是什么？
     → SafepointMechanism::poll(thread) — 返回 true 表示 safepoint 正在进行。
     在 ThreadLocal 模式下，检查线程本地 poll flag；在 Global 模式下，检查 _state != _not_synchronized。

  ④ poll() 返回 true 后，check_safepoint_and_suspend_for_native_trans() 做了什么？
     → safepoint.cpp: JavaThread::check_safepoint_and_suspend_for_native_trans(thread)
     → 调用 SafepointSynchronize::block(thread) → 线程进入阻塞等待。

  ⑤ poll 返回 false（没有 safepoint）或 block() 返回后，剩下的是什么？
     → thread->set_thread_state(to) — 设为目标状态（通常是 _thread_in_vm）。
     从此线程进入 JVM 内部代码。
```

### 4.2 ★★ `transition_and_fence()` vs `transition_from_native()` — 不在一个抽象层

```
问题：
  ① 为什么 transition_and_fence 只调用 block_if_requested，而 transition_from_native 先 poll 再 check？
     → block_if_requested 检查自己的 poll flag **是否已被 VMThread 的 begin() 设置了**
     （ThreadLocal 模式：检查 local_poll_armed → _polling_page 字段；
      Global 模式：检查 global_poll() → do_call_back() 读 _state）。
     而 poll 主动探测"safepoint 是否正在进行"。

     在 VM 内部的 transition_and_fence：
       VMThread 在 begin() 的 arm_local_poll 中已经设置了线程的 poll flag —
       这不需要线程主动 poll，是 VMThread 的被动写入。
       线程在 transition_and_fence 中调用 block_if_requested → 发现 flag 已设置 → block()。

     在 native 返回的 transition_from_native：
       线程刚从 native 回来，可能完全不知道 VMThread arm 了 flag —
       arm_local_poll 在 begin() 中发生，而此线程彼时在 native 中、没被波及。
       所以必须主动 poll 一次"现在有没有 safepoint 在进行"。

     ★ 关键区别：block_if_requested 是被动检查（VMThread 有没给我设 flag），
       poll 是主动探测（JVM 全局是否在 _synchronizing）。

  ② transition_and_fence 的 fence 是 StoreLoad，transition_from_native 没有显式 fence — 为什么？
     → transition_from_native 依赖 serialize_thread_state_with_handler() 的隐式屏障。
     这个函数写入一个特殊页（os::write_memory_serialize_page），触发 store buffer flush。
     transition_and_fence 用显式的 OrderAccess::fence()。
     两条路径最终都保证 _thread_state 写入对 VMThread 的 SPIN 可见。
```

### 4.3 ★ `_thread_in_native_trans` 的窗口语义

```
问题：
  ① 从 VMThread 的 SPIN 视角看，_thread_in_native_trans 如何处理？
     → examine_state_of_thread() 在 safepoint.cpp:1090-1144。
     检查步骤：is_ext_suspended? → safepoint_safe? → _thread_in_vm? → 默认。
     _thread_in_native_trans **不匹配** safepoint_safe（因为不是 _thread_in_native 或 _thread_blocked）。
     也不匹配 _thread_in_vm。所以走到默认分支：保持 _running，继续等待。
     ★ VMThread 不会 roll_forward 这个线程，也不会 mark _call_back — 它就是等。

  ② 线程在 _thread_in_native_trans 期间能调用 malloc 吗？
     → 能。这个状态本质上还是在执行代码——只是不能保证 Java 栈可遍历。
     malloc 需要锁 → 如果 VMThread 持有了同一把锁 → 死锁。
     ★ 这就是为什么 native_trans 窗口必须极短（通常 <100ns，只做 serialize + poll + set_state）。

  ③ 如果线程在 _thread_in_native_trans 期间命中 mprotect 的 SIGSEGV 会怎样？
     → 这不应该发生。mprotect 操作的是 polling page — 线程在 native_trans 窗口内不访问 polling page。
     poll() 是主动函数调用，不依赖页面保护。
```

### 4.4 ★ GCLocker 与 native 线程的双重身份

```
问题：
  ① native 线程在 safepoint 的 SPIN 中被检测到 in_critical() — 这时发生了什么？
     → roll_forward(_at_safepoint) → signal_thread_at_safepoint() → _waiting_to_block--
     → 同时 increment_jni_active_count() — _current_jni_active_count++
     → begin() 末尾 set_jni_lock_count(_current_jni_active_count) — 写入 GCLocker::_jni_lock_count
     → 之后 check_active_before_gc() 读 is_active() → _jni_lock_count > 0 → 发现 critical 活跃 → 设 _needs_gc

  ② 线程在 critical 期间被 roll_forward 放行，但 jni_unlock 时尝试 heap->collect() — 冲突吗？
     → [08-05] §七 已经回答。本文从线程视角重述：线程被放行 → 继续执行 native 代码 →
     释放 critical → jni_unlock → heap->collect → doit_prologue → Heap_lock 阻塞
     （第一个分配者线程持有）→ 等 safepoint end() → 获得 Heap_lock → 正常 GC。
```

### 4.5 ★ native wrapper 桩（`SharedRuntime::generate_native_wrapper()`）

```
问题：
  ① 桩代码的结构是什么？（只说概念，不要求贴汇编）
     → 分为三段：prologue（保存 Java 寄存器、设置 JNIEnv）、body（调用真正的 native 函数）、
     epilogue（处理 native 返回值、恢复 Java 状态、safepoint poll check）。

  ② 桩代码在哪设 _thread_in_native？在哪设回来？
     → ★ 两种路径不同：
     **解释器路径**：汇编 `movl [thread+offset], _thread_in_native` 直写（`templateInterpreterGenerator_x86.cpp:1037-1040`），不经任何 RAII 对象。
     **JIT 路径**：prologue 末尾通过 `ThreadToNativeFromVM` 构造（`interfaceSupport.inline.hpp:284`）
     调用 `trans_and_fence(_thread_in_vm, _thread_in_native)` 设 `_thread_in_native`。
     两种路径的返回都走 `transition_from_native`→poll→block（解释器通过 `safepoint_poll` 汇编序列，JIT 通过桩代码 epilogue）。
     ★ 注意：`ThreadInVMfromJava` 设的是 `_thread_in_vm`（从 Java 进 VM），不是 `_thread_in_native`。

  ③ 桩代码中的 safepoint poll 和编译代码中的 poll 指令一样吗？
     → 不一样。编译代码的 poll 是一条读 polling page 地址的内联指令
     （x86_64 Global 模式：`test %eax, [polling_page]`；AArch64：`ldr wzr, [xreg]`）。
     桩代码的 poll 是 `SafepointMechanism::poll()` 函数调用 — 通过函数指针间接调用。
     两者最终都通过读 _state 或 polling page 来判断是否需要 safepoint。
```

## 五、文章结构

```
§〇 源文件清单（跨 prims + runtime，标注模块归属）

§一 ★ 全景 — JavaThread 的 5 态 8 步循环 Mermaid 图
  ❓ 为什么需要 5 个唯一状态、8 步弧（而不是"Java/Native/VM"三个状态三个弧）？
  1.1 完整 Mermaid 状态图：_thread_in_Java → _vm → _Java → _native_trans(进) → _native → _native_trans(出) → _blocked → _vm → _Java
  1.2 每个状态转换标注：触发函数、源文件:行号、fence 语义、是否触发 safepoint check
  1.3 和 VMThread 视角的对比：同一时刻，VMThread 怎么看待这个线程

§二 ★★★ transition_from_native() — 逐行走读（衔接 [08-02]）
  ❓ poll 返回 true 之后、block 之前，线程还干了什么？
  2.1 源码逐行（interfaceSupport.inline.hpp:158-177），每行解释"为什么"
  2.2 poll 检测 → check_safepoint_and_suspend_for_native_trans → block 的三段式
  2.3 ★ 和 [08-02] 的衔接：本文聚焦 poll 之后的代码路径，poll 机制本身引用 [08-02]

§三 ★★ transition_and_fence vs transition_from_native（衔接 [08-02] §四）
  ❓ 为什么同一个"穿越边界"要两个函数？
  3.1 场景对比：VM 内部转换 vs JNI 返回转换
  3.2 fence 语义对比：显式 OrderAccess::fence vs serialize_thread_state 隐式屏障
  3.3 poll 时机对比：block_if_requested(已知 safepoint) vs poll(探测 safepoint)

§四 ★ JNI 调用生命周期（衔接 [08-04]）
  ❓ 从 JNI 入口到返回，线程经历了什么？
  4.1 jni_invoke_static / jni_invoke_nonstatic 的入口和出口（jni.cpp）
  4.2 native wrapper 桩代码的简化分析（sharedRuntime.cpp:generate_native_wrapper）
  4.3 和 GCLocker 的互动：critical 期间的线程双重身份
  ★ 注：除了 JNI 路径，编译代码调用 C 运行时（如 Math 的 intrinsic 降级）也走
    transition_from_native，入口在 SharedRuntime 的 C 运行时调用桩。本文以 JNI 为主线，
    非 JNI 路径的差异仅在该节末简要提及。

§五 ★ 和 [08-safepoint] 的交叉验证
  5.1 VMThread SPIN 中看到 native_trans 状态的行为验证（examine_state_of_thread）
  5.2 roll_forward(_at_safepoint) 的副作用：signal_thread_at_safepoint + increment_jni_active_count
  5.3 和 [08-04] 的 GCLocker 连接：jni_lock 对 safepoint 行为的影响

§六 GDB 验证 + 可证伪断言（≥8 条）
  断言 1: transition_from_native 完整调用栈（从 jni.cpp 入口到 block）
  断言 2: poll 命中 safepoint 时 _thread_state 的精确值（应该还在 _thread_in_native_trans）
  断言 3: _thread_in_native_trans 窗口期内 VMThread 的 _type 标记（保持 _running）
  断言 4: block() 内部 _waiting_to_block 递减的原子性验证
  断言 5: transition_and_fence 的 fence 指令类型（StoreLoad）验证
  断言 6: native wrapper 桩代码中 _thread_state 变更的时间点
  断言 7: jni_unlock 在 safepoint 进行中时 Heap_lock 阻塞验证
  断言 8: sharedRuntime 的 generate_native_wrapper 生成的桩代码大小
```

## 六、写作要求

**最关键的一条**：以 [08-01] 和 [08-05] 的写作风格为参考——以"❓ 为什么..."开头，先建立设计动机，再用源码做证据。本文是 09 阶段的**桥梁文档**：一头连着 08 学过的 safepoint 协议，一头连着 09 即将展开的 JNI 子系统。

1. **★ 5 态 8 步状态循环 Mermaid 图是全文第一个核心交付物**：5 个唯一状态（_thread_in_Java, _thread_in_vm, _thread_in_native_trans, _thread_in_native, _thread_blocked）经 8 条弧形成一个闭环，每条弧标注触发函数名 + 源文件:行号 + 是否触发 safepoint check。用颜色区分"主动转换"（线程自己改）vs"被动转换"（safepoint 强制）。

2. **★ 每一步必须标注"在哪个线程上执行"**：大部分时间在 JavaThread 上，但 §五 的跨验证需要标注 VMThread 视角。

3. **★ `transition_from_native()` 的逐行走读必须精细到"为什么先设状态再 serialize 再 poll"**：不是翻译代码，而是解释设计决定的理由。

4. **★ 和 [08-01][08-02][08-04][08-05] 的交叉引用必须精确到节**：不重述内容，只标注"详见 [0X] §N"。

5. **★ `_thread_in_native_trans` 的窗口语义是本文的独特贡献**：为什么需要这个中间态？从 VMThread 视角看它等于什么？窗口中能做什么不能做什么？

6. **★ GDB 验证重点**：native 返回途中被 safepoint 截停的完整调用栈 + 各状态的精确值。

## 七、输出格式

- Markdown 文件，命名为 `01-ThreadState-NativeTransition.md`
- 输出路径：`/data/workspace/openjdk-cut-new/probe_md/libjvm-analysis/09-native-interface/`
- 元信息头（标准环境 + 源文件清单 + 前置 [08-01][08-02][08-04][07-thread] + 阅读收益 + "09 阶段桥梁，阅读顺序第一"的说明）
