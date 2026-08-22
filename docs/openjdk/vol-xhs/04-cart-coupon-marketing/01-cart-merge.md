# 购物车合并

> 对应目录：`vol-xhs/04-cart-coupon-marketing/`
> 目标问题：为什么登录后匿名购物车不能简单覆盖或简单相加，而必须走一套专门的合并逻辑？这套合并逻辑到底在保护什么？

## 一句话困惑

购物车合并听起来像是交易前置链里最“轻”的一个动作：用户登录之后，把未登录时加过的商品同步到登录态购物车里，好像就结束了。

但只要把这个问题多追问一步，就会发现它一点都不轻：

- 匿名态和登录态里出现了同一个 `skuId`，数量是相加、覆盖，还是取较大值？
- 登录态购物车本来已经有勾选状态，匿名态合并进来时要不要覆盖？
- 合并时如果某个 SKU 已经不存在或已下架，是跳过、报错，还是把脏条目写进去再让后面清理？
- 购物车当前以 Redis 为权威数据源，合并时到底是先写 MySQL，还是先写 Redis？

这篇要回答的不是“登录时调了 `/api/cart/merge`”，而是：**为什么购物车合并在 `my-xhs` 里是一套独立的业务规则，而不是一个简单的批量插入动作。**

## 一句话答案

在 `my-xhs` 里，匿名购物车合并本质上是在把“一个临时的、无身份归属的待购集合”，安全地并入“一个已经有身份、勾选态、排序态和持久化链路的权威购物车”；它必须同时守住去重、数量上限、商品存在性、勾选状态不被误覆盖，以及 Redis 三结构一致性这几条约束，所以绝不只是“把列表拷过去”。

## 先建立最小心智模型

先别急着看合并逻辑，先明确购物车在这个系统里的地位。

`CartController` 在 `my-xhs-cart/src/main/java/com/myxhs/cart/controller/CartController.java:19` 到 `:23` 已经把这个域的核心判断写穿了：

- 所有接口需登录
- 购物车操作以 Redis 为权威数据源
- MQ 异步持久化到 MySQL

服务层注释又进一步把模型展开。`CartService` 在 `my-xhs-cart/src/main/java/com/myxhs/cart/service/CartService.java:31` 到 `:47` 明确写了三件事：

1. Redis 三结构协同：`Hash + Set + ZSet`
2. Redis 为权威数据源，MQ 异步持久化到 MySQL
3. Feign 调商品服务获取 SKU 信息并标记失效商品

把这套模型压缩成一句人话就是：

```text
购物车 = 以 userId 为归属、以 skuId 为元素、以 Redis 为权威承载的待购集合
```

一旦接受这个定义，就会立刻明白：匿名购物车合并不是“复制数组”，而是**把一组还没有正式归属的待购元素并入一个已经存在的权威集合。**

## 先推演第一个最直觉的失败方案：登录后直接覆盖登录态购物车

很多系统最先想到的方案是：用户一登录，就把匿名购物车整个覆盖到登录态购物车上。

### 为什么这个方案很诱人

因为它实现简单：

- 匿名态就是一份临时列表
- 登录态就是一份正式列表
- 登录时用临时列表替换正式列表

前端甚至都很容易配合：把匿名态本地缓存整包提交给后端，后端直接写进去就行。

### 它会先坏在哪里

它会立刻破坏登录态购物车已经存在的用户意图。

假设用户在另一台设备上已经登录，并且做过以下动作：

- 某个 SKU 已加购
- 数量已经调大
- 勾选状态已经调成未选中

这时如果本机匿名购物车登录后直接覆盖，登录态原有的数量和勾选状态都会被抹掉。用户不会觉得“系统做了一次同步”，只会觉得“我之前调好的购物车被重置了”。

也就是说，覆盖方案的问题不是技术失败，而是业务语义失败：**它把登录态权威集合当成了一个可以随便被匿名态重写的临时草稿。**

## 再推演第二个也很直觉的失败方案：同 SKU 数量直接相加

另一种看起来更“聪明”的方案是：既然覆盖不行，那相同 `skuId` 就把数量加起来。

### 为什么这也很有诱惑力

因为相加看起来最符合“合并”字面意思：

- 匿名态有 2 个
- 登录态有 3 个
- 合并后就是 5 个

这似乎既没有丢失任一边的数据，也保留了双方的操作结果。

### 它真正会先坏在哪里

相加最容易在两个地方出错：

#### 第一处：它会把“重复操作”误解释成“用户真的要买更多”

匿名态里的 2 个，不一定是用户有意想和登录态里的 3 个叠加；它也可能只是两端分别保存了同一次购买意图的不同残影。如果直接相加，系统就会擅自替用户放大购买数量。

#### 第二处：它极易踩上数量上限和幂等重试问题

`CartMergeRequest` 在 `my-xhs-cart/src/main/java/com/myxhs/cart/dto/request/CartMergeRequest.java:18` 到 `:34` 已经明确限定：

- 一次最多合并 50 个商品
- 单个商品数量 1-99

如果同一个匿名购物车因为网络超时被重试，直接相加会让同一批条目反复叠上去，最后不仅可能超出 99，还会让一次幂等重试变成重复加购。

### `my-xhs` 为什么明确不这么做

`CartService.mergeAnonymousCart()` 的注释在 `my-xhs-cart/src/main/java/com/myxhs/cart/service/CartService.java:483` 到 `:491` 已经把策略写得非常清楚：

- 同一 SKU：取较大数量，但不超过 99
- 新 SKU：直接加入，但总数不超过 50
- 合并操作天然幂等，多次合并结果一致，因为取的是 `max`

也就是说，系统明确把“合并”解释成：

**保留两个购物车里对同一 SKU 的较强购买意图，而不是把两个来源的数量机械相加。**

这就是这条业务规则最核心的设计取舍。

## 匿名购物车请求里到底带什么

`CartMergeRequest` 在 `my-xhs-cart/src/main/java/com/myxhs/cart/dto/request/CartMergeRequest.java:13` 到 `:35` 的结构非常克制：

- 只带 `items`
- 每项只带 `skuId`
- 每项只带 `quantity`

它没有带：

- 商品名称
- 价格
- 勾选状态
- 排序时间

这说明匿名购物车在后端视角里，只是一组最小化的“待购意图片段”：

```text
我想买哪个 sku
我想买几个
```

剩下的真相——商品是否存在、是否仍可卖、应该怎样写进三结构、勾选态怎么继承——都要由登录态购物车系统自己决定，而不是让匿名请求体自己定义。

## 真正的合并逻辑到底在做什么

合并入口在 `my-xhs-cart/src/main/java/com/myxhs/cart/controller/CartController.java:103` 到 `:113`，真正执行逻辑在 `CartService.mergeAnonymousCart()`，从 `my-xhs-cart/src/main/java/com/myxhs/cart/service/CartService.java:494` 开始。

把这个方法拆开看，它实际上在守四层边界。

## 第一层：先过滤非法或无意义输入

方法一进来就先处理两类最轻的失败输入：

- `items` 为空直接返回，见 `my-xhs-cart/src/main/java/com/myxhs/cart/service/CartService.java:495` 到 `:496`
- `skuId` 为空、数量为空、数量不大于 0 的条目直接跳过，见 `my-xhs-cart/src/main/java/com/myxhs/cart/service/CartService.java:503` 到 `:506`

这说明系统把匿名态请求当成“不完全可信”的输入，而不是默认每一条都必须写进正式购物车。

## 第二层：先校验 SKU 是否仍然存在

这是合并逻辑里很关键的一步。

`CartService` 在 `my-xhs-cart/src/main/java/com/myxhs/cart/service/CartService.java:508` 到 `:512` 里明确写了：合并时同样校验 `SKU` 存在性，不让幽灵条目进入购物车。

对应的存在性校验最终通过 `ProductFeignClient.getSkuDetail()` 完成，见：

- `my-xhs-cart/src/main/java/com/myxhs/cart/feign/ProductFeignClient.java:29` 到 `:36`
- `my-xhs-cart/src/main/java/com/myxhs/cart/service/CartService.java:605` 到 `:613`

这一步的意义很大：它说明匿名购物车不是一个“只要前端说有，我就收下”的容器，而是登录时要被重新对齐到商品真相上的。

如果某个 `skuId` 已经不存在，系统选择的是跳过，而不是让脏数据继续混进正式购物车。

## 第三层：真正的合并写入发生在 Redis 三结构里，而且必须原子完成

这条边界是整篇的核心。

购物车不是一张简单表，而是 Redis 三结构：

- `items`：商品与数量，`Hash`
- `checked`：勾选状态，`Set`
- `sort`：加购时间排序，`ZSet`

对应定义见 `my-xhs-cart/src/main/java/com/myxhs/cart/service/CartService.java:43` 到 `:47`。

合并时，系统并没有用“查一下有没有，再 put 一下”的普通写法，而是直接执行 Lua 脚本，见 `my-xhs-cart/src/main/java/com/myxhs/cart/service/CartService.java:516` 到 `:524`。

注释已经把它的真正意图写出来：

- 已有项：`HGET + max() + HSET`
- 新项：`HLEN + HSET + SADD + ZADD NX`
- 整体在同一段 Lua 里原子执行

这说明合并逻辑真正保护的不是“写进去就行”，而是：

1. 同一 `skuId` 的最终数量要按规则收敛
2. 三结构不能出现半成功中间态
3. 并发删除后不能因为 merge 再把已删条目复活成脏状态

所以登录合并不是一个批处理，而是一次对 Redis 权威集合的原子整形操作。

## 第四层：合并之后还要通过 MQ 把变化异步落到 MySQL

即使 Redis 已经是权威数据源，系统仍然不会在合并后就此停下。

`CartSyncEvent` 在 `my-xhs-cart/src/main/java/com/myxhs/cart/dto/event/CartSyncEvent.java:12` 到 `:34` 定义了购物车同步事件；`mergeAnonymousCart()` 在不同分支里，会分别发送：

- `UPDATE` 事件，见 `my-xhs-cart/src/main/java/com/myxhs/cart/service/CartService.java:534` 到 `:536`
- `ADD` 事件，见 `my-xhs-cart/src/main/java/com/myxhs/cart/service/CartService.java:538` 到 `:540`

最终事件通过 `sendCartSyncEvent()` 进入 `CART_TOPIC`，见 `my-xhs-cart/src/main/java/com/myxhs/cart/service/CartService.java:659` 到 `:689`。而真正把这条事件落到 MySQL 的是 `CartSyncConsumer`：`my-xhs-cart/src/main/java/com/myxhs/cart/consumer/CartSyncConsumer.java:22` 到 `:30` 明确写着“将购物车变更异步持久化到 MySQL”，并在 `:64` 到 `:69` 按 `ADD / UPDATE / DELETE / CHECK / CHECK_ALL / CLEAR` 分流处理；其中 `upsertCartItem()` 会真正执行 `insert` 或 `updateById`，见 `my-xhs-cart/src/main/java/com/myxhs/cart/consumer/CartSyncConsumer.java:91` 到 `:144`。

也就是说，登录合并的数据流其实是：

```text
前端匿名 items
  → cart merge
    → Redis 三结构原子收敛（权威）
    → MQ 事件
      → MySQL 异步持久化
```

这一步非常关键，因为它说明：**合并是购物车权威态的一次正式变更，不是登录时的临时拼接。**

这里还要补一个容易被忽略的分布式细节：`sendCartSyncEvent()` 并不是简单地把 `System.currentTimeMillis()` 塞进事件，而是叠加了同实例内单调递增的 `EVENT_SEQ`，见 `my-xhs-cart/src/main/java/com/myxhs/cart/service/CartService.java:54` 到 `:55` 和 `:668` 到 `:670`。它防的是同毫秒内连续事件在消费端被 `updatedAt >= eventTime` 误判成旧消息而跳过。也就是说，购物车链不是只靠 MQ 保序，而是还额外修了“同毫秒时间戳碰撞”这个很细的乱序边界。

## 为什么已有商品不覆盖勾选状态，而新商品默认勾选

这是这套合并逻辑里最值得细看的业务取舍。

`mergeAnonymousCart()` 在 `my-xhs-cart/src/main/java/com/myxhs/cart/service/CartService.java:531` 到 `:540` 明确区分了两种情况：

- 如果是已有商品，Lua 不触碰 `checked` 集合，后续发 `UPDATE` 事件时 `checked=null`，不覆盖 MySQL 勾选态。
- 如果是新商品，Lua 会把它 `SADD` 进 `checked` 集合，后续发 `ADD` 事件时 `checked=1`，默认勾选。

这条规则其实在保护两个完全不同的用户意图：

1. **已有商品的勾选状态，是登录态用户已经表达过的正式意图，不应该被匿名态覆盖。**
2. **新合并进来的商品，默认视为“用户刚刚明确想买”，因此默认勾选更符合下单前语义。**

如果系统不区分这两类路径，要么会粗暴覆盖用户现有勾选态，要么会让新合并商品进入购物车后却默认不参与结算，体验也会很怪。

## 合并为什么必须天然幂等

购物车合并是一个很容易被网络重试击中的动作：

- 用户刚登录
- 前端发起 merge
- 网络抖动或超时
- 前端重试

如果后端没有把合并设计成幂等，购物车数量就会越合越多。

`CartService` 明确选择了“同一 SKU 取较大数量”的策略，本质上就是在给 merge 做幂等语义：

- 第一次合并：`2` 和 `3` → 取 `3`
- 第二次重试：还是 `2` 和 `3` → 还是 `3`

这比“简单相加”更像一次对最终意图的收敛，而不是一次对操作次数的累计。

也就是说，系统认为 merge 不是“加购动作重放”，而是“登录瞬间的一次状态合并”。这两者的语义完全不同。

## 为什么商品校验要放在 merge 之前，而不是留到购物车列表阶段再处理

有人可能会说：既然购物车列表本来就会去商品域补信息并标记无效商品，那 merge 阶段为什么还要校验 SKU 是否存在？留到列表页再兜底不就行了？

这看起来省事，但会带来一个很实际的问题：**脏条目已经进入了正式购物车权威态。**

一旦脏条目合并进 Redis 三结构：

- 它会被正式计入这个用户的待购集合
- 它可能参与排序、角标、数量统计
- 它还会被异步同步到 MySQL

之后再在列表页里标成无效，只是把症状暴露出来，并没有阻止脏数据进入系统。

所以 `my-xhs` 当前的策略是：

- merge 前做存在性校验，挡住最明显的幽灵 SKU
- 列表页仍保留 `valid` 标记作为第二层防御

这第二层防御在 `getCartList()` 里也有明确落点：`my-xhs-cart/src/main/java/com/myxhs/cart/service/CartService.java:430` 到 `:451` 会根据 `SKU` 和 `SPU` 状态给条目标记 `valid=false`，并写入 `invalidReason("商品已下架")` 或 `invalidReason("商品信息获取失败")`。也就是说，merge 负责阻止明显脏条目进入正式购物车，列表页再负责兜住后续状态变化带来的失效项。

这说明 merge 并不是一个“低价值前置动作”，而是脏数据正式进入权威购物车之前的第一道门。

这里还有一个更底层、但很容易被漏掉的微服务工程点：cart 调 product 的批量接口并不是靠业务代码手动拼 `X-Internal-Call`，而是通过 `InternalCallFeignConfig` 自动注入 Header，见 `my-xhs-cart/src/main/java/com/myxhs/cart/feign/InternalCallFeignConfig.java:9` 到 `:24`。这说明“购物车列表批量补 SKU 详情”在当前实现里已经不是一条临时 Feign 调用，而是一条正式的内部受保护读链。

## Redis 丢失后的恢复为什么也属于购物车合并语义的延长线

如果只看 `/merge` 接口，很容易以为合并在写入 Redis 三结构并发 MQ 之后就结束了。但 `getCartList()` 和 `CartReconcileJob` 说明，系统其实还在为另一个极端场景兜底：Redis 购物车丢失。

`getCartList()` 在发现 `itemsMap` 为空时，并不会立刻认定用户购物车为空，而是先尝试 `restoreCartFromDb()` 从 MySQL 把购物车三结构回写到 Redis，见 `my-xhs-cart/src/main/java/com/myxhs/cart/service/CartService.java:333` 到 `:345` 和 `:698` 到 `:730`。更关键的是，恢复之后它还会**再跑一次 pipeline 重读三结构**，见 `my-xhs-cart/src/main/java/com/myxhs/cart/service/CartService.java:346` 到 `:359`，避免第一次读取时拿到的空 `checkedSet/sortMap` 直接污染首次响应。

这说明登录态购物车并不是“Redis 一丢就只能认空”，而是把 MySQL 当成 Redis 权威态丢失后的恢复来源。购物车合并虽然首先发生在 Redis，但最终还要靠 MySQL 兜底保持“这个用户本来想买什么”不至于因为缓存层事故整体消失。

## 对账为什么要保守到宁可残留脏 MySQL，也不肯误删兜底数据

`CartReconcileJob` 里还有一个非常值得写出来的取舍：当 `itemsKey` 不存在时，它不会贸然执行“Redis 无 + MySQL 有 → 删除 MySQL”这类修复，见 `my-xhs-cart/src/main/java/com/myxhs/cart/job/CartReconcileJob.java:140` 到 `:149`。

原因很现实：`itemsKey` 不存在既可能表示“用户真清空了购物车”，也可能表示“Redis 故障把这份购物车弄丢了”。如果在第二种情况下还按常规对账把 MySQL 兜底数据一起删掉，就会出现 Redis 和 MySQL 双份全丢。

所以当前实现明确选择了一个偏保守的策略：

- 宁可留下部分陈旧 MySQL 行
- 也不在 Redis key 缺失时贸然摧毁唯一兜底账本

这个取舍很能说明购物车系统的真实优先级：**读视图可以接受少量陈旧持久化残影，但不能接受用户待购状态双份全灭。**

## 购物车条目的“有效”为什么不等于“现在一定有货”

还有一个很容易被误解的业务边界：购物车列表里的 `valid` 标记，并不是“这个商品现在一定可以结算”。`getCartList()` 里只会根据商品服务返回的 `SKU.status` 和 `SPU.status` 判断条目是否下架，见 `my-xhs-cart/src/main/java/com/myxhs/cart/service/CartService.java:430` 到 `:451`；它明确**不会**去看 `stock`，因为 product 侧的 `stock` 只是冗余占位值，真实库存要等 inventory/order 链路裁决。

这意味着当前购物车页回答的问题其实是：

- 这个待购条目在商品维度上还存不存在
- 它在商品主数据维度上是不是已经失效

而不是：

- 这次提交订单时库存一定足够

如果把 `valid=true` 误写成“可直接结算”，就会把商品有效性判断和库存可交易性判断混成一层。当前实现恰恰是把这两件事拆开的：cart 只兜商品骨架，order/inventory 再兜真实库存。

## 写路径边界：下架 SKU 不能再进入购物车权威态

当前加购和匿名合并在写入 Redis 前都会通过 `skuExists()` 检查商品状态；只有 `SKU.status=ON_SHELF` 才允许继续写入，见 `my-xhs-cart/src/main/java/com/myxhs/cart/service/CartService.java:605` 到 `:614`。这修复了“下架商品仍能加购、列表页再被标无效”的读写语义分裂。商品服务不可用时仍保留降级放行，避免商品服务短暂故障阻断购物车主写链，列表页和订单链继续承担后续防线。

事件消费也有对应的乱序保护：如果 `CHECK` 事件先于 `ADD/UPDATE` 到达，`CartSyncConsumer` 现在只记录并跳过，不会凭空插入 `quantity=1` 的购物车行，见 `my-xhs-cart/src/main/java/com/myxhs/cart/consumer/CartSyncConsumer.java:221` 到 `:226`。

## 真实故障案例：为什么合并逻辑如果不区分“状态合并”和“操作叠加”，重试一次就会把用户意图放大

这篇最值得抓住的真实风险，不是 Lua 脚本本身，而是合并语义很容易被写成错误的“操作重放”。

### 现象

如果系统把 merge 写成：

- 已有商品数量 = 老数量 + 匿名数量
- 已有商品勾选状态 = 匿名态覆盖登录态

那么一次普通的登录重试就可能出现：

- 数量被翻倍
- 勾选状态被重置
- 用户原本已经取消勾选的商品重新参与结算

### 根因

根因不是“网络抖动”，而是系统把 merge 误写成了“把匿名操作重新执行一遍”。但 merge 真正要做的，其实是“把匿名态和登录态收敛成一个最终状态”。

这就是为什么：

- 数量取 `max`
- 已有商品不覆盖勾选态
- 新商品才默认勾选

### 修复

`my-xhs` 当前的修法就是把 merge 明确建模成状态合并：

1. 重复 SKU 不相加，而取较大数量
2. 已有条目不覆盖 `checked`
3. 新条目才走默认勾选
4. 全过程用 Lua 原子执行，防止三结构分裂

### 验证

验证是否真的修好，不是看 merge 返回 200，而要看：

- 同一匿名购物车重试多次，结果是否稳定
- 已有购物车项的勾选态是否仍然保留
- 新合并商品是否进入 `checked` 集合
- Redis 和 MySQL 是否最终一致

### 余波

这个案例提醒我们：**购物车合并真正保护的是“用户的待购状态”，而不是“匿名操作历史”。** 一旦把这两件事混了，系统在最开始的登录环节就会悄悄篡改用户意图。

## 这一篇先收束成一张总图

```text
匿名购物车
  = 一组最小待购意图（skuId + quantity）

登录态购物车
  = 以 userId 归属的 Redis 三结构权威集合

合并过程
  1. 过滤空/非法条目
  2. 校验 SKU 仍存在
  3. Lua 原子收敛三结构
     - 已有 SKU：数量取 max，不覆盖 checked
     - 新 SKU：直接加入，默认 checked
  4. 刷新 Redis 三结构 TTL，保持活跃购物车不过期
5. 发送 MQ 事件异步落 MySQL
```

这里最重要的不是“登录后发了一个 merge 请求”，而是三条判断：

1. 匿名购物车合并是状态收敛，不是操作重放。
2. Redis 三结构是权威态，所以合并必须首先在 Redis 原子完成。
3. 合并真正保护的是用户待购意图不被覆盖、不被放大，也不被脏数据污染。

## 证据清单

这篇的关键判断主要由以下证据托底：

- 匿名购物车请求模型：`my-xhs-cart/src/main/java/com/myxhs/cart/dto/request/CartMergeRequest.java:13`
- 合并入口：`my-xhs-cart/src/main/java/com/myxhs/cart/controller/CartController.java:103`
- 购物车 Redis 三结构与权威态定义：`my-xhs-cart/src/main/java/com/myxhs/cart/service/CartService.java:31`
- 合并策略与幂等说明：`my-xhs-cart/src/main/java/com/myxhs/cart/service/CartService.java:483`
- 合并时的 SKU 存在性校验：`my-xhs-cart/src/main/java/com/myxhs/cart/service/CartService.java:508`、`my-xhs-cart/src/main/java/com/myxhs/cart/feign/ProductFeignClient.java:29`
- 内部 Feign 自动注入 `X-Internal-Call`：`my-xhs-cart/src/main/java/com/myxhs/cart/feign/InternalCallFeignConfig.java:9`
- 下架 SKU 写入前拦截：`my-xhs-cart/src/main/java/com/myxhs/cart/service/CartService.java:605`
- 乱序 CHECK 不伪造购物车项：`my-xhs-cart/src/main/java/com/myxhs/cart/consumer/CartSyncConsumer.java:221`
- 列表页第二层 `valid` 防御：`my-xhs-cart/src/main/java/com/myxhs/cart/service/CartService.java:430`
- Lua 原子合并写入：`my-xhs-cart/src/main/java/com/myxhs/cart/service/CartService.java:516`
- 已有条目不覆盖 checked、新条目默认 checked：`my-xhs-cart/src/main/java/com/myxhs/cart/service/CartService.java:531`
- TTL 刷新保持活跃购物车：`my-xhs-cart/src/main/java/com/myxhs/cart/service/CartService.java:544`、`my-xhs-cart/src/main/java/com/myxhs/cart/service/CartService.java:640`
- MQ 事件与异步落 MySQL：`my-xhs-cart/src/main/java/com/myxhs/cart/dto/event/CartSyncEvent.java:12`、`my-xhs-cart/src/main/java/com/myxhs/cart/service/CartService.java:659`、`my-xhs-cart/src/main/java/com/myxhs/cart/consumer/CartSyncConsumer.java:22`、`my-xhs-cart/src/main/java/com/myxhs/cart/consumer/CartSyncConsumer.java:91`
- 同毫秒事件单调序列号防乱序误判：`my-xhs-cart/src/main/java/com/myxhs/cart/service/CartService.java:54`、`my-xhs-cart/src/main/java/com/myxhs/cart/service/CartService.java:668`
- Redis 丢失后从 MySQL 恢复并重读三结构：`my-xhs-cart/src/main/java/com/myxhs/cart/service/CartService.java:333`、`my-xhs-cart/src/main/java/com/myxhs/cart/service/CartService.java:349`、`my-xhs-cart/src/main/java/com/myxhs/cart/service/CartService.java:698`
- 对账保守跳过删除场景（防双份全丢）：`my-xhs-cart/src/main/java/com/myxhs/cart/job/CartReconcileJob.java:140`

## 边界清单

- 本篇只讨论“匿名购物车并入登录态购物车”这条前置链路，不展开购物车列表回显、勾选、清空、对账和恢复逻辑，这些在后续购物车专题继续展开。
- 当前匿名购物车请求只带 `skuId + quantity`，不带价格、名称、勾选态；这不是简化遗漏，而是有意把正式语义留给登录态购物车系统决定。
- SKU 存在性校验会挡住最明显的幽灵条目，但商品是否下架、SPU 是否失效等问题在列表阶段还有第二层 `valid` 防线，本篇不展开那条回显逻辑。
- 本篇重点是合并语义，不展开 MQ 消费端如何把 `CartSyncEvent` 持久化到 MySQL。
- `ai-app`、`ai-mcp`、`ai-tools` 不进入本篇分析线。

## 这篇解决了什么，还留下什么问题

这篇先解决了三个问题：

- 为什么登录后匿名购物车不能简单覆盖，也不能简单相加。
- 为什么合并必须在 Redis 三结构里原子完成，而不是先落数据库再说。
- 为什么同一 `skuId` 的数量、勾选态和存在性都要分别处理，才能真正保护用户的待购状态。

但它还没进入另一个同样关键的交易前置问题：购物车只是“准备买什么”，真正能不能便宜、便宜多少，还取决于优惠券生命周期怎样进入下单链。

所以下一篇应该进入 `02-coupon-lifecycle.md`，去回答**优惠券从模板创建、用户领取、下单核销到取消退回，到底怎样在 Redis、MQ、MySQL 之间流动**。


补：当前实现新增了 `cleared` 清空标记，避免 Redis 空购物车被 MySQL 残留误恢复；同时事件流水消费者对 `timestamp=null` 脏消息直接跳过。


补：后续写路径成功时会主动清理 `cleared` 标记；对账也会识别该标记，把“用户真的清空了购物车”和“Redis 故障导致 itemsKey 丢失”区分开。


补：`CLEAR` 事件现在会额外携带 clear barrier 时间戳，消费侧日志会保留这层屏障语义，便于后续继续收敛“清空后旧消息迟到”的排障与增强。


补：`CartSyncConsumer` 现已把 clear barrier 升级为真实判定语义；`ADD/UPDATE/DELETE/CHECK/CHECK_ALL` 若时间落在最新 `CLEAR` 之前，会被直接跳过，防止清空后旧消息把 MySQL 购物车重新写回。
