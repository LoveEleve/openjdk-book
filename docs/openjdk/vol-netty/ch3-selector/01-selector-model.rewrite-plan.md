# Netty Ch3-01 Selector 模型 — 正文写作规划

## 前置依赖

### HARD

- Ch2-01 `01-read-write.md`：已经建立 `read/write` 的返回值与部分进度语义。
- Ch2-02 `02-connect-accept.md`：已经建立 `connect/finishConnect` 两拍与 `accept()` 返回 child channel 的行为。
- Ch2-03 `03-blocking-vs-nonblocking.md`：已经把“等待责任上浮”收束为非阻塞模型的总前提。
- Ch1 ByteBuffer 三篇：尤其是 attachment 里为什么常挂 Buffer、以及 `flip/compact` 的进度保存意义。

### SOFT

- JDK 底层多路复用器概念：本篇只讲 Selector 抽象与 JDK Java 层结构，不展开 epoll/kqueue 细节。
- 基本位掩码概念：帮助理解 `OP_READ/WRITE/CONNECT/ACCEPT` 与 interest/ready set。

### NAV

- Ch3-02 select loop：本篇建立 Selector 角色与 key 集合语义，下一篇展开完整单线程循环。
- Ch3-03 工程陷阱：本篇只埋下 selectedKeys、OP_WRITE、wakeup 的坑，下一篇集中展开工程问题。
- Netty Ch5 EventLoop：后续会把 register/select/process/wakeup 收进 `NioEventLoop`。
- Netty Ch4 ByteBuf：attachment 与后续读写状态承载只做轻桥接，不展开实现。

## 一句话困惑

既然 Channel 已经能非阻塞返回“现在没进展”，那 1000 个 Channel 到底由谁统一观察、谁通知我哪个连接现在值得继续读、写、连或 accept？

## 一句话顿悟

Selector 不是替你读写数据的对象，而是一张“等待时机调度表”：Channel 先注册自己关心的事件，底层 select 再把就绪结果写回 `SelectionKey`，调用方最后从 `selectedKeys` 里取出那些“现在值得继续”的连接。

## 理解路径

1. 先从 Ch2 留下的悬念切入：非阻塞只解决“不在 API 内部等”，还没解决“谁来统一等”。
2. 再讲 register：Channel 怎样正式进入 Selector 管理，为什么必须先非阻塞。
3. 再讲 `SelectionKey`：interestOps、readyOps、attachment 与四种事件。
4. 再讲 selected-key set：为什么是追加/更新，而不是每次新造一份结果。
5. 最后讲 wakeup 与 cancel：多线程如何打断阻塞 select，以及 key 为何异步注销。

## 失败方案

- 没有 Selector 时，对 1000 个非阻塞 Channel 逐个轮询 `read()`：线程不阻塞，但 CPU 仍然空转。
- 把 `OP_WRITE` 长期挂在 interestOps 上：select 几乎不再阻塞，模型退化成忙循环。
- 遍历完 `selectedKeys` 不手动 remove/clear：下一轮继续处理旧 key，逻辑重复甚至空转。
- `cancel()` 后假设 key 已经立刻从所有集合消失：会误判 selectedKeys 与 key validity 的时间窗口。
- 在别的线程注册或改 interestOps 却不理解 wakeup 语义：selector 线程可能继续睡到下一个时机。

## 误解清单

- Selector 不是 Channel 容器，而是“注册表 + 就绪结果集”。
- register 不是把数据复制进 Selector，而是产出一个 `SelectionKey` 代表这次注册关系。
- interestOps 是“我关心什么”，readyOps 是“这次准备好了什么”。
- `selectedKeys()` 不是只读快照，也不是每次 select 自动清空。
- `OP_WRITE` 不是“有数据待发送”，而是“当前 socket 可以继续写”。
- `cancel()` 不是同步立刻删除，而是先进入 cancelled-key 流程，等下次 selection 清理。

## 字数预算

- 开场困惑与前情回顾：800-1200 字
- register 与 Selector 三套 key 集合：1500-1900 字
- 四种事件与 interest/ready 语义：1600-2200 字
- selectedKeys 的增量语义与清理责任：1200-1700 字
- wakeup / cancel / 多线程边界：1400-1900 字
- 收网与 Ch3-02 桥接：800-1200 字

## 目标结构

1. 非阻塞已经不等了，可谁来统一等
2. register：Channel 如何进入 Selector 管理
3. `SelectionKey`：interestOps、readyOps、attachment 和四种事件
4. `selectedKeys`：为什么必须手动清理
5. wakeup 与 cancel：打断 select 和异步注销
6. 收网：Selector 给单线程事件循环准备了什么

## 证据清单

写作时重新核对当前 JDK 11 源码：

- `java/nio/channels/Selector.java:49-165`：三套 key 集合与 select 三步语义。
- `java/nio/channels/Selector.java:207-260`：并发边界、selectedKeys 非线程安全、wakeup/close/interrupt 打断 select。
- `java/nio/channels/SelectableChannel.java:147-210`：`register` 合同与阻塞模式限制。
- `java/nio/channels/SelectionKey.java:270-355`：`readyOps`、四种 OP 常量与 `isReadable/isWritable` 语义。
- `sun/nio/ch/SelectorImpl.java:52-88`：`keys`、`selectedKeys` 与 public view。
- `sun/nio/ch/SelectorImpl.java:133-168`：`select/selectNow/select(timeout)` 如何映射到 `doSelect`。
- `sun/nio/ch/SelectorImpl.java:199-223`：register 时创建 `SelectionKeyImpl` 并 attach / interestOps。
- `sun/nio/ch/SelectorImpl.java:244-304`：`processDeregisterQueue` 与 `processReadyEvents`。
- `sun/nio/ch/SelectionKeyImpl.java:55-166`：`interestOps` / `readyOps` / `translateInterestOps` / attachment。

## 边界清单

- 本篇基于 JDK 11 `java.base` Selector Java 层实现，不把 Linux epoll、macOS kqueue 细节写成抽象规范。
- 不把 `selectedKeys` 的 Java 集合实现细节外推为所有 JDK 版本都完全一致。
- 不把 Netty 的优化结构（如数组化 selected key set、selector rebuild）提前写成本篇事实，只做导航。
- `wakeup()` 的底层唤醒实现因平台和实现不同而不同，本篇只讲抽象合同与 JDK Java 层可见行为。

## 深审清单

- [ ] 不把 register 误写成“必须在 EventLoop 线程”这种 Netty 约束；JDK 只给出并发合同与同步语义
- [ ] 明确 `selectedKeys` 是追加/更新语义，不是每次 select 重建新集合
- [ ] 区分 interestOps 与 readyOps，避免把“关心”写成“已经就绪”
- [ ] 不把 `OP_WRITE` 说成一定永久就绪，只能写“常常容易持续就绪，工程上应谨慎持有”
- [ ] 明确 `cancel()` 的异步注销流程与 `isValid()` 检查窗口
- [ ] wakeup 只讲打断 select 合同，不提前透支 Netty `wakenUp` 修复逻辑
