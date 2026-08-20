# 营销叠加与优先级

> 对应目录：`vol-xhs/04-cart-coupon-marketing/`
> 目标问题：当前 `my-xhs` 的营销能力到底叠加到了什么程度？在没有独立 promotion engine 的前提下，基础价格、可用优惠券、最终支付金额之间，优先级实际上是怎样被当前代码隐式决定的？

## 一句话困惑

上一章已经诚实说明，当前代码里并没有一套独立的 promotion engine。那么接下来的问题就不再是“规则引擎怎么实现”，而是更现实的一个：**在没有规则引擎的情况下，当前系统到底已经叠加了哪些营销能力，又是按什么顺序收敛的？**

这件事如果不说清楚，读者很容易在两个方向上产生错觉：

- 一种错觉是“既然有购物车、有优惠券、有订单，那叠加优先级一定已经被完整实现了”。
- 另一种错觉是“既然没有独立引擎，那当前营销栈几乎等于没有规则”。

这两种判断都不对。当前实现并不是“没有营销栈”，而是**营销叠加能力还停留在一个非常克制、非常有限、但已经能形成闭环的阶段**。

## 一句话答案

当前 `my-xhs` 的营销叠加栈，本质上只完成了三层收敛：商品域给出 `SKU.price` 作为基础价格，coupon 域给出“当前用户可用的单券折扣”，order 域再把两者收敛成 `payAmount`；也就是说，当前优先级不是通过统一规则树显式声明出来的，而是被“先算商品总价 → 再算单券折扣 → 最后得出支付金额”这条代码路径隐式固定了。

## 先把当前实现的营销栈压成一张最小图

```text
商品域
  提供：SKU.price / originalPrice

购物车聚合层
  展示：当前购物车项 + 当前可用券集合

优惠券域
  提供：单券可用性 + 单券折扣金额

订单域
  收敛：totalAmount → discountAmount → payAmount
```

这张图最关键的地方在于：

- 购物车页面能看到“有哪些券可用”，不等于系统已经决定“这些券怎么叠加”。
- 优惠券域能算出单张券折扣，不等于系统已经支持多规则组合。
- 订单域能输出最终支付金额，不等于它有一套显式的营销优先级配置中心。

更重要的是，这三层其实已经构成了一条完整的交易前置总链：

```text
购物车先把待购集合收住
  → coupon 域再告诉你“当前有哪些券可能可用”
    → 订单域用商品总价 + 单券折扣收敛出 payAmount
      → 订单成功后才真正核销那张被选中的券
```

这条链说明当前营销问题并不是孤立地发生在某个“促销模块”里，而是横跨：

- `cart`：用户准备买什么
- `coupon`：这次交易现在有哪些折扣候选
- `order`：这次交易最终按多少钱成立

所以这篇如果只讲“有没有引擎”，仍然会漏掉一个很关键的业务视角：**当前营销栈真正完成的，是交易前置状态怎样一步步收束成一个最终可支付金额。**

## 先推演第一个失败方案：把“可用券列表”误当成“完整营销叠加能力”

这是当前实现里最容易被误读的一点。

### 为什么这个误解很自然

购物车聚合服务 `CartAggService` 在 `my-xhs-home/src/main/java/com/myxhs/home/service/CartAggService.java:25` 到 `:33` 已经明确写了：第一页并行聚合购物车列表和可用优惠券。代码里：

- `cartFuture` 拉购物车项，见 `my-xhs-home/src/main/java/com/myxhs/home/service/CartAggService.java:56` 到 `:64`
- `couponFuture` 拉可用优惠券，见 `my-xhs-home/src/main/java/com/myxhs/home/service/CartAggService.java:66` 到 `:76`
- 最后返回 `availableCouponCount` 和 `availableCoupons`，见 `my-xhs-home/src/main/java/com/myxhs/home/service/CartAggService.java:129` 到 `:137`

从页面效果看，这已经很像一个“营销栈”：

- 购物车里有商品
- 页面上有可用券
- 用户也能感知到多少张券可选

很容易让人下意识以为：既然系统都能把这些券列出来了，那一定也已经解决了多优惠能力如何叠加的问题。

### 它真正会先坏在哪里

可用券列表只说明：

```text
这些券现在看起来都能参与这笔交易
```

它并没有说明：

```text
如果同时出现多种优惠，最终只能选一张还是能叠多张
先应用哪一种
类目级优惠和券是否冲突
券和商品促销谁先算
```

也就是说，“可用券集合”只是候选集，不是叠加规则本身。这一点在聚合层的返回模型里也能看出来：`CartAggVO` 只把它定义成 `availableCouponCount` 和 `availableCoupons` 两个字段，见 `my-xhs-home/src/main/java/com/myxhs/home/dto/CartAggVO.java:43` 到 `:47`；`CartAggService` 在 `my-xhs-home/src/main/java/com/myxhs/home/service/CartAggService.java:129` 到 `:137` 也只是把 coupon 服务返回的列表原样塞回结果，并没有做排序、打分、互斥或优先级计算。

如果把候选集误当成规则引擎，后面一旦出现多张可用券或更多促销能力，系统就会立即从“页面上都能看见”滑到“到底按哪张算没人说得清”。

## 再推演第二个失败方案：把最终支付金额误当成“当前已经有完整优先级体系”的证明

另一种常见误解是：既然订单最终能算出 `payAmount`，那优先级体系应该已经存在，只是没有单独抽出来。

### 为什么这个误解也很自然

订单创建时，系统确实会做完整的金额收敛。`OrderService` 在 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:186` 到 `:193` 中：

1. 算 `totalAmount`
2. 算 `discountAmount`
3. 得到 `payAmount`

表面上看，这似乎就是一条完整的营销计算链。

### 它真正的问题

这条链能成立，不代表它已经支持“多规则叠加”，只代表它目前支持一条非常受限的收敛路径：

```text
总价 = SKU.price * quantity
折扣 = coupon 服务返回的单券折扣
支付金额 = 总价 - 折扣
```

这和“存在完整优先级体系”之间还差得很远。

因为当前代码里并没有看到：

- 多张券同时参与
- 商品级促销和券共同参与
- 类目级促销与单券冲突处理
- 不同促销类型的优先级矩阵

所以 `payAmount` 当前更像是**有限规则闭环的结果**，而不是完整叠加栈的终局证明。

## 当前实现里的第一层：基础价格先决定总价上限

营销叠加的最底层，仍然是基础价格。

`OrderService.calculateTotalAmount()` 在 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:960` 到 `:971` 中逐条取 `SKU.price` 乘以数量累加，得到 `totalAmount`。

这说明当前营销栈里最先被固定下来的优先级，其实是：

```text
基础商品价格先成立
```

所有后续优惠，不管怎么来，至少当前都只能在这个 `totalAmount` 之上再做减法，而不是重写商品基础价格来源。

也就是说，当前实现里商品基础价优先级最高，不是因为配置文件里写了“优先级 1”，而是因为订单代码路径首先就把它算完了。

## 当前实现里的第二层：可用券集合只是候选集，不是叠加器

购物车聚合层给用户看到的是：当前有哪些券可能可用。

`CouponService.getAvailableCoupons()` 在 `my-xhs-coupon/src/main/java/com/myxhs/coupon/service/CouponService.java:434` 到 `:456` 里已经把可用券视图收了一遍：

- 必须是 `status=0`
- 必须未过期
- 不能是未来才生效的券

这意味着 coupon 域当前能非常明确地回答：

```text
用户此刻手上有哪些候选券
```

但它仍然没有回答：

```text
如果有多张候选券，最后应该怎么叠
```

所以可用券集合的优先级地位其实是：它在整个营销栈中负责“候选输入”，而不负责“叠加决策”。

这里还藏着一个很容易被忽略的工程问题：`CartAggService` 把购物车本体和可用券集合放在第一层并行查询，见 `my-xhs-home/src/main/java/com/myxhs/home/service/CartAggService.java:57` 到 `:80`。这说明“购物车能不能展示”和“可用券能不能查出来”在当前页面模型里被当成两类不同强度的依赖：

- 购物车本体失败 → 整个购物车页失败
- 可用券失败 → 页面仍可成立，只是候选券视图降级为空或 0

这说明营销前置链在工程上也不是一个整体原子块，而是：**商品待购集合是强依赖，可用券候选是弱依赖。** 这对后面理解“为什么购物车页能打开但当前没有推荐可用券”非常重要。

## 当前实现里的第三层：coupon 域只负责单券规则，不负责多规则编排

这层是当前系统最容易被高估的地方。

### coupon 模板已经定义了单券规则类型

`CouponTemplate` 在 `my-xhs-coupon/src/main/java/com/myxhs/coupon/entity/CouponTemplate.java:13` 到 `:17` 已经定义了三类券：

- 满减
- 折扣
- 无门槛

`CouponService.calculateDiscount()` 又在 `my-xhs-coupon/src/main/java/com/myxhs/coupon/service/CouponService.java:345` 到 `:354` 中按 `type` 执行对应公式。

这说明 coupon 域确实已经有“规则”。

### 但它目前只负责单券真相

coupon 域当前的规则入口仍然是单张券：

- `/discount/{id}`：只算这一张券在当前订单金额下能减多少，见 `my-xhs-coupon/src/main/java/com/myxhs/coupon/controller/CouponController.java:133` 到 `:145`
- `/use`：真正核销这一张券，见 `my-xhs-coupon/src/main/java/com/myxhs/coupon/controller/CouponController.java:147` 到 `:158`

对应的请求入口也把这个边界钉死了：`OrderCreateRequest` 里只有单个 `couponId` 字段，而不是 `couponIds` 列表，见 `my-xhs-order/src/main/java/com/myxhs/order/dto/request/OrderCreateRequest.java:21` 到 `:22`。这说明当前 coupon 域承担的不是“整笔交易的所有营销编排”，而是：

```text
给定一张券
在给定订单金额下
告诉你它是否可用、可减多少
```

它没有承担“多张券之间如何比较、如何叠加、如何互斥”的职责。

## 当前实现里的第四层：order 域把单券结果和总价收敛成最终支付金额

真正让用户看到 `discountAmount` 和 `payAmount` 的，是订单域的最后收口。

`OrderService.calculateCouponDiscount()` 在 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:975` 到 `:991` 中，会把 `totalAmount` 传给 coupon 域，拿回单券折扣。

随后 `createOrder()` 在 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:186` 到 `:193` 中，用：

```text
totalAmount - discountAmount = payAmount
```

完成最终价格收敛。

所以当前实现里，订单域隐式地承担了最后一道优先级：

1. 先认商品基础总价
2. 再认单张券折扣
3. 最后给出支付金额

它并没有一个叫“promotion priority matrix”的结构，但它通过计算顺序把优先级固定下来了。

## 当前营销叠加到底已经做到哪一步

如果把“营销叠加”理解成“多个价格相关能力共同进入最终支付金额”，那么当前实现其实已经走到了一个明确但有限的阶段。

### 已经做到的

1. **基础价格 + 单券折扣** 可以收敛成最终支付金额
2. **购物车页** 能展示“当前有哪些券可选”
3. **订单创建** 能在最终提交时真正核销那一张被选中的券

### 还没有做到的

1. **多券叠加**
2. **商品级促销**
3. **类目级促销**
4. **店铺级促销**
5. **券与券的优先级编排**
6. **券与商品促销的优先级编排**

也就是说，当前营销栈不是空白，而是停在“单券驱动的价格收敛链”这一层。

## 现有优先级到底是怎样被代码隐式决定的

这一点值得单独说，因为它正是下一阶段最容易演化出复杂度的地方。

当前代码里虽然没有显式优先级矩阵，但优先级已经被计算顺序固定了：

### 第一步：商品基础价格先成立

没有人能先于 `SKU.price` 改写 `totalAmount`。

### 第二步：优惠券只在总价之上做减法

coupon 域拿到的是 `orderAmount`，不是购物车原始条目集合，也不是商品分类树。这意味着单券规则当前只能在“总价已经成立”的前提下发挥作用。

### 第三步：订单域只认一个 `discountAmount`

当前订单域最终只收一个折扣值，再和总价收敛。也就是说，它当前天然只支持一条折扣输入，而不是一个促销列表。

这三步合起来，实际上就构成了当前实现里的隐式优先级：

```text
基础总价 > 单券折扣 > 最终支付金额
```

它简单，但也因此很清楚。

## 为什么“没有独立引擎”在当前阶段并不等于“营销栈不可用”

看到这里，读者很容易有两种极端结论：

- 既然没有独立引擎，那营销栈很弱，几乎没做什么。
- 既然最终钱算出来了，那当前实现已经足够，不需要再抽象。

这两个判断都过头了。

### 当前方案的价值

它至少保证了：

- 单券规则只有一个权威来源
- 订单最终支付金额有明确收口
- 商品价格和优惠券规则没有在两个域里重复实现

### 当前方案的上限

但它的上限也很明确：只要进入“多促销同时参与”的阶段，当前这套隐式顺序很快就会不够用。

因为到那时你必须显式回答：

- 先券后满减，还是先满减后券
- 两张券能否一起用
- 商品级优惠和订单级优惠谁先结算
- 不同折扣叠加时如何避免金额漂移

这些问题在当前代码里都还没有独立位置。

## 真实故障案例：为什么营销栈最危险的不是“没有更多规则”，而是“现在明明只有单券规则，却被人误以为已经支持完整叠加”

这篇最值得抓住的风险，不是系统报错，而是系统被误用。

### 现象

一旦前端、产品或者后续开发者看到：

- 购物车里出现了可用券列表
- 订单里有 `discountAmount`
- coupon 模板还有不同类型

他们就很容易下意识觉得：系统已经具备一整套营销叠加能力，只要多加几种模板类型就能扩展。

### 根因

根因在于当前实现把营销收敛做成了一条可用链路，但没有把“边界只到哪一步”显式写在代码结构里。于是外部观察者很容易把“当前已经能跑通的闭环”误看成“完整营销栈已存在”。

### 修复

当前最重要的修复，不是立刻上一个复杂规则引擎，而是先把边界讲清楚：

- 现在只支持单券规则
- 现在只有一个 `discountAmount` 输入点
- 现在没有多促销叠加与优先级编排层

### 验证

验证这件事，不能只看用户页面，而要直接看代码是否存在：

- 多券输入
- 多折扣来源列表
- 显式优先级矩阵
- 独立 promotion engine

当前都没有。

### 余波

这个案例说明，**营销栈最危险的时刻，往往不是规则太少，而是大家误以为规则已经很多。** 一旦误判边界，后续功能就会建立在错误抽象之上。

## 这一篇先收束成一张总图

```text
当前营销叠加栈

商品域
  提供：SKU.price / originalPrice
  语义：基础价格真相

购物车聚合层
  提供：可用券候选集
  语义：候选输入，不做叠加决策

优惠券域
  提供：单张券可用性 + 单张券折扣金额
  语义：单券规则真相

订单域
  提供：totalAmount / discountAmount / payAmount 收敛
  语义：最终支付金额拍板者

当前缺位
  多券叠加
  多促销优先级矩阵
  独立 promotion engine
```

这里最重要的不是有没有 marketing 模块，而是三条判断：

1. 当前系统已经有营销收敛链，但它只支持非常有限的单券叠加能力。
2. 当前优先级不是显式配置出来的，而是被“总价 → 单券折扣 → 支付金额”这条代码顺序隐式固定。
3. 真正危险的不是现在缺少复杂规则，而是未来有人误把这条有限收敛链当成完整营销栈继续叠功能。

## 证据清单

这篇的关键判断主要由以下证据托底：

- 购物车聚合时并行拉可用券：`my-xhs-home/src/main/java/com/myxhs/home/service/CartAggService.java:25`、`my-xhs-home/src/main/java/com/myxhs/home/service/CartAggService.java:66`
- 可用券当前只是候选集，聚合层不做优先级计算：`my-xhs-home/src/main/java/com/myxhs/home/dto/CartAggVO.java:43`、`my-xhs-home/src/main/java/com/myxhs/home/service/CartAggService.java:129`
- 可用券候选过滤：`my-xhs-coupon/src/main/java/com/myxhs/coupon/service/CouponService.java:434`
- 优惠券模板规则类型：`my-xhs-coupon/src/main/java/com/myxhs/coupon/entity/CouponTemplate.java:13`
- coupon 域把“试算”和“真正用券”分开：`my-xhs-coupon/src/main/java/com/myxhs/coupon/controller/CouponController.java:133`、`my-xhs-coupon/src/main/java/com/myxhs/coupon/controller/CouponController.java:147`
- 订单请求当前只接受单个 `couponId`：`my-xhs-order/src/main/java/com/myxhs/order/dto/request/OrderCreateRequest.java:21`
- 订单总价计算：`my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:186`、`my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:960`
- 订单通过 coupon 服务拿折扣并收敛 `payAmount`：`my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:189`、`my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:975`
- 当前审查方法对“order/coupon 各算各的”风险提示：`docs/review-method/19-coupon-marketing.md:79`

## 边界清单

- 本篇讨论的是“当前实现下的营销叠加边界”，不是在分析一个并不存在的独立 promotion engine。
- 当前实现里的“营销栈”本质上还是单券驱动的价格收敛链，不应误写成多规则编排系统。
- 可用券候选集、单券折扣计算、最终支付金额收敛是三层不同职责；本篇只讲它们怎样串起来，不展开更细的促销公式设计。
- 多券叠加、商品级/类目级/店铺级促销和优先级矩阵在当前实现中缺位，不能写成已支持能力。
- `ai-app`、`ai-mcp`、`ai-tools` 不进入本篇分析线。

## 这篇解决了什么，还留下什么问题

这篇先解决了三个问题：

- 当前 `my-xhs` 的营销叠加栈到底已经做到什么程度，而不是靠想象补全。
- 在没有独立引擎时，基础价格、单券规则和订单支付金额怎样串成一条有限的收敛链。
- 当前优先级并不是显式配置，而是由代码路径隐式决定的。

到这里，`04-cart-coupon-marketing` 目录的四篇已经把交易前置能力的主骨架立住了：

- 购物车怎样把待购状态收敛成权威集合
- 优惠券怎样穿过模板、用户券、核销和退回生命周期
- 当前促销规则真实落在哪些代码里
- 营销叠加当前只走到哪一步、边界又停在哪一步

下一步就该进入真正的交易执行主链：`05-inventory-order-payment/01-inventory-three-level.md`。之所以先讲库存而不是先讲订单创建，是因为库存是交易主链里第一块真正脱离单机直觉、必须靠预扣/确认/释放三段状态机才能成立的核心机制；不先把它讲透，后面的下单、事务消息和支付闭环都会失去最关键的约束前提。
