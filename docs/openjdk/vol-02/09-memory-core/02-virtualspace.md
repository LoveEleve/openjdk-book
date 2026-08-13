# 02. VirtualSpace — 先占坑,后付费的虚拟地址管理

> **前置依赖**:[09-memory-core/01 — Universe + CollectedHeap](openjdk/vol-02/09-memory-core/01-universe-heap.md):`G1CollectedHeap::initialize` 里 `Reserve the maximum` 的底层机制就是这一篇;[01-os/02 — 虚拟内存](openjdk/vol-02/01-os/02-virtual-memory.md):mmap/页表/虚拟地址空间的概念基础;[16-code-cache/01 — CodeBlob 与 CodeHeap](openjdk/vol-02/16-code-cache/01-codeblob-heap.md):CodeCache 用 CodeHeap 而非 VirtualSpace(本篇会对照)
> → **后续**:[09-memory-core/03 — Arena/ResourceArea](03-arena-resourcearea-allocation.md)(VM 自己的 C++ 内存分配器)
> 关联域: 01-os(系统调用)、09-memory-core(内存管理)、10-metaspace(元数据空间)、16-code-cache(代码缓存)

## 占 32GB 的坑,只付 8GB 的钱

G1 默认最大堆是物理内存的 1/4(`MaxRAMFraction` 默认 4,gc_globals.hpp:320;`MaxHeapSize = physical_memory × MaxRAMPercentage%`,arguments.cpp:1750-1751),但 `-Xmx32g` 意味着 JVM 启动就要拿到 32GB 虚拟地址——不是 32GB 物理内存。操作系统允许"reserve 与 commit 分离": 先把地址空间占住(不产生物理页),用到哪再给哪补物理页。hotspot 把这两件事拆成了两个类: `ReservedSpace`(占坑)与 `VirtualSpace`(按需提交)。上一讲 `G1CollectedHeap::initialize` 里那句 `Reserve the maximum`,落到底层就是这篇的两个类与一组 mmap/mprotect 系统调用。

## 1. 占坑: PROT_NONE 的 mmap

### 一次 reserve 的完整样貌

Linux 上 reserve 的真相是 `anon_mmap`(os_linux.cpp:3838-3855,截取核心,逐字):

```cpp
// os_linux.cpp:3838-3855(截取核心,逐字)
static char* anon_mmap(char* requested_addr, size_t bytes, bool fixed) {
  char * addr;
  int flags;

  flags = MAP_PRIVATE | MAP_NORESERVE | MAP_ANONYMOUS;
  if (fixed) {
    assert((uintptr_t)requested_addr % os::Linux::page_size() == 0, "unaligned address");
    flags |= MAP_FIXED;
  }

  // Map reserved/uncommitted pages PROT_NONE so we fail early if we
  // touch an uncommitted page. Otherwise, the read/write might
  // succeed if we have enough swap space to back the physical page.
  addr = (char*)::mmap(requested_addr, bytes, PROT_NONE,
                       flags, -1, 0);

  return addr == MAP_FAILED ? NULL : addr;
}
```

两个关键点:

- **`MAP_NORESERVE`**: 告诉内核"别为这些页预留 swap/记账"——32GB 的虚拟地址几乎零成本;
- **`PROT_NONE`**: 比 MAP_NORESERVE 更狠的一层保险。注释说得很直白: 不设成 PROT_NONE 的话,误写未提交页可能"碰巧"成功(只要 swap 够)——那是隐蔽的内存泄漏;设为 PROT_NONE 后,任何未提交页的访问都**立刻 SIGSEGV**,问题当场暴露。注意 mmap 的是整个区域,不是只有前缀——流传说法里"PROT_NONE 只给 _noaccess_prefix"是错的(§2 会讲 _noaccess_prefix 的真正用途)。

顺带澄清一个流传的数字: `os::vm_allocation_granularity()` 在 Linux 上就是**页大小**(os_linux.cpp:3126-3129,通常 4KB),不是 64KB。"至少 64K"只是 virtualspace.cpp:186 注释里对多数 OS 返回地址对齐情况的观察。

### ReservedSpace::initialize: 对齐的攻防

`ReservedSpace::initialize`(virtualspace.cpp:120-232)先做断言(大小与对齐必须是 granularity 的倍数,:124-129),然后 `alignment = MAX2(alignment, os::vm_page_size())`(:131)。之后三种路径:

- **请求特定地址**(压缩 oops 需要堆在固定位置): `os::attempt_reserve_memory_at`(:193),失败会返回 NULL;
- **普通 reserve**: `os::reserve_memory(size, NULL, alignment)`(:199-200);
- **返回地址不对齐**: 释放,改走 `os::reserve_memory_aligned`(:206-222)。

"不对齐就重试最多 10 次"是流传说法,实际是**一次重试 + 超额保留**——`os::reserve_memory_aligned`(os_posix.cpp:287-340,截取核心,逐字):

```cpp
// os_posix.cpp:287-340(截取核心,逐字)
char* os::reserve_memory_aligned(size_t size, size_t alignment, int file_desc) {
  assert((alignment & (os::vm_allocation_granularity() - 1)) == 0,
      "Alignment must be a multiple of allocation granularity (page size)");
  assert((size & (alignment -1)) == 0, "size must be 'alignment' aligned");

  size_t extra_size = size + alignment;
  assert(extra_size >= size, "overflow, size is too large to allow alignment");

  char* extra_base;
  if (file_desc != -1) {
    // For file mapping, we do not call os:reserve_memory(extra_size, NULL, alignment, file_desc) because
    // we need to deal with shrinking of the file space later when we release extra memory after alignment.
    // We also cannot called os:reserve_memory() with file_desc set to -1 because on aix we might get SHM memory.
    // So here to call a helper function while reserve memory for us. After we have a aligned base,
    // we will replace anonymous mapping with file mapping.
    extra_base = reserve_mmapped_memory(extra_size, NULL);
    if (extra_base != NULL) {
      MemTracker::record_virtual_memory_reserve((address)extra_base, extra_size, CALLER_PC);
    }
  } else {
    extra_base = os::reserve_memory(extra_size, NULL, alignment);
  }

  if (extra_base == NULL) {
    return NULL;
  }

  // Do manual alignment
  char* aligned_base = align_up(extra_base, alignment);

  // [  |                                       |  ]
  // ^ extra_base
  //    ^ extra_base + begin_offset == aligned_base
  //     extra_base + begin_offset + size       ^
  //                       extra_base + extra_size ^
  // |<>| == begin_offset
  //                              end_offset == |<>|
  size_t begin_offset = aligned_base - extra_base;
  size_t end_offset = (extra_base + extra_size) - (aligned_base + size);

  if (begin_offset > 0) {
      os::release_memory(extra_base, begin_offset);
  }

  if (end_offset > 0) {
      os::release_memory(extra_base + begin_offset + size, end_offset);
  }
```

策略是"**超额保留,手动对齐,两侧割掉**": 干脆多 reserve `alignment` 字节(:292),把 `extra_base` 向上对齐到 alignment(:315),然后把前部(begin_offset)与后部(end_offset)分别释放(:327-334)——不管内核把基址给到哪,总能在 [extra_base, extra_base+alignment) 里找到一个对齐点。一次调用搞定,不需要循环。

大页是另一条路: `special = large && !os::can_commit_large_page_memory()`(virtualspace.cpp:148)——不支持按需提交大页时,`reserve_memory_special` 一次把整块大页钉死(_special 标志,整个区域全程已提交)。

**关键设计 (斜体)**: *reserve 的语义是"地址空间"而非"内存": MAP_NORESERVE 让大块虚拟地址近乎免费,PROT_NONE 把"误用未提交页"从隐蔽错误变成当场崩溃。对齐问题用超额保留解决——用一点点虚拟地址冗余,换掉循环重试的不确定性与多次系统调用。*

## 2. noaccess prefix: 压缩 oops 的"护栏"

流传说法里 "noaccess_prefix = 对齐后 base 前有多余空间" 是错的——普通 ReservedSpace 的 `_noaccess_prefix` 恒为 0,它只属于 `ReservedHeapSpace`(堆专用子类),且动机是**压缩 oops 的隐式 null 检查**(virtualspace.cpp:301-327,截取核心,逐字):

```cpp
// virtualspace.cpp:301-327(截取核心,逐字)
void ReservedHeapSpace::establish_noaccess_prefix() {
  assert(_alignment >= (size_t)os::vm_page_size(), "must be at least page size big");
  _noaccess_prefix = noaccess_prefix_size(_alignment);

  if (base() && base() + _size > (char *)OopEncodingHeapMax) {
    if (true
        WIN64_ONLY(&& !UseLargePages)
        AIX_ONLY(&& os::vm_page_size() != 64*K)) {
      // Protect memory at the base of the allocated region.
      // If special, the page was committed (only matters on windows)
      if (!os::protect_memory(_base, _noaccess_prefix, os::MEM_PROT_NONE, _special)) {
        fatal("cannot protect protection page");
      }
      log_debug(gc, heap, coops)("Protected page at the reserved heap base: "
                                 PTR_FORMAT " / " INTX_FORMAT " bytes",
                                 p2i(_base),
                                 _noaccess_prefix);
      assert(Universe::narrow_oop_use_implicit_null_checks() == true, "not initialized?");
    } else {
      Universe::set_narrow_oop_use_implicit_null_checks(false);
    }
  }

  _base += _noaccess_prefix;
  _size -= _noaccess_prefix;
  assert(((uintptr_t)_base % _alignment == 0), "must be exactly of required alignment");
}
```

- `noaccess_prefix_size(alignment)` = `lcm(page_size, alignment)`(:297)——页大小与对齐的最小公倍数;
- 触发条件是 `base + size > OopEncodingHeapMax`(:305)——堆顶越过了压缩 oops 的编码上限(`OopEncodingHeapMax = 2^32 << LogMinObjAlignmentInBytes`,默认 8 字节对齐下即 32GB,arguments.cpp:1609),意味着压缩指针需要非零 base,此时**堆基址下方那一页必须不可访问**: 隐式 null 检查的原理是——null(或很小偏移)解引用落在堆基址正下方,只有那里 PROT_NONE,解引用 null 才必然 SIGSEGV,而不是读到堆里的合法对象;
- 之后 `_base += _noaccess_prefix; _size -= _noaccess_prefix`(:318-319): 保护页从堆的账本里让出——`compressed_oop_base()`(virtualspace.hpp:120-123)= `_base - _noaccess_prefix` 暴露真正的压缩基址;`release()` 时也要算回 `real_base = _base - _noaccess_prefix`(virtualspace.cpp:277-278)才能完整释放。

## 3. VirtualSpace: 三段与顺序提交

### 一个 reserved 区域,切成三段来 commit

`VirtualSpace` 的类注释是它的自白: "data structure for committing a previously reserved address range in smaller chunks"(virtualspace.hpp:137)。三段布局的注释在 :152-158: 每个区域(lower/middle/upper)有自己的 end boundary 与 high 指针(注释原话: "the high water mark for the last allocated byte"——已提交字节的水位线);**lower 与 upper 用普通页,中间的 middle 用大页粒度**——这就是 MPSS(多页大小支持)的形态。

`initialize_with_granularity`(virtualspace.cpp:680-727)把边界与三段起点算好(截取核心,逐字):

```cpp
// virtualspace.cpp:704-727(截取核心,逐字)
  _lower_alignment  = os::vm_page_size();
  _middle_alignment = max_commit_granularity;
  _upper_alignment  = os::vm_page_size();

  // End of each region
  _lower_high_boundary = align_up(low_boundary(), middle_alignment());
  _middle_high_boundary = align_down(high_boundary(), middle_alignment());
  _upper_high_boundary = high_boundary();

  // High address of each region
  _lower_high = low_boundary();
  _middle_high = lower_high_boundary();
  _upper_high = middle_high_boundary();

  // commit to initial size
  if (committed_size > 0) {
    if (!expand_by(committed_size)) {
      return false;
    }
  }
  return true;
}
```

注意流传的"初始只有 lower 提交,`_middle_high = _upper_high = _lower_high`"不成立: 三段 high 指针各自指向自己区域的起点(:717-719),初始提交量直接走 `expand_by(committed_size)`(:723-726)——提交量大时会直接提交进 middle 段。

### expand_by: 只能从 high() 顺序推进

`expand_by`(virtualspace.cpp:844-928)的提交顺序是 **lower → middle → upper 依次推进**(:906-925,每段先算 needs 再 `commit_expanded`)。为什么不能跳段?三段的对齐粒度不同: 中间段按大页粒度提交(:704-706)。注释把来龙去脉写在 :833-842: 大空间(>LargePageSizeInBytes)从一开始就按大页粒度设计 expand/shrink,让 OS 的大页物理页不被割裂——如果跳过 lower 直接提交 middle,两端粒度不一致会把可合并的大页区域切成碎块。shrink 同理: `shrink_by`(:935 起)从 high() 往回,**先 upper 后 middle 后 lower**(:980-1000 的三个 if 块),永远不动中间未满段的内部——"不能从内部 uncommit"的说法由此而来。`_special` 的整个区域已钉死时,expand/shrink 只是挪指针(:856-860,:939-943),不碰系统调用。

**关键设计 (斜体)**: *三段不是三段"用途",而是三种"提交粒度": 两头的普通页(小步进、低浪费),中间的大页(吞吐优先)。顺序提交/收缩保证已提交区域永远是从基址开始的连续区间——uncommit 与 commit 都只碰边界,中间永不出现洞。*

## 4. 系统调用层: commit 与 uncommit 的真相

- **commit**: `os::pd_commit_memory`(os_linux.cpp:3230-3232)→ `commit_memory_impl`(os_linux.cpp:3209-3218,截取核心,逐字):

```cpp
// os_linux.cpp:3209-3218(截取核心,逐字)
int os::Linux::commit_memory_impl(char* addr, size_t size, bool exec) {
  int prot = exec ? PROT_READ|PROT_WRITE|PROT_EXEC : PROT_READ|PROT_WRITE;
  uintptr_t res = (uintptr_t) ::mmap(addr, size, prot,
                                     MAP_PRIVATE|MAP_FIXED|MAP_ANONYMOUS, -1, 0);
  if (res != (uintptr_t) MAP_FAILED) {
    if (UseNUMAInterleaving) {
      numa_make_global(addr, size);
    }
    return 0;
  }
```

用 `MAP_FIXED` 在同一地址重新映射成可读写(exec 时加 PROT_EXEC)——**虚拟地址不变,权限升级**;

- **uncommit**: `os::pd_uncommit_memory`(os_linux.cpp:3641-3645,截取核心,逐字):

```cpp
// os_linux.cpp:3641-3645(截取核心,逐字)
bool os::pd_uncommit_memory(char* addr, size_t size) {
  uintptr_t res = (uintptr_t) ::mmap(addr, size, PROT_NONE,
                                     MAP_PRIVATE|MAP_FIXED|MAP_NORESERVE|MAP_ANONYMOUS, -1, 0);
  return res  != (uintptr_t) MAP_FAILED;
}
```

流传的"uncommit = `madvise(MADV_DONTNEED)`"在 jdk11u 里不成立——它是**再一次 mmap,把页重新映射回 PROT_NONE + MAP_NORESERVE**: 权限收回,物理页释放,虚拟地址保留。与 reserve 时的状态一模一样——commit/uncommit 是同一块地址在"可读写"与"PROT_NONE"两种映射之间的往返。

**谁在用这套机制**: GC 堆是 `ReservedHeapSpace` + 自己的 region 管理(G1 的 HeapRegionManager 在 reserved 区域里划 region),不走 VirtualSpace;**CodeCache 也不走 VirtualSpace**——它是三个独立的 `CodeHeap`(codeCache.hpp:89-92 的 `_heaps`/`_nmethod_heaps` 列表,16 域讲过),流传的"CodeCache 用 VirtualSpace 三段: lower=non-profiled、middle=profiled、upper=non-method"张冠李戴——CodeCache 的三段是三个 CodeHeap 实例,不是一段虚拟空间的三段。真正吃 VirtualSpace 的是 **Metaspace**: `VirtualSpaceList`(metaspace/virtualSpaceList.hpp:39)管理一串 VirtualSpaceNode,按空间类型取列表(metaspace.cpp:372),chunk 从当前 VirtualSpace 里切。

## 5. MemRegion: 一段内存的身份证

GC 代码里到处传递的 `MemRegion`(memRegion.hpp)是最轻量的区域抽象: `HeapWord* _start` + `size_t _word_size` 两个字段(:48-49),**按值传递**的纯数据(注释明说: 无对象、平凡拷贝,:36-40)。操作只有 `contains`(:81-88,地址/区域是否在内)、`intersection`(:64)、`_union`、`minus`。它只是"描述一段区间"的身份证,不是分配器也不是容器——流传的"G1 的 HeapRegion 是 MemRegion 子类"是错的: `HeapRegion : public G1ContiguousSpace`(heapRegion.hpp:191),MemRegion 只是被 GC 借来表示"哪段地址归谁"。

## 核心悬念

reserve/commit 的地基到齐: reserve 用 PROT_NONE + MAP_NORESERVE 占住地址空间(超额保留手动对齐代替重试)、ReservedHeapSpace 的 noaccess prefix 给压缩 oops 竖起保护页、VirtualSpace 按 lower/middle/upper 三粒度顺序提交与收缩、commit/uncommit 是同一地址在两种映射间的往返、MemRegion 是轻量区域身份证。但到目前为止,这些"内存"都是**裸地址**: 谁来负责把一块块区域切成可复用的小块、谁管理"用完还给谁"?GC 堆里有 region/chunk 管理器,而 VM 自己的 C++ 代码(元数据、调试、编译中间表示)靠的是 Arena 与 ResourceArea——Chunk 分配与栈式生命周期。下一篇: VM 自己的内存分配器。

> → [09-memory-core/03 — Arena/ResourceArea](03-arena-resourcearea-allocation.md)
