# Channel 的读与写：返回值不是结果，而是状态信号

> 本文基于 JDK 11 NIO `SocketChannel` 实现。前置：Ch1 ByteBuffer 三篇；本文先讲 read/write 的返回值、部分进度和并发边界，Selector 事件循环放到下一章。

## 同一个 read，为什么有三个答案

传统 `InputStream.read()` 的直觉很强：返回正数表示读到了字节，返回 `-1` 表示 EOF。到了非阻塞 `SocketChannel`，一次 `read()` 还可能返回 `0`：这次没有数据，但调用没有被阻塞。

于是一次读取至少有三个结果：

```text
n > 0  ：本次读到了 n 个字节
n == 0 ：本次暂时没有可读数据
n == -1：对端已经关闭输入方向
```

这三个返回值不是简单的“读了多少”，而是把 IO 状态传给调用方。尤其是 `0`：它让线程可以从系统调用返回，去处理其他 Channel，而不是永远堵在当前连接上。

但返回 `0` 也提出了新的问题：调用方不能把它当成异常，也不能把它当成 EOF；它必须把 Buffer 保存下来，等待下一次合适的读取机会。

## 一、read：阻塞和非阻塞不是两个 API

`SocketChannelImpl.read(ByteBuffer)` 使用同一个方法签名处理两种模式。真正的差异藏在调用前后的生命周期方法里：

```text
read(buf)
  -> readLock.lock()
  -> beginRead(blocking)
  -> IOUtil.read(fd, buf, -1, nd)
  -> endRead(blocking, n > 0)
  -> readLock.unlock()
  -> 返回 n
```

在阻塞模式下，`beginRead(true)` 会登记 reader 线程，并在需要时等待；系统调用如果被中断，外层会对 `IOStatus.INTERRUPTED` 重试。非阻塞模式则不会把当前线程挂在那里，底层一次返回当前能取得的结果（`SocketChannelImpl.java:300-367`）。

这两个模式共享同一套 Buffer 语义：成功读取 n 个字节后，Buffer 的 position 前进 n。模式改变的是“没有进展时线程怎么办”，不是“数据写入 Buffer 的规则”。

## 二、为什么 read 返回 0 不是失败

设想一个非阻塞服务线程同时管理 1000 个连接。如果当前连接没有数据时 read 直接阻塞，其他 999 个连接就无法被处理；如果 read 把“没有数据”当异常，连接又会被错误关闭。

`0` 解决的是第三种状态：

```text
当前 Channel 没数据
       │
       ▼
read 返回 0
       │
       ▼
保留 Buffer 状态，去观察其他 Channel
       │
       ▼
未来就绪时再继续 read
```

这也意味着，非阻塞 read 的调用方必须保存“下一次从哪里继续”的状态。上一篇的 Buffer position 就承担了这部分进度；本次成功读了多少，position 就推进多少；本次返回 0，position 不变。

一个直觉但错误的实现是：

```text
while (read(buf) == 0) {
    继续立即 read(buf)
}
```

这会把非阻塞 IO 重新变成忙轮询，空闲连接越多，CPU 浪费越严重。下一篇 Selector 的意义，就是把“什么时候值得再 read”从业务循环中抽出来。

## 三、write：写不完时，Buffer 保存剩余进度

写路径和读路径对称：`write(ByteBuffer)` 获取 `writeLock`，执行 `beginWrite`，调用 `IOUtil.write`，再执行 `endWrite`（`SocketChannelImpl.java:410-476`）。

但网络写入有一个更容易踩的坑：对端接收速度、内核发送缓冲区和当前 Channel 状态都可能让一次 write 只写出一部分。

如果本次写出 n 个字节，Buffer position 会推进 n；如果返回 0，position 不推进，`hasRemaining()` 仍然为 true：

```text
待写 Buffer：[已经写出][还未写出................]
                         ▲
                      position

write 返回 0
       │
       ▼
position 不变，保留整个剩余区间
       │
       ▼
等下一次可写机会后继续 write
```

错误方案是“write 返回 0 就丢掉这个 Buffer，下一次重新构造数据”。这样不仅浪费复制，还可能造成数据重复或截断。正确的做法是保留 Buffer，让 position 成为真实的发送进度。

这正是 Netty `ChannelOutboundBuffer` 后来要维护多个待写状态的原因：NIO 的 Channel 只告诉你“这次写了多少”，而完整的异步网络框架还要保存剩余数据、flush 边界和下一次写机会。

## 四、IOStatus：底层状态和上层返回值要分开看

JDK 内部用 `IOStatus` 表示 native IO 结果：

```text
EOF         = -1  对端关闭
UNAVAILABLE = -2  非阻塞暂时没有数据
INTERRUPTED = -3  系统调用被中断
```

`IOStatus.normalize` 只把 `UNAVAILABLE` 转成 0，其他状态不被它一并吞掉（`IOStatus.java:31-76`）。因此不能写成“所有负数都被归一成 0”，也不能把 IOStatus 的每个内部值机械当成 `SocketChannel.read()` 的最终返回值。

```text
native dispatcher
   │
   ├─ 正数：实际读写字节数
   ├─ UNAVAILABLE：上层可能得到 0
   ├─ INTERRUPTED：阻塞路径可能重试
   └─ EOF：上层保留关闭语义
```

这里的分层很重要：底层 dispatcher 需要表达中断、不可用、EOF 等细节；面向 Channel 调用方的 API 则要把这些状态转换成可使用的 read/write 结果。

## 五、读锁和写锁：同向互斥，异向并行

`SocketChannelImpl` 维护两把独立的锁：

```java
private final ReentrantLock readLock = new ReentrantLock();
private final ReentrantLock writeLock = new ReentrantLock();
```

同一个方向的操作共享同一把锁：两个线程不能同时对同一个 SocketChannel 执行 read，两个写线程也不能同时执行 write。这样可以保证同一方向的系统调用和 Buffer 进度不会互相交错。

但 readLock 和 writeLock 是分开的：一个线程 read 时，另一个线程可以 write。这符合全双工 TCP 的性质：输入方向和输出方向可以同时推进。

```text
线程 A: readLock  -> read(fd, buf)  -> unlock
线程 B: writeLock -> write(fd, buf) -> unlock
                  ↑
              两把锁独立，可并行
```

关闭 Channel 时，`readerThread` 和 `writerThread` 等字段还会配合状态锁，让关闭动作知道是否有读写线程正在使用资源（`SocketChannelImpl.java:76-105`）。所以这两把锁不只是防止数据交错，也参与 Channel 关闭和线程协调。

## 六、阻塞等待不是忙循环

阻塞模式下，`beginRead`/`beginWrite` 会处理线程等待，`endRead`/`endWrite` 则完成本次操作后的清理和唤醒协调（`SocketChannelImpl.java:300-431`）。

这里需要区分两种“循环”：

- 阻塞 read 对 `INTERRUPTED` 的重试：这是处理信号中断，不是反复空读
- 非阻塞调用方不断立即 read：这是忙轮询，通常是错误方案

JDK 把第一种循环封装在 Channel 内部，把第二种选择留给上层，因为上层需要结合 Selector、定时器或其他任务决定何时再次尝试。

## 收网：Channel 把 Buffer 状态接到流式 IO

现在可以把 Ch1 的 Buffer 与本篇的 Channel 接起来：

```text
read(buf)
  -> 内核给出本次可读结果
  -> 正数：写入 buf，position 前进
  -> 0：buf 不变，等待后续就绪
  -> -1：输入方向关闭

write(buf)
  -> 内核接收本次可写部分
  -> 正数：position 前进
  -> 0：剩余内容保留，等待下一次可写
```

Channel 不替你完成消息边界，也不保证一次读完或一次写完。它只把底层流的进展告诉你；Buffer 保存进度，调用方决定如何继续。

下一篇进入 connect/accept：Channel 不仅负责传输字节，还要建立连接。连接建立不是一个 `connect()` 调用就结束，非阻塞模式下还要处理 `finishConnect()`；server 侧的 accept 又会返回什么模式的 Channel？
