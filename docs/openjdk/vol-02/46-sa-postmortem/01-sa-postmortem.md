# 01. SA Postmortem — core dump + ptrace + ELF symbols

> **前置依赖**:[39-runtime-monitoring/02 — Timer + Monitoring Services: 高精度计时 + JMX 统计](openjdk/vol-02/39-runtime-monitoring/02-timer-stats.md):运行时观测的最后一站;[06-oops/01 — 对象头: 一个 word,五种身份](openjdk/vol-02/06-oops/01-markoop-oopdesc.md):SA 遍历的对象结构;[09-memory-core/01 — Universe + CollectedHeap: JVM 的“宇宙大爆炸”](openjdk/vol-02/09-memory-core/01-universe-heap.md):`Universe::_collectedHeap` 是 SA 的入口符号
> → **后续**:[14-c1-compiler/01 — C1 管线 + HIR — 字节码→编译图](openjdk/vol-02/14-c1-compiler/01-c1-pipeline-ir.md)
> 关联域: 24-frame(栈解帧)、17-threads(线程)

`hs_err_pid.log` 只有线程栈；要看**堆**得靠 SA(Serviceability Agent)。它不依赖 JVM 进程存活：有 **core dump** 就读 core 文件，没有就用 **ptrace 读活进程内存**。这篇要回答的核心问题是：

1. SA 到底是怎么从一个已经死掉的 JVM 里“读出”堆和线程的？
2. `jhsdb jmap --heap --pid` 和 `--core` 看起来像一个工具，它们底层到底共享了什么？
3. 符号（比如 `Universe::_collectedHeap`）是怎么从 `libjvm.so` 里被定位出来的？

答案会反复落到一句话：**SA 并不理解“活 JVM”和“core 文件”这两种不同世界，它只要求一个统一的“按地址读内存、按名字找符号”的抽象。core 模式靠 ELF program headers 建映射表、二分查段、pread 读字节；活进程模式靠 ptrace attach + `/proc/<pid>/maps` 建映射表、`PTRACE_PEEKDATA` 分片读字节；符号解析则统一走 ELF symtab/dynsym → 哈希表 → base+offset。**

---

## 1. 开场困惑——JVM 都死了，怎么还能看堆

`hs_err_pid.log` 能告诉你“崩在哪个线程栈上”，但它并不会把堆对象图直接打印出来。要真正回答“这个对象在哪里”“堆长什么样”“哪些线程还活着”，就得让工具直接读进程内存。

对活进程来说，这件事看起来像“调试器 attach”；对 core 文件来说，看起来像“离线解析一个二进制转储”。直觉上这像两套完全不同的工具。

SA 的关键设计是：**把这两种世界都压成同一个抽象**——给我一个地址，我能读到那里的字节；给我一个符号名，我能算出它在目标地址空间里的实际地址。上层的堆遍历、线程遍历、对象解码因此完全复用。

---

## 2. 两个朴素方案为什么都不对

### 方案一: SA 只会解析 core 文件，不支持活进程

很多人先把 SA 理解成“离线分析 core 的工具”。这当然是它的一大用途，但并不完整。`jhsdb jmap --heap --pid <pid>` 走的是 live-process 路线：attach、停住目标进程、按地址读内存、解析符号。也就是说，core 不是前提，只是其中一种数据源。

### 方案二: SA 直接解析 HotSpot 私有 core 格式

另一个常见想象是：既然 JVM 自己生成 core,那 SA 大概依赖某种 HotSpot 私有布局。但 Linux 上 core 文件就是 **ELF**，活进程的内存映射就是 `/proc/<pid>/maps`，字节读取就是 `pread` 或 `ptrace`。SA 利用的是操作系统已经给出的快照机制,不是 JVM 私有转储格式。

所以这篇真正要看清的，不是“JVM 特有格式”，而是 **ELF / ptrace / 符号表** 这三层如何拼成统一的服务性抽象。

---

## 3. core dump 解析——ELF 段表 + 二分 + pread

### 第一步: 把 PT_LOAD 段收成 `map_info`

core 文件是 ELF 格式。SA 打开 core 后,先读 ELF header 和 program headers。`PT_LOAD` 段就是进程虚拟内存的快照。每个段都变成一个 `map_info` 结构(`add_map_info`, ps_core.c:124-134),记录:

- 文件 fd
- 文件内 offset
- 进程虚拟地址 `vaddr`
- 段大小 `memsz`

插入时用链表 prepend——O(1)。

### 第二步: 链表转数组,按虚拟地址排序

为了让“按地址找段”足够快，SA 不会每次线性扫链表。它会把链表转成指针数组，再按 `vaddr` 排序(`sort_map_array`, ps_core.c:382-421)。源码注释写得很直白：排序之后就能做 binary search。

### 第三步: `core_lookup` 做二分

`core_lookup` 的职责就是“给定一个虚拟地址，找到它落在哪个 `map_info` 段里”：

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

查不到时还有一层 `class_share_maps` 兜底，用来处理 CDS 共享区的特殊映射。

### 第四步: `pread` 读字节,段尾补零

定位到段后，`core_read_data`(ps_core.c:431-465)做的事情就很机械了：

- `mapoff = addr - mp->vaddr`
- `off = mp->offset + mapoff`
- `pread(fd, buf, len, off)` 直接从 core 文件偏移处读字节

如果读到段尾的分数页，剩余部分补零。这样上层永远只面对“给定地址读字节”，不会关心底下是 ELF 段边界还是页对齐问题。

所以 core 模式的本质是：**ELF 段表 → 排序数组 → 地址到文件偏移的映射 → `pread`**。

---

## 4. 活进程读取——ptrace attach + `PTRACE_PEEKDATA`

### attach: `PTRACE_ATTACH` + `waitpid(SIGSTOP)`

`jhsdb jmap --heap --pid <pid>` 走 `LinuxDebuggerLocal.attach0`，先做位宽检查(`verifyBitness`)，再走 `Pgrab`。`Pgrab` 内部最终就是 `ptrace_attach`：发 `PTRACE_ATTACH`，再 `waitpid` 等目标线程停在 `SIGSTOP` 上。SA 操作期间目标进程暂停，用完后 detach 恢复。

### 建映射表: `/proc/<pid>/maps`

活进程模式里没有 ELF program headers 可用，取而代之的是 `/proc/<pid>/maps`。SA 逐段解析它，生成和 core 模式同形状的 `map_info` 列表。这样一来，“按地址找段”的上层逻辑就可以复用。

### 读字节: 8 字节 `PTRACE_PEEKDATA`

真正读内存是 `process_read_data`(ps_proc.c:66-116)。这里最值得记住的是它不是字节流接口，而是 **按机器字（8 字节）读**：

- 对齐地址时直接一段段 `PTRACE_PEEKDATA`
- 非对齐地址时分三段：先读前半、再读整字循环、尾部再补一次并拼接

这就是所谓“read-unread bytes”的机制。目标进程地址空间里的任意一段内存，最后都被切成一串 8 字节块去拼出来。

所以活进程模式的本质是：**ptrace attach + maps 建段 + 8 字节分片读取**。

---

## 5. 符号解析——ELF symtab → 哈希表 → 堆入口

### 从 section header 里找 symtab / dynsym

找到 `libjvm.so` 之后，SA 要定位 `Universe::_collectedHeap` 这类内部符号。`build_symtab_internal`(symtab.c:329+)会读取 ELF 的 section header 表：

- 默认用 `SHT_DYNSYM`（动态符号表）
- 如果存在 `SHT_SYMTAB`（静态符号表）则优先切过去

### 建哈希表,查找变成 O(1)

符号名（`st_name -> strtab`）全部复制进内存后，SA 用 `hcreate_r/hsearch_r` 建一个哈希表(symtab.c:416-432)。之后查找不再线性扫符号表，而是:

- `search_symbol` 以名字为 key 查哈希表
- 命中后返回 `base + sym->offset`

这意味着**“符号名 → 目标进程运行时地址”**只是一次哈希查找加一次基址偏移。

### 全局搜索与 debug 文件兜底

`lookup_symbol`(libproc_impl.c:215-238)甚至会忽略 object_name，遍历所有库的符号表全局搜索。找不到符号时，SA 还会尝试 `.gnu_debuglink` 或 build-id 机制去找分离的 debug 文件。

### `Universe::_collectedHeap` 作为终点示例

拿到 `Universe::_collectedHeap` 的地址后，SA 读该指针 → 得到 `CollectedHeap` 对象 → 再按 GC 类型（G1/Parallel/…）走各自的堆遍历逻辑。`jhsdb jmap --heap` 输出 “Garbage-First (G1) GC with 23 thread(s)” 就是这条链的终点。

所以符号解析这一层的本质是：**ELF 符号表不是拿来一条条扫的，而是先建哈希索引，再把名字翻成运行时地址。**

---

## 6. 误解澄清与收网

1. **SA 只能分析 core 文件吗?** 不能。活进程模式同样是 SA 的主路径之一，靠的是 ptrace 而不是 core。
2. **SA 解析的是 HotSpot 私有 core 格式吗?** 不是。Linux 上它依赖的是 ELF program headers、`/proc/<pid>/maps`、`pread`、`ptrace` 这些系统设施。
3. **core 和活进程模式是两套完全不同的工具吗?** 不是。它们共享同一个 `ps_prochandle` 抽象和上层堆/线程/对象解码逻辑，区别只在“地址 → 字节”这一层怎么实现。
4. **符号查找是线性扫一遍 `libjvm.so` 吗?** 不是。构建期先把 symtab/dynsym 做成哈希表，运行时是 O(1) 查找。
5. **目标进程 attach 后还能正常继续跑吗?** attach 期间会停在 `SIGSTOP` 上，直到 SA detach 才恢复。

把这一篇压成三句话：

- **core 模式** = ELF 段表 + 排序数组二分 + `pread`。
- **活进程模式** = ptrace attach + `/proc/<pid>/maps` + `PTRACE_PEEKDATA` 分片读。
- **共同部分** = 符号哈希表 + `base+offset` 定位 + 上层堆/线程遍历。

第 5 批收官。下一批进入 JIT/GC 的核心域：C1 编译器,字节码怎么变成编译图(HIR)。

> → [14-c1-compiler/01 — C1 管线 + HIR — 字节码→编译图](openjdk/vol-02/14-c1-compiler/01-c1-pipeline-ir.md)