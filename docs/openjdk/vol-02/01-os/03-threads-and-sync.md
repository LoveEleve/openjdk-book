# 03. JVM 里的线程为什么不平等？— 角色、等待与强制暂停

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64` 讨论
> **前置依赖**：[01 — 平台探测](01-platform-detection.md)：CPU 数与平台优先级；[02 — 虚拟内存](02-virtual-memory.md)：线程栈与保护页
> → **后续**：[04 — 信号与安全点](04-signals-and-safepoint.md)：线程如何通过信号进入安全点
> 关联域：17-threads、18-safepoint、19-sync、24-frame、28-jvmti
> 工具实证：[卷 T ch02](openjdk/vol-tools/ch02.md) 的 `Thread.print` 输出

## 先看 `top -H`：这些线程不是一支没有编制的队伍

执行：

```text
top -H -p <jvm_pid>
```

一个刚启动的 JVM，往往已经有很多线程。

你当然能认出自己的业务线程，但下面这些名字也会出现：

- `VM Thread`
- `GC Thread#x`
- `C1 CompilerThread0`
- `WatcherThread`
- `Attach Listener`

它们并不是“JVM 顺手创建出来的后台线程”。每一个线程都代表一类责任：有人负责把必须串行的 VM 操作排队执行，有人负责并发 GC，有人负责编译，有人负责定期唤醒运行时检查，还有人负责接收外部诊断请求。

如果把这些线程都当成普通 Java 线程，问题很快就会出现：

- GC 的协调线程被业务线程饿死，回收无法按时推进
- VM 操作没有唯一执行者，多个线程同时修改全局状态
- 编译线程和业务线程相互争抢，编译队列越来越长
- 一个线程被调试器强制挂起时，它手里还持有锁，另一个线程永远等不到
- `unpark` 先发生、`park` 后发生时，唤醒信号如果没有被记住，线程会睡过头

所以这篇真正要回答的不是“JVM 有哪 7 种线程”，而是：

**HotSpot 为什么要把线程分成不同角色？这些角色如何影响调度与暂停？主动等待如何避免丢信号？外部强制暂停又为什么危险？**

先把全篇总图画出来：

```text
角色分工
  JavaThread       执行业务与 Java 代码
  CompilerThread   把热点代码编译成机器码
  GC threads       推进垃圾回收
  VMThread         串行执行必须统一协调的 VM 操作
  WatcherThread    定期唤醒，驱动运行时服务

等待方式
  park/unpark      线程主动协作，permit 必须可记忆
  suspend/resume   外部强制控制，request 与真正停下必须分开
```

一句话先记住：

**HotSpot 创建的不是一堆平等线程，而是一支有职责层级的运行时队伍。**

## 先做一次实测：`ps -T` 和 `jcmd` 看到的不是同一张名单

不要只把上面的线程名当成概念示意。用本地 `OpenJDK 11u` 启动一个最小的不退出程序：

```bash
/data/tmp/opencode/jdk11/bin/java -cp /data/tmp/opencode Loop
```

程序只做两件事：主线程保持运行，另起一个线程循环调用 `LockSupport.parkNanos()`。随后分别执行：

```bash
ps -T -p <pid> -o pid,tid,comm,args
/data/tmp/opencode/jdk11/bin/jcmd <pid> Thread.print
```

实测得到的名单并不相同。

`ps -T` 展示的是 Linux 视角下的 OS 线程全集，可以看到：

- `VM Thread`
- `GC Thread#0`
- `G1 Main Marker`
- `G1 Conc#0`
- `G1 Refine#0`
- `G1 Young RemSet Sampling`
- `C1 CompilerThread0`
- `C2 CompilerThread0`
- `Sweeper thread`
- `VM Periodic Task Thread`
- `Reference Handler`
- `Finalizer`
- `Signal Dispatcher`
- `Service Thread`
- `Common-Cleaner`
- 自己创建的 `demo-parker`

而 `jcmd Thread.print` 给出的 Java 线程视图中，会列出 `main`、`Reference Handler`、`Finalizer`、编译线程、`demo-parker` 等 JavaThread；`VM Thread`、`GC Thread#0`、G1 worker 等 VM 内部线程则以转储末尾的 VM/GC 线程条目出现，未必进入前面的 Java 线程列表。

这次实测暴露了一个比“JVM 有 7 种线程”更重要的边界：

```text
Linux ps -T
  → 看 OS 层的线程全集

jcmd Thread.print
  → 看 JVM 能识别并组织出来的 Java 线程与部分 VM 线程

ThreadType
  → HotSpot 内部按职责划分的角色分类
```

所以“7 种线程”只能理解成 7 类角色，不能理解成进程里只有 7 个线程，也不能期待 `ps -T`、`jcmd` 和 `ThreadType` 三张名单逐项对齐。

这组实证还有两个值得记录的细节：

- `demo-parker` 在 `jcmd` 中显示为 `TIMED_WAITING (parking)`，这正是 Java 层 `LockSupport.parkNanos()` 到 HotSpot park 原语的可见结果
- 执行诊断命令后，进程可能出现 `Attach Listener`；如果启用了本地管理能力，还可能看到 `RMI TCP Accept-0`。这些是诊断/管理路径按需创建的线程，不应误判为所有最小 JVM 启动时都会固定拥有的线程

这一步实测把本篇的观察层次固定下来了：先区分 OS 线程、JavaThread 和 HotSpot 角色，再讨论它们为什么需要不同的调度与等待协议。

---

## 一、7 种 `ThreadType` 不是 7 个线程

### 1.1 先从角色而不是数量看线程

HotSpot 在 `os.hpp:487-495` 定义了线程类型枚举：

```cpp
// os.hpp:487-495
// enum ThreadType
vm_thread
cgc_thread
pgc_thread
java_thread
compiler_thread
watcher_thread
os_thread
```

这段枚举表达的是“线程承担什么职责”，不是 JVM 进程最终一定只有 7 个线程。

同一种角色可能有多个实例：

- 多个并发 GC 线程
- 多个并行 GC 线程
- 多个编译线程
- 大量业务 JavaThread

因此更准确的关系是：

```text
ThreadType 是角色分类
Thread 实例是这个角色的具体成员
```

### 1.2 谁在队伍里负责什么

#### `java_thread`：业务执行者

这是最接近用户的角色。

你的 `new Thread()` 最终会由 HotSpot 的 `JavaThread` 包装底层 pthread。它执行 Java 字节码、调用本地方法，也可能承载 JVM 内部某些服务线程。

业务线程数量通常最多，但它们不是 JVM 唯一重要的线程。

#### `compiler_thread`：把热点代码变成机器码

C1/C2 编译器线程从编译队列取任务，把解释执行阶段发现的热点方法编译成机器码。

它们的数量通常由 `CICompilerCount` 等参数和平台 ergonomics 推导。平台核数看错时，编译线程数量也可能跟着偏离。

#### `cgc_thread` 与 `pgc_thread`：两种 GC 工作角色

并发 GC 线程负责与业务线程并发推进的阶段；并行 GC 线程负责某些需要多个 GC 工作线程协作的阶段。

它们数量不同、调度压力不同，也不应该简单地和 JavaThread 放进同一个角色桶里。

#### `vm_thread`：全局 VM 操作的串行执行者

VMThread 的特殊性不在于它“也会执行任务”，而在于它经常执行需要统一协调、甚至需要全局静止语义的 VM 操作。

如果多个线程可以同时执行同一类 VM 操作，问题就会变成：

- 谁负责修改全局状态
- 谁负责保证操作顺序
- 两次 deoptimization 或 GC 请求如何互不踩踏
- 失败和取消由谁收尾

一个直觉方案是让每个请求线程自己执行自己的 VM 操作。

这会把串行化责任分散到每个调用点，调用点之间再用锁拼出顺序。复杂度会迅速扩散。

HotSpot 的选择是把需要统一调度的 VM 操作交给一个专门角色排队执行。单例 VMThread 的代价是吞吐受单线程限制，但它换来了清晰的串行边界。

所以 VMThread 不是“性能最快的线程”，而是“全局状态必须由谁统一推进”的答案。

#### `watcher_thread`：周期性检查者

WatcherThread 会定期醒来，推动一些周期性运行时服务。

它的关键价值不是处理某一个具体业务，而是让那些“不能永远等外部事件触发”的机制继续有机会运行。

如果周期性检查线程长期得不到调度，运行时的自适应逻辑就会出现延迟：该检查的状态不能及时检查，该触发的动作不能及时触发。

#### `os_thread`：未归入上述角色的线程

这是一个兜底类别，不应该被误解为“JVM 中不存在的线程”。它表示某些线程没有归入主要 HotSpot 角色体系。

### 1.3 为什么线程角色会影响 safepoint

线程角色不只是打印名称。

当 JVM 要进入 safepoint 时，业务线程、编译线程、GC 线程、VMThread、WatcherThread 的待遇并不完全相同。

最基本的角色关系是：

```text
需要被协调停下的线程
  → JavaThread、CompilerThread 等执行者

负责发起或推进协调的线程
  → VMThread、WatcherThread 等基础设施角色
```

如果连负责协调的线程也被当成普通执行者一起停住，就会出现一个循环：

- 谁发起暂停？已经被暂停
- 谁执行 VM 操作？也已经被暂停
- 谁负责恢复？同样没人运行

因此，读线程清单时不能只问“有几类”，还要问：

**这个角色是在被暂停的一侧，还是在负责让别人暂停的一侧？**

这里先立一个路标：

这一节最重要的不是背表格，而是建立“角色决定责任，责任决定暂停待遇”的关系。下一节再看这些角色如何被创建成真正的 pthread。

---

## 二、线程出生时，栈大小和退出方式就已经写进角色里了

### 2.1 `pthread_attr_t` 不是样板代码

线程创建的核心入口在 Linux 的 `os::create_thread()`，源码位于 `os_linux.cpp:938` 附近：

```cpp
// os_linux.cpp:938 起
bool os::create_thread(Thread* thread, ThreadType thr_type,
                       size_t req_stack_size) {
  pthread_attr_t attr;
  pthread_attr_init(&attr);
  pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
  pthread_attr_setguardsize(&attr, guard_size);
  ...
  pthread_attr_setstacksize(&attr, stack_size);
}
```

这段代码前面先回答了三个问题：

- 线程退出后谁负责回收它的 pthread 资源
- 线程需要多大的栈
- 栈边界如何配置保护空间

### 2.2 为什么 JVM 线程使用 detached

一个 joinable pthread 退出后，需要另一个线程调用 `pthread_join()` 回收其退出资源。

如果 JVM 的几十类内部线程都采用 joinable，就意味着线程退出管理会形成额外的等待关系：

- 谁负责 join
- 退出顺序如何保证
- VM 关闭时哪些线程必须先退
- 某个线程异常退出后谁负责收尾

JVM 选择 `PTHREAD_CREATE_DETACHED`，让线程退出时由系统自动回收相应 pthread 资源。

这不表示 JVM 不关心线程生命周期。

JavaThread、VMThread 等 HotSpot 对象仍然有自己的状态和清理流程；它只是不再用 pthread join 作为底层资源回收的基本协议。

### 2.3 栈大小为什么不能所有角色统一

上一篇已经讲过，线程栈不仅是一块可写内存，还带有 guard、yellow、red、reserved、shadow 等保护边界。

不同角色的调用深度和本地代码路径不同，因此默认栈大小也可能不同。OpenJDK 11u 的 x86 Linux 实现中，默认值在 `os_cpu/linux_x86/os_linux_x86.cpp:734` 附近，Java 线程与 Compiler 线程并不采用同一个默认尺度；Java 线程还可以通过 `-Xss` 影响栈大小。

如果所有线程都统一采用一个很小的栈：

- 编译器或 VM 内部较深的调用链更容易耗尽栈
- 异常和信号处理余量会被压缩

如果所有线程都统一采用一个很大的栈：

- 大量业务线程会预留更多地址空间
- 栈相关的虚拟内存开销和保护管理规模增大

所以线程角色在创建时就会影响资源边界。

### 2.4 两个特殊入口

JVM 还需要处理两类不是普通 `pthread_create` 逻辑的线程：

- `create_main_thread`：`JNI_CreateJavaVM` 进入时，当前已经存在的第一个线程
- `create_attached_thread`：native 线程通过 `JNI_AttachCurrentThread` 接入 JVM

尤其是 attached thread，它不是由 JVM 从零创建的。

JVM 需要把一个已经存在的 OS 线程纳入自己的线程体系，但不能简单地假设它拥有一套刚刚创建的 JVM 栈和优先级配置。

这也是为什么“创建一个 JVM 线程”和“把外部线程接入 JVM”是两个不同问题。

---

## 三、优先级不是“谁永远先跑”，而是“关键角色不能长期饿死”

### 3.1 Java priority 与 Linux nice 不是同一套刻度

Java 提供 `1` 到 `10` 的普通优先级以及 `CriticalPriority`；Linux 调度器使用 nice 值，通常范围是 `-20` 到 `19`，数值越小代表更高的调度权重倾向。

HotSpot 在 `os_linux.cpp:4691` 定义 Java 优先级到 nice 的映射：

```cpp
int os::java_to_os_priority[CriticalPriority + 1] = {
  19,
   4, 3, 2, 1,
   0,
  -1, -2, -3, -4,
  -5,
  -5
};
```

这里有两个必须纠正的误解。

第一，Java `MaxPriority` 映射到 nice `-5`，不是 `-10` 或 `-20`。

第二，这不是一一映射。`MaxPriority` 和 `CriticalPriority` 最终可能落到同一个 nice 值。

因此 Java 层的 11 个等级，被压缩成 Linux 可以表达的一组调度倾向。

### 3.2 nice 是权重，不是绝对先后

Linux CFS 不是看到 nice 小的线程就保证它每次先运行。

nice 会影响调度权重和 vruntime 增长速度。高权重线程在竞争 CPU 时更容易获得更多运行时间，但它仍然会受到：

- CPU 核数
- cgroup quota
- 其他线程负载
- 调度器状态

的影响。

所以更准确的说法是：

**HotSpot 调整 nice，是在表达“这个角色更重要，不能长期得不到调度”，而不是建立严格的先后顺序。**

### 3.3 为什么 WatcherThread 与 VMThread 需要特殊对待

源码中可以看到：

- WatcherThread 在 `thread.cpp:1385-1388` 附近以较高 Java 优先级设置
- VMThread 在 `vmThread.cpp:301-306` 附近直接设置 native priority
- 并发 GC 线程在 `concurrentGCThread.cpp:44` 附近按角色优先级处理

VMThread 绕过普通 Java priority 映射，是因为它需要一种不被 Java 优先级表限制的 native 调度表达。

但“VMThread 更高”也不是简单的越高越好。

WatcherThread 自己承担周期性推进责任。如果 VMThread 的调度优先级完全压过 WatcherThread，WatcherThread 的周期性行为和 profiling 语义也可能受到影响。

因此这里不是一条简单的排序表，而是一个调度权衡：

```text
关键推进者不能饿死
        │
        ├─ WatcherThread：周期性唤醒与检查
        ├─ VMThread：串行执行关键 VM 操作
        └─ GC/Compiler：推进回收与编译
```

### 3.4 失败方案：所有线程统一优先级

如果所有线程都用普通 Java 线程的同一优先级，表面上公平，实际却把关键角色和业务负载混在了一起。

在 CPU 紧张、容器 quota 较小或编译/GC 压力较高时，可能出现：

- WatcherThread 长时间得不到运行
- VM 操作排队却迟迟没有执行者
- 编译线程与业务线程竞争，热点代码迟迟不编译
- GC 后台阶段不能按计划推进

另一种失败方案是所有关键线程都直接使用最高 CriticalPriority。

这也不合理：系统必须保留层级，不同角色之间仍然需要竞争和让步；而且 HotSpot 对 CriticalPriority 的使用有角色约束，并不是一个可以随便给所有线程套上的万能开关。

所以优先级设计的核心不是“把关键线程全部调到最高”，而是：

**给关键推进者足够的调度机会，同时避免让一个角色压垮整个运行时。**

---

## 四、park：线程主动等待，为什么 permit 必须记住

### 4.1 `park` 不是简单调用条件变量

`LockSupport.park()` 表面上是让当前 Java 线程等待，底层需要解决一个更尖锐的并发问题：

```text
线程 A：unpark(B)
线程 B：稍后 park()
```

如果 `unpark` 只负责“现在把 B 从条件变量唤醒”，而 B 此时还没有睡下，信号就可能无处保存。

等 B 后面真正调用 `park()`，它会错误地睡下去。

所以 park/unpark 需要的不是一次性通知，而是一个与线程关联的、可被后续 park 消费的 permit。

### 4.2 PlatformEvent 的状态

POSIX 下，HotSpot 使用 `PlatformEvent` 保存 park/unpark 所需状态。核心字段位于 `os_posix.hpp:163-192`，状态转换实现位于 `os_posix.cpp:1996-2119`：

```cpp
class PlatformEvent : public CHeapObj<mtSynchronizer> {
 private:
  volatile int _event;
  volatile int _nParked;
  pthread_mutex_t _mutex[1];
  pthread_cond_t _cond[1];
  ...
};
```

OpenJDK 11u 的实现把 `_event` 作为受限范围的信号量使用，并允许 `-1 / 0 / 1` 三种状态。理解这段时，最重要的不是死记数字，而是理解它需要表达三种事实：

```text
没有可消费信号，也没有正在等待
        │
        ├─ permit 已经提前到达，等待者稍后直接消费
        │
        └─ 线程已经进入等待，需要条件变量协助阻塞
```

可以用简化状态图表达它的核心意图：

```text
中性状态
  ├─ unpark 先到 → 记录 permit
  │                  ↓
  │             后续 park 直接返回
  │
  └─ park 先到 → 标记等待并进入 condvar
                    ↓
                后续 unpark 唤醒
```

注意：具体 `_event` 数值与内部 CAS/锁顺序必须以 OpenJDK 11u 的 `park()`、`unpark()` 实现为准；这里的状态图用于说明“信号必须可记忆”的设计，不把数字本身当成 Java API 语义。

### 4.3 为什么两态布尔值不够

假设只有一个布尔值 `parked`：

- `false`：线程没有 park
- `true`：线程已经 park

那么 A 在 B park 前调用 unpark 时，系统只能看到 `parked == false`。

如果它什么也不记录，信号丢失。

如果它把 `parked` 直接改成 `true`，又会把“已经有 permit”和“线程已经睡眠”混为一谈。

后续 B 调 park 时无法判断自己应该立即返回，还是应该真正进入等待。

因此状态必须覆盖交错顺序：

```text
unpark → park
park → unpark
```

这就是 PlatformEvent 设计的核心。

### 4.4 mutex、condvar 与 `_nParked`

状态变量记录 permit 协议，原子操作负责处理 `_event` 的快速状态转换，mutex 和 condition variable 则在确实需要阻塞或唤醒时参与协作。

`_nParked` 帮助 HotSpot表达“关联线程当前是否已经进入阻塞状态”。

这里不要把 mutex/condvar 理解成“所有唤醒都必须经过同一个系统调用”。OpenJDK 11u 的 `park()` 会先原子地递减 `_event`：如果原值为 `1`，直接消费 permit 返回；如果原值为 `0`，才获取 mutex、增加 `_nParked` 并在 condvar 上等待。`unpark()` 则先原子地把 `_event` 置为 `1`，只有发现原值为负、确实存在等待者时，才获取 mutex 并发出通知。

真正关键的是：

- 快速路径先检查并更新 permit 状态
- 确认没有可消费 permit 后，才进入等待
- 只有存在实际等待者时，才需要通过 condvar 唤醒

否则就会出现经典的检查—睡眠竞态：

```text
B 检查：没有信号
A 发信号
B 进入睡眠
```

正确协议必须让 A 的信号和 B 的入睡在同一套同步保护下协调，保证信号不会在检查与等待之间丢掉。

### 4.5 padding 与 PlatformParker：优化不能抢走主线

`PlatformEvent` 结构中存在 cache padding，但不能简单说成“`_event` 和 `_nParked` 之间有 64B padding”。源码布局里 padding 位于 mutex/condition 相关区域附近，重点是降低高频同步字段与锁对象发生不必要的 cache line 争用。

这是性能细节，不是 park 正确性的前提。

同样，`PlatformParker` 的两个 condition variable 主要服务不同时间语义：

- `parkNanos` 从相对时长换算绝对截止时间
- `parkUntil` 已经提供绝对截止时间

这类设计可以减少某条路径上的时间换算，但不能改变 park/unpark 的核心协议：

**时间到了可以返回，permit 到了也可以返回；无论哪一种，等待状态都必须正确。**

### 4.6 失败方案：先 park，再检查信号

一个错误实现可能这样写：

1. 线程直接进入条件变量等待
2. 醒来后再检查有没有 unpark

这会把“信号先到”的情况彻底弄丢：

- A 先 unpark
- B 因为没有先检查状态，直接睡下去
- A 的信号已经结束
- B 只能等下一次事件，甚至一直等下去

所以并发等待里有一条不能省的规则：

**先在同步保护下检查并消费状态，再决定是否阻塞。**

---

## 五、suspend：外部强制暂停为什么必须有中间态

### 5.1 park 与 suspend 不是同一种等待

`park` 是线程自己决定等待。

线程知道自己会停在那里，也能在不持有关键资源的前提下进入等待。

`suspend` 则是另一个世界：

- 外部线程发出暂停请求
- 目标线程可能正在执行任意代码
- 目标线程可能还没有看到请求
- 目标线程甚至可能持有锁

所以 suspend 不能简单实现成“把一个 running 标志改成 suspended”。

请求发出和目标真正停下之间，存在一个必须被表达的中间过程。

### 5.2 四态协议

HotSpot 在 `os.hpp:981-1000` 定义了 `SuspendResume::State`：

```cpp
enum State {
  SR_RUNNING,
  SR_SUSPEND_REQUEST,
  SR_SUSPENDED,
  SR_WAKEUP_REQUEST
};
```

可以把它读成一条状态机：

```text
SR_RUNNING
    │ 外部发出 suspend
    ▼
SR_SUSPEND_REQUEST
    │ 目标线程在合适的检查点响应
    ▼
SR_SUSPENDED
    │ 外部发出 resume
    ▼
SR_WAKEUP_REQUEST
    │ 目标线程完成恢复
    ▼
SR_RUNNING
```

为什么必须有 `SR_SUSPEND_REQUEST`？

因为外部请求发出时，目标线程还可能正在运行。它可能：

- 尚未响应外部 suspend/resume 信号
- 正在执行一段尚未完成上下文保存的路径
- 需要先完成某些状态发布
- 正在处理另一个线程控制请求

在 OpenJDK 11u Linux 实现中，目标线程收到专用信号后，信号处理路径保存上下文并尝试把状态切到 `SR_SUSPENDED`；外部 `do_suspend()` 通过信号量等待这个确认，超时则取消请求或等待已经完成的暂停。见 `os_linux.cpp:4826-4857`、`:4925-4961`。

如果直接把状态写成 `SR_SUSPENDED`，外部控制者会误以为线程已经停下，但目标线程实际上还在执行。

中间态把“请求已经发出”和“线程真的停止”分开了。

### 5.3 为什么强制 suspend 有死锁风险

考虑下面的交错：

```text
线程 A：持有 mutex M
线程 B：请求 suspend(A)
线程 A：被强制停下
线程 B：继续执行，需要 mutex M
线程 B：永久等待
```

A 并没有主动决定在安全位置释放 M，它只是被外部力量停住了。

这就是强制 suspend 与 park 的根本差异：

| | suspend | park |
|---|---|---|
| 发起者 | 外部控制者 | 线程自己或协作方 |
| 目标线程是否知道 | 请求可能先于目标响应 | 线程主动进入等待 |
| 是否可能停在持锁区间 | 可能 | 协议设计上应避免 |
| 核心风险 | 状态不一致、锁依赖、恢复失败 | 信号协议和状态竞态 |

因此不能把 park 写成“天然没有任何死锁风险”。如果 park 的调用方自己持锁等待，业务代码照样可以死锁；这里真正不同的是，park 不会像外部强制 suspend 那样在目标线程完全不知情时切断它的执行。

更准确的结论是：

**park 的协议允许线程主动选择等待位置；suspend 则可能在调用者不知情时切断它正在持有的同步资源。**

### 5.4 请求失败与恢复

强制暂停还需要处理另一个现实问题：目标线程可能迟迟不响应。

如果外部控制者无限等待，就可能把一个线程的问题扩大成整个 VM 的控制面阻塞。

因此 suspend/resume 协议必须有：

- 请求状态
- 目标响应状态
- 恢复请求状态
- 超时或失败后的收尾路径

至于某个具体 OpenJDK 11u 更新版本如何等待、何时超时、由哪个线程推动回退，必须以 `SuspendResume` 的实现与调用方源码为准，不能只凭状态枚举推导完整时序。

这里要特别区分三种暂停：

```text
park       → 线程主动等待
safepoint  → JVM 协调线程在检查点停下
suspend    → 外部控制者请求目标线程暂停
```

它们都可能让线程暂时不运行，但触发者、协议、锁风险和恢复条件都不同。

---

## 六、收网：线程角色、调度、等待和暂停是一套控制系统

现在回到开头的 `top -H`。

那些线程并不是一堆名字，而是一套控制系统中的不同角色：

```text
业务请求到来
    │
    ├─ JavaThread 执行业务
    ├─ 编译请求进入 CompilerThread
    ├─ GC 请求交给 GC 线程推进
    ├─ 需要全局协调的操作进入 VMThread
    └─ 周期性检查由 WatcherThread 继续推动

线程需要等待
    └─ park/unpark：permit 先记录，等待再消费

外部需要暂停线程
    └─ suspend/resume：request → suspended → wakeup → running
```

这篇真正讲清楚的不是 7 个枚举值，而是四条设计原则：

1. **角色先于数量。** 线程数量会变，但职责边界必须清楚。
2. **优先级保护关键推进者。** nice 只能表达调度倾向，不是绝对顺序。
3. **等待必须记住状态。** `unpark` 先到时，后续 `park` 仍要能正确消费 permit。
4. **强制暂停必须承认风险。** 请求不等于停下，停下可能切断锁和资源关系。

最容易记住的三句话是：

- VMThread 的价值是把需要统一协调的操作收进一个清晰的串行边界
- PlatformEvent 的价值是把“先通知、后等待”的并发交错变成不会丢失的状态协议
- SuspendResume 的价值不是让强制暂停变安全，而是把请求、真正暂停和恢复过程显式化

下一篇继续追问：

**当 JVM 需要让多个线程停在已知位置时，为什么一个 SIGSEGV 信号可以同时承担栈溢出、安全点轮询、隐式空指针和真正崩溃等完全不同的任务？**

> → [04-signals-and-safepoint.md](04-signals-and-safepoint.md)：JVM 如何分发同一个 SIGSEGV
