# Tokenizer 与 Embedding：文本如何变成模型看得懂的向量

> 前置：`../00-prerequisites/00-1-计算机与数据.md`、`../01-foundations/01-向量矩阵与神经网络.md`
> 本篇任务：把"字符串"变成 token id，再把 token id 变成向量，完成模型前向计算的第一个入口。

---

## 一、这一章真正的问题

回顾 `01-01`：神经网络的输入是向量。

但语言模型的"原始输入"是字符串：

```text
"今天天气很好"
```

两者之间隔着一大段路。

这一章要回答：

1. 文本怎么切分成最小的单元（token）？
2. token 怎么变成模型能查的数字（token id）？
3. token id 怎么变成向量（embedding）？
4. 为什么不能直接给模型喂字符或单词？

---

## 二、最小前置知识

- 理解文本本质上是一串数字编号（`00-1`）
- 理解向量和矩阵（`01-01`）
- 不害怕查表

---

## 三、直觉方案为什么不够好

### 直觉方案 1：直接把字符当输入

> 每个字符一个数字，"你好" → [你, 好] → 两个数字。

问题：
- 每种语言的字符集不同（英文 26，中文几万）
- 字符本身没有语义（"猫"这个字不代表"猫"的词义）
- 序列太长，模型难以处理

### 直觉方案 2：直接按单词切

> 每个单词一个编号，"今天/天气/很好" → [12, 88, 3]

问题：
- 单词量巨大（英语动辄上百万，含变形、组合）
- 没见过的词（OOV）无法处理
- "playing / played / plays" 被当成完全不同的东西

### 直觉方案 3：one-hot 独热编码

> 每个 token 一个超长向量，只在自身位置为 1。

问题：
- 向量维度 = 词表大小，几十万维，爆炸
- 任意两个 token 的向量都正交，**完全看不出语义相似**

所以需要更聪明的方案：子词切分 + 可学习的 embedding 向量。

---

## 四、正式机制

### 1. token：切分后的最小单元

tokenizer 的工作就是：把文本切分成 token。

三种粒度：

| 粒度 | 例子 | 优点 | 缺点 |
|------|------|------|------|
| 字符 | "h-e-l-l-o" | 词表小 | 序列长、无语义 |
| 单词 | "hello", "world" | 有语义 | 词表大、OOV |
| 子词 | "hello", "world" 或 "play", "ing" | 折中 | 需要训练切分规则 |

现代大模型几乎都用**子词（subword）**。

### 2. BPE：子词切分是怎么训练的

BPE（Byte Pair Encoding）是最常见的子词算法。

核心思路：
1. 先把文本拆成一个个字符
2. 统计最常出现的相邻字符组合
3. 把它们合并成一个 token
4. 重复直到达到词表大小

举例（简化）：

```text
"low lower lowest" ~> "low", "lowe", "lowest"
第一次合并："lo" 常出现 → 变成一个 token
之后（简化）："low" 变成一个 token
最后词表里有：l,o,w,low,er,lower,est,lowest ...
```

训练完之后：
- 常见词 → 一个 token
- 罕见词 → 拆成几个子词 token
- 新词 → 也能被子词拼出来，OOV 问题基本消失

### 3. token id：给 token 编个号

训练好 tokenizer 后，把所有 token 收集成一张**词表（vocabulary）**。

每个 token 在表里的位置，就是它的 **token id**。

```text
词表：
0: <unk>   （未知）
1: <s>     （句首）
2: </s>    （句尾）
3: "今天"
4: "天气"
5: "很好"
...

"今天天气很好" → [3, 4, 5]
```

注意几个特殊 token：
- `<unk>`：没见过的 token 兜底
- `<bos>` / `<eos>`：句子开始 / 结束
- `<pad>`：批量时把不同长度补齐

### 4. embedding：token id → 向量

token id 只是整数，还需要变成向量。

方法：一张 **embedding 查找表（embedding table）**。

```text
形状：词表大小 × 向量维度
例如：V × D
```

token id = 3 → 查表第 3 行 → 得到一个 D 维向量。

关键点：

> embedding 表是**可学习的参数**，训练过程中每个词的向量会不断被调整，最终让语义相近的词向量接近。

这就是"语义向量化"的名场面：
- "猫" 和 "狗" 的向量接近
- "国王" - "男人" + "女人" ≈ "女王"

### 5. 完整链路

```text
文本
  → tokenizer 切分
  → token 序列
  → 查词表得到 token id
  → 查 embedding 表得到向量序列
  → 送入神经网络
```

形状变化：

```text
"今天天气很好"
  → 3 个 token
  → token ids: [3, 4, 5]
  → embedding 张量: (3, D)   ← 3 个 D 维向量
```

这就是模型前向计算的真正入口。

---

## 五、最小实现 / 伪代码

### 1. 玩具版 tokenizer

```python
# 极简版：直接按词切分（真实系统用子词）

tokens = ["今天", "天气", "很好"]

# 建词表
vocab = {"<unk>": 0, "<s>": 1, "</s>": 2}
for i, tok in enumerate(tokens):
    vocab[tok] = i + 3   # 3 开始分配

print(vocab)
# {'<unk>': 0, '<s>': 1, '</s>': 2, '今天': 3, '天气': 4, '很好': 5}

# 文本 → token ids
text = "今天天气很好"
ids = [vocab.get(tok, 0) for tok in tokens]
print(ids)  # [3, 4, 5]
```

### 2. 玩具版 embedding 查找

```python
import numpy as np

# 假设词表 6 个 token，向量维度 4
V, D = 6, 4

# 随机初始化 embedding 表（真实训练时会被学习）
embedding_table = np.random.randn(V, D)

# token ids：今天(3) 天气(4) 很好(5)
ids = [3, 4, 5]

# 查表
vectors = np.stack([embedding_table[i] for i in ids])
print(vectors.shape)  # (3, 4)  ← 3 个 token，每个 4 维向量
```

### 3. 一个更接近真实的视角

```python
# numpy 的索引天然支持批量查表
vectors = embedding_table[ids]
print(vectors.shape)  # (3, 4)
```

这就是 embedding 查找的全部。后面所有 Transformer 中间张量，都会带着这样清晰的 shape。

---

## 六、复杂度与边界

1. **词表大小决定模型入口规模**
   - 词表几万到几十万，embedding 表就是 词表大小 × 维度 的巨大矩阵
   - 这是模型参数量的大头之一

2. **embedding 维度需要平衡**
   - 太小：表达不了语义
   - 太大：参数膨胀、训练难收敛
   - 常见 512 ~ 4096

3. **tokenizer 决定"一个词被切成几段"**
   - token 越多，序列越长，计算越贵
   - 不同语言的 token 效率差别很大（同一句话英文可能 5 token，中文 3 token）

4. **`<unk>` 是兜底不是万灵药**
   - 大量 `<unk>` 说明 tokenizer 没训练好
   - 子词已基本消除 OOV，但仍需保留未知兜底

---

## 七、论文与真实系统映射

BPE 子词的核心思想来自论文：
- "Neural Machine Translation of Rare Words with Subword Units"（Sennrich et al. 2015）
- GPT-2 / GPT-3 / LLaMA / DeepSeek 都用子词 tokenizer

在真实模型里：
- 词表大小常见 32k（GPT-2）到 128k+（DeepSeek-V3）
- 中文多用中文字符级 + BPE 混合
- 特殊 token 数量随能力和协议扩展（如工具调用的 `<tool_call>`）

在真实 Agent 系统里：
- token 数直接影响成本和上下文预算
- 工具参数、系统提示、会话历史最终都会变成 token 序列
- 后面 `04-inference` 会讲 KV Cache 和成本，token 是基本计量单位

---

## 八、下一章为什么必须接着读

你已经知道：
- 文本 → token → token id → embedding 向量

但向量本身还不能做复杂的推理。

一个"向量序列"进入模型后，第一件要做事是：**让每个 token 知道自己该关注哪些上下文。**

这就引出了 Transformer 最核心的机制：

- `../02-transformer/02-attention机制.md`

它会把"向量序列"升级成"带上下文的表示"，这也是 Attention Is All You Need 那篇论文的主角。

---

## 一句话结论

> **模型看到的世界，既不是字符也不是单词，而是经过 tokenizer 切分、查表得到的向量序列。tokenizer 决定粒度，embedding 表提供可学习的语义向量，两者共同构成模型前向计算的入口。**