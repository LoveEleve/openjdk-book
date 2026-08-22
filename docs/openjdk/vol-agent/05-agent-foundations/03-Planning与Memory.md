# Planning 与 Memory：Agent 如何规划并记住

> 前置：`02-Tool Use与行动闭环.md`
> 本篇任务：理解 Agent 的规划（Planning）与记忆（Memory）机制，以及它们如何让 Agent 处理复杂长任务。

---

## 一、这一章真正的问题

上一章我们有了工具调用能力。但这还不够：

- 简单任务可以"走一步看一步"
- 复杂任务（如"分析整个项目并写报告"）需要先规划、再执行、再验证

同时，Agent 还需要"记住"：
- 当前任务目标是什么
- 已经做了什么
- 历史上下文里有什么

这一章要回答：
1. Planning 为什么是 Agent 的关键能力？
2. 计划和执行的边界在哪里？
3. Memory 有哪些类型？
4. 为什么"上下文"不是"记忆"？

---

## 二、最小前置知识

- 理解 Agent Loop（`05-01`）
- 理解工具调用（`05-02`）
- 理解上下文窗口的概念（`04-inference`）

---

## 三、直觉方案为什么不够好

### 直觉方案 1：让模型边做边想，不做计划

> 直接让模型一步步调工具，走一步看一步。

问题：
- 模型可能迷失方向，忘记最初目标
- 步数一多，上下文越来越长，模型注意力分散
- 无法保证覆盖所有子任务

### 直觉方案 2：把所有历史都塞进上下文

> 反正上下文窗口很大，全都保留。

问题：
- 上下文越长，token 成本越高
- 长上下文中模型对"中间信息"容易丢失（Lost in the Middle）
- 有用信息被海量无关信息淹没

---

## 四、正式机制

### 1. Planning：把任务拆成可执行步骤

规划 = 把大任务分解成一系列小步骤，并确定顺序。

```text
用户任务：分析项目的代码质量
→ 计划：
   1. 了解项目结构
   2. 阅读关键文件
   3. 找出潜在问题
   4. 运行测试验证
   5. 生成报告
```

#### 计划的作用
- 给模型一个"路线图"，不至于迷失
- 支持拆解并行子任务
- 让"已做 / 未做"可追踪

### 2. Planning vs ReAct

- **ReAct**：走一步看一步，边想边做
- **Planning**：先规划整体，再按计划执行

两者各有适用：
- 简单任务：ReAct 直接跑
- 复杂任务：先规划再执行

### 3. Planner / Executor 分离

更成熟的设计是把两者拆成两个角色：

```text
Planner（规划器）：制定计划
Executor（执行器）：执行计划中的步骤
```

为什么分离？
- 规划需要"全局视角"
- 执行需要"聚焦单步"
- 分开后各自 prompt 更清晰

### 4. 记忆类型

Agent 的"记忆"可以分成几层：

#### 短期记忆（工作记忆）
- 当前对话 / 当前任务的上下文
- 每轮调用模型时都会看到
- 通常在上下文窗口内

#### 长期记忆（持久记忆）
- 跨会话保留的知识
- 用户偏好、历史结论、已验证事实
- 需要外部存储（数据库、向量库）

#### 记忆的写入
- 什么值得记住？
- 什么应该忘掉？
- 旧信息被新信息覆盖？

### 5. 为什么"上下文"不是"记忆"

关键区别：

```text
上下文（context）：模型当前看到的所有 token
记忆（memory）：系统保存的、可持续访问的长期信息
```

- 上下文是"快照"，每轮都重新组装
- 记忆是"仓库"，可以持久化、检索、更新
- 把记忆全塞进上下文 = 上下文爆炸

### 6. Memory Barrel 的两种基本设计

#### 全量历史注入
- 简单，但 token 成本高，长上下文易丢失信息

#### 检索式记忆
- 按相关性检索相关记忆
- 只喂给模型相关的部分
- 成本低，效率高

成熟系统用检索式，因为：
- 相关记忆比全量历史更有效
- 上下文有限，必须选择要喂什么

---

## 五、最小实现 / 伪代码

### 1. Planner / Executor 框架

```python
def planner(model, task):
    """模型生成任务计划（多个子步骤）。"""
    prompt = f"You are a planner. Break the task into steps:\n{task}"
    plan_text = model.generate(prompt)

    # 简化解析：提取以数字开头的行作为步骤
    steps = [line.strip() for line in plan_text.split("\n")
             if line.strip() and line.strip()[0].isdigit()]
    # 真正的实现会结构化解析
    return steps

def executor(model, step, context):
    """执行单个步骤。"""
    return model.generate(f"Execute step: {step}\nContext: {context}")

def run_with_plan(model, task):
    steps = planner(model, task)
    results = []
    for i, step in enumerate(steps):
        result = executor(model, step, results)
        results.append(result)
    return results
```

### 2. 记忆管理的伪代码

```python
class Memory:
    def __init__(self, max_working_tokens=2048):
        self.working = []       # 短期记忆（当前上下文）
        self.long_term = {}     # 长期记忆（键值存储）
        self.max_working_tokens = max_working_tokens

    def add(self, key, value):
        self.long_term[key] = value

    def get(self, key):
        return self.long_term.get(key)

    def summarize_working(self):
        """当短期记忆过长时，压缩摘要。"""
        # 用摘要模型压缩 working
        # 保留最近 + 摘要
        summary = summary_model(self.working[:-10])
        self.working = [summary] + self.working[-10:]
```

关键逻辑：
- working 有 token 上限，超了要压缩
- long_term 是持久化的键值存储
- 检索式记忆：按需从 long_term 取，而不是全量注入

---

## 六、复杂度与边界

1. **计划可能过时**
   - 执行过程中发现计划不适用
   - 需要能够重新规划（repair plan）

2. **记忆可能存错**
   - 把临时信息当长期知识
   - 需要记忆写入门控

3. **记忆会污染上下文**
   - 检索出的记忆可能不相关甚至错误
   - 会误导模型

4. **规划成本**
   - 规划本身要调用模型，增加成本
   - 简单任务不值得规划

---

## 七、论文与真实系统映射

- **ReAct**（Yao et al. 2022）：推理 + 行动
- **Tree of Thoughts**（Yao et al. 2023）：搜索式推理规划
- **MemGPT**（Packer et al. 2023）：分层记忆管理
- **Generative Agents**（Park et al. 2023）：记忆、反思、计划

在真实 Agent 系统里：
- Reasonix 的 Controller / Coordinator / PlanContract：规划与执行契约
- OpenCode 的 Agent selection、session history：会话记忆
- Hermes 的 memory/skills：长期知识管理
- dsh 的 Compaction / Session log：上下文与记忆分层

---

## 八、下一章为什么必须接着读

你已经知道：
- Planning 让 Agent 能处理复杂任务
- Memory 让 Agent 能记住并检索信息

但 Agent 还需要一个关键能力：

> 当知识不在模型参数里，也不在对话历史里时，Agent 怎么获取？

这就是：

- `../05-agent-foundations/04-RAG与Reflection.md`

它讲 Retrieval-Augmented Generation（检索增强生成）和 Reflection（反思与自我改进）。

---

## 一句话结论

> **Planning 让 Agent 把大任务拆成可执行步骤，Memory 让 Agent 记住并检索信息。但"上下文"不等于"记忆"——长期知识应该持久存储、按需检索，而不是全量塞进上下文。**