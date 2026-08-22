# RLHF 与 DPO：让模型学会"什么该说、什么不该说"

> 前置：`02-SFT与指令微调.md`
> 本篇任务：理解 RLHF 和 DPO 两种对齐方法，以及它们为什么是 SFT 之后的关键步骤。

---

## 一、这一章真正的问题

SFT 之后的模型已经能"按指令回答"了，但还有一个问题：

> 模型不知道"什么该说、什么不该说"。

SFT 模型可能：
- 输出有害内容
- 编造不存在的"事实"（幻觉）
- 拒绝回答它应该回答的问题

所以需要**对齐（Alignment）**：让模型学会"符合人类偏好的输出"。

这一章要回答：
1. 为什么 SFT 不够？
2. RLHF 的三阶段是什么？
3. DPO 如何简化 RLHF？
4. 对齐的风险和局限是什么？

---

## 二、最小前置知识

- 理解 SFT 数据格式和训练方式
- 理解"偏好"的概念：甲比乙好
- 理解奖励和惩罚的基本概念

---

## 三、直觉方案为什么不够好

### 直觉方案 1：直接告诉模型"这是错的"

> 在 SFT 数据里加入"不要输出有害内容"的指令。

问题：
- 模型可能会在某些情况下遵守，但无法泛化到所有情况
- 复杂边界（如"什么时候该拒绝"）无法通过简单指令覆盖

### 直觉方案 2：用规则过滤输出

> 在模型输出后，用规则检查是否合规，不合规就重试。

问题：
- 无法覆盖模型输出的所有可能性
- 规则是"硬"的，无法处理模糊边界
- 不改变模型本身，只是表面过滤

---

## 四、正式机制

### 1. RLHF：三阶段训练

RLHF（Reinforcement Learning from Human Feedback）分为三个阶段：

#### 阶段一：SFT
- 用高质量指令数据做 SFT
- 得到一个"能按指令回答"的基础模型

#### 阶段二：训练奖励模型

- 对同一问题，让模型生成多个回答
- 让人类标注：哪个回答更好
- 用这些偏好数据训练一个**奖励模型（Reward Model）**
- 奖励模型的输入：问题 + 回答
- 奖励模型的输出：一个分数，表示"这个回答有多好"

#### 阶段三：用 PPO 强化学习

- 用奖励模型给 SFT 模型的输出打分
- 用 PPO（Proximal Policy Optimization）算法更新 SFT 模型
- 让模型学会：输出更"高奖励"的回答

### 2. RLHF 的问题

- 复杂：需要训练奖励模型 + 跑 PPO
- 不稳定：PPO 超参数敏感，容易崩溃
- 昂贵：需要维护多个模型

### 3. DPO：直接偏好优化

DPO（Direct Preference Optimization）的核心发现：

> 奖励模型阶段可以省略——偏好信息可以直接用于训练语言模型。

DPO 的做法：
- 输入：一对回答（chosen / rejected）
- 目标：让模型更倾向于输出"被偏好的回答"
- 只需要一个简单的分类损失函数

### 4. DPO 的直觉

DPO 的目标函数可以理解为：

```text
让模型在"被偏好的回答"上给更高的概率
让模型在"不被偏好的回答"上给更低的概率
```

它不需要显式的奖励模型，而是把"偏好"直接编码进训练目标里。

### 5. RLHF vs DPO

| 维度 | RLHF | DPO |
|------|------|-----|
| 组件 | SFT + RM + PPO | SFT + DPO loss |
| 复杂度 | 高 | 低 |
| 稳定性 | 低 | 高 |
| 效果 | 好 | 与 RLHF 相当 |
| 当前使用 | RLHF 和 DPO 都在广泛使用 | 后者使用者越来越多 |

---

## 五、最小实现 / 伪代码

### 1. DPO 损失函数示意

```python
import numpy as np

def dpo_loss(chosen_logps, rejected_logps, beta=0.1):
    """
    chosen_logps: 偏好回答的对数概率（标量）
    rejected_logps: 不偏好回答的对数概率（标量）
    beta: 控制偏差强度
    """
    # 偏好回答和不偏好回答的"差距"
    diff = chosen_logps - rejected_logps
    # DPO 损失
    loss = -np.log(1 / (1 + np.exp(-beta * diff)))
    return loss

# 模拟
chosen_prob = 0.8      # 偏好回答的概率
rejected_prob = 0.2    # 不偏好回答的概率

chosen_logp = np.log(chosen_prob)
rejected_logp = np.log(rejected_prob)

loss = dpo_loss(chosen_logp, rejected_logp)
print(f"chosen prob: {chosen_prob}, rejected prob: {rejected_prob}")
print(f"DPO loss: {loss:.4f}")

# 如果模型对偏好回答给的概率更高，loss 应该更小
chosen_prob_better = 0.95
rejected_prob_lower = 0.05
chosen_logp2 = np.log(chosen_prob_better)
rejected_logp2 = np.log(rejected_prob_lower)
loss2 = dpo_loss(chosen_logp2, rejected_logp2)
print(f"\nchosen prob: {chosen_prob_better}, rejected prob: {rejected_prob_lower}")
print(f"DPO loss: {loss2:.4f}（更小，说明模型学得更好）")
```

### 2. 偏好数据格式

```json
{
  "prompt": "什么是 Attention？",
  "chosen": "Attention 是一种让模型关注输入中的相关部分……",
  "rejected": "Attention 是深度学习中的一种技术……（编造事实）"
}
```

---

## 六、复杂度与边界

1. **对齐是必要的，但不是万能的**
   - 对齐让模型更安全、更有用
   - 但不能消除所有风险

2. **偏好数据存在偏见**
   - 标注者的偏好可能不一致
   - 数据偏见会在对齐过程中被放大

3. **过度对齐可能导致模型"过于谨慎"**
   - 模型拒绝回答它本可以回答的问题
   - 需要在安全性和有用性之间平衡

4. **DPO 不是 RLHF 的完全替代品**
   - 在某些复杂任务上，RLHF 可能仍然更好
   - 两种方法都在持续改进

---

## 七、论文与真实系统映射

- **InstructGPT**（Ouyang et al. 2022）：首次将 RLHF 成功应用于大语言模型
- **DPO**（Rafailov et al. 2023）：提出直接偏好优化，简化对齐流程
- **Constitutional AI**：用 AI 自己生成偏好数据，减少人工标注

在真实系统里：
- ChatGPT 使用 RLHF 对齐
- LLaMA-2-Chat 使用 RLHF
- DeepSeek 使用 DPO 对齐
- Qwen 使用 DPO + RLHF 混合

---

## 八、下一章为什么必须接着读

你已经知道：
- RLHF 和 DPO 把模型对齐到人类偏好
- 对齐让模型更安全、更有用

但还有一个非常重要的问题：

> 对于绝大多数开发者来说，从头训练一个模型是不现实的。
> 我们如何在有限的资源下微调模型？

这就是：

- `../03-model-training/04-LoRA与参数高效微调.md`

它会在不改变模型全部参数的情况下，用极低的成本完成微调和对齐，让"小团队也能微调大模型"成为可能。

---

## 一句话结论

> **RLHF 和 DPO 让模型学会"什么该说、什么不该说"。RLHF 复杂但经典，DPO 简单且高效。两者都是对齐（alignment）的核心方法，使模型从"能说"变成"说对"。**