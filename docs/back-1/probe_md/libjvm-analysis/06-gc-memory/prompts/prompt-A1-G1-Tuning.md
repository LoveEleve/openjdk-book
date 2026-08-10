# PROMPT: 请撰写 A1-G1-Tuning.md

## 一、任务

撰写一篇 G1 GC 调优实战指南，主题：**从源码理解到生产调优：G1 每个参数的"为什么"和"设多少"**

### 定位与独特性

你已经完成了 12 篇 G1 GC 深度源码分析文档（00-Overview 到 11-Reference-Processing）。**本文是把源码理解转化为生产决策的桥梁**——它的独特价值在于：

> **其他调优指南告诉你"这个参数设 200ms"，本文告诉你"为什么是 200ms 而不是 50ms 或 500ms——背后的 Region 粒度、RSet 扫描时间、Evacuation 并行度共同决定了这个数"**

换句话说：**每个建议值都有源码级的因果链支撑**（追溯到 Region 4MB、CardTable 512B、PLAB waste、gc_efficiency 排序等），而不是"经验值"或"Oracle 推荐"。

---

## 二、核心叙事线（禁止做参数手册翻译机！）

### 叙事框架：一个生产事故的排查链路

不要按参数字母序罗列。按**排查链路**组织：先定位问题→ 选对参数→ 调对值→ 验证效果。

```
生产环境：G1 Young GC 频繁（每 2 秒一次），pause time 偶尔飙到 500ms
  │
  ├─ 步骤 1：看什么日志？→ -Xlog:gc*=info 输出解读（G1 特有字段 vs 通用字段）
  │    └─ "Humongous allocation" 出现？→ [02 §八] 直接 Full GC 风险
  │    └─ "to-space exhausted" 出现？→ Evacuation Failure → [03 §七]
  │    └─ "Concurrent Mark" 周期过频？→ IHOP 问题 → [08 §二]
  │
  ├─ 步骤 2：判断瓶颈 — 是分配压力、标记跟不上、还是碎片化？
  │    ├─ Young GC 频率太高 → Eden 太小？还是 allocation rate 太高？
  │    ├─ Mixed GC 回收太少 → gc_efficiency 低的 Region 太多？→ [08 §四]
  │    └─ Full GC 偶尔出现 → 三条触发路径排查 → [09 §一]
  │
  ├─ 步骤 3：调参 — 每个参数的回答链："为什么是这个值？→ 源码证据 → 权衡"
  │    └─ ★ 核心问题：哪个参数管什么？改了会影响什么？（因果链，不是值列表）
  │
  └─ 步骤 4：验证 — 调完后看什么指标确认生效？
       ├─ MaxGCPauseMillis 调了→ 看 `[gc,phases]` 中 `Evacuate` 实际耗时 vs target
       ├─ IHOP 调了→ 看 CM 触发时的 Old occupancy 是否在目标范围
       ├─ G1MixedGCCountTarget 调了→ 看一轮 Mixed GC 周期做了几轮（`[gc,ergo,cset]` 中 Old > 0）
       ├─ ConcGCThreads 调了→ 看 CM 周期时长（Initial Mark → Cleanup 间隔）
       └─ G1HeapWastePercent 调了→ 看 Mixed GC 结束时的 heap occupancy 变化
```

---

## 三、必须覆盖的参数（13 个核心参数）

### 每个参数的回答模板（必须严格遵循）：

```
参数名
  ├─ 管什么？（一句话）
  ├─ ★ 默认值是多少？为什么是这个默认值？（源码级因果链，追溯到 Region/CardTable/PLAB/gc_efficiency）
  ├─ ★ 改大了会怎样？（源码级因果链）
  ├─ ★ 改小了会怎样？（源码级因果链）
  ├─ 什么场景下需要调？（具体生产症状）
  ├─ 调到多少？（有公式给公式，没公式给经验范围 + 为什么这个范围）
  └─ 调完后看什么日志字段确认生效？
```

### 13 个参数（按排查链路排列，不是字母序）：

#### 1. MaxGCPauseMillis（停顿目标）

- **默认 200ms。为什么是 200ms？**
  - ★ 根本原因：**200ms 是人类对停顿的主观感知阈值**（超过 200ms 用户有明显卡顿感），不是从 Region 数学推导出来的
  - Region 数学**解释 200ms 能做什么**：在 4MB Region + 典型 workload 下，200ms 预算允许 ~50 Region 的 CSet（RSet 扫描 + Evacuation 约 ~4ms/Region，实际 1-20ms 波动取决于 RSet 卡片密度和对象平均大小）→ Eden ≈ 200MB → Young GC 频率 ~2-3 次/秒（中等 allocation rate）→ 可接受
  - 对比：设 50ms → CSet ~12 Region → Eden ≈ 50MB → Young GC 每秒 10+ 次 → throughput 崩
  - 对比：设 500ms → CSet ~125 Region → 用户感知明显卡顿
  - → 深挖 G1Policy 怎么用这个值：`[08-MixedGC-Policy §三]` 中 `_young_list_target_length` 的计算
- **什么场景调**：延迟敏感型（调小）vs 吞吐优先型（调大）
- ★ **为什么不能设太小（如 10ms）**：Region 粒度 4MB 决定了最小扫描单元。10ms 预算 → `_young_list_target_length` 被压到 1-2 个 Region → Eden ≈ 8MB → **Young GC 每秒 50+ 次** → 每次 GC 的 ~1ms STW 协调 overhead 占比极高 → throughput 崩盘。不是 Full GC 变多，是 **Young GC 频率本身把应用干死了**

#### 2. -Xms / -Xmx（堆大小）

- **应该一样大还是不一样大？**
  - `-Xms = -Xmx`：避免运行时扩堆（expand 需要 commit memory + 更新 page table → 额外延迟）。G1 在 `attempt_allocation_slow` 中如果触发 expand，持 Heap_lock（`[02 §三]`）→ 阻塞正在 `new` 的其他线程（**分配竞争，不是全 STW**），但延迟远小于一次 Young GC
  - `-Xms < -Xmx`：节省物理内存（堆没用到时不 commit），代价是 expand 时有短暂的分配阻塞
- **G1ReservePercent**（默认 10%）：为什么 G1 要预留 10%？→ Evacuation 阶段 to-space 需要 headroom。没有 reserve → Evacuation Failure 概率大增
- **堆大小 × Region 数**：8GB / 4MB = 2048 Regions。堆越大 Region 越多 → RSet 总开销越大。什么时候应该增大 Region 大小（`-XX:G1HeapRegionSize`）？

#### 3. G1HeapRegionSize（Region 大小）

- **默认自动（堆大小 / 2048，取 2^n MB）**
- **为什么不是 1MB？** → 8GB 堆 = 8192 Regions → RSet 管理开销 ×4（每个 Region 都要维护自己的 RSet）
- **为什么不是 16MB？** → 512 Regions → 碎片粒度过大 → 一个小对象让整个 16MB Region 不能用作 Humongous 连续分配
- **什么时候手动设**：堆 > 32GB（自动算出的 Region 可能太大/太小）
- → 深挖 Region 大小对 free_list 和 Humongous 的影响：`[01 §六][02 §八]`

#### 4. InitiatingHeapOccupancyPercent / IHOP（并发标记触发阈值）

- **默认 45%。为什么是 45%？**
  - Concurrent Mark 需要时间（~seconds），Old 区在 CM 期间还在增长（allocation + promotion）
  - 如果 IHOP = 70%：CM 刚启动 Old 就满了 → allocation failure → Full GC
  - 如果 IHOP = 20%：CM 频繁但找不到可回收 Old Region（空转）→ CPU 浪费
  - 45% 的公式本质：给 CM 留出 (100% - 45%) = 55% 的 Old 空间作为"标记窗口"→ 只要 Old 净增长速率（allocation + promotion）< 55% × Old size / CM duration，就不退化 Full GC（简化模型，实际 promotion 速率是 IHOP 自适应最难预测的部分）
- **自适应模式**（`-XX:+G1UseAdaptiveIHOP`，默认开启）：G1 根据历史 allocation rate 和 marking time 动态调整 → `G1AdaptiveIHOPControl` 怎么根据 `G1Analytics` 预测修正阈值？
- → 深挖 IHOP 的自适应算法：`[08-MixedGC-Policy §二]`

#### 5. ConcGCThreads（并发标记线程数）

- **默认值推导**：`ConcGCThreads = MAX2((ParallelGCThreads + 2) / 4, 1)` — 约 **ParallelGCThreads / 4**（源码 `g1ConcurrentMark.cpp:367` `scale_concurrent_worker_threads()`）
- 示例：ParallelGCThreads=13 → `(13+2)/4 = 3.75` → ConcGCThreads=3
- ★ **为什么是 ~1/4 而不是等量？** → CM 线程和 mutator 线程共享 CPU。如果 CM 线程太多 → mutator 被频繁抢占 → allocation rate 下降 → 应用吞吐量崩。如果 CM 线程太少 → 标记跟不上 allocation rate → Old 持续增长 → IHOP 提前消耗 → Full GC
- ★ **为什么 1/4 是经验平衡点？** → 在 STW 阶段（Young GC），全部 ParallelGCThreads 个线程饱和 CPU 没问题（mutator 已暂停）。在并发阶段，CM 线程和 mutator 竞争 CPU。1/4 意味着：假设 13 核，3 个 CM 线程占总 CPU 的 ~23%，mutator 保留 ~77%——mutator 基本不受影响，CM 有足够推进速度。这是 Amdahl 定律的并发场景应用
- ★ **什么时候调**：CM 周期过长（marking 时间 > Old 增长率允许窗口）→ 增大；CM 抢 CPU 导致应用卡顿 → 减小
- → 深挖 `do_marking_step` 的时间片控制 + `SuspendibleThreadSet` 协调：`[06-ConcurrentMark-Core §四]`

#### 6. G1RSetUpdatingPauseTimePercent（RSet 更新占停顿时间比例）

- **默认 10%**。含义：每次 GC pause 中，最多用 10% 的时间来更新 RSet（处理 dirty cards）
- ★ **为什么是 10%？** → RSet 更新是 GC pause 的"固定开销"（和 CSet 大小无关）。如果占太多 → Evacuation 时间被压缩 → CSet 被迫缩小 → GC 频率升高
- **调大会怎样**：RSet 更精确（更多 dirty cards 被处理→ 下次 GC 的 RSet 扫描更少），但本次 pause 更长
- **调小会怎样**：RSet 残留更多 dirty cards → 下次 GC 的 RSet 扫描开销增大 → 下次 pause 更长
- → 深挖 DirtyCardQueue + G1ConcurrentRefine 的消费流程：`[04-CardTable-RSet §二]`

#### 7. G1MixedGCCountTarget（Mixed GC 最大轮数）

- **默认 8**。含义：一次 Mixed GC 周期内最多做 8 轮 Mixed GC
- ★ **为什么是 8？** → 每轮 Mixed GC 选 gc_efficiency 最高的 Old Region。8 轮 ≈ 可以覆盖大部分高 gc_efficiency 的 Old Region——再多的轮次边际收益递减（剩下的 gc_efficiency 太低）
- **调大会怎样**：更多 Old Region 被回收 → 但每轮 pause time 不变 → 总 STW 时间更长
- **调小会怎样**：可能无法回收足够 Old Region → Old 持续增长 → IHOP 再次触发 → 新一轮 CM + Mixed GC
- → 深挖 gc_efficiency 排序和 CSetChooser：`[08-MixedGC-Policy §四]`

#### 8. ParallelGCThreads（GC 并行线程数）

- **默认值推导**：`cores ≤ 8: ParallelGCThreads = cores`；`cores > 8: ParallelGCThreads = 8 + (cores - 8) × 5/8`（源码 `abstract_vm_version.cpp:349` `nof_parallel_worker_threads(5, 8, 8)`）
- ★ **为什么不是 `= CPU cores`？** → Amdahl 定律：GC 不是 100% 可并行。超过 8 个线程后，work stealing 开销 + 线程同步开销开始抵消并行收益。5/8 系数是经验折中
- ★ **线程数和 Work Stealing 的关系**：线程数越多 → TaskQueue 越多 → steal 概率越低但每个 steal 开销不变 → 需要在并行度和协调开销间平衡
- → 深挖 TaskQueue 机制：`[03-YoungGC §六]` 的 Work Stealing 小节

#### 9. G1HeapWastePercent（Mixed GC 停止阈值）⭐ 新增

- **默认 5%**。含义：当剩余候选 Old Region 的可回收空间 < 堆大小的 5% 时，**停止 Mixed GC**——即使还有候选 Region。这是 Mixed GC "边际收益递减" 的止损线
- ★ **为什么是 5%？** → 5% 的堆 = 8GB 堆下约 400MB。回收少于 400MB 却要付出 ~50ms STW → 不划算。多用一轮 Mixed GC 换来的回收 < 开销，不如等到下一轮 CM 再来
- ★ **调大会怎样？** Mixed GC 提前停止→Old 回收不彻底→Old 持续增长→IHOP 频繁触发 CM→CPU 浪费在无效 CM 周期上
- ★ **调小会怎样？** Mixed GC 做更多轮→大量 gc_efficiency 低的 Region 也被回收→总 STW 增加但边际回收递减→throughput 下降
- **什么场景调**：如果 `[gc,heap]` 显示 Old 回收量很少但 Mixed GC 仍在执行→调大止损线；如果 Mixed GC 停止后发现 Old 还有大量垃圾→调小止损线
- → 深挖 `collectionSetChooser.cpp` 中 `G1HeapWastePercent` 的判断逻辑：`[08-MixedGC-Policy §四]`

#### 9.5. G1MixedGCLiveThresholdPercent（Old Region 候选过滤）⭐ 新增

- **默认 85%**。含义：如果 Old Region 中活对象比例 > 85%，**直接排除候选**——回收成本远超收益
- ★ **为什么是 85%？** → 活对象 > 85% → 需要 Evacuation 的对象 > 85% → 复制开销 + RSet 更新 ≈ 或 > 回收的垃圾 → 不划算。这是 gc_efficiency 排序的 **前置过滤器**
- ★ **三元过滤链**：`G1MixedGCLiveThresholdPercent`（过滤活对象太多的）→ `gc_efficiency` 排序（挑性价比最高的）→ `G1MixedGCCountTarget` + `G1HeapWastePercent`（何时停止）
- **什么时候调**：Mixed GC 回收量很少但 Old 占用率高 → 可能太多 Region 被 85% 过滤掉了 → 调高到 90% 放更多 Region 进候选池
- → 深挖 `CollectionSetChooser::add_region()` 中 liveness 判断：`[08-MixedGC-Policy §四]`

#### 10. G1NewSizePercent / G1MaxNewSizePercent（年轻代边界）⭐ 新增

- **默认 5% / 60%**。含义：年轻代大小在 [5%, 60%] 堆的范围内自适应
- ★ **为什么有上下界？** → 下限 5%：防止 Young GC 过于频繁（每次 GC 有固定 overhead ~1ms STW 协调，太小则 overhead 比例过高）。上限 60%：给 Old 区留至少 40% 空间——IHOP 默认 45%，如果 Old 只剩 40%，IHOP 一触发就濒临 Full GC
- ★ **为什么调 MaxGCPauseMillis 不会让 Eden < 5%？** → G1YoungGenSizer 硬限制：即使 pause time target 要求更小的 CSet，Eden 也不会 < 堆的 5%。这是 pause time target "为什么不能无限小"的硬边界
- **什么时候调**：OLD 区长期不足 → 调小 G1MaxNewSizePercent；Young GC 过于频繁且 pause time 远低于 target → 调大 G1NewSizePercent
- → 深挖 `g1YoungGenSizer.cpp` 中年轻代大小边界计算：`[08-MixedGC-Policy §一]`

#### 11. ParallelRefProcEnabled（并行引用处理）⭐ 新增

- **默认 false**。含义：启用并行 Reference Processing（多线程同时处理发现队列中的引用）
- ★ **为什么默认关闭？** → 并行引用处理时，`DiscoveredList` 需要原子操作（`_discovery_is_mt = true`），增加 CAS 开销。如果引用数量少 → 串行就够了 → 省掉原子操作开销。JDK 选择保守默认
- ★ **什么场景必须开？** → GC log 中 `Post Evacuate` 阶段耗时 > 50% 或 `Reference Processing` 子阶段 > 30% 时——说明引用处理是瓶颈。大量使用 WeakHashMap / ThreadLocal / 缓存框架的场景，开启后 Reference Processing 耗时可降低 50-70%
- **验证方式**：开启前后对比 `[gc,phases]` 中 `Reference Processing` 的耗时（`-Xlog:gc+phases+ref=debug`）
- → 深挖 `ReferenceProcessor::process_discovered_references()` 的并行路径：`[11-Reference-Processing §四]`

#### 12. MaxTenuringThreshold（对象晋升年龄）⭐ 新增

- **默认 15**。含义：对象在 Survivor 中经过多少次 GC 后晋升到 Old
- ★ **为什么是 15？** → 4-bit age 字段（markOop 中保留 4 位 = 最大值 15）。不是任意的——markOop 的位宽限制了上限
- ★ **调大会怎样？** 对象在 Survivor 多待几轮 → 更多短命对象在 Young 区自然死亡（不被晋升到 Old）→ **Old 增长放缓 → IHOP 触发延迟 → CM 频率降低**。代价：Survivor 占用更多
- ★ **调小会怎样？** 对象更快晋升到 Old → Old 更快达到 IHOP → CM 更频繁 → CPU 开销增大
- **什么场景调**：Old 区持续增长且大量对象其实活不过几秒 → **调大 threshold**（配合 `-XX:TargetSurvivorRatio` 确保 Survivor 有足够空间让对象"多待一会儿"）
- → 深挖 ageTable + promotion 判定：`[03-YoungGC §二]`

---

## 四、三个生产场景的诊断链路

### 场景 1：Humongous 分配风暴

**症状**：GC log 频繁出现 `Humongous allocation` → 间歇性 Full GC → pause time 偶发秒级

**诊断步骤**：
1. `-Xlog:gc+humongous=debug` 看哪些对象是 Humongous（trace 级太啰嗦，debug 级够用）
2. 应用侧排查：是否有大 `byte[]` 缓存、大 String、序列化缓冲区？→ **第一步应该是应用层优化**（G1 对大对象不友好是设计上决定的，无法通过调参完全规避）
3. ★ **深入影响**：Humongous 对象分配在 Old Region（跳过 Young）→ 即使只活 1 秒，也永久垫高 Old occupancy → IHOP 提前 → 不必要的 CM 周期。它不只是"偶尔 Full GC"，是**持续性抬高 GC 开销**
4. 无法避免且有机会重启 JVM 时 → 增大堆 + 增大 `G1HeapRegionSize`（注意：Region 大小是启动参数，不能运行时改）
5. ★ **为什么增大 Region 能缓解？** → 4MB Region 时 Humongous 阈值 = 2MB；16MB Region 时阈值 = 8MB → 很多原来的 "Humongous" 变成常规对象 → 可以走 Evacuation 而非直接 Full GC
6. 无法重启时 → 只能增大堆（-Xmx），给 Humongous 分配留出更多连续空间
7. ★ **Humongous 回收不是只有 Full GC**：短命的 Humongous 在 CM Cleanup 阶段可以被 in-place 回收（直接标 Free）。只有当 **分配时找不到连续空间**（多个 Humongous 同时存活 + 碎片化）才退化 Full GC

### 场景 2：to-space exhausted / Evacuation Failure

**症状**：GC log 出现 `to-space exhausted` → pause time 突然变长 → 偶尔 Full GC

**诊断步骤**：
1. 检查 `G1ReservePercent` 是否设太小（默认 10%）→ 增大到 15-20% 作为应急
2. 检查 Survivor space 是否不足（promotion 压力大）→ `G1MaxNewSizePercent` 是否太低？
3. 检查是否有大量对象同时晋升（allocation spike）
4. ★ **检查 PLAB waste rate**（`-Xlog:gc+plab=trace`）→ waste > 50% 说明 PLAB 太小 → retired PLAB 中大量浪费 → 有效 to-space 缩水。**增大 `-XX:YoungPLABSize`**（或间接触发自适应：增大 `G1ReservePercent` 给 PLAB auto-tuning 更多操作空间）。这一条常常被忽略但效果显著：PLAB waste 10% vs 50%，可用 to-space 差 40%
5. ★ **为什么 Evacuation Failure 不等于 Full GC？** → 单次 Evac Failure 只是把失败的 Region 标记 RETAINED（`_evacuation_failed=true`）→ 等待下次 Mixed GC 回收或累积多次后触发 Full GC。但连续 Evac Failure 会耗尽 G1ReservePercent → 最终退化 Full GC

### 场景 3：并发标记周期过频

**症状**：CM 周期间隔 < 10 秒 → CPU 持续偏高 → 应用吞吐量下降

**诊断步骤**：
1. 看 IHOP：`-Xlog:gc+ergo+ihop=trace` 确认自适应算法是否偏太低 → 先尝试调 `-XX:G1AdaptiveIHOPInitialPercentage=55`（只改初始值，不影响自适应）→ 仍不行才考虑 **最后手段**：`-XX:-G1UseAdaptiveIHOP` 手动设 50-55%
2. 看 allocation rate：是否应用有泄漏？→ `jmap -histo:live` 确认
3. 看 ConcGCThreads：是否太少（标记跟不上分配速率）？或太多（抢了 mutator CPU 导致 allocation 堆积）？
4. 看是否开启了 StringDedup？→ `jmap -histo` 看到大量 `char[]` → `-XX:+UseStringDeduplication`（可以削减 Old 区 25%+ 的 live data，比调任何 GC 参数效果都好）
5. ★ **为什么 CM 过频也会导致 Full GC？** → CM 占 CPU → 标记时间窗口拉长 → Old 在更长的标记期间积累更多 promoted objects → Remark 阶段发现 Old occupancy 远超 IHOP 预期 → allocation failure 风险大增 → 最终 Full GC。这是 **负反馈循环**：越 GC 越慢 → 越慢越 GC

---

## 五、日志解读（G1 特有输出）

### ★ 调优必备日志套装（先开日志，再谈调优）

没有日志一切都是猜。开箱即用的两套配置：

```
★ 基础监控（生产环境必备，低开销）：
  -Xlog:gc*=info:file=/tmp/gc.log::filecount=10,filesize=100M
  → 输出：GC 类型、每次耗时、堆变化、CSet 组成、并发标记周期

★ 聚焦排查（怀疑 GC 是瓶颈时追加）：
  -Xlog:gc+heap=debug,gc+ergo+cset=trace,gc+phases=debug,gc+ref=debug,gc+plab=trace
  → 输出：详细子阶段耗时 + CSet 选择推理 + 引用处理细节 + PLAB waste
```

### 必须解读的 GC log 字段（JDK 9+ unified logging 格式，`-Xlog:gc*=info`）：

```
[gc,start     ] GC(42) Pause Young (Normal) (G1 Evacuation Pause)
[gc,phases    ] GC(42)   Pre Evacuate Collection Set: 0.3ms
[gc,phases    ] GC(42)   Evacuate Collection Set: 18.7ms
[gc,phases    ] GC(42)   Post Evacuate Collection Set: 2.1ms
[gc,phases    ] GC(42)   Other: 0.5ms
[gc,heap      ] GC(42) Eden: 2048M(2048M)->0B(1892M) Survivor: 256M->156M Old: 2048M->2200M
[gc,ergo,cset ] GC(42)   Chosen CSet: 52 regions (Eden: 48, Survivor: 4, Old: 0)
```

关键字段含义：
- `Pre Evacuate` vs `Evacuate` vs `Post Evacuate` 的比例 → 定位瓶颈在哪个阶段
- `Old: 2048M->2200M` — Old 增长速率 → IHOP 触发预测
- `Old: 0` in CSet — 确认这是 Young GC，不是 Mixed GC
- ★ **为什么垃圾回收后 Old 反而变大？** → 因为 Young GC 把 Eden/Survivor 中的活对象晋升（promote）到 Old 了

---

## 六、文章结构

```
§〇 文档索引 + 本文定位
  - 已完成的 12 篇文档引用表
  - 本文的独特价值：源码因果链驱动的参数决策（不是"经验值"罗列）

§一 ★ 调优方法论 — 不是调参数，是调决策链
  1.1 ★ 调优的本质：G1 的所有参数都在控制同一个决策循环
      → G1Policy → CSet 大小 → pause time → allocation rate → 下一轮 IHOP
  1.2 调优三步法：看症状 → 定瓶颈 → 改参数 → 验证（每步对应日志字段）
  1.3 ★ 设计替代分析：如果所有参数都用默认值，什么场景会出问题？

§二 ★★ 核心参数 — 13 个参数 × 每个"为什么是这个默认值"（源码因果链）
  2.1 MaxGCPauseMillis（200ms 的源码依据）
  2.2 -Xms/-Xmx + G1ReservePercent（堆大小 + 预留空间）
  2.3 G1HeapRegionSize（4MB 的 tradeoff）
  2.4 IHOP（45% 的公式推导）
  2.5 ConcGCThreads（~1/4 规则的源码公式）
  2.6 G1RSetUpdatingPauseTimePercent（10% 的权衡）
  2.7 G1MixedGCCountTarget（8 轮的理由）
  2.8 ParallelGCThreads（Amdahl 定律的应用）
  2.9 G1HeapWastePercent（Mixed GC 停止阈值 — 为什么 5%）
  2.10 G1MixedGCLiveThresholdPercent（Old Region 候选过滤 — 三元过滤链第二环）
  2.11 G1NewSizePercent / G1MaxNewSizePercent（年轻代边界 — 为什么 pause time target 不能无限小）
  2.12 ParallelRefProcEnabled（引用处理并行化 — 为什么默认关闭）
  2.13 MaxTenuringThreshold（对象晋升年龄 — 为什么是 15）

§三 ★★ 生产场景诊断 — 3 个场景 × "症状→日志→参数→验证"
  3.1 Humongous 分配风暴 → 间歇性 Full GC（含 in-place 回收说明）
  3.2 to-space exhausted → Evacuation Failure
  3.3 并发标记周期过频 → CPU 持续偏高

§四 ★ GC 日志速查 — G1 特有字段解读
  4.0 ★ 调优必备日志套装（生产基础集 + 聚焦排查集）
  4.1 Young GC log 字段逐行解释（含 Old 区为什么越回收越大）
  4.2 Mixed GC log 关键差异点（CSet 中出现 Old）
  4.3 Full GC log 识别（"Pause Full" 关键字）
  4.4 Concurrent Mark 周期识别（IHOP 触发→Cleanup 结束）

§五 调优决策树
  5.1 Mermaid：从症状到参数的决策图
      高延迟 → pause time 长 → 减小 MaxGCPauseMillis → CSet 缩小 → GC 频率升高
      → 如果 throughput 也降了 → 增大堆 → 增大 Region → 循环
  5.2 常见调优组合（不要单参数调）

§六 可证伪断言 ≥5 条
```

---

## 七、写作要求

1. **★ 每个参数必须回答"为什么是这个默认值"** — 不是"Oracle 推荐"，而是从源码因果链推导（Region 4MB、CardTable 512B、PLAB waste rate、gc_efficiency 公式）。这是本文区分于所有已有调优指南的核心价值
2. **★ 禁止参数列表式罗列** — 不要"参数名 → 含义 → 默认值 → 建议值"这种格式。按排查链路组织：症状 → 定位 → 参数 → 验证
3. **★ 禁止做源码翻译机** — 不贴大段源码，但每个建议值必须标注"因为 [01 §六] 中 free_list 的性质 导致了 X"这种因果链
4. **★ 与已有 12 篇文档的精确交叉引用** — 每个参数的解释链追溯到具体文档的具体章节
5. **★ 设计替代分析 ≥2 处**：
   - 如果所有参数都用默认值，什么场景会出问题？（堆 4GB + 高 allocation rate）
   - 如果把 MaxGCPauseMillis 设成 10ms 会怎样？（源码论证为什么不可能）
6. **★ Mermaid 决策树 1 张**：从症状到参数的诊断流程图
7. **★ 可证伪断言 ≥5 条**：每条标注 GC log 命令 + 预期输出
8. **★ 面向实战** — 读完本文应该能拿着 GC log 定位问题、选对参数、给出理由
9. **★ 每个"经验值"要有源码因果链** — 不许出现"一般建议设成 X"而没有因果论证
10. **元信息头**：标准环境 + 已有文档索引 + 阅读收益

---

## 八、标准环境

- OpenJDK 11 slowdebug build
- `-Xms8g -Xmx8g -XX:+UseG1GC -XX:MaxGCPauseMillis=200`
- G1 Region 大小 = 4MB，共 2048 Regions
- 64 位 Linux x86

---

## 九、已有文档交叉引用

| 文档 | 本文引用点 |
|------|-----------|
| [01] HeapRegion | Region 4MB 的 tradeoff、free_list 结构、G1HeapRegionSize |
| [02] ObjectAllocation | Humongous 分配风暴排查、attempt_allocation_slow 持锁 expand |
| [03] YoungGC | Evacuation Failure 处理、Work Stealing 机制、MaxTenuringThreshold/ageTable |
| [04] CardTable-RSet | RSet 更新消耗、G1RSetUpdatingPauseTimePercent |
| [05] SATB-Barrier | SATB 激活窗口（CM 期间 Concurrent Refinement 开销影响） |
| [06] ConcurrentMark-Core | ConcGCThreads 的 CPU 竞争、时间片控制 |
| [07] ConcurrentMark-Phases | CM Cleanup 阶段 Humongous in-place 回收 |
| [08] MixedGC-Policy | IHOP 自适应、gc_efficiency、G1MixedGCCountTarget、G1HeapWastePercent、G1MixedGCLiveThresholdPercent、G1NewSizePercent |
| [09] FullGC | 三条触发路径排查 |
| [10] PLAB | PLAB waste rate → to-space 利用效率 → Evacuation Failure 排查 |
| [11] Reference-Processing | ParallelRefProcEnabled 的影响范围 |

---

## 十、聚焦源文件

| # | 文件 | 核心用途 |
|---|------|------|
| 1 | `g1Policy.cpp` | MaxGCPauseMillis → `_young_list_target_length` 计算、IHOP 自适应 |
| 2 | `g1IHOPControl.cpp` | G1AdaptiveIHOPControl 的自适应算法 |
| 3 | `g1Analytics.cpp` | allocation rate、pause time 预测 |
| 4 | `g1CollectedHeap.cpp` | heap expand/shrink、G1ReservePercent 使用 |
| 5 | `g1ConcurrentMarkThread.cpp` | ConcGCThreads 的实际调度 |
| 6 | `collectionSetChooser.cpp` | gc_efficiency 排序 |
| 7 | `g1RemSet.cpp` | G1RSetUpdatingPauseTimePercent 应用 |

---

## 十一、输出格式

- 输出 Markdown 文件命名：`A1-G1-Tuning.md`（本文是 prompt，最终产出是正文）
- 输出路径：`/data/workspace/openjdk-cut-new/probe_md/libjvm-analysis/06-gc-memory/`
- 不限制行数，13 个参数每个必须讲透因果链，内容完整度优先
