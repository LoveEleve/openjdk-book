# Context Compression：Hermes 为什么把缓存边界当成架构约束

> 项目：Hermes（main 基线）
> 角色：主线机制正文 03
> 对应范围规划：`01-Hermes源码学习范围规划.md`
> 依据材料：`Agent/analysis/hermes-agent/01-闭环笔记/pass2-hq4-context-compression.md`

---

## 零、阅读前提示

- 建议先读：
  1. `02-AIAgent主循环：Hermes 如何组织 turn、工具批与长期运行.md`
  2. `03-TurnRunner与GatewayRunner：Hermes 如何把多会话与多平台运行收进同一执行系统.md`
  3. `../03-Agent源码前置认知桥.md`
- 推荐源码阅读路径：
  1. `agent/context_compressor.py`
  2. `agent/conversation_compression.py`
  3. `agent/native_compaction.py`
  4. `agent/context_engine.py`
  5. `agent/context_breakdown.py`
  6. `docs/micro-compaction.md`

## 一、这一章真正的问题

Hermes 一开始就把一条约束写得非常狠：

> **Per-conversation prompt caching is sacred.**

这意味着压缩在 Hermes 里不只是“上下文大了就摘要一下”，而是在回答：

1. 模型可见上下文何时允许改变？
2. 为了不破坏缓存前缀，哪些内容绝不能被随意重写？
3. 压缩如果反复失败或收益太小，系统如何避免 thrash？
4. 摘要、知识保留、提交、取消之间如何建立确定性边界？

所以这一章真正的问题是：

> **Hermes 为什么把上下文压缩当成运行时架构的一部分，而不是一个 token 优化器。**

---

## 二、先给结论：Hermes 的压缩系统不是“摘要器”，而是被缓存边界、失败冷却、技能保留和提交栅栏共同约束的状态机

最容易犯的错，是把 `context_compressor.py` 理解成：
- 超长了就切一刀
- 叫模型总结一下
- 再继续跑

这会把 Hermes 看浅。

更准确的理解是：

> **Hermes 的压缩是一条独立的运行状态机，它既要管理 token 预算，也要保护 prompt cache、知识标记、工具配对、取消边界和失败恢复。**

这就是为什么它会有：
- should_compress 决策状态机
- ineffective 记账
- 冷却期
- 恢复试探
- 幽灵技能重注入
- 提交栅栏
- micro-compaction
- native compaction

这些东西如果只是“摘要功能”，根本不需要这么重。

---

## 三、为什么压缩决策必须是状态机，而不是单阈值

Hermes 当然也有阈值，但它远不止阈值。

它真正做的是：
- tokens < threshold → 不压缩
- cooldown 中 → 阻塞压缩
- ineffective 连续过高 → 防 thrash 阻塞
- 到恢复窗口时只给一次 probation probe

这说明它关心的不是：
- 有没有超过窗口

而是：
> **系统在当前条件下是否值得再压缩一次。**

这是非常成熟的工程判断，因为很多系统会死在：
- 一旦接近上限
- 每轮都触发压缩
- 每轮收益都很差
- 最后陷入 summary thrash

Hermes 明确把这种情况建模成状态机，而不是隐性经验规则。

---

## 四、为什么“三段式上下文”比简单切历史更强

Hermes 的 compaction 不是把旧消息一股脑压成摘要。

它明确在处理：
- **头部**：system prompt 永远保护，附加 protect_first_n
- **中间**：需要摘要的历史
- **尾部**：最近 token 预算内的 retained tail

而且它还会保证：
- tool_call/result 组不被拆开
- split turn 有自己的前缀摘要逻辑
- retainedTail 可以继续参与后续压缩

这说明 Hermes 对上下文的理解不是：
- 历史 vs 现在

而是：
> **稳定前缀 / 可摘要中段 / 必保留尾部**

这是一种比“删掉前面的”成熟得多的上下文视图建模。

---

## 五、为什么“幽灵技能”是一个值得单独讲的问题

这是 Hermes 很有代表性的设计点。

压缩后，如果 skill_view 工具的内容被摘要掉，模型很可能：
- 把原来明确的技能标记
- 改写成一段模糊散文

结果就是：
- 技能知识还“在”
- 但不再是可执行的技能指令

Hermes 把这个问题叫作：
> **幽灵技能（ghosted skills）**

然后它不是相信模型摘要会保留指令，而是：
- 先收集被裁掉的 skill markers
- 摘要后再检查这些 marker 是否还在
- 不在就确定性重注入 `Pruned Skills` 段

这非常值钱，因为它在说明一个深层原则：

> **对可执行知识，不能把“是否保留”交给模型自由改写。**

这和我们前面在 OpenCode 看到的 skills / guidance 分层，是同一类成熟判断。

---

## 六、为什么 memory provider context 要被当成“数据，不是指令”

Hermes 在摘要时会把记忆 provider 的内容显式包进：
- `<memory-provider-context>{JSON}</memory-provider-context>`

并且明确声明：
- 这是供摘要保留的源材料
- 不是指令

还会：
- 做 JSON 序列化
- 做 HTML 转义

这说明 Hermes 明确意识到：

> **知识 / 记忆不是天然可信的控制指令，它进入 LLM 调用前也必须防注入。**

这和前面 OpenCode / Reasonix 的思路是一致的：
- 结构化数据应该被当成数据，不是 prompt 指令

这个点对 Agent 系统特别重要，因为“长期记忆”和“当前控制语义”不能混成一锅。

---

## 七、为什么提交栅栏是这一章最值钱的设计之一

Hermes 的 `CompressionCommitFence` 很成熟。

它在解决的是：

> **压缩过程是同步运行的，但调用方可能取消等待。此时提交边界必须保持确定性。**

也就是说：
- 取消要么赢在 commit 之前
- 要么就等完整 commit 完成
- 不能出现“半提交半取消”的不确定态

这非常重要，因为压缩不是读操作，而是：
- 真正会改会话上下文可见状态
- 还会影响后续运行缓存和摘要连续性

所以提交栅栏保护的是：
> **上下文重写的确定性边界。**

这已经不是“压缩实现细节”，而是 runtime correctness 设计。

---

## 八、为什么 micro-compaction 和 native compaction 说明 Hermes 已经进入“成本策略层”

Hermes 不是只有一种压缩方案。

它明确同时考虑：
- 批量压缩（一次大摘要）
- micro-compaction（每轮折一个交换，摊销成本）
- native compaction（provider 原生压缩能力）

这说明它已经不只是“有没有压缩”，而是在做：

> **压缩成本策略的显式选择。**

这里很值钱的点在于：
- 不同压缩策略会影响：
  - prompt cache
  - 运行停顿
  - 知识二手化程度
  - 控制面复杂度

所以 Hermes 明确把这些取舍写出来，而不是隐藏在实现里。

---

## 九、这一章真正解决了哪些工程问题？

### 1. 如何在不破坏缓存前缀的前提下压缩长会话
Hermes 的解法：头/中/尾三区 + 缓存边界神圣约束

### 2. 如何避免压缩系统自己陷入 thrash
Hermes 的解法：冷却期 + ineffective 记账 + 恢复窗口试探

### 3. 如何保证压缩不会破坏工具协议和技能知识
Hermes 的解法：tool pair 边界保护 + ghost skill 重注入

### 4. 如何把知识提供者内容安全地带进摘要
Hermes 的解法：memory provider context JSON 化 + 转义 + 非指令声明

### 5. 如何让压缩提交和取消之间保持确定性
Hermes 的解法：CompressionCommitFence

### 6. 如何把压缩提升到成本策略层
Hermes 的解法：batch / micro / native 三路径并存

这一章最值得学的，不是“压缩很复杂”，而是：

> **Hermes 如何把上下文压缩从工具型功能，提升成受缓存、知识、协议和提交边界共同约束的运行状态机。**

---

## 十、读者最容易学错的地方

### 错觉 1：压缩就是摘要旧消息
错。Hermes 的压缩系统还在保护缓存前缀、技能知识、工具边界和提交确定性。

### 错觉 2：should_compress 只是 token 超限判断
错。它是带冷却和防 thrash 的决策状态机。

### 错觉 3：幽灵技能只是小 bug
错。它暴露了“模型改写可执行知识”这个很深的风险。

### 错觉 4：memory provider context 是普通字符串
错。它必须被当成结构化、不可信、可保留但不可执行的数据源。

### 错觉 5：取消压缩和提交压缩是同一件事
错。Hermes 用 commit fence 明确把两者区分开了。

---

## 十一、分析边界

### 为什么这里不先深入具体 provider 实现
因为这一章先回答“上下文为什么这样被压缩”，而不是“哪家模型怎么压缩”。

### 为什么这里不先看具体 memory provider
因为 memory 在这里的重点不是来源，而是它怎么安全地进入摘要链。

### 为什么文档 `micro-compaction.md` 也是主证据
因为这不是实现附注，而是显式记录的成本策略取舍。

---

## 十二、读者分层路由

### beginner
先抓住：
1. Hermes 的压缩不只是摘要
2. prompt cache 前缀是神圣边界
3. 幽灵技能说明压缩会伤害可执行知识

### intermediate
重点看：
- should_compress 状态机
- 头/中/尾三区
- split turn 处理
- ghost skill 防御
- memory provider context

### advanced
重点看：
- commit fence
- ineffective 记账 / probation probe
- micro vs batch vs native 三条成本路径
- why compression is runtime control, not helper utility

---

## 十三、迁移清单

### 可迁移思想 1：把缓存前缀当架构约束
- 可迁移到：强依赖 prefix cache 的长跑 Agent
- 前提：系统有稳定前缀和可延迟变化层
- 不适合直接照搬到：不依赖 provider cache 的小系统

### 可迁移思想 2：压缩决策状态机
- 可迁移到：压缩成本高、可能 thrash 的 Agent 系统
- 前提：压缩收益不是恒正收益
- 不适合直接照搬到：上下文很小、压缩调用极轻的系统

### 可迁移思想 3：可执行知识的确定性保留
- 可迁移到：skills / instructions / methods 对后续执行有真实影响的系统
- 前提：知识不是单纯描述，而会改变行为
- 不适合直接照搬到：知识只做展示、不参与执行的系统

### 可迁移思想 4：压缩提交栅栏
- 可迁移到：压缩会真实重写上下文状态的系统
- 前提：取消和提交之间有竞态
- 不适合直接照搬到：纯只读摘要器

---

## 十四、自测问题

1. 为什么 Hermes 把 prompt cache 边界当成架构约束，而不是优化细节？
2. 为什么 should_compress 必须是状态机，而不是单阈值？
3. 什么是幽灵技能，为什么它暴露了压缩的深层风险？
4. 为什么 memory provider context 必须被声明为“数据而不是指令”？
5. CompressionCommitFence 在保护什么边界？

---

## 十五、读完这一章，读者应该获得什么能力？

至少应该能做到：

1. 解释 Hermes 为什么把上下文压缩做成架构级机制。
2. 说清冷却、防 thrash、工具边界、知识保留和提交确定性之间的关系。
3. 理解 Hermes 为什么同时保留 batch / micro / native 三条压缩路径。
4. 理解为什么压缩系统和知识系统、执行系统、缓存系统是强耦合的。
5. 用自己的话说明：Hermes 为什么把压缩从“摘要工具”提升成了“运行时控制能力”。

如果还做不到这些，就说明这章还没真正学懂。
