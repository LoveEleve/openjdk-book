# Reasonix DurableExecution 源码解析：RunLoop 如何变成长期任务系统

> 解析对象：`internal/agent/run_loop.go`、`internal/control/turn_orchestrator.go`
> 定位：Reasonix 第三份真正源码解析，验证“RunLoop + TurnOrchestrator + GoalEval/Checkpoint 协同”这条长跑主线。
> 关联机制分析：`reasonix/04-RunLoop与DurableExecution：Reasonix 如何把 Agent 变成长跑任务系统.md`

---

## 一、解析对象

- 文件名：`internal/agent/run_loop.go`、`internal/control/turn_orchestrator.go`
- 行数范围：run loop 主流程、turn orchestration 关键段
- 核心函数/方法：RunLoop 主循环、turn orchestration、malformed completion / missing reasoning 恢复路径
- 入口事件/命令：Controller 发起一次 session/goal 执行推进
- 出口事件/返回：turn 完整结束、checkpoint 边界形成、goal 继续/阻塞/完成

## 二、调用链

```text
Controller 接到任务
  → TurnOrchestrator 组织前台回合
  → RunLoop 推进当前 turn
  → provider 输出 / 工具协作 / 恢复路径
  → turn 收尾与状态沉淀
  → GoalEval 判断 continue / blocked / complete / uncertain
  → checkpoint / jobs / completion 决定下一轮是否继续
```

## 三、状态转换

| 状态 | 进入条件 | 离开条件 | 关键行 |
|------|----------|----------|--------|
| 待执行 | Controller 发起目标推进 | turn 被 orchestration 建立 | `turn_orchestrator.go` 主流程 |
| turn 运行中 | RunLoop 已开始 | 模型完成、工具完成或进入恢复 | `run_loop.go` 主循环 |
| 恢复中 | 缺失推理 / 畸形完成 / 异常输出 | 成功回退或终止 | `run_loop.go` 恢复分支 |
| 待评估 | 当前 turn 收尾 | GoalEval 返回 verdict | controller/evaluator 协同段 |
| 可恢复边界 | 当前状态满足 checkpoint 条件 | 下次恢复或继续执行 | checkpoint 协同段 |
| session 继续 | verdict 为 continue / uncertain | 下一轮 turn 启动 | loop 外层推进 |

## 四、关键分支

| 分支 | 判断条件 | line | 结果 |
|------|----------|------|------|
| 缺失推理恢复 | 模型产出不满足结构要求 | `run_loop.go` 恢复段 | 保守回退，不盲目重放工具 |
| 工具不重跑 | 首次异常后已有副作用风险 | `run_loop.go` 工具恢复策略 | 使用已知结果恢复一致性 |
| evaluator 缺失或失败 | GoalEval 不可用 | evaluator 协同段 | fail-closed，停止继续 |
| checkpoint 成立 | 当前 turn 状态稳定 | checkpoint 协同段 | 形成可信恢复边界 |
| session 级 jobs 注入 | 后台任务跨 turn 存活 | jobs 协同段 | 结果在后续 turn 回注 |

## 五、数据流

- 输入来源：Controller 的目标、当前 session 状态、provider 输出、后台 jobs 摘要
- 传递路径：TurnOrchestrator → RunLoop → tool / recovery → GoalEval / checkpoint
- 输出去向：下一轮执行许可、checkpoint 状态、completion / notes / session 级持续任务状态

## 六、测试契约

| 测试名 | 位置 | 验证内容 |
|--------|------|----------|
| run loop / controller 相关测试 | `internal/agent`、`internal/control` 测试集 | 验证长跑 turn、恢复路径、goal 继续语义 |
| goal evaluator 测试 | `internal/goaleval/evaluator_test.go` | 验证 evaluator fail-closed 与 verdict 契约 |

## 七、总结

- 核心结论：Reasonix 的 durable execution 不是单个 loop，而是 RunLoop、TurnOrchestrator、GoalEval、Checkpoint 和 jobs 共同维持的长期任务协议。
- 可迁移点：把恢复语义、完成判定和 checkpoint 都提升到执行协议层，才能真正做长跑 Agent。
- 易错点：把 `run_loop.go` 当成普通回合循环；实际上它只有和 evaluator、checkpoint、jobs 绑在一起才成立。
