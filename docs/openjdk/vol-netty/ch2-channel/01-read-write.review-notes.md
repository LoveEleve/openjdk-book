# Netty Ch2-01 Channel 读写 — 正文深审记录

## 第一轮：事实审

- 核对 `SocketChannelImpl` 的 read/write、begin/end read/write、readLock/writeLock。
- 核对 `IOStatus`：`normalize` 只把 `UNAVAILABLE(-2)` 转为 0，不能把 EOF(-1) 写成 0。
- 明确底层 IOStatus 与上层 Channel 返回值不是机械一一对应。

## 第二轮：因果审

- read 返回 0 被解释为非阻塞进度信号，不写成异常或 EOF。
- write 返回 0 与 Buffer position/remaining 的关系已闭环。
- 阻塞模式的 INTERRUPTED 重试与非阻塞忙轮询已区分。
- readLock/writeLock 的同向互斥、异向并行均有源码依据。

## 第三轮：结构审

- 结构为：read 三态 → write 部分进度 → 阻塞/非阻塞 → IOStatus → 两把锁 → 收网。
- Selector、connect/accept、EventLoop 只作为后续桥接，不提前展开。
- 前置依赖为 Ch1 ByteBuffer，篇末引出 Ch2-02/Ch3。

## 第四轮：读者审

- 删除代码块后，读者仍能复述 read/write 的状态信号和 Buffer 进度。
- 明确“read 0 不是 EOF”“write 0 不能丢 Buffer”“bulk/剩余数据由上层管理”等误解。
- 使用 read/write 两条文字数据流作为总图。

## 第五轮：边界审

- 未把非阻塞 read 0 绝对化为“连接一定仍然健康”。
- 未把 NIO Channel 说成消息边界协议；明确它只处理字节流进展。
- 未提前把 Netty EventLoop/ChannelOutboundBuffer 写成当前实现事实。

## 第六轮：方法论审

- 篇级规划：`01-read-write.rewrite-plan.md`。
- 正文目录：`vol-netty/ch2-channel/`，未修改 `vol-02`/`vol-java`。
- 禁用词扫描通过。
- 当前未发现高风险事实问题。
