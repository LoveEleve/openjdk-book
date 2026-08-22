# 18-safepoint/01-safepoint-orchestration 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释 safepoint 如何让所有线程同时停住——三态机、begin/end 指挥、block 响应、cleanup 任务、以及 counter 的红绿灯语义

## 1. 核心困惑

**JVM 怎么让 200 个线程“同时”停住？VMThread 怎么一个一个点名、等所有线程都安全了才放行？`_safepoint_counter` 的奇偶语义在 JNI fast path 和编译检测里各扮演什么角色？cleanup 为什么是“停摆窗口里必须做的 7 件事”？**

## 2. 一句话顿悟

**safepoint 是“VM 线程持锁当门闩、所有线程排队进门”的集体停摆：`_safepoint_counter` 偶数时无 safepoint、奇数时正在 safepoint；begin() 锁线程表 + 亮黄灯 + 武装轮询 + 逐线程点名 + 三档等待；每个线程在 native 返回 / 轮询 / 阻塞点到达 block() 排队卡在 Threads_lock；end() 解除武装 + 放行。cleanup 的 7 项维护利用“全世界静止”做不含并发干扰的操作。**

## 3. 结构

1. 开场：让 200 个线程同时停住
2. 两个误解：safepoint 是信号驱动的 / `_safepoint_counter` 只用于轮询
3. 三态机与双全局量
4. begin() 指挥
5. block() 响应
6. cleanup 7 项任务
7. end() 放行
8. 收网

## 4. 证据清单

- `src/hotspot/share/runtime/safepoint.hpp:61-66`
- `src/hotspot/share/runtime/safepoint.hpp:107-119`
- `src/hotspot/share/runtime/safepoint.cpp:145`
- `src/hotspot/share/runtime/safepoint.cpp:155-453`
- `src/hotspot/share/runtime/safepoint.cpp:388-398`
- `src/hotspot/share/runtime/safepoint.cpp:499-590`
- `src/hotspot/share/runtime/safepoint.cpp:731`
- `src/hotspot/share/runtime/safepoint.cpp:816-886`
- `src/hotspot/share/runtime/safepoint.cpp:1045-1108`
- `src/hotspot/share/runtime/safepoint.hpp:228-277`

## 5. 完成后 review

- 能否复述“三态机 + counter + begin/block/end + cleanup”
- 是否讲清 counter 的三个消费者
- 是否讲清 block() 里两层锁的设计
- 是否完成禁用词、链接、`file:line`、删码、`git diff --check` 校验