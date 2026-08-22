# LoRA 与参数高效微调：用最少资源适配大模型

> 前置：`02-SFT与指令微调.md`、`../01-foundations/01-向量矩阵与神经网络.md`
> 本篇任务：理解 LoRA 和 QLoRA 的原理，知道为什么它们让"小团队微调大模型"成为可能。

---

## 一、这一章真正的问题

前两章我们讲了 SFT 和 RLHF/DPO。但有一个大问题没解决：

> 全量微调一个 70B 的模型需要 16 块 A100，绝大多数团队做不到。

所以需要**参数高效微调（PEFT）**：用极少的训练资源，达到接近全量微调的效果。

这一章要回答：
1. 为什么全量微调这么贵？
2. LoRA 的核心思想是什么？
3. LoRA 为什么能大幅减少训练参数？
4. QLoRA 如何在 LoRA 基础上进一步降低显存？

---

## 二、最小前置知识

- 理解 SFT 是什么
- 理解矩阵的秩（rank）概念
- 理解 W 和 b 是模型参数

---

## 三、直觉方案为什么不够好

### 直觉方案 1：只微调最后一层

> 反正前面层是通用的，只需要改最后一层就行。

问题：
- 最后一层参数量太少，表达能力不足
- 无法适配复杂的任务需求

### 直觉方案 2：冻结大部分层，微调少数层

> 只微调最后几层。

问题：
- 需要实验确定"微调哪几层、各层多少参数"
- 不同任务的最佳配置不同
- 存储和部署仍然需要维护完整的模型副本

---

## 四、正式机制

### 1. 全量微调的代价

假设一个 70B 的模型：
- 参数：700 亿个浮点数
- 每个参数训练时需要存储：参数本身 + 梯度 + 优化器状态
- 总计：约 700B × 2 字节 × 3 ≈ 420GB 显存

仅优化器状态就需要数百 GB 显存。

### 2. LoRA 的核心思想

LoRA（Low-Rank Adaptation）的洞察：

> 模型微调时，参数的变化量（ΔW）是**低秩的**。

也就是说，$\Delta W$ 可以分解成两个小矩阵的乘积：

$$\Delta W = A \cdot B$$

- $A$ 的形状：`(d_model, r)`
- $B$ 的形状：`(r, d_model)`
- $r \ll d_model$（通常 r = 8 ~ 64）

### 3. LoRA 的参数量减少

全量微调 W（形状 `d_model × d_model`）：

```text
参数量 = d_model × d_model
```

LoRA 微调 A + B：

```text
参数量 = d_model × r + r × d_model = 2 × d_model × r
```

当 $r \ll d_model$ 时，参数量减少非常显著。

举例：d_model=4096, r=8

```text
全量微调：4096 × 4096 = 16,777,216
LoRA：    4096 × 8 × 2 = 65,536
```

减少约 256 倍。

### 4. LoRA 的训练与推理

#### 训练时
- 原始权重 W 冻结（不更新）
- 只更新 A 和 B
- 前向计算：`y = W·x + B·(A·x)`

#### 推理时
- 可以把 $A \cdot B$ 合并回 W：$W' = W + A \cdot B$
- 推理速度不变（没有额外计算开销）

### 5. QLoRA：在 LoRA 基础上量化

QLoRA 进一步降低显存：

- 把原始 W 量化为 4-bit（NF4 数据类型）
- LoRA 适配器保持 16-bit
- 训练时，用 4-bit W 和 16-bit A/B 计算

效果：
- 65B 模型可以在单张 48GB GPU 上微调
- 性能接近全量 16-bit 微调

---

## 五、最小实现 / 伪代码

### 1. LoRA 层实现

```python
import numpy as np

class LoRALayer:
    def __init__(self, d_model, r=8):
        # 原始权重冻结（预训练好的）
        self.W = np.random.randn(d_model, d_model) * 0.01

        # LoRA 低秩矩阵（随机初始化）
        self.A = np.random.randn(d_model, r) * 0.01
        self.B = np.zeros((r, d_model))

    def forward(self, x):
        # 原始路径 + LoRA 路径
        return x @ self.W + x @ self.A @ self.B

    def merge_weights(self):
        # 把 LoRA 合并回原始权重（推理时使用）
        self.W = self.W + self.A @ self.B
        self.A = None
        self.B = None

# 测试
d_model, r = 64, 4
lora = LoRALayer(d_model, r)

# 训练时冻结 W，只更新 A 和 B
# 训练前：W 不变，A/B 从随机开始学习
# 训练后：把 A·B 合并回 W，推理速度不变

print(f"原始 W 参数量: {d_model * d_model}")
print(f"LoRA 参数量: {d_model * r * 2}")
print(f"参数量减少倍率: {d_model * d_model // (d_model * r * 2)}")
```

### 2. 不同 rank 的效果对比

```python
d_model = 4096

for r in [1, 4, 8, 16, 32, 64]:
    full_params = d_model * d_model
    lora_params = d_model * r * 2
    ratio = full_params / lora_params
    print(f"r={r:2d}: LoRA 参数 = {lora_params:8d}, 全量 = {full_params:8d}, "
          f"减少倍率 = {ratio:.0f}x")
```

---

## 六、复杂度与边界

1. **LoRA 的 rank 选择很重要**
   - r 太小：表达能力不足
   - r 太大：参数量增大，优势减弱
   - 经验值：r=8 或 r=16 在大多数任务上效果不错

2. **LoRA 不是全量微调的完美替代**
   - 在有些任务上，LoRA 的效果略低于全量微调
   - 但对于大多数实际场景，LoRA 的差距可忽略

3. **QLoRA 的量化会引入轻微的精度损失**
   - 4-bit 量化理论上会损失精度
   - 实际效果：在大多数任务上，与全精度微调几乎一致

4. **LoRA 可以同时训练多个适配器**
   - 一个基础模型 + 多个 LoRA 适配器
   - 不同任务切换时只需换适配器，不需要换模型
   - 这是 LoRA 在工程上的一个重要优势

---

## 七、论文与真实系统映射

- **LoRA**（Hu et al. 2021）：提出低秩适应方法，参数量减少 10000 倍
- **QLoRA**（Dettmers et al. 2023）：结合 4-bit 量化和 LoRA，单卡微调 65B 模型

在真实系统里：
- HuggingFace PEFT 库内置 LoRA 和 QLoRA 支持
- 几乎所有开源模型（LLaMA、Qwen、DeepSeek）都可用 LoRA 微调
- LoRA 是当前最主流的参数高效微调方法

> 关于"10000 倍"：这是 LoRA 论文对 GPT-3 175B 的声称数值。
> 实际倍率取决于 $d_{model}$ 与 $r$ 的比例（如正文示例 d_model=4096, r=8 是 256 倍）。
> 模型越大、rank 越小，倍率越高。

---

## 八、下一章为什么必须接着读

至此，`03-model-training` 的四篇核心文章已经完成：

```text
01 预训练与 Scaling：基础能力来源
02 SFT 与指令微调：续写器 → 指令模型
03 RLHF 与 DPO：对齐人类偏好
04 LoRA 与参数高效微调：低成本适配
```

但模型训练完只是第一步。真正让模型在生产中跑起来的，是**推理（Inference）**。

下一站是 `04-inference/`：
- **KV Cache**：为什么生成不能每次重算整个上下文
- **Batching**：如何同时服务多个用户
- **量化**：如何让模型更小、更快
- **Serving**：如何把模型部署成服务

---

## 一句话结论

> **LoRA 利用"微调参数变化是低秩的"这一洞察，用两个小矩阵替代全量 W 更新，把训练参数量减少数千倍。QLoRA 进一步结合 4-bit 量化，让单卡微调 65B 模型成为可能。**