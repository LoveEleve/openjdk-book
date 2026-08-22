# OpenCode Permission 源码解析：副作用请求为什么要变成会话内待决状态

> 解析对象：`packages/core/src/permission.ts`、`packages/core/src/permission/saved.ts`、`packages/schema/src/permission.ts`
> 定位：OpenCode 第五份真正源码解析，验证“ask/assert + pending deferred + saved approvals + deny wins”这条权限主线。
> 关联机制分析：`opencode/06-Permission与Approval：OpenCode 如何约束 Agent 的副作用边界.md`

---

## 一、解析对象

- 文件名：`packages/core/src/permission.ts`、`packages/core/src/permission/saved.ts`、`packages/schema/src/permission.ts`
- 行数范围：规则匹配、`ask` / `assert`、pending permission、reply、saved approval 持久化主流程段
- 核心函数/方法：权限评估、规则合并、pending 请求创建、用户回复处理、saved approval 查询/写入
- 入口事件/命令：工具或动作即将触发副作用能力
- 出口事件/返回：allow / deny / ask、会话内待决 permission、或保存后的 project 级 approval

## 二、调用链

```text
模型或工具准备触发副作用
  → PermissionV2 按 action × resource 评估规则
  → 合并 agent 规则 + saved approvals + 当前输入约束
  → ask() 仅登记 pending 或返回结果
  → assert() 在 ask 时进入 Deferred 等待
  → 用户 reply(reject / once / always)
  → 当前请求继续/失败，并级联影响同 session 其他 pending
```

## 三、状态转换

| 状态 | 进入条件 | 离开条件 | 关键行 |
|------|----------|----------|--------|
| 待评估 | 新副作用请求到达 | 得到 allow / deny / ask | `permission.ts` 评估段 |
| ask-pending | 评估结果为 ask | 用户 reply 或被级联处理 | pending permission 段 |
| allowed once | 用户选择 once | 当前请求执行完毕 | reply 处理段 |
| allowed always | 用户选择 always | 写入 saved approval 并继续 | `saved.ts` 持久化段 |
| rejected | 用户 reject 或规则 deny | 请求终止 | deny / reject 分支 |
| cascaded | 同 session 有匹配 pending 被一次回复影响 | 所有相关 pending 收敛 | reply 级联段 |

## 四、关键分支

| 分支 | 判断条件 | line | 结果 |
|------|----------|------|------|
| configured deny | agent/input 规则命中 deny | `permission.ts` 合并段 | 直接拒绝，saved allow 不得覆盖 |
| ask vs assert | 调用方选择预检还是强制门 | `permission.ts` ask/assert 段 | ask 不等待，assert 阻塞等待回复 |
| once | 用户仅放行当前请求 | reply 段 | 只解锁当前 pending |
| always | 用户批准持久化 | `saved.ts` 段 | 写入 project 级 approval，并可解锁同类 pending |
| reject cascade | 用户拒绝当前请求 | reply 级联段 | 同 session 相关 pending 一并拒绝 |

## 五、数据流

- 输入来源：action、resource、agent 配置规则、saved approvals、当前 session/input 约束、用户回复
- 传递路径：规则匹配 → effect 决策 → pending/deferred → reply → saved approval 可选持久化
- 输出去向：当前副作用是否继续、session 内 pending permission 状态、project 级长期批准记录

## 六、测试契约

| 测试名 | 位置 | 验证内容 |
|--------|------|----------|
| permission 测试 | `packages/core/test/permission.test.ts` | 验证 action/resource 匹配、deny 优先、ask/assert 区分、reply 语义 |
| saved approvals 相关测试 | `packages/core/test` 中 permission/saved 用例 | 验证 always 持久化、project 级范围与 deny 不可被覆盖 |

## 七、总结

- 核心结论：OpenCode 的权限系统不是弹窗逻辑，而是把副作用请求做成会话内可等待、可持久化、可级联的控制面状态。
- 可迁移点：长跑 Agent 里，approval 最好成为 durable pending state，而不是一次同步回调结果。
- 易错点：把 saved allow 当最高优先级；真正安全的系统必须保持 configured deny 永远赢。
