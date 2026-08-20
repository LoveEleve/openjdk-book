# 38-perfdata/02-stat-sampler 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释 sampled PerfData 为什么不让业务线程自己在事件点更新，而要通过 WatcherThread 上的周期任务统一刷新，以及这条采样通道怎样与事件驱动型计数器分工共存

## 1. 选题判断

现稿已有较好的事实基础：
- `StatSampler::engage`
- `PeriodicTask` / `WatcherThread`
- sampled 列表遍历与 `item->sample()`
- `HighResTimeSampler`
- 与 `RuntimeService` / `ClassLoadingService` 事件驱动计数器的对比

但当前正文仍偏“注册链 + 哪些计数器走采样”的清单式展开。真正该打穿的读者困惑更集中：

**既然 JVM 内部自己就知道什么时候发生了类加载、safepoint、GC、编译等事件，为什么还有一批 PerfData 计数器不在事件点即时更新，而要专门挂一个 50ms 周期任务去刷新？谁来跑这个周期任务，它为什么不单独开线程，为什么 sampled counters 和事件驱动 counters 要故意分成两条路？**

这才是本篇最该回答的问题。

## 2. 一句话顿悟

**StatSampler 不是“定时把所有计数器重写一遍”，而是 PerfData 为“没有天然事件边界、但又需要对外暴露当前值”的那类观测量单独开的刷新通道：JVM 让事件驱动型计数器在事件现场即时写入，把 sampled 型计数器集中挂到 WatcherThread 的 `PeriodicTask` 表里按固定周期采样。这样既避免每个业务线程都背采样职责，也避免为少数 sampled 值单独养一条线程。**

## 3. 总图

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

## 4. 结构大纲与字数预算

### 第一节：开场困惑——为什么有些计数器不在事件现场更新

目标约 1200 字。

- 从 `sun.os.hrt.ticks`、`javaCommand`、safepoint counters 对比切入
- 点出：不是所有观测量都有天然“事件发生点”
- 埋主线：sampled 计数器是为“持续状态”开的另一条写入路径

### 第二节：两个朴素方案为什么都不行

目标约 1800 字。

必须推演：
1. 所有计数器都让业务线程在现场自己写
2. sampled counters 单独开一条专属采样线程

结论：
- 第一种会把采样责任散落到业务线程和热点路径
- 第二种又会为少数 sampled 值额外引入线程与调度复杂度

### 第三节：注册链——为什么 StatSampler 只是 WatcherThread 上的一个任务

目标约 2100 字。

- `Thread::create_vm` 调 `StatSampler::engage`
- `StatSamplerTask(PerfDataSamplingInterval)`
- `PeriodicTask::enroll`
- `WatcherThread::run` / `sleep`
- `PeriodicTask::real_time_tick` / `execute_if_pending`
- 强调“复用一颗时钟，不新增一条睡眠线程”

### 第四节：采样循环——为什么它只碰 `_sampled` 列表

目标约 1900 字。

- `initialize` 里拿 `PerfDataManager::sampled()` 副本
- `collect_sample -> sample_data`
- `PerfLongVariant::sample`
- 采样只写值、不建条目、不改结构
- 路标：它刷的是“值投影”，不是对象注册表

### 第五节：sampled counters——哪些值适合走采样

目标约 1800 字。

- `HighResTimeSampler` / `sun.os.hrt.ticks`
- helper 型 sampled 值和地址型 sampled 值的共同点
- 解释“没有天然事件边界，但对外希望看到当前状态”
- 强调允许一个采样周期的滞后

### 第六节：事件驱动 counters——为什么它们故意绕过 StatSampler

目标约 1900 字。

- `RuntimeService::record_safepoint_begin`
- `ClassLoadingService` 的 loaded/unloaded counters
- 说明这些值在事件现场就必须就位
- 收回主线：不是所有 PerfData 都需要定时刷新

### 第七节：采样与读取并发——为什么这里继续能无锁

目标约 2000 字。

- WatcherThread 不参与 safepoint protocol 的注释边界
- sampled 写入仍然是标量 `_valuep` 写
- readable/accessible 边界仍来自上一篇的 Prologue 协议
- 不夸大成强一致，只强调结构已定型 + 值允许稍旧

### 第八节：误解澄清与收网

目标约 1300 字。

至少回答：
1. StatSampler 是否刷新所有 PerfData
2. sampled 是否等于“不重要”
3. WatcherThread 是否专门为 PerfData 而生
4. 事件驱动与采样型能否混用
5. 无锁读取是否意味着 sampled 值总是最新

## 5. 失败方案必须写进正文

1. 所有计数器都在业务线程现场即时写
2. sampled counters 单独开专属后台线程
3. 把 sampled 与 event-driven 计数器混成同一更新模型

## 6. 证据清单

- `share/runtime/statSampler.cpp:42`：`StatSamplerTask`
- `share/runtime/statSampler.cpp:59`：`StatSampler::initialize`
- `share/runtime/statSampler.cpp:78`：`StatSampler::engage`
- `share/runtime/statSampler.cpp:135`：`sample_data`
- `share/runtime/statSampler.cpp:155`：`collect_sample`
- `share/runtime/statSampler.cpp:338`：`HighResTimeSampler`
- `share/runtime/statSampler.cpp:348`：`create_sampled_perfdata`
- `share/runtime/task.hpp:45`：`PeriodicTask` 限制与 `execute_if_pending`
- `share/runtime/task.cpp:49`：`real_time_tick`
- `share/runtime/thread.cpp:1395`：`WatcherThread::sleep`
- `share/runtime/thread.cpp:1453`：`WatcherThread::run`
- `share/runtime/thread.cpp:4048`：`Thread::create_vm` 调 `StatSampler::engage`
- `share/runtime/globals.hpp:2431`：`PerfDataSamplingInterval = 50`
- `share/runtime/perfData.cpp:216`：`PerfLongVariant::sample`
- `share/services/runtimeService.cpp:87`：safepoint 事件驱动更新
- `share/services/classLoadingService.cpp:84`：class loading 计数器创建

## 7. 必须明确的边界

- 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
- 本篇聚焦 sampled 刷新通道，不展开 WatcherThread 的全部职责
- 事件驱动计数器只举典型对照，不扩成 RuntimeService / ClassLoadingService 专题
- “无锁”仍限定在 PerfData 的当前共享布局模型，不外推成通用并发模板
- 下一篇前若不继续 PerfData 域，也要让本文自成闭环

## 8. 完成后 review

- 删除代码后，能否复述“StatSampler 是 sampled counters 的独立刷新通道，而不是全量重写器”
- 是否讲清楚 sampled 与 event-driven 两类计数器的分工边界
- 是否解释了为什么复用 WatcherThread 而不是单独开线程
- 是否说明 sampled 值允许滞后，但结构协议仍由上一篇兜底
- 是否完成删码测试、禁用词、链接、`file:line`、`git diff --check` 校验
