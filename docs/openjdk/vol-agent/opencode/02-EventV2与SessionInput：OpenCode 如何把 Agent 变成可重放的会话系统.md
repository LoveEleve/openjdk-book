# EventV2 与 SessionInput：OpenCode 如何把 Agent 变成可重放的会话系统

> 项目：OpenCode (`v1.18.18` 基线)
> 角色：主线机制正文 01
> 对应范围规划：`01-OpenCode源码学习范围规划.md`
> 依据材料：`Agent/analysis/opencode/01-闭环笔记/q1-event-v2.md`

---

## 零、阅读前提示

- 如果你对 Agent / LLM / tool call / context 这些词完全不熟，先读：`../03-Agent源码前置认知桥.md`
- 如果你不清楚 OpenCode 整卷主线结构，先读：`00-OpenCode主线总图.md`
- 推荐源码阅读路径：
  1. `packages/schema/src/event.ts`
  2. `packages/core/src/event.ts`
  3. `packages/core/src/session/input.ts`
  4. `packages/schema/src/session-event.ts`
  5. `packages/core/test/event.test.ts`

## 一、这一章真正要回答什么问题

如果把 OpenCode 看成一个普通“模型 + 工具”的 CLI 程序，你很容易得到一个错误印象：

- 用户发一句话
- 模型回一句话
- 工具调一下
- 结束

但 OpenCode 不是这样设计的。

它真正要解决的问题是：

> **如何把 Agent 做成一个可持续运行、可恢复、可重放、可审计的会话系统，而不是一次性的内存循环。**

所以，这一章真正的问题不是“事件系统怎么写”，而是：

1. 为什么 OpenCode 不满足于单纯的 SessionPrompt 循环？
2. 为什么它要引入 EventV2 这样的事件溯源基础设施？
3. 为什么 SessionInput 要把输入提升为收件箱，而不是直接塞进 prompt 历史？
4. 为什么 durable / live-only、owner、replay、projector 这些东西会同时出现？

如果这些问题没想清楚，后面你再去看 SessionRunner、Context Epoch、Compaction、Tool Registry，就会一直觉得“这个系统为什么要这么复杂”。

---

## 二、先给结论：EventV2 不是“事件总线”，而是 OpenCode 的真相源

最容易犯的错，是把 EventV2 理解成一个更高级的 EventEmitter。

这会把 OpenCode 的设计完全看浅。

正确理解应该是：

> **EventV2 是一个事件溯源基础设施。**
> 它负责定义事件契约、提交协议、重放规则、owner 栅栏、以及 durable/live-only 的边界。

也就是说，EventV2 解决的不是“怎么通知别人有事发生”，而是：

- 什么才算这个会话系统真正承认的状态变化？
- 哪些变化必须可重放？
- 哪些增量只是运行时噪声？
- 如果系统中断了，怎么从日志里把状态重新建起来？

一旦理解到这一层，你就会发现：

- V1 的内存循环是一种“会跑”的实现
- V2 的 EventV2 才是一种“可以长期活下去”的系统基础设施

---

## 二点五、前置知识

读这一章前，最低限度最好先知道：

1. 什么是事件溯源（事件不是日志，而是状态真相）
2. 什么是收件箱模型（输入先被系统接收，再被执行引擎消费）
3. 什么是 replay / durable / live-only 边界

如果完全没有这些概念，也可以继续读，但建议先抓住：
- EventV2 = 真相源
- SessionInput = 收件箱

## 三、SessionInput 为什么重要：用户输入不是一段 prompt，而是收件箱里的待处理工作

OpenCode 在这里做了一件很关键的事：

> **它没有把新输入直接拼接进对话历史，而是先把输入放进 `session_input` 收件箱。**

这一步非常重要，因为它把“用户输入”从一段文本提升成了“待处理工作单元”。

你可以把它理解成：

- 普通聊天程序：新输入 = 历史里的又一条 user message
- OpenCode V2：新输入 = 收件箱里的新任务 / 新 steering / 新后续工作

这样设计的好处是：

1. **输入有状态**
   - admitted
   - promoted
   - consumed

2. **输入能幂等处理**
   - 同一个输入不会因为重放或恢复被重复消费成不同结果

3. **输入能进入 durable execution 语义**
   - 输入不再只是“模型看到什么”，而是“系统承认接到了什么工作”

这就是为什么 SessionInput 不能被理解成一个普通的消息数组。

它其实是：
> **Agent 的收件箱控制面。**

---

## 四、EventV2 的第一层：事件定义不是字符串，而是“版本化契约”

这一层最容易被忽视。

在 OpenCode 里，事件不是：
- 一个 type 字符串
- 一个 payload 对象
- 然后就 append 到日志里

它真正做的是：

### 1. 事件定义（define）
为每类事件绑定：
- type
- durable 元信息（可选）
- schema

### 2. latest
同一种事件如果有多个版本定义，系统要知道哪个是当前最新版本。

### 3. durable
durable 事件会被写成带版本号的 `type.version`，例如：
- `session.next.prompted.1`

这意味着：

> **事件不是自由文本，而是版本化契约。**

这件事对源码学习很重要，因为它回答了一个本质问题：

### 为什么 OpenCode 能长期演化，而不把恢复和重放搞坏？
因为它不是“把 JSON 丢进去就完了”，而是：

- 事件先被定义成契约
- 版本演进是显式的
- 重放时按版本解码

这是非常强的工程意识。

---

## 五、EventV2 的第二层：提交协议决定了系统是不是“真的可恢复”

这部分是 OpenCode 最值钱的地方之一。

很多系统会说自己是事件驱动，但真正关键的问题是：

> **状态投影和事件落库，到底是不是一个原子动作？**

OpenCode 的提交协议顺序大致是：

1. 读取当前 aggregate 的 seq
2. 校验新事件 seq 必须连续
3. 校验 event.id 全局唯一
4. 执行 projector
5. 执行 commit 回调
6. upsert event_sequence 并写入 event 表

最重要的是：

> **projector、commit、落库在同一事务里。**

这意味着：

- 如果 projector 失败 → 事件不提交
- 如果 commit 回调失败 → 事件和副作用一起回滚
- 如果落库失败 → 前面的投影也不算成功

所以 EventV2 不是“先改状态，再顺手记日志”，也不是“先写日志，再异步修状态”。

它的承诺是：
> **状态变化和事件真相同时成立，或者同时失败。**

这就是为什么它配得上“事件溯源基础设施”这个名字。

---

## 六、通知不是核心，重放才是核心

很多人看到事件系统，会先盯着 pub/sub、listener、bridge。

但在 OpenCode 里，更重要的问题不是“谁订阅了事件”，而是：

> **这些事件以后能不能重放出一致的状态。**

所以你看这套系统时，应该优先关注：

- durable 事件怎么写
- replay 怎么校验
- diverged event 怎么报错
- owner mismatch 怎么处理

而不是先看：
- listener 怎么广播
- bridge 怎么兼容 V1 bus

通知是消费层问题；
重放才是系统级正确性问题。

---

## 七、为什么要分 durable 和 live-only

这是 OpenCode 很关键的一条边界设计。

它明确把事件分成两类：

### 1. durable
必须能重放，构成系统真相的一部分。

例如：
- Started
- Ended
- PromptAdmitted
- ContextUpdated
- Tool.Called
- Tool.Success
- Tool.Failed
- Compaction.Ended
- Revert.Committed

### 2. live-only
运行时增量，可以丢，不要求重放。

例如：
- Text.Delta
- Reasoning.Delta
- Tool.Input.Delta
- Compaction.Delta

这条边界背后的核心思想是：

> **流式过程不是系统真相；定稿边界才是系统真相。**

这点极其重要，因为如果你把所有流式碎片都当真相来持久化：
- 恢复会变复杂
- 重放会变得脆弱
- 日志噪声会巨大
- 状态一致性会更难保证

所以 OpenCode 的回答非常清晰：

- Started / Ended 才是 replayable boundary
- Delta 只是用户体验层增量，不是 durable truth

这条设计边界，是很多 Agent 系统都应该学的。

---

## 八、owner / fencing：为什么事件日志里还要有“归属栅栏”

如果你第一次看这里，很容易疑惑：

> 都已经有 seq 了，为什么还要 owner？

因为对于一个会恢复、会重放、未来可能会多实例接管的系统来说，只靠 seq 不够。

还需要回答：

- 这个 aggregate 当前归谁处理？
- 我这次 replay 是不是在越权接管别人的状态？
- 如果两个运行者都认为自己能重放，会不会出现冲突？

owner + strictOwner 就是在回答这些问题。

它的价值在于：
- 不是只保证“事件序号没乱”
- 还保证“谁有权处理这条状态流”

也就是说：
> seq 保证顺序，owner 保证归属。 

这是一种非常典型的 **fencing / ownership** 思路。

---

## 九、SessionInput 和 EventV2 加在一起，才是 OpenCode 的 durable session 语义

如果把两者拆开看，会觉得：

- EventV2 只是事件系统
- SessionInput 只是输入队列

但把它们合起来看，你会发现：

### OpenCode 真正在做的是：
> **把 Agent 会话变成一个有收件箱、有事件日志、有重放协议、有所有权边界的持久执行系统。**

这就是它和“内存里跑个 loop”的本质差别。

简化理解：

- SessionInput：定义“系统接到了什么工作”
- EventV2：定义“系统真正承认发生了什么状态变化”
- Projector：定义“这些事件如何投影成对外可见状态”
- Replay：定义“系统中断后如何恢复”

这四者合起来，才是 OpenCode 的 durable execution 雏形。

---

## 十、读者最容易学错的地方

### 误区 1：把 EventV2 看成高级 EventEmitter
错。
它的核心不在通知，而在契约、提交协议、重放和 owner 栅栏。

### 误区 2：把 SessionInput 看成消息数组
错。
它本质上是收件箱控制面，而不是普通 prompt 历史。

### 误区 3：把 Delta 当成持久状态
错。
Delta 只是流式过程，Started / Ended 才是 durable truth。

### 误区 4：把 replay 理解成“把日志再跑一遍”
不够。
真正关键的是：
- seq 连续性
- diverged detection
- owner fencing
- 版本解码

### 误区 5：先看 V1 prompt loop，再把它当主线
这会把你带偏。
V1 有参考价值，但主线应该先落在 V2 的事件溯源执行骨架上。

---

## 十一、这部分最值得迁移的思想

### 1. 输入先进入收件箱，而不是直接进入历史
这个思想对任何需要可恢复执行的 Agent 都很关键。

### 2. 事件是版本化契约，而不是自由 JSON
这能显著提高演进与重放的可控性。

### 3. 投影、副作用、事件提交要同事务
否则“日志是一个版本、状态是另一个版本”的灾难几乎迟早会发生。

### 4. 流式增量不等于 durable truth
这是长跑系统里特别重要的一条边界。

### 5. 顺序保证之外，还要有归属保证
很多系统只讲 seq，不讲 owner/fencing，这在恢复和接管时很危险。

---

## 十二、横切机制：这章不只是 EventV2 的局部实现

这一章里其实已经出现了 3 条横切机制，它们不能只被理解成 EventV2 的内部细节：

### 1. 所有权 / 归属（owner / fencing）
- 它不只是 replay 的一个参数，而是“谁有权推进这条状态流”的全局约束。
- 后面看 session runner、resume、跨实例恢复时，还会再次出现。

### 2. durable / live-only 边界
- 这不只是事件分类，而是整个 Agent 系统对“什么算真相”的定义。
- 后面看 text/reasoning/tool input 的流式增量时，都会回到这条边界。

### 3. projector / commit 原子性
- 这不只是数据库实现技巧，而是 OpenCode 能不能说自己“可恢复、可重放”的核心前提。
- 后面分析 SessionProjector、SessionFacade、History 时都要回到这一点。

所以这一章虽然主题是 EventV2 + SessionInput，但它实际已经在给整套系统立法。

## 十三、结构化认知风险点

### 风险 1：把 EventV2 当成高级 EventEmitter
- 类型：`misread`
- 为什么会错：因为最显眼的是 publish / subscribe，而不是 replay / durable / owner。
- 正确理解：EventV2 的核心不在通知，而在“真相如何被定义、提交、重放和归属”。
- 出错后果：后面会低估 projector、seq、owner 栅栏的意义。

### 风险 2：把 SessionInput 当成消息数组
- 类型：`misread`
- 为什么会错：它表面上长得像输入历史，但本质是收件箱。
- 正确理解：SessionInput 记录的是“系统接到了什么工作”，不是“模型看到了什么文本”。
- 出错后果：无法理解 why queue/steer/promotion 会成为执行骨架的一部分。

### 风险 3：把 Delta 当成可重放状态
- 类型：`false-understanding`
- 为什么会错：流式增量最容易给人“这就是过程真相”的错觉。
- 正确理解：Started / Ended 才是 durable boundary，Delta 只是用户体验层增量。
- 出错后果：后面会误判 compaction、resume、history 的设计边界。

### 风险 4：把 owner / strictOwner 看成实现细节
- 类型：`debugging-blindspot`
- 为什么会错：owner 看起来像补充字段，但实际上是状态流归属栅栏。
- 正确理解：seq 保证顺序，owner 保证归属。
- 出错后果：在多实例恢复或接管语义上会完全失焦。

## 十四、分析边界

### 为什么这里不先看 UI / CLI / Web
因为这章关注的是“真相源”和“输入提升为收件箱”的底层语义；UI 只是外壳，不决定 durable session 是否成立。

### 为什么这里不先看 MCP / ACP / Protocol Bridge
因为这些是控制面外化；如果 EventV2 这层不懂，后面协议桥接只会变成表层接口清单。

### 为什么测试是证据层，而不是外围附录
因为很多关键语义——无窗口订阅、失败回滚、owner 栅栏——在测试契约里比注释更明确。这里测试不只是验证，而是设计证据。

## 十五、读者分层路由

### beginner
- 先抓住两个点：
  1. SessionInput = 收件箱，不是消息数组
  2. EventV2 = 真相源，不是通知总线
- 其余像 owner / diverged / durable/live-only，先建立印象即可。

### intermediate
- 要重点理解提交协议和 replay 四级校验。
- 这一层开始可以把它和后面的 SessionRunner/Projector 串起来看。

### advanced
- 应该重点看 owner/fencing、projector/commit 同事务、以及 Started/Delta/Ended 这类 replayable boundary 设计。
- 这决定了你是否能把它迁移到别的 Agent runtime。

## 十六、迁移清单

### 可迁移思想 1：输入先进入收件箱，再进入 prompt 历史
- 可迁移到：任何需要 continue / resume / durable execution 的 Agent 系统
- 迁移前提：系统必须承认“输入也是状态”，而不是临时文本
- 不能照搬的点：如果目标系统完全没有恢复语义，这套设计会显得过重

### 可迁移思想 2：事件是版本化契约，而不是自由 JSON
- 可迁移到：有 replay / projector / audit 需求的系统
- 迁移前提：需要长期演进和 schema 兼容
- 不能照搬的点：如果系统只是一次性流水日志，可能不需要这么重的版本语义

### 可迁移思想 3：Started / Delta / Ended 分离
- 可迁移到：任何需要同时支持流式体验和 durable 真相的系统
- 迁移前提：必须明确“哪些是过程增量，哪些是可重放边界”
- 不能照搬的点：如果系统没有 streaming，就不必强造这套事件族

### 可迁移思想 4：seq 保顺序，owner 保归属
- 可迁移到：会话恢复、多实例接管、长跑任务系统
- 迁移前提：需要解决“谁有权继续推进状态流”
- 不能照搬的点：单进程、单实例、无恢复的系统里 owner 成本可能过高

## 十七、关键源码位置

- `packages/core/src/event.ts`
  - 事件定义、提交协议、replay、owner 栅栏
- `packages/core/src/session/input.ts`
  - 收件箱 admit / promote / durable 输入提升
- `packages/schema/src/event.ts`
  - 事件契约与版本化定义
- `packages/schema/src/session-event.ts`
  - durable / live-only 边界与事件族
- `packages/core/src/event/sql.ts`
  - `event_sequence` / `event` 的持久化结构
- `packages/opencode/src/event-v2-bridge.ts`
  - V1 与 V2 的桥接边界
- `packages/core/test/event.test.ts`
  - replay / owner / durable tail / rollback 等关键契约证据

## 十八、工程问题学习点

### 工程问题 1：如何让状态变化可恢复而不是只可观察
- OpenCode 的解法：EventV2 + projector + durable event
- 代价：提交协议更重、事件契约必须版本化
- 可迁移性：适合任何需要 resume / replay 的 Agent runtime

### 工程问题 2：如何让输入成为可治理对象而不是自由文本
- OpenCode 的解法：SessionInput 收件箱
- 代价：输入路径更复杂，系统需要处理 admitted/promoted 语义
- 可迁移性：适合多轮执行和 steering 语义明显的系统

### 工程问题 3：如何处理流式增量与 durable 真相之间的冲突
- OpenCode 的解法：Started / Delta / Ended 边界
- 代价：事件种类增多，运行时模型更复杂
- 可迁移性：适合任何需要 stream + replay 共存的系统

## 十九、自测问题

1. 为什么 EventV2 不能被理解成普通事件总线？
2. 为什么 SessionInput 更像收件箱，而不是消息数组？
3. 为什么 Delta 不能直接当成 durable 状态？
4. 如果没有 owner / strictOwner，恢复和接管会出什么问题？
5. 为什么 projector / commit / 落库必须同事务？

## 二十、这一章读完，读者应该获得什么能力？

至少应该能做到：

1. 用自己的话解释：为什么 OpenCode 需要 EventV2，而不是普通事件总线。
2. 解释 SessionInput 为什么是收件箱，而不是简单消息列表。
3. 说清 durable vs live-only 的区别。
4. 说清 replay 为什么必须校验 seq / diverged / owner。
5. 理解 OpenCode 正在从 V1 prompt loop 迁向 V2 durable session 内核。
6. 知道这一章里的 owner / durable boundary / projector 原子性为什么会在后续章节反复出现。

如果还做不到这些，就说明这章还没真正学懂。
