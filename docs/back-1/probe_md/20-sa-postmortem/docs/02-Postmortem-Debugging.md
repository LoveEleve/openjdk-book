# 02 Native Postmortem 调试（Core dump）— ps_core.c 深度解析

## §〇 Production Scenario

**真实场景**: 某电商系统 JVM 在高峰时段崩溃（SIGSEGV），core 文件 8GB。运维工程师不在现场，无法实时附加调试器。唯一的线索是 `core.9876` 文件。使用 `jhsdb jstack --exe java --core core.9876` 分析，发现 `ConcurrentMarkThread` 在访问已卸载的 `Klass*` 指针——事后确认为 `G1ConcurrentMark::cleanup()` 的竞态条件（JDK-8222793）。

**诊断三步走**:

```bash
# 1. 确认 core dump 文件存在 + 设置大小
ulimit -c unlimited
echo "core.%p" > /proc/sys/kernel/core_pattern

# 2. 用 jhsdb 分析 core dump
jhsdb jstack --exe java --core core.9876
# 输出: ConcurrentMarkThread 在 G1ConcurrentMark::cleanup() 中访问非法地址

# 3. GDB 验证寄存器状态
gdb java core.9876 -ex "info registers rip" -ex "bt"
# 确认崩溃点在 ObjectSynchronizer::inflate 的 C2 compiled code 中
```

**核心问题**:

1. `jhsdb` 如何从 ELF core dump 文件重建进程地址空间？核心函数 `Pgrab_core()` (`ps_core.c:1048`)
2. ELF core dump 的 `PT_NOTE` 段中，`NT_PRSTATUS` / `NT_AUXV` 各自携带什么信息？
3. 虚拟地址 → core 文件偏移的映射如何建立？`map_info` 链表 + `map_array` 二分查找如何工作？
4. `core_read_data()` (`ps_core.c:431`) 的 fd 分派：core fd / exec fd / lib fd 各自读哪些地址范围？
5. 符号查找在 Postmortem Mode 的降级：`dlopen` 不可用，如何解析 `.dynsym`？
6. 如果没有 `NT_FILE` note（旧 core 文件），SA 如何构建 `lib_info` 链表？

**反事实**: 如果没有 Postmortem Mode（SA 只能 attach 活进程），线上报警的"JVM 进程突然没了"——无法复现（高峰流量负载无法复制）、无法调试（进程已崩溃）、无法定位根因。Core dump 是唯一的证据链，Postmortem Mode 是唯一的分析途径。JVM SA 的 Postmortem Mode 使得事后故障分析（Postmortem Analysis）成为可能——无需实时 GDB session，core dump 可以离线分析、跨团队协作、保存为证据。

## §一 Pgrab_core() 完整流程：从 open(core_file) 到 ps_prochandle 初始化

### Narrative: 执行总览

本文档覆盖 `ps_core.c` 的 1134 行 C 源码，解释 Postmortem Mode 的完整实现。以**执行流**为主线，穿插 ELF 格式示意图和虚拟地址映射图。

```
jhsdb jstack --exe java --core core.12345
    ↓
Java 层: LinuxDebuggerLocal.java:342 → attach0(execFile, coreFile)
    │                                    JNI 边界
    ▼
Native C: LinuxDebuggerLocal.c:272 → Pgrab_core(exec, core)
    ↓                                 [ps_core.c:1048]
open(core_file, O_RDONLY)            打开 core 文件
read_elf_header(core_fd)             验证 ELF magic + e_type == ET_CORE
    ↓
open(exec_file, O_RDONLY)            打开可执行文件
read_elf_header(exec_fd)             验证 ELF magic + e_type == ET_EXEC/ET_DYN
    ↓
read_core_segments(ph, &core_ehdr)  [ps_core.c:635]
    → 遍历 core 文件的 Program Header
    → PT_LOAD: add_map_info(core_fd, p_offset, p_vaddr, p_filesz)
    → PT_NOTE: core_handle_note()  [ps_core.c:574]
        → 解析 ELF_NHDR 链表
        → NT_PRSTATUS: core_handle_prstatus() → add_thread_info()
        → NT_AUXV: 提取 AT_ENTRY → ph->core->dynamic_addr
    ↓
read_exec_segments(ph, &exec_ehdr)  [ps_core.c:782]
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
    → read_interp_segments(ph)      [ps_core.c:764] ← ld-linux 解释器段
    → 从 _DYNAMIC 找到 DT_DEBUG → r_debug.r_map
    → 遍历 link_map 链表
    → 对每个 lib: pathmap_open(lib_name) → read_lib_segments()
    → add_lib_info_fd(ph, lib_name, fd, base)
    → sort_map_array(ph)            第二次排序（每次添加库后）
    ↓
init_classsharing_workaround(ph)     [ps_core.c:256]
    → lookup_symbol("UseSharedSpaces")
    → 打开 classes.jsa → 添加 class_share_maps
    ↓
返回 ph                             Pgrab_core 成功
    ↓
Java 层通过 JNI 调用
    → readBytesFromProcess0 → ps_pdread(ph, addr, buf, size)
    → ph->ops->p_pread → core_read_data  [ps_core.c:431]
    → getThreadIntegerRegisterSet0 → core_get_lwp_regs  [ps_core.c:487]
    ↓
Prelease(ph)                       [libproc.h:66-67]
    → core_release(ph)               [ps_core.c:99]
        → close_files(ph)           [ps_core.c:46]
        → destroy_map_info(ph)       [ps_core.c:77]
        → free(ph->core)
```

### 1.1 Pgrab_core() 函数签名与参数 [ps_core.c:1048-1053]

```c
struct ps_prochandle* Pgrab_core(const char* exec_file,
                                  const char* core_file)
```

**参数**:
- `exec_file`: 可执行文件路径（如 `/usr/bin/java`）——Postmortem Mode 中用于读取只读代码段（`.text`）
- `core_file`: core dump 文件路径（如 `core.12345`）——进程崩溃时的内存快照

**返回值**: 成功返回 `ps_prochandle*`（句柄，后续所有操作的基础），失败返回 `NULL`。

**失败点**: ① `open(core_file)` 失败（文件不存在/权限不足）② ELF header 验证失败（`e_type != ET_CORE`）③ `read_core_segments()` 失败（PT_NOTE 解析错误）④ `read_exec_segments()` 失败（`exec_base_addr == 0L`）

**为什么需要 `exec_file` 参数？** 因为 core dump 文件可能不包含只读内存映射（内核为节省空间，只 dump 可写页 `PF_W`），SA 需要重新打开原始可执行文件读取代码段。`exec_file` 参数在 Live Mode 的 `Pgrab(pid)` 中不存在——因为 Live Mode 直接从 `/proc/pid/maps` 和 `/proc/pid/mem` 读取。

### 1.2 第一步：打开 core 文件 + 验证 ELF header [ps_core.c:1072-1081]

```c
// ps_core.c:1072-1081（open core 文件 + ELF header 验证）
if ((ph->core->core_fd = open(core_file, O_RDONLY)) < 0) {
    print_debug("can't open core file\n");
    goto err;
}
if (read_elf_header(ph->core->core_fd, &core_ehdr) != true
    || core_ehdr.e_type != ET_CORE) {
    print_debug("core file is not a valid ELF ET_CORE file\n");
    goto err;
}
```

**关键验证**:
- `man 2 open`: `O_RDONLY` 只读打开——Postmortem Mode 是**只读**操作，永远不会修改 core 文件（`core_write_data` 是 no-op）
- `man 5 elf`: `ET_CORE = 4`——core dump 的 ELF 类型标识。与 `ET_EXEC = 2`（可执行文件）、`ET_DYN = 3`（共享库/PIE）完全不同
- `read_elf_header()`: 验证 ELF magic `\x7fELF` (`EI_MAG0-3`) + `EI_CLASS` (64-bit) + `e_version == EV_CURRENT` (`man 5 elf`)

**ELF Header 关键字段** (`man 5 elf`):

| 字段 | 大小 | 含义 | 在 Postmortem Mode 中的用途 |
|------|------|------|--------------------------|
| `e_phoff` | `Elf64_Off` | Program Header Table 的文件偏移 | `read_program_header_table()` 定位 PHT |
| `e_phnum` | `Elf64_Half` | Program Header 条目数 | 遍历 PHT 的上限 |
| `e_phentsize` | `Elf64_Half` | 每个 Program Header 的大小 | 计算 PHT 总字节数 |
| `e_entry` | `Elf64_Addr` | 程序入口地址 | 用于 ET_DYN 的 `dynamic_addr` 计算 |
| `e_type` | `Elf64_Half` | ELF 类型 | 必须为 `ET_CORE` |

### 1.3 第二步：打开可执行文件 + 验证 ELF header [ps_core.c:1083-1092]

```c
// ps_core.c:1083-1092（read_elf_header 和 e_type 检查合并为一个条件）
if ((ph->core->exec_fd = open(exec_file, O_RDONLY)) < 0) {
    print_debug("can't open executable file\n");
    goto err;
}
if (read_elf_header(ph->core->exec_fd, &exec_ehdr) != true ||
    ((exec_ehdr.e_type != ET_EXEC) && (exec_ehdr.e_type != ET_DYN))) {
    print_debug("executable file is not a valid ELF file\n");
    goto err;
}
```

**接受 `ET_EXEC` 和 `ET_DYN` 的原因**: 现代 Linux 发行版中，可执行文件通常是 PIE（Position-Independent Executable）。PIE 可执行文件的 `e_type` 是 `ET_DYN`（与共享库相同），而非传统的 `ET_EXEC`。SA 必须同时接受这两种类型以支持 PIE 二进制文件。

**为什么 `ET_EXEC` 和 `ET_DYN` 的分支逻辑不同？** 在 `read_exec_segments()` 中，PT_DYNAMIC 段的 `dynamic_addr` 计算方式取决于 `e_type`:
- `ET_EXEC`: `dynamic_addr = PT_DYNAMIC.p_vaddr`（直接使用，因为加载基址固定为 0）
- `ET_DYN` (PIE): 需要从 NT_AUXV 的 `AT_ENTRY` 反推基址

### 1.4 初始化 ps_prochandle：core_ops vtable + fd 哨兵 [ps_core.c:1066-1069]

```c
// ps_core.c:1066-1069
ph->ops = &core_ops;                          // 绑定虚函数表（core_read_data 等）
ph->core->core_fd = -1;                       // 未打开状态哨兵
ph->core->exec_fd = -1;
ph->core->interp_fd = -1;                     // 解释器 fd，延迟到 read_exec_segments 打开
```

**vtable 多态机制** (`libproc_impl.h:64-75` + `ps_core.c:501-506`):

```c
// libproc_impl.h:64-75
typedef struct ps_prochandle_ops {
   void (*release)(struct ps_prochandle* ph);
   bool (*p_pread)(struct ps_prochandle*, uintptr_t, char*, size_t);
   bool (*p_pwrite)(struct ps_prochandle*, uintptr_t, const char*, size_t);
   bool (*get_lwp_regs)(struct ps_prochandle*, lwpid_t, struct user_regs_struct*);
} ps_prochandle_ops;

// ps_core.c:501-506 — Postmortem vtable
static ps_prochandle_ops core_ops = {
   .release      = core_release,
   .p_pread      = core_read_data,           // ← pread 大块读取
   .p_pwrite     = core_write_data,          // ← no-op，禁止写入
   .get_lwp_regs = core_get_lwp_regs         // ← 从 NT_PRSTATUS 缓存读取
};
```

**Live/Postmortem 分叉点**:

```
ph->ops->p_pread(ph, addr, buf, size)
    │
    ├── core_ops    → core_read_data    (pread 大块读取，性能最优)
    │                   [ps_core.c:431]
    │
    └── process_ops → process_read_data (ptrace PEEKDATA 逐字读取，~100x 慢)
                        [ps_proc.c]
```

**为何用 `-1` 作为 fd 哨兵？** `close_files()` (`ps_core.c:46`) 检查 `fd >= 0` 决定是否 `close(2)`。所有 fd 初始化为 `-1` 确保 `close_files()` 在部分初始化失败时不会关闭未打开的文件描述符。

### 1.5 第三步：read_core_segments() — 核心解析 [ps_core.c:1095]

详见 **§三 read_core_segments() 深度分析**。

**一句话**: 遍历 core 文件的 Program Header，`PT_LOAD` 段加入 `map_info` 链表，`PT_NOTE` 段解析为线程寄存器快照。

### 1.6 第四步：read_exec_segments() — 可执行文件解析 [ps_core.c:1100-1107]

详见 **§五 read_exec_segments()**。

**关键返回值**: `exec_base_addr`——可执行文件的加载基址。如果是 PIE（`ET_DYN`），由 `dynamic_addr - e_entry` 计算。`Pgrab_core()` 随后将其注册到 `lib_info` 链表以便符号查找。

```c
// ps_core.c:1100-1107
if ((exec_base_addr = read_exec_segments(ph, &exec_ehdr)) == 0L) {
    print_debug("error: failed to read exec file segments\n");
    goto err;
}
add_lib_info_fd(ph, exec_file, ph->core->exec_fd, exec_base_addr);
```

### 1.7 第五步：sort_map_array() 第一次排序 [ps_core.c:1112]

在 `read_shared_lib_info()` 之前需要 `sort_map_array()` 构建二分查找数组，因为 `read_shared_lib_info()` 内部调用 `ps_pdread()` 从 core dump 读取 `r_debug` 结构体，而 `ps_pdread()` → `core_read_data()` → `core_lookup()` 依赖排序后的 `map_array`。

```c
// ps_core.c:1112
sort_map_array(ph);
```

### 1.8 第六步：read_shared_lib_info() — 重建链接映射 [ps_core.c:1116-1118]

详见 **§七 read_shared_lib_info() 链接映射重建**。

**一句话**: 从可执行文件的 `_DYNAMIC` 段找到 `DT_DEBUG` → 读取 `r_debug` 结构体 → 遍历 `link_map` 链表 → 打开每个共享库 → 添加只读段映射。

### 1.9 第七步：sort_map_array() 第二次排序 [ps_core.c:1121]

```c
// ps_core.c:1121
sort_map_array(ph);
```

`read_shared_lib_info()` 中每次添加共享库的段映射后都会调用 `sort_map_array()`（`ps_core.c:1025`），但这个最终排序确保所有映射（core + exec + lib）都正确排序。

### 1.10 第八步：init_classsharing_workaround() — CDS 处理 [ps_core.c:1125]

```c
// ps_core.c:1125
init_classsharing_workaround(ph);
```

**CDS (Class Data Sharing) workaround**:
1. 遍历 `lib_info` 链表找到 `libjvm.so`
2. 符号查找 `UseSharedSpaces` → 检查 CDS 是否启用
3. 符号查找 `SharedArchivePath` → 获取 `classes.jsa` 路径
4. 打开 `classes.jsa` → 验证 CDS header → 添加只读区域到 `class_share_maps` 链表

**为什么 CDS 映射不在 `map_array` 中？** `class_share_maps` 是独立链表，只在 `core_lookup()` 的 fallback 线性搜索中使用。设计意图：当 `-Xshare:off` 时，避免 CDS 数据优先于 core dump 数据返回。

### 1.11 错误处理与内存清理 [ps_core.c:1131-1133]

```c
// ps_core.c:1131-1133
err:
   Prelease(ph);
   return NULL;
```

`Prelease()` → `core_release()` → `close_files()` + `destroy_map_info()` + `free(core)`，保证所有资源正确释放（即使在部分初始化失败的情况下）。

---

> **💡 初学者提示 1**: ELF core dump 不是普通的 ELF 可执行文件，它的 `e_type` 是 `ET_CORE`（而非 `ET_EXEC`/`ET_DYN`）。Core dump 包含进程崩溃时的**内存快照**（通过 `PT_LOAD` 段）和**线程状态**（通过 `PT_NOTE` 段）。可以用 `readelf -a core.12345` 查看详细信息。ET_CORE = 4（定义在 `/usr/include/elf.h`）。

> **💡 初学者提示 2**: `PT_NOTE` 段是 core dump 中最复杂的部分，它包含多个 note 条目（每个条目以 `Elf64_Nhdr` 开头）。每个 note 有一个 `n_type` 字段：`NT_PRSTATUS = 1`（线程寄存器）、`NT_PRPSINFO = 3`（进程状态信息）、`NT_AUXV = 6`（auxv 向量）、`NT_FILE = 0x46494c45`（映射文件路径，Linux 3.6+ 扩展）。SA 主要关注 `NT_PRSTATUS` 和 `NT_AUXV`。

> **💡 初学者提示 3**: `map_info` 链表记录了虚拟地址到文件偏移的映射。每个 `map_info` 对应一个 `PT_LOAD` 段（来自 core 文件）或共享库的只读段（来自 `.so` 文件）。`core_read_data()` 通过 `core_lookup()` 二分查找 `map_array`，找到地址所在的 `map_info`，然后计算文件偏移：`off = map->offset + (addr - map->vaddr)`，最后用 `pread(map->fd, buf, size, off)` 读取。

> **💡 初学者提示 4**: Core dump 文件可能**不包含只读内存映射**（如 `libjvm.so` 的代码段），因为内核为了节省空间，只会 dump 可写段（`PF_W`）。SA 需要重新打开原始 `.so` 文件，读取只读段来"补全"内存映射。这就是 `read_lib_segments()` (`ps_core.c:694`) 的作用。

> **💡 初学者提示 5**: `read_shared_lib_info()` 需要从 core dump 中重建共享库链表，但它不能调用 `dlopen()`（目标进程已崩溃）。相反，它从可执行文件的 `_DYNAMIC` 段找到 `DT_DEBUG`，进而找到动态链接器维护的 `r_debug` 结构体，再遍历 `link_map` 链表。这是 GDB 等调试器也使用的经典技巧。

> **💡 初学者提示 6**: `core_read_data()` (`ps_core.c:431`) 使用 `pread(2)` 而非 `read(2)`，因为 `pread` 允许指定文件偏移（不会改变文件描述符的当前位置）。这对于多文件描述符场景（core fd / exec fd / lib fd）是必需的——每次读取需要精确的文件偏移。

> **💡 初学者提示 7**: `sort_map_array()` (`ps_core.c:385`) 将 `maps` 链表转为 `map_array` 指针数组，`qsort` 按 `vaddr` 排序。这是为了 `core_lookup()` 中的二分查找。为什么不用平衡树？因为 `PT_LOAD` 段数量通常 < 100，二分查找 O(log n) 足够快，且常数因子比平衡树小得多。

> **💡 初学者提示 8**: Postmortem Mode 和 Live Mode 的核心差异在 vtable 分发：`ph->ops->p_pread` 在 Postmortem 下调用 `core_read_data`（`pread` 大块读），在 Live 下调用 `process_read_data`（`ptrace(PEEKDATA)` 逐字读）。速度差距 >100x。详细对比见 §六。

> **💡 初学者提示 9**: `read_interp_segments()` (`ps_core.c:764`) 是一个容易被忽略但至关重要的中间步骤。它负责读取动态链接器（ld-linux.so.2）的段——ld.so 本身也是一个共享库，如果没有它的符号，符号查找就无法工作。它在 `read_shared_lib_info()` 中被调用，位于遍历 `link_map` 之前。

---

## §二 ELF Core Dump 格式基础

### 2.1 ELF Core Dump 布局

```
ELF Core Dump 布局（ET_CORE = 4）：
+-------------------+
| ELF Header        |  ← read_elf_header() 读取 [salibelf.c:33]
|  e_type = ET_CORE |
|  e_phoff = ...    |
|  e_phnum = ...    |
+-------------------+
| Program Header    |  ← read_program_header_table() 读取 [salibelf.c:48]
| Table (PHT)       |
| [0] PT_NOTE       |  ← core_handle_note() 解析 [ps_core.c:574]
| [1] PT_LOAD       |  ← add_map_info(core_fd, ...) [ps_core.c:124]
| [2] PT_LOAD       |
| [3] PT_LOAD       |
| ...               |
+-------------------+
| PT_NOTE 数据      |  ← core_handle_note() → core_handle_prstatus()
| ┌───────────────┐ |
| │ NT_PRSTATUS 0 │ |  ← 线程 0 的寄存器快照（user_regs_struct）
| ├───────────────┤ |
| │ NT_PRSTATUS 1 │ |
| ├───────────────┤ |
| │ ...           │ |
| ├───────────────┤ |
| │ NT_AUXV       │ |  ← AT_ENTRY → ph->core->dynamic_addr
| └───────────────┘ |
+-------------------+
| PT_LOAD [0] 数据  |  ← core_read_data() 从 core_fd 读取
| (堆、栈、BSS)     |
+-------------------+
| PT_LOAD [1] 数据  |
+-------------------+
```

**ELF Header 验证** (`salibelf.c:33-40`):

```c
// 验证 ELF magic + 版本
static int read_elf_header(int fd, ELF_EHDR* ehdr) {
   if (pread(fd, ehdr, sizeof(ELF_EHDR), 0) != sizeof(ELF_EHDR)) {
      return 0;  // 读取失败
   }
   // 验证 magic: ELFMAG0='\x7f', ELFMAG1='E', ELFMAG2='L', ELFMAG3='F'
   if (ehdr->e_ident[EI_MAG0] != ELFMAG0 || ...) {
      return 0;  // 不是 ELF 文件
   }
   if (ehdr->e_version != EV_CURRENT) {
      return 0;  // 不支持的版本
   }
   return 1;
}
```

参考: `man 5 elf` 的 "ELF Header（Ehdr）" 部分，定义在 `/usr/include/elf.h`。

### 2.2 PT_NOTE 段详解

**PT_NOTE 段是 core dump 中最复杂的部分**，它包含进程的**元数据**（寄存器、状态信息、auxv 等）。每个 note 条目以 `Elf64_Nhdr` 开头 (`ps_core.c:601-603`):

```
单个 Note 条目的布局：
+-------------------+
| Elf64_Nhdr        |  n_namesz (4 字节) + n_descsz (4 字节) + n_type (4 字节)
|   n_namesz = len  |
|   n_descsz = len  |
|   n_type   = type |
+-------------------+
| name              |  n_namesz 字节（4 字节对齐）
| (通常 "CORE\0")   |
+-------------------+
| descriptor        |  n_descsz 字节（4 字节对齐）
| (prstatus_t 等)   |
+-------------------+

Note 对齐规则（ps_core.c:571）:
  descdata = p + sizeof(Elf64_Nhdr) + ROUNDUP(notep->n_namesz, 4);
  下一项 = descdata + ROUNDUP(notep->n_descsz, 4);
```

**Note 类型详解** (`man 5 elf` + Linux 内核扩展):

| Note 类型 | Elf.h 定义 | 携带信息 | SA 是否使用 | 对应函数 |
|-----------|-----------|---------|------------|---------|
| `NT_PRSTATUS` | `elf.h:NT_PRSTATUS = 1` | 线程寄存器快照（`prstatus_t.pr_reg` = `user_regs_struct`，含 `rip`/`rsp`/`rbp` 等 x86_64 寄存器）| ✅ 是 | `core_handle_prstatus()` (`ps_core.c:509`) |
| `NT_PRPSINFO` | `elf.h:NT_PRPSINFO = 3` | 进程状态信息（PID、UID、可执行文件名、信号编号）| ❌ 否 | SA 未使用（可用 `readelf -n` 查看） |
| `NT_AUXV` | `elf.h:NT_AUXV = 6` | Auxiliary vector（`AT_ENTRY`、`AT_PHDR`、`AT_BASE` 等 20+ 条目）| ✅ 是 | `core_handle_note()` (`ps_core.c:610-622`) |
| `NT_FILE` | Linux 扩展 = `0x46494c45` | 映射文件路径列表（路径字符串 + 偏移 + 地址）| ⚠️ 有条件 | 旧 core 文件无此 note，SA 不用 |
| `NT_FPREGSET` | `elf.h:NT_FPREGSET = 2` | 浮点寄存器快照（XMM/YMM 寄存器）| ❌ 否 | SA 不使用（可用 GDB `info float` 查看） |

### 2.3 为什么寄存器快照在 PT_NOTE 的 PRSTATUS 中（而非独立段）？

1. **历史原因**: Solaris 的 core dump 格式（`.mdmp` 文件）也将寄存器放在 `prstatus` 结构中。Linux 的 `fs/binfmt_elf.c` 模仿了 Solaris 的格式（注释 `ps_core.c:663-664` 明确提到 "Solaris compatibility"）
2. **ELF 设计**: `PT_NOTE` 段是"可变长度元数据"的标准位置。寄存器快照被视为"进程状态"的一部分，而非独立的内存映射
3. **GDB 兼容性**: GDB 期望从 `NT_PRSTATUS` 中读取寄存器（`bfd/elf.c` 的 `elfcore_grok_prstatus` 函数）
4. **空间效率**: 每个线程的寄存器只有 ~200 字节（`sizeof(user_regs_struct) = 216`），放在 `PT_NOTE` 中紧凑高效。如果每个线程一个 `PT_LOAD` 段，每段至少一个页（4096 字节），50 线程浪费 ~200KB

**Counterfactual**: 如果寄存器快照放在独立的 `PT_LOAD` 段中，`core_read_data()` 可以直接读取，无需解析 `PT_NOTE` 和 `Elf64_Nhdr` 链表。但这需要 SA 维护线程 ID → 独立段的映射（额外复杂），且浪费 core 文件空间。

### 2.4 Linux 与 Solaris PT_NOTE 格式差异 [ps_core.c:643-663]

```c
// ps_core.c:643-663 的注释详细解释了差异
//
// Linux:
//   每个 clone'd 线程有一个独立的 prstatus 条目
//   NT_PRSTATUS[0] = 主线程寄存器
//   NT_PRSTATUS[1] = 线程 1 寄存器
//   ...
//
// Solaris:
//   PT_NOTE 只有一个 prstatus 条目（主要是主线程）
//   其他线程的寄存器需要从 lwp status 读取（独立的结构）
//
// SA 需要处理 Linux 格式：遍历所有 NT_PRSTATUS 条目，
// 每个条目创建一个 thread_info 节点
```

### 2.5 ELF 关键结构体速查（man 5 elf）

| 结构体 | 大小 | 定义位置 | 用途 |
|--------|------|---------|------|
| `Elf64_Ehdr` | 64 字节 | `elf.h:347-384` | ELF 文件头（e_type, e_phoff, e_entry） |
| `Elf64_Phdr` | 56 字节 | `elf.h:422-449` | Program Header（p_type, p_offset, p_vaddr, p_filesz） |
| `Elf64_Nhdr` | 12 字节 | `elf.h:1136-1142` | Note Header（n_namesz, n_descsz, n_type） |
| `Elf64_Shdr` | 64 字节 | `elf.h:482-511` | Section Header（sh_name, sh_type, sh_offset, sh_size） |
| `Elf64_Dyn` | 16 字节 | `elf.h:887-898` | Dynamic Section（d_tag, d_un） |
| `user_regs_struct` | ~216 字节 | `<sys/user.h>` | x86_64 通用寄存器集（r15-r8, rdi, rsi, rbp, rbx, rdx, rcx, rax, rsp, rip 等） |

### 2.6 项目环境信息

**Source Roots**:
```
src/jdk.hotspot.agent/linux/native/libsaproc/ps_core.c     # Postmortem Mode 实现 (1100+ 行)
src/jdk.hotspot.agent/linux/native/libsaproc/libproc_impl.h # 核心数据结构 (127 行)
src/jdk.hotspot.agent/linux/native/libsaproc/salibelf.c    # ELF 辅助函数 (130 行)
src/jdk.hotspot.agent/linux/native/libsaproc/libproc_impl.c # 公共实现 (420 行)
```

**Build**:
```bash
make hotspot-native   # 单独构建 libsaproc.so
make images           # 全量构建
```

**Key Binaries**:
```
support/native/jdk.hotspot.agent/libsaproc/libsaproc.so   # 构建产物
images/jdk/lib/libsaproc.so                               # JDK 镜像产物
```

**Syscall 速查**: `open(2)` / `pread(2)` / `read(2)` / `lseek(2)` / `close(2)` — 详见附录 B。

---

## §三 read_core_segments() 深度分析

### 3.1 函数概览 [ps_core.c:635-691]

**用途**: 遍历 core 文件的 Program Header Table，将 `PT_LOAD` 段加入 `map_info` 链表（可写内存映射），将 `PT_NOTE` 段解析为线程寄存器快照和 auxv 向量。

```c
// ps_core.c:635-691
static bool read_core_segments(struct ps_prochandle* ph,
                                ELF_EHDR* core_ehdr) {
   // Step 1: 读取 core 文件的 Program Header Table
   ELF_PHDR* phbuf = read_program_header_table(
       ph->core->core_fd, core_ehdr);
   if (phbuf == NULL) return false;

   // Step 2: 遍历所有 Program Header
   for (int i = 0; i < core_ehdr->e_phnum; i++) {
      ELF_PHDR* phdr = &phbuf[i];
      switch (phdr->p_type) {
      case PT_NOTE:
         // 解析 note 段（线程寄存器、auxv）
         if (!core_handle_note(ph, phdr)) {
            free(phbuf);
            return false;
         }
         break;

      case PT_LOAD:
         // 忽略空段
         if (phdr->p_filesz == 0) break;
         // 将可写内存映射加入 map_info 链表
         add_map_info(ph, ph->core->core_fd, phdr->p_offset,
                      phdr->p_vaddr, phdr->p_filesz, phdr->p_flags);
         break;
      }
   }

   free(phbuf);
   return true;
}
```

### 3.2 PT_LOAD 处理：add_map_info() [ps_core.c:674-679]

`PT_LOAD` 段代表进程的虚拟内存映射。Core dump 中的 `PT_LOAD` 段是**可写内存**的快照（堆、栈、BSS 段、数据段）：

```c
// ps_core.c:124-137
static map_info* add_map_info(struct ps_prochandle* ph, int fd,
                               off_t offset, uintptr_t vaddr,
                               size_t memsz, uint32_t flags) {
   map_info* map;
   if ((map = allocate_init_map(fd, offset, vaddr, memsz, flags)) == NULL) {
      return NULL;
   }
   // add this to map list
   map->next  = ph->core->maps;
   ph->core->maps   = map;
   ph->core->num_maps++;
   return map;
}
```

**关键设计**:
- **头插法（O(1) 插入）**: `mp->next = ph->core->maps; ph->core->maps = mp;`——不关心顺序，因为 `sort_map_array()` 会重新排序
- **p_filesz vs p_memsz**: Core dump 使用 `p_filesz` 而非 `p_memsz`，因为 core 文件可能截断小于页的内存映射
- **flags 字段**: `PF_R = 0x4`, `PF_W = 0x2`, `PF_X = 0x1`——用于后续段冲突解决（见 §五）

**allocate_init_map()** (`ps_core.c:107-121`):

```c
static map_info* allocate_init_map(int fd, off_t offset,
                                    uintptr_t vaddr, size_t memsz,
                                    uint32_t flags) {
   map_info* map;
   if ((map = (map_info*)calloc(1, sizeof(map_info))) == NULL) {
      print_debug("can't allocate memory for map_info\n");
      return NULL;
   }
   // initialize map
   map->fd     = fd;
   map->offset = offset;
   map->vaddr  = vaddr;
   map->memsz  = memsz;
   map->flags  = flags;
   return map;
}
```

`allocate_init_map()` **接收 5 个参数**：`fd`（文件描述符）、`offset`（文件偏移）、`vaddr`（虚拟地址）、`memsz`（映射大小）、`flags`（权限标志）。这些参数由调用方 `add_map_info()` 从 `PT_LOAD` 的 Program Header 提取后传入，避免了函数内部分层获取的重复逻辑。

> **man 3 calloc**: 与 `malloc` 不同，`calloc` 将内存初始化为 0，避免未初始化字段导致的不确定行为。

### 3.3 为什么 core 文件中的 PT_LOAD 只有可写段？

**内核策略** (`fs/binfmt_elf.c` 的 `elf_core_dump()`): core dump 只包含**标记有 `PF_W`（可写）的 VMA**。原因是：
1. **空间优化**: 只读段（`.text`、`.rodata`）的内容与磁盘上的可执行文件/共享库完全相同，dump 它们浪费空间
2. **可恢复性**: 只读段可以从原始文件恢复——这正是 `read_lib_segments()` 的作用
3. **性能**: dump 8GB+ 的 core 文件可能导致磁盘 I/O 瓶颈和 OOM

**Counterfactual**: 如果 core dump 包含所有页（可读+可写），SA 不需要 `read_exec_segments()` / `read_lib_segments()` 从 `.so` 文件补读只读段。但这会：
- 显著增大 core 文件（JVM 的 `libjvm.so` 代码段 ~20MB）
- 增加 dump 延迟（高峰时段 8GB 进程需要 ~30 秒 dump）
- 后续从 core 文件读取 vs 磁盘文件读取无性能差异（都是 `pread(2)`）

### 3.4 PT_NOTE 处理：core_handle_note() [ps_core.c:669-671]

由 `core_handle_note()` 解析，详见 **§四 core_handle_prstatus()**。

### 3.5 read_program_header_table() [salibelf.c:48-65]

```c
// salibelf.c:48-65
ELF_PHDR* read_program_header_table(int fd, ELF_EHDR* hdr) {
   // 计算 PHT 总字节数
   size_t nbytes = hdr->e_phnum * hdr->e_phentsize;
   ELF_PHDR* phbuf = (ELF_PHDR*)malloc(nbytes);
   if (phbuf == NULL) {
      print_debug("can't allocate memory for reading program headers");
      return NULL;
   }
   // 从 hdr->e_phoff 偏移读取整个 PHT
   if (pread(fd, phbuf, nbytes, hdr->e_phoff) != nbytes) {
      print_debug("can't read program header table");
      free(phbuf);
      return NULL;
   }
   return phbuf;
}
```

> **man 2 pread**: `pread(fd, buf, count, offset)` 从文件偏移 `offset` 读取 `count` 字节，不改变文件描述符的当前位置。等价于 `lseek(offset) + read(count) + lseek(back)`，但原子性更好（无竞态条件）。

---

## §四 core_handle_prstatus() + thread_info 链表

### 4.1 core_handle_note() 的 note 解析循环 [ps_core.c:574-632]

**核心逻辑**:

```
1. lseek(core_fd, note_phdr->p_offset, SEEK_SET)  ← 定位到 PT_NOTE 数据起始
2. malloc(p_filesz) → buf                          ← 分配缓冲区
3. read(core_fd, buf, size)                        ← 读取整个 note 段
4. 遍历 note 链表:
   p = buf
   while (p < buf + size):
     notep = (ELF_NHDR*)p
     descdata = p + sizeof(ELF_NHDR) + ROUNDUP(notep->n_namesz, 4)
     switch (notep->n_type):
       case NT_PRSTATUS:
         core_handle_prstatus(ph, descdata, notep->n_descsz)
       case NT_AUXV:
         遍历 auxv 数组，找 AT_ENTRY → ph->core->dynamic_addr
     p = descdata + ROUNDUP(notep->n_descsz, 4)
5. free(buf)
```

**Note 对齐公式详解**:
```c
// ps_core.c:571
#define ROUNDUP(x, y)  ((((x)+((y)-1))/(y))*(y))
```

// Note 结构:
// | Elf64_Nhdr (12 字节) | name (n_namesz 字节) | desc (n_descsz 字节) |
//                         ↑ 4 字节对齐           ↑ 4 字节对齐
```

> **man 5 elf** "Note Information" 部分规定: name 和 descriptor 都必须是 4 字节对齐的。`ROUNDUP(n, 4)` 确保对齐。

### 4.2 core_handle_prstatus() — 保存寄存器到 thread_info [ps_core.c:509-569]

```c
// ps_core.c:509-569
static bool core_handle_prstatus(struct ps_prochandle* ph,
                                  const char* buf, size_t nbytes) {
   const prstatus_t* prstat = (const prstatus_t*)buf;
   lwpid_t lwp_id = prstat->pr_pid;      // 线程 ID

   // 创建 thread_info 节点
   thread_info* newthr = add_thread_info(ph, lwp_id);
   if (newthr != NULL) {
      // 复制完整的 x86_64 寄存器集
      memcpy(&newthr->regs, prstat->pr_reg,
             sizeof(struct user_regs_struct));
   }
   return (newthr != NULL);
}
```

**prstatus_t 结构体** (参考 `/usr/include/sys/procfs.h`):

```c
struct elf_prstatus {
   struct elf_siginfo pr_info;     // 信号信息（si_signo, si_code, si_errno）
   short pr_cursig;                // 当前未决信号
   unsigned long pr_sigpend;       // 未决信号位图
   unsigned long pr_sighold;       // 阻塞信号位图
   pid_t pr_pid;                   // 线程 ID（== gettid()）
   pid_t pr_ppid;                  // 父进程 ID
   pid_t pr_pgrp;                  // 进程组 ID
   pid_t pr_sid;                   // session ID
   struct timeval pr_utime;        // 用户态 CPU 时间
   struct timeval pr_stime;        // 内核态 CPU 时间
   struct timeval pr_cutime;       // 累计子进程用户态时间
   struct timeval pr_cstime;       // 累计子进程内核态时间
   elf_gregset_t pr_reg;           // ← 核心：通用寄存器快照
   int pr_fpvalid;                 // 浮点寄存器是否有效
};
```

### 4.3 x86_64 寄存器布局：user_regs_struct [ps_core.c:536-565]

SA 中定义了 `user_regs_struct` 的 offset 映射（用于按索引访问单个寄存器）:

```c
// ps_core.c:536-565
#ifndef AMD64
#define REG_INDEX(reg) offsetof(struct user_regs_struct, reg)
static const int core_prstatus_reg_offsets[] = {
   REG_INDEX(r15), REG_INDEX(r14), REG_INDEX(r13), REG_INDEX(r12),
   REG_INDEX(rbp), REG_INDEX(rbx), REG_INDEX(r11), REG_INDEX(r10),
   REG_INDEX(r9),  REG_INDEX(r8),  REG_INDEX(rax), REG_INDEX(rcx),
   REG_INDEX(rdx), REG_INDEX(rsi), REG_INDEX(rdi), -1,  // orig_rax
   REG_INDEX(rip), REG_INDEX(cs),  REG_INDEX(eflags),
   REG_INDEX(rsp), REG_INDEX(ss),  REG_INDEX(fs_base),
   REG_INDEX(gs_base), REG_INDEX(ds), REG_INDEX(es),
   REG_INDEX(fs),   REG_INDEX(gs)
};
#endif
```

> `man 5 elf` 不定义 `user_regs_struct`，它定义在 `<sys/user.h>` 中。

### 4.4 core_get_lwp_regs() — 获取线程寄存器 [ps_core.c:487-499]

```c
// ps_core.c:487-499
static bool core_get_lwp_regs(struct ps_prochandle* ph, lwpid_t lwp_id,
                               struct user_regs_struct* regs) {
   // 遍历 thread_info 链表找到匹配的线程
   for (thread_info* thr = ph->threads; thr != NULL; thr = thr->next) {
      if (thr->lwp_id == lwp_id) {
         *regs = thr->regs;     // 复制寄存器快照
         return true;
      }
   }
   return false;  // 线程未找到
}
```

**查找复杂度**: O(N)，N = 线程数。典型 JVM 有 ~50 线程，线性查找足够快。

### 4.5 与 Live Mode 的 process_get_lwp_regs() 对比

| 特性 | Postmortem (`core_get_lwp_regs`) | Live (`process_get_lwp_regs`) |
|------|--------------------------------|-------------------------------|
| 寄存器来源 | core 文件的 `NT_PRSTATUS` 缓存 | `/proc/pid/task/[tid]/stat` 或 `ptrace(PTRACE_GETREGS)` |
| 获取方式 | `memcpy` 从 `thread_info->regs` | 系统调用 `ptrace(2)` |
| 系统调用次数 | 0 | 1 per thread |
| 性能 | ~10ns（内存复制） | ~1μs（ptrace 系统调用） |
| 有效性 | 崩溃时刻的快照（静态） | 实时值（可能变化） |

---

## §五 read_exec_segments() 与 read_lib_segments()

### 5.1 read_exec_segments() 概览 [ps_core.c:782-849]

**三合一函数**: 同时处理可执行文件的三个关键部分——代码段映射、解释器路径、`_DYNAMIC` 段地址。

```c
// ps_core.c:782-849
static uintptr_t read_exec_segments(struct ps_prochandle* ph,
                                     ELF_EHDR* exec_ehdr) {
   uintptr_t result = 0L;
   // Step 1: 读取可执行文件的 Program Header Table
   ELF_PHDR* phbuf = read_program_header_table(ph->core->exec_fd, exec_ehdr);
   if (phbuf == NULL) return 0L;

   for (int i = 0; i < exec_ehdr->e_phnum; i++) {
      ELF_PHDR* phdr = &phbuf[i];

      switch (phdr->p_type) {
      case PT_LOAD:
         // 只添加非可写且非空的段（只读代码/数据段）
         if (!(phdr->p_flags & PF_W) && phdr->p_filesz != 0) {
            add_map_info(ph, ph->core->exec_fd, phdr->p_offset,
                         phdr->p_vaddr, phdr->p_filesz, phdr->p_flags);
         }
         break;

      case PT_INTERP:
         // 读取解释器路径（如 "/lib64/ld-linux-x86-64.so.2"）
         {
            char interp_name[PATH_MAX];
            pread(ph->core->exec_fd, interp_name, phdr->p_filesz, phdr->p_offset);
            interp_name[phdr->p_filesz] = '\0';
            ph->core->interp_fd = pathmap_open(interp_name);
         }
         break;

      case PT_DYNAMIC:
         if (exec_ehdr->e_type == ET_EXEC) {
            // 传统可执行文件：直接使用 p_vaddr
            result = phdr->p_vaddr;
            // ET_EXEC 也需要设置 dynamic_addr，供后续 read_shared_lib_info 使用
            ph->core->dynamic_addr = phdr->p_vaddr;
         } else {
            // PIE：需要从 NT_AUXV 反推基址
            result = ph->core->dynamic_addr - exec_ehdr->e_entry;
            // 调整 dynamic_addr 以修正 PIE 偏移
            ph->core->dynamic_addr += phdr->p_vaddr - exec_ehdr->e_entry;
         }
         print_debug("address of _DYNAMIC is 0x%lx\n", ph->core->dynamic_addr);
         break;
      }
   }

   free(phbuf);
   return result;
}
```

### 5.2 PT_LOAD（非可写段）处理 [ps_core.c:796-802]

**为什么只添加非可写段？**

1. **可写段已在 core 文件中**: `read_core_segments()` 已将 core 文件的所有 `PT_LOAD` 段（可写内存快照）加入 `map_info`
2. **只读段需要从原始文件补读**: core 文件可能不包含只读段，需要从可执行文件/共享库补读
3. **冲突解决**: 如果 core 文件已经包含某个地址范围（`p_flags & PF_W`），优先级高于原始文件——因为 core 文件反映崩溃时的真实内存状态

**Counterfactual**: 如果从可执行文件添加所有 PT_LOAD 段（包括可写段），可执行文件中的数据段（`.data`/`.bss`）会覆盖 core 文件中运行时修改过的数据——导致读取到过时的值。

### 5.3 PT_INTERP 处理：解释器路径 + open(interp_fd) [ps_core.c:805-825]

```c
// ps_core.c:805-825
case PT_INTERP:
{
   char interp_name[BUF_SIZE];
   // 读取解释器路径字符串
   pread(ph->core->exec_fd, interp_name, phdr->p_filesz, phdr->p_offset);
   interp_name[phdr->p_filesz - 1] = '\0';  // 截断（路径通常以 \n 或 \0 结尾）
   ph->core->interp_fd = pathmap_open(interp_name);
   break;
}
```

**解释器路径示例**:
- 64-bit Linux: `/lib64/ld-linux-x86-64.so.2`
- 32-bit Linux: `/lib/ld-linux.so.2`

**pathmap_open()** (`libproc_impl.c:35`): 路径映射打开。支持 `SA_ALTROOT` 环境变量——如果设置了 `SA_ALTROOT`，会在备选根目录中搜索文件（用于交叉调试场景）。

**为什么需要打开 ld.so？** 后续的 `read_shared_lib_info()` 需要从 ld.so 的段读取 `r_debug` 结构体，而 `read_interp_segments()` (`ps_core.c:764`) 负责将 ld.so 的段加入 `map_info` 链表。

### 5.4 PT_DYNAMIC 处理：两种格式的 dynamic_addr 计算 [ps_core.c:828-838]

```c
// ps_core.c:828-838
case PT_DYNAMIC:
{
   if (exec_ehdr->e_type == ET_EXEC) {
      // 传统可执行文件（非 PIE）：dynamic_addr = PT_DYNAMIC.p_vaddr
      result = phdr->p_vaddr;
   } else {
      // PIE (ET_DYN)：基址 = dynamic_addr - e_entry
      // dynamic_addr 来自 NT_AUXV 的 AT_ENTRY
      result = ph->core->dynamic_addr - exec_ehdr->e_entry;
      // 修正 dynamic_addr 以包含 PIE 的额外偏移
      ph->core->dynamic_addr += phdr->p_vaddr - exec_ehdr->e_entry;
   }
   break;
}
```

**公式详解**:

```
ET_EXEC（传统可执行文件）:
  result = PT_DYNAMIC.p_vaddr
  ph->core->dynamic_addr = PT_DYNAMIC.p_vaddr  ← 隐式设置（ET_EXEC 也需要 dynamic_addr！）
  因为加载基址固定为 0，virtual address === file offset

ET_DYN（PIE 可执行文件）:
  result = ph->core->dynamic_addr - e_entry
  ph->core->dynamic_addr += PT_DYNAMIC.p_vaddr - e_entry
  因为 PIE 的加载基址被 ASLR 随机化，需要从 AT_ENTRY（实际入口地址）反推
```

### 5.5 read_lib_segments() 详解 [ps_core.c:694-761]

**用途**: 读取共享库的只读段，解决与 core dump PT_LOAD 段之间的地址冲突。

```c
// ps_core.c:694-761
static bool read_lib_segments(struct ps_prochandle* ph, int lib_fd,
                               ELF_EHDR* lib_ehdr, uintptr_t lib_base) {
   // Step 1: 读取 Program Header Table（lib_ehdr 由调用方传入，无需重新读取）
   ELF_PHDR* phbuf = read_program_header_table(lib_fd, lib_ehdr);
   if (phbuf == NULL) return false;

   // Step 2: 遍历 PT_LOAD 段 — 只处理非可写且非空的只读段
   for (int i = 0; i < lib_ehdr->e_phnum; i++) {
      ELF_PHDR* phdr = &phbuf[i];
      if (phdr->p_type != PT_LOAD) continue;
      if (phdr->p_flags & PF_W) continue;   // 跳过可写段（core 文件已有）
      if (phdr->p_filesz == 0) continue;    // 跳过空段

      uintptr_t target_vaddr = lib_base + phdr->p_vaddr;
      map_info* existing = core_lookup(ph, target_vaddr);

      if (existing == NULL) {
         // 情况 1: 该地址没有现有映射 → 直接添加
         add_map_info(ph, lib_fd, phdr->p_offset, target_vaddr,
                       phdr->p_filesz, phdr->p_flags);
      } else if (existing->flags != phdr->p_flags) {
         // 情况 2: 权限不同（mprotect 导致）→ 尊重 core dump
         continue;
      } else if (existing->fd == lib_fd) {
         // 情况 3: 同一个 fd → 跳过
         continue;
      } else {
         // 情况 4: 冲突 → 替换 core 映射为库映射
         // 原因: ELF header 第一页可能在 core dump 中存在 (JDK-7133122)
         existing->fd     = lib_fd;
         existing->offset = phdr->p_offset;
         existing->memsz  = phdr->p_memsz;
      }
   }
   free(phbuf);
   return true;
}
```

**冲突解决的四种情况**:

| 情况 | 现有映射 | 库映射 | 处理 |
|------|---------|-------|------|
| 1 | 无 | 有 | 直接添加库映射 |
| 2 | 有，权限不同 | 有，权限不同 | 尊重 core dump（运行时 `mprotect` 修改了权限） |
| 3 | 有，同 fd | 有，同 fd | 跳过（已经添加过） |
| 4 | 有，不同 fd | 有，同权限 | 替换为库映射（core 文件可能截断只读段） |

**为什么替换 core 映射为库映射？** JDK-7133122：ELF header 的第一页可能在 core dump 中存在（即使它是只读的），但 core dump 中的版本可能被截断或不完整。从 `.so` 文件读取更可靠。

### 5.6 read_interp_segments() — 解释器段 [ps_core.c:764-780]

```c
// ps_core.c:764-778
static bool read_interp_segments(struct ps_prochandle* ph) {
   ELF_EHDR interp_ehdr;

   if (read_elf_header(ph->core->interp_fd, &interp_ehdr) != true) {
      print_debug("interpreter is not a valid ELF file\n");
      return false;
   }

   if (read_lib_segments(ph, ph->core->interp_fd, &interp_ehdr,
                         ph->core->ld_base_addr) != true) {
      print_debug("can't read segments of interpreter\n");
      return false;
   }

   return true;
}
```

**在调用链中的位置**: `read_shared_lib_info()` → `read_interp_segments(ph)` → `read_lib_segments(ph, interp_fd, &interp_ehdr, ld_base_addr)`

这确保了 `ld-linux.so` 的段在遍历 `link_map` 之前就可读——因为 `link_map` 链表头在 `r_debug` 结构体中（存储在 ld.so 的数据段），需要通过 `ps_pdread()` 读取，而 `ps_pdread()` 依赖已有映射。

---

## §六 core_read_data() 内存读取深度分析

### 6.1 完全代码走读 [ps_core.c:431-479]

```c
// ps_core.c:431-479
static bool core_read_data(struct ps_prochandle* ph, uintptr_t addr,
                            char* buf, size_t size) {
   size_t resid = size;          // 剩余待读取字节
   int page_size = sysconf(_SC_PAGE_SIZE);  // 通常是 4096

   while (resid != 0) {
      // Step 1: 二分查找包含 addr 的 map_info
      map_info* mp = core_lookup(ph, addr);
      if (mp == NULL) {
         // 地址不在任何映射中 → 失败
         print_debug("Can't find map for address %p\n", addr);
         break;
      }

      // Step 2: 计算文件偏移
      int fd = mp->fd;                           // core_fd/exec_fd/lib_fd
      uintptr_t mapoff = addr - mp->vaddr;       // 地址在映射中的偏移
      size_t len = MIN(resid, mp->memsz - mapoff);  // 本次最多读取字节
      off_t off = mp->offset + mapoff;          // 文件中的绝对偏移

      // Step 3: 用 pread 读取
      if (pread(fd, buf, len, off) <= 0) {
         break;  // read 失败
      }

      resid -= len;
      addr  += len;
      buf   += len;

      // Step 4: 处理尾部不足一页的部分（填充 0）
      size_t rem = mp->memsz % page_size;
      if (rem > 0) {
         rem = page_size - rem;                // 不足一页的字节数
         len = MIN(resid, rem);
         memset(buf, 0, len);                 // 填充 0
         resid -= len;
         addr  += len;
         buf   += len;
      }
   }

   return (resid == 0);  // 全部读取成功 → true
}
```

**关键设计点**:

1. **pread 而非 read**: `pread(fd, buf, len, off)` 不改变文件描述符位置。多 fd 场景下（core/exec/lib），`read()` 的隐式偏移会导致难以追踪的 bug——因为同一个 fd 可能被多次调用，偏移混乱。

2. **尾部填零** (`ps_core.c:460-469`): core dump 中的 `PT_LOAD` 段可能不覆盖页的末尾部分（`memsz % page_size != 0`）。对于这些未捕获的字节，必须返回 0。

3. **跨映射自动处理**: `while (resid != 0)` 循环自动处理跨映射读取——每次循环调用 `core_lookup(ph, addr)` 重新查找。

### 6.2 core_lookup() 二分查找详解 [ps_core.c:155-199]

```c
// ps_core.c:155-199
static map_info* core_lookup(struct ps_prochandle* ph, uintptr_t addr) {
   int mid, lo = 0, hi = ph->core->num_maps - 1;
   map_info* mp;

   // Step 1: 二分查找 — 收缩区间直到 hi - lo <= 1
   while (hi - lo > 1) {
      mid = (lo + hi) / 2;
      if (addr >= ph->core->map_array[mid]->vaddr) {
         lo = mid;
      } else {
         hi = mid;
      }
   }

   // Step 2: 检查 lo 或 hi
   if (addr < ph->core->map_array[hi]->vaddr) {
      mp = ph->core->map_array[lo];
   } else {
      mp = ph->core->map_array[hi];
   }

   // Step 3: 验证地址在映射范围内
   if (addr >= mp->vaddr && addr < mp->vaddr + mp->memsz) {
      return (mp);    // 命中！
   }

   // Step 4: CDS fallback — 线性搜索 class_share_maps
   // （不排序、不加入 map_array，防止 -Xshare:off 时误匹配）
   mp = ph->core->class_share_maps;
   if (mp) {
      print_debug("can't locate map_info at 0x%lx, trying class share maps\n", addr);
   }
   while (mp) {
      if (addr >= mp->vaddr && addr < mp->vaddr + mp->memsz) {
         print_debug("located map_info at 0x%lx from class share maps\n", addr);
         return (mp);
      }
      mp = mp->next;
   }

   return NULL;  // 完全未找到
}
```

**二分查找的特殊之处**: 停止条件是 `hi - lo > 1`（即 `lo` 和 `hi` 相邻），而非传统的 `lo <= hi`。这使算法在收敛后只需要检查 `lo` 和 `hi` 两个候选：若 `addr < map_array[hi]->vaddr` 则命中 `lo`，否则命中 `hi`。传统 `lo <= hi` 的二分查找在每个元素上检查是否命中（O(log n) 次），而此变体只需在最后检查 1 次——在边界情况的处理更简洁。

**CDS fallback 的设计意图**: `class_share_maps` 不加入 `map_array`，只在 fallback 中被线性搜索。原因：
- CDS 区域（classes.jsa 中的只读区域）与 core 文件中的映射可能冲突
- 当 `-Xshare:off` 时，CDS 数据可能无效——优先返回 core 文件中的映射
- CDS 区域数量通常 < 5，线性搜索 O(5) 可忽略不计

### 6.3 fd 分派逻辑

| fd 类型 | 来源 | 对应的地址范围 | 为什么用这个 fd？ |
|---------|------|---------------|----------------|
| `core_fd` | `Pgrab_core()` 中 `open(core_file)` (`ps_core.c:1072`) | Core 文件的 `PT_LOAD` 段（可写段：堆、栈、BSS、数据） | Core 文件包含进程崩溃时的**内存快照**，可写段必须从 core 文件读取 |
| `exec_fd` | `Pgrab_core()` 中 `open(exec_file)` (`ps_core.c:1083`) | 可执行文件的**非可写** `PT_LOAD` 段（`.text` 代码段） | Core 文件可能**不包含**只读段（内核优化），需要从原始可执行文件读取 |
| `lib_fd` | `read_shared_lib_info()` 中 `pathmap_open(lib_name)` (`ps_core.c:998`) | 共享库的**非可写** `PT_LOAD` 段（`.text` 代码段、`.rodata` 只读数据段） | 同上，共享库的只读段也需要从 `.so` 文件读取 |

**分派决策**: `core_lookup()` 根据虚拟地址二分查找 `map_array`，找到的 `map_info` 包含 `fd` 字段——`core_read_data()` 从该 `fd` 读取。

### 6.4 性能分析

**pread vs ptrace 量化对比**:

| 操作 | Postmortem (pread) | Live (ptrace PEEKDATA) | 加速比 |
|------|-------------------|------------------------|--------|
| 读取 4 字节 | 1 次 `pread(2)` | 1 次 `ptrace(2)` | ~1x |
| 读取 4KB | 1 次 `pread(2)` | 1024 次 `ptrace(2)`（每次 4 字节） | **~1000x** |
| 读取 1MB | 1 次 `pread(2)` | 262144 次 `ptrace(2)` | **~250000x** |
| 系统调用开销（每次） | ~200ns (syscall) | ~500ns (ptrace 更慢 + user/kernel 切换) | ~2.5x per-call |

**核心原因**: `ptrace(PEEKDATA)` 每次只能读 `sizeof(void*)` 字节（8 字节 on 64-bit），而 `pread` 可以一次读取任意大小。对于 SA 的典型负载（读取 Java 对象/OOP/方法表，通常 8-256 字节），`pread` 优势明显但不如 1MB 场景极端。

**map_array 排序性能量化**:

假设 50 个 PT_LOAD 段（典型 JVM 进程）:

| 方案 | 查找复杂度 | 50 次查找的比较次数 | 内存 |
|------|-----------|---------------------|------|
| 遍历 maps 链表 | O(n) = 50 | 50 × 50 / 2 = **1250** | O(n) 指针 |
| map_array 二分查找 | O(log n) = 6 | 50 × 6 = **300** | O(n) 额外指针 |
| **加速比** | **~4x** | - | +50 个指针（400 字节） |

**Counterfactual**: 如果用平衡树（如红黑树）替代排序数组，查找也是 O(log n)，但：
- 平衡树每个节点有额外 overhead（3 个指针：parent/left/right）
- 需要 rebalance 操作（旋转 + 颜色翻转）
- 但插入是 O(log n) 而非 `sort_map_array` 的 O(n log n)
- 对于 99% 只读的场景（maps 在初始化后不变），排序数组更简单且 cache-friendly

---

## §七 read_shared_lib_info() 链接映射重建

### 7.1 为什么需要重建链接映射？

Live Mode 中，SA 可以直接:
1. 调用 `dlopen()` 加载共享库 → 在自身进程中访问符号
2. 读取 `/proc/pid/maps` → 获取所有映射文件的路径和加载基址

Postmortem Mode 中，**两者都不可用**:
- `dlopen()` 无效（目标进程已崩溃）
- `/proc/pid/maps` 不存在（进程已终止）

必须在 core dump 中**重建链接映射**——找到所有已加载共享库的路径和加载基址。

### 7.2 算法：从 _DYNAMIC 开始 [ps_core.c:906-1044]

```
可执行文件的 _DYNAMIC 段
  ↓ 遍历 Elf64_Dyn 数组
DT_DEBUG (d_tag = 21)
  ↓ d_un.d_ptr → r_debug 结构体的虚拟地址
r_debug.r_map
  ↓ 指向第一个 link_map 结构体（通常是 ld-linux.so 自身）
link_map 链表遍历:
  l_addr   → 加载基址偏移（= 实际地址 - vaddr）
  l_name   → 共享库路径字符串
  l_ld     → 该库的 _DYNAMIC 段地址
  l_next   → 下一个 link_map
```

**关键宏定义** (`ps_core.c:852-858`):

```c
#define FIRST_LINK_MAP_OFFSET offsetof(struct r_debug, r_map)
#define LD_BASE_OFFSET       offsetof(struct r_debug, r_ldbase)
#define LINK_MAP_ADDR_OFFSET offsetof(struct link_map, l_addr)
#define LINK_MAP_NAME_OFFSET offsetof(struct link_map, l_name)
#define LINK_MAP_LD_OFFSET   offsetof(struct link_map, l_ld)
#define LINK_MAP_NEXT_OFFSET offsetof(struct link_map, l_next)
```

使用 `offsetof` 而非硬编码，因为 `r_debug` 和 `link_map` 的布局在不同 glibc 版本中可能变化。

### 7.3 遍历 _DYNAMIC 段找 DT_DEBUG [ps_core.c:927-933]

```c
// ps_core.c:927-933
static bool read_shared_lib_info(struct ps_prochandle* ph) {
   uintptr_t dynamic_addr = ph->core->dynamic_addr;
   uintptr_t debug_base = 0;
   ELF_DYN dyn;
   while (true) {
      // 通过 core_read_data 读取一个 Elf64_Dyn 条目
      if (ps_pdread(ph, dynamic_addr, &dyn, sizeof(ELF_DYN)) != PS_OK)
         break;
      if (dyn.d_tag == DT_DEBUG) {
         debug_base = dyn.d_un.d_ptr;  // 找到了！
         break;
      }
      if (dyn.d_tag == DT_NULL)
         break;
      dynamic_addr += sizeof(ELF_DYN);
   }
   if (debug_base == 0) {
      print_debug("Could not find DT_DEBUG\n");
      return false;
   }
```

`_DYNAMIC` 段是一个 `Elf64_Dyn` 数组，以 `d_tag == DT_NULL (0)` 结束。`DT_DEBUG = 21` 表示 `d_un.d_ptr` 指向 `r_debug` 结构体。

> **man 5 elf** 的 "Dynamic Section" 部分: `DT_DEBUG` 用于调试——`d_ptr` 指向动态链接器维护的调试信息。

### 7.4 读取 r_debug 结构体 [ps_core.c:938-950]

```c
   // ps_core.c:938-950
   // 从 r_debug.r_map 读取第一个 link_map 的地址
   uintptr_t first_link_map_addr = 0;
   ps_pdread(ph, debug_base + FIRST_LINK_MAP_OFFSET,
             &first_link_map_addr, sizeof(uintptr_t));

   // 从 r_debug.r_ldbase 读取 ld.so 的基址
   ps_pdread(ph, debug_base + LD_BASE_OFFSET,
             &ph->core->ld_base_addr, sizeof(uintptr_t));
```

`r_debug` 结构体 (glibc 内部，定义在 `sysdeps/generic/ldsodefs.h`):
- `r_version`: 版本号
- `r_map`: 指向 `link_map` 链表头
- `r_brk`: 断点地址（动态链接器的 hook）
- `r_state`: 链接状态（`RT_CONSISTENT`/`RT_ADD`/`RT_DELETE`）
- `r_ldbase`: ld.so 自身的加载基址

### 7.5 遍历 link_map 链表 [ps_core.c:966-1041]

```c
   // ps_core.c:966-1041
   uintptr_t link_map_addr = first_link_map_addr;
   while (link_map_addr != 0) {
      // ① 读取 l_addr（加载基址偏移）
      uintptr_t lib_base_diff = 0;
      ps_pdread(ph, link_map_addr + LINK_MAP_ADDR_OFFSET,
                &lib_base_diff, sizeof(uintptr_t));

      // ② 读取共享库名称地址
      uintptr_t str_addr = 0;
      ps_pdread(ph, link_map_addr + LINK_MAP_NAME_OFFSET,
                &str_addr, sizeof(uintptr_t));

      // ③ 逐字节读取库名称字符串
      char lib_name[PATH_MAX] = {0};
      if (str_addr != 0) {
         for (int i = 0; i < PATH_MAX; i++) {
            if (ps_pdread(ph, str_addr + i, &lib_name[i], 1) != PS_OK) break;
            if (lib_name[i] == '\0') break;
         }
      }

      // ④ 打开共享库文件
      int lib_fd = pathmap_open(lib_name);
      if (lib_fd < 0) {
         // 库文件不可访问 → 跳过（不中止）
         goto next;
      }

      // ⑤ 处理 prelinked 库
      ELF_EHDR elf_ehdr;
      if (!read_elf_header(lib_fd, &elf_ehdr)) {
         close(lib_fd);
         goto next;
      }
      if (lib_base_diff == 0) {
         // prelinked 库：l_addr == 0 → 需要手动计算基址
         lib_base_diff = calc_prelinked_load_address(link_map_addr, lib_fd, &elf_ehdr);
      }

      // ⑥ 计算加载基址
      uintptr_t lib_base = lib_base_diff + find_base_address(lib_fd, &elf_ehdr);

      // ⑦ 读取只读段映射
      read_lib_segments(ph, lib_fd, &elf_ehdr, lib_base_diff);

      // ⑧ 注册到 lib_info 链表
      add_lib_info_fd(ph, lib_name, lib_fd, lib_base);

      // ⑨ 重新排序（每次添加库后）
      sort_map_array(ph);

   next:
      // ⑩ 读取 l_next → 下一个 link_map
      uintptr_t next_link_map_addr = 0;
      ps_pdread(ph, link_map_addr + LINK_MAP_NEXT_OFFSET,
                &next_link_map_addr, sizeof(uintptr_t));
      link_map_addr = next_link_map_addr;
   }
```

**错误处理策略**: `pathmap_open` 失败 → 跳过该库继续（库可能被卸载或路径不存在）；`read_elf_header` 失败 → 同上。

### 7.6 calc_prelinked_load_address() — Prelink 处理 [ps_core.c:868-902]

```c
// ps_core.c:868-902
static uintptr_t calc_prelinked_load_address(uintptr_t link_map_addr,
                                              int lib_fd, ELF_EHDR* elf_ehdr) {
   ELF_PHDR* phbuf = read_program_header_table(lib_fd, elf_ehdr);
   if (phbuf == NULL) return INVALID_LOAD_ADDRESS;

   uintptr_t lib_dyn_addr = 0;
   // 找 PT_DYNAMIC 段的 p_vaddr
   for (int i = 0; i < elf_ehdr->e_phnum; i++) {
      if (phbuf[i].p_type == PT_DYNAMIC) {
         lib_dyn_addr = phbuf[i].p_vaddr;
         break;
      }
   }
   free(phbuf);

   if (lib_dyn_addr == 0) return INVALID_LOAD_ADDRESS;

   // 从 link_map 读取运行时 l_ld（实际 _DYNAMIC 地址）
   uintptr_t lib_ld = 0;
   ps_pdread(ph, link_map_addr + LINK_MAP_LD_OFFSET,
             &lib_ld, sizeof(uintptr_t));

   // 计算：基址 = 运行时 l_ld - 文件中的 .dynamic vaddr
   return lib_ld - lib_dyn_addr;
}
```

**为什么需要这个函数？** Prelinked 库（`prelink(8)` 工具处理后）的 `link_map.l_addr == 0`（因为 prelink 将加载基址预绑定为固定值）。实际基址可能不同（ASLR 或冲突导致搬迁），必须通过 `l_ld - PT_DYNAMIC.p_vaddr` 反推。

**公式**:
```
lib_base = l_ld - PT_DYNAMIC.p_vaddr
```
这是 `readelf -l <lib.so> | grep DYNAMIC` 的 `VirtAddr` 与运行时 `l_ld` 的差值。

### 7.7 为什么不用 NT_FILE note？

| 特性 | NT_FILE note | link_map 链 |
|------|-------------|-------------|
| 可用性 | 仅 Linux 3.6+ 内核 | 所有 Linux 版本（glibc 2.0+） |
| 信息内容 | 路径 + 偏移 + 地址 | 路径 + 加载基址 + `_DYNAMIC` |
| 可靠性 | 可能不完整（容器环境下路径可能不对） | 动态链接器维护的权威链表 |
| 库已卸载 | 可能仍包含已 `dlclose` 的库 | 不会包含（从链表中移除） |
| 性能 | 直接解析 | 需要逐步遍历（O(n) per lib） |

**SA 的选择**: 永远不用 `NT_FILE`，始终从 `link_map` 链重建——追求兼容性和可靠性。

---

## §八 core_data 结构体的生命周期

### 8.1 结构体定义 [libproc_impl.h:79-92]

```c
struct core_data {
   int                core_fd;          // core 文件 fd
   int                exec_fd;          // 可执行文件 fd
   int                interp_fd;        // ld-linux 解释器 fd
   int                classes_jsa_fd;   // CDS 归档文件 fd
   uintptr_t          dynamic_addr;     // a.out 的 .dynamic 段地址
   uintptr_t          ld_base_addr;     // ld.so 的基地址
   size_t             num_maps;         // maps 链表中的映射数量
   map_info*           maps;            // maps 链表头
   map_info*           class_share_maps;// CDS 专用映射链表
   map_info**          map_array;       // 按 vaddr 排序的指针数组
};
```

### 8.2 生命周期各阶段

| 阶段 | 位置 | 操作 | 填充的字段 |
|------|------|------|-----------|
| **分配** | `ps_core.c:1059-1063` | `calloc(1, sizeof(core_data))` → 全 0 | 全部为 0/NULL |
| **初始化** | `ps_core.c:1066-1069` | `ops = &core_ops` + fd 哨兵 = -1 | `core_fd = -1`, `exec_fd = -1`, `interp_fd = -1` |
| **打开文件** | `ps_core.c:1072-1083` | `open(core_file)` + `open(exec_file)` | `core_fd`, `exec_fd` 有效 |
| **parse core** | `ps_core.c:635-691` | `read_core_segments` → PT_LOAD + PT_NOTE | `maps` 链表, `num_maps++` |
| **note parsing** | `ps_core.c:574-632` | `core_handle_note` → NT_PRSTATUS + NT_AUXV | `dynamic_addr` (从 AT_ENTRY) |
| **parse exec** | `ps_core.c:782-849` | `read_exec_segments` → PT_LOAD/PT_INTERP/PT_DYNAMIC | `maps` 链表, `interp_fd`, `dynamic_addr` |
| **first sort** | `ps_core.c:1112` | `sort_map_array` → 分配 `map_array` + qsort | `map_array`, `num_maps` |
| **rebuild libs** | `ps_core.c:906-1044` | `read_shared_lib_info` → link_map 遍历 | `maps` 链表, `ld_base_addr` |
| **second sort** | `ps_core.c:1121` | `sort_map_array` → 重新排序（新增的 lib 段） | `map_array` 重建 |
| **CDS** | `ps_core.c:256-363` | `init_classsharing_workaround` | `classes_jsa_fd`, `class_share_maps` |
| **release** | `ps_core.c:99-105` | `core_release` → close + free | 全部释放 |

### 8.3 延迟填充的原因

**为什么 `interp_fd` 是延迟填充的？** `interp_fd` 的路径在可执行文件的 `PT_INTERP` 段中——这个信息只有在 `read_exec_segments()` 遍历 PHT 时才能获得。无法在 `Pgrab_core()` 初始化阶段提前知道。

**为什么 `classes_jsa_fd` 是延迟填充的？** 需要符号查找 `SharedArchivePath` → 需要 `lib_info` 链表 → 而 `lib_info` 链表在 `read_shared_lib_info()` 中填充 → 这是最晚的初始化步骤。

**Counterfactual**: 如果所有字段都在 `Pgrab_core()` 中一次性初始化，代码会更简单（单一入口 + 单一初始化）。但这要求：
1. 在打开 core 文件之前就知道 `interp_fd` 路径 → 不可能，因为路径在可执行文件中
2. 在解析共享库之前就知道 CDS 路径 → 不可能，因为需要符号查找
3. 延迟填充是**必要复杂度**，反映了 Postmortem Mode 的渐进式初始化本质——每一步的发现推动下一步的解析

### 8.4 core_release() 清理顺序 [ps_core.c:99-105]

```c
// ps_core.c:99-105
static void core_release(struct ps_prochandle* ph) {
   close_files(ph);              // ① 关闭所有 fd
   destroy_map_info(ph);         // ② 释放 maps + map_array + class_share_maps
   free(ph->core);              // ③ 释放 core_data 结构体自身
}
```

**清理顺序至关重要**: 必须先关闭 fd（`close_files` 遍历 `lib_info` 链表关闭所有共享库 fd），再释放链表（`destroy_map_info` 释放 `map_info` 节点和 `map_array`），最后释放 `core_data` 本体。

**close_files()** [ps_core.c:46-74]:

```c
// ps_core.c:46-74
static void close_files(struct ps_prochandle* ph) {
   // 关闭 4 个主文件描述符
   if (ph->core->core_fd >= 0)       close(ph->core->core_fd);
   if (ph->core->exec_fd >= 0)       close(ph->core->exec_fd);
   if (ph->core->interp_fd >= 0)     close(ph->core->interp_fd);
   if (ph->core->classes_jsa_fd >= 0) close(ph->core->classes_jsa_fd);

   // 关闭所有共享库 fd — 遍历 lib_info 链表（非 map_info！）
   lib_info* lib = ph->libs;
   while (lib) {
      int fd = lib->fd;
      if (fd >= 0 && fd != ph->core->exec_fd) {
         close(fd);
      }
      lib = lib->next;
   }
}
```

> **关键**: `close_files` 遍历的是 **`lib_info` 链表**（`ph->libs`），而非 `map_info` 链表。`map_info` 中每个 PT_LOAD 段都引用同一个 `lib_fd`，遍历 `map_info` 会导致**对同一个 fd 多次调用 `close(2)`**（`man 2 close` 规定这种行为是 UB）。另外只排除 `exec_fd`（因为 `exec_fd` 已在前面单独关闭），不排除 `interp_fd` 和 `classes_jsa_fd`——它们也在前面单独关闭了。

**destroy_map_info()** [ps_core.c:77-96]:

```c
// ps_core.c:77-96
static void destroy_map_info(struct ps_prochandle* ph) {
   // 释放 maps 链表（遍历 + 逐个 free）
   map_info* mp = ph->core->maps;
   while (mp != NULL) {
      map_info* next = mp->next;
      free(mp);
      mp = next;
   }
   // 释放 map_array 指针数组
   free(ph->core->map_array);
   // 释放 class_share_maps 链表
   map_info* cm = ph->core->class_share_maps;
   while (cm != NULL) {
      map_info* next = cm->next;
      free(cm);
      cm = next;
   }
}
```

---

## §九 边缘场景与诊断工具

### 9.1 Core 文件不完整 [ps_core.c:460-469]

**场景**: core 文件被截断（磁盘满、ulimit 限制、崩溃时信号中断），导致 `PT_LOAD` 段的部分页缺失。

**SA 的处理** (`core_read_data()` line 460-469):

```c
// 尾部不足一页 → 填充 0
size_t rem = mp->memsz % page_size;
if (rem > 0) {
   rem = page_size - rem;
   len = MIN(resid, rem);
   memset(buf, 0, len);  // 填充 0（不是 segfault！）
}
```

**设计原理**: 返回 0 比返回错误更好——因为 SA 的上层代码（Java 对象读取/OOP 解引用）期望读到有效数据。0 可能导致后续校验失败（如 NullPointerException），但不会使 SA 本身崩溃。

**可以用 GDB 验证**:
```bash
# 生成不完整的 core 文件
ulimit -c 1000000  # 限制 1MB

# 用 GDB 加载
gdb java core.incomplete -ex "x/16bx 0x7f000000" -ex quit
```

### 9.2 共享库文件不存在 [ps_core.c:1000-1003]

**场景**: core dump 引用了一个已被删除/移动的共享库（如容器升级后删除了旧版 `libjvm.so`）。

**SA 的处理**: `pathmap_open(lib_name)` 返回 -1 → `read_shared_lib_info()` 跳过该库（不中止）:

```c
// ps_core.c:1000-1003
if (lib_fd < 0) {
   print_debug("can't open %s\n", lib_name);
   goto next_lib;  // 跳过，不影响其他库的解析
}
```

**pathmap_open() 的补偿机制** (`libproc_impl.c:35`):
- 检查 `SA_ALTROOT` 环境变量 → 在备选根目录中查找
- 例如: `SA_ALTROOT=/mnt/crash-dump-rootfs` → 在 `/mnt/crash-dump-rootfs/usr/lib/libjvm.so` 查找

**实际限制**: 如果库文件完全不可用（且没有 `SA_ALTROOT`），该库的只读段和符号表将无法恢复——SA 可能无法解析该库中的函数名（只显示地址）。

### 9.3 Prelink 处理 [ps_core.c:862-902]

**场景**: 系统使用了 `prelink(8)` 工具（在旧版 RHEL/CentOS 上常见），预绑定共享库的加载基址以减少动态链接延迟。

**核心问题**: Prelinked 库的 `link_map.l_addr == 0`（因为 prelink 声称库已加载在正确位置），但实际上 ASLR 可能将它加载到不同地址。

**SA 的解决**: `calc_prelinked_load_address()` 通过 `l_ld - PT_DYNAMIC.p_vaddr` 反推实际基址。

**验证方法**:
```bash
# 检查系统是否使用了 prelink
prelink --verify /usr/lib/libc.so.6 2>&1

# 查看 link_map 的 l_addr
# 在 GDB 中: p ((struct link_map *)0x...) ->l_addr
```

### 9.4 CDS Workaround [ps_core.c:256-363]

**场景**: JVM 启用了 Class Data Sharing (`-Xshare:on/auto`)，`classes.jsa` 文件中的只读区域在 core dump 中不完整。

**SA 的处理**:
1. 检查 `UseSharedSpaces` 符号 → 如果 CDS 未启用，提前返回
2. 读取 `SharedArchivePath` 字符串 → 获取 `classes.jsa` 路径
3. 验证 CDS header（`_magic` + `_version`）
4. 遍历 `NUM_CDS_REGIONS`（= 9, 定义于 `src/hotspot/share/include/cds.h:36`），添加 `_read_only` 区域到 `class_share_maps`

**注意**: `class_share_maps` **不加入** `map_array`——只在 `core_lookup()` 的线性 fallback 中使用。这确保 CDS 数据不会优先于 core dump 数据。

### 9.5 诊断工具五件套

| 工具 | 用途 | 示例 |
|------|------|------|
| **readelf** | 查看 core 文件的 ELF 结构 | `readelf -a core.12345` / `readelf -l core.12345` / `readelf -n core.12345` |
| **jhsdb** | SA 命令行工具 | `jhsdb jstack --exe java --core core.12345` / `jhsdb jmap --exe java --core core.12345` |
| **gdb** | 对比验证（标准调试器） | `gdb java core.12345 -ex "info registers" -ex "bt"` |
| **/proc** | 运行时信息（Live Mode 对比） | `cat /proc/pid/maps`（对比 core 的 PT_LOAD 段） / `cat /proc/pid/status`（对比 NT_PRSTATUS） |
| **strace** | 跟踪系统调用 | `strace -e trace=open,pread,close jhsdb jstack --exe java --core core.12345` |

**使用模式**:
```bash
# ① 快速诊断: file + readelf
file core.12345          # 确认是 core dump
readelf -h core.12345    # 确认 e_type == ET_CORE
readelf -l core.12345    # 查看 PT_LOAD 段映射
readelf -n core.12345    # 查看 NT_PRSTATUS 线程寄存器

# ② 详细分析: jhsdb
jhsdb jstack --exe java --core core.12345
jhsdb jmap --exe java --core core.12345

# ③ 对比验证: gdb
gdb java core.12345 -batch \
    -ex "thread apply all bt" \
    -ex "info registers"

# ④ 系统调用跟踪: strace
strace -e trace=pread,open,close -o strace.log \
    jhsdb jstack --exe java --core core.12345
```

---

## §十 总结：Postmortem Mode 的设计权衡

### 10.1 pread 而非 ptrace —— 性能优势 100x+

| 维度 | Postmortem (pread) | Live (ptrace) | 优势 |
|------|-------------------|---------------|------|
| 系统调用类型 | `pread(2)` 大块读取 | `ptrace(PEEKDATA)` 逐字读取 | pread 一次读任意大小 |
| 读取 4KB 的系统调用次数 | 1 | 512（每次 8 字节） | **512x 减少** |
| 读取 1MB 的系统调用次数 | 1 | 131072 | **131072x 减少** |
| 内核路径 | VFS read → page cache | ptrace → copy_from_user | pread 更直接 |
| 可并行性 | 天然线程安全（原子偏移） | ptrace 有全局锁 | pread 可并行 |
| 内存开销 | 无（依赖 page cache） | 每次 PEEKDATA 有 1 次 context switch | pread 无 context switch |

### 10.2 延迟填充 core_data —— 必要复杂度

| 设计 | 优势 | 劣势 |
|------|------|------|
| 一次性初始化所有字段 | 代码简单，所有状态明确 | 无法处理依赖关系（`interp_fd` 路径在 exec 中，CDS 路径在符号表中） |
| 渐进式填充（当前设计） | 处理复杂依赖，每步的发现推动下一步 | 中间状态不完整，错误处理复杂 |

**结论**: 这是**唯一可行的方案**——Postmortem Mode 的逐层解析本质决定了必须渐进式填充。

### 10.3 NT_FILE 兼容性 —— 用 link_map 而非 NT_FILE

| 特性 | NT_FILE (Linux 3.6+) | link_map (所有 Linux) |
|------|---------------------|----------------------|
| 兼容性 | 仅 Linux 3.6+ 内核 | 所有版本 |
| 数据来源 | 内核生成（可能截断） | glibc 动态链接器（权威） |
| 完整性 | 可能遗漏已卸载的库 | 不包含已 dlclose 的库 |
| 实现复杂度 | 简单（直接解析 note） | 复杂（遍历 _DYNAMIC → r_debug → link_map） |

SA 选择 `link_map` 而非 `NT_FILE`，是**可靠性优先**的设计取舍。

### 10.4 Core 文件优化 —— 只读段不 dump，需从 .so 文件补全

| 策略 | Core 文件大小 | 性能 | 可靠性 |
|------|-------------|------|--------|
| dump 所有页（可读+可写） | 巨大（8GB process → 8GB core） | dump 慢（~30 秒） | 高——不需要重新打开 .so 文件 |
| 只 dump 可写页（当前） | 可管理（8GB process → ~2GB core） | dump 快（~5 秒） | 需要 .so 文件存在且可读 |
| 压缩 core dump | 最小 | dump 慢（CPU 瓶颈） | 需要解压缩工具 |

内核选择方案 B（只 dump 可写页），SA 必须配合——`read_lib_segments()` 从 `.so` 文件补读只读段。

### 10.5 Postmortem Mode 与 Live Mode 的对比

| 维度 | Postmortem (ps_core.c) | Live (ps_proc.c) |
|------|------------------------|-------------------|
| 入口函数 | `Pgrab_core(exec, core)` (1048) | `Pgrab(pid)` |
| 数据源 | core dump 文件 + 可执行文件 + 共享库 | `/proc/pid/mem` 或 `ptrace(PEEKDATA)` |
| 线程寄存器 | core 文件 PT_NOTE → NT_PRSTATUS 缓存 | `ptrace(PTRACE_GETREGS)` 系统调用 |
| 共享库 | `link_map` 链重建 + `pathmap_open` 打开 .so | `/proc/pid/maps` + `dlopen` |
| 符号查找 | ELF `.dynsym` from .so files | `dlsym` 或 ELF `.dynsym` |
| 写入支持 | 不支持 (`core_write_data` 是 no-op) | 支持（`/proc/pid/mem` 可写） |
| 要求 | core dump 文件 + 原始可执行文件/.so | 目标进程存活 + `/proc` 挂载 |
| 性能（读 4KB） | ~200ns（1 次 `pread(2)`） | ~256μs（512 次 `ptrace(2)`） |
| vtable | `core_ops` (`ps_core.c:501`) | `process_ops` (`ps_proc.c`) |

**两模式共享的接口**: `ps_prochandle_ops` vtable（`libproc_impl.h:64-75`）——上层代码（`ps_pdread()` / `ps_lgetregs()` 等）不关心是 Postmortem 还是 Live，通过 vtable 多态分发。

**关键公式** (`libproc_impl.c:382-384`):
```c
// 统一入口——所有上层代码调用这个
bool ps_pdread(struct ps_prochandle* ph, uintptr_t addr,
                char* buf, size_t size) {
   return ph->ops->p_pread(ph, addr, buf, size);
   // Postmortem → core_read_data (pread 大块读)
   // Live → process_read_data (ptrace 逐字读)
}
```

---

## 附录 A: 关键源码位置速查

| 符号 | 文件:行号 | 说明 |
|------|----------|------|
| `Pgrab_core` | `ps_core.c:1048-1134` | Postmortem Mode 入口，打开并解析 core dump |
| `read_core_segments` | `ps_core.c:635-691` | 解析 core 文件的 PT_LOAD + PT_NOTE 段 |
| `read_exec_segments` | `ps_core.c:782-849` | 解析可执行文件的 PT_LOAD/PT_INTERP/PT_DYNAMIC |
| `read_lib_segments` | `ps_core.c:694-761` | 解析共享库的 PT_LOAD 段（只读部分） |
| `read_interp_segments` | `ps_core.c:764-780` | 解析 ld-linux 解释器段 |
| `core_handle_note` | `ps_core.c:574-632` | 解析 PT_NOTE 段（NT_PRSTATUS/NT_AUXV） |
| `core_handle_prstatus` | `ps_core.c:509-569` | 处理 NT_PRSTATUS（保存寄存器到 thread_info） |
| `core_read_data` | `ps_core.c:431-479` | 从 core dump 读取内存（虚拟地址 → 文件偏移） |
| `core_lookup` | `ps_core.c:155-199` | 二分查找 map_array + CDS fallback |
| `core_get_lwp_regs` | `ps_core.c:487-499` | 获取线程寄存器（从 cached 的 prstatus 读取） |
| `core_release` | `ps_core.c:99-105` | 清理函数（释放 core_data） |
| `core_write_data` | `ps_core.c:482-493` | No-op 写操作（Postmortem 模式禁止写） |
| `sort_map_array` | `ps_core.c:385-425` | 排序 map_info 数组（用于二分查找） |
| `core_cmp_mapping` | `ps_core.c:371-381` | qsort 比较器（按 vaddr 排序） |
| `read_shared_lib_info` | `ps_core.c:906-1044` | 从 _DYNAMIC 重建链接映射 |
| `init_classsharing_workaround` | `ps_core.c:256-363` | CDS 归档文件的 workaround |
| `calc_prelinked_load_address` | `ps_core.c:868-902` | 计算 prelink 库的加载基址 |
| `close_files` | `ps_core.c:46-74` | 关闭所有文件描述符 |
| `destroy_map_info` | `ps_core.c:77-96` | 释放 maps/class_share_maps/map_array |
| `allocate_init_map` | `ps_core.c:107-121` | calloc 分配 + 初始化 map_info |
| `add_map_info` | `ps_core.c:124-137` | 分配+头插到 maps 链表 |
| `add_class_share_map_info` | `ps_core.c:140-152` | 头插到 class_share_maps 链表 |
| `read_jboolean` | `ps_core.c:209-217` | 从 core dump 读 jboolean |
| `read_pointer` | `ps_core.c:219-227` | 从 core dump 读 uintptr_t |
| `read_string` | `ps_core.c:230-249` | 从 core dump 读字符串 |
| `core_ops` | `ps_core.c:501-506` | Postmortem Mode 的 vtable |
| `map_info` | `libproc_impl.h:54-61` | 虚拟内存映射结构体 |
| `core_data` | `libproc_impl.h:79-92` | core dump 专用数据结构体 |
| `ps_prochandle_ops` | `libproc_impl.h:64-75` | vtable 类型定义 |
| `thread_info` | `libproc_impl.h:47-52` | 线程信息结构体 |
| `lib_info` | `libproc_impl.h:38-44` | 共享库信息结构体 |
| `read_elf_header` | `salibelf.c:33-40` | 读取 ELF 文件头 |
| `read_program_header_table` | `salibelf.c:48-65` | 读取 Program Header Table |
| `find_base_address` | `salibelf.c:105-126` | 找到共享库的加载基址 |
| `is_elf_file` | `salibelf.c:42-45` | ELF magic 验证 |
| `add_lib_info` | `libproc_impl.c:156` | 追加 lib_info（尾插法） |
| `add_lib_info_fd` | `libproc_impl.c:160` | 追加 lib_info（含 fd + 符号表解析） |
| `add_thread_info` | `libproc_impl.c:253` | 追加 thread_info（头插法） |
| `pathmap_open` | `libproc_impl.c:35` | SA_ALTROOT 路径映射打开 |
| `ps_pdread` | `libproc_impl.c:381` | 统一读入口（vtable 分发） |

---

## 附录 B: 相关 man 手册章节

| 手册页 | 章节 | 关键部分 | 在本文档中的使用 |
|--------|------|---------|---------------|
| `man 5 elf` | 5 | ELF 文件格式：Ehdr/Phdr/Shdr/Nhdr，`ET_CORE`，`PT_NOTE`，`NT_PRSTATUS` | §二 §三 §四 的 ELF 结构解析 |
| `man 2 open` | 2 | 打开 core 文件/可执行文件/共享库 | `Pgrab_core` 中的 `open(core_file)` (`ps_core.c:1072`) |
| `man 2 pread` | 2 | 从指定偏移读取文件（不改变 fd 位置） | `core_read_data` (`ps_core.c:450`) 的核心系统调用 |
| `man 2 read` | 2 | 从文件描述符读取数据（偏移隐式递增） | `core_handle_note` (`ps_core.c:594`) 读取 PT_NOTE；与 pread(2) 对比：read 改变 fd 位置，存在多线程竞态 |
| `man 2 lseek` | 2 | 定位文件偏移 | `core_handle_note` (`ps_core.c:581`) 定位 PT_NOTE |
| `man 2 close` | 2 | 关闭文件描述符 | `close_files` (`ps_core.c:51-71`) |
| `man 3 calloc` | 3 | 分配并清零内存 | `allocate_init_map` (`ps_core.c:109`) 分配 map_info |
| `man 3 qsort` | 3 | 排序数组 | `sort_map_array` (`ps_core.c:411`) 排序 map_array |
| `man 3 free` | 3 | 释放内存 | `destroy_map_info` (`ps_core.c:81-94`) 释放链表 |
| `man 5 proc` | 5 | `/proc/pid/maps` 格式 | 理解 core dump PT_LOAD 段的来源 |
| `man 2 ptrace` | 2 | 进程跟踪系统调用 | 与 Postmortem pread 的性能对比 |

---

## 附录 C: 调用链总图

```
┌──────────────────────────────────────────────────────────────────┐
│                        Java 层 (SA API)                          │
│  LinuxDebuggerLocal.java                                         │
│    attach(exec, core) ──────────────────────┐                    │
│    readBytesFromProcess(addr, len) ──────────┼── 每次 OOP 读取   │
│    readCInteger(addr, size) ────────────────┘                    │
├──────────────────────────────────────────────────────────────────┤
│                        JNI 边界                                  │
│  LinuxDebuggerLocal.c                                            │
│    Java_..._attach0__(exec, core)     → Pgrab_core (一次性)      │
│    Java_..._readBytesFromProcess0()   → ps_pdread → vtable 分发  │
├──────────────────────────────────────────────────────────────────┤
│                   Native C 层 (libsaproc.so)                     │
│                                                                  │
│  ★ 初始化阶段 (一次性) ★                                        │
│  Pgrab_core                                                      │
│    ├── read_elf_header (验证 ET_CORE)                            │
│    ├── read_core_segments                                        │
│    │     ├── PT_LOAD → add_map_info(core_fd, ...)                │
│    │     └── PT_NOTE → core_handle_note                          │
│    │           ├── NT_PRSTATUS → core_handle_prstatus            │
│    │           │     └── add_thread_info(ph, lwp_id)             │
│    │           └── NT_AUXV → AT_ENTRY → dynamic_addr             │
│    ├── read_exec_segments                                        │
│    │     ├── PT_LOAD(non-W) → add_map_info(exec_fd, ...)          │
│    │     ├── PT_INTERP → pathmap_open → interp_fd                │
│    │     └── PT_DYNAMIC → dynamic_addr                            │
│    ├── sort_map_array(ph) [第一次]                                │
│    ├── read_shared_lib_info                                      │
│    │     ├── _DYNAMIC → DT_DEBUG → debug_base                    │
│    │     ├── r_debug.r_map → first_link_map                      │
│    │     ├── read_interp_segments(ph)                             │
│    │     └── for each link_map:                                  │
│    │           ├── pathmap_open(lib_name) → lib_fd                │
│    │           ├── read_lib_segments(lib_fd, ...)                 │
│    │           ├── add_lib_info_fd(ph, name, fd, base)            │
│    │           └── sort_map_array(ph) [每次库后]                  │
│    └── init_classsharing_workaround                              │
│          ├── lookup_symbol("UseSharedSpaces")                     │
│          ├── pathmap_open("classes.jsa")                          │
│          └── add_class_share_map_info(ph, ...)                    │
│                                                                  │
│  ★ 运行时阶段 (高频) ★                                          │
│  ps_pdread(ph, addr, buf, size)                                  │
│    └── ph->ops->p_pread(ph, addr, buf, size)                     │
│          ├── Postmortem: core_read_data                           │
│          │     ├── core_lookup(addr) → 二分查找 map_array         │
│          │     │     └── fallback: 线性搜索 class_share_maps      │
│          │     └── pread(fd, buf, len, off)                       │
│          └── Live: process_read_data                              │
│                └── pread(/proc/pid/mem, ...)                      │
└──────────────────────────────────────────────────────────────────┘
```
