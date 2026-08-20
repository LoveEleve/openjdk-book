# OpenCode 源码学习范围规划

> 项目：anomalyco/opencode
> 分析目标：作为 5 个 Agent 项目中的第一站，重建“现代 Agent runtime / session / context / tool / permission / protocol”的整体骨架
> 依据：
> - `vol-agent/02-源码分析方法论.md`
> - `vol-agent/03-Agent源码前置认知桥.md`
> - `vol-agent/04-统一源码分析模板.md`
> - `vol-agent/05-五Agent源码分析范围规划.md`

---

## 一、项目基本信息

- 项目名：OpenCode
- 版本基线：`v1.18.18`（依据既有域发现笔记）
- 技术栈：TypeScript + monorepo + Effect / SQLite / HttpApi / MCP / CLI / plugin
- 核心形态：CLI Agent + Session Runtime + Event/Storage + Protocol/Server/Client + MCP/ACP 集成

---

## 二、项目根问题（Project Thesis）

### 1. root problems

1. **如何把“模型 + 工具 + 用户输入”组织成一个可持续执行、可恢复、可追踪的 Agent 会话系统。**
2. **如何在长跑条件下保持上下文稳定、工具协议稳定、以及运行状态可恢复。**
3. **如何把权限、工具调用、扩展协议、远程模型和本地运行时编织成一个不会失控的控制面。**

### 2. design theses

- 不是把 Agent 当“一次问答”，而是把它当“持续运行的会话状态机”。
- 不是让 SessionPrompt 内存循环统治一切，而是逐步迁向 V2 事件溯源执行引擎。
- 不是把工具调用当普通函数调用，而是把它当模型驱动、权限约束、可结算的协议过程。
- 不是把 compaction 当省 token 小技巧，而是把它当长跑上下文工程的一部分。

### 3. architectural promises

- 会话状态最终可重放、可恢复、可解释。
- 工具调用有明确 schema、权限、执行与结算边界。
- Session / Context / Event / Tool / Permission / Protocol 不是一个神文件，而是可以拆开的控制面组件。
- CLI 只是外壳，真正的内核在 core / session / event / tool / permission / context 这一层。

---

## 三、主线机制（Mainline Mechanisms）

## O-1 EventV2 事件溯源与收件箱（核心主线）

### 为什么是主线
- 它决定了 OpenCode 的“真相源”是什么。
- 它把会话状态从“内存循环”推进到“事件日志 + 投影 + 重放”。
- 不理解它，就无法理解为什么 V2 能做恢复、交接、审计。

### 重点源码域
- `packages/core/src/event.ts`
- `packages/core/src/session/input.ts`
- `packages/schema/src/event.ts`
- `packages/schema/src/session-event.ts`

### 关键问题
- 事件如何定义、版本化、持久化？
- 收件箱为什么需要 admitted/promoted 双游标？
- 事件与投影如何保证一致性？
- owner / fencing / seq 连续性为什么是必要的？

---

## O-2 SessionRunner / SessionExecution / RunCoordinator（执行骨架）

### 为什么是主线
- 这是 OpenCode 的运行骨架：一轮轮 turn 如何继续、工具如何插入、compaction 如何改变控制流。
- 不理解它，就没法理解“Agent 是怎么一直跑下去的”。

### 重点源码域
- `packages/core/src/session/runner/`
- `packages/core/src/session/execution.ts`
- `packages/core/src/session/run-coordinator.ts`

### 关键问题
- run 双层循环到底怎么组织？
- shouldRun / needsContinuation 是什么？
- unsettled tools 怎么兜底？
- interrupt / wake / drain 怎么协调？

---

## O-3 SystemContext / Context Epoch / Compaction（上下文工程）

### 为什么是主线
- OpenCode 不是只调用模型，而是在精细管理“模型到底看见什么”。
- 上下文稳定性、compaction、resume 都是产品级核心，不是辅助功能。

### 重点源码域
- `packages/core/src/system-context/`
- `packages/core/src/session/context-epoch.ts`
- `packages/core/src/session/compaction.ts`

### 关键问题
- baseline / snapshot / replacement-ready 分别是什么？
- compaction 为什么被设计成控制流转移，而不是单纯压缩？
- context epoch 如何帮助恢复与比较？

---

## O-4 Tool Registry / Tool Settlement（工具协议）

### 为什么是主线
- Agent 是否可信，很大程度上取决于工具调用协议是否稳。
- 工具不是“顺手调函数”，而是模型驱动的协议链。

### 重点源码域
- `packages/core/src/tool/registry.ts`
- `packages/core/src/tool/tool.ts`
- `packages/core/src/tool/tools.ts`
- 各 leaf tool 实现

### 关键问题
- schema 如何定义？
- stale rejection 为什么必要？
- 结算七步是什么？
- 输出托管为什么存在？

---

## O-5 Permission / Approval / Sandbox Policy（控制边界）

### 为什么是主线
- Agent 的副作用能力必须受约束，否则无法进入真实环境。
- OpenCode 的权限系统不是附属品，而是控制面的一部分。

### 重点源码域
- `packages/core/src/permission.ts`
- `packages/core/src/permission/`
- `packages/opencode/src/permission/`

### 关键问题
- deny 优先是怎么实现的？
- ask / assert 两套 API 边界是什么？
- saved approval 如何持久化？
- 为什么这里是授权层而不是完整隔离层？

---

## O-6 Session Facade / Projector / History（会话外部接口）

### 为什么是主线
- 这是运行内核对外暴露成“可用产品”的那一层。
- 不理解 facade / projector，就不知道事件内核如何变成可读消息流与历史。

### 重点源码域
- `packages/core/src/session.ts`
- `packages/core/src/session/projector.ts`
- `packages/core/src/session/history.ts`

### 关键问题
- 事件如何被投影成消息？
- history / messages / prompt 这些外部可见对象和内部事件状态是什么关系？

---

## 四、横切专题（Crosscutting Tracks）

## O-X1 Location / Project / Workspace
- 为什么 OpenCode 到处都有 Location？
- 路由、权限、工具、指令、运行时都依赖它，说明它是控制面中的空间坐标系统。

## O-X2 Database / SQLite / Projection consistency
- 数据库不只是存东西，而是状态一致性的基础设施。
- event / session / permission / project 都靠它。

## O-X3 Snapshot / Revert / Output Store
- 长跑 Agent 不能只会继续跑，还要会保存、回滚、输出托管。
- 这是产品级稳定性的横切基础设施。

## O-X4 MCP / ACP / Protocol bridge
- OpenCode 不只是本地 CLI，它还试图成为协议中枢。
- MCP / ACP / server / client / sdk-next 代表的是“控制面外化”。

## O-X5 Plugin / Skills / Agent selection
- 技能和插件不是孤立功能，而是系统扩展性的核心侧面。

---

## 五、认知风险点（Cognitive Risks）

### 1. 把 V1 legacy prompt loop 当成当前主线
- 风险：会读到一大堆旧逻辑，以为那就是产品现在的核心。
- 实际：V2 事件溯源执行引擎才是应重点理解的主线。

### 2. 把工具调用当普通函数调用
- 风险：忽略 schema、settlement、stale rejection、permission。
- 实际：工具调用是模型驱动协议，不是本地函数直调。

### 3. 把 compaction 当“省 token 小功能”
- 风险：低估上下文工程的重要性。
- 实际：它决定系统能否长跑。

### 4. 把 permission 当外围安全模块
- 风险：误以为只是附加功能。
- 实际：它直接影响工具执行链路和运行时控制面。

### 5. 把 CLI / UI 当主线
- 风险：先读外壳，忽略内核。
- 实际：OpenCode 的核心在 core/session/event/tool/permission/context。

---

## 六、分析边界

### UI 要不要进主线？
- **结论：不要。**
- 理由：当前分析目标是 Agent runtime / control plane，不是视觉表现。

### 非主流平台实现要不要进主线？
- **结论：不要。**
- 理由：除非它改变主机制理解，否则先不纳入第一轮分析。

### Demo / example 要不要进主线？
- **结论：不要。**
- 理由：案例只用来验证，不用来决定系统结构。

### 测试代码要不要关心？
- **结论：要，但不作为主线。**
- 理由：测试是行为契约与边界条件证据。

### benchmark / recorder / stats 要不要关心？
- **结论：第二轮按需。**
- 理由：它们对性能与 observability 有价值，但不是第一轮主线。

### 第三方协议层（MCP/ACP）要不要关心？
- **结论：要，但作为横切/后段主线。**
- 理由：它们不是执行骨架，但对产品形态非常关键。

---

## 七、前置认知桥

对于没读过 Agent / AI / 大模型源码的人，先补：

1. 什么是 LLM provider / messages / model / tool call
2. 什么是 Agent loop / turn / step / continue / resume
3. 什么是 tool protocol / settlement
4. 什么是 context / compaction / checkpoint
5. 什么是 permission / sandbox / approval
6. 什么是 eval / regression / A/B

也就是说，OpenCode 第一轮分析前，必须先读：
- `vol-agent/03-Agent源码前置认知桥.md`

---

## 八、工程问题学习点

OpenCode 值得学的工程问题，不是“怎么调模型”，而是：

1. 如何把 Agent 做成会话系统而不是 prompt 脚本
2. 如何让工具调用具有协议边界和可恢复性
3. 如何让上下文工程与长跑恢复协同
4. 如何在不完全依赖隔离沙箱的情况下仍然建立权限控制面
5. 如何把本地 CLI 产品扩展成 MCP / ACP / Server / SDK 生态

---

## 九、第一轮学习顺序建议

1. EventV2 + SessionInput
2. SessionRunner / SessionExecution / RunCoordinator
3. SystemContext / Context Epoch / Compaction
4. Tool Registry / Tool settlement
5. Permission / Approval
6. Session Facade / Projector / History
7. Location / Database / Snapshot / Output Store
8. MCP / ACP / Plugin / Skills / SDK

这个顺序的目标是：
- 先看系统怎么成立
- 再看系统怎么持续运行
- 再看系统怎么被约束
- 最后看系统怎么被扩展

---

## 十、第一轮完成标准

只有同时满足以下条件，OpenCode 才算完成第一轮源码分析：

- 有项目根问题
- 有主线机制清单
- 有横切专题清单
- 有认知风险点
- 有分析边界
- 有前置认知桥
- 每个核心域都有机制闭环
- 有测试证据支撑边界判断
- 有工程问题学习点
- 有后续书级结构建议

不允许以“文件扫过了”“笔记写很多了”作为完成标准。