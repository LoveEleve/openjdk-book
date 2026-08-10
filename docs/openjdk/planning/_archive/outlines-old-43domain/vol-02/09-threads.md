# Threads（线程管理）— 文章大纲

> vol-02 · 域 09 · 🔴 A | 拓扑排序 #9 | 基于 Pass 0+1 探索
> 依赖：OS 抽象层（os::create_thread）+ OOPs

## 叙事计划

**开篇场景**：你开了一个 Spring Boot 应用，处理 100 个并发请求——JVM 背后可能创建了 100+ 个 `JavaThread`。但 JVM 里不只是 Java 线程——还有编译线程（CompilerThread）、GC 线程（ConcurrentGCThread）、VMThread、WatcherThread、信号分发线程（Signal Dispatcher）、引用处理线程（Reference Handler）、终结器线程（Finalizer）。每个都继承自同一个 `Thread` 基类，但行为和生命周期完全不同。

**第一层：线程层级——五个层次的继承树**

`Thread`（`thread.hpp:115`，继承 `ThreadShadow`）→ `NonJavaThread`（`:819`）→ `NamedThread`（`:857`）→ `WorkerThread`（`:885`）/ `WatcherThread`（`:902`）。Java 线程走另一分支：`Thread` → `JavaThread`（`:952`）→ `CompilerThread`（`:2129`）。VMThread 不继承 JavaThread——它是 `NamedThread` 的子类。

`Thread` 基类持有 `OSThread*`（平台线程对象）和 `ThreadLocalStorage`。`JavaThread` 加上栈信息（`_stack_base`/`_stack_size`）、JNI 环境、handle block。`NonJavaThread` 没有 JNI 环境——它不执行 Java 代码。

**第二层：JavaThread 状态机——五种状态的转换**

`JavaThread` 有一个 `_thread_state` 字段（`thread.hpp:1038`），编码当前执行上下文：`_thread_in_vm`（执行 JVM C++ 代码）、`_thread_in_Java`（执行解释器/编译代码）、`_thread_in_native`（执行 JNI native 代码）、`_thread_blocked`（阻塞等锁）、`_thread_new`（刚创建未初始化）。状态转换通过 `ThreadStateTransition::transition_and_fence()` 完成——不仅改状态，还插内存屏障保证 safepoint 可见性。GC 只在 `_thread_in_vm` 或 `_thread_in_Java` 时扫描该线程的栈——`_thread_in_native` 状态不扫（native 代码没有 oop 根，除非在 JNI handle block 里）。

**第三层：线程创建与销毁——栈守卫和 SMR 安全回收**

`os::create_thread()` 创建平台线程后，`JavaThread` 构造函数设置栈信息和 ThreadLocalStorage。栈守卫页（stack guard pages）在栈底映射 `PROT_NONE` 页——栈溢出时触发 `SIGSEGV`，被信号处理器捕获后抛 `StackOverflowError`。黄色区和红色区两段守卫：黄色区先触发可恢复（允许线程处理异常），红色区是致命溢出。

线程退出时不是 `delete`——是 `ThreadsSMRSupport::smr_delete()`（Safe Memory Reclamation）。其他线程可能正在遍历线程列表（通过 `ThreadsList`），直接 delete 会让 dangling pointer 指向已释放的内存。SMR 使用 hazard pointer——正在遍历的线程声明"我在读"，退出线程延迟释放直到所有读者离开。

**第四层：VMThread——执行 VM 操作的独生子**

`VMThread`（`vmThread.hpp:114`）是 JVM 中唯一的特殊线程——全局只有一个实例。它不执行 Java 代码，专职在 safepoint 中执行 `VM_Operation`（GC、偏向锁撤销、线程 dump、JVMTI 事件）。`VMThread::loop()` 等待操作入队 → 请求全局 safepoint → 所有 Java 线程暂停 → 执行操作 → 释放 safepoint——循环往复。

**第五层：Handshake——JEP 312 的线程级操作**

`Handshake`（`handshake.cpp:516`）是 JDK11 引入的机制——不触发全局 safepoint，只针对单个 Java 线程。`Handshake::execute(closure, target_thread)` 让目标线程在安全状态下执行回调——线程轮询到 handshake 请求时，暂停执行，运行 closure，然后恢复。相比全局 safepoint：更快（不需要暂停所有线程）、更轻量（只影响目标）。

**设计权衡**

一、全局 safepoint vs 线程级 handshake。safepoint 简单但影响所有线程，handshake 精准但实现更复杂（需要每线程轮询机制）。JDK11 后偏向锁撤销从 safepoint 迁移到 handshake——性能提升显著。

二、SMR vs 互斥锁。线程列表遍历用 SMR（无锁读）代替 `Threads_lock` 互斥——读路径零阻塞。代价是退出线程的延迟释放增加内存占用窗口。

## 核心悬念

**JVM 怎么管理上百个 Java 线程的生命周期——创建时有栈守卫防溢出，存活时有状态机管安全点，退出时有 SMR 防 dangling pointer？**

**→ 下一域**：线程在跑了，但 GC 要收垃圾——怎么让所有线程同时停下来？不是 `SIGSTOP`，是一页不可读内存 + 一条 polling 指令的协作式机制。Safepoint 篇见。

## 预估

1 篇，5 层递进，预估 2500-3000 行。
