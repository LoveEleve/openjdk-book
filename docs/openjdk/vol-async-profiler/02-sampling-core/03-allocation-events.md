# 03. 堆在涨，RSS 也在涨，但“谁在分配”根本不是一个问题 —— JVM allocation 与 native malloc 的两大家族

> **前置依赖**：[02 —— 既然后端已经统一，为什么前端还要分这么多路](./02-event-engines.md)：知道来源语义会在进入统一记录后端之前先分叉。
> → **后续**：[04 —— 锁竞争、阻塞与 wall-clock 事件](./04-lock-wall-events.md)：继续进入 lock 与 wall 这两类时间/等待来源链。
>
> 本篇基于当前 async-profiler 源码。重点是 allocation 来源语义，不把 `alloc`、`outside-TLAB`、`live object`、`nativemem` 混成同一种精度或同一种事件模型。

## 堆在涨，native RSS 也在涨，但它们未必是同一来源

场景：你看到 Java 堆一直涨，于是直觉上想问“谁在 new”；但同一时间，进程的 RSS 也在涨，甚至 Java heap 指标还算稳定。这时如果你继续把问题压成一句“谁在分配内存”，就已经把两类根本不同的来源混在一起了。

在 async-profiler 里，至少要先把内存增长拆成两大家族：

```text
JVM object allocation family
  → selectAllocEngine()
    ├─ ObjectSampler / J9ObjectSampler
    ├─ AllocTracer (fallback / trap)
    └─ LiveRefs / LIVE_OBJECT dump

Native memory family
  → MallocTracer hooks
    ├─ malloc/calloc/realloc/aligned_alloc sample path
    └─ free event-only path
```

它们最后都能进入统一记录后端，但“样本为什么会在这一刻出现”完全不同：

- Java object allocation 关心的是对象创建、TLAB/outside-TLAB、对象类与存活语义；
- native memory 关心的是 libc 层 malloc/free、hook、库 patch 与地址级回收语义。

所以，本篇真正要回答的不是“alloc 事件怎么实现”，而是：**当用户说‘谁在分配内存’时，async-profiler 为什么必须先把这个问题拆开，才能保证后面火焰图上的宽度还带着正确的语义。**

*关键设计（斜体）：* *allocation 不是一个单一来源，而是两大家族：JVM 对象创建家族与 native malloc/free 家族。统一后端只能汇总结果，不能抹平来源语义。* [模式: 问题先分家，再统一汇总]

## 先推翻四个最容易把 allocation 写平的直觉

### 一个 `alloc` 事件就能解释所有内存增长

这是最危险的误解。`event=alloc` 主要回答的是 JVM 对象分配，而不是所有 native malloc/free。就算最后都能变成某种“内存热点图”，来源链不同，解释语义也不同：一个对象来自哪种类、是否走 TLAB、是否存活到 stop；与某个 native 地址被 malloc 后又 free，是完全不同的问题。

### ObjectSampler 永远是 alloc 主路径

这也不成立。当前实现真正的入口选择在 `Profiler::selectAllocEngine()`，并不是“有 alloc 就一定走 SampledObjectAlloc”。能力、JVM 类型和 TLAB 选择都会影响结果。把 ObjectSampler 写成固定主路，会把 OpenJ9 路径和 AllocTracer fallback 全部写丢。

### `--live` 只是普通过滤条件

`--live` 看起来像一个输出开关，但源码不是把它当成“最后筛一遍结果”。它会建立弱引用表、在 GC start 时重置状态，并在 stop 时触发 `dumpLiveRefs()` 把存活对象作为独立来源再送进记录后端。这是一整条附加语义链，而不是 UI 过滤器。

### free 也会像 malloc 一样留下完整 sample

native memory 章节里最容易混淆的一点，就是把 malloc 和 free 都理解成“有一条完整 sample”。当前实现不是这样：malloc 类路径可能进入 `recordSample()`；free 则走 `recordEventOnly()`。一个是样本链，一个是只有事件、没有完整栈存储的记录方式。若把这点抹平，后面就解释不清为什么 native memory 的“增长”与“回收”可见性不同。

## 第一层：JVM 对象分配到底走哪条前端，不是写死的

`Profiler::selectAllocEngine()` 位于 `src/profiler.cpp:798-805`，这是整篇 allocation 章节真正的起点：

- 先判断 `!tlab && VM::addSampleObjectsCapability()`，满足时返回 `object_sampler`；
- 只有前一条件不满足，才继续判断 OpenJ9 并返回 `j9_object_sampler`；
- 两者都不满足时，最后回退到 `alloc_tracer`。

这说明“Java 对象分配前端”不是唯一对象，而是一套按能力、JVM 类型和模式顺序分流的选择器。也就是说：

```text
我要看 Java 对象分配
  ≠ 一定走同一个 engine
```

因此，写作时必须把 ObjectSampler 和 AllocTracer 放在“同一问题的不同来源路径”里，而不是让它们彼此抢“主入口”的称号。当前实现只是在能力足够时更偏向 JVMTI SampledObjectAlloc；不满足时再退回 trap 路径。

> 路标：接下来先讲 JVM object allocation family，再讲 native memory family。不要一上来把 malloc/free 和对象分配混成“内存事件”。

*关键设计（斜体）：* *对 JVM alloc 来说，先做前端选择，再进入具体采样路径；“alloc”是问题名，不是固定实现名。* [模式: 家族内选择器]

## 第二层：ObjectSampler 不是“收到一个事件”这么简单，它还带着 live object 语义

### JVMTI 分配事件如何接进 profiler

`src/objectSampler.cpp:172-193` 展示了 ObjectSampler 的启动链：

- `_interval` 来自 `args._alloc` 或默认分配间隔；
- `initLiveRefs(args._live)` 在启动初期就处理 `--live`；
- `SetHeapSamplingInterval(_interval)` 设置 heap sampling interval；
- 开启 `JVMTI_EVENT_SAMPLED_OBJECT_ALLOC`；
- 同时开启 `JVMTI_EVENT_GARBAGE_COLLECTION_START`。

这条来源链的核心不是“打中了一段代码”，而是 JVM 以采样分配事件的形式，把对象创建通知给 profiler。回调点在 `ObjectSampler::SampledObjectAlloc()`（`src/objectSampler.cpp:134-139`）：当 `_enabled` 为真时，它把 object、class、size 交给 `recordAllocation()`。

### `recordAllocation()` 在这里做了什么

`src/objectSampler.cpp:145-157` 里的 `recordAllocation()` 会构造 `AllocEvent`：

- `_start_time` 记录事件时间；
- `_total_size` 取 `size > _interval ? size : _interval`；当前实现明确会把 sample 计量值提升到不小于 interval 的大小，但本文不再把这个选择外推成超出源码可证的设计意图；
- `_instance_size` 保留真实对象大小；
- `_class_id` 通过 `lookupClassId()` 从 JVMTI class signature 映射到 profiler 的 classMap。

之后它调用：

```cpp
u64 trace = Profiler::instance()->recordSample(NULL, event._total_size, event_type, &event);
```

这一步非常关键：ObjectSampler 并没有自己保存调用栈，它只是把“对象分配这件事发生了”的元数据接进统一记录后端。真正的栈获取、存储与 recorder 逻辑，仍由 profiler 主链负责。

### `--live` 为什么不是简单过滤

ObjectSampler 的另一条线在 `LiveRefs`。`src/objectSampler.cpp:32-129` 里维护了一张弱引用表：

- `LiveRefs::add()` 为对象创建 `WeakGlobalRef`，并把 size、trace、time 等信息放进固定大小表；
- `GarbageCollectionStart()` 在 `:141-143` 调用 `live_refs.gc()`，重置 full 标记；
- `dumpLiveRefs()` 在 `:166-169` 只有 `_live` 为真时才会执行真正 dump；
- `stop()` 在 `:185-193` 先关闭 JVMTI 事件，再执行 `VM::releaseSampleObjectsCapability()`，最后才调用 `dumpLiveRefs()`。

这说明 `--live` 的语义根本不是“事后筛掉死亡对象”。它更像：

```text
分配时记住一个弱引用
  → GC 过程中更新可用状态
    → stop 时重新扫描仍然活着的对象
      → 把它们作为 LIVE_OBJECT 再送回 profiler
```

### LIVE_OBJECT 又是另一种记录入口

`LiveRefs::dump()` 在 `src/objectSampler.cpp:97-128` 里先 `tryResetCounters()`，然后对仍然活着的弱引用构造 `LiveObject` 事件，并通过：

```cpp
profiler->recordExternalSamples(1, event._alloc_size, tid, call_trace_id, LIVE_OBJECT, &event);
```

送回后端。这里不是一次新的 `recordSample()`，而是基于原先保存的 trace id，把“这对象到 stop 还活着”作为新的 LIVE_OBJECT 语义重新入账。因此 `--live` 不仅改变“看谁”，还改变“怎么记”：它把 stop 阶段又引入了一次外部样本回灌。

还要把它和上一章的失败语义桥接起来：`recordExternalSamples()` 不是 signal 当场取栈，它会先给已有 trace 累加计数，再尝试写 recorder。因此 LIVE_OBJECT 这条链继承的是“基于现有 trace 的外部样本回灌”语义，而不是普通 allocation sample 的当场取栈语义。

*关键设计（斜体）：* *ObjectSampler 不只是分配事件适配器；一旦开启 `--live`，它还多维护了一条“弱引用表 → GC 重置 → stop dump → LIVE_OBJECT 外部样本”的附加来源链。* [模式: JVMTI 分配通知 + 存活对象再入账]

## 第三层：AllocTracer 是 fallback trap，但 trap 命中不等于每次都留下 sample

### 它依赖的是 HotSpot 内部符号，而不是 JVMTI 事件

`src/allocTracer.cpp:21-45` 的 `AllocTracer::initialize()` 做的第一件事，是从 `libjvm` 里按多个版本前缀查找 `AllocTracer` 相关符号：

- JDK 10+；
- JDK 8u262+；
- JDK 7-9。

找不到就直接返回 `No AllocTracer symbols found`。这已经说明它依赖的是 HotSpot 内部符号布局，而不是 JVM 官方采样分配 API。找到之后，`Trap` 对象会保存入口地址并配对。

### trap handler 先分辨 inside/outside TLAB

`AllocTracer::trapHandler()` 在 `src/allocTracer.cpp:48-81` 里先判断当前 PC 落在 `_in_new_tlab` 还是 `_outside_tlab` 覆盖范围：

- 命中 `_in_new_tlab`，事件类型为 `ALLOC_SAMPLE`；
- 命中 `_outside_tlab`，事件类型为 `ALLOC_OUTSIDE_TLAB`；这里已经不是“同一 alloc sample 的一个标记位”，而是独立的 event type；
- 都不是则交回 `Profiler::trapHandler()`。

随后它从寄存器上下文中取出 total size、instance size，并执行 `frame.ret()`，相当于模拟被 trap 函数返回。只有在这一切之后，才轮到真正的采样判定。

### trap 命中只是第一步，字节累计到阈值才会真的记样本

最容易被写错的地方就在 `src/allocTracer.cpp:78-79`：

```cpp
if (_enabled && updateCounter(_allocated_bytes, total_size, _interval)) {
    recordAllocation(...);
}
```

这说明一次 trap 命中并不自动等于“留下了一条 allocation sample”。真实顺序是：

1. 执行流撞到 HotSpot 分配相关 trap；
2. parser/tracer 识别 inside/outside TLAB 与大小参数；
3. `updateCounter()` 按累计字节与 interval 判断是否到了触发阈值；
4. 只有到阈值时，才调用 `recordAllocation()`。

如果把 trap 命中直接讲成“这里产生了一条分配样本”，会把 interval 的采样节流语义整个写丢。

### `--live` 在 fallback 路径上还有额外限制

`AllocTracer::start()` 的 `src/allocTracer.cpp:99-117` 还有一个非常重要的边界：当 `args._live && !args._all` 时，直接返回 `'live' option is supported on OpenJDK 11+`。紧挨着的注释还明确说明，这个 engine 会在 `Profiler::selectAllocEngine()` 里被选中，正是因为 `can_generate_sampled_object_alloc_events` 不可用，也就是当前实现主要把它当成旧 JDK/能力不足时的 fallback。也因此，不能把 `--live` 写成 allocation 的普遍能力；它依赖具体前端和 JVM 能力。

*关键设计（斜体）：* *AllocTracer 通过 HotSpot trap 观察分配，但 trap 命中只提供了“发生了候选分配”的机会；真正是否形成 sample，还要经过字节累计阈值与能力边界的二次筛选。* [模式: trap 命中 ≠ 样本形成]

## 第四层：native memory 家族盯的是 malloc/free，而不是对象创建

### malloc 路径：hook 之后才进入 sample

`src/mallocTracer.cpp:35-97` 定义了多类 libc hook：`malloc_hook`、`calloc_hook`、`realloc_hook`、`free_hook`、`posix_memalign_hook`、`aligned_alloc_hook`。这些 hook 的共同特点是：

- 先调用原始分配/释放函数；
- 在 tracer 正在运行且参数有效时，再附加记录逻辑。

真正把 native 分配送进 profiler 的逻辑在 `MallocTracer::recordMalloc()`（`src/mallocTracer.cpp:214-223`）：它先通过 `updateCounter(_allocated_bytes, size, _interval)` 判断累计字节是否越过阈值，到了才构造 `MallocEvent` 并调用：

```cpp
Profiler::instance()->recordSample(NULL, size, MALLOC_SAMPLE, &event);
```

这里和 AllocTracer 有一个共同点：触发点发生了，不等于每次都记样本；都还要经过按字节累计的阈值筛选。

### free 路径不是 sample，而是 event-only

`MallocTracer::recordFree()`（`src/mallocTracer.cpp:225-232`）则完全不同：它构造 `MallocEvent` 后，直接调用：

```cpp
Profiler::instance()->recordEventOnly(MALLOC_SAMPLE, &event);
```

这意味着当前 free 路径不走完整 sample 存储链，而是只把“释放发生了”当成一条 event-only 记录。它不会像 malloc sample 一样必然留下完整调用栈样本。

这也是为什么“malloc/free 都是 native memory 事件”这种说法还不够精确：在记录后端上，它们已经分成了 sample path 与 event-only path 两种不同精度承诺。

### `_nofree`、nested malloc 与 patchLibraries

`src/mallocTracer.cpp:119-211` 还说明了 native memory 这条链为什么比 Java alloc 更像运行时 patch 系统：

- `detectNestedMalloc()` 检测某些实现里 `calloc()` 是否内部调用 `malloc()`，以避免 double-accounting；
- `patchLibraries()` 遍历 native libs，给 malloc/realloc/free/aligned_alloc 等导入打 patch；
- `_nofree` 让 free 路径在需要时不再入账；
- `stop()` 只把 `_running` 设为 false，不恢复原始 malloc 入口，因为当前实现认为库卸载场景下这样做不安全。

这里还要把 `start()` 的时序写清：`src/mallocTracer.cpp:234-247` 先设置 `_interval`、`_nofree`、`_allocated_bytes`，首次需要时执行 `initialize()`，随后把 `_running = true`，最后才 `patchLibraries()`。也就是说，native memory 家族的“开始观测”不是一句开关，而是一条初始化 → 运行标志 → 动态 patch 的顺序链。

这条来源家族更关心的是：**哪些 libc 调用会被 patch，哪些 native 库已经被重新接管，哪些 free 应该继续可见。**它和 JVM 对象分配那条“对象类 + TLAB + live refs”路径，已经不是同一种语言。

*关键设计（斜体）：* *native memory 家族观察的是地址级 malloc/free 生命周期，而不是 JVM 对象创建；它的 patch、去重与 event-only 语义必须单独保留。* [模式: libc hooks + sample/event-only 分裂]

## 第五层：统一后端不会抹平这些来源链的精度差异

把几条入口放到一起看，最重要的不是“最后都能上火焰图”，而是它们进入后端的方式已经不同：

- `ObjectSampler::recordAllocation()` 在 `src/objectSampler.cpp:153-156` 走 `recordSample()`，并可在 `_live` 时记住 trace；
- `LiveRefs::dump()` 在 `:121` 走 `recordExternalSamples()`，把仍然活着的对象重新入账成 `LIVE_OBJECT`；
- `AllocTracer::recordAllocation()` 在 `src/allocTracer.cpp:96` 走 `recordSample()`；
- `MallocTracer::recordMalloc()` 在 `src/mallocTracer.cpp:221` 走 `recordSample()`；
- `MallocTracer::recordFree()` 在 `:231` 走 `recordEventOnly()`。

因此“内存热点”这个词背后，至少已经混着三种不同记录精度：

1. 当场取样并记录完整 sample；
2. 基于已有 trace 的外部样本回灌；
3. 只有事件、没有完整 sample 的 event-only 记录。

如果写作时把这些路径都压成“内存事件”，读者就会误以为它们在样本数量、调用栈完整性和回收语义上完全可比。事实并不是这样。

换一种更读者友好的复述方式：

- Java alloc 里，你看到的宽度更多是在回答“谁不断创建对象”；
- `--live` 追加回答“谁创建的对象活到了 stop”；
- native malloc 回答“谁不断申请 native 地址空间”；
- native free 回答“哪些地址后来被释放了”，但它的记录形态又比 malloc 更轻。

到这里，JVM object family 已经拆成了三条不同语义：对象创建通知、旧能力下的 trap fallback、以及 stop 时的存活对象再入账；native memory family 则拆成了 malloc sample 与 free event-only 两种轻重不同的记录方式。

这才是把 allocation 家族讲透后的真正收口：**统一后端只保证它们能被放到同一观察框架里，不保证它们是同一种来源语义，也不保证是同一种精度。**

## 收网：先回答“涨的是哪类内存”，再谈火焰图上谁最宽

把本篇压缩成一句话：

```text
先分清是 JVM 对象增长，还是 native malloc 增长；
再分清是创建、存活还是释放；
最后才把它们放到统一记录后端里看谁最宽。
```

本篇的一句话困惑是：**当用户问“谁在分配内存”时，为什么 async-profiler 不能只给一个 alloc 事件就结束？**

本篇的一句话顿悟是：**因为“谁在分配内存”其实混合了两类事件问题：`event=alloc` 进入 JVM object family，由 `selectAllocEngine()` 决定 ObjectSampler / J9ObjectSampler / AllocTracer；`event=nativemem` 则进入 MallocTracer hooks 家族。只有先把对象创建、outside-TLAB、live object、native malloc/free 这些来源链拆开，统一后端才有意义。**

*关键设计（斜体）：* *allocation 章节真正的起点不是输出，而是来源分家：对象创建、存活对象和 native 地址分配本来就是不同问题。* [模式: 来源分家 + 后端会师]

[跨层标注：`selectAllocEngine()`——JVM alloc 前端选择器；JVMTI `SampledObjectAlloc`——对象创建事件；HotSpot `AllocTracer` trap——TLAB/outside-TLAB fallback；`LiveRefs` / `LIVE_OBJECT`——stop 时存活对象再入账；`MallocTracer` hooks——native malloc/free 生命周期；`recordSample` / `recordExternalSamples` / `recordEventOnly`——不同精度的统一记录入口]

## 下一篇：锁竞争与 wall-clock 为什么又是另外两类时间问题

allocation 家族已经拆清楚：对象创建、对象存活和 native malloc/free 都不是同一个问题。下一篇继续看 lock 与 wall：

- 为什么 lock 观察的是竞争事件流；
- 为什么 wall 观察的是墙钟时间里的线程状态；
- 为什么它们和 CPU/alloc 的宽度语义都不一样。

**→ 下一篇：[锁竞争、阻塞与 wall-clock 事件](./04-lock-wall-events.md)。**
