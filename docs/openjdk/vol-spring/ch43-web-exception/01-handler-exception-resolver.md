# Controller 抛异常以后谁来接住：Spring MVC 的 `HandlerExceptionResolver` 责任链与 `@ControllerAdvice` 全局处理

> 本文基于 Spring Framework 6.x 当前源码。本文只讲 Spring MVC 异常处理主线：`DispatcherServlet.processHandlerException(...)` 如何遍历 `HandlerExceptionResolver` 链，`ExceptionHandlerExceptionResolver` 如何缓存并匹配 `@ExceptionHandler` / `@ControllerAdvice` 方法，`ResponseStatusExceptionResolver` 如何处理 `@ResponseStatus`，以及 `DefaultHandlerExceptionResolver` 如何为标准 MVC 异常设置 HTTP 状态码。异常响应体、ProblemDetail 和更复杂的错误页装配，会在后续篇章继续展开。

## 为什么 Controller 抛出异常后，不是直接把堆栈返回给浏览器

前面已经讲过 `DispatcherServlet.doDispatch(...)` 的正常请求链，也讲过 `HandlerInterceptor` 在正常和异常路径中的收尾行为。

但只要 Controller 抛出异常，一个更关键的问题就会出现：

- 这个异常由谁处理？
- 为什么有时返回 JSON，有时返回错误页？
- 为什么 `@ControllerAdvice` 可以处理所有 Controller 的业务异常？
- 404、400、405、415 这些标准异常的状态码又是谁设置的？

如果只从表面看，异常处理好像只是：

- catch 到异常
- 返回错误信息

但 Spring MVC 实际上并不是在一个 catch 里写死所有异常处理，而是把异常交给一条 `HandlerExceptionResolver` 责任链。

第一层问题是：**异常处理也是一个有顺序的策略链，不同 resolver 负责不同级别的错误语义。**

- `ExceptionHandlerExceptionResolver`：用户定义的 `@ExceptionHandler` / `@ControllerAdvice`
- `ResponseStatusExceptionResolver`：`@ResponseStatus` 和 `ResponseStatusException`
- `DefaultHandlerExceptionResolver`：Spring MVC 标准异常的默认状态码

它们不是同时执行三个处理器，而是按 order 排好的一条链：前一个返回非 null 才算真正接管，后面的 resolver 就不再继续尝试。

第二层问题是：**`@ControllerAdvice` 的全局处理不是异常对象自己找到方法，而是先把全局 advice 缓存起来，异常发生时再和当前 handler 的本地异常方法一起做匹配。**

如果每次异常都遍历所有 advice、所有方法、所有异常类型，处理成本会很高。Spring 会在 `initExceptionHandlerAdviceCache()` 阶段扫描 `@ControllerAdvice`，构建 `ExceptionHandlerMethodResolver`，将全局 advice 的异常类型与处理方法预先建立映射。真正发生异常时，再把：

- 当前 Controller 的本地 `@ExceptionHandler`
- 全局 `@ControllerAdvice` 缓存

放进同一套匹配逻辑里综合选择。

第三层问题是：**不同 resolver 返回 null 的含义是“我不处理”，而不是“异常消失了”。**

责任链中：

- resolver 返回非 null `ModelAndView`，表示它接管异常
- 返回 null，表示交给下一个 resolver
- 全部返回 null，异常继续向外抛，随后沿 `DispatcherServlet` / Servlet 容器错误路径继续传播——这不等于立刻固定成 500，也可能继续进入容器级错误页或更外层错误处理机制

因此，本文真正要回答的问题不是“Spring MVC 如何捕获异常”，而是：

**Spring MVC 如何把 Controller 异常交给一条有顺序的 Resolver 链，并分别用自定义异常方法、响应状态注解和标准异常兜底完成错误响应？**

## 先看失败方案：为什么不能一个 catch 全包、所有异常都走默认错误页、每次异常重新扫描处理方法

### 失败方案一：`DispatcherServlet` 里直接 catch 后统一返回 500

如果所有异常都统一返回 500，业务自定义异常、参数校验异常、404、405、415 就会失去不同的 HTTP 语义。

Spring 把异常处理拆成多个 resolver，让不同类型的错误由不同策略处理。

### 失败方案二：所有异常都直接走默认错误页

默认错误页只能处理框架兜底场景，无法满足业务返回统一 JSON、业务错误码或特定视图的需求。

因此用户的 `@ExceptionHandler` / `@ControllerAdvice` 必须优先于默认 resolver。

### 失败方案三：每次异常都反射扫描所有 `@ExceptionHandler`

如果每次异常都扫描全量 Controller 和 Advice 方法，错误处理链会产生明显的重复反射成本。

Spring 在初始化阶段构建异常类型到方法的缓存，异常发生时只做类型匹配和方法调用。

## 异常处理的最小总图

```text
handler / rendering exception
   -> DispatcherServlet.processHandlerException
   -> HandlerExceptionResolver chain
      -> ExceptionHandlerExceptionResolver (@ExceptionHandler / @ControllerAdvice)
      -> ResponseStatusExceptionResolver (@ResponseStatus)
      -> DefaultHandlerExceptionResolver (standard MVC exceptions)
   -> first non-null ModelAndView takes over
   -> render error response
```

## 一、`processHandlerException(...)`：异常重新进入 MVC 控制流

`DispatcherServlet` 在处理器或视图渲染阶段捕获异常后，调用 `processHandlerException(...)`。

它遍历容器中已经装配好的 `HandlerExceptionResolver` 列表，按照顺序调用：

```text
resolver.resolveException(request, response, handler, ex)
```

返回规则很简单：

- 返回非 null `ModelAndView`：当前 resolver 已接管
- 返回 null：继续下一个 resolver

这和 `HandlerMapping`、`ViewResolver` 的责任链语义一致：

- 当前节点不处理就返回 null
- 下一个节点继续尝试
- 首个能处理的节点接管

## 二、`ExceptionHandlerExceptionResolver`：`@ControllerAdvice` 如何变成全局异常处理

`@ControllerAdvice` 本身不是异常处理器，它只是声明一个全局组件。真正把它变成异常处理能力的是 `ExceptionHandlerExceptionResolver`。

初始化阶段，Resolver 会：

1. 扫描所有 `@ControllerAdvice` Bean
2. 为每个 Advice 创建 `ExceptionHandlerMethodResolver`
3. 扫描其中的 `@ExceptionHandler` 方法
4. 建立异常类型到处理方法的映射缓存

异常发生时，Resolver 会：

- 先查当前 Controller 的本地异常处理方法
- 再查全局 `@ControllerAdvice`
- 按异常类型（包括父类和 cause 链）选择最匹配的方法
- 使用 `InvocableHandlerMethod` 调用处理方法
- 处理方法返回值继续走普通 MVC 返回值处理链

这里还要补一层优先级边界：局部 `@ExceptionHandler` 通常先于全局 `@ControllerAdvice` 参与决策；而多个全局 advice 之间，又会继续受 `@Order` 和异常类型匹配深度影响。

因此，`@ExceptionHandler` 方法可以：

- 返回 JSON
- 返回视图名
- 返回 `ModelAndView`

它不是一套独立的输出机制，而是重新进入 MVC 的正常返回值处理路径。

## 三、异常类型匹配：为什么父类处理方法可以捕获子类异常

`ExceptionHandlerMethodResolver` 建立的是异常类型到方法的映射。

如果异常本身没有精确匹配，它会继续查找：

- 异常父类
- cause 链中的异常

但这里不能把它理解成“只要 cause 链里出现某个异常就一定覆盖当前异常”。真实逻辑仍然要比较当前异常、其父类层次以及 cause 链中候选之间的匹配深度，选择更合适的处理方法，而不是把 cause 机械地当成更高优先级。

例如：

```java
@ExceptionHandler(IllegalArgumentException.class)
public ResponseEntity<?> handleIllegalArgument(IllegalArgumentException ex) { ... }
```

即使实际抛出的是 `NumberFormatException`，也可以被这个方法捕获，因为 `NumberFormatException` 是 `IllegalArgumentException` 的子类。

如果多个方法都能匹配，Spring 会选择距离当前异常类型更近的处理方法。

## 四、`ResponseStatusExceptionResolver`：`@ResponseStatus` 的状态码语义

如果没有匹配的 `@ExceptionHandler`，异常链会继续尝试 `ResponseStatusExceptionResolver`。

它处理两类情况：

- 异常类或异常方法上带 `@ResponseStatus`
- 抛出的异常是 `ResponseStatusException`

这个 resolver 的主要任务是：

- 设置 HTTP status
- 设置 reason
- 可能直接发送错误响应
- 通常返回一个空 `ModelAndView`，把后续是否继续走容器错误页或响应体输出，交给当前响应状态和响应是否已提交这两个事实共同决定

它不一定生成一个完整的业务 JSON，它更像是：

- 把异常语义翻译成 HTTP 状态语义

## 五、`DefaultHandlerExceptionResolver`：Spring MVC 标准异常的最后兜底

如果用户没有自定义异常处理，也没有 `@ResponseStatus`，Spring MVC 还会用 `DefaultHandlerExceptionResolver` 处理标准异常。

常见映射包括：

- `NoHandlerFoundException` → 404
- `HttpRequestMethodNotSupportedException` → 405
- `HttpMediaTypeNotSupportedException` → 415
- `MethodArgumentNotValidException` → 400
- `AsyncRequestTimeoutException` → 503

它的 order 是 `LOWEST_PRECEDENCE`，因此自定义 resolver 会优先处理，只有前面的链都没有接管时，它才执行默认状态码映射。这里的“兜底”也要收紧理解：它是默认 resolver 链中的低优先级兜底，而不是所有未处理异常的最终唯一去处。某些异常如果连它也不识别，仍会继续向更外层 Servlet 容器错误处理路径传播。

## 六、为什么异常处理链也要排序

异常处理 resolver 的排序直接决定优先级。

对默认链来说，大致层次通常是：

1. 用户自定义 `@ExceptionHandler`
2. `@ResponseStatus` / `ResponseStatusException`
3. Spring MVC 标准异常兜底

但这里不能把它理解成一条永远固定不变的铁序列。真实顺序仍然受 resolver bean 的注册方式、`@Order` 和显式配置影响；上面这三层只是默认世界里的常见格局。

如果默认 resolver 排在用户自定义 resolver 前面，业务异常就可能提前被默认处理，用户写的 `@ControllerAdvice` 无法生效。

所以异常处理的 order 不是性能细节，而是：

- 哪一层错误语义优先接管请求

## 七、异常处理和拦截器的关系

处理器抛异常时：

- `postHandle` 不执行
- `processHandlerException` 尝试找到异常 resolver
- 异常最终被处理或继续抛出
- `afterCompletion` 仍然执行

视图渲染阶段也可能抛异常；此时同样可能进入异常处理路径，但响应可能已经部分提交，resolver 能够修改状态或替换响应内容的空间会更小。这是“处理器异常”和“渲染异常”都属于异常主线、但可恢复程度不同的边界。

这与前一篇 `HandlerInterceptor` 的收尾语义形成配合：

- resolver 负责把异常转成可响应的 HTTP 结果
- interceptor 的 `afterCompletion` 负责最终收尾

## 八、几个最容易错的判断

### 1. `@ControllerAdvice` 自己捕获异常

不成立。

它提供全局异常处理方法，真正扫描、匹配和调用的是 `ExceptionHandlerExceptionResolver`。

### 2. 所有异常都由 `DefaultHandlerExceptionResolver` 处理

不成立。

用户定义的 `@ExceptionHandler` 和 `@ResponseStatus` resolver 都排在默认 resolver 前面。

### 3. `@ExceptionHandler` 方法返回 JSON 后直接结束，不再走 MVC 返回值链

不成立。

它的返回值仍会进入 MVC 的返回值处理和视图 / 消息转换路径。

### 4. resolver 返回 null 表示异常没有了

不成立。

null 只表示当前 resolver 不处理，责任链会继续传递。

### 5. 处理器抛异常后 `afterCompletion` 不会执行

不成立。

即使处理器或视图渲染失败，已经成功执行 `preHandle` 的拦截器仍会进入 `afterCompletion`。

## 收网：Spring MVC 统一的不是“catch 一个异常”，而是“异常如何沿 Resolver 链重新回到 HTTP 响应主线”

现在可以回到开头的问题：Controller 抛出异常以后，谁来接住？

Spring MVC 的答案是一条有顺序的异常处理链：

```text
processHandlerException
   -> ExceptionHandlerExceptionResolver
   -> ResponseStatusExceptionResolver
   -> DefaultHandlerExceptionResolver
   -> render / sendError / continue propagation
```

因此，这篇真正该带走的结论是：

**Spring MVC 把异常处理问题从“DispatcherServlet 里写一个大 catch”提升成了“通过 HandlerExceptionResolver 责任链，把业务异常、响应状态异常和标准 MVC 异常分别交给不同策略处理，再重新汇入 HTTP 响应与拦截器收尾主线”的异常处理协议。**

这也留下了下一篇最自然的问题：既然 MVC 的请求入口、参数、消息转换、视图和异常处理都已经立住了，那 `@InitBinder`、`@ModelAttribute` 等绑定扩展，又是如何在参数解析之前定制 `WebDataBinder` 的？

下一篇进入 Spring MVC 的 `@InitBinder` 与数据绑定主线。