# dsh Projection 五元契约源码解析：事件源如何被投影成可消费状态

> 解析对象：`session/projection`
> 定位：dsh 第七份真正源码解析，验证“projection 五元契约 + 快照水印 + 非权威检查点”这条投影主线。
> 关联机制分析：`dsh/07-高价值专题清单.md`

---

## 一、解析对象

- 文件名：`session/projection`
- 行数范围：projection 定义、事件消费、快照/水印、恢复与继续订阅主流程段
- 核心函数/方法：projection 注册、事件应用、snapshot checkpoint、水印推进、恢复后继续追平
- 入口事件/命令：session/event append、持久化历史重放、projection 快照保存/恢复
- 出口事件/返回：可消费状态视图、快照水印、恢复后继续推进的 projection 状态

## 二、调用链

```text
Session 事件产生
  → projection 订阅 session/event
  → 按五元契约把事件应用到投影状态
  → 周期性生成 snapshot + watermark
  → 重启后先恢复 snapshot
  → 再从 watermark 之后继续追平剩余事件
```

## 三、状态转换

| 状态 | 进入条件 | 离开条件 | 关键行 |
|------|----------|----------|--------|
| 未投影 | projection 刚注册 | 首个事件到达 | projection init 段 |
| 应用中 | 新事件到达 | 状态更新并推进 watermark | apply 段 |
| 已快照 | 达到 checkpoint/snapshot 条件 | 新事件继续到来 | snapshot 段 |
| 恢复中 | 进程重启或重建 projection | snapshot 加载并追平剩余事件 | restore/replay 段 |
| 已追平 | watermark 到达当前事件尾部 | 等待新事件 | catch-up 收尾段 |

## 四、关键分支

| 分支 | 判断条件 | line | 结果 |
|------|----------|------|------|
| snapshot 保存 | 当前状态值得检查点化 | snapshot 段 | 生成非权威快照，减少重放成本 |
| watermark 推进 | 事件已成功应用 | watermark 段 | 记录投影已消费到哪里 |
| 非权威 checkpoint | snapshot 落后于最新事件 | restore 段 | 依靠水印后续追平，不把快照当真相 |
| full replay | 没有可用 snapshot | replay 段 | 从事件源全量重建 |
| incremental catch-up | 有 snapshot 但未追平 | catch-up 段 | 只消费 watermark 之后事件 |

## 五、数据流

- 输入来源：session/event 历史与增量流、已有 snapshot、水印位置
- 传递路径：事件源 → projection apply → snapshot/watermark → 恢复后 replay/catch-up
- 输出去向：用户可消费状态视图、缓存状态、恢复加速所需的投影检查点

## 六、测试契约

| 测试名 | 位置 | 验证内容 |
|--------|------|----------|
| projection 相关测试 | `session/projection` 测试集 | 验证 apply、snapshot、水印推进与恢复追平 |
| session 集成测试 | session/持久化/投影集成用例 | 验证 projection 不改变事件真相，只消费并派生状态 |

## 七、总结

- 核心结论：dsh 的 projection 不是第二真相层，而是基于事件源生成的派生视图；snapshot 只是加速恢复的非权威检查点。
- 可迁移点：事件源系统里，projection 应坚持“事件是真相，snapshot 是缓存”，并用 watermark 明确消费边界。
- 易错点：把 projection checkpoint 当权威状态；那会让系统在快照落后或损坏时失去从事件源重新恢复的能力。
