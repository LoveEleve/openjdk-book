# 一个 HTTP 请求进入 `Http11Processor` 之后，内部到底在发生什么

> 本文基于 Tomcat 10.1.34 当前源码。本文只讲 HTTP/1.1 处理纵深：请求进入 `Http11Processor` 之后，`InputBuffer`、`OutputBuffer`、Coyote `Request/Response`、keep-alive 与 recycle 这些对象和状态是怎样共同组成一条真实运行态的。本文不重讲整条请求主线，而是把视角收缩到协议处理层内部的对象生命史。

## 为什么“请求经过 Processor”这句话，其实把最重要的东西都折叠掉了

前面在 Tomcat 主干里，我们已经把请求进入主线讲清楚了：

- `Connector` 是外层入口
- `Endpoint` 接住连接与事件
- `Http11Processor` 负责协议处理
- `CoyoteAdapter` 把请求切进 Catalina

如果只停在这层理解，主线当然已经成立。

但读到这里，往往会自然留下一个非常大的空白：

**请求是“经过了 Http11Processor”没错，可这个“经过”里面到底发生了什么？**

如果不把这层打开，很多后面看起来像性能问题、状态问题、复用问题的现象都会显得悬空：

- 为什么同一个连接能连着处理多个请求
- `Request` 和 `Response` 到底是谁持有、什么时候复用
- Input / OutputBuffer 究竟只是读写工具，还是状态承载体
- keep-alive 为什么不只是网络开关，而会改变对象生命史
- recycle 为什么会成为性能与稳定性都很重要的一步

也就是说，`Http11Processor` 并不只是“把字节解析成请求”的一层薄壳。它更像一个运行时对象组织中心：

- 输入是怎么被接住的
- 请求语义是怎么一步步推进的
- 响应是怎么被写回的
- 这条链路结束之后，哪些对象被继续复用、哪些状态被清掉

所以，本文真正要回答的问题不是“`Http11Processor` 做 HTTP 解析”，而是：

**一个 HTTP 请求进入 `Http11Processor` 之后，Tomcat 到底在内部组织了一条怎样的对象生命史？**

## 先看失败方案：为什么不能把协议处理理解成“解析一下、写回一下”

### 失败方案一：HTTP 处理就是把字节解析成 Request，再把 Response 写回去

这是最常见的概括方式，因为它在结果上并没有错。

从表面上看，一个 HTTP 请求进入协议栈后，好像确实只是做了两件事：

- 把字节流解析成请求语义
- 把响应语义再编码回字节流

问题在于，这个说法完全看不到运行时对象本身的组织方式。

因为一旦真进入 Tomcat 当前实现，就会立刻碰到：

- 输入状态是谁维护的
- 请求对象什么时候成型
- 响应对象什么时候开始被填充
- keep-alive 下这一整套对象为什么不用每次全新创建
- 请求结束之后哪些状态会被 recycle

所以“解析一下、写回一下”只能描述表层动作，不能解释真实运行时。

### 失败方案二：`Http11Processor` 只是协议语义入口，不需要单独深挖对象层

另一种常见误区是：

- `Http11Processor` 当然负责 HTTP/1.1
- 但这不就是一个“懂协议的处理器”吗
- 真正重要的还是后面的容器执行链

这个理解的问题在于，它低估了协议层本身的对象生命史。

Tomcat 的很多后续现象——包括性能、复用、连接保持、请求状态推进——都和这层对象组织方式强相关。

如果这里不单独讲透，后面读者会知道：
- 请求能进来
- 也能出去

但不会真正明白：
- 为什么这层会影响吞吐
- 为什么 recycle 会重要
- 为什么有些问题表面看像业务慢，其实先卡在协议处理对象这边

### 失败方案三：对象复用以后再讲，HTTP 处理先只讲协议字段

如果只看协议本身，最容易沉进去的是：
- header
- body
- 状态码
- keep-alive 语义

这些当然都重要，但如果本篇只写成“HTTP/1.1 字段和状态解释”，就会错过真正值得深挖的一层：

**Tomcat 是怎么用一组对象和缓冲区，把这些协议语义不断接住、推进、写回、再回收的。**

所以，本篇的重点不只是“HTTP 规则”，而是“HTTP 规则在 Tomcat 当前实现里是如何附着在对象生命史上的”。

## HTTP/1.1 处理的最小总图

如果把这条处理链先压缩成最小模型，它大概可以写成下面这样：

```text
Socket bytes
   -> InputBuffer
   -> Request
   -> Http11Processor decisions
   -> Response
   -> OutputBuffer
   -> response bytes
   -> keep-alive / recycle
```

如果再换一种更容易理解的拆法，这条线可以分成四段职责：

```text
[输入承载]
InputBuffer + Request

   ->

[协议推进]
Http11Processor

   ->

[输出承载]
Response + OutputBuffer

   ->

[复用与退场]
keep-alive + recycle
```

这张图最重要的价值，不是让读者先记住所有类，而是先把四个问题分开：

### 一、输入承载
回答：请求字节流是谁接住、谁把它推进成请求对象？

### 二、协议推进
回答：哪一层在真正根据 HTTP/1.1 语义做判断与流转控制？

### 三、输出承载
回答：响应语义是怎么被组织并写回的？

### 四、复用与退场
回答：为什么同一条连接上可以继续处理后续请求，对象又是怎么被回收或复用的？

只要先把这四层职责分开，`Http11Processor` 这条线就不再只是“懂协议的处理器”。

## 一、`Http11Processor`：它不只是解析器，还是这条对象生命史的组织者

`Http11Processor` 的定义位置：

证据：`org/apache/coyote/http11/Http11Processor.java:70`
证据：`org/apache/coyote/http11/Http11Processor.java:251`

只看类名时，最容易把它理解成“一个 HTTP/1.1 解析器”。这个定位并不完全错，但明显太窄。

因为从当前实现视角看，它至少还在承担另一层职责：

- 它不是单纯被动解析字节
- 它还在组织这条协议处理链里各个对象和状态的推进顺序

也就是说，它不仅懂 HTTP/1.1 规则，还在决定：

- 什么时候继续读
- 什么时候请求对象算成型
- 什么时候可以往下游推
- 什么时候该组织输出
- 一轮请求结束后对象接下来怎么处理

这在方法级上也能直接看到：
- `service(...)` 是整轮协议处理主入口：`org/apache/coyote/http11/Http11Processor.java:251`
- `prepareResponse()` 负责把输出侧真正推向写回阶段：`org/apache/coyote/http11/Http11Processor.java:879`
- 一轮结束后会走 `endRequest()`，再触发 `inputBuffer.nextRequest()` 和 `outputBuffer.nextRequest()`：`org/apache/coyote/http11/Http11Processor.java:1194`、`org/apache/coyote/http11/Http11Processor.java:1166`

所以，把 `Http11Processor` 只写成“协议解析器”，会丢掉它真正更重要的一面：

**它是在管理协议层对象生命史的推进者。**

## 二、`InputBuffer` 与 `Request`：请求不是突然出现的，而是被一步步接住的

一个 HTTP 请求进入协议层，并不是一下子就变成一个完整的“请求对象”。

它首先要经历的是：
- 原始字节流进入
- 输入缓冲去承接这段流
- 请求对象逐步承载起更高层的语义状态

这就是为什么 `InputBuffer` 和 `Request` 应该被一起看，而不是拆成两个孤立类名。

- `InputBuffer` 更靠近“字节是怎么进来的”
- `Request` 更靠近“这些字节现在已经被组织成了怎样的请求状态”

对应的硬锚点也很清楚：
- `Http11InputBuffer`：`org/apache/coyote/http11/Http11InputBuffer.java:41`
- `Request`：`org/apache/coyote/Request.java:62`
- `Http11InputBuffer.nextRequest()` 会推动 `request.recycle()`：`org/apache/coyote/http11/Http11InputBuffer.java:287`
- `Request.recycle()` 自己会重置 headers、parameters、uri、method、scheme 等状态：`org/apache/coyote/Request.java:768`

也就是说，请求不是某一瞬间突然出现的对象，而是一段被持续推进的状态承载体。

所以本篇讲“输入承载”时，真正要立住的不是“Buffer 读数据”这种表层事实，而是：

**请求对象本身也是协议层生命史里被逐步构造出来的一部分。**

## 三、`Response` 与 `OutputBuffer`：写回也不是最后一行调用，而是一条对称的输出生命史

和输入一样，输出也不只是“最后调用一下 write() 就结束”。

在 Tomcat 当前实现里，响应也有自己的承载与推进结构：

- `Response` 负责承接更高层的响应语义
- `OutputBuffer` 更靠近字节写回

对应的硬锚点包括：
- `Response`：`org/apache/coyote/Response.java:51`
- `Http11OutputBuffer`：`org/apache/coyote/http11/Http11OutputBuffer.java:36`
- `Http11OutputBuffer.nextRequest()` 会推动 `response.recycle()`：`org/apache/coyote/http11/Http11OutputBuffer.java:261`
- `Response.recycle()` 自己会清理 headers 等响应状态：`org/apache/coyote/Response.java:637`

这意味着，HTTP 处理主线不是单向只读进来，而是一条完整的双向组织链：

- 进来时靠 `InputBuffer + Request`
- 写回时靠 `Response + OutputBuffer`

只有把这两端对称地看清楚，后面很多关于延迟、写回压力、缓冲状态的讨论才会有结构基础。

所以这里真正重要的，不是“输出也有个 Buffer”，而是：

**Tomcat 把 HTTP/1.1 的输入和输出都组织成了可承载状态、可被推进、可被复用的对象链。**

## 四、keep-alive 与 recycle：为什么这不是“一次性解析”，而是一条会循环的对象生命史

如果每个连接只处理一个请求，那前面这些对象组织还没那么有意思。真正让这条线变复杂、也变重要的，是：

- keep-alive
- recycle

只要 keep-alive 存在，请求处理就不再是“一次连接，一次对象，一次结束”的简单模型。

这一点在 `Http11Processor.service(...)` 的后半段也能直接看到：一轮请求结束后，不是简单把链条扔掉，而是继续调用 `inputBuffer.nextRequest()` 和 `outputBuffer.nextRequest()`，把对象推进到下一轮可复用状态。

它会变成：

- 一条连接上可能连续进入多个请求
- 一组对象会不断在多轮请求之间被复用
- 每轮处理之后，都必须把状态收回到适合下一轮继续使用的位置

这就是为什么 recycle 在 Tomcat 里不是微不足道的小步骤。它关系到：

- 下一轮请求看到的是不是干净状态
- 当前对象复用有没有把历史包袱带过去
- keep-alive 优化到底有没有因为状态残留而反噬系统

所以，keep-alive 不是“连接优化开关”这么简单，它直接改变了协议层对象生命史：

**这条线不再是一次性消耗，而是不断循环的运行时复用链。**

## 到了这里，HTTP 处理已经不能再被理解成“协议字段解析”了

现在再回头看“请求经过 `Http11Processor`”这句话，问题就非常清楚了。

它当然没错，但如果只停在这层，就会看不见协议层内部真正重要的东西：

- 输入状态如何被承接
- 请求对象如何被逐步推进
- 响应对象如何被组织与写回
- keep-alive 如何把整条链变成循环的对象生命史

也就是说，Tomcat 的 HTTP/1.1 处理主线，不只是“懂协议规则”，而是：

**用一组缓冲区、请求对象、响应对象和复用规则，把协议语义组织成一条真实运行态。**

这也是为什么这一篇不能省掉。因为只有把这层压实，前面的请求进入主线和后面的对象复用专题，才会真正接上。

## 这篇真正立住的，是“协议层对象生命史”这个概念

如果只从表面看，这篇很容易被讲成：

- `Http11Processor` 处理 HTTP/1.1
- 输入有 `InputBuffer`
- 输出有 `OutputBuffer`
- 最后 recycle 一下

这种讲法当然不算错，但还是太平。

从当前源码和前面主干综合起来，更稳妥的理解方式应该是：

1. HTTP 请求在 Tomcat 里不是一下子变成完整对象的
2. 输入、处理、输出、复用是同一条链上的连续阶段
3. `Http11Processor` 管的不只是协议语义，还在组织对象和状态的推进顺序
4. keep-alive 让这条线从一次性处理，变成可循环的对象生命史

只有把这个概念立住，后面再讲对象复用、性能瓶颈、慢请求为什么会卡在协议层，读者才有真正的抓手。

## 这篇之后，Tomcat 还值得继续补什么

到这里，Tomcat 完整卷又补上了一条以前只是主干里一笔带过、现在被单独压实的专题：

- HTTP/1.1 处理不是一句“Processor 解析协议”，而是一条对象生命史

如果继续沿这条线补深，最自然的下一步就是：

- **对象复用 / 对象生命周期复用专题**

因为到这里，输入、处理、输出、keep-alive 已经立住了；再往下最自然的问题就是：

- Tomcat 到底在哪些地方复用了对象
- 这些复用点为什么会和性能、稳定性、状态残留问题绑定在一起