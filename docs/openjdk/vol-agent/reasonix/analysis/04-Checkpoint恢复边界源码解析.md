# Reasonix Checkpoint 源码解析：恢复边界为什么必须同时覆盖文件与会话

> 解析对象：`internal/checkpoint/checkpoint.go`、`internal/checkpoint/transaction.go`
> 定位：Reasonix 第四份真正源码解析，验证“FileSnap + MsgIndex + prepare/commit 重验证 + 意图先持久化”这条恢复主线。
> 关联机制分析：`reasonix/05-ContextManager与Checkpoint：Reasonix 如何在缓存与恢复之间保持长跑稳定.md`

---

## 一、解析对象

- 文件名：`internal/checkpoint/checkpoint.go`、`internal/checkpoint/transaction.go`
- 行数范围：checkpoint 结构定义、prepare/commit 事务、文件发布与恢复边界主流程段
- 核心函数/方法：checkpoint 建立、prepare、commit、文件 publish、冲突重验证
- 入口事件/命令：一次可恢复的 turn / 事务边界形成，或用户请求回滚/恢复
- 出口事件/返回：可信 checkpoint、已发布文件状态、可恢复会话边界、或冲突拒绝

## 二、调用链

```text
一次 turn 达到稳定边界
  → 建立 checkpoint（会话 + 文件联合快照）
  → 需要恢复/回滚时进入 prepare
  → 检查 active writers / token / blob / conflicts
  → 通过后进入 commit
  → 再次重验证当前世界是否变化
  → 先持久化“可能已发布”意图
  → 执行 rename / publish
  → 持久化已发布进度与最终结果
```

## 三、状态转换

| 状态 | 进入条件 | 离开条件 | 关键行 |
|------|----------|----------|--------|
| checkpoint 已建立 | turn 达到可恢复边界 | prepare 或被新 revision 取代 | `checkpoint.go` 建立段 |
| prepare 中 | 用户/系统请求恢复事务 | 通过校验或失败 | `transaction.go` prepare 段 |
| ready to commit | prepare 通过 | commit 开始 | prepare 收尾段 |
| committing | commit 重验证完成 | publish 成功或冲突失败 | commit 主流程 |
| published-intent | 已落“可能已发布”意图 | 最终进度确认 | intent 先持久化段 |
| committed / rejected | 文件发布完成或冲突拒绝 | 后续恢复或结束 | commit 收尾段 |

## 四、关键分支

| 分支 | 判断条件 | line | 结果 |
|------|----------|------|------|
| checkpoint 过期 | session revision / mutation seq 已变化 | `checkpoint.go` / `transaction.go` 校验段 | 拒绝旧恢复计划 |
| active writer 冲突 | 存在新的写入者 | prepare / commit 校验段 | 终止本次回滚/恢复 |
| file conflict | FileSnap 指纹与当前文件不匹配 | conflict 检查段 | 拒绝提交 |
| world changed between prepare/commit | token / writers / plan 变化 | commit 重验证段 | preview 不再授权 commit |
| publish 后崩溃窗口 | rename 后未来得及记终态 | intent 先持久化段 | 恢复逻辑可补偿完成 |

## 五、数据流

- 输入来源：当前 session 状态、MsgIndex、FileSnap、workspace token、active writers、恢复请求
- 传递路径：checkpoint 快照 → prepare 校验 → commit 重验证 → publish → 进度持久化
- 输出去向：恢复边界、文件状态回滚/发布结果、后续 durable execution 可继续的安全起点

## 六、测试契约

| 测试名 | 位置 | 验证内容 |
|--------|------|----------|
| checkpoint / transaction 测试 | `internal/checkpoint` 测试集 | 验证 prepare/commit 双重校验、文件冲突、意图先持久化与恢复补偿 |
| recovery 相关测试 | `internal/recovery` 相关测试 | 验证 checkpoint 恢复后会话与文件边界一致 |

## 七、总结

- 核心结论：Reasonix 的 checkpoint 保存的不是单纯文件快照，而是文件状态、会话边界、版本与并发条件的联合恢复面。
- 可迁移点：preview 绝不能直接授权 commit；prepare 和 commit 之间必须承认世界已经变化。
- 易错点：只记录文件内容而忽略 MsgIndex / revision / mutation seq；那样恢复出来的会话与代码状态会失配。
