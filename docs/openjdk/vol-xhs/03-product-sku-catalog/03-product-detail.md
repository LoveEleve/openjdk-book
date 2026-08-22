# 商品详情聚合

> 对应目录：`vol-xhs/03-product-sku-catalog/`
> 目标问题：既然商品域已经有 `SPU / SKU` 模型，也能返回 `SpuDetailVO`，为什么详情页还要再走一层 `home` 聚合？商品详情到底是一个 product 本地模型，还是一个跨域聚合模型？

## 一句话困惑

走到这里，读者通常会产生一个非常自然的疑问：**既然商品服务已经能根据 `spuId` 返回 `SpuDetailVO`，为什么前台详情页还要通过 `home` 再聚一次？**

从直觉上看，商品详情似乎就该是商品域自己的事：

- 名称、描述、图片都在 `SPU`
- 价格、规格都在 `SKU`
- 分类也在商品域里

如果这些数据都已经齐了，那多出一层聚合看起来像是重复劳动，甚至像架构上的过度设计。

但真正把代码走通之后会发现，所谓“商品详情页”在 `my-xhs` 里其实包含了两类完全不同的数据：

1. **商品真相本体**：这个商品是什么、有哪些变体、母体状态如何。
2. **商品外部视图**：每个变体当前还有没有库存、这个商品被收藏和浏览了多少次、后续是否还要挂关联内容。

前者属于 `product` 域，后者已经跨到了 `inventory`、`counter`，甚至未来会触到 `content/search`。所以“商品详情”在业务上看起来像一个页面，在系统里却已经不是单域模型。

## 一句话答案

`my-xhs` 的商品详情不是单纯的 `product` 本地返回对象，而是以 `product` 域的 `SPU + SKU` 真相为骨架，再由 `home` 域聚合库存、计数和后续扩展视图形成的跨域读模型；也就是说，商品服务负责提供“商品是什么”，首页聚合层负责补齐“商品现在呈现成什么样”。

## 先建立最小心智模型

先把两个容易混淆的概念分开：

- `SpuDetailVO`：商品域的本地详情模型
- `ProductDetailAggVO`：前台页面真正消费的聚合详情模型

它们看起来都像“商品详情”，但解决的是两个层次的问题。

### `SpuDetailVO` 解决什么

`my-xhs-product/src/main/java/com/myxhs/product/dto/response/SpuDetailVO.java:8` 到 `:39` 已经定义得很清楚：

- `SPU` 级字段：名称、描述、图片、类目、状态
- `SKU` 列表：作为该商品母体下的变体集合

所以这个对象回答的是：

```text
这个商品母体是什么
这个母体下面有哪些可卖变体
```

### `ProductDetailAggVO` 又额外解决什么

`my-xhs-home/src/main/java/com/myxhs/home/dto/ProductDetailAggVO.java:13` 到 `:20` 明确写了聚合来源：

- `SPU` 详情（含 `SKU` 列表）来自 `product`
- 各 `SKU` 库存来自 `inventory`
- 商品计数来自 `counter`
- 关联种草笔记未来可来自 `content / search`

所以它回答的是：

```text
这个商品现在应该怎样被前台展示
```

也就是说，**前一个模型是商品真相，后一个模型是页面读模型。**

## 先推演第一个失败方案：让商品服务单独负责整个详情页

最直觉的方案就是：既然商品详情叫“商品详情”，那就应该只由商品服务负责。

### 为什么这个方案很有诱惑力

因为从对象组织上看，商品域已经拥有很多关键字段：

- `SPU` 提供名字、描述、图片、类目、状态
- `SKU` 提供规格、价格、原价、变体状态

`ProductController` 里也已经直接暴露了商品详情接口。`my-xhs-product/src/main/java/com/myxhs/product/controller/ProductController.java:92` 到 `:109` 的 `/api/product/spu/{spuId}` 就能返回 `SpuDetailVO`。

如果只看这一层，很容易得出：页面直接打 `product` 服务就够了，何必再走 `home` 聚合。

### 这个方案先坏在哪里

它会先在“库存”和“计数”两类数据上出问题。

#### 第一处断裂：库存不属于 product

上一篇已经讲过，`SKU.stock` 在当前系统里只是冗余占位值，真实库存属于 `inventory` 域。如果商品服务硬要自己返回库存，就只有两种选择：

1. 误把 `SKU.stock` 当真相
2. 在商品服务内部再去调库存服务

第一种会直接产生错误展示；第二种则说明“详情页已经跨域”，只不过聚合位置被偷塞进了 `product` 域内部。

#### 第二处断裂：计数也不属于 product

商品收藏数、浏览数这些值，不在 `SPU` 或 `SKU` 真相里，而在计数视图域里。`ProductDetailAggService` 通过 `counter` 服务批量查询计数，见 `my-xhs-home/src/main/java/com/myxhs/home/feign/CounterFeignClient.java:21` 和 `my-xhs-home/src/main/java/com/myxhs/home/service/ProductAggService.java:78` 到 `:96`。

这说明“详情页该展示什么计数”已经不是商品域自己能独立回答的问题。

### `my-xhs` 为什么不走这条路

系统的做法很清楚：

- `product` 服务负责返回 `SPU + SKU` 真相骨架。
- `home` 服务再把库存、计数和未来扩展视图拼到这具骨架上。

这就是它把“详情真相”和“详情展示”分成两层的原因。

## 再推演第二个失败方案：让 home 直接跳过 product，只拼页面片段

还有一种看起来也能成立的思路：既然页面最终都要走聚合，那不如 `home` 直接自己查各域，把 `product` 当成普通下游甚至可有可无。

### 为什么这个方案也有诱惑力

因为 `home` 的职责本来就是聚合，它看起来完全可以：

- 自己拼商品名字
- 自己拼规格
n- 自己拼价格
- 自己拼库存和计数

这样似乎还减少了一层“先拿 `SpuDetailVO`，再继续聚”的中转。

### 它真正的问题

它会让商品真相边界被 `home` 吞掉。

`home` 并不拥有 `SPU / SKU` 的主数据语义。它只是一个展示聚合域。如果让它绕过商品域直接拼装所有片段，就会出现两个问题：

1. 商品模型的演化开始分散到多个域。
2. `home` 不再只是拼装页面，而开始重建商品真相本身。

这不是抽象担忧，而是当前实现恰好在反方向上自我约束了：`home` 的 `ProductFeignClient` 只拿商品域已经整理好的 `SPU` 详情骨架，见 `my-xhs-home/src/main/java/com/myxhs/home/feign/ProductFeignClient.java:19` 到 `:22`；而 `ProductAggService` 在 `my-xhs-home/src/main/java/com/myxhs/home/service/ProductAggService.java:61` 到 `:76` 也只是把这个骨架作为第一层输入，再继续补计数和库存。换句话说，当前代码明确选择了“product 先定义骨架，home 再补视图”，而不是让 `home` 自己重建整套 `SPU / SKU` 字段集合。

这会让商品域从“权威源”退化成“其中一个数据提供方”，而 `home` 则从聚合层膨胀成另一个隐形商品域。

### `my-xhs` 为什么也不这么做

`home` 的 `ProductFeignClient` 在 `my-xhs-home/src/main/java/com/myxhs/home/feign/ProductFeignClient.java:19` 到 `:22` 明确调用的是 `/api/product/spu/{spuId}`，而不是自己重建 `SPU / SKU` 模型。这说明聚合层被严格限制在“先拿商品真相骨架，再补外部视图”，而不是越权篡改商品域边界。

还有一个很现实的微服务边界在源码里也写得很清楚：商品域除了公开详情接口，还额外提供了 `/api/product/sku/batch` 这种内部批量接口，供 cart/order 等下游一次拉多条 SKU 信息，且要求 `X-Internal-Call` 令牌并把 `skuIds` 数量限制在 100 以内，见 `my-xhs-product/src/main/java/com/myxhs/product/controller/ProductController.java:175` 到 `:190`。这说明商品详情聚合并不是“每个下游自己打一堆单条详情 HTTP”，而是已经开始围绕批量读取和内部受保护端点来控制跨服务扇出成本。

## product 域本地详情到底提供了什么

`ProductController.getSpuDetail()` 在 `my-xhs-product/src/main/java/com/myxhs/product/controller/ProductController.java:94` 暴露单条详情入口。它的返回值来自 `SpuService.getSpuDetail(spuId)`，见 `my-xhs-product/src/main/java/com/myxhs/product/controller/ProductController.java:98`。

`SpuService` 对这条读路径的设计非常重：

- 多级缓存
- 布隆过滤器
- 逻辑过期
- 空值缓存
- 延迟双删后一致性兜底

这些策略集中出现在 `my-xhs-product/src/main/java/com/myxhs/product/service/SpuService.java:406` 到 `:537`。这说明商品服务对外提供的本地详情，并不是轻飘飘的一次表查询，而是商品真相的稳定读入口。

这条本地详情读路径解决的是三件事：

1. **这个 `spuId` 是否存在**
2. **这个商品母体当前有哪些上架 `SKU`**
3. **这些母体与变体信息怎样稳定、高频地被读取**

所以 product 域的职责已经很明确：它负责把“商品是什么”这层真相读稳定。

这里还有一个容易漏掉的可观测性边界：`ProductController.getSpuDetail()` 只在**单条详情入口**记录商品浏览事件，而且只在存在 `X-User-Id` 时才异步落 `t_product_behavior`，见 `my-xhs-product/src/main/java/com/myxhs/product/controller/ProductController.java:102` 到 `:108`、`my-xhs-product/src/main/java/com/myxhs/product/entity/ProductBehavior.java:12` 到 `:16`。这意味着 search/home 之类的内部 Feign 补全调用、批量读取路径、缓存异步刷新路径，都不会被记成用户浏览。系统不是在“凡是查过商品都算浏览”，而是在刻意保护埋点语义：只有真实用户打开单条详情页，才进入“商品浏览→加购→下单→支付”的漏斗分析链。

但它在写路径上也留下了一个很诚实的边界：当前 `t_spu` 没有 `creatorUserId` 字段，`ProductController.createSpu()` 里直接留了 TODO，只能记录操作者日志，不能做真正的“商品所有权”校验，见 `my-xhs-product/src/main/java/com/myxhs/product/controller/ProductController.java:68` 到 `:69`。这意味着当前管理员权限主要靠 `X-Admin-Call` 令牌控制，而不是靠商品记录自身的归属关系控制。

## 真正让详情页跨域的，是哪几类外部视图

当 `home` 接管详情页时，它不是重复商品域的工作，而是在商品骨架之外补三类外部视图。

## 1. 库存视图：按 SKU 逐个补可卖状态

`ProductDetailAggService` 的注释在 `my-xhs-home/src/main/java/com/myxhs/home/service/ProductAggService.java:26` 到 `:34` 已经讲得很清楚：

- 第一层并行：`SPU` 详情 + 商品计数
- 第二层依赖第一层的 `SKU` 列表，再去查每个 `SKU` 的库存
- 库存服务不可用时，详情页仍可降级展示

真正的库存补齐逻辑在 `aggregateSkuStock()`：

- 遍历 `skuListRaw`，见 `my-xhs-home/src/main/java/com/myxhs/home/service/ProductAggService.java:183` 到 `:200`
- 对每个 `skuId` 调 `inventoryFeignClient.getStock(skuId)`，见 `my-xhs-home/src/main/java/com/myxhs/home/service/ProductAggService.java:192`
- 再把 `availableStock` 和 `hasStock` 回填进 `SkuWithStockVO`，见 `my-xhs-home/src/main/java/com/myxhs/home/service/ProductAggService.java:220` 到 `:239`

这说明商品详情页上的“是否有货”，根本不是商品域字段，而是库存域投影出来的外部视图。

## 2. 计数视图：收藏数、浏览数来自 counter

同样地，商品详情页上的收藏数和浏览数也不是商品域本地字段。

`ProductAggService` 在 `my-xhs-home/src/main/java/com/myxhs/home/service/ProductAggService.java:78` 到 `:96` 通过 `counterFeignClient.batchGetCounts()` 查询商品计数，再在 `:138` 和 `:139` 组装进最终详情对象。

所以详情页里用户看到的“这个商品热不热”，也已经不属于商品本体，而属于外部计数视图。

## 3. 未来扩展视图：关联内容并不应该先塞进 product

`ProductDetailAggVO` 在 `my-xhs-home/src/main/java/com/myxhs/home/dto/ProductDetailAggVO.java:44` 到 `:45` 还保留了 `relatedNotes` 字段，注释在 `:19` 已经说明未来会接入 `content / search`。

当前实现还没有真正聚合这部分数据，`ProductAggService` 在 `my-xhs-home/src/main/java/com/myxhs/home/service/ProductAggService.java:140` 先返回空列表。也就是说，`relatedNotes` 当前只是一条明确保留的扩展口，不构成现有商品详情链路的一部分。

但这个字段仍然很有价值，因为它提前暴露了一个架构判断：**商品详情页未来承载的，可能不仅是商品真相和库存/计数视图，还会继续吸收内容视图。**

这就更说明详情页天然应该落在聚合域，而不是把所有未来扩展都塞进商品域。

## 这条读路径为什么最终落在 home 而不是 product

到这里可以把整个读路径压缩成一句话：

- `product` 负责稳定地返回商品真相骨架
- `home` 负责把外部视图贴到这具骨架上

这也是为什么 `ProductDetailAggVO` 和 `SpuDetailVO` 会同时存在。

### `SpuDetailVO` 的边界

它是商品域本地真相的外壳：

- 商品母体字段
- SKU 列表
- 不碰真实库存
- 不碰计数视图

### `ProductDetailAggVO` 的边界

它是页面聚合模型：

- 承接 `SPU` 基本信息
- 承接 `SKU + 库存`
- 承接商品计数
- 为关联内容预留口子

两者的关系不是“谁更完整就替代谁”，而是：

**前者是域真相，后者是读模型。**

## 降级策略为什么进一步证明这是聚合模型

如果商品详情真是纯商品域问题，就不应该有那么明显的跨域降级策略。

但 `ProductAggService` 注释里已经明确写了：

- 商品服务不可用 → 返回 `null`
- 库存服务不可用 → 库存显示“暂无数据”
- 计数服务不可用 → 计数显示 `0`

而且这些语义在代码里也有落点：

- 商品骨架不可缺：`my-xhs-home/src/main/java/com/myxhs/home/service/ProductAggService.java:65` 到 `:69` 一旦商品服务返回 503 就抛 `DownstreamUnavailableException`，`my-xhs-home/src/main/java/com/myxhs/home/service/ProductAggService.java:107` 到 `:113` 又把空骨架直接视为 `null` 返回。
- 计数可降级：`my-xhs-home/src/main/java/com/myxhs/home/service/ProductAggService.java:79` 到 `:96` 捕获异常后返回空 `Map`，最终在 `:138` 和 `:139` 把收藏数和浏览数降级为 `0`。
- 库存可降级：`my-xhs-home/src/main/java/com/myxhs/home/service/ProductAggService.java:189` 到 `:198` 库存查询异常时返回空 `Map`，再在 `:220` 到 `:239` 把 `availableStock` 降级为默认值并继续组装 `SkuWithStockVO`。

这说明详情页里的不同字段，其可失败性并不一致：

- 商品骨架不可缺
- 库存可降级
- 计数也可降级

这种“不同行字段有不同故障语义”的模型，本质上就是聚合读模型，而不是单域对象读取。

## 商品详情聚合还承担一个工程代价：按 SKU 并发查询会把跨服务扇出带进页面延迟

`ProductAggService.aggregateSkuStock()` 会遍历商品详情中的 `skuListRaw`，为每个 `skuId` 创建一个 `CompletableFuture`，再等待这一批库存查询完成，见 `my-xhs-home/src/main/java/com/myxhs/home/service/ProductAggService.java:178` 到 `:205`。这带来一个很具体的工程问题：

```text
一个 SPU 有多少 SKU
→ 一个详情请求就可能产生多少次 inventory Feign 调用
```

当前实现没有把这个扇出假装成“没有成本”，而是用独立的 `batchFeignPool`、动态超时和字段级降级控制它：库存查询慢或失败时，商品骨架仍可返回，SKU 库存字段降级为默认视图，见 `my-xhs-home/src/main/java/com/myxhs/home/service/ProductAggService.java:202` 到 `:239`。

这条设计同时说明了三个视角：

- **业务逻辑**：详情页必须展示每个变体的库存状态；
- **工程问题**：按 SKU 扇出会放大线程、连接和延迟成本；
- **微服务问题**：库存真相留在 inventory，home 只能通过跨服务聚合取得；
- **分布式边界**：详情页拿到的是某一时刻的库存视图，不是订单提交时的库存承诺，真正交易仍必须回到 order → inventory 的校验与预扣链。

所以 `ProductDetailAggVO` 的存在不仅是返回结构选择，也是在一个页面级接口里承接跨服务扇出和部分降级责任。

## 真实故障案例：为什么库存一旦被错误看成商品域字段，详情页会先展示错，再交易时打脸

这条聚合链最容易出问题的地方，恰恰就是“库存到底属于谁”。另外，商品域自己的只读接口也修过一个容易让前台误判的边界：现在 `/api/product/sku/list/{spuId}` 在所属 `SPU` 已下架时直接返回空列表，不再继续把“SKU 仍上架但母体已下架”的半有效结果暴露给公开读路径，见 `my-xhs-product/src/main/java/com/myxhs/product/service/SkuService.java:124` 到 `:146`。

### 现象

如果详情页直接把商品域里的 `SKU.stock` 当成真实库存，页面上看起来会非常自然：

- 每个规格旁边都有库存数字
- 看上去像是商品服务直接给了你完整答案

但一旦用户继续往购物车和下单链路走，系统又会在订单侧重新查 `inventory`。此时就会出现：展示层说有货，交易层却说库存不足；或者展示层说库存没变，但真实库存其实已经被预扣了。

### 根因

根因不是“详情页多查了一次”，而是**把商品真相和库存真相混成了一层**。`SKU.stock` 在当前实现里已经降级成冗余占位字段，而详情页真正需要的是库存域的实时投影。

### 修复

`my-xhs` 当前的修法非常明确：

1. `SkuVO` 不暴露 `stock`
2. 商品骨架仍由 product 提供
3. 详情页库存统一由 `home` 调 `inventory` 补齐

### 验证

验证是否真的修好，不能只看详情页能不能打开，而要看：

- 详情页的库存是否来自 `inventoryFeignClient.getStock()`
- 订单前置校验是否仍走库存服务
- 库存服务降级时，页面是否仅部分退化，而不是把商品本体一起打崩

### 余波

这个案例提醒我们：**详情页之所以要聚合，不是为了架构好看，而是因为有些真相从一开始就不属于商品域。** 如果强行把它们塞回商品域，页面也许能暂时少一跳调用，但后续交易链一定会把这个误判放大出来。

## 再补一个容易被忽略的运行时故障：浏览埋点丢了，不等于详情链坏了

商品详情还有一种很容易误判的故障：页面明明能正常打开，但漏斗看板里的“商品浏览”突然变少，于是读代码的人很容易反过来怀疑详情接口本身有问题。

当前实现恰恰把这两件事拆开了。`recordSpuViewAsync()` 用的是独立的 `SPU_VIEW_EXECUTOR`，队列满时走 `DiscardPolicy`，提交失败或落库失败都只记 warn，不影响详情返回，见 `my-xhs-product/src/main/java/com/myxhs/product/service/SpuService.java:86` 到 `:94`、`my-xhs-product/src/main/java/com/myxhs/product/service/SpuService.java:550` 到 `:569`。这意味着：

- 详情接口 200，不代表浏览事件一定落库成功
- 浏览事件缺失，也不代表商品骨架、库存聚合或计数聚合出了问题

也就是说，当前系统显式接受一种“页面成功、埋点丢失”的半成功状态。它的代价不是交易错误，而是可观测性变弱、漏斗分析变粗。这和前面讲的“库存或商品骨架错误会直接污染展示/交易”不是同一级事故，不能混成一类排查。

## 这一篇先收束成一张总图

```text
product 域本地详情
  SpuDetailVO
    = SPU 基本信息 + SKU 列表

home 域聚合详情
  ProductDetailAggVO
    = SpuDetailVO
    + inventory 的 SKU 库存
    + counter 的商品计数
    + 未来 content/search 的关联内容
```

这里最重要的不是“详情页调用了几个服务”，而是三条判断：

1. 商品域只负责提供商品真相骨架，不负责吞并外部视图。
2. 详情页真正消费的是跨域读模型，而不是商品域本地对象。
3. 库存、计数、内容等后续视图越多，越说明详情页应该停留在聚合层，而不是回流到商品域内部。

## 证据清单

这篇的关键判断主要由以下证据托底：

- 商品域本地详情入口：`my-xhs-product/src/main/java/com/myxhs/product/controller/ProductController.java:92`
- 商品域内部批量 SKU 端点与数量上限：`my-xhs-product/src/main/java/com/myxhs/product/controller/ProductController.java:175`
- SPU 下架时 SKU 列表直接收空：`my-xhs-product/src/main/java/com/myxhs/product/service/SkuService.java:124`
- SPU 创建当前无 ownership tracking：`my-xhs-product/src/main/java/com/myxhs/product/controller/ProductController.java:68`
- 本地详情入口与聚合入口在埋点语义上被刻意区分：`my-xhs-product/src/main/java/com/myxhs/product/controller/ProductController.java:102`
- 商品浏览事件流水只记录真实单条详情浏览：`my-xhs-product/src/main/java/com/myxhs/product/entity/ProductBehavior.java:12`
- 浏览埋点独立线程池且允许丢失：`my-xhs-product/src/main/java/com/myxhs/product/service/SpuService.java:86`、`my-xhs-product/src/main/java/com/myxhs/product/service/SpuService.java:550`
- `SpuService` 多级缓存读路径：`my-xhs-product/src/main/java/com/myxhs/product/service/SpuService.java:406`
- `SpuDetailVO` 结构：`my-xhs-product/src/main/java/com/myxhs/product/dto/response/SpuDetailVO.java:8`
- `home` 聚合商品详情入口：`my-xhs-home/src/main/java/com/myxhs/home/controller/HomeController.java:95`
- `ProductDetailAggVO` 聚合来源：`my-xhs-home/src/main/java/com/myxhs/home/dto/ProductDetailAggVO.java:13`
- 商品详情两层并行聚合：`my-xhs-home/src/main/java/com/myxhs/home/service/ProductAggService.java:26`、`my-xhs-home/src/main/java/com/myxhs/home/service/ProductAggService.java:59`
- 商品骨架、计数、库存三种不同降级语义：`my-xhs-home/src/main/java/com/myxhs/home/service/ProductAggService.java:65`、`my-xhs-home/src/main/java/com/myxhs/home/service/ProductAggService.java:87`、`my-xhs-home/src/main/java/com/myxhs/home/service/ProductAggService.java:192`
- 库存聚合来自 inventory：`my-xhs-home/src/main/java/com/myxhs/home/service/ProductAggService.java:192`
- 计数聚合来自 counter：`my-xhs-home/src/main/java/com/myxhs/home/feign/CounterFeignClient.java:21`、`my-xhs-home/src/main/java/com/myxhs/home/service/ProductAggService.java:87`
- 详情页预留关联内容扩展：`my-xhs-home/src/main/java/com/myxhs/home/dto/ProductDetailAggVO.java:44`、`my-xhs-home/src/main/java/com/myxhs/home/service/ProductAggService.java:140`

## 边界清单

- 本篇只回答“商品详情为什么是跨域聚合模型”，不展开库存服务内部时序、计数服务内部实现和关联内容聚合规则。
- 当前 `relatedNotes` 仍未真正接入内容或搜索域，本篇只能把它作为未来扩展口，而不能写成已完成链路。
- `product` 域本地详情与 `home` 聚合详情并存，不是重复设计，而是域真相和页面读模型的分层。
- 本篇聚焦读路径，不展开商品创建、上下架、价格校验等写路径问题。
- `ai-app`、`ai-mcp`、`ai-tools` 不进入本篇分析线。

## 这篇解决了什么，还留下什么问题

这篇先解决了三个问题：

- 为什么 `SpuDetailVO` 还不够，详情页最终要消费的是 `ProductDetailAggVO`。
- 为什么库存和计数一旦进入详情页，商品详情就已经不再是单域模型。
- 为什么 `home` 聚合层不是多余跳板，而是商品骨架与外部视图之间的合法拼装位置。

但它还留下最后一个更具体的问题：商品域和库存域的分界一旦成立，后续商品侧到底怎样与库存域对接，才能既不把库存吞回商品域，又不让详情和交易链失配？

所以下一篇应该进入 `04-inventory-link.md`，去回答**商品域与库存域到底是怎样衔接的，为什么系统要让 `SKU` 成为交易单位、却又不让它持有真实库存真相**。
