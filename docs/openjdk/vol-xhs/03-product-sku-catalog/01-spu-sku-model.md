# SPU / SKU 数据模型

> 对应目录：`vol-xhs/03-product-sku-catalog/`
> 目标问题：为什么 `my-xhs` 要把商品拆成 `SPU` 和 `SKU` 两层，而不是一张“商品表”直接解决？这两层模型分别承载什么真相，又怎样进入详情页、购物车和下单链路？

## 一句话困惑

商品域看起来是整个系统里最“普通”的部分：无非是商品名称、价格、图片、库存这些字段，做成一张表似乎就够了。

但一旦进入真实业务链路，这个直觉会马上遇到几个问题：

- 商品详情页要展示的是“这个商品整体是什么”，还是“用户当前选中的那个规格是什么”？
- 购物车里保存的应该是一个抽象商品，还是一个可交易的具体规格？
- 库存和价格到底挂在商品层，还是挂在规格层？
- 如果同一个商品有红色/白色、128G/256G、单件/套装这些变化，一张表如何不把读写路径变得混乱？

`my-xhs` 选择用 `SPU + SKU` 两层模型回答这些问题。真正要搞清楚的，不是教科书上 SPU/SKU 的定义，而是：**在这个系统里，为什么商品真相必须拆成“共性层”和“可交易变体层”，以及这层拆分怎样影响后面的详情聚合、购物车、库存和订单。**

## 一句话答案

在 `my-xhs` 里，`SPU` 承载的是“这个商品整体是什么”的共性真相，`SKU` 承载的是“这个商品当前到底卖哪一种变体”的交易真相；前者服务于展示和归类，后者服务于价格、规格选择和后续交易链，而真实库存甚至进一步从 `SKU` 中剥离到了独立的 `inventory` 域。

## 先建立一个最小心智模型

先不要急着看字段，先把这两层模型压缩成一句人话：

- `SPU` 像一个“商品母体”
- `SKU` 像这个母体下面每一种真正能被选中、被加购、被下单的变体

在源码里，这个分层写得很直白：

- `my-xhs-product/src/main/java/com/myxhs/product/entity/Spu.java:9` 到 `:13` 说明 `SPU` 描述商品共有属性，一个 SPU 下有多个 SKU。
- `my-xhs-product/src/main/java/com/myxhs/product/entity/Sku.java:11` 到 `:16` 说明 `SKU` 描述规格变体，每个 SKU 有独立价格和库存语义。

也就是说，这个模型先做了一次非常关键的拆分：

```text
SPU = 共性商品真相（名字、类目、描述、图片、上/下架）
SKU = 可交易变体真相（规格、价格、原价、状态）
```

后面再加一个更重要的补丁：

```text
库存真相 ≠ SKU 表里的 stock 字段
库存真相 = inventory 服务
```

这个补丁正是本篇后面要重点解释的地方。

## 先推演第一个最直觉的失败方案：只用一张商品表

很多人第一次建电商商品模型时，最直觉的做法是：

```text
商品表
  id
  name
  price
  stock
  image
  category
  specs
  status
```

看起来一切都有了，好像完全没必要再拆 `SPU` 和 `SKU`。

### 为什么这个方案看起来合理

因为对单规格商品来说，它确实够用：

- 一个商品一个价格
- 一个商品一组库存
- 一个商品一张主图
- 一个商品一个上下架状态

如果系统永远只卖这种“没有规格变化的单体商品”，一张表并不会立刻出错。

### 它在真实业务里会先坏在哪里

只要商品出现变体，这张表就会马上失去清晰边界。

举个最典型的例子：同一个手机有 `黑色/白色` 和 `128G/256G` 两组规格。

这时一张表会遇到三个立即冲突的问题：

1. **商品描述和图片是共性，还是每个变体都要重复一份？**
2. **价格和库存是商品级字段，还是规格级字段？**
3. **购物车和订单里保存的到底是“商品ID”，还是“具体变体ID”？**

如果把这些信息都塞进一张表，你最后只能在“共性信息重复存储”和“交易语义模糊不清”之间二选一。

### `my-xhs` 为什么不走这条路

`SPU` 实体在 `my-xhs-product/src/main/java/com/myxhs/product/entity/Spu.java:20` 到 `:36` 中只保留了典型共性字段：

- 名称 `name`
- 分类 `categoryId`
- 品牌 `brandId`
- 描述 `description`
- 图片列表 `images`
- 状态 `status`

而 `SKU` 实体在 `my-xhs-product/src/main/java/com/myxhs/product/entity/Sku.java:23` 到 `:42` 中保留的是变体级字段：

- 所属 `spuId`
- 名称 `name`
- 价格 `price`
- 原价 `originalPrice`
- 规格 `specs`
- 状态 `status`

也就是说，`my-xhs` 用这套双层模型解决的是：

- **SPU 负责回答“这是什么商品”**
- **SKU 负责回答“这个商品当前卖的是哪一种具体变体”**

这就是第一条关键设计取舍：**用两层真相换清晰边界，而不是用一张大表换短期省事。**

## 再推演第二个同样常见的失败方案：既然有 SKU，就把库存完全留在 SKU 表里

即使接受了 `SPU / SKU` 双层模型，仍然很容易产生第二个直觉：既然 `SKU` 是可交易变体，那库存当然就该存在 `SKU.stock` 里。

这套直觉在很多简单系统中也成立，但在 `my-xhs` 里它同样被主动打破了。

### 为什么这个方案很有诱惑力

因为它在概念上很顺：

- SKU 是可买的变体
- 每个 SKU 一组价格
- 每个 SKU 一组库存

如果系统里没有独立库存域，这通常也是最自然的建模方式。

### `my-xhs` 为什么偏偏不这样做

`Sku` 实体在 `my-xhs-product/src/main/java/com/myxhs/product/entity/Sku.java:35` 到 `:36` 明确写了 `stock` 字段，但注释在 `:15` 已经把事实讲穿：**这个字段是冗余占位字段，实际库存以 inventory 服务为准。**

同样的判断在返回对象里又被重复了一次。`my-xhs-product/src/main/java/com/myxhs/product/dto/response/SkuVO.java:10` 到 `:12` 明确说明：

- `SkuVO` 不含 `stock`
- `SKU` 表的 `stock` 是创建时的冗余占位值
- 真实库存以 `inventory` 服务为准

这说明系统在商品模型上又做了一次更深的拆分：

```text
SPU = 商品共性真相
SKU = 规格/价格变体真相
Inventory = 库存真相
```

### 这个拆分到底解决了什么

它解决的是“商品建模”和“库存时序”被混在一起的问题。

商品域关心的是：

- 卖什么
- 有哪些规格
- 每个规格怎么展示
- 当前是否允许上架

库存域关心的是：

- 还能卖多少
- 是否预扣
- 是否确认扣减
- 是否需要释放或回补

如果库存直接留在商品域里，后面的三级扣减、补偿、回滚、对账都会被迫绑进 `product`。这会让商品域从一个偏主数据域，膨胀成一个同时承担并发和交易时序的重域。

`my-xhs` 明确选择不走这条路，因此商品模型从一开始就把交易态最敏感的那部分真相让给了 `inventory` 域。

## 这套模型到底怎样进入读路径

讲清楚 SPU / SKU 不能只看表结构，还必须看它怎样进入真实读路径。

### SPU 详情为什么天然要带 SKU 列表

`SpuDetailVO` 在 `my-xhs-product/src/main/java/com/myxhs/product/dto/response/SpuDetailVO.java:8` 到 `:39` 已经定义得很清楚：

- 它有商品名称、描述、图片、类目、状态这些 SPU 级字段
- 它还带了一组 `skuList`

这说明详情页在系统眼里不是“查一个商品对象”，而是：

1. 先查商品母体
2. 再把这个母体下可卖的变体一起展开

详情页需要的不是一个平铺记录，而是一个“共性外壳 + 变体集合”的结构。

### SKU 返回对象为什么还要补 SPU 图和 SPU 状态

`SkuVO` 里除了 `sku` 自己的字段外，还额外出现了两个很关键的字段：

- `image`，见 `my-xhs-product/src/main/java/com/myxhs/product/dto/response/SkuVO.java:34`
- `spuStatus`，见 `my-xhs-product/src/main/java/com/myxhs/product/dto/response/SkuVO.java:40`

这说明 `SKU` 在对外返回时，并不是完全自治的对象。它仍然要继承一部分来自 `SPU` 的上下文：

- SKU 表本身没有图片，于是主图从所属 SPU 的第一张图继承，见 `my-xhs-product/src/main/java/com/myxhs/product/service/SkuService.java:216` 到 `:229`
- 购物车等场景判断商品是否仍然有效时，不仅要看 SKU 自己是否上架，还要看所属 SPU 是否仍然上架，于是 `SkuVO` 额外带上了 `spuStatus`，见 `my-xhs-product/src/main/java/com/myxhs/product/service/SkuService.java:175` 到 `:188` 和 `:199` 到 `:212`

这又说明了一个很重要的设计点：**SPU 和 SKU 不是完全独立的两张表，而是“共性层”与“变体层”之间持续互相投影的模型。**

## 写路径上，SPU 和 SKU 分别承担什么责任

### SPU 写路径：先定“卖什么”

`SpuService.createSpu()` 从 `my-xhs-product/src/main/java/com/myxhs/product/service/SpuService.java:256` 开始：

1. 先校验分类是否存在，见 `my-xhs-product/src/main/java/com/myxhs/product/service/SpuService.java:261` 到 `:265`
2. 再组装 SPU 实体，写入名称、分类、品牌、描述、图片、状态，见 `my-xhs-product/src/main/java/com/myxhs/product/service/SpuService.java:267` 到 `:278`
3. 事务提交后，再把新 SPU 加进布隆过滤器，见 `my-xhs-product/src/main/java/com/myxhs/product/service/SpuService.java:280` 到 `:287`

这条写路径回答的是：平台上从此多了一个新的“商品母体”。

### SKU 写路径：再定“卖这个母体的哪一种变体”

`SkuService.createSku()` 从 `my-xhs-product/src/main/java/com/myxhs/product/service/SkuService.java:47` 开始：

1. 先校验所属 SPU 是否存在，见 `my-xhs-product/src/main/java/com/myxhs/product/service/SkuService.java:52` 到 `:56`
2. 再写入变体级字段：名称、价格、原价、初始库存占位、规格、状态，见 `my-xhs-product/src/main/java/com/myxhs/product/service/SkuService.java:58` 到 `:68`
3. 提交后清理 SPU 缓存，因为 SKU 列表变了，见 `my-xhs-product/src/main/java/com/myxhs/product/service/SkuService.java:70` 到 `:77`

也就是说，这条写路径回答的是：这个商品母体下面新增了一个可交易变体。

### 为什么 SKU 创建后要清 SPU 缓存

这是一个很有代表性的边界信号。

如果 SPU 和 SKU 真是两套毫不相干的数据，创建 SKU 不应该影响 SPU 缓存。但在 `my-xhs` 里恰好相反：因为详情页总是以 `SPU + SKU 列表` 的结构对外返回，所以只要 SKU 变化，SPU 详情缓存就必须失效。

这进一步证明：**系统真正对外暴露的主模型，不是裸 SPU，也不是裸 SKU，而是以 SPU 为外壳、SKU 为内容的组合体。**

## 读路径上，为什么 SPU 详情要承担更多聚合责任

`SpuService` 注释在 `my-xhs-product/src/main/java/com/myxhs/product/service/SpuService.java:48` 到 `:60` 已经写清了它的角色：

- 它是商品核心服务
- 它承载两级缓存架构
- 它要处理缓存穿透、击穿、一致性策略

也就是说，`SPU` 这一层并不只是“一个母表”。它还是商品对外读模型的聚合壳。商品详情查的是 SPU，但返回时一定会带 SKU 列表，因此：

- 缓存击穿防护主要挂在 SPU 详情上
- 布隆过滤器也围绕 SPU ID 建立
- 逻辑过期缓存重建也先从 SPU 维度出发

这里还值得把工程和分布式代价再点透一层。`SpuService.initBloomFilter()` 在 `my-xhs-product/src/main/java/com/myxhs/product/service/SpuService.java:151` 到 `:176` 明确承认：商品详情高频读路径不只是“查缓存”，还要处理布隆过滤器首次初始化、多实例同时启动、Redis 不可用和异步全量加载这些工程问题。后面的 `asyncLoadBloomFilter()` 又进一步说明了系统为什么不敢在启动时同步全量灌 100 万 SPU：那会把服务启动拖成几十万次 Redis 调用，甚至在容器探活窗口内被反复杀死，见 `my-xhs-product/src/main/java/com/myxhs/product/service/SpuService.java:178` 到 `:250`。

这说明商品域虽然看起来像“读多写少”的普通主数据域，但它在工程层面已经有一套很完整的高频详情稳定性设计：

- 布隆过滤器先挡穿透
- 本地/Redis 缓存承担热读
- 逻辑过期承担重建窗口
- 事务提交后再更新布隆过滤器，避免回滚后的假阳性，见 `my-xhs-product/src/main/java/com/myxhs/product/service/SpuService.java:280` 到 `:288`

换句话说，商品域在业务上解决的是“这个商品是什么”，在工程上又额外解决了“这个高频详情入口怎样在多实例和缓存条件下稳定读”。

这里还有几个源码里很重、但文档里还没点透的工程细节。

第一，`SpuService` 没有把这些异步动作丢给 `ForkJoinPool.commonPool()`，而是自己维护了两个带 `MdcAwareExecutorService` 包装的专用线程池，见 `my-xhs-product/src/main/java/com/myxhs/product/service/SpuService.java:75` 到 `:94`：

- `SPU_ASYNC_EXECUTOR`：负责缓存刷新、延迟双删、布隆过滤器异步加载；有界队列 + `CallerRunsPolicy`，优先保证任务不静默丢失
- `SPU_VIEW_EXECUTOR`：负责商品浏览事件落库；有界队列 + `DiscardPolicy`，明确接受“埋点可丢、详情响应不能慢”

这说明系统已经把“商品详情主链”和“详情旁路可观测性”拆成了两套故障语义：缓存刷新这类核心维护动作尽量不丢，而浏览事件这类可观测性旁路允许直接丢弃。

第二，布隆过滤器并不是启动完成后天然可用，而是有一个显式的 `bloomFilterReady` 就绪窗口，见 `my-xhs-product/src/main/java/com/myxhs/product/service/SpuService.java:120` 到 `:127`。首次部署或异步重建期间，这个标志保持 `false`，所有请求都会跳过布隆过滤器，直接降级到“查缓存/查 DB”。也就是说，系统宁可暂时失去防穿透优化，也不让启动阶段因为布隆过滤器未就绪而误拦真实请求。

第三，异步加载历史 SPU ID 时不只是“分批加载”，还叠加了“分布式锁 + 拿锁后二次检查”，见 `my-xhs-product/src/main/java/com/myxhs/product/service/SpuService.java:188` 到 `:205`。这意味着多实例同时启动时，只有一个实例真正跑全量加载；其他实例即便晚一步拿到锁，也会先看 `count()>0` 再决定是否退出，避免重复灌 Redis。

第四，`SPU` 写路径也不是简单的 `updateById`。`SpuService.updateSpu()` 用 `LambdaUpdateWrapper` 只更新变更字段，显式规避 read-then-write 导致的并发覆盖；事务提交后又做“立即删缓存 + 1 秒后二次删”，见 `my-xhs-product/src/main/java/com/myxhs/product/service/SpuService.java:301` 到 `:357`。这条延迟双删不是形式主义，而是在覆盖一个具体窗口：并发读线程可能刚好在第一次删缓存之后、第二次删缓存之前把旧值异步回填回来。

第五，冷 key miss 的“防惊群”后来还补过一次真实修复。现在 `getSpuDetail()` 已改成只有拿到 `loadLock` 的线程才查 DB 并回填缓存；其他线程会短暂等待后重查 Redis，只有缓存仍未回填时才降级直查 DB，见 `my-xhs-product/src/main/java/com/myxhs/product/service/SpuService.java:485` 到 `:537`。这意味着当前实现不再只是“名义上有加载锁”，而是把“未拿到锁的线程继续直打 DB”这个漏洞真正堵上了。

这说明系统在读路径上的选择是：**把商品详情这个高频入口稳定在 SPU 维度，再把 SKU 作为它的子结构展开。**

## 这套模型一旦失效，会怎样沿着详情、购物车和订单三条链一起扩散

`SPU / SKU` 分层真正有价值的地方，不只是让数据结构更好看，而是它把“商品已经不该继续卖了”这件事拆成了几条可以分别拦截的链。

### 第一条：详情页先失效

商品域自己的详情返回里已经会把 `SPU` 状态和 `SKU` 列表一起带出来；到了 `home` 聚合层，`ProductAggService` 又会进一步把每个 `SKU` 的库存补进来。也就是说，一旦：

- `SPU` 下架
- `SKU` 下架
- `inventory` 返回无货

前台详情页看到的就不再只是“一个商品对象”，而是“这个商品骨架还在不在、哪些变体还能不能卖、哪些变体现在有没有货”这三层组合结果。

### 第二条：购物车再做一次有效性拦截

`CartService.getCartList()` 在 `my-xhs-cart/src/main/java/com/myxhs/cart/service/CartService.java:430` 到 `:451` 已经明确体现了这条防线：即使商品当初加入购物车成功，列表回显时仍会再次检查：

- `SKU` 是否还能查到
- `SKU.status` 是否仍上架
- `SPU.status` 是否仍上架

一旦任一条件不成立，条目不会被强删，而是被标成 `valid=false` 并附上 `invalidReason`。这说明购物车并不是盲目信任“当初能加购”，而是在当前时刻重新把商品真相投影成“还能不能结算”。

### 第三条：订单再做交易前最终校验

真正最严格的一道门还在订单侧。`OrderService.createOrder()` 在 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:158` 到 `:183` 中，会在创建订单前再次检查：

- `skuInfo` 是否存在
- `spuStatus` 是否仍允许交易
- `inventory` 返回的当前可用库存是否足够

也就是说，商品失效不是在某一个入口被拦一次就完了，而是沿着：

```text
详情页展示
  → 购物车有效性
    → 下单前交易校验
```

被连续拦截三次。这里很值得记住的一点是：**商品域负责宣告“这个变体还在不在卖”，库存域负责宣告“它现在还有没有货”，而购物车和订单分别把这两类事实翻译成“还能不能继续结算”。**

这条三层防线正好说明，`SPU / SKU / Inventory` 的拆分不只是建模问题，也是在给不同业务阶段提供不同粒度的失效判断。

## 这套模型如何进入后面的购物车和订单

### 购物车为什么必须存 SKU，而不是 SPU

购物车里用户真正准备买的，不是一个抽象商品，而是一个具体规格。

`CartService` 在 `my-xhs-cart/src/main/java/com/myxhs/cart/service/CartService.java:384` 到 `:393` 中，会批量查询 `SKU` 信息来组装购物车视图；这说明购物车项天然是按 `skuId` 组织的，而不是按 `spuId`。

如果购物车只存 `spuId`，后面就根本没法确定用户选中的到底是哪一种变体：红色还是白色，128G 还是 256G。

### 订单为什么也必须以 SKU 为交易单位

`OrderService.createOrder()` 在 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:147` 到 `:156` 批量拉的就是 `SKU` 详情，而不是 `SPU`。因为到了交易阶段，系统关心的是：

- 具体买哪个变体
- 这个变体当前什么价格
- 这个变体对应哪组库存

这再次证明：**SPU 是展示和归类单位，SKU 才是进入交易链的真实单位。**

## 这套模型真正做出的三层分工

到这里可以把整个商品模型压缩成三层：

```text
SPU
  负责：商品共性、详情外壳、分类归属、展示主入口

SKU
  负责：规格变体、价格、原价、交易入口、购物车/订单引用单位

Inventory
  负责：真实库存、预扣/确认/释放、补偿与对账
```

这三层分工里最容易被忽略的一条，是 SKU 虽然是交易单位，但它仍然不是库存真相本身。`my-xhs` 明确拒绝了“交易变体 = 库存系统”的偷懒建模，把库存进一步独立了出去。

## 真实故障案例：为什么 SKU 的 `stock` 字段会误导整个读链

这套模型里最反直觉、也最容易出事故的地方，就是 `SKU` 表里明明还有 `stock` 字段，但系统又反复强调“真实库存不看它”。

### 现象

如果调用者偷懒，重新把 `stock` 暴露回 `SkuVO`，或者前端/聚合层直接误读实体里的 `SKU.stock` 当成真实库存来展示或校验，那么会立刻得到一条看似合理、实际错误的数据链：

- 商品域返回一个库存数字
- 购物车或详情页直接信这个数字
- 订单再按另一个库存源做真正校验

最终就会出现展示层和交易层看到的库存不是同一个世界。

### 根因

根因不是字段不存在，而是字段语义已经变了。

`my-xhs-product/src/main/java/com/myxhs/product/entity/Sku.java:15` 明确说 `stock` 是冗余占位字段；`my-xhs-product/src/main/java/com/myxhs/product/dto/response/SkuVO.java:10` 到 `:12` 则进一步把它从对外返回模型里直接删掉。这说明商品域已经试图从模型层防止误用。

### 修复

修复思路不是“把 stock 字段彻底删掉”，而是：

1. 在对外 `VO` 中不暴露这个字段。
2. 在商品详情聚合时显式从 `inventory` 服务查真实库存。这个路径在 `my-xhs-home/src/main/java/com/myxhs/home/feign/InventoryFeignClient.java:21` 定义为 `/api/inventory/stock/{skuId}`，并在 `my-xhs-home/src/main/java/com/myxhs/home/service/ProductAggService.java:192` 真正被调用。
3. 在购物车、订单等后续链路里也统一以 `inventory` 为准。

### 验证

验证是否修好，不是看 `SKU` 表里还有没有 `stock`，而是看：

- `SkuVO` 是否仍不暴露 `stock`
- 商品详情是否从 `inventory` 聚合库存
- 下单前是否仍由订单侧调用库存服务做真正校验

### 余波

这个案例的价值在于，它提醒我们：**模型里的字段不等于字段语义永远不变。** 一旦库存域被拆出去，`SKU.stock` 这种历史字段就会从真相降级成兼容占位。如果后续分析不先把这件事讲清楚，后面的库存篇、购物车篇、订单篇都会在第一步就踩坑。

## 这一篇先收束成一张总图

```text
SPU
  回答：这是什么商品
  持有：名称、类目、品牌、描述、图片、上/下架状态
  对外：商品详情的外壳

SKU
  回答：这个商品当前卖哪一种具体变体
  持有：spuId、价格、原价、规格、状态
  对外：购物车和订单引用的交易单位

Inventory
  回答：这个变体现在到底还有多少可卖库存
  持有：真实库存时序与补偿逻辑
  对外：详情页库存、下单前校验、支付后确认扣减
```

这里最重要的不是记住名词定义，而是三条判断：

1. `SPU` 是商品共性真相，不是交易单位。
2. `SKU` 是交易变体真相，但不是库存真相。
3. 详情页暴露的是 `SPU + SKU` 组合体，交易链引用的是 `SKU + Inventory` 组合体：订单先在 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:151` 拉取 `SKU` 真值，再在 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:173` 调库存服务做前置校验，说明交易链里这两类事实从一开始就是分开进入的。

## 证据清单

这篇的关键判断主要由以下证据托底：

- `SPU` 共性模型：`my-xhs-product/src/main/java/com/myxhs/product/entity/Spu.java:9`
- `SKU` 变体模型与 `stock` 降级语义：`my-xhs-product/src/main/java/com/myxhs/product/entity/Sku.java:11`
- `SkuVO` 不暴露真实库存：`my-xhs-product/src/main/java/com/myxhs/product/dto/response/SkuVO.java:8`
- `SpuDetailVO` 以 `SPU + SKU 列表` 对外返回：`my-xhs-product/src/main/java/com/myxhs/product/dto/response/SpuDetailVO.java:8`
- `SPU` 详情入口挂缓存、布隆过滤器与一致性策略：`my-xhs-product/src/main/java/com/myxhs/product/service/SpuService.java:48`、`my-xhs-product/src/main/java/com/myxhs/product/service/SpuService.java:116`
- 专用异步线程池与 MDC 透传：`my-xhs-product/src/main/java/com/myxhs/product/service/SpuService.java:75`
- 布隆过滤器就绪降级与空过滤器重载：`my-xhs-product/src/main/java/com/myxhs/product/service/SpuService.java:120`、`my-xhs-product/src/main/java/com/myxhs/product/service/SpuService.java:163`
- 布隆过滤器分布式锁 + 二次检查：`my-xhs-product/src/main/java/com/myxhs/product/service/SpuService.java:188`
- `SPU` 部分更新与延迟双删：`my-xhs-product/src/main/java/com/myxhs/product/service/SpuService.java:301`
- 冷 key miss 的真实防惊群修复：`my-xhs-product/src/main/java/com/myxhs/product/service/SpuService.java:485`
- `SPU` 创建路径：`my-xhs-product/src/main/java/com/myxhs/product/service/SpuService.java:256`
- `SKU` 创建路径与 SPU 缓存失效：`my-xhs-product/src/main/java/com/myxhs/product/service/SkuService.java:47`
- `SKU` 批量读取时补 SPU 图与 SPU 状态：`my-xhs-product/src/main/java/com/myxhs/product/service/SkuService.java:100`、`my-xhs-product/src/main/java/com/myxhs/product/service/SkuService.java:175`
- 商品详情真实库存来自 inventory 聚合：`my-xhs-home/src/main/java/com/myxhs/home/feign/InventoryFeignClient.java:21`、`my-xhs-home/src/main/java/com/myxhs/home/service/ProductAggService.java:192`
- 购物车以 `skuId` 组织交易准备态：`my-xhs-cart/src/main/java/com/myxhs/cart/service/CartService.java:384`
- 订单以 `SKU + Inventory` 组合进入交易校验：`my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:151`、`my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:173`

## 边界清单

- 本篇只回答商品模型为什么切成 `SPU / SKU / Inventory` 三层，不展开分类树、价格体系、库存时序和商品详情聚合的全部细节，这些分别留给后续篇章。
- “SKU 不是库存真相”在本文属于源码明确支持的强结论，不是推测。
- `SKU.stock` 仍保留在实体里，说明系统存在历史兼容或占位负担；但本文不进一步追溯这个字段的演化历史，只讨论当前语义。
- 商品域和库存域的分界已经在本篇建立；后续库存篇不应再把库存问题当成商品字段问题重复讲。
- `ai-app`、`ai-mcp`、`ai-tools` 不进入本篇分析线。

## 这篇解决了什么，还留下什么问题

这篇先解决了三个问题：

- 为什么 `my-xhs` 不用一张商品表，而要拆成 `SPU` 和 `SKU` 两层。
- 为什么 `SKU` 虽然是交易单位，却仍然不能承载真实库存真相。
- 为什么详情页、购物车、订单三条读写路径会分别引用这三层模型中的不同部分。

但它还留下了两个更具体的问题：

- 商品类目、分类树和价格体系，怎样继续约束 `SPU / SKU` 模型？
- 商品详情对外暴露时，为什么要再经过一轮跨域聚合，而不是停在商品服务本地？

所以下一篇应该进入 `02-category-price.md`，先把类目树和价格体系立住，再看这个模型怎样被业务规则继续约束。至于“商品详情为什么还要跨域聚合库存、计数和后续视图”，会在 `03-product-detail.md` 里继续展开。
