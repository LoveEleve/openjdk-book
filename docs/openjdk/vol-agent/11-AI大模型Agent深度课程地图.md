# AI / 大模型 / Agent 深度课程地图

> 目标：定义本卷的完整学习顺序、阶段依赖、论文路线、实验路线和与真实 Agent 源码的映射。

---

## 一、总路线

本卷按“先理解程序和数据，再能算，再能训，再能推，再能做事，最后能长期可靠运行”的顺序组织。

> 真正零基础读者先读 `00-prerequisites/`。Phase 0 不是第一接触点，而是零基础前置层之后的实验与工程补桥。

```text
Pre-phase 0 零基础：程序、数据、函数、模型、学习
  ↓
Phase 0 计算机与 Python 基础补桥
  ↓
Phase 1 数学、概率与学习问题
  ↓
Phase 2 Tokenizer 与 Transformer 前向计算
  ↓
Phase 3 语言模型训练与对齐
  ↓
Phase 4 单模型推理与 Serving
  ↓
Phase 5 Agent 基本范式与 Tool Loop
  ↓
Phase 6 Context、Memory、RAG 与 Planning
  ↓
Phase 7 Runtime、恢复、权限与多 Agent
  ↓
Phase 8 论文精读、评测、安全与生产治理
```

> 论文不是最后才读的附录：每个 Phase 都应穿插对应论文；Phase 8 负责统一比较证据质量、安全与生产治理。

不能跳过的关键依赖：

```text
Attention 前不要讲 KV Cache
KV Cache 前不要讲长上下文优化
Language Modeling 前不要讲 SFT/RLHF
Tool Loop 前不要讲完整 Agent Runtime
Context Engineering 前不要讲 Memory/Compaction
状态机与副作用前不要讲可靠 Agent
```

---

## 二、Phase 0：计算机与 Python 补桥

> 前置：`00-prerequisites`。本阶段不再解释“什么是程序/数据/模型”，而是把读者带到能运行张量实验和阅读后续实现的水平。

### 目标
让读者能够运行最小实验、读懂张量代码和理解服务端执行边界。

### 必备知识

- Python 函数、类、迭代器、生成器、异常；
- NumPy/PyTorch 基本 tensor 操作；
- shape、dtype、device；
- 文件、进程、网络和 JSON；
- 基本复杂度和内存估算；
- Git、虚拟环境和实验可复现。

### 不在此阶段深入

- CUDA kernel；
- 分布式系统完整理论；
- 高等数学证明；
- 特定云服务 API。

### 通过标准

读者能够：
- 创建一个 tensor 并追踪 shape；
- 写一个可重复运行的实验；
- 读取模型输出并保存指标；
- 解释 CPU/GPU、显存/内存和 batch 的基本区别。

---

## 三、Phase 1：数学、概率与学习问题

### 目标
建立“模型不是魔法，而是参数化函数 + 损失 + 优化”的最小心智模型。

### 学习顺序

1. 标量、向量、矩阵和张量
2. 线性变换、内积和范数
3. 概率分布、条件概率与 Bayes 直觉
4. 熵、交叉熵和 KL 散度
5. 梯度、链式法则与反向传播
6. 梯度下降、Adam 与学习率
7. Softmax、LogSumExp 与数值稳定性
8. 训练/验证/测试、泛化和分布偏移
9. 校准、不确定性和损失与能力的差异

### 最小实验

- 线性回归；
- logistic regression；
- 手写 softmax + cross entropy；
- 手写两层 MLP；
- 数值梯度检查；
- 比较 SGD、Momentum、Adam；
- 观察过拟合与温度校准。

### 进入下一阶段的门槛

读者必须能解释：
- 一个 batch 的 loss 如何形成；
- 一个参数如何收到梯度；
- 为什么 softmax 可能数值溢出；
- 为什么训练 loss 下降不代表真实任务能力提升。

---

## 四、Phase 2：Tokenizer 与 Transformer

### 目标
完整追踪：

```text
文本
  → token ids
  → embeddings
  → Q/K/V
  → attention
  → MLP/residual/norm
  → logits
```

### 学习顺序

1. 字符、词、子词与 tokenizer trade-off
2. BPE / WordPiece / Unigram 的基本思路
3. Embedding lookup
4. Query、Key、Value
5. Scaled Dot-Product Attention
6. Causal Mask
7. Multi-Head Attention
8. Residual、LayerNorm/RMSNorm、MLP
9. Decoder-only Transformer
10. Logits、temperature 与 next-token distribution
11. 位置编码、RoPE、ALiBi 与长上下文
12. MQA/GQA 与 KV 头共享

### 每篇必须标出的内容

- 输入和输出 shape；
- 计算复杂度；
- 显存占用；
- 训练时和推理时的差异；
- mask 是否正确；
- 一个最小数值例子。

### 最小实验

- 手写 BPE toy tokenizer；
- 手写 Self-Attention；
- 可视化 causal mask；
- 手写 decoder-only block；
- 比较 MHA/MQA/GQA 的 KV 内存；
- 观察不同位置编码的长度外推趋势。

### 进入下一阶段的门槛

读者能够从一个 token id 追踪到最终 logits，并解释每次矩阵运算的目的。

---

## 五、Phase 3：预训练、SFT 与对齐

### 目标
理解“模型会续写”如何逐渐变成“模型会按指令完成任务”。

### 学习顺序

1. Causal Language Modeling
2. 数据清洗、去重、质量和配比
3. Batch、padding、packing 与 checkpoint
4. 预训练计算预算和 Scaling Laws
5. SFT 数据格式、loss mask 与 instruction tuning
6. Preference data、reward model 与 RLHF
7. DPO 的目标函数和隐式奖励
8. 对齐、拒答、helpfulness/safety trade-off
9. LoRA、QLoRA 和参数高效微调
10. MoE、专家路由和负载均衡
11. 数据/模型/张量/流水线并行

### 论文路线

- GPT-3；
- Scaling Laws for Neural Language Models；
- Chinchilla；
- InstructGPT；
- DPO；
- LoRA；
- Switch Transformers。

### 最小实验

- tiny language model 训练；
- SFT loss mask 对比；
- preference pair 的 DPO toy loss；
- LoRA rank 对参数量和效果的影响；
- MoE toy router 的负载不均衡。

### 进入下一阶段的门槛

读者能够区分：
- base model；
- instruction model；
- preference alignment；
- inference-time prompting；
- system-level tool control；
- 经典机器学习中的分类/回归与语言模型训练目标之间的连续性。

---

## 六、Phase 4：推理与 Serving

### 目标
理解一次生成请求如何消耗计算、显存、队列和服务预算。

### 学习顺序

1. Prefill 与 Decode
2. KV Cache
3. Greedy、temperature、top-k、top-p
4. Streaming 与取消
5. Continuous Batching
6. PagedAttention 与显存分页
7. Quantization
8. Speculative Decoding
9. 长上下文、RoPE scaling 和上下文压缩
10. Structured Output 与 constrained decoding
11. 多模型路由、限流、队列和 backpressure
12. Token、延迟、吞吐和成本观测

### 论文/系统路线

- FlashAttention；
- vLLM / PagedAttention；
- Speculative Decoding；
- SmoothQuant / GPTQ / AWQ；
- TensorRT-LLM 或同类 Serving 设计。

### 最小实验

- 对比无 cache 与 KV cache 的 decode；
- 测量 batch size 对吞吐/延迟的影响；
- 实现 sampling 对比；
- 模拟 paged KV block；
- 统计 token 成本、首 token 延迟和生成速度；
- 构造取消、超时和 partial stream 场景。

### 进入下一阶段的门槛

读者能够解释：
- 为什么长上下文主要受 KV 显存影响；
- 为什么吞吐和交互延迟不是同一个指标；
- 为什么 streaming 需要生命周期和取消语义；
- 为什么结构化输出需要模型层与 runtime 层共同保证。

---

## 七、Phase 5：Agent 基本范式

### 目标
理解 Agent 不是“更长的 prompt”，而是模型、环境、工具和状态共同组成的闭环。

### 学习顺序

1. Chat Completion 与 Agent Loop 的区别
2. ReAct：Thought/Action/Observation
3. Tool Schema 与 Tool Result
4. 状态机、事件和 turn/step
5. Retry、abort、timeout 和 partial result
6. Planning vs ReAct
7. Workflow vs autonomous loop
8. 完成判定与停止条件

### 论文路线

- ReAct；
- MRKL；
- Toolformer；
- Tree of Thoughts；
- Reflexion。

### 最小实验

- 手写一个 calculator tool loop；
- 加入错误结果回注；
- 加入最大步数和取消；
- 加入工具 schema 校验；
- 比较 ReAct、固定 workflow 和 planner/executor。

### 进入下一阶段的门槛

读者能够画出一个 Agent 的：
- 输入；
- 状态；
- 模型调用；
- 工具调用；
- 观察结果；
- 停止/恢复路径。

---

## 八、Phase 6：Context、Memory、RAG 与 Planning

### 目标
解决 Agent 长跑时最核心的三个问题：
- 模型上下文有限；
- 历史信息不等于长期知识；
- 任务目标不能只存在于自然语言里。

### 学习顺序

1. Context Engineering
2. Context window、prompt cache 和信息预算
3. Compaction 与摘要状态
4. 短期记忆、工作记忆和长期记忆
5. Embedding、向量检索和 reranking
6. RAG 数据流与引用证据
7. Planning、Task Contract 与 subgoal
8. Reflection、Critic 与 evaluator
9. Memory 写入门控、冲突与新鲜度
10. Multi-Agent 委派、角色、摘要和心跳
11. Browser/Computer Use 的环境状态

### 论文路线

- RAG；
- REALM；
- MemGPT；
- Self-RAG；
- Generative Agents；
- AutoGPT/Agent memory 相关系统论文和实践。

### 最小实验

- 实现 BM25/向量检索 toy pipeline；
- 比较全量历史、摘要和检索上下文；
- 做一个带 citation 的 RAG；
- 实现 memory 写入冲突检测；
- 实现 planner → executor → evaluator 三段协议；
- 模拟 subagent 摘要预算和失败恢复。

### 进入下一阶段的门槛

读者能够解释：
- 为什么 context 不是 memory；
- 为什么 RAG 不是简单把文档拼进 prompt；
- 为什么 planner、executor、evaluator 必须有边界；
- 为什么多 Agent 的难点是协调和证据，而不是并发调用模型。

---

## 九、Phase 7：Agent Runtime 与可靠系统

### 目标
把 Agent 从实验循环提升为可以长期运行的系统。

### 学习顺序

1. Durable Event、SessionInput 与收件箱
2. Session、History、Projection 与真相层
3. Tool Settlement、幂等和 stale rejection
4. Permission、Approval、Sandbox 与 Secret Scope
5. Workspace Lease、Fencing 与共享执行世界
6. Context Epoch、Compaction 与恢复
7. Delivery/Lifecycle/Evidence Ledger
8. GoalGate、GoalJudge 与停止语义
9. Observability、Recorder、Trace 与 Replay
10. Plugin、Capability Seam 与 Provider 路由
11. Workflow、State Machine 与 Durable Execution
12. 成本、并发、限流和预算控制

### 源码映射

- OpenCode：EventV2、SessionRunner、ToolRegistry、SystemContext、Permission；
- Reasonix：Controller、PlanContract、RunLoop、Checkpoint、Goaleval、WorkspaceLease；
- Pi：AgentSession、SessionManager、Compaction、ProviderComposer；
- Hermes：GoalJudge、DeliveryLedger、LifecycleLedger、VerificationEvidence；
- dsh：ReactLoopAgent、Session、Tools、Projection、Capability Seams、Shared World。

### 通过标准

读者能够从源码中指出：
- 真相在哪里提交；
- 上下文在哪里投影；
- 工具在哪里结算；
- 权限在哪里生效；
- 失败在哪里分类；
- 恢复从哪里开始；
- 系统为什么允许继续或必须暂停。

---

## 十、Phase 8：论文、安全、评测与生产治理

### 目标
不只让 Agent 跑起来，还要知道它是否可靠、是否安全、是否值得部署。

### 学习顺序

1. 事实性、幻觉与不确定性
2. Prompt Injection 与数据/指令边界
3. Tool Sandboxing 与 Capability Security
4. Secret Scope、数据泄露与输出过滤
5. Agent trajectory evaluation
6. LLM-as-a-Judge 的偏差
7. Red Team、Hostile Fixture 与故障注入
8. 幂等、重试、恢复和停止条件
9. 质量、成本、延迟、漂移和回归
10. Responsible AI 与治理

### 论文/标准路线

- TruthfulQA；
- HELM；
- Constitutional AI；
- Red Teaming Language Models with Language Models；
- AgentBench；
- SWE-bench；
- OWASP Top 10 for LLM Applications。

### 最小实验

- 构造 indirect prompt injection；
- 构造工具越权与 secret 泄露 fixture；
- 比较 final-answer、trajectory、tool/result 三种评测；
- 比较主模型 judge 与独立 judge 的一致性；
- 注入 timeout、crash、duplicate delivery 和 stale state；
- 输出质量、成本和恢复率报告。

---

## 十一、每阶段统一产物

每个阶段不只产文章，还产五类资产：

1. **概念地图**：前置/后置依赖；
2. **最小实现**：可以运行和观察；
3. **实验报告**：假设、指标、结果和失败样本；
4. **论文卡片**：问题、方法、证据、局限、迁移；
5. **源码锚点**：真实文件、函数、状态、测试契约。

阶段目录建议保持：

```text
阶段目录/
├── README.md
├── 01-主题文章.md
├── 02-主题文章.md
├── papers/
├── labs/
└── notes/
```

---

## 十二、推荐的实际阅读节奏

### 第一轮：建立可运行心智模型

顺读：
- Phase 1 的数学最小集；
- Phase 2 的 Token → Attention → Transformer；
- Phase 4 的 KV Cache 和 Sampling；
- Phase 5 的最小 Agent Loop。

目标：能看懂模型和 Agent 的主循环。

### 第二轮：补训练与系统成本

顺读：
- Phase 3 全部；
- Phase 4 Serving；
- Phase 6 Context/RAG/Memory。

目标：能解释模型能力如何来、请求为什么贵、上下文为什么会失控。

### 第三轮：进入真实 Runtime

顺读：
- Phase 7；
- 现有五项目源码分析；
- 五项目横向专题。

目标：能从源码验证 Agent 的真相层、停止语义、工具边界和恢复协议。

### 第四轮：论文与可靠性反证

顺读：
- Phase 8；
- 论文精读；
- hostile fixtures 与故障实验。

目标：能判断一个漂亮的 Agent demo 为什么还不能直接成为生产系统。

---

## 十三、最终完成标准

完成本卷第一版，不要求读者记住所有模型名或论文名，而要求能独立回答：

1. 一个 token 如何经过 Transformer 变成下一 token 分布？
2. 训练目标如何塑造模型能力，SFT/DPO 又改变了什么？
3. KV Cache、batch、量化和 serving 如何决定成本与延迟？
4. Agent Loop 如何把模型输出变成可观察行动？
5. Planning、Memory、RAG、Reflection 和 Multi-Agent 各自解决什么问题？
6. 工具调用如何经过权限、执行、结算、记录和恢复？
7. 什么是 Agent 的真相层、上下文层和恢复边界？
8. 为什么模型自称完成不等于任务完成？
9. 如何用论文、实验和源码共同验证一个工程判断？
10. 一个 Agent 系统在什么条件下应该继续、暂停、失败或恢复？

## 一句话结论

> **这卷的学习顺序不是“先把所有 AI 名词讲完”，而是沿着一条可验证的系统链前进：先理解计算，再理解模型；先理解生成，再理解行动；先理解行动，再理解状态、证据和可靠性。**
