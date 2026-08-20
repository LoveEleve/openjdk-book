# SelectStrategy 与 selectedKeys 优化：本轮到底等不等 I/O

> 本文基于当前 Netty `SelectStrategy` / `DefaultSelectStrategy` / `NioIoHandler` / `SelectedSelectionKeySet` 实现。前置：Ch5-01 `01-architecture-and-runloop.md`、Ch3 Selector 三篇；本文解释 select 阶段如何决定阻塞或继续，以及 selected keys 如何从 JDK `HashSet` 优化成数组结构，不展开 premature select returns 和 rebuildSelector。

## EventLoop 已经知道“有任务时别轻易睡”，那这一轮具体怎么决定

上一节已经把 EventLoop 的主循环立住了：每一轮先跑 I/O，再给任务一段执行时间；而且只有在没有普通任务和定时任务时，I/O 才允许阻塞等待。

但这还只是原则。

真正进入 `runIo()` 时，线程面前是一个比原则更尖锐的问题：

```text
现在队列里有任务
但也可能正好有 Channel 已就绪
本轮到底该：
- 阻塞 select 等 I/O
- 先 selectNow 快速探一下
- 还是直接跳过 select 回去继续循环
```

如果每次有任务就无脑跳过所有 select，I/O 可能被拖延；如果每次都阻塞 select，任务又会被拖延。第 5 章第二篇要回答的，就是这个“本轮到底等不等 I/O”的具体决策。

还有另一个同样现实的问题：假设答案是“现在值得处理 selected keys”，JDK 默认给你的 still 是 `HashSet + Iterator`。在高频 select loop 里，这套结构真的合适吗？

所以这一篇其实在讲两层优化：

```text
第一层：本轮 select 阶段的行为策略
第二层：已经拿到 selected keys 后，怎样更便宜地消费它们
```

前者由 `SelectStrategy` 决定，后者由 `SelectedSelectionKeySet` 和 `NioIoHandler` 的优化遍历决定。

## 一、SelectStrategy 决定的是“select 阶段怎么做”，不是整个 run() 怎么做

### 1. 三个常量只是 select 阶段的信号值

`SelectStrategy` 接口只定义了三个负数常量：

- `SELECT = -1`：下一步应该执行阻塞 select。
- `CONTINUE = -2`：不要立刻做阻塞 select，而是让 I/O 循环继续推进。
- `BUSY_WAIT = -3`：用非阻塞轮询方式获取新事件。

源码见 `SelectStrategy.java:26-39`。

接口注释也写得很克制：它提供的是“控制 select loop 行为”的能力，而不是 EventLoop 总调度器。`calculateStrategy(...)` 的返回值如果是 `>= 0`，只表示“有工作要处理”；至于接下来整个 `run()` 怎么走，要由外层 I/O handler 再结合上下文决定，见 `SelectStrategy.java:41-51`。

这点必须先立住。否则读者很容易把 SelectStrategy 想成“整个 EventLoop 的状态机”，进而误会：只要策略返回一个值，就已经决定了任务、selected keys 和 wakeup 的全部后续动作。

更准确的说法是：

```text
SelectStrategy 只回答
“本轮 select 阶段该不该阻塞，以及是否已有工作”

它不独自决定
“整个 runIo 之后是否继续处理 keys、任务、wakeup、rebuild”
```

### 2. DefaultSelectStrategy 没有“有任务就直接 CONTINUE”

这里先纠正一个非常常见、也很容易从旧资料继承下来的误解。

当前 `DefaultSelectStrategy.calculateStrategy(...)` 的实现只有一行：

```text
hasTasks ? selectSupplier.get() : SelectStrategy.SELECT
```

源码见 `DefaultSelectStrategy.java:28-31`。

也就是说：

- 没有任务时，明确返回 `SELECT`，允许后续阻塞等待 I/O。
- 有任务时，并不是直接返回 `CONTINUE`，而是先调用 `selectSupplier.get()`。

在当前 `NioIoHandler` 里，这个 supplier 通常就是一次 `selectNow()` 试探。它的意义是：即使任务在排队，也先用非阻塞方式快速看一眼现在有没有 I/O ready。

因此真正的顺序是：

```text
hasTasks = true
  -> 先 selectNow 看看是否已经有 I/O 就绪
  -> 如果返回 > 0，说明 I/O 也值得处理
  -> 如果返回 0，才意味着这次试探没有拿到就绪 key
```

这比“有任务就跳过所有 select”保守得多。它保留了一个机会：任务密集时，仍然先轻量试探一下 I/O，而不是把 I/O 彻底往后拖。

### 3. `0` 不是 `CONTINUE` 常量，但可能触发“继续而不阻塞”的效果

这里要再收一道边界。

在当前默认策略下，`selectSupplier.get()` 可能返回 0。对 `DefaultSelectStrategy` 来说，这只是一个普通的 `>= 0` 返回值，不等于 `SelectStrategy.CONTINUE` 常量本身。

真正把这个 0 解释成“这次不用阻塞 select，直接进入后续路径”的，是外层 `NioIoHandler.run()`。

所以不能把两者硬写成：

```text
selectNow() == 0  == CONTINUE
```

更准确的链路应该是：

```text
DefaultSelectStrategy 返回 0
  -> 进入 NioIoHandler.run() 的 switch/default 路径
  -> 不会再进入阻塞 select 分支
  -> 这一轮效果上相当于“继续推进，不阻塞等待”
```

这是本篇最容易讲混的一点：策略返回值本身与 `run()` 的外层效果，不是同一个层次的概念。

## 二、`NioIoHandler.run()` 如何消费这三个策略值

### 1. 真正的分支在 `switch (calculateStrategy(...))`

当前 `NioIoHandler.run()` 会调用：

```text
selectStrategy.calculateStrategy(selectNowSupplier, !context.canBlock())
```

实现见 `NioIoHandler.java:420-469`。

这里的第二个参数是 `!context.canBlock()`，而不是“裸的 hasTasks”。因为当前 EventLoop 是否允许阻塞，不只取决于普通任务，还取决于定时任务。上一节已经核对过：`canBlock()` 只有在 `!hasTasks() && !hasScheduledTasks()` 时才为 true。

所以当前 NIO 路径实际上是在问：

```text
现在是不是有任何理由让我别阻塞？
如果有，就先做一次非阻塞试探
```

### 2. `CONTINUE` 是唯一会立刻返回的显式控制信号

在 `switch` 里，`CONTINUE` 的行为很直接：如果需要上报活跃 I/O 时间，就报告 0，然后本轮 `run()` 直接返回 0，见 `NioIoHandler.java:423-429`。

这说明 `CONTINUE` 的语义不是“做一次轻量 select 再说”，而是更强的一条控制信号：

```text
这轮别阻塞 select
也别在这里做额外等待
直接把控制权交还给外层循环
```

当前默认策略并不直接生成它，但自定义策略可以。这样设计的好处是，策略接口保留了“我连试探都不想做，直接继续”的表达能力，而默认实现只是选择了更保守的一种方式。

### 3. `BUSY_WAIT` 在 NIO 上当前并没有真正被支持

`BUSY_WAIT` 分支在当前 `NioIoHandler.run()` 里直接 fall through 到 `SELECT`，源码注释明确写着：busy-wait 不被 NIO 支持，见 `NioIoHandler.java:430-433`。

这意味着在当前实现里：

```text
BUSY_WAIT
  -> 不会进入一条真正独立的忙轮询实现
  -> 只是退化成 SELECT 分支的前置状态
```

这个边界非常重要。因为一旦把 `BUSY_WAIT` 当成“Netty NIO 当前真的提供了高性能忙轮询”，整篇后续解释都会偏掉。当前源码能支持的事实只有：接口保留了这个信号位，但 NIO handler 暂时不真正实现它。

### 4. `SELECT` 才真正进入阻塞/定时 select 逻辑

`SELECT` 分支会调用：

```text
select(context, wakenUp.getAndSet(false))
```

见 `NioIoHandler.java:433-435`。

注意，这里进入的不是“必然无限阻塞”的 `selector.select()`，而是 `NioIoHandler.select(...)` 这套更复杂的包装逻辑。它还要综合考虑：

- 是否存在到期的 scheduled task。
- `wakenUp` 的状态。
- 本轮是不是已经被外部线程叫醒。
- 任务队列在进入 select 前有没有再次变为非空。

所以 `SELECT` 的真正含义应该理解成：

```text
进入当前 NIO 后端的等待策略
必要时阻塞
必要时 selectNow
必要时立即 break
```

而不是一句简单的“它就会直接阻塞”。

## 三、`select()` 内部怎么把“不该阻塞”落实成代码

### 1. 有到期定时任务时，先用 `selectNow()` 兜底

`NioIoHandler.select(...)` 首先会计算当前定时任务的 deadline。如果 deadline 已经到期，且这是本轮第一次 select，它会直接执行 `selector.selectNow()`，然后 break，见 `NioIoHandler.java:633-651`。

这条路径的意义是：

```text
定时任务已经到点
  -> 没必要再睡进阻塞 select
  -> 先 selectNow 把当前就绪事件收一遍
  -> 让外层尽快回到 runAllTasks
```

它说明 EventLoop 对“有没有工作要做”的判断不是单一维度。就算没有普通任务，定时任务到点也足以打断阻塞等待。

### 2. 进入真正阻塞前，还会再看一眼任务队列

`select()` 里有一段非常关键的注释：如果某个任务是在 `wakenUp` 为 true 时提交的，它可能没有机会真正调用 `Selector.wakeup()`。为了不让这个任务一直挂到 select 超时，进入 select 前会再次检查任务队列；如果发现当前不能阻塞，且成功把 `wakenUp` 从 false CAS 到 true，就直接 `selector.selectNow()` 并 break，见 `NioIoHandler.java:658-665`。

这说明当前实现不是“前面算过 canBlock 就永远相信它”。在真正阻塞之前，还会做最后一次状态复核。

这也是 EventLoop 主循环的典型气质：所有“我要睡了”的地方，都会尽量在睡前多看一眼是否已经有新工作进来。

### 3. 阻塞 select 返回后，不只看 selectedKeys 数量

即使执行了 `selector.select(timeoutMillis)`，返回后也不会只根据 selected key 数量下结论。当前 `select()` 会在以下任一条件满足时 break：

- `selectedKeys != 0`
- `oldWakenUp`
- `wakenUp.get()`
- `!runner.canBlock()`

见 `NioIoHandler.java:668-677`。

这说明“本轮要不要继续等待”并不是由 selected key 数量单独决定的。即使这次 select 没拿到业务 key，只要 wakeup 状态或任务状态告诉你“已经不该继续睡”，也应当把控制权还给外层。

这一点和 Ch3 的 JDK Selector 心智模型正好接上：select 返回，不一定意味着业务 I/O 就绪；也可能意味着 wakeup、interrupt 或任务边界。Netty 在这里进一步把这些退出条件显式整合进了 loop。

## 四、JDK 的 `selectedKeys` 为什么会成为热点

### 1. JDK 给的是通用集合，不是为 Netty 主路径量身定做的结构

JDK `selectedKeys` 的抽象语义没有问题：它是一个保存本轮就绪 key 的集合。但对 Netty 的高频 NIO loop 来说，JDK 默认的 `HashSet + Iterator` 并不完全匹配实际消费模式。

在典型的 EventLoop 路径里，对 selected keys 的需求非常朴素：

```text
一、把 JDK 发现的就绪 key 按顺序收集起来
二、逐个处理
三、处理完以后清空
```

Netty 并不需要：

- 在 selected keys 里做高频随机删除。
- 在处理中途大量做哈希查询。
- 保留复杂的集合语义供外部通用操作。

如果消费模式本来就是“append -> 顺序遍历 -> reset”，那 HashSet 的通用性就会变成额外成本。

### 2. SelectedSelectionKeySet 只保留当前需要的能力

`SelectedSelectionKeySet` 的结构非常直接：一个 `SelectionKey[] keys` 数组，加一个 `size`，初始容量 1024，见 `SelectedSelectionKeySet.java:25-32`。

`add()` 只是尾部追加，满了就翻倍扩容，见 `SelectedSelectionKeySet.java:34-46`。这条路径没有哈希桶，也没有冲突处理。对当前使用场景来说，JDK Selector 自己已经负责避免 selected set 的重复语义，Netty 这里只需要一个顺序收集容器。

更关键的是，`remove()` 永远返回 false，见 `SelectedSelectionKeySet.java:48-50`。这不是 bug，而是刻意把“不需要的集合能力”从热点路径里删掉。

`reset()` 则通过 `Arrays.fill(keys, start, size, null)` 清理槽位，再把 `size` 归零，见 `SelectedSelectionKeySet.java:95-108`。

于是整个结构的主路径就变成：

```text
selected key 到来
  -> keys[size++] = key
处理完成
  -> reset()/reset(start)
```

它并不是通用 Set 的更好实现，而是面向 Netty 当前消费模式裁掉通用性之后的一块专用数组。

### 3. `contains()` 存在，但不是这个结构的优化目标

`SelectedSelectionKeySet` 仍然实现了 `contains()`，但它只是线性扫描数组，见 `SelectedSelectionKeySet.java:53-63`。

这件事恰恰证明它的设计目标不是通用集合：如果 Netty 真把“高频 contains 查询”放在这个结构的主路径上，这个实现就不会成立。

所以理解这个结构时要避免两个极端：

- 不是说数组永远比 HashSet 高级。
- 也不是说 Netty 偷工减料忘了实现删除和快速查找。

真正的事实是：在当前 selected keys 消费模式下，append 和顺序遍历才是主操作，通用集合能力反而会拖累热点路径。

## 五、Netty 怎么把 JDK 的 `selectedKeys` 换成自己的数组

### 1. 它同时替换了 `selectedKeys` 和 `publicSelectedKeys`

`NioIoHandler.openSelector()` 先创建原始 selector；如果没有禁用优化，再尝试加载 `sun.nio.ch.SelectorImpl` 并找到 `selectedKeys` 和 `publicSelectedKeys` 两个字段，见 `NioIoHandler.java:143-233`。

如果运行在 Java 9+ 且有 Unsafe，就优先通过字段偏移直接 `putObject`；否则退回反射 `Field.set()`，见 `NioIoHandler.java:186-216`。

这里最容易漏掉的一点是：它不是只替换了一个内部字段，而是两个都替换。这样，JDK 内部路径和对外暴露的 selected key 集合视图都会指向同一个 `SelectedSelectionKeySet`。

### 2. 失败时降级，而不是报错终止

如果类加载失败、字段不存在、Unsafe 偏移拿不到，或者反射不可达，`openSelector()` 就把 `selectedKeys` 设为 null，返回原始 selector，见 `NioIoHandler.java:224-233`。

这说明这项优化从一开始就被设计成：

```text
能用 -> 加速
不能用 -> 保持正确性，回退 plain 路径
```

它不是正确性的前提。Netty 不会因为你所在 JVM 不能安全注入 `SelectorImpl` 私有字段，就拒绝运行 NIO；它只是失去一条性能优化路径。

### 3. 包装 selector 的作用是每轮先 reset 再委托

注入成功后，Netty 不直接把原 selector 暴露出去，而是包成 `SelectedSelectionKeySetSelector`。这个包装器在每次 `select()`、`select(long)` 或 `selectNow()` 之前，先对数组执行 `reset()`，再把调用委托给底层 selector，见 `SelectedSelectionKeySetSelector.java:24-68`。

这样做的目的是把“上一轮的残留槽位清空”固定到 select 入口，而不是让外层使用者手动维护。

换句话说：

```text
JDK selector 负责产生本轮 selected keys
Netty selector wrapper 负责在下一轮开始前把数组状态复位
```

这和第 3 章的 `selectedKeys` 消费责任模型是一脉相承的，只不过现在 reset 的实现从 `Iterator.remove()` 变成了数组槽位清理。

## 六、optimized 与 plain 两条遍历路径差在哪里

### 1. plain 路径仍然是 JDK 集合遍历模型

如果注入失败，`selectedKeys == null`，`NioIoHandler.processSelectedKeys()` 就回退到 `processSelectedKeysPlain(selector.selectedKeys())`，见 `NioIoHandler.java:510-515`。

plain 路径先看集合是否为空；不为空就创建 iterator，逐个取 key、`i.remove()`、处理 key，见 `NioIoHandler.java:527-560`。

这条路径功能完全正确，也符合 JDK `selectedKeys` 的消费方式。但它意味着：

- 每轮可能创建 iterator。
- 每个 key 要走一次 iterator 状态机和 remove。
- `needsToSelectAgain` 时还要重建 iterator。

也正因为这条路径随时可用，Netty 才能大胆把数组优化做成“加速器”，而不是正确性前提。

### 2. optimized 路径把“逐个 remove”改成“逐槽置空 + 批量 reset”

数组优化路径的循环非常直接：

```text
for (i = 0; i < selectedKeys.size; i++) {
    k = selectedKeys.keys[i]
    selectedKeys.keys[i] = null
    processSelectedKey(k)
}
```

实现见 `NioIoHandler.java:563-583`。

它不需要 iterator，也不需要每个元素做 remove。已处理元素在循环中立即置 null，整个批次结束后再由 `reset()` 统一把 size 归零。

这就是它与 plain 路径的本质区别：

```text
plain      -> 迭代器逐个取、逐个 remove
optimized  -> 数组顺序读、顺手置 null、批量 reset
```

### 3. 为什么 `needsToSelectAgain` 时只 `reset(i + 1)`

optimized 路径里，如果 `needsToSelectAgain` 为 true，会调用：

```text
selectedKeys.reset(i + 1)
selectAgain()
i = -1
```

见 `NioIoHandler.java:574-581`。

这里最容易疑惑的是：为什么不是直接 `reset(0)`？

原因在于前面已经处理过的槽位，在循环过程中已经逐个手动设为了 null。此时真正需要批量清理的，是“从当前下一个槽位开始，到本轮数组末尾那些还没处理的键”。

所以这段逻辑可以读成：

```text
[0..i]    已处理，之前已手工置 null
[i+1..end] 尚未处理，现在统一清掉
然后 selectNow 更新新一轮 selected keys
再从头开始处理新数组
```

这既避免重复清理已处理区间，也确保旧的未处理条目不会和 `selectAgain()` 带来的新 selected keys 混在一起。

### 4. `selectAgain()` 的作用不是阻塞，而是刷新 SelectionKeys

`selectAgain()` 做的事情很简单：把 `needsToSelectAgain` 设回 false，然后调用一次 `selector.selectNow()`，见 `NioIoHandler.java:762-768`。

它的目标不是等待新事件，而是把当前 selector 内部状态刷新到 selected keys 集合里，避免继续用一个已经在处理过程中被取消/修改过的旧结果集。

这与 Ch3 的“selectedKeys 需要消费责任”正好呼应：当前一轮遍历中如果环境发生变化，最安全的做法不是硬着头皮继续扫旧集合，而是先把就绪状态刷新一遍，再从一致的新快照继续处理。

## 七、最容易错的五个判断

### 1. 有任务时，DefaultSelectStrategy 直接返回 `CONTINUE`

不成立。当前默认实现是“有任务时先调用 `selectSupplier.get()`”；是否表现成不阻塞继续，要由 `NioIoHandler.run()` 再结合返回值和上下文决定。

### 2. `selectNow() == 0` 就等于 `CONTINUE` 常量

不成立。`0` 只是一个 `>= 0` 的策略结果，不是 `CONTINUE = -2`。两者在当前 run 路径上可能表现出相近效果，但语义层级不同。

### 3. SelectedSelectionKeySet 是通用高性能 Set

不成立。它是面向 Netty 当前 selected keys 消费模式的专用数组结构。`contains()` 仍是线性扫描，`remove()` 也不支持随机删除。

### 4. 数组优化失败就说明 NIO 不可用

不成立。失败只会回退到 plain 路径，功能仍然正确，只是少了一条性能优化。

### 5. optimized 路径完全不需要清理

不成立。它只是把逐个 `iterator.remove()` 改成“处理时置 null + 轮次边界 reset”。清理责任仍然存在，只是形式更适合当前热点路径。

## 收网：一个决定“等不等”，一个决定“怎么便宜地处理”

现在可以把这一篇压成两句话。

第一句是关于 SelectStrategy 的：

```text
它决定的是本轮 select 阶段该不该阻塞、要不要先试探
不是整个 EventLoop 运行逻辑的总开关
```

第二句是关于 selected keys 优化的：

```text
它省掉的是通用集合在当前热点路径上的多余成本
不是改变 selected keys 的语义本身
```

所以本篇真正建立的是两个边界：

- SelectStrategy 负责在“任务已经来了”和“I/O 可能也来了”之间做本轮等待策略判断。
- SelectedSelectionKeySet 负责把 selected keys 的消费结构从通用集合收缩成更贴近 Netty 真实操作模式的数组。

第 5 章的主线到这里更清楚了：上一节讲的是 EventLoop 为什么能同时驱动 I/O 和任务；这一节讲的是它进入 I/O 阶段后，怎样决定是否阻塞，以及如何更便宜地吃掉本轮就绪结果。

下一篇进入真正的生产级陷阱：Selector 为什么会“莫名其妙地连续提前返回”，Netty 又怎样通过 wakeup 协议、select 计数和 rebuildSelector 把这类问题压住。