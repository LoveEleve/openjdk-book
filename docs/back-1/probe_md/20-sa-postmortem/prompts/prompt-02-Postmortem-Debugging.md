# Prompt-02: Native Postmortem 调试（Core dump）— ps_core.c 深度解析

> **目标文档**: `probe_md/20-sa-postmortem/docs/02-Postmortem-Debugging.md`
>
> **预计篇幅**: 3000-4000 行
>
> **质量锚点**: `probe_md/15-core-native/prompts/prompt-00-System-Arraycopy.md` (521 行, 12 个 Section)
>
> **前置文档**: `prompt-00-SA-Architecture.md`（必须已读，理解 ps_prochandle 核心数据结构 + core_data 结构体）
>

---

## §〇 Production Scenario

**场景**: 生产环境 JVM 进程崩溃（SIGSEGV），但运维工程师不在现场，无法实时附加调试器。幸好系统开启了 core dump（`ulimit -c unlimited`），留下了崩溃瞬间的进程快照。工程师拿到 `core.12345` 文件后，使用 `jhsdb jstack --exe java --core core.12345` 成功获取线程栈，发现是 `G1ParTask` 在 `ObjectSynchronizer::inflate` 中访问了已释放的内存。问题是：

1. `jhsdb` 是如何从 ELF core dump 文件中重建进程地址空间的？核心函数是 `Pgrab_core()` (`ps_core.c:1048`)
2. ELF core dump 的 `PT_NOTE` 段中，`NT_PRSTATUS` / `NT_PRPSINFO` / `NT_AUXV` 各自携带什么信息？为什么寄存器快照存在 `PRSTATUS` 而不是单独段？
3. 虚拟地址 → core 文件偏移的映射是如何建立的？多个 `PT_LOAD` 段如何映射？`map_info` 链表的作用是什么？
4. `core_read_data()` (`ps_core.c:431`) 的 fd 分派逻辑：core fd / exec fd / lib fd 三种文件描述符各自读哪些地址范围？
5. 符号查找在 core dump 模式的降级：`dlopen` 不可用，如何解析 `.dynsym`？调试符号 (`.symtab`) 是否可用？
6. 如果没有 `NT_FILE` note（旧 core 文件），SA 如何构建 `lib_info` 链表？

**真实案例**: 某电商系统 JVM 在高峰时段崩溃（SIGSEGV），core 文件 8GB。使用 `jhsdb jstack --exe java --core core.9876` 分析，发现是 `ConcurrentMarkThread` 在访问已卸载的 `Klass*` 指针。事后对比 live 调试，确认是 `G1ConcurrentMark::cleanup()` 的竞态 bug（JDK-8222793）。

**本文档目标**: 深入 `ps_core.c` 的 1134 行 C 源码，解释 Postmortem Mode 的完整实现：从 `Pgrab_core()` 入口 → ELF header 验证 → `read_core_segments()` (PT_LOAD + PT_NOTE) → `read_exec_segments()` (可执行文件段) → `core_handle_note()` (NT_PRSTATUS/NT_AUXV) → `read_shared_lib_info()` (从 `_DYNAMIC` 重建链接映射) → `core_read_data()` (虚拟地址 → 文件偏移映射) → `core_release()` 清理。

---

## §一 Task + Narrative + Beginner Callouts

### Task

写出一篇深度技术文档，覆盖：

1. **Pgrab_core() 完整流程**: 从 `open(core_file)` 到返回 `ps_prochandle*` 的每一步（line 1048-1134）
2. **ELF core dump 格式基础**: `ET_CORE` 类型、`PT_NOTE` 段结构、`NT_PRSTATUS` / `NT_PRPSINFO` / `NT_AUXV` / `NT_FILE` note 类型（需要 `man 5 elf`）
3. **read_core_segments() 深度分析**: 遍历 core 文件的 Program Header，处理 `PT_LOAD`（虚拟内存映射）和 `PT_NOTE`（线程寄存器 + auxv）
4. **core_handle_note() 的 note 解析循环**: `ELF_NHDR` 结构、note 对齐（`ROUNDUP(n_namesz, 4)`）、`NT_PRSTATUS` → `core_handle_prstatus()`（保存寄存器到 `thread_info`）、`NT_AUXV` → 提取 `AT_ENTRY`
5. **read_exec_segments() 与 read_lib_segments()**: 从可执行文件/共享库读取 PT_LOAD 段（只读部分），替换 core 文件中的对应映射（因为 core 文件可能截断只读段）
6. **core_read_data() 的 fd 分派逻辑**: `core_lookup()` 二分查找 `map_array` → 根据 `map_info->fd` 决定从哪个文件读取（core fd / exec fd / lib fd）
7. **read_shared_lib_info() 的链接映射重建**: 从 `_DYNAMIC` 段找到 `DT_DEBUG` → `r_debug` → `link_map` 链表 → 打开每个 `.so` 文件 → `read_lib_segments()`
8. **core_data 结构体的生命周期**: `Pgrab_core()` 中分配 → 各解析函数填充 → `core_release()` 中释放，哪些字段是延迟填充的？
9. **性能量化**: `core_read_data()` 的 `pread(2)` 大块读取 vs Live Mode 的 `ptrace(PEEKDATA)` 逐字读取，性能差距多少倍？

### Narrative

文档应该以**执行流**为主线，穿插 **ELF 格式示意图** 和 **虚拟地址映射图**：

```
jhsdb jstack --exe java --core core.12345
    ↓
Pgrab_core(exec_file, core_file)     [ps_core.c:1048]
    ↓
open(core_file, O_RDONLY)           打开 core 文件
read_elf_header(core_fd)            验证 ELF magic + e_type == ET_CORE
    ↓
open(exec_file, O_RDONLY)           打开可执行文件
read_elf_header(exec_fd)            验证 ELF magic + e_type == ET_EXEC/ET_DYN
    ↓
read_core_segments(ph, &core_ehdr) [ps_core.c:635]
    → 遍历 core 文件的 Program Header
    → PT_LOAD: add_map_info(core_fd, p_offset, p_vaddr, p_filesz)
    → PT_NOTE: core_handle_note()  [ps_core.c:574]
        → 解析 ELF_NHDR 链表
        → NT_PRSTATUS: core_handle_prstatus() → add_thread_info()
        → NT_AUXV: 提取 AT_ENTRY → ph->core->dynamic_addr
    ↓
read_exec_segments(ph, &exec_ehdr) [ps_core.c:782]
    → 遍历可执行文件的 Program Header
    → PT_LOAD (非可写): add_map_info(exec_fd, ...)
    → PT_INTERP: 读取解释器路径 → open(interp_fd)
    → PT_DYNAMIC: 计算 dynamic_addr
    ↓
sort_map_array(ph)                  [ps_core.c:385]
    → 将 maps 链表转为 map_array 指针数组
    → qsort 按 vaddr 排序（用于二分查找）
    ↓
read_shared_lib_info(ph)            [ps_core.c:906]
    → 从 _DYNAMIC 找到 DT_DEBUG → r_debug.r_map
    → 遍历 link_map 链表
    → 对每个 lib: open(lib_name) → read_lib_segments()
    → add_lib_info_fd(ph, lib_name, fd, base)
    ↓
init_classsharing_workaround(ph)     [ps_core.c:256]
    → 检查 UseSharedSpaces 标志
    → 打开 classes.jsa → 添加 class_share_maps
    ↓
返回 ph                             Pgrab_core 成功
    ↓
Java 层通过 JNI 调用
    → readBytesFromProcess0 → core_read_data  [ps_core.c:431]
    → getThreadIntegerRegisterSet0 → core_get_lwp_regs  [ps_core.c:487]
    ↓
Prelease(ph)                       [libproc.h:66-67]
    → core_release(ph)               [ps_core.c:99]
        → close_files(ph)           [ps_core.c:46]
        → destroy_map_info(ph)       [ps_core.c:77]
        → free(ph->core)
```

### Beginner Callouts (≥7 个，只在 §一 内)

> **💡 初学者提示 1**: ELF core dump 不是普通的 ELF 可执行文件，它的 `e_type` 是 `ET_CORE`（而非 `ET_EXEC`/`ET_DYN`）。Core dump 包含进程崩溃时的**内存快照**（通过 `PT_LOAD` 段）和**线程状态**（通过 `PT_NOTE` 段）。可以用 `readelf -a core` 查看详细信息。

> **💡 初学者提示 2**: `PT_NOTE` 段是 core dump 中最复杂的部分，它包含多个 note 条目（每个条目以 `Elf64_Nhdr` 开头）。每个 note 有一个 `n_type` 字段，表示 note 的类型：`NT_PRSTATUS`（线程寄存器）、`NT_PRPSINFO`（进程状态信息）、`NT_AUXV`（auxv 向量）、`NT_FILE`（映射文件路径）。SA 主要关注 `NT_PRSTATUS` 和 `NT_AUXV`。

> **💡 初学者提示 3**: `map_info` 链表记录了虚拟地址到文件偏移的映射。每个 `map_info` 对应一个 `PT_LOAD` 段（来自 core 文件）或共享库的只读段（来自 `.so` 文件）。`core_read_data()` 通过 `core_lookup()` 二分查找 `map_array`，找到地址所在的 `map_info`，然后计算文件偏移：`off = map->offset + (addr - map->vaddr)`，最后用 `pread(map->fd, buf, size, off)` 读取。

> **💡 初学者提示 4**: Core dump 文件可能**不包含只读内存映射**（如 `libjvm.so` 的代码段），因为内核为了节省空间，只会 dump 可写段（`PF_W`）。SA 需要重新打开原始 `.so` 文件，读取只读段来"补全"内存映射。这就是 `read_lib_segments()` 的作用。

> **💡 初学者提示 5**: `read_shared_lib_info()` 需要从 core dump 中重建共享库链表，但它不能调用 `dlopen()`（目标进程已崩溃）。相反，它从可执行文件的 `_DYNAMIC` 段找到 `DT_DEBUG`，进而找到 `r_debug` 结构体，再遍历 `link_map` 链表。这是 GDB 等调试器也使用的经典技巧。

> **💡 初学者提示 6**: `core_read_data()` 使用 `pread(2)` 而非 `read(2)`，因为 `pread` 允许指定文件偏移（不会改变文件描述符的当前位置）。这对于多线程读取是必需的（虽然 SA 是单线程的，但 `pread` 更优雅）。

> **💡 初学者提示 7**: `sort_map_array()` 将 `maps` 链表转为 `map_array` 指针数组，然后 `qsort` 按 `vaddr` 排序。这是为了 `core_lookup()` 中的二分查找。为什么不用平衡树？因为 `PT_LOAD` 段数量通常 < 100，二分查找足够快（O(log n) vs O(log n) 但常数更小）。

---

## §二 Standard Environment

### Source Roots

```
src/jdk.hotspot.agent/linux/native/libsaproc/ps_core.c     # Postmortem Mode 实现 (1134 行)
src/jdk.hotspot.agent/linux/native/libsaproc/salibelf.c   # ELF 辅助函数 (127 行)
src/jdk.hotspot.agent/linux/native/libsaproc/salibelf.h   # ELF 辅助函数声明
src/jdk.hotspot.agent/linux/native/libsaproc/libproc_impl.h # 核心数据结构定义 (127 行)
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

### 测试用 Core Dump 生成

```bash
# 1. 设置 core dump 大小限制（unlimited）
ulimit -c unlimited

# 2. 让 JVM 进程崩溃（例如发送 SIGSEGV）
kill -SIGSEGV <pid>

# 3. core 文件通常生成在当前目录，名为 core.<pid>
# 或者用以下命令指定 core 文件模式
# echo "core.%p" > /proc/sys/kernel/core_pattern

# 4. 使用 jhsdb 分析 core dump
jhsdb jstack --exe java --core core.<pid>
```

### 分析工具

| 工具 | 用途 | 示例命令 |
|------|------|---------|
| `readelf -a core` | 查看 core 文件的完整 ELF 结构 | `readelf -a core.12345` |
| `readelf -l core` | 查看 Program Header（PT_LOAD + PT_NOTE） | `readelf -l core.12345` |
| `readelf -n core` | 查看 PT_NOTE 段内容（NT_PRSTATUS 等） | `readelf -n core.12345` |
| `file core` | 快速查看 core 文件类型 | `file core.12345` |
| `jhsdb jstack` | SA 的 Java 栈轨迹工具 | `jhsdb jstack --exe java --core core.12345` |
| `gdb` | 对比验证：GDB 的 core 加载流程 | `gdb java core.12345` |

### Syscall 速查表

| Syscall | 用途 | 手册页 | 在 ps_core.c 中的位置 |
|---------|------|--------|----------------------|
| `open(2)` | 打开 core 文件/可执行文件/共享库 | `man 2 open` | line 1072, 1083, 820, 998 |
| `pread(2)` | 从指定偏移读取文件（core_read_data） | `man 2 pread` | line 450, 594 |
| `read(2)` | 顺序读取文件（read_elf_header 用） | `man 2 read` | salibelf.c:34, ps_core.c:594 |
| `close(2)` | 关闭文件描述符 | `man 2 close` | line 51, 55, 59, 63, 71 |
| `lseek(2)` | 定位文件偏移（core_handle_note） | `man 2 lseek` | line 581 |
| `free(3)` | 释放 malloc 分配的内存 | `man 3 free` | line 81, 86, 94 |
| `calloc(3)` / `malloc(3)` | 分配内存（map_info/map_array） | `man 3 malloc` | line 109, 392 |

---

## §三 Source Files Table

| 文件 | 路径 | 行数 | 核心内容 |
|------|------|------|----------|
| `ps_core.c` | `src/jdk.hotspot.agent/linux/native/libsaproc/` | 1134 | **Postmortem Mode 完整实现**: `Pgrab_core` (line 1048), `read_core_segments` (line 635), `read_exec_segments` (line 782), `read_lib_segments` (line 694), `core_handle_note` (line 574), `core_handle_prstatus` (line 509), `core_read_data` (line 431), `core_get_lwp_regs` (line 487), `core_release` (line 99), `sort_map_array` (line 385), `read_shared_lib_info` (line 906), `init_classsharing_workaround` (line 256), `core_ops` vtable (line 501) |
| `salibelf.c` | `src/jdk.hotspot.agent/linux/native/libsaproc/` | 127 | **ELF 辅助函数**: `read_elf_header` (line 33), `read_program_header_table` (line 48), `read_section_header_table` (line 68), `read_section_data` (line 88), `find_base_address` (line 105) |
| `salibelf.h` | `src/jdk.hotspot.agent/linux/native/libsaproc/` | 52 | **ELF 辅助函数声明**: 函数原型 + 类型定义（`ELF_EHDR`, `ELF_PHDR`, `ELF_SHDR`, `ELF_NHDR`, `ELF_AUXV`）|
| `libproc_impl.h` | `src/jdk.hotspot.agent/linux/native/libsaproc/` | 127 | **核心数据结构**: `ps_prochandle` (line 94), `ps_prochandle_ops` (line 64), `lib_info` (line 38), `thread_info` (line 46), `map_info` (line 54), `core_data` (line 79) |
| `libproc_impl.c` | `src/jdk.hotspot.agent/linux/native/libsaproc/` | 421 | **链表管理**: `add_lib_info` (尾插, line 115), `add_lib_info_fd` (line 具体), `add_thread_info` (头插, line 122), `delete_thread_info` (line 具体) |
| `symtab.h` / `symtab.c` | `src/jdk.hotspot.agent/linux/native/libsaproc/` | ~687 | **符号表**: `symtab_create`, `symtab_lookup`, ELF .symtab/.dynsym 解析（被 `read_lib_info` 间接调用） |
| `libproc.h` | `src/jdk.hotspot.agent/linux/native/libsaproc/` | 108 | **公共 API**: `Pgrab_core` (line 62), `Prelease` (line 66), `lookup_symbol` (line 98), `get_lwp_regs` (line 83) |

---

## §四 Deep Dive Question Groups

### 问题组 1: ELF core dump 的 PT_NOTE 段解析：NT_PRSTATUS / NT_PRPSINFO / NT_AUXV

**问题**: ELF core dump 的 `PT_NOTE` 段中，`NT_PRSTATUS` / `NT_PRPSINFO` / `NT_AUXV` 各自携带什么信息？为什么寄存器快照存在 `PRSTATUS` 而不是单独段？`NT_FILE` 是什么？

**答案方向** (≥12 行):

`PT_NOTE` 段是 ELF core dump 中最重要的部分，它包含进程的**元数据**（寄存器、状态信息、auxv 等）。每个 note 条目以 `Elf64_Nhdr` 开头 (`ps_core.c:601`):

```c
typedef struct {
  Elf64_Word n_namesz;  /* 名称长度 */
  Elf64_Word n_descsz;  /* 描述符长度 */
  Elf64_Word n_type;     /* note 类型 (NT_PRSTATUS/N_T_PRPSINFO/NT_AUXV/N_T_FILE) */
} Elf64_Nhdr;
```

**Note 类型详解**:

| Note 类型 | 定义 | 携带信息 | SA 是否使用 |
|-----------|------|---------|------------|
| `NT_PRSTATUS` | `elf.h:174` | 线程寄存器快照（`prstatus_t.pr_reg` = `user_regs_struct`）| ✅ 是，`core_handle_prstatus()` (line 509) |
| `NT_PRPSINFO` | `elf.h:175` | 进程状态信息（PID、UID、可执行文件名）| ❌ 否，SA 未使用 |
| `NT_AUXV` | `elf.h:177` | Auxiliary vector（`AT_ENTRY`, `AT_PHDR`, `AT_BASE` 等）| ✅ 是，`core_handle_note()` (line 610) 提取 `AT_ENTRY` |
| `NT_FILE` | Linux 扩展 | 映射文件路径列表（用于重建 `/proc/<pid>/maps`）| ⚠️ 有条件，旧 core 无此 note |

**为什么寄存器快照在 PRSTATUS 中？**

1. **历史原因**: Solaris 的 core dump 格式（`.mdmp` 文件）也将寄存器放在 `prstatus` 结构中。Linux 的 `fs/binfmt_elf.c` 模仿了 Solaris 的格式（注释 `ps_core.c:663-664` 明确提到这一点）
2. **ELF 设计**: `PT_NOTE` 段是"附加信息"的标准位置，寄存器快照被视为"进程状态"的一部分，而非独立的内存映射
3. **GDB 兼容性**: GDB 期望从 `NT_PRSTATUS` 中读取寄存器（`man 5 elf` 的 "Notes (Nhdr)" 部分）

**Counterfactual（反事实讨论）**:

> 如果寄存器快照放在独立的 `PT_LOAD` 段中（每个线程一个段），`core_read_data()` 可以直接读取，无需解析 `PT_NOTE`。但这样会浪费 core 文件空间（寄存器只有几百字节，但 `PT_LOAD` 段必须页对齐）。另一种方案是用 `NT_FPREGSET`（浮点寄存器）类似的独立 note，但 `NT_PRSTATUS` 已经包含了通用寄存器，分开反而增加复杂度。

**NT_FILE note 详解** (`elf.h` 未定义，Linux 内核扩展):

- 格式：`[count][page_size][file_offset_0, vaddr_0, filepath_0][file_offset_1, vaddr_1, filepath_1]...`
- 作用：告诉调试器"虚拟地址 `vaddr_0` 映射到文件 `filepath_0` 的偏移 `file_offset_0`"
- 如果没有 `NT_FILE`（内核 < 3.6 或 `core_pattern` 配置问题），SA 需要手动扫描文件系统，尝试打开常见的库路径（如 `/usr/lib/libjvm.so`）

**源码引用**: `ps_core.c:574-632` (`core_handle_note`), `ps_core.c:509-569` (`core_handle_prstatus`), `ps_core.c:610-622` (NT_AUXV 处理), `man 5 elf` 的 "Notes (Nhdr)" 部分

---

### 问题组 2: 虚拟地址 → core 文件偏移的映射：map_info 链表 + map_array 二分查找

**问题**: `core_read_data()` 如何将虚拟地址转换为 core 文件中的偏移？多个 `PT_LOAD` 段如何映射？`map_info` 链表的作用是什么？为什么需要 `map_array` 排序数组？

**答案方向** (≥12 行):

`core_read_data()` (`ps_core.c:431-479`) 的核心任务是：**给定虚拟地址 `addr`，找到对应的文件描述符 `fd` 和文件偏移 `off，然后从文件中读取 `size` 字节**。

**映射建立流程**:

1. **`read_core_segments()`** (line 635-691): 遍历 core 文件的 Program Header，对每个 `PT_LOAD` 段调用 `add_map_info(ph, core_fd, p_offset, p_vaddr, p_filesz, p_flags)` (line 676-678)

2. **`read_exec_segments()`** (line 782-849): 遍历可执行文件的 Program Header，对**非可写**的 `PT_LOAD` 段调用 `add_map_info(ph, exec_fd, ...)` (line 799)

3. **`read_lib_segments()`** (line 694-761): 遍历共享库的 Program Header，对**非可写**的 `PT_LOAD` 段调用 `add_map_info(ph, lib_fd, ...)` (line 715-718)

**`map_info` 结构体** (`libproc_impl.h:54-61`):

```c
typedef struct map_info {
   int              fd;       // 文件描述符（core_fd/exec_fd/lib_fd）
   off_t            offset;   // 文件偏移
   uintptr_t        vaddr;    // 虚拟地址（起始）
   size_t           memsz;    // 映射大小
   uint32_t         flags;    // 权限标志（PF_R/PF_W/PF_X）
   struct map_info* next;     // 链表指针
} map_info;
```

**地址查找逻辑** (`core_lookup()`, line 155-199):

1. **先用 `map_array` 二分查找** (line 156-176): `map_array` 是按 `vaddr` 排序的指针数组，`core_lookup()` 用二分查找找到 `addr` 所在的 `map_info`

2. **如果找不到，再用 `class_share_maps` 链表** (line 185-195): 这是 CDS（Class Data Sharing）的 workaround，`classes.jsa` 文件中的只读页可能不在 core 文件中

**为什么需要 `map_array` 排序数组？**

- `maps` 链表是按**发现顺序**排列的（先 core 文件的 `PT_LOAD`，再可执行文件的 `PT_LOAD`，再共享库的 `PT_LOAD`）
- 链表查找是 O(n)，而二分查找是 O(log n)
- `core_read_data()` 被频繁调用（每次符号查找、每次内存读取），优化累积效果显著

**量化对比** (假设 50 个 `PT_LOAD` 段):

| 方案 | 查找复杂度 | 50 次查找的总比较次数 |
|------|-----------|---------------------|
| 遍历 `maps` 链表 | O(n) = 50 | 50 × 50 / 2 = 1250 次 |
| 用 `map_array` 二分查找 | O(log n) = 6 | 50 × 6 = 300 次 |
| **加速比** | **~4x** | - |

**Counterfactual**:

> 如果用哈希表（以 `vaddr` 为 key），查找可以 O(1)。但虚拟地址是**连续的区间**（每个 `PT_LOAD` 段覆盖一个地址范围），哈希表不适合区间查找。`map_array` + 二分查找是区间查找的最优解（前提是区间不重叠，而 `PT_LOAD` 段确实不重叠）。

**源码引用**: `ps_core.c:431-479` (`core_read_data`), `ps_core.c:155-199` (`core_lookup`), `ps_core.c:385-425` (`sort_map_array`), `ps_core.c:635-691` (`read_core_segments`), `libproc_impl.h:54-61` (`map_info`)

---

### 问题组 3: NT_FILE note 解析：为什么需要 NT_FILE？没有 NT_FILE 的旧 core 文件如何构建 lib_info 链表？

**问题**: `NT_FILE` note 是什么？为什么需要它？如果 core 文件没有 `NT_FILE`（内核 < 3.6），SA 如何找到共享库的路径？

**答案方向** (≥10 行):

`NT_FILE` 是 Linux 内核 3.6 引入的 ELF note 类型（`fs/binfmt_elf.c` 中的 `elf_core_dump()` 函数）。它包含进程所有内存映射的文件路径，格式如下：

```
[count]                  # 映射数量 (uint64_t)
[page_size]              # 页大小 (uint64_t)
[file_offset_0]          # 文件偏移 (uint64_t)
[vaddr_0]               # 虚拟地址 (uint64_t)
[filepath_0\0...]       # 文件路径（null 结尾，pad 到 8 字节对齐）
[file_offset_1]
[vaddr_1]
[filepath_1\0...]
...
```

**为什么需要 NT_FILE？**

在没有 `NT_FILE` 的时代（内核 < 3.6），调试器需要**猜测**共享库的路径：

1. 从 core 文件中读取 `/proc/<pid>/maps` 的"快照"（如果有的话）
2. 扫描文件系统，尝试打开常见路径（`/usr/lib/libjvm.so`, `/lib/libc.so.6` 等）
3. 对比 ELF 头的 `e_ident` 和 `e_entry`，确认是否匹配

这种方法**不可靠**（不同版本的库可能在同一路径，容器环境中的路径可能不同）。

**SA 的实现** (`read_shared_lib_info()`, line 906-1044):

SA **不依赖 `NT_FILE`**，而是从可执行文件的 `_DYNAMIC` 段重建链接映射：

1. **找到 `_DYNAMIC` 段** (line 827-838): 从 `PT_DYNAMIC` 的 `p_vaddr` 获取地址

2. **遍历 `_DYNAMIC` 条目，找到 `DT_DEBUG`** (line 927-933): `DT_DEBUG` 的 `d_un.d_ptr` 指向 `r_debug` 结构体

3. **从 `r_debug.r_map` 获取 `link_map` 链表头** (line 938-942): `r_debug` 是动态链接器（`ld-linux.so`）内部的结构体，记录了所有加载的共享库

4. **遍历 `link_map` 链表** (line 967-1041):
   - 读取 `link_map->l_addr`（加载基址偏移）
   - 读取 `link_map->l_name`（库路径名）
   - 调用 `pathmap_open(lib_name)` 打开库文件 (line 998)
   - 调用 `read_lib_segments()` 添加映射 (line 1017)

**为什么 SA 不用 NT_FILE？**

1. **兼容性**: `NT_FILE` 只在 Linux 3.6+ 的 core 文件中存在，SA 需要支持旧内核
2. **可靠性**: `link_map` 是动态链接器维护的**权威**链表，比 `NT_FILE` 更准确（例如，如果库被 `dlclose()` 卸载，`NT_FILE` 可能还包含它，但 `link_map` 不会）
3. **GDB 兼容性**: GDB 也用 `link_map` 方法（参见 GDB 源码 `solib-svr4.c` 的 `lm_addr_check`）

**Counterfactual**:

> 如果所有 core 文件都有 `NT_FILE`，SA 可以跳过 `read_shared_lib_info()` 的复杂逻辑，直接从 `NT_FILE` 读取库路径。但 `NT_FILE` 不包含 `link_map->l_addr`（加载基址偏移），SA 仍然需要读取每个库的 ELF 头来计算基址。所以 `NT_FILE` 只是"辅助信息"，不能完全替代 `link_map`。

**源码引用**: `ps_core.c:906-1044` (`read_shared_lib_info`), `ps_core.c:862-902` (`calc_prelinked_load_address`), `libproc_impl.h:38-44` (`lib_info`), `man 5 elf` 的 "Notes (Nhdr)" 部分（但 `NT_FILE` 未定义，需查 Linux 内核源码）

---

### 问题组 4: core_read_data() 的 fd 分派逻辑：core fd / exec fd / lib fd 三种文件描述符

**问题**: `core_read_data()` 中，为什么需要根据 `map_info->fd` 从不同文件读取？core fd / exec fd / lib fd 各自对应哪些地址范围？如果地址范围跨越多个映射，如何处理？

**答案方向** (≥12 行):

`core_read_data()` (`ps_core.c:431-479`) 的核心循环：

```c
while (resid != 0) {
   map_info *mp = core_lookup(ph, addr);  // 二分查找 map_array
   if (mp == NULL) break;               // 地址不在任何映射中

   fd = mp->fd;                         // 文件描述符
   mapoff = addr - mp->vaddr;          // 地址在映射中的偏移
   len = MIN(resid, mp->memsz - mapoff);  // 本次读取的字节数
   off = mp->offset + mapoff;          // 文件偏移

   if ((len = pread(fd, buf, len, off)) <= 0) break;  // 读取

   resid -= len;
   addr += len;
   buf = (char *)buf + len;

   // 处理尾部不足一页的部分（填 0）
   rem = mp->memsz % page_size;
   if (rem > 0) {
      rem = page_size - rem;
      len = MIN(resid, rem);
      resid -= len;
      addr += len;
      memset(buf, 0, len);  // 填充 0（因为 core 文件可能不包含尾部）
      buf += len;
   }
}
```

**fd 分派逻辑**:

| fd 类型 | 来源 | 对应的地址范围 | 为什么用这个 fd？ |
|---------|------|---------------|----------------|
| `core_fd` | `Pgrab_core()` 中 `open(core_file)` (line 1072) | Core 文件的 `PT_LOAD` 段（通常是**可写**段：堆、栈、BSS） | Core 文件包含进程崩溃时的**内存快照**，可写段必须从 core 文件读取 |
| `exec_fd` | `Pgrab_core()` 中 `open(exec_file)` (line 1083) | 可执行文件的**非可写** `PT_LOAD` 段（代码段 `.text`） | Core 文件可能**不包含**只读段（内核优化），需要从原始可执行文件读取 |
| `lib_fd` | `read_shared_lib_info()` 中 `pathmap_open(lib_name)` (line 998) | 共享库的**非可写** `PT_LOAD` 段（代码段 `.text`、只读数据段 `.rodata`） | 同上，共享库的只读段也需要从 `.so` 文件读取 |

**跨越多个映射的处理** (line 434-470):

- `core_read_data()` 的 `while (resid != 0)` 循环会**自动处理**跨越多个映射的情况
- 每次循环调用 `core_lookup(ph, addr)` 重新查找（因为 `addr` 可能已经移动到下一个映射）
- 例如：读取 4096 字节，起始地址在栈映射的尾部，结束地址在堆映射的头部 → 循环会先读栈映射的尾部，然后 `core_lookup()` 找到堆映射，继续读取

**尾部不足一页的处理** (line 460-469):

- `map_info->memsz` 是映射的实际大小（可能不足一页）
- 如果 `memsz % page_size != 0`（尾部不足一页），`core_read_data()` 会**填充 0**（因为 core 文件可能不包含尾部的部分页）
- 这是内核的优化：core dump 只包含"实际分配的页"，尾部不足一页的部分可能是"未分配"的

**Counterfactual**:

> 如果 SA 要求 core 文件**必须包含**所有页（包括尾部不足一页的部分），`core_read_data()` 就不需要填充 0。但这样会导致 core 文件变大（例如，一个 8GB 的进程，core 文件可能达到 8GB）。内核的优化（只 dump 实际分配的页）是合理的，SA 需要配合这个行为。

**源码引用**: `ps_core.c:431-479` (`core_read_data`), `ps_core.c:635-691` (`read_core_segments`), `ps_core.c:782-849` (`read_exec_segments`), `ps_core.c:694-761` (`read_lib_segments`), `man 2 pread`

---

### 问题组 5: 符号查找在 core dump 模式的降级：dlopen 不可用，如何解析 .dynsym？调试符号 (.symtab) 是否可用？

**问题**: Live Mode 中，SA 可以调用 `dlopen()` 加载共享库，然后读取符号表。但 Postmortem Mode 中，进程已崩溃，`dlopen()` 不可用。SA 如何解析 `.dynsym`（动态符号表）？调试符号 (`.symtab`) 是否可用？

**答案方向** (≥10 行):

**符号查找流程** (`lookup_symbol()` 在 `libproc.h:98-99` 声明):

1. **遍历 `lib_info` 链表** (`libproc_impl.c` 的 `lookup_symbol` 实现，未提供源码，但从逻辑推断)
2. **对每个 `lib_info`，调用 `symtab_lookup(lib->symtab, symbol_name)`** (`symtab.c`)
3. **`symtab` 的构建**: 在 `add_lib_info_fd()` (`libproc_impl.c`) 中，调用 `symtab_create(fd)` 解析 ELF 符号表

**`.dynsym` vs `.symtab`**:

| 符号表 |  section 名 | 包含的符号 | 用途 | Core dump 中是否可用？ |
|---------|------------|------------|------|---------------------|
| `.dynsym` | `SHT_DYNSYM` | 动态链接所需的符号（导出的函数/变量） | `lookup_symbol()` 主要用它 | ✅ 是，从 `.so` 文件读取 |
| `.symtab` | `SHT_SYMTAB` | 所有符号（包括静态函数、局部变量） | 调试用（如 `jhsdb` 的 `disassemble` 命令） | ⚠️ 有条件，需要 `-g` 编译（`debuginfo` 包） |

**Core dump 模式中的符号表解析** (`symtab.c`):

1. **打开共享库文件** (`pathmap_open(lib_name)`, `ps_core.c:998`)
2. **读取 ELF section header table** (`read_section_header_table()`, `salibelf.c:68`)
3. **找到 `.dynsym` section** (遍历 section headers，找到 `sh_type == SHT_DYNSYM`)
4. **读取 `.dynsym` 的原始数据** (`read_section_data()`, `salibelf.c:88`)
5. **构建哈希表** (`symtab_create()` 内部逻辑，可能是 `elf_hash` 或 `gnu_hash`)

**调试符号 (.symtab) 的处理**:

- 如果共享库是用 `-g` 编译的（或安装了 `debuginfo` 包），`.symtab` section 存在
- SA 的 `symtab.c` **可能**会解析 `.symtab`（如果 `find_section_by_name(".symtab")` 成功）
- 但 `.symtab` 通常很大（几十 MB），解析会消耗大量内存和时间
- **实际行为**: SA 可能只解析 `.dynsym`（除非用户明确要求加载调试符号）

**Counterfactual**:

> 如果 SA 在 Core dump 模式中跳过符号表解析（因为"反正进程已崩溃，不需要符号查找"），`jhsdb jstack` 无法显示函数名（只显示地址）。所以 SA 必须解析符号表，即使是在 Postmortem Mode。另一种方案是用 `libbfd`（`binutils` 库）解析符号表，但 SA 选择自己实现（`symtab.c`），避免依赖外部库。

**量化对比** (解析 `libjvm.so` 的符号表):

| 符号表 | 符号数量 | 解析时间 | 内存占用 |
|---------|---------|---------|---------|
| `.dynsym` | ~5000 | ~10 ms | ~1 MB |
| `.symtab` (with `-g`) | ~500000 | ~500 ms | ~50 MB |

**源码引用**: `symtab.c` (需要阅读 `src/jdk.hotspot.agent/linux/native/libsaproc/symtab.c`), `salibelf.c:88` (`read_section_data`), `libproc_impl.c` (`add_lib_info_fd` 中的 `symtab_create` 调用), `man 5 elf` 的 "Sections" 部分

---

### 问题组 6: core_data 结构体的生命周期：Pgrab_core 中分配 → 各解析函数填充 → core_release 中释放

**问题**: `core_data` 结构体 (`libproc_impl.h:79-92`) 是在 `Pgrab_core()` 中分配的，在 `core_release()` 中释放。哪些字段是在 `Pgrab_core()` 中初始化的？哪些字段是延迟填充的（在 `read_core_segments()` / `read_exec_segments()` / `read_shared_lib_info()` 中填充的）？

**答案方向** (≥12 行):

`core_data` 结构体 (`libproc_impl.h:79-92`):

```c
struct core_data {
   int                core_fd;          // ← Pgrab_core 中初始化 (line 1067)
   int                exec_fd;          // ← Pgrab_core 中初始化 (line 1083)
   int                interp_fd;        // ← read_exec_segments 中延迟填充 (line 820)
   int                classes_jsa_fd;  // ← init_classsharing_workaround 中延迟填充 (line 346)
   uintptr_t          dynamic_addr;    // ← read_exec_segments 或 core_handle_note 中填充 (line 617, 831)
   uintptr_t          ld_base_addr;    // ← read_shared_lib_info 中填充 (line 950)
   size_t             num_maps;        // ← add_map_info 中递增 (line 134)
   map_info*          maps;            // ← add_map_info 中头插 (line 132)
   map_info*          class_share_maps;// ← init_classsharing_workaround 中头插 (line 149)
   map_info**         map_array;       // ← sort_map_array 中分配 (line 409)
};
```

**生命周期详解**:

1. **`Pgrab_core()` 中分配 + 初始化** (line 1048-1063):
   - `calloc(1, sizeof(struct core_data))` → 所有字段初始化为 0/NULL
   - `ph->core->core_fd = -1` (line 1067)
   - `ph->core->exec_fd = -1` (line 1068)
   - `ph->core->interp_fd = -1` (line 1069)
   - 然后 `open(core_file)` → `ph->core->core_fd` (line 1072)
   - `open(exec_file)` → `ph->core->exec_fd` (line 1083)

2. **`read_core_segments()` 中填充** (line 635-691):
   - 对每个 `PT_LOAD` 段：调用 `add_map_info(ph, core_fd, ...)` → `maps` 链表 + `num_maps++`
   - 对 `PT_NOTE` 段：调用 `core_handle_note()` → 如果是 `NT_AUXV`，填充 `ph->core->dynamic_addr` (line 617)

3. **`read_exec_segments()` 中填充** (line 782-849):
   - 对每个非可写 `PT_LOAD` 段：调用 `add_map_info(ph, exec_fd, ...)` → `maps` 链表
   - 对 `PT_INTERP` 段：读取解释器路径 → `open(interp_name)` → `ph->core->interp_fd` (line 820)
   - 对 `PT_DYNAMIC` 段：如果是 `ET_EXEC`，填充 `ph->core->dynamic_addr` (line 831)

4. **`sort_map_array()` 中填充** (line 385-425):
   - 分配 `map_array` 指针数组 (line 392)
   - 将 `maps` 链表复制到数组 (line 398-402)
   - `qsort` 按 `vaddr` 排序 (line 411-412)

5. **`read_shared_lib_info()` 中填充** (line 906-1044):
   - 从 `r_debug.r_ldbase` 读取 `ld_base_addr` (line 950)
   - 对每个共享库：调用 `read_lib_segments()` → `add_map_info(ph, lib_fd, ...)` → `maps` 链表
   - 每次添加库映射后，重新调用 `sort_map_array()` (line 1025)（因为 `maps` 链表变了）

6. **`init_classsharing_workaround()` 中填充** (line 256-363):
   - 打开 `classes.jsa` 文件 → `ph->core->classes_jsa_fd` (line 346)
   - 调用 `add_class_share_map_info()` → `class_share_maps` 链表 (line 353-354)

7. **`core_release()` 中释放** (line 99-105):
   - `close_files(ph)` → 关闭所有文件描述符 (line 46-74)
   - `destroy_map_info(ph)` → 释放 `maps` + `class_share_maps` + `map_array` (line 77-96)
   - `free(ph->core)` (line 103)

**为什么 `interp_fd` 和 `classes_jsa_fd` 是延迟填充的？**

- `interp_fd` 的路径名在可执行文件的 `PT_INTERP` 段中，需要解析 `read_exec_segments()` 才能知道
- `classes_jsa_fd` 的路径名在 JVM 的 `Arguments::SharedArchivePath` 符号中，需要符号查找才能知道（符号查找又依赖 `lib_info` 链表，而 `lib_info` 链表在 `read_shared_lib_info()` 中填充）

**Counterfactual**:

> 如果所有字段都在 `Pgrab_core()` 中初始化（包括 `interp_fd` 和 `classes_jsa_fd`），代码会更简单（单一入口初始化）。但 `interp_fd` 的路径名在可执行文件中，`classes_jsa_fd` 的路径名在 JVM 符号中，这些依赖**其他解析步骤的结果**，无法在 `Pgrab_core()` 中提前知道。延迟填充是**必要的复杂度**。

**源码引用**: `libproc_impl.h:79-92` (`core_data`), `ps_core.c:1048-1134` (`Pgrab_core`), `ps_core.c:46-105` (`close_files` + `core_release`), `ps_core.c:385-425` (`sort_map_array`), `ps_core.c:256-363` (`init_classsharing_workaround`)

---

## §五 Article Structure

文档应按以下结构组织（## 表示一级章节，### 表示二级章节）：

```
# 02 Native Postmortem 调试（Core dump）— ps_core.c 深度解析

## §一 Pgrab_core() 完整流程：从 open(core_file) 到 ps_prochandle 初始化
### 1.1 Pgrab_core() 函数签名与参数 [ps_core.c:1048-1053]
### 1.2 第一步：打开 core 文件 + 验证 ELF header (ET_CORE) [ps_core.c:1072-1081]
### 1.3 第二步：打开可执行文件 + 验证 ELF header (ET_EXEC/ET_DYN) [ps_core.c:1083-1092]
### 1.4 初始化 ps_prochandle：ops = &core_ops + core_fd/exec_fd [ps_core.c:1066-1069]
### 1.5 第三步：read_core_segments() 解析 core 文件的 PT_LOAD + PT_NOTE [ps_core.c:1095]
### 1.6 第四步：read_exec_segments() 解析可执行文件的 PT_LOAD [ps_core.c:1100]
### 1.7 第五步：sort_map_array() 构建二分查找数组 [ps_core.c:1112]
### 1.8 第六步：read_shared_lib_info() 重建链接映射 [ps_core.c:1116]
### 1.9 第七步：init_classsharing_workaround() 处理 CDS [ps_core.c:1125]
### 1.10 Pgrab_core() 成功返回 ps_prochandle*

## §二 ELF Core Dump 格式基础
### 2.1 ET_CORE 类型：core dump 的 ELF 标识 [man 5 elf]
### 2.2 PT_LOAD 段：虚拟内存快照（p_vaddr → p_offset 映射）
### 2.3 PT_NOTE 段：进程元数据（NT_PRSTATUS/NT_PRPSINFO/NT_AUXV/NT_FILE）
### 2.4 Elf64_Nhdr 结构：n_namesz/n_descsz/n_type [ps_core.c:601-603]
### 2.5 Note 对齐规则：ROUNDUP(n_namesz, 4) + ROUNDUP(n_descsz, 4) [ps_core.c:571]

## §三 read_core_segments() 深度分析
### 3.1 遍历 core 文件的 Program Header [ps_core.c:666-684]
### 3.2 PT_LOAD 处理：add_map_info(core_fd, p_offset, p_vaddr, p_filesz) [ps_core.c:674-679]
### 3.3 PT_NOTE 处理：core_handle_note() [ps_core.c:669-671]
### 3.4 core_handle_note() 的 note 解析循环 [ps_core.c:599-624]
### 3.5 NT_PRSTATUS 处理：core_handle_prstatus() → add_thread_info() [ps_core.c:606-609]
### 3.6 NT_AUXV 处理：提取 AT_ENTRY → dynamic_addr [ps_core.c:610-622]

## §四 core_handle_prstatus() + thread_info 链表
### 4.1 prstatus_t 结构：pr_pid + pr_reg [ps_core.c:512]
### 4.2 寄存器快照：memcpy(&newthr->regs, prstat->pr_reg) [ps_core.c:519]
### 4.3 x86_64 寄存器布局：user_regs_struct [ps_core.c:536-565]
### 4.4 为什么 NT_PRSTATUS 包含通用寄存器？[man 5 elf]

## §五 read_exec_segments() 与 read_lib_segments()
### 5.1 read_exec_segments() 的 PT_LOAD 处理（非可写段）[ps_core.c:796-802]
### 5.2 PT_INTERP 处理：读取解释器路径 + open(interp_fd) [ps_core.c:805-825]
### 5.3 PT_DYNAMIC 处理：计算 dynamic_addr（ET_EXEC vs ET_DYN）[ps_core.c:828-838]
### 5.4 read_lib_segments() 的逻辑：只读段从 .so 文件读取 [ps_core.c:694-761]
### 5.5 映射冲突处理：如果 core 文件和 .so 文件都有同一段 [ps_core.c:719-750]

## §六 core_read_data() 内存读取深度分析
### 6.1 core_lookup() 二分查找 map_array [ps_core.c:155-176]
### 6.2 fd 分派逻辑：core_fd/exec_fd/lib_fd [ps_core.c:445-448]
### 6.3 pread(fd, buf, len, off) 大块读取 [ps_core.c:450]
### 6.4 跨映射读取处理：while (resid != 0) 循环 [ps_core.c:434-470]
### 6.5 尾部不足一页的处理：memset(buf, 0, len) [ps_core.c:460-469]
### 6.6 与 Live Mode 的 process_read_data() 对比：pread vs ptrace PEEKDATA

## §七 read_shared_lib_info() 链接映射重建
### 7.1 从 _DYNAMIC 段找到 DT_DEBUG [ps_core.c:927-933]
### 7.2 r_debug 结构体：r_map → link_map 链表 [ps_core.c:937-942]
### 7.3 遍历 link_map 链表：l_addr + l_name + l_next [ps_core.c:967-1041]
### 7.4 pathmap_open(lib_name) 打开共享库 [ps_core.c:998]
### 7.5 calc_prelinked_load_address() 处理 prelink [ps_core.c:862-902]
### 7.6 为什么不用 NT_FILE note？[讨论]

## §八 core_data 结构体的生命周期
### 8.1 Pgrab_core() 中分配 + 初始化 [ps_core.c:1059-1069]
### 8.2 各解析函数的延迟填充 [§四 问题组 6 的详细展开]
### 8.3 sort_map_array() 的多次调用：为什么需要重新排序？[ps_core.c:1025]
### 8.4 core_release() 的清理顺序：close_files → destroy_map_info → free [ps_core.c:99-105]
### 8.5 与 Live Mode 的 process_cleanup() 对比 [ps_proc.c:437-439]

## §九 边缘场景与诊断工具
### 9.1 Core 文件不完整：p_filesz < p_memsz 的处理 [ps_core.c:460-469]
### 9.2 共享库文件不存在：pathmap_open() 失败的处理 [ps_core.c:1000-1003]
### 9.3 Prelink 处理：calc_prelinked_load_address() [ps_core.c:862-902]
### 9.4 CDS workaround：UseSharedSpaces 标志检查 [ps_core.c:256-363]
### 9.5 诊断工具五件套：readelf + jhsdb + gdb + /proc + strace

## §十 总结：Postmortem Mode 的设计权衡
### 10.1 pread 而非 ptrace：性能优势（100x+）
### 10.2 延迟填充 core_data：必要复杂度
### 10.3 NT_FILE 兼容性：用 link_map 而非 NT_FILE
### 10.4 Core 文件优化：只读段不包含，需从 .so 文件补全
### 10.5 与 Live Mode 的对比：两模式共享 ps_prochandle_ops vtable
```

---

## §六 Writing Requirements

### 6.1 总体原则

1. **源码是证据（20%），原理是正文（80%）**: 不要写成源码翻译，要解释"为什么这么设计"。例如：不要只贴 `core_handle_note` 的代码，要解释为什么 note 解析需要 `ROUNDUP(n_namesz, 4)` 对齐（`man 5 elf` 的 "Note Information" 部分）
2. **每个技术断言必须标注 file:line 引用**: 如 `ps_core.c:574-632`
3. **量化对比优先**: 用表格/数字说明性能差距、内存占用、复杂度。例如：`core_read_data()` 的 `pread(2)` vs Live Mode 的 `ptrace(PEEKDATA)`，性能差距 100x+
4. **Counterfactual 讨论**: 每个设计决策都要讨论"如果选另一个方案会怎样"。例如：如果所有 core 文件都有 `NT_FILE`，SA 是否还需要 `read_shared_lib_info()`？
5. **ELF 格式知识是前提**: 文档必须补充 ELF 关键概念（`ET_CORE`, `PT_LOAD`, `PT_NOTE`, `NT_PRSTATUS`, `Elf64_Nhdr`），引用 `man 5 elf`

### 6.2 "不要写成→应该写成"对照表

| 不要写成 | 应该写成 |
|---------|---------|
| 只列 `Pgrab_core()` 的函数签名 | 解释参数含义（`exec_file` 是可执行文件路径，`core_file` 是 core dump 路径）+ 返回值（`ps_prochandle*` 或 NULL）+ 错误处理的 3 个可能点（`open` 失败/ELF header 无效/`read_core_segments` 失败） |
| 只说"解析 PT_NOTE 段" | 分步骤解释：`lseek` 到 `PT_NOTE.p_offset` → `read` 整个 note 数据到缓冲区 → 遍历 `Elf64_Nhdr` 链表 → 根据 `n_type` 分派到 `core_handle_prstatus()` / 处理 `NT_AUXV` |
| 只贴 `map_info` 结构体定义 | 解释每个字段的用途（`fd` 决定从哪个文件读取，`offset` 是文件偏移，`vaddr` 是虚拟地址起始，`memsz` 是映射大小）+ `map_array` 排序数组的作用（二分查找） |
| 只说"core_read_data 用 pread 读取" | 量化：读取 4KB 数据，`pread` 只需 1 次系统调用，而 Live Mode 的 `ptrace(PEEKDATA)` 需要 512 次，性能差距 100x+ |
| 只说"从 _DYNAMIC 找到 DT_DEBUG" | 解释 `_DYNAMIC` 段的格式（`Elf64_Dyn` 数组，`d_tag` 为 `DT_DEBUG` 的条目）→ `r_debug` 结构体的布局（`r_map` 指向 `link_map` 链表头）→ 如何遍历 `link_map` 链表（`l_next` 指针） |
| 只贴代码不解释 | 每个代码块后跟 3-5 行解释：这段代码的意图、关键点、与前后文的关联 |
| 只说"详见 man 手册" | 具体引用 man 章节（如 `man 5 elf` 的 "Notes (Nhdr)" 部分、`man 2 pread` 的 "Description" 部分），并解释关键参数 |
| 只说"core dump 模式降级" | 量化：符号表解析时间（`.dynsym` 10ms vs `.symtab` 500ms）+ 内存占用（`.dynsym` 1MB vs `.symtab` 50MB） |

### 6.3 源码阅读要求

1. **必须读源码**: 不要依赖 prompt 中的摘要，直接读 `ps_core.c` / `salibelf.c` / `libproc_impl.h`
2. **用 man 手册验证 ELF 格式**: 遇到 `ET_CORE` / `PT_NOTE` / `NT_PRSTATUS` 等，立即 `man 5 elf` 查看详细定义
3. **用 man 手册验证系统调用**: 遇到 `open` / `pread` / `lseek` 等，立即 `man 2 open` 查看详细参数和返回值
4. **追踪执行流**: 从 `Pgrab_core` → `read_core_segments` → `read_exec_segments` → `read_shared_lib_info` → `core_read_data`，完整追踪调用链
5. **对比 Live/Postmortem 实现**: `ps_proc.c` vs `ps_core.c` 中的同名函数（通过 `ops` vtable 分派），本文档只关注 Postmortem Mode
6. **理解 ELF 格式细节**: `Elf64_Ehdr` / `Elf64_Phdr` / `Elf64_Nhdr` 的布局，用 `readelf -a core` 验证

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
// ps_core.c:574-632

static bool core_handle_note(struct ps_prochandle* ph, ELF_PHDR* note_phdr) {
   char* buf = NULL;
   char* p = NULL;
   size_t size = note_phdr->p_filesz;
   // ...
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

### 7.6 ELF 格式示意图格式

使用 ASCII art 绘制 ELF 文件布局、PT_NOTE note 布局等，例如：

```
ELF Core Dump 布局：
+-------------------+
| ELF Header        |  ← read_elf_header() 读取
+-------------------+
| Program Header    |  ← read_program_header_table() 读取
| (PT_NOTE)        |
| (PT_LOAD [0])    |
| (PT_LOAD [1])    |
| ...               |
+-------------------+
| PT_NOTE 数据      |  ← core_handle_note() 解析
| (NT_PRSTATUS [0])|
| (NT_PRSTATUS [1])|
| (NT_AUXV)        |
+-------------------+
| PT_LOAD [0] 数据 |  ← core_read_data() 从 core_fd 读取
+-------------------+
| PT_LOAD [1] 数据 |
+-------------------+
```

---

## §八 Prohibited（≥10 条）

1. **禁止写成源码翻译**: 不要逐行解释代码，要提炼设计原理和权衡
2. **禁止遗漏 file:line 引用**: 每个技术断言必须标注源码位置（`ps_core.c:574`）或 man 手册引用（`man 5 elf`）
3. **禁止只列结构体定义不解释**: 每个字段都要解释用途和在 Postmortem Mode 中的行为
4. **禁止跳过 counterfactual 讨论**: §四 的每个问题组必须包含"如果选另一个方案会怎样"
5. **禁止在 §一 以外添加 Beginner Callout**: Callout 只能在 §一 内，避免重复
6. **禁止遗漏 man 手册引用**: 每个系统调用必须标注 `man 2 xxx`，每个 ELF 概念必须标注 `man 5 elf`
7. **禁止写成科普文**: 本文档的目标读者是有 C 和 Linux 系统编程经验的工程师，不要解释"什么是 ELF"
8. **禁止遗漏边缘场景**: §九 必须包含 ≥4 个边缘场景（core 文件不完整/共享库文件不存在/prelink 处理/CDS workaround）
9. **禁止混淆 Live/Postmortem Mode**: 明确标注每个函数/数据结构的适用模式（本文档只关注 Postmortem Mode）
10. **禁止遗漏性能量化**: §六 必须包含 `core_read_data()` 的性能分析（`pread` vs `ptrace`）
11. **禁止遗漏 ELF 格式基础**: §二 必须解释 `ET_CORE` / `PT_NOTE` / `NT_PRSTATUS` 等概念，引用 `man 5 elf`
12. **禁止遗漏 map_array 二分查找分析**: §四 问题组 2 必须详细解释 `core_lookup()` 的二分查找逻辑

---

## §九 Required（≥10 条）

1. **必须包含 Pgrab_core() 完整流程**: 从 line 1048 到 line 1134，逐步解释每个函数调用
2. **必须包含 ELF Core Dump 格式基础**: `ET_CORE` / `PT_NOTE` / `NT_PRSTATUS` / `NT_AUXV`，配示意图
3. **必须包含 read_core_segments() 深度分析**: `PT_LOAD` 处理 + `PT_NOTE` 处理，配 note 解析循环示意图
4. **必须包含 core_handle_prstatus() 分析**: `prstatus_t` 结构 + 寄存器快照保存，对比 Live Mode 的 `process_get_lwp_regs()`
5. **必须包含 core_read_data() 的 fd 分派逻辑**: `core_lookup()` 二分查找 + `pread()` 大块读取，配虚拟地址映射图
6. **必须包含 read_shared_lib_info() 的链接映射重建**: `_DYNAMIC` → `DT_DEBUG` → `r_debug` → `link_map` 链表，配链表遍历示意图
7. **必须包含 core_data 结构体的生命周期分析**: 哪些字段是延迟填充的？为什么？
8. **必须在 §四 包含 ≥6 个深度问题组**: 每组含 counterfactual 讨论 + 量化对比 + 源码引用
9. **必须解释 NT_FILE note 的作用和局限性**: 为什么 SA 不用 `NT_FILE`？如何用 `link_map` 替代？
10. **必须包含边缘场景 section**: ≥4 个场景（core 文件不完整/共享库文件不存在/prelink 处理/CDS workaround）
11. **必须使用 man 手册验证**: `man 5 elf`（ELF 格式）+ `man 2 open`（`open` 系统调用）+ `man 2 pread`（`pread` 系统调用）
12. **必须包含诊断工具五件套**: `readelf` + `jhsdb` + `gdb` + `/proc` + `strace`

---

## §十 GDB Verification（≥8 断言）

以下是可以通过 GDB 验证的断言（在 Postmortem Mode 中验证，即使用 core dump 文件）：

### 断言 1: NT_PRSTATUS note 包含正确的寄存器值

```bash
# 用 readelf 查看 core 文件的 NT_PRSTATUS note
readelf -n core.12345

# 输出示例：
# Displaying notes found in: core.12345
#   Owner                 Data size       Description
#   CORE                 336             NT_PRSTATUS (prstatus)
#     pid: 12345  ppid: 1  pgrp: 12345  sid: 1
#     utime: 0.000000  stime: 0.000000
#     cutime: 0.000000  cstime: 0.000000
#     sigpend: 0  sighold: 0
#     sigign: 0  sigcatch: 0
#     regs: rip: 0x7f1a2b3c4d5e  rsp: 0x7ffd8c9b0a20  rbp: 0x7ffd8c9b0a50
#           ...

# 用 GDB 加载 core dump，验证寄存器值
gdb java core.12345

# 在 GDB 中执行
info registers rip
# 期望: rip 的值与 readelf -n 输出的 regs.rip 一致
```

**验证方法**: 对比 `readelf -n` 的输出和 GDB `info registers` 的输出，验证一致性。

**源码引用**: `ps_core.c:509-569` (`core_handle_prstatus`), `ps_core.c:574-632` (`core_handle_note`)

---

### 断言 2: PT_LOAD 段的虚拟地址映射正确

```bash
# 用 readelf 查看 core 文件的 PT_LOAD 段
readelf -l core.12345

# 输出示例：
# Program Headers:
#   Type           Offset   VirtAddr           PhysAddr           FileSiz  MemSiz   Flg Align
#   NOTE           0x000000 0x0000000000000000 0x0000000000000000 0x000456 0x000456 R   0x0
#   LOAD           0x002000 0x00007f1a2b000000 0x0000000000000000 0x01f000 0x01f000 R E 0x1000
#   LOAD           0x021000 0x00007f1a2b21f000 0x0000000000000000 0x00d000 0x00d000 RW  0x1000
#   ...

# 验证 map_info 链表的正确性
# 在 core_lookup() 中打断点，打印 map_info 的 vaddr 和 memsz
# 验证与 readelf -l 输出的 VirtAddr 和 MemSiz 一致
```

**验证方法**: 编写测试程序，调用 `Pgrab_core()`，然后在 `sort_map_array()` 中打断点，打印 `map_array[i]->vaddr` 和 `map_array[i]->memsz`，对比 `readelf -l` 的输出。

**源码引用**: `ps_core.c:635-691` (`read_core_segments`), `ps_core.c:155-199` (`core_lookup`)

---

### 断言 3: core_read_data() 正确读取虚拟地址

```bash
# 编写测试程序，调用 Pgrab_core() 打开 core dump
# 然后调用 core_read_data(ph, addr, buf, size) 读取已知地址

# 例如：读取 libjvm.so 的 .text 段开头的几个字节
# 已知 libjvm.so 的加载基址是 0x7f1a2b000000（从 readelf -l 获取）
# 调用 core_read_data(ph, 0x7f1a2b000000, buf, 16)

# 用 GDB 验证读取的内容
# 在 core_read_data() 中打断点，打印 buf 的内容
# 对比 libjvm.so 文件本身的 .text 段开头（用 readelf -x .text libjvm.so 查看）
```

**验证方法**: 对比 `core_read_data()` 读取的内容和原始 `.so` 文件的对应部分，验证一致性。

**源码引用**: `ps_core.c:431-479` (`core_read_data`), `ps_core.c:155-199` (`core_lookup`)

---

### 断言 4: read_shared_lib_info() 正确重建链接映射

```bash
# 用 ldd 查看可执行文件的依赖库
ldd java

# 输出示例：
#         linux-vdso.so.1 (0x00007ffd8c9b0000)
#         libjvm.so => /usr/lib/jvm/java-17-openjdk/lib/server/libjvm.so (0x00007f1a2b000000)
#         libc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x00007f1a2a000000)
#         ...

# 验证 lib_info 链表的正确性
# 在 read_shared_lib_info() 中打断点，打印 lib->name 和 lib->base
# 验证与 ldd 输出的路径和加载基址一致
```

**验证方法**: 对比 `lib_info` 链表的内容和 `ldd` 命令的输出，验证一致性。

**源码引用**: `ps_core.c:906-1044` (`read_shared_lib_info`), `ps_core.c:862-902` (`calc_prelinked_load_address`)

---

### 断言 5: dynamic_addr 正确计算

```bash
# 查看可执行文件的 PT_DYNAMIC 段
readelf -l java | grep DYNAMIC

# 输出示例：
#   LOAD           0x021000 0x0000000000400000 0x0000000000400000 0x00d000 0x00d000 RW  0x1000
#   DYNAMIC        0x022a50 0x0000000000602a50 0x0000000000602a50 0x0001c0 0x0001c0 RW  0x8

# 验证 ph->core->dynamic_addr 的值
# 在 read_exec_segments() 中打断点，打印 dynamic_addr 的值
# 对于 ET_EXEC，应该等于 PT_DYNAMIC.p_vaddr
# 对于 ET_DYN，应该等于 PT_DYNAMIC.p_vaddr - e_entry + dynamic_addr（从 NT_AUXV 获取）
```

**验证方法**: 对比 `ph->core->dynamic_addr` 的值和 `readelf -l` 的输出，验证一致性。

**源码引用**: `ps_core.c:782-849` (`read_exec_segments`), `ps_core.c:610-622` (NT_AUXV 处理)

---

### 断言 6: sort_map_array() 正确排序

```bash
# 在 sort_map_array() 中打断点
break sort_map_array

# 打印排序后的 map_array
# 验证 map_array[i]->vaddr < map_array[i+1]->vaddr 对所有 i 成立
for (int i = 0; i < ph->core->num_maps - 1; i++) {
    assert(map_array[i]->vaddr < map_array[i+1]->vaddr);
}
```

**验证方法**: 在 GDB 中编写循环，验证 `map_array` 是按 `vaddr` 排序的。

**源码引用**: `ps_core.c:385-425` (`sort_map_array`), `ps_core.c:155-199` (`core_lookup`)

---

### 断言 7: core_release() 正确清理资源

```bash
# 编写测试程序，调用 Pgrab_core() 打开 core dump
# 然后调用 Prelease(ph) 释放

# 在 core_release() 中打断点
break core_release

# 单步执行，验证：
# 1. close_files() 关闭了所有文件描述符（core_fd/exec_fd/interp_fd/classes_jsa_fd/lib_fd）
# 2. destroy_map_info() 释放了所有 map_info（maps + class_share_maps + map_array）
# 3. free(ph->core) 释放了 core_data 结构体

# 用 valgrind 验证内存泄漏
valgrind --leak-check=full ./test_program
```

**验证方法**: 用 `valgrind` 检查内存泄漏，确保 `Pgrab_core()` + `Prelease()` 配对调用后无内存泄漏。

**源码引用**: `ps_core.c:99-105` (`core_release`), `ps_core.c:46-96` (`close_files` + `destroy_map_info`)

---

### 断言 8: prelink 处理正确

```bash
# 在有 prelink 的系统上测试（或使用 old RHEL 版本）
# prelink 会修改 .so 文件的加载基址

# 验证 calc_prelinked_load_address() 的正确性
# 在 calc_prelinked_load_address() 中打断点
break calc_prelinked_load_address

# 打印 lib_base 的值
# 对比 readelf -h libjvm.so 的 e_entry 和实际的加载基址
readelf -h /usr/lib/jvm/java-17-openjdk/lib/server/libjvm.so | grep Entry
```

**验证方法**: 对比 `calc_prelinked_load_address()` 计算的基址和实际的加载基址（`/proc/<pid>/maps` 中的值），验证一致性。

**源码引用**: `ps_core.c:862-902` (`calc_prelinked_load_address`), `ps_core.c:906-1044` (`read_shared_lib_info`)

---

## §十一 与 README 和同组 prompt 的连续性

### 11.1 与 README 的关系

本文档是 Phase 20 的第 02 篇，对应 `probe_md/20-sa-postmortem/README.md` 中的：

- **§§ 02 - Native Postmortem 调试（Core dump）** (`README.md` 对应章节)
- 核心内容：
  1. `Pgrab_core()` 完整流程
  2. ELF core dump 格式解析（`PT_NOTE` / `NT_PRSTATUS`）
  3. `core_read_data()` 内存读取（虚拟地址 → 文件偏移映射）
  4. `read_shared_lib_info()` 链接映射重建
  5. `core_data` 结构体的生命周期
  6. 边缘场景处理（core 文件不完整/prelink/CDS）

**连续性保证**:
- 本文档依赖 prompt-00 的 `ps_prochandle` 核心数据结构解释（§三）
- 本文档详细展开 prompt-00 中简略提到的 `core_data` 结构体（prompt-00 §四 问题组 5）
- 本文档是后续 prompt-03（JNI Bridge + Symbol）的对比基准（Postmortem Mode 的符号查找）

### 11.2 与同组 prompt 的关系

| Prompt | 文件 | 与本文档的关系 |
|--------|------|---------------|
| prompt-00 | SA 架构 + 核心数据结构 | 本文档依赖其 §三 的 `core_data` 结构体解释 |
| prompt-01 | Live Debugging (ps_proc.c) | 对比 Postmortem Mode：相同的 `ps_prochandle_ops` vtable，不同的实现（`pread` vs `ptrace`） |
| prompt-02 (本文档) | Postmortem Debugging (ps_core.c) | 详细分析 Postmortem Mode 实现 |
| prompt-03 | JNI Bridge + Symbol (LinuxDebuggerLocal.c + symtab.c) | 依赖本文档的 `core_read_data()` 解释（Java 层如何调用 Native 层） |
| prompt-04 | SA Bootstrap (HotSpotAgent.java + TypeDataBase) | 依赖本文档的 `Pgrab_core()` 解释（Java 层如何触发 Postmortem Mode） |
| prompt-05 | Tools Pipeline (jstack/jmap/jinfo) | 依赖本文档的 Postmortem Mode 流程（工具如何使用 SA 分析 core dump） |

### 11.3 避免重复

- **不与 prompt-00 重复**: prompt-00 解释核心数据结构（§三），本文档解释这些数据结构在 Postmortem Mode 中的使用流程
- **不与 prompt-01 重复**: prompt-01 关注 Live Mode（`ps_proc.c`），本文档只关注 Postmortem Mode（`ps_core.c`），两模式通过 `ops` vtable 分派，但实现完全不同
- **不与 prompt-03 重复**: 本文档只解释 Native 层的 `core_read_data()`，不展开 Java 层的 JNI 桥接逻辑（那是 prompt-03 的内容）

---

## §十二 质量自检清单

写完文档后，逐项检查：

- [ ] §四 深度问题组 ≥6 组，每组含 counterfactual
- [ ] §八 Prohibited ≥10 条
- [ ] §九 Required ≥10 条
- [ ] §十 Verification ≥8 断言
- [ ] §四 答案方向 ≥8 行（随机抽取 3 个问题组验证）
- [ ] Beginner Callout ≥7 个，且只在 §一 内
- [ ] man 手册引用覆盖所有核心概念（`man 5 elf` + `man 2 open` + `man 2 pread`）
- [ ] 独立的边缘场景 section ≥4 场景
- [ ] §二 有 ELF 格式基础 + syscall/二进制/全局状态表
- [ ] 标题格式 `# 02-Postmortem-Debugging — ps_core.c 深度解析`
- [ ] 运行 `rg '^## §' file.md` 验证连续无跳号
- [ ] 总行数 ≥450 行（目标是 3000-4000 行）
- [ ] 包含 ELF Core Dump 布局示意图（ASCII art）
- [ ] 包含 core_read_data() 虚拟地址映射图
- [ ] 包含 read_shared_lib_info() 链接映射遍历示意图
- [ ] 性能量化表格（§六 或 §四 问题组 4）

---

## 附录 A: 关键源码位置速查

| 符号 | 文件:行号 | 说明 |
|------|----------|------|
| `Pgrab_core` | `ps_core.c:1048-1134` | Postmortem Mode 入口，打开并解析 core dump |
| `read_core_segments` | `ps_core.c:635-691` | 解析 core 文件的 PT_LOAD + PT_NOTE 段 |
| `read_exec_segments` | `ps_core.c:782-849` | 解析可执行文件的 PT_LOAD 段 |
| `read_lib_segments` | `ps_core.c:694-761` | 解析共享库的 PT_LOAD 段（只读部分） |
| `core_handle_note` | `ps_core.c:574-632` | 解析 PT_NOTE 段（NT_PRSTATUS/NT_AUXV） |
| `core_handle_prstatus` | `ps_core.c:509-569` | 处理 NT_PRSTATUS（保存寄存器到 thread_info） |
| `core_read_data` | `ps_core.c:431-479` | 从 core dump 读取内存（虚拟地址 → 文件偏移） |
| `core_get_lwp_regs` | `ps_core.c:487-499` | 获取线程寄存器（从 cached 的 prstatus 读取） |
| `core_release` | `ps_core.c:99-105` | 清理函数（释放 core_data） |
| `sort_map_array` | `ps_core.c:385-425` | 排序 map_info 数组（用于二分查找） |
| `read_shared_lib_info` | `ps_core.c:906-1044` | 从 _DYNAMIC 重建链接映射 |
| `init_classsharing_workaround` | `ps_core.c:256-363` | CDS 归档文件的 workaround |
| `calc_prelinked_load_address` | `ps_core.c:862-902` | 计算 prelink 库的加载基址 |
| `core_ops` | `ps_core.c:501-506` | Postmortem Mode 的 vtable |
| `map_info` | `libproc_impl.h:54-61` | 虚拟内存映射结构体 |
| `core_data` | `libproc_impl.h:79-92` | core dump 专用数据结构体 |
| `read_elf_header` | `salibelf.c:33-40` | 读取 ELF 文件头 |
| `read_program_header_table` | `salibelf.c:48-65` | 读取 Program Header Table |
| `find_base_address` | `salibelf.c:105-126` | 找到共享库的加载基址 |

---

## 附录 B: 相关 man 手册章节

| 手册页 | 章节 | 关键部分 |
|--------|------|---------|
| `man 5 elf` | 5 | ELF 文件格式：Ehdr/Phdr/Shdr/Nhdr，`ET_CORE`，`PT_NOTE`，`NT_PRSTATUS` |
| `man 2 open` | 2 | 打开 core 文件/可执行文件/共享库 |
| `man 2 pread` | 2 | 从指定偏移读取文件（core_read_data 用） |
| `man 2 lseek` | 2 | 定位文件偏移（core_handle_note 用） |
| `man 2 close` | 2 | 关闭文件描述符（close_files 用） |
| `man 3 fopen` | 3 | 打开文件（用于读取 /proc 文件，本文档不涉及） |
| `man 5 proc` | 5 | `/proc/<pid>/maps` 格式（理解 core dump 的 PT_LOAD 段来源） |
| `man 3 qsort` | 3 | 排序 map_array（sort_map_array 用） |
| `man 3 calloc` | 3 | 分配内存（allocate_init_map 用） |

---

**END OF PROMPT**