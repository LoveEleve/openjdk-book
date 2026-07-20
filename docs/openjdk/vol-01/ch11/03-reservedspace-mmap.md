# 堆从哪里来：Universe::reserve_heap 的 mmap 双阶段预约

> **本文定位**：背景知识文章。G1 的 8GB 堆不是 malloc 出来的——是 `mmap(PROT_NONE, MAP_NORESERVE)` 先占住地址空间，需要时再用 `mmap(MAP_FIXED, PROT_READ|PROT_WRITE)` 让区间可访问。这就解释了两个概念——reserve（占地址）和 commit（建页表）。
>
> **前置依赖**：ch11/01（全景）、ch11/02（Region 大小、heap_alignment=4MB）。
>
> **阅读提示**：本文只需要记住两个 flag 组合：(1) `PROT_NONE|MAP_NORESERVE|MAP_ANONYMOUS` = reserve；(2) `MAP_FIXED|PROT_READ|PROT_WRITE|MAP_ANONYMOUS` = commit。以及 G1 在 reserve 完之后靠 `G1PageBasedVirtualSpace` 按页追踪哪些区间已经 commit。

---

## 1. 场景：不能用 malloc

G1CollectedHeap::initialize 第一步：

```cpp
ReservedSpace heap_rs = Universe::reserve_heap(max_byte_size, heap_alignment);
//                     max_byte_size = 8GB, heap_alignment = 4MB
```

为什么不用 `malloc(8GB)`？

1. **地址不可控**：CompressedOops 要求堆底在 32GB 以内。`malloc` 返回的地址完全看内核和 ASLR  
2. **无法分离 reserve/commit**：`malloc` 返回的区间已可读写。G1 要求先占地址，只让初始大小的区间可访问，其余保持禁止——expand 时才按需开放  
3. **对齐不够**：堆必须 4MB 对齐，`malloc` 只保证 16 字节  

---

## 2. 两次 mmap

同一段虚拟地址，两次独立的 mmap：

```
第 1 次 — reserve（预约地址空间）：
  mmap(NULL, 8GB, PROT_NONE,
       MAP_PRIVATE | MAP_NORESERVE | MAP_ANONYMOUS, -1, 0)

第 2 次 — commit（让区间可访问，expand 时触发）：
  mmap(addr, size, PROT_READ|PROT_WRITE,
       MAP_PRIVATE | MAP_FIXED | MAP_ANONYMOUS, -1, 0)
```

man 手册 `mmap(2)` ：

| `MAP_NORESERVE` | "Do not reserve swap space for this mapping." |
| `MAP_FIXED` | "Don't interpret addr as a hint: place the mapping at exactly that address." |
| `MAP_ANONYMOUS` | "The mapping is not backed by any file; its contents are initialized to zero." |

手册还指出 "the only safe use for MAP_FIXED is where the address range was previously reserved using another mapping"——HotSpot 的 reserve-then-commit 正是此条件的标准用法。

commit 不传 `MAP_POPULATE`，所以物理帧在首次访问时由缺页中断分配（demand paging）。

---

## 3. G1 的调用路径

从 `Universe::reserve_heap` 到 `mmap` 有三层：

```
Universe::reserve_heap(8G, 4M)                ← G1 调用的入口
  └─ ReservedHeapSpace(8G, 4M, ...)           ← 构造时执行 reserve
       └─ ReservedSpace::initialize(8G, 4M)   ← 处理对齐、大页分支
            └─ os::reserve_memory(8G, ...)    ← OS 抽象层
                 └─ anon_mmap(NULL, 8G, ...)  ← 实际系统调用
```

其中 `ReservedHeapSpace` 是 `ReservedSpace` 的子类——构造时创建的是同一个 `ReservedSpace` 对象，子类只是在构造函数里额外调了 `initialize_compressed_heap`（因为 `UseCompressedOops` 在 8GB 堆下默认开启），reserve 的同时让堆底落在压缩编码可用的地址范围（ch11/16 详讲）。最底层的 `anon_mmap` 只有一个。

`ReservedHeapSpace` 继承自 `ReservedSpace`，构造后 mmap 的结果记在顶层的 7 个字段里。对理解堆预约机制，关键是这三个：

| 字段 | 8GB 堆下的值 | 含义 |
|------|-------------|------|
| `_base` | mmap 返回的起始地址 | 预约区域的起始 |
| `_size` | 8GB | 预约的字节数 |
| `_alignment` | 4MB | 对齐粒度 |

`ReservedSpace` 本身是值类型——`reserve_heap` 里 `ReservedHeapSpace total_rs(...)` 构造在栈上，`return total_rs` 把整个对象（全部 7 个字段）拷到调用方 `G1CollectedHeap::initialize` 的局部变量 `heap_rs`。 |

后续 `_collectedHeap->reserved_region()` 就靠 `_base` 和 `_size` 返回 `MemRegion`——CardTable、BarrierSet、6 个 Mapper 都依赖这个 `MemRegion` 确定各自覆盖的地址范围。

最底层只有一个入口：

```cpp
/* === src/hotspot/os/linux/os_linux.cpp:3838-3855 === */

static char* anon_mmap(char* requested_addr, size_t bytes, bool fixed) {
  int flags = MAP_PRIVATE | MAP_NORESERVE | MAP_ANONYMOUS;
  if (fixed) flags |= MAP_FIXED;
  char* addr = (char*)::mmap(requested_addr, bytes,
                              PROT_NONE, flags, -1, 0);
  return addr == MAP_FAILED ? NULL : addr;
}
```

G1 走 `requested_addr=NULL, fixed=false`——内核在任意可用地址分配。返回的地址如果不满足 4MB 对齐，`ReservedSpace::initialize` 会释放后扩大 size 用 `os::reserve_memory_aligned` 重试。

commit 一侧同样只有一个入口：

```cpp
/* === src/hotspot/os/linux/os_linux.cpp === */

int os::Linux::commit_memory_impl(char* addr, size_t size, bool exec) {
  int prot = exec ? PROT_READ|PROT_WRITE|PROT_EXEC : PROT_READ|PROT_WRITE;
  uintptr_t res = (uintptr_t)::mmap(addr, size, prot,
                    MAP_PRIVATE|MAP_FIXED|MAP_ANONYMOUS, -1, 0);
  return (res != (uintptr_t)MAP_FAILED) ? 0 : errno;
}
```

---

## 4. reserve 之后怎么追踪 commit 状态

reserve 完只有"占住了地址范围"——还需要一个数据结构追踪"哪些页已经 commit（可访问），哪些还是 `PROT_NONE`（不可访问）"。HotSpot 通用方案是 `VirtualSpace`——用 `_low` 和 `_high` 两根指针，假设 commit 是连续挨着长的：

```
[_low, _high) = 已 commit，可访问
[_high, _high_boundary) = 仅 reserve，PROT_NONE
```

G1 不用这个——它需要 commit 可以分散（比如只 commit Region 3、跳过 Region 4、再 commit Region 5）。所以 G1 用 `G1PageBasedVirtualSpace`：内部一个 `CHeapBitMap`，每个 bit 对应一页，bit=1 表示该页已 commit。`commit(page)` 就是先调上面的 `commit_memory_impl`，再设 bit；`uncommit(page)` 反过来。

6 个 `G1RegionToSpaceMapper`（堆/BOT/CardTable/CardCounts/prev_bitmap/next_bitmap）各持一个 `G1PageBasedVirtualSpace`，独立管理各自的 reserve/commit——后续章节详讲。

---

## 5. 完成时的状态

`Universe::reserve_heap(8G, 4M)` 执行完毕后：

- OS：一段 8GB 虚拟地址空间归属本进程，`PROT_NONE`
- HotSpot：`_base` 指向起始地址，`_size = 8GB`
- 物理内存 ≈ 0（MAP_NORESERVE）

堆还不能用——没有 commit、没有 Region 对象、没有 GC 线程。
