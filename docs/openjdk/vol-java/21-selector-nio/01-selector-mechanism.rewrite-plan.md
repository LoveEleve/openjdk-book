# 21-selector-nio/01 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `Selector`、`SelectionKey`、`SelectableChannel`、`SelectorImpl` 与 Linux `EPollSelectorImpl` 的唤醒骨架。本文聚焦注册/选择/消费三段式、interestOps/readyOps、selectedKeys、`wakeup()` 机制；epoll 细节平台层放下一篇。
> 目标：把“Selector 抽象与选择机制”改写成一篇围绕“一个线程为什么能同时管很多连接，关键不在它做了更多事，而在于它不再为每个连接单独阻塞等待，而是把等待这件事集中外包给 Selector”的机制文章。

## 1. 读者困惑

- 一个线程为什么能处理上万连接，难道它真的在同时盯着所有 socket 吗？
- Selector、SelectionKey、SelectableChannel 三者到底是谁在等、谁在记、谁在干活？
- `interestOps` 和 `readyOps` 为什么要分成两套位图，不能只留一份吗？
- `select()`、`selectNow()`、`wakeup()` 到底分别在解决什么等待场景？
- `selectedKeys` 为什么必须自己 remove，框架为什么不帮你自动清掉？
- wakeup 为什么靠一个“自管道”就能把阻塞中的 select 弄醒？

## 2. 一句话顿悟

**NIO 的 Selector 之所以能让一个线程管理海量连接，不是因为这个线程忽然变强了，而是因为“等待某个连接变得可读/可写”这件事不再发生在每个连接自己的阻塞 read 上，而是被集中交给 Selector：通道先登记自己关心什么事件，内核帮忙盯着，真正就绪时再把结果写回 SelectionKey。应用线程只负责消费 selectedKeys，而不是为每个连接单独睡下去。**

## 3. 旧稿优点与问题

### 保留

- 已覆盖 Selector/SelectionKey/SelectableChannel 三件套、interestOps/readyOps、SelectorImpl 骨架、selectedKeys 消费责任和 wakeup 的自管道机制。
- 已抓到“注册 → select → 消费”三阶段主线，这是本篇核心。
- 已把 epoll 平台实现细节拆到下一篇，边界合理。

### 必须重写

- 主要不是内容缺失，而是需要一份与其他域一致的计划和更强的问题驱动开场。
- 三件套角色要更明确地回到“谁声明兴趣、谁统一等待、谁承载结果”这条主线上。
- `selectedKeys` 必须 remove 的责任，要强调是事件循环协议的一部分，而非使用细节。
- wakeup 应更明确讲成“把外部控制动作翻译成一个内核可见的就绪事件”。

## 4. 理解路径

### 第一节：从“为什么一个线程能管上万连接”开场

用 BIO 一连接一线程的对照开场。先立住总问题：NIO 并不是让线程更会并发，而是把等待 I/O 就绪这件事从每个连接上剥离出来集中管理。

### 第二节：Selector 三件套为什么是三个角色而不是一个大对象

证据：
- `Selector.java` 中 `select/selectedKeys/keys`
- `SelectionKey.java` 中 `channel/interestOps/readyOps`
- `SelectableChannel.register` 相关路径（旧稿已有 AbstractSelectableChannel 回钩）

主线：
- Channel 负责声明“我是谁、我关心什么事件”。
- Selector 负责统一等待“谁准备好了”。
- SelectionKey 负责记住这次配对关系与兴趣/就绪状态。
- 三者组合起来才把“等待”和“处理”拆成两步。

### 第三节：interestOps / readyOps 为什么必须分开

证据：
- `SelectionKey` 中 OP 常量与对应方法（旧稿已有行号）

主线：
- interestOps 是“我想等什么”；readyOps 是“内核刚告诉我什么已经发生”。
- 两者分开后，应用层才能一边长期声明兴趣，一边一次次消费就绪结果，而不丢失配置。

### 第四节：select 骨架为什么只是模板，真正阻塞点在平台实现

证据：
- `Selector.java:294`：`open`
- `SelectorImpl.java:133-147`：`select/selectNow`
- `SelectorImpl.java:114-130`：`lockAndDoSelect`
- `SelectorImpl.java:111`：`doSelect`
- `SelectorImpl.java:279-304`：`processReadyEvents`

主线：
- Selector 抽象层负责 key 管理、状态校验与就绪事件翻译。
- 真正阻塞在平台 `doSelect` 上，SelectorImpl 本身是模板骨架，不是内核等待实现。
- 这为下一篇 epoll 细节做铺垫。

### 第五节：selectedKeys 为什么必须手动消费并 remove

证据：
- `Selector.java:344`：`selectedKeys()`
- `SelectorImpl.java:70`：返回的是可 remove 的受限集合
- `SelectorImpl.java:244-271`：`processDeregisterQueue`

主线：
- selectedKeys 是本轮“已就绪快照”的工作清单，不是框架自动帮你收尾的事件总线。
- 不 remove 就会反复处理同一批 key，readyOps 语义会变脏。
- 所以 remove 是事件循环协议的一部分，不是 API 小习惯。

### 第六节：wakeup 为什么本质上是在制造一个“内核可见的假事件”

证据：
- `Selector.java:609`：`wakeup`
- `SelectorImpl.java:177-196`：关闭时先 wakeup
- `EPollSelectorImpl.java:83-93`：构造期注册 fd0
- `EPollSelectorImpl.java:250-260`：`wakeup()` 写 fd1
- `EPollSelectorImpl.java:262-267`：`clearInterrupt`

主线：
- 阻塞中的 select 不能被“Java 变量改了”这类用户态动作直接打断，必须制造一个内核可见事件。
- 自管道正是在做这件事：向写端写 1 字节，让读端变成可读，从而把 epoll/select 唤醒。
- 这是“把控制信号翻译成 I/O 就绪事件”的经典技巧。

## 5. 失败方案清单

1. 把 Selector 理解成“一个线程轮询所有连接”，忽略内核等待这一层。
2. 用同一份位图同时表达 interest 和 ready，导致声明与结果混淆。
3. select 返回后不清理 selectedKeys，反复消费旧就绪事件。
4. 以为 wakeup 只是设置一个布尔标记，不依赖底层 fd 事件。
5. 在平台注册和应用消费之间混淆职责，导致对实现层次理解错位。

## 6. 误解清单

1. 一个线程能管很多连接，主要是因为 CPU 更快了。
2. SelectionKey 只是保存通道引用，interest/ready 位图意义不大。
3. `selectNow()` 和 `wakeup()` 都只是“不阻塞”的另一种写法。
4. selectedKeys 是框架自动维护的历史队列，应用可不管清理。
5. wakeup 的自管道技巧只和 epoll 实现细节有关，与 Selector 抽象无关。

## 7. 证据清单

- `Selector.java:294`：`open`
- `Selector.java:344`：`selectedKeys`
- `Selector.java:609`：`wakeup`
- `SelectionKey.java` 中 OP 常量与 `interestOps/readyOps`
- `SelectorImpl.java:70`：selected key set 包装
- `SelectorImpl.java:111`：`doSelect`
- `SelectorImpl.java:114-147`：`lockAndDoSelect` / `select` 家族
- `SelectorImpl.java:177-196`：close 先 wakeup
- `SelectorImpl.java:244-271`：`processDeregisterQueue`
- `SelectorImpl.java:279-304`：`processReadyEvents`
- `EPollSelectorImpl.java:83-93`：wake fd 注册
- `EPollSelectorImpl.java:250-260`：wakeup 写字节
- `EPollSelectorImpl.java:262-267`：清理唤醒字节

## 8. 版本与边界

- 基于 JDK 11。
- 本篇聚焦 Selector 抽象机制和 wakeup 语义，不展开 epoll/select/poll 的平台复杂对比，留给下一篇。
- 不把 SocketChannel 具体注册与 connect 流程提前展开，保持在选择器骨架层。
- selectedKeys 语义以 JDK 默认实现为主，不外推到所有框架自定义 key-set 优化。

## 9. 删除代码测试与最终验收标准

- 删除代码块后，读者仍能复述“为什么 Selector 能把等待从连接线程上剥离出来 → 三件套如何分工 → interestOps/readyOps 为何分离 → select 骨架为什么要下沉到 doSelect → selectedKeys 为什么必须手动消费 → wakeup 为什么靠自管道变成一个内核可见事件”。
- 必须把 selectedKeys 的 remove 责任讲清。
- 必须自然引到 `02-epoll-platform.md`。
