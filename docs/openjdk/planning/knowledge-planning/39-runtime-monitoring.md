# 域 39: Runtime Monitoring — 知识规划

> 源码: runtime/serviceThread.* + timer.* + classLoadingService.* + runtimeService.* + threadService.* | 18文件 | 🟡 普通域

## 01 逐源提取

| Source File | Inferred Mechanism | Confidence |
|------------|-------------------|------------|
| runtime/serviceThread.hpp/cpp | **ServiceThread — 后台服务线程**: JVMTI deferred event dispatch, GC notification, OopStorage cleanup, JFR checkpoint, jvmti object tagging | High |
| runtime/timer.hpp/cpp + timerTrace.cpp | **Timer + TraceTime**: elapsedTimer(millis/nanos), TraceTime(RAII auto-print timer), 多平台(OS/javaTimeMillis) | Medium |
| services/classLoadingService.hpp/cpp | **ClassLoadingService**: loaded class count, unloaded class count, class loading time统计 | Low |
| services/runtimeService.hpp/cpp + threadService.hpp/cpp | **RuntimeService**: safepoint count/time, application time; ThreadService: thread create/peak count | Low |
| services/threadIdTable.hpp/cpp | **ThreadIdTable**: thread_id→JavaThread* 快速查询, jcmd Thread.print 的基础 | Low |

*5 知识点*

## 02 聚合 — P1/P2

### P1
| KP | 出现文件 |
|----|---------|
| ServiceThread (核心后台) | serviceThread.*, jvmtiEventController.hpp, OopStorage(域25), JFR(域32) |

### P2
| KP | 出现文件 |
|----|---------|
| Timer + TraceTime | timer.*, timerTrace.cpp, gcTimer.hpp(域25) |

## 03 深度分类

### 🔴 Deep (1 KP)
| KP | 为什么 🔴 |
|----|---------|
| ServiceThread — JVM 的唯一后台线程 | ServiceThread 处理 ~10 种 deferred tasks: JVMTI events(dynamic code event/single step), GC notification(counters update), OopStorage cleanup(delete), JFR periodic events, jvmti object tagging, JFR checkpoint。它以低优先级运行——不干扰 GC 暂停——但确保定期有进度。WatcherThread(域20)也被 ServiceThread 互补——各自处理不同类型周期性任务 |

### 🟡 Working (1 KP)
| KP | 说明 |
|----|------|
| Timer + ClassLoading/Runtime/Thread Services | 计时器+性能统计 |

## 04 聚类 — 2篇

| 篇 | 标题 | 核心问题 |
|:--:|------|------|
| 1 | ServiceThread | "JVM 的后台线程做什么？10 种 deferred tasks 是什么？" |
| 2 | Timer + Monitoring Services | "怎么计时 JVM 内部操作？Class Load/Thread Count 怎么统计？" |
