# PROMPT: 请撰写 03-Memory.md

## 〇、背景与使用场景

### 你在凌晨 3 点被报警唤醒时经历了什么

`top` 显示 JVM 的 RSS 是 2.1GB。但你检查 `-Xmx`——只有 1GB。你检查 `jcmd <pid> GC.heap_info`——堆使用 800MB。差了 1.3GB——在哪里？

你打开 hs_err 文件的 `Memory map` 段：

```
0x0000000080000000-0x0000000100000000 ---p 00000000 00:00 0           [heap reserved]
0x0000000080000000-0x00000000a0000000 rw-p 00000000 00:00 0           [heap committed]
0x00000000a0000000-0x00000000c0000000 rw-p 00000000 00:00 0           [heap committed]
0x00007f8b1a000000-0x00007f8b1a200000 rwxp 00000000 00:00 0          [CodeCache]
0x00007f8b1ae00000-0x00007f8b1be00000 rw-p 00000000 00:00 0          [Metaspace]
0x00007f8b2c000000-0x00007f8b2d000000 rw-p 00000000 00:00 0          [thread stack: 12494]
...

---p 段的总大小是 2.0GB——reserve 了没 commit。rw-p 段的总大小只有 800MB——实际 commit 的。但 RSS 为什么是 2.1GB？

因为非堆内存：Metaspace 800MB、CodeCache 128MB、200+ 线程栈 × 1MB ≈ 200MB、GC 数据结构（remembered set 位图、SATB 队列、CardTable）≈ 100MB、glibc malloc arena ≈ 50MB...这些加在一起超过了 1.3GB 的差额。而且 glibc 的 `malloc_trim` 不会主动 munmap——内存释放在 glibc 内部空闲链表中，RSS 不降。

另一个场景：G1 GC 时间从 80ms 突然变成 800ms。`-XX:+PrintGCDetails` 显示 `Humongous Allocation` 频繁失败——因为需要 2MB 对齐的 Huge Page 分配，但 `os::reserve_memory_special` 用了 SHM 路径 → `shmget(SHM_HUGETLB)` 从 hugetlbfs 池分配 → 池不够 → 回退到 4KB 小页 → Humongous region 被拆成 512 个 4KB 页 → GC 找连续区域的开销 O(n²)。

### 背景概念速览

- **reserve vs commit 两阶段模型**：`reserve_memory` → `mmap(PROT_NONE, MAP_NORESERVE)` ——虚拟地址空间记账，不分配物理页。`commit_memory` → `mmap(PROT_READ|PROT_WRITE, MAP_FIXED)` ——在同一虚拟地址上覆盖映射，建立页表映射，分配物理页（page fault 时 lazy）。这是 JVM 内存管理的"第一公里"——所有堆页、CodeCache、Metaspace 都经过这两个阶段。
- **MAP_NORESERVE**：Linux overcommit 控制。带此标记的 mmap 不预留交换空间 → 内核 OOM Killer 不会为此映射保留"不杀的票"→ 物理内存紧张时这个映射优先被 OOM。
- **MAP_FIXED**：强制在指定虚拟地址上建立映射——如果该地址已有旧映射 → 内核先 munmap 旧映射再建立新映射。JVM 用它在同一个 reserve 地址上覆盖 PROT_NONE → PROT_READ|PROT_WRITE（这就是"commit"的本质）。
- **RSS（Resident Set Size）**：物理内存中的页框数。只有被 commit + 实际访问过的页计入 RSS。reserve 但不 commit 的页不计入；commit 但从未被读写的页可能也不计入（取决于 overcommit 策略和 prefault 行为）。

### 相关生态工具

- **`pmap -x <pid>`**：按 address range 排序的虚拟内存布局——能看到每个 `---p`（reserve 不 commit）和 `rw-p`（commit 可读写）段的大小。
- **`/proc/<pid>/smaps`**：比 pmap 更详细——每段的 `Rss`、`Pss`、`Swap`、`Anonymous` 字段。能精确计算"哪个段吃了多少物理内存"。
- **`jcmd <pid> VM.native_memory summary`**：如果启用了 `-XX:NativeMemoryTracking=summary`——NMT 按类别（Java Heap / Metaspace / Code / Thread / GC）报告 reserved vs committed 内存。
- **`-XX:+AlwaysPreTouch`**：启动时 touch 所有堆页 → 强制 page fault 在启动时发生 → OOM 发生在启动而非运行时 → 避免生产环境 OOM Killer 随机杀进程。

## 一、任务 + 核心故事线（禁止做源码翻译机！）

读者学完了 [08-safepoint]——理解了 GC 期间 `CardTable`、`RSet` 等 GC 辅助数据结构需要 mmap 内存。读者学完了 [06-gc-memory]——理解了 G1 的 `HeapRegion`、`Humongous region`、`PLAB` 等堆内结构。

但是，这些文章有一个共同的未解问题：**这些内存页从哪里来？** 堆不是 C++ 的 `new char[1GB]`——它是 `mmap` 出来的。每个页从"虚拟地址空间的一个承诺"变成"物理内存的一个页框"，经过了 `reserve → commit → uncommit → release` 的四态生命周期。`top` 显示 RSS 2GB 但 `-Xmx` 只有 1GB——根源就在这四态模型中。

**本文不是 mmap 手册**——不讲 `MAP_ANONYMOUS` vs `MAP_SHARED` vs `MAP_PRIVATE` 的内核页表差异、不讲 overcommit 的三态 `/proc/sys/vm/overcommit_memory`（0/1/2）、不讲 kernel same-page merging（KSM）的 `madvise(MADV_MERGEABLE)`。本文也不是 Linux 内存管理教程——不讲 buddy allocator / slab / vmalloc / kmalloc 的区别。

**本文的唯一目标是：追踪 JVM 堆内存从 `ReservedSpace::initialize` → `os::reserve_memory` → `os::commit_memory` → `mmap(PROT_NONE)` → `mmap(MAP_FIXED)` 的完整四态生命周期。** 关键是：`commit_memory_impl` 中 `mmap(MAP_FIXED)` 覆盖旧 PROT_NONE 映射——中间有原子性 gap 吗？`MAP_NORESERVE` 和 overcommit 策略如何交互？VirtualSpace 的 low/high watermark 在 uncommit→recommit 交替中会不会被"空洞"破坏？

### 核心叙事线——"物理内存从哪里来"

08 的 GC 讲"Eden 区满了，要回收", [10-03] 的 MemoryService 讲"pool usage 上升了"。但没有一篇讲这些页从哪里来。本文是 JVM 内存管理的"第一公里"——在 GC 和 MemoryService 之下，有 `mmap` / `mprotect` / `MAP_FIXED` / `MAP_NORESERVE` 四态生命周期。读者读完本文后，看到 `top` 的 RSS 数字时能追溯到具体哪些 mmap 段贡献了多少物理内存。

### 和 README §V 的关系

[11-os-layer README](README.md) §五的对比表列出了 11 阶段和 08/09/10 的维度差异。本文的"内存映射"是 OS 三原语的第三原语——它是 08（GC 期间内存操作）和 06（堆结构）的物理实现层。读者读完本文后应能理解 06 的 G1 heap 和本文的 reserve→commit 如何形成"堆逻辑结构 ↔ OS 虚拟内存"的映射。

## 二、标准环境

- OpenJDK 11 slowdebug build
- `-Xms8g -Xmx8g -XX:+UseG1GC`
- 64 位 Linux x86
- ★ `/proc/sys/vm/overcommit_memory = 0`（默认 heuristic overcommit）
- ★ GDB 在 slowdebug build 中验证（`#ifdef ASSERT` 全部生效）

## 三、聚焦源文件

| # | 文件 | 路径 | 模块 | 核心函数/类（行号） | 本文角色 |
|---|------|------|------|-------------------|---------|
| 1 | `os_linux.cpp` | `src/hotspot/os/linux/os_linux.cpp` | os/linux | `commit_memory_impl`(:3291-3310), `pd_reserve_memory`(:3985-3988), `pd_commit_memory`(:3312-3314), `pd_uncommit_memory`(:3723-3727), `pd_release_memory`(:3990-3992), `recoverable_mmap_error`(:3249-3270), `reserve_memory_special`(:4577-4599) | ★★★ 内存操作——所有系统调用的 Linux 实现 |
| 2 | `os_posix.cpp` | `src/hotspot/os/posix/os_posix.cpp` | os/posix | `reserve_memory_aligned`(:288-344), `map_memory_to_file`(:248-276) | ★★ POSIX——对齐分配 + 文件映射 |
| 3 | `os.hpp` | `src/hotspot/share/runtime/os.hpp` | runtime | `reserve/commit/uncommit/release_memory` 声明(:339-362), `reserve_memory_special`(:418), `ExecMem` | ★★ 接口——四态生命周期声明 |
| 4 | `virtualspace.cpp` | `src/hotspot/share/runtime/virtualspace.cpp` | runtime | `ReservedSpace::initialize`(:122-243), `VirtualSpace::expand_by`(:1000-1086), `commit_expanded` | ★★★ 堆抽象——3 层封装 |
| 5 | `collectedHeap.hpp` | `src/hotspot/share/gc/shared/collectedHeap.hpp` | gc/shared | `reserved_region()`(:224), `base()`(:225) | ★ GC 接口——GC 端对 VirtualSpace 的消费 |

**跨模块说明**：内存映射跨越 os/linux、os/posix、runtime（virtualspace）、gc/shared 四个模块。`os_linux.cpp` 的 `commit_memory_impl` 是本阶段最关键的单函数——它是 reserve→commit 转换的"唯一系统调用执行点"。`virtualspace.cpp` 是抽象层——ReservedSpace 和 VirtualSpace 把 `mmap/MAP_FIXED` 包装为 GC 友好的接口。

**前置**：[08-safepoint]（GC 期间内存操作 + CardTable）, [06-gc-memory]（G1 堆结构和回收）

## 四、必须深度走读的核心概念

> 以下不是答案——是必须从源码中挖掘答案的问题列表。每道题先定位源文件行号，再回答"为什么"，最后用 3-5 行关键源码做引证。★ 必须覆盖 README §八 的全部 4 个深度问题。

### 4.1 ★★★ reserve → commit 两阶段模型

```
问题：
  ① 为什么 JVM 不一步到位把堆一次性 mmap 进来？
    答案方向: 3 个原因：
    (1) 灵活 GC 策略——G1 需要 reserve 大范围（如 32GB）但只 commit 当前 region(1-32MB)
        → 如果一步到位 → 物理内存全占 → 浪费且 OOM risk。
    (2) Overcommit 兼容——Linux 默认允许 mmap 超出物理内存。reserve 时内核只在 VMA 中
        记账 → 不分配物理页。commit 时才建页表。
    (3) RSS 可控——只有 commit 的页计入 RSS。reserve 但不 commit 的页不计入。
        运维能看懂"reserved 2GB committed 800MB"比"mmap 2GB 全占"更有用。

  ② 四态生命周期的系统调用对应关系是什么？
    代码引证:
      // reserve: PROT_NONE + MAP_NORESERVE — virtual address range only
      pd_reserve_memory → anon_mmap(requested_addr, bytes, ...) 
                        → mmap(addr, size, PROT_NONE, MAP_PRIVATE|MAP_ANONYMOUS|MAP_NORESERVE, -1, 0)
      // commit: MAP_FIXED over same address — establish page table mapping  
      pd_commit_memory → commit_memory_impl(addr, size, exec)
                       → mmap(addr, size, PROT_READ|PROT_WRITE, MAP_PRIVATE|MAP_FIXED|MAP_ANONYMOUS, -1, 0)
      // uncommit: PROT_NONE + MAP_NORESERVE over same address — drop page table mapping
      pd_uncommit_memory → mmap(addr, size, PROT_NONE, MAP_PRIVATE|MAP_FIXED|MAP_NORESERVE|MAP_ANONYMOUS, -1, 0)
      // release: munmap — free virtual address range
      pd_release_memory → munmap(addr, size)
    答案方向: ★ 关键洞察：commit 和 uncommit 都调用 `mmap`（不是 mprotect）——
    利用了 MAP_FIXED 的"覆盖旧映射"语义。这不是 bug——Linux MAP_FIXED 在同一 VMA 内
    允许不同 prot 的映射覆盖。`mprotect` 不能改 MAP_NORESERVE 标记 → 所以用 mmap 覆盖。

  ③ ★ README §八 问题 1: MAP_FIXED 覆盖旧映射有原子性 gap 吗？
    代码引证:
      // MAP_FIXED 的行为：内核先 munmap 旧映射 → 再建新映射
      // 两者之间有一个窗口——此虚拟地址无映射
      // 如果另一个线程在这两个操作之间访问该地址 → SIGSEGV
      uintptr_t res = (uintptr_t)::mmap(addr, size, prot,
                                         MAP_PRIVATE|MAP_FIXED|MAP_ANONYMOUS, -1, 0);
    答案方向: 理论上—MAP_FIXED 的 munmap→remap 中间有其他线程访问 → SIGSEGV。
    但 JVM 的调用模式保证了安全：commit 操作在 safepoint 期间（GC 线程持有 Heap_lock）
    或在线程初始化阶段（单线程创建线程栈）→ 无并发访问。G1 的 heap expansion 在
    `G1CollectedHeap::expand()` 中——单线程路径。CardTable 的 commit 在初始化阶段
    （单线程）。所以实践中无此竞态——但代码本身不保证原子性，依赖调用模式。
```

### 4.2 ★★★ commit_memory_impl 与 Linux overcommit

```
问题：
  ① mmap 返回成功就说明物理内存已分配吗？
    线索: os_linux.cpp:3293-3295
    答案方向: **不**。Linux 默认 overcommit（`/proc/sys/vm/overcommit_memory=0`）。
    mmap 成功只表示 VMA 记账成功——物理页在第一次访问时才分配
    （page fault → `do_anonymous_page` → alloc_page）。如果此时物理内存不足 →
    OOM Killer 杀进程（可能是 JVM 自己，也可能是别人的进程）。

  ② recoverable_mmap_error 枚举了什么错误？
    线索: os_linux.cpp:3249-3270
    代码引证:
      static bool recoverable_mmap_error(int err) {
        switch (err) {
          case EBADF:   // bad file descriptor
          case EINVAL:  // invalid argument
          case ENOTSUP: // not supported
            return true; // caller can retry
          default:
            return false; // ENOMEM etc → vm_exit_out_of_memory
        }
      }
    答案方向: EBADF/EINVAL/ENOTSUP 是"参数/环境错误"→ 可恢复（如 alignment_hint
    不对 → 换一种对齐重试）。ENOMEM 直接 fatal——因为 reserve 的地址空间不能被放
    弃（其他 GC 数据结构依赖它）。
    ★ README §八 问题 2: ENOMEM 也可能是虚拟地址空间不足（不是物理内存不足）→
    在 64 位系统上虚拟地址空间 ≠ 几乎无限吗？→ 不是——`/proc/sys/vm/max_map_count`
    限制了 VMA 数量（默认 65530）。如果一个 JVM 创建了大量小 mmap（如每个线程栈、
    每个 Metaspace chunk），可能超过 max_map_count → ENOMEM → fatal。
    JVM 应该区分"虚拟空间 ENOMEM"和"物理内存 ENOMEM"吗？→ 当前代码不区分——
    因为 reserve 映射已经占了虚拟地址空间，commit 失败无论什么原因都意味着不可恢复。

  ③ JVM 怎么应对 overcommit 风险？
    答案方向: 3 层防御：
    (1) AlwaysPreTouch：`-XX:+AlwaysPreTouch` → 启动时 touch 所有堆页 → 强制 page fault
        在启动时发生 → OOM 发生在启动而非运行时。
    (2) commit 后 Prefetch：`Prefetch::read(addr, size)` 或 `madvise(MADV_WILLNEED)`→
        强制页表立即映射 → 减少运行时 page fault。
    (3) UseContainerSupport：如果检测到 cgroup 内存限制 → JVM 用 cgroup limit
        而非物理内存做 commit 决策——避免在容器内 overcommit 导致宿主机 OOM。

  ④ ★ README §八 问题 3: MAP_NORESERVE 在 reserve 中带了，但 commit 不带——新映射的 overcommit 行为由什么决定？
    代码引证:
      // reserve: MAP_NORESERVE → no swap reservation → OOMable
      // commit: NO MAP_NORESERVE → overcommit behavior depends on /proc/sys/vm/overcommit_memory
    答案方向: commit 的 mmap 不带 MAP_NORESERVE → overcommit 策略由
    `/proc/sys/vm/overcommit_memory` 决定：
    - 0 (heuristic): 允许 overcommit，但拒绝"明显过分"的请求
    - 1 (always): 永远允许，mmap 总是成功
    - 2 (strict): 不允许 overcommit，CommitLimit 计算公式生效
    JVM 在生产环境推荐 overcommit_memory=0 或 1——不推荐 2 因为 JVM 的
    reserve > commit 模式在 strict 模式下被误认为"overcommit"。
```

### 4.3 ★ 大页（Huge Pages）的两条路径

```
问题：
  ① -XX:+UseLargePages 做了什么？
    线索: os_linux.cpp:4577-4599
    代码引证:
      char *os::reserve_memory_special(size_t bytes, size_t alignment,
                                       char *req_addr, bool exec) {
        if (UseSHM) {
          addr = os::Linux::reserve_memory_special_shm(...);  // SysV shared memory
        } else {
          addr = os::Linux::reserve_memory_special_huge_tlbfs(...);  // hugetlbfs
        }
      }
    答案方向: 两条路径：(1) SHM——`shmget(IPC_PRIVATE, size, SHM_HUGETLB|0666)`→
    `shmat(shmid, addr, ...)`→从 hugetlbfs 池分配大页。需要 root 预先
    `echo N > /proc/sys/vm/nr_hugepages` 预留。
    (2) HugeTLBFS——`mmap(addr, size, prot, MAP_PRIVATE|MAP_ANONYMOUS|MAP_HUGETLB, -1, 0)`
    → 从 hugetlbfs 挂载点分配。同样需要预先预留。

  ② 为什么 G1 对大页有特殊优化？
    答案方向: G1 的 Humongous region 可以被对齐到 2MB 边界。大页减少 TLB miss→
    GC 的 RSet scan（随机地址模式）性能提升 10-20%。`os::reserve_memory_special`
    返回对齐的大页地址→G1 在 `G1PageBasedVirtualSpace` 中逐个 commit Humongous region。

  ③ THP (Transparent Huge Pages) 是第三种大页路径——怎么工作？
    答案方向: 不需要 `-XX:+UseLargePages`——内核后台扫描 4KB 页，合并连续的
    4KB 页为 2MB 大页（`khugepaged` 线程）。JVM 通过 `madvise(MADV_HUGEPAGE)` 建议
    内核合并特定区域（堆优先）。THP 是"尽力而为"——有可能失败——和 SHM/HugeTLBFS
    的确定性不同。
```

### 4.4 ★ ReservedSpace → VirtualSpace → Commit 的 3 层抽象

```
问题：
  ① ReservedSpace / VirtualSpace / commit_memory() 的职责分别是什么？
    线索: virtualspace.hpp:32-93 (ReservedSpace), 140-239 (VirtualSpace)
    答案方向:
    - ReservedSpace: 一个连续的虚拟地址范围（已 reserve，可能不 commit）。
      可以分割成多个 VirtualSpace——如 G1 的多个 heap region 从同一个 ReservedSpace 分配。
    - VirtualSpace: ReservedSpace 的一个子范围——有独立的 commit/uncommit 状态跟踪
      （low/high watermark + lower/middle/upper 三区域——MPSS 支持）。
    - commit_memory: OS 层调用——mmap/MAP_FIXED → 让内核建立页表。
    三层好处: GC 可以在不释放虚拟地址的情况下动态扩展/收缩堆。

  ② VirtualSpace::expand_by 的 low/high watermark 机制是什么？
    线索: virtualspace.cpp:1000-1086
    答案方向: VirtualSpace 用 `_low` 和 `_high` 水印跟踪 commit 范围。expand_by 增加
    _high；shrink_by 减少 _high。有三层粒度（lower/middle/upper）对应 MPSS 的
    小页/大页/小页布局。
    ★ README §八 问题 4: 如果 uncommit 了中间一段（不是从 high 往回收缩），
    watermark 会被"空洞"破坏吗？→ VirtualSpace 不支持中间 uncommit——shrink_by
    只减少 _high（从顶部释放）。如果需要中间 uncommit → 必须用独立的 VirtualSpace。
    这是设计决策——不是 bug。G1 region 的独立 commit/uncommit 正是通过
    G1PageBasedVirtualSpace 的多个 VirtualSpace 实例来实现的。
```

### 4.5 ★★ 为什么 RSS 超过 -Xmx？

```
问题：
  ① 常见超出场景逐项分析：
    答案方向:
    (1) 非堆内存: Metaspace mmap（`CompressedClassSpaceSize`+`MaxMetaspaceSize`),
        CodeCache mmap, 线程栈（每线程~1MB），NMT 追踪的 malloc 区域
    (2) GC 数据结构: G1 remembered set 位图、SATB 队列（per-thread GC worker buffer）、
        CardTable——每个都是独立 mmap 段
    (3) glibc malloc arena: `malloc_info(0, stderr)` 可查看 arena 数——默认
        8×core_count 个 arena，每个有 cached free chunk → 不 munmap → RSS 不降
    (4) CompressedOops base: 如果堆不能映射到 32GB 以下 → JVM 需要额外的
        class space mmap → 约 1GB
    (5) DirectByteBuffer: 每个 ByteBuffer.allocateDirect() → os::malloc → 
        可能从 glibc 分配 → 计入 RSS

  ② RSS 超过 2×-Xmx 时怎么排查？
    答案方向: (1) `pmap -x <pid>` → 按 anonymous 段排序 → 找最大的非堆段；
    (2) `jcmd <pid> VM.native_memory summary` → NMT 分类汇总；
    (3) hs_err 的 Memory map 段 → 解析 address range → 匹配 commit 区域大小。
    排查路径：NMT 显示 "GC" 段大 → 检查 G1 RSet 位图；NMT 显示 "Thread" 段大 →
    检查线程数 × 栈大小；NMT 显示 "Internal" 段大 → 检查 glibc arena 数和 malloc_info。
```

### 4.6 ★ 和 [08-safepoint] + [06-gc] 的连接

```
问题：
  ① CardTable 的 mmap 怎么创建？
    答案方向: [08-safepoint] 讲 GC barrier 写到 CardTable（mark dirty card）。
    CardTable 本身是一块 mmap 内存——`os::reserve_memory()` 预留 →
    `os::commit_memory()` 让页可读写。card_size 和 page_size 决定 CardTable 占用
    多少内存（如 4KB page + 512 bytes card → CardTable = heap_size / 512）。

  ② G1 RSet 位图的 mmap 在哪里？
    答案方向: G1 的 per-region RSet（remembered set）使用位图（BitMap）→
    底层是 `os::reserve_memory` + `os::commit_memory`。每个 region 的 RSet 按
    当前大小动态扩展——VirtualSpace::expand_by 驱动。

  ③ 和 06 的 Humongous region 的连接——大页分配失败时怎么办？
    答案方向: 06 讲 Humongous region 需要 2MB 对齐。如果 `reserve_memory_special`
    失败（hugetlbfs 池已空）→ 回退到 `os::reserve_memory`（4KB 小页）→ 
    Humongous region 散在 4KB 页上 → GC 找连续区域 O(n²) → 时间爆炸。
```

## 五、文章结构

```
§〇 源文件清单（跨 os/linux + os/posix + runtime/virtualspace + gc/shared）

§一 ★★★ reserve → commit 两阶段模型
  ❓ 为什么 JVM 不一步到位把堆一次性 mmap？
  ❓ 四态生命周期的系统调用对应关系是什么？
  1.1 ★ 四态生命周期的 4 个系统调用 + PROT/FLAGS 组合表
  1.2 MAP_NORESERVE 的语义——overcommit 与 OOM Killer 的关系
  1.3 ★ README §八 问题 1: MAP_FIXED 覆盖的原子性 gap —— 为什么实际安全？

§二 ★★★ commit_memory_impl 与 Linux overcommit
  ❓ mmap 返回成功就说明物理内存已分配吗？（不——overcommit）
  ❓ ENOMEM 是虚拟地址不足还是物理内存不足？
  2.1 recoverable_mmap_error 的枚举——EBADF/EINVAL/ENOTSUP vs 默认 fatal
  2.2 ★ JVM 应对 overcommit 的 3 层防御：AlwaysPreTouch / Prefetch / UseContainerSupport
  2.3 ★ README §八 问题 2: max_map_count 导致 ENOMEM 的场景
  2.4 ★ README §八 问题 3: commit 不带 MAP_NORESERVE —— /proc/sys/vm/overcommit_memory 重新决定行为

§三 ★★ 大页（Huge Pages）的两条路径 + THP
  ❓ -XX:+UseLargePages 做了什么？（SHM vs HugeTLBFS）
  ❓ G1 Humongous region 为什么需要大页？
  3.1 SHM 路径——shmget(SHM_HUGETLB) + shmat
  3.2 HugeTLBFS 路径——mmap(MAP_HUGETLB) + hugetlbfs 挂载点
  3.3 THP 的 madvise(MADV_HUGEPAGE)——尽力而为的后天合并
  3.4 路径回退逻辑——SHM 失败 → HugeTLBFS → THP → 4KB 小页

§四 ★★★ ReservedSpace → VirtualSpace → commit 的 3 层抽象
  ❓ 三层各自的职责是什么？
  ❓ VirtualSpace 的 low/high watermark 怎么处理 uncommit 的空洞？
  4.1 ReservedSpace::initialize 的决策树——special / reserve / reserve_aligned
  4.2 VirtualSpace::expand_by 的三区域 commit（lower/middle/upper → MPSS）
  4.3 ★ README §八 问题 4: watermark "空洞"问题——shrink_by 只从顶部收缩
  4.4 G1PageBasedVirtualSpace——多个 VirtualSpace 实现独立 commit/uncommit

§五 ★★ 为什么 RSS 超过 -Xmx？
  ❓ 5 种常见超出场景的精确分析
  ❓ RSS 超过 2×-Xmx 的排查路径
  5.1 逐项分析——Metaspace / CodeCache / ThreadStacks / GC structures / glibc arenas
  5.2 pmap → NMT → hs_err memory map 的排查链
  5.3 glibc malloc_trim 为什么不能降 RSS

§六 ★ 和 [08-safepoint] + [06-gc] 的交叉连接
  ❓ CardTable 的 mmap 怎么创建？
  ❓ G1 region 的 commit/uncommit 怎么通过 VirtualSpace 实现？
  6.1 [08-04] CardTable barrier → mmap 创建 → commit_memory
  6.2 [06-01] HeapRegion → G1PageBasedVirtualSpace → reserve/commit 的动态扩展
  6.3 ★ README §五 阶段对比表——内存是 11 的第三原语

§七 GDB 验证 + 可证伪断言
```

## 六、写作要求

1. **★ "四态生命周期系统调用对照表" 是本文的第一交付物**：reserve → commit → uncommit → release，每个标注 mmap/munmap 的精确参数（PROT + FLAGS）。

2. **★ MAP_FIXED 的原子性 gap 是本文的"aha moment"之一**：MAP_FIXED 先 munmap 再 mmap——中间有窗口。但 JVM 调用模式保证了并发安全——必须解释"为什么安全"和"如果不安全会怎样"。

3. **★ overcommit 三态与 MAP_NORESERVE 的交互**：reserve 带 MAP_NORESERVE → 不预留 swap；commit 不带 → overcommit 策略由 sysctl 决定。这条规则是理解"为什么 JVM 不会在 strict overcommit 模式下正确工作"的钥匙。

4. **★ VirtualSpace 的"不支持中间 uncommit"不是 bug——是设计**：解释为什么 G1 需要 G1PageBasedVirtualSpace 而不是 VirtualSpace::uncommit(addr, size)。

5. **★ RSS 超出 -Xmx 的 5 种场景必须逐项量化**：每种场景给典型数字（Metaspace: 200MB-1GB, CodeCache: 128-256MB, 线程栈: threads×1MB, GC 结构: heap/512 的 CardTable + RSet 位图）。

6. **★ 和 [08-safepoint] 的连接——CardTable 的 mmap**：从 GC barrier 的 `byte_map_base` 追溯到 `os::reserve_memory` → `commit_memory`。

## 七、输出格式

- Markdown 文件，命名为 `03-Memory.md`
- 输出路径：`/data/workspace/openjdk-cut-new/probe_md/libjvm-analysis/11-os-layer/`
- 元信息头：
  ```
  > **阶段**：[11-os-layer]
  > **前置**：[08-safepoint]（CardTable mmap + GC 内存操作）, [06-gc-memory]（G1 heap structure）
  > **依赖本文**：[11-04]（hs_err 的 memory map 段解析依赖对 reserve/commit 的理解）
  > **阅读收益**：理解 JVM 堆内存从虚拟地址承诺到物理页框的四态生命周期——mmap 的 reserve→commit→uncommit→release 全链路；掌握 RSS 超过 -Xmx 的物理根源和排查路径
  ```

## 禁止行为

- ❌ 把 mmap/mprotect 的 man page 抄一遍——不讲 MAP_ANONYMOUS vs MAP_SHARED vs MAP_PRIVATE 的内核页表差异
- ❌ 深入 Linux buddy allocator/slab/vmalloc 的内核实现——这属于 Linux 内核文档
- ❌ 展开 NUMA 感知分配（`numa_make_global`, `libnuma` 绑定）——NUMA 是策略层面，不是 OS 基础原语
- ❌ 深入 THP 的内核合并算法（`khugepaged` 的扫描周期、`/sys/kernel/mm/transparent_hugepage/khugepaged/scan_sleep_millisecs`）——属于 Linux 内核文档
- ❌ 展开 cgroups v1 vs v2 的容器内存限制（`memory.limit_in_bytes` vs `memory.max`）——cgroup 路径是独立专题
- ❌ 忘记 [08-safepoint] 的 CardTable——每提到 GC 相关的 mmap 内存，必须引用 [08-04] 的 CardTable 创建
- ❌ 把 RSS 排查当成运维手册——只解释"为什么 RSS 超过 -Xmx"，不讲"怎么用 perf/tracing 根除"
- ❌ 忽略 VirtualSpace 的三层 MPSS 布局（lower/middle/upper）——这是 watermark 空洞问题的前置知识
- ❌ 不覆盖 README §八 的全部 4 个深度问题——每个问题必须在 §四 中有一个问题组明确对应

## 要求行为

- ✅ **★ 四态生命周期的系统调用参数对照表**：阶段 / 系统调用 / PROT / FLAGS / 物理内存分配 / VMA 变化
- ✅ **★ overcommit 三态与 MAP_NORESERVE 的交互矩阵**：overcommit 0/1/2 × MAP_NORESERVE 有/无 → mmap 行为
- ✅ **★ RSS 超出 -Xmx 的 5 场景量化表**：场景 / 典型大小 / 计算公式 / 排查工具 / 缓解手段
- ✅ **★ VirtualSpace 三区域（lower/middle/upper）的 ASCII 布局图**：标注 low/high watermark 和 commit 区域
- ✅ **★ 大页 3 路径（SHM / HugeTLBFS / THP）的决策树**：UseSHM 标志 → shmget → 失败回退 → mmap(MAP_HUGETLB) → 失败回退 → 4KB 小页
- ✅ **★ 和 [08-safepoint] CardTable 的 mmap 创建链**：`byte_map_base` → `os::reserve_memory` → `commit_memory`
- ✅ **★ 【11-os-layer README §五 阶段对比表】的引用**
- ✅ **★ 和 [06-gc] G1 region 的连接**：`G1PageBasedVirtualSpace` → `os::commit_memory`
- ✅ **★ GDB 可证伪断言 ≥10 条**

## GDB 可证伪断言

1. **断言：reserve memory 调用 `mmap(PROT_NONE, MAP_NORESERVE)` 不分配物理页**
   验证：`br os_linux.cpp:3987` (pd_reserve_memory) → `stepi` → 进入 anne_mmap → `pmap -x <pid>` 查看 → RSS 无变化
   预期：reserve 后 RSS 不变，maps 中出现 `---p` 段

2. **断言：commit memory 调用 `mmap(PROT_READ|PROT_WRITE, MAP_FIXED)` 在同一地址覆盖**
   验证：`br os_linux.cpp:3293` (commit_memory_impl 的 mmap) → `p addr` → `br os_linux.cpp:3293` 再次断 → `p addr` → 确认两次 addr 相同
   预期：两次 mmap 的 addr 参数相同——reserve 和 commit 在同一虚拟地址

3. **断言：commit 后 RSS 可能不变（overcommit=0 + page fault lazy）**
   验证：`br os_linux.cpp:3314` (pd_commit_memory 返回) → `pmap -x <pid>` → 对比 commit 前后的 RSS → 可能不变（页未被 touch）
   预期：RSS 不立即增加——page fault 在第一次访问时分配物理页

4. **断言：AlwaysPreTouch 启动时 touch 所有堆页 → RSS = -Xms**
   验证：`-XX:+AlwaysPreTouch -Xms1g -Xmx1g` → 启动后 `pmap -x <pid>` → RSS ≈ 1GB
   预期：touch 操作触发所有 page fault → RSS 立即等于 -Xms

5. **断言：uncommit memory 调用 `mmap(PROT_NONE, MAP_FIXED|MAP_NORESERVE)` → RSS 下降**
   验证：G1 触发 region uncommit → `br os_linux.cpp:3725` → `pmap -x <pid>` 对比前后
   预期：uncommit 区域从 `rw-p` 变为 `---p`，RSS 下降

6. **断言：release memory 调用 `munmap` → VMA 完全消失**
   验证：`br os_linux.cpp:3992` (pd_release_memory) → `pmap -x <pid>` 对比前后
   预期：munmap 后该地址段从 maps 中完全消失

7. **断言：ENOMEM 在 `commit_memory_impl` 中触发 `vm_exit_out_of_memory`**
   验证：设置 `vm.max_map_count=100` → 触发超过 → `br os_linux.cpp:3306` → 断点命中
   预期：`recoverable_mmap_error(ENOMEM)` 返回 false → `vm_exit_out_of_memory` 被调用

8. **断言：`reserve_memory_special` 使用 UseSHM 路径时调用 `shmget`**
   验证：`br os_linux.cpp:4583` → `stepi` 进入 `reserve_memory_special_shm` → `br` 在 shmget → 确认调用
   预期：`UseSHM=true` 时 `shmget(IPC_PRIVATE, size, SHM_HUGETLB|0666)` 被调用

9. **断言：VirtualSpace::expand_by 增加 _high watermark**
   验证：`br virtualspace.cpp:1084` → `p _high` 对比 `previous_high` → `_high` 增加了 `bytes`
   预期：`_high = _high + bytes` 且 commit 在 `_high` 之前的区域被成功调用

10. **断言：G1 的 heap expansion 通过 VirtualSpace::expand_by → commit_memory**
    验证：在 G1 GC 过程中 `br virtualspace.cpp:1060` → `bt` → 调用栈包含 `G1CollectedHeap::expand()` → `VirtualSpace::expand_by`
    预期：GC expansion 走完整的 VirtualSpace → os::commit_memory 链

11. **断言：glibc malloc_trim 后 RSS 不一定下降**
    验证：`p (int)malloc_trim(0)` → GDB 中手动调用 → `pmap -x <pid>` 对比
    预期：RSS 可能不变——glibc arena 中的空闲内存未还回 OS（只释放堆顶）
