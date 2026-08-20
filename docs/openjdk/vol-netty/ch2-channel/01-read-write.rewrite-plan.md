# Netty Ch2-01 Channel 读写 — 正文写作规划

## 前置依赖

### HARD

- Ch1 ByteBuffer 三篇：Buffer 的 position/limit、Heap/Direct、视图与共享状态。

### SOFT

- Java Socket 基础：读/写、EOF、发送缓冲区。
- Ch3 Selector：本篇只解释非阻塞返回 0 的后续问题，不展开事件循环。

### NAV

- Ch2-02 connect/accept：连接建立与接受的下一步。
- Ch2-03 blocking/nonblocking：本篇建立返回值语义，下一篇系统总结模式差异。
- Ch3 Selector：OP_READ/OP_WRITE 如何避免轮询。
- Netty Ch5 EventLoop/Ch7 Pipeline：作为后续架构桥接。

## 一句话困惑

同一个 `read/write` 方法，为什么在阻塞与非阻塞模式下会返回完全不同的信号；多个线程同时读写同一个 Channel 又如何避免数据交错？

## 一句话顿悟

Channel 的读写 API 不替调用方完成进度管理：返回值表达“已完成/暂不可用/关闭”，Buffer position 保存部分进度，而读锁与写锁把同向互斥和异向并行分开。

## 理解路径

1. 先从 `read()` 三种返回值建立非阻塞困惑。
2. 再讲 `write()` 返回 0 时 Buffer 如何保留未写数据。
3. 再讲阻塞/非阻塞差异其实藏在 begin/end read/write。
4. 解释读读互斥、读写并行的两锁设计。
5. 最后讲 IOStatus 的统一状态，并桥接 Selector 与 Netty outbound buffer。

## 失败方案

- 非阻塞 read 不断轮询所有 Channel：CPU 空转，Selector 后续解决。
- write 返回 0 后丢弃 Buffer：数据截断；正确做法是保留 remaining。
- read/write 共用一把锁：读写不能并发，吞吐下降。
- 把所有负数都当 EOF：中断/暂不可用与关闭混淆。

## 必须澄清

- read 返回 0、-1、正数的语义
- write 返回 0 时 position 不推进
- 同向读/写互斥，异向读写可并行
- IOStatus 的底层状态与上层 SocketChannel 返回值不是一一等同
- Selector/Netty EventLoop 是后续机制，不提前展开

## 目标结构

1. read 返回值：完成/等待/关闭（1200-1600 字）
2. write 部分写入与剩余 Buffer（1200-1600 字）
3. begin/end 与阻塞等待（1000-1400 字）
4. readLock/writeLock 并发边界（1100-1500 字）
5. IOStatus 归一化与边界（1000-1300 字）
6. 总图与 Selector/Netty 桥接（700-900 字）

## 证据清单

写作时重新核对当前 JDK 源码：

- `SocketChannelImpl.java`：read/write/beginRead/endRead/beginWrite/endWrite/锁
- `IOUtil.java`：IOStatus 常量与 normalize
- Ch1 Buffer 正文：position/remaining/compact
- Ch3 Selector 大纲：后续桥接，不直接借用未验证结论

## 深审清单

- [ ] 不把 read 0 简化成永远“连接还在”
- [ ] 明确 `IOStatus.normalize` 只把 `UNAVAILABLE(-2)` 归一为 0，`EOF(-1)` 不会被归一成 0
- [ ] 不把 IOStatus 常量直接等同于 SocketChannel 最终返回值
- [ ] 代码块逐字来自当前 JDK 源码
- [ ] 解释部分写读/写进度如何与 Buffer position 对接
- [ ] 明确同向互斥、异向并行
- [ ] 通过六轮正文 review
