# RunLoop 与 Durable Execution：Reasonix 如何把 Agent 变成长跑任务系统

> 项目：Reasonix（main-v2 基线）
> 角色：主线机制正文 03
> 对应范围规划：`01-Reasonix源码学习范围规划.md`
> 依据材料：
> - `Agent/analysis/reasonix/00-域发现/00-reasonix-域发现.md`
> - `Agent/analysis/reasonix/00-域发现/00-reasonix-域发现-v7补充.md`
> - `Agent/analysis/reasonix/01-闭环笔记/pass2-rq6-coordinator.md`
> - `Agent/analysis/reasonix/01-闭环笔记/pass2-rq7-checkpoint.md`
> - `Agent/analysis/reasonix/01-闭环笔记/pass2-rq9-completion.md`

---

## 零、阅读前提示

- 建议先读：
  1. `01-Reasonix源码学习范围规划.md`
  2. `02-Controller：Reasonix 为什么要把 Agent 做成单控制器系统.md`
  3. `03-Coordinator与PlanContract：Reasonix 如何让规划不再只是 prose.md`
- 推荐源码阅读路径：
  1. `internal/agent/run_loop.go`
  2. `internal/control/turn_orchestrator.go`
  3. `internal/checkpoint/`
  4. `internal/goaleval/`
  5. `internal/jobs/jobs.go`

## 一、这一章真正的问题

如果 Controller 解决的是：
- 谁是统一控制面

Coordinator 解决的是：
- 规划和执行如何被契约化

那么这一章真正要回答的是：

> **Reasonix 到底靠什么把 Agent 从“会说会调工具”变成“能持续推进、能检查自己、能恢复状态的长跑任务系统”。**

换句话说，这一章不是在讲“loop 怎么写”，而是在讲：

1. 一轮 turn 是怎么被组织和收尾的？
2. 为什么它可以在故障、中断、信息残缺的情况下继续推进？
3. 为什么 checkpoint / evaluator / jobs / completion 这些看似分散的东西，其实都属于 durable execution 语义的一部分？

---

## 二、先给结论：Reasonix 的运行循环不是聊天循环，而是“被控制面、评估器、检查点和后台任务共同约束的执行系统”

最容易学错的一点是：
- 看到 `run_loop.go`
- 就以为这是一个“模型回一轮、工具调一下、再来一轮”的普通循环

这会把 Reasonix 看浅。

更准确的理解应该是：

> **RunLoop 在 Reasonix 里不是单独存在的，它是 Controller、TurnOrchestrator、Checkpoint、GoalEval、Jobs 等组件共同维持的一条持续执行主线。**

也就是说：
- loop 不是核心全部
- 但它是这些控制语义真正汇合的地方

所以这里最重要的不是“代码里怎么 while”，而是：
> **系统到底怎样让一轮执行既能推进，又能被中止、评估、恢复和继续。**

---

## 三、为什么 RunLoop 必须被看成 durable execution 骨架

根据既有域发现，Reasonix 的 `internal/agent/run_loop.go` 有几个值得先抓住的特征：

### 1. 它不是只负责调用 provider
它还要处理：
- streamed turn
- 工具协作
- 缺失推理 / 畸形完成的恢复
- 不立即重复工具执行
- turn 的完整结束语义

### 2. 它不是单独决策系统
很多关键决策在别的组件里：
- Controller 决定命令面和生命周期
- Coordinator 决定 planner/executor 路由
- GoalEval 决定完成判定
- Checkpoint 决定恢复边界

这说明 RunLoop 在系统里的正确定位不是：
- “唯一核心”

而是：
- **执行骨架的承重梁**

### 3. 它天然带 durable execution 味道
因为它不是只想“把这一轮跑完”，而是要保证：
- 中途失败后还有恢复语义
- 任务未完成时有下一步要求
- 运行过程中的状态能进入 checkpoint / completion / note / event sink

所以读这一章时，应该始终把它看成：
> **长跑任务系统的执行骨架**
而不是对话循环。

---

## 四、TurnOrchestrator 为什么必须和 RunLoop 一起理解

既有域发现里一个非常重要的补充是：
- `internal/control/turn_orchestrator.go`

这说明在 Reasonix 里，turn 不是裸跑，而是：
- 在控制面协调下被组织起来的

这特别关键，因为它提示你：

> **RunLoop 负责推进执行，TurnOrchestrator 负责把一轮执行嵌入到更大的控制语义里。**

也就是说：
- `run loop` = 执行骨架
- `turn orchestrator` = 会话控制与前台回合组织

两者加起来，才构成真正的 durable session turn。

如果只看 RunLoop，不看 orchestrator，你会误以为：
- controller 只是入口
- loop 自己就能解释全部行为

这在 Reasonix 里是不对的。

---

## 五、为什么“缺失推理恢复”是一个很强的信号

`run_loop.go` 最值得重视的提示之一是：
- 它显式处理缺失推理 / 畸形完成的恢复路径
- 首个畸形完成不会先提交
- 失败时回退完整首响应，不重跑工具

这非常值钱，因为它说明：

> **Reasonix 已经在处理“模型输出不符合预期”时，执行系统怎么维持一致性。**

很多项目在这里会偷懒：
- 输出坏了就重试
- 或者直接崩

Reasonix 更成熟的地方在于：
- 它意识到工具调用、副作用、历史状态可能已经部分发生
- 所以恢复策略必须保守
- 不能简单地“再来一次”

这其实是 durable execution 系统很典型的成熟信号。

---

## 六、为什么 GoalEval 要被看作执行骨架的一部分

在很多系统里，完成判定被当成：
- 最后的检查器
- 或者收尾报告器

但在 Reasonix 里，之前我们已经看到：
- evaluator 为 nil 时 fail-closed
- 没有评估器，目标循环不能继续

这意味着：

> **GoalEval 不是 loop 之外的装饰件，而是 loop 能否自主继续运行的许可条件。**

换句话说：
- loop 负责推进
- evaluator 负责决定这次推进之后，是继续、暂停、还是完成

这说明 Reasonix 的 durable execution 不是：
- “先让模型一直跑，最后看看是否完成”

而是：
- “每一轮执行之后，是否允许继续推进，都必须再经过判断层”

这是一种非常强的控制哲学。

---

## 七、Checkpoint 为什么不是保存状态，而是运行协议的一部分

这一节必须和前后主线绑在一起看：
- 前面 Controller 决定什么是一次真实操作与状态推进
- Coordinator / PlanContract 决定这次推进的目标、边界和可接受结果
- RunLoop 决定当前 turn 到底推进到了哪里
- Checkpoint 则决定：**哪一刻的推进结果已经足够稳定，可以被当成恢复边界**

Checkpoint 在 Reasonix 里也不能被理解成：
- 定时存一下状态
- 崩了可以继续

那样太浅了。

更准确的理解是：

> **Checkpoint 定义了哪一刻的系统状态足够稳定，足以成为后续恢复和继续执行的可信边界。**

这意味着它在回答：
- 哪些中间状态不能被当恢复点？
- 哪些外部副作用必须已经收束？
- 哪些上下文 / turn / message / artifact 应进入恢复面？

所以 checkpoint 在 Reasonix 里不是“为了方便”，而是：
> **为了 durable execution 的边界完整性。**

---

## 八、为什么 jobs 也应该被纳入这一章理解

这部分之所以值得单独强调，是因为它证明了一件事：

> Reasonix 不是把 turn 当作唯一的执行单位，而是把 session 当作更高一级的持续任务容器。

如果 jobs 只是普通后台 goroutine，那它根本不值得进入主线；
它之所以值得进主线，恰恰是因为它改变了我们对“执行单位”的理解：
- turn 只是前台推进单元
- session 才是持续任务的真正容器

`internal/jobs/jobs.go` 被既有域发现提成了：
- session 级后台任务注册表
- 生命周期 = session，而不是 turn
- 可跨 turn 持续
- 完成摘要会注入下一轮

这件事非常重要。

它说明一个成熟 Agent 运行系统，不能只理解：
- 当前 turn 在干嘛

还必须理解：
- 有些工作跨 turn 存活
- session 是更高一级的生命周期容器

也就是说，RunLoop 不是孤立于 session 的。
它要和：
- jobs
- checkpoint
- completion
- recovery
一起看。

这样你才会意识到：
> **Reasonix 的 durable execution，不只是多轮聊天，而是 session 级持续任务系统。**

---

## 九、这一章真正解决了哪些工程问题？

### 1. 如何让 Agent 从对话程序变成长跑任务系统
Reasonix 的解法：RunLoop + TurnOrchestrator + session 级 jobs

### 2. 如何在模型输出残缺、推理缺失或执行异常时继续保持一致性
Reasonix 的解法：显式恢复路径、保守回退、不盲目重跑工具

### 3. 如何让自主运行有真正的停止和继续语义
Reasonix 的解法：GoalEval 进入主执行协议，且 nil 时 fail-closed

### 4. 如何让 checkpoint 成为真实恢复边界，而不是随手存档
Reasonix 的解法：checkpoint 作为稳定状态边界的一部分

### 5. 如何让跨 turn 的后台任务也进入系统执行模型
Reasonix 的解法：session 级 jobs + 完成摘要注入下一轮

所以这一章最值得学的不是“loop 怎么写”，而是：

> **Reasonix 如何把执行、评估、恢复和后台任务编织成一个真正会持续运行的任务系统。**

---

## 十、读者最容易学错的地方

### 错觉 1：RunLoop 就是另一个 Agent while 循环
错。它是 durable execution 骨架的一部分，而不是全部。

### 错觉 2：TurnOrchestrator 只是包装层
错。它在定义前台回合怎样嵌入更大的控制语义。

### 错觉 3：GoalEval 只是收尾验证器
错。它决定 loop 能不能继续跑。

### 错觉 4：Checkpoint 只是保存状态
错。它在定义恢复边界，而不是为了“崩了还能接着来”的便利功能。

### 错觉 5：缺失推理恢复只是 retry 细节
错。它体现的是：Reasonix 不会因为模型输出畸形就轻率重跑，尤其不会在副作用可能已经发生后随便重试工具。

### 错觉 6：jobs 只是后台附加任务
错。它们说明 Reasonix 的生命周期是 session 级，不是单回合级；后台任务完成摘要会反向影响下一轮执行判断。

---

## 十一、分析边界

### 为什么这里不先展开 Memory / History
因为这一章先回答“系统怎样持续推进与恢复”，而不是“历史如何被检索和组织”。

### 为什么这里不先展开 PlanContract 细节
因为上一章已经解决规划契约，这章重点是契约如何进入执行骨架并被持续执行。

### 为什么测试和行为注释是关键证据
因为 streamed turn、异常恢复、工具不重跑、jobs 跨 turn 持续这些语义，很难只靠函数签名看出来。

---

## 十二、关键源码位置

- `internal/agent/run_loop.go`
  - streamed turn、provider 响应收集、异常恢复和工具继续语义
- `internal/control/turn_orchestrator.go`
  - 前台回合如何被 Controller 组织
- `internal/checkpoint/`
  - checkpoint 状态、原子写入和恢复边界
- `internal/recovery/`
  - 崩溃/中断后的恢复流程
- `internal/goaleval/`
  - 独立目标完成评估器
- `internal/jobs/jobs.go`
  - session 级后台任务生命周期与完成摘要
- `internal/trajectory/`
  - 运行轨迹记录

## 十三、主线依赖锚定

这一章前接：
- `Controller`：提供命令面、生命周期和统一事件出口
- `Coordinator / PlanContract`：提供执行任务、边界和验收事实

这一章后接：
- `ContextManager`：决定下一轮模型看到的上下文
- `Checkpoint / Recovery`：把执行中间态固化成恢复边界
- `GoalEval / Completion`：决定这轮之后是否允许继续
- `Memory / History`：承接跨 turn 的状态与摘要

所以 RunLoop 不是孤立的“执行模块”，而是：
> **把控制面命令和任务契约，转化为可持续推进的 durable execution。**

## 十四、工程问题学习点

| 工程问题 | Reasonix 的解法 | 代价 | 可迁移到 |
|----------|----------------|------|----------|
| 如何让 Agent 从对话程序变成长跑任务系统 | RunLoop + TurnOrchestrator + session 级 jobs | 系统更复杂，生命周期管理更重 | 需要长跑的 Agent |
| 如何在模型输出残缺时继续保持一致性 | 显式恢复路径、保守回退、不盲目重跑工具 | 恢复逻辑更保守 | 有副作用的系统 |
| 如何让自主运行有真正的停止和继续语义 | GoalEval 进入主执行协议，nil 时 fail-closed | 系统更保守，可能暂停更多 | 无人值守 Agent |
| 如何让 checkpoint 成为真实恢复边界 | checkpoint 作为稳定状态边界的一部分 | 检查点更重 | 需要可靠恢复的系统 |
| 如何让跨 turn 的后台任务也进入系统执行模型 | session 级 jobs + 完成摘要注入下一轮 | 生命周期管理更复杂 | 有后台任务的系统 |

## 十五、读者分层路由

### beginner
先抓住：
1. Reasonix 的 loop 不是聊天循环，而是长跑任务骨架
2. evaluator 和 checkpoint 都不是附属功能
3. session 比 turn 更大，是持续运行的容器

### intermediate
重点看：
- run loop
- turn orchestrator
- completion / evaluator
- checkpoint / recovery
- jobs lifecycle

### advanced
重点看：
- streamed turn 的恢复语义
- 工具不重跑的保守设计
- fail-closed evaluator 对自主运行的约束
- session 级持久任务系统的建模方式

---

## 十三、迁移清单

### 可迁移思想 1：执行骨架不只是 loop，还要带 evaluator / checkpoint / jobs
- 可迁移到：任何需要长跑和持续恢复的 Agent 系统
- 前提：系统确实允许多轮、多阶段持续执行，且需要在执行中间态做正式决策
- 不适合直接照搬到：一次性命令型 Agent、短生命周期 patch agent

### 可迁移思想 2：模型异常恢复不能默认重跑工具
- 可迁移到：任何工具有副作用的 Agent
- 前提：副作用不可随意重复，且系统要把“保守恢复”放在“多试一次”之前
- 不适合直接照搬到：纯只读分析器或无副作用工具系统

### 可迁移思想 3：evaluator 是继续执行的许可条件
- 可迁移到：无人值守 Agent / autoloop 系统
- 前提：系统真的会自己一直跑，并且不能接受模型自己宣布完成
- 不适合直接照搬到：纯人工逐轮确认、每步都由用户审批的系统

### 可迁移思想 4：jobs 的生命周期高于 turn
- 可迁移到：存在后台任务、异步子任务、延迟完成任务的 Agent 系统
- 前提：需要 session 级任务容器，并允许“这轮没结束、后台还在跑”的语义存在
- 不适合直接照搬到：没有后台任务、没有延迟完成语义的极简系统

---

## 十四、自测问题

1. 为什么 Reasonix 的 RunLoop 不能被理解成普通 while 循环？
2. 为什么 GoalEval 是 durable execution 的主协议成员，而不是后处理器？
3. 为什么工具在恢复路径里不能简单重跑？
4. 为什么 checkpoint 不是附加功能，而是恢复边界定义？
5. 为什么 jobs 的 session 级生命周期值得被纳入主线理解？

---

## 十五、读完这一章，读者应该获得什么能力？

至少应该能做到：

1. 解释为什么 Reasonix 更像长跑任务系统，而不是对话程序。
2. 说清 RunLoop、TurnOrchestrator、GoalEval、Checkpoint、Jobs 分别在 durable execution 里扮演什么角色。
3. 理解为什么模型异常时不能简单重试或重跑工具。
4. 理解为什么 evaluator 与 checkpoint 必须进入主执行语义。
5. 用自己的话说明：Reasonix 是如何让 Agent 执行具备持续推进、恢复、继续和停止的工程边界的。

如果还做不到这些，就说明这章还没真正学懂。
