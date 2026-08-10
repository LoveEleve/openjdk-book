# PROMPT: 请撰写 02-ObjectAllocation.md

## 一、任务

撰写一篇深度的 JVM 源码分析文档，主题：**对象分配 — TLAB 的乐观重试与多级降级链**

### 核心故事线（禁止做源码翻译机！）

你可能会说："分配对象不就是 `new Object()` 吗？HotSpot 编译器把 `new` 指令翻译成 TLAB bump-pointer，两个字就搞定了。"

**❓ 但如果 TLAB 满了呢？** 这是 99% 的 G1 文章停笔的地方——"满了就 slow path 分配呗"。然后全文完。

本文要追问的是：**TLAB 满了之后到底发生了什么？** 这中间有一条让你意外的五级降级链。注意区分"真·外部重试"和"一个函数内部的子步骤"——后者虽然也试了两次，但在同一调用栈上，不属于独立的降级层级：

```
TLAB bump (~10 cycles, inline, lock-free)
  │
  └─ TLAB full → allocate_new_tlab() → attempt_allocation()
      │  (内部两步: retained bump → current bump，全程 lock-free)
      │  ~50-200 cycles
      │
      └─ attempt_allocation() returns NULL → attempt_allocation_slow()
           │  Heap_lock + attempt_allocation_locked() → 可能换 Region
           │  ~500 cycles (无 region 争用时)
           │
           └─ still NULL → VM_G1CollectForAllocation → safepoint → GC
                │  Young GC (~200ms) → Mixed GC → Full GC (escalating)
                │  GC 成功 → retry from attempt_allocation()
                │  GC 失败 → retry with stronger GC → ...
                │
                └─ all GCs exhausted → NULL → java.lang.OutOfMemoryError
```

> **写作提示**：写正文时，retained 和 current 可以作为 `attempt_allocation()` 内部的"两个子策略"详细展开，但不要把它们列为独立的降级层级——它们共享同一个调用入口和 NULL 返回值。

**★ 这条链的核心设计哲学不是"怎么分配"，而是"怎么做才能不触发 GC"** — 每一级都是乐观试一次，因为 GC 是昂贵的，分配是高频的。TLAB refill ≈ 几十个 cycles，而一次 Young GC 暂停 = 200ms（5 个数量级的差距）。

### 核心叙事线（8 个"为什么"问题，每个必须有源码回答）

1. **❓ TLAB 为什么能实现 ~10 cycle 分配？** — 不是"bump pointer 很快"这种废话。要追问：**为什么 TLAB 内部的 bump-pointer 不需要 CAS？**（因为 TLAB 是 per-thread 独占的，没有竞争）**为什么不担心伪共享？**（TLAB 的对齐和 padding 策略，`_reserve_for_allocation_prefetch` 预留区起什么作用？）**为什么 TLAB 的 `_end` 不是真正的 Region 边界？**（`_allocation_end` vs `_end` 的区别——采样点可以插入在 TLAB 中间触发 slow path 收集统计）

2. **❓ 为什么 TLAB refill 失败后不直接 GC，还要试 retained region？** — **MutatorAllocRegion 有一个 `_retained_alloc_region` 字段**。当一个 Region 快满时，G1 不是立即退休它，而是先检查剩余空间能不能容纳下一个 TLAB ——如果能，保留它继续用，同时分配一个新 Region 作为主分配 Region。追问：**如果没有 retained region，每次 Region 切换都要浪费多少空间？**（平均浪费半个 TLAB ≈ 1KB-2KB/次，在分配密集型应用中累积可观）。追问：**为什么 `_retained_alloc_region` 也是 volatile？**（并发 refinement 线程可能读它）

3. **❓ 为什么 `G1Allocator::attempt_allocation()` 分三级（retained → current → locked）？** — 源码 `g1Allocator.inline.hpp:44-52`：
   ```cpp
   attempt_allocation() {
     // Level 1: try retained region (lock-free bump)
     result = mutator_alloc_region()->attempt_retained_allocation(...);
     if (result != NULL) return result;
     // Level 2: try current region (lock-free bump)
     return mutator_alloc_region()->attempt_allocation(...);
   }
   ```
   为什么 Level 1 和 Level 2 都是 lock-free？因为 `_alloc_region` 的 bump-pointer 操作在单 mutator 线程内是无竞争的（同一个 Region 同时只有当前 mutator 线程在写）。只有 Level 3 `attempt_allocation_locked()` 才需要 `Heap_lock`——因为它可能替换 `_alloc_region` 为新 Region，涉及 free_list 操作。

4. **❓ Humongous 分配为什么不走 TLAB？** — `attempt_allocation_humongous()` 在 `g1CollectedHeap.cpp:873` 开始，独立于普通分配路径。为什么 humongous（≥2MB，即 ≥ `GrainBytes/2 + 1`）不能走 TLAB？→ TLAB 大小一般不到 2MB；Humongous 需要连续 N 个 Region，必须在 Heap_lock 保护下从 free_list 一次性分配；Humongous 不进入 TAMS 统计（`_humongous_start_region` 指针标记），在并发标记中特殊处理。追问：**为什么 Humongous 分配前要先检查是否要启动并发标记？**（`g1_policy()->need_to_start_conc_mark("concurrent humongous allocation")`）→ 因为 Humongous 对象直接进入 Old 代，可能瞬间推高 Old 占用率 → 触发 IHOP 阈值 → 需要启动并发标记给后续 Mixed GC 留时间。

5. **❓ G1Allocator 为什么要维护三组 AllocRegion，而不是统一的一个？** — `_mutator_alloc_region`（MutatorAllocRegion）、`_survivor_gc_alloc_region`（SurvivorGCAllocRegion）、`_old_gc_alloc_region`（OldGCAllocRegion）三组分离的原因：① 生命周期不同（mutator 跨 GC、GC alloc regions 仅在 GC 期间存活）；② BOT 更新策略不同（mutator 和 Survivor 不更新 BOT：`bot_updates=false`；Old GC 需要更新 BOT：`bot_updates=true`——因为 Surv 中的对象还年轻不会被卡表扫，Old 中的会被扫）；③ 退役行为不同（OldGCAllocRegion::release() 会 fill dummy object 防止 refinement 线程并发写 conflict；SurvivorGCAllocRegion 不需要）。

6. **❓ G1AllocRegion 为什么要引入 dummy_region 模式？** — 源码 `g1AllocRegion.hpp:44-54`：`_alloc_region` 永远不会是 NULL——没有被激活时指向一个特殊的 `_dummy_region`（一个 `top()==end()` 的满 Region）。追问：**如果允许 `_alloc_region == NULL` 会怎样？** → 每次分配前都要检查 `_alloc_region != NULL` → 额外的分支预测失败 → 在 hot path 上增加 ~5-10% 的周期开销。dummy_region 用 `get()` 方法隔离——外部拿到 NULL（不暴露 dummy），内部直接用 `allocate(hr)` 尝试分配（在满 Region 上 always fail → 自然降级）。追问：**为什么 `_alloc_region` 是 volatile？** → mutator 写它（替换 Region），concurrent refinement 线程读它（判断扫描边界）。

7. **❓ `attempt_allocation_slow()` 为什么是无限循环而不是 try N 次？** — `g1CollectedHeap.cpp:452`：`for (uint try_count = 1; ; try_count += 1)` ——注意这是个**无条件循环**，没有 try_count 上限。循环内依次尝试：`attempt_allocation_locked` → 如果失败，触发 GC（Young→Mixed→Full 逐级升级）→ GC 后再试 `attempt_allocation` → 失败则触发更强 GC。直到分配成功或 OOM。追问：**为什么在 GC 之后还要再试 `attempt_allocation_locked` 而不是直接 rely on GC 结果？** → GC 之后可能有一个极窄的竞态窗口——另一个线程抢先分配了刚释放的内存 → 当前线程 GC 后不能保证有空间 → 需要再试一次持锁分配来消除这个窗口。追问：**为什么没有上限？** → 如果 GC 失败了才可能 OOM，如果 GC 成功了就应该有空间——无限循环的设计前提是"GC 成功 = 可用空间 > 0"，没有"GC 成功但分配仍然神秘失败"的情况。

8. **❓ TLAB 的 `_desired_size` 是怎么算出来的？为什么 `_refill_waste_limit` 不是一个简单常量？** — TLAB 大小是自适应的：`compute_size()` 基于 `_target_refills`（预期 GC 间 refill 次数）、Eden 剩余空间、活跃线程数动态调整。`_refill_waste_limit` 控制 TLAB 剩余空间少于多少时直接丢弃而非保留——太大浪费 Eden，太小导致 refill 过于频繁。简述公式即可（15 行以内），重心放 GDB 验证实际值。追问：**G1 什么时候触发 `resize_all_tlabs()`？** — GC 之后，基于本轮存活数据重新调整。

### 本文和 01 的关系

- **01 讲的是"哪里能分配"**（Region 的 _top bump-pointer、free_list、状态机）
- **02 讲的是"怎么去分配"**（从 TLAB 到 Eden 到 Heap_lock 的降级路径）
- **03 讲的是"分配失败后的 GC 怎么回收"**（Young GC Evacuation）
- **10 讲的是"GC worker 怎么在 GC 内分配"**（PLAB）

**交叉引用约定**：
- `G1AllocRegion` 从 `free_list` 取 Region → 引用 `[01-HeapRegion §六]`
- `allocate_direct_or_new_plab` → 简述 → 深挖在 `[10-PLAB §3]`
- `do_collection_pause_at_safepoint` → 简述 → 深挖在 `[03-YoungGC §2]`

### 禁止行为

- ❌ 把 `attempt_allocation` / `attempt_allocation_locked` / `attempt_allocation_slow` 三个函数贴代码然后说"这段代码先是...然后是..."——这是翻译源码
- ❌ 只讲"TLAB 是 thread-local 的"不讲"为什么不直接 CAS bump Region 的 _top"
- ❌ 只讲 Humongous 比一半 Region 大，不讲 `GrainBytes/2` 这个阈值为什么是这个值
- ❌ 不讲 G1AllocRegion 的 `_bot_updates` 为什么三个子类不同
- ❌ 不标注每级分配的锁状态（无锁 / Heap_lock / safepoint）和性能开销
- ❌ 不给出 GDB 可验证的断言

### 要求行为

- ✅ **★ 每节以 "❓ 为什么..." 开头**：先建立设计问题，再用源码做证据
- ✅ **★ 三级降级链的 Mermaid 图**：标注每级的锁状态、开销、失败后的下一级。不是流程图——是决策树，节点标注 cycle count。注意区分"一个函数内的子步骤"（retained/current）和"独立外部重试"（attempt_allocation → attempt_allocation_slow → GC）
- ✅ **★ 每一级分配的性能开销标注**：TLAB bump (~10 cycles) → TLAB refill / attempt_allocation (~50-200 cycles, 内部 retained→current) → attempt_allocation_slow + Heap_lock (~500 cycles) → Young GC (~200ms) → Full GC (~seconds)
- ✅ **★ G1AllocRegion::_dummy_region 的设计替代分析**：如果允许多一个 NULL 检查会怎样
- ✅ **★ Humongous 路径单独画 Mermaid**：因为它的分支逻辑和普通分配完全不同（先检查 IHOP → 连续 Region 分配 → Starts + Continues）
- ✅ **★ TLAB refill 和 Region 切换的锁协议**：什么时候无锁？什么时候 Heap_lock？为什么？
- ✅ **★ GDB 验证 ≥5 条**：`sizeof(ThreadLocalAllocBuffer)`（GDB ptype/o 确认）、TLAB `_top/_end` 偏移、`sizeof(G1Allocator)`（含嵌入子对象，GDB 确认）、`_retained_alloc_region` 非 NULL 时机、Humongous threshold = `GrainWords/2`
- ✅ **★ 设计替代分析**：每回答一个"为什么 X"，必须追问"如果不用 X 而用 Y 会怎样"

## 二、标准环境

- OpenJDK 11 slowdebug build
- `-Xms8g -Xmx8g -XX:+UseG1GC`（G1 Region = 4MB，2048 Regions）
- 64 位 Linux x86
- ★ GDB 在 slowdebug build 中验证（`#ifdef ASSERT` 全部生效）

## 三、聚焦源文件

| # | 文件 | 模块 | 核心函数/类（需验证行号）| 本文角色 |
|---|------|------|---------------------|---------|
| 1 | `threadLocalAllocBuffer.hpp/cpp` | gc/shared | `ThreadLocalAllocBuffer`(L46), `_start/_top/_end/_allocation_end`(L50-54), `_desired_size`(L56), `_refill_waste_limit`(L57) | ★★★ TLAB 结构 |
| 2 | `g1Allocator.hpp/cpp/.inline.hpp` | gc/g1 | `G1Allocator`(L38), `attempt_allocation()`(inline:44), `attempt_allocation_locked()`(inline:54), `survivor_attempt_allocation()`(cpp:202), `old_attempt_allocation()`(cpp:230) | ★★★ 三级分配降级链 |
| 3 | `g1AllocRegion.hpp/cpp/.inline.hpp` | gc/g1 | `G1AllocRegion`(L41), `_alloc_region`(L54 volatile), `_dummy_region`(L81), `attempt_allocation()`(hpp:154), `attempt_allocation_locked()`(hpp:172) | ★★★ 分配上下文抽象 |
| 4 | `g1AllocRegion.hpp`（子类） | gc/g1 | `MutatorAllocRegion`(L208), `_retained_alloc_region`(L217 volatile), `SurvivorGCAllocRegion`(L275), `OldGCAllocRegion`(L281) | ★★ 三类分配 Region 的策略差异 |
| 5 | `g1CollectedHeap.cpp` | gc/g1 | `attempt_allocation()`(L409), `attempt_allocation_slow()`(L431), `attempt_allocation_humongous()`(L873), `new_mutator_alloc_region()` | ★★★ 分配入口 + Humongous 路径 |
| 6 | `memAllocator.cpp` | gc/shared | `MemAllocator::allocate()` — TLAB refill 调用 `allocate_new_tlab`(L338) | ★★ 从 `new` 字节码到 TLAB 的入口 |
| 7 | `collectedHeap.hpp` | gc/shared | `allocate_new_tlab()`(L145) 虚接口 | ★ 接口定义 |
| 8 | `plab.hpp` | gc/shared | `PLAB` 结构（简述） | ★ GC worker 侧分配（深挖在 [10-PLAB]） |

## 四、必须深度走读的核心概念

### 4.1 ★★★ 三级降级链 — 每一级为什么存在？

```
问题：
  ① 源码: g1Allocator.inline.hpp:44-52 — attempt_allocation()
     Level 1: mutator_alloc_region()->attempt_retained_allocation(...)
     Level 2: mutator_alloc_region()->attempt_allocation(...)
     Level 3: attempt_allocation_locked() — 持 Heap_lock，可能换 Region

  ② retained region 的本质是什么？
     MutatorAllocRegion::_retained_alloc_region (volatile HeapRegion*)
     当主 Region 快用满时，G1 检查剩余空间能否容纳下一个 TLAB
     → 如果能 → 保留为 retained → 主 Region 退休
     → 新分配先尝试 retained → 失败了才从新 Region 分配
     ★ 为什么这能省空间？ → 不保留的话每次切换浪费 ~1KB（半个 TLAB 平均）

  ③ 为什么 Level 1 + Level 2 都是 lock-free？
     因为 mutator alloc region 在同一时刻只属于当前 mutator 线程
     → bump-pointer 移动只有自己 → 无并发竞争 → 不需要锁
     但这只在"一个 Region 同时只有一个线程分配"的前提下成立
     → 如果有其他线程也在这个 Region 分配，则需要 CAS 或锁（GC 期间多个 worker 同时写一个 Surv Region 就需要 CAS）

  ④ Level 3 为什么需要 Heap_lock？
     attempt_allocation_locked 可能替换 _alloc_region 为新 Region
     → 替换过程涉及 free_list.remove_region() → 这是全局操作
     → 需要 Heap_lock 保护 free_list 不被其他 mutator 线程并发修改
     → 但注意：不是 MutexLocker 保护 bump-pointer（那不需要）——保护的只是 Region 切换
```

### 4.2 ★★ Humongous 路径 — 为什么不走 TLAB？

```
问题：
  ① Humongous 定义: word_size >= (GrainWords / 2) = 262144 words = 2MB
     → 2MB 是 G1 设计的分水岭：小于 2MB 可以放在单个 Region；≥ 2MB 必须跨 Region

  ② 为什么 2MB 而不是 4MB 或 1MB？
     如果阈值 = 4MB（即整个 Region）：对象 3.9MB 放在一个 4MB Region → 浪费 0.1MB，但对象 4.1MB 必须跨 2 个 Region → 每个 Region 浪费 ~50% 平均。
     如果阈值 = 1MB：大量 1-2MB 对象被当作 Humongous → 每个都需要 special-cased RSet、BOT、TAMS 处理 → over-specialization。
     ★ 2MB = 4MB/2 的权衡：① 大于阈值的对象至少占半个 Region→ 即使浪费也不会超过 50%；
        ② 小于 2MB 的对象可以用正常 TLAB + Eden bump 路径（不触发 Humongous 特殊逻辑）；
        ③ 这是对称性权衡——不需要精细调优，硬编码 1/2 就足够好。

  ③ Humongous 分配为什么不能走 TLAB？
     - TLAB 大小不可能容纳 2MB+ 对象（TLAB ~tens of KB）
     - StartsHumongous + N × ContinuesHumongous 需要连续 Region
     → 必须从 free_list 一次性分配而非从单个 Region bump
     → 必须在 Heap_lock 保护下操作 free_list

  ④ 为什么 Humongous 分配前要先检查 need_to_start_conc_mark？
     g1CollectedHeap.cpp:902-904:
       if (g1_policy()->need_to_start_conc_mark("concurrent humongous allocation", word_size))
         collect(GCCause::_g1_humongous_allocation);
     → Humongous 对象直接进入 Old 代 → 可能瞬间推高 Old 占用率
     → 如果不先检查 → 几个 humongous 连续分配 → Old 直接爆 → Full GC
     → 先检查 IHOP → 如果 Old 占用已经接近阈值 → 先触发并发标记 → humongous 在标记周期中被追踪
```

### 4.3 ★★ G1AllocRegion — dummy_region 和 volatile 设计

```
问题：
  ① _dummy_region 是一个特殊的 HeapRegion（不属于堆，top()==end()）
     → 当 G1AllocRegion 没有被激活时，_alloc_region 不指向 NULL，而指向 dummy
     → 好处：allocate() 函数不需要 NULL 检查 → 满 Region 上 always fail → 自然降级
     → 如果允许 NULL：每次 allocate() 前 cmp _alloc_region, NULL → jne → 分支预测失败代价

  ② _alloc_region 为什么是 volatile？
     - 主分配线程写 _alloc_region（替换时）
     - Concurrent refinement 线程读 _alloc_region（判断"当前 Region 是否已退休"）
     → 如果 refinement 线程读到过期的 _alloc_region → 可能扫描一个已经退休的 Region
     → volatile 保证跨线程可见性

  ③ 三个子类的 _bot_updates 差异：
     - MutatorAllocRegion: bot_updates = false — young regions 的 BOT 不更新（young 不会被卡表扫）
     - SurvivorGCAllocRegion: bot_updates = false — 同上
     - OldGCAllocRegion: bot_updates = true — old regions 会被 RSet 卡表扫，需要 BOT 定位对象起始
     ★ 两层理由：① young region 对象寿命短，不值得维护 BOT；② young region 不会被卡表定位（卡表只从 old 扫到 young）
```

### 4.4 ★ TLAB 内部结构

```
问题：
  ① TLAB 的五个指针边界：_start, _top, _pf_top, _end, _allocation_end
     _start → _top: 已分配区域（top 是 bump-pointer）
     _top → _end: 空闲区域（可继续分配）
     _pf_top: prefetch watermark — 当 _top 越过 _pf_top 时，硬件自动预取下一个 cache line
       ★ 这是 "~10 cycle 分配" 的关键贡献者之一：没有 prefetch，下一个对象 header 的 L1 miss 会多 ~4 cycles
     _allocation_end: 真实 TLAB 结尾（不含 alignment_reserve）
     _end: 可能比 _allocation_end 大（含 reserved space）或为采样统计而提前缩短到 TLAB 中间

  ② _reserve_for_allocation_prefetch: TLAB 结尾预留一小段不分配
     → 防止 TLAB 末尾的分配触发跨 TLAB 边界的 cache line 竞争

  ③ TLAB 满的判断：_top + size > _end → refill 需要
     → refill 先尝试从 mutator alloc region 分一块 → 失败则触发 slow path allocation

  ★ 面试追问：为什么用 TLAB 而不是 per-thread Region？
     如果给每个线程分配一个专属 4MB Region → 200 线程 × 4MB = 800MB → Eden 直接炸。
     TLAB 是 thread-local 的虚拟切片——它只是 Region 内的一段地址区间，不拥有 Region。
     这解释了为什么 TLAB refill 需要回到全局 G1Allocator 分配——TLAB 不拥有内存。
```

### 4.5 ★ 从 `new` 字节码到对象落地的完整路径

```
问题：
  ① 编译器将 new 指令编译为 TLAB 快速路径（C1/C2/JIT 的 fast_new 模板）
     → ~10 cycles 内完成：TLAB._top + size → check < TLAB._end → 写入 mark word → 返回

  ② TLAB 满时 → MemAllocator::allocate() 慢速路径
     → TLAB refill 先尝试从 mutator alloc region 切一块新 TLAB
     → 内部调用链: MemAllocator → G1CollectedHeap::allocate_new_tlab() →
       _allocator->attempt_allocation(min, desired, actual)
       → 成功 → 更新 TLAB._start/_top/_end → 继续 bump
       → 失败 → 不走 allocate_new_tlab 了，直接走 mem_allocate() slow path

  ③ attempt_allocation 失败 → attempt_allocation_slow()
     → 持 Heap_lock 再试一次（可能换 Region）
     → 失败 → 触发 VM_G1CollectForAllocation → safepoint → GC
     → GC 成功 → 再试 attempt_allocation → 成功 / 失败
     → 多次失败 → NULL → java.lang.OutOfMemoryError
```

## 五、文章结构（§〇 ~ §七 + 附录）

```
§〇 源文件清单（8 文件，标注模块归属）

§一 ★ 全景 — 一个对象从 new 到 OOM 的完整路径
  ❓ 编译器为什么信任 TLAB 而不每次检查？
  1.1 编译器的 fast_new 模板 → TLAB 内部分配（~10 cycles）
  1.2 ★ 三级降级 Mermaid 决策树（标注每级开销 + 锁状态）

§二 ★★ TLAB — thread-local 的极致优化
  ❓ TLAB bump 为什么比 CAS bump 快 10x？
  2.1 TLAB 结构（_start/_top/_end/_allocation_end/_pf_top/_desired_size）
  2.2 为什么 _end ≠ _allocation_end？（采样点 + prefetch reserve）
  2.3 TLAB 大小自适应（简述 _desired_size 公式 + GDB 验证）
  2.4 TLAB refill: allocate_new_tlab → attempt_allocation → 更新 TLAB 边界

§三 ★★★ 三级降级链 — TLAB 满后每步的"为什么"
  ❓ 为什么 retained region 要存在？为什么互级都 lock-free？
  3.1 Level 1: retained alloc region（留一口气）
  3.2 Level 2: current alloc region（再试一次）
  3.3 Level 3: Heap_lock + 换 Region（这就是 slow path 了！）
  3.4 attempt_allocation_slow() 无限循环（逐级 GC 升级 + 重试协议）

§四 ★ G1Allocator — 三种角色的统一调度
  ❓ 为什么 mutator/survivor/old 三组分离？
  4.1 G1Allocator 结构（_mutator_alloc_region / _survivor_gc_alloc_region / _old_gc_alloc_region）
  4.2 MutatorAllocRegion: retained region + _bot_updates=false
  4.3 GC alloc regions: 仅在 GC 期间存活 + release 协议
  4.4 OldGCAllocRegion 的 dummy object 填充（防止 concurrent refinement 并发冲突）
  4.5 从 G1Allocator 到 PLAB 的桥接（简述）→ `survivor_attempt_allocation` / `old_attempt_allocation` 被 `G1PLABAllocator::allocate_direct_or_new_plab` 调用 → 深挖在 `[10-PLAB §3]`

§五 ★★ G1AllocRegion — dummy_region 模式 + 锁协议
  ❓ 为什么允许 _alloc_region=NULL 会慢？
  5.1 _dummy_region 模式（不需要 NULL 检查的奥妙）
  5.2 volatile _alloc_region 的跨线程读者
  5.3 锁协议: 无锁 try → 持 Heap_lock 强试 → safepoint GC
  5.4 _bot_updates 三子类差异的深层原因

§六 ★ Humongous 路径
  ❓ 为什么 ≥2MB 不能走 TLAB？
  6.1 Humongous 分配流程 Mermaid（先 IHOP → 连续 Region 分配 → Starts + Continues）
  6.2 Humongous 为什么直接进 Old + 为什么不更新 BOT
  6.3 Humongous 与并发标记的交互（need_to_start_conc_mark）

§七 GDB 验证 + 可证伪断言（≥5 条）
  断言 1: sizeof(ThreadLocalAllocBuffer) ≈ 120-150B（GDB ptype/o 待确认）
  断言 2: TLAB _top/_end 偏移验证（GDB ptype/o ThreadLocalAllocBuffer）
  断言 3: sizeof(G1Allocator) ≈ 160-230B（含 3 个嵌入 G1AllocRegion 子对象，待 GDB 确认）
  断言 4: _retained_alloc_region 存在时机（分配前后 GDB 对比）
  断言 5: Humongous threshold = HeapRegion::GrainWords/2 = 262144 words = 2MB（验证 word_size >= GrainWords/2）
```

## 六、与 01 和后续文档的交叉引用

| 引用点 | 本文位置 | 目标文档 |
|--------|---------|---------|
| Region 从 free_list 取 | §3.3 | `[01-HeapRegion §六]` |
| free_list 非循环链表 + remove_region(from_head) | §3.3 | `[01-HeapRegion §六]` |
| allocate_direct_or_new_plab（简述分配降级）| §4.3 | `[10-PLAB §3]` 深挖 |
| do_collection_pause_at_safepoint | §3.4 | `[03-YoungGC §2]` |
| G1FullGCCompact | §3.4（fallback 链末尾）| `[09-FullGC §2]` |
| CardTable + BOT 在卡扫中的作用 | §4.4 | `[04-CardTable-RSet §X]` |

## 七、写作要求（继承 01 的方法论）

1. **★ 每节以 "❓ 为什么..." 开头** — 06 阶段统一格式
2. **★ 每级分配标注性能开销**（cycles / ns 级别）和锁状态
3. **★ Mermaid 图必须有决策节点**：不是装饰，要展示降级条件
4. **★ 设计替代分析**：每回答一个"为什么 X"，必须追问"如果不用 X 而用 Y 会怎样"
5. **★ 跨文件约束追踪**：如 `_bot_updates` 的取值跨 `g1AllocRegion.hpp` 三个子类构造函数
6. **★ 可证伪断言 ≥5 条**
7. **★ 源码行号全部 grep 验证**
8. **★ 和 01 不重复**：01 讲了 Region 的 `_top` bump-pointer 机制，02 要用它但不重述——只引用

## 八、输出格式

- Markdown 文件，命名为 `02-ObjectAllocation.md`
- 输出路径：`/data/workspace/openjdk-cut-new/probe_md/libjvm-analysis/06-gc-memory/`
- 元信息头：标准环境 + 源文件清单 + 前置依赖（`[01-HeapRegion]`）+ 阅读收益
