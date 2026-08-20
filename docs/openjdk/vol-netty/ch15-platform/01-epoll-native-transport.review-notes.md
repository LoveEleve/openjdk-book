# Ch15-01 epoll 原生传输：EpollEventLoop、AbstractEpollChannel、EpollSocketChannel — Review Notes

## 第一轮：事实审

### 已核对的核心结论

1. `EpollEventLoop` 当前已被标记为 deprecated，建议改用 `SingleThreadIoEventLoop + EpollIoHandler`，证据：`transport-classes-epoll/src/main/java/io/netty/channel/epoll/EpollEventLoop.java:32`。  
2. `EpollEventLoop` 当前主要只是把注册查询转发给 `EpollIoHandler`，`setIoRatio()` 已成为 no-op，证据：`transport-classes-epoll/src/main/java/io/netty/channel/epoll/EpollEventLoop.java:64`、`:77`。  
3. `AbstractEpollChannel` 当前直接持有 `LinuxSocket`、`IoRegistration`、`ops`、connectPromise/connectTimeoutFuture 和 cached 地址，证据：`transport-classes-epoll/src/main/java/io/netty/channel/epoll/AbstractEpollChannel.java:66`。  
4. `setFlag/clearFlag` 当前会在 channel 已注册时把新的 epoll 事件掩码提交给 `IoRegistration`，证据：`transport-classes-epoll/src/main/java/io/netty/channel/epoll/AbstractEpollChannel.java:121`。  
5. `doClose()` 当前会先 fail connectPromise、取消 connectTimeoutFuture、处理 deregister，再最终 `socket.close()`，证据：`transport-classes-epoll/src/main/java/io/netty/channel/epoll/AbstractEpollChannel.java:173`。  
6. `EpollSocketChannel` 当前是基于 Linux epoll 的 `SocketChannel` 实现，并暴露 `tcpInfo()`、`tcpFastOpenConnect`、tcp md5 等能力，证据：`transport-classes-epoll/src/main/java/io/netty/channel/epoll/EpollSocketChannel.java:40`。  
7. `EpollSocketChannel.doConnect0()` 当前在 fast open 分支里会直接接入 `ChannelOutboundBuffer`，调用 `addFlush/current/removeBytes` 处理初始数据，证据：`transport-classes-epoll/src/main/java/io/netty/channel/epoll/EpollSocketChannel.java:135`。  
8. `prepareToClose()` 当前在 `SO_LINGER > 0` 时会取消 registration 并返回 `GlobalEventExecutor.INSTANCE`，证据：`transport-classes-epoll/src/main/java/io/netty/channel/epoll/EpollSocketChannel.java:157`。  
9. 本地测试目录下大量 `Epoll*Test` 覆盖 socket、file region、gathering write、manual loop、tcp md5 等边界，说明平台专题验证的是“承载层替换后的语义仍成立”，证据：`transport-native-epoll/src/test/java/io/netty/channel/epoll/` 目录。

### 深审发现

1. **高风险：容易把 epoll 写成上层主线重写。** 正文已明确它替换的是 Linux 承载层，而不是重写 Pipeline/Promise/HTTP2 主线。  
2. **中风险：容易把 `EpollEventLoop` 误写成 4.2 的唯一核心点。** 正文已改成“兼容壳 + 向 `EpollIoHandler` 收敛”的结论。  
3. **中风险：容易把 `SO_LINGER` 写成纯 socket 配置细节。** 正文已强调它会影响关闭时的执行器边界。  
4. **低风险：容易把平台测试外推成普适性能结论。** 正文只把它们当作“承载层替换但语义仍成立”的证据。

## 第二轮：因果审

- epoll 替换的是 Linux I/O 承载层，而不是 Channel 上层语义：✅  
- `AbstractEpollChannel` 把 native socket、掩码、注册关系和关闭状态重新收束成 Channel 可理解的状态机：✅  
- `EpollSocketChannel` 通过 fast open、linger、tcpInfo 等把 Linux 特性接入同一条出站/关闭主线：✅  
- `GlobalEventExecutor` 在 `SO_LINGER` 场景下作为低频辅助执行面出现，说明平台能力会反过来影响执行器选择：✅

## 第三轮：结构审

正文结构按“先钉死 epoll 只是承载层替换 -> EpollEventLoop -> AbstractEpollChannel -> EpollSocketChannel -> 测试语义 -> 收网”推进，没有按类文件顺序机械平铺。✅

失败/误解已覆盖：
- epoll 等于整套新主线  
- `EpollEventLoop` 仍是全部 epoll 逻辑中心  
- 切到 epoll 后上层 ChannelOutboundBuffer / Promise / Pipeline 全要重学  
- `SO_LINGER` 只是一个配置项  
满足方法论要求。✅

## 第四轮：读者审

删除代码块后，正文仍应能复述：
- epoll 替换的是 Linux 承载层  
- 4.2 里的 `EpollEventLoop` 更像兼容壳  
- `AbstractEpollChannel` 是平台状态机核心  
- `EpollSocketChannel` 如何把 fast open / linger / tcpInfo 接到主线  
- 上层 Pipeline/Promise/HTTP2 主线为什么不需要重学  

当前正文满足删码后主线仍成立。✅

## 第五轮：边界审

- 未展开全部 JNI/native C 细节。✅  
- 未把 epoll 写成平台性能定论。✅  
- 未枚举全部 socket option。✅  
- 未重讲上层 HTTP/2 / Pipeline 主线。✅

## 第六轮：依赖审

- 依赖 Ch2、Ch5、Ch7、Ch12 前置，真实存在。✅  
- 与后续 io_uring 平台专题分工清晰：本篇先回答“承载层替换”，下一篇再做对照。✅

## 机械检查

- 禁用词：`此处不再赘述 / 不再展开 / 类似地 / 同理 / 依此类推 / 篇幅所限 / 显然 / 容易看出 / 细节读者自行阅读源码` 均未命中。✅  
- 代码块：未使用 fenced code block。✅  
- 源码引用：已逐条核对。✅  
- 去掉代码块后正文仍成立：是。✅  
- 正文字符数：约 7,628。  
- 去掉常见 markdown 标记后的字符数：约 7,335。  
- 目标定位：平台专题篇，已形成独立闭环。✅

## 结论

当前正文已经建立 epoll 平台专题的核心边界：替换 Linux 承载层，不重写上层主线。本篇不承担 JNI/native C 细节的深入展开；那部分如需扩写，应另开 native 深挖专题。Ch15-01 可作为后续 io_uring 对照篇的直接前置篇。