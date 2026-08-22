# Reasonix WorkspaceLease 与 Permission 源码解析：副作用控制为什么要同时管理权限与工作区所有权

> 解析对象：`internal/permission/`、`internal/workspacelease/lease.go`、`internal/control/controller.go`
> 定位：Reasonix 第六份真正源码解析，验证“per-call policy + writer lease 持续到任务完成”这条副作用边界主线。
> 关联机制分析：`reasonix/07-Permission与WorkspaceLease：Reasonix 如何保护任务系统的副作用边界.md`

---

## 一、解析对象

- 文件名：`internal/permission/`、`internal/workspacelease/lease.go`、`internal/control/controller.go`
- 行数范围：permission 评估、reader/writer 租约、controller 中权限与租约集成主流程段
- 核心函数/方法：per-call policy 决策、writer lease 获取/保持/释放、controller 对副作用请求的阻塞与继续语义
- 入口事件/命令：任务准备执行副作用动作或进入写工作区阶段
- 出口事件/返回：allow/ask/blocked 决策、writer lease 持有状态、任务继续/暂停/终止

## 二、调用链

```text
Controller 推进任务
  → 遇到副作用动作先走 permission policy
  → 若只读则不拿 lease，继续执行
  → 若开始写工作区则获取 writer lease
  → writer lease 持续保留到任务完成 / 验证收尾
  → 期间 review / verify 读取同一工作区语义世界
  → 任务结束后释放 lease
```

## 三、状态转换

| 状态 | 进入条件 | 离开条件 | 关键行 |
|------|----------|----------|--------|
| 待授权 | 新副作用动作到达 | allow / ask / blocked | `internal/permission/` 评估段 |
| reader 模式 | 仅执行读/check/review | 转入写模式或任务结束 | lease reader/writer 区分段 |
| writer lease 持有中 | 首次工作区变更开始 | 任务完成或失败收尾 | `workspacelease/lease.go` writer 段 |
| blocked | permission 未通过或 lease 冲突 | 用户/系统解锁后重试 | controller 阻塞段 |
| released | 任务完成并释放写租约 | 下一任务重新竞争 | lease release 段 |

## 四、关键分支

| 分支 | 判断条件 | line | 结果 |
|------|----------|------|------|
| permission block | 当前动作未经授权 | `internal/permission/` 段 | 当前任务暂停或终止 |
| reader no lease | 动作只读 | `workspacelease/lease.go` reader 分支 | 不占有工作区所有权 |
| first write acquires lease | 第一次写工作区 | writer 分支 | 持有租约直到任务完成 |
| verify/review under same lease | 写任务未结束但进入验证/审查 | controller 集成段 | 验证看到同一语义工作区 |
| competing writer | 另一任务尝试写同一工作区 | lease 冲突段 | 拒绝并等待当前 writer 结束 |

## 五、数据流

- 输入来源：Controller 的任务推进、副作用动作类型、工作区标识、当前 lease 状态、permission policy
- 传递路径：permission 决策 → reader/writer 分类 → lease 获取/维持 → controller 后续验证与完成阶段
- 输出去向：任务是否允许继续、副作用是否可执行、工作区在整个任务期间的一致语义边界

## 六、测试契约

| 测试名 | 位置 | 验证内容 |
|--------|------|----------|
| permission 相关测试 | `internal/permission` 测试集 | 验证 per-call policy 与任务阻塞/继续语义 |
| workspace lease 相关测试 | `internal/workspacelease` 测试集 | 验证 reader/writer 区分、writer 持续租约与冲突处理 |

## 七、总结

- 核心结论：Reasonix 不只判断“能不能做”，还判断“在任务整个生命周期里，谁拥有这个工作区的修改权”。
- 可迁移点：有验证/回滚/长跑语义的 Agent，writer lease 应持续到任务完成，而不是只覆盖某一次写操作。
- 易错点：把 lease 做成瞬时文件锁；那样 review/verify 阶段看到的工作区可能已被别的任务改写，破坏任务语义一致性。
