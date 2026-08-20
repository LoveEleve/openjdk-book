# 01 MySQL Sharding：为什么这套订单库不是“多建几张表”这么简单

从 `08-gateway-security-observability/` 这一组转到 `09-data-model-storage/`，读者最容易带着的一个问题，其实并不是“ShardingSphere 怎么配”，而是更贴近真实业务的一句：前面写了那么多订单、支付、事务消息、Gateway 和可观测性，为什么现在还要专门把 MySQL 分库分表拎出来写一篇？

答案很直接。因为到目前为止，交易主链里已经反复暴露出一个事实：`my-xhs` 的订单域不是建在一张单表上，也不是简单把订单、明细、快照、本地消息、事件流全塞进一个库就结束了。它有一套明确的 ShardingSphere 分片拓扑：`4` 个逻辑数据源 × 每库 `4` 张物理表，共 `16` 个实际节点；同时还故意把 `t_order_no_mapping` 放在独立公共库，把 `t_payment` 放在独立支付库，再用 `JdbcTemplate` 绕开 ShardingSphere 主路由。这意味着它解决的根本不是“SQL 写到哪张表”这么浅的问题，而是：**当订单域必须同时兼顾用户维度路由、订单号反查、支付侧旁路查询、本地消息一致性和后续服务拆分时，数据布局到底该怎样切，哪些表该跟着分，哪些表反而不能跟着分。**

如果不把这一层专门拆开，前面那些交易文档就会留下两个很大的理解空洞。第一，读者会知道订单服务“用了 ShardingSphere”，却不知道为什么按 `orderNo` 裸查订单会查不到，为什么明明叫 `my_xhs_order` 的库里没有 `t_order` 主表，为什么有些查询必须显式带 `userId` 才能命中正确分片。第二，读者会知道订单服务还有 `OrderNoMappingRepository`、`PaymentRepository` 这些看起来绕开主数据源的仓储类，却很难一下子看明白：这到底是临时权宜之计，还是这套分片架构本来就故意把“适合按 `user_id` 扩展的表”和“不适合按 `user_id` 扩展的表”拆开处理。

本篇就专门把这套 MySQL 分片链收出来。它会先回答最直觉的问题：为什么订单域要按 `user_id` 走 `4×4` 分片，而不是一张大表或只按库不按表。然后再往后推：绑定表为什么必须一起分、`t_order_no_mapping` 为什么要作为公共旁路库存在、`t_payment` 为什么在订单服务里反而不能走 ShardingSphere、以及 `ReadWriteRoutingDataSource` 这一套与订单分片为什么不是一回事。最后还会用真实误判和真实排障案例，把“表不存在”“订单查不到”“读写分离应不应该叠在分片之上”这几类最容易讲混的点收口。

## 先给结论：这套分片的核心不是“多 16 张表”，而是“围绕 `user_id` 把订单主链和旁路查询主动拆开”

先别急着看 YAML，先把本篇最重要的人话结论钉住：`my-xhs-order` 的 MySQL 分片，核心并不是“4 库 × 4 表看起来很大”，而是它做了一个非常明确的领域切分——**凡是天然围绕 `user_id` 访问、且必须在订单主事务里一起演化的表，跟着订单主链一起按 `user_id` 分片；凡是不适合按 `user_id` 访问、或者承担跨分片定位作用的表，则被主动剥离到独立库。**

这一刀切下去，订单域就被分成了两类数据。

第一类是必须跟着订单主链一起路由的数据：`t_order`、`t_order_item`、`t_local_message`、`t_order_snapshot`、`t_order_event`。它们都出现在同一份 `sharding-config.yaml` 的 `tables` 段里，共享数据库分片策略、表分片策略和绑定表关系。换句话说，系统假设这些数据在绝大多数核心场景下都应沿着同一条 `user_id` 维度被路由到同一个物理库 / 物理表组合。`my-xhs-order/src/main/resources/sharding-config.yaml:71`

第二类是故意不进这条主路由的数据：`t_order_no_mapping` 和 `t_payment`。前者存放在公共库 `my_xhs_order` 中，只负责“给订单号反查出 `user_id` 与 `order_id`”；后者存放在独立支付库 `my_xhs_payment` 中，用单独的 Hikari 数据源与 `JdbcTemplate` 操作。它们都不是“分片漏配的边角料”，而是这套架构主动保留的旁路。`my-xhs-order/src/main/java/com/myxhs/order/repository/OrderNoMappingRepository.java:13` `my-xhs-order/src/main/java/com/myxhs/order/repository/PaymentRepository.java:13`

所以如果把这套设计讲成“订单服务有 16 张表”，你只讲到了表象；真正的设计意图是：**用 `user_id` 保证订单主链写放大后仍然沿一个稳定维度扩展，同时承认 `orderNo` 反查与支付查询不适合顺着这条维度走，于是为它们单独开旁路。**

## 直觉方案为什么不够：单表、只分库、不设旁路表都会在订单域里撞墙

### 失败方案一：一张大单表，订单、明细、消息、事件全放一起

如果完全不考虑分片，最直觉的设计就是：订单主表一张、明细一张、本地消息一张、快照一张、事件一张，全放在同一个业务库里，靠主键索引和普通二级索引扛住增长。

这个方案在业务早期当然最简单，甚至能让很多跨表查询显得很自然。但对 `my-xhs` 这种已经明确走交易主链、事务消息、事件流和后续履约扩展的系统来说，它的问题非常明确：订单域天然会沿用户维度和交易时间持续增长，而订单主表、明细表、本地消息表和事件流表又会一起放大。只要还希望把“同一笔订单的主数据、明细、快照、消息、事件”收在一条本地事务范围内，单表方案最终就会把所有写热点、索引膨胀和维护成本集中在同一套表上。

`my-xhs` 这里没有在正文里做大规模性能压测数字，但它已经用数据布局表达了态度：订单域不打算把增长寄托在一张主表的横向索引优化上，而是从一开始就承认“订单主链要水平切”。ShardingSphere 的配置注释写得非常清楚：开发环境是在同一 MySQL 实例上用 4 个 database 模拟分库，生产只需把 JDBC URL 指向不同实例就能水平扩展。也就是说，当前 `4×4` 更像是拓扑形态的先验表达，而不是性能极限到了才被迫拆。`my-xhs-order/src/main/resources/sharding-config.yaml:4`

### 失败方案二：只按库分，不按表分

第二个看起来更节制的方案是：按 `user_id % 4` 把订单分到四个库，但每个库里保留一张 `t_order`、一张 `t_order_item`、一张 `t_local_message`。这样既有分库，又不用再解释那么多表后缀。

这个方案比单表前进一步，但在 `my-xhs` 这种拓扑里仍然不够。原因很简单：如果每个库内部只保留一张大表，那随着业务量继续增长，单库表的体量仍然会不断扩大；并且所有“同库内的大表热点、索引宽度、冷热数据混杂”问题都还在，只是从一张表变成了四张更大的表。

`my-xhs` 选择的不是“只分库”，而是“库路由与表路由一起分”。库路由规则是 `user_id % 4 -> ds0..ds3`；表路由规则是 `(user_id / 4) % 4 -> t_xxx_0..3`。它等于把同一个 `user_id` 维度进一步展开成“先选库，再选表”的两层拓扑，使每个逻辑表最终落到 `16` 个物理节点上。`my-xhs-order/src/main/resources/sharding-config.yaml:151`

这里最重要的不是公式本身，而是它表达的扩展姿态：作者不打算让“进入某个库之后的单表继续无限长大”，而是明确要求表级别也跟着一起切。这就是为什么文章不能只写“ShardingSphere 做了分库分表”，还得把这两层路由公式拆出来讲清。

### 失败方案三：所有查询都强迫走分片主路由，不设 `orderNo` 旁路表

再进一步，还有一种很容易被架构洁癖推崇的方案：既然都分片了，那就让所有查询都遵守这套主路由逻辑，不要再额外引入旁路表和独立库。尤其是 `orderNo` 这种字段，完全可以靠二级索引或全库广播查询去查。

这个想法在文档里最容易被写成“架构更纯粹”，但在 `my-xhs` 的订单域里恰好不实用。原因在于，订单号是非常典型的跨域识别符：客服查单、支付回调、外部系统通知，都天然更容易拿到 `orderNo`，却未必先知道 `user_id`。而 ShardingSphere 的主路由维度又明确是 `user_id`。如果没有旁路映射表，你就会经常陷入一种尴尬：调用方给了订单号，但系统必须先在多个分片上广播或猜测性查询，才能知道这条订单到底在哪。

`my-xhs` 的解法非常明确：专门建 `t_order_no_mapping`，把 `order_no -> user_id + order_id` 存在公共库 `my_xhs_order` 里。`OrderNoMappingRepository` 的类注释就写明了它的职责：该表只负责通过订单号反查 `user_id`，并且故意不走 ShardingSphere，而是使用独立的 `mappingJdbcTemplate`。`my-xhs-order/src/main/java/com/myxhs/order/repository/OrderNoMappingRepository.java:13`

这就意味着系统承认一件很现实的事：**并不是所有订单域查询都适合强迫走 `user_id` 主路由。** 对于 `orderNo` 这种天然外部键，更划算的办法是先走一张极轻的映射旁路，再回到正确分片。这个旁路不是破坏分片架构，而是在降低分片架构对外部调用方的认知负担。

## 先画总图：订单域的 MySQL 拓扑到底长什么样

先把拓扑用文字图立住，后面再回到每条实现细节：

```text
订单主分片（ShardingSphere 数据源）
  ds0 -> my_xhs_order_0
  ds1 -> my_xhs_order_1
  ds2 -> my_xhs_order_2
  ds3 -> my_xhs_order_3

每个分片库内都有 5 组分表：
  t_order_0..3
  t_order_item_0..3
  t_local_message_0..3
  t_order_snapshot_0..3
  t_order_event_0..3

路由规则：
  database = user_id % 4
  table    = (user_id / 4) % 4

旁路 / 非分片数据源：
  my_xhs_order      -> t_order_no_mapping（订单号映射表）
  my_xhs_payment    -> t_payment（支付记录表）
```

这张图里最重要的不是库名和表名数量，而是读者要先记住三件事。

第一，订单主链不是只有一张 `t_order` 表，而是五类表一起分。订单主表、明细、本地消息、快照、事件流都跟着 `user_id` 跑同一套分片逻辑。第二，分片的主维度是 `user_id`，不是 `orderNo`、`orderId`、`paymentNo`。第三，系统故意保留了两个旁路：一个给订单号定位，一个给支付记录查询。没有这两个旁路，很多业务入口根本不适合直接命中主分片。

这也是为什么前面那些“表不存在”“订单查不到”的误判会频繁发生——因为如果没有先建立这张图，你天然就会拿单库单表的直觉去理解一个本来就不是单库单表的订单域。

## 主分片链：为什么 `t_order`、`t_order_item`、`t_local_message`、`t_order_snapshot`、`t_order_event` 必须一起分

`sharding-config.yaml` 里最值得读的并不是 `t_order` 一张表，而是 `tables:` 下面列出的五张逻辑表：

- `t_order`
- `t_order_item`
- `t_local_message`
- `t_order_snapshot`
- `t_order_event`

它们全部共享相同的数据库分片策略 `db-inline`，也全部共享各自基于 `user_id` 的表分片策略。`my-xhs-order/src/main/resources/sharding-config.yaml:73`

为什么这五张表必须一起分？因为它们本质上对应的是同一条订单事务链的五种形态。

- `t_order` 是订单主状态机
- `t_order_item` 是明细展开
- `t_local_message` 是本地消息 / Outbox 语义
- `t_order_snapshot` 是下单时点的快照
- `t_order_event` 是事件流 / Event Sourcing 衍生层

如果这些表不跟着一起分，就会立刻出现两类问题。第一类是同一笔订单的本地事务边界被拆散：订单主表写在一个地方，本地消息或快照落在另一个地方，最终你反而需要跨分片再做一致性编排。第二类是订单链上的关联查询会不断退化成跨库跨表广播，尤其是主表、明细、快照、事件流并读时。

`my-xhs` 这里还额外做了一步：把这五张表声明为 `bindingTables`。这一步的文字解释非常关键，因为它说的不是“为了配置完整”，而是“保证关联查询不产生笛卡尔积”。换句话说，作者已经预判到这些表会经常按相同分片键一起被访问，因此要让 ShardingSphere 明确知道：只要 `user_id` 一样，它们就应该沿着同一套路由落到相同库 / 表后缀。`my-xhs-order/src/main/resources/sharding-config.yaml:145`

这就是为什么本篇不能把分片只讲成 `t_order` 一张表的故事。真正被设计出来的是**整个订单主链的一组绑定表拓扑**。

## 路由公式为什么选 `user_id`，而不是 `orderNo` 或 `orderId`

到这里读者通常会继续追问：为什么偏偏是 `user_id`？订单明明也有 `orderNo`、`id`、甚至支付侧还有 `paymentNo`，为什么不用这些字段分？

源码配置已经给出明确事实：数据库分片键是 `user_id`，表分片键也是 `user_id`。库路由规则是 `user_id % 4`；表路由规则是 `(user_id.intdiv(4)) % 4`。`my-xhs-order/src/main/resources/sharding-config.yaml:151`

这背后更贴近业务的人话解释是：`my-xhs` 把订单域的主访问模式理解成“用户视角下的订单集合”，而不是“随机分布的一堆订单号”。用户会查自己的订单列表、自己的订单详情、自己的退款进度，客服或支付回调再通过映射旁路进来。也就是说，**系统把“按用户维度收束订单主链”视为一等公民，而把订单号、支付号视为需要旁路适配的跨域外键。**

如果改用 `orderNo` 分片，随机性当然会更好一些，但用户维度的本地聚合就会变差；如果改用 `orderId` 雪花主键分片，则业务上“同一用户的订单天然散开”，订单列表、事件回放、快照并读都更难沿一条稳定主路由收束。`my-xhs` 最终选 `user_id`，本质上是在吞下“订单号反查要多一步映射”的代价，换取用户主视角下更稳定的主分片局部性。

这也是为什么订单服务里会不断强调“查询必须带 `userId`”。`OrderService.isOrderOwner()` 上就直接写着注释：使用带 `userId` 的查询，确保 ShardingSphere 路由到正确分片。代码本身也强制在条件里同时 `eq(Order::getId, orderId)` 和 `eq(Order::getUserId, userId)`。`my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:1058`

这不是多写一个 where 条件的代码洁癖，而是在顺着分片主维度保护路由可判定性。少了 `userId`，就很容易从“精确命中一个物理节点”退化成“ShardingSphere 需要扩大路由面，甚至触发全路由”。

## `t_order_no_mapping` 为什么必须独立存在：它不是脏补丁，而是给 `orderNo` 世界开的旁路

如果把 `user_id` 作为主分片键，一个特别现实的问题就会马上出现：外部世界很多时候拿到的是 `orderNo`，而不是 `user_id`。这在支付回调、客服工单、外部系统补偿、甚至一些管理查询里都很常见。

`my-xhs` 没有强迫所有调用方都先知道用户维度再进订单域，而是专门留了一张 `t_order_no_mapping`。它存放在公共库 `my_xhs_order` 中，只负责最小化的映射：`order_no -> user_id + order_id`。`OrderNoMappingRepository` 也非常克制，只提供 `insert`、`selectByOrderNo`、`selectByOrderId` 三个操作，而且全部用独立的 `mappingJdbcTemplate` 去打，不让 ShardingSphere 参与。`my-xhs-order/src/main/java/com/myxhs/order/repository/OrderNoMappingRepository.java:39`

这张表的价值，不在于它“多了一个映射关系”，而在于它把 `orderNo` 这个外部键世界和 `user_id` 这个主分片世界接了起来。`OrderService.getOrderByOrderNo()` 的逻辑就完全沿着这条旁路走：先查映射表拿到 `user_id` 与 `order_id`，校验请求用户是不是 owner，再回到 `getOrderDetail(userId, orderId)` 走正确分片。`my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:1040`

而且这条旁路现在不只是源码推断，历史业务文档和测试记录也都在重复印证同一件事。`docs/test-2/business-docs/order/D04-order-by-no.md` 直接把这条接口写成“orderNo 非分片键 → 走映射表 `t_order_no_mapping` → 获取 userId → 分库定位”；而 `docs/test-2/service-analysis/09-order/02-order-test-record.md` 又明确记了一条更硬的运行态经验：支付/退款回调端点即使没有 `X-User-Id`，也仍然是通过 `t_order_no_mapping` 反查 userId 来完成分片路由。也就是说，映射表在这里不是边缘补丁，而是已经进入真实交易链与回调链的正式基础设施。`docs/test-2/business-docs/order/D04-order-by-no.md:5` `docs/test-2/service-analysis/09-order/02-order-test-record.md:310`

如果没有这张映射表，订单号查询要么广播到所有分片，要么把订单号本身也做成另一个显式路由维度，复杂度都会陡增。也就是说，`t_order_no_mapping` 不是“因为 ShardingSphere 不够聪明，只好打补丁”，而是作者有意识地给“非主分片键世界”预留了入口转换层。

这也正好解释了 `FINAL-HANDOFF.md` 里那条曾被撤回的误判：有人一度以为 `my_xhs_order` 库缺 `t_order` 表是设计错误，后来才确认那恰恰是正常设计；至少就当前已核到的订单服务实现与交接材料而言，这个公共库承担的就是 `t_order_no_mapping` 这类旁路映射职责，而不是订单主表落点。`docs/FINAL-HANDOFF.md:176`

## `t_payment` 为什么故意不进 ShardingSphere：支付查询维度和订单主分片不是一回事

另一个很容易被误解成“架构不统一”的点，是 `PaymentRepository` 明明在订单服务里，却不走 ShardingSphere，而是单独连 `my_xhs_payment`。

如果只从“统一技术栈”出发，最直觉的想法当然是：既然订单都分片了，支付表是不是也应该跟着订单一起分，甚至直接塞进同一套分片拓扑里？

`PaymentDataSourceConfig` 的类注释恰好给了非常清楚的反答案：支付表不走分片，原因有三条——它属于支付域、未来本来就会拆成独立支付服务；它的主要查询维度是 `order_id / payment_no`，不适合用 `user_id` 分片；而且支付表数据量远小于订单表，当前没必要为它引入同样的分片复杂度。`my-xhs-order/src/main/java/com/myxhs/order/config/PaymentDataSourceConfig.java:13`

这几条理由合在一起，说明了一个非常重要的架构判断：**数据是否分片，不取决于“是不是交易链的一部分”，而取决于它的主访问模式是否和主分片维度一致。** 订单主链天然围绕 `user_id` 收束，所以适合跟着订单一起切；支付记录反而更像一个会逐步外移到支付域的独立表，继续强绑在订单主分片里只会让查询维度和服务边界都变得更别扭。

因此 `PaymentRepository` 故意用独立的 `paymentJdbcTemplate` 去查 `t_payment`，并明确写着“避免被 ShardingSphere 拦截路由到分片库”。这里不是架构走漏，而是刻意保留支付域的数据自治。`my-xhs-order/src/main/java/com/myxhs/order/repository/PaymentRepository.java:13`

## 订单分片和读写分离为什么不是一回事，甚至当前故意排除了那套通用路由配置

`my-xhs` 还有一个特别容易被讲混的点：common 模块里明明有 `ReadWriteRoutingDataSourceConfig` 这套路由配置，为什么订单服务反而在 `OrderApplication` 里显式把它从 `ComponentScan` 里排除了？`my-xhs-order/src/main/java/com/myxhs/order/OrderApplication.java:27`

这里如果不拆开讲，读者很容易产生一个机械直觉：订单服务既然已经有分片，那再叠一层 master/slave 读写分离不是更好吗？

但源码和评审材料给出的现实恰恰说明：**订单分片与通用读写分离不是同一层问题，当前订单服务甚至刻意不让那套通用读写路由生效。**

- `ReadWriteRoutingDataSourceConfig` 只在 `spring.datasource.readwrite.enabled=true` 时启用，目标是给普通主从结构切 master/slave。`my-xhs-common/src/main/java/com/myxhs/common/config/ReadWriteRoutingDataSourceConfig.java:18`
- 订单服务的主数据源则完全由 `ShardingSphereDataSourceConfig` 手工创建，直接加载 `sharding-config.yaml`，并以它作为 `@Primary` 数据源。`my-xhs-order/src/main/java/com/myxhs/order/config/ShardingSphereDataSourceConfig.java:38`
- `OrderApplication` 还专门把 `ReadWriteRoutingDataSourceConfig.class` 从扫描中排除，避免这两套路由栈彼此打架。`my-xhs-order/src/main/java/com/myxhs/order/OrderApplication.java:27`

这背后的业务解释很重要。订单主链的 SQL 已经先要经过 “`user_id` 决定哪一个分片库、哪一张物理表” 这一层路由。若再在其外层粗暴叠一个普通 master/slave `AbstractRoutingDataSource`，不仅路由链复杂度暴涨，还会让“同一笔订单的局部一致性、事务消息、快照与事件流”面对更复杂的读写时序。评审材料里也明确点出了现状：order 当前用 ShardingSphere 直连 3306，`sharding-config.yaml` 没有 `readwrite-splitting` 规则；要不要以后再叠读写分离，是后续权衡，不是当前主路径。`docs/test-2/review-fresh/review-production-config.md:521`

所以这里最重要的结论不是“订单服务没用读写分离”，而是：**作者有意识地把“先把分片拓扑走顺”放在“再叠通用读写分离”之前。**

## `ShardingSphereDataSourceConfig` 真正干了什么：不是自动配置小优化，而是整条主数据源的接管

`ShardingSphereDataSourceConfig` 里最容易被一眼略过去的注释，其实非常关键：Spring Boot 3.2.5 的 `DataSourceAutoConfiguration` 无法可靠识别 `jdbc:shardingsphere:` 协议，因此订单服务不走自动配置，而是手工读取 YAML，动态替换 `worker-id`，再通过 `YamlShardingSphereDataSourceFactory.createDataSource(...)` 创建主数据源。`my-xhs-order/src/main/java/com/myxhs/order/config/ShardingSphereDataSourceConfig.java:21`

这件事的重要性在于，它说明 ShardingSphere 在这里并不是“多加一个 starter 就完事”的附加层，而是订单服务的主数据源就是被它整条接管的。对应地：

- `DataSourceAutoConfiguration` 被排除
- `MybatisPlusAutoConfiguration` 也被排除
- `SqlSessionFactory` 手工创建
- 默认 `JdbcTemplate` 也明确绑定这套分片数据源

`my-xhs-order/src/main/java/com/myxhs/order/OrderApplication.java:21` `my-xhs-order/src/main/java/com/myxhs/order/config/ShardingSphereDataSourceConfig.java:59`

对读者来说，这一步特别重要，因为它把“数据库分片”从一个纯配置文件概念，变成了“订单服务启动期就决定的主数据源装配方式”。只有理解到这点，后面才能明白为什么映射表库、支付库要单独再开 `JdbcTemplate`，而不是顺手让它们也混进同一套自动注入的数据源体系里。

这里还值得再补一句工程和分布式代价：`ShardingSphereDataSourceConfig` 不只是“手工创建数据源”，它还把 `worker-id` 解析策略一起拉进了启动链，见 `my-xhs-order/src/main/java/com/myxhs/order/config/ShardingSphereDataSourceConfig.java:28` 到 `:33` 与 `:81` 到 `:116`。也就是说，分片库里的雪花主键不是一个天然全局存在的基础设施，而是要在每个实例启动时根据环境变量、系统属性或本机 IP 推导出一个不会冲突的 worker-id。

这说明分片方案在当前实现里还额外承担了一层工程问题：**主键生成器本身也是启动配置与运行环境的一部分。** 如果 worker-id 解析错了，出问题的就不只是路由，而是整条订单/事件/本地消息链的 ID 空间。这种代价不会出现在“只看 YAML 分片规则”的阅读里，但它恰恰是分库分表在工程落地中最真实的一类复杂度。

## 真实故障与误判：为什么“`my_xhs_order` 库里没有 `t_order`”反而是正常设计

按照本卷方法论，这篇不能只讲拓扑，还必须落一个真实故障或误判案例。对于 MySQL 分片这一篇，最典型的就是 `FINAL-HANDOFF.md` 里那条被明确撤回的误判：`my_xhs_order` 数据库缺 `t_order` 表。

这个误判之所以有代表性，是因为它完美暴露了单库单表直觉怎样把分片系统看错。按普通业务系统的习惯，只要看到一个库名叫 `my_xhs_order`，就自然会期待里面有一张主表 `t_order`。可在 `my-xhs` 这里，真正的订单主表不是 `my_xhs_order.t_order`，而是散在 `my_xhs_order_0..3` 四个分库里的 `t_order_0..3` 十六个物理节点。公共库 `my_xhs_order` 留下来的，反而是 `t_order_no_mapping` 这种旁路表。`docs/FINAL-HANDOFF.md:176`

用方法论要求的五段式把这次误判收起来：

- 现象：排查者进入 `my_xhs_order` 库后看不到 `t_order`，误以为主表缺失
- 根因：把“公共库”错当成“主分片库”，沿用了单库单表思维
- 修复：回到 `sharding-config.yaml` 和实际分片库拓扑，确认主表真实落点是 `my_xhs_order_0..3.t_order_0..3`
- 验证：交接文档已明确记录该误判被撤回，主表全部存在
- 余波：以后任何“表不存在”“订单查不到”的排障，第一步都必须先确认自己是不是站在正确分片库和正确后缀表上

这类案例特别适合作为数据模型篇的故障例子，因为它不是代码 bug，而是**错误心智模型**导致的排障事故。对于分片系统来说，这种事故甚至比单条 SQL 写错更常见。

## 证据清单：本篇关键结论分别站在哪一层

L0 源码静态证据：

- `sharding-config.yaml` 明确声明了 `4` 个数据源、`5` 组逻辑表、`bindingTables`、库路由 `user_id % 4`、表路由 `(user_id.intdiv(4)) % 4`。`my-xhs-order/src/main/resources/sharding-config.yaml:13`
- `OrderNoMappingRepository` 与 `PaymentRepository` 都明确说明自己使用独立数据源，不走 ShardingSphere。`my-xhs-order/src/main/java/com/myxhs/order/repository/OrderNoMappingRepository.java:13` `my-xhs-order/src/main/java/com/myxhs/order/repository/PaymentRepository.java:13`
- `OrderService.getOrderByOrderNo()` 与 `isOrderOwner()` 直接体现了“订单号先走映射旁路、分片查询必须显式带 `userId`”的主路径。`my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:1047`
- `OrderApplication` 显式排除 `ReadWriteRoutingDataSourceConfig`，主数据源由 `ShardingSphereDataSourceConfig` 手工接管。`my-xhs-order/src/main/java/com/myxhs/order/OrderApplication.java:26`

L1 框架 / 语义证据：

- ShardingSphere 这里不是简单 DataSource 自动配置，而是手工读取 YAML 并创建主数据源，说明分片路由已深入到订单服务启动装配层。`my-xhs-order/src/main/java/com/myxhs/order/config/ShardingSphereDataSourceConfig.java:38`
- `bindingTables` 的存在意味着作者明确要求订单主表、明细、本地消息、快照、事件流在相同分片键下协同路由，避免关联查询退化成笛卡尔积或广播放大。`my-xhs-order/src/main/resources/sharding-config.yaml:145`
- 订单域故意不叠通用读写分离，说明“分片路由”与“master/slave 路由”在当前实现里被视作两层不同复杂度。`my-xhs-common/src/main/java/com/myxhs/common/config/ReadWriteRoutingDataSourceConfig.java:18`

L2 运行态证据：

- `HANDOFF.md` 已明确把 order 的核心能力写成“ShardingSphere 4×4 分片 + Event Sourcing + 事务消息”。`docs/HANDOFF.md:38`
- `FINAL-HANDOFF.md` 已明确撤回 “`my_xhs_order` 缺 `t_order`” 这一误判，确认主表实际散在四库十六表中。`docs/FINAL-HANDOFF.md:176`
- `docs/test-2/review-fresh/review-production-config.md` 已记录当前生产配置现状：order 走 ShardingSphere 直连 3306，尚未叠 `readwrite-splitting` 规则。`docs/test-2/review-fresh/review-production-config.md:521`

## 边界清单：哪些话现在能说，哪些还不能写满

第一，当前可以明确写出订单域已经实现 `4×4=16` 节点的 ShardingSphere 主拓扑，但不能把它写成“当前一定已经跨四台独立 MySQL 物理机部署”。从 YAML 看，当前开发 / 现有环境仍是在同一 MySQL 实例 `3306` 上用多 database 模拟分库，生产可扩到多实例只是架构预留。`my-xhs-order/src/main/resources/sharding-config.yaml:9`

第二，当前可以明确写出订单主链的五张逻辑表是绑定表并共享 `user_id` 路由，但不能把它写成“订单域所有数据都已纳入分片拓扑”。`t_order_no_mapping` 和 `t_payment` 恰恰是被故意留在分片外侧的旁路数据。

第三，当前可以明确写出订单服务没有启用通用读写分离，但不能直接写成“订单域永远不适合读写分离”。这里现在也能把证据再压实一层：一方面，`OrderApplication` 已显式把 `ReadWriteRoutingDataSourceConfig` 排除在扫描之外；另一方面，当前 `sharding-config.yaml` 只声明了 `!SHARDING` 规则，并没有看到 `readwrite-splitting` 这类规则段。因此更稳妥的说法是：当前实现优先保证分片主路由与交易一致性，未来是否叠加 `readwrite-splitting` 仍是另一个架构阶段的问题，而不是当前这套 YAML 已经具备但暂未打开的能力。`my-xhs-order/src/main/java/com/myxhs/order/OrderApplication.java:27` `my-xhs-order/src/main/resources/sharding-config.yaml:71`

第四，当前可以明确写出“查询必须带 `userId`”是这套分片设计的核心约束之一，但不能把它写成“任何不带 `userId` 的查询都完全不可实现”。`orderNo` 查询就是通过映射旁路实现的，只是那不再是直走主分片而已。

## 收网：这篇 MySQL 分库分表真正建立了什么

到这里可以回收开头的问题了。`my-xhs` 的 MySQL 分库分表不是“多建几张后缀表”的体力活，而是一套围绕 `user_id` 组织订单主链、同时为 `orderNo` 与支付查询保留旁路的主动数据布局。订单主表、明细、本地消息、快照、事件流之所以必须一起分，不是为了配置看起来完整，而是为了让交易主链在水平切分之后仍然保持本地事务和局部关联查询的可收束性；映射表与支付表之所以故意留在主分片外面，也不是不统一，而是因为它们的查询维度和服务边界本来就不该顺着 `user_id` 硬走。

从业务逻辑视角看，这套设计守住的是“用户视角下的订单主链”这一主访问模式；从工程视角看，它把 ShardingSphere 主数据源、公共旁路库、支付独立库、手工 `SqlSessionFactory` 与多套 `JdbcTemplate` 明确拆开；从分布式视角看，它用绑定表和稳定分片键换取局部一致性与扩展性，同时承认非主分片键查询必须借旁路表转译；从微服务视角看，它也为后续支付域进一步独立拆分预留了很清楚的数据库边界。

更重要的是，本篇也把一个特别容易被误判的事实钉住了：**在分片系统里，“表不存在”很多时候不是库坏了，而是你站错了库、拿错了分片键、带着单库单表的心智去看一套本来就不是单库单表的数据拓扑。**

下一篇如果继续沿 `09-data-model-storage/` 推进，最自然的顺序就是进入 `docs/openjdk/vol-xhs/09-data-model-storage/02-redis-strategy.md`，把前面交易链、Gateway、通知、搜索里反复出现的 Redis Sentinel、业务库 / 缓存库角色分工、Lua 原子语义和运行态陷阱统一收束。