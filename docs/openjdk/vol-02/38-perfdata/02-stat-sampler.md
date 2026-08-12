# 02. StatSampler — 谁在周期性刷新计数器

> **前置依赖**:[01 — PerfData 架构](01-perfdata.md):计数器对象在 C 堆、值在共享区,`_sampled` 列表与 `sample()` 的落点
> → **后续**:[41-zip-jimage/01 — ZIP 文件读取](openjdk/vol-02/41-zip-jimage/01-zip.md)(第 2 批下一域)
> 关联域: 18-safepoint(safepointTime 等计数器在 safepoint 事件里 inc)、39-runtime-mon(另一条观测通道)、32-jfr(事件采样)

## 谁在给 hrt.ticks 充值

01 篇留下一个悬念: `sun.os.hrt.ticks` 这类计数器**不是**业务线程随手写的——它需要一个"采样者"周期性地把内部时钟读出来写进共享内存。这个采样者就是 **StatSampler**: 一个挂在 WatcherThread 上的周期任务,默认每 50ms 跑一次,把"采样型计数器"的值刷进 PerfData 区域。这篇拆开它: 采样线程怎么运转、哪些计数器走采样(哪些不走)、以及这种"周期刷"与无锁读怎么配合。

## 1. 采样线程: WatcherThread 上的周期任务

### 注册链: engage → enroll → tick → task

StatSampler 不是独立线程——它是 `PeriodicTask` 的一个子类实例,注册进 WatcherThread 的任务表。链条从 VM 启动开始:

1. `Thread::create_vm` 里调 `StatSampler::engage()`(thread.cpp:4048,与 MemProfiler/JniPeriodicChecker 等一起注册);
2. `engage`(statSampler.cpp:78-90)创建 `StatSamplerTask(PerfDataSamplingInterval)` 并 `enroll()`——任务表 `_tasks[]` 最多 10 个槽(task.hpp:45-48),间隔参数 `PerfDataSamplingInterval` 默认 **50ms**(globals.hpp:2431):

```cpp
// statSampler.cpp:78-90(截取核心,逐字)
void StatSampler::engage() {

  if (!UsePerfData) return;

  if (!is_active()) {

    initialize();

    // start up the periodic task
    _task = new StatSamplerTask(PerfDataSamplingInterval);
    _task->enroll();
  }
}
```

3. WatcherThread(thread.hpp:902,名字 "VM Periodic Task Thread")的主循环是: 算好离下一个任务还有多久 → 睡到点 → `PeriodicTask::real_time_tick(time_waited)`(thread.cpp:1453-1507);
4. `real_time_tick`(task.cpp:49-71)遍历任务表,对每个任务调 `execute_if_pending(delay_time)`——累积时间到 `_interval` 就执行 `task()` 并清零(task.hpp:82-92,逐字):

```cpp
// task.hpp:82-92(逐字)
  void execute_if_pending(int delay_time) {
    // make sure we don't overflow
    jlong tmp = (jlong) _counter + (jlong) delay_time;

    if (tmp >= (jlong) _interval) {
      _counter = 0;
      task();
    } else {
      _counter += delay_time;
    }
  }
```

5. `StatSamplerTask::task()` 就一行: `StatSampler::collect_sample()`(statSampler.cpp:41-45)。

**关键设计 (斜体)**: *把采样器做成 PeriodicTask 而不是独立线程,是"复用一颗时钟": WatcherThread 本来就要周期醒来处理各类任务(超时、检查、JVMTI 等),采样只是任务表里的一项——多一个 50ms 任务,不新增一个睡眠线程。*

### 采样循环: 只碰 sampled 列表

`collect_sample`(statSampler.cpp:158-177)→ `sample_data(_sampled)`(:135-143):

```cpp
// statSampler.cpp:135-143(截取核心,逐字)
void StatSampler::sample_data(PerfDataList* list) {

  assert(list != NULL, "null list unexpected");

  for (int index = 0; index < list->length(); index++) {
    PerfData* item = list->at(index);
    item->sample();
  }
}
```

注意它只遍历 **`_sampled` 列表**(`PerfDataManager::sampled()`,statSampler.cpp:69 从 PerfDataManager 拿副本)——不是所有计数器。`PerfData::sample()` 是虚函数,`PerfLongVariant::sample`(perfData.cpp:216-220)的实现是: 有 `_sample_helper` 就从 helper 取新值,写进共享内存(01 篇讲过的 `_valuep`)。**采样只写值,不分配内存、不创建条目**——条目在启动时一次性铺好(01 篇的 create_entry),采样的全部成本是一次取数 + 一次 8 字节写。

## 2. 哪些计数器走采样: 采样型 vs 事件驱动型

### 采样型: 注册时带上"取数器"

计数器创建时如果带 `PerfSampleHelper*`(或直接给一个 `jlong*` 地址),`PerfDataManager::create_xxx` 会把 `sampled=true` 传给 `add_item`(perfData.cpp:487-503),对象进 `_sampled` 列表(perfData.cpp:318-322)。每个采样计数器自带一个取数器——`sun.os.hrt.ticks` 的取数器是 `HighResTimeSampler`(statSampler.cpp:338-342,逐字):

```cpp
// statSampler.cpp:338-342(逐字)
class HighResTimeSampler : public PerfSampleHelper {
  public:
    jlong take_sample() { return os::elapsed_counter(); }
};
```

每次采样,`sample()` 调 `take_sample()` 把 `os::elapsed_counter()`(高精度时钟)刷进共享区。机制总结: **采样型计数器的值不由事件驱动,由采样周期驱动**。

### 事件驱动型: 不走 StatSampler

对照 01 篇的例子——`sun.rt.safepointTime`/`sun.rt.applicationTime`/`sun.rt.safepoints` 是 **RuntimeService** 在初始化时创建的(runtimeService.cpp:45-68),更新靠 **safepoint 事件**: `record_safepoint_begin` 里 `_total_safepoints->inc()`、`_application_time_ticks->inc(...)`(runtimeService.cpp:87-102)。`sun.cls.loadedClasses` 同理——ClassLoadingService 创建(classLoadingService.cpp:87),类加载时更新。它们**不在 sampled 列表里**,值在事件发生时即时写,不经过采样循环。

**关键设计 (斜体)**: *两类计数器的分工是"谁有资格等"——事件驱动计数器要求值在事件发生时就位(jstat 立刻看到最新 safepoint 数),采样计数器允许最多一个采样周期的延迟(hrt.ticks 本来就只是时间戳/活性信号,50ms 的滞后无人在意)。StatSampler 只碰后者,事件路径零额外开销。*

## 3. 采样与读取: 无锁 + 最终一致

### 采样写入与 jstat 读取的并发

采样线程(非 safepoint 参与者的 WatcherThread,见 task.cpp:65 注释 "The WatcherThread does not participate in the safepoint protocol")写共享内存的同时,jstat 可能在读同一个 8 字节。安全性来自 01 篇的两个前提,这里只需确认采样路径同样满足:

- **写入是 8 字节对齐的普通 store**(create_entry 的对齐 + `*(jlong*)_valuep = ...`),x86-64 上原子;
- **消费者容忍旧值**: jstat 读到的可能是上一轮采样值。对 1-5 秒刷新的监控面板,50ms 的采样粒度无感。

### 就绪信号: accessible,不是 size

"数据什么时候可以读"由 prologue 的 `accessible` 标志表达(01 篇讲过: VM 启动完成时置位,management.cpp:205-207)。读方(JDK 侧 PerfDataBuffer)检查 magic、版本与 accessible 之后才开始按 entry_offset 遍历条目——不需要额外的"数据无效"标记,因为计数器条目在启动时一次性铺好、不存在"半初始化条目"。整个共享区的并发模型就是: 结构一次性建成 + 标量 8 字节原子写 + 读方容忍旧值。

**关键设计 (斜体)**: *"采样"这个动作本身也不加锁: 采样线程写、消费者读,都是普通内存访问。之所以成立,是因为协议把"并发窗口"压缩到最小——结构在启动时定型(accessible 置位前消费者根本不来),热路径上只有标量写。这是典型的"用结构不变性换并发安全": 锁解决不了的问题(消费者数量未知、进程间锁清理困难),结构一次性初始化天然规避。*

## 核心悬念

采样通道到齐: StatSampler 以 PeriodicTask 身份挂在 WatcherThread 上,50ms 一轮只遍历 `_sampled` 列表、只写值不分配;事件驱动型计数器(safepointTime/loadedClasses)则绕过采样,在事件发生处即时 inc;读方靠 magic/版本/accessible 判断就绪,标量 8 字节原子写 + 容忍旧值撑起无锁。PerfData 域到此收官——jstat 的数字从哪来、谁在刷新、怎么无锁,闭环了。下一域换一种形态: JVM 从 JDK 的模块镜像里读类文件——ZIP 结构怎么解析、哈希查找怎么加速——域 41: ZIP 与 jimage。

> → [41-zip-jimage/01 — ZIP 文件读取](openjdk/vol-02/41-zip-jimage/01-zip.md)
