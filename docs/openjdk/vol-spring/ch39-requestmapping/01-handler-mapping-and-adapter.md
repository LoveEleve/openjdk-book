# 为什么 `@RequestMapping` 方法能被精确找到并调用：`HandlerMapping` 与 `RequestMappingHandlerAdapter` 的双链协作

> 本文基于 Spring Framework 6.x 当前源码。本文只讲 Spring MVC 主线里的第二层：`RequestMappingHandlerMapping` 如何在启动时把 `@RequestMapping` / `@GetMapping` 等注解方法注册成 `HandlerMethod`，运行时又如何根据 URL 与请求条件选出最佳匹配；以及 `RequestMappingHandlerAdapter` 如何把这个 `HandlerMethod` 继续推进成参数解析、方法调用和返回值处理。参数解析器、返回值处理器和 `@RequestBody` / `@ResponseBody` 会在后续篇章继续拆开。

## 为什么 `DispatcherServlet` 还不够：找到处理器和真正调用处理器其实是两件不同的事

上一篇已经把 `DispatcherServlet.doDispatch(...)` 的六步主链立住了：

- `getHandler`
- `getHandlerAdapter`
- `preHandle`
- `handle`
- `postHandle`
- `processDispatchResult`

只要走到这里，一个新的关键问题就会自然出现：

- `getHandler(request)` 到底是怎么从一堆 `@RequestMapping` 方法里找到当前这一个的？
- 找到了 `HandlerMethod` 之后，`ha.handle(...)` 又是怎么把它真正执行起来的？

如果只说“Spring MVC 会自动映射并执行”，那最值得学习的两条主线其实都被折叠掉了。

因为 Spring MVC 在这里并不是一个统一黑盒，而是故意拆成了两条完全不同的策略链：

- **HandlerMapping**：负责回答“这个请求该交给谁”
- **HandlerAdapter**：负责回答“这个处理器该怎样被调用”

第一层问题是：**请求匹配和处理器执行不是一个问题。**

一个 `@RequestMapping` 方法要真正跑起来，至少要跨过两个门槛：

- 启动期先被发现并注册进映射表
- 运行期再被某个适配器解释成“可调用的处理器方法”

这说明 Spring 不会把“找到它”和“执行它”揉成同一个大对象，而是故意拆开。

第二层问题是：**`RequestMappingHandlerMapping` 处理的是“候选发现 + 运行匹配”，不是每次请求再重新反射扫描 Controller。**

也就是说，`@RequestMapping` 主线不是：

- 请求来了
- 反射遍历所有 Controller 方法
- 现场判断谁匹配

而是：

- 启动时一次性扫描和注册
- 运行时只在注册表上做查找与评分

这和前面 BeanDefinition、配置类解析、事件监听扫描一样，都是典型的：

- **启动期建索引 / 运行期查索引**

第三层问题是：**找到 `HandlerMethod` 并不意味着已经能直接 `method.invoke(...)`。**

这里也要先把范围边界说清：本篇讲的是 Spring MVC 里最常见、也最核心的**注解式 `HandlerMethod` 主线**。它会顺带提到 `HttpRequestHandler`、原生 `Servlet` 这些其它 handler 类型，是为了说明为什么必须有 `HandlerAdapter`，但不会把整个 handler 生态一次讲完。

因为 Controller 方法的真实调用前，还要继续解决：

- 方法参数从哪来
- `@PathVariable` / `@RequestParam` / `@RequestBody` 谁负责解析
- 返回值怎么处理
- `@ResponseBody` 和视图渲染怎么分流

这就是为什么 Spring 还需要：

- `RequestMappingHandlerAdapter`

它并不是“另一个 Mapping”，而是：

- 把 `HandlerMethod` 进一步解释成可执行的 MVC 调用链

因此，本文真正要回答的问题不是“Spring MVC 怎么找到 `@RequestMapping` 方法”，而是：

**为什么对 Spring 来说，URL 映射必须在启动时先落成 `HandlerMethod` 注册表，而运行时又必须通过 `RequestMappingHandlerAdapter` 把这个元数据方法重新推进成一次真正的 MVC 调用？**

## 先看失败方案：为什么不能每次请求都重新扫描、也不能让 Mapping 和 Adapter 合成一件事

### 失败方案一：每次请求进来都遍历所有 Controller 方法现场匹配

这是最容易想到的朴素做法：

- 当前请求来了
- 把所有 Controller 和方法反射出来
- 一条条比路径、HTTP 方法、参数条件
- 找到匹配的那一个

这个方案的问题不在于“写起来麻烦”，而在于它会把扫描成本放到每个请求上。

而 Spring MVC 明明已经在启动阶段拥有完整的 BeanDefinition、配置类和组件扫描结果，完全没必要到运行时再重复做反射和注册工作。

所以 Spring 真正要避免的，不是“写代码多一点”，而是：

- **让每个请求都付扫描和反射成本。**

### 失败方案二：`HandlerMapping` 找到处理器后就顺手执行，不再单独要 `HandlerAdapter`

这个方案看起来也很顺：

- 既然已经找到了处理器
- Mapping 直接调用它不就完了

但问题在于，Spring MVC 面对的处理器类型并不只一种。

至少会有：

- `HandlerMethod`（注解式 Controller 方法）
- `HttpRequestHandler`
- `Servlet`

这几类处理器的调用协议完全不同。也就是说，“找到谁”和“怎么调用谁”本来就是两类问题。

如果把它们揉到同一个类里：

- 每种处理器都要在 Mapping 里额外塞一套执行分支
- Mapping 会不断膨胀成“发现 + 调用 + 参数处理”一体化怪物

所以 Spring 必须把这条链拆开：

- Mapping 决定归谁
- Adapter 决定怎么调

### 失败方案三：`HandlerAdapter` 直接做参数解析和返回值处理，但不预装解析器 / 处理器链

如果 `RequestMappingHandlerAdapter` 每次都用几个 if/else 去硬写 `@PathVariable`、`@RequestParam`、`@RequestBody`，它很快就会变成一个扩展困难的大解析器。

Spring 真正的设计不是这样。它会在自身初始化阶段先装配：

- 参数解析器链
- 返回值处理器链
- BinderFactory
- ModelFactory

也就是说：

- 运行时真正调用某个 HandlerMethod 时，核心问题不是“要不要解析参数”，而是“交给哪一个已准备好的解析策略去解析”

这再次体现了 Spring 一贯的方式：

- 先把策略链组好
- 请求到来时只负责调度和分发

## Spring MVC 的双链主线最小总图

如果把这条主线先压缩成最小模型，它可以写成下面这样：

```text
startup
   -> scan controller methods
   -> build RequestMappingInfo
   -> register HandlerMethod into MappingRegistry

request time
   -> lookup best HandlerMethod
   -> choose RequestMappingHandlerAdapter
   -> resolve arguments
   -> invoke method
   -> handle return value
```

如果再换一种更容易理解的拆法，这条链可以分成四段职责：

```text
[启动扫描注册]
RequestMappingHandlerMapping.initHandlerMethods

   ->

[运行时匹配]
lookupHandlerMethod / bestMatch

   ->

[处理器适配]
RequestMappingHandlerAdapter.handleInternal

   ->

[参数与返回值装配]
ServletInvocableHandlerMethod / argumentResolvers / returnValueHandlers
```

这张图最重要的价值，不是让读者背类名，而是先把四个问题分开：

### 一、启动扫描注册

回答：`@RequestMapping` 方法为什么能在运行时不靠重新反射，而直接从注册表里查出来？

### 二、运行时匹配

回答：当有多个路径、方法、参数条件时，Spring 怎么在运行时选出最佳匹配？

### 三、处理器适配

回答：为什么 `HandlerMethod` 不能直接调用，而必须经过 `RequestMappingHandlerAdapter`？

### 四、参数与返回值装配

回答：为什么调用 Controller 方法前要先装配参数解析器和返回值处理器链？

只要先把这四层职责分开，Spring MVC 就不再像“一个注解 + 一个方法自动跑起来”的黑盒。

## 一、`initHandlerMethods()`：`@RequestMapping` 不是运行时现场找出来的，而是启动时先注册好

先从 `RequestMappingHandlerMapping` 看，最值得钉死的一点就是：

- Spring MVC 的注解映射，不是运行时即时发现的
- 而是启动阶段先做一次全量扫描并注册

也就是说，`afterPropertiesSet()` 触发 `initHandlerMethods()` 时，容器会：

- 遍历所有 Bean 名称
- 用 `isHandler(beanType)` 过滤出 `@Controller` / `@RequestMapping` 候选
- 对每个候选类反射方法
- 用 `getMappingForMethod(...)` 解析出 `RequestMappingInfo`
- 再通过 `registerHandlerMethod(...)` 注册到 `MappingRegistry`

这一步特别重要，因为它和前面配置类、事件监听、BeanDefinition 世界高度同构：

- 启动期先做扫描与索引
- 运行期只在注册表上查找

所以 `@RequestMapping` 真正的第一层意义，不是“有个注解”，而是：

- **它能在启动时被提前压成可查找的运行索引。**

## 二、`RequestMappingInfo`：Spring 不是只按路径匹配，而是把多维条件一起注册起来

只要继续往 `getMappingForMethod(...)` 里走，就会看到：

- Spring 真正注册的并不只是 URL 字符串

它注册的是 `RequestMappingInfo`，里面至少包含：

- 路径条件
- HTTP 方法条件
- params 条件
- headers 条件
- consumes / produces 条件

这说明 Spring MVC 真正面对的不是“URL 找方法”这么简单，而是：

- **一组请求条件如何共同决定某个 HandlerMethod 的适用范围。**

也正因为如此，Spring 才不会把 paths、methods、params、headers、consumes、produces 散落成几组平行字段让运行时各自判断，而是把它们收束进一个 `RequestMappingInfo` 这样的复合匹配单元。只有这样，运行时才有一个统一对象去做 `getMatchingCondition(...)`、`compareTo(...)` 和 bestMatch 评分。

也正因为如此，运行时匹配不是普通哈希命中，而是：

- 先尽量走字面路径快速查找
- 找不到或需要比较时，再进入多条件匹配和排序

所以 `RequestMappingInfo` 不只是“保存注解值”，而是：

- **把注解世界里的多维请求语义提前注册成运行时匹配单元。**

## 三、`lookupHandlerMethod()`：运行时真正做的不是“找到一个 handler”，而是“从候选里选最佳匹配”

只要进入请求阶段，`RequestMappingHandlerMapping` 的真正核心就不再是扫描，而是：

- `lookupHandlerMethod(...)`

它特别重要的一点是：

- Spring 并不假设只会命中一个候选

因为现实里经常会出现：

- 字面路径和模板路径都能命中
- 多个方法都满足 HTTP 方法条件
- 某些 produces / params 条件会让候选再继续收缩

也就是说，运行时处理的不是“有没有命中”，而是：

- **多个候选里谁是 bestMatch。**

这就解释了为什么：

- `pathLookup` 只缓存字面路径
- 模板路径、变量路径需要回退到更复杂的全量候选匹配
- 最后还要调用 `RequestMappingInfo.compareTo(...)` 做比较排序

所以 `lookupHandlerMethod()` 真正统一的不是一次查找，而是：

- **快速路径 + 候选评分 + 最佳匹配裁决。**

这样，同一个 `@RequestMapping` 的 `HandlerMethod` 既可以被 RequestMapping 家族的 mapping 注册出来，也可以由统一的 adapter 协议继续往下执行。

如果两个候选经过条件匹配和比较后仍然无法分出唯一最佳结果，Spring 不会随便选一个，而会抛出 `IllegalStateException`，报告 `Ambiguous handler methods mapped`。这条失败边界非常重要：映射系统宁可明确暴露歧义，也不把请求静默交给不确定的 Controller 方法。

## 四、为什么 `pathLookup` 只存字面路径：模板路径不能被压平成普通 key

这个细节特别能说明 Spring MVC 为什么必须分成“启动注册 + 运行匹配”两段。

因为像：

- `/users/1`
- `/users/{id}`

这两类路径在语义上完全不同。

字面路径可以直接哈希查找，模板路径却需要：

- 展开变量
- 再结合 params / headers / produces 等条件一起比较

也就是说，Spring 不会为了“统一查找接口”而牺牲路径语义。

所以它选择：

- 字面路径进 `pathLookup`
- 模板路径保留到运行时走更复杂的比较和评分

这也说明 `MappingRegistry` 不是单一哈希表，而是：

- **多层索引 + 回退匹配策略**

这和前面 DataSource 路由、事件检索缓存、条件装配阶段世界的设计一样，都是：

- 快速路径先走
- 不够时再回到更重但更准确的匹配路径

## 五、为什么 `RequestMappingHandlerAdapter` 不是“再调一次方法”，而是把 HandlerMethod 推进成一次完整 MVC 调用链

找到 `HandlerMethod` 以后，很多人会下意识觉得：

- 那不就是 `method.invoke(...)` 了吗

这个判断对普通反射成立，但对 Spring MVC 远远不够。

因为 `HandlerMethod` 只是：

- 一个带目标 bean、Method、参数元数据的包装

真正调用它之前，Spring 还必须继续准备：

- 参数解析器链
- 返回值处理器链
- `WebDataBinderFactory`
- `ModelFactory`
- 异步请求支持上下文

也就是说，`RequestMappingHandlerAdapter` 的作用不是“再调一次方法”，而是：

- **把一个元数据化的 HandlerMethod 推进成一次真正的 MVC 请求处理链。**

所以 HandlerAdapter 不只是“适配不同 handler 类型”的薄层，它在这里更像：

- Controller 方法执行的装配工厂

这里的 `supports(handler)` 也不是礼貌性的多态接口，而是 Spring MVC 把不同 handler 世界压到统一 `ha.handle(...)` 调度入口的关键协议：先问“你能不能解释这个 handler”，能解释的 Adapter 才有资格接管后续调用。

## 六、`ServletInvocableHandlerMethod`：真正执行前，Spring 先要把参数世界和返回值世界都接好

只要进入 `invokeHandlerMethod(...)`，最核心的对象就是：

- `ServletInvocableHandlerMethod`

它的重要性在于，它不是简单包装 `HandlerMethod`，而是：

- 挂上参数解析器
- 挂上返回值处理器
- 挂上 BinderFactory
- 挂上 ModelFactory
- 挂上方法校验器

这里的“方法校验器”也不是装饰物，它正好把前面 `@Validated` 那条主线重新接回来了：Controller 方法真正执行前，方法参数和返回值的校验入口就挂在这一层，而不是在业务方法内部手工判断。

这说明 Spring MVC 真正要执行 Controller 方法时，并不是在反射调用前临时东拼西凑，而是先把：

- **参数世界**
- **调用世界**
- **返回值世界**

都装配到同一个 invocable handler 上。

也就是说，Controller 方法执行真正的关键不是“反射”本身，而是：

- **在反射之前，Spring 已经把整套调用语义挂好了。**

## 七、为什么 `HandlerAdapter` 和参数解析器链必须分开：一个负责“谁来执行”，一个负责“怎么喂参数”

只要继续往 `RequestMappingHandlerAdapter` 深处看，又会遇到另一个很重要的分层：

- `HandlerAdapter` 不自己手写所有参数解析
- 它再把参数问题继续交给 `HandlerMethodArgumentResolver` 链

这意味着：

- Adapter 负责“这个 HandlerMethod 怎样进入 MVC 执行链”
- Resolver 负责“每个参数怎么从 request / path / body / model 里拿出来”

如果压成一句最容易复述的话，就是：

- **Adapter 解决的是 handler 类型适配，resolver 解决的是参数来源适配。**

所以这两者不能合并成一个大解析器。

因为它们回答的是两类问题：

- **执行策略问题**
- **参数来源问题**

这也是为什么上一篇 `DispatcherServlet` 必须先把 Adapter 作为独立策略链立住。

## 八、`@ResponseBody` 与 `ModelAndView`：返回值处理不是“返回对象就结束”，而是另一条分流链

`ha.handle(...)` 真正结束时，Spring 还得继续回答：

- 这个返回值是拿去渲染视图
- 还是直接写响应体
- `@ResponseStatus` 是否让请求直接短路

这也是为什么 `ServletInvocableHandlerMethod.invokeAndHandle(...)` 之后，`RequestMappingHandlerAdapter` 还要继续走：

- 返回值处理器链
- `mavContainer.isRequestHandled()` 判定
- `getModelAndView()` 决定是否进入视图渲染

这里 `@ResponseStatus` 也不是一个孤立注解，它会通过设置响应状态并配合 `mavContainer.setRequestHandled(true)` 影响后续是否还进入视图渲染链。也就是说，返回值世界不仅在决定“返回什么”，还在决定“请求到这里是不是已经算处理完了”。

也就是说，Controller 方法的执行并不是 `method.invoke(...)` 一句就结束，而是：

- **返回值语义也要再被 Spring MVC 解释一遍。**

## 九、为什么这篇必须放在 `DispatcherServlet` 之后，而不能和 `@RequestBody` / 参数解析专题混在一起

看到这里，最值得回收的一个问题就是：

- 为什么这篇要先把 HandlerMapping / HandlerAdapter 这两条链讲清，再去拆参数解析器或消息转换器？

因为如果不先立住这两条总线，后面任何一个细化专题都会悬空。

比如：

- 不先知道 `RequestMappingHandlerMapping` 怎么注册和匹配，`@RequestMapping` 为什么能命中都讲不清
- 不先知道 `RequestMappingHandlerAdapter` 怎么装配 `ServletInvocableHandlerMethod`，`@RequestBody` 和参数解析器链也无从安放

也就是说，这篇不是“注解匹配细节”或“参数解析细节”，而是：

- **Spring MVC 主线里“找到谁”和“怎么调用谁”的双链总览。**

## 十、几个最容易错的判断

### 1. `@RequestMapping` 方法是请求来了以后才反射找出来的

不成立。

它们在启动时就被扫描并注册进 `MappingRegistry`，运行时只做查找与评分。

### 2. `HandlerMapping` 和 `HandlerAdapter` 是一一对应关系

不成立。

Mapping 负责找谁，Adapter 负责怎么调，二者是独立策略链。

### 3. `pathLookup` 能处理所有 URL 模式

不成立。

它主要缓存字面路径，模板路径仍要回到运行时候选匹配和评分。

### 4. 找到 `HandlerMethod` 就等于已经能直接执行 Controller 方法

不成立。

还必须经过参数解析器、返回值处理器、BinderFactory、ModelFactory 等装配链。

### 5. `@ResponseBody` 只是返回值处理器里的一个小分支

不完整。

它会直接改变是否生成 `ModelAndView`、是否进入视图渲染，是返回值世界的一条关键分流线。

## 收网：Spring MVC 真正统一的不是“URL 对上哪个方法”，而是“请求如何经过注册、匹配、适配和参数/返回值装配后落到 HandlerMethod 上”

现在可以回到开头的问题：为什么 `DispatcherServlet` 里的 `getHandler` 和 `ha.handle` 必须分成两条链？

因为对 Spring MVC 来说，它真正要面对的不是“找到一个方法就反射调用”，而是：

- 启动时如何把注解方法提前注册成运行时索引
- 运行时如何从多个候选里选出最佳匹配
- 找到 `HandlerMethod` 后又如何把它继续装配成一次完整的 MVC 调用

所以 Spring MVC 的双链主线可以压缩成：

```text
RequestMappingHandlerMapping
   -> 启动扫描注册
   -> 运行时 URL / method / params / headers / produces 匹配

RequestMappingHandlerAdapter
   -> 装配 ServletInvocableHandlerMethod
   -> 参数解析器链
   -> 返回值处理器链
   -> 真正调用 Controller 方法
```

因此，这篇真正该带走的结论不是“Spring MVC 有两个策略类”，而是：

**Spring 把请求映射问题从“找到一个 Controller 方法”提升成了“启动期注册索引 + 运行期最佳匹配 + 执行期参数/返回值装配”的双链调度协议。**

这也留下了下一篇最自然的问题：既然 `HandlerMapping` 和 `HandlerAdapter` 的总链已经立住了，那最常用的三类参数解析——`@PathVariable`、`@RequestParam`、`@RequestBody`——到底是怎样被 `HandlerMethodArgumentResolver` 链逐个识别并解析出来的？

下一篇进入 Spring MVC 的参数解析主线。