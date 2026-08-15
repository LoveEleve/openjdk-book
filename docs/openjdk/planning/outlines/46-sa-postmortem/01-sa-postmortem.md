# 01. SA Postmortem — core dump + ptrace + ELF symbols

> 🔴 Deep | 不依赖 live JVM → 独立进程读取 JVM 状态
> 读者处境: JVM crash→`hs_err_pid.log` 不完整→需要 core dump→`jhsdb jmap --core core.dump --exe java`→SA 作为独立进程解析 core dump→找 libjvm.so→ELF symbols→`Universe::_collectedHeap`→oop iterate→dump heap objects。**不需要 JVM 还在运行**——SA 直接从 core file 或 /proc/pid/mem 读取内存。

> ⚠️ 写作期修正(2026-08-15, vol-02/46-sa-postmortem/01 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **"core_lookup 线性扫描 O(n)/linked list" 错(重要)**: 真实=**map_array 排序指针数组+二分查找**(core_lookup ps_core.c:153-175,注释 "We keep a sorted array of pointers in ph->map_array, so we can binary search";sort_map_array :382-421 链表→数组→qsort)——O(log n);大纲 completeness 问 6 的"链表 vs 红黑树/O(n) 太慢"基于错误前提
> - **"add_map_info 用 linked list prepend O(1)" ✓ 对**(:124-134 map->next=core->maps)——但 lookup 用 map_array 二分
> - **"symtab 遍历 symbol table entries 线性" 错(重要)**: 构建时 **hcreate_r 哈希表**(symtab.c:416-432,size n*1.25),查找 **hsearch_r O(1)**(search_symbol :569-587,命中返回 base+sym->offset :583);符号 section 默认 **SHT_DYNSYM**,发现 **SHT_SYMTAB 则优先切换**(build_symtab_internal :329+)
> - **"lookup_symbol 找到 libjvm.so 的 symtab" 半对**: 真实=**忽略 object_name 遍历所有库全局搜索**(libproc_impl.c:215-238,注释 "We just ignore object_name and do a global search")
> - **"debuginfo-install" 半对**: 真实机制=**ELF .gnu_debuglink 段**(build_symtab_from_debug_link symtab.c:261)/**NT_GNU_BUILD_ID note**(build_symtab_from_build_id :305)
> - **源码位置**: 不在 hotspot/agent/,在 **jdk.hotspot.agent/linux/native/libsaproc/**(ps_core.c 1134 行 ✓/ps_proc.c 527/symtab.c 607 ✓/LinuxDebuggerLocal.c 584)
> - **"ps_proc.c:78-110 ptrace PEEKDATA 8 字节" ✓**(process_read_data :66-116: 非对齐三段式=前部/整字循环/尾部合并);ptrace_attach :275-292(PTRACE_ATTACH+waitpid SIGSTOP);Pgrab 在 **ps_proc.c:450**(非 libproc_impl.c)
> - **缺机制(重要)**: ①verifyBitness(LinuxDebuggerLocal.c:196-210,/proc/<pid>/exe 位宽检查,失败 "cannot open binary file");②core_read_data(ps_core.c:431-465): core_lookup 二分→mapoff=addr-vaddr→off=offset+mapoff→**pread**;段尾分数页补零;③class_share_maps 链表兜底(CDS,:189-200);④ps_prochandle 统一 core/live 数据源(上层只调 ps_pdread);⑤attach0(LinuxDebuggerLocal.c:251:Pgrab→fillThreadsAndLoadObjects)→ps_prochandle 存 jlong 字段;⑥search_symbol base+offset=运行时地址
> - **实证**: 46-sa-postmortem-demo.txt(jhsdb jmap --heap --pid 活进程 attach 成功:G1 23 threads/Heap Configuration/regions 7630;jstack 解 Interpreted frame;gcore 19GB core+jhsdb --heap --core 离线解析成功;首次 attach 失败教训=目标进程已退出 /proc/<pid>/exe 消失)
> - **悬念指向错**: "→ 域47 Instrumentation" 过期(47 是第 7 批);46 是**第 5 批收官域**——悬念应指**第 6 批第一个域 14-c1-compiler/01**(C1 管线+HIR)

### 1. "Core dump 解析 — ELF segment → memory maps"

场景: Java 进程 crash→core dump 文件(ELF format)→SA open core file→ELF header→program headers(PT_LOAD segments)→每个 segment 记录为 `map_info`(addr range→offset in core file→fd)→`core_lookup(addr)`→find segment→pread→read data。

**ps_core.c** (`ps_core.c:155-500`):
```
core_lookup(ph, addr) (line 155):
  → 遍历 ph->core->mappings(linked list of map_info)
  → 找到 addr 所在 segment(addr >= mp->vaddr && addr < mp->vaddr + mp->memsz)
  → return mp

core_read_data(ph, addr, buf, size) (line 431):
  → mp = core_lookup(ph, addr) → 找 segment
  → offset = mp->offset + (addr - mp->vaddr)  → 计算 core file 中偏移
  → pread(ph->core->core_fd, buf, size, offset) → read from core file

add_map_info(ph, fd, offset, vaddr, memsz) (line 124):
  → 创建 map_info node → insert into mappings linked list
  → 按 vaddr 排序(升序)——binary search O(log n) for lookup
[C++: ps_core.c:1134行——core dump 是 ELF format——SA 重用 Linux kernel 的 ELF 格式(core_pattern→core.%p)]
```
- 源码: `ps_core.c:155-180` (core_lookup→linked list traversal) + `ps_core.c:431-460` (core_read_data→pread) + `ps_core.c:124-140` (add_map_info→sorted insert)

- 关键设计: **Core file vs /proc/pid/mem 统一抽象** — 两个数据源用同一 `ps_prochandle` 结构体——core file 用 `pread(fd, offset)`, live process 用 `ptrace(PTRACE_PEEKDATA)`。上层 SA 代码(JMap/JStack/JInfo)不知道数据源——统一 read protocol。**add_map_info 用 linked list prepend** (`ps_core.c:132-133`: `map->next=core->maps`→O(1) insert)——core dump 通常有 200+ segments, core_lookup 是 O(n) 线性扫描——对于诊断工具(非性能关键)足够。

### 2. "Live process 读取 — ptrace + /proc/pid/maps"

场景: `jhsdb jstack <pid>`→SA attach to live JVM via ptrace→read process memory maps→ptrace PEEKDATA→read thread stacks→unwind frames→Java stack trace。

**ps_proc.c + LinuxDebuggerLocal.c** (`ps_proc.c:61-130 + LinuxDebuggerLocal.c:100-400`):
```
ptrace(PTRACE_ATTACH, pid):
  → attach to Java process(all threads)——kernel sends SIGSTOP
  → 读取 /proc/<pid>/maps→parse address→add_map_info
  → read memory: ptrace(PTRACE_PEEKDATA, pid, addr, 0)→8 bytes per call
  → read registers: ptrace(PTRACE_GETREGS, tid)→struct user_regs_struct
  → read stack: process_read_data→multiple PEEKDATA calls→construct frame
  → unwind: find RBP/saved RBP→previous frame→recursive
  → done: ptrace(PTRACE_DETACH, pid)→process resumes

LinuxDebuggerLocal.c — Java_..._attach0:
  → ptrace(PTRACE_ATTACH, pid) → read process info
  → JNI return ps_prochandle pointer(jlong)→Java SA code uses it
[C++: ps_proc.c:78-110——ptrace PEEKDATA 每次读 8 bytes(pointersize)——需 word-align + read-unread bytes]
```
- 源码: `ps_proc.c:78-110` (ptrace PEEKDATA read) + `LinuxDebuggerLocal.c:100-250` (attach0→ptrace attach + maps load)

- 关键设计: **PTRACE_PEEKDATA 每次读 sizeof(long)=8 bytes** — 如果读取非对齐(unword-aligned)地址→SA 先读对齐的前 8 bytes→提取后半→再读下一 8 bytes→提取前半→合并。**ptrace 阻塞原进程** — attach 后 target process STOPPED→SA 完成后必须 detach→否则进程永久停止。

### 3. "ELF 符号表 — find JVM internals"

场景: SA 找到 libjvm.so→parse ELF `.symtab` section→look up `Universe::_collectedHeap`→get symbol address→add to libjvm's loaded addr→`HeapWord* heap = *((HeapWord**)addr)`→oop iterate→dump objects。

**symtab.c** (`symtab.c:40-300`):
```
lookup_symbol(ph, "Universe::_collectedHeap"):
  → 找到 libjvm.so 的 ELF .symtab/.dynsym section
  → 遍历 symbol table entries→st_name match→get st_value(offset in libjvm)
  → st_value + libjvm_load_addr = runtime address in target process
  → return address
[C++: symtab.c:607行——ELF .dynsym(动态符号) + .symtab(静态符号)——libjvm.so 用动态符号]
```
- 源码: `symtab.c:40-200` (ELF section header parse) + `symtab.c:200-350` (symbol lookup→elf_symtab_iterate)

- 关键设计: **调试符号是 SA 的关键依赖** — libjvm.so 必须保留 `.symtab`(静态符号)或 `.dynsym`(动态符号)→SA 才能找到 JVM 内部数据结构(CollectedHeap/SymbolTable/SystemDictionary)。如果 libjvm.so stripped→SA 无法工作→只能看 native stacks→不能看 Java heap。**`debuginfo-install java-11-openjdk`** 安装 debug symbols(`libjvm.debuginfo`)—SA 自动搜索 `/usr/lib/debug/` 下的分离 debuginfo 文件。

---

### 核心悬念

**"SA: core dump→ELF segments→add_map_info→core_lookup→pread(read memory)。Live→/proc/pid/maps→ptrace PEEKDATA(read 8 bytes at a time)。ELF symtab→Universe::_collectedHeap→oop iterate→Java heap dump。独立进程→不依赖 JVM 仍在运行——事后诊断唯一途径。"** — 下一篇: 域47 Instrumentation。

> → 域47 Instrumentation
