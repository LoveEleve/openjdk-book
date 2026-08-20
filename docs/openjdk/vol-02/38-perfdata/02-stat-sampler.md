# 02. 为什么有些 PerfData 不在事件现场更新？— `StatSampler`

> **版本边界**：本文基于 `OpenJDK 11u / HotSpot / Linux / x86_64`。这里讨论的是 PerfData 域里 sampled counters 的刷新通道：`StatSampler` 如何以 `PeriodicTask` 的身份挂到 `WatcherThread` 上，按固定周期采样 `_sampled` 列表，并与事件驱动型计数器并存。WatcherThread 的其他职责不在本篇展开。
>
> **前置依赖**：[01 — `jstat` 凭什么能跨进程读 JVM 数字？— `PerfData` 架构](01-perfdata.md)
> → **后续**：[41-zip-jimage/01 — ZIP 文件读取](../41-zip-jimage/01-zip.md)

上一篇已经把 PerfData 主通道搭好了：对象在 JVM 内，值在共享区，布局是公共契约。外部工具靠 `PerfDataPrologue + PerfDataEntry` 去读共享内存，而 HotSpot 内部则继续用 `PerfData` 对象管理名字、单位、可变性和数据槽位。

但到那里为止，还有一个看似不起眼、其实非常关键的问题没有回答：**这些值是谁写进去的？**

有些计数器很直觉，比如类加载次数、safepoint 次数、GC 次数——事件一发生，现场顺手 `inc()` 一下就行。但像 `sun.os.hrt.ticks` 这种值，就没有一个同样自然的“事件现场”：它表示的是当前高精度时间计数器的某种对外投影，不是某个离散事件发生一次就更新一次的东西。

这就逼出本篇真正要回答的问题：**既然 JVM 内部自己就知道什么时候发生了类加载、safepoint、GC、编译等事件，为什么还有一批 PerfData 计数器不在事件点即时更新，而要专门挂一个 50ms 周期任务去刷新？谁来跑这个周期任务，它为什么不单独开线程，为什么 sampled counters 和事件驱动 counters 要故意分成两条路？**

先把答案压成一句话：**`StatSampler` 不是“定时把所有计数器重写一遍”，而是 PerfData 为“没有天然事件边界、但又需要对外暴露当前值”的那类观测量单独开的刷新通道：JVM 让事件驱动型计数器在事件现场即时写入，把 sampled 型计数器集中挂到 WatcherThread 的 `PeriodicTask` 表里按固定周期采样。这样既避免每个业务线程都背采样职责，也避免为少数 sampled 值单独养一条线程。**

## 先试两个最自然的办法，看看为什么都不行

### 朴素方案一：所有计数器都让业务线程在事件现场自己写

这是最自然的第一反应。

既然 HotSpot 本来就知道 safepoint 什么时候开始、类什么时候加载、GC 什么时候发生，那索性所有计数器都在这些现场更新不就行了？谁触发了事件，谁顺手把对应的 PerfData 写掉。

这个方案对一类计数器确实成立，但对另一类根本不成立。

原因在于，并不是所有观测量都有一个天然、低成本、语义清晰的“事件现场”。

比如：

- `loadedClasses` 这种天然就和“类刚加载完”绑定；
- `total_safepoints` 天然就和“safepoint 开始”绑定；
- 但 `hrt.ticks` 这种值更像一个“当前时间源的外部投影”，它不是某个天然离散事件的副产品。

如果你硬把后一类值也塞进业务线程现场更新，就会遇到两个问题。

第一，写入责任会四处散落。业务线程、VM 线程、类加载路径、GC 路径都可能要为“顺手采一份当前状态”负责。

第二，很多 sampled 值其实并不要求事件到达那一刻就立刻可见，它只需要“对外周期性反映当前状态”。如果还强行把它塞进事件现场，就相当于把一类本可集中、低频、独立刷新的工作，摊到了原本就承担业务语义的热路径上。

也就是说，**事件驱动写入适合“这个事件本来就在这里发生”的计数器，不适合“只需要周期观察当前值”的计数器。**

所以第一种朴素方案失败，不是因为 HotSpot 不喜欢统一，而是因为 sampled 值和事件值本来就不是一类更新模型。

### 朴素方案二：既然要周期刷，那就专门开一条采样线程

第二个也很自然的想法是：好，我承认有些值更适合定时采样。那最直接的办法就是专门给 PerfData 再开一条后台线程，每 50ms 醒来，刷一遍 sampled counters。

这个方案也能工作，但它仍然不是 HotSpot 的选择。

问题不在于“多一条线程绝对不行”，而在于：**JVM 里本来就已经有一个周期性醒来的统一时钟角色——WatcherThread。**

如果为了少量 sampled counters 再单独养一条线程，就会平白增加：

- 一条新的睡眠/唤醒循环；
- 一套独立的注册与调度关系；
- 一份额外的线程生命周期管理成本。

而这些事情 WatcherThread + `PeriodicTask` 框架本来就已经在干了。既然系统里已经有一颗统一的“周期心跳”，最自然的做法就是把采样任务挂上去，而不是再造一颗新的心脏。

所以第二种方案失败的根本原因是：**HotSpot 不需要“为 PerfData 单独造一个周期线程”，它更偏向复用现成的周期任务框架。**

这两个失败方案合起来，正好引出 `StatSampler` 的正式设计：**事件驱动计数器继续在现场写；sampled 计数器则集中交给 WatcherThread 上的一项周期任务。**

## 注册链：为什么 `StatSampler` 只是 WatcherThread 上的一个任务

先从它怎么挂进去看起。

`StatSampler` 不是一个线程类，也不是一个独立调度器。它的最底层形态只是一个 `PeriodicTask` 子类：

```cpp
class StatSamplerTask : public PeriodicTask {
  public:
    StatSamplerTask(int interval_time) : PeriodicTask(interval_time) {}
    void task() { StatSampler::collect_sample(); }
};
```

`share/runtime/statSampler.cpp:42`

这几行代码已经把它的身份说得很清楚：**采样器不是一条线程，而是“到点就执行 `collect_sample()`”的一项周期任务。**

### `engage()`：启动时把自己挂到周期任务表里

真正的注册入口在 `StatSampler::engage()`。如果 `UsePerfData` 打开，而且当前还没 active，它就会先 `initialize()`，再创建一个 `StatSamplerTask(PerfDataSamplingInterval)`，最后 `enroll()`。`share/runtime/statSampler.cpp:78`

这里有两个重要信息。

第一，采样周期直接来自 `PerfDataSamplingInterval`。当前默认值是 `50`，也就是 50ms。`share/runtime/globals.hpp:2431`

第二，`enroll()` 说明它不是自己管理调度，而是加入某个统一任务表。

而 `Thread::create_vm()` 正是把这个入口接到 VM 启动链路里的地方。源码可以直接看到它会调 `StatSampler::engage()`。`share/runtime/thread.cpp:4048`

这就把整件事串起来了：**PerfData 采样不是工具 attach 之后才临时起一个线程，而是在 VM 自己启动时就挂进了统一的周期任务系统。**

### `PeriodicTask`：任务表不是无限的，也不是随时乱执行

`PeriodicTask` 自己的定义也很有信息量。它明确写了：

- 系统里最多 `10` 个周期任务；
- 间隔最小粒度是 `10ms`；
- `execute_if_pending(delay_time)` 会累加已过去的时间，只有达到 `_interval` 才调用 `task()`。`share/runtime/task.hpp:39`

这说明周期任务框架本来就不是为“海量微任务”准备的，而是为少量、系统级、可等待的后台周期动作准备的。`StatSampler` 正好符合这种身份。

### WatcherThread：真正周期醒来的只有它

那谁在推动这些任务前进？是 WatcherThread。

`WatcherThread::run()` 的主循环非常简单：

- 先调用 `sleep()` 算离下一次任务还有多久；
- 睡到点；
- 然后把实际等过的时间交给 `PeriodicTask::real_time_tick(time_waited)`。`share/runtime/thread.cpp:1453`

而 `real_time_tick()` 内部会拿着 `PeriodicTask_lock` 遍历 `_tasks[]`，对每项都执行 `execute_if_pending(delay_time)`。`share/runtime/task.cpp:49`

这就解释了为什么 `StatSamplerTask::task()` 最终会定期触发：不是它自己在计时，而是 WatcherThread 周期性醒来，顺手给所有周期任务“推进一格时间”。

### 为什么这是“复用一颗时钟”，不是“又多一层转发”

从功能上看，这好像多绕了一圈：`WatcherThread -> real_time_tick -> execute_if_pending -> StatSamplerTask::task -> collect_sample`。

但工程上这恰恰是最省事的结构。

因为它表达的是：**StatSampler 不拥有自己的时钟，它借用系统里那颗已经存在的时钟。**

这样做的直接收益是：

- 不新增睡眠线程；
- 不新增独立调度循环；
- 不把 PerfData 采样变成一个特殊基础设施；
- 只是在已有 PeriodicTask 表里多占一个槽位。

所以如果把这节压成一句话，那就是：**HotSpot 没有为 sampled PerfData 单独造一个线程，而是把它做成 WatcherThread 上的一项普通周期任务。**

## 采样循环：为什么它只碰 `_sampled` 列表

挂进 WatcherThread 之后，下一步该看它到底刷什么。

`StatSampler::initialize()` 先做两件事：

- 创建那些在更早阶段还没法安家的 perfdata；
- 再从 `PerfDataManager::sampled()` 拿一份 `_sampled` 列表的副本。`share/runtime/statSampler.cpp:59`

后面真正执行采样时，`collect_sample()` 最终只是调用：

```cpp
sample_data(_sampled);
```

而 `sample_data()` 的实现更直接，就是遍历列表，对每个 `PerfData* item` 调一次 `item->sample()`。`share/runtime/statSampler.cpp:135`

这段逻辑很值得停一下，因为它说明了两件常被混淆的事。

第一，`StatSampler` 不是“刷新所有 PerfData”。它只碰 `_sampled` 列表。

第二，采样动作不是“重新建条目”或“每轮重算共享布局”。当前实现通常是在初始化后拿一份 sampled 列表副本，随后主要让对象把当前值写回自己对应的 `_valuep` 槽位。

也就是说，`StatSampler` 刷新的不是 PerfData 的“结构”，而是 PerfData 的“当前值投影”。

### `collect_sample()` 为什么刻意保留一份 sampled 列表副本

源码里还有一段很说明问题的注释：`collect_sample()` 里把“如果 PerfDataManager 计数增加，就重新拿 sampled 列表副本”的逻辑注释掉了，留成 future work。`share/runtime/statSampler.cpp:155`

这说明当前实现通常把 sampled 集合视为启动后基本稳定，不在每轮采样里动态重建列表。对这篇主线来说，最该记住的不是这个 future TODO，而是：**采样循环追求的是便宜而稳定，不想把自己变成一个每 50ms 还要重建元数据视图的管理线程。**

这和上一章 PerfData 的“共享布局先建好，运行期主要写值”这条主线正好一脉相承。

## sampled counters：哪些值适合走采样

现在可以问最关键的业务问题了：到底什么样的值适合进 `_sampled`？

### 典型例子：`sun.os.hrt.ticks`

`StatSampler::create_sampled_perfdata()` 里有个最好的样板：`HighResTimeSampler`。它的 `take_sample()` 只返回 `os::elapsed_counter()`。`share/runtime/statSampler.cpp:338`

随后 `create_sampled_perfdata()` 会把它注册成：

```cpp
PerfDataManager::create_counter(SUN_OS, "hrt.ticks", PerfData::U_Ticks, psh, CHECK);
```

`share/runtime/statSampler.cpp:348`

这非常说明 sampled counters 的定位：它们不是在“某个离散事件”发生时才有意义，而是需要一个外部可读的、周期刷新的“当前值镜像”。

### `sample()` 真正做的只是“向 helper 要一份当前值”

`PerfLongVariant::sample()` 的实现几乎朴素到不能再朴素：如果 `_sample_helper` 不为 NULL，就执行：

```cpp
*(jlong*)_valuep = _sample_helper->take_sample();
```

`share/runtime/perfData.cpp:216`

这也恰好解释了 sampled counters 和事件型 counters 的本质差别：

- 事件型 counter 的值由“事件发生”推进；
- sampled counter 的值由“采样时刻的 helper 返回结果”刷新。

这两种值来源完全不一样，所以强行统一更新模型只会让其中一类变别扭。

### sampled 不等于“不重要”

这里特别容易出现一个误解：既然 sampled 值允许 50ms 滞后，那是不是说明它们不重要？

不是。

更准确地说，sampled 只表示：**它们对“采样时机”比对“事件现场”更敏感。**

像 `hrt.ticks` 这种值，本来就更像一个时间源信号或活性参考。它重要，但它的重要性不依赖于“某个业务事件一发生就立刻写进去”。它需要的是：

- 低成本；
- 周期可见；
- 对外有稳定的当前值投影。

这正是 sampled 通道擅长的事。

## 事件驱动 counters：为什么它们故意绕过 `StatSampler`

说清 sampled 之后，必须再把另一类计数器拉回来对照，不然读者很容易误以为 PerfData 最终都是由 WatcherThread 定时刷新。

事实并不是这样。

### `RuntimeService`：safepoint 相关值就在 safepoint 现场写

`safepoint` 相关计数器就是最典型的反例。

`RuntimeService::record_safepoint_begin()` 在 safepoint 开始时，如果 `UsePerfData` 打开，就会直接：

- `_total_safepoints->inc()`；
- 必要时 `_application_time_ticks->inc(...)`。`share/services/runtimeService.cpp:87`

这条路径完全不经过 `StatSampler`。

原因也很好理解：safepoint 次数、应用时间这类值，本来就有清晰、离散、必须即时生效的事件边界。与其每 50ms 才统一刷新一次，不如在事件现场立刻写，既准确又便宜。

### `ClassLoadingService`：类加载计数也不该等采样周期

`ClassLoadingService` 也是同样。它创建 `loadedClasses`、`unloadedClasses`、`sharedLoadedClasses`、`sharedUnloadedClasses` 这些 counter。`share/services/classLoadingService.cpp:84`

这类值天然绑定在类加载/卸载事件上。它们如果不在现场更新，而是等下一轮采样才反映出来，反倒会把原本精确的事件计数搞成“延迟对外可见的近似状态”。

所以它们故意绕过 `StatSampler`，不是因为 WatcherThread 不够好，而是因为 sampled 模型根本不适合它们。

### 真正的分工标准：谁有资格等

到这里可以把 sampled 和 event-driven 的分工压成一句非常实用的话：**看这个值有没有天然事件边界，以及它能不能容忍一个采样周期的滞后。**

- 有天然事件边界、且现场必须就位的，走 event-driven；
- 没有天然事件边界、但需要周期对外暴露当前值的，走 sampled。

这就是为什么 HotSpot 不试图把所有 PerfData 收敛到同一更新模型。统一看起来整洁，实际上会让两类本质不同的观测量彼此迁就。

## 采样与读取并发：为什么这里继续能无锁

还剩最后一个关键点：WatcherThread 自己也是在运行期正常活动的线程，它会一边采样写值，另一边 `jstat` 可能正在跨进程读值。为什么这里继续不需要重型并发协议？

### WatcherThread 本来就不参加 safepoint 协议

`PeriodicTask::real_time_tick()` 里有一句很关键的注释：WatcherThread 不是 JavaThread，所以它不参与 `PeriodicTask_lock` 上的 safepoint protocol。`share/runtime/task.cpp:49`

`WatcherThread::sleep()` 那边也同样强调：它不因为自己是周期线程，就突然被纳入 JavaThread 那套 safepoint 参与模型。`share/runtime/thread.cpp:1395`

这说明 sampled 通道从设计上就不是“依赖 safepoint 去同步”的，而是按普通后台线程方式运行。

### sampled 写入仍然只是上一篇那种标量值写

但这并不危险，原因也正是上一篇已经建立的边界仍然成立。

`PerfLongVariant::sample()` 的更新就是一条普通的 `_valuep` 赋值。`share/runtime/perfData.cpp:216` 共享区的结构早在启动时就已经铺好，条目不会在每轮采样里重新分配或重排。于是运行期高频并发窗口里真正发生的，只有：

- WatcherThread 定时把 sampled 值写进一个 8 字节对齐槽位；
- 外部读方把这个槽位读出来。

也就是说，采样通道之所以继续能无锁，不是因为它 magically 安全，而是因为它刻意把运行期并发窗口压缩成了**“只写已存在条目里的标量值”**。

### 就绪边界仍然不是采样器自己负责

这里还要再强调一次：`StatSampler` 负责的是“定期刷新 sampled 值”，不是“宣布整个共享区已经 ready”。

共享区何时可读，仍然靠上一篇的 `accessible` 协议。采样器并没有为 sampled counters 再发明一套独立的“准备好了”标志。它只是在 PerfData 主通道已经搭好的前提下，利用那条通道持续往里写新值。

所以本篇最该记住的边界是：**StatSampler 解决的是刷新时机，不是共享布局协议本身。**

## 到这里为止，主线其实只发生了四件事

如果前面信息比较多，这里先把整件事压回四步：

1. `StatSampler` 在 VM 启动时以 `PeriodicTask` 身份挂进 WatcherThread 的任务表；
2. WatcherThread 周期醒来后，通过 `real_time_tick()` 推动 `StatSamplerTask::task()`；
3. 采样器只遍历 `_sampled` 列表，让每个 sampled `PerfData` 把当前值写回共享槽位；
4. 有天然事件边界的 PerfData 则继续在事件现场即时更新，根本不走这条采样通道。

只要这四步还在脑子里，`StatSampler` 就不会再看起来像“一个定时刷表的小功能”。

## 常见误解澄清

### 误解一：`StatSampler` 会刷新所有 PerfData

不是。

它只拿 `PerfDataManager::sampled()` 这份列表副本，真正执行时也只遍历 `_sampled`。事件驱动型计数器并不经过它。`share/runtime/statSampler.cpp:59`、`share/runtime/statSampler.cpp:135`

### 误解二：sampled 就等于“不重要”

不对。

sampled 只表示“它更适合按周期观察当前值”，不表示它不重要。像 `hrt.ticks` 这种值本来就不是离散事件计数，而是状态型观测量。

### 误解三：WatcherThread 是专门为 PerfData 造的线程

不是。

PerfData 只是 `PeriodicTask` 表上的一个任务；WatcherThread 是更一般的系统级周期任务承载者。`share/runtime/thread.cpp:1453`

### 误解四：事件驱动和采样型计数器可以随便混用

不建议这么理解。

两类值的分工边界在于“有没有天然事件边界、能不能容忍一个采样周期的滞后”。混用会把某一类值逼进不适合它的更新模型。

### 误解五：无锁读取就意味着 sampled 值总是最新

不是。

PerfData 的这条观测通道更强调低成本和最终可见，而不是事务式最新值保证。sampled 值天然可能落后一个采样周期，这正是它和事件驱动计数器的区别之一。

## 收网：`StatSampler` 的本质，是 sampled counters 的独立刷新通道

现在再回头看开头那个问题，答案已经能收成一张总图了。

```text
启动时
  Thread::create_vm
    └─ StatSampler::engage
         └─ new StatSamplerTask(interval) + enroll()

运行时
  WatcherThread
    └─ PeriodicTask::real_time_tick(delay)
         └─ StatSamplerTask::task()
              └─ StatSampler::collect_sample()
                   └─ sample_data(_sampled)
                        └─ PerfData::sample()

分工
  sampled counters
    └─ 周期取样写共享区
  event-driven counters
    └─ 在事件现场即时 inc/set
```

把它再压成三句话：

- `StatSampler` 让 sampled PerfData 不必把刷新责任散落到业务线程和事件现场；
- WatcherThread + `PeriodicTask` 让 JVM 不必为这条通道额外养一条专属采样线程；
- 事件驱动型计数器继续走事件现场即时写，sampled 型计数器则集中走周期刷新。

所以 `StatSampler` 的价值，不在于“每 50ms 做了一次遍历”这么表面的事实。

真正的价值是：**它给 PerfData 划出了一条专门服务“状态型观测量”的刷新通道，让 JVM 不必把所有观测值都硬塞进事件驱动模型，也不必为少数 sampled 值付出额外线程成本。**

这也让 PerfData 域真正闭环了：上一篇讲“对象怎么住进共享区、外部怎么读”，这一篇讲“哪些值由谁在什么时候写进去”。再往后切域，就从“运行时观测通道”转到另一类运行时基础设施。

> → [41-zip-jimage/01 — ZIP 文件读取](../41-zip-jimage/01-zip.md)
