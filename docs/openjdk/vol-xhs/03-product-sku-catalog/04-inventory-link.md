# 商品域与库存域的衔接

> 对应目录：`vol-xhs/03-product-sku-catalog/`
> 目标问题：为什么 `SKU` 明明已经是可交易变体，`my-xhs` 却仍然不让它持有真实库存真相？商品域和库存域到底怎样衔接，才能既让详情页读到库存，又让订单链按正确时序扣减库存？

## 一句话困惑

到了这里，商品域已经建立了三层关键判断：

- `SPU` 是商品共性真相
- `SKU` 是交易变体真相
- 真实库存不在 `SKU.stock`，而在独立的 `inventory` 域

但这会立刻带来一个新的疑问：**既然库存真相不在商品域里，那商品域和库存域到底靠什么衔接？**

尤其是对第一次接触这套系统的读者来说，这个地方非常容易产生认知断裂：

- 前台详情页明明按 `spuId` 打开，却又要显示每个 `SKU` 是否有货。
- 购物车保存的是 `skuId`，但购物车本身不拥有库存真相。
- 订单下单时既要信商品域给出的规格和价格，又要信库存域给出的可用库存。

如果不把这个衔接点讲清楚，前面几篇建立起来的 `SPU / SKU / Inventory` 三层分工，读者会记住名词，却不知道系统真正怎么把它们接起来。

## 一句话答案

`my-xhs` 用 `SKU` 作为商品域通向库存域的桥接键：商品域负责定义“卖的是哪个变体”，库存域负责定义“这个变体现在还能卖多少”；两者通过 `skuId` 对齐，但商品域不吞库存真相，库存域也不反向重建商品模型。

## 先建立一个最小桥接模型

先把这两个域的分工压缩成一张最小图：

```text
product 域
  SPU → 商品母体
  SKU → 可交易变体（价格、规格、状态）

inventory 域
  Inventory(skuId) → 该变体当前的真实库存时序
```

这里最重要的一条线是：

```text
SKU.id  ==  Inventory.skuId
```

这不是巧合，而是整个系统有意选定的衔接点。

`Inventory` 实体在 `my-xhs-inventory/src/main/java/com/myxhs/inventory/entity/Inventory.java:12` 到 `:16` 已经把自己的语义写穿了：

- 一条记录对应一个 `SKU`
- `available_stock` 表示可用库存
- `locked_stock` 表示预扣未确认库存
- 总库存是两者之和

实现层同样延续了这个选择。`InventoryController.initStock()` 在 `my-xhs-inventory/src/main/java/com/myxhs/inventory/controller/InventoryController.java:52` 到 `:64` 初始化库存时只接受 `skuId`，`InventoryService.initStock()` 在 `my-xhs-inventory/src/main/java/com/myxhs/inventory/service/InventoryService.java:147` 到 `:193` 也只围绕 `skuId` 建 Redis 总库存、分桶和 MySQL 记录。也就是说，库存域不是按 `SPU` 建模，也不是按“商品名称”建模，而是从一开始就承认：**库存只能精确到可交易变体这一层。**

## 先推演第一个失败方案：让 product 域直接持有真实库存

这是最直觉、也最常见的做法。

### 为什么这个方案很诱人

因为 `SKU` 本来就像最自然的库存宿主：

- 它已经代表可交易变体
- 它已经有规格、价格、状态
- 它甚至在实体里还有一个 `stock` 字段

如果系统规模不大，很多人会自然而然地得出：既然 `SKU` 和库存看起来关系最紧，那就让商品域自己把库存也管了。

### 它在 `my-xhs` 上先坏在哪里

这个方案一旦放进真实交易时序，很快会暴露三个问题。

#### 第一处断裂：商品域的读模型和库存域的写模型不是同一类问题

商品域关心的是：

- 这个商品是什么
- 这个 `SKU` 卖多少钱
- 当前上不上架
- 前台应该怎样展示

库存域关心的是：

- 当前可用库存还有多少
- 某笔订单是否已经预扣
- 预扣能不能确认
- 失败后怎么释放或回补

前者更像稳定读模型，后者更像高并发时序状态机。把它们塞进一个域里，会让商品域被迫承担库存扣减、预扣、补偿和对账这些完全不同的责任。

#### 第二处断裂：详情页读库存和订单扣库存不是同一件事

详情页需要的是“此刻给用户看一个库存视图”，而订单链需要的是“以原子方式预扣、确认、释放库存”。这两类操作虽然都叫“查库存/扣库存”，但时序要求完全不同。

如果把它们都塞回 `product` 域，详情页和订单链就会挤在同一套模型里，最后很容易为了扣减正确性牺牲展示路径，或者为了展示路径简单化弱化交易保护。

#### 第三处断裂：库存一旦进入补偿链，商品域会被交易链反向绑死

`InventoryService` 注释在 `my-xhs-inventory/src/main/java/com/myxhs/inventory/service/InventoryService.java:37` 到 `:49` 已经明确写了自己的三级扣减职责：

- Redis 分桶预扣
- MQ 异步扣 MySQL
- 定时对账修复

这类逻辑一旦回到商品域，商品域就不再是纯商品主数据域，而会被迫长出交易链最重的并发和一致性逻辑。

### `my-xhs` 为什么明确不这么做

系统已经把这条边界写在对外模型里。`SkuVO` 在 `my-xhs-product/src/main/java/com/myxhs/product/dto/response/SkuVO.java:10` 到 `:12` 明确写着：

- 不含 `stock`
- `SKU` 表里的 `stock` 是冗余占位值
- 真实库存以 `inventory` 服务为准

这说明商品域不是“没有能力管库存”，而是**主动拒绝把库存真相继续留在自己这里。**

## 再推演第二个失败方案：让 inventory 域反向持有商品模型

既然不让 product 持有真实库存，另一种也很容易滑过去的误解是：那不如让 inventory 域自己也多带一点商品信息，甚至把商品模型反向揉进去。

### 为什么这套思路也有诱惑力

因为库存域最终也要对外提供 `/stock/{skuId}` 查询，看起来它完全可以顺手把：

- 商品名称
- 规格描述
- 价格
- 图片

都一起带回来。这样前台和订单甚至可以少调用一次商品域。

### 它真正的问题

这会把库存域反向变成一个“半商品域”。

库存域当前控制器的职责边界非常清楚。`my-xhs-inventory/src/main/java/com/myxhs/inventory/controller/InventoryController.java:21` 到 `:26` 明确写着：

- 提供库存初始化、预扣减、确认、释放、查询等接口
- 预扣减/确认/释放供订单服务内部调用
- 查询接口可公开访问，用于商品详情页展示库存

也就是说，库存域的查询接口对外只回答一个问题：**这个 `skuId` 现在还有多少可用库存。**

如果让库存域顺手把商品模型也一起托管，它就开始承担原本属于商品域的演进责任：名称变了怎么办，图片变了怎么办，规格序列化规则变了怎么办，SPU 下架了怎么办。库存域就会被商品模型反向污染。

### `my-xhs` 为什么也不这么做

`InventoryController.getStock()` 在 `my-xhs-inventory/src/main/java/com/myxhs/inventory/controller/InventoryController.java:135` 到 `:140` 暴露的只是 `/api/inventory/stock/{skuId}`，返回的是 `StockVO`。而 `StockVO` 在 `my-xhs-inventory/src/main/java/com/myxhs/inventory/dto/response/StockVO.java:13` 到 `:26` 只包含：

- `skuId`
- `availableStock`
- `lockedStock`
- `bucketCount`
- `initialized`

它不返回商品名称、图片、价格，也不重建 `SPU / SKU` 语义。这说明系统对这条边界同样有自觉：

- `product` 负责定义“这个 `skuId` 是什么商品变体”
- `inventory` 负责定义“这个 `skuId` 还有多少库存”

衔接靠同一个 `skuId`，而不是靠某一边吞掉另一边的模型。

## 这两个域真正靠什么衔接

到这里可以先把答案说破：**它们靠 `skuId` 衔接。**

但这句话还不够，要继续拆成两层。

### 第一层：商品域负责稳定地产生 `skuId`

`SkuService.createSku()` 在 `my-xhs-product/src/main/java/com/myxhs/product/service/SkuService.java:51` 到 `:80` 中创建 `SKU`：

- 校验 `SPU` 存在
- 生成 `sku.id`
- 写入 `price / originalPrice / specs / status`

这里真正重要的，不只是写库，而是它定义了一个全系统共享的交易变体标识：`skuId`。

### 第二层：库存域把 `skuId` 视为自己的唯一业务键

`Inventory` 实体在 `my-xhs-inventory/src/main/java/com/myxhs/inventory/entity/Inventory.java:28` 到 `:35` 中，把 `skuId` 作为库存记录的宿主键，并围绕它维护：

- `availableStock`
- `lockedStock`
- `freezingStock`

也就是说，库存域没有自己的“商品概念”，它只接受商品域产出的 `skuId`，然后围绕这个键维护库存时序真相。

这才是系统真正的桥接方式：

```text
product 产出可交易标识（skuId）
inventory 接管这个标识对应的库存时序
```

## 这条桥怎样进入详情页读路径

详情页要展示“这个规格现在还有没有货”，所以最先暴露商品域和库存域衔接问题的，就是前台读路径。

`home` 侧的 `InventoryFeignClient` 在 `my-xhs-home/src/main/java/com/myxhs/home/feign/InventoryFeignClient.java:18` 到 `:22` 只做一件事：按 `skuId` 查询可用库存。

对应的聚合逻辑在 `ProductAggService`：

- 先通过商品域拿 `SPU` 详情和 `SKU` 列表，见 `my-xhs-home/src/main/java/com/myxhs/home/service/ProductAggService.java:61` 到 `:76`
- 再遍历 `skuListRaw`，按每个 `skuId` 去库存域查询，见 `my-xhs-home/src/main/java/com/myxhs/home/service/ProductAggService.java:183` 到 `:200`
- 最终把 `availableStock` 和 `hasStock` 回填进 `SkuWithStockVO`，见 `my-xhs-home/src/main/java/com/myxhs/home/service/ProductAggService.java:220` 到 `:239`

这说明详情页的桥接方式不是：

```text
product 直接带库存返回
```

而是：

```text
product 先给出 SKU 列表
home 再拿 skuId 逐个去 inventory 查库存
```

也就是说，详情页读路径承认了一个事实：**商品骨架和库存视图来自两个域，只能在聚合层会合。**

## 这条桥又怎样进入订单执行链

读路径只是展示层，真正更关键的是交易链。

订单侧的 `InventoryFeignClient` 在 `my-xhs-order/src/main/java/com/myxhs/order/feign/InventoryFeignClient.java:23` 到 `:43` 明确列出四种库存动作：

- `/stock/{skuId}`：下单前校验
- `/release`：取消或超时释放
- `/refund-restore`：退款回补
- `/confirm`：支付成功后确认扣减

这四个接口说明，库存域不是订单域里的一次字段读取，而是交易链中的一个完整参与者。

在 `OrderService` 里，这条桥接已经真正落到不同业务时机：

- 创建订单前，先从商品域批量拉 `SKU` 真值，再按每个 `skuId` 调库存域做前置校验，见 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:147` 到 `:156`、`my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:171` 到 `:183`
- 支付成功后，再按订单时机确认扣减，见 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:716` 到 `:745`
- 超时关单后，再按订单时机释放库存，见 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:775` 到 `:776`，其联动释放逻辑会继续调用库存域
- 退款成功后，再按订单时机回补库存，见 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:798` 到 `:815`

这意味着下单时并不是“商品域告诉订单库存是多少”，而是：

1. 商品域告诉订单：你买的是哪些 `skuId`
2. 库存域再对这些 `skuId` 分别回答：现在能不能扣、之后怎么扣

这正是这条桥接最重要的地方：**商品域负责定义交易对象，库存域负责定义交易对象的库存命运。**

## 库存域为什么要比商品域更重

读者走到这里，经常会自然追问：既然两边都是围绕 `skuId`，为什么库存域明显比商品域更重，甚至重得多？

答案恰恰在于，它们虽然共享键，但不共享问题类型。

### 商品域更像主数据域

商品域重点解决的是：

- 商品长什么样
- 规格怎么组织
- 价格怎么表达
- 上下架怎么展示
- 详情怎么缓存

这些问题多数偏读模型、主数据和展示语义。

### 库存域更像高并发时序域

库存域重点解决的是：

- 高并发预扣是否超卖
- 预扣记录如何过期
- 支付成功后如何确认
- 失败后如何释放
- Redis 与 MySQL 怎样最终一致

`InventoryService` 从 `my-xhs-inventory/src/main/java/com/myxhs/inventory/service/InventoryService.java:37` 开始，几乎整段都围绕“分桶预扣 + 三级扣减保证”展开。这类问题本质上已经不是商品建模，而是交易时序建模。

所以系统刻意把库存真相拆出去，不是为了多一个服务，而是为了让高并发时序问题不要污染商品主数据域。

## 真实故障案例：为什么 `SKU.stock` 一旦被误当真相，详情页和交易链会看到两个世界

这一篇最值得抓住的真实风险，就是“同一个 `skuId`，展示层和交易层为什么可能看到两个不同的库存世界”。

### 现象

如果有人重新把 `SKU.stock` 当真相，那么前台详情页、购物车甚至某些调试脚本都可能直接显示这个数字；但订单链在真正下单时，又会去库存域查 `availableStock`。

于是就会出现最糟糕的一类体验：

- 页面显示有货
- 用户加了购物车
- 下单时库存不足

或者反过来：

- 页面显示库存不变
- 真实库存已经预扣
- 同一时间不同入口看到的剩余量完全不同

### 根因

根因不是“库存查询慢”或“前端没刷新”，而是**商品域和库存域的边界被破坏了**。`skuId` 本来只应该承担桥接键的角色，一旦商品域自己又开始声称“我也知道真实库存”，整个桥就变成了两个域同时争抢同一块真相。

### 修复

`my-xhs` 当前给出的修法是成体系的：

1. `SkuVO` 不暴露 `stock`，见 `my-xhs-product/src/main/java/com/myxhs/product/dto/response/SkuVO.java:10` 到 `:12`
2. 详情页统一通过 `home → inventory` 聚合库存，见 `my-xhs-home/src/main/java/com/myxhs/home/service/ProductAggService.java:192`
3. 订单前置校验统一通过 `order → inventory` 走交易链检查，见 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:173`

### 验证

验证是否真的守住这条边界，不是看表里还有没有 `stock` 字段，而要看：

- 对外 `VO` 是否仍不暴露 `stock`
- 商品详情是否仍通过库存服务补齐库存
- 订单链是否仍通过库存服务做前置校验、确认、释放与回补

### 余波

这个案例的真正价值在于，它把“为什么要拆库存域”从抽象设计问题，变成了一个非常现实的系统一致性问题。**如果 `skuId` 这座桥两边都抢着定义库存，系统就会从一个世界分裂成两个世界。**

## 这一篇先收束成一张总图

```text
product 域
  定义：SPU / SKU 模型
  产出：skuId（交易变体标识）
  不持有：真实库存时序

inventory 域
  接收：skuId
  维护：available / locked / freezing 三段库存状态
  对外：查询、预扣、确认、释放、退款回补

桥接关系
  详情页：product 给 SKU 列表 → home 用 skuId 查 inventory
  订单链：product 给 SKU 真值 → order 用 skuId 查 inventory
```

这里最重要的不是“两个服务互相调了接口”，而是三条判断：

1. `skuId` 是商品域通向库存域的桥接键，不是库存真相本身。
2. 商品域定义交易对象，库存域定义交易对象的库存命运。
3. 详情页和订单链都要跨过这座桥，但跨桥后的问题完全不同：一个是展示视图，一个是交易时序。

## 证据清单

这篇的关键判断主要由以下证据托底：

- `SkuVO` 明确不暴露真实库存：`my-xhs-product/src/main/java/com/myxhs/product/dto/response/SkuVO.java:10`
- 库存实体以 `skuId` 为宿主键：`my-xhs-inventory/src/main/java/com/myxhs/inventory/entity/Inventory.java:12`
- 库存控制器的边界与公开查询入口：`my-xhs-inventory/src/main/java/com/myxhs/inventory/controller/InventoryController.java:21`、`my-xhs-inventory/src/main/java/com/myxhs/inventory/controller/InventoryController.java:135`
- 库存域初始化时只接受 `skuId`：`my-xhs-inventory/src/main/java/com/myxhs/inventory/controller/InventoryController.java:52`、`my-xhs-inventory/src/main/java/com/myxhs/inventory/service/InventoryService.java:147`
- 库存查询模型只回答库存，不重建商品模型：`my-xhs-inventory/src/main/java/com/myxhs/inventory/dto/response/StockVO.java:13`
- 库存域的三级扣减职责：`my-xhs-inventory/src/main/java/com/myxhs/inventory/service/InventoryService.java:37`
- 详情页按 `skuId` 聚合库存：`my-xhs-home/src/main/java/com/myxhs/home/feign/InventoryFeignClient.java:18`、`my-xhs-home/src/main/java/com/myxhs/home/service/ProductAggService.java:192`
- 订单链按 `skuId` 校验/确认/回补库存：`my-xhs-order/src/main/java/com/myxhs/order/feign/InventoryFeignClient.java:23`、`my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:171`、`my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:716`、`my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:798`
- `SKU` 作为交易变体的创建与主数据来源：`my-xhs-product/src/main/java/com/myxhs/product/service/SkuService.java:51`

## 边界清单

- 本篇只回答“商品域如何与库存域衔接”，不展开库存域内部的分桶算法、TCC、对账和补偿细节，这些放到库存专题详讲。
- `SKU.stock` 仍保留在实体中，但在当前实现里只具备冗余占位语义；本篇不追溯它的历史演化，只讨论当前系统如何防止误用。
- 详情页和订单链都跨商品域与库存域，但前者是读聚合语义，后者是交易时序语义，不应混写成同一类调用。
- `ai-app`、`ai-mcp`、`ai-tools` 不进入本篇分析线。

## 这篇解决了什么，还留下什么问题

这篇先解决了三个问题：

- 为什么 `SKU` 虽然是交易单位，却仍然不能持有真实库存真相。
- 商品域和库存域真正靠什么衔接，以及为什么这个衔接点必须是 `skuId`。
- 为什么详情页和订单链都要跨域查库存，但两者跨域的语义完全不同。

到这里，`03-product-sku-catalog` 这一组的四篇已经把商品域最核心的骨架立住了：

- `01-spu-sku-model.md` 讲清了 `SPU / SKU / Inventory` 三层分工
- `02-category-price.md` 讲清了类目树和价格体系怎样约束这个模型
- `03-product-detail.md` 讲清了商品详情为什么会演化成跨域聚合模型
- `04-inventory-link.md` 讲清了商品域和库存域到底怎样衔接

下一步就该进入交易前置环节：`04-cart-coupon-marketing/01-cart-merge.md`，从购物车为什么先落 Redis、登录后为什么要合并匿名购物车开始，把交易主链再往前推一段。