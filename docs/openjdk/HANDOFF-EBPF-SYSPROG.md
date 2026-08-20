# HANDOFF — `vol-ebpf` 完成 + `vol-system-programming` 进行中（2/7）交接文档

> 交接日期：2026-08-19
> 交接范围：
> - `/data/workspace/source-code/openjdk-book/docs/openjdk/vol-ebpf/`（已完成 7/7）
> - `/data/workspace/source-code/openjdk-book/docs/openjdk/vol-system-programming/`（已完成 2/7）
> 当前状态：eBPF 卷第一轮正文已全部落盘；系统编程卷已写 01、02 两篇（02 经过一次深度修复补充），03-07 待写。
> 下一主线建议：**继续写 `vol-system-programming/03-fork-exec-daemon.md`**，完成后依次 04-07；系统编程卷结束后，再回到此前四卷（memory/filesystem/network/performance）的二轮深修（见 §4 与 `HANDOFF-VOLS-MEM-FS-NET-PERF.md`）。

---

## 0. 先看结论

本次会话完成了两个新卷：

- `vol-ebpf/`：7/7 篇第一轮正文全部完成（前序轮次完成 01-04，本次完成 05-07）。
- `vol-system-programming/`：01、02 两篇完成；02 篇在用户要求下做了深度修复与补充。

### `vol-ebpf/`（7/7）

```text
docs/openjdk/vol-ebpf/
├── 01-ebpf-architecture.md
├── 02-ebpf-maps-ringbuf.md
├── 03-libbpf-skel-development.md
├── 04-bpftrace-programming.md
├── 05-tracing-sources-selection.md
├── 06-cpu-memory-observability.md
└── 07-network-security-xdp.md
```

### `vol-system-programming/`（2/7）

```text
docs/openjdk/vol-system-programming/
├── 01-file-io-basics.md      ✅ 已完成（曾发生写入损坏，已整篇重写修复）
├── 02-mmap-epoll-inotify.md  ✅ 已完成（初稿 268 行/8026 字符 → 深修后 292 行/9296 字符）
├── 03-fork-exec-daemon.md    ⬜ 下一篇（大纲已存在，见 §5）
├── 04-pthread-threads.md     ⬜ 待写
├── 05-signals-timers-malloc.md ⬜ 待写
├── 06-memory-malloc-debug.md ⬜ 待写
└── 07-cpp-atomic-lockfree.md ⬜ 待写
```

注意：`docs/openjdk/vol-system-programming/` 目录下**只有 01、02 两篇正文**；`completeness-questions.md`（23 题完备性提问）位于**大纲目录** `规划/内功修炼/outlines/07-系统编程/`，不在 docs 目录树中。

这些文章全部遵循：

- `docs/openjdk/WRITING-METHODOLOGY.md`
- `docs/openjdk/WRITING-GUIDELINES.md`
- 与 `HANDOFF-OS-KERNEL.md`、`HANDOFF-VOLS-MEM-FS-NET-PERF.md` 延续的写作节奏

并且每篇至少做过：

- 篇幅检查（正文删码后 ≥8000 字符）
- 禁用词扫描
- 结构闭环检查
- 与上一篇桥接衔接检查

---

## 1. 本次会话的关键事件（下一位 AI 必读）

### 1.1 写入损坏事故（重要教训）

`vol-system-programming/01-file-io-basics.md` 初稿写入时，文件尾部混入了大量垃圾字符（如 `⋯`、`}ҩыз`、`} 马会`、成串 `} \n` 行、`{":1}` 等），且正文被截断（只剩 137 行，第三节中途断掉）。

处置：检测到异常后，**整篇重写**该文件为干净版本（275 行），并完成验证。

教训：**每次 `write` 大文件后，必须立刻做一次落盘校验**，至少包含：
1. 读取文件尾部 30-50 行，确认没有垃圾字符/截断；
2. `python3` 统计行数与删码字符数；
3. 禁用词 grep。

### 1.2 用户对篇幅的反馈与"深度修复和补充"

用户对 275 行（约 8000 字符）的 01 篇提出疑问后，明确要求"深度修复和补充"。02 篇因此走了完整流程：

- 初稿写完后验证：292 行、删码后 9296 字符、无禁用词；
- 随后又做一轮深度补充，新增内容：
  - `MAP_ANONYMOUS` vs `malloc` 的边界；
  - `MAP_SHARED` 写入后仍需 `msync`/`fsync` 的持久化决策；
  - ET 模式"非阻塞 + 读干净到 EAGAIN"纪律；
  - `EPOLLONESHOT`/`EPOLLHUP`/`EPOLLERR` 边界选项；
  - `openat2` 解析约束（fstat 不解决全部路径安全问题）；
  - inotify rename cookie、`IN_Q_OVERFLOW`、事件合并与队列防御。

**建议：02 篇可作为本卷后续篇章的篇幅/密度参考标准。**

---

## 2. 必须遵守的方法论与硬约束

先读：

- `docs/openjdk/WRITING-METHODOLOGY.md`
- `docs/openjdk/WRITING-GUIDELINES.md`
- `docs/openjdk/HANDOFF-OS-KERNEL.md`
- `docs/openjdk/HANDOFF-VOLS-MEM-FS-NET-PERF.md`
- 本文档

### 2.1 环境硬约束

- **无 Linux kernel / glibc / Ceph 源码树可用**（见 `HANDOFF-OS-KERNEL.md` §1.3）。禁止伪造 `file:line`；正文只保留模块/文件名级导航（如 `mm/mmap.c`、`fs/eventpoll.c`、`kernel/fork.c`）。
- `python` 命令不可用，用 `python3` 做字符统计。
- 仓库有大量**既有未提交改动**（`vol-02`、`vol-java`、`WRITING-GUIDELINES.md` 等为 `M`），新文章为 `??` 未跟踪。**严禁运行任何会回滚/清理用户改动的 git 命令**（`git checkout .`、`git reset --hard`、`git clean` 一律禁用）。

### 2.2 每篇写作完成的验收清单

1. `python3` 统计：正文删码后字符数 ≥8000（机制类主文），统计脚本：
   ```python
   import re; from pathlib import Path
   text = Path('FILE').read_text()
   narr = re.sub(r'```[^\n]*\n.*?```', '', text, flags=re.S)
   print(len(narr.replace('\n','').replace(' ','')))
   ```
2. 禁用词 grep 必须零命中：
   `此处不再赘述|不再展开|类似地|同理|依此类推|篇幅所限|显然|容易看出|细节读者自行阅读源码`
3. 篇首含：主题/前置文章/本篇后续/依赖分类（硬/软/导航）/版本说明。
4. 篇中每个大节有"本节最该记住的结论"与"一句最短人话"。
5. 篇尾含：收束（回扣开头问题）+ 下一篇桥接（写清下篇标题与承接的问题）。
6. 落盘后立即校验文件尾部（见 §1.1 教训）。

### 2.3 系统编程卷的既有桥接链

- 01 篇桥接段承诺了 02 篇主题（mmap/epoll/inotify）——已兑现。
- 02 篇桥接段承诺了 03 篇主题（fork/exec/daemon、地址空间与 fd 表继承、信号处理重置）——**写 03 时必须回扣此承诺**。
- 03 篇大纲悬念："fd 能打开文件、epoll 能监控事件、mmap 能映射地址；进程通过 fork/exec 创建后，fd 表、地址空间和信号处理到底如何继承与重置？"

---

## 3. 已完成文件的验证状态

### 3.1 `vol-ebpf/` 各篇验证状态

本轮完成的 05-07 三篇，均按流程跑过：`python3` 删码字符统计（≥8000）+ 禁用词 grep（零命中）+ 结构检查。与 01-04 共同构成完整 7 篇 eBPF 卷：

| 篇 | 文件 | 主题 |
|---|---|---|
| 01 | `01-ebpf-architecture.md` | eBPF 架构总览 |
| 02 | `02-ebpf-maps-ringbuf.md` | maps 与 ringbuf |
| 03 | `03-libbpf-skel-development.md` | libbpf/skel 开发 |
| 04 | `04-bpftrace-programming.md` | bpftrace 编程 |
| 05 | `05-tracing-sources-selection.md` | 追踪源选择 |
| 06 | `06-cpu-memory-observability.md` | CPU/内存可观测性 |
| 07 | `07-network-security-xdp.md` | 网络与安全/XDP |

### 3.2 `vol-system-programming/` 各篇验证状态

- `01-file-io-basics.md`：重写后 275 行。**2026-08-19 复核**：删码后 7776 字符（**低于 8000 线，遗留项**），禁用词扫描零命中，尾部干净。
- `02-mmap-epoll-inotify.md`：292 行，删码后 9296 字符，无禁用词；深修补充完成。

---

## 4. 全局待办（不因本卷推进而消失）

### 4.1 四卷二轮深修（最高优先级遗留项）

`HANDOFF-VOLS-MEM-FS-NET-PERF.md` 已详述：`vol-memory`(13)、`vol-filesystem`(12)、`vol-network`(14)、`vol-system-performance`(8) 四卷是"第一轮教学正文"，尚未完成"源码证据位/依赖分类/边界清单"二轮提纯。推荐深修顺序：

1. `vol-memory/13-ptmalloc-stack.md`
2. `vol-filesystem/08-jbd2-journal.md`
3. `vol-network/10-netfilter-nat.md`
4. `vol-system-performance/01-methodology-foundation.md`

然后按同一模板批量铺开。**注意**：在无源码树环境下，证据位只能用"模块/文件名 + 常见函数名 + 版本限定"表达，不要伪造精确行号。

### 4.2 上一份交接文档的 review 遗留

`HANDOFF-VOLS-MEM-FS-NET-PERF.md` 自身仍缺四件事，且**本文档目前仍未覆盖**，全部属于遗留项：

- 源码树可用性说明（本文档 §2.1 已单独给出，但旧档未回改）；
- 深审完成度分级（哪些篇只做了基础检查）——四卷与 eBPF 卷均未做分级；
- 完整跨卷依赖矩阵——**新旧两份交接都没有提供**，只有篇首自然语言前置与局部桥接链；
- "勿回滚既有未提交改动"的显式警告（本文档 §2.1 已单独给出，但旧档未回改）。

### 4.3 `vol-ebpf` 卷同样是"第一轮正文"

与四卷同待遇：`vol-ebpf/` 7 篇也是第一轮教学正文，尚未做证据位/依赖/边界二轮提纯（`07-network-security-xdp.md:5` 自身也写明"可回到 eBPF 卷做二轮提纯"）。将来深修时把它并入 §4.1 的批量模板。

### 4.4 跨卷桥接断裂：`vol-ebpf/07` → `vol-system-programming/01`

核验发现：

- `vol-ebpf/07-network-security-xdp.md` **没有"下一篇桥接"小节**（全卷其余 6 篇均有），其篇首"本篇后续"写的是"转入阶段 7 系统编程**或**回到 eBPF 卷做二轮提纯"，未定向承诺；
- `vol-system-programming/01-file-io-basics.md:4` 前置文章只引用 `vol-filesystem/03、04、05` 三篇，**没有回指 `vol-ebpf/07`**。

即 eBPF 卷与系统编程卷之间存在桥接断层。建议写 03 篇或回修时处理：给 `vol-ebpf/07` 补一段明确的"下一篇桥接"指向系统编程卷 01，或在系统编程卷篇首前置中补上 eBPF 卷导航依赖。

---

## 5. 下一步：`vol-system-programming/03-fork-exec-daemon.md`

### 5.1 大纲与写作入口

- 大纲：`/data/workspace/source-code/book/成长之路/tmp-question/程序员从入门到放弃之路/规划/内功修炼/outlines/07-系统编程/03-fork-exec-daemon.md`
- 标题：fork、exec、wait 与 daemon — 进程如何复制、替换、回收和脱离终端
- 关键概念链（按大纲）：fork（copy-on-write、fd 表复制、父子关系）→ execve（地址空间替换、fd 标志、信号重置）→ wait/僵尸进程 → daemon 化（setsid/脱离控制终端/重定向 stdio）。
- 完成后依序 04-pthread-threads、05-signals-timers-malloc、06-memory-malloc-debug、07-cpp-atomic-lockfree。

### 5.2 写作提示

- 回扣 02 篇桥接承诺（fd 表、地址空间、信号在 fork/exec 下如何继承与重置）。
- 引用此前卷的已有结论：内存卷的 COW/缺页（fork 的 copy-on-write）、系统编程 01 篇的 fd/open file description 继承（fork 复制 fd 表）。
- 大纲自带的 completeness-questions.md（23 题，5 身份）可用来检查覆盖度。

---

## 6. 推荐给下一位 AI 的开场动作

1. 读 `HANDOFF-VOLS-MEM-FS-NET-PERF.md`（四卷状态与深修模板）。
2. 读本卷 01、02 两篇正文，把握已建立的桥接与叙述风格。
3. 打开大纲 `03-fork-exec-daemon.md`，按其叙事顺序写正文。
4. 写完后执行 §2.2 验收清单（尤其落盘后校验尾部）。

---

## 7. 下一位 AI 要特别记住的一句话

**系统编程卷的 01-02 已完成且经过一次事故修复与一次深度补充，是当前最干净的样板；继续写 03-07 时，每篇落盘后第一件事就是校验文件尾部是否干净、删码字数是否过线，不要把"write 成功"当成"写对了"。**
