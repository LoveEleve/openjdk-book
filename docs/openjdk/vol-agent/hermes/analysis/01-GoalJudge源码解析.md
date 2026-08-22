# Hermes GoalJudge 源码解析：完成判定为什么必须独立于执行器

> 解析对象：`hermes_cli/goals.py`
> 定位：Hermes 第一卷第一份真正源码解析，验证“GoalGate + GoalJudge + 有界 fail-open”这条验收主线。
> 关联机制分析：`hermes/08-Verification与GoalJudge：Hermes 如何把完成判定做成独立审查系统.md`

---

## 一、解析对象

- 文件名：`hermes_cli/goals.py`
- 行数范围：GoalGate / GoalJudge 主流程所在段
- 核心函数/方法：`GoalGate`、`judge_goal`、judge 结果解析与暂停计数逻辑
- 入口事件/命令：执行器准备宣布完成，或在验证结果后请求独立判定
- 出口事件/返回：`done` / `continue` / `wait` / `skipped` verdict，或触发自动暂停

## 二、调用链

```text
执行器准备收尾
  → GoalGate 先跑确定性验证
  → 验证失败则把证据回注给执行器
  → 验证通过后调用 GoalJudge
  → auxiliary 模型基于 goal / response / contract / subgoals 判定
  → 返回 verdict（done / continue / wait / skipped）
  → 连续 parse/transport 失败时触发自动暂停
```

## 三、状态转换

| 状态 | 进入条件 | 离开条件 | 关键行 |
|------|----------|----------|--------|
| 待验证 | 执行器认为可能完成 | GoalGate 通过或失败 | `goals.py` gate 主流程 |
| 验证失败 | shell gate 未通过 | 证据回注后继续执行 | gate 失败分支 |
| 待判定 | gate 通过 | GoalJudge 返回 verdict | `judge_goal` 调用段 |
| wait | judge 认为应等待后台进程或外部条件 | wait 秒数到期或人工恢复 | wait verdict 分支 |
| done | judge 判定满足 contract / goal | 任务正式结束 | done verdict 分支 |
| auto-paused | parse / transport 连续失败超阈值 | 人工恢复 | 自动暂停分支 |

## 四、关键分支

| 分支 | 判断条件 | line | 结果 |
|------|----------|------|------|
| gate 失败 | 验证命令未通过 | `goals.py` GoalGate 段 | 不允许宣布完成，回注失败证据 |
| gate 命中指纹缓存 | 工作区未变化且失败已知 | `goals.py` gate 指纹段 | 直接重放失败，避免无效重跑 |
| judge 返回 done | contract / goal 满足 | `goals.py` verdict 分支 | 结束任务 |
| judge 返回 wait | 需等待后台进程或条件成熟 | `goals.py` verdict 分支 | 停泊等待 |
| parse/transport 连续失败 | 达到各自阈值 | `goals.py` 自动暂停段 | 自动暂停任务 |

## 五、数据流

- 输入来源：goal、last response、verification evidence、contract、subgoals、background processes
- 传递路径：GoalGate 验证 → 失败证据或 judge payload → auxiliary judge 调用 → verdict 解析
- 输出去向：执行器继续/停止决策、自动暂停计数器、任务生命周期状态

## 六、测试契约

| 测试名 | 位置 | 验证内容 |
|--------|------|----------|
| Goal / verification 相关测试 | `hermes` 项目中 `goals.py` 与 verify 相关测试集 | 验证 gate 先于判定、四态 verdict、失败分轴与自动暂停 |
| verification evidence 相关测试 | `agent/verification_evidence.py` 相关测试 | 验证证据账本有界与 fail-silent |

## 七、总结

- 核心结论：Hermes 先用 GoalGate 过滤，再用独立的 GoalJudge 做最终判定，拒绝让执行器自己宣布完成。
- 可迁移点：验收型 Agent 适合“门先于判定 + 独立审查器 + 有界 fail-open”的三段式结构。
- 易错点：把 GoalJudge 看成普通后处理；实际上它与 GoalGate、自动暂停计数一起构成了完成语义本身。
