# Safepoint（安全点）— 文章大纲

> vol-02 · 域 10 · 🔴 A | 拓扑排序 #10
> 依赖：OS 抽象层（信号处理）+ Threads（线程管理）

## 叙事计划

**开篇场景**：GC 要回收垃圾，但所有 Java 线程都在跑——如果直接移动对象，线程可能正握着一个指针指向旧地址。JVM 需要一种机制让所有线程同时停下来——这就是 safepoint。不是操作系统级的 `SIGSTOP`，是协作式的：JVM 在代码中预埋 polling 指令，每个线程周期性地"自觉"检查是否需要停。

**第一层：SafepointMechanism——polling page 机制**

`SafepointMechanism::initialize()`（`safepointMechanism.cpp:110`）分配两页内存：前半页 `PROT_NONE`（不可读写），后半页可读。全局变量 `_polling_page` 指向 bad 页。线程在执行循环回边或方法返回时读取 `_polling_page`——正常情况下读到 good 页（可读），safepoint 请求时把 `_polling_page` 切换到 bad 页→线程读触发 `SIGSEGV`→`JVM_handle_linux_signal` 识别为 poll address→挂起自己。

arm/disarm 是一对原子操作：`arm()` 切换 `_polling_page` 到 bad 页（通知所有线程停），`disarm()` 切回 good 页（通知继续）。polling 指令的位置由 JIT 编译器和解释器生成——编译后的代码在循环回边和方法返回前插入 `test` 指令。

**第二层：SafepointSynchronize——全局暂停的编排**

`SafepointSynchronize::begin()` 是 safepoint 的入口：设置全局标志 → 通知所有 Java 线程 → 等待所有线程到达 → 执行 VM 操作 → `end()` 释放所有线程。线程到达的顺序不重要——`ThreadSafepointState` 记录每个线程的状态（_at_poll_safepoint / _call_back）。

线程"到达"safepoint 的方式有两种：一是主动读取 polling page 触发 SIGSEGV 后挂起，二是从 native 代码返回 JVM 时被拦截（`ThreadStateTransition::transition_from_native`）。非 Java 线程（编译线程、WatcherThread）不需要参与 safepoint——它们不操作 Java 对象。

**第三层：Safepoint 性能开销——为什么 JVM 不敢随便停**

一次 safepoint 的代价：所有 Java 线程停 → 执行 VM 操作 → 全恢复。如果某个线程正在跑长循环且没有 polling 指令（比如 count loop 被 JIT 优化掉了 polling），所有其他线程都要等它——这就是 infamous 的"long safepoint pause"。`-XX:+SafepointTimeout` 检测超时 safepoint，`-XX:+PrintSafepointStatistics` 输出统计。

**第四层：与 Handshake 的关系——全局 vs 线程级**

Safepoint 是全局暂停——`Thread-Local Handshake`（`handshake.hpp`，JDK11 JEP 312）是单线程操作。有些操作不需要暂停所有线程——比如偏向锁撤销只影响持有偏向锁的那个线程。handshake 通过 `Handshake::execute(closure, target_thread)` 只暂停目标线程——不触发全局 safepoint。JDK11 把偏向锁撤销从 safepoint 迁移到 handshake 后，GC 之外的 safepoint 次数大幅减少。

**设计权衡**

一、polling page vs 显式通知。polling page 利用 MMU 的硬件保护实现零开销检测（正常情况只多一条 `test` 指令）。代价是实现依赖特定平台（不同 CPU 有不同的 `test` 指令编码位置）。

二、全局 safepoint vs 线程 handshake。全局暂停简单但影响所有线程。handshake 精准但需要每个线程有独立的轮询机制。两者共存：GC 用 safepoint（必须全局），偏向锁用 handshake（只需单线程）。

## 核心悬念

**JVM 怎么让 100 个 Java 线程同时停下来——没有 OS 信号、没有内核介入，只靠一页不可读内存和一个 polling 指令？**

**→ 下一域**：线程都停了，谁在 safepoint 里干活？`System.gc()` 怎么从你的 Java 线程跑到 JVM 唯一一个 VMThread 上——80+ 种 VM 操作全走这一个通道。VM Operations 篇见。

## 预估

1 篇，4 层递进，预估 2000-2500 行。
