# ReAct 精读：推理与行动如何交替

> 论文：ReAct: Synergizing Reasoning and Acting in Language Models（Yao et al. 2022）
> 公开链接：<https://arxiv.org/abs/2210.03629>
> 本地 PDF：`pdfs/2210.03629-ReAct.pdf`
> 推荐阶段：Phase 5（学完 `05-01-Agent Loop与ReAct.md` 后阅读）
> 前置知识：LLM、Agent Loop、工具调用、in-context learning

---

## 一、论文要解决什么问题

大语言模型（LLM）有两种能力，但通常是分开研究的：
- **推理能力（Reasoning）**：如 Chain-of-Thought（CoT），通过推理链提高准确率
- **行动能力（Acting）**：生成行动计划、与环境交互（如与知识库对话）

ReAct 要回答的核心问题：

> 能不能把"推理"和"行动"交织在一起，让 LLM 既能思考、又能执行，从而更可靠地完成任务？

答案是：**交错生成 Thought、Action、Observation**。

---

## 二、旧方案哪里不够

### 1. 纯推理（CoT）

- 模型靠内部知识推理，不能获取外部信息
- 产生幻觉：推理链再"合理"，也可能是编的
- 错误会沿推理链传播，一步错、步步错

### 2. 纯行动（Act-only）

- 类似"行动计划生成"，但缺少推理支撑
- 没有"为什么这样做"的追踪，可解释性差
- 遇到异常时难以调整计划

### 关键问题

这两种方式都不能同时做到：
- 利用外部信息（对抗幻觉）
- 保持可解释的推理轨迹（方便调试）

---

## 三、核心对象与状态

### 对象

| 符号 | 含义 |
|------|------|
| Thought | 模型的推理步骤（为什么这么做） |
| Action | 要执行的动作（如调 Wikipedia API） |
| Observation | 动作执行后获得的反馈 |
| Final Answer | 最终输出（停止时） |

### 状态

状态 = 到目前为止的完整轨迹（Thought/Action/Observation 交替序列）。

模型每一步看到的都是"累积轨迹"，从而能动态决定下一步。

---

## 四、关键公式 / 算法

### 1. ReAct 的推理格式

每轮生成的文本是：

```text
Thought: 我现在需要查找 X 的信息
Action: Search[X]
Observation: X 的相关信息是 ...
Thought: 基于以上信息，我现在可以回答
Final Answer: 答案是 ...
```

### 2. ReAct 与 CoT / Act 的关系

CoT、Act、ReAct 是**三种消融形态**，通过系统地删减 ReAct 轨迹构造：

- **CoT** = ReAct 去掉 Action 和 Observation（只留 Thought）
- **Act** = ReAct 去掉 Thought（只留 Action → Observation）
- **ReAct** = 三者保留（Thought + Action + Observation 交替）

论文的立场是三者**互补**：CoT 的推理结构更好但容易幻觉，ReAct 更扎实但推理灵活性略差。组合使用（CoT-SC→ReAct）效果最佳。

### 3. 决策流程

```text
状态：当前轨迹（Thought/Action/Observation 序列）
  → LLM 生成下一步（Thought + Action 或 Final Answer）
  → 如果是 Action，执行并获得 Observation
  → 更新轨迹
  → 循环
  → 直到 Final Answer
```

---

## 五、实验怎么设计

### 任务

论文在四类任务上评估 ReAct：

1. **知识密集型问答（QA）**：HotpotQA、FEVER
2. **多步推理**：需要调用外部信息
3. **交互式决策**：ALFWorld（虚拟家居任务）
4. **网页交互**：WebShop（在线购物）

### 对比基线

论文通过**消融 ReAct 轨迹**构造基线，而非独立设计：

- **CoT**（Wei et al. 2022）：去掉 Action 和 Observation，只保留 Thought——纯推理基线
- **CoT-SC**（Wang et al. 2022a）：CoT + 自洽性（采样 21 条轨迹，temperature 0.7，取多数答案）
- **Act**：去掉 Thought，只保留 Action——纯行动基线
- **CoT-SC→ReAct**：CoT-SC 置信度不足时回退到 ReAct
- **ReAct→CoT-SC**：ReAct 在步数限制内未返回答案时回退到 CoT-SC
- **BUTLER / BUTLER_g**（ALFWorld）：模仿学习 Agent
- **IL / IL+RL**（WebShop）：模仿学习 + 强化学习

### 模型

主实验用 **PaLM-540B**；微调实验用 PaLM-8B 和 PaLM-62B；附录用 GPT-3 text-davinci-002 做对比。

### 关键指标

- 准确率 / 成功率
- 是否可解释（能否追踪每一步为什么这么做）
- 对幻觉和错误传播的抵抗能力
- 失败模式分析（推理错误、幻觉、标签歧义）

---

## 六、证据是否支持结论

### 1. QA 任务

在 HotpotQA 和 FEVER 上，ReAct 优于纯 CoT：
- 因为 ReAct 能调用外部知识，减少幻觉
- 遇到不确定的信息时，模型可以查证

**最关键的数据（Table 2，200 条 HotpotQA 轨迹人工分析）：**
- ReAct **幻觉率 0%** vs CoT **幻觉率 56%**
- 代价是推理错误率上升：ReAct 47% vs CoT 16%（交错结构降低了推理灵活性）
- 这组数据说明：ReAct 的核心价值不是"推理更好"，而是**消灭幻觉**

### 2. 交互式任务

在 ALFWorld 上，ReAct 成功率显著高于 LLM-only 方法，甚至接近强化学习方法：
- 推理轨迹让模型能根据 Observation 调整计划
- 不依赖大量训练数据

### 3. 可解释性

ReAct 的 Thought 让每一步决策都可读：
- 模型"为什么调这个工具"可见
- 方便定位失败环节

### 结论可信度评估

**中等偏强**：实验覆盖了推理和行动两类任务，且对比了多种基线。局限是任务规模有限，且依赖固定的工具接口（如 Wikipedia API）。

---

## 七、局限与失败模式

### 1. 模型容易"陷入循环"

模型可能反复执行同一个 Thought + Action，没有进展。
论文将此类错误归入"推理错误"（47%），称为"repetitive loop error"——模型重复生成之前的 Thought 和 Action 而无法跳出。
需要额外的停滞检测或最大步数限制。

### 2. 依赖工具可用性

ReAct 的效果依赖外部工具的可用性和接口质量：
- 如果没有合适的工具，推理链路会断裂
- 工具调用格式的错误会累积

### 3. 规划能力受限

ReAct 是"走一步看一步"的推理：
- 缺乏长远规划
- 复杂任务可能中途迷失

### 4. 无关信息干扰

如果 Observation 过于冗长或无关，模型可能被误导。
需要控制 Observation 的规模和质量。

---

## 八、对 Agent 工程的迁移价值

### 1. ReAct 框架是 Agent 的通用骨架

几乎所有真实 Agent 系统（OpenCode、Reasonix、Pi、Hermes、dsh）都基于类似于 ReAct 的交错推理-行动循环。

### 2. Thought 提供了可解释性

真实系统把 Thought 记录下来：
- 让用户理解 Agent 在做什么
- 方便调试失败原因
- 也是审计和评测的基础

### 3. Observation 是真相层的重要组成

在 ReAct 中，Observation 是"系统承认发生了什么"的入口。
这在 `06-agent-runtime/01-会话与真相层.md` 中有详细解读。

### 4. 停滞检测和策略规划是后续增强

ReAct 的最直接局限性——循环和规划——正是：
- Hermes 的 GoalGate / GoalJudge（停滞、完成判定）
- Reasonix 的 Goaleval（停滞检测、转向策略）
- Tree of Thoughts（搜索式规划）

要补齐的方向。

---

## 一句话结论

> **ReAct 把 LLM 的推理能力和行动能力交织起来，通过 Thought / Action / Observation 的循环让模型既能思考、又能查证外部信息，从而减少幻觉、提高可解释性。它是几乎所有现代 Agent 系统的共同骨架。**