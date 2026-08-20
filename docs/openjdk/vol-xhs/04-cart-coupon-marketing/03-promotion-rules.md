# 促销规则与价格收敛

> 对应目录：`vol-xhs/04-cart-coupon-marketing/`
> 目标问题：下单前的营销规则到底在哪里生效？`my-xhs` 是不是有一套独立的促销规则引擎，还是当前只靠商品基础价格 + 优惠券规则 + 订单汇总来完成价格收敛？

## 一句话困惑

走到购物车和优惠券之后，读者很自然会期待看到一套“营销规则引擎”：

- 满减和折扣怎么叠加
- 优惠券和商品价格谁先算
- 多张券能不能一起用
- 试算和真正下单时，最终支付金额由谁拍板

目录名 `promotion-rules` 也很容易让人先入为主地以为代码里一定有一套专门的 `PromotionService`、规则 DSL、优先级编排器之类的实现。

但真正把代码翻开之后，问题反而变成了另一个方向：**当前代码里并没有一套独立的促销规则引擎。** 这不是缺漏，而是当前实现阶段的事实。

所以这篇的任务，不是编造一个不存在的规则引擎，而是诚实回答：**在当前 `my-xhs` 实现里，营销规则到底是由哪些真实代码片段拼出来的，哪些能力已经存在，哪些能力其实还没有。**

## 一句话答案

当前 `my-xhs` 并没有独立的 promotion engine；所谓“促销规则”主要收敛在三层：商品域提供 `SKU.price / originalPrice` 作为基础价格真相，优惠券域通过模板类型和责任链给出单券折扣语义，订单域再把商品总价和优惠券折扣收敛成 `payAmount`。也就是说，现在的营销规则更像“价格收敛链”，而不是“独立规则引擎”。

## 先把一个容易误解的事实说透：当前没有独立促销规则引擎

先说结论，再给证据。

这次代码核对里，没有找到独立的 `promotion` / `marketing` 规则模块，也没有看到类似：

- 独立的规则 DSL
- 多促销类型编排器
- 通用规则树或规则引擎框架
- 券叠加优先级中心

相反，当前“营销规则”的真实落点主要只有两处：

1. `coupon` 域对单张券的规则定义和折扣计算
2. `order` 域对商品总价与券折扣的最后收敛

这意味着这篇不能按“独立促销引擎源码分析”的方式写，而要按“当前实现里，促销能力是怎样被拼出来的”来写。

这不是退而求其次，而是方法论要求的诚实：**源码里没有的东西，就不能因为目录名需要而硬写出来。**

## 先推演第一个失败方案：把“营销规则”想象成一个已经存在的统一引擎

这是最容易犯的错误。

### 为什么这个误解很自然

因为从产品语言看，优惠、折扣、满减、无门槛券、支付金额这些概念天然属于“营销规则”。很多成熟电商系统也确实会专门有一个 promotion engine。

如果照着经验想象 `my-xhs`，读者很容易自动脑补：

- 商品域只给原价
- 营销引擎算所有优惠
- 订单域只接受结果

### 它在当前代码里为什么站不住

当前代码并没有这样一个中枢。

- `CouponTemplate` 在 `my-xhs-coupon/src/main/java/com/myxhs/coupon/entity/CouponTemplate.java:13` 到 `:17` 只定义了三类券：满减、折扣、无门槛。
- 折扣计算也直接写在 `CouponService.calculateDiscount()` 里，见 `my-xhs-coupon/src/main/java/com/myxhs/coupon/service/CouponService.java:345` 到 `:354`。
- 订单域自己的价格汇总只做两步：先算商品总价，再调 coupon 服务拿折扣，见 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:960` 到 `:991`。

也就是说，当前实现里根本没有一套“把所有营销规则集中起来统一求值”的地方。

如果硬把它写成一个成熟的规则引擎，文章就会从第一步开始失真。

## 再推演第二个失败方案：把所有价格逻辑都塞进订单域

既然没有独立引擎，另一种也很自然的思路是：那干脆让订单域自己把所有优惠都算完。

### 为什么这个方案也很诱人

因为订单域最终本来就要输出：

- `totalAmount`
- `discountAmount`
- `payAmount`

既然最后拍板的是它，直觉上似乎也该由它来独自承担所有规则。

### 它为什么会先坏在哪里

这个方案会很快把订单域变成另一个隐形优惠券域，进而复制规则。

`docs/review-method/19-coupon-marketing.md:79` 到 `:97` 已经把这类风险点明：如果 `order` 和 `coupon` 两边各算各的，结果很容易漂移，最后根本不知道哪一边才是权威折扣逻辑。

这也是当前实现为什么刻意让 `order` 在 `calculateCouponDiscount()` 中通过 Feign 去调用 `coupon` 服务，而不是本地重写一份折扣逻辑。对应代码见：

- `my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:975` 到 `:991`
- `my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:983` 直接调用 `couponFeignClient.getCouponDiscount(...)`
- `my-xhs-coupon/src/main/java/com/myxhs/coupon/controller/CouponController.java:133` 到 `:145` 把“试算折扣”单独暴露成 `/discount/{id}`
- `my-xhs-coupon/src/main/java/com/myxhs/coupon/controller/CouponController.java:147` 到 `:158` 又把“真正用券”单独暴露成 `/use`

这说明订单域虽然负责价格收敛，但并不想吞掉单券规则真相；而 coupon 域也在接口层面把“试算”和“真正占用”明确分开了。

## 当前实现里的第一层规则：商品域提供基础价格真相

如果没有独立促销引擎，第一层价格真相来自哪里？答案很明确：来自商品域的 `SKU.price / originalPrice`。

### 为什么基础价格必须来自 SKU 而不是订单自己猜

上一篇已经讲过，`SKU` 是交易变体单位，不同变体可以有不同价格。订单在创建时必须先按真实 `skuId` 拉回对应价格。

`OrderService.calculateTotalAmount()` 在 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:960` 到 `:971` 就只做一件事：

- 根据 `skuId` 从 `skuMap` 里拿到 `price`
- 乘上数量后累加成 `totalAmount`

这一步没有任何营销规则，只有基础交易价格真相。

### `originalPrice` 在当前实现里是什么地位

从商品模型看，`SKU` 还提供了 `originalPrice`。这说明系统已经预留了“展示原价 / 对比现价”的能力。

但在当前订单收敛链里，真正进入支付金额计算的，是 `price`，不是 `originalPrice`。这至少说明：

- `originalPrice` 当前没有进入订单结算链
- `price` 才承担基础交易语义

至于 `originalPrice` 是否只用于展示，在当前代码里没有比“未进入结算链”更强的直接证据，所以本文不把它再写成更满的结论。

所以第一层规则很简单：**商品域先告诉你这个变体现在按多少钱卖。**

## 当前实现里的第二层规则：coupon 域负责单券规则真相

真正的促销规则，目前主要集中在优惠券模板和优惠券服务里。

### 模板先定义“这张券属于哪一种规则”

`CouponTemplate` 在 `my-xhs-coupon/src/main/java/com/myxhs/coupon/entity/CouponTemplate.java:13` 到 `:17` 明确列出三种券：

1. 满减
2. 折扣
3. 无门槛

同时模板还带：

- `discountValue`
- `minAmount`
- `totalCount`
- `perUserLimit`
- `validStart / validEnd`
- `status`

这说明当前营销规则并不是一个开放式表达式系统，而是一组**模板驱动的有限规则类型**。

### 责任链先决定“这张券当前可不可以算”

在真正计算折扣前，`CouponService.getCouponDiscount()` 不会直接套公式，而是先走责任链校验，见 `my-xhs-coupon/src/main/java/com/myxhs/coupon/service/CouponService.java:275` 到 `:289`。

这条链至少在做三类事情：

- 归属校验：这张券是不是当前用户的
- 状态校验：是否未使用
- 门槛/有效期等规则校验

这说明当前实现里的“营销规则”并不只是价格公式，还包括“有没有资格参与本次试算”。

### 公式计算其实很朴素

真正的折扣计算落在 `calculateDiscount()`：

- 满减：直接减 `discountValue`
- 折扣：`orderAmount - orderAmount * discountValue / 10`
- 无门槛：直接减 `discountValue`
- 最终减免不会超过订单金额，防止 0 元购越界

对应代码在 `my-xhs-coupon/src/main/java/com/myxhs/coupon/service/CouponService.java:345` 到 `:354`。

也就是说，当前实现里的“营销规则引擎”，本质上还只是：

```text
模板类型 + 责任链校验 + 一段 switch 公式
```

它能跑通当前业务，但离一个可自由扩展、多规则叠加的真正引擎还很远。

## 当前实现里的第三层规则：order 域负责最后的价格收敛

虽然订单域不拥有单券规则真相，但最终支付金额仍然必须在订单域收口。

`OrderService.createOrder()` 在前半段价格收敛链里做了三步：

1. `calculateTotalAmount()` 算商品总额，见 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:186` 和 `:960`
2. `calculateCouponDiscount()` 调 coupon 服务算折扣，见 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:189` 和 `:975`
3. `payAmount = totalAmount - discountAmount`，见 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:190` 到 `:193`

这三步恰好勾勒出当前实现中的价格收敛链：

```text
SKU 基础价格
  → 订单汇总 totalAmount
    → coupon 域返回 discountAmount
      → order 域收敛 payAmount
```

所以订单域的职责不是“制定所有规则”，而是**把多个域贡献出来的价格语义收束成最终付款金额。**

## 这条价格收敛链当前缺少什么

按方法论要求，这里不能只讲“现在怎么做”，还要诚实讲“现在没做什么”。

当前代码里明显缺少至少三类典型营销能力：

### 1. 多券叠加规则

当前实现只能围绕一张 `couponId` 计算折扣，并没有看到多张券叠加、互斥、优先级编排的实现。

### 2. 商品级促销或类目级促销

当前商品域主要提供基础价格，并没有看到：

- 第二件半价
- 某类目额外满减
- 套装价
- 阶梯价

之类独立促销规则。

### 3. 独立促销规则引擎

没有统一规则编排层，就意味着：

- 新增营销玩法时，规则很可能会继续散落到 coupon/order 两端
- 复杂促销一多，`switch` 公式和分散校验很快会撑不住

这不是说当前实现错误，而是说它还处在“优惠券驱动的价格收敛阶段”，还没进入“真正独立营销引擎阶段”。

## 为什么这不是缺陷，而是当前阶段的真实设计事实

看到这里，读者很容易下意识觉得：没有独立 promotion engine，是不是架构还不完整？

从能力完备性上说，当然还不完整；但从当前业务闭环看，这种实现是有其阶段合理性的。

### 现在这套方案先解决了什么

它先解决了三个最现实的问题：

1. 商品价格有真实来源
2. 单券折扣有单一权威
3. 订单最终支付金额有明确收敛点

在业务复杂度还没演进到多营销玩法爆炸之前，这套链路比“过早上一个复杂规则引擎”更容易落地、更容易验证。

### 它未来会先卡在哪里

但一旦系统开始需要：

- 多券叠加
- 商品级促销与券叠加
- 类目级促销
- 店铺级促销
- 用户等级价

当前这套“商品域给基础价 + coupon 域算单券 + order 域做减法”的链条就会很快逼近上限。

也就是说，现在这套设计不是最终答案，而是当前阶段的一条最小闭环路径。

## 真实故障案例：为什么价格规则一旦分散到多个域，最先坏掉的不是接口返回，而是最终支付金额语义

这篇最重要的风险，不在“系统会不会报错”，而在“系统可能返回 200，但钱算错了”。

### 现象

如果订单域也自己算一遍折扣，或者优惠券域和订单域对“满减/折扣/无门槛”的语义理解不一致，那么最先暴露的问题往往不是异常，而是：

- 下单页显示一个优惠金额
- 订单真正落库时又是另一个金额
- 用户看到的 `discountAmount` 和最终 `payAmount` 关系不再可信

### 根因

根因不是公式复杂，而是**价格规则真相分裂**。

一旦：

- 商品域给了一套展示价
- coupon 域给了一套折扣逻辑
- order 域又本地猜了一套折扣逻辑

系统就会出现多个“看起来都合理”的价格来源，最后谁都说自己没错，错的是系统整体。

### 修复

当前实现围绕这个风险做的最重要修复，其实不是更复杂的引擎，而是更简单的收权：

- 基础价格只认 `SKU.price`
- 单券折扣只认 coupon 服务
- 最终支付金额只在订单侧做最后一次收敛

### 验证

验证这种问题，不能只看接口 200，而要看：

- `totalAmount` 是否由 `SKU.price * quantity` 得到
- `discountAmount` 是否来自 coupon 服务
- `payAmount` 是否严格等于前两者收敛结果

### 余波

这个案例说明，**营销规则最危险的错误，不是系统挂掉，而是系统还在跑，但钱算成了另一套语义。** 这也是为什么即使当前没有独立规则引擎，也必须先把价格收敛链的权威边界立住。

## 这一篇先收束成一张总图

```text
商品域
  提供：SKU.price / originalPrice
  角色：基础价格真相

优惠券域
  提供：模板类型 + 校验链 + 单券折扣计算
  角色：单券规则真相

订单域
  提供：totalAmount / discountAmount / payAmount 收敛
  角色：最终支付金额拍板者

当前缺位
  多促销叠加规则
  独立 promotion engine
  商品级/类目级/多券优先级编排
```

这里最重要的不是“有没有 promotion 模块”，而是三条判断：

1. 当前代码里没有独立促销规则引擎，这是必须诚实承认的实现事实。
2. 当前营销规则主要靠“基础价格真相 + 单券规则真相 + 订单收敛”三段链拼出来。
3. 真正危险的不是规则少，而是规则真相分裂到多个域后，最终支付金额不再可信。

## 证据清单

这篇的关键判断主要由以下证据托底：

- 优惠券模板规则类型：`my-xhs-coupon/src/main/java/com/myxhs/coupon/entity/CouponTemplate.java:13`
- 订单总价计算：`my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:960`
- 订单通过 coupon 服务试算折扣：`my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:975`
- coupon 域把“试算”和“真正用券”分成两个接口：`my-xhs-coupon/src/main/java/com/myxhs/coupon/controller/CouponController.java:133`、`my-xhs-coupon/src/main/java/com/myxhs/coupon/controller/CouponController.java:147`
- 单券折扣计算公式：`my-xhs-coupon/src/main/java/com/myxhs/coupon/service/CouponService.java:345`
- 优惠券复审方法论对“order/coupon 各算各的”风险提示：`docs/review-method/19-coupon-marketing.md:79`
- 可用券用户视图过滤：`my-xhs-coupon/src/main/java/com/myxhs/coupon/service/CouponService.java:434`

## 边界清单

- 本篇讨论的是“当前实现里的促销规则怎样收敛”，不是在分析一个并不存在的独立 promotion engine。
- 当前代码中的营销规则主体仍然是优惠券模板与单券计算，不等于完整营销平台。
- 多券叠加、类目级促销、商品级促销、会员价等能力在当前实现中缺位；本文不能把它们写成已实现事实。
- 订单域当前只做价格收敛，不应把它误写成营销规则真相的唯一来源。
- `ai-app`、`ai-mcp`、`ai-tools` 不进入本篇分析线。

## 这篇解决了什么，还留下什么问题

这篇先解决了三个问题：

- 当前 `my-xhs` 并没有独立促销规则引擎，这一点必须被诚实说清。
- 现有营销规则是由商品基础价格、单券折扣规则和订单金额收敛三段拼出来的。
- 当前阶段真正要守住的，不是“规则引擎是否华丽”，而是最终支付金额的语义不能分裂。

到这里，`04-cart-coupon-marketing` 目录已经建立了两条重要前置能力：

- 购物车把用户待购状态收敛成权威集合
- 优惠券把单券生命周期和折扣规则收敛出来

下一步就该补上营销栈里的最后一个总问题：当购物车、优惠券和基础价格都准备好之后，当前实现到底允许哪些能力叠加、哪些能力根本还没有叠加入口、优先级实际上是怎样被隐式决定的。

所以下一篇应该进入 `04-marketing-stack.md`，去回答**在没有独立 promotion engine 的前提下，当前“营销叠加”真实做到哪一步、边界停在哪一步、优先级又是怎样被当前代码隐式决定的**。
