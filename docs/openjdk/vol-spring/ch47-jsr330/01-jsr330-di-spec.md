# 为什么 `@Inject` 在 Spring 里也能工作：JSR-330 依赖注入规范与 Spring `@Autowired` 体系的契约边界

> 本文基于 Spring Framework 6.x 当前源码。本文只讲规范层的第一篇：JSR-330 依赖注入规范是如何被 Spring 适配进自己的注入体系的，`@Inject`、`@Named`、`@Qualifier`(javax) 与 Spring `@Autowired`、`@Qualifier` 的关系是什么，以及为什么“规范兼容”不等于“完全等价”。具体 Bean 创建链与候选裁决逻辑，前面的依赖注入主线已经展开过，这里只聚焦规范边界。

## 为什么 Spring 明明有 `@Autowired`，却还要支持 `@Inject`

前面依赖注入主线里，我们已经把 Spring 自己的注入协议讲清楚了：

- `AutowiredAnnotationBeanPostProcessor` 负责扫描注入点
- `DependencyDescriptor` 负责建模依赖请求
- `DefaultListableBeanFactory.resolveDependency(...)` 负责候选查找和裁决
- `@Primary`、字段名、`@Qualifier`、`@Priority` 会共同参与多候选裁决

看到这里，一个很自然的问题就会冒出来：

- 既然 Spring 自己已经有完整的 `@Autowired` 体系，为什么还要支持 `@Inject`？

这个问题如果只从“功能重复”去看，很容易得出一个过于简单的答案：

- Spring 只是顺手兼容一下 Java 标准注解

这个答案并不算错，但它还不够深。

因为对 Spring 来说，支持 JSR-330 不只是“多认几个注解”，而是在回答一个更基本的问题：

- **一个外部依赖注入规范，怎样才能在不破坏 Spring 自己核心主线的前提下，被吸纳进同一个容器体系里。**

第一层问题是：**JSR-330 提供的是最小依赖注入契约，而不是完整容器协议。**

它主要关心的是：

- `@Inject`：这个点需要依赖注入
- `@Named`：这个名字是限定信息
- `@Singleton`：这是单例范围

也就是说，JSR-330 并不想解决 Spring 里那种丰富的容器控制问题：

- `@Lazy`
- `@DependsOn`
- `@Primary`
- 条件装配
- Bean 生命周期钩子

这说明规范层和 Spring 实现层天然就不在一个语义厚度上。

第二层问题是：**Spring 兼容 JSR-330 的方式，不是另起一条注入主线，而是把规范注解适配进现有主线。**

也就是说：

- `@Inject` 不会触发另一套新的依赖注入处理器
- `@Named` 也不会开启另一套新的候选选择器

相反，Spring 会把这些注解尽可能接回已有的：

- `AutowiredAnnotationBeanPostProcessor`
- `QualifierAnnotationAutowireCandidateResolver`
- BeanDefinition 的作用域语义

这说明 Spring 真正做的是：

- **规范注解的适配**

而不是：

- **容器语义的让渡**

第三层问题是：**规范兼容并不等于行为完全等价。**

这是规范层最容易被讲糊的地方。

因为很多人一听到“Spring 支持 `@Inject`”，就会自然推断：

- 那它大概和 `@Autowired` 完全等价

实际情况并不是这样。

最明显的差异包括：

- `@Inject` 没有 `required=false`
- `@Named` 只是名字限定，表达力不等于 Spring `@Qualifier` 的全部世界
- `@Singleton` 是规范中的范围标记，但并不自动等于 Spring 单例体系的所有运行时语义

也就是说，Spring 支持 JSR-330，不是说“Spring 变成了 JSR-330 容器”，而是：

- **Spring 仍然是 Spring，只是允许外部最小 DI 契约接进来。**

因此，本文真正要回答的问题不是“`@Inject` 和 `@Autowired` 有什么区别”，而是：

**为什么对 Spring 来说，JSR-330 只能被适配进 Spring 的依赖注入主线，而不能替代 Spring 自己那套更厚的容器协议？**

## 先看失败方案：为什么不能把 `@Inject` 当成 `@Autowired` 的完全等价写法，也不能把 `@Named` 当成完整限定器体系

### 失败方案一：既然 Spring 支持 `@Inject`，那它和 `@Autowired` 就完全等价

这是最常见的误解。

因为从最表层使用体验看，它们确实都能写成：

```java
@Inject
private UserService userService;
```

或：

```java
@Autowired
private UserService userService;
```

并且最后都能把 Bean 注进去。

但这只说明：

- 它们都能进入 Spring 的注入主线

却不能说明：

- 它们拥有完全相同的语义能力

最典型的差异是：

- `@Autowired(required = false)` 可以表达“没找到也没关系”
- `@Inject` 本身没有对应属性

所以如果把两者完全等价，会立刻看漏掉一个关键事实：

- **Spring 兼容的是注入入口，不是把自己扩展过的容器控制语义全部压回规范。**

### 失败方案二：`@Named` 就等价于 Spring `@Qualifier`

这也是一个很容易误导人的简化。

因为从最直观的场景看：

- `@Named("vip")`
- `@Qualifier("vip")`

确实都像是在做“名字限定”。

但 Spring 的 `@Qualifier` 体系并不仅仅局限于一个字符串值。它还可以进一步参与：

- 更复杂的限定元数据
- 自定义 qualifier 注解
- 和 `@Primary`、字段名、`@Priority` 一起进入多候选裁决链

而 `@Named` 更多表达的是：

- 这是一个名字级别的限定

所以两者在最常见的简单命名场景里能重叠，但不意味着它们在容器表达力上完全相等。

### 失败方案三：`@Singleton` 写上以后，就等于 Spring 的 singleton 语义全部成立

这个判断也不稳。

因为 Spring 的 singleton 世界远不只是：

- 这个 Bean 在容器里只有一份

它还牵涉：

- eager / lazy 预实例化
- 三级缓存
- 提前暴露
- 循环依赖
- Bean 销毁管理

而 JSR-330 的 `@Singleton` 更像是在规范层表达：

- 这是一个容器单例

也就是说，它给的是：

- 最小范围声明

而不是：

- Spring 单例主线的全部运行时细节

所以这里最关键的不是“是否都叫 singleton”，而是：

- **规范只声明边界，Spring 负责把边界落实成复杂运行时语义。**

## JSR-330 与 Spring DI 的最小总图

如果把这条主线先压缩成最小模型，它可以写成下面这样：

```text
JSR-330 annotations
   -> Spring annotation scanning / candidate resolution
   -> reuse Spring injection pipeline
   -> keep Spring-specific control semantics outside the spec layer
```

如果再换一种更容易理解的拆法，这条链可以分成三层：

```text
[规范声明]
@Inject / @Named / @Singleton

   ->

[Spring 适配层]
AutowiredAnnotationBeanPostProcessor / Qualifier resolver / BeanDefinition scope mapping

   ->

[Spring 容器主线]
依赖注入 / 候选裁决 / 单例生命周期 / 扩展控制信号
```

这张图最重要的价值，不是让读者记住几个注解，而是先把三个问题分开：

### 一、规范声明

回答：JSR-330 到底只规定了哪些最低限度的依赖注入契约？

### 二、Spring 适配层

回答：Spring 是怎样把这些规范注解接入自己现有依赖注入主线的？

### 三、Spring 容器主线

回答：为什么规范兼容之后，实际运行时仍然站在 Spring 自己的容器语义上？

## 一、`@Inject`：Spring 真正兼容的是“注入入口”，不是另一套注入系统

先从 `@Inject` 看。

它在 JSR-330 里表达的是最基本的一句话：

- 这里需要注入一个依赖

Spring 之所以能支持它，不是因为它为 `@Inject` 另写了一套从头到尾的新注入机制，而是因为它把 `@Inject` 接到了原有的 `AutowiredAnnotationBeanPostProcessor` 上。

也就是说，对 Spring 来说，`@Inject` 的真正意义不是：

- 引入另一套依赖注入实现

而是：

- **让一个规范层注解，成为现有注入主线的另一个合法入口。**

这一步特别重要。

因为它说明 Spring 的适配方式非常克制：

- 外部规范注解可以进来
- 但一旦进来，就统一走 Spring 自己的依赖解析、候选查找和注入链

所以 `@Inject` 在 Spring 里不是独立体系，而是：

- **Spring 注入主线的一种兼容入口。**

## 二、为什么 `@Inject` 和 `@Autowired` 看起来很像，却不该被讲成完全等价

只要继续比较，就会发现这两者最大的差异并不在“能不能注进去”，而在：

- **能表达多少容器控制语义。**

`@Autowired` 是 Spring 自己的注入注解，所以它天然会带着 Spring 容器自己的思路：

- `required = false`
- 配合 `@Lazy`
- 配合更完整的 Spring 候选裁决语义

而 `@Inject` 更接近：

- 我只声明这里需要注入
- 规范本身不替你扩展更多容器专属控制信号

这也就解释了为什么：

- `@Inject` 可以被 Spring 支持
- 但它不会反过来定义 Spring 的整个注入世界

也就是说，两者相似的是入口，不相似的是表达力。

## 三、`@Named`：Spring 兼容的是名字限定，但不把自己的完整限定器体系缩成一个字符串

再看 `@Named`。

它最直观的语义就是：

- 这个依赖我希望用某个名字来限定

Spring 之所以能兼容它，是因为自己的候选裁决主线本来就包含：

- 名字匹配
- qualifier 过滤

所以对最常见的 `@Named("beanName")` 场景，Spring 可以很自然地把它适配成自己的限定器世界。

但这里必须补一个边界：

- Spring 的 `@Qualifier` 世界不只等于字符串名字

也就是说，`@Named` 和 `@Qualifier("x")` 在很多简单场景里会重叠，但这并不代表：

- Spring 完整的 qualifier 语义可以被 `@Named` 一个注解完全替代

所以更准确的说法应该是：

- Spring 兼容了规范层的“名字限定”概念
- 但没有把自己的限定器体系压缩回一个最小规范表达

## 四、`@Singleton`：规范声明的是范围，Spring 兑现的是整套单例运行时语义

如果说 `@Inject` 和 `@Named` 主要落在注入阶段，那么 `@Singleton` 最关键的意义则在范围层。

JSR-330 用它表达：

- 这个类型在容器里应被当成单例

这是一条很重要的规范契约，但它只给出：

- 范围边界

而没有给出 Spring 单例世界里的全部运行时语义。

前面单例、循环依赖和作用域篇已经讲过，Spring 的 singleton 远不只是：

- 只有一份实例

它还连着：

- eager / lazy
- 三级缓存
- 提前暴露
- 生命周期销毁
- 依赖关系与作用域分流

也就是说，`@Singleton` 在 Spring 里更像：

- **规范层的范围声明信号**

而 Spring 再继续用自己的 BeanDefinition、BeanFactory、生命周期链把这个范围信号落实成完整的单例运行机制。

所以这里真正要记住的不是“都叫 singleton”，而是：

- 规范负责声明
- Spring 负责兑现

## 五、为什么 JSR-330 在 Spring 里是“适配”，不是“让位”

看到这里，最值得回收的一个问题就是：

- Spring 既然支持 JSR-330，是不是意味着自己的注入体系不重要了？

答案当然是否定的。

因为从整个源码主线回头看，Spring 一直做的是：

- 允许外部规范入口接进来
- 但真正运行时，仍然统一落回自己的容器协议

也就是说：

- 规范兼容，不等于容器让位
- 外部注解可以成为入口
- 但 BeanDefinition、候选裁决、生命周期、作用域、后处理器这些主线，仍然是 Spring 自己的世界

这也说明规范层之所以值得单独成篇，不是为了重复文档，而是为了帮助读者建立一个非常重要的边界感：

- **哪些是跨容器都该成立的最小契约**
- **哪些是 Spring 自己额外提供的更厚语义**

## 六、几个最容易错的判断

### 1. `@Inject` 和 `@Autowired` 完全等价

不成立。

它们都能进入 Spring 注入主线，但 Spring 的 `@Autowired` 具备更强的容器控制表达力，例如 `required=false`。

### 2. `@Named` 就等于完整的 Spring `@Qualifier` 体系

不成立。

它能覆盖最常见的名字限定场景，但 Spring 的限定器世界不止一个字符串。

### 3. `@Singleton` 写上以后，就已经等于 Spring 的单例主线全部成立

不成立。

它只声明范围信号，真正的单例缓存、生命周期和提前暴露语义仍由 Spring 自己兑现。

### 4. Spring 支持 JSR-330 就说明它内部换成了 JSR-330 的容器模型

不成立。

Spring 做的是适配，而不是替换自己的容器主线。

## 收网：Spring 真正兼容的不是“另一套容器”，而是“另一套最小注入契约入口”

现在可以回到开头的问题：为什么 `@Inject` 在 Spring 里也能工作？

因为 Spring 并没有为 JSR-330 再造一套注入容器，而是把：

- `@Inject`
- `@Named`
- `@Singleton`

这些规范层信号，接回自己已经成熟的依赖注入、候选裁决和作用域主线里。

也就是说，JSR-330 在 Spring 里的真实位置可以压成：

```text
规范注解
   -> Spring 适配层
   -> Spring 原有注入 / 候选 / 生命周期世界
```

因此，这篇真正该带走的结论不是“Spring 也支持 `@Inject`”，而是：

**Spring 把 JSR-330 从“另一套依赖注入体系”降到“另一套最小契约入口”，并继续用自己的容器主线去兑现这些规范语义。**

这也留下了下一篇最自然的问题：既然 JSR-330 解决的是最小注入契约，那 JSR-250 里的 `@PostConstruct`、`@PreDestroy`、`@Resource` 又是怎样在 Spring 里被接入生命周期和名字注入主线的？

下一篇进入 JSR-250 通用注解主线。