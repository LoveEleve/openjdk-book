# PROMPT: 请撰写 00-G1GC-Overview.md

## 一、任务

撰写一篇 G1 GC 全景概览文档，主题：**G1 GC 全链路：一个对象从分配到消亡穿越 G1 的完整生命周期，每步标注对应文档编号**

### 核心故事线（禁止做源码翻译机！）

你已经完成了 11 篇 G1 GC 深度源码分析文档（01-HeapRegion 到 11-Reference-Processing）。现在需要写一篇**唯一面向入门读者的全景导航**——它就是 G1 GC 文档集的"序言 + 索引"。读者应该读完本文后形成 G1 GC 的心理模型骨架，然后按需查阅各篇深挖。

**本文的核心叙事线不是"某个子系统的实现细节"，而是回答一个总问题**：

> **一个 Java 对象从 `new` 到被回收，在 G1 GC 中经历了什么？每一步由谁决定、由谁执行、按什么顺序？**

```
Java 代码: obj = new byte[1024]();
    │
    ▼
┌──────────────────────────────────────────────────────────────────┐
│ 阶段 A: 分配 — TLAB bump → Eden CAS → Humongous 特殊路径 [01][02][10] │
├──────────────────────────────────────────────────────────────────┤
│ 阶段 B: 引用写入（运行时屏障）— 每次 obj.field = other，GC 铺路  │
│          ┌─ CardTable 标记脏卡 — 为 RSet 提供数据源 [04]          │
│          └─ SATB 前屏障记录旧值 — 为并发标记提供快照 [05]         │
├──────────────────────────────────────────────────────────────────┤
│ 阶段 C: GC 周期 — 触发 + 执行 + 引用处理，一个完整回收周期         │
│   触发链（G1Policy 决策 [08]）:                                    │
│     Eden 满 → Young GC [03]                                       │
│     Old 超过 IHOP(默认45%) → 启动 Concurrent Mark [06][07]         │
│     CM Cleanup 后有候选 Region → Mixed GC×N [08]                   │
│     Humongous 分配失败 / Evac Failure 累积 / CM abort → Full GC [09]│
│   每次 GC 周期内:                                                  │
│     ├─ 标记/Evacuate（活对象 → 安全区）                            │
│     ├─ Reference Processing（四种引用统一管线）[11]                │
│     └─ WeakProcessor（JNI Weak Global + StringTable）[11]          │
├──────────────────────────────────────────────────────────────────┤
│ 阶段 D: 回收 — Region 回到 free_list，等待下一次分配 [01][03][09] │
│   Young GC: CSet Region type → Free，放回 free_list                │
│   Full GC: sliding compaction 消除碎片 → 重建连续 free_list        │
└──────────────────────────────────────────────────────────────────┘
```

---

### 核心叙事线（10 个"为什么"问题，每个必须有简洁回答 + 文档引用）

**❓ 架构设计层（Overview 最核心的两问——先回答"为什么有 G1"）**

0. **❓ G1 凭什么做到"可预测的停顿时间"？它的核心创新是什么？**
   → 回答：Region + Concurrent Mark。Region 让每次 GC 只回收集合内的部分堆（CSet size 可动态调整）→ pause time ∝ CSet live data, not ∝ heap size。Concurrent Mark 把 Old 区的"哪些是垃圾"标记工作移出 STW → Old 回收不阻塞应用。没有这两点，G1 就是 ParallelOld。
   → 深挖 → `[01-HeapRegion]` + `[06-ConcurrentMark-Core]`

**❓ 分配层**

1. **❓ 为什么 G1 需要 TLAB？没有 TLAB 会怎样？为什么 TLAB 失败后不直接 GC 还要试 Eden CAS？**
   → 回答：TLAB 避免锁竞争 (~10 cycles bump-pointer)；失败后试 Eden CAS 是乐观重试（可能其他线程刚释放了 Eden 空间），省一次 GC。
   → 深挖 → `[02-ObjectAllocation]` + `[10-PLAB]`（GC 侧的 TLAB）

2. **❓ Region 到底是什么？为什么 G1 选 4MB 而不是 1MB 或 16MB？**
   → 回答：G1 的最小回收单元。4MB 是时间开销和碎片控制的折中—— 1MB 导致 8GB 堆有 8192 个 Region（扫描开销大）；16MB 导致碎片粒度太大（一个小对象浪费一整块）。
   → 深挖 → `[01-HeapRegion]`

**❓ GC 触发层**

3. **❓ G1 怎么决定做 Young GC、Mixed GC 还是 Full GC？谁在决策？Humongous 分配直接触发 Full GC 是什么情况？**
   → 回答：G1Policy 全局状态机决定。Young GC：Eden 填满或 G1Policy 主动调度（pause time target）；Mixed GC：CM Cleanup 后 Old 候选 Region >0；Full GC：三种路径——(a) Evacuation Failure 累积 (b) Humongous 找不到连续空 Region **直接触发** (c) CM abort 触发。Humongous 路径是"绕过 Young/Mixed，直接 Full GC"的关键通道。
   → 深挖 → `[08-MixedGC-Policy]`（G1Policy/IHOP） + `[09-FullGC]`（完整触发链） + `[02-ObjectAllocation]`（Humongous 分配）

4. **❓ 为什么 Young GC 是"先发制人"的主动调度而非被动应急？这和其他 GC 有什么不同？**
   → 回答：G1Policy 维护 `_young_list_target_length`，它基于 pause time target 动态调整 Young 代大小——不是等到 Eden 真正耗空才 GC，而是在"预估下次 GC 耗时超标"前主动触发。
   → 深挖 → `[03-YoungGC]` + `[08-MixedGC-Policy]`

**❓ GC 执行层**

5. **❓ G1 Young GC 为什么选择 Evacuation（复制）而不是 Mark-Sweep（标记清除）？**
   → 回答：Eden 中 90%+ 是垃圾，复制活对象（少）的成本远低于扫描整个 Eden（多）。且复制天然消除了碎片——Survivor Region 是 bump-pointer 紧凑分配。
   → 深挖 → `[03-YoungGC]`

6. **❓ 四种 GC 类型（Young/Mixed/Full/CM）在"依赖什么基础设施 + 大致耗时 + 解决了什么问题"上有什么区别？**
   → 构建对比表：Young GC（快速常规回收，~20-50ms）→ Mixed GC（Old 分批回收，挑 gc_efficiency 高的 Region，~50-100ms）→ CM（后台找 Old 垃圾，不 STW）→ Full GC（保底全堆压缩，~seconds）。
   → 深挖 → `[04-CardTable-RSet]` + `[05-SATB-Barrier]` + `[06-ConcurrentMark-Core]` + `[09-FullGC]`

**❓ 基础设施层**

7. **❓ 为什么 G1 需要 RSet（Remembered Set）？没有 RSet 会怎样？**
   → 回答：没有 RSet = 每次 Young GC 都需要扫描整个堆找 Old→Young 的引用 = 8GB 全堆扫描 ≈ seconds 级 STW。RSet 是"Old 的哪张 Card 引用了 Young"的反向索引。
   → 深挖 → `[04-CardTable-RSet]`

8. **❓ 整个 GC 过程中，四种引用（Soft/Weak/Final/Phantom）在什么时机被处理？每个 GC 类型的 Reference Processing 范围有什么不同？**
   → 回答：所有 GC 共享同一套 `process_discovered_references()` 管线，但 **discovery 范围不同**：Young/Mixed GC 只发现 CSet 内的 Reference（因为只扫描 CSet）；Full GC 全堆发现（全堆标记）。处理时机：Young GC Phase 3 / Full GC Phase 1 / CM Remark 阶段。
   → 深挖 → `[11-Reference-Processing]`

---

### 禁止行为

- ❌ **不要尝试"浓缩"任何一篇已有文档的内容** — 本文只讲"是什么、什么时候、引用到哪篇"，不展开"怎么实现"
- ❌ **不要贴大段源码** — 可以用 3-5 行的代码片段辅助说明关键概念，但本文不是源码分析文档
- ❌ **不要把本文写成"文档目录"** — 不是编号列表，是带叙事线的全链路
- ❌ **不要深入讨论任何一个子系统的实现细节** — 留给对应文档
- ❌ **不要引入新概念而不解释** — 每个术语第一次出现时给一句话定义

### 要求行为

- ✅ **★ 以"一个对象的一生"为叙事主线** — 从 `new byte[1024]()` 开始，到 Region 回到 free_list 结束
- ✅ **★ 每节以"❓ 为什么..."开头** — 先问问题，再给一句话答案 + 文档引用
- ✅ **★ 全文 Mermaid 图 ≥2 张**：
  1. **对象全生命周期** — 从分配到回收的主 Mermaid 流程图（标注每步对应的文档编号）
  2. **四种 GC 类型对比** — 决策树：什么时候触发哪种 GC？走哪条路径？
- ✅ **★ 四种 GC 对比表** — Young / Mixed / Full / CM 在"触发条件、STW、依赖 RSet？依赖 SATB？回收策略、引用发现方式"上的对比
- ✅ **★ 与 11 篇已有文档的精确交叉引用** — 每条引用到具体章节（如 `[03-YoungGC §3.3]`）
- ✅ **★ 面向面试** — 读完本文能做"G1 GC 全景是什么"的系统回答（附带 5+ 面试题）
- ✅ **★ 设计替代分析 ≥2 处**：
  1. 如果 G1 不分 Region（单一块式堆）— 为什么不行？
  2. 如果所有 GC 都做 Compaction（像 Full GC）— 为什么不行？
- ✅ **★ 元信息头**：标准环境 + 阅读收益 + 阅读路径建议（入门/进阶/专家）

---

## 二、标准环境

- OpenJDK 11 slowdebug build
- `-Xms8g -Xmx8g -XX:+UseG1GC -XX:MaxGCPauseMillis=200`
- G1 Region 大小 = 4MB，共 2048 Regions
- 64 位 Linux x86

---

## 三、11 篇已有文档索引（必须精确引用）

| # | 文档 | 核心内容 | 本文引用点 |
|---|------|------|------|
| [01] | `01-HeapRegion` | Region 432B 字段全景、状态机、free_list、TAMS | 阶段 1 分配 / 阶段 6 回收 |
| [02] | `02-ObjectAllocation` | TLAB bump → Eden CAS → Humongous | 阶段 1 分配 |
| [10] | `10-PLAB` | GC worker 侧的 TLAB（三级分配 + waste accounting） | 阶段 4 GC 执行 |
| [03] | `03-YoungGC` | 四阶段 Evacuation + CAS 转发 + Work Stealing | 阶段 3 触发 / 阶段 4 执行 |
| [04] | `04-CardTable-RSet` | CardTable 512B + RSet 三级（Sparse→Fine→Coarse） | 阶段 2 引用写入 / 阶段 4 RSet 依赖 |
| [05] | `05-SATB-Barrier` | SATB 前屏障 + per-thread buffer + completed_buffers | 阶段 2 引用写入 / 并发标记依赖 |
| [06] | `06-ConcurrentMark-Core` | do_marking_step 四段走读 + Finger CAS + MarkStack | 阶段 3 CM 触发 / 阶段 4 CM 执行 |
| [07] | `07-ConcurrentMark-Phases` | Initial Mark → Remark → Cleanup → Rebuild RSet | 阶段 3 CM 触发 |
| [08] | `08-MixedGC-Policy` | G1Policy 全局决策引擎 + IHOP + Mixed GC CSet 选策 | 阶段 3 触发决策 |
| [09] | `09-FullGC` | 触发链 + 四阶段 MPAC + 滑动压缩 | 阶段 3 保底 / 阶段 4 执行 |
| [11] | `11-Reference-Processing` | 四种引用的 Discovery/Processing 两阶段 + 四 Phase 管线 | 阶段 5 引用处理 |

---

## 四、聚焦源文件（仅列本文直接引用的关键入口）

| # | 文件 | 核心用途 |
|---|------|------|
| 1 | `g1CollectedHeap.cpp` | GC 入口 `do_collection_pause_at_safepoint()` / `attempt_allocation_slow()` |
| 2 | `g1Policy.cpp` | GC 决策引擎（Young/Mixed 调度 + IHOP 触发 CM） |
| 3 | `g1FullCollector.cpp` | Full GC 四阶段调度 |
| 4 | `referenceProcessor.cpp` | 四 Phase 引用处理管线 |
| 5 | `heapRegionManager.cpp` | Region 分配/回收/expand |

---

## 五、文章结构（§〇 ~ §七）

```
§〇 文档清单 + 阅读路径
  - 11 篇已有文档索引（标注阅读顺序建议：入门/进阶/专家）
  - 读者指南：什么章节适合什么背景的读者

§一 ★ 全景 — 一个对象的全生命周期（主 Mermaid 图）
  1.1 Mermaid 1：对象全生命周期 — new → TLAB/Eden → Region → 屏障 → GC 周期 → free_list
      （图中每步标注被哪篇文档深挖，以文档编号标注在边上）
  1.2 各阶段的时间开销量级（TLAB ~10 cycles / Young GC ~20-50ms / CM ~seconds / Full GC ~seconds）
  1.3 ★ 为什么 G1 需要 Region？设计替代分析 ① — 单一块式堆 vs 分区堆（pause time ∝ heap size vs ∝ CSet size）

§二 ★★ 阶段 A：分配 — 对象怎么到达堆上
  2.1 分配决策树：TLAB bump → Eden CAS bump → Heap_lock+换 Region → Young GC
      ★ 为什么 TLAB 失败后不直接 GC？（乐观重试省一次 GC）
  2.2 TLAB vs PLAB：Mutator 侧 [02] vs GC 侧 [10] 的对偶结构
  2.3 Humongous 分配：≥2MB 的大对象 — 连续 N 个 Region，失败直接触发 Full GC

§三 ★★ 阶段 B：运行时屏障 — GC 基础设施在暗中铺路
  ❓ 每次 obj.field = other，JVM 额外做了什么？
  3.1 CardTable 写屏障：标记脏卡（512B 粒度）→ 驱动 RSet 增量更新 [04]
  3.2 SATB 前屏障：记录旧值 → per-thread buffer → concurrent mark 消费 [05]
  3.3 两套屏障的激活窗口：CardTable 始终激活；SATB 只在 CM 期间激活（为什么？→ 省无关开销）

§四 ★★★ 阶段 C：GC 周期 — 四种 GC 的执行概览
  ❓ 四种 GC 各做什么？怎么触发？耗时多少？
  4.1 Mermaid 2：GC 类型决策树 — 从 Eden 满开始，标注每条触发分支的条件和对应的 GC 类型
      ★ 关键节点：Eden 满 → Young GC → Old 超 IHOP？→ CM → Cleanup 有候选？→ Mixed ×N
      ★ 分流分支：Humongous 分配失败 / CM abort / Evac Failure 累积 → Full GC
  4.2-4.5 四种 GC 的简短概览（每类 ~10 行）:
      Young GC：4.5 Phase, ~20-50ms, CSet=Eden+Survivor, Evacuation+copy_to_survivor_space
      Mixed GC：同 Young GC, CSet=Eden+Survivor+Old(gc_efficiency 排序), ~50-100ms, 1-8 轮
      Concurrent Mark：Initial→Concurrent→Remark→Cleanup, ~seconds 无 STW, Remark~50ms
      Full GC：MPAC 四阶段, ~seconds STW, 全堆压缩消除碎片
  4.6 四种 GC 对比总表（触发条件、STW time、RSet/SATB/TAMS 依赖、Basic 回收策略）
  4.7 ★ 设计替代分析 ② — 如果所有 GC 都做 Compaction（像 Full GC）会怎样？
      → 每次 Young GC 都要全堆标记 + 修正指针 = STW ∝ heap size → pause time target 失效

§五 ★ 阶段 C 内嵌：Reference Processing — GC 周期中的引用处理
  ❓ GC 怎么处理 Soft/Weak/Final/Phantom 引用？
  5.1 Discovery/Processing 两阶段分离 — 为什么不能边发现边处理？（Parallel marking 硬约束）
  5.2 四 Phase 管线顺序（Soft→Weak→Final→Phantom 的硬依赖链）
  5.3 ★ Young/Mixed GC 只发现 CSet 内 Reference；Full GC 全堆发现 — 这是关键差异
  5.4 三种 GC 如何分别调用统一管线
      → 全部深挖 `[11-Reference-Processing]`

§六 ★ 阶段 D：回收 — Region 回到 free_list
  ❓ GC 完成后，Region 去了哪里？
  6.1 Young/Mixed GC：CSet Region type → Free，放回 free_list（`remove_all_from_collection_set()`）
  6.2 Full GC：sliding compaction 消除碎片 → 大块连续空闲 → **完全重建** free_list
  6.3 ★ 为什么 Full GC 后堆碎片被消除？（Compaction 把所有活对象紧凑排列到堆底部）

§七 面试视角 + 全景总结
  ❓ "请简要介绍 G1 GC" — 30 秒版 / 2 分钟版
  面试问题 7 个：
    1. G1 和 Serial/Parallel/CMS/ZGC 的核心区别？
    2. G1 怎么实现可预测停顿？pause time target 怎么起作用？
    3. 什么情况下 G1 降级到 Full GC？三条触发路径分别是什么？
    4. Concurrent Mark abort 后会发生什么？
    5. IHOP 调低了/调高了分别什么后果？
    6. Young GC 和 Mixed GC 在执行流程上有什么相同和不同？
    7. G1 的两套写屏障（CardTable + SATB）各有什么用？为什么需要两套？
```

---

## 六、写作要求

1. **★ 本文是"导航 + 全景"，不是"缩写"** — 绝不浓缩任何已有文档的源码分析内容
2. **★ 每节以"❓ 为什么..."开头** — 先问问题，再用 1-2 句回答 + 深挖引用
3. **★ 设计替代分析 ≥2 处**
4. **★ Mermaid 图 ≥2 张**（对象生命周期 + GC 决策树）
5. **★ 与已有 11 篇的精确交叉引用** — 每条引用到具体章节
6. **★ 面试友好** — 本文应该让读者能做出 30 秒和 2 分钟版本的 G1 GC 全景回答
7. **★ 面向入门读者** — 每个术语第一次出现给一句话解释，不做任何假设
8. **★ 时间量级标注** — 每个操作标注大约耗时（TLAB ~10 cycles / Young GC ~20ms / CM ~seconds / Full GC ~seconds）
9. **★ 禁止深入任何子系统的实现** — 只说"Y 在阶段 Z 做 X → 深挖在 [N]"**

---

## 七、输出格式

- Markdown 文件，命名为 `00-G1GC-Overview.md`
- 输出路径：`/data/workspace/openjdk-cut-new/probe_md/libjvm-analysis/06-gc-memory/`
- 目标行数：~300-400 行（全景文档 + 面试 + 对比表，需要一定篇幅才能讲清楚）
- 元信息头：标准环境 + 11 篇已有文档索引表 + 阅读收益 + 阅读路径建议（入门/进阶/专家三档）
- 阅读收益强调：读完本文后能回答"一个对象从分配到回收在 G1 中经历的四阶段是什么？四种 GC 类型有什么区别（触发条件、大致耗时、解决了什么问题）？什么时候触发哪种 GC（含 Humongous 直接 Full GC 和 CM abort 两条隐藏路径）？G1 依赖哪些关键基础设施（Region、RSet、SATB、TLAB/PLAB、G1Policy/IHOP）？四种引用在什么时候被处理？Reference Processing 在 Young/Mixed GC 中为什么是 CSet 限定的？G1 和 Serial/Parallel/CMS/ZGC 的核心区别？"
- ★ 重要：本文面向**入门读者**——每个第一次出现的术语（Region、CSet、RSet、SATB、TLAB、PLAB、IHOP、Evacuation、Compaction、Humongous、gc_efficiency）给一句括号定义
