# 02. "16G heap 在 8G 机器上？" — 虚拟内存 + 大页面 + 栈保护

> 🔴 Deep | 23 KP 中的 5 个核心机制
> 读者处境: 你见过 `-Xmx16g` 但不理解 reserve/commit 的区别——这篇是答案。

### 1. reserve vs commit — "预订座位"和"真的来了"

场景: 餐厅 8 个座位，你订了 16 个。服务员记在本子上——没搬椅子。JVM reserve 内存就是这个逻辑——占地址空间，不占物理内存。

**mmap(MAP_NORESERVE)** (`os_linux.cpp:4235-4260`):
- `void *mmap(NULL, size, PROT_READ|PROT_WRITE, MAP_PRIVATE|MAP_ANONYMOUS|MAP_NORESERVE, -1, 0)` — 只预留地址空间
- [C++: mmap 参数详解——NULL=让内核选地址，size=请求大小(向上对齐到 page_size)，PROT_READ|PROT_WRITE=可读写，MAP_PRIVATE=写时复制(copy-on-write)，MAP_ANONYMOUS=不关联文件(匿名映射)，MAP_NORESERVE=不预分配 swap 空间。返回 void* = 映射起始地址，失败返回 MAP_FAILED (-1)]
- [man 2 mmap]
- [内核: overcommit 策略——vm.overcommit_memory=0 (默认 heuristic): 内核估算"有没有足够物理+swap"，允许合理超量; =1 (always): 永远允许，不管物理内存; =2 (strict): 严格限制，mmap 必须确保有物理页支撑。JVM 依赖 heuristic 模式——reserve 16GB 在 8GB 机器上可能成功(视内核估算)，但在 strict 模式直接失败]
- [man 5 proc] (`/proc/sys/vm/overcommit_memory`)

**mmap(MAP_FIXED)** (`os_linux.cpp:4333-4360`):
- 在已预留的地址空间中 commit——现在真正分配物理页
- [C++: MAP_FIXED 强制映射到指定地址。危险——如果目标地址已被占用(其他 mmap/shared library)，新映射会**替换**旧映射——可能破坏栈/heap。JVM 用 MAP_FIXED 是因为 reserve 阶段已经确保了地址范围，commit 时这个范围是已知安全的]
- 为什么不用 brk()？→ brk 只能扩展 heap 的连续区域——不能独立管理不同用途的地址范围。JVM 的 GC heap、Metaspace、CodeCache 需要各自独立的虚拟地址范围——mmap 每个独立管理

**为什么不是 malloc/free？** — G1 heap region 需要连续虚拟地址(region bitmap 索引的前提)。16GB heap 用 malloc 被碎片化成 N 个不连续块→region 索引断裂。且 malloc 在 16GB 上的内存碎片问题更严重——glibc malloc 用 arena 机制(多线程竞争)→每个 arena 独立管理一部分 heap→碎片

**Page fault minor vs major** (`os.cpp:1873-1877`):
- minor: 页在内存，只需页表更新——~1µs。发生: 进程首次访问已分配的页(TLB miss + page table walk)
- major: 页不在内存(被 swap out 或从未分配)——~10ms (需要 disk I/O)
- [x86: page fault handler 流程——CPU 查 TLB→miss→查 page table→entry 的 present bit=0→#PF exception (vector 14)→内核 vm_fault handler→检查 vma (virtual memory area)——如果 vma 有页但未映射→minor fault (分配+映射)→如果 vma 无页需要 IO→major fault (读 disk)]
- Pre-touch (`os.cpp:1873`): 起一个新线程——逐页写零值——制造 minor fault——强迫 OS 现在就分配物理页。不做 Pre-touch→GC 在遍历 heap region 时遇到上千次 page fault→pause time 膨胀 10x

**uncommit / release 路径**:
- uncommit → madvise(MADV_DONTNEED): 告诉内核"这些页我不要了"——保留地址空间但释放物理页——G1 可之后再 commit 同一 region
- release → munmap: 完全释放——地址空间+物理页一起还
- [C++: madvise(MADV_DONTNEED) vs munmap。madivse 只影响物理页——虚拟地址空间保留。munmap 释放全部。G1 region decommit 用 MADV_DONTNEED 因为 region 可能之后被复用]
- [man 2 madvise] [man 2 munmap]

**pd_* 平台分发** (`os.hpp:120-152`):
- share 层: `os::reserve_memory()` → 调 `pd_reserve_memory()`——虚函数 dispatch
- Linux 层: `os_linux.cpp` 实现 pd_reserve——实际调 mmap
- 上层代码 (GC/Compiler/ClassLoader) 只调 `os::reserve_memory()`——完全不感知底层是 mmap 还是 VirtualAlloc(Windows)

### 2. 大页面 — TLB miss: 15% → 1%

**为什么大页面？** (`os.hpp:111-117`):
- [x86: TLB (Translation Lookaside Buffer)——CPU 上 ~64 个条目的硬件缓存，翻译虚拟地址→物理地址。TLB hit=1 cycle，TLB miss=page table walk (4 次内存访问 = ~100 cycles)。4KB 页面: 2GB heap / 4KB = 524,288 个潜在 TLB miss——TLB 只有 64 个槽——频繁 eviction。2MB 页面: 2GB / 2MB = 1,024 个页面——TLB miss 率从 ~15% 降到 ~1%]
- `_page_sizes[max=9]` 降序排列(最大优先)，sentinel=0 (`os.hpp:111`)
- `page_size_for_region()`: 给定 region_size + min_pages 约束→选最大适配页面(`os.cpp:1488`)

**hugetlbfs** (`os_linux.hpp:93-108`):
- mount -t hugetlbfs → mmap 预留——100% 保证 huge page
- 需要 root 预配置——`echo 1024 > /proc/sys/vm/nr_hugepages`
- [内核: hugetlbfs 是独立文件系统——挂载在 `/dev/hugepages`——mmap 文件=获得 huge page。池大小固定(预分配)——用完后新的 hugetlb mmap 失败。不能 swap——物理页锁定在 RAM]

**SHM** (`os_linux.hpp:99`):
- shmget(SHM_HUGETLB) → shmat——IPC 共享内存+大页面标志
- [C++: shmget 返回 SystemV IPC identifier——shmat 映射到进程。SHM_HUGETLB 标志告诉内核从 huge page 池分配。需要 IPC_PRIVATE 或 ftok 生成 key]
- [man 2 shmget] [man 2 shmat]

**THP + khugepaged** (`os_linux.cpp:3932`):
- madvise(MADV_HUGEPAGE)——零配置，内核决定是否合并
- [内核: khugepaged 内核线程——扫描进程的虚拟地址空间——发现 512 个连续 4K 页=2MB→合并为 1 个 huge page→更新全部 PTE。合并时 stop_machine——所有 CPU 暂停 (kernel 4.x 前) 或用锁保护 (kernel 5.x+)。JVM 禁用 THP 的根因: khugepaged 跨 G1 region 边界合并——打破独立回收语义——一个 Old region 和一个 Young region 被合并到同一 huge page→Old 被回收时 huge page 拆分→1,535 次额外的 page fault]
- [man 2 madvise] [man 7 kernel] (Transparent Hugepage Support)

### 3. 栈保护 — 递归 10 万次不 crash

**四级保护区** (`os.cpp:449-466`):
- Yellow → StackOverflowError (Java 异常)——可恢复——`Thread::stack_overflow_state` 被设置→抛异常
- Red → fatal error + hs_err——不可恢复——栈已用尽，无法执行抛出异常的代码
- Reserved → 保障抛出 StackOverflowError 时还有栈帧可用——异常抛出需要 ~3KB 栈空间(Throwable.fillInStackTrace 的调用链)
- Shadow → 信号处理器 (SIGSEGV handler) 执行所需的最小栈预留(~2KB)
- [C++: mprotect(PROT_NONE)——把保护区页面设为不可访问。线程触及→#PF→SIGSEGV→handler 检查 faulting address——如果在 yellow zone→设置 StackOverflowError→longjmp 到异常处理。如果已经在 yellow 内→说明在 red zone→fatal。默认: yellow=8KB, red=4KB, reserved=8KB, shadow=4KB]
- [man 2 mprotect]

**os::guard_memory / unguard_memory** (`os.cpp:1456-1468`):
- 底层实现: mprotect 设置页面保护——每次 Java 线程创建时调用——为每个线程分配独立的 4 个 guard 页
- [C++: 栈增长方向——x86 从高地址向低地址增长(rsp -= N)。栈底=低地址边界。guard 页在栈底——线程向低地址写越过栈底→触 guard→SIGSEGV。不是 guard "栈顶"——是 guard "栈底"]

### 4. 辅助 — 内存保护 + 内存映射 + Pre-touch

**内存保护** (`os.hpp:370-378`):
- protect_memory: MEM_PROT_NONE/READ/RW/RWX——mprotect 封装
- guard_memory/unguard_memory: 栈 guard 页管理

**内存映射文件** (`os.hpp:379-396`):
- map_memory→remap_memory→unmap_memory——完整 mmap 封装链
- AllocateHeapAt (-XX:HeapDir): 堆文件映射——堆放到 NVMe/PMEM
- [内核: DAX (Direct Access)——PMEM 直接映射到物理地址——绕过 page cache。mmap + MAP_SYNC——store 直接持久化——不需要 fsync。JVM heap 用 DAX→GC 的 write barrier 直接持久化——crash 后 heap 状态可恢复]

---

### 核心悬念

**"JVM 怎么让 16GB heap 在 8GB 机器上运行？"** — reserve 占地址空间不用物理内存——OS 的 overcommit 策略允许"假预订"。commit 在 GC 需要时真正分配——但 Pre-touch 把 page fault 前置。大页面减少 TLB miss——但 THP 的 khugepaged 跨 region 合并抵消收益。下一篇: 内存是堆的容器——线程是栈的容器。JVM 内部有 7 种线程——它们谁先谁后？

> → [03-threads-and-sync.md](03-threads-and-sync.md)
