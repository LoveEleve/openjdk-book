# Prompt-00: SA 架构全景 + Native 核心数据结构

> **目标文档**: `probe_md/20-sa-postmortem/docs/00-SA-Architecture-Native-Core.md`
>
> **预计篇幅**: 2000-3000 行
>
> **质量锚点**: `probe_md/15-core-native/prompts/prompt-00-System-Arraycopy.md` (521 行, 12 个 Section)

---

## §〇 Production Scenario

**场景**: 生产环境 JVM 进程突然无响应（hang），jstack 无法连接，但 SA（Serviceability Agent）的 `jhsdb jstack --pid <pid>` 仍能成功获取线程栈。运维工程师需要理解：

1. 为什么 SA 能在 JVM 无响应时工作？（零协作需求）
2. SA 的 `libsaproc.so` 是如何通过 `ptrace(PTRACE_PEEKDATA)` 从挂起的 JVM 进程中读取内存的？
3. 如果是 core dump 离线分析（`jhsdb jstack --exe libjvm.so --core core.1234`），SA 又是如何在不依赖运行中进程的情况下，从 ELF core 文件中重建进程地址空间的？

**真实案例**: 某微服务 JVM 因 GC 死锁导致所有线程挂起，jstat/jstack 超时。使用 `jhsdb jstack --pid 4451` 成功获取到 412 个线程的完整栈轨迹，帮助定位到 `G1ParTask` 的 `ObjectSynchronizer` 死锁。事后分析 core dump（`jhsdb jstack --exe java --core core.4451`）验证了相同结论。

**本文档目标**: 深入 `libsaproc.so` 的 C 源码，解释 SA 的三层架构、两模式（Live/Postmortem）的底层实现、以及 `ps_prochandle` 核心数据结构体系的设计哲学。

---

## §一 Task + Narrative + Beginner Callouts

### Task

写出一篇深度技术文档，覆盖：

1. **SA 三层架构全景**: Java Debugger 抽象层 → JNI 桥接层 → Native libsaproc.so
2. **两模式对比**: Live Mode (ptrace) vs Postmortem Mode (ELF core parse) 的完整对比
3. **ps_prochandle 核心数据结构体系**:
   - `ps_prochandle` 主结构体（pid/ops/libs/threads/core）
   - `ps_prochandle_ops` vtable（函数指针分派）
   - `lib_info` 链表（共享库映射 + 符号表）
   - `thread_info` 链表（LWP ID + 寄存器缓存）
   - `map_info` 链表（虚拟内存映射）
   - `core_data` 结构体（core dump 专用数据）
4. **PageCache 机制**: `DebuggerBase.java` 的 16MB 缓存如何与 libsaproc 读操作协调

### Narrative

文档应该以**执行流**为主线：

```
SA 启动 (HotSpotAgent.attach)
    ↓
模式选择 (Live vs Core)
    ↓
创建 ps_prochandle (Pgrab / Pgrab_core)
    ↓
填充核心数据结构 (lib_info 链表 + thread_info 链表 + map_info 链表)
    ↓
Java 层通过 JNI 调用 libsaproc API (lookup_symbol / get_lwp_regs / read_bytes)
    ↓
底层内存读取 (ptrace PEEKDATA vs pread)
    ↓
PageCache 减少 syscalls
```

### Beginner Callouts (≥7 个，只在 §一 内)

> **💡 初学者提示 1**: SA（Serviceability Agent）是 JDK 自带的诊断工具集，与 JMX/JVMTI 不同，它**不需要目标 JVM 配合**。即使 JVM 已挂起（死锁、OOM、GC hang），SA 仍能通过 OS 级接口（ptrace/core dump）读取内存。

> **💡 初学者提示 2**: `libsaproc.so` 是 SA 的 Native 层，用 C 编写（不是 C++）。它直接调用 `ptrace(2)`、`pread(2)`、`open(2)` 等系统调用，不依赖 libjvm.so。

> **💡 初学者提示 3**: `ps_prochandle` 是 SA 的核心结构体，类似于 Solaris libproc 的 `struct ps_prochandle`。它用 **C 函数指针 vtable**（而非 C++ 虚函数）实现 Live/Postmortem 两模式的多态分派。

> **💡 初学者提示 4**: Live Mode 使用 `ptrace(PTRACE_PEEKDATA)` 逐字读取目标进程内存，每次读取 **1 word**（8 字节 on amd64）。这就是为什么 SA 读取大块内存时很慢——PageCache 就是为了解决这个问题。

> **💡 初学者提示 5**: Postmortem Mode 读取 core dump 时，使用 `pread(2)` 从 ELF 文件中读取。关键是建立 **虚拟地址 → 文件偏移** 的映射（通过 PT_LOAD 段），这与 Live Mode 的 ptrace 读取完全不同。

> **💡 初学者提示 6**: `lib_info` 链表记录了目标进程加载的所有共享库（如 libjvm.so、libc.so），每个库有独立的**符号表缓存**（`struct symtab*`）。符号查找时遍历链表，在 `symtab` 中搜索。

> **💡 初学者提示 7**: `thread_info` 链表记录了目标进程的所有线程（LWP）。Live Mode 从 `/proc/<pid>/task/` 扫描，Postmortem Mode 从 core dump 的 `NT_PRSTATUS` note 读取。`regs` 字段缓存了线程的寄存器值（用于栈回溯）。

---

## §二 Standard Environment

### Source Roots

```
src/jdk.hotspot.agent/linux/native/libsaproc/    # Linux Native 实现 (13 files)
src/jdk.hotspot.agent/share/native/libsaproc/     # 跨平台 Native (sadis.c)
src/jdk.hotspot.agent/share/classes/sun/jvm/hotspot/debugger/  # Java Debugger 抽象层
```

### Build Command

```bash
# 全量构建 (产出 libsaproc.so + sa-jdi.jar)
make images

# 单独构建 libsaproc.so
make hotspot-native

# 产出路径
support/native/jdk.hotspot.agent/libsaproc/libsaproc.so
images/jdk/lib/libsaproc.so
```

### Binary Paths

| 组件 | 路径 | 类型 |
|------|------|------|
| libsaproc.so | `images/jdk/lib/libsaproc.so` | ELF 64-bit LSB shared object |
| sa-jdi.jar | `images/jdk/lib/sa-jdi.jar` | Java JAR (sa-jdi.jar) |
| jhsdb | `images/jdk/bin/jhsdb` | Shell script launcher |

### Syscall 速查表

| Syscall | 用途 | 手册页 |
|---------|------|--------|
| `ptrace(2)` | Live Mode 内存读写 + 寄存器访问 | `man 2 ptrace` |
| `pread(2)` / `pwrite(2)` | Core Mode 文件读取（定位 + 读取） | `man 2 pread` |
| `open(2)` / `openat(2)` | 打开 /proc 文件、core 文件、共享库 | `man 2 open` |
| `opendir(3)` / `readdir(3)` | 扫描 `/proc/<pid>/task/` 枚举线程 | `man 3 opendir` |
| `fopen(3)` / `fgets(3)` | 解析 `/proc/<pid>/maps` 文本格式 | `man 3 fopen` |
| `close(2)` | 关闭文件描述符 | `man 2 close` |
| `waitpid(2)` | 等待 ptrace ATTACH 完成 (SIGSTOP) | `man 2 waitpid` |
| `kill(2)` | 发送信号 (SIGSTOP/SIGCONT) | `man 2 kill` |

---

## §三 Source Files Table

| 文件 | 路径 | 行数 | 核心内容 |
|------|------|------|----------|
| `libproc_impl.h` | `src/jdk.hotspot.agent/linux/native/libsaproc/` | 127 | **核心数据结构定义**: `ps_prochandle`, `ps_prochandle_ops` (vtable), `lib_info`, `thread_info`, `map_info`, `core_data` |
| `libproc.h` | `src/jdk.hotspot.agent/linux/native/libsaproc/` | 108 | **公共 C API**: `Pgrab`, `Pgrab_core`, `Prelease`, `lookup_symbol`, `find_lib`, `get_lwp_regs`, `get_num_threads` 等 15 个函数 |
| `libproc_impl.c` | `src/jdk.hotspot.agent/linux/native/libsaproc/` | 421 | **核心管理函数**: `add_lib_info`, `add_lib_info_fd`, `add_thread_info`, `delete_thread_info`, `init_libproc` |
| `ps_proc.c` | `src/jdk.hotspot.agent/linux/native/libsaproc/` | 527 | **Live Mode 实现**: `process_read_data` (ptrace PEEKDATA), `Pgrab` (ATTACH 流程), `process_get_lwp_regs`, `ptrace_attach`, `ptrace_waitpid` |
| `ps_core.c` | `src/jdk.hotspot.agent/linux/native/libsaproc/` | 1134 | **Postmortem Mode 实现**: `core_read_data` (pread), `Pgrab_core`, `core_release`, `add_map_info`, ELF note 解析 |
| `symtab.h` | `src/jdk.hotspot.agent/linux/native/libsaproc/` | ~80 | **符号表 API**: `symtab_create`, `symtab_lookup`, `symtab_destroy` |
| `symtab.c` | `src/jdk.hotspot.agent/linux/native/libsaproc/` | 607 | **ELF 符号表解析**: `.symtab` / `.dynsym` 解析, hash table 查找 |
| `proc_service.h` | `src/jdk.hotspot.agent/linux/native/libsaproc/` | ~100 | **GDB 兼容接口**: `ps_pdread`, `ps_pglobal_lookup` 等 (供 libthread_db 使用) |
| `LinuxDebuggerLocal.java` | `src/jdk.hotspot.agent/share/classes/sun/jvm/hotspot/debugger/linux/` | ~800 | **Java JNI 桥接层**: `attach0`, `readBytesFromProcess0`, `lookupByName0`, `getThreadIntegerRegisterSet0` |
| `DebuggerBase.java` | `src/jdk.hotspot.agent/share/classes/sun/jvm/hotspot/debugger/` | ~500 | **PageCache 实现**: 16MB 缓存 (4096 页 × 4KB), LRU 淘汰, 减少 ptrace 调用 |

---

## §四 Deep Dive Question Groups

### 问题组 1: ps_prochandle vtable 分派设计

**问题**: 为什么 `ps_prochandle_ops` 使用 C 函数指针 vtable 而非 C++ 虚函数实现多态？

**答案方向** (≥8 行):

在 `libproc_impl.h:64-75`，`ps_prochandle_ops` 定义了 4 个函数指针：
- `release`: 清理函数
- `p_pread`: 读取 debuggee 内存
- `p_pwrite`: 写入 debuggee 内存
- `get_lwp_regs`: 获取线程寄存器

**设计决策分析**:
1. **C 兼容性**: `libsaproc` 是 C 代码（非 C++），避免 C++ ABI 兼容性问题
2. **与 Solaris libproc 兼容**: 注释 `libproc_impl.h:33` 明确说明 "mimic those of Solaris 8.0 - libproc's Pcontrol.h"
3. **函数指针 vtable vs C++ 虚函数**:
   - C 函数指针：显式、可控、无隐藏的 vtable 布局
   - C++ 虚函数：依赖编译器实现，ABI 不稳定

**Counterfactual（反事实讨论）**:
> 如果改用 C++ 虚函数，`ps_prochandle` 会变成 `class PsProchandle` 带虚析构函数。优点：类型安全、IDE 重构友好。缺点：(1) C++ 异常安全需要 `-fno-exceptions` 兼容；(2) Solaris 移植层需要重写；(3) 与 GDB 的 `proc_service.h` API（纯 C）交互时需要 `extern "C"` 包装。

**量化对比**:

| 方案 | 函数调用开销 | 内存布局 | ABI 稳定性 | GDB 兼容性 |
|------|-------------|----------|------------|------------|
| C 函数指针 vtable | 1 次间接跳转 | `ops` 指针 + 4 函数指针 | 稳定（调用约定固定） | 直接兼容 |
| C++ 虚函数 | 2 次间接跳转（vptr→vtable→func） | vptr 隐藏在对象头部 | 依赖编译器（Itanium ABI） | 需要 `extern "C"` |

**源码引用**: `libproc_impl.h:94-103` (`struct ps_prochandle` 定义), `ps_proc.c` (Live Mode 的 `ops` 实现), `ps_core.c:64-75` (Core Mode 的 `ops` 实现)

---

### 问题组 2: 两模式内存读取路径差异

**问题**: Live Mode 的 `ptrace(PTRACE_PEEKDATA)` 逐字读取 vs Postmortem Mode 的 `pread()` 大块读取，性能差异是多少倍？为什么 Live Mode 这么慢？

**答案方向** (≥8 行):

**Live Mode 读取路径** (`ps_proc.c:69-116` `process_read_data`):
1. `ptrace(PTRACE_PEEKDATA, pid, addr, 0)` 每次读取 **1 word**（8 字节 on amd64）
2. 需要处理**非对齐地址**（`libproc_impl.h:56-58` `align()` 宏）
3. 对于 `size > 8` 的请求，循环调用 `ptrace` 多次
4. **系统调用开销**: 每次 `ptrace` 是 1 次 syscall → ~100-200ns/次

**Postmortem Mode 读取路径** (`ps_core.c` `core_read_data`):
1. `pread(fd, buf, size, offset)` 一次读取 **任意大小**
2. `offset` 通过 `map_info` 的 `vaddr → offset` 映射计算
3. **系统调用开销**: 1 次 `pread` 可读取 KB~MB 级数据

**量化对比** (读取 4096 字节):

| 模式 | Syscall 次数 | 时间开销 | 计算公式 |
|------|-------------|---------|---------|
| Live (ptrace) | 512 次 (4096/8) | ~50-100 μs | 512 × 200ns/syscall |
| Postmortem (pread) | 1 次 | ~1-5 μs | 1 × 5μs (文件顺序读) |
| **加速比** | **512x** | **10-100x** | - |

**Counterfactual**:
> 如果 Linux 内核支持 `process_vm_readv(2)`（added in Linux 3.2），Live Mode 可以一次读取大块内存。但 SA 需要支持旧内核（RHEL 6/7），所以仍用 `ptrace`。实际上，`process_vm_readv` 可以将 Live Mode 性能提升到接近 Postmortem Mode（~5x 差距而非 100x）。

**PageCache 的作用** (`DebuggerBase.java`):
- 缓存 4096 页 × 4KB = **16MB**
- 命中时跳过 `ptrace` 调用
- LRU 淘汰策略

**源码引用**: `ps_proc.c:69-116`, `ps_core.c` core_read_data 函数, `libproc_impl.h:67-72` (ops->p_pread 函数指针)

---

### 问题组 3: lib_info 链表 vs 哈希表

**问题**: 为什么 `lib_info` 用单向链表而非哈希表做符号查找索引？当目标进程加载了 200+ 个共享库时，遍历链表的性能影响如何？

**答案方向** (≥8 行):

**lib_info 链表定义** (`libproc_impl.h:38-44`):
```c
typedef struct lib_info {
  char             name[BUF_SIZE];
  uintptr_t        base;
  struct symtab*   symtab;   // 每个库独立的符号表缓存
  int              fd;
  struct lib_info* next;     // 单向链表
} lib_info;
```

**符号查找流程** (`libproc.h:98-99` `lookup_symbol`):
1. 遍历 `lib_info` 链表
2. 对每个 `lib->symtab` 调用 `symtab_lookup`
3. 找到第一个匹配项即返回

**为什么用链表？**
1. **库数量少**: 典型 JVM 进程加载 50-150 个共享库，不是性能瓶颈
2. **插入顺序 = 加载顺序**: 符号查找需要按加载顺序搜索（先加载的库优先），链表天然保持顺序
3. **简单性**: 不需要处理哈希冲突、rehash、内存分配复杂度
4. **与 Solaris libproc 兼容**: 再次强调 Solaris 兼容性（`libproc_impl.h:33`）

**性能量化** (遍历 150 个库):
- 链表遍历: O(n) = 150 次指针解引用 → ~150ns（如果 symtab 未缓存）
- 实际: `symtab` 已缓存，第一次查找后 `symtab_lookup` 是 O(1) hash 查找
- **瓶颈不在链表遍历，而在 `symtab_lookup` 的 hash 冲突**

**Counterfactual**:
> 如果改用哈希表（以 `base` 地址为 key），`lookup_symbol` 可以 O(1) 定位库。但当多个库有**符号名冲突**时（如 `malloc` 在 libc.so 和 libmalloc.so 中都存在），需要按加载顺序搜索，哈希表反而需要额外维护顺序。链表虽然 O(n)，但 n 通常 < 200，且 `symtab` 内部已是哈希表，整体性能可接受。

**源码引用**: `libproc_impl.h:38-44`, `libproc_impl.c` `add_lib_info` (尾插), `symtab.c` `symtab_lookup`

---

### 问题组 4: thread_info 头插 vs lib_info 尾插

**问题**: 为什么 `thread_info` 链表用**头插法**（`add_thread_info`），而 `lib_info` 链表用**尾插法**（`add_lib_info`）？这反映了什么设计意图？

**答案方向** (≥8 行):

**lib_info 尾插** (`libproc_impl.c` `add_lib_info`):
```c
// lib_tail 指向链表尾部，新节点插入尾部
ph->lib_tail->next = lib;
ph->lib_tail = lib;
```
**设计意图**: 保持**库加载顺序**（从 `/proc/<pid>/maps` 或 core dump 的 `NT_FILE` note 中按地址升序读取）。符号查找时，先加载的库优先（符合 ELF 动态链接器的符号解析规则）。

**thread_info 头插** (`libproc_impl.c` `add_thread_info`):
```c
// 新节点插入头部
thr->next = ph->threads;
ph->threads = thr;
```
**设计意图**:
1. **最近添加的线程在链表头部**: 符合栈的 LIFO 特性，最近创建的线程先被扫描
2. **与 `get_lwp_id(ph, 0)` 配合**: 索引 0 返回"第一个"线程（通常是 main 线程或最近附加的线程）
3. **性能无关**: 线程数量通常 < 1000，头插 O(1) vs 尾插 O(n)（如果没有 tail 指针）

**对比总结**:

| 链表 | 插入方式 | 顺序含义 | 访问模式 |
|------|---------|---------|---------|
| `lib_info` | 尾插 | 库加载顺序（地址升序） | 遍历（符号查找） |
| `thread_info` | 头插 | 线程发现顺序（LIFO） | 遍历（寄存器读取） |

**Counterfactual**:
> 如果 `thread_info` 也用尾插，需要维护 `thread_tail` 指针（类似 `lib_tail`）。但线程发现的顺序是**不确定的**（`/proc/<pid>/task/` 的 `readdir` 返回顺序依赖文件系统实现），尾插保证的顺序没有实际意义。头插简化了代码（O(1) 插入，无需 tail 指针）。

**源码引用**: `libproc_impl.h:46-51` (`thread_info` 定义), `libproc_impl.c:122` `add_thread_info`, `libproc_impl.c:115` `add_lib_info`

---

### 问题组 5: core_data 结构体的必要性

**问题**: 为什么 `core_data` 结构体只用于 Postmortem Mode（core dump），而 Live Mode 不需要？`core_data` 中的 `map_array` 排序数组有什么用？

**答案方向** (≥8 行):

**core_data 定义** (`libproc_impl.h:79-92`):
```c
struct core_data {
   int                core_fd;        // core 文件描述符
   int                exec_fd;         // 可执行文件描述符
   int                interp_fd;       // 动态链接器 (ld-linux.so.2)
   int                classes_jsa_fd; // Class Data Sharing (CDS) 归档
   uintptr_t          dynamic_addr;   // a.out 的 PT_DYNAMIC 段地址
   uintptr_t          ld_base_addr;   // ld.so 基址
   size_t             num_maps;        // map_info 数量
   map_info*          maps;           // map_info 链表
   map_info*          class_share_maps;
   map_info**         map_array;      // 按 vaddr 排序的指针数组！
};
```

**为什么 Live Mode 不需要 core_data？**

| 数据 | Live Mode | Postmortem Mode | 原因 |
|------|-----------|-----------------|------|
| core_fd | 不需要 | 需要 | Live 无 core 文件 |
| exec_fd | 不需要（通过 /proc/<pid>/exe 符号链接） | 需要 | core 文件不含可执行文件内容 |
| maps | 通过 `/proc/<pid>/maps` 实时读取 | 需要从 ELF Program Header 重建 | core 文件是进程快照，需离线解析 |
| map_array | 不需要 | **需要** | 地址 → 文件偏移的二分查找 |

**map_array 的作用** (`libproc_impl.h:91`):
- `maps` 链表是按**发现顺序**排列的（从 ELF Program Header 读取）
- `map_array` 是按 `vaddr` **排序的指针数组**，用于 `core_read_data` 中的**地址查找**
- **二分查找**: O(log n) 定位虚拟地址所在的 `map_info`，然后计算文件偏移

**性能量化**:
- 遍历 `maps` 链表: O(n)（n = PT_LOAD 段数量，通常 20-50）
- 用 `map_array` 二分查找: O(log n)（~5 次比较 for n=32）
- **实际影响**: `core_read_data` 被频繁调用（每次符号查找、每次内存读取），优化累积效果显著

**Counterfactual**:
> 如果 `maps` 链表按 `vaddr` 排序，可以遍历的同时做"早期退出"（当 `vaddr < map->vaddr` 时停止）。但插入时需要 O(n) 查找插入位置，且 Program Header 的顺序不一定是地址升序。用独立的 `map_array` 排序数组，既保持了插入的 O(1)（头插），又获得了查找的 O(log n)。

**源码引用**: `libproc_impl.h:79-92`, `ps_core.c` `build_map_array` (排序), `ps_core.c` `core_read_data` (用 map_array 查找)

---

### 问题组 6: PageCache 与 ptrace 读取的协调

**问题**: `DebuggerBase.java` 的 PageCache 是如何减少 `ptrace(PTRACE_PEEKDATA)` 调用次数的？缓存未命中时，SA 是如何批量读取的？

**答案方向** (≥8 行):

**PageCache 设计** (`DebuggerBase.java`):
- **容量**: 4096 页 × 4KB/页 = **16MB**
- **页大小**: 4KB（匹配 x86 页大小）
- **替换策略**: LRU（最近最少使用）
- **缓存键**: 页对齐的虚拟地址

**读取流程** (`DebuggerBase.readBytes`):
1. 计算请求地址所在的**页**（`addr / 4096`）
2. 检查该页是否在 PageCache 中
3. **命中**: 直接从缓存复制，无需 `ptrace`
4. **未命中**: 调用 `readPage`（JNI → `libsaproc.p_pread`），读取 **整页 4KB**，存入 PageCache

**ptrace 调用次数对比** (读取 4KB 数据):

| 场景 | 无 PageCache | 有 PageCache (冷启动) | 有 PageCache (热命中) |
|------|-------------|---------------------|---------------------|
| 4KB 顺序读 | 512 次 ptrace | 1 次 `p_pread` (4KB) | 0 次 ptrace |
| 4KB 随机读 | 512 次 ptrace | 512 次 `p_pread` (1 字节/次) | 取决于局部性 |

**关键优化**: `readPage` 在 Native 层（`ps_proc.c:69-116` `process_read_data`）仍然是**逐 word 读取**！PageCache 的优化在于**减少 `readPage` 的调用次数**，而非优化 `process_read_data` 内部。

**Counterfactual**:
> 如果 `process_read_data` 改用 `process_vm_readv(2)`（批量读取），即使 PageCache 未命中，也能 1 次 syscall 读取 4KB。但 SA 需要支持旧内核（Linux < 3.2），所以 `process_read_data` 仍用 `ptrace`。PageCache 是在**应用层**绕开这个限制：通过缓存 4KB 页，减少 `process_read_data` 的调用频率。

**未来优化方向**:
- 用 `process_vm_readv` 替代 `ptrace`（需要运行时检测内核版本）
- 增大 PageCache 到 64MB（适合大堆分析）
- 预取（prefetch）相邻页

**源码引用**: `DebuggerBase.java` `readBytes` + `readPage`, `ps_proc.c:69-116` `process_read_data`, `libproc.h:68-69` `p_pread` 函数指针

---

## §五 Article Structure

文档应按以下结构组织（## 表示一级章节，### 表示二级章节）：

```
# 00 SA 架构全景 + Native 核心数据结构 — libsaproc.so 深度解析

## §一 SA 三层架构全景
### 1.1 从 jhsdb 命令行到 libsaproc.so 的调用链
### 1.2 三层架构图（Java Debugger → JNI → Native）
### 1.3 零协作需求：为什么 SA 能在 JVM 挂起时工作？

## §二 两模式对比：Live vs Postmortem
### 2.1 模式选择逻辑（HotSpotAgent.attach 中的 if-else）
### 2.2 量化对比表（入口函数/内存读 syscall/线程获取/符号查找/Worker 线程）
### 2.3 Live Mode 局限性：ptrace 的权限要求 + 性能瓶颈

## §三 ps_prochandle 核心数据结构体系
### 3.1 ps_prochandle 主结构体拆解（pid/ops/libs/threads/core）
### 3.2 ps_prochandle_ops vtable：C 函数指针实现多态
### 3.3 lib_info 链表：共享库映射 + 符号表缓存
### 3.4 thread_info 链表：LWP ID + 寄存器缓存
### 3.5 map_info 链表：虚拟内存映射（仅 Postmortem Mode）
### 3.6 core_data 结构体：core dump 专用数据（map_array 排序数组）

## §四 内存读取路径深度分析
### 4.1 Live Mode：ptrace(PTRACE_PEEKDATA) 逐字读取
### 4.2 Postmortem Mode：pread() + 虚拟地址 → 文件偏移映射
### 4.3 性能量化：512x  syscalls 差距 + PageCache 优化

## §五 PageCache 机制：应用层缓存减少 ptrace 调用
### 5.1 DebuggerBase.java 的 16MB 缓存设计
### 5.2 缓存命中/未命中的处理流程
### 5.3 LRU 淘汰策略 + 未来优化方向（process_vm_readv）

## §六 符号查找流程：从 Java 层到 ELF 符号表
### 6.1 lookup_symbol 的完整调用链（Java → JNI → libsaproc → symtab）
### 6.2 symtab.c 的 ELF 符号表解析（.symtab vs .dynsym）
### 6.3 符号查找的性能瓶颈分析

## §七 边缘场景与诊断工具
### 7.1 ptrace 权限不足（ypthon cap_sys_ptrace / /proc/sys/kernel/yama/ptrace_scope）
### 7.2 core dump 文件不完整（no vmem or truncated）
### 7.3 诊断工具五件套：strace + jhsdb + jstack + GDB + /proc

## §八 总结：SA 架构设计的权衡
### 8.1 C 而非 C++：与 Solaris libproc 的兼容性
### 8.2 链表而非哈希表：简单性优先
### 8.3 ptrace 而非 process_vm_readv：旧内核支持
### 8.4 PageCache：应用层补偿内核接口的低效

---

## §六 Writing Requirements

### 6.1 总体原则

1. **源码是证据（20%），原理是正文（80%）**: 不要写成源码翻译，要解释"为什么这么设计"
2. **每个技术断言必须标注 file:line 引用**: 如 `libproc_impl.h:64-75`
3. **量化对比优先**: 用表格/数字说明性能差距、内存占用、复杂度
4. **Counterfactual 讨论**: 每个设计决策都要讨论"如果选另一个方案会怎样"

### 6.2 "不要写成→应该写成"对照表

| 不要写成 | 应该写成 |
|---------|---------|
| 只列 ps_prochandle 字段名 | 每个字段解释用途 + 活进程 vs core dump 时的不同取值 |
| 只说"两模式不同" | 量化对比表：入口函数/内存读 syscall/线程获取路径/符号查找方式/是否需要 Worker 线程 |
| 只贴 lib_info 结构体定义 | 解释字段用途（name/base/symtab/fd/next）+ 符号查找流程 + 与 symtab.c 的交互 |
| 只说"ptrace 很慢" | 量化：读取 4KB 需要 512 次 ptrace 调用 vs 1 次 pread，性能差距 50-100x |
| 只说"PageCache 缓存内存" | 解释缓存键（页对齐地址）、缓存大小（4096×4KB）、LRU 淘汰、未命中时的批量读取策略 |
| 只说"vtable 实现多态" | 对比 C 函数指针 vtable vs C++ 虚函数：调用开销/内存布局/ABI 稳定性/GDB 兼容性 |
| 只贴代码不解释 | 每个代码块后跟 3-5 行解释：这段代码的意图、关键点、与前后文的关联 |
| 只说"详见 man 手册" | 具体引用 man 章节（如 `man 2 ptrace` 的 `PTRACE_PEEKDATA` 部分），并解释关键参数 |

### 6.3 源码阅读要求

1. **必须读源码**: 不要依赖 prompt 中的摘要，直接读 `.c` / `.h` 文件
2. **用 man 手册验证系统调用**: 遇到 `ptrace` / `pread` / `opendir` 等，立即 `man 2 ptrace` 查看详细参数和返回值
3. **追踪调用链**: 从 `Pgrab` → `process_read_data` → `ptrace(PTRACE_PEEKDATA)`，完整追踪调用链
4. **对比 Live/Postmortem 实现**: `ps_proc.c` vs `ps_core.c` 中的同名函数（通过 `ops` vtable 分派）

---

## §七 Output Format

### 7.1 文件格式

- **格式**: GitHub Flavored Markdown (`.md`)
- **编码**: UTF-8
- **行宽**: 100 字符（方便终端阅读）

### 7.2 代码块格式

```c
// 代码块必须标注文件路径和行号范围
// 示例：
// libproc_impl.h:64-75

typedef struct ps_prochandle_ops {
   void (*release)(struct ps_prochandle* ph);
   bool (*p_pread)(struct ps_prochandle *ph, uintptr_t addr, char *buf, size_t size);
   bool (*p_pwrite)(struct ps_prochandle *ph, uintptr_t addr, const char *buf , size_t size);
   bool (*get_lwp_regs)(struct ps_prochandle* ph, lwpid_t lwp_id, struct user_regs_struct* regs);
} ps_prochandle_ops;
```

### 7.3 表格格式

使用 GitHub Flavored Markdown 表格，对齐列宽。

### 7.4 Callout 格式

使用 `> **💡 初学者提示 X**` 格式（仅在 §一 中，不重复）：

```markdown
> **💡 初学者提示 8**: 这是第 8 个 callout（如果需要超过 7 个）。
```

### 7.5 章节编号

使用 `## §一` `### 1.1` 格式，确保 `rg '^## §' file.md` 能验证连续无跳号。

---

## §八 Prohibited（≥8 条）

1. **禁止写成源码翻译**: 不要逐行解释代码，要提炼设计原理和权衡
2. **禁止遗漏 file:line 引用**: 每个技术断言必须标注源码位置
3. **禁止只列结构体定义不解释**: 每个字段都要解释用途和活进程/core dump 时的不同取值
4. **禁止跳过 counterfactual 讨论**: §四 的每个问题组必须包含"如果选另一个方案会怎样"
5. **禁止在 §一 以外添加 Beginner Callout**: Callout 只能在 §一 内，避免重复
6. **禁止遗漏 man 手册引用**: 每个系统调用必须标注 `man 2 xxx` 或 `man 3 xxx`
7. **禁止写成科普文**: 本文档的目标读者是有 C 和 Linux 系统编程经验的工程师，不要解释"什么是指针"
8. **禁止遗漏边缘场景**: §七 必须包含 ≥3 个边缘场景（ptrace 权限/core dump 不完整/符号表缺失）
9. **禁止混淆 Live/Postmortem Mode**: 明确标注每个函数/数据结构的适用模式
10. **禁止遗漏 PageCache 与 libsaproc 的协调**: §五 必须解释应用层缓存如何减少 ptrace 调用

---

## §九 Required（≥8 条）

1. **必须包含 SA 三层架构图**: 用 ASCII art 或 Mermaid 绘制 Java → JNI → Native 的调用链
2. **必须包含两模式量化对比表**: 覆盖入口函数/内存读 syscall/线程获取/符号查找/Worker 线程
3. **必须逐个解释 ps_prochandle 的 6 个核心数据结构**: `ps_prochandle`, `ps_prochandle_ops`, `lib_info`, `thread_info`, `map_info`, `core_data`
4. **必须在 §四 包含 ≥6 个深度问题组**: 每组含 counterfactual 讨论 + 量化对比 + 源码引用
5. **必须解释 PageCache 机制**: 16MB 缓存 + LRU 淘汰 + 减少 ptrace 调用的原理
6. **必须包含边缘场景 section**: ≥3 个场景（ptrace 权限/core dump 不完整/符号表缺失）
7. **必须使用 man 手册验证系统调用**: `ptrace(2)`, `pread(2)`, `opendir(3)` 等
8. **必须包含诊断工具五件套**: `strace` + `jhsdb` + `jstack` + `GDB` + `/proc`
9. **必须解释 vtable 设计决策**: C 函数指针 vs C++ 虚函数的权衡
10. **必须验证 §四 答案方向 ≥8 行**: 随机抽取 3 个问题组验证

---

## §十 GDB Verification（≥7 断言）

以下是可以通过 GDB 验证的断言（在 Live Mode 中验证）：

### 断言 1: ps_prochandle 的 pid 字段正确

```gdb
# 附加到运行中的 JVM
gdb -p <pid>

# 查找 libsaproc.so 中的全局变量或局部变量
# 假设在 Pgrab 中打了断点
break Pgrab
run

# 验证 ps_prochandle->pid == target_pid
print ph->pid
# 期望: $1 = <target_pid>
```

### 断言 2: process_read_data 每次读取 8 字节

```gdb
break process_read_data
run

# 单步执行，观察 ptrace(PTRACE_PEEKDATA) 的调用次数
# 对于 size=4096 的请求，应该调用 512 次 ptrace
```

### 断言 3: lib_info 链表按加载顺序排列

```gdb
# 在 add_lib_info 中打断点
break add_lib_info

# 验证 lib->next 的插入顺序
# 第一个 lib 应该是可执行文件本身（a.out）
print lib->name
# 期望: "/path/to/java"
```

### 断言 4: thread_info 链表头插

```gdb
# 在 add_thread_info 中打断点
break add_thread_info

# 验证新线程插入头部
# 第一次调用时 ph->threads == NULL
# 第二次调用时 ph->threads->lwpid == 第二个线程的 LWP ID
```

### 断言 5: core_data.map_array 按 vaddr 排序

```gdb
# 需要调试 core dump 模式
# 在 build_map_array 中打断点
break build_map_array

# 验证 map_array[i]->vaddr < map_array[i+1]->vaddr
# 对所有 i 成立
```

### 断言 6: ptrace(PTRACE_PEEKDATA) 返回 long

```gdb
# 验证 ptrace 的返回值是 long（8 字节 on amd64）
break process_read_data

# 单步到 ptrace 调用
step
print sizeof(rslt)
# 期望: $1 = 8
```

### 断言 7: PageCache 命中时跳过 ptrace

```gdb
# 在 DebuggerBase.readPage 中打断点
break DebuggerBase.readPage

# 第一次读取某个地址：冷启动，调用 ptrace
# 第二次读取同一地址：缓存命中，不调用 ptrace
# 需要在 Java 层设置条件断点
```

---

## §十一 与 README 和同组 prompt 的连续性

### 11.1 与 README 的关系

本文档是 Phase 20 的第 00 篇，对应 `probe_md/20-sa-postmortem/README.md` 中的：

- **§§ 00 - SA 架构全景 + Native 核心数据结构** (`README.md:141-156`)
- 核心内容 1-7 (`README.md:149-156`)

**连续性保证**:
- 本文档覆盖 `libproc_impl.h`, `libproc.h`, `libproc_impl.c` 三个文件
- 后续 prompt-01 覆盖 `ps_proc.c`（Live Mode 详细分析）
- 后续 prompt-02 覆盖 `ps_core.c`（Postmortem Mode 详细分析）
- 本文档是后续文档的**基础**，必须详细解释核心数据结构

### 11.2 与同组 prompt 的关系

| Prompt | 文件 | 与本文档的关系 |
|--------|------|---------------|
| prompt-00 (本文档) | SA 架构 + 核心数据结构 | 基础：解释所有核心数据结构 |
| prompt-01 | Live Debugging (ps_proc.c) | 依赖本文档的 `ps_prochandle` + `ops->p_pread` 解释 |
| prompt-02 | Postmortem Debugging (ps_core.c) | 依赖本文档的 `core_data` + `map_info` 解释 |
| prompt-03 | JNI Bridge + Symbol (LinuxDebuggerLocal.c + symtab.c) | 依赖本文档的 `lookup_symbol` + `lib_info` 解释 |
| prompt-04 | SA Bootstrap (HotSpotAgent.java + TypeDataBase) | 依赖本文档的 SA 三层架构图 |
| prompt-05 | Tools Pipeline (jstack/jmap/jinfo) | 依赖本文档的 Debugger 抽象层解释 |

### 11.3 避免重复

- **不与 prompt-01 重复**: 本文档只解释 `process_read_data` 的原理，不展开 Live Mode 的完整流程（那是 prompt-01 的内容）
- **不与 prompt-02 重复**: 本文档只解释 `core_data` 结构体，不展开 ELF core dump 解析细节（那是 prompt-02 的内容）
- **不与 prompt-03 重复**: 本文档只解释 `lookup_symbol` API，不展开 JNI 桥接层细节（那是 prompt-03 的内容）

---

## §十二 质量自检清单

写完文档后，逐项检查：

- [ ] §四 深度问题组 ≥6 组，每组含 counterfactual
- [ ] §八 Prohibited ≥8 条
- [ ] §九 Required ≥8 条
- [ ] §十 Verification ≥7 断言
- [ ] §四 答案方向 ≥8 行（随机抽取 3 个验证）
- [ ] Beginner Callout ≥7 个，且只在 §一 内
- [ ] man 手册引用覆盖所有核心 syscall
- [ ] 独立的边缘场景 section ≥3 场景
- [ ] §二 有 syscall/二进制/全局状态表
- [ ] 标题格式 `# NN-Name — Subtitle`
- [ ] 运行 `rg '^## §' file.md` 验证连续无跳号
- [ ] 总行数 ≥450 行（目标是 2000-3000 行）

---

## 附录: 关键源码位置速查

| 符号 | 文件:行号 | 说明 |
|------|----------|------|
| `ps_prochandle` | `libproc_impl.h:94-103` | 主结构体 |
| `ps_prochandle_ops` | `libproc_impl.h:64-75` | vtable |
| `lib_info` | `libproc_impl.h:38-44` | 共享库链表 |
| `thread_info` | `libproc_impl.h:46-51` | 线程链表 |
| `map_info` | `libproc_impl.h:53-61` | 虚拟内存映射 |
| `core_data` | `libproc_impl.h:79-92` | core dump 专用数据 |
| `Pgrab` | `libproc.h:58-59` | Live Mode 入口 |
| `Pgrab_core` | `libproc.h:62-63` | Postmortem Mode 入口 |
| `Prelease` | `libproc.h:66-67` | 释放 ps_prochandle |
| `lookup_symbol` | `libproc.h:98-99` | 符号查找 |
| `process_read_data` | `ps_proc.c:69-116` | Live Mode 内存读取 |
| `core_read_data` | `ps_core.c` (搜索函数名) | Postmortem Mode 内存读取 |
| `add_lib_info` | `libproc_impl.c:115` | 尾插 lib_info |
| `add_thread_info` | `libproc_impl.c:122` | 头插 thread_info |

---

**END OF PROMPT**
