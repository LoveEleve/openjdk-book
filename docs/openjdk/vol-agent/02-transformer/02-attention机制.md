# Attention 机制：Token 如何选择自己该关心的上下文

> 前置：`01-tokenizer与embedding.md`、`../01-foundations/01-向量矩阵与神经网络.md`、`../00-prerequisites/00-4-概率与分布直觉.md`
> 本篇任务：理解 Query / Key / Value，以及 Scaled Dot-Product Attention 的核心计算。

---

## 一、这一章真正的问题

上一章我们得到了一串向量：

```text
[J_A, J_B, J_C]   ← 每个 token 一个 D 维向量
```

但这里有个问题：

> 每个向量目前只代表"这个词本身"，不代表"这个词在这个句子里的意思"。

例如"苹果"：
- 在"我想吃苹果"里，是水果
- 在"苹果发布了新手机"里，是公司

同一个词，含义取决于上下文。

所以这一章要回答：

1. 一个 token 如何才能"感知"到其他 token？
2. Query / Key / Value 分别是什么？
3. 注意力权重怎么算出来的？
4. 为什么叫"Scaled Dot-Product Attention"？

---

## 二、最小前置知识

- 理解 embedding 向量（`02-01`）
- 理解矩阵乘法、向量点积（`01-01`）
- 理解软 max 把分数变概率（`00-4`）
- 认识"缩放（scale）"

---

## 三、直觉方案为什么不够好

### 直觉方案 1：把所有向量加起来

> 让每个 token 都等于整句话向量的平均。

问题：
- 所有词变成同一个向量，信息全揉在一起
- 无法区分"谁对谁更重要"

### 直觉方案 2：固定取相邻词的向量

> 每个 token 只看左边邻居。

问题：
- 长距离关系无法捕捉（"苹果"和"公司"可能隔很远）
- 关系的"强度"也固定死了

attention 的核心突破在于：

> **让每个 token 自己决定：我该重点看哪些 token，每个看多少。**
> 而且这个决策是可学习的。

---

## 四、正式机制

### 1. 注意力要回答的问题

对句子中的每个 token（我叫它 **query token**），我们要计算：

> 它和句子中其他 token（我叫它们 **key tokens**）的**相关程度**。

相关程度高的，就多关注；相关程度低的，就少关注。

### 2. 三个角色：Query / Key / Value

为了让模型"可学习"地决定谁关注谁，Transformer 给每个 token 准备了三个投影向量：

- **Query（Q）**：我想找什么样的上下文
- **Key（K）**：我能提供什么样的上下文
- **Value（V）**：如果被关注，我实际给出去的内容

理解方式：
- 用 Q 和 K 比较 → 算出"你们俩相关吗"
- 把相关度变成权重
- 用权重把所有 V 加权求和 → 得到融合了上下文的表示

### 3. 计算步骤

假设输入是 $X$，形状是 `(序列长度, 向量维度)`。

#### 第一步：投影得到 Q / K / V

```text
Q = X · W_Q
K = X · W_K
V = X · W_V
```

- $W_Q, W_K, W_V$ 都是可学习的权重矩阵
- Q、K、V 形状都是 `(序列长度, 头维度)`

#### 第二步：Q 和 K 点积，计算相关度分数

```text
score[i, j] = Q[i] · K[j]
```

- `score[i, j]`：第 i 个 query 和第 j 个 key 的相关程度
- 全部组合起来是一个 `(序列长度, 序列长度)` 矩阵

#### 第三步：缩放

```text
score = score / sqrt(d_k)
```

- $d_k$ 是 key 的向量维度
- 为什么缩放？点积的数值会随维度变大，缩放可以避免 softmax 输入过大导致梯度问题

#### 第四步：softmax 归一化成注意力权重

```text
weights = softmax(score)   # 对每一行做 softmax
```

- 每行的权重加起来 = 1
- 表示"第 i 个 token 对每个位置关注多少"

#### 第五步：权重加权求和 Value

```text
output[i] = sum_j weights[i, j] · V[j]
```

- 输出形状：`(序列长度, 头维度)`

### 4. 完整公式（Attention Is All You Need 原文）

$$\text{Attention}(Q, K, V) = \text{softmax}\left(\frac{QK^T}{\sqrt{d_k}}\right) V$$

其中：
- $QK^T$：所有 query 和 key 两两点积
- $\div \sqrt{d_k}$：缩放
- softmax：按行归一化成权重
- $\times V$：加权求和

### 5. 一个具体的数字例子

假设 4 个 token，向量维度 2。

```text
输入 X（4×2）：
  token0: [1, 0]
  token1: [0, 1]
  token2: [1, 1]
  token3: [0, 0]

为了简单，假设和学习已经很好，Q=K=V=X。
```

计算 `Q·K^T`（2 维内积）：

```text
        t0   t1   t2   t3
t0      [1, 0]·[1, 0] = 1
t0,t1   [1, 0]·[0, 1] = 0
...
完整矩阵：
        t0  t1  t2  t3
t0      1   0   1   0
t1      0   1   1   0
t2      1   1   2   0
t3      0   0   0   0
```

对第一行 `[1, 0, 1, 0]` 做 softmax：

```text
exp: [2.72, 1.0, 2.72, 1.0]
和:  7.44
权重: [0.37, 0.13, 0.37, 0.13]
```

输出：
```text
output[0] = 0.37·t0 + 0.13·t1 + 0.37·t2 + 0.13·t3
          = 0.37·[1,0] + 0.13·[0,1] + 0.37·[1,1] + 0.13·[0,0]
          = [0.74, 0.50]
```

token0 的新表示，就是融合了全部 token 的加权结果。

### 6. 为什么起作用

权重被训练出来之后：
- 相关的 token 权重高
- 不相关的权重低
- 每个 token 的输出变成"自身 + 相关上下文"的混合

这就是"带上下文的表示"。

---

## 五、最小实现 / 伪代码

### 1. 手写 Scaled Dot-Product Attention

```python
import numpy as np

def scaled_dot_product_attention(Q, K, V):
    # Q, K, V 形状：(seq_len, d_k)
    d_k = Q.shape[-1]

    # 1. 点积：所有 query 和 key 两两计算
    scores = Q @ K.T               # (seq_len, seq_len)

    # 2. 缩放
    scores = scores / np.sqrt(d_k)

    # 3. softmax（沿行归一化）
    exp_scores = np.exp(scores - scores.max(axis=-1, keepdims=True))  # 数值稳定
    weights = exp_scores / exp_scores.sum(axis=-1, keepdims=True)

    # 4. 加权求和 V
    output = weights @ V            # (seq_len, d_k)
    return output, weights

# 测试
np.random.seed(0)
seq_len, d_k = 4, 2
X = np.random.randn(seq_len, d_k)
W_Q = np.eye(d_k)   # 简化：不投影
W_K = np.eye(d_k)
W_V = np.eye(d_k)

Q = X @ W_Q
K = X @ W_K
V = X @ W_V

out, w = scaled_dot_product_attention(Q, K, V)
print(f"输出形状: {out.shape}")     # (4, 2)
print(f"权重形状: {w.shape}")       # (4, 4)
print(f"第 0 行权重和: {w[0].sum():.3f}")   # 1.000（softmax 归一化验证）
```

### 2. Causal Mask 预告

`weights` 现在允许 token 看"未来"，这在语言模型里是不允许的。

下一篇会讲 causal mask，它只改动一处：

```python
mask = np.triu(np.ones((seq_len, seq_len)), k=1)  # 上三角为 1
scores = scores - 1e9 * mask  # 未来的位置给一个极小值，softmax 后≈0
```

先留个印象，下一篇专门展开。

---

## 六、复杂度与边界

1. **注意力是 O(n²) 的**
   - n 是序列长度
   - 每个 token 要和其他所有 token 两两计算
   - 序列越长，成本平方级上涨

2. **点积的数值范围随维度增长**
   - 维度越大，点积越大，softmax 可能进入饱和区
   - 这就是要除以 $\sqrt{d_k}$ 的原因

3. **Q / K / V 投影来自同一个 X**
   - 是"自注意力（self-attention）"
   - X 既当 query 又当 key 和 value

4. **注意力是"软"加权，不是硬选择**
   - 是概率式混合，不是"只看某一个"
   - 这是它的强大之处，也是它计算量大的来源

---

## 七、论文与真实系统映射

这一章就是论文《Attention Is All You Need》（Vaswani et al. 2017）的核心内容，arXiv 号 `1706.03762`。

在真实模型里：
- 大模型底层计算大量是 attention
- 语言模型最关键的约束之一就是 attention 的 O(n²) 成本
- 后面 FlashAttention、KV Cache、注意力变体（GQA、MQA、SWA）都在优化 attention

在真实 Agent 系统里：
- 上下文长度直接决定 Agent 能"看到"多少历史和工具结果
- 每个 Agent turn 都是对历史 ROI 的一次 attention

---

## 八、下一章为什么必须接着读

你已经知道：
- Q / K / V 如何形成注意力权重
- 注意力如何把上下文融合进表示

但还有两个问题没解决：

1. **语言模型只能从左到右看，不能偷看未来**
   → 需要 causal mask

2. **attention 只是 Transformer 的一部分，还有归一化、MLP、残差连接**
   → 需要完整的 Transformer block

这两个问题就是：

- `../02-transformer/03-causal-mask与transformer-block.md`

它会把 attention 拼成真正能工作的 Transformer 块，并让它学会"预测下一个词"。

---

## 一句话结论

> **Attention 让每个 token 通过 Q/K 与自己关注的上下文建立权重，再用权重加权 V 得到融合表示。它是 Transformer 让模型"理解上下文"的核心机制，也是后续无数优化的原点。**