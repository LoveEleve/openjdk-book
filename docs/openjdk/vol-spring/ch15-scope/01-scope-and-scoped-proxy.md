# 为什么 `singleton` 不是默认就完了：Spring 的作用域、Web Scope 与 Scoped Proxy 如何把“同一个定义”分流成不同生命周期

> 本文基于 Spring Framework 6.x 当前源码。本文只讲 Spring Bean 作用域主线的第一层：为什么容器不能把所有 Bean 都当成默认单例来处理，而必须引入 `Scope` 接口、`singleton / prototype / request / session` 这些不同作用域语义，以及 `ScopedProxyFactoryBean` / `ScopedProxyCreator` 这套代理化补丁来解决“短作用域 Bean 注入长作用域 Bean”的矛盾。自定义 Scope、Web 容器更细集成和 `refresh()` 前半段总串联，会在后续篇章继续展开。

## 为什么看起来只是“一个对象活多久”，最后会长成 Spring 的一整条作用域主线

第一次学 Spring 作用域时，很多人都会先把它想成一个很轻的配置项。

因为表面上你最常看到的通常只是：

- 默认不写就是 `singleton`
- 特殊时写个 `@Scope("prototype")`
- Web 场景再加上 `@RequestScope`、`@SessionScope`

直觉上，这似乎只是在回答一个很朴素的问题：

- 这个 Bean 是不是每次都 new

如果站在普通对象工厂视角，这种理解当然不算错。

但一旦把视角切到 Spring IoC 容器，这个问题会立刻变得更深。

因为对 Spring 来说，作用域从来不只是“创建策略选项”，它同时还会影响：

- Bean 是不是会进入单例缓存主线
- 生命周期链的哪一段会被执行几次
- 销毁回调由谁负责
- 一个长生命周期 Bean 如何安全引用一个短生命周期 Bean

也就是说，Spring 真正要解决的不是“多几个 scope 名字”，而是：

**同一张 BeanDefinition 在不同生命周期语义下，如何被容器分流成不同的对象管理策略。**

第一层问题是：**`singleton`、`prototype` 和 Web Scope 并不只是“数量不同”，而是容器责任边界不同。**

比如：

- `singleton` 由容器缓存、复用、销毁
- `prototype` 往往由容器负责创建，但不继续负责长期托管
- `request` / `session` 又依赖 Web 请求或会话边界来决定对象何时存在

这说明作用域不是“对象个数”那么简单，而是在回答：

- **容器到底为这个 Bean 管到哪一步。**

第二层问题是：**Spring 并不是把所有 scope 都一视同仁地走 `Scope.get(...)`。**

这也是很多人第一次看源码时最容易误判的一点。

因为既然有 `Scope` 接口，直觉上很容易以为：

- 所有作用域都应该统一走 `Scope.get(name, objectFactory)`

但 Spring 恰恰没有这么做。

原因在于：

- `singleton` 在 Spring 里不是普通 Scope，它还承担三级缓存、提前暴露、循环依赖解环这些特别重的语义

也就是说，Spring 这里必须正面承认：

- **`singleton` 是作用域世界里的 Special Case。**

第三层问题是：**短作用域 Bean 注入长作用域 Bean，天然会和注入时机冲突。**

这是作用域真正变复杂的地方。

例如：

- `@Controller` 默认是 singleton
- 里面又 `@Autowired` 了一个 `@RequestScope` Bean

这时问题马上就来了：

- singleton 在容器启动时创建
- request scope Bean 却只有具体 HTTP 请求到来时才有意义

也就是说，Spring 必须继续回答：

- **如果依赖的生命周期比当前 Bean 更短，注入点到底该先放什么进去？**

这就逼出了 Scoped Proxy 这一整条补丁主线。

因此，本文真正要回答的问题不是“Spring 支持哪些作用域”，而是：

**为什么对 Spring 来说，作用域问题最后必须被提升成“定义分流策略 + Web 上下文绑定 + 代理化桥接”的完整生命周期协议？**

## 先看失败方案：为什么不能把所有 Bean 都当单例、也不能直接把 request Bean 塞进 singleton 字段里

理解 Spring 的作用域主线，最好的方式不是先背几个 scope 名字，而是先看几种非常顺手、但一放到容器里就会迅速失效的朴素方案。

### 失败方案一：所有 Bean 都当成单例就行

这是很多人初学 Spring 时最自然的想法。

因为大多数业务 Bean 确实都跑在默认单例模式下：

- Service
- Repository
- 大部分工具类

这会让人很容易进一步推断：

- 既然默认单例就很好用
- 那是不是所有 Bean 都当单例最省事

这个想法的问题在于，它把“默认最常见”误当成了“所有场景都成立”。

因为有些对象天然就不适合作为整个应用共享同一个实例：

- 需要每次请求都独立一份的状态对象
- 需要每次查都返回新对象的原型对象
- 明确绑定到会话或请求边界的数据对象

也就是说，Spring 必须承认：

- 并不是每张定义都应落入“全局唯一、长期缓存、统一销毁”的单例世界

所以作用域体系存在的第一层意义，就是把“默认单例”从自然习惯提升成：

- 一个明确可被选择、也可被偏离的容器策略

### 失败方案二：那就所有作用域都统一走一个 `Scope` 接口

如果意识到单例不够，第二种自然思路就是：

- 好，那所有 scope 都统一抽象成 `Scope`
- 容器只管调 `scope.get(...)`
- 里面想缓存还是想每次新建，都由 Scope 自己决定

这个方案在概念上很干净，但对 Spring 来说仍然不成立。

原因并不在于接口设计不够优雅，而在于：

- `singleton` 在 Spring 里承担的语义远比“缓存一下”更重

前面循环依赖篇已经说明：

- 单例世界里不仅有最终单例缓存
- 还有提前暴露、早期引用、三级缓存、AOP 早期代理这些特殊主线

这些能力都不是普通 `Scope.get(...)` 这种“要么返回缓存值，要么调用 objectFactory 创建”的协议能承载的。

也就是说，Spring 这里必须正面分裂：

- 大多数自定义 / Web Scope 可以走 `Scope` 抽象
- 但 `singleton` 不能被简单压回这一套协议里

所以 `singleton` 不是“只是默认值”，而是作用域体系里最特殊、最重的一类容器责任。

### 失败方案三：`request` Bean 注入 `singleton` 时，启动时直接创建一个先放进去不就行了

这也是作用域最经典的误区。

假设：

- `OrderController` 是 singleton
- `RequestData` 是 request scope

最朴素的想法就是：

- Controller 创建时顺手先给它注入一个 RequestData 实例
- 后面请求来了就用这个字段

这个方案的问题在于，它直接破坏了 request scope 的语义。

因为 request scope Bean 的核心前提是：

- 它应该绑定到“当前请求”

如果在 singleton 创建时就注入一个真实实例，那之后所有请求看到的都会是：

- 同一个对象

这等于把短作用域对象错误地提升成了长作用域对象。

也就是说，短作用域 Bean 注入长作用域 Bean 时，Spring 面对的真正问题不是“能不能塞进去”，而是：

- **塞进去的到底应不应该是那个真实对象。**

这就是为什么最后必须引入代理，而不是直接注入目标实例。

## Spring 作用域体系的最小总图

如果把这条主线先压缩成最小模型，它可以写成下面这样：

```text
BeanDefinition scope metadata
   -> doGetBean chooses branch
   -> singleton / prototype / custom scope strategy
   -> optional scoped proxy bridges lifetime mismatch
```

如果再换一种更容易理解的拆法，这条链可以分成四段职责：

```text
[定义分流]
BeanDefinition.scope

   ->

[容器分支]
doGetBean singleton / prototype / scope map

   ->

[作用域实现]
Scope / request / session / thread-like scopes

   ->

[生命周期桥接]
Scoped proxy
```

这张图最重要的价值，不是让读者记几个实现类，而是先把四个问题分开：

### 一、定义分流

回答：同一张 BeanDefinition 是怎样告诉容器“以后我不走默认单例路线”的？

### 二、容器分支

回答：`doGetBean()` 到底在哪个位置开始把不同 scope 分成不同处理主线？

### 三、作用域实现

回答：普通自定义 Scope、request/session Scope 到底靠什么持有对象和销毁回调？

### 四、生命周期桥接

回答：短作用域对象为什么不能直接塞进长作用域字段里，而必须先经过 Scoped Proxy？

只要先把这四层职责分开，Spring 的作用域体系就不再像一个“几个注解值”的列表。

## 一、`BeanDefinition.scope`：作用域首先不是运行时技巧，而是定义阶段就写进蓝图的生命周期分流信号

从定义世界看，作用域最容易被低估的地方在于：

- 它看起来只是一个字符串属性

比如：

- `singleton`
- `prototype`
- `request`
- `session`

但对 Spring 来说，它真正的意义绝不是“后面顺手参考一下”。

更准确地说：

**作用域是 BeanDefinition 在定义阶段就写进去的生命周期分流信号。**

也就是说，BeanDefinition 一旦声明了 scope，容器后面就不再只是在“创建一个对象”，而是在决定：

- 这个定义应进入哪一条对象管理主线
- 容器到底该为它管理到哪一步
- 后续 `getBean()` 时是否复用、是否缓存、是否需要从上下文取值

这和前面 `BeanDefinition` 那篇的结论完全一致：

- 定义世界不只是“描述一个类”
- 它是在提前写容器未来要怎么对待这个对象

所以作用域不是运行时花活，而是定义阶段就已经编码进蓝图的生命周期策略。

## 二、为什么 `singleton` 不能被当成普通 Scope：它背后连着三级缓存、提前暴露和完整单例主线

只要继续往容器分流那一层看，最关键的边界马上就出现了：

- 为什么 `singleton` 不是普通 `Scope`？

这一步特别重要，因为它最容易被过度抽象思维误伤。

从接口设计直觉看，大家很容易觉得：

- 既然各种作用域都是“按某种规则取对象”
- 那 singleton 也应该只是 `Scope` 的一种实现

这个想法在概念上看起来很漂亮，但在 Spring 源码里并不成立。

因为前面循环依赖篇已经把 singleton 世界的重量讲清楚了：

- `singletonObjects`
- `earlySingletonObjects`
- `singletonFactories`
- `getEarlyBeanReference(...)`

这些都说明，Spring 单例主线解决的根本不是“缓存一个对象”而已，而是：

- 提前暴露窗口
- 早期引用语义
- AOP 早期代理一致性
- 单例生命周期时序

而普通 `Scope.get(name, ObjectFactory)` 这种抽象，更像是在回答：

- 当前作用域里有没有现成对象
- 没有的话是否调用工厂创建

也就是说，`Scope` 协议对于普通自定义 scope 来说够用，但对于 singleton 来说太轻了。

所以 `singleton` 在 Spring 里不是“Scope 的默认实现”，而是：

- **作用域体系里的 Special Case。**

它站在更深的单例生命周期主线上，而不是站在普通 `Scope.get(...)` 协议里。

## 三、`prototype`：Spring 为什么只负责创建，不继续负责长期托管

如果 `singleton` 代表“容器负责长期持有和复用”，那 `prototype` 恰好暴露了另一个特别重要的边界：

- Spring 并不是对所有 Bean 都负相同程度的责任

很多人第一次学到 prototype 时，会自然把它理解成：

- 每次 `getBean()` 都 new 一个新对象

这当然没错，但还不够深。

更准确的说法应该是：

- Spring 对 prototype 的核心承诺是“每次请求都创建新实例”
- 但它不会像 singleton 那样继续把这个对象长期纳入自己的缓存与统一销毁主线

也就是说，prototype 最关键的教学意义不在于“每次都新建”，而在于：

**容器责任在这里明显收缩了。**

这条边界特别重要，因为它说明 Spring 的作用域系统不是单纯在玩“实例个数变化”，而是在定义：

- 容器在不同生命周期策略下，到底还要不要继续管理这个对象的后半生

所以 prototype 不是“弱一点的 singleton”，而是一个能让你清楚看见容器责任边界收缩的典型例子。

## 四、Web Scope：`request` / `session` 为什么必须把生命周期绑定到外部上下文，而不是绑定到容器缓存本身

只要继续往 Web 场景走，作用域问题就会再明显升级一次。

因为这时 Spring 面对的不再只是：

- 要不要缓存
- 要不要每次新建

而是：

- 对象的存在本身依赖于某个外部上下文是否存在

这正是 `request` / `session` scope 的特殊性。

### `request`：对象应该绑定当前 HTTP 请求

它表达的是：

- 同一个 BeanDefinition，在不同请求里应对应不同实例
- 请求结束后，这个实例也应该随请求边界一起退场

### `session`：对象应该绑定当前 HTTP 会话

它表达的是：

- 同一会话内可以复用
- 但不同用户会话之间必须隔离

这说明 Web Scope 和 singleton/prototype 的差别，不只是缓存粒度不同，而是：

- **对象的生命周期绑定到了外部 Web 上下文。**

这里再往前压一句：`request` / `session` 之所以真的复杂，不是因为多了两个 scope 名字，而是因为从这一刻开始，Bean 生命周期不再只由 Spring 容器内部阶段决定，还会显式依赖容器外部事件：

- 请求开始 / 请求结束
- 会话创建 / 会话失效

也正因为如此，Spring 这里不能只靠内部单例缓存自己玩完，而必须继续接入：

- `RequestContextHolder`
- `RequestAttributes`
- Web 请求 / 会话边界

也就是说，Web Scope 真正体现的是：

- 容器不仅管理对象
- 它还要把对象生命周期和外部运行上下文绑定起来

## 五、为什么 `RequestContextHolder` 不是小工具，而是 Web Scope 的上下文桥

只要进入 Web Scope，另一个很关键的问题就会浮出来：

- 同样调用 `getBean("requestData")`
- Spring 怎么知道当前该拿哪一个请求里的实例？

答案就在 `RequestContextHolder`。

它之所以重要，不是因为“用 ThreadLocal 存了点数据”这么轻，而是因为：

**它把 Web 外部上下文桥接回了 Spring 作用域体系。**

也就是说，Spring 不会凭空知道：

- 当前是哪个 HTTP 请求
- 当前是哪个 Session

而 `Scope` 自己也并不天然理解 HTTP 世界。它只知道：

- 给我当前上下文
- 我按这个上下文去取或创建作用域对象

所以这里必须有一个稳定的桥，把：

- 当前线程正在处理的请求语义

重新送回 Scope 实现里。

这就是为什么 `RequestContextHolder` 不只是工具类，而是：

- Web Scope 之所以能成立的上下文桥

也正因为如此，离开这个桥，`request` / `session` Scope 根本无从判断当前应返回哪个真实对象。

## 六、为什么 Scoped Proxy 是解决“短作用域注入长作用域”的唯一稳定解法

只要讲到这里，作用域体系最经典、也最容易让人一下子看懂“为什么这事没那么简单”的问题就会出现：

- singleton Bean 里注入 request scope Bean 怎么办？

这个问题之所以经典，是因为它天然暴露出一个生命周期矛盾：

- singleton 在容器启动期就会被创建
- request Bean 只有具体请求到来时才真正有意义

所以如果你在 singleton 创建时直接注入一个真实 request Bean，马上就会出事：

- 要么请求上下文根本还不存在
- 要么注进去的是某一个错误时刻的实例
- 要么它从此被 singleton 长期持有，彻底破坏了 request scope 的语义

这就是为什么 Spring 最终必须引入 Scoped Proxy。

因为它真正解决的不是“怎么塞进去一个对象”，而是：

- **怎么让长作用域 Bean 持有一个稳定引用，但把真实目标对象的解析延后到每次方法调用时。**

也就是说，singleton 里真正注入的不是 request Bean 本身，而是：

- 一个代理壳子
- 这个代理在每次调用时，才回头去当前 request/session scope 里拿真实对象

所以 Scoped Proxy 真正统一的是：

- 依赖图上的长期引用关系
- 和真实对象生命周期的短时动态获取

它不是一个“方便一点的代理技巧”，而是：

**作用域不匹配时的生命周期桥接协议。**

## 七、为什么作用域专题必须放在 BFPP 之后，而不是当作注解小节顺手讲

看到这里，最值得回收的一个问题就是：

- 为什么作用域不能只在 `@Scope` 注解那里顺手讲几句？

因为它根本不是一个注解介绍问题，而是容器主线里非常深的一条分流机制。

前面几篇已经把这些主线立住了：

- `BeanDefinition` 先把 scope 作为定义元数据写进蓝图
- `BeanFactory` 决定容器能力如何组织
- `doCreateBean()` 解释单 Bean 生命周期链
- 循环依赖说明 singleton 世界之所以特殊，是因为它背着三级缓存和提前暴露
- BFPP 又说明定义世界会在实例化前被进一步改写

到了这里，作用域主线才真正有条件被讲清：

- 同一张定义蓝图，在 `doGetBean()` 里会被分流到不同生命周期策略上
- singleton 走特殊主线
- prototype 走短托管主线
- request/session 走外部上下文绑定主线
- 生命周期冲突则交给 Scoped Proxy 收口

也就是说，这篇不是“一个小注解专题”，而是：

**Spring 容器如何把定义世界里的生命周期策略真正落成对象管理分支。**

## 八、几个最容易错的判断

### 1. 作用域只是“对象创建几次”的问题

不成立。

它同时决定容器缓存、生命周期托管、销毁责任和上下文绑定边界。

### 2. `singleton` 只是 Scope 接口的默认实现

不成立。

Spring 的 singleton 世界背着三级缓存、提前暴露和循环依赖语义，是作用域体系里的 Special Case。

### 3. `prototype` 只是每次都 new，其他都和 singleton 一样

不成立。

它最关键的差别是容器责任边界明显收缩：容器负责创建，但不再像 singleton 那样长期托管。

### 4. `request` Bean 注入 singleton 时，直接注入真实对象就行

不成立。

这会直接打破短作用域语义。真正稳定的解法是注入代理，把真实对象获取延迟到每次调用时。

### 5. `RequestContextHolder` 只是 ThreadLocal 小工具

不成立。

它是 Web 外部上下文和 Spring 作用域体系之间的桥，没有它 request/session scope 根本无法知道“当前是谁”。

## 收网：Spring 要统一的从来不是“有哪些 scope 名字”，而是“同一张定义如何被分流成不同生命周期策略”

现在可以回到开头那个问题：为什么看起来只是“Bean 活多久”的事，Spring 却要做出 Scope 接口、Web Scope、Scoped Proxy 这一整条主线？

因为对 Spring 这种 IoC 容器来说，它真正要面对的不是“多几个注解值”，而是：

- 同一张定义蓝图在不同场景下如何走不同对象管理策略
- 容器到底该为这个对象负责到哪一步
- 生命周期短长不一致时依赖关系怎么稳定成立
- Web 外部上下文如何进入容器作用域主线

所以 Spring 的答案不是在 `@Scope` 上补几种字符串常量，而是建立一条完整分流链：

```text
BeanDefinition.scope   = 生命周期策略元数据

doGetBean 分支        = singleton / prototype / custom scope 路由

Scope / Web Scope      = 上下文绑定与对象持有协议

Scoped Proxy           = 短作用域注入长作用域时的生命周期桥接
```

因此，这篇真正该带走的结论不是“Spring 支持 singleton/prototype/request/session”，而是：

**Spring 把作用域问题从“对象创建几次”提升成了“同一张定义蓝图如何被分流到不同生命周期管理策略，并在作用域不匹配时继续通过代理桥接”的容器级协议。**

这也留下了下一篇最自然的问题：既然定义世界、实例世界、循环依赖、注入协议、后处理器和作用域分流都已经立住了，那把这些子链真正串成一条容器启动总主线的 `refresh()`，到底是怎样把前面这些零散能力在一次启动里组织起来的？

也就是说，接下来最自然的继续点就是：

- `prepareRefresh`
- `obtainFreshBeanFactory`
- `invokeBeanFactoryPostProcessors`
- `registerBeanPostProcessors`
- `finishBeanFactoryInitialization`
- `finishRefresh`

下一篇进入 Spring 的 `refresh()` 生命周期总串联。