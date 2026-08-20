# Coordinator 与 PlanContract：Reasonix 如何让规划不再只是 prose

> 项目：Reasonix（main-v2 基线）
> 角色：主线机制正文 02
> 对应范围规划：`01-Reasonix源码学习范围规划.md`
> 依据材料：`Agent/analysis/reasonix/01-闭环笔记/pass2-rq6-coordinator.md`

---

## 零、阅读前提示

- 建议先读：
  1. `01-Reasonix源码学习范围规划.md`
  2. `02-Controller：Reasonix 为什么要把 Agent 做成单控制器系统.md`
  3. `../03-Agent源码前置认知桥.md`
- 推荐源码阅读路径：
  1. `internal/agent/coordinator.go`
  2. `internal/agent/planner_route.go`
  3. `internal/plancontract/`
  4. `internal/taskcontract/`

## 一、这一章真正的问题

如果 Controller 回答的是：
> “谁来统一驱动整个 Agent 系统？”

那么这一章要回答的是：

> **当系统决定需要规划时，规划结果如何被做成可信、可执行、可验证的结构，而不是一段 prose。**

也就是说，这里真正关心的不是“有没有 planner”，而是：

1. 什么时候该走 planner，什么时候不该？
2. planner 失败时，系统该降级还是该 fail-closed？
3. planner 给 executor 的交接，为什么不能只是普通文本？
4. 为什么计划本身要被做成可引用、可验证、可限制写入范围的契约？

---

## 二、先给结论：Reasonix 把规划当成执行控制的一部分，而不是思维附属物

很多 Agent 系统里的 planner，最终给出的东西本质上还是一段比较长的文字：
- 先做什么
- 再做什么
- 然后注意什么

这会导致一个问题：
- 看起来有计划
- 实际上执行器无法稳定检查它
- 更无法据此做写边界、证据引用、失败恢复等控制

Reasonix 的厉害之处就在于：

> **它不满足于“planner 说了什么”，而要把 planner 产物做成真正可执行的契约。**

这就是为什么：
- PlanContract
- planFacts
- acceptanceCriterionIDs
- mutationEscapesPlan
这些东西会集中出现。

它们不是附加功能，而是在回答：
> **计划如何真正进入执行控制面。**

---

## 三、Coordinator 为什么重要：它不是“多一个模型”，而是“多了一层控制语义”

表面上看，Coordinator 像是在做双模型协作：
- planner
- executor

但如果只从“一个模型变两个模型”来理解，就太浅了。

Coordinator 真正引入的变化是：

1. **规划被独立出来**
   - planner 负责研究、整理、交付结构化计划
2. **执行被隔离出来**
   - executor 只负责执行，不负责发明计划
3. **两者之间的 handoff 被显式协议化**
   - 不是“planner 说一句，executor 猜着做”

所以 Coordinator 的价值不是“多模型”，而是：
> **把规划和执行之间的控制边界正式拉出来。**

---

## 四、为什么 planner 约束这么重

Reasonix 对 planner 的约束非常严格：
- 只读工具研究
- 研究有界
- 不允许直接执行副作用
- 要提交 `submit_plan`
- 要区分 `verified_files` 和 `candidate_files`
- 需要用户决策时必须走 `ask`

这说明它在解决一个很实际的问题：

> **如果 planner 既负责想，又负责做，那 planner 就会污染执行器的边界。**

Reasonix 不接受这种混乱。

它要求 planner：
- 研究
- 组织计划
- 交付结构化产物
- 但不自己偷跑执行

这很重要，因为它让 planning 不再只是“模型多想一步”，而是：
> **一种受边界约束的受控研究阶段。**

---

## 五、为什么“什么时候用 planner”必须是确定性路由

很多人会觉得：
- 需不需要 planner，让模型判断就行了

Reasonix 不是这样，它明确做了：
- `executor_only`
- `plan_and_execute`
- `plan_for_approval`
- `plan_only`

还有对应的深度：
- none
- light
- full

这非常关键，因为它说明：

> **是否启用 planner，不应该是模型自己决定的随机行为，而应该是系统策略。**

否则会出现：
- 同样任务这次规划，下次不规划
- 风险任务有时直接执行
- 简单任务有时被过度规划

Reasonix 在这里坚持的是：
> **planner route 是控制策略，不是聊天风格。**

---

## 六、降级语义为什么值钱

Coordinator 另一个很成熟的地方，是它没有把 planner 失败一刀切处理。

它区分：

### 1. `plan_and_execute`
- planner 失败 → 可以降级到 executor 直接执行

### 2. `plan_only` / `plan_for_approval`
- planner 失败 → fail-closed

这背后体现的是一个非常重要的判断：

> **不是所有 planner 故障都值得阻塞任务，但边界性规划故障绝不能自动越权变执行。**

这就是成熟系统和玩具系统的差别。

它没有简单地说：
- 有 planner 就必须 planner 成功
- 失败就全挂

也没有简单地说：
- planner 坏了就一律继续

而是按执行语义区分：
- 普通任务可降级
- 涉及审批 / 边界 / 只规划不执行的任务必须 fail-closed

这条思想特别值得迁移。

---

## 七、为什么 `SetPlanContract` 比 prose handoff 更关键

Coordinator 最值钱的一点之一，就是：
- planner 交给 executor 的不是一段普通 handoff prose
- 而是结构化的 `PlanContract`

这意味着：
- executor 不只是“读懂一段说明”
- 而是拿到：
  - 目标
  - 风险
  - 验收判据
  - verified vs candidate 证据
  - touchpoints

所以 planning 的结果不再只是：
- 一段听起来很有条理的话

而是：
> **执行控制面的正式输入。**

这就是为什么这章标题里要强调：
- 规划不再只是 prose

因为在这里，Reasonix 实际上把“计划”从叙事，提升成了 **机器可验证的执行契约**。

---

## 八、`planFacts` 和 `mutationEscapesPlan`：计划为什么还能限制执行边界

如果 PlanContract 只是结构化版的“说明书”，那还不够强。

Reasonix 更进一步：
- `planFacts` 把计划投影成执行器和验收器可消费的事实
- `mutationEscapesPlan` 用计划约束写入范围

这意味着计划不仅能指导执行，还能：
- 限制写入边界
- 限制引用边界
- 限制“系统到底被允许碰哪些文件 / 路径”

这里最成熟的地方是：
> **计划不只是指导器，它还是边界约束器。**

这和我们在 OpenCode 里看到的 permission / output store / stale rejection 一样，都是在回答：
- 怎么防系统“越做越野”

---

## 九、持久化 no-op 为什么重要

一个很容易被忽略、但非常成熟的设计是：

如果某一轮只有 planner 跑了，executor 没真正执行，Reasonix 仍然会持久化：
- 一条 no-op 备注

这件事看起来很小，但意义非常大：

> **下轮执行器必须知道：上一轮并没有真正做任何动作。**

如果没有这层：
- 下一轮会误以为某些步骤已经执行
- 会话历史会出现“规划过了但没落地”的假理解

所以 no-op note 不只是提示，而是：
> **对未执行轮次的 durable 语义。**

---

## 十、交接防注入：为什么 planner 文本不能直接操纵 executor

这是 Coordinator 里最值得高度关注的设计之一。

它明确意识到：
- planner 的文本输出本身并不天然可信
- 尤其不能让它：
  - 声称自己没权限
  - 声称用户已经批准
  - 声称某个工具不可用
  - 声称某个 candidate 已经 verified

所以它的 handoff 协议里明确规定：
- planner 输出只是上下文
- 能力限制必须由 executor 自己验证
- 审批状态必须由 host 明确传入
- candidate 路径仍要再验证

这是非常重要的一层：
> **Reasonix 已经意识到 planner 也是潜在的污染源。**

也就是说，Coordinator 不只是管两个模型怎么协作，
还在管：
> **规划层不能操纵执行层。**

这非常成熟。

---

## 十一、这一章真正解决了哪些工程问题？

### 1. 如何把 planner / executor 真正解耦
Reasonix 的解法：Coordinator + Runner 抽象 + 结构化计划交付

### 2. 如何决定什么时候需要 planner
Reasonix 的解法：确定性路由，而不是让模型自由决定

### 3. 如何避免 planner 故障把任务系统搞崩
Reasonix 的解法：按场景区分降级与 fail-closed

### 4. 如何让计划真正进入执行控制面
Reasonix 的解法：PlanContract / planFacts / acceptanceCriterionIDs

### 5. 如何防止 planner 文本污染 executor
Reasonix 的解法：handoff anti-injection 协议

所以这一章最值得学的，不是“Reasonix 用了双模型”，而是：

> **它把规划层和执行层之间的边界，做成了真正可控制、可验证、可降级、可防注入的系统。**

---

## 十二、读者最容易学错的地方

### 错觉 1：Coordinator 只是把两个模型串起来
错。它在定义规划与执行的控制边界。

### 错觉 2：PlanContract 只是结构化文档
错。它是执行控制和边界约束的输入。

### 错觉 3：planner route 只是策略优化
错。它是系统控制语义，不是聊天偏好。

### 错觉 4：planner 失败降级只是容错技巧
错。它体现的是“哪些规划错误可以继续，哪些必须停”的治理哲学。

### 错觉 5：handoff 只是 planner 给 executor 说一句话
错。这里最关键的是防注入与可验证性。

---

## 十三、分析边界

### 为什么这里不先看具体工具执行细节
因为这一章关心的是 planning → execution 的边界，不是 tool leaf 行为。

### 为什么这里不先展开 goaleval / boundedllm 内部细节
因为第一轮先要理解它们在 Coordinator 里的结构地位，细节可以单拉一章深读。

### 为什么测试是关键证据
planner 降级、plan_only fail-closed、no-op note、anti-injection 等关键语义，很多必须靠测试和组合行为才能确认。

---

## 十四、关键源码位置

| 文件 | 行数 | 核心职责 |
|------|------|----------|
| `internal/agent/coordinator.go` | 789 行 | 双模型协作核心：planner/executor 路由、降级、交付 |
| `internal/agent/planner_route.go` | 62 行 | 确定性路由：4 种路由 + 3 种深度 |
| `internal/agent/planner_registry.go` | 49 行 | planner 注册表 |
| `internal/agent/plan_contract.go` | 160 行 | planFacts 投影、判据 ID 验证、写逃逸检测 |
| `internal/plancontract/plan.go` | 301 行 | Plan 数据结构、Normalize/Validate |
| `internal/plancontract/order.go` | 155 行 | Ordered 单排序源 |
| `internal/plancontract/diff.go` | 141 行 | Diff 版本差异、NeedsApproval |
| `internal/plancontract/render.go` | 123 行 | Render（用户看到的计划）|
| `internal/plancontract/project.go` | 33 行 | ProjectTodos（执行器看到的任务列表）|

**阅读顺序建议**：
1. 先读 `plancontract/plan.go`，理解 Plan 数据结构
2. 再读 `coordinator.go` 的 `DefaultPlannerPrompt`（24-40 行），理解 planner 行为约束
3. 再读 `planner_route.go`，理解确定性路由
4. 再读 `plan_contract.go` 的 `mutationEscapesPlan`（102-135 行），理解写逃逸检测
5. 最后读 `plancontract/diff.go`，理解 NeedsApproval 的"扩张才审批"语义

## 十五、工程问题学习点

| 工程问题 | Reasonix 的解法 | 代价 | 可迁移到 |
|----------|----------------|------|----------|
| 规划和执行如何不互相污染 | Coordinator + PlanContract | 系统更复杂，交接协议更重 | 有多阶段规划/执行的 Agent |
| 什么时候需要 planner | 确定性路由（4 路由 + 3 深度） | 需要维护路由策略 | 任何担心 planner 过用/滥用的系统 |
| planner 故障如何处理 | 分场景降级 vs fail-closed | 需要区分普通任务和边界任务 | 高风险任务系统 |
| 计划如何真正进入执行控制面 | PlanContract / planFacts / acceptanceCriterionIDs | 计划对象更重，解析更复杂 | 强调执行边界的系统 |
| 计划如何约束写入范围 | mutationEscapesPlan | 需要维护 verified/candidate files | 会修改工作区的 Agent |
| 如何防止 planner 文本操纵 executor | 7 条交接防注入指令 | 交接协议更复杂 | planner/executor 分离的系统 |

## 十六、读者分层路由

### beginner
先抓住：
1. Coordinator 不是“双模型功能”，而是控制边界
2. planner 不负责执行
3. plan contract 不是 prose

### intermediate
重点看：
- planner route
- deliverPlan 决策表
- no-op note
- anti-injection handoff

### advanced
重点看：
- planFacts / mutationEscapesPlan
- criterion ID verification
- fail-closed / degrade 语义边界
- coordinator 对产品级规划系统的启发

---

## 十五、迁移清单

### 可迁移思想 1：planner / executor 必须通过结构化契约交接
- 可迁移到：有多阶段规划 / 执行分层的 Agent 系统
- 前提：执行层要可验证、可审计、可约束
- 不能照搬的点：极简单模型系统不一定需要完整 coordinator

### 可迁移思想 2：planner route 应该是确定性策略而不是模型感觉
- 可迁移到：任何担心 planner 过用 / 滥用 / 失控的系统
- 前提：任务复杂度可被策略判断
- 不能照搬的点：如果系统完全没有 planning 层，这条不成立

### 可迁移思想 3：plan 能约束 mutation scope
- 可迁移到：会写文件、改代码、改环境的 Agent 系统
- 前提：计划必须能产出 touchpoints
- 不能照搬的点：没有写入能力的系统收益较小

### 可迁移思想 4：planner handoff 必须防注入
- 可迁移到：任何 planner 和 executor 分开的 Agent 架构
- 前提：planner 输出本身不被视为真相
- 不能照搬的点：完全单模型、无规划层系统无需这么重

---

## 十六、自测问题

1. 为什么 Reasonix 要把 planner / executor 之间的边界做得这么重？
2. 为什么 plan contract 比 prose handoff 更重要？
3. 为什么 planner route 不能交给模型自己随便决定？
4. 为什么 `plan_and_execute` 可以降级，而 `plan_only / plan_for_approval` 必须 fail-closed？
5. 为什么 anti-injection handoff 是 Coordinator 里最值钱的设计之一？

---

## 十七、读完这一章，读者应该获得什么能力？

至少应该能做到：

1. 解释 Coordinator 为什么不只是“双模型协作器”，而是规划与执行之间的控制边界。
2. 说清 PlanContract 为什么是执行系统输入，而不是结构化文档。
3. 理解 planner 路由、降级和 fail-closed 各自的语义边界。
4. 理解 planFacts / mutationEscapesPlan / criterion validation 在保护什么边界。
5. 用自己的话说明：Reasonix 为什么更像“一个被计划契约驱动的任务系统”，而不是“一个会多想一步的聊天 Agent”。

如果还做不到这些，就说明这章还没真正学懂。
