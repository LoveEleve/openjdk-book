# PROMPT: 请撰写 02-Polling-Mechanism.md

## 一、任务

撰写一篇深度的 JVM 源码分析文档，主题：**Polling Mechanism — 全局 Polling Page vs ThreadLocal Handshake + transition_and_fence + ThreadBlockInVM + 轮询点分布**

### 核心故事线（禁止做源码翻译机！）

[01-Safepoint-Protocol] 已经把 begin/end 的三态协议讲透了。你看到：
- begin() 中 L253 `_state = _synchronizing`，L278 `make_polling_page_unreadable()` arm polling page
- end() 中 L565 `make_polling_page_readable()` disarm polling page
- block() 被 polling page SIGSEGV handler 调用，是 JavaThread 的阻塞入口

但你发现了吗？[01] 根本**没有解释** JavaThread 到底怎么"发现"自己被 arm 了。begin() 改了 `_state` 做了 mprotect，然后呢？JavaThread 是**被动收到信号**还是**主动轮询发现**？如果是主动轮询——在哪轮询？怎么做到低开销？`ThreadBlockInVM` 和这个轮询机制是什么关系？

**本文的核心叙事线**是从 "polling page 被 arm" 到 "JavaThread 进入 block()" 的端到端追踪：

1. **★ 为什么用轮询（Polling）而不是信号（Signal）？** — 这是一个设计哲学问题。如果 VMThread 通过信号通知每个线程停，需要 `pthread_kill` 遍历所有线程 → O(N) 系统调用。轮询则是**线程自省**——线程在安全点上主动读一个内存地址 → O(1) 全局操作（mprotect） + 每个线程 O(1) 内存读。追问：**为什么内存读比信号快？** `test` 指令 20-30 CPU cycles vs `pthread_kill` 数千 cycles（用户态→内核态→信号分发→用户态 handler）

2. **★ Global Page Poll 的完整链路** — `mprotect(PROT_NONE)` → TLB entry 被标为 invalid → 每条 JavaThread 在安全点执行 `test [polling_page], 0` → MMU 查 TLB → invalid → 内存访问 → page fault → SIGSEGV → 内核调用 JVM 注册的 sigsegv handler → `handle_polling_page_exception()` → `block()`。追问：**这个 page fault 和普通的无效地址访问有什么区别？** JVM 的 SIGSEGV handler 用 `si_addr`（fault address）判断是不是 polling page——如果是，进入 safepoint 流程；如果不是，才是真正的 crash 或 `NullPointerException` 的隐式检测（implicit null check）。

3. **★ ThreadLocal Handshake (JDK 10+) — 为什么比 Global Page Poll 更优？** — 不再需要 `mprotect`（和其昂贵的 TLB shootdown），而是在每个 JavaThread 的 `Thread` 对象上设置一个 flag。线程在安全点上检查自己的 flag → 如果是 handshake → 执行。优势：只影响目标线程（不需要全局 TLB flush），可以和 safepoint 并行使用（手握手操作 ≠ 全局暂停）。追问：**那为什么 JDK 11 默认还是 ThreadLocalHandshakes=false？** 稳定性+兼容性——ThreadLocal Handshake 依赖 JIT 正确插入 poll 点，早期版本有遗漏路径的风险。

4. **★ `SafepointMechanism::poll()` — Global 和 Local 模式的代码差异** — 关键不只是函数逻辑不同，而是 **inline vs outline** 的区别。`global_poll()` 和 `local_poll()` 都是 inline 函数（在 `safepointMechanism.inline.hpp` 中），编译后内联到每个轮询调用点的 JIT 代码中。这意味着：每个安全点的轮询耗时 = 单条 load 指令（Global）或单条 flag 检查（ThreadLocal）。

5. **★★★ `transition_and_fence()` — 为什么状态转换必须带 StoreLoad 屏障？** — 这是 [01] 中 "先改 `_state` 再 arm" 的**对偶问题**。在 [01] 中，VMThread 先写 `_state = _synchronizing` 再 arm polling page（用 `OrderAccess::fence()` 做 StoreLoad），保证先写后读的顺序。而 `transition_and_fence()` 是 JavaThread 侧的对应操作：JavaThread 写 `_thread_state` 后发 `storeload` barrier，保证 VMThread 在 SPIN 循环中（无锁读取 `_thread_state`）看到最新值。追问：**如果不用 fence 会怎样？** VMThread 可能从 store buffer 读到旧值 `_thread_in_vm`，认为线程还未到达 safepoint → 死等/超时。这是"隐藏读者"问题的经典案例——写者是 JavaThread 自己，读者是不加锁读 `_thread_state` 的 VMThread。

6. **★ `ThreadBlockInVM` 的生命周期 — 为什么析构要 poll 而构造不用？** — 构造时：`_thread_in_vm` → `_thread_blocked`（`transition_and_fence` 带 StoreLoad），告诉 VMThread"我要阻塞了"——不需要 poll（因为线程主动阻塞，不需要被 safepoint 暂停）。析构时：`_thread_blocked` → `_thread_in_vm` → `poll()`！为什么析构要 poll？因为线程从 `_thread_blocked` 恢复到 `_thread_in_vm` 后可能**立刻被新的 safepoint 要求暂停**——如果不 poll 就继续执行，相当于漏掉了 safepoint。追问：**那构造时为什么不 poll？** 构造时线程主动声明阻塞 → 如果此时有 safepoint 在进行，线程已处于 `_thread_blocked`（安全位置）；如果没有 safepoint，poll 检查是多余的。

7. **★ 轮询点分布 — JavaThread 在哪些位置 poll？** — 这是个完整性检查：如果遗漏了一个执行路径上的 poll 点，safepoint 就无法暂停该路径上的线程。真实的 4 个轮询点：
  - ① **解释器方法返回 & 回边**：`TemplateTable::_return`（return bytecodes）和 `TemplateTable::branch`（back-branch bytecodes：goto/if*/tableswitch/lookupswitch），在这些字节码处理完成后调用 `SafepointMechanism::poll()`。注意：**不是每条 bytecode 后都 poll**——只在方法边界和回边处 poll，否则解释器性能不可接受。
  - ② **编译代码循环回边**：JIT 在 `Parse::do_one_bytecode()` 的 loop back-branch 处插入 `safepoint_poll` IR 节点 → 编译后生成 `test` 指令
  - ③ **JNI 返回**：`ThreadInVMfromNative::~ThreadInVMfromNative()` → `transition_and_fence(native→vm)` → `SafepointMechanism::poll()`
  - ④ **ThreadBlockInVM 析构**：`_thread_blocked→_thread_in_vm` 后的 `poll()`
  - ★ 追问：**为什么只有这 4 个就够了？** 因为任何从"不受 JVM 控制"回到"受 JVM 控制"的入口都被覆盖：方法边界（①+②）、native 边界（③）、阻塞恢复边界（④）。任意代码执行路径必然通过这 4 类入口之一回到 JVM 感知状态。
  - ★ 反例思考：**end() 之后为什么不需要 poll？** — `end()` 后线程已被 `Threads_lock->unlock()` 释放，此时 `_state` 已经是 `_not_synchronized`，poll 检查返回 false 是空操作，不需要。
  - ★ 追问：**JIT 代码不需要在每条指令后都 poll，为什么 JVM 不怕漏掉？** 因为这 4 个 poll 点覆盖了所有"从用户态回到 JVM 感知状态"的入口。任何不 poll 的代码路径长度都是有限的（方法内指令有限 + 循环有回边 poll），最终必然到达一个 poll 点。

8. **★ SIGSEGV handler 中的 polling page 检测 — 怎么区分 polling page fault 和真正的 crash？** — `JVM_handle_linux_signal()` 检查 `sig == SIGSEGV`，然后检查 `si_addr`（fault address）是否在 polling page 地址范围内。如果是 → 调用 `SafepointSynchronize::handle_polling_page_exception()`。如果不是 → 可能是 NullPointerException（`si_addr` 在保护页范围内→implicit null check）或真正的 crash。追问：**polling page 和 implicit null check 都是 SIGSEGV，怎么不混淆？** 它们使用不同的保护页——polling page 是独立的守护页（`_polling_page`），implicit null check 是第一页（地址 0 附近）。

### 禁止行为

- ❌ 把 `global_poll()` 和 `local_poll()` 贴出来逐行翻译——它们是单行函数
- ❌ 把 SIGSEGV handler 源码整段贴出来——只引用判断 polling page 的关键分支
- ❌ 混淆 `transition_and_fence` 和普通 `set_thread_state`——前者带 StoreLoad，后者不带
- ❌ 遗漏 TLB shootdown 的成本分析——这是为什么需要 ThreadLocal Handshake 的核心动机
- ❌ 把 5 个轮询点列出来就完事——必须解释"为什么这 5 个够了"（完整性论证）
- ❌ 遗漏 `SafepointMechanism::poll()` 的 Global/Local dispatch 逻辑
- ❌ 不解释 `block_if_requested()` vs `block()` 的关系
- ❌ 不画端到端时序图——从 `make_polling_page_unreadable()` 到 `block()` 的全路径
- ❌ 不验证源码行号——所有行号必须用 grep 确认
- ❌ 把 Global Page Poll 和 ThreadLocal Handshake 等比重描述——JDK 11 默认 Global，ThreadLocal 是实验性

### 要求行为

- ✅ **★ Global Page Poll 的完整链路必须画成 Mermaid 时序图**：VMThread → mprotect → TLB → JavaThread `test` 指令 → MMU → page fault → kernel SIGSEGV → JVM handler → `handle_polling_page_exception()` → `block()`
- ✅ **★ 两种轮询模式的对比表必须精确**：arm 方式 / poll 方式 / disarm / 每线程开销 / 全局开销 / 最小延迟 / 是否影响未参与线程 / JIT poll 点插入
- ✅ **★ `transition_and_fence` 必须结合 [01] 的 SPIN 循环分析**：VMThread 无锁读 `_thread_state` 需要 StoreLoad 保证可见性——没有 fence → VMThread 读旧值 → 死等
- ✅ **★ ThreadBlockInVM 构造/析构必须对比**：构造时不 poll（主动阻塞，安全）、析构时 poll（可能被 safepoint 要求停）——用表对比
- ✅ **★ 5 个轮询点必须标注"为什么必须在此处 poll"**：方法返回（安全状态入口）、循环回边（防止无线循环逃逸 safepoint）、JNI 返回（跨语言边界）、Blocking 恢复（从阻塞回到运行）
- ✅ **★ `block_if_requested()` 和 `block()` 的关系必须解释**：`block_if_requested()` 是一个 thin wrapper——检查 dispatch 模式（Global vs ThreadLocal）→ 如果是 safepoint → 调用 `block()`；如果是 handshake → 执行 `HandshakeClosure`
- ✅ **★ SIGSEGV handler 中 polling page 检测的分支逻辑**：`si_addr` 范围判断 → polling page / null check / crash 三向分流
- ✅ **★ 和 [01] 的衔接**：本文是 [01] 的"下半部分"——[01] 讲 VMThread 侧（begin/end），本文讲 JavaThread 侧（poll/block/fence）
- ✅ **GDB 验证 ≥10 条**：重点在 `global_poll()` 返回值、SIGSEGV handler 触发、`transition_and_fence` 的 fence 效果、ThreadBlockInVM 析构时的 poll

## 二、标准环境

- OpenJDK 11 slowdebug build
- `-Xms8g -Xmx8g -XX:+UseG1GC`
- 64 位 Linux x86
- ★ GDB 在 slowdebug build 中验证（`#ifdef ASSERT` 全部生效）
- ★ 默认 Global Page Poll 模式（`ThreadLocalHandshakes=false`）

## 三、聚焦源文件

| # | 文件 | 完整路径 | 核心函数（需验证行号） | 本文角色 |
|---|------|---------|---------------------|---------|
| 1 | `safepointMechanism.inline.hpp` | `src/hotspot/share/runtime/safepointMechanism.inline.hpp` | `global_poll()`, `local_poll()`, `poll()`, `block_if_requested()` | ★★★ poll 热路径（inline，每个轮询点执行） |
| 2 | `safepointMechanism.hpp` | `src/hotspot/share/runtime/safepointMechanism.hpp` | `arm_local_poll()`, `disarm_local_poll()`, `uses_global_page_poll()`, `polling_type` | ★ arm/disarm 接口 |
| 3 | `safepointMechanism.cpp` | `src/hotspot/share/runtime/safepointMechanism.cpp` | `default_initialize()`, `block_if_requested_slow()`, `initialize_serialize_page()` | ★ 初始化 + 慢路径 |
| 4 | `interfaceSupport.inline.hpp` | `src/hotspot/share/runtime/interfaceSupport.inline.hpp` | `ThreadBlockInVM`(:297), `transition_and_fence()`(:136), `ThreadInVMfromNative` | ★★ 线程状态转换 + StoreLoad fence + poll 嵌入点 |
| 5 | `os_linux.cpp` | `src/hotspot/os/linux/os_linux.cpp` | `make_polling_page_unreadable()`(:6011), `make_polling_page_readable()`(:6018), SIGSEGV handler `JVM_handle_linux_signal()` | ★★ Linux 平台的 mprotect + signal handler |
| 6 | `safepoint.cpp` | `src/hotspot/share/runtime/safepoint.cpp` | `handle_polling_page_exception()`(:996), `ThreadSafepointState::handle_polling_page_exception()`(:1211), `block()`(:859) | ★★ SIGSEGV→block 的桥接 + JIT poll return 特殊处理 |
| 7 | `handshake.hpp` | `src/hotspot/share/runtime/handshake.hpp` | `Handshake`(:48), `HandshakeClosure` | ★ ThreadLocal Handshake 接口（浅析） |
| 8 | `handshake.cpp` | `src/hotspot/share/runtime/handshake.cpp` | `execute()`(:389), `process_by_self()` | ThreadLocal Handshake 的调度执行 |
| 9 | `stubGenerator_x86_64.cpp` | `src/hotspot/cpu/x86/stubGenerator_x86_64.cpp` | `generate_safepoint_poll()` — 生成 `test [polling_page], 0` 的 stub 代码 | ★ `test` 指令的 CPU 级生成（本文不要求深度 AI 读，但需知道它存在） |

## 四、必须深度走读的核心概念

> 以下不是答案——是必须从源码中挖掘答案的问题列表。每道题先定位源文件行号，再回答"为什么"，最后用 3-5 行关键源码做引证。禁止贴整段函数。

### 4.1 ★★★ Global Page Poll 的端到端链路 — 从 mprotect 到 block()

```
问题：
  ① mprotect(PROT_NONE) 后，TLB 中对应 entry 发生了什么？
     答案方向: TLB entry 的 Present bit 被清零（或整个 entry 被 invalidate）
     IPI (Inter-Processor Interrupt) → 其他核心被迫刷新自己的 TLB

  ② JavaThread 执行 `test [polling_page], 0` 时，CPU/MMU 的内部流程是什么？
     线索: os_linux.cpp + x86 的 page fault 机制
     答案方向: 虚拟地址 → 查 TLB → miss/invalid → 查页表 → PTE 的 Present bit = 0
     → 硬件触发 #PF (Page Fault exception) → CPU 压栈 error code + CR2(fault addr)
     → 内核的 page_fault handler → do_page_fault() → 发现是用户态合法地址但页不存在
     → force_sig(SIGSEGV) → 设置 siginfo_t.si_addr = fault_addr

  ③ JVM 的 SIGSEGV handler 怎么区分 polling page fault 和真正的 SEGV？
     线索: os_linux.cpp 的 JVM_handle_linux_signal()
     答案方向: 检查 si_addr 是否在 _polling_page 的地址范围内（通常是一页）
     → 是 → is_polling_page_fault() → handle_polling_page_exception()
     → 否 → 检查是否 implicit null check（si_addr 在操作系统保护页范围内）
     → 否 → 真正的 crash

  ④ handle_polling_page_exception() → block() 之间的调用链是什么？
     handle_polling_page_exception(thread) 
       → ThreadSafepointState::handle_polling_page_exception()
         → 判断是 poll_return 还是 poll（通过 nmethod 的 metadata）
         → SafepointMechanism::block_if_requested(thread)
           → ★ 内部先调用 SafepointSynchronize::do_call_back() 检查 _state != _not_synchronized
           → 如果 do_call_back() → SafepointSynchronize::block(thread) [已在01详细分析]
           → 如果 !do_call_back() → 直接返回（竞态：arm 后立即 disarm，page fault 白触发了）
           → 如果是 ThreadLocal Handshake → Handshake::process_self()
```

### 4.2 ★★★ Global vs ThreadLocal 两种轮询模式的精确对比

```
★★★★★ 表格格式（必须不少于 8 个维度）：

| 维度 | Global Page Poll (默认) | ThreadLocal Handshake (JDK 10+) |
|------|------------------------|--------------------------------|
| arm 方式 | mprotect(polling_page, PROT_NONE) — 系统调用 | 设置 JavaThread 对象上的 flag (CAS) — 用户态 |
| arm 开销 | TLB shootdown + IPI — ~1μs | 1 条 CAS — ~20ns |
| poll 开销（每线程每次）| disarm 状态：`test`, 0] — 20-30 cycles（TLB 命中）
                                        arm 状态：page fault → SIGSEGV → handler — 1000+ cycles | `test [thread->handshake_flag], 0` — ~5 cycles（始终） |
| 影响范围 | 全局 — 所有核心的 TLB 被刷新 | 仅目标线程 — 不影响其他线程 |
| JIT poll 点插入 | safepoint_poll IR node → `test` 指令 | 同 Global（额外加 handshake 检查） |
| JNI 返回是否检查 | 是（ThreadInVMfromNative 析构） | 是（同 Global） |
| 并发粒度 | 必须全局 STW（所有线程） | 可以单线程握手+多线程并行 |
| 最小延迟 | ~5μs（mprotect + TLB reload） | ~50ns（CAS + flag check） |
| 稳定性 | JDK 1.2+，成熟 | JDK 10+，默认关闭（需 -XX:+ThreadLocalHandshakes） |
| 是否可用 | 始终 | `ThreadLocalHandshakes` flag + JIT 支持 |

追问: 为什么 JDK 11 关着 ThreadLocalHandshakes 但 arm 代码中两种路径都写了？
  答案方向: 因为 JIT 生成的 poll 代码是编译时决定的（根据 ThreadLocalPoll 宏）。
  如果编译时 ThreadLocalHandshakes=true，poll 代码检查线程本地 flag；
  如果 false（默认），poll 代码读全局 polling page。
```

### 4.3 ★★★ `transition_and_fence()` — StoreLoad 屏障的必要性

```
问题：
  ① transition_and_fence() 的 StoreLoad 屏障和 begin() 中的 OrderAccess::fence() 是什么关系？
     线索: [01] SPIN 循环中 VMThread 无锁读 _thread_state
     答案方向: 这是 Java 并发模型中的 "消息传递" 模式——
        P1 (JavaThread): 写 _thread_state = _thread_blocked → storeload() → 读 polling page
        P2 (VMThread):    无锁读 _thread_state (在 SPIN 循环的 examine_state_of_thread 中)
        storeload 保证: P1 的所有 store 在 load 之前被全局可见 → P2 读到最新状态

  ② 如果没有 storeload()，具体会发生什么？（需要画时间线）
     JavaThread CPU:       _thread_state = _thread_blocked (write)
                           --- store buffer 中, 未刷到 L1 ---
                           poll() → 阻塞（正确）
     VMThread CPU:         读 _thread_state = _thread_in_vm (旧值！)
                           → 认为线程还在运行 → 继续 SPIN → 死等
     
  ③ StoreLoad 的性能开销是多少？
     x86: mfence → ~33-100 cycles（比普通 store 慢 10-30x）
     但好处: 避免跨核缓存一致性协议的延迟（MESI → ~100-300 cycles per miss）
     因此有 fence 比没有 fence 时 VMThread 读 stale 值 → 多 SPIN 几百次 → 总计慢更多

源码验证重点：
  - interfaceSupport.inline.hpp 中 transition_and_fence() 的实现
  - safepoint.cpp 中 examine_state_of_thread() → _thread->thread_state()（无锁读取）
  - [01] 中 SPIN 循环 L302-308（迭代读 _thread_state）
```

### 4.4 ★★ `ThreadBlockInVM` — 构造/析构 + 为什么析构要 poll？

```
问题：
  ① ThreadBlockInVM 构造:
     _thread_in_vm → _thread_blocked（主动声明阻塞）
     作用: 告诉 VMThread "我在安全位置，不需要暂停我"
     为什么不 poll？— 因为线程即将阻塞（如等锁），如果当前有 safepoint，线程在 _thread_blocked
     状态下自动被视为到达；如果当前没有 safepoint，poll 是空检查。

  ② ThreadBlockInVM 析构:
     _thread_blocked → _thread_in_vm（恢复运行）
     为什么必须 poll？— ★ 关键！线程从阻塞恢复后，可能在阻塞期间 VMThread 发起了新 safepoint
     → 线程的 _state 是 _thread_blocked（对 VMThread 可见），但线程已经要恢复运行了
     → 必须先 transition_and_fence（保证状态变化被 VMThread 看到）
     → 再 poll()（检查是否有待处理的 safepoint）
     → 如果有 → block()；如果没有 → 继续

  ③ 使用场景分析（每个场景标注源码位置）:
     - Mutex::lock() → 等锁时 → ThreadBlockInVM → 允许 safepoint
     - Monitor::wait() → 释放 monitor 等待 → ThreadBlockInVM → 允许 safepoint
     - JNI 调用 → ThreadInVMfromJava → 进入 VM 代码区域
     - GC 的 VM_Operation::doit() 内部 → 可能不需要 ThreadBlockInVM（已在 safepoint 中）

  ④ ThreadBlockInVM 和 block() 的对比（已在[01]简要提及，本文深化）:
     二者终态相同 (_thread_blocked) 但路径不同—前者主动声明，后者被迫暂停。
     本文需要画一个对比表（触发、调用点、是否需要 poll、是否有 fence、VMThread 的视角）
```

### 4.5 ★ 轮询点分布 — 为什么这 4 个就够了？（+ 2 个反例分析）

```
这是本文的"完整性论证"——必须解释为什么不会漏掉线程：

① 解释器方法返回 & 回边 (TemplateTable::_return & TemplateTable::branch):
   → return bytecodes (areturn/ireturn/return 等) 和 back-branch bytecodes (goto/if*/tableswitch/lookupswitch)
     处理完成后，解释器调用 SafepointMechanism::poll() 检查是否发生 safepoint
   → 注意：不是每条 bytecode 后都 poll——只在方法边界和回边处
   → 如果有 → do_call_back → block()
   覆盖了所有纯解释执行的线程（-Xint 场景）

② JIT 编译代码中的循环回边 (safepoint_poll IR node):
   → JIT 在 if/for/while 的 back-branch 处插入 safepoint_poll
   → Parse::do_one_bytecode() → C2 的 Parse::add_safepoint()
   → 编译后生成 test [polling_page], 0 指令
   为什么必须在循环回边处 poll？— 因为编译代码可以无限循环而不返回！
   如果不在这里 poll → 无线循环无法暂停 → safepoint 超时

③ JNI 返回 (ThreadInVMfromNative::~ThreadInVMfromNative()):
   → JNI 代码执行完毕后 → transition_and_fence(native→vm) → poll()
   为什么必须？— 线程在 native 中不 poll（因为 native 代码不受 JVM 控制）
   必须等线程回到 JVM 才能拦截

④ ThreadBlockInVM 析构 (从 _thread_blocked 恢复):
   → transition_and_fence → poll()
   已在 4.4 分析

⑤ UseCountedLoopSafepoints 控制下的计数循环:
   → 即使 JIT 可能消除某些短循环中的 poll（因为 SafePointNode 有消除优化）
   → UseCountedLoopSafepoints=true（默认）保证即使消除的循环也有 poll

★ 追问: 如果线程在 `_thread_in_native` 中，它怎么被暂停？
   → 不在 native 中暂停！VMThread 在 SPIN 循环的 examine_state_of_thread() 中
   发现 _thread_in_native + walkable stack → roll_forward(_at_safepoint) → 标记线程安全
   → 线程从 native 返回时（ThreadInVMfromNative 析构）检查 _state → 发现 _synchronizing → block()
   ★ 关键: _thread_in_native 的线程在 native 执行期间"不被阻塞"——只有 JVM 权限暂停！
```

### 4.6 ★ SafepointMechanism::poll() — Global/Local 的 dispatch 逻辑

```
源码位置: safepointMechanism.inline.hpp:50-52

inline bool SafepointMechanism::poll(Thread* thread) {
  return uses_global_page_poll() ? global_poll() : local_poll(thread);
}

global_poll() → 读全局 _polling_page → 如果 page fault → SIGSEGV（已 arm）
                                → 如果正常返回 0 → 不阻塞（已 disarm）
local_poll()  → 读 thread->_poll_data（或 thread->_handshake flag）
                → 如果 arm → block_if_requested()

★ 追问: 为什么 poll() 返回 bool 而不是 void？
   → 返回值用于控制流: true → 需要阻塞 / false → 继续执行
   解释器/JIT 代码中: if (SafepointMechanism::poll(thread)) { block(); }
```

### 4.7 ★ `block_if_requested()` 和 `block()` 的关系

```
block_if_requested() 是 SafepointMechanism 层的抽象，负责选择:
  - 如果是 safepoint → 调用 SafepointSynchronize::block(thread)（[01] §五）
  - 如果是 handshake → 调用 Handshake::process_self()（本文浅析）
  - 如果 thread 没有待处理的操作 → 直接返回

block_if_requested_slow() 是慢路径（safepointMechanism.cpp），处理:
  - ThreadLocal Handshake 时需要执行 HandshakeClosure::do_thread()
  - 跨平台兼容（某些平台不支持 ThreadLocal poll → 回退到 global poll）

★ 追问: 为什么有 block_if_requested() 和 block_if_requested_slow() 两个函数？
   → inline 版本（快路径）只做快速判断（global poll arm → block）
   → slow 版本处理复杂情况（handshake、跨平台回退）
   这是典型的 "fast path / slow path" 优化模式
```

## 五、文章结构

```
§〇 源文件清单（跨 runtime/os/handshake）

§一 为什么 JavaThread 需要"主动轮询"而不是"被动信号"？
  ❓ poll vs signal — 性能权衡
  ❓ 为什么可以因为 polling page 是 O(1) 全局操作 + O(1) 每线程检查？
  1.1 signal 方案的开销分析（pthread_kill × N）
  1.2 polling 方案的开销分析（mprotect × 1 + test × N）
  1.3 与 [01] 的衔接：begin() arm polling → JavaThread poll → block()

§二 ★★★ Global Page Poll — 从 mprotect 到 block() 的端到端链路
  ❓ mprotect 后 JavaThread 的 `test` 指令为什么会触发 SIGSEGV？
  ❓ SIGSEGV handler 怎么判断是 polling page 还是 crash？
  2.1 Mermaid 时序图：VMThread → mprotect → TLB → test → page fault → SIGSEGV → block()
  2.2 x86 页表/TLB 机制的精简解释
  2.3 SIGSEGV handler 中的分支：polling page / implicit null / crash 三向分流
  2.4 handle_polling_page_exception() 源码走读（3-5行关键源码）
  2.5 poll_return 的特殊处理——与 poll 的区别
      ★ 为什么方法返回处的 poll 需要特殊处理？
      方法返回 oop 可能在寄存器中。如果在 poll_return 处直接进入 safepoint，
      GC 无法追踪寄存器中的 oop → 需要先 `HandleMark` 将返回值保存到栈上
      → `block()`（可能发生 GC）→ 恢复。这是 GC 和 safepoint 交互的微妙细节。

§三 ★★ ThreadLocal Handshake — 无 mprotect 的轮询
  ❓ 为什么需要另一种轮询模式？
  3.1 两种模式对比表（10维度）
  3.2 arm/disarm 的 CAS 实现 vs mprotect
  3.3 block_if_requested() 中的 dispatch 逻辑

§四 ★★★ transition_and_fence — StoreLoad 屏障的必要性
  ❓ 没有 fence 会发生什么？
  ❓ 和 [01] begin() 中的 fence 是什么关系？
  4.1 transition_and_fence() 源码走读 (interfaceSupport.inline.hpp)
  4.2 隐藏读者分析：VMThread 在 SPIN 循环中无锁读 _thread_state
  4.3 错误时间线：没有 fence 时 VMThread 读到旧状态的场景
  4.4 与 [01] SPIN 循环的交叉引用

§五 ★★ ThreadBlockInVM — 构造/析构 + 为什么析构要 poll
  ❓ 构造时不poll，析构时poll——为什么不对称？
  5.1 ThreadBlockInVM 生命周期源码走读 (interfaceSupport.inline.hpp)
  5.2 使用场景追踪（Mutex::lock / Monitor::wait / JNI 转换）
  5.3 与 block() 的对比表

§六 ★ 轮询点分布 — 为什么这 4 个就够了？（+ 反例分析）
  ❓ 如果漏掉一个轮询点，会有什么后果？
  6.1 4 个轮询点的源码位置 + 触发条件 + 2 个反例（end() 后为什么不 poll？UseCountedLoopSafepoints 怎么补充？）
  6.2 完整性论证：为什么覆盖了所有"从不可见→可见"的入口
  6.3 _thread_in_native 的线程怎么被暂停？— 不在 native 中暂停！

§七 GDB 验证 + 可证伪断言（≥10 条）
  断言 1-3: polling page 读验证（disarm 时返回 0，arm 时触发 SIGSEGV）
  断言 4-5: transition_and_fence 的 StoreLoad 效果（GDB 在两个CPU上观察 _thread_state）
  断言 6: ThreadBlockInVM 析构时的 poll 调用（断点验证）
  断言 7: Global Page Poll SIGSEGV handler 中 si_addr 检查
  断言 8: strace 验证 mprotect 系统调用（PER_NONE / PROT_READ）
  断言 9: 验证 safepointMechanism.inline.hpp 中 poll() 的内联效果（objdump -d libjvm.so | 查看 global_poll 汇编）
  断言 10: ThreadLocal Handshake 的 CAS arm/disarm (需要 -XX:+ThreadLocalHandshakes)

  可证伪断言 1: Global Page Poll 关闭 (-XX:-UseSafepointPolling) → 没有 mprotect 调用
  可证伪断言 2: disarm 状态下 *(polling_page) == 0
  可证伪断言 3: arm 状态下 *(polling_page) → SIGSEGV
  可证伪断言 4: transition_and_fence 中包含 storeload fence（反汇编验证）
  可证伪断言 5: ThreadBlockInVM 析构时调用 SafepointMechanism::poll()
```

## 六、写作要求

**最重要的一条**：以 `[01-Safepoint-Protocol]` 的写作风格为参考——以"❓ 为什么..."开头，先建立设计动机，再用源码做证据。

1. **★ Global Page Poll 的端到端链路是全文灵魂**：必须画 Mermaid 时序图——从 VMThread 的 `make_polling_page_unreadable()` 到 JavaThread 的 `block()`——标注每个步骤的"谁、在哪、做什么"

2. **★ 和 [01] 的双向引用**：
   - [01] 的 begin() arm polling → 本文解释 arm 后 JavaThread 怎么响应
   - [01] 的 end() disarm polling → 本文解释 disarm 后 JavaThread 怎么恢复
   - [01] 的 block() → 本文解释谁调用了 block()
   - 本文的 transition_and_fence() → [01] 的 SPIN 循环是 fence 的"隐藏读者"

3. **★ 两种轮询模式的对比表**：不少于 10 个维度，标注 JDK 11 默认值

4. **★ ThreadBlockInVM 构造/析构对比**：构造时不 poll ✓ / 析构时必须 poll ✓ —— 必须解释不对称性

5. **★ 5 个轮询点的完整性论证**：不只是列出来——必须回答"为什么不会有第 6 个漏掉的路径"

6. **★ SIGSEGV handler 的三向分流**：polling page / implicit null check / crash —— 必须标注每个分支的判断条件和源码行号

7. **交叉引用**：[01-Safepoint-Protocol] + [07-Internal-Locks §四] + [07-Thread-Architecture §五] + [09-JavaThread-System]

8. **GDB 验证重点**：`global_poll()` 返回值 + SIGSEGV handler 的 `si_addr` + `transition_and_fence` 的反汇编验证（查看 mfence 指令）

## 七、输出格式

- Markdown 文件，命名为 `02-Polling-Mechanism.md`
- 输出路径：`/data/workspace/openjdk-cut-new/probe_md/libjvm-analysis/08-safepoint/`
- 元信息头（标准环境 + 源文件 + 前置 [01-Safepoint-Protocol] [07-Internal-Locks §四] [07-Thread-Architecture §五] [09-JavaThread-System] + 阅读收益）
