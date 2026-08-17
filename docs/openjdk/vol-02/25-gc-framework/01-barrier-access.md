# 01. GC 怎么在每次 oop 访问时悄悄插入 barrier？— BarrierSet + Access API

> **前置依赖**:[06-oops/05 — Access API — 每次引用读写,GC 都在旁听](openjdk/vol-02/06-oops/05-access-api-barrier.md):Access 模板的装饰器组合与 G1 两道 barrier(SATB pre/卡表 post)的语义,本篇讲"这套机制在 JVM 里的骨架";[09-memory-core/01 — Universe + CollectedHeap — JVM 的"宇宙大爆炸"](openjdk/vol-02/09-memory-core/01-universe-heap.md):barrier 服务的对象在堆里;[14-c1-compiler/04 — Runtime1 + FrameMap — C1 runtime 与栈帧](openjdk/vol-02/14-c1-compiler/04-c1-runtime-frame.md)与 [15-c2-compiler/01 — C2 Ideal Graph: Node + Type + IGVN — C2 的节点海](openjdk/vol-02/15-c2-compiler/01-c2-ideal-graph.md):两个编译器的 barrier 生成框架
> → **后续**:[25-gc-framework/02 — new Object() 走到了哪？— CollectedHeap + 分配路径](openjdk/vol-02/25-gc-framework/02-collected-heap.md)
> 关联域: 06-oops(对象访问)、15-c2(barrier 节点优化)、08-interpreter(解释器模板)、23-stub(汇编桩)

## 一条赋值语句的三重身份

`obj.field = value` 在 Java 层是一行;在字节码层是一条 `putfield`;在 JVM 里,它是**被 GC barrier 包围**的一步操作——G1 下写引用前要记录旧值进 SATB 队列(并发标记快照),写完后要把对象所在 512 字节"卡"标记为 dirty(remembered set 的粒度)。06-oops/05 讲了这两道 barrier 的**语义**;本篇问的是**骨架**:这套"悄悄插入"在 JVM 内部由什么类承担、解释器/C1/C2 三条执行路径各自怎么注入、以及编译器凭什么敢在热路径上让 barrier 消失。

## 1. Access 管线 — 5 步模板管线与"运行时解析"

`Access<decorators>::oop_store_at(...)` 不是直接读写,而是走一条**5 步模板管线**(access.hpp:63-92 的权威注释):

```cpp
// access.hpp:63-92(截取核心,逐字)
// Each access goes through the following steps in a template pipeline.
// There are essentially 5 steps for each access:
// * Step 1:   Set default decorators and decay types. This step gets rid of CV qualifiers
//             and sets default decorators to sensible values.
// * Step 2:   Reduce types. This step makes sure there is only a single T type and not
//             multiple types. The P type of the address and T type of the value must
//             match.
// * Step 3:   Pre-runtime dispatch. This step checks whether a runtime call can be
//             avoided, and in that case avoids it (calling raw accesses or
//             primitive accesses in a build that does not require primitive GC barriers)
// * Step 4:   Runtime-dispatch. This step performs a runtime dispatch to the corresponding
//             BarrierSet::AccessBarrier accessor that attaches GC-required barriers
//             to the access.
// * Step 5.a: Barrier resolution. This step is invoked the first time a runtime-dispatch
//             happens for an access. The appropriate BarrierSet::AccessBarrier accessor
//             is resolved, then the function pointer is updated to that accessor for
//             future invocations.
// * Step 5.b: Post-runtime dispatch. This step now casts previously unknown types such
//             as the address type of an oop on the heap (is it oop* or narrowOop*) to
//             the appropriate type. It also splits sufficiently orthogonal accesses into
//             different functions, such as whether the access involves oops or primitives
//             and whether the access is performed on the heap or outside. Then the
//             appropriate BarrierSet::AccessBarrier is called to perform the access.
```

前三步在 `accessBackend.hpp`(Step 1-4 的实现,access.hpp:87-88 注释),第 4 步 `RuntimeDispatch` 是核心:

```cpp
// accessBackend.hpp:452-474(截取核心,逐字)
  // Step 4: Runtime dispatch
  // The RuntimeDispatch class is responsible for performing a runtime dispatch of the
  // accessor. This is required when the access either depends on whether compressed oops
  // is being used, or it depends on which GC implementation was chosen (e.g. requires GC
  // barriers). The way it works is that a function pointer initially pointing to an
  // accessor resolution function gets called for each access. Upon first invocation,
  // it resolves which accessor to be used in future invocations and patches the
  // function pointer to this new accessor.

  template <DecoratorSet decorators, typename T, BarrierType type>
  struct RuntimeDispatch: AllStatic {};

  template <DecoratorSet decorators, typename T>
  struct RuntimeDispatch<decorators, T, BARRIER_STORE>: AllStatic {
    typedef typename AccessFunction<decorators, T, BARRIER_STORE>::type func_t;
    static func_t _store_func;

    static void store_init(void* addr, T value);

    static inline void store(void* addr, T value) {
      _store_func(addr, value);
    }
  };
```

*关键设计: **运行时分派,不是编译期静态分派**。`_store_func` 是每个 (decorators, T, 操作) 组合的静态函数指针,初始指向 `store_init`;第一次调用时 `store_init` 调 `BarrierResolver::resolve_barrier()`——按当前 `BarrierSet::barrier_set()->kind()` 的 switch(access.inline.hpp:218-235)选到对应 GC 的 `AccessBarrier` 函数,`_store_func = function` 完成 patch(access.inline.hpp:284-288),之后每次访问就是一次间接调用。为什么必须运行时分派?因为 **GC 是启动时用 flag 选的**(-XX:+UseG1GC/UseSerialGC…),同一个 libjvm.so 编译一次要服务所有 GC——函数指针缓存是"一次解析、永久有效"的折衷。**运行时分派有三副面孔**: VM 内部 C++(运行时/Unsafe/反射等)走这里的函数指针缓存;解释器模板走 BarrierSetAssembler 的**虚函数调用**(§2.2);C1/C2 在编译期把 barrier 编成机器码,热路径零间接调用。*

`AS_RAW` 装饰器是旁路(accessDecorators.hpp:139-145): "This will bypass runtime function pointer dispatching in the pipeline and hardwire to raw accesses"——裸访问连间接调用都省了,VM 内部确定不需要 barrier 的场景用。

## 2. BarrierSet — GC↔编译器桥的三层骨架

### 2.1 类骨架: FakeRtti + 三个子组件 + AccessBarrier

`BarrierSet` 是 GC barrier 的总接口(barrierSet.hpp:44+):

```cpp
// barrierSet.hpp:57-74(截取核心,逐字)
protected:
  // Fake RTTI support.  For a derived class T to participate
  ...
  typedef FakeRttiSupport<BarrierSet, Name> FakeRtti;

private:
  FakeRtti _fake_rtti;
  BarrierSetAssembler* _barrier_set_assembler;
  BarrierSetC1* _barrier_set_c1;
  BarrierSetC2* _barrier_set_c2;
```

三个要点:

1. **FakeRtti**(:58-71): 不用 C++ RTTI,Name 枚举(`FOR_EACH_BARRIER_SET_DO` 宏展开,:50-55)打标签;`kind()` 取具体类、`is_a(name)` 测祖先。`barrier_set_cast<T>(bs)`(:302-306)断言后 static_cast——"Fake Rtti 做 static_cast"就在这里。
2. **三个子组件**(:72-74): `Assembler`(桩/解释器层手写汇编)、`C1`、`C2`——每个 GC 子类各配一套(G1BarrierSetAssembler/G1BarrierSetC1/G1BarrierSetC2)。
3. **AccessBarrier 嵌套模板**(:166-299): `template <DecoratorSet decorators, typename BarrierSetT> class AccessBarrier: protected RawAccessBarrier<decorators>`——**默认实现全部委托 RawAccessBarrier**(裸存取+压缩 oop 编解码);GC 子类覆盖需要 barrier 的方法。注释 :155-159 明说: "Its accessors will then be automatically resolved at runtime"——§1 的 RuntimeDispatch 解析的正是这个。**特化链**: G1BarrierSet::AccessBarrier → ModRefBarrierSet::AccessBarrier → BarrierSet::AccessBarrier → RawAccessBarrier(g1BarrierSet.hpp:88-108)。

### 2.2 三视角注入: 汇编层 / C1 / C2

**汇编层(BarrierSetAssembler)** 服务解释器与桩。x86 的默认实现 `load_at`/`store_at`(barrierSetAssembler_x86.cpp:34-130)就是裸存取+压缩 oop 编解码;GC 子类覆盖加 barrier。解释器模板的引用写在 `do_oop_store`(templateTable_x86.cpp:146-158)→ `store_heap_oop`(macroAssembler_x86.cpp:5501-5504)→ `access_store_at`(macroAssembler_x86.cpp:5478,与 `access_load_at` :5466-5475 同构): `AS_RAW` 时显式调基类 `BarrierSetAssembler::store_at`(裸存取),否则 **虚调用** `bs->store_at(...)`——解释器每处引用访问一次**虚分派**,运行时决定 barrier 代码;这是"运行时分派"的第二副面孔。G1 的 SATB 写前 barrier 是整段手写汇编(g1BarrierSetAssembler_x86.cpp:142+):

```cpp
// g1BarrierSetAssembler_x86.cpp:168-208(截取核心,逐字)
  // Is marking active?
  if (in_bytes(SATBMarkQueue::byte_width_of_active()) == 4) {
    __ cmpl(in_progress, 0);
  } else {
    assert(in_bytes(SATBMarkQueue::byte_width_of_active()) == 1, "Assumption");
    __ cmpb(in_progress, 0);
  }
  __ jcc(Assembler::equal, done);
  ...

  // Do we need to load the previous value?
  if (obj != noreg) {
    __ load_heap_oop(pre_val, Address(obj, 0), noreg, noreg, AS_RAW);
  }

  // Is the previous value null?
  __ cmpptr(pre_val, (int32_t) NULL_WORD);
  __ jcc(Assembler::equal, done);

  // Can we store original value in the thread's buffer?
  // Is index == 0?
  __ movptr(tmp, index);                   // tmp := *index_adr
  __ cmpptr(tmp, 0);                       // tmp == 0?
  __ jcc(Assembler::equal, runtime);       // If yes, goto runtime

  __ subptr(tmp, wordSize);                // tmp := tmp - wordSize
  __ movptr(index, tmp);                   // *index_adr := tmp
  __ addptr(tmp, buffer);                  // tmp := tmp + *buffer_adr

  // Record the previous value
  __ movptr(Address(tmp, 0), pre_val);
  __ jmp(done);
```

检查链: marking 活跃?→ 读旧值 → 旧值非空?→ 本地 SATB buffer 有空间?(index-8 写入)/ 无空间?(call runtime)。这套汇编与 §3 的卡标记一样,**全 inline,只在 buffer 满时才进 runtime**。

**C1(BarrierSetC1)** 在 LIR 层注入: `G1BarrierSetC1::pre_barrier/post_barrier`(g1BarrierSetC1.cpp:51/:110)生成 LIR,慢路径是 Runtime1 生成的 blob(预/后 barrier runtime stub,:194-221)。

**C2(BarrierSetC2)** 在 Ideal 图注入: GraphKit 持有 `_barrier_set`(= `BarrierSetC2*`,graphKit.cpp:56),store/load 分派到 `_barrier_set->BarrierSetC2::store_at(access, value)`(:1606)。G1 的实现 `pre_barrier`/`post_barrier`(g1BarrierSetC2.cpp:175/:372)用 **IdealKit** 生成节点序列——结构与上面的汇编完全同构(读 marking 标志 → 读 index → 存 buffer → 满则 `make_leaf_call write_ref_field_pre_entry` :267-268)。**节点在 Ideal 图里 = 可被优化**:

- `g1_can_remove_pre_barrier`(:86)/`g1_can_remove_post_barrier`(:306): 冗余 barrier 消除(比如 store 的值已知 NULL、或写向不可能被并发观察的位置);
- **ReduceInitialCardMarks**(C2 product,默认 true): 写向**刚分配、未发布**的对象(`obj == kit->just_allocated_object(...)`)时跳过卡标记(:391-398,"We can skip marks on a freshly-allocated object in Eden")——对象还在 Eden 且无人可见,卡标记毫无意义;Eden 的卡本来就由 GC 统一处理。

**[实证](openjdk/planning/outlines/00-jvm-tools/materials/commands/25-gc-barrier-demo.txt)**: C1 与 C2 的同一方法 nmethod header 尺寸差一倍以上(C1 1248/1344 vs C2 576)——barrier 在 Ideal 图里的可优化性是 C2 代码更紧的原因之一;`ReduceInitialCardMarks`/`UseCondCardMark` 都是可开关的 product flag(素材 C 段)。

## 3. CardTable — 512 字节一张卡

卡表是"老年代对象引用年轻代"的索引粒度(06-oops/05 已讲语义):堆按 **512 字节**分卡,每卡一个 `jbyte`(cardTable.hpp:231-232 `card_shift=9`)。卡值枚举(:95-102): `clean_card=-1`/`dirty_card=0`/`precleaned_card=1`/`claimed_card=2`/`deferred_card=4`。地址→卡号:`byte_for(p) = &_byte_map_base[uintptr_t(p) >> card_shift]`(:153-158)。写 barrier 的标记动作在汇编层(cardTableBarrierSetAssembler_x86.cpp:88-132):

```cpp
// cardTableBarrierSetAssembler_x86.cpp:97-131(截取核心,逐字)
  __ shrptr(obj, CardTable::card_shift);

  Address card_addr;
  ...
  intptr_t byte_map_base = (intptr_t)ct->byte_map_base();
  if (__ is_simm32(byte_map_base)) {
    card_addr = Address(noreg, obj, Address::times_1, byte_map_base);
  } else {
    ...
    AddressLiteral cardtable((address)byte_map_base, relocInfo::none);
    Address index(noreg, obj, Address::times_1);
    card_addr = __ as_Address(ArrayAddress(cardtable, index));
  }

  int dirty = CardTable::dirty_card_val();
  if (UseCondCardMark) {
    Label L_already_dirty;
    if (ct->scanned_concurrently()) {
      __ membar(Assembler::StoreLoad);
    }
    __ cmpb(card_addr, dirty);
    __ jcc(Assembler::equal, L_already_dirty);
    __ movb(card_addr, dirty);
    __ bind(L_already_dirty);
  } else {
    __ movb(card_addr, dirty);
  }
```

*关键设计: 卡标记是"地址右移 9 位 + 写 0"——没有函数调用、没有原子操作(卡字节的并发写是安全的,脏卡只需"至少标记一次")。`byte_map_base` 是 `_byte_map - (堆低地址 >> 9)`(:101-105 注释),把"堆地址→卡字节"变成一次位移寻址;64 位下若 base 超过 32 位立即数,退回数组寻址。`UseCondCardMark` 先读后写,避免反复标记同一张卡的写放大(默认关)。*

G1 的卡表是子类 `G1CardTable`(g1CardTable.hpp:47),多一个 `g1_young_card_val()`(:65):写向 Eden 对象时卡值本来就是 young 专用值,post barrier 直接跳过(C2 侧 g1BarrierSetC2.cpp:418 的快速路径;06-oops/05 的 `write_ref_field_post` 同源)。被标脏的卡由 **DirtyCardQueue**(G1 专属,g1/dirtyCardQueue.hpp:46+)批量收集——`PtrQueue` 的线程本地缓冲(index/buf 字段,与 §2 汇编里 SATB 队列同构),满了整块转交 `DirtyCardQueueSet`,GC 时 "Update RS" 阶段消费——**[实证](openjdk/planning/outlines/00-jvm-tools/materials/commands/25-gc-barrier-demo.txt)**: 2 亿次老对象引用写之后,`-Xlog:gc+phases=debug` 里 Update RS 阶段真实出现并处理卡片(素材 A 段),卡标记的工作量在 GC 侧可见。

## 核心悬念

引用读写的旁听骨架到齐: **Access 管线**(5 步 + 函数指针缓存,运行时按 GC 解析)、**BarrierSet 骨架**(FakeRtti + 汇编/C1/C2 三子组件 + AccessBarrier 特化链)、**三视角注入**(解释器走汇编、C1 走 LIR stub、C2 走 Ideal 节点并可消除)、**卡表**(512B/卡,`shr 9 + movb 0`)。barrier 保证"GC 看到的引用图是完整的"——但图里的**顶点**(对象)从哪来?`new Object()` 在 Java 里是一行,在 JVM 里是 TLAB bump-pointer 快速路径、PLAB、全局分配的漫长下潜。下一篇: CollectedHeap 与分配路径。

> → [25-gc-framework/02 — new Object() 走到了哪？— CollectedHeap + 分配路径](openjdk/vol-02/25-gc-framework/02-collected-heap.md)
