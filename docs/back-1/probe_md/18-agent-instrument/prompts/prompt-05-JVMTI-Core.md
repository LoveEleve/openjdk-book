# PROMPT: 请撰写 05-JVMTI-Core.md

## §〇 Production Scenario（必须真实出现在文档 §〇 中）

**症状**：Agent 调用 JVMTI 函数返回 `JVMTI_ERROR_WRONG_PHASE (112)`，或 `SetEventNotificationMode` 成功但事件从不触发。

```c
// Agent 代码：尝试在 Primordial phase 调用需要 Live phase 的函数
jvmtiError err = (*jvmti)->GetLoadedClasses(jvmti, &class_count, &classes);
// 返回 JVMTI_ERROR_WRONG_PHASE — GetLoadedClasses 只能在 Live phase 调用
```

**根因分析**：JVMTI 有严格的 phase 模型和函数可用性约束。每个 JVMTI 函数都有 `capabilities` 和 `phase` 两个维度的门控。事件系统通过 `JvmtiEventController` 的 `recompute_enabled` 机制全局计算"哪些事件真正应该发送"——涉及 3 层合并（per-env × per-thread × global）。

**三步诊断**：

```bash
# 1. 检查当前 JVMTI phase
# 在 agent 代码中: jvmti->GetPhase(&phase)
# Live=4, OnLoad=1, Primordial=2, Start=6

# 2. 查看事件是否被正确启用
jcmd <pid> VM.jvmti_events  # 列出所有 JVMTI 事件状态

# 3. GDB 断点验证事件控制器
gdb -ex "break jvmtiEventController.cpp:571" \
    -ex "run" \
    -ex "print any_env_thread_enabled" \
    --args java -agentlib:myagent
```

**反事实**：如果 JVMTI 没有 phase 模型——agent 可以在任何阶段调用任何函数 → Agent_OnLoad 中调用 GetLoadedClasses → 类加载器尚未初始化 → 返回空列表 → agent 以为"没有类被加载" → 但之后数百个类被加载 → agent 完全不知道。Phase 模型强制了"什么阶段能做什么"的契约，避免了 agent 在错误时机获取错误状态。

---

## §一 Task + Narrative + De-glamorization + Beginner Callouts

### Task

Reading this prompt, you will produce a document that explains the JVMTI core infrastructure—the JvmtiEnv lifecycle, the event controller's recompute_enabled mechanism, the thread state management, the tag map system, and the capability management. This is NOT a reference manual for all 300+ JVMTI functions—it's ENGINEERING documentation on HOW the infrastructure that powers them works.

Reader completed **01-Agent-Loading**（JPLISAgent 创建 JvmtiEnv），**02-ClassFileLoadHook**（CFLH 事件如何通过 JvmtiExport 调度），**03-Attach-API**（agentmain 创建新的 JvmtiEnv）。This doc: **how JvmtiEnv manages 300+ functions, how events are enabled/disabled with zero-overhead gates, and how object tagging survives GC** — from `JvmtiEnvBase` at jvmtiEnvBase.hpp:57 to `JvmtiTagMap::weak_oops_do` at jvmtiTagMap.cpp:3318.

### Interview Story Format Answer（必须出现在 §一 末尾）

"JVMTI isn't a monolithic API—it's a layered infrastructure. At the bottom, `JvmtiEnvBase` at jvmtiEnvBase.hpp:57 is a CHeapObj that holds a `JvmtiEnv` pointer, a `JvmtiEventController` (through the facade), and a per-env `JvmtiTagMap`. The 300+ JVMTI functions are generated from a specification file via XSLT—`jvmtiHpp.xsl` produces the `JvmtiEnv : public JvmtiEnvBase` class with all function declarations. Each function call goes through two checks: capability check (did the agent request this capability?) and phase check (is the VM in the right phase?). The event system is the most complex part: `JvmtiEventControllerPrivate::recompute_enabled` at jvmtiEventController.cpp:571 is the global recomputation engine. It merges three levels: per-environment event enables (`JvmtiEnvEventEnable`), per-thread event enables (`JvmtiThreadEventEnable`), and the intersection (`JvmtiEnvThreadEventEnable`). The result sets global booleans like `_should_post_class_file_load_hook`—a single bool read in the hot path that gates the entire CFLH pipeline. The `JvmtiTagMap` at jvmtiTagMap.cpp is a per-env hash map from `jobject` to `jlong` tag—it survives GC through `weak_oops_do` callbacks that update oop references when objects move."

### Beginner Callout Boxes（文档中必须出现的 7 个 callout 框）

1. **JvmtiEnv 的 XSLT 代码生成**: JVMTI 规范定义了 ~300 个函数。`jvmtiHpp.xsl` 从规范 XML 生成 `JvmtiEnv` 类的声明，`jvmtiEnv.xsl` 生成函数实现骨架。这避免了手工维护 300+ 函数签名的一致性问题。Source: `src/hotspot/share/prims/jvmtiHpp.xsl`.

2. **Phase 门控**: 每个 JVMTI 函数有 `phase` 约束——定义在规范 XML 中，代码生成时注入到函数开头。Phase 检查是 `JvmtiEnvBase::check_phase()` → 如果当前 phase < 要求 → 返回 `JVMTI_ERROR_WRONG_PHASE`。Phase 值：ONLOAD(1) < PRIMORDIAL(2) < LIVE(4) < START(6) < DEAD(8)。Source: `jvmtiEnvBase.hpp` phase 检查宏。

3. **事件启用位图**: `JvmtiEventEnabled` (jvmtiEventController.hpp:78) 是一个 64-bit 位掩码——每个位对应一个 JVMTI 事件。`CLASS_FILE_LOAD_HOOK_BIT = ((jlong)1 << (EVENT_CFLH - TOTAL_MIN_EVENT_TYPE_VAL))`。位图通过 `|` 和 `&` 操作合并——O(1) 检查是否有任何 agent 启用了某个事件。

4. **recompute_enabled 的三层合并**: `JvmtiEventControllerPrivate::recompute_enabled` (jvmtiEventController.cpp:571) 遍历所有 JvmtiEnv × 所有 JvmtiThreadState，计算每个事件的"真正应该发送"标志。(1) 合并所有 env 的全局事件启用 → `any_env_thread_enabled`，(2) 合并每个线程的 per-env 事件启用 → `universal_global_event_enabled`，(3) 将 delta 写入 `JvmtiExport::_should_post_*` 布尔门控。任何 env 注册/注销事件时触发重新计算。

5. **JvmtiTagMap 的 GC 安全**: `JvmtiTagMap` (jvmtiTagMap.cpp) 是 `jobject → jlong` 的哈希映射。`jobject` 是 JNI weak global reference——GC 可能移动对象。`weak_oops_do` 回调在 GC 移动对象后更新映射中的 oop 引用。如果对象被回收 → 条目从映射中移除。这保证了 tag 在 GC 后仍然有效。

6. **Capability 管理**: JVMTI capabilities 分为 4 组：(1) `always_capabilities`——始终可用，(2) `onload_capabilities`——Agent_OnLoad 时可请求，(3) `onload_only_capabilities`——仅 OnLoad 阶段，(4) `potential_capabilities`——JVM 支持但 agent 未请求。`JvmtiManageCapabilities::add_capabilities` 检查 agent 的 phase 是否允许请求该 capability。Source: `jvmtiManageCapabilities.hpp`.

7. **JvmtiEnvIterator**: `JvmtiEnvIterator` (jvmtiEnvBase.hpp:318) 遍历所有活跃的 JvmtiEnv。在 CFLH 两遍遍历（non-retransformable → retransformable）中使用——遍历所有 env，根据 `env->is_retransformable()` 和 `env->is_enabled(CFLH)` 过滤。Source: `jvmtiExport.cpp:910-932`.

---

## §二 Standard Environment

OpenJDK 11 slowdebug, 64-bit Linux。

Source roots:
- `src/hotspot/share/prims/jvmtiEnvBase.hpp` — JvmtiEnvBase (:57), JvmtiEnvIterator (:318)
- `src/hotspot/share/prims/jvmtiEnvBase.cpp` — JvmtiEnvBase 实现
- `src/hotspot/share/prims/jvmtiEnv.cpp` — JvmtiEnv 300+ 函数实现（~4600 行）
- `src/hotspot/share/prims/jvmtiHpp.xsl` — XSLT 生成 JvmtiEnv 声明
- `src/hotspot/share/prims/jvmtiEventController.hpp` — 事件控制类体系（~245 行）
- `src/hotspot/share/prims/jvmtiEventController.cpp` — recompute_enabled (:571)
- `src/hotspot/share/prims/jvmtiThreadState.hpp` — JvmtiThreadState (:77)
- `src/hotspot/share/prims/jvmtiEnvThreadState.hpp` — JvmtiEnvThreadState (:109)
- `src/hotspot/share/prims/jvmtiTagMap.hpp` — JvmtiTagMap (:41), JvmtiTagHashmap (:37)
- `src/hotspot/share/prims/jvmtiTagMap.cpp` — ~3400 行实现
- `src/hotspot/share/prims/jvmtiManageCapabilities.hpp` — 能力管理（~85 行）
- `src/hotspot/share/prims/jvmtiExtensions.hpp` — 扩展机制（~60 行）

Build: `make jdk`

Key binary: `build/linux-x86_64-normal-server-slowdebug/jdk/lib/server/libjvm.so`

---

## §三 Source Files Table

| # | File | Full Path | Lines | Core Functions | Role |
|---|------|-----------|:--:|-------|------|
| 1 | **jvmtiEnvBase.hpp** | `src/hotspot/share/prims/jvmtiEnvBase.hpp` | ~600 | JvmtiEnvBase(:57), JvmtiEnvIterator(:318), phase/capability 检查宏 | 🔥 JVMTI 环境基类 |
| 2 | **jvmtiEnv.cpp** | `src/hotspot/share/prims/jvmtiEnv.cpp` | ~4600 | RedefineClasses(:457), RetransformClasses(:393), 300+ 函数 | JVMTI 函数实现 |
| 3 | **jvmtiEventController.cpp** | `src/hotspot/share/prims/jvmtiEventController.cpp` | ~700 | recompute_enabled(:571), set_event_callbacks(:693), enter_interp_only_mode(:351) | 🔥 事件控制引擎 |
| 4 | **jvmtiEventController.hpp** | `src/hotspot/share/prims/jvmtiEventController.hpp` | ~245 | JvmtiEventEnabled(:78), JvmtiEnvThreadEventEnable(:107), JvmtiThreadEventEnable(:130), JvmtiEnvEventEnable(:151) | 事件控制类体系 |
| 5 | **jvmtiThreadState.hpp** | `src/hotspot/share/prims/jvmtiThreadState.hpp` | ~180 | JvmtiThreadState(:77), JvmtiEnvThreadStateIterator(:60) | 线程级 JVMTI 状态 |
| 6 | **jvmtiEnvThreadState.hpp** | `src/hotspot/share/prims/jvmtiEnvThreadState.hpp` | ~200 | JvmtiEnvThreadState(:109), JvmtiFramePops(:78) | 每 env×线程 状态 |
| 7 | **jvmtiTagMap.cpp** | `src/hotspot/share/prims/jvmtiTagMap.cpp` | ~3400 | set_tag(:739), get_tag(:771), iterate_through_heap(:1512), weak_oops_do(:3318), get_objects_with_tags(:1612), follow_references(:3302) | 🔥 对象标记系统 |
| 8 | **jvmtiManageCapabilities.hpp** | `src/hotspot/share/prims/jvmtiManageCapabilities.hpp` | ~85 | initialize, add_capabilities(:71), get_potential_capabilities(:68) | Capability 管理 |

---

## §四 Deep Dive Question Groups（≥6，EXACT questions + answer directions）

### 4.1 ★★★ JvmtiEnv 代码生成与函数门控

```
问题：
  ① JvmtiEnv 的 300+ 函数是如何从规范生成的？
      答案方向: JVMTI 规范是 XML 文件，定义了每个函数的签名、参数、返回值、
        phase 要求、capability 要求。jvmtiHpp.xsl 从规范 XML 生成 JvmtiEnv 类声明，
        jvmtiEnv.xsl 生成函数实现骨架。每个函数实现骨架包含：
        1. JvmtiEnvBase::check_phase(required_phase) — phase 检查
        2. JvmtiEnvBase::check_capability(required_capability) — capability 检查
        3. 实际函数逻辑
        4. return error_code
      
      追问: 为什么不用虚函数表而是代码生成？
      → 300+ 虚函数 → vtable 300+ 条目 × 每个 JvmtiEnv 实例 → 内存浪费。
        JvmtiEnv 是 CHeapObj，数量少（通常 1-3 个），但生成代码避免了手工
        维护 300+ 函数签名的一致性问题——规范变更后只需重新生成。

  ② Counterfactual: 如果没有代码生成——手工实现 300+ 函数？
      答案方向: 每个函数都需要一致的 phase/capability 检查 → 300 次复制粘贴
      → 某个函数忘记检查 → agent 在错误 phase 调用 → 未定义行为。
      代码生成保证 100% 一致性——每个函数都有相同的门控模式。
```

### 4.2 ★★★ recompute_enabled — 事件启用全局计算

```
问题：
  ① recompute_enabled (jvmtiEventController.cpp:571) 的三层合并逻辑是什么？
      答案方向:
        1. 遍历所有 JvmtiEnv → recompute_env_enabled → 合并到 any_env_thread_enabled
        2. 如果有线程过滤事件 → 为缺失 JvmtiThreadState 的线程创建 state
        3. 遍历所有 JvmtiThreadState → recompute_thread_enabled → 合并到 universal_global_event_enabled
        4. 计算 delta = universal_global_event_enabled ^ old_value
        5. 如果 CLASS_FILE_LOAD_HOOK_BIT 位翻转 → JvmtiExport::set_should_post_class_file_load_hook(bool)
        6. 如果 BREAKPOINT_BIT 翻转 → 更新解释器模式标志
        
      追问: 为什么需要 per-thread 合并？
      → agent 可以按线程过滤事件：SetEventNotificationMode(enable, BREAKPOINT, someThread)。
        只有 someThread 上启用了断点事件——其他线程不需要在解释器中检查断点。
        Per-thread 合并确保只有相关线程承担事件检查开销。

  ② Counterfactual: 如果每次事件检查时都遍历所有 env 和线程状态？
      答案方向: CFLH 每类加载触发一次 → 如果每次遍历 10 个 env × 100 个线程
        → 1000 次检查 → ~50µs → 类加载时间翻倍。
        recompute_enabled 预计算布尔门控 → 热路径只需 1 个 bool 读取 → 0.3ns。
```

### 4.3 ★★★ JvmtiThreadState — 线程级状态管理

```
问题：
  ① JvmtiThreadState (jvmtiThreadState.hpp:77) 管理哪些状态？
      答案方向:
        - class_being_redefined: 当前线程正在 redefine 的类（CFLH 中读取）
        - class_load_kind: load / redefine / retransform（CFLH Poster 中读取）
        - 事件启用位图: 当前线程启用了哪些事件
        - JvmtiEnvThreadState 链表: 每个 env 在此线程上的状态
        - 单步调试状态: 当前是否在单步中
        - FramePop 状态: 哪些栈帧需要 FramePop 事件
        
      追问: JvmtiThreadState 何时创建？
      → 延迟创建：只有在线程第一次被 agent 引用时才分配。
        JavaThread::jvmti_thread_state() 返回现有 state 或 NULL。
        JvmtiThreadState::state_for(jt) 在不存在时创建——但有 bug 7126851：
        在特定场景下 state_for 的创建时机不安全。CFLH 中使用 jvmti_thread_state()
        而非 state_for() 来避免此 bug。

  ② Counterfactual: 如果每个线程在创建时就分配 JvmtiThreadState？
      答案方向: 10000 个线程 × sizeof(JvmtiThreadState) ~500 bytes = 5MB
        → 但 99% 的线程永远不会被 agent 引用 → 5MB 纯浪费。
        延迟分配将开销降到实际需要的线程上（通常 < 10 个）。
```

### 4.4 ★★★ JvmtiTagMap — 对象标记与 GC 交互

```
问题：
  ① JvmtiTagMap::set_tag (jvmtiTagMap.cpp:739) 如何存储 tag？
      答案方向:
        1. 查找 jobject → oop → JvmtiTagHashmapEntry
        2. 如果不存在 → 创建新条目 → 存储 (oop, tag) 对
        3. jobject 是 JNI weak global reference → GC 可能回收对象
        4. 如果对象被移动（GC 复制）→ weak_oops_do 更新 oop 引用
        5. 如果对象被回收 → 条目从 hash map 中移除
        
      追问: 为什么使用 JNI weak global reference 而非强引用？
      → 如果使用强引用 → 所有被 tag 的对象都不能被 GC → agent 可以
        无意中创建内存泄漏。Weak reference 让 GC 正常回收无其他引用的对象，
        tag 条目自动清理。

  ② Counterfactual: 如果使用 pthread mutex 保护 TagMap 而非 GC 安全设计？
      答案方向: TagMap 在 safepoint 中被 GC 访问（weak_oops_do）→ 不能持有锁
        → 否则 GC 线程等待 agent 线程释放锁 → 死锁。
        JvmtiTagMap 使用 lock-free 设计 + GC 通知机制——在 safepoint 中安全更新。
```

### 4.5 ★★★ Capability 管理

```
问题：
  ① JvmtiManageCapabilities 的 4 组 capability 如何区分？
      答案方向:
        1. always_capabilities: 始终可用，agent 不需要请求（如 GetEnv, GetPhase）
        2. onload_capabilities: Agent_OnLoad 或 Agent_OnAttach 时可请求（如 can_redefine_classes）
        3. onload_only_capabilities: 仅 OnLoad 阶段可请求（如 can_generate_breakpoint_events）
        4. potential_capabilities: JVM 支持但 agent 未请求——通过 GetPotentialCapabilities 查询
        
      追问: 为什么有 onload_only 限制？
      → 某些 capability 必须在 JVM 启动时设置——如 can_generate_breakpoint_events
        需要在解释器初始化时分配断点表。Live phase 时解释器已运行 → 无法回退分配。
        OnLoad 是"配置阶段"，Live 是"运行阶段"。

  ② Counterfactual: 如果所有 capability 都可以在 Live phase 请求？
      答案方向: 断点事件需要在每个解释器方法入口插入检查代码。
        如果 Live phase 才请求 → 需要遍历所有已加载方法插入断点检查
        → 可能需要 deoptimize 所有已编译方法 → 等同于 redefine 所有类
        → 数十秒的暂停时间。OnLoad 时设置 → 零运行时开销。
```

### 4.6 ★★★ JvmtiEnvIterator — Env 遍历与 CFLH 两遍

```
问题：
  ① JvmtiEnvIterator (jvmtiEnvBase.hpp:318) 如何遍历所有 JvmtiEnv？
      答案方向: JvmtiEnvBase 有静态链表 _head → _next 指针。
        JvmtiEnvIterator 持有 _env 指针，first() 返回 _head，next() 返回 _env->_next。
        遍历顺序 = env 创建顺序（按 -agentlib 命令行顺序）。
      
      追问: CFLH 两遍遍历为什么需要 JvmtiEnvIterator？
      → post_all_envs (jvmtiExport.cpp:910) 需要遍历所有 env 两遍：
        第一遍过滤 non-retransformable env → 第二遍过滤 retransformable env。
        JvmtiEnvIterator 提供统一遍历接口，两遍用不同过滤条件。

  ② Counterfactual: 如果 JvmtiEnv 用数组而非链表存储？
      答案方向: 动态添加 agent（Attach API）→ 需要扩容数组 → 复制 + 重新分配
        → 但 CFLH 正在遍历数组 → 并发问题。链表允许在遍历期间安全添加新 env
        （append 到尾部不影响已有迭代器）。但删除需要特殊处理。
```

---

## §五 Article Structure

```
§〇 生产场景 — JVMTI_ERROR_WRONG_PHASE 错误诊断
  ★ 真实错误 + phase 模型解释
  ★ 三步诊断: GetPhase → jcmd VM.jvmti_events → GDB 断点
  ★ 反事实: 无 phase 模型 → agent 获取错误状态

§一 ★★★ JVMTI 核心基础设施源码走读
  1.1 JvmtiEnvBase 类结构 → JvmtiEnvIterator → phase/capability 检查宏
  1.2 JvmtiEnv 代码生成 → XSLT → 300+ 函数骨架
  1.3 jvmtiEventController.cpp:571 recompute_enabled → 三层合并
  1.4 jvmtiEventController.hpp 事件启用位图类体系
  1.5 jvmtiThreadState.hpp:77 JvmtiThreadState → 线程级状态
  1.6 jvmtiTagMap.cpp:739 set_tag → GC 安全的对象标记
  1.7 jvmtiManageCapabilities.hpp 4 组 capability
  1.8 ★ Mermaid: JVMTI 架构分层图 — 4 层: Agent / JvmtiEnv / Event Controller / TagMap
  1.9 ★ 面试 Story Format 答案

§二 ★★★ 7 Beginner Callout 框
  2.1 XSLT 代码生成
  2.2 Phase 门控
  2.3 事件启用位图
  2.4 recompute_enabled 三层合并
  2.5 JvmtiTagMap GC 安全
  2.6 Capability 管理
  2.7 JvmtiEnvIterator

§三 ★★ 性能剖析
  3.1 Phase 检查: 内联 bool 比较 ~0.3ns
  3.2 recompute_enabled: O(n_envs × n_threads) ~100µs（仅在事件注册时）
  3.3 TagMap set_tag: hash 查找 + 分配 ~200ns
  3.4 事件门控: bool 读取 ~0.3ns（热路径零开销）

§四 ★ GDB 断点验证 — 7 断点
  断言 1: jvmtiEnvBase.hpp phase check → verify phase value
  断言 2: jvmtiEventController.cpp:571 recompute_enabled → verify bitmask merge
  断言 3: jvmtiThreadState.hpp state creation → verify delayed allocation
  断言 4: jvmtiTagMap.cpp:739 set_tag → verify tag storage
  断言 5: jvmtiTagMap.cpp:3318 weak_oops_do → verify GC update
  断言 6: jvmtiManageCapabilities.hpp add_capabilities → verify phase gate
  断言 7: jvmtiEnvBase.hpp:318 JvmtiEnvIterator → verify traversal order

§五 ★ Cross-Reference
  ❓ 01-Agent-Loading — JvmtiEnv 创建 + SetEventCallbacks
  ❓ 02-ClassFileLoadHook — CFLH 事件通过 JvmtiExport 调度
  ❓ 03-Attach-API — agentmain 创建新的 JvmtiEnv
  ❓ 04-Redefine-Classes — RetransformClasses 依赖 JvmtiEnv
```

---

## §六 Writing Requirements

1. **Every paragraph opens with WHY**.

2. **3-5 lines source code per claim**.

3. **Mermaid** — JVMTI 架构分层图。4 层: Agent Layer / JvmtiEnv Layer / Event Controller Layer / TagMap & State Layer。

4. **GDB session** — 7 breakpoints.

5. **7 Beginner callout boxes**.

6. **Cross-reference at three points**.

7. **Story-format interview answer**.

8. **"不要写成→应该写成" 对照表**:
   | 不要写成 | 应该写成 |
   |---------|---------|
   | "JVMTI has 300+ functions" | "JvmtiEnv at jvmtiEnv.cpp declares 300+ functions generated from JVMTI specification XML via jvmtiHpp.xsl — each function skeleton includes check_phase() and check_capability() gates injected by code generation" |
   | "Events are enabled/disabled by agents" | "JvmtiEventControllerPrivate::recompute_enabled at jvmtiEventController.cpp:571 merges per-env, per-thread, and global event enables into a single 64-bit bitmask, then sets JvmtiExport::_should_post_* boolean gates — reducing the hot-path check to one bool read" |
   | "JvmtiTagMap stores object tags" | "JvmtiTagMap::set_tag at jvmtiTagMap.cpp:739 stores (jobject, jlong) pairs in a hash map with JNI weak global references — weak_oops_do at :3318 updates oop references when GC moves objects, and entries are removed when objects are collected" |
   | "Capabilities control what agents can do" | "JvmtiManageCapabilities partitions capabilities into 4 groups: always_capabilities (no request needed), onload_capabilities (OnLoad or OnAttach), onload_only (OnLoad only), and potential (query-only) — add_capabilities at :71 checks the agent's current phase against the capability's group" |
   | "JvmtiThreadState tracks per-thread state" | "JvmtiThreadState at jvmtiThreadState.hpp:77 is lazily allocated — JavaThread::jvmti_thread_state() returns NULL for threads never touched by an agent. It stores class_being_redefined, class_load_kind, event enables, and a JvmtiEnvThreadState linked list" |

---

## §七 Output Format

- Markdown file, named `05-JVMTI-Core.md`
- Output path: `/data/workspace/openjdk-cut-new/probe_md/18-agent-instrument/docs/`
- 元信息头: 包含阶段、前置、配套、后续依赖、阅读收益
- 目标行数: 400+ lines

---

## §八 Prohibited（≥8）

- ❌ 只说 "JVMTI has many functions" 而不展示代码生成机制
- ❌ 不解释 recompute_enabled 三层合并 — 必须展示 per-env × per-thread × global 位图合并
- ❌ 忽略 JvmtiTagMap 的 GC 安全性 — 必须展示 weak_oops_do
- ❌ 不解释 capability 4 组分类 — 必须展示 always/onload/onload_only/potential
- ❌ 不展示 JvmtiEnvIterator 在 CFLH 两遍遍历中的使用
- ❌ 忽略 JvmtiThreadState 延迟分配 — 必须展示 jvmti_thread_state() vs state_for()
- ❌ 不做 GDB 断点 trace — 至少 7 个断点
- ❌ 不要写成 JVMTI API 参考手册（不需要列出 300+ 函数）

---

## §九 Required（≥8）

- ✅ **★ Mermaid 架构分层图** — 4 层: Agent / JvmtiEnv / Event Controller / TagMap
- ✅ **★ recompute_enabled 完整源码** — 三层合并逻辑
- ✅ **★ JvmtiTagMap set_tag + weak_oops_do 源码**
- ✅ **★ JvmtiManageCapabilities 4 组分类**
- ✅ **★ JvmtiEnvIterator 遍历源码**
- ✅ **★ JvmtiThreadState 延迟分配机制**
- ✅ **★ 7 Beginner Callout 框**
- ✅ **★ 面试 Story Format 答案**
- ✅ **★ GDB 断点 ≥7 条**
- ✅ **★ "不要写成→应该写成" 对照表** — ≥5 行
- ✅ **★ 交叉引用** — 01, 02, 03, 04

---

## §十 GDB Verification（≥7 assertions）

```
断言 1: JvmtiEnv phase check (jvmtiEnvBase.hpp)
  (gdb) break jvmtiEnv.cpp:457 (RedefineClasses)
  (gdb) print get_phase() → 期望: JVMTI_PHASE_LIVE (4)
  (gdb) continue → 通过 phase 检查

断言 2: recompute_enabled (jvmtiEventController.cpp:571)
  (gdb) break jvmtiEventController.cpp:571
  (gdb) print any_env_thread_enabled → 期望: 启用了事件的位图
  (gdb) continue → 计算完成
  (gdb) print JvmtiExport::should_post_class_file_load_hook() → 期望: true/false

断言 3: JvmtiThreadState 延迟创建 (jvmtiThreadState.cpp)
  (gdb) print jt->jvmti_thread_state() → 期望: NULL (首次访问)
  (gdb) continue → agent 调用后
  (gdb) print jt->jvmti_thread_state() → 期望: 非 NULL

断言 4: JvmtiTagMap set_tag (jvmtiTagMap.cpp:739)
  (gdb) break jvmtiTagMap.cpp:739
  (gdb) print object → 期望: 有效的 jobject
  (gdb) print tag → 期望: 非 0 tag 值
  (gdb) continue → tag 存储完成

断言 5: weak_oops_do (jvmtiTagMap.cpp:3318)
  (gdb) break jvmtiTagMap.cpp:3318
  (gdb) continue → GC 触发时调用
  (gdb) print entry_count → 期望: TagMap 条目数

断言 6: Capability phase check (jvmtiManageCapabilities.cpp)
  (gdb) break jvmtiManageCapabilities.cpp add_capabilities
  (gdb) print get_phase() → 期望: JVMTI_PHASE_ONLOAD
  (gdb) print capability → 期望: 被请求的 capability

断言 7: JvmtiEnvIterator (jvmtiEnvBase.hpp:318)
  (gdb) break jvmtiExport.cpp:910 (post_all_envs)
  (gdb) print it.first() → 期望: 第一个 JvmtiEnv
  (gdb) continue → it.next() → 遍历所有 env
```

---

## §十一 与 README 和同组 prompt 的连续性

1. **从 README §一 承接**：本文展开 "05 — JVMTI 核心: JvmtiEnv 300+ 函数、事件控制器、能力管理、TagMap"——JVMTI 基础设施的完整代码级解答。

2. **同组边界**: 01-04 都依赖 JVMTI 核心基础设施。本文是基础设施文档——解释 JvmtiEnv 如何管理 300+ 函数、事件控制器如何实现零开销门控、TagMap 如何在 GC 中保持一致性。06-07 是 JDWP 调试协议（独立于 JVMTI 基础设施）。
