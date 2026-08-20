# SessionProjector 与 History：OpenCode 如何把内部状态投影成用户可见会话

> 项目：OpenCode (`v1.18.18` 基线)
> 角色：主线机制正文 06
> 对应范围规划：`01-OpenCode源码学习范围规划.md`
> 依据材料：`Agent/analysis/opencode/01-闭环笔记/q9-projector.md`

---

## 零、阅读前提示

- 建议先读：
  1. `00-OpenCode主线总图.md`
  2. `02-EventV2与SessionInput...`
  3. `03-SessionRunner与SessionExecution...`
  4. `04-ToolRegistry与Tool Settlement...`
  5. `05-SystemContext与Compaction...`
- 推荐源码阅读路径：
  1. `packages/core/src/session/projector.ts`
  2. `packages/core/src/session/message-updater.ts`
  3. `packages/core/test/session-projector.test.ts`
  4. `packages/core/src/session.ts`
  5. `packages/core/src/session/history.ts`

## 一、这一章真正的问题

前面几章一直在分析：
- 系统真相怎么记录
- 执行骨架怎么推进
- 工具协议怎么结算
- 上下文怎么稳定
- 权限边界怎么控制

但用户真正看到的不是这些内部对象，而是：
- 一条条 user / assistant / tool / system 消息
- 一段段 history
- 一个“看起来连贯”的会话

所以这一章真正的问题是：

> **OpenCode 如何把内部 durable 事件和运行状态，稳定地投影成用户可见的会话消息。**

也就是说，这里关注的不是“系统怎么跑”，而是：
- 系统跑出来的状态，最后如何被解释、排序、更新和展示

---

## 二、先给结论：SessionProjector 不是“把事件渲染成文本”，而是消息状态机

最容易犯的错，是把 projector 理解成：
- 有事件
- 就 append 一条消息
- 再把它们按时间排好

OpenCode 不是这么浅地做的。

它真正做的是：

- 把事件映射成消息状态变化规则表
- 明确哪些事件会：
  - 创建消息
  - 更新消息
  - 完成消息
  - 忽略消息
- 保证消息顺序服从事件顺序，而不是消息自己的时间戳
- 保证 unfinished assistant / tool state 能被正确关闭和取代

所以 SessionProjector 的本质不是“视图层”，而是：

> **会话可见状态的确定性投影器。**

---

## 三、为什么 projector 必须在事件事务内执行

这里的关键不是 projector 本身做了什么，而是：

> **它是在 EventV2 的事务内执行的。**

这意味着：
- 事件提交成功 → 投影一定一致
- 投影失败 → 事件不提交

这个边界非常重要，因为它保证了：

> **用户看到的消息状态，不会和 durable 事件真相分叉。**

如果没有这条原子性约束，会发生什么？
- 事件已经落库了
- 但消息投影没写进去
- 或者写了一半
- 恢复后会话视图和真实执行历史对不上

所以 projector 在 OpenCode 里不是旁路消费者，而是：
> **真相提交的一部分。**

---

## 四、为什么“消息顺序 = 事件顺序”这么关键

普通聊天产品里，消息顺序常常按：
- 生成时间
- 前端收到的顺序
- 局部更新时刻

但 OpenCode 明确选择：

> **消息顺序 = durable event seq**

这其实是一条非常成熟的设计判断：
- 不信任局部时间戳
- 不信任流式到达顺序
- 只信任统一事件序

这意味着：
- 实时路径和重放路径会生成相同的消息顺序
- 历史恢复时，不会因为时间差导致视图不稳定
- “消息是什么顺序看到的”不再依赖客户端运气，而依赖系统真相

这一点对 Agent 产品很重要，因为很多复杂语义（tool call、compaction、retry、switch）只要顺序一乱，用户理解就会崩。

---

## 五、Assistant 为什么是消息模型的中心对象

在 OpenCode 的消息世界里，assistant 消息不是普通文本块，而是整个会话可见状态的主轴。

它的生命周期大致是：
1. `step.started` 创建一个新的 assistant 消息
2. text / reasoning / tool 结果不断追加到它上面
3. `step.ended` / `step.failed` 让它定稿

这意味着：

> **assistant 不是“回复文本”，而是“一个执行 step 的外显容器”。**

所以你不能只把它看成：
- 模型说的话

而应该把它看成：
- 这一轮执行对用户可见的外壳
- 它承载 text
- 也承载 reasoning
- 也承载 tool states
- 还承载 cost / tokens / snapshot 等元信息

这就是为什么 OpenCode 要在 `step.started` 时：
- 完成上一个未完成的 assistant
- 再 append 一个新的 assistant

这不是 UI 细节，而是在保证：
> **新的执行轮次不会错误复活旧的不完整消息。**

---

## 六、工具状态机为什么必须出现在消息投影层

很多系统会把工具状态只留在内部执行层，最终只给用户一个：
- 调用了什么
- 成功/失败

OpenCode 不是这样。它把工具状态也带进了消息投影模型。

工具状态机是：
- pending
- running
- completed
- error

而且不同事件会推动状态迁移：
- `tool.input.started`
- `tool.input.ended`
- `tool.called`
- `tool.progress`
- `tool.success`
- `tool.failed`

### 这在解决什么问题？
它在解决：
- 工具不只是副作用，还是用户理解当前执行状态的重要窗口
- 工具结果不是一个静态 blob，而是有过程、有终态
- 崩溃恢复后，用户仍然应该看到“这个工具已经失败化”而不是悬挂着

也就是说，OpenCode 在这里做的是：
> **把工具执行过程从内部 runtime 状态，提升成可解释的会话状态。**

这对调试和用户信任都很重要。

---

## 七、为什么 delta 不能直接投影成最终消息

和 EventV2 那一章一样，这里有一条非常关键的原则：

> **delta 是 live 增量，不是 durable final state。**

所以 projector 的策略是：
- delta 可以累积
- 但真正的定稿要看 `Ended`

这意味着：
- 如果增量过程中有丢块、错序、补发
- 最终仍然要以 Ended 的完整值为准

否则消息投影就会受制于流式噪声，而不是受制于 durable truth。

这和“消息顺序 = 事件顺序”是同一层设计思想：
> 用户可见状态必须有稳定的真相来源。

---

## 八、为什么有些事件会被投影，有些不会

这一点也很有代表性。

OpenCode 不会看到什么事件都给用户 append 一条消息。

它明确区分：

### 直通投影事件
例如：
- agent switched
- model switched
- prompted
- context updated
- shell started
- compaction ended

这些会直接变成可见消息，因为它们本身就在改变会话理解。

### 忽略事件
例如：
- prompt admitted
- tool input delta
- retried
- compaction started / delta
- revert.*

这些对系统内部很重要，但不一定适合作为用户可见消息直接暴露。

这说明 projector 在做的不是“完整事件镜像”，而是：

> **有选择地把内部状态转换成对人类有意义的会话视图。**

这就是“投影”的真正含义。

---

## 九、这一章真正解决了哪些工程问题？

### 1. 如何把 durable 事件稳定映射成用户可见会话
OpenCode 的解法：projector + message updater 规则表

### 2. 如何保证实时路径和重放路径的会话视图一致
OpenCode 的解法：消息顺序 = 事件 seq，定稿以 Ended 为准

### 3. 如何把 assistant / tool / text / reasoning 组织成统一会话对象
OpenCode 的解法：assistant 消息作为外显容器，tool state 进入消息模型

### 4. 如何防止中断后旧的 unfinished assistant 错误复活
OpenCode 的解法：step.started 先完成旧未完成 assistant，再开始新 assistant

### 5. 如何只把真正有意义的事件暴露给用户
OpenCode 的解法：显式区分直通消息和忽略事件

这说明 OpenCode 在这里解决的不是“显示历史消息”这么简单，而是：

> **如何让用户看到的是稳定、可解释、可恢复的会话视图。**

---

## 十、读者最容易学错的地方

### 误区 1：把 projector 当事件转字符串
错。它是在维护一个消息状态机。

### 误区 2：把 assistant 当普通文本消息
错。assistant 是一轮 step 的可见外壳。

### 误区 3：把 tool 结果当最终状态，不关心过程
错。pending / running / completed / error 的变化本身就是会话语义的一部分。

### 误区 4：把 delta 当最终值
错。Ended 才是 durable 定稿边界。

### 误区 5：以为所有事件都该被投影给用户
错。投影器做的是“人类可理解状态选择”，不是事件镜像。

---

## 十一、分析边界

### 为什么这里不先看 facade / history 的 API 细节
因为这一章先关注“状态如何被投影出来”，而不是“这些状态后来怎么被接口读取”。

### 为什么这里不先看前端渲染
因为消息状态机的核心不在 UI，而在 durable event → visible session 的中间层。

### 为什么测试仍然是关键证据
assistant 生命周期、tool state 终态、ignored events、delta/ended 边界，这些很多都是从测试里才能确认完整约束。

---

## 十二、读者分层路由

### beginner
先抓住：
1. projector 不是展示层，而是消息状态机
2. assistant 是一轮执行的外显容器
3. 消息顺序依赖事件 seq，不依赖消息时间戳

### intermediate
重点看：
- step.started / ended / failed
- tool pending → running → completed / error
- delta vs Ended
- ignored events 列表

### advanced
重点看：
- projector 为什么必须在事务里跑
- message updater 为什么是纯规则表
- usage / snapshot / cost 如何进入可见消息模型
- 为什么“事件镜像”不是一个好投影设计

---

## 十三、迁移清单

### 可迁移思想 1：消息顺序 = durable event seq
- 可迁移到：所有需要 replay / resume 的 Agent 系统
- 前提：有统一事件真相源
- 不能照搬的点：没有 durable 事件层的系统，单用这个规则意义不大

### 可迁移思想 2：assistant 作为 step 外显容器
- 可迁移到：多工具、多增量、多状态的 Agent 会话系统
- 前提：执行轮次和可见回复需要强绑定
- 不能照搬的点：极简 chat bot 不一定需要这么重的消息模型

### 可迁移思想 3：tool state 进入可见消息层
- 可迁移到：强调调试、审计、用户可解释性的 Agent 产品
- 前提：用户真的需要理解工具过程
- 不能照搬的点：如果产品只关心最终结果，过程可视化可以弱化

### 可迁移思想 4：投影器只暴露“人类有意义的事件”
- 可迁移到：任何事件驱动系统的对外状态视图层
- 前提：需要明确区分内部事件和用户可见状态
- 不能照搬的点：调试模式和产品模式可能需要不同视图

---

## 十四、自测问题

1. 为什么 SessionProjector 不能只是把事件按时间渲染成文本？
2. 为什么消息顺序必须绑定 durable event seq？
3. 为什么 assistant 在 OpenCode 里更像一个 step 容器，而不只是回复文本？
4. 为什么 tool state 要进入可见消息模型？
5. 为什么 delta 不能被当成最终会话真相？

---

## 十五、读完这一章，读者应该获得什么能力？

至少应该能做到：

1. 解释为什么 OpenCode 需要一个确定性的 SessionProjector，而不是简单 history append。
2. 说清 assistant / tool / text / reasoning 在消息模型中的关系。
3. 理解为什么消息顺序必须以事件 seq 为准。
4. 理解为什么有些事件会被投影，有些事件会被忽略。
5. 用自己的话说明：OpenCode 是如何把内部 durable 状态转成用户可见会话的。

如果还做不到这些，就说明这章还没真正学懂。
