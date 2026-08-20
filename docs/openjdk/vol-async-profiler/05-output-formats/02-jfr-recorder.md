# 02. 不依赖 JDK API，怎样写出 JFR？——Recording、事件缓冲与 JfrSync

> **前置依赖**：[AP-2 —— 采样主路径](../02-sampling-core/01-sampling-core.md)、[AP-4 —— 调用栈存储](../04-stack-symbols/04-storage-alloc.md)、[AP-5-01 —— FlameGraph 输出](./01-flamegraph-html.md)
> → **后续**：AP-5 的 OTLP converter（下一篇继续写 `05-output-formats/03-otlp-converter.md`）
>
> 场景：采样事件要被 JMC/JFR reader 读取，但信号/事件路径不能依赖 Java `jdk.jfr` 对象和完整的 JFR runtime writer。
>
> 本篇基于当前 async-profiler 源码，重点讨论 native `FlightRecorder` 的 JFR 写入实现，以及可选的 `--jfrsync` 协同路径。它不是对 JDK Flight Recorder 内部实现的复刻说明，也不把当前 metadata/schema 写法外推为所有 JDK 版本的规范保证；结论以当前源码中 `flightRecorder.cpp`、`jfrMetadata.cpp` 和嵌入的 `JfrSync.java` 为准。

## 先把真正的困惑摆出来：为什么 JFR 不能像日志那样“有事件就写一行”

上一章的 flamegraph，最终面对的是浏览器。native 侧只要把调用路径整理成 Trie，再压成常量池和 `f/u/n` 指令，浏览器就能把它画成 Canvas 或 tree view。但 JFR 完全不是这个消费模型。JFR 的消费者是 JMC、`jfr` 工具、`RecordingFile` 和各种 reader，它们期待的不是“一串事件字节”，而是一种有 schema、有 chunk、有 constant pool、有时间基准和对象 ID 关系的二进制协议。

这意味着，光有“事件发生了什么”远远不够。reader 还必须知道：某个事件类型的字段顺序是什么，事件里写的线程 ID 应该去哪个池里解释，`call_trace_id` 对应哪一串帧，帧里的 method ID 又该怎样继续关联到 class、package 和 symbol。如果这些关系缺任何一层，文件里的数字就只是一串没人认识的整数。

async-profiler 在这里还背着一个更硬的约束：很多事件来自采样热路径，甚至可能来自信号上下文。这个路径最怕被拖进 Java 对象分配、JNI 往返、JFR runtime 内部锁和大对象拼装。于是最直觉、也最容易想到的方案——“每次采样都直接调用 `jdk.jfr` API，让 JDK 自己负责建事件对象和写文件”——反而首先出局。因为它会把最重、最不确定的一批工作直接带进最热的路径里。

第二个朴素方案，是每条事件发生时，就把完整 stack trace、method、class、thread 等对象关系全部写进文件。这样看起来最完整，也最像“当场落账”。但它同样会把解析方法、补类名、构造字符串池、维护对象去重这些成本，重新拉回事件发生那一刻。换句话说，事件还没来得及从热路径退出，就已经被迫承担了 reader 端才真正需要的全部关系恢复。

第三个误解，是把 JFR 想成一种“永远只先写内存，最后统一落盘”的异步模型。这个说法对理解吞吐很有诱惑力，因为它听起来像是对热路径最友好的方案。但当前实现并不是这样：常态确实是先写 buffer，可一旦 buffer 满了，当前路径就允许直接 `write()`。如果把它笼统写成“只写内存”，后面关于阻塞边界和 chunk 收口的理解就会错位。

第四个误解，则是把 `--jfrsync` 想成“native 事件直接注入正在运行的 JDK Recording”。这个直觉很自然，因为用户最终只看到一个 `.jfr` 文件。但当前实现真正干的事情其实更保守：JDK 自己写一份 master recording，async-profiler 自己写一份 native recording，最后再把后者 append 到前者。也就是说，这不是双 writer 交错写同一 chunk，而是两个 recording 在文件层协同。

所以本篇真正要回答的问题不是“JFR 怎么写字节”，而是：async-profiler 到底怎样把“事件发生时必须立即写下的最小事实”，和“reader 最终必须看到的完整对象关系”拆开处理。

它的真实做法可以先压成下面这张总图：

```text
Profiler::recordSample()
  → CallTraceStorage.put() / call_trace_id
    → FlightRecorder::recordEvent(lock_index, tid, trace_id, event_type, event)
      → RecordingBuffer[lock_index]
        → record* writer：event bytes
          → flushIfNeeded() / write()

chunk finish / switch
  → flush all buffers
    → writeCpool()
      → threads / stack traces / methods / classes / packages / symbols / strings
        → patch cpool size
          → patch chunk header
            → JFR reader / JMC
```

*关键设计（斜体）：* *JFR 写入的核心不是“把事件记下来”这么简单，而是把“热路径最小事实”与“reader 最终解释关系”拆成两个阶段：前者即时编码进 buffer，后者在 chunk 收口时通过 metadata、constant pool 和 header patch 补齐。*[模式: 手写协议编码 + 延迟对象池物化 + chunk 化输出]

先记住这句总领：对 async-profiler 来说，JFR 不是一个 API 调用，而是一套必须自己兑现的二进制契约。后面所有实现细节，都是围绕“怎样分摊这份契约的成本”展开的。

## 第一层：为什么 `Recording` 一开始要先搭一个 chunk 骨架，而不是等事件来了再说

真正承担格式状态的，不是 `FlightRecorder` 这个门面，而是 `flightRecorder.cpp` 里的 `Recording`。`FlightRecorder` 本身只握着一个 `Recording*`，真正和 chunk 生命周期、缓冲区、对象池、写入目标打交道的都是后者。

从字段就能看出它不是一个简单的 `FILE*` 包装器。它同时持有 `_buf[CONCURRENCY_LEVEL]` 这组并发槽缓冲、最终输出文件 `_fd`、可选的内存暂存文件 `_memfd`、当前 chunk 起点 `_chunk_start`、时间基准 `_start_time/_start_ticks`、多 chunk 对象 ID 偏移 `_base_id`、字节与时间阈值 `_chunk_size/_chunk_time`，以及后面要在收口阶段补齐的 `_method_map`、`_thread_set`、`_string_pool`（`src/flightRecorder.cpp:237-273`）。

这组字段本身已经在说明一个事实：JFR 录制不是“拿到事件就往文件追加”，而是要先建立一个随时间推进的 chunk 上下文。没有这个上下文，后面事件写出来的 `startTime`、`call_trace_id`、`thread id` 甚至都没有稳定的解释归属。

构造函数正是在做这件事。它先记录当前微秒时间和 tick，规范化 chunk 大小与 chunk 时间的最小值，然后依次写 header、metadata、recording info、settings，以及可选的系统信息、JVM 信息、系统属性和 native library 信息（`src/flightRecorder.cpp:280-312`）。这些内容先写进 `_buf`，随后一次 `flush(_buf)`，把当前 chunk 的前置区域落到文件里。

```text
chunk 起点
  ├─ header：magic、版本、offset、时间基准、TSC 信息
  ├─ metadata：类型、字段、annotation 和字符串索引
  ├─ ActiveRecording：录制身份与生命周期
  ├─ ActiveSetting：async-profiler 参数快照
  ├─ 可选系统/JVM/property/native library 信息
  └─ 后续 profiling events + constant pool
```

这里最重要的不是“前面都写了什么条目”，而是为什么要先写这些东西。因为 reader 看到任何 profiling event 之前，必须先知道：这是哪种格式版本，这个 chunk 从什么时候开始，后续事件类型在哪套 schema 里解释，录制自身带了哪些 settings，甚至某些 built-in 类型和环境信息应该如何映射。换句话说，事件不是文件的起点，chunk 骨架才是文件的起点。

如果反过来做——先把 profiling event 盲写进去，等最后再补 metadata/header——那么任意中途读取、任意工具扫描、甚至同一个 chunk 内部的自描述能力都会变弱。async-profiler 这里的选择，其实就是先给 reader 搭好“读法”，再开始往里面填“被读的内容”。

### header 为什么一开始只能写占位值

`writeHeader()` 写入了 `FLR\0` magic、major/minor 版本、chunk size、constant pool offset、metadata offset、start time、duration、start ticks、ticks per sec 和 features（`src/flightRecorder.cpp:582-596`）。但这里有个非常关键的矛盾：chunk 刚开始时，最终大小、constant pool 起点、duration 这些值还根本不知道。

所以当前实现没有试图“先算完再写”，而是明确接受一个事实：JFR chunk 的一部分头信息只有在 chunk 结束时才成立。于是开始时先写固定布局的占位值，等 `finishChunk()` 真正收口时，再用 `pwrite()` 回补 chunk size、cpool offset、duration 和校正后的 TSC frequency（`src/flightRecorder.cpp:347-399`）。

这背后对应的失败方案其实也很典型：为了在 header 里一开始就拿到所有正确值，最直觉的办法是先把所有事件攒进一个大对象，等最后什么都知道了再统一输出。这样看似整洁，实则把整个录制过程重新变成“大对象暂存 + 一次性吐出”的模型，不仅内存成本更高，也把 flush、chunk switch 和持续输出的好处一并抹掉了。

async-profiler 的选择更接近“流式写协议”的常见做法：承认 header 里有一部分字段天然属于后验信息，于是保留固定布局，最后再 patch。它不为了“起手就完整”而放弃流式写出能力。

到这里先记住一句话：`Recording` 不是在等事件，它是在先建立 reader 能理解事件的 chunk 骨架。

## 第二层：为什么 metadata 不是注释，而是 reader 的类型系统

如果说 header 搭的是 chunk 的物理骨架，那么 metadata 搭的就是整份 JFR 的语义骨架。没有 metadata，reader 看到的每条 event bytes 都只是“若干整数和字节”；只有 metadata 先定义了类型、字段、annotation 和 constant pool 关系，这些数字才变成“某种 JFR 事件”。

`jfrMetadata.h` 先定义了整套 `JfrType`：基础标量类型、对象池类型、事件类型、annotation 类型全部在这里有自己的 ID（`src/jfrMetadata.h:16-87`）。再往下，`field()` 还会根据 flags 决定字段是不是 constant pool 引用、是不是数组、是不是时间戳、duration、bytes、address、percentage、contextual 等（`src/jfrMetadata.h:132-220`）。

真正把这些类型关系铺成一棵 schema 树的，是 `jfrMetadata.cpp` 里的 `JfrMetadata::_root`。这里会声明：

- `jdk.types.StackTrace` 有 `truncated` 和 `frames`；
- `jdk.types.StackFrame` 有 `method`、`lineNumber`、`bytecodeIndex` 和 `type`；
- `jdk.ExecutionSample` 有 `startTime`、`sampledThread`、`stackTrace` 和 `state`；
- `profiler.WallClockSample`、`profiler.Malloc`、`profiler.NativeLock`、`profiler.ProcessSample` 等，则是 async-profiler 自己扩出来的事件世界（`src/jfrMetadata.cpp:13-333`）。

也就是说，metadata 不是“顺便写一份说明书给人看”，而是在给 reader 提供一份强制性的解释规则：某个 type id 代表什么类，这个类有哪些字段，这些字段是值本身还是池引用，是 tick 时间还是纳秒 duration，是字节数还是地址。没有这层规则，后面的事件 writer 根本无从定义“自己写出来的顺序到底算什么”。

`Recording::writeMetadata()` 正是在做这件事：先写 metadata event 的 type、时间基准和特殊 metadata id，再写字符串表，最后递归写整棵 `Element` 树（`src/flightRecorder.cpp:598-629`）。这里甚至连 metadata event 自己的长度也得先占位，写完后再 patch，因为 schema 树本身的序列化长度同样只有结束后才知道。

```text
JfrMetadata::_root
  → Element(name, attributes, children)
    → writeMetadata()
      → string table
      → recursive writeElement()
        → JFR reader 可解释的类型描述
```

### 为什么事件 writer 必须严格服从 metadata 顺序

这个约束后面会反复用到。比如 metadata 把 `jdk.ExecutionSample` 定义为 `startTime → sampledThread → stackTrace → state`，那么 `recordExecutionSample()` 就必须按对应顺序写 event type、start time、tid、call trace id、thread state（`src/jfrMetadata.cpp:89-94`、`src/flightRecorder.cpp:1078-1086`）。metadata 把 `jdk.ObjectAllocationInNewTLAB` 定义成 `startTime → eventThread → stackTrace → objectClass → allocationSize → tlabSize`，writer 也就必须按这个顺序去落 `_class_id`、`_instance_size` 和 `_total_size`（`src/jfrMetadata.cpp:96-103`、`src/flightRecorder.cpp:1111-1121`）。

因此 metadata 和 event bytes 不是两份互相独立的材料，而是同一份格式契约的正反两面：metadata 规定语义，writer 兑现语义。把 metadata 写成“可选说明信息”，会直接削弱读者对整篇主线的理解。

*关键设计（斜体）：* *格式兼容首先是 schema 兼容：writer 写出的数字只有在 metadata 事先把它们解释成正确字段时，JFR reader 才能把它们读成事件。*[模式: 类型契约 + 递归序列化]

到这里先记住：JFR 之所以能“被读懂”，并不是因为写出了事件字节，而是因为先写出了一套 reader 用来读懂这些字节的类型系统。

## 第三层：为什么 `lock_index` 会一路贯穿到 JFR，而不是再起一套全局串行 writer

讲到这里，真正的热路径才刚开始。`Profiler::recordSample()` 在完成采样和 `CallTraceStorage.put()` 后，会把相同的 `lock_index` 继续传给 `_jfr.recordEvent()`；`recordExternalSample()` 也走同一条入口（`src/profiler.cpp:488-492`、`src/profiler.cpp:510-521`）。

这个细节看起来像只是“顺手沿用一个参数”，其实它非常关键，因为它说明 JFR writer 没有把自己重新包装成另一套独立的全局串行模型。AP-2 里已经建立过一个按并发槽分流的采样主路径，这里 JFR 选择继续借用那条主线，而不是在最后一步突然把所有事件重新挤进一个共享大锁或一个统一队列。

`FlightRecorder::recordEvent()` 先确认 `_rec` 存在；对于 profiling event，还会更新当前线程的 `sample_counter`，然后直接通过 `_rec->buffer(lock_index)` 取出对应的 `RecordingBuffer`（`src/flightRecorder.cpp:1473-1485`）。接下来再按 `EventType` 分派到不同的 writer：

```text
PERF / EXECUTION / INSTRUMENTED_METHOD → recordExecutionSample
METHOD_TRACE                           → recordMethodTrace
WALL_CLOCK_SAMPLE                      → recordWallClockSample
MALLOC_SAMPLE                          → recordMallocSample
ALLOC / ALLOC_OUTSIDE_TLAB             → allocation writers
LOCK / PARK / NATIVE_LOCK              → lock writers
LIVE_OBJECT / WINDOW / SPAN / USER     → 对应事件 writer
```

这里的 writer 做的事情都很克制：先留一段长度占位，然后按 metadata 约定顺序写 event type、TSC 时间戳、线程 ID、call trace ID 和事件特有字段，最后回填本条记录长度（`src/flightRecorder.cpp:1078-1299`）。它们不会在这里去查完整方法名、不会在这里构造线程对象、不会在这里把整个 stack trace 展开成 frame 列表。热路径只负责写“当前事件不可不写的最小事实”。

这一步本质上是在主动拒绝另一个诱人的方案：既然 reader 迟早需要完整对象关系，那不如在事件发生时就把这些关系都写全。问题是，那会让每条事件重新承担 `Lookup::resolveMethod()`、类名/符号名物化、池去重和字符串管理的成本。对于采样热路径来说，这些都太重了。

所以 `recordEvent()` 的真正角色不是“完成 JFR 文件”，而是“把事件变成后续还能被解释的一段最小字节”。这个角色必须压得足够窄，后面 constant pool 才有存在意义。

### 这不是“只写缓冲、永不落盘”的后台模型

常态路径下，事件确实先进入 `_buf[lock_index]`，这是为了避免每条样本都争用同一个全局输出锁。但这里必须把一个边界讲透：`recordEvent()` 在完成写入后，会立刻调用 `_rec->flushIfNeeded(buf)`。一旦 buffer 达到 `RECORDING_BUFFER_LIMIT`，`flush()` 就会直接把这段数据 `write()` 到 `_fd` 或 `_memfd`，然后重置缓冲（`src/flightRecorder.cpp:568-580`、`src/flightRecorder.cpp:1530`）。

所以准确说法是：热路径的常态是“分槽追加”，而不是“绝不触盘”。当前实现允许当前调用路径在必要时自己完成一次批量 write。这个边界非常关键，因为它决定了 JFR 录制的阻塞模型，不能被简化成一个“后台线程迟早统一刷盘”的想象队列。

`recordLog()` 则是另一条不同的路径：它会在 `_rec_lock` 保护下，用一个栈上临时 `Buffer` 编码 `T_LOG`，然后直接 flush（`src/flightRecorder.cpp:1535-1554`）。这一条不走 profiling sample 的并发槽，因此不能和 `recordEvent()` 混写成同一个热路径模型。

这里先记住一句话：JFR 热路径不是零 IO，而是“先写分槽 buffer，必要时由当前路径批量 write”。

## 第四层：为什么事件里只写 ID，而 stack trace / method / class / thread 要拖到 chunk 结束时再补

到这里，最关键的设计权衡终于完整暴露出来了。每条事件里明明已经有 `tid`、`call_trace_id`、`class_id` 这些数字，为什么不干脆在事件发生时，把这些数字对应的真实对象关系一起就地写进去？

答案很简单：因为 reader 需要的是完整对象关系，但热路径不该承担完整对象关系的恢复成本。事件发生时，只要把“此刻是哪条线程、哪条 trace、哪个类、哪个地址、哪个 duration”这些最小事实记下来就够了。至于这些事实最终如何被解释成“这个线程叫啥、这条 trace 有哪些帧、这个 method 对应哪个 class、这个 symbol 长什么样”，完全可以延后到 chunk 收口时统一补。

`finishChunk()` 就是在干这件事。它先 flush monitor buffer、process buffer 和所有并发 `RecordingBuffer`，然后记录 stop 时间与 stop ticks；如果在 in-memory 模式下，还要先把 `_memfd` 内容复制到最终 `_fd`。等这些都完成之后，才把当前文件位置记成 `cpool_offset`，调用 `writeCpool()` 真正开始写 constant pool（`src/flightRecorder.cpp:347-367`）。

`writeCpool()` 内部再按固定顺序写出 frame types、thread states、GC when、threads、stack traces、methods、classes、packages、symbols、strings、user event types 和 log levels（`src/flightRecorder.cpp:844-872`）。这里每一种 pool 都不是“优化项”，而是某一类事件字段的解释后援。例如：

- `tid` 需要 thread pool 才能还原线程元数据；
- `call_trace_id` 需要 stack trace pool 才能还原帧列表；
- frame 里的 method key 继续需要 method/class/package/symbol pool 才能还原成真正的方法身份；
- span tag、user event type 等则依赖 string/user event type pools。

### 为什么 stack trace pool 不能在事件发生时完整写出

这一步必须讲得更硬，因为它是整篇文章的核心失败方案。一条事件里的 `call_trace_id` 看起来像只是一个“懒得展开的引用”，但其实它代表的是一个 deliberate choice：事件热路径只引用 trace 身份，不当场物化 trace 内容。

`writeStackTraces()` 先从 `CallTraceStorage.collectTraces()` 拿到带 ID 的 trace 集合，再通过 `Lookup::resolveMethod()` 把每个 `ASGCT_CallFrame` 解析成 JFR `StackFrame` 需要的 method、line number、bytecode index 和 frame type（`src/flightRecorder.cpp:962-990`）。这一步显然比“写一个整数 ID”重得多，因为它已经进入了对象关系恢复层。

如果把这层工作提前到每条事件发生时做，代价会立刻炸开：每条事件都要展开整条 stack trace，都要解析方法与行号，都要参与 method/class/symbol 的池管理，还要面对同一条 trace 被重复写多次的问题。这样不仅热路径变重，JFR 文件本身也会充满重复的结构描述。

所以当前实现明确采用了另一种策略：事件发生时只记 `call_trace_id`，chunk 结束时再统一问一句“这一段时间里真正被事件引用过的 trace 是哪些”，然后一次性把它们补进 stack trace pool。reader 后面读到事件时，再通过同一个 ID 去找对应的 trace。

```text
事件：tid=42, call_trace_id=100

finishChunk()
  → T_THREAD pool：42 → 线程元数据
  → T_STACK_TRACE pool：100 → CallTrace 的帧列表
  → T_METHOD/T_CLASS/T_PACKAGE/T_SYMBOL pools
  → JFR reader 按 ID 还原完整事件
```

### `collectTraces()` 重置 samples 不是细节，而是 chunk 边界协议

这里还藏着一个极容易被轻描淡写带过、但实际上非常关键的设计：`CallTraceStorage::collectTraces()` 在收集 trace 时，会把 `values[slot].samples` 置零，并注明“Reset samples to avoid duplication of call traces between JFR chunks”（`src/callTraceStorage.cpp:120-140`）。

这不是普通的清理动作，而是在显式维护 chunk 边界协议。因为 JFR 的 stack trace pool 不是一个“全局永不重置的大池”，而是每个 chunk 自己要对自己的事件引用负责。若不在收集时把已消费过的 trace 标记掉，后续 chunk 就可能无差别地把前面已经写过、但这一个 chunk 里未必真正再次被引用的 trace 重抄一遍。那样既会放大文件体积，也会模糊“这个 chunk 到底为自己的事件补了哪些对象关系”这一边界。

换句话说，`collectTraces()` 的 sample reset 不是 incidental implementation detail，而是在告诉你：constant pool 的生成不是“顺手把全局状态 dump 一遍”，而是“只为当前 chunk 真正涉及到的事件关系补课”。

### JFR stack trace pool 与 flamegraph Trie 根本不是一回事

这里还必须再次打掉一个很常见的混淆。上一章 flamegraph 也在谈“栈”，本章 JFR 也在谈“栈”，于是很容易有人把两者都叫成“栈结构”。但它们服务的目标完全不一样。

flamegraph 的 Trie，服务的是前缀聚合和宽度累计，目标是让浏览器能画一张图；JFR 的 stack trace pool，服务的是稳定 ID 与事件关系恢复，目标是让 reader 能按对象池解释事件。前者更关心“哪些路径共享前缀、该怎样累宽度”，后者更关心“这个 ID 对应哪条 frame 序列、frame 里 method/class/symbol 是谁”。

把两者混在一起，会直接模糊本篇最重要的结论：JFR 在 chunk 收口阶段补的不是“另一种可视化树”，而是“reader 解释事件所需的对象池”。

## 第五层：为什么 chunk 结束时还要回补 cpool size、header 和 ticks frequency

等 constant pool 写完之后，chunk 其实还没真正完成。因为 reader 在开头就要看到的某些关键信息，只有走到 chunk 末尾这一刻才真正知道。

`finishChunk()` 在写完 cpool 并 flush 之后，会拿到 `chunk_end`。这时才能用 `chunk_end - cpool_offset` 回补 cpool size，再用 `chunk_end - _chunk_start`、`cpool_offset - _chunk_start`、`_stop_time - _start_time` 等信息 patch header（`src/flightRecorder.cpp:369-394`）。其中还会重新计算 ticks per sec：如果启用了 TSC，就根据实际 start/stop ticks 与 wall time 得到一个更准确的频率值；否则退回 `TSC::frequency()`（`src/flightRecorder.cpp:376-383`）。

这里的核心不是“补了哪些字段”，而是为什么这些字段天然只能后验得出。chunk size 要等最后一个字节写完才知道，cpool offset 要等所有 profiling events 结束后才知道，duration 要等 stop time 才知道，ticks frequency 在 TSC 场景下也最好用真实区间重新校正。当前实现没有强行绕开这个事实，而是把 patch 当成协议完成的正式一环。

这也是为什么测试里会显式关注 chunk 与时钟边界。例如 `test/test/jfr/JfrTests.java:257` 会在 `jfrsync` 模式下按 chunk 分两次读取 `ExecutionSample`，先读 JDK chunk，再读 async-profiler chunk，并比较两边的 `ticksPerSec` 是否对齐。这说明时钟与 chunk 边界不是隐藏细节，而是 reader 真会观察到、也真会依赖的格式事实。

### 多 chunk 为什么需要 `_base_id`

如果 recording 因 `_chunk_size` 或 `_chunk_time` 达到阈值而需要切换，`switchChunk()` 会先调用 `finishChunk()` 完成旧 chunk，然后把 `_chunk_start` 移到新位置，继承 stop 时间为下一个 chunk 的 start 时间，增加 `_base_id`，重置已写字节，再重新写 header、metadata 和 recording info（`src/flightRecorder.cpp:402-421`）。

`_base_id` 的意义，是给后续 chunk 的 method、symbol、package 等对象池留出一个新的 ID 区间，避免它们与前一个 chunk 的对象 ID 冲突。也就是说，chunk 切换不是“把 buffer 清空继续写”这么简单，而是要重新建立本 chunk 的对象引用空间。

这里还要守住一个边界：`_chunk_size` 默认 100 MiB、`_chunk_time` 默认 3600 秒，这些都来自 async-profiler 自己的录制策略（`src/arguments.h:273-274`、`src/flightRecorder.cpp:290-292`），不是 JFR 规范要求的固定值。不要把实现策略误写成格式规范。

## 第六层：in-memory 模式改了暂存位置，但没改写协议本身

当 JFR 选项包含 `IN_MEMORY`，并且 `OS::createMemoryFile()` 成功时，`Recording` 会把 `_memfd` 作为当前写入目标（`src/flightRecorder.cpp:314-316`）。这意味着常态 `flush()` 写到的是 `_memfd` 而不是最终 `_fd`；等 chunk 结束时，再把 `_memfd` 的内容复制到 `_fd`，继续写 cpool 和 patch header（`src/flightRecorder.cpp:360-367`、`src/flightRecorder.cpp:568-574`）。

这里最容易犯的错误，是把 in-memory 模式理解成“另一种 JFR 结构”或“另一种 writer 协议”。事实并不是这样。它只是在改变字节的暂存位置：先去内存文件，再拷到最终文件。metadata、event bytes、constant pool、header patch 的协议一层都没变。

所以这部分应该被理解成“写入策略”的变化，而不是“格式语义”的变化。它会影响内存占用与 `usedMemory()` 统计，但不会改变 reader 最终看到的 chunk 结构。

## 第七层：`--jfrsync` 为什么是文件级协同，而不是把 native 事件直接塞进 JDK Recording

如果前面的普通 `-o jfr` 讲的是“async-profiler 自己怎样手写一份 JFR-compatible recording”，那么 `--jfrsync` 讲的就是另一件事：怎样让 JDK 自己的 recording 和 async-profiler 自己的 recording 协同落到同一个目标文件里。

`FlightRecorder::start()` 里，如果 `args._jfr_sync` 非空，先调用 `startMasterRecording()`，把用户给的目标文件名记成 master recording file；随后 async-profiler 自己再打开一个带进程号的临时文件，比如 `target.jfr.<pid>~`（`src/flightRecorder.cpp:1311-1347`）。也就是说，从一开始就已经不是“同一个 writer 共写一个文件”，而是“两个 recording 各写各的，只是最终会汇到一个目标文件上”。

```text
目标文件 target.jfr
  ← JDK master Recording：JDK 原生事件

临时文件 target.jfr.<pid>~
  ← async-profiler Recording：采样/分配/锁/native 事件

停止时
  → 结束 async-profiler chunk
  → 把临时文件内容 append 到 master 文件
```

`Recording` 析构时，在完成最后一个 chunk 后会调用 `appendRecording()`，把当前 native recording 内容复制到 master file 末尾（`src/flightRecorder.cpp:332-345`、`src/flightRecorder.cpp:492-500`）。所以当前实现体现出来的不是“双 writer 交错写同一 chunk”，而是“两个 recording 在文件级串接”。

这点必须讲透，否则读者会很容易误解成：native writer 在运行时直接把自己的事件注入到了 JDK 正在维护的那个 recording 里。事实并非如此。两边在生成阶段依然保持独立，最终只在文件层汇合。

### 嵌入的 `JfrSync` helper 真正在干什么

这条协同路径确实会进入 Java 世界，但要看清进入的是哪一层。`flightRecorder.cpp` 通过 `INCLUDE_HELPER_CLASS` 把 `one/profiler/JfrSync.class` 嵌进 native 二进制；第一次走 `startMasterRecording()` 时，会检查 `jdk/jfr/FlightRecorderListener` 是否存在，定义这个 helper class，注册 native `stopProfiler()`，再解析 `start`、`stop`、`box` 方法（`src/flightRecorder.cpp:1404-1423`）。

这一步说明两件事。第一，`--jfrsync` 的确依赖 JDK 侧 JFR API；第二，这条依赖是可选的，只在协同路径下才激活，不代表普通 `-o jfr` 也必须借助 Java `jdk.jfr.Recording`。

`JfrSync.start()` 里，如果 `settings` 以 `+` 开头，就显式 enable 一组事件；否则就加载 JFR configuration，再按 event mask 禁用那些已经由 async-profiler 自己负责的 built-in events，比如 `jdk.ExecutionSample`、`jdk.ObjectAllocationInNewTLAB`、`jdk.JavaMonitorEnter` 等（`src/helper/one/profiler/JfrSync.java:55-77`、`src/helper/one/profiler/JfrSync.java:99-135`）。然后它把 destination 指向 master 文件，开启 `setToDisk(true)` 和 `setDumpOnExit(true)`，最后启动这份 JDK recording。

这个动作的真正含义不是“让 JDK 帮 native writer 补完一切”，而是“JDK 继续负责自己那部分 built-in 事件，async-profiler 继续负责自己这套 native recording，然后最后把两份结果合在一起”。职责没有混，只有文件被合并。

### 停止顺序为什么是机制本身的一部分

当 master recording 进入 `STOPPED` 状态时，`JfrSync` 的 listener 会回调 native `stopProfiler()`；native `FlightRecorder::stop()` 再去停 `RecordingAPI`、停 `RateLimit`、停 master recording、销毁 native `Recording`，最后触发 append（`src/helper/one/profiler/JfrSync.java:47-53`、`src/flightRecorder.cpp:1352-1365`）。

这个顺序之所以重要，是因为它直接决定“哪一份 recording 先封口、哪一份 recording 后追加、最终目标文件里 chunk 的顺序是什么”。如果把这一段写成“启动一个 JDK Recording 以便同步停止”，读者就会漏掉协同机制真正的设计点：停止不是一个附属操作，而是保证两个 recording 最终能以正确顺序落成文件的组成部分。

`test/test/jfr/JfrTests.java:257` 也正是在验证这一点：reader 会先读到 JDK chunk，再读到 async-profiler chunk，并比较两边的 ticks frequency 与 `clock` 设置。说明协同后的结果不仅是“文件存在”，而且 chunk 边界和时钟语义都对 reader 可见。

### jfrsync 的兼容边界

当前实现明确要求目标环境能找到 `jdk/jfr/FlightRecorderListener`；如果 `FindClass("jdk/jfr/FlightRecorderListener")` 失败，`startMasterRecording()` 就直接返回错误（`src/flightRecorder.cpp:1404-1411`）。`Profiler::start()` 还会拒绝非 Java 进程的 jfrsync（`src/profiler.cpp:894`）。

因此必须明确区分：普通 native JFR writer 与 `--jfrsync` 是两条不同路径；后者依赖 JDK JFR API 和嵌入的 helper；JFR 文件“能读”不等于所有运行环境都支持 jfrsync；master recording 的配置和 event mask 会直接影响哪些 JDK built-in events 被保留、哪些被禁用。

## 常见误解与实现边界

**误解一：async-profiler 的 `-o jfr` 直接调用了 `jdk.jfr.Recording`。** 普通 JFR 输出由 native `Recording` 手写 header、metadata、event 和 constant pool；只有 `--jfrsync` 才定义并调用嵌入的 `JfrSync` helper。

**误解二：recordEvent 只是临时记一下计数，真正的事件要等停止时才生成。** 当前 `recordEvent()` 会立即把事件字段编码进对应 `RecordingBuffer`；停止或 chunk 切换时主要补写对象池、刷盘和 patch header。

**误解三：热路径永远只写内存，不会真的执行 `write()`。** 常态确实是分槽追加，但 buffer 达到阈值后，当前调用路径会直接触发 `flush()` 的 `write()`。

**误解四：JFR 的 stack trace pool 就是 flamegraph 的 Trie。** 前者面向稳定 ID、方法/类解析和事件关联；后者面向前缀聚合与可视化宽度，目标完全不同。

**误解五：`collectTraces()` 重置 samples 只是内部清理小动作。** 这实际上是在维护 chunk 边界，避免同一批 trace 在后续 chunk 中被无差别重复补进 stack trace pool。

**误解六：`--jfrsync` 把 native 事件直接注入正在运行的 JDK Recording。** 当前实现先写独立的 async-profiler recording，结束时再 append 到 master 文件；这是文件级协同，而不是共写同一 chunk。

**误解七：metadata 只是可选说明信息。** 当前 writer 按 metadata 中的类型和字段顺序编码，reader 依赖它解释事件与 constant pool；metadata 与 event bytes 是同一份格式契约的两面。

## 收网：async-profiler 真正拆开的，是“事件发生时必须写什么”和“reader 最终需要什么”

如果把整条链压成一句话，async-profiler 并不是“绕开 JDK API 直接硬写一个文件”，而是在 native 侧完整兑现了一套 JFR-compatible 的协议分工：热路径先写最小事件事实，chunk 收口时再补对象关系，reader 最终依赖 metadata 和 constant pool 把两者重新拼回完整语义。

```text
Profiler::recordSample()
  → CallTraceStorage.put()：得到 call_trace_id
    → FlightRecorder::recordEvent(lock_index, tid, trace_id, event_type, event)
      → 对应 record* writer：立即编码事件字段
        → _buf[lock_index]：并发槽缓冲
          → buffer 满时 flush(write)

Recording::finishChunk()
  → flush monitor/process/event buffers
    → writeCpool()
      → threads / stack traces / methods / classes / packages / symbols / strings
        → patch cpool size
          → patch chunk header
            → JFR reader / JMC
```

到这里，主线只发生了三件事。

第一，metadata 先定义 reader 应该怎样解释后续字节，所以事件 bytes 从一开始就不是孤立数据，而是 schema 契约下的实现。

第二，事件热路径只写固定布局的 native buffer，并在必要时由当前路径批量 `write()`；它刻意不承担完整对象池物化。

第三，chunk 结束时才把 call trace、方法、类、线程和字符串整理成 constant pool，并回补 header，让 reader 最终拿到一份自洽的 chunk。

*关键设计（斜体）：* *async-profiler 把“事件发生时必须立即写什么”和“reader 最终需要哪些对象关系”强行拆开：前者进入分槽 buffer，后者在 chunk 完成阶段通过 constant pool、metadata 和 header patch 补齐。*[模式: 事件即时编码 + 延迟对象池 + chunk 封装]

**本篇的一句话困惑**：async-profiler 没有直接调用 JFR Java API，为什么生成的文件仍能被 JMC/JFR reader 正确解释？

**本篇的一句话顿悟**：它在 native 侧手写 JFR-compatible 的 header、metadata、事件字段和 constant pool；采样时只编码事件与对象 ID，chunk 结束时再补齐 stack trace、method、class 和 thread 等对象关系。

AP-5 下一篇进入 OTLP converter：它不再写 JFR 二进制，而是把 profiler 的样本/trace 映射成 OpenTelemetry 的 span/log/stack profile 数据结构，消费边界与 JFR 完全不同。

[跨层标注：C++ native JFR writer；JFR metadata/type contract；`lock_index` 并发缓冲；TSC tick 与纳秒/时间跨度；`write/pwrite` chunk 输出；JNI/RegisterNatives；JDK `jdk.jfr.Recording` 仅限 `--jfrsync`；JFR reader/JMC 消费]
