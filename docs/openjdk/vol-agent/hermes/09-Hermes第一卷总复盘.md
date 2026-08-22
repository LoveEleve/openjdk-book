# Hermes 第一卷总复盘

> 覆盖范围：
> 1. AIAgent 主循环
> 2. TurnRunner / GatewayRunner
> 3. ContextCompression
> 4. Memory / Skills / Curator
> 5. Permission / SecretScope / SelfRepoGuard
> 6. DeliveryLedger / LifecycleLedger
> 7. Verification / GoalJudge

---

## 一、这一卷到底在讲什么？

如果只看单篇标题，你会觉得 Hermes 这一卷讲了很多模块：
- loop
- gateway
- compression
- memory
- skills
- permission
- ledger
- verification

但如果把 8 篇真正收回来，这一卷其实只在讲一件事：

> **Hermes 如何把同一个 Agent 内核，长期运行在多平台、多任务、多账本、多审查约束下，并让它变成一个可持续学习、可解释、可恢复的代理系统。**

也就是：Hermes 不是“功能很多”，而是：

```text
AIAgent 主循环
  ↓
网关 / 多会话运行控制
  ↓
上下文压缩 / 缓存边界
  ↓
记忆 / 技能 / 学习闭环
  ↓
边界控制 / 凭证隔离 / 自保护
  ↓
交付与生命周期账本
  ↓
验证 / 完成判定 / 守卫族
```

这正是我们最初给它下的判断：
> Hermes 不是功能最多的 Agent，而是把同一个内核长期运行在多平台、多任务、多账本、多审查约束下的代理系统。

---

## 二、Hermes 最值得记住的 5 个系统判断

## 1. Prompt Cache 是架构约束，不是性能优化

Hermes 从一开始就假设：
- per-conversation prompt caching is sacred

这意味着：
- system prompt 不能随意变化
- 技能注入要进 user 消息而不是 system prompt
- 上下文压缩是唯一允许重写的前提

这直接主导了 Hermes 的上下文工程、技能注入和缓存稳定设计。

---

## 2. 完成判定不能靠模型自己宣布

Hermes 用了一整套系统来解决“什么时候算完成”：
- verify runner
- verification evidence ledger
- GoalGate（门先于判定）
- GoalJudge（独立审查器）
- verification_stop
- kanban_stop

这说明 Hermes 完全不相信“模型自己说完成了就是完成了”。

---

## 3. 学习不是累积知识，而是治理知识

Hermes 的记忆和技能系统不只是“越存越多”，而是：
- 双态记忆（冻结快照 + 活态写入）
- 技能生命周期（active/stale/archived）
- 来源分级
- curator 自动重构
- background review fork

这说明 Hermes 把“防止知识库变成垃圾场”当成学习系统的一部分。

---

## 4. 运行后还能解释发生了什么，是系统资产

Hermes 有：
- DeliveryLedger（响应有没有送达）
- LifecycleLedger（上次进程怎么死的）
- 心跳内存采样
- 不洁死亡检测

这说明它不是只在乎“能不能跑”，还非常在乎：
> 跑完之后，系统还能不能向人解释发生过什么。

---

## 5. 多平台不是外壳，而是形态本身

Hermes 的插件、平台适配器、网关、多会话、多账本，不是“可有可无的外壳”，而是产品形态的一部分。

- TurnRunner / GatewayRunner
- BasePlatformAdapter
- stream_dispatch
- 多平台授权

这些都说明：Hermes 不是在“接几个渠道”，而是在做真正形态上的多平台代理系统。

---

## 三、Hermes 最值得迁移的思想

### 1. 交付语义 durable 化
不假设“生成了就等于送达了”。

### 2. 生命周期哨兵
不假设“进程总是干净退出”。

### 3. 门先于判定
验证通过之后，才允许宣布完成。

### 4. 独立审查器
完成判定和执行器彻底解耦。

### 5. 有界 fail-open
验收场景下，继续比暂停好，但必须有界。

### 6. 技能生命周期治理
知识库不只积累，还要治理。

### 7. 双态记忆
冻结快照进缓存，活态写入保持稳定。

---

## 四、Hermes 和其他项目的关系

| 维度 | OpenCode | Reasonix | Pi | Hermes |
|------|----------|----------|----|--------|
| 核心差异 | 现代 runtime | 受控任务系统 | 共享运行时 | 多平台长期代理 |
| 执行 | SessionRunner | Controller | Agent Loop | AIAgent + GatewayRunner |
| 完成判定 | 无独立 evaluator | Goaleval | — | GoalJudge / 守卫族 |
| 知识 | plugin / skills | subject 冲突 | facts 表 | 学习闭环 + curator |
| 账本 | — | checkpoint | records/lanes | delivery/lifecycle ledger |
| 平台 | 协议外化 | 无强平台 | 多形态共享内核 | 多平台适配器 |

---

## 五、一句话结论

Hermes 第一卷最本质的收获，不是“它有多少功能”，而是：

> **它展示了一个 Agent 系统如何通过验证、账本、守卫、学习治理和平台适配，变成一个能长期、可解释、可持续改进运行的代理系统。**

这就是这 8 篇真正拼出来的东西。