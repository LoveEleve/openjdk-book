# Permission 与 Approval：OpenCode 如何约束 Agent 的副作用边界

> 项目：OpenCode (`v1.18.18` 基线)
> 角色：主线机制正文 05
> 对应范围规划：`01-OpenCode源码学习范围规划.md`
> 依据材料：`Agent/analysis/opencode/01-闭环笔记/q7-permission.md`

---

## 零、阅读前提示

- 建议先读：
  1. `00-OpenCode主线总图.md`
  2. `03-SessionRunner与SessionExecution...`
  3. `04-ToolRegistry与Tool Settlement...`
- 如果你对 approval / sandbox / capability grant 完全没概念，先读：`../03-Agent源码前置认知桥.md`
- 推荐源码阅读路径：
  1. `packages/core/src/permission.ts`
  2. `packages/core/src/permission/saved.ts`
  3. `packages/schema/src/permission.ts`
  4. `packages/core/test/permission.test.ts`
  5. `packages/opencode/src/permission/`（只作为 V1 / 外层适配参考）

## 一、这一章真正的问题

OpenCode 不是一个只会读代码的工具，它可以：
- 读文件
- 跑命令
- 改文件
- 装插件
- 连外部服务

这就意味着，它不是“要不要有权限系统”的问题，而是：

> **如果没有一套稳定的权限与审批控制面，整个 Agent runtime 根本不可能安全落地。**

所以这章真正要回答的问题是：

1. OpenCode 为什么不把 permission 当成外围功能？
2. `ask` 和 `assert` 为什么要分开？
3. 为什么 `deny` 必须永远赢？
4. 一次批准为什么可能影响同 session 的其他 pending 请求？
5. 为什么这里是“授权层”，而不是“真正的沙箱隔离层”？

---

## 二、先给结论：PermissionV2 不是弹窗逻辑，而是 Agent 控制面的执行边界

很多人看到权限系统，第一反应是：
- 不就是用户点一下 allow / deny 吗？

如果这样理解 OpenCode，会把整个控制面看浅。

PermissionV2 真正解决的是：

- 模型想做的事，哪些可以直接做？
- 哪些要问用户？
- 哪些必须禁止？
- 一次批准能不能跨 session 复用？
- 用户拒绝后，正在等待的同类请求怎么办？
- 没有 agent / 没有配置的时候，默认是开放还是收紧？

所以它的本质不是“弹个框”，而是：

> **把副作用能力从“执行细节”提升成“受规则、状态和持久化共同约束的控制面”。**

---

## 三、规则模型：为什么是 action / resource / effect

OpenCode 的权限模型不是“给某个工具开权限”这么简单。

它把规则定义成：
- `action`
- `resource`
- `effect: allow | deny | ask`

这很关键，因为它回答的是：

### 1. 为什么权限不能只按工具名判断？
因为真正危险的不是：
- 是不是 `bash`
而是：
- `bash` 想对什么资源做什么事情

所以权限模型必须是：
> **动作 × 资源**

而不是“工具名白名单”。

### 2. 为什么 effect 里要有 ask？
因为不是所有事情都该：
- 永远允许
- 永远禁止

有一类事情是：
- 本次需要人工决定
- 但并不应该永久放行或永久禁止

这就是 `ask` 的意义。

### 3. 为什么要用 wildcard / findLast
因为权限规则天然需要：
- 通配资源
- 局部覆盖
- 最后写入优先

这说明 OpenCode 的权限系统不是 ad-hoc if/else，
而是有明确规则模型的。

---

## 四、三来源评估管线：为什么 deny 必须永远赢

OpenCode 的权限评估，不只看一份规则，而是要组合：

1. 当前 agent 配置规则
2. saved approvals（持久化批准）
3. 当前输入附带的上下文约束

这时最核心的问题不是“怎么合并”，而是：

> **冲突时谁优先？**

OpenCode 的答案非常明确：
- `deny` 永远优先
- saved allow 不能覆盖 configured deny
- 没有 agent / 没有主默认 agent 时，默认 deny

这其实体现的是一条非常成熟的安全默认值：

> **宁可少放，不可错放。**

这条规则的重要性在于，它防止系统进入一种特别危险的状态：
- 某次历史批准
- 意外盖过了当前更严格的配置

如果那样，系统会逐渐变成“用户以为有边界，实际上边界被稀释”。

OpenCode 明确避免了这一点。

---

## 五、ask vs assert：为什么要分“预检”和“强制等待”

这是 PermissionV2 里特别值钱的设计。

很多系统只会做一种事：
- 需要权限 → 直接等待用户批准

OpenCode 没这么简单，它区分了：

### `ask`
- 做评估
- 如果结果是 ask，就把请求放入 pending
- 但**不等待**
- 调用方自己决定后续怎么处理

### `assert`
- 做评估
- allow → 直接过
- deny → 抛阻塞错误
- ask → 进入等待，并直到用户做出回复

这说明 OpenCode 在这里不是只做权限判断，而是在做：

> **执行语义设计**

因为有些场景要：
- 先问一下，调用方自己决定是否继续

而另一些场景必须：
- 没拿到权限就不能往下走

如果不分这两层，Agent runtime 很容易出现：
- 本该继续的地方被无谓卡住
- 本该阻塞的地方偷偷绕过去

所以 `ask / assert` 的区分，实际上是在回答：
> **权限是建议、阻塞、还是协议硬门？**

---

## 六、Deferred 异步等待：为什么批准不是立即返回，而是会话内待决状态

当 `assert()` 遇到 `ask` 时，OpenCode 不会立刻得到结果，
而是：
- 创建一个 pending permission
- 发出 Asked 事件
- 等待 Deferred resolve

这件事的本质是：

> **用户批准不是函数返回值，而是会话状态的一部分。**

这点很关键，因为它把 approval 从“UI 交互行为”提升成了：
- durable 的待决状态
- 会话控制面的一个节点

这也是为什么：
- list / get / forSession 都能看到 pending permissions
- reply 不是简单 callback，而是状态转换

所以批准流程在 OpenCode 里，不是：
- 运行时顺手弹个框

而是：
> **Agent 会话图的一部分。**

---

## 七、reject / once / always：为什么一次回复会影响整个 session

这是 PermissionV2 最值得学的一点之一。

OpenCode 对用户回复不是只支持：
- allow
- deny

而是支持：
- `reject`
- `once`
- `always`

而且这些回复不只是作用在“当前这一个请求”，还会有级联语义。

### reject
- 当前请求拒绝
- 同 session 相关 pending 一并拒绝

### once
- 只放行当前这个

### always
- 持久化成 saved approval
- 同 session 下其他匹配 pending 可以自动过

这说明 OpenCode 在设计时已经意识到：

> **权限不是一个点操作，而是会影响会话后续行为的控制面事件。**

这和我们前面在 EventV2 / SessionRunner 里看到的思想是一致的：
- 系统不只是执行一次动作
- 它会持续运行
- 所以一次决策必须能改变后续状态

---

## 八、saved approvals：为什么批准会被持久化

OpenCode 还有一个很重要的工程判断：

有些权限决定，不应该每次都重新问。

所以它会把 `always` 批准持久化到 permission 表里。

但它仍然保留两条护栏：

1. 只保存 project 级范围
2. configured deny 永远优先于 saved allow

这说明它不是在追求“越方便越好”，而是在追求：

> **在可复用和安全默认值之间，做受约束的复用。**

所以 saved approvals 的价值不是简单“记住用户点击”，
而是：
- 降低重复交互成本
- 但不放弃中心化策略约束

这就是产品级权限系统和简单 prompt 弹窗的差别。

---

## 九、为什么这里没有真正的沙箱隔离层

这一点必须说清楚，否则很容易误读。

OpenCode 在这里做的是：
- 权限 / 审批 / 规则控制
- 也就是 **authorization layer**

它并没有在这一层真正实现：
- 操作系统级隔离
- 强制资源限制
- 完整 syscall / 文件系统沙箱

这意味着：

> **PermissionV2 解决的是“允不允许做”，不是“即使允许做，也只能做到多大程度”。**

所以它很重要，但它不是完整 sandbox。

这一点必须讲清楚，否则读者会高估这套系统的安全边界。

---

## 十、这一章真正解决了哪些工程问题？

### 1. 如何把副作用能力从“函数细节”提升成“控制面决策”
OpenCode 的解法：action / resource / effect 规则模型

### 2. 如何让权限判断适应不同执行语义
OpenCode 的解法：`ask` / `assert` 双 API

### 3. 如何把用户批准纳入会话状态而不是临时 UI 行为
OpenCode 的解法：Deferred + pending permission + Event.Asked

### 4. 如何在可复用和安全默认值之间做平衡
OpenCode 的解法：saved approvals + configured deny 优先

### 5. 如何让同 session 中多个相关权限请求保持一致语义
OpenCode 的解法：reject / always 的级联处理

这一章最值得学的，不是“权限怎么写 if/else”，而是：

> **一个产品级 Agent，要怎么把副作用能力纳入统一的运行控制面。**

---

## 十一、读者最容易学错的地方

### 误区 1：把 permission 看成弹窗逻辑
错。它是执行控制面的组成部分。

### 误区 2：把 ask 和 assert 看成两个名字不同的同一函数
错。它们代表预检和强制等待两种完全不同的执行语义。

### 误区 3：把 saved approval 当成“记住我的选择”
错。它是 project 级权限记忆，但仍受 configured deny 约束。

### 误区 4：把 approval 当成 UI 交互
错。它是会话状态里的 pending → resolved 转换。

### 误区 5：把 PermissionV2 当完整 sandbox
错。它是授权层，不是系统级隔离层。

---

## 十二、分析边界

### 为什么这里不先看具体 leaf tool 权限调用点
因为这一章关注的是权限控制面，不是某个工具怎样请求权限。

### 为什么这里不先展开 V1 permission 模型
因为第一轮分析目标是当前主线机制；V1 只作为兼容/历史参考。

### 为什么测试是主证据之一
ask/assert、saved approval、deny 优先、级联语义这些，都要靠测试才能真正看清楚边界，不看测试很容易看浅。

---

## 十三、读者分层路由

### beginner
先抓住：
1. permission 不是弹窗，是控制面
2. `ask` 和 `assert` 是两种不同的执行语义
3. `deny` 永远优先是一条核心安全原则

### intermediate
重点看：
- 三来源评估管线
- saved approvals
- pending + Deferred
- reply 的级联语义

### advanced
重点看：
- permission 如何和 tool settlement / session runner / approval lifecycle 咬合
- 为什么 OpenCode 有授权层，但没有完整隔离层
- 这种设计在真实产品里意味着什么边界

---

## 十四、迁移清单

### 可迁移思想 1：权限 = 动作 × 资源 × effect
- 可迁移到：任何需要细粒度副作用控制的 Agent 系统
- 前提：系统能区分动作语义与资源语义
- 不能照搬的点：极简玩具 Agent 没有复杂资源模型时会过重

### 可迁移思想 2：ask / assert 分离
- 可迁移到：既需要预检也需要强阻塞的系统
- 前提：权限结果会影响执行控制流
- 不能照搬的点：没有继续/暂停语义的系统不一定需要分开

### 可迁移思想 3：批准作为会话状态，而不是 UI 返回值
- 可迁移到：持续运行、多轮等待用户确认的 Agent 系统
- 前提：系统有 pending / resume 语义
- 不能照搬的点：一次性同步工具系统可能没必要

### 可迁移思想 4：saved allow 不得覆盖 configured deny
- 可迁移到：所有严肃的副作用控制面
- 前提：存在静态策略与历史批准并存的场景
- 不能照搬的点：如果系统没有“中心策略”层，这条规则就没落点

---

## 十五、自测问题

1. 为什么 OpenCode 要把 permission 做成规则系统，而不是简单 if/else？
2. 为什么 `ask` 和 `assert` 必须分开？
3. 为什么批准在 OpenCode 里是 pending 状态，而不是立即回调？
4. 为什么 `deny` 永远优先于 saved allow？
5. 为什么 PermissionV2 很重要，但仍然不能被误认为完整沙箱？

---

## 十六、读完这一章，读者应该获得什么能力？

至少应该能做到：

1. 解释为什么 PermissionV2 是 OpenCode 运行控制面的组成部分。
2. 说清 `ask` / `assert`、`reject` / `once` / `always` 的语义差别。
3. 理解 saved approvals 为什么存在，以及它为什么不能覆盖 configured deny。
4. 理解用户批准为什么会影响整个 session，而不只是单次操作。
5. 用自己的话说明：为什么一个产品级 Agent，不能把副作用边界交给 leaf tool 自己随意处理。

如果还做不到这些，就说明这章还没真正学懂。
