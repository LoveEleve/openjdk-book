# AgentLoop：dsh 如何用 Cordis 插件框架组织 Agent 执行

> 项目：dsh（dsh-root v0.1.0-rc.5）
> 角色：主线机制正文 01
> 对应范围规划：`01-dsh源码学习范围规划.md`
> 依据材料：`Agent/analysis/deepseek-harness/01-闭环笔记/q2-agent-loop.md`

---

## 零、阅读前提示

- 如果你对 Agent loop / turn / step / tool call 这些概念完全没感觉，先读：`../03-Agent源码前置认知桥.md`
- 如果你还没看 dsh 范围规划，先读：`01-dsh源码学习范围规划.md`
- 推荐源码阅读路径：
  1. `packages/core/agent-loop/src/agent.ts`
  2. `packages/core/agent-loop/src/dispatch.ts`
  3. `packages/core/agent/src/index.ts`
  4. `packages/core/agent-loop/tests/loop.spec.ts`
  5. `docs/architecture.md`

## 一、这一章真正的问题

dsh 和其他 4 个项目有一个本质差异：

> **它不是“一个会调模型的 Agent”，而是一个基于 Cordis 插件的 Agent 框架。**

所以它的 AgentLoop 不是在“跑一个循环”，而是在“由插件驱动的 Agent 运行时”。

这一章真正要回答的是：

1. dsh 的 AgentLoop 和 OpenCode / Reasonix / Pi / Hermes 有什么本质不同？
2. 为什么融合分派三模式是 Cordis 插件思想在 Agent 层的体现？
3. Phase 状态机如何工作？
4. 为什么 turn/step 双层在这里比其他项目更接近“事件驱动”？

---

## 二、先给结论：dsh 的 AgentLoop 不是“一个循环”，而是“一个由 Phase 状态机驱动的、基于 Cordis 事件的 Agent 运行时”

最容易犯的错，是把 dsh 的 AgentLoop 理解成和其他项目一样的“while 循环”。

这不对。

dsh 的 AgentLoop 不是一个单体循环，而是一个：
- 由 Phase 状态机驱动
- 基于 Cordis 事件分派
- 融合 emit/serial/waterfall 三模式
- 通过 InboxTarget 双队列接收输入

的 **Agent 运行时框架**。

---

## 三、为什么融合分派三模式是 dsh 的核心设计

dsh 的 `dispatch.ts` 定义了三种分派模式，这不是巧合，而是 Cordis 插件思想在 Agent 层的自然延伸。

### emit
- fire-and-forget
- 非 veto
- 同步 throw 和 promise rejection 各自隔离

### serial
- 有序等待
- 适合有顺序依赖的监听器

### waterfall
- 中间件链
- 参数以 `next` 结尾
- 必须调用 `next()` 委托
- 短路即设计

在 AgentLoop 里，这些分派模式直接对应了不同的扩展点语义：
- `agent/request` 是 waterfall（可以拦截、修改请求）
- `tools/*` 是 waterfall（可以拦截、修改工具调用）
- 某些事件是 emit（fire-and-forget，不阻塞主循环）

这说明 dsh 的 AgentLoop 不是“一个循环里塞满 if/else”，而是：
> **一个由事件分派驱动的、可插拔的 Agent 运行时。**

---

## 四、为什么 Turn/Step 双层在这里比其他项目更接近“事件驱动”

dsh 的 turn/step 双层语义和其他项目类似，但有一个关键差异：

> **它是通过事件瀑布驱动的，而不是通过函数调用链。**

也就是说：
- turn/start 是一个事件
- step/start 是一个事件
- agent/request 是一个事件
- llm/stream 是一个事件
- tools/* 是一个事件

每个事件都可以被插件拦截、修改、或短路。

这意味着 dsh 的 AgentLoop 不是“一个函数”，而是：
> **一组事件瀑布。**

---

## 五、为什么 Phase 状态机是执行控制的核心

dsh 的 `ReactLoopAgent` 定义了三个 Phase：

- idle：等待输入
- maintenance：维护中
- running：运行中（turn / step / abort / wakeRequested）

这个状态机解决的是：

> **agent 当前在做什么？**

- idle 时，wake 总是开新 turn 边界
- running 时，有新输入可以走 next-step 或 next-turn
- abort 时，活动被取消

这说明 dsh 不是把执行状态放在一个局部变量里，而是：
> **把执行状态显式建模成 Phase 状态机。**

---

## 六、为什么 InboxTarget 双队列很重要

dsh 的输入不是直接进入 loop 的，而是通过 InboxTarget：
- next-turn：开新 turn
- next-step：继续当前 step

这解决的是：

> **输入应该在什么边界被处理？**

- 新 turn 输入 → 开新 turn
- 当前 turn 继续输入 → 走 next-step

这和其他 4 个项目的 steer/follow-up 在语义上是等价的，但表达方式更接近“事件驱动”而不是“队列消费”。

---

## 七、这一章真正解决了哪些工程问题？

### 1. 如何让 Agent 循环变成可插拔事件系统
dsh 的解法：融合分派三模式 + 事件瀑布

### 2. 如何让执行状态显式可观察
dsh 的解法：Phase 状态机

### 3. 如何让输入在不同执行边界正确处理
dsh 的解法：InboxTarget 双队列

### 4. 如何让 turn/step 语义通过事件驱动而不是函数调用
dsh 的解法：turn/* / step/* / agent/* 事件瀑布

---

## 八、读者最容易学错的地方

### 错觉 1：dsh 的 AgentLoop 和其他项目一样
错。它是基于 Cordis 事件驱动的，不是单体循环。

### 错觉 2：融合分派只是三种模式
错。它们对应了不同的扩展点语义。

### 错觉 3：Phase 状态机只是状态标签
错。它定义执行控制边界。

### 错觉 4：InboxTarget 只是队列
错。它定义输入应该在哪一层被处理。

---

## 九、读完这一章，读者应该获得什么能力？

至少应该能做到：

1. 解释 dsh 的 AgentLoop 和其他 4 个项目的本质差异。
2. 说清融合分派三模式各自对应什么扩展点语义。
3. 理解 Phase 状态机如何控制执行边界。
4. 理解为什么 dsh 更接近“事件驱动的 Agent 运行时”，而不是“单体循环”。

如果还做不到这些，就说明这章还没真正学懂。