# 域 20: VM Operations — 知识规划

> 源码路径: hotspot/share/runtime/vmOperations.* + vmThread.* + task.* + init.*
> 源码量: 8 文件 / ~2,527 行 | 🟡 普通域

## 01 逐源提取

| Source File | Inferred Mechanism | Confidence |
|------------|-------------------|------------|
| vmOperations.hpp + vmOperations.cpp | **VM_Operation — 70+ VM操作基类**: 4模式(_safepoint block+safepoint / _no_safepoint block no safepoint / _concurrent non-block no safepoint / _async_safepoint non-block+safepoint), evaluate()→doit()管道, doit_prologue/doit_epilogue(JavaThread侧回调), 双链表(_next/_prev), type()/evaluation_mode()/allow_nested() 子类覆盖 | High |
| vmThread.hpp + vmThread.cpp | **VMThread — 单例 VM 操作执行线程**: loop: wait for ops→process queue→VM_Operation::evaluate()(safepoint begin→doit→safepoint end)→notify。VMOperationQueue(SafepointPriority/MediumPriority 双优先级, 双链表+计数), execute(VM_Operation*)提交+阻塞等待完成, vm_during_initialization() 启动路径特殊处理 | High |
| task.hpp + task.cpp | **PeriodicTask — 后台周期性任务**: enroll/disenroll 注册到 WatcherThread, execute_if_ready(_counter 递减到 0→执行→重置 _counter), WatcherThread::run()→while(true)执行 enrolled tasks→sleep | Medium |
| init.hpp + init.cpp | **VM 初始化序列**: init_globals()(全局变量初始化→23步有序初始化), vm_init_globals()(第二阶段: jintArgumentProlog/10_intiPhase2/30_runPhase2), 必须在 safepoint 做操作前的特殊路径 | Low |

*4 个知识点*

## 02 聚合 — 跨文件汇总

### P1 — 系统级共识
| KP | 出现文件 |
|----|---------|
| VM_Operation 提交→排队→safepoint→执行→通知 | vmOperations.*(VM_Operation+evaluate), vmThread.*(VMThread+queue), safepoint.*(begin/end 包装) |

### P2 — 局部重要
| KP | 出现文件 |
|----|---------|
| VMOperationQueue 双优先级队列 | vmThread.*, vmOperations.*(evaluate 排序) |
| PeriodicTask 框架 | task.*, vmThread.hpp(WatcherThread) |

### P3 — 孤立
| KP | 文件 |
|----|------|
| VM init 序列 | init.* |

## 03 深度分类

### 🔴 Deep — 核心设计决策 (2 KP)
| KP | 为什么 🔴 |
|----|---------|
| VM_Operation 4模式 + evaluate() 管道 | 不是所有 VM 操作都需要 safepoint——GC 需要(_safepoint), JVMTI stack trace 不需要(_no_safepoint), cleanup 可以并发(_concurrent), biased lock revoke 需要 safepoint 但不阻塞调用者(_async_safepoint)。4 模式区分了"是否需要全局暂停"+"调用者是否等待"——这是 VM 操作调度的核心决策表 |
| VMThread 提交→通知协议 | JavaThread::execute(op)→push to queue→block until op done→VMThread loop: wait for op→safepoint begin(op if _safepoint)→op->evaluate()→op->doit()→safepoint end→notify JavaThread。每个操作都有 doit_prologue(JavaThread还未阻塞, 可取消)和 doit_epilogue(JavaThread醒来后可收尾)。这个协议确保了70+种不同操作的统一接口 |

### 🟡 Working — 有设计但非核心 (2 KP)
| KP | 说明 | 为什么 🟡 非 🔴 |
|----|------|------|
| VMOperationQueue 双优先级 | SafepointPriority(GC/biased lock) > MediumPriority(non-safepoint ops)。双链表+计数——queue_peek lock-free 给 wait loop 提供快速检查 | 队列是 VMThread 的数据结构——理解协议就够了, 队列实现不改变操作语义 |
| PeriodicTask 框架 | WatcherThread 定期执行 enrolled tasks: counter 递减→0时执行→重置。典型用途: JFR recording, perfdata sampling, biased lock bulk revoke check | 是后台辅助——没有它 JVM 仍正常运行（perf 统计不准） |

### 🟢 Surface — 了解即可 (1 KP)
| KP | 说明 |
|----|------|
| VM init 序列 | 23 步 init_globals + 第二阶段 vm_init_globals——确保各子系统按依赖顺序初始化 |

## 04 聚类 — 依赖图+教学顺序+文章拆分

### 依赖图
```
JavaThread::execute(VM_Operation*)
     │
     ▼
VMOperationQueue (SafepointPriority/MediumPriority)
     │
     ▼
VMThread::loop → SafepointSynchronize::begin → VM_Operation::evaluate() → doit() → end → notify
                                                                                          │
PeriodicTask ← WatcherThread (background)                                                ▼
                                                                                  JavaThread wakeup
```

### 文章拆分: 2 篇

| 篇 | 标题 | 覆盖 KP | 核心问题 | 预估 |
|:--:|------|:--:|------|:--:|
| 1 | VM_Operation + VMThread 编排 | 4模式, evaluate/doit/doit_prologue/doit_epilogue, VMOperationQueue 双优先级, VMThread::loop, execute→wait→notify 协议 | "Java 线程说 '帮我做 GC'——这个请求怎么排队、怎么安全执行、怎么通知回来？" | 核心 |
| 2 | Background Task + Init 序列 | PeriodicTask, WatcherThread: poll+execute counter, init_globals 23步顺序, vm_init_globals 第二阶段 | "JVM 启动时按什么顺序初始化？后台周期性任务怎么调度？" | 深度 |
