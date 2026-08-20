# 阻塞与非阻塞：同一个 Channel，谁来负责等待

> 本文基于 JDK 11 NIO `SocketChannel` / `ServerSocketChannel` 实现。前置：Ch1 ByteBuffer 三篇、Ch2-01 `01-read-write.md`、Ch2-02 `02-connect-accept.md`；本文收束 Channel 这一章，把阻塞/非阻塞的等待责任、兼容桥和最小收发循环接成一条线，Selector 放到 Ch3。

## 同一个 read，为什么改一个开关就像换了一门编程模型

前两篇其实已经零散碰到了这个问题。

我们已经看过：

- `read()` 在非阻塞模式下可以返回 `0`，表示现在没数据，但线程没有被卡住。
- `connect()` 在非阻塞模式下可以先返回 `false`，表示连接正在进行中，后面还要 `finishConnect()`。
- `accept()` 就算监听 socket 是非阻塞的，新返回的 child channel 也默认还是阻塞。

这些现象如果单独看，会觉得 NIO 很碎：这里一个 `0`，那里一个 `false`，另一头又冒出一个“默认阻塞”的 child channel。可如果退一步，它们其实都在围绕同一个总问题打转：

```text
当这一步暂时做不下去时，谁来负责等待？
```

阻塞模式的答案是：API 自己等。

- 没数据？`read()` 自己等。
- 连接还没建好？`connect()` 或 `finishConnect()` 自己等。
- 还没有新连接？`accept()` 自己等。

非阻塞模式的答案则完全相反：API 不等，调用方自己决定接下来怎么办。

- 没数据？`read()` 先返回 `0`。
- 连接未完成？`connect()` / `finishConnect()` 先返回 `false`。
- 没有新连接？`accept()` 返回 `null`。

所以“阻塞”和“非阻塞”真正切开的，不是类名，也不是方法名，而是等待责任的归属。

这也是很多人第一次学 NIO 最别扭的地方。你表面上仍在调用同一个 `SocketChannel.read(buf)`，可背后的编程模型已经变了：从“我调用一个会替我等好的操作”，变成“我调用一个会把当前进展报告给我的操作”。

这一篇就把这条主线完整收拢起来：先看 `configureBlocking` 到底切换了什么，再把 `read/write/connect/accept` 四种动作放在同一张表里对照，最后落到最经典的一段收发循环：`read -> flip -> process -> compact`。

## 一、configureBlocking：切换的不是方法名，而是谁来等

NIO 最容易让人误解的一点，是看上去只有一个很轻描淡写的开关：`configureBlocking(true/false)`。

可这个开关一旦翻过去，同一个 Channel 的语义就完全变了。

JDK 在抽象层面的写法非常直接。`AbstractSelectableChannel` 里用一个 `nonBlocking` 标志保存当前模式：`isBlocking()` 实际上是返回 `!nonBlocking`；而 `configureBlocking(block)` 在必要时调用 `implConfigureBlocking(block)`，然后把 `nonBlocking` 改成对应值，见 `AbstractSelectableChannel.java:282` 和 `AbstractSelectableChannel.java:298`。

也就是说，阻塞/非阻塞首先是 Channel 对自己行为合同的一次切换。它不是额外包装出一个 `BlockingSocketChannel` 与 `NonBlockingSocketChannel`；它就是同一个对象，在同一组 API 上换了一套等待规则。

到了 `SocketChannelImpl` 这一层，`implConfigureBlocking(block)` 的实现又很短：最终调用 `IOUtil.configureBlocking(fd, block)`，见 `SocketChannelImpl.java:535`。

但这里要立刻加一层边界：`configureBlocking` 改的是 Channel 的阻塞合同，不只是某个孤立 native 开关。`SelectableChannel` 的抽象说明写的是“这个 channel 上的 I/O 操作是否会阻塞直到完成”，而不是“某次系统调用是否立即返回”；同时它还受注册状态约束——一个已经注册到 Selector 的 channel 不能再切回阻塞模式，见 `SelectableChannel.java:266`。

所以 `configureBlocking` 真正要记住的结论只有一句：

```text
它切换的不是“你调用哪个方法”，而是“当前 I/O 暂时做不下去时，等待责任留在方法内部，还是上浮给调用方”。
```

这句话比任何底层细节都更重要。

因为一旦理解成“等待责任切换”，前两篇那些零散现象就能统一起来：

- 非阻塞 `read()` 返回 0，是因为在 Buffer 还有剩余空间、而当前 socket 又暂时没有可读数据时，API 不替你等数据。
- 非阻塞 `connect()` 返回 false，是因为 API 不替你等握手完成。
- 非阻塞 `accept()` 返回 null，是因为 API 不替你等新连接到来。

反过来，阻塞模式并不是“更强大”的另一套 API。它只是把这些等待重新包回方法内部，让调用者继续保留旧 `Socket` 时代那种线性心智模型。

### 一个常见误解：阻塞/非阻塞是两个世界，其实它们只差等待责任

初学时很容易形成一种错觉：BIO 和 NIO 是两套截然不同的世界，前者对应 `Socket`，后者对应 `SocketChannel`；一旦用了 `SocketChannel`，就应该天然进入非阻塞编程。

这个印象不准确。

`SocketChannel` 自己就是可切换的。它并不天然等于非阻塞；同一个 `SocketChannel` 既可以在阻塞模式下像传统 socket 那样线性读写，也可以切成非阻塞模式，开始用返回值表达“现在先做到哪一步”。

所以这里真正的分界线不是“用了哪个类”，而是“你把等待藏在 API 内部，还是把等待暴露给调用方”。这也是为什么本章前两篇必须先讲 `read/write` 和 `connect/accept` 的返回值，再来讲阻塞/非阻塞：如果不先理解返回值是在汇报状态，后面就根本读不懂非阻塞模型。

## 二、把四类动作放在一起：阻塞是方法内等待，非阻塞是状态上浮

到这里，最需要做的不是继续逐个方法讲细枝末节，而是把 `read/write/connect/accept` 四类动作放到同一张图里。

### 1. read：没数据时，是线程停住还是先返回 0

`SocketChannelImpl.read(ByteBuffer)` 在阻塞和非阻塞下共用同一个方法实现，见 `SocketChannelImpl.java:300`。前一篇已经建立过：成功读到数据时返回正数，EOF 返回 `-1`，非阻塞模式下“现在没数据”时会返回 `0`。

真正的模型差异是：

```text
阻塞 read
  -> 调用方说：我现在就要结果
  -> 方法内部等待，直到有数据/EOF/异常

非阻塞 read
  -> 调用方说：你先告诉我当前有没有进展
  -> 有数据返回正数
  -> 没数据返回 0
  -> 以后何时再试，由调用方决定
```

这两种语义最大的区别，不在“最后有没有读到数据”，而在没有读到数据的那一刻，线程归谁支配。

阻塞读把线程留在当前连接上；非阻塞读则把线程还给上层，让它决定是去处理别的连接、注册 Selector，还是暂时退出本轮循环。

### 2. write：写不下去时，是在这里等，还是把剩余进度留下来

`SocketChannelImpl.write(ByteBuffer)` 也是同样的模型，见 `SocketChannelImpl.java:410`。

阻塞写的心智模型很像老式 `OutputStream.write()`：你交给它一个 buffer，它会把“等待当前写操作可继续推进”这件事包在方法内部。这里要注意边界：这并不等于 Java 层自己循环直到整个 Buffer 必定一次写空；JDK 11 在 `SocketChannelImpl.write(ByteBuffer)` 里明确重试的是 `IOStatus.INTERRUPTED` 这种中断路径，见 `SocketChannelImpl.java:457`。非阻塞写则更像一份阶段性进展报告：

```text
写出正数 -> 本轮写出了一部分，position 前进
写出 0   -> 当前先写不动，remaining 还得保留
```

这也是为什么上一节一直强调：非阻塞写返回 0 时，不能把 Buffer 丢掉，也不能在原地死循环继续写。因为 API 已经把“等发送缓冲区再次可写”这件事移交给你了；你要做的不是硬扛，而是保留 remaining，等下一次合适时机。

### 3. connect：是自己等握手，还是先告诉你“正在连”

`connect()` / `finishConnect()` 的两拍模型，本质上只是等待责任的另一种表现。

阻塞模式下，`connect()` 的合同是：要么连上返回，要么失败抛异常。

非阻塞模式下，它把“还没连好”上浮成一个中间状态：

```text
connect() -> true   已连好
connect() -> false  正在连
finishConnect() -> true / false
```

这并不是 connect 特有的怪异设计，而是同一个原则在连接阶段的延续：当前做不完时，不由方法替你等，而是由调用方回来继续推进第二拍。

### 4. accept：是自己等新连接，还是先告诉你“现在没有”

`ServerSocketChannel.accept()` 这边也一样。

阻塞模式下，没有新连接时当前线程继续等；非阻塞模式下，没有新连接就先返回 `null`，见 `ServerSocketChannelImpl.java:274`。它和非阻塞 `read()==0`、非阻塞 `connect()==false` 在抽象上完全对称：

```text
当前没法继续
  -> 阻塞模型：方法内部等待
  -> 非阻塞模型：返回一个“暂时没进展”的信号
```

所以从整章的角度看，NIO 并没有针对每个动作零散发明不同规则。它只是在不同动作上，用不同的返回值把同一个原则显露出来：

- `read()` 用 `0`
- `connect()` / `finishConnect()` 用 `false`
- `accept()` 用 `null`

这些信号形式不同，但语义是同源的：现在先别在这里等。

## 三、为什么 JDK 还保留 SocketAdaptor：因为旧世界还没立刻消失

讲到这里，很多人会自然冒出一个问题：如果非阻塞模型这么不同，JDK 当年怎么和旧 `Socket` / `InputStream` 世界共存？总不能要求所有代码一夜之间全部改写成状态机吧。

JDK 的回答，就是 `SocketAdaptor` 这座桥。

`SocketChannelImpl.socket()` 并不是直接把自己暴露成一个原始对象，而是通过 `SocketAdaptor.create(this)` 产出一个看起来像传统 `Socket` 的外观，见 `SocketChannelImpl.java:185` 和 `SocketAdaptor.java:69`。这说明 `SocketChannel` 从设计上就没想和旧 `Socket` 世界彻底断开，而是给了一个兼容层，让老接口还能继续工作。

### SocketAdaptor 干的，不是把 NIO 变快，而是把 NIO 重新伪装成旧语义

`SocketAdaptor.connect(remote, timeout)` 非常能说明问题，见 `SocketAdaptor.java:87`。

如果没有超时，它直接调用阻塞模式下的 `sc.connect(remote)`。但如果用户要的是传统 `Socket.connect(timeout)` 这种“带超时但看起来阻塞”的语义，JDK 会做一件很有意思的事：先临时把 channel 切到非阻塞，发起 `connect()`；不管这次是否立刻成功，`finally` 都会先把 channel 切回阻塞模式；如果连接还没完成，再在阻塞模式下通过 `pollConnected(to)` 等待时机成熟，最后调用 `finishConnect()` 收尾，见 `SocketAdaptor.java:104` 和 `SocketChannelImpl.java:980`。

它的心智图大概是这样：

```text
传统 Socket.connect(timeout)
  -> 用户期待：像阻塞 connect，但带超时

SocketAdaptor 的做法
  -> 临时 configureBlocking(false)
  -> connect(remote)
  -> 先恢复阻塞语义
  -> pollConnected(timeout)
  -> finishConnect()
```

这特别能说明一件事：传统线性阻塞语义，很多时候不是底层只有这一条路，而是 JDK 可以在内部借助非阻塞步骤拼出一个“看起来像阻塞”的外观。

`SocketAdaptor` 在带超时读这一侧也采用了同一思路。`SocketAdaptor.SocketInputStream.read(ByteBuffer)` 处理带超时的 `InputStream.read` 语义时，并没有另外造一份 BIO 实现，而是借助 `pollRead(to)` 判断是否可读，再调用 `sc.read(bb)`，见 `SocketAdaptor.java:193`。如果没有超时，它就直接走 `sc.read(bb)` 这条阻塞读路径。

所以 `SocketAdaptor` 真正证明的是：

```text
BIO 线性接口 ≠ 底层一定不是 NIO
很多旧接口语义，可以由 NIO channel + 等待策略重新拼装出来
```

### 但这座桥解决的是兼容，不是改写底层模型

如果只看到“JDK 能把 `SocketChannel` 适配成 `Socket`”，很容易产生另一个误解：既然桥都造好了，是不是底层模型就和 NIO 没什么差别了。

至少从当前源码能直接证明的部分来看，不是这样。

`SocketAdaptor` 提供的是一个旧 `Socket` 外观：调用方看到的仍是阻塞式 `connect/read` 合同；为了维持这个合同，适配层会在内部临时切换模式、等待可读/可连接时机，再把结果包装回传统接口。也就是说，这一层解决的是兼容问题，而不是消除阻塞/非阻塞的模型差异。

- 站在适配层外面，老 `Socket` 代码可以继续按线性方式调用。
- 钻到适配层里面，你会看到它仍然在借助 `SocketChannel`、`pollRead`、`pollConnected` 和 `finishConnect()` 来拼装这种外观。

理解这一点，对读 Netty 很重要。Netty 后续不会提供一个“看起来还是旧 Socket”的主接口；它是沿着等待责任上浮这条路继续往前走，把这些等待时机收编进 EventLoop。 

## 四、最小收发循环：为什么 flip/compact 总是在最关键的地方出现

到这里，可以把 Ch1 的 ByteBuffer 与 Ch2 的 Channel 真正接起来了。

前面已经讲了很多“等待责任”的抽象话，可它们最终都要落到一段非常朴素的收发循环里。因为无论阻塞还是非阻塞，网络收发的日常工作总绕不开这几步：

```text
n = read(buf)
if (n > 0) {
    flip()
    process(...)
    compact() / clear()
} else if (n == 0) {
    暂时没有新数据，等待下一次时机
} else {
    EOF，结束输入方向
}
```

这几步之所以经典，不是因为它们语法优美，而是因为它们刚好把“本轮读到了多少”“消费了多少”“还剩多少”这些进度全部接住了。

### 1. read：把本轮新增数据追加到写区末尾

调用 `channel.read(buf)` 时，ByteBuffer 还处在“准备写入新数据”的状态。谁来记录本轮到底写进来多少？不是调用方手动算，也不是 Channel 额外给你建一份对象，而是直接推进 ByteBuffer 的 position。

如果本轮读了 n 个字节，position 就前进 n；如果非阻塞读返回 0，position 不变；如果返回 -1，说明对端输入方向结束。

这一步真正保存的，是“本轮读操作之后，Buffer 里有效数据写到了哪里”。

### 2. flip：把“写到哪了”翻成“能读到哪了”

read 结束后，Buffer 内部已经积累了一段可供业务处理的数据，可它此时仍站在“写模式”里。`flip()` 的作用不是复制数据，而是做一次边界翻译：把当前 position 变成新的 limit，再把 position 归零。

这样接下来读取业务数据时，读取方看到的不是整个 capacity，而是“这轮真实写入到哪里为止”，这正是 Ch1 第一篇建立过的核心状态机。

所以 `flip()` 做的不是魔法，而是这句很朴素的事情：

```text
刚才写到哪
  -> 现在就只能读到哪
```

### 3. process：真正的难点不在“读”，而在“可能只处理了一半”

如果业务逻辑总能一次把 Buffer 里的内容全部吃掉，那事情就简单得多；你处理完后直接 `clear()`，下一轮继续读就行。

麻烦恰恰出在很多真实协议都不是这样。

比如你本轮读到了半个消息，或者读到了一个半消息：

- 半个消息：现在还不能完整解析，得把这一半留到下一轮。
- 一个半消息：前一个消息处理完了，后半个消息还得留下来等补齐。

这就是为什么 NIO 的经典循环不是无条件 `read -> flip -> process -> clear`，而是在“可能只处理了一部分”时走 `compact()`。

因为一旦“只处理了一部分”成为常态，Buffer 就必须能保存剩余现场；只有在当前有效数据已经全部消费完时，`clear()` 才是更直接的选择。

### 4. compact：不是清空，而是把未处理尾巴搬到前面

`compact()` 最容易被误解成“差不多就是 clear 的另一种写法”。这完全不对。

`clear()` 的意思是：我认为当前内容已经都没用了，下一轮从头写。

`compact()` 的意思则完全不同：我知道前半段已经消费掉了，但后半段仍然有效，请把这一段未读内容前移到开头，再把 position 放到这段剩余数据后面，让下一轮 `read()` 能接着追加。

可以把它想成这样：

```text
flip 后可读区：
[已处理][未处理........]
         ^ position

compact 后：
[未处理........][空位......]
            ^ 新 position
```

这一步非常关键，因为它把“协议可能读半包”这个现实，准确落回了 ByteBuffer 的状态机里。没有 `compact()`，你就只能在业务层手动搬数据，或者干脆丢掉半包内容。

所以这一整套最小收发循环，真正想解决的不是“API 怎么连起来写”，而是“多次读写之间，进度如何被保存”。它和非阻塞模型天然是一对：

- 非阻塞 `read()==0` 时，如果 Buffer 还有空位，你保留当前 Buffer，等下一次时机。
- 非阻塞 `write()==0` 时，你保留当前 remaining，等下一次可写时机。
- `flip/compact` 正是在帮你保存这种“这次还没做完”的现场。

## 五、为什么 clear 只在“全吃完”时才成立，非阻塞写也有它自己的 compact 时刻

这里再把最容易犯的错误单独掰开讲一下。

### 错误方案一：process 后直接 clear

如果每次 process 都默认“肯定处理完了”，那你会很自然写成：

```text
read(buf)
flip()
processAll(buf)
clear()
```

这种写法只有在一个前提下才安全：你真的已经消费完了 Buffer 里全部有效数据。

一旦 process 只做了一部分，`clear()` 就会把剩余现场直接抹掉。这也是为什么正文方法论一直强调要推演失败方案：因为只说 `compact()` 很重要，读者未必意识到它到底在防哪个错。真正让人记住它的，是“如果这里用 `clear()`，半包就没了”。

### 错误方案二：非阻塞写返回 0 后继续原地死循环

读路径有 `compact()` 来保留未消费数据，写路径虽然不调用 `compact()`，但思想是同一个：保留剩余进度。

非阻塞写最经典的循环不是“写到 0 还不停”，而是：

```text
while (buf.hasRemaining()) {
    int n = channel.write(buf);
    if (n == 0) {
        break;
    }
}
```

一旦返回 0，当前 remaining 就是下一轮要继续写的现场。它和读路径中的“未消费尾巴”本质一样：

- 读路径靠 `compact()` 保存未消费输入。
- 写路径靠 position/remaining 保留未发完输出。

这也是为什么 ByteBuffer 在 NIO 世界里显得既强大又别扭：它并不是“装字节的数组替代品”，而是一份 I/O 进度凭证。你读半包也靠它，写半包也靠它。

## 六、把这一章收起来：Channel 负责汇报进展，等待由不同模型分配

现在可以把 Ch2 的三篇主线真正合并成一张图。

### 第一篇告诉我们：read/write 返回值是在汇报进展

- `read() > 0`：读到了数据
- `read() == 0`：现在没数据
- `read() == -1`：输入结束
- `write() == 0`：现在先写不动，剩余内容要保留

### 第二篇告诉我们：连接建立也遵循同一原则

- `connect() == false`：不是失败，是连接进行中
- `finishConnect() == false`：说明还得以后再确认
- `accept() == null`：当前没有新连接
- child channel 默认阻塞：上层还要继续配置

### 这一篇把前两篇收束成模型差异

```text
阻塞模型：
方法内部承担等待责任

非阻塞模型：
方法返回当前进展
等待责任上浮给调用方
```

而 ByteBuffer 的 `flip/compact`，正是这个模型能真正落地的关键胶水。因为只要等待责任上浮，I/O 就很少一次做完；只要不是一次做完，进度就必须被保存。Channel 负责把“这次做到哪一步”告诉你，Buffer 负责把“下一次从哪里继续”保存下来。

## 收网：为什么下一章一定是 Selector

走完这一章，其实会自然冒出一个更大的问题。

如果非阻塞模式下所有等待都不在 API 内部完成，那调用方是不是只能自己忙轮询？

- `read()==0` 了，隔多久再试？
- `write()==0` 了，什么时候再写？
- `connect()==false` 了，何时回来 `finishConnect()`？
- `accept()==null` 了，怎么知道下次会有连接？

这正是裸 Channel 模型走到尽头的地方。非阻塞让线程拿回了控制权，但也把“什么时候值得再试”这个判断扔给了上层。如果上层只是写成 while 死循环，那非阻塞就只是把线程阻塞换成了 CPU 空转。

所以下一章必须是 Selector。它要解决的不是“如何再造一个 Channel API”，而是“既然等待责任已经上浮，怎么用一个统一机制接管这些等待时机”。

到这里，Ch2 的地基就完整了：

```text
ByteBuffer 负责保存进度
Channel 负责汇报进展
阻塞/非阻塞决定谁来等待
Selector 负责告诉你何时值得继续
```

这四句话，基本就是 Netty 整个后续世界的入口。