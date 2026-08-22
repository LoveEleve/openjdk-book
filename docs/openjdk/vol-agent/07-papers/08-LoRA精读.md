# LoRA 精读：低秩适配让微调大模型变得可负担

> 论文：LoRA: Low-Rank Adaptation of Large Language Models（Hu et al. 2021）
> 公开链接：<https://arxiv.org/abs/2106.09685>
> 本地 PDF：`pdfs/2106.09685-LoRA.pdf`
> 推荐阶段：Phase 3（学完 `03-04-LoRA与参数高效微调.md` 后阅读）
> 前置知识：Transformer、全量微调的成本、参数高效微调概念

---

## 一、论文要解决什么问题

全量微调大模型非常昂贵：

- GPT-3 175B 全量微调，光是训练参数就 175B
- 部署多份微调模型需要保存多份完整权重
- 普通人无法负担

LoRA 的核心问题：

> 能不能在几乎不损失效果的前提下，大幅减少微调时的可训练参数和显存需求？

答案是：**把微调的"权重变化"建模为低秩矩阵乘积**。

---

## 二、旧方案哪里不够

### 1. 全量微调

- 更新所有参数
- 需要保存完整模型 + 梯度 + 优化器状态，显存爆炸
- 每部署一个微调版本，都要一份完整权重

### 2. Adapter（适配器）

- 在 Transformer 层中间插入额外模块
- 增加了推理延迟（额外一次计算）
- 不在主干上有效利用

### 3. Prefix-Tuning / Prompt-Tuning

- 增加输入前缀或 prompt 参数
- 对模型结构改动小
- 但可训练效率和效果稳定性有争议

### 核心洞察

> 微调时，模型参数的变化量往往是"低秩"的——可以用小矩阵表达。

---

## 三、核心对象与状态

### 对象

| 对象 | 含义 |
|------|------|
| 预训练权重 `W` | 冻结，不更新 |
| 低秩矩阵 `A` | 随机初始化，可训练 |
| 低秩矩阵 `B` | 初始化为零，可训练 |
| rank `r` | 低秩维度（通常 4~64） |

### 关键状态

权重分解本身：$\Delta W = B A$

前向计算：$h = W x + \frac{\alpha}{r} \cdot B A x$

注意：$\alpha / r$ 是**输出缩放因子**，不是权重分解的一部分。当 $\alpha = r$ 时缩放因子为 1，此时 LoRA 输出就是 $BAx$。论文中 $\alpha$ 默认取 $r$，不需要调。

- $W_{\text{new}} = W + \frac{\alpha}{r} B A$
- 前向：$y = W x + \frac{\alpha}{r} B (A x)$

---

## 四、关键公式 / 算法

### 1. 权重变化的低秩分解

假设原权重是 $W \in \mathbb{R}^{d \times k}$，微调变化是 $\Delta W$。

LoRA 假设 $\Delta W$ 可分解为：

$$\Delta W = B A$$

其中：
- $A \in \mathbb{R}^{r \times k}$
- $B \in \mathbb{R}^{d \times r}$
- $r \ll \min(d, k)$（r 可能是 4、8、16）

前向计算时加入输出缩放：

$$h = W x + \frac{\alpha}{r} \cdot B A x$$

$\alpha$ 是缩放常数，论文默认 $\alpha = r$（即缩放因子为 1）。

### 2. 参数量对比

全量微调：
$$\text{params} = d \times k$$

LoRA：
$$\text{params} = d \times r + r \times k = r(d + k)$$

GPT-3 175B 上的缩减倍数（论文 Table 15）：
- r=1, 适配 2 个矩阵：4.7M 参数 → **37,000x** 缩减
- r=2：9.4M 参数 → **18,600x** 缩减
- r=4：约 19M 参数 → **约 10,000x** 缩减（论文原文："up to 10,000x"）

### 3. 前向计算的两种形式

- **训练时**：$h = W x + \frac{\alpha}{r} \cdot B A x$（同时计算冻结路径和低秩路径）
- **推理时/部署时**：把 $\frac{\alpha}{r} BA$ 合并回 $W' = W + \frac{\alpha}{r} BA$，推理延迟与原始模型一致

### 4. 缩放因子

- 加入 $\alpha / r$ 缩放
- 保证训练稳定性
- 不增加推理计算

---

## 五、实验怎么设计

### 任务

- GLUE（语言理解）
- E2E NLG（生成）
- 大规模语言模型评测（GPT-3 175B）

### 对比基线

- 全量微调
- Adapter
- Prefix-tuning
- 只微调偏置（BitFit）等

### 关键指标

- 微调后可训练参数数量
- 显存占用
- 推理延迟
- 下游任务准确率/生成质量
- 是否引入额外推理开销

---

## 六、证据是否支持结论

### 1. 效果接近全量微调

在 RoBERTa、DeBERTa、GPT-2 上，LoRA 与全量微调效果相当或更好。

### 2. 大模型上验证

GPT-3 175B 上，LoRA 在多项任务上表现良好。

### 3. 训练效率

- 可训练参数减少 **最高 10,000 倍**（GPT-3 175B，r=4，适配 2 个矩阵；r=1 时可达 37,000 倍）
- GPU 内存显著减少
- 训练吞吐更高

### 4. 推理无开销

因为可以合并权重，部署后无额外延迟——这是相比 Adapter 的核心优势。

### 结论可信度评估

**强**：论文在多个规模、多个任务的完整验证，且核心低秩假设被后续大量工作（QLoRA 等）支持。

---

## 七、局限与失败模式

论文明确报告了以下局限：

### 1. 低秩假设不总是成立

- 对有明确高秩需求的极复杂任务（如预训练语言与下游任务语言不同），LoRA 可能弱于全量微调
- 论文原话："if the downstream task were in a different language than the one used for pre-training, retraining the entire model could certainly outperform LoRA with a small r"

### 2. rank 选择缺乏原则性方法

- 论文承认矩阵选择依赖启发式："We mostly depend on heuristics to select the weight matrices to apply LoRA to"
- rank 太小：表达能力不足
- rank 太大：节省不明显
- 更高 rank 不一定覆盖更有意义的子空间（Table 6 显示 r=8 和 r=64 的 top 奇异向量高度重叠）

### 3. 最优 rank 与模型规模的关系是开放问题

- 论文附录 H.2 指出："the relationship between model size and the optimal rank for adaptation is still an open question"

### 4. 与其他并行训练技术组合更复杂

- 与梯度检查点、ZeRO、分布式并行组合时，需要额外适配

---

## 八、对 Agent 工程的迁移价值

### 1. LoRA 是小团队微调大模型的钥匙

在 `03-04-LoRA与参数高效微调.md` 中：
- 只有 LoRA / QLoRA，普通团队才能微调数十亿参数模型
- Agent 开发中，领域微调常用 LoRA 而非全量微调

### 2. 多适配器支持多任务 Agent

Agent 可以：
- 一个基础模型
- 一个"代码助手"适配器
- 一个"数据分析"适配器
- 一个"安全审查"适配器

按任务切换适配器，无需切换模型。

### 3. QLoRA 让单卡微调成为可能

- QLoRA（4-bit 量化 + LoRA）可在单张 48GB GPU 微调 65B 模型
- 让 Agent 团队能在有限资源下做领域适配

### 4. 推理时合并权重，适合 Agent 部署

Agent 需要快速响应、低内存占用。
LoRA 合并权重后推理无开销，适合生产。

---

## 一句话结论

> **LoRA 利用"微调权重变化往往是低秩的"这一洞察，用两个小矩阵（A、B）近似权重变化，把可训练参数减少数千到万倍，同时不牺牲效果、不增加推理延迟。它让小团队微调大模型成为现实，也是 QLoRA 等后续方法的基石。**