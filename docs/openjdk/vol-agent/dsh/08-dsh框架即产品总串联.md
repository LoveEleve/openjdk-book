# dsh 框架即产品总串联

> 覆盖范围：
> 1. Cordis 插件运行时
> 2. ReactLoopAgent / AgentLoop
> 3. Session 事件源 / Surface 投影
> 4. Tools 五事件管线
> 5. 双后端持久化 / Projection
> 6. Capability Seams
> 7. Profile / Bundle 装配
> 8. 共享执行世界

---

## 一、这一卷最后到底串出了什么？

如果只看单篇标题，dsh 像是在讲很多互相分散的模块：
- Cordis
- AgentLoop
- Session
- Tools
- Projection
- Capability Seams
- Bundle
- Sandbox

但把它们真正串起来，dsh 最终讲清楚的是：

> **dsh 如何把 Agent 做成“框架即产品”的系统：运行时、会话、工具、持久化、能力边界和产品装配都不依赖特权核心，而依赖插件、事件源和能力缝协同成立。**

---

## 二、dsh 的完整主线

```text
Cordis 插件运行时
  ↓
ReactLoopAgent 事件驱动执行骨架
  ↓
Session 事件源（模型可见即已记录）
  ↓
Surface / Projection 把事件投影成模型与用户可见视图
  ↓
Tools 五事件管线把工具变成协议
  ↓
Capability Seams 把能力定义和实现拆开
  ↓
Profile / Bundle 把插件运行时装配成具体产品
  ↓
共享执行世界把副作用能力收进同一环境边界
```

这条线说明：
- dsh 的核心不是某个 loop
- 不是某个 session 文件
- 也不是某个工具系统

而是：
> **一套可以持续装配、替换、投影和持久化的插件化 Agent 框架。**

---

## 三、最值得记住的 6 个系统判断

## 1. 框架本身就是产品

dsh 不先造一个大核心，再给它挂扩展；
它一开始就假定：
- 产品形态 = 插件组合
- 运行时行为 = provider 组合

所以框架和产品之间几乎没有硬边界。

## 2. 事件源是模型视图的真相层

Session 不是后台日志，
而是：
- 模型可见历史
- 持久化历史
- 插件可消费历史

共同依赖的真相层。

## 3. 工具调用是协议，不是函数

只有当工具也进入事件管线、守卫、日志和结果投影之后，
dsh 的插件化能力才不会把副作用边界弄散。

## 4. Projection 和持久化都只是事件源的派生层

JSONL、SQLite、projection snapshot 都不是最终真相；
它们只是围绕 Session 事件源建立的 durable 或派生视图。

## 5. 能力缝把“框架能力”和“产品能力”彻底拆开

definition/provider/consumer 三角色，让同一 consumer 代码可以跑在完全不同的 provider 组合上。

## 6. 共享执行世界保证副作用能力看到同一个现实

fs、shell、subprocess、sandbox 不共享世界的话，
整个“框架即产品”会在副作用层面破功。

---

## 四、一句话结论

dsh 最有价值的地方，不是“插件很多”，而是：

> **它给出了一个 Agent 框架的完整工程答案：如何让运行时、会话、工具、持久化、能力边界和产品装配全部插件化，同时仍然保持同一个真相层和同一个执行世界。**
