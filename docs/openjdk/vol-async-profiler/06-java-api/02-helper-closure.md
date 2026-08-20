# 02. native 注进去以后，Java 谁来接？——Instrument、LockTracer、Recording/Span 与 helper 闭环

> **前置依赖**：[AP-3 —— BytecodeRewriter 与 JVM 集成](../03-jvm-integration/02-bytecode-rewriter.md)、[AP-5 —— JFR recorder](../05-output-formats/02-jfr-recorder.md)、[AP-6-01 —— Java API 入口](./01-java-api.md)
> → **后续**：本卷收束
>
> 场景：native 侧织入字节码、拦截 JNI 注册或产生业务 span 后，Java 世界必须有最小的可调用落点来接住这些能力。
>
> 本篇基于当前 async-profiler 源码，重点讨论几类 Java helper / closure 角色：native 侧织入或注册之后，Java 世界里到底由谁接住这些调用；`Instrument`、`LockTracer`、`Recording`、`Span`、`JfrSync` 各自解决什么问题。这里的 helper 不是新的 profiler 内核，而是 native 能力在 Java 侧的“落点”和“桥”。以下结论以 `helper/one/profiler/*.java`、`Recording.java`、`Span.java`、`instrument.cpp`、`lockTracer.cpp`、`javaApi.cpp`、`threadLocalData.*` 为准。

## 先把真正的困惑摆出来：native 把能力织进 JVM 之后，Java 世界总得有人接电话

前几篇已经把几条主链讲清了：BytecodeRewriter 能织入调用，LockTracer 能接管 `Unsafe.park` 的注册链，JFR writer 能把 native 事件写成 chunk，Java API 也已经能把 `.so` 变成 `AsyncProfiler` 单例。乍看之下，好像真正重要的东西都已经在 native 世界里完成了。

但只要你继续往 JVM 运行时走一步，就会撞上一个更具体、也更容易被忽视的空档：native 做完这些动作之后，Java 世界里到底由谁来接？如果字节码里被塞进 `invokestatic one/profiler/Instrument.recordEntry()`，那 `Instrument` 是谁？如果要在 bootstrap class loader 的语境里安全地 `RegisterNatives`，谁来充当那个“可信 Java 门面”？如果业务代码想主动写一个 span，并且希望它和 profiler/JFR 事件共用同一条时间线，谁来把 Java 的时间、线程局部事实和 native 录制流接起来？

这里最容易冒出来的两个极端直觉，其实都不对。

第一个极端，是认为既然主逻辑已经在 native，所有事情都可以直接碰 native，Java 世界根本不需要 helper。问题在于，JVM 并不会接受“改写后的字节码直接调用某个 native 地址”这种表达；`RegisterNatives` 也不总能在任意类加载器和调用栈上下文里静默完成；JDK 自己的 Java API，比如 `jdk.jfr.Recording`，更不可能让 native 绕过 Java 身份直接去调用。native 逻辑再强，也总得在 Java 世界找到一个合法、可加载、可被字节码引用、可出现在调用栈上的收件人。

第二个极端，则是反过来给每个 native 能力都做一个厚重的 Java façade，再由 Java 反复回调 JNI。这样当然也能跑，但很快就会把主逻辑、状态判断、性能路径和 JVM 兼容细节重新搬回 Java 层。对 async-profiler 这种 native-first 的系统来说，这恰恰是它最不想付出的代价。

所以当前实现采用的是一条非常克制的中间路线：不把主逻辑搬到 Java，只在 Java 世界创造一组极薄的 helper，让它们分别充当收件箱、trusted 代理和时钟桥。它们的共同点不是“功能很多”，而是“刚好够用”：够让字节码引用一个普通静态方法，够让 `RegisterNatives` 发生在 JVM 愿意接受的上下文里，够让业务 span 与 profiler 时钟/线程局部样本对齐，够让 JDK Java API 有一个合法代理出面交互。

```text
native 需要一个 Java 落点
  ├─ 字节码织入落点 → Instrument
  │    → native Instrument::recordEntry/recordExit0
  ├─ trusted JNI/loader 上下文 → LockTracer
  │    → native setEntry0 / RegisterNatives(Unsafe.park)
  ├─ clock/state/thread-local bridge → Recording
  │    → timestamp / state / getThreadLocalBuffer / emitSpan
  ├─ Java 业务 span façade → Span
  │    → Recording.* + native SpanEvent
  └─ JDK JFR API 代理 → JfrSync
       → master recording / listener / stopProfiler
```

*关键设计（斜体）：* *helper 的意义不是“再封一层 Java 业务逻辑”，而是为 native 机制提供 JVM 愿意接受的最小 Java 触点：一个可被字节码引用的收件箱、一个可信的注册上下文、一个与 native 时钟对齐的桥，或一个能代 native 出面调用 JDK API 的代理。*[模式: 最小 Java 收件箱 + trusted 代理 + 时钟桥]

先记住本文的总领：这些 helper 之所以存在，不是因为 native 不够强，而是因为 native 想穿过 JVM 边界时，总得以 Java 能接受的最小形状出现。后面每个 helper 看起来都很薄，但正是这些薄层把整条 native 主线在 Java 世界里接上了。

## 第一层：为什么 `Instrument` 必须存在，而且改写器宁可织入普通 `invokestatic` 也不直接暴露 native 细节

最容易理解的一类 helper 是 `Instrument`，因为它正好站在“字节码被改写后，下一步到底会执行什么”这个断点上。

`helper/one/profiler/Instrument.java` 本身非常薄，只有三个公开入口：`recordEntry()`、`recordExit(long startTimeNs, long minLatency)` 和 `recordExit0(long startTimeNs)`（`src/helper/one/profiler/Instrument.java:8-32`）。如果只看这个文件，你很容易觉得它只是个无聊的胶水壳。但它的重要性根本不在于自己的代码量，而在于 BytecodeRewriter 最终织入到目标方法里的，就是对这些普通 Java 静态方法的调用。

`instrument.cpp` 里的常量池构建、`rewriteCodeForLatency` 和 `ClassFileLoadHook`，都明确指向 `one/profiler/Instrument`、`recordEntry`、`recordExit`、`recordExit0`（例如 `src/instrument.cpp:975-989、1236-1255`）。也就是说，被改写过的类在 JVM 眼里，仍然只是在执行完全标准的 Java 调用：`invokestatic one/profiler/Instrument.recordEntry()`，跑原始方法体，再 `invokestatic one/profiler/Instrument.recordExit(...)`。

```text
原始方法
  → 字节码改写
    → invokestatic one/profiler/Instrument.recordEntry()
    → ... 原始方法体 ...
    → invokestatic one/profiler/Instrument.recordExit(...)
```

这里必须把一个失败方案讲透：为什么不干脆让改写器“直接碰 native”，例如在字节码里埋某个 native 地址、某种特殊跳板，或者让改写后的类直接暴露 profiler 内核细节？因为那会立刻把被改写类拖到 JVM 并不喜欢的边界上。类验证、常量池解析、方法调用模型，JVM 都更愿意看到“它在调一个普通静态 Java 方法”，而不是“这里藏着一个 native 特技”。

换句话说，改写器之所以宁可多绕一层 `Instrument`，并不是因为技术上绕不过 native，而是因为这一层能把所有改写结果都留在 JVM 最熟悉的 Java 调用语义里。native 仍然在背后，但不直接裸露给被改写类。

### 为什么阈值判断先放在 Java helper，而不是所有 exit 都先进 native 再说

`Instrument` 的第二个关键点，在于它不是纯转发壳。`recordEntry()` 和 `recordExit0()` 是 native 方法，但 `recordExit(long startTimeNs, long minLatency)` 不是：它会先用 `System.nanoTime()` 做一次阈值判断，只有 `System.nanoTime() - startTimeNs >= minLatency` 时，才真正调用 `recordExit0(startTimeNs)`（`src/helper/one/profiler/Instrument.java:16-31`）。

这背后又对应一个很典型的失败方案：所有 exit 都先回到 native，再由 native 去判断 latency 是否达标。这样看上去逻辑更集中，但代价也很明显：大量本来很短、根本不值得记录的方法调用，也要先跨一次 Java→native 边界，最后再被 native 否掉。

当前实现的选择更克制：先在 Java helper 做一次极廉价的时间比较，高频短方法因此可以在不进入 native 的情况下被快速跳过。`recordExit(long startTimeNs)` 这个无阈值重载则仍然保留，源码注释还特别说明保留它是为了让 latency=0 时拥有与标准路径相同的附加 frame 数（`src/helper/one/profiler/Instrument.java:24-29`）。

native 侧 `Instrument::initialize()` 再通过 `DefineClass` + `RegisterNatives` 把 `recordEntry` 和 `recordExit0` 绑定到 C++ 实现；后者真正去记录 `INSTRUMENTED_METHOD` 样本和 `METHOD_TRACE` 事件（`src/instrument.cpp:1061-1079、1259-1280`）。

所以这条链真正的分工是：

- 改写器负责把“该调用哪个 Java helper”织进字节码；
- Java `Instrument` 负责最小阈值判断和 JVM 可见的方法签名；
- native `Instrument` 实现负责真正记样本和方法事件。

*关键设计（斜体）：* *`Instrument` 的价值不在于拥有复杂逻辑，而在于它把“字节码里该出现什么”和“什么时候值得真的进 native”这两件事都压成了 JVM 最容易接受的最小形状：普通 `invokestatic` 和一次便宜的 Java 阈值过滤。*[模式: 字节码收件人 + Java 预过滤 + native 记录]

## 第二层：为什么 `LockTracer` 看起来只是在设一个入口，却真正解决的是 trusted `RegisterNatives` 上下文问题

如果说 `Instrument` 主要回答“插桩后的字节码该调谁”，那 `LockTracer` 则回答另一类更隐蔽的问题：native 想改掉某个已有的 Java/JNI 注册链时，谁来提供 JVM 愿意接受的 trusted 上下文？

`helper/one/profiler/LockTracer.java` 乍看非常单薄：它只有一个静态入口 `setEntry(long entry)`，内部调用 private native `setEntry0(long entry)`；类注释甚至直接把它定义成 “Helper class to call JNI RegisterNatives in a trusted context”（`src/helper/one/profiler/LockTracer.java:8-23`）。

如果只按功能表面去看，这条链很容易被误读成“helper 调 native 设置一个函数指针”。但它真正要解决的根本不是“业务锁逻辑怎么写”，而是“`RegisterNatives` 在什么类加载器/调用栈上下文里出现，JVM 才愿意安静接受”。

`lockTracer.cpp` 需要 hook `Unsafe.registerNatives()`，先拿到原始 `Unsafe.park` 的 native 地址，再把 `park` 重定向到自己的 hook（`src/lockTracer.cpp:82-151`）。源码和 helper 注释都明确提到一个特定现实约束：为规避 JDK-8238460 相关 warning，调用链里至少需要构造两个属于 bootstrap class loader 的 frame（`src/helper/one/profiler/LockTracer.java:16-20`）。

这正是 `LockTracer` helper 存在的真正理由。它不是一个“锁采样 API façade”，而是一个 bootstrap 上下文里的可信 Java 代理。native 借它出面，才能把 `RegisterNatives` 放在 JVM 规则允许、也不至于告警的那条语境里。

### 为什么这条链不能简单写成“native 自己把 `Unsafe.park` 指过去就完了”

这正是必须打掉的失败方案。功能上看，最终目标确实只是把 `Unsafe.park` 的 native 入口换掉。但如果把这件事简化成“设个指针”，就会忽略 JVM 真正在乎的不是结果，而是“这个结果是在什么规则下完成的”。

当前链路是：

1. native `LockTracer::initialize()` 找到 `Unsafe`、拦截 `RegisterNatives`、解析原始 `park` 地址；
2. 通过 `DefineClass` 或 `FindClass` 得到 helper `LockTracer`；
3. 给 helper 的 `setEntry0` 注册 native 方法，并缓存 Java 静态方法 `setEntry`；
4. 再调用 Java `LockTracer.setEntry(entry)`；
5. Java helper 转回 native `setEntry0(entry)`；
6. 最终在这个可信上下文里执行 `RegisterNatives(_Unsafe, &park, 1)`（`src/lockTracer.cpp:77-150`）。

```text
native initialize()
  → 定义/找到 helper LockTracer
  → RegisterNatives(helper.setEntry0)
  → 调 Java helper.setEntry(entry)
    → native setEntry0(entry)
      → RegisterNatives(Unsafe.park = entry)
```

所以 `LockTracer` 看起来只是在“中转一个 entry”，实际上它真正中转的是“谁可以在 JVM 愿意接受的上下文里发起这次 `RegisterNatives`”。功能是换入口，helper 解决的是身份问题，而不是锁业务逻辑问题。

*关键设计（斜体）：* *`LockTracer` 不是业务锁逻辑的 Java façade，而是 trusted `RegisterNatives` 的身份桥：它的价值不在于封装功能，而在于让 native 对 `Unsafe.park` 的重定向发生在 JVM 能接受的 loader / stack context 里。*[模式: trusted JNI 代理 + bootstrap 上下文桥]

## 第三层：为什么 `Recording` 不是主 profiler API，而只是 state / clock / thread-local bridge

到了 `Recording` 和 `Span` 这一组，误解会更重。因为它们既在 `one.profiler` 包里，又暴露 Java 方法，还和 JFR/业务 span 紧密相关，很容易让人以为“这是不是 Java 世界里另一套更高级的 profiler API”。

但 `Recording` 的行为其实从一开始就在否认这件事。它的静态初始化会尝试 `registerNatives()`；如果此时 async-profiler native 还没装载好，它不会像 `AsyncProfiler.getInstance()` 那样继续找库，而是直接吞掉 `UnsatisfiedLinkError`，把状态置为 `UNAVAILABLE`（`src/api/one/profiler/Recording.java:32-38`）。

这一个细节已经足够说明：`Recording` 不是主入口。主入口要负责把库真正激活起来，而 `Recording` 只是在说：“如果 native 桥已经准备好，我就接；如果还没准备好，我先承认自己不可用。”

所以它的角色更像一座桥，而不是一个 façade。它提供的是：

- `state()`：当前 recording 状态；
- `clockFrequency()`：当前 profiler 时钟频率；
- `timestamp()`：与 profiler/JFR 同一时钟下的时间戳；
- `getThreadLocalBuffer()`：native TLD 的 `DirectByteBuffer` 视图；
- `emitSpan()`：把 span 事件送回 native 录制流（`src/api/one/profiler/Recording.java:17-99`）。

### 为什么 `timestamp()` 和 `clockFrequency()` 比看起来更重要

`timestamp()` 默认通过 `System.nanoTime()` 提供时间戳；如果 native 侧启用了 TSC，`updateClock()` 会把内部 `MethodHandle` 切换到 `jdk.jfr.internal.JVM.counterTime`，并同步 `clockFrequency`（`src/api/one/profiler/Recording.java:75-92`、`src/javaApi.cpp:232-301`）。

这意味着 `Recording` 真正在做的是时钟桥：它不是再发明一种业务时间 API，而是确保 Java 侧如果要写 span、算区间、判断事件是否落在某个 profiling session 里，用的是和 native profiler / JFR writer 同一条时间线。

没有这层桥，Java 业务代码当然也能自己调 `System.nanoTime()`，但那并不能保证它和 native 当前 recording 时钟总是严格可比。当前实现明确要把这件事桥起来，而不是让调用方自己去猜。

### `DirectByteBuffer` TLD 视图为什么重要

`asprof_thread_local_data` 目前只定义了一个字段：`sample_counter`，表示该线程最近一次 profiling sample 的内部时钟时间戳（`src/asprof.h:41-65`）。`ThreadLocalData::getIfPresent()` 允许在 native 侧安全地取到这块 thread-local data；`Recording.getThreadLocalBuffer()` 则把它直接暴露成 `DirectByteBuffer`（`src/threadLocalData.h:12-40`、`src/threadLocalData.cpp:19-40`、`src/javaApi.cpp:154-158`）。

这一步如果只写成“把 TLD 暴露给 Java”，很容易显得像低级实现细节。真正重要的是，它为后面的 `Span` 提供了一条超薄的、零对象建模的桥：Java 不必等 native 再回调，也不必维护另一套 per-thread 计数结构，只要读取当前线程这块直映射过来的内存，就能知道“最近一次 profiling sample 发生在什么时候”。

所以 `Recording` 不是 profiler façade，而是时钟桥 + 状态桥 + thread-local 事实桥。

## 第四层：为什么 `Span` 不能每次都无脑进 native，而要先利用 thread-local sample 事实做 sampled-only 快速路径

真正把 `Recording` 这座桥用起来的，是 `Span`。如果说 `Recording` 提供的是“Java 怎样看到 profiler 的状态、时钟和线程局部事实”，那么 `Span` 提供的就是“Java 业务代码怎样利用这些事实，只在值得的时候把区间并进同一条录制时间线”。

`Span.start()` 的逻辑已经说明了一切：只有在 `Recording.state == RUNNING` 时，它才返回 `Recording.timestamp()`；并且如果当前线程不是 virtual thread，还会强制初始化 thread-local buffer（`src/api/one/profiler/Span.java:54-68`）。这说明 `Span` 并不是一个独立于 profiler session 的通用埋点系统，它从一开始就把自己绑定在“当前 recording 是否运行、当前线程是否已有样本桥”这个前提上。

### `endIfProfiled()` 真正解决的是什么问题

`Span` 里最关键的不是 `end()`，而是 `endIfProfiled()` / `emitIfProfiled()`。前者只有在 virtual thread 或 `hasProfileSamples(startTime)` 成立时，才真的调用 `Recording.emitSpan(...)`；否则就什么都不发（`src/api/one/profiler/Span.java:90-123`）。

`hasProfileSamples(startTime)` 又只是一个极简单的判断：比较 thread-local `sample_counter >= startTime`（`src/api/one/profiler/Span.java:47-49`）。也就是说，`Span` 在问的不是“这个业务操作重不重要”，而是“这个 span 打开期间，这个线程上到底有没有 profiling sample 落进来”。

这里必须把一个失败方案讲透：为什么不干脆每次 `end()` / `endIfProfiled()` 都直接进 native，让 native 自己判断要不要记？因为那会把“本来根本没和 profile 发生交集的高频 span”也一股脑地送过 JNI 边界，再在 native 里否掉。对频繁出现、但大多数时候没有包住 sample 的 span 来说，这是很不划算的成本模型。

当前实现的思路更克制：先借助 profiler 已经维护好的 thread-local `sample_counter`，在 Java 世界用一次极便宜的内存读取判断“有没有交集”；只有真有交集，才值得让这个 span 进入 native 事件流。也就是说，sampled-only 路径存在的意义，不是做业务筛选，而是避免为和 profile 没发生关系的 span 付 JNI 与录制成本。

### 测试其实已经在验证这条设计

`test/test/span/SpanTests.java:56` 到 `test/test/span/SpanTests.java:65` 明确验证了这件事：无条件 span 总会被记录，而 `busyOptional` 这种包住 CPU 忙区间的 span 会保留下来，`idleOptional` 这种大多包住睡眠区间、没有采样交集的 span 则大幅减少。`SpanTests.java:77` 到 `SpanTests.java:81` 还进一步验证了 busyRequest 的时间区间内确实包含 CPU sample。换句话说，测试不是在验证“span API 能用”，而是在验证“sampled-only 快速路径确实把 span 录制和 profiling sample 交集绑定在一起”。

`test/test/span/SpanTests.java:99` 到 `SpanTests.java:102` 还说明了另一个关键边界：只有 session 活着期间发出的 span 才会真正落进 JFR，before/after session 的 span 都不会被记下来。`test/test/span/SpanTests.java:105` 到 `SpanTests.java:120` 则进一步证明，即使应用先开始使用 `Span` API，之后再 attach async-profiler，helper 这条桥仍然能把 attach 后的 span 接住。

### virtual thread 特判为什么也必须点明

`Span` 对 virtual thread 有显式特判：如果当前线程是 virtual thread，就不依赖 thread-local sample buffer，而是直接允许 `endIfProfiled()` / `emitIfProfiled()` 发送（`src/api/one/profiler/Span.java:24-36、90-123`）。这说明当前 sampled-only 判断并不是“一条路径适用于所有线程模型”。文章如果不把这条边界点出来，读者就会误以为 `sample_counter` 这套判断在所有线程上都完全等价。

所以这里真正成立的结论是：`Span` 不是通用埋点系统，而是借用 profiler 时钟和 thread-local 样本事实，只在“真的和 profile 发生交集”时才值得进入同一条 recording 时间线。

*关键设计（斜体）：* *`Span` 的 sampled-only 路径不是业务语义过滤，而是一种成本过滤：先借 thread-local sample 事实在 Java 世界便宜判断“这段区间值不值得进入 native/JFR”，只有真的与 profile 相交时才付记录成本。*[模式: clock-aligned span bridge + sampled-only fast path]

## 第五层：为什么 `JfrSync` 看似是特例，其实正好暴露了 helper 的另一种共同角色——JDK API 代理

`JfrSync.java` 在 JFR 那篇已经讲过，这里不再重走其 start/stop 细节，而是要把它放回 helper 的全景里看。它不是普通 Java API 用户会主动 import 的类，而是一个被嵌入到 native 二进制里、只在 `--jfrsync` 路径下由 native `DefineClass` 加载出来的 Java 代理（`src/helper/one/profiler/JfrSync.java:21-143`、`src/flightRecorder.cpp:1404-1465`）。

它做的事情有两类：

- 替 native 与 JDK `jdk.jfr.Recording` API 交互，创建/停止 master recording；
- 作为 `FlightRecorderListener`，在 master recording 进入 `STOPPED` 时回调 native `stopProfiler()`。

如果只从功能表面看，它和 `Instrument`、`LockTracer`、`Recording`/`Span` 好像很不一样：前几者主要围绕字节码、JNI hook 或 thread-local，`JfrSync` 则是在替 native 和 JDK 自己的 Java API 对话。但这恰恰说明 helper 的共同架构角色更普遍：当 native 想触碰某个“必须以 Java 形状出现”的世界时，它并不把主逻辑搬到 Java，而是只在 Java 侧放一个最小合法代理，由这个代理替 native 与那套 Java 语义交互。

所以 `JfrSync` 不是 helper 体系里的例外，反而是对“helper = Java 世界最小合法代理”这一定义的另一种验证。

## 第六层：把这些 helper 放在一起，才能看出整卷真正闭环在哪里

如果分别看 `Instrument`、`LockTracer`、`Recording`、`Span`、`JfrSync`，它们都很薄，甚至都像“无聊胶水层”。也正因如此，单独阅读它们时很容易低估其价值。但一旦把它们摆在同一张图里，结构就非常清楚了：

```text
BytecodeRewriter
  → one.profiler.Instrument.recordEntry/recordExit
    → native Instrument::recordEntry/recordExit0
      → profiler sample / method trace

LockTracer native hook
  → one.profiler.LockTracer.setEntry
    → native setEntry0
      → RegisterNatives(Unsafe.park)

Java business code
  → Span.start/end/emit
    → Recording.timestamp / getThreadLocalBuffer / emitSpan
      → native SpanEvent
        → profiler event stream / JFR

--jfrsync
  → embedded JfrSync
    → JDK Recording API / listener
      → stopProfiler callback
```

这些链路虽然看起来分散，实际上共享一个非常稳定的结构：native 世界仍然想保留主逻辑，但它在穿越 JVM 边界时，总得以一种 JVM 愿意接受的形状出现。于是 async-profiler 总是倾向于创造一个“足够薄、但语义刚好够用”的 Java 收件箱，而不是把主逻辑整个搬到 Java。

这也是为什么 helper 的价值不能按“文件行数”来衡量。它们真正补上的空缺不是业务逻辑，而是边界逻辑：

- 字节码里要有一个稳定可调用的方法符号；
- `RegisterNatives` 要发生在合适的 loader / stack context；
- 业务 span 要能和 profiler/JFR 共用同一时钟与样本事实；
- 某些 JDK Java API 必须由 Java 代理出面交互。

如果没有这些 helper，整卷前面讲过的 attach、采样、JFR、OTLP、Java API 都仍然存在，但它们在 JVM 边界上会留下一个个“native 已经会了，可 JVM 里没人接”的断口。helper 真正做的，就是把这些断口一一补成闭环。

*关键设计（斜体）：* *helper 的价值不在于业务逻辑厚度，而在于它让 native-first 架构以 JVM 愿意接受的最小 Java 形状出现：普通静态调用、普通类加载、普通 JDK API 交互、普通 DirectByteBuffer 视图。*[模式: native-first architecture + JVM-friendly Java façade]

## 常见误解与实现边界

**误解一：`Instrument` 是 Java 层性能分析器。** 当前它只是插桩后的 Java 收件人，真正记样本和方法事件的仍是 native `Instrument` 实现。

**误解二：`LockTracer` helper 只是为了设一个入口指针。** 它更关键的职责是提供 trusted `RegisterNatives` 上下文，让 `Unsafe.park` 的改写发生在 JVM 愿意接受的 loader / stack context 里。

**误解三：`Recording`/`Span` 是另一套 Java profiler API。** `Recording` 更偏 state/clock/thread-local bridge，`Span` 更偏业务区间与 profiler 时间线的桥；它们都不是主 profiler façade。

**误解四：`Recording.getThreadLocalBuffer()` 返回的是稳定 Java 数据结构。** 当前它暴露的是 native `asprof_thread_local_data` 的 `DirectByteBuffer` 视图，字段布局随 native API 演进可能变化。

**误解五：`Span.endIfProfiled()` 判断的是业务逻辑重要性。** 它当前只看该线程在 span 打开期间是否出现过 profiling sample；这是 sample 交集过滤，不是业务语义过滤。

**误解六：virtual thread 与 platform thread 完全共用同一条 sampled-only 判断。** 当前 `Span` 对 virtual thread 有特判：virtual thread 直接允许发送，不依赖 thread-local sample buffer。

**误解七：`JfrSync` 只是一个特殊小工具，不体现 helper 的共同模式。** 它同样是在 native 穿越 JVM 边界时，提供一个最小 Java 代理去和 JDK API 合法交互。

## 收网：helper / closure 真正补上的，是 native 穿越 JVM 边界后的“收件箱空缺”

如果把整条链压成一句话，helper/closure 这些类真正做的，不是“再造一层 Java 业务逻辑”，而是让 native 能力穿过 JVM 边界后，总能在 Java 世界找到一个刚好够用的合法落点：插桩有收件人，trusted JNI 有代理，JFR 有 Java API 代理，业务 span 有和 profiler 同步的状态/时钟桥。

```text
native 需要一个 Java 落点
  ├─ 插桩收件箱 → Instrument
  ├─ trusted RegisterNatives 代理 → LockTracer
  ├─ JDK JFR API 代理 → JfrSync
  └─ 时钟 / 状态 / 业务 span 桥 → Recording + Span
```

到这里，主线只发生了三件事。

第一，字节码改写和 hook 并不直接把 native 细节裸露给 JVM，而是尽量借助最小 Java helper 落地。

第二，`Recording` / `Span` 让 Java 业务代码可以和 profiler/JFR 共享同一时钟与事件流，同时只在值得时才付 span 录制成本。

第三，helper 让整卷前面建立起来的 attach、参数、采样、JVM 集成、JFR/OTLP/FlameGraph 输出、Java API 入口，最终在 JVM 边界处形成一个完整闭环。

*关键设计（斜体）：* *当 native 能力必须穿过 JVM 边界时，async-profiler 始终倾向于创造一个“足够薄、但语义刚好够用”的 Java 收件箱或代理，而不是把主逻辑搬到 Java。*[模式: 最小 helper surface + native logic retention]

**本篇的一句话困惑**：native 侧把调用织进去、把事件抛出来之后，Java 世界到底是谁来接？

**本篇的一句话顿悟**：`Instrument`、`LockTracer`、`Recording`、`Span`、`JfrSync` 这些 helper 共同构成 async-profiler 在 Java 世界的最小触点集合：有的充当收件箱，有的提供 trusted 上下文，有的负责时钟桥或 JDK API 代理，但它们都不拥有 profiler 主逻辑。

AP-6 至此收束：前一篇解释“Java API 怎么把 `.so` 变成对象入口”，本篇解释“native 能力穿过 JVM 边界后由谁接住”。整卷从 attach、参数、采样、JVM 集成、栈与符号，到三种输出和 Java/helper 入口，已经形成完整闭环。

[跨层标注：JVMTI/BytecodeRewriter；JNI RegisterNatives；bootstrap class loader 上下文；DirectByteBuffer/TLS；TSC/JFR clock bridge；业务 span 与 profiler event stream；embedded Java helper class]
