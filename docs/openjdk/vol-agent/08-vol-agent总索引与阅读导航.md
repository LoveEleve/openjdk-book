# vol-agent 总索引与阅读导航

> 用途：作为 `vol-agent/` 的总入口，帮助读者在 5 个 Agent 项目、方法论文档、机制分析正文和真正源码解析之间快速建立阅读路径。

---

## 一、这个目录到底在做什么？

`vol-agent/` 不是单个项目的笔记堆，而是一个专门面向 **Agent 源码学习 / 架构比较 / 工程问题提炼** 的知识库。

它分成两层：

1. **通用层**：方法论、范围规划、模板、横向比较锚点
2. **项目层**：每个项目自己的主线机制分析 + 真正源码解析

你可以把它理解成：

```text
通用方法论
  ↓
项目范围规划
  ↓
主线机制正文
  ↓
真正源码解析
  ↓
横向对比与迁移结论
```

---

## 二、顶层文档怎么读

## 卷 AI · 大模型与 Agent（新增理论卷）

> 这是本目录中新增的 AI / 大模型 / Agent 理论教材，与五项目源码分析并行。
> 27 篇核心正文 + 3 个最小实验 + 1 篇论文精读（25 篇本地 PDF）已全部完成。

### 理论正文阅读顺序

```text
00-prerequisites  零基础桥（4 篇）：程序/数据/函数/模型/概率
  ↓
01-foundations     数学与学习（4 篇）：向量/梯度/交叉熵/泛化
  ↓
02-transformer     Transformer 前向（4 篇）：tokenizer/attention/mask/logits
  ↓
03-model-training  训练与对齐（4 篇）：预训练/SFT/RLHF+DPO/LoRA
  ↓
04-inference       推理与 Serving（4 篇）：KV Cache/batching/量化/长上下文
  ↓
05-agent-foundations Agent 原理（4 篇）：Loop/Tool/Planning+Memory/RAG+Reflection
  ↓
06-agent-runtime    工程运行时（4 篇）：真相层/工具协议/完成判定/权限安全
  ↓
09-safety-evaluation 安全与评测（3 篇）：Injection/评测/治理
```

### 配套证据与验证

- `07-papers/`：论文精读 + 25 篇本地 PDF
- `08-labs/`：3 个可运行最小实验
- 总入口：`README.md`（卷 AI 首页）

## 0x 方法论与模板

- `00-源码学习痛点.md`
- `01-docs-迁移清单.md`
- `02-源码分析方法论.md`
- `03-Agent源码前置认知桥.md`
- `04-统一源码分析模板.md`
- `07-通用-源码解析模板.md`
- `08-vol-agent总索引与阅读导航.md`
- `09-vol-agent当前完成度与后续增量方向.md`

建议用途：
- 第一次进入 `vol-agent/`，先读 `02` 和 `03`
- 需要自己续写文章时，先看 `04` 和 `07`

## 0x 范围规划与总锚点

- `05-五Agent源码分析范围规划.md`
- `06-5项目横向对比总锚点.md`

建议用途：
- 想先知道 5 个项目分别值不值得看、各自重点是什么，先读这两篇

## 1x~4x 迁移来的辅助资料

- `10-product/`
- `20-plans/`
- `30-architecture/`
- `40-review/`

建议用途：
- 作为背景材料、计划草稿和评审存档使用
- 不作为第一阅读入口

---

## 三、五个项目各自从哪里开始

## OpenCode

### 项目画像
- 路线：现代事件溯源 Agent runtime
- 最核心问题：如何把 Agent 会话做成可重放、可恢复、可持续运行的系统

### 建议入口
1. `opencode/00-OpenCode主线总图.md`
2. `opencode/01-OpenCode源码学习范围规划.md`
3. `opencode/12-OpenCode第一卷总复盘.md`
4. `opencode/13-OpenCode横向对比锚点.md`

### 主线正文推荐顺序
1. `opencode/02-EventV2与SessionInput：OpenCode 如何把 Agent 变成可重放的会话系统.md`
2. `opencode/03-SessionRunner与SessionExecution：OpenCode 的执行骨架如何持续运行.md`
3. `opencode/04-ToolRegistry与Tool Settlement：为什么工具调用不是普通函数调用.md`
4. `opencode/05-SystemContext与Compaction：OpenCode 为什么能长跑而不散.md`
5. `opencode/06-Permission与Approval：OpenCode 如何约束 Agent 的副作用边界.md`

### analysis 阅读顺序
1. `opencode/analysis/01-EventV2提交协议源码解析.md`
2. `opencode/analysis/02-SessionRunner执行骨架源码解析.md`
3. `opencode/analysis/03-ToolRegistry结算管线源码解析.md`
4. `opencode/analysis/04-SystemContext一致性与压缩源码解析.md`
5. `opencode/analysis/05-Permission审批控制面源码解析.md`

---

## Reasonix

### 项目画像
- 路线：受控任务系统 + durable execution
- 最核心问题：如何把 Agent 做成可评估、可恢复、可阻塞、可继续的长期任务系统

### 建议入口
1. `reasonix/01-Reasonix源码学习范围规划.md`
2. `reasonix/10-Reasonix第一卷总复盘.md`
3. `reasonix/11-Reasonix横向对比锚点.md`

### 主线正文推荐顺序
1. `reasonix/02-Controller：Reasonix 为什么要把 Agent 做成单控制器系统.md`
2. `reasonix/03-Coordinator与PlanContract：Reasonix 如何让规划不再只是 prose.md`
3. `reasonix/04-RunLoop与DurableExecution：Reasonix 如何把 Agent 变成长跑任务系统.md`
4. `reasonix/05-ContextManager与Checkpoint：Reasonix 如何在缓存与恢复之间保持长跑稳定.md`
5. `reasonix/06-Goaleval与BoundedLLM：Reasonix 为什么把完成判定做成独立审查器.md`
6. `reasonix/07-Permission与WorkspaceLease：Reasonix 如何保护任务系统的副作用边界.md`

### analysis 阅读顺序
1. `reasonix/analysis/01-Goaleval独立审查器源码解析.md`
2. `reasonix/analysis/02-PlanContract源码解析.md`
3. `reasonix/analysis/03-DurableExecution运行骨架源码解析.md`
4. `reasonix/analysis/04-Checkpoint恢复边界源码解析.md`
5. `reasonix/analysis/05-ContextManager上下文视图源码解析.md`
6. `reasonix/analysis/06-WorkspaceLease与Permission副作用边界源码解析.md`

---

## Pi

### 项目画像
- 路线：共享运行时内核 + 显式会话状态机
- 最核心问题：如何让 interactive / print / rpc 多形态共享同一个 Agent runtime

### 建议入口
1. `pi/01-Pi源码学习范围规划.md`
2. `pi/09-Pi第一卷总复盘.md`
3. `pi/10-Pi横向对比锚点.md`

### 主线正文推荐顺序
1. `pi/02-AgentLoop：Pi 的执行骨架如何组织 turn、tools 与 continuation.md`
2. `pi/03-AgentSession状态机：Pi 为什么把复杂控制流收进会话系统.md`
3. `pi/04-AgentSessionRuntime与Modes：Pi 如何让多种前端共用一个运行时内核.md`
4. `pi/06-Session持久化与事实层：Pi 如何用会话树和存储组织长期状态.md`
5. `pi/07-Context与Compaction：Pi 如何构建并压缩模型可见上下文.md`
6. `pi/08-LLM与ProviderComposer：Pi 如何把多模型与多供应商能力接入运行时.md`

### analysis 阅读顺序
1. `pi/analysis/01-AgentSession状态机源码解析.md`
2. `pi/analysis/02-SessionManager会话树源码解析.md`
3. `pi/analysis/03-Compaction上下文压缩源码解析.md`
4. `pi/analysis/04-ProviderComposer模型能力组合源码解析.md`

---

## Hermes

### 项目画像
- 路线：多平台长期代理系统
- 最核心问题：如何把验证、账本、学习闭环和平台适配统一进一个长期运行系统

### 建议入口
1. `hermes/01-Hermes源码学习范围规划.md`
2. `hermes/09-Hermes第一卷总复盘.md`
3. `hermes/10-Hermes横向对比锚点.md`

### 主线正文推荐顺序
1. `hermes/02-AIAgent主循环：Hermes 如何组织 turn、工具批与长期运行.md`
2. `hermes/03-TurnRunner与GatewayRunner：Hermes 如何把多会话与多平台运行收进同一执行系统.md`
3. `hermes/07-DeliveryLedger与LifecycleLedger：Hermes 如何把交付和生命周期做成可追责的持久层.md`
4. `hermes/08-Verification与GoalJudge：Hermes 如何把完成判定做成独立审查系统.md`
5. `hermes/05-Memory与Skills：Hermes 为什么把学习闭环做成系统主线.md`

### analysis 阅读顺序
1. `hermes/analysis/01-GoalJudge源码解析.md`
2. `hermes/analysis/02-DeliveryLedger交付账本源码解析.md`
3. `hermes/analysis/03-LifecycleLedger生命周期账本源码解析.md`
4. `hermes/analysis/04-VerificationEvidence证据账本源码解析.md`

---

## dsh

### 项目画像
- 路线：插件运行时框架 / 框架即产品
- 最核心问题：如何在没有特权核心的情况下，把 Agent 行为全部交给插件、事件源和能力缝组合定义

### 建议入口
1. `dsh/01-dsh源码学习范围规划.md`
2. `dsh/05-dsh第一卷总复盘.md`
3. `dsh/06-dsh横向对比锚点.md`
4. `dsh/08-dsh框架即产品总串联.md`

### 主线正文推荐顺序
1. `dsh/02-AgentLoop：dsh 如何用 Cordis 插件框架组织 Agent 执行.md`
2. `dsh/03-Session日志：dsh 如何把模型可见即已记录做成运行时不变量.md`
3. `dsh/04-Cordis插件框架：dsh 为什么选择一切皆插件作为架构哲学.md`

### analysis 阅读顺序
1. `dsh/analysis/01-ReactLoopAgent源码解析.md`
2. `dsh/analysis/02-Surface投影源码解析.md`
3. `dsh/analysis/03-Inbox双队列源码解析.md`
4. `dsh/analysis/04-AgentDispatch源码解析.md`
5. `dsh/analysis/05-Tools五事件管线源码解析.md`
6. `dsh/analysis/06-Session双后端持久化源码解析.md`
7. `dsh/analysis/07-Projection五元契约源码解析.md`
8. `dsh/analysis/08-CapabilitySeams三角色源码解析.md`
9. `dsh/analysis/09-ProfileBundle装配源码解析.md`
10. `dsh/analysis/10-共享执行世界源码解析.md`

---

## 四、横向专题阅读顺序

建议在完成至少两个项目的主线阅读后，再读这些按工程问题重组的专题：

1. `14-五项目横向专题：真相层、上下文层与恢复边界.md`
2. `15-五项目横向专题：完成判定与停止语义.md`
3. `16-五项目横向专题：工具协议与副作用边界.md`

它们分别回答：
- 什么是真相、模型看什么、失败后从哪里恢复
- 什么时候完成、继续还是暂停
- 工具意图如何被授权、执行、记录和恢复

---

## 五、按阅读目标选择路线

## 如果你只想快速建立 5 个项目的整体判断
按这个顺序读：
1. `02-源码分析方法论.md`
2. `05-五Agent源码分析范围规划.md`
3. `06-5项目横向对比总锚点.md`
4. 每个项目的“第一卷总复盘”
5. 每个项目的“横向对比锚点”

## 如果你想真正学“代码到底怎么跑”
按这个顺序读：
1. 先看对应项目的范围规划
2. 再看 1~2 篇主线机制正文
3. 然后进入该项目 `analysis/` 从 `01` 开始顺读

## 如果你想做横向架构比较
按这个顺序读：
1. `06-5项目横向对比总锚点.md`
2. OpenCode / Reasonix / Pi / Hermes / dsh 各自的横向锚点
3. 回到对应项目的总复盘确认差异来源

---

## 五、一句话结论

如果只用一句话概括 `vol-agent/`：

> **它是一个面向 Agent 源码学习的分层知识库：上层负责方法论与比较，下层负责项目主线与真正源码解析，目标不是复述源码，而是提炼可迁移的工程结构。**
