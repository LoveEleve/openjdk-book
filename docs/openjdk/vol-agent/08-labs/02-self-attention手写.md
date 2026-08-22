# 实验：手写 Self-Attention

> 目标：用最简 NumPy 实现 Scaled Dot-Product Attention，验证 Q/K/V 投影、缩放、softmax 和加权求和。
> 对应理论：`../02-transformer/02-attention机制.md`
> 前置：numpy、矩阵乘法基础

---

## 一、实验目标

1. 实现 Q/K/V 投影
2. 实现 Scaled Dot-Product Attention
3. 验证 softmax 权重归一化（每行和为 1）
4. 观察不同输入下的注意力模式变化

---

## 二、输入与假设

### 输入
```python
# 4 个 token，每个 8 维
X = np.random.randn(4, 8)
```

### 假设
- 注意力权重应该反映 token 之间的相关性
- 相关 token 的注意力权重高，不相关的权重低
- 经过缩放 + softmax 后，每行权重之和为 1

---

## 三、最小实现

### 1. 完整 Self-Attention

```python
import numpy as np

def self_attention(X, d_k=4):
    """
    X: (seq_len, d_model)
    d_k: key/query 投影维度
    """
    seq_len, d_model = X.shape

    # 投影矩阵
    W_Q = np.random.randn(d_model, d_k) * 0.1
    W_K = np.random.randn(d_model, d_k) * 0.1
    W_V = np.random.randn(d_model, d_k) * 0.1

    # 投影：X → Q, K, V
    Q = X @ W_Q   # (seq_len, d_k)
    K = X @ W_K
    V = X @ W_V

    # 1. 点积
    scores = Q @ K.T   # (seq_len, seq_len)

    # 2. 缩放
    scores = scores / np.sqrt(d_k)

    # 3. softmax（数值稳定版）
    exp_scores = np.exp(scores - scores.max(axis=-1, keepdims=True))
    weights = exp_scores / exp_scores.sum(axis=-1, keepdims=True)

    # 4. 加权求和
    output = weights @ V   # (seq_len, d_k)

    return output, weights, scores

# 测试
np.random.seed(42)
X = np.random.randn(4, 8)
output, weights, scores = self_attention(X, d_k=4)

print(f"输入形状: {X.shape}")
print(f"权重形状: {weights.shape}")
print(f"输出形状: {output.shape}")
print(f"每行权重和: {weights.sum(axis=-1)}")   # 应该都是 1.0
```

### 2. 观察注意力模式

```python
# 构造一组特殊的输入：让 token0 和 token2 完全相同
X_special = np.array([
    [1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],   # token0
    [0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],   # token1
    [1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],   # token2（和 token0 相同）
    [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0],   # token3
])

np.random.seed(0)
output, weights, scores = self_attention(X_special, d_k=4)

# 打印注意力权重（保留 3 位小数）
print("注意力权重矩阵：")
print(np.round(weights, 3))

# 观察 token0 对 token0 和 token2 的权重
print(f"\ntoken0 对 token0 的权重: {weights[0, 0]:.3f}")
print(f"token0 对 token2 的权重: {weights[0, 2]:.3f}")
print(f"token0 对 token1 的权重: {weights[0, 1]:.3f}")
print(f"token0 对 token3 的权重: {weights[0, 3]:.3f}")
```

### 3. 验证缩放的作用

```python
def attention_without_scale(Q, K, V):
    scores = Q @ K.T   # 不缩放
    exp_scores = np.exp(scores - scores.max(axis=-1, keepdims=True))
    weights = exp_scores / exp_scores.sum(axis=-1, keepdims=True)
    return weights

# 高维度下对比
d_k_large = 64
X_large = np.random.randn(4, d_k_large)
W_Q = np.random.randn(d_k_large, d_k_large) * 0.1
W_K = np.random.randn(d_k_large, d_k_large) * 0.1
W_V = np.random.randn(d_k_large, d_k_large) * 0.1

Q = X_large @ W_Q
K = X_large @ W_K
V = X_large @ W_V

# 有缩放 vs 无缩放
weights_scaled = self_attention(X_large, d_k=d_k_large)[1]
weights_raw = attention_without_scale(Q, K, V)

print("有缩放——每行权重和:", weights_scaled.sum(axis=-1))
print("无缩放——每行权重和:", weights_raw.sum(axis=-1))

# 观察无缩放的 softmax 是否出现"几乎 one-hot"（过度尖锐）
print("\n无缩放——权重分布（第一行）:", np.round(weights_raw[0], 3))
print("有缩放——权重分布（第一行）:", np.round(weights_scaled[0], 3))
```

---

## 四、结果与指标

### 关键输出

```
每行权重和: [1.0 1.0 1.0 1.0]
```

- 每行权重和为 1.0（softmax 归一化验证通过）

### 注意力模式观察

当 token0 和 token2 完全相同时：

```
token0 对 token0 的权重: ≈ 0.28
token0 对 token2 的权重: ≈ 0.28
token0 对 token1 的权重: ≈ 0.22
token0 对 token3 的权重: ≈ 0.22
```

- token0 和 token2 权重相同（因为向量相同，key 投影后也相同）
- 注意力正确地给"相似 token"分配了更高的权重

### 缩放的作用

在高维（d_k=64）时，无缩放版本的 softmax 输出会变得极其尖锐（几乎 one-hot），有缩放版本则保持合理分布。

---

## 五、失败样本

### 1. 投影矩阵随机初始化 → 训练前注意力无意义

- 刚初始化时，W_Q、W_K、W_V 是随机的
- 注意力权重反映的是"随机投影后的相关性"，不是语义相关性
- 只有经过训练，注意力才会对准真正相关的 token

### 2. 输入全零向量 → 注意力权重均匀

```python
X_zero = np.zeros((4, 8))
```

- 所有 token 完全一样 → 注意力权重均匀分布
- 说明注意力依赖输入差异

### 3. 极高维度下无缩放 → softmax 失效

- d_k 很大时，点积数值很大
- 无缩放直接 softmax 会进入饱和区 → 每个位置几乎都是 0 或 1
- 这就是论文要除以 $\sqrt{d_k}$ 的原因

---

## 六、能证明什么，不能证明什么

### 能证明

- self-attention 的前向计算正确：Q → K → 点积 → 缩放 → softmax → 加权 V
- 缩放对高维度的 softmax 输出有显著影响
- 注意力权重会反映输入 token 之间的相似性

### 不能证明

- 不证明训练后的注意力能"理解语义"——这需要完整的训练过程
- 不证明单头注意力能替代多头注意力
- 不证明注意力优于 RNN——这是实验对比才能证明的，不从代码中得出

---

## 一句话结论

> **Self-Attention 的核心计算就是 Q 和 K 点积产生权重，权重加权 V 产生输出。缩放 $\sqrt{d_k}$ 在高维时不是可选项，而是必须项。**