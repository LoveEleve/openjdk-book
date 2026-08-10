# 05. 一次赋值在 GC 眼里怎么变成"脏卡片"？— CardTable + DirtyCardQueue

> 🔴 Deep | 5 KP 中的写屏障
> 读者处境: `obj.field = new_val`——如果 obj 在老年代、field 指向新生代对象。下次 young GC 只扫描新生代——必须知道老年代哪些 field 指向新生代。CardTable 解决了: 每次引用赋值→标记对应卡片为"脏"→GC 只 scan 脏卡片。

### 1. "card shift = 9 — 每 512 bytes 一个 card"

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
