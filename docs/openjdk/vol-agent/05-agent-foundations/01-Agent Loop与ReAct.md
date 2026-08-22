# Agent Loop 与 ReAct：从"生成文本"到"执行任务"

> 前置：`02-transformer` 四篇、`04-inference` 四篇
> 本篇任务：理解 Agent Loop 的基本结构，以及 ReAct 范式如何把语言模型从"文本生成器"变成"任务执行系统"。

---

## 一、这一章真正的问题

前面所有章节都在讲一件事：**模型怎么生成文本**。

但生成文本 ≠ 完成任务。

要让模型真正"做事"，需要：
- 理解任务目标
- 调用工具
- 观察结果
- 决定下一步
- 知道什么时候停止

这一章要回答：
1. 一个 Agent 的最小骨架是什么？
2. Chat Completion 和 Agent Loop 有什么区别？
3. ReAct 范式如何工作？
4. 为什么 Agent 必须要有状态和停止条件？

---

## 二、最小前置知识

- 理解 LLM 的生成是"预测下一个 token"
- 理解函数（`00-2`）
- 理解"输入 → 处理 → 输出 → 更新状态 → 继续"（`00-1`）

---

## 三、直觉方案为什么不够好

### 直觉方案 1：直接让模型生成答案

> 把任务描述写进 prompt，让模型直接输出结果。

问题：
- 模型无法获取外部信息
- 模型无法执行操作（如读文件、查数据库）
- 模型无法验证自己的结果

### 直觉方案 2：一个循环里不断调模型

> 不停地让模型生成，直到它说"完成了"。

问题：
- 模型可能永远不停（无限循环）
- 没有工具调用能力
- 无法验证"完成"是否真实

---

## 四、正式机制

### 1. Chat Completion 与 Agent Loop 的区别

#### Chat Completion
```text
用户输入 → 模型 → 文本输出
```

单次、无状态、无工具。

#### Agent Loop
```text
用户输入 → 模型 → 思考 → 行动 → 观察 → 模型 → 思考 → 行动 → ... → 最终输出
```

多步、有状态、有工具、有停止条件。

### 2. Agent Loop 的最小骨架

```text
while True:
    1. 接收输入（当前任务 + 历史 + 工具结果）
    2. 模型生成输出（思考 + 行动）
    3. 如果模型决定停止 → 退出循环
    4. 否则执行工具（读文件、调 API 等）
    5. 把工具结果加入上下文
    6. 循环
```

这就是 Agent 的"最小骨架"。

### 3. ReAct：推理与行动交替

ReAct（Reasoning + Acting）是最经典的 Agent 范式。

每轮生成的输出格式：

```text
Thought: 我需要知道当前目录的文件列表
Action: run_command: ls -la
Observation: total 3 files ...
Thought: 我看到有一个 main.py ...
Action: read_file: main.py
Observation: ...
Thought: 我现在理解了代码结构，可以回答了
Final Answer: 这段代码实现了一个...
```

四个关键字段：
- **Thought**：模型的推理过程（为什么做这个决定）
- **Action**：要执行的工具调用
- **Observation**：工具执行的结果
- **Final Answer**：最终输出（停止时）

### 4. 为什么 Agent 需要状态

每次循环，模型看到的是"累积的上下文"：

```text
第 1 轮：系统提示 + 任务 + Thought + Action + Observation
第 2 轮：系统提示 + 任务 + 第 1 轮 + 第 2 轮的 Thought + Action + Observation
...
```

状态 = 到目前为止的完整交互历史。

这也是为什么 Agent 天然需要上下文管理——没有上下文就没有"记忆"。

### 5. 为什么 Agent 需要停止条件

Agent 不能无限跑下去。必须定义停止条件：

- 模型输出 `Final Answer` → 正常停止
- 超过最大步数 → 强制停止
- 检测到错误 → 错误停止
- 用户中断 → 手动停止

---

## 五、最小实现 / 伪代码

### 1. 最小 Agent Loop

```python
def agent_loop(model, task, max_steps=10):
    context = [{"role": "system", "content": "你是一个助手，可以调用工具。"},
               {"role": "user", "content": task}]

    for step in range(max_steps):
        # 1. 模型生成
        response = model.generate(context)

        # 2. 如果模型决定停止
        if "Final Answer" in response:
            return extract_final_answer(response)

        # 3. 提取工具调用
        action = extract_action(response)
        if action is None:
            continue   # 模型没有输出工具调用，继续

        # 4. 执行工具
        result = execute_tool(action["name"], action["args"])

        # 5. 把工具结果加入上下文
        context.append({"role": "assistant", "content": response})
        context.append({"role": "tool", "content": result})

    # 超过最大步数
    return "ERROR: max steps exceeded"
```

### 2. ReAct 格式解析

```python
def extract_action(response):
    """从模型输出中提取工具调用。"""
    if "Action:" not in response:
        return None
    lines = response.split("\n")
    for line in lines:
        if line.startswith("Action:"):
            # 格式：Action: 工具名: 参数
            content = line[len("Action:"):].strip()
            parts = content.split(":", 1)
            name = parts[0].strip()
            args = parts[1].strip() if len(parts) > 1 else ""
            return {"name": name, "args": args}
    return None

def extract_final_answer(response):
    """提取最终答案。"""
    if "Final Answer:" in response:
        return response.split("Final Answer:")[-1].strip()
    return response
```

---

## 六、复杂度与边界

1. **Agent Loop 不是 Chat Completion**
   - 每次循环都调用模型，成本逐轮累加
   - 上下文不断增长，KV Cache 和 token 成本持续上升

2. **模型可能"陷入循环"**
   - 不断调同一个工具，没有进展
   - 需要检测停滞（stall detection）

3. **工具结果可能很大**
   - 大文件、长输出直接塞进上下文会撑爆
   - 需要截断、摘要、分页

4. **模型可能"自以为是"地完成**
   - 没真正执行工具就宣布完成
   - 需要验证机制

---

## 七、论文与真实系统映射

ReAct 论文（Yao et al. 2022）首次系统性地提出了"推理与行动交替"的范式。

在真实 Agent 系统里：
- ReAct 是几乎所有 Agent 框架的基础
- OpenCode 的 SessionRunner、Reasonix 的 Controller、Pi 的 AgentLoop、dsh 的 ReactLoopAgent 都基于类似范式
- 区别在于：工具系统、权限控制、上下文管理、停止条件等工程细节

---

## 八、下一章为什么必须接着读

你已经知道：
- Agent Loop = 循环：思考 → 行动 → 观察 → 继续/停止
- ReAct 是 Agent 的基本范式

但还有一个关键问题没解决：

> 模型怎么知道有哪些工具可以用？工具结果怎么回到模型？工具调用失败怎么办？

这就是：

- `../05-agent-foundations/02-Tool Use与行动闭环.md`

它讲工具 schema、工具结果处理、错误恢复和行动闭环。

---

## 一句话结论

> **Agent Loop 把语言模型从"单次文本生成器"变成"多步任务执行系统"。ReAct 范式通过"思考→行动→观察→继续/停止"的循环，让模型能自主调用工具、观察结果、推进任务，直到完成或达到上限。**