/**
 * Hermes 范围规划
 */
# Hermes 源码学习范围规划

> 项目：NousResearch/hermes-agent（main 基线）
> 分析目标：作为第四个 Agent 项目，重点学习“同一 AIAgent 内核如何支撑 CLI/消息网关/TUI/桌面四形态，并把记忆、审查、授权、可观测和后台任务编织成一个长期运行系统”。
> 依据：
> - `vol-agent/02-源码分析方法论.md`
> - `vol-agent/03-Agent源码前置认知桥.md`
> - `vol-agent/04-统一源码分析模板.md`
> - `vol-agent/05-五Agent源码分析范围规划.md`
> - `Agent/analysis/hermes-agent/00-域发现/00-hermes-域发现.md`

---

## 一、项目基本信息

- 项目名：Hermes
- 版本基线：`main`
- 技术栈：Python + TS/Electron/TUI + SQLite + 多平台网关 + 插件体系
- 核心形态：同一 AIAgent 内核跑在 CLI / 消息网关 / TUI / 桌面四形态，带记忆、技能、会话搜索、学习图谱、MCP/ACP、守卫与调度

---

## 二、项目根问题（Project Thesis）

### 1. root problems

1. **如何把一个会调模型、会用工具的 Agent 提升成可以在多平台、多会话、多任务场景下稳定运行的长期代理系统。**
2. **如何在保持 prompt cache 前缀稳定的前提下，把记忆、技能、压缩、验证、守卫和审计接入主循环。**
3. **如何把交付、生命周期、监控、工具结果存储、审批和平台适配都收进一个统一的运行控制模型。**

### 2. design theses

- 同一 AIAgent 内核服务四种外壳，模式层不重复实现核心执行语义。
- prompt cache 前缀神圣不可轻易改动，压缩是唯一例外。
- 新能力优先走边缘（扩展、技能、工具集、MCP），不随意污染核心窄腰。
- 运行过程必须可审计、可交付、可恢复、可观测，而不只是“能完成任务”。

### 2.5 sharpened thesis

更锋利的一句话：

> **Hermes 的本质不是“功能很多的 Agent”，而是把同一个 Agent 内核长期运行在多平台、多任务、多账本、多审查约束下的代理系统。**

这意味着：
- 平台适配不是附属层，而是产品形态的一部分；
- 账本和审查器不是事后补丁，而是主运行语义的组成部分；
- prompt cache 不是优化项，而是上层架构约束。
### 3. architectural promises

- 核心逻辑尽量集中在 AIAgent / loop / gateway runner / state store 上。
- prompt cache 前缀稳定优先于“任意方便地改 prompt”。
- 记忆、技能、审查、交付、生命周期和监控都必须进入运行时，而不是做外围插件。
- 平台适配器只是外化手段，不重写核心执行控制。

---

## 三、主线机制（Mainline Mechanisms）

### 三条大主线

#### 主线 A：执行与运行控制
- AIAgent 主循环 / Conversation Loop
- TurnRunner / GatewayRunner
- Context compression / native compaction / reasoning summaries
- Permission / approval / secret scope / self-repo guard

#### 主线 B：学习与审查系统
- Memory / Skills / Curator / LearningGraph
- Verification / GoalJudge / BackgroundReview
- SessionDB / Search / DeliveryLedger / LifecycleLedger

#### 主线 C：平台化与生态外化
- BasePlatformAdapter
- MCP / ACP
- Plugins / Cron
- 多平台消息网关形态

这样分组的目的，是避免第一轮正文直接被 8 条平行主线打散。

## H-1 AIAgent 主循环 / Conversation Loop（核心主线）

### 为什么是主线
- 这是 Hermes 最直接的执行骨架。
- 不理解它，就看不懂 budgets、guardrails、工具批处理和 turn finalizer。

### 重点源码域
- `run_agent.py`
- `agent/conversation_loop.py`

### 关键问题
- 同步主循环如何组织？
- iteration budget / grace call / interrupt 语义是什么？
- 工具批三模式怎么进入 turn？

---

## H-2 TurnRunner / GatewayRunner（网关态执行中枢）

### 为什么是主线
- Hermes 不只是本地 CLI，它还有消息网关和多会话治理。
- TurnRunner / GatewayRunner 共同定义了运行中协作和平台外壳下的执行语义。

### 重点源码域
- `gateway/run.py`
- `gateway/session.py`
- `gateway/stream_dispatch.py`

### 关键问题
- 网关里的 agent 运行如何被组织？
- session 槽位、fallback 链、drain、唤醒和 stream dispatch 的边界是什么？

---

## H-3 上下文压缩 / 压缩决策（缓存优先）

### 为什么是主线
- Hermes 明确把 prompt cache 前缀当成神圣前提。
- 不理解这点，就看不懂为什么很多变化都不允许直接进入前缀。

### 重点源码域
- `agent/context_compressor.py`
- `conversation_compression.py`
- `native_compaction.py`
- `reasoning_summaries.py`

### 关键问题
- 本地压缩和服务端压缩怎么分工？
- 为什么缓存边界如此重要？
- reasoning summary 解决什么问题？

---

## H-4 记忆系统 / 技能生命周期 / 学习图谱

### 为什么是主线
- Hermes 自称 self-improving agent，记忆和技能不是附属功能。
- 学习图谱把知识、技能、行为都结构化了。

### 重点源码域
- `tools/memory_tool.py`
- `agent/memory_manager.py`
- `memory_provider.py`
- `tools/skills_tool.py`
- `agent/curator.py`
- `agent/learning_graph.py`

### 关键问题
- 记忆如何进入前缀？
- 技能如何从使用记录变成生命周期对象？
- 学习图谱在系统里扮演什么角色？

---

## H-5 验证系统 / Goal Judge / Background Review

### 为什么是主线
- Hermes 在验证、背景审查和 goal judge 上投入很深。
- 不理解这一层，就会把它误看成“只是一个大循环”。

### 重点源码域
- `agent/verify/`
- `verification_evidence.py`
- `background_review.py`
- `tools/kanban_tools.py:_goal_judge`

### 关键问题
- verify runner / recipes 怎么组织？
- 证据账本怎么落？
- 背景审查 fork 为什么存在？

---

## H-6 权限 / 审批 / Secret Scope / 自仓库保护

### 为什么是主线
- Hermes 对边界控制远不只是 allow/deny。
- 它覆盖命令安全、secret scope、自仓库保护、智能审批等多个面。

### 重点源码域
- `tools/approval.py`
- `tools/write_approval.py`
- `agent/secret_scope.py`
- `tools/self_repo_guard.py`
- `tirith_security.py`

### 关键问题
- 智能审批熔断在保护什么？
- secret scope 如何和 profile 绑定？
- 自仓库保护为什么值得单列？

---

## H-7 会话存储 / 搜索 / 账本

### 为什么是主线
- Hermes 的持久层不只是 session DB，还包含 delivery ledger / lifecycle ledger / session search / storage schema。

### 重点源码域
- `hermes_state.py`
- `hermes_state_search.py`
- `hermes_state_schema.py`
- `gateway/delivery_ledger.py`
- `gateway/lifecycle_ledger.py`

### 关键问题
- SessionDB 的角色是什么？
- delivery ledger 为什么是 at-least-once 的核心？
- lifecycle ledger 怎么做脏死检测？

---

## H-8 平台适配器 / 协议外化 / 插件生态

### 为什么是主线
- Hermes 的平台适配器和插件生态体量很大，而且是产品形态的一部分。

### 重点源码域
- `gateway/platforms/base.py`
- `mcp_serve.py`
- `acp_adapter/`
- `plugins/`
- `cron/`

### 关键问题
- 平台能力抽象怎么定义？
- MCP / ACP 在 Hermes 里是什么地位？
- 插件和调度系统如何接入主运行时？

---

## 四、横切专题（Crosscutting Tracks）

## H-X1 Prompt Cache 神圣边界
- 这是 Hermes 最独特的架构哲学之一。
- 几乎所有上下文管理设计都受它约束。

## H-X2 守卫层 / 审查层
- tool guardrails
- goal judge
- background review
- verification evidence
- 它们共同构成“执行器之外的判断层”

## H-X3 生命周期账本
- delivery ledger
- lifecycle ledger
- process registry
- tool result storage
- 这条线体现 Hermes 对运行期长期一致性的重视

## H-X4 交付 / 运行 / 观测三位一体
- delivery ledger
- lifecycle ledger
- monitoring plane
- shutdown forensics
- 重点不只是“记账”，而是把运行后的可解释性做成系统资产

## H-X5 多平台适配统一抽象
- BasePlatformAdapter + stream_dispatch
- 外壳很多，但协议尽量统一

## H-X6 学习闭环
- memory
- skills
- curator
- learning graph
- background review

---

## 五、认知风险点（Cognitive Risks）

### 1. 错觉：Hermes 只是一个功能很多的 Agent CLI
- 实际风险：看不到它是多平台、多账本、多审查、多运行态的长期代理系统。
- 应纠正为：它更像“多平台运行控制系统”。

### 2. 错觉：prompt cache 只是性能优化
- 实际风险：看不到它是上层架构约束。
- 应纠正为：它直接决定上下文工程和压缩设计。

### 3. 错觉：memory / skills 只是附加功能
- 实际风险：低估 self-improving 这条产品主线。
- 应纠正为：学习闭环是 Hermes 的核心卖点之一。

### 4. 错觉：gateway / platform 只是外壳
- 实际风险：忽略 TurnRunner、GatewayRunner、stream_dispatch 的系统角色。
- 应纠正为：平台外化是 Hermes 主形态的一部分。

### 5. 错觉：verification / goal judge / background review 是零散 feature
- 实际风险：看不出 Hermes 其实也在构建“执行器之外的判断层”。
- 应纠正为：这些机制共同组成 Hermes 的审查层。

### 6. 错觉：approval / secret / self_repo_guard 都是安全边角料
- 实际风险：看不见边界控制和自保护的重要性。
- 应纠正为：这些是长期运行系统的控制护栏。

### 7. 错觉：delivery ledger / lifecycle ledger 只是审计工具
- 实际风险：低估 at-least-once 交付和脏死检测的运行语义。
- 应纠正为：账本定义了“事后还能不能知道发生了什么”。

---

## 六、分析边界

### UI 要不要进主线？
- **不要。**
- TUI/桌面/Web 视觉层先不进主线，保留平台协议与后端桥面。

### 平台适配器要不要全扫？
- **不要。**
- 先看 `BasePlatformAdapter` 抽象和 `gateway/session/run.py`，具体 20+ 平台适配器后置。

### 插件要不要一开始全看？
- **不要。**
- 先把插件当能力生态边界，等主循环、记忆、验证、平台抽象站稳后再细扫。

### provider / platform / plugin 的具体实例要不要第一轮全进？
- **不要。**
- 第一轮先看抽象骨架：AIAgent / GatewayRunner / BasePlatformAdapter / plugin lifecycle。
- 具体 provider / platform / plugin 实例会在第二轮按代表样本深读，而不是第一轮平铺扫描。

### 测试代码要不要关心？
- **要。**
- 尤其是 verification evidence、context compression、session/search、approval 相关测试契约。

### 语音 / TTS / 图像 / 视频要不要进主线？
- **不要。**
- 这是边缘模态能力，不是第一轮系统骨架。

---

## 七、前置认知桥

读 Hermes 前，建议先具备：
- Agent loop / tool batch / turn lifecycle 基本理解
- prompt cache / context compression 基本理解
- approval / sandbox / guardrail 基本理解
- ledger / observability / at-least-once 基本理解

如果没有，先读：
- `vol-agent/03-Agent源码前置认知桥.md`

---

## 八、工程问题学习点

Hermes 值得学的工程问题，不是“功能很多”，而是：

1. 如何让一个内核同时支撑 CLI、消息网关、TUI、桌面多形态
2. 如何把 prompt cache 边界上升为架构约束
3. 如何把记忆、技能、学习图谱做成长期学习闭环
4. 如何把 verify / review / guard 体系接进主循环
5. 如何通过账本和监控让长期运行可解释、可恢复、可追责
6. 如何把平台适配、协议外化、插件调度纳入产品生态

---

## 九、第一轮学习顺序建议

1. AIAgent 主循环 / conversation loop
2. TurnRunner / GatewayRunner
3. Context compression / native compaction / reasoning summaries
4. Memory / Skills / Curator / LearningGraph
5. Verification / GoalJudge / BackgroundReview
6. Permission / SecretScope / SelfRepoGuard / Approval
7. SessionDB / Search / DeliveryLedger / LifecycleLedger
8. BasePlatformAdapter / MCP / ACP / Plugins / Cron

---

## 十、Hermes 第一卷预期书级结构

如果第一轮分析做对，Hermes 这一卷最终应该长成：

1. AIAgent 主循环 / Conversation Loop
2. TurnRunner / GatewayRunner 与多会话治理
3. Context compression / native compaction / reasoning summaries
4. Memory / Skills / Curator / LearningGraph
5. Verification / GoalJudge / BackgroundReview
6. Permission / SecretScope / SelfRepoGuard / Approval
7. SessionDB / Search / DeliveryLedger / LifecycleLedger
8. BasePlatformAdapter / MCP / ACP / Plugins / Cron
9. 失败边界、交付语义与可迁移思想总结

这意味着：
- 第一卷不是“功能大全”，而是“一个长期代理系统如何成立”。
- 后续正文要优先服务这三条大主线：执行控制、学习审查、平台外化。

## 十一、第一轮完成标准

Hermes 只有同时满足以下条件，才算完成第一轮源码分析：

- 有项目根问题
- 有主线机制清单
- 有横切专题
- 有认知风险点
- 有分析边界
- 有前置认知桥
- 每个核心域有机制闭环
- 有测试/账本/守卫证据支撑关键判断
- 有工程问题学习点
- 有书级结构建议

不允许以“文件很多、功能很多、平台很多”作为完成标准。