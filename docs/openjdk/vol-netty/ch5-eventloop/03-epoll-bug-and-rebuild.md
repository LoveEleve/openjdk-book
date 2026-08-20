# epoll bug 与 Selector 重建：EventLoop 为什么要有三层防线

> 本文基于当前 Netty `NioIoHandler` 实现，重点解释 `wakenUp` 协议、premature select 检测和 `rebuildSelector0()`。前置：Ch3 Selector 三篇、Ch5-01 `01-architecture-and-runloop.md`、Ch5-02 `02-select-strategy-and-optimization.md`；本文不展开多线程 EventLoopGroup 和 chooser。

## CPU 100%，GC 正常，流量也不高：EventLoop 为什么还在忙

Netty 线上有一类故障特别让人困惑：

- 进程 CPU 持续很高。
- GC 日志看起来很正常，没有明显 stop-the-world 压力。
- 网络流量并不夸张，甚至 selected keys 也未必很多。
- 线程栈上却反复看到 EventLoop 卡在 selector 路径附近。

如果你已经读过前两篇 EventLoop 文章，就会知道这类现象最可疑的地方不在 ByteBuf，也不在普通任务队列，而在“等待本身”出了问题。

EventLoop 的设计本来很节制：

```text
没任务、没定时任务
  -> 允许阻塞等待 I/O
有任务或需要继续推进
  -> 不阻塞，尽快返回主循环
```

所以当 CPU 100% 却没有明显业务推进时，真正可疑的是：本来应该阻塞的 select 为什么反复提前返回？或者本来应该叫醒的 select 为什么在某个时序窗口里没有被正确唤醒？

Netty 当前 `NioIoHandler` 围绕这类问题铺了三层防线，但这三层不是同一个补丁的重复叠加，而是三种不同故障的递进处理：

```text
第一层：wakeup CAS + 补偿唤醒
         防的是“唤醒时序错位”

第二层：premature select 计数
         防的是“selector 连续提前返回”

第三层：rebuildSelector0()
         处理的是“这个 selector 已经不值得继续信任”
```

这篇文章要做的，就是把这三层拆开。否则很容易把所有“select 提前返回”都混成一个问题，既看不清为什么会 CPU 空转，也看不清为什么 Netty 既要 CAS，又要计数，又要重建。

## 一、先把正常返回、任务返回和异常连续返回分开

### 1. 不是所有 `select()==0` 都是 bug

这是第一条必须先立住的边界。

在 NIO 世界里，单次 `select()` 或 `selectNow()` 返回 0，本身并不稀奇。它可能来自：

- 这次本来就是 `selectNow()`，只是没拿到就绪 key。
- 本轮有到期定时任务，所以不值得继续阻塞等待。
- `wakeup()` 把阻塞打断了，但这次返回不是业务 I/O ready。
- 当前不能阻塞，需要尽快回到任务循环。
- 线程被 interrupt。

当前 `NioIoHandler.select(...)` 的代码就明确把这些情况与真正的可疑路径分开。只要出现以下任一条件，循环就会 break：

- `selectedKeys != 0`
- `oldWakenUp`
- `wakenUp.get()`
- `!runner.canBlock()`

见 `NioIoHandler.java:668-677`。

也就是说，Netty 从一开始就没把“这次没有业务 key”直接当成 bug 信号。它先问的是：

```text
这次返回有没有别的合理解释？
```

只有在这些解释都不成立、而且这种提前返回还连续发生时，才开始怀疑 selector 本身已经偏离预期行为。

### 2. 正常 timeout、线程 interrupt、IOException 都是不同故障类

当前实现里，正常 timeout 会把 `selectCnt` 重置为 1，见 `NioIoHandler.java:693-697`。线程被 interrupt 时，会打印 debug 日志并 break，见 `NioIoHandler.java:678-689`。而如果在 selector loop 里收到 `IOException`，`run()` 会先执行 `rebuildSelector0()`，再交给 `handleLoopException(e)` 做告警和 1 秒退避，见 `NioIoHandler.java:470-475`、`:498-507`。

这三类路径不能混在一起：

```text
timeout
  -> 这轮就是没等到事件，属于正常等待结果

interrupt
  -> 更像用户代码或第三方库打断线程

IOException
  -> selector 本身已明显不健康，直接重建
```

Netty 的防线不是“凡是异常都走同一条恢复逻辑”，而是先按故障性质分类，再决定是继续、计数还是直接 rebuild。

### 3. 真正危险的是连续、快速、没有合理解释的提前返回

第二篇已经讲过：EventLoop 的 select 阶段本来就在努力避免“该睡时没睡、该醒时没醒”的错位。如果在这些保护都存在的情况下，selector 还是在短时间内连续提前返回，而又没有 selected keys、没有 wakeup、没有 pending task、没有 timeout 到期，那这就不再像正常控制流，而像是等待机制本身出了问题。

这就是所谓的 premature select returns。它和单次 `selectNow()==0` 的最大区别在于：

```text
单次返回 0
  -> 可能只是这轮没有工作

连续提前返回
  -> 线程没有阻塞、没有推进业务、却持续消耗 CPU
```

所以第 1 层和第 2 层防线的分工应该先分清：第一层先确保“这不是我们自己把唤醒时序搞丢了”；第二层才开始怀疑 selector 本身出了问题。

## 二、第一层：`wakenUp` CAS 和补偿唤醒，防的是时序错位

### 1. `wakeup()` 不是每次都直接发 syscall

`NioIoHandler` 用一个 `AtomicBoolean wakenUp` 协调唤醒状态，见 `NioIoHandler.java:105-116`。

外部线程调用 `wakeup()` 时，只有在当前线程不是 executor 线程，并且 `wakenUp.compareAndSet(false, true)` 成功时，才真正调用 `selector.wakeup()`，见 `NioIoHandler.java:615-618`。

这样做不是炫技，而是为了避免把昂贵的 wakeup 系统调用放大成每次提交任务都无脑触发：

```text
已有唤醒请求未消费
  -> 再次 wakeup 没必要重复发 syscall

没有唤醒请求
  -> CAS false -> true 成功
  -> 这次才真正 selector.wakeup()
```

这就是第一层防线的第一半：减少冗余唤醒，同时保留“至少有一个唤醒信号”这一事实。

### 2. 真正危险的窗口在 `set(false)` 和 `select()` 之间

问题出在 select 线程自己也会修改 `wakenUp`。在进入 `select(context, wakenUp.getAndSet(false))` 时，它先把旧状态取走并清成 false，然后才准备执行真正的 select，见 `NioIoHandler.java:433-435`。

这中间会出现一个坏窗口：

```text
select 线程：把 wakenUp 设回 false
外部线程：此时提交任务，CAS false -> true 成功，并 wakeup()
select 线程：随后才进入 selector.select(...)
```

如果这个窗口处理不好，就会出现一种很难察觉的问题：唤醒请求来过了，但当前这次 select 可能已经错过了它，下一轮又因为 `wakenUp` 状态错位而不再真正 wakeup，导致线程不必要地阻塞。

当前源码里的大段注释就是在解释这个竞态，见 `NioIoHandler.java:436-462`。它把“在 select 前过早把 `wakenUp` 设回 false”明确标记为 BAD 场景。

### 3. 补偿唤醒为什么放在 `select()` 返回之后

当前实现的补偿动作很简单：`select(...)` 返回后，如果 `wakenUp.get()` 仍为 true，就再调一次 `selector.wakeup()`，见 `NioIoHandler.java:464-466`。

这条语句的语义不是“我怀疑又有 I/O 来了”，而是：

```text
如果在我这轮 select 之前/期间
有线程成功把 wakenUp 设成了 true
那我宁可多补一次 wakeup
也不冒险让下一轮错误阻塞
```

这就是第一层防线的第二半：CAS 负责合并冗余唤醒，补偿 wakeup 负责修补坏窗口。它解决的是“唤醒信号被错位消费”的问题，而不是 selector 自己无缘无故提前返回的问题。

### 4. `selectNow()` 也要恢复唤醒状态

还有一个容易漏掉的小边界：当前 `selectNow()` 的 finally 里，如果 `wakenUp.get()` 仍为 true，会再次调用 `selector.wakeup()`，见 `NioIoHandler.java:736-744`。

这说明唤醒协议不是只在阻塞 select 路径上才重要。即使是非阻塞试探，当前实现也在尽量维护一致的 wakeup 状态：

```text
selectNow() 执行完
  -> 如果外部线程还标记着待消费唤醒
  -> 恢复一次 wakeup，避免后续状态失配
```

所以第一层防线可以压缩成一句话：

```text
它防的不是 epoll bug
而是我们自己在 select/wakeup 时序上把信号弄丢
```

## 三、第二层：`selectCnt` 只统计“可疑的连续提前返回”

### 1. 阈值是次数，不是时间

`NioIoHandler` 里有两个常量：`MIN_PREMATURE_SELECTOR_RETURNS = 3` 和 `SELECTOR_AUTO_REBUILD_THRESHOLD`。后者默认从系统属性 `io.netty.selectorAutoRebuildThreshold` 读取，默认是 512；如果配置值小于 3，就直接置 0，表示禁用自动检测，见 `NioIoHandler.java:66-88`。

这一步有两个容易被旧资料写偏的地方。

第一，512 是次数阈值，不是固定时间窗口。当前代码从来没有把它乘上某个 tick 得到“约 51 秒”之类的结论。一次循环可能很快，也可能因为 timeout 很长而很慢，所以不能把 512 次直接换算成固定秒数。

第二，小于 3 不是“更敏感”，而是直接禁用。因为太小的阈值会让正常短暂波动也落入“可疑连续返回”的误判区间。

### 2. 计数不是见 0 就加一

如果只看大纲，很容易误写成：

```text
select 返回 0 -> selectCnt++
```

当前源码远比这保守。

在 `select()` 的循环里，只有当以下这些正常出口都没发生时，计数才会继续累计：

- 有 selected keys。
- 有旧/新 wakeup 信号。
- 当前已经不能阻塞。
- timeout 正常到期。
- 线程被 interrupt。

其中 timeout 会把 `selectCnt` 设为 1，见 `NioIoHandler.java:693-697`；interrupt 也会 break 并把 `selectCnt` 设为 1，见 `NioIoHandler.java:678-689`。

所以 `selectCnt` 的真正含义更接近：

```text
在没有合理理由的情况下
selector 连续提前返回了多少次
```

这比“连续 0 次数”精细得多，也更贴近生产环境想区分的问题：到底是正常没活，还是 selector 已经处于异常忙醒状态。

### 3. 为什么不是见一次异常就立刻 rebuild

因为单次提前返回很难定性。

- 可能只是边界上的 wakeup 时序。
- 可能是刚好到期的 deadline。
- 可能是线程 interrupt。
- 可能只是一次短暂的 selector 抖动。

如果一看到“这次好像没理由”就重建 selector，会把一个很重的恢复动作误用成普通分支。Netty 当前实现选择的是：

```text
先记录
连续出现再怀疑
达到阈值再重建
```

这让 rebuild 从“日常控制流的一部分”退回“确认 selector 已经不健康后的恢复手段”。

### 4. 日志信号如何帮助 SRE 排查

当 `selectCnt > MIN_PREMATURE_SELECTOR_RETURNS` 时，当前实现会打 debug 日志，内容是 `Selector.select() returned prematurely ... times in a row`，见 `NioIoHandler.java:709-714`。

而真正触发 rebuild 时，会打 warn 日志：`Selector.select() returned prematurely ... rebuilding Selector ...`，见 `NioIoHandler.java:747-752`。

所以 SRE 现场至少可以区分三种信号：

```text
debug: returned prematurely ...
  -> 已出现连续可疑返回，但未必已到重建阈值

warn: rebuilding Selector ...
  -> 已达到自动重建条件

debug: Thread.currentThread().interrupt() was called
  -> 这是线程中断，不是 epoll/select 路径故障
```

这组日志比“CPU 高”更可操作，因为它们已经把问题收缩到 selector/wakeup 这一层。

## 四、第三层：`rebuildSelector0()` 不是修补 selectedKeys，而是重建注册关系

### 1. 重建入口先 warn，再立即 selectNow

当阈值达到时，`selectRebuildSelector(selectCnt)` 先打印 warn，然后调用 `rebuildSelector0()`；重建完成后，再对新 selector 做一次 `selectNow()`，见 `NioIoHandler.java:747-759`。

这个 `selectNow()` 很关键。它不是为了继续阻塞等待，而是为了让刚迁移完的新 selector 立即填充一轮 selected keys，避免重建结束后还要等下一轮自然 select 才看见现有就绪状态。

因此第三层防线的第一步不是“重建完万事大吉”，而是：

```text
新 selector 建好
  -> 尽快补一轮 selectNow
  -> 把当前已可见的就绪状态重新捞出来
```

### 2. `rebuildSelector0()` 的顺序为什么是“先迁移，再替换，再关闭旧 selector”

当前 `rebuildSelector0()` 的顺序非常清楚：

1. `openSelector()` 创建新 selector。
2. 遍历旧 selector 的 keys。
3. 对每个仍有效、且还没在新 selector 上注册的 key，调用 `handle.register(newSelector)` 重新注册。
4. 迁移结束后，把 `selector` 和 `unwrappedSelector` 原子替换成新对象。
5. 最后关闭旧 selector。

源码见 `NioIoHandler.java:255-302`。

这个顺序不是随便排的。如果先关闭旧 selector，再去迁移注册，旧 selector 持有的注册集合就会先被打断；而当前顺序确保在替换引用前，新的 selector 已经尽量接住旧的注册关系。

可以把它压成：

```text
先把“谁归新 selector 管”搬过去
再把全局入口切到新 selector
最后才把旧 selector 关掉
```

这正是第三层防线与前两层的区别：它已经不再是局部补偿，而是在替换整个等待基础设施。

### 3. 迁移的是 registration，不是旧 selected state

`rebuildSelector0()` 遍历的是 `oldSelector.keys()`，拿到的是注册关系，而不是旧 selector 当前的 selectedKeys，见 `NioIoHandler.java:270-285`。

这意味着重建做的事情是：

```text
把“哪些 channel/handle 在这上面注册、关注哪些 I/O”迁过去
```

而不是把“上一轮已经就绪的 selected keys 集合”原样复制过去。旧的 selected state 本质上属于 selector 当前一次选择的结果；重建之后，新的可见就绪状态要由新 selector 再次 select/selectNow 得出。

这也是为什么“迁移过程中旧 selected keys 会不会丢”不能写成绝对 yes/no。当前源码能证明的是：它迁移了注册关系，并在新 selector 上再执行一次 `selectNow()`；至于某个具体事件是否因为内核缓冲区、时序边界或对端状态而在重建窗口内表现不同，超出了这段 Java 代码本身能单独保证的范围。

### 4. 失败的重新注册怎么处理

迁移每个 key 时，当前实现如果遇到异常，会打印 warn 并调用 `handle.cancel()`，见 `NioIoHandler.java:281-284`。

这说明 Netty 并没有假装“所有迁移都一定成功”。它至少明确了失败路径：

```text
这条 registration 没迁成功
  -> 不能继续留着一个半失效状态
  -> cancel 掉，由上层按既有失效协议处理
```

对于生产系统来说，这种明确失败比“静默漏掉一条注册关系”更重要。否则重建虽然成功了，但某几个 handle 可能从此悄悄失联。

## 五、怎么判断现场更像哪一层问题

### 1. 像第一层：任务来了，但 select 似乎没及时醒

如果问题表现更像“偶尔有任务卡到下一轮才被处理”，而没有明显的 `returned prematurely` 或 rebuild 日志，更该优先看 wakeup 协议和时序窗口，而不是直接怀疑 selector 已经坏掉。

这一类问题的核心是：

```text
唤醒信号是否在坏窗口里被错位消费
```

它不需要假设 selector 已经不健康，只需要关注 `wakenUp` 状态和 select 返回后的补偿动作是否发挥了作用。

### 2. 像第二层：CPU 高、GC 正常、debug 日志反复报 prematurely

这更像 selector 在连续提前返回，但还没到强制 rebuild 的级别。系统仍在运行，只是 EventLoop 花了太多时间在“醒来却没干成活”这件事上。

这时最关键的证据不是业务层日志，而是 EventLoop 自己的 debug/warn 信息。

### 3. 像第三层：warn 级别已经 rebuild

当日志出现 `rebuilding Selector`，说明当前实现已经判断：继续信任这个 selector 不划算了，重建成本值得支付。

这时排查重点应该转向：

- 重建是否频繁发生。
- 某类平台/JDK/部署参数是否更容易触发。
- 重建后业务是否有异常注册失败日志。
- 是否有人把 `io.netty.selectorAutoRebuildThreshold` 改得过高、过低或置 0。

特别是阈值为 0 时，自动检测会被禁用；系统仍然能跑，也仍然可以通过上层入口手动触发 rebuild，但这条“连续提前返回后的自动自愈”防线就没了。这里不是说一定不该禁用，而是必须知道你在放弃什么。

## 六、最容易错的五个判断

### 1. 单次 `select()==0` 就能判定 epoll bug

不成立。当前实现明确区分 timeout、wakeup、任务、interrupt 和连续提前返回。单次返回 0 远远不够定性。

### 2. `SELECTOR_AUTO_REBUILD_THRESHOLD=512` 等于固定多少秒后重建

不成立。它是次数阈值，不是时间阈值。每次循环持续多久，取决于 timeout、任务、唤醒和运行现场，不能换算成固定秒数。

### 3. wakeup CAS 修复的就是 epoll 假唤醒

不成立。第一层防线修的是唤醒时序错位；premature select 计数和 rebuild 才是在对抗 selector 连续提前返回。

### 4. rebuild 时会把旧 selectedKeys 原样搬到新 selector

不成立。当前实现迁移的是注册关系，不是旧 selected state。新 selector 的就绪状态依赖后续 select/selectNow 再计算。

### 5. 只要 rebuild 了，业务绝不会受影响

不应作这种绝对承诺。当前源码能证明它会迁移注册关系、替换 selector 并关闭旧 selector；能否完全无感，还取决于具体 handle 重注册是否成功、外部事件时序和运行环境。

## 收网：这三层不是重复补丁，而是递进恢复链

现在可以把整篇压成一张最小图：

```text
第一层：wakeup CAS + 返回后补偿唤醒
  -> 防时序错位

第二层：selectCnt 只累计可疑连续提前返回
  -> 区分正常返回与异常空转

第三层：rebuildSelector0 + selectNow
  -> 替换失去预期行为的 selector
```

它们处理的不是同一个问题的三个重复写法，而是 EventLoop 在等待阶段可能遭遇的三种不同层次故障：

- 信号有没有被正确送到。
- selector 是否在错误时机连续返回。
- 当前这个 selector 是否已经不值得继续信任。

所以第 5 章第三篇最重要的结论不是“Netty 修了 epoll bug”这么粗，而是：

```text
Netty 先用最小补偿修时序
再用计数区分正常与异常
最后才在必要时替换整个 selector
```

这也把 EventLoop 的生产级画像补完整了：它不是只会 select/read/write 的裸 Reactor，而是一个自带故障识别和恢复策略的长期运行骨架。

下一篇进入多线程与特殊模型：当一个 EventLoopGroup 持有多个单线程 EventLoop 时，Channel 怎么被分配到不同 loop？为什么默认线程数会和 CPU 数相关？多线程下“一个 loop 重建 selector”又为什么不会自动影响其他 loop？