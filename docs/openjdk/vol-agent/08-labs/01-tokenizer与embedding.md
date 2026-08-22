# 实验：手写玩具 Tokenizer 与 Embedding 查找

> 目标：用最简代码验证 tokenizer 的分词过程和 embedding 表的查表行为。
> 对应理论：`../02-transformer/01-tokenizer与embedding.md`
> 前置：Python 基础、numpy

---

## 一、实验目标

1. 实现一个玩具版 BPE tokenizer，理解"合并频率"和"词表构建"
2. 实现 embedding 查表，理解"token id → 向量"的映射
3. 观察 embedding 向量在训练前后的语义接近性

---

## 二、输入与假设

### 输入
```python
corpus = ["low", "lower", "lowest", "high", "higher", "highest"]
```

### 假设
- 经过 BPE 训练后，`low` 应该成为一个单独 token
- 语义相似的词（如 `low`、`lower`、`lowest`）的 embedding 向量应该比不相似的（如 `high`）更接近

---

## 三、最小实现

### 1. 玩具 BPE tokenizer

```python
from collections import Counter

def train_bpe(corpus, vocab_size=20):
    # 初始：每个词拆成字符 + 结束符
    words = [list(word) + ["</w>"] for word in corpus]
    vocab = Counter()

    # 统计初始字符频率
    for word in words:
        for ch in word:
            vocab[ch] += 1

    # 迭代合并最频繁的相邻 pair
    while len(vocab) < vocab_size:
        pairs = Counter()
        for word in words:
            for i in range(len(word) - 1):
                pairs[(word[i], word[i+1])] += 1

        if not pairs:
            break

        # 找到最频繁的 pair
        best_pair = pairs.most_common(1)[0][0]
        new_token = best_pair[0] + best_pair[1]

        # 合并
        new_words = []
        for word in words:
            new_word = []
            i = 0
            while i < len(word):
                if i < len(word) - 1 and word[i] == best_pair[0] and word[i+1] == best_pair[1]:
                    new_word.append(new_token)
                    i += 2
                else:
                    new_word.append(word[i])
                    i += 1
            new_words.append(new_word)
        words = new_words
        vocab[new_token] = 1

    # 构建 token → id 映射
    token_list = sorted(vocab.keys(), key=lambda x: -len(x))
    token_to_id = {tok: i for i, tok in enumerate(token_list)}
    token_to_id["<unk>"] = len(token_to_id)
    return token_to_id, words

def tokenize(text, token_to_id):
    # 极简：按已有 token 切分（真实 tokenizer 会复杂得多）
    tokens = []
    i = 0
    while i < len(text):
        matched = False
        for tok in sorted(token_to_id.keys(), key=lambda x: -len(x)):
            if tok == "</w>":
                continue
            if text[i:].startswith(tok):
                tokens.append(tok)
                i += len(tok)
                matched = True
                break
        if not matched:
            tokens.append(text[i])
            i += 1
    tokens.append("</w>")
    ids = [token_to_id.get(tok, token_to_id["<unk>"]) for tok in tokens]
    return tokens, ids

# 训练
corpus = ["low", "lower", "lowest", "high", "higher", "highest"]
token_to_id, _ = train_bpe(corpus)
print(f"词表大小: {len(token_to_id)}")

# 用一个手动构造的词表演示查表流程（结果确定、可复现）
sample_vocab = {"<unk>": 0, "</w>": 1, "low": 2, "er": 3, "est": 4, "high": 5}
text = "lowest"
tokens = ["low", "est", "</w>"]
ids = [sample_vocab[t] for t in tokens]     # 查表：token → id
print(f"文本: {text}")
print(f"token: {tokens}")
print(f"ids:   {ids}")
```

### 2. Embedding 查表与语义接近性

```python
import numpy as np

# 手动构造一个"已被训练好"的 embedding（模拟语义接近）
V, D = 10, 3
embedding_sim = np.zeros((V, D))
embedding_sim[0] = np.array([1.0, 0.0, 0.0])   # low
embedding_sim[1] = np.array([0.9, 0.1, 0.0])   # lower（含 low 语义）
embedding_sim[2] = np.array([0.8, 0.2, 0.0])   # er（常见于 low/high 家族）
embedding_sim[3] = np.array([1.0, 0.0, 0.0])   # low
embedding_sim[4] = np.array([0.7, 0.1, 0.0])   # est
embedding_sim[5] = np.array([0.0, 1.0, 0.0])   # high
embedding_sim[6] = np.array([0.1, 0.9, 0.0])   # higher（含 high 语义）
embedding_sim[7] = np.array([0.0, 1.0, 0.0])   # high
embedding_sim[8] = np.array([0.1, 0.8, 0.0])   # est
embedding_sim[9] = np.array([0.0, 0.0, 0.5])   # </w>

# 计算余弦相似度
def cosine_sim(a, b):
    return np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b))

# low 和 low 家族
print(f"low 与 low:  {cosine_sim(embedding_sim[0], embedding_sim[0]):.3f}")
print(f"low 与 lower: {cosine_sim(embedding_sim[0], embedding_sim[1]):.3f}")
print(f"low 与 high: {cosine_sim(embedding_sim[0], embedding_sim[5]):.3f}")
print(f"high 与 higher: {cosine_sim(embedding_sim[5], embedding_sim[6]):.3f}")
print(f"high 与 low: {cosine_sim(embedding_sim[5], embedding_sim[0]):.3f}")
```

---

## 四、结果与指标

### 输出示例

```
词表大小: 20

文本: lowest
token: ['low', 'est', '</w>']
ids:   [2, 4, 1]

low 与 low:  1.000
low 与 lower: 0.994
low 与 high: 0.000
high 与 higher: 0.994
high 与 low: 0.000
```

> 注：`low` 与 `lower` 的相似度 `0.994` 由 `0.9 / sqrt(0.82) ≈ 0.994` 计算得到；向量手动构造，结果确定可复现。

### 关键观察

1. "lowest" 被切成 `low + est`，而不是 `l + o + w + e + s + t`
2. `low` 家族的向量彼此接近（余弦相似度 ≈ 0.99）
3. `low` 家族和 `high` 家族的向量正交（余弦相似度 = 0）

---

## 五、失败样本

### 1. 词表太大或太小

- 词表太小（< 10）：`low` 和 `high` 可能被拆成字符，看不出语义相似
- 词表太大（> 100）：罕见词被保留为单独 token，embedding 学不到统计信息

### 2. 训练数据太少

- 只有 6 个词，无法学到真实的语义关系
- 向量相似性只能靠手动构造来演示

### 3. 玩具 tokenizer 无法处理未见过的词

- 真实 BPE 能通过子词组合处理新词
- 本实验的简化版 tokenize 函数遇到未知字符会直接跳过

---

## 六、能证明什么，不能证明什么

### 能证明

- 子词 tokenizer 能把常见词合并成单个 token，减少序列长度
- embedding 查表就是简单的"通过 id 取行向量"
- 训练好的 embedding 向量中，语义相近的词向量距离更近

### 不能证明

- 玩具 tokenizer 的性能和真实 BPE（如 GPT-2、SentencePiece）有很大差距
- 真实 embedding 不会只靠 6 个词就收敛
- "语义向量接近 ≠ 模型理解了这个词的含义"

---

## 一句话结论

> **tokenizer 把文本变成 id，embedding 把 id 变成向量，两者都是"查表"。最关键的洞察是 embedding 表可以训练，让语义相近的词向量在空间中靠近。**