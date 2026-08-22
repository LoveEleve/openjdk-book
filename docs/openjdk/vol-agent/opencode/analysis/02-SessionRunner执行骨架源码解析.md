# OpenCode SessionRunner 源码解析：双层循环如何把会话持续跑下去

> 解析对象：`packages/core/src/session/runner/llm.ts`、`packages/core/src/session/execution.ts`
> 定位：OpenCode 第二份真正源码解析，验证“外层 queue + 内层 continuation + turn 协议”这条执行主线。
> 关联机制分析：`opencode/03-SessionRunner与SessionExecution：OpenCode 的执行骨架如何持续运行.md`

---

## 一、解析对象

- 文件名：`packages/core/src/session/runner/llm.ts`、`packages/core/src/session/execution.ts`
- 行数范围：runner 主循环、runTurn、execution 状态协同段
- 核心函数/方法：`SessionRunner` 主循环、`runTurn`、continuation / promotion / compaction 转移逻辑
- 入口事件/命令：会话 queue 中存在待处理 durable 输入
- 出口事件/返回：turn 结束、继续下一轮、触发 compaction 转移、或会话停机

## 二、调用链

```text
会话 queue 有待处理输入
  → SessionRunner 外层循环
  → 检查是否需要开始新 turn
  → runTurn
  → promotion / request 组装 / llm.stream
  → 发布 text / reasoning / tool-call 增量事件
  → eager 工具执行与 settle
  → 判断 needsContinuation / compaction / stop
  → 返回外层循环继续或停机
```

## 三、状态转换

| 状态 | 进入条件 | 离开条件 | 关键行 |
|------|----------|----------|--------|
| queue 待处理 | inbox/promoted 输入存在 | 新 turn 启动 | `llm.ts` 外层循环 |
| turn 运行中 | request 已发给 provider | 模型停止、工具待续跑或异常转移 | `runTurn` 主流程 |
| continuation | 当前 turn 仍需续跑 | 工具结果回流或 turn 真正结束 | `needsContinuation` 判断段 |
| compaction 转移 | 上下文超限 / TurnTransitionError | 用压缩后上下文重启当前 turn | compaction 分支 |
| stopped | queue 空且当前 turn 结束 | 新输入再唤起 | runner 收尾段 |

## 四、关键分支

| 分支 | 判断条件 | line | 结果 |
|------|----------|------|------|
| promotion 发生 | queue 中 durable 输入被提升 | `llm.ts` promotion 段 | `step` 重置，进入新执行回合 |
| 需要 continuation | 当前 turn 产出 tool calls / steer 后仍未闭环 | `llm.ts` continuation 判断 | 留在内层循环继续 |
| compaction 触发 | 请求超上下文或显式转移错误 | `llm.ts` / `execution.ts` 转移段 | 回到 turn 起点重跑 |
| 工具失败 | settle 时出现失败语义 | runner 工具收尾段 | 发布失败事件并让模型可见 |
| location 失效 | runner 所属位置已变化 | turn 开头校验段 | 拒绝旧 runner 继续执行 |

## 五、数据流

- 输入来源：SessionInput / queue promotion / 当前 turn 工具结果
- 传递路径：queue → runTurn request → `llm.stream` 增量事件 → tool fibers → Step.Ended / Step.Failed
- 输出去向：durable event store、会话投影状态、下一轮 continuation 判断

## 六、测试契约

| 测试名 | 位置 | 验证内容 |
|--------|------|----------|
| `session-runner.test.ts` | `packages/core/test/session-runner.test.ts` | 验证 runner 双层循环、工具续跑、step 语义与停止条件 |
| `session-runner-recorded.test.ts` | `packages/core/test/session-runner-recorded.test.ts` | 验证 durable 重放下 runner 行为稳定 |

## 七、总结

- 核心结论：OpenCode 的执行骨架不是普通 while，而是把 queue、continuation、tool settle、compaction 转移统一进可恢复运行协议。
- 可迁移点：把“会话级新工作”和“当前 turn 续跑”分成两层循环，能显著降低长跑 Agent 的控制流混乱度。
- 易错点：把 compaction 当成普通 helper；实际上它在 SessionRunner 里是一种正式的执行转移语义。
