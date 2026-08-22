# Tool Use 与行动闭环：模型如何调用外部能力

> 前置：`01-Agent Loop与ReAct.md`
> 本篇任务：理解工具 schema、工具调用协议、工具结果处理，以及为什么工具调用不是"函数调用"而是"协议"。

---

## 一、这一章真正的问题

上一章我们建立了 Agent Loop 的基本骨架：

```text
思考 → 行动 → 观察 → 继续/停止
```

但"行动"这一步，具体是怎么发生的？

这一章要回答：
1. 模型怎么知道有哪些工具可用？
2. 工具调用的输入输出怎么定义的？
3. 工具执行失败怎么办？
4. 为什么工具调用不是本地函数调用？

---

## 二、最小前置知识

- 理解 Agent Loop 的骨架（`05-01`）
- 理解 JSON 格式（`00-1`）
- 理解函数 = 输入 → 输出（`00-2`）

---

## 三、直觉方案为什么不够好

### 直觉方案 1：直接让模型写 Python 代码

> 让模型生成 Python 代码，然后执行。

问题：
- 安全风险极大（模型可能生成恶意代码）
- 错误处理复杂
- 无法约束模型调用哪些函数

### 直觉方案 2：把工具调用写进系统提示

> 在系统提示里写"你可以调用以下工具：...，工具参数是……"

问题：
- 模型不一定严格遵守格式
- 解析模型输出需要大量容错代码
- 工具数量多时，系统提示太长

---

## 四、正式机制

### 1. 工具 Schema：定义工具的输入输出

每个工具需要一份 schema，告诉模型：

```json
{
  "name": "read_file",
  "description": "读取指定文件的内容",
  "parameters": {
    "type": "object",
    "properties": {
      "path": {
        "type": "string",
        "description": "文件路径"
      }
    },
    "required": ["path"]
  }
}
```

Schema 包含：
- 工具名称
- 描述（模型靠这个理解工具用途）
- 参数（名称、类型、描述、是否必填）

### 2. 工具注册表

Agent 初始化时，把所有可用的工具注册成一个列表。

```text
tools = [read_file, write_file, search_code, run_command, ...]
```

这个列表会被拼进系统提示，作为模型"能看到的能力清单"。

### 3. 工具调用流程

```text
模型输出：{"tool_call": {"name": "read_file", "args": {"path": "main.py"}}}
  → 系统解析出工具名和参数
  → 查注册表，找到对应的工具函数
  → 校验参数是否符合 schema
  → 执行工具
  → 返回结果
  → 结果加入上下文，模型继续
```

### 4. 工具结果处理

工具执行后，结果需要回到模型上下文。

几个关键问题：

#### 结果太长怎么办？
- 截断到最大长度
- 保存完整结果到文件，只给模型摘要
- 这就是 OpenCode 的 ToolOutputStore 做的事

#### 工具执行失败怎么办？
- 错误信息也作为结果返回给模型
- 模型自己决定是重试、换工具还是放弃
- 不把工具错误当作"程序崩溃"

#### 工具调用被拒绝怎么办？
- 权限系统拒绝调用 → 返回拒绝原因
- 模型重新规划

### 5. 为什么工具调用不是函数调用

工具调用和本地函数调用的关键区别：

| 维度 | 本地函数调用 | 工具调用 |
|------|------------|----------|
| 调用方 | 代码 | 模型（文本生成） |
| 输入 | 类型安全 | 文本解析，可能有误 |
| 输出 | 类型确定 | 需要解析 |
| 失败处理 | 异常 | 回注给模型 |
| 权限 | 调用者权限 | 独立权限系统 |
| 状态 | 无状态 | 影响上下文 |

所以工具调用本质上是一个**协议**，不是一个函数调用。

---

## 五、最小实现 / 伪代码

### 1. 工具注册与执行

```python
class ToolRegistry:
    def __init__(self):
        self.tools = {}

    def register(self, tool):
        self.tools[tool["name"]] = tool

    def execute(self, name, args):
        if name not in self.tools:
            return {"error": f"unknown tool: {name}"}
        try:
            # 执行工具函数
            result = self.tools[name]["fn"](**args)
            return {"result": result}
        except Exception as e:
            return {"error": str(e)}

    def get_schemas(self):
        return [{"name": t["name"], "description": t["description"],
                 "parameters": t["parameters"]}
                for t in self.tools.values()]

# 注册工具
registry = ToolRegistry()
registry.register({
    "name": "read_file",
    "description": "读取文件内容",
    "parameters": {"type": "object", "properties": {
        "path": {"type": "string", "description": "文件路径"}},
        "required": ["path"]},
    "fn": lambda path: open(path).read()
})

# 模拟模型调用
tool_call = {"name": "read_file", "args": {"path": "test.txt"}}
result = registry.execute(tool_call["name"], tool_call["args"])
print(result)
```

### 2. 工具结果回注模型

```python
# 工具执行后，结果加入上下文
context = [
    {"role": "system", "content": "你是一个助手，可以调用工具。"},
    {"role": "user", "content": "读取 main.py 的内容"},
    {"role": "assistant", "content": "Thought: 我需要读取 main.py\nAction: read_file(path='main.py')"},
    {"role": "tool", "content": "def hello():\n    print('hello')"},  # 工具结果
]

# 模型看到工具结果后，决定下一步
# 可能继续调用工具，也可能输出 Final Answer
```

---

## 六、复杂度与边界

1. **工具 schema 越精确，模型越少出错**
   - 参数描述要清晰
   - 参数名要有意义
   - 必填参数和可选参数要明确

2. **工具结果不能无限制增长**
   - 大文件、长输出需要截断
   - 截断后要告诉模型"结果已截断，完整内容在文件 X"

3. **工具调用可能不合法**
   - 参数类型错误
   - 工具不存在
   - 权限不足
   - 都需要有明确的错误返回

4. **工具注册表的顺序影响模型选择**
   - 模型倾向于选择排在前面的工具
   - 重要工具应该排在前面

---

## 七、论文与真实系统映射

- **Toolformer**（Schick et al. 2023）：模型自学习工具调用
- **ReAct**（Yao et al. 2022）：工具调用作为行动的一部分

在真实系统里：
- OpenAI 的 function calling、MCP 协议都是工具调用的工程实现
- OpenCode 的 ToolRegistry 把工具注册、scope、permission 统一管理
- dsh 的工具系统把工具调用做成五事件管线
- 工具权限、stale rejection、output store 是真实系统的关键组件

---

## 八、下一章为什么必须接着读

你已经知道：
- 工具 = schema + 注册表 + 执行 + 结果回注
- 工具调用是协议，不是函数调用

但 Agent 只靠"调工具"还不够，还需要：

> 能规划多步任务、能记住历史信息。

这就是：

- `../05-agent-foundations/03-Planning与Memory.md`

它讲 Agent 如何制定计划、拆解子任务，以及如何管理短期和长期记忆。

---

## 一句话结论

> **工具调用不是函数调用，而是协议：模型通过 schema 知道工具的能力，通过注册表找到实现，通过结果回注继续推进。工具调用是 Agent"行动"的核心，但必须配合 schema、权限、结果管理和错误处理才能成为可靠的系统。**