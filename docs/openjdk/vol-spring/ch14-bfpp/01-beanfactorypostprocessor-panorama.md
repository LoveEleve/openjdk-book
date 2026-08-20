# 为什么有的扩展改的是对象，有的改的是定义：`BeanFactoryPostProcessor` 如何在 Bean 创建前改写整个定义世界

> 本文基于 Spring Framework 6.x 当前源码。本文只讲 Spring `BeanFactoryPostProcessor` 主线的第一层：为什么容器在 `BeanPostProcessor` 之外，还必须再单独保留一套更早执行、直接面向 `BeanDefinition` 和工厂配置的后处理体系，以及 `BeanDefinitionRegistryPostProcessor`、`ConfigurationClassPostProcessor`、`PropertySourcesPlaceholderConfigurer` 为什么都站在这一层。`@Configuration` 解析纵深、`@Conditional` 自动装配纵深和作用域专题，会在后续篇章继续展开。

## 为什么 Spring 里两个名字很像的 post-processor，处理的却不是同一个世界

学到 `BeanPostProcessor` 之后，很多人都会下意识觉得：

- Spring 的扩展点大概已经讲得差不多了
- 后处理器不就是在 Bean 生命周期里找个地方切进去吗

这时再看到 `BeanFactoryPostProcessor` 和 `BeanDefinitionRegistryPostProcessor`，第一反应很容易是：

- 这是不是只是另一组差不多的回调
- 名字像，作用大概也差不多

如果只停在这个表面印象里，后面几乎一定会把 Spring 最关键的一条分界线看糊：

- `BeanPostProcessor` 处理的是**实例世界**
- `BeanFactoryPostProcessor` 处理的是**定义世界**

也就是说，这两套 post-processor 并不是“同一个扩展点的不同重载”，而是在 Spring 容器里站在两个完全不同的时空位置上。

第一层问题是：**有些扩展来得太晚，不能等对象创建出来以后再做。**

这也是为什么 `BeanPostProcessor` 虽然已经很强，但仍然不够。

因为只要对象真的创建出来，很多事情其实已经来不及了：

- Bean 的 class、scope、lazy、dependsOn 等定义信息已经确定
- 某些 `@Configuration` 里的 `@Bean` 方法如果还没被解析，后续定义压根不会进入容器
- 某些 `${...}` 占位符如果还停留在定义值里，实例化阶段看到的就是错误原文

也就是说，Spring 必须正视另一类扩展需求：

- **不是“Bean 创建以后怎么加工它”，而是“Bean 创建之前，定义世界要不要先改写”。**

第二层问题是：**定义世界和实例世界虽然连着，但它们的扩展语义根本不同。**

在实例世界里，你处理的是：

- 这个对象现在怎么注入
- 怎么初始化
- 要不要被代理
- 销毁前怎么收口

而在定义世界里，你处理的是：

- 当前容器里有哪些 BeanDefinition
- 某个定义是否要被新增、修改、删除、替换
- 工厂配置和占位符值是否要在实例化前先重写

这说明：

- `BeanPostProcessor` 关心“对象怎么继续活下去”
- `BeanFactoryPostProcessor` 关心“对象还没出生前，定义世界应先被整理成什么样”

第三层问题是：**有些扩展甚至不只是改定义，还会继续往容器里注册新的定义。**

这一步尤其关键。

因为一旦扩展点不只会修改已有 BeanDefinition，还可能继续注册新的 BeanDefinition，那么它就不再只是“工厂配置后处理”，而是在改写：

- 容器接下来到底有哪些定义可供后续主线消费

这就是 `BeanDefinitionRegistryPostProcessor` 要单独存在的根本原因。

因此，本文真正要回答的问题不是“`BeanFactoryPostProcessor` 和 `BeanPostProcessor` 有什么区别”，而是：

**为什么对 Spring 来说，定义世界必须在对象创建前就开放一整套独立的后处理协议，而且这套协议还要继续区分“改定义”和“增定义”两层能力？**

## 先看失败方案：为什么不能等 Bean 创建出来以后再修、也不能把定义处理塞回 BPP 体系

理解 `BeanFactoryPostProcessor` 主线，最好的方式不是先背接口，而是先看几种很自然、但一放到容器启动主线上就会迅速失效的朴素方案。

### 失败方案一：等 Bean 创建出来以后再改，不也一样吗

这是最容易产生的直觉。

因为从普通代码视角看，很多修改看起来都可以晚一点做：

- 先把对象创建出来
- 后面再改属性
- 真有问题再包一层代理

如果对象已经安全出生，而且你改的只是实例行为，这种思路当然没问题。

但对 Spring 来说，有一类问题一旦等到实例阶段就已经彻底晚了：

- 某个 `@Configuration` 类还没被解析成新的 BeanDefinition
- 某个占位符值还是 `${server.port}` 原文
- 某个 scope 或 lazy 属性还没被覆盖成最终值

这些都说明，Spring 真实面对的不是“稍后补改对象”，而是：

- **定义世界必须先被整理好，后面的实例创建链才能正确启动。**

也就是说，`BeanFactoryPostProcessor` 解决的不是“后续微调”，而是实例链启动前的前置整形。

### 失败方案二：那就让 `BeanPostProcessor` 更早切进去

如果意识到实例后处理太晚，第二种自然想法就是：

- 既然 `BeanPostProcessor` 已经是后处理体系
- 那不如让它再提前一点，连定义一起处理

这个方案的问题在于，它会把两个完全不同的世界重新混成一团。

因为一旦进入 `BeanPostProcessor`，它默认面对的就已经是：

- 某个正在出生或已经出生的 Bean 实例

而 `BeanFactoryPostProcessor` 面对的则是：

- 一整个 `ConfigurableListableBeanFactory`
- 以及里面还未变成实例的 BeanDefinition 集合

也就是说，这不是“时机再往前提一点”的关系，而是：

- **处理对象 vs 处理定义** 的语义差别

所以 Spring 不能只把 BPP 接口提前，而必须明确拆开：

- 实例世界一套扩展协议
- 定义世界一套扩展协议

### 失败方案三：修改定义和注册新定义反正都差不多，放同一个接口就行

如果继续往前看，很快又会冒出第三种直觉：

- 改 BeanDefinition 和注册新 BeanDefinition 不都在定义阶段吗
- 那就一个接口全做了不就行了

这个判断同样不稳。

因为“修改已有定义”和“继续往容器里加新定义”这两件事虽然都站在定义世界，但能力层次完全不同：

- 前者只是在消费当前容器已有的定义集合
- 后者则会改变“后面还有哪些定义存在”这个事实本身

也就是说，注册新定义会反过来影响：

- 后续是否还会发现新的后处理器
- `@Configuration` / `@Import` 解析之后还会不会继续膨胀出新的定义世界

这说明 Spring 需要的不是“定义世界一个总接口”，而是：

- **先有改定义的 BFPP**
- **再有能继续改写定义集合规模的 BDRPP**

## Spring 定义后处理体系的最小总图

如果把这条主线先压缩成最小模型，它可以写成下面这样：

```text
bean definitions loaded
   -> registry-level definition expansion
   -> bean factory definition mutation
   -> placeholder / configuration processing
   -> bean instantiation may begin
```

如果再换一种更容易理解的拆法，这条链可以分成四段职责：

```text
[定义后处理基础层]
BeanFactoryPostProcessor

   ->

[定义注册增强层]
BeanDefinitionRegistryPostProcessor

   ->

[关键实现一]
ConfigurationClassPostProcessor

   ->

[关键实现二]
PropertySourcesPlaceholderConfigurer
```

这张图最重要的价值，不是让读者记住几个接口名，而是先把四个问题分开：

### 一、定义后处理基础层

回答：为什么 Spring 要在实例化前开放一个“面向整个 BeanFactory 的定义修改协议”？

### 二、定义注册增强层

回答：为什么“能改定义”和“能继续注册新定义”必须再分一层？

### 三、关键实现一

回答：`@Configuration`、`@ComponentScan`、`@Import` 为什么必须依赖这条定义扩展链，而不是等实例阶段再说？

### 四、关键实现二

回答：`${...}` 占位符为什么必须先在定义世界被解析和替换，而不是等对象实例化后再补？

只要先把这四层职责分开，`BeanFactoryPostProcessor` 就不再像“BPP 的前置版本”。

## 一、`BeanFactoryPostProcessor`：Spring 先开放的是“定义世界如何被修改”，而不是“对象如何被加工”

如果先从最基础层看，`BeanFactoryPostProcessor` 最重要的一层意义其实非常清楚：

- Spring 明确承认 BeanFactory 在实例化开始前，还需要一个可被统一修改的定义阶段

也就是说，它不是在说：

- 现在来加工某个 Bean

而是在说：

- **现在先来处理整个定义世界。**

这一步特别关键。

因为它说明 Spring 的容器主线不是：

- 定义读进来
- 马上开始实例化

而是：

- 定义读进来
- 先开放一轮“定义后处理”
- 再让实例创建世界正式启动

也就是说，BFPP 面对的不是“某一个 BeanDefinition 的零散补丁点”，而是一整个在实例化前仍然可被统一改写的定义批次。这也是为什么它拿到的参数不是单个定义，而是整个 `ConfigurableListableBeanFactory`。

从整卷前十四篇一起回头看，这种写法其实很统一：

- `BeanDefinition` 把对象未来的创建规则编码成蓝图
- `BeanFactory` 把定义世界组织成能力树
- `doCreateBean()` 则在实例世界里推进单个 Bean 生命周期
- 到这里，`BeanFactoryPostProcessor` 再往前补上一层：

**在 Bean 还没出生前，定义蓝图本身也要允许被处理。**

这就是它和 `BeanPostProcessor` 最本质的区别。

- BPP 站在实例世界
- BFPP 站在定义世界

这不是执行时机先后这么简单，而是：

- **它们处理的对象根本不同。**

## 二、为什么 `BeanDefinitionRegistryPostProcessor` 必须单独存在：有些扩展不只是“改定义”，而是继续生成新定义

只要 BFPP 这层立住之后，下一步最自然的问题就是：

- 既然都在定义阶段，为什么还要单独拆出 `BeanDefinitionRegistryPostProcessor`？

答案就在于，Spring 必须正视定义世界里两种完全不同的能力：

### 1. 修改已有定义

例如：

- 改 scope
- 改 lazy
- 替换某些属性值
- 注册或调整某些工厂级设置

### 2. 注册全新的定义

例如：

- 解析 `@Configuration`
- 处理 `@ComponentScan`
- 沿 `@Import` 继续发现更多配置类
- 最终让容器里出现一批原本还不存在的 BeanDefinition

这两者虽然都发生在实例化前，但能力等级完全不同。

前者面对的是：

- 当前世界里已经有什么，我要怎么改它

后者面对的是：

- 当前世界本身还不完整，我要继续把定义世界扩出来

这就是 `BeanDefinitionRegistryPostProcessor` 必须单独存在的根本原因。

它不是“更强一点的 BFPP”这么简单，而是在表达：

- **有些扩展点本身会改变后续容器里到底还有哪些定义存在。**

这也正是为什么它站在 Registry 这一层，而不是停留在普通 BeanFactory 上：它处理的已经不只是“如何看待现有定义”，而是“定义集合本身接下来会不会继续长”。

这和普通 BFPP 的差别非常大。

因为一旦定义集合本身会继续增长，Spring 的执行主线就不能只跑一遍“拿到当前定义然后处理完”这么简单了。

## 三、为什么 BDRPP 要 while 循环收集：定义世界不是静态清单，而会在处理过程中继续长出来

只要进入 `BeanDefinitionRegistryPostProcessor` 的真实执行流程，就会碰到一个特别关键、也特别体现 Spring 味道的点：

- 为什么这里会有 while 循环不断重新收集？

这不是一个小优化问题，而是定义世界动态扩张带来的必然要求。

因为对 Spring 来说，某个 BDRPP 一旦开始工作，它完全可能：

- 注册出新的 BeanDefinition
- 而这些新定义里，又可能继续包含新的 BDRPP

也就是说，定义世界在这个阶段不是一个静态输入集合，而是：

- **边处理、边继续长。**

这就意味着，Spring 在这里不能满足于：

- 启动时扫一遍所有 BDRPP
- 调完结束

否则后面动态新出现的那些 BDRPP 根本没有机会再被执行。

所以 while 循环真正解决的，不是“代码更保险”，而是：

**定义世界的递归扩张必须被完整收束。**

这也是为什么 `ConfigurationClassPostProcessor` 能沿着：

- `@Configuration`
- `@ComponentScan`
- `@Import`

继续不断扩出新定义的关键。

所以这里最值得记住的不是“有个 while”，也不是“为了保险多扫几次”，而是：

- Spring 把“定义处理会递归生成更多定义”这件事正面建模进了启动主线

## 四、`ConfigurationClassPostProcessor`：为什么 `@Configuration` 解析必须站在定义世界，而不是实例世界

讲到这里，最典型也最能说明 BDRPP 价值的实现，就是 `ConfigurationClassPostProcessor`。

它为什么重要？因为它直接回答了一个看起来很普通、其实非常核心的问题：

- `@Configuration`、`@ComponentScan`、`@Import` 这些东西，为什么不能等对象创建出来以后再说？

答案很直接：

- 因为它们本来就在决定“后面还有哪些 BeanDefinition 会存在”

也就是说，`ConfigurationClassPostProcessor` 不是在加工某个 Bean，而是在：

- 解析配置类
- 注册新定义
- 继续扩展定义世界本身

这说明它天然属于：

- **BeanDefinitionRegistryPostProcessor 世界**

而不可能属于：

- Bean 实例世界

如果把它放晚了，后果会非常直接：

- 那些由 `@Bean`、`@ComponentScan`、`@Import` 带进来的定义，根本来不及进入后续主线

也就是说，`ConfigurationClassPostProcessor` 的位置不是“实现习惯”，而是由它操作的对象类型决定的：

- 它处理的是定义世界本身
- 所以它必须在实例化前，而且必须足够早

这也是为什么它通常站在更高优先级层，先于很多普通 BFPP 执行。

## 五、`PropertySourcesPlaceholderConfigurer`：`${...}` 为什么必须先在定义世界被替换

只要讲完配置类扩张，另一类特别典型的 BFPP 实现就会自然出现：

- `PropertySourcesPlaceholderConfigurer`

它解决的根本问题不是“怎么读环境值”，那个前面 `Environment` 一篇已经讲过了。

它真正要回答的是：

- **BeanDefinition 里那些还只是 `${...}` 原文的值，什么时候要被真正替换成环境里的结果？**

这一步特别关键。

因为如果占位符还停留在定义原文里，而后面实例创建链已经启动，那么容器就会面对：

- 该注入的值还没落成最终字符串
- 某些工厂配置和属性值仍然是未解释文本

也就是说，占位符替换不能被拖到实例后处理阶段。

它必须先在定义世界完成。

这也说明 `PropertySourcesPlaceholderConfigurer` 虽然和环境系统强相关，但它站的位置不是：

- 读取某个环境值的工具类

而是：

- **把定义世界里的占位符文本解析成真正配置值的定义后处理器。**

这就是为什么它属于 BFPP 世界，而不是 BPP 世界。

因为它加工的对象仍然是：

- BeanDefinition 中的属性值表示

而不是已经出生的 Bean 实例字段上的最终值。也就是说，它先改的是“定义里怎么写”，不是“对象里现在装着什么”。

## 六、为什么 BFPP 的排序和 BDRPP 的分层不是细节，而是定义世界能否正确收口的前提

只要 BFPP / BDRPP 的关键实现一放在一起，就会立刻出现另一个核心问题：

- 它们谁先执行？

这个问题不能被当成“只是顺序优化”。

因为顺序一旦错位，定义世界就会直接出问题：

- `@Configuration` 还没先解析，后面的定义集合就不完整
- `${...}` 还没替换，后面的工厂或属性值就还是原文
- 某些后处理器还没被发现，后续定义主线就已经往前走了

也就是说，这里的优先级不是体验优化，而是：

- **定义世界收口顺序的一部分。**

这也是为什么 Spring 要把：

- PriorityOrdered
- Ordered
- 无优先级

再一次引进来。

和前面 `Ordered` 那篇完全呼应：

- Spring 不只是让顺序存在
- 它要让很多主线都能依赖同一套分层排序协议

而在 BFPP / BDRPP 世界里，这套协议的重要性更高，因为这里一旦排错，后面整条实例主线的输入都会跟着错。

## 七、为什么 `BeanFactoryPostProcessor` 不是“创建前的 BeanPostProcessor”，而是定义世界的独立主线

看到这里，最值得回收的一个问题就是：

- `BeanFactoryPostProcessor` 到底和 `BeanPostProcessor` 的关系是什么？

最容易犯的错误，就是把它理解成：

- 只是时机更早一点的 BPP

这个理解不够稳。

更准确的说法应该是：

- `BeanPostProcessor` 站在实例世界，围绕单个 Bean 的出生、初始化、增强和退场切入
- `BeanFactoryPostProcessor` 站在定义世界，围绕“Bean 还没出生时，定义蓝图和工厂配置如何先被重写”切入

也就是说，这两条线不是“同一条扩展主线的先后阶段”，而是：

- **两个不同世界里的两套扩展协议。**

这一点越早立住，后面学习 Spring 主线就越不容易混。

因为很多看起来名字像的东西，真正差别根本不是名字，而是：

- 它到底在改对象
- 还是在改对象还没出生前的定义世界

## 八、几个最容易错的判断

### 1. `BeanFactoryPostProcessor` 就是“更早一点执行的 BeanPostProcessor”

不成立。

BPP 处理的是实例世界，BFPP 处理的是定义世界，两者不是简单前后关系，而是处理对象不同。

### 2. 修改 BeanDefinition 和注册新 BeanDefinition 没本质区别

不成立。

前者处理的是“现有定义怎么改”，后者处理的是“定义世界本身还会继续扩张”，能力层次完全不同。

### 3. `ConfigurationClassPostProcessor` 只是个配置解析工具类

不成立。

它之所以关键，是因为它在定义世界里继续生成新的 BeanDefinition，直接改变了后续容器输入。

### 4. `${...}` 占位符替换晚一点做也没事

不成立。

如果不在定义世界先替换好，后面的实例化主线看到的就还是未解析文本。

### 5. BFPP / BDRPP 的顺序只是性能优化问题

不成立。

它决定的是定义世界能否按正确顺序收口，顺序错了，后面整个实例主线的输入都会错。

## 收网：Spring 要统一的从来不是“如何在对象出生后再补一点逻辑”，而是“对象出生前定义世界如何先被整理好”

现在可以回到开头那个问题：为什么 Spring 里还要有一套 `BeanFactoryPostProcessor` / `BeanDefinitionRegistryPostProcessor`，不能只靠 `BeanPostProcessor`？

因为对 Spring 这种 IoC 容器来说，它真正要面对的不只是：

- Bean 出生后怎么加工

还包括：

- BeanDefinition 世界在实例化前是否已经完整
- 定义集合是否还会继续扩张
- 配置类、扫描结果、占位符值是否都已经被整理好

所以 Spring 的答案不是把实例后处理器提前一点，而是明确立出另一条定义世界主线：

```text
BeanFactoryPostProcessor           = 修改已存在定义与工厂配置
BeanDefinitionRegistryPostProcessor = 在定义世界继续注册新定义
ConfigurationClassPostProcessor    = 扩张定义世界的关键实现
PropertySourcesPlaceholderConfigurer = 先在定义世界解析 `${...}`
```

因此，这篇真正该带走的结论不是“Spring 还有一类叫 BFPP 的扩展点”，而是：

**Spring 把扩展问题从“对象怎么加工”进一步提升成了“对象出生前，定义世界如何先被扩张、整理和重写”的容器级协议。**

这也留下了下一篇最自然的问题：既然定义世界、BeanFactory 能力树、实例创建链、循环依赖、注入协议和后处理器体系都已经立住了，那真正把 Spring IoC 容器整体启动起来的那条总主线——`refresh()`——到底是怎样把这些分散子链在一次容器启动里串起来的？

也就是说，接下来最自然的继续点就是：

- `prepareRefresh`
- `obtainFreshBeanFactory`
- `invokeBeanFactoryPostProcessors`
- `registerBeanPostProcessors`
- `finishBeanFactoryInitialization`
- `finishRefresh`

下一篇进入 Spring 的 `refresh()` 生命周期总串联。