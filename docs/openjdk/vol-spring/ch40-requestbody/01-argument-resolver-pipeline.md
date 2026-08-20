# 为什么 `@PathVariable`、`@RequestParam`、`@RequestBody` 不是一套解析器：Spring MVC 参数解析链的三种机制

> 本文基于 Spring Framework 6.x 当前源码。本文只讲 Spring MVC 参数解析主线：`HandlerMethodArgumentResolver` 接口如何统一“这个参数归谁管”的判断，为什么 `@PathVariable` / `@RequestParam` 要走 `AbstractNamedValueMethodArgumentResolver` 这条命名值模板链，而 `@RequestBody` 必须单独走 `HttpMessageConverter` 请求体反序列化链。消息转换器本身的 `canRead` / `canWrite` 与 Jackson 集成，会在下一篇继续展开。

## 为什么同样是 Controller 参数，`@PathVariable`、`@RequestParam`、`@RequestBody` 却不能用同一种解析方式

上一篇已经把 `RequestMappingHandlerMapping` 和 `RequestMappingHandlerAdapter` 的双链主线立住了。

我们已经知道：

- `HandlerMapping` 负责找到 `HandlerMethod`
- `HandlerAdapter` 负责把它推进成真正的 MVC 调用链
- `ServletInvocableHandlerMethod` 会在执行前挂好参数解析器、返回值处理器、BinderFactory 和校验器

走到这里，一个更具体的问题就自然出现了：

- 参数到底是怎么解析出来的？

因为从 Controller 方法签名看，下面这些写法都只是“方法参数”：

- `@PathVariable Long id`
- `@RequestParam(defaultValue = "0") int page`
- `@RequestBody UserDto dto`

但它们背后面对的原始数据来源完全不同：

- URL 模板变量
- query/form 参数
- 整个 request body

也就是说，Spring MVC 面对的不是“参数怎么统一取值”，而是：

**不同来源的参数，如何在同一条方法调用前被分发给不同解析策略。**

第一层问题是：**`HandlerMethodArgumentResolver` 统一的是分派协议，不是解析方式本身。**

它只要求两个问题：

- `supportsParameter`：这个参数归不归我管？
- `resolveArgument`：归我管时，我怎么把它解析出来？

也就是说，Spring 并不强行要求所有参数走同一种模板，而是先用统一接口完成“参数归属判定”，再把不同来源交给不同解析器。

第二层问题是：**命名值参数和请求体参数在模型上根本就不是一回事。**

对于 `@PathVariable`、`@RequestParam`，Spring 面对的是：

- 先确定参数名
- 再按名字去某个来源里找原始值
- 之后再做 defaultValue / required / 类型转换

而对于 `@RequestBody`，Spring 面对的却是：

- 不是按名字找一个值
- 而是把整个 body 根据 Content-Type 反序列化成一个对象

这说明二者在抽象层面就完全不同。

第三层问题是：**参数解析器链不是“找一个就调”，而是先尽量复用模板，再在必要时走独立策略链。**

这里也要先把范围边界说清：Spring MVC 里真正的参数解析器远不止这三类，默认 `RequestMappingHandlerAdapter` 会装配一整套二十多个 resolver。本文只聚焦最常用、也最能代表两种核心模型的三类：

- `@PathVariable`
- `@RequestParam`
- `@RequestBody`

也就是说，本篇是在解释参数解析世界的主干分流模型，而不是一次性覆盖全部 resolver 生态。

这也是为什么：

- `@PathVariable` 和 `@RequestParam` 可以共享 `AbstractNamedValueMethodArgumentResolver`
- `@RequestBody` 却必须走 `AbstractMessageConverterMethodArgumentResolver`

因此，本文真正要回答的问题不是“Spring MVC 怎么解析参数”，而是：

**为什么对 Spring 来说，Controller 参数必须先通过 `HandlerMethodArgumentResolver` 接口完成分派，再由“命名值模板链”与“消息体转换链”这两种完全不同的机制分别处理？**

## 先看失败方案：为什么不能统一按名字取值、统一用一个大解析器、把 body 当作一个特殊参数名处理

### 失败方案一：所有参数都按名字取值

这对 `@RequestParam` 和 `@PathVariable` 看起来没什么问题，但到了 `@RequestBody` 就彻底失效：

- body 不是“按名字拿一个值”
- 它是“把整个请求体变成对象”

所以统一按名字会让 `@RequestBody` 的数据模型彻底走样。

### 失败方案二：一个大解析器 if/else 处理所有注解

如果把 `@PathVariable`、`@RequestParam`、`@RequestBody`、`@CookieValue`、`@RequestHeader`、`@ModelAttribute` 全部写进一个大解析器，那么：

- 新增一种参数类型就要改核心代码
- 命名值逻辑和消息体逻辑会互相污染
- 很难重用共性的 defaultValue / required / conversion 流程

所以 Spring 用的是“统一接口 + 多个 resolver 策略”。

### 失败方案三：`@RequestBody` 只不过是一个名字特殊的参数

这也是很容易踩的误解。

因为请求体不是“某个值”，而是：

- 整个字节流
- 还要结合 Content-Type、目标类型、消息转换器链、校验器来决定怎么读

所以它天然不可能落进 `AbstractNamedValueMethodArgumentResolver` 的命名值模型里。

## Spring MVC 参数解析的最小总图

如果把这条主线先压缩成最小模型，它可以写成下面这样：

```text
HandlerMethod parameter
   -> HandlerMethodArgumentResolverComposite
   -> supportsParameter?
   -> matching resolver
      -> named value template path (@PathVariable / @RequestParam)
      -> message converter path (@RequestBody)
   -> WebDataBinder convert/validate
   -> argument array for method invocation
```

可以再拆成四段职责：

```text
[统一分派协议]
HandlerMethodArgumentResolver

   ->

[命名值模板链]
AbstractNamedValueMethodArgumentResolver

   ->

[具体命名值实现]
PathVariableMethodArgumentResolver / RequestParamMethodArgumentResolver

   ->

[消息体解析链]
RequestResponseBodyMethodProcessor -> HttpMessageConverter
```

## 一、`HandlerMethodArgumentResolver`：Spring 先统一“参数归谁管”，再统一“参数从哪来”

这个接口是整条参数解析主线的门面。

它并不规定具体怎么解析，而只统一两件事：

- `supportsParameter(parameter)`：你能不能处理这个参数
- `resolveArgument(parameter, mavContainer, webRequest, binderFactory)`：能的话怎么处理

这一步特别像前面很多篇的写法：

- `HandlerAdapter` 统一“这个 handler 归谁执行”
- `MessageSource` 统一“消息怎么问”
- `TaskExecutor` 统一“任务怎么提交”
- 而这里，`HandlerMethodArgumentResolver` 统一的是“参数归谁解析”

也就是说，它首先组织的是一条**参数归属判定协议**，而不是：

- 参数值如何存储
- Controller 最终如何调用
- 某个具体注解内部怎么取值

这些后续问题，都要在“先由谁接手这个参数”成立之后才继续展开。

## 二、`AbstractNamedValueMethodArgumentResolver`：`@PathVariable` 和 `@RequestParam` 的共用模板

只要参数来源还是“按名字从某个源里拿值”，Spring 就可以把共性收进一个模板父类。

这条模板链大致是：

1. 读取注解元数据，得到 `NamedValueInfo`（name / required / defaultValue）
2. 解析嵌入值和表达式
3. 调用子类 `resolveName(...)` 去取原始值
4. 如果没取到，走 defaultValue / required / missingValue 分支
5. 调 `WebDataBinder` 做 `convertIfNecessary`
6. 返回最终参数值

这说明 Spring 真正统一的不是“参数从哪来”，而是：

- **按名字拿值之后的后半段处理骨架**

这里最容易被低估的不是“能按名字取值”，而是“取不到值时怎么办”。这条模板链真正统一了三种后续边界：

- 有 defaultValue → 用默认值继续
- required=true 且无值 → 抛缺值异常
- 允许 null / Optional → 把 null 继续交给后面的类型转换与空值处理

也就是说，`AbstractNamedValueMethodArgumentResolver` 的价值不只是少写几行取值代码，而是在把“缺值如何处理”的规则也固定成容器协议。

也正因为如此，`@PathVariable` 和 `@RequestParam` 虽然来源不同，却能复用同一套后半段流程。

## 三、`@PathVariable`：值不是临时从 URL 字符串现切，而是 HandlerMapping 早就写进 request attribute 里的

这是 `@PathVariable` 最容易被讲错的一点。

很多人会本能觉得：

- 参数解析器直接解析当前 URL，把 `{id}` 切出来

这个理解太浅。

更准确的说法应该是：

- URL 模板匹配在上一层 `HandlerMapping` 阶段就已经完成
- 解析出的 URI template variables 已经被写进 `request` 的 attribute 里
- `PathVariableMethodArgumentResolver` 只是把这份结果按名字取出来

也就是说，这条链真正做的是：

- **HandlerMapping 负责写 attribute**
- **resolver 负责读 attribute**

所以 `@PathVariable` 不只是“从 URL 取值”，而是：

- `HandlerMapping` 和参数解析器分工后的二段式结果读取

## 四、`@RequestParam`：query/form 参数本质上是 Servlet 容器已经解析好的参数表

`@RequestParam` 的来源又不同。

它不看 URI template variables，而是：

- `request.getParameterValues(name)`
- 如果没有，再尝试 `name + "[]"` 这类兜底

也就是说，Spring 在这里并不直接解析原始 query string，而是站在 Servlet 容器已经整理好的参数表之上做二次取值、默认值和类型转换。换句话说：

- query string / form body 的参数拆分，主要已经由 Servlet 容器完成
- Spring 这里负责的是“拿到这些参数之后，如何绑定、补默认值并转换成目标类型”

所以：

- `@PathVariable` 更像读取上游 HandlerMapping 写下来的 attribute
- `@RequestParam` 更像读取 Servlet 请求参数表

两者共享模板，但来源不同。

## 五、`@RequestBody`：它不是“按名字取一个值”，而是“整个 body 进入消息转换器链”

`@RequestBody` 的模型与前两者完全不同。

这里 Spring 面对的不是：

- 给我一个名字
- 我去 request 里找这个 name 对应的值

而是：

- 给我目标类型
- 我拿整个 request body
- 再根据 Content-Type 找一个能读它的 `HttpMessageConverter`

这就是为什么 `@RequestBody` 不走 `AbstractNamedValueMethodArgumentResolver`，而是走：

- `RequestResponseBodyMethodProcessor`
- `AbstractMessageConverterMethodArgumentResolver`

这条链会：

1. 读取 Content-Type
2. 遍历 `messageConverters`
3. 询问谁 `canRead(targetType, contentType)`
4. 让第一个可读的 converter 真正去反序列化 body
5. 之后再通过 `WebDataBinder` 和 validator 做绑定与校验

所以 `@RequestBody` 真正统一的不是“参数名解析”，而是：

- **整个请求体如何被策略化地反序列化成目标对象。**

这也带来一条和命名值完全不同的失败边界：如果 body 缺失而 `required=true`，或者某个 converter 读 body 失败，抛出的不是命名值缺失异常，而是 `HttpMessageNotReadableException` 这一类消息转换异常。也就是说，body 解析失败属于“消息体读写世界”的错误，不属于“按名字取值失败”的错误。

## 六、为什么 `@RequestBody` 后面还要接 `WebDataBinder` 和校验器

很多人会以为：

- JSON 读成对象以后就完了

但 Spring 还要继续做两件事：

- 创建 Binder
- 校验（如 `@Valid` / `@Validated`）

这意味着 `@RequestBody` 链并不是纯消息转换，而是：

- **消息转换 + 数据绑定收口 + 校验主线**

也就是说，消息转换得到的对象还要继续进入 Spring MVC 自己的参数收口世界，而不是直接裸交给方法。

这也是为什么 `@Valid @RequestBody UserDto dto` 可以在反序列化后自动触发校验。换句话说，`@RequestBody` 解析出对象以后并没有立刻结束，而是还要继续经过 Binder / Validator 这道收口工序，最后才真正成为可交给 Controller 方法的参数。

## 七、为什么参数解析器链和 `HandlerAdapter` 必须分开：一个解决“谁执行”，一个解决“参数从哪来”

上一节已经提到：

- `HandlerAdapter` 决定这个 handler 怎么被调
- resolver 决定这个参数从哪来

这两者之所以必须分开，是因为它们面对的是两类完全不同的问题：

- **handler 类型适配**
- **参数来源适配**

如果把它们混在一起，`RequestMappingHandlerAdapter` 很快就会膨胀成一个包办：

- handler 匹配
- 参数解析
- 消息转换
- 返回值处理

的超大解析器。

Spring 选择的方式是：

- Adapter 统一入口
- Resolver 链分派参数来源
- Converter 链再分派 body 解析策略

这就是多层策略链的分治。

## 八、为什么这篇必须放在 `HandlerMapping / HandlerAdapter` 双链之后，而不是直接并进 `@RequestBody` 或 `@PathVariable` 小专题

看到这里，最值得回收的一个问题就是：

- 为什么不能直接分别讲 `@PathVariable`、`@RequestParam`、`@RequestBody` 就好？

因为如果不先把参数解析总链立住，后面每个小注解都会显得像是独立技巧。

但现在我们已经知道：

- 它们首先共享 `HandlerMethodArgumentResolver` 分派协议
- 命名值类共享模板方法骨架
- 请求体类共享消息转换器策略链
- 最后都要回到 `ServletInvocableHandlerMethod` 的参数数组世界

也就是说，这篇不是三个注解技巧文，而是：

- **Spring MVC 参数世界的分派与收口主线。**

换个角度看，上一篇 `HandlerMapping / HandlerAdapter` 讲的是“找到谁、由谁来调”；而这一篇真正回答的是：`ServletInvocableHandlerMethod` 身上那一整套 resolver 里，最常用的三类参数到底是怎样被分派和收口的。两篇拼起来，才构成一次完整的 Controller 调用前半段。

## 九、几个最容易错的判断

### 1. `@PathVariable` 是参数解析器直接从 URL 字符串切出来的

不成立。

真正的 URL 模板变量提取在 `HandlerMapping` 阶段完成，resolver 主要是从 request attribute 里读结果。

### 2. `@RequestParam` 和 `@PathVariable` 只是两个不同注解，内部机制完全不同

不完整。

它们来源不同，但在“名字解析 / defaultValue / required / 类型转换”这一段共享 `AbstractNamedValueMethodArgumentResolver` 模板骨架。

### 3. `@RequestBody` 只是命名值解析的一种特殊情况

不成立。

它面对的是整个 body 的反序列化，不是按名字取单值，所以必须走独立的消息转换器链。

### 4. `HandlerAdapter` 会自己手写所有参数解析逻辑

不成立。

Adapter 负责 handler 类型适配，参数来源解析交给 resolver 链。

### 5. 反序列化出对象后，Spring MVC 的参数链就结束了

不成立。

对象还要继续经过 Binder / Validator 的收口，才真正成为方法参数。

## 收网：Spring MVC 统一的不是“几个注解怎么取值”，而是“参数如何先分派给 resolver，再按来源走不同解析策略，最后收口成可调用参数数组”

现在可以回到开头的问题：为什么 `@PathVariable`、`@RequestParam`、`@RequestBody` 这些参数不能共用同一种解析方式？

因为对 Spring MVC 来说，它真正要面对的不是“参数都长在方法签名上”，而是：

- 有的值来自 HandlerMapping 早先写入的 URI 变量
- 有的值来自 Servlet 参数表
- 有的值来自整个请求体
- 它们虽然都要变成最终参数数组，但中途必须先经过不同的策略链

所以 Spring MVC 的参数主线可以压缩成：

```text
HandlerMethodArgumentResolverComposite
   -> supportsParameter 分派
   -> 命名值模板链（@PathVariable / @RequestParam）
   -> 消息体转换链（@RequestBody）
   -> WebDataBinder / Validator 收口
   -> argument array for method.invoke
```

因此，这篇真正该带走的结论不是“Spring MVC 有很多参数注解”，而是：

**Spring 把参数解析问题从“每个注解各写一点逻辑”提升成了“统一分派协议 + 命名值模板链 + 请求体转换链 + 最终绑定校验收口”的 MVC 参数解析主线。**

这也留下了下一篇最自然的问题：既然 `@RequestBody` 现在已经把 body 交给 `HttpMessageConverter` 处理了，那么这些 converter 自己到底是如何按 Content-Type 和目标类型 `canRead` / `canWrite`，再把 JSON / String / byte[] 分流给不同实现的？

下一篇进入 `HttpMessageConverter` 主线。