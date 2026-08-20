# Ch2-03 `03-blocking-vs-nonblocking.md` review-notes

## 第一轮：事实审

- 已重新核对 `AbstractSelectableChannel.java:282-313`，确认 `isBlocking()` 与 `configureBlocking()` 的 Java 层状态切换。
- 已重新核对 `SocketChannelImpl.java:535-550`，确认 channel 的实现层调用 `IOUtil.configureBlocking(fd, block)`。
- 已重新核对 `SocketChannelImpl.java:300`、`:410`、`ServerSocketChannelImpl.java:274`，正文只把它们用于说明同一 API 在两种模式下的等待责任差异。
- 已重新核对 `SocketAdaptor.java:87-139` 与 `:193-218`，修正并确认正文按 JDK 11 的 `pollConnected` / `finishConnect` 与 `pollRead` 行为描述，没有写成自旋忙等。
- 已重新核对 `ChannelInputStream.java:47-108`，正文把它作为 NIO Channel 到 `InputStream` 的兼容入口，未扩展未验证实现细节。

## 第二轮：因果审

- “阻塞/非阻塞的核心是等待责任归属”是全文抽象主线，所有具体结论均回落到 API 返回值、模式状态或源码调用。
- “SocketAdaptor 是兼容桥，不是性能终态”属于设计解释，正文用其适配行为支撑，没有冒充 JDK 注释中的作者意图。
- “flip/compact 保存多次 IO 之间的进度”由前置 ByteBuffer 结论与本篇的 read/write 返回值共同支撑，未引入未验证性能数字。

## 第三轮：结构审

- 标题顺序为：统一困惑 -> `configureBlocking` -> 四类动作对照 -> `SocketAdaptor` -> 收发循环 -> 总图与 Selector 桥接。
- 没有按 `SocketChannelImpl` 源码顺序翻译，代码证据只在概念提出后出现。
- `accept()` 和 `connect()` 的细节复用前篇结论，本篇集中做模式层收束，避免重复展开。

## 第四轮：读者审

- 删除代码块后，正文仍能说明“阻塞由 API 内部等待，非阻塞把等待责任上浮”的主线。
- 已明确 `read()==0`、`connect()==false`、`accept()==null` 形式不同但语义同源，降低初学者对多个特殊返回值的记忆负担。
- 已用 `clear()` 丢失半包的失败方案解释 `compact()`，避免只给 API 定义。

## 第五轮：边界审

- 已声明基于 JDK 11 `java.base` NIO 实现。
- 没有把 `IOUtil.configureBlocking` 的 native 实现写成平台唯一的 `fcntl` 细节。
- 没有把 `SocketAdaptor` 的内部适配方式外推为所有 JDK 版本的统一实现。
- Selector、EventLoop、ByteBuf 只作为后续导航，没有提前当作本文事实前提。

## 第六轮：依赖审

- HARD 前置为 Ch1 ByteBuffer、Ch2-01、Ch2-02，均已存在并完成复审。
- NAV 指向 Ch3 Selector 与后续 Netty EventLoop/ByteBuf，方向正确。
- 本文收束 Ch2，并在结尾明确引出 Ch3 Selector，符合书级规划的章间桥规则。

## 强制复检

- 删码测试：通过，叙述可独立复述主线。
- 陌生人测试：通过，关键术语均在首次使用处给出局部解释。
- 反向提纲测试：通过，小标题可还原“问题 -> 失败 -> 顿悟 -> 机制 -> 回收”。
- 禁用词扫描：首次命中“同样地”，已改写为“`SocketAdaptor` 在带超时读这一侧也采用了同一思路”，复扫无命中。

## 深审修订

- 已修正 `SocketAdaptor.connect(timeout)` 的时序描述：先临时切到非阻塞发起 `connect()`，随后在 `finally` 中恢复阻塞模式，再执行 `pollConnected()` 与 `finishConnect()`；不再把 `pollConnected()` 误写成发生在非阻塞模式下。
- 已补充 `configureBlocking` 的合同边界：它切换的是 Channel 的阻塞语义与等待责任，不把它简化成单一 native 开关；并补充了 `SelectableChannel` 注册 Selector 后不能切回阻塞模式这一限制。
- 已收紧阻塞写表述：改为“把等待当前写操作推进的责任包在方法内部”，不再暗示 Java 层必然循环直到整个 Buffer 一次写空。
- 已补全最小收发循环的 `n > 0 / n == 0 / n < 0` 分支，并明确 `compact()` 只用于保留未消费现场，全部消费完时可直接 `clear()`。
- 已把 `SocketAdaptor` 相关评价收敛到源码能直接支撑的兼容语义，不再把“推荐终态”写成作者意图。

## 结论

- Ch2-03 已按本轮深审问题修订完成，可作为进入 Ch3 Selector 的前置正文。 
