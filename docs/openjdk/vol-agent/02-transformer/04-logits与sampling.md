# Logits 与 Sampling：模型如何吐出一个词

> 前置：`03-causal-mask与transformer-block.md`、`../00-prerequisites/00-4-概率与分布直觉.md`、`../01-foundations/03-交叉熵与语言建模目标.md`
> 本篇任务：理解 hidden state 如何变成 logits，以及 temperature、top-k、top-p 等采样策略如何决定"选哪个词"。

---

## 一、这一章真正的问题

上一章我们已经走完了：

```text
文本 → token → embedding → Transformer Block × N 层
```

但还差最后一步没落地：

> 模型最后一层输出的向量，如何变成"下一个词"？

这一章要回答：

1. 隐藏状态（hidden state）怎么变成 logits？
2. 为什么不能直接"选概率最高的词"，而是要采样？
3. temperature 在调什么？
4. top-k 和 top-p 分别在干什么？
5. greedy、采样、beam search 有什么本质区别？

---

## 二、最小前置知识

- 理解 softmax 把分数变概率（`00-4`、`01-03`）
- 理解概率分布的总和为 1（`00-4`）
- 理解"概率高 ≠ 事实正确"（`00-4`）

---

## 三、直觉方案为什么不够好

### 直觉方案 1：每次都选概率最高的词

> 反正模型给了概率，选最高的那个就行。

这在确定性任务里合理，但在生成任务里：
- 结果永远一样，非常死板
- 一旦一步选错，后续全错（错误累积）
- 对话、写作、创意任务都需要多样性

### 直觉方案 2：完全均匀随机

> 按概率公平地随机挑一个。

这个也不对：
- 太随机，质量崩坏
- "猫" 和 "狗" 都 10%，再低概率的词也可能被选中

所以正确的做法是**在 greedy 和完全随机之间调节**：让模型"倾向于"高概率词，但保留一定随机性。

---

## 四、正式机制

### 1. 隐藏状态 → logits

Transformer 最后一层输出的一串向量是隐藏状态。

要把它们变成"词表大小的分数"，需要一个**输出投影**：

```text
logits = hidden_state · W_LM_head
```

- 隐藏状态：`(seq_len, d_model)`
- 输出投影矩阵 `W_LM_head`：`(d_model, 词表大小)`
- logits：`(seq_len, 词表大小)`

最后一个 token 的 logits，就是"预测下一个词"的分数向量。

### 2. logits → 概率

```text
probs = softmax(logits)
```

- probs 每个元素 ≥ 0
- 总和 = 1

### 3. 解码前先处理一下分数：多样性的开关

#### temperature（温度）

在做 softmax 之前，先把 logits 除以一个 temperature：

```text
logits_t = logits / temperature
```

- `temperature = 1`：不变
- `temperature < 1`：分数差距变大 → 更确定，更接近 greedy
- `temperature > 1`：分数差距变小 → 更随机，更多样

直觉：温度相当于"决策的冷静程度"。
- 低温和 = 冷静、保守、更确定
- 高温度 = 冲动、冒险、更多样

#### top-k：只保留前 k 个候选

把所有候选词按概率排序，只保留前 k 个，其他的概率清零，再重新归一化。

```text
k=3:
原始 probs: 猫0.30  狗0.25  鱼0.15  鸟0.10  鼠0.05 ...
top-3 后:  猫0.30  狗0.25  鱼0.15   [鸟和鼠被清零]
重新归一化
```

作用：
- 避免极低概率词被选中
- 限制候选范围

#### top-p（nucleus / 核心采样）

按概率从高到低累加，直到累积概率达到 p，只在这些词里采样。

```text
p=0.8:
累积:  猫0.30(+0.30)  狗0.25(+0.55)  鱼0.15(+0.70)  鸟0.10(+0.80)  [停]
保留这 4 个，重新归一化，采一个
```

作用：
- 自适应保留"最可能的一簇"
- 比 top-k 更动态

### 4. 采样：从概率分布里抽一个

给一个分布，按概率随机抽一个词：

```python
def sample_from_probs(probs):
    r = random.random()          # [0, 1)
    cum = 0
    for i, p in enumerate(probs):
        cum += p
        if r < cum:
            return i, probs[i]   # 返回选中的词和其概率
```

这就是"按概率采样"。

### 5. 完整生成流程（自回归）

```text
输入："今天天气很"
  → 模型中所有层
  → 最后一个 token 的隐藏状态
  → LM head → logits
  → 温度调整 → top-k/top-p → softmax → 概率分布
  → 采样 → "好"
  → 拼到输入:"今天天气很好"
  → 继续 ...

直到遇到结束 token <eos> 或达到长度上限。
```

每次只生成一个 token，这就是**自回归生成（autoregressive generation）**。

---

## 五、最小实现 / 伪代码

### 1. temperature、top-k、top-p 的完整示例

```python
import numpy as np

def softmax(logits):
    exp_logits = np.exp(logits - np.max(logits))  # 数值稳定
    return exp_logits / exp_logits.sum()

def apply_temperature(logits, temperature):
    return logits / temperature

def apply_top_k(logits, k):
    if len(logits) <= k:
        return logits
    threshold = np.sort(logits)[-k]     # 第 k 大的值
    masked = logits.copy()
    masked[masked < threshold] = -1e9   # 低于阈值的位置清零
    return masked

def apply_top_p(logits, p):
    sorted_idx = np.argsort(logits)[::-1]  # 从高到低排序
    cumsum = np.cumsum(softmax(logits)[sorted_idx])
    cutoff = cumsum > p
    cutoff_pos = np.where(cutoff)[0][0] if cutoff.any() else len(sorted_idx)
    keep = sorted_idx[:cutoff_pos + 1]
    masked = np.full_like(logits, -1e9)
    masked[keep] = logits[keep]
    return masked

def sample(logits):
    probs = softmax(logits)
    return int(np.random.choice(len(probs), p=probs))

# 示例 logits（词表 5）
logits = np.array([2.0, 0.5, 1.2, -0.3, 0.8])

# 不同温度下的概率
for t in [0.5, 1.0, 2.0]:
    probs = softmax(apply_temperature(logits, t))
    print(f"temp={t}: {np.round(probs, 3)}")

# top-k
print("top-k=2:", softmax(apply_top_k(logits, 2)))
# top-p
print("top-p=0.8:", softmax(apply_top_p(logits, 0.8)))
```

### 2. 观察不同温度对分布的影响

#### temperature = 0.5（倾向确定）
```text
分数差距放大，概率更"尖锐"，几乎总是选最大词
```

#### temperature = 1.0（默认）
```text
原始分布，概率按 softmax 原始输出
```

#### temperature = 2.0（更多样）
```text
分数差距缩小，概率更"平坦"，低概率词更容易被选中
```

这就是同一个模型，通过调节温度，可以变得"保守"或"有创意"。

---

## 六、复杂度与边界

1. **生成是逐 token 的，不是一次完成**
   - 每多一个词就要再跑一次全模型（除非有 KV Cache）
   - 这就是为什么生成慢、长文本贵

2. **采样是"软选择"，不是"最优解"**
   - 有随机性，所以结果不可完全复现（除非固定 seed）
   - 确定性任务应避免采样

3. **temperature、top-k、top-p 是超参数**
   - 没有绝对最优，取决于任务
   - 客服系统常用低温度，创作常用高温度

4. **top-k 和 top-p 往往一起用**
   - 两者可以叠加：先 top-p 再 top-k，或相反
   - 目的是在"多样性"和"可控性"之间平衡

5. **greedy、sampling、beam search 的区别**
   - **greedy**：每一步选概率最高的词，确定性、无随机性，适合翻译、摘要等需要稳定的任务
   - **sampling**：按概率分布随机选，有随机性，适合对话、创作等需要多样性的任务
   - **beam search**：每一步保留 k 个候选路径，结束时选总体概率最高的路径。比 greedy 更全局，但计算量更大。适合翻译、语音识别等追求全局最优的解码任务

---

## 七、论文与真实系统映射

- greedy / sampling / temperature / top-k / top-p 是所有 LLM 推理的自带能力
- Hugging Face 的 `generate()`、OpenAI 的 API 参数、本地推理框架都有这些开关
- 论文中"解码策略"常出现在采样对比实验里

在真实 Agent 系统里：
- coding agent 通常用低温度（更确定）
- 创意任务用高温度
- Agent 的"错误回注"、"重试"都要配合合适的解码策略

---

## 八、下一章为什么必须接着读

到这里，`02-transformer` 的最小闭环已经完成：

```text
tokenizer → embedding → attention → causal mask → block → logits → sampling
```

你终于可以完整回答：一个 token 如何变成下一个 token。

但这只是"前向计算"的大心脏。真正的现代 LLM 还差一块拼图：

- **位置编码**：模型怎么知道"前后左右"的顺序
- **KV Cache、RoPE、GQA**：性能与长上下文如何优化

下一站会进入训练与推理的系统部分：

- `03-model-training/`：预训练、SFT、RLHF、DPO
- `04-inference/`：KV Cache、batching、量化

你的"模型最小闭环"已经建立，接下来就是往真实工程靠拢。

---

## 一句话结论

> **模型把最后一个 token 的隐藏状态映射成词表的 logits，经过温度、top-k、top-p 调节后用 softmax 变概率，再采样出一个词。自回归地一位一位生成，就完成了"模型会说话"的全部闭环。**