# 域 17: Threads — 知识规划

> 源码路径: hotspot/share/runtime/thread.* + threadSMR.* + handshake.* + osThread.* + interfaceSupport.*
> 源码量: 16 文件 / ~10,900 行 | 🟡 大域

## 01 逐源提取

| Source File | Inferred Mechanism | Confidence |
|------------|-------------------|------------|
| thread.hpp + thread.cpp + thread.inline.hpp | **Thread 基类 — 所有线程的抽象根**: TLS(thread_local _thr_current), TLAB, ResourceArea, HandleArea, _suspend_flags(外部挂起+async exception), _polling_page(safepoint 轮询), oops_do(GC root), RcuCounter(GlobalCounter 支持), ObjectMonitor 缓存链 | High |
| thread.hpp:952-1051 (JavaThread) | **JavaThread — Java 级线程表示**: _threadObj(java.lang.Thread oop), _thread_state(JavaThreadState 状态机), _safepoint_state, termination(_not_terminated→_thread_exiting→_thread_terminated→_vm_exited), _next(全局线程链表), _anchor(java frame anchor), _deopt_nmethod, _vframe_array | High |
| thread.hpp:819-840 (NonJavaThread) + NamedThread (857-) | **NonJavaThread/NamedThread — 非Java线程层次**: NamedThread 有 _name 和 WatcherThread/VMThread/ConcurrentGCThread 三子类。通过 list 链入 NonJavaThread 全局表。is_Java_thread()=false → NonJavaThread | High |
| threadSMR.hpp + threadSMR.cpp + threadSMR.inline.hpp | **Thread-SMR — 线程安全内存回收**: hazard pointer 模式 — ThreadsListHandle 保护 JavaThread* 不被删。acquire_stable_list: 先 fast path(读 volatile _java_thread_list)→慢 path 加锁+nested handle。smr_delete: 线程退出后延迟删除，等所有 ThreadsListHandle 释放旧 list 才真正回收。to_delete_list 待删队列+delete_notify 双检查锁定减少锁竞争 | High |
| handshake.hpp + handshake.cpp | **Handshake — 线程间闭包执行**: HandshakeClosure→单个目标线程(self/polling/vmthread 三种路径)。HandshakeState 每线程一个→Semaphore 协调 VM thread vs self。process_self_inner: call do_thread→clear_handshake。try_process_by_vmThread: 检查 not_safe/state_busy→成功则 do_thread | High |
| osThread.hpp + osThread.cpp | **OSThread — OS 级线程封装**: _thread_id/os 线程句柄, ThreadState(已废弃但保持兼容), _interrupted, _start_thread_lock, platform 特定字段。JavaThread::osthread() 访问 | High |
| interfaceSupport.inline.hpp + interfaceSupport.cpp | **interfaceSupport — 线程状态转换守卫**: ThreadInVMfromJava/ThreadInVMfromNative/ThreadInVMfromUnknown/ThreadInNativeFromVM/ThreadBlockInVM — RAII 模式自动切换 _thread_state。transition: trans_and_fence(OrderAccess::fence()+set_thread_state) — 确保其他线程看到新状态后的内存可见性 | High |
| threadStatisticalInfo.hpp | **ThreadStatisticalInfo**: 统计信息 —— _active_bcp, _blocking_lock, _blocking_lock_owner, _monitor_enter, _monitor_on_deflations, _monitor_waits — 轻量级统计 | Low |
| threadLocalStorage.hpp | **threadLocalStorage**: Thread::current() 实现——_thr_current TLS 变量，signal handler 安全的 current_or_null_safe | Medium |
| threadWXSetters.inline.hpp | **threadWXSetters**: Write/Execute 内存保护 —— W^X 安全，代码段不可写。minor detail | Low |
| threadCritical.hpp | **ThreadCritical**: 临界区包装——os 层信号安全锁 | Low |

*11 个知识点*

## 02 聚合 — 跨文件汇总

### P1 — 系统级共识 (≥5 文件)
| KP | 出现文件 |
|----|---------|
| Thread 层次 (Thread→JavaThread→NonJavaThread) | thread.*, threadSMR.*, handshake.*, osThread.*, interfaceSupport.* |
| JavaThread 状态机 + 状态转换守卫 | thread.hpp, interfaceSupport.*, thread.cpp(transition), safepoint.*, handshake.* |

### P2 — 局部重要 (2-4 文件)
| KP | 出现文件 |
|----|---------|
| Thread-SMR (hazard pointer 线程安全) | threadSMR.*, thread.hpp(hazard_ptr fields), thread.cpp(thread add/remove) |
| Handshake 机制 (闭包执行) | handshake.*, thread.hpp(HandshakeState), safepoint.* |
| OSThread 平台线程封装 | osThread.*, thread.hpp(osthread()), os_linux.* |
| Suspend/Resume 外部挂起 | thread.hpp(_suspend_flags), osThread.hpp(ThreadState), interfaceSupport.* |

### P3 — 孤立 (1-2 文件)
| KP | 文件 |
|----|------|
| ThreadStatisticalInfo | threadStatisticalInfo.hpp |
| threadLocalStorage (TLS 实现) | threadLocalStorage.hpp |
| ThreadCritical (临界区) | threadCritical.hpp |
| threadWXSetters (W^X) | threadWXSetters.inline.hpp |

## 03 深度分类

### 🔴 Deep — 核心设计决策 (4 KP)
| KP | 为什么 🔴 |
|----|---------|
| JavaThread 状态机 + transition | 5 状态(_thread_in_native/_thread_in_vm/_thread_in_Java/_thread_blocked/_thread_new) —— 全部 safepoint/jni/GC 交互的基础。transition_and_fence 确保内存屏障——先写 _thread_state 再 fence——其他线程的 safepoint check 走 loadload→看到新状态→可以安全操作。这是 JVM 多线程安全的基石 |
| Thread-SMR (hazard pointer) | 线程退出后不能立即 delete——其他线程可能持有 JavaThread*。hazard_ptr 模式: 读取者发布 hazard ptr(指向当前 ThreadsList)→写入者等所有 hazard ptr 清→delete。不阻塞读路径——与 RCU 同构。ThreadsListHandle RAII 获取/释放 hazard ptr。实际实现: ThreadsList 是 JavaThread* 数组，update 时 xchg 新 list→旧 list 进 to_delete_list→等所有读者释放→free |
| Handshake 自执行路径 | 不同于 safepoint(all threads stop)，handshake 只 target 一个线程——被 target 的线程在 safepoint poll 处执行 closure(self-exec) 或在 blocked 状态由 VM thread 代理执行(vmthread-exec)。Semaphore 双边协调: self try claim→成功则自己执行; VM thread claim→等待 thread block→执行→semaphore signal。比 safepoint 轻量——不需要全局 stop-the-world |
| RAII 状态转换守卫 (interfaceSupport) | ThreadInVMfromJava 构造函数调 trans_and_fence→析构函数调 trans_and_fence 回退。不是裸 set_state——是 trans_and_fence(atomic+storeload fence)。Java→VM 的转换由 ~25 个 ThreadBlockInVM/ThreadInVMfromJava 点触发——每个都是潜在的 safepoint 点。泄露或被绕过→safepoint 静默跳过→线程在 Java 状态执行 VM 操作→corruption |

### 🟡 Working — 有设计但非核心 (4 KP)
| KP | 说明 | 为什么 🟡 非 🔴 |
|----|------|------|
| Thread 层次体系 | Thread→JavaThread/NonJavaThread→NamedThread→VMThread/WorkerThread。is_Java_thread() 是类型分派的关键 predicate | 层次本身是分类工具——状态机/SMR/Handshake 才是核心决策。层次定义是手段，不是目的 |
| OSThread 平台线程封装 | _thread_id/os 句柄, ThreadState(兼容性保留), platform 数据 | 是 Thread 的 OS 支撑——平台适配层。写作时需讲但不决定设计方向 |
| Suspend/Resume 外部挂起 | _suspend_flags: _external_suspend/_ext_suspended 用于 JVMTI/JVM_SuspendThread。self-suspend 模式——线程检查 flag 后自愿挂起。避免强制挂起的不安全状态 | 外部挂起是 JVMTI legacy——没有它 Thread 仍然正常工作。🔴状态机会决定 *何时* 可以挂起 |
| Thread 局部资源 TLAB+HandleArea+ResourceArea | 每 Thread 的分配缓存(TLAB)、JNI handle 区、resource mark 区 | TLAB 属于 GC(域9)，HandleArea 属于 JNI(域27)——在 Thread 域中只是交叉引用 |

### 🟢 Surface — 了解即可 (3 KP)
| KP | 说明 |
|----|------|
| ThreadStatisticalInfo | 统计字段——活跃 bcp/blocks/monitor 计数 |
| threadLocalStorage TLS | Thread::current() 的 TLS 实现 |
| ThreadCritical / W^X setters | os 临界区 + W^X 安全 |

## 04 聚类 — 依赖图+教学顺序+文章拆分

### 依赖图
```
                   Thread (基类)
                  /              \
          JavaThread            NonJavaThread
          |   |   |              |    |    |
     _thread_  |  Thread-   NamedThread
      state    |  SMR        (VM/GC)
               |
          Handshake
          (per-thread)
               |
      interfaceSupport
      (RAII guards)
```

### 教学顺序

**层次 → 状态 → 并发保护**:
1. 先建立 Thread 层次认知(基类→JavaThread→NonJavaThread→NamedThread→WorkerThread)
2. 再理解 JavaThread 的状态机——它是安全的基石
3. 然后讲并发保护: Thread-SMR(防止 UAF) + Handshake(线程间通信)
4. 最后讲状态转换守卫 interfaceSupport——RAII 模式实现

### 文章拆分: 4 篇

| 篇 | 标题 | 覆盖 KP | 核心问题 | 预估 |
|:--:|------|:--:|------|:--:|
| 1 | Thread 层次体系 | Thread 基类, JavaThread 字段(TLAB/HandleArea/ResourceArea), NonJavaThread, NamedThread, WorkerThread, OSThread | "JVM 里有多少种线程？它们怎么分类？" | 基础 |
| 2 | JavaThread 状态机 | JavaThreadState(5态), transition_and_fence, termination(_not_terminated→_thread_exiting→_thread_terminated→_vm_exited), safepoint 交互 | "Java 线程怎么告诉 JVM '我现在在 native code，不能 safe point'？" | 核心 |
| 3 | Thread-SMR 与 Handshake | hazard pointer 模式, ThreadsListHandle RAII, smr_delete 延迟回收, HandshakeClosure, self-exec vs vmthread-exec, Semaphore 协调 | "线程退出后怎么不 crash？怎么让一个线程在你指定的时机执行一段代码？" | 核心 |
| 4 | 状态转换守卫 (interfaceSupport) | ThreadInVMfromJava/ThreadInVMfromNative/ThreadInNativeFromVM/ThreadBlockInVM RAII, trans_and_fence 实现, Suspend 自挂起 | "线程从 Java 进入 VM——这个转换的一瞬间，JVM 怎么保证安全？" | 深度 |
