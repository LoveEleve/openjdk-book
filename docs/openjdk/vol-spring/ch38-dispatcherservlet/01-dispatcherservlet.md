# 一个 HTTP 请求是怎样进入 Spring MVC 的：`DispatcherServlet.doDispatch` 的六步调度链

> 本文基于 Spring Framework 6.x 当前源码。本文只讲 `DispatcherServlet.doDispatch(...)` 这条主线：一个 HTTP 请求如何从 Tomcat `HttpServlet.service()` 进入 Spring MVC，再经过 `getHandler`、`getHandlerAdapter`、`preHandle`、`handle`、`postHandle`、`processDispatchResult` 这六步，最终被派发到 Controller 并返回视图。`HandlerMapping` 和 `HandlerAdapter` 的细节会在后续篇章展开。

## 为什么一个 HTTP 请求进入 Tomcat 后，最终能跑到你自己写的 `@RequestMapping` 方法上

前面几卷我们已经把 Tomcat 和 Spring 的很多基础拆开了。

但从 Tomcat 到 Spring MVC 之间，还需要一个关键的桥。这个桥就是 `DispatcherServlet`。

`DispatcherServlet` 本身是一个 `HttpServlet`，它被注册到 Tomcat 的嵌入式容器里。当请求到达 Tomcat 时，Tomcat 调用 `HttpServlet.service()`，最终进入 `DispatcherServlet.doDispatch(...)`。

`doDispatch(...)` 是 Spring MVC 的调度核心，它把“请求 → 处理器 → 视图”的流程固定成主链六步：

1. `getHandler(request)`：遍历 `HandlerMapping` 链，找到能处理当前请求的处理器
2. `getHandlerAdapter(handler)`：匹配一个合适的 `HandlerAdapter`
3. 如果 `preHandle` 返回 false，流程中断
4. `ha.handle(handler, ...)`：真正执行 Controller 方法
5. `postHandle`：执行后置拦截器
6. `processDispatchResult`：处理视图解析、异常收尾

主链之外还有一个收尾阶段 `afterCompletion`，它更像 finally：无论请求成功、失败还是被拦截器中断，已执行 `preHandle` 的拦截器，其 `afterCompletion` 都会被调用。所以严格说是“主链六步 + afterCompletion 收尾”，而不是七条平等的步骤。

第一层问题是：**`HandlerMapping` 和 `HandlerAdapter` 是两条独立的策略链，不是“一个 Mapping 对应一个 Adapter”。**

`HandlerMapping` 负责“找到能处理这个请求的处理器”。`HandlerAdapter` 负责“用合适的方式执行这个处理器”。两者是分离的：

- 同一个 `HandlerMapping` 返回的处理器，可能由不同的 `HandlerAdapter` 执行
- 不同的 `HandlerMapping` 可能返回相同类型的处理器，由同一个 `HandlerAdapter` 处理

第二层问题是：**`HandlerExecutionChain` 不只是目标处理器，还包含拦截器链。**

`getHandler(request)` 返回的是 `HandlerExecutionChain`，它包含：

- 目标处理器（通常是 `HandlerMethod`）
- 能匹配该请求的拦截器链

拦截器的 `preHandle` 在处理器执行之前调用，`postHandle` 在之后调用，`afterCompletion` 在请求完成时调用。

第三层问题是：**`doDispatch` 只负责调度，不负责执行具体的业务逻辑。**

`doDispatch` 把请求分发给 `HandlerAdapter`、拦截器链和视图解析器，但它自己并不执行 Controller 方法。真正的业务逻辑在 `HandlerAdapter.handle(...)` 内部完成。

因此，本文真正要回答的问题不是“`DispatcherServlet` 有哪些方法”，而是：

**`DispatcherServlet.doDispatch(...)` 如何用六步调度链，把 HTTP 请求从 Tomcat 的 `HttpServlet.service()` 推进到 Spring MVC 的处理器执行、拦截器链和视图解析？**

## 先看失败方案：为什么不能“一个 Servlet 处理所有请求”、让 `HandlerMapping` 和 `HandlerAdapter` 合并、把拦截器放在处理器内部

### 失败方案一：一个 Servlet 直接处理所有请求

如果只用一个普通的 `HttpServlet`，`service()` 方法里写大量 if/else 判断 URL 路径，代码会非常难维护。`DispatcherServlet` 用 `HandlerMapping` 链把 URL 匹配逻辑统一收走在适当的策略链中，而不是在调度器里硬编码。

### 失败方案二：让 `HandlerMapping` 和 `HandlerAdapter` 合并

`HandlerMapping` 找到处理器后，`HandlerAdapter` 负责执行。如果把它们合并，那每种处理器类型（`@RequestMapping` 方法、`HttpRequestHandler`、原生 `Servlet`）都需要单独一套映射规则。分离后，`RequestMappingHandlerAdapter` 可以只处理 `HandlerMethod`，而不管它来自哪个 `HandlerMapping`。

### 失败方案三：把拦截器逻辑放在处理器内部

如果拦截器逻辑写在 Controller 方法里，代码会散落在各处，且无法统一管理。`doDispatch` 把拦截器链放在 `HandlerExecutionChain` 里，在处理器执行前后统一调用。

## `doDispatch` 调度链的最小总图

```text
HttpServlet.service(req, res)
   -> DispatcherServlet.doDispatch(req, res)
   -> 主链六步:
      -> 1. getHandler(request)
         -> 遍历 HandlerMapping 链
         -> 返回 HandlerExecutionChain (handler + interceptors)
      -> 2. getHandlerAdapter(handler)
         -> 遍历 HandlerAdapter 链
         -> 返回匹配的 Adapter
      -> 3. preHandle (interceptor chain)
         -> 若返回 false，中断后续流程
      -> 4. ha.handle(handler, ...)
         -> 执行 Controller 方法
      -> 5. postHandle (interceptor chain)
      -> 6. processDispatchResult
         -> 视图解析 / 异常处理 / 收尾
   -> 7. afterCompletion (收尾阶段，类似 finally)
      -> 无论成功失败，已执行 preHandle 的拦截器都调用 afterCompletion
```

## 一、`getHandler(request)`：遍历 `HandlerMapping` 链找到处理器

`DispatcherServlet` 持有一个 `HandlerMapping` 列表（如 `RequestMappingHandlerMapping`、`BeanNameUrlHandlerMapping`、`SimpleUrlHandlerMapping` 等）。`getHandler(request)` 遍历这个列表，按顺序调用 `mapping.getHandler(request)`，返回第一个非 null 的 `HandlerExecutionChain`。

这些策略列表是在 Servlet 初始化阶段组装好的：`initHandlerMappings()` 从容器里收集所有 `HandlerMapping` Bean（或用默认策略），`initHandlerAdapters()` 同理收集 `HandlerAdapter`。也就是说，`doDispatch` 能遍历这些链，前提是它们已经在初始化阶段被装配进 `DispatcherServlet` 内部字段。

`HandlerExecutionChain` 包含：

- 目标处理器（通常是 `HandlerMethod`，即 `@RequestMapping` 方法的封装）
- 该请求匹配的拦截器列表

## 二、`getHandlerAdapter(handler)`：匹配处理器适配器

`getHandlerAdapter(handler)` 遍历 `HandlerAdapter` 列表，调用 `adapter.supports(handler)`，返回第一个匹配的适配器。

最常见的适配器是 `RequestMappingHandlerAdapter`，它支持 `HandlerMethod` 类型。不同类型的处理器需要不同的适配器：

- `HandlerMethod` → `RequestMappingHandlerAdapter`
- `HttpRequestHandler` → `HttpRequestHandlerAdapter`
- `Servlet` → `SimpleServletHandlerAdapter`

## 三、`preHandle` 与拦截器链

`HandlerExecutionChain` 中的拦截器，在 `preHandle` 中被逐个调用。如果某个拦截器的 `preHandle` 返回 false，后续拦截器和处理器都不会执行，当前请求被中断。

这里有一个重要的边界：当第 i 个拦截器的 `preHandle` 返回 false 时，前面已执行过 `preHandle` 且返回 true 的 0..i-1 个拦截器，其 `afterCompletion` 仍会被调用（通常通过触发 `triggerAfterCompletion`）。也就是说，“中断”不等于“什么都不做”，而是“中断 + 对已执行部分做 afterCompletion 收尾”。

## 四、`ha.handle(handler, ...)`：真正执行 Controller 方法

`HandlerAdapter.handle(...)` 是“真正干活”的地方。对 `RequestMappingHandlerAdapter` 来说，它会在内部解析参数（`@PathVariable`、`@RequestParam`、`@RequestBody` 等），调用 `HandlerMethod` 对应的方法，并处理返回值（`@ResponseBody` 序列化、`ModelAndView` 视图解析等）。

`handle` 的返回类型总是 `ModelAndView`；当处理器方法标注了 `@ResponseBody` 直接写响应体时，因为没有视图需要渲染，返回的 `ModelAndView` 为 null。也就是说，是“处理方法标注了 @ResponseBody”使返回值为 null，而不是“请求的一种方式”。

## 五、`postHandle` 与 `processDispatchResult`

处理器执行完后，拦截器的 `postHandle` 被调用。然后 `processDispatchResult` 处理视图解析和异常：

- 正常时：`render(mv, request, response)` 解析视图并渲染
- 异常时：`processHandlerException` 处理异常，可能展示错误页

## 六、`afterCompletion`：请求完成的收尾

无论是否成功，拦截器的 `afterCompletion` 在请求完成后被调用，用于资源清理、日志记录等。

## 七、几个最容易错的判断

### 1. `DispatcherServlet` 直接处理业务逻辑

不成立。

它只负责调度，业务逻辑由 `HandlerAdapter.handle(...)` 执行。

### 2. `HandlerMapping` 和 `HandlerAdapter` 是一一对应关系

不成立。

它们是两条独立的策略链，同一个 `HandlerAdapter` 可以处理来自不同 `HandlerMapping` 的处理器。

### 3. 拦截器只在处理器执行前执行

不成立。

拦截器有 `preHandle`、`postHandle`、`afterCompletion` 三个回调，覆盖执行前、执行后、请求完成三个阶段。

### 4. `doDispatch` 的任务是“把请求映射到处理器并执行”

不完整。

它还负责适配器匹配、拦截器调度、视图解析和异常处理。

### 5. `HandlerExecutionChain` 只包含处理器

不成立。

它包含处理器和拦截器链两部分。

## 收网：`doDispatch` 统一的不是“一个请求怎么被处理”，而是“请求如何经过 HandlerMapping、HandlerAdapter、拦截器、视图解析的协同调度”

现在可以回到开头的问题：为什么一个 HTTP 请求进入 Tomcat 后，最终能跑到你自己写的 `@RequestMapping` 方法上？

因为 `DispatcherServlet.doDispatch(...)` 在六步调度链中，把请求依次交给 `HandlerMapping`、`HandlerAdapter`、拦截器、处理器，最后交给视图解析器。

```text
getHandler → getHandlerAdapter → preHandle → handle → postHandle → processDispatchResult → afterCompletion
```

因此，这篇真正该带走的结论是：

**Spring 把 HTTP 请求分发问题从“一个 Servlet 处理所有请求”提升成了“用 doDispatch 调度链统一经过 HandlerMapping、HandlerAdapter、拦截器、视图解析的多阶段协同”的前端控制器协议。**

这也留下了下一篇最自然的问题：既然 `doDispatch` 调度链已经立住了，那 `HandlerMapping` 到底是怎么根据 URL 找到 `HandlerMethod` 的，以及 `HandlerAdapter` 又是怎么把 `@RequestMapping` 方法的参数解析、返回值处理、`@RequestBody` 序列化串起来的？

下一篇进入 Spring 的 `HandlerMapping` 与 `HandlerAdapter` 主线。