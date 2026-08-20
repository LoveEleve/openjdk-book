# 为什么认证不能只靠 ClientInterceptor 塞 header：grpc-java 的 CallCredentials 与调用前凭证门

> 本文基于 `grpc-java v1.83.1` 当前源码。前面的横切面篇已经讲过 `ClientInterceptor` 怎样在调用边界挂入 metadata；本篇继续补完整卷里的机制补深层：为什么 grpc-java 官方在 `ClientInterceptor` 的注释里明确说“提供认证凭证更好用 `CallCredentials`”，而不是让每个人都自己写一个 interceptor 往 header 里塞 token。重点放在 `CallCredentials`、`CallOptions.withCallCredentials`、`AbstractStub.withCallCredentials`、`CallCredentialsApplyingTransportFactory`、`RequestInfo`、`MetadataApplier`，以及它和 `ClientInterceptor` 的职责边界；不展开 TLS/mTLS/OAuth/JWT 的生态细节。

## 为什么认证不能只靠“interceptor 给 header 加个 token”

在横切面篇里，我们已经建立过一个重要结论：

- 只要你想在客户端调用上插入通用横切逻辑，`ClientInterceptor` 是一个很好的边界
- 它能改 metadata、能包 `ClientCall`、能观察回包

你可能马上就想到一个很自然的用法：

- 写一个 `ClientInterceptor`
- 在每个调用的 header 里塞一个认证 token
- 完成认证

这个做法在小型 demo 里确实“能跑”。

但 grpc-java 官方对这件事的态度非常明确，`ClientInterceptor` 的注释里直接写了一句很关键的话：

- 提供 authentication credentials 这件事，由 `CallCredentials` 来服务更好
- 当然，`ClientInterceptor` 也可以在 `CallOptions` 里设置 `CallCredentials`

见 `api/src/main/java/io/grpc/ClientInterceptor.java:31`。

这不是官方在故作矜持，而是在提醒一个更根本的问题：

- 认证不是一个普通的 metadata 拼接问题
- 它需要更多面向本次调用的结构化信息
- 它可能需要异步获取凭证
- 它需要明确“这次调用的凭证门到底过没过”
- 并且它还要和处理每次 RPC 的生命周期与失败路径正确对齐

这些都不适合塞进一个“通用 interceptor”里。

所以本文真正要回答的问题不是：

- grpc-java 有没有认证机制
- `CallCredentials` 怎么用

而是：

**为什么 grpc-java 必须把“每次 RPC 的凭证生成”单独设计成 `CallCredentials`，而不是把它继续压进 `ClientInterceptor` 那个通用横切面里。**

## 先看失败方案：为什么认证不能直接在 interceptor 里硬编码

### 失败方案一：认证用 ClientInterceptor 往 header 塞 token 就行

这是最自然、也最容易踩的坑。

因为从表面看，认证确实只是“在请求里加一个 header”。

但一旦你真的把认证写成一个普通 interceptor，很快就会发现它缺很多能力：

- 它不知道该调用的 method、authority、security level
- 它不知道该 transport 是什么
- 它没有“认证头还没准备好，请等一下再建流”的原生表达
- 它也没有“认证失败，请把这通调用以这个 status 收口”的强制出口

所以在真实场景里，interceptor 做认证很容易变成：

- 在错误的位置塞 header
- 在错误的时机获取 token
- 缺少安全等级判定
- 无法优雅收口失败

### 失败方案二：CallCredentials 只是 metadata utils，和 interceptor 等价

另一种误区，是承认 `CallCredentials` 存在，但觉得它只是“另一处写 metadata 的地方”。

这会忽略它真正区别于 interceptor 的地方：

- 它有自己的 `RequestInfo`
- 它有自己的 `appExecutor`
- 它通过 `MetadataApplier` 异步放行
- 它可以组合成 `CompositeCallCredentials`
- 它还和 channel 级 / per-call 级凭证的组合语义绑定

所以它不是“metadata utils”，而是：

- **一套专门处理每次 RPC 凭证生成的异步机制**

### 失败方案三：安全等级无所谓，认证只是加头

还有一种特别容易被忽视的问题，是忽略 `RequestInfo` 里那些面向安全决策的信息。

真实认证经常不是：

- 无脑加一个 token

而是：

- 先看当前 transport 是不是足够安全
- 这次调用的 authority 是不是可信
- 当前是什么安全等级
- 该用什么凭证策略

这些信息都放在 `RequestInfo` 里。

如果在 interceptor 里硬写认证，很多这些信息你就拿到得很别扭，甚至根本拿不到。

### 失败方案四：认证失败就在某个中间层抛异常

还有一种错误理解：

- 凭证生成了就 OK
- 凭证生成失败就抛异常

问题在于，grpc-java 需要的不是简单地 throw。

它需要：

- 这个 RPC 在真正建流前被 `MetadataApplier.fail(status)` 收口
- 最终这通调用以明确的失败状态 close 给调用方

如果只是原地抛异常，call/listener/transport/context 的收尾就很难对齐。

## 先立最小总图：凭证生成门到底插在哪一段调用前链里

如果先不抠细节，最值得先记住的是：`CallCredentials` 不是调用链末尾的旁路工具，而是插在“调用已经进入 channel，但 stream 还没真正建到 transport 上”之前的一道异步门。

```text
stub.withCallCredentials(creds)
  -> CallOptions
  -> CallCredentialsApplyingTransportFactory
  -> applyRequestMetadata(RequestInfo, appExecutor, applier)
  -> applier.apply(headers) or applier.fail(status)
  -> create/continue stream
```

如果换成人话，这条线其实只发生了四件事。

第一，**凭证先被挂进 CallOptions**。

第二，**真正要建 transport stream 的 factory 发现这次调用带了 credentials**。

第三，**它会先让 credentials 生成“本 RPC 的凭证 metadata”**，并且这个生成可以是异步的。

第四，**只有 applier 被调用之后，这次 RPC 才会真正继续建流；如果 applier 走的是 fail(path)，这通调用就以失败收口。**

所以认证在这里不是“发请求时顺手加个头”，而是：

- **调用真的往前走之前，必须先通过的一道凭证门**

## 第一层：`CallCredentials` 为什么天然是每-RPC 的凭证生成模型

`CallCredentials` 的类注释一开始就写得很清楚：

- 它携带 credential data
- 这些数据会通过 request metadata 在每次 RPC 时传给 server

见 `api/src/main/java/io/grpc/CallCredentials.java:21`。

这里最值得注意的词是：

- per each RPC

也就是说，`CallCredentials` 从设计上就不是“一次配置、永远不变”，而是：

- 每次 RPC 都可能需要生成一份凭证 metadata

这也是它区别于 interceptor 的一个关键。

### `applyRequestMetadata(...)` 为什么是异步凭证生成口

`CallCredentials` 的核心方法只有一个：

- `applyRequestMetadata(RequestInfo, Executor appExecutor, MetadataApplier applier)`

见 `api/src/main/java/io/grpc/CallCredentials.java:40`、`:55`。

这个方法说明：

- 凭证不是调用发生时“同步读出来就用”
- 而是可能要通过网络、OAuth flow 等方法异步获取
- 获取完成后，通过 `applier` 把结果喂回 gRPC

所以它天然承担：

- 每-RPC 的异步凭证生成语义

### 为什么要给 credentials 一个 app executor

方法签名里的 `appExecutor` 不是随便加的。

它的意思是：

- 如果 credentials 实现需要做阻塞操作（比如网络获取 token）
- 它不应阻塞当前调用链
- 而应在这个 executor 上异步执行
- 完成后再由 applier 回调

见 `api/src/main/java/io/grpc/CallCredentials.java:45`。

这说明 `CallCredentials` 和调用异步边界是紧密耦合的，不是简单的同步 helper。

## 第二层：`RequestInfo` 为什么给凭证生成器提供结构化决策信息

`CallCredentials.RequestInfo` 是这次调用在凭证决策这一侧看到的“世界是什么”的抽象。

它提供：

- `getMethodDescriptor()`
- `getCallOptions()`
- `getSecurityLevel()`
- `getAuthority()`
- `getTransportAttrs()`

见 `api/src/main/java/io/grpc/CallCredentials.java:86`。

这说明 gRPC 在这里认为：

- 正确的认证决策，不能只看“method 叫什么”
- 还要看调用 options、安全等级、authority、transport attributes

这些信息在 interceptor 里虽然也可能拿到一部分，但在 `CallCredentials` 里是被结构化、显式地交给凭证决策者的。

所以 `RequestInfo` 的价值是：

- 让认证逻辑看到“这次调用在安全视角下是什么样”

## 第三层：`MetadataApplier` 为什么是唯一出口，并且 RPC 必须等它

`MetadataApplier` 是两个方法的抽象：

- `apply(Metadata headers)`
- `fail(Status status)`

见 `api/src/main/java/io/grpc/CallCredentials.java:73`。

类注释还特别强调：

- 非线程安全
- 必须且只能调用其中一个
- RPC 只有在这之后才会继续

见 `api/src/main/java/io/grpc/CallCredentials.java:68`。

这说明它不是一个“可选的 metadata 出口”，而是：

- 一次调用能否继续往前的强制性门

如果 printer 没有在正确时机调用 `apply()` 或 `fail()`，这次 RPC 就不会继续建流。

所以 `MetadataApplier` 就是本篇里那扇“认证门”的物理载体。

### 成功路径

当凭证生成成功时，`apply(headers)` 会把这次调用产生的凭证 metadata 合并进原始 headers。

这是调用继续前进的入口。

### 失败路径

当凭证生成失败时，`fail(status)` 会把这次调用以明确的 `Status` 收口。

这正是上一篇消息对象桥和客户端主线里反复强调的“失败必须回到统一 status 语义”的延续。

## 第四层：`CallOptions` 怎样把 credentials 带进调用

`CallOptions` 内部持有：

- `CallCredentials credentials`

见 `api/src/main/java/io/grpc/CallOptions.java:65`。

并通过：

- `withCallCredentials(credentials)` 设置
- `getCredentials()` 读取

见 `api/src/main/java/io/grpc/CallOptions.java:139`、`:284`。

这说明 `CallCredentials` 不是 channel 全局状态，而是：

- 一个具体调用可独立携带的调用选项

也是 `AbstractStub.withCallCredentials(...)` 最终实现的落点：

- `build(channel, callOptions.withCallCredentials(credentials))`

见 `stub/src/main/java/io/grpc/stub/AbstractStub.java:224`。

所以从用户入口开始，credentials 就已经进入了不可变调用的语义链条。

## 第五层：`CallCredentialsApplyingTransportFactory` 怎样把凭证真正压到 transport 前

真正让凭证在实际运行时生效的，往往是 `CallCredentialsApplyingTransportFactory`。

这个 factory 会把每个 transport 包一层包装，见 `core/src/main/java/io/grpc/internal/CallCredentialsApplyingTransportFactory.java:43`、`:83`。

### 它会在新建 stream 前检查 CallOptions 里的 credentials

真正关键的是它的 apply 逻辑。

它会先看 `callOptions.getCredentials()`：
- 如果为 null，就用 channel 级 credentials
- 如果 channel 级也有，就对二者做 `CompositeCallCredentials`

见 `core/src/main/java/io/grpc/internal/CallCredentialsApplyingTransportFactory.java:117`。

这构成了一个很有用的政策：

- per-call credentials 优先
- 如果没有，则回退 channel 级
- 两者都有，则组合使用

### 它怎么把 `RequestInfo` 和 app executor 传进去

这个方法里会构造：

- `RequestInfo`
- `MetadataApplierImpl`
- 并把 app executor 传给 `applyRequestMetadata(...)`

见 `core/src/main/java/io/grpc/internal/CallCredentialsApplyingTransportFactory.java:124`、`:130`。

也就是说，在真正的新 stream 创建动作发生前，factory 已经悄悄完成了：

- 找出本次调用凭证
- 组合 channel/per-call
- 启动 `applyRequestMetadata`
- 等待 `MetadataApplier` 结果

因此它完美承担了“调用前凭证门”的执行者角色。

### `MetadataApplierImpl` 会怎样把结果送回调用

真正在 gRPC 里等待 credentials 结果并继续调用的是 `MetadataApplierImpl`，见 `core/src/main/java/io/grpc/internal/MetadataApplierImpl.java:33`、`:54`。

它让：

- `apply(headers)` -> headers 合并 -> 调用继续
- `fail(status)` -> 调用以该 status 失败收口

所以整条调用前凭证门，从 API 层到最后执行者，是连通的。

## 第六层：channel 级与 per-call 级凭证为什么会组合

`CallCredentials` 不只是一对一存在，还支持：

- `CompositeCallCredentials`
- `CompositeChannelCredentials`

见：

- `api/src/main/java/io/grpc/CompositeCallCredentials.java:27`
- `api/src/main/java/io/grpc/CompositeChannelCredentials.java:22`

前者允许：

- 把多个 per-RPC 凭证组合成一个
- 并且如果第一个凭证失败，会影响整个组合的结果

后者允许：

- channel 级 credentials 与 per-call credentials 一起被考虑

这都说明：

- 凭证不是单一静态字符串
- 而是一套可组合的调用安全语义

`Context` 和 async 也在这个组合过程中被保留，所以它不是简单合并 header，而是真正把每次凭证生成组织成一条可失败、可组合的前置链。

## 第七层：`CallCredentials` 和 `ClientInterceptor` 的职责边界在哪里

现在可以明确把两者拆开了。

### `ClientInterceptor` 适合通用横切

`ClientInterceptor` 适合：

- logging
- monitoring
- metadata 观察
- request/response rewriting
- 通用调用边界逻辑

见 `api/src/main/java/io/grpc/ClientInterceptor.java:21`。

它更像是调用链上的通用 filter，不一定天然理解：

- 凭证生成
- 安全等级
- authority
- transport attrs

### `CallCredentials` 适合认证语义

`CallCredentials` 适合：

- per-RPC 凭证生成
- 异步获取 token
- 组合多个凭证
- 失败以 status 收口
- 和安全等级/authority/transport attrs 结合决策

见 `api/src/main/java/io/grpc/CallCredentials.java:21`。

它不是“另一个 metadata interceptor”，而是一道专门的调用前凭证门。

所以官方注释说得很准确：

- 认证最好由 `CallCredentials`
- `ClientInterceptor` 只需要保留通用横切职责就够了

## 最后把整条 CallCredentials 主线收回来

现在可以把整篇文章的主线收回来了。

如果只记一句最短的人话答案，那就是：

**`CallCredentials` 不是另一个 metadata header helper，而是 gRPC 里专门负责“每次 RPC 异步凭证生成门”的机制：它通过 `CallOptions` 进入调用，由 `CallCredentialsApplyingTransportFactory` 在真正建流前触发 `applyRequestMetadata()`，再靠 `MetadataApplier.apply()/fail()` 决定这通调用是继续前进还是以失败收口。**

把它拆开，就是四层稳定职责。

### 第一层：`CallCredentials` 负责每-RPC 的异步凭证生成

- `applyRequestMetadata(RequestInfo, appExecutor, applier)`
- 允许阻塞 token 获取在 app executor 上进行

### 第二层：`RequestInfo` 负责给凭证决策提供安全视角

- method / authority / security level / transport attrs

### 第三层：`MetadataApplier` 负责成为调用前的强制出口

- `apply(headers)` 放行
- `fail(status)` 收口

### 第四层：`CallCredentialsApplyingTransportFactory` 负责把凭证真正压到 transport 前

- 读取 per-call credentials
- 组合 channel/per-call
- 触发异步凭证门

## 这篇先立住的，不是 token 怎么写，而是认证的运行时边界

到这里为止，这篇文章故意没有展开：

- OAuth/JWT 具体流程
- mTLS/ALTS 全量机制
- 各种认证框架生态
- server 端认证处理

不是这些不重要，而是如果不先把 `CallCredentials` 作为“调用前异步凭证门”立住，前面的 interceptor 篇和后面的安全/生产层之间，就会缺一块非常关键的认证机制骨架。

所以这篇真正要留下来的心智模型只有一条：

```text
认证不是往 header 塞 token
认证是通过“每-RPC 异步凭证门”决定这次调用能否继续
```

只要这条线立住，后面再去看具体的 OAuth、JWT、mTLS 或安全排障，读者就有了一张能区分“interceptor 该干什么、CallCredentials 该干什么”的运行时总图。