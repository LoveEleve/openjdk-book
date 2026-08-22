# Hermes 横向对比锚点

> 用途：从 Hermes 第一卷中抽出后续对比 dsh 时可直接复用的比较维度。

---

## 一、Hermes 整体画像

一句话定义：

> **Hermes 是把同一个 Agent 内核长期运行在多平台、多任务、多账本、多审查约束下的代理系统。**

---

## 二、最核心的 10 个对比锚点

## H-A1 执行骨架
- Hermes 的做法：AIAgent 主循环 + GatewayRunner + TurnRunner
- 对比问题：其他项目有没有多平台运行控制层？

## H-A2 上下文工程
- Hermes 的做法：Prompt Cache 神圣 + 本地/服务端双压缩 + 微压缩
- 对比问题：其他项目如何对待缓存前缀？

## H-A3 完成判定
- Hermes 的做法：GoalGate + GoalJudge + 守卫族
- 对比问题：其他项目有独立审查器吗？

## H-A4 知识系统
- Hermes 的做法：双态记忆 + 技能生命周期 + curator + background review
- 对比问题：其他项目只存不治理吗？

## H-A5 交付与生命周期
- Hermes 的做法：DeliveryLedger + LifecycleLedger + 哨兵
- 对比问题：其他项目能把“结果有没有送达”说清楚吗？

## H-A6 边界控制
- Hermes 的做法：authz_mixin + SecretScope + SelfRepoGuard
- 对比问题：其他项目如何隔离凭证？

## H-A7 验证系统
- Hermes 的做法：Recipe 检测 + 证据账本 + GoalJudge
- 对比问题：其他项目怎么做验收？

## H-A8 失败语义
- Hermes 的做法：分类学 23 类 + fail-open 有界
- 对比问题：其他项目如何区分失败类型？

## H-A9 学习闭环
- Hermes 的做法：background review + curator + learning graph
- 对比问题：其他项目有没有强制知识沉淀通道？

## H-A10 可解释性
- Hermes 的做法：账本 + 哨兵 + 心跳采样
- 对比问题：其他项目崩溃后还能解释吗？

---

## 三、一句话结论

如果只用一句话概括 Hermes：

> **它代表了多平台长期代理系统的工程化版本——不是最轻的，也不一定最灵活，但它把验证、账本、守卫、学习治理、缓存约束和边界控制都做成了系统。**