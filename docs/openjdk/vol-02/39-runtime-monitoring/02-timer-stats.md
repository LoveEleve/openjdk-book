# 02. Timer + Monitoring Services — 高精度计时 + JMX 统计

> **前置依赖**:[39-runtime-monitoring/01 — JVM 的后台线程做什么?— ServiceThread](01-service-thread.md):监控数据的消费线程;[38-perfdata/01 — PerfData 架构: jstat 的数据从哪来](openjdk/vol-02/38-perfdata/01-perfdata.md):三个 Monitoring Service 的计数器全部是 PerfData;[18-safepoint/01 — JVM 怎么让所有线程同时停住?— Safepoint 编排](openjdk/vol-02/18-safepoint/01-safepoint-orchestration.md):safepoint 统计是 RuntimeService 的数据源
> → **后续**:[46-sa-postmortem/01 — SA Postmortem — core dump + ptrace + ELF symbols](openjdk/vol-02/46-sa-postmortem/01-sa-postmortem.md):39 域收官,第 5 批最后一个域
> 关联域: 35-dcmd、25-gc(GC 计时)

## GC 日志里的毫秒从哪来,计数器又给谁看

`-Xlog:gc+phases` 输出 "GC(0) Phase 1: Mark live objects 3.412ms"——这个毫秒数是一个 RAII 计时器自动打的;而 `jstat -class` 显示的 "Loaded 1841" 是 ClassLoadingService 的计数器。这篇回答: **计时器家族**(elapsedTimer/TimeStamp/TraceTime/GC 专用计时)与 **Monitoring Service 家族**(ClassLoadingService/RuntimeService/ThreadService)——它们不是各自维护数据,而是 **PerfData 计数器的读口**(38-perfdata 域的直接消费)。顺带纠正大纲两个想象: TraceTime 不在 timer.cpp 里(在独立的 timerTrace.hpp,输出走统一日志框架),GC phase 计时用的是 GCTraceTimeImpl 而不是 TraceTime;三个 Service 的计数器由**类加载/卸载事件钩子**与 safepoint 记录更新,不是"safepoint 里数一遍"。

## 1. 计时器: 从 os::elapsed_counter 到 RAII

一切的底是 **`os::elapsed_counter`**(os_linux.cpp:1435-1437)——**单调时钟**: `javaTimeNanos() - initial_time_count`(`initial_time_count` 是 JVM 启动时记录的计数器,声明 :177,启动时在 clock_init 后赋值 :5565);`javaTimeNanos`(:1555-1569)用 **`CLOCK_MONOTONIC` 的 clock_gettime**(:1558;`clock_gettime` 本身是 **dlsym 动态加载**的,:1489-1491——规避旧 glibc 的版本差异),不支持时 fallback `gettimeofday`。`elapsed_frequency` 是 `NANOSECS_PER_SEC`(:1439-1441,纳秒分辨率)。*关键设计: CLOCK_MONOTONIC 不受 NTP 同步与管理员改时间影响——GC 日志里的时间戳线性前进,即使 wall clock 被回拨*。

**elapsedTimer**(timer.hpp:32-50,注意在 **share/runtime/** 不是大纲的 utilities/): `_counter`(累计)+`_start_counter`+`_active`;`start()` 记 `_start_counter = os::elapsed_counter()`,`stop()` 把差值累进 `_counter`——支持多次 start/stop 累加。`seconds()`/`milliseconds()` 由 `_counter` 换算。**TimeStamp**(timer.hpp:53-73)是"事件时刻"记录器(`update()` 记当前 elapsed,之后查 `seconds()`/`ticks_since_update()`)。

**TraceTime 在独立文件 `timerTrace.hpp`**(share/runtime/,80 行)——RAII: 构造里 `_t.start()`,析构里 stop+打印:

```cpp
// timerTrace.hpp:57-68(截取核心,逐字)
  TraceTime(const char* title,
            bool doit = true);

  TraceTime(const char* title,
            elapsedTimer* accumulator,
            bool doit = true,
            bool verbose = false);

  TraceTime(const char* title,
            TraceTimerLogPrintFunc ttlpf);
```

**输出走统一日志框架,不是 tty**: `_print` 是 `TraceTimerLogPrintFunc`(函数指针),`TRACETIME_LOG` 宏在 `log_is_enabled` 时取 `LogImpl::write` 的地址(:57-59)——所以 TraceTime 配合 `-Xlog:startuptime` 之类的标签使用;`_accum` 参数让同一计时器跨多次调用累计。**GC 的 phase 计时用的是另一套**: `GCTraceTimeImpl`(gcTraceTime.hpp:46-65,基于 **Ticks**/utilities/ticks.hpp,同样走日志框架)+ GCTraceCPUTime/GCTraceConcTimeImpl 变体——[实证](openjdk/planning/outlines/00-jvm-tools/materials/commands/39-runtime-monitoring-timer-demo.txt)的 `-Xlog:gc+phases` 输出 "Phase 1: Mark live objects 3.412ms" 是它的产物,不是 TraceTime。

## 2. Monitoring Services: PerfData 的读口

三个 Service 都是 AllStatic,**计数器全部是 PerfData 对象**(38-perfdata 域的 PerfCounter/PerfVariable),Service 只是提供读口与语义汇总:

**ClassLoadingService**(classLoadingService.hpp): `loaded_class_count()` = `_classes_loaded_count` + `_shared_classes_loaded_count` 两个 PerfCounter 之和(:62-65)。**更新点不是"safepoint 数一遍",而是类加载/卸载事件钩子**: `notify_class_loaded`(classLoadingService.cpp:148-166,inc 计数 + 按 `compute_class_size` 累加字节)被 `classFileParser.cpp:5772`(普通类)与 `systemDictionary.cpp:1370`(共享类)调用;`notify_class_unloaded` 在 `instanceKlass.cpp:2428`(类卸载)。[实证](openjdk/planning/outlines/00-jvm-tools/materials/commands/39-runtime-monitoring-timer-demo.txt)里 `jstat -class` 显示 "Loaded 1841 / Bytes 3798.0"——**jstat 直接读 hsperf 文件**(不需要 attach!),读数就是这对 PerfCounter。

**RuntimeService**(runtimeService.hpp:34-51): PerfCounter `_total_safepoints`/`_safepoint_time_ticks`/`_application_time_ticks` + **TimeStamp** `_safepoint_timer`/`_app_timer`;`record_safepoint_begin/end`(runtimeService.cpp:87+)由 18 域的 safepoint 记录调用——`safepoint_count()`/`safepoint_sync_time_ms()`/`application_time_ms()` 就是 JMX 侧 `RuntimeMXBean` 的读口(比如 `getSafepointCount`)。

**ThreadService**(threadService.hpp:53-101): PerfCounter/PerfVariable `_total_threads_count`/`_live_threads_count`/`_peak_threads_count`/`_daemon_threads_count` **加上原子计数** `_atomic_threads_count`/`_atomic_daemon_threads_count`——`get_live_thread_count`/`get_daemon_thread_count` 读**原子计数**(:98-101,线程创建/销毁时 `increment_thread_counts`/`decrement_thread_counts` 更新,不依赖 PerfData 开关);`get_total_thread_count`/`get_peak_thread_count` 读 PerfData。

*关键设计: Service 是"读口"不是"数据源"*——数据活在 PerfData 与各类事件钩子里(JFR 的 `jfrPeriodic.cpp:459` 也直接读 `loaded_class_count`),JMX(JMM 接口,management.cpp:860)、jstat、JFR 三个消费端看到的是同一份计数器。

## 3. 组合起来: 一条监控管线

把 01 篇与这篇拼起来: **数据**在 PerfData/事件钩子(38 域+本篇)→ **Service 提供读口**(本篇)→ **ServiceThread 串行消费** JVMTI/GC/DCmd 通知(01 篇)→ **JMX/JFR/jstat/jcmd 对外暴露**(36/37 域的命令通道)。计时家族负责给这条管线打时间戳: safepoint 的 begin/end 进 RuntimeService 的 PerfCounter,GC phase 进 GCTraceTimeImpl 的日志输出,VM 内部各处用 TraceTime/elapsedTimer 做微基准。[实证](openjdk/planning/outlines/00-jvm-tools/materials/commands/39-runtime-monitoring-timer-demo.txt)里还有个环境修正: **jcmd attach 在容器可用**——之前的实验(JMC/VisualVM 自动 attach)已把 attach listener 拉起来,socket 文件在 /tmp/.java_pid<pid>,`jcmd <pid> GC.run` 直接成功("Command executed successfully")——36 域"jcmd 不可用"的结论再次修正(listener 启动后即可用)。

## 核心悬念

39 域收官: 计时家族从 os::elapsed_counter(CLOCK_MONOTONIC 单调时钟,不受 wall clock 影响)到 elapsedTimer/TimeStamp/TraceTime(timerTrace.hpp 独立文件,日志框架输出)/GCTraceTimeImpl(GC phase 专用);三个 Monitoring Service 是 PerfData 计数器的读口(类加载事件钩子/safepoint 记录/线程计数更新),JMX/JFR/jstat 三个消费端看同一份数据。至此第 5 批只剩最后一个域——也是整个 VM 核心批次的收官: **Serviceability Agent**——JVM 都死了(core dump)之后,怎么用 ptrace+ELF 符号把堆/线程挖出来。下一篇: SA Postmortem。

> → [46-sa-postmortem/01 — SA Postmortem — core dump + ptrace + ELF symbols](openjdk/vol-02/46-sa-postmortem/01-sa-postmortem.md)
