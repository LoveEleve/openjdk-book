# Agent 评测方法：怎么证明 Agent 真的会做事

> 前置：`01-Prompt Injection与数据边界.md`
> 本篇任务：理解 Agent 评测的基本方法、常见基准和评测的陷阱。

---

## 一、这一章真正的问题

Agent 系统越来越复杂，但有一个核心问题一直没解决：

> 怎么客观地证明一个 Agent 真的"会做事"？

这一章要回答：
1. Agent 评测和传统 NLP 评测有什么不同？
2. 常见的 Agent 评测基准有哪些？
3. 评测的陷阱和误区是什么？
4. 什么是"轨迹评测"？为什么它比"最终答案评测"更可靠？

---

## 二、最小前置知识

- 理解 Agent Loop（`../05-agent-foundations/01-Agent Loop与ReAct.md`）
- 理解训练集/测试集的分工（`../01-foundations/04-训练验证与泛化.md`）
- 理解"数据泄漏"的概念（`../01-foundations/04-训练验证与泛化.md`）

---

## 三、直觉方案为什么不够好

### 直觉方案 1：只看最终答案

> Agent 输出的最终答案正确，就说明它做得好。

问题：
- Agent 可能"蒙对"了答案，但过程是错误的
- 无法判断 Agent 是否真正理解了任务
- 无法定位失败环节

### 直觉方案 2：用传统 NLP 评测集

> 用 MMLU、HumanEval 等标准评测集测试 Agent。

问题：
- 这些评测集是"单次问答"，不是"多步任务"
- 无法评测 Agent 的工具调用、规划、恢复能力
- 评测结果和实际 Agent 表现差距很大

---

## 四、正式机制

### 1. Agent 评测和传统 NLP 评测的区别

```text
传统 NLP 评测：
  输入 → 模型 → 输出 → 对答案
  单次、无状态、无工具

Agent 评测：
  输入 → 多步循环 → 工具调用 → 观察 → 继续 → 最终输出
  多步、有状态、有工具、有恢复
```

传统评测无法覆盖 Agent 的核心能力：工具调用、规划、错误恢复、停止判定。

### 2. 轨迹评测（Trajectory Evaluation）

核心思想：**不仅看最终答案，还要看执行过程。**

```text
评测指标：
  最终答案正确性：答案是否正确
  工具调用正确性：每步工具调用是否合理
  效率：用了多少步、多少 token
  恢复能力：遇到错误时能否正确处理
  停止判定：该停的时候是否停了
```

### 3. 常见 Agent 评测基准

#### SWE-bench
- 任务：给定 GitHub issue，Agent 需要修改代码仓库来解决
- 评测指标：生成的 patch 是否被测试通过
- 难度：当前最佳模型仅能解决约 20%

#### AgentBench
- 任务：多环境交互（操作系统、网页、数据库、搜索引擎）
- 评测指标：任务完成率 + 效率
- 覆盖：8 个不同的环境

#### TruthfulQA
- 任务：回答事实性问题
- 评测指标：真实性和有用性
- 不是 Agent 专用，但评测"模型是否可靠"

### 4. 评测的陷阱

#### 数据泄漏
- Agent 的训练数据可能包含评测集中的问题
- 训练时见过解法 → 评测时"背答案"

#### 任务泄漏
- 评测环境中的信息可能无意中暴露了答案
- Agent 利用环境中的"线索"而不是真正的推理

#### 评测不全面
- 只评测"最终答案"，不评测"过程"
- 一个 Agent 可能碰巧做对，但大部分时候不会做

### 5. 评测的"守门人"原则

一个好的 Agent 评测应该：

```text
1. 测试集严格隔离（Agent 在训练时不能看到）
2. 评测轨迹，不只结果
3. 覆盖多种失败模式
4. 可重复执行
5. 有明确的通过/失败标准
```

---

## 五、最小实现 / 伪代码

### 1. 轨迹评测

```python
def evaluate_trajectory(agent, task, ground_truth):
    trajectory = agent.run(task)

    # 1. 最终答案正确性
    final_correct = trajectory.final_answer == ground_truth["answer"]

    # 2. 工具调用合理性
    correct_calls = 0
    for step in trajectory.steps:
        if step["type"] == "tool_call":
            if step["name"] in ground_truth["expected_tools"]:
                correct_calls += 1

    tool_accuracy = correct_calls / len(trajectory.tool_calls)

    # 3. 步数比（接近 1 表示步骤接近最优；越大表示越冗余）
    step_ratio = len(trajectory.steps) / ground_truth["min_steps"]

    return {
        "final_correct": final_correct,
        "tool_accuracy": tool_accuracy,
        "step_ratio": step_ratio,
        "total_steps": len(trajectory.steps),
        "total_tokens": trajectory.total_tokens,
    }
```

### 2. 评测报告示例

```python
def generate_report(results):
    pass_rate = sum(1 for r in results if r["final_correct"]) / len(results)
    avg_tool_acc = sum(r["tool_accuracy"] for r in results) / len(results)
    avg_steps = sum(r["total_steps"] for r in results) / len(results)

    print(f"通过率: {pass_rate:.1%}")
    print(f"平均工具调用准确率: {avg_tool_acc:.1%}")
    print(f"平均步数: {avg_steps:.1f}")
    print(f"总评测数: {len(results)}")
```

---

## 六、复杂度与边界

1. **评测是"抽样"不是"全量"**
   - 无法覆盖所有可能的任务
   - 评测通过不代表 Agent 在所有场景下都可靠

2. **轨迹评测比最终答案评测更贵**
   - 需要人工标注"正确轨迹"
   - 自动评测需要更复杂的规则

3. **评测基准本身在进化**
   - SWE-bench、AgentBench 等基准在不断更新
   - 旧基准可能被过拟合

4. **评测不能替代真实环境测试**
   - 评测基准是"模拟"
   - 真实环境有更多变化和噪声

---

## 七、论文与真实系统映射

- **SWE-bench**（Jimenez et al. 2024）：真实 GitHub issue 评测
- **AgentBench**（Liu et al. 2023）：多环境 Agent 评测
- **TruthfulQA**（Lin et al. 2021）：事实性评测

在真实系统里：
- OpenCode、Reasonix、Pi、Hermes、dsh 都有各自的测试契约
- 评测是 Agent 开发的核心环节，但当前仍是活跃的研究领域

---

## 八、下一章为什么必须接着读

你已经知道：
- Agent 评测需要评测轨迹，不只是最终答案
- 常见评测基准和数据泄漏陷阱

但还有最后一个问题：

> 安全防御和评测都有了，生产环境怎么治理？

这就是：

- `03-安全治理与合规.md`

它讲生产环境中的安全治理、监控和合规。

---

## 一句话结论

> **Agent 评测不能只看最终答案，还要看执行轨迹。SWE-bench 和 AgentBench 是当前主流的 Agent 评测基准，但数据泄漏、评测不全面等陷阱需要警惕。评测通过不意味着 Agent 在所有场景下都可靠。**