# SessionRunner 与 SessionExecution：OpenCode 的执行骨架如何持续运行

> 项目：OpenCode (`v1.18.18` 基线)
> 角色：主线机制正文 02
> 对应范围规划：`01-OpenCode源码学习范围规划.md`
> 依据材料：`Agent/analysis/opencode/01-闭环笔记/q3-session-runner.md`

---

## 零、阅读前提示

- 如果你还没读 `02-EventV2与SessionInput...`，建议先读，否则这章的 run/continue/recover 语义会悬空。
- 如果你对 Agent loop / tool continuation 不熟，先读：`../03-Agent源码前置认知桥.md`
- 推荐源码阅读路径：
  1. `packages/core/src/session/runner/llm.ts`
  2. `packages/core/src/session/runner/publish-llm-event.ts`
  3. `packages/core/src/session/execution.ts`
  4. `packages/core/src/session/run-coordinator.ts`
  5. `packages/core/test/session-runner.test.ts`

## 一、这一章真正的问题

如果上一章 EventV2 + SessionInput 解决的是：

> **系统如何承认“发生了什么”**

那么这一章要解决的是：

> **系统如何持续地把“待处理输入 → 模型 → 工具 → 持久状态变化”这条链真正跑起来。**

也就是说，这一章的重点不是“某个函数怎么写”，而是：

1. OpenCode 的 Agent 执行为什么不是一个普通 while 循环？
2. 为什么它需要 `SessionRunner / SessionExecution / RunCoordinator` 这套骨架？
3. 一次 provider turn 到底会发生哪些阶段？
4. 中断、压缩、失败、工具并行、step 配额为什么都要进入统一执行语义？

如果这些问题没理解，后面再看 permission、tool registry、compaction、context epoch，就会只看到模块，而看不到控制面。

---

## 二、先给结论：OpenCode 的执行骨架不是“循环”，而是“持续可恢复的运行协议”

普通程序里的循环，通常是：
- 读输入
- 执行逻辑
- 输出结果
- 结束

OpenCode 的执行骨架不是这样。

它更像：

- 看收件箱还有没有工作
- 决定当前 turn 该怎么继续
- 让模型产出 text / reasoning / tool calls
- 立即启动工具执行
- 把所有增量和结果投影成 durable 事件
- 决定这轮执行结束没有、要不要继续、要不要压缩、要不要中断
- 下一轮从持久状态继续，而不是从内存继续

所以 `SessionRunner` 的价值不是“把模型调起来”，而是：

> **把 Agent 执行定义成一个可持续推进、可持久化、可中断、可恢复的协议。**

---

## 二点五、前置知识

读这一章前，最好先具备这些最小理解：

1. EventV2 / SessionInput 是 durable truth + 收件箱，而不是普通消息列表
2. 模型调用不是一次请求，而可能触发工具续跑
3. compaction / interrupt / continue 会改变执行流，而不是外围小功能

如果这些前提没建立，你会很容易把这章看成一个“过于复杂的 while 循环”。

## 三、双层循环：为什么 OpenCode 不只需要一个 while

OpenCode 的 `SessionRunner` 有一个很关键的结构：

- 外层循环：看会话级收件箱还有没有新工作（queue）
- 内层循环：看当前 provider turn 是否还需要 continuation（needsContinuation）

这不是写法偏好，而是控制面语义的体现。

### 外层循环解决什么？
它回答的是：
> **这个会话层面还有没有新的 durable 输入要处理？**

也就是说，系统不是看“内存里还有没有变量”，而是看：
- queue 里还有没有待提升工作
- 有没有下一轮需要开始的新任务

### 内层循环解决什么？
它回答的是：
> **当前这一轮 provider turn，在模型 / 工具 / steering 驱动下，还需不需要继续推进？**

这一步很关键，因为 Agent 不是：
- 模型回一段文本就结束
而是可能：
- 模型先出 tool call
- 工具跑完再续一轮
- 中途用户再 steer 一次
- 当前 turn 还要继续吃这个 steer

所以 `needsContinuation` 不是“多跑一轮”，而是：
> **当前 turn 的控制流还没有真正闭环。**

### 为什么这比单循环重要？
因为它把两类问题拆开了：

1. **会话层级还有没有工作**
2. **当前 turn 还要不要继续**

这样就不会把：
- 新输入
- 当前续跑
- tool continuation
- steer
- queue promotion
全部搅在一个 while 里。

这正是 OpenCode 作为产品级 Agent runtime 的成熟点之一。

---

## 四、一次 runTurn 不是“调一次模型”，而是严格的 7 步协议

OpenCode 对 provider turn 的处理，不是一个大黑箱。它把一次 turn 明确切成了 7 步：

1. location 校验
2. agent 选择
3. epoch initialize / prepare
4. promotion
5. request 组装
6. llm.stream + 增量事件发布
7. 工具结算与收尾

这个拆法很值钱，因为它说明：

> **OpenCode 把执行看成一个需要被阶段化治理的过程，而不是一次“模型调用函数”。**

我们逐个看它们分别在防什么问题。

### 1）location 校验
它先确保：
- 当前 runner 还在正确的 Location 上

这意味着：
- 如果会话被移动（move / workspace change）
- 旧 runner 不能假装自己还能继续跑

这不是小细节，而是：
> **执行归属必须先正确，后面所有上下文和工具结果才有意义。**

### 2）agent 选择
当前 turn 属于哪个 agent / provider / profile，不是后面临时猜，而是在 turn 开始阶段确定。

这一步在产品层意味着：
- 当前执行到底是谁在执行
- 观察 / 切换 / 运行时选择，会不会影响当前 turn

### 3）epoch initialize / prepare
这一步把本轮执行和上下文 epoch 绑起来。

它的意义是：
- 本轮看到的 baseline 是什么
- 压缩后如何重建 baseline
- 当前系统上下文是不是稳定可用

### 4）promotion
这里处理收件箱里的输入提升。

最关键的一点是：
- 如果 promoted 发生，`step` 要重置为 1

这不是计数器小技巧，而是语义声明：
> **新的 durable 输入到来，意味着进入新的执行回合。**

### 5）request 组装
这一层决定模型真正会看见什么：
- system
- baseline
- 权限过滤后的工具
- max-steps 约束
- 当前 turn 的 promoted 输入

这一步是“上下文工程”进入执行协议的接口面。

### 6）llm.stream + 增量事件发布
OpenCode 在这里不是“拿到一段文本就存下来”，而是：
- 把 text / reasoning / tool input 都走事件发布管线
- 增量和 durable 之间严格区分

### 7）工具结算与收尾
最后一步不是简单 await 工具，而是：
- 等待工具 fibers
- 处理各种失败语义
- 发布 Step.Ended / Step.Failed
- 保证执行状态能被 durable 重放

所以这一整套 7 步的真正价值是：

> **每一步都对应一种系统级不变量。**

---

## 五、为什么压缩在这里不是优化，而是控制流转移

这是 OpenCode 非常有代表性的一个设计点。

很多系统把压缩当成：
- 某个 helper
- 某个中间函数
- 某次超长后顺手处理一下

OpenCode 不是这样。

它把 compaction 当成一种：
> **执行控制流中的异常转移（TurnTransitionError）**

什么意思？

不是：
- 在原地把上下文压一压再接着跑

而是：
- 通过一个专门的转移错误，把执行弹回 turn 开头
- 用新的压缩后上下文，重新开始当前 turn

这很重要，因为它保证：
- 主循环本身不需要知道 compaction 的所有细节
- compaction 不会把半旧半新的 request 混着用
- overflow recovery 有明确的“一次恢复机会”边界

所以压缩在 OpenCode 里不是“小技巧”，而是：
> **执行协议的一部分。**

---

## 六、工具执行为什么要 eager，而且为什么要有一整套兜底矩阵

很多人会以为：
- 模型给出 tool call
- 系统顺手跑一下工具
- 把结果回给模型

OpenCode 在这件事上更严肃得多。

### 它的选择是：eager 执行
一旦 tool-call 事件到达：
- 立即启动对应的 tool fiber
- 并在 turn 收尾前等待所有工具 settle

这个选择背后的关键点是：

1. **模型的工具意图不能长期悬挂**
2. **工具的 running/pending 状态必须能 durable 地收口**
3. **失败也必须成为模型可见的结果，而不是静默丢失**

所以你在测试里会看到大量“失败兜底矩阵”：
- 本地工具失败
- hosted tool 失败
- permission decline
- corrected permission
- question dismiss
- provider stream fail
- interrupt while awaiting settlement

这说明：
> **OpenCode 认为，工具结算不是正常路径附带物，而是 Agent runtime 正确性的一部分。**

---

## 七、为什么“中断前先失败化 running 工具”这么重要

这也是很容易被低估的一点。

OpenCode 在 run 开始时，会先扫描：
- 上一进程遗留下来的 pending / running 工具
然后把它们 durable 地标成失败：
- `Tool execution interrupted`

这件事非常重要，因为它防止出现最危险的一类状态：

> **日志里永远挂着一个 running 工具，但实际那个进程已经死了。**

如果不先失败化这些工具：
- 重放后状态会卡死
- 后面的 tool settlement 会产生歧义
- 系统会一直背着一个“假活着”的副作用状态

所以这里的设计其实是在回答：
> **崩溃后，系统如何把“未完成的执行”转成“明确的失败事实”。**

这对 durable execution 是非常关键的。

---

## 八、max-steps 为什么不是“次数限制”，而是执行契约

OpenCode 还有一个非常容易被看浅的点：
- max-steps

如果只是从表面看，会觉得：
- 防止模型跑太久

但实际上，它的设计更像是：
> **对当前执行轮次的契约限制**

特别是：
- 最后一步禁止工具 materialize
- toolChoice 改成 none
- 追加 `MAXIMUM STEPS REACHED` 提示
- 新的 steer promoted 进来后，step 配额重置

这说明 OpenCode 不是把 steps 当“粗暴超时器”，而是：
- 在控制模型什么时候必须收束
- 什么时候允许新输入重新开启一轮执行

这和“while(true) 跑到超时”是完全不同的思想。

---

## 九、这一整套执行骨架，到底在工程上解决了什么问题？

这一章最值得学的工程点，不是某个类细节，而是这些：

### 1. 会话级工作和 turn 级 continuation 被拆开
避免把所有控制流揉成一团。

### 2. 执行阶段被显式化
每一步都对应可理解、可审计的状态变化。

### 3. 工具结算是协议，而不是副作用
这决定了 Agent 是否可信。

### 4. compaction 被纳入控制流语义
这决定了长跑是否稳定。

### 5. 崩溃恢复不是“接着跑”，而是先把旧的不确定执行变成明确失败
这决定了 durable recovery 是否真实。

所以这一章真正教你的，不只是 OpenCode 的 loop，
而是：
> **一个产品级 Agent runtime，为什么必须把执行本身工程化成协议。**

---

## 十、读者最容易学错的地方

### 误区 1：把双层循环看成代码写法偏好
不是。它在拆会话级工作和 turn 级 continuation 的语义边界。

### 误区 2：把 runTurn 看成“调一次模型”
不是。它是带阶段边界的执行协议。

### 误区 3：把 compaction 看成省 token 小功能
不是。它直接影响控制流和恢复语义。

### 误区 4：把工具失败看成普通异常
不够。工具失败必须 durable、可回显、可重放。

### 误区 5：把 max-steps 看成粗暴阈值
不是。它在塑造一轮执行什么时候必须收束。

---

## 十一、这一章最值得迁移的思想

### 1. 双层循环 = 会话级调度 + turn 级 continuation
这在所有复杂 Agent 系统里都很有价值。

### 2. 执行阶段显式化
比“大函数里一路往下跑”强太多。

### 3. compaction 作为控制流转移
这是长跑 Agent 非常值得借的设计。

### 4. 崩溃恢复先失败化悬挂工具
这是 durable execution 的关键工程习惯。

### 5. 工具结算矩阵化
系统正确性不是只考虑 happy path，而是把失败语义系统化。

---

## 十二、和上一章的依赖桥：为什么没有 EventV2 / SessionInput，这一章就会失去意义

这一章如果脱离上一章来看，很容易变成“一个复杂的 runtime loop 解析”。

但它真正的前提是：
- SessionInput 已经把输入变成 durable 收件箱
- EventV2 已经把状态变化变成可重放事件真相

所以 SessionRunner 不是凭空运转的，它只是把上两者连接起来：

- SessionInput 决定“系统接到了什么工作”
- SessionRunner 决定“工作如何被持续推进”
- EventV2 决定“推进结果如何被持久承认”

这就是为什么前一章讲“真相源”，这一章讲“执行骨架”——两者必须连起来理解。

## 十三、结构化认知风险点

### 风险 1：把双层循环看成写法偏好
- 类型：`misread`
- 为什么会错：表面上像两个 while，容易被理解成工程师个人风格。
- 正确理解：外层循环处理会话级 durable 工作，内层循环处理 turn 级 continuation 语义。
- 出错后果：后面会把 queue / steer / continue 全混成“重复跑一轮”。

### 风险 2：把 runTurn 看成一次模型调用
- 类型：`false-understanding`
- 为什么会错：很多系统就是 request → response，所以读者自然套用这个心智。
- 正确理解：runTurn 是 7 步执行协议，不是一次 fetch。
- 出错后果：会低估 location、epoch、promotion、settlement 的作用。

### 风险 3：把 compaction 看成 token 优化小功能
- 类型：`misread`
- 为什么会错：压缩表面看是在减少上下文长度。
- 正确理解：在 OpenCode 里，compaction 是控制流转移，是 turn 重新开始的边界。
- 出错后果：会完全看不懂 overflow recovery 和 resume 语义。

### 风险 4：把工具失败看成普通异常
- 类型：`debugging-blindspot`
- 为什么会错：很多程序把工具失败当局部错误处理。
- 正确理解：OpenCode 必须把工具失败 durable 化，让失败进入会话真相。
- 出错后果：会误解为什么系统要在中断/崩溃时先失败化 running 工具。

## 十四、分析边界

### 为什么这里不先展开 tool leaf 细节
因为这一章关心的是“工具如何进入执行协议并被结算”，不是某个具体工具怎么实现。

### 为什么这里不先看 MCP / ACP / server
因为这些属于控制面外化；如果执行骨架没懂，后面协议层只会被看成一堆接口文件。

### 为什么测试是主证据之一
双层循环、interrupt、压缩边界、工具失败化这些行为，很多不是从注释里看出来，而是从测试契约里确认的。这里测试是执行语义的一部分证据，不是附录。

## 十五、读者分层路由

### beginner
- 先抓住：
  1. 外层是“还有没有新工作”
  2. 内层是“当前这一轮要不要继续”
- 不要一开始就陷进每个工具事件细节。

### intermediate
- 重点看 runTurn 7 步和 compaction 的异常转移。
- 这一层开始要把它和 EventV2 durable 事件理解成一个系统。

### advanced
- 应重点看：
  - 工具结算矩阵
  - failInterruptedTools
  - max-steps 契约
  - provider turn 与 durable state 的耦合方式
- 这些是后面迁移到其他 Agent runtime 最值钱的部分。

## 十六、迁移清单

### 可迁移思想 1：双层循环拆开会话级工作与 turn 级 continuation
- 可迁移到：任何多轮工具调用 Agent runtime
- 前提：系统区分 durable 新输入和当前 turn 续跑
- 不能照搬的点：纯一次性问答系统不需要这么重

### 可迁移思想 2：执行阶段显式化
- 可迁移到：需要调试、恢复、审计的 Agent 系统
- 前提：阶段边界要能映射到事件 / 状态变化
- 不能照搬的点：如果没有持久状态，阶段过多会带来不必要复杂度

### 可迁移思想 3：compaction 作为控制流转移
- 可迁移到：长跑、上下文紧张、需要 resume 的系统
- 前提：上下文变化必须重新构造 request
- 不能照搬的点：没有长跑语义的系统不用把 compaction 升格到这么高

### 可迁移思想 4：崩溃恢复先失败化 running 工具
- 可迁移到：工具执行可能跨进程中断的系统
- 前提：工具状态需要 durable 化
- 不能照搬的点：完全同步、无恢复的 toy system 不需要这套护栏

## 十七、关键源码位置

- `packages/core/src/session/runner/llm.ts`
  - 双层循环、runTurn 7 步、工具失败化、max-steps
- `packages/core/src/session/runner/publish-llm-event.ts`
  - text/reasoning/tool input/tool result 的事件发布管线
- `packages/core/src/session/execution.ts`
  - 会话执行桥面
- `packages/core/src/session/run-coordinator.ts`
  - wake / interrupt / drain 协调
- `packages/core/test/session-runner.test.ts`
  - 长跑、steer、continue、compaction、工具结算的核心契约
- `packages/core/test/session-runner-tool-events.test.ts`
  - 工具事件流完整性
- `packages/core/test/session-runner-message.test.ts`
  - 消息投影边界

## 十八、工程问题学习点

### 工程问题 1：如何把 Agent 执行变成“可恢复会话”而不是“内存循环”
- OpenCode 的解法：双层循环 + durable inbox + event projection
- 代价：状态机更复杂，调试成本更高
- 可迁移性：适合任何需要 continue / resume 的 Agent runtime

### 工程问题 2：如何把压缩纳入执行语义，而不是外围优化
- OpenCode 的解法：TurnTransitionError 驱动的控制流转移
- 代价：turn 语义和异常语义耦合更紧
- 可迁移性：适合长跑和上下文预算紧张的系统

### 工程问题 3：如何处理工具执行失败和中断后的收口
- OpenCode 的解法：eager tool run + settlement matrix + failInterruptedTools
- 代价：执行协议比普通工具调用复杂很多
- 可迁移性：适合任何会跨进程中断的工具执行系统

## 十九、自测问题

1. 为什么 OpenCode 要区分会话级工作和 turn 级 continuation？
2. 为什么 compaction 会被设计成控制流转移？
3. 为什么工具失败必须 durable 化，而不是只打印错误？
4. 为什么崩溃恢复时要先失败化 running/pending 工具？
5. 没有上一章的 EventV2 / SessionInput，这一章为什么就站不住？

## 二十、这一章读完，读者应该获得什么能力？

至少应该能做到：

1. 解释为什么 OpenCode 的执行骨架需要双层循环。
2. 说清一次 runTurn 不是一次模型调用，而是严格分阶段的执行协议。
3. 理解 compaction 为什么被纳入控制流本身。
4. 理解工具失败为什么必须 durable 化。
5. 理解崩溃恢复为什么要先处理旧 running/pending 工具。
6. 说明这一章如何依赖前一章的 EventV2 / SessionInput，才能成立一个真正可恢复的会话系统。

如果还做不到这些，就说明这章还没真正学懂。
