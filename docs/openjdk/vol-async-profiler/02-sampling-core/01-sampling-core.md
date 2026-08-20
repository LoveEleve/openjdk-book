# 01. 信号响起的一瞬间 —— 采样主路径与 `recordSample`

> **前置依赖**：[03 —— `jattach`、`fdtransfer` 与权限桥](../01-startup-attach/03-attach-fdtransfer.md)：知道 agent 已经进 JVM，必要时 perf 相关资源也已准备好
> → **后续**：CPU / alloc / lock / wall 等事件的具体引擎分流
>
> 本篇所有源码锚点均已回对 async-profiler 源码。

## 真正的采样，从信号或事件回调进入 `recordSample`

场景：profiler 已经 attach 成功，参数也被解析成 `Arguments`。接下来真正的问题不是“动作是什么”，而是：**一次采样事件到来时，调用栈怎样被记录成一条样本？**

在 async-profiler 里，这条主路径最终会汇入 `Profiler::recordSample()`（`src/profiler.cpp:402-493`）。无论前端来自 CPU 信号、wall-clock 线程信号，还是某些 JVMTI/事件路径，最后都要把“这次样本”转成 call trace 和 event 记录。

## 为什么采样器宁可丢样本，也不肯在这里等锁

`recordSample()` 一开始做的不是栈行走，而是保护自己：

1. `atomicInc(_total_samples)` 先累计总样本数（`:403`）；
2. 取当前线程 id（`:405`）；
3. 走 `RateLimit::allow(event_type)`（`:408`）判断预算；
4. 走 `tryLock(tid)`（`:408`）尝试拿到一个并发锁槽。

如果预算不允许，或者当前并发采样信号过多、锁槽拿不到，方法直接放弃这次样本（`:408-417`）。这里还有一个特殊分支：

```cpp
if (event_type == PERF_SAMPLE) {
    PerfEvents::resetBuffer(tid);
}
```

对应 `src/profiler.cpp:412-415`。这是因为 perf ring buffer 如果不重置，下一次读取可能还会看到残留事件。也就是说，**丢弃样本**并不等于**什么都不用做**。

关键设计（斜体）：*采样器先保证自己不死锁、不爆并发，再考虑把样本记下来。*[模式: 预算节流 + 无阻塞 tryLock] 采样路径宁可丢样本，也不能在信号上下文里为了“完整记录”去等待锁或扩大内存。

## 为什么采样器总共有 16 个锁槽，却一次只试 3 个

`CONCURRENCY_LEVEL` 的真实定义在 `src/profiler.h:30`，当前值是 **16**。`tryLock(tid)` 的实现位于 `src/profiler.cpp:185-194`：它先把线程 id 混洗成一个初始槽位，然后最多尝试连续 3 个候选锁槽；三次都拿不到，立即返回 `-1`。

所以这里不是“总共只有 3 个并发锁槽”，而是：

- profiler 预留了 16 个锁槽和对应的 call trace buffer；
- 单次采样只肯做 3 次无阻塞尝试；
- 第 4 次不会继续探测，而是直接放弃当前样本。

这个设计的激进点不在槽位总数，而在失败策略：即使后面还有其他槽位空着，当前 signal handler 也不愿意把搜索继续拖长。因为在信号处理上下文里，最糟糕的情况不是“少记了一条样本”，而是“为了多记一条样本，把被打断线程卡在 profiler 自己的锁竞争里”。

如果这里改成阻塞等待，或者把探测范围扩大成“遍历全部 16 个槽位直到成功”，采样器就会把自己变成被观察程序的新热点，甚至在极端情况下成为死锁源。也正因此，`recordSample()` 的正确性前提不是“永不丢样本”，而是“采样器自己永远不会成为被观察程序的死锁源”。

## 为什么一次样本不会只走一种取栈方式

过了前置保护之后，`recordSample()` 才开始构造调用栈：

- `frames` 和 `jvmti_frames` 从预分配缓冲取出（`src/profiler.cpp:421-422`）；
- 某些事件先插入事件帧（`:424-432`）；
- 有 native 栈需求时调用 `getNativeTrace()`（`:434-442`）；
- Java 栈部分再按 if/else 条件分流，而不是“永远走同一条主路径”。

真实分支条件在 `src/profiler.cpp:444-464`：

- `_features.mixed` 为真时，直接走 `StackWalker::walkVM()`，让 Java 与 native 帧交错展开；
- 否则，如果 `event_type <= MALLOC_SAMPLE`：
  - `_cstack == CSTACK_VM` 时走 `StackWalker::walkVM()`；
  - 其他情况下才走 `getJavaTraceAsync()`；
- 再否则，如果事件位于 `ALLOC_SAMPLE..ALLOC_OUTSIDE_TLAB` 且当前 `_alloc_engine == &alloc_tracer`：
  - `VMStructs::hasStackStructs()` 为真时走 `walkVM()`；
  - 否则走 `getJavaTraceAsync()`；
- 剩下的锁事件、instrumentation 事件等，则走同步 JVMTI 栈采集 `getJavaTraceJvmti()`。

这说明 async-profiler 从来不是“只会一种取栈方式”。不同事件、不同栈模式、不同 VMStructs 能力，会决定最后使用 VM walker、ASGCT 还是同步 JVMTI。

## `getJavaTraceAsync()`：信号里拿 Java 栈的主路径

`Profiler::getJavaTraceAsync()` 在 `src/profiler.cpp:350-385`。这里的第一句注释就是关键事实：

```cpp
// Workaround for JDK-8132510: it's not safe to call GetEnv() inside a signal handler since JDK 9
```

因此它先用 `VMThread::current()` 找当前线程的 VM 线程包装（`:353-356`），再从中取出 `JNIEnv*`（`:358-367`）。若拿不到 JNIEnv，就把它当成“不是 Java 线程”，直接返回 0。

之后调用：

```cpp
VM::_asyncGetCallTrace(&trace, max_depth, ucontext);
```

对应 `src/profiler.cpp:369-371`。这是 HotSpot 的 AsyncGetCallTrace（ASGCT）路径：在信号上下文里安全地尝试抓取 Java 栈。

如果拿到了栈帧，直接返回数量（`:373-375`）；如果失败，则通过 `asgctError()` 解释错误码，并将失败映射成错误帧（`:377-384`）。这样用户看到的不会是简单空白，而是 `GC_active`、`no_Java_frame`、`truncated` 这一类可解释状态。

关键设计（斜体）：*在非 mixed、非 VM walker 的信号路径里，Java 栈主入口通常是异步安全的 ASGCT，而不是同步 JVMTI。*[模式: 异步安全主路径 + 错误帧降级] 失败并不意味着整条样本报废，而是尽量转成可分析的错误标记。

## `getJavaTraceJvmti()`：不是主路径，而是可同步场景的回退

`Profiler::getJavaTraceJvmti()` 在 `src/profiler.cpp:387-399`。它直接调用 `VM::jvmti()->GetStackTrace(...)`，然后把结果复制/转换成 AsyncGetCallTrace 风格的帧数组。

这个路径更安全地出现在：

- lock 事件；
- instrumentation 事件；
- 非信号场景或明确允许同步 JVM TI 栈获取的路径。

因此不要把它理解成“ASGCT 的普遍替代品”。它是**在不受信号处理器限制时**的可用回退。

## `recordSample()` 的后半段：补帧、写入、解锁

栈行走完成后，`recordSample()` 还要做几件事：

- 如果最终 `num_frames == 0`，统一补 `no_Java_frame` 错误帧（`:466-468`）；这个兜底并不只表示“线程当前不在 Java 上下文”，也可能意味着 native/VM/JVMTI 各条取栈分支最终都没有产出任何帧；
- 如果达到栈深上限且允许截断，补 `truncated` 错误帧（`:468-470`）；
- 可选补充 thread id、sched policy、CPU 编号等辅助帧（`:473-481`）；
- 如果开启了统计，累计栈行走耗时（`:483-486`）；
- 把帧写入 `_call_trace_storage`（`:488`）；
- 再交给 `_jfr.recordEvent(...)` 记录事件（`:489`）；
- 最后 `unlock(lock_index)` 释放锁槽（`:491`）。

这条顺序说明：**采样记录并不是“先写 JFR、再存栈”，而是先把 call trace 放进存储，再由 recorder 消费其编号。**

到这里为止，主线其实只发生了三件事：第一，采样器先用 `RateLimit` 和有限次 `tryLock()` 保护自己；第二，再按事件与能力条件选择合适的取栈路径；第三，最后才把结果压进 `CallTraceStorage` 和 JFR recorder。后面的其他入口，变化的主要不是“记录终点”，而是“样本在到达记录终点前已经被准备到了哪一步”。

## `recordExternalSample()` / `recordEventOnly()`：不是所有事件都走同一入口

除了 `recordSample()`，`profiler.cpp` 里还有：

- `recordExternalSample()`（`:495-522`）；
- `recordExternalSamples()`（`:524-535`）；
- `recordEventOnly()`（`:538-548`）。

它们服务的是“外部样本已形成”或“只需记录事件、不需要完整样本”的路径，因此不能把所有模式都压成“信号到 `recordSample()`”这一条。

更关键的是，这几个入口在顺序和失败后果上并不一样：

- `recordSample()` 先 `tryLock()`，拿到锁后才继续栈行走、写 `CallTraceStorage` 和 JFR；
- `recordExternalSample()` 则先把现成帧写进 `_call_trace_storage.put()`，之后才 `tryLock()` 写 JFR（`:503-521`）；如果后面的锁没拿到，trace 已经进了存储，但 JFR 事件会丢；
- `recordExternalSamples()` 甚至先给已有 `call_trace_id` 累加 samples/counter，再尝试拿锁写 JFR（`:524-535`）；失败时计数可能已经更新，但 recorder 不一定跟上；
- `recordEventOnly()` 根本不写 call trace，只在 `_jfr.active()` 且拿到锁时记录一个“只有事件、没有栈”的条目（`:538-548`）。

所以“采样失败”在这些入口上的可见性并不相同：有的会增加 `_failures[-ticks_skipped]`，有的只是少了一条 JFR 事件，有的则只跳过 event-only recorder 写入。理解这点，才能看懂为什么同样是“没记下来”，不同事件路径的后果并不一致。

## 信号与 crash handler：采样器还要先保护自己

在 `Profiler::setupSignalHandlers()`（`src/profiler.cpp:687-709`）里，async-profiler 还会安装：

- `SIGTRAP`：给 `AllocTracer::trapHandler`（`:687-694`）；
- crash handler 替换（`:696-706`）；
- `WAKEUP_SIGNAL`（`:708`）。

这说明这里安装的不只是“样本来源信号”，还包括为 alloc trap、自身崩溃隔离和打断 syscall 服务的运行期保护设施。`SIGTRAP` 不是普通 CPU 采样入口，`WAKEUP_SIGNAL` 也不是“又一种采样事件”；它们更多是在为 profiler 自己的运行安全兜底。

关键设计（斜体）：*采样器不仅要会记样本，还要先学会在 signal、trap 和崩溃上下文里自保。*[模式: 自保护信号网] 采样正确性离不开运行期稳定性。

## 这一篇的收束

把采样主路径压缩成一句话：

```text
事件到来
  → RateLimit / tryLock 先过滤和自保
    → native / Java 栈按条件拼接
      → 错误帧与辅助帧补齐
        → call trace storage
          → recorder / JFR / 后续输出
```

这也解释了为什么 async-profiler 的“采样”不只是 `signalHandler()` 一句回调，而是一整条为了在危险上下文里安全存活的记录链。

跨层标注：[ASGCT——信号安全的 Java 栈主路径]；[JVMTI——同步回退与锁/仪表事件取栈]；[RateLimit / tryLock——采样器自保护]；[JFR recorder——事件消费后端]

## 下一篇：CPU、alloc、lock、wall 事件如何分流

这一篇回答了“样本到达后怎么记下来”，下一篇继续看“样本从哪来”：

- 哪些事件走 `cpuEngine`；
- 哪些事件走 `wallClock`；
- 哪些依赖 JVMTI 事件；
- 为什么不同事件会落到不同引擎。

**→ 下一篇：事件引擎与采样来源。**
