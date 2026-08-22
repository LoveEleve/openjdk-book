# Causal Mask 与 Transformer Block：模型如何从左到右、一层层处理

> 前置：`02-attention机制.md`
> 本篇任务：理解 causal mask、残差连接、归一化和前馈网络如何组成一个完整 Transformer Block，以及 decoder-only 模型如何变成语言模型。

---

## 一、这一章真正的问题

上一章我们学会了 Self-Attention：

```text
output = softmax(QKᵀ / √d_k) · V
```

但要让一个语言模型真正工作，还需要解决三个问题：

1. **不能偷看未来**
   - 预测第 3 个词时，不能让它看到第 4 个词
   - 否则"预测"就变成"照抄答案"

2. **深层网络不稳定**
   - 几十层叠起来，梯度会消失/爆炸
   - 需要归一化和残差连接

3. **只有 attention 还不够**
   - attention 是"加权混合"，还需要逐位置的"深度变换"
   - 需要前馈网络（MLP / FFN）

这一章要回答：
1. causal mask 到底把什么遮住了？
2. 残差连接为什么能稳定训练？
3. LayerNorm 在干什么？
4. 前馈网络起什么作用？
5. 一个完整 decoder-only 模型怎么把 Transformer 变成语言模型？

---

## 二、最小前置知识

- 理解 self-attention 的 Q/K/V（`02-02`）
- 理解 softmax 按行归一化（`00-4`）
- 理解前向计算和 MLP（`01-01`）
- 理解序列从左到右的顺序概念

---

## 三、直觉方案为什么不够好

### 直觉方案 1：预测时不遮住未来

> 直接把整句都喂给模型，让它预测。

问题：
- 预测第 3 个 token 时，模型已经"看见"了第 4、5 个 token
- 那它不需要"预测"，直接"抄"即可
- 训练时作弊，推理时又看不到未来 → 训练/推理不一致

### 直觉方案 2：不加残差，叠很深

> 反正神经网络有很多层，一层层叠上去就好。

问题：
- 层数多了，梯度经过很多次乘法，会指数级变小（梯度消失）
- 或者指数级变大（梯度爆炸）
- 深层网络几乎学不进去

### 直觉方案 3：只要 attention，不要别的

> Attention 已经把上下文融合了，应该够了。

问题：
- attention 本质是"加权求和"，是线性混合
- 缺少非线性的、逐位置深度变换
- 表达能力不够

---

## 四、正式机制

### 1. Causal Mask：让注意力只看"过去和现在"

语言模型是自回归的：每一步只基于"已生成的 token"预测下一个。

实现方法：在计算 `QKᵀ` 分数矩阵后，把"未来位置"的分数设为负无穷（实践中用一个很大的负数，如 `-1e9`）。

```text
        t0   t1   t2   t3
t0     [ ✓, 遮,  遮,  遮 ]
t1     [ ✓,  ✓,  遮,  遮 ]
t2     [ ✓,  ✓,   ✓,  遮 ]
t3     [ ✓,  ✓,   ✓,   ✓ ]
```

- 每一行代表一个 query（当前 token）
- 每一列代表一个 key（能看的 token）
- 对角线及左下：允许看（过去 + 现在）
- 右上：遮住（未来）

流程：

```text
scores = Q · Kᵀ
scores = scores / √d_k
scores = scores + mask    # 未来位置加 -1e9
weights = softmax(scores) # 被遮住的位置 softmax 后 ≈ 0
output = weights · V
```

因为 softmax 里 `-1e9` 的指数趋近 0，所以遮住的位置几乎不贡献。

### 2. 单头注意力的完整实现

```python
def causal_attention(Q, K, V):
    d_k = Q.shape[-1]
    seq_len = Q.shape[0]

    scores = Q @ K.T / np.sqrt(d_k)     # (seq_len, seq_len)

    # 上三角遮罩：未来位置设为 -1e9
    mask = np.triu(np.ones((seq_len, seq_len)), k=1) * -1e9
    scores = scores + mask

    exp_scores = np.exp(scores - scores.max(axis=-1, keepdims=True))
    weights = exp_scores / exp_scores.sum(axis=-1, keepdims=True)

    return weights @ V, weights
```

### 3. 多头注意力（Multi-Head Attention）

"头（head）"是什么？

简单理解：**把 Q/K/V 切成几份，各自做一次 attention，再把结果拼回来。**

```text
输入 X（seq_len, D）
  → 对每个头 h：
        Q_h = X · W_Q_h
        K_h = X · W_K_h
        V_h = X · W_V_h
        计算 attention
  → 所有头的结果拼起来
  → 通过一个输出投影
```

为什么多头有用？
- 不同头可能学到不同的"关注模式"：
  - 一个头关注语法
  - 一个头关注指代
  - 一个头关注位置距离
- 相当于让模型"多角度理解"同一句话

### 4. LayerNorm：稳定每一层

归一化的目的是让每一层的激活值分布不要过炸或过小。

LayerNorm 做法：

```text
对每个向量：
  先算该向量的均值和方差
  用它们做标准化（变成均值 0、方差 1）
  再乘一个可学习的缩放 + 平移（gamma、beta）
```

```text
y = gamma · (x - mean) / sqrt(var + eps) + beta
```

作用：
- 让深层网络训练稳定
- 防止某层数值过大/过小

### 5. 残差连接：给梯度一条"捷径"

每个子层（attention 或 MLP）都带一个"旁路"：

```text
output = layer(x) + x
```

- `layer(x)` 是子层的结果
- `+ x` 是直接把输入加上去（残差）

好处：
- 梯度可以直接通过 x 那一支传回去，避免消失
- 即使子层学到的东西很少，信息也不会丢

### 6. 前馈网络（FFN / MLP）

attention 负责"聚合上下文"，FFN 负责"逐位置深度处理"：

```text
h = attention_output + x        # 残差
h = LayerNorm(h)
ffn_output = MLP(h)             # 通常两层线性 + 激活
output = ffn_output + h         # 残差
```

FFN 形如：

```text
MLP(x) = W₂ · ReLU(W₁ · x + b₁) + b₂
```

- attention 是"跨 token"的
- FFN 是"逐 token"的
- 两者互补

### 7. 完整 Transformer Block

一个 Block = 两个子层 + 各自归一化 + 残差：

```text
输入 x
  ↓
attention(x) → 残差 → LayerNorm
  ↓
MLP(x) → 残差 → LayerNorm
  ↓
输出（进入下一个 Block / 输出层）
```

### 8. Decoder-only 模型如何变成语言模型

现代大模型（GPT、LLaMA、DeepSeek、Qwen）大多用 **decoder-only**：

```text
输入 token ids
  → Embedding
  → 位置编码
  → Transformer Block × N 层
  → 最后一层输出（隐藏状态）
  → 映射到 logits（词表大小）
  → softmax → 预测下一个 token 的概率
```

关键点：
- 输入和输出共享同一串 token
- 每一步只基于"之前 + 当前"的 token
- 所以训练任务就是"给定前面的词，预测下一个词"

---

## 五、最小实现 / 伪代码

### 1. 手写一个简化 Transformer Block

```python
import numpy as np

def layer_norm(x, gamma, beta, eps=1e-6):
    mean = x.mean(axis=-1, keepdims=True)
    var = x.var(axis=-1, keepdims=True)
    return gamma * (x - mean) / np.sqrt(var + eps) + beta

def relu(x):
    return np.maximum(0, x)

def causal_self_attention(X, W_Q, W_K, W_V):
    seq_len, d_model = X.shape
    d_k = W_Q.shape[-1]

    Q = X @ W_Q   # (seq_len, d_k)
    K = X @ W_K
    V = X @ W_V

    scores = Q @ K.T / np.sqrt(d_k)

    mask = np.triu(np.ones((seq_len, seq_len)), k=1) * -1e9
    scores = scores + mask

    exp_scores = np.exp(scores - scores.max(axis=-1, keepdims=True))
    weights = exp_scores / exp_scores.sum(axis=-1, keepdims=True)

    return weights @ V, weights

def transformer_block(X, W_Q, W_K, W_V, W_O, W1, b1, W2, b2, gamma1, beta1, gamma2, beta2):
    # 子层 1：attention
    attn_out, _ = causal_self_attention(X, W_Q, W_K, W_V)
    attn_out = attn_out @ W_O
    x = X + attn_out                        # 残差
    x = layer_norm(x, gamma1, beta1)        # 归一化

    # 子层 2：FFN
    ffn_out = relu(x @ W1 + b1) @ W2 + b2
    x = x + ffn_out                         # 残差
    x = layer_norm(x, gamma2, beta2)        # 归一化

    return x
```

### 2. 演示一个 Block 能跑通

```python
np.random.seed(0)
seq_len, d_model = 4, 8
d_k = 8

# 随机初始化参数（真实训练会学到）
W_Q = np.random.randn(d_model, d_k) * 0.1
W_K = np.random.randn(d_model, d_k) * 0.1
W_V = np.random.randn(d_model, d_k) * 0.1
W_O = np.random.randn(d_k, d_model) * 0.1
W1  = np.random.randn(d_model, 16) * 0.1   # FFN 中间层 16 维
b1  = np.zeros(16)
W2  = np.random.randn(16, d_model) * 0.1
b2  = np.zeros(d_model)
gamma1 = np.ones(d_model)
beta1  = np.zeros(d_model)
gamma2 = np.ones(d_model)
beta2  = np.zeros(d_model)

X = np.random.randn(seq_len, d_model)
out = transformer_block(X, W_Q, W_K, W_V, W_O, W1, b1, W2, b2, gamma1, beta1, gamma2, beta2)
print(out.shape)  # (4, 8)  ← 形状保持，内容被更新
```

关键观察：
- Block 的输入输出形状相同
- 因此可以一个接一个叠加 N 层
- 每层的输出都"更深入地理解了上下文"

---

## 六、复杂度与边界

1. **attention 的 O(n²) 是主要成本，FFN 是参数大头**
   - attention：序列长度决定成本
   - FFN：隐藏层维度决定参数数量

2. **Causal Mask 是训练/推理一致性的保证**
   - 训练时必须遮未来，推理时也不能看未来
   - 否则"训练能抄答案，推理不能" → 严重不一致

3. **LayerNorm 的顺序有多种变体**
   - Pre-LN vs Post-LN
   - 现代模型多用 Pre-LN（更稳定）
   - 属于实现细节，但影响训练稳定性

4. **残差连接不改变信息量，改变流动方式**
   - 即使子层退化，信息也能通过残差直达

---

## 七、论文与真实系统映射

这一章是 Transformer 论文《Attention Is All You Need》的核心结构，加上 decoder-only 语言模型的现代主流变体。

在真实模型里：
- LLaMA / GPT / DeepSeek / Qwen 的结构大体都是：embedding → N 个 decoder block → LM head
- 区别主要在：归一化位置、激活函数（GELU）、RoPE 位置编码、GQA/MQA
- 你看到的"说模型有多少层"，就是指 Transformer Block 的数量

在真实 Agent 系统里：
- 上下文压缩、KV Cache、长上下文这些概念，全部建立在"Transformer 一层层处理序列"之上
- "看到多少上下文"直接决定 Agent 能否正确执行任务

---

## 八、下一章为什么必须接着读

你已经知道：
- 完整 Transformer Block 如何工作
- 模型如何一层层处理 token 序列

但还有最后一个环节没讲：

> 模型最后一层输出的"隐藏状态"，如何变成"下一个词的预测"？

这涉及到 logits、softmax 和**采样（sampling）**。

- `../02-transformer/04-logits与sampling.md`

这也是"从模型到生成"的最后一步：模型终于能吐出下一个词了。

---

## 一句话结论

> **Causal Mask 保证模型只看过去和现在，LayerNorm 和残差让深层训练稳定，FFN 提供逐位置深度变换。它们的组合就是 Transformer Block，而 decoder-only 模型就是把它叠起来做"预测下一个词"。**