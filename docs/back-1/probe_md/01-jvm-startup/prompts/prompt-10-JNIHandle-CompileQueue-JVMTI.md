# PROMPT: 请撰写 10-JNIHandle-CompileQueue-JVMTI.md

## §〇 Production Scenario（必须真实出现在文档 §〇 中）

**Scenario 1: JNI local reference overflow**. A Java application calling native methods in a loop gets `JNI ERROR (app bug): local reference table overflow (max=65536)`. The JNI specification guarantees only 16 local references per native call, but HotSpot pre-allocates 32 slots per `JNIHandleBlock`. In the trace: `PushLocalFrame(512)` was supposed to contain references, but each iteration of `FindClass("SomeClass")` creates a new local reference without releasing it. The fix is `DeleteLocalRef(cls)` after use, or `PushLocalFrame` / `PopLocalFrame` boundaries.

**Scenario 2: CompileBroker dead compilation**. `-XX:-TieredCompilation -XX:CompilationPolicyChoice=2` selects `TieredThresholdPolicy` but tiered is disabled → `Unimplemented()` crash during `compilationPolicy_init`. The correct flag is `-XX:CompilationPolicyChoice=0` (SimpleCompPolicy) for non-tiered mode.

**Scenario 3: JVMTI agent not loaded**. `-agentpath:/path/to/agent.so` at startup, but the agent never receives `VMStart`. The root cause: `Agent_OnLoad` returned `JNI_ERR`, causing `vm_exit_during_initialization` before any Java class loading. The agent library's `Agent_OnLoad` signature was wrong (missing `const` on third parameter).

**诊断三件套**（直接写进 §〇）:

```bash
# 1. JNI local reference overflow — 查看 max local capacity
jcmd <pid> VM.native_memory summary | grep "JNI Handle"

# 2. 检查编译策略
jcmd <pid> VM.flags -all | grep -E "CompilationPolicyChoice|TieredCompilation"

# 3. JVMTI agent 加载诊断
strace -e openat,mmap java -agentpath:/path/to/agent.so -version 2>&1 | grep agent
# 确认 .so 被 dlopen 加载

# 4. GDB 断点 Agent_OnLoad 调用
gdb -ex "break thread.cpp:4479" \
    -ex "run" \
    -ex "print *on_load_entry" \
    -ex "print agent->options()" \
    --args java -agentpath:agent.so -version
```

**反事实**：如果 JNI local reference 使用无限增长的 vector 而非固定块 → 无上限的 JNI 调用可消耗 GB 级内存，GC 需遍历所有 local 引用作为根（HotSpot 的 JNIHandleBlock 链表天然限制遍历成本 ≤ O(活跃块数)）。如果 CompilationPolicy 的 fatal error 改为 warning + fallback → 用户可能在不知情下以低效策略运行数月。如果 Agent_OnLoad 失败仅打印警告而非退出 → agent 会在 VMInit 阶段因缺失能力而崩溃，症状更诡异难调试。

---

## §一 Task + Narrative + Beginner Callouts

### Task

Reading this prompt, you will produce a document covering **four init_globals steps** (compilationPolicy_init #4, jni_handles_init #21, compileBroker_init #27) and **one Stage 3 agent initialization** (create_vm_init_agents), plus the **JVMTI env infrastructure** (JvmtiEnv/JvmtiEnvBase + JvmtiExport phase machine + JvmtiAgentThread). This is ENGINEERING documentation on the **data structures and initialization order**, not a tutorial on using JNI/JVMTI APIs.

Reader completed documents 00 (JNI_CreateJavaVM entry), 01 (CodeCache), 02 (G1 Heap), 03 (Metaspace), 04 (SymbolTable), 05 (StringTable), 06 (Mutex), 07 (PerfMemory), 08 (G1 Policy), 09 (G1 CM Infra). This doc: the remaining init_globals steps that handle **JNI reference management**, **compilation infrastructure boot**, and the **JVMTI agent loading pipeline** — the bridge between native agents and the JVM.

### Interview Story Format Answer（必须出现在 §一 末尾）

"JNI local references are managed through JNIHandleBlock — a fixed-size 32-slot block linked in a chain per thread. `allocate_handle` uses 4 allocation paths: fast (last block has space), freelist (reuse freed slots), next block (move to existing next), and expand (allocate new block via `allocate_block`). Global and weak global references use OopStorage — two independent instances (`_global_handles`, `_weak_global_handles`) with separate locks (JNIGlobalAlloc_lock, JNIWeakAlloc_lock) to prevent GC-safepoint deadlocks. CompileQueue is a doubly-linked list with `add()` appending to tail and `get()` blocking with 5-second timeout — compiler threads wait on `MethodCompileQueue_lock` and are notified on each `add()`. JVMTI agent loading at Stage 3 follows: enter_onload_phase → dlopen agent.so → dlsym Agent_OnLoad → call Agent_OnLoad(&vm, options, NULL) → enter_primordial_phase. Failure at any step is fatal (`vm_exit_during_initialization`). The JvmtiEnvBase holds per-agent state: magic 0x71EE, event callbacks table, capabilities bitmaps, and version — each agent gets its own JvmtiEnv via `JNI GetEnv()`."

### Beginner Callout Boxes（文档 §一 中必须出现 ≥7 个 callout 框）

1. **JNI Local vs Global References**: Local references are thread-local, live only for the duration of a single native call (or until PopLocalFrame). They're stored in JNIHandleBlock chains. Global references (`NewGlobalRef`) are stored in OopStorage and must be explicitly deleted (`DeleteGlobalRef`). Weak global references (`NewWeakGlobalRef`) don't prevent GC — the JVM may clear them at any safepoint. Source: `jniHandles.hpp:132`, `jniHandles.cpp:343`.

2. **OopStorage is the backend for ALL handle types**: Both `_global_handles` and `_weak_global_handles` are `OopStorage*` instances. OopStorage manages blocks of oop* slots with concurrent allocation and GC iteration. The difference: `_global_handles` uses `JNIGlobalAlloc_lock` + `JNIGlobalActive_lock`; `_weak_global_handles` uses `JNIWeakAlloc_lock` + `JNIWeakActive_lock`. Source: `jniHandles.cpp:205-210`.

3. **CompileQueue::get() blocks with 5s timeout, NOT infinite**: If the queue is empty, the compiler thread calls `MethodCompileQueue_lock->wait(5000)`. After 5 seconds, it re-checks the queue. If compilation is disabled forever, it returns NULL (thread exits). If dynamic thread count allows removal, it also returns NULL. This is a cooperative shutdown mechanism, not an error. Source: `compileBroker.cpp:433-465`.

4. **compileBroker_init does NOT create compiler threads**: It only initializes `CompilationLog`, `DirectivesStack`, and parses compiler directives. The actual compiler thread creation happens later in `compilation_init_phase1` (thread.cpp:4227), which is called from `create_vm` AFTER `init_globals` returns. Source: `compileBroker.cpp:236-251`, `compileBroker.cpp:864`.

5. **Agent_OnLoad failure is FATAL**: If any agent's `Agent_OnLoad` returns non-`JNI_OK`, the JVM calls `vm_exit_during_initialization` and prints the error. There is no graceful fallback. This design ensures that agents with broken initialization don't produce a half-initialized VM state. Source: `thread.cpp:4479-4481`.

6. **JVMTI has 5 phases, not 4**: PRIMORDIAL → ONLOAD → START → LIVE → DEAD. `enter_primordial_phase` is called after `create_vm_init_agents` completes, NOT after `Agent_OnLoad`. This is the default phase where limited JVMTI operations are allowed (mostly queries, no event registration). Source: `jvmtiExport.cpp:606-622`.

7. **JNIHandleBlock has a 32-slot fixed size**: `block_size_in_oops = 32`. This is NOT configurable and is baked into the HotSpot binary. Each block is allocated from a global free list (`_block_free_list`) protected by `JNIHandleBlockFreeList_lock` (with `_no_safepoint_check_flag` to prevent deadlock with `Threads_lock`). Source: `jniHandles.hpp:141`, `jniHandles.cpp:384-404`.

8. **CompilationPolicyChoice is validated at startup with fatal error**: Values outside [0, 2] cause `fatal("CompilationPolicyChoice must be in the range: [0-2]")`. Value 2 (`TieredThresholdPolicy`) requires `-XX:+TieredCompilation` — otherwise `Unimplemented()`. Value 1 (`StackWalkCompPolicy`) requires `COMPILER2` compiled in. Source: `compilationPolicy.cpp:71-92`.

---

## §二 Standard Environment

### Source Roots

| Root | Path | 用途 |
|------|------|------|
| JNI Handles | `src/hotspot/share/runtime/jniHandles.cpp` + `jniHandles.hpp` | JNIHandleBlock + JNIHandles::initialize |
| init_globals | `src/hotspot/share/runtime/init.cpp` (:109-212) | 初始化调用序列 |
| Compilation Policy | `src/hotspot/share/runtime/compilationPolicy.cpp` (:61-99) | compilationPolicy_init |
| Compile Broker | `src/hotspot/share/compiler/compileBroker.cpp` (:236-251, :366-465, :864-925) | compileBroker_init + CompileQueue + compilation_init_phase1 |
| Compile Broker Header | `src/hotspot/share/compiler/compileBroker.hpp` (:80-99) | CompileQueue 类定义 |
| JVMTI Export | `src/hotspot/share/prims/jvmtiExport.cpp` (:606-622, :653-696) | JvmtiExport 阶段切换 + post_vm_start/init |
| JVMTI Export Header | `src/hotspot/share/prims/jvmtiExport.hpp` (:65) | JvmtiExport 类定义 |
| JVMTI Env Base | `src/hotspot/share/prims/jvmtiEnvBase.hpp` (:57-105) | JvmtiEnvBase 类定义 |
| JVMTI Env Base Impl | `src/hotspot/share/prims/jvmtiEnvBase.cpp` (:190-222) | JvmtiEnvBase 构造函数 |
| JVMTI Agent Thread | `src/hotspot/share/prims/jvmtiAgentThread.hpp` (:36) | JvmtiAgentThread 类定义 |
| JVMTI Agent Thread Impl | `src/hotspot/share/prims/jvmtiImpl.cpp` (:65-87) | JvmtiAgentThread 构造 + start_function_wrapper |
| Thread (create_vm agents) | `src/hotspot/share/runtime/thread.cpp` (:4358-4487, :4006-4009) | create_vm_init_agents + lookup_on_load |
| Agent symbols | `src/hotspot/os/posix/include/jvm_md.h` (:43) | AGENT_ONLOAD_SYMBOLS 宏 |
| OopStorage | `src/hotspot/share/gc/shared/oopStorage.cpp` + `oopStorage.hpp` | OopStorage 后端实现 |

### Build Configuration

```bash
# 构建 libjvm.so（包含本文所有代码）
make hotspot

# 验证 JNIHandleBlock 编译进去
nm -C build/linux-x86_64-server-release/hotspot/variant-server/libjvm/libjvm.so | grep JNIHandleBlock
```

### Binary Paths

| Binary | Path |
|--------|------|
| libjvm.so | `build/linux-x86_64-server-release/hotspot/variant-server/libjvm/libjvm.so` |
| JNI handles symbols | `JNIHandles::_global_handles`, `JNIHandles::_weak_global_handles`, `JNIHandleBlock::allocate_handle` |
| CompileQueue symbols | `CompileBroker::_c1_compile_queue`, `CompileBroker::_c2_compile_queue`, `CompileQueue::add`, `CompileQueue::get` |
| JVMTI symbols | `JvmtiEnvBase::_head_environment`, `JvmtiExport::enter_live_phase` |

### Syscall / Library 速查

| Call | man | 上下文 |
|------|-----|--------|
| `dlopen` | `man 3 dlopen` | `os::dll_load` 加载 agent.so |
| `dlsym` | `man 3 dlsym` | `os::dll_lookup` 查找 Agent_OnLoad 符号 |
| `pthread_cond_wait` | `man 3 pthread_cond_wait` | `Monitor::wait` 在 CompileQueue::get 中 |
| `pthread_cond_signal` | `man 3 pthread_cond_signal` | `Monitor::notify` 在 CompileQueue::add 中 |

### Global State 初始化顺序速查（init.cpp:109-212）

```
Step  4: compilationPolicy_init()     — L124  (策略选择 + fatal 验证)
Step  5: codeCache_init()             — L127  (依赖 Step 4 的策略)
Step  9: universe_init()              — L137  (依赖 codeCache + metaspace)
Step 19: javaClasses_init()           — L163  (依赖 universe_init)
Step 21: jni_handles_init()           — L165  (依赖 universe_init，需堆存在)
Step 27: compileBroker_init()         — L177  (依赖 codeCache + compilerOracle)
```

---

## §三 Source Files Table

| # | File | 行数 | 角色 | 关键行 |
|---|------|:---:|------|--------|
| 1 | `src/hotspot/share/runtime/init.cpp` | ~300 | init_globals 调用序列 | :109-212 |
| 2 | `src/hotspot/share/runtime/jniHandles.cpp` | ~600 | JNIHandleBlock 实现 + JNIHandles::initialize | :205, :343, :384-565 |
| 3 | `src/hotspot/share/runtime/jniHandles.hpp` | ~200 | JNIHandleBlock 类定义 | :132-162 |
| 4 | `src/hotspot/share/runtime/compilationPolicy.cpp` | ~100 | compilationPolicy_init | :61-99 |
| 5 | `src/hotspot/share/compiler/compileBroker.cpp` | ~2000 | compileBroker_init + CompileQueue + compilation_init_phase1/2 | :236, :366, :433, :614, :768, :864 |
| 6 | `src/hotspot/share/compiler/compileBroker.hpp` | ~200 | CompileQueue 类定义 + CompileBroker 静态成员 | :80-99 |
| 7 | `src/hotspot/share/runtime/thread.cpp` | ~6300 | create_vm_init_agents + lookup_on_load + create_vm 主流程 | :4008, :4358-4487 |
| 8 | `src/hotspot/share/prims/jvmtiExport.cpp` | ~2800 | JvmtiExport 阶段切换 + post_vm_start/init | :606-622, :653-696 |
| 9 | `src/hotspot/share/prims/jvmtiExport.hpp` | ~80 | JvmtiExport 类声明 | :65 |
| 10 | `src/hotspot/share/prims/jvmtiEnvBase.hpp` | ~600 | JvmtiEnvBase 类定义 | :57-105 |
| 11 | `src/hotspot/share/prims/jvmtiEnvBase.cpp` | ~700 | JvmtiEnvBase 构造函数 | :190-222 |
| 12 | `src/hotspot/share/prims/jvmtiAgentThread.hpp` | ~40 | JvmtiAgentThread 类定义 | :36 |
| 13 | `src/hotspot/share/prims/jvmtiImpl.cpp` | ~1100 | JvmtiAgentThread 构造 + call_start_function | :65-87 |
| 14 | `src/hotspot/share/gc/shared/oopStorage.cpp` | ~800 | OopStorage 后端实现 | 全文 |
| 15 | `src/hotspot/os/posix/include/jvm_md.h` | ~50 | AGENT_ONLOAD_SYMBOLS 宏 | :43 |

---

## §四 Deep Dive Question Groups

### Group 1: JNIHandleBlock — 本地句柄块分配器

1. **JNIHandleBlock 的 4 条分配路径 (allocate_handle) 在什么条件下触发？快速路径 vs 空闲链表 vs 下一个 block vs 扩展的决策树是怎样的？** 答案方向：详细描述 `allocate_handle` (jniHandles.cpp:501-565) 的 4 条路径：路径A — `_last->_top < 32` 直接在最后 block 分配 (L532-536)；路径B — `_free_list != NULL` 复用已释放槽位 (L539-544)；路径C — `_last->_next != NULL` 移动到下一个已存在 block (L546-550)；路径D — `_allocate_before_rebuild == 0` 时调用 `rebuild_free_list()` 扫描所有 block 收集空闲槽 (L553-554)，否则 `allocate_block` 创建新 block (L557-563)。追问：为什么需要 `rebuild_free_list` 而不是始终创建新 block？量化对比：32 槽位 block 大小 vs C-Heap 分配开销 vs GC 遍历成本。内核引用：GC 在 safepoint 遍历 JNIHandleBlock 链表作为 root 集 (man 3 malloc, GC root enumeration)。

2. **allocate_block 的三级缓存层级是什么？线程本地 → 全局空闲链表 → new 的层级设计解决了什么并发问题？** 答案方向：线程本地空闲链表（`thread->free_handle_block()`）是无锁快速路径 (L390-392)；全局 `_block_free_list` 由 `JNIHandleBlockFreeList_lock` 保护 (L398-399)；最后 `new JNIHandleBlock()` (L400-404)。追问：为什么锁使用 `_no_safepoint_check_flag`？追查 `jni_AttachCurrentThread` 先持 `Threads_lock` 再取 `JNIHandleBlockFreeList_lock` 的死锁风险 (man 3 pthread_mutex_lock)。量化：`_blocks_allocated` 计数器追踪总块数。

3. **PushLocalFrame / PopLocalFrame 的底层机制是什么？pop_frame_link 如何实现栈帧链？** 答案方向：`push_jni_handle_block` 保存 `prev_handles` → `allocate_block` → `set_pop_frame_link(prev)` → `set_active_handles(new_block)`。`pop` 恢复 `prev_handles` → `release_block(current)`。追问：如果 PushLocalFrame 后忘记 PopLocalFrame 会怎样？内存泄漏的量化和检测方法。Counterfactual：如果 JNIHandleBlock 是单个可增长数组而非固定块链表 — GC root 遍历变成 O(所有分配过的句柄) 而非 O(活跃块数)。

### Group 2: OopStorage — 全局/弱全局句柄后端

4. **`jni_handles_init` 创建的两个 OopStorage 实例有什么区别？为什么 global 和 weak_global 需要独立锁？** 答案方向：`_global_handles` 使用 `JNIGlobalAlloc_lock` + `JNIGlobalActive_lock`，强引用阻止 GC；`_weak_global_handles` 使用 `JNIWeakAlloc_lock` + `JNIWeakActive_lock`，不阻止 GC，对象回收后句柄变为 NULL (jniHandles.cpp:205-210)。追问：为什么需要两组独立锁而非共享一个？追查 GC safepoint 与 `JNIGlobalAlloc_lock` 的交互 — 如果共享锁，weak_global 的 GC 清除操作会阻塞 global 分配。Counterfactual：如果合并为一个 OopStorage — 每个 allocation 和 GC sweep 相互阻塞，吞吐量下降。

5. **OopStorage 的 block-based 分配策略是什么？每个 block 有多少 slot？allocation 和 iteration 如何并发？** 答案方向：OopStorage 使用固定大小 block（默认 64 slots/block），每个 block 有 allocation bitmap。`allocate()` 在 block 内找空闲 slot，`release()` 标记 slot 为空。GC 迭代所有 block 的所有活跃 slot 作为 root。追问：OopStorage 如何支持并发 allocation + 并发 iteration？deadline 机制 (oopStorage.cpp)。Counterfactual：如果 OopStorage 用全局数组而非 block — 动态扩容需要 realloc + 移动所有指针。

### Group 3: CompilationPolicy — 编译策略选择

6. **compilationPolicy_init 的 3 种策略选择及其条件验证是什么？fatal error 在什么情况下触发？** 答案方向：Switch on `CompilationPolicyChoice`: 0→`SimpleCompPolicy`, 1→`StackWalkCompPolicy` (需 `COMPILER2`), 2→`TieredThresholdPolicy` (需 `TIERED`)。Default → `fatal("CompilationPolicyChoice must be in the range: [0-2]")` (compilationPolicy.cpp:71-92)。`set_in_vm_startup(DelayCompilationDuringStartup)` 延迟启动期间编译 (L63)。追问：`-XX:-TieredCompilation -XX:CompilationPolicyChoice=2` 为什么 crash？Unimplemented() vs fatal() 的区别。Counterfactual：如果 mismatch 改为 warning + fallback 到 SimpleCompPolicy — 用户不知情下可能以 suboptimal 策略运行。

7. **CompilationPolicy::set_in_vm_startup(true) 的效果是什么？启动期延迟编译如何与 compileBroker 交互？** 答案方向：`_in_vm_startup = true` 阻止启动期间的编译请求排队。`compilation_init_phase1` 创建编译器线程后，编译请求仍会被 `is_compilation_disabled_forever()` 或 startup flag 过滤。追问：这个 flag 何时被清除？通过 `set_in_vm_startup(false)` — 通常在 `call_initPhase2` 之后。Counterfactual：如果没有 startup delay — 启动期间提交数百个编译任务，排队延迟 > 编译时间，启动时间延长 2-3x。

### Group 4: CompileQueue — 编译任务队列

8. **CompileQueue 的双向链表设计如何支持 add/get/remove/select？** 答案方向：`_first`/`_last` 指针维护链表头尾。`add()` 追加到尾部 → `++_size` → `notify_all()` (compileBroker.cpp:366-398)。`get()` 阻塞等待直到队列非空，5 秒超时重试 (compileBroker.cpp:433-465)。追问：`select_task` 和 `select_for_compilation` 的策略是什么？`MethodCompileQueue_lock->wait(5000)` 为什么是 5 秒而非无限？动态编译器线程数模式下，线程通过 `can_remove()` 检查优雅退出。

9. **C1 和 C2 各有一个 CompileQueue。它们如何区分优先级？CompileTask 的 `_num_inlined_bytecodes` 等字段如何影响调度？** 答案方向：`CompileBroker::_c1_compile_queue` (L190) 和 `_c2_compile_queue` (L189) 是独立实例。C1 队列接收初始编译任务（tier 2/3），C2 队列接收最终编译任务（tier 4）。`CompileQueue::select()` 根据 CompilationPolicy 从队列中选择最优任务（非简单 FIFO）。追问：task stealing — 编译器线程是否可以从另一个队列取任务？Counterfactual：如果合并为单一队列 — C1 和 C2 任务混杂，C2 长任务阻塞 C1 快速编译。

### Group 5: Stage 3 Agent 初始化 — Agent_OnLoad 调用链

10. **create_vm_init_agents 的完整执行流程是什么？从 enter_onload_phase 到 enter_primordial_phase 的每一步做什么？** 答案方向：1) `JvmtiExport::enter_onload_phase()` 设置 JVMTI_PHASE_ONLOAD (thread.cpp:4472)；2) 遍历 `Arguments::agents()` 链表 (L4474)；3) 每个 agent: `lookup_agent_on_load` → `lookup_on_load` → `os::dll_load` (dlopen) → `os::find_agent_function` (dlsym "Agent_OnLoad") → `(*on_load_entry)(&main_vm, options, NULL)` (L4479)；4) `JvmtiExport::enter_primordial_phase()` (L4487)。追问：如果 `Agent_OnLoad` 返回非 `JNI_OK` — 立即 `vm_exit_during_initialization`，无回退。Counterfactual：如果 Agent_OnLoad 失败仅记录警告 — agent 在 VMInit 阶段因缺失能力崩溃。

11. **lookup_on_load 的 .so 查找路径是什么？绝对路径 vs 相对路径的处理有什么区别？** 答案方向：绝对路径 → `os::dll_load(name)` (thread.cpp:4375)；相对路径 → 先尝试标准 dll 目录，再尝试库路径目录 (L4379-4402)。`os::find_builtin_agent()` 检查是否静态链接的 agent (L4364-4369)。追问：Linux 上的搜索路径是什么？`LD_LIBRARY_PATH` + `java.library.path`。Counterfactual：如果只支持绝对路径 — 用户必须硬编码安装路径。

### Group 6: JvmtiEnv/JvmtiEnvBase — Agent 环境结构

12. **JvmtiEnvBase 持有哪些 per-agent 状态？magic 0x71EE 的验证机制如何工作？** 答案方向：`_magic = JVMTI_MAGIC (0x71EE)` 在构造时设置 (jvmtiEnvBase.cpp:190)，`dispose` 后变为 `0xDEFC` (jvmtiEnvBase.hpp:95)。`_event_callbacks` — agent 注册的回调表 (L100)。`_current_capabilities` + `_prohibited_capabilities` — 能力位图 (L104-105)。`_head_environment` 静态链表头 (L62)。追问：`_jvmti_external` 结构体如何暴露给 agent？`functions` 指针指向 JVMTI 接口函数表。Counterfactual：如果没有 magic 验证 — use-after-dispose 导致函数指针调用野指针。

13. **JVMTI 5 阶段状态机 (PRIMORDIAL→ONLOAD→START→LIVE→DEAD) 如何约束 agent 可用 API？** 答案方向：每个阶段只允许特定 JVMTI 函数调用。ONLOAD: 只能查询系统属性、注册 capabilities。PRIMORDIAL: 最受限。START: JNI 可用，部分事件可注册。LIVE: 全功能。DEAD: VM 关闭中。追问：阶段检查在哪里实现？`JvmtiEnvBase::check_phase()` — 每个 JVMTI 函数入口都调用。Counterfactual：如果无阶段限制 — agent 在 `Agent_OnLoad` 中调用 JNI 函数导致 native crash。

### Group 7: JvmtiAgentThread — Agent 线程包装

14. **JvmtiAgentThread 如何将 agent 的 start 函数包装进 JavaThread？start_function_wrapper 的调用路径是什么？** 答案方向：构造时 `JavaThread(start_function_wrapper)` (jvmtiImpl.cpp:66)，保存 `_start_fn`, `_env`, `_start_arg` (L67-69)。线程启动 → `start_function_wrapper` → `call_start_function` → `ThreadToNativeFromVM transition` → `_start_fn(env->jvmti_external(), jni_env, start_arg)` (L85-87)。追问：为什么需要 `ThreadToNativeFromVM` 转换？agent 的 start 函数是 native 代码，不能持有 VM 内部锁。

### Group 8: JVMTI 事件发送 — post_vm_start / post_vm_initialized

15. **post_vm_start 和 post_vm_initialized 如何遍历所有 JvmtiEnv 发送事件？early_vmstart_env 的跳过逻辑是什么？** 答案方向：遍历 `_head_environment` 链表 → 检查 `is_enabled(JVMTI_EVENT_VM_START/VMI_INIT)` → `JvmtiThreadEventMark` → `JvmtiJavaThreadEventTransition` → `env->callbacks()->VMStart/VMInit(...)` (jvmtiExport.cpp:653-696)。`post_vm_start` 跳过 `early_vmstart_env()` (已在 `post_early_vm_start` 中通知)。追问：`JvmtiThreadEventMark` 和 `JvmtiJavaThreadEventTransition` 分别做什么？Mark 标记当前线程，Transition 做 VM→Native 状态转换。

### Group 9: JNIHandleBlock 内部实现细节 — release_block 和 rebuild_free_list

16. **release_block 为什么有线程本地和全局两条回收路径？zap 操作 (memset 0) 的作用是什么？** 答案方向：线程本地回收 (thread != NULL) 无锁直接插入线程本地空闲链表头 (jniHandles.cpp:435-446)。全局回收 (thread == NULL) 加锁逐块插入 `_block_free_list` (L448-462)。`zap()` 用 `memset(0)` 清零整个 block，防止 UAF (use-after-free) 漏洞。追问：`pop_frame_link` 的递归释放 (L464-469) 在什么场景触发？PushLocalFrame 嵌套时的异常清理路径。

17. **rebuild_free_list 的启发式策略是什么？什么时候决定追加新 block 而非仅复用现有空闲槽？** 答案方向：`rebuild_free_list()` (jniHandles.cpp:568+) 扫描链中所有 block，收集 `_handles[i] == NULL` 的槽位到 `_free_list`。如果空闲槽位占总槽位比例 < 50%，追加新 block。追问：这个 50% 阈值是硬编码的 (`block_size_in_oops / 2`)? 为什么是 50% 而非其他值？Counterfactual：如果永远不复用空闲槽 — 每次 native 调用分配新 block，32 槽位 × N 次调用 → O(N²) 内存泄漏。

### Group 10: compileBroker_init 与 compilation_init_phase1 的职责分离

18. **为什么 compileBroker_init 和 compilation_init_phase1 被分成两个独立函数？它们在 create_vm 中的调用时机为什么不同？** 答案方向：`compileBroker_init` 在 `init_globals()` 中调用 (init.cpp:177)，只做轻量初始化（指令栈 + 日志），因为此时还没有 Java 线程。`compilation_init_phase1` 在 `create_vm` 的 Stage 8 调用 (thread.cpp:4227)，此时 Java 线程已存在，可以创建编译器 JavaThread 并设置 JNI handles。追问：如果在 `init_globals` 中就创建编译器线程会发生什么？没有 Java 核心类 → JNIHandleBlock 未初始化 → oop 分配失败。Counterfactual：如果合并为一个函数 — 必须等到 create_vm 后期才能初始化编译基础设施，但其他 init_globals 步骤（如 stubRoutines_init1/2）依赖代码缓存在编译基础设施之前存在。

### Group 11: JvmtiExport 全局状态 — 静态成员和单例模式

19. **JvmtiExport 作为 AllStatic 类，如何管理全局 JVMTI 状态？_head_environment 链表如何支持多 agent 环境？** 答案方向：`JvmtiExport` 是 `AllStatic` 类 (jvmtiExport.hpp:65)，所有成员都是静态的。`_head_environment` (JvmtiEnvBase*) 是全局环境链表头。每个 `JNI GetEnv()` 创建新的 `JvmtiEnv` 追加到链表。追问：链表遍历的性能影响？`post_vm_start` 遍历所有 env 发送事件，如果有 N 个 agent → O(N) 复杂度。Counterfactual：如果 JvmtiExport 不是 AllStatic 而是单例对象 — 需要多一层指针间接访问，增加 GC safepoint 期间的延迟。

### Group 12: OopStorage 与 GC 的交互 — 并发 iteration

20. **OopStorage 如何支持 GC 在 safepoint 中迭代所有活跃 oop 而不同时阻塞新的 allocation？** 答案方向：OopStorage 使用 `_active_array` 和 `_allocation_list` 分离活跃 block 和分配 block。GC 迭代 `_active_array`（快照），新 allocation 在 `_allocation_list` 上（不阻塞 GC）。`reduce_deferred_updates()` 将分配合并到活跃列表。追问：`JNIGlobalActive_lock` vs `JNIGlobalAlloc_lock` 的分离设计如何防止死锁？`_active_array` 迭代持有 `Active_lock`，`allocate()` 持有 `Alloc_lock`，两者不互斥。Counterfactual：如果使用单一锁 — GC safepoint 期间 allocation 被阻塞，可能导致 O(n) JNI 函数调用累积。

---

## §五 Article Structure（每 Section 的行数目标）

每个 Section 的目标行数和核心内容要求：

| Section | 目标行数 | 核心内容 |
|---------|:------:|---------|
| §〇 Production Scenario | ~80 | 3 个真实故障 + 诊断 bash + 反事实 |
| §一 Interview + Callouts | ~100 | 面试回答 + ≥7 Callout 框 |
| §二 Standard Environment | ~60 | source roots + build + syscall 速查 |
| §三 Source Files Table | ~30 | 15 个文件 + 行号 + 角色 |
| §四 JNIHandleBlock | ~250 | 4 路径决策树 + 三级缓存 + Mermaid |
| §五 OopStorage | ~200 | 双实例 + 锁分离 + block allocation + Mermaid |
| §六 CompilationPolicy | ~150 | 3 策略 switch + fatal 条件 + startup delay |
| §七 CompileQueue | ~200 | add/get/select + 5s 超时 + Mermaid |
| §八 Stage 3 Agent Init | ~250 | create_vm_init_agents + dlopen/dlsym + Mermaid |
| §九 JvmtiEnv | ~200 | magic + capabilities + 5 阶段状态机 + Mermaid |
| §十 JVMTI 事件通知 | ~150 | post_vm_start/init + JvmtiAgentThread |
| §十一 init_globals 依赖 | ~100 | 依赖图 + 失败传播 + Mermaid |
| §十二 边缘场景与诊断 | ~100 | 溢出/饥饿/竞态 + strace/jcmd/GDB//proc |
| §十三 syscall + /proc | ~60 | man 2/3 引用 + /proc/self/maps |

**总目标**: ~1,800-2,200 行最终文档

### Section 编写顺序和依赖

```
§〇→§一→§二→§三 (基础信息，一次性写完)
  ↓
§四→§五 (JNI 句柄系统，紧密关联)
  ↓
§六→§七 (编译基础设施，紧密关联)
  ↓
§八→§九→§十 (JVMTI 系统，紧密关联)
  ↓
§十一 (全局依赖图)
  ↓
§十二→§十三 (边缘场景 + 诊断 + syscall)
```

### Mermaid 图表要求

1. **JNIHandleBlock 4 路径决策树** (flowchart TD): 显示从 `allocate_handle(obj)` 入口到 4 条路径的分支条件（_top < 32? _free_list? _last->_next? _allocate_before_rebuild?）
2. **allocate_block 三级缓存** (stateDiagram): 线程本地→全局空闲链表→new 的状态转换，标注锁持有
3. **Agent_OnLoad 调用链** (sequenceDiagram): create_vm → create_vm_init_agents → enter_onload_phase → lookup_agent_on_load → os::dll_load → os::find_agent_function → Agent_OnLoad → enter_primordial_phase
4. **CompileQueue add/get** (sequenceDiagram): 生产者线程 → add → notify_all → 编译器线程 → get → wait(5000) → 超时重试
5. **init_globals 依赖图** (flowchart LR): compilationPolicy → codeCache → universe → jni_handles → compileBroker → universe_post_init，标注每个步骤的失败传播
6. **OopStorage block 布局** (graph TD): block 结构 → allocation bitmap → active_array → allocation_list
7. **JVMTI 5 阶段状态机** (stateDiagram): PRIMORDIAL→ONLOAD→START→LIVE→DEAD，每个阶段标注可用 API

```
# 10-JNIHandle-CompileQueue-JVMTI — init_globals #4/#21/#27 + Stage 3 Agent Initialization

## §〇 Production Scenario（3 个真实故障 + 诊断工具 + 反事实）

## §一 Interview Answer + Beginner Callouts（≥7 callout 框）

## §二 Standard Environment（source roots + build + binary paths + syscall 速查）

## §三 Source Files Table

## §四 JNIHandleBlock — 本地句柄的块式分配器（~250 行）
### 4.1 JNIHandleBlock 数据结构（32 槽位 + 链表指针 + free_list）
### 4.2 allocate_handle 4 条路径（快速→空闲链表→next block→扩展）
### 4.3 allocate_block 三级缓存（线程本地→全局空闲链表→new）
### 4.4 PushLocalFrame / PopLocalFrame 栈帧机制
### 4.5 内存布局与 GC root 遍历
### 4.6 诊断工具：jcmd VM.native_memory + GDB 断点

## §五 OopStorage — JNI 全局/弱全局句柄后端（~200 行）
### 5.1 jni_handles_init 创建两个 OopStorage 实例
### 5.2 global vs weak_global: 锁分离与 GC 交互
### 5.3 OopStorage block-based allocation 策略
### 5.4 并发 allocation + iteration 的 deadline 机制

## §六 CompilationPolicy — 编译策略初始化（~150 行）
### 6.1 compilationPolicy_init 的 3 策略 switch
### 6.2 fatal error 条件与参数验证
### 6.3 startup delay 与 compileBroker 的交互

## §七 CompileQueue — 编译任务双向链表队列（~200 行）
### 7.1 CompileQueue 数据结构（_first/_last + 双向链表）
### 7.2 add() 追加尾部 + notify_all
### 7.3 get() 阻塞等待 + 5s 超时 + 动态线程退出
### 7.4 C1 vs C2 独立队列 + select_task 策略
### 7.5 compileBroker_init — 仅初始化指令栈，不创建线程

## §八 Stage 3 Agent 初始化 — Agent_OnLoad 调用链（~250 行）
### 8.1 create_vm_init_agents 完整流程
### 8.2 lookup_on_load: dlopen → dlsym 查找 Agent_OnLoad
### 8.3 Agent_OnLoad 回调与错误处理
### 8.4 JVMTI 阶段切换：ONLOAD → PRIMORDIAL
### 8.5 诊断：strace dlopen/dlsym + GDB Agent_OnLoad 断点

## §九 JvmtiEnv — Agent 环境结构（~200 行）
### 9.1 JvmtiEnvBase 成员：magic + capabilities + callbacks
### 9.2 _head_environment 全局链表
### 9.3 JVMTI 5 阶段状态机与 API 约束
### 9.4 构造函数：magic 设置 + EventController 注册

## §十 JVMTI 事件通知 — post_vm_start/init（~150 行）
### 10.1 post_vm_start: 遍历 env 链表 + 跳过 early env
### 10.2 post_vm_initialized: VMInit 事件 + EventController::vm_init
### 10.3 JvmtiAgentThread: start_function_wrapper + call_start_function

## §十一 init_globals 依赖关系图（~100 行）
### 11.1 compilationPolicy_init → codeCache_init → universe_init → jni_handles_init
### 11.2 compileBroker_init → universe_post_init 的依赖链
### 11.3 失败传播：compileBroker_init 返回 JNI_EINVAL 的传播路径

## §十二 边缘场景与诊断（~100 行）
### 12.1 JNIHandleBlock 溢出：32 槽位满 + 无限链扩展
### 12.2 CompileQueue 饥饿：所有线程等待同一方法
### 12.3 Agent_OnLoad 竞态：两个 agent 注册冲突事件
### 12.4 OopStorage block 耗尽与 GC 压力
### 12.5 诊断：strace dlopen/dlsym + jcmd VM.native_memory + GDB + /proc/self/maps

**边缘场景分析要点**:

1. **JNIHandleBlock 溢出** — 如果 32 槽位全部用完，`allocate_handle` 进入路径 D 扩展。连续扩展 2048 次 → 2048 个 block × 32 槽 = 65536 个槽位（Hard-coded max）。超过此限制 → `fatal("ran out of JNI handle blocks")`。追问：为什么是 65536？与 `-XX:MaxJNILocalCapacity` 的关系？

2. **CompileQueue 饥饿** — 如果 `_c2_compile_queue` 只有 1 个 task，2 个 C2 线程竞争。`select_task` 从队列中选择最优 task，两个线程可能选择同一个 → 一个成功 `remove`，另一个回到等待循环。追问：`select_for_compilation` 如何避免重复编译？检查 `task->is_unloaded()` 和 `task->in_progress()`。

3. **Agent_OnLoad 竞态** — 两个 agent 在 `Agent_OnLoad` 中注册同一个事件。后注册的 agent 覆盖前者的回调？JVMTI 支持每个事件多个回调，通过 `JvmtiEventController` 管理。追问：如果 agent A 注册 `VMStart` 后在回调中调用 agent B 未注册的 JVMTI 函数 → 阶段检查拒绝 → `JVMTI_ERROR_WRONG_PHASE`。

4. **OopStorage block 耗尽** — 如果 `_global_handles` 的 block 全部满，`allocate()` 创建新 block。每个 block 默认 64 slots (OopStorage::_block_size)。如果 JNI 代码创建 100K 个 `NewGlobalRef` 而不释放 → 100K/64 = 1563 个 block × 64 × 8 bytes = ~800KB，加上 GC root 遍历开销。追问：OopStorage 是否有上限？`_allocation_count` 计数器 vs `_allocation_limit`。

## §十三 系统调用与 /proc 交互
### 13.1 dlopen (man 3) — `os::dll_load` → agent .so 加载
### 13.2 dlsym (man 3) — `os::dll_lookup` → Agent_OnLoad 符号查找
### 13.3 pthread_cond_wait/signal (man 3) — CompileQueue 同步
### 13.4 mmap (man 2) — OopStorage block 底层分配
### 13.5 /proc/self/maps — 验证 agent.so 和 libjvm.so 的地址空间布局
### 13.6 /proc/self/status — VmRSS/VmSize 反映 OopStorage + JNIHandleBlock 内存

**syscall 详细分析**:
- `dlopen(agent_path, RTLD_LAZY|RTLD_GLOBAL)` → 加载 agent .so 到进程地址空间 → 失败返回 NULL → `vm_exit_during_initialization("Could not find agent library")`
- `dlsym(lib_handle, "Agent_OnLoad")` → 查找 Agent_OnLoad 符号 → 失败 → `vm_exit_during_initialization("Could not find Agent_OnLoad function")`
- `pthread_cond_wait` 在 `Monitor::wait(5000)` 中 → 5 秒超时 → 编译器线程检查 `is_compilation_disabled_forever()` → 返回 NULL 退出线程
- `mmap` 在 OopStorage 创建新 block 时 → 分配 64 × 8 = 512 bytes per block (page-aligned 4KB) → 追踪 `/proc/self/maps` 中的匿名映射

## §十四 与 CodeBlob Taxonomy prompt (prompt-01b) 的交叉引用

本文档与 `prompt-01b-CodeBlob-Taxonomy-nmethod-Layout.md` 存在交叉：
- `compilationPolicy_init` 选择编译策略 → 决定哪些方法进入 CompileQueue → 编译生成的 nmethod 进入 CodeCache → CodeBlob taxonomy 分类
- `CompileQueue::get()` 取出的 CompileTask → 编译器执行 → 生成 nmethod (CodeBlob 子类) → 安装到 CodeCache
- 文档 01 (CodeCache) 覆盖 CodeCache 基础设施 → 本文覆盖编译请求队列 → prompt-01b 覆盖 CodeBlob 类型体系

**建议**: 在生成 prompt-01b 文档时引用本文 §六 §七，在本文 §六 §七 中引用文档 01 (CodeCache)。
```

---

## §六 Writing Requirements

| 不要写成 | 应该写成 |
|---------|---------|
| "JNIHandleBlock 是一个句柄块" | "JNIHandleBlock 是 32 槽位的固定大小 oop 数组 (`_handles[32]`)，通过 `_next` 指针形成单向链表，通过 `_pop_frame_link` 支持栈帧弹出。每个线程持有链首块 (`thread->active_handles()`)，GC 遍历整条链表作为 root 集 (jniHandles.hpp:132-162)" |
| "allocate_handle 分配一个句柄" | "allocate_handle 尝试 4 条路径：①快速 — `_last->_top < 32` 在最后 block 分配 (L532)；②空闲链表 — `_free_list` 复用已释放槽 (L539)；③下一 block — `_last->_next` 存在则移动 (L546)；④扩展 — `rebuild_free_list()` 或 `allocate_block()` 新建 block (L553-563) (jniHandles.cpp:501-565)" |
| "CompileQueue 是一个队列" | "CompileQueue 是 CompileTask 的双向链表，`_first`/`_last` 指向头尾，`add()` 追加尾部并 `notify_all()` 唤醒等待线程，`get()` 在 `MethodCompileQueue_lock` 上等待 5 秒超时 (compileBroker.hpp:80-99, compileBroker.cpp:366-465)" |
| "Agent_OnLoad 被调用" | "`create_vm_init_agents` → `lookup_agent_on_load` → `os::dll_load` (dlopen) 加载 .so → `os::find_agent_function` (dlsym "Agent_OnLoad") 查找符号 → `(*on_load_entry)(&main_vm, options, NULL)` 调用。失败时 `vm_exit_during_initialization` (thread.cpp:4468-4487)" |
| "OopStorage 存储全局引用" | "两个独立 OopStorage 实例：`_global_handles` (JNIGlobalAlloc_lock + JNIGlobalActive_lock) 存储 `NewGlobalRef` 强引用；`_weak_global_handles` (JNIWeakAlloc_lock + JNIWeakActive_lock) 存储 `NewWeakGlobalRef` 弱引用。独立锁防止 GC safepoint 死锁 (jniHandles.cpp:205-210)" |

**核心原则**:
- 每个技术断言必须标注 `file:line`
- 源码是证据（20%），原理分析是正文（80%）
- 所有函数调用用 `FunctionName()` 格式
- 所有类名用 `ClassName` 格式
- 优先使用 Mermaid 图表展示数据结构和调用链

---

## §七 Output Format

- 输出路径: `/data/workspace/openjdk-cut-new/probe_md/01-jvm-startup/docs/10-JNIHandle-CompileQueue-JVMTI.md`
- 标题格式: `# 10-JNIHandle-CompileQueue-JVMTI — init_globals 收尾 + Agent 初始化`
- Section 编号: `## §〇`, `## §一`, ..., `## §十三`
- 代码块标注语言: `cpp` (C++), `bash` (shell), `mermaid` (图表)
- 文件引用格式: `src/hotspot/share/runtime/jniHandles.cpp:501`

---

## §八 Prohibited（禁止行为）

1. **禁止把 prompt 的"答案方向"直接抄进文档** — prompt 是导航，源码是证据。必须用 codegraph_explore 或 Read 逐个读源文件，不可文字转录
2. **禁止缺少 file:line 引用** — 每个技术断言必须标注源文件和行号
3. **禁止跳过 counterfactual 讨论** — 每个 Question Group 必须包含至少 1 个反事实分析
4. **禁止 Callout 框放在 §一 之外** — 所有 Callout 框只能在 §一 中
5. **禁止省略 man 手册引用** — 每个 syscall/libc 函数必须标注 `man 2`/`man 3`/`man 5`
6. **禁止"购物清单"式描述** — 不能只列出数据结构名和大小，必须描述内部设计和决策原因
7. **禁止 Mermaid 图表缺失** — §四 JNIHandleBlock 4 路径决策树、§八 Agent_OnLoad 调用链必须用 Mermaid 图表
8. **禁止跳过 init_globals 依赖链** — §十一必须展示 compilationPolicy_init → codeCache_init → universe_init → jni_handles_init → compileBroker_init 的完整依赖图
9. **禁止诊断工具不完整** — strace + jcmd + GDB + /proc 四件套必须覆盖全部 3 个 Production Scenario
10. **禁止 Section 编号跳号** — 完成后运行 `rg '^## §' file.md` 验证连续

---

## §九 Required（必须包含）

1. **JNIHandleBlock 4 路径决策树 Mermaid 流程图**
2. **allocate_block 三级缓存 Mermaid 状态图**（线程本地→全局链表→new）
3. **Agent_OnLoad 完整调用链 Mermaid 序列图**（create_vm → create_vm_init_agents → dlopen → dlsym → Agent_OnLoad → primordial_phase）
4. **CompileQueue add/get 交互 Mermaid 序列图**（编译线程等待→生产者通知→出队）
5. **init_globals 依赖关系图**（compilationPolicy → codeCache → universe → jni_handles → compileBroker → universe_post_init）
6. **OopStorage block allocation 布局图**（block 结构 + allocation bitmap + slot 复用）
7. **JVMTI 5 阶段状态机图**（PRIMORDIAL→ONLOAD→START→LIVE→DEAD + 每个阶段的 API 可用性）
8. **至少 7 个 Callout 框**（只在 §一 中）
9. **至少 3 个 Counterfactual 讨论**（JNIHandleBlock 替代设计、Agent_OnLoad 错误处理、CompileQueue 合并队列）
10. **完整的诊断工具覆盖**（strace dlopen/dlsym、jcmd VM.native_memory、GDB Agent_OnLoad 断点、/proc/self/maps）

---

## §十 GDB Verification（≥7 断言）

1. **JNIHandleBlock 分配**: `break jniHandles.cpp:384` → 触发 JNI 本地引用分配 → `print block->_top` 显示当前槽位使用数 → `print block->_next` 显示链表下一个 block
2. **allocate_handle 路径**: `break jniHandles.cpp:532` (快速路径) → `break jniHandles.cpp:539` (空闲链表) → 验证不同条件下进入不同路径
3. **jni_handles_init**: `break jniHandles.cpp:343` → `print JNIHandles::_global_handles` → 验证 OopStorage 创建成功
4. **CompileQueue::add**: `break compileBroker.cpp:366` → `print queue->_size` → `continue` 后 `print queue->_size` 增加 1
5. **CompileQueue::get 阻塞**: `break compileBroker.cpp:445` → 队列为空时触发 `wait(5000)` → `info threads` 确认编译器线程在 `pthread_cond_wait`
6. **Agent_OnLoad 调用**: `break thread.cpp:4479` → `print *on_load_entry` 显示函数地址 → `print agent->options()` 显示 agent 参数
7. **lookup_on_load dlopen**: `break os_linux.cpp:1948` (os::dll_load) → `print name` 显示 agent .so 路径 → `continue` 后检查返回值
8. **JVMTI phase 切换**: `break jvmtiExport.cpp:618` (enter_onload_phase) → `break jvmtiExport.cpp:606` (enter_primordial_phase) → 验证阶段从 ONLOAD 切换到 PRIMORDIAL

---

## §十一 与 README 和同组 prompt 的连续性

### 与 README 的关系
- 本文覆盖 init_globals 第 4 步 (compilationPolicy_init)、第 21 步 (jni_handles_init)、第 27 步 (compileBroker_init)
- 本文覆盖 Stage 3 (Agent 初始化): `create_vm_init_agents`
- 不覆盖第 5 步 (codeCache_init) — 已在文档 01-CodeCache.md
- 不覆盖第 9 步 (universe_init) — 已在文档 00-JNI-CreateJavaVM.md

### 与同组 prompt 的连续性
- **prompt-00** (JNI_CreateJavaVM): 覆盖了 init_globals 框架和 universe_init → 本文从 init_globals 剩余步骤接续
- **prompt-01** (CodeCache): 覆盖了 codeCache_init → 本文的 compilationPolicy_init 是其前置依赖
- **prompt-06** (Mutex): 覆盖了锁系统 → 本文使用 `MethodCompileQueue_lock`、`JNIHandleBlockFreeList_lock`、`JNIGlobalAlloc_lock` 等锁
- **prompt-11** (Stages 5-10): 覆盖了 compilation_init_phase1/2 线程创建 → 本文的 compileBroker_init 是其前置依赖

### 文档间引用
- 编译线程创建引用文档 11
- 锁实现引用文档 06
- CodeCache 引用文档 01
- universe_init 引用文档 00
