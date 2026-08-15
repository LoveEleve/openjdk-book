# 01. SA Postmortem — core dump + ptrace + ELF symbols

> **前置依赖**:[39-runtime-monitoring/02 — Timer + Monitoring Services: 高精度计时 + JMX 统计](openjdk/vol-02/39-runtime-monitoring/02-timer-stats.md):运行时观测的最后一站;[06-oops/01 — 对象头: 一个 word,五种身份](openjdk/vol-02/06-oops/01-markoop-oopdesc.md):SA 遍历的对象结构;[09-memory-core/01 — Universe + CollectedHeap: JVM 的"宇宙大爆炸"](openjdk/vol-02/09-memory-core/01-universe-heap.md):`Universe::_collectedHeap` 是 SA 的入口符号
> → **后续**:[14-c1-compiler/01 — C1 管线 + HIR — 字节码→编译图](openjdk/vol-02/14-c1-compiler/01-c1-pipeline-ir.md):第 5 批收官,进入第 6 批(JIT/GC)
> 关联域: 24-frame(栈解帧)、17-threads(线程)

## JVM 都死了,怎么还能看堆

`hs_err_pid.log` 只有线程栈;要看**堆**得靠 SA(Serviceability Agent)——它不依赖 JVM 进程存活: 有 **core dump**(离线)就读 core 文件,没有就用 **ptrace 读活进程内存**。SA 的 native 层在 `jdk.hotspot.agent/linux/native/libsaproc/`(`ps_core.c` 1134 行/`ps_proc.c` 527/`symtab.c` 607),Java 层在 `sun.jvm.hotspot` 包,`jhsdb` 是它的命令行壳。这篇拆三层: **core 文件的解析**(ELF segment → 二分查段 → pread)、**活进程的读取**(ptrace attach + 8 字节 PEEKDATA + 非对齐合并)、**符号解析**(ELF symtab → 哈希表 → `Universe::_collectedHeap`)。[实证](planning/outlines/00-jvm-tools/materials/commands/46-sa-postmortem-demo.txt)把活进程与 core 两种模式都跑通了。

## 1. core dump 解析: ELF 段表 + 二分 + pread

core 文件是 ELF 格式;SA 打开后读 ELF header → program headers(**PT_LOAD 段**就是进程的虚拟内存快照),每段建一个 `map_info`(fd/offset/vaddr/memsz,`add_map_info` ps_core.c:124-134)——**链表 prepend 插入(O(1))**,之后再**转成指针数组并按 vaddr 排序**(`sort_map_array`,:382-421,注释 "we sort map_info by starting virtual address so that we can do binary search")。所以**`core_lookup` 不是线性扫描,是二分**: 

```c
// ps_core.c:153-160(截取核心,逐字)
// Return the map_info for the given virtual address.  We keep a sorted
// array of pointers in ph->map_array, so we can binary search.
static map_info* core_lookup(struct ps_prochandle *ph, uintptr_t addr) {
  int mid, lo = 0, hi = ph->core->num_maps - 1;
  map_info *mp;

  while (hi - lo > 1) {
    mid = (lo + hi) / 2;
```

查不到时还有 **class_share_maps 链表兜底**(:189-200,CDS 共享区,注释 "Unfortunately, we have no way of detecting -Xshare state")。**读内存**走 `core_read_data`(:431-465): 二分定位段 → `mapoff = addr - mp->vaddr` → `off = mp->offset + mapoff` → **`pread(fd, buf, len, off)`**(:456)——按段分片读,段尾的分数页补零(:462-465)。*关键设计: 上层只管 `ps_pdread` 一个接口,core 用 pread、活进程用 ptrace——`ps_prochandle` 统一两种数据源(下文 jhsdb 一个命令两种模式都能跑,正是这个抽象)*。

## 2. 活进程读取: ptrace attach + PEEKDATA

`jhsdb jmap --heap --pid <pid>` 走 `LinuxDebuggerLocal.attach0`(LinuxDebuggerLocal.c:251): 先 **`verifyBitness`**(:196-210,读 `/proc/<pid>/exe` 的 ELF 头检查位宽,失败即 "cannot open binary file"——[实证](planning/outlines/00-jvm-tools/materials/commands/46-sa-postmortem-demo.txt)里第一次 attach 失败正是因为目标进程已退出,`/proc/<pid>/exe` 消失),再 **`Pgrab`**(ps_proc.c:450,libproc.h:59 声明): `ptrace_attach`(ps_proc.c:275-292,`PTRACE_ATTACH` + waitpid 等 **SIGSTOP**)→ 解析 `/proc/<pid>/maps` 逐段 `add_map_info` → `fillThreadsAndLoadObjects` 填线程与库列表。

读内存是 **`process_read_data`**(ps_proc.c:66-116): `PTRACE_PEEKDATA` 每次取 **8 字节**(sizeof(long)),**非对齐地址分三段**: 先读对齐地址的 8 字节取前半 → 整字循环 → 尾部再读一次取后半合并(:78-116)——正是"read-unread bytes"的机制。栈解帧(jhsdb jstack)读的就是这些字节:[实证](planning/outlines/00-jvm-tools/materials/commands/46-sa-postmortem-demo.txt)里完整解出 `socketAccept` 的 Interpreted frame。*关键设计: ptrace 让目标进程停在 SIGSTOP 上——SA 操作期间进程暂停,用完必须 detach 恢复*。

## 3. 符号解析: ELF symtab → 哈希表 → 堆入口

找到 `libjvm.so` 后要定位 `Universe::_collectedHeap` 这类内部符号。`build_symtab_internal`(symtab.c:329+)读 ELF 的 section header 表: **默认用 SHT_DYNSYM(动态符号),若存在 SHT_SYMTAB(静态符号)则优先切过去**;符号名(st_name→strtab)全部复制进内存后 **建哈希表**(hcreate_r/hsearch_r,:416-432)——所以**查找不是线性遍历,是 O(1) 哈希**: `search_symbol`(:569-587)以符号名为 key 查表,命中返回 **`base + sym->offset`**(:583,库加载基址+符号偏移=目标进程里的运行时地址)。`lookup_symbol`(libproc_impl.c:215-238)甚至**忽略 object_name,遍历所有库的 symtab 全局搜索**(注释 "We just ignore object_name and do a global search for the symbol")。找不到符号时还有 **debuginfo 机制**: `build_symtab_from_debug_link`(symtab.c:261,ELF `.gnu_debuglink` 段)/`build_symtab_from_build_id`(:305,NT_GNU_BUILD_ID note)定位分离的 debug 文件。

拿到 `Universe::_collectedHeap` 的地址后,SA 读该指针 → CollectedHeap 对象 → 按 GC 类型(G1/Parallel 等)走各自的 oop 遍历——[实证](planning/outlines/00-jvm-tools/materials/commands/46-sa-postmortem-demo.txt)里 `jhsdb jmap --heap --pid` 输出 "Garbage-First (G1) GC with 23 thread(s)" 与 Heap Configuration,就是这条链的终点。

## 4. core 模式: 事后诊断的唯一途径

**gcore**(容器 core_pattern=core,可直接用)把活进程抓成 core 文件,之后 JVM 进程生死都无所谓:`jhsdb jmap --heap --core <core> --exe <java>`——[实证](planning/outlines/00-jvm-tools/materials/commands/46-sa-postmortem-demo.txt)里 19GB 的 core 被成功解析出 "Heap Configuration" 与 "G1 GC with 23 thread(s)"。这印证了 `ps_prochandle` 抽象的威力: core 模式下 ELF program headers 就是映射表(§1),活进程模式下 `/proc/<pid>/maps` 才是(§2),符号与堆遍历完全复用。*关键设计: SA 是 JVM 死后唯一能看堆的途径——crash 场景下 hs_err 只有栈,core + SA 才有堆*。

## 核心悬念

46 域收官,也是**第 5 批(VM 核心)收官**: SA 的三层拆完——core 文件是 ELF 段表 + 排序数组二分 + pread,活进程是 ptrace attach + 8 字节 PEEKDATA 三段合并,符号是 ELF symtab 哈希表 + base+offset 定位 `Universe::_collectedHeap`;`ps_prochandle` 把两种数据源统一成一个读接口,`jhsdb jmap --heap --pid/--core` 都是它的壳。[实证](planning/outlines/00-jvm-tools/materials/commands/46-sa-postmortem-demo.txt)把活进程、jstack 解栈、19GB core 离线解析全部跑通。VM 核心 13 域到此收官——下一批进入 **JIT/GC**: 第一个就是 C1 编译器,字节码怎么变成编译图(HIR)。

> → [14-c1-compiler/01 — C1 管线 + HIR — 字节码→编译图](openjdk/vol-02/14-c1-compiler/01-c1-pipeline-ir.md)
