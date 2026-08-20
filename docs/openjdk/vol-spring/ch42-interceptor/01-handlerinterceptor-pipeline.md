# 为什么 `preHandle`、`postHandle`、`afterCompletion` 不是三个平行回调：Spring MVC 的 `HandlerInterceptor` 正进逆出主线

> 本文基于 Spring Framework 6.x 当前源码。本文只讲 Spring MVC 拦截器主线：`HandlerInterceptor` 的三个回调为什么要按“正进逆出”的方式嵌进 `DispatcherServlet.doDispatch(...)`，`HandlerExecutionChain` 如何用 `interceptorList` 与 `interceptorIndex` 组织执行与清理，以及 `WebMvcConfigurer.addInterceptors(...)` / `InterceptorRegistry` 如何把路径和顺序装进这条链。异常处理器会在后续篇章继续展开。

## 为什么登录校验、审计日志、统一响应头这些能力，Spring 不让你直接写进 Controller

到前面为止，Spring MVC 的主干已经基本立住了：

- `DispatcherServlet` 负责总调度
- `HandlerMapping` 负责找到 `HandlerMethod`
- `HandlerAdapter` 负责把它推进成真正的调用链
- 参数解析器和消息转换器分别处理方法参数与请求体 / 响应体
- `ViewResolver` 负责视图世界

但只要进入真实 Web 项目，就会立刻出现另一类高频需求：

- 请求进 Controller 之前先做登录校验
- 请求完成后统一记录耗时
- 无论成功失败都要清理线程变量、MDC、埋点或资源

这类需求如果直接散落进 Controller，就会很快把业务方法污染成一堆重复模板。

这里也要先把范围边界说清：本文讲的是 **Spring MVC 内部的 handler 拦截线**。它不是 Servlet Filter 世界——Filter 发生在更外层的 Servlet 容器入口，而 `HandlerInterceptor` 已经站在 `DispatcherServlet` 内部、知道当前 handler 是谁的这条链上。

Spring MVC 的回答不是“再写几个工具类”，而是：

- **把请求执行链前后那些不属于业务本身、但又必须跟着请求流动的动作，收成一条可插拔的拦截器链。**

第一层问题是：**拦截器不是“一个前置回调 + 一个后置回调”这么简单，而是一条带清理语义的执行链。**

这也是为什么 `HandlerInterceptor` 不是只有两个方法，而是：

- `preHandle`
- `postHandle`
- `afterCompletion`

如果只把它理解成“前后两个切点”，你会立刻解释不通一个很关键的问题：

- 如果某个拦截器中途返回 false，或者处理器 / 视图渲染抛异常，谁来做已经执行部分的收尾？

这正是 `afterCompletion` 必须存在的原因。

第二层问题是：**多个拦截器同时存在时，执行顺序不能只是“注册顺序”，而要符合资源开闭的栈式语义。**

比如两个拦截器 A 和 B：

- A 先 pre
- B 再 pre
- 处理器执行
- B 先 post
- A 再 post
- B 先 after
- A 再 after

也就是说，前置是正序推进，后置和收尾是逆序回卷。

如果不这样设计，很多“先申请资源、后释放资源”的配对关系都会错位。

第三层问题是：**拦截器不只是全局链表，它还要按路径和顺序装配成每次请求实际可见的链。**

也就是说，Spring 要解决的并不是：

- 容器里有多少个拦截器

而是：

- 当前请求该经过哪些拦截器
- 它们的先后顺序是什么
- 哪些路径该跳过哪条拦截器

这就把 `HandlerExecutionChain` 和 `InterceptorRegistry` 一起拉进来了。

因此，本文真正要回答的问题不是“Spring MVC 拦截器怎么用”，而是：

**为什么对 Spring MVC 来说，拦截器必须被实现成“路径筛选 + 正进逆出 + 异常也收尾”的请求执行链，而不能只是 Controller 外层的几个普通回调？**

## 先看失败方案：为什么不能只要前后两个回调、也不能直接把拦截逻辑写进处理器里

### 失败方案一：只要前置和后置两个回调就够了

这看起来很自然。

因为最常见的拦截需求确实像是：

- 执行前做点事
- 执行后做点事

如果请求永远成功、也永远不会被某个拦截器中途拦下，这种双回调模型似乎足够。

但真实 Web 请求一旦出现：

- 某个拦截器 `preHandle` 返回 false
- 处理器抛异常
- 视图渲染抛异常

你就会发现只靠“前 / 后”根本不够。因为：

- 有些资源已经在前面被打开
- 但后置逻辑不一定还有机会顺利执行

所以 Spring 不能只给“前 / 后”，还必须给一个：

- **无论成功失败都要走的收尾钩子**

这就是 `afterCompletion` 的本质。

### 失败方案二：多个拦截器按注册顺序一直从头到尾执行就行

如果只从列表角度看，很容易觉得：

- A、B 两个拦截器就都按顺序调三遍
- `A.pre -> B.pre -> controller -> A.post -> B.post -> A.after -> B.after`

这个顺序在“日志打印”这种无状态场景下似乎也能跑。

但只要拦截器里做的是：

- 申请资源
- 进入上下文
- 打开计时器
- 设置 ThreadLocal / MDC

这种需要对称关闭的动作，就会立刻出问题。

因为正确的资源释放顺序应该是：

- **最后进入的先退出**

也就是标准的栈式 LIFO。

所以 Spring 不能把 post / after 也按正序执行，而必须让它们逆序回卷。

### 失败方案三：拦截器逻辑直接写在 Controller 或 Filter 里

如果把这些逻辑直接写在 Controller 里：

- 每个处理器都得重复写
- 业务代码和非业务代码彻底缠在一起

如果全部交给 Servlet Filter，又会丢掉 Spring MVC 拦截器的一个关键优势：

- Filter 发生在 HandlerMapping 之前
- 它根本不知道当前命中的到底是哪一个 `HandlerMethod`
- 也拿不到 `ModelAndView` 这种 MVC 语义对象

也就是说：

- Filter 太早
- Controller 太晚
- `HandlerInterceptor` 刚好站在 `DispatcherServlet` 内部、Handler 世界外层这个最合适的位置

## Spring MVC 拦截器链的最小总图

如果把这条主线先压缩成最小模型，它可以写成下面这样：

```text
request
   -> HandlerExecutionChain.applyPreHandle (正序)
   -> handler execution
   -> HandlerExecutionChain.applyPostHandle (逆序)
   -> view rendering / exception processing
   -> HandlerExecutionChain.triggerAfterCompletion (逆序, 仅清理已成功 pre 的)
```

如果再换一种更容易理解的拆法，这条链可以分成四层：

```text
[声明协议]
HandlerInterceptor

   ->

[运行时执行链]
HandlerExecutionChain

   ->

[DispatcherServlet 插点]
doDispatch 中的 pre / handle / post / render / after

   ->

[注册与路径约束]
WebMvcConfigurer / InterceptorRegistry
```

这张图最重要的价值，不是让读者记住几个类名，而是先把四个问题分开：

### 一、声明协议

回答：拦截器为什么需要 `preHandle / postHandle / afterCompletion` 三个回调，而不是两个？

### 二、运行时执行链

回答：多个拦截器如何按“正进逆出”的栈式语义执行？

### 三、DispatcherServlet 插点

回答：拦截器到底嵌进 `doDispatch` 的哪些位置？异常时又怎样兜底？

### 四、注册与路径约束

回答：拦截器怎么按 path pattern 和顺序装进链，而不是全局无差别生效？

## 一、`HandlerInterceptor`：Spring MVC 真正统一的不是“一个前置切面”，而是请求前、请求后、请求完成三段式语义

从接口层看，`HandlerInterceptor` 并不复杂，但它的三方法设计不是随手多加的。

- `preHandle`：处理器执行前
- `postHandle`：处理器正常返回后、视图渲染前
- `afterCompletion`：请求完成时，无论成功失败

它最重要的意义不在于“回调多”，而在于：

- Spring MVC 明确把请求链拆成了三段可插入语义

这和前面事务同步篇其实非常像：

- `afterCommit` 和 `afterCompletion` 必须分开，因为时机不同

这里也是一样：

- `postHandle` 只在处理器成功返回后才有意义
- `afterCompletion` 则必须覆盖异常和中断路径

所以 `HandlerInterceptor` 真正统一的不是“前后回调”，而是：

- **请求执行链的三段式生命周期语义。**

## 二、`HandlerExecutionChain`：为什么拦截器链要记录 `interceptorIndex`

只要多个拦截器同时存在，执行链就必须回答两个问题：

1. 哪些拦截器已经成功执行过 `preHandle`
2. 请求中途被中断或抛异常时，到底该对哪些拦截器执行 `afterCompletion`

这就是 `HandlerExecutionChain` 里 `interceptorIndex` 存在的真正原因。

它不是一个普通循环变量，而是：

- **当前请求已经安全进入到第几层拦截器的栈深记录。**

也就是说，每当某个拦截器的 `preHandle` 返回 true，`interceptorIndex` 就前进一格。

如果后面：

- 某个拦截器返回 false
- 或处理器 / 视图渲染抛异常

Spring 就可以准确知道：

- 只有 0..interceptorIndex 这些已经成功 pre 的拦截器需要 after 清理
- 还没执行到的那些拦截器不能乱清理

所以 `interceptorIndex` 真正保证的不是性能，而是：

- **异常与中断场景下的清理边界正确性。**

## 三、为什么 `postHandle` 和 `afterCompletion` 都要逆序执行

只要 `preHandle` 是正序推进，后半段最自然的问题就是：

- `postHandle` 和 `afterCompletion` 为什么要反过来？

因为 Spring MVC 在这里采用的是非常典型的栈式语义：

- 先进入的最后退出
- 先注册的最后清理

也就是说：

- `A.pre`
- `B.pre`
- handler
- `B.post`
- `A.post`
- `B.after`
- `A.after`

这不是为了和前面不一样，而是因为很多真实资源都要求这种对称：

- MDC / ThreadLocal
- 计时器开始 / 结束
- 权限上下文压栈 / 出栈

如果后半段也按正序执行，就会直接破坏这种对称关系。

所以逆序不是技巧，而是：

- **拦截器链的资源配对模型。**

## 四、`doDispatch` 里的精确插点：拦截器并不是围着 handler 随便绕一圈

只要回到 `DispatcherServlet.doDispatch(...)`，就会发现拦截器的插点非常精确：

1. `getHandler(...)`
2. `applyPreHandle(...)`
3. `ha.handle(...)`
4. `applyPostHandle(...)`
5. `processDispatchResult(...)`
6. `triggerAfterCompletion(...)`

这里最值得强调的不是顺序本身，而是：

- `postHandle` 发生在处理器成功之后、视图渲染之前
- `afterCompletion` 则发生在整个请求真正结束之后

也就是说，`postHandle` 还能碰到 `ModelAndView` 世界，`afterCompletion` 则更多是做最终清理。

这里还要把正常路径 / 异常路径的边界说硬一点：处理器一旦抛异常，`postHandle` 不会执行，但 `afterCompletion` 仍然会执行。也就是说，`postHandle` 属于“正常返回之后”的窗口，`afterCompletion` 属于“请求最终收尾”的窗口。

这就解释了为什么某些逻辑必须放在 postHandle：

- 改 Model
- 改 ViewName

而有些逻辑必须放在 afterCompletion：

- 释放资源
- 记录最终耗时
- 收尾清理

## 五、为什么 `preHandle=false` 不是简单 return，而是“中断 + 栈式清理”

当某个拦截器 `preHandle` 返回 false 时，请求不会继续走到处理器。

但这不代表这条链什么都不做了。

因为在它之前，可能已经有若干拦截器成功执行了 `preHandle`，它们也许已经：

- 打开了计时
- 压入了 ThreadLocal
- 申请了上下文资源

这时 Spring MVC 做的不是“直接 return”，而是：

- 先触发 `triggerAfterCompletion`
- 逆序清理前面那些已成功 pre 的拦截器
- 然后再中断请求

也就是说，`preHandle=false` 的语义从来不是“什么都不做”，而是：

- **中断 + 对已进入栈的部分做完整收尾。**

这正是为什么上一篇 review 里强调 afterCompletion 不能被理解成可有可无的 finally-like 附件。

## 六、为什么 `afterCompletion` 必须在异常路径也执行

请求并不总是正常返回的：

- 处理器可能抛异常
- 视图渲染可能抛异常
- 甚至某个后续步骤也可能中断

如果 `afterCompletion` 只在成功路径执行，那拦截器链就会变成：

- 成功时能清理
- 失败时资源泄漏

这显然不行。

所以 `DispatcherServlet` 在 try/catch 收尾里，无论是正常流还是异常流，都会确保 `triggerAfterCompletion` 最终被调用。

这说明 afterCompletion 在设计上就是：

- **对“请求一定结束了”这一事实的收尾回调**

而不是对“处理器成功返回”这一事实的回调。

## 七、`WebMvcConfigurer.addInterceptors(...)`：拦截器不是全局无差别生效，而是带路径和顺序被装进链

只要进入注册阶段，另一个很关键的问题就是：

- 拦截器不是容器里有一个 Bean 就自动全局生效

Spring MVC 真正的做法是：

- 通过 `WebMvcConfigurer.addInterceptors(registry)` 声明式注册
- 在 `InterceptorRegistry` 里附着：
  - path patterns
  - exclude patterns
  - order

然后再把这些结果装进 `HandlerExecutionChain`。

这一步特别重要，因为它说明拦截器世界真正被统一的，不只是“回调接口”，还有：

- **哪些请求该过这条链、它们按什么顺序过。**

而且这些注册信息不是等请求来了才临时计算，而是在 `HandlerMapping` 初始化阶段就被装进 `HandlerExecutionChain` 的构建逻辑里。也就是说：

- 启动时先把拦截器、路径模式、顺序约束收好
- 运行时只按当前请求命中结果挑出真正可见的那一段链

所以 `InterceptorRegistry` 不只是一个 List builder，而是：

- 对拦截器生效范围和排序规则的统一收口点

## 八、为什么它和 Servlet Filter 不是替代关系，而是分层关系

很多人第一次接触 Spring MVC 拦截器时，都会问：

- 这和 Servlet Filter 有什么区别？

最关键的分界在于：

- Filter 发生在 Servlet 容器层，更早
- `HandlerInterceptor` 发生在 Spring MVC 内部，已经知道当前命中的 handler 是谁

这意味着：

- Filter 更适合底层请求 / 响应包装、编码、CORS 等容器前置逻辑
- Interceptor 更适合依赖 `HandlerMethod`、`ModelAndView`、视图世界的 MVC 级逻辑

也就是说，它们不是简单替代关系，而是：

- **两个站在不同层级的拦截面。**

## 九、几个最容易错的判断

### 1. `postHandle` 和 `afterCompletion` 都只是“处理器之后做点事”

不成立。

`postHandle` 只在处理器成功返回后、视图渲染前执行；`afterCompletion` 覆盖请求结束时的统一收尾。

### 2. 多个拦截器的 `postHandle` / `afterCompletion` 应该按注册顺序执行

不成立。

它们必须逆序执行，才能守住资源开闭的栈式对称。

### 3. `preHandle=false` 只是中断请求，不会再做别的事

不成立。

Spring 会对已经成功 pre 的拦截器触发 `afterCompletion` 收尾。

### 4. 只要把拦截器 Bean 放进容器，它就会自动全局生效

不成立。

Spring MVC 需要通过 `InterceptorRegistry` 把路径和顺序配置一起装进链。

### 5. `HandlerInterceptor` 和 Servlet Filter 是一回事

不成立。

它们发生在不同层级，掌握的信息和可处理的语义不同。

## 收网：Spring MVC 统一的不是“前后加点逻辑”，而是“请求如何在 handler 外层形成一条正进逆出的拦截与收尾主线”

现在可以回到开头的问题：为什么登录校验、审计日志、统一响应头这些能力，Spring 不让你直接写进 Controller？

因为对 Spring MVC 来说，它真正要统一的不是“几个回调方法”，而是：

- 请求前如何正序进入若干拦截器
- 请求后如何逆序回卷
- 中断和异常时如何只对已进入部分做收尾
- 路径和顺序如何在注册阶段先收口成执行链

所以 Spring MVC 的拦截器主线可以压缩成：

```text
HandlerInterceptor
   -> HandlerExecutionChain.applyPreHandle (正序)
   -> handler execution
   -> applyPostHandle (逆序)
   -> processDispatchResult
   -> triggerAfterCompletion (逆序, 只清理已成功 pre 的)
```

因此，这篇真正该带走的结论不是“Spring MVC 有三个拦截器回调”，而是：

**Spring MVC 把横切逻辑问题从“在 Controller 里手工插代码”提升成了“请求如何在 handler 外层形成一条带路径约束、正进逆出、异常也收尾的拦截主线”的容器级协议。**

这也留下了下一篇最自然的问题：既然拦截器链和 DispatcherServlet 主链都已经立住了，那当处理器或视图渲染真正抛出异常时，Spring MVC 又是如何在 `processDispatchResult(...)` 之后通过 `HandlerExceptionResolver` 把异常重新收回控制流里的？

下一篇进入 Spring MVC 的异常处理主线。