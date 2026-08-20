# 请求一旦偏离正常路径，Tomcat 怎么把它重新接住：async、timeout 与 error

> 本文基于 Tomcat 10.1.34 当前源码。本文只讲“请求一旦不再沿着 `Mapper -> Valve -> FilterChain -> Servlet` 正常走到底，Tomcat 如何重新接住它”。也就是说，重点是 `AbstractProcessor / AsyncStateMachine -> AsyncContextImpl -> StandardWrapperValve / StandardHostValve -> ErrorReportValve` 这一段反向收束主线。至于 Session 生命周期、Mapper 路由树算法、WebSocket/HTTP2 各自的专项异步模型，会在后续专题继续展开。

## 正常主线讲完了，为什么还远远不够

前面两篇把 Tomcat 的正向主线大致立住了：

- 请求怎样从 Socket 进入 Tomcat
- 请求怎样从 Coyote 切进 Catalina
- 请求怎样在 Catalina 里经过 Mapper、Valve、FilterChain，最后推进到 `Servlet.service()`

如果只看这些内容，Tomcat 看起来像一条很规整的流水线：

- 请求进来
- 目标选好
- 责任链传播
- Filter 执行
- Servlet 执行
- 返回响应

问题是，真实请求并不会每次都这么平滑地走完整条链。

有些请求会这样偏离：

- Servlet 调了 `startAsync()`，请求不再在当前线程里就地收尾
- 业务迟迟没有完成，触发 timeout
- 某一层抛出异常，要么走错误页，要么直接走失败输出
- async dispatch 再次把控制流拉回容器链

一旦这些情况出现，前面那条“正向执行主线”就不够了。因为它只能解释：**请求正常时如何向前推进**，却解释不了：**请求一旦偏离正常路径，Tomcat 怎么把它重新接住。**

而 Tomcat 对这件事的处理，并不是在某个角落里打几个补丁。相反，它有一条非常清楚的反向收束链：

- Processor 侧有状态机负责感知请求已经偏离正常路径
- 容器侧有 `AsyncContextImpl` 协调重新分派与回调
- `StandardWrapperValve`、`StandardHostValve`、`ErrorReportValve` 又会重新进入主线，负责继续收束或兜底

所以，本文真正要回答的问题不是“Tomcat 支不支持 async”，也不是“异常时能不能显示错误页”，而是：

**一个已经偏离正常执行路径的请求，Tomcat 究竟是在什么地方感知到它出了岔子，又是在什么地方把它重新接回系统控制流里？**

## 先看失败方案：为什么不能把 async / timeout / error 当成几个零散小技巧

### 失败方案一：async 只是 `startAsync()` 之后换个线程继续跑

这是最常见的误解，因为从 Servlet API 表面看，async 好像就是这样：

- 调一下 `startAsync()`
- 当前线程先退出
- 后面换个线程再继续

这个理解当然抓住了一点表象，但它严重低估了 Tomcat 为此做的运行时控制。

因为只要真正沿源码往下追，就会立刻遇到几个无法回避的问题：

- 为什么 `AbstractProcessor` 构造时就要持有一个 `AsyncStateMachine`？
- 为什么不是单纯靠 `AsyncContext` 对象记录一下状态就完事？
- 为什么 async dispatch、timeout、complete、onError 这些动作需要共享同一套控制中心？

也就是说，async 不是“换线程”这么简单，而是**请求生命周期已经脱离了正常同步返回路径**。一旦这样，就必须有更底层的状态机负责看住它。

如果把 async 写成 Servlet API 的薄封装，后面所有关于 timeout、error、容器线程边界的解释都会开始失真。

### 失败方案二：异常出口就是 `try/catch + 错误页`

另一种常见偷懒方式，是把错误处理理解成一个非常简单的模型：

- 某一层抛异常
- 上层 catch 住
- 找个错误页输出

这个说法在结果上并不完全错，但对 Tomcat 来说太薄了。它没有解释：

- 异常是在哪一层被重新接住的
- 为什么 `StandardHostValve.throwable(...)` 会重新变得关键
- `ErrorReportValve` 到底是“外围修饰”还是主线兜底角色
- async dispatching 过程中抛异常，和普通同步请求抛异常，控制流是否完全一样

所以异常出口不是某个散落的 `catch` 分支，而是 Tomcat 运行时收束偏离路径的一整套兜底机制。

### 失败方案三：timeout、complete、onError 只是几个平行事件

如果只从名字看，这几个词很容易被拆成互不相干的小点：

- timeout
- complete
- onError
- dispatch

但在 Tomcat 里，它们不是彼此独立的小功能，而是同一条请求在“偏离正常同步执行”之后，不同方向上的状态流出口。

如果把它们拆着理解，读者最后虽然能记住几个 API 名字，却拼不出完整的控制流：

- 请求什么时候还在正常主线上
- 什么时候已经进入 async 状态
- timeout 到底是谁感知的
- onError 为什么会反过来影响容器链
- complete 为什么不只是“业务代码写完了”

所以，本篇必须把这些看成一条统一的偏离路径收束链，而不是几块互不关联的补充说明。

## Tomcat 重新接住偏离请求的最小总图

如果把这条反向收束主线先压缩成最小模型，它可以写成下面这样：

```text
Servlet / Filter / async dispatch / exception
   -> AsyncStateMachine (Processor side)
   -> AsyncContextImpl (container coordination)
   -> StandardWrapperValve / StandardHostValve
   -> ErrorReportValve / error handling output
```

如果换一种更好理解的拆法，这条链可以分成三层职责：

```text
[状态核心]
AbstractProcessor -> AsyncStateMachine

   ->

[容器协调]
AsyncContextImpl / StandardWrapperValve

   ->

[兜底收束]
StandardHostValve.throwable(...) -> ErrorReportValve
```

这张图最重要的价值，不是让读者去背类名，而是先把三个问题分开：

### 一、状态核心
回答：是谁最先知道这个请求已经偏离了正常同步执行路径？

这一层主要由：
- `AbstractProcessor`
- `AsyncStateMachine`

承担。

### 二、容器协调
回答：请求一旦开始 async、dispatch 或进入异常分支，容器侧是怎么重新组织这条流的？

这一层主要由：
- `AsyncContextImpl`
- `StandardWrapperValve`

承担。

### 三、兜底收束
回答：当请求不能沿正常主线顺利完成时，谁负责在更外层把它重新兜底、转换成错误输出或错误页处理？

这一层主要由：
- `StandardHostValve`
- `ErrorReportValve`

承担。

只要先把这三层问题拆开，后面 async/timeout/error 为什么会互相牵连，就会清楚很多。

## 一、`AsyncStateMachine`：偏离正常路径时，请求状态先在这里变了

如果说前几篇讲的是“请求如何向前推进”，那本篇第一个必须立住的事实就是：

**请求一旦偏离正常同步执行路径，最先出问题的不是容器树，而是请求自己的生命周期状态。**

这也是为什么 `AbstractProcessor` 在构造时就直接创建了 `AsyncStateMachine`：

证据：`org/apache/coyote/AbstractProcessor.java:85`

而 `AsyncStateMachine` 自己的定义位置是：

证据：`org/apache/coyote/AsyncStateMachine.java:129`

这两个锚点组合起来，至少能先立住一个重要结论：

- async 不是 Servlet 层额外附加的一点小能力
- 它从 Processor 这一层就已经被纳入请求生命周期核心控制里了

也就是说，Tomcat 不是等到业务代码调了 `startAsync()` 才临时想起“这请求要特殊处理”。相反，Processor 从一开始就准备好了一套状态机，专门负责处理请求偏离同步主线后的状态变化。

这里最重要的不是马上把每个状态枚举背下来，而是先抓住这个定位：

**只要请求不再按“同步执行完就返回”这条路走，Processor 侧的状态机就必须先接管它。**

这也是为什么 timeout、dispatch、complete、error 这些名字后面都不会只是 Servlet API 事件，而会变成真正的运行时状态流。

## 二、`AsyncContextImpl`：状态变了以后，容器侧怎么重新组织这条流

只有状态机还不够。因为请求一旦进入 async，Tomcat 还要面对另一个问题：

- 状态已经偏离了正常路径
- 那容器侧怎么重新把这条流组织起来？

这一步就轮到 `AsyncContextImpl` 了。

其中一个很关键的锚点是：

证据：`org/apache/catalina/core/AsyncContextImpl.java:442`

这个位置之所以重要，不是因为它本身就是全部 async 逻辑，而是因为它直接暴露出一条事实：

**async 过程中抛出的异常，最后并不是留在某个局部回调里自生自灭，而是会被重新送回容器主线的错误出口。**

也就是说，`AsyncContextImpl` 不只是一个 Servlet API 包装对象。它的真实作用更像是：

- 把 async 请求在容器侧重新组织起来
- 在 dispatch、complete、error 这些动作之间做协调
- 一旦出现异常，再把它重新送回更外层的容器兜底结构

所以 `AsyncContextImpl` 的地位，不能只理解成“API 外壳”，而更适合先把它看作“容器侧 async 协调的关键落点”。

没有这一层，Processor 的状态变了，也没法自然落回 Catalina 的执行语义里。

## 三、`StandardWrapperValve`：偏离路径第一次回到容器执行链的地方

在正常主线里，`StandardWrapperValve` 是容器链与 Filter/Servlet 执行链的边界点。到了 async/timeout/error 主线里，它仍然很关键，只不过这次关键的不是“继续往前执行”，而是“偏离路径如何重新接回容器链”。

在 `StandardWrapperValve` 里，可以直接看到两个和 async dispatching 强相关的分支：

证据：`org/apache/catalina/core/StandardWrapperValve.java:152`
证据：`org/apache/catalina/core/StandardWrapperValve.java:164`

这些锚点说明一件很重要的事：Tomcat 在这里明确区分了：

- 正常请求继续 `filterChain.doFilter(...)`
- async dispatching 则走 `request.getAsyncContextInternal().doInternalDispatch()`

这就意味着，async 并不是“脱离容器主线，跑到别的世界去”。它只是让请求在某个时刻不再沿普通同步分支往下走，而改由另一条受控分支重新进入执行链。

所以 `StandardWrapperValve` 在这里承担的角色，不只是“第四层 Valve”，而是：

**偏离路径第一次重新接回容器执行链的位置。**

这也是为什么 Ch3 里讲它是“边界点”，到这一篇它又会重新变得关键。因为无论正常路径还是偏离路径，很多执行上的重新分派最终都绕不开它。

## 四、`StandardHostValve.throwable(...)`：异常为什么会重新回到 Host 这一层

异常一旦发生，Tomcat 并不会简单地在当前局部把它吞掉。更外层还要有人来判断：

- 当前 Context 在不在
- 这是不是客户端主动中断
- 有没有匹配的错误页
- 这次错误最终该如何继续输出

这也是 `StandardHostValve.throwable(...)` 重新变得关键的原因：

证据：`org/apache/catalina/core/StandardHostValve.java:231`

从这个锚点至少可以先看出一个结构事实：

- Host 这一层不只是在正常主线里负责往下分发
- 它在失败路径里还承担了重新兜底和判断错误出口的职责

这解释了一个经常会让读者困惑的现象：为什么异常出了以后，控制流好像又“退回”到了更外层？

因为从容器视角看，错误处理本来就不只是当前 Wrapper 或 Filter 的局部问题。它往往需要重新回到更外层的容器语义里去判断：

- 当前应用上下文是什么
- 错误页如何匹配
- 这次失败是否要直接终止

所以 `StandardHostValve` 在这里不是“重复接锅”，而是失败路径里本来就该重新出现的外层兜底角色。

## 五、`ErrorReportValve`：失败路径最后是怎么输出的

有了 `StandardHostValve.throwable(...)`，控制流已经重新回到了更外层容器语义中。但对一个失败请求来说，这还不是结束。

因为系统最后还要决定：

- 向客户端输出什么
- 是否构造默认错误页
- 哪些错误需要直接终止，哪些还能被包装成可见结果

这里就轮到 `ErrorReportValve` 出场了：

证据：`org/apache/catalina/valves/ErrorReportValve.java:61`

它在本文中的意义，不是“Tomcat 还有个错误页类”，而是：

**当下游 `Valve` 返回后，如果响应状态已经进入错误区间，或者存在未捕获异常，就需要有一个末端角色继续把失败处理接下去。**

这也解释了为什么它不能被当成外围装饰物。至少从当前实现和类注释能看出，`ErrorReportValve` 并不是单纯展示错误页，而是在失败路径的末端继续检查响应状态并触发错误处理。

换句话说，Tomcat 的失败路径不是：

- 某处抛异常
- 某处 catch 一下
- 事情结束

而是：

- Processor/状态机先感知请求偏离
- 容器侧重新组织这条流
- Host 层重新接住异常语义
- `ErrorReportValve` 再负责最后的失败输出

只有这样，Tomcat 才算真的把一条偏离正常路径的请求重新收束住了。

## 到了这里，请求并没有“恢复正常”，但它已经重新回到系统控制之中

看到这里，很容易又产生一个错觉：

- async 有状态机了
- 容器侧也有 `AsyncContextImpl` 了
- 错误出口还有 `StandardHostValve` 和 `ErrorReportValve`
- 那是不是说明这些请求最后又回到了“正常主线”？

并不是。

更准确地说，到这里我们能确定的是：

**请求即使偏离了正常同步执行路径，也没有脱离 Tomcat 的控制。**

Tomcat 并没有把这些场景丢给“某个回调自己处理”，而是明确准备了一条重新收束链：

- 状态先在 Processor 侧被看住
- 容器侧负责重新协调
- 更外层容器负责重新兜底
- 最后失败输出也有自己的末端角色

所以本篇真正要立住的，不是“Tomcat 对 async/error 做了很多特殊处理”，而是：

**Tomcat 的请求主线并不只有正向执行链，还有一条专门负责处理偏离路径的重新收束链。**

## 这篇真正立住的，是 Tomcat 不只会把请求往前推，也会把失控请求重新接住

如果只看正常主线，Tomcat 很容易被理解成一台很规整的转发机器：

- 进来
- 路由
- 执行
- 返回

但只要把 async、timeout、error 放进来，就会发现 Tomcat 的另一半能力恰恰在于：

- 它不只是会把请求往前推
- 它还会在请求偏离时，把它重新接回自己能控制的链条里

从当前源码归纳出来，更稳妥的理解方式是：

1. 正常主线负责把请求一路推进到执行末端
2. 偏离主线负责在 async/timeout/error 时重新组织状态与控制流
3. 两条链最后共同构成一个真正可运行的 Tomcat 请求系统

只有把这两半都建立起来，后面再讲 Session、错误页、容器关闭、连接超时时，读者才知道它们到底是在影响正向执行链，还是在影响偏离后的重新收束链。

## 下一篇该接什么

这篇已经把请求偏离正常路径以后，Tomcat 如何重新接住它的大框架立住了。

接下来最自然的继续点有两个方向：

1. 继续细化这条失败路径，专门深挖：
   - `AsyncStateMachine`
   - dispatch / complete / onError
   - timeout 语义

2. 回到另一个尚未展开的运行时主题：
   - Session 生命周期
   - 过期与持久化
   - 请求执行链中的 Session 参与边界

如果按当前卷的顺序继续推进，更自然的是先进入：

- **T-5 Session 生命周期闭环**

因为这时正向执行主线和偏离主线都已经立住了，读者也更容易理解 Session 为什么不只是“一个对象”，而是贯穿请求生命周期的状态载体。