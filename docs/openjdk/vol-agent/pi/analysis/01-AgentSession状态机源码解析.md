# Pi AgentSession 状态机源码解析：复杂控制流如何收进共享会话内核

> 解析对象：`coding-agent/src/core/agent-session.ts`
> 定位：Pi 第一卷第一份真正源码解析，验证“显式会话状态机 + 多模式共享内核”这条核心路径。
> 关联机制分析：`pi/03-AgentSession状态机：Pi 为什么把复杂控制流收进会话系统.md`

---

## 一、解析对象

- 文件名：`coding-agent/src/core/agent-session.ts`
- 行数范围：主文件整体（超大核心文件，约 3000+ 行）
- 核心函数/方法：`AgentSession` 构造与主状态推进逻辑、steering / follow-up 消费、compaction / retry / abort 相关分支
- 入口事件/命令：interactive / print / rpc 模式通过 `AgentSessionRuntime` 驱动会话继续
- 出口事件/返回：会话状态推进、消息/条目持久化、下一轮 continuation 或停止

## 二、调用链

```text
前端模式（interactive / print / rpc）
  → AgentSessionRuntime
  → AgentSession（共享会话内核）
  → 消费 steering / follow-up / pending 输入
  → 构造当前 turn 上下文
  → 执行当前轮模型 / 工具 / continuation
  → 必要时触发 compaction / retry / abort / overflow recovery
  → 写入 session entries / 更新内存状态 / 决定继续或停止
```

## 三、状态转换

| 状态 | 进入条件 | 离开条件 | 关键行 |
|------|----------|----------|--------|
| 空闲会话 | 新建或上一轮结束 | 收到新 prompt / continue | `AgentSession` 主状态初始化段 |
| pending | 有待消费输入或 follow-up | turn 开始消费 | steering / follow-up 队列消费段 |
| turn 运行中 | 当前轮 request 已建立 | 工具完成 / 模型停机 / 异常转移 | turn 执行主流程 |
| compaction 中 | 上下文溢出或压缩被要求 | 生成 summary 并重建上下文 | compaction 分支 |
| retry / recovery | 模型或工具返回需要恢复 | 成功恢复或停止 | retry / overflow recovery 分支 |
| stopped | 无后续工作或显式终止 | 新输入再次唤起 | stop / finalize 分支 |

## 四、关键分支

| 分支 | 判断条件 | line | 结果 |
|------|----------|------|------|
| steering 注入 | 当前轮开始前存在 steering | `agent-session.ts` steering 处理段 | 改写当前轮方向 |
| follow-up 消费 | 当前轮准备停机且队列有 follow-up | `agent-session.ts` follow-up 处理段 | 开启会话级新工作 |
| compaction 触发 | 上下文窗口超限或显式压缩 | `agent-session.ts` compaction 段 | 用 summary 重建上下文 |
| retry 触发 | provider / tool / runtime 允许重试 | `agent-session.ts` retry 段 | 以恢复语义继续 |
| abort / bash interrupt | 当前执行被显式打断 | `agent-session.ts` abort 段 | 停止当前分支并保留会话真相 |

## 五、数据流

- 输入来源：前端 prompt、会话 continuation、steering、follow-up、持久化 session entries
- 传递路径：输入队列 → `AgentSession` 状态机 → 当前 turn request / tool continuation → session entry 写入与内存归约
- 输出去向：会话树条目、当前内存状态、后续 continuation、模式壳可见结果

## 六、测试契约

| 测试名 | 位置 | 验证内容 |
|--------|------|----------|
| `agent-session-concurrent` 相关测试 | `coding-agent/test/agent-session-concurrent.test.ts` | 验证并发场景下会话状态推进不失真 |
| reducer / harness 会话测试 | `agent/test/harness/reducer.test.ts` | 验证归约、压缩、继续执行等行为契约 |

## 七、总结

- 核心结论：Pi 真正的复杂度中心不在 loop，而在 `AgentSession` 这个共享会话状态机；它把 steering、follow-up、compaction、retry、abort 收进了统一会话内核。
- 可迁移点：多模式系统应尽量共享一个显式会话状态机，而不是让每个前端各自维护生命周期。
- 易错点：把 `AgentSession` 误解成消息容器，而忽略它其实承担了执行控制、恢复、压缩和持久化协同语义。
