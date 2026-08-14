# 01. 每次 malloc 怎么被追踪到 call-site?— NMT 追踪系统

> **前置依赖**:[09-memory-core/02 — VirtualSpace: 先占坑,后付费的虚拟地址管理](openjdk/vol-02/09-memory-core/02-virtualspace.md):os::reserve_memory 是 NMT 虚拟内存追踪的钩子;[09-memory-core/03 — Arena + ResourceArea: VM 自己的 C++ 内存分配器](openjdk/vol-02/09-memory-core/03-arena-resourcearea-allocation.md):arena 的 chunk 来自 os::malloc,报告的 Arena Chunk 类别因此要专门调整;[20-vm-operations/02 — 谁在后台周期性干活?— PeriodicTask、WatcherThread 与启动序列](openjdk/vol-02/20-vm-operations/02-background-init.md):后台任务清单里没有 NMT——它是纯事件驱动的;[03-arguments-flags/01 — Flag 定义体系: 一个宏,三次展开](openjdk/vol-02/03-arguments-flags/01-flag-definition-system.md):PrintNMTStatistics 是 diagnostic flag
> → **后续**:[34-nmt/02 — NMT 报告](02-nmt-report.md)
> 关联域: 39-runtime-mon(运行时监控)、38-perfdata(另一条观测通道)

## 排查堆外泄漏,先要回答"谁 malloc 的"

应用进程的内存(RSS)一路涨,GC 日志里堆却一直稳定——问题出在**堆外**(native 内存):JVM 内部为线程栈、代码缓存、GC 辅助结构、元数据 malloc 的内存,任何一个子系统写穿都可能泄漏。`jcmd <pid> VM.native_memory summary` 能把 native 内存按 20 个类别列出来,再配合 detail 模式甚至能看到**每个分配点的调用栈**。这份报告从哪来?答案是: **VM 里每一次 `os::malloc`/`os::free`/`mmap` 调用都被登记在案**——malloc 时在用户数据前嵌入一个记账头,free 时读回头上的大小与归属,再按调用点聚合。这篇拆四层: 开关如何早于任何 malloc 就位、malloc 记账头、call-site 哈希表、虚拟内存的区域记账。

## 1. 追踪的开关: 参数怎么比 JVM 还早到达

NMT 的跟踪级别不是三档,而是**四档**(nmtCommon.hpp:35-41):

```cpp
// nmtCommon.hpp:35-41(截取核心,逐字)
enum NMT_TrackingLevel {
  NMT_unknown = 0xFF,
  NMT_off     = 0x00,
  NMT_minimal = 0x01,
  NMT_summary = 0x02,
  NMT_detail  = 0x03
};
```

`off` 是未开启;`minimal` 是"曾经开过、被 shutdown 后的残余态"(header 只占位不记录,见 §2);`summary` 按类别统计;`detail` 额外做 call-site 追踪。**启动参数 `-XX:NativeMemoryTracking=summary` 是 product flag**(globals.hpp:674),`-XX:+PrintNMTStatistics` 是 diagnostic flag(globals.hpp:677,需 `-XX:+UnlockDiagnosticVMOptions`)。

关键问题: NMT 在**第一次 `os::malloc` 时**就要完成初始化——否则早期的分配(静态变量初始化、C 运行时链接器)就漏掉了。而 `-XX:NativeMemoryTracking` 的参数解析发生在 JVM 启动的 `Arguments::parse` 阶段,那时的 malloc 已经不少了。解法是把开关交给 **launcher**: java 启动器在 JVM 起来之前扫描参数,发现 `-XX:NativeMemoryTracking=value` 就写环境变量 `NMT_LEVEL_<pid>`(java.c:825-880):

```cpp
// java.c:858-874(截取核心,逐字)
        if (JLI_StrCCmp(arg, "-XX:NativeMemoryTracking=") == 0) {
            int retval;
            // get what follows this parameter, include "="
            size_t pnlen = JLI_StrLen("-XX:NativeMemoryTracking=");
            if (JLI_StrLen(arg) > pnlen) {
                char *value = arg + pnlen;
                size_t pbuflen = pnlen + JLI_StrLen(value) + 10; // 10 max pid digits
                ...
                JLI_Snprintf(pbuf, pbuflen, "%s%d=%s", NMT_Env_Name, JLI_GetPid(), value);
                retval = JLI_PutEnv(pbuf);
```

JVM 侧在**第一次任何 NMT 动作时**读这个环境变量(memTracker.cpp:58-96):`getenv("NMT_LEVEL_<pid>")`,按值设级别,然后**立即 unsetenv**(:84,"Remove the environment variable to avoid leaking to child processes")。`tracking_level()`(memTracker.hpp:119-127)是懒初始化入口——单线程期首次调用就定死级别。参数解析阶段(arguments.cpp:3685-3701)再做双保险: `check_launcher_nmt_support` 验证环境变量与参数一致(否则 "using wrong launcher?"),`verify_nmt_option` 拒绝非法值("Syntax error, expecting -XX:NativeMemoryTracking=[off|summary|detail]")。

*关键设计: 级别一经确定,只能降不能升*——`transition_to`(memTracker.cpp:164-184)注释说得很直白: "Upgrading tracking level is not supported and has never been supported",因为升降级要增删跟踪结构,不是线程安全的;`shutdown`(jcmd 的 `VM.native_memory shutdown`)也只能降到 minimal(:157-162)。这也解释了 [实证:](planning/outlines/00-jvm-tools/materials/commands/jcmd-VM.native_memory.txt) 里第一次 `jcmd VM.native_memory` 的失败输出 "Native memory tracking is not enabled"——**运行期补不开**,只能重启加参数。

## 2. 每次 malloc 的记账: MallocHeader

`os::malloc`(os.cpp:685-742)的尾部是唯一事实来源:

```cpp
// os.cpp:723-741(截取核心,逐字)
  u_char* ptr;
  ptr = (u_char*)::malloc(alloc_size);

#ifdef ASSERT
  if (ptr == NULL) {
    return NULL;
  }
  // Wrap memory with guard
  GuardedMemory guarded(ptr, size + nmt_header_size);
  ptr = guarded.get_user_ptr();
#endif
  if ((intptr_t)ptr == (intptr_t)MallocCatchPtr) {
    log_warning(malloc, free)("os::malloc caught, " SIZE_FORMAT " bytes --> " PTR_FORMAT, size, p2i(ptr));
    breakpoint();
  }
  debug_only(if (paranoid) verify_memory(ptr));

  // we do not track guard memory
  return MemTracker::record_malloc((address)ptr, size, memflags, stack, level);
```

`alloc_size = size + nmt_header_size`(os.cpp:710): **`::malloc` 多要一个 header 的大小**,返回后 `MemTracker::record_malloc` 在块首原地构造 MallocHeader,把**用户指针后移一个 header 返回**(mallocTracker.cpp:120-148,`memblock = malloc_base + sizeof(MallocHeader)`)。于是布局是 `[MallocHeader][user_data...]`,free 时 `header = user_ptr - sizeof(MallocHeader)` 回溯(record_free :150-155),把 header 起点交还 `::free`(os.cpp:818-819)。**用户拿到的指针永远指向 header 之后的区域**——这是让追踪对调用方完全透明的关键。

MallocHeader 本身是个**位域打包的两个机器字**(mallocTracker.hpp:240-266: 类注释 "To satisfy malloc alignment requirement, NMT uses 2 machine words for tracking purpose, which ensures 8-bytes alignment on 32-bit systems and 16-bytes on 64-bit systems",LP64 下 16 字节):

```cpp
// mallocTracker.hpp:246-262(截取核心,逐字)
class MallocHeader {
#ifdef _LP64
  size_t           _size      : 64;
  size_t           _flags     : 8;
  size_t           _pos_idx   : 16;
  size_t           _bucket_idx: 40;
#define MAX_MALLOCSITE_TABLE_SIZE right_n_bits(40)
#define MAX_BUCKET_LENGTH         right_n_bits(16)
#else
  size_t           _size      : 32;
  size_t           _flags     : 8;
  size_t           _pos_idx   : 8;
  size_t           _bucket_idx: 16;
```

`_size` 是用户请求大小,`_flags` 是 MEMFLAGS(类别,占低字节,memTracker.cpp:59-61 有静态断言),`_pos_idx`/`_bucket_idx` 是 **call-site 表里的桶号与链内位置**(只有 detail 级别才写)。构造时按级别分派(mallocTracker.hpp:264-287): **minimal 级别直接 return,header 一个字都不写,纯占位**——free 的 release 路径同样在 `tracking_level() <= NMT_minimal` 时直接跳过(mallocTracker.cpp:68-70),只保持"用户指针后移 header 大小"的布局一致;summary 级别做 `MallocMemorySummary::record_malloc`(见 §3);detail 级别再调 `record_malloc_site` 把 (bucket_idx, pos_idx) 记进 header。**header 自身也记账**(:286,`record_new_malloc_header(sizeof(MallocHeader))`)——报告里的 "tracking overhead" 就是所有 header 的累计大小。

*关键设计: header 不存调用栈本身,只存表索引*——栈快照(4 帧 × 8 字节)是几十字节,索引只要 7 字节,全部分配(哪怕极小的 16 字节)也只需固定 16 字节 header 开销。对应着"追踪自身花多少"的可控性。**追踪范围只覆盖走 `os::malloc` 通道的分配**——JNI 库直接调 libc `malloc` 拿到的内存不经过这里,自然不在账本上。

## 3. summary 级别: 只做原子加减

summary 级别不查任何表,数据落在**静态快照区**里的 `MallocMemory` 计数器数组(mallocTracker.hpp:134-182,`_malloc[mt_number_of_types]`,按类别索引;静态区用 `CALC_OBJ_SIZE_IN_TYPE` 预留 size_t 数组再 placement new,与 MallocSiteTable 同款技巧)。每次 malloc/free 只是对对应类别的计数器做原子加减:

```cpp
// mallocTracker.hpp:55-71(截取核心,逐字)
  inline void allocate(size_t sz) {
    Atomic::inc(&_count);
    if (sz > 0) {
      Atomic::add(sz, &_size);
      DEBUG_ONLY(_peak_size = MAX2(_peak_size, _size));
    }
    DEBUG_ONLY(_peak_count = MAX2(_peak_count, _count);)
  }

  inline void deallocate(size_t sz) {
    assert(_count > 0, "Nothing allocated yet");
    assert(_size >= sz, "deallocation > allocated");
    Atomic::dec(&_count);
```

**每个类别两个计数器: 次数(count)与字节(size),全部原子操作,无锁无栈**。报告里的 "malloc=343389 #3287" 就是 (size, count)。类别本身是 `enum MemoryType`(allocation.hpp:114-141)——**20 类**(Java Heap/Class/Thread/ThreadStack/Code/GC/Compiler/Internal/Other/Symbol/NMT/ClassShared/Chunk/Test/Tracing/Logging/Arguments/Module/Synchronizer/Safepoint),加上哨兵 mtNone 映射到报告的 "Unknown"(nmtCommon.cpp:31-51 的名字表)。大类下还分 malloc 与 arena 两套计数器(MallocMemory, :93-128):arena 创建/销毁记 count、chunk 变化走 `record_arena_size_change` 调 `resize`。**报告输出前有个调整**(`make_adjustment`,mallocTracker.cpp:55-59): arena 的 backing chunk 是从 mtChunk 类别 malloc 的,arena 报告里算了自己的大小,所以要把它从 mtChunk 里减去,得到"真正的空闲 chunk"——这是 Arena(09-03 域)体系在报告层的对账。

## 4. detail 级别: 按调用点聚合的哈希表

detail 模式多出的数据结构是 **MallocSiteTable**: 把"相同调用栈 + 相同类别"的分配聚合成一条记录。每个入口是 `MallocSiteHashtableEntry`(mallocSiteTable.hpp:57-97),内含 `MallocSite`(=AllocationSite<MemoryCounter>: 一个 NativeCallStack + 一个计数器 + MEMFLAGS,allocationSite.hpp:33-58)。表是**静态 511 桶的哈希**(`table_size = 128*4 - 1`,:118-122),桶内是**无删除的链表**。

查表/插表在 `lookup_or_add`(mallocSiteTable.cpp:142-185): 算 hash → 取桶头 → 逐个比较(栈相同**且**类别相同才命中,:166)→ 未命中就在链尾 **CAS 插入新节点**(`head->atomic_insert`,:174,即 `Atomic::replace_if_null(entry, &_next)`)。链表"只有尾部会竞争",配合链尾 CAS,插入不需要大锁。节点分配用 `AllocateHeap(..., mtNMT, *hash_entry_allocation_stack(), RETURN_NULL)`(:201-205)——**用预先伪造的特殊调用栈**分配,否则 new_entry 自己 malloc 又会触发一次追踪,造成无限递归(注释在 mallocSiteTable.cpp:31-51 与 initialize :75-113: 表桶数组和这个"入口分配点"的占位对象都是静态数组,因为**最早的 os::malloc 调用来自 C 运行时链接器、早于任何 VM 代码**)。

并发访问由一个极简的 **AccessLock** 保护(mallocSiteTable.hpp:128-166): 一个计数器,共享访问就 `Atomic::add(1)`,排他访问(只有 shutdown)先把计数器 CAS 成负的 min_jint,等所有读者退出——"一但请求排他,共享访问永远被拒"(:125-127)。每笔 malloc 都走 `allocation_at`(共享锁 + lookup_or_add + `site->allocate(size)`),free 走 `deallocation_at`(用 header 里的 bucket_idx/pos_idx 直接定位,:214-225)。**定位是 O(桶长)的链内寻址**(malloc_site :188-196)——这正是 header 存索引的原因,free 时不用重新抓栈、不用重新哈希。

*关键设计: 表只增不减,free 只是把计数减回去*——记录"某个调用点分配过多少、现在还活着多少";新调用点入口分配失败(OOM)时**该笔分配不进表**,整个追踪自动降级到 summary(`record_malloc_site` 失败 → `MemTracker::transition_to(NMT_summary)`,mallocTracker.cpp:79-90),保证追踪自身的内存峰值有界。

## 5. 调用栈: 固定 4 帧

call-site 的键是 `NativeCallStack`——**编译期定死的 4 帧**(nmtCommon.hpp:43-45: "Number of stack frames to capture. This is a build time decision")。采集在构造时做(nativeCallStack.cpp:33-56): `os::get_native_stack(_stack, NMT_TrackingStackDepth, toSkip)` 走**帧指针链**(os_posix.cpp:120-140: 从 `os::current_frame()` 起沿 `sender_pc` 往上爬,遇到非 C 帧就停)——不是 glibc backtrace,是 HotSpot 自己的栈遍历。hash 是各帧地址求和(nativeCallStack.cpp:83-95),比较是 hash + memcmp。

谁在什么时候抓栈?答案在 **CURRENT_PC/CALLER_PC 宏**(memTracker.hpp:88-91):

```cpp
// memTracker.hpp:88-91(截取核心,逐字)
#define CURRENT_PC ((MemTracker::tracking_level() == NMT_detail && NMT_stack_walkable) ? \
                    NativeCallStack(0, true) : NativeCallStack::empty_stack())
#define CALLER_PC  ((MemTracker::tracking_level() == NMT_detail && NMT_stack_walkable) ?  \
                    NativeCallStack(1, true) : NativeCallStack::empty_stack())
```

`os::malloc(size, flags)` 默认参数就是 `CALLER_PC`(os.cpp:681-683)。**只有 detail 级别才真正抓栈**——summary 级别传空栈,连抓栈的开销都没有;这也解释了为什么 [实证:](planning/outlines/00-jvm-tools/materials/commands/34-nmt-tracking-demo.txt) 里 detail 报告的 malloc 归属段总是**恰好 4 帧调用栈**。`NMT_stack_walkable` 是平台标志(memTracker.cpp:43-47): Linux 恒 true,仅 Solaris 置 false。*关键设计: 抓栈动作是分配路径的一部分,但只在 detail 付这个钱,而且深度封顶 4*——栈深度直接决定表内存: 511 桶、桶内位置索引封顶 `right_n_bits(16)`(MAX_BUCKET_LENGTH,即 2^16-1),全部静态规划。

## 6. 虚拟内存: 按地址区间记账

malloc 用哈希表,虚拟内存却**不用哈希**——reserve/commit/uncommit/release 是对**地址区间**的操作(可能重叠、分割、合并),所以 VirtualMemoryTracker 的形态是**按地址排序的 ReservedMemoryRegion 链表**(virtualMemoryTracker.hpp:391-418,`_reserved_regions` 是 SortedLinkedList)。每个 `ReservedMemoryRegion`(hpp:290-381)记 base/size + 调用栈 + MEMFLAGS,内部再挂一个**按地址排序的 CommittedMemoryRegion 子链表**(hpp:256-284,每段也有自己的调用栈)——一个 reserve 里的多个 commit 段都记录在案。

入口链与 malloc 平行: `os::reserve_memory`(os.cpp:1759-1790)成功后调 `MemTracker::record_virtual_memory_reserve` → `VirtualMemoryTracker::add_reserved_region`(virtualMemoryTracker.cpp:332-392);commit 同理走 `add_committed_region`(:409-422)。add 时在排序链表里按地址定位,能**合并相邻且调用栈相同的区域**(try_merge_with,:84-95;committed 子区域的合并逻辑 :106-157);release 时整段删或**从中间切割**成两段(remove_released_region :437-488,split 时高半段新建 region 并把原 committed 子链表搬过去,:472-485)。虚拟内存数据结构受 **ThreadCritical 保护**(memTracker.hpp:214)——不是哈希表那种细粒度 CAS,因为区域操作天然低频。

线程栈是特例: `record_thread_stack`(memTracker.hpp:256-263)除了记区域还**借用 mtThreadStack 的 malloc 计数器记账线程数**(`record_malloc(0, mtThreadStack)`,size 0 只加 count)——所以报告里 "Thread (thread #18)" 的线程数来自这里,stack 的 committed 部分在每次快照时用 `os::committed_in_range` 现测(RegionIterator,snapshot_thread_stacks, virtualMemoryTracker.cpp:566-569)。[实证](planning/outlines/00-jvm-tools/materials/commands/34-nmt-tracking-demo.txt)里每线程栈都是 "reserved 1048576 ... from thread_native_entry" + 一个 "committed 8192"(栈底守卫页,`thread_stack_uncommitted_bottom` 跳过它们,:296-314)。

## 核心悬念

追踪系统拆完: 开关由 launcher 在 JVM 启动前经环境变量 `NMT_LEVEL_<pid>` 送达(只降不升,四级状态);每次 `os::malloc` 在用户数据前嵌一个 16 字节 MallocHeader(位域: 大小/类别/表索引),`os::free` 回溯 header 归还基址;summary 级别只做按类别的原子计数,malloc 与 arena 分账、报告前对账 chunk;detail 级别才在 511 桶的静态哈希表里按"调用栈+类别"聚合(链尾 CAS、排他锁、OOM 自动降级),栈固定 4 帧;虚拟内存按地址区间在排序链表里记账(合并/切割/子 committed 段)。[实证](planning/outlines/00-jvm-tools/materials/commands/34-nmt-tracking-demo.txt)的 summary 报告里 "Total: reserved=18058807559, committed=1165695239" 按 20 类摊开,detail 报告里 malloc 归属段 4 帧栈逐字对上 `PerfStringConstant::PerfStringConstant`→`StatSampler::create_misc_perfdata` 这类调用点,虚拟内存段对上 `G1FromCardCache::initialize` 这类分配链。

但报告本身还没出现——"reserved/committed/type" 这些原始记账怎么变成 `jcmd VM.native_memory summary` 那棵格式化输出树?快照(基线)、diff(泄漏定位)又建立在什么数据结构上?下一篇: NMT 报告。

> → [34-nmt/02 — NMT 报告](02-nmt-report.md)
