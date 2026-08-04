# 12b. initialize_heap() 收尾——TLAB 上限、压缩指针与 TLAB 启动

> **本文定位**：`Universe::initialize_heap()`（universe.cpp:764-823）五个阶段中的 ③④⑤——补完 ch09 遗留的缺口。③ 设 TLAB 全局上限、④ 决定压缩指针编码模式、⑤ 启动 TLAB 子系统。ch09 前面的文章讲完 create_heap 和 G1CollectedHeap::initialize()，本文把 initialize_heap() 剩余的三行核心调用讲完。
>
> **前置依赖**：[ch09/12](12-summary.md)（总结章，指出本缺口）；ch09/03（reserve_heap 与压缩指针 base 的预约）。

---

## 1. 执行位置与全景

`Universe::initialize_heap()` 的完整结构（universe.cpp:764-823）：

```cpp
jint Universe::initialize_heap() {
  _collectedHeap = create_heap();                          // ① 已讲（ch09/04）
  jint status = _collectedHeap->initialize();              // ② 已讲（ch09/02-11）
  if (status != JNI_OK) {
    return status;
  }
  log_info(gc)("Using %s", _collectedHeap->name());

  ThreadLocalAllocBuffer::set_max_size(Universe::heap()->max_tlab_size());   // ③ 本文

#ifdef _LP64
  if (UseCompressedOops) {                                  // ④ 本文
    ... 压缩指针模式决策 (~40 行)
  }
#endif

  if (UseTLAB) {                                            // ⑤ 本文
    ThreadLocalAllocBuffer::startup_initialization();
  }
  return JNI_OK;
}
```

三个步骤的职责一览：

| 步骤 | 行号 | 做了什么 | 一句话本质 |
|------|------|---------|-----------|
| ③ `set_max_size` | 772 | 设置 TLAB 全局上限 | TLAB 最大 = humongous 阈值（半 Region） |
| ④ CompressedOops | 774-812 | 决定 oop 编码的 shift/base | 4GB/32GB 两个阈值切出四种模式 |
| ⑤ `startup_initialization` | 817-821 | 初始化 TLAB 子系统 | 算 refill 目标 + 建全局统计 + 重初始化主线程 TLAB |

---

## 2. ③ TLAB set_max_size——TLAB 不能装 humongous 对象

### 2.1 一行调用，两个角色

```cpp
ThreadLocalAllocBuffer::set_max_size(Universe::heap()->max_tlab_size());
```

- `ThreadLocalAllocBuffer::set_max_size()` 是静态 setter（threadLocalAllocBuffer.hpp:126）——把全局静态字段 `_max_size` 设好
- `Universe::heap()->max_tlab_size()` 是虚函数——**G1 的实现定义了"G1 里 TLAB 最大能多大"**

### 2.2 G1 的答案：半 Region

```cpp
// g1CollectedHeap.cpp:2200-2204
// For G1 TLABs should not contain humongous objects, so the maximum TLAB size
// must be equal to the humongous object limit.
size_t G1CollectedHeap::max_tlab_size() const {
  return align_down(_humongous_object_threshold_in_words, MinObjAlignment);
}
```

`_humongous_object_threshold_in_words` 在构造函数中设置（g1CollectedHeap.cpp:1469）：

```cpp
_humongous_object_threshold_in_words = humongous_threshold_for(HeapRegion::GrainWords);
```

```cpp
// g1CollectedHeap.hpp:1221-1224
static size_t humongous_threshold_for(size_t region_size) {
  return (region_size / 2);   // 半 Region
}
```

所以 G1 的 TLAB 上限 = `GrainWords / 2`。以默认 4MB Region 为例：TLAB 最大 = 2MB。

### 2.3 为什么是半 Region

源码注释给出的理由是唯一的：**TLAB 不允许装 humongous 对象**。G1 把超过半 Region 的对象定义为 humongous，直接分配在连续 Region 上（不走 TLAB）。如果 TLAB 允许大于半 Region，TLAB 里就能装下 humongous 对象，破坏这个约定。

这个上限还隐含一个好处：**TLAB 永远不会跨越 Region 边界**。G1 的 TLAB 从单个 Region 中切出，`G1Allocator::unsafe_max_tlab_alloc()`（g1Allocator.cpp:141-156）把可分配量限制在 `min(当前 Region 剩余空间, max_tlab)`——加上全局上限 ≤ 半 Region，TLAB 天然不会横跨两个 Region，GC 按 Region 粒度回收时无需处理半截 TLAB。

注意这里的取舍：**TLAB 实际大小远小于这个上限**。上限只是"绝对不允许超过"的护栏，运行时 TLAB 的实际大小由 `initial_desired_size()` 和自适应调整决定（§4.5），通常只有几百 KB。

---

## 3. ④ CompressedOops——4GB/32GB 两个阈值，四种模式

### 3.1 背景：压缩指针是什么

oop（ordinary object pointer）是 JVM 内部表示"指向 Java 对象的引用"的指针。64 位平台上地址占 8 字节，所以一个 oop 是 8 字节。

**为什么堆 ≤ 32GB 时 8 字节里有 32 位永远是 0？** 地址本质上就是一个数，64 位地址的取值范围是 `[0, 2^64)`。两个约束砍掉了 64 位里的 32 位：

**约束一：堆大小限制 → 高 29 位恒 0**

```
2^35 = 34359738368 = 32GB（2 的 35 次方）

堆 ≤ 32GB → 堆里任何一个地址都 < 2^35
→ 这个地址用二进制表示，只需要 35 个 bit 就能写完
→ 第 35 位及以上的所有位（35~63 位，共 29 位）永远是 0
```

例子：`0x800000000`（32GB，堆末尾）写成 64 位二进制：

```
0x800000000 = 0000 0000 0000 0000 0000 0000 0000 1000 0000 0000 0000 0000 0000 0000 0000 0000
              ↑←────── 高 29 位（第 35~63 位）恒 0 ──────→↑↑←──── 低 35 位，装得下堆里所有地址 ────→
```

如果堆是 32GB，最大的地址就是 `2^35 - 1`——二进制下高 29 位全 0。

**约束二：对象 8 字节对齐 → 低 3 位恒 0**

HotSpot 默认 `ObjectAlignmentInBytes = 8`：任何对象在堆里的起始地址都必须是 8 的倍数。8 的倍数意味着什么？8 = `2^3`，所以一个 8 的倍数写成二进制，**末 3 位（第 0~2 位）一定是 `000`**。

例子：地址 `0x600000000 + 100`（100 不是 8 的倍数，真实对象不会落在这里），换成 `0x600000000 + 104`（104 = 13×8）：

```
0x600000000 + 104 = 0x600000068
二进制末 3 位：         ...0110 1000
                        ↑↑↑
                        └─┴─┴─ 末 3 位 = 000（因为 104 是 8 的倍数）
```

**两个约束叠加：**

```
64 位地址
├─ 高 29 位（35~63）：恒 0 —— 堆 ≤ 32GB，地址装不进这 29 位
├─ 中间 32 位（3~34）：真正携带信息
└─ 低 3 位（0~2）：恒 0 —— 对象 8 字节对齐
```

中间这 32 位就是全部信息量。**压缩指针 = 只存这 32 位**。还原时把 3 位对齐补回去：

```
存储：narrow_oop = 地址 >> 3          （丢掉低 3 位恒 0，只留 32 位信息）
还原：地址 = narrow_oop << 3          （补回 3 个 0，得到完整 64 位地址）
```

这就是 ZeroBased 模式的全部原理——不需要 base，因为地址本身就在 32GB 以内。

**为什么还要 base？** 注意约束的前提：**堆大小 ≤ 32GB**（reserve_heap 的硬性断言，universe.cpp:852——超了必须关压缩指针）。但堆**放在哪个地址**由 OS 决定，完全可能落在高处。假设 8GB 堆被放在地址 64GB 处（区间 [64GB, 72GB)）：

```
直接存 地址 >> 3：72GB >> 3 = 9G  → 9G > 2^32（4.29G），需要 34 位，装不下 32 位！

解法：引入 base = 64GB（堆起始地址）
平移：(address - base) ∈ [0, 8GB)        ← 把堆整体搬回原点
右移：(address - base) >> 3 ∈ [0, 1G)     ← 1G < 4.29G，轻松装进 32 位
解码：base + (narrow_oop << 3)            ← 平移回去
```

注意单位：`>> 3` 把地址从"字节"换算成"8 字节组"（对象 8 字节对齐，组号就是全部信息）。64GB 处的地址换算成组号高达 9G，超出 32 位；平移回原点后组号只有 1G，装得下。解码时 `base + (narrow_oop << 3)` 把组号乘回字节数、再加回 base。

所以 `base` 的作用是**把任意位置的堆"平移"回低 32 位可编码的区间**：

| 堆的位置 | base | 模式 |
|---------|------|------|
| 堆末尾 ≤ 32GB（低地址空间） | 0 | ZeroBased——地址本身就能 >> 3 装下 |
| 堆末尾 > 32GB（高处，如 64GB） | 堆起始地址 | DisjointBase / HeapBased——先平移再 >> 3 |

### 3.2 决策代码

```cpp
// universe.cpp:774-812（节选核心）
#ifdef _LP64
  if (UseCompressedOops) {
    if ((uint64_t)Universe::heap()->reserved_region().end() > UnscaledOopHeapMax) {
      // Didn't reserve heap below 4Gb.  Must shift.
      Universe::set_narrow_oop_shift(LogMinObjAlignmentInBytes);   // shift = 3
    }
    if ((uint64_t)Universe::heap()->reserved_region().end() <= OopEncodingHeapMax) {
      // Did reserve heap below 32Gb. Can use base == 0;
      Universe::set_narrow_oop_base(0);                            // base = 0
    }
    AOTLoader::set_narrow_oop_shift();
    Universe::set_narrow_ptrs_base(Universe::narrow_oop_base());
    ...
    Arguments::PropertyList_add(new SystemProperty("java.vm.compressedOopsMode",
                                                   narrow_oop_mode_to_string(narrow_oop_mode()),
                                                   false));
  }
#endif
```

两个关键常量（默认 8 字节对齐）：

```
UnscaledOopHeapMax = max_juint + 1 = 2^32 = 4GB        // globalDefinitions.hpp:517
OopEncodingHeapMax = (max_juint+1) << LogMinObjAlignmentInBytes
                   = 2^32 << 3 = 32GB                  // arguments.cpp:1610
LogMinObjAlignmentInBytes = exact_log2(ObjectAlignmentInBytes) = 3
```

### 3.3 四个判断分支 → 四种模式

`reserved_region().end()` 是堆预约的**末尾地址**（ch09/03 的 mmap 完成后才有值）。四个组合：

```
堆末尾 ≤ 4GB？                 shift=0, base=0      → Unscaled（不压缩，直接存）
4GB < 堆末尾 ≤ 32GB？           shift=3, base=0      → ZeroBased（零基压缩）
堆末尾 > 32GB？                 shift=3, base=堆地址  → DisjointBase / HeapBased
```

| 模式 | shift | base | 判定依据（堆最终落点） | 编码公式 |
|------|-------|------|---------------------|---------|
| Unscaled | 0 | 0 | 堆末尾 ≤ 4GB | `narrow_oop = oop`（无压缩） |
| ZeroBased | 3 | 0 | 4GB < 堆末尾 ≤ 32GB | `narrow_oop = oop >> 3` |
| DisjointBase | 3 | 堆外地址 | 堆末尾 > 32GB，且 base 与堆不重叠 | `narrow_oop = (oop - base) >> 3` |
| HeapBased | 3 | 堆内地址 | 堆末尾 > 32GB，base 落入堆区间 | 同上（base 与堆重叠） |

### 3.4 reserve_heap 的压缩指针路径——五级降级尝试

第 ④ 步**只负责最终确定 shift/base**——堆落在哪是 ch09/03 的 `Universe::reserve_heap()` 早就决定的。而那里远不是一次 mmap 那么简单：`ReservedHeapSpace` 构造走 `initialize_compressed_heap()`（virtualspace.cpp:490-600），**从最优模式到最差模式逐级尝试**，每级失败才降级到下一级：

```
Level 0: 用户指定 HeapBaseMinAddress          ← 仅当用户显式设置 -XX:HeapBaseMinAddress
         └─ 强制精确落在该地址，不对则 release

Level 1: Unscaled 模式（< 4GB）                ← 堆能装进 4GB 时才尝试
         └─ try_reserve_range：从 4GB 顶部向下试 HeapSearchSteps(3) 个点

Level 2: ZeroBased 模式（< 32GB）              ← 预留压缩类空间后尝试
         └─ zerobased_max = 32GB - CompressedClassSpaceSize
         └─ 从顶部向下试 3 个点

Level 3: DisjointBase 模式                     ← 从预置地址表挨个试
         └─ 2×32G, 3×32G, 4×32G, 8×32G, 10×32G, 1×64K×32G, ...（virtualspace.cpp:452-466）

Level 4: 任意地址（HeapBased）                 ← 最后的绝望尝试
         └─ initialize(NULL)，无任何地址偏好
```

关键机制（`try_reserve_heap`，virtualspace.cpp:334-414）：

```cpp
if (special) {                                  // 大页 + 系统不支持按需提交
  base = os::reserve_memory_special(...);       // 尝试大页
}
if (base == NULL) {
  // 大页失败 → 降级为普通内存（不带大页）
  if (requested_address != 0) {
    base = os::attempt_reserve_memory_at(size, requested_address, _fd_for_heap);  // 指定地址
  } else {
    base = os::reserve_memory(size, NULL, alignment, _fd_for_heap);               // 任意地址
  }
}
...
if ((((size_t)base) & (alignment - 1)) != 0) {
  release();                                    // 地址不对齐 → 释放重试下一个点
}
```

所以完整链条是**两层降级**：

```
模式降级:  Unscaled → ZeroBased → DisjointBase → HeapBased（四档模式）
每档内部:  try_reserve_range 从高到低试 3 个 attach point
每次尝试:  大页失败 → 降级普通 mmap；对齐失败 → 释放试下一个
```

`compressed_oop_base()` 返回最终落点（ReservedHeapSpace 构造完成后 `_base`），`Universe::reserve_heap()` 把它存进 `narrow_oop_base` 的初始值：

```cpp
// universe.cpp:868-873
if (UseCompressedOops) {
  // Universe::initialize_heap() will reset this to NULL if unscaled
  // or zero-based narrow oops are actually used.
  Universe::set_narrow_oop_base((address)total_rs.compressed_oop_base());
}
```

于是第 ④ 步的职责收敛为（universe.cpp:782-792）：
- `end > 4GB` → shift 从 0 提到 3
- `end ≤ 32GB` → base 归零（把预谋的 base 清零，启用 zero-based 模式）
- 两个判断都不满足（> 32GB）→ 保持 reserve_heap 设的 base 不变

### 3.5 日志验证——你看到的那行输出

`-Xlog:gc+heap+coops=info` 的输出来自 `Universe::print_compressed_oops_mode()`（universe.cpp:825-843），由 initialize_heap 第 794-799 行触发：

```cpp
LogTarget(Info, gc, heap, coops) lt;
if (lt.is_enabled()) {
  ResourceMark rm;
  LogStream ls(lt);
  Universe::print_compressed_oops_mode(&ls);
}
```

```cpp
void Universe::print_compressed_oops_mode(outputStream* st) {
  st->print("Heap address: " PTR_FORMAT ", size: " SIZE_FORMAT " MB",
            p2i(Universe::heap()->base()),
            Universe::heap()->reserved_region().byte_size()/M);
  if (Universe::narrow_oop_base() != 0) {
    st->print(": " PTR_FORMAT, p2i(Universe::narrow_oop_base()));
  }
  if (Universe::narrow_oop_shift() != 0) {
    st->print(", Compressed Oops mode: %s, Oop shift amount: %d",
              narrow_oop_mode_to_string(narrow_oop_mode()),
              Universe::narrow_oop_shift());
  }
  ...
}
```

用你的 8GB 堆例子验证：

```
[0.056s][info][gc,heap,coops] Heap address: 0x0000000600000000, size: 8192 MB, Compressed Oops mode: Zero based, Oop shift amount: 3
```

- `Heap address = 0x600000000`（24GB），size 8GB → 堆末尾 = `0x800000000` = 32GB
- `end ≤ OopEncodingHeapMax`（32GB）→ `narrow_oop_base = 0` → **ZeroBased**
- `end > UnscaledOopHeapMax`（4GB）→ `shift = 3` ✓
- 编码公式：`narrow_oop = oop >> 3`，解码：`oop = narrow_oop << 3`——32 位窄指针能覆盖到 `2^35 = 32GB`，正好够

想看每一级降级的尝试过程，用 `-Xlog:gc+heap+coops=trace`——`try_reserve_heap` 每次尝试都打一行：

```cpp
// virtualspace.cpp:358-361
log_trace(gc, heap, coops)("Trying to allocate at address " PTR_FORMAT
                           " heap of size " SIZE_FORMAT_HEX,
                           p2i(requested_address), size);
```

你会看到从 Unscaled 区间的顶部开始，逐个 attach point 的尝试记录，直到某个点 mmap 成功。

### 3.6 生产视角：大部分堆 < 32GB，但模式不只看堆大小

绝大多数生产 JVM 的堆小于 32GB——但**堆大小只是必要条件，模式最终取决于堆的落点**：

```
堆大小 ≤ 4GB 且落点低    → Unscaled
堆大小 ≤ 32GB 且落点低    → ZeroBased（最常见）★
堆大小 ≤ 32GB 但落点高    → DisjointBase / HeapBased（小堆也会遇到！）
堆大小 > 32GB             → 压缩指针被自动关闭（8 字节引用）
```

两个生产现实：

**1. 堆 > 32GB 时压缩指针自动关闭**。`Arguments::set_use_compressed_oops()` 检测到 `MaxHeapSize` 超过 `max_heap_for_compressed_oops()`（≈ 32GB）时，自动把 `UseCompressedOops` 置为 false——引用回到 8 字节，同样的对象图多占约一倍引用内存。这是大堆内存开销暴涨的原因之一。

**2. 堆 ≤ 32GB 也可能落到高位地址**。低 32GB 地址空间被占用时（ASLR 随机化、其他进程/库先 mmap 占了低地址），即使堆只有 8GB，落点在 64GB 处也走 DisjointBase。这正是 ch09/03 里 reserve_heap 优先尝试低地址预留的原因，也是五级降级存在的意义——**尽可能把堆留在可压缩的地址区间**。

实践：用 `-Xlog:gc+heap+coops=info` 看模式，用 `java -XX:+PrintFlagsFinal -version | grep UseCompressedOops` 确认开关状态。如果堆 > 32GB 且引用内存占比高，可以考虑缩小堆、或用 `-XX:-UseCompressedOops` 显式关闭（避免大堆场景下开关自动关闭带来的歧义）。

### 3.7 为什么能省内存

32GB 堆 + ZeroBased：每个引用从 8 字节变 4 字节，节省 50% 的引用空间。1 亿个对象引用就省 400MB。这是 G1 大堆场景几乎必开压缩指针的原因——但代价是 `java.vm.compressedOopsMode` 属性告诉程序当前模式，JNI 层需要按模式做地址换算。

---

## 4. ⑤ TLAB startup_initialization——TLAB 子系统开机

### 4.1 全景：三件事

```cpp
// threadLocalAllocBuffer.cpp:226-268
void ThreadLocalAllocBuffer::startup_initialization() {

  // Assuming each thread's active tlab is, on average,
  // 1/2 full at a GC
  _target_refills = 100 / (2 * TLABWasteTargetPercent);   // ① 算 refill 目标
  _target_refills = MAX2(_target_refills, 2U);            // 下限 2，防止 VM 启动期 GC

  _global_stats = new GlobalTLABStats();                  // ② 建全局统计

#ifdef COMPILER2
  if (is_server_compilation_mode_vm()) {                  // ③ C2 预留 prefetch 空间
    int lines = MAX2(AllocatePrefetchLines, AllocateInstancePrefetchLines) + 2;
    _reserve_for_allocation_prefetch = (AllocatePrefetchDistance + AllocatePrefetchStepSize * lines) /
                                       (int)HeapWordSize;
  }
#endif

  guarantee(Thread::current()->is_Java_thread(), "tlab initialization thread not Java thread");
  Thread::current()->tlab().initialize();                 // ④ 重初始化主线程 TLAB
  ...
}
```

### 4.2 ① _target_refills——控制 TLAB GC 浪费的比例

#### 前置概念一：refill 是什么

一个线程要分配对象，从 eden 里切一块空间（TLAB），**用完再切一块——"切一块"就是一次 refill**（源码对应 `fill()`，threadLocalAllocBuffer.cpp:179）。

每块切多大，有个两难：

```
切太小 → 一会儿就没了，频繁切。每切一次都有开销（拿锁换 Region、填 dummy 对象、统计）
切太大 → GC 来时手里这块没用完（平均只用一半），剩下的一半成为 gc_waste
```

JVM 的做法：**不直接决定切多大，而是定一个目标——每次 GC 之前平均切 50 次（`_target_refills = 50`）**。然后反推每块大小：

```
每块大小 = 预估分配量 ÷ 50
```

例：预估下次 GC 前该线程分配 100MB → 每块切 `100MB ÷ 50 = 2MB` → 用完 50 块正好到 GC。

注意：**`_target_refills` 是常量（启动时算一次，不再变），运行时被调整的是 TLAB 大小**。refill 次数是结果——TLAB 变大则次数变少，变小则变多；resize() 通过改每块大小，让实际次数凑到目标 50。

#### 前置概念二：TLAB GC 浪费（gc_waste）

GC 时刻，每个线程的活跃 TLAB 中 `top` 与 `end` 之间的空间——即**已划给 TLAB、但尚未被对象填充的部分**——在源码中记为 `_gc_waste`（threadLocalAllocBuffer.cpp:76）：

```cpp
_gc_waste += (unsigned)remaining();   // remaining() = end - top
```

对应标志 `TLABWasteTargetPercent` 的定义（gc_globals.hpp:778）：

> "Percentage of Eden that can be wasted (half-full TLABs at GC)"

**为什么它会影响 GC 频率？** G1 触发年轻代 GC 的判据是 eden 的消耗量（young Region 数达到目标值）。TLAB 划走的空间计入 eden 消耗——**无论其中是否填充了对象**。

设每个 GC 周期内：

```
C = eden 消耗量（达到 C 即触发 GC，常数：young 目标 Region 数 × Region 大小）
A = 该周期内对象实际分配量
W = 该周期内所有活跃 TLAB 的 gc_waste 之和

关系：A = C - W      （eden 消耗 = 对象分配 + TLAB 未使用空间）
```

应用在固定时间段内需要分配的总量 `U`，所需的 GC 周期数：

```
GC 周期数 = U / A = U / (C - W)
```

**W 越大（TLAB 越大），每个周期内的有效分配量 A 越小，GC 周期数越多，STW 停顿次数越多。** 这就是为什么 gc_waste 空间虽然会被回收（无物理损失），仍需要控制其比例——它计入 eden 消耗、触发 GC，但不承载对象。

数值例（C = 2GB，U = 36GB）：

```
W = 200MB（占 10%）：A = 1.8GB → GC 周期数 = 20
W = 20MB（占 1%）：  A = 1.98GB → GC 周期数 ≈ 19
```

#### 公式推导

```cpp
_target_refills = 100 / (2 * TLABWasteTargetPercent);
```

`TLABWasteTargetPercent = 1`——gc_waste 占 eden 的比例上限（1%）。源码注释解释假设：**GC 时每个线程的活跃 TLAB 平均半满**。

推导：

```
每线程每周期 gc_waste ≈ 0.5 × TLAB大小（活跃 TLAB 平均半满）
每线程每周期分配量  ≈ R × TLAB大小（R = 两次 GC 之间的 refill 次数）
gc_waste 比例 = 0.5 / R

令 0.5 / R = TLABWasteTargetPercent = 0.01
→ R = 0.5 / 0.01 = 50
```

`_target_refills` 由此定义为 TLAB 大小的**校准目标**：resize() 时按"每周期恰好 refill 50 次"来确定 TLAB 大小（见 §4.5），从而保证 gc_waste 比例不超过 1%。

`MAX2(_target_refills, 2U)` 下限 2 的注释："We need to set initial target refills to 2 to avoid a GC which causes VM abort during VM initialization"——如果目标太小，TLAB 刚分配就满，VM 启动期就触发 GC，而此时 VM 尚未就绪会 abort。

### 4.3 ② GlobalTLABStats——TLAB 的全局统计器

```cpp
_global_stats = new GlobalTLABStats();
```

`GlobalTLABStats`（threadLocalAllocBuffer.hpp:209-291）持有 12 个累计字段 + 12 个 PerfData 变量：

```
构造（threadLocalAllocBuffer.cpp:353-413）:
  _allocating_threads_avg(TLABAllocationWeight=35)   ← AdaptiveWeightedAverage
  initialize()                                        ← 12 个计数清零
  _allocating_threads_avg.sample(1)                   ← 种子样本：1 个分配线程
  if (UsePerfData):
    12 × PerfDataManager::create_variable(SUN_GC, "tlab.<name>", ...)
```

12 个计数器（`sun.gc.tlab.*`）：

| PerfData 名 | 含义 |
|---|---|
| `allocThreads` / `maxFills` / `fills` | 分配线程数 / 最大 refill 数 / 总 refill 数 |
| `alloc` | 总分配量（字节） |
| `gcWaste` / `maxGcWaste` | GC 时的 TLAB 浪费（半满剩余） |
| `slowWaste` / `maxSlowWaste` | 慢路径 refill 浪费 |
| `fastWaste` / `maxFastWaste` | 快路径 refill 浪费 |
| `slowAlloc` / `maxSlowAlloc` | 慢分配次数 |

#### `_allocating_threads_avg` 的采样对象与用途

**采样对象**：每个 GC 周期内，执行过至少一次 TLAB refill 的线程数量。

**采样时机与数据流**（threadLocalAllocBuffer.cpp:56-67, 71-112）：

```
GC 前，accumulate_statistics_before_gc()：
  遍历所有 JavaThread：
    accumulate_statistics()
      └─ 若 _number_of_refills > 0（该周期内发生过 TLAB refill）：
           global_stats()->update_allocating_threads()    // _allocating_threads += 1
  汇总后 publish()：
    _allocating_threads_avg.sample(_allocating_threads)   // 以该值为样本更新平滑平均
```

**数据消费方**：`initial_desired_size()`（threadLocalAllocBuffer.cpp:275-280）与 `resize()`：

```cpp
unsigned nof_threads = global_stats()->allocating_threads_avg();
init_sz = (Universe::heap()->tlab_capacity(myThread()) / HeapWordSize) /
          (nof_threads * target_refills());
```

每块 TLAB 大小 = eden 容量 ÷（分配线程数 × 目标 refill 次数）。该平均值决定分母中的线程数项——eden 容量固定时，分配线程越多，每块 TLAB 越小。

**`sample(1)` 的语义**：`GlobalTLABStats` 构造时（启动阶段）尚无任何 GC 周期可供采样，`_allocating_threads_avg` 无历史数据。`sample(1)` 以值 1 作为首个样本初始化该统计器——既为初始 TLAB 大小计算提供非零分母（避免除零），也作为后续真实采样数据的起始基准。

### 4.4 ③ C2 prefetch 预留

#### 为什么需要预留：三个层层递进的问题

**问题一：为什么 C2 要在分配代码里插 prefetch？**

```
CPU 访问内存很慢（约 100-300 个时钟周期）
Java 的 new 被 JIT 编译成分配代码后，紧接着就要往对象里写字段
→ 如果对象内存不在缓存里，第一次写字段就要等几百个周期

C2 的优化：分配完成后，立刻对"下一块要用的内存"发 prefetch 指令
→ CPU 提前把这块内存读进缓存
→ 后续真正访问时缓存命中，不用等
```

注意：prefetch 的目标地址 = `top + distance`（未来要用的地址），**超出了当前 TLAB 的已用部分**。

**问题二：为什么需要预留空间？**

```
prefetch 的目标地址 = top + AllocatePrefetchDistance + ...
这个地址可能超出 TLAB 的 end，甚至超出堆的范围

超出堆 → 某些平台（如 SPARC 的 BIS 指令）会触发 fault → JVM 崩溃

解法：把 TLAB 的可用 end 往回收，留出一段"禁飞区"：
  实际可分配范围 = [start, end - reserve)
  prefetch 指令的目标落在 [end - reserve, end) 这段预留区里
  → 地址仍在 TLAB 内（堆内），不会 fault
```

**问题三：公式在算什么？**

```cpp
// ① 预取几行：对象分配和数组分配各有一个行数参数，取大的 + 2 保险
int lines = MAX2(AllocatePrefetchLines, AllocateInstancePrefetchLines) + 2;

// ② 预取范围 = 起始距离 + 每行步长 × 行数
//    即从 top+distance 开始，连续预取 lines 行
_reserve_for_allocation_prefetch = (AllocatePrefetchDistance + AllocatePrefetchStepSize * lines) / (int)HeapWordSize;
//                                                               ↑ 除以 8，把字节换算成 word
```

`end_reserve()` 再取这个值和"数组头最小空间"的较大者，作为 TLAB 末尾的保留区大小：

```cpp
// threadLocalAllocBuffer.hpp:144-150
static size_t end_reserve() {
  int reserve_size = typeArrayOopDesc::header_size(T_INT);  // 数组头最小空间
  return MAX2(reserve_size, _reserve_for_allocation_prefetch);
}
```

`alignment_reserve()` = 对齐后的 `end_reserve()`，在 `fill()` 时从 TLAB 可用空间中扣除：

```cpp
// threadLocalAllocBuffer.cpp:187
initialize(start, top, start + new_size - alignment_reserve());
//                          ↑ TLAB 实际可用范围把保留区排除在外
```

**为什么只在 C2/server 模式生效**：C1 编译的分配代码不含 prefetch 指令，不需要预留。server 模式默认使用 C2，其生成的分配代码带 prefetch 插桩（`AllocatePrefetchStyle` 相关），才需要这块"禁飞区"。

### 4.5 ④ 主线程 TLAB 重初始化——启动时序的坑

```cpp
guarantee(Thread::current()->is_Java_thread(), "tlab initialization thread not Java thread");
Thread::current()->tlab().initialize();
```

**为什么主线程的 TLAB 要重初始化？** 因为主线程对象创建得比堆早。`ThreadLocalAllocBuffer::initialize()` 空版本（threadLocalAllocBuffer.cpp:204-224）里有注释：

```cpp
// Following check is needed because at startup the main
// thread is initialized before the heap is.  The initialization for
// this thread is redone in startup_initialization below.
if (Universe::heap() != NULL) {
  size_t capacity = Universe::heap()->tlab_capacity(myThread()) / HeapWordSize;
  float alloc_frac = desired_size() * target_refills() / (float) capacity;
  _allocation_fraction.sample(alloc_frac);
}
```

主线程的 TLAB 在创建时（早于堆）调过 `initialize()`——那时 `Universe::heap() == NULL`，`tlab_capacity` 拿不到，`_allocation_fraction` 采样被跳过，`initial_desired_size()` 也因 `global_stats() == NULL` 走不到自适应分支。堆就绪后必须重做一遍。

#### initial_desired_size()——初始 TLAB 大小怎么算

```cpp
// threadLocalAllocBuffer.cpp:270-285
size_t ThreadLocalAllocBuffer::initial_desired_size() {
  size_t init_sz = 0;
  if (TLABSize > 0) {                          // 用户显式指定
    init_sz = TLABSize / HeapWordSize;
  } else if (global_stats() != NULL) {         // 自适应
    unsigned nof_threads = global_stats()->allocating_threads_avg();  // 启动时 = 1
    init_sz  = (Universe::heap()->tlab_capacity(myThread()) / HeapWordSize) /
               (nof_threads * target_refills());
    init_sz = align_object_size(init_sz);
  }
  init_sz = MIN2(MAX2(init_sz, min_size()), max_size());
  return init_sz;
}
```

自适应公式：**初始 TLAB 大小 = eden 容量 / (分配线程数 × 目标 refill 数)**。

G1 的 `tlab_capacity()`（g1CollectedHeap.cpp:2192-2194）：

```cpp
size_t G1CollectedHeap::tlab_capacity(Thread* ignored) const {
  return (_g1_policy->young_list_target_length() - _survivor.length()) * HeapRegion::GrainBytes;
}
```

即当前 eden 目标容量（young 目标 Region 数减去 survivor 数，再乘 Region 大小）。

数值示例（8GB 堆、4MB Region、young 目标 512 Region、survivor 8、单线程启动）：

```
tlab_capacity = (512 - 8) × 4MB = 2016MB
init_sz       = 2016MB / (1 × 50) ≈ 40MB
clamp         = [min_size=2KB+reserve, max_size=2MB] → 40MB 被压到 2MB
```

实际启动时往往被 `max_size()`（半 Region）钳制——这就是 §2.3 说的"上限护栏"在起作用。运行后 `resize()` 会按实际分配情况自适应调整。

---

## 5. 完成——initialize_heap() 五阶段全部讲完

③④⑤ 补齐后，`Universe::initialize_heap()` 的完整讲解闭环：

```
① create_heap()                       ch09/04
② _collectedHeap->initialize()        ch09/02-11
③ TLAB set_max_size                  本文 §2 —— 上限 = humongous 阈值
④ CompressedOops 模式决策            本文 §3 —— 4GB/32GB 阈值
⑤ TLAB startup_initialization       本文 §4 —— refills + 统计 + 主线程重初始化
```

此后的流程回到 `universe_init()`（ch08/01 全景）：SystemDictionary::initialize_oop_storage → Metaspace::global_initialize → ... → SymbolTable/StringTable::create_table。

---

## 本章小结

| 步骤 | 关键数值 | 一句话 |
|------|---------|--------|
| ③ TLAB max | `GrainWords/2`（默认 2MB） | TLAB 不允许装 humongous 对象 |
| ④ CompressedOops | 4GB / 32GB 两个阈值 | shift=3 需要堆 > 4GB；base=0 需要堆 ≤ 32GB |
| ⑤ _target_refills | `100/(2×1) = 50` | TLAB 大小校准目标，控制 gc_waste ≤ 1% |
| ⑤ 主线程重初始化 | — | 主线程 TLAB 创建早于堆，必须补初始化 |

> **下一篇**：[ch09/12 总结](12-summary.md)——回顾全部 12 篇文章如何将 `initialize_heap()` 五阶段逐行讲透。
