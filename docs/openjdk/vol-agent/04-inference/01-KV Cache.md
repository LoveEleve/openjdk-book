# KV Cache：为什么生成不能每次重算整个上下文

> 前置：`../02-transformer/02-attention机制.md`、`../02-transformer/03-causal-mask与transformer-block.md`
> 本篇任务：理解 KV Cache 的作用，以及它如何让自回归生成从"O(n²) 重算"变成"O(n) 增量"。

---

## 一、这一章真正的问题

回顾 `02-transformer`，自回归生成是逐 token 进行的：

```text
输入："今天天气很"
  → 模型前向 → 预测 "好"
输入："今天天气很好"
  → 模型前向 → 预测下一个
输入："今天天气很好，"
  → 模型前向 → 预测下一个
```

如果每次生成新 token 都重新跑一遍**完整输入**，那么：
- 第 1 步：计算 5 个 token
- 第 2 步：计算 6 个 token
- 第 3 步：计算 7 个 token
- ...
- 第 n 步：计算 n+m 个 token

总计算量 ≈ O(n²)，生成 1000 个 token 就要做约 50 万次 token 前向。这太慢了。

这一章要回答：
1. 每次生成时，哪些计算是"重复"的？
2. KV Cache 是什么？
3. KV Cache 能省多少？
4. 它的显存代价是什么？

---

## 二、最小前置知识

- 理解 attention 中的 Q / K / V（`02-02`）
- 理解自回归生成流程（`02-04`）
- 理解 O(n²) 复杂度

---

## 三、直觉方案为什么不够好

### 直觉方案 1：每次重新算整个上下文

> 反正模型前向就是算一遍整个序列，直接重算就好了。

问题：
- 每个新 token 都重算前面所有 token 的 attention
- 生成 N 个 token 的总复杂度是 O(N²)
- 长文本生成极慢，成本爆炸

### 直觉方案 2：只算最后一个 token 的 new attention

> 新 token 只关注它自己，不用管旧的。

问题：
- attention 需要"当前 token 的 Q 和所有旧 token 的 K、V"做交互
- 旧 token 的 K、V 仍然必须存在，否则无法计算 attention

关键洞察：
> 旧 token 的隐藏状态（从而 K、V）**不会改变**，所以可以缓存起来复用。

---

## 四、正式机制

### 1. 为什么会重复计算

假设现在有 4 个 token 的完整输入，attention 计算如下：

```text
Q = X · W_Q     # (4, d_k)
K = X · W_K     # (4, d_k)
V = X · W_V     # (4, d_k)

scores = Q @ K^T  # (4, 4)
weights = softmax(scores)
output = weights @ V  # (4, d_k)
```

生成第 5 个 token 后，输入变成 5 个 token，K、V 变成 `(5, d_k)`。

注意：
- 前 4 个 token 的 K、V **和第 4 步时完全一样**
- 因为它们对应的隐藏状态没有变化（只有第五个位置的 token 是新增的）

所以没必要重新计算前 4 个 token 的 K、V，直接缓存复用即可。

### 2. KV Cache 是什么

KV Cache = 缓存每一层、每个位置已经算好的 K 和 V。

```text
每一层都有一个缓存：
  K_cache: (已处理 token 数, d_k)
  V_cache: (已处理 token 数, d_k)
```

生成第 5 个 token 时：
1. 只用计算第 5 个 token 的 Q、K、V
2. 把第 5 个 token 的 K、V 追加到缓存
3. 用"全部 Q（只有新 token 的）+ 全部 K、V（缓存）"计算 attention

### 3. 生成过程的两种模式

#### Prefill（预填充）
- 处理完整输入 prompt
- 计算所有输入 token 的 K、V 并构建缓存
- 产生第一个输出 token

#### Decode（解码/生成）
- 逐个生成新 token
- 每次只计算新 token 的 Q、K、V
- 使用缓存加速

### 4. KV Cache 节省多少

没有 KV Cache：每次生成新 token，重算整个序列的 K、V 和 attention。

有 KV Cache：每次生成只算新 token 的 K、V，attention 直接用缓存。

复杂度对比（生成 N 个 token）：

```text
无 KV Cache：O(N²)
有 KV Cache：O(N)   # 每个新 token 只和已缓存 K/V 交互
```

### 5. KV Cache 的代价：显存

KV Cache 不是免费的，它占用显存：

```text
每层 KV 大小 = 2 (K+V) × 序列长度 × 头数 × 头维度 × 2 (字节)
```

对于大模型大上下文，KV Cache 显存可能和模型参数一样大甚至更大。

这也是后面 PagedAttention、量化、长上下文优化要解决的问题。

---

## 五、最小实现 / 伪代码

### 1. 无 KV Cache 的生成（O(N²)）

```python
import numpy as np

def generate_without_cache(model, prompt_ids, max_new_tokens):
    all_ids = prompt_ids.copy()
    for _ in range(max_new_tokens):
        # 每次用完整序列前向
        logits = model.forward(all_ids)      # 重算所有 token
        next_id = np.argmax(logits[-1])      # 取最后一个 token 的 logits
        all_ids.append(next_id)
    return all_ids
```

### 2. 有 KV Cache 的生成（O(N)）

```python
class KVAttention:
    def __init__(self, W_Q, W_K, W_V):
        self.W_Q, self.W_K, self.W_V = W_Q, W_K, W_V
        self.K_cache = None
        self.V_cache = None

    def forward_incremental(self, x):
        # x: 当前新 token 的表示 (1, d_model)
        q = x @ self.W_Q   # (1, d_k)
        k = x @ self.W_K   # (1, d_k)
        v = x @ self.W_V   # (1, d_k)

        # 追加到缓存
        if self.K_cache is None:
            self.K_cache, self.V_cache = k, v
        else:
            self.K_cache = np.concatenate([self.K_cache, k], axis=0)
            self.V_cache = np.concatenate([self.V_cache, v], axis=0)

        # 只用新 token 的 Q 和全部缓存的 K/V 计算 attention
        scores = (q @ self.K_cache.T) / np.sqrt(self.W_Q.shape[-1])
        exp_scores = np.exp(scores - scores.max())
        weights = exp_scores / exp_scores.sum()
        output = weights @ self.V_cache   # (1, d_k)
        return output


def generate_with_cache(model, prompt_ids, max_new_tokens):
    all_ids = prompt_ids.copy()
    # prefill：先处理完整 prompt 构建缓存
    prompt_embeddings = model.embed(prompt_ids)     # prompt 的向量表示
    for x in prompt_embeddings:                     # 逐个 token 构建缓存
        model.attention.forward_incremental(x)

    for _ in range(max_new_tokens):
        logits = model.forward_with_cache(all_ids[-1])  # 只用最后一个 token
        next_id = np.argmax(logits[-1])
        all_ids.append(next_id)
    return all_ids
```

### 3. 复杂度对比（概念演示）

```python
# 无缓存：第 1 步算 5 个，第 2 步算 6 个，... 第 N 步算 N+4 个
def total_compute_without_cache(n):
    return sum(range(5, 5 + n))   # ≈ O(n²)

# 有缓存：prefill 算 5 个，之后每步只算 1 个
def total_compute_with_cache(n):
    return 5 + n - 1              # ≈ O(n)

n = 1000
print(f"无 KV Cache: 约 {total_compute_without_cache(n)} 次 token 前向")
print(f"有 KV Cache: 约 {total_compute_with_cache(n)} 次 token 前向")
```

---

## 六、复杂度与边界

1. **KV Cache 是推理的主要显存瓶颈**
   - 长上下文时，KV 显存可能超过模型本身
   - 这是长上下文部署最核心的成本

2. **KV Cache 无法跨请求复用**
   - 每个请求（session）有自己独立的 KV Cache
   - 除非命中系统的 prefix cache（相同前缀复用）

3. **KV Cache 随序列长度线性增长**
   - 序列越长，缓存越大
   - 需要管理（如 prompt cache、KVCache eviction）

4. **批量时 KV Cache 同时放大**
   - 如果 batch size = B，总 KV = B × 单请求 KV
   - 这引出后面的 PagedAttention 优化

---

## 七、论文与真实系统映射

KV Cache 是现代 LLM Serving 的基础优化，几乎所有推理框架都实现了：
- vLLM 的 PagedAttention 专门优化 KV Cache 的内存管理
- FlashAttention 关注计算和 HBM 读写
- KV Cache 量化进一步降低显存

在真实 Agent 系统里：
- Agent 的每个 turn 都依赖 KV Cache 加速
- 长会话需要高效管理 KV Cache，否则显存迅速耗尽
- 上下文压缩、会话快照、prompt cache 都围绕 KV Cache 展开

---

## 八、下一章为什么必须接着读

你已经知道：
- KV Cache 让生成从 O(n²) 变 O(n)
- 但 KV Cache 本身消耗大量显存

多用户同时使用时，问题更严重：

> 每个请求都有独立的 KV Cache，如果一次处理多个请求，显存怎么分配？

这就是：

- `../04-inference/02-Batching与吞吐.md`

它讲 continuous batching、吞吐、延迟，以及它们如何决定一个服务能同时服务多少用户。

---

## 一句话结论

> **KV Cache 缓存了每一层已算好的 K 和 V，让自回归生成从"每次重算整个上下文"变成"增量计算新 token"，把复杂度从 O(n²) 降到 O(n)。但它以显存为代价，是长上下文推理的主要成本来源。**