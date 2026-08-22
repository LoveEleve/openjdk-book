# 17-threads/01-thread-hierarchy 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释 JVM 线程的四层身份（JavaThread/Thread/OSThread/pthread）、JavaThread 的启动链路，以及 VM/GC/编译器/Watcher 等非用户线程如何分家

## 1. 核心困惑

**一个 JVM 里到底有几种“线程”？`java.lang.Thread`、C++ `JavaThread`、OS pthread 和 `OSThread` 如何对应？为什么 CompilerThread 明明不跑用户 Java，却仍是 JavaThread 子类？VMThread/GC/Watcher 又为什么走 NonJavaThread 分支？**

## 2. 一句话顿悟

**JVM 把线程身份拆成四层：`Thread` 管 VM 线程行李与公共生命周期，`JavaThread` 承载 Java 对象/状态/栈锚点，`OSThread` 对账 pthread 与 OS 状态，pthread 负责内核调度。差异不在“有没有一条 OS 线程”，而在 run() 多态行为和 Java 状态/栈扫描协议：用户线程、编译器线程复用 JavaThread；VM/GC/Watcher 走 NonJavaThread。**

## 3. 结构

1. 开场：一个 JVM 好几种线程身份
2. 两个误解：JavaThread=OS thread / CompilerThread=NonJavaThread
3. Thread 公共基类与每线程行李
4. JavaThread 启动链路
5. JavaThread 身份字段
6. NonJavaThread / NamedThread / WatcherThread 家族
7. OSThread OS 对账本
8. 收网

## 4. 证据清单

- `src/hotspot/share/runtime/thread.hpp:115-373`
- `src/hotspot/share/runtime/thread.hpp:794-817`
- `src/hotspot/share/runtime/thread.cpp:488-502`
- `src/hotspot/share/runtime/thread.cpp:1758`
- `src/hotspot/os/linux/os_linux.cpp:770-819`
- `src/hotspot/share/runtime/thread.cpp:370-401`
- `src/hotspot/share/runtime/thread.hpp:952-1040`
- `src/hotspot/share/runtime/thread.hpp:819-923`
- `src/hotspot/share/runtime/osThread.hpp:56-77`

## 5. 完成后 review

- 能否复述四层线程身份分工
- 是否讲清 JavaThread 启动与 threadStatus 写入时机
- 是否讲清 CompilerThread 是 JavaThread 子类
- 是否讲清 NonJavaThread 与 WatcherThread 分支
- 是否完成禁用词、链接、`file:line`、删码、`git diff --check` 校验