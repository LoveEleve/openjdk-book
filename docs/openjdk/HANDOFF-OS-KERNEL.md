# HANDOFF — `vol-os-kernel` 正文写作交接文档

> 交接日期：2026-08-18
> 交接范围：`/data/workspace/source-code/openjdk-book/docs/openjdk/vol-os-kernel/`
> 当前状态：**19/19 篇已全部落盘，并已按统一模板完成一轮二轮深修（补依赖分类、证据位导航、误解/证据/边界三清单）**
> 下一主线建议：`vol-os-kernel` 二轮模板化深修已收口；若仍停留在本卷，可对篇幅仍偏短的代表篇做第三轮事故感/排障感补强，否则转入总规划中的下一条独立主线

---

## 0. 先看结论

本次会话已经把 `vol-os-kernel/` 的 19 篇正文全部写完，文件如下：

```text
docs/openjdk/vol-os-kernel/
├── 01-buddy-slab-physical-memory.md
├── 02-paging-page-tables.md
├── 03-mmap-vma-page-fault.md
├── 04-page-cache-reclaim-oom.md
├── 05-mesi-false-sharing.md
├── 06-atomic-barriers.md
├── 07-lock-family.md
├── 08-rcu-deadlock.md
├── 09-interrupts-softirq.md
├── 10-cfs-scheduler.md
├── 11-process-fork-switch.md
├── 12-thundering-herd-epoll.md
├── 13-vfs-ext4.md
├── 14-page-cache-io-path.md
├── 15-block-io-epoll.md
├── 16-container-namespace-cgroup.md
├── 17-virtualization.md
├── 18-ipc.md
└── 19-kernel-boot-debug.md
```

这些文章都遵循了 `docs/openjdk/WRITING-METHODOLOGY.md` 与 `docs/openjdk/WRITING-GUIDELINES.md` 的三步分离流程，且每篇都做过至少一轮结构/删码/禁用词/桥接检查。

但请注意：**这一批文章整体存在一个系统性问题——中后段多篇“结构闭环已成立，但篇幅仍低于主机制篇理想目标（8k+ 叙述字符）”。** 这不是事实错误，而是“教学打穿度”仍可继续拔高的空间。若下一位 AI 要做二轮全面提纯，优先从这个问题下手，而不是重写结构。

---

## 1. 当前产出定位

### 1.1 已完成的不是“源码注释版”，而是第一轮教学正文

这些文章不是单纯把 outline 展开成散文，而是按以下逻辑写成：

- 场景/困惑开篇
- 失败方案推演
- 角色—动机—障碍—手段主线
- 机制拆解
- 误解澄清
- 桥接下一篇

所有文章都努力做到：**删掉代码块后，文章主线仍能成立。**

### 1.2 这一批文章的共同风格

统一采用了这些写法：

- 少讲“字段说明”，多讲“角色为什么这么做”
- 先人话心智图，再讲术语
- 先把“为什么不能更简单”说透，再落设计
- 不依赖 Linux 源码工作树本地逐行核对行号
- 代码/函数/文件只作为“证据导航”，不是文章骨架

### 1.3 为什么没有硬塞 `file:line`

当前环境里**没有可用的 Linux kernel 源码树**，因此这批文章没有伪造当前源码行号。

做法是：

- 保留了稳定的文件/模块名导航，如 `mm/page_alloc.c`、`fs/eventpoll.c`
- 所有“版本依赖、参数范围、默认值、具体实现细节”都刻意避免写成普遍常量
- 需要精确行号的内容停留在原始 outline 里，正文不冒充“已逐行核验”

这点非常重要。下一位 AI 如果要补精确源码行号，必须先有真实 Linux 源码树，再做逐段重验。

---

## 2. 必须遵守的方法论与规范

### 2.1 两个总文档是强约束，不是参考读物

先读：

- `docs/openjdk/WRITING-METHODOLOGY.md`
- `docs/openjdk/WRITING-GUIDELINES.md`

最低执行要求：

1. **三步分离**：素材提取 → 理解路径设计 → 叙事写作
2. **正文不是源码翻译**
3. **删码测试必须通过**
4. **至少一个失败方案推演**
5. **篇末必须桥接下一篇**
6. **先问题、场景、障碍，再设计与代码证据**

### 2.2 当前卷的默认节奏

本卷已经形成的稳定工作流如下：

1. 读对应 outline
2. 读前一篇已完成正文的桥接段
3. 明确本篇“读者真正困惑”
4. 先设计文章结构，不急着写正文
5. 写正文
6. 做 1 轮以上深审
7. 修复后再进入下一篇

### 2.3 默认不要做的事

- 不要把旧项目 `规划/` 里的源码行号直接搬进正文当事实
- 不要按源码文件顺序写文章
- 不要把“合理推测”写成“源码明确保证”
- 不要把“中断门/锁/页表/容器”等主题写成术语清单
- 不要补大段代码块来凑篇幅

---

## 3. 这一批文章的完成状态

### 3.1 已写完且通过基础终检的文件

1. `docs/openjdk/vol-os-kernel/01-buddy-slab-physical-memory.md`
2. `docs/openjdk/vol-os-kernel/02-paging-page-tables.md`
3. `docs/openjdk/vol-os-kernel/03-mmap-vma-page-fault.md`
4. `docs/openjdk/vol-os-kernel/04-page-cache-reclaim-oom.md`
5. `docs/openjdk/vol-os-kernel/05-mesi-false-sharing.md`
6. `docs/openjdk/vol-os-kernel/06-atomic-barriers.md`
7. `docs/openjdk/vol-os-kernel/07-lock-family.md`
8. `docs/openjdk/vol-os-kernel/08-rcu-deadlock.md`
9. `docs/openjdk/vol-os-kernel/09-interrupts-softirq.md`
10. `docs/openjdk/vol-os-kernel/10-cfs-scheduler.md`
11. `docs/openjdk/vol-os-kernel/11-process-fork-switch.md`
12. `docs/openjdk/vol-os-kernel/12-thundering-herd-epoll.md`
13. `docs/openjdk/vol-os-kernel/13-vfs-ext4.md`
14. `docs/openjdk/vol-os-kernel/14-page-cache-io-path.md`
15. `docs/openjdk/vol-os-kernel/15-block-io-epoll.md`
16. `docs/openjdk/vol-os-kernel/16-container-namespace-cgroup.md`
17. `docs/openjdk/vol-os-kernel/17-virtualization.md`
18. `docs/openjdk/vol-os-kernel/18-ipc.md`
19. `docs/openjdk/vol-os-kernel/19-kernel-boot-debug.md`

### 3.2 每篇都已做过的检查

至少做过以下检查中的大部分：

- `wc` 看篇幅
- 禁用词扫描
- 删码测试（手动/脚本剥离代码块后检查主线是否仍成立）
- 小标题反向提纲检查
- 下一篇桥接是否和真实文件名一致
- 误写英文残留清理（如 `magically`）

### 3.3 当前最值得继续做的不是“补写缺篇”，而是“在已完成二轮模板化深修的基础上，决定是否进入第三轮提纯”

因为 19 篇已经全部有了，而且现在也已经完成统一模板的二轮深修。下一位 AI 不应继续在 `vol-os-kernel/` 补新文章，而应在两条路里选一条：

1. 转入下一卷/下一主题继续写
2. 回头给这 19 篇做第三轮提纯和拔高

---

## 4. 已知系统性问题与建议修法

### 4.1 系统性问题：中后段多篇篇幅偏短（在二轮模板化深修完成后仍成立）

虽然这些文章都已闭环，但多篇删码后正文长度在约 5.2k–6.9k 字符区间，低于方法论中“重大机制篇原则上 8k+”的理想目标。

受影响最明显的，大致是：

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

### 4.2 正确补强方向

不要靠下面这些方式扩写：

- 堆术语
- 堆代码块
- 抄长表格
- 多写“定义句”

应该优先从这些方向补：

- 失败方案再具体一层
- 加现实事故/现象例子
- 加“为什么这条路没被选”
- 加更清晰的时序图/角色图
- 加“用户体感”或“线上排查”视角
- 加版本差异/边界代价/适用范围

### 4.3 每篇最适合补强的位置（仅建议）

- `docs/openjdk/vol-os-kernel/05-mesi-false-sharing.md`
  - 可补：`volatile` 不是原子性的事故场景；伪共享在 `perf c2c` 里的具体热点案例
- `docs/openjdk/vol-os-kernel/06-atomic-barriers.md`
  - 可补：消息传递模型再细一层；CAS 自旋下 ABA 的具体失败流程
- `docs/openjdk/vol-os-kernel/07-lock-family.md`
  - 可补：长临界区误用 spinlock 的失败例子；futex 慢路径突然变贵的线上感知
- `docs/openjdk/vol-os-kernel/08-rcu-deadlock.md`
  - 可补：RCU 写者为什么不能原地改对象；活锁退避为什么必须引入随机性
- `docs/openjdk/vol-os-kernel/09-interrupts-softirq.md`
  - 可补：网络收包/NAPI 或中断风暴的具体案例
- `docs/openjdk/vol-os-kernel/10-cfs-scheduler.md`
  - 可补：交互任务被埋进 CPU-bound 队列的具象场景；多核迁移带来的缓存冷启动例子
- `docs/openjdk/vol-os-kernel/12-thundering-herd-epoll.md`
  - 可补：高并发下上下文切换风暴的数值化例子；accept_mutex 的历史局限
- `docs/openjdk/vol-os-kernel/13-vfs-ext4.md`
  - 可补：逐分量路径解析案例；JBD2 三种崩溃点恢复对照
- `docs/openjdk/vol-os-kernel/17-virtualization.md`
  - 可补：shadow page table 为什么麻烦；virtio vs SR-IOV 在热迁移与弹性上的冲突
- `docs/openjdk/vol-os-kernel/18-ipc.md`
  - 可补：共享内存 + 同步原语的失败案例；Binder 一次拷贝与 socket 两次拷贝的对照图

---

## 5. 当前工作的关键约束与事实边界

### 5.1 没有 Linux kernel 源码树

当前环境里：

- 有 `openjdk-book` 仓库
- 有 `docs/openjdk/WRITING-*` 方法论文档
- **没有可直接拿来逐行核对的 Linux kernel 源码树**

因此这一批文章：

- 只保留稳定的文件/模块/概念导航
- 避免写死具体行号
- 对细枝末节参数、实现差异都尽量收束成“版本相关”描述

如果下一位 AI 拿到了真实 kernel 源码树，可以补做逐篇行号校验和局部源码证据增强。但在没有源码树前，不要假装自己核过了精确行号。

### 5.2 不要再把原项目中的旧正文当成“事实源”直接搬运

旧项目路径：

- `/data/workspace/source-code/book/成长之路/tmp-question/程序员从入门到放弃之路/正文/内功修炼/01-OS内核/`

这里只能作为**风格/结构参考**，不能直接视为已核验事实源。当前这 19 篇新正文已经不再依赖旧正文逐段改写，而是按新方法论重构过了。

### 5.3 不要再写回旧项目的 `正文/` 目录

当前正确正文目录是：

- `docs/openjdk/vol-os-kernel/`

不要再写到：

- `程序员从入门到放弃之路/正文/`

---

## 6. 下一位 AI 的推荐行动顺序

### 方案 A：继续主线，转入下一卷/下一主题（推荐）

建议直接开始 `vol-memory/` 或与之同级的新主题目录，保持当前节奏：

1. 找到对应主题 outline
2. 先读方法论文档
3. 一篇一篇写
4. 每篇写完立刻深审

优先级高于回头微调 `vol-os-kernel/`。

### 方案 B：做 `vol-os-kernel/` 的二轮提纯

如果用户明确要把 OS 卷拔高到更强教学深度，则建议：

1. 先从 `05` 到 `10` 这些并发/调度篇开始补强
2. 再处理 `12`、`13`、`17`、`18` 等偏中后段短篇
3. 每篇只做“失败方案/事故/边界/工具视角”的增量补强
4. 不轻易改动已稳定的小标题结构

### 方案 C：做总索引/README/卷级导航（只有用户明确要求时）

当前没有自动生成新的卷 README 或索引页。如果用户后续要“整理目录导航”“加卷级总览”“做阅读顺序页”，再做这类工作。

---

## 7. 推荐给下一位 AI 的实际开场动作

如果继续工作，建议先读这些：

1. `docs/openjdk/WRITING-METHODOLOGY.md`
2. `docs/openjdk/WRITING-GUIDELINES.md`
3. `docs/openjdk/HANDOFF-OS-KERNEL.md`
4. `docs/openjdk/vol-os-kernel/19-kernel-boot-debug.md`

如果转入下一主题，再读对应 outline 与执行计划。

---

## 8. 本批工作的一句话总结

`vol-os-kernel/` 已经从“旧 outline 驱动的知识点集合”推进到了“可连续阅读的 19 篇机制正文主线”，当前最重要的价值不是再补缺篇，而是：

- 要么转入下一主题继续推进全书
- 要么回头把中后段主机制篇进一步扩成更强的教学重击版

---

## 9. 文件位置总览

### 方法论与规范

- `docs/openjdk/WRITING-METHODOLOGY.md`
- `docs/openjdk/WRITING-GUIDELINES.md`
- `docs/openjdk/SESSION-HANDOFF.md`
- `docs/openjdk/HANDOFF-OS-KERNEL.md`

### 当前正文卷

- `docs/openjdk/vol-os-kernel/01-buddy-slab-physical-memory.md`
- `docs/openjdk/vol-os-kernel/02-paging-page-tables.md`
- `docs/openjdk/vol-os-kernel/03-mmap-vma-page-fault.md`
- `docs/openjdk/vol-os-kernel/04-page-cache-reclaim-oom.md`
- `docs/openjdk/vol-os-kernel/05-mesi-false-sharing.md`
- `docs/openjdk/vol-os-kernel/06-atomic-barriers.md`
- `docs/openjdk/vol-os-kernel/07-lock-family.md`
- `docs/openjdk/vol-os-kernel/08-rcu-deadlock.md`
- `docs/openjdk/vol-os-kernel/09-interrupts-softirq.md`
- `docs/openjdk/vol-os-kernel/10-cfs-scheduler.md`
- `docs/openjdk/vol-os-kernel/11-process-fork-switch.md`
- `docs/openjdk/vol-os-kernel/12-thundering-herd-epoll.md`
- `docs/openjdk/vol-os-kernel/13-vfs-ext4.md`
- `docs/openjdk/vol-os-kernel/14-page-cache-io-path.md`
- `docs/openjdk/vol-os-kernel/15-block-io-epoll.md`
- `docs/openjdk/vol-os-kernel/16-container-namespace-cgroup.md`
- `docs/openjdk/vol-os-kernel/17-virtualization.md`
- `docs/openjdk/vol-os-kernel/18-ipc.md`
- `docs/openjdk/vol-os-kernel/19-kernel-boot-debug.md`

### 原始 outline 来源

- `/data/workspace/source-code/book/成长之路/tmp-question/程序员从入门到放弃之路/规划/内功修炼/outlines/01-OS内核/`

---

## 10. 给下一位 AI 的最后一句话

不要再把这 19 篇当成“待起步项目”，它们已经是**完成一轮正文 + 一轮统一模板化二轮深修**的整卷。你的任务不再是“把 outline 写出来”，而是：

- 继续推进下一主题，保持这套方法论节奏
- 或者把这 19 篇从“二轮模板已收口”继续打磨到“每篇都更像重磅教学文章”
