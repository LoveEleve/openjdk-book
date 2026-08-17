# 06. G1 的写屏障为什么最重？— G1BarrierSet Pre/Post Barrier

> **前置依赖**:[26-g1-gc/02 — 应用还在跑——你怎么知道谁活着？— 并发标记 + SATB](02-concurrent-marking.md):pre-write barrier 把旧引用送进 SATB;[26-g1-gc/03 — Region A 里谁引用了 Region B？— RSet + CardTable 并发细化](03-rem-set.md):post-write barrier 把 card 送进 DirtyCardQueue 并最终更新 RSet;[25-gc-framework/01 — GC 怎么在每次 oop 访问时悄悄插入 barrier？— BarrierSet + Access API](openjdk/vol-02/25-gc-framework/01-barrier-access.md):Access API 与 BarrierSet 分派层
> → **后续**:[26-g1-gc/07 — Full GC + 根处理](07-full-gc-roots.md)
> 关联域: 15-c2(C2 barrier 优化)、14-c1(C1 LIR barrier)、25-gc-framework(CardTable/DirtyCardQueue)

G1 的一次引用写入,不是简单的 `*field = new_value`。它可能同时需要两道屏障:

- **pre-write barrier**:写之前读取旧值,并发标记活跃时把旧值送进 SATB;
- **post-write barrier**:写之后把来源 card 标脏,让 RSet/refinement 知道这张 card 需要扫描。

大纲把这两道屏障写成了“40-50 cycles”的固定成本,又把 inline 代码简化成了不存在的变量名。真实实现更准确的描述是:**C1/C2 在编译期生成判断与快路径,x86 assembler 负责慢路径;具体成本取决于 SATB 是否 active、card 是否已 dirty、队列是否耗尽以及编译器能否证明屏障可省略。**

---

## 1. pre barrier — 写之前保存旧值

### C++ 入口不是一段独立的“enqueue 伪代码”

`G1BarrierSet` 的 pre barrier 声明在 g1BarrierSet.hpp:49-60,inline 实现在 g1BarrierSet.inline.hpp:36-46:它检查 decorator,读取字段旧值,非 null 时调用 `enqueue`。`enqueue` 的实际线程分流在 g1BarrierSet.cpp:61-73:

```cpp
// g1BarrierSet.cpp:61-73(截取核心,逐字)
void G1BarrierSet::enqueue(oop pre_val) {
  // Nulls should have been already filtered.
  assert(oopDesc::is_oop(pre_val, true), "Error");

  if (!_satb_mark_queue_set.is_active()) return;
  Thread* thr = Thread::current();
  if (thr->is_Java_thread()) {
    G1ThreadLocalData::satb_mark_queue(thr).enqueue(pre_val);
  } else {
    MutexLockerEx x(Shared_SATB_Q_lock, Mutex::_no_safepoint_check_flag);
    _satb_mark_queue_set.shared_satb_queue()->enqueue(pre_val);
  }
}
```

它有三个关键门控:

1. SATB 不 active,直接 return;
2. JavaThread 写自己的 thread-local SATB queue;
3. 非 Java 线程进 shared SATB queue,并持 `Shared_SATB_Q_lock`。

所以“pre barrier 的成本固定”不准确:大多数非标记时期只走 active 检查,只有 SATB active 且旧值非 null 时才继续入队。

### SATB queue 是 PtrQueue 的专用实例

`satbMarkQueue.hpp:44-64` 定义 `SATBMarkQueue : public PtrQueue`。队列里存的是可能已经 stale 的 object head 指针,不是 card 地址。buffer 未满时由编译器生成 inline 写入;满了才进入 runtime slow path,这和 25-05 的 DirtyCardQueue 是同一套 PtrQueue 机制的两个实例。

---

## 2. post barrier — 写之后标记 card

### 快路径先过滤 young card

真实的 post barrier inline 入口(g1BarrierSet.inline.hpp:48-55):

```cpp
// g1BarrierSet.inline.hpp:48-55(截取核心,逐字)
template <DecoratorSet decorators, typename T>
inline void G1BarrierSet::write_ref_field_post(T* field, oop new_val) {
  volatile jbyte* byte = _card_table->byte_for(field);
  if (*byte != G1CardTable::g1_young_card_val()) {
    // Take a slow path for cards in old
    write_ref_field_post_slow(byte);
  }
}
```

这里还没有直接把 card 设为 dirty。第一层过滤是:如果来源 field 位于 young card,直接跳过 slow path。Young Region 在 GC 时整体处理,不需要每次内部引用更新都进入老年代式的 RSet 记账。

### slow path 才做 dirty + enqueue

`write_ref_field_post_slow`(g1BarrierSet.cpp:99-114):

```cpp
// g1BarrierSet.cpp:99-114(截取核心,逐字)
void G1BarrierSet::write_ref_field_post_slow(volatile jbyte* byte) {
  // In the slow path, we know a card is not young
  assert(*byte != G1CardTable::g1_young_card_val(), "slow path invoked without filtering");
  OrderAccess::storeload();
  if (*byte != G1CardTable::dirty_card_val()) {
    *byte = G1CardTable::dirty_card_val();
    Thread* thr = Thread::current();
    if (thr->is_Java_thread()) {
      G1ThreadLocalData::dirty_card_queue(thr).enqueue(byte);
    } else {
      MutexLockerEx x(Shared_DirtyCardQ_lock,
                      Mutex::_no_safepoint_check_flag);
      _dirty_card_queue_set.shared_dirty_card_queue()->enqueue(byte);
    }
  }
}
```

post barrier 的真实动作是:

1. `storeload` 保证 card 状态与之前的 store 有顺序关系;
2. card 不是 dirty 才写 dirty;
3. JavaThread 进入本地 DirtyCardQueue,非 Java 线程进入 shared queue;
4. 已经 dirty 的 card 不重复 enqueue。

这就是重复写同一 card 时能省掉大量工作的原因,但不能直接把它换算成固定的“25-30 cycles”:干净 card、已脏 card、队列满、非 Java 线程的路径完全不同。

---

## 3. C1 — LIR 层生成两类 barrier stub

### C1 pre barrier:先读 SATB active flag

`G1BarrierSetC1::pre_barrier`(gc/g1/c1/g1BarrierSetC1.cpp:51-108)在 LIR 层生成 SATB active 检查,必要时创建 `G1PreBarrierStub`。post barrier 则在 :110-176 生成 card 跨 Region 判断并创建 `G1PostBarrierStub`。

```cpp
// g1BarrierSetC1.cpp:51-108(截取核心,逐字)
void G1BarrierSetC1::pre_barrier(LIRAccess& access, LIR_Opr addr_opr,
                                 LIR_Opr pre_val, CodeEmitInfo* info) {
  LIRGenerator* gen = access.gen();
  DecoratorSet decorators = access.decorators();

  // First we test whether marking is in progress.
  BasicType flag_type;
  bool patch = (decorators & C1_NEEDS_PATCHING) != 0;
  bool do_load = pre_val == LIR_OprFact::illegalOpr;
...
  LIR_Opr flag_val = gen->new_register(T_INT);
  __ load(mark_active_flag_addr, flag_val);
  __ cmp(lir_cond_notEqual, flag_val, LIR_OprFact::intConst(0));
...
  __ branch(lir_cond_notEqual, T_INT, slow);
  __ branch_destination(slow->continuation());
}
```

C1 不是“简单 copy pre+post”。它已经在 LIR 层做了 active flag 分支、地址/旧值准备,把队列满等慢路径留给 runtime stub。

### C1 post barrier:先判断来源与目标是否跨 Region

C1 的 post barrier 用地址与新值做 XOR,右移 `HeapRegion::LogOfHRGrainBytes`,结果为 0 表示同 Region,可以跳过 card mark。这比“每次写都标卡”更精确。

---

## 4. C2 — 在 Ideal Graph 中证明屏障可以删除

### pre barrier 可因新对象初始化而删除

`G1BarrierSetC2::g1_can_remove_pre_barrier`(g1BarrierSetC2.cpp:86-172)会沿 memory chain 检查:

- 地址是否能精确分解出 base + offset;
- base 是否来自一个 AllocateNode;
- 中间是否出现同一 field 的旧 store;
- 初始化是否仍然写入 null。

如果能证明对象刚分配、该字段此前没有非 null 旧值,C2 就可以删除 pre barrier。源码注释说得很明确:新分配对象的字段初始为 null,没有必要把 null 送进 SATB。

```cpp
// g1BarrierSetC2.cpp:86-103(截取核心,逐字)
bool G1BarrierSetC2::g1_can_remove_pre_barrier(GraphKit* kit,
                                               PhaseTransform* phase,
                                               Node* adr,
                                               BasicType bt,
                                               uint adr_idx) const {
  intptr_t offset = 0;
  Node* base = AddPNode::Ideal_base_and_offset(adr, phase, offset);
  AllocateNode* alloc = AllocateNode::Ideal_allocation(base, phase);

  if (offset == Type::OffsetBot) {
    return false; // cannot unalias unless there are precise offsets
  }

  if (alloc == NULL) {
    return false; // No allocation found
  }

  intptr_t size_in_bytes = type2aelembytes(bt);
```

这不是运行时“重复 barrier 消除”,而是 C2 在编译期基于内存图证明屏障无必要。大纲把“C2 eliminates redundant pre-barrier”说得太泛,实际核心是**新分配对象 + 字段初始化状态可证明**。

### C2 post barrier 也能删除,但条件不同

`g1_can_remove_post_barrier`(g1BarrierSetC2.cpp:306-335)要求 store 的对象来自同一个 AllocateNode,并且 store 紧跟初始化路径。`post_barrier`(g1BarrierSetC2.cpp:372-466)还会过滤:

- 写入常量 null;
- 新分配 Eden 对象且 `ReduceInitialCardMarks` 开启;
- 能证明 store 与初始化关联。

C2 的 post barrier 不是“生成一个 PostBarrierStub 就结束”。它会把 card 地址算出来,判断是否跨 Region,判断 card 状态,再走 inline card mark 或 runtime leaf call。

---

## 5. x86 assembler — 慢路径才真正 call runtime

`G1BarrierSetAssembler::g1_write_barrier_pre`(cpu/x86/gc/g1/g1BarrierSetAssembler_x86.cpp:142-245)展示了 pre barrier 的机器级流程:

1. 读 thread-local SATB active flag;
2. 不是 active 就跳 done;
3. 读取旧值,旧值为 null 就跳 done;
4. 读取 SATB index,非 0 就在本地 buffer 写入旧值并递减 index;
5. index 为 0 才保存寄存器并 call `G1BarrierSetRuntime::write_ref_field_pre_entry`。

因此慢路径不是每次写入都会调用。常态是 inline 的 flag/null/index 判断;只有 SATB buffer 满才进入 runtime stub。

C1 的 `G1PreBarrierStub`/`G1PostBarrierStub` 最终也通过 `G1BarrierSetAssembler` 生成对应 runtime stub(g1BarrierSetC1.cpp:41-49,202-224)。所以“C1/C2/Assembler 三层”不是三套互相独立的 barrier,而是:

- C1/C2 生成编译器 IR/LIR;
- assembler 统一把 stub 变成平台机器码;
- runtime slow path 负责队列补充和异常路径。

---

## 核心悬念

**G1BarrierSet 的两道屏障并不是固定成本黑盒:** pre barrier 在 SATB active、旧值非 null、buffer 未满/已满时分别走不同路径;post barrier 先过滤 young card、同 Region、null 和 dirty card;C1/C2 还能在编译期证明初始化场景并删除屏障。剩下的最后问题是:这些路径都失败或无法继续时,G1 如何触发 Full GC,以及 Full GC 如何扫描根并压缩整个堆。**下一篇看 Full GC + 根处理。

> → [07-full-gc-roots.md](07-full-gc-roots.md)
