# 技术栈选型与版本

> 对应目录：`vol-xhs/00-overview-architecture/`
> 目标问题：为什么 `my-xhs` 最后会落成 `Spring Cloud + Nacos + RocketMQ + MySQL + Redis + Elasticsearch + SkyWalking` 这组技术栈？它们各自到底在系统里承担什么职责？

## 一句话困惑

前面三篇已经把服务拓扑、业务域边界、核心数据流串了起来，但读者还会自然追问：**为什么这些业务和数据流，最后要压在现在这套基础设施上？**

尤其是 `my-xhs` 这种系统，看起来几乎把常见中间件都用了一遍：

- 服务发现与配置中心用 `Nacos`
- 接口治理和流量入口用 `Gateway + Sentinel`
- 异步消息用 `RocketMQ`
- 事务性与主数据持久化用 `MySQL`
- 高并发准备态和热点数据用 `Redis`
- 搜索与日志又用 `Elasticsearch`
- 定时补偿和回放用 `XXL-Job`
- 可观测性再叠一层 `SkyWalking + Prometheus`

如果只是把这些名词列出来，文章就会退化成技术清单；真正应该回答的是：**每一个组件到底接住了系统哪一类问题，如果去掉它，会先坏掉哪一段链路。**

## 一句话答案

`my-xhs` 这套技术栈并不是为了“显得微服务很完整”，而是分别接住了七类不同问题：服务寻址、流量治理、异步扩散、主数据持久化、热点状态承载、检索视图组织、运行时可观测与补偿。它们叠在一起，刚好对应前面三篇已经建立起来的拓扑、边界和数据流。

## 先给出最小技术地图

```text
入口与治理
  Gateway + Sentinel

服务发现与配置
  Nacos

同步业务与主数据
  Spring Boot / Spring Cloud + MySQL

高频状态与缓存
  Redis

异步扩散与补偿
  RocketMQ + XXL-Job

检索与发现
  Elasticsearch

运行态观测
  SkyWalking + Prometheus + 日志链路
```

这张图里最关键的判断是：**每个技术组件不是围绕某个服务存在，而是围绕某一类问题存在。**

## 先推演第一个失败方案：只靠 Spring Boot + MySQL 跑完整个平台

一种最直觉的想法是：既然业务代码都写在 Spring Boot 里，能不能不用那么多中间件，直接 HTTP + MySQL 把整个平台跑起来？

### 为什么这个方案很诱人

因为它简化了部署心智：

- 每个服务自己连库。
- 服务之间直接调接口。
- 所有状态都落 MySQL。
- 不需要消息队列、缓存、搜索、配置中心、观测组件。

这套方案在 demo 级系统里常常足够。

### 它在 `my-xhs` 上会先坏在哪里

前面几篇已经说明，`my-xhs` 不是纯同步 CRUD：

- 商品浏览依赖聚合读流。
- 购物车把 Redis 当权威数据源。
- 优惠券靠 Lua 原子扣减和 MQ 同步入库。
- 订单靠多域编排和事务消息。
- 通知靠异步扩散和 SSE 推送。

如果只剩 Spring Boot + MySQL，这几段链路会先后失去支撑：

1. **没有 Nacos**，服务寻址和配置变更会退化成硬编码。
2. **没有 Redis**，购物车、券库存、分布式锁、未读数、热搜窗口都会直接压到数据库。
3. **没有 RocketMQ**，内容扩散、通知生成、事务保底、补偿回放全部会被迫塞进同步链路。
4. **没有 Elasticsearch**，内容检索和商品检索会退化成数据库模糊查询。
5. **没有可观测性链路**，跨服务故障会难以追踪。

所以第一个失败方案不是“功能不能写”，而是**一旦真实流量和真实链路复杂度进来，系统会先在寻址、并发、扩散和观测四个方向崩掉。**

## 再推演第二个失败方案：所有问题都交给同一个中间件处理

另一种常见误区是：既然中间件这么多，不如尽量统一用途，比如：

- 既然 Redis 很快，那把所有状态都塞 Redis。
- 既然 MQ 能解耦，那所有跨域动作都异步化。
- 既然 ES 能查，那把主数据也全交给 ES。

这同样会失败。

### 为什么它也很有诱惑力

因为“统一组件做统一问题”在局部上很省脑子。单个团队只要把一个组件玩熟，好像什么都能往里装。

### 它在 `my-xhs` 上失败在哪里

`my-xhs` 这套系统恰恰证明，不同数据语义要用不同承载：

- 购物车适合 Redis 权威 + MQ 异步落库。
- 优惠券适合 Redis 原子扣减 + MQ syncSend + 失败回滚。
- 订单适合 MySQL 本地事务 + 事务消息。
- 搜索适合 ES 索引视图，不适合承载主交易真相。
- 通知适合 DB + Redis 未读数 + SSE 推送，不适合只靠 MQ 临时飞过去。

所以技术栈真正要解决的，不是“统一”，而是**让不同语义的数据落在最合适的基础设施上。**

## 1. Gateway：它不是普通转发器，而是整个系统的流量入口层

从配置上看，`gateway` 已经把自己的角色写得很清楚。`my-xhs-gateway/src/main/resources/application.yml:27` 直接说明它是 WebFlux 网关，不接数据库；`my-xhs-gateway/src/main/resources/application.yml:80` 之后则进入统一路由配置。

这里的职责至少有四类：

1. **统一路由**：`/api/user/**`、`/api/order/**`、`/api/home/**` 等入口全部在这里分流。
2. **超时与连接池治理**：`httpclient.connect-timeout`、`response-timeout`、连接池生命周期都在这里设定，见 `my-xhs-gateway/src/main/resources/application.yml:81` 到 `:91`。
3. **按业务域差异化限流**：订单、支付、搜索、首页等路由有不同 QPS 与超时元数据，见 `my-xhs-gateway/src/main/resources/application.yml:99` 之后。
4. **统一安全入口**：JWT、HMAC、白名单、管理端点放行都在网关层收敛。

如果没有网关，这些策略就会分散到各服务里重复实现，最后每个域都得自己处理“入口问题”。

## 2. Nacos：它解决的是“服务怎么互相找到”和“配置怎么动态收拢”

几乎所有服务的 `application.yml` 都同时声明了 `spring.cloud.nacos.discovery` 和 `spring.cloud.nacos.config`。例如：

- 网关：`my-xhs-gateway/src/main/resources/application.yml:37` 到 `:59`
- 订单：`my-xhs-order/src/main/resources/application.yml:57` 到 `:74`
- 购物车：`my-xhs-cart/src/main/resources/application.yml:56` 到 `:73`
- 搜索：`my-xhs-search/src/main/resources/application.yml:56` 到 `:73`
- 通知：`my-xhs-notification/src/main/resources/application.yml:58` 到 `:75`

这说明 Nacos 在系统里承担的是双重角色：

### 第一重角色：服务发现

`gateway` 路由里使用 `lb://my-xhs-user`、`lb://my-xhs-order` 这种形式，说明同步调用链默认依赖注册发现而不是硬编码地址。

### 第二重角色：配置中心

很多公共配置通过 shared-configs 下发，例如 `my-xhs-common.yaml`。这意味着：

- Redis 密码
- 公共动态开关
- 某些共享配置

不是散落在每个模块自己的文件里，而是尝试通过配置中心统一收拢。

Nacos 在这里要解决的核心问题，不是“方便”，而是**让一张会变化的服务拓扑还能被统一发现和统一配置。**

## 3. Sentinel：它解决的是“调用可以失败，但不能失控”

几乎每个服务都配了 `spring.cloud.sentinel.transport` 和 `eager: true`。例如：

- 网关：`my-xhs-gateway/src/main/resources/application.yml:60` 到 `:79`
- 订单：`my-xhs-order/src/main/resources/application.yml:87` 到 `:93`
- 搜索：`my-xhs-search/src/main/resources/application.yml:74` 到 `:78`
- 通知：`my-xhs-notification/src/main/resources/application.yml:76` 到 `:80`

同时，Feign 侧也普遍开启了 Sentinel 支持：

- `my-xhs-order/src/main/resources/application.yml:129` 到 `:133`
- `my-xhs-cart/src/main/resources/application.yml:113` 到 `:117`

这说明 Sentinel 在系统里的核心职责不是“装一个控制台看看 QPS”，而是：

- 给 Gateway 提供入口限流基座。
- 给 Feign 调用提供 fallback 生效条件。
- 给聚合域和编排域提供舱壁/降级思路。

也就是说，它服务的是“失败治理”，不是“业务功能”。

## 4. MySQL：它仍然是交易真相和主数据真相的最终落点

虽然系统里大量使用 Redis、MQ、ES，但交易真相最终仍然要落到 MySQL。

从订单配置就很能看出来。`my-xhs-order/src/main/resources/application.yml:138` 到 `:149` 里，订单服务甚至显式区分了：

- 支付数据源
- 订单号映射表数据源

这说明交易域的真相不仅落库，而且落得很认真：分库、映射表、独立数据源都在服务配置里明确存在。

MySQL 在系统里主要承担三类真相：

1. **主数据真相**：用户、商品、内容、通知等对象。
2. **交易真相**：订单、支付、退款、库存等强状态数据。
3. **补偿真相**：本地消息表、Outbox、事件表、对账表等。

换句话说，Redis 和 MQ 再活跃，也没有取代 MySQL 的“最终账本”地位。

## 5. Redis：它承载的是高频状态、并发控制和短路径真相

Redis 在 `my-xhs` 里不是单纯“做缓存”。它至少有四种角色。

### 第一种角色：准备态权威数据源

购物车就是典型例子。`my-xhs-cart/src/main/resources/application.yml:37` 到 `:55` 先配好 Redis，而 `CartController` 和 `CartService` 又明确把 Redis 定义为权威数据源。

### 第二种角色：原子扣减与高并发防超卖

优惠券服务的 Redis Key 设计和 Lua 脚本直接说明，它用 Redis 解决券库存和限领的原子收敛，见 `my-xhs-coupon/src/main/java/com/myxhs/coupon/service/CouponService.java:37` 到 `:47`。

### 第三种角色：分布式锁与幂等状态

订单服务和支付服务都大量依赖 Redis 键做幂等、防重复、防并发进入。没有 Redis，这些短路径状态就会退化成数据库行锁或重复请求风暴。

### 第四种角色：未读数、热搜窗口、聚合辅助状态

通知未读数、热搜统计、搜索历史、SSE ticket 等，都天然更适合放在 Redis，而不是直接打主库。

这说明 Redis 在系统里承担的是：**高频、短路径、原子、可失效、但又必须足够快的那部分状态。**

## 6. RocketMQ：它解决的是“主链之外的扩散”和“主链失败后的保底”

几乎所有关键业务服务都配了 `rocketmq.name-server`：

- 订单：`my-xhs-order/src/main/resources/application.yml:122`
- 购物车：`my-xhs-cart/src/main/resources/application.yml:104`
- 搜索：`my-xhs-search/src/main/resources/application.yml:101`
- 通知：`my-xhs-notification/src/main/resources/application.yml:104`

前面数据流篇已经说明，MQ 在系统里主要承担两类问题：

### 第一类：结果扩散

- 内容发布后 Feed 扩散
- 点赞/关注后通知生成
- 推荐行为上报
- 购物车异步落库

### 第二类：一致性保底

- 订单事务消息
- 库存补偿与超时释放
- 券库存和用户券入库之间的收敛

因此 RocketMQ 的定位不是“让代码更解耦”这种抽象套话，而是：**把不能阻塞主链路、但又必须最终发生的动作接走。**

## 7. Elasticsearch：它承担的是检索视图，不是主数据权威

搜索服务配置非常清楚地表明它是独立视图层：`my-xhs-search/src/main/resources/application.yml:93` 到 `:100` 配置 ES 连接，`:110` 到 `:121` 定义了 `note_index`、`product_index`、`suggest_index` 等索引名。

这说明 ES 在系统里回答的问题不是“数据存在吗”，而是：

- 能否高效按关键词搜内容。
- 能否高效按关键词搜商品。
- 能否做搜索建议、热搜与发现。

一旦把 ES 当主数据源，后面的状态一致性会很快失控；但如果完全没有 ES，内容和商品检索又会退化成数据库扫描。所以它天然适合作为**检索视图层**。

## 8. XXL-Job：它承接的是那些不能只靠请求触发的动作

很多服务都配了 `xxl.job`：

- 订单：`my-xhs-order/src/main/resources/application.yml:152`
- 搜索：`my-xhs-search/src/main/resources/application.yml:180`
- 通知：`my-xhs-notification/src/main/resources/application.yml:131`

这说明系统里有一类动作根本不属于“用户请求来了才触发”，而属于：

- 延迟关单兜底
- 索引重建
- 补偿修复
- 对账回放
- 定时清理

如果没有任务调度体系，这些动作就会零散地塞进某个接口或者某个 `@Scheduled` 里，难以稳定编排和观测。

## 9. 可观测性链路：它解决的是“系统会动，但你看不见它为什么这样动”

几乎所有服务都暴露了 `management.endpoints.web.exposure.include: health,info,prometheus,metrics`，例如：

- 订单：`my-xhs-order/src/main/resources/application.yml:165` 之后
- 购物车：`my-xhs-cart/src/main/resources/application.yml:119` 之后
- 搜索：`my-xhs-search/src/main/resources/application.yml:145` 之后
- 通知：`my-xhs-notification/src/main/resources/application.yml:144` 之后

这说明 Prometheus 指标暴露已经被当成标配。再结合交接文档里持续提到的 SkyWalking、ES 日志、traceId 入库问题，可以看出系统已经把可观测性当成主链路配套的一部分，而不是外置附属品。

可观测性在这里至少解决三件事：

1. **跨服务 trace**：请求穿过 gateway、order、payment、inventory 时，能不能串起来。
2. **指标可视化**：接口 RT、连接池、业务延迟、限流等能不能画出来。
3. **日志归集与检索**：当 Feign、MQ、配置中心、缓存出问题时，能不能按 traceId 回查现场。

也就是说，没有可观测性，这套系统并不是“少一块仪表盘”，而是**出现问题时根本不知道数据流断在哪。**

## 这套技术栈真正回答的七类问题

到这里可以把整套技术栈压缩成七类问题和七个答案：

1. **服务怎么找到彼此** → `Nacos`
2. **流量怎么进来、怎么限流、怎么鉴权** → `Gateway + Sentinel`
3. **主数据和交易真相最终落在哪** → `MySQL`
4. **高频状态和并发控制放在哪** → `Redis`
5. **主链之外的扩散和补偿怎么做** → `RocketMQ + XXL-Job`
6. **检索和发现怎么做** → `Elasticsearch`
7. **系统为什么坏、坏在哪、链路断在哪** → `SkyWalking + Prometheus + 日志链路`

这七类问题如果少任意一类，前面三篇已经建立起来的拓扑、边界和数据流都会缺一块支撑。

## 真实故障案例：为什么技术栈不是装饰，而是故障会首先暴露的边界

这套技术栈之所以值得单独写，不是因为“项目用了很多中间件”，而是因为故障常常先在这些技术栈边界上暴露。

### 现象

前一阶段修复里，出现过多类非常典型的问题：

- 网关路由缺失导致入口不可达。
- Feign 寻址与 URL override 问题导致跨服务调用不稳。
- traceId 不进 ES，导致跨服务排查断链。
- MQ 历史坏消息和死信问题暴露出一致性链条没有自动收束。
- SkyWalking 插件冲突说明观测链本身也会成为故障源。

### 根因

这些问题表面上分散，实质上都落在同一个判断上：**技术栈中的每一层都在承担业务责任，因此每一层失效时，暴露出来的不是“中间件坏了”，而是某一类业务能力消失了。**

### 修复

所以修复从来不是“把某个服务重启一下”这么简单，而是要明确：

- 它属于入口问题、寻址问题、缓存问题、消息问题，还是观测问题。
- 这层坏掉后，上面的哪条业务链会先断。

### 验证

对应地，验证也必须是分层的：

- 网关路由恢复没有。
- 服务发现恢复没有。
- MQ 消费是否继续推进。
- 指标、日志、trace 是否重新可见。

### 余波

这个案例提醒我们：**技术栈不是部署附录，而是业务系统的一部分。** 在微服务系统里，很多业务能力根本就长在基础设施之上。

## 这一篇先收束成一张技术-问题映射图

```text
Nacos
  解决：服务发现 + 配置中心

Gateway + Sentinel
  解决：统一入口 + 鉴权 + 限流 + 调用治理

MySQL
  解决：主数据真相 + 交易真相 + 补偿账本

Redis
  解决：高频状态 + 原子扣减 + 幂等键 + 分布式锁

RocketMQ
  解决：异步扩散 + 事务保底 + 最终一致性收敛

Elasticsearch
  解决：检索视图 + 发现能力

XXL-Job
  解决：补偿、回放、定时重建、兜底调度

SkyWalking + Prometheus + 日志链路
  解决：跨服务观测、指标可视化、故障定位
```

这里最重要的不是“用了哪些组件”，而是两条判断：

1. 每个组件都是在替某一类业务难题兜底，不是装饰性的企业组件堆砌。
2. 一旦系统出故障，问题往往会先沿着这些组件边界暴露出来。

## 证据清单

这篇的关键判断主要由以下证据托底：

- 网关与入口治理：`my-xhs-gateway/src/main/resources/application.yml:27`、`my-xhs-gateway/src/main/resources/application.yml:80`
- Nacos 发现与配置中心：`my-xhs-gateway/src/main/resources/application.yml:37`、`my-xhs-order/src/main/resources/application.yml:57`
- Sentinel 治理：`my-xhs-gateway/src/main/resources/application.yml:60`、`my-xhs-order/src/main/resources/application.yml:87`
- Feign + Nacos 同步调用基座：`my-xhs-order/src/main/resources/application.yml:94`、`my-xhs-cart/src/main/resources/application.yml:79`
- RocketMQ 作为异步与事务基座：`my-xhs-order/src/main/resources/application.yml:122`、`my-xhs-cart/src/main/resources/application.yml:104`、`my-xhs-notification/src/main/resources/application.yml:104`
- Redis 作为高频状态承载：`my-xhs-cart/src/main/resources/application.yml:37`、`my-xhs-search/src/main/resources/application.yml:37`
- Elasticsearch 作为检索视图：`my-xhs-search/src/main/resources/application.yml:93`
- XXL-Job 作为补偿/重建基座：`my-xhs-order/src/main/resources/application.yml:152`、`my-xhs-search/src/main/resources/application.yml:180`
- Prometheus 指标暴露：`my-xhs-order/src/main/resources/application.yml:165`、`my-xhs-search/src/main/resources/application.yml:145`、`my-xhs-notification/src/main/resources/application.yml:144`

## 边界清单

- 本篇讨论的是“技术栈承担什么职责”，不是逐一做中间件源码分析；Nacos、RocketMQ、Redis、ES 自身实现细节不在本文展开。
- “为什么选择这组组件”在本文主要依据当前代码与配置承担的职责来解释，不等于项目最初设计者只有这一种选型路径。
- 对 SkyWalking、Prometheus、ES 日志链路的描述，当前以现有配置和交接记录中的运行经验为主，若要做运行态强结论，后续仍需补原始 trace、指标和日志现场。
- `ai-app`、`ai-mcp`、`ai-tools` 继续排除在本卷主分析线之外。

## 这篇解决了什么，还留下什么问题

这篇先解决了三个问题：

- `my-xhs` 的技术栈不是装饰性堆砌，而是逐层接住不同业务难题。
- 入口、发现、存储、缓存、消息、搜索、调度、观测各有明确分工。
- 一旦系统出故障，基础设施边界往往就是业务能力首先断裂的地方。

到这里，`00-overview-architecture` 这个目录的四篇总览就基本闭环了：

- `01-service-topology.md` 讲清了服务怎样连起来。
- `02-business-domains.md` 讲清了边界为什么这样切。
- `03-data-flow.md` 讲清了数据如何穿过这些边界。
- `04-technology-stack.md` 讲清了这些边界和流动为什么需要当前这组基础设施托住。

下一步就该离开总览，进入第一条真正的业务主链：`03-product-sku-catalog/01-spu-sku-model.md`，先把商品域的主数据模型立住。