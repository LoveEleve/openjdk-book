# 为什么不能跳过 `*Grpc` 生成代码层：grpc-java 的 protoc 代码生成与运行时装配骨架

> 本文基于 `grpc-java v1.83.1` 当前源码。前面四篇已经把 grpc-java 的客户端调用主线、服务端调用主线、横切面协议，以及 NameResolver / LoadBalancer / transport 桥接主线立住了。但真实使用者接触到的入口并不是 `ClientCallImpl`、`ServerCallImpl` 或 `ManagedChannelImpl`，而是 `.proto` 生成出来的 `*Grpc`、Stub、`ImplBase`、`bindService()`。本文继续按这条主线往回追，专门回答：这些看起来很像样板代码的生成产物，到底是怎样把 `.proto` 契约装进 grpc-java 运行时主线里的。重点放在 `compiler/`、golden 样本、真实 `*Grpc` 产物、`MethodDescriptor`、Stub 工厂、`AsyncService`、`ImplBase`、`MethodHandlers`、`bindService()`；不展开 Spring 集成、不重讲前四篇运行时细节。

## 为什么不能把 `*Grpc` 文件当成噪音直接跳过

很多人读 grpc-java 源码时，一碰到 `compiler/`、`*Grpc.java`、golden 产物这种东西，第一反应都是：

- 这不就是代码生成出来的样板吗
- 运行时真正值钱的还是 `ClientCallImpl`、`ServerCallImpl`、`ManagedChannelImpl`
- 这些生成类能跑就行，没必要细看

这个直觉非常自然，但如果你真按这个思路跳过去，前面四篇已经建立好的主线会立刻断掉。

因为前面四篇回答的其实是：

- 一次调用在运行时里怎么跑
- 客户端怎样走到 `ClientCall`
- 服务端怎样走到 `ServerCalls`
- 拦截器、Context、Deadline 怎样挂回主线
- NameResolver / LoadBalancer / transport 怎样继续把调用送出去

可它们都默认了一件事：

- 用户是怎么接触到这条主线的

而对 grpc-java 绝大多数真实使用者来说，这个入口并不是：

- 手写 `MethodDescriptor`
- 手写 `ClientCall`
- 手写 `ServerCallHandler`

而是：

- 先写 `.proto`
- 再运行 `protoc-gen-grpc-java`
- 最后得到一个 `*Grpc` 文件
- 从里面拿到 Stub、`ImplBase`、`bindService()` 和若干方法描述符

所以如果把 `*Grpc` 文件直接当噪音跳过，就会有几个关键问题完全答不上来：

- `.proto` 里的一个 service 方法，到底是怎样变成前面四篇里反复出现的 `MethodDescriptor` 的？
- 为什么运行时主线里的 async / blocking / future 入口，在用户侧会刚好长成三种不同的 Stub？
- 为什么服务端实现只需要继承 `ImplBase` 或实现 `AsyncService`，最后就能接回 `ServerCalls` 这条主线？
- `bindService()` 看上去只是 glue code，它为什么实际上是服务端“方法契约 -> 运行时 dispatch”那座桥？
- lite / full protobuf 两条生成路径，为什么不仅依赖不同，连 marshaller 骨架都不同？

换句话说，前四篇已经把 grpc-java 的运行时骨架讲清楚了；而这一篇要补的是：

- **用户定义的 `.proto` 契约，到底怎样被装进这套运行时骨架。**

如果不补这一层，整卷读者仍然会卡在一个非常常见、但很难靠 runtime 文章自行跨过去的问题上：

- 我知道主线怎么跑了，可我项目里平时接触到的那些 `*Grpc` 文件，到底在这条主线里处于什么位置？

所以本文真正要回答的问题不是：

- grpc-java 有没有 codegen plugin
- grpc-java 会不会生成 Stub
- grpc-java 会不会生成 `ImplBase`

而是：

**为什么 `protoc-gen-grpc-java` 生成出来的 `*Grpc` 文件，不是样板噪音，而是 `.proto` 契约进入 grpc-java 运行时主线的第一座装配桥。**

## 先看失败方案：为什么不能把 codegen 层粗暴跳过

### 失败方案一：生成代码只是样板，理解 runtime 时整体跳过

这是最常见的误解。

因为从工程实践角度看，很多人确实不会去手改 `*Grpc.java`，于是就很容易觉得：

- 既然不手改
- 那就没必要理解

但这个判断漏掉了一个非常关键的事实：

- 你不需要修改它，不等于它不承担核心语义

codegen 层真正承担的是：

- 方法契约如何被稳定编码
- 客户端入口怎样被类型化暴露
- 服务端入口怎样被接成 dispatch 骨架

如果这一层整体跳过，你就解释不了：

- 为什么 unary / server-streaming / client-streaming / bidi-streaming 在 `*Grpc` 里已经提前分叉
- 为什么 `MethodDescriptor` 的 type、fullMethodName、marshaller、safe/idempotent 这些东西会在调用真正发生之前就先稳定下来
- 为什么服务端默认未实现行为会走 `asyncUnimplemented*`
- 为什么运行时后面只需要接这些骨架，而不需要每次重新解释 `.proto`

所以 codegen 层不是“可以完全无视的生成物”，而是前四篇运行时主线的契约入口层。

### 失败方案二：`*Grpc` 只是 API 皮肤，不承担运行时语义

另一种常见误解，是承认 `*Grpc` 有用，但只把它当成 API 外观。

比如：

- 这里有几个方法描述符
- 这里有几个 stub
- 这里有个 `ImplBase`
- 看上去像方便调用和继承而已

问题在于，这种理解会把真正最有价值的部分擦掉。

因为 `*Grpc` 并不是“随便包一层名字好看点的 API”，它里面稳定下来的很多东西，后面都会直接参与运行时：

- `MethodDescriptor.MethodType`
- full method name
- marshaller 选择
- sampledToLocalTracing
- safe / idempotent 之类方法属性
- `AsyncService` 的默认实现语义
- `MethodHandlers` 的分派逻辑
- `bindService()` 产出的 `ServerServiceDefinition`

这些都不是皮肤，而是：

- **运行时如何理解这份契约的骨架**

### 失败方案三：服务端生成代码只是为了给你一个 `ImplBase` 继承

很多人对服务端 codegen 的理解会停在：

- 生成了个 `ImplBase`
- 继承它，实现几个方法
- 完事

这个理解太薄了。

因为 `ImplBase` 的真正价值从来不是“帮你少写接口定义”，而是：

- 它和 `AsyncService`
- 它和默认未实现行为
- 它和 `bindService()`
- 它和 `MethodHandlers`

一起组成了服务端从“用户实现”回到 `ServerCalls` 主线的完整装配桥。

如果只把它理解成“方便继承”，你就永远解释不了为什么：

- `bindService()` 会长那样
- 为什么服务端没有让你手写 `ServerCallHandler`
- 为什么四种方法类型都能被统一地装成 `ServerServiceDefinition`

### 失败方案四：blocking / future / async stub 是运行时自己临时长出来的

还有一种微妙误解，是把三类 stub 全都理解成运行时临时分叉。

但真正的顺序其实是反过来的：

- 运行时当然统一收敛到 `ClientCall`
- 可面向用户暴露的 async / blocking / future 三类入口，是 codegen 层就已经生成好的

也就是说，运行时的统一和 API 的分化，并不是互相矛盾，而是通过 codegen 层提前完成了分工：

- codegen 负责把不同调用风格做成用户可用入口
- runtime 再把它们重新收束回统一主线

如果这层不先讲清楚，前面第一篇里“为什么有三种 Stub 但底层还能统一”的解释就会缺一块地基。

## 先立最小总图：`.proto` 是怎样接到前四篇 runtime 主线里的

如果先不抠生成细节，最值得先记住的不是某个类名，而是 `.proto` 怎样逐层落地。

```text
.proto service definition
  -> protoc-gen-grpc-java
  -> *Grpc.java skeleton
  -> MethodDescriptor(s)
  -> Stub factories / AsyncService / ImplBase
  -> MethodHandlers / bindService()
  -> ClientCalls / ServerCalls / runtime mainline
```

如果换成人话，这条链其实只发生了五件事。

第一，**service 契约会先被压成一组稳定的方法描述符**。

第二，**客户端表面调用入口会被分化成 async / blocking / future 三类 Stub**。

第三，**服务端应用入口会被做成 `AsyncService` / `ImplBase` 这类实现骨架**。

第四，**这些骨架不会直接自己发起调用或处理 transport，而是通过 `MethodHandlers` / `bindService()` 接回前四篇已经建立的 runtime 主线。**

第五，**marshaller 决定了请求/响应对象怎样从“protobuf 对象”进一步接到 grpc-java 的消息语义层。**

也就是说，本篇真正要建立的不是“编译器会生成什么文件”，而是：

- `.proto` 契约怎样稳定变成前四篇所依赖的运行时骨架

先有这张图，后面再去看生成文件本身，才不会把它误读成样板噪音。

## 第一层：`MethodDescriptor` 为什么必须先成为 codegen 骨架的地基

只要打开任意一个生成产物，比如 golden 里的 `compiler/src/test/golden/TestService.java.txt`，最先跳出来的真正关键结构，并不是 stub，也不是 `ImplBase`，而是那一串静态 `MethodDescriptor`。

例如 `getUnaryCallMethod()`、`getStreamingOutputCallMethod()`、`getStreamingInputCallMethod()`、`getFullBidiCallMethod()` 等，都是以静态懒加载方式存在，见 `compiler/src/test/golden/TestService.java.txt:20`。

这件事非常关键。

因为它说明 codegen 第一层真正稳定下来的，不是“某种 Java 方法外观”，而是：

- 这项 RPC 在 runtime 看来到底是什么方法契约

在每个 `MethodDescriptor` 构造里，生成代码都会把下面这些信息钉死：

- `MethodType`
- full method name
- request marshaller
- response marshaller
- tracing 采样标记
- 某些方法额外的 `safe` / `idempotent` 属性

例如：

- unary 会 `.setType(UNARY)`
- server streaming 会 `.setType(SERVER_STREAMING)`
- client streaming 会 `.setType(CLIENT_STREAMING)`
- bidi 会 `.setType(BIDI_STREAMING)`

见 `compiler/src/test/golden/TestService.java.txt:24` 及其后续各方法。

这说明什么？

说明 `.proto` 里的“这是什么 RPC”这件事，在 codegen 第一层就已经被精确定义为一份运行时契约，而不是等调用发生时再临时判断。

这和前面第二篇服务端调用模型的逻辑正好对上：

- 为什么 unary / server-streaming 会被归成一类
- 为什么 client-streaming / bidi 会被归成一类
- 为什么 single-response 契约会在服务端被严卡

这些都不是运行时临时脑补出来的，而是 `MethodDescriptor.MethodType` 从 codegen 层就已经稳定编码进去了。

### 为什么 full method name 和 marshaller 也必须在这里定死

`MethodDescriptor` 里另一个特别重要的点，是：

- `.setFullMethodName(generateFullMethodName(SERVICE_NAME, ...))`
- `.setRequestMarshaller(...)`
- `.setResponseMarshaller(...)`

见：

- `compiler/src/test/golden/TestService.java.txt:38`
- `compiler/src/test/golden/TestService.java.txt:40`

这说明 codegen 不只是把“方法类型”编出来，而是连：

- 这次 RPC 在协议层叫什么名字
- 请求对象怎样转成消息
- 响应对象怎样转回消息

这些最基础的桥接信息，也都提前压成静态骨架了。

也就是说，`*Grpc` 文件第一层解决的是：

- 用户契约怎样进入 gRPC 的统一方法语义层

没有这一层，后面的 stub 和服务端装配都无从谈起。

### `safe` / `idempotent` 说明 codegen 层还会带入更高一层契约属性

在同一个 golden 文件里，像 `SafeCall`、`IdempotentCall` 这种方法，还会额外生成：

- `.setSafe(true)`
- `.setIdempotent(true)`

见 `compiler/src/test/golden/TestService.java.txt:210` 之后。

这说明 codegen 层承接的不是“最小可调用信息”而已，它还会把更高一层方法契约直接烘进 descriptor。

所以不能把 `MethodDescriptor` 理解成“只是 runtime 查一下名字的结构体”。

它其实是 codegen 层输出给整个 grpc-java 运行时的第一份正式契约对象。

### lite/full 差异说明 codegen 不是一份模板到处抄

如果再对照 `compiler/src/testLite/golden/TestService.java.txt`，还能看到一个非常重要的事实：

- full protobuf 用的是 `ProtoUtils.marshaller(...)`
- lite 版本用的是 `ProtoLiteUtils.marshaller(...)`

见：

- `compiler/src/test/golden/TestService.java.txt:40`
- `compiler/src/testLite/golden/TestService.java.txt:37`

这说明 codegen 层不是“固定模板文本替换”，而是会根据生成目标把底层 marshaller 桥也一起改掉。

也就是说，grpc-java 的 codegen 已经提前把平台/依赖变体考虑进运行时入口骨架里了。

所以第一层可以先收一句：

- `MethodDescriptor` 不是 runtime 偶然用到的小结构，而是 `.proto` 契约在 grpc-java 里最先稳定下来的运行时地基

## 第二层：为什么三类 Stub 必须在 codegen 层就生成出来

前面第一篇已经解释过：grpc-java 运行时会把不同调用风格重新收束回 `ClientCall` 主线。

但如果继续往前追，就会发现面向用户暴露的 async / blocking / future 入口，其实不是运行时临时组出来的，而是 `*Grpc` 文件里先生成好的。

在 golden 文件和真实 `TestServiceGrpc` 产物里，都能看到：

- `newStub(...)`
- `newBlockingV2Stub(...)`
- `newBlockingStub(...)`
- `newFutureStub(...)`

见：

- `compiler/src/test/golden/TestService.java.txt:274`
- `interop-testing/src/generated/main/grpc/io/grpc/testing/integration/TestServiceGrpc.java:267`

这说明 codegen 层一开始就替用户把“表面 API 的分化”做好了。

### 为什么这件事不能等到 runtime 再临时拼

如果不这么做，运行时就必须直接面对一个更混乱的问题：

- 用户到底想用哪种风格调用
- 哪些方法应该暴露在 blocking stub 上
- 哪些应该暴露在 future stub 上
- 哪些应该是 responseObserver 入口

但 codegen 层的优势恰恰在于：

- 它已经知道每个 `.proto` 方法的 method type
- 它知道哪些调用风格在类型上应该长什么样
- 它可以在生成阶段就给用户一份稳定、类型安全的 API 外壳

于是运行时只需要做一件事：

- 把这些不同入口重新压回统一调用主线

所以三类 stub 的分化，本质上是：

- codegen 帮运行时提前做了用户入口装配

### Stub 工厂为什么和前面第一篇完全对得上

生成代码里每个 `newStub()` 实际上都是通过 `AbstractStub.StubFactory` 去 new 具体 stub 的，见：

- `compiler/src/test/golden/TestService.java.txt:274`
- `interop-testing/src/generated/main/grpc/io/grpc/testing/integration/TestServiceGrpc.java:270`

这和前面第一篇讲过的 `AbstractStub` / `AbstractBlockingStub` / `AbstractFutureStub` 主线完全对上了。

也就是说，第一篇讲的是：

- 运行时里，stub 是怎样持有 `Channel + CallOptions`

而本篇补出来的是：

- 这些具体 stub 入口，原来在 codegen 层就已经被稳定生成好了

所以从卷内结构上说，这篇不是推翻第一篇，而是把第一篇往上游再接了一层。

### 真实生成产物说明这不是测试样板，而是正式 API 外壳

如果只看 compiler golden，容易误以为那是“为了测试生成器的样板文本”。

但 `interop-testing/src/generated/main/grpc/io/grpc/testing/integration/TestServiceGrpc.java` 已经是仓库里真实保留下来的生成产物样本，它同样具有完整的：

- 方法 descriptor
- stub 工厂
- `AsyncService`
- `ImplBase`
- `MethodHandlers`
- `bindService()`

见 `interop-testing/src/generated/main/grpc/io/grpc/testing/integration/TestServiceGrpc.java:12`。

这里要特别控一下边界：它毕竟位于 `interop-testing`，不是业务项目源码目录本身，也不是 grpc-java 运行时手写维护的核心类；它的价值在于，**它是仓库中可直接核验的真实 codegen 样本**，能拿来对照 golden 文件，证明这些骨架并不是测试想象出来的模板，而是 protoc 在真实工程场景里会稳定产出的标准结构。

所以第二层可以先收一句：

- 三类 Stub 不是 runtime 临时长出来的，而是 codegen 层预先生成好的类型化用户入口

## 第三层：`AsyncService` / `ImplBase` 为什么不是“方便继承”的模板，而是服务端入口桥

如果说 stub 工厂解释的是“客户端入口怎么生成”，那 `AsyncService` / `ImplBase` 解释的就是：

- 服务端应用入口怎么接回 runtime 主线

在真实 `TestServiceGrpc` 里，生成代码不会只给你一个 `ImplBase`，而是先给出：

- `AsyncService` 接口
- 再给出 `ImplBase implements BindableService, AsyncService`

见 `interop-testing/src/generated/main/grpc/io/grpc/testing/integration/TestServiceGrpc.java:332`。

这一步特别值钱。

因为它说明 grpc-java 这里不是简单地“给你一个抽象基类继承一下”，而是先把服务端应用入口分成了两层：

- `AsyncService`：真正的服务方法契约面
- `ImplBase`：把这个契约进一步接进 grpc-java 服务端装配体系

### 默认未实现行为为什么重要

`AsyncService` 的默认方法里，不是空实现，而是统一走：

- `ServerCalls.asyncUnimplementedUnaryCall(...)`
- `ServerCalls.asyncUnimplementedStreamingCall(...)`

见 `interop-testing/src/generated/main/grpc/io/grpc/testing/integration/TestServiceGrpc.java:341` 及后续。

这件事非常能说明生成代码层的真正职责。

因为它意味着：

- codegen 不是只生成一个“方法签名目录”
- 它还为服务端未实现行为提供了统一协议兜底

也就是说，即使用户只继承 `ImplBase` 但没有重写某个方法，生成骨架也已经知道：

- 这个方法在协议上应该怎样返回“未实现”

这已经不是“方便继承”那么简单，而是：

- **把服务端契约语义一起装配进骨架**

### `ImplBase` 真正值钱的不是继承，而是它把用户实现接上 `bindService()`

`ImplBase` 本身最关键的一句其实是：

- `public final ServerServiceDefinition bindService() { return TestServiceGrpc.bindService(this); }`

见 `interop-testing/src/generated/main/grpc/io/grpc/testing/integration/TestServiceGrpc.java:167`。

这说明 `ImplBase` 的真正价值，不是“少写几个接口声明”，而是：

- 它保证用户的服务实现，能被统一地接回 `bindService()` 这条服务端装配链

也就是说，codegen 在这里替你完成的是：

- 服务方法实现 -> 服务端定义对象

这正是第二篇运行时主线前面缺的那一段桥。

所以如果读者只看第二篇，不看这一篇，就会知道：

- 服务端最后是 `ServerCallHandler.startCall(...)`

但他还是不知道：

- 自己平时写的 `ImplBase`，是怎样真正变成那个 `ServerCallHandler` 的

本篇就是专门把这段桥补上。

## 第四层：`MethodHandlers` / `bindService()` 为什么是最关键的 glue，而不是样板细节

现在来到整篇最容易被误看成“生成样板杂音”的一段：

- `MethodHandlers`
- `bindService()`

恰恰是这里，codegen 层和 runtime 主线才真正合龙。

### `MethodHandlers` 不是噪音，它是“方法号 -> 调用语义”分派器

在真实 `TestServiceGrpc` 里，`MethodHandlers<Req, Resp>` 会根据 method id，把不同的调用导向：

- unary / server-streaming 的 `invoke(request, responseObserver)`
- client-streaming / bidi-streaming 的 `invoke(responseObserver)` 返回 request observer

见 `interop-testing/src/generated/main/grpc/io/grpc/testing/integration/TestServiceGrpc.java:917`。

这说明 `MethodHandlers` 真正干的事情是：

- 把 codegen 时已经知道的方法契约
- 精确转换成 runtime 层需要的调用分派形态

也就是说，它不是“为了减少重复代码而自动生成的 switch”，而是：

- **服务方法契约落回 `ServerCalls` 主线时的最后一层分派桥**

### `bindService()` 真正装的是 `ServerServiceDefinition`

再看 `bindService()`。

它不是简单收集方法名，而是：

- `ServerServiceDefinition.builder(...)`
- `.addMethod(getXxxMethod(), new MethodHandlers<>(...))`

把所有方法装进一个正式的 `ServerServiceDefinition`

见 `interop-testing/src/generated/main/grpc/io/grpc/testing/integration/TestServiceGrpc.java:999`。

这一步是整篇文章最该牢牢记住的一个点。

因为它说明：

- 从 `.proto` 过来的 service 契约，最后不是直接变成“几个 Java 方法”
- 而是变成一份 runtime 真正认识的服务定义对象

里面已经同时包含了：

- 方法 descriptor
- 调用类型
- 服务端 handler glue

也就是说，`bindService()` 是：

- **用户服务实现真正接进 grpc-java 服务端运行时的正式入口**

如果缺这一步，前面第二篇服务端主线就会一直悬空半截。

### 为什么这一层正好把前两篇主线真正接上了

现在可以把前面两篇和这一层重新合起来看。

- 第一篇讲的是：客户端真正会进入 `ClientCall`
- 第二篇讲的是：服务端最终会走到 `ServerCalls` / `ServerCallHandler`
- 本篇补的是：这些入口和出口，并不是用户直接手写出来的，而是 `*Grpc` 骨架先装出来的

于是“用户契约怎样接到主干运行时”这条链，第一次真正闭环：

```text
.proto
  -> MethodDescriptor
  -> Stub / AsyncService / ImplBase
  -> ClientCalls / ServerCalls
  -> ClientCallImpl / ServerCallImpl
```

这里要刻意控一下力度：这还不是 grpc-java 整卷所有运行时都闭环了，因为调用真正发出去之后，后面还要继续接第三、第四篇已经建立的横切面协议与 NameResolver / LoadBalancer / transport 桥；但至少到这里为止，**用户写下的 `.proto` 契约，已经不再悬空，而是正式接回了主干运行时骨架。**

## 第五层：lite / full codegen 差异为什么不能只当依赖名区别

最后再补一个特别容易被轻视的点：

- protobuf-lite 和 full protobuf

很多人平时只会记住：

- full 用 `grpc-protobuf`
- lite 用 `grpc-protobuf-lite`

但从生成骨架角度看，这不只是依赖名区别。

### 生成骨架里的 marshaller 就已经不同

在 full golden 文件里，生成代码写的是：

- `ProtoUtils.marshaller(...)`

而在 lite golden 文件里，生成代码写的是：

- `ProtoLiteUtils.marshaller(...)`

见：

- `compiler/src/test/golden/TestService.java.txt:40`
- `compiler/src/testLite/golden/TestService.java.txt:37`

这说明从 codegen 层开始，grpc-java 就已经把：

- 目标消息运行时是 full 还是 lite

烘进了骨架本身。

所以 lite / full 的区别不是“后面运行时自己适配一下”这么简单，而是：

- 用户契约从被编出来的那一刻起，就已经进入了不同的 marshaller 桥接路径

### 为什么这也属于装配桥的一部分

方法论特别强调，完整卷不能只盯着主干运行时，也要讲清楚：

- 外部配置 / 外部契约怎样映射到内部结构

lite / full 差异恰恰就是这种映射的一个典型例子。

它说明：

- 同样的 `.proto` 契约
- 在不同运行时目标下
- 生成出来的 grpc-java 骨架并不完全一样

所以这一点虽然不是主干，但它绝对不是注脚，仍然属于 codegen 装配桥的一部分。

## 最后把整条 codegen 主线收回来：为什么 `*Grpc` 不是噪音，而是 grpc-java 的装配桥

现在可以把整篇文章的主线收回来了。

如果只记一句最短的人话答案，那就是：

**`protoc-gen-grpc-java` 生成的 `*Grpc` 文件，不是样板噪音，而是 `.proto` 契约进入 grpc-java 主干运行时的第一座装配桥：它先把方法契约压成 `MethodDescriptor`，再生成客户端 Stub 入口、服务端 `AsyncService` / `ImplBase` 骨架，以及 `MethodHandlers` / `bindService()` 这些 glue，把用户定义精确接回前四篇已经建立好的主干运行时主线。**

把它拆开，就是四层非常稳定的分工。

### 第一层：`MethodDescriptor` 负责把 `.proto` 契约稳定成 runtime 可识别的方法骨架

- method type
- full method name
- marshaller
- tracing / safe / idempotent 等属性

### 第二层：Stub 工厂负责生成用户侧不同调用风格入口

- async stub
- blocking stub
- future stub

它们在 codegen 层先分化，在 runtime 层再统一收束。

### 第三层：`AsyncService` / `ImplBase` 负责生成服务端应用入口骨架

- 默认未实现行为
- 服务方法契约面
- 与 `bindService()` 的统一接桥

### 第四层：`MethodHandlers` / `bindService()` 负责把契约真正接进 grpc-java runtime

- 把方法类型分派回 `ServerCalls`
- 把全部方法装成 `ServerServiceDefinition`

## 这篇先立住的，不是生成器实现细节，而是 grpc-java 的“契约到运行时”装配桥

到这里为止，这篇文章故意没有展开很多你已经能想到的线：

- `ManagedChannelBuilder` / `ServerBuilder` 还会怎样继续装配
- `Marshaller` / `ProtoUtils` 还能怎样继续深挖
- Spring / Boot / Cloud 如何继续套在上层
- 非 protobuf 的 binding 怎样接入

不是这些不重要，而是如果不先把 **codegen 骨架作为装配桥** 立住，前面四篇运行时主线和用户实际接触到的 `*Grpc` 文件之间，就会永远隔着一层黑箱。

所以这篇真正要留下来的心智模型只有一条：

```text
.proto 不会直接变成运行时
它先变成 *Grpc 骨架
*Grpc 骨架再把用户入口接回 grpc-java runtime 主线
```

只要这条线立住，后面再去看 builder 装配层、Marshaller 深挖、InProcess 测试桥或 services / xDS / 生产层，读者脑中就已经有了“用户契约是怎样被真正装进去的”这块地基。

而这，也正是 grpc-java 完整卷重新规划后，最适合作为第二组第一篇留下来的装配桥正文。