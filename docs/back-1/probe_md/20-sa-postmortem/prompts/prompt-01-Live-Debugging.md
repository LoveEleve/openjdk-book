# Prompt-01: Native 活进程调试（Live Mode）— ps_proc.c 深度解析

> **目标文档**: `probe_md/20-sa-postmortem/docs/01-Live-Debugging.md`
>
> **预计篇幅**: 2500-3500 行
>
> **质量锚点**: `probe_md/15-core-native/prompts/prompt-00-System-Arraycopy.md` (521 行, 12 个 Section)
>
> **前置文档**: `prompt-00-SA-Architecture.md`（必须已读，理解 ps_prochandle 核心数据结构）

---

## §〇 Production Scenario

**场景**: 生产环境 JVM 进程 CPU 100%，但 jstack 超时无法连接。运维工程师使用 `jhsdb jstack --pid 18234` 成功获取线程栈，发现是 `G1ParTask` 在 `ObjectSynchronizer::inflate` 中自旋。问题是：

1. `jhsdb` 是如何通过 `ptrace(PTRACE_ATTACH)` 附加到正在运行的 JVM 进程的？
2. 附加后为什么必须 `waitpid` 等待 `SIGSTOP`？如果不等待会怎样？
3. `process_read_data()` 是如何通过 `ptrace(PTRACE_PEEKDATA)` 从目标进程读取内存的？为什么需要手工处理地址对齐？
4. `/proc/<pid>/maps` 解析得到的库基址，如何与 SA 的符号表查找配合，实现 `lookup_symbol("CollectedHeap::collect")` 这样的符号解析？
5. 扫描 `/proc/<pid>/task/` 枚举线程时，如果线程在 `opendir` 和 `ptrace_attach` 之间退出，SA 如何兜底？

**真实案例**: 某支付系统 JVM 在高峰时段无响应，jstat 超时。使用 `jhsdb jstack --pid 4451` 附加成功，但在扫描线程时发现 3 个线程已退出（`/proc/4451/task/` 中存在但 `process_doesnt_exist` 返回 true），SA 正确跳过了这些线程，最终成功获取 409 个线程的栈轨迹。事后分析发现是 `G1ConcurrentMark` 的 yield 逻辑 bug。

**本文档目标**: 深入 `ps_proc.c` 的 527 行 C 源码，解释 Live Mode 的完整实现：从 `Pgrab()` 入口 → `ptrace_attach()` 信号交互 → `process_read_data()` 内存读取 → `/proc/<pid>/maps` 解析 → 线程扫描与 attach 竞态处理 → `Prelease()` 清理顺序。

---

## §一 Task + Narrative + Beginner Callouts

### Task

写出一篇深度技术文档，覆盖：

1. **Pgrab() 完整流程**: 从 `ptrace(PTRACE_ATTACH)` 到返回 `ps_prochandle*` 的每一步（line 450-527）
2. **ptrace 信号交互协议**: `PTRACE_ATTACH` 发送 SIGSTOP → `waitpid` 等待 → 非 SIGSTOP 信号转发（`ptrace_continue`）→ 为什么必须等待 SIGSTOP？
3. **process_read_data() 深度分析**: `ptrace(PTRACE_PEEKDATA)` 逐 word 读取、地址对齐处理（head/tail 拼接）、边界情况（跨页、尾部不足 long）
4. **/proc/<pid>/maps 解析**: `read_lib_info()` 的文本解析逻辑、prelink 处理、为什么不用 libproc 的 library iteration API
5. **线程扫描与 attach 竞态**: `/proc/<pid>/task/` 扫描 → `process_doesnt_exist()` 兜底 → `ptrace_attach()` 逐个附加
6. **process_doesnt_exist() 的实现**: 读取 `/proc/<pid>/status` 的 `State:` 行，判断 X/Z 状态
7. **Prelease() 清理顺序**: 为什么先 `ptrace(DETACH)` 再释放链表？顺序反过来会怎样？
8. **性能量化**: `ptrace(PTRACE_PEEKDATA)` 的系统调用开销、与 `process_vm_readv(2)` 的对比

### Narrative

文档应该以**执行流**为主线，穿插**信号交互时序图**和**内存读取对齐示意图**：

```
jhsdb jstack --pid <pid>
    ↓
Pgrab(pid)                           [ps_proc.c:450]
    ↓
ptrace_attach(pid)                   [ps_proc.c:275]
    → ptrace(PTRACE_ATTACH, pid)     发送 SIGSTOP 给目标进程
    → ptrace_waitpid(pid)             [ps_proc.c:178]
        → waitpid(pid, &status, 0)  阻塞等待 SIGSTOP
        → 如果 status 不是 SIGSTOP → ptrace_continue 转发信号
    ↓
ph->pid = pid                       初始化 ps_prochandle
ph->ops = &process_ops             挂载 vtable（Live Mode 实现）
    ↓
read_lib_info(ph)                   [ps_proc.c:351]
    → fopen("/proc/<pid>/maps")
    → 解析每行：地址范围、权限、偏移、设备、inode、路径名
    → add_lib_info(ph, path, base)  添加到 lib_info 链表
    ↓
扫描 /proc/<pid>/task/              [ps_proc.c:485-504]
    → opendir + readdir
    → 对每个 tid != pid：process_doesnt_exist(tid) 检查
    → add_thread_info(ph, tid)
    ↓
逐个 ptrace_attach(tid)             [ps_proc.c:509-525]
    → 跳过主线程（已 attach）
    → 如果 ATTACH_THREAD_DEAD → delete_thread_info 从链表移除
    ↓
返回 ph                            Pgrab 成功
    ↓
Java 层通过 JNI 调用
    → readBytesFromProcess0 → process_read_data  [ps_proc.c:69]
    → getThreadIntegerRegisterSet0 → process_get_lwp_regs  [ps_proc.c:125]
    ↓
Prelease(ph)                       [libproc.h:66-67]
    → process_cleanup(ph)            [ps_proc.c:437]
        → detach_all_pids(ph)       [ps_proc.c:429]
            → ptrace(PTRACE_DETACH) 对每个线程
        → 释放 lib_info/thread_info 链表
```

### Beginner Callouts (≥7 个，只在 §一 内)

> **💡 初学者提示 1**: `ptrace(PTRACE_ATTACH, pid)` 的本质是向目标进程发送 SIGSTOP 信号，并使自己成为目标进程的父进程（tracer）。目标进程收到 SIGSTOP 后会挂起，并向 tracer 发送 SIGCHLD。SA 通过 `waitpid` 等待这个事件。
>
> **💡 初学者提示 2**: `process_read_data()` 不能直接读取任意地址。Linux 的 `ptrace(PTRACE_PEEKDATA)` 每次只返回 **1 word**（8 字节 on amd64），且要求地址是 **word 对齐**的。如果目标地址未对齐（如 0x7f1a2b3c4d5e，末尾不是 0 或 8），需要手工拼接。
>
> **💡 初学者提示 3**: `/proc/<pid>/maps` 是文本文件，每行格式：`address           perms offset  dev   inode   pathname`。例如：`7f1a2b3c0000-7f1a2b3c4000 r-xp 00000000 08:01 12345  /usr/lib/libjvm.so`。SA 解析这个文件来获取所有共享库的加载基址。
>
> **💡 初学者提示 4**: `process_doesnt_exist(pid)` 不是通过 `kill(pid, 0)` 检查进程是否存在，而是读取 `/proc/<pid>/status` 文件，检查 `State:` 行的值。如果状态是 `X`（dead）或 `Z`（zombie），则认为线程已不存在。
>
> **💡 初学者提示 5**: Live Mode 的 `process_write_data()` 是 **空实现**（直接返回 false）！也就是说，SA 的 Live Mode 是**只读**的，不能修改目标进程的内存。这是设计决策：避免意外修改正在运行的 JVM。
>
> **💡 初学者提示 6**: `ptrace_waitpid()` 中的 `__WALL` 标志（line 44-45 定义）是 Linux 专有宏，表示等待所有类型的子进程（包括 tracee 和 cloned 进程）。如果不加这个标志，`waitpid` 可能返回 `ECHILD`（当 tracee 是通过 `clone` 创建的线程时）。
>
> **💡 初学者提示 7**: `Prelease()` 的清理顺序是：**先** `ptrace(PTRACE_DETACH)` 解除对所有线程的 attach，**再** 释放 `lib_info`/`thread_info` 链表。如果顺序反过来，DETACH 时需要访问 `thread_info` 链表，但链表已被释放，会导致 use-after-free。

---

## §二 Standard Environment

### Source Roots

```
src/jdk.hotspot.agent/linux/native/libsaproc/ps_proc.c    # Live Mode 实现 (527 行)
src/jdk.hotspot.agent/linux/native/libsaproc/libproc_impl.h # 核心数据结构定义 (127 行)
src/jdk.hotspot.agent/linux/native/libsaproc/libproc.h      # 公共 C API 声明 (108 行)
src/jdk.hotspot.agent/linux/native/libsaproc/libproc_impl.c # add_lib_info/add_thread_info 实现
```

### Build Command

```bash
# 全量构建 (产出 libsaproc.so)
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
| jhsdb | `images/jdk/bin/jhsdb` | Shell script launcher |
| sa-jdi.jar | `images/jdk/lib/sa-jdi.jar` | Java JAR (包含 SA 工具) |

### Syscall 速查表

| Syscall | 用途 | 手册页 | 在 ps_proc.c 中的位置 |
|---------|------|--------|----------------------|
| `ptrace(2)` | 进程跟踪/内存读写/寄存器访问 | `man 2 ptrace` | line 78, 94, 107, 169, 277, 420 |
| `waitpid(2)` | 等待子进程状态变化（SIGSTOP） | `man 2 waitpid` | line 184 |
| `open(2)` | 打开 /proc/<pid>/maps 等文件 | `man 2 open` | 通过 fopen 间接调用 |
| `pread(2)` | 读取文件（本文档不涉及，core mode 用） | `man 2 pread` | - |
| `opendir(3)` / `readdir(3)` | 扫描 /proc/<pid>/task/ 枚举线程 | `man 3 opendir` | line 490-492 |
| `fopen(3)` / `fgets(3)` | 解析 /proc/<pid>/maps 文本格式 | `man 3 fopen` | line 357, 363 |
| `fopen(3)` / `fgets(3)` | 读取 /proc/<pid>/status 检查线程状态 | `man 3 fopen` | line 238 |
| `close(2)` | 关闭文件描述符（lib_info.fd） | `man 2 close` | line 410 |
| `kill(2)` | 发送信号（本文档不直接调用） | `man 2 kill` | 通过 ptrace 间接实现 |

---

## §三 Source Files Table

| 文件 | 路径 | 行数 | 核心内容 |
|------|------|------|----------|
| `ps_proc.c` | `src/jdk.hotspot.agent/linux/native/libsaproc/` | 527 | **Live Mode 完整实现**: `Pgrab` (line 450), `ptrace_attach` (line 275), `ptrace_waitpid` (line 178), `process_read_data` (line 69), `process_get_lwp_regs` (line 125), `process_doesnt_exist` (line 231), `read_lib_info` (line 351), `ptrace_detach` (line 419), `detach_all_pids` (line 429), `process_cleanup` (line 437), `process_ops` vtable (line 441) |
| `libproc_impl.h` | `src/jdk.hotspot.agent/linux/native/libsaproc/` | 127 | **核心数据结构**: `ps_prochandle` (line 94), `ps_prochandle_ops` (line 64), `lib_info` (line 38), `thread_info` (line 46), `map_info` (line 53), `core_data` (line 79), `align()` 宏 (line 56) |
| `libproc.h` | `src/jdk.hotspot.agent/linux/native/libsaproc/` | 108 | **公共 API**: `Pgrab` (line 58), `Pgrab_core` (line 62), `Prelease` (line 66), `lookup_symbol` (line 98), `get_lwp_regs` (line 83), `find_lib` (line 95) |
| `libproc_impl.c` | `src/jdk.hotspot.agent/linux/native/libsaproc/` | 421 | **链表管理**: `add_lib_info` (尾插, line 115), `add_thread_info` (头插, line 122), `delete_thread_info` (line 具体), `init_libproc` (line 具体) |
| `symtab.h` / `symtab.c` | `src/jdk.hotspot.agent/linux/native/libsaproc/` | ~687 | **符号表**: `symtab_create`, `symtab_lookup`, ELF .symtab/.dynsym 解析（被 `read_lib_info` 间接调用） |

---

## §四 Deep Dive Question Groups

### 问题组 1: ptrace(PTRACE_ATTACH) 的信号交互协议

**问题**: 为什么 `ptrace(PTRACE_ATTACH)` 后必须 `waitpid` 等待 SIGSTOP？如果 SA 不等待直接继续执行会怎样？`ptrace_continue()` 的作用是什么？

**答案方向** (≥12 行):

`ptrace(PTRACE_ATTACH, pid)` 的内核行为是：向目标进程发送 SIGSTOP，并使 tracer 成为目标的父进程（`man 2 ptrace` 的 "Description" 部分）。但 SIGSTOP **不会立即送达**（目标进程可能在执行其他系统调用），所以 SA 必须调用 `waitpid(pid, &status, 0)` 阻塞等待。

**关键竞态** (`ps_proc.c:178-223` `ptrace_waitpid`):
1. `waitpid` 返回后，检查 `WIFSTOPPED(status)` 是否为 true
2. 如果是，检查 `WSTOPSIG(status)` 是否为 SIGSTOP
3. 如果不是 SIGSTOP（目标进程收到其他信号，如 SIGSEGV），调用 `ptrace_continue(pid, signal)` 转发该信号，然后继续 `waitpid`
4. 如果 `waitpid` 返回 `ECHILD`，尝试 `waitpid(pid, &status, __WALL)`（处理 cloned 线程）

**为什么不等待会出错？**
- 如果 SA 在目标进程真正停止前就尝试 `ptrace(PTRACE_PEEKDATA)`，内核返回 `EBUSY`（操作正在进行）
- 如果 SA 不等待就 `ptrace(PTRACE_DETACH)`，目标进程可能仍处于 stopped 状态，导致进程永久挂起（SIGSTOP 待处理）

**Counterfactual（反事实讨论）**:
> 如果 Linux 提供 `ptrace(PTRACE_ATTACH_SYNC)`（原子 attach + wait），就不需要分开调用。但现实是 `PTRACE_ATTACH` 是异步的，SA 必须处理这个竞态。macOS 的 `ptrace(PT_ATTACH)` 有类似问题，但可以通过 `SIGSTOP` + `wait` 组合解决。

**量化影响**:
- `waitpid` 的延迟：通常 < 1ms（目标进程立即响应 SIGSTOP）
- 如果目标进程在系统调用中（如 `nanosleep`），延迟可能达到系统调用持续时间（最坏情况：几秒）

**源码引用**: `ps_proc.c:178-223` (`ptrace_waitpid`), `ps_proc.c:275-306` (`ptrace_attach`), `ps_proc.c:167-174` (`ptrace_continue`), `man 2 ptrace` 的 "PTRACE_ATTACH" 部分

---

### 问题组 2: process_read_data() 的对齐处理与边界情况

**问题**: `ptrace(PTRACE_PEEKDATA)` 要求地址是 word 对齐的（8 字节 on amd64），但 SA 的调用者可能传入任意地址。 `process_read_data()` 是如何处理未对齐地址、跨页读取、尾部不足 word 的边界情况的？

**答案方向** (≥12 行):

`process_read_data()` (`ps_proc.c:69-116`) 的对齐处理分三步：

**第一步：处理头部未对齐** (line 75-87)
```c
uintptr_t aligned_addr = align(addr, sizeof(long));  // line 73
if (aligned_addr != addr) {
    // 用 ptrace 读取 aligned_addr 处的 1 word
    rslt = ptrace(PTRACE_PEEKDATA, ph->pid, aligned_addr, 0);  // line 78
    // 手工拼接：从 rslt 的对应偏移复制字节到 buf
    for (; aligned_addr != addr; aligned_addr++, ptr++);  // line 83: 跳过头部
    for (; ((intptr_t)aligned_addr % sizeof(long)) && aligned_addr < end_addr;
            aligned_addr++)
       *(buf++) = *(ptr++);  // line 86: 复制拼接部分
}
```
**解释**: 如果 `addr = 0x7f1a2b3c4d05`（末尾 0x05，未对齐），`aligned_addr = 0x7f1a2b3c4d08`。先读取 `aligned_addr` 处的 word，然后从该 word 的第 5 字节开始复制。

**第二步：逐 word 读取对齐部分** (line 89-102)
```c
words = (end_addr - aligned_addr) / sizeof(long);
for (i = 0; i < words; i++) {
    rslt = ptrace(PTRACE_PEEKDATA, ph->pid, aligned_addr, 0);  // line 94
    *(long *)buf = rslt;  // line 99: 直接赋值（buf 已对齐）
    buf += sizeof(long);
    aligned_addr += sizeof(long);
}
```

**第三步：处理尾部不足 word** (line 104-114)
```c
if (aligned_addr != end_addr) {
    rslt = ptrace(PTRACE_PEEKDATA, ph->pid, aligned_addr, 0);  // line 107
    for (; aligned_addr != end_addr; aligned_addr++)
       *(buf++) = *(ptr++);  // line 112: 复制尾部字节
}
```

**边界情况分析**:

| 场景 | 示例 | 处理方式 |
|------|------|---------|
| 地址未对齐，size 很小 | addr=0x...d05, size=3 | 第一步拼接 3 字节，第二/三步不执行 |
| 地址对齐，size 很大 | addr=0x...d08, size=4096 | 第一步跳过，第二步循环 512 次，第三步可能执行 |
| 跨页读取 | addr 在页尾，size 跨越页边界 | ptrace 内核自动处理（读取目标进程虚拟内存，不限页边界） |
| size=0 | - | `end_addr == addr`，三步都跳过，直接返回 true |

**Counterfactual**:
> 如果要求调用者保证地址对齐，`process_read_data` 可以简化（去掉第一步和第三步）。但 Java 层的 `DebuggerBase.readBytes` 可能传入任意地址（用户请求读取任意内存），所以对齐处理不能省略。另一种方案是用 `process_vm_readv(2)`（Linux 3.2+），它支持任意地址对齐，但 SA 需要支持旧内核。

**性能影响**:
- 未对齐地址：额外 1 次 ptrace 调用（读取 aligned_addr 处的 word）+ 内存复制
- 最坏情况（size=1, addr 未对齐）：3 次 ptrace 调用（head + 1 word + tail），但实际只返回 1 字节

**源码引用**: `ps_proc.c:69-116`, `libproc_impl.h:56-58` (`align()` 宏), `man 2 ptrace` 的 `PTRACE_PEEKDATA` 部分

---

### 问题组 3: /proc/<pid>/maps 解析 vs libproc library iteration API

**问题**: `read_lib_info()` (`ps_proc.c:351-416`) 直接解析 `/proc/<pid>/maps` 文本文件，而不是使用 libproc 的 library iteration API（如 `libproc.h` 的 `get_num_libs`/`get_lib_name`）。为什么？

**答案方向** (≥10 行):

**`read_lib_info()` 的解析逻辑** (`ps_proc.c:351-416`):
1. `fopen("/proc/<pid>/maps", "r")` (line 356-357)
2. `fgets_no_cr()` 逐行读取 (line 363)
3. `split_n_str()` 按空格分割为最多 7 个字段 (line 365)
4. 检查 `nwords < 6` → 跳过（不是共享库条目）(line 367-370)
5. 检查 `word[5][0] == '['` → 跳过（ `[stack]`, `[heap]`, `[vdso]` 等）(line 374-377)
6. 检查 prelink 篡改（`.#prelink#` 关键字）(line 385-395)
7. `find_lib(ph, word[5])` 检查是否已添加 (line 397)
8. `sscanf(word[0], "%lx", &base)` 解析基址 (line 401-404)
9. `add_lib_info(ph, word[5], base)` 添加到链表 (line 405)

**为什么不用 libproc 的 API？**

`libproc.h` 中确实有 `get_num_libs()` / `get_lib_name()` / `get_lib_base()` API（line 77-92），但这些 API 是 **SA Java 层使用的**，不是 Native 层内部使用的。在 `Pgrab()` 执行期间，Java 层尚未启动，所以 Native 层必须自己解析 `/proc/<pid>/maps`。

**更深层的设计原因**:
1. **`/proc/<pid>/maps` 是最权威的来源**: 它直接反映内核的虚拟内存映射，不需要依赖其他库
2. **跨平台兼容性**: Solaris 的 `/proc/<pid>/map` 是二进制接口，Linux 是文本接口。直接解析 `/proc` 文件系统，避免依赖特定 libproc 版本
3. **prelink 处理**: `read_lib_info` 特殊处理了 prelink 篡改的库路径（line 385-395），这是 `/proc/<pid>/maps` 特有的问题

**Counterfactual**:
> 如果用 `dl_iterate_phdr()`（libc API）枚举共享库，可以避免解析 `/proc/<pid>/maps`。但 `dl_iterate_phdr` 需要目标进程的配合（调用方必须是目标进程），而 SA 是外部工具，无法调用目标进程的 `dl_iterate_phdr`。`/proc/<pid>/maps` 是 OS 提供的外部可见接口，适合调试器使用。

**量化对比**:

| 方案 | 优点 | 缺点 |
|------|------|------|
| 解析 `/proc/<pid>/maps` | 权威、跨进程可见、不需要目标配合 | 文本解析、prelink 处理复杂 |
| `dl_iterate_phdr()` | 结构化、不需要解析文本 | 只能在目标进程内调用 |
| `libelf` 遍历 PT_LOAD 段 | 结构化、跨平台 | 需要读取 ELF 文件，不能直接反映内存映射 |

**源码引用**: `ps_proc.c:351-416`, `libproc.h:77-95`, `man 5 proc` 的 `/proc/[pid]/maps` 部分

---

### 问题组 4: 线程扫描与 attach 的竞态处理

**问题**: `Pgrab()` 在 line 485-504 扫描 `/proc/<pid>/task/` 枚举线程，然后在 line 509-525 逐个 `ptrace_attach()`。如果线程在 `opendir` 和 `ptrace_attach` 之间退出（或被其他线程 detached），会怎样？SA 如何处理？

**答案方向** (≥12 行):

**竞态窗口分析**:

```
时间线：
T1: opendir("/proc/<pid>/task/")     ← 扫描开始
T2: readdir() → 发现 tid=12345
T3: [线程 12345 退出]                ← 竞态窗口！
T4: ptrace_attach(12345)             ← 附加到已退出的线程
```

**`ptrace_attach()` 的错误处理** (`ps_proc.c:275-306`):
1. 调用 `ptrace(PTRACE_ATTACH, pid)` (line 277)
2. 如果失败，检查 `errno == EPERM || errno == ESRCH` (line 278)
3. 如果是，调用 `process_doesnt_exist(pid)` 检查线程是否还存在 (line 280)
4. 如果 `process_doesnt_exist` 返回 true → 返回 `ATTACH_THREAD_DEAD` (line 282)

**`process_doesnt_exist()` 的实现** (`ps_proc.c:231-272`):
1. `sprintf(fname, "/proc/%d/status", pid)` (line 237)
2. `fopen(fname, "r")` (line 238)
3. 如果 `fp == NULL` → 假设线程不存在，返回 true (line 242)
4. 否则，查找 `State:` 行 (line 248)
5. 如果状态是 `X`（dead）或 `Z`（zombie）→ 返回 true (line 257-259)

**`Pgrab()` 中的处理** (`ps_proc.c:509-525`):
```c
while (thr) {
    thread_info* current_thr = thr;
    thr = thr->next;
    if (ph->pid != current_thr->lwp_id) {
      if ((attach_status = ptrace_attach(current_thr->lwp_id, ...)) != ATTACH_SUCCESS) {
        if (attach_status == ATTACH_THREAD_DEAD) {
          delete_thread_info(ph, current_thr);  // line 517: 从链表移除
        }
        else {
          Prelease(ph);  // line 520: 严重错误，释放整个 ph
          return NULL;
        }
      }
    }
}
```

**关键设计**: `ATTACH_THREAD_DEAD` 是**可恢复错误**（线程已退出，跳过即可），但 `ATTACH_FAIL` 是**不可恢复错误**（权限不足、未知错误等），需要 `Prelease(ph)` 清理所有资源。

**Counterfactual**:
> 如果在 `opendir` 之前先 `ptrace_attach(pid)`（主线程），然后扫描 `/proc/<pid>/task/`，可以减少竞态窗口（主线程已停止，线程退出需要 `PTRACE_DETACH`）。但 SA 的设计是**先 attach 主线程** → **读取库信息** → **再扫描线程**，这是因为读取库信息需要符号表，而符号表查找需要遍历 `lib_info` 链表（在 `read_lib_info` 中填充）。如果先扫描线程，此时 `lib_info` 链表还是空的。

**另一种竞态**: 线程在 `process_doesnt_exist()` 返回 false 后、 `ptrace_attach()` 调用前退出。此时 `ptrace_attach` 返回 `ESRCH`，`process_doesnt_exist()` 再次检查（在 `ptrace_attach` 内部）会返回 true。所以**双重检查**保证了竞态下的正确性。

**源码引用**: `ps_proc.c:231-272` (`process_doesnt_exist`), `ps_proc.c:275-306` (`ptrace_attach`), `ps_proc.c:485-525` (线程扫描 + attach), `man 2 ptrace` 的 ERRORS 部分（`ESRCH`）

---

### 问题组 5: PTRACE_PEEKDATA 的性能瓶颈与优化方向

**问题**: `process_read_data()` 每次调用 `ptrace(PTRACE_PEEKDATA)` 只读取 8 字节（1 word），导致读取大块内存时系统调用次数爆炸。量化分析这个瓶颈，并讨论优化方案（`process_vm_readv`、PageCache、批量预取）。

**答案方向** (≥12 行):

**性能量化** (读取不同大小的内存):

| 读取大小 | ptrace 调用次数 | 系统调用开销（估算） | 实际观测（参考） |
|---------|----------------|-------------------|----------------|
| 8 字节 | 1 次 | ~200 ns | ~1 μs |
| 128 字节 | 16 次 | ~3.2 μs | ~10 μs |
| 4 KB (1 页) | 512 次 | ~102 μs | ~500 μs - 1 ms |
| 16 KB (PageCache 行) | 2048 次 | ~409 μs | ~2-5 ms |
| 1 MB | 131072 次 | ~26 ms | ~100-500 ms |

**为什么这么慢？**
1. **每次 ptrace 是 1 次系统调用**: 用户态 → 内核态 → 用户态切换（~100-200 ns/次）
2. **内核需要处理 ptrace 请求**: 访问目标进程的页表、处理权限检查、复制内存
3. **无批量接口**: `PTRACE_PEEKDATA` 的 API 设计就是逐 word 读取（历史原因：Solaris 的 `/proc` 接口也是逐 word）

**优化方案对比**:

| 方案 | 原理 | 性能提升 | 兼容性 |
|------|------|---------|--------|
| `process_vm_readv(2)` | 1 次系统调用读取任意大小 | ~100x（1MB 读取从 500ms → 5ms） | Linux 3.2+（2012 年） |
| PageCache（Java 层） | 缓存 4KB 页，减少 `process_read_data` 调用 | ~10-50x（命中时 0 次 ptrace） | 全版本 |
| 预取（prefetch） | 提前读取相邻页到 PageCache | ~2-5x（减少冷启动开销） | 需要修改 Java 层 |
| `/proc/<pid>/mem` | `open("/proc/<pid>/mem") + pread` | ~50-100x（类似 core dump） | Linux 3.2+，需要 PTRACE_MODE_ATTACH |

**`process_vm_readv(2)` 的详细分析**:
```c
// 理想中的优化版本
ssize_t process_read_data_optimized(struct ps_prochandle* ph, uintptr_t addr, char *buf, size_t size) {
    struct iovec local_iov = { .iov_base = buf, .iov_len = size };
    struct iovec remote_iov = { .iov_base = (void*)addr, .iov_len = size };
    return process_vm_readv(ph->pid, &local_iov, 1, &remote_iov, 1, 0);
}
```
- **优点**: 1 次系统调用读取任意大小，内核内部批量复制
- **缺点**: 需要运行时检测内核版本（`uname()` 或 `syscall(__NR_process_vm_readv)` 失败回退）

**Counterfactual**:
> 如果 SA 在 2010 年设计时就要求 Linux 3.2+，`process_vm_readv` 会是默认选择。但 SA 需要支持 RHEL 6（Linux 2.6.32），所以只能用 `ptrace`。实际上，OpenJDK 社区有讨论添加 `process_vm_readv` 支持的 patch，但因为向后兼容性原因未被合并。

**PageCache 的局限性**:
- PageCache 在 **Java 层**（`DebuggerBase.java`），缓存粒度是 4KB 页
- 但 `process_read_data` **内部仍然是逐 word 读取**！PageCache 减少的是 `process_read_data` 的**调用次数**，而非每次调用内部的 ptrace 次数
- 如果读取模式是**随机的**（跨页访问），PageCache 命中率低，性能仍然很差

**源码引用**: `ps_proc.c:69-116` (`process_read_data`), `man 2 process_vm_readv`, `DebuggerBase.java` (PageCache 实现), `man 5 proc` 的 `/proc/[pid]/mem` 部分

---

### 问题组 6: Prelease() 的清理顺序与 use-after-free 风险

**问题**: `process_cleanup()` (`ps_proc.c:437-439`) 先调用 `detach_all_pids()` 再返回。但 `detach_all_pids()` 需要遍历 `ph->threads` 链表。如果先释放链表再 detach，会发生什么？为什么这个顺序很重要？

**答案方向** (≥10 行):

**`process_cleanup()` 的实现** (`ps_proc.c:437-439`):
```c
static void process_cleanup(struct ps_prochandle* ph) {
  detach_all_pids(ph);  // 先 detach
  // 注意：这里没有显式释放 lib_info/thread_info 链表！
  // 释放操作在 Prelease() 的调用者中（Java 层 JNI 代码）
}
```

**`detach_all_pids()` 的实现** (`ps_proc.c:429-435`):
```c
static void detach_all_pids(struct ps_prochandle* ph) {
  thread_info* thr = ph->threads;
  while (thr) {
     ptrace_detach(thr->lwp_id);  // line 432: 需要访问 thr->lwp_id
     thr = thr->next;              // line 433: 需要访问 thr->next
  }
}
```

**如果顺序反过来**（先释放链表，再 detach）:
```c
// 错误示例（不要这样写）
static void process_cleanup_wrong(struct ps_prochandle* ph) {
  // 先释放链表（假设有这个函数）
  free_thread_info_list(ph->threads);
  ph->threads = NULL;

  // 再 detach：但此时 ph->threads 已被释放！
  detach_all_pids(ph);  // ← use-after-free！访问已释放内存
}
```

**为什么 `process_cleanup` 不释放链表？**
- 链表的释放是在 **Java 层** 的 `Prelease()` JNI 实现中完成的（通过 `libproc_impl.c` 的 `free_lib_info_list` / `free_thread_info_list`）
- `process_cleanup()` 只负责 **Native 层的清理**（ptrace detach），链表释放由 Java 层的 JNI 代码协调

**`ptrace_detach()` 的实现** (`ps_proc.c:419-426`):
```c
static bool ptrace_detach(pid_t pid) {
  if (pid && ptrace(PTRACE_DETACH, pid, NULL, NULL) < 0) {
    print_debug("ptrace(PTRACE_DETACH, ..) failed for %d\n", pid);
    return false;
  } else {
    return true;
  }
}
```
- 如果 `pid == 0`（链表头节点？），跳过 detach
- 如果 `ptrace(PTRACE_DETACH)` 失败，只打印 debug 信息，**不返回错误**（因为清理阶段尽量做最多工作）

**Counterfactual**:
> 如果用 RAII（C++）管理 `ps_prochandle` 的资源，析构函数可以保证顺序：先 detach 所有 ptrace，再释放链表。但 `libsaproc` 是 C 代码，没有 RAII。所以必须**手工保证顺序**，这是一个常见的 C 代码 bug 来源。

**实际 bug 案例**:
- JDK-8239783: `Pgrab` 失败时没有正确清理已 attach 的线程，导致目标进程永久挂起（`PTRACE_DETACH` 未被调用）
- 修复：在 `ptrace_attach` 失败时，调用 `Prelease(ph)` 清理已 attach 的线程（`ps_proc.c:520-521`）

**源码引用**: `ps_proc.c:429-439` (`detach_all_pids` + `process_cleanup`), `ps_proc.c:419-426` (`ptrace_detach`), `ps_proc.c:520-521` (失败时的 `Prelease` 调用), `libproc_impl.c` (链表释放函数)

---

### 问题组 7（附加，可选）: process_get_lwp_regs() 的跨平台兼容层

**问题**: `process_get_lwp_regs()` (`ps_proc.c:125-165`) 用了大量 `#if defined` 条件编译来处理不同架构的 ptrace 寄存器读取接口。为什么 x86 和 sparc 的 `ptrace(PTRACE_GETREGS)` 参数顺序不同？`PTRACE_GETREGSET` 是如何统一这个差异的？

**答案方向** (≥10 行):

**x86 vs sparc 的参数差异** (`ps_proc.c:128-135`):
```c
// Linux on x86 and sparc are different.
// On x86 ptrace(PTRACE_GETREGS, ...) uses pointer from 4th argument and ignores 3rd argument.
// On sparc it uses pointer from 3rd argument and ignores 4th argument.
#if defined(sparc) || defined(sparcv9)
#define ptrace_getregs(request, pid, addr, data) ptrace(request, pid, addr, data)
#else
#define ptrace_getregs(request, pid, addr, data) ptrace(request, pid, data, addr)
#endif
```

**原因分析**:
- x86 的 `ptrace` 实现遵循 **syscall 约定**：`addr` 是 "address" 参数，`data` 是 "data" 参数。`PTRACE_GETREGS` 的 "data" 是用户空间缓冲区指针
- sparc 的 `ptrace` 实现把 "addr" 当作输出缓冲区指针（历史原因：SunOS 的 ptrace 接口设计）
- 这不是 Linux 内核的差异，而是 **glibc 的 ptrace wrapper** 在不同架构上的实现差异

**`PTRACE_GETREGSET` 的统一接口** (`ps_proc.c:151-159`):
```c
#elif defined(PTRACE_GETREGSET)
  struct iovec iov;
  iov.iov_base = user;
  iov.iov_len = sizeof(*user);
  if (ptrace(PTRACE_GETREGSET, pid, NT_PRSTATUS, (void*) &iov) < 0) {
    // 错误处理
  }
  return true;
```
- `PTRACE_GETREGSET`（Linux 2.6.34+）使用 `struct iovec` 传递缓冲区，避免了参数顺序差异
- `NT_PRSTATUS` 是 ELF note 类型，表示 "prstatus"（线程状态）

**优先级**（在 `ps_proc.c:137-163` 中）:
1. 优先使用 `PTRACE_GETREGS64`（64 位架构）
2. 否则使用 `PTRACE_GETREGS`
3. 否则使用 `PT_GETREGS`（BSD 兼容）
4. 否则使用 `PTRACE_GETREGSET`
5. 如果都不支持，打印 debug 信息并返回 false

**Counterfactual**:
> 如果所有架构都用 `PTRACE_GETREGSET`，条件编译可以简化。但 `PTRACE_GETREGSET` 是相对较新的接口（Linux 2.6.34, 2010 年），SA 需要支持旧内核（RHEL 5/6）。所以必须保留所有旧接口的兼容层。

**量化影响**:
- `PTRACE_GETREGS`: 1 次 ptrace 调用，读取所有通用寄存器（~50-100 字节，依赖架构）
- `PTRACE_GETREGSET`: 1 次 ptrace 调用，更灵活（可以只读取部分寄存器）

**源码引用**: `ps_proc.c:125-165`, `man 2 ptrace` 的 `PTRACE_GETREGS` / `PTRACE_GETREGSET` 部分, `man 3 ptrace` (glibc wrapper)

---

## §五 Article Structure

文档应按以下结构组织（## 表示一级章节，### 表示二级章节）：

```
# 01 Native 活进程调试（Live Mode）— ps_proc.c 深度解析

## §一 Pgrab() 完整流程：从 ptrace(ATTACH) 到 ps_prochandle 初始化
### 1.1 Pgrab() 函数签名与调用约定 [ps_proc.c:450-458]
### 1.2 第一步：ptrace_attach() 主线程 [ps_proc.c:461-467]
### 1.3 初始化 ps_prochandle：pid + ops vtable [ps_proc.c:470-474]
### 1.4 第二步：read_lib_info() 解析 /proc/<pid>/maps [ps_proc.c:479]
### 1.5 第三步：扫描 /proc/<pid>/task/ 枚举线程 [ps_proc.c:485-504]
### 1.6 第四步：逐个 ptrace_attach() 线程 [ps_proc.c:509-525]
### 1.7 Pgrab() 成功返回 ps_prochandle*

## §二 ptrace 信号交互协议深度分析
### 2.1 PTRACE_ATTACH 的内核行为：发送 SIGSTOP + 成为 tracer
### 2.2 ptrace_waitpid() 的实现：waitpid 循环 + 非 SIGSTOP 信号转发
### 2.3 __WALL 宏的必要性：处理 cloned 线程的 waitpid ECHILD 错误
### 2.4 ptrace_continue() 的作用：转发非 SIGSTOP 信号
### 2.5 信号交互时序图（ASCII art）

## §三 process_read_data() 内存读取深度分析
### 3.1 ptrace(PTRACE_PEEKDATA) 的系统调用语义
### 3.2 地址对齐处理：align() 宏 + head/tail 拼接算法
### 3.3 边界情况分析：跨页、尾部不足 word、size=0
### 3.4 性能量化：系统调用次数 vs 读取大小
### 3.5 与 process_vm_readv(2) 的对比（优化方向）

## §四 /proc/<pid>/maps 解析与库信息加载
### 4.1 /proc/<pid>/maps 文本格式详解 [man 5 proc]
### 4.2 read_lib_info() 解析逻辑：split_n_str + fgets_no_cr
### 4.3 prelink 处理：.#prelink# 关键字 + (deleted) 后缀
### 4.4 add_lib_info() 尾插链表 + symtab 构建
### 4.5 为什么不用 dl_iterate_phdr()？跨进程可见性分析

## §五 线程扫描与 attach 竞态处理
### 5.1 /proc/<pid>/task/ 扫描逻辑 [ps_proc.c:485-504]
### 5.2 process_doesnt_exist() 的实现：/proc/<pid>/status 解析
### 5.3 竞态窗口分析：opendir → readdir → ptrace_attach 之间的线程退出
### 5.4 ATTACH_THREAD_DEAD vs ATTACH_FAIL：可恢复 vs 不可恢复错误
### 5.5 delete_thread_info() 从链表移除已退出线程

## §六 process_get_lwp_regs() 跨平台兼容层
### 6.1 x86 vs sparc 的 ptrace(PTRACE_GETREGS) 参数顺序差异
### 6.2 ptrace_getregs 宏的统一接口
### 6.3 PTRACE_GETREGSET 的现代接口（struct iovec）
### 6.4 条件编译优先级：GETREGS64 → GETREGS → PT_GETREGS → GETREGSET
### 6.5 user_regs_struct 的跨平台定义（libproc.h:36-46）

## §七 Prelease() 清理与资源回收
### 7.1 process_cleanup() 的清理顺序：先 detach 再释放
### 7.2 detach_all_pids() 遍历 thread_info 链表
### 7.3 ptrace_detach() 的错误处理：打印 debug 但不返回错误
### 7.4 use-after-free 风险分析：为什么顺序很重要
### 7.5 JDK-8239783 bug 案例：Pgrab 失败时未清理已 attach 线程

## §八 边缘场景与诊断工具
### 8.1 ptrace 权限不足：CAP_SYS_PTRACE / /proc/sys/kernel/yama/ptrace_scope
### 8.2 目标进程退出：process_doesnt_exist() 的兜底
### 8.3 多线程 attach 竞态：双重检查 process_doesnt_exist()
### 8.4 诊断工具五件套：strace + jhsdb + jstack + GDB + /proc
### 8.5 用 GDB 验证 ptrace PEEKDATA 读取特定地址的值

## §九 总结：Live Mode 的设计权衡
### 9.1 ptrace 而非 process_vm_readv：旧内核支持
### 9.2 逐 word 读取而非批量读取：API 限制
### 9.3 PageCache 补偿：应用层缓存减少 ptrace 调用
### 9.4 C 而非 C++：与 Solaris libproc 的兼容性
### 9.5 只读而非读写：process_write_data() 空实现
```

---

## §六 Writing Requirements

### 6.1 总体原则

1. **源码是证据（20%），原理是正文（80%）**: 不要写成源码翻译，要解释"为什么这么设计"。例如：不要只贴 `ptrace_waitpid` 的代码，要解释为什么需要 `__WALL` 宏、为什么需要转发非 SIGSTOP 信号
2. **每个技术断言必须标注 file:line 引用**: 如 `ps_proc.c:178-223`、`man 2 ptrace` 的 `PTRACE_ATTACH` 部分
3. **量化对比优先**: 用表格/数字说明性能差距、内存占用、复杂度。例如：读取 4KB 需要 512 次 ptrace vs 1 次 process_vm_readv
4. **Counterfactual 讨论**: 每个设计决策都要讨论"如果选另一个方案会怎样"。例如：如果先释放链表再 detach 会怎样？
5. **时序图/示意图**: 用 ASCII art 绘制信号交互时序图、内存读取对齐示意图

### 6.2 "不要写成→应该写成"对照表

| 不要写成 | 应该写成 |
|---------|---------|
| 只贴 ptrace_attach 代码 | 解释 PTRACE_ATTACH 的内核行为（发送 SIGSTOP → 成为 tracer）+ waitpid 等待时序 + 信号转发逻辑 |
| 只说"process_read_data 处理对齐" | 分三步解释：head 拼接（未对齐部分）→ 逐 word 读取（对齐部分）→ tail 拼接（尾部不足 word），配示意图 |
| 只贴 /proc/<pid>/maps 示例行 | 解释每列的含义（地址范围/权限/偏移/设备/inode/路径名）+ SA 如何使用这些信息（基址 → symtab 查找） |
| 只说"ptrace 很慢" | 量化：读取 4KB 需要 512 次 ptrace 调用 vs 1 次 process_vm_readv，性能差距 50-100x，附系统调用开销分解 |
| 只说"检查线程是否存在" | 解释 process_doesnt_exist 的双重检查（fopen 失败 → 假设不存在；State: X/Z → 确定不存在）+ 竞态窗口分析 |
| 只贴代码不解释 | 每个代码块后跟 3-5 行解释：这段代码的意图、关键点、与前后文的关联 |
| 只说"详见 man 手册" | 具体引用 man 章节（如 `man 2 ptrace` 的 `PTRACE_PEEKDATA` 部分、`man 5 proc` 的 `/proc/[pid]/maps` 部分），并解释关键参数 |
| 只列函数调用链 | 用时序图（ASCII art）展示函数调用顺序 + 信号交互时序 |

### 6.3 源码阅读要求

1. **必须读源码**: 不要依赖 prompt 中的摘要，直接读 `ps_proc.c` / `libproc_impl.h` / `libproc.h`
2. **用 man 手册验证系统调用**: 遇到 `ptrace` / `waitpid` / `opendir` 等，立即 `man 2 ptrace` 查看详细参数和返回值
3. **追踪调用链**: 从 `Pgrab` → `ptrace_attach` → `ptrace_waitpid` → `process_read_data`，完整追踪调用链
4. **对比 Live/Postmortem 实现**: `ps_proc.c` vs `ps_core.c` 中的同名函数（通过 `ops` vtable 分派），本文档只关注 Live Mode
5. **理解条件编译**: `ps_proc.c:39-46` (x86_64 宏)、`ps_proc.c:131-163` (ptrace_getregs 条件编译)，解释为什么需要这些宏

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
// ps_proc.c:178-223

static attach_state_t ptrace_waitpid(pid_t pid) {
  int ret;
  int status;
  errno = 0;
  while (true) {
    ret = waitpid(pid, &status, 0);
    // ...
  }
}
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

### 7.6 时序图格式

使用 ASCII art 绘制信号交互时序图，例如：

```
SA (tracer)               目标 JVM (tracee)
    |                           |
    |-- ptrace(PTRACE_ATTACH) →|
    |                           |-- 收到 SIGSTOP
    |                           |-- 停止执行
    |← waitpid() 返回 ----------|
    |   (status = SIGSTOP)      |
    |                           |
    |-- ptrace(PTRACE_PEEKDATA) →|
    |← 返回 word ---------------|
    |                           |
    |-- ptrace(PTRACE_DETACH) →|
    |                           |-- 继续执行
```

---

## §八 Prohibited（≥10 条）

1. **禁止写成源码翻译**: 不要逐行解释代码，要提炼设计原理和权衡
2. **禁止遗漏 file:line 引用**: 每个技术断言必须标注源码位置（`ps_proc.c:178`）或 man 手册引用（`man 2 ptrace`）
3. **禁止只列结构体定义不解释**: 每个字段都要解释用途和在 Live Mode 中的行为
4. **禁止跳过 counterfactual 讨论**: §四 的每个问题组必须包含"如果选另一个方案会怎样"
5. **禁止在 §一 以外添加 Beginner Callout**: Callout 只能在 §一 内，避免重复
6. **禁止遗漏 man 手册引用**: 每个系统调用必须标注 `man 2 xxx` 或 `man 3 xxx` 或 `man 5 xxx`
7. **禁止写成科普文**: 本文档的目标读者是有 C 和 Linux 系统编程经验的工程师，不要解释"什么是指针"、"什么是 ptrace"
8. **禁止遗漏边缘场景**: §八 必须包含 ≥4 个边缘场景（ptrace 权限不足/目标进程退出/线程扫描竞态/prelink 篡改）
9. **禁止混淆 Live/Postmortem Mode**: 明确标注每个函数/数据结构的适用模式（本文档只关注 Live Mode）
10. **禁止遗漏性能量化**: §三 必须包含 `process_read_data` 的性能分析（系统调用次数 vs 读取大小）
11. **禁止遗漏时序图**: §二 必须包含 ptrace 信号交互的时序图（ASCII art）
12. **禁止遗漏 prelink 处理**: §四 必须解释 `read_lib_info` 中的 prelink 处理逻辑（line 385-395）

---

## §九 Required（≥10 条）

1. **必须包含 Pgrab() 完整流程**: 从 line 450 到 line 527，逐步解释每个函数调用
2. **必须包含 ptrace 信号交互协议分析**: `PTRACE_ATTACH` → `waitpid` → 信号转发 → `PTRACE_DETACH`，配时序图
3. **必须包含 process_read_data() 对齐处理的三步分析**: head 拼接 → 逐 word 读取 → tail 拼接，配示意图
4. **必须包含 /proc/<pid>/maps 解析详解**: 文本格式 + `read_lib_info` 解析逻辑 + prelink 处理
5. **必须包含线程扫描与 attach 竞态处理**: `process_doesnt_exist` 双重检查 + `ATTACH_THREAD_DEAD` 可恢复错误
6. **必须在 §四 包含 ≥7 个深度问题组**: 每组含 counterfactual 讨论 + 量化对比 + 源码引用
7. **必须解释 process_get_lwp_regs() 的跨平台兼容层**: x86 vs sparc 参数顺序差异 + `PTRACE_GETREGSET` 统一接口
8. **必须包含 Prelease() 清理顺序分析**: 先 detach 再释放的原因 + use-after-free 风险
9. **必须包含边缘场景 section**: ≥4 个场景（ptrace 权限不足/目标进程退出/线程扫描竞态/prelink 篡改）
10. **必须使用 man 手册验证系统调用**: `ptrace(2)`, `waitpid(2)`, `opendir(3)`, `proc(5)`
11. **必须包含诊断工具五件套**: `strace` + `jhsdb` + `jstack` + `GDB` + `/proc`
12. **必须解释 process_vm_readv(2) 优化方向**: 与 ptrace PEEKDATA 的量化对比 + 兼容性分析

---

## §十 GDB Verification（≥8 断言）

以下是可以通过 GDB 验证的断言（在 Live Mode 中验证）：

### 断言 1: ptrace(PTRACE_PEEKDATA) 每次读取 8 字节

```bash
# 附加到运行中的 JVM
gdb -p <pid>

# 在 process_read_data 中打断点
break process_read_data
run

# 单步执行，观察 ptrace(PTRACE_PEEKDATA) 的调用次数
# 对于 size=4096 的请求，应该调用 512 次 ptrace
```
**验证方法**: 使用 GDB 的 `display` 命令，每次停在 `ptrace` 调用时，打印 `aligned_addr` 和 `end_addr` 的差值。

### 断言 2: ptrace_waitpid() 正确等待 SIGSTOP

```bash
# 编写测试程序：附加到目标进程，在 ptrace_attach 后打印 waitpid 的返回值
# 验证 status 的 WSTOPSIG 是 SIGSTOP (信号编号 19)

break ptrace_waitpid
run

# 打印 status 的值
print status

# 验证 WIFSTOPPED(status) 为 true
print WIFSTOPPED(status)

# 验证 WSTOPSIG(status) == SIGSTOP
print WSTOPSIG(status)
# 期望: 19 (SIGSTOP 的信号编号)
```
**源码引用**: `ps_proc.c:190-197`

### 断言 3: process_read_data() 正确拼接未对齐地址

```bash
# 测试未对齐地址读取
# 在 process_read_data 中设置条件断点：当 addr % 8 != 0 时中断

break process_read_data if ((uintptr_t)addr % 8 != 0)
run

# 单步执行，观察 head 拼接逻辑 (line 75-87)
# 验证 buf 的前几个字节正确复制自 rslt 的对应偏移
```
**验证方法**: 在 GDB 中手动计算 `aligned_addr` 和 `addr` 的差值，验证 `ptr` 的偏移正确。

### 断言 4: read_lib_info() 正确解析 /proc/<pid>/maps

```bash
# 在 read_lib_info 中打断点
break read_lib_info

# 单步执行，打印解析出的库名和基址
print word[5]   # 库路径名
print base      # 基址

# 验证 lib_info 链表的正确性
print ph->libs->name
print ph->libs->base
```
**验证方法**: 对比 `/proc/<pid>/maps` 文件的内容和 `ph->libs` 链表的内容，验证一致性。

### 断言 5: process_doesnt_exist() 正确判断线程状态

```bash
# 创建一个多线程测试程序，让其中一个线程退出
# 在 process_doesnt_exist 中打断点

break process_doesnt_exist

# 传入一个已退出线程的 tid
# 验证函数返回 true

# 传入一个运行中线程的 tid
# 验证函数返回 false
```
**验证方法**: 手动读取 `/proc/<tid>/status` 文件，检查 `State:` 行的值。

### 断言 6: Prelease() 正确 detach 所有线程

```bash
# 在 process_cleanup 中打断点
break process_cleanup

# 单步执行 detach_all_pids
# 验证每个线程的 ptrace(PTRACE_DETACH) 被调用

# 验证 thread_info 链表在 detach 后仍然有效（没有被提前释放）
```
**验证方法**: 在 `detach_all_pids` 中打印 `thr->lwp_id`，验证所有线程都被遍历到。

### 断言 7: process_get_lwp_regs() 正确读取寄存器

```bash
# 在 process_get_lwp_regs 中打断点
break process_get_lwp_regs

# 验证 user_regs_struct 的内容
# 对于 x86_64，检查 rip/rsp/rbp 等寄存器的值是否合理

print user->rip    # 指令指针
print user->rsp    # 栈指针
```
**验证方法**: 对比 GDB 的 `info registers` 命令的输出，验证一致性。

### 断言 8: ptrace_attach() 正确处理 EPERM/ESRCH

```bash
# 测试权限不足场景：以普通用户附加到 root 进程
# 验证 ptrace_attach 返回 ATTACH_FAIL，且 err_buf 包含错误信息

# 测试线程退出场景：在 ptrace_attach 之前让线程退出
# 验证 ptrace_attach 返回 ATTACH_THREAD_DEAD
```
**验证方法**: 检查 `err_buf` 的内容，验证错误信息正确。

---

## §十一 与 README 和同组 prompt 的连续性

### 11.1 与 README 的关系

本文档是 Phase 20 的第 01 篇，对应 `probe_md/20-sa-postmortem/README.md` 中的：

- **§§ 01 - Native 活进程调试（Live Mode）** (`README.md` 对应章节)
- 核心内容：
  1. `Pgrab()` 完整流程
  2. `ptrace` 信号交互协议
  3. `process_read_data()` 内存读取
  4. `/proc/<pid>/maps` 解析
  5. 线程扫描与 attach 竞态
  6. `Prelease()` 清理顺序

**连续性保证**:
- 本文档依赖 prompt-00 的 `ps_prochandle` 核心数据结构解释（§三）
- 本文档详细展开 prompt-00 中简略提到的 `process_read_data` 原理（prompt-00 §四 问题组 2）
- 本文档是后续 prompt-02（Postmortem Mode）的对比基准

### 11.2 与同组 prompt 的关系

| Prompt | 文件 | 与本文档的关系 |
|--------|------|---------------|
| prompt-00 | SA 架构 + 核心数据结构 | 本文档依赖其 §三 的核心数据结构解释 |
| prompt-01 (本文档) | Live Debugging (ps_proc.c) | 详细分析 Live Mode 实现 |
| prompt-02 | Postmortem Debugging (ps_core.c) | 对比 Live Mode：相同的 `ps_prochandle_ops` vtable，不同的实现 |
| prompt-03 | JNI Bridge + Symbol (LinuxDebuggerLocal.c + symtab.c) | 依赖本文档的 `process_read_data` 解释（Java 层如何调用 Native 层） |
| prompt-04 | SA Bootstrap (HotSpotAgent.java + TypeDataBase) | 依赖本文档的 `Pgrab` 解释（Java 层如何触发 Live Mode） |
| prompt-05 | Tools Pipeline (jstack/jmap/jinfo) | 依赖本文档的 Live Mode 流程（工具如何使用 SA） |

### 11.3 避免重复

- **不与 prompt-00 重复**: prompt-00 解释核心数据结构（§三），本文档解释这些数据结构在 Live Mode 中的使用流程
- **不与 prompt-02 重复**: 本文档只关注 Live Mode（`ps_proc.c`），不展开 Postmortem Mode（`ps_core.c`）的实现
- **不与 prompt-03 重复**: 本文档只解释 Native 层的 `process_read_data`，不展开 Java 层的 JNI 桥接逻辑（那是 prompt-03 的内容）

---

## §十二 质量自检清单

写完文档后，逐项检查：

- [ ] §四 深度问题组 ≥7 组，每组含 counterfactual
- [ ] §八 Prohibited ≥10 条
- [ ] §九 Required ≥10 条
- [ ] §十 Verification ≥8 断言
- [ ] §四 答案方向 ≥8 行（随机抽取 3 个问题组验证）
- [ ] Beginner Callout ≥7 个，且只在 §一 内
- [ ] man 手册引用覆盖所有核心 syscall（`ptrace(2)`, `waitpid(2)`, `opendir(3)`, `proc(5)`）
- [ ] 独立的边缘场景 section ≥4 场景
- [ ] §二 有 syscall/二进制/全局状态表
- [ ] 标题格式 `# 01-Native-Live-Debugging — ps_proc.c 深度解析`
- [ ] 运行 `rg '^## §' file.md` 验证连续无跳号
- [ ] 总行数 ≥450 行（目标是 2500-3500 行）
- [ ] 包含 ptrace 信号交互时序图（ASCII art）
- [ ] 包含 process_read_data 对齐处理示意图
- [ ] 性能量化表格（§三 或 §四 问题组 5）

---

## 附录 A: 关键源码位置速查

| 符号 | 文件:行号 | 说明 |
|------|----------|------|
| `Pgrab` | `ps_proc.c:450-527` | Live Mode 入口，attach 到目标进程 |
| `ptrace_attach` | `ps_proc.c:275-306` | 单个 pid 的 attach，含错误处理 |
| `ptrace_waitpid` | `ps_proc.c:178-223` | 等待 SIGSTOP，处理信号转发 |
| `ptrace_continue` | `ps_proc.c:167-174` | 转发非 SIGSTOP 信号 |
| `process_read_data` | `ps_proc.c:69-116` | 通过 ptrace PEEKDATA 读取内存 |
| `process_write_data` | `ps_proc.c:119-122` | 空实现（Live Mode 只读） |
| `process_get_lwp_regs` | `ps_proc.c:125-165` | 读取线程寄存器（跨平台兼容层） |
| `process_doesnt_exist` | `ps_proc.c:231-272` | 检查线程是否还存在 |
| `read_lib_info` | `ps_proc.c:351-416` | 解析 /proc/<pid>/maps |
| `ptrace_detach` | `ps_proc.c:419-426` | detach 单个 pid |
| `detach_all_pids` | `ps_proc.c:429-435` | 遍历链表 detach 所有线程 |
| `process_cleanup` | `ps_proc.c:437-439` | 清理函数（ops->release） |
| `process_ops` | `ps_proc.c:441-446` | Live Mode 的 vtable（4 个函数指针） |
| `attach_state_t` | `ps_proc.c:50-54` | ptrace_attach 返回值三态枚举（SUCCESS/FAIL/THREAD_DEAD） |
| `split_n_str` | `ps_proc.c:318-336` | 原地字符串分割（read_lib_info 辅助函数） |
| `fgets_no_cr` | `ps_proc.c:341-347` | 读取一行并去掉换行符 |
| `align` | `ps_proc.c:56-58` | 地址对齐计算（static inline 函数） |
| `ps_prochandle` | `libproc_impl.h:94-103` | 核心数据结构 |
| `ps_prochandle_ops` | `libproc_impl.h:64-75` | vtable |
| `lib_info` | `libproc_impl.h:38-44` | 共享库链表节点 |
| `thread_info` | `libproc_impl.h:47-51` | 线程链表节点 |

---

## 附录 B: 相关 man 手册章节

| 手册页 | 章节 | 关键部分 |
|--------|------|---------|
| `man 2 ptrace` | 2 | PTRACE_ATTACH, PTRACE_DETACH, PTRACE_PEEKDATA, PTRACE_GETREGS, PTRACE_GETREGSET |
| `man 2 waitpid` | 2 | WIFSTOPPED, WSTOPSIG, __WALL |
| `man 3 opendir` | 3 | 打开目录流 |
| `man 3 readdir` | 3 | 读取目录项 |
| `man 3 fopen` | 3 | 打开文件（用于 /proc 文件） |
| `man 3 fgets` | 3 | 逐行读取（用于解析 /proc 文件） |
| `man 5 proc` | 5 | /proc/[pid]/maps, /proc/[pid]/status, /proc/[pid]/task/ |
| `man 2 process_vm_readv` | 2 | 批量读取进程内存（优化方向） |
| `man 7 signal` | 7 | SIGSTOP 信号语义 |

---

**END OF PROMPT**
