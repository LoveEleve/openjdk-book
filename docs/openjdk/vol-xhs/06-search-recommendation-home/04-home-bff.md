# 首页 BFF 聚合

> 对应目录：`vol-xhs/06-search-recommendation-home/`
> 目标问题：为什么 `home` 不是一个薄转发层，而是一层主动管理并发聚合、降级、超时和返回形态的页面编排层？

## 一句话困惑

如果只看接口路径，`/api/home/feed`、`/api/home/note/{id}`、`/api/home/product/{spuId}`、`/api/home/user/{targetUserId}`、`/api/home/cart` 似乎只是在给前端提供一些更方便的接口封装。

于是最自然的误解就是：**`home` 不过是一个“把几个下游接口拼一下”的薄 BFF。**

但真正读完代码之后会发现，`home` 其实在做远不止“拼一下”这么简单的事：

- 它决定哪些下游可以并行、哪些必须分层聚合
- 它决定某个下游超时后整个页面是报错、降级还是部分字段兜底
- 它决定返回给前端的是本地真相、聚合视图，还是进一步加工过的 VO
- 它甚至决定一个页面请求是否应该释放 Tomcat 线程，进入异步聚合模式

这说明 `home` 不是薄代理，而是：**页面形态、下游编排和降级策略的集中控制层。**

但这里也要先把边界说清：当前 `home` 仍然是一个围绕已有页面接口做聚合和降级控制的轻量 BFF，它并没有进一步演化成独立前端渲染平台、GraphQL 网关或前后端通用编排平台。也就是说，本文讨论的是“页面聚合层”，不是在把它外推成更重的一类前端基础设施。
## 一句话答案

`my-xhs` 的 `home` 服务不是在“重复暴露下游接口”，而是在把多个域的读模型重新组织成页面级视图：它用独立线程池和 `CompletableFuture` 做并发编排，把商品详情、笔记详情、用户主页、购物车聚合和 Feed 流这些页面拆成多层子查询，再按不同字段的可降级程度组装结果。也就是说，BFF 在这里不是装饰层，而是专门负责“页面应该怎么看见后端世界”的编排层。

## 先建立最小心智模型

先把 `home` 这层的角色压缩成一句人话：

```text
它不拥有最多真相
但它决定前端能以什么形状、什么延迟、什么容错语义看见这些真相
```

`HomeController` 在 `my-xhs-home/src/main/java/com/myxhs/home/controller/HomeController.java:17` 到 `:25` 的类注释里，已经把这个边界讲得很清楚：

- 它是首页聚合接口（BFF 层）
- 核心职责是把多个下游数据并行聚合成完整 VO
- Controller 层返回 `CompletableFuture`
- 真正的聚合逻辑在 Service 层并行编排

这说明 `home` 一开始就不是按业务真相域来设计的，而是按**页面读模型和聚合执行模型**来设计的。

## 先推演第一个最直觉的失败方案：前端自己并发调所有下游接口

这是很多系统在没有 BFF 时会自然走上的路。

### 为什么这个方案很诱人

因为它看起来最少后端代码：

- 前端想要笔记详情，就自己调 note、user、counter、analytics、comment
- 想要商品详情，就自己调 product、inventory、counter
- 想要购物车页，就自己调 cart、inventory、coupon

从“少做一个服务”的角度看，这似乎很节省。

### 它会先坏在哪里

它会先坏在三个地方：

1. **页面协议碎片化**：前端不得不理解每个下游的响应差异。
2. **降级策略失控**：哪个下游失败该整体报错，哪个字段可以置空，前端很难一致处理。
3. **并发编排散落**：并发数量、超时窗口、字段依赖关系全都跑到前端去，既难统一，也难观测。

从当前实现把页面编排、降级语义和异步聚合统一收在 `home` 层的选择来看，系统并不打算让前端承担这些复杂度，这正是 `home` 存在的根本原因。

## 再推演第二个失败方案：BFF 只做串行转发，不主动管理并发与降级

即使接受了 BFF，另一种也很常见的误解是：BFF 只要按顺序调几个下游，再把结果拼起来就够了。

### 为什么这个方案也很诱人

因为它仍然比前端直调集中了一层：

- 前端简单了
- 后端也有统一入口
- 看起来已经比没有 BFF 好很多

### 它为什么在当前系统里仍然不够

因为页面聚合真正难的不是“调用几个服务”，而是：

- 哪些服务能并行
- 哪些服务要等上一层结果出来后再继续
- 哪些字段丢了还能返回页面
- 哪些核心数据一旦不可用就必须整体失败

如果 BFF 只是串行转发，那么：

- 下游越多，页面越慢
- 一个弱依赖接口变慢，会无差别拖垮整个页面
- 页面字段的容错语义无法被显式表达

`my-xhs` 当前实现恰恰不是这样。几乎每个聚合服务都显式写了：

- 第 1 层并行什么
- 第 2 层依赖什么
- 哪些字段超时后如何降级

这说明 BFF 在这里已经是**执行模型和故障模型的承载层**，而不是简单转发器。

## 第一步：Controller 层已经主动选择了异步化，而不是同步阻塞拼装

`HomeController` 的五个主入口几乎都直接返回 `CompletableFuture`：

- Feed：`my-xhs-home/src/main/java/com/myxhs/home/controller/HomeController.java:46` 到 `:64`
- 笔记详情：`my-xhs-home/src/main/java/com/myxhs/home/controller/HomeController.java:69` 到 `:90`
- 商品详情：`my-xhs-home/src/main/java/com/myxhs/home/controller/HomeController.java:95` 到 `:114`
- 用户主页：`my-xhs-home/src/main/java/com/myxhs/home/controller/HomeController.java:119` 到 `:140`
- 购物车聚合：`my-xhs-home/src/main/java/com/myxhs/home/controller/HomeController.java:145` 到 `:160`

这说明当前实现从入口层就已经明确：**聚合请求不应该长时间占着 Tomcat 线程同步等待所有下游返回。**

这也是为什么配置文件里专门有 `home.aggregator` 线程池，见 `my-xhs-home/src/main/resources/application.yml:129` 到 `:136`。BFF 在这里不仅管理“调谁”，还管理“用什么资源模型调谁”。

## 第二步：不同页面的聚合层次并不一样，BFF 不是统一模板拼装器

一个很容易被低估的事实是：当前 `home` 并不是对所有页面用同一套聚合模板。

### 笔记详情：两层并行聚合

`NoteAggService` 在 `my-xhs-home/src/main/java/com/myxhs/home/service/NoteAggService.java:24` 到 `:29` 明确写了：

- 第 1 层并行：笔记详情 + 点赞状态 + 收藏状态 + 计数
- 第 2 层再依赖 `authorId`，去取作者信息、关注关系、热门评论

这说明笔记详情不是“把五个接口一起发出去”，而是一个带依赖拓扑的两层图。

### 用户主页：单层并行聚合

`UserProfileAggService` 在 `my-xhs-home/src/main/java/com/myxhs/home/service/UserProfileAggService.java:24` 到 `:31` 又明确写成了另一种形态：

- 用户信息
- 计数
- 关注关系
- 用户笔记列表

这些数据源在当前实现里没有依赖关系，所以直接单层并行。

### Feed 流：先从 Redis 拿 ID，再分层补视图

`FeedService` 又是第三种模式。它先从 Redis 收件箱/发件箱取 noteId 列表，见 `my-xhs-home/src/main/java/com/myxhs/home/service/FeedService.java:31` 到 `:40` 和 `:78` 到 `:130`；然后才进入两层聚合：

- 第 1 层：笔记详情 + 点赞状态 + 未读数
- 第 2 层：作者信息 + 计数

也就是说，Feed 聚合不是直接围绕下游服务展开，而是先围绕 ID 流展开。

### 购物车聚合：先拿购物车和券，再补库存

`CartAggService` 也写了两层：

- 第 1 层：购物车列表 + 可用优惠券，见 `my-xhs-home/src/main/java/com/myxhs/home/service/CartAggService.java:25` 到 `:33`
- 第 2 层：按 `skuId` 再查库存，见 `my-xhs-home/src/main/java/com/myxhs/home/service/CartAggService.java:112` 到 `:170`

这说明 BFF 并不是一个统一模板引擎，而是：**不同页面各自拥有不同的聚合拓扑。**

## 第三步：降级策略说明 BFF 不只决定“怎么查”，还决定“出错时页面还能不能成立”

这是当前实现里最能体现 BFF 价值的一点。

### Controller 层只兜总失败

在 `HomeController` 里，各个入口都统一 catch `DownstreamUnavailableException` 并返回 `SERVICE_UNAVAILABLE`，这说明 Controller 主要负责承接“关键下游整体不可用”的失败语义。

### Service 层决定哪些字段可降级

真正更有意思的在各个聚合 Service 内部。

#### 笔记详情

`NoteAggService` 在 `my-xhs-home/src/main/java/com/myxhs/home/service/NoteAggService.java:126` 到 `:137` 中，把 content 服务视为强依赖：

- 内容服务不可用 → 整个笔记详情失败
- 笔记数据为空 → 视为笔记不存在

但点赞、收藏、计数、评论等字段又都允许默认值降级。

#### 用户主页

`UserProfileAggService` 也采用同样的模式：

- 用户服务不可用 → 主页整体失败，见 `my-xhs-home/src/main/java/com/myxhs/home/service/UserProfileAggService.java:182` 到 `:188`
- 其他服务不可用 → 计数、关系、笔记列表降级为空值或默认值

#### 购物车聚合

`CartAggService` 则把购物车本体视为强依赖：

- 购物车服务不可用 → 整个购物车页失败，见 `my-xhs-home/src/main/java/com/myxhs/home/service/CartAggService.java:87` 到 `:89`
- 优惠券服务不可用 → 只让可用券数降为 0，见 `my-xhs-home/src/main/java/com/myxhs/home/service/CartAggService.java:66` 到 `:76`
- 库存服务不可用 → 单个 SKU 库存降级，见 `my-xhs-home/src/main/java/com/myxhs/home/service/CartAggService.java:151` 到 `:170`

这说明当前 BFF 真正做的是：**把页面字段按“强依赖 / 弱依赖”重新分类，并把故障语义统一编码进后端。**

## 第四步：BFF 实际还在管理一套资源模型，而不是只在管理字段拼装

如果 BFF 只是“把几个下游结果拼起来”，它其实不一定需要专门的线程池分层和嵌套并发隔离；当前实现之所以额外引入 `aggregatorPool` 和 `batchFeignPool`，说明作者已经把**跨服务扇出成本**当成了 BFF 的核心工程问题。

`AggregatorThreadPoolConfig` 在 `my-xhs-home/src/main/java/com/myxhs/home/config/AggregatorThreadPoolConfig.java:13` 到 `:29` 先明确否定了直接用 `ForkJoinPool.commonPool()` 的做法：

- commonPool 是全局共享的，下游超时会阻塞其他业务；
- 默认线程数更适合 CPU 型任务，不适合 Feign 这种 IO 密集聚合；
- BFF 需要精确控制核心线程、最大线程、队列容量和拒绝策略。

随后它又在 `my-xhs-home/src/main/java/com/myxhs/home/config/AggregatorThreadPoolConfig.java:61` 到 `:82` 额外拆出 `batchFeignPool`，并把原因写得非常直白：如果外层聚合任务和内层批量 Feign 子任务共用同一个线程池，高并发时很容易出现“外层任务把线程池占满、内层子任务反而永远拿不到线程”的嵌套 `CompletableFuture` 饥饿问题。

这说明 `home` 当前要解决的，不只是“哪些下游要并行”，还包括：

```text
一个页面请求被拆成多少个子请求
这些子请求该用几层线程池承接
超时发生时线程和队列会怎样退化
```

从工程视角看，这一层非常关键，因为它解释了为什么 BFF 的代价不只是多一次网络跳转，而是会把下游扇出、线程池饥饿、MDC 透传和调用超时都集中到自己身上。`AggregatorThreadPoolConfig` 甚至把 MDC 透传都写进了执行器包装层，见 `my-xhs-home/src/main/java/com/myxhs/home/config/AggregatorThreadPoolConfig.java:103` 到 `:163`，这说明 BFF 这里的资源模型已经不仅是性能问题，也是观测一致性问题。

## 第五步：BFF 返回的不是原始下游对象，而是页面视图对象

另一个很重要但容易被忽视的事实是：`home` 并不是把下游结果原样转发给前端。

以购物车聚合为例，`CartAggService` 最终返回的不是 cart 服务原始结构，而是 `CartAggVO`：

- 聚合后的商品项
- 选中数量
- 选中总金额
- 可用券数量和列表

它已经变成了页面视图对象，不再是任何单一服务自己的原始模型。

商品详情也是一个更直观的例子。`ProductDetailAggVO` 在 `my-xhs-home/src/main/java/com/myxhs/home/dto/ProductDetailAggVO.java:13` 到 `:20` 里，明确把自己的来源写成了：

- `product` 提供 `SPU` 详情和 `SKU` 列表
- `inventory` 提供各 `SKU` 库存
- `counter` 提供商品计数
- `content/search` 未来可提供关联笔记

而 `ProductAggService` 在 `my-xhs-home/src/main/java/com/myxhs/home/service/ProductAggService.java:128` 到 `:141` 中，最终把这些来源组装成一个页面专用对象。它不是任何单一服务自己的原始模型，而是 BFF 视角下重新整理过的页面对象。

同样，笔记详情、商品详情、用户主页都各自有自己的 AggVO。这说明 BFF 当前在做一件很明确的事：**统一前端消费模型。**

也就是说，下游服务负责讲自己的真相，BFF 负责把多个真相翻译成页面语言。

## 第五步：线程池和超时窗口说明 BFF 还在管理资源，而不只是管理字段

如果 BFF 只是做模型拼装，它并不一定需要专门的聚合线程池和每层超时。

但当前实现已经把资源模型也纳入了 BFF 设计：

- `home.aggregator` 线程池在配置文件中显式存在，见 `my-xhs-home/src/main/resources/application.yml:129` 到 `:136`
- 各聚合服务都手工设置了 `CompletableFuture.allOf(...).get(timeout, TimeUnit...)` 的时间窗口

这说明 BFF 不只是“业务层聚合”，还承担了另一层职责：

```text
页面请求应该花多少资源
哪一层聚合能等多久
某个下游慢了时是整体失败还是部分降级
```

这就是为什么说它不是薄代理，而是主动管理并发和超时的页面编排层。

## BFF 最容易被讲漏的微服务问题：它其实在替前端定义“错误语义”

BFF 之所以不是薄层，另一个很关键的原因是：它不仅在决定“怎么查”，还在决定“查失败以后前端应该把这件事理解成什么”。

这一点在历史问题里曾明确暴露过。`review-1` 的 `F-039` 就专门指出：如果 BFF 把下游不可用错误包装成“对象不存在”或“空购物车”，系统级依赖故障就会被伪装成业务语义，用户和测试都会被误导。当前这些聚合服务之所以把：

- 商品/用户/购物车本体视为强依赖；
- 库存/计数/关系/可用券视为可降级字段；
- `DownstreamUnavailableException` 继续向上抛给 Controller 做统一 503；

本质上就是在防止这种“错误语义漂移”。

所以在微服务视角下，`home` 不只是把多个读模型收成一个页面，而是在主动回答：

```text
下游失败了
前端看到的应该是“没有数据”
还是“这个页面当前不成立”
```

这比单纯并发聚合更值钱，因为它决定了依赖故障会不会被伪装成业务真相。

## 真实故障案例：为什么首页/详情页最危险的不是某个下游挂了，而是 BFF 不知道谁可以降级、谁不能降级

BFF 层最容易被低估的风险，不是调用失败本身，而是失败语义没被建模。

### 现象

如果 BFF 不区分强依赖和弱依赖，那么一旦某个下游超时，系统就会在两个极端里摆动：

- 要么一个小字段失败就把整页打成 500
- 要么所有字段都强行默认值，页面看起来还能返回，但关键内容其实已经失真

### 根因

根因不是“某个服务慢了”，而是 BFF 没有明确定义：

- 哪些字段是页面成立的前提
- 哪些字段只是增强信息
- 哪些超时要整体失败
- 哪些超时只该局部降级

### 修复

当前实现正是通过各聚合 Service 把这层语义硬编码下来：

- content/user/购物车本体等关键源失败 → 直接 fail
- 库存/计数/关系/优惠券等弱依赖失败 → 默认值降级

### 验证

验证 BFF 不能只测“接口 200 不 200”，而要测：

- 某个下游失败时整页是否仍能成立
- 关键字段缺失时是否会被错误吞掉
- 聚合超时后是否会出现字段级默认值和整体失败语义错位

### 余波

这个案例说明，**BFF 最重要的价值不只是并发聚合，而是把“页面怎样优雅地失败”这件事从前端拉回后端统一控制。**

## 这一篇先收束成一张总图

```text
前端页面请求
  → HomeController 异步入口
    → 各聚合服务按页面类型决定拓扑
       - 单层并行
       - 两层并行
       - 先取ID再补视图
    → 强依赖失败则整体 fail
    → 弱依赖失败则字段降级
    → 返回页面级 AggVO
```

这里最重要的不是“调了多少下游”，而是三条判断：

1. BFF 不是薄转发层，而是页面读模型和故障语义的集中控制层。
2. 不同页面有不同的聚合拓扑，不能用统一模板想象它们。
3. 当前实现里，线程池、超时和字段降级和聚合逻辑同等重要，都是 BFF 的职责组成部分。

## 证据清单

这篇的关键判断主要由以下证据托底：

- HomeController 异步 BFF 入口：`my-xhs-home/src/main/java/com/myxhs/home/controller/HomeController.java:17`
- 聚合线程池配置：`my-xhs-home/src/main/resources/application.yml:129`
- 笔记详情两层聚合：`my-xhs-home/src/main/java/com/myxhs/home/service/NoteAggService.java:22`
- 商品详情聚合与 AggVO：`my-xhs-home/src/main/java/com/myxhs/home/service/ProductAggService.java:22`、`my-xhs-home/src/main/java/com/myxhs/home/dto/ProductDetailAggVO.java:13`
- 用户主页单层聚合：`my-xhs-home/src/main/java/com/myxhs/home/service/UserProfileAggService.java:22`
- Feed 推拉混合 + 两层聚合：`my-xhs-home/src/main/java/com/myxhs/home/service/FeedService.java:31`、`my-xhs-home/src/main/java/com/myxhs/home/service/FeedService.java:133`
- 购物车两层聚合与降级：`my-xhs-home/src/main/java/com/myxhs/home/service/CartAggService.java:21`、`my-xhs-home/src/main/java/com/myxhs/home/service/CartAggService.java:87`

## 边界清单

- 本篇讨论的是 BFF 聚合层的职责边界，不展开每个页面下游服务的全部业务细节，这些分别属于内容、商品、购物车、通知等专题。
- 当前实现里的 `home` 仍然是轻量 BFF，并未演化成独立前端渲染平台或 GraphQL 网关；本文不把它过度外推。
- 聚合线程池和超时窗口是当前实现的重要组成部分，但其参数值属于可调配置，不应误写成业务绝对常量。
- 本篇主要解释页面聚合、降级和编排，不展开首页推荐算法和热搜算法本身。
- `ai-app`、`ai-mcp`、`ai-tools` 不进入本篇分析线。

## 这篇解决了什么，还留下什么问题

这篇先解决了三个问题：

- 为什么 `home` 不是薄转发层，而是页面级读模型和故障语义的集中控制层。
- 为什么不同页面必须有不同聚合拓扑，而不能用一套“调几个接口再拼装”的模板想象。
- 为什么 BFF 的核心价值不只在并发聚合，更在于它决定了页面能否优雅降级。

到这里，`06-search-recommendation-home` 目录的四篇已经把流量入口主骨架立住了：

- ES 搜索如何作为独立索引视图工作
- 推荐怎样通过多路召回和排序形成 Pipeline
- 热搜怎样把搜索行为收敛成公共榜单
- 首页 BFF 怎样把多个域的读模型重新编排成页面视图

下一步如果继续沿用户可见能力往前推，更自然的是进入 `07-im-notification-message`，因为搜索、推荐、热搜和首页聚合之后，下一层最贴近用户感知的就是通知、SSE 与 IM 触达链。