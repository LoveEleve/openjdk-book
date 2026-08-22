# Hermes DeliveryLedger 源码解析：最终响应为什么能在崩溃后继续送达

> 解析对象：`gateway/delivery_ledger.py`
> 定位：Hermes 第二份真正源码解析，验证“pending / attempting / delivered / failed + sweep_recoverable”这条交付主线。
> 关联机制分析：`hermes/07-DeliveryLedger与LifecycleLedger：Hermes 如何把交付和生命周期做成可追责的持久层.md`

---

## 一、解析对象

- 文件名：`gateway/delivery_ledger.py`
- 行数范围：record obligation、mark attempting、mark delivered/failed、sweep recovery 主流程段
- 核心函数/方法：`record_obligation`、`mark_attempting`、`mark_delivered`、`mark_failed`、`sweep_recoverable`
- 入口事件/命令：最终响应已生成，准备向平台发送
- 出口事件/返回：交付账本状态推进、恢复重投候选、确定性终态记录

## 二、调用链

```text
最终响应生成
  → record_obligation(pending)
  → 平台发送前 mark_attempting
  → 发送成功则 mark_delivered
  → 发送失败则 mark_failed
  → 进程崩溃后下次启动 sweep_recoverable
  → 认领 pending / attempting / failed 的可恢复行并重投
```

## 三、状态转换

| 状态 | 进入条件 | 离开条件 | 关键行 |
|------|----------|----------|--------|
| pending | 已有发送义务但未开始发送 | mark_attempting / sweep | `delivery_ledger.py` obligation 段 |
| attempting | 发送已开始但未确认终态 | mark_delivered / mark_failed / crash | attempting 段 |
| delivered | 平台确认送达 | 保留期后清理 | delivered 段 |
| failed | 确定性发送失败 | 下次恢复边界重试 | failed 段 |
| recoverable | 重启后账本扫描命中 | 被当前生命认领并重投 | `sweep_recoverable` 段 |

## 四、关键分支

| 分支 | 判断条件 | line | 结果 |
|------|----------|------|------|
| pending 崩溃 | 发送从未开始 | `sweep_recoverable` pending 分支 | 直接重投，无重复风险 |
| attempting 崩溃 | 可能已发送但未确认 | attempting 恢复分支 | 带可见标记重投 |
| failed 重启 | 上一生命确定性失败 | failed 恢复分支 | 重启作为自然重试边界 |
| 平台不可达 | 本 boot 平台不可用 | deliverable platforms 过滤段 | 不消耗 attempts 预算 |
| attempts 超限 | 真实发送次数用尽 | retry 预算分支 | 停止继续重投 |

## 五、数据流

- 输入来源：最终响应文本、目标平台、当前发送尝试结果、重启后的账本扫描结果
- 传递路径：发送义务写入 → 尝试状态推进 → 终态落账 → 重启后 sweep 恢复
- 输出去向：平台最终交付、账本中的可审计终态、恢复流程的候选重投项

## 六、测试契约

| 测试名 | 位置 | 验证内容 |
|--------|------|----------|
| delivery ledger 相关测试 | Hermes 项目中 `gateway/delivery_ledger.py` 测试集 | 验证四态状态机、崩溃恢复、attempts 预算与可恢复扫描 |
| gateway 恢复相关测试 | gateway / watchdog 相关测试 | 验证重启后未完成交付的认领与重投 |

## 七、总结

- 核心结论：DeliveryLedger 真正在定义“已交付”的语义边界，而不是简单记录发过什么。
- 可迁移点：在崩溃窗口敏感的 Agent 里，应先落发送义务，再做真实发送，再记录终态。
- 易错点：把 `attempting` 和 `pending` 视为相同未完成状态；实际上两者的重复发送风险和恢复策略完全不同。
