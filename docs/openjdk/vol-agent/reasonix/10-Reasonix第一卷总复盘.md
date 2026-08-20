# Reasonix 第一卷总复盘

> 覆盖范围：
> 1. Controller
> 2. Coordinator / PlanContract
> 3. RunLoop / Durable Execution
> 4. ContextManager / Checkpoint / Recovery
> 5. Goaleval / BoundedLLM
> 6. Permission / WorkspaceLease
> 7. Memory / History
> 8. TaskContract / AutoResearch

---

## 一、这一卷到底在讲什么？

如果只看单篇标题，你可能会觉得这一卷讲的是很多模块：
- controller
- coordinator
- run loop
- context manager
- checkpoint
- goaleval
- permission
- memory
- task contract

但如果把它们真正收回到一起，这一卷其实只在讲一件事：

> **Reasonix 如何把 Agent 从"会调模型的程序"，做成一个由单控制器驱动、由任务契约约束、由独立审查器许可、由缓存优先上下文支撑、由持久恢复边界保护的长跑任务系统。**

也就是说，Reasonix 这一卷真正的主线不是"功能列表"，而是：

```text
单控制器控制面
  ↓
规划与执行契约
  ↓
长跑执行骨架
  ↓
缓存优先上下文 + 恢复边界
  ↓
独立审查器
  ↓
副作用边界与工作区一致性
  ↓
长期知识与会话轨迹
  ↓
任务目标、停滞检测与数据契约
```

这条线非常完整，也说明 Reasonix 的产品哲学不是：
- 先把功能堆上去

而是：
- 先把控制面站稳
- 再把契约、执行、审查、恢复、知识一层层接上去

---

## 二、Reasonix 最值得记住的 5 个系统判断

## 1. 前端不拥有执行语义，Controller 才拥有

这是 Reasonix 最根本的一条判断。

它不把 Agent 看成：
- 每个前端各自跑一个循环

而是看成：
- 所有前端共享同一个单控制器

所以：
- TUI 只是入口
- HTTP 只是入口
- Desktop 只是入口
- Controller 才是唯一的逻辑层

这点是 Reasonix 和很多"Agent CLI"之间最本质的区别。

---

## 2. 计划不是 prose，而是数据契约

Reasonix 对计划的理解非常成熟：
- PlanContract 不是给人看的文档
- 它会被 Ordered / Diff / ProjectTodos / NeedsApproval / mutationEscapesPlan 继续消费

这意味着：
> **计划是执行控制面的正式输入，不是叙述附属物。**

这也是为什么：
- SuccessCriterion 必须带 EvidenceIDs
- CandidateFiles 和 VerifiedFiles 必须分开
- 范围扩张才需要审批

---

## 3. 上下文不是 prompt 字符串，而是受缓存优先原则支配的状态系统

Reasonix 在 ContextManager 上的核心判断是：
- system prompt + 首个用户 turn 构成字节稳定的缓存前缀
- 会话中途变化走 transient tail injection
- compaction 有明确触发线和保护集

这说明它真正解决的不是"怎么写 prompt"，而是：
> **模型每一轮看到的系统语义，如何在长跑中保持稳定并控制成本。**

---

## 4. 完成判定不是收尾检查，而是自主执行的准入条件

Goaleval 在 Reasonix 里不是附加验证器，而是：
- 无工具
- 无完整历史
- 独立 usage source
- 有界预算
- fail-closed

这意味着：
> **没有 evaluator，目标循环就不能继续跑。**

这条设计让 Reasonix 明显区别于"模型自己宣布完成"的系统。

---

## 5. 任务不是一句话目标，而是被数据契约约束的执行对象

TaskSpec / AutoResearch 让任务具备了：
- goal
- scope
- non_goals
- allowed_operations
- success_criteria + evidence_ids
- stale_count / pivot_count
- next_required_action

这意味着：
> **Reasonix 把"做什么、做到什么程度、什么时候该转向、什么时候该问人"都做成了系统可计算的契约。**

---

## 三、这一卷里最关键的工程问题是什么？

如果你把前 8 篇串起来看，Reasonix 真正解决的工程问题主要有这几类：

### 1. 如何让所有前端共享同一套 Agent 逻辑
- Controller

### 2. 如何把规划和执行之间的边界做成可验证契约
- Coordinator + PlanContract

### 3. 如何让 Agent 从对话程序变成长跑任务系统
- RunLoop + TurnOrchestrator + session 级 jobs

### 4. 如何在缓存成本、上下文完整性和长跑恢复之间做平衡
- ContextManager + Checkpoint + Recovery

### 5. 如何让完成判定独立于执行器
- Goaleval + BoundedLLM

### 6. 如何把副作用边界和工作区一致性纳入任务系统
- Permission + WorkspaceLease

### 7. 如何把长期知识、临时会话和历史轨迹拆开
- Memory + History + Archive

### 8. 如何把任务目标、停滞检测和转向策略做成数据契约
- TaskSpec + AutoResearch + stale/pivot + nextRequiredAction

---

## 四、Reasonix 最值得迁移的思想是什么？

这一卷里，我认为最值得迁移的思想有 8 个：

### 1. 单控制器统一所有前端逻辑
这避免了前端各自发明执行语义。

### 2. 计划是数据，不是 prose
这是系统能对计划做 diff、审批、写边界约束的前提。

### 3. 确定性 planner route
什么时候需要规划、什么时候不需要，应该是系统策略，不是模型感觉。

### 4. Planner/Executor 交接必须防注入
规划层文本不能直接操纵执行层。

### 5. 上下文必须缓存优先
这决定了 Agent 的成本和长跑能力。

### 6. Evaluator 必须独立、有界、fail-closed
这是自主运行的安全前提。

### 7. 任务停滞和转向必须量化
stale_count / pivot_count / nextRequiredAction 把"感觉没进展"变成了可执行信号。

### 8. 工作区租约按任务生命周期持有
这保护了 review / verify / completion 的一致性。

---

## 五、Reasonix 和 OpenCode 的核心差异

| 维度 | OpenCode | Reasonix |
|------|----------|----------|
| 控制面 | SessionRunner + RunCoordinator | 单控制器 Controller |
| 规划层 | 无显式 planner route | Coordinator + PlanContract + 确定性路由 |
| 上下文 | SystemContext + Context Epoch + Compaction | 缓存优先 + 固定前缀 + transient tail |
| 完成判定 | 无独立 evaluator | Goaleval + BoundedLLM fail-closed |
| 记忆 | 无显式 subject 冲突模型 | Subject 冲突模型 + pinned/relevant + freshness |
| 任务契约 | 无显式 TaskSpec | TaskSpec + stale/pivot + nextRequiredAction |
| 工作区保护 | Permission 为主 | Permission + WorkspaceLease |
| 平台化方向 | MCP / Protocol / SDK | 控制器 + 契约 + 独立审查 |

一句话总结差异：
> **OpenCode 更像"现代 Agent runtime 的完整工程化版本"，Reasonix 更像"受控制器驱动的长跑任务操作系统"。**

---

## 六、这一卷最容易被误读的地方

### 误读 1：Reasonix 复杂，是因为它功能太多
不对。
更准确地说，它复杂，是因为它试图把 Agent 做成：
- 可恢复
- 可审查
- 可约束
- 可长跑
的任务系统。

### 误读 2：Controller 只是命令分发器
不对。它是整个系统的统一控制面。

### 误读 3：PlanContract 只是结构化文档
不对。它是执行、验收、审批、写入边界共同消费的契约。

### 误读 4：Goaleval 只是收尾验证器
不对。它是自主运行的准入条件。

### 误读 5：stale_count / pivot_count 只是统计字段
不对。它们是继续 / 转向 / 问人的控制信号。

---

## 七、如果读者只读这一卷，最后应该获得什么整体认知？

至少应该得到这 6 个判断：

1. **Reasonix 的核心不是对话，而是受控制器驱动的任务系统。**
2. **它的计划不是 prose，而是数据契约。**
3. **它的上下文不是字符串，而是缓存优先、受保护的状态系统。**
4. **它的完成判定不是模型自我宣布，而是独立审查器许可。**
5. **它的任务不是一句话目标，而是被目标、范围、非目标、成功标准、停滞检测共同约束的执行对象。**
6. **它已经明显不是一个 CLI 工具，而是在向"受控任务操作系统"演进。**

如果读完这 8 篇，读者还看不到这 6 个判断，那说明这一卷还没有真正完成。

---

## 八、后续怎么衔接到多项目对比？

Reasonix 第一卷结束后，最重要的是把它沉淀成几个对比锚点，后面去看 Pi / Hermes / dsh 时，重点比较：

1. 控制面是单控制器还是分布式？
2. 计划有没有数据契约？
3. 上下文是缓存优先还是自由拼接？
4. 完成判定有没有独立审查器？
5. 任务有没有停滞检测和转向策略？
6. 工作区一致性怎么保护？
7. 长期知识怎么组织？

也就是说，Reasonix 的价值不只是"学会 Reasonix"，而是：
> **给后面 3 个项目建立一个"受控任务系统"的比较底座。**

---

## 九、一句话结论

Reasonix 第一卷最本质的收获，不是"它有哪些模块"，而是：

> **它展示了一个 Agent 系统如何把单控制器、任务契约、缓存优先上下文、独立审查器、副作用边界、长期知识和停滞检测，组织成一个真正能长跑的受控任务操作系统。**

这就是这 8 篇真正拼出来的东西。
