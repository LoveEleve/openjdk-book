# 03 Feign Timeout：为什么“下游不可达”在这套系统里不是一次 503，而是一整条收敛链被迫接管

在运行时故障这一组里，端口冲突复盘的是“服务根本没以正确姿势活起来”，死信复盘的是“消息已经进了异步链，但语义收不下来”。到了 Feign 超时这一篇，要处理的则是另一类处在同步与异步夹缝中的经典问题：**本次请求已经走进了主链，并且明确需要依赖下游服务，但下游就是没在预期时间里给出一个可接受的结果。**

很多团队第一次看到 Feign timeout，直觉都会把它理解成一个相对简单的故障：调用慢了、超时了、FallbackFactory 生效、上游返回 503 或重试一下。这个理解在单个接口层面当然没错，但在 `my-xhs` 里远远不够。因为这里的 Feign 超时，从来不是一条孤立的 HTTP 调用慢了几秒，而是会沿着整条业务链往后扩散：有的调用超时会直接导致用户请求失败，有的调用超时会转进补偿 Topic，有的调用超时会触发支付 / 退款通知补偿任务，有的调用超时如果被错误地包装成业务空结果，甚至还会把“依赖不可达”伪装成“对象不存在”或“空购物车”。也就是说，**Feign timeout 在这里最危险的地方，不是耗时数字本身，而是它会强迫系统决定：这次失败是要同步暴露给上游、异步继续收口，还是被错误地吞掉。**

这也是为什么本篇不能只讲超时时间配了多少毫秒、fallback 返回了什么，而必须把超时放进业务语义里去看：order 对 inventory / coupon / payment 的调用为什么有些可以补偿、有些必须 fail-fast；payment 对 order 的通知为什么超时后不能静默成功，而要由补偿任务接管；home 这种聚合层如果把 Feign 失败误写成“业务空结果”，为什么会比直接 503 更危险。只有把这些因果链讲清，Feign timeout 才不会被写成“框架层小故障”。

## 先给结论：`my-xhs` 的 Feign 超时不是一次网络抖动，而是同步主链与补偿系统之间的分流点

先别急着看 `read-timeout` 数字，先把本篇最重要的人话结论钉住：`my-xhs` 里的 Feign 超时，真正重要的不是“超时了”，而是**超时以后系统如何分流：是立即让用户看到失败，是让补偿系统接管，还是错误地把依赖问题伪装成业务结果。**

这条结论在项目里至少有三层含义。

第一，Feign 调用不是都一样。有的调用发生在订单创建主链里，超时意味着这次订单动作本身就不应该继续向前；有的调用发生在支付 / 退款结果通知里，超时不代表支付事实失效，而是通知链需要交给补偿任务继续收口；还有一些调用发生在 BFF 聚合里，错误处理策略如果选错，就会把系统级依赖问题伪装成用户级业务语义。第二，超时之后的 fallback 并不是统一返回空对象或 `R.ok()`。在 `my-xhs` 里，支付侧 `OrderFeignFallbackFactory` 明确要求所有关键路径都返回失败，让补偿任务接管；订单侧对库存 / 优惠券的 fallback 也不会假装成功，而是显式返回 503。第三，Feign 超时的恢复从来不只靠 Feign 自己。超时只是同步主链的断点，真正的收敛往往由 MQ、XXL-Job、补偿消息、定时扫描、乐观锁去完成。

如果忘掉这三层差别，你就会在后面的很多设计上产生误判。你会把 503 当成一次普通短失败，而忽略它其实是“切换到异步恢复链”的分流信号；你会觉得 fallback 返回空数据更用户友好，却没有意识到它可能是在伪造业务结果；你也会低估超时配置和 fallback 语义之间的耦合关系。

## 直觉方案为什么不够：不是所有超时都该自动重试，也不是所有 fallback 都该返回空结果

### 失败方案一：下游超时就自动重试一次或直接吞掉

这是最常见的直觉。既然调用超时，先再试一遍，或者 fallback 里返回一个默认值，让主链先走下去。这样看起来最平滑。

问题在于，`my-xhs` 里很多 Feign 调用不是“附加信息查询”，而是交易主链或结果通知的一部分。比如订单对库存服务的调用如果超时，你并不能乐观地认为“也许库存其实已经够了”；订单对优惠券核销如果超时，也不能默认“先创建订单，稍后再说”。因为这些调用本身就是当前订单能否成立的一部分约束。`InventoryFeignFallbackFactory` 和 `CouponFeignFallbackFactory` 的实现也非常明确：都直接返回 `R.fail(503, ...)`，而不是构造一个假成功。`my-xhs-order/src/main/java/com/myxhs/order/feign/InventoryFeignFallbackFactory.java:11` `my-xhs-order/src/main/java/com/myxhs/order/feign/CouponFeignFallbackFactory.java:12`

也就是说，在这类同步强约束路径上，“超时后继续往前”不是降级，而是在主动制造不一致风险。

### 失败方案二：Fallback 最好总返回空对象 / 空列表，避免用户看到 503

这类策略在聚合层尤其常见：用户看到空购物车、空详情、空列表，总比看到 503 友好一点吧？

但 `my-xhs` 的历史 review 已经证明，这种思路恰恰可能把“依赖不可达”伪装成“业务对象不存在”或“确实没有数据”，从而让排障和业务判断一起走偏。review 中对 `home` BFF 的问题总结得非常直接：主源依赖的 Feign fallback 返回 `R.ok(empty)`，聚合层继续映射为 404、空购物车或空流，结果系统级依赖故障被包装成了业务语义。`docs/review-1/02-findings/FINAL-VERIFIED-MAIN-BUGS.md:66`

这说明在 `my-xhs` 里，Feign timeout 处理的关键不只是“有没有 fallback”，而是 fallback 返回值是否保持了**故障语义的真实度**。有时候直接 503 比“看起来业务正常但其实是依赖断了”要诚实得多，也安全得多。

### 失败方案三：只要补偿任务会兜底，同步路径里 Feign 返回什么都无所谓

这是另一种很危险的误解。因为 `my-xhs` 里确实有很多补偿任务：支付成功通知补偿、退款通知补偿、本地消息补发、订单补偿 Topic、索引增量补偿……于是很容易让人产生一种错觉：既然后面总能补，前面同步 Feign 超时也不用太严谨，先返回成功或空数据，后面收口就行。

这在支付 / 退款通知链路上尤其致命。`OrderFeignFallbackFactory` 的注释已经把设计原则说得很清楚：支付和订单是强一致场景，所有降级方法都必须返回失败 `R.fail`，而不能静默成功。原因非常直接——如果返回成功，调用方就会以为订单侧已经更新完成，从而**不会触发补偿任务**，真正的一致性缺口反而被永远藏住了。`my-xhs-payment/src/main/java/com/myxhs/payment/feign/OrderFeignFallbackFactory.java:12`

所以在 `my-xhs` 里，补偿任务不是给你放松同步错误处理纪律用的；恰恰相反，只有同步路径在失败时老老实实暴露失败，补偿系统才知道应该接管。

## 先画总图：Feign timeout 在 `my-xhs` 里会往哪几条恢复路径分流

先把这条分流图立住：

```text
同步 Feign 调用
  -> 正常返回
       业务继续推进
  -> timeout / service unavailable / fallback
       分为三类：

1. 主链强约束调用
   - order -> inventory / coupon / product(user/address)
   - fallback 返回失败
   - 本次请求直接失败 / 回滚 / 取消订单

2. 结果通知调用
   - payment -> order notifyPaySuccess / notifyRefundSuccess
   - fallback 返回失败
   - 由 paymentNotifyCompensateJob / refundNotifyCompensateJob 接管

3. 聚合读取调用
   - home / BFF -> product/user/cart/content...
   - 若错误吞掉 -> 伪装成业务空结果
   - 正确做法应保留故障语义或明确降级边界
```

这张图里最关键的，不是调用关系本身，而是：**超时后的恢复动作是按业务语义分层的。**

- 强约束路径的超时要尽早暴露，不该装作成功。
- 通知型路径的超时要显式失败，让补偿系统接力。
- 聚合型路径如果要降级，也必须明确这是“降级展示”而不是“业务真相”。

只有这样，Feign timeout 才不是一条 HTTP 层小故障，而是一条同步主链如何把失败移交给下一层系统的分流点。

## order 这一侧：为什么超时会直接影响订单是否应该继续创建或继续推进

### 超时配置本身已经在表达“这是同步强约束调用”

`my-xhs-order` 的 Feign 默认配置非常克制：`connect-timeout=3000`，`read-timeout=5000`。这不是一个为了极限性能而设置的激进阈值，而是一个很典型的“我愿意给下游几秒钟，但不会无限等你”的业务时限。`my-xhs-order/src/main/resources/application.yml:100`

更重要的是，订单服务对这些下游的调用并不是等价的。比如：

- 拉商品详情、地址快照这种前置信息失败，下单就没有足够事实继续
- 库存查询失败，不能继续乐观地下单
- 优惠券核销失败，要取消当前订单，不能把资损留给后面

从这个角度看，order 侧的 Feign timeout 不是“慢了几秒”，而是主链在同步阶段就必须做出的一次严格判断：**这笔订单还应不应该继续往后走。**

### fallback 返回 503，本身就是一种业务决策

`InventoryFeignFallbackFactory` 和 `CouponFeignFallbackFactory` 都没有选择返回空数据或伪成功，而是统一 `R.fail(503, "...服务不可用")`。这说明 fallback 在这里不是“兜住错误让主链继续”，而是在同步主链里明确制造一个“必须停”的决策点。`my-xhs-order/src/main/java/com/myxhs/order/feign/InventoryFeignFallbackFactory.java:21` `my-xhs-order/src/main/java/com/myxhs/order/feign/CouponFeignFallbackFactory.java:20`

这个设计其实非常重要，因为它背后表达的是：在订单域里，超时不是一个可以悄悄吞掉的技术细节，而是业务约束暂时不能成立的明确事实。与其让用户看到一个“看似下单成功，但后面可能库存 / 券 / 支付都不一致”的结果，不如直接在同步主链里停住。

## payment 这一侧：为什么 timeout 本身就应该触发补偿，而不能静默成功

支付域对 Feign timeout 的态度，与订单域又不完全一样。支付成功 / 退款成功这类事实，在支付服务本地往往已经成立；问题在于订单域还没被及时通知到。因此这里的超时不是“本次支付要不要继续”，而是“结果通知有没有被订单域接住”。

`OrderFeignFallbackFactory` 正好把这种差异写得非常清楚：

- `notifyPaySuccess` 降级返回失败，触发支付侧补偿任务
- `notifyRefundSuccess` 降级返回失败，触发退款补偿任务
- `notifyRefundFail` 失败时标注需人工处理
- `getOrderPayAmount` / `getOrderStatus` 失败时直接拒绝支付或后续推进

`my-xhs-payment/src/main/java/com/myxhs/payment/feign/OrderFeignFallbackFactory.java:14`

这里最重要的一点不是 `R.fail` 这个返回值，而是它与补偿任务之间的契约：**必须失败，调用方才知道要把这件事交给下一层恢复系统。** 如果这里静默返回成功，`PaymentNotifyCompensateJob` 和 `RefundNotifyCompensateJob` 就不会再有机会接管，订单域可能永久停在旧状态。

所以在支付链里，timeout 的关键不是“调用慢了”，而是“通知语义是否被明确地传导成未完成状态”。

这里还值得再补一个跨案例判断：**Feign timeout 最危险的地方，经常不是超时本身，而是返回语义把失败解释错了。**

- 如果 fallback 返回 `R.ok()`，调用方会以为后半段已经完成，补偿链失明；
- 如果 fallback 返回空对象或空列表，BFF 可能把依赖故障伪装成“业务不存在”；
- 如果 fallback 正确返回 `R.fail()`，系统才知道应该进入下一层补偿或直接 fail-fast。

这意味着 Feign timeout 在 `my-xhs` 里本质上还是一个**错误语义治理问题**：网络慢只是触发条件，真正决定后续会不会假成功的，是超时之后系统把这次失败翻译成了什么业务含义。

## 支付 / 退款补偿任务为什么说明 Feign timeout 其实是一种状态缺口，而不是单纯网络错误

`PaymentNotifyCompensateJob` 与 `RefundNotifyCompensateJob` 这两类任务特别能说明，Feign timeout 在 `my-xhs` 里最终被看成的不是 HTTP 故障，而是**状态缺口**。

以 `PaymentNotifyCompensateJob` 为例：它不会因为一次 Feign 失败就盲目重试，而是先扫支付成功记录，再通过 `getOrderPayAmount` 间接判断订单当前是否仍需要这次支付事实；只有当返回结果表明订单侧仍保留“待支付”缺口时，才重新调用 `notifyPaySuccess`。也就是说，这里补的不是“某次 HTTP 失败”，而是“支付结果尚未被订单状态机吸收”这一条缺口。`my-xhs-payment/src/main/java/com/myxhs/payment/job/PaymentNotifyCompensateJob.java:128`

退款补偿也是一样：先查退款成功记录，再问订单域当前状态，如果仍然缺这次退款事实，就重新通知；若订单服务不可达或状态异常，则累加 Redis 计数、等待下一轮；超过阈值，再暴露人工边界。`my-xhs-payment/src/main/java/com/myxhs/payment/job/RefundNotifyCompensateJob.java:81`

这说明在 `my-xhs` 里，Feign timeout 不是靠“网络恢复后自动成功”去理解的，而是靠“现在系统里还有没有一条状态缺口没补上”去理解的。只有把 timeout 解释成状态缺口，补偿任务的存在才是合理的。

## 为什么 home / BFF 的超时更危险：它会把依赖故障伪装成业务空结果

运行时复盘里，Feign timeout 最容易被讲漏的一类，就是聚合层的依赖超时。因为它不像订单、支付那样直接牵涉交易正确性，看起来更像展示层问题。

但 `my-xhs` 的历史 review 已经明确证明，这类超时如果处理错了，后果反而很隐蔽。Home BFF 曾把 product/user/cart/note/feed 等主源 Feign 失败后的 fallback 包成 `R.ok(empty)`，导致依赖故障被映射成“对象不存在”“空购物车”“空流”等看似合理的业务结果。`docs/review-1/02-findings/FINAL-VERIFIED-MAIN-BUGS.md:66`

这种问题特别危险，因为它不会像 503 那样尖叫，而是以“业务没数据”的形式悄悄污染用户感知和回归判断。换句话说，**聚合层的 Feign timeout 失败如果被语义伪装，会比直接失败更难发现。**

这也提醒本篇一个非常重要的结论：并不是所有调用链都该同样对待。交易链里的 timeout 要 fail-fast，支付结果链里的 timeout 要显式失败并交给补偿，BFF 聚合链里的 timeout 则必须小心降级语义，不能把系统错误写成业务真相。

## 真实故障案例：支付 / 退款通知 fallback 若返回成功，补偿系统就会失明

按照本卷方法论，每篇都要有真实故障案例。对 Feign timeout 这一篇来说，最适合的不是“某次网络慢了”，而是 fallback 语义本身会不会把失败隐藏掉。

`OrderFeignFallbackFactory` 的注释已经把这个风险说得非常直白：支付和订单是强一致场景，所有降级方法都必须返回失败，而不是静默成功；否则调用方就会认为操作已完成，补偿任务不会再接管。`my-xhs-payment/src/main/java/com/myxhs/payment/feign/OrderFeignFallbackFactory.java:22`

这就是一个非常值得写进正文的“架构级故障候选”：如果这里哪怕出于“用户体验”或“减少报错”的理由改成 `R.ok()`，那么超时就不再是可恢复缺口，而会变成一类**被系统自己吞掉的一致性故障**。虽然当前实现已经修成返回失败，但这个案例恰好能帮助读者理解，为什么 fallback 返回值本身就是分布式恢复语义的一部分。

再加上 `FINAL-HANDOFF.md` 对 payment→order Feign 30/30 调通的记录，以及 Task11 中“竞态自动退款 reason 正确”“部分退款两段联动”的运行态验证，可以把这条链从“纯设计推断”进一步落到真实系统里。`docs/FINAL-HANDOFF.md:160` `docs/test-3/HANDOFF-TASK11.md:80`

## 证据清单：本篇关键结论分别站在哪一层

L0 源码静态证据：

- `my-xhs-order` 的 OpenFeign 默认配置显式设置 `connect-timeout=3000`、`read-timeout=5000`，说明订单域同步依赖等待窗口是明确配置出来的。`my-xhs-order/src/main/resources/application.yml:100`
- `InventoryFeignFallbackFactory` / `CouponFeignFallbackFactory` 都在下游不可用时明确返回 503，而不伪造成功。`my-xhs-order/src/main/java/com/myxhs/order/feign/InventoryFeignFallbackFactory.java:18` `my-xhs-order/src/main/java/com/myxhs/order/feign/CouponFeignFallbackFactory.java:19`
- `OrderFeignFallbackFactory` 明确规定支付 / 退款通知降级必须返回失败，以触发补偿任务。`my-xhs-payment/src/main/java/com/myxhs/payment/feign/OrderFeignFallbackFactory.java:12`
- `PaymentNotifyCompensateJob` / `RefundNotifyCompensateJob` 显式把 Feign 状态回查与再通知写进补偿流程。`my-xhs-payment/src/main/java/com/myxhs/payment/job/PaymentNotifyCompensateJob.java:20` `my-xhs-payment/src/main/java/com/myxhs/payment/job/RefundNotifyCompensateJob.java:19`

L1 框架 / 语义证据：

- Feign timeout 在这里不是单纯网络异常，而是“同步主链是否还能继续”或“补偿链是否该接手”的分流信号。
- fallback 返回空对象 / 成功响应，会直接改变系统对失败是否可见的判断，因此本身就是业务语义决策，而不是技术细节。
- 结果通知链上的 timeout 更适合被解释为“状态缺口尚未收口”，而不是“一次 HTTP 调用慢了”。

L2 运行态证据：

- `docs/FINAL-HANDOFF.md` 已记录 payment→order Feign 30/30 调通、order→payment Feign 调通，说明这条跨服务链不是纸面设计。`docs/FINAL-HANDOFF.md:160`
- `docs/HANDOFF.md` 已记录 order→inventory / coupon / payment、home→所有服务等 URL override 修复，说明这类跨服务依赖曾真实受 Spring Cloud / Nacos 侧故障影响。`docs/HANDOFF.md:82`
- `docs/test-3/HANDOFF-TASK11.md` 已记录支付超时扫描 / 自动退款 / 部分退款两段联动等场景通过验证，说明 timeout 之后的补偿与收敛链已在运行态上走通过。`docs/test-3/HANDOFF-TASK11.md:77`

## 边界清单：哪些话现在能说，哪些还不能写满

第一，当前可以明确写出 Feign timeout 在 `my-xhs` 里会向不同恢复路径分流，但不能把它写成“所有超时都已有完备补偿”。某些聚合读超时、某些补全字段调用失败，仍可能被错误语义或半成品视图放大。

第二，当前可以明确写出支付 / 退款结果链上的 timeout 会触发补偿任务，但不能把它写成“补偿任务一定最终修复一切”。达到重试上限、状态矛盾、依赖长期不可达时，仍会暴露人工边界。

第三，当前可以明确写出 order 域同步强约束调用的 fallback 返回 503，但不能把它写成“所有下游失败都应该同样 fail-fast”。聚合链、读优化链、通知链的降级策略并不完全相同。

第四，当前可以明确写出 URL override 与 fallback / timeout 语义在历史上真实影响过系统，但不能把它写成“当前所有 Feign 风险都已清零”。运行态链路一旦变化、下游行为一旦改变，超时和补偿边界仍然会重新暴露。

## 收网：这篇 Feign Timeout 真正建立了什么

到这里可以回收开头的问题了。`my-xhs` 的 Feign timeout 不是一次普通 503，而是一条同步主链如何把失败分流出去的边界：订单主链里，它决定这次动作应不应该继续；支付 / 退款结果链里，它决定补偿任务应不应该接管；BFF 聚合链里，它决定系统故障会不会被伪装成业务空结果。

从业务逻辑视角看，它守住的是“同步依赖失败后，主链还应不应该往前走”；从工程视角看，它把 timeout 配置、fallback 返回值、Feign 回查和补偿任务串成了一条恢复分流链；从分布式视角看，它承认超时既可能是瞬时波动，也可能是状态缺口暴露；从微服务视角看，它让“下游不可达”不再只是一次 HTTP 失败，而是要么显式失败、要么明确交给下一层收口的分流点。

更重要的是，本篇把一个特别容易被低估的事实钉住了：**Feign timeout 最危险的不是超时本身，而是系统如何解释这次超时——把它当成失败、当成空结果，还是当成需要异步恢复的缺口。**

下一篇如果继续沿 `11-runtime-failure-review/` 推进，最自然的顺序就是进入 `docs/openjdk/vol-xhs/11-runtime-failure-review/04-startup-failure.md`，把前面多次出现的配置缺失、条件装配、Profile / Token / 依赖组合错误做一次系统复盘。