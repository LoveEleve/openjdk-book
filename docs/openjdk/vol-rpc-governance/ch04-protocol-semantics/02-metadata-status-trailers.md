# grpc-java：Metadata、Status 与 Trailers — 一次 RPC 的三段式元数据

> 基于 grpc-java v1.83.1

## 一、困惑开场：为什么有一部分元数据要在最后才到

假设你要排查一个 gRPC 线上问题。客户端报了一个 `Status.INTERNAL`，`onClose()` 回调里传进来两个参数：一个 `Status` 和一个 `Metadata`。你打开这两个对象，发现 `Status` 里有一个 code、一个 description 和一个 stack trace；`Metadata` 里有一堆 key-value 对。看起来都很合理。

但如果你再深入一点，会开始困惑。这个 `Metadata` 里装的到底是什么？它和客户端发请求时传给 `ClientCall` 的 headers 是同一个东西吗？如果服务端是通过 `onError(Throwable)` 结束调用的，那 `onClose()` 里拿到的 `Metadata` 是从哪来的？`grpc-status` 和 `grpc-message` 这两个 key 在整个协议里承担什么角色？

这些问题的答案，藏在 gRPC 协议对一次 RPC 元数据的三段式划分里：**headers**（流开始时）、**Status**（流结束时）、**trailers**（流结束时）。这三段不是随意的组织结构，它们各自有明确的协议语义和生命周期。

## 二、前情回顾：主干篇里的 Status 已经在工作

在 ch01 的主干篇中，我们已经反复见过 `Status` 和 `Metadata`：

- 客户端侧，`ClientCall.listener.onClose(Status status, Metadata trailers)` 在调用结束时被调用。
- 服务端侧，`ServerCallImpl.close(Status status, Metadata trailers)` 在 handler 完成时被调用。
- 在 ch04/01 方法契约篇中，我们已经见过 `Status.INTERNAL` 和 `Status.CANCELLED` 这些值。

但主干篇只在"调用结束"这个点上用到它们，没有解释这个点前后发生了什么——`close()` 里的 Status 是怎么编码进协议的？`onClose()` 里拿到的 Status 是怎么从协议解码出来的？trailers 参数在整个传播链路中扮演什么角色？本篇就是要补上这一层。

## 三、先走三条失败的路

### 失败方案一：Metadata 就是 headers，Status 就是错误码

最容易想到的理解是：Metadata 就是 HTTP 里的 headers，Status 就是返回的错误码。两者独立，Metadata 在请求开始就发，Status 在响应结束才回。

这种理解有两个偏差。

第一，Metadata 不只出现在 headers 里。gRPC 的 Metadata 可以出现在两个位置：流开始的 headers，和流结束的 trailers。服务端在 `close()` 时返回的 Metadata 是 trailers，不是 headers。你在 `onClose()` 里拿到的 `Metadata trailers` 参数，正是这段流结束时的元数据。

第二，Status 不是简单的错误码。它是一个对象，包含 code、description 和 cause 三个字段。code 只是其中的一部分。而且 Status 不是通过响应体传输的，它是被序列化进 trailers 的两个标准 key（`grpc-status` 和 `grpc-message`）里的。

### 失败方案二：Status 通过 headers 发送就够了，不需要 trailers

你可能会想：既然 headers 在流一开始就发送，那 Status 放到 headers 里发不就行了？客户端能更早知道结果。

问题是，对于 streaming 响应，服务端是边处理边发消息的。服务端在发送第一条消息时，可能还没决定最终结果——它可能在处理过程中才遇到错误。如果 Status 提前放在 headers 里，那后面流中途出错时，headers 里的 Status 就已经过期了。

所以 gRPC 协议规定：**Status 必须通过 trailers 发送**，也就是在流结束时发送。这样保证了客户端收到的 Status 是最终、确定的，不会因为流中途的状态变化而失效。

### 失败方案三：Metadata 的 key 就一种类型，不需要分成 ASCII/Binary

如果你只处理过字符串类型的元数据，可能会觉得 Metadata 的 key 就是"字符串 key → 字符串值"这种简单结构，不需要什么 ASCII/Binary 之分。

但想一想：如果我想在 Metadata 里放一个二进制 token 呢？HTTP/2 的 header 值是 ASCII 字符，不能直接塞二进制字节。解决方案是 base64 编码——把二进制编码成 ASCII 字符串再传输。

gRPC 没有把这个逻辑硬编码进每个使用者，而是把"谁需要 base64"这个决定做进了 `Metadata.Key<T>` 类型系统：`AsciiKey` 直接存 ASCII 字符串，`BinaryKey`（key 名以 `-bin` 结尾）自动 base64 编码/解码。使用 `Key.of(String, BinaryMarshaller)` 创建 Binary key，值会被自动处理。

## 四、最小总图：一次 RPC 的三段式元数据

在进入具体实现之前，先建立一张总图。

一次 gRPC RPC 的元数据按生命周期分为三段：

```
时间线 →

[1. headers] ──> [消息体（可能多条）] ──> [2. trailers 含 Status]
   ▲                                        ▲
   协议参数                               最终状态
   content-type/te/timeout/encoding        grpc-status/grpc-message
   应用自定义 headers                     应用自定义 trailers
```

- **headers**：流开始时发送。携带协议参数（`content-type`、`te`、`grpc-timeout`、`grpc-encoding`）和应用自定义的请求元数据（如鉴权 token）。
- **消息体**：一个或多个 gRPC 消息（通过方法类型契约决定数量）。
- **trailers**：流结束时发送。携带最终状态（`grpc-status`、`grpc-message`）和应用自定义的响应元数据。

三个核心概念在这个图中各居其位：`Metadata` 是 key-value 容器，同时覆盖 headers 和 trailers；`Status` 是通过 trailers 中的两个标准 key 传输的最终结果；`Trailers` 是承载 Status 的元数据段。

下面分层拆解。

## 五、Metadata：key-value 容器与 key 类型

### 5.1 内部是怎么存的

`Metadata` 的内部存储比"HashMap"要特殊。它不是用一个 `Map<String, List<byte[]>>`，而是用了一个 `Object[] namesAndValues` 数组，交错存储 key 和 value：`[name0, value0, name1, value1, ...]`。key 永远是 `byte[]`（ASCII 编码），value 可能是 `byte[]` 或 `LazyValue<?>`（延迟序列化的值）。

`Metadata.java:150` — `namesAndValues` 内部存储结构

为什么不用 HashMap？因为 Metadata 的首要目标不是查找，而是序列化——它最终要被转换成 HTTP/2 的 header 块发送出去。数组结构对序列化更友好，不需要经过 Map 的遍历和转义。

`Metadata.java:248` — `get(Key<T>)` 方法：返回最后一个匹配的值
`Metadata.java:342` — `put(Key<T>, T)` 方法：追加一个键值对
`Metadata.java:402` — `removeAll(Key<T>)` 方法：移除所有匹配的值

### 5.2 Key 的类型系统

`Key<T>` 是 Metadata 的核心设计。它是一个抽象类，定义了 key 的名字（`name`，小写 ASCII），以及序列化/反序列化的抽象方法。

`Metadata.java:671` — `Key<T>` 抽象类定义

创建 Key 时，有两个工厂方法，对应两种 key 类型：

- `Key.of(String, AsciiMarshaller<T>)`：创建一个 ASCII key。
- `Key.of(String, BinaryMarshaller<T>)`：创建一个 Binary key。

`Metadata.java:682` — `Key.of(String, BinaryMarshaller)` 工厂方法
`Metadata.java:703` — `Key.of(String, AsciiMarshaller)` 工厂方法

### 5.3 AsciiKey：直接存可见字符

`AsciiKey` 用于存 ASCII 字符串值。它的 `toBytes()` 把值编码成 US-ASCII 字节，`parseBytes()` 把字节解码回字符串。

`Metadata.java:966` — `AsciiKey<T>` 内部类

`AsciiMarshaller<T>` 定义了两个方法：`toAsciiString(T)` 和 `parseAsciiString(String)`。值被限制为可见 ASCII 字符（0x20-0x7E）。

`Metadata.java:599` — `AsciiMarshaller<T>` 接口

### 5.4 BinaryKey：-bin 后缀 + base64

`BinaryKey` 用于存任意的二进制值。它的名字必须以 `-bin` 结尾，值通过 HTTP/2 传输时自动 base64 编码。

`Metadata.java:859` — `BinaryKey<T>` 内部类

`BinaryMarshaller<T>` 定义了 `toBytes(T)` 和 `parseBytes(byte[])` 两个方法——不经过 String，直接操作字节数组。

`Metadata.java:568` — `BinaryMarshaller<T>` 接口

### 5.5 Key 命名规则

`validateName()` 定义了 key 命名的合法性：字符必须是 `[a-z0-9._-]`，且只能是小写。如果有大写字母，`Key` 构造器会把它改成小写。

`Metadata.java:736` — `validateName()` 方法

有 `-bin` 后缀的是 Binary key，其余的是 ASCII key。`BinaryKey` 构造器会检查名字必须以 `-bin` 结尾，`AsciiKey` 构造器会检查名字不能以 `-bin` 结尾。

## 六、Status：15 个标准码与三种构造方式

### 6.1 15 个标准码

Status 的核心是 `Status.Code` 枚举，定义了 15 个标准码（外加一个 UNKNOWN 兜底）。每个码有一个数字值（0-16）和一个语义描述：

```
OK                0   成功
CANCELLED         1   被调用方取消
UNKNOWN           2   未知错误
INVALID_ARGUMENT  3   参数非法
DEADLINE_EXCEEDED 4   超时
NOT_FOUND         5   未找到
ALREADY_EXISTS    6   已存在
PERMISSION_DENIED 7   权限拒绝
RESOURCE_EXHAUSTED 8  资源耗尽
FAILED_PRECONDITION 9  前置条件不满足
ABORTED           10  操作被中止
OUT_OF_RANGE      11  超出范围
UNIMPLEMENTED     12  未实现
INTERNAL          13  内部错误
UNAVAILABLE       14  服务不可用
DATA_LOSS         15  数据丢失
UNAUTHENTICATED   16  未认证
```

`Status.java:65` — `Status.Code` 枚举（OK=0 到 UNAUTHENTICATED=16）

这些码不是随意编号的。它们构成一个有语义的层次：0-3 是通用的调用问题，4-11 是特定业务逻辑问题，12-16 是服务端环境问题。客户端可以通过 `Status.getCode()` 统一识别和处理。

`Status.java:237` — `STATUS_LIST` 规范实例

### 6.2 Status 对象的结构

`Status` 不是一个简单的枚举值，它是一个包含三个字段的不可变对象：`code`（枚举值）、`description`（人类可读的描述）、`cause`（Java 抛出的原因，只在本地存在，不传输）。

`Status.java:441` — `Status` 私有构造器

我们通常用 `Status.NOT_FOUND` 这种静态字段来引用标准码，但要附加描述时，用 `withDescription(String)` 或 `withCause(Throwable)` 创建新的实例。

`Status.java:455` — `withCause(Throwable)` 方法
`Status.java:466` — `withDescription(String)` 方法

### 6.3 三种使用方式

`Status` 通常以三种方式使用：

1. 服务端通过 `onError(Throwable)` 返回错误：grpc-java 会从 `Throwable` 里提取 Status。`Status.fromThrowable(Throwable)` 会遍历异常的 cause 链，找到第一个 `StatusException` 或 `StatusRuntimeException`，取出其中的 Status。

`Status.java:396` — `fromThrowable()` 方法

2. 客户端通过 `asRuntimeException()` 包装 Status 抛出：`StatusRuntimeException` 持有 Status 和可选 trailers。

`Status.java:523` — `asRuntimeException()` 方法
`StatusRuntimeException.java:26` — `StatusRuntimeException` 类

3. 通过 `Status.trailersFromThrowable(Throwable)` 提取异常中携带的 trailers，用于错误处理和日志。

`Status.java:416` — `trailersFromThrowable()` 方法

## 七、Trailers：为什么 Status 必须通过 trailers 发送

### 7.1 trailers 的协议语义

在 HTTP/2 中，headers 在流开始时发送（HEADERS frame），trailers 在流结束前发送（HEADERS frame with END_STREAM）。gRPC 使用这两段来承载不同生命周期的元数据。

trailers 的核心语义是：它总是最后到达。这意味着，trailers 只能和流的最终状态（Status）一起发送，不能提前。

### 7.2 Status 为什么必须放 trailers

回到失败方案二的问题：为什么不能把 Status 提前放到 headers？

因为对于 streaming 响应，服务端在发送第一条消息时可能还没决定最终结果。如果 Status 放在 headers 里，客户端在收到 headers 时就会认为调用已经结束——但此时流可能还在继续。

把 Status 放进 trailers 保证了：客户端只有在收到所有消息体之后，才会收到最终的 Status。这保证了消息体与状态的一致性。

### 7.3 服务端出口：addStatusToTrailers

当服务端调用 `ServerCall.close(Status, Metadata)` 时，最终会走到 `AbstractServerStream.close()`：

`AbstractServerStream.java:123` — `close(Status, Metadata)` 发送 trailers

这个方法分三步：关闭 framer（不再写消息体）→ `addStatusToTrailers()` 注入 Status → `writeTrailers()` 发送。

`addStatusToTrailers()` 是编码的关键一步：

```java
trailers.discardAll(InternalStatus.CODE_KEY);    // 去掉已有的 grpc-status
trailers.discardAll(InternalStatus.MESSAGE_KEY); // 去掉已有的 grpc-message
trailers.put(InternalStatus.CODE_KEY, status);   // 写入 grpc-status
if (status.getDescription() != null) {
    trailers.put(InternalStatus.MESSAGE_KEY, status.getDescription()); // 写入 grpc-message
}
```

`AbstractServerStream.java:138` — `addStatusToTrailers()` 注入 grpc-status/message

注意这里的 `put` 是追加：它先 discard 掉可能已存在的 `grpc-status`/`grpc-message`，再写入新的。这样保证最终状态不会被之前的慢发覆盖。

### 7.4 客户端入口：statusFromTrailers

客户端收到 trailers 时，`Http2ClientStreamTransportState.transportTrailersReceived()` 会调用 `statusFromTrailers()` 从 trailers 中提取 Status：

```java
private Status statusFromTrailers(Metadata trailers) {
    Status status = trailers.get(InternalStatus.CODE_KEY);   // 解析 grpc-status
    if (status != null) {
        String message = trailers.get(InternalStatus.MESSAGE_KEY);  // 解析 grpc-message
        if (message != null) {
            status = status.withDescription(message);
        }
        return status;
    }
    ...
}
```

`Http2ClientStreamTransportState.java:193` — `statusFromTrailers()` 提取 Status

这里有一个关键细节：`InternalStatus.CODE_KEY` 是一个 `Metadata.Key<Status>`，它的 marshaller（`StatusCodeMarshaller`）把 status 的 code 序列化成 ASCII 十进制字符串（如 `"0"` 对应 OK），反序列化时再解析回 `Status`。

`Status.java:560` — `StatusCodeMarshaller`（code 序列化）
`Status.java:572` — `StatusMessageMarshaller`（percent-encoding）

`grpc-message` 的值也经过特殊编码——非 ASCII 字符会被 percent-encoding 转义（如换行 `\u000A` → `%0A`），这样任意 Unicode 描述都能安全通过 HTTP/2 传输。

## 八、grpc- 预留 key 的剥离机制

### 8.1 为什么要预留 grpc- 前缀

gRPC 协议把 `grpc-` 前缀的 key 预留给自己使用：`grpc-status`、`grpc-message`、`grpc-timeout`、`grpc-encoding`、`grpc-accept-encoding` 等。

`GrpcUtil.java:99` — `TIMEOUT_KEY` 等预留 key 定义
`GrpcUtil.java:144` — `CONTENT_TYPE_KEY` 定义

这些 key 不属于应用层。它们是 gRPC 协议自身的参数，应用层代码不应该看到它们，也不应该使用 `grpc-` 前缀。

### 8.2 stripTransportDetails：把协议内部 key 剥离

客户端在把 trailers 交付给应用层 `onClose()` 之前，先调用 `stripTransportDetails()` 把 `grpc-status`、`grpc-message` 和 HTTP/2 的 `:status` 移除：

```java
metadata.discardAll(HTTP2_STATUS);        // :status
metadata.discardAll(InternalStatus.CODE_KEY);    // grpc-status
metadata.discardAll(InternalStatus.MESSAGE_KEY); // grpc-message
```

`Http2ClientStreamTransportState.java:255` — `stripTransportDetails()` 剥离 grpc- key

这意味着，应用层 `onClose()` 里拿到的 `Metadata trailers` 是"干净的"——不包含 `grpc-status` 和 `grpc-message`，只包含服务端自定义的 trailer key。而那些被剥离的 key，其值已经通过 `statusFromTrailers()` 被提取进 Status 对象了。

### 8.3 这个机制的完整性

所以完整的 Status 传播链路是：

```
服务端 ServerCall.close(status, trailers)
  → AbstractServerStream.addStatusToTrailers() 把 status 放进 grpc-status/grpc-message
  → writeTrailers() 发送
  → 客户端 transportTrailersReceived() 收到
  → statusFromTrailers() 把 grpc-status/grpc-message 提取成 Status 对象
  → stripTransportDetails() 把 grpc-status/grpc-message 从 trailers 里剥离
  → onClose(status, trailers) 交付给应用层
```

Status 和 trailers 在协议层是"互补"的关系：应用层看到的是被剥离了系统 key 的"干净"trailers，而 Status 对象已经携带了从系统 key 里解析出的 code 和描述。

## 九、收网总结

回到开头的困惑：`onClose(status, trailers)` 里的 `Metadata trailers` 到底是什么？

它是流结束时服务端发来的元数据，其中已经被 grpc-java 剥离了 `grpc-status` 和 `grpc-message` 两个系统 key。那些被剥离的值，已经被解析成了 `Status` 对象的 code 和 description。你拿到的是一个"干净"的 trailers——只包含服务端自定义的 key，和一份已解码的 Status。

Metadata、Status 和 Trailers 三者构成了 gRPC 的完整元数据体系：

- **Metadata** 是 key-value 容器，ASCII/Binary 两种 key 类型决定了值如何序列化。
- **Status** 是 15 个标准码 + 描述 + 原因的完整对象，通过 `grpc-status`/`grpc-message` 两个 trailer key 传输。
- **Trailers** 是承载 Status 的元数据段，保证客户端收到的是最终确定的状态。

**三句话总结：**

1. Metadata 覆盖 headers（流开始）和 trailers（流结束）两段，`Key<T>` 的 ASCII/Binary 类型决定了值通过 `-bin` 后缀是否做 base64 编码。
2. Status 不是简单错误码，它包含 code/description/cause 三个字段，通过 `grpc-status` 和 `grpc-message` 两个 trailer key 在流结束时传输。
3. 客户端在交付 trailers 给应用层之前会剥离 `grpc-status`/`grpc-message` 系统 key，把它们解析成 Status 对象——所以你拿到的 trailers 是"干净的"。

**下篇预告：** 下一篇将进入取消、half-close 与完成边界，看一次 RPC 在客户端取消、服务端关闭、连接中断时，Status 和调用完成应该如何收敛。