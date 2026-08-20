# 10-concurrent-collections/02 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `java.util.concurrent.ConcurrentHashMap`。本文聚焦 `sizeCtl`、`initTable`、`addCount`、`helpTransfer`、`transfer`、`ForwardingNode`、`baseCount`、`counterCells`、`CounterCell` 与 `sumCount`。完整树化逻辑、跳表与其他并发容器不在本文展开。
> 目标：把“ConcurrentHashMap 扩容与计数”改写成一篇围绕“为什么并发哈希表不能等满了再由一个线程独占扩容，也不能只靠一个全局 `size` 计数器”的机制文章。

## 1. 读者困惑

- 为什么 `ConcurrentHashMap` 的扩容不能像单线程 `HashMap` 那样，一个线程停下来把所有桶搬完再继续？
- `sizeCtl` 为什么一个字段要同时承担初始化阈值、扩容阈值和扩容状态？
- 为什么写线程在 `putVal` 里遇到 `MOVED` 会转去 `helpTransfer`？
- 扩容时旧桶为什么要放 `ForwardingNode`，读线程又怎么借它转到新表？
- `transferIndex` 为什么存在，它解决的是哪种协作冲突？
- 为什么 CHM 不能只用一个 `AtomicLong size` 统计元素个数？
- `size()` 为什么常被说成弱一致，这和 `CounterCell` 有什么关系？

## 2. 一句话顿悟

**ConcurrentHashMap 把“表太满了怎么办”和“元素个数怎么统计”都做成了分摊式并发协议：扩容不是某个线程独占停机搬家，而是由 `sizeCtl` 协调、`transferIndex` 分片、`ForwardingNode` 转发、多个写线程协作推进；计数也不是所有线程争抢一个全局整数，而是低竞争时改 `baseCount`，高竞争时分流到 `CounterCell`。**

## 3. 旧稿优点与问题

### 保留

- 已覆盖 `sizeCtl`、`helpTransfer`、`transferIndex`、`ForwardingNode`、`CounterCell` 与 `size()` 弱一致。
- 已把扩容期间读线程如何跟随转发表节点查找说出来。
- 已指出 CHM 与 `LongAdder` 的思路亲缘关系。

### 必须重写

- 旧稿还是“字段解释 + 机制罗列”，没有先建立两个核心失败场景：单线程独占扩容会拖垮并发写，全局计数器会形成热点争用。
- `sizeCtl` 需要讲成“协调旗”，而不是死背数值区间。
- `helpTransfer` / `transfer` 要讲成协作搬家流程：谁发起、谁加入、谁认领区间、谁宣告完成。
- `ForwardingNode` 需要回到上一篇的主线：它不是内部细节，而是读写线程在迁移期看到的桶状态信号。
- 计数部分要突出“为什么不只靠一个 size 字段”，而不是只记住 `baseCount/counterCells` 名字。

## 4. 理解路径

### 第一节：从两个最朴素但都会失效的方案开场

场景一：map 快满了，让一个线程独占扩容，其他线程都等它搬完；场景二：所有写线程都对同一个全局 `size` 做 CAS 累加。指出它们分别会在高并发下制造停顿和热点争用。

### 第二节：`sizeCtl` 为什么像一面协调旗，而不是普通阈值字段

证据：
- `ConcurrentHashMap.java:800`：`sizeCtl`
- `ConcurrentHashMap.java:2281-2299`：`initTable`
- `ConcurrentHashMap.java:1526`：初始化后设置 0.75 阈值
- `ConcurrentHashMap.java:2276-2277`：`resizeStamp`
- `ConcurrentHashMap.java:575-586`：`RESIZE_STAMP_BITS` / `RESIZE_STAMP_SHIFT`

主线：
- 正数时，它像阈值；`-1` 时，它像“初始化进行中”旗；小于 `-1` 时，它又编码了“扩容进行中 + 参与者信息”。
- CHM 不想再分散多个同步变量，而是把“谁能初始化、是否正在扩容、扩容协作代数”都收进一个协调入口。

### 第三节：扩容为什么要做成“写线程顺手帮忙搬家”

证据：
- `ConcurrentHashMap.java:2316-2347`：`addCount`
- `ConcurrentHashMap.java:2335-2346`：达到阈值后触发扩容或协助扩容
- `ConcurrentHashMap.java:2355-2366`：`helpTransfer`

主线：
- 写入完成后，`addCount` 负责检查总量是否逼近阈值。
- 一旦发现该扩容了，不是停下来让一个专职线程包办，而是允许当前线程发起或加入迁移。
- 这正是 CHM 延续上一篇思想的地方：把全局成本分摊给正在写入的参与者，而不是制造一个巨大的串行阶段。

### 第四节：`transferIndex` 如何把搬桶工作切成区间

证据：
- `ConcurrentHashMap.java:805`：`transferIndex`
- `ConcurrentHashMap.java:2416-2433`：`transfer` 初始化 `nextTable`、`transferIndex`
- `ConcurrentHashMap.java:2442+`：线程认领区间
- `ConcurrentHashMap.java:2418`：`stride` 与 `NCPU`

主线：
- 多线程协作扩容的第一难点不是“怎么搬”，而是“谁搬哪一段”。
- `transferIndex` 记录尚未认领的高位区间，线程通过 CAS 认领一段任务，而不是彼此从头扫到尾。
- `stride` 说明 CHM 连任务粒度都考虑了 CPU 数量，避免协作成本高过收益。

### 第五节：旧桶为什么要放 `ForwardingNode`

证据：
- `ConcurrentHashMap.java:2223-2244`：`ForwardingNode`
- `ConcurrentHashMap.java:2433`：构造 `ForwardingNode`
- `ConcurrentHashMap.java:2503-2505` / `2538-2540`：搬完后把旧桶置为 `fwd`

主线：
- 迁移不是“复制完再一次性切换世界”，因为读写线程可能同时经过旧表。
- 所以旧桶搬完后立刻写入 `ForwardingNode`，告诉后来线程：这里的真实数据已经转去 `nextTable`。
- 这让读线程和后续写线程不必阻塞，只要顺着转发表继续走即可。

### 第六节：扩容何时宣告完成，为什么不会永远协作下去

证据：
- `ConcurrentHashMap.java:2458-2460`：迁移结束后切换 `table` 和 `sizeCtl`
- `ConcurrentHashMap.java:2463-2464`：协作者退出条件
- `ConcurrentHashMap.java:2360-2363`：`helpTransfer` 停止协助条件

主线：
- 协作扩容不能只有“加入”，还得有“何时停”。
- 当区间认领耗尽、参与者计数达到结束条件后，最后收尾线程负责把 `nextTable` 提升为新 `table`，重算 `sizeCtl` 阈值。
- `ForwardingNode`、`nextTable`、`sizeCtl` 在这里一起完成“旧表退场、新表接管”。

### 第七节：为什么计数不能只靠一个 `size` 字段

证据：
- `ConcurrentHashMap.java:790`：`baseCount`
- `ConcurrentHashMap.java:815`：`counterCells`
- `ConcurrentHashMap.java:2555`：`CounterCell`
- `ConcurrentHashMap.java:2316-2332`：`addCount`
- `ConcurrentHashMap.java:2572+`：`fullAddCount`

主线：
- 单个全局计数器在高并发写入下会形成 CAS 热点，线程都在同一个内存位置上互撞。
- CHM 先尝试低成本的 `baseCount`；一旦竞争明显，再把线程打散到多个 `CounterCell`。
- 这和 `LongAdder` 的设计哲学一致：不是追求每次都修改同一个权威数字，而是先分摊争用，最后再汇总。

### 第八节：`size()` 为什么是弱一致

证据：
- `ConcurrentHashMap.java:909-910`：`size()` 调 `sumCount()`
- `ConcurrentHashMap.java:2167`：`mappingCount()`
- `ConcurrentHashMap.java:2560-2564`：`sumCount`

主线：
- `sumCount()` 做的是 `baseCount + ΣcounterCells`，但汇总时并不会冻结所有写线程。
- 因此 `size()` 更像“当前近似快照”，不是事务式精确计数。
- 这是 CHM 为吞吐量支付的代价：你换来了低争用更新，也接受了查询 size 的弱一致。

### 第九节：收网与下一篇钩子

- 收束成两条主线：扩容靠协作搬家，计数靠分片累加。
- 回到上一篇：`MOVED` 为什么会出现在写路径里，现在闭环了。
- 自然引到 `ConcurrentSkipListMap`：哈希并发解决了，无序结构讲完后，下一篇看“有序并发”为什么选跳表。

## 5. 失败方案清单

1. 让某个线程独占完成整个扩容过程，其他线程全部等待。
2. 让所有线程对同一个全局 `size` 字段做 CAS 累加。
3. 扩容时只把数据复制到新表，却不给旧桶留下转发标记。
4. 多个协作线程都从头扫描整张旧表，互相重复搬同一批桶。
5. 把 `sizeCtl` 当成单纯阈值字段，忽略它还承载初始化/扩容状态。
6. 把 `size()` 当成强一致实时精确值，在并发逻辑里据此做严格控制分支。
7. 以为遇到 `MOVED` 的线程只能等待，不能参与推进扩容。

## 6. 误解清单

1. CHM 扩容时会像 stop-the-world 一样冻结读写线程。
2. `sizeCtl` 负数只表示“出 bug 了”或“还没初始化完”。
3. `ForwardingNode` 只是内部占位，对读路径没有行为意义。
4. `transferIndex` 只是一个普通下标，不承担任务分片。
5. `CounterCell` 出现后，`baseCount` 就彻底没用了。
6. `size()` 不精确说明 CHM 的计数实现不可靠；实际这是吞吐量与一致性的设计取舍。
7. `LongAdder` 和 CHM 的计数方案只是名字像，本质无关。

## 7. 证据清单

- `ConcurrentHashMap.java:575-586`：`RESIZE_STAMP_BITS` / `RESIZE_STAMP_SHIFT`
- `ConcurrentHashMap.java:597`：`NCPU`
- `ConcurrentHashMap.java:783`：`nextTable`
- `ConcurrentHashMap.java:790`：`baseCount`
- `ConcurrentHashMap.java:800`：`sizeCtl`
- `ConcurrentHashMap.java:805`：`transferIndex`
- `ConcurrentHashMap.java:815`：`counterCells`
- `ConcurrentHashMap.java:909-910`：`size()`
- `ConcurrentHashMap.java:2167`：`mappingCount()`
- `ConcurrentHashMap.java:2223-2244`：`ForwardingNode`
- `ConcurrentHashMap.java:2276-2277`：`resizeStamp`
- `ConcurrentHashMap.java:2281-2299`：`initTable`
- `ConcurrentHashMap.java:2316-2347`：`addCount`
- `ConcurrentHashMap.java:2355-2366`：`helpTransfer`
- `ConcurrentHashMap.java:2416-2464`：`transfer`
- `ConcurrentHashMap.java:2555-2557`：`CounterCell`
- `ConcurrentHashMap.java:2560-2564`：`sumCount`
- `ConcurrentHashMap.java:2572+`：`fullAddCount`

## 8. 版本与边界

- 基于 JDK 11。
- 本文讨论的是 JDK 8+ 之后的 CHM 实现，不适用于 JDK 7 Segment 时代的扩容和计数方案。
- `size()`/`mappingCount()` 的弱一致描述是当前并发实现特征，不是所有 map 计数 API 的统一规范。
- `CounterCell` 与 `LongAdder` 思想同源，但本文不展开 `Striped64` 全部细节，只借它帮助理解“分片计数”的动机。
- 不把 `transfer` 的每个分支逐行穷尽，重点放在协作机制和状态流转上。

## 9. 删除代码测试与最终验收标准

- 删除代码块后，读者仍能复述“为什么单线程独占扩容不行 → `sizeCtl` 如何协调初始化/扩容 → `addCount` 如何触发并加入扩容 → `transferIndex` 如何分片搬桶 → `ForwardingNode` 如何把后来线程导向新表 → 为什么计数不能只靠一个全局 size → `size()` 为什么是弱一致”。
- 必须把扩容讲成协作协议，而不是单线程算法翻版。
- 必须把 `sizeCtl` 讲成协调旗，而不是背数值区间。
- 必须把 `CounterCell` 的存在理由讲清楚：分散 CAS 热点。
- 结尾要自然引到 `03-skiplist.md`：无序并发哈希讲完后，有序并发结构为什么换成跳表。
