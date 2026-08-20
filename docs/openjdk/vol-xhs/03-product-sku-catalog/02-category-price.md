# 类目树与价格体系

> 对应目录：`vol-xhs/03-product-sku-catalog/`
> 目标问题：既然 `SPU / SKU` 模型已经把商品拆成“共性层”和“变体层”，那类目树和价格体系又分别在约束什么？为什么类目挂在 `SPU` 上，而价格主要挂在 `SKU` 上？

## 一句话困惑

上一篇已经解释了为什么 `my-xhs` 要把商品拆成 `SPU` 和 `SKU` 两层，但读者很快会继续卡住：

- 商品到底应该归到哪个分类下？这个分类是给整个商品母体看的，还是给每个变体单独看的？
- 为什么 `SPU` 里没有价格，价格主要挂在 `SKU` 上？
- 如果同一个商品母体下面有多个变体，订单创建时到底相信哪个价格？
- 类目树看起来只是前台导航结构，为什么在商品创建时会被强校验？

这些问题的背后，其实是同一个主题：**`SPU / SKU` 只是把商品真相拆开了，但还没有说明“共性真相”到底被哪些业务规则进一步约束。** 这篇就回答这件事。

## 一句话答案

在 `my-xhs` 里，类目树约束的是 `SPU` 的归属与展示位置，价格体系约束的是 `SKU` 的交易语义与订单计费依据；前者回答“这个商品属于什么类”，后者回答“这个具体变体按多少钱卖”，两者分别钉住了商品模型的展示轴和交易轴。

## 先建立最小心智模型

如果上一篇的结论是：

- `SPU` 负责“这是什么商品”
- `SKU` 负责“这个商品卖哪一种变体”

那么这一篇要补上的结论是：

- **类目树是给 `SPU` 定位置的**
- **价格体系是给 `SKU` 定交易语义的**

压缩成一张最小图：

```text
SPU
  ├─ 类目归属（属于哪一类商品）
  └─ 展示语义（描述、图片、品牌、分类）

SKU
  ├─ 变体规格（颜色、容量、尺码……）
  └─ 交易价格（price / originalPrice）
```

也就是说，这篇不是单独讲“分类”或“价格”，而是在讲它们分别怎样约束商品模型的不同层。

## 先推演第一个失败方案：把类目挂到 SKU 上

一种看似也讲得通的做法是：既然最终交易的是 `SKU`，那分类也挂在 `SKU` 上不就行了？

### 为什么这个方案有诱惑力

因为 `SKU` 是最具体、最可交易的对象。很多人第一次建模时会下意识觉得：最具体的对象就该承担最多属性，于是：

- 颜色、容量、尺寸在 `SKU`
- 价格在 `SKU`
- 那分类好像也能在 `SKU`

这样一来，一张 `SKU` 表似乎就能承载大部分前台展示和交易所需信息。

### 它会先坏在哪里

问题在于，类目并不是“交易态最细颗粒的事实”，而是“商品母体的归属语义”。

如果把类目挂在 `SKU` 上，同一个商品母体下的多个变体就会马上面临重复与漂移风险：

- 黑色 128G 一个类目
- 白色 256G 又复制一份类目
- 后续如果商品归类调整，要改所有 SKU

到这一步，类目不再是“母体归属”，而变成了“变体重复字段”。

### `my-xhs` 为什么不这么做

`Spu` 实体在 `my-xhs-product/src/main/java/com/myxhs/product/entity/Spu.java:23` 到 `:24` 直接持有 `categoryId`；而 `Sku` 实体在 `my-xhs-product/src/main/java/com/myxhs/product/entity/Sku.java:21` 到 `:42` 根本没有类目字段。

这说明系统做了非常明确的选择：

- 商品归属是 `SPU` 级事实
- SKU 只是这个母体下的交易变体，不重新定义自己属于哪一类

所以类目树在模型里的真正职责，是给 `SPU` 找一个稳定的“母体位置”，而不是给每个变体重复贴标签。

## 再推演第二个失败方案：把价格挂到 SPU 上

和类目问题相反，价格最直觉的另一种失败方案是：既然前台详情页首先展示的是一个整体商品，那把价格也挂在 `SPU` 上不就行了？

### 为什么这个方案也很诱人

因为从商品详情页的直觉出发，用户先看到的是“一个商品”，然后才点开规格。很多平台的卡片流里也只显示一个主价格。

这很容易诱导出一个错误判断：既然展示时看起来像一个商品一个价格，那 `SPU` 上直接放价格似乎更省事。

### 它真正卡住的地方

一旦 `SKU` 之间价格不同，这个方案就立刻失效。

同一个商品母体下可能存在：

- 不同容量不同价格
- 不同套装不同价格
- 不同版本不同原价/促销价

如果把价格挂在 `SPU` 上，那么：

- 详情页选规格后无法切换到真正价格
- 购物车无法知道用户选的是哪一种计费单元
- 订单创建也无法确定应以哪个价格结算

这意味着价格天然不是“商品母体共性”，而是“交易变体语义”。

### `my-xhs` 为什么把价格留在 SKU 上

`Sku` 实体在 `my-xhs-product/src/main/java/com/myxhs/product/entity/Sku.java:29` 到 `:33` 持有：

- `price`
- `originalPrice`

对应的创建请求 `SkuCreateRequest` 也把价格作为必填或核心约束字段：

- `my-xhs-product/src/main/java/com/myxhs/product/dto/request/SkuCreateRequest.java:23` 要求 `price` 必填且必须大于 0
- `my-xhs-product/src/main/java/com/myxhs/product/dto/request/SkuCreateRequest.java:27` 到 `:29` 定义了可选的 `originalPrice`

这说明在 `my-xhs` 眼里，价格体系并不是 `SPU` 附属信息，而是 `SKU` 的核心交易属性。

## 类目树为什么不是装饰性的前台导航数据

很多系统里，分类树容易被误解成“前端下拉菜单的数据源”。在 `my-xhs` 里，类目树比这重要得多。

### 类目树的真实结构是什么

`Category` 实体在 `my-xhs-product/src/main/java/com/myxhs/product/entity/Category.java:9` 到 `:15` 明确写了它采用 `parent_id` 自关联实现三级树：

- 一级分类：`parent_id = 0`
- 二级分类：`parent_id = 一级分类ID`
- 三级分类：`parent_id = 二级分类ID`

同时实体还带有：

- `level`，见 `my-xhs-product/src/main/java/com/myxhs/product/entity/Category.java:28`
- `sort`，见 `my-xhs-product/src/main/java/com/myxhs/product/entity/Category.java:31`
- `icon`，见 `my-xhs-product/src/main/java/com/myxhs/product/entity/Category.java:34`
- `status`，见 `my-xhs-product/src/main/java/com/myxhs/product/entity/Category.java:37`

这已经说明分类不是一组随手拼出来的标签，而是一个正式的层级模型。

### 类目树如何进入读路径

`CategoryService` 在 `my-xhs-product/src/main/java/com/myxhs/product/service/CategoryService.java:20` 到 `:24` 直接把自己定义成“三级分类树缓存策略：Redis(2h) → MySQL”。

也就是说，这棵树本身就是一个需要缓存和稳定供给的读模型，不是每次请求临时现拼的辅助数据。

它的读路径非常清晰：

1. 先查 Redis，见 `my-xhs-product/src/main/java/com/myxhs/product/service/CategoryService.java:47` 到 `:57`
2. 未命中再查 MySQL，见 `my-xhs-product/src/main/java/com/myxhs/product/service/CategoryService.java:59` 到 `:74`
3. 构树时一次性查出所有启用分类，再按 `parentId` 在内存中组装，见 `my-xhs-product/src/main/java/com/myxhs/product/service/CategoryService.java:84` 到 `:101`
4. 递归生成 `CategoryTreeVO`，见 `my-xhs-product/src/main/java/com/myxhs/product/service/CategoryService.java:111` 到 `:133`

这说明类目树在系统里的角色是：**稳定地给商品母体提供归属坐标，并给前台提供结构化浏览入口。**

### 为什么商品创建时要强校验类目存在

`SpuCreateRequest` 在 `my-xhs-product/src/main/java/com/myxhs/product/dto/request/SpuCreateRequest.java:18` 把 `categoryId` 设成必填；`SpuService.createSpu()` 又在 `my-xhs-product/src/main/java/com/myxhs/product/service/SpuService.java:261` 到 `:265` 真正查库校验分类是否存在。

这说明类目不是“没有也行”的附加信息，而是创建商品母体时必须先钉住的业务坐标。

如果这里不做强校验，会立刻产生两类问题：

- 商品母体成为悬空对象，不知道应该挂在哪个浏览结构下
- 后续列表页、搜索过滤、推荐归类都会失去上游依据

所以类目树在商品域里不是装饰，而是 `SPU` 身份的一部分。

### 类目树的工程边界：当前读模型强，写模型弱

`CategoryService` 当前的设计重点是“Redis 2 小时缓存 → MySQL 回源 → 内存构树”，但代码同时明确留下一个重要边界：当前版本没有完整的分类写 API 和缓存失效链。于是类目树在运行中呈现出一种很典型的读多写少系统形态：

- 读路径有缓存和批量构树优化；
- 商品创建会强校验分类存在；
- 但分类本身如果发生后台变更，缓存何时失效并不等于商品写入时立即完成。

这意味着分类不是单纯的静态字典，而是一份带缓存时效的共享业务配置。对商品域来说，分类错误可能先表现为导航/列表展示异常，随后才影响搜索过滤、推荐归类和商品创建校验。

## 价格体系为什么主要是 SKU 级规则，而不是 SPU 级规则

价格在业务里经常被说成“商品价格”，但在模型里它其实更接近“变体成交价”。

### 当前模型里的价格语义

从 `SkuCreateRequest` 和 `SkuVO` 可以看出，系统区分了两层价格：

- `price`：实际交易价格
- `originalPrice`：原价或参考价

这些字段都挂在 `SKU` 上，而不是 `SPU` 上。这说明系统已经默认接受这样一个事实：

**同一个商品母体，不同变体可以有不同定价。**

### 订单创建时，真正被信任的是哪个价格

订单服务从 `product` 拉回来的不是 `SpuDetailVO`，而是一个轻量的 `SkuInfoDTO`。`my-xhs-order/src/main/java/com/myxhs/order/dto/SkuInfoDTO.java:7` 到 `:10` 明确说，这个 DTO 只含下单时需要的字段。

而这些字段里真正和价格有关的，是：

- `id`
- `spuId`
- `name`
- `price`
- `image`
- `spuStatus`

也就是说，订单创建时真正进入交易链的价格依据，是 `SKU.price`，不是 `SPU` 层的某个聚合价格。`SPU` 在交易里仍然重要，但它贡献的是“这属于哪个商品母体”和“这个母体是否仍上架”，而不是最终计费金额。

### 为什么这里没有更复杂的价格引擎

当前商品域的价格体系还比较朴素：

- 商品域负责提供 `price / originalPrice`
- 优惠券域在下单时再给折扣
- 订单域把这两者收敛成最终 `payAmount`

也就是说，`my-xhs` 目前还没有把“营销价、会员价、阶梯价、区域价”都塞进商品域，而是让商品域先提供基础价格真相，再让优惠券和订单域在后面叠加交易语义。

这是一个非常实际的边界选择：商品域先保证价格基础可信，营销规则后置给别的域处理。

### 价格从 product 到 order 的微服务边界

价格的分工不是“商品服务返回一个数字，订单服务照抄”这么简单。`product` 负责提供 SKU 当前的基础价格和商品状态，`order` 在真正创建订单时重新批量拉取 `SkuInfoDTO`，再按请求数量计算 `totalAmount`。这条路径带来一个必要的分布式判断：

- 详情页或购物车展示的价格属于读视图；
- 订单创建时重新读取的 SKU 价格才进入当前交易快照；
- 优惠券折扣还要经过 coupon 服务重新试算；
- 最终 `payAmount` 由订单侧收敛，不是前端传来的金额。

因此，商品价格变更后，展示层和订单提交瞬间可能存在短暂时间差，但交易链不会把前端旧金额当成最终真相。商品域提供基础价，订单域重新拉取并固化交易计算，这就是价格在微服务边界上的责任分配。

## 类目树和价格体系分别怎样约束商品模型

到这里可以把两者的约束方式明确区分开。

### 类目树约束的是 SPU 的归属合法性

它回答的是：

- 商品母体属于哪一类
- 这个分类现在是否启用
- 它在整棵树里处于哪一层
- 前台浏览时该挂到哪条路径下

所以它主要约束的是 `SPU.categoryId`。

### 价格体系约束的是 SKU 的交易合法性

它回答的是：

- 这个变体当前卖多少钱
- 是否有一个对照原价
- 下单时应该以哪个价格计算金额

所以它主要约束的是 `SKU.price / originalPrice`。

### 这两套规则为什么不能混

如果把类目树问题和价格问题混在一起，会立刻出现两种误导：

- 误把分类当成交价规则的一部分
- 误把价格当成商品母体的共性属性

而 `my-xhs` 的模型恰恰是把这两种语义拆开的：

- 类目管“归到哪”
- 价格管“卖多少”

## 真实故障案例：为什么类目和价格看起来是静态字段，错了却会连锁污染后面的读写路径

类目和价格很容易被当成“静态基础字段”，于是写代码时掉以轻心。但它们一旦错了，污染的范围会远比想象大。

### 现象

如果 `SPU` 创建时不校验类目存在，或者 `SKU` 价格字段被错误使用，很快就会出现这样的异常链：

- 商品能创建成功，但在类目浏览树里找不到位置。
- 详情页展示的是一个价格，订单创建时拿到的是另一套价格依据。
- 搜索和推荐侧即使能搜到商品，也无法保证它处在正确的业务归类下。

### 根因

根因在于：

- 类目树并不是装饰，而是 `SPU` 的归属坐标。
- 价格并不是文案，而是 `SKU` 的交易输入。

一旦这两个字段的语义被写散，后面再怎么补购物车、订单、搜索、推荐，都只是修下游症状。

### 修复

`my-xhs` 当前的修法其实很明确：

- 创建 `SPU` 时强校验 `categoryId`
- 创建 `SKU` 时强校验 `price > 0`
- 订单下单时只拿 `SKU.price` 进入计费链

### 验证

验证是否真的守住这条边界，不是看字段在不在表里，而要看：

- `SPU` 创建是否拒绝无效类目
- `SKU` 创建是否拒绝非法价格
- 订单侧是否仍以 `SKU` 价格为准

### 余波

这个案例提醒我们：**类目和价格虽然看起来像静态字段，但它们其实分别是展示轴和交易轴的入口字段。入口错了，下游整条链都会被污染。**

## 这一篇先收束成一张总图

```text
SPU
  持有：name / categoryId / brandId / description / images / status
  被类目树约束：属于哪一类、挂在哪个浏览层级

SKU
  持有：spuId / name / price / originalPrice / specs / status
  被价格体系约束：这个具体变体按什么价格交易

Order
  借用：SKU.price 进入金额计算

CategoryTree
  作用：给 SPU 提供归属树，不参与交易计费
```

这里最重要的不是字段清单，而是三条判断：

1. 类目树约束的是 `SPU` 的归属，不是 `SKU` 的交易语义。
2. 价格体系约束的是 `SKU` 的交易语义，不是 `SPU` 的展示归属。
3. 商品域当前提供的是基础价格真相，真正的折扣和最终支付金额在后续交易域里继续收敛。

## 证据清单

这篇的关键判断主要由以下证据托底：

- 类目树的三级模型：`my-xhs-product/src/main/java/com/myxhs/product/entity/Category.java:9`
- 分类树读路径与缓存：`my-xhs-product/src/main/java/com/myxhs/product/service/CategoryService.java:20`、`my-xhs-product/src/main/java/com/myxhs/product/service/CategoryService.java:46`、`my-xhs-product/src/main/java/com/myxhs/product/service/CategoryService.java:84`
- `SPU` 必须带 `categoryId`：`my-xhs-product/src/main/java/com/myxhs/product/dto/request/SpuCreateRequest.java:18`
- `SPU` 创建时强校验类目存在：`my-xhs-product/src/main/java/com/myxhs/product/service/SpuService.java:261`
- `SKU` 价格字段与校验：`my-xhs-product/src/main/java/com/myxhs/product/dto/request/SkuCreateRequest.java:23`、`my-xhs-product/src/main/java/com/myxhs/product/entity/Sku.java:29`
- 订单只借用 SKU 轻量价格真相：`my-xhs-order/src/main/java/com/myxhs/order/dto/SkuInfoDTO.java:7`
- 分类树返回模型：`my-xhs-product/src/main/java/com/myxhs/product/dto/response/CategoryTreeVO.java:8`

## 边界清单

- 本篇只讨论类目树和价格体系如何约束 `SPU / SKU` 模型，不展开品牌体系、促销规则、券叠加和库存时序。
- “价格体系”在本文里主要指 `SKU.price / originalPrice` 这层基础交易价格，不等于完整营销价格引擎。
- 订单侧引用 `SkuInfoDTO` 的价格，说明交易域当前信任商品域提供的基础价格；后续优惠、折扣、支付金额收敛不在本文展开。
- 类目树当前是只读模型，`CategoryService` 注释已经明确指出当前版本无分类写 API 和缓存失效机制，因此“分类修改后最长 2h 生效”属于当前实现边界。
- `ai-app`、`ai-mcp`、`ai-tools` 不进入本篇分析线。

## 这篇解决了什么，还留下什么问题

这篇先解决了三个问题：

- 为什么类目树挂在 `SPU` 上，而不是挂在 `SKU` 上。
- 为什么价格主要挂在 `SKU` 上，而不是挂在 `SPU` 上。
- 为什么类目和价格看起来都属于商品字段，却分别约束了展示轴和交易轴。

但它还没回答另一个更具体的问题：当 `SPU / SKU`、类目树、价格体系都准备好之后，商品详情为什么还要再跨域聚合库存、计数和其他视图，而不是停在商品服务本地？

所以下一篇应该进入 `03-product-detail.md`，去回答**商品详情到底是一个本地模型，还是一个跨域聚合模型**。
