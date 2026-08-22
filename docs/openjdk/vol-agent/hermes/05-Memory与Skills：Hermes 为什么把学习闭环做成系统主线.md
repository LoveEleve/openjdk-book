# Memory 与 Skills：Hermes 为什么把学习闭环做成系统主线

> 项目：Hermes（main 基线）
> 角色：主线机制正文 04
> 对应范围规划：`01-Hermes源码学习范围规划.md`
> 依据材料：
> - `Agent/analysis/hermes-agent/01-闭环笔记/pass2-hq1-memory.md`
> - `Agent/analysis/hermes-agent/01-闭环笔记/pass2-hq2-skills-lifecycle.md`
> - `Agent/analysis/hermes-agent/01-闭环笔记/pass2-hq24-learning-graph.md`
> - `Agent/analysis/hermes-agent/01-闭环笔记/pass2-hq12-background-review.md`

---

## 零、阅读前提示

- 建议先读：
  1. `02-AIAgent主循环：Hermes 如何组织 turn、工具批与长期运行.md`
  2. `04-ContextCompression：Hermes 为什么把缓存边界当成架构约束.md`
  3. `../03-Agent源码前置认知桥.md`
- 推荐源码阅读路径：
  1. `tools/memory_tool.py`
  2. `agent/memory_manager.py`
  3. `agent/memory_provider.py`
  4. `tools/skills_tool.py`
  5. `tools/skill_usage.py`
  6. `agent/curator.py`
  7. `agent/learning_graph.py`
  8. `agent/background_review.py`

## 一、这一章真正的问题

很多 Agent 项目都有：
- memory
- skills
- search
- graph

但大多数时候，这些功能更像外挂：
- 有是有
- 但不一定真的进入运行主线

Hermes 在这里不一样。它真正要回答的是：

> **一个 Agent 如何把记忆、技能、知识老化、自动重构、图谱可视化和背景审查统一成“学习闭环”，而不是停留在零散功能集合。**

也就是说，这一章不是在讲：
- 它有多少 memory plugin
- 有多少技能文件

而是在讲：
> **Hermes 为什么敢说自己是 self-improving agent。**

---

## 二、先给结论：Hermes 的学习系统不是“会记住点东西”，而是一个受缓存稳定、写入门控、生命周期治理和后台审查共同约束的知识系统

最容易犯的错，是把 Hermes 的记忆和技能看成：
- 保存一点 Memory.md
- 再加一些技能 prompt
- 然后做个学习图谱

这完全看浅了。

更准确的理解应该是：

> **Hermes 把知识单元、知识生命周期、知识注入、知识安全、知识热度、知识重构和知识可视化都纳入了同一条产品主线。**

所以这一章真正的主角不是某个 `memory_tool` 或 `skills_tool`，而是：
- 双态记忆模型
- 技能生命周期状态机
- background review fork
- 学习图谱
- 写审批子系统

这些拼起来，才构成了 Hermes 的学习闭环。

---

## 三、为什么 Hermes 的记忆必须分成“冻结快照”和“活态写入”

Hermes 的 memory 最值钱的判断之一是：
- `_system_prompt_snapshot`
- `memory_entries / user_entries`

也就是说，它明确区分：

### 冻结快照
- 会在 session 启动时折进 system prompt
- 会话中不再变化
- 用来维持 prompt cache 前缀稳定

### 活态写入
- memory tool 可继续修改
- 可以落盘、合并、归档、审查
- 但不会立刻回写进当前稳定前缀

这说明 Hermes 在 memory 上的核心不是“存什么”，而是：
> **知识如何进入当前执行上下文，而又不破坏缓存神圣边界。**

这和我们在 ContextCompression 那一章看到的架构哲学完全一致。

---

## 四、为什么 MemoryStore 的四操作语义很重要

Hermes 的 `memory_tool.py` 不是简单地 add/remove 文本。

它真正定义了：
- add
- replace
- remove
- apply_batch

并且每个操作都受：
- 参数合法性
- 容量预算
- 外部漂移检测
- threat pattern 扫描
- 原子写
- 审批门控
- consolidation failure 上限

共同约束。

这说明它的 memory tool 不只是编辑器，而是：
> **知识库写入协议。**

特别值钱的是：
- 成功响应是 TERMINAL，不鼓励模型反复重试
- consolidation failure 超过 3 次会显式停下
- 读失败 != 空存储
- 外部漂移会备份并拒绝写入

这已经不是简单的“文件操作”，而是在认真处理：
> **知识写入不能因为一次坏读、一次竞争写或一次错误合并把整个知识库搞坏。**

---

## 五、为什么背景审查 fork 是 Hermes 的知识沉淀硬通道

很多系统会依赖：
- 模型自己看着办
- 或者偶尔 prompt 一下“要不要记忆/生成技能”

Hermes 认为这不够。

所以它做了 background review fork：
- 每轮结束后
- fork 一个独立 AIAgent
- 回放对话快照
- 问自己：
  - 该存什么 memory？
  - 该生成什么 skill？

这条线非常值钱，因为它说明：

> **知识沉淀不能只靠模型自觉，必须有一个强制的后台审查通道。**

而且 Hermes 还把它做得很严：
- 工具白名单只允许 memory / skills 族
- `skip_memory=True` 防止 fork 污染外部 memory provider
- `_persist_disabled=True` 防止 fork 把 review 对话写回主会话
- cron 等场景可以跳过 background review

这说明 background review 不是“多一个功能”，而是：
> **自主知识维护的隔离执行系统。**

---

## 六、为什么 Skills 的治理重点不是“怎么调用”，而是“怎么不烂掉”

Hermes 的 skills 最值得学的，不是 `/skill` 命令本身，而是它整套治理：

### 1. 三态状态机
- active
- stale
- archived

### 2. 来源分级
- agent 自创
- bundled built-in
- hub-installed
- external_dirs
- protected builtins

### 3. 用量追踪
- use_count
- view_count
- patch_count
- last activity

### 4. curator 自动审查
- 合并成 umbrella
- 降级成 references / templates / scripts
- 干跑报告
- 预快照 + diff

这说明 Hermes 对 skills 的理解不是：
- 越多越好

而是：
> **技能库如果没有生命周期治理，很快就会膨胀成垃圾场。**

这非常符合我们的方法论：
- 学习系统不只是积累知识
- 还要治理知识

---

## 七、为什么 LearningGraph 值得进主线

LearningGraph 不是可视化玩具。

它在回答一个非常重要的问题：

> **用户到底学到了什么，以及这些技能和记忆之间是怎么关联的。**

它的结构很有代表性：
- 节点：技能 + 记忆块
- 边：
  - 技能-技能（related_skills）
  - 记忆-技能（词法重叠 + 名称命中加权）
- 统计：
  - 孤立率
  - 使用率
  - agent 创建比例
  - top categories

这说明 Hermes 不是只想“有 memory 有 skills”，而是想让这些学习信号变得：
- 可观察
- 可解释
- 可诊断

它在做的是：
> **学习可见化。**

---

## 八、为什么 `agent_context` 写保护特别重要

这一点很容易被忽略，但实际上非常关键。

Hermes 在 background review / memory provider 这里明确区分：
- 主会话
- cron
- subagent
- review fork

这意味着它已经意识到：

> **不是谁产生了知识，就都应该直接写进同一个用户画像里。**

否则会发生：
- cron 噪音污染用户画像
- subagent 独立视角污染主会话知识
- review fork 的审查 prompt 反过来变成用户记忆

所以 `agent_context` 写保护本质上是在回答：
> **谁有权定义长期知识。**

这比普通“权限控制”更深，因为它是在保护：
- 知识库的语义纯度

---

## 九、这一章真正解决了哪些工程问题？

### 1. 如何让知识进入当前 session，又不破坏缓存前缀
Hermes 的解法：冻结快照 vs 活态写入双态模型

### 2. 如何防止知识写入把知识库搞坏
Hermes 的解法：漂移检测、原子写、威胁扫描、审批门控、consolidation failure 上限

### 3. 如何让技能库不膨胀成垃圾场
Hermes 的解法：三态状态机 + 来源分级 + 用量追踪 + curator

### 4. 如何让知识沉淀变成强制通道，而不是软提示
Hermes 的解法：background review fork

### 5. 如何让学习结果变得可见、可解释、可诊断
Hermes 的解法：learning graph + 密度统计

这一章真正要学的，不是“记忆功能很多”，而是：

> **Hermes 如何把长期知识、技能治理、后台审查和学习可视化统一成一个真正可持续运行的学习系统。**

---

## 十、读者最容易学错的地方

### 错觉 1：memory 就是 Memory.md 文件
错。真正核心是双态记忆架构和写入协议。

### 错觉 2：background review 只是自动提示
错。它是自主知识维护的硬通道。

### 错觉 3：skills 就是 prompt 片段库
错。它们有状态机、来源分级、用量追踪和自动重构系统。

### 错觉 4：LearningGraph 只是 UI 可视化
错。它在回答“学到了什么”这个产品级问题。

### 错觉 5：谁都能往长期知识里写东西
错。Hermes 明确在控制 agent_context 的写入来源。

---

## 十一、分析边界

### 为什么这里不先深挖具体 memory provider 插件实现
因为第一轮先看 Hermes 如何定义统一记忆契约和知识治理边界，而不是每个 provider 的细节。

### 为什么这里要把 curator 和 background review 放进主线
因为如果把它们当成后处理，就会错过 Hermes 的学习闭环哲学。

### 为什么 LearningGraph 必须进主线
因为它不是装饰功能，而是在让"学到了什么"这件事变得可见。

---

## 十二、读者分层路由

### beginner
先抓住：
1. Hermes 的知识系统不是“有 memory 和 skills”，而是有治理闭环
2. 记忆分成冻结快照和活态写入
3. background review 是强制知识沉淀通道

### intermediate
重点看：
- MemoryStore 四操作
- curator 生命周期治理
- 来源分级
- 用量追踪
- learning graph

### advanced
重点看：
- 双态记忆如何保护缓存稳定性
- 写审批、agent_context 写保护、background review 隔离如何共同保护知识纯度
- 为什么 Hermes 的学习系统比一般 Agent 更像“知识操作系统”

---

## 十三、迁移清单

### 可迁移思想 1：知识双态（冻结快照 vs 活态写入）
- 可迁移到：重视缓存前缀稳定性的长跑 Agent
- 前提：长期知识既要注入，又不能每轮改写前缀
- 不适合直接照搬到：无缓存约束、无长期知识需求的系统

### 可迁移思想 2：技能生命周期治理
- 可迁移到：技能会不断增殖的系统
- 前提：技能不只是静态模板，而会被 agent 创建、使用、淘汰
- 不适合直接照搬到：技能极少且完全人工管理的系统

### 可迁移思想 3：后台审查 fork
- 可迁移到：希望让知识沉淀变成硬通道的系统
- 前提：系统可承受额外审查成本，并能严格隔离审查副作用
- 不适合直接照搬到：低资源、无持续运行需求的系统

### 可迁移思想 4：学习可视化图谱
- 可迁移到：想让知识资产可诊断、可解释的系统
- 前提：技能/记忆已经被结构化存储
- 不适合直接照搬到：知识单元尚未结构化的系统

---

## 十四、自测问题

1. 为什么 Hermes 的记忆系统要分成冻结快照和活态写入？
2. 为什么 background review 不是“自动提示”，而是知识沉淀硬通道？
3. 为什么 skills 必须有 active/stale/archived 生命周期？
4. 为什么 `agent_context` 写保护对长期知识很关键？
5. 为什么 LearningGraph 是学习系统主线的一部分，而不是 UI 附加功能？

---

## 十五、读完这一章，读者应该获得什么能力？

至少应该能做到：

1. 解释 Hermes 如何把 memory、skills、curator、background review 和 learning graph 组织成一个学习闭环。
2. 说清双态记忆、技能生命周期、来源分级、写审批和后台审查各自的角色。
3. 理解为什么 Hermes 的知识系统要比一般 Agent 更重、更谨慎。
4. 理解为什么学习图谱和知识治理都属于主运行语义，而不是后处理功能。
5. 用自己的话说明：Hermes 为什么更像一个“带知识治理和学习可视化的长期代理系统”。

如果还做不到这些，就说明这章还没真正学懂。
