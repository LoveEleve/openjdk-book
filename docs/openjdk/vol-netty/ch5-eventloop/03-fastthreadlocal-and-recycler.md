# Ch5-03 FastThreadLocal、InternalThreadLocalMap 与 Recycler

## 先把问题放回 Netty 自己的运行时环境里

很多人第一次看到 Netty 里的 `FastThreadLocal`、`InternalThreadLocalMap`、`Recycler`、`ObjectPool` 这些类，直觉都会有点抵触：JDK 已经有 `ThreadLocal`，对象分配也有 GC，为什么还要自己再造一套？如果孤立地看某个类，这种抵触很正常。因为单独拿出一两个工具类，确实很像“为了微优化而微优化”。

问题在于，Netty 不是在普通业务线程上偶尔做几次对象分配，也不是在短寿命线程里偶尔读写一次 `ThreadLocal`。它的大量核心路径都跑在长寿命 event loop 线程上，而且这些路径高度重复：handler 链不断流过同一批线程，codec 一直在出入对象，promise/listener 一直在堆叠回调，出站任务和各种小型包装对象被频繁创建、释放、再创建。从源码的线程本地缓存、对象池和复用容器设计可以确认，Netty 把这些重复访问和短命对象处理视为值得集中优化的运行时热点；至于具体收益，仍需结合基准和运行环境验证。

所以理解这套基础设施的关键，不是先问“它比 JDK 快多少”，而是先问：**Netty 的 event loop 热点到底在反复做哪些小而密的动作，以至于它宁愿自己准备一整块运行时缓存和对象复用层。**

这条线大致可以拆成两个问题面。

第一类问题，是高频线程本地访问。Netty 很多运行时状态并不是跨线程共享的大结构，而是“这条 event loop 线程自己随手就要用的东西”：一些字符串构建器、字符集编码器、类型匹配器缓存、future listener 深度计数、数组列表缓存，甚至是 `FastThreadLocal` 自己管理的 indexed variables。只要这些东西总在同一条长寿命线程上出现，访问和清理方式就非常值得专门优化。

第二类问题，是大量短命小对象的重复分配。像 codec 里用来暂存输出对象的 list，像出站路径里不断出现的任务或 entry，像某些只在一小段调用链里存在的包装对象，如果每次都 `new -> 使用 -> 交给 GC`，就会让这些对象持续经过分配和回收路径。Netty 并不想对所有对象都搞统一池化，但它确实为这类明显短命、重复、热点的对象准备了线程本地、可清理、可控的复用面。

于是它才把这两类问题拆开处理：`FastThreadLocal` 和 `InternalThreadLocalMap` 负责线程本地热点访问与缓存承载，`Recycler` 负责受控的小对象复用。后面我们会看到，这两条线不是彼此孤立的；相反，它们经常正好叠在一起。event loop 线程的长寿命和可控清理，为长期持有局部缓存和复用池提供了运行时条件。

## 先别急着谈对象池，先看为什么 Netty 连 thread-local 都要重写

如果只从接口名字看，`FastThreadLocal` 似乎只是 `ThreadLocal` 的更快版本。但如果这样理解，后面很容易滑到一种错误想法：仿佛 Netty 只是觉得 JDK `ThreadLocal` 不够快，所以简单换了个更激进的实现。真实情况要克制得多，当前源码能直接证明的是访问结构、线程类型和清理路径的差异，不能单凭实现形态替代基准测试下结论。

`FastThreadLocal` 的类注释一开始就把优化目标说得很清楚：它只是在访问来自 `FastThreadLocalThread` 时，尝试把 thread-local 访问从传统的按变量定位路径改成“固定索引访问数组槽位”，见 `common/src/main/java/io/netty/util/concurrent/FastThreadLocal.java:28`。而且注释紧接着就补了边界：只有线程本身是 `FastThreadLocalThread` 或其子类，才能走 快速路径；其他线程会回退到普通 `ThreadLocal` 路径，见 `common/src/main/java/io/netty/util/concurrent/FastThreadLocal.java:36`。

这两句话放在一起，已经说明它不是一个“无条件更快”的全局替代品，而是一套**依赖线程模型成立**的局部实现。只有当框架已经能识别并控制大量热点线程，比如 event loop 线程和 `DefaultThreadFactory` 创建出来的线程，才有理由采用这套路径；它带来的实际收益仍需由基准测试验证。

真正的实现也严格遵守了这个边界。每个 `FastThreadLocal` 在构造时都会从 `InternalThreadLocalMap.nextVariableIndex()` 拿到一个全局索引，见 `common/src/main/java/io/netty/util/concurrent/FastThreadLocal.java:126`。`get()` 时先去当前线程的 `InternalThreadLocalMap` 里按这个索引直接取值；没有值时再走 `initialize(...)`，把初始值塞进数组槽位，并登记到 `variablesToRemove` 集合里，见 `common/src/main/java/io/netty/util/concurrent/FastThreadLocal.java:136`、`:175`。

也就是说，`FastThreadLocal` 真正改变的不是“线程本地值的语义”，而是“值在当前线程内部怎么被找出来”。传统线程本地访问需要根据变量定位存储位置；`FastThreadLocal` 则是在框架能掌控线程模型时，提前给每个变量分一个固定槽位，让 event loop 线程以后直接按下标拿。与此同时，它在初始化时还会把自己登记进 `variablesToRemove` 集合里，这说明这条 快速路径 从一开始就不是只追求“拿得快”，而是把“之后能不能统一清理掉”一起纳入设计。

这件事从源码形态看是把通用定位路径改成了数组索引访问。对 Netty 这种长寿命线程模型来说，它可以让高频局部状态拥有稳定的存取位置；至于一次访问和整体吞吐究竟改善多少，不能脱离基准测试直接断言。Netty 的设计选择是先把这类热点访问集中到自己能够控制的线程模型里。

所以第一层心智模型可以先立住：**`FastThreadLocal` 不是新的线程本地语义，而是依赖受控线程模型的索引化访问路径。**它解决的是“在 Netty 自己能掌控的线程上，如何为线程本地热点访问提供固定槽位和统一清理”，而不是证明“JDK `ThreadLocal` 普遍不够用”。

## `InternalThreadLocalMap` 才是这条线真正的运行时容器

只看 `FastThreadLocal`，很容易误以为这一整套基础设施只是在给“每个 thread-local 变量”找一个更快的存放位置。真正把这条线拉开的，是 `InternalThreadLocalMap`。

这个类最重要的地方，不是名字里有个 map，而是它根本不是“一个 thread-local 值”。它更像是 Netty 在每条热点线程上挂的一整个运行时容器。

类里最显眼的确实是 `indexedVariables`，这块数组就是给 `FastThreadLocal` 提供槽位访问的，见 `common/src/main/java/io/netty/util/internal/InternalThreadLocalMap.java:63`。但再往下看就会发现，它装的东西远不止这一项。里面还有：

- `futureListenerStackDepth`；
- `localChannelReaderStackDepth`；
- `handlerSharableCache`；
- `TypeParameterMatcher` 的两层缓存；
- `StringBuilder`；
- charset encoder/decoder cache；
- `ArrayList` cache；
- 以及一些 cleaner flag。

对应定义见 `common/src/main/java/io/netty/util/internal/InternalThreadLocalMap.java:66`。

这说明一件非常关键的事：**Netty 不是把 thread-local 当成“给某个业务变量找个藏身处”，而是把线程本地热点缓存、运行时元信息和索引化变量统一收编进一个线程级容器。**

这也解释了为什么它要同时维护 `fastGet()` 和 `slowGet()` 两条路径。对于 `FastThreadLocalThread`，这个容器直接挂在线程对象的专用字段上，见 `common/src/main/java/io/netty/util/internal/InternalThreadLocalMap.java:119`；对于普通线程，则回退到 `slowThreadLocalMap` 这条普通 `ThreadLocal` 路径，见 `common/src/main/java/io/netty/util/internal/InternalThreadLocalMap.java:127`。换句话说，容器本身也在享受“受控线程走快路、普通线程走兼容路”的分层策略。

真正能看出它像“运行时容器”的，是几个常见缓存方法。

`stringBuilder()` 会在第一次访问时创建一个指定初始容量的 `StringBuilder`，之后重复复用；如果容量已经长得太大，还会主动把它缩回目标范围，见 `common/src/main/java/io/netty/util/internal/InternalThreadLocalMap.java:213`。`charsetEncoderCache()` 和 `charsetDecoderCache()` 则在每条线程上保留字符集编码器和解码器缓存，见 `common/src/main/java/io/netty/util/internal/InternalThreadLocalMap.java:226`。`arrayList()` 也不是每次新建，而是优先清空、复用已有的 list 并调整容量，见 `common/src/main/java/io/netty/util/internal/InternalThreadLocalMap.java:242`。

这些方法放在一起，可以确认 Netty 把线程本地缓存视为运行时承载面：字符串构建器、编码器、list 缓存、类型匹配器缓存等状态，都可以挂在对应线程的本地容器里复用。像后面会再次见到的 `CodecOutputList`，就是这种思路在 codec 热点里的一个具体代表。这里描述的是源码中的缓存设计，不等同于已经完成的性能基准结论。

所以第二层心智模型应该这样立：**`FastThreadLocal` 是访问入口，`InternalThreadLocalMap` 才是被持续复用的线程级运行时容器。**如果只看到前者，容易把整条线想窄；只有把后者也看进去，才会意识到 Netty 想优化的其实是一整块“热点线程自己的小世界”。

## `removeAll()` 说明这套东西不是只管快，还得管清理边界

线程本地缓存和复用池最容易被忽略的问题，不是“能不能更快”，而是“谁来收尾”。Netty 对这个问题其实非常清醒。

`FastThreadLocal.removeAll()` 不是简单清一个变量，而是先从 `InternalThreadLocalMap` 里拿到 `VARIABLES_TO_REMOVE_INDEX` 对应的集合，把当前线程上登记过的所有 `FastThreadLocal` 逐个 remove，再最终调用 `InternalThreadLocalMap.remove()` 把整个线程级容器摘掉，见 `common/src/main/java/io/netty/util/concurrent/FastThreadLocal.java:49`。这意味着框架从一开始就知道：只要你在长寿命线程上堆线程本地缓存，就必须有统一清理出口。

这件事在容器环境下尤其重要。很多服务端线程不是 JVM 进程结束就跟着消失，而是线程池、event loop 或外部容器长期持有的。如果没有 `removeAll()` 和 `destroy()` 这类显式清理入口，FastThreadLocal 这套东西很快就会从“性能优化”翻车成“长期残留的线程本地垃圾箱”。

所以要特别小心一个误解：看到 `FastThreadLocal` 和 `InternalThreadLocalMap` 采用了面向热点访问的实现，就以为它们只关心读取路径。其实它们同时也在定义线程级缓存的生命周期边界。Netty 不是把东西往线程里一塞就不管了，而是明确准备了“哪些变量被注册、如何统一 remove、slow path 容器如何 destroy”的收尾路径。

这一点非常重要，因为后面讲 `Recycler` 时会发现同样的思路还在：能复用很好，但必须是**受控复用**。只要线程模型、清理时机或归还边界失控，所谓优化就会变成新的长期负担。

## `Recycler` 解决的不是“所有对象都池化”，而是“热点短命对象如何受控复用”

如果说 `FastThreadLocal` 和 `InternalThreadLocalMap` 主要在解决“值怎么存、怎么快拿”，那 `Recycler` 解决的就是另一类问题：某些短命对象明明长得很小，却在事件循环热点上反复被创建和丢弃，这时是否值得让它们在线程本地或局部池里复用。

类注释把它定义得很克制：这是一个基于 线程本地栈 的轻量对象池，见 `common/src/main/java/io/netty/util/Recycler.java:39`。这里最值得注意的是“轻量”和“thread-local”。Netty 并没有打算把它做成一套全局、统一、无条件跨线程共享的对象池框架，而是先从热点线程的局部复用切入。

静态参数也说明了这一点。`Recycler` 会读取 `maxCapacityPerThread`、`chunkSize`、`ratio`、`blocking`、`batchFastThreadLocalOnly` 这些开关，见 `common/src/main/java/io/netty/util/Recycler.java:77`。这不是在宣告“池化永远更好”，而是在表达：复用本身是一件有容量、有比例、有线程模型约束的事，得受控地做。

最能说明这种克制的，是 `get()` 方法。若当前 recycler 绑定的是一个本地池 `localPool`，就直接从那里取；否则，如果当前线程根本不会清理 fast thread locals，Netty 宁可退回 `newObject(NOOP_HANDLE)`，也不强行把对象放进 thread-local 复用体系，见 `common/src/main/java/io/netty/util/Recycler.java:303`。换句话说，不是所有线程都默认有资格进入池化路径；只要清理边界不成立，Netty 就宁可老老实实 new 一个新对象。这一步非常关键，因为它说明框架并不是“能池化就池化”，而是明确把“线程是否受控、是否具备清理边界”当成前提条件。

这正是理解 `Recycler` 的关键：它不是 GC 的替代品，更不是“所有对象都值得放进池里”的价值判断。它只是在 Netty 自己最熟悉、最可控的线程模型里，优先把那些重复、短命、热点的小对象留在本地复用面上，减少反复 `new -> 丢弃 -> GC` 的噪声。

所以理解 `Recycler` 最好的方式，不是把它想成“更激进的对象池”，而是把它想成**事件循环热点上的受控复用面**。热点、短命、可控、可清理，这几个条件缺一个，收益和风险比都会变差。

## `Recycler` 为什么反复强调 owner、清理和无保护路径边界

很多人第一次看 `Recycler` 的构造器和注释，会被那些 `USE IT CAREFULLY`、`owner`、`unguarded` 之类的文字吓一跳，仿佛这个类好像特别危险。其实这些提醒恰好说明 Netty 对对象复用的态度非常清醒：它知道对象池的风险点在哪里，所以反而一直在强调边界。

例如，某些构造器允许把 recycler pin 到指定线程 owner，也允许关闭部分校验走 `unguarded` 路径，见 `common/src/main/java/io/netty/util/Recycler.java:161`。这不是在鼓励业务到处走捷径，而是在承认：在极端性能敏感场景里，确实有人需要更激进的局部优化；但一旦这么做，就必须自己承担“线程不会并发 get”“回收对象身份不会乱”“owner 生命周期可控”这些额外前提。

再比如 `threadLocalPool` 的初始化。只有在 `maxCapacityPerThread > 0` 且允许用 thread-local storage 时，Recycler 才会真正为每条线程创建 `LocalPool`；而且这个 `FastThreadLocal<LocalPool<?, T>>` 还专门重写了 `onRemoval(...)`，在变量被移除时清空内部句柄队列并解除 owner 引用，见 `common/src/main/java/io/netty/util/Recycler.java:269`。这和前面 `FastThreadLocal.removeAll()` 的思路完全一致：能复用很好，但线程级池化状态必须有清理出口。

所以这里最值得记住的，不是某个具体构造器参数，而是背后的设计态度。Netty 没有把对象复用浪漫化成“所有分配都该被池化”，反而不断提醒：只有在线程模型、池大小、批量比例和清理时机都大致受控时，这套复用面才成立。否则你得到的就不是优化，而是更难定位的对象生命周期问题。

这一点跟前面几篇里反复出现的主线其实是同一件事：Netty 的很多“快”都建立在“边界先被定义清楚”之上。`Recycler` 也是。它的重点不是省几次 `new`，而是以尽量小的风险把高频短命对象留在一个可管理的局部世界里。

## `ObjectPool` 说明这条线最终还是回收到 `Recycler`

理解这条基础设施线时，还有一个很容易误判的点：看到 `ObjectPool` 这个名字，很容易以为 Netty 同时维护着“ObjectPool 一套”和“Recycler 一套”并列机制。源码其实已经给出更明确的信号：`ObjectPool` 当前更多是一个兼容包装层，底层真正干活的还是 `Recycler`。

`ObjectPool.newPool(...)` 内部直接 new 了一个 `RecyclerObjectPool`，而这个包装类的核心成员又正是一个匿名 `Recycler<T>`，见 `common/src/main/java/io/netty/util/internal/ObjectPool.java:70`。再加上类和接口上大面积的 `@Deprecated` 标记，这基本已经把演化方向说透了：`ObjectPool` 不是一条与 `Recycler` 平行发展的长期主线，而是在旧接口语义上给出的一层过渡壳。

这点很重要，因为它提醒我们不要把注意力错误地分散到“对象池抽象是否优雅”上。对 Netty 当前实现来说，真正值得分析的是 `Recycler` 如何在热点线程上工作、如何受控复用、如何与 `FastThreadLocal` 和清理边界结合，而不是再额外发明一套并列的对象池世界。

所以如果要给这条线做一个简化判断，可以这样记：`ObjectPool` 在今天更多是 API 兼容层；`Recycler` 才是 Netty 对“小对象如何受控复用”给出的核心答案。

## `CodecOutputList` 和 `TypeParameterMatcher` 证明：这不是并发包里的孤立优化

讲到这里，还得再解决一个很容易出现的误会：就算 `FastThreadLocal`、`InternalThreadLocalMap`、`Recycler` 本身说得通，会不会它们只是 common/concurrent 目录里的局部实现技巧，离真正的 codec、pipeline、handler 热点还有点远？

答案是否定的。`CodecOutputList` 和 `TypeParameterMatcher` 恰好说明，这条基础设施线已经深入到了 Netty 的日常热点面里。

先看 `CodecOutputList`。它是 codec base classes 内部使用的一个特殊 `AbstractList`，而它最关键的地方不是 list 本身，而是背后那组 `FastThreadLocal<CodecOutputLists>` 缓存，见 `codec-base/src/main/java/io/netty/handler/codec/CodecOutputList.java:27`、`:38`。每条线程会缓存一批 `CodecOutputList` 实例，默认一次准备 16 个，拿不到时才退回到不缓存的新对象，见 `codec-base/src/main/java/io/netty/handler/codec/CodecOutputList.java:41`、`:69`。这说明 codec 并没有把“每次 encode/new 一个 ArrayList”当作理所当然，而是直接建立在线程本地复用面上。

再看 `TypeParameterMatcher`。它在 `get(...)` 和 `find(...)` 里直接去 `InternalThreadLocalMap` 里拿 `typeParameterMatcherGetCache` 和 `typeParameterMatcherFindCache`，见 `common/src/main/java/io/netty/util/internal/TypeParameterMatcher.java:31`、`:48`。也就是说，就连这种看起来偏反射、偏泛型辅助的热点判断，也已经被收编到同一块线程级运行时容器里。

这两个例子放在一起非常有说服力。因为它们分别落在两个完全不同的面上：一个是 codec 的高频对象列表，一个是类型匹配的元信息缓存。Netty 仍然用同样的基础设施思路处理它们：如果某类小对象或小缓存会在长寿命线程热点上被反复命中，那就优先把它们留在线程本地、可复用、可统一清理的容器里，而不是每次都从零开始。

所以这条线的真正价值，并不在于 `FastThreadLocal` 这个类本身写得多漂亮，也不在于 `Recycler` 某个局部池结构多精巧，而在于它们已经变成了 Netty 整体运行时风格的一部分。codec、匹配器、listener 栈深、字符串缓存、list 缓存，都在吃同一套基础设施红利。

这也正好说明，我们分析它时不该把它当成“并发包里的小专题”，而应该把它看成 Netty 热点运行时的公共底盘。

## 收网：这套基础设施真正要优化的，不是某个类，而是一整块热点线程小世界

现在可以把整条主线收回来了。为什么 Netty 要自己造 `FastThreadLocal`、`InternalThreadLocalMap`、`Recycler` 这一套？不是因为 JDK 没法用，而是因为 Netty 的长寿命 event loop 线程和高频 handler/codec 热点，把很多原本可以忽略的小成本不断累积出来了。

- `FastThreadLocal` 通过全局索引和数组槽位，把受控线程上的 thread-local 访问从查表改成定点访问，见 `common/src/main/java/io/netty/util/concurrent/FastThreadLocal.java:126`。  
- `InternalThreadLocalMap` 不是单值 thread-local，而是每条热点线程自己的运行时容器，里面放着 indexed variables、字符串缓存、编码器缓存、list 缓存、类型匹配器缓存和多种元信息，见 `common/src/main/java/io/netty/util/internal/InternalThreadLocalMap.java:66`。  
- `Recycler` 则把大量重复、短命、热点的小对象复用收编成一套受控 线程本地对象池，并且始终把 owner、清理、容量和线程模型边界放在前面，见 `common/src/main/java/io/netty/util/Recycler.java:39`。  
- `ObjectPool` 说明兼容层最终也在回收到 `Recycler` 这条主线，见 `common/src/main/java/io/netty/util/internal/ObjectPool.java:70`。  
- `CodecOutputList` 和 `TypeParameterMatcher` 证明这套基础设施已经深入到 codec 和反射匹配热点里，而不是只停留在 common 包，见 `codec-base/src/main/java/io/netty/handler/codec/CodecOutputList.java:38`、`common/src/main/java/io/netty/util/internal/TypeParameterMatcher.java:31`。

所以本篇真正要留下来的心智模型是：**Netty 优化的不是某个单独工具类，而是一整块“热点线程自己的小世界”。**在这块小世界里，线程本地值怎么快拿、哪些小对象值得反复用、哪些缓存该集中放、什么时候必须统一清理，都会被当成同一个运行时问题来处理。

有了这层理解，后面再去看内存池 thread cache、出站写任务复用、codec 小对象缓冲，甚至一些看起来莫名其妙的 `FastThreadLocal` 使用点，就不会再觉得它们只是零散技巧。它们只是 Netty 在同一条原则下的不同落点：**把热点线程上反复发生的小成本，尽量留在一个受控、可复用、可清理的局部运行时里。**