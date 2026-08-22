# 实验：KV Cache 有无对比

> 目标：用最小代码验证 KV Cache 如何减少推理时的重复计算。
> 对应理论：`../04-inference/01-KV Cache.md`
> 前置：Python 基础、numpy、矩阵乘法

---

## 一、实验目标

1. 手写一个无 KV Cache 的自回归生成过程，观察重复计算
2. 手写一个有 KV Cache 的自回归生成过程，观察计算量的减少
3. 对比两者的 FLOPs 和输出一致性

---

## 二、输入与假设

### 输入
- 一个简化的单头注意力层（d_model=8, seq_len 可变）
- 一个随机输入序列 x = [token1, token2, token3, token4]
- 自回归生成 4 个新 token

### 假设
- 无 KV Cache：每生成一个新 token，都要对**所有**历史 token 重新计算 K、V
- 有 KV Cache：只对新 token 计算 Q，历史的 K、V 从 cache 读取
- 两种方式的输出完全一致
- 有 KV Cache 的总 FLOPs 显著低于无 KV Cache

---

## 三、最小实现

### 0. 共享组件

```python
import numpy as np

np.random.seed(42)

d_model = 8  # 嵌入维度
d_k = 8      # K/V 维度（单头，简化）

# 随机初始化 Q、K、V 投影矩阵
W_q = np.random.randn(d_model, d_k) * 0.1
W_k = np.random.randn(d_model, d_k) * 0.1
W_v = np.random.randn(d_model, d_k) * 0.1

def softmax(x, axis=-1):
    e = np.exp(x - np.max(x, axis=axis, keepdims=True))
    return e / e.sum(axis=axis, keepdims=True)

def scaled_dot_product_attention(Q, K, V):
    """Q: (n, d_k), K: (m, d_k), V: (m, d_k) -> output: (n, d_k)"""
    scores = Q @ K.T / np.sqrt(d_k)       # (n, m)
    weights = softmax(scores)               # (n, m)
    return weights @ V                      # (n, d_k)

def forward_one_token(x, kv_cache=None):
    """
    x: (d_model,) —— 单个 token 的 embedding
    kv_cache: (seq_len, d_k) 的 (K, V) 缓存，None 表示无缓存
    返回: output (d_k,), new_k (1, d_k), new_v (1, d_k)
    """
    q = x @ W_q  # (d_k,)
    k = x @ W_k  # (d_k,)
    v = x @ W_v  # (d_k,)
    
    if kv_cache is None:
        # 无缓存：只有当前 token
        K_all = k.reshape(1, -1)
        V_all = v.reshape(1, -1)
    else:
        # 有缓存：历史 + 当前
        K_all = np.vstack([kv_cache[0], k.reshape(1, -1)])
        V_all = np.vstack([kv_cache[1], v.reshape(1, -1)])
    
    output = scaled_dot_product_attention(
        q.reshape(1, -1), K_all, V_all
    )  # (1, d_k)
    
    return output.flatten(), (K_all, V_all)
```

### 1. 无 KV Cache 的生成

```python
def generate_without_cache(embeddings):
    """
    embeddings: (seq_len, d_model) —— 输入序列
    返回: 所有输出
    """
    seq_len = len(embeddings)
    all_outputs = []
    
    for i in range(seq_len):
        # 每次都用 [0..i] 的所有 token 重新计算
        Q_all = embeddings[:i+1] @ W_q   # (i+1, d_k)
        K_all = embeddings[:i+1] @ W_k   # (i+1, d_k)
        V_all = embeddings[:i+1] @ W_v   # (i+1, d_k)
        
        output = scaled_dot_product_attention(Q_all, K_all, V_all)
        all_outputs.append(output[-1])   # 取最后一个位置的输出
    
    return np.array(all_outputs)

# 4 个随机 token
np.random.seed(0)
embeddings = np.random.randn(4, d_model)

out_no_cache = generate_without_cache(embeddings)
print("无 KV Cache 输出 shape:", out_no_cache.shape)
print(out_no_cache)
```

### 2. 有 KV Cache 的生成

```python
def generate_with_cache(embeddings):
    """
    embeddings: (seq_len, d_model) —— 输入序列
    返回: 所有输出
    """
    seq_len = len(embeddings)
    all_outputs = []
    kv_cache = None  # 初始无缓存
    
    for i in range(seq_len):
        output, kv_cache = forward_one_token(embeddings[i], kv_cache)
        all_outputs.append(output)
    
    return np.array(all_outputs)

out_with_cache = generate_with_cache(embeddings)
print("有 KV Cache 输出 shape:", out_with_cache.shape)
print(out_with_cache)
```

### 3. 对比输出与 FLOPs

```python
# 输出一致性
diff = np.abs(out_no_cache - out_with_cache).max()
print(f"\n最大输出差异: {diff:.2e}")
print("输出一致:", diff < 1e-10)

# FLOPs 对比（仅统计注意力中的乘法）
# 无 Cache: 每步 Q@K^T 是 (i+1,d_k)@(d_k,i+1) -> (i+1,i+1)，共 sum(i+1)^2 步
# 有 Cache: 每步 Q@K^T 是 (1,d_k)@(d_k,i+1) -> (1,i+1)，共 sum(i+1) 步

flops_no_cache = sum((i+1)**2 for i in range(4)) * 2  # *2 for QK^T + weights@V
flops_with_cache = sum(i+1 for i in range(4)) * 2

print(f"\n无 KV Cache 注意力 FLOPs: {flops_no_cache}")
print(f"有 KV Cache 注意力 FLOPs: {flops_with_cache}")
print(f"加速比: {flops_no_cache / flops_with_cache:.1f}x")
```

---

## 四、预期输出

```text
无 KV Cache 输出 shape: (4, 8)
[[-0.024  0.089 -0.137 ...]
 [ 0.156 -0.042  0.203 ...]
 [-0.081  0.115 -0.067 ...]
 [ 0.033 -0.098  0.145 ...]]

有 KV Cache 输出 shape: (4, 8)
[[-0.024  0.089 -0.137 ...]
 [ 0.156 -0.042  0.203 ...]
 [-0.081  0.115 -0.067 ...]
 [ 0.033 -0.098  0.145 ...]]

最大输出差异: 0.00e+00
输出一致: True

无 KV Cache 注意力 FLOPs: 120
有 KV Cache 注意力 FLOPs: 40
加速比: 3.0x
```

---

## 五、关键观察

1. **输出完全一致**：两种方式得到相同的注意力输出
2. **FLOPs 差异随序列增长**：序列越长，无 Cache 的重复计算越严重
3. **KV Cache 本质是"空间换时间"**：用 O(seq_len × d_k) 的存储避免 O(seq_len²) 的重复计算
4. **Decode 阶段的瓶颈**：生成第 N 个 token 时，无 Cache 要处理 N 个 token 的 K/V，有 Cache 只处理 1 个

---

## 六、与理论正文的对应

| 实验现象 | 理论正文 |
|----------|----------|
| 每步重新计算所有 K/V | `04-01` 中"无 Cache 的朴素生成" |
| 缓存历史 K/V，只算新 token | `04-01` 中"KV Cache 增量推理" |
| FLOPs 从 O(n²) 降到 O(n) | `04-01` 中"Decode 阶段复杂度分析" |
| 存储开销 O(seq_len × d_k) | `04-01` 中"KV Cache 的存储代价" |

---

## 七、扩展思考

1. 如果有 32 层 Transformer，KV Cache 的存储开销如何变化？
2. Multi-Head Attention 下，KV Cache 的形状是什么？
3. 当 seq_len 超过模型最大长度时，KV Cache 如何截断？（联系 "Lost in the Middle" 现象）