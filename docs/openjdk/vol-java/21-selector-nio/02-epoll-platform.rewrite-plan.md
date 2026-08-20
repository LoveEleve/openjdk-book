# 21-selector-nio/02 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 Linux 平台 `EPollSelectorImpl`、`EPoll` 封装与 `SelectorProvider` 分层。本文聚焦 create/ctl/wait 三调用、事件表在内核、水平触发默认选择、自管道唤醒与 provider 分层；socket/channel 行为留到下一篇。
> 目标：把“epoll 实现与平台分层”改写成一篇围绕“Selector 抽象背后真正值钱的不是 Java API 本身，而是 Linux 平台用 epoll 把‘谁就绪了’这件事沉到内核事件表里；Java 层只负责把这种内核就绪结果翻译回 key 集合”的机制文章。

## 1. 读者困惑

- `Selector.open()` 到 Linux 上为什么会落到 `EPollSelectorImpl`，Java 是怎么把平台差异藏起来的？
- epoll 到底比 select/poll 好在哪，为什么它能支撑海量连接？
- `create`、`ctl`、`wait` 三调用分别在整个选择器生命周期里扮演什么角色？
- 事件表“在内核”这句话到底意味着什么？
- JDK 为什么默认走水平触发而不是边缘触发？
- wakeup 的自管道在 epoll 下到底是怎样和内核事件机制咬合的？

## 2. 一句话顿悟

**Selector 在 Linux 上之所以能高效，不是因为 Java 层轮询得更聪明，而是因为真正的事件表和就绪队列被交给了 epoll：`create` 建立内核事件表，`ctl` 维护 fd 与兴趣事件，`wait` 只拿回当前就绪项。JDK 的 `EPollSelectorImpl` 做的不是重新实现一套多路复用器，而是把 epoll 的事件结果翻译成 SelectionKey 的 readyOps / selectedKeys 语义，再用自管道把外部控制动作转换成一个内核可见的可读事件。**

## 3. 旧稿优点与问题

### 保留

- 已覆盖 provider 工厂链、epoll 三调用、事件表在内核、水平触发与自管道唤醒。
- 已把 `processUpdateQueue`、`processEvents`、`clearInterrupt` 这些关键桥接点抓出来。
- 已把 SocketChannel 细节留到下一篇，边界合理。

### 必须重写

- 主要不是内容缺失，而是需要统一风格的计划与更强的问题驱动开场。
- epoll 相对 select/poll 的优势要更明确地回扣“事件表在内核 + 只返回就绪项”这条主线。
- 水平触发选择要讲成“JDK 为了简单安全付出的默认取舍”，而不是只报一个事实。
- 自管道唤醒要强调它是“把控制操作翻译成内核可见 I/O 事件”的桥接技巧。

## 4. 理解路径

### 第一节：从“Selector.open 到底在 Linux 上开出了什么”开场

承接上一篇：Selector 抽象和 key 管理已经知道了，但继续追问——在 Linux 上它具体落成了谁。先立住平台分层问题：Java API 统一，具体平台多路复用实现不同。

### 第二节：provider 工厂链为什么是平台差异的入口

证据：
- `Selector.java:294`：`open`
- `Selector.java:171`：`SelectorProvider.provider()`
- `DefaultSelectorProvider.java:45`：返回 `EPollSelectorProvider`
- `EPollSelectorProvider.java:35`：`openSelector()`
- `EPollSelectorImpl.java:50`：类定义

主线：
- Selector 不是直接 new 平台实现，而是先走 provider SPI，再落到 linux 的 epoll provider。
- 这就是“共享骨架 + 平台实现”分层的真正入口。

### 第三节：为什么 epoll 三调用就能描述整个事件表生命周期

证据：
- `EPoll.java:112`：`create()`
- `EPoll.java:114`：`ctl(...)`
- `EPoll.java:116`：`wait(...)`
- `EPoll.java:58-64`：控制码与事件常量
- `EPollSelectorImpl.java:79-85`：构造时创建 epfd / pollArray / pipe
- `EPollSelectorImpl.java:143-175`：`processUpdateQueue`

主线：
- create 建事件表；ctl 增删改兴趣；wait 只取回当前就绪项。
- 事件表长期住在内核，不再像 select 一样每次把全量 fd 集合搬来搬去。
- `processUpdateQueue` 说明兴趣变化如何被同步回内核事件表。

### 第四节：epoll 为什么能支撑海量连接——事件表在内核, wait 只取就绪项

证据：
- `EPollSelectorImpl.java:53/56/59/62-63`：关键字段
- 旧稿中的 select/poll 对比说明

主线：
- 重点不只是 O(1) 口号，而是“事件表常驻内核 + 回调/就绪队列语义 + wait 只取活跃项”。
- 对比 select/poll 每次全量扫描与 fd 集合拷贝，强调总连接数和就绪连接数解耦。

### 第五节：为什么 JDK 默认水平触发,而不是更激进的边缘触发

证据：
- `EPoll.java:63-67`：EPOLLIN/EPOLLOUT/EPOLLONESHOT 常量,无 EPOLLET
- `EPollSelectorImpl` 整体行为与 select/poll 语义一致

主线：
- 水平触发意味着“还有数据没读完,下次还会提醒你”,简单安全,更接近传统 select/poll 行为。
- 边缘触发虽然能减少重复通知,但要求应用一次读尽,更容易漏事件。
- JDK 默认值体现的是“抽象一致性与安全优先”,不是绝对极限性能优先。

### 第六节：自管道唤醒为什么是把控制动作翻成一个“假 I/O 事件”

证据：
- `EPollSelectorImpl.java:83-93`：注册 fd0 进 epoll
- `EPollSelectorImpl.java:250-260`：`wakeup()` 写 fd1
- `EPollSelectorImpl.java:191-192`：识别出 fd0 就绪
- `EPollSelectorImpl.java:262-267`：`clearInterrupt`

主线：
- 阻塞中的 epoll_wait 只认内核事件，不认你 Java 线程里改了个布尔值。
- 自管道就是把“想把 select 叫醒”翻译成“现在有个 fd 可读”的内核事件。
- 这说明 wakeup 技巧和 epoll 不是并列知识点,而是同一条桥接逻辑的两端。

## 5. 失败方案清单

1. 把 Linux 上的 Selector 当成 Java 自己轮询 fd 的结果。
2. 只记“epoll 是 O(1)”却不理解为什么事件表常驻内核才是关键。
3. 以为 epoll 的 create/ctl/wait 只是系统调用名字，对 Java 层行为没影响。
4. 把水平触发和边缘触发当成纯性能选项，不看丢事件风险。
5. 以为 wakeup 只是设置一个标志位，不需要真正的内核事件参与。

## 6. 误解清单

1. Selector.open 直接返回一个跨平台统一实现，只是内部 if 平台判断。
2. epoll_wait 返回的是“所有 fd 当前状态”，而不是就绪项集合。
3. processUpdateQueue 只是把 Java 集合清一清，不影响内核状态。
4. 水平触发更“低级”，边缘触发总是更优。
5. 自管道是一个 Linux 私有技巧，对 Selector 语义本身没意义。

## 7. 证据清单

- `Selector.java:171/294`
- `DefaultSelectorProvider.java:45`
- `EPollSelectorProvider.java:35`
- `EPollSelectorImpl.java:50`
- `EPollSelectorImpl.java:53/56/59/62-63`
- `EPollSelectorImpl.java:79-85`
- `EPollSelectorImpl.java:92-93`
- `EPollSelectorImpl.java:143-175`
- `EPollSelectorImpl.java:191-192`
- `EPollSelectorImpl.java:250-260`
- `EPollSelectorImpl.java:262-267`
- `EPoll.java:58-64`
- `EPoll.java:112/114/116`

## 8. 版本与边界

- 基于 JDK 11 Linux 实现。
- 本篇聚焦 epoll 平台分层和 wakeup 机制，不展开 SocketChannel 的 connect/accept/读写细节。
- 不把边缘触发拓展成 Netty 全景，只作为 JDK 默认取舍的对照点。

## 9. 删除代码测试与最终验收标准

- 删除代码块后，读者仍能复述“Selector.open 如何落到 EPollSelectorImpl → create/ctl/wait 如何对应事件表生命周期 → 为什么事件表在内核会让 wait 只返回就绪项 → 为什么 JDK 默认水平触发 → 自管道 wakeup 怎样把控制动作变成内核可见事件”。
- 必须自然引到 `03-socketchannel-blocking.md`。
