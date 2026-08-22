# InstructGPT 精读：用人类反馈把模型对齐到用户意图

> 论文：Training language models to follow instructions with human feedback（InstructGPT, Ouyang et al. 2022）
> 公开链接：<https://arxiv.org/abs/2203.02155>
> 本地 PDF：`pdfs/2203.02155-InstructGPT-RLHF.pdf`
> 推荐阶段：Phase 3（学完 `03-02-SFT与指令微调.md`、`03-03-RLHF与DPO.md` 后阅读）
> 前置知识：预训练、SFT、奖励模型、强化学习基本概念

---

## 一、论文要解决什么问题

GPT-3 之类的语言模型很强大，但有一个核心问题：

> 模型越大，不代表越会按用户意图做事。

模型可能：
- 生成不真实、有毒或无用的内容
- 不符合用户"想要什么"
- 对指令理解很差

InstructGPT 的核心问题：

> 能不能用人类的反馈，把大语言模型对齐到用户意图，让模型更安全、更有用？

答案是：**SFT + 奖励模型 + RLHF（PPO）** 三阶段对齐。

---

## 二、旧方案哪里不够

### 1. 纯超大模型

- 模型大，但未必"会办事"
- 生成内容与用户意图匹配差
- 1.3B 的模型一旦对齐，可以比 175B 的未对齐模型更有用

### 2. 简单 SFT

- 是"人类演示"的监督学习
- 演示有限，模型学不完全部的"好坏判断"
- 无法把"回答好 vs 回答差"的偏好信息充分利用

### 核心洞察

> 单独扩大模型不够，需要把"人类偏好"作为训练信号。

---

## 三、核心对象与状态

### 对象

| 对象 | 含义 |
|------|------|
| SFT 模型 | 用人类演示做微调的基础模型 |
| Reward Model（RM） | 评估一个回答有多好（是一个独立模型） |
| Policy 模型 | 最终要优化的模型（从 SFT 出发） |
| Preference Data | 人类标注的"哪个回答更好" |

### 状态

三阶段训练：

```text
阶段 1：SFT（人类演示）
阶段 2：训练 Reward Model（人类偏好）
阶段 3：PPO 强化学习优化 Policy
```

---

## 四、关键公式 / 算法

### 1. SFT 阶段

用人类写的高质量演示微调模型，得到 SFT 模型。

### 2. Reward Model 阶段

对同一 prompt，让模型生成多个回答，人工排序：
- 训练 RM 预测"哪个回答更受欢迎"
- 损失：偏好排序（pairwise ranking）loss

RM 输入 = prompt + response
RM 输出 = 一个标量分数（表示质量）

### 3. RLHF / PPO 阶段

论文使用两种目标函数：

**纯 PPO 模型**（gamma=0）：
$$\max_\theta \; E_{x \sim D, y \sim \pi_\theta(y|x)} \left[ r_\phi(x, y) - \beta \log \frac{\pi_\theta(y|x)}{\pi_{\text{SFT}}(y|x)} \right]$$

**PPO-ptx 模型**（论文默认使用的版本）：
$$\max_\theta \; E_{x \sim D, y \sim \pi_\theta(y|x)} \left[ r_\phi(x, y) - \beta \log \frac{\pi_\theta(y|x)}{\pi_{\text{SFT}}(y|x)} \right] + \gamma \; E_{x \sim D_{\text{pretrain}}} \left[ \log \pi_\theta(x) \right]$$

- $r_\phi(x,y)$：Reward Model 给出的分数
- 第二项：KL 约束，防止模型偏离 SFT 模型太远
- 第三项（PPO-ptx）：混合预训练梯度，缓解"对齐税"（让模型在公开 NLP 数据集上不退化太多）

通俗理解：
- 让模型生成更高 RM 分数的回答
- 但不要偏离原始模型太多（KL 惩罚）
- 同时保持预训练能力（pretraining mixing）

### 4. PPO

- PPO（Proximal Policy Optimization）在强化学习中用
- 通过多次采样、更新 policy，最大化期望 reward
- 每次更新幅度受限（clip），保持稳定

---

## 五、实验怎么设计

### 数据

- 标注者写的高质量演示（用于 SFT）
- 标注者对模型回答排序（用于 RM）
- prompts 来自标注者和真实 API 用户

### 模型规模

- 1.3B、6B、175B 三种规模的模型
- 核心结论：对齐 vs 规模独立评估

### 对比基线

- GPT-3（175B，未对齐）
- GPT-3 prompted（加 few-shot 前缀的 GPT-3）
- SFT（仅监督微调，无 RLHF）
- FLAN（在 FLAN 数据集上微调的 GPT-3，约 100 万样本）
- T0（在 T0++ 数据集上微调的 GPT-3，约 100 万样本）
- PPO / PPO-ptx（InstructGPT 自身的两种变体）

### 关键指标

- 人类偏好（标注者判断哪个更好）
- 真实性和毒性
- 在标准 NLP 任务上的回归损失（是否有能力退化）

---

## 六、证据是否支持结论

### 1. 人类偏好

- 1.3B 的 InstructGPT 被标注者认为优于 175B 的 GPT-3
- 结论：对齐效果可能比单纯扩大规模更重要

### 2. 真实性与毒性

- RLHF 后的模型更真实（TruthfulQA 提升）
- 有害输出减少

### 3. 通用能力退化 vs 保留

- 某些标准公开数据集上略有退化
- 但用户主观体验显著提升
- 这与"对齐可能让模型更安全但更保守"的趋势一致

### 结论可信度评估

**强**：这是 RLHF 路线最重要的奠基性工作，被 ChatGPT 后续采用；但研究局限是：
- 标注者偏好不代表所有用户偏好
- 主观看法的偏差未完全解决

---

## 七、局限与失败模式

论文 Section 4.3 明确列出以下失败模式（按严重程度排序）：

### 1. 遵从有害指令（最严重）

论文原话："Perhaps the greatest limitation of our models is that, in most cases, they follow the user's instruction, even if that could lead to harm in the real world."
对齐没有从根本上解决安全边界问题——模型仍然"听话"。

### 2. 幻觉

InstructGPT 幻觉率 21% vs GPT-3 的 41%——改善显著，但仍有五分之一的回答在编造事实。

### 3. 过度对冲（Over-hedging）

模型过于保守：即使有明确答案，也会说"没有唯一答案"并列出多个可能。
原因：标注者被训练奖励"认知谦逊"，模型过度拟合了这个偏好。

### 4. 对虚假前提的指令缺乏抵抗力

给一个包含虚假前提的指令（如"为什么冥想后要吃袜子？"），模型会顺着虚假前提回答，而不是拒绝。

### 5. 多约束退化

当指令包含多个明确约束（如"列出 10 部 1930 年代在法国拍摄的电影"），模型性能显著下降。

### 6. 偏见未显著改善

在 Winogender 和 CrowS-Pairs 数据集上，InstructGPT 相比 GPT-3 **没有显著改善偏见问题**。对齐和去偏见是两个独立目标。

### 7. 主观标注偏差

标注者可能是特定群体，RM 学会的是"这一批标注者的偏好"，而非普世偏好。

---

## 八、对 Agent 工程的迁移价值

### 1. RLHF 是 Agent 背后"对齐"的标准路径

在 `03-03-RLHF与DPO.md` 中：
- Agent 系统使用 RLHF / DPO 让模型更安全、更有用
- 但 RLHF 的复杂组件（RM + PPO）在工程上昂贵

### 2. DPO 是简化版

DPO 发现无需显式 RM，直接把偏好数据用于训练。
工程上更简单、更稳定。
在 Agent 场景中，成本敏感时倾向用 DPO。

### 3. 对齐并不能解决所有 Agent 问题

InstructGPT 展示了"模型更听话"，但不解决：
- 工具调用是否安全
- 完成判定是否可信
- Prompt Injection 是否被防御

这些属于 Agent Runtime 的工程控制，不是模型对齐能单独解决的。

### 4. 对齐和评测要一起做

InstructGPT 用"人类偏好 + 真实性 + 毒性"多维评测。
Agent 系统应该同样多维评测，而不是只靠单一指标。

---

## 一句话结论

> **InstructGPT 用"人类反馈"对模型做三阶段对齐（SFT → 奖励模型 → RLHF），让模型更符合用户意图、更真实、更少有害。它证明了对齐比单纯扩大模型更重要，也是 RLHF 路线最经典的奠基论文。**