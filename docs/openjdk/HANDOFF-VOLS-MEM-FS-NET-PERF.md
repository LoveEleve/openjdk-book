# HANDOFF — `vol-memory` / `vol-filesystem` / `vol-network` / `vol-system-performance` 写作与深修交接文档

> 交接日期：2026-08-19
> 交接范围：
> - `/data/workspace/source-code/openjdk-book/docs/openjdk/vol-memory/`
> - `/data/workspace/source-code/openjdk-book/docs/openjdk/vol-filesystem/`
> - `/data/workspace/source-code/openjdk-book/docs/openjdk/vol-network/`
> - `/data/workspace/source-code/openjdk-book/docs/openjdk/vol-system-performance/`
> 当前状态：四个卷的**第一轮正文主线已全部落盘**，但**尚未完成二轮“源码证据位补齐”与“依赖/边界统一提纯”**
> 下一主线建议：优先转入 **系统性能卷的二轮深修模板化修补**，随后按同法批量回修 `vol-memory` / `vol-filesystem` / `vol-network`

---

## 0. 先看结论

本次会话完成了以下四个新卷的第一轮正文写作：

### `vol-memory/`（13/13）

```text
docs/openjdk/vol-memory/
├── 01-struct-page-folio.md
├── 02-buddy-pcp-gfp.md
├── 03-pagetables-tlb.md
├── 04-mmstruct-vma.md
├── 05-page-fault-scenarios.md
├── 06-page-cache-xarray.md
├── 07-writeback-dirty.md
├── 08-reverse-mapping.md
├── 09-lru-kswapd-reclaim.md
├── 10-swap.md
├── 11-overcommit-oom.md
├── 12-memory-stats-tools.md
└── 13-ptmalloc-stack.md
```

### `vol-filesystem/`（12/12）

```text
docs/openjdk/vol-filesystem/
├── 01-ext2-disk-layout.md
├── 02-ext2-inode-indirect-blocks.md
├── 03-file-creation-touch.md
├── 04-write-data-flow.md
├── 05-read-data-flow.md
├── 06-file-deletion-xattr-locks.md
├── 07-filesystem-comparison.md
├── 08-jbd2-journal.md
├── 09-cow-snapshot.md
├── 10-mount-permissions.md
├── 11-nfs-network-fs.md
└── 12-object-distributed-fs.md
```

### `vol-network/`（14/14）

```text
docs/openjdk/vol-network/
├── 01-tcpip-model-arp.md
├── 02-tcp-state-machine.md
├── 03-tcp-flow-congestion.md
├── 04-tcp-troubleshooting.md
├── 05-kernel-recv-path.md
├── 06-kernel-send-path.md
├── 07-io-models.md
├── 08-epoll-reactor.md
├── 09-million-concurrency.md
├── 10-netfilter-nat.md
├── 11-ssl-tls.md
├── 12-http-evolution.md
├── 13-dns-cdn-websocket.md
└── 14-container-network.md
```

### `vol-system-performance/`（8/8）

```text
docs/openjdk/vol-system-performance/
├── 01-methodology-foundation.md
├── 02-benchmark-measurement.md
├── 03-cpu-perf-flamegraph.md
├── 04-tma-roofline.md
├── 05-memory-disk-network-observability.md
├── 06-ftrace-bpf-tracing.md
├── 07-wait-analysis-optimization.md
└── 08-source-code-tuning.md
```

这些文章全部遵循了：

- `docs/openjdk/WRITING-METHODOLOGY.md`
- `docs/openjdk/WRITING-GUIDELINES.md`
- 与 `docs/openjdk/HANDOFF-OS-KERNEL.md` 延续下来的写作节奏

并且每篇至少做过：

- 篇幅检查
- 禁用词扫描
- 基础结构闭环检查
- 与上一篇桥接衔接检查

但是必须明确：**这一批文章目前是“第一轮教学正文”，不是“已完成源码证据补齐的终稿”。**

当前最重要的后续工作，不是继续补新卷，而是：

1. 给这四卷做**二轮提纯**；
2. 尤其补齐“源码证据位 / 依赖分类 / 边界清单”；
3. 把“高质量教学正文”提升为“高质量源码分析正文”。

---

## 1. 这一批产出的真实定位

### 1.1 已完成的是“机制主线正文”，不是“逐行源码考据版”

这一批文章的强项在于：

- 开场能抓读者困惑
- 有失败方案推演
- 有角色—动机—障碍—手段主线
- 能形成单篇闭环
- 篇末桥接比较稳
- 删码后叙述主线大多仍成立

这一批文章的共同弱项在于：

- **源码证据位稀薄**
- 很多判断只有模块/文件名导航，没有 `file:line` 级托底
- 依赖记录多写在篇首自然语言里，**没有系统化明确标成“硬/软/导航依赖”**
- 边界说明虽然有版本说明，但**正文内部对“哪些说法只是当前实现/常见实现”提醒还不够均匀**

### 1.2 它们已经能连续阅读，但还没完全达到方法论文档要求的“源码正文”形态

当前这批稿子大致处在：

- **作为教学文章，结构基本成立**
- **作为源码分析文章，证据密度不足**

这点非常关键。下一位 AI 不要把它们当作“重写失败品”，也不要把它们误认为“已经彻底收敛的终稿”。它们最适合的定位是：

> **第一轮完整正文，等待二轮证据化与规范化提纯。**

---

## 2. 必须遵守的方法论与补强原则

先读：

- `docs/openjdk/WRITING-METHODOLOGY.md`
- `docs/openjdk/WRITING-GUIDELINES.md`
- `docs/openjdk/HANDOFF-OS-KERNEL.md`
- 本文档

### 2.1 这次深修最重要的不是“再扩字数”，而是补齐方法论硬约束

根据 `docs/openjdk/WRITING-METHODOLOGY.md`，当前最欠缺的不是结构，而是：

1. `file:line` 级源码锚点
2. 依赖分类（硬/软/导航）
3. 事实与推断的显式分离
4. 边界与代价的可定位说明
5. 证据清单的系统化沉淀

### 2.2 当前绝对不要做的事

- 不要整卷推倒重写
- 不要先追求统一文风润色
- 不要靠堆代码块来“补源码感”
- 不要在没有真实源码核验的情况下伪造精确行号
- 不要把“常见实现”“大多数情况”写成“所有版本都如此”
- 不要只改标题和开头，不补证据位

### 2.3 当前最正确的修法

对每篇采用同一个二轮修法模板：

1. **篇首补依赖分类**
2. **正文关键结论后补 `file:line` 证据位**
3. **篇尾补“证据清单 / 边界清单 / 误解清单”**
4. **对强结论加版本/实现边界限定**
5. **不破坏当前已成型的小标题结构**

---

## 3. 当前发现的系统性问题（非常重要）

这是我在一次 review 抽样中发现的共性问题，下一位 AI 必须正视。

### 3.1 最大问题：源码证据位稀薄

`docs/openjdk/WRITING-METHODOLOGY.md:237` 明确要求：

- “每个源码行号已重新验证”

但当前四卷多数正文虽然有：

- 文件名
- 模块名
- 常见函数名

却很少真正落下：

- `file:line`
- “哪段代码证明了这句判断”
- “这句是源码事实 / 这句是设计推断”

这会带来三个直接后果：

1. 事实审很难做
2. 因果审很难做
3. 文章更像高质量系统课讲义，而不是源码分析书

### 3.2 第二问题：依赖写得顺，但分类没写清

当前很多篇都把“上一篇”写成前置，但其实其中大量是：

- 叙事桥接
- 软依赖
- 导航依赖

而不是“没读就完全看不懂”的硬依赖。

如果不把这层分类写清，后续读者和后续 AI 都会误判阅读顺序与复用关系。

### 3.3 第三问题：边界说明存在，但分布不均

多数文章篇首有版本说明，这很好。

但问题是：

- 到正文中部或关键判断处，很多“当前实现”“常见实现”“典型配置”没有继续提醒
- 某些非常顺的结论，读起来像普遍规律

这容易在后续被误读成：

- 所有 Linux/所有 glibc/所有 Ceph/所有内核版本都如此

### 3.4 第四问题：少量篇章已达到篇幅线，但“事故感/排障感”仍可拔高

尤其是：

- `vol-network/`
- `vol-system-performance/`

这些主题天然适合加入：

- 线上事故感
- 指标与现象的对应
- 真实排障路径

当前虽然有机制线，但还可以更“打人”。

---

## 4. 抽样 review 里已定位的代表性高优先级文件

建议下一位 AI 先从这些代表篇着手做“模板化修法”，再推广到全卷。

### A. `docs/openjdk/vol-memory/13-ptmalloc-stack.md`

问题：

- `docs/openjdk/vol-memory/13-ptmalloc-stack.md:6` 只有版本说明，没有证据位框架
- 正文大量在讲：
  - bins
  - `brk` vs `mmap`
  - tcache
  - 栈自动增长
- 但几乎没有 `glibc/malloc/malloc.c`、`mm/mmap.c`、`mm/memory.c` 级 `file:line` 锚点

建议修法：

- 给以下关键结论补 `file:line`：
  - bins 分层
  - `mmap` threshold
  - `malloc_trim`
  - tcache fast path
  - `VM_GROWSDOWN` / `expand_stack`
- 末尾补：
  - 一句话困惑
  - 一句话顿悟
  - 证据清单
  - 边界清单

### B. `docs/openjdk/vol-filesystem/08-jbd2-journal.md`

问题：

- 文章教学线很强，但 JBD2 尤其需要证据位
- 当前对：
  - `handle_t`
  - `transaction_t`
  - descriptor/commit
  - recovery/replay
  - 三种 journal 模式
  的叙述几乎都缺精准托底

建议修法：

- 补 `fs/jbd2/*.c` 与 `fs/ext4/*.c` 的关键 `file:line`
- 明确标出：
  - “元数据事务保证”
  - “不等于用户数据立即持久化”
  - `ordered/writeback/journal` 的边界
- 增补一个“误解纠正”小节或证据清单

### C. `docs/openjdk/vol-network/10-netfilter-nat.md`

问题：

- hook / conntrack / NAT 的主线很顺
- 但对：
  - PREROUTING / POSTROUTING 先后
  - conntrack 首包建状态
  - SNAT/DNAT 回包复用
  - STUN/TURN/ICE 的边界
  仍然过于“讲顺了”，不够“讲证据”

建议修法：

- 补 `net/netfilter/*` 与协议侧说明的关键 `file:line`
- 在正文中对：
  - “为什么不是所有流量都同一路规则顺序”
  - “conntrack 表满意味着什么”
  - “STUN 只能看见映射，不保证可打通”
  做更硬边界提示

### D. `docs/openjdk/vol-system-performance/01-methodology-foundation.md`

问题：

- 这篇作为方法论正文，结构很好
- 但它更像一篇体系课引言，而不是“源码分析书正文”风格
- 其中大量工具/模型说明没有证据托底（虽然理论上也不总是源码点）

建议修法：

- 不要求它像 Linux 源码篇一样塞太多 `file:line`
- 但要补：
  - “这些工具对应的内核计数器/接口”最少量证据位
  - 比如 `/proc/stat`、`/proc/meminfo`、块层与网络统计的落点
- 更重要的是：
  - 在篇尾明确“下一卷/下一篇怎样用这套方法”
  - 做成全卷方法论总纲模板

---

## 5. 四个卷的完成清单

### 5.1 `vol-memory` 已完成文件

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

### 5.2 `vol-filesystem` 已完成文件

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

### 5.3 `vol-network` 已完成文件

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

### 5.4 `vol-system-performance` 已完成文件

1. `docs/openjdk/vol-system-performance/01-methodology-foundation.md`
2. `docs/openjdk/vol-system-performance/02-benchmark-measurement.md`
3. `docs/openjdk/vol-system-performance/03-cpu-perf-flamegraph.md`
4. `docs/openjdk/vol-system-performance/04-tma-roofline.md`
5. `docs/openjdk/vol-system-performance/05-memory-disk-network-observability.md`
6. `docs/openjdk/vol-system-performance/06-ftrace-bpf-tracing.md`
7. `docs/openjdk/vol-system-performance/07-wait-analysis-optimization.md`
8. `docs/openjdk/vol-system-performance/08-source-code-tuning.md`

---

## 6. 当前最推荐的下一步动作（强建议按此顺序）

### 方案 A：先做“模板化深修”，不要四卷散着改（强烈推荐）

建议顺序：

1. `docs/openjdk/vol-memory/13-ptmalloc-stack.md`
2. `docs/openjdk/vol-filesystem/08-jbd2-journal.md`
3. `docs/openjdk/vol-network/10-netfilter-nat.md`
4. `docs/openjdk/vol-system-performance/01-methodology-foundation.md`

对这 4 篇做统一修法模板：

- 篇首补：
  - 一句话困惑
  - 一句话顿悟
  - 依赖分类（硬/软/导航）
- 正文关键判断后补：
  - `file:line` 证据位
- 篇尾补：
  - 误解清单
  - 证据清单
  - 边界清单

完成后，再把同样模板推广到全卷。

### 方案 B：对四卷做“证据位批量回填”

如果不想先选代表篇，也可以按卷处理：

1. `vol-memory`
2. `vol-filesystem`
3. `vol-network`
4. `vol-system-performance`

每卷的做法：

- 先抽 3 篇代表文
- 建一个本卷 patch 风格
- 再批量铺开其余篇

### 方案 C：若用户此刻不要求深修，可直接进入下一主题

如果用户只要“继续推进全书”，则可以跳过深修，转入：

- 阶段 6：`06-eBPF`

但从质量角度说，这不是当前最优先的动作。

---

## 7. 推荐给下一位 AI 的开场动作

如果继续深修，建议先读：

1. `docs/openjdk/WRITING-METHODOLOGY.md`
2. `docs/openjdk/WRITING-GUIDELINES.md`
3. `docs/openjdk/HANDOFF-OS-KERNEL.md`
4. `docs/openjdk/HANDOFF-VOLS-MEM-FS-NET-PERF.md`
5. 然后直接打开这 4 篇代表文：
   - `docs/openjdk/vol-memory/13-ptmalloc-stack.md`
   - `docs/openjdk/vol-filesystem/08-jbd2-journal.md`
   - `docs/openjdk/vol-network/10-netfilter-nat.md`
   - `docs/openjdk/vol-system-performance/01-methodology-foundation.md`

### 推荐执行顺序

1. 先设计一份“深修模板”
2. 只修一篇，确认风格
3. 再修 3 篇代表文
4. 最后按卷批量推进

---

## 8. 下一位 AI 要特别记住的一句话

**这四个卷已经完成了“第一轮完整教学正文”，但还没有完成“源码证据位补齐后的源码分析终稿”。**

你现在最该做的，不是推倒重写，而是：

- 保留现有结构
- 补强证据位
- 清理依赖类型
- 补齐边界与误解清单
- 把正文从“讲得通”推进到“讲得准、讲得有源码锚点”。
