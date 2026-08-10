# 第 1 章 Linux 系统编程——内存、同步、信号、诊断

> **阅读前提**：本章假定读者具备 C 语言基础，理解指针、内存分配、函数指针等概念。如果已经用 C 写过 `pthread_create()` 和 `sigaction()`，可以直接从 1.3 节开始。

> **核心问题**：HotSpot JVM 是一个多线程 C++ 程序，运行在 Linux 上。它如何申请内存？如何让线程等待/唤醒？如何把 `NullPointerException` 从一次内存访问转换为 Java 异常？这些问题都经过 Linux 内核的数十个系统调用。本章从这些 syscall 出发，按照"**标准 C 用法 → HotSpot 使用方式 → 微妙之处**"三步组织，每个 syscall 都标注了 `man 2/3/5` 参考来源和 JVM 源码 `file:line` 使用位置。

---

## 1.1 mmap(2)——四重境界

`mmap(2)` 是 HotSpot 内存管理的基石。统计显示它在源码中出现 1,288 次，远超过 `malloc()`。理解 `mmap()` 的不同用法，就等于理解了 JVM 堆、CodeCache、Metaspace 的底层工作机制。

> **man 参考**：`man 2 mmap`

### 核心函数签名

```c
#include <sys/mman.h>
void *mmap(void *addr, size_t length, int prot, int flags, int fd, off_t offset);
```

| 参数 | 含义 | HotSpot 常用取值 |
|------|------|-----------------|
| `addr` | 期望地址 | `NULL`（让内核选）或精确地址（`MAP_FIXED`） |
| `length` | 映射大小 | 页对齐（通常 4KB 的倍数） |
| `prot` | 内存保护 | `PROT_NONE` / `PROT_READ\|PROT_WRITE` / `PROT_READ\|PROT_WRITE\|PROT_EXEC` |
| `flags` | 映射标志 | `MAP_PRIVATE\|MAP_ANONYMOUS` 为最常用组合 |
| `fd` | 文件描述符 | `-1`（匿名映射，不关联文件） |
| `offset` | 文件偏移 | `0`（匿名映射时忽略） |

### 境界一：MAP_ANONYMOUS——匿名内存

这是最基础的用法。JVM 通过它申请不与任何文件关联的内存，等价于"让内核给我一块空闲地址空间"。

**标准 C 用法**：
```c
// 申请 1MB 可读写匿名内存
void *p = mmap(NULL, 1 << 20, PROT_READ | PROT_WRITE,
               MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
if (p == MAP_FAILED) { perror("mmap"); exit(1); }
```

**HotSpot 使用方式**——VirtualSpace 的内存保留（Reserve）：[`virtualspace.cpp:210-211`](src/hotspot/share/memory/virtualspace.cpp#L210)

```cpp
// NOT_MACOS 分支：os::reserve_memory() 最终调用 pd_reserve_memory()
// → os::Linux::reserve_memory() → ::mmap()
base = os::reserve_memory(size, NULL, alignment, _fd_for_heap);
// os::reserve_memory() 内部：
// ::mmap(NULL, size, PROT_NONE, MAP_PRIVATE | MAP_ANONYMOUS | MAP_NORESERVE, -1, 0)
```

**微妙之处**：注意到 `PROT_NONE` + `MAP_NORESERVE` 组合吗？这引出了第二重境界。

### 境界二：MAP_NORESERVE——保留地址，暂不提交

`MAP_NORESERVE` 是 JVM 内存延后分配（lazy allocation）的核心机制。

> **man 参考**：`man 2 mmap`，搜索 `MAP_NORESERVE`。`MAP_NORESERVE` 告诉内核："我只保留这段地址范围，不要现在真的分配物理页"。真正的内存提交在后续的 `commit_memory()` 调用中完成。

**HotSpot 使用方式**——ReservedSpace 的保留（不提交）阶段：[`os_linux.cpp:3724`](src/hotspot/os/linux/os_linux.cpp#L3724)

当 JVM 启动时调用 `ReservedSpace::initialize()`，它首先用 `PROT_NONE` + `MAP_NORESERVE` 保留地址空间：

```cpp
// os::Linux::reserve_memory() 内部
uintptr_t res = (uintptr_t) ::mmap(addr, size, PROT_NONE,
    MAP_PRIVATE | MAP_ANONYMOUS | MAP_NORESERVE, -1, 0);
```

这段地址虽然"属于"JVM，但触摸它会触发 `SIGSEGV`——因为当前权限是 `PROT_NONE`（不可读、不可写、不可执行）。真正的可访问性通过后续的**分段提交**激活。

**分段提交**——VirtualSpace::expand_by()：[`virtualspace.cpp:1000`](src/hotspot/share/memory/virtualspace.cpp#L1000)

```cpp
// expand_by 实际调用 commit_memory_impl
// → os::Linux::commit_memory_impl() → ::mmap() 覆盖已有映射
int os::Linux::commit_memory_impl(char *addr, size_t size, bool exec) {
    int prot = exec ? PROT_READ | PROT_WRITE | PROT_EXEC : PROT_READ | PROT_WRITE;
    uintptr_t res = (uintptr_t) ::mmap(addr, size, prot,
                                       MAP_PRIVATE | MAP_FIXED | MAP_ANONYMOUS, -1, 0);
    // MAP_FIXED: 必须在 addr 精确地址提交，不能偏移
}
```

> **对照表：标准 C 用法 → HotSpot 使用方式 → 微妙之处**

| 维度 | 标准 C 用法 | HotSpot 使用方式 | 微妙之处 |
|------|-----------|---------------|---------|
| 内存申请 | 一次 `mmap()` 申请即可用 | **两阶段**：Reserve（`PROT_NONE`）→ Commit（`PROT_READ\|WRITE`） | 两阶段允许堆按需增长，堆未提交区域占地址但不占物理内存 |
| 失败处理 | `perror()` + `exit()` | `recoverable_mmap_error()` 检查 errno → `vm_exit_out_of_memory()` | 区分可恢复错误（如 `ENOMEM`）和不可恢复错误（如 `EINVAL`），[`os_linux.cpp:3302-3309`](src/hotspot/os/linux/os_linux.cpp#L3302) |
| MAP_FIXED | 很少使用 | 提交阶段**必用** `MAP_FIXED` | 确保提交的地址与保留地址完全一致，否则 CompressedOops 基址计算出错 ([`os_linux.cpp:3293`](src/hotspot/os/linux/os_linux.cpp#L3293)) |
| 大页 | 通过 `MAP_HUGETLB` | 条件编译兜底 + `MADV_HUGEPAGE` | HotSpot 自行 `#define MAP_HUGETLB 0x40000` 以兼容旧内核，[`os_linux.cpp:3328-3334`](src/hotspot/os/linux/os_linux.cpp#L3328) |

**错误路径（errno）**：`commit_memory_impl()` 最关键的路径是处理 `mmap()` 返回 `MAP_FAILED` 时保存 `errno`，然后调用 `recoverable_mmap_error()` 判断是否可恢复。不可恢复时调用 `vm_exit_out_of_memory()` 终止 JVM。

```cpp
int err = errno;  // 立即保存 errno，防止被其他调用覆盖
if (!recoverable_mmap_error(err)) {
    vm_exit_out_of_memory(size, OOM_MMAP_ERROR, "committing reserved memory.");
}
```

> **原理**：为什么必须先保存 errno？`errno` 是线程局部变量（`man 3 errno`），但 `recoverable_mmap_error()` 内部可能调用日志函数，日志函数的 `write()` 等 syscall 可能修改 `errno`。

### 境界三：MAP_FIXED——精确寻址与 CompressedOops

`MAP_FIXED` 要求内核在指定地址映射内存，不允许偏移。这在两种场景中至关重要。

**场景 1：分段提交**。提交阶段必须在保留阶段指定的地址上激活页面（见境界二）。

**场景 2：CompressedOops 基址**。在 64 位 JVM 上，CompressedOops 要求堆基址对齐到特定边界（如 32GB 对齐），以便用 32 位编码 64 位指针。

```cpp
// 尝试在期望地址 reserve 堆空间
base = os::attempt_reserve_memory_at(size, requested_address, _fd_for_heap);
// 内部：::mmap(requested_address, size, PROT_NONE,
//             MAP_PRIVATE | MAP_ANONYMOUS | MAP_NORESERVE | MAP_FIXED, -1, 0)
// 源码：virtualspace.cpp:196, virtualspace.cpp:409
```

如果 `requested_address` 已被其他映射占用，`MAP_FIXED` 会直接**覆盖**已有映射——这是危险的。因此 HotSpot 首先用 `MAP_FIXED` 尝试，失败后回退到让内核自主选地址。

> **安全提示**：`MAP_FIXED` 会无条件覆盖已有映射。现代 Linux 推荐 `MAP_FIXED_NOREPLACE`（`man 2 mmap`，Linux 4.17+），它不会覆盖已有映射，冲突时返回 `EEXIST`。HotSpot 未使用较新的 `MAP_FIXED_NOREPLACE`，因为需要兼容旧内核。

### 境界四：MAP_POPULATE——预提交

`MAP_POPULATE` 让内核在 `mmap()` 返回前就完成页表填充和物理页分配，避免后续的缺页（page fault）开销。

```cpp
// G1 PageBasedVirtualSpace 中的使用
// g1PageBasedVirtualSpace.cpp:146
uintptr_t res = (uintptr_t) ::mmap(addr, size, prot,
    MAP_PRIVATE | MAP_FIXED | MAP_ANONYMOUS | MAP_POPULATE, -1, 0);
```

> **权衡**：`MAP_POPULATE` 让映射立即可用（无缺页延迟），但增加了调用开销，且在多 NUMA 节点上可能导致内存分配在非最优节点。JVM 提供了 `AlwaysPreTouch` 选项作为替代：[`virtualspace.cpp:1000`](src/hotspot/share/memory/virtualspace.cpp#L1000) 的 `expand_by(size, pre_touch=true)` 会遍历每个页触发缺页。

### mmap 小结

| 境界 | flags 组合 | JVM 场景 | 源码位置 |
|------|-----------|---------|---------|
| 匿名映射 | `MAP_PRIVATE\|MAP_ANONYMOUS` | 一般内存分配 | [`os_linux.cpp:5798`](src/hotspot/os/linux/os_linux.cpp#L5798) |
| 延后提交 | + `MAP_NORESERVE` + `PROT_NONE` | ReservedSpace | [`os_linux.cpp:3724`](src/hotspot/os/linux/os_linux.cpp#L3724) |
| 精确提交 | + `MAP_FIXED` | commit_memory | [`os_linux.cpp:3293`](src/hotspot/os/linux/os_linux.cpp#L3293) |
| 强制提交 | + `MAP_POPULATE` | G1 页表预填充 | [`g1PageBasedVirtualSpace.cpp:146`](src/hotspot/share/gc/g1/g1PageBasedVirtualSpace.cpp#L146) |

---

## 1.2 mprotect(2)——内存的读/写/执行权限

`mprotect(2)` 修改已有内存映射的权限，是 JVM 实现**栈溢出保护**和**代码段权限管理**的核心机制。统计出现 416 次。

> **man 参考**：`man 2 mprotect`

```c
#include <sys/mman.h>
int mprotect(void *addr, size_t len, int prot);
// prot: PROT_NONE, PROT_READ, PROT_WRITE, PROT_EXEC 的组合
```

### 栈溢出保护的 Guard Page

每个 Java 线程的栈底部都有一页或多页 `PROT_NONE` 保护页。当线程递归过深，栈指针触及保护页时，触发 `SIGSEGV`，JVM 将其转换为 `StackOverflowError`。

```cpp
// os::Linux::commit_memory() 在提交栈页面前先设置保护页
// os_linux.cpp:4008
return ::mprotect(bottom, size, prot) == 0;
// 将栈底区域设为 PROT_NONE，作为 guard page
```

> **原理**：`PROT_NONE` 意味着对这段内存的任何读写访问都会触发 `SIGSEGV`。内核在缺页处理程序（page fault handler）中检查 VMA（Virtual Memory Area）权限，权限不足时向进程发送 `SIGSEGV`，`si_code` 设为 `SEGV_ACCERR`（`man 2 sigaction` 的 `siginfo_t` 定义）。

### 代码段权限管理

JIT 编译生成的代码需要写权限（生成机器码）和可执行权限（执行机器码），但**不能同时拥有两者**（W^X 安全策略）。HotSpot 的处理方式：

```cpp
// os_linux.cpp:5804
// 先可写，生成代码
int res = ::mprotect(p, size, PROT_WRITE | PROT_EXEC);
// 但实际情况中 HotSpot 更精确地用 PROT_READ|PROT_EXEC 定案
// 详细流程见 CodeCache 相关章节（Part 2）
```

> **对照表：标准 C 用法 → HotSpot 使用方式 → 微妙之处**

| 维度 | 标准 C 用法 | HotSpot 使用方式 | 微妙之处 |
|------|-----------|---------------|---------|
| 保护页 | 较少使用 | 每线程 1~N 页 `PROT_NONE` Guard Page | 多页保护解决"跳过大对象后再写栈"的问题（`-XX:StackShadowPages`） |
| 代码段 | `mmap()` 时指定最终权限 | 分阶段：可写 → 可执行（W^X） | 写操作和可执行操作在时间上分开，从不共存 |
| 错误路径 | 返回 -1 即失败 | `assert(ret == 0, ...)` 但生产代码返回 `bool` | 在某些平台上大页 `mprotect()` 可能失败（如不支持），需降级处理 |

---

## 1.3 futex(2)——JVM 同步的基石

`futex(2)` 是所有 Linux 同步原语的底层系统调用。JVM 的 `synchronized` 关键字、`Object.wait()/notify()` 最终都经过 `pthread_mutex_lock` / `pthread_cond_wait`，而它们在内核中全部基于 `futex(2)` 实现。统计显示 futex 相关内容出现 307 次。

> **man 参考**：`man 2 futex`、`man 7 futex`

```c
#include <linux/futex.h>
#include <sys/time.h>
long futex(uint32_t *uaddr, int futex_op, uint32_t val,
           const struct timespec *timeout, uint32_t *uaddr2, uint32_t val3);
```

### FUTEX_WAIT/FUTEX_WAKE——快速路径与慢速路径

futex 的"快路径"完全在用户态完成：一个原子 CAS（Compare-And-Swap）操作。只有争用时才进入内核调用 `FUTEX_WAIT`。

```
无竞争快路径（用户态）：
  while ((v = Atomic::cmpxchg(v - 1, &_event, v)) != v) ;
  // 如果 v == 1，减到 0，直接返回——没有进入内核

有竞争慢路径（内核态）：
  pthread_mutex_lock(_mutex);     // → 内核 futex(FUTEX_WAIT)
  while (_event < 0) {
      pthread_cond_wait(_cond, _mutex);  // → 内核 futex(FUTEX_WAIT)
  }
  pthread_mutex_unlock(_mutex);   // → 内核 futex(FUTEX_WAKE)
```

> **futex 与 pthread_mutex 的关系**：`pthread_mutex_lock()` 在 glibc 中的实现就是 futex。无竞争时只做一次原子操作（快路径），有竞争时调用 `futex(FUTEX_WAIT, ...)` 进入内核挂起。

### HotSpot 中的实际使用

JVM 并不直接调用 `futex()`，而是通过 `pthread_mutex`、`pthread_cond` 间接使用。PlatformEvent（HotSpot 最底层的线程阻塞原语）演示了这一模式。

**PlatformEvent::park() 的完整流程**：[`os_posix.cpp:2008-2037`](src/hotspot/os/posix/os_posix.cpp#L2008)

```cpp
// 快速路径：原子地递减 _event
int v;
for (;;) {
    v = _event;
    if (Atomic::cmpxchg(v - 1, &_event, v) == v) break;
}
// 如果递减前 _event > 0（已"许可"），直接返回——不进入内核
if (v == 0) {
    // 慢速路径：进入内核等待
    int status = pthread_mutex_lock(_mutex);       // futex(FUTEX_WAIT)
    ++_nParked;
    while (_event < 0) {
        status = pthread_cond_wait(_cond, _mutex);  // futex(FUTEX_WAIT)
        // 处理虚假唤醒：while 循环重新检查条件
    }
    --_nParked;
    _event = 0;
    status = pthread_mutex_unlock(_mutex);          // futex(FUTEX_WAKE)
}
```

> **对照表：标准 C 用法 → HotSpot 使用方式 → 微妙之处**

| 维度 | 标准 C 用法 | HotSpot 使用方式 | 微妙之处 |
|------|-----------|---------------|---------|
| 阻塞等待 | `pthread_mutex_lock()` + `pthread_cond_wait()` | `PlatformEvent::park()` | 内层 while 循环处理虚假唤醒（spurious wakeup）：OS 可能无故唤醒线程，必须重检 `_event < 0` |
| 超时等待 | `pthread_cond_timedwait()` | `PlatformEvent::park(jlong millis)` | 超时计算使用 `CLOCK_MONOTONIC` 绝对时间，避免系统时间跳变影响，[`os_posix.cpp:1902-1922`](src/hotspot/os/posix/os_posix.cpp#L1902) |
| 唤醒通知 | `pthread_cond_signal()` | `PlatformEvent::unpark()` | 唤醒前先原子设置 `_event = 1`，然后 `pthread_cond_signal()` → 内核 `futex(FUTEX_WAKE)` |
| futex PI | 通过 `PTHREAD_PRIO_INHERIT` | HotSpot 未使用 futex PI | Java `synchronized` 使用 JVM 内置的锁膨胀（偏向锁→轻量锁→重量锁）替代 PI 解决优先级反转 |

### futex 与 Semaphore 的关系

HotSpot 的 `Semaphore` 类（用于 Suspend/Resume 线程协调等）同样通过 `PlatformEvent` 实现：

- `Semaphore::wait()` → `PlatformEvent::park()` → **如果许可不够** → `pthread_cond_wait()` → `futex(FUTEX_WAIT)`
- `Semaphore::signal()` → `PlatformEvent::unpark()` → `pthread_cond_signal()` → `futex(FUTEX_WAKE)`

> **追问**：为什么 HotSpot 不直接调用 `futex()` 系统调用？因为通过 `pthread` 包装可以享受 glibc 的优化（如自适应自旋、优先级继承）、可移植性更好、且 `pthread` 在无竞争时已经足够快（一次原子操作）。

---

## 1.4 pthread——Java 线程的本质

每个 `java.lang.Thread` 在 HotSpot 中对应一个 `pthread`（1:1 映射）。JVM 不实现"绿色线程"，线程调度完全委托给 Linux 内核。

> **man 参考**：`man 7 pthreads`、`man 3 pthread_create`、`man 3 pthread_attr_init`、`man 3 pthread_key_create`

### pthread_create——从 Java 代码到内核线程

`Thread.start()` 最终调用 `os::create_thread()` → `pthread_create()`：[`os_linux.cpp:1031`](src/hotspot/os/linux/os_linux.cpp#L1031)

```cpp
// os::Linux::create_thread() 的核心调用
int ret = 0;
int limit = 3;  // 最多重试 3 次
do {
    ret = pthread_create(&tid, &attr,
                         (void *(*)(void *)) thread_native_entry,
                         thread);
} while (ret == EAGAIN && limit-- > 0);
```

三个参数分别承载了 JVM 对线程的所有控制：

| 参数 | 含义 | HotSpot 配置 |
|------|------|-------------|
| `&tid` | 出参，内核线程 ID | 存入 `OSThread::_pthread_id`，用于 `pthread_kill()` 等操作 |
| `&attr` | 线程属性 | 栈大小、Guard Page 大小、信号掩码 |
| `thread_native_entry` | 线程入口函数 | 完成 TLS 设置 → 执行 `JavaThread::run()` |
| `thread` | 传给入口的参数 | `JavaThread` 对象指针 |

### 栈大小配置

```cpp
// os_linux.cpp:1000-1014
// 栈大小 = 用户指定（-Xss）或默认值 + Guard Page 大小
size_t guard_size = os::Linux::default_guard_size(thr_type);
if (stack_size <= SIZE_MAX - guard_size) {
    stack_size += guard_size;  // Guard Page 占用栈空间的一部分
}
int status = pthread_attr_setstacksize(&attr, stack_size);
pthread_attr_setguardsize(&attr, os::Linux::default_guard_size(thr_type));
```

> **微妙之处**：`pthread_attr_setguardsize()` 设置的 glibc Guard Page 和 JVM 的 Guard Page 是**两层独立的机制**。glibc 在栈末尾放置 `PROT_NONE` 页，JVM 在此基础上增加更复杂的多页防护（通过 `-XX:StackShadowPages` 控制）。

### TLS（线程局部存储）

HotSpot 需要快速从当前 `pthread` 找到对应的 `JavaThread` 对象。它使用 `pthread_key_create()` + `pthread_setspecific()` 实现。

```cpp
// ThreadLocalStorage::thread() 返回当前 pthread 对应的 Thread*
// 内部使用 pthread_getspecific() 从 TLS 槽位读取
Thread *ThreadLocalStorage::thread() {
    return (Thread*) pthread_getspecific(ThreadLocalStorage::_thread_key);
}
```

> **原理**：TLS 的硬件实现依赖 `fs` 段寄存器（x86-64）。glibc 在 `pthread_getspecific()` 中通过 `fs` 寄存器偏移访问 TLS 数据，无需系统调用。

### 错误路径

```cpp
// pthread_create 失败处理，os_linux.cpp:1041-1053
if (ret != 0) {
    // 打印诊断信息：当前线程数、资源限制（ulimit）、内存使用、容器信息
    log_info(os, thread)("Number of threads approx. running in the VM: %d",
                         Threads::number_of_threads());
    os::Posix::print_rlimit_info(&st);  // ulimit -a 信息
    os::print_memory_info(&st);         // 内存使用
    os::Linux::print_proc_sys_info(&st);  // /proc/sys 参数
    os::Linux::print_container_info(&st); // 容器 cgroup 限制
}
```

> **对照表：标准 C 用法 → HotSpot 使用方式 → 微妙之处**

| 维度 | 标准 C 用法 | HotSpot 使用方式 | 微妙之处 |
|------|-----------|---------------|---------|
| 线程创建 | `pthread_create()` | `pthread_create()` + 3 次重试（`EAGAIN`）| `EAGAIN` 可能是暂时资源不足，重试可能成功 |
| 线程退出 | `pthread_exit()` / `return` | `JavaThread::run()` 返回后 `pthread_exit()` | exit 前必须清理 Thread-Local 对象 |
| 栈管理 | 默认栈大小 | `-Xss` 可配 + Guard Page 双重保护 | JVM Guard Page 是 `mprotect(PROT_NONE)`，glibc Guard Page 是 `pthread_attr_setguardsize()` |
| 线程标识 | `pthread_self()` | `os::current_thread_id()` + TLS 映射 | 需要双层映射：`pthread_t` → `Thread*` → `JavaThread*` |

---

## 1.5 信号处理

HotSpot 统计中有 746 次 `sigaction()` 使用和 876 次 `SIGSEGV` 提及。信号处理是 JVM 将硬件异常转换为 Java 异常的关键通道。

> **man 参考**：`man 2 sigaction`、`man 7 signal`、`man 2 sigaltstack`、`man 3 pthread_sigmask`

### sigaction(2)——SA_SIGINFO 详细模式

JVM 需要比简单信号处理更丰富的信息：导致信号的内存地址（`si_addr`）、信号原因码（`si_code`）、以及**中断时的 CPU 寄存器状态**（`ucontext_t`）。因此 HotSpot 必用 `SA_SIGINFO` 标志。

```c
struct sigaction {
    void     (*sa_handler)(int);          // 简单模式
    void     (*sa_sigaction)(int, siginfo_t *, void *);  // SA_SIGINFO 模式
    sigset_t   sa_mask;                   // 信号处理期间阻塞的信号
    int        sa_flags;                  // SA_SIGINFO | SA_RESTART 等
};
```

### SIGSEGV → NullPointerException 的转换

这是 JVM 信号处理最核心的场景。当 Java 代码访问 `null` 对象时，CPU 尝试访问低地址内存（通常 `0x0 ~ 0x1000`），触发缺页 → 内核发送 `SIGSEGV` → JVM 信号处理器检查 `si_addr`：

```
Java: obj.field = 42;  // obj == null
  ↓
CPU: mov [0x10], 42    // 访问地址 0x10（null + field offset）
  ↓
MMU: 缺页！地址 0x10 没有映射
  ↓
内核: 发送 SIGSEGV，si_addr=0x10，si_code=SEGV_ACCERR 或 SEGV_MAPERR
  ↓
JVM signalHandler() [os_linux.cpp:5221]
  ↓
JVM_handle_linux_signal() 检查 si_addr：
  - 如果 si_addr < os::vm_page_size()（通常 4KB）→ NullPointerException
  - 如果 si_addr 在 Guard Page 内 → StackOverflowError
  - 如果 si_addr 在 Safepoint Polling Page → GC 暂停处理
  ↓
抛出 Java 异常，恢复执行
```

**信号处理器的安装**：[`os_linux.cpp:5329-5408`](src/hotspot/os/linux/os_linux.cpp#L5329)

```cpp
void os::Linux::set_signal_handler(int sig, bool set_installed) {
    // 1. 先获取当前的信号处理器（不修改）
    sigaction(sig, NULL, &oldAct);

    // 2. 检查是否已被第三方覆盖
    void *oldhand = ...;
    if (oldhand != SIG_DFL && oldhand != SIG_IGN && oldhand != signalHandler) {
        if (UseSignalChaining) {
            // 加入信号链，而不是覆盖
            os::Posix::save_preinstalled_handler(sig, oldAct);
        } else {
            fatal("Unexpected pre-existing sigaction handler");
        }
    }

    // 3. 安装 JVM 的处理器
    struct sigaction sigAct;
    sigfillset(&(sigAct.sa_mask));       // 处理期间阻塞所有信号
    sigAct.sa_sigaction = signalHandler; // 三参数信号处理器
    sigAct.sa_flags = SA_SIGINFO | SA_RESTART;  // SA_SIGINFO + 系统调用自动重启
    int ret = sigaction(sig, &sigAct, &oldAct);
    assert(ret == 0, "check");
}
```

**统一安装所有信号处理器**：[`os_linux.cpp:5413-5468`](src/hotspot/os/linux/os_linux.cpp#L5413)

```cpp
void os::Linux::install_signal_handlers() {
    set_signal_handler(SIGSEGV, true);   // NullPointer / StackOverflow / GC
    set_signal_handler(SIGBUS, true);    // 硬件内存错误（对齐、不可访问）
    set_signal_handler(SIGILL, true);    // 非法指令
    set_signal_handler(SIGFPE, true);    // 算术异常（除零等）
    set_signal_handler(SIGPIPE, true);   // 管道破裂
    set_signal_handler(SIGXFSZ, true);   // 文件大小超限
    // ... 其他信号
}
```

### 信号链（libjsig.so）——与第三方库的信号协调

JNI 代码可能安装自己的信号处理器。如果 JVM 直接覆盖，第三方库的信号处理会失效。`libjsig.so` 实现了信号链机制。

**工作流程**：[`os_linux.cpp:5418-5455`](src/hotspot/os/linux/os_linux.cpp#L5418)

```
libjsig.so 拦截（interpose）sigaction() 系统调用：
  1. 第三方库调用 sigaction() → libjsig 记录处理器，不真正安装到内核
  2. JVM 调用 sigaction() → libjsig 真正安装到内核

信号发生时：
  1. 内核调用 JVM 的 signalHandler()
  2. JVM 检查是否能处理
  3. 不能处理 → 查询 libjsig 获取链上**下一个**处理器
  4. 调用下一个处理器 [os_linux.cpp:5255-5298]
```

```cpp
// call_chained_handler() 调用链上处理器的完整过程
// os_linux.cpp:5255-5298
static bool call_chained_handler(struct sigaction *actp, int sig,
                                 siginfo_t *siginfo, void *context) {
    if (actp->sa_handler == SIG_DFL) {
        return false;  // 默认处理器 → JVM 自己处理为意外异常
    } else if (actp->sa_handler != SIG_IGN) {
        // 尊重 SA_RESETHAND：一次性处理器，用后自动重置为 SIG_DFL
        // 尊重信号掩码：用 pthread_sigmask 临时设置
        // 根据 SA_SIGINFO 选择调用 sa_sigaction 或 sa_handler
    }
    return true;
}
```

### 信号栈（sigaltstack）

> **man 参考**：`man 2 sigaltstack`

当线程栈已被耗尽（如 `StackOverflowError`），内核栈和用户栈都可能不够用。为避免信号处理器执行时栈溢出导致信息丢失，JVM 使用 `sigaltstack()` 为信号处理器分配独立的备选栈。

```c
#include <signal.h>
int sigaltstack(const stack_t *ss, stack_t *old_ss);
```

`SA_ONSTACK` 标志（在 `sa_flags` 中设置）告诉内核使用备选栈执行信号处理器：

```cpp
// sigAct.sa_flags = SA_SIGINFO | SA_RESTART | SA_ONSTACK;
```

> **对照表：标准 C 用法 → HotSpot 使用方式 → 微妙之处**

| 维度 | 标准 C 用法 | HotSpot 使用方式 | 微妙之处 |
|------|-----------|---------------|---------|
| 信号注册 | `signal()` 或 `sigaction()` | 只用 `sigaction()` + `SA_SIGINFO` | 需要 `siginfo_t` 里的 `si_addr` 确定故障地址，`signal()` 不提供此信息 |
| 信号保存 | 不保存旧处理器 | 先读取旧处理器再决定覆盖/链入 | 信号链通过 libjsig.so 的 `dlsym(RTLD_DEFAULT, ...)` 动态解析，[`os_linux.cpp:5432`](src/hotspot/os/linux/os_linux.cpp#L5432) |
| SA_RESTART | 可选 | 必用 | 防止 `read()` 等慢系统调用被信号中断返回 `EINTR` |
| 信号掩码 | 手动设置 | `sigfillset(&sa_mask)` | JVM 在处理任何一个信号时阻塞所有其他信号，简化并发建模 |
| 信号栈 | 通常不用 | `SA_ONSTACK` + `sigaltstack()` | 防止在栈溢出时信号处理器无栈可用，丢失 crash 信息 |

---

## 1.6 /proc 诊断接口

`/proc` 是 Linux 的进程信息伪文件系统。HotSpot 大量使用它获取运行时状态，出现 55 次，但它在诊断流程中不可替代。

> **man 参考**：`man 5 proc`

### /proc/self/maps——地址空间快照

`/proc/self/maps` 列出进程的虚拟内存映射，每行表示一个 VMA（Virtual Memory Area）：

```
$ cat /proc/self/maps
7f000000-7f100000 rw-p 00000000 00:00 0          [heap]
7f100000-7f200000 rwxp 00000000 00:00 0          [JIT Code]
7f200000-7f300000 ---p 00000000 00:00 0          [guard page]
```

HotSpot 用 `find_vma()` 解析这个文件，定位给定地址所在的内存区域：[`os_linux.cpp:1241-1261`](src/hotspot/os/linux/os_linux.cpp#L1241)

```cpp
static bool find_vma(address addr, address *vma_low, address *vma_high) {
    FILE *fp = fopen("/proc/self/maps", "r");
    if (fp) {
        address low, high;
        while (!feof(fp)) {
            if (fscanf(fp, "%p-%p", &low, &high) == 2) {
                if (low <= addr && addr < high) {
                    // 找到包含 addr 的内存区域
                    *vma_low = low;
                    *vma_high = high;
                    fclose(fp);
                    return true;
                }
            }
            // 跳过当前行的剩余内容
            for (;;) { int ch = fgetc(fp); if (ch == '\n') break; }
        }
        fclose(fp);
    }
    return false;
}
```

**使用场景**：
- 定位主线程的初始栈（primordial thread stack）：[`os_linux.cpp:1269-1274`](src/hotspot/os/linux/os_linux.cpp#L1269)
- 检查 VMA 属性（是否有大页）：[`os_linux.cpp:2287`](src/hotspot/os/linux/os_linux.cpp#L2287)
- 检查 CompressedOops 堆是否在预期位置：[`os_linux.cpp:4072`](src/hotspot/os/linux/os_linux.cpp#L4072)

### /proc/self/smaps——精确内存使用

`/proc/self/smaps` 比 `maps` 更详细，包含每个 VMA 的 RSS（常驻内存）、PSS（比例分配共享内存）、Swap 使用等。

```
$ cat /proc/self/smaps
7f000000-7f100000 rw-p ...
Size:    1024 kB
Rss:      512 kB   # 实际使用的物理内存
Pss:      256 kB   # 按共享比例计算的物理内存
...
```

> **与 /proc/meminfo 的差异**：`/proc/meminfo` 提供全局内存统计，`/proc/self/smaps` 提供当前进程的逐映射细粒度数据。

### /proc/<pid>/fd——文件描述符

HotSpot 的 `-XX:+PrintFileDescriptors` 输出所有打开的文件描述符，内部通过遍历 `/proc/self/fd/` 目录实现。

> **对照表：标准 C 用法 → HotSpot 使用方式 → 微妙之处**

| 诊断接口 | 内容 | HotSpot 用法 | 潜在问题 |
|---------|------|-------------|---------|
| `/proc/self/maps` | VMA 列表 | 定位内存区域、检查堆地址 | `fopen()` 不是信号安全的，crash 期间不能用 |
| `/proc/self/smaps` | 逐映射内存统计 | 精确内存使用报告 | 内核遍历页表构建输出，非常慢（~100ms） |
| `/proc/<pid>/fd` | 文件描述符列表 | 诊断文件泄漏 | 在高线程数时遍历有开销 |
| `/proc/sys/vm/` | 内核内存参数 | 打印 `overcommit_memory` 等参数 | 读操作无副作用 |

---

## 1.7 ELF 与栈回溯

崩溃时，JVM 需要把指令地址转换为人可读的函数名和偏移（如 `_ZN6Thread10initializeEv+0x2f` → `Thread::initialize() + 47`）。这需要解析 ELF 文件的符号表。

> **man 参考**：`man 5 elf`、`man 3 dladdr`、`man 1 readelf`、`man 1 nm`

### ELF 文件格式速览

| 结构 | 内容 | 栈回溯用途 |
|------|------|-----------|
| ELF Header | 魔数、架构（x86-64）、入口点 | 判断文件类型 |
| Program Header | LOAD/DYNAMIC/GNU_STACK 段 | 定位动态链接信息 |
| Section Header | `.text` `.rodata` `.symtab` 等节 | 定位符号表 |
| `.symtab` | 全部符号（函数名+地址） | 地址→函数名转换 |
| `.dynsym` | 动态符号（PLT 使用的） | 动态链接函数解析 |
| `.debug_info` | DWARF 调试信息 | 源码行号映射 |

### dladdr(3)——地址到符号的基本转换

HotSpot 用 `dladdr()` 将函数指针转换为符号信息：[`os_linux.cpp:1788-1794`](src/hotspot/os/linux/os_linux.cpp#L1788)

```cpp
#include <dlfcn.h>
Dl_info dlinfo;
if (dladdr((void *) addr, &dlinfo) != 0) {
    // dlinfo.dli_fname: 共享库路径（如 libjvm.so）
    // dlinfo.dli_fbase: 共享库加载基址
    // dlinfo.dli_sname: 符号名（最近的函数）
    // dlinfo.dli_saddr: 符号地址
}
```

> **微妙之处**：`dladdr()` 返回的是"最近"符号，而不是精确符号。如果 `addr` 在 `foo()` 函数体内某处，`dli_sname` 就是 `"foo"`，`dli_saddr` 是 `foo()` 的起始地址。真正的偏移需要 `addr - dli_saddr` 计算。

**已知 bug**：旧版 glibc 的 `dladdr()` 可能将地址解析到错误的库边界，因为 HotSpot 使用了**稀疏地址空间**（reserve 了大量 `PROT_NONE` 区域）。参见 [`os_linux.cpp:1884`](src/hotspot/os/linux/os_linux.cpp#L1884) 的注释。

### ELF 文件解析——自实现解码器

HotSpot 还实现了自己的 ELF 解析器（[`elfFile.cpp`](src/hotspot/share/utilities/elfFile.cpp)），用于：

1. **精确符号解析**：绕过 `dladdr()` 的局限性，直接读取 `.symtab` 和 `.dynsym`
2. **DWARF 调试信息**：读取 `.debug_info` 获取源码位置映射
3. **共享库地址范围**：读取 Program Header 确定每个 `.so` 的地址范围，用于判断 `addr` 属于哪个库

```cpp
// elfFile.cpp:85 — 直接读取 ELF 文件的函数封装
bool ElfFile::read_bytes(void *buf, size_t size) {
    return fread(buf, size, 1, _fd) == 1;
}
```

### _Unwind_Backtrace 与 backtrace(3)

> **man 参考**：`man 3 backtrace`、`man 3 backtrace_symbols`

`backtrace()` 从调用栈中收集返回地址，`backtrace_symbols()` 将地址转为符号字符串。HotSpot 在 crash 报告中使用 `backtrace()` 或 `_Unwind_Backtrace()` 生成栈帧列表。

```c
#define _GNU_SOURCE
#include <execinfo.h>
void *buffer[100];
int nptrs = backtrace(buffer, 100);
char **strings = backtrace_symbols(buffer, nptrs);
// strings[0] = "libjvm.so(_ZN6Thread10initializeEv+0x2f) [0x7f...]"
```

> **对照表：标准 C 用法 → HotSpot 使用方式 → 微妙之处**

| 维度 | 标准 C 用法 | HotSpot 使用方式 | 微妙之处 |
|------|-----------|---------------|---------|
| 地址→符号 | `dladdr()` | `dladdr()` + 自实现 ELF 解析器 | `dladdr()` 有 glibc bug（稀疏地址空间） → 先检查地址是否在已知库范围内 |
| 栈回溯 | `backtrace()` | `backtrace()` + Frame 步进遍历 | `backtrace()` 可能跳过 JIT 编译帧（帧指针省略导致无法回溯）→ Frame 步进用 RBP 链补充 |
| 符号解析时机 | 启动时 | crash 时才解析（懒加载） | crash 期间不能分配内存（`malloc()` 不安全）→ 预分配缓冲区 |
| DWARF 信息 | `libunwind` | 自实现 ELF 解析器 | libunwind 不是默认库（需额外安装）→ 自实现保证可用性 |

---

## 1.8 时间测量

JVM 的所有时间戳——从 `System.nanoTime()` 到 JFR（Java Flight Recorder）事件——最终都汇聚到 `clock_gettime(2)`。统计出现 138 次。

> **man 参考**：`man 2 clock_gettime`、`man 2 gettimeofday`

### CLOCK_MONOTONIC 的单调性保证

**标准 C 的关键区别**：

```c
// 不推荐：gettimeofday() 受系统时间调整影响（NTP/time sync 会导致跳变）
struct timeval tv;
gettimeofday(&tv, NULL);
// tv 可能向前跳或向后跳 ← 对超时计算是灾难性的

// 推荐：clock_gettime(CLOCK_MONOTONIC, ...)
struct timespec ts;
clock_gettime(CLOCK_MONOTONIC, &ts);
// ts 保证单调递增，不受系统时间调整影响
```

> **原理**：`CLOCK_MONOTONIC` 从系统启动开始计时，不随 wall clock 跳变。NTP 只调整频率（`adjtime()`），不会导致时间倒退。但**注意**：`CLOCK_MONOTONIC` 在系统挂起（suspend）期间不计数——如果严格需要包含挂起时间，用 `CLOCK_BOOTTIME`（`man 2 clock_gettime`，Linux 2.6.39+）。

### HotSpot 的时间戳管线

**1. 动态加载 `clock_gettime()`**：[`os_linux.hpp:211-212`](src/hotspot/os/linux/os_linux.hpp#L211)

```cpp
// HotSpot 用 dlsym 动态加载 clock_gettime
static int clock_gettime(clockid_t clock_id, struct timespec *tp) {
    return _clock_gettime ? _clock_gettime(clock_id, tp) : -1;
}
// _clock_gettime 通过 dlsym(RTLD_DEFAULT, "clock_gettime") 初始化
// 原因：兼容老内核（2.4）无此函数
```

**2. JFR 纳秒时间戳**：[`os_linux.cpp:1614`](src/hotspot/os/linux/os_linux.cpp#L1614)

```cpp
int status = Linux::clock_gettime(CLOCK_MONOTONIC, &tp);
// 转换为纳秒：tp.tv_sec * 1_000_000_000 + tp.tv_nsec
```

**3. 绝对时间（日志、crash 报告）**：[`os_linux.cpp:3086`](src/hotspot/os/linux/os_linux.cpp#L3086)

```cpp
os::Linux::clock_gettime(CLOCK_REALTIME, &ts);
// CLOCK_REALTIME 返回 UTC 时间，用于打印日志时间戳
```

**4. 超时计算（PlatformEvent timeout）**：

```cpp
// os_linux.cpp:5531
int rc = os::Linux::clock_gettime(clockid, &tp);
// clockid 为 CLOCK_MONOTONIC
// 计算绝对超时时间：now + timeout → 用于 pthread_cond_timedwait()
```

> **对照表：标准 C 用法 → HotSpot 使用方式 → 微妙之处**

| 维度 | 标准 C 用法 | HotSpot 使用方式 | 微妙之处 |
|------|-----------|---------------|---------|
| 性能计时 | `clock_gettime(CLOCK_MONOTONIC)` | 同上 + 动态加载兜底 | 老内核（2.4）无 `clock_gettime()` → 动态加载 + fallback 到 `gettimeofday()` |
| 绝对时间 | `gettimeofday()` | `clock_gettime(CLOCK_REALTIME)` | `gettimeofday()` 微秒精度，`CLOCK_REALTIME` 纳秒精度 |
| 超时等待 | 相对时间 | 转为绝对时间（A.D.） | 条件变量等待必须用绝对时间（`pthread_cond_timedwait()` 规范要求）→ 防止虚假唤醒累积偏差 |
| 时间溢出 | 无防护 | `MAX_SECS = 100,000,000` 硬限制 | 防止 `timeout / NANOUNITS` 溢出 32 位 `time_t`，实际限时约 3.17 年 |
| 时钟选择 | `CLOCK_MONOTONIC` | 偏好 `CLOCK_MONOTONIC`，回退 `CLOCK_REALTIME` | 部分老 glibc 不支持 `pthread_condattr_setclock()` → [`os_posix.cpp:1853-1861`](src/hotspot/os/posix/os_posix.cpp#L1853) 分支处理 |
| `nanosleep()` | 34 次出现 | JVM 内部定时器 | `nanosleep()` ≠ `sleep()`：`nanosleep()` 不受信号中断（`SA_RESTART` 不适用），剩余时间可查，[`man 2 nanosleep`](https://man7.org/linux/man-pages/man2/nanosleep.2.html) |

---

## 1.9 信号安全 I/O

信号处理器中不能调用任何"非信号安全"的函数——包括 `printf()`、`malloc()`、`fopen()`。违反此规则可能导致死锁（`malloc` 内部有锁）或数据损坏。

> **man 参考**：`man 7 signal-safety`（Linux 信号安全函数完整列表）、`man 2 write`

### 为什么 write(2) 安全而 printf(3) 不安全？

```c
// 不安全：
void bad_handler(int sig) {
    printf("Signal %d\n", sig);  // × 可能死锁！
    // printf 内部调用 malloc（分配缓冲区）
    // 如果信号中断正在执行的 malloc → 锁已被持有 → 死锁
}

// 安全：
void good_handler(int sig) {
    static const char msg[] = "Signal\n";
    write(STDERR_FILENO, msg, sizeof(msg) - 1);  // √ 安全
    // write 是纯粹的系统调用，无内部锁
}
```

> **原理**：`write()` 是"async-signal-safe"的——内核直接执行，无用户态锁。`printf()` 位于"async-signal-unsafe"列表中——可能分配内存、持有 `FILE*` 锁、或使用全局状态。

### HotSpot 的信号安全写入实现

**InstrumentLog 的信号安全日志**：[`instrumentLog.cpp:86-98`](src/hotspot/share/utilities/instrumentLog.cpp#L86)

```cpp
void InstrumentLog::write_log_signal_safe(const char* msg) {
    if (!_initialized || _log_fd < 0) {
        return;  // 无日志文件 → 直接返回
    }
    // 只用 write() 系统调用，不使用 fwrite/malloc/lock
    const char* prefix = "[Signal] ";
    const char* newline = "\n";
    ::write(_log_fd, prefix, strlen(prefix));  // √ 信号安全
    ::write(_log_fd, msg, strlen(msg));         // √ 信号安全
    ::write(_log_fd, newline, 1);              // √ 信号安全
}
```

**fdStream——确保 write 直通内核**：[`ostream.cpp:604-609`](src/hotspot/share/utilities/ostream.cpp#L604)

```cpp
void fdStream::write(const char* s, size_t len) {
    if (_fd != -1) {
        // 直接调用 write()，绕过 FILE* 缓冲区和锁
        size_t count = ::write(_fd, s, (int)len);
    }
}
```

### vmError::report_and_die()——Crash 时的信号安全写入

当 JVM 崩溃时（如 `SIGSEGV` 未被正确处理），`vmError::report_and_die()` 负责写 `hs_err_pid<pid>.log` 文件：

1. **步骤 1——保存现场**：获取信号信息、PC、栈帧
2. **步骤 2——信号安全的步骤**：
   - 线程列表、内存区域 → 使用 `fdStream`（底层 `::write()`）
   - 寄存器状态 → 直接格式化到静态缓冲区
3. **步骤 3——写文件**：`::open()` + `::write()` → `hs_err` 文件
4. **步骤 4——可选 fork 子进程**：用 `fork()` + `execve()` 调用外部 debugger
   - 为什么用 fork？因为 `exec()` 会破坏当前进程状态，coredump 会丢失 → `fork()` 在子进程中 exec

> **man 参考**：`man 2 fork`、`man 2 execve`

```cpp
// vmError.cpp:1312
// report_and_die() 的入口日志使用信号安全方式
INST_LOG_SIGNAL_SAFE("VMError::report_and_die — JVM fatal error, generating hs_err log");
```

### 信号安全函数速查

Posix 定义的 async-signal-safe 函数（`man 7 signal-safety`）：

| 类别 | 安全函数 | 不安全替代 | 为什么 |
|------|---------|-----------|--------|
| 输出 | `write()`, `writev()` | `printf()`, `fprintf()` | FILE* 有锁 |
| 内存分配 | 静态 buffer 预分配 | `malloc()`, `new` | 分配器有锁 |
| 文件操作 | `open()`, `close()` | `fopen()`, `fclose()` | FILE* 有锁 |
| 字符串 | `_exit()` | `exit()`, `atexit()` | `exit()` 调用 atexit 回调 |
| 进程 | `fork()` | `system()`, `popen()` | 内部有锁和信号处理 |
| 同步 | 无 | `sem_post()`, `pthread_mutex_lock()` | 信号处理期间不应阻塞 |

> **对照表：标准 C 用法 → HotSpot 使用方式 → 微妙之处**

| 维度 | 标准 C 用法 | HotSpot 使用方式 | 微妙之处 |
|------|-----------|---------------|---------|
| Crash 日志写入 | `fprintf(stderr, ...)` | `fdStream::write()` → `::write(2, ...)` | 绕过 `FILE*` 缓冲和锁 |
| 内存分配 | `asprintf()` | 预分配静态缓冲区 | 在 `install_signal_handlers()` 前分配好所有输出缓冲区 |
| 文件创建 | `fopen("hs_err...")` | `::open("hs_err...", O_CREAT\|... )` + `::write()` | `fopen()` 不是信号安全的 |
| 子进程调用 | `popen("gdb ...")` | `fork()` + `execve()` | `popen()` 内部调用 `fork()` + `malloc()` — `malloc()` 在信号处理中不安全 |
| 线程杀死 | 不应在信号中操作其他线程 | `pthread_kill(SIGILL)` 中断报告线程 | 报告线程可能卡住（死锁）→ 超时后用 `pthread_kill` 中断它，[`vmError_posix.cpp:72-77`](src/hotspot/os/posix/vmError_posix.cpp#L72) |

---

## 小结

JVM 对 Linux 系统调用的使用不是"按需调用"的散装方式，而是精心设计的**分层抽象**：

```
应用层（Java）
  synchronized, Thread.start(), System.nanoTime()
    ↓
JVM 运行时层（C++）
  ObjectMonitor, os::create_thread(), PlatformEvent
    ↓
POSIX 抽象层（C++）
  pthread_mutex_lock, pthread_cond_wait, sigaction
    ↓
系统调用层（内核）
  futex, mmap, mprotect, clock_gettime, write
    ↓
硬件层
  CPU 原子操作, MMU 页表, fs 寄存器
```

| 主题 | 核心 syscall | HotSpot 入口 | 关键文件 |
|------|-------------|-------------|---------|
| 内存分配 | `mmap(2)` | `os::reserve_memory()` + `os::commit_memory()` | [`os_linux.cpp:3280-3310`](src/hotspot/os/linux/os_linux.cpp#L3280) |
| 内存保护 | `mprotect(2)` | Guard Page / CodeCache W^X | [`os_linux.cpp:4008`](src/hotspot/os/linux/os_linux.cpp#L4008) [`os_linux.cpp:5804`](src/hotspot/os/linux/os_linux.cpp#L5804) |
| 线程同步 | `futex(2)` | `PlatformEvent::park()` / `unpark()` | [`os_posix.cpp:2008-2037`](src/hotspot/os/posix/os_posix.cpp#L2008) |
| 线程创建 | `pthread_create(3)` | `os::create_thread()` | [`os_linux.cpp:1031`](src/hotspot/os/linux/os_linux.cpp#L1031) |
| 信号处理 | `sigaction(2)` | `signalHandler()` + 信号链 | [`os_linux.cpp:5221`](src/hotspot/os/linux/os_linux.cpp#L5221) [`os_linux.cpp:5329`](src/hotspot/os/linux/os_linux.cpp#L5329) |
| 进程诊断 | `/proc/self/maps` | `find_vma()` | [`os_linux.cpp:1241`](src/hotspot/os/linux/os_linux.cpp#L1241) |
| 符号解析 | `dladdr(3)` | `os::dll_address_to_function_name()` | [`os_linux.cpp:1788`](src/hotspot/os/linux/os_linux.cpp#L1788) |
| 时间测量 | `clock_gettime(2)` | 动态加载 + `CLOCK_MONOTONIC` | [`os_linux.hpp:211`](src/hotspot/os/linux/os_linux.hpp#L211) |
| Crash 报告 | `write(2)` | `fdStream::write()` → `::write()` | [`ostream.cpp:604`](src/hotspot/share/utilities/ostream.cpp#L604) |

**进一步阅读**：
- 第 2 章：C++ in HotSpot——模板、虚函数、宏、内存模型（本章读完后续）
- Linux 手册：`man 2 mmap`, `man 2 futex`, `man 7 signal`, `man 5 proc`, `man 7 signal-safety`
- 内核源码：`mm/mmap.c` 的 `do_mmap()`, `kernel/futex.c` 的 `do_futex()`, `arch/x86/mm/fault.c` 的 `do_page_fault()`

> **一句话总结**：JVM 的 Linux 系统编程哲学是"在用户态尽可能快，需要时进入内核，永远在信号安全范围内操作"——`mmap` 的延后提交、`futex` 的快速路径、`write` 的信号安全输出，全部遵循这一原则。
