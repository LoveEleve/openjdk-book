# 01. Selector 抽象与选择机制 — 三件套、注册、select 流程

> 本文基于 JDK 11 `Selector`、`SelectionKey`、`SelectableChannel`、`SelectorImpl` 与 Linux `EPollSelectorImpl` 的唤醒骨架。本文聚焦注册/选择/消费三段式、interestOps/readyOps、selectedKeys、`wakeup()` 机制；epoll 细节平台层放下一篇。本文讨论的是 JDK 11 Selector 抽象机制，不把这里的 key 集合语义、自管道唤醒方式和 Linux 示例实现外推成所有平台、所有 NIO 框架都必须遵守的统一规范。
> **前置依赖**：[19-buffer-channel/01 — Buffer 状态机](../19-buffer-channel/01-buffer-state-machine.md)(就绪后读写的 Buffer 载体)
> **后续**：[21-selector-nio/02 — epoll 实现与平台分层](02-epoll-platform.md)

## 为什么一个线程能管上万连接,关键不是它更忙,而是它不再替每个连接单独睡着等

BIO 的直觉很简单: 一个连接配一个线程,线程阻塞在 read 上等数据。连接数一多,问题也跟着一比一膨胀——一万个连接就是一万个线程,大部分线程都在各自的阻塞点上睡着。NIO 真正改变的不是“一个线程突然变强了”,而是**把等待某个连接变得可读/可写这件事,从每个连接自己的阻塞 read 上剥离出来,集中外包给 Selector 统一处理**。

这意味着应用线程不再负责“替每个连接等事件”,而是只负责两件事: 先声明自己对哪些事件感兴趣,再在 Selector 告诉它“这些连接已经就绪”之后去消费结果。真正盯着 fd 是否可读/可写、真正把海量等待合成一次阻塞的,是内核和 Selector 背后的平台实现。

所以这一篇的主线不是 API 列表,而是沿着这个总问题展开: 为什么三件套(Selector/SelectionKey/SelectableChannel)要分工,为什么 `interestOps` 和 `readyOps` 不能混成一份状态,以及为什么 `wakeup()` 最终必须被翻译成一个内核可见的事件,才能把阻塞中的 `select` 叫醒。

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

## 七、五个最容易混掉的边界：Selector 不是线程轮询器，interest 不等于 ready，selectedKeys 不是历史缓存，wakeup 不是 Java 标记，selectNow 也不是 wakeup

在收网之前，先把这一篇最容易记错的五条边界压实。

第一，Selector 不是“一个线程自己轮询所有连接”。真正盯着 fd 是否可读/可写的不是应用线程，而是内核等待机制。应用线程只是把兴趣登记出去，再在就绪结果回来后消费 selectedKeys。

第二，`interestOps` 也不等于 `readyOps`。前者表达的是“我长期关心什么”，后者表达的是“这一次真正发生了什么”。把这两套位图混成一份状态，就会把配置和结果搅在一起，后面事件循环一定会乱。

第三，`selectedKeys` 也不是框架自动清理的历史缓存。它是这一轮已经就绪、等你消费的工作清单；不 remove，就等于告诉事件循环“这批活我还没处理完”，同一个 key 很容易被反复看见。

第四，`wakeup()` 更不是改一个 Java 布尔位就能把阻塞中的 `select` 叫醒。阻塞发生在内核等待里，所以唤醒也必须制造一个内核可见事件；自管道的本质，就是把“我要你醒”翻译成“某个 fd 现在可读了”。

第五，`selectNow()` 也不是 `wakeup()` 的另一种写法。`selectNow()` 是调用方主动选择“不等，立即看看现在有没有就绪事件”；`wakeup()` 则是别的线程在你已经阻塞等待时，强行把这次等待打断。一个是等待策略，一个是外部控制信号。

把这五条边界记稳，Selector 这一篇就不会重新塌回“一个线程管很多连接”的口号印象。它真正讲的是：等待怎样从每个连接自己的阻塞点上被剥离出来，再通过兴趣登记、内核等待、就绪翻译和事件清单消费重新组织起来。

## 收网：Selector 真正做的不是“替线程多干活”，而是把等待这件事集中外包给内核与选择器骨架

回到开头那个问题，现在已经能看清为什么一个线程能管理很多连接，并不是因为它忽然获得了更多算力，而是因为它不再替每个连接单独睡下去。Selector 机制真正做的，是把“等连接什么时候可读/可写”这件事，从每个通道自己的阻塞调用里剥离出来，集中交给三件套与平台 `doSelect` 去完成。

这也把整篇的主线收回来了：

- `SelectableChannel` 负责声明兴趣；
- `Selector` 负责统一等待；
- `SelectionKey` 负责承载兴趣位与就绪位这份配对关系；
- `selectedKeys` 则把本轮结果交回应用线程消费；
- `wakeup()` 再把外部控制动作翻译成一个内核可见事件，保证阻塞等待能被安全打断。

把整篇压成一张总图，就是：

```text
通道
  → 声明 interestOps

Selector
  → 平台 doSelect 统一等待
  → 把内核就绪翻译成 readyOps

应用线程
  → 遍历 selectedKeys
  → 处理后主动 remove

外部控制
  → wakeup 制造自管道可读事件
  → 打断阻塞中的 select
```

如果说这一篇解决的是“为什么等待能从每个连接自己的阻塞点上被集中剥离出来”，下一篇就会继续往 Linux 平台层走：`EPollSelectorImpl` 到底怎样把这套抽象焊到 epoll 的 create/ctl/wait 三调用上。
