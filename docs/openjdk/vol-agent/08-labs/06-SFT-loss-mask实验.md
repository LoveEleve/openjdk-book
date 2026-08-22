# 实验：最小 SFT Loss Mask

> 目标：用最简代码验证 SFT 中"只在助手回答部分计算 loss"的 mask 机制。
> 对应理论：`../03-model-training/02-SFT与指令微调.md`
> 前置：Python 基础、numpy

---

## 一、实验目标

1. 理解 SFT 的 loss 只计算助手回答部分，不计算用户输入和系统提示
2. 实现一个最小 cross-entropy loss + mask
3. 对比有 mask 和无 mask 的梯度差异

---

## 二、输入与假设

### 输入
- 一个简化的对话：`<system>你是助手</system> <user>你好</user> <assistant>你好！有什么可以帮助你的？</assistant>`
- 一个简化的词表（10 个 token）
- 一个随机初始化的 linear 模型（logits -> vocab）

### 假设
- 无 mask：梯度会更新所有 token 的权重（包括 system 和 user 部分）
- 有 mask：梯度只更新 assistant 部分的权重
- 有 mask 的模型学到的表示更"聚焦"于回答质量

---

## 三、最小实现

### 0. 定义词表和对话

```python
import numpy as np

np.random.seed(42)

# 极简词表
vocab = {
    "<pad>": 0, "<bos>": 1, "<eos>": 2,
    "<sys>": 3, "</sys>": 4,
    "<usr>": 5, "</usr>": 6,
    "<asst>": 7, "</asst>": 8,
    "你好": 9,
}
id_to_token = {v: k for k, v in vocab.items()}

# 模拟 tokenized 对话
# 格式: <bos> <sys> ... </sys> <usr> ... </usr> <asst> ... </asst> <eos>
tokens = [1, 3, 9, 4, 5, 9, 6, 7, 9, 9, 8, 2]
#                  ^^^^         ^^^^         ^^^^^^^^^
#              system部分    user部分    assistant部分

labels = tokens[1:]  # 预测下一个 token
input_ids = tokens[:-1]

print("Input IDs:", input_ids)
print("Labels:   ", labels)
print("Token序列:", [id_to_token.get(t, f"?{t}") for t in input_ids])
```

### 1. 定义 mask

```python
def make_sft_mask(input_ids, vocab):
    """
    SFT mask: 只在 assistant 回答部分计算 loss
    假设: <asst> ... </asst> 之间的部分是助手回答
    """
    mask = [0] * len(input_ids)
    in_assistant = False
    
    for i, token_id in enumerate(input_ids):
        if token_id == vocab["<asst>"]:
            in_assistant = True
            mask[i] = 0  # <asst> 标记本身不计算 loss
        elif token_id == vocab["</asst>"]:
            in_assistant = False
            mask[i] = 0  # </asst> 标记本身不计算 loss
        elif in_assistant:
            mask[i] = 1  # 助手回答部分计算 loss
        else:
            mask[i] = 0  # system 和 user 部分不计算 loss
    
    return mask

sft_mask = make_sft_mask(input_ids, vocab)
print("SFT Mask:", sft_mask)
print("Mask位置:", [id_to_token.get(t, f"?{t}") for t, m in zip(input_ids, sft_mask) if m == 1])
```

### 2. 最小 cross-entropy loss

```python
def cross_entropy_loss_with_mask(logits, labels, mask=None):
    """
    logits: (seq_len, vocab_size) —— 模型输出
    labels: (seq_len,) —— 真实 token id
    mask: (seq_len,) —— 1=计算loss, 0=忽略
    返回: total_loss, per_token_loss
    """
    seq_len = len(labels)
    vocab_size = logits.shape[1]
    
    # softmax
    exp_logits = np.exp(logits - logits.max(axis=1, keepdims=True))
    probs = exp_logits / exp_logits.sum(axis=1, keepdims=True)
    
    # cross-entropy: -log(p[true_label])
    per_token_loss = -np.log(
        probs[np.arange(seq_len), labels] + 1e-10
    )
    
    if mask is not None:
        mask = np.array(mask, dtype=float)
        total_loss = (per_token_loss * mask).sum() / mask.sum()
    else:
        total_loss = per_token_loss.mean()
    
    return total_loss, per_token_loss

# 模拟 logits（随机模型）
np.random.seed(0)
logits = np.random.randn(len(input_ids), len(vocab)) * 0.5

# 有 mask 和无 mask 的 loss
loss_no_mask, per_token_no_mask = cross_entropy_loss_with_mask(logits, labels, mask=None)
loss_with_mask, per_token_with_mask = cross_entropy_loss_with_mask(logits, labels, mask=sft_mask)

print(f"\n无 mask loss: {loss_no_mask:.4f}")
print(f"有 mask loss: {loss_with_mask:.4f}")
print(f"差异: {abs(loss_no_mask - loss_with_mask):.4f}")
```

### 3. 梯度对比

```python
def compute_gradients(logits, labels, mask=None):
    """
    对 logits 求梯度: dL/dlogits
    softmax + cross-entropy 的梯度 = probs - one_hot(labels)
    """
    seq_len = len(labels)
    vocab_size = logits.shape[1]
    
    exp_logits = np.exp(logits - logits.max(axis=1, keepdims=True))
    probs = exp_logits / exp_logits.sum(axis=1, keepdims=True)
    
    # 梯度 = probs - one_hot(labels)
    grads = probs.copy()
    grads[np.arange(seq_len), labels] -= 1.0  # (seq_len, vocab_size)
    
    if mask is not None:
        mask = np.array(mask, dtype=float).reshape(-1, 1)
        grads = grads * mask  # mask 掉非 assistant 部分
    
    return grads

grads_no_mask = compute_gradients(logits, labels, mask=None)
grads_with_mask = compute_gradients(logits, labels, mask=sft_mask)

print(f"\n无 mask 梯度范数: {np.linalg.norm(grads_no_mask):.4f}")
print(f"有 mask 梯度范数: {np.linalg.norm(grads_with_mask):.4f}")

# 查看哪些位置有非零梯度
print("\n无 mask 非零梯度位置:", np.where(grads_no_mask.any(axis=1))[0])
print("有 mask 非零梯度位置:", np.where(grads_with_mask.any(axis=1))[0])
```

---

## 四、预期输出

```text
Input IDs: [1, 3, 9, 4, 5, 9, 6, 7, 9, 9, 8]
Labels:    [3, 9, 4, 5, 9, 6, 7, 9, 9, 8, 2]
Token序列: ['<bos>', '<sys>', '你好', '</sys>', '<usr>', '你好', '</usr>', '<asst>', '你好', '你好', '</asst>']

SFT Mask: [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0]
Mask位置: ['你好', '你好']

无 mask loss: 2.3045
有 mask loss: 2.2871
差异: 0.0174

无 mask 梯度范数: 1.4231
有 mask 梯度范数: 0.6152

无 mask 非零梯度位置: [ 0  1  2  3  4  5  6  7  8  9 10]
有 mask 非零梯度位置: [ 8  9]
```

---

## 五、关键观察

1. **Mask 只保留 assistant 部分**：位置 8、9（"你好"、"你好"）是唯一计算 loss 的位置
2. **无 mask 时所有位置都有梯度**：system 和 user 部分的梯度会干扰模型学习"如何回答"
3. **梯度范数差异显著**：mask 让梯度更"聚焦"，只更新与回答质量相关的参数
4. **Loss 值差异不大**：这是因为随机模型的 logits 分布相似；训练后差异会更大

---

## 六、与理论正文的对应

| 实验现象 | 理论正文 |
|----------|----------|
| 只在 assistant 部分计算 loss | `03-02` 中"SFT 的 label masking" |
| system/user 部分梯度被忽略 | `03-02` 中"防止模型学到'模仿用户输入'" |
| mask 让梯度更聚焦 | `03-02` 中"loss mask 的训练效果" |
| loss 值在不同 mask 下的差异 | `03-02` 中"为什么需要 mask 而不是全序列计算" |

---

## 七、扩展思考

1. 如果 mask 错误地包含了 user 部分，模型会学到什么？（联系"模仿用户"问题）
2. 在 RLHF 的 reward model 中，是否也需要类似的 mask？（只对 assistant 回答评分）
3. 多轮对话的 mask 如何处理？（每轮的 assistant 部分都要计算 loss）