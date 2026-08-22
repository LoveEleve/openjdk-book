# 卷 AI · 大模型与 Agent

> 零基础入口：先读 [00-prerequisites](00-prerequisites/README.md)，不要直接跳到 Transformer。

> 一套从数学、神经网络、Transformer，到 LLM 推理、RAG、工具调用、Agent Runtime 与多 Agent 系统的源码与论文阅读卷。
>
> 这不是 API 使用手册，也不是论文摘要集合，而是从“模型为什么这样工作、Agent 为什么必须这样组织”出发，把理论、论文、伪代码、真实源码和工程边界串成一条可以走通的路径。

## 这卷解决什么问题

当一个用户输入进入大模型 Agent 时，系统同时在处理几套互相牵制的机制：

- 文本要被切成 token，映射成向量，再经过 Attention 和 MLP 多层变换；
- 模型要在有限上下文窗口内维护任务状态，并通过 KV Cache 降低重复计算；
- 训练要把海量文本变成基础能力，再通过 SFT、偏好优化和对齐变成可用助手；
- 推理要处理 batching、sampling、流式输出、结构化输出、工具调用和失败重试；
- Agent 要把模型意图变成计划、工具、副作用、记忆和可验证结果；
- RAG、Memory、Compaction、Subagent 和评测还要共同维持长期任务的一致性；
- 权限、沙箱、提示注入、数据泄露和不确定完成判定要阻止系统越过边界。

这卷的主线，就是把这些“为什么必须这样做”的问题拆开，再用公式、论文、伪代码和真实项目源码把答案钉住。

## 适合谁阅读

这卷同时面向零基础读者和已有工程背景的读者，采用前置层分流：零基础从 `00-prerequisites` 开始，有 Python/工程经验的读者可以按 Gate 自测后跳到对应阶段。

尤其适合：

- 想从零建立大模型和 Agent 完整知识体系的读者；
- 正在阅读 Transformer、推理引擎或 Agent Runtime 源码，但容易在数学、模型状态和工程控制流之间迷路的开发者；
- 需要把 RAG、工具调用、上下文压缩、Memory、评测和安全问题落到真实系统的 Agent 工程师；
- 想精读经典论文，并理解论文思想如何进入 OpenCode、Reasonix、Pi、Hermes、dsh 这类项目的工程实现者。

不要求先掌握深度学习全部数学，但建议熟悉 Python、基本线性代数、概率、函数和数据结构。每篇文章会在需要的位置补足局部前置知识；涉及训练或推理实现时，会同时给出“先看懂”和“再深入”的两条路线。

## 从哪里开始

### 如果你完全没有 AI 基础

入口：[00-prerequisites](00-prerequisites/README.md)

先完成：程序、数据、函数、算法、数据集、模型、训练和推理这些最小概念；尤其要理解“经典机器学习 → 参数化模型 → 神经网络”这条桥，再进入数学和神经网络。

### 如果你第一次学 AI / 大模型

入口：[00-prerequisites](00-prerequisites/README.md)，完成后进入 [01-foundations](01-foundations/README.md)。

按基础到模型的顺序读：

1. AI 系统的最小地图
2. 向量、矩阵与神经网络
3. 梯度下降与反向传播
4. Token、Embedding 与位置编码
5. Attention：模型如何选择上下文
6. Transformer：从输入到输出的完整数据流
7. 训练、推理与权重到底是什么

> 以上章节正文已全部完成。详见 `01-foundations/`、`02-transformer/` 目录。

### 如果你关心大模型推理工程

入口：[04-inference](04-inference/README.md)

> 建议先完成 Phase 2 的 Transformer 前向计算，再进入 KV Cache 和 Serving。

1. KV Cache
2. Batching、吞吐与延迟
3. Sampling 与解码
4. 量化、LoRA 与推理成本
5. 长上下文与 Context Window
6. 结构化输出与约束采样

> 以上章节正文已全部完成。详见 `04-inference/` 目录。

### 如果你关心 Agent 原理

入口：[05-agent-foundations](05-agent-foundations/README.md)

> 建议先完成 Phase 4 的生成、Sampling 和取消语义，再进入 Tool Loop。

1. 从语言模型到 Agent Loop
2. ReAct、Tool Use 与行动闭环
3. Planning：为什么 Agent 需要计划
4. Memory：短期上下文与长期记忆
5. RAG：检索如何进入推理
6. Reflection、Critic 与完成判定
7. Multi-Agent 与任务委派

> 以上章节正文已全部完成。详见 `05-agent-foundations/` 目录，并与现有 5 个 Agent 项目源码分析互相映射。

### 如果你关心真实 Agent 源码

入口：[06-agent-runtime](06-agent-runtime/README.md)

> 建议先完成 Phase 5 的 Tool Loop、状态机和停止语义，再进入五项目源码卷。

1. Agent Runtime 的共同结构
2. 事件、会话与真相层
3. 工具协议与副作用边界
4. 上下文构建与压缩
5. 完成判定、恢复与可观测性
6. 回到 `vol-agent/` 现有 5 个项目的主线正文与 `analysis/` 源码解析

> 前 5 个章节正文已全部完成（详见 `06-agent-runtime/` 目录）；第 6 项已经有现成的五项目源码正文。

## 十层地图

这卷按依赖关系组织成十层。`00-prerequisites` 是零基础入口，后续层次帮助读者逐步深入；层次是帮助理解的路线，不要求所有读者逐篇通读。

| 层 | 主题 | 主要域 |
|---|---|---|
| 0. 零基础前置 | [程序、数据、函数、模型与学习](00-prerequisites/README.md) | `00-prerequisites` |
| 0.5 工程实验补桥 | [Python、张量、环境与实验复现](13-零基础阅读协议与学习进度卡.md) | `Phase 0` |
| 1. 数学与学习 | [向量、概率、梯度、损失函数和优化](01-foundations/README.md) | `01-foundations` |
| 2. 模型原语 | [Token、Embedding、Attention、Transformer、位置编码](02-transformer/README.md) | `02-transformer` |
| 3. 训练与模型 | [预训练、SFT、偏好优化、对齐、Scaling、MoE](03-model-training/README.md) | `03-model-training` |
| 4. 推理与系统 | [KV Cache、Batching、量化、Sampling、长上下文、Serving](04-inference/README.md) | `04-inference` |
| 5. Agent 机制 | [Loop、Tool、Planning、Memory、RAG、Reflection、Multi-Agent](05-agent-foundations/README.md) | `05-agent-foundations` |
| 6. 工程运行时 | [Runtime、事件、会话、权限、恢复和真实源码](06-agent-runtime/README.md) | `06-agent-runtime`、`vol-agent/` |
| 7. 论文精读 | [经典论文的假设、算法、实验和迁移](07-papers/README.md) | `07-papers` |
| 8. 最小实验 | [用代码验证数学和系统机制](08-labs/README.md) | `08-labs` |
| 9. 安全与评测 | [可靠性、安全边界、评测和生产治理](09-safety-evaluation/README.md) | `09-safety-evaluation` |

## 论文阅读路线

论文不按发表时间罗列，而按它们解决的系统问题组织。

详见：[如何精读一篇 AI 论文](07-papers/00-如何精读一篇AI论文.md)、[论文总索引与精读路线](07-papers/01-论文总索引与精读路线.md)

### 模型基础

1. `Attention Is All You Need`：Transformer 与 Self-Attention
2. `BERT`：双向预训练与表示学习
3. `Language Models are Few-Shot Learners`：规模化语言模型与 in-context learning
4. `Training language models to follow instructions with human feedback`：指令跟随与 RLHF

### 推理与对齐

1. `Direct Preference Optimization`：不经过显式奖励模型的偏好优化
2. `FlashAttention`：IO 感知的 Attention 计算
3. `LoRA`：低秩参数高效微调
4. `Switch Transformers`：稀疏 MoE 与专家路由

### Agent 与工具

1. `ReAct`：推理与行动交替
2. `Toolformer`：模型学习调用工具
3. `MRKL Systems`：模块化神经符号系统
4. `Reflexion`：语言反馈驱动的自我改进
5. `Tree of Thoughts`：搜索式推理
6. `Generative Agents`：记忆、反思与计划

### RAG、记忆与评测

1. `Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks`：RAG 基本结构
2. `REALM`：检索增强预训练
3. `MemGPT`：分层记忆与上下文管理
4. `Self-RAG`：检索与自我反思联合控制
5. `SWE-bench`：真实软件工程任务评测
6. `AgentBench`：多环境 Agent 能力评测

每篇论文建议遵循：

```text
问题背景
  → 前置知识
  → 核心假设
  → 算法/模型结构
  → 伪代码与数据流
  → 实验如何证明有效
  → 局限与失败模式
  → 真实 Agent 工程如何迁移
```

## 域索引

| 域 | 入口 | 关注的问题 |
|---|---|---|
| 01-foundations | AI 系统地图 | 一个模型系统由哪些层组成 |
| 02-transformer | Attention / Transformer | token 如何变成上下文相关表示 |
| 03-model-training | 预训练与对齐 | 模型能力如何被训练出来 |
| 04-inference | KV Cache / Serving | 模型如何低成本、稳定地生成结果 |
| 05-agent-foundations | Agent Loop / Tool / Memory | 模型如何变成能执行任务的系统 |
| 06-agent-runtime | Runtime / Session / Recovery | Agent 如何长期运行并保持可恢复 |
| 07-papers | [论文精读](07-papers/README.md) | 经典论文的假设、算法、实验和迁移 |
| 08-labs | [代码实验](08-labs/README.md) | 用最小实现验证数学和系统机制 |
| 09-safety-evaluation | [安全与评测](09-safety-evaluation/README.md) | 可靠性、安全边界、评测和生产治理 |

## 文章统一写法

每篇文章尽量遵循和 JVM 源码卷相同的节奏：

1. 先提出一个读者真正想知道的问题；
2. 补足理解该问题所需的最小前置知识；
3. 推演一个直觉但不够好的方案；
4. 给出模型、算法、状态和数据流；
5. 用公式、伪代码、最小实验或真实源码验证关键判断；
6. 讨论复杂度、成本、失败模式和安全边界；
7. 在结尾把局部机制接回下一篇和 Agent 系统全局。

因此，这卷不会把“Attention 是什么”写成词典式定义，也不会把论文写成摘要翻译。目标是让读者能够回答：

- 这个机制解决了什么具体问题？
- 它为什么比直觉方案更好？
- 它的计算、内存和失败边界是什么？
- 它如何进入真实模型或 Agent Runtime？

## 与现有 vol-agent 的关系

`vol-agent/` 现有内容已经完成 5 个真实 Agent 项目的架构与源码分析：

- OpenCode：事件溯源 runtime
- Reasonix：受控长跑任务系统
- Pi：共享运行时与会话状态机
- Hermes：多平台长期代理与账本系统
- dsh：一切皆插件的 Agent 框架

本卷不替代这些项目分析，而是提供它们背后的 AI / LLM / Agent 前置知识：

```text
数学与模型基础
  ↓
Transformer 与 LLM 推理
  ↓
Agent 原理与论文
  ↓
Agent Runtime 工程
  ↓
OpenCode / Reasonix / Pi / Hermes / dsh 源码
```

## 版本与范围边界

- 模型机制以现代 Transformer 类语言模型为主，不绑定某一家模型或服务商。
- 推理系统会优先讲清单机、单卡、流式和长上下文等核心机制，再讨论分布式 Serving。
- Agent 章节关注可验证的系统结构，不把“模型自主性”当成无需工程约束的魔法。
- 论文内容会区分论文原始结论、后续工程实践和本文的迁移判断。
- 训练章节会覆盖理解大模型所需的核心概念，但不把本卷变成完整深度学习课程或 CUDA 教程。
- 真实项目源码仍以各项目自身版本基线为准，跨版本阅读时必须重新核对路径、接口和行为契约。

## 深度学习地图与方法论

- [零基础阅读协议与学习进度卡](13-零基础阅读协议与学习进度卡.md) — 依赖门、学习节奏、阶段产物和回退规则
- [理论学习方法论](10-理论学习方法论.md) — 四层深度、问题驱动、论文/实验/源码四角验证
- [AI / 大模型 / Agent 深度课程地图](11-AI大模型Agent深度课程地图.md) — Phase 0~8 的依赖顺序、阶段目标、论文路线和通过标准
- [理论卷覆盖矩阵与收口标准](12-理论卷覆盖矩阵与收口标准.md) — 覆盖等级、P0/P1/P2 缺口与阶段完成条件

## 一句话结论

> **这是一卷把 AI 论文、Transformer 原理、LLM 推理和 Agent Runtime 源码串在一起的系统阅读卷：先理解模型如何产生能力，再理解 Agent 如何把能力变成可执行、可恢复、可验证的工程系统。**
