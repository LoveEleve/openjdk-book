# TurnRunner 与 GatewayRunner：Hermes 如何把多会话与多平台运行收进同一执行系统

> 项目：Hermes（main 基线）
> 角色：主线机制正文 02
> 对应范围规划：`01-Hermes源码学习范围规划.md`
> 依据材料：
> - `Agent/analysis/hermes-agent/00-域发现/00-hermes-域发现.md`
> - `Agent/analysis/hermes-agent/01-闭环笔记/pass2-hq21-stream-dispatch.md`
> - `Agent/analysis/hermes-agent/01-闭环笔记/pass2-hq8-turn-lease.md`
> - `Agent/analysis/hermes-agent/01-闭环笔记/pass2-hq20-session-stall.md`
> - `Agent/analysis/hermes-agent/01-闭环笔记/pass2-hq9-delivery-ledger.md`

---

## 零、阅读前提示

- 建议先读：
  1. `02-AIAgent主循环：Hermes 如何组织 turn、工具批与长期运行.md`
  2. `../03-Agent源码前置认知桥.md`
- 推荐源码阅读路径：
  1. `gateway/run.py`
  2. `gateway/turn_lease.py`
  3. `gateway/stream_dispatch.py`
  4. `gateway/session.py`
  5. `gateway/delivery_ledger.py`
  6. `gateway/session_stall.py`

## 一、这一章真正的问题

上一章已经说明 Hermes 的 AIAgent 主循环本身很重，但那还只是：
- 单个 agent 在运行时怎么推进

还没有回答另一个更难的问题：

> **当这个 agent 被放进网关、多会话、多平台、多渠道、多路输入输出里时，它如何仍然维持同一套执行语义。**

这一章真正要回答的是：

1. TurnRunner / GatewayRunner 在 Hermes 里扮演什么角色？
2. 为什么 Hermes 的网关不是简单的“把消息转给 agent”？
3. 为什么 session slot、turn lease、stream dispatch、delivery ledger、session stall 这些东西都必须进入同一主线？

---

## 二、先给结论：GatewayRunner 不是外壳，而是 Hermes 在多平台环境下的执行控制面

最容易犯的错，是把 Hermes 的网关理解成：
- 不过是消息入口
- 把平台消息转给 AIAgent
- 再把结果发回去

这完全看浅了。

更准确的理解是：

> **GatewayRunner 是 Hermes 在多平台、多会话、多交付约束环境下的执行控制面。**

它不只是路由消息，而是在同时处理：
- 会话槽位
- turn lease
- 交付账本
- 会话停滞通知
- stream dispatch
- gateway 授权
- 平台能力适配

所以这一章不能被理解成“平台外壳细节”，而是：
> **Hermes 如何把单个 agent 的执行骨架抬升成多会话运行系统。**

---

## 三、为什么 TurnRunner 值得单独抬出来

既有域发现里已经把 `TurnRunner` 从 `gateway/run.py` 的闭包逻辑里提成了独立协作器。

这说明 Hermes 已经意识到一个问题：
- 如果所有“回合内逻辑”都塞在 GatewayRunner 里
- 网关代码会迅速变成不可维护的巨型总控

TurnRunner 的价值是：
- 把工具进度回调、live status 行、log 队列、首次长工具提示这些“单回合内协作”抽出来
- 让 GatewayRunner 关注：
  - 多 session 治理
  - 生命周期
  - 交付
  - 唤醒/排空/恢复

所以 TurnRunner 的意义不是“重构得更好看”，而是：
> **把回合内协作和网关级控制分层。**

---

## 四、为什么 turn lease 是主线，而不是锁工具

Hermes 的 `turn_lease.py` 非常值得重视，因为它在解决一个大问题：

> **同一个 session 在多 routing key / 多平台输入下，如何保证同一时刻只有一轮真正的 turn 在推进。**

这不是普通锁，因为它关注的不是：
- 某个函数能不能进

而是：
- 一个 session 当前是否已经被某个 turn 占有
- 迟到结果是否还能提交
- generation / identity release 是否匹配

也就是说，Turn Lease 是：
> **会话级执行独占边界。**

没有它，多平台 / 多入口环境下就很容易出现：
- 同一 session 被两轮同时推进
- 历史、记忆、交付、审查全部失真

---

## 五、为什么 GatewayRunner 不是“多会话 for-loop”

Hermes 的网关执行系统真正的难点不在消息多少，而在：

> **多会话并发治理**

它要同时回答：
- 有多少 active session 槽位
- 某个 session 现在是不是还能再进一轮
- fallback 链是否还有效
- 旧 agent 缓存快照还能不能复用
- drain / scale-to-zero / wake 的边界是什么

这意味着 Hermes 的网关层，不是“消息分发层”，而是：
> **会话资源调度层。**

这和 OpenCode 的 SessionRunner / Reasonix 的 Controller 不一样——
Hermes 的难点更偏向：
- 多会话
- 多平台
- 多账本
- 长期运行治理

---

## 六、为什么 stream_dispatch 是一个很值钱的缝

`stream_dispatch.py` 的设计很成熟：
- agent 发 typed event
- adapter 决定怎么交付
- 某些事件 adapter 可以直接吃掉
- 路由器自身不带平台知识

这说明 Hermes 在这里做的不是“事件发出去”，而是：

> **把 agent 内部事件流和平台展示行为之间，用一个薄而统一的协议层隔开。**

这非常值钱，因为多平台系统最容易死在：
- 每个平台适配器都自己解释 agent 事件
- 最后行为越来越不一致

Hermes 的 stream_dispatch 在努力避免这点。

---

## 七、为什么 delivery ledger 也必须进主线

很多系统把“回复发出去”视为理所当然。

Hermes 更谨慎，它用 `delivery_ledger.py` 去记录：
- pending
- attempting
- delivered
- failed
- recovered-reply

这说明它在解决的是：

> **最终响应从生成到真正被交付，中间每一步都必须可解释。**

特别是：
- 崩溃恢复后
- 平台发送失败后
- 需要 at-least-once 语义时

delivery ledger 就不再是审计附件，而是：
> **运行系统对“结果真的送达了吗”这一问题的正式回答。**

---

## 八、为什么 session stall 值得进主线

`session_stall.py` 不是一个小监控工具。

它在做的是：
- 识别某个 session 是否长期没有新进展
- 结合共享活动观察契约
- 决定要不要发停滞通知

这说明 Hermes 已经在显式处理：
> **长时间运行时，系统有没有在悄悄僵住。**

这和我们前面在 Reasonix 里看到的：
- stale_count / pivot_count
是同一个问题域，只是 Hermes 的做法更偏运行时观测和通知。

---

## 九、这一章真正解决了哪些工程问题？

### 1. 如何把单个 agent 的执行骨架放进多平台、多会话运行系统里
Hermes 的解法：GatewayRunner + TurnRunner 分层

### 2. 如何保证同一 session 在多入口下不会并发乱跑
Hermes 的解法：Turn Lease

### 3. 如何让平台适配器不重写 agent 执行语义
Hermes 的解法：stream_dispatch + BasePlatformAdapter

### 4. 如何把“回复是否真正送达”纳入 durable 语义
Hermes 的解法：delivery ledger

### 5. 如何识别长跑 session 是否僵住
Hermes 的解法：session stall 检测

所以这一章真正要学的，不是“网关代码怎么写”，而是：

> **Hermes 如何把单个 agent 的执行循环，提升成多会话、多平台、多交付约束下的运行控制系统。**

---

## 十、读者最容易学错的地方

### 错觉 1：GatewayRunner 只是消息路由层
错。它是多会话运行控制面。

### 错觉 2：TurnRunner 只是抽出来的 helper
错。它在分离回合内协作和网关级控制语义。

### 错觉 3：turn lease 就是锁
错。它在保护同一 session 的执行独占语义。

### 错觉 4：stream_dispatch 只是事件转发
错。它在定义 agent 事件与平台适配器之间的协议缝。

### 错觉 5：delivery ledger 只是审计
错。它在定义“交付完成”是否真的成立。

---

## 十一、分析边界

### 为什么这里不先展开具体 20+ 平台适配器
因为第一轮要先站稳“统一适配抽象”和“多会话治理”，不是平台实例平铺扫描。

### 为什么这里不先看 UI 细节
因为这章关心的是执行控制，不是视觉呈现。

### 为什么账本和网关要一起讲
因为在 Hermes 里，delivery / lifecycle / stall 都不是外围监控，而是网关运行语义的一部分。

---

## 十二、读者分层路由

### beginner
先抓住：
1. GatewayRunner 不是路由器，而是多会话控制面
2. turn lease 不只是锁
3. delivery ledger 不只是审计表

### intermediate
重点看：
- TurnRunner / GatewayRunner 分工
- turn lease
- stream dispatch
- delivery ledger
- session stall

### advanced
重点看：
- 多平台适配下为什么还必须维持同一执行语义
- turn lease 和 generation/identity 的运行约束
- 为什么“交付语义”值得单独 durable 化

---

## 十三、迁移清单

### 可迁移思想 1：网关层也要有自己的执行控制面
- 可迁移到：任何多平台 / 多入口 Agent 系统
- 前提：存在多 session、多渠道、多并发输入
- 不适合直接照搬到：单一 CLI Agent

### 可迁移思想 2：session 级 turn lease
- 可迁移到：同一会话可能被多个入口并发触达的系统
- 前提：session 是共享状态容器
- 不适合直接照搬到：单线程单入口本地工具

### 可迁移思想 3：stream dispatch 作为平台协议缝
- 可迁移到：平台多样、事件形态统一的系统
- 前提：agent 内部事件是 typed / structured 的
- 不适合直接照搬到：无事件流输出的简单系统

### 可迁移思想 4：交付账本 durable 化
- 可迁移到：需要 at-least-once 回复、恢复回复或外部平台发送保障的系统
- 前提：结果交付本身是业务语义的一部分
- 不适合直接照搬到：无外部发送、无持久交付约束的系统

---

## 十四、自测问题

1. 为什么 GatewayRunner 不能被理解成简单的消息入口？
2. 为什么 TurnRunner 需要从 gateway/run.py 闭包里抬成协作器？
3. 为什么 turn lease 保护的是 session 级执行独占，而不是简单并发锁？
4. 为什么 stream_dispatch 对多平台一致性这么关键？
5. 为什么 delivery ledger 和 session stall 都属于运行控制面，而不只是审计/监控工具？

---

## 十五、读完这一章，读者应该获得什么能力？

至少应该能做到：

1. 解释 Hermes 为什么要把网关层做成多会话运行控制系统。
2. 说清 TurnRunner、GatewayRunner、Turn Lease、stream dispatch 各自扮演什么角色。
3. 理解为什么交付和停滞检测在 Hermes 里属于主运行语义，而不只是运维边缘。
4. 理解多平台适配为什么必须建立在统一执行语义之上。
5. 用自己的话说明：Hermes 为什么比很多 Agent 项目更接近“平台级长期代理系统”。

如果还做不到这些，就说明这章还没真正学懂。
