# 为什么国际化消息不是“读个 properties 文件”就完了：Spring 的 `MessageSource`、父级回退与模板化解析主线

> 本文基于 Spring Framework 6.x 当前源码。本文只讲 Spring 国际化消息主线的第一层：为什么容器不会把国际化消息理解成“根据 key 去某个资源文件里查字符串”的简单工具能力，而必须引入 `MessageSource`、`AbstractMessageSource`、`HierarchicalMessageSource`、`DelegatingMessageSource`、`ResourceBundleMessageSource` 这一整条模板化解析与父级回退主线。`ReloadableResourceBundleMessageSource`、Boot 的 `spring.messages.*` 自动配置和更细的缓存策略，会在后续篇章继续展开。

## 为什么看起来只是“按 key 查一条文案”，最后会牵出一整条回退和格式化主线

前面这卷已经把很多容器主线拆开过：

- `Environment` 解释配置值从哪里来
- `refresh()` 里 Step 7 会初始化 MessageSource
- 父子容器会在多个子系统里沿同一方向建立 parent 关系
- 事件体系又在容器启动完成后形成广播总线

只要走到这里，一个更接近日常业务但又特别容易被低估的问题就会出现：

- `messageSource.getMessage("user.notfound", args, locale)` 到底只是“查个文本”，还是容器级基础设施的一部分？

如果只从最表层看，国际化消息似乎很简单：

- 一个 key
- 一个 locale
- 找到对应消息字符串
- 有参数时格式化一下

这看起来几乎像任何 i18n 库都能做的事情。

但只要把视角切到 Spring 容器，问题就立刻不再只是“查文件”：

- 没找到本地消息时，是否要回退到父上下文
- 有默认消息时，是直接返回，还是继续抛异常
- 有参数和没参数，是否应该走同一条昂贵的 MessageFormat 路径
- 多个 basename 的消息源，究竟是合并、覆盖还是按序查找

也就是说，Spring 真正要解决的不是“读取资源文件”，而是：

**容器里的消息世界如何按统一协议解析、格式化、回退并最终决定失败语义。**

第一层问题是：**消息查找在 Spring 里首先是一个容器协议，而不是一个资源文件访问动作。**

这点特别关键。

因为对调用方来说，它面对的从来不是：

- 某个 `messages_zh_CN.properties` 文件

而是：

- 一个 `MessageSource`

也就是说，Spring 一上来就先把“消息从哪里来”这个问题抽象掉，留下的只是：

- 根据 key、参数和 locale 取结果

这和前面很多篇的写法非常一致：

- `ResourceLoader` 先统一资源读取入口
- `ConversionService` 先统一值转换入口
- `ApplicationEventMulticaster` 先统一广播入口
- 而在这里，`MessageSource` 先统一的，则是国际化消息查询入口

第二层问题是：**消息解析不是总能一步到位，它天然带着回退链。**

比如：

- 当前消息源没这个 key
- 当前上下文的本地消息表没命中
- 但父上下文可能有
- 还可能有默认消息
- 最终实在都没有，才抛 `NoSuchMessageException`

这说明消息查找在 Spring 里不是一次局部查询，而是：

- **一条逐层兜底的责任链。**

第三层问题是：**无参消息和带参数消息，本来就不该总走同一种路径。**

这一点如果不打开，很容易把 `MessageSource` 理解成：

- 每次都把文本塞进 `MessageFormat`
- 然后格式化返回

但 Spring 显然不满足于这种粗糙模型。

因为对容器来说：

- 没参数的纯文本查找，本来就应该更轻
- 有参数的消息才需要进入 `MessageFormat` 世界

也就是说，Spring 真正要组织的不是“查到文本就返回”，而是：

- **消息解析路径本身也要按输入复杂度分流。**

因此，本文真正要回答的问题不是“Spring 怎样做国际化”，而是：

**为什么对 Spring 来说，一个看似简单的 `getMessage(...)`，最后必须被提升成“统一消息协议 + 模板化解析骨架 + 父级回退链 + 资源文件适配”的容器基础设施主线？**

## 先看失败方案：为什么不能“直接查 ResourceBundle”“没找到就返回 null”“所有消息都统一 MessageFormat”

理解 Spring 的消息主线，最好的方式不是先背几个类名，而是先看几种特别自然、但一放到容器世界里就会迅速失效的朴素方案。

### 失败方案一：直接用 `ResourceBundle.getString(key)` 就够了

这是最符合很多人 i18n 直觉的方案。

因为从 JDK 世界看，国际化消息最直接的路径确实就是：

- 先拿 `ResourceBundle`
- 再 `getString(code)`

如果应用永远只有一个消息文件来源、没有父子上下文、也没有默认消息和统一异常语义，这样做当然几乎足够。

但对 Spring 容器来说，它会立刻撞上几个问题：

- 本地没找到时，父上下文怎么办
- 有默认消息时，是返回默认值还是继续抛错
- 调用方是想要“找不到就 null”、还是“找不到就异常”
- basename 可能不止一个时，查找顺序怎么统一

也就是说，`ResourceBundle` 能解决的是“单一资源文件查找”，而 Spring 真正要解决的是：

- **容器级消息解析协议。**

### 失败方案二：没找到消息就直接返回 null，调用方自己处理

如果意识到单个 `ResourceBundle` 不够，第二种自然思路就会变成：

- 好，那框架只负责查
- 找不到就返回 null
- 调用方自己决定要不要 fallback 或抛错

这个方案的问题在于，它会把消息查找的语义彻底打散。

因为不同调用方最终就会各自处理：

- 有的返回默认值
- 有的抛自己的异常
- 有的继续去别的消息源找
- 有的干脆静默吞掉

这就意味着，Spring 会失去一件特别重要的能力：

- **在容器层统一定义消息查找失败的语义边界。**

也就是说，Spring 真正要避免的不是“返回 null 不优雅”，而是：

- 调用方各自定义消息失败语义，最后让整个容器消息世界失去一致性

### 失败方案三：所有消息不管有没有参数，都统一走 `MessageFormat`

还有一种特别容易被忽略但实际上成本很高的方案：

- 反正最终都返回字符串
- 那就所有消息统一交给 `MessageFormat` 去处理

这个思路在语义上当然可行，但对 Spring 这种高频容器基础设施来说太粗了。

因为它忽略了一个非常现实的事实：

- 很多消息根本没有参数

如果每次无参消息都要：

- 先构造或查找 `MessageFormat`
- 再做一次格式化路径

那本来可以走的轻量纯文本分支，就会被不必要地拖重。

这说明 Spring 真正要组织的不是“统一格式化”，而是：

- **先区分消息语义复杂度，再决定是否进入格式化世界。**

## Spring MessageSource 体系的最小总图

如果把这条主线先压缩成最小模型，它可以写成下面这样：

```text
getMessage(code, args, locale)
   -> abstract message source template
   -> no-arg fast path or message-format path
   -> local source lookup
   -> common messages fallback
   -> parent message source fallback
   -> default message or exception
```

如果再换一种更容易理解的拆法，这条链可以分成四段职责：

```text
[统一入口]
MessageSource

   ->

[模板骨架]
AbstractMessageSource

   ->

[父级回退]
HierarchicalMessageSource / DelegatingMessageSource

   ->

[资源文件适配]
ResourceBundleMessageSource
```

这张图最重要的价值，不是让读者记住几个消息源实现类，而是先把四个问题分开：

### 一、统一入口

回答：为什么 Spring 调用方面对的是 `MessageSource` 协议，而不是某个具体资源文件 API？

### 二、模板骨架

回答：为什么无参消息、有参消息、默认消息、异常语义必须被统一收进父类骨架，而不能由每个子类自己随意定义？

### 三、父级回退

回答：为什么消息系统也和 BeanFactory、Environment 一样，必须沿 parent 建立单向回退链？

### 四、资源文件适配

回答：为什么 `ResourceBundle` 在 Spring 里只能作为底层资源适配层，而不是整个消息系统本体？

只要先把这四层职责分开，Spring 的国际化消息体系就不再像“读几个 properties 文件”。

## 一、`MessageSource`：Spring 先统一“消息怎么问”，再统一“消息从哪里答”

如果先从调用方视角看，Spring 的第一层抽象其实很克制。

它没有要求业务代码先知道：

- 当前用的是哪个 basename
- 当前底层是不是 `ResourceBundle`
- 当前是否还有 parent 回退链

相反，它先把问题统一成：

- `getMessage(code, args, locale)`
- `getMessage(code, args, defaultMessage, locale)`

这一步和前面很多篇的设计取向完全一致：

- 先统一调用协议
- 再把后面的复杂性收回基础设施内部

也就是说，Spring 在这里首先统一的不是“消息存在哪”，而是：

- **消息该如何被提问。**

这一步特别重要，因为它决定了后续：

- fallback
- 默认值
- 异常
- 格式化

这些复杂语义，都有了统一入口可以接住。

所以 `MessageSource` 在这里真正扮演的，不是 i18n 工具类，而是：

- **容器消息系统的最小协议。**

## 二、`AbstractMessageSource`：Spring 真正要统一的不是资源读取，而是消息解析语义的模板骨架

只要统一入口立住之后，最关键的主线就会落到 `AbstractMessageSource` 上。

这一步特别值得强调，因为它最容易被讲浅成：

- 一个父类帮子类少写点代码

这个理解太轻了。

更准确地说，`AbstractMessageSource` 真正统一的不是“少写代码”，而是：

- **消息解析主线的固定骨架。**

也就是说，它在父类层先把这些问题的顺序固定下来：

- locale 怎么兜底
- 有没有参数
- 无参时能否走快路径
- 有参时是否进入 `MessageFormat`
- 本地没找到时要不要查 commonMessages
- 再查不到是否向 parent 回退
- 彻底没命中后是返回默认消息还是抛异常

这说明 Spring 真正面对的不是“资源怎么读”，而是：

- **消息查找、格式化、回退和失败语义怎样形成一条一致的解析管线。**

所以 `AbstractMessageSource` 不是一个便利父类，而是：

- MessageSource 世界的模板方法骨架

## 三、为什么无参消息和带参消息必须分流：Spring 统一的不是“字符串返回”，而是“消息解析路径”

只要进入 `getMessageInternal(...)`，一个特别能体现 Spring 容器味道的点就会出现：

- 无参消息
- 有参消息

并不总走同一条路径。

这一步很重要，因为它说明 Spring 在这里关心的并不是：

- 最后都返回字符串，不如统一走一套

而是：

- **不同输入复杂度，应该走不同成本的解析路径。**

也就是说：

- 无参消息如果子类支持，可以直接返回纯文本
- 有参消息才真正进入 `MessageFormat` 语义世界

这不是小优化，而是：

- Spring 在消息主线里主动把“简单消息”和“格式化消息”拆成了两条层级不同的解析支路

这和前面 `ConversionService`、条件装配、配置类处理里的思路是一样的：

- 统一协议成立
- 但具体路径必须按语义复杂度再分流

所以这里真正被统一的不是“最后都给个 String”，而是：

- **不同消息输入在同一模板骨架里如何走不同解析支路。**

## 四、为什么父级回退不是附属能力，而是 MessageSource 世界里的第二条责任链

只要走到本地查找失败，Spring 消息体系里最关键的一条边界就会出现：

- parent fallback

这一步特别值得单独拎出来，因为它正好和前面 BeanFactory、Environment、父子容器那几篇形成强呼应。

也就是说，MessageSource 在 Spring 里并不是孤立系统。它同样要服从父子上下文那条大原则：

- 当前层先查
- 没命中再向上回退
- 方向只能单向向上

这说明 `HierarchicalMessageSource` 的意义绝不只是“支持 parent”。更准确地说，它是在把 MessageSource 世界重新接回：

- **父子上下文的统一单向可见性模型。**

所以本地消息没找到时向 parent 回退，并不是顺手行为，而是：

- MessageSource 这一子系统对 parent / child 协议的继承

也正因为如此，上一篇父子容器篇才必须先讲。否则这里的 parent fallback 会很容易被读成“又一个自己的回退规则”，而不是同一条上下文方向约束的延伸。

## 五、为什么 `getMessageFromParent(...)` 要区分 `AbstractMessageSource` 与普通 `MessageSource`

只要继续往 parent 回退链里看，又会碰到一个特别有 Spring 味道的实现细节：

- 如果 parent 本身也是 `AbstractMessageSource`
- Spring 会尽量直接走它的内部模板主线
- 而不是一上来就走最外层 public API

这一步如果讲浅了，很容易只说成：

- 哦，省一层方法调用

这显然不够。

更准确的说法应该是：

- Spring 在这里要守的，不只是调用成本，而是消息失败语义不要被 parent 的外层默认行为过早吞掉

也就是说，直接进 `getMessageInternal(...)` 这类内层路径，真正保护的是：

- 当前子消息源这条链还没走完前，不要让 parent 提前把“没找到”的情况过度包装成默认值或其他外层返回语义

所以这里的分流不是优化花活，而是：

- **责任链在跨父子消息源时的失败语义保护。**

这也再次说明 Spring 这里不是在简单查文件，而是在维护一条消息责任链的严谨边界。

## 六、`ResourceBundleMessageSource`：JDK 资源文件在 Spring 里只是底层消息存储适配层，不是整个消息系统本体

只要把模板骨架和 parent fallback 立住之后，再看 `ResourceBundleMessageSource`，位置就会非常清楚。

它最容易被误读成：

- Spring 国际化不就是对 `ResourceBundle` 做了一层封装吗

这个理解抓到了一部分事实，但仍然太浅。

因为 `ResourceBundleMessageSource` 在整条主线里的真正位置不是“消息系统本体”，而是：

- **把 JDK ResourceBundle 适配进 Spring MessageSource 骨架的底层资源实现。**

也就是说，它主要解决的是：

- basename 如何按序查找
- locale 对应的 bundle 如何获取
- message string / message format 如何从底层资源里取出来

但它并不负责整个消息协议的全部语义。像：

- 默认消息
- `NoSuchMessageException`
- parent fallback
- `commonMessages`

这些更高层语义，前面都已经先被 `AbstractMessageSource` 骨架接住了。

这说明 Spring 在这里依旧保持着很稳定的分层：

- 上层统一协议和回退语义
- 下层只是具体资源文件适配

所以 `ResourceBundleMessageSource` 的意义不在于“最常用实现”，而在于：

- 它让 ResourceBundle 进入 Spring 消息系统，但不会反过来定义整个消息系统

## 七、为什么多个 basename 不是“合并消息表”，而是“按序查找链”

只要进入 `ResourceBundleMessageSource`，另一个特别容易被讲错的点就是：

- 多个 basename 到底是什么语义？

很多人会下意识以为：

- `messages` 和 `errors` 都配上以后
- Spring 大概把它们合并成一个大消息表

这个理解不精确。

更准确地说，Spring 在这里做的是：

- **按顺序查找，而不是按结构合并。**

也就是说：

- 先查前面的 basename
- 找到就停
- 后面的 basename 只在前面没命中时才兜底

这一步很像前面 `Environment` 那篇里 `PropertySource` 的责任链语义。

也就是说，Spring 在消息世界里并没有突然换一套哲学，而仍然坚持：

- 多来源并存时，优先级顺序比“全量合并”更基础

所以 basename 列表在这里不是“资源集合”，而是：

- **消息查找顺序链。**

## 八、为什么这篇必须放在事件机制之后，而不是直接并进父子容器或 Environment

看到这里，最值得回收的一个问题就是：

- MessageSource 为什么要单独成篇，而不是和 Environment 或父子容器顺手一起讲掉？

因为它既和前面那些主线有关，又有自己独立的一条模板解析与回退链。

和 Environment 的关系在于：

- 两者都在处理“值从哪里来”的问题
- 但 Environment 统一的是配置来源与占位符
- MessageSource 统一的是消息解析、格式化与国际化回退

和父子容器的关系在于：

- 它同样服从 parent / child 单向回退模型
- 但它又不是 Bean 查找链，而是消息查找链

而放在事件机制之后，也刚好能帮助读者意识到：

- `refresh()` 里 Step 7 / 8 / 10 这些看起来像“外围基础设施”的部分，其实都不是附属功能
- MessageSource 和 EventMulticaster 一样，都在容器正式完成前先就位，供后续系统统一依赖

所以这篇站的位置，不是“国际化知识补丁”，而是：

- **容器基础设施层里的另一条统一协议主线。**

## 九、几个最容易错的判断

### 1. Spring 国际化本质上就是对 `ResourceBundle` 的简单封装

不成立。

ResourceBundle 只是底层资源适配层，消息解析、格式化、默认消息、异常和父级回退都由 Spring 自己的消息骨架统一组织。

### 2. 无参消息和带参消息走同一条解析路径就行

不成立。

Spring 明确把无参快速路径和 `MessageFormat` 路径分开，消息解析成本本身也是被建模的。

### 3. 没找到消息直接返回 null 让调用方自己处理更灵活

不成立。

这会把默认消息、异常和 parent fallback 语义全部打散，破坏容器级一致性。

### 4. MessageSource 的 parent fallback 只是它自己的局部机制

不成立。

它本质上是父子上下文单向回退模型在消息子系统里的延伸。

### 5. 多个 basename 会被 Spring 合并成一个消息表

不成立。

它们是按序查找链，不是结构合并。

## 收网：Spring 要统一的从来不是“怎么读一条国际化消息”，而是“消息、格式化、回退和失败语义如何被组织成一条容器主线”

现在可以回到开头那个问题：为什么看起来只是 `getMessage(...)` 这样一个很普通的调用，Spring 却要为它准备 `MessageSource`、模板骨架、parent fallback 和 `ResourceBundle` 适配这么一整条主线？

因为对 Spring 这种容器框架来说，它真正要面对的不是“去文件里按 key 找字符串”，而是：

- 消息查询该通过什么统一协议被提问
- 不同复杂度消息该走什么解析路径
- 当前上下文没命中时怎样沿 parent 世界继续回退
- 默认消息和异常语义如何统一
- JDK 的 ResourceBundle 怎样被适配进这个体系而不是反过来支配它

所以 Spring 的答案不是提供一个 i18n 工具类，而是建立一条完整消息主线：

```text
MessageSource
   -> AbstractMessageSource 模板骨架
   -> HierarchicalMessageSource 父级回退链
   -> ResourceBundleMessageSource 底层资源适配
```

因此，这篇真正该带走的结论不是“Spring 支持国际化消息”，而是：

**Spring 把国际化消息问题从“查一个资源文件”提升成了“消息、格式化、父级回退与失败语义如何被统一组织成容器基础设施协议”的系统。**

这也留下了下一篇最自然的问题：既然 MessageSource 和 ApplicationEventMulticaster 都已经立住了，那回到前面配置类世界之后，那个真正决定“有些 Bean 为什么最终不在容器里出现”的另一个核心条件入口——`@Conditional` 之外更贴近真实运行环境的 `@Lazy`、`@Primary`、`@DependsOn`，又是怎样在定义世界里继续影响后续实例主线的？

也就是说，接下来最自然的继续点就是：

- `@Lazy`
- `@Primary`
- `@DependsOn`
- 它们为什么不是几个小注解，而是定义世界里继续影响实例世界的控制信号

下一篇进入 Spring 的 `@Lazy` / `@Primary` / `@DependsOn` 主线。