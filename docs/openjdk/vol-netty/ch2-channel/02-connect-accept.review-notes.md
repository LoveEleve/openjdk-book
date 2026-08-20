# Ch2-02 `02-connect-accept.md` review-notes

## 第一轮：事实审

- 已重新核对 `SocketChannel.java:330-445`，确认阻塞/非阻塞下 `connect()`、`finishConnect()` 的 API 合同与正文一致。
- 已重新核对 `SocketChannelImpl.java:572-599`、`SocketChannelImpl.java:621-698`、`SocketChannelImpl.java:718-795`，确认 `bind()`、`connect()`、`finishConnect()` 的状态推进与正文一致。
- 已重新核对 `ServerSocketChannel.java:230-237` 与 `ServerSocketChannelImpl.java:274-311`，确认 `accept()` 在非阻塞模式下无连接返回 `null`，且新 child channel 会被 `IOUtil.configureBlocking(newfd, true)` 设回阻塞模式。
- 已重新核对 `Net.java:445-483`，正文只引用 `bind()` / `connect()` 进入 native 层这一层事实，没有把未证实的 OS 细节写死。

## 第二轮：因果审

- “非阻塞 connect 拆成两拍，是为了不让线程卡在握手期间”属于 API 设计动机推断，但与 `SocketChannel` 的阻塞/非阻塞合同和状态机一致，保留。
- “accept 返回阻塞 child 是兼容旧 `Socket` 预期的折中”属于设计推断，正文明确按兼容语义解释，没有冒充源码注释原文。
- 删除了对底层单一 OS 调用细节的展开，只保留 JDK 层能证实的行为。

## 第三轮：结构审

- 正文顺序按读者困惑组织：开场困惑 -> `connect()` -> `finishConnect()` -> `bind()` -> `accept()` -> 收网。
- 没有按源码文件顺序逐段翻译，也没有把 Netty 后续实现提前作为主线证据。
- `bind()` 放在中间而不是开头，用于解释客户端/服务端角色分叉，结构合理。

## 第四轮：读者审

- 删掉代码块后，主线仍可复述：客户端两拍连接、服务端 child 默认阻塞、框架必须托管这几个拐点。
- 为避免读者把 `false` 理解成失败，正文在开场、`connect()` 节和收网处都重复回收这一点。
- 为避免读者误把 server 非阻塞继承到 child，上文、代码证据和动作链三处重复强调 child 仍需 `configureBlocking(false)`。

## 第五轮：边界审

- 已明确全文基于 JDK 11 `java.base` NIO 实现，不外推到所有 JDK 和平台。
- 已避免把 `checkConnect` 固定解释成某个单一 OS 机制。
- 已避免提前展开 Selector `OP_CONNECT` / `OP_ACCEPT` 和 Netty Bootstrap 内部细节，只保留桥接导航。

## 第六轮：依赖审

- HARD 前置仅使用已完成的 Ch1 与 Ch2-01 结论。
- 后续桥接保持为 NAV：Ch2-03、Ch3 Selector、Netty Ch5 / Ch9，没有把后文实现当前置事实。
- 与大纲 `outlines/ch2-channel/02-connect-accept.md` 的主线一致，但正文没有照抄旧大纲中的未核实行号或过度 OS 细节。

## 结论

- 当前正文可进入下一步校验。
- 若后续再补图谱节点，本文可稳定沉淀为：非阻塞连接两拍模型 + `accept()` child 阻塞陷阱 + `bind()` 客户端/服务端分叉。