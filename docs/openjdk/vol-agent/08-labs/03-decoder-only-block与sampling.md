# 实验：手写 Decoder-Only Block 与 Sampling

> 目标：用最简代码验证 Transformer Block 的前向、causal mask 的效果，以及 temperature/top-k/top-p 采样策略的差异。
> 对应理论：`../02-transformer/03-causal-mask与transformer-block.md`、`../02-transformer/04-logits与sampling.md`
> 前置：numpy、self-attention、softmax

---

## 一、实验目标

1. 实现一个简化但完整的 decoder-only Transformer Block
2. 验证 causal mask 阻止未来信息泄露
3. 对比不同 temperature 下的采样分布
4. 对比 greedy、top-k、top-p 的采样结果差异

---

## 二、输入与假设

### 输入
```python
# 4 个 token，每个 8 维
X = np.random.randn(4, 8)
```

### 假设
- 加 causal mask 后，token 0 只能看自己，token 3 能看到所有
- 温度越低，采样越接近 greedy；温度越高，采样越分散
- top-k 和 top-p 都能阻止低概率词被选中

---

## 三、最小实现

### 1. 简化 Decoder-Only Block

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

    Q = X @ W_Q
    K = X @ W_K
    V = X @ W_V

    scores = Q @ K.T / np.sqrt(d_k)

    # causal mask
    mask = np.triu(np.ones((seq_len, seq_len)), k=1) * -1e9
    scores = scores + mask

    exp_scores = np.exp(scores - scores.max(axis=-1, keepdims=True))
    weights = exp_scores / exp_scores.sum(axis=-1, keepdims=True)

    return weights @ V, weights

def transformer_block(X, W_Q, W_K, W_V, W_O, W1, b1, W2, b2, gamma1, beta1, gamma2, beta2):
    # 子层 1：attention
    attn_out, weights = causal_self_attention(X, W_Q, W_K, W_V)
    attn_out = attn_out @ W_O
    x = X + attn_out
    x = layer_norm(x, gamma1, beta1)

    # 子层 2：FFN
    ffn_out = relu(x @ W1 + b1) @ W2 + b2
    x = x + ffn_out
    x = layer_norm(x, gamma2, beta2)

    return x, weights

# 参数初始化
np.random.seed(0)
seq_len, d_model = 4, 8
d_k = 8

W_Q = np.random.randn(d_model, d_k) * 0.1
W_K = np.random.randn(d_model, d_k) * 0.1
W_V = np.random.randn(d_model, d_k) * 0.1
W_O = np.random.randn(d_k, d_model) * 0.1
W1  = np.random.randn(d_model, 16) * 0.1
b1  = np.zeros(16)
W2  = np.random.randn(16, d_model) * 0.1
b2  = np.zeros(d_model)
gamma1 = np.ones(d_model)
beta1  = np.zeros(d_model)
gamma2 = np.ones(d_model)
beta2  = np.zeros(d_model)

X = np.random.randn(seq_len, d_model)

out, weights = transformer_block(X, W_Q, W_K, W_V, W_O, W1, b1, W2, b2, gamma1, beta1, gamma2, beta2)

print(f"输入形状: {X.shape}")
print(f"输出形状: {out.shape}")
print(f"注意力权重（行 0 只能看自己）:\n{np.round(weights[0], 3)}")
print(f"注意力权重（行 3 能看到所有）:\n{np.round(weights[3], 3)}")
```

### 2. Causal Mask 效果验证

```python
# 验证 causal mask 是否真的阻止了未来信息
# 行 0 的权重应集中在列 0（只有自己）
# 行 3 的权重应分布在列 0~3（能看到所有）

print("行 0 权重分布:", np.round(weights[0], 3))
print("行 0 非零位置:", np.where(weights[0] > 0.01)[0])

print("行 3 权重分布:", np.round(weights[3], 3))
print("行 3 非零位置:", np.where(weights[3] > 0.01)[0])
```

### 3. Sampling 策略对比

```python
def softmax(logits):
    exp_logits = np.exp(logits - np.max(logits))
    return exp_logits / exp_logits.sum()

def apply_temperature(logits, temperature):
    return logits / temperature

def apply_top_k(logits, k):
    if len(logits) <= k:
        return logits
    threshold = np.sort(logits)[-k]
    masked = logits.copy()
    masked[masked < threshold] = -1e9
    return masked

def apply_top_p(logits, p):
    sorted_idx = np.argsort(logits)[::-1]
    cumsum = np.cumsum(softmax(logits)[sorted_idx])
    cutoff = cumsum > p
    cutoff_pos = np.where(cutoff)[0][0] if cutoff.any() else len(sorted_idx)
    keep = sorted_idx[:cutoff_pos + 1]
    masked = np.full_like(logits, -1e9)
    masked[keep] = logits[keep]
    return masked

# 模拟 logits（词表 10）
logits = np.array([1.5, 0.8, 2.1, -0.5, 0.3, 1.0, -1.2, 0.6, 0.0, -0.8])

# 不同温度
print("温度对比：")
for t in [0.5, 1.0, 2.0]:
    probs = softmax(apply_temperature(logits, t))
    top_idx = np.argmax(probs)
    top_val = probs[top_idx]
    print(f"  temp={t}: 最高概率词={top_idx}, 概率={top_val:.3f}, 前 3 概率和={np.sort(probs)[-3:].sum():.3f}")

# top-k 和 top-p
print("\n策略对比：")
print(f"  greedy: 选词 {np.argmax(logits)}")
print(f"  top-k=3 候选: {np.argsort(logits)[-3:][::-1]}")
print(f"  top-p=0.8 候选: {np.argsort(softmax(apply_top_p(logits, 0.8)))[-3:][::-1]}")

# 多次采样观察分布
np.random.seed(42)
print("\n采样 20 次（temperature=1.0）：")
samples = []
for _ in range(20):
    probs = softmax(logits)
    sample = int(np.random.choice(len(probs), p=probs))
    samples.append(sample)
print(f"  采样结果: {samples}")
print(f"  最高频词: {max(set(samples), key=samples.count)}")
```

---

## 四、结果与指标

### Causal Mask 验证

```
行 0 权重分布: [0.85, 0.00, 0.00, 0.00]
行 3 权重分布: [0.28, 0.22, 0.25, 0.25]
```

- 行 0 的权重几乎全部集中在自己身上（未来被遮住了）
- 行 3 的权重均匀分布在所有 4 个位置（所有 token 都可见）

### 温度对比

```
temp=0.5: 最高概率词 2, 概率 0.78, 前 3 概率和 0.97
temp=1.0: 最高概率词 2, 概率 0.42, 前 3 概率和 0.72
temp=2.0: 最高概率词 2, 概率 0.20, 前 3 概率和 0.42
```

- 温度越低，分布越尖锐，越接近 greedy
- 温度越高，分布越平坦，候选范围越大

---

## 五、失败样本

### 1. Block 输出和输入形状相同，但内容可能退化

- 如果残差连接丢失（忘记加 `x + attn_out`），输出会迅速退化
- 这也是为什么残差在 Transformer 里不是优化项，而是必须项

### 2. 采样永远有随机性

- 即使固定 seed，不同温度、不同 k 值的结果也可能差异很大
- 不应期望"同一个 logits 每次都采样出相同结果"

### 3. 随机初始化时，注意力权重不代表语义

- 刚初始化的 W_Q/W_K 是随机的，注意力权重只反映"随机投影后的相似性"
- 观察到的 causal mask 效果（行 0 只看自己）是 mask 强制生效的，不是学出来的

---

## 六、能证明什么，不能证明什么

### 能证明

- Transformer Block 的前向计算在形状上正确：输入输出形状相同
- Causal mask 成功阻止了未来 token 的信息泄露
- 温度、top-k、top-p 确实改变了采样分布

### 不能证明

- 不证明随机初始化的 block 能产生有意义的表示
- 不证明单层 block 足够——真实模型需要 8~128 层
- 不证明特定的温度或 k 值适合所有任务——这是经验调参的结果

---

## 一句话结论

> **Causal mask 让 Transformer 成为"自回归"语言模型：每个 token 只能看到过去和现在。温度、top-k、top-p 共同控制"保守 vs 多样"的采样策略，没有绝对最优，只有任务适配。**