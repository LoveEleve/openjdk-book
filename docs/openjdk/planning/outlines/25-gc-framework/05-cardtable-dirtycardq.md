# 05. 一次赋值在 GC 眼里怎么变成"脏卡片"？— CardTable + DirtyCardQueue

> 🔴 Deep | 5 KP 中的写屏障
> 读者处境: `obj.field = new_val`——如果 obj 在老年代、field 指向新生代对象。下次 young GC 只扫描新生代——必须知道老年代哪些 field 指向新生代。CardTable 解决了: 每次引用赋值→标记对应卡片为"脏"→GC 只 scan 脏卡片。

### 1. "card shift = 9 — 每 512 bytes 一个 card"
> ⚠️ 写作期修正(2026-08-15, vol-02/25-gc-framework/05 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **与 25-01 分工**: 卡表结构(card_shift=9/byte_for/store_check 汇编/CardValues)25-01 已详;本篇聚焦**标记之后的 DirtyCardQueue 与消费链**
> - **"CardTableRS — Remembered Set" 死代码(重要)**: CardTableRS 只被 GenCollectedHeap/cardGeneration 引用(cardGeneration.cpp:42、genCollectedHeap.cpp:133)——**G1-only 构建不适用**;G1 的 remembered set=region 级 RSet(G1RemSet),卡表只是索引入口;**mod_union_table 同死代码**
> - **"MOVNTI 非临时存储" 断言错**: store_check 是普通 movb(25-01 已实证);无 MOVNTI
> - **G1 卡值方言**: G1CardTable(g1CardTable.hpp:47)+g1_young_gen 值——年轻区卡默认 young,post barrier 跳过(25-01 已述);young 卡标记是并发的,写可能先于标 young 漏过滤(注释 g1RemSet.cpp:557-563,精炼时再查)

场景: 4GB heap→card table 大小 = 4GB/512 = 8MB。每张卡片 512 bytes 覆盖→标记粒度足够细到减少 false sharing。

**CardTable byte_map** (`cardTable.hpp:80-150 + cardTable.cpp:40-100`):
```cpp
class CardTable {
  jbyte* _byte_map;        // card table base
  size_t _byte_map_size;   // = heap_size >> card_shift (= 9)
  static const int card_shift = 9;   // 512 bytes
};
jbyte* byte_for(const void* p) {
  return _byte_map + ((uintptr_t)p >> card_shift);
}
// write barrier:
*byte_for(p) = dirty_card; // 1 mov instruction
```
- 源码: `cardTable.hpp:80-150` byte_map 分配 + `cardTable.cpp:40-100` card_shift 初始化
- 关键设计: card_shift=9(512 bytes)——balance: 4KB card→太多 false sharing(相邻存活对象间 obj.f=null 但 card 标记为脏), 64B→card table = 4GB/64=64MB→>L3 cache→非连续性访存→慢。512=2^9→shift(硬件中简单位移)优化 `p>>9` = `shr rsi,9`
- [x86: `shr rsi, 9; mov byte [rsi+card_table_base], 0`——两条指令投出 store。card table 用 MOVNTI(non-temporal store)→绕过 cache→直接写内存→cache 不被 evicted→后续读命中率高]

**CardTableRS — Remembered Set** (`cardTableRS.hpp:40-120 + cardTable.cpp:150-300`):
```
CardTableRS: 每 card 的 Remembered Set 实现
  - dirty_card 扫描范围: 该 card 的 object→检查其 oop field→标记跨代引用
  - mod_union_table: Union of "card was dirtied between young GCs"
  - 用于 G1 evacuation:仅扫描 dirty+young cards 找存活对象
```
- 源码: `cardTableRS.hpp:40-120` + `cardTable.cpp:150-300` dirty_card iteration
- 关键设计: CardTableModRefBS 的 write_ref_field 微优化——`*card_addr = dirty` + check existing value→if already dirty→skip enqueue→避免重复 queue

### 2. "DirtyCardQueue — 批处理脏卡片"
> ⚠️ 写作期修正(2026-08-15, vol-02/25-gc-framework/05 已按真实源码成文):
> - **文件位置错**: ptrQueue.*/dirtyCardQueue.* 在 **share/gc/g1/**(大纲 gc/shared 错);SATBMarkQueue(satbMarkQueue.hpp:45)同套机制另一实例(G1SATBBufferSize=1K vs G1UpdateBufferSize=256)
> - **入队动作(大纲漏)**: write_ref_field_post_slow(g1BarrierSet.cpp:99-114): storeload fence→非 dirty 才标→Java 线程入 G1ThreadLocalData::dirty_card_queue/非 Java 线程 Shared_DirtyCardQ_lock 共享队列——入队的是**卡字节地址 jbyte\***
> - **PtrQueue 机制**: _active(:49)/_index 字节索引从容量递减(:56-59)/_capacity_in_bytes/_buf(:92);enqueue :141-144(不活跃直接返回)→enqueue_known_active(ptrQueue.cpp:64-74: while(_index==0) handle_zero_index→_index-=8→_buf[index()]=ptr);buffer=G1UpdateBufferSize=256(dirtyCardQueue.cpp:161);PtrQueueSet 满处理(free list 优先 :127-142)
> - **"enqueue 在 L1 miss 时约 20 cycles" 无据删**;**"swap 用 CAS 替换 buffer 指针" 错**(buffer 转移在 handle_zero_index 内,锁在 _cbl_mon/_fl_lock)
> - **消费链(大纲漏,重要)**: 并发精炼=G1ConcurrentRefine::do_refinement_step(g1ConcurrentRefine.cpp:429-446,yellow zone 判断)→refine_completed_buffer_concurrently(dirtyCardQueue.cpp:249-252,G1RefineCardConcurrentlyClosure :43-53)→apply_closure_to_completed_buffer(:259-280: get_completed_buffer _cbl_mon :226-247→逐卡→全处理 deallocate/部分放回 :274-277);**refine_card_concurrently 语义**(g1RemSet.cpp:539-634): 非 dirty 返回→region 非 old/humongous 忽略→**HCC 热卡缓存拦截(命中入缓存不精炼,满驱逐旧卡 :587-607)**→卡裁剪到 region top→**清卡 :631 后扫描引用登记 RSet**;Update RS 接力(refine_card_during_gc :673,登记指向 CSet 引用;update_rem_set :477-499)
> - 线程: "G1 Refine#%d"(g1ConcurrentRefineThread.cpp:55);G1ConcRefinementThreads ergonomic
> - **悬念指向** ✓(06-oopstorage;06 标题="字符串去重和 GC 统计 — OopStorage + StringDedup + GC Stats")

场景: G1 每个线程有一个 DirtyCardQueue——write barrier 把脏卡片 buffer 到 queue→queue 满时批次 handle(G1 refine buffer)。

**DirtyCardQueue + PtrQueue** (`dirtyCardQueue.hpp:30-100 + ptrQueue.hpp:40-120`):
```
PtrQueue (基类):
  void** _buf;         // 当前 buffer
  size_t _index;       // 当前 index (递减——同 Java stack)
  void enqueue(void* ptr); // 存 ptr→填充时 swap buffer

DirtyCardQueue:
  void handle_completed_buffer(); // 处理满的 buffer
  DirtyCardQueueSet* _qset;       // global queue set
```
- 源码: `ptrQueue.hpp:40-120` enqueue 逻辑 + `dirtyCardQueue.hpp:30-100` DCQ
- 关键设计: buffer大小=256 cards→cover 128KB heap。enqueue 在 L1 miss 时约 20 cycles(store forwarding)。满时→swap to global DirtyCardQueueSet→G1 ConcurrentRefineThread pickup→process buffer→扫描每 card 的 field 找跨代引用
- [C++: PtrQueue enqueue = `_buf[_index--] = ptr; if (UNLIKELY(_index < 0)) handle_full_buffer()`——fast path 是单 store——全 inline。swap 用 CAS 替换 buffer 指针→避免 double-enqueue]

---

### 核心悬念

**"CardTable 用 512 bytes/card 标记脏区域——write barrier 是 1 mov instruction。DirtyCardQueue 批次收集→GC concurrent refinement 处理。"** — 但字符串去重和 GC 统计怎么工作？下一篇: OopStorage + StringDedup + GC Stats。
> → [06-oopstorage-stringdedup-stats.md](06-oopstorage-stringdedup-stats.md)
