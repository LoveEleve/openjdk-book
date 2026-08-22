# OpenFeign：Contract、MethodMetadata 与 RequestTemplate

> 基于 OpenFeign 13.14-SNAPSHOT

## 一、困惑开场：为什么 Feign 不在调用时现解注解

如果把 Feign 想成“声明式 HTTP client”，最直觉的实现方式其实是：每次接口方法被调用时，反射看看这个方法上写了什么注解，再现拼一遍 URL、headers、query 和 body。

这样写当然也能工作，但代价很明显：

- 每次调用都要重新解析注解  
- 每次调用都要重新判断参数是 path 还是 query 还是 body  
- 每次调用都要重新构造那份请求结构  

Feign 没这么做。它的关键设计是：**把“不会随每次调用变化的结构”尽量前移到 build-time。**

所以这篇文章要回答的不是“注解是什么语法”，而是：**这些注解最终怎样被压成一份可以复用的请求蓝图。**

## 二、前情回顾：上一篇讲运行主线，这一篇讲蓝图怎样生成

上一篇已经建立了 OpenFeign 的 runtime spine：

```text
builder -> ReflectiveFeign -> MethodHandler -> RequestTemplate.Factory -> Client.execute() -> ResponseHandler
```

但那篇刻意没有深讲一个关键问题：`MethodHandler` 是怎么来的？它为什么不需要在每次调用时重新理解接口？

这一篇只回答这一层。

这里要再把视角收紧：**本篇真正关心的不是注解语法长什么样，而是这些注解最后留下了哪些可复用的结构。**

- 注解接口如何变成 `MethodMetadata`
- `MethodMetadata` 怎样内含一份 `RequestTemplate` 原型
- 参数角色怎样在 build-time 被分类
- 每次调用时为什么只需要克隆并填值，而不是重新解释接口

换句话说，上一篇讲的是“运行链怎么跑”，这一篇讲的是“运行链的蓝图怎么被预先压出来”。

## 三、先走三条失败的路

### 失败方案一：`@Param` 天然就是 query/path 参数

这是很多新读者的第一直觉。看到：

```java
@RequestLine("GET /users/{id}")
User get(@Param("id") String id);
```

很容易以为 `@Param` 就等于“path 参数”或者“query 参数”。

但在 Feign 里，`@Param` 做的事情更底层：它只是把一个参数“命名”，至于这个名字最终出现在 path、query、header 还是 body template 里，要看请求模板里哪里引用了这个名字。

如果这个名字根本没有出现在任何 request variable 里，它甚至会被当作 form param。

所以 `@Param` 不决定语义位置，模板上下文才决定。

### 失败方案二：`RequestTemplate` 就是最终要发出去的 Request

如果这样理解，就解释不了为什么 Feign 还要在调用期再走一遍 `RequestTemplate.Factory.create(argv)`、`resolve(...)` 和 `Target.apply(...)`。

`MethodMetadata.template()` 存的是一份 **unresolved prototype**：里面还保留着 `{id}`、`{name}` 这样的变量占位，query/header/body 也可能还是模板。真正的 `Request` 要到每次调用时，根据这次 `argv` 重新克隆并填值之后才能生成。

所以 template 不是 final request，而是 request grammar。

### 失败方案三：body/query/header 的角色要等调用期才能知道

这也不对。OpenFeign 尽量把参数角色分类前移到 build-time：

- `bodyIndex`
- `queryMapIndex`
- `headerMapIndex`
- `indexToName`
- `formParams`

这些信息都被固化进 `MethodMetadata`。调用期真正要做的只是：把这次的参数值填进去。

## 四、最小总图：build-time 先造蓝图，invoke-time 再填实参

```text
Build time
interface + annotations
    ↓
Contract.parseAndValidateMetadata()
    ↓
MethodMetadata
    ↓
RequestTemplate prototype

Invoke time
argv
    ↓
RequestTemplate.Factory.create(argv)
    ↓
clone + fill + resolve
    ↓
Target.apply()
    ↓
final Request
```

这里最重要的边界要先钉死：

- **build-time 固定结构**：HTTP method、path template、header/query/body blueprint、参数角色槽位。  
- **invoke-time 填充数据**：本次 argv、queryMap/headerMap 内容、body 编码、base URL 与 target 语义。  

只要把这两层混在一起，就会误以为 Feign 每次都在“重新解释接口”。

## 五、`Contract`：接口方法怎样被翻译成 `MethodMetadata`

### 5.1 总入口：`parseAndValidateMetadata(Class<?>)`

当 `ReflectiveFeign` 组装 proxy 时，它会先让 `Contract` 去解析整个接口。

`Contract.java:49` — `parseAndValidateMetadata(Class<?>)`

这里做的是接口级遍历：跳过 `Object` 方法、静态方法、default 方法和 `@FeignIgnore`，只处理真正的 Feign 接口方法。

### 5.2 每个方法都先创建一份空白蓝图

对每个方法，`BaseContract.parseAndValidateMetadata(type, method)` 都会创建一份新的 `MethodMetadata`，先把最基础的东西放进去：

- target type  
- reflective `Method`  
- resolved return type  
- `configKey`

`Contract.java:91` — 创建 `MethodMetadata`

这说明 `MethodMetadata` 不是“最后补出来的结果对象”，而是 contract 解析的主容器。更重要的是，提前把参数角色固化下来，可以让运行期不再重复判断“哪个参数是 body、哪个是 queryMap、哪个要做 expander”；调用期只需按槽位取 argv。Feign 把结构判断前移，换来了更轻、更稳定的每次调用路径。

### 5.3 注解处理顺序：类级先于方法级

Contract 会先处理类级注解，再处理方法级注解。这样一来，类级 headers 或其他共享设定可以先写入模板，再由方法级继续覆盖或追加。

`Contract.java:101` — inherited interface annotations
`Contract.java:104` — target type annotations
`Contract.java:106` — method annotations

### 5.4 参数处理是最核心的一层

参数注解逐个处理时，会不断更新 `MethodMetadata`：

- `URI` 参数会被记到 `urlIndex`  
- `@QueryMap` 会被记到 `queryMapIndex`  
- `@HeaderMap` 会被记到 `headerMapIndex`  
- `@Param` 会进入 `indexToName`，再决定是不是 form param  
- 未消费的普通参数有机会成为 body

`Contract.java:120` — parameter annotations 处理
`Contract.java:136` — body/URI/options 分类
`Contract.java:241` — `nameParam(...)`

## 六、`DefaultContract`：OpenFeign 原生注解怎样落到模板上

### 6.1 `@RequestLine`：先决定 method 和 relative uri

`DefaultContract` 把 `@RequestLine("GET /users/{id}")` 解析成两个核心结果：

- `template.method("GET")`
- `template.uri("/users/{id}")`

`DefaultContract.java:57` — `RequestLine` 解析
`DefaultContract.java:64` — method
`DefaultContract.java:65` — uri

### 6.2 `@Headers`：类级和方法级都只是往模板里加 header blueprint

`@Headers` 不会立刻生成最终 header 值，只是把 header 模板写进 `RequestTemplate` 原型。

`DefaultContract.java:35` — `@Headers` processor
`DefaultContract.java:84` — method/class headers merge

### 6.3 `@Body`：literal body 和 body template 是两回事

如果 `@Body` 是纯字符串常量，就直接写成 body；如果里面包含 `{...}` 变量，就写成 `bodyTemplate`。

`DefaultContract.java:78` — literal body
`DefaultContract.java:80` — body template

这和 later 的 body encoder 又是不同层次：这里固定的是 body 的模板语法，不是把真实对象序列化成 bytes。

### 6.4 `@Param`：先命名，再由上下文决定位置

`DefaultContract` 处理 `@Param` 时，先解析参数名，再调用 `nameParam(...)` 记录 `index -> name`。

`DefaultContract.java:97` — `@Param` 处理
`DefaultContract.java:113` — expander class 记录

如果这个名字没有出现在任何 request variable 中，它才会被推断为 form param。

`DefaultContract.java:117` — form param 推断

### 6.5 `@QueryMap` / `@HeaderMap`：不是模板变量，而是后续追加源

这两个注解不会和普通 `{var}` 一样进入 path/query/header 的模板展开，而是只在 metadata 里记录一个特殊参数槽位。运行期再把 map 内容附加进去。

`DefaultContract.java:121` — `@QueryMap`
`DefaultContract.java:130` — `@HeaderMap`

## 七、`MethodMetadata`：请求蓝图到底存了什么

### 7.1 它不是“注解缓存”，而是方法蓝图

`MethodMetadata` 里存的东西，不只是注解结果，而是这个方法未来如何生成 request 的 blueprint。

它至少包括：

- `configKey`
- `returnType`
- `targetType`
- `Method`
- `bodyIndex`
- `urlIndex`
- `queryMapIndex`
- `headerMapIndex`
- `bodyType`
- `formParams`
- `indexToName`
- `indexToExpanderClass`
- `RequestTemplate template`

`MethodMetadata.java:28` — metadata state
`MethodMetadata.java:37` — RequestTemplate prototype
`MethodMetadata.java:52` — constructor back-link

### 7.2 `isAlreadyProcessed(...)` 是一个很重要的判定点

参数是不是已经被某种注解/语义消费掉，不是看它“长得像什么”，而是看 metadata 里有没有被标记过。

`MethodMetadata.java:212` — `isAlreadyProcessed(...)`

这让 Feign 能避免同一个参数同时被当成 body、又当成 queryMap 之类的重复语义。

## 八、`RequestTemplate`：为什么它是原型，不是最终请求

### 8.1 build-time 的 template 是共享原型

`MethodMetadata` 里那份 `template` 是每个方法共享的 blueprint。它持有：

- relative uri 模板  
- query template  
- header template  
- body template  
- method  
- target  
- slash / collection 等规则

`RequestTemplate.java:53` — template fields

### 8.2 每次调用先 clone

运行期不会直接修改这份共享原型，而是通过 `RequestTemplate.from(metadata.template())` 克隆出一份新实例。

`RequestTemplate.java:123` — clone from prototype
`RequestTemplateFactoryResolver.java:85` — 从 metadata.template() 克隆

这一步非常关键：它保证并发调用之间不会互相污染模板状态。更准确地说，多个调用共享的是请求语法结构，不共享任何一次调用的实参值；共享的是 prototype，不是 resolved template。

### 8.3 `resolve(...)` 才真正替换变量

path/query/header/body 模板中的 `{var}` 占位，都要到 `resolve(Map<String, ?>)` 才真正替换成这次调用的值。

`RequestTemplate.java:182` — resolve
`RequestTemplate.java:203` — query resolve
`RequestTemplate.java:239` — header resolve
`RequestTemplate.java:255` — body resolve

### 8.4 `request()` 才 materialize 成最终 `Request`

只有在 template 已经 resolved 之后，才允许调用 `request()` 生成真正的不可变 `Request`。

`RequestTemplate.java:287` — request()

所以 runtime 上的真实层次是：

```text
MethodMetadata.template()
  -> cloned template
  -> resolved template
  -> final Request
```

## 九、调用期：参数是怎样被填进模板里的

### 9.1 `RequestTemplateFactoryResolver` 选择工厂

Feign 不只用一种 template 工厂。它会根据 method metadata 的状态，选择：

- 普通 resolve 路径  
- form encode 路径  
- body encode 路径

`RequestTemplateFactoryResolver.java:40` — choose template factory

### 9.2 build-time 固定的是语法，invoke-time 填的是值

这就是第二篇最该记住的一句话。普通 `{var}` 模板变量和 `@QueryMap` / `@HeaderMap` 也不是同一阶段处理：前者进入 `resolve(...)`，后者在模板 resolve 之后再把这次调用的 map 内容追加进去。

调用期的 `argv` 会被填进：

- path variables  
- query variables  
- header variables  
- body template variables  
- queryMap / headerMap  
- body encoder

`RequestTemplateFactoryResolver.java:107` — argv -> resolve / append

### 9.3 `Request.Options` 是运行期特例，不进 metadata

`Request.Options` 参数不会被记在 `MethodMetadata` 的任何专用字段里，而是在运行时扫描参数数组时识别。

这也是一个典型例子：不是所有参数角色都值得提前固化，`Options` 就是纯调用期特例。

## 十、为什么这一切能让调用期足够轻

如果没有 `Contract -> MethodMetadata -> RequestTemplate prototype` 这层预编译，Feign 每次调用都得：

- 重新反射方法  
- 重新识别参数角色  
- 重新构造模板骨架  
- 重新分析 headers/query/body 模板

现在这些都提前做完了。调用期只做两件事：

1. 克隆 blueprint  
2. 用这次实参把它填满

这就是 Feign 这套设计真正的价值：把接口语法成本尽可能推到 build-time，把调用期压缩成“填值 + 执行”。

## 十一、误解澄清

### 误解一：`@Param` 天然就是 query 或 path 参数

不是。它只是给参数命名，具体落在哪一层，要看模板上下文。

### 误解二：`MethodMetadata` 只是方法注解缓存

不是。它是完整的请求蓝图，里面已经固化了参数槽位、模板原型和 body/query/header 等结构信息。

### 误解三：`RequestTemplate` 就是最终请求

不是。它先是共享原型，再是每次调用的克隆模板，最后才 materialize 成 `Request`。

### 误解四：`@QueryMap` / `@HeaderMap` 和普通 `{var}` 变量是一回事

不是。它们属于运行期后追加的特殊槽位，不走普通模板变量解析。

### 误解五：`Request.Options` 也是 metadata 的一部分

不是。它是纯运行期特例参数。

### 误解六：`@QueryMap` / `@HeaderMap` 和普通模板变量同阶段处理

不是。普通模板变量在 `resolve(...)` 阶段替换，而 QueryMap/HeaderMap 会在后续阶段把 map 内容追加到已经解析过的模板上。这种顺序差异会影响同名参数的覆盖和最终 Request 形态。

## 十二、收网总结：Contract 不是解释器，而是预编译器

回到开头的问题：为什么 Feign 不在调用时现解注解？

因为它想把“结构性的理解成本”尽量提前：

- `Contract` 负责把接口和注解翻成 `MethodMetadata`
- `MethodMetadata` 保存这次请求的结构蓝图
- `RequestTemplate` 持有 unresolved prototype
- 运行期只负责 clone + fill + resolve

**三句话总结：**

1. `Contract` 真正做的不是“临时解释注解”，而是 build-time 预编译接口方法的请求蓝图。  
2. `MethodMetadata` 保存的是参数角色和模板骨架，`RequestTemplate` 保存的是尚未填值的请求原型。  
3. OpenFeign 在调用期快，是因为它提前把结构固化了，运行时只做“把这次实参填进去”。  

**下篇预告：** 下一篇进入 OpenFeign 的 `Encoder / Decoder / ErrorDecoder / Retryer / Capability` 扩展层，看请求体、响应体和错误语义是怎么被继续装配进去的。