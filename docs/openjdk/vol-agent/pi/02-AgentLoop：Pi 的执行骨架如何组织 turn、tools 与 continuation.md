# Agent Loop：Pi 的执行骨架如何组织 turn、tools 与 continuation

> 项目：Pi（main 基线）
> 角色：主线机制正文 01
> 对应范围规划：`01-Pi源码学习范围规划.md`
> 依据材料：`Agent/analysis/pi/01-闭环笔记/pass2-q4-agent-loop.md`

---

## 零、阅读前提示

- 如果你对 Agent loop / tool call / continue / steer / follow-up 这些概念完全没感觉，先读：`../03-Agent源码前置认知桥.md`
- 如果你还没看 `Pi` 范围规划，先读：`01-Pi源码学习范围规划.md`
- 推荐源码阅读路径：
  1. `agent/src/agent-loop.ts`
  2. `agent/src/agent.ts`
  3. `agent/src/types.ts`
  4. `agent/src/harness/agent-harness.ts`
  5. `agent/test/harness/reducer.test.ts`

## 一、这一章真正的问题

如果你第一次看 Pi，很容易把 `agent-loop.ts` 理解成：
- 一个会调模型的循环
- 有工具就调工具
- 没工具就停下

这会把它看得太浅。

更准确的问题是：

> **Pi 的执行骨架，到底是如何把“当前 turn 的工具续跑”和“会话级 follow-up/steering 驱动”分开的？**

也就是说，这一章真正要回答的是：

1. 为什么 Pi 需要两个入口：`agentLoop` 和 `agentLoopContinue`？
2. 为什么 Pi 的 loop 也采用双层结构？
3. 为什么 steering 和 follow-up 的消费时机不一样？
4. 为什么工具失败不会立刻把循环打死，而是被包装成模型可见错误结果？

---

## 二、先给结论：Pi 的 loop 不是“会不会继续问模型”，而是“如何分层推进一个会话”

Pi 最成熟的地方之一是：
- 它没有把所有输入和续跑逻辑糊成一个 while(true)
- 而是明确分成：
  - 新 prompt 启动
  - continue 续跑
  - tool continuation
  - steering 注入
  - follow-up 注入

所以它解决的不是“模型下一轮说什么”，而是：

> **一个会话里，什么时候是在继续同一轮语义，什么时候是在开始新的会话级工作。**

这和 OpenCode 的双层循环有共鸣，但 Pi 的表达方式更接近：
- loop + queue
- 而不是 event-sourcing / inbox 模型

所以这里真正值钱的是它的：
> **会话推进分层语义**

---

## 三、为什么 `agentLoop` 和 `agentLoopContinue` 必须分开

Pi 的两个入口不是方便 API 使用，而是在表达语义差别：

### `agentLoop(prompts)`
- 用于全新启动
- 没有上轮上下文续跑约束

### `agentLoopContinue(context)`
- 用于重试 / 工具结果后续跑 / 继续当前上下文
- 有硬约束：最后消息不能是 `assistant`
- 必须能转成 user/toolResult 结尾，才能继续让 LLM 工作

这点特别重要，因为它在回答：

> **不是所有“再跑一次”都叫 continuation。**

有些继续，是：
- 当前 turn 接着往下做

有些继续，是：
- 新的 session-level 输入出现了

Pi 明确把这两类情况分开了，这比很多系统里“重新再调一次模型”成熟得多。

---

## 四、双层循环为什么是 Pi 的核心骨架

Pi 的 `runLoop` 核心价值就在于它把两件事拆开了：

### 外循环
- 消费 `follow-up`
- 决定会话级是否还有新工作

### 内循环
- 消费 `tool calls`
- 处理当前 provider turn 的 continuation
- 注入 steering
- 执行工具
- 判断这一轮是否该 stop / continue

这件事值钱的地方在于：

> **Pi 明确区分了“工具驱动的局部续跑”和“会话级新任务驱动的继续”。**

如果不这么拆：
- steering
- follow-up
- tool results
- retry
会非常容易混在一起，形成失控循环。

所以 Pi 的 loop 不是“层次多一点”，而是：
> **执行语义真的被分层了。**

---

## 五、为什么 steering 和 follow-up 的消费时机不同

这是 Pi 特别值得学的一点。

### steering
- 在每轮开始前注入
- 本质上是：
  > 对当前执行方向的即时引导

### follow-up
- 在 agent 想停时再注入
- 本质上是：
  > 会话级的下一阶段工作

如果你把这两个都当成“用户再发了一句输入”，就会完全看不懂 Pi 的控制面。

Pi 的真正判断是：
- steering = 改当前轮的方向
- follow-up = 在当前轮结束边界再引入新的任务

这条区分特别重要，因为它影响：
- 队列消费顺序
- 会话状态机
- 继续运行的边界

---

## 六、为什么 `prepareNextTurn` 和 `shouldStopAfterTurn` 这两个钩子这么值钱

这两个钩子很像扩展点，但其实它们在定义 loop 的开放性。

### `prepareNextTurn`
它允许在每轮后：
- 换模型
- 调整 thinking 级别
- 修改下一轮上下文

这意味着 Pi 的 loop 不是硬编码的，它留了一个“转向下一轮”的正式接口。

### `shouldStopAfterTurn`
它允许系统在一轮完成后外部决定：
- 要不要继续
- 要不要停

这就把“任务完成判定”从 loop 内部逻辑里拉出来，变成可插拔决策点。

这两者一起说明：

> **Pi 的执行骨架不是封死的，它预留了系统级调度和判定的插口。**

这非常适合作为产品设计的学习点。

---

## 七、工具执行为什么是“并行执行 + 顺序输出”

Pi 在工具执行上的成熟点，不只是“支持并行”。

更关键的是：
- 工具可以并行执行
- 但最终结果仍按原始调用顺序回到上下文

这点很重要，因为它平衡了两件事：

### 1. 运行效率
- Promise.all 并行

### 2. 模型理解稳定性
- LLM 看到的结果顺序和 tool call 顺序一致
- 不会因为完成时间快慢打乱语义

所以这里的工程判断不是“快”，而是：
> **并行执行，但绝不让模型看到乱序结果。**

这非常成熟。

---

## 八、为什么“immediate 错误结果”模式很值钱

Pi 的另一个高价值判断是：
- 工具准备阶段的失败
  - 找不到工具
  - 参数无效
  - 被 beforeToolCall block
  - 被 abort
- 不会直接把 loop 打死
- 而是立刻生成一个错误 ToolResultMessage 返回给模型

这说明它在解决的是：

> **工具失败不是进程级异常，而是 Agent 继续思考时必须看见的上下文事实。**

所以 Pi 没有把工具错误当“程序炸了”，而是当：
- 模型要重新判断下一步的输入

这和“错误进入上下文”这件事，是很多成熟 Agent 共同的深层设计。

---

## 九、为什么截断时要把所有工具调用全部失败

这一点非常有代表性。

Pi 的判断是：
- streamed tool-call arguments 如果所在消息被截断
- 即使参数还能勉强 parse / validate
- 也一律认为不安全
- 全部 fail

为什么？
因为：
> **“能解析”不等于“语义完整”。**

这说明 Pi 在这里极其保守：
- 宁可让模型重新发起
- 也不执行一个看似完整、实际上可能静默缺失字段的工具调用

这条边界很成熟，值得重点学习。

---

## 十、动态工具注册为什么是 Pi 的“自进化机制”

Pi 的工具执行链里还允许：
- 工具执行后带 `addedToolNames`
- 下一轮 LLM 就能看见新增工具

这意味着：
- Agent 不是只消费固定工具集
- 它可以在执行中给自己扩展能力面

这一点非常关键，因为它说明：

> **Pi 在设计上已经允许“能力在运行中扩展”。**

这和 OpenCode 的 plugin / skills 有共鸣，但 Pi 的表达更靠近 loop 内核。

---

## 十一、这一章真正解决了哪些工程问题？

### 1. 如何区分“继续同一轮”与“开始下一轮工作”
Pi 的解法：双入口 + 双层循环 + steering/follow-up 不同消费时机

### 2. 如何把任务完成判定和下一轮配置从 loop 内核里抽出来
Pi 的解法：`prepareNextTurn` + `shouldStopAfterTurn`

### 3. 如何让工具执行既高效又不打乱模型语义
Pi 的解法：并行执行 + 顺序输出

### 4. 如何让工具失败成为模型可见事实，而不是程序级崩溃
Pi 的解法：immediate 错误结果模式

### 5. 如何防止截断消息里的“伪完整”工具参数被执行
Pi 的解法：截断全失败

### 6. 如何让能力在运行中扩展
Pi 的解法：`addedToolNames` 动态注入

这一章最值得学的，不是“Pi 也有一个 loop”，而是：

> **它把会话推进、工具续跑、引导输入、停止判定和能力扩展组织成了一个清晰分层的执行骨架。**

---

## 十二、读者最容易学错的地方

### 错觉 1：agentLoopContinue 只是再跑一次模型
错。它有严格上下文结尾约束，代表 continuation 语义。

### 错觉 2：双层循环只是写法选择
错。它在分离会话级 follow-up 和 turn 级 tool continuation。

### 错觉 3：steering 和 follow-up 都是新消息
错。两者的语义和消费时机完全不同。

### 错觉 4：工具失败就是异常
错。Pi 把工具失败变成模型可见上下文事实。

### 错觉 5：addedToolNames 只是小功能
错。它实际上让 runtime 能在执行中扩展能力面。

---

## 十三、分析边界

### 为什么这里不先看 AgentSession 大状态机
因为这章先讲最外层执行骨架，状态机作为下一层更复杂的控制面再展开更清楚。

### 为什么这里不先看具体 tool leaf 实现
因为这一章关心的是工具协议和执行时序，不是某个具体工具如何读文件。

### 为什么测试是关键证据
双层循环、steering/follow-up、截断全失败、并行执行顺序输出这些，都必须靠测试行为契约来确认，不能只看直觉。

---

## 十四、读者分层路由

### beginner
先抓住：
1. Pi 的 loop 不是普通对话循环
2. continuation 和 follow-up 不是一回事
3. 工具失败不会立刻打死系统

### intermediate
重点看：
- 双入口
- 双层循环
- prepareNextTurn / shouldStopAfterTurn
- 并行工具执行 + 顺序输出

### advanced
重点看：
- immediate 错误结果模式
- 截断全失败的安全边界
- addedToolNames 的动态能力扩展意义
- processEvents 如何用事件归约更新内部状态

---

## 十五、迁移清单

### 可迁移思想 1：双入口区分启动与续跑
- 可迁移到：任何有 continue/retry/tool-result 续跑语义的 Agent
- 前提：系统确实区分新任务和当前轮 continuation
- 不适合直接照搬到：纯单轮问答型系统

### 可迁移思想 2：双层循环分离会话级和 turn 级控制
- 可迁移到：复杂工具调用 Agent
- 前提：系统存在 steering / follow-up / tool continuation 等多种输入类型
- 不适合直接照搬到：输入模型极简单的系统

### 可迁移思想 3：并行执行 + 顺序输出
- 可迁移到：多工具并行且需要稳定上下文顺序的系统
- 前提：LLM 对工具结果顺序敏感
- 不适合直接照搬到：工具间强依赖、必须顺序执行的系统

### 可迁移思想 4：截断全失败
- 可迁移到：工具调用来自流式参数生成的系统
- 前提：参数残缺但可 parse 的风险真实存在
- 不适合直接照搬到：非流式、固定 schema 低风险场景

---

## 十六、自测问题

1. 为什么 Pi 要区分 `agentLoop` 和 `agentLoopContinue`？
2. 为什么 steering 和 follow-up 的消费时机不同？
3. 为什么并行执行后还要按原顺序输出工具结果？
4. 为什么工具准备阶段失败不应该直接打死整个 loop？
5. 为什么截断消息里的工具调用必须全部 fail？

---

## 十七、读完这一章，读者应该获得什么能力？

至少应该能做到：

1. 解释为什么 Pi 的执行骨架需要双入口和双层循环。
2. 说清 steering / follow-up / tool continuation 三种输入语义的区别。
3. 理解为什么 Pi 把工具失败转成模型可见结果，而不是异常直接中断。
4. 理解并行执行 + 顺序输出和截断全失败分别在保护什么边界。
5. 用自己的话说明：Pi 为什么更像一个“可在多种前端形态下复用的共享运行时”，而不只是一个有 loop 的 Agent。 

如果还做不到这些，就说明这章还没真正学懂。
