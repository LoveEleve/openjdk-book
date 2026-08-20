# TaskContract 与 AutoResearch：Reasonix 如何把任务目标和停滞检测做成数据契约

> 项目：Reasonix（main-v2 基线）
> 角色：主线机制正文 08
> 对应范围规划：`01-Reasonix源码学习范围规划.md`
> 依据材料：
> - `Agent/analysis/reasonix/01-闭环笔记/pass2-rq1-autoresearch.md`
> - `Agent/analysis/reasonix/01-闭环笔记/pass2-rq2-plancontract.md`

---

## 零、阅读前提示

- 建议先读：
  1. `03-Coordinator与PlanContract：Reasonix 如何让规划不再只是 prose.md`
  2. `04-RunLoop与DurableExecution：Reasonix 如何把 Agent 变成长跑任务系统.md`
  3. `06-Goaleval与BoundedLLM：Reasonix 为什么把完成判定做成独立审查器.md`
- 推荐源码阅读路径：
  1. `internal/autoresearch/task.go`
  2. `internal/autoresearch/summary.go`
  3. `internal/autoresearch/store.go`
  4. `internal/plancontract/plan.go`
  5. `internal/plancontract/order.go / diff.go / render.go / project.go`

## 一、这一章真正的问题

Agent 系统最容易退化成一句空话的是：
- “先分析一下，再继续做”
- “计划写好了，后面照着做”
- “感觉没有进展，换个方向”

这些判断如果都靠 prose，最后就会变成：
- 说起来像计划
- 但系统无法验证
- 无法知道是否越界
- 无法判断什么时候该转向、什么时候该停

所以这一章真正要回答的是：

> **Reasonix 如何把任务目标、范围、允许的操作、成功标准、停滞信号和下一步动作，全部做成数据契约。**

这意味着：
- 计划不是文档
- 任务不是一句话
- 停滞不是直觉
- 转向不是拍脑袋

---

## 二、先给结论：Reasonix 把“任务”当成一个被数据约束的执行对象，而不是一段待完成的自然语言描述

这里最值钱的，不是 `TaskSpec` 长什么样，
而是它背后的判断：

> **任务必须先被结构化，系统才能对它做控制。**

如果任务只是：
- 一个 goal 文本
- 一段 plan prose

那后面这些问题都没法稳做：
- 我现在是不是越界了？
- 哪些成功标准还没满足？
- 哪些证据已经足够？
- 我是在停滞还是正常推进？
- 该继续、该转向还是该问人？

所以 Reasonix 在这里做的是：
> **把任务从“描述”提升成“可被系统读取和判定的契约对象”。**

---

## 三、为什么 `TaskSpec` 是规格书三合一蓝本

`TaskSpec` 里最值得学的不是字段数量，而是字段角色：

- `Goal`
- `Scope`
- `NonGoals`
- `AllowedOperations`
- `SuccessCriteria`

这 5 件事拼起来，已经不只是“计划”，而是：

### 1. 执行目标
系统到底在完成什么。

### 2. 范围边界
哪些东西属于当前任务，哪些不属于。

### 3. 非目标
即使看起来相关，也不在这一轮里做。

### 4. 权限边界
允许写什么、联网什么、发布什么。

### 5. 成功标准
怎样才算真正完成。

所以它像的不是 todo list，而是：
> **规格书 + 执行契约 + 验收基线的三合一。**

这就是为什么我们说它是“规格书蓝本”。

---

## 四、SuccessCriterion 为什么不是附加元数据，而是验收核心

很多系统里 success criteria 只是：
- 一个 checklist
- 看起来更正式一点

Reasonix 这里不一样。

它为每个 criterion 都显式绑定了：
- `ID`
- `Description`
- `Required`
- `EvidenceIDs`

这意味着：

> **成功标准不是一句愿望，而是需要证据去满足的对象。**

特别是：
- `Required = true` 但 `countAcceptedEvidence == 0`
  → 状态就必须是 open

所以这里真正重要的是：
- success criteria 不只是写下来
- 它们会驱动系统判定“还有没有未完成项”

也就是说，Reasonix 的任务系统在这里真正开始接近：
> **可审计的执行契约。**

---

## 五、为什么 `nextRequiredAction` 很值钱

`nextRequiredAction()` 是这章里最容易被低估、却最像“Agent 产品灵魂”的设计之一。

因为它把一句非常模糊的话：
- “下一步该怎么办”

变成了有结构的决策链：
- blocked → 先解阻塞
- stale >= 4 → 问人（最小外部输入）
- stale >= 2 → 结构性转向
- 否则 → 继续下一个能产出证据的步骤

这意味着它在解决：

> **当 Agent 没有明显进展时，到底是继续硬跑、换方向，还是向人求助。**

这一步太关键了，因为很多 Agent 系统死在这里：
- 一直重复同一方向
- 或者频繁乱 pivot
- 或者该问人时不问人

而 Reasonix 已经把这些行为：
- 量化
- 结构化
- 策略化
了。

---

## 六、为什么 `stale_count / pivot_count` 这么重要

这两个字段其实是在回答：

> **系统怎么知道自己是在推进，还是在假装推进。**

### `stale_count`
表示：
- 在同一方向上重复尝试
- 但没有新进展

### `pivot_count`
表示：
- 方向切换次数
- 过高时意味着系统可能在乱窜

这比“看起来好像卡住了”强太多了。因为它把“感觉没进展”变成：
- 可累计
- 可阈值化
- 可驱动控制动作

所以 `stale_count / pivot_count` 的价值不是统计字段，
而是：
> **Agent 死循环与盲目转向的量化控制器。**

---

## 七、为什么 `PlanContract` 比 prose handoff 更重要

上一章其实已经讲过，Reasonix 不满足于 prose handoff。

这章要补上的点是：
- `Plan` 不是给人看的漂亮列表
- 它会被：
  - `Ordered()`
  - `Diff()`
  - `ProjectTodos()`
  - `NeedsApproval()`
  这些算法继续消费

这意味着：

> **Plan 是一个可排序、可比较、可投影、可审批、可限制写入范围的可执行对象。**

也就是说，`PlanContract` 在这里的价值不只是“planner 更规范”，而是：
- 计划真正进入了系统控制流

这是它和普通 prose 最大的区别。

---

## 八、为什么 `NeedsApproval` 的“扩张才审批”这么成熟

这是一个非常产品级的设计。

Reasonix 明确区分：

### 需要审批
- 新步骤
- 新目标
- 新风险
- 新判据
- 更宽的 touchpoints / candidate files

### 不需要审批
- 删步骤
- 改标题
- 重排序
- 收窄范围

这背后的哲学很清楚：

> **范围收敛不该总是打扰用户，范围扩张才需要重新确认。**

这是非常成熟的审批语义。

如果没有这层判断，系统只会两头坏：
- 要么什么都审批，交互极重
- 要么什么都不审批，边界失控

Reasonix 的回答是：
> **审批关注的是“范围有没有被扩大”，而不是“内容有没有变化”。**

---

## 九、为什么 `planFacts` / `mutationEscapesPlan` 是真正的执行边界

如果 plan 只是指导器，那它的价值还不够高。

Reasonix 更进一步做了两件事：

### `planFacts`
把计划投影成执行与验收都能消费的事实层。

### `mutationEscapesPlan`
判断：
- 当前写入是否超出了计划声明的范围

这非常关键，因为它意味着：

> **计划不仅告诉执行器“做什么”，还限制执行器“最多做什么”。**

这和权限、租约一样，都是在建立：
- 系统不应该越界

所以这一层是：
> **planning → execution boundary 的真正落地处。**

---

## 十、这一章真正解决了哪些工程问题？

### 1. 如何把任务从自然语言目标提升成可执行契约
Reasonix 的解法：TaskSpec

### 2. 如何让成功标准变成证据可验证对象
Reasonix 的解法：SuccessCriterion + EvidenceIDs

### 3. 如何量化停滞和转向，而不是靠感觉
Reasonix 的解法：stale_count + pivot_count + nextRequiredAction

### 4. 如何让计划真正进入执行系统，而不只是生成给人看的文本
Reasonix 的解法：PlanContract / planFacts / ProjectTodos

### 5. 如何把审批语义建立在“范围扩张”而不是“任何变化”之上
Reasonix 的解法：NeedsApproval

这一章最值得学的，不是“Reasonix 有计划对象”，而是：

> **它把任务目标、成功标准、停滞检测、审批和写入边界，全都做成了系统可计算的数据契约。**

---

## 十一、关键源码位置

| 文件 | 行数 | 核心职责 |
|------|------|----------|
| `internal/autoresearch/task.go` | 125 行 | TaskSpec 数据结构、Progress 停滞检测 |
| `internal/autoresearch/schema.go` | 52 行 | 规格书合法性检查 |
| `internal/autoresearch/summary.go` | 95 行 | 验收算法、nextRequiredAction 决策链 |
| `internal/autoresearch/store.go` | 659 行 | 任务存储、增量读取、安全读取模型 |
| `internal/plancontract/plan.go` | 301 行 | Plan 数据结构、Normalize/Validate |
| `internal/plancontract/order.go` | 155 行 | Ordered 单排序源 |
| `internal/plancontract/diff.go` | 141 行 | Diff 版本差异、NeedsApproval |
| `internal/plancontract/render.go` | 123 行 | Render（用户看到的计划） |
| `internal/plancontract/project.go` | 33 行 | ProjectTodos（执行器看到的任务列表） |

**阅读顺序建议**：
1. 先读 `autoresearch/task.go`，理解 TaskSpec 和 Progress 结构
2. 再读 `summary.go` 的 `nextRequiredAction`（74-82 行），理解停滞/转向决策链
3. 再读 `plancontract/plan.go`，理解 Plan 数据结构和 Normalize/Validate
4. 再读 `plancontract/diff.go` 的 `NeedsApproval`（84-99 行），理解"扩张才审批"
5. 最后读 `plancontract/render.go`，理解计划如何被渲染和投影

## 十二、工程问题学习点

| 工程问题 | Reasonix 的解法 | 代价 | 可迁移到 |
|----------|----------------|------|----------|
| 如何把任务从自然语言目标提升成可执行契约 | TaskSpec（goal/scope/non_goals/allowed_operations/success_criteria） | 任务对象更重，解析更复杂 | 多轮持续执行的 Agent |
| 如何让成功标准变成证据可验证对象 | SuccessCriterion + EvidenceIDs | 需要维护证据链 | 强调自动验收的 Agent |
| 如何量化停滞和转向 | stale_count + pivot_count + nextRequiredAction | 需要维护状态计数器 | 长跑、自主研究类 Agent |
| 如何让计划真正进入执行系统 | PlanContract / planFacts / ProjectTodos | 计划对象更复杂 | 有计划对象的系统 |
| 如何把审批语义建立在"范围扩张"之上 | NeedsApproval（扩张才审批） | 需要区分收敛和扩张 | 有审批流程的系统 |

## 十三、读者分层路由

### 错觉 1：TaskSpec 就是更正式的任务描述
错。它是执行、验收、恢复共同消费的契约对象。

### 错觉 2：SuccessCriteria 是 checklist
错。它们通过 `EvidenceIDs` 进入验证系统。

### 错觉 3：stale_count / pivot_count 只是统计字段
错。它们是继续 / 转向 / 问人的控制信号。

### 错觉 4：PlanContract 只是 planner 的结构化输出
错。它还控制 ProjectTodos、Diff、NeedsApproval、mutation scope。

### 错觉 5：审批只是人工确认
错。这里真正成熟的是审批触发语义：范围扩张才审批。

---

## 十二、分析边界

### 为什么这里不先展开 memory / history
因为这章先讲任务契约与控制语义；记忆和会话轨迹是它们的长期承接层，不是契约定义层。

### 为什么这里不先展开具体 tool leaf
因为这章关注的是“任务允许什么”和“计划约束什么”，不是具体工具细节。

### 为什么测试是关键证据
TaskSpec / PlanContract 最值钱的点在行为语义上——幂等、Diff、NeedsApproval、投影和边界检测，不看测试很容易把它们看成普通数据结构。

---

## 十三、读者分层路由

### beginner
先抓住：
1. 任务不是一句话，而是契约对象
2. 成功标准不是愿望，而是带证据的验证对象
3. 没进展不是感觉，而是有 stale / pivot 信号

### intermediate
重点看：
- TaskSpec 字段角色
- SuccessCriterion / EvidenceIDs
- nextRequiredAction
- NeedsApproval
- mutationEscapesPlan

### advanced
重点看：
- PlanContract 如何从“计划文本”升级成“执行控制对象”
- 为什么 candidate / verified files 必须分开
- 为什么审批和写入边界都建立在计划数据结构上

---

## 十四、迁移清单

### 可迁移思想 1：任务目标必须结构化
- 可迁移到：所有需要多轮持续执行的 Agent
- 前提：目标、范围、非目标、允许操作需要进入系统控制流
- 不适合直接照搬到：极短、一次性任务

### 可迁移思想 2：成功标准必须带 evidence ids
- 可迁移到：任何强调自动验收的 Agent
- 前提：证据可被独立记录和匹配
- 不适合直接照搬到：完全主观创造型任务

### 可迁移思想 3：停滞与转向必须量化
- 可迁移到：长跑、自主研究、自主规划类 Agent
- 前提：系统会自己继续跑，而不是每轮都靠人驱动
- 不适合直接照搬到：纯人工逐轮确认系统

### 可迁移思想 4：范围扩张才审批
- 可迁移到：有计划、有审批、有写边界的 Agent
- 前提：系统能区分“收敛”与“扩张”
- 不适合直接照搬到：无计划对象的极简系统

---

## 十五、自测问题

1. 为什么 Reasonix 不满足于把任务写成一句 goal？
2. 为什么 SuccessCriterion 一定要带 EvidenceIDs？
3. stale_count / pivot_count 为什么不是统计，而是控制信号？
4. 为什么 NeedsApproval 的成熟点在“扩张才审批”？
5. 为什么 mutationEscapesPlan 是规划层最重要的执行边界之一？

---

## 十六、读完这一章，读者应该获得什么能力？

至少应该能做到：

1. 解释为什么 Reasonix 要把任务目标、范围、非目标、允许操作和成功标准都结构化。
2. 说清 TaskSpec / PlanContract / SuccessCriterion / nextRequiredAction 各自的作用。
3. 理解为什么停滞、转向和问人必须有量化标准。
4. 理解为什么计划不仅指导执行，还约束审批与写入范围。
5. 用自己的话说明：Reasonix 为什么更像“以任务契约驱动的系统”，而不只是“会规划一下的 Agent”。

如果还做不到这些，就说明这章还没真正学懂。
