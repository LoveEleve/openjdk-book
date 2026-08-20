# HANDOFF — BIN 方法论重写详细交接文档

> 更新时间：2026-08-19
> 仓库：`/data/workspace/source-code/openjdk-book`
> 工作目录：`/data/workspace/source-code/openjdk-book`
> JDK 11 源码树：`/data/workspace/source-code/code/spring/jdk11/src`
> 用途：交给下一位 AI，继续按 BIN 技术作者方法论和项目写作规范，推进 `docs/openjdk/vol-java/` 正文系统性重写。

---

## 1. 当前总目标

本轮工作的核心目标不是“把源码讲对”，而是：

> **把旧的事实卡片式/源码平铺式文章，重写成删掉代码后仍然成立的技术文章。**

统一写法必须遵守：

- 先有读者困惑，再有源码证据
- 先有失败方案，再有顿悟与设计感
- 先用角色/动机/障碍组织主线，再让代码承担证明作用
- 正文结构必须是：**问题 → 失败方案 → 顿悟 → 机制拆解 → 收网**
- 代码是证据，不是骨架

当前实际工作已经从早期零散试点，推进成了对 `vol-java` 多个域的连续 BIN 化重写。

---

## 2. 必读文件

开始任何新工作前，必须先读：

- `docs/openjdk/WRITING-GUIDELINES.md`
- `docs/HANDOFF-BIN-ARTICLE-REWRITE.md`
- 本文：`docs/HANDOFF-BIN-ARTICLE-REWRITE-2026-08-19.md`

其中：

### 2.1 `docs/openjdk/WRITING-GUIDELINES.md`

这是最高写作标准，必须服从。重点规则：

- 三步分离：素材提取 → 理解路径设计 → 叙事写作
- 主语必须是角色，不是变量
- 每个机制必须完整回答四个问题：
  1. 谁在什么场景下触发它？
  2. 它一步一步做了什么？
  3. 如果它缺席或失败，会发生什么？
  4. 设计者为什么不选更简单的办法？
- 构造与运行时必须分离
- 禁止前向引用式写法
- 正文必须有失败方案推演
- 代码块只能作为证据，不得成为文章骨架

### 2.2 `docs/HANDOFF-BIN-ARTICLE-REWRITE.md`

这是早期交接文档，记录了这轮工作最初的目标、方法论转向和质量标准。虽然进度已经大幅更新，但里面关于“旧稿不能等于成稿”的判断仍然有效。

---

## 3. 统一工作方法

### 3.1 每篇必须先建 `.rewrite-plan.md`

计划文件命名：

- `<article>.rewrite-plan.md`

计划文件必须至少包含：

- 读者困惑
- 一句话顿悟
- 旧稿优点与问题
- 理解路径
- 失败方案清单
- 误解清单
- 证据清单（真实 `file:line`）
- 版本与边界
- 删除代码测试与最终验收标准

### 3.2 正文重写时的统一主线要求

正文必须做到：

- 先建立真实问题或读者困惑
- 明确“为什么直觉办法不够”
- 源码证据必须回扣主线，而不是平铺
- 收尾必须把全文压回一个统一结论
- 必须有自然的下一篇衔接

### 3.3 当旧稿已相当接近成稿时的策略

不是所有文章都要推倒重写。

如果旧稿已经接近 BIN 成稿标准，可采用：

- 补齐 `.rewrite-plan.md`
- 改强开头的问题驱动
- 改强收网与边界
- 做禁用词/占位锚点检查
- 仅做“轻量收束”，避免无意义重写

这个策略已经在若干篇上验证可行。

---

## 4. 检查规则

### 4.1 必做禁用词检查

在目标域目录下检查：

```bash
rg -n '后面会讲|展开\)|第 [2-9] 篇|域 \d+ 展开|此处不再赘述|不再展开|类似地|同理|依此类推|篇幅所限|显然|容易看出|细节读者自行阅读' <article>.md
```

必须为 0 命中。

### 4.2 必做占位锚点检查

在目标域目录下检查：

```bash
rg --pcre2 -n '\([^)]*\.java:(?!\d)' <article>.md
rg -n '\(\d{3,4} 行\)' <article>.md
```

必须为 0 命中。

### 4.3 常用 diff 检查

```bash
git diff -- docs/openjdk/vol-java/<domain>/<article>.md docs/openjdk/vol-java/<domain>/<article>.rewrite-plan.md
```

### 4.4 质量自查

必须确认：

- 删除代码块后，主线仍成立
- 小标题能还原“问题 → 失败 → 顿悟 → 机制 → 收网”
- 写清 JDK 11 版本边界
- 写清至少 3 个误解 / 失败方案
- 没有只靠代码堆出正文结构

---

## 5. 当前真实进度概览

下面是**截至 2026-08-19** 已形成“正文 + rewrite-plan”闭环、并且已按统一 BIN 方法论重写/收束过的域。

### 5.1 已完成闭环的域

#### `10-concurrent-collections`

已闭环：6 篇正文 + 6 篇 plan

- `01-chm-storage-rw.md`
- `02-resize-count.md`
- `03-skiplist.md`
- `04-copyonwrite-concurrentqueue.md`
- `05-blocking-queues.md`
- `06-transfer-selection.md`

#### `11-thread-threadlocal`

已闭环：3 篇正文 + 3 篇 plan

- `01-thread-lifecycle.md`
- `02-threadlocal.md`
- `03-exception-random.md`

#### `12-lock-sync`

已闭环：5 篇正文 + 5 篇 plan

- `01-aqs-core.md`
- `02-await-wakeup.md`
- `03-reentrantlock-condition.md`
- `04-shared-tools.md`
- `05-stamped-readwrite.md`

#### `13-atomic`

已闭环：3 篇正文 + 3 篇 plan

- `01-atomicinteger-cas.md`
- `02-striped64-longadder.md`
- `03-reference-updater.md`

#### `14-threadpool`

已闭环：5 篇正文 + 5 篇 plan

- `01-ctl-worker.md`
- `02-execute-worker.md`
- `03-shutdown-reject.md`
- `04-futuretask-scheduled.md`
- `05-executors-selection.md`

#### `15-async`

已闭环：4 篇正文 + 4 篇 plan

- `01-cf-basics.md`
- `02-compose-exception.md`
- `03-forkjoinpool.md`
- `04-forkjointask.md`

#### `16-stream`

已闭环：6 篇正文 + 6 篇 plan

- `01-stream-api-lambda.md`
- `02-pipeline-lazy.md`
- `03-intermediate-ops.md`
- `04-terminal-eval.md`
- `05-collectors.md`
- `06-spliterator-parallel.md`

#### `17-io-streams`

已闭环：3 篇正文 + 3 篇 plan

- `01-byte-streams.md`
- `02-reader-writer.md`
- `03-file-filesystem.md`

#### `18-serialization`

已闭环：3 篇正文 + 3 篇 plan

- `01-protocol-flow.md`
- `02-serialversion-custom.md`
- `03-security-filter.md`

#### `19-buffer-channel`

已闭环/轻量收束完成：3 篇正文 + 3 篇 plan

- `01-buffer-state-machine.md`
- `02-bytebuffer-family.md`
- `03-filechannel-mmap.md`

#### `21-selector-nio`

已闭环：3 篇正文 + 3 篇 plan

- `01-selector-mechanism.md`
- `02-epoll-platform.md`
- `03-socketchannel-blocking.md`

#### `24-time-date`

已闭环：6 篇正文 + 6 篇 plan

- `01-core-value-types.md`
- `02-duration-period.md`
- `03-zone-rules.md`
- `04-formatter-parse.md`
- `05-zoned-offset.md`
- `06-clock-best-practice.md`

#### `25-agent-diagnostic`

已闭环：3 篇正文 + 3 篇 plan

- `01-attach-mechanism.md`
- `02-instrumentation.md`
- `03-diagnostic-tools.md`

#### `32-unsafe`

已闭环：3 篇正文 + 3 篇 plan

- `01-unsafe-overview.md`
- `02-offheap-directbuffer.md`
- `03-cas-park.md`

#### `34-jmx`

已闭环：6 篇正文 + 6 篇 plan

- `01-jmx-architecture.md`
- `02-objectname-register.md`
- `03-mbean-types-mxbean.md`
- `04-notification.md`
- `05-remote-tools.md`
- `06-production-practice.md`

### 5.2 正在推进中的域

#### `39-jfr`

当前已完成前 5 篇中的 5 篇？注意：**已完成前 5 篇中的前 5 篇到第 5 篇，尚未做第 6 篇。**

已完成：

- `01-jfr-overview-event-model.md`
- `01-jfr-overview-event-model.rewrite-plan.md`
- `02-custom-event-annotation.md`
- `02-custom-event-annotation.rewrite-plan.md`
- `03-bytecode-instrumentation.md`
- `03-bytecode-instrumentation.rewrite-plan.md`
- `04-recording-config.md`
- `04-recording-config.rewrite-plan.md`
- `05-consumer-api.md`
- `05-consumer-api.rewrite-plan.md`

当前自然下一步：

- `docs/openjdk/vol-java/39-jfr/06-production-practice.md`

这是当前**最直接、最连续、最适合无缝接手**的下一篇。

---

## 6. 当前活动域：`39-jfr`

### 6.1 当前目录

- `docs/openjdk/vol-java/39-jfr`

目录内容：

- `01-jfr-overview-event-model.md`
- `01-jfr-overview-event-model.rewrite-plan.md`
- `02-custom-event-annotation.md`
- `02-custom-event-annotation.rewrite-plan.md`
- `03-bytecode-instrumentation.md`
- `03-bytecode-instrumentation.rewrite-plan.md`
- `04-recording-config.md`
- `04-recording-config.rewrite-plan.md`
- `05-consumer-api.md`
- `05-consumer-api.rewrite-plan.md`
- `06-production-practice.md`

### 6.2 当前统一风格主线

这一域已经逐步建立出非常一致的写法：

- `01`：JFR 不是另一种 dump 工具，而是低开销持续事件流
- `02`：自定义事件不是 POJO，而是事件 Schema 声明
- `03`：事件类不是天然有行为，而是运行时字节码注入把协议编译成专用路径
- `04`：录制控制的核心是“会话 + 模板 + 事件级规则”，不是文件开关
- `05`：`.jfr` 的价值是可流式、可结构化、可程序消费的自描述历史

因此 `06` 应该自然收束到：

> **JFR 真正的生产价值，不在于“出了问题再临时开录制”，而在于怎样把 default/profile、短时定位、持续背景录制、脚本消费和事故复盘组合成一套低干扰生产观测闭环。**

---

## 7. 当前下一步的具体建议

### 7.1 直接目标

下一位 AI 应直接继续：

- 读取：`docs/openjdk/vol-java/39-jfr/06-production-practice.md`
- 建立：`docs/openjdk/vol-java/39-jfr/06-production-practice.rewrite-plan.md`
- 按当前域已建立的 BIN 风格重写正文

### 7.2 建议重点主线

建议把 `06-production-practice.md` 的主线组织成：

1. **为什么 JFR 不是“重型事故时才开的工具”，而是可做低干扰常驻背景录制**
2. **default/profile 是成本预算选择，不是“简单/高级”二分**
3. **JFR 最适合的生产闭环：背景录制 → 告警触发 → 保留窗口 → 事故后导出复盘**
4. **什么时候用 JFR，什么时候仍该先用 jstack/jmap/jcmd/JMX**
5. **JFR 的成本边界：录制窗口、事件集、阈值、栈采集、磁盘保留**
6. **如何把 JFR 接入自动化诊断，而不是人工单机分析**

### 7.3 推荐证据方向

下一篇大概率要核的源码/API点：

- `jdk.jfr.Recording`
- `jdk.jfr.Configuration`
- `jdk.jfr.consumer.RecordingFile`
- `jdk.jfr.internal.tool.Main`
- `jcmd JFR.start/JFR.dump/JFR.stop` 对应命令侧线索（如果源码树有足够公开锚点则用；没有就用稳定 CLI/API 说明，但要明确边界）

---

## 8. 写作时的禁区与注意事项

### 8.1 禁区

- 不要把正文重新写回“工具列表/类列表/方法列表”卡片结构
- 不要把“代码事实正确”误当成“已经是成稿”
- 不要在正文里出现前向引用依赖式表述
- 不要为了“像教科书完整”而把后续篇内容塞回当前篇
- 不要主动回退、清理或覆盖其他已有改动

### 8.2 特别注意

- `grep` 工具多文件 include 经常不稳，必要时拆成单文件 grep
- 某些模块源码在当前裁剪树里不完整，若要引用稳定 API 结构，可：
  - 先明确说明“源码树已裁剪”
  - 再用已抓到的公开接口锚点 + 稳定 API 结论
  - 但不要伪造具体不存在的行号
- 当前工作方式已经验证：
  - **轻量收束**适合接近成稿的旧稿
  - **完整重写**适合卡片味重、主线弱的旧稿

---

## 9. 当前工作区情况

当前 `git diff --stat` 显示有大量 `docs/openjdk/vol-java/` 改动，覆盖多个域。这些改动就是这轮 BIN 化重写成果的一部分。

注意：

- 仓库当前不是干净工作区
- 绝对不要用破坏性命令清理未提交改动
- 只在明确用户要求时才考虑提交
- 如需提交，必须只暂存本次实际修改文件

---

## 10. 对下一位 AI 的一句话交接

如果你只记住一句话，就记住这一句：

> **当前最自然的接手点是 `39-jfr/06-production-practice.md`；延续前 5 篇已经建立好的统一 BIN 风格，把 JFR 从“事件模型与技术机制”收束到“生产闭环与成本预算”上。**
