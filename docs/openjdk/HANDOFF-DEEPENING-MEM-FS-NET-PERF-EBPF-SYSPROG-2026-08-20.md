# HANDOFF — `vol-os-kernel` / `vol-system-programming` / `vol-memory` / `vol-filesystem` / `vol-network` / `vol-system-performance` / `vol-ebpf` 二轮深修推进交接文档

> 交接日期：2026-08-20
> 交接范围：
> - `/data/workspace/source-code/openjdk-book/docs/openjdk/vol-os-kernel/`
> - `/data/workspace/source-code/openjdk-book/docs/openjdk/vol-system-programming/`
> - `/data/workspace/source-code/openjdk-book/docs/openjdk/vol-memory/`
> - `/data/workspace/source-code/openjdk-book/docs/openjdk/vol-filesystem/`
> - `/data/workspace/source-code/openjdk-book/docs/openjdk/vol-network/`
> - `/data/workspace/source-code/openjdk-book/docs/openjdk/vol-system-performance/`
> - `/data/workspace/source-code/openjdk-book/docs/openjdk/vol-ebpf/`
> 当前状态：`vol-os-kernel` 19/19、`vol-system-programming` 7/7、`vol-memory` 13/13、`vol-filesystem` 12/12、`vol-network` 14/14、`vol-system-performance` 8/8、`vol-ebpf` 7/7 已全部完成一轮“模板化二轮深修”；此前系统编程卷 `01-file-io-basics.md` 的 8000 字符遗留项与 eBPF→系统编程跨卷桥接断层也已修复。
> 下一主线建议：**这一批内功卷的二轮模板化深修已全部收尾。下一步最建议先回写各交接文档，并转入总规划中的下一条独立主线（如 `MySQL/` 或 `分布式/`）；若仍停留在内功线，则可针对 `vol-os-kernel` 中篇幅仍偏短的代表篇做第三轮事故感/排障感补强。**

---

## 0. 先看结论

这一轮工作到当前为止，核心完成了四件事：

1. **系统编程卷补齐到 7/7 完整完成。**
2. **系统编程卷 01 篇的篇幅遗留项已修复。**
3. **memory / filesystem / network / system-performance / ebpf 五卷已整卷完成二轮模板化深修。**
4. **`vol-os-kernel` 也已按同一模板完成 19/19 二轮深修，至此内功七卷全部完成统一 patch 风格收口。**

### 0.1 `vol-system-programming/` 现在是 7/7

```text
docs/openjdk/vol-system-programming/
├── 01-file-io-basics.md
├── 02-mmap-epoll-inotify.md
├── 03-fork-exec-daemon.md
├── 04-pthread-threads.md
├── 05-signals-timers-malloc.md
├── 06-memory-malloc-debug.md
└── 07-cpp-atomic-lockfree.md
```

全部已按当前方法论正文标准写完，并做过至少：

- 删码字符数检查
- 禁用词扫描
- 文件尾部干净性检查
- 篇尾桥接检查

### 0.2 `vol-system-programming/01-file-io-basics.md` 的旧遗留项已消掉

旧交接 `docs/openjdk/HANDOFF-EBPF-SYSPROG.md:150` 记录它删码后仅 `7776` 字符，低于 8000 线。

本轮已针对两处最薄弱段落做增量补强：

- partial I/O 失败推演加厚
- `close`/`unlink`/共享引用边界加厚

现在该文删码后字符数已到 **8623**，并重新通过禁用词与尾部校验。

### 0.3 eBPF 卷与系统编程卷的跨卷桥接断层已修复

旧交接 `docs/openjdk/HANDOFF-EBPF-SYSPROG.md:181` 提到：

- `vol-ebpf/07` 没有明确下一篇桥接
- `vol-system-programming/01` 没有回接 `vol-ebpf/07`

本轮已双向修补：

- `docs/openjdk/vol-ebpf/07-network-security-xdp.md` 补了明确的“下一步桥接”到系统编程卷 01
- `docs/openjdk/vol-system-programming/01-file-io-basics.md` 补了卷间导航，回接 `vol-ebpf/07`

现在这条跨卷阅读链已经闭环。

---

## 1. 本轮二轮深修工作的本质

这次做的不是“重写正文”，而是把既有第一轮教学正文，往源码分析正文再推进半步。

统一模板是：

1. **篇首补**
   - 一句话困惑
   - 一句话顿悟
   - 依赖分类（硬/软/导航）
2. **正文关键判断后补**
   - 模块/文件/常见函数级证据位说明
   - 事实与边界提醒
3. **篇尾补**
   - 误解清单
   - 证据清单
   - 边界清单
4. **保持原小标题结构稳定**
   - 不推倒重排
   - 不为补证据位而堆大段代码块
5. **继续遵守无源码树现实**
   - 不伪造精确 `file:line`
   - 只能用“模块/文件名 + 常见函数名 + 版本限定”的证据表达

这套模板现在已经在多个卷上跑通，可以直接继续批量铺开。

---

## 2. 已完成情况总览

## 2.1 `vol-system-programming/` 完整状态

本轮完成了以下 5 篇正文：

1. `docs/openjdk/vol-system-programming/03-fork-exec-daemon.md`
2. `docs/openjdk/vol-system-programming/04-pthread-threads.md`
3. `docs/openjdk/vol-system-programming/05-signals-timers-malloc.md`
4. `docs/openjdk/vol-system-programming/06-memory-malloc-debug.md`
5. `docs/openjdk/vol-system-programming/07-cpp-atomic-lockfree.md`

配合此前已完成的：

6. `docs/openjdk/vol-system-programming/01-file-io-basics.md`
7. `docs/openjdk/vol-system-programming/02-mmap-epoll-inotify.md`

现在系统编程卷是完整 7 篇。

### 各篇校验结果摘要

- `docs/openjdk/vol-system-programming/03-fork-exec-daemon.md`
  - 删码后字符数：14806
  - 禁用词：零命中
  - 尾部：干净
- `docs/openjdk/vol-system-programming/04-pthread-threads.md`
  - 删码后字符数：13301
  - 禁用词：零命中
  - 尾部：干净
- `docs/openjdk/vol-system-programming/05-signals-timers-malloc.md`
  - 删码后字符数：13486
  - 禁用词：零命中
  - 尾部：干净
- `docs/openjdk/vol-system-programming/06-memory-malloc-debug.md`
  - 删码后字符数：12581
  - 禁用词：零命中
  - 尾部：干净
- `docs/openjdk/vol-system-programming/07-cpp-atomic-lockfree.md`
  - 删码后字符数：13453
  - 禁用词：曾命中 1 处 `同理`，已修复后复扫零命中
  - 尾部：干净
- `docs/openjdk/vol-system-programming/01-file-io-basics.md`
  - 旧值 7776 已修补到 8623
  - 禁用词：零命中
  - 尾部：干净

---

## 2.2 四卷 + eBPF 二轮深修进度

### A. `vol-memory/`

**已整卷铺开完成模板化二轮深修：13/13。**

已补模板文件：

1. `docs/openjdk/vol-memory/01-struct-page-folio.md`
2. `docs/openjdk/vol-memory/02-buddy-pcp-gfp.md`
3. `docs/openjdk/vol-memory/03-pagetables-tlb.md`
4. `docs/openjdk/vol-memory/04-mmstruct-vma.md`
5. `docs/openjdk/vol-memory/05-page-fault-scenarios.md`
6. `docs/openjdk/vol-memory/06-page-cache-xarray.md`
7. `docs/openjdk/vol-memory/07-writeback-dirty.md`
8. `docs/openjdk/vol-memory/08-reverse-mapping.md`
9. `docs/openjdk/vol-memory/09-lru-kswapd-reclaim.md`
10. `docs/openjdk/vol-memory/10-swap.md`
11. `docs/openjdk/vol-memory/11-overcommit-oom.md`
12. `docs/openjdk/vol-memory/12-memory-stats-tools.md`
13. `docs/openjdk/vol-memory/13-ptmalloc-stack.md`

### B. `vol-filesystem/`

**已整卷铺开完成模板化二轮深修：12/12。**

已补模板文件：

1. `docs/openjdk/vol-filesystem/01-ext2-disk-layout.md`
2. `docs/openjdk/vol-filesystem/02-ext2-inode-indirect-blocks.md`
3. `docs/openjdk/vol-filesystem/03-file-creation-touch.md`
4. `docs/openjdk/vol-filesystem/04-write-data-flow.md`
5. `docs/openjdk/vol-filesystem/05-read-data-flow.md`
6. `docs/openjdk/vol-filesystem/06-file-deletion-xattr-locks.md`
7. `docs/openjdk/vol-filesystem/07-filesystem-comparison.md`
8. `docs/openjdk/vol-filesystem/08-jbd2-journal.md`
9. `docs/openjdk/vol-filesystem/09-cow-snapshot.md`
10. `docs/openjdk/vol-filesystem/10-mount-permissions.md`
11. `docs/openjdk/vol-filesystem/11-nfs-network-fs.md`
12. `docs/openjdk/vol-filesystem/12-object-distributed-fs.md`

### C. `vol-network/`

**已整卷铺开完成模板化二轮深修：14/14。**

已补模板文件：

1. `docs/openjdk/vol-network/01-tcpip-model-arp.md`
2. `docs/openjdk/vol-network/02-tcp-state-machine.md`
3. `docs/openjdk/vol-network/03-tcp-flow-congestion.md`
4. `docs/openjdk/vol-network/04-tcp-troubleshooting.md`
5. `docs/openjdk/vol-network/05-kernel-recv-path.md`
6. `docs/openjdk/vol-network/06-kernel-send-path.md`
7. `docs/openjdk/vol-network/07-io-models.md`
8. `docs/openjdk/vol-network/08-epoll-reactor.md`
9. `docs/openjdk/vol-network/09-million-concurrency.md`
10. `docs/openjdk/vol-network/10-netfilter-nat.md`
11. `docs/openjdk/vol-network/11-ssl-tls.md`
12. `docs/openjdk/vol-network/12-http-evolution.md`
13. `docs/openjdk/vol-network/13-dns-cdn-websocket.md`
14. `docs/openjdk/vol-network/14-container-network.md`

### D. `vol-system-performance/`

**已整卷铺开完成模板化二轮深修：8/8。**

已补模板文件：

1. `docs/openjdk/vol-system-performance/01-methodology-foundation.md`
2. `docs/openjdk/vol-system-performance/02-benchmark-measurement.md`
3. `docs/openjdk/vol-system-performance/03-cpu-perf-flamegraph.md`
4. `docs/openjdk/vol-system-performance/04-tma-roofline.md`
5. `docs/openjdk/vol-system-performance/05-memory-disk-network-observability.md`
6. `docs/openjdk/vol-system-performance/06-ftrace-bpf-tracing.md`
7. `docs/openjdk/vol-system-performance/07-wait-analysis-optimization.md`
8. `docs/openjdk/vol-system-performance/08-source-code-tuning.md`

### E. `vol-ebpf/`

**已整卷铺开完成模板化二轮深修：7/7。**

已补模板文件：

1. `docs/openjdk/vol-ebpf/01-ebpf-architecture.md`
2. `docs/openjdk/vol-ebpf/02-ebpf-maps-ringbuf.md`
3. `docs/openjdk/vol-ebpf/03-libbpf-skel-development.md`
4. `docs/openjdk/vol-ebpf/04-bpftrace-programming.md`
5. `docs/openjdk/vol-ebpf/05-tracing-sources-selection.md`
6. `docs/openjdk/vol-ebpf/06-cpu-memory-observability.md`
7. `docs/openjdk/vol-ebpf/07-network-security-xdp.md`

---

## 3. 当前已经稳定的二轮模板风格

下一位 AI 如果继续做二轮深修，**不要再探索模板长什么样**，直接复用下述 patch 风格：

### 3.1 篇首固定补法

在 `主题 / 前置文章 / 本篇后续` 之后，补：

- `一句话困惑`
- `一句话顿悟`
- `依赖分类`
  - 硬依赖
  - 软依赖
  - 导航依赖
- 保留原 `版本说明`

### 3.2 正文补法

不要大改结构；只在**最关键判断句后**补 1~2 句“证据位提醒”：

- 指向模块/文件/常见函数名
- 提醒这一判断落在哪条实现路径上
- 若是边界性强结论，顺手补一句“不要把它误读成所有版本/所有实现都如此”

### 3.3 篇尾补法

在收束和下一篇桥接之间，插入：

- `误解清单`
- `证据清单`
- `边界清单`

### 3.4 不要做的事

- 不要推倒重写小标题结构
- 不要在无源码树环境下伪造精确 `file:line`
- 不要为了“源码感”堆大段代码块
- 不要一次横跳多个卷散着修

---

## 4. 仍然必须遵守的全局硬约束

### 4.1 方法论文档必读

先读：

- `docs/openjdk/WRITING-METHODOLOGY.md`
- `docs/openjdk/WRITING-GUIDELINES.md`
- `docs/openjdk/HANDOFF-OS-KERNEL.md`
- `docs/openjdk/HANDOFF-VOLS-MEM-FS-NET-PERF.md`
- `docs/openjdk/HANDOFF-EBPF-SYSPROG.md`
- 本文档

### 4.2 环境约束

- **无 Linux kernel / glibc / Ceph 源码树可用**
- 禁止伪造精确 `file:line`
- 证据位表达只能用：
  - 模块/文件名
  - 常见函数名
  - 必要时加“实现路径/语义边界”说明
- `python` 命令不可用，统一用 `python3`
- 仓库存在大量既有未提交改动，**严禁任何会回滚/清理用户改动的 git 命令**

### 4.3 每次写完或深修后必做

1. 禁用词扫描必须零命中（见 `docs/openjdk/WRITING-METHODOLOGY.md` 与 `docs/openjdk/WRITING-GUIDELINES.md` 的统一禁用词清单）
2. 抽读篇首与篇尾，确认补丁风格自然
3. 检查文件尾部是否干净
4. 若是新增长文正文，则跑删码字符数
5. 若编辑失败/文本歧义，先 `Read` 精确定位再改

---

## 5. 本轮已经修掉的旧遗留项

### 5.1 系统编程卷 01 的 8000 字遗留项

- 旧问题来源：`docs/openjdk/HANDOFF-EBPF-SYSPROG.md:150`
- 旧值：7776
- 新值：8623
- 状态：**已修复**

### 5.2 eBPF → 系统编程跨卷桥接断层

旧问题来源：`docs/openjdk/HANDOFF-EBPF-SYSPROG.md:181`

已处理：

- `docs/openjdk/vol-ebpf/07-network-security-xdp.md` 补明确桥接到系统编程 01
- `docs/openjdk/vol-system-programming/01-file-io-basics.md` 补卷间导航回接 `vol-ebpf/07`

状态：**已修复**

---

## 6. 下一主线建议

### 6.1 当前结论

`vol-os-kernel`、`vol-system-programming`、`vol-memory`、`vol-filesystem`、`vol-network`、`vol-system-performance`、`vol-ebpf` 这七卷都已经完成同一套二轮模板化深修。

### 6.2 现在最建议做什么

优先做两件事：

1. **把最新完成状态同步回各交接文档。**
2. **转入总规划中的下一条独立主线**，优先级可在 `MySQL/` 与 `分布式/` 间选择。

### 6.3 如果仍然停留在内功线

若不立刻转新主线，最值得做的不是再探索模板，而是针对 `vol-os-kernel` 中篇幅仍偏短的代表篇做第三轮补强，优先：

- `docs/openjdk/vol-os-kernel/05-mesi-false-sharing.md`
- `docs/openjdk/vol-os-kernel/06-atomic-barriers.md`
- `docs/openjdk/vol-os-kernel/07-lock-family.md`
- `docs/openjdk/vol-os-kernel/08-rcu-deadlock.md`
- `docs/openjdk/vol-os-kernel/09-interrupts-softirq.md`
- `docs/openjdk/vol-os-kernel/10-cfs-scheduler.md`
- `docs/openjdk/vol-os-kernel/12-thundering-herd-epoll.md`
- `docs/openjdk/vol-os-kernel/13-vfs-ext4.md`
- `docs/openjdk/vol-os-kernel/17-virtualization.md`
- `docs/openjdk/vol-os-kernel/18-ipc.md`

补强方向仍遵守 `HANDOFF-OS-KERNEL.md`：优先补事故感、排障感、失败方案与用户体感，不靠堆术语或堆代码块扩字。

---

## 7. 推荐给下一位 AI 的开场动作

如果继续工作，建议严格按这个顺序：

1. 读本交接文档
2. 先确认当前是在做**交接回写**、**转新主线**，还是**给已完成卷做第三轮补强**
3. 若转新主线，先读对应总规划目录与方法论文档，再读目标卷/主题的现有提纲或正文
4. 若继续补强已完成卷，对照同卷相邻已修篇，沿同一模板只补证据位、边界与三清单，不重排结构
5. 跑禁用词扫描
6. 读篇首与篇尾抽查自然度
7. 必要时再做删码字符数与尾部清洁检查

---

## 8. 给下一位 AI 的最后一句话

**现在最值钱的不是继续探索“模板长什么样”，而是承认这套二轮 patch 风格已经在内功七卷上全部跑通；接下来要么把最新状态同步进交接体系，要么带着同样的方法论转入 `MySQL/`、`分布式/` 等下一条主线，而不是再回头重复发明模板。**
