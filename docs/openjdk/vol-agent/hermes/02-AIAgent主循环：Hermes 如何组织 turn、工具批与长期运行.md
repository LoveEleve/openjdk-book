# AIAgent 主循环：Hermes 如何组织 turn、工具批与长期运行

> 项目：Hermes（main 基线）
> 角色：主线机制正文 01
> 对应范围规划：`01-Hermes源码学习范围规划.md`
> 依据材料：`Agent/analysis/hermes-agent/01-闭环笔记/pass2-hq5-agent-loop.md`

---

## 零、阅读前提示

- 如果你对 Agent loop / fallback / guardrail / tool batch 这些概念完全没感觉，先读：`../03-Agent源码前置认知桥.md`
- 如果你还没看 Hermes 范围规划，先读：`01-Hermes源码学习范围规划.md`
- 推荐源码阅读路径：
  1. `run_agent.py`
  2. `agent/conversation_loop.py`
  3. `model_tools.py`
  4. `agent/tool_executor.py`
  5. `agent/iteration_budget.py`
  6. `agent/turn_finalizer.py`

## 一、这一章真正的问题

Hermes 最容易给人的第一印象是：
- 一个超级大的主循环
- 一个工具执行器
- 一堆 fallback / retry / gate

但如果只停在“主循环很大”，就会完全看不懂它最值钱的设计判断。

这一章真正要回答的问题是：

> **Hermes 如何把 AIAgent 做成一个能够长期运行、能在失败中转向、能并发执行工具、能保持交付和审查边界的代理系统。**

换句话说，这一章不是在讲“一个 while 循环怎么写”，而是在讲：

1. Hermes 的 turn 语义为什么比普通聊天循环重得多？
2. 为什么预算、中断、steer、redirect、工具批、fallback 链都必须进入同一条执行骨架？
3. 为什么它的主循环看起来像 god-file，但又能通过 TurnFinalizer / ToolExecutor / stream_dispatch 等 seams 被逐步分解？

---

## 二、先给结论：Hermes 的 AIAgent 不是聊天循环，而是“被预算、纠偏、工具批和回合收尾协议共同约束的长期代理骨架”

最容易犯的错，是把 Hermes 的主循环理解成：
- 调模型
- 处理工具
- 结束

这太浅了。

更准确的理解应该是：

> **Hermes 的主循环是一条长期运行主线，它同时承受预算控制、运行中纠偏、工具并发、provider fallback、后台审查与回合收尾契约。**

所以它最值得学的，不是“代码多”，而是：
- 它把哪些东西都强行纳入了同一条执行协议里

---

## 三、为什么 iteration budget 不只是计数器

Hermes 的 `iteration_budget` 不是简单的“最多跑几轮”。

它有几个非常关键的语义：
- `consume` / `refund`
- parent / child 预算独立
- `grace call`

这说明它在解决的是：

### 1. 预算不是静态上限，而是执行控制的一部分
例如：
- 某些动作会消耗预算
- 某些动作（如编程式工具调用）可以退款

### 2. 子代理预算和父代理预算并不完全绑定
也就是说，系统已经承认：
- delegation 不只是子过程
- 它是一个相对独立的预算域

### 3. grace call 体现了“收尾权”
预算耗尽时，不是立刻掐死，而是允许最后一次收尾。

这非常值钱，因为它说明 Hermes 的预算控制不是：
- 粗暴 stop

而是：
> **在边界内给系统一次优雅收尾机会。**

---

## 四、为什么每个工具前都要做中断检查

Hermes 一个很成熟的地方是：
- 中断不是只在 loop 边界检查
- 而是在**每个工具执行前都检查**

这意味着：
- 已经开始跑的工具和还没开始跑的工具会被区别处理
- 被跳过的工具不会静默消失，而是要写取消占位结果

这一点非常重要，因为它在解决：

> **模型和用户必须知道“哪些工具没跑”，而不是只知道“系统被中断了”。**

如果没有取消占位：
- 模型会误以为所有工具都执行完了
- 会在错误前提上继续推理

所以这里最值钱的不是“支持中断”，而是：
> **中断语义对模型透明。**

---

## 五、为什么工具批三模式值得单独拿出来学

Hermes 的工具执行不是一刀切，而是至少有三种模式：
- concurrent
- sequential
- segmented

这说明它在解决的是：

> **不同工具批，不应该被同一种执行策略强行处理。**

### concurrent
- 并行跑，提高吞吐
- 但最终结果仍按原始顺序回注

### sequential
- 对有顺序要求或交互性更强的工具，逐个执行

### segmented
- 一批执行完后，最终收尾延后到 turn-end
- 更像一种“阶段性工具流水线”

所以 Hermes 在这里的设计重点不是“并发”，而是：
> **工具批执行策略也是运行协议的一部分。**

---

## 六、为什么 fallback 链不是“换个 provider 再试一次”

Hermes 的 provider fallback 非常值得学，因为它不是简单重试。

在 fallback 过程中，它会重新做：
- reasoning echo 补回
- prompt cache 断点重装饰
- 载荷 sanitize
- 响应形状验证

这说明 Hermes 已经意识到：

> **provider 切换不是只换 endpoint，而是整条调用链的语义环境都要重建。**

这点太重要了，因为如果把 fallback 理解成：
- 请求失败 → 换个模型再调

那你会漏掉真正值钱的东西：
- provider 差异不仅在 URL
- 还在 caching / reasoning / payload / output shape

所以 Hermes 的 fallback 更像：
> **重装饰后的 provider 重新进入执行链。**

---

## 七、为什么 `/steer` 和 redirect 值得单独拎出来

Hermes 在“运行中纠偏”这件事上做得很重。

### `/steer`
- 在当前 API 调用前 drain
- 注入最后 tool 消息而不是 user 消息
- 没有合适位置时会重新排队

### redirect
- 会修正当前运行中的输入
- 还要检测和已返回响应之间的竞争
- stale 响应会被丢弃，重新按修正后输入重建

这说明 Hermes 在解决的不是“给用户一个打断入口”，而是：

> **当系统已经在跑，用户临时改方向时，如何不让旧响应和新方向互相污染。**

这是一种非常成熟的“运行中纠偏”设计。

---

## 八、为什么回合收尾协议是 Hermes 的关键主线之一

Hermes 的回合收尾顺序不是随意的，而是有明确契约：
1. 持久化消息
2. 外部记忆同步
3. 背景 review 取消
4. 压缩状态重置

这说明什么？

> **一个回合结束，不只是模型停下来，而是系统要把一整套后处理、知识沉淀、后台审查和状态重置一起做完。**

也就是说，`turn finalization` 在 Hermes 里不是尾巴，而是：
- 运行正确性的最后一环
- 也是下一个 turn 的前置条件

这就是为什么 `TurnFinalizer` 值得从 god-file 里拆出来。

---

## 九、为什么错误分类学是运行骨架的一部分

`error_classifier.py` 这类文件很容易被看成 util。

但 Hermes 在这里做得很系统：
- 23 类 FailoverReason
- 每类错误都映射到恢复策略
- auth / billing / rate_limit / context_overflow / payload_too_large / ssl / content policy 等都有明确归类

这意味着：

> **失败不是 catch 一下，而是运行骨架的控制输入。**

这非常重要，因为它让：
- fallback
- retry
- compaction
- abort
- fail fast
都不再是拍脑袋，而是受错误分类学约束。

---

## 十、这一章真正解决了哪些工程问题？

### 1. 如何让 Agent 长时间持续运行而不是只完成一轮对话
Hermes 的解法：AIAgent 主循环 + budget + grace call + steer/redirect

### 2. 如何让工具执行既高效又有边界
Hermes 的解法：工具批三模式 + 每工具中断检查 + 顺序回注

### 3. 如何让 provider fallback 不破坏运行语义
Hermes 的解法：reasoning 回声垫 + 缓存断点重渲染 + 载荷 sanitize + 响应形状验证

### 4. 如何让回合结束成为系统级状态转换，而不是简单返回结果
Hermes 的解法：持久化 → 记忆 → 后台取消 → 压缩状态重置 的收尾契约

### 5. 如何把失败变成可被系统处理的输入
Hermes 的解法：23 类错误分类学 → 恢复策略映射

所以这一章真正要学的，不是“主循环好大”，而是：

> **Hermes 如何把预算、中断、纠偏、工具批、fallback、错误分类和回合收尾编织成一个长期代理系统的执行骨架。**

---

## 十一、读者最容易学错的地方

### 错觉 1：Hermes 的 loop 只是功能很多
错。它是在统一多种运行时约束，而不是堆 if/else。

### 错觉 2：budget 就是上限计数器
错。grace call / refund / delegation 让它变成了执行控制的一部分。

### 错觉 3：fallback 只是换 provider
错。它会重建一整条调用链的上下文和协议细节。

### 错觉 4：中断就是停下来
错。Hermes 还要让哪些工具没跑对模型可见。

### 错觉 5：TurnFinalizer 只是重构出来的小模块
错。它揭示的是完整的回合收尾契约。

---

## 十二、分析边界

### 为什么这里不先展开 GatewayRunner 的全部平台细节
因为第一轮先要站稳 AIAgent 主循环本体，再去看多平台网关如何承接它。

### 为什么这里不先深入 memory / skills / approval 的实现细节
因为这一章先讲执行骨架，其他系统先作为挂在骨架上的控制成员去理解。

### 为什么测试和契约说明仍然是关键证据
budget / interrupt / fallback / recovery / tool batch 这些行为很多都不能只看函数签名，必须看契约和测试说明。

---

## 十三、读者分层路由

### beginner
先抓住：
1. Hermes 的 loop 不是聊天循环，而是长期代理骨架
2. budget、steer、tool batch、fallback 都是主流程的一部分
3. turn 结束不是返回文本，而是系统收尾契约

### intermediate
重点看：
- iteration budget
- tool batch 三模式
- steer / redirect
- fallback 重装饰
- turn finalization

### advanced
重点看：
- 23 类错误分类学如何进入恢复链
- 为什么每工具中断检查比 turn 级中断更成熟
- fallback 为什么必须重建 reasoning / cache / payload 语义
- Hermes 的执行骨架和 OpenCode / Pi / Reasonix 有什么差异

---

## 十四、迁移清单

### 可迁移思想 1：预算不是计数器，而是执行控制语义
- 可迁移到：长跑、多工具、多子代理 Agent
- 前提：系统允许持续多轮运行
- 不适合直接照搬到：一次性问答型 Agent

### 可迁移思想 2：每工具中断检查 + 取消占位结果
- 可迁移到：工具批执行系统
- 前提：中断后模型仍要知道哪些工具没跑
- 不适合直接照搬到：无工具或无中断语义系统

### 可迁移思想 3：fallback 重装饰
- 可迁移到：多 provider / 多模型切换系统
- 前提：provider 差异会影响 prompt cache / reasoning / payload 语义
- 不适合直接照搬到：单 provider 固定环境

### 可迁移思想 4：回合收尾协议化
- 可迁移到：回合结束后要做持久化、知识沉淀、后台审查、状态重置的系统
- 前提：系统不是一轮结束就彻底终止
- 不适合直接照搬到：极短生命周期、无后处理的系统

---

## 十五、自测问题

1. 为什么 Hermes 的 AIAgent 主循环不该被理解成大号聊天 while 循环？
2. 为什么 iteration budget、grace call 和 delegation 让预算变成了执行控制语义？
3. 为什么工具批要分 concurrent / sequential / segmented 三种模式？
4. 为什么 fallback 在 Hermes 里不是“换个 provider 再试一次”这么简单？
5. 为什么 TurnFinalizer 能暴露出 Hermes 的完整收尾契约？

---

## 十六、读完这一章，读者应该获得什么能力？

至少应该能做到：

1. 解释 Hermes 的主循环为什么更像长期代理系统，而不是普通对话循环。
2. 说清 budget、中断、纠偏、工具批和 fallback 分别在骨架里扮演什么角色。
3. 理解为什么错误分类学会直接影响恢复策略。
4. 理解为什么回合结束本身也是系统级状态转换。
5. 用自己的话说明：Hermes 为什么把执行骨架做得比很多 Agent 项目都更重、更全、更接近运行时控制系统。

如果还做不到这些，就说明这章还没真正学懂。
