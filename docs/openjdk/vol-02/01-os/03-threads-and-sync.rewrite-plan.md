# 03-threads-and-sync 重写规划

> 状态：重写前大纲
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 目标：把“7 种线程、优先级、park、suspend”统一成一篇关于 JVM 如何组织、调度并暂停线程的机制文

## 1. 选题判断

本篇值得独立成篇，但不能继续按“线程分类表 → 优先级表 → PlatformEvent → SuspendResume”并列推进。

统一问题应改成：

**JVM 里这么多不同职责的线程，为什么不能都按普通 Java 线程处理？当它们需要等待、唤醒或被外部暂停时，HotSpot 如何保证关键角色继续工作，又如何避免唤醒丢失和挂起死锁？**

四块内容的统一主线：

- 线程角色决定谁必须活跃、谁必须停下
- 调度优先级表达系统关键路径
- park 是线程主动交出控制权
- suspend 是外部强制改变线程状态，风险完全不同

## 2. 读者困惑

`top -H` 里为什么一个 JVM 会有几十个线程？

为什么 GC、VM、编译器、Watcher 线程不能都像业务线程一样平等调度？

为什么 `LockSupport.unpark()` 先发生，后面的 `park()` 不能把信号丢掉？

为什么 JVM 不推荐用强制 suspend 来做普通并发等待？

## 3. 一句话顿悟

**HotSpot 不是在创建一堆平等线程，而是在建立一支有明确分工的运行时队伍：关键线程通过角色和优先级保证 VM 能继续推进，协作等待用可记忆 permit 防止丢唤醒，外部 suspend 则用显式状态机承认强制暂停的风险。**

## 4. 版本边界

- 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
- `ThreadType`、nice 映射、pthread 属性、PlatformEvent、SuspendResume 是 HotSpot/Linux 实现
- 线程数量由 GC、编译器、启动参数和版本配置决定，不应写成固定清单
- safepoint 参与者和暂停规则需要区分“线程角色”和具体 safepoint 实现，本文只建立基础模型

## 5. 旧稿主要问题

### 已有优点

- 7 类线程清单和关键字段完整
- nice 映射、PlatformEvent 三态、SuspendResume 四态都有源码
- 能指出 Watcher/VMThread 与普通 Java 线程的角色差异
- 已经有“强制暂停 vs 协作等待”的对照

### 必须修复

- 线程分类表缺少“为什么要这样分”的冲突场景
- 优先级部分容易把 nice 映射写成严格的调度保证，需要明确它是调度权重/优先倾向，不是绝对先后
- WatcherThread 最高优先级的因果需要源码边界，不应把所有 GC/JIT/JFR 触发都简单归给它
- PlatformEvent 三态要按真实状态转换讲，不能只给一个简化状态图
- “PlatformEvent 与线程同生共死”要核对对象生命周期语义，避免把实现注释泛化
- `park`、`parkNanos`、`parkUntil`、`PosixSemaphore` 需要明确层次，避免旁支过散
- SuspendResume 的“WatcherThread 超时回退”需要源码核实，不能只按旧稿描述
- “Park 无死锁风险”应改成“不会因外部强制暂停而引入同类风险”，避免绝对化

## 6. 结构大纲

### 第一节：事故开场——一个 JVM 为什么需要不同的线程阶层

场景：

- GC 线程被业务线程挤压
- VM 操作没人执行
- Watcher 被饿死后自适应机制停止
- 调试器强制暂停一个持锁线程，另一个线程永远等待

预估字数：900-1100

### 第二节：先画角色图——7 类线程不是清单，而是运行时分工

文字图：

```text
业务层：JavaThread
执行层：CompilerThread / GC threads
协调层：VMThread / WatcherThread
其他宿主层：os_thread

请求发生 → Watcher/业务触发 → VMThread 串行执行关键 VM 操作
                         → GC/Compiler 并行推进
```

必须回答：

- `ThreadType` 是什么
- 哪些是数量可变的类别
- 为什么 VMThread 是特殊的协调角色
- 为什么线程角色会影响 safepoint 待遇

预估字数：1500-1800

### 第三节：线程怎样出生——pthread 属性、栈大小与 detach

目标：把创建过程和上一篇栈保护连接起来。

必须讲：

- `pthread_attr_t`
- detached 线程为何适合 JVM 的生命周期
- 栈大小如何按线程角色区分
- `create_main_thread` / `create_attached_thread` 为什么是特殊入口
- 失败方案：所有线程统一栈大小、统一 join、把附加线程当新线程创建

预估字数：1300-1600

### 第四节：优先级不是“谁永远先跑”，而是“关键路径不能被饿死”

目标：解释 Java priority 到 Linux nice 的翻译与边界。

必须讲：

- Java 11 级到 Linux nice 的 M:1 映射
- `MaxPriority -> nice -5` 不等于 nice -10
- VMThread 为什么绕开普通 Java priority 映射
- WatcherThread 为什么需要高优先级
- nice 是调度权重，不是绝对先后保证
- 失败方案：所有线程同优先级、把 Critical 当万能最高优先级

预估字数：1800-2200

### 第五节：park——线程主动等待，为什么 permit 必须记住

目标：围绕“提前 unpark 不丢失”讲 PlatformEvent。

必须讲：

- `_event` 的真实语义
- mutex/condvar 如何协作
- park 与 unpark 的交错顺序
- 为什么两态不够
- `_nParked`、padding、PlatformParker 的作用边界
- `parkNanos` 与 `parkUntil` 为什么需要不同时间处理

预估字数：2200-2600

### 第六节：suspend——外部强制暂停为什么必须用状态机

目标：对比协作等待与外部暂停。

必须讲：

- 四种 SuspendResume 状态
- request 与 suspended 为什么必须分离
- 线程何时真正进入 suspended
- 恢复如何走 wakeup request
- 超时/失败回退的真实条件
- 持锁线程被强制暂停为什么可能制造死锁

预估字数：2000-2400

### 第七节：收网——线程角色、调度、等待、暂停是一套控制系统

收束：

- 角色决定责任
- 优先级保护关键推进者
- park 保护协作等待的信号
- suspend 承认外部控制的危险

预估字数：700-900

## 7. 必须展开的失败方案

1. 所有 JVM 线程统一按 Java 线程处理
2. 所有线程使用相同优先级
3. `park/unpark` 只用一个“是否已唤醒”布尔值
4. 线程先 park、再检查信号
5. 外部 suspend 不设置中间态，直接把线程标记为 suspended
6. 强制 suspend 一个持有锁的线程

## 8. 必须澄清的误解

1. 7 种 `ThreadType` 不是 JVM 进程中固定只有 7 个线程
2. nice 值不是绝对调度顺序
3. `CriticalPriority` 不是所有线程都能随意使用
4. `unpark` 不是简单唤醒系统调用，而是可被后续 park 消费的 permit
5. park 是协作等待，但不代表任何相关代码都天然无死锁
6. suspend 请求发出不等于目标线程已经停下
7. safepoint、park、外部 suspend 是三种不同的暂停语义

## 9. 证据清单

- `os.hpp:487-495`：`ThreadType`
- `os_linux.cpp:4691`：Java priority 到 nice 映射
- `thread.cpp:1385-1388`：WatcherThread 优先级
- `vmThread.cpp:301-306`：VMThread native priority
- `concurrentGCThread.cpp:44`：并发 GC 线程优先级
- `os_linux.cpp:938`：`create_thread`
- `os_cpu/linux_x86/os_linux_x86.cpp:734`：默认栈大小
- `os_posix.hpp:163-192`：`PlatformEvent`
- `os_posix.hpp:205-220`：`PlatformParker`
- `semaphore_posix.hpp:33-50`：`PosixSemaphore`
- `os.hpp:981-1000`：`SuspendResume::State`
- `thread.cpp` 中 suspend/resume 状态转换实现：写作时重新核验

## 10. 字数预算

- 目标正文总字数：`10000-14000`
- 叙述性正文目标：`7000+`

## 11. 实证补充

正文必须优先使用本地 OpenJDK 11u 实测，而不是只列理论线程名。

实验入口：

- JDK：`/data/tmp/opencode/jdk11`
- 最小程序：`/data/tmp/opencode/Loop.java`
- 观测命令：`ps -T -p <pid> -o pid,tid,comm,args`
- JVM 转储：`/data/tmp/opencode/jdk11/bin/jcmd <pid> Thread.print`

实验结论必须明确区分：

- `ps -T`：Linux 视角的 OS 线程全集
- `jcmd Thread.print`：JVM 组织的 JavaThread 与部分 VM/GC 线程视图
- `ThreadType`：HotSpot 内部职责分类

实测线程名可以作为文章中的证据样本，但不能当成所有 JDK 11、所有 GC 配置下的固定线程清单。

## 12. 完成后 review 清单

1. 删掉代码后是否仍能解释线程角色和状态转换
2. 是否把“线程清单”写成了“角色冲突与职责分工”
3. 是否明确 nice 只是调度倾向，不是绝对顺序
4. 是否完整推演了提前 unpark 和强制 suspend 的失败场景
5. 是否核对了 SuspendResume 的真实实现，而不是沿用旧稿推断
6. 是否区分 park、safepoint、外部 suspend
7. 是否完成版本边界、禁用词、证据和总图检查
