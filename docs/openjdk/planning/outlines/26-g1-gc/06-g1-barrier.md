# 06. G1 的写屏障为什么最重？— G1BarrierSet Pre/Post Barrier

> 🔴 Deep | 5 KP 中的 Barrier 实现
> 读者处境: G1 的写屏障是所有 GC 中最重的(40-50 cycles)——因为它有两个 barrier: pre(SATB buffer 保存旧值) + post(dirty card 标记)。两个 barrier 在 Access API 中全 inline——通过 C1/C2/Assembler 三层生成代码。

### 1. "pre-write barrier — 保存旧值"

场景: `obj.field = new_val`——pre-barrier 在修改前抓取 `obj.field` 的旧值。如果并发标记活跃→旧值必须保存到 SATB buffer——标记线程可能还没有 trace 这个旧值→若直接覆盖→标记线程错过旧值→丢失存活对象。

**g1_write_barrier_pre** (`g1BarrierSet.inline.hpp:40-80`):
```cpp
void G1BarrierSet::write_ref_field_pre(T* field, oop new_val) {
  if (SATB_active) { // concurrent marking ON?
    T heap_oop = RawAccess<>::oop_load(field); // old value
    if (!CompressedOops::is_null(heap_oop)) {
      _satb_mark_queue.enqueue(heap_oop); // push to SATB
    }
  }
}
```
- 源码: `g1BarrierSet.inline.hpp:40-80` + `satbMarkQueue.hpp:40-120` enqueue
- 关键设计: full barrier cost~15-20 cycles——C2 可优化。若连续写同一 field→C2 eliminates redundant pre-barrier(第一次保存→第二次 field 还没变→pre-barrier 被 skip)。如果 SATB 不活跃→barrier 是 single cmp+jump→~2 cycles
- [x86: C2 内联: `cmpl [SATB_active],0; je skip; mov rdi,[field_addr]; test rdi,rdi; jz skip; mov [queue_buffer+rsi*8],rdi; add rsi,1; test rsi,63; jz slow_path`——全 inline ~12-15 instructions]

### 2. "post-write barrier — 标记脏卡片"

场景: 存储完成后——post-barrier 标记 card dirty——通知 RS 的 concurrent refinement 线程"这张 card 需要被 RS 扫描"。

**g1_write_barrier_post** (`g1BarrierSet.inline.hpp:100-150 + g1CardTable.hpp:40-80`):
```cpp
void G1BarrierSet::write_ref_field_post(T* field) {
  volatile jbyte* card_addr = _g1_card_table->byte_for(field);
  if (*card_addr != dirty_card) { // already dirty?—skip
    *card_addr = dirty_card;       // mark dirty — 1 mov
    _dcqs.enqueue(card_addr);      // enqueue to DirtyCardQueue
  }
}
```
- 源码: `g1BarrierSet.inline.hpp:100-150` + `g1CardTable.hpp:40-80`
- 关键设计: check-then-dirty 避免 repeated enqueue(for same card)——card 已在 queue 中→refinement thread processing→2nd write to same card→check sees dirty→skip enqueue。cost~25-30 cycles for clean card, ~10 cycles for already dirty card
- [x86: post-barrier inline: `shr field,9; add field,card_table_base; cmpb [field],0; je skip; mov byte[field],0; call enqueue_card`——7-8 instructions]

### 3. "C1/C2/Assembler 三层实现"

场景: 三种编译器为 G1 barrier 生成不同优化 level——C1(简单 copy), C2(aggressive eliminate redundant barriers), Assembler(手写汇编桩 for slow paths)。

**G1BarrierSetC1** (`gc/g1/c1/g1BarrierSetC1.cpp:40-200`):
- C1 generates `LIR_OpG1Barrier` custom LIR nodes→codegen→x86 instructions。C1 不做 barrier optimization(简单直接 copy pre+post)
**G1BarrierSetC2** (`gc/g1/c2/g1BarrierSetC2.cpp:40-300`):
- C2 IDEAL graph: `G1PreBarrierStub + G1PostBarrierStub` nodes→full C2 optimization can eliminate redundant barriers。Late-inline expansion 结合 register allocation→minimal instruction count
**G1BarrierSetAssembler** (`cpu/x86/gc/g1/g1BarrierSetAssembler_x86.cpp:40-250`):
- Slow paths(SATB buffer full / card already dirty / refinement needed)→hand-written assembly stub。入口: `generate_g1_pre_barrier_slow_path` + `generate_g1_post_barrier_slow_path`——仅当 buffer 满/card 原已 dirty 时调用

---

### 核心悬念

**"G1BarrierSet pre-barrier(SATB buffer,15-20 cycles) + post-barrier(dirty card,25-30 cycles) = ~40-50 cycles。C1/C2/Assembler 三层各自优化——C2 消除冗余 barrier。"** — 下一篇: Full GC + 辅助。

> → [07-full-gc-roots.md](07-full-gc-roots.md)
