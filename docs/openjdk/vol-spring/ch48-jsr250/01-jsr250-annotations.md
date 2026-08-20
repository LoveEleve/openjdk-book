# 为什么 `@PostConstruct`、`@PreDestroy`、`@Resource` 在 Spring 里也能工作：JSR-250 通用注解如何接入生命周期与名字注入主线

> 本文基于 Spring Framework 6.x 当前源码。本文只讲规范层的第二篇：JSR-250 通用注解是怎样被 Spring 吸纳进自己容器主线的，`@PostConstruct` / `@PreDestroy` 如何接入 Bean 生命周期，`@Resource` 又如何以“按名字优先”的方式进入依赖注入世界。Bean 生命周期、依赖注入和 BPP 体系已经在前文展开，这里只聚焦规范边界与 Spring 的适配方式。

## 为什么这些原本属于 Java EE 世界的注解，在 Spring 里也能自然生效

前一篇已经把 JSR-330 的最小依赖注入契约讲清楚了：

- `@Inject`
- `@Named`
- `@Singleton`

Spring 兼容的不是另一套完整容器，而是把这些规范层入口适配回自己的注入和作用域主线。

只要继续往规范层走，另一批看起来更熟悉的注解就会出现：

- `@PostConstruct`
- `@PreDestroy`
- `@Resource`

它们在很多 Spring 项目里都很常见，以至于很多人几乎忘了：

- 这些其实并不是 Spring 原生发明的注解
- 它们来自 JSR-250 这条更偏 Java EE 的通用组件规范

如果只停在表面看，这些注解似乎和 Spring 的已有主线很像：

- `@PostConstruct` 像 `InitializingBean.afterPropertiesSet()`
- `@PreDestroy` 像 `DisposableBean.destroy()`
- `@Resource` 又像 `@Autowired` 的另一种写法

但只要真的往源码里追，就会发现这里最关键的问题并不是“像不像”，而是：

- **这些外部规范注解到底是怎样被接入 Spring 自己的生命周期和注入主线里的。**

第一层问题是：**JSR-250 注解覆盖了两条完全不同的 Spring 主线。**

也就是说：

- `@PostConstruct` / `@PreDestroy` 属于生命周期主线
- `@Resource` 属于依赖注入主线

这和 JSR-330 只更靠近 DI 那条线不同。它意味着 Spring 不能只写一个“小适配器”就完事，而必须在：

- Bean 初始化 / 销毁链
- 以及名字优先的资源注入链

两个世界里都建立入口。

第二层问题是：**`@Resource` 和 `@Autowired` 看起来都能注入对象，但它们的第一原则完全不同。**

`@Autowired` 的核心语义是：

- 先按类型找候选
- 多个候选再消歧

而 `@Resource` 的核心语义是：

- 先按名字找
- 找不到再退回按类型

也就是说，它不是 `@Autowired` 的同义词，而是：

- **另一种资源引用哲学。**

第三层问题是：**`@PostConstruct` / `@PreDestroy` 看起来只是回调点，但它们真正依赖的是 BPP 和销毁适配器这两条不同主线。**

也就是说：

- 初始化注解的执行依赖 `InitDestroyAnnotationBeanPostProcessor` 这类 BPP
- 销毁注解则要依赖 `DisposableBeanAdapter` / 销毁链在容器关闭时统一触发

所以它们并不是“注解自己会回调”，而是：

- **Spring 在两个不同阶段主动兑现它们的生命周期契约。**

因此，本文真正要回答的问题不是“这些注解怎么用”，而是：

**为什么对 Spring 来说，JSR-250 的三类通用注解必须分别被接入生命周期和依赖注入主线，而不能被理解成几个和 Spring 原生注解完全等价的小别名？**

## 先看失败方案：为什么不能把 `@Resource` 当作 `@Autowired` 的别名、把 `@PostConstruct` 当作普通 init-method、把 `@PreDestroy` 当作顺手回调

### 失败方案一：`@Resource` 就是 `@Autowired` 的另一种写法

这是最常见的误解。

因为从日常使用体验看，它们都能把 Bean 注进字段或 setter。

但 Spring 真正处理它们时，第一原则完全不同：

- `@Autowired` 先 byType
- `@Resource` 先 byName

如果把 `@Resource` 当成 `@Autowired` 的语法替换，就会立刻解释不通这些行为差异：

- 字段名刚好匹配 Bean 名时为什么它更“听名字”
- 同类型多个候选时，它为什么不先走 Spring 的 byType 裁决链

所以 `@Resource` 的本质不是“换个注解”，而是：

- **把 JSR-250 的资源引用语义，适配进 Spring 的 DI 世界。**

### 失败方案二：`@PostConstruct` 和 Spring init-method 完全等价，所以实现也应完全一样

表面上，它们确实都发生在 Bean 初始化时。

但如果把它们看成完全等价，就会看漏一个关键点：

- `@PostConstruct` 是规范注解
- `init-method` 是 Spring 定义世界里的配置元数据

也就是说，它们最终都能进入初始化主线，但入口完全不同：

- 一个通过注解扫描被 BPP 发现
- 一个通过 BeanDefinition 元数据在初始化链里被直接调用

所以 Spring 不能只把它们压成“同一个机制”，而必须承认：

- **它们是不同来源、最终汇流到同一条初始化收口链。**

### 失败方案三：`@PreDestroy` 只是容器关闭时顺手调一下

这个判断太轻了。

因为 `@PreDestroy` 并不是“谁想到谁调”，它依赖的是：

- 这个 Bean 是否进入了容器的销毁链
- 容器在关闭时是否按依赖顺序触发销毁
- 这个注解回调是否被登记进统一销毁适配器

也就是说，`@PreDestroy` 真正依赖的不是“关闭时顺手调用”，而是：

- **Spring 对销毁世界的统一组织。**

## JSR-250 适配主线的最小总图

如果把这条主线先压缩成最小模型，它可以写成下面这样：

```text
JSR-250 annotations
   -> lifecycle-related: @PostConstruct / @PreDestroy
   -> DI-related: @Resource
   -> CommonAnnotationBeanPostProcessor / InitDestroyAnnotationBeanPostProcessor
   -> Bean lifecycle / dependency injection mainline
```

如果再换一种更容易理解的拆法，这条链可以分成三层：

```text
[生命周期入口]
@PostConstruct / @PreDestroy

   ->

[注入入口]
@Resource

   ->

[Spring 适配层]
CommonAnnotationBeanPostProcessor / InitDestroyAnnotationBeanPostProcessor / 销毁链
```

这张图最重要的价值，不是让读者记住几个注解名字，而是先把三个问题分开：

### 一、生命周期入口

回答：为什么 `@PostConstruct` / `@PreDestroy` 明明是规范注解，却能在 Spring 生命周期里准确落点？

### 二、注入入口

回答：为什么 `@Resource` 能进入 Spring 的 DI 世界，但始终保留“名字优先”的规范语义？

### 三、Spring 适配层

回答：Spring 到底是通过哪些处理器和销毁适配器把这些外部契约重新接回自己主线的？

## 一、`@PostConstruct`：Spring 真正兼容的不是“一个初始化注解”，而是“生命周期前置收口入口”

先从 `@PostConstruct` 看。

它最容易被讲浅的一点就是：

- 初始化完以后调一下方法

这句话方向没错，但对 Spring 主线来说太薄。

更准确地说，`@PostConstruct` 在 Spring 里真正扮演的是：

- **Bean 已完成依赖注入，但还没彻底进入可用实例世界时的前置收口入口。**

也就是说，它并不是随便挂在某个阶段，而是紧贴：

- 依赖注入之后
- `afterPropertiesSet()` 之前
- 自定义 init-method 之前

这一步特别关键，因为它说明 Spring 不是简单地“认这个注解”，而是：

- 把这个规范回调非常精确地插进自己的初始化主线里

而这又依赖：

- `CommonAnnotationBeanPostProcessor`
- 它的父类 `InitDestroyAnnotationBeanPostProcessor`
- 在 `applyBeanPostProcessorsBeforeInitialization` 这个阶段扫描并执行该注解

所以 Spring 真正兼容的是：

- **一个规范层的生命周期回调契约**

而不是“碰到注解就随便调”。

## 二、`@PreDestroy`：Spring 必须先把销毁世界组织起来，规范注解才能在关闭时有位置可落

再看 `@PreDestroy`。

它最常见的误解就是：

- 跟 `@PostConstruct` 对称，关闭时调一下就行

但真正的复杂度在于，Spring 的销毁世界和创建世界本来就不是镜像对称的。

因为：

- Bean 不是一创建就自动等于“以后一定会销毁”
- 只有进入单例管理、销毁注册链的 Bean，关闭时才会被容器统一处理

这说明 `@PreDestroy` 要想真正生效，前提并不只是：

- 类上有这个注解

而是：

- Bean 已被纳入 `DisposableBeanAdapter` / 销毁链
- 容器关闭时会按依赖顺序触发销毁

也就是说，Spring 真正兼容的不是“关闭时调个注解方法”，而是：

- **把规范注解接入自己完整的销毁世界。**

所以 `@PreDestroy` 的位置，不能脱离前面 `BeanFactory` 销毁和 Bean 生命周期篇去看。

## 三、`@Resource`：Spring 适配的是资源引用哲学，而不是把它改写成 byType 容器语义

`@Resource` 是这篇里最容易和 `@Autowired` 混淆的注解。

它的核心问题不是“能不能注进去”，而是：

- 它首先在表达什么样的注入哲学？

JSR-250 给它的原始语义更接近：

- 通过资源名来引用某个资源

也就是说，Spring 在兼容它时，并没有强行把它改造成：

- 完全等价于 `@Autowired`

而是保留了这条规范边界：

- **先按名字找**
- **找不到再退回 byType**

这和前面依赖注入篇里 `@Autowired` 的 byType 优先正好形成对照。

所以 `@Resource` 的真正价值不在于“又多一个注入注解”，而在于：

- Spring 允许另一种资源引用哲学接入自己的 DI 世界
- 但不会因此改变自身 DI 主线的中心仍是 byType 裁决

也就是说，它是一种兼容式适配，而不是语义替换。

## 四、为什么 `CommonAnnotationBeanPostProcessor` 是这三类注解的共同适配层

只要把这三类注解放在一起，一个很自然的问题就会出现：

- 为什么 Spring 不为每个注解都写一个独立处理器？

因为对 Spring 来说，它真正要组织的不是“每个注解一个处理类”，而是：

- **同一组外部通用注解的统一适配层。**

这就是 `CommonAnnotationBeanPostProcessor` 存在的意义。

它统一接住：

- `@Resource`
- `@PostConstruct`
- `@PreDestroy`

但并不是把这三者压成同一种行为，而是：

- 注入类注解走依赖注入适配
- 生命周期类注解走初始化 / 销毁适配

也就是说，统一的是：

- 注解来源（都是 JSR-250）

而不是：

- 最终落入的 Spring 主线（注入 vs 生命周期）

这也说明 Spring 在这里做的是：

- **按规范来源聚合适配器**
- **再按内部语义把它们分流进不同主线**

## 五、为什么 JSR-250 的适配不是“多支持几个注解”，而是“让外部契约进入 Spring 主线”

看到这里，最值得回收的一个问题就是：

- Spring 兼容 JSR-250，到底意味着什么？

如果只从表面看，很容易说成：

- Spring 多支持了三个注解

这个说法当然有事实成分，但还不够深。

更准确的说法应该是：

- `@PostConstruct` 被接入初始化收口链
- `@PreDestroy` 被接入销毁链
- `@Resource` 被接入名字优先的注入主线

也就是说，Spring 真正做的从来不是“多认几个注解”，而是：

- **把外部通用注解契约，精准嵌进自己已经成熟的容器主线。**

这也和前一篇 JSR-330 的结论完全呼应：

- Spring 接受规范入口
- 但真正的运行时世界仍由 Spring 自己主导

## 六、几个最容易错的判断

### 1. `@Resource` 和 `@Autowired` 只是名字不同

不成立。

`@Resource` 保留了名字优先的资源引用语义，`@Autowired` 则以类型优先为主。

### 2. `@PostConstruct` 和 init-method 是同一种入口

不成立。

前者是规范注解，经由 BPP 扫描接入初始化链；后者是定义元数据，在 BeanDefinition 世界里直接声明。

### 3. `@PreDestroy` 只要写了，容器关闭时一定会执行

不完整。

它还依赖 Bean 已进入容器的销毁注册链，并由容器关闭时统一触发。

### 4. Spring 兼容 JSR-250 就说明它把自己的生命周期体系替换成了规范体系

不成立。

Spring 做的是适配入口，不是替换自己的生命周期主线。

## 收网：Spring 真正兼容的不是“几种旧注解写法”，而是“外部通用组件契约如何被重新接回自己的生命周期和注入世界”

现在可以回到开头的问题：为什么 `@PostConstruct`、`@PreDestroy`、`@Resource` 在 Spring 里也能自然工作？

因为 Spring 并不是让外部规范接管自己的容器，而是做了这样一层转换：

```text
JSR-250 注解
   -> CommonAnnotationBeanPostProcessor / InitDestroyAnnotationBeanPostProcessor
   -> 注入主线 / 初始化链 / 销毁链
```

因此，这篇真正该带走的结论不是“Spring 支持 JSR-250”，而是：

**Spring 把 JSR-250 从“外部通用注解集合”适配成了“能被自己生命周期和依赖注入主线精准接住的外部契约入口”。**

这也留下了下一篇最自然的问题：既然 JSR-330 和 JSR-250 都在说明“规范层只给出最小契约”，那 Servlet 规范在 Spring MVC 世界里又是怎样只规定最外层边界，而真正的请求调度、参数解析、消息转换、视图解析等语义全部由 Spring 自己往里填充的？

下一篇进入 Spring MVC 的 Servlet 规范边界篇。