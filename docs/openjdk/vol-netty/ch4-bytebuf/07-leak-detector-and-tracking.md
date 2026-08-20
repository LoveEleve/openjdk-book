# Ch4-07 Netty 内存泄漏检测与定位

## 先把一个常见误会拆掉

很多人第一次看到 Netty 的泄漏日志，第一反应都差不多：既然 `ByteBuf` 已经有 `refCnt`，为什么系统里还会出现泄漏？难道引用计数本身没有防住吗？

这个问题之所以常见，是因为它把两件相邻但不同的事情混在了一起。`refCnt` 解决的是“对象归零时如何显式回收”，也就是给资源生命周期一个明确的终点；但它并不保证业务一定会走到这个终点。换句话说，Netty 已经把“正确回收应该长什么样”定义清楚了，可它没有魔法去强迫每个 handler、每个 codec、每个异步失败分支都真的走到最后那次 `release()`。

只要对象所有权协议在某个地方被破坏，泄漏就仍然会发生。比如一个 handler 拿到消息以后缓存起来，却忘了在异常路径里 release；比如一个派生视图跨异步边界继续活着，但原本的调用点已经不再管它；比如一次 write 失败以后，业务既没有自己兜底，也没有把 responsibility 正确交给运行时。所有这些场景里，`refCnt` 并没有失效，它只是一直没被减到 0。

所以 Netty 的 leak detector 不是“第二套回收机制”，更不是“自动替你补 release 的保险丝”。它做的事情其实非常克制：既然框架不能替你决定业务上的最后一次 release，那它至少要在对象已经走丢以后，尽量告诉你它是怎么走丢的。于是这套机制干的不是“修复泄漏”，而是“给泄漏留痕”。

这就是本篇的核心问题：**Netty 到底如何把“某个该 release 的对象最终没有归零”这件事，转化成一条可定位的日志。**只要这条链路讲清楚，`SIMPLE/ADVANCED/PARANOID`、leak-aware wrapper、`touch()`、`record()`、弱引用队列、`Created at` 和 `Recent access records` 这些零散名词就会自动拼起来。

## 先定义：Netty 说的“泄漏”到底是什么

如果不先定义“什么叫泄漏”，后面所有实现细节都会显得像技巧堆叠。Netty 对 leak 的定义，和很多人直觉里“对象活得太久了”并不完全一样。

`ResourceLeakDetector.track(obj)` 的合同写得很直白：它会为对象创建一个 `ResourceLeakTracker`，并且这个 tracker 预期会在相关资源 deallocate 时通过 `close(trackedObject)` 被关闭，见 `common/src/main/java/io/netty/util/ResourceLeakDetector.java:248`。这句话非常重要，因为它说明 detector 关注的核心不是“对象多久没被回收”，而是“这份 tracker 最终有没有被正确 close”。

反过来看 `SimpleLeakAwareByteBuf.release()` 就更清楚了。这个 wrapper 在 `super.release()` 返回 true、也就是引用计数真的归零以后，会调用 `closeLeak()`，进而执行 `leak.close(trackedByteBuf)`，见 `buffer/src/main/java/io/netty/buffer/SimpleLeakAwareByteBuf.java:142`、`buffer/src/main/java/io/netty/buffer/SimpleLeakAwareByteBuf.java:170`。Composite 版本也是同一逻辑，见 `buffer/src/main/java/io/netty/buffer/SimpleLeakAwareCompositeByteBuf.java:33`。这说明对 Netty 来说，一次“正确的生命周期结束”至少包含两件事：业务或运行时把 `refCnt` 真正减到了 0，以及相应的 leak tracker 被成功 close。

于是泄漏的定义就可以说得很精确了：**一个被 track 过的对象，本来应该在生命周期结束时 close 掉对应的 tracker；如果这个 tracker 迟迟没被 close，而底层对象却已经先一步走到了 GC 可见的不可达状态，这就是 leak。**

这个定义和“内存还没被回收”有关系，但不完全等同。因为 detector 不是通过扫描所有活着的对象来判断泄漏，而是通过“谁已经被 GC 发现不可达了，但 tracker 还没关”来判断。换句话说，它抓的是**丢失控制权以后暴露出来的生命周期违约**，不是简单地抓“对象还在内存里待着”。

这也解释了两个常见误会。

第一，Netty 的 leak detector 不是对象存活时长监控器。一个对象哪怕活了很久，只要 ownership 清楚、最终也确实走到了 `release -> close tracker`，就不构成 leak。反过来，一个对象即使只存在很短时间，只要业务把最后那次 release 漏掉了，detector 仍然会把它看成泄漏。

第二，leak detector 不是 `refCnt` 的替代品。没有 `refCnt`，框架连“正确收尾”这件事都没有统一入口；有了 `refCnt`，框架才能进一步定义“如果这条收尾链没有闭环，该如何记录违约证据”。所以引用计数和泄漏检测不是二选一，而是前后衔接的两层协议：前者定义正确释放动作，后者在动作没有完成时帮助定位责任断点。

## 真正的总图：分配时挂 tracker，释放时关 tracker，没关上就等后续上报

理解 leak detector，最重要的不是记类名，而是先在脑子里立一张最小总图。对 ByteBuf 主线来说，这条链路可以压缩成五步。

第一步，分配器在对象进入系统时决定要不要跟踪它。`AbstractByteBufAllocator.toLeakAwareBuffer()` 会先执行 `AbstractByteBuf.leakDetector.track(buf)`，如果拿到了 tracker，就根据当前级别决定包成 `AdvancedLeakAwareByteBuf` 还是 `SimpleLeakAwareByteBuf`，见 `buffer/src/main/java/io/netty/buffer/AbstractByteBufAllocator.java:40`。CompositeByteBuf 也走同样的包装入口，见 `buffer/src/main/java/io/netty/buffer/AbstractByteBufAllocator.java:52`。这一步说明 leak detector 不是业务代码随手调一下的辅助函数，而是 allocator 在对象出生点统一注入的跟踪装置。

第二步，运行时在对象流转过程中选择性记录访问痕迹。对象一旦被包成 leak-aware wrapper，后续的 `retain()`、`release()`、派生视图操作、甚至部分非引用计数读写操作，都可能在 wrapper 层被记录成访问轨迹。是否记录、记录多少、记录哪些操作，取决于当前级别以及使用的是 Simple 还是 Advanced wrapper。

第三步，正常释放路径会在对象真正归零时关闭 tracker。对 leak-aware ByteBuf 来说，`release()` 成功归零以后会显式调用 `leak.close(trackedByteBuf)`，见 `buffer/src/main/java/io/netty/buffer/SimpleLeakAwareByteBuf.java:173`。也就是说，Netty 并不是等 GC 来“顺便发现这个对象没有泄漏”，而是在正常路径里主动声明：这份 tracker 到此为止应该被关闭。

第四步，如果 tracker 一直没有被关闭，而对象本身已经不再强可达，那么弱引用机制就会把它送进 detector 的引用队列。`ResourceLeakDetector` 内部维护了 `allLeaks`、`refQueue` 和 `reportedLeaks` 三组核心结构，见 `common/src/main/java/io/netty/util/ResourceLeakDetector.java:168`。一份 leak 的真正“尸体”不是业务对象本身，而是那个绑定在弱引用上的 tracker 条目。

第五步，后续某次新的 `track()` 或显式检查触发 `reportLeak()` 时，detector 会轮询 `refQueue`，把那些已经入队但仍未 close 的 tracker 生成报告，再打印 traced 或 untraced 日志，见 `common/src/main/java/io/netty/util/ResourceLeakDetector.java:311`。所以日志不是在对象“走丢”的当下瞬间同步产生，而是在后续检测周期里被拖出来报告。

这张图一旦立住，很多零散实现都会自动归位：

- allocator 包装点负责“出生时挂 tracker”；
- leak-aware wrapper 负责“活着时记录轨迹、死掉时关 tracker”；
- 弱引用队列负责“对象真丢了以后把案发记录送进候审区”；
- `reportLeak()` 负责“把旧案翻出来形成日志”。

从这个角度看，leak detector 真正解决的不是回收问题，而是证据链问题。它把一个原本在 GC 阶段几乎不可追溯的“漏 release”事故，尽量改造成一条还能回头看的运行时轨迹。

## 先看默认策略：为什么默认不是全量跟踪

看到这里，很多人会自然提出一个问题：既然这套机制这么有用，为什么默认不把所有对象、所有访问、所有堆栈都记下来？

答案很现实：代价太高。

`ResourceLeakDetector` 的静态配置已经把这个取舍写得很清楚。默认级别是 `SIMPLE`，默认 `TARGET_RECORDS` 是 4，默认采样间隔是 128，见 `common/src/main/java/io/netty/util/ResourceLeakDetector.java:44`、`common/src/main/java/io/netty/util/ResourceLeakDetector.java:48`、`common/src/main/java/io/netty/util/ResourceLeakDetector.java:51`。静态初始化时会读取 `io.netty.leakDetection.level`、`io.netty.leakDetection.targetRecords`、`io.netty.leakDetection.samplingInterval` 和 `trackClose` 等开关，见 `common/src/main/java/io/netty/util/ResourceLeakDetector.java:107`。

这里的设计意图很明显：默认模式首先考虑的是“线上可接受的开销”，而不是“每次都把排障信息拉满”。`track0()` 里真正的采样逻辑也证明了这一点。只有在三种情况下 tracker 才一定或有机会被创建：

- 强制跟踪；
- 当前级别是 `PARANOID`；
- 或者级别不是 `DISABLED`，且随机数命中采样间隔。

对应实现见 `common/src/main/java/io/netty/util/ResourceLeakDetector.java:280`。也就是说，在默认 `SIMPLE` 下，大多数对象根本不会创建 tracker，只有按采样命中的那一小部分才会被跟踪。

这正是理解 `SIMPLE/ADVANCED/PARANOID` 的关键。它们不是“准确 / 不准确”三档，而是“你愿意付出多大成本来换取多少定位信息”的三档。

- `SIMPLE` 的重点是“先告诉你系统里确实存在漏 release”，即使证据不够细，也比完全闷着强；默认情况下，很多这类报告最后只会落成后文要讲的 `untraced` 级别提示。
- `ADVANCED` 的重点是“除了告诉你有 leak，还尽量保留最近访问轨迹”。
- `PARANOID` 的重点是“宁可代价最高，也要几乎不放过每个对象”。

`isRecordEnabled()` 进一步把这一点钉死了。只有当前级别是 `ADVANCED` 或 `PARANOID`，并且 `TARGET_RECORDS > 0` 时，record 才真正有意义，见 `common/src/main/java/io/netty/util/ResourceLeakDetector.java:275`。换句话说，在默认 `SIMPLE` 下，即使你看到了 leak-aware wrapper，也不该想当然地以为“每次 touch 都会帮我记栈”。大多数情况下，Simple 模式追求的是“低成本发现是否存在问题”，不是“完整重建对象一生”。

这个设计看起来保守，但非常符合 Netty 的定位。泄漏检测是排障能力，不是常态业务主线。默认配置必须先保证不把正常流量拖慢；真正需要细查时，再显式把 detector 拉到更重的级别。否则这套机制本身就可能从“定位问题”变成“制造额外负担”的来源。

## 为什么要有 Simple 和 Advanced 两层 wrapper

知道了级别取舍以后，下一步最容易困惑的问题是：既然都叫 leak-aware，为什么还要分成 `SimpleLeakAwareByteBuf` 和 `AdvancedLeakAwareByteBuf` 两层？

如果只看名字，很容易误以为 Advanced 只是“Simple 多打一些日志”。实际差别比这更结构化。

Simple 层的核心责任，是确保一条最基本的闭环：对象被 track 过，后续如果成功归零，就一定能关掉 tracker；如果对象是派生视图，还要尽量确保派生链路不会把 tracker 丢掉。比如 `SimpleLeakAwareByteBuf.release()` 在 `super.release()` 返回 true 时关闭 leak，见 `buffer/src/main/java/io/netty/buffer/SimpleLeakAwareByteBuf.java:143`。它还会在 `retainedSlice()`、`retainedDuplicate()`、`readRetainedSlice()` 以及派生视图相关路径里处理 tracker 继承和异常补充，见 `buffer/src/main/java/io/netty/buffer/SimpleLeakAwareByteBuf.java:83`、`buffer/src/main/java/io/netty/buffer/SimpleLeakAwareByteBuf.java:186`。

这里最值得注意的是 `unwrappedDerived(...)`。如果派生对象最终落到了 `AbstractPooledDerivedByteBuf`，Simple wrapper 并不会只把原来的 tracker 机械复用下去，而是会先把 parent 指向当前 wrapper，再强制对派生对象执行 `trackForcibly(derived)`，见 `buffer/src/main/java/io/netty/buffer/SimpleLeakAwareByteBuf.java:191`、`buffer/src/main/java/io/netty/buffer/SimpleLeakAwareByteBuf.java:196`。这一步非常关键，因为它说明 Netty 已经意识到：派生视图是泄漏定位里天然容易断线的一层，如果只把“父对象有 tracker”当成足够条件，很多真实事故最后会只留下一个模糊的父对象创建点，而看不到派生链路在哪里偏离了 ownership 协议。

Advanced 层则是在 Simple 的闭环之上，再补一层“访问轨迹记录”。`AdvancedLeakAwareByteBuf` 定义了 `recordLeakNonRefCountingOperation(leak)`，除非 `io.netty.leakDetection.acquireAndReleaseOnly` 开关开启，否则会对很多非引用计数操作也执行 `leak.record()`，见 `buffer/src/main/java/io/netty/buffer/AdvancedLeakAwareByteBuf.java:38`、`buffer/src/main/java/io/netty/buffer/AdvancedLeakAwareByteBuf.java:63`。后面你会看到它几乎覆盖了 slice、duplicate、discard、ensureWritable、各种 get/set/read/write 类操作，见 `buffer/src/main/java/io/netty/buffer/AdvancedLeakAwareByteBuf.java:69`。

于是两层 wrapper 的差别可以用一句话概括：

- **Simple** 关注的是“别把 tracker 弄丢，最终 release 时要能关掉它”；
- **Advanced** 关注的是“如果最后没关掉，我还想知道对象在丢失之前都经历过什么”。

这也是为什么本篇前面一直强调：leak detector 的目标不是自动修复，而是留证。Simple 至少保证“案子能立起来”，Advanced 才进一步保证“案卷里有更多经过”。如果没有这层分工，默认线上模式不是信息太少，就是开销太大，两头都不讨好。

## 真正的难点：访问轨迹不是完整历史，而是压缩后的证据链

大多数人第一次看到 leak 日志时，最想知道的是：这堆 `Recent access records` 到底怎么来的，它为什么有时只有几条，有时还写着 dropped records？

要回答这个问题，得看 `DefaultResourceLeak` 里面那套记录结构。每个 tracker 本质上是一个 `WeakReference`，同时内部维护一条 `TraceRecord` 链，头节点通过原子字段更新器维护，见 `common/src/main/java/io/netty/util/ResourceLeakDetector.java:399`、`common/src/main/java/io/netty/util/ResourceLeakDetector.java:414`。每次 `record()` 或 `record(hint)`，最后都会进 `record0(...)`，见 `common/src/main/java/io/netty/util/ResourceLeakDetector.java:442`、`common/src/main/java/io/netty/util/ResourceLeakDetector.java:478`。

`record0(...)` 最有意思的地方，不是“把当前堆栈存起来”，而是“怎么在有限成本下存”。如果当前记录数还没达到 `TARGET_RECORDS`，它就正常把新 `TraceRecord` 压到头部；一旦记录数超过目标值，就开始根据 `backOffFactor` 做概率丢弃，见 `common/src/main/java/io/netty/util/ResourceLeakDetector.java:491`、`common/src/main/java/io/netty/util/ResourceLeakDetector.java:493`。这意味着 detector 根本没想过保留完整历史，它保留的是“创建点 + 最近若干条访问轨迹”的压缩样本。

这个取舍背后非常合理。真实系统里，高频缓冲对象可能被访问很多次。如果每次都完整保留堆栈，不仅内存开销会暴涨，报告里也会堆满重复噪声，最后反而不利于定位。Netty 这里的策略更像一份案情摘要：我不保证给你一生流水账，但我尽量给你最近几次关键接触记录，以及最早的创建点。

`generateReport(...)` 就是在把这份摘要转成最终日志。它会先写 `Recent access records:`，再逆着 `TraceRecord` 链输出最近访问点；如果走到 `TraceRecord.BOTTOM` 前的最后一条，就标成 `Created at:`；同时它还会统计两类被压缩掉的信息：重复记录数量和因为超出目标数量而被丢弃的记录数量，见 `common/src/main/java/io/netty/util/ResourceLeakDetector.java:589`、`common/src/main/java/io/netty/util/ResourceLeakDetector.java:601`、`common/src/main/java/io/netty/util/ResourceLeakDetector.java:618`、`common/src/main/java/io/netty/util/ResourceLeakDetector.java:625`。

这就是为什么你看到的 leak 日志永远不是“完整历史回放”，而是一份经过压缩和去重的证据链。它足够回答两个关键问题：

- 这份对象最初是从哪里出生的；
- 在它丢失控制权之前，最近还被哪些调用点碰过。

对排障来说，这通常已经够用了。真正需要的不是把对象的一生复印出来，而是把 ownership 最可能断掉的那几个边界暴露出来。`TraceRecord` 的取舍正是朝这个目标优化的。

## 日志为什么有 traced 和 untraced 两种

理解了记录机制以后，再看 `reportLeak()` 和最终日志文案，就会发现 Netty 连“给不出细轨迹时怎么说”都专门分了两档。

`reportLeak()` 轮询 `refQueue` 时，会先看 `dispose()` 能不能成功把 tracker 从 `allLeaks` 移除；如果能，再取 `records = ref.getReportAndClearRecords()`，然后根据 `records` 是否为空，决定调用 `reportUntracedLeak` 还是 `reportTracedLeak`，见 `common/src/main/java/io/netty/util/ResourceLeakDetector.java:317`、`common/src/main/java/io/netty/util/ResourceLeakDetector.java:328`。

`reportTracedLeak(...)` 的文案会直接把 `records` 拼到日志后面，见 `common/src/main/java/io/netty/util/ResourceLeakDetector.java:348`。而 `reportUntracedLeak(...)` 则会明确告诉你：当前只有“某个 `release()` 没有在对象被 GC 前调用”的结论，如果想知道 leak 发生在哪里，需要开启 advanced leak reporting，见 `common/src/main/java/io/netty/util/ResourceLeakDetector.java:359`。

这两档文案的存在非常说明问题。Netty 并没有假装自己在所有模式下都能给出定位细节。默认模式下，它愿意先用较低成本告诉你“确实有问题”；如果你需要真正顺着日志往上追，就得接受更高的记录成本，把 detector 切到更细的级别。

这也是生产排障里一个经常被误解的点：看到 untraced leak，不代表 detector 坏了，而是说明你当前只启用了“发现问题”的力度，还没启用“展开轨迹”的力度。反过来，traced leak 也不意味着报告里包含了对象的一切历史，它只是说明当前配置足够让 detector 输出被保留下来的若干访问轨迹。

从方法论的角度看，这两档文案其实非常诚实。它没有把不足的信息伪装成完整结论，也没有把更高成本的定位能力偷偷塞进默认路径，而是把“发现问题”和“深入定位”明确拆成两步。对一个高性能运行时来说，这种克制比“一上来就全开”更合理。

## 工厂和排除表说明：这套机制不是硬编码死的

到这里还可以再补一层理解：leak detector 虽然深深嵌在 ByteBuf 主线里，但 Netty 仍然给它留了可替换和降噪的扩展点。

先看工厂。`ResourceLeakDetectorFactory` 维护了一个全局单例工厂，允许通过 `setResourceLeakDetectorFactory(...)` 替换默认实现，而且文档明确要求这件事要在 Netty Bootstrap 初始化前完成，见 `common/src/main/java/io/netty/util/ResourceLeakDetectorFactory.java:33`、`common/src/main/java/io/netty/util/ResourceLeakDetectorFactory.java:45`。默认工厂还支持通过 `io.netty.customResourceLeakDetector` 这个 system property 注入自定义 detector 构造器，见 `common/src/main/java/io/netty/util/ResourceLeakDetectorFactory.java:95`。这说明 detector 不是写死在 `new ResourceLeakDetector<>()` 这一层，而是被 Netty 视作一个可前置定制的基础设施组件。

再看排除表。`ResourceLeakDetector.addExclusions(...)` 允许把某些类的方法从最终堆栈报告里过滤掉，见 `common/src/main/java/io/netty/util/ResourceLeakDetector.java:644`。这件事之所以重要，是因为 leak detector 如果不主动降噪，最终报告很容易被框架自身的包装方法刷满，读者反而看不到真正有意义的业务访问点。

例如 `ReferenceCountUtil` 的静态初始化就把自己的 `touch` 加入了排除表，见 `common/src/main/java/io/netty/util/ReferenceCountUtil.java:31`；`AbstractByteBufAllocator` 会排除 `toLeakAwareBuffer`，见 `buffer/src/main/java/io/netty/buffer/AbstractByteBufAllocator.java:36`；`AdvancedLeakAwareByteBuf` 也会把 `touch` 和 `recordLeakNonRefCountingOperation` 之类的内部记录方法排除掉，见 `buffer/src/main/java/io/netty/buffer/AdvancedLeakAwareByteBuf.java:51`。这意味着 detector 输出的堆栈并不是“原始 JVM 栈完全照搬”，而是经过一层很有针对性的清洗。

这一点对排障非常关键。真正有用的 leak 日志，不是把框架所有内部跳板都列一遍，而是尽量把“哪一层业务或哪一段真正的协议转移打断了 ownership”暴露出来。工厂提供可替换性，排除表提供可读性，两者都说明 Netty 把 leak detector 当成一套长期可维护的排障基础设施，而不是一段临时补丁。

## 真正拿到泄漏日志以后，应该怎么读

讲完实现，还得回到读者最关心的现实问题：如果线上真的刷出一条 `LEAK: ByteBuf.release() was not called before it's garbage-collected`，应该怎么读，才不会只停留在“啊，漏了”。

第一步，不要把它当成“GC 太晚”问题，而要先当成 ownership 协议问题。泄漏日志说明的不是 JVM 怎么了，而是某一份被 track 的对象在生命周期结束前，tracker 没有被正确 close。换成业务语言，就是：本来应该有一条 `release -> close tracker` 的链路闭环，但 somewhere 断掉了。

第二步，看它是 traced 还是 untraced。如果是 untraced，说明当前 detector 只告诉你“确实有 leak”，却没有足够访问轨迹。这时最重要的动作不是硬猜，而是结合环境决定是否临时切到更高检测级别。如果已经是 traced，就继续往下看访问记录。

第三步，先看 `Created at`，再看 `Recent access records`。创建点告诉你对象从哪里出生，但它通常不是罪魁祸首，只是案件起点。真正有价值的往往是最近访问点：那些离案发现场最近的 retain、slice、write、包装、转发、缓存动作，最有可能对应 ownership 断裂的地方。

第四步，把最近访问点映射回本篇上一章建立的那张角色图：

- 如果最后几条记录都落在某个业务 handler，很可能是消费者终结责任漏掉了；
- 如果记录停在某个派生视图操作后面，可能是 slice/duplicate 跨边界继续活着，但原调用点忘了 retain 或忘了对应 release；
- 如果记录停在 write / queue / buffer 相关路径附近，就要检查这次对象到底有没有正确交给出站运行时托管，以及失败分支是不是绕开了正常兜底；
- 如果记录停在 codec 附近，就要看旧对象 ownership 是否已经在编码或解码边界被消费，而业务仍误以为它还由别处负责。

第五步，不要忘了日志本身是压缩视图。`Recent access records` 只有最近若干条，重复和超量记录会被丢弃，见 `common/src/main/java/io/netty/util/ResourceLeakDetector.java:618`、`common/src/main/java/io/netty/util/ResourceLeakDetector.java:625`。所以它不是完整历史，而是排障入口。真正的工作是顺着这些入口回到 ownership 断裂最可能发生的边界，再结合源码和失败路径去补洞。

如果把这套读法掌握了，leak 日志就不再只是“系统抱怨了一句 release 没调用”，而是 ownership 调试器交给你的问题地图。你要找的不是“哪一行没写 release”这么机械的答案，而是“哪一次责任转移没人接住”。

## 收网：leak detector 不是回收器，它是 ownership 协议的事故记录仪

现在可以回到开篇那个问题了：既然已经有 `refCnt`，为什么还要 leak detector？

因为 `refCnt` 只定义正确回收的动作，不保证业务一定做到；而 leak detector 则是在这条动作链没有完成时，尽量保留下证据。

- allocator 在对象出生点决定是否挂 tracker，并注入 Simple 或 Advanced wrapper，见 `buffer/src/main/java/io/netty/buffer/AbstractByteBufAllocator.java:40`。
- leak-aware wrapper 在正常 `release()` 归零时关闭 tracker，在高级模式下还会记录访问轨迹，见 `buffer/src/main/java/io/netty/buffer/SimpleLeakAwareByteBuf.java:142`、`buffer/src/main/java/io/netty/buffer/AdvancedLeakAwareByteBuf.java:63`。
- detector 用弱引用队列等待“对象先走丢、tracker 仍未 close”的时刻，再在后续 `reportLeak()` 中形成 traced 或 untraced 日志，见 `common/src/main/java/io/netty/util/ResourceLeakDetector.java:311`。
- `TraceRecord` 和排除表保证最终报告不是完全失控的堆栈转储，而是面向排障的压缩证据链，见 `common/src/main/java/io/netty/util/ResourceLeakDetector.java:589`、`common/src/main/java/io/netty/util/ResourceLeakDetector.java:644`。

所以这篇真正要留下来的心智模型是：**leak detector 不是自动修理工，而是 ownership 协议的事故记录仪。**它不能替你补 `release()`，但它会尽量告诉你：哪一类对象丢了、最近在哪里被碰过、创建点在哪里、当前证据有多细。

这也正好把下一篇自然引出来。既然 leak detector 已经说明“谁该 release”一旦说不清就会留下什么痕迹，后面接着要看的，正是 `ChannelOutboundBuffer` 和 writability：对象写出去以后，Netty 的运行时托管区到底如何接管一段生命周期，如何在 flush、背压、close 和失败路径里兜底释放。等这条线再接上，`touch(msg)`、PendingWrite、HTTP/2 frame 里那些看似零碎的 release 规则，就会继续回到同一张 ownership 总图上。