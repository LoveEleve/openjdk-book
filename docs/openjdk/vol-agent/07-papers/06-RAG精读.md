# RAG 精读：检索增强生成

> 论文：Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks（Lewis et al. 2020）
> 公开链接：<https://arxiv.org/abs/2005.11401>
> 本地 PDF：`pdfs/2005.11401-RAG.pdf`
> 推荐阶段：Phase 6（学完 `05-04-RAG与Reflection.md` 后阅读）
> 前置知识：seq2seq / encoder-decoder、向量检索、知识密集任务

---

## 一、论文要解决什么问题

大语言模型把知识存在参数里，但这种方式有三个问题：

1. **知识更新难**：训练完成后，知识就固定了
2. **知识无法追溯**：模型的回答没有"来源"
3. **参数记忆有限**：参数量有限，记不住全部知识

RAG 的核心问题：

> 能不能让模型在生成时访问一个"外部知识库"，从而提高知识密集型任务的准确性，并让答案有出处？

答案是：**把生成过程和一个可检索的文档库结合**。

---

## 二、旧方案哪里不够

### 1. 纯参数化模型（如 T5、BART）

- 知识存在模型参数里
- 无法轻易更新
- 无法解释"为什么知道这个"
- 在知识密集型任务上表现受限

### 2. 纯检索模型（如抽取式 QA）

- 直接抽取答案片段，不做生成
- 需要精确的检索结果，泛化差
- 语言生成能力弱

### 关键局限

两者都不能同时做到：
- 利用外部知识的灵活性
- 自由生成的语言能力
- 可追溯的来源

---

## 三、核心对象与状态

### 对象

| 符号 | 含义 |
|------|------|
| Query | 用户输入/当前生成上下文 |
| Retriever | 从知识库检索相关文档 |
| Document | 检索到的文档 |
| Generator | 基于 query + doc 生成答案 |

### 状态

RAG 有两种主要构型：

1. **RAG-Sequence（Seq）**：整段回答共享同一组检索文档
2. **RAG-Token（Token）**：每个生成 token 可以使用不同的检索结果

状态 = Query + 检索到的文档 + 当前生成的前缀。

---

## 四、关键公式 / 算法

### 1. RAG 的生成概率

RAG-Sequence 把生成概率建模为：

$$p(y|x) = \sum_{z \in \text{top-k}} p(z|x) \prod_{i} p(y_i | x, z, y_{<i})$$

其中：
- $x$：输入
- $z$：检索到的文档
- $y$：生成的答案

通俗理解：
- 先检索 top-k 文档
- 每个文档给一个权重 $p(z|x)$
- 基于每个文档分别生成，按权重合并

### 2. 检索器（Retriever）

使用预训练 DPR（Dense Passage Retriever）：
- 把 query 和 document 都编码成向量
- 用内积计算匹配分数
- 取 top-k

关键细节：DPR 和 BART 在 RAG 框架内**联合微调**，而非仅仅分别预训练后组合。联合微调让检索器学到"什么文档对生成有用"。

### 3. 生成器（Generator）

使用 BART（预训练 seq2seq）：
- 输入：query + 检索到的文档
- 输出：生成的答案

论文贡献之一是 DPR + BART **端到端联合微调**，让检索器和生成器协同优化。

### 4. RAG 与 seq2seq 的区别

- seq2seq：只从一个"参数化记忆"生成
- RAG：从"参数化记忆 + 外部文档库"生成，且文档权重可学

---

## 五、实验怎么设计

### 任务

论文在多个知识密集型任务评估：

1. **开放域问答（Open-domain QA）**：Natural Questions、TriviaQA、WebQuestions
2. **事实生成**：需要引用外部知识的生成任务
3. **抽象 QA**：需要从多个文档中综合信息

### 对比基线

- 纯参数化 seq2seq（BART、T5）
- RAG + 检索器变体（RAG-Sequence vs RAG-Token 内部对比）
- REALM（Karpukhin et al. 2020，另一个检索增强模型）
- DPR+Reader（提取式 QA，不生成）
- 有监督 SOTA（参考值）

### 关键指标

- 准确率（QA）
- 事实性、多样性（生成）
- 能否提供追溯（source）

---

## 六、证据是否支持结论

### 1. 开放域问答

RAG 在三个 Open-QA 基准（Natural Questions、TriviaQA、WebQuestions）上取得当时 SOTA：
- 优于纯参数化模型（BART）
- 优于检索增强变体（REALM）
- 优于提取式方法（DPR+Reader）

论文原文："set the state-of-the-art on three open domain QA tasks, outperforming parametric seq2seq models and task-specific retrieve-and-extract architectures."

### 2. 生成质量

在生成任务上，RAG 被评估为：
- 更具体（使用文档中的信息）
- 更事实化
- 更多样

### 3. 追溯性

RAG 天然支持来源追溯（每个答案可关联到文档）。

### 结论可信度评估

**强**：多个任务、多种基线、消融实验完整，且被后续大量 RAG 工作验证和扩展。

---

## 七、局限与失败模式

### 1. 检索质量决定一切

如果检索不到相关文档：
- 模型退化到只有参数知识
- 编造答案（幻觉）

如果检索到错误文档：
- 模型被误导

### 2. 生成与检索的耦合

RAG-Sequence 假设整段答案共享同一组文档，可能不精确。
RAG-Token 每 token 检索，成本高。

### 3. 文档库管理

- 需要维护一个最新、干净的文档库
- 文档冲突、过期信息、重复会降低效果
- 纵深检索时间成本

### 4. 对"何时该检索"没有自主判断

RAG 总是检索，即使模型已经知道答案——这会带来不必要的延迟和潜在的检索噪声。

后来的 Self-RAG (Asai et al. 2023)、CRAG (Yan et al. 2024) 针对这个问题做了改进，但原始 RAG 论文本身没有讨论这个方向。

---

## 八、对 Agent 工程的迁移价值

### 1. RAG 是 Agent 获取外部知识的基础

在 `05-04-RAG与Reflection.md` 中：
- Agent 用 RAG 获取知识库知识
- 用 Reflection 验证答案是否基于文档

### 2. 检索质量直接决定 Agent 可靠性

Agent 系统中：
- 检索不到 → Agent 不知道
- 检索到错误 → Agent 被误导

这解释了为什么真实系统需要：
- 检索质量评估（CRAG 的 retrieval evaluator）
- 引用标记
- 失败降级

### 3. "何时该检索"是后续改进方向

现代 Agent 系统用：
- 用户需求判断是否需要检索
- 上下文不足时检索，已知则跳过
- 这正是自 RAG（Self-RAG）思路的工程化

### 4. RAG + 工具调用是 Agent 双通道

RAG 检索"知识"，工具调用执行"操作"。
两者构成 Agent 获取信息的两大通道。

---

## 一句话结论

> **RAG 把生成模型和一个可检索的外部文档库结合，让模型既能利用外部知识、又能自由生成、还能追溯来源。它奠定了 Agent 获取外部知识的基础，但检索质量是决定其效果的关键。**