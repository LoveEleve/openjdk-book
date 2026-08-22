# Attention Is All You Need 精读

> 论文：Attention Is All You Need（Vaswani et al. 2017）
> 公开链接：<https://arxiv.org/abs/1706.03762>
> 本地 PDF：`pdfs/1706.03762-Attention-Is-All-You-Need.pdf`
> 推荐阶段：Phase 2（学完 `02-transformer` 四篇后，在进入 `03-model-training` 之前阅读）
> 前置知识：tokenizer、embedding、attention 机制、causal mask、Transformer Block

---

## 一、论文要解决什么问题

2017 年之前，序列建模（sequence modeling）的主要工具是：
- RNN（LSTM、GRU）
- CNN（卷积序列模型）

它们的问题非常明确：

> 序列建模被 RNN 的顺序依赖和 CNN 的局部感受野限制了。

这篇论文要回答的核心问题是：

> 能不能只用 attention 机制，不要 RNN 也不要 CNN，做一个更并行、更快的序列模型？

答案是：**Transformer**。

---

## 二、旧方案哪里不够

### 1. RNN（LSTM、GRU）

RNN 的核心问题是：**每一步必须等前一步算完，才能算下一步。**

```text
s1 = f(x1, s0)
s2 = f(x2, s1)
s3 = f(x3, s2)
```

- 无法并行（训练慢）
- 长距离依赖要靠梯度穿越很多步（容易消失）
- 即使有 LSTM、GRU，在实际长序列中仍然有瓶颈

### 2. CNN

CNN 可以并行，但感受野有限。

- 要看到长距离，必须叠很多层或加大卷积核
- 计算量并不比 attention 小

### 3. 当时 attention 只是辅助

当时的 attention 机制只是 RNN 的附加组件：
- 在 encoder-decoder 之间加一个 attention 层
- 不是"全靠 attention"

这篇论文的突破：**把 attention 当作唯一的序列建模机制。**

---

## 三、核心对象与状态

### 对象

| 符号 | 含义 | 形状 |
|------|------|------|
| $X$ | 输入序列 | (seq_len, d_model) |
| $Q, K, V$ | query、key、value 投影 | (seq_len, d_k) 或 (seq_len, d_v) |
| $W_Q, W_K, W_V$ | 投影矩阵 | (d_model, d_k) 或 (d_model, d_v) |
| $d_k$ | key 的向量维度 | 标量 |
| $d_{model}$ | 模型隐藏层维度 | 标量 |
| $h$ | 注意力头数 | 标量 |

### 状态

论文没有显式维护状态，整个计算是**无状态的函数变换**：输入序列 → 多层变换 → 输出序列。

---

## 四、关键公式与算法

### 1. Scaled Dot-Product Attention

$$\text{Attention}(Q, K, V) = \text{softmax}\left(\frac{QK^T}{\sqrt{d_k}}\right) V$$

- $QK^T$：所有 query 和 key 两两点积（相关度分数）
- $\div \sqrt{d_k}$：缩放，防止点积随维度增大而进入 softmax 饱和区
- softmax：按行归一化成注意力权重
- $\times V$：加权求和得到输出

### 2. Multi-Head Attention

$$\text{MultiHead}(Q, K, V) = \text{Concat}(\text{head}_1, \ldots, \text{head}_h) W_O$$

$$\text{head}_i = \text{Attention}(QW_Q^i, KW_K^i, VW_V^i)$$

- 把 $Q, K, V$ 分别投影到 $h$ 组不同的子空间
- 每个头独立做 attention
- 拼起来再投影回 $d_{model}$

### 3. Position-wise Feed-Forward Network

$$\text{FFN}(x) = \max(0, xW_1 + b_1) W_2 + b_2$$

- 两层线性 + ReLU
- 逐 token 独立处理，不跨 token

### 4. Positional Encoding

由于没有 RNN 或 CNN 提供位置信息，必须显式注入位置编码：

$$\text{PE}_{(pos, 2i)} = \sin\left(\frac{pos}{10000^{2i/d_{model}}}\right)$$

$$\text{PE}_{(pos, 2i+1)} = \cos\left(\frac{pos}{10000^{2i/d_{model}}}\right)$$

- 不同频率的正弦/余弦波
- 让模型能区分"第 1 个词"和"第 5 个词"

### 5. Transformer 整体结构

论文使用的是 **encoder-decoder 架构**（不是今天流行的 decoder-only）：

**Encoder**：6 层，每层 = Multi-Head Self-Attention + FFN + 残差 + LayerNorm

**Decoder**：6 层，每层 = Masked Multi-Head Self-Attention + Cross-Attention + FFN + 残差 + LayerNorm

其中：
- Masked Self-Attention：带 causal mask，防止看到未来
- Cross-Attention：Q 来自 decoder，K 和 V 来自 encoder 输出

---

## 五、实验怎么设计

### 任务

- 机器翻译：WMT 2014 英德（EN-DE）、WMT 2014 英法（EN-FR）
- 英文成分句法分析（English Constituency Parsing）

### 对比基线

- EN-DE：对比当时的 SOTA（含集成模型）
- EN-FR：对比 SOTA
- 与当时的 RNN+Attention 模型做对比

### 训练配置

- 8 块 P100 GPU
- Base 模型：训练 12 小时（每步 0.4 秒）
- Big 模型：训练 3.5 天

### 关键指标

- BLEU 分数
- 训练成本（GPU 小时）
- 参数量

---

## 六、证据是否支持结论

### 1. 翻译任务

| 任务 | 旧 SOTA | Transformer | 提升 |
|------|---------|-------------|------|
| WMT 2014 EN-DE | 26.4 BLEU | 28.4 BLEU | +2.0 |
| WMT 2014 EN-FR | 40.6 BLEU | 41.8 BLEU | +1.2 |

提升显著，而且训练成本远低于旧 SOTA。

### 2. 训练效率

- 8 块 GPU、3.5 天达到 SOTA
- 当时最好的 RNN + Attention 模型需要更长时间和更多 GPU

### 3. 消融实验

论文做了大量消融实验：
- 减少头数 → 效果下降
- 去掉 attention 缩放 → 训练不稳定
- 减少层数 → 效果下降

这些实验有力支持了"每项设计都不是多余的"。

### 结论可信度评估

**强**：实验结果清晰，消融实验完整，baseline 公平，且后续被大量独立复现验证。

---

## 七、局限与失败模式

### 1. O(n²) 计算复杂度

这是 Transformer 最核心的局限，论文自己也承认了：

- 序列长度 n 增加，计算量平方级增长
- 对于长序列（如 10k+ token），计算和显存都急剧膨胀
- 后续大量工作（FlashAttention、稀疏注意力、Attention Sinks）都是在缓解这个问题

### 2. 位置编码是固定工程，不是学习的

论文使用固定的正弦/余弦函数，而不是可学习的参数。

后续 RoPE、ALiBi 等位置编码证明了更好的方案。

### 3. 论文只做了翻译和句法分析

论文没有涉及：语言模型预训练、生成式对话、代码生成等。

这些是后续 GPT-3、BERT、LLaMA 等工作扩展的。

### 4. Encoder-Decoder 架构在现代语言模型中已被简化

论文用的是 encoder-decoder（适合翻译）。
现代大模型大多用 decoder-only（适合语言生成）。
但 attention 的核心机制完全一致。

---

## 八、对 Agent 工程的迁移价值

### 1. Attention 是 Agent 理解上下文的基石

Agent 的每次推理，本质都是：
- 把历史会话、工具结果、系统提示拼成序列
- 用 attention 融合上下文
- 决定下一步该做什么

没有 attention，Agent 就无法"关注"历史中的关键信息。

### 2. O(n²) 限制直接决定 Agent 的上下文预算

- 序列越长，推理越慢、越贵
- Agent 必须做上下文压缩、摘要、KV Cache 管理来控制成本
- 这就是后面 `04-inference` 和 `06-agent-runtime` 的核心工程问题

### 3. 多头注意力是"多角度理解"的工程原型

- 多个头可能关注不同方面
- 对应 Agent 中："同时考虑工具结果、历史轨迹、系统指令"
- 这种"多角度融合"是 Agent 推理的重要组成部分

### 4. 论文的"小而精"实验风格值得学习

- 每个设计都做了消融实验
- 实验配置公开、可复现
- 不夸大结论、明确说出局限

这应该成为所有 Agent 论文的写作标准。

---

## 一句话结论

> **Transformer 用一个简洁的公式 $\text{softmax}(QK^T / \sqrt{d_k}) V$ 替代了 RNN 和 CNN，让序列建模变得可并行、可训练、可扩展。它到今天仍是几乎所有 LLM 和 Agent 系统的底层架构，没有之一。**