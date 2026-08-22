# SFT 与指令微调：从续写模型到指令模型

> 前置：`01-预训练与Scaling.md`
> 本篇任务：理解 SFT（Supervised Fine-Tuning）如何把"续写模型"变成"按指令回答的模型"。

---

## 一、这一章真正的问题

预训练模型很强大，但它有一个"致命问题"：

> 它只会续写，不会回答。

你问它"什么是 Attention？"，它可能继续写"什么是 Attention？这篇文章讲了……"而不是直接回答。

所以需要一个步骤：**把"续写模型"变成"指令模型"**。

这一章要回答：
1. SFT 的数据长什么样？
2. SFT 和预训练有什么本质区别？
3. 为什么 SFT 不需要大规模数据？
4. SFT 的局限和风险是什么？

---

## 二、最小前置知识

- 理解预训练 = 预测下一个 token
- 理解交叉熵损失函数
- 理解训练集、过拟合的概念

---

## 三、直觉方案为什么不够好

### 直觉方案 1：直接给模型写规则

> 把"如何回答问题"写成系统提示。

问题：
- 提示词只能影响输出风格，不能改变模型的知识和能力
- 复杂任务无法通过提示词精确控制

### 直觉方案 2：用预训练数据让模型学会回答

> 预训练数据里包含 Q&A 对，模型应该已经学会了。

问题：
- 预训练数据里 Q&A 对的比例极小
- 模型学到的"续写"模式 > "回答"模式
- 不加显式微调，模型不会主动切换到"回答"模式

---

## 四、正式机制

### 1. SFT 数据格式

SFT 的数据是"指令+回答"对：

```json
{
  "instruction": "什么是 Attention？",
  "output": "Attention 是一种让模型关注输入中相关部分的机制……"
}
```

### 2. SFT 训练时只计算回答部分的 loss

关键区别：**只有回答 token 参与损失计算，指令 token 不参与。**

```text
输入："什么是 Attention？<sep>Attention 是一种……"
                              ↑ 只计算这部分 loss
```

原因是：
- 指令 token 的"预测"不重要（模型不需要学会生成指令）
- 我们只关心模型能否正确生成回答

### 3. SFT 和预训练的区别

| 维度 | 预训练 | SFT |
|------|--------|-----|
| 数据量 | 数万亿 token | 数千到数十万条 |
| 数据来源 | 网页、书籍、代码 | 人工标注、高质量数据 |
| 计算量 | 数千 GPU 天 | 数十 GPU 小时 |
| 目标 | 学习语言规律 | 学习指令跟随 |

### 4. 为什么 SFT 不需要大量数据

SFT 不是"教模型新知识"，而是"教模型如何输出"。

- 预训练已经教会了模型知识
- SFT 只是把知识从"续写模式"切换到"回答模式"
- 所以几千条高质量数据就足够

### 5. SFT 的风险

#### 灾难性遗忘
- 微调时，模型可能会"忘记"预训练时学到的东西
- 解决方法：混合一部分预训练数据一起训练

#### 数据质量严重重要
- 一条低质量 SFT 数据的影响力远大于一条预训练数据
- 错误数据会直接教坏模型

#### 过拟合
- SFT 数据少，容易过拟合
- 表现为：训练 loss 很低，但泛化不好

---

## 五、最小实现 / 伪代码

### 1. SFT loss mask 示意

```python
import numpy as np

def sft_loss(probs, labels, loss_mask):
    """
    probs: (seq_len, vocab_size) 每个位置的 token 概率分布（已 softmax）
    labels: (seq_len) 每个位置的正确答案 id
    loss_mask: (seq_len) 1=参与 loss，0=不参与
    """
    total_loss = 0.0
    total_tokens = 0

    for i in range(len(probs)):
        if loss_mask[i] == 1:
            # 只对回答部分计算交叉熵；注意：probs 必须是概率，
            # 如果是模型输出的 logits，需先 softmax 再取 -log
            ce = -np.log(probs[i, labels[i]])
            total_loss += ce
            total_tokens += 1

    return total_loss / total_tokens

# 模拟
seq_len = 10
loss_mask = [0, 0, 0, 1, 1, 1, 1, 1, 1, 1]
# 前 3 个 token 是指令，不参与 loss
# 后 7 个 token 是回答，参与 loss

print(f"参与 loss 的 token 数: {sum(loss_mask)}")
print(f"不参与 loss 的 token 数: {len(loss_mask) - sum(loss_mask)}")
```

### 2. 对话格式示例

```python
# 多轮对话格式
conversation = [
    {"role": "user", "content": "什么是 Attention？"},
    {"role": "assistant", "content": "Attention 是一种机制，让模型在生成每个 token 时关注输入序列中的相关部分……"},
    {"role": "user", "content": "为什么需要 Attention？"},
    {"role": "assistant", "content": "因为 RNN 在处理长序列时存在梯度消失问题……"},
]

# 训练时，user 消息不参与 loss，assistant 消息参与 loss
```

---

## 六、复杂度与边界

1. **SFT 数据质量比数量更重要**
   - 1000 条高质量数据 > 100 万条低质量数据
   - 数据质量决定了模型上限

2. **SFT 不能解决知识不足的问题**
   - 如果模型训练时没见过的知识，SFT 也不能教会它
   - SFT 只改变"输出方式"，不改变"知识储备"

3. **灾难性遗忘需要预防**
   - 混合预训练数据
   - 较小的学习率
   - 避免过度训练

4. **SFT 后的模型仍然需要对齐**
   - SFT 教模型"如何回答"，但不教模型"什么该回答、什么不该回答"
   - 对齐是下一步（RLHF/DPO）的工作

---

## 七、论文与真实系统映射

SFT 的核心思想来自 InstructGPT 论文（Ouyang et al. 2022）：

- GPT-3 + SFT → InstructGPT
- 效果：1.3B 的 InstructGPT 在评测中超过 175B 的原始 GPT-3

在真实系统里：
- LLaMA 系列、Qwen、DeepSeek 都做了 SFT
- 微调数据量在数万到数十万条不等
- 数据质量是决定模型能力的关键因素

---

## 八、下一章为什么必须接着读

你已经知道：
- SFT 把"续写模型"变成"指令模型"
- 但 SFT 只教"如何回答"，不教"该不该回答"

SFT 后的模型可能会：
- 输出有害内容
- 编造不存在的事实
- 拒绝回答它应该回答的问题

所以需要更进一步的**对齐**：

- `../03-model-training/03-RLHF与DPO.md`

它会把"对错"的判断交给模型，让模型学会"什么该说、什么不该说"。

---

## 一句话结论

> **SFT 用少量高质量指令数据把预训练模型从"续写器"变成"指令跟随者"。它不教新知识，只改变输出方式。数据质量决定 SFT 效果的上限。**