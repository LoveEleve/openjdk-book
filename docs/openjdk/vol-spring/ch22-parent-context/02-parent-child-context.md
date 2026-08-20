# 为什么父子容器不是实现细节：Spring 如何用单向委托把根容器、子容器和应用分层边界绑定在一起

> 本文基于 Spring Framework 6.x 当前源码。本文只讲 Spring 父子容器主线：为什么 `setParent(...)` 不是简单记个字段，为什么 `getBean()`、Environment、MessageSource 这些子系统都必须各自建立一致的 parent 关系，以及为什么父子容器的查找链只能单向向上，而不能双向互看。Spring Boot 更复杂的 bootstrap / web 子上下文和 Servlet 容器整合，会在后续篇章继续展开。

## 为什么父子容器在 Spring 里从来不是“多一个上下文引用”这么简单

只要一路读到 `ApplicationContext` 实现体系，父子容器这个词就会开始反复冒出来。

你会看到类似场景：

- 根容器放 Service / Repository / DataSource
- 子容器放 Controller / Web 相关组件
- 子容器里照样能注入父容器里的 Bean
- 但父容器又不会反过来去依赖子容器的 Web Bean

如果只从表面看，这些现象很容易被讲成一句很平的话：

- Spring 支持 parent / child context

这句话当然没错，但它严重低估了父子容器在 Spring 里的真实重量。

因为对容器来说，parent 关系从来不只是：

- 我有一个上级上下文引用

它至少同时牵涉三件事：

- Bean 查找链怎么向上委托
- Environment 等上下文级能力怎么继承和合并
- MessageSource、生命周期和分层结构如何保持一致方向

也就是说，父子容器在 Spring 里不是“引用关系”，而是：

**一整套单向可见性和分层责任边界。**

第一层问题是：**parent 关系不能只在一个地方成立，它必须在多个子系统里保持方向一致。**

比如：

- BeanFactory 要知道 parent 是谁，才能向上找 Bean
- Environment 要知道 parent 是谁，才能合并上层环境属性
- MessageSource 也要知道 parent 是谁，才能在本地没命中时继续回退

这意味着 Spring 面对的根本不是“字段同步”，而是：

- **parent 链语义怎样在多个子系统里被同时建立。**

第二层问题是：**父子容器之所以重要，不只是因为能复用 Bean，更是因为它在容器层面表达了应用分层边界。**

这点特别关键。

因为一旦 parent / child 能力做错，后果不只是“有些 Bean 找不到”，还会直接破坏：

- Service 层与 Web 层的依赖方向
- 上层基础设施与下层应用组件的可见性
- 启动顺序和销毁顺序的基本前提

也就是说，Spring 这里面对的从来不是“查找方便不方便”，而是：

**父子容器是否在容器级别守住了分层架构。**

第三层问题是：**单向向上查找不是语法习惯，而是生命周期和依赖方向的硬约束。**

很多人第一次看到 parent delegation 时，会自然觉得：

- 子容器能看父容器
- 那父容器为什么不能顺手看子容器

如果只从“查得更全”角度看，双向似乎很方便。

但对 Spring 来说，这会立刻摧毁：

- 容器初始化顺序
- Web 子容器晚于根容器启动的基本节奏
- Service 不依赖 Controller 的架构边界

也就是说，父子容器的单向性不是实现偏好，而是：

- **容器世界对依赖方向的硬编码。**

因此，本文真正要回答的问题不是“Spring 父子容器怎么设置 parent”，而是：

**为什么对 Spring 来说，父子容器必须被提升成“多子系统一致的单向委托链”，而不是一个上下文对象之间的简单引用关系？**

## 先看失败方案：为什么不能只记 parent 字段、也不能让父子容器双向可见

理解 Spring 父子容器主线，最好的方式不是先背几个接口方法，而是先看几种特别自然、但一放到容器世界里就会迅速失效的朴素方案。

### 失败方案一：`setParent(...)` 不就是把 parent 字段存起来吗

这是最顺手的直觉。

因为从表面 API 看，父子容器关系确实像是：

- child.setParent(parent)
- 然后 child 记住这个引用

如果 Spring 只需要“谁是谁的父亲”这条最表面的关系，这样当然足够。

但问题在于，容器里真正依赖 parent 的从来不止一个字段：

- BeanFactory 查找要向上走
- Environment 要合并
- MessageSource 要回退

也就是说，如果只记住一个 `ApplicationContext parent` 字段，后面马上会出现更糟的问题：

- 上下文知道有 parent
- 但 BeanFactory 仍不知道该往哪找
- 或 Environment 合并了，但 MessageSource 没同步
- 最后同一个 parent 关系在不同子系统里表现出不同方向

所以 Spring 真正需要的不是“记住 parent 引用”，而是：

**让多个子系统都沿同一个 parent 方向工作。**

### 失败方案二：子容器能看父容器，父容器顺手也能看子容器不是更方便吗

这是另一个非常容易让人误判的想法。

因为从“查找能力最大化”角度看，双向似乎很诱人：

- 谁找不到都能互相看看

但一旦进入容器分层世界，这个想法会立刻出问题。

因为父子容器在 Spring 里本来就通常代表：

- 根容器：Service / Repository / DataSource
- 子容器：Web / MVC / Controller

如果允许父容器也向下看子容器，结果会怎样？

- Service 层可能开始依赖 Controller
- 根容器初始化时又去碰还没准备好的 Web 子容器
- 父子之间的依赖方向和创建顺序全部被打乱

也就是说，双向不是“更灵活”，而是：

- **直接把容器分层边界打穿。**

所以 Spring 在这里要守住的不是“查找够不够全”，而是：

- 上层能不能继续保持稳定的单向依赖秩序

### 失败方案三：父子查找只要 Bean 能向上委托就够了，Environment / MessageSource 同步不是关键

如果意识到“parent 不是只记字段”，第三种自然思路就会缩成：

- 好，那至少 Bean 查找能向上委托就行了
- 其他子系统大不了以后再说

这个判断同样不稳。

因为对 Spring 来说，parent 关系真正危险的不是某个 API 少调一次，而是：

- 它一旦在不同子系统里方向不一致，整个容器语义就会开始分裂

例如：

- BeanFactory 看到父子是 A → B
- 但 Environment 没合并或者反向错了
- MessageSource 又是另一套回退关系

最后应用层看到的就会是：

- Bean 能继承
- 配置却不继承
- 国际化消息又是另一套边界

这会让 parent / child 从“架构边界”退化成“偶然好用的局部特性”。

所以 Spring 真正要维护的是：

- **parent 关系在多个子系统上的一致性。**

## Spring 父子容器体系的最小总图

如果把这条主线先压缩成最小模型，它可以写成下面这样：

```text
child context establishes parent
   -> environment chain aligns
   -> bean factory delegation aligns
   -> message source fallback aligns
   -> single upward visibility model emerges
```

如果再换一种更容易理解的拆法，这条链可以分成四段职责：

```text
[上下文层 parent]
ApplicationContext.setParent(...)

   ->

[环境层同步]
ConfigurableEnvironment.merge(...)

   ->

[Bean 查找层同步]
parentBeanFactory / doGetBean delegation

   ->

[消息与其它子系统同步]
parent MessageSource fallback
```

这张图最重要的价值，不是让读者记住几个方法名，而是先把四个问题分开：

### 一、上下文层 parent

回答：为什么 `setParent(...)` 本身只是父子关系的入口，而不是全部？

### 二、环境层同步

回答：为什么 parent 一建立，Environment 就必须先合并？

### 三、Bean 查找层同步

回答：为什么真正高频的父子关系最终要落到 `parentBeanFactory` 委托链上？

### 四、消息与其他子系统同步

回答：为什么 MessageSource 这类子系统也必须沿同一方向建立 parent fallback？

只要先把这四层职责分开，父子容器就不再像“一个 parent 字段 + 一个 getParent() 方法”。

## 一、`setParent(...)`：Spring 真正建立的不是一个引用，而是一条跨子系统的方向约束

先从最外层 API 看，Spring 父子容器体系当然是从：

- `setParent(...)`

开始的。

但如果只把它理解成：

- 记下 parent 引用

这条主线几乎什么都没讲到。

因为对 Spring 来说，`setParent(...)` 真正重要的地方不是字段赋值，而是：

- **从这一刻起，多个子系统都必须开始沿同一方向解释 parent。**

也就是说，parent 的意义在这里不是“对象之间有关系”，而是：

- 这是后面 Environment、BeanFactory、MessageSource 都要对齐的一条方向约束

这也解释了为什么前面 BeanFactory 那篇要专门把 `HierarchicalBeanFactory` 拿出来讲。

因为 parent 关系在 Spring 里从来就不是上下文对象的装饰属性，而是容器能力树里的一条独立模型线。

## 二、为什么 Environment 先同步：父子容器不只共享 Bean，还共享“当前环境解释世界”

只要 parent 一建立，Spring 很早就会先同步的一层其实不是 Bean 查找，而是：

- Environment

这一步特别值得停一下。

因为很多人会天然觉得，父子容器最重要的应该先是：

- 子容器能不能从父容器拿 Bean

这当然很重要，但 Spring 这里更早先做的是：

- 把 parent 的环境解释世界先 merge 进来

为什么？

因为对定义世界和条件装配世界来说：

- active profiles
- 属性源
- 占位符解释语义

这些东西本来就会在 Bean 解析和条件判断之前发生作用。

也就是说，父子容器不只是共享对象，还在共享：

- **“当前配置和环境世界该怎么被解释”这套前置语义。**

这就说明 Environment 在这里不是附属能力，而是 parent 关系里更靠前的一条同步链。

没有这一步，子容器虽然也许能向上找 Bean，但它站的环境语义世界却已经和父容器脱节了。

## 三、为什么真正高频的父子委托最终落在 `parentBeanFactory`：因为 Bean 查找不能每次都绕回 ApplicationContext 门面

只要继续往 Bean 查找主线里走，就会看到父子容器真正高频的那条路径，并不是：

- `ApplicationContext.getParent()`

而是：

- `parentBeanFactory`

这一步非常关键，因为它说明 Spring 真正要优化和守住的，不是“上下文门面层关系可见”，而是：

- **Bean 查找主线里的向上委托可以直接落到 BeanFactory 世界。**

也就是说，当 `doGetBean()` 发现：

- 当前工厂本地没有这个定义
- 但上面还有 parentBeanFactory

它不会再拐回一整圈上层 ApplicationContext 门面，而是直接沿 BeanFactory 能力树向上委托。

这也正是为什么 `getInternalParentBeanFactory()` 那篇源码线索重要：

- Spring 不是抽象地在说“有个 parent”
- 它是在努力把这条父子委托链尽可能压到真正处理 Bean 的核心层上

所以 `parentBeanFactory` 不是实现细节，而是：

- **父子容器在 Bean 世界里的真正工作链。**

## 四、为什么 `containsBean(...)` 和 `containsLocalBean(...)` 的差别不能被低估

父子容器主线里，最容易被忽略但特别能说明问题的一组行为差异就是：

- `containsBean(...)`
- `containsLocalBean(...)`

很多人第一次看到它们，只会觉得：

- 一个查范围大一点
- 一个查范围小一点

这个理解太表面。

因为它们背后真正区分的是两种完全不同的容器视角：

### `containsBean(...)`

它面对的问题是：

- 从当前上下文整体视角看，这个 Bean 最终是不是能被拿到

也就是说，它天然允许向上委托。

### `containsLocalBean(...)`

它面对的问题是：

- 不看父容器，只看当前这一层本地世界里到底有没有这个定义/实例

这意味着它并不是简化版 API，而是在回答：

- **当前层自己是否真正拥有这个 Bean。**

这一步特别重要，因为一旦父子容器存在，“有没有”和“是不是我本地的”就不再是同一个问题。

这再次说明：

- 父子容器不是偶尔 fallback 一下
- 而是已经把很多最基础的容器语义都分成了“本地视角”和“整体视角”

## 五、为什么 MessageSource 也必须沿 parent 方向回退：父子容器不是 Bean 特例，而是整套上下文能力边界

只要把 Bean 查找链看清之后，另一个特别值得强调的问题就是：

- 为什么 MessageSource 也要继续跟着 parent 走？

因为这恰恰能证明，父子容器从来不是“Bean 这一个子系统的特例”。

更准确地说，Spring 在这里守住的是：

- 一旦上下文被分层
- 那么所有带“查找/回退”语义的子系统，都应该沿同一个方向建立 parent fallback

对 MessageSource 来说，这意味着：

- 当前层没命中
- 才继续向父层回退

这和 Bean 查找的单向委托精神是完全一致的。

也就是说，Spring 这里真正统一的不是“对象能不能共享”，而是：

- **分层上下文里的可见性和回退方向。**

这也是为什么前面 Environment 合并、这里 MessageSource 回退、那边 BeanFactory 委托，虽然分属不同子系统，却都要放在同一篇里讲。

因为它们真正共同回答的是同一个 parent 问题。

## 六、为什么父子容器的单向性不是习惯，而是架构边界、启动顺序和销毁顺序的共同前提

看到这里，再回头看最开始那个问题：为什么 parent 委托只能向上，不能双向互看？

现在可以看得更清楚了。

它之所以不能双向，不只是为了“代码简洁”，而是因为父子容器在 Spring 里同时承担三层约束：

### 1. 架构边界约束

- 上层根容器不应该依赖下层 Web 子容器
- Service 不该回头依赖 Controller

### 2. 启动顺序约束

- 父容器通常先准备基础设施
- 子容器再在此基础上扩展自己的 Web 世界

### 3. 销毁顺序约束

- 子容器退出时，不应反过来拖着父容器做不该做的回看依赖

也就是说，单向向上委托在 Spring 里不是语法习惯，而是：

- **把架构方向、启动方向、销毁方向压成同一个容器可见性方向。**

这也解释了为什么父子容器在 Spring 里如此基础：

- 它不是附属功能
- 它是在容器层面表达“谁依赖谁”的硬边界

## 七、为什么这篇必须放在 ApplicationContext 实现体系之后，而不是并进 BeanFactory 那篇就讲完

看到这里，最值得回收的一个问题就是：

- 父子容器为什么不在 BeanFactory 那篇顺手讲完就算了？

答案就在于：

- BeanFactory 那篇主要解决的是“能力树如何分层”
- 而这一篇真正要解决的是“这些能力一旦进入上下文分层世界，如何在多个子系统里保持方向一致”

也就是说，前者更像接口能力模型，后者更像：

- **上下文分层之后的实际运行语义。**

而这又必须放在 ApplicationContext 实现体系之后，因为你得先知道：

- 上下文作为上下文是怎么存在的
- 不同实现如何先装定义世界

之后才能真正看清：

- 一旦上下文不止一个，parent / child 关系如何沿 Bean、Environment、MessageSource 一起成立

所以这篇不是重复，而是在把父子容器从接口模型拉回真实上下文运行世界。

## 八、几个最容易错的判断

### 1. 父子容器就是 child 保存一个 parent 引用

不成立。

真正成立的是多个子系统都沿同一方向建立 parent 语义，而不只是字段保存。

### 2. 只要 Bean 查找能向上委托，其他子系统同步不重要

不成立。

Environment 合并、MessageSource 回退也必须保持同一方向，否则上下文语义会分裂。

### 3. 双向可见比单向向上委托更灵活

不成立。

双向会直接破坏分层架构、启动顺序和依赖方向边界。

### 4. `containsBean(...)` 和 `containsLocalBean(...)` 只是查找范围大小不同的小差别

不完整。

它们本质上分别代表“整体视角”和“本地视角”的容器语义区别。

### 5. 父子容器只是 Web 场景里的实现细节

不成立。

它在 Spring 里本质上是上下文分层世界的单向可见性模型。 

## 收网：Spring 要统一的从来不是“哪个上下文指向哪个上下文”，而是“分层上下文在多个子系统里如何沿同一方向工作”

现在可以回到开头那个问题：为什么父子容器在 Spring 里从来不是“多一个 parent 引用”这么简单？

因为对 Spring 这种 IoC 容器来说，它真正要面对的不是“对象关系怎么连”，而是：

- Bean 查找能不能沿同一方向向上委托
- Environment 和 MessageSource 能不能保持同样的回退方向
- 分层容器能不能在容器层面守住架构边界、启动顺序和销毁顺序

所以 Spring 的答案不是给上下文加一个字段，而是建立一条跨子系统一致的 parent 协议：

```text
ApplicationContext.setParent(...)
   -> Environment merge
   -> parentBeanFactory delegation
   -> parent MessageSource fallback
   -> single upward visibility model
```

因此，这篇真正该带走的结论不是“Spring 支持父子容器”，而是：

**Spring 把父子容器问题从“上下文之间如何引用”提升成了“分层上下文如何在 Bean、环境、消息等多个子系统里沿同一方向工作”的容器级协议。**

这也留下了下一篇最自然的问题：既然上下文分层、定义世界扩张、条件裁决和 refresh 总链都已经立住了，那事件体系又是怎样在容器启动完成后，把 ApplicationContext 里的“已经发生了什么”重新广播给监听者的？

也就是说，接下来最自然的继续点就是：

- `ApplicationEvent`
- `ApplicationListener`
- `ApplicationEventMulticaster`
- `@EventListener`

下一篇进入 Spring 的事件机制主线。