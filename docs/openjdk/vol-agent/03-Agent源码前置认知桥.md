# Agent 源码前置认知桥

> 目标：面向“没读过 Agent / AI / 大模型源码”的读者，用最小必要知识，把人带到可以正式读 5 个 Agent 项目源码的状态。
> 原则：不讲泛泛的大模型教材，只讲“读这批源码前必须知道什么”。

---

## 一、先建立一个基本判断

读 Agent 源码，和读普通框架源码最大的差别在于：

> 你看到的不是“一个库如何被调用”，而是“一个会自己做决策、自己调工具、自己持续运行的系统”。

所以如果你直接带着“普通框架源码阅读心态”进去，会很容易误判：
- 以为它只是 API 封装
- 以为它只是聊天机器人
- 以为 tool call 就是函数调用
- 以为 loop 只是 while(true)

而实际上，Agent 项目通常都在同时处理：
- 模型调用
- 会话状态
- 上下文管理
- 工具调用协议
- 错误恢复
- 持续执行 / continue / resume
- 权限 / 沙箱 / 评测

所以你需要先建立一套最小认知桥。

---

## 二、最小必要认知桥

## 2.1 什么是 LLM 调用

在 Agent 源码里，大模型不是“一个本地函数”，而是一个：

- 远程推理服务
- 输入通常是 `messages`
- 输出可能是：
  - 普通文本
  - reasoning / thinking
  - tool call
  - structured object

你看到这些词时要知道：
- `provider`：模型服务封装层
- `model`：具体模型名
- `messages`：给模型看的上下文
- `max_tokens`：限制输出规模
- `stream`：边生成边返回
- `structured output`：强制模型按 schema 返回结构化对象

如果不先知道这一层，后面一看到 provider / stream / generateObject / tool_calls，就会一脸懵。

---

## 2.2 什么是 Agent Loop

Agent 不是“一问一答”，而是一个循环系统。

典型的循环至少会反复做这几件事：
1. 读取当前状态
2. 决定下一步要不要调用模型
3. 决定要不要调工具
4. 处理工具结果
5. 检查是否完成 / 是否继续 / 是否阻塞

所以你看到这些词时要知道：
- `turn`：一轮模型交互
- `step`：turn 内部的一步
- `tool loop`：模型 → 工具 → 模型 的循环
- `continue` / `resume`：不是重新开始，而是从已有状态接着跑

很多 Agent 项目真正的复杂度，不在 prompt，而在 loop 如何被组织得稳定。

---

## 2.3 什么是 Planner / Executor / Evaluator

很多 Agent 项目会把职责拆成三个角色：

### Planner
- 决定怎么做
- 负责规格书、任务分解、章纲、计划

### Executor
- 实际去读文件、调工具、跑命令、写内容

### Evaluator
- 判断结果够不够好
- 检查是否要修订、继续、阻塞、失败

有些项目这三者是明确模块；有些项目是混在 loop 里；但你心里一定要有这个分工框架。

否则你会把：
- 计划逻辑
- 执行逻辑
- 验收逻辑

混成一团。

---

## 2.4 什么是 Tool Calling

对普通程序员来说，函数调用很自然；
但在 Agent 里，tool calling 不是“直接执行函数”，而是：

1. 模型先决定“要不要调工具”
2. 模型输出一个工具调用意图（tool call）
3. 运行时去执行这个工具
4. 工具结果再回到上下文里
5. 模型再根据结果继续思考

所以你会看到：
- tool schema
- tool result
- settlement
- permission
- sandbox
- stale rejection

这些并不是“额外复杂”，而是因为 Agent 的工具调用本质上是 **模型驱动的协议过程**。

---

## 2.5 什么是 Context / Compression / Resume

普通程序不需要关心“上下文窗口”，但 Agent 需要，因为模型只能看到你喂给它的内容。

所以你会看到很多围绕这些问题的代码：
- 哪些消息留下来
- 哪些消息压缩掉
- 哪些信息不能丢
- 上下文不够时怎么续跑

关键术语：
- `context window`
- `compaction`
- `summary`
- `checkpoint`
- `resume`
- `handover`

如果你不理解这一层，就会误以为：
> 为什么这些项目花这么多代码在“压缩 / 续跑 / 检查点”上？

实际上，这是 Agent 是否能长跑的生命线。

---

## 2.6 什么是 Sandbox / Approval / Capability Grant

Agent 能读文件、跑命令、写文件，这就意味着它有真实副作用。

所以你会看到：
- `permission`
- `approval`
- `sandbox`
- `grant`
- `danger-full-access`
- `read-only`
- `workspace-write`

这些不是“安全附加件”，而是 Agent runtime 的核心部分。

如果没有这层，你根本没法让 Agent 在真实系统里稳定运行。

---

## 2.7 什么是 Eval / Regression / A/B

Agent 不是“能跑就行”，因为同样一个任务：
- 它可能跑偏
- 可能编造
- 可能压缩后失忆
- 可能某次 commit 后退化

所以 Agent 项目里，评测体系很重要：
- `eval`
- `regression`
- `suite`
- `ablation`
- `A/B`
- `score`

这意味着：
> Agent 的质量不能只靠人肉感觉，而要靠可重复评测。

---

## 三、读 Agent 源码时最容易出现的错觉

### 错觉 1：它只是一个会调 API 的聊天壳子
不是。真正复杂的是：
- loop
- state
- context
- tool protocol
- evaluator
- sandbox
- recovery

### 错觉 2：工具调用就是普通函数调用
不是。它是模型驱动协议。

### 错觉 3：上下文管理只是“省 token”
不是。它是长跑能力的基础。

### 错觉 4：评测只是锦上添花
不是。没有评测，你根本不知道 Agent 是不是在稳定退化。

### 错觉 5：章节/计划/规格书只是文档
不是。很多 Agent 把这些东西当成执行控制面的一部分。

---

## 四、开始读 5 个 Agent 项目前，最低要带着哪些问题进去？

后面开始读 `opencode / reasonix / pi / hermes / dsh` 时，你可以始终带着这 8 个问题：

1. 它的主循环怎么组织？
2. 状态放在哪里？如何恢复？
3. 工具调用怎么编排？
4. 上下文怎么管？怎么压缩？
5. 验收 / evaluator 怎么接进执行链路？
6. 权限 / 沙箱 / 审批怎么做？
7. 评测 / regression / A/B 怎么落地？
8. 它最终产出的高价值结构是什么？

只要带着这 8 个问题去看，就不会完全迷失在文件和模块里。

---

## 五、建议的阅读顺序

如果你之前没读过 Agent 源码，我建议不是五个一起看，而是：

1. `opencode`
   - 先建立“现代 Agent runtime 骨架”的整体感知
2. `reasonix`
   - 看 durable execution / controller / 状态机
3. `pi`
   - 看 runtime abstraction / session / skills
4. `hermes`
   - 看 turn runner / gateway / evaluator 工程化
5. `dsh`
   - 看极简控制面 / todo-plan / guardrail

---

## 六、这份认知桥的边界

这份文档不是：
- 大模型原理教材
- Agent 研究综述
- LangChain / MCP 全家桶百科

它只是：
> **让你能开始读 Agent 源码的最小认知桥。**

当后面分析 5 个项目时，如果遇到新的必要概念，再按需补桥，不一次性灌输过量背景知识。

---

## 七、一句话总结

> 读 Agent 源码前，你最先要知道的不是“AI 原理大全”，而是：
> **这是一个会持续决策、会调工具、会管理上下文、会恢复运行、还要被评测约束的系统。**

带着这个框架再进源码，你就不会一上来就被文件和术语淹没。