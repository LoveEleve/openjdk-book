# Ch3-03 Selector 工程陷阱 — 正文写作规划

## 前置依赖

### HARD

- Ch3-01 `01-selector-model.md`：三套集合、SelectionKey、四种事件、wakeup/cancel 基本语义。
- Ch3-02 `02-select-loop.md`：完整 select loop 四步闭环、OP_WRITE 按需注册、iter.remove vs cancel、最小服务端骨架。
- Ch2-01~03：Channel 返回值、configureBlocking、read→flip→process→compact。
- Ch1-01~03：Buffer 状态机、Direct 内存、视图陷阱。

### SOFT

- Linux epoll 使用经验：有助于理解空轮询 bug 的底层成因。
- 多线程调试经验：有助于理解 wakeup 竞态窗口。

### NAV

- Ch4 Netty ByteBuf：本篇收网引出 Ch4，不做 Ch4 的知识展开。
- Ch5 Netty EventLoop：空轮询的 Netty 解法（rebuildSelector）只做导航，不提前展开。

## 一句话困惑

知道了 Selector 模型和 select loop 四步闭环，但裸 NIO 在生产环境里到底有哪些坑，为什么这些坑不是"写错了"而是"JDK NIO 设计层面就裸露着"？

## 一句话顿悟

空轮询 bug、wakeup 竞态、selectedKeys 累积，这三个坑的共同根源是：JDK 把底层系统调用的原始语义几乎原封不动地透传给了上层，没有额外做工程级的保护层。

## 理解路径

1. 先从 select() 空轮询 bug 切入——这是最有体感的生产级陷阱。
2. 再拆 wakeup 时序窗口——这是理解"Selector 不是原子操作"的关键。
3. 最后收 selectedKeys 累积陷阱——把 Ch3-01/02 已经建立的概念在工程后果上拼完整。
4. 收网：三个坑的共同根源 + Ch4 导航。

## 失败方案

- 在每一轮 select 循环里 sleep(1)：能压住空轮询 bug 的 CPU，但牺牲了响应延迟。
- 试图用 double-check + 锁来消除 wakeup 竞态：这会把单线程 select loop 变回阻塞同步。
- 遍历 selectedKeys 时不 remove，靠"业务侧判重"来兜底：重复处理 + 可能在 cancel 之后撞到失效 key。

## 误解清单

- 空轮询 bug 不是"你的代码写错了"，而是 epoll_wait 系统调用在特定边界条件下的假唤醒。
- wakeup 竞态不会导致正确性问题（不会丢唤醒），但会导致一次额外空返回。
- selectedKeys 累积不是"JDK 没清理"，而是"结果集消费者没做收尾"。
- 这三个坑的共同点不是"JDK 有 bug"，而是"JDK NIO 把底层语义透传，没加工程保护"。

## 字数预算

- 开场困惑与三个坑的共同根源：500-800 字
- select() 空轮询 bug：1800-2400 字
- wakeup 竞态时序窗口：1500-2000 字
- selectedKeys 累积的完整生产级后果：1200-1700 字
- 收网 + Ch4 导航：500-800 字

## 目标结构

1. 裸 NIO 在生产级会撞到什么
2. 空轮询 bug：epoll_wait 的假唤醒
3. wakeup 竞态：打断 select 的时序窗口
4. selectedKeys 累积：消费者不收尾的全部后果
5. 收网：三个坑的共同根源

## 证据清单

- `EPollSelectorImpl.java:102-138` — doSelect 中 epoll_wait 调用与 INT 中断重试逻辑
- `EPollSelectorImpl.java:181-207` — processEvents 处理 fd0 中断与普通 fd 就绪
- `EPollSelectorImpl.java:250-262` — wakeup 向 fd1 写字节 + interruptTriggered 标志
- `EPollSelectorImpl.java:264-268` — clearInterrupt drain fd0 + 重置标志
- `SelectorImpl.java:279-304` — processReadyEvents 中 selectedKeys 已包含 key 时的更新逻辑
- `SelectorImpl.java:259` — processDeregisterQueue 从 selectedKeys 移除已 cancel 的 key
- `Selector.java:254-256` — wakeup 幂等合同
- `IOStatus.java:38` — INTERRUPTED 常量定义

## 边界清单

- 本篇基于 JDK 11 Linux EPollSelectorImpl 实现，PollSelectorImpl/KQueueSelectorImpl 的差异不展开。
- 空轮询 bug 只在 JDK 层解释现象与传递路径，Netty 的 rebuildSelector 解法只做 Ch5 导航。
- wakeup 竞态只讨论"不丢唤醒、但可能多唤醒一次"的时序窗口，不展开 Netty 的 wakeup 优化。
- selectedKeys 累积只讨论 JDK 层的后果，Netty 的 selectedKeys 优化留到 Ch5。
- 不把三个坑写成"JDK 的 bug"，而是定位为"底层语义透传、缺少工程保护层"。

## 深审清单

- [ ] 空轮询 bug 不写成"JDK API 签名错误"，而是 epoll_wait 假唤醒通过 JDK 透传
- [ ] doSelect 中 `numEntries == IOStatus.INTERRUPTED` 的重试逻辑要对准 EPollSelectorImpl.java:121-130
- [ ] wakeup 的 `interruptTriggered` 标志只在 `clearInterrupt` 时重置，不在 wakeup 本身重置
- [ ] selectedKeys 累积与 cancel 的交叉时段要明确：cancel 后 key 仍在 selectedKeys 直到下次 selection 清理
- [ ] 收网不提前展开 Netty 的解法细节，只做 Ch4/Ch5 导航
- [ ] 不写成"NIO 不能用于生产"，而是"裸 NIO 缺工程保护层"
