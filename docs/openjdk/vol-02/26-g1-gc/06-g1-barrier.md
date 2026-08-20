# 06. G1 的写屏障为什么最重？— G1BarrierSet Pre/Post Barrier

> **前置依赖**:[26-g1-gc/02 — 应用还在跑——你怎么知道谁活着？— 并发标记 + SATB](02-concurrent-marking.md):pre-write barrier 把旧引用送进 SATB;[26-g1-gc/03 — Region A 里谁引用了 Region B？— RSet + CardTable 并发细化](03-rem-set.md):post-write barrier 把 card 送进 DirtyCardQueue 并最终更新 RSet;[25-gc-framework/01 — GC 怎么在每次 oop 访问时悄悄插入 barrier？— BarrierSet + Access API](openjdk/vol-02/25-gc-framework/01-barrier-access.md):Access API 与 BarrierSet 分派层
> → **后续**:[26-g1-gc/07 — Full GC + 根处理](07-full-gc-roots.md)
> 关联域: 15-c2(C2 barrier 优化)、14-c1(C1 LIR barrier)、25-gc-framework(CardTable/DirtyCardQueue)

G1 的一次引用写入,不是简单的 `*field = new_value`。它可能同时需要两道屏障:

- **pre-write barrier**:写之前读取旧值,并发标记活跃时把旧值送进 SATB;
- **post-write barrier**:写之后把来源 card 标脏,让 RSet/refinement 知道这张 card 需要扫描。

按常识,这似乎让 G1 的每次引用写入都背上两遍额外成本——"G1 的写屏障最重"的说法就来自这里。但这一篇要回答的是:**为什么必须有两道、而不是一道?以及"最重"在多数路径上到底成不成立?**

先说结论,再拆底层:两道屏障解决的是两个不同方向的问题,不能合并;而它们各自都先用快路径过滤,真正走完全部路径的写操作只占一小部分。C1/C2/Assembler 三层也并不是三层独立实现,而是同一套屏障在不同层做了不同的代码生成。

---

## 1. 为什么需要两道屏障,而不是一道

要回答"能不能合并",得先看两个问题在时间线上的方向:

**pre barrier 发生在写之前,保护的是"将要被覆盖的旧值"。** G1 并发标记采纳的是"旧世界快照"协议(SATB,02 篇):标记开始时对象图长什么样,标记就按那个样子算。如果应用把 `a.field` 从指向 `X` 改成指向 `Y`,而标记线程还没扫过 `X`,那么 `X` 就可能永久漏掉——因为它唯一的入边 `a.field` 已经被覆盖。所以写之前必须把旧值 `X` 记下来。

**post barrier 发生在写之后,记录的是"新值落在了哪张卡"。** 03 篇讲过:GC pause 要收某个 Region 时,必须先知道"谁可能引用了它"。跨 Region 引用发生后,来源 field 所在卡必须标脏,然后精炼进目标 Region 的 RSet。

两个问题的方向完全不同:一个是对着旧世界读,一个是对着新世界写。如果只做 post barrier,旧值 `X` 会丢;如果只做 pre barrier,新产生的跨 Region 引用不会被记录。**它们各保各的,缺一个 G1 就可能既丢对象又丢入边。** 一张屏障无法同时处理"写之前的旧值"和"写之后的新卡"——因为它只有写前后两个时间点,而两个问题恰恰各占一个。

那"重重叠加"是不是必然?不是。往下看每一道屏障的门控,绝大多数写操作根本走不到深路径。

---

## 2. 两个朴素方案为什么都不对

### 方案一:把 SATB 和 card mark 合并成一道屏障

想"省一道屏障",常见思路是:反正都是写屏障,一起干。但如第一节所述,pre 和 post 一个在 store 之前、一个在 store 之后,关心的是一个时点的旧状态、一个时点之后的新状态。合在一起的结果必然是:要么丢了旧值(标志没记下就覆盖了),要么漏了入边(跨 Region 的新引用没人记录)。**这是两个正交的需求,合并是伪优化。**

### 方案二:每次写都走完整的 runtime 流程

反过来的极端是"反正要收就都收,每次都老老实实入队/标脏"。这保证正确,但 C1/C2/解释器为每个写点生成的都是固定高成本,写操作又是最热的热点。G1 的真实做法恰是相反的:**把最贵的路径挪到最不常走的角落**——用若干个平价条件(decorator 门控/flag 状态/null 检查)在前头过滤,只有全部条件都命中才付大代价。

所以正确的问题不是"G1 写屏障贵不贵",而是"**什么条件下才会贵**"。下面的门控就是答案。

---

## 3. pre barrier —— 保护旧值不丢,但大多数时候直接返回

### 入口:decorator 已经替它挡掉不少

`G1BarrierSet::write_ref_field_pre` 的 inline 入口(g1BarrierSet.inline.hpp:36-46):

```cpp
// g1BarrierSet.inline.hpp:36-46(截取核心,逐字)
template <DecoratorSet decorators, typename T>
inline void G1BarrierSet::write_ref_field_pre(T* field) {
  if (HasDecorator<decorators, IS_DEST_UNINITIALIZED>::value ||
      HasDecorator<decorators, AS_NO_KEEPALIVE>::value) {
    return;
  }

  T heap_oop = RawAccess<MO_VOLATILE>::oop_load(field);
  if (!CompressedOops::is_null(heap_oop)) {
    enqueue(CompressedOops::decode_not_null(heap_oop));
  }
}
```

它一进来先看两个 decorator:

- `IS_DEST_UNINITIALIZED`:断言目标是未初始化内存(比如刚 new 出来的对象字段),旧值必然是 null 或 garbage,不需要 SATB;
- `AS_NO_KEEPALIVE`:弱引用读路径上的"不保活"语义。

这两个条件任一命中,直接 `return`。**这些是编译器在生成站点时就已知的静态信息**——C1/C2 传给 barrier 的 decorator 集合里已经写明了,不是运行时判断。

即使两个 decorator 都不命中,还有第二个滤网:读旧值,`null` 就 `return`。只有旧值确实是个对象,才轮到 `enqueue`。

### enqueue:SATB 不 active 时,到此为止

`G1BarrierSet::enqueue`(g1BarrierSet.cpp:61-73):

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

真正的第一个运行时门控是 `is_active()`——在大部分 G1 工作负载中,并发标记不在跑的时间段里 SATB 不 active,这里直接 return。也就是说,非标记时期的一次写引用,pre barrier 只做了一次 active flag 检查 + 一次旧值 null 判断,几乎没有额外成本。

标记活跃时,才分流到线程本地 SATB 队列(Java 线程)或共享队列。非 Java 线程（如 GC worker、VM 线程）没有线程本地 SATB 队列，统一走 `Shared_SATB_Q_lock` 保护的共享队列；它们数量少，锁竞争可控。

### SATBMarkQueue 其实就是 PtrQueue 的一个实例

`satbMarkQueue.hpp:44-64` 定义 `SATBMarkQueue : public PtrQueue`,队列元素是"可能已经 stale 的 object head 指针"(注释原话),不是 card 地址。它的索引/缓冲区字段布局直接暴露给编译器(satbMarkQueue.hpp:72-85),让 C1/C2 能生成 `index -- ; buf[index] = ptr` 的 inline 写入;只有缓冲区耗尽才进 runtime。

这和 25-05 篇的 DirtyCardQueue 是同一套 `PtrQueue` 机制的两个实例——一个是 SATB 旧值指针,一个是 dirty card 字节地址。因此 pre barrier 的 fast-path inline + slow-path runtime 结构与 post barrier 完全同构。

---

## 4. post barrier —— 标记跨 Region 引用,但大量情况被过滤

### 第一层过滤:来源卡是 young card,直接跳过

`write_ref_field_post`(g1BarrierSet.inline.hpp:48-55):

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

它把来源 field 换算成 card 字节,然后判断:如果这张卡已经是 young card 专用值(`g1_young_card_val()`),直接不处理。原因:young Region 的引用在 GC 时整体处理,不需要像老年代那样逐卡记账。**年轻代内部的引用写,几乎每一下都命中这个过滤。**

注意这里还没有标 dirty——它只是"不是 young,才考虑下一步"。

### 第二层:才做 storeload + 置 dirty + enqueue

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

- `storeload`:保证卡表写入与之前的 store 有明确的顺序关系(不能乱序让 GC 读到旧卡);
- 卡已 dirty 就不再写、不再入队——**同一张卡反复写,只有第一次付入队成本**;
- Java 线程进本地 DirtyCardQueue,非 Java 线程进 shared queue(同样持 `Shared_DirtyCardQ_lock`)。

所以 post barrier 的常态是:young card 一步跳过;老卡 + 已 dirty 一步跳过;真正走到"置 dirty + enqueue"的,是"跨 Region 引用 + 卡还未脏"的写。

---

## 5. C1 / C2 / Assembler——不是三层独立实现,是同一套屏障的三层代码生成

### 编译期 vs 运行期:谁能证明"这刀不用下"

上面三、四节讲的都是 **C++ 运行时**的路径。但热点函数里 barrier 不能真的走 C++ 调用——C1/C2/解释器要为每个写点现场生成机器码。三层分工是:

- **C1**:生成 LIR 中间表示,把门控和 stub 拼出来;
- **C2**:在 Ideal Graph 里分析内存链,**尽可能证明屏障可删除**,删不掉的再生成;
- **Assembler**:把 stub 和 inline 序列落到具体 ISA(x86)。

一层比一层更"懂"上下文。这一节的要点是:**它们不是三份独立的屏障逻辑,而是同一套 `G1BarrierSetRuntime` 慢路径的三个前置生成器。** 慢路径统一指向 `G1BarrierSetRuntime::write_ref_field_pre_entry` / `write_ref_field_post_entry`,三层的差异只在于快路径怎么做、多快能证明不用做。

### C1:在 LIR 层做 active flag 分支 + 跨 Region XOR

C1 的 `pre_barrier`(g1BarrierSetC1.cpp:51-108)首先生成对 thread-local `satb_mark_queue_active` flag 的加载和比较:

```cpp
// g1BarrierSetC1.cpp:70-77,106-107(截取核心,逐字)
LIR_Address* mark_active_flag_addr =
  new LIR_Address(thrd,
                  in_bytes(G1ThreadLocalData::satb_mark_queue_active_offset()),
                  flag_type);
// Read the marking-in-progress flag.
LIR_Opr flag_val = gen->new_register(T_INT);
__ load(mark_active_flag_addr, flag_val);
__ cmp(lir_cond_notEqual, flag_val, LIR_OprFact::intConst(0));

__ branch(lir_cond_notEqual, T_INT, slow);
__ branch_destination(slow->continuation());
```

C1 不做沿内存链的 `g1_can_remove_*` 式证明——它没那个 IR 分析能力。它的职责是**把运行时门控翻译成 LIR**,同时在自己的入口处顺手过滤掉简单情况:非 `IN_HEAP` 引用、常量 null 直接不生成 barrier(g1BarrierSetC1.cpp:113-120);标记不活跃就跳过,活跃才落到 `G1PreBarrierStub`。

`post_barrier`(g1BarrierSetC1.cpp:110-176)更精确一点:它用地址与新值的 XOR、右移 `HeapRegion::LogOfHRGrainBytes` 判断**是否跨 Region**——不跨 Region 就不标卡:

```cpp
// g1BarrierSetC1.cpp:146-160,171-174(截取核心,逐字)
LIR_Opr xor_res = gen->new_pointer_register();
LIR_Opr xor_shift_res = gen->new_pointer_register();
__ move(addr, xor_res);
__ logical_xor(xor_res, new_val, xor_res);
__ move(xor_res, xor_shift_res);
__ unsigned_shift_right(xor_shift_res,
                        LIR_OprFact::intConst(HeapRegion::LogOfHRGrainBytes),
                        xor_shift_res,
                        LIR_OprDesc::illegalOpr());
...
__ cmp(lir_cond_notEqual, xor_shift_res, LIR_OprFact::intptrConst(NULL_WORD));
__ branch(lir_cond_notEqual, ..., slow);
```

这里有一个和 C++ 运行时 `byte_for` 路径不同的细节:C1 的 `post_barrier` 不是把 field 换算成卡号去比 young 值,而是直接看"目标对象和来源地址处在同一 Region 吗";同 Region 时不标卡,不同 Region 才进 stub。**"同 Region 跨 Map"的引用在 G1 里不需要 RSet 记账**,所以这也是一个廉价的快路径过滤(§4 的 young card 分工不同:那是年轻代整体语义,这是跨 Region 判定)。

### C2:证明"可以不用动"才是它的强项

C2 的前置逻辑不一样:它不是把门控翻译成 LIR,而是**先分析能不能不生成 barrier**。`g1_can_remove_pre_barrier`(g1BarrierSetC2.cpp:86-172)从写点的内存链出发:

```cpp
// g1BarrierSetC2.cpp:86-103,160-162(截取核心,逐字)
intptr_t offset = 0;
Node* base = AddPNode::Ideal_base_and_offset(adr, phase, offset);
AllocateNode* alloc = AllocateNode::Ideal_allocation(base, phase);

if (offset == Type::OffsetBot) {
  return false; // cannot unalias unless there are precise offsets
}

if (alloc == NULL) {
  return false; // No allocation found
}
...
if (captured_store == NULL || captured_store == st_init->zero_memory()) {
  return true;
}
```

翻译成人话:C2 要证明的是"我写给的这个字段,自从对象 new 出来之后从没被写过非 null 值"。它沿 memory chain 往回追溯:

- 地址能否拆出精确的 base + offset(offset 是 `OffsetBot` 就不可判,不能删);
- base 是否来自一个 `AllocateNode`(新分配对象,不是就别想了);
- 中间有没有同一字段的旧 store(有就说明字段可能有旧值,不能删);
- 初始化是否仍写 null(新对象的字段初始为 null,送 null 进 SATB 毫无意义)。

这条链只在一处历史里满足(分配后的首次初始化),所以**只有真正的新对象初始化才能删 pre barrier**。这就是 `ReduceInitialCardMarks` 时代的经典消除。

`g1_can_remove_post_barrier`(g1BarrierSetC2.cpp:306-335)条件更窄、逻辑与 pre 类似:要求 store 的对象来自同一个 `AllocateNode`,且 store 紧跟初始化路径(内存 State 直接落在该分配的 Initialize 上)。在 `post_barrier`(g1BarrierSetC2.cpp:372-479)里则还有几个快速 return:

- 写入常量 null——没有值得记录的新引用;
- 新分配 Eden 对象且 `ReduceInitialCardMarks` 开启——Eden 内对象不用标卡;
- `g1_can_remove_post_barrier` 命中——初始化路径上的 store。

走不到这些快速 return 的,`post_barrier` 才真正生成"算 card 地址 → 判断跨 Region → 判断 card 状态 → inline 入队或 leaf call `write_ref_field_post_entry`"的完整序列。

**关键是把 C2 的职责说准**:它不是"重复 barrier 消除",而是基于内存图证明"这个写点的 pre/post 无必要"。`g1_can_remove_post_barrier` 注释(g1BarrierSetC2.cpp:300-305)明确警告:这条删除路径必须与运行时的 `new_deferred_store_barrier` 严格同步保持,否则慢路径分配时会漏标卡——**编译器的删除是拿"运行时有补偿"换来的,不是免费。**

### x86 Assembler:inline 序列为主,慢路径才 call

C1/C2 的 stub 最终由 `G1BarrierSetAssembler` 生成机器码。以 pre barrier 的 `g1_write_barrier_pre`(g1BarrierSetAssembler_x86.cpp:142-258)为例,它的 inline 段真实流程:

1. 读 thread-local SATB active 字节,tests 为 0 就跳 done;
2. 需要时加载旧值,`pre_val == NULL` 就跳 done;
3. 读 SATB index,`index != 0` 就 `index -= wordSize; buf[index] = pre_val` 原地写完跳 done;
4. 只有 index 为 0(缓冲区满)才保存 live 寄存器、`call G1BarrierSetRuntime::write_ref_field_pre_entry`。

所以机器码层面的成本分布是:**两个条件分支 + 一次递减 + 一次 store**,比"每次写都 call runtime"便宜得多;runtime 只在 buffer 耗尽时出现。C1 的 stub(`G1PreBarrierStub::emit_code`,g1BarrierSetC1.cpp:41-49)最终也落到 `gen_pre_barrier_stub`,即同一套 Assembler + Runtime。

这就是"三层"真相:**C1 把门控翻译成 LIR,C2 尽可能先证明可删,Assembler 统一把这些 stub 变成平台机器码,慢路径统一 call `G1BarrierSetRuntime`。** 它们不是三个不同的屏障,是同一套屏障的三层前端。

---

## 6. 误解澄清与收网

1. **pre barrier 是不是每次写都入队?** 不是。三个静态/运行时滤网层层拦截:decorator 命中(未初始化/不保活)、旧值为 null、SATB 不 active——任一命中就 return。
2. **post barrier 是不是每次写都标脏卡?** 不是。young card 直接跳过;老卡未脏才置 dirty + 入队;已 dirty 不重复入队。C1/C2 还会运掉同 Region 引用。
3. **两道屏障能不能合并成一道?** 不能。pre 保护写之前的旧世界快照,post 记录写之后的新跨 Region 引用,分居 store 两侧,方向不同。
4. **C1/C2/Assembler 是否是三层独立实现?** 不是。它们是同一套屏障在三个环节的代码生成与证明:慢路径统一走 `G1BarrierSetRuntime`。
5. **"G1 写屏障最重"是否无条件成立?** 不是。快路径只花几个条件分支;真正的重成本集中在"标记活跃 + 旧值非 null + buffer 满"(pre)和"跨 Region + 老卡未 dirty + buffer 满"(post)。C2 还能在新对象初始化等场景把整道屏障删掉。

把这一篇压成三句话:

- **G1 需要两道屏障,是因为它有两种各自独立的记账需求**:pre 记"旧世界快照里谁活着",post 记"新世界谁跨 Region 引用了谁"。
- **每一道屏障都用多个廉价门控在前头过滤**:绝大多数写操作只花几个条件分支,真正走完整路径的很少。
- **C1/C2/Assembler 不是三层屏障,是三层生成器**:C1 翻译门控,C2 证明可删,Assembler 落机器码,慢路径统一归 `G1BarrierSetRuntime`。

写屏障是 G1 与 mutator 之间的接缝。走到这一步,G1 的标记、RSet、分配、策略、屏障都到齐了——但用尽全力仍然可能失败:humongous 挤爆、晋升失败、标记中途堆满。这些情况会怎么落底,是下一篇的事。

> → [07-full-gc-roots.md](07-full-gc-roots.md)