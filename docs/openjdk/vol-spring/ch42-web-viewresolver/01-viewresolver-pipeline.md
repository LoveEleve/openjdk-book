# 为什么 `return "userList"` 最后能变成 JSP 或 302：Spring MVC 的 `ViewResolver` 链与视图渲染主线

> 本文基于 Spring Framework 6.x 当前源码。本文只讲 Spring MVC 视图解析主线：`DispatcherServlet.render(...)` 如何把逻辑视图名交给 `ViewResolver` 链，`AbstractCachingViewResolver` 如何用模板方法统一缓存与并发控制，`UrlBasedViewResolver` / `InternalResourceViewResolver` 如何把逻辑名变成物理资源，以及 `ContentNegotiatingViewResolver` 怎样把 Accept 内容协商再引回视图世界。`HttpMessageConverter` 与 `@ResponseBody` 路径已经在上一篇展开，本篇只讲“非直接写响应体”的视图分支。

## 为什么 Controller 返回一个字符串，Spring 却知道该渲染 JSP、forward 还是 redirect

前一篇已经把 `@ResponseBody` 这一支讲清楚了：

- 返回值可以直接交给 `HttpMessageConverter`
- 不再走视图解析
- `ModelAndView` 可能为 null，请求被标记为已处理

只要走到这里，一个对照问题就会自然出现：

- 那当 Controller 返回的是一个普通字符串，比如 `"userList"`，Spring 又是怎么知道它要去渲染哪个 JSP、还是做一次 redirect / forward 的？

如果只从表面看，这像是在做一件很轻的事：

- 字符串 → 拼接路径 → 渲染

但只要真的往源码里追，就会立刻发现这里至少还藏着四类问题：

- 逻辑视图名和物理资源路径如何分开
- 多个 `ViewResolver` 同时存在时谁先试、谁后试
- 某个 View 创建后是否要缓存
- 同样一个逻辑视图名在不同 Accept 下为什么还能返回 HTML 或 JSON

也就是说，Spring MVC 这里真正要解决的不是“字符串怎么变成 JSP 文件名”，而是：

**逻辑视图如何经过 resolver 链、缓存骨架和内容协商，最终变成可执行的 View 渲染动作。**

第一层问题是：**视图解析和视图渲染不是一件事。**

很多人第一次看 MVC 视图时，会自然把它想成：

- 找到 JSP
- 渲染 JSP

这当然没错，但对 Spring 来说，中间必须先经过一层显式拆分：

- `ViewResolver` 负责“把逻辑视图名解析成 `View` 对象”
- `View` 负责“把 model 渲染进 HTTP 响应”

也就是说：

- 字符串视图名不是视图本身
- `View` 对象才是真正可执行的渲染动作

第二层问题是：**解析逻辑本身是一条责任链，而不是单个 resolver 独占。**

因为 Spring 允许多个 `ViewResolver` 同时存在：

- `InternalResourceViewResolver`
- `BeanNameViewResolver`
- `ContentNegotiatingViewResolver`
- 以及更多自定义 resolver

这意味着同一个逻辑视图名并不是交给某一个固定实现，而是：

- 由 resolver 链按顺序尝试，首个非 null 的 `View` 胜出

所以视图世界和前面 `HandlerMapping`、`HandlerAdapter` 一样，也是一条责任链。

第三层问题是：**字符串视图名里本身还编码了多种语义，不只是普通页面名。**

例如：

- `"userList"` → 逻辑视图名
- `"redirect:/users"` → 浏览器重定向
- `"forward:/login"` → 服务器内部转发

这说明视图解析主线不仅要找物理资源，还要先判断：

- 当前这个字符串到底表达的是哪种跳转语义

第四层问题是：**视图世界也有自己的内容协商。**

前一篇我们已经讲了 `HttpMessageConverter` 的内容协商：

- 读方向看 `Content-Type`
- 写方向看 `Accept` 与 producible types

但在 MVC 里，哪怕没有 `@ResponseBody`，逻辑视图名也仍然可能进入：

- `ContentNegotiatingViewResolver`

也就是说，Spring 不只是在消息转换器里做内容协商，它还允许在视图世界里根据 Accept 从多个候选 `View` 中选出最合适的那个。

因此，本文真正要回答的问题不是“Spring 怎么根据字符串找 JSP”，而是：

**为什么对 Spring MVC 来说，逻辑视图名必须被提升成一条“resolver 链 + View 缓存骨架 + redirect/forward 分派 + 视图层内容协商”的完整渲染主线？**

## 先看失败方案：为什么不能 Controller 直接返回物理路径、也不能只配一个 ViewResolver、也不能每次都重新建 View

### 失败方案一：Controller 直接返回物理资源路径

最直接的做法是让 Controller 返回：

- `/WEB-INF/views/userList.jsp`

这看起来最简单，但它会立刻把上层业务方法和底层视图存放位置绑死：

- 改一下 prefix / suffix，所有 Controller 返回值都要改
- 同一逻辑视图无法切换成 redirect / forward / JSON view
- 视图层路径结构泄漏到业务层

Spring 用逻辑视图名 + resolver 链把这些细节隔离开了。

### 失败方案二：所有视图都只交给一个 resolver 处理

如果只有单个 resolver，的确能覆盖最简单的 JSP 场景。但一旦你同时需要：

- JSP
- `redirect:` / `forward:`
- JSON View
- BeanNameView

就会发现单个 resolver 很快变得臃肿。

Spring 选择的是责任链：

- 每个 resolver 只回答“这个视图名是不是归我管”
- 不归我管就返回 null，让下一个 resolver 继续尝试

### 失败方案三：每次返回逻辑视图都重新创建一个 View 对象

逻辑上当然可行，但会带来明显的资源浪费：

- JSP View、BeanNameView、URL-based View 其实是轻量配置对象
- prefix/suffix 相同、locale 相同的视图完全可以复用

所以 Spring 把“缓存和并发控制”统一收在 `AbstractCachingViewResolver` 里，而不是让每个子类各自重新实现。

## 视图解析主线的最小总图

```text
Controller return value
   -> ViewNameMethodReturnValueHandler sets logical view name
   -> DispatcherServlet.render(modelAndView)
   -> resolveViewNameInternal(viewName, locale)
   -> ViewResolver chain
   -> first non-null View wins
   -> view.render(model, request, response)
```

这条线可以再拆成四层：

```text
[调度入口]
DispatcherServlet.render

   ->

[解析责任链]
ViewResolver / resolveViewNameInternal

   ->

[缓存模板]
AbstractCachingViewResolver

   ->

[具体策略]
UrlBasedViewResolver / InternalResourceViewResolver / ContentNegotiatingViewResolver
```

## 一、`DispatcherServlet.render(...)`：字符串返回值进入视图世界的总入口

`doDispatch` 主链走到最后，如果当前请求没有被 `@ResponseBody` 或其它直接响应路径标记成 `requestHandled=true`，Spring 就会进入：

- `DispatcherServlet.render(...)`

这一步特别重要，因为它说明视图世界在 MVC 里不是附属功能，而是：

- **与消息转换器并列的另一条返回值主线。**

`render(...)` 首先要做的不是渲染，而是判断：

- 当前 `ModelAndView` 里已经直接带了 `View` 对象
- 还是只有一个逻辑视图名，需要继续解析

如果是逻辑视图名，就进入 `resolveViewNameInternal(...)`，把解析责任交给 resolver 链。

也就是说，`render` 真正统一的是：

- 返回值已经走完 handler 链之后，如何进入视图世界

## 二、`resolveViewNameInternal(...)`：首个非 null 的 resolver 胜出

Spring 的 ViewResolver 链遵守一条非常清晰的规则：

- **首个返回非 null 的 View 立即胜出。**

也就是说，resolver 之间不是共同协作把一个视图拼出来，而是责任链式的“谁能处理谁接管”：

- 能处理 → 返回 `View`
- 不能处理 → 返回 null，继续下一个

这条规则和前面很多主线一脉相承：

- `HandlerMapping` 也是找第一个能接住请求的 mapping
- `HandlerMethodArgumentResolver` 也是先问谁支持当前参数
- `HttpMessageConverter` 也是遍历找第一个能读 / 写的 converter

所以 Spring MVC 在视图世界里依然坚持同一种风格：

- 统一入口
- 多策略候选
- 首个可处理者接管

## 三、为什么缓存要收进 `AbstractCachingViewResolver`

只要 resolver 链成立，下一个很自然的问题就是：

- 同一个逻辑视图名是不是每次都要重新解析成新的 View 对象？

如果每次都重新建：

- JSP View 的 prefix/suffix 拼接会重复发生
- BeanNameView 和 URL-based View 也会不断新建包装对象
- 多线程同时命中同一个视图名还会重复创建

Spring 把这个共性抽成：

- `AbstractCachingViewResolver`

它在基类里统一处理：

- `viewAccessCache` 快速读
- `viewCreationCache` 受锁保护的创建缓存
- `UNRESOLVED_VIEW` 哨兵
- `cacheFilter` 与 LRU 驱逐

这意味着具体子类不必重复实现：

- 并发控制
- 视图缓存
- 失败视图的哨兵值管理

它们只需负责：

- 如何真正 `createView(...)`
- 或更底层的 `loadView(...)`

这就是典型的模板方法：

- 缓存骨架固定在父类
- 视图构建差异留给子类

## 四、`UrlBasedViewResolver`：同一个字符串里其实已经编码了 redirect / forward / normal view 三种语义

`UrlBasedViewResolver` 的关键，不是“拼一个 prefix + viewName + suffix”这么简单，而是：

- 它首先会识别字符串前缀语义

也就是说，同样都是返回字符串：

- `"userList"` → 普通逻辑视图
- `"redirect:/users"` → 浏览器重定向
- `"forward:/login"` → 服务器内部转发

这说明逻辑视图名本身不是纯名字，而是：

- **逻辑名 + 特殊前缀语义的复合字符串协议**

在 `createView(...)` 里，`UrlBasedViewResolver` 首先检查：

- 是否有 `redirect:` 前缀 → 创建 `RedirectView`
- 是否有 `forward:` 前缀 → 创建 `InternalResourceView`
- 否则走普通 `loadView(...)`

这也解释了为什么 Spring MVC 不需要额外的 API 去声明 redirect / forward。前缀本身就是视图世界的一种轻量协议。

## 五、`InternalResourceViewResolver`：JSP 不是直接被“返回字符串”触发的，而是先变成 `View` 再通过 `RequestDispatcher` 渲染

当逻辑视图名走到 JSP 路线时，真正发生的步骤是：

1. resolver 把逻辑名拼成 `/WEB-INF/views/userList.jsp`
2. 生成 `InternalResourceView`（或 `JstlView`）
3. 渲染时把 model 暴露成 request attributes
4. 通过 `RequestDispatcher.forward()` 或 `include()` 真正把请求交给 JSP

也就是说，JSP 不是“字符串自己映射过去”的，而是：

- **先被包装成 `View` 对象，再由 `View.render(...)` 驱动 Servlet 容器完成转发。**

这说明视图解析主线和 Servlet 容器是二段式协作，而不是单一字符串替换。

## 六、`ContentNegotiatingViewResolver`：视图世界也做内容协商，它和消息转换器走的是平行逻辑

上一章已经讲了 `HttpMessageConverter` 的内容协商：

- 读方向按 `Content-Type`
- 写方向按 `Accept` + producible 媒体类型交集

视图世界其实也有自己的内容协商分支：

- `ContentNegotiatingViewResolver`

它做的事不是再写一套新的 Accept 逻辑，而是：

- 先拿到 requested media types
- 再让底下其他 resolver 尝试解析 viewName
- 收集候选 View
- 再按 `View.getContentType()` 与请求媒体类型做最优匹配

这说明：

- `@ResponseBody` 和 `ViewResolver` 虽然是两条不同主线
- 但它们在“内容协商”这一点上共享同一个上位问题：

**给定客户端 Accept，服务端该返回哪一种表现形式。**

两者的差别在于：

- 消息转换器处理的是“对象 → 响应体字节”
- 视图解析器处理的是“逻辑视图名 / model → 具体视图渲染”

所以 `ContentNegotiatingViewResolver` 不是消息转换器的替代品，而是视图世界里的平行协商器。

## 七、为什么这篇必须放在 `@ResponseBody` 之后：它们是返回值世界的两条平行分支

到这里最值得回收的一个问题就是：

- 为什么先讲 `HttpMessageConverter`，再讲 `ViewResolver`？

因为在 Spring MVC 里，返回值世界本来就天然分成两条路：

- 直接写响应体 → `@ResponseBody` / `HttpMessageConverter`
- 交给视图渲染 → 逻辑视图名 / `ModelAndView` / `ViewResolver`

前一篇把“直接写 body”讲清楚了，这一篇正好把另一支补完。

如果顺序反过来，读者会很难意识到：

- 视图解析并不是 MVC 的全部
- 它只是与消息转换器并列的一条返回值分支

也就是说，本篇不是“JSP 技巧篇”，而是：

- **Spring MVC 返回值世界中，视图分支的完整主线。**

## 八、几个最容易错的判断

### 1. Controller 返回字符串，就是直接拼成 JSP 路径

不成立。

逻辑视图名要先经过 `ViewResolver` 链，解析成 `View` 对象后再渲染。

### 2. 所有视图解析都由一个 resolver 完成

不成立。

Spring 使用责任链，首个返回非 null 的 resolver 胜出。

### 3. 视图解析和视图渲染是一件事

不成立。

resolver 负责“逻辑名 → View”，`View.render()` 负责“model → HTTP 输出”。

### 4. `redirect:` 和 `forward:` 只是 Spring MVC 特殊字符串写法

不完整。

它们实际上是 `UrlBasedViewResolver` 支持的前缀分派协议，对应完全不同的视图处理语义。

### 5. 内容协商只发生在 `HttpMessageConverter` 世界里

不成立。

`ContentNegotiatingViewResolver` 在视图世界里也会根据 Accept 做协商，只是处理对象不同。

## 收网：Spring MVC 统一的不是“怎么从字符串变成 JSP”，而是“逻辑视图如何经过 resolver 链、缓存骨架和渲染语义最终变成 HTTP 响应”

现在可以回到开头的问题：为什么 Controller 返回一个 `"userList"`，Spring 却知道该渲染 JSP、forward 还是 redirect？

因为 Spring MVC 并不把视图看成字符串替换，而是建立了一条完整主线：

```text
Controller return value
   -> ViewNameMethodReturnValueHandler 设置逻辑视图名
   -> DispatcherServlet.render(...)
   -> ViewResolver 链（首个非 null 胜出）
   -> AbstractCachingViewResolver 统一缓存骨架
   -> UrlBased / InternalResource / ContentNegotiating 等具体 resolver
   -> View.render(model, request, response)
```

因此，这篇真正该带走的结论不是“Spring MVC 会解析视图名”，而是：

**Spring 把视图问题从“字符串怎么拼文件名”提升成了“逻辑视图名如何经过责任链解析、缓存、内容协商并最终渲染成 HTTP 响应”的完整视图主线。**

这也留下了下一篇最自然的问题：既然 ViewResolver 这一支已经立住了，那在 `doDispatch` 里和它并列、同样沿请求生命周期切入的那条拦截器链——`preHandle`、`postHandle`、`afterCompletion`——到底是怎样组织 HandlerInterceptor 的？

下一篇进入 Spring MVC 的 `HandlerInterceptor` 主线。