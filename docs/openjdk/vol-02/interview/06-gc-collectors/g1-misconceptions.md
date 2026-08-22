# G1 GC 常见误解清单（逐条纠偏版）

> 这不是“G1 是什么”的入门介绍，而是专门纠偏：把市面上最容易讲错、讲反、讲浅的点逐条打穿。
>
> 建议配合 `26-g1-gc/01-07` 正文阅读。

## 1. “G1 的核心就是把堆切成很多 Region”

**错在哪**

只讲 Region，等于只讲了地理网格，没讲治理协议。

**更准确的说法**

G1 的核心不是 Region 本身，而是：

```text
Region
+ SATB 并发标记
+ RSet 反向索引
+ pause budgeting
+ evacuation / mixed selection
```

Region 只是载体。真正让 G1 和传统代际收集器分道扬镳的，是它把“这次暂停该处理什么”收窄成 **Collection Set + 这些 Region 的外部入边**，而不是继续和整块老年代绑定。

## 2. “RSet 记录的是这个 Region 指向了谁”

**错在哪**

方向反了。

**更准确的说法**

RSet 是 **target region 视角下的反向索引**：如果我要收 Region Y，我关心的是“哪些别的 Region 的哪些 cards 可能指向 Y”。

它不是正向边表，不是在说“我出去引用了谁”；它是在说“谁可能从外面来找我”。

这一点一旦看反，Update RS / Scan RS、coarse/fine/sparse、甚至 pause 工作集缩小的收益点都会全讲错。

## 3. “SATB 就是记录新增引用”

**错在哪**

把 G1 和 CMS 经典思路混成了一种。

**更准确的说法**

G1 的 SATB（Snapshot-At-The-Beginning）记录的是**删除前旧值**，服务的是并发标记快照语义：

- 标记开始时假设对象图拍了一张快照；
- mutator 之后把某条边删掉时，旧值要先记下来；
- 这样并发标记即使晚一点看到，也不会漏掉这条“快照中本来存在的边”。

CMS 经典的并发更新方向更接近“记录新增边”。两者的记录方向不同，语义也不同，不能混着说。

## 4. “Young GC / Mixed GC 时，G1 还是会把老年代都扫一遍”

**错在哪**

这等于否认了 RSet 的存在意义。

**更准确的说法**

G1 的暂停收益，正是在于它不再把 pause 成本重新绑回“老年代总大小”。

在 pause 中：

- 先 `Update RS` 清尾，把还没精炼完的 dirty card 线索补进 remembered-set 视图；
- 再 `Scan RS`，只扫 **Collection Set 各 Region 的 remembered set 里列出的来源 cards**。

也就是说，G1 想做到的不是“扫描更快”，而是“先把要扫描的东西缩小到只剩必要 cards”。

## 5. “Mixed GC 就是 Young GC 顺便回收一点老年代”

**错在哪**

“顺便”把最核心的选择逻辑抹掉了。

**更准确的说法**

Mixed GC 不是附带行为，而是并发标记结束后的一套**收益受预算约束的老年代回收选择协议**。

它至少要同时回答：

- 哪些 old region 的回收收益够高；
- 这次 pause 预算允许把多少 old region 放进 CSet；
- 当前 remembered set / card 精炼成本是否会让 pause 超预算；
- Humongous / pinned / evacuation failure 风险如何影响选择。

所以 Mixed GC 不是“年轻代回收完，顺手捎点 old”，而是“有预算地把最值得回收的 old region 混进这次 evacuation”。

## 6. “G1 的 barrier 就是卡表写屏障”

**错在哪**

把三条不同语义的链压成了一个词。

**更准确的说法**

G1 至少有三条不能混的机制：

1. **post-write barrier / dirty card queue**
   - 作用：记录“这张来源 card 可能脏了”
   - 面向：RSet 精炼 / Update RS
2. **SATB pre-barrier**
   - 作用：记录“删除前旧值”
   - 面向：并发标记快照
3. **精炼线程 / pause 内 Update RS**
   - 作用：把来源 card 线索翻译成 target region 的 remembered set

所以“G1 有写屏障”这句话太粗。你必须说清它到底在维护哪一个不变量。

更关键的是，pre-barrier 和 post-barrier 不能合并，因为它们维护的是两个不同的时间维度：

- pre-barrier 维护的是**并发标记快照里的历史边**——删除发生之后，旧值不能从这轮快照里凭空消失；
- post-barrier 维护的是**当前 heap layout 里的新脏卡线索**——跨 Region 写入发生后，来源 card 必须进入后续 RSet 精炼链。

一个维护过去的快照，一个维护当前的布局；把它们统称为“写屏障”会把 G1 最关键的时间语义抹掉。

## 7. “并发标记已经知道哪些对象活着，所以 pause 里就直接搬对象”

**错在哪**

把“谁活着”和“谁指向我要收的 Region”混成了一件事。

**更准确的说法**

并发标记回答的是：

```text
哪些对象在这一轮快照里活着？
```

而 evacuation pause 还必须回答：

```text
如果我要搬走 CSet 里的 Region，外面谁还指着它们？
```

前者靠 SATB + 标记位图；后者靠 RSet + card 精炼。

G1 要同时把这两件事做对，才能既不漏活对象，又不在 pause 里全扫老年代。

## 8. “G1 的 pause 时间主要由堆大小决定”

**错在哪**

这等于把 G1 重新讲回传统 stop-the-world collector。

**更准确的说法**

更收紧地说，G1 想让 pause 时间尽量与**本次工作集**相关，而不是和**整个堆容量**强绑定。

也就是说，它希望 pause 主要由：

- 本次 CSet 的大小
- 外部入边卡片数
- evacuation / copy 成本
- 精炼尾巴
- 选择进来的 mixed old region 数量

共同决定，而不是简单由“整个堆有多大”决定。

这就是为什么它需要 `MaxGCPauseMillis`、预测模型、Region 选择和 RSet——它在做 pause 工作集预算，而不是只在做堆回收。

## 9. “Humongous 对象就是大对象而已，对 G1 没什么本质影响”

**错在哪**

低估了 humongous path 对布局和回收策略的扰动。

**更准确的说法**

Humongous 对象在 G1 里通常直接占多个连续 Region，不走普通 Eden/TLAB 分配路径，也不参加普通 evacuation copy 协议。这会影响：

- Region 连续性要求
- remembered-set 成本
- mixed collection 的收益计算
- Full GC 或空间回收时机

所以 humongous 不是“大一点的普通对象”，而是一条不同的生命周期和布局路径。

## 10. “G1 已经并发了，所以失败时也不会退化得太重”

**错在哪**

把正常路径的低停顿，误当成失败路径也会很优雅。

**更准确的说法**

G1 仍然有退化路径，而且这些路径经常正是生产事故时你需要知道的：

- to-space exhausted / evacuation failure
- promotion 失败
- humongous 分配失败
- Metaspace / JNI critical section / GCLocker 对回收时机的干扰
- 最终退化到 Full GC

所以“懂 G1”不只是懂正常路径，更要懂它在什么条件下放弃自己的主协议，退回更保守、更重的路径。

再说得更直白一点：**并发和低停顿并不意味着失败路径也会很优雅。** 恰恰相反，失败路径往往意味着 G1 赖以压低 pause 的前提（可用 to-space、可控的 mixed 预算、正常的精炼与 evacuation）已经失效，于是退化通常会比“普通回收”更重，而不是更轻。这也是为什么生产事故里的 G1 经常让人感觉“平时很好，一旦出问题就特别难看”。

## 一句话总收束

市面上很多 G1 讲解之所以错，不是因为它们一字不对，而是因为它们只讲了**现象层**，没讲清 G1 的三个真正支点：

- **SATB**：保护并发标记快照
- **RSet**：压缩 pause 工作集
- **pause budgeting**：控制这次到底收什么

只要这三点没讲透，讲得再顺，也只是“看起来懂 G1”。