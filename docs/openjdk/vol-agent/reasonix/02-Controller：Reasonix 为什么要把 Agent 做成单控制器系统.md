# Controller：Reasonix 为什么要把 Agent 做成单控制器系统

> 项目：Reasonix（main-v2 基线）
> 角色：主线机制正文 01
> 对应范围规划：`01-Reasonix源码学习范围规划.md`
> 依据材料：`Agent/analysis/reasonix/01-闭环笔记/pass2-rq8-controller.md`

---

## 零、阅读前提示

- 如果你对 Agent loop / tool call / evaluator / checkpoint 这些概念完全没感觉，先读：`../03-Agent源码前置认知桥.md`
- 如果你还没看 `Reasonix` 范围规划，先读：`01-Reasonix源码学习范围规划.md`
- 推荐源码阅读路径：
  1. `internal/control/controller.go`
  2. 与 `Controller` 直接关联的 `recovery / rewind / approval / goal` 路径
  3. `internal/agent/run_loop.go`
  4. `internal/goaleval/`

## 一、这一章真正的问题

大多数人第一次看 Reasonix，很容易把它看成：
- 一个 Go 写的 Agent CLI
- 有几个前端
- 有一个 loop
- 有几个工具和记忆模块

但如果这样理解，你会完全低估它最核心的设计判断：

> **Reasonix 不把 Agent 做成“前端里跑一个循环”，而是把它做成“由单控制器统一驱动的任务系统”。**

所以这一章真正要回答的问题是：

1. 为什么 `Controller` 必须是第一主线？
2. 它为什么不只是命令分发器？
3. 为什么它要持有 guardian、evaluator、budget、memory、permission、subagent gate 这些组件？
4. 为什么说它是“传输无关执行内核 + 命令面 + 事件面”的统一入口？

如果这些问题没回答，后面你再看 RunLoop、PlanContract、Checkpoint、Goaleval，就会把它们误读成散装模块，而不是统一控制面的一部分。

---

## 二、先给结论：Controller 是 Reasonix 的产品级控制面，不是普通调度器

最容易犯的错，是把 `controller.go` 理解成：
- 命令分发
- 调几个子模块
- 给前端返回结果

这远远不够。

更准确的理解是：

> **Controller 是所有前端共享的、负责统一推进会话生命周期、任务控制、权限交互、恢复语义和目标循环的逻辑内核。**

它在系统里的地位不是：
- “某个大文件”

而是：
- TUI / HTTP / desktop 等前端共同依赖的唯一逻辑层
- 各种组件（runner、guardian、memory、evaluator、budget、hooks）的编排层
- Agent 会话从“输入”到“运行”到“评估”再到“恢复”的控制枢纽

所以这章不是“Controller 很大、很多方法”，而是：
> **Reasonix 为什么要先把控制面立起来，再谈执行。**

---

## 三、为什么单控制器是 Reasonix 的第一原则

Reasonix 在这里做了一个非常明确的取舍：

> **前端不拥有执行语义，前端只发命令、渲染事件。**

### 这在解决什么问题？
如果每个前端都各自实现：
- 发送输入
- 取消
- 审批
- 恢复
- 状态轮询
- 目标循环

那么系统很快就会变成：
- HTTP 一套语义
- TUI 一套语义
- desktop 又一套语义

最后：
- 逻辑分叉
- 行为不一致
- 恢复和调试困难

Reasonix 的选择是：
- 所有前端走同一套 Controller 命令面
- 所有前端观察同一套事件面

也就是说：
> **前端只是入口，Controller 才是真正的会话驱动层。**

这也是为什么在我们的方法论里，它必须排第一。

---

## 四、命令面为什么不是简单接口，而是前端契约

Controller 暴露出来的不是一个单一 `run()`，而是一整组提交入口：
- Send
- Submit
- SubmitHTTP
- SubmitDisplay
- SubmitDeliveryRecovery
- SubmitUserTurn
- …

这说明它在做的不是“统一一个函数签名”，而是：

> **把所有前端必须遵守的会话提交语义变成契约。**

例如：
- `display` 和 `input` 分离
- HTTP 会话和普通会话入口不同
- delivery recovery 有单独入口
- 用户回合与普通提交被区分

这里最值钱的一点是：

### display 与 input 分离
这说明 Reasonix 很早就意识到：
- 用户界面显示的文本
- 和真正进入模型 / 执行语义的输入
不是同一件事。

这是一条非常产品级的判断，避免了“渲染逻辑污染执行语义”。

---

## 五、为什么 Controller 要持有这么多组件

如果你只把 Controller 看成命令分发器，你会无法解释为什么它持有：
- runner
- guardian
- evaluator
- taskBudget
- goalTokenBudget
- memoryManager
- policy
- subagentGate
- skills
- hooks
- shell

但如果你把它理解成“控制面内核”，就会发现这些组件都合理：

### 1. runner / executor
负责真正执行会话与 turn。

### 2. guardian / recoveryGate
负责在执行过程中保护系统不跑偏、不越界、不失控。

### 3. evaluator
负责无人值守目标循环的完成判定。

### 4. budgets
负责成本约束和停止条件。

### 5. memoryManager
负责把记忆系统接进会话生命周期。

### 6. policy / permission
负责副作用边界。

### 7. subagentGate / skills
负责能力扩展与子代理协作。

### 8. hooks
负责外部观察 / 扩展上下文。

### 9. shell
负责与系统环境发生可控交互。

所以这些组件不是“堆模块”，而是在共同回答：
> **一个长期运行的 Agent，会话级控制面到底要负哪些责任。**

---

## 六、为什么 goal loop + evaluator fail-closed 是 Reasonix 的灵魂之一

这一点特别值得抬出来讲。

Reasonix 有一条很强的设计判断：

> **如果没有 evaluator，就不能让无人值守目标循环继续跑。**

也就是说：
- evaluator 不存在 → fail closed
- 不会默认“那就先继续”

这太关键了，因为很多 Agent 系统在这里会偷懒：
- 没有严肃判定器
- 也照样继续让模型自我宣布完成或继续

Reasonix 明确拒绝这种做法。

### 这在解决什么问题？
它在解决：
- 自主跑不等于放任模型继续生成
- 没有完成判定器的继续执行，本质上不安全
- 无人值守循环必须有：
  - evaluator
  - token budget
  - usage tee（成本观测）

所以这里最重要的不是“有一个 goaleval 包”，而是：
> **Reasonix 认为 evaluator 是自主运行的准入条件。**

这条设计非常值得学。

---

## 七、为什么单一 event sink 很重要

Reasonix 的另一个关键判断是：
- 所有运行中事件都走统一的 `event.Sink`

这意味着：
- reasoning
- tool call
- approval
- turn completion
- recovery
- 目标循环变化
都进入同一事件出口。

这件事的重要性在于：

1. 前端不各自发明状态流
2. 事件成为统一的观测协议
3. 调试、回放、审计、复盘有统一出口

所以 `event.Sink` 在这里不只是输出手段，
而是在帮助 Reasonix 实现：
> **命令面 / 事件面分离，但全系统只认一条事件流。**

这和前面 OpenCode 的 durable truth / projector，在工程精神上是同源的。

---

## 八、为什么记忆写串行化要“off 主锁”

这个点特别像高手代码里的“真正值钱的小判断”。

Reasonix 明确把 memory 写串行化放在自有锁下，避免卡住：
- 审批
- 状态轮询
- 其他控制面操作

这说明它很清楚：

> **不是所有正确性都应该压在一把大锁上。**

这是一个成熟工程系统会非常在意的问题：
- 你既要状态一致
- 又不能让副操作拖垮主控制面

所以这件事虽然看起来只是锁粒度，但它体现的是：
> **控制面延迟和一致性之间的工程权衡。**

---

## 九、这一章真正解决了哪些工程问题？

### 1. 如何让多个前端共享同一套 Agent 逻辑
Reasonix 的解法：单控制器

### 2. 如何把“提交输入 / 取消 / 恢复 / 审批 / 紧缩 / 新会话”做成统一命令面
Reasonix 的解法：Submit 族 + command surface

### 3. 如何让自主运行不失控
Reasonix 的解法：goal loop + evaluator fail-closed + budget + usage tee

### 4. 如何让运行期的状态变化都进入统一可观测流
Reasonix 的解法：单一 event sink

### 5. 如何让 memory / skills / hooks / shell 这些副系统进入控制面，但不打散主循环
Reasonix 的解法：Controller 持有组件并集中编排

所以 Controller 真正解决的不是“调度模块”，而是：

> **如何给 Agent 系统建立一个统一、可恢复、可观测、可约束的控制中枢。**

---

## 十、读者最容易学错的地方

### 错觉 1：Controller 只是命令分发器
错。它是整个系统的统一控制面。

### 错觉 2：多前端只是多几个适配层
错。Reasonix 的重点恰恰是：前端不拥有执行语义。

### 错觉 3：evaluator 只是收尾验证器
错。它是无人值守继续执行的安全前提。

### 错觉 4：event sink 只是日志出口
错。它是整个系统的统一事件协议面。

### 错觉 5：memory / skills / hooks 只是挂件
错。它们都是控制面必须调度的成员，但不能反客为主。

---

## 十一、关键源码位置

| 文件 | 行数 | 核心职责 |
|------|------|----------|
| `internal/control/controller.go` | 6,276 行 | 项目最大文件：统一控制面、命令面、事件面、组件编排 |
| `internal/control/turn_orchestrator.go` | 654 行 | 前台回合执行、goalContinuationSnapshot |
| `internal/control/recovery.go` | — | Controller 层恢复语义 |
| `internal/agent/runner.go` | — | Runner 接口定义（单/双模型无感） |
| `internal/agent/run_loop.go` | 754 行 | 运行循环、streamedTurn |
| `internal/goaleval/evaluator.go` | 267 行 | 独立目标完成评估器 |
| `internal/boundedllm/bounded.go` | 159 行 | 有界审查器共享基础设施 |
| `internal/jobs/jobs.go` | 2,071 行 | session 级后台任务注册表 |

**阅读顺序建议**：
1. 先读 `controller.go` 的字段定义（89-150 行），建立组件清单直觉
2. 再读 `spawnGuardedTurn` / `finishGuardedTurn`（932-1040），理解守卫回合
3. 再读 `runGoalLoopWithRaw`（1109-1150），理解无人值守目标循环
4. 最后读 `runner.go`，理解 Runner 接口如何统一单/双模型

## 十二、工程问题学习点

| 工程问题 | Reasonix 的解法 | 代价 | 可迁移到 |
|----------|----------------|------|----------|
| 多前端如何共享同一套 Agent 逻辑 | 单控制器 Controller | 前端失去执行语义控制权 | CLI/HTTP/desktop 并存的 Agent |
| 自主运行如何不失控 | goal loop + evaluator fail-closed + budget + usage tee | 系统更复杂，调试成本更高 | 无人值守 Agent |
| 副操作如何不阻塞主控制面 | 记忆写串行化 off 主锁 | 需要额外锁管理 | 复杂 Agent runtime |
| 如何让所有状态变化进入统一观测流 | 单一 event.Sink | 前端不能各自发明事件采集 | 需要统一追踪的系统 |
| 如何让 hooks / skills / shell 等副系统进入控制面 | Controller 持有并集中编排 | 组件间耦合度提高 | 复杂 Agent 系统

## 十三、读者分层路由

### 为什么第一轮不先看 TUI / desktop / HTTP 前端细节
因为当前目标是先理解“唯一逻辑层”如何成立；前端只是入口，不是核心控制面。

### 为什么第一轮不先看 MCP / plugin / extension
因为这些是后段外化/扩展层；如果 Controller / RunLoop / Context / Contract 主线没站稳，后面只会看成一堆接口和 glue code。

### 为什么测试是关键证据
Controller 很多最值钱的语义（并发 resume、goal loop、nil evaluator fail-closed、memory 锁粒度）都要靠测试和整体验证行为才能真正看清楚。

---

## 十二、读者分层路由

### beginner
先抓住：
1. Controller 不是分发器，是统一控制面
2. evaluator 不是附加件，是自主运行的前提
3. event sink 不是日志，而是统一事件协议

### intermediate
重点看：
- Submit 系列命令面
- guardian / evaluator / budget / memory 的角色
- goal loop 和 fail-closed 语义
- 前端如何统一走 Controller

### advanced
重点看：
- transport-agnostic 控制器模式
- 控制面组件的职责边界
- 锁粒度与 memory 写串行化的工程取舍
- 为什么这是 durable execution / task OS 风格，而不是聊天循环风格

---

## 十三、迁移清单

### 可迁移思想 1：单控制器统一所有前端逻辑
- 可迁移到：CLI / HTTP / desktop 并存的 Agent 产品
- 前提：需要统一生命周期、取消、审批、恢复语义
- 不能照搬的点：极简单前端系统可能没必要这么重

### 可迁移思想 2：goal loop 必须 fail-closed
- 可迁移到：任何无人值守 Agent 循环
- 前提：系统真的允许“自己一直跑”
- 不能照搬的点：纯人工每步确认的工具型 Agent 不一定需要这么强

### 可迁移思想 3：display 与 input 分离
- 可迁移到：需要同时服务前端展示和模型输入的系统
- 前提：渲染层和语义层存在差异
- 不能照搬的点：没有多前端 / 没有渲染分层的系统收益较小

### 可迁移思想 4：memory / hooks / shell 等副系统必须由控制面统一编排
- 可迁移到：复杂 Agent runtime
- 前提：系统有多个副系统会影响主循环
- 不能照搬的点：小型实验系统不必一开始就收得这么紧

---

## 十四、自测问题

1. 为什么 Reasonix 必须把 Controller 排在第一主线？
2. 为什么前端不能各自实现回合生命周期？
3. 为什么 evaluator 为 nil 时要 fail-closed？
4. 为什么 event sink 是控制面的一部分，而不只是日志出口？
5. 为什么 memory 写串行化要刻意放到主锁之外？

---

## 十五、读完这一章，读者应该获得什么能力？

至少应该能做到：

1. 解释为什么 Reasonix 的核心不是某个 loop，而是单控制器控制面。
2. 说清命令面 / 事件面为什么必须统一而不能散在前端。
3. 理解 evaluator / budget / usage tee 为什么是自主运行的前提条件。
4. 理解 Controller 为什么要同时持有 runner、memory、skills、permission、hooks、shell 等组件。
5. 用自己的话说明：Reasonix 为什么更像“任务系统 / 控制系统”，而不只是一个会调模型的 CLI。

如果还做不到这些，就说明这章还没真正学懂。
