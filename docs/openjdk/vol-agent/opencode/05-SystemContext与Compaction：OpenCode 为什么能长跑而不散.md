# SystemContext 与 Compaction：OpenCode 为什么能长跑而不散

> 项目：OpenCode (`v1.18.18` 基线)
> 角色：主线机制正文 04
> 对应范围规划：`01-OpenCode源码学习范围规划.md`
> 依据材料：`Agent/analysis/opencode/01-闭环笔记/q2-system-context.md`

---

## 零、阅读前提示

- 如果还没读前 3 篇，建议按顺序先读：
  1. `02-EventV2与SessionInput...`
  2. `03-SessionRunner与SessionExecution...`
  3. `04-ToolRegistry与Tool Settlement...`
- 如果对 context window / compaction / resume 不熟，先读：`../03-Agent源码前置认知桥.md`
- 推荐源码阅读路径：
  1. `packages/core/src/system-context/index.ts`
  2. `packages/core/src/system-context/registry.ts`
  3. `packages/core/src/session/context-epoch.ts`
  4. `packages/core/src/instruction-context.ts`
  5. `packages/core/test/system-context/*`

## 一、这一章真正的问题

Agent 系统最容易“表面能跑、长期必散”的地方，不是模型调用本身，而是：

- 模型每轮到底看见什么
- 上下文什么时候变了、为什么变了
- 指令、技能、引用、环境这些系统消息怎么被合并
- 上下文太长后压缩，怎么避免把系统主线压没
- 运行中断后，又如何恢复到一个一致的上下文基线

所以这一章真正要回答的问题是：

> **OpenCode 为什么能长跑，而不会在多轮执行、压缩、恢复、指令变更中把系统上下文搞散。**

这不是“怎么省 token”的问题，而是：
> **如何让模型每一轮看到的系统语义保持稳定、可比较、可替换。**

---

## 二、先给结论：SystemContext 不是拼 prompt，而是“可刷新上下文源的代数”

最容易学错的一点是：
- 看到 system context
- 就以为它只是把几段系统提示拼起来

这会严重低估 OpenCode 的设计深度。

OpenCode 在这里真正做的是：

- 把每一类系统上下文抽象成一个 `Source`
- 每个 `Source` 都有自己的：
  - key
  - codec
  - load
  - baseline
  - update
  - removed
- 然后用一套统一的代数来处理：
  - 初始化
  - 比较
  - 刷新
  - 替换
  - 删除

所以 SystemContext 的本质不是“system prompt builder”，而是：

> **一个可比较、可增量刷新、可恢复的一致性上下文系统。**

这对 Agent 来说极其关键，因为模型不是“理解世界”，模型只理解你喂给它的上下文。

所以如果上下文不稳，整个 Agent 再聪明也会散。

---

## 三、Source 为什么是六字段，而不是一段字符串

OpenCode 把上下文源建模成一个 `Source`，这里最值钱的点是：

它不是直接定义：
- 这段文本怎么渲染

而是先定义：
- 这个源怎么加载
- 怎么编码/解码
- 怎么形成 baseline
- 怎么计算 update
- 怎么描述 removed

也就是说，OpenCode 不是把上下文当静态文本，而是当：
> **可观察、可版本化、可比较的值**

### 这在解决什么问题？
它在解决：
- 配置变了，系统该怎么通知模型？
- 技能集变了，模型该知道什么？
- 指令文件变了，是增量补丁还是整体替换？
- 某个上下文源暂时不可用时，该保留旧值还是视为移除？

如果没有这种值语义，很多 Agent 系统最后只能做到：
- 每轮重拼一次 prompt
- 看起来简单
- 但没有一致性，也没有可恢复性

OpenCode 明显不是在走这条路。

---

## 四、三操作代数：initialize / reconcile / replace

SystemContext 最核心的地方，不是某个 Source，而是三种统一操作：

### 1. initialize
第一次观察全部源，建立初始 baseline。

### 2. reconcile
比较当前观察值和已承认的 snapshot，决定：
- Unchanged
- Updated
- ReplacementReady
- Blocked

### 3. replace
在满足条件时，把整个 generation 替换成新的稳定值。

这套设计很重要，因为它回答的是：

> **上下文变化发生后，系统怎么知道应该发增量、整体替换，还是先阻塞。**

也就是说，OpenCode 把“上下文变化”做成了一个状态机问题，而不是字符串拼接问题。

---

## 五、Unavailable 语义为什么这么关键

这里是 SystemContext 最容易被低估的深点之一。

在很多系统里，一个上下文源读失败，处理方式很粗暴：
- 要么当成没有
- 要么直接报错
- 要么继续拼残缺上下文

OpenCode 没这么做。

它区分了：

### 1. initialize 时 unavailable
- 不能当作“正常没有”
- 而是 `InitializationBlocked`

### 2. reconcile 时 unavailable
- 如果已有 snapshot，就保持旧值（stale-while-revalidate）
- 如果没有 snapshot，就跳过

### 3. replace 时 unavailable
- 触发 `ReplacementBlocked`

这条语义特别重要，因为它体现了一个成熟的工程判断：

> **临时不可用 ≠ 真正删除。**

如果这条边界不清楚，Agent 很容易在一次读文件失败、一次配置抖动后：
- 把指令清空
- 把技能消失
- 把系统上下文整体变成不稳定状态

所以 `Unavailable` 是 OpenCode 在保护：
> **上下文一致性不要被临时故障轻易破坏。**

---

## 六、为什么惰性渲染这么值钱

又一个特别容易被看成实现细节、其实很有工程味道的点。

OpenCode 在比较 source 是否变化时，并不会立刻把 update 渲染成文本。
它会：
- 先比较值层差异
- 只有确定这次变化真的要进上下文时，才渲染文本

这就是惰性渲染。

### 它解决了什么？
1. 避免做无意义工作
2. 避免中间态被误当最终态
3. 更重要的是：
   > **上下文系统先是状态比较系统，然后才是文本生成系统。**

这点非常成熟。

因为如果你先渲染，再比较：
- 很容易把渲染策略和状态语义混在一起
- 最后很难稳定处理 replace / removed / stale

惰性渲染让 OpenCode 始终保持一个更干净的边界：
- 先决定语义动作
- 再决定文本输出

---

## 七、指令域为什么是一等公民

在很多项目里，像 `AGENTS.md` 这种东西只是“附加说明”。

OpenCode 不是这样处理的。

它把指令域做成了 SystemContext 的真实消费者：
- 从当前目录向上搜 `AGENTS.md`
- 合并全局 + 项目 + 包路径中的指令
- 做稳定排序
- 整体作为一个上下文源参与 reconcile / replace

这很重要，因为它意味着：

> **指令不是 prompt 工程附属物，而是 Agent 会话语义的一部分。**

如果读者不理解这一点，后面很容易低估：
- instruction context
- builtins
- skill guidance
- reference guidance

这些东西的系统地位。

---

## 八、为什么 compaction 在 OpenCode 里是执行语义，而不是“删历史”

这一章虽然核心是 SystemContext，但必须连到 compaction，因为 OpenCode 的长跑能力就在这里成立。

如果没有这层，你会把 compaction 理解成：
- 上下文太长了，删一点历史

这太浅了。

在 OpenCode 里，compaction 的真正意义是：

1. 它要保留系统语义锚点
   - baseline
   - context epoch
   - durable 事件边界
   - 不可丢的系统指令

2. 它要允许系统继续长跑
   - 而不是每轮都越跑越膨胀

3. 它必须和执行骨架对齐
   - 否则压缩完上下文，模型继续沿旧 turn 理解，就会产生错位

所以你现在应该把 compaction 理解成：

> **OpenCode 在“上下文有限”这个现实下，为保证系统持续运行而引入的执行结构性动作。**

这和简单“压缩文本”完全不是一回事。

---

## 九、这一章真正解决了哪些工程问题？

### 1. 如何让多个上下文源在变化时不互相踩踏
OpenCode 的解法：`Source` + `initialize/reconcile/replace`

### 2. 如何在上下文源短暂不可用时避免系统语义崩坏
OpenCode 的解法：Unavailable = stale-while-revalidate

### 3. 如何让系统消息变化可比较、可重放、可恢复
OpenCode 的解法：baseline / snapshot / reconcile / replace

### 4. 如何让长跑系统的上下文既稳定，又能更新
OpenCode 的解法：Context Epoch + Compaction 协同

### 5. 如何把指令、技能、引用、环境统一纳入上下文控制面
OpenCode 的解法：SystemContext Registry + Builtins + InstructionContext + Guidance 源

这说明 OpenCode 真正厉害的不是“会拼 prompt”，而是：

> **它把 prompt 背后的状态管理，提升成了系统级基础设施。**

---

## 十、读者最容易学错的地方

### 误区 1：把 SystemContext 当成 system prompt 拼接器
错。它首先是上下文源代数和状态机。

### 误区 2：把 Unavailable 当 removed
错。临时不可用和真实移除是两类完全不同的语义。

### 误区 3：把 compaction 当文本压缩
错。它影响执行语义和 resume 语义。

### 误区 4：把指令域当附属说明文件
错。它是会话语义的一部分。

### 误区 5：把 baseline / snapshot / replace 看成实现细节
错。它们决定了系统上下文是否能稳定演进。

---

## 十一、分析边界

### 为什么这里不先看 MCP / ACP / 协议桥
因为这一章关注的是“模型到底看见什么”以及“这个视图如何演进”，协议桥属于控制面外化，应该后看。

### 为什么这里不先看 leaf skills / reference details
因为技能和引用在这一章里重要的不是内容本身，而是它们被当作 Source 进入统一上下文代数这一事实。

### 为什么测试是关键证据
很多 `Unavailable / replace / removed / 空渲染拒绝 / 稳定序` 的语义，在测试里比注释写得更明确；不看测试会低估上下文系统的精细程度。

---

## 十二、读者分层路由

### beginner
先抓住：
1. SystemContext 不是文本拼接器，是上下文状态系统
2. Unavailable 不是 remove
3. compaction 不是删历史

### intermediate
重点看：
- initialize / reconcile / replace
- baseline / snapshot
- instruction context
- builtins / guidance 源

### advanced
重点看：
- 惰性渲染
- 空渲染拒绝
- Registry 稳定序
- Context Epoch 与 compaction / resume 的协同

---

## 十三、迁移清单

### 可迁移思想 1：把系统上下文建模成 source algebra
- 可迁移到：任何需要多来源 system context 的 Agent
- 前提：你真的把上下文看成状态，而不是字符串
- 不能照搬的点：一次性 toy agent 不需要这么重

### 可迁移思想 2：Unavailable = stale-while-revalidate
- 可迁移到：任何长跑系统的配置 / 指令 / 引用上下文
- 前提：系统需要在短暂读取失败时保持稳定语义
- 不能照搬的点：如果场景要求强一致阻塞，不能默认保留旧值

### 可迁移思想 3：先决定语义动作，再渲染文本
- 可迁移到：所有“上下文会变”的 Agent 系统
- 前提：source 值层和文本层可分离
- 不能照搬的点：如果系统上下文完全静态，收益会变小

### 可迁移思想 4：指令 / 技能 / 引用 / 环境统一进上下文控制面
- 可迁移到：需要多种系统指导源共同作用的 Agent runtime
- 前提：这些源都必须有边界、顺序和可替换语义
- 不能照搬的点：如果某类信息只是旁路提示，不应强行升格为 Source

---

## 十四、自测问题

1. 为什么 SystemContext 不该被理解成 system prompt builder？
2. 为什么 Unavailable 不能等价于 removed？
3. 为什么 compaction 会影响执行语义，而不只是 token 数？
4. 为什么 instruction context 应该被纳入主上下文系统，而不是放在外围配置层？
5. 为什么 OpenCode 要先比较 source 语义，再做文本渲染？

---

## 十五、读完这一章，读者应该获得什么能力？

至少应该能做到：

1. 解释为什么 OpenCode 的上下文系统必须是“可刷新状态机”，而不是文本拼接器。
2. 说清 initialize / reconcile / replace 三种操作分别在解决什么问题。
3. 理解 Unavailable、removed、replace 之间的区别。
4. 理解 compaction 为什么必须和执行骨架协同。
5. 用自己的话说明：为什么一个能长跑的 Agent，不可能只靠 prompt engineering，而必须有一层真正的上下文工程。

如果还做不到这些，就说明这章还没真正学懂。
