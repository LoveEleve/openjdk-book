# Pi Compaction 源码解析：摘要、尾巴与工具协议如何一起保住上下文语义

> 解析对象：`agent/src/harness/compaction/compaction.ts`、`agent/src/harness/session/context.ts`
> 定位：Pi 第三份真正源码解析，验证“合法切点 + split turn 摘要 + retainedTail 持久化”这条压缩主线。
> 关联机制分析：`pi/07-Context与Compaction：Pi 如何构建并压缩模型可见上下文.md`

---

## 一、解析对象

- 文件名：`agent/src/harness/compaction/compaction.ts`、`agent/src/harness/session/context.ts`
- 行数范围：context 构建、token 估算、findCutPoint、summary/update summary、retainedTail 生成主流程段
- 核心函数/方法：上下文条目构建、`findCutPoint`、split turn 处理、compaction entry 写入
- 入口事件/命令：当前会话上下文逼近预算或显式触发压缩
- 出口事件/返回：compaction summary、retained tail、新的模型可见上下文视图

## 二、调用链

```text
会话即将超上下文预算
  → context.ts 先从 session entries 推导模型可见视图
  → compaction.ts 估算 token 并寻找合法 cut point
  → 若切在 turn 中间，则先摘要 split-turn 前缀
  → 生成 summary / update summary
  → 把 retainedTail 写入 compaction entry
  → 下次构建上下文时用 summary + tail + 新消息继续运行
```

## 三、状态转换

| 状态 | 进入条件 | 离开条件 | 关键行 |
|------|----------|----------|--------|
| 未压缩 | 上下文仍在预算内 | 触发 compaction | `context.ts` / compaction 入口段 |
| 找切点中 | token 预算逼近上限 | 找到合法切点或失败 | `findCutPoint` 段 |
| split-turn 摘要中 | 切点落在 turn 中间 | 生成前缀摘要 | split turn 分支 |
| summary 已生成 | 全量或增量摘要完成 | retainedTail 写入 | summary / update summary 段 |
| 已压缩 | compaction entry 持久化 | 下次继续运行或再次压缩 | compaction entry 收尾段 |

## 四、关键分支

| 分支 | 判断条件 | line | 结果 |
|------|----------|------|------|
| deferred assistant 过滤 | assistant stopReason 为 deferred | `context.ts` 过滤段 | 不进入模型上下文 |
| 非法切点拒绝 | 候选点会切断 tool call/result 语义 | `findCutPoint` 判断段 | 继续寻找下一个合法切点 |
| split turn | 切点落在一个 turn 中间 | compaction split-turn 段 | 单独摘要 turn 前缀 |
| 增量摘要 | 已有旧 summary 再次压缩 | update summary 段 | 在旧摘要上演进，而非全量重写 |
| 文件元数据提取 | 工具调用含 read/write/edit 文件信息 | compaction metadata 段 | 写入 `<read-files>` / `<modified-files>` 等元数据 |

## 五、数据流

- 输入来源：session entries、旧 compaction summary、工具调用与文件操作元数据、token 预算
- 传递路径：entries → context view → cut point → summary/update summary → retainedTail 嵌入 compaction entry
- 输出去向：新的模型上下文视图、持久化 compaction entry、下轮继续执行所需的摘要与尾巴

## 六、测试契约

| 测试名 | 位置 | 验证内容 |
|--------|------|----------|
| compaction 序列化测试 | `tests/compaction-serialization.test.ts` | 验证摘要结构、序列化与多轮 compaction 一致性 |
| harness/session 相关测试 | `agent` 测试集中 context / compaction 相关用例 | 验证合法切点、tool result 配对、retainedTail 与 split-turn 语义 |

## 七、总结

- 核心结论：Pi 的 compaction 不是删历史，而是通过合法切点、turn 前缀摘要和 retainedTail 持久化，重建一个还能继续推理的上下文视图。
- 可迁移点：压缩时必须保护工具协议配对关系，并让摘要成为可持续演进的任务状态，而不是一次性文本。
- 易错点：把 `toolResult` 当成普通消息独立切开；这会让压缩后的模型上下文看到半截协议，导致后续推理失真。
