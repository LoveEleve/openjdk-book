# AgentSessionRuntime 与 Modes：Pi 如何让多种前端共用一个运行时内核

> 项目：Pi（main 基线）
> 角色：主线机制正文 03
> 对应范围规划：`01-Pi源码学习范围规划.md`
> 依据材料：
> - `Agent/analysis/pi/00-域发现/00-pi-域发现.md`
> - `Agent/analysis/pi/01-闭环笔记/pass2-q1-agent-session.md`

---

## 零、阅读前提示

- 建议先读：
  1. `01-Pi源码学习范围规划.md`
  2. `02-AgentLoop：Pi 的执行骨架如何组织 turn、tools 与 continuation.md`
  3. `03-AgentSession状态机：Pi 为什么把复杂控制流收进会话系统.md`
- 推荐源码阅读路径：
  1. `coding-agent/src/core/agent-session-runtime.ts`
  2. `coding-agent/src/core/services.ts`
  3. `coding-agent/src/modes/interactive/interactive-mode.ts`
  4. `coding-agent/src/modes/print-mode.ts`
  5. `coding-agent/src/modes/rpc/`

## 一、这一章真正的问题

前两篇已经说明：
- Pi 的 loop 不是普通循环
- AgentSession 是它的复杂度中心

但还有一个关键问题没回答：

> **为什么 Pi 可以同时支持 interactive / print / rpc 三种形态，而不让每种前端各写一套执行逻辑？**

换句话说，这一章真正要回答的是：

1. AgentSessionRuntime 到底在抽象什么？
2. 为什么它不是“多一个包装层”，而是多形态复用的运行时内核？
3. interactive、print、rpc 各自持有什么，又明确不持有什么？
4. 为什么这种分层对 Agent 产品很重要？

---

## 二、先给结论：Pi 的核心不是模式很多，而是“模式不拥有执行语义”

最容易学错的一点是：
- interactive-mode 很大
- rpc-mode 也有很多协议代码
- print-mode 也有自己的输出逻辑

于是自然会觉得：
> 每种模式都有一套自己的 Agent 逻辑

这是不对的。

更准确的结论是：

> **Pi 刻意让各模式只拥有自己的 I/O / 协议外壳，而真正的执行语义、会话状态、服务绑定和事件桥接都被收进同一个 `AgentSessionRuntime`。**

也就是说：
- 模式很多
- 但内核尽量只有一个

这和我们前面在：
- Reasonix 的单控制器
- OpenCode 的 session runtime + facade
中看到的思想是一致的，只是 Pi 更强调：
> **多形态共享一个运行时内核。**

---

## 三、为什么 AgentSessionRuntime 不是普通容器，而是内核边界

如果只是个普通容器，它最多帮你把：
- session
- services
- cwd
这些东西绑在一起。

但 Pi 这里真正值钱的是：

> **它把“执行状态”和“前端形态”之间的边界明确切开了。**

根据既有域发现：
- interactive-mode.ts:392
- print-mode.ts:33
- rpc-mode.ts:54
都注入了 `runtimeHost`

这说明：
- 不同模式不是各自 new 自己的一套 runtime
- 而是围绕同一个 runtimeHost / AgentSessionRuntime 运行

所以它真正抽象的是：

### 1. 一个 session 的执行骨架
- agent loop
- session state
- context / compaction
- tool lifecycle

### 2. 一个 session 依赖的 services
- storage
- tools
- skills
- settings
- resource loaders

### 3. 一个会话对外暴露的事件和绑定点
- 扩展事件桥
- runtime 诊断
- mode-specific rendering

这就是为什么它比一个普通容器更接近：
> **会话运行时内核边界。**

---

## 四、为什么 interactive / print / rpc 必须共享同一运行时内核

这是 Pi 最值得学的一条主线之一。

### 如果不共享会怎样？
那么每种模式都得各自重做：
- loop 驱动
- 会话状态推进
- tool settlement
- compaction 触发
- steering / follow-up / retry
- 历史恢复

最后会出现：
- interactive 一套语义
- print 一套语义
- rpc 又一套语义

这和 Reasonix 不想让 TUI / HTTP / desktop 各自带状态，是同一个问题。

### Pi 的回答
它把运行时统一出来，让模式只负责：
- 输入怎么来
- 输出怎么展示
- 协议怎么编码

而不是负责：
- 会话怎么推进
- 工具怎么结算
- 历史怎么压缩
- 何时该继续跑

所以这条设计可以总结为：
> **模式只是壳，运行时才是语义核心。**

---

## 五、Interactive / Print / RPC 的真正区别，不在逻辑，而在外化方式

Pi 这里如果只看文件体量，很容易被 `interactive-mode.ts` 吓到。

但正确的看法不是：
- interactive 最复杂，所以它是主线

而是：
- interactive 只是 I/O 形态最丰富
- 但不是执行语义的唯一来源

### interactive mode
- 负责 TUI 交互、流式展示、工具执行追踪、thinking 可见性、skill 命令等
- 它“看起来最像产品”

### print mode
- 非交互输出模式
- 更适合脚本 / 批处理 / 只要结果不需要交互控制的场景

### rpc mode
- 把内核外化成 headless JSON stdin/stdout 协议
- 适合作为远程控制 / 其他宿主集成边界

所以三者的真正差别是：
> **外化方式不同，不是内核逻辑不同。**

这非常重要，因为很多系统会把“前端复杂度”误当“产品架构复杂度”。
Pi 在这里给出的更成熟答案是：
- 视觉层、协议层可以很复杂
- 但执行内核必须尽量共享

---

## 六、为什么 runtime diagnostics 值得被单独提出来

`AgentSessionRuntime` 附近还有一个很容易被忽略但非常成熟的设计：
- 运行时诊断（runtime diagnostics）

这说明 Pi 在创建运行时时，除了构造核心对象，还在做一件很产品级的事：

> **在真正开跑前，先看看这个运行时有没有潜在问题。**

这和很多系统只是：
- 失败了再报错
不同。

runtime diagnostics 的意义是：
- 先发现不致命但危险的问题
- 决定要不要在 UI 层提示
- 让模式层可以做更好的交互引导

这非常值得学，因为它意味着：
- runtime 初始化不是黑箱
- 它也会生成可解释状态

---

## 七、为什么扩展事件桥也属于这一章的主线

Pi 的运行时不仅要支撑内核和前端，还要支撑：
- 扩展
- 技能
- 事件桥
- runtimeHost 重新绑定

这意味着 `AgentSessionRuntime` 的责任不只是：
- 跑一个 session

还包括：
- 给外部系统（扩展 / mode / 技能）提供稳定接点

所以它不是“session 的外壳”，而是：
> **整个 Agent 生态进入 session 内核的桥面。**

如果你不把这点看清楚，后面读 skills / extensions / tool systems 时，会觉得它们是外挂；
但实际上，在 Pi 里它们是被运行时内核正式接纳的。

---

## 八、这一章真正解决了哪些工程问题？

### 1. 如何避免不同前端各自重写 Agent 执行逻辑
Pi 的解法：AgentSessionRuntime 共享内核

### 2. 如何让会话状态、服务依赖和事件桥面在一个统一运行时里收束
Pi 的解法：session + services + runtimeHost + diagnostics

### 3. 如何支持多种交互形态而不让控制面分叉
Pi 的解法：interactive / print / rpc 只负责外化方式

### 4. 如何让运行时初始化就具备可解释性
Pi 的解法：runtime diagnostics

### 5. 如何让扩展系统、安全状态和模式层都围绕同一个会话内核运转
Pi 的解法：runtime 作为统一接点

所以这一章真正要学的，不是“Pi 有几个 mode”，而是：

> **Pi 如何把多形态交互的复杂度压到内核之外，同时维持一个共享的执行语义中心。**

---

## 九、读者最容易学错的地方

### 错觉 1：interactive-mode 最大，所以它就是主线
错。体量大不等于主线。真正主线是共享 runtime 内核。

### 错觉 2：print / rpc 只是小适配器
不完全对。它们确实不拥有主执行语义，但却是“模式层如何外化内核”的重要样本。

### 错觉 3：runtime 只是把几个对象绑在一起
错。它定义的是会话执行语义与前端形态之间的内核边界。

### 错觉 4：扩展和技能是外挂
错。Pi 的运行时把它们正式接到了会话内核的桥面上。

---

## 十、分析边界

### 为什么这里不先深入 TUI 视觉组件
因为这一章关注的是“共享运行时内核”，不是视觉交互表现。

### 为什么这里不先展开 SessionManager 存储细节
因为这一章先讲 runtime 如何统一模式；持久化细节应该在后续 session/history 章节深入。

### 为什么这里不先展开 provider 层
因为 provider 是另一条主线；这一章先站稳“模式和内核的分工”。

---

## 十一、读者分层路由

### beginner
先抓住：
1. 多种模式不等于多套内核
2. runtime 才是会话的执行中心
3. interactive / print / rpc 的差别主要在外化方式

### intermediate
重点看：
- AgentSessionRuntime
- runtimeHost
- services
- diagnostics
- 模式层注入关系

### advanced
重点看：
- 为什么共享运行时能压住模式复杂度
- 扩展事件桥如何进入 session 内核
- 这套设计和单控制器 / facade 型系统相比的异同

---

## 十二、迁移清单

### 可迁移思想 1：多形态共享同一执行内核
- 可迁移到：CLI / RPC / print / web 多入口 Agent
- 前提：希望不同前端拥有同一执行语义
- 不适合直接照搬到：只有单一前端的小系统

### 可迁移思想 2：运行时初始化自带诊断
- 可迁移到：复杂 Agent runtime
- 前提：系统启动前存在大量潜在但非致命问题
- 不适合直接照搬到：极简原型系统

### 可迁移思想 3：模式层只负责外化，不负责主执行语义
- 可迁移到：所有会暴露多种交互界面的 Agent
- 前提：有清晰的 session/runtime 内核
- 不适合直接照搬到：前后端天然耦合的简单产品

---

## 十三、自测问题

1. 为什么 Pi 必须把 AgentSessionRuntime 抬成共享内核，而不是让每种 mode 各写一套？
2. 为什么 interactive / print / rpc 的区别主要在外化方式，而不是执行语义？
3. runtime diagnostics 在这条主线上真正解决了什么问题？
4. 为什么技能、扩展和运行时桥面应该被一起理解？
5. 用自己的话解释：Pi 为什么更像“多形态共享运行时系统”，而不只是“一个带多个模式的 CLI Agent”。

---

## 十四、读完这一章，读者应该获得什么能力？

至少应该能做到：

1. 解释为什么 Pi 的核心不是某个 mode，而是 AgentSessionRuntime 共享内核。
2. 说清多形态前端和单一执行语义之间的关系。
3. 理解 runtime / mode / services / diagnostics / extensions 各自扮演什么角色。
4. 理解为什么“前端不重实现执行语义”对 Agent 产品特别重要。
5. 用自己的话说明：Pi 为什么代表了一种“共享运行时内核 + 多外壳形态”的架构路线。

如果还做不到这些，就说明这章还没真正学懂。
