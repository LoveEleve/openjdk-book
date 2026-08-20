# Ch3-01 `01-selector-model.md` review-notes

## 第一轮：事实审

- 已重新核对 `SelectableChannel.java:147-210`，正文关于 `register` 返回 `SelectionKey`、阻塞模式下注册抛 `IllegalBlockingModeException` 的表述与源码一致。
- 已重新核对 `Selector.java:49-165`，正文关于 key set / selected-key set / cancelled-key set 三套集合、以及 selection 对 selected set 的增加/更新语义与源码一致。
- 已重新核对 `SelectorImpl.java:52-88`、`:199-223`、`:244-304`，正文关于 `keys`、`selectedKeys`、register、`processDeregisterQueue`、`processReadyEvents` 的表述与实现一致。
- 已重新核对 `SelectionKey.java:270-332` 与 `SelectionKeyImpl.java:52-166`，正文关于 `interestOps` / `readyOps` / 四个操作位的区分与源码一致。

## 第二轮：因果审

- “Selector 是等待时机调度表，而不是实际做 I/O 的对象”由 Channel 与 Selector 职责分离直接支撑。
- “register 前必须先非阻塞”由 `IllegalBlockingModeException` 合同与 Selector 一线程多连接模型共同支撑。
- 对 `OP_WRITE` 只写成“容易持续就绪，工程上应按需持有”，没有夸大成所有平台、所有时刻都永久就绪。
- `wakeup()` 只解释为打断当前 selection，没有把 eventfd/pipe 等平台细节写成抽象规范。

## 第三轮：结构审

- 正文顺序按读者理解路径展开：为什么需要 Selector -> register -> 三套集合 -> SelectionKey -> 四种事件 -> selectedKeys -> wakeup/cancel -> 收网。
- 没有按 `SelectorImpl` 源码顺序翻译，也没有提前把 Netty `NioEventLoop` 实现当作当前事实。
- 将 `selectedKeys` 放在四种事件之后，有利于读者先理解“结果写到 key 上”，再理解“结果集为什么要手动消费”。

## 第四轮：读者审

- 删掉代码块后，正文仍可独立复述 Selector 的职责和三套集合语义。
- `interestOps` / `readyOps` 用“提问/回答”重写，降低首次接触时的抽象负担。
- `selectedKeys` 为什么必须 remove/clear 通过“消费结果不收尾”这一失败模型解释，不只是给 API 说明。

## 第五轮：边界审

- 已明确本文基于 JDK 11 Java 层 Selector 实现，不把底层 epoll/kqueue 差异写成统一规则。
- 没有沿用旧大纲里 `eventfd`、`epoll_wait`、JDK-6427854 等平台与后文章节细节作为本篇事实。
- `cancel()` 只讲异步注销流程，不提前展开复杂并发竞态与 Netty rebuild 逻辑。

## 第六轮：依赖审

- HARD 前置是 Ch2 三篇与 Ch1 ByteBuffer，均已存在。
- NAV 指向 Ch3 后续篇章与 Netty Ch5 EventLoop，方向正确。
- 本篇篇末桥接到单线程 select 循环，符合书级规划中 Ch3 的章节推进。

## 强制复检

- 删码测试：通过，叙述主线不依赖代码块成立。
- 陌生人测试：通过，首次引入的 `SelectionKey`、interest/ready、selectedKeys 都有局部解释。
- 反向提纲测试：通过，可还原“问题 -> register -> 结果写回 -> 消费 -> wakeup/cancel -> 回收”。
- 禁用词扫描：通过，无命中。

## 深修补记

- 已修正 `register` 只走“新建 key”路径的错误表述：正文现在明确区分“首次注册创建 `SelectionKeyImpl`”与“已注册返回现有 key 并更新 interest/attachment”两条路径。
- 已补强 `selectedKeys` 的边界：不再把问题简单写成“旧 key 原样残留”，而是明确 selection 仍会更新 ready set，但消费责任仍在事件循环侧。
- 已收紧 `OP_WRITE` 的因果链：源码层只证明 ready 条件，工程层再补“常见 socket 上容易持续就绪，因此应按需持有”的经验结论。
- 已补充 `wakeup()` 与 interest set 更新的关系：变更不会影响当前 selection，只会在下一轮被看见，因此 wakeup 的作用是尽快结束当前阻塞。
- 已补足 `select()` / `select(timeout)` / `selectNow()` 的最小回答，满足本章完备性问题对三种 select 形式差异的覆盖。
- 已收敛 attachment 的例子，不再把 Buffer/handler 之类实现细节写得过重。

## 结论

- Ch3-01 已按本轮深审问题修订完成，可进入 Ch3-02 单线程 select 循环。
