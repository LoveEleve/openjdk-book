# 为什么 `@RequestBody` 能读 JSON、`@ResponseBody` 又能写 JSON：`HttpMessageConverter` 的双向消息转换链

> 本文基于 Spring Framework 6.x 当前源码。本文只讲 Spring MVC 的消息转换主线：`HttpMessageConverter` 如何把“请求体 → Java 对象”和“Java 返回值 → HTTP 响应体”统一成一套双向协议，`AbstractHttpMessageConverter` 如何固定读写骨架，`readWithMessageConverters(...)` 与 `writeWithMessageConverters(...)` 为什么一条按 Content-Type 直接匹配、一条按 Accept 做内容协商，以及 `MappingJackson2HttpMessageConverter` 怎样把 Jackson 真正接进这套转换链。视图解析会在后续篇章继续展开。

## 为什么 `@RequestBody` 和 `@ResponseBody` 看起来都像“处理 JSON”，实际却是同一套转换器协议的两端

前一篇已经把 Spring MVC 参数解析主线立住了。

我们已经知道：

- `@PathVariable`、`@RequestParam` 走的是命名值模板链
- `@RequestBody` 走的是独立的消息体转换链
- 参数解析完成后，还要经过 Binder / Validator 收口

只要走到这里，一个很自然的问题就会继续冒出来：

- `@RequestBody` 读 JSON 是怎么挑到 Jackson 的？
- `@ResponseBody` 写 JSON 又是怎么决定 Content-Type 的？
- 为什么返回 `List<User>` 时，泛型信息没有丢？

如果只从表面看，`@RequestBody` 和 `@ResponseBody` 都像在做“JSON 序列化 / 反序列化”。

但这里也要先把范围边界说清：本篇讲的是 **HTTP body 与 Java 对象之间的双向消息转换协议**。它不是在重讲上一篇参数解析主线，也不是提前进入下一篇视图解析主线；它专门解释请求体 / 响应体这一支是怎样被 converter 链接管的。

Spring 真正组织的也不是一个 JSON 专用通道，而是：

- 一套统一的消息转换协议
- 不同转换器在这套协议下各自判断“我能不能读 / 写这个类型和媒体类型”

第一层问题是：**读链路和写链路虽然共用 `HttpMessageConverter`，但匹配方式天然不对称。**

这是整篇最关键的分界。

- 读请求体时，客户端已经通过 `Content-Type` 把媒体类型写死了
- 写响应体时，服务端要根据客户端的 `Accept` 头和自己能产出的媒体类型做内容协商

也就是说：

- 读是“给定事实，找一个能读它的转换器”
- 写是“给定偏好和能力集合，先协商出媒体类型，再找一个能写它的转换器”

这说明 Spring 统一的不是“都用同一套判断”，而是：

- **同一套转换器协议在读 / 写方向上走两种不同分派逻辑。**

第二层问题是：**`HttpMessageConverter` 本身只定义四个方法，但真正的差异都被压进了 supports/readInternal/writeInternal 三个变化点。**

也就是说，Spring 不要求每个转换器都自己重写：

- 媒体类型判断
- 默认 Content-Type
- Content-Length
- flush
- 读写骨架

这些都已经被 `AbstractHttpMessageConverter` 固定成模板方法。

第三层问题是：**Jackson 转换器并不是“支持 JSON 就完了”，它还要保住目标类型尤其是泛型类型的信息。**

因为：

- `UserDto` 和 `List<UserDto>` 不是一回事
- `Map<String, User>` 也不是普通 Class 能完整表达的

所以 `MappingJackson2HttpMessageConverter` 真正依赖的是：

- 通过 `JavaType` 保留泛型信息
- 再把这个 `JavaType` 交给 Jackson 自己做读写能力判断与序列化/反序列化

因此，本文真正要回答的问题不是“Spring 怎么支持 JSON”，而是：

**为什么对 Spring MVC 来说，`@RequestBody` 和 `@ResponseBody` 最终必须被提升成“统一转换器协议 + 读写双向分流 + 内容协商 + 泛型保留”的消息转换主线？**

## 先看失败方案：为什么不能把 JSON 处理写死在 `@RequestBody` / `@ResponseBody` 里、也不能统一按一种媒体类型判断

### 失败方案一：`@RequestBody` / `@ResponseBody` 直接写死 Jackson 逻辑

这是最容易想到的方案。

因为大多数现代 Web 应用最常见的确实就是 JSON。

但如果把 JSON 逻辑直接写死在 `@RequestBody` / `@ResponseBody` 支持器里，立刻会出现几个问题：

- `String`、`byte[]`、表单、XML、multipart 等其它消息格式无从接入
- 自定义媒体类型（如 `application/*+json`）难以扩展
- 所有格式都得侵入参数解析和返回值处理核心逻辑

所以 Spring 真正要避免的不是“多几个类”，而是：

- **把媒体格式选择写死在 MVC 主链里。**

### 失败方案二：读和写都按同一个媒体匹配规则处理

如果读写都统一为“遍历转换器，找第一个 `canRead/canWrite` 的就行”，看起来很省事，但实际上写方向会立刻失真。

因为：

- 读请求体时，客户端已经告诉你 `Content-Type`
- 写响应体时，服务端要同时考虑 `Accept` 头、控制器 `produces`、转换器支持范围

也就是说，写方向如果不先做协商，可能出现：

- 客户端只接受 `application/xml`
- 服务端却随手选了第一个支持 JSON 的转换器

所以 Spring 必须把：

- 读 = 直接按 `Content-Type` 找能读的
- 写 = 先做内容协商，再找能写的

这两件事分开。

### 失败方案三：泛型返回值和泛型请求体用裸 `Class<?>` 判断就够了

如果转换器只看 `Class<?>`，它永远没法区分：

- `List<User>`
- `List<Object>`
- `Map<String, User>`

这些实际语义完全不同的目标类型。

所以 Spring 真正要守住的不是“对象类型大概是什么”，而是：

- **消息转换时的完整目标类型语义。**

这就是 `JavaType` / `ResolvableType` 这些类型桥必须存在的原因。

## Spring 消息转换器链的最小总图

如果把这条主线先压缩成最小模型，它可以写成下面这样：

```text
request body read
   -> Content-Type
   -> iterate converters
   -> canRead(targetType, mediaType)
   -> readInternal / readJavaType

response body write
   -> Accept + producible types
   -> negotiate media type
   -> iterate converters
   -> canWrite(valueType, mediaType)
   -> writeInternal / Jackson serialize
```

如果再换一种更容易理解的拆法，这条链可以分成四段职责：

```text
[统一协议]
HttpMessageConverter

   ->

[模板骨架]
AbstractHttpMessageConverter

   ->

[读方向]
readWithMessageConverters(...)

   ->

[写方向]
writeWithMessageConverters(...)

   ->

[Jackson 实现]
MappingJackson2HttpMessageConverter
```

这张图最重要的价值，不是让读者记住几个 converter 名字，而是先把四个问题分开：

### 一、统一协议

回答：为什么 Spring 不把消息转换写死在 MVC 核心里，而要先抽成 `HttpMessageConverter` 接口？

### 二、模板骨架

回答：为什么媒体类型判断、默认头设置、读写骨架要统一收在抽象父类里？

### 三、读方向

回答：为什么 `@RequestBody` 要直接按 `Content-Type` 选转换器，而不需要先协商？

### 四、写方向

回答：为什么 `@ResponseBody` 必须先做 Accept / produces 协商，再匹配转换器？

### 五、Jackson 实现

回答：为什么 JSON 转换不仅是“支持 application/json”，还必须保住泛型类型信息？

只要先把这几层职责分开，Spring MVC 的消息转换就不再像“拿到 body 就直接扔给 Jackson”。

## 一、`HttpMessageConverter`：Spring 先统一“谁能读 / 谁能写”，再统一“如何读 / 写”

从最外层看，Spring 的消息转换并不是先选某种格式，而是先定义协议：

- `canRead(clazz, mediaType)`
- `canWrite(clazz, mediaType)`
- `read(...)`
- `write(...)`

这一步很像前面很多篇的写法：

- `HandlerMethodArgumentResolver` 先统一“参数归谁管”
- `MessageSource` 先统一“消息怎么问”
- `TaskExecutor` 先统一“任务怎么提交”
- 在这里，`HttpMessageConverter` 先统一的则是：

**某个媒体类型 + 目标类型，到底该归哪个转换器负责。**

也就是说，它首先组织的是两对职责：

- `canRead / canWrite` 负责归属判定
- `read / write` 负责真正读写动作

而不是具体 JSON/XML/String 的实现细节。

## 二、`AbstractHttpMessageConverter`：把共同的读写骨架先固定下来

只要统一协议立住之后，Spring 接下来做的不是让每个转换器自由发挥，而是先把通用骨架固定下来。

在 `AbstractHttpMessageConverter` 里，最关键的模板点有三类：

- 类型支持：`supports(clazz)`
- 媒体类型支持：`canRead(mediaType)` / `canWrite(mediaType)`
- 真正变化点：`readInternal(...)` / `writeInternal(...)`

除此之外，像：

- 默认 `Content-Type` 推断
- `Content-Length` 头设置
- flush
- Streaming output 分支

这些都由模板层统一处理。也就是说，响应头里最基础的 `Content-Type / Content-Length` 默认行为本来就是模板骨架的一部分，而不是 Jackson/String/byte[] 这些具体转换器各自随意决定的。

也就是说，Spring 真正统一的不是“所有 converter 长得像”，而是：

- **转换器的 80% 骨架由模板固定，子类只负责 20% 的差异点。**

这也是为什么 String / byte[] / Jackson / XML 这些看似不同的转换器，最后都能共享同一套读写框架。

## 三、读链路：`@RequestBody` 不是协商，而是按 `Content-Type` 找第一个能读的转换器

前一篇已经立住了：`@RequestBody` 的参数不是按名字取，而是把整个 body 交给消息转换器链。

进入 `readWithMessageConverters(...)` 之后，Spring 真正做的事情是：

1. 从请求头取 `Content-Type`
2. 如果缺失，按 `application/octet-stream` 兜底
3. 遍历 messageConverters
4. 问每个 converter：你能不能读这个**目标类型 + 媒体类型**？
5. 第一个能读的 converter 执行 `read(...)`

这说明读链路本质上不是“协商”，而是：

- **客户端已经给出了确定媒体类型，服务端只需要找一个能读它的实现。**

这里还要先把失败边界总括清楚：读方向至少有两类不同出口。

- 找不到任何可读 converter，属于媒体类型不被支持，通常走 `HttpMediaTypeNotSupportedException`
- 找到了 converter，但 body 缺失、格式损坏或解析失败，属于消息内容不可读，通常走 `HttpMessageNotReadableException`

也就是说，读链路真正统一的是：

- “给定 body 媒体类型，谁来接管反序列化”
- 以及“是没有合适转换器，还是转换器读 body 失败”这两类不同错误边界

## 四、写链路：`@ResponseBody` 不是直接写 JSON，而是先做内容协商再选转换器

写方向则完全不同。

因为到写响应时，服务端面对的不是一个已确定的媒体类型，而是三组约束的交集：

- 客户端可接受的 `Accept` 列表
- 当前 Controller 方法的 `produces` 声明（如果有）
- 当前消息转换器能够生产的媒体类型集合

所以 `writeWithMessageConverters(...)` 不能像读那样直接“遍历第一个能写的”。它必须先做：

- acceptable media types
- producible media types
- 交集
- specificity 排序
- 选出最具体的 concrete media type

然后再遍历转换器，找出第一个 `canWrite(valueType, selectedMediaType)` 的实现。

也就是说，写链路真正组织的是：

- **内容协商 → 媒体类型裁决 → converter 选择**

这也解释了为什么写方向一旦没有交集，就会抛：

- `HttpMediaTypeNotAcceptableException`

这不是“没找到 converter”，而是“服务端能产出的类型与客户端 Accept 根本没有可交集的媒体类型”。

## 五、为什么 `RequestMappingHandlerAdapter` 默认消息转换器里没有“顶层 JSON converter 自动必有”这件事

这点很容易被 Spring Boot 经验带偏。

在纯 Spring MVC 框架层，`RequestMappingHandlerAdapter` 初始化默认消息转换器时，只会放最基础的几个：

- `ByteArrayHttpMessageConverter`
- `StringHttpMessageConverter`
- `AllEncompassingFormHttpMessageConverter`

也就是说，**框架层默认不保证顶层一定有 JSON converter**。

`MappingJackson2HttpMessageConverter` 是否出现在完整应用里，往往还取决于：

- classpath 上是否有 Jackson
- 上层 MVC 配置或 Boot 自动配置是否把它注册进来

这一步很重要，因为它说明：

- Spring MVC 消息转换抽象先成立
- JSON 只是其中一种策略实现，不是框架内建前提

## 六、`MappingJackson2HttpMessageConverter`：真正的 JSON 能力来自 Jackson，自身负责的是把 Jackson 接回 Spring 协议

只要进入最常见的 JSON 场景，就会落到 `MappingJackson2HttpMessageConverter`。

它最值得强调的一点是：

- 它本身并不重新发明 JSON 解析
- 真正的 JSON 读写能力来自 `ObjectMapper`

它在 Spring 里的核心作用，是把 Jackson 的：

- `canDeserialize`
- `canSerialize`
- `readValue`
- `writeValue`

接回 `HttpMessageConverter` 这套读写协议中。

也就是说，它统一的不是 JSON 算法，而是：

- **Jackson 如何成为 Spring 消息转换链里的一个标准节点。**

这也解释了为什么它的 `supports()` 可以很宽松，而真正的读写能力判断要继续委托给 `ObjectMapper.canDeserialize / canSerialize`。

## 七、为什么 `List<User>` 不会在消息转换时丢失成 `List<Object>`

只要继续讲 Jackson，就必须补一个特别关键的点：

- 泛型怎么保住？

因为如果只拿裸 `Class<?>` 去判断：

- `List<User>`
- `List<Object>`

对转换器来说就全变成了 `List.class`，信息已经丢失。

Spring 在这里做的，是先通过：

- `ResolvableType`
- `GenericTypeResolver`
- 再交给 Jackson 构造 `JavaType`

也就是说，消息转换主线里并不是直接把 `Class<?>` 扔给 `ObjectMapper`，而是先把目标类型重新保造成一个带泛型信息的 `JavaType`。

这一步和前一篇参数解析主线也要明确分工：`RequestResponseBodyMethodProcessor` 负责“参数归属、读 body、绑定与校验”，本篇继续解释的是它下面的 converter 世界——`canRead` / `read`、`canWrite` / `write`、内容协商以及 Jackson 的 `JavaType`。

这一步特别重要，因为它说明：

- `HttpMessageConverter` 世界和前面 `ConversionService` 世界一样，也在处理“目标类型不能只看裸类名”的问题

所以：

- 读 `@RequestBody List<User>` 时
- 写 `@ResponseBody List<User>` 时

Spring 和 Jackson 都不是把它当 `List<Object>` 处理，而是保住了容器元素类型。

## 八、为什么这篇必须放在参数解析之后、视图解析之前

看到这里，最值得回收的一个问题就是：

- 为什么消息转换器要在 `@RequestBody` 参数解析之后单独成篇？

因为前一篇的重点是：

- 参数解析世界如何分派

而这一篇真正要解决的，是其中 `@RequestBody` / `@ResponseBody` 这条分支自己的双向转换协议。

也就是说，前一篇负责讲：

- body 参数为什么单独走一条链

这一篇负责讲：

- 这条链里 converter 自己又是怎样继续分发和协商的

放到视图解析之前也同样自然，因为它们刚好是 MVC 返回值世界的两条平行分支：

- `@ResponseBody` → 消息转换器
- 非 `@ResponseBody` → 视图解析器

所以这篇站的位置，不是“JSON 小专题”，而是：

- **Spring MVC 请求体 / 响应体世界的双向转换主线。**

## 九、几个最容易错的判断

### 1. `@RequestBody` 直接把 body 交给 Jackson 就结束了

不成立。

它要先经过 `readWithMessageConverters(...)` 选择 converter，之后还会继续经过 Binder / Validator 收口。

### 2. 读请求体和写响应体是同一套“找第一个能用的 converter”逻辑

不成立。

读方向按 `Content-Type` 直接匹配；写方向要先做 Accept / produces 内容协商。

### 3. 只要 classpath 上有 Jackson，Spring MVC 一定默认有顶层 JSON converter

不成立。

框架层默认只有最基础的几个 converter；完整 JSON 支持通常还依赖上层 MVC 配置或 Boot 自动配置。

### 4. `MappingJackson2HttpMessageConverter` 自己决定能否处理泛型

不完整。

它依赖 Spring 先保住 `ResolvableType / JavaType`，再委托 Jackson 做泛型序列化 / 反序列化。

### 5. 多个 basename 是消息系统的问题，与消息转换无关

正确，但这也说明消息转换和 MessageSource 是两套不同主线，不应混在一起理解。

## 收网：Spring MVC 真正统一的不是“如何把 JSON 读写出来”，而是“如何用统一转换器协议，把请求体和响应体分别按正确方向、正确媒体类型、正确目标类型接回 MVC 主线”

现在可以回到开头的问题：为什么 `@RequestBody` 能读 JSON、`@ResponseBody` 又能写 JSON？

因为 Spring MVC 用统一的 `HttpMessageConverter` 协议，把：

- 谁能读
- 谁能写
- 读方向如何直接按 Content-Type 分派
- 写方向如何先做内容协商
- Jackson 如何被接入
- 泛型如何保留

这些问题组织成了一条双向消息转换主线：

```text
HttpMessageConverter
   -> AbstractHttpMessageConverter 模板骨架
   -> readWithMessageConverters (按 Content-Type 选能读的)
   -> writeWithMessageConverters (先协商再选能写的)
   -> MappingJackson2HttpMessageConverter / ObjectMapper
```

因此，这篇真正该带走的结论不是“Spring MVC 支持 JSON”，而是：

**Spring 把请求体 / 响应体问题从“交给某个 JSON 库处理”提升成了“通过统一 converter 协议，对读写方向分别做媒体类型分发与协商、再把具体格式能力接入 MVC 主线”的消息转换体系。**

这也留下了下一篇最自然的问题：既然 `@ResponseBody` 这一支已经把“直接写响应体”讲清楚了，那另一支“返回视图名 / ModelAndView”又是怎样通过 `ViewResolver` 链解析成真正视图并渲染的？

下一篇进入 Spring MVC 的视图解析主线。