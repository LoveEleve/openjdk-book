# 单线程 select 循环：一个线程怎样管住所有连接

> 本文基于 JDK 11 `Selector` / `SelectionKey` / `SocketChannel` / `ServerSocketChannel` 实现。前置：Ch1 ByteBuffer 三篇、Ch2 Channel 三篇、Ch3-01 `01-selector-model.md`；本文把 Selector 真正落成一个最小单线程 Reactor 循环，工程陷阱的更深一层放到 Ch3 后续篇章。

## Selector 已经告诉你“谁值得继续”，接下来循环怎么写

上一节把 Selector 的角色立住了：它不是做 I/O 的对象，而是一张等待时机调度表。Channel 先 register 进来，Selector 再统一观察 interest set，一旦某个 key 现在值得继续推进，就把结果写回 `readyOps` 并放进 `selectedKeys`。

可光知道这个模型还不够。

因为到了真正写服务端循环时，读者很快就会发现：API 懂了，不代表程序就能跑对。你大概已经能写出这样的骨架：

```text
while (true) {
    selector.select();
    for (key in selectedKeys) {
        处理 key
    }
}
```

问题在于，真正的坑几乎全在“处理 key”这四个字里。

- `isAcceptable()` 时只 accept 一下够不够？
- `isReadable()` 后 `read()` 返回 0 或 -1 怎么收尾？
- `OP_WRITE` 为什么不能默认一直挂着？
- 处理完一个 key 后，到底是 `iter.remove()` 还是 `key.cancel()`？
- `close()` 之后为什么 selector 里还可能暂时看见这把 key？

这些细节如果处理不好，单线程 Reactor 并不会优雅地管理 1000 个连接，反而会退化成另一种形式的混乱：结果集越来越脏、写事件常驻空转、半包状态被清掉、失效 key 反复撞进循环。

所以这一篇真正要讲的，不是“有个 while 循环”，而是：单线程 select loop 必须形成一个严格闭环。

```text
阻塞等待
  -> 取出本轮值得处理的 key
  -> 按事件类型分流
  -> 处理完立刻消费并清理结果
  -> 回到下一轮等待
```

只要这四步里有一步偷懒，NIO 就会从“多路复用”退回“忙轮询”或“脏状态机”。

## 一、一个线程怎样同时管住所有连接

先把最朴素的对照摆出来。

BIO 服务端最自然的写法，往往是：

```text
while (true) {
    Socket client = server.accept();
    new Thread(() -> handle(client)).start();
}
```

它的优点是直觉很强：谁连进来，就给谁一个线程；谁在读，就让谁在自己的线程里等。

但这套直觉的代价也很直接：连接数一多，线程数就跟着涨。每个线程都在等待自己的那个连接，连接多了之后，系统花在上下文切换、栈空间和调度上的成本会越来越高。

单线程 select loop 走的是完全不同的路线。

它不是给每个连接一个线程，而是先让所有连接都变成非阻塞，再把“谁值得继续处理”这件事统一交给 Selector。这样一来，线程就不再分配给连接本身，而是分配给“这一轮所有就绪事件的统一消费”。

换句话说：

```text
BIO: 一个线程盯一个连接
NIO select loop: 一个线程盯所有连接的就绪时机
```

这里必须强调一个边界：单线程 select loop 不等于“所有业务逻辑都必须单线程执行”。这一篇只讨论 I/O 等待与最小 Reactor 骨架：也就是谁负责 `select()`、谁负责 `accept/read/write/finishConnect()` 这一层的调度。至于后续业务处理是否继续交给别的执行器，不属于本篇主线。

## 二、select loop 的四步闭环：等、取、分流、清理

一个最小可工作的 select loop，真正关键的不是 `while (true)`，而是每一轮都必须按同一闭环走完。

### 第一步：等 —— 统一把线程停在 select 上，而不是停在某个 Channel 上

循环开头最重要的一句，通常是：

```text
int n = selector.select();
```

这里的意义不是“取出若干 key”那么简单，而是把当前线程的等待位置，从某一个具体 Channel 的 `read()` / `accept()` 上，抽到了 Selector 这一层。

JDK 文档在 `Selector` 上已经给过最小合同：`select()`、`select(timeout)` 和 `selectNow()` 唯一的本质区别，就是是否阻塞以及阻塞多久，见 `Selector.java:163-165`。因此在最小 Reactor 里，`select()` 这一步承担的是：

```text
如果这轮还没有任何值得处理的事件
  -> 线程就在 Selector 这里统一等待
而不是在某个单独 Channel 上等待
```

这就是多路复用真正成立的地方。

### 第二步：取 —— 从 selectedKeys 里拿出“本轮值得继续”的关系

一旦 `select()` 返回，真正要处理的不是 Channel 本身，而是 `selectedKeys()` 里的那批 key。因为上一节已经建立过：Selector 维护的是注册关系与就绪结果，真正从中取数的是 `SelectionKey`。

于是最小骨架通常长成这样：

```text
Iterator<SelectionKey> iter = selector.selectedKeys().iterator();
while (iter.hasNext()) {
    SelectionKey key = iter.next();
    ...
}
```

这一步看似平淡，实际上已经把整个模型压缩得很清楚：

- 先由 Selector 统一生产结果
- 再由事件循环逐个消费结果
- 结果集不是自动快照，而是要你亲手迭代、亲手收尾

### 第三步：分流 —— 按 ready 事件决定现在该推进哪一步

拿到 key 之后，循环才真正开始“做事”。

可它做的不是一个统一动作，而是按 ready 事件分流。

- `isAcceptable()`：说明现在值得 accept 新连接。
- `isReadable()`：说明现在值得 read 现有连接。
- `isConnectable()`：说明现在值得回来执行 `finishConnect()`。
- `isWritable()`：说明之前被卡住的写操作现在值得继续推进。

这也解释了为什么上一节必须先把 `SelectionKey` 讲清楚：select loop 的分流不是靠 Channel 类型瞎猜，而是靠 key 上已经写好的 readiness 位。

### 第四步：清理 —— 结果不消费干净，下一轮就会带着脏状态继续跑

很多人写 select loop 时，最容易漏掉的不是 select，也不是分流，而是“结果怎么收尾”。

如果 `selectedKeys` 里的条目处理完后不被消费掉，那么下一轮循环就可能继续看见这些旧结果。上一节已经解释过，这不等于 JDK 出错，而是你把结果集消费责任丢在了半路。

所以一个真正闭环的 select loop，最后一步不是“处理完就算了”，而是：

```text
这轮结果已经消费完
  -> 从 selectedKeys 里移除
  -> 再回到下一轮 select
```

只有这样，下一轮看到的才是新的等待与新的就绪结果，而不是上一轮的残影。

## 三、四类分支在循环里各做什么

闭环有了，接下来就要看每个分支到底承担什么责任。

### 1. Accept：把新连接纳入管理，而不是只把它接进来

`OP_ACCEPT` 分支最容易写得过浅。

很多人直觉上觉得，`isAcceptable()` 之后最重要的动作就是 `accept()`。这当然没错，但如果只停在这一步，你得到的只是一个新 child channel，还没有把它真正纳入单线程循环的管理范围。

最小动作链其实是：

```text
ServerSocketChannel server = (ServerSocketChannel) key.channel();
SocketChannel client = server.accept();
client.configureBlocking(false);
client.register(selector, OP_READ, attachment);
```

这里最容易漏掉的，是中间那句 `configureBlocking(false)`。

Ch2-02 已经证实过：`accept()` 返回的新 `SocketChannel` 默认仍然是阻塞模式。所以如果你只 accept 而不把它切成非阻塞，就算监听 socket 本身是非阻塞的，整个“一线程多连接”的前提也会在 child channel 上立刻断掉。

于是 Accept 分支真正的职责，其实是三件事：

- 拿到新连接
- 把它切到非阻塞
- 用合适的 interestOps 和 attachment 把它注册回 Selector

只有走完这三步，这个新成员才算正式加入当前 loop 的管理体系。

### 2. Read：把 Ch2 的 `read -> flip -> process -> compact` 接回来了

`isReadable()` 分支是 Ch2 全部铺垫真正落地的地方。

当一个已连接的 `SocketChannel` 对应的 key 变成 readable，你通常会拿到 attachment 里的 Buffer，然后执行读取：

```text
SocketChannel ch = (SocketChannel) key.channel();
ByteBuffer buf = (ByteBuffer) key.attachment();
int n = ch.read(buf);
```

接下来分三种情况。

第一种，`n > 0`。这说明本轮确实读进了新数据，于是你才进入 Ch2 已经建立好的那条最小循环：

```text
buf.flip();
process(buf);
buf.compact();
```

第二种，`n == 0`。这在非阻塞模式下表示这次没有新进展。注意：被 select 标成 readable 并不等于你这次 read 就一定读出正数，边界条件仍由 Channel 自己的合同决定。这里的正确动作通常不是清空 Buffer，更不是死循环继续读，而是保持当前 attachment 状态，让 loop 回到下一轮。

第三种，`n == -1`。这表示对端输入方向结束。此时最小服务端通常就该关闭这个 channel，让它进入后续的 cancel / deregister 流程。

所以 Read 分支真正干的，不是“读一下而已”，而是把 Ch2 那条状态机完整接回来：

```text
read(buf)
  -> n > 0  : flip -> process -> compact/clear
  -> n == 0 : 暂无进展，保持现场
  -> n == -1: 关闭连接
```

### 3. Connect：把第二拍收口，而不是在这里重新 connect

`OP_CONNECT` 在服务端最小骨架里不一定出现，但在客户端或混合 loop 中必须有一席之地。

它和 Ch2-02 的关系很直接：`connect()` 返回 `false` 后，正确做法不是忙等，也不是重复发起 `connect()`，而是等 selector 在某一轮把这个 key 标成 connectable，再回来执行 `finishConnect()`。

所以 Connect 分支的主线非常短：

```text
if (key.isConnectable()) {
    SocketChannel ch = (SocketChannel) key.channel();
    if (ch.finishConnect()) {
        ...
    }
}
```

本篇不重复展开两拍 connect 的全部细节，只回收一个最重要的事实：Selector 交给你的不是“连接已经成功”的承诺，而是“现在值得回来做第二拍”的时机。

### 4. Write：只有写不动后，才值得请 Selector 提醒你继续写

四类分支里，Write 最容易把整个 loop 写坏。

因为很多人看到 `isWritable()`，会自然推导成一个危险心智模型：既然 write 也是一种事件，那我平时就把 `OP_WRITE` 一直挂在 interestOps 里，需要发数据时自然就会收到提醒。

这正是 select loop 最常见的空转来源之一。

上一节已经建立过：`OP_WRITE` 表示“当前可继续写”，而在常见 socket 场景下，这个状态很容易持续成立。所以如果你没有待发送数据却长期关心 `OP_WRITE`，selector 往往会反复把这个位交回来，线程看似很忙，实际上只是在处理一个“本来就总容易成立”的 readiness。

正确心智模型应该反过来：

- 平时默认不持有 `OP_WRITE`
- 先直接尝试 `channel.write(buf)`
- 只有写到一半、返回 0、remaining 还在时，才临时把 `OP_WRITE` 加进 interestOps
- 下次真正收到 writable 后继续写
- 写完立刻把 `OP_WRITE` 从 interestOps 移掉

可以把它压成这样：

```text
while (buf.hasRemaining()) {
    int n = channel.write(buf);
    if (n == 0) {
        key.interestOps(key.interestOps() | OP_WRITE);
        break;
    }
}

下次 isWritable():
  -> 继续 write
  -> 写完后 interestOps &= ~OP_WRITE
```

这套写法背后的本质，其实和 Ch2 的部分进度完全一致：Selector 不是帮你“生成写请求”，而是帮你在“上一次写被卡住之后”提供下一次继续写的时机。

## 四、为什么 `iter.remove()` 和 `key.cancel()` 不是一回事

写 select loop 时，另一个特别容易混的点，是把“消费 selectedKeys 结果集”与“注销注册关系”混成同一个动作。

这两件事必须分开。

### `iter.remove()` 清的是本轮结果，不是注册关系

当你在 `selectedKeys().iterator()` 上调用 `iter.remove()` 时，你移除的是“这条 key 在当前结果集里的这一份结果”。

这意味着：

- 它不会把 key 从 selector 的 key set 注销掉。
- 它不会让 channel 失去注册关系。
- 它只是在说：这轮 select 交给我的这个结果，我已经消费完了。

所以 `iter.remove()` 的职责，是让结果集闭环，而不是管理生命周期。

### `key.cancel()` / `channel.close()` 清的是注册关系，但也不是立刻删光

反过来，`key.cancel()` 或 `channel.close()` 处理的，是生命周期问题。

`AbstractSelectableChannel.implCloseChannel()` 已经说明：当 channel 关闭时，它会把自己所有 key 都 `cancel()` 掉，见 `AbstractSelectableChannel.java:241-258`。而 `cancel()` 并不会同步立刻把 key 从 selector 全部集合里抹掉，它只是先把这把 key 加进 `cancelledKeys`，见 `AbstractSelector.java:88-94`。

真正的清理发生在后续 selection 里的 `processDeregisterQueue()`：JDK 会遍历 cancelled-key set，执行底层 `implDereg`，再从 `selectedKeys`、`keys` 和 channel 自己的 key set 里把它摘掉，见 `SelectorImpl.java:244-268`。

所以这里正确的两步模型必须再次强调：

```text
close / cancel
  -> 先宣布这把 key 作废
下一次 selection
  -> 再统一从各套集合里移除
```

这也是为什么循环里处理 key 时，不能想当然地认为“只要它还在集合里就一定有效”。JDK 文档已经明确提醒：key 出现在 selector 的某个集合中，并不保证它现在仍有效，见 `Selector.java:220-224`。

于是最稳妥的心智模型就变成：

- `iter.remove()`：消费本轮结果
- `cancel()/close()`：宣布注册关系作废
- 后续 selection：统一做真正的 deregister 清理

只要把这三层职责分开，selectedKeys、cancelledKeys、keys 三套集合就不会在脑子里打架。

## 五、把最小 NIO 服务端骨架拼出来

现在可以把前面所有零件拼成一个最小骨架了。

```text
1. ServerSocketChannel.open()
2. bind(local)
3. configureBlocking(false)
4. Selector.open()
5. server.register(selector, OP_ACCEPT)
6. while (true) {
       selector.select();
       iterate selectedKeys {
           if (!key.isValid()) {
               remove and continue;
           }
           if (key.isAcceptable()) {
               accept -> child configureBlocking(false) -> register(OP_READ, attachment)
           } else if (key.isReadable()) {
               read -> n>0: flip/process/compact ; n==-1: close
           } else if (key.isConnectable()) {
               finishConnect() and adjust interestOps
           } else if (key.isWritable()) {
               continue write and remove OP_WRITE when done
           }
           iter.remove();
       }
   }
```

这段骨架之所以重要，不是因为它能直接拿去做生产代码，而是因为它第一次把前面三章的知识真正串成了一套能运行的心智模型：

- Ch1 提供 Buffer 状态机
- Ch2 提供 Channel 的返回值与部分进度
- Ch3-01 提供 Selector 的 register / key / selectedKeys 语义
- 本篇把它们压成一个单线程 I/O 调度闭环

所以单线程 select loop 的价值，绝不只是“线程更少了”。它真正改变的是：线程不再绑定连接，而是绑定“当前所有值得推进的 I/O 机会”。

## 收网：这就是 Netty EventLoop 的最小前身

走到这里，应该已经能看见 Netty EventLoop 的影子了。

裸 NIO 的单线程 loop 已经具备了最小 Reactor 的骨架：

```text
一个 Selector
一个线程
若干注册关系
一轮轮 select
按事件分流处理
结果集消费完再进入下一轮
```

但它也暴露了很多原始感很强的细节：

- 你得自己写 `if (key.isAcceptable()) ... else if ...`
- 你得自己管理 attachment
- 你得自己控制 `OP_WRITE` 何时加、何时删
- 你得自己记得 `iter.remove()`
- 你得自己理解 `cancel()` 的异步清理窗口

Netty 后面并不是推翻这套模型，而是把这些原始步骤收编进更稳定的运行时结构：EventLoop 管 select，Pipeline 管事件分发，ChannelOutboundBuffer 管写半包与 `OP_WRITE` 的开关。

所以这一篇最该带走的结论不是“NIO 可以一个线程处理很多连接”这么泛，而是这句更具体的话：

```text
单线程 select loop 的核心，不是 while(true)
而是“等 -> 取 -> 分流 -> 清理”四步必须闭环
```

下一篇进入 Selector 的工程陷阱。到那时，我们会专门把本篇还没有彻底展开的生产级问题拆开：为什么 select 会空轮询、为什么 wakeup 有竞态、为什么 selectedKeys 的实现还能继续优化，以及 Netty 后来是怎么把这些坑一个个补上的。