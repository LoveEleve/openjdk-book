# 为什么有的配置类一开始就被跳过，有的 `@Bean` 方法要等后面才判断：Spring 的 `@Conditional` 两阶段装配主线

> 本文基于 Spring Framework 6.x 当前源码。本文只讲 Spring 条件装配体系的第一层：为什么容器不能把所有 `@Conditional` 都当成“遇到就立刻判断一次”的布尔开关，而必须通过 `Condition`、`ConfigurationCondition`、`ConditionEvaluator`、`ConditionContext` 与 `PARSE_CONFIGURATION / REGISTER_BEAN` 两阶段语义，把条件判定严格绑定到定义世界的不同时间点上。Spring Boot 更大的 `@ConditionalOnClass`、`@ConditionalOnBean`、`@ConditionalOnProperty` 自动装配世界，会在后续篇章继续展开。

## 为什么 `@ConditionalOnClass` 和 `@ConditionalOnBean` 看起来都像条件，判断时机却完全不同

前面我们已经分别讲过几条和条件世界强相关的主线：

- `Environment` 如何组织配置来源和占位符语义
- `@Profile` 如何通过 `@Conditional(ProfileCondition.class)` 进入条件装配体系
- `refresh()` Step 5 如何先收口定义世界，再让实例世界启动
- `@Configuration`、`@ComponentScan`、`@Import` 如何在定义世界里递归扩张 BeanDefinition

只要把这些线放在一起，一个更尖锐的问题就自然冒出来了：

- 既然条件装配最终都是“满足就保留，不满足就跳过”，为什么 Spring 还非要分阶段判断？

这个问题如果只用一句“有些条件依赖 Bean，有些依赖类路径”当然能回答一半，但还远远不够。

因为对 Spring 来说，真正要处理的不是“条件长得不一样”，而是：

- **不同条件依赖的信息，本来就在定义世界的不同时间点才可达。**

第一层问题是：**有些条件在配置类刚被看见时就能判断，有些则必须等定义世界更完整以后再判断。**

例如：

- `@ConditionalOnClass` 只要类路径和类加载器信息，就可以较早决定
- `@ConditionalOnBean` 却要等容器里相关 BeanDefinition 先注册出来，才有意义

也就是说，Spring 面对的不是“一套统一输入上的布尔表达式”，而是：

- **一组依赖可达信息不同的条件策略。**

第二层问题是：**条件装配首先处理的不是 Bean 实例，而是定义世界里的“这个东西还要不要继续存在”。**

这一步特别关键。

因为只要一个条件不满足，Spring 不是在运行时把某个对象关掉，而是会直接做出更早的决策：

- 跳过这个配置类
- 跳过这个 `@Bean` 方法
- 让它后面的定义世界根本不再扩张

也就是说，`@Conditional` 的本质不是行为开关，而是：

- **定义世界入口的裁决器。**

第三层问题是：**条件系统不能只看注解值，还必须知道当前容器在定义世界里已经走到了哪一步。**

这也是 `ConditionEvaluator` 真正复杂的地方。

因为对 Spring 来说，同一个条件接口虽然都是：

- `matches(context, metadata)`

但它背后的问题却并不一样：

- 现在这个 metadata 属于配置类解析阶段吗
- 还是已经是方法级 BeanDefinition 注册阶段
- 当前 `BeanFactory`、`Environment`、`ClassLoader` 到底准备到什么程度了

也就是说，Spring 真正要统一的并不是“如何执行一个 matches 方法”，而是：

- **在定义世界的不同阶段，条件判定应该站在什么信息视角上工作。**

因此，本文真正要回答的问题不是“Spring 的 `@Conditional` 怎么用”，而是：

**为什么对 Spring 来说，条件装配必须被提升成一条带有阶段语义的定义世界裁决主线，而不是一组立即求值的布尔开关？**

## 先看失败方案：为什么不能“看到条件就立刻判”、也不能所有条件都等到最后再一起判

理解 Spring 的条件装配主线，最好的方式不是先背接口，而是先看几种很自然、但一放到定义世界里就会迅速失效的朴素方案。

### 失败方案一：看到 `@Conditional` 就立刻判断一次，满足则继续，不满足就跳过

这是最符合直觉的方案。

因为从使用者视角看，条件注解看起来就是：

- 一个注解
- 一个判断
- 一个 true/false 结果

如果容器面对的永远只是类路径、环境属性这类静态信息，这种“立刻判断”似乎完全可行。

但问题在于，Spring 真实的条件世界里，很多条件并不依赖同一类输入。

比如：

- `@ConditionalOnClass` 只看类路径
- `@ConditionalOnBean` 却要看 BeanDefinition 是否已经在容器里出现

也就是说，“看到注解就立刻判”会直接把一类条件误杀掉：

- 定义世界还没长完整
- 但你已经要求它现在就回答“某个 Bean 是否存在”

这说明 Spring 真正要避免的不是“多判断几次”，而是：

- **在错误的阶段拿不完整的信息做过早裁决。**

### 失败方案二：那就等所有定义都收完以后，再统一判断所有条件

如果意识到“太早判断”不对，第二种自然思路就会变成：

- 好，那我不早判了
- 等所有定义都进来以后，再统一裁决

这个方案看起来比前一个稳，但它同样不够。

因为对 Spring 来说，有些条件之所以必须在更早阶段生效，恰恰是因为：

- 它决定了后续定义世界还要不要继续扩张

例如：

- 一个配置类如果在 PARSE 阶段就应被跳过
- 那它里面的 `@ComponentScan`、`@Import`、`@Bean` 根本都不该继续发生

也就是说，晚判虽然避免了“信息不够”的问题，却会错过另一种更关键的控制点：

- **某条定义扩张链是否一开始就该被拦下。**

所以 Spring 不能把所有条件都拖到最后统一裁决。

### 失败方案三：`@Profile`、`@ConditionalOnClass`、`@ConditionalOnBean` 各自找地方写特判就行

还有一种很诱人的思路是：

- `@Profile` 一套逻辑
- `@ConditionalOnClass` 一套
- `@ConditionalOnBean` 再一套
- 反正结果最后都是 skip / keep

这个方案的问题在于，它会让 Spring 失去最重要的一种能力：

- **所有条件都站在同一个定义世界裁决框架里。**

一旦每种条件自己找地方切，后面就会出现：

- 谁先判谁后判没有统一协议
- 某些条件看的是解析前定义世界，某些看的是注册后定义世界，但没有显式模型表达
- 条件世界会退化成很多 scattered 特判

所以 Spring 真正要建立的，不是“很多条件实现类”，而是：

- 一个统一的条件裁决引擎
- 再让不同条件实现自己声明“我应该在哪个阶段工作”

## Spring 条件装配体系的最小总图

如果把这条主线先压缩成最小模型，它可以写成下面这样：

```text
metadata with @Conditional semantics
   -> ConditionEvaluator
   -> collect Condition instances
   -> decide phase
   -> evaluate with current ConditionContext
   -> skip or keep definition world branch
```

如果再换一种更容易理解的拆法，这条链可以分成四段职责：

```text
[条件声明]
@Conditional / @Profile / OnXxx annotations

   ->

[统一裁决入口]
ConditionEvaluator

   ->

[阶段语义]
ConfigurationCondition / PARSE_CONFIGURATION / REGISTER_BEAN

   ->

[运行时上下文]
ConditionContext
```

这张图最重要的价值，不是让读者记住几个接口名，而是先把四个问题分开：

### 一、条件声明

回答：配置类、`@Bean` 方法究竟通过什么方式把“条件语义”挂进定义世界？

### 二、统一裁决入口

回答：为什么 Spring 不让每种条件自己找地方切，而要统一走 `ConditionEvaluator`？

### 三、阶段语义

回答：为什么条件系统必须显式承认“某些条件属于解析期，某些属于注册期”？

### 四、运行时上下文

回答：条件实现到底通过哪些可达信息来决定 matches 结果？

只要先把这四层职责分开，`@Conditional` 就不再像“又一个布尔注解”。

## 一、`@Conditional`：Spring 先统一“条件语义如何挂进定义世界”，再统一“这些条件在哪里被评估”

从声明层先看，Spring 条件系统最重要的一步并不是 `Condition` 接口，而是：

- 容器先承认“定义世界可以带条件语义”

也就是说，`@Conditional` 的意义不只是“给某个类贴条件”，而是：

- 把“这个定义受条件控制”这件事，以统一元数据方式挂进配置类或 `@Bean` 方法

这一步很重要，因为它说明 Spring 关心的从来不是：

- 某个实现类怎么判断

而是：

- **定义世界怎样先带着条件语义进入后续解析链。**

这和前几篇的写法完全一致：

- `BeanDefinition` 把创建规则提前编码进定义蓝图
- `@Scope` 把生命周期分流语义提前编码进定义蓝图
- 而 `@Conditional` 则把“是否还值得继续存在”的语义提前编码进定义蓝图

也就是说，Spring 在这里处理的依旧首先是定义世界，而不是运行时对象世界。

## 二、`ConditionEvaluator`：真正统一的不是某种条件实现，而是“定义要不要继续往下走”的裁决入口

只要条件语义已经挂进定义世界，下一步最自然的问题就是：

- 到底谁来判？

Spring 的答案不是让每种条件自己找调用点，而是把这件事统一收口到：

- `ConditionEvaluator`

它最关键的价值，不是“帮忙调一下 `matches()`”，而是：

**把定义世界是否继续向下推进这件事，统一收成一个裁决入口。**

也就是说，`ConditionEvaluator` 真正面对的不是：

- 这个条件理论上成立吗

而是：

- **当前这个定义分支应不应该继续向后扩张、注册或进入后续主线。**

这一步特别重要，因为它把条件系统从“注解功能”升级成了：

- 定义世界总调度的一部分

这也解释了为什么上一篇 `@Profile` 里我们一直强调：

- `shouldSkip(...)` 比 “matches 吗” 更贴近 Spring 真正的运行时问题

因为容器要做的不是回答布尔题，而是决定：

- 这条定义链现在还要不要继续活下去

## 三、为什么 `ConfigurationCondition` 必须把条件世界拆成 PARSE 和 REGISTER 两阶段

只要继续往条件裁决深处看，就会碰到这套体系最核心的设计点：

- `ConfigurationCondition`
- `PARSE_CONFIGURATION`
- `REGISTER_BEAN`

这一步之所以关键，不是因为它提供了两个枚举值，而是因为它把条件世界最重要的真实边界正式建模出来了：

- **定义世界在不同阶段，可达信息并不相同。**

也就是说，Spring 在这里不是在说：

- 条件总会在某个统一时刻一起判断

而是在说：

- 有些条件只能在配置类解析期判断
- 有些条件必须等到 BeanDefinition 注册期才有意义

这和前面 `refresh()` 那篇的 Step 5 主线完全呼应：

- 定义世界不是静态块
- 它会在解析过程中继续扩张
- 所以条件系统也不能只有一个统一时间点

### `PARSE_CONFIGURATION`：判断“这条配置类扩张链要不要一开始就被拉起”

这个阶段面对的更像：

- 类路径
- 环境属性
- profile
- 注解元数据本身

它最适合回答的是：

- 这个配置类值不值得继续展开

也就是说，PARSE 阶段在控制的是：

- **定义扩张链的入口。**

### `REGISTER_BEAN`：判断“某个具体定义在更完整的定义世界里要不要真的落地” 

而到了注册阶段，容器能看到的信息更多了：

- 其他定义是否已经进入 BeanFactory
- 某些候选 BeanDefinition 是否已经存在

这时像 `@ConditionalOnBean` 一类条件才终于有意义。

所以 REGISTER 阶段控制的就不再是“入口要不要开”，而更像：

- **某个方法级定义、某个具体注册动作最终要不要真的落地。**

这就是为什么 Spring 条件装配体系必须是两阶段，而不能是一阶段全包。

## 四、为什么 `ConditionContext` 才是条件真正站的“信息世界”

只要阶段语义立住之后，下一个问题就会自然冒出来：

- 条件实现到底靠什么信息来判断？

Spring 的答案并不是让每个 `Condition` 自己去全局乱找，而是通过 `ConditionContext` 把当前可达的信息世界统一收口。

也就是说，对条件实现来说，它不应该自己再去拼装：

- 环境信息
- BeanFactory
- 类加载器
- 资源加载能力

这些东西，而应统一从上下文里拿。

这一步特别重要，因为它说明 Spring 条件系统真正统一的，不只是“怎么调条件”，还包括：

- **条件在当前阶段被允许看见哪些信息。**

也就是说，`ConditionContext` 不是工具参数，而是条件运行时的合法视野边界。

这也是为什么：

- `OnClass` 类条件会主要依赖 `ClassLoader`
- `OnProperty` 这类条件会依赖 `Environment`
- `OnBean` 这类条件会依赖 `BeanFactory`

所以条件世界并不是“大家都在同一个全知视角里判断”，而是：

- 在统一上下文协议下，按当前阶段看当前可达的信息世界

## 五、为什么 `@Profile` 看起来简单，却已经是整个条件世界的缩影

前面专门写过 `@Profile`，现在再回头看，它的位置就会更清楚了。

因为 `@Profile` 之所以像一个非常容易理解的小条件，并不是因为条件装配世界本身简单，而是因为：

- 它依赖的是环境信息
- 这类信息在 PARSE 阶段就已经相对稳定可达

也就是说，`@Profile` 的“简单”，其实是条件世界里最轻的一种情形：

- 不必等 BeanDefinition 注册更完整
- 不强依赖后续定义世界状态
- 只要环境和注解元数据基本可达，就能先做裁决

这也解释了为什么上一篇把 `@Profile` 写成“进入条件世界的最轻入口”是合理的。

而这篇往前再推一步之后，读者就能看清：

- `@Profile` 不是一套独立系统
- 它只是条件装配总协议里最容易先看懂的一种具体条件

## 六、为什么 Spring Boot 的 `@ConditionalOnClass`、`@ConditionalOnBean` 必须建立在这套两阶段体系上

看到这里，最值得回收的一个问题就是：

- 为什么 Spring Boot 自动装配离不开这套条件世界？

答案其实已经呼之欲出了。

因为 Boot 面对的自动装配世界，本来就要求：

- 有些类条件得先在 PARSE 阶段过滤
- 有些 Bean 存在性条件又必须晚到 REGISTER 阶段过滤

如果没有这套两阶段条件模型，Boot 几乎就无法稳定工作。

因为：

- `@ConditionalOnClass` 太晚判，会让很多本来根本不该解析的配置先白白进入世界
- `@ConditionalOnBean` 太早判，又会因为相关 BeanDefinition 还没到位而被误杀

也就是说，Boot 之所以能表现成“按需自动装配”，底层并不是很多注解魔法，而是：

- Spring 核心容器已经先把条件装配世界的阶段边界、裁决入口和上下文协议建好了

这也说明当前这篇虽然站在 Framework 卷里，但它本质上已经在给后面 Boot 自动装配卷打地基。

## 七、为什么这篇必须放在配置类处理主线之后，而不是和 `@Profile` 合并写完就算了

看到这里，再回头看当前写作顺序，其实会更清楚：

- 为什么 `@Profile` 先写
- 为什么 `@Conditional` 还必须单独再写一篇

原因就在于：

- `@Profile` 解决的是“最轻、最先能讲清的环境条件入口”
- 当前这篇则要正式把条件装配的阶段世界、定义世界裁决入口和上下文协议全部拉开

而它之所以必须放在配置类处理之后，是因为：

- 条件系统真正裁决的对象就是配置类和方法级定义世界
- 不先讲清 Step 5 的定义递归扩张，`PARSE_CONFIGURATION` / `REGISTER_BEAN` 两阶段就会显得悬空

也就是说，这篇不是一个注解专题，而是：

- `refresh()` Step 5 里定义世界继续收口时的裁决体系总说明

## 八、几个最容易错的判断

### 1. 所有 `@Conditional` 都应该在看到注解时立刻判断

不成立。

有些条件依赖的信息只在后续定义世界更完整时才可达，所以必须分阶段。

### 2. `@ConditionalOnBean` 和 `@ConditionalOnClass` 只是条件内容不同，评估时机无所谓

不成立。

它们依赖的信息世界不同，这正是两阶段条件模型必须存在的原因。

### 3. `ConditionEvaluator` 只是帮忙调一下 `matches()`

不成立。

它真正统一的是“定义世界的哪一条分支现在要不要继续往后走”的裁决入口。

### 4. `ConditionContext` 只是工具参数包

不完整。

它本质上定义了条件在当前阶段被允许看见的信息世界。

### 5. `@Profile` 已经足够代表整个条件装配体系

不成立。

它只是最轻的一类环境条件，真正的条件装配体系还要解决阶段差异、Bean 存在性、定义世界收口等更复杂的问题。

## 收网：Spring 要统一的从来不是“怎么写几种条件注解”，而是“定义世界何时、按什么信息视角被裁决是否继续存在”

现在可以回到开头那个问题：为什么 `@ConditionalOnClass` 和 `@ConditionalOnBean` 看起来都像条件，Spring 却要专门建立两阶段条件装配体系？

因为对 Spring 这种 IoC 容器来说，它真正要面对的不是“布尔表达式怎么判断”，而是：

- 当前定义在这个阶段能看到哪些信息
- 这个阶段就该不该继续让它存在
- 过早判断会不会误杀、过晚判断会不会放过不该存在的定义
- 条件裁决如何稳定嵌进 Step 5 的定义扩张与收口主线

所以 Spring 的答案不是把所有条件都写成同一时刻立即求值，而是建立一条完整条件装配协议：

```text
@Conditional / @Profile / OnXxx annotations
   -> ConditionEvaluator
   -> ConfigurationCondition phase split
   -> ConditionContext information world
   -> skip or keep definition branch
```

因此，这篇真正该带走的结论不是“Spring 有个 `Condition` 接口”，而是：

**Spring 把条件问题从“某个注解怎么判断”提升成了“定义世界在不同阶段、站在不同信息视角下，如何被统一裁决是否继续存在”的容器级协议。**

这也留下了下一篇最自然的问题：既然条件世界已经立住了，那最终负责“真正把配置类世界、条件裁决、BeanDefinition 扩张和实例化总点火”收成一次整体容器行为的，还是那条最外层的 `ApplicationContext` 及其实现体系——也就是容器自己是谁、怎么持有 BeanFactory、怎么把这整套总启动链落地的问题。

也就是说，接下来最自然的继续点就是：

- `ApplicationContext` 与 `GenericApplicationContext`
- `AnnotationConfigApplicationContext`
- 容器持有 BeanFactory 的方式
- 为什么 Spring 还要有“上下文实现体系”这一层

下一篇进入 Spring 的 `ApplicationContext` 实现体系主线。