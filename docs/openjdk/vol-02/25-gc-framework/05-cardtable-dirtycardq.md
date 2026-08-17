# 05. 一次赋值在 GC 眼里怎么变成"脏卡片"？— CardTable + DirtyCardQueue

> **前置依赖**:[25-gc-framework/01 — GC 怎么在每次 oop 访问时悄悄插入 barrier？— BarrierSet + Access API](openjdk/vol-02/25-gc-framework/01-barrier-access.md):卡表结构(512B/卡、`byte_for`、store_check 汇编)与 barrier 注入已拆,本篇讲卡片**标记之后**的故事;[25-gc-framework/04 — 4 个 GC worker 怎么平分扫描任务？— WorkGang + TaskQueue](openjdk/vol-02/25-gc-framework/04-workgang-taskqueue.md):消费脏卡的并发精炼线程与 Update RS 并行阶段;[25-gc-framework/03 — SoftReference 什么时候被清除？— Reference Processing](openjdk/vol-02/25-gc-framework/03-reference-processing.md):卡表与引用发现同属"GC 看见对象图变化"的机制
> → **后续**:[25-gc-framework/06 — 字符串去重和 GC 统计 — OopStorage + StringDedup + GC Stats](openjdk/vol-02/25-gc-framework/06-oopstorage-stringdedup-stats.md)
> 关联域: 25-01(卡表结构)、25-04(并行消费)、17-threads(精炼线程)

## 标记之后的故事

`obj.field = new_val` 的写屏障把对象所在卡标成 dirty(25-01 篇的 `shr 9 + movb 0`)——但这只是**半程**:脏卡要被记住、被收集、最终被 GC 消费,老年代→新生代的跨代引用才真正进入 remembered set。本篇讲卡片的"下半生": 线程本地的 `DirtyCardQueue` 怎么积累脏卡、满了怎么办、`G1 Refine` 线程怎么并发消化、年轻代 GC 的 Update RS 又怎么接力。

## 1. 卡表回顾 — 从"结构"到"语义"

25-01 已拆卡表结构(card_shift=9、`byte_for`、store_check 汇编)。本篇从 GC 语义补两块:

- **G1 的卡值方言**: `G1CardTable`(g1CardTable.hpp:47)在通用 CardValues(clean=-1/dirty=0)之上加 `g1_young_gen` 值——**年轻代区域内的卡默认就是 young 值**,写 Eden 对象不产生"需扫描的脏卡"(年轻代内部引用由 GC 整体处理),post barrier 遇到 young 卡直接跳过(25-01 已述);
- **大纲的"CardTableRS/ModUnionTable"是死代码**: CardTableRS 只被 `GenCollectedHeap`/`cardGeneration` 引用(cardGeneration.cpp:42、genCollectedHeap.cpp:133)——**G1-only 构建不适用**;G1 的 remembered set 是 region 级 RSet(G1RemSet),卡表只是 RSet 的"索引入口"。大纲的 x86 "MOVNTI 非临时存储" 也是断言错误——25-01 已实证 store_check 是普通 `movb`。

## 2. DirtyCardQueue — 线程本地的脏卡积累

写屏障标记卡之后,**卡字节的地址(`jbyte*`)**进入**线程本地的 PtrQueue**(基类在 g1/ptrQueue.hpp:37+;DirtyCardQueue 是子类,dirtyCardQueue.hpp:46+,注释 "A ptrQueue whose elements are 'oops', pointers to object heads")——入队动作在 `write_ref_field_post_slow`(g1BarrierSet.cpp:99-114): Java 线程入 `G1ThreadLocalData::dirty_card_queue(thr)`,非 Java 线程在 `Shared_DirtyCardQ_lock` 下入共享队列(:110-115):

```cpp
// ptrQueue.cpp:64-74(截取核心,逐字)
void PtrQueue::enqueue_known_active(void* ptr) {
  while (_index == 0) {
    handle_zero_index();
  }

  assert(_buf != NULL, "postcondition");
  assert(index() > 0, "postcondition");
  assert(index() <= capacity(), "invariant");
  _index -= _element_size;
  _buf[index()] = ptr;
}
```

*关键设计: **一次递减 + 一次写入,只有 buffer 用尽才走慢路径**。`_index` 是字节索引,从 buffer 容量往下数(ptrQueue.hpp:56-59,"Starts at capacity_in_bytes (indicating an empty buffer) and goes towards zero");`_active` 开关让队列可整体静默(:141-144)。buffer 默认 **256 个条目**(`G1UpdateBufferSize=256`,dirtyCardQueue.cpp:161 设置)——满 256 张卡触发 `handle_zero_index`: 整块 buffer 交 `PtrQueueSet`(完整队列集合),线程换一块新 buffer(或复用 free list,ptrQueue.cpp:127-142)。*

**注意命名**: PtrQueue 在 **share/gc/g1/**(G1 专属;大纲说 gc/shared 错);SATB 队列(SATBMarkQueue,25-01 的 pre barrier 用)与 DirtyCardQueue 是**同一套 PtrQueue 机制的两个实例**(buffer 大小不同: G1SATBBufferSize=1K vs G1UpdateBufferSize=256)。

## 3. 消费链 — 并发精炼与 Update RS

脏卡 buffer 被收集到 `DirtyCardQueueSet` 的 completed buffers 链后,两条消费路径:

### 3.1 并发精炼(G1 Refine 线程)

**"G1 Refine#N" 线程**(g1ConcurrentRefineThread.cpp:55 命名;数量 `G1ConcRefinementThreads`)在 GC 之外消化脏卡——`G1ConcurrentRefine::do_refinement_step`(g1ConcurrentRefine.cpp:429-446): 检查 completed buffer 数量与 yellow zone,然后:

```cpp
// dirtyCardQueue.cpp:249-252(截取核心,逐字)
bool DirtyCardQueueSet::refine_completed_buffer_concurrently(uint worker_i, size_t stop_at) {
  G1RefineCardConcurrentlyClosure cl;
  return apply_closure_to_completed_buffer(&cl, worker_i, stop_at, false);
}
```

`apply_closure_to_completed_buffer`(:259-280)取一个 buffer(`get_completed_buffer` 在 `_cbl_mon` 下出队,:226-247)→ 逐卡应用 closure——`G1RefineCardConcurrentlyClosure`(dirtyCardQueue.cpp:43-53)转调 `refine_card_concurrently`(g1RemSet.cpp:539+): **先清卡、再扫描卡内对象的引用,把被引用 region 记录进来源 region 的 RSet**(老区引用新区被实时登记);young/空闲 region 的卡忽略(:574-576),卡范围裁剪到 region 的分配顶(:609-626)。整块处理完释放,处理一半放回队列(:274-277)。**热卡还有缓存**: `G1HotCardCache`(g1HotCardCache.hpp:56+)收纳"刚精炼过又立刻再写"的卡——命中缓存的卡不再立即精炼,缓存满时驱逐旧卡补处理(:587-607),避免同一张卡被反复扫描。

### 3.2 Update RS(GC 期间接力)

年轻代 GC 时,剩余脏卡由 **Update RS 阶段**处理(g1RemSet.cpp:477-499): `iterate_dirty_card_closure`(:495)把每个 completed buffer 逐卡交给 `G1RefineCardClosure`(:444-475,`do_card_ptr` → `refine_card_during_gc`)——**扫描卡内对象,把指向 Collection Set 的引用登记进 RSet**,为随后的 Scan RS 做准备。**[实证](openjdk/planning/outlines/00-jvm-tools/materials/commands/25-gc-cardqueue-demo.txt)**: gc+phases 里 Update RS 的 `Processed Buffers`(素材 B)就是这个消费过程的直接读数;`gc+refine=debug` 标签可看精炼线程启停(素材 A)。

## 核心悬念

脏卡的旅程封好了: **标记**(store_check 写 0,25-01)、**积累**(PtrQueue 递减索引 + 256 条目 buffer,满则整块上缴)、**并发消化**(G1 Refine 线程逐卡扫引用登记 RSet,Hot Card Cache 拦热卡)、**GC 接力**(Update RS 在暂停中清尾)。至此 GC 框架的"看见对象图变化"机制全部到齐——剩下的是 GC 的**辅助设施**: 字符串去重怎么省内存、GC 统计/日志怎么记录一次暂停。下一篇: OopStorage + StringDedup + GC Stats。

> → [25-gc-framework/06 — 字符串去重和 GC 统计 — OopStorage + StringDedup + GC Stats](openjdk/vol-02/25-gc-framework/06-oopstorage-stringdedup-stats.md)
