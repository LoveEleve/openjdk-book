# 为什么 `@Autowired`、`@Resource`、`@Qualifier` 看起来像在“自动注入”，其实背后是三套不同的候选选择协议

> 本文基于 Spring Framework 6.x 当前源码。本文只讲 Spring 依赖注入主线的第一层：为什么容器不能把字段注入、方法注入、按名注入、按类型注入、多候选消歧都压成一种模糊的“自动装配”，而必须通过 `AutowiredAnnotationBeanPostProcessor`、`CommonAnnotationBeanPostProcessor`、`DependencyDescriptor`、`DefaultListableBeanFactory.resolveDependency(...)`、`QualifierAnnotationAutowireCandidateResolver` 这一整条链，把不同注入语义拆成明确可裁决的协议。`BeanPostProcessor` 体系全景、`@Value` 的更细注入链和编程式 autowire，会在后续篇章继续展开。

## 为什么平时写起来都像“自动注入”，真正进容器以后却不是一回事

第一次接触 Spring 注入时，很多人都会把下面这些写法放在同一个脑抽屉里：

- `@Autowired private UserService userService;`
- `@Resource private UserService userService;`
- `@Autowired @Qualifier("vipDiscount") private DiscountService discountService;`

因为从使用者视角看，它们都像在表达同一件事：

- 我需要一个依赖
- Spring 帮我塞进来

这会非常自然地让人形成一种笼统印象：

- 注入不就是容器自动找个对象填进去吗

这个印象在入门阶段不算错，但一旦真的往 Spring 内部追，就会立刻暴露出它不够精确。

因为这些注入写法看起来相似，实际却在向容器提出完全不同的问题：

- `@Autowired` 更接近：按类型找，必要时再消歧
- `@Resource` 更接近：先按名字找，找不到再退到类型
- `@Qualifier` 更接近：我已经接受按类型这套主线，但在这个注入点上我要进一步收紧候选集

也就是说，它们不是一种注入能力的不同语法皮肤，而是：

**三种不同的候选选择协议。**

这里还要先把范围边界说清：本文讲的是 Spring 容器里最常见、最默认的注解驱动注入协议，也就是 `@Autowired` / `@Resource` / `@Qualifier` 这一组主线。它不覆盖：

- 旧 XML `autowire` 模式的全部历史分支
- 编程式 `AutowireCapableBeanFactory` 的全部世界
- 更高层框架对注入行为的再次封装

这不是在缩小问题，而是在保证后面的因果链只围绕当前最主流、最稳定的容器注入协议展开。

第一层问题是：**注入点本身需要先被扫描出来。**

这也是很多人第一次读 `@Autowired` 主线时最容易忽略的一步。

从日常代码看，好像你只是在字段上贴了个注解。

但对容器来说，它首先要先找到：

- 哪些字段是注入点
- 哪些方法参数是注入点
- 这些注入点各自带了什么元数据
- 这个元数据未来在候选选择时该怎样被解释

也就是说，注入不是从“选哪个 Bean”开始的，而是从：

- **先把注入需求抽出来**

开始的。

第二层问题是：**候选选择不是“有没有这个类型”这么简单，而是一条逐层收缩的裁决链。**

比如同一个接口有多个实现时，容器就必须继续回答：

- 先看类型是否匹配
- 再看是不是有 `@Primary`
- 再看字段名是不是刚好指向某个 Bean
- 再看有没有 `@Qualifier`
- 再看有没有 `@Priority`
- 最后如果还分不清，到底抛什么异常

这说明 Spring 真正组织的不是“自动找对象”，而是：

**依赖请求如何一步步裁决成唯一候选。**

第三层问题是：**`@Autowired` 和 `@Resource` 不是先后优先级不同，而是哲学不同。**

这点特别关键。

因为很多文章会把它们讲成：

- 一个先查这个，一个再查那个

这当然没错，但还不够深。

更准确的说法应该是：

- `@Autowired` 代表 Spring 自己的 IoC 容器哲学：以类型为中心
- `@Resource` 代表 JSR-250 / Java EE 世界带来的资源引用哲学：以名字为中心

所以这两者不是同一条链上的参数差异，而是：

- **两种不同依赖注入世界观在 Spring 容器里的共存。**

因此，本文真正要回答的问题不是“`@Autowired` 和 `@Resource` 有什么区别”，而是：

**为什么对 Spring 来说，看起来都像“自动注入”的几种写法，最后必须被拆成“注入点扫描 + 候选解析 + 按类型/按名字/局部限定消歧”的完整依赖注入协议？**

## 先看失败方案：为什么不能把注入理解成“按类型找一个”或者“按名字找一个”

理解 Spring 的依赖注入主线，最好的方式不是先背几个注解，而是先看几种特别自然、但一放到容器里就会迅速失效的朴素方案。

### 失败方案一：注入就是按类型找一个 Bean 塞进去

这是很多人第一次理解 `@Autowired` 时最自然的想法。

因为表面上看，它确实很像：

- 字段类型是 `UserService`
- 容器里找 `UserService`
- 找到就注进去

如果你的项目里每种类型永远只有一个实现，这种理解甚至几乎完全成立。

但 Spring 容器面对的真实世界很快就会打破这个前提：

- 同一个接口经常有多个实现
- 同一种类型可能既有应用 Bean，也有基础设施 Bean
- 某些场景还会出现代理对象与原始类型匹配问题

这时“按类型找一个”马上就会变成一个不完整描述：

- 如果找到多个，谁赢
- 如果一个也没找到，失败语义是什么
- 如果字段名暗示了更强意图，要不要利用

也就是说，`@Autowired` 真正要组织的不是“按类型找一个”，而是：

**先按类型找候选，再把候选一步步裁决成唯一结果。**

### 失败方案二：那就统一按名字找

如果意识到 byType 不够，第二种很自然的想法就是：

- 好，那就都按字段名或参数名找
- 反正字段通常也会按 Bean 名来命名

这个方案在少量项目里看起来也许挺顺，但它对 Spring 来说同样不够。

因为容器真正要面对的是：

- 类型语义通常比名字语义更稳定
- 字段名只是一个局部命名习惯，不应该天然压过类型系统
- 某些注入点根本不想表达“我要这个名字”，而只是说“我要这个类型”

这就是为什么 `@Autowired` 并没有采用“先名字后类型”的思路。

它真正的立场是：

- 先把类型当成主要契约
- 名字只在需要消歧时再作为更弱的意图信号使用

也就是说，Spring 并不是不会用名字，而是不想让名字成为默认主语。

### 失败方案三：多个候选时让调用方自己手工写代码挑就行

还有一种非常朴素、但和 IoC 容器哲学正面冲突的思路：

- 容器把所有候选都拿出来
- 你自己在业务代码里判断该要哪个

这个方案的问题不在于能不能工作，而在于它会把容器最核心的价值直接削掉。

因为 IoC 容器真正应该做的，不只是“保存对象”，而是：

- **替调用方把对象选择规则收回容器内部。**

如果一到多候选就把责任重新推回业务代码，那么：

- 容器失去统一选择语义
- 候选裁决分散到无数局部判断里
- `@Primary`、`@Qualifier`、名字匹配这些机制也都失去统一落点

所以 Spring 真正要解决的，不是“找到所有可能对象”，而是：

**如何把依赖请求在容器内部收束成唯一可注入结果。**

## Spring 依赖注入的最小总图

如果把这条主线先压缩成最小模型，它可以写成下面这样：

```text
injection point annotation
   -> injection metadata
   -> dependency descriptor
   -> candidate lookup
   -> candidate narrowing
   -> inject resolved bean
```

如果再换一种更容易理解的拆法，这条链可以分成五段职责：

```text
[注入点扫描]
AutowiredAnnotationBeanPostProcessor / CommonAnnotationBeanPostProcessor

   ->

[依赖请求建模]
DependencyDescriptor

   ->

[候选查找]
DefaultListableBeanFactory.resolveDependency(...)

   ->

[候选裁决]
@Primary / beanName / @Qualifier / @Priority

   ->

[最终赋值]
field.set / method invoke
```

这张图最重要的价值，不是让读者记住类名，而是先把五个问题分开：

### 一、注入点扫描

回答：容器到底在哪个阶段、通过哪些后处理器把注入点先找出来？

### 二、依赖请求建模

回答：为什么注入点不能只是“一个字段”，而要先被包装成一个容器可理解的依赖请求对象？

### 三、候选查找

回答：Spring 到底如何从容器里找到所有可能候选？

### 四、候选裁决

回答：多个候选同时存在时，`@Primary`、名字匹配、`@Qualifier`、`@Priority` 到底按什么顺序收缩？

### 五、最终赋值

回答：什么时候才真正把解析好的依赖写回字段或方法参数？

只要先把这五层职责分开，依赖注入就不再像“容器自己找个对象塞进去”的黑盒行为。

## 一、`AutowiredAnnotationBeanPostProcessor`：`@Autowired` 不是字段自己会注入，而是 BPP 在生命周期链里主动接管了这个阶段

只要先从 `@Autowired` 切入，就必须先纠正一个很常见的错觉：

- 字段上贴了 `@Autowired`
- 好像这个字段自己就有了“自动注入”能力

这当然不是真的。

更准确地说，`@Autowired` 真正开始生效的入口，不在字段本身，而在：

- `AutowiredAnnotationBeanPostProcessor`

它的重要性不在于“Spring 有个后处理器负责 `@Autowired`”，而在于它说明：

**依赖注入首先是生命周期链中的一个容器动作。**

也就是说，`@Autowired` 不是字段的魔法，而是容器在 `populateBean` 阶段，通过 BPP 主动扫描、提取并执行的注入协议。

更准确地说，`AutowiredAnnotationBeanPostProcessor` 不是“替字段赋值的工具类”，而是通过 `postProcessProperties(...)` 这个生命周期插点，把依赖注入正式插进上一章 `populateBean` 主线里的那只手。

这一步非常关键。

因为它把前一篇的生命周期主线直接接回来了：

- Bean 对象壳子先出生
- 然后才进入 `populateBean`
- 在这里，`AutowiredAnnotationBeanPostProcessor.postProcessProperties(...)` 开始接管注入点处理

也就是说，注入不是对象出生时自然发生的，而是：

- **容器在生命周期特定阶段显式执行的一步。**

这也解释了为什么依赖注入篇不能脱离 `doCreateBean()` 来看。因为它不是单独工具能力，而是 Bean 生命周期主链里最核心的一段兑现动作。

## 二、`InjectionMetadata` 与 `DependencyDescriptor`：Spring 先把“字段/方法上的注解”翻译成容器能理解的依赖请求

只要后处理器入口立住之后，下一步最自然的问题就是：

- Spring 看到一个 `@Autowired` 字段以后，到底是怎么理解它的？

这一步特别容易被讲扁成：

- 扫到字段
- 反射 set 一下

但对 Spring 来说，中间其实还差非常关键的一层：

- 先把“注入点”翻译成容器能理解的依赖请求对象

这就是 `InjectionMetadata` 和 `DependencyDescriptor` 的位置。

### `InjectionMetadata`：它回答“这个 Bean 上有哪些注入动作要执行”

Spring 不会每次注入都重新从零扫描整个类结构，而是先把：

- 哪些字段要注
- 哪些方法要注
- 每个元素对应什么注入语义

整理成一份注入元数据。

这一步的价值不只是缓存性能，更重要的是：

- **把“类级扫描结果”抽成容器后续可反复执行的注入计划。**

### `DependencyDescriptor`：它回答“当前这个注入点到底向容器提出了什么请求”

而当真正来到某一个字段或参数时，Spring 还不能只拿着一个 `Field` 就去找 Bean。

因为它真正需要知道的是：

- 这个注入点要什么类型
- 是否必需
- 有没有额外限定条件
- 有没有嵌套泛型信息
- 这个请求未来在候选解析里该怎样被理解

也就是说，`DependencyDescriptor` 做的不是“包装反射对象”，而是：

**把局部注入点提升成容器级依赖请求。**

所以它不是一个轻量适配层，而是后面候选查找和裁决链真正依赖的请求载体：

- required 决定找不到时是失败还是允许为空
- 泛型信息决定候选类型边界
- 限定信息决定后续是否还要继续过滤候选集

这一步非常关键，因为后面整个 `resolveDependency(...)` 主线，真正消费的不是“字段本身”，而是：

- 一个已经被抽象过的依赖请求描述

## 三、为什么 `@Autowired` 的核心语义是 byType，而不是 byName

只要依赖请求被建模出来之后，下一步最自然的问题就是：

- Spring 到底怎么找候选？

`@Autowired` 在这里最核心的立场非常明确：

- **先按类型找。**

这不是一个小实现细节，而是 Spring IoC 哲学的一部分。

因为从容器视角看：

- 类型比名字更接近“我要什么能力”
- 名字更像局部约定或消歧信号

也就是说，`@Autowired private UserService userService;` 真正表达的第一层意思不是：

- 我要一个叫 `userService` 的 Bean

而是：

- 我要一个 `UserService` 类型的依赖

只有当类型匹配得出多个候选，名字才会上升为第二层裁决信号。

这里还要再把层级说清：字段名不是从一开始就在和类型并列竞争，而是在 byType 已经把候选集收出来之后，才作为后续消歧信号上升。也就是说：

- 类型先决定“候选池是谁”
- 名字再决定“这个候选池里谁更像当前注入点真正想要的那个”

这说明 Spring 在 `@Autowired` 这条线上真正坚持的是：

**依赖注入先基于类型契约，而不是基于名字约定。**

这也正是它和 `@Resource` 分道扬镳的根本地方。

## 四、多个候选怎么被压成一个：`@Primary`、字段名、`@Qualifier`、`@Priority` 不是平行选项，而是一条裁决链

只要一进入真实项目，就不可能永远只有唯一候选。

比如：

- 一个接口多个实现
- 一个类型既有默认实现又有特殊实现
- 不同模块各自注册了同类 Bean

这时 Spring 真正要回答的问题就不再是：

- 有没有候选

而变成：

- **多个候选同时存在时，谁最后赢。**

这就是 `DefaultListableBeanFactory.resolveDependency(...)` 背后最值得看的地方。

因为它组织的不是一堆平行规则，而是一条逐层收缩候选的裁决链。

### 1. `@Primary`：全局默认优先者

它表达的不是“这个注入点必须选我”，而是：

- 如果大家都只是按类型来要，默认先偏向我

所以它是容器级默认偏好，而不是局部强制指定。

### 2. 字段名 / 参数名匹配：局部名字意图信号

这一步比很多人想象得重要。

因为当调用方已经把字段命名成某个更具体的 Bean 名时，Spring 会把它理解成：

- 这不是纯类型需求了
- 名字里也在表达局部意图

也就是说，名字在 `@Autowired` 世界里并不是主语，但它在多候选阶段会成为一个很强的 tie-breaker。

### 3. `@Qualifier`：局部覆盖默认选择

`@Qualifier` 最重要的地方不是“多一个注解”，而是它明确告诉容器：

- 在这个注入点上，我要进一步收紧候选集

也就是说：

- `@Primary` 是全局默认
- `@Qualifier` 是局部覆盖

这两者不是互斥替代关系，而是不同层级的选择语义。

### 4. `@Priority`：再往后的数值排序语义

只有前面都没定下来时，Spring 才会进一步看优先级排序语义。

这也说明依赖注入和前面 `Ordered` 那篇并不是完全平行的：

- 顺序语义可以参与依赖裁决
- 但它不是 `@Autowired` 世界里的第一原则

所以这条链真正重要的不是每一条规则单独是什么意思，而是：

**Spring 在把“多个候选怎么缩成一个”这件事组织成一条有先后层次的裁决协议。**

这里还要补一句特别容易被误解的边界：`@Qualifier` 在真实流程里，很多时候会更早进入候选过滤，而不只是“最后再挑一下”。

也就是说，对某些依赖请求来说：

- 候选集合在进入最终裁决链之前，就已经因为 `@Qualifier` 被大幅收紧了
- 后面的 `@Primary`、名字匹配、`@Priority` 等步骤看到的，往往已经不是最初那个完整候选集

所以本篇把它写成一条“裁决链”是为了帮助读者建立层次感，但真实实现里，限定符语义经常比最终决策更早开始发挥作用。

## 五、`@Resource`：它不是 `@Autowired` 的另一种写法，而是“按名优先”的另一套注入哲学

只要把 `@Autowired` 的 byType 立场看清楚之后，再看 `@Resource`，它的差异就会变得非常明显。

很多人第一次看 `@Resource` 时会觉得：

- 它不就是另一个注入注解吗

这个理解太浅了。

因为 `@Resource` 真正重要的地方不是“注解不同”，而是：

- **它先按名字找。**

也就是说，当你写：

- `@Resource private UserService userService;`

它首先表达的不是“我要一个 `UserService` 类型”，而更接近：

- 我想引用名为 `userService` 的资源

只有在这个名字路径找不到时，Spring 才退回 byType。

这一步非常关键，因为它反映的不是实现顺序差异，而是两种不同的注入哲学：

- `@Autowired`：IoC 容器视角，类型优先
- `@Resource`：资源引用视角，名字优先

这也解释了为什么 `@Resource` 的处理入口不在 `AutowiredAnnotationBeanPostProcessor`，而在 `CommonAnnotationBeanPostProcessor`。

因为它不只是“另一个注解”，而是另一套历史来源和设计语义。

同时，`@Resource` 之所以还能在名字找不到时退回 byType，也不是 JSR-250 天然就规定了完整的 Spring 式容器候选解析链，而是 Spring 在兼容这套资源引用语义时，主动把它重新接回了 IoC 容器世界。也就是说：

- `@Resource` 的起点仍然是按名
- 但它最终能在 Spring 容器里继续工作，是因为 Spring 替它补上了向 byType 退回的适配桥

## 六、为什么 `@Qualifier` 不等于 `@Primary`，也不等于 byName

只要讲到这里，最容易被混淆的一个点就是：

- `@Qualifier` 不就是指定名字吗
- 那和 `@Primary`、字段名匹配、`@Resource` 到底差在哪

这里必须拆开看。

### `@Primary` 解决的是：默认候选谁更优先

也就是说，它面对的是：

- 大多数按类型注入时，默认让谁赢

### 字段名匹配解决的是：调用方名字里已经隐含了局部意图

它面对的是：

- 当前这个字段名是否已经比纯类型更具体

### `@Resource` 解决的是：整套注入协议本来就以名字为主

它面对的是：

- 名字是不是第一主语

### `@Qualifier` 解决的是：在 byType 主线内部，对当前注入点显式加限定条件

它面对的是：

- 我仍然接受 byType 这套主线
- 但这个注入点还要再加一道局部过滤

所以它的真正意义不是“名字版注入”，而是：

**在 byType 注入协议里追加一层局部限定。**

也正因为如此，它既不等价于 `@Primary`，也不等价于 `@Resource`。

## 七、为什么这条依赖注入主线必须放在循环依赖之后、BPP 全景之前

看到这里，最值得回收的一个问题就是：

- 为什么依赖注入这一篇必须放在当前这个位置？

答案恰恰说明它不是一个独立注解技巧专题，而是 Bean 生命周期主线里承上启下的一层。

前一篇刚刚讲过：

- 对象可以在哪个阶段被提前暴露
- 三级缓存和早期引用如何成立

但那一篇主要解决的是：

- 引用能不能先出现

到了这一篇，问题才真正变成：

- 这个引用到底该指向哪个 Bean

也就是说：

- 循环依赖篇主要解决“有没有可注入引用”
- 当前这篇解决“该注哪个候选对象”

这两者前后相接，刚好拼成 `populateBean` 阶段最核心的两半。

而它又必须放在 `BeanPostProcessor` 全景之前，是因为：

- `@Autowired`、`@Resource` 本身就是通过 BPP 体系切进生命周期链的

也就是说，如果不先把依赖注入协议讲透，后面看 BPP 全景时就会只看到很多处理器名字，而看不到它们各自在兑现什么容器契约。

## 八、几个最容易错的判断

### 1. `@Autowired`、`@Resource`、`@Qualifier` 本质上都一样，只是写法不同

不成立。

它们分别对应按类型、按名字和局部限定三种不同的依赖裁决协议。

### 2. `@Autowired` 就是按类型找一个 Bean 塞进去

不完整。

它真正组织的是“按类型找候选，再按 `@Primary`、名字、`@Qualifier`、`@Priority` 逐层收缩”的裁决链。

### 3. `@Resource` 只是比 `@Autowired` 更老一点

不成立。

它代表的是一套按名字优先的资源引用哲学，不只是年代不同。

### 4. `@Qualifier` 等于指定 Bean 名，所以和 `@Resource` 没本质区别

不成立。

`@Qualifier` 是在 byType 主线内部追加局部限定，而 `@Resource` 从一开始就是按名字优先的注入协议。

### 5. 注入是字段自己完成的，容器只是顺手赋值

不成立。

注入点扫描、依赖请求建模、候选查找和最终赋值，全部都是容器在生命周期链里显式执行的动作。

## 收网：Spring 要统一的从来不是“怎么给字段 set 一个对象”，而是“依赖请求如何被容器裁决成唯一候选”

现在可以回到开头那个问题：为什么看起来都像“自动注入”的几种写法，最后 Spring 却要做出整套依赖注入协议？

因为对 Spring 这种 IoC 容器来说，它真正要面对的不是“字段上怎么塞个对象”，而是：

- 注入点如何先被扫描出来
- 依赖请求如何被抽象成容器可理解的描述对象
- 多个候选如何按统一规则被裁决
- 按类型、按名字、局部限定这几种注入哲学如何在同一容器里共存

所以 Spring 的答案不是继续在各处散落反射赋值，而是建立一条统一注入主线：

```text
AutowiredAnnotationBeanPostProcessor / CommonAnnotationBeanPostProcessor
   -> 注入点扫描
DependencyDescriptor
   -> 依赖请求建模
DefaultListableBeanFactory.resolveDependency(...)
   -> 候选查找与裁决
@Primary / beanName / @Qualifier / @Priority
   -> 多候选收缩
field.set / method invoke
   -> 最终注入
```

因此，这篇真正该带走的结论不是“Spring 支持 `@Autowired` 和 `@Resource`”，而是：

**Spring 把依赖注入问题从“字段怎么拿到对象”提升成了“容器如何扫描注入点、建模依赖请求、裁决候选并完成最终赋值”的 IoC 核心协议。**

这也留下了下一篇最自然的问题：既然依赖注入、生命周期、循环依赖这些行为都反复通过后处理器切进来，那 Spring 里这些“魔法注解”背后真正统一的那层体系——`BeanPostProcessor`——到底长什么样？

也就是说，接下来最自然的继续点就是：

- `InstantiationAwareBeanPostProcessor`
- `SmartInstantiationAwareBeanPostProcessor`
- `DestructionAwareBeanPostProcessor`
- `CommonAnnotationBeanPostProcessor`
- `AutowiredAnnotationBeanPostProcessor`
- `AbstractAutoProxyCreator`

下一篇进入 Spring 的 `BeanPostProcessor` 体系全景。