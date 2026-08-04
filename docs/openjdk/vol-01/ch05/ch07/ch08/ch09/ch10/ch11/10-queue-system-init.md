# 10. 队列系统初始化——SATB + 双 DCQ + ConcurrentRefinement + YoungGenSampling

> **本文定位**：`G1CollectedHeap::initialize()` 第 1679-1707 行。初始化 G1 的**四套队列基础设施**——SATB 写前快照队列、并发 refine 线程（处理脏卡）、两道 DirtyCardQueueSet（barrier 端和 GC 端）、以及 YoungGen RSet 采样线程。这是 G1 "边写边记、边跑边处理"能力的骨架。
>
> **前置依赖**：[ch09/09](09-g1-policy-init.md)（G1Policy init 完毕、young_list_target_length 已算好）。

---

## 1. 执行位置与全景

09 篇覆盖到第 1677 行（`g1_policy()->init()`）。紧接其后，`initialize()` 进入四套队列系统的初始化：

```cpp
// g1CollectedHeap.cpp:1679-1707
G1BarrierSet::satb_mark_queue_set().initialize(SATB_Q_CBL_mon,           // [1] SATB
                                               SATB_Q_FL_lock,
                                               G1SATBProcessCompletedThreshold,
                                               Shared_SATB_Q_lock);

jint ecode = initialize_concurrent_refinement();                         // [2] 并发 refine
if (ecode != JNI_OK) {
    return ecode;
}

ecode = initialize_young_gen_sampling_thread();                         // [3] YoungGen 采样
if (ecode != JNI_OK) {
    return ecode;
}

G1BarrierSet::dirty_card_queue_set().initialize(DirtyCardQ_CBL_mon,    // [4] DCQ barrier 端
                                                DirtyCardQ_FL_lock,
                                                (int)concurrent_refine()->yellow_zone(),
                                                (int)concurrent_refine()->red_zone(),
                                                Shared_DirtyCardQ_lock,
                                                NULL,
                                                true);

dirty_card_queue_set().initialize(DirtyCardQ_CBL_mon,                   // [5] DCQ GC 端
                                  DirtyCardQ_FL_lock,
                                  -1, // never trigger processing
                                  -1, // no limit on length
                                  Shared_DirtyCardQ_lock,
                                  &G1BarrierSet::dirty_card_queue_set());
```

这 29 行代码创建的四套系统虽然独立运行，但存在一条**依赖链**贯穿它们：

```
[2] initialize_concurrent_refinement()
       │  创建 G1ConcurrentRefine，算出 yellow_zone / red_zone
       │
       ▼
[4] G1BarrierSet::dirty_card_queue_set().initialize(yellow_zone, red_zone)
       │  全局 primary DCQ set——mutator 和 refinement 线程交互的中心
       │
       ▼
[5] G1CollectedHeap::dirty_card_queue_set().initialize()
       │  GC 端 secondary DCQ set——共享 primary 的 buffer free list
       │
[1] SATBMarkQueueSet::initialize()      ← 独立，和 DCQ 无关
[3] YoungGen Sampling Thread            ← 独立，和队列无关
```

> **为什么先写 [2] 再写 [4][5] 再写 [1][3]**：按依赖驱动原则——理解 DCQ 必须先理解 refinement 的 zone 模型，所以本文先讲 [2]，再讲 [4][5]（两道 DCQ），最后讲独立的 [1][3]（SATB + YoungGen 采样）。

### 1.1 四套系统各干什么

用一句话概括每套系统**构造时创建了什么**：

| 系统 | 干了什么 | 详细位置 |
|------|---------|---------|
| ConcurrentRefinement | 创建 `G1ConcurrentRefine` + N 个 `G1ConcurrentRefineThread`，算出 green/yellow/red 三区域阈值 | §2 |
| DCQ (barrier 端) | 初始化全局 `DirtyCardQueueSet`——buffer 大小 256、yellow/red 阈值、FreeIdSet | §3 |
| DCQ (GC 端) | 初始化 GC 端 `DirtyCardQueueSet`——共享 barrier 端的 buffer free list、threshold=-1 | §3 |
| SATB | 初始化全局 `SATBMarkQueueSet`——process_completed=20、三个锁、shared SATB queue | §4 |
| YoungGen 采样 | 创建 `G1YoungRemSetSamplingThread`——一个并发线程，每 300ms 采样 RSet 长度 | §5 |

---

## 2. G1ConcurrentRefine——并发 refine 引擎

### 2.1 前置知识——G1 的双写屏障：写前 + 写后

G1 有两道写屏障，各自服务于不同的 GC 机制。这是理解本章四套队列系统"为什么存在"的基础：

```
mutator 执行 ref.field = new_value;  // 覆盖了一个引用
       │
       ├── [写前屏障] SATB barrier
       │      把 old_value 记到 SATB buffer 队列
       │      → 保证并发标记的"快照"完整性
       │      → 由 §4 的 SATBMarkQueueSet 接收
       │
       └── [写后屏障] post-write barrier
              把 card table 的对应字节标为 dirty
              → 标记"这片内存可能有跨 Region 引用"
              → 由 §3 的 DirtyCardQueueSet 接收，§2 的 refinement 线程处理
```

**写前屏障（SATB barrier）**——并发标记的正确性保障。

并发标记开始后，mark 线程扫描引用图给活对象做标记。但 mutator 同时在修改引用——如果 mutator 把某个老年代字段从 `C` 改成 `D`，而 mark 线程还没扫到这个字段，`C` 就可能被漏标。漏标的后果是 `C` 被当做垃圾回收——灾难性的活对象丢失。

SATB 的解决方案：**在并发标记期间，mutator 覆盖引用字段时把旧值（`C`）记下来**。记录操作只做一件事——往线程本地的 SATB buffer 里 `push(C)`。buffer 满了就交给全局 `SATBMarkQueueSet`，攒够 20 个就唤醒 CM 并发标记线程去处理。

写前屏障只在并发标记期间开启（由 CMThread 在 initial-mark GC 后调 `set_active_all_threads(true)` 激活），平时是关闭的。§4 初始化的 SATBMarkQueueSet 就是收这些旧值的队列。

**写后屏障（post-write barrier）**——Remembered Set 更新的数据来源。

跨 Region 引用是 G1 的核心问题。如果 Old Region A 引用 Young Region B 里的对象，做 Young GC 时只扫描 B 的引用图是找不到 A→B 这条边的。但把整个 Old 区都扫一遍就违背了 G1 的分代设计。解决方案是用 **card table**——把堆按 512 字节切成一张张 card，每当 mutator 往**非年轻代**里写入一个引用时就标记对应 card "脏了"。

**Card 标记的粒度——标记的是被写字段所在的 card，不是对象的起始 card。**

执行 `obj.ref_field = target`（把对象 obj 的引用字段赋值为 target）时，写后屏障做三件事：

```
1. 判断 obj 和 target 是否在同一个 Region                   [跨 Region 过滤]
   → 同 Region → 直接跳过（不需要更新 RSet）
   → 不同 Region → 继续

2. 把字段 ref_field 所在的那张 card 标为 dirty              [脏卡标记]
   card_index = (&obj.ref_field) >> 9                       ← 基于字段地址，不是对象起始地址
   card_table[card_index] = 0

3. 把脏卡地址推入线程本地 DCQ buffer
```

**步骤 1 的源码依据**（`g1BarrierSetC2.cpp:451-460`）：

```cpp
// 代码中的 cast = &obj.ref_field（写入的目标地址）, val = target（被写入的值）
Node* xor_res = __ URShiftX(
    __ XorX(cast, __ CastPX(__ ctrl(), val)),               // 把字段地址和 target 值做 XOR
    __ ConI(HeapRegion::LogOfHRGrainBytes)                   // 右移 Region 粒度位数
);
// xor_res == 0 → &obj.ref_field 和 target 在同一个 Region
//   → obj 和 target 在同一个 Region（因为字段地址和 obj 起始地址必然在同一个 Region）
// xor_res != 0 → 不同 Region，有跨 Region 引用，需要标记 card
```

**为什么用字段地址 XOR 值就能判断是否同 Region？** 任何两个地址在同一个 Region ⇔ 它们的高位（丢掉低位的 Region 内偏移）相等 ⇔ `(addr1 ^ addr2) >> LogOfHRGrainBytes == 0`。底层就是一行整数运算——没有函数调用、不需要查表，是 barrier 的 fast path 能做到的极限。字段地址所在的 Region = obj 所在的 Region（因为对象不能横跨 Region），所以这行等价于问 `obj.region == target.region?`。

**但不是所有跨 Region 引用都需要标记 card。解释器屏障揭示了关键的一层过滤**（`g1BarrierSet.inline.hpp:49-55`）：

```cpp
inline void G1BarrierSet::write_ref_field_post(T* field, oop new_val) {
    volatile jbyte* byte = _card_table->byte_for(field);         // 字段所在的 card
    if (*byte != G1CardTable::g1_young_card_val()) {             // ← 关键：只对 old card 处理
        write_ref_field_post_slow(byte);    // 走 slow path：标记脏卡 + 入队 DCQ
    }
    // card 是 young 标记 → 直接返回，什么都不做
}
```

**post-write barrier 涉及的关键 card 值**（`g1CardTable.hpp:53-54`, `cardTable.hpp:97-106`）：

| 名称 | 值 | 含义 | 在 barrier 中的角色 |
|------|-----|------|-------------------|
| `g1_young_card_val()` | **32** (0x20) | "这是 young Region 的 card" | fast path 读到此值直接返回 |
| `dirty_card_val()` | **0** (0x00) | "脏了" | barrier 写入的值；slow path 读到此值跳过重复标记 |
| `clean_card_val()` | **-1** (0xFF) | "干净" | refinement 线程处理 card 后的状态 |

> **注意**：card table 的实际状态不止这三种——G1 还用了 `claimed`、`deferred` 等额外值用于 GC 暂停期间的协作。这里列出的只是 post-write barrier 代码路径中直接判断的三个值，不是 card table 的完整取值表。

**为什么 young Region 的 card 不需要标记？** 因为 **所有 STW GC 暂停都全量扫描 young Region**——不管 card 是不是 dirty。无论是 Young GC 还是 Mixed GC，young Region 的引用字段都会被遍历。

所以不仅是 young→young，**young→old 也同理被跳过**。barrier 的 young_card 检查是一刀切：`*byte == young_card_val` → 直接返回，根本不去看 `target` 是 young 还是 old。

反过来说，old→old 跨 Region 引用则会被标记——因为 Mixed GC 时并非所有 old Region 都在 CSet 中，非 CSet 的 old 对 CSet 中 old 的引用只能靠 RSet。下面是 **`obj.ref_field = target` 的 4 种引用组合在 barrier 中的完整行为**：

| 引用方向 | obj 所在 Region | target 所在 Region | XOR 跳过? | young_card 跳过? | 最终标记? | 为什么 |
|---------|----------------|-------------------|----------|-----------------|----------|--------|
| young→young | young | young（同 Region） | ✓ (同 Region) | — | ✗ | Young GC 全量扫 young，不需要 RSet |
| young→young | young | young（不同 Region） | ✗ | ✓ (obj 的 card = 32) | ✗ | 同上——young Region 永远被全量扫 |
| young→old | young | old | ✗ | ✓ (obj 的 card = 32) | ✗ | Young GC 不碰 old；Mixed GC 全量扫 young 自然覆盖 |
| old→young | old | young | ✗ | ✗ (obj 的 card ≠ 32) | ✓ | Young GC 不扫 old——只能靠 RSet 找到入边 |
| old→old | old | old（同 Region） | ✓ (同 Region) | — | ✗ | 同 Region 内引用不需要 RSet（GC 撤离整个 Region） |
| old→old | old | old（不同 Region） | ✗ | ✗ (obj 的 card ≠ 32) | ✓ | Mixed GC 只撤离部分 old——非 CSet old 对 CSet old 的引用靠 RSet |

下面展开每种组合对应的 GC 场景。

```
Young GC:  只撤离 young Region——old Region 碰都不碰
           young→old 引用在本次 GC 中不需要用到

Mixed GC:  撤离 young + 部分 old CSet
           所有 young 仍然被全量扫描 → 自然发现 young→old 引用
           被撤离的 old Region 在 CSet 中也全量扫描 → old→old (同 CSet) 引用被覆盖
           非 CSet 的 old 对 CSet 中 old 的引用 → 只能靠 RSet（来自 card marking）
```

**C2 编译器做同样的过滤**（`g1BarrierSetC2.cpp:418,470`）：加载 card 的当前值，和 `young_card` 常量比较，相同就直接跳过——不调 `g1_mark_card()`。

**还有一层：已经 dirty 的 card 不会重复入队。** C2 在 young_card 过滤之后还做了一次 dirty_card 检查（`g1BarrierSetC2.cpp:475-477`）：加 StoreLoad 内存屏障后重新读取 card 值，如果已经是 `dirty_card_val()`，说明之前的某个 barrier 已经标记过了——跳过。解释器 slow path 同样有这层检查（`g1BarrierSet.cpp:103`：`if (*byte != dirty_card_val())`）。

#### 2.1.1 写后屏障到底做了什么——逐行拆解

以解释器路径为例（最简洁，C1/C2 做的事一样只是表达形式不同）。入口在 `g1BarrierSet.inline.hpp:49-55`：

```cpp
inline void G1BarrierSet::write_ref_field_post(T* field, oop new_val) {
    volatile jbyte* byte = _card_table->byte_for(field);      // 第 50 行
    if (*byte != G1CardTable::g1_young_card_val()) {          // 第 51 行
        write_ref_field_post_slow(byte);                       // 第 53 行
    }
}
```

只有两行逻辑。`field` 是被写字段的地址（`&obj.ref_field`），`new_val` 是被写入的值（`target`）。

**第 50 行**——`_card_table->byte_for(field)`：把字段地址 `&obj.ref_field` 换算成 card table 中对应字节的地址。`byte_for()` 就是 `_byte_map_base + (field >> 9)`——一行地址计算。

**第 51 行**——`*byte != g1_young_card_val()`：读 card table 这个字节的值。
- 如果值是 **32**（`g1_young_card_val`）→ `obj` 在 young Region → **直接返回**，什么都不做。
- 如果值是 **0**（`dirty_card_val`）或 **-1**（`clean_card_val`）→ `obj` 在 old Region → 进入 `write_ref_field_post_slow()`。

**注意这里没有检查 `target` 是谁。** barrier 不关心 `target` 是不是 NULL、`target` 在哪个 Region——只要 `obj` 在 old Region 里，就往下走。这是因为 `obj` 的 card 只要不是 young，就意味着"obj 所在的 Region 不是每次 GC 都扫，需要靠 card 来追踪它的引用变更"。

如果 `obj` 在 old Region，进入 slow path（`g1BarrierSet.cpp:99-114`）：

```cpp
void G1BarrierSet::write_ref_field_post_slow(volatile jbyte* byte) {
    OrderAccess::storeload();                              // 1) StoreLoad 屏障
    if (*byte != G1CardTable::dirty_card_val()) {          // 2) 如果已经是 dirty = 0
        *byte = G1CardTable::dirty_card_val();              // 3) 标记 card = 0
        Thread* thr = Thread::current();
        if (thr->is_Java_thread()) {
            G1ThreadLocalData::dirty_card_queue(thr).enqueue(byte);  // 4) 入队
        } else {
            // 非 Java 线程入共享队列
        }
    }
}
```

slow path 又做了两层检查：

**步骤 1**——`OrderAccess::storeload()`：确保 `obj.ref_field = target` 这条写入在检查 card 之前对所有线程可见。不加这个屏障的话，CPU 可能重排指令——card 值先被读到再写 `target`——会导致"card 标记了 dirty 但 `target` 还没写进去"的竞态。

**步骤 2**——`*byte != dirty_card_val()`：再读一次 card 值。如果在 fast path 和 slow path 之间，另一个线程（或同一线程之前的写操作）已经把这张 card 标成 dirty（0）了，就不再重复标记和入队。

**步骤 3**——`*byte = 0`：把 card 标为 dirty。

**步骤 4**——`dirty_card_queue(thr).enqueue(byte)`：把这张脏卡的地址推入线程本地 DCQ buffer。buffer 满了 → `handle_zero_index()` → `enqueue_complete_buffer()` → 攒够了唤醒 refinement 线程处理（这就是 §2-§3 讲的 DCQ + Refinement 系统）。

> **C1/C2 做了什么不同的事？** C1 和 C2 是把上面这套逻辑"编译进机器码"——解释器是每次执行 `obj.ref_field = target` 时 C++ 调 `write_ref_field_post()`，C2 则是把 card table 地址计算、card 值比较、StoreLoad、dirty 检查全部展开成机器指令，inline 在赋值指令之后。逻辑完全一样，只是少了几层函数调用。C2 额外多了一个优化：如果编译期能证明 `target == NULL` 或 `obj` 刚在 Eden 分配，就直接不生成 barrier 代码。

**slow path 的入队逻辑（`g1BarrierSet.cpp:99-114`）**：

```cpp
void G1BarrierSet::write_ref_field_post_slow(volatile jbyte* byte) {
    OrderAccess::storeload();                              // 1) StoreLoad 内存屏障
    if (*byte != G1CardTable::dirty_card_val()) {          // 2) 已经 dirty 就跳过
        *byte = G1CardTable::dirty_card_val();              // 3) 标记 card dirty
        Thread* thr = Thread::current();
        if (thr->is_Java_thread()) {                        // 4a) Java 线程: 线程本地 DCQ
            G1ThreadLocalData::dirty_card_queue(thr).enqueue(byte);
        } else {                                           // 4b) 非 Java 线程: 共享 DCQ
            MutexLockerEx x(Shared_DirtyCardQ_lock, ...);
            _dirty_card_queue_set.shared_dirty_card_queue()->enqueue(byte);
        }
    }
}
```

`enqueue(byte)` 的实现（`ptrQueue.hpp:141-143`, `ptrQueue.cpp:64-74`）：

```cpp
void PtrQueue::enqueue(void* ptr) {
    if (!_active) return;
    while (_index == 0) {             // buffer 满了？
        handle_zero_index();          // → 处理满 buffer（入队或自救）
    }
    _index -= sizeof(void*);          // 移动索引
    _buf[index()] = ptr;              // 写入 buffer
}
```

`handle_zero_index()` 的 key 逻辑（`ptrQueue.cpp:169-204`）：

```
buffer 满了 (_index == 0)
  → make_node_from_buffer(buf, index)
  → process_or_enqueue_complete_buffer(node)
    ├─ _n_completed_buffers >= max_completed_queue(red_zone)?
    │    → mut_process_buffer(node)  ← mutator 自救，自己处理脏卡
    │    → return true → 重用 buffer
    └─ else:
         → enqueue_complete_buffer(node)  ← 入队 completed list
           → n_completed_buffers++
           → if n >= process_completed_threshold → notify refinement
         → return false → allocate new buffer
```

这就是 §2 的 refinement 线程和 §3 的 DCQ Set 的**数据源头**——每一张脏卡都从 `write_ref_field_post_slow` → `enqueue` → `handle_zero_index` → `enqueue_complete_buffer` 这条链流入 completed list，再由 primary refinement 线程在 `DirtyCardQ_CBL_mon` 上被唤醒处理。

`adr` 就是被写字段 B 的地址。`adr >> 9` 算出这个字段落在哪张 card。**标记的是字段地址所在的 card，不是对象 obj 的起始 card。** 这引出一个问题：

**如果一个对象很大、横跨多张 card，只标记其中一张 card 够吗？**

比如对象 obj 大小 1000 字节，起始于 card 10 偏移 300 处，横跨了三张 card：

```
card 10: [obj header ... 前 212 字节]
card 11: [obj 中间 512 字节（有引用字段 ref_field）]
card 12: [obj 后 276 字节]

如果 ref_field 落在 card 11 内：
  obj.ref_field = target  →  barrier 标记 card 11 为 dirty（card 10 和 12 不标记）
```

card 11 被标记了，但 obj 的头不在 card 11 里（头在 card 10）。如果 GC 只扫 card 11 的 512 字节，找不到 obj 的起始地址，没法知道 obj 还有哪些引用字段需要处理——这就是问题所在。

**答案在于 BOT（Block Offset Table）**。被标记的是 card 11，但 GC 不是只扫 card 11。GC 的扫描路径是：

```
card_table[11] = dirty  →  从 card 11 的起始地址开始找对象
  → 查 BOT: BOT_table[card_11_start >> N] 返回偏移 = 300
    → 意思是"这个地址往前 300 字节才是对象头"
    → card_11_start - 300 = obj 的起始地址（在 card 10 内）
  → 从 obj 的头部开始扫描 obj 的全部引用字段
    → 找到 ref_field（在 card 11）、找到 other_field（在 card 12）...
    → obj 的所有引用字段都被扫到——不管字段落在 card 10/11/12 的哪个
  → 处理完 obj，obj 的实际大小 1000 字节 > card 大小 → BOT 知道下一个对象起始在哪
    → 继续扫描下一个对象
```

BOT（ch09/06 §4 讲过）存的不是 card 级映射，而是**每条地址线**的查询表。任何一个 card 区的中间地址去查 BOT，它都能告诉你"从这里往前多少字节到最近的对象起始位置"。正因为 BOT 能做到这一点，**一张脏卡就足以引导 GC 找到整个对象的全部引用字段**——不需要所有被对象跨越的 card 都被标记。

> **注意**：如果 mutator 后来修改了 obj 在 card 12 内的另一个引用字段，card 12 也会被单独标记——但卡 11 和 12 被标记的时间点不同。这不影响正确性，GC 扫描时查看的仅仅是"card 是不是 dirty"，对每张 dirty card 都做一次 BOT 查询，重复走到同一个对象头也没关系——已经扫过的对象会被 skipped。

**为什么需要两道？** 写前屏障保证并发标记"不漏"（不丢活对象），写后屏障保证 RSet "不假"（标记跨 Region 引用）。两道屏障各自生成数据——一个生成 SATB 条目的旧引用，一个生成脏卡记录——分别由两套独立的队列和线程系统处理。

**本节重点**：写后屏障产生的脏卡去哪了——由 `DirtyCardQueueSet` 收、由 `G1ConcurrentRefine` 管理的 refinement 线程处理。下面先讲 refinement 引擎，再讲两个 DCQ Set。

### 2.2 create()——一步创建整个引擎

`initialize_concurrent_refinement()` 只调了一行——`G1ConcurrentRefine::create()`（`g1CollectedHeap.cpp:1518-1522`）：

```cpp
jint G1CollectedHeap::initialize_concurrent_refinement() {
    jint ecode = JNI_OK;
    _cr = G1ConcurrentRefine::create(&ecode);
    return ecode;
}
```

`_cr` 是 `G1CollectedHeap` 的成员字段（`g1CollectedHeap.hpp:781`）：

```cpp
G1ConcurrentRefine* _cr;
```

`create()` 的完整流程（`g1ConcurrentRefine.cpp:277-303`）：

```cpp
G1ConcurrentRefine* G1ConcurrentRefine::create(jint* ecode) {
    // 1) 计算所有 zone 的初始值
    size_t min_yellow_zone_size = calc_min_yellow_zone_size();
    size_t green_zone = calc_init_green_zone();
    size_t yellow_zone = calc_init_yellow_zone(green_zone, min_yellow_zone_size);
    size_t red_zone = calc_init_red_zone(green_zone, yellow_zone);

    // 2) 构造对象
    G1ConcurrentRefine* cr = new G1ConcurrentRefine(
        green_zone, yellow_zone, red_zone, min_yellow_zone_size);

    // 3) 初始化线程控制——创建 N 个 refinement 线程
    *ecode = cr->initialize();
    return cr;
}
```

三步：算 zone → new 对象 → 创建线程。下面逐一展开。

### 2.3 三色区域模型——green / yellow / red

G1ConcurrentRefine 用三个数值把 **primary DCQ Set 的已完成 buffer 数量**分成四个区域（`g1ConcurrentRefine.hpp:90-92`）。衡量的不是某个线程的 `DirtyCardQueue`（线程本地队列），也不是 `DirtyCardQueueSet` 这个对象本身——而是 `G1BarrierSet::dirty_card_queue_set()._n_completed_buffers`[^1]，即全局 completed buffer 链表中攒了多少个满 buffer：

[^1]: 全局有两个 `DirtyCardQueueSet` 实例——`G1BarrierSet` 上的全局静态 primary 和 `G1CollectedHeap` 上的实例字段 secondary。zone 只衡量 primary 的 `_n_completed_buffers`（`PtrQueueSet` 的保护字段 `ptrQueue.hpp:268`，外部通过 `completed_buffers_num()` 方法读取），因为 secondary 只在 GC 暂停末尾临时使用，完成后立即 merge 回 primary。两道 DCQ Set 的完整对照见 [§3.1](#31-先搞清两个-dcq-set-是什么对照表)。

```
缓冲区数量（completed buffer 的 _n_completed_buffers）

  0 ───────────────── green_zone ────────── yellow_zone ──────────── red_zone ───
      绿色区域                      黄色区域                      红色区域

  绿色：什么都不做             黄色：逐步激活线程           红色：所有线程 + mutator 自救
  让脏卡在队列里积累           每个线程有各自的              mutator 自己处理 buffer
  利用缓存效果——同一张         激活/停用阈值                防止 infinite backlog
  卡可能被多次 dirty
```

**为什么要有绿色区域？** 一张 card 可能被 mutator 反复写——如果在 buffer 里多等一会儿，可能收到多次写操作，refinement 一次处理就覆盖了多次写入。如果一有脏卡就处理，同一张 card 可能被重复扫描。绿色区域给了脏卡"积累时间"，利用自然批处理。

> **注意区分**：这里的"缓存效果"是绿色区域的**自然批处理**——等 buffer 攒一攒再处理，不是 G1 中那两个显式的 card cache 数据结构：

| 名称 | ZBF | 访问路径 | 功能 | 何时使用 |
|------|-----|---------|------|---------|
| **绿色区批次** | — | refinement 线程取 buffer | 自然批处理，多次写入同一 card 合并为一次 refinement | buffer 在 completed list 中等待时 |
| **G1HotCardCache** | 固定数组 `_hot_cache[G1ConcRSLogCacheSize]` | post-write barrier 触发 | 拦截高频脏卡：当前 barrier 把 card 放入 cache 而非 DCQ；后续同一 card 的 barrier 看到 cache 已命中 → 跳过 slow path，降低屏障开销 | 运行时 mutator 持续写入 |
| **G1FromCardCache** | 2D 数组 `[region][worker]` | GC pause 中 RSet 扫描 | 记录每个 (Region, Worker) 对最近扫描过的卡；同一卡再次出现 → 已知已处理，跳过 | GC 暂停中 RSet 扫描 |

简单说：**HotCardCache 管"写"**（屏障侧减负）、**FromCardCache 管"扫"**（GC 侧去重）、**绿色区批次管"批"**（攒够了再处理）。三个都是为了避免重复处理同一张 card，但位置和机制完全不同。

**四个区域的说人话翻译**：

| 区域 | 范围 | 含义 |
|------|------|------|
| 绿色 | [0, green) | 还早，不处理——让脏卡攒一攒 |
| 黄色 | [green, yellow) | 开始处理——逐个唤醒 refinement 线程 |
| 红色 | [yellow, red) | 全力处理——所有 refinement 线程都醒着 |
| 超红 | [red, ∞) | 处理不过来——mutator 自己处理，别再加了 |

#### 2.3.1 green_zone 计算——等于 ParallelGCThreads

```cpp
// g1ConcurrentRefine.cpp:245-251
static size_t calc_init_green_zone() {
    size_t green = G1ConcRefinementGreenZone;     // JVM 标志，默认 0
    if (FLAG_IS_DEFAULT(G1ConcRefinementGreenZone)) {
        green = ParallelGCThreads;                // 未设标志 → 等于 STW worker 数
    }
    return MIN2(green, max_green_zone);           // 上限 max_green_zone
}
```

- 默认：`green = ParallelGCThreads`。4 核机器 → green = 4，8 核 → green = 8。
- 上限 `max_green_zone` 防止 green 无限大。
- `G1ConcRefinementGreenZone` 是全局标志（`g1_globals.hpp:127`），默认 0，`FLAG_IS_DEFAULT` 检查用户是否手动设过。

> **zone 的类型和单位**：三个 zone 都是 `size_t` 类型（`g1ConcurrentRefine.hpp:90-92`），衡量的是 primary DCQ Set 的 `_n_completed_buffers`——**completed buffer 的数量**，不是单张脏卡的数量。每个 completed buffer 最多容纳 256 张脏卡地址（`G1UpdateBufferSize = 256`），所以 `green = 8` 意味着绿色区域内最多攒 8 个满 buffer ≈ 2048 张脏卡。

#### 2.3.2 yellow_zone 计算——green × 2，有下限

```cpp
// g1ConcurrentRefine.cpp:253-264
static size_t calc_init_yellow_zone(size_t green, size_t min_size) {
    size_t config = G1ConcRefinementYellowZone;   // JVM 标志，默认 0
    size_t size = 0;
    if (FLAG_IS_DEFAULT(G1ConcRefinementYellowZone)) {
        size = green * 2;                         // 默认 size = green × 2
    } else if (green < config) {
        size = config - green;
    }
    size = MAX2(size, min_size);                  // 不低于 min_size
    size = MIN2(size, max_yellow_zone);           // 不超 max_yellow_zone
    return MIN2(green + size, max_yellow_zone);   // 注意: yellow = green + size
}
```

- 关键看最后一行——`return green + size`。`size` 是**黄色区宽度**，green 是绿色边界。**yellow 是绿色边界 + 黄色区宽度**。
- 默认 `size = green × 2`，所以 `yellow = green × 3`。
  - PT=8：green=8, size=16 → yellow = 8+16 = **24**（不是 16）。
  - PT=4：green=4, size=8 → yellow = 4+8 = **12**。

#### 2.3.3 red_zone 计算——yellow + (yellow - green)

```cpp
// g1ConcurrentRefine.cpp:266-275
static size_t calc_init_red_zone(size_t green, size_t yellow) {
    size_t size = yellow - green;                 // size = yellow 区宽度
    if (!FLAG_IS_DEFAULT(G1ConcRefinementRedZone)) {
        size_t config = G1ConcRefinementRedZone;
        if (yellow < config) {
            size = MAX2(size, config - yellow);
        }
    }
    return MIN2(yellow + size, max_red_zone);     // 注意: red = yellow + size
}
```

- 默认：`size = yellow - green`，`red = yellow + (yellow - green)` = green + 4×green = 5×green。
  - PT=8：green=8, yellow=24 → red = 24+16 = **40**。
  - PT=4：green=4, yellow=12 → red = 12+8 = **20**。

> **直观理解**：三个 zone 对称等距。yellow 在 green 和 red 的正中间——`yellow - green = red - yellow`。从绿色到黄色到红色，步长相同。

#### 2.3.4 min_yellow_zone_size——保证黄色区宽度

```cpp
// g1ConcurrentRefine.cpp:235-243
static size_t calc_min_yellow_zone_size() {
    size_t step = G1ConcRefinementThresholdStep;    // 默认 2
    uint n_workers = G1ConcRefinementThreads;       // 默认 = ParallelGCThreads
    return step * n_workers;
}
```

- `min_yellow_size = 2 × G1ConcRefinementThreads`。
  - PT=8 → min_yellow = 16。
  - PT=4 → min_yellow = 8。

- 这个下限的意义：黄色区域内要容纳 `n_workers` 个线程各自的激活阈值（每个线程的阈值在 yellow 区间内等差阶梯分布，详见 §2.5.1）。如果 yellow 太窄，后续线程的激活阈值会塌到 green，失去"逐个唤醒"的效果。

#### 2.3.5 默认值速查

以 ParallelGCThreads = 8 为例（8 核机器）：

```
G1ConcRefinementThresholdStep = 2
G1ConcRefinementThreads       = 8

min_yellow = 2 × 8 = 16
green      = 8
yellow     = green + size
           = 8 + MAX(8×2, 16)
           = 8 + MAX(16, 16)
           = 24
red        = yellow + (yellow - green)
           = 24 + 16
           = 40
```

三层台阶：`0 ─(8)─ 绿色边界 ─(16)─ 黄色边界 ─(16)─ 红色边界`

绿色区 8 个 buffer，黄色区 16 个 buffer，红色区 16 个 buffer——黄色区和红色区宽度相同（都是 `green × 2`）。

### 2.4 G1ConcurrentRefine 构造函数——只存值，不做复杂事

`new G1ConcurrentRefine(...)` 的构造函数（`g1ConcurrentRefine.cpp:218-229`）：

```cpp
G1ConcurrentRefine::G1ConcurrentRefine(size_t green_zone,
                                       size_t yellow_zone,
                                       size_t red_zone,
                                       size_t min_yellow_zone_size) :
    _thread_control(),                     // 空构造
    _green_zone(green_zone),
    _yellow_zone(yellow_zone),
    _red_zone(red_zone),
    _min_yellow_zone_size(min_yellow_zone_size)
{
    assert_zone_constraints_gyr(green_zone, yellow_zone, red_zone);
}
```

很简单：`_thread_control` 默认构造（全 NULL），四个 zone 存入字段。不创建线程——线程在 `initialize()` 里创建。

### 2.5 initialize()——创建 refinement 线程

`cr->initialize()` 委托给 `G1ConcurrentRefineThreadControl::initialize()`（`g1ConcurrentRefine.cpp:277-303`）：

```cpp
// g1ConcurrentRefine.cpp:277-303
jint G1ConcurrentRefine::initialize() {
    return _thread_control.initialize(this, max_num_threads());
}
```

`max_num_threads()` 返回 `G1ConcRefinementThreads` 标志值（`g1_globals.hpp:201`），默认由 `g1Arguments.cpp:86-88` 在运行时设为 `ParallelGCThreads`。

`ThreadControl::initialize()` 的完整实现（`g1ConcurrentRefine.cpp:69-92`）：

```cpp
jint G1ConcurrentRefineThreadControl::initialize(
    G1ConcurrentRefine* cr, uint num_max_threads) {

    _cr = cr;
    _num_max_threads = num_max_threads;

    // 1) 分配线程指针数组——N 个槽位
    _threads = NEW_C_HEAP_ARRAY_RETURN_NULL(
        G1ConcurrentRefineThread*, num_max_threads, mtGC);
    if (_threads == NULL) {
        return JNI_ENOMEM;
    }

    // 2) 创建线程
    for (uint i = 0; i < num_max_threads; i++) {
        if (UseDynamicNumberOfGCThreads && i != 0) {
            _threads[i] = NULL;              // 延迟创建——先搁置
        } else {
            _threads[i] = create_refinement_thread(i, true);  // 立即创建
        }
    }
    return JNI_OK;
}
```

**两种创建策略**：

- **`UseDynamicNumberOfGCThreads = false`**（用户明确关闭动态线程数时）：所有 N 个线程全量创建。
- **`UseDynamicNumberOfGCThreads = true`**（默认）：只创建线程 0，其余线程延迟创建。
  - 线程 0 是 **primary 线程**，必然存在。它等待的 monitor 和其他线程不同（见 §2.5.2）。
  - 线程 1..N-1 按需创建——当队列积压到需要它们的激活阈值时才 `create_refinement_thread(i, false)`。

`create_refinement_thread(i, true)` 创建单个线程（`g1ConcurrentRefine.cpp:39-50`）：

```cpp
G1ConcurrentRefineThread* G1ConcurrentRefineThreadControl::create_refinement_thread(
    uint worker_id, bool initializing) {
    G1ConcurrentRefineThread* result = NULL;
    if (initializing || !InjectGCWorkerCreationFailure) {
        result = new G1ConcurrentRefineThread(_cr, worker_id);
    }
    if (result == NULL || result->osthread() == NULL) {
        log_warning(gc)("Failed to create refinement thread %u", worker_id);
    }
    return result;
}
```

`G1ConcurrentRefineThread` 的构造函数内部调了 `create_and_start()`（`g1ConcurrentRefineThread.cpp:56`）——所以 `new G1ConcurrentRefineThread(...)` 时 OS 线程就被创建并启动了。但线程启动后第一件事是进入 `wait_for_completed_buffers()` 睡觉——等着 `_monitor->notify()` 叫醒它。具体循环见 §2.5.2。

### 2.5.1 每个线程的激活/停用阈值——等差阶梯

N 个 refinement 线程均匀覆盖 yellow 区间。`calc_thresholds()` 计算每个线程的激活停用阈值（`g1ConcurrentRefine.cpp:199-216`）：

```
yellow_size = yellow_zone - green_zone          // 黄色区宽度
step = yellow_size / num_max_threads()          // 每线程的步长

// 线程 0 特殊：step_0 = MIN(step, ParallelGCThreads/2)
// → 线程 0 比普通线程更早被激活

// 线程 i 的激活阈值（需要多少 buffer 才叫醒线程 i）
activation_threshold(i) = green_zone + ceil(step × (i+1))

// 线程 i 的停用阈值（buffer 降到多少以下线程 i 回去睡觉）
deactivation_threshold(i) = green_zone + floor(step × i)
```

以 8 核为例（green=8, yellow=24, red=40, num=8）：

| 线程 | 停用阈值 | 激活阈值 | 说明 |
|------|---------|---------|------|
| 0 (primary) | 8 | 10 | yellow 区第一个被激活 |
| 1 | 10 | 12 | |
| 2 | 12 | 14 | |
| 3 | 14 | 16 | |
| 4 | 16 | 18 | |
| 5 | 18 | 20 | |
| 6 | 20 | 22 | |
| 7 | 22 | 24 | 最后一个线程在 yellow 边界被激活 |

> **线程 0 特殊处理的直觉**：默认配置下 `step = yellow_size / max_threads = 2g / g = 2`，和 PT 数无关（green 和 max_threads 都等于 PT）。`MIN(step, PT/2)` 在默认值下永远选 step（2 < PT/2 for any PT > 4），不影响阈值分布。这个特殊处理只对用户手动设置了极大的 yellow zone 时生效——防止 step 因 yellow 过宽而变得过大，导致线程 0 等到太晚才被激活。

### 2.5.2 线程生命周期——睡觉 → 被叫醒 → 处理 → 回去睡

每个 `G1ConcurrentRefineThread` 的入口是 `run_service()`（`g1ConcurrentRefineThread.cpp:92-138`）：

```cpp
void G1ConcurrentRefineThread::run_service() {
    while (!should_terminate()) {
        wait_for_completed_buffers();          // 在 monitor 上睡觉
        if (should_terminate()) break;

        SuspendibleThreadSetJoiner sts_join;   // 加入可暂停线程集

        while (!should_terminate()) {
            if (sts_join.should_yield()) {     // STW 来了？
                sts_join.yield();              // 让出控制权
                continue;
            }
            if (!_cr->do_refinement_step(_worker_id)) {  // 处理一个 buffer
                break;                         // 低于停用阈值，回去睡觉
            }
        }
    }
}
```

**怎么睡觉——`wait_for_completed_buffers()`**（`g1ConcurrentRefineThread.cpp:59-64`）：

```cpp
void G1ConcurrentRefineThread::wait_for_completed_buffers() {
    MutexLockerEx x(_monitor, Mutex::_no_safepoint_check_flag);
    while (!should_terminate() && !is_active()) {
        _monitor->wait(Mutex::_no_safepoint_check_flag);
    }
}
```

**primary 和非 primary 的差异不在睡觉方式上——都在各自的 `_monitor` 上 `wait()`**。差异在两点：

**差异 1：`_monitor` 的初始化不同**（`g1ConcurrentRefineThread.cpp:35-52`）：

```cpp
G1ConcurrentRefineThread::G1ConcurrentRefineThread(G1ConcurrentRefine* cr, uint worker_id) {
    if (!is_primary()) {
        _monitor = new Monitor(Mutex::nonleaf, "Refinement monitor",
                               true, Monitor::_safepoint_check_never);
    } else {
        _monitor = DirtyCardQ_CBL_mon;  // primary 的 monitor 就是 DCQ set 的 CBL_mon
    }
}
```

- Primary 的 `_monitor` = `DirtyCardQ_CBL_mon` —— DCQ 在 buffer 满时调 `_cbl_mon->notify()`，直接唤醒 primary。
- 非 primary 的 `_monitor` = 各自 new 的独立 monitor —— 只能被 `activate()` 唤醒。

**差异 2：`is_active()` 的实现不同**（`g1ConcurrentRefineThread.cpp:66-69`）：

```cpp
bool G1ConcurrentRefineThread::is_active() {
    DirtyCardQueueSet& dcqs = G1BarrierSet::dirty_card_queue_set();
    return is_primary() ? dcqs.process_completed_buffers() : _active;
}
```

- Primary：读 `dcqs.process_completed_buffers()`——DCQ Set 的 `_process_completed` 标志（buffer 数量达 yellow 时置 true）。
- 非 primary：读自己的 `_active` 成员——上一级线程通过 `activate()` 置 true。

**怎么被叫醒——`activate()`**（`g1ConcurrentRefineThread.cpp:71-80`）：

```cpp
void G1ConcurrentRefineThread::activate() {
    MutexLockerEx x(_monitor, Mutex::_no_safepoint_check_flag);
    if (!is_primary()) {
        set_active(true);                      // 置自己的 _active = true
    } else {
        dcqs.set_process_completed(true);       // 置 DCQ 的 _process_completed = true
    }
    _monitor->notify();                         // 唤醒等在 _monitor 上的线程
}
```

**完整唤醒链**：

```
mutator buffer 满 → enqueue_complete_buffer()
  → _n_completed_buffers >= yellow
    → _process_completed = true
      → _cbl_mon->notify()
        → primary 线程 _monitor->wait() 被叫醒
          → is_active() = dcqs.process_completed_buffers() = true → 跳出 wait 循环
            → 开始处理
              → 处理不过来了 → maybe_activate_next(0)
                → thread[1].activate()
                  → _active = true + _monitor.notify()
                    → thread[1] _monitor->wait() 被叫醒
                      → is_active() = _active = true → 跳出 wait 循环
                        → 开始处理
```

### 2.6 自适应调整——GC pause 后重算 zone

初始化算的 zone 是初值，后续每次 GC 暂停后 G1Policy 会根据实际耗时调整（`g1ConcurrentRefine.cpp:379-407`）：

```cpp
void G1ConcurrentRefine::adjust(double update_rs_time,
                                size_t update_rs_processed_buffers,
                                double goal_ms) {
    DirtyCardQueueSet& dcqs = G1BarrierSet::dirty_card_queue_set();

    if (G1UseAdaptiveConcRefinement) {
        update_zones(update_rs_time, update_rs_processed_buffers, goal_ms);

        if (max_num_threads() == 0) {
            dcqs.set_process_completed_threshold(INT_MAX);
        } else {
            size_t activate = activation_threshold(0);          // primary 线程的激活阈值
            dcqs.set_process_completed_threshold((int)activate); // 不是 yellow_zone
        }
        dcqs.set_max_completed_queue((int)red_zone());
    }

    // completed_queue_padding：防止 GC 暂停刚结束时 buffer 骤降导致线程提前停用
    size_t curr = dcqs.completed_buffers_num();
    if (curr >= yellow_zone()) {
        dcqs.set_completed_queue_padding(curr);
    } else {
        dcqs.set_completed_queue_padding(0);
    }
    dcqs.notify_if_necessary();
}
```

**关键细节**：`process_completed_threshold` 被设为 `activation_threshold(0)`（primary 线程的激活阈值，默认 ~10），而不是 `yellow_zone()`（默认 ~24）。原因：primary 线程的 `is_active()` 判断就是 `dcqs.process_completed_buffers()`——设 `activation_threshold(0)` 让 primary 在达到自己的激活阈值时就被唤醒，而不是等到全部 yellow 区填满。`max_completed_queue` 仍用 `red_zone()`。

详细的调整算法属于 G1Policy 篇章。

### 2.7 G1ConcurrentRefine 字段速查

| 字段 | 类型 | 含义 |
|------|------|------|
| `_thread_control` | `G1ConcurrentRefineThreadControl` | 管理 N 个 refinement 线程 |
| `_green_zone` | `size_t` | 绿色边界 |
| `_yellow_zone` | `size_t` | 黄色边界 |
| `_red_zone` | `size_t` | 红色边界 |
| `_min_yellow_zone_size` | `size_t` | 黄色区最小宽度 |

### 2.8 关键 JVM 标志速查

| 标志 | 默认 | 含义 |
|------|------|------|
| `G1ConcRefinementThreads` | = ParallelGCThreads | 最大 refinement 线程数 |
| `G1ConcRefinementGreenZone` | 0 → 运行时 = PT | 绿色边界 |
| `G1ConcRefinementYellowZone` | 0 → 运行时 = green×2 | 黄色边界 |
| `G1ConcRefinementRedZone` | 0 → 运行时计算 | 红色边界 |
| `G1ConcRefinementThresholdStep` | 2 | 线程间 step 步长 |
| `G1UseAdaptiveConcRefinement` | true | 是否自动调整 zone |
| `UseDynamicNumberOfGCThreads` | true | 是否延迟创建非 primary 线程 |

---

## 3. 两道 DirtyCardQueueSet

ConcurrentRefinement 创建好后，代码紧接着初始化两个 `DirtyCardQueueSet`。两个 set 虽然类型相同，角色完全不同——一个在 `G1BarrierSet` 上（全局静态），一个在 `G1CollectedHeap` 上（实例字段）。

### 3.1 先搞清两个 DCQ Set 是什么——对照表

在 [ch09/04a §5.2](04a-g1-heap-constructor.md) 已讲过一个 `_dirty_card_queue_set`——那是 `G1CollectedHeap` 的实例字段。本节和另一个静态实例一起讲清楚两个的区别和分工：

| 维度 | G1BarrierSet（barrier 端 primary） | G1CollectedHeap（GC 端 secondary） |
|------|----------------------------------|----------------------------------|
| **存放位置** | `G1BarrierSet::_dirty_card_queue_set`，**全局静态** | `G1CollectedHeap::_dirty_card_queue_set`，**实例字段** |
| **定义** | `g1BarrierSet.hpp:43` | `g1CollectedHeap.hpp:766` |
| **fl_owner** | 自己（`NULL → this`） | 指向 primary（共享 free list） |
| **process_completed_threshold** | yellow_zone()（动态） | -1（永不触发） |
| **max_completed_queue** | red_zone()（动态） | -1（无上限） |
| **FreeIdSet** | 有 | 无 |
| **角色** | mutator 和 refinement 线程的中心——接收 mutator 的 dirty card、分发给 refinement 处理 | **Redirty** 专用的临时容器——GC 暂停末尾重新标记脏卡，暂停结束后合并回 primary |
| **谁写入** | mutator 线程（写屏障 buffer） | GC worker 线程（RedirtyLoggedCard 闭包） |
| **谁读取** | refinement 线程 + GC worker（scan_rem_set） | primary（通过 merge_bufferlists） |

### 3.2 为什么需要两道？——GC 暂停期间的 card 临时日志

**结论先行**：GC 暂停期间，所有 worker 产生的 card——不管是正常撤离还是撤离失败——都走 secondary DCQ。区别只在于正常撤离已经标过 dirty（`mark_card_deferred`），redirty 时只需要搬 buffer；撤离失败没标过，redirty 时需要补标。

下面是每一步的源码证据。

**第一步：GC worker 的本地队列指向 secondary。** `G1ParScanThreadState` 构造时（`g1ParScanThreadState.cpp:43`）：

```cpp
_dcq(&g1h->dirty_card_queue_set())   // g1h->dirty_card_queue_set() = secondary DCQ
```

这里 `_dcq` 的类型是 `DirtyCardQueue`（线程本地队列，`g1ParScanThreadState.hpp:48`），**不是 `DirtyCardQueueSet`**。`enqueue(card_addr)` 写的是这个本地队列的 `_buf` 数组——不是直接写到 DCQ Set。本地 buffer 满了之后，`handle_zero_index()` 才把 buffer 包装成 `BufferNode`，挂到 `_dcq._qset` 的 completed list 尾部。而 `_dcq._qset` 就是构造时传入的 **secondary DCQ Set**。所以"走 secondary"说的是**最终目的地**是 secondary DCQ Set 的 completed list。同样，mutator 写屏障 `enqueue()` 写的也是线程本地队列，满了交到 **primary DCQ Set**——本文 §3.3.0 已经讲过这层关系。

**第二步：正常撤离时，card 走 secondary。** `g1ParScanThreadState.hpp:114-126`：

```cpp
if (ct()->mark_card_deferred(card_index)) {      // ← 已经在 card table 上标 dirty 了
    dirty_card_queue().enqueue(card_addr);        // ← 入队 secondary DCQ（本地 buffer）
}
```

`mark_card_deferred` 是原子写入 card table。`dirty_card_queue()` 返回的就是第一步构造的 `_dcq`——它的 `_qset` 是 secondary。所以正常撤离时：**先标 dirty，再入队 secondary**。

**第三步：撤离失败时，card 也走 secondary。** `g1EvacFailure.cpp:206`：

```cpp
_dcq(&_g1h->dirty_card_queue_set())   // 同样的 secondary DCQ
```

区别是——失败路径**只入队、不标 dirty**。没有 `mark_card_deferred` 这步，因为失败处理的逻辑不调 barrier。

**第四步：暂停末尾，本地 buffer 全部 flush 到 secondary。** GC worker 的 `DirtyCardQueue` 析构时（`dirtyCardQueue.cpp:129-133`）调 `flush()` → `flush_impl()` → `enqueue_complete_buffer()`——所有残留在本地 buffer 里的 card 全数交到 secondary 的 completed list。mutator 方的本地队列也由 `concatenate_logs()` 在同一时间 flush 到 primary。

**第五步：redirty 处理 secondary，搬到 primary。** `g1CollectedHeap.cpp:3696-3708`：

```
redirty_logged_cards()
  → reset_for_par_iteration()                         ← 初始化并行迭代
  → workers()->run_task(&redirty_task)                 ← 多 GC worker 并行
       → par_apply_closure_to_all_completed_buffers(&cl)
            → 对每条 card 调用 RedirtyLoggedCardTableEntryClosure:
                  if (!will_become_free(hr))            ← 卡所在 Region 不会被释放
                      card_table[x] = 0                 ← 标 dirty（已标过的这里就是空操作）
  → merge_bufferlists(&secondary)                      ← 所有 buffer 搬到 primary
  → assert(secondary._n_completed_buffers == 0)         ← secondary 已清空
```

正常撤离的 card：已被 `mark_card_deferred` 标过 → `card_table[x] = 0` 是空操作。撤离失败的 card：没标过 → 真正补标。

**完整时序**：

```
═══════════ GC 暂停开始 ═══════════

正常撤离:
  mark_card_deferred(card) + _dcq.enqueue(card)  ← 标 dirty + 记到 secondary
撤离失败:
  _dcq.enqueue(card)                              ← 只记到 secondary，不标 dirty

═══════════ 撤离完毕 ═══════════

GC worker._dcq 析构 → flush() → 本地残留全部入队 secondary

redirty_logged_cards():
  → 正常撤离 card: 已经 dirty，只需搬 buffer 到 primary
  → 失败撤离 card: 补标 dirty + 搬 buffer 到 primary
  → secondary 清空

═══════════ GC 暂停结束 ═══════════

primary._n_completed_buffers 增加 → 达 yellow → notify refinement 正常处理
```

**两道 DCQ 的价值**：暂停期间所有 card 走 secondary（临时记事本），暂停末尾统一 merge 到 primary（常驻中心）。primary 的 zone 统计始终只反映 mutator barrier 的正常流量，不受 GC 内部 card 的影响。

#### 3.2.1 汇总：到底有几个 DCQ Set、几条 DirtyCardQueue

| 谁 | 类型 | `_qset` 指向 | 角色 |
|----|------|-------------|------|
| mutator（每个应用线程） | 1 条 `DirtyCardQueue`，TLS | `primary` | 生产者——写 barrier 时记录脏卡 |
| GC Worker（STW 撤离线程，每个 Worker） | 1 条 `DirtyCardQueue`，`Pss._dcq` | `secondary` | 生产者——撤离更新引用时记录脏卡 |
| 非 Java 线程（VM/Service 线程） | 1 条共享 `DirtyCardQueue`，`primary._shared_dirty_card_queue` | `primary` | 生产者——无 TLS，走共享队列 |
| refinement 线程（并发） | 无 | — | 消费者——从 primary 的 completed list 取 buffer 处理 |
| 并发 GC 线程（并发标记） | 无 | — | 消费者——处理 SATB 队列，不走 DCQ |

只有 **2 个 `DirtyCardQueueSet`**：primary（`G1BarrierSet` 全局静态）和 secondary（`G1CollectedHeap` 实例字段）。**N 条 `DirtyCardQueue`** 分布在各处——但每一条都只归属到这两个 `DirtyCardQueueSet` 之一。

GC Worker 是 STW 暂停内执行撤离的线程（`ParallelGCThreads`），不是并发 refinement 线程（`G1ConcRefinementThreads`）也不是并发标记线程（`ConcGCThreads`）。

> **secondary DCQ Set 不是第三个 DCQ Set。** 它正是 `G1CollectedHeap::_dirty_card_queue_set`——[§3.1](#31-先搞清两个-dcq-set-是什么对照表) 对照表中 GC 端的那个实例字段。全部只有两个 `DirtyCardQueueSet`：primary（`G1BarrierSet` 全局静态）用于 mutator barrier，secondary（`G1CollectedHeap` 实例字段）就是这里讲的红化临时容器。

### 3.3 barrier 端 DCQ Set——mutator 和 refinement 的中心

初始化源码（`g1CollectedHeap.cpp:1694-1700`）：

```cpp
G1BarrierSet::dirty_card_queue_set().initialize(
    DirtyCardQ_CBL_mon,                          // [1] completed buffer list 的锁
    DirtyCardQ_FL_lock,                          // [2] buffer free list 的锁
    (int)concurrent_refine()->yellow_zone(),     // [3] 处理触发阈值 = yellow
    (int)concurrent_refine()->red_zone(),        // [4] max queue 长度 = red
    Shared_DirtyCardQ_lock,                      // [5] 非 Java 线程的 shared DCQ 锁
    NULL,                                        // [6] fl_owner=NULL → 自己管 free list
    true                                         // [7] 创建 FreeIdSet
);
```

#### 3.3.0 前置：DCQ 的三层结构——BufferNode、两条链表、线程本地队列

在逐参数解释之前，先搞清楚 `DirtyCardQueueSet` 内部管理的数据结构。`initialize()` 的每个参数都服务于下面这张图里的某个组件。

先从全景看三层是什么关系：

```
┌─ G1BarrierSet::_dirty_card_queue_set (primary DCQ Set) ──────────────────────┐
│                                                                               │
│   ┌─ completed buffer list (FIFO, _cbl_mon 保护) ───────────────┐            │
│   │  head → [Node A] → [Node B] → [Node C] → tail               │            │
│   │          ↑ 满了的 buffer，等待 refinement 处理               │            │
│   └──────────────────────────────────────────────────────────────┘            │
│                                                                               │
│   ┌─ buffer free list (LIFO, _fl_lock 保护) ─────────────────────┐           │
│   │  _buf_free_list → [Node X] → [Node Y] → NULL                 │           │
│   │                   处理完的 buffer，留给后续 allocate 复用    │           │
│   └──────────────────────────────────────────────────────────────┘            │
│                         ↑ deallocate_buffer                  ↑ allocate_buffer│
│                         │                                    │               │
│   ┌──────────────────────│────────────────────────────────────│───────────┐   │
│   │  线程 A DirtyCardQueue │      线程 B DirtyCardQueue       │            │   │
│   │  _buf → [▨][▨]...[ ]  │    _buf → [▨][▨]...[▨]           │            │   │
│   │  _index = 1024         │    _index = 0 → handle_zero_index│            │   │
│   │  _qset → 这个 DCQ Set  │    _qset → 这个 DCQ Set          │            │   │
│   └────────────────────────┴─────────────────────────────────┴────────────┘   │
└───────────────────────────────────────────────────────────────────────────────┘
```

- 每个 Java 线程有自己的 `DirtyCardQueue`，`_qset` 指向同一个 primary DCQ Set
- `_buf` 往 buffer 里写 card 地址，`_index` 递减，到 0 即为满
- 满了的 `_buf` 包装成 `BufferNode` → 挂到 completed list 尾部
- refinement 线程从 completed list 头部取 Node → 处理 → 归还到 free list
- 新线程需要 buffer 时从 free list 头部取（没有就 new）

下面逐层展开内部细节。

**第一层：BufferNode——buffer 和链表节点的合一**（`ptrQueue.hpp:214-253`）。

`BufferNode` 不是一个独立包裹 buffer 的对象——分配时 Node 头和 buffer 数组一起 `malloc`，两者始终紧挨在一起：

```
低地址                                         高地址
┌──────────────────────┬──────────────────────────────────────┐
│ BufferNode 头部       │  _buffer 数组                        │
│ ┌────────┬─────────┐ │  ┌───────┬───────┬───┬───────────┐  │
│ │_index  │ _next   │ │  │ [0]   │ [1]   │…  │ [255]     │  │
│ │(8B)    │ (8B)    │ │  │ void* │ void* │   │ void*     │  │
│ └────────┴─────────┘ │  └───────┴───────┴───┴───────────┘  │
│       16 字节         │            256 × 8B = 2KB           │
└──────────────────────┴──────────────────────────────────────┘
```

算一下：头部 + 256 × 8 = 2064 字节。`make_node_from_buffer(buf)` 返回 `(char*)buf - offsetof(BufferNode, _buffer)`——拿到 buffer 地址就能反推 Node 地址，反过来 `make_buffer_from_node(node)` 做 `(char*)node + offsetof(...)` 拿到 buffer 地址。**同一个内存块，两个视角**——PtrQueue 看到的是 `void**` 数组，链表看到的是 `BufferNode*`。

> **`_buf` 和 `_buffer` 是同一块内存的两种叫法**。`_buf` 是 PtrQueue 的字段名（`void**` 指针），`_buffer` 是 BufferNode 的字段名（数组）。线程本地的 `PtrQueue._buf` 指向的就是所属 BufferNode 的 `_buffer[0]` 地址——等价于 `_buf = &node._buffer[0]`。PtrQueue 往 `_buf` 里写 card 地址，refinement 从 `_buffer` 的同位置读取。两个名字、同一块内存区域。

- **`_index`**（BufferNode 侧）：**续读位置**。和 PtrQueue 的同名字段含义完全相反。在 PtrQueue 里 `_index` 是"还剩多少字节空间"（从 2048 递减到 0，到 0 说明满了），在 BufferNode 里 `_index` 是"从哪个下标开始读"（从 0 递增到 buffer_size）。满 buffer 转换时：

  ```
  新鲜的空 buffer（`_buf` 和 `_buffer` 是同一块内存——写和读都在这里）：
    PtrQueue._buf 指向数据区开头（也就是 &node._buffer[0]）
    PtrQueue._index = 256×8 = 2048  ← "还剩 2048 字节 = 256 个槽位可写"

  写入第 1 条 card：
    _index -= 8 → 2040
    _buf[2040/8] = _buf[255] = cardA    ← 写的是 _buffer[255]

  写入第 2 条 card：
    _index -= 8 → 2032
    _buf[2032/8] = _buf[254] = cardB    ← 写的是 _buffer[254]

  写入第 256 条 card：
    _index -= 8 → 0
    _buf[0/8] = _buf[0] = cardZ         ← 写的是 _buffer[0]
    _index = 0 → 满了，不能再写了！

  handle_zero_index() 转换：
    make_node_from_buffer(_buf, 0)       ← 用 _buf 地址反推 BufferNode
    → node._index = 0                    ← 转换：字节偏移 0 → 元素下标 0

  BufferNode 读取阶段（refinement 操作的是 node._buffer）：
    node._index = 0   → 从 _buffer[0] 开始读
    node._index 递增   → refinement 读完一条就往前推进一个
    node._index = 256  → 等于 buffer_size，"全部处理完" → 归还 free list
  ```

  关键：`_buf` 和 `_buffer` 是同一块内存区域，PtrQueue 往里写 card 地址，refinement 从同一位置读。`PtrQueue._index` 是**写指针**（还剩多少字节空间，递减），`BufferNode._index` 是**读指针**（处理到哪个下标了，递增）。同是 0，在 PtrQueue 侧表示"没空间、满了"，到 BufferNode 侧变成"从第 0 个元素开始读"。

- **`_next`**：单向链表指针，串联成 completed list 或 free list。

**第二层：两条链表**（`ptrQueue.hpp:264-279`）。

两条链表都是单向 `BufferNode` 链表，但操作方式不同：

| 链表 | 操作方式 | 锁 | 生产者 | 消费者 |
|------|---------|-----|--------|--------|
| completed list | FIFO（尾部插入，头部取出） | `_cbl_mon`（Monitor） | mutator `handle_zero_index` | refinement 线程 |
| free list | LIFO（头部插入，头部取出） | `_fl_lock`（Mutex） | refinement 处理完归还 | mutator 需要新 buffer 时 |

`completed list` 的入队逻辑（`ptrQueue.cpp:224-245`）—```cpp
// 把 node 挂到链表尾部
if (_completed_buffers_tail == NULL) {
    _completed_buffers_head = _completed_buffers_tail = node;
} else {
    _completed_buffers_tail->set_next(node);
    _completed_buffers_tail = node;
}
_n_completed_buffers++;
// 达到阈值 → 唤醒 refinement
if (_n_completed_buffers >= _process_completed_threshold && _notify_when_complete) {
    _cbl_mon->notify();
}
```

`free list` 的头插操作（`ptrQueue.cpp:147-152`）—```cpp
node->set_next(_buf_free_list);
_buf_free_list = node;
_buf_free_list_sz++;
```

多个 DCQ Set 可以通过 `_fl_owner` 共享同一条 free list——primary DCQ 自己拥有（`_fl_owner = this`），secondary DCQ 借用 primary 的（`_fl_owner = &primary`）。

**第三层：线程本地的 DirtyCardQueue**（`ptrQueue.hpp:91-92`, `dirtyCardQueue.hpp:44-66`）。

每个 Java 线程通过 `G1ThreadLocalData::dirty_card_queue(thread)` 获得自己的 `DirtyCardQueue`：

```
DirtyCardQueue（线程本地，继承自 PtrQueue）
  _buf → BufferNode._buffer 的视图 (void** 数组，256 个槽位)
  _index → 字节偏移，从 2048 递减到 0
  _qset → 指向 primary DCQ Set（决定 buffer 从哪分配、满了往哪交）
  _active → true（DirtyCardQueue 默认活跃，构造时传 active=true）
```

`_buf` 里存的不是 card index 整数，而是 **card table 中对应字节的地址**（`jbyte*` 指针）——源码 `g1BarrierSet.cpp:107` 的 `enqueue(byte)`，`byte` 就是 `_card_table->byte_for(field)` 返回的 card 字节指针，例如 `0x7f00a3c01020`。refinement 拿到这个指针后直接 `*card_ptr = dirty_card_val()` 就能操作 card table。

**写入方向——从尾巴往前写**。`_index` 从 `capacity_in_bytes()` (= 2048) 开始，每写一条减 8（`_element_size`）。第一次写 `_buf[255]`，第二次写 `_buf[254]`……到最后一次写 `_buf[0]`，`_index` 变为 0：

```
初始（空）:                   写入 1 条后:
  _index = 2048                 _index = 2040 = 255×8
  _buf[0..255] 全空              _buf[255] = card_addr
                                _buf[0..254] 未使用

写入 256 条后（满）:
  _index = 0
  _buf[0..255] 全部有数据
  → 触发 handle_zero_index()
```

**完整数据流**：

```
写屏障 → 线程本地 DirtyCardQueue.enqueue(card_addr)
  → _index -= 8, _buf[_index/8] = card_addr              // 从尾巴往前写
  → _index == 0（buffer 满）→ handle_zero_index()
    → make_node_from_buffer(_buf, index())                // 包装成 BufferNode
    → process_or_enqueue_complete_buffer(node)
      → _n_completed_buffers >= red_zone → mut_process_buffer（自救）
      → 否则 → enqueue_complete_buffer：挂到 completed list 尾部
      → _n_completed_buffers++ → 达 yellow → notify refinement
    → allocate_buffer：从 free list 头部取（空则 new）新 _buf
    → reset：_index = 2048，继续写

refinement 线程
  → 从 completed list 头部取 BufferNode
  → apply_closure_to_buffer：从 node->_index 到 buffer_size 逐条 card 处理
  → 全部处理完 → deallocate_buffer：挂回 free list 头部
```

下面逐个解释 `initialize()` 的 7 个参数——每一个都对应图中某个结构。

#### 3.3.1 参数 [1] DirtyCardQ_CBL_mon——保护 completed buffer 链表

`DirtyCardQ_CBL_mon` 是 `Monitor`（非普通 Mutex，支持 wait/notify）。定义在 `mutexLocker.cpp:216`：

```cpp
def(DirtyCardQ_CBL_mon, PaddedMonitor, access, true, Monitor::_safepoint_check_never);
```

- **类型**：`PaddedMonitor`（带缓存行填充，避免伪共享）
- **排名**：`access`
- **用途**：保护 completed buffer 链表的插入/取出。当 buffer 数达到阈值时，用它叫醒 primary refinement 线程（前面 §2.5.2 讲过——primary 线程就在这个 monitor 上 `wait()`）。

#### 3.3.2 参数 [2] DirtyCardQ_FL_lock——保护 buffer free list

```cpp
def(DirtyCardQ_FL_lock, PaddedMutex, access, true, Monitor::_safepoint_check_never);
```

- **类型**：`PaddedMutex`
- **用途**：保护 buffer 的空闲链表 `_buf_free_list`。分配 buffer 和归还 buffer 都要持此锁。

#### 3.3.3 参数 [3][4] yellow_zone 和 red_zone——和 refinement 联动的阈值

```
process_completed_threshold = yellow_zone    ← 何时唤醒 refinement 线程
max_completed_queue         = red_zone       ← 何时 mutator 自己处理
```

这两个值**来自 ConcurrentRefinement**（刚刚创建完毕）。只要 `_n_completed_buffers` 超过 yellow，refinement 线程就被唤醒；超过 red，mutator 在 buffer 满了时不入队，自己调 `mut_process_buffer()` 直接处理——这就是前面 §2.3 三色模型的实现。

这两个值后续每次 GC 暂停后通过 `G1ConcurrentRefine::adjust()` 动态更新——不是构造时写死的。

#### 3.3.4 参数 [5] Shared_DirtyCardQ_lock——非 Java 线程的脏卡入队

```cpp
def(Shared_DirtyCardQ_lock, PaddedMutex, access + 1, true, Monitor::_safepoint_check_never);
```

- **排名**：`access + 1`（比前两个锁高一级，避免死锁——如果需要同时持有 Shared 和 FL/CBL，必须先拿高排名的 Shared，再拿低排名的 FL/CBL）
- **用途**：非 Java 线程（VM 线程、Service 线程等）没有 TLS buffer，它们的脏卡通过 `_shared_dirty_card_queue` 入队，持这个锁保护。

#### 3.3.5 参数 [6] fl_owner = NULL

`ptrQueue.cpp:124`：

```cpp
_fl_owner = (fl_owner != NULL) ? fl_owner : this;
```

`NULL → this`，意味着 primary DCQ Set **自己管理自己的 free list**。其他 DCQ Set（GC 端）可以借用它的 free list——见 §3.4.3。

#### 3.3.6 参数 [7] init_free_ids = true

`DirtyCardQueueSet::initialize()` 末尾（`dirtyCardQueue.cpp:163-165`）：

```cpp
if (init_free_ids) {
    _free_ids = new FreeIdSet(num_par_ids(), _cbl_mon);
}
```

**`FreeIdSet`——一个受保护的整型 ID 池（`dirtyCardQueue.cpp:57-121`）。只做一件事：给并发自救的多个 mutator 线程各分一个唯一编号。**

**为什么需要它？** `worker_i` 最终进入 `G1FromCardCache::contains_or_replace(worker_i, region_idx, from_card)`（`heapRegionRemSet.cpp:351`）——`_cache[region_idx][worker_i]`，存储的语义是"worker_i 在这个 Region 上最近扫过的卡号是 from_card"。`add_reference` 查到缓存命中就跳过，避免重复加 RSet 记录。

如果两个 mutator 拿了同一个 `worker_i`，它们互顶对方的缓存——线程 A 存的 card_X 被线程 B 用 card_Y 覆盖，A 下次再扫 card_X 又会 miss，要多扫一遍。这**不影响正确性**——RSet 是幂等的，重复扫描只是浪费 CPU。FreeIdSet 是纯性能优化：给不同线程分不同列，让 G1FromCardCache 的去重命中率尽可能高。

**ID 池大小**：`num_par_ids() = os::initial_active_processor_count()`（CPU 核数，`dirtyCardQueue.cpp:145-147`）。8 核→8 个 ID。

内部用一个单向链表管理空闲 ID：

```
FreeIdSet 内部（num_par_ids = 4）：
  _ids[0] = 1, _ids[1] = 2, _ids[2] = 3, _ids[3] = end_of_list
  _hd = 0         ← 链表头

claim: 取 _hd(=0) → _hd = _ids[0] = 1 → 返回 0  (剩余: 1→2→3)
claim: 取 _hd(=1) → _hd = _ids[1] = 2 → 返回 1  (剩余: 2→3)
release(0): _ids[0] = _hd = 2 → _hd = 0           (剩余: 0→2→3)
链表空（_hd == end_of_list）→ wait() 等其他线程 release
```

**会跟 refinement 线程冲突吗？不会。** Refinement 线程的 `_worker_id`（0..G1ConcRefinementThreads-1）在传给 `refine_card_concurrently` 时加了偏移——`worker_id + num_par_ids()`（`g1ConcurrentRefine.cpp:444`）。所以 refinement 线程实际占用 G1FromCardCache 的列 `[8..15]`，FreeIdSet 的 ID 占 `[0..7]`——物理不重叠。

**会跟 GC Worker 冲突吗？列上重叠但时间隔开。** GC Worker 在暂停内用 `worker_id 0..ParallelGCThreads-1`（无偏移），和 FreeIdSet 重叠在 `[0..7]`。但 GC 暂停时所有 mutator 被 safepoint 冻结，FreeIdSet 上没有活着使用者——列虽然重叠，时间上碰不到。

G1FromCardCache 总列数 = `num_par_ids + G1ConcRefinementThreads + MAX2(ConcGCThreads, ParallelGCThreads)`（`g1RemSet.cpp:300-304`）——**三套 ID 在同一张表的不同列上**，通过偏移和时间隔开，互不冲突。

**为什么 GC 端 DCQ 不需要 FreeIdSet？** secondary DCQ 的 `threshold = -1`——永不触发自救，永不需要临时 worker ID。

### 3.4 GC 端 DCQ Set——Redirty 临时容器

```cpp
// g1CollectedHeap.cpp:1702-1707
dirty_card_queue_set().initialize(
    DirtyCardQ_CBL_mon,                          // [1] 同 primary
    DirtyCardQ_FL_lock,                          // [2] 同 primary
    -1,                                          // [3] never trigger processing
    -1,                                          // [4] no limit on length
    Shared_DirtyCardQ_lock,                      // [5] 同 primary
    &G1BarrierSet::dirty_card_queue_set()        // [6] fl_owner → primary
);
```

和前一个比，只有两个参数不同。

#### 3.4.1 process_completed_threshold = -1——永不触发处理

在 `PtrQueueSet::enqueue_complete_buffer()` 中（`ptrQueue.cpp:237-239`）：

```cpp
if (!_process_completed && _process_completed_threshold >= 0 &&
    _n_completed_buffers >= (size_t)_process_completed_threshold) {
    _process_completed = true;
    ...
}
```

`_process_completed_threshold == -1` 让第一个条件 `>= 0` 恒为 false——**这个 DCQ Set 永远不会通知 refinement 线程来处理**。因为它的 buffer 最终会通过 `merge_bufferlists()` 合并到 primary，由 primary 负责触发处理。

#### 3.4.2 max_completed_queue = -1——无长度限制

在 `PtrQueueSet::process_or_enqueue_complete_buffer()` 中（`ptrQueue.cpp:206-222`）：

```cpp
if (_max_completed_queue == 0 ||
    (_max_completed_queue > 0 &&
     _n_completed_buffers >= _max_completed_queue + _completed_queue_padding)) {
    bool b = mut_process_buffer(node);     // mutator 自己处理
    ...
}
```

`_max_completed_queue == -1`——既不等于 0 也不大于 0，mutator 永远不走这个分支。GC worker 写入的 buffer 只管入队，从不自救。因为写的人就是 GC worker，在暂停内写入、在暂停内合并回 primary——不会堆积。

#### 3.4.3 fl_owner = &G1BarrierSet::dirty_card_queue_set()——共享 free list

这是两个 DCQ Set 之间最关键的连接。GC 端 DCQ 的 `_fl_owner` 指向 barrier 端 DCQ。

**效果**：当 GC 端 DCQ 需要分配 buffer 时，操作的不是自己的链表，而是 `_fl_owner` 的——也就是 primary 的。源码很清楚（`ptrQueue.cpp:127-152`）：

```cpp
// allocate_buffer — 从 _fl_owner 的 free list 取
MutexLockerEx x(_fl_owner->_fl_lock, ...);           // 锁 _fl_owner 的锁
node = _fl_owner->_buf_free_list;                    // 从 _fl_owner 取 Node
_fl_owner->_buf_free_list = node->next();             // _fl_owner 的链表往后移

// deallocate_buffer — 归还到 _fl_owner 的 free list
node->set_next(_fl_owner->_buf_free_list);           // 挂到 _fl_owner 链表头部
_fl_owner->_buf_free_list = node;
```

primary DCQ：`_fl_owner = this`（自己拥有 free list）。secondary DCQ：`_fl_owner = &primary`（借用 primary 的 free list）。所以 secondary 分配和归还 buffer 时，实际上操作的都是 primary 的空闲链表——两个 DCQ Set 共用同一个 buffer 池，secondary 不需要维护独立 free list。

```cpp
BufferNode* PtrQueueSet::allocate_buffer() {
    BufferNode* node = NULL;
    {
        MutexLockerEx x(_fl_owner->_fl_lock);       // 锁 primary 的 FL_lock
        node = _fl_owner->_buf_free_list;            // 从 primary 的 free list 取
        if (node != NULL) {
            _fl_owner->_buf_free_list = node->next();
            _fl_owner->_buf_free_list_sz--;          // 减 primary 的计数
        }
    }
    if (node == NULL) {
        node = BufferNode::allocate(_buffer_size);   // free list 空 → 新分配
    }
    return node;
}
```

`deallocate_buffer()` 同理——归还 buffer 到 primary 的 free list。

**为什么共享？** GC 端 DCQ 只在暂停期间用一阵子——不值得维护自己的 free list。共享 primary 的 pool，省内存、省锁竞争。

### 3.5 DirtyCardQueueSet::initialize() 到底做了什么

前面讲的都是两个 DCQ 的调用参数差异，现在看 `initialize()` 本身做了什么（`dirtyCardQueue.cpp:149-166`）：

```cpp
void DirtyCardQueueSet::initialize(Monitor* cbl_mon,
                                   Mutex* fl_lock,
                                   int process_completed_threshold,
                                   int max_completed_queue,
                                   Mutex* lock,
                                   DirtyCardQueueSet* fl_owner,
                                   bool init_free_ids) {
    // 1) 调用父类 PtrQueueSet::initialize()
    PtrQueueSet::initialize(cbl_mon, fl_lock,
                            process_completed_threshold, max_completed_queue,
                            fl_owner);

    // 2) 设置每个 buffer 的大小——只能调一次
    set_buffer_size(G1UpdateBufferSize);     // = 256

    // 3) 给 shared dirty card queue（非 Java 线程用）设置锁
    _shared_dirty_card_queue.set_lock(lock);  // = Shared_DirtyCardQ_lock

    // 4) 可选创建 FreeIdSet——primary 传 true，GC 端省略此参数（默认值 false）
    if (init_free_ids) {
        _free_ids = new FreeIdSet(num_par_ids(), _cbl_mon);
    }
}
```

> **步骤 1 的 `PtrQueueSet::initialize()` 做了什么？** 这个函数是基类方法，调它的原因是 `DirtyCardQueueSet` 继承自 `PtrQueueSet`，而 DCQ Set 的两条核心链表——completed buffer list 和 buffer free list——都在基类里。`initialize()` 就是把这些链表的管理参数交给基类（`ptrQueue.cpp:113-125`）：

```cpp
void PtrQueueSet::initialize(Monitor* cbl_mon, Mutex* fl_lock,
                             int process_completed_threshold,
                             int max_completed_queue,
                             PtrQueueSet *fl_owner) {
    _max_completed_queue = max_completed_queue;       // 入队上限：yellow 或 -1
    _process_completed_threshold = process_completed_threshold;  // 通知阈值：red 或 -1
    _completed_queue_padding = 0;                     // 防颠簸 padding，初始 0
    _cbl_mon = cbl_mon;                               // completed list 的锁
    _fl_lock = fl_lock;                               // free list 的锁
    _fl_owner = (fl_owner != NULL) ? fl_owner : this; // free list 所有者
}
```

7 行、5 个字段。每个字段的含义和传值在上面 §3.3.1-§3.3.6 已经逐一展开过了——`_cbl_mon` 保护 completed list（§3.3.1）、`_fl_lock` 保护 free list（§3.3.2）、`_process_completed_threshold` 和 `_max_completed_queue` 控制入队和通知（§3.3.3）、`_fl_owner` 决定 free list 归谁管（§3.3.5）。基类的事情不复杂——就是接收这些参数，填入对应的链表管理字段。真正复杂的是这些链表怎么被 §3.3.0 讲的 BufferNode 和线程本地队列衔接在一起。

#### 3.5.1 `_shared_dirty_card_queue`——非 Java 线程的脏卡入队

每个 Java 线程有 TLS 中的 `DirtyCardQueue`——`write_ref_field_post_slow` 无锁写入。但 VM 线程、Service 线程等**非 Java 线程没有 TLS**，它们产生的脏卡走 primary DCQ Set 上的这一条共享队列（`g1BarrierSet.cpp:105-112`）：

```cpp
Thread* thr = Thread::current();
if (thr->is_Java_thread()) {
    G1ThreadLocalData::dirty_card_queue(thr).enqueue(byte);   // Java：走 TLS
} else {
    MutexLockerEx x(Shared_DirtyCardQ_lock, ...);             // 非 Java：加锁
    _dirty_card_queue_set.shared_dirty_card_queue()->enqueue(byte);  // 共享队列
}
```

共享队列走锁保护——`Shared_DirtyCardQ_lock`（access+1）。因为多个非 Java 线程都可能触发写屏障，同时往这个队列写入。`_shared_dirty_card_queue` 在 DCQ Set 构造时设为 `permanent = true`（`dirtyCardQueue.hpp:71`：`DirtyCardQueue _shared_dirty_card_queue`，构造传入 `permanent=true`），析构时不释放 buffer（因为在析构时可能已经拿不到锁了）。

#### 3.5.2 buffer 大小——G1UpdateBufferSize = 256

每个 buffer 是 `void*` 数组——`256 × 8 = 2048 字节`（2KB）。存的不是对象引用，而是 **card 地址**（`jbyte*`）。每个 entry 占 8 字节（64 位指针）。加上 `BufferNode` 头部的 `_index` 和 `_next` 指针，一个完整 buffer 约 2KB + 16B。

### 3.6 完整数据流——各 DCQ 在整个系统中的角色

```
                            Mutator 线程
                               │
                    post-write barrier
                               │
                    per-thread DirtyCardQueue
                    (_qset = &G1BarrierSet::dirty_card_queue_set())
                               │
                  buffer 满了 → enqueue_complete_buffer()
                               │
                               ▼
            ┌──────────────────────────────────────┐
            │  G1BarrierSet::dirty_card_queue_set  │ ← primary DCQ
            │  (全局静态 primary)                   │
            │                                      │
            │  _n_completed_buffers                 │
            │  process_completed_threshold = yellow │
            │  max_completed_queue = red            │
            │  fl_owner = this (自己管 free list)   │
            └──────┬───────────┬───────────────────┘
                   │           │
          yellow → │           │ red →
        notify()  │           │ mutator 自己 mut_process_buffer()
                   ▼           ▼
    ┌──────────────────────┐
    │ Refinement 线程 0..N │
    │ do_refinement_step() │
    │ → RSet 更新           │
    └──────────────────────┘

              ═══════ GC 暂停 ═══════

    prepare_for_oops_into_collection_set_do()
        → 将所有 Java 线程的 per-thread DCQ flush 到 primary
        → GC worker get_completed_buffer() 扫描 dirty card
        → 遍历卡内引用，查 RSet 交叉引用

    [暂停末尾]

    RedirtyLoggedCardTableEntryClosure
        → 写脏卡到 GC 端 DCQ
        │
        ▼
    ┌──────────────────────────────────────┐
    │  G1CollectedHeap::_dirty_card_queue  │ ← secondary DCQ
    │  (GC 端临时容器)                      │
    │                                      │
    │  process_completed_threshold = -1     │
    │  max_completed_queue = -1            │
    │  fl_owner = &primary                │
    └──────┬───────────────────────────────┘
           │
           │ merge_bufferlists(&secondary)
           │
           ▼
    ┌──────────────────────────────────────┐
    │  回到 primary DCQ                    │
    │  → refinement 线程继续处理新 card    │
    └──────────────────────────────────────┘
```

### 3.7 两个 DCQ Set 的完整状态表

barrier 端 primary 初始化后的状态：

| 字段 | 类型 | 值 | 说明 |
|------|------|----|------|
| `_buffer_size` | `size_t` | 256 | G1UpdateBufferSize |
| `_cbl_mon` | `Monitor*` | DirtyCardQ_CBL_mon | 保护 completed 链表 |
| `_completed_buffers_head` | `BufferNode*` | NULL | 初始空 |
| `_n_completed_buffers` | `size_t` | 0 | 初始 0 |
| `_process_completed_threshold` | `int` | yellow_zone()（~24） | 达到后 notify |
| `_fl_lock` | `Mutex*` | DirtyCardQ_FL_lock | 保护 free list |
| `_buf_free_list` | `BufferNode*` | NULL | 初始空 |
| `_fl_owner` | `PtrQueueSet*` | this | 自己管 free list |
| `_all_active` | `bool` | true | 默认激活 |
| `_max_completed_queue` | `int` | red_zone()（~40） | 超限 mutator 自救 |
| `_free_ids` | `FreeIdSet*` | new FreeIdSet(...) | worker ID 池 |

GC 端 secondary 初始化后的差异：

| 差异字段 | GC 端值 |
|---------|--------|
| `_fl_owner` | `&G1BarrierSet::dirty_card_queue_set()` |
| `_process_completed_threshold` | -1 |
| `_max_completed_queue` | -1 |
| `_free_ids` | NULL |

---

## 4. SATB 队列系统

SATB 不是真的"拍照"——并发标记不可能把整个堆冻住拷贝一份。它是用**记录被覆盖的旧值**来达到同样的效果。

假设并发标记开始时，`obj.ref` 指向对象 `B`。标记线程还没来得及扫 `obj`，mutator 就执行了 `obj.ref = C`——`B` 丢了，"B 还活着吗"没人知道。标记线程后面扫到 `obj`，看到的是 `C`，不会看到 `B`，`B` 就漏标了——垃圾回收器会把它当垃圾回收掉。

SATB 的做法：**在 `obj.ref = C` 执行之前，先把 `B`（旧值）记到 SATB buffer 里**。`B` 本身是一个对象引用——标记线程从 SATB buffer 读到 `B`，认它作"根"，沿着 `B` 追踪下去——`B` 引用的对象、`B` 引用的对象引用的对象……全都被标记为存活。这样即使 `obj.ref` 已经变成 `C` 了，`B` 依然不会被漏掉。

这一步"在写之前记下旧值"就是 **pre-write barrier（写前屏障）**。本文 §2.1 讲双写屏障时提过——G1 有两道屏障，pre-write 在赋值前记旧值给 SATB，post-write 在赋值后标脏卡给 DCQ。pre-write barrier 只在并发标记期间开启（由 CMThread 在 initial-mark GC 后激活，平时是关的）。本章 §4 初始化的 SATBMarkQueueSet 就是收这些旧值的队列——barrier 往 SATB buffer 里 push，buffer 满了交到 SATBMarkQueueSet 的 completed list。

和 DCQ 不同，SATB 不是"通知-唤醒"模式——`SATBMarkQueueSet` 构造时 `_notify_when_complete = false`（默认），不会调用 `_cbl_mon->notify()`。并发标记期间，CMTask worker 一直运行，主动检查 `_process_completed` 标志——满了就调 `drain_satb_buffers()`（`g1ConcurrentMark.cpp:2417`）批量消耗。20 是批处理阈值——攒够一批再 drain，避免频繁进出。

**SATB 只在并发标记期间生效。** 标记周期开始（initial-mark GC 后，`g1ConcurrentMark.cpp:771`）调 `set_active_all_threads(true)` 开启写前屏障；标记周期结束（remark 后，`g1ConcurrentMark.cpp:1170`）调 `set_active_all_threads(false)` 关闭。平时 `_active = false`，mutator 的 SATB `enqueue()` 是空操作——没有旧值被记录，不存在"积累了没处理"的问题。

SATB 队列系统就是用来**接收、缓存、调度**这些旧引用值的队列基础设施。它不追踪引用本身（那是 CM 的工作），只管"收"——mutator 写屏障把旧值 push 进来，攒够了交给 CM 处理。

### 4.1 调用位置和参数

```cpp
// g1CollectedHeap.cpp:1679-1682
G1BarrierSet::satb_mark_queue_set().initialize(
    SATB_Q_CBL_mon,                        // [1] completed buffer list 的 monitor
    SATB_Q_FL_lock,                        // [2] buffer free list 的锁
    G1SATBProcessCompletedThreshold,       // [3] 触发阈值 = 20
    Shared_SATB_Q_lock                     // [4] 非 Java 线程的 shared SATB queue 锁
);

> **为什么 SATB 不是通知唤醒模式？** `initialize()` 调用链上看不到，关键在 SATBMarkQueueSet 的构造函数（`satbMarkQueue.cpp:199-201`）：
>
> ```cpp
> SATBMarkQueueSet::SATBMarkQueueSet() :
>     PtrQueueSet(),    // ← 默认 notify_when_complete = false
>     _shared_satb_queue(this, true /* permanent */) { }
> ```
>
> `PtrQueueSet` 构造函数默认参数就是 `false`（`ptrQueue.hpp:305`：`PtrQueueSet(bool notify_when_complete = false)`）。所以 `enqueue_complete_buffer` 里的 `_cbl_mon->notify()` 永远不会被调用。SATB 不走通知唤醒——靠 CMTask worker 主动轮询 `_process_completed` 标志来 drain。和 DCQ 的 `DirtyCardQueueSet(true)`（`notify_when_complete = true`）相反。
```

与 DCQ Set 不同——SATB**只有一道**（只有 `G1BarrierSet` 上的静态实例，没有 GC 端第二道），因为 SATB buffer 只有一个用途：收集旧引用值给并发标记线程消费。不需要中转。

### 4.2 G1BarrierSet::satb_mark_queue_set()——全局唯一实例

```cpp
// g1BarrierSet.hpp:42,78-80
static SATBMarkQueueSet _satb_mark_queue_set;       // 静态成员，全局唯一
static SATBMarkQueueSet& satb_mark_queue_set() {
    return _satb_mark_queue_set;
}

// g1BarrierSet.cpp:51
SATBMarkQueueSet G1BarrierSet::_satb_mark_queue_set;  // 定义
```

进程生命周期早期 static 初始化，只有一个实例。

### 4.3 SATBMarkQueueSet::initialize()——只做两件事

实现非常短（`satbMarkQueue.cpp:203-208`）：

```cpp
void SATBMarkQueueSet::initialize(Monitor* cbl_mon, Mutex* fl_lock,
                                  int process_completed_threshold, Mutex* lock) {
    PtrQueueSet::initialize(cbl_mon, fl_lock, process_completed_threshold, -1);
    _shared_satb_queue.set_lock(lock);
}
```

两件事：
1. 调父类 `PtrQueueSet::initialize()`——和 DCQ 同款父类，存储锁和阈值。`max_completed_queue = -1`（不限制 completed list 长度）。
2. 给 `_shared_satb_queue` 设锁——锁是 `Shared_SATB_Q_lock`。

### 4.4 参数详解

#### 4.4.1 SATB_Q_CBL_mon——唤醒 CM 线程

```cpp
// mutexLocker.cpp:212
def(SATB_Q_CBL_mon, PaddedMonitor, access, true, Monitor::_safepoint_check_never);
```

和 DCQ 的 `DirtyCardQ_CBL_mon` 同类型——都是 `PaddedMonitor`。功能也类似：当 completed SATB buffer 数达到 20 时，`_cbl_mon->notify()` 唤醒并行标记线程来处理。

#### 4.4.2 SATB_Q_FL_lock——保护 buffer free list

```cpp
// mutexLocker.cpp:211
def(SATB_Q_FL_lock, PaddedMutex, access, true, Monitor::_safepoint_check_never);
```

和 DCQ 的 `DirtyCardQ_FL_lock` 同理——保护 `_buf_free_list`。

#### 4.4.3 G1SATBProcessCompletedThreshold = 20——触发阈值

```cpp
// g1_globals.hpp:95-97
develop(intx, G1SATBProcessCompletedThreshold, 20,
        "Number of completed buffers that triggers log processing.")
        range(0, max_jint)
```

- **默认 20**：当 completed SATB buffer 达到 20 个时，并发标记线程被唤醒处理。
- **develop 标志**：只在 debug 版本可以调，product 版本固定 20。

> **为什么 20 这个数？** SATB buffer 大小是 1024 个条目（`G1SATBBufferSize = 1024`，`g1_globals.hpp:91`），20 个 buffer 能容纳 20×1024 = 20,480 个旧引用。这个数足够大——不会因为一两个 buffer 就唤醒 CM 线程（避免频繁唤醒），但又足够小——不会让旧引用积压太多导致 CM 处理不过来。

#### 4.4.4 Shared_SATB_Q_lock——非 Java 线程的入队保护

```cpp
// mutexLocker.cpp:213
def(Shared_SATB_Q_lock, PaddedMutex, access + 1, true, Monitor::_safepoint_check_never);
```

- **排名**：`access + 1`（比 CBL_mon 和 FL_lock 高一级，死锁防护）
- **用途**：非 Java 线程没有 TLS 中的 `SATBMarkQueue`，它们记录的旧引用通过 `_shared_satb_queue.enqueue()` 入队，持这个锁保护。

SATB 队列分布很简单——只有 **1 个 `SATBMarkQueueSet`**（不像 DCQ 有两个），上面挂了 N 条 `SATBMarkQueue`：

| 谁 | 条数 | 说明 |
|----|------|------|
| 每个 Java 线程 | 1 条 TLS `SATBMarkQueue` | `_qset = 全局 SATBMarkQueueSet`，无锁写入 |
| `SATBMarkQueueSet._shared_satb_queue` | 1 条共享 | 非 Java 线程用，`Shared_SATB_Q_lock` 加锁保护 |
| CMTask worker | 无 | 消费者——从 `SATBMarkQueueSet` 的 completed list 取 buffer 处理 |
| GC Worker | 无 | STW 暂停内 SATB 由 evacuation 闭包直接处理，不走线程本地队列入队

### 4.5 SATBMarkQueueSet 的结构——一笔让字段

SATBMarkQueueSet 继承自 PtrQueueSet，自身只有一个额外字段：

```cpp
// satbMarkQueue.hpp:89-90
class SATBMarkQueueSet: public PtrQueueSet {
    SATBMarkQueue _shared_satb_queue;    // 给非 Java 线程用的共享 SATB 队列
};
```

`_shared_satb_queue` 在构造函数中设为 `permanent = true`（`satbMarkQueue.cpp:199-201`）：

```cpp
SATBMarkQueueSet::SATBMarkQueueSet() :
    PtrQueueSet(),
    _shared_satb_queue(this, true /* permanent */)
{}
```

`permanent = true` 意味着析构时不释放 buffer——因为析构时可能已经不能安全加锁了。

### 4.6 三把锁的排序规则

SATB 三把锁的 rank 排序：

```
Shared_SATB_Q_lock (access+1)
  > SATB_Q_CBL_mon (access)
  > SATB_Q_FL_lock (access)
```

当代码需要同时持有这些锁时，必须按 rank 从高到低加锁，避免死锁。具体来说：非 Java 线程入队 shared queue 时先拿 `Shared_SATB_Q_lock`（高 rank），再拿 `FL_lock`（低 rank）；普通 Java 线程入队只拿 `CBL_mon` 或 `FL_lock`，不存在冲突。

> **阅读提示**：SATB buffer 的大小（`G1SATBBufferSize = 1024`）在后续步骤才设置——不在当前 `initialize()` 里设。设置时机在 G1CollectedHeap 初始化更靠后的位置，通过 `satb_mark_queue_set().set_buffer_size(G1SATBBufferSize)` 调。本文看到这里时 `_buffer_size` 仍为 0。

### 4.7 SATB 初始化后的状态速查

| 字段 | 值 | 含义 |
|------|-----|------|
| `_buffer_size` | 0（未设） | 后续 `set_buffer_size(1024)` 才设 |
| `_cbl_mon` | `SATB_Q_CBL_mon` | 保护 completed list |
| `_completed_buffers_head` | NULL | 空链表 |
| `_n_completed_buffers` | 0 | 计数为 0 |
| `_process_completed_threshold` | 20 | 达阈值 notify |
| `_fl_lock` | `SATB_Q_FL_lock` | 保护 free list |
| `_buf_free_list` | NULL | 空 |
| `_fl_owner` | this | 自己管 free list |
| `_max_completed_queue` | -1 | 不限长度 |
| `_shared_satb_queue` 锁 | `Shared_SATB_Q_lock` | 非 Java 线程入队用 |

### 4.8 SATB 和 DCQ 的对比

两套队列系统用了同一套基类（`PtrQueueSet`），但细节不同：

| 维度 | SATB | DCQ |
|------|------|-----|
| 实例数 | 1（全局静态） | 2（barrier + GC） |
| buffer 大小 | 1024 个指针（8KB） | 256 个指针（2KB） |
| 存储内容 | 旧对象引用（oop） | 脏卡地址（jbyte*） |
| 消费者 | 并发标记线程（CMTask） | 并发 refinement 线程 |
| 触发阈值 | 固定 20 | 动态 yellow_zone |
| shared queue | `_shared_satb_queue`（STM） | `_shared_dirty_card_queue`（DirtyCardQueue） |
| 触发机制 | `process_completed` 标志 + notify | 同样的 PtrQueueSet 机制 |

---

## 5. YoungGen 采样线程——自适应 young 区大小的数据源

### 5.1 它解决什么问题

G1 的自适应 young 区大小依赖 RSet 扫描耗时的预测。但 G1Analytics 只在 GC 结束后更新预测——两次 GC 之间 RSet 持续膨胀，预测失准。采样线程就是填这个盲区：每 300ms 读一次已加入 CSet 的 young Region 的实际 RSet 大小，发现超过预测值就通知 G1Policy 下调 `_young_list_target_length`（缩小 eden，提早触发 GC）。

### 5.2 为什么非 GC 期间有 Region 可采样

`G1CollectionSet::iterate()` 遍历 `_collection_set_regions` 数组（`g1CollectionSet.cpp:174-199`）。这个数组在 GC 结束后不是空的——survivor 在 GC 暂停末尾由 `transfer_survivors_to_cset()` 加入（`g1Policy.cpp:1148-1176`）[^2]，之后每填满一个 eden Region 就有 mutator 分配器调用 `retire_mutator_alloc_region()` → `collection_set()->add_eden_region()` 继续往里加（`g1CollectedHeap.cpp:4869-4881`）。只有**当前正在活跃分配的 eden Region**（还没退休的那个）不在数组里，不影响采样。

[^2]: survivor 是上次 GC 中活下来的 young 对象所在 Region，仍然是 young。下一轮 GC 所有 young Region 都要撤离——与其等到下次 GC 暂停时再找，不如在本次 GC 结束时直接放进 CSet 数组。这就是 G1 的 incremental CSet building——CSet 不是 GC 前临时组建，而是从 GC 结束后就开始逐步构建。

### 5.3 构造时创建了什么

两行代码（`g1CollectedHeap.cpp:1529-1536`）：

```cpp
jint G1CollectedHeap::initialize_young_gen_sampling_thread() {
    _young_gen_sampling_thread = new G1YoungRemSetSamplingThread();
    if (_young_gen_sampling_thread->osthread() == NULL) {
        return JNI_ENOMEM;
    }
    return JNI_OK;
}
```

`_young_gen_sampling_thread` 是 `G1CollectedHeap` 的字段（`g1CollectedHeap.hpp:155`）。构造函数（`g1YoungRemSetSamplingThread.cpp:35-43`）里设了线程名 `"G1 Young RemSet Sampling"`，建了自己的 `_monitor`（nonleaf 级别），调用 `create_and_start()` 立即启动 OS 线程。

线程继承 `ConcurrentGCThread`，走标准四阶段流程：`initialize_in_thread()` → `wait_for_universe_init()`（等 JVM 启动完毕）→ `run_service()`（300ms 循环采样）→ `terminate()`。运行时细节属于后续 Policy 篇章，本章不展开。

---

## 6. 锁汇总

本章涉及的全部 7 个锁：

| 锁 | 类型 | 等级 | 保护 | 属于哪个系统 |
|----|------|------|------|------------|
| `SATB_Q_CBL_mon` | PaddedMonitor | access | SATB completed buffer list | SATB |
| `SATB_Q_FL_lock` | PaddedMutex | access | SATB buffer free list | SATB |
| `Shared_SATB_Q_lock` | PaddedMutex | access+1 | SATB shared queue（非 Java 线程） | SATB |
| `DirtyCardQ_CBL_mon` | PaddedMonitor | access | DCQ completed buffer list | DCQ |
| `DirtyCardQ_FL_lock` | PaddedMutex | access | DCQ buffer free list | DCQ |
| `Shared_DirtyCardQ_lock` | PaddedMutex | access+1 | DCQ shared queue（非 Java 线程） | DCQ |
| `G1YoungRemSetSamplingThread::_monitor` | Monitor (nonleaf) | nonleaf | sampling 线程的睡眠/唤醒 | YoungGen |

---

> **本章小结**：四套队列基础设施都就绪了——SATB 准备收旧引用、ConcurrentRefinement 准备处理脏卡、两道 DCQ 各就各位、YoungGen 采样线程开始监控 RSet 趋势。还剩最后一步：GC 分配器就位。
>
> **下一篇**：[ch09/11](11-allocator-ready-and-cleanup.md)——Dummy Region + G1AllocRegion::setup + init_mutator_alloc_region + 收尾。
