# 04 Startup Failure：为什么“应用起不来”在这套系统里不是一类故障，而是一整串条件与配置互锁

走到 `11-runtime-failure-review/` 这一组的第四篇，最容易出现的误解是：所谓启动失败，不过就是某个端口被占了、某个 bean 没注入、某个配置没配对。看起来都是“服务起不来”，那复盘时大概把几种常见错误列一列就够了。

但 `my-xhs` 的真实材料恰恰说明，启动失败在这里不是单点问题，而是一整串条件、配置、Profile、依赖和外部中间件互相锁死的结果。它既可能来自最外层的端口冲突，也可能来自 Feign 与 Sentinel 的版本语义错配；既可能来自 `@ConditionalOnProperty` 让某个 bean 不加载，又可能来自另一个类对这个 bean 的强依赖；既可能来自 Redis / Sentinel 尚未可达，导致网关在 bean 创建期就直接炸掉；也可能来自 shell 脚本引号坏掉，让明明存在的参数根本没被 JVM 收到。换句话说，**在 `my-xhs` 里，“应用起不来”并不是一个统一症状，而是一组互相缠绕的启动前提条件暴露失败。**

这也是为什么这一篇不能只沿着 Spring Boot 启动日志去讲。前面的历史修复里，已经清清楚楚摆着几种完全不同的启动失败类型：`MockPayService` 条件装配导致 `pay.type=remote` 时 order 起不来；`OrderFeignClient` / `PaymentFeignClient` 的 `contextId` 又会把问题推进到 `Cannot invoke "Object.hashCode()" because "key" is null` 这种 Feign / LoadBalancer NPE；gateway 还会因为 Redis Sentinel 地址不对，连 `stringRedisTemplate` 都建不起来，直接在过滤器构造阶段报 `Cannot build a RedisURI`；analytics 则可能因为启动脚本里 `JAVA_OPTS` 引号坏掉，导致 admin token 实际为空，最后表现为启动失败或噪音日志。`docs/FINAL-HANDOFF.md:168` `docs/test-3/pitfalls.md:241` `docs/test-3/review/ANSWERS-DEPLOY-PACKAGE.md:145`

所以本篇真正要回答的，不是“系统曾经有哪些启动失败”，而是：**为什么在 `my-xhs` 里，启动失败本质上是一类条件链故障——某个模块能不能启动，不只取决于自己代码有没有问题，还取决于配置开关、条件装配、下游 token、Redis / Sentinel、Feign / LoadBalancer 和重启脚本是不是共同满足了一套隐藏前提。** 只有把这层互锁关系讲清，读者才不会继续把“启动失败”理解成一条日志里的单次异常。

## 先给结论：`my-xhs` 的启动失败不是单点异常，而是“模块对外部条件的真实依赖图”被一次性撕开的时候

先别急着看具体案例，先把本篇最重要的人话答案钉住：`my-xhs` 的启动失败，真正暴露的不是某一行代码单独写错了，而是**模块对环境、依赖和条件装配的真实依赖图**。

一个服务能不能起，不只是“main 方法能不能跑”，而是至少要同时满足几类前提：

- 端口没人占用
- 启动脚本把正确参数、profile、token、agent 传进 JVM
- `@ConditionalOnProperty` 选出的 bean 集合与代码里的真实注入关系一致
- Redis / Sentinel / Nacos / MQ / Feign / LoadBalancer 这些外部依赖在启动阶段至少达到最小可用
- 某些框架组合（Spring Cloud / SCA / Sentinel / OpenFeign）没有在当前版本上触发隐藏的不兼容路径

只要其中一层出错，Spring Boot 最终可能都统一表现为 `APPLICATION FAILED TO START`，但背后的故障类别其实完全不同。也正因为如此，启动失败在 `my-xhs` 里最不能用“一句话归纳”。同样是起不来，端口冲突、条件装配冲突、Redis 硬依赖、脚本参数缺失、Feign 版本语义错配，对后续修法的要求是完全不同的。

如果把这些都混成“服务启动失败”，后面每次复盘都会看起来像随机踩坑；把它们拆成条件链之后，你才会意识到：`my-xhs` 的启动问题大多不是偶然，而是架构真实依赖关系被一次性揭开。

## 直觉方案为什么不够：不是所有启动失败都能靠“补个配置、重启一下”解决

### 失败方案一：缺什么 bean 就补什么 bean

这是最常见的思路。启动失败日志里说哪个 bean 创建失败，就去把那个 bean 补出来，或者改下注入方式，让 Spring 能起就行。

问题在于，这种做法经常只处理了表面依赖，而没有看清 bean 集合为什么会发生变化。`MockPayService` 的案例就是典型：order 模块原本允许 `pay.type=mock` 走本地 Mock 支付，但一旦运行切到 `pay.type=remote`，`MockPayService` 因 `@ConditionalOnProperty` 不再加载；如果 Controller / Service 还把它当硬依赖注入，启动时就会直接失败。这里真正的问题不是“少一个 bean”，而是**条件装配切换后，调用方仍按旧依赖图工作**。`docs/FINAL-HANDOFF.md:171` `my-xhs-order/src/main/java/com/myxhs/order/service/MockPayService.java:35`

所以启动失败不是“少配一行 bean”那么简单，而是条件装配把依赖图切换了，你的代码是否真的接受这种切换。

### 失败方案二：只要依赖服务运行了，应用启动一定不会再卡外部中间件

第二个误解也很常见：应用启动本身主要是加载 Spring 容器，真正访问 Redis、Feign、MQ、Nacos 应该都在运行期；所以只要代码逻辑没错，外部依赖即便暂时不通，也不至于让应用起不来。

`my-xhs` 的 gateway 刚好就是反例。历史 pitfall 里已经明确写过：gateway 的 `GatewayAuthFilter` / `HmacSignatureFilter` 通过构造器硬依赖 `stringRedisTemplate`，而 `RedisConnectionFactory` 又依赖 Sentinel 节点配置；如果 Redis / Sentinel 广播地址不对，`Cannot build a RedisURI` 会直接在 bean 创建期把整个 gateway 启动打死。也就是说，在这里 Redis 不是“运行时才会访问”的依赖，而是**启动前置硬依赖**。`docs/test-3/pitfalls.md:241`

这说明在 `my-xhs` 里，不能笼统地把外部中间件都看成运行期依赖。有些模块把它们拉进了启动链本身。

### 失败方案三：日志里报什么就修什么，脚本和参数层不重要

第三个误解则更偏运维现实：既然应用起不来，看启动日志报什么就修什么，脚本参数只是机械输入，不会决定故障本质。

这在 `my-xhs` 里同样不成立。analytics 的历史问题就说明，光是 `start-all.sh` / 启动脚本里 `JAVA_OPTS_ANALYTICS` 引号坏掉，就足以让 admin token 参数根本没被 JVM 收到，最后表现成启动失败、空等甚至噪音日志洪峰。这里应用代码本身未必有任何问题，故障却真实地发生在脚本层。`docs/test-3/review/ANSWERS-DEPLOY-PACKAGE.md:145`

所以本篇必须把启动脚本、环境变量、条件装配和应用代码一起看，不能把它们拆成“运维层”和“代码层”两个互不相干的世界。

## 先画总图：`my-xhs` 的启动失败其实分成四类条件链

先把问题空间用文字图立住：

```text
启动失败
  -> A. 端口 / 进程层
       端口被旧实例占用 -> bind 失败 -> APPLICATION FAILED TO START

  -> B. 条件装配层
       @ConditionalOnProperty 切换 -> bean 不加载
       调用方仍强依赖 -> 启动失败

  -> C. 外部依赖层
       Redis / Sentinel / Nacos / Feign / MQ 在 bean 创建期被硬依赖
       地址错误 / token 缺失 / 依赖不可达 -> 容器启动失败

  -> D. 框架组合层
       Spring Cloud / OpenFeign / Sentinel / LoadBalancer 在当前版本下出现语义错配
       典型如 contextId + hashCode NPE / WebFlux NoSuchMethodError
```

这张图里最关键的，不是类别多，而是它告诉读者：启动失败在 `my-xhs` 里不是一个层面的故障，而是四类完全不同的条件链断裂。如果你不先判断自己落在哪一类，后面的修法大概率会跑偏。

## 条件装配链：`MockPayService` 为什么把“切到 remote 模式”变成了直接启动失败

这是最值得先讲的启动失败案例，因为它非常典型地暴露了 `@ConditionalOnProperty` 的双刃剑特性。

`MockPayService` 的类上明确标了：只有 `pay.type=mock` 时才加载，而且 `matchIfMissing=true`。这意味着在默认 / mock 模式下，它会存在；一旦显式切到 `pay.type=remote`，这个 bean 就会从容器里消失。`my-xhs-order/src/main/java/com/myxhs/order/service/MockPayService.java:35`

问题出在切到 remote 后，调用方如果仍然把它当成必注入 bean 使用，Spring 容器就会在启动阶段直接失败。`FINAL-HANDOFF.md` 已明确记录这次修复：`OrderController` / 相关路径对 `MockPayService` 的强依赖，导致 `pay.type=remote` 时 order 服务起不来，后来通过 `ObjectProvider<MockPayService>` 改成可选注入才恢复启动。`docs/FINAL-HANDOFF.md:171`

这个案例特别有代表性，因为它说明条件装配不是“把某个实现优雅切掉”就完了。真正危险的地方在于：**依赖图也必须跟着模式切换一起变化。** 只要调用方还活在旧模式里，`@ConditionalOnProperty` 就会从“灵活开关”变成“启动断路器”。

## 框架组合链：为什么 `contextId` 能把 Feign / LoadBalancer 问题推进到启动期

另一类非常具有代表性的启动失败，是 Feign / LoadBalancer / Sentinel 版本组合在当前框架栈上的语义错配。`FINAL-HANDOFF.md` 已明确记录过一次典型修复：`OrderFeignClient` / `PaymentFeignClient` 使用 `contextId` 后，配合 Sentinel Feign 与当前 Spring Cloud 组合，会触发 `Cannot invoke "Object.hashCode()" because "key" is null` 这种启动期 NPE，修复方式是删除 `contextId`。`docs/FINAL-HANDOFF.md:168`

这里最重要的，不是某个参数不能用，而是这类故障说明：**框架组合层的启动失败并不一定来自业务代码，而是来自几个“看起来都合法”的配置项在当前版本语义下发生了冲突。** 这也是为什么简单读一眼注解或配置往往看不出问题，只有在真实 Spring 容器装配、Sentinel 代理和 Feign Client 初始化时，故障才会浮现。

所以这类故障不适合被归成“少配了一个属性”，它本质上是版本与装配语义错配。

## 外部依赖链：gateway 为什么能在 Redis / Sentinel 不可达时直接起不来

`my-xhs` 最值得警惕的一类启动失败，是那些把外部依赖直接拉进 bean 创建期的模块。gateway 就是最典型的例子。

历史 pitfall 已明确指出：gateway 的过滤器通过构造器硬依赖 `stringRedisTemplate`，而 Redis 连接工厂在 Sentinel 配置有值时会优先尝试构建哨兵连接；如果 Sentinel 广播的是错地址、或者 `RedisURI` 根本无法构建，应用就不是“启动后访问 Redis 时失败”，而是**根本启动不起来**。`docs/test-3/pitfalls.md:241`

这条链在架构上非常关键，因为它把“gateway 是 Redis 硬依赖”直接暴露出来。也就是说，在 `my-xhs` 里，有些模块对外部中间件的依赖不是延迟绑定的，而是提前绑定到容器启动期。一旦地址 / token / 节点状态错了，启动失败就不再是业务层问题，而是容器根本构不起来。

对读者来说，这一点必须讲透，否则很容易误把“Redis / Sentinel 错配”当成运行期慢性故障，而不是启动级致命依赖。

## 参数 / 脚本链：为什么 shell 引号坏掉也会表现成应用启动失败

`my-xhs` 的历史材料还揭示了另一类非常容易被忽略的启动失败：代码层没错，Spring 配置也没错，但 shell 脚本把 JVM 参数拼坏了。

`docs/test-3/review/ANSWERS-DEPLOY-PACKAGE.md` 已经把 analytics 的问题说得非常直接：`JAVA_OPTS_ANALYTICS` 历史上引号坏掉，导致 `-Dmanagement.admin-token=...` 这样的参数实际上没有正确传入；结果应用表现成 admin-token 缺失、启动失败或长时间噪音。`docs/test-3/review/ANSWERS-DEPLOY-PACKAGE.md:145`

这类故障最危险的地方在于，它在日志层面看起来可能像业务配置缺失，但真正根因根本不在应用配置文件，而在启动脚本字符串拼接。也就是说，**启动失败的责任边界未必在服务本身，可能在脚本把依赖条件表达错了。**

这也是为什么本篇必须把脚本、Profile、环境变量和 Spring 容器放在同一张因果图里去看。

## 真实故障案例：`pay.type=remote` 下 order 因 `MockPayService` 强依赖而启动失败

按照本卷方法论，每篇都要有一个能逼出设计问题的真实故障案例。对启动失败篇来说，最适合的主案例就是 order 切到 remote 支付模式后，因为 `MockPayService` 条件装配 + 调用方强依赖而直接起不来。

这个案例特别有价值，因为它不是“端口被占了”这种基础设施故障，而是更贴近业务架构切换现实的一种失败：开发模式切生产模式，本来应该只是替换支付实现；结果却因为依赖图没跟着切换，一启动就炸。

用方法论的五段式收它：

- 现象：`pay.type=remote` 下 order 服务启动失败
- 根因：`MockPayService` 仅在 `pay.type=mock` 时加载，但调用链仍将其视作硬依赖
- 修复：改成 `ObjectProvider<MockPayService>` 这类可选注入，让 remote 模式不再要求 Mock bean 存在
- 验证：交接文档已记录 remote 模式启动成功，order→payment Feign 调通
- 余波：以后任何 `@ConditionalOnProperty` 切实现的地方，都必须同时审调用方依赖图

这个案例几乎就是本篇总纲：启动失败真正暴露的，不是某个 bean 缺了，而是**条件切换后的真实依赖图并没有被代码正确承接。**

## 为什么“启动失败”篇必须单独讲：它把运行前提条件显性化了

前面的端口冲突、Feign timeout、死信复盘，很多都还发生在“服务已经活着”的前提下。启动失败则不同：它直接告诉我们，这套系统很多时候并不是“业务代码开始运行后才暴露复杂度”，而是**在进入业务之前，依赖条件链就已经足够复杂到让整个服务停在容器初始化阶段。**

这也是为什么本篇的价值不在于多列几个报错字符串，而在于把“模块到底依赖什么才能启动”这张图显性化。只有前提条件图被看见，后面很多所谓偶发故障才不会显得随机。

这里还要再补一个和端口冲突篇呼应的工程判断：启动失败的另一面，往往就是**平台假成功**。只要脚本、调度台、监控面板或回调端点把失败翻译成了“看起来还行”，系统就会进入最危险的一类状态——故障已经发生，但上层控制面还以为服务已经恢复。端口冲突篇里的 health 假阳性、退款回调篇里的 `R.ok()` 假成功、推荐任务篇里的 XXL-Job `handleSuccess()` 假产物，其实都属于同一类问题：**控制面错误地确认了一个并未真正成立的状态。**

所以“应用起不来”这一篇真正要给读者留下的，不只是几种启动错误的分类，而是一个更通用的判断：在 `my-xhs` 里，很多最难排的运行时故障都不是业务逻辑本身，而是系统的确认链把失败说成了成功。

## 证据清单：本篇关键结论分别站在哪一层

L0 源码 / 配置静态证据：

- `MockPayService` 明确受 `@ConditionalOnProperty(name="pay.type", havingValue="mock", matchIfMissing=true)` 控制。`my-xhs-order/src/main/java/com/myxhs/order/service/MockPayService.java:35`
- `my-xhs-order` 的 Feign 默认配置显式存在 `connect-timeout=3000`、`read-timeout=5000`，并依赖 `FeignInternalCallInterceptor`。`my-xhs-order/src/main/resources/application.yml:94`
- order 启动类显式排除了 `DataSourceAutoConfiguration`、`MybatisPlusAutoConfiguration`，并自定义了主数据源装配，说明启动图本身就不走默认路径。`my-xhs-order/src/main/java/com/myxhs/order/OrderApplication.java:21`
- payment 控制器严格依赖 `myxhs.internal.token` / `myxhs.admin.token`，说明 token 是否传进进程本身就会决定运行与启动后行为。`my-xhs-payment/src/main/java/com/myxhs/payment/controller/PaymentController.java:35`

L1 框架 / 语义证据：

- `@ConditionalOnProperty` 改变的不只是实现类集合，还会直接改变容器依赖图；调用方若仍按旧图工作，启动期就会失败。
- 外部依赖若在 bean 创建阶段被硬依赖，失败表现就不是“运行时慢性退化”，而是容器直接起不来。
- 启动脚本、系统属性、Profile、条件装配和外部依赖共同组成真实启动图，不能拆成彼此独立的小问题。

L2 运行态证据：

- `FINAL-HANDOFF.md` 已明确记录 `MockPayService` 强依赖导致 `pay.type=remote` 启动失败，以及修复后 remote 模式成功启动。`docs/FINAL-HANDOFF.md:171`
- 同一份文档已记录 `OrderFeignClient` / `PaymentFeignClient` 的 `contextId` 导致 Sentinel Feign NPE，删除后启动恢复。`docs/FINAL-HANDOFF.md:168`
- `docs/test-3/pitfalls.md` 已明确记录 gateway 因 Sentinel / RedisURI 构建失败而启动失败，说明外部依赖可直接进入容器启动链。`docs/test-3/pitfalls.md:241`
- `docs/test-3/review/ANSWERS-DEPLOY-PACKAGE.md` 已记录 analytics 启动脚本引号错误导致 admin-token 未生效的真实问题。`docs/test-3/review/ANSWERS-DEPLOY-PACKAGE.md:145`
- 当前本机 `19010/19016/19011/19012` 都实测 `OPEN`，说明 coupon/search/order/payment 现时监听已恢复；但这只是现时状态，不等价于启动链风险永久消失。

## 边界清单：哪些话现在能说，哪些还不能写满

第一，当前可以明确写出 `my-xhs` 的启动失败是条件链故障，不是单点异常；但不能把它写成“所有启动失败都已被彻底根除”。现有材料能证明的是历史问题类型与修复路径，不是未来不会再踩。

第二，当前可以明确写出 `@ConditionalOnProperty`、Feign / Sentinel 版本语义、Redis / Sentinel 可达性、脚本参数传递都会决定服务能否启动；但不能把它们写成“彼此互斥”的故障类型。现实里它们经常会叠在一起。

第三，当前可以明确写出 `pay.type=remote`、Feign `contextId`、gateway RedisURI、analytics admin-token 都是启动失败的真实案例；但不能把这些案例外推成“所有模块都存在同等级别条件装配风险”。更准确的说法是：这套系统的多个关键模块已经暴露出这种模式，足以说明启动图依赖复杂。

第四，当前可以明确写出本机相关端口现已恢复为 `OPEN`；但不能把这写成“对应新代码与新配置一定已正确生效”。端口开放只是一层现时运行态证据，仍需与版本、日志和功能探活一起成立。

## 收网：这篇 Startup Failure 真正建立了什么

到这里可以回收开头的问题了。`my-xhs` 的启动失败不是一类“起不来”的统一错误，而是服务真实启动图中多个条件链的断裂：端口占用、条件装配切换、Redis / Sentinel 硬依赖、Feign / Sentinel 版本语义错配、脚本参数传递错误，都可能让系统在业务逻辑尚未开始前就停下。

从业务逻辑视角看，它决定的是“后面所有链路是否有资格开始运行”；从工程视角看，它暴露的是 Spring 条件装配、脚本、系统属性、token、外部依赖和框架版本的组合复杂度；从分布式视角看，它说明很多所谓业务故障其实在进入业务之前就已埋好雷；从微服务视角看，它让“启动图”本身成为了必须被复盘和设计的系统事实，而不是默认背景。

更重要的是，本篇把一个特别容易被忽略的事实钉住了：**在 `my-xhs` 里，很多启动失败不是因为代码不会跑，而是因为系统对“什么条件下这段代码才允许开始跑”这件事，本身就非常复杂。**

下一篇如果继续沿 `11-runtime-failure-review/` 推进，这一组已经基本收口；更自然的转向，是进入 `12-testing-release-ops/01-test-strategy.md`，把前面大量出现的 15 层验证、cases、pitfalls 和真实回归方法统一收束成测试策略篇。