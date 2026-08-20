# OpenCode 第一卷总复盘

> 覆盖范围：
> 1. EventV2 / SessionInput
> 2. SessionRunner / SessionExecution
> 3. ToolRegistry / Tool Settlement
> 4. SystemContext / Context Epoch / Compaction
> 5. Permission / Approval
> 6. SessionProjector / History
> 7. MCP / 协议外化
> 8. Plugin / Skills / Agent Selection
> 9. SessionFacade / Snapshot / Revert / MoveSession
> 10. Observability / Recorder

---

## 一、这一卷到底在讲什么？

如果只看单篇标题，你可能会觉得这一卷讲的是很多模块：
- event
- runner
- tools
- context
- permission
- projector
- protocol
- plugins
- snapshot
- observability

但如果把它们真正收回到一起，这一卷其实只在讲一件事：

> **OpenCode 如何把一个“会调模型”的程序，做成一个可持续运行、可恢复、可扩展、可审计、可外化的 Agent runtime。**

也就是说，OpenCode 这一卷真正的主线不是“功能列表”，而是：

```text
真相源
  ↓
执行骨架
  ↓
工具协议
  ↓
上下文工程
  ↓
权限控制
  ↓
可见会话投影
  ↓
协议外化
  ↓
能力扩展
  ↓
可恢复外壳
  ↓
可观测与复盘资产
```

这条线非常完整，也说明 OpenCode 的产品哲学不是：
- 先把功能堆上去

而是：
- 先把 runtime 内核站稳
- 再把外化层、扩展层、观察层一层层接上去

---

## 二、OpenCode 最值得记住的 5 个系统判断

## 1. 会话不是对话历史，而是可恢复的持续执行系统

这是 OpenCode 最根本的一条判断。

它不把 session 看成：
- 一串 messages

而是看成：
- 一个有收件箱、有 durable truth、有执行骨架、有恢复语义的系统

所以：
- SessionInput 不只是消息
- EventV2 不只是事件总线
- SessionRunner 不只是 loop
- History 不只是历史记录

它们共同构成：
> **durable session**

这点是 OpenCode 和很多“Agent demo”之间最本质的区别。

---

## 2. 工具不是函数，而是协议能力

OpenCode 对工具的理解非常成熟：
- 工具值是 opaque handle
- 工具执行走 settlement pipeline
- 工具结果要 bounded / stored
- stale tool 不允许继续执行
- permission 不由 tool 自己裸管，而要进统一控制面

这意味着：
> **工具能力在 OpenCode 里是协议对象，不是本地函数集合。**

这件事非常值得记住，因为它解释了为什么 OpenCode 在：
- registry
- settlement
- output store
- permission
上投入了这么多复杂度。

---

## 3. 上下文不是 prompt 字符串，而是状态机

这一卷里最容易被低估、但其实非常先进的地方之一，就是 SystemContext / Context Epoch / Compaction。

OpenCode 不是把 system prompt 当一段字符串，而是：
- 把不同来源建成 source
- 做 initialize / reconcile / replace
- 区分 unavailable / removed / updated
- 把 compaction 纳入执行控制流

所以它真正解决的不是“怎么写 prompt”，而是：
> **模型每一轮看见的系统语义，如何在长跑中保持稳定。**

这对 Agent 工程来说非常关键。

---

## 4. 权限不是弹窗，而是控制面

PermissionV2 这一章把 OpenCode 的“边界意识”暴露得很充分。

它不是：
- 需要权限就弹窗

而是：
- action/resource/effect 规则模型
- ask / assert 两种执行语义
- pending permission 进入会话状态
- reject / once / always 影响 session 后续行为
- saved approvals 受 configured deny 约束

所以权限系统在这里不是外围件，而是：
> **副作用控制的运行时控制面。**

---

## 5. OpenCode 不是本地 CLI 工具，而是在向“协议化平台节点”演化

前 10 篇最后一路走到了：
- MCP
- OAuth / DCR
- protocol bridge
- plugins
- skills
- sdk
- recorder / observability

这说明 OpenCode 不是只想做一个：
- 本地命令行 Agent

而是在演化成：
> **一个能被外部系统接入、能提供能力、能输出协议、能被观测和复盘的 Agent 平台节点。**

这点非常重要，因为它决定了它很多复杂度不是“多余”，而是为了平台化做准备。

---

## 三、这一卷里最关键的工程问题是什么？

如果你把前 10 篇串起来看，OpenCode 真正解决的工程问题主要有这几类：

### 1. 如何让 Agent 从一次性推理，变成可恢复的持续执行系统
- EventV2
- SessionInput
- SessionRunner

### 2. 如何让工具世界变成受 runtime 管控的协议过程
- ToolRegistry
- Tool Settlement
- Output Store

### 3. 如何让模型上下文在长跑中保持一致性
- SystemContext
- Context Epoch
- Compaction

### 4. 如何让副作用能力受控制，而不是自由散落在 leaf tool 里
- PermissionV2
- Approval state
- Saved approvals

### 5. 如何让内部 durable 状态稳定投影成用户可见会话
- SessionProjector
- History filtering
- Facade

### 6. 如何把内部控制面安全地外化出去
- MCP
- OAuth
- Protocol bridge
- Plugin / Skill system

### 7. 如何让这套系统在事后还能解释、复盘、录制和回放
- Observability
- Recorder
- RunID / logs / traces / cassettes

---

## 四、OpenCode 最值得迁移的思想是什么？

这一卷里，我认为最值得迁移的思想有 8 个：

### 1. 输入先进入收件箱，再进入模型上下文
这是 durable execution 的地基。

### 2. 事件是版本化契约，而不是自由 JSON
这是长期演进和重放稳定性的核心。

### 3. 运行骨架用“双层循环”拆开会话级工作与 turn 级 continuation
这让复杂 Agent loop 有了真正可管理的结构。

### 4. 工具执行必须走 settlement pipeline
这比“模型调用函数”成熟太多。

### 5. 上下文必须被建模成 source algebra，而不是 system prompt 拼接
这是长跑能力真正的根。

### 6. 权限必须进入控制面，而不是挂在 leaf tool 上做零散判断
这是副作用安全的核心原则。

### 7. 会话可见状态必须由 durable truth 投影出来，而不是临时消息堆出来
这是恢复和历史一致性的关键。

### 8. 录制与可观测性必须从一开始就是系统资产，而不是事后补的运维功能
这对长期演进特别关键。

---

## 五、这一卷最容易被误读的地方

### 误读 1：OpenCode 复杂，是因为它功能太多
不对。
更准确地说，它复杂，是因为它试图把 Agent 做成：
- 可持续运行
- 可恢复
- 可控
- 可扩展
- 可观测
的系统。

### 误读 2：很多模块只是工程化细节
不对。
像：
- compaction
- stale rejection
- pending permission
- history filtering
- runID
都不是小细节，而是 runtime 正确性的组成部分。

### 误读 3：MCP / plugin / sdk 是附加功能
不完全对。
它们更像 OpenCode 的平台化方向。

### 误读 4：Observability 只是日志输出
不对。
它其实在定义“系统事后还能不能被解释”。

---

## 六、如果读者只读这一卷，最后应该获得什么整体认知？

至少应该得到这 6 个判断：

1. **OpenCode 的核心不是对话，而是 durable session。**
2. **它的 loop 不是 while(true)，而是会话级工作和 turn 级 continuation 的协议骨架。**
3. **它的工具不是函数集合，而是受 schema、permission、settlement 约束的协议能力。**
4. **它的上下文不是字符串，而是可刷新、可替换、可压缩的状态系统。**
5. **它的权限、会话外壳、协议桥、扩展能力，都是围绕“让内核稳定外化”服务的。**
6. **它已经明显不是一个本地小 Agent，而是在向可平台化的 Agent runtime 演进。**

如果读完这 10 篇，读者还看不到这 6 个判断，那说明这一卷还没有真正完成。

---

## 七、后续怎么衔接到多项目对比？

OpenCode 第一卷结束后，最重要的是把它沉淀成几个对比锚点，后面去看 Reasonix / Pi / Hermes / dsh 时，重点比较：

1. 真相源是不是 durable event / inbox 模型？
2. loop 是怎么组织的？
3. 工具协议是怎么做的？
4. context / compaction / resume 怎么协同？
5. permission / sandbox 怎么建边界？
6. observable / recorder / eval 怎么落地？
7. 扩展能力是怎样被平台化的？

也就是说，OpenCode 的价值不只是“学会 OpenCode”，而是：
> **给后面 4 个项目建立一个现代 Agent runtime 的比较底座。**

---

## 八、一句话结论

OpenCode 第一卷最本质的收获，不是“它有哪些模块”，而是：

> **它展示了一个现代 Agent 产品如何把真相源、执行骨架、工具协议、上下文工程、权限控制、可见会话、协议外化、扩展能力和可观测性，组织成一套能长期运行的系统。**

这就是这 10 篇真正拼出来的东西。