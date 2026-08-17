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
- 关键设计: pre barrier 先检查 SATB active,再读取旧值;旧值非 null 才进入线程本地 SATB queue,buffer 满才走 runtime slow path。具体成本取决于 active/旧值/index 状态,不使用无源码依据的固定 cycles 数字
- ⚠️ 漂移修正: 大纲伪代码不存在;真实 C++ 入口是 `g1BarrierSet.inline.hpp:36-46`(decorator→RawAccess load→CompressedOops null filter→`enqueue`),`enqueue` 分 JavaThread 本地 queue/非 Java shared queue(g1BarrierSet.cpp:61-73);x86 快路径真实在 `g1BarrierSetAssembler_x86.cpp:142-203`(active/null/index 检查,非固定"12-15 instructions")

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
- 关键设计: post barrier 先过滤 young card,slow path 用 check-then-dirty 避免同一 card 重复入队;clean card 才写 dirty 并进入 JavaThread 本地 DirtyCardQueue/非 Java shared queue。具体成本取决于 card 状态与队列路径,不使用无源码依据的固定 cycles 数字
- ⚠️ 漂移修正: 大纲伪代码不存在;真实 inline 入口是 `g1BarrierSet.inline.hpp:48-55`(young card filter),slow path 是 `g1BarrierSet.cpp:99-114`(storeload→dirty check→enqueue);x86/C2 还会做同 Region/null/初始对象等优化,不能简化成固定 7-8 条指令

### 3. "C1/C2/Assembler 三层实现"

场景: 三种编译器为 G1 barrier 生成不同优化 level——C1(简单 copy), C2(aggressive eliminate redundant barriers), Assembler(手写汇编桩 for slow paths)。

**G1BarrierSetC1** (`gc/g1/c1/g1BarrierSetC1.cpp:40-200`):
- C1 在 LIR 层生成 active flag 检查、跨 Region/card 判断与 `G1PreBarrierStub`/`G1PostBarrierStub`(g1BarrierSetC1.cpp:51-176),runtime stub 最终由 `G1BarrierSetAssembler` 发射;不能概括成"简单直接 copy"
**G1BarrierSetC2** (`gc/g1/c2/g1BarrierSetC2.cpp:40-300`):
- C2 在 Ideal Graph 中生成 pre/post barrier,并可通过 `g1_can_remove_pre_barrier`(:86-172)证明新分配对象字段为 null来删除 pre,通过 `g1_can_remove_post_barrier`(:306-335)删除初始对象的 post;post 快路径还处理 null/young/same-region/card 状态
**G1BarrierSetAssembler** (`cpu/x86/gc/g1/g1BarrierSetAssembler_x86.cpp:142-245`):
- Slow paths(SATB buffer full / card already dirty / refinement needed)→hand-written assembly stub。入口: `generate_g1_pre_barrier_slow_path` + `generate_g1_post_barrier_slow_path`——仅当 buffer 满/card 原已 dirty 时调用

---

### 核心悬念

**"G1BarrierSet pre-barrier(SATB buffer,15-20 cycles) + post-barrier(dirty card,25-30 cycles) = ~40-50 cycles。C1/C2/Assembler 三层各自优化——C2 消除冗余 barrier。"** — 下一篇: Full GC + 辅助。

> → [07-full-gc-roots.md](07-full-gc-roots.md)
