# 01. Selector 抽象与选择机制 — 三件套、注册、select 流程

> **前置依赖**: [19-buffer-channel/01 — Buffer 状态机](../19-buffer-channel/01-buffer-state-machine.md)(就绪后读写的 Buffer 载体)
> → **后续**: [21-selector-nio/02 — epoll 实现与平台分层](02-epoll-platform.md)
> 关联: 域 19 BufferChannel(数据载体);内部卷 01-os(文件描述符与平台层)

## 一个线程怎么管上万连接

BIO 一连接一线程: 一万个连接就是一万个线程。NIO 的答案是把"等事件"从每个连接里抽出来集中到一处——`Selector`。一个线程把上万个通道注册进去,内核帮忙盯着,谁就绪通知谁。这一篇讲 Selector 的三件套角色、select 的骨架流程、selectedKeys 的消费循环,以及 wakeup 的唤醒机制。

## 1. "Selector 三件套" — 角色分工

### 1.1 三个角色

| 角色 | 职责 | 源码 |
|------|------|------|
| `Selector` | **多路复用器**: 统一等待就绪事件 | `Selector.java:418` `select()` |
| `SelectionKey` | **就绪键**: 通道 + 选择器的配对凭证 | `SelectionKey.java:118` `channel()`/`:168` `interestOps()`/`:280` `readyOps()` |
| `SelectableChannel` | 可注册的通道: 把自己挂到 Selector | `SelectableChannel.java:257` `register(sel, ops)` |

### 1.2 事件常量

`SelectionKey.java:296-332` 四个操作位:

| 常量 | 值 | 源码 | 语义 |
|------|-----|------|------|
| `OP_READ` | 1<<0 | `:296` | 可读 |
| `OP_WRITE` | 1<<2 | `:308` | 可写 |
| `OP_CONNECT` | 1<<3 | `:320` | 连接完成 |
| `OP_ACCEPT` | 1<<4 | `:332` | 有新连接可接受 |

### 1.3 三阶段模型

"注册(登记兴趣)→ select(等待就绪)→ 消费(selectedKeys)": 通道对 Selector 声明"我对读事件感兴趣"(interestOps),选择器统一等待;内核就绪后,选择器把就绪信息写回 key 的 readyOps,应用遍历 selectedKeys 消费。`SelectionKey` 就是连接两者的"契约对象"——一个通道在一个 Selector 上只有一个 key: `AbstractSelectableChannel.register` 先 `findKey` 查已有 key,存在则更新 interestOps 后直接返回(`spi/AbstractSelectableChannel.java:214-222`)。

关键设计(斜体):*三件套 = "通道声明兴趣、选择器统一等待、key 作凭证"。面试"selector 是怎么工作的": 单线程注册 N 个通道,内核等待任一就绪;一连接一线程的 BIO 对比是必答项。*

## 2. "select 的流程" — SelectorImpl 骨架

### 2.1 骨架 + 平台模板方法

`Selector.open()`(`Selector.java:294`)→ `SelectorProvider.provider()`(`:171`)→ 平台 `openSelector()`,返回具体实现(linux 上是 `EPollSelectorImpl`,`EPollSelectorImpl.java:50`,extends SelectorImpl)。

共享骨架 `SelectorImpl`(`sun/nio/ch/SelectorImpl.java`,311 行)的求值链:

```java
// SelectorImpl.java:133-137 + 140-147(截取,逐字)
    public final int select(long timeout) throws IOException {
        if (timeout < 0)
            throw new IllegalArgumentException("Negative timeout");
        return lockAndDoSelect(null, (timeout == 0) ? -1 : timeout);
    }

    public final int select() throws IOException {
        return lockAndDoSelect(null, -1);
    }

    public final int selectNow() throws IOException {
        return lockAndDoSelect(null, 0);
    }
```

- timeout 约定(`:108-109` 注释): **0 = 不等待、-1 = 无限等待**——`select()` 传 -1 无限阻塞,`selectNow()` 传 0 立即返回,`select(timeout)` 的 0 被转成 -1(语义: 不设超时)
- `lockAndDoSelect`(`:114-130`): 加锁 + `inSelect` 防重入检查 + 调平台抽象 `doSelect`(`:111`)
- 真正阻塞在平台 `doSelect`——共享层只做 key 管理/就绪消费,平台层只做"内核等待"(模板方法)

### 2.2 processReadyEvents: 就绪事件 → readyOps

`processReadyEvents`(`SelectorImpl.java:279-304`)把平台传来的就绪位翻译成 key 的 readyOps:

- key 已在 selectedKeys 中 → `translateAndUpdateReadyOps` 累加更新(`:291-294`)
- 不在 → `translateAndSetReadyOps` 设置后加入 selectedKeys(`:295-300`)
- 有 action 时直接回调(`:282-288`)

面试"select 返回后做什么": 遍历 selectedKeys,按 key 的 readyOps 分支处理(读/写/连接/接受)。

关键设计(斜体):*"骨架 + 平台 doSelect"是模板方法——共享层管 key/就绪消费,平台层只管内核等待。面试"select 阻塞在哪": 平台 doSelect(linux 上是 `EPoll.wait`,`EPollSelectorImpl.java:120`);面试"select() vs selectNow()": 无限阻塞 vs 立即返回(0 与 -1 两个哨兵值)。*

## 3. "selectedKeys 怎么消费" — 就绪键集

### 3.1 一次性快照

`selectedKeys()`(`Selector.java:344`)返回就绪键集合——只读集合但**允许 remove**(实现是 `ungrowableSet` 包装,`SelectorImpl.java:70`)。经典事件循环:

```java
// 用法示意(API 形式,非源码片段)
while (selector.select() > 0) {
    Iterator<SelectionKey> it = selector.selectedKeys().iterator();
    while (it.hasNext()) {
        SelectionKey key = it.next();
        // 按 key.readyOps() 分支处理(读/写/连接/接受)
        it.remove();          // 必须 remove!
    }
}
```

**不 remove 的后果**: 已处理的 key 下次遍历仍会出现,同一事件被反复处理;且新就绪事件会覆盖/累加 readyOps,状态混乱。框架不自动清——消费与清理是应用的责任。

### 3.2 配套机制

- 取消队列: `processDeregisterQueue`(`SelectorImpl.java:244-271`)在每次 select 时处理被 cancel 的 key(implDereg 注销通道)
- 关闭: `implCloseSelector`(`:177-196`)先 `wakeup()` 唤醒阻塞的 select,再逐个注销

关键设计(斜体):*selectedKeys 是"一次性快照"——消费后必须 remove,框架不自动清。面试"为什么 iterator.remove()": 否则同一 key 反复处理;生产: 高并发服务器的事件循环(Netty boss/worker 线程的同构思想)。*

## 4. "wakeup" — 唤醒阻塞中的 select

### 4.1 语义

`wakeup()`(`Selector.java:609`): 让**阻塞中的 select 立即返回**(线程安全,可被其他线程调用)。典型场景: 优雅关闭、或要 select 醒来处理新注册的通道(`implCloseSelector` 先 wakeup 再注销,`SelectorImpl.java:178`)。

### 4.2 linux 实现: 自管道

构造时 `IOUtil.makePipe` 建一对管道 fd(读端 fd0/写端 fd1,`EPollSelectorImpl.java:83-85`;native 实现是 `pipe(2)`,`unix/native/libnio/ch/IOUtil.c:87-89`),把**管道读端 fd0 注册进 epoll 监听可读**(`:93`):

```java
// EPollSelectorImpl.java:92-93(截取,逐字)
        // register one end of the socket pair for wakeups
        EPoll.ctl(epfd, EPOLL_CTL_ADD, fd0, EPOLLIN);
```

`wakeup()` 向另一端 fd1 **写一个字节**(`EPollSelectorImpl.java:250-258`):

```java
// EPollSelectorImpl.java:250-260(截取,逐字)
    public Selector wakeup() {
        synchronized (interruptLock) {
            if (!interruptTriggered) {
                try {
                    IOUtil.write1(fd1, (byte)0);
                } catch (IOException ioe) {
                    throw new InternalError(ioe);
                }
                interruptTriggered = true;
            }
        }
        return this;
    }
```

fd0 可读 → epoll_wait 因这个事件返回 → `doSelect` 的 `processEvents` 识别出 fd0 并标记 interrupted(`EPollSelectorImpl.java:191-192`),随后 `clearInterrupt` 把管道读空(`:262-267`,`IOUtil.drain(fd0)`)。

面试"wakeup 原理": 自管道——不依赖信号,用 fd 事件让内核等待自然醒来。

关键设计(斜体):*"自管道唤醒"是跨平台经典技巧——向管道写一字节,epoll 因管道可读返回,等待解除。面试"wakeup 原理": 自管道写入;生产: 优雅停机/动态注册新通道都要先 wakeup。*

跨层标注: [域 19 BufferChannel——就绪后读写的 Buffer 是数据载体;内部卷 01-os——fd 就绪语义是 select/poll/epoll 的统一抽象]

## 核心悬念

骨架通了——**linux 上内核等待怎么实现**?`EPollSelectorImpl` 的 epfd、`EPoll.create/ctl/wait` 三个 native 调用、事件表在内核的 O(1) 就绪查询、与 select/poll 的差别——下一篇: epoll 实现与平台分层。

> → [21-selector-nio/02 — epoll 实现与平台分层](02-epoll-platform.md)
