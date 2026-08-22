# Hermes VerificationEvidence 源码解析：验证证据为什么必须有界且不干扰主流程

> 解析对象：`agent/verification_evidence.py`
> 定位：Hermes 第四份真正源码解析，验证“有界证据账本 + fail-silent + 会话根聚合”这条验证留痕主线。
> 关联机制分析：`hermes/08-Verification与GoalJudge：Hermes 如何把完成判定做成独立审查系统.md`

---

## 一、解析对象

- 文件名：`agent/verification_evidence.py`
- 行数范围：`agent/verification_evidence.py:1-698`；重点是证据记录、摘要截断、过期清理、session-root 聚合主流程
- 核心函数/方法：`record_terminal_result`、`record_verify_run`、输出摘要裁剪、按 session root 聚合、过期与总量裁剪
- 入口事件/命令：一次 verify / gate / goal evidence 产生新的验证结果
- 出口事件/返回：有界证据事件、最近验证摘要、可供 GoalGate / GoalJudge 使用的审计痕迹

## 二、调用链

```text
verify runner / GoalGate 产生验证结果
  → verification_evidence 记录事件
  → 对超长输出做 summary 截断
  → 按 session root 聚合事件序列
  → 超年龄 / 超数量时清理旧证据
  → GoalGate / GoalJudge / 人类审计读取最近证据
```

## 三、状态转换

| 状态 | 进入条件 | 离开条件 | 关键行 |
|------|----------|----------|--------|
| 新证据 | 一次验证刚结束 | 写入账本或静默失败 | `verification_evidence.py` append 段 |
| 已截断摘要 | 输出超出摘要上限 | 入账完成 | summary 裁剪段 |
| 已聚合 | 事件挂到对应 session root | 被后续读取或清理 | session root 聚合段 |
| 已过期 | 超过年龄阈值 | 清理移除 | age cleanup 段 |
| 已溢出 | 超过 per-root 或 total 上限 | 旧事件被淘汰 | capacity cleanup 段 |

## 四、关键分支

| 分支 | 判断条件 | line | 结果 |
|------|----------|------|------|
| output summary 截断 | 输出超 `MAX_OUTPUT_SUMMARY_CHARS` | summary 段 | 只保留有界摘要 |
| 证据过期 | 超过 `MAX_EVIDENCE_AGE_DAYS` | cleanup 段 | 移除旧证据 |
| per-root 超限 | 单个 session root 事件过多 | capacity 段 | 淘汰最旧事件 |
| total 超限 | 全局事件数超 `MAX_TOTAL` | total cleanup 段 | 做全局有界裁剪 |
| fail-silent | 写账本过程本身失败 | error handling 段 | 不影响 CLI 主退出码 |

## 五、数据流

- 输入来源：verify runner 输出、GoalGate 失败证据、session root 标识、时间戳与摘要文本
- 传递路径：验证结果 → 摘要裁剪 → session root 聚合 → 过期/容量清理
- 输出去向：账本中的审计证据、GoalJudge 可读取的最近验证痕迹、人类排障所需的历史摘要

## 六、测试契约

| 测试名 | 位置 | 验证内容 |
|--------|------|----------|
| verification evidence 相关测试 | 闭环材料明确记录 `agent/verification_evidence.py:1-698` 的契约；具体测试文件名需按 Hermes 基线检索 | 验证摘要上限、年龄裁剪、容量裁剪与 fail-silent |
| verify / goals 相关集成测试 | `agent/verify/`、`hermes_cli/goals.py` 相关测试集 | 验证证据能被 GoalGate / GoalJudge 后续消费 |

## 七、总结

- 核心结论：Hermes 的证据账本不是无限留存系统，而是在不阻塞主流程的前提下，保留足够审计和判定所需的有界证据。
- 可迁移点：验证证据系统最好和主链路解耦，并明确年龄、容量、摘要三重边界。
- 易错点：把“保留所有证据”当目标；在长跑 Agent 里，更重要的是证据可读、可用、可控，而不是无限增长。
