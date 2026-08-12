# 02. "16G heap 在 8G 机器上？" — 虚拟内存、大页面与栈保护

> **前置依赖**：[01 — 平台探测](01-platform-detection.md)：page_size 来自内核
> → **后续**：[03 — 线程与同步](03-threads-and-sync.md)：线程的栈就是本节"栈保护"的容器
> 关联域: 09-memory-core(堆)、10-metaspace、16-code-cache(三个消费方)、26-g1(region 与大页面)、34-nmt(追踪)

## 一个反直觉的事实:16GB 的堆在 8GB 的机器上能启动

`-Xmx16g` 在只有 8GB 物理内存的机器上启动,不报错。`ps` 一看,RSS(实际占用的物理内存)只有几百 MB,但虚拟内存(VSZ)显示 16GB。

这不是魔法,是操作系统虚拟内存的经典机制:**reserve(预订)和 commit(兑现)是两件事**。第一篇我们看过 JVM 怎么探测机器;这一篇讲它怎么向 OS 要内存——不是 `malloc`,而是 `mmap`。

```
reserve   → 占地址空间,不占物理内存(预订座位,不搬椅子)
commit    → 真正分配物理页(人来了,才上椅子)
uncommit  → 释放物理页,保留地址空间(人走了,椅子撤了,座位还订着)
release   → 地址空间也还掉(退订)
```

这个"四态生命周期"(`os.hpp:339-362` 的接口声明:reserve_memory → commit_memory → uncommit_memory → release_memory)是全部内存子系统的地基:GC 堆(域 09/26)、Metaspace(域 10)、CodeCache(域 16)全都建立在这四个操作之上。这一篇先把四态讲透,再讲两个优化(大页面、栈保护)。

## 1. reserve vs commit:"预订"和"真的来了"

### reserve:MAP_NORESERVE + PROT_NONE

reserve 的实现是 `anon_mmap`(`os_linux.cpp:3838`):

```cpp
// os_linux.cpp:3838 起(截取:省略 assert 与返回值处理,核心语句逐字)
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
  ...
}
```

三个关键参数,对应三句人话:

- **`MAP_NORESERVE`**: 不预分配 swap 空间——内核只在地图上画一块区域,不记账。
- **`PROT_NONE`**: 映射出来的页**不可读不可写**——谁碰谁 SIGSEGV。这比"可以读但没物理页"更安全:万一内核估算失误,预留区真的能写,程序会在错误的地方写坏数据;PROT_NONE 让"碰了未 commit 的页"立刻暴露。
- **`MAP_ANONYMOUS`**: 不关联文件,纯内存映射。

- [man 2 mmap]
- [内核: overcommit 策略——`vm.overcommit_memory=0`(默认 heuristic):内核估算"有没有足够物理+swap",允许合理超量;`=1`(always):永远允许;`=2`(strict):严格限制。JVM 依赖 heuristic——reserve 16GB 在 8GB 机器上可能成功(视内核估算),strict 模式直接失败]
- [man 5 proc](`/proc/sys/vm/overcommit_memory`)

**关键设计 (斜体)**: *为什么 reserve 要用 PROT_NONE 而不是可读写的空页?注释写得很直白:"fail early if we touch an uncommitted page"——未 commit 的页本来就不该碰,让它在第一时间以 SIGSEGV 暴露,而不是等到 swap 空间把错误"兜住"、程序带着坏数据跑下去。这是"失败要快"原则在内存管理上的体现。*

### commit:MAP_FIXED 把物理页"钉"进预留区

commit 的实现是 `commit_memory_impl`(`os_linux.cpp:3211`):

```cpp
// os_linux.cpp:3211 起(核心)
int os::Linux::commit_memory_impl(char* addr, size_t size, bool exec) {
  int prot = exec ? PROT_READ|PROT_WRITE|PROT_EXEC : PROT_READ|PROT_WRITE;
  uintptr_t res = (uintptr_t) ::mmap(addr, size, prot,
                                     MAP_PRIVATE|MAP_FIXED|MAP_ANONYMOUS, -1, 0);
  ...
}
```

注意和 reserve 的差别:**同样是对同一段地址再 mmap 一次**,但这次带 `MAP_FIXED`(强制钉在指定地址)+ 可读写权限。内核此时才真正分配物理页(或至少记账)。

- [C++: MAP_FIXED 很危险——如果目标地址已被占用(共享库、别的 mmap),新映射会**替换**旧映射。JVM 敢用,是因为 reserve 阶段已经确保了这段地址是空的,commit 时范围是已知安全的]
- [man 2 mmap]

**为什么不用 brk()?** `brk` 只能扩展进程堆的连续区域——JVM 的 GC 堆、Metaspace、CodeCache 需要**各自独立的虚拟地址范围**,每个都要能单独 reserve/commit/release。mmap 让每个区域独立管理;brk 做不到。

**为什么不是 malloc/free?** G1 的 heap region 需要**连续虚拟地址**(region 位图按地址索引的前提)。`malloc` 在 16GB 规模上会被碎片化成不连续块,region 索引直接断裂;而且 glibc malloc 的 arena 机制(多线程各自管理一块堆)在巨型分配上碎片更严重。

### uncommit 与 release:人走了,椅子撤了

四态的后两态,是 GC 回收时的日常。**这里有一个和大纲/常识不同的实现细节**:uncommit 不是 `madvise(MADV_DONTNEED)`,而是**用 PROT_NONE 重新映射同一段地址**(`os_linux.cpp:3642`):

```cpp
// os_linux.cpp:3642 —— pd_uncommit_memory 完整实现
bool os::pd_uncommit_memory(char* addr, size_t size) {
  uintptr_t res = (uintptr_t) ::mmap(addr, size, PROT_NONE,
                                     MAP_PRIVATE|MAP_FIXED|MAP_NORESERVE|MAP_ANONYMOUS, -1, 0);
  return res  != (uintptr_t) MAP_FAILED;
}
```

效果等价:物理页被释放,地址空间保留(还是 PROT_NONE 不可碰)。release 则是 `anon_munmap`(os_linux.cpp:3899)——`munmap` 把地址空间和物理页一起还掉。

- [man 2 munmap]
- [C++: 为什么 uncommit 用"重映射"而不是 madvise?两者效果相近(释放物理页、保留地址空间);重映射的额外好处是把页置回 PROT_NONE——和 reserve 阶段同一套安全语义,未 commit 的页统一不可访问。注意不同 JDK 版本实现不同,这里以 jdk11u 为准]

### Pre-touch:把 page fault 前置

commit 之后,物理页是"按需"分配的——**第一次访问某页时触发 page fault,内核才真正给页**。GC 遍历整个堆时,如果堆是新的,会遭遇上千次 page fault。解法是 `pretouch_memory`(`os.cpp:1873`):

```cpp
// os.cpp:1873 —— 完整实现
void os::pretouch_memory(void* start, void* end, size_t page_size) {
  for (volatile char *p = (char*)start; p < (char*)end; p += page_size) {
    *p = 0;    // 逐页写零,制造 page fault,强迫内核现在就分配物理页
  }
}
```

- [x86: page fault 流程——CPU 查 TLB → miss → 查页表 → present bit=0 → #PF(vector 14)→ 内核 vm_fault → minor fault(页在内存,映射即可,~1µs)或 major fault(要读盘,~10ms)。pretouch 把 major fault 的批量成本前置到启动期]
- [C++: 写 `*p = 0` 是为了触发 fault;`volatile` 防止编译器把这个循环优化掉]

**关键设计 (斜体)**: *为什么 pretouch?GC 停顿是有预算的——遍历堆时遭遇 1000 次 page fault,停顿膨胀 10 倍;启动时花几百毫秒把页摸一遍,换运行期停顿稳定。代价换确定性——这是 JVM 内存管理的核心哲学。*

### pd_* 平台分发:一层接口,三套实现

share 层定义 `os::reserve_memory()`(`os.hpp:296-362`),内部调 `pd_reserve_memory()`;Linux 实现是 `anon_mmap`,Windows 实现是 `VirtualAlloc`。上层代码(GC/Compiler/ClassLoader)**只调 `os::reserve_memory()`,完全不感知底层**。

## 2. 大页面:TLB miss 从 15% 到 1%

### 为什么要在乎页面大小

- [x86: TLB(Translation Lookaside Buffer)——CPU 上的硬件缓存(~64 槽),缓存虚拟→物理地址翻译。hit=1 cycle;miss 要查页表(4 次内存访问 ≈ 100 cycles)。4KB 页:2GB 堆 = 524,288 个页,TLB 只有 64 个槽,频繁换出;2MB 页:2GB = 1,024 个页,TLB miss 率从 ~15% 降到 ~1%]

JVM 维护页面大小数组 `_page_sizes`(`os.hpp:103-117`,最大 9 项降序 + 0 哨兵),选页面的函数是 `page_size_for_region()`(`os.cpp:1488`):给定 region 大小和最小页数约束,选最大的适配页面。

### 三种获取方式

**hugetlbfs**(`os_linux.hpp:93-108`):挂载 `hugetlbfs` 文件系统,`mmap` 文件获得大页——100% 保证,但要 root 预配置池(`echo 1024 > /proc/sys/vm/nr_hugepages`)。

- [内核: hugetlbfs 是独立文件系统,挂载在 /dev/hugepages,mmap 文件 = 获得大页。池大小固定(预分配),用完即失败;大页不能 swap,锁定在 RAM]

**SHM**(`os_linux.hpp:99` 的 `reserve_memory_special_shm`):`shmget(SHM_HUGETLB)` + `shmat`,SystemV 共享内存加大页标志。

- [man 2 shmget][man 2 shmat]

**THP(Transparent Huge Pages)**:零配置,`madvise(MADV_HUGEPAGE)` 告诉内核"这片区域可以合并大页",khugepaged 内核线程后台扫描合并(`os_linux.cpp:3283-3285`)。

- [man 2 madvise]

### THP 的坑:khugepaged 跨 region 合并

THP 听上去美好,但 JVM 的默认行为是**关掉它**:

- [内核: khugepaged 扫描进程地址空间,发现 512 个连续 4K 页(2MB)就合并成一个 huge page,更新全部 PTE。合并过程要么 stop_machine 全 CPU 暂停(老内核),要么锁保护(新内核)]

问题在于:khugepaged **不认 G1 的 region 边界**——一个 Old region 和一个 Young region 的相邻页可能被合并进同一个 huge page。G1 回收 Old region 时,这个 huge page 要拆回 4K 页,**一次回收多出上千次额外的 page fault**,GC 停顿反而恶化。大页面的收益被跨 region 合并抵消——这是"优化在真实系统里互相打架"的活例子。

## 3. 栈保护:递归 10 万次不 crash

### 四级保护区

每个 Java 线程的栈底,有四级保护区(`os.cpp:449-466` 在 `init_before_ergo` 里按 OS 页面大小适配;默认值在 `globals.hpp:1882-1901` + `globals_x86.hpp:57-59`):

```
高地址  ← 线程栈生长方向(x86 从高到低)
  ...业务栈帧...
  Yellow  zone  (2 页=8KB)   → 可恢复:抛 StackOverflowError
  Red     zone  (1 页=4KB)   → 不可恢复:fatal + hs_err
  Reserved zone (1 页=4KB)   → 保证抛异常时还有栈帧可用
  Shadow  zone  (若干页)     → 信号处理器执行所需的最小栈
低地址  ← 栈底
```

为什么四级而不是一级?每一级回答一个问题:

- **Yellow**:线程溢出到这里——还有栈可用,能执行"构造 StackOverflowError 对象 + 抛异常"的代码 → 可恢复。
- **Red**:溢出到 yellow 的代码本身还需要 ~3KB 栈(Throwable.fillInStackTrace 的调用链)——如果 yellow 也用完了,说明连抛异常都不够 → fatal。
- **Reserved**:保障上面那句"还有栈可用"——yellow 内抛异常所需的那点栈,单独划出来。
- **Shadow**:SIGSEGV 处理器(见域 01 的信号框架)也要栈——溢出时处理器本身得有地方跑。

- [C++: mprotect(PROT_NONE) 把保护区设为不可访问。线程触到 → #PF → SIGSEGV → 处理器检查 faulting 地址:在 yellow zone → 设 StackOverflowError → 走异常路径;已在 yellow 内再溢出 → red → fatal]
- [man 2 mprotect]

**关键设计 (斜体)**: *为什么是"四级"而不是一级?因为"栈溢出"不是一个点,而是一个过程——从"可恢复"到"完全没救"之间有过渡。每多一级,就是把一种失败模式从"fatal"变成"可恢复"或"有尊严地死"。分级是失败处理的通用模式:先预警,再隔离,最后兜底。*

### guard_memory / unguard_memory

底层的开关是 `guard_memory`/`unguard_memory`(`os_linux.cpp:3944/3948`),就是 mprotect 的封装。每个 Java 线程创建时,为它的栈配好四个保护区页;回收时 unguard 再还。

- [C++: x86 栈向低地址增长(rsp -= N),栈底 = 低地址边界。guard 页在栈底——线程写越过栈底就触发 SIGSEGV。保护的是"栈底",不是"栈顶"]

## 看见:16GB 堆为什么 RSS 只有 2GB

回到开头的场景。`-Xmx16g` 启动后:

- VSZ(虚拟内存)= 16GB+ — reserve 的地址空间
- RSS(物理内存)= 实际 commit 的部分 — 只有用到的页
- 容器里(第一篇的 cgroup 记忆限额)只统计 RSS,所以 2GB 限额的容器装得下 16GB 虚拟堆——**只要别真把 16GB 都 commit 掉**

工具卷的实证([卷 T ch05](openjdk/vol-tools/ch05.md) 的 GC Configuration 页显示 MaxHeapSize 15264MB,而实际 used 只有几百 MB)——同一个事实:reserve 大、commit 小。

## 核心悬念

"16GB 堆在 8GB 机器上跑"的答案是 reserve/commit 分离。但内存只是容器——**线程是栈的容器**。下一篇:JVM 内部 7 种线程(Java/VMThread/GC/Compiler/Watcher...),它们的栈怎么创建、优先级怎么排、谁先谁后?

> → [03-threads-and-sync.md](03-threads-and-sync.md):线程创建与优先级映射
