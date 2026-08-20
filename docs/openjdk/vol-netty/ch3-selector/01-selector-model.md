# Selector 模型：谁来替 1000 个 Channel 统一等消息

> 本文基于 JDK 11 `Selector` / `SelectionKey` / `SelectorImpl` 实现。前置：Ch1 ByteBuffer 三篇、Ch2 Channel 三篇；本文先建立 Selector 的角色、三套 key 集合、四种事件与 `selectedKeys` 语义，完整 select 循环与工程陷阱放到 Ch3 后续篇章。

## 非阻塞已经不等了，可谁来统一等

Ch2 最后留下的悬念其实很尖锐。

我们已经把 `SocketChannel` 切成了非阻塞模式，也已经接受了一个现实：`read()` 返回 `0`、`connect()` 返回 `false`、`accept()` 返回 `null` 都不是失败，而是在告诉调用方“这一步现在先别在这里等”。

问题是，不在这里等之后呢？

如果你只有 1 个连接，最笨的办法是自己 while 循环重试：

```text
read()==0 了
  -> 过一会再 read()
connect()==false 了
  -> 过一会再 finishConnect()
accept()==null 了
  -> 过一会再 accept()
```

可一旦连接数变成 1000，这个办法就暴露出它的荒唐：线程虽然不再阻塞在某一个 Channel 上，但它开始阻塞在“无意义地反复检查 1000 个 Channel”上。你躲开了老式 BIO 的“一连接一卡住”，却掉进了另一种空转：线程不停醒来，却经常什么也做不了。

所以非阻塞模型只完成了一半革命。

- 它解决了“等待不能再藏在单个 API 内部”。
- 但它还没有解决“这些等待现在该由谁统一托管”。

Selector 就是补上这另一半的对象。

它不是用来读数据的，也不是用来写数据的；真正读写的还是 Channel 和 Buffer。Selector 干的事更像一个调度中心：你先把自己关心的等待条件登记进去，然后由它替你统一盯着这些条件；一旦某个条件成立，再把“现在值得继续”的 Channel 交还给你。

如果只记一句话，Selector 的本质可以先压成这样：

```text
Channel 负责做 I/O
Selector 负责告诉你：哪个 Channel 现在值得继续做 I/O
```

这个区分非常重要，因为后面所有 `register`、`SelectionKey`、`selectedKeys`、`wakeup` 的细节，都是围绕这件事展开的。

## 一、register：Channel 怎样正式进入 Selector 的等待名单

既然 Selector 是统一托管等待时机的地方，那第一个问题就变成：Channel 怎么把自己交给它？

答案是 `register`。

`SelectableChannel.register(Selector sel, int ops, Object att)` 的抽象合同说明：它会把当前 Channel 与某个 Selector 建立注册关系，并返回一把 `SelectionKey` 作为这次关系的凭证，见 `SelectableChannel.java:147`。如果 channel 还没有向这个 selector 注册过，就创建新的 key；如果已经注册过，则更新 interest set 和 attachment。

这一步的关键词不是“加入一个容器”，而是“建立一条注册关系”。

因为 Selector 关心的不是“我手上有哪些对象”，而是“这些对象分别在等什么事件”。也正因此，`register` 不只要传入 Selector 本身，还要传入一份兴趣集合 `ops`，也就是：

```text
我不是笼统地把这个 Channel 交给你
我是说：请帮我盯着它的这些事件
```

JDK Java 层的实际注册流程也印证了这一点。

这里要立刻分清两条路径。

- 如果当前 channel 还没有向这个 selector 注册过，JDK 才会走 `SelectorImpl.register(...)`，创建新的 `SelectionKeyImpl`，挂上 attachment，执行底层 `implRegister(k)`，再把 key 放进 selector 的 key set 并设置 interestOps，见 `SelectorImpl.java:199`。
- 如果它已经向同一个 selector 注册过，`SelectableChannel.register(...)` 的合同是直接返回现有 key，并更新 interest set；如果这次传入的 attachment 非空，也会覆盖 attachment，见 `SelectableChannel.java:150-166`。

可以先把 register 的数据流记成这样：

```text
channel.register(selector, ops, attachment)
  -> 若未注册：创建 SelectionKeyImpl
  -> 若已注册：取回现有 key
  -> 更新 attachment / interestOps
  -> 返回这把 key
```

这里最容易犯的第一个误解是：觉得 register 就像把 Channel 塞进一个 List，后面靠 Selector 自己去猜这个 Channel 要干嘛。

事实正相反。Selector 从一开始就不猜，它要求注册时把“你关心什么”讲清楚。否则后面就绪了，它也不知道该把什么样的 readiness 回报给你。

### 为什么 register 前必须先切到非阻塞

上一章已经埋过这个钩子：`SelectableChannel` 如果还在阻塞模式下，注册到 Selector 会直接抛 `IllegalBlockingModeException`，见 `SelectableChannel.java:190`。

这背后的逻辑其实很统一。

Selector 的存在，就是为了把“等待责任”从单个 API 中抽走，统一托管。如果一个 Channel 还处在阻塞模式，那它的 `read()` / `accept()` / `connect()` 仍会把等待留在方法内部；这样一来，就算你把它交给了 Selector，线程还是可能在某个单独调用上停住，整个“一线程管很多连接”的前提就被破坏了。

所以这里不是 JDK 人为规定了一个怪规则，而是模型自身要求：

```text
要交给 Selector 统一等
  -> Channel 自己就不能再偷偷阻塞
```

这也让 Ch2 和 Ch3 严丝合缝接上了：阻塞/非阻塞并不是孤立的模式开关，而是 Selector 能否成立的前置条件。

## 二、Selector 手里其实有三套集合：注册表、结果集、待清理表

如果只把 Selector 想成“一个能 select 的对象”，很快就会在后续 API 上迷路。真正有帮助的心智图，是把它先看成三套集合。

`Selector` 抽象文档在开头就把这件事写得很清楚：一个 selector 维护 key set、selected-key set 和 cancelled-key set 三套集合，见 `Selector.java:49`。

### 1. key set：所有当前注册关系的总表

第一套是 key set，也就是 `keys()` 返回的那一份集合。它存的是“当前仍然注册在这个 Selector 上的所有 SelectionKey”。

JDK 文档的表述很精准：这不是“所有 Channel”，而是“所有当前注册关系的 key”，见 `Selector.java:55`。因为一个 Channel 被 Selector 管理这件事，本质上是通过 key 表达的；你能取消、改兴趣、检查有效性，也都是通过 key 来做，不是直接改 Selector 内部结构。

在 `SelectorImpl` 里，这份集合对应的是 `keys` 字段，初始化为 `ConcurrentHashMap.newKeySet()`，见 `SelectorImpl.java:52` 和 `SelectorImpl.java:67`。

### 2. selected-key set：这次 select 发现“值得继续”的结果集

第二套是 `selectedKeys()` 返回的 selected-key set。它只保存那些在之前某次 selection 操作中，被检测到“至少对某个兴趣事件已经就绪”的 key，见 `Selector.java:59`。

这句话里有两个词必须记住。

第一是“之前某次 selection 操作”。它提醒你：selected-key set 不是实时镜像，而是某次 `select` 之后留下的结果。

第二是“至少对某个兴趣事件已经就绪”。这意味着 selectedKeys 里出现 key，不是因为这个 Channel “存在”，而是因为它“现在值得继续做事”。

在 `SelectorImpl` 里，这份集合对应 `selectedKeys` 字段，底层是 `HashSet`，外面通过 `Util.ungrowableSet` 暴露一个允许删除、不允许添加的 public view，见 `SelectorImpl.java:55`、`:68`、`:70`。

### 3. cancelled-key set：已经判死，但还没来得及正式清掉

第三套是 cancelled-key set。它不会直接暴露给应用，但在 Selector 模型里非常关键，见 `Selector.java:66`。

它装的不是“已经完全没了的 key”，而是“已经被 cancel，但其 channel 还没从 selector 正式注销干净的 key”。这说明 `cancel()` 不是一把删到底，而是先进入待清理队列，等后续 selection 操作统一处理。

这三套集合放在一起，Selector 的内部角色就立起来了：

```text
keys           = 我当前管理着哪些注册关系
selectedKeys   = 这轮已经发现哪些关系值得继续处理
cancelledKeys  = 哪些关系已经作废，等下次统一清理
```

只要这张图在脑子里，后面的 `selectedKeys` 清理和 `cancel()` 异步注销就不会再显得零碎。

## 三、SelectionKey：它不是事件本身，而是“注册关系 + 当前结果”的账本

很多人第一次看 Selector，会把注意力都放在 `select()` 上，反而把 `SelectionKey` 当成某种可有可无的中间对象。

这恰恰会让后面的理解越来越乱。

因为在 Selector 模型里，真正把“注册时我关心什么”和“这次 select 发现了什么”接到一起的，不是 Selector 自己，而是每一把 `SelectionKey`。

可以把它看成一个小账本，至少记三类信息：

- 这把 key 对应哪个 channel
- 这把 key 当前关心哪些事件
- 这把 key 这次已经准备好了哪些事件

在 `SelectionKeyImpl` 里，这几件事都能直接看到：它持有 `channel`、`selector`、`interestOps`、`readyOps`，见 `SelectionKeyImpl.java:52-56`。

于是 `SelectionKey` 的核心价值也就清楚了：

```text
register 时：把“我关心什么”记进 key
select 之后：把“这次准备好了什么”也写回同一把 key
处理阶段：调用方从 key 上取出这两类信息并继续动作
```

这就是为什么正文不能把它讲成“事件对象”。它不是一个瞬时事件包，而是一条持续存在的注册关系记录，只是在 select 之后额外带上了这次的 readiness 结果。

### interestOps 和 readyOps：一个是提问，一个是回答

整套 Selector 模型里最容易混的两个词，就是 interestOps 和 readyOps。

区分它们最简单的办法，不是死背 API，而是把它们当成一问一答。

- interestOps：这是调用方向 Selector 提的问题——我关心哪些事件？
- readyOps：这是 Selector 在某次 selection 之后给的回答——这次哪些事件已经好了？

在 `SelectionKeyImpl.interestOps(int ops)` 里，JDK 会先校验这些 ops 是否是当前 channel 支持的位，然后写入 interestOps，并通过 `selector.setEventOps(this)` 让底层在下一次 selection 时按新的兴趣集合观察，见 `SelectionKeyImpl.java:95`。

而 `readyOps()` 则只是返回这把 key 当前记录的 ready 集合，见 `SelectionKey.java:270` 和 `SelectionKeyImpl.java:128`。

所以两者的关系可以压成一句特别朴素的话：

```text
interestOps = 我想知道什么
readyOps    = 这次真的发生了什么
```

如果把它们混成一回事，就会立刻写出很奇怪的程序。比如 register 时把 `OP_READ` 挂上去，并不代表这个 channel 现在已经可读；它只代表“以后可读时请告诉我”。

### attachment：为什么 Selector 不需要你再自己维护一张 Map

`register` 的第三个参数 `att` 很容易被初学者忽略，以为只是个可有可无的附加物。

实际上它解决的是非常现实的问题：当某个 key 就绪后，处理代码往往还需要顺手拿到与这条注册关系绑定的一块局部状态。

如果没有 attachment，你就得在外面自己再维护一张 `Map<Channel, State>`。而 JDK 直接把这块入口挂在 key 上：`SelectorImpl.register(...)` 创建 key 后立刻 `k.attach(attachment)`，见 `SelectorImpl.java:205-206`。

于是数据流会变成：

```text
register(selector, OP_READ, buf)
  -> key 上挂 buf
select 发现这个 key 可读
  -> 处理时 key.attachment() 直接拿回 buf
```

这不是为了少写几行代码，而是因为在事件驱动模型里，“哪条连接需要哪份局部状态”本来就应该和注册关系站在一起。

## 四、四种事件：不是四个回调，而是四个 readiness 位

建立了 `SelectionKey` 的心智图之后，再看四种事件就容易得多。

JDK 在 `SelectionKey` 里定义了四个核心操作位：`OP_READ`、`OP_WRITE`、`OP_CONNECT`、`OP_ACCEPT`，见 `SelectionKey.java:285-332`。

它们不是四个回调方法，也不是四种对象类型，而只是四个 readiness 位。select 完成后，Selector 会把底层观察到的就绪结果翻译到 `readyOps` 里；应用再用 `isReadable()`、`isWritable()` 这一类位测试方法去分流处理。

### OP_READ：现在值得回来继续读

`OP_READ` 的含义并不是“肯定能把整条消息一次读完”，而是“当前这个 channel 处于可继续读取的状态”。JDK 文档还特意补充了边界：不仅正常可读会置上这个位，EOF、远端关闭输入方向或错误 pending 时也可能让 selector 把 `OP_READ` 加进 ready set，见 `SelectionKey.java:288-295`。

这和 Ch2 完全接得上。

Selector 从来不替你读数据，它只是告诉你：现在值得回来调一次 `read()` 了。至于这次 read 到底得到正数、0 还是 -1，仍由 Channel 自己的合同决定。

### OP_CONNECT：现在值得回来完成第二拍

`OP_CONNECT` 也不是“连接已经 100% 成功”的同义词，而是“当前 socket 已经进入值得执行 `finishConnect()` 的时机”，见 `SelectionKey.java:311-319`。

这正是 Ch2 第二篇里两拍 connect 的自然延续：

```text
connect() 返回 false
  -> 不忙等
  -> register(OP_CONNECT)
  -> select 告诉你：现在值得 finishConnect()
```

Selector 在这里只负责交付“时机”，不负责替你完成第二拍。

### OP_ACCEPT：现在值得回来 accept 一次

`OP_ACCEPT` 的角色最直接：如果某个 `ServerSocketChannel` 已经准备好接受新连接，selector 就会在 ready set 上标记这个位，见 `SelectionKey.java:323-330`。

它传达的信息也不是“已经替你拿到 child channel”，而是“现在去调 `accept()` 是值得的”。真正拿 child channel、再把它切成非阻塞、继续注册后续兴趣，都是上层在收到这个 readiness 之后要做的事。

### OP_WRITE：最容易被误会的一个位

四种事件里，`OP_WRITE` 最危险，因为它太容易让人想当然。

很多初学者会把它理解成“有数据可写时通知我”。这个说法不精确。更准确地说，`OP_WRITE` 表示当前 socket 处于可继续写出的状态；JDK 文档甚至明确写了，远端关闭输出或错误 pending 时，也可能让 selector 在 ready set 中带上这个位，见 `SelectionKey.java:299-307`。

它危险的地方就在这里：和 `OP_READ` 不同，“可继续写”在很多时候会持续成立。也就是说，如果你长期把 `OP_WRITE` 放在 interestOps 里，selector 很可能会频繁告诉你“它还能写”，从而把整个循环推向一种近似忙轮询的状态。

所以工程上真正该记住的不是“OP_WRITE 很特殊”这种空话，而是这条边界：源码能直接证明的是，selector 会在检测到“当前可继续写”时把 `OP_WRITE` 放进 ready set；而在常见 socket 场景里，这种可写状态往往容易持续成立，于是这才带来工程上的约束：

```text
只有当你手里真的还有待发送数据时
OP_WRITE 才值得被放进 interestOps
```

它表示的是“请在写被卡住后，等下次能继续写时再提醒我”，而不是“平时也一直替我盯着写机会”。

## 五、selectedKeys：它不是每轮新建快照，而是持续维护的结果集

现在来到 Selector 最著名、也最容易踩坑的地方：`selectedKeys()`。

很多人第一次写 select 循环时，会不自觉把它想成这样：`select()` 返回后，我拿到一份“这一轮全新的结果列表”；处理完下一轮再来时，这份列表自然已经刷新了。

这个心智模型不对。

`Selector` 抽象文档写得很清楚：selection 操作不是简单“生成一份新列表”，而是对 selected-key set 做增加或更新，见 `Selector.java:105-108` 与 `:139-150`。如果 key 之前不在 selected-key set，就加进去并覆盖 ready set；如果它已经在 selected-key set，中间又出现新的 readiness，那么新结果会按位并到现有 ready set 上，而不是先把旧条目自动删掉。

JDK 实现层也能直接看到这一点。

在 `SelectorImpl.processReadyEvents(...)` 里，如果 `selectedKeys.contains(ski)` 为真，就走 `translateAndUpdateReadyOps`；如果还不在 selectedKeys 里，才会 `selectedKeys.add(ski)`，见 `SelectorImpl.java:291-299`。

这说明 selected-key set 的语义更接近：

```text
一份持续维护的“待你处理结果集”
而不是一轮一轮全新生成的快照
```

这也解释了为什么 JDK 文档要特别强调：你可以 remove，可以 clear，但不能直接 add，见 `Selector.java:86-93`。因为这份集合的生产者是 selection 操作本身，消费者才是你的事件循环代码。

### 为什么必须手动 remove / clear

一旦理解 selectedKeys 不是自动重建快照，就能看见那个经典陷阱了：如果你处理完 key 却不把它从 selectedKeys 里移掉，那么下一轮循环里，这份结果集仍然可能保留旧条目。

这不一定立刻等于“JDK 出 bug”，因为下一次 selection 仍可能继续更新这些 key 的 ready set；但一定等于“你把消费责任留在了结果集里”。而事件循环最怕的就是这种消费不收尾：结果对象还在，下一轮代码又看到它，于是重复判断、重复处理，甚至在没有真正新进展时做空操作。

所以正确心智模型不是“JDK 为什么不帮我自动清理”，而是：

```text
Selector 负责产生结果
你的循环负责消费结果
消费完就要显式 remove / clear
```

这和前面整章强调的“责任划分”是完全一致的。Selector 已经把等待时机统一托管了，但结果集怎么被消费干净，仍然是上层事件循环自己的责任。

## 六、wakeup 与 cancel：一个负责把 select 叫醒，一个负责异步注销

到这里，Selector 的基本模型已经出来了，但还有两个边界动作必须补上：如果 selector 线程正在阻塞 select，别的线程怎么打断它？以及某个 key 作废时，为什么不会立刻从所有集合中凭空消失？

答案分别是 `wakeup()` 和 `cancel()`。

### wakeup：不是产生事件，而是打断当前 selection

`Selector` 文档在并发章节里写得很明确：一个阻塞在 selection 操作里的线程，可以被 `wakeup()`、`close()` 或 `Thread.interrupt()` 三种方式打断；其中 `interrupt()` 最终也会触发 `wakeup()`，见 `Selector.java:226-240`。

所以 `wakeup()` 的语义，不是“给 selectedKeys 塞一个新 key”，而是“把正在等的一轮 select 叫醒，让它尽快回到 Java 层”。

这件事在多线程协作里尤其重要。比如 selector 线程正在 `select()` 阻塞，另一个线程想更新某个 key 的 interestOps，或者想让事件循环尽快看见一批新任务。这里要补一层关键边界：JDK 文档明确说，selection 进行中的 interest set 变更不会影响这一轮操作，只会在下一轮 selection 生效，见 `Selector.java:216-218`。因此 `wakeup()` 的意义不是“把这次变更硬塞进当前这轮”，而是“尽快结束当前阻塞，进入下一轮，让这些更新尽早被看见”。

本篇先只记它的抽象合同：

```text
wakeup() 的职责 = 打断当前可能阻塞的 select
```

至于底层到底用 eventfd、pipe 还是别的机制，以及 Netty 怎么围绕唤醒竞态做优化，放到后文再展开。这里先别越界把后文答案提前塞进来。

### cancel：不是立刻蒸发，而是进入下一轮统一清理

很多人第一次看 `SelectionKey.cancel()`，会自然想象成“这把 key 立刻从 selector 内部所有地方删掉”。

但 `Selector` 文档在开头已经交代过：key 被 cancel 后，会先进入 cancelled-key set，真正从各套 key 集合里移除并完成 channel deregister，是在下一次 selection 操作中处理的，见 `Selector.java:80-84` 和 `:127-129`。

JDK 实现层对应的是 `SelectorImpl.processDeregisterQueue()`：它会遍历 cancelled-key set，依次做 `implDereg`、`selectedKeys.remove(ski)`、`keys.remove(ski)`，再从 channel 自己的 key set 上把它摘掉，见 `SelectorImpl.java:244-268`。

所以 `cancel()` 的正确心智模型是两步：

```text
key.cancel()
  -> 先宣布这把 key 作废
下一次 selection
  -> 再统一做真正的注销与移除
```

这也解释了为什么事件循环在处理 selected key 时，不能想当然地认为“只要它还在集合里就肯定有效”。JDK 文档在并发部分也专门提醒：key 出现在集合里，不等于它此刻仍有效，应用代码需要按需检查有效性，见 `Selector.java:220-224`。

于是 wakeup 和 cancel 一头一尾把模型补完整了：

- wakeup 负责把正在等待的一轮 select 叫醒
- cancel 负责把已经作废的注册关系延迟到 selection 边界统一清理

它们都在服务同一个目标：让 Selector 既能托管等待时机，又不至于在 selection 进行中把内部注册表改乱。

## 收网：Selector 先把“等谁、何时等、结果放哪”这三件事搭好

现在可以回到开篇那个问题：既然非阻塞已经不在 API 内部等了，谁来替 1000 个 Channel 统一等消息？

答案已经完整了。

Selector 先要求每个 Channel 用 `register` 把“我关心什么”登记进来；然后通过 selection 操作去观察这些兴趣位是否满足；一旦某些 Channel 已经值得继续推进，就把结果写进 `SelectionKey.readyOps`，并通过 `selectedKeys` 交还给事件循环消费。

把这一套压成一张最小总图，就是：

```text
register
  -> 建立 Channel 与 Selector 的注册关系
  -> 用 interestOps 说明“我关心什么”
  -> 用 attachment 挂上局部状态

select
  -> 统一等待时机成熟
  -> 把 readiness 写回 key.readyOps
  -> 把值得处理的 key 放进 selectedKeys

event loop
  -> 遍历 selectedKeys
  -> 按 OP_READ / OP_CONNECT / OP_ACCEPT / OP_WRITE 分流
  -> 消费后手动 remove / clear
```

这时你应该能感觉到，Selector 已经把一线程多连接的骨架搭出来了，但还缺最后一块肉：完整循环到底怎么写？这里只先给一个最小回答：`select()` 会一直等到至少有一个事件就绪，`select(timeout)` 最多等指定时长，`selectNow()` 则根本不等；JDK 文档明确说，它们之间唯一的本质区别就是是否阻塞以及阻塞多久，见 `Selector.java:163-165`。而遍历 selectedKeys 时顺序如何，`OP_WRITE` 该怎么按需开关，`cancel()` 和 `wakeup()` 在真实循环里怎么配合，则放到下一篇继续展开。

这就是下一篇单线程 select 循环要展开的内容。

如果说 Ch2 解决的是“单个 Channel 怎么在非阻塞模型里保存进度”，那 Ch3 从这一篇开始解决的，就是“很多 Channel 的等待时机怎么被统一收编”。而这一步，正是 Netty EventLoop 的直接前传。