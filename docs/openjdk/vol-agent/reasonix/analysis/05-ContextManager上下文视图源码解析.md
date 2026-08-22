# Reasonix ContextManager 源码解析：缓存前缀与变化尾部如何同时成立

> 解析对象：`internal/agent/context_manager.go`、`internal/agent/compact.go`、`internal/agent/context_usage.go`
> 定位：Reasonix 第五份真正源码解析，验证“固定前缀 + transient tail + 单次 compaction 事务”这条上下文主线。
> 关联机制分析：`reasonix/05-ContextManager与Checkpoint：Reasonix 如何在缓存与恢复之间保持长跑稳定.md`

---

## 一、解析对象

- 文件名：`internal/agent/context_manager.go`、`internal/agent/compact.go`、`internal/agent/context_usage.go`
- 行数范围：provider-visible context 构建、compact_ratio 触发、保护集保留与 usage 统计主流程段
- 核心函数/方法：ContextManager 维护 baseline / tail、压缩触发判断、单次摘要事务、上下文使用统计
- 入口事件/命令：新 turn 开始、上下文长度逼近预算、压缩后恢复执行
- 出口事件/返回：稳定的 provider-visible context、压缩后新摘要、继续运行所需的 transient tail

## 二、调用链

```text
session 启动
  → ContextManager 建立固定前缀 baseline
  → 每轮把新变化附加到 transient tail
  → context_usage 统计当前预算消耗
  → 达到 compact_ratio 阈值时进入 compact
  → 保留固定前缀与保护集，生成单次摘要事务
  → 用摘要 + 保留消息重建新的 provider-visible context
```

## 三、状态转换

| 状态 | 进入条件 | 离开条件 | 关键行 |
|------|----------|----------|--------|
| baseline 稳定 | session 建立固定前缀 | 出现新 turn 变化 | `context_manager.go` 初始化段 |
| tail 增长中 | 新消息/工具结果追加 | 达到 compact 阈值或 turn 结束 | context append 段 |
| compact pending | `compact_ratio` 触发 | compact 成功或失败 | `compact.go` 入口段 |
| compacting | 执行单次摘要事务 | 新 context 生成 | compact 主流程 |
| rebuilt context | 摘要 + 保护集重建完成 | 下一轮继续增长 tail | compact commit / rebuild 段 |

## 四、关键分支

| 分支 | 判断条件 | line | 结果 |
|------|----------|------|------|
| 固定前缀保护 | system prompt + 首用户 turn 属于 baseline | `context_manager.go` 基线段 | compaction 不压这部分 |
| 保护集保留 | 用户关键 turn、错误、工具协议组不可压 | `compact.go` protect set 段 | 保证压缩后仍有任务锚点 |
| 达到 compact_ratio | 使用率超过阈值 | `context_usage.go` / `compact.go` | 触发一次摘要事务 |
| 非无限压缩 | 已完成一次 compaction | compact 主流程 | 避免不断重写摘要造成漂移 |
| transient tail 注入 | 变化不应改写稳定前缀 | ContextManager 更新段 | 新信息只进变化层 |

## 五、数据流

- 输入来源：system prompt、首用户 turn、后续消息、工具结果、usage 统计、压缩摘要
- 传递路径：baseline + tail → usage 统计 → compact trigger → summary + protected set → rebuilt context
- 输出去向：provider-visible context、Goaleval 可依赖的有限证据视图、checkpoint 可对齐的消息边界

## 六、测试契约

| 测试名 | 位置 | 验证内容 |
|--------|------|----------|
| context / compact 相关测试 | `internal/agent` 测试集中 context/compact 用例 | 验证 prefix stability、compact threshold、保护集与摘要事务 |
| usage 相关测试 | `internal/agent/context_usage` 相关用例 | 验证预算统计与 compaction 触发边界 |

## 七、总结

- 核心结论：Reasonix 的 ContextManager 通过固定前缀和变化尾部分层，让 prefix cache 与长期上下文演进同时成立。
- 可迁移点：依赖前缀缓存的长跑 Agent，最好把稳定基线与会话内变化显式拆开，再让 compaction 只作用于变化层。
- 易错点：把 `compact_ratio` 当普通性能参数；实际上它定义了上下文何时进入一次正式的状态转换。
