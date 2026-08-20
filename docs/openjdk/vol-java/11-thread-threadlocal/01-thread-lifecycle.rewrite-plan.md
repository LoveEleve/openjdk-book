# 11-thread-threadlocal/01 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `java.lang.Thread`。本文聚焦 `start`/`run`、`join`、`sleep`、`interrupt`、`interrupted`/`isInterrupted` 与线程状态视图；底层 OS 线程创建只解释到 Java/native 边界，完整 HotSpot 调度与 JVM TI 细节不在本文展开。
> 目标：把“线程生命周期与调度原语”改写成一篇围绕“一个 Thread 对象什么时候才真正变成可调度线程，以及为什么 sleep/join/interrupt 看起来都像‘等待’，语义却完全不同”的机制文章。

## 1. 读者困惑

- `new Thread(...).run()` 和 `start()` 到底差在哪，为什么前者不算启动线程？
- 为什么一个 `Thread` 只能 `start()` 一次？
- `join()` 为什么不会像 while 轮询那样白白烧 CPU？
- `sleep()`、`wait()`、`join()` 都会让线程停下来，它们到底谁释放锁、谁不释放锁？
- `interrupt()` 为什么经常被说成“不是杀线程”，那它到底做了什么？
- 为什么有 `interrupted()` 和 `isInterrupted()` 两个方法，一个还会清标志？
- `RUNNABLE`、`BLOCKED`、`WAITING`、`TIMED_WAITING` 这些状态和源码里的 `threadStatus` 是什么关系？

## 2. 一句话顿悟

**Thread 的核心分界线是：`new Thread()` 只得到一个 Java 对象，`start()` 才把它交给 JVM 去创建真实线程；而 sleep、join、interrupt 这些“线程控制”API，本质上都不是强制调度命令，而是在 Java 对象、监视器等待、native 线程状态和中断标志之间建立协作协议。**

## 3. 旧稿优点与问题

### 保留

- 已覆盖 `start0` native 边界、`join(long)` 的 `while (isAlive()) wait(0)`、`interrupt` 设置标志与阻塞唤醒、`threadStatus` 到 `State` 的映射。
- 已抓到常见面试坑：`run` 只是普通方法、sleep 不释放锁、中断是协作式。
- 已把 `interrupted()` / `isInterrupted()` 的清标志差异讲出来。

### 必须重写

- 旧稿仍偏“面试题串讲”，需要先建立一个统一主问题：Thread 对象怎样从普通对象变成真实线程，又怎样与等待/中断状态交互。
- `sleep`/`join`/`interrupt` 应放在“等待语义为什么不同”这一主线上，不宜各自独立背定义。
- `join` 需要强调它为什么选 wait/notify 而不是轮询，并回扣线程死亡事件。
- `interrupt` 需要讲成“请求 + 协作响应”协议，而不是功能清单。
- 线程状态部分要服务于前文动作链，别把 `JVMTI` 位标志讲成孤立表格。

## 4. 理解路径

### 第一节：从“为什么直接调 run 不会启动线程”开场

用最常见误用开场：`new Thread(task).run()` 代码确实执行了，但没有并发。指出读者真正卡住的问题不是“语法”，而是“一个 Thread 对象什么时候才背后绑定真实线程”。

### 第二节：`start()` 为什么是分界线——对象、簿记与 native 线程创建

证据：
- `Thread.java:780`：`start()`
- `Thread.java:812`：`start0()`
- `Thread.java:827`：`run()`
- `Thread.java:837`：`exit()`

主线：
- `start()` 先做对象级校验和线程组簿记，再跨到 native `start0()`。
- `run()` 只是回调目标方法，本身不创建线程。
- `threadStatus != 0` 保证只能启动一次；否则抛 `IllegalThreadStateException`。
- 这解释了为什么真正的线程栈和调度资格在 `start()` 时才出现，而不是在 `new Thread()` 时出现。

### 第三节：为什么“等待”不能混成一个词——sleep、join、wait 各自站在哪条边界上

证据：
- `Thread.java:295`：`sleep(long)`
- `Thread.java:1289`：`join(long)`
- 按需回引 Object.wait，但本文主证据仍以 Thread 侧为主

主线：
- `sleep` 是线程主动暂停一段时间，不释放持有的监视器。
- `join` 是一个线程等待另一个线程死亡事件，本质是 `while (isAlive()) wait(0)`。
- `wait` 则是对象监视器协议的一部分，和“等另一个线程结束”不是同一问题。
- 让读者先按“等时间 / 等另一个线程结束 / 等对象条件”三类区分，不再把它们都叫“暂停”。

### 第四节：`join()` 为什么用 wait/notify，而不是 while 轮询

证据：
- `Thread.java:1289-1300`：`join(long)`
- `Thread.java:1340`：带 nanos 的 `join`
- `Thread.java:837`：`exit()` 作为线程死亡路径证据入口

主线：
- 线程结束是一个事件，不适合让等待者忙等检查。
- `join` 用 `wait` 挂起等待者，被唤醒后再检查 `isAlive()`，实现低 CPU 开销等待。
- 超时版 join 依赖时间差值继续等待剩余时间。
- 重点不是记住 `wait(0)`，而是理解“线程死亡 → 唤醒等待 join 的线程”这条事件链。

### 第五节：`interrupt()` 为什么不是 kill ——它只是立标志并请求协作退出

证据：
- `Thread.java:979`：`interrupt()`
- `Thread.java:1015`：`interrupted()`
- `Thread.java:1032`：`isInterrupted()`

主线：
- `interrupt()` 首先设置中断标志；如果目标线程阻塞在可响应中断的点上，则进一步触发唤醒或异常。
- 它不是强制终止线程；线程是否退出取决于代码是否检查标志、是否把 `InterruptedException` 往上抛或恢复标志。
- 解释静态 `interrupted()` 为什么会清标志，而实例 `isInterrupted()` 只是观察。

### 第六节：线程状态为什么是“视图”，不是简单脚本枚举

证据：
- `Thread.java` 中 `threadStatus` 字段位置需在重写时补精确锚点
- `Thread.java` 中 `getState()` 位置需补精确锚点
- `VM.toThreadState` 的精确锚点若继续使用，需补读源码后落准

主线：
- `NEW`、`RUNNABLE`、`BLOCKED`、`WAITING`、`TIMED_WAITING`、`TERMINATED` 是对底层位状态的一层 Java 视图。
- 它们要回扣前文动作：`start` 后从 NEW 离开，`join`/`wait` 进入 WAITING，`sleep` 进入 TIMED_WAITING，锁竞争会看到 BLOCKED。
- 重点不是背枚举，而是知道这些状态是对“当前正在等什么”的粗粒度描述。

### 第七节：收网与下一篇钩子

- 收束为三条主线：启动分界线、等待语义分流、中断协作协议。
- 把 Thread 对象和 ThreadLocal 链起来：既然线程对象已经存在并长期驻留，线程私有数据为什么要挂在它身上。

## 5. 失败方案清单

1. 直接调用 `run()`，却期待获得新线程和并发执行。
2. 对同一个 `Thread` 对象重复调用 `start()`。
3. 用 `sleep()` 代替 `wait()`，还期待它能释放锁让别的线程推进。
4. 用 while 轮询 `isAlive()` 实现等待线程结束。
5. 把 `interrupt()` 当作强制杀线程命令。
6. 在捕获 `InterruptedException` 后直接吞掉，不恢复中断标志也不退出。
7. 把线程状态当成一条绝对精确的调度脚本，而不是当前等待原因的视图。

## 6. 误解清单

1. `new Thread()` 时底层 OS 线程就已经创建好了。
2. `run()` 和 `start()` 只是两种写法，没有本质差异。
3. `sleep()` 会像 `wait()` 一样释放监视器锁。
4. `join()` 是 while 死循环轮询线程是否结束。
5. `interrupt()` 一定会让目标线程立刻退出。
6. `interrupted()` 和 `isInterrupted()` 只是静态/实例写法不同。
7. `RUNNABLE` 一定表示线程此刻正在占用 CPU 执行字节码。

## 7. 证据清单

- `Thread.java:295`：`sleep(long)`
- `Thread.java:780`：`start()`
- `Thread.java:812`：`start0()`
- `Thread.java:827`：`run()`
- `Thread.java:837`：`exit()`
- `Thread.java:979`：`interrupt()`
- `Thread.java:1015`：`interrupted()`
- `Thread.java:1032`：`isInterrupted()`
- `Thread.java:1289`：`join(long)`
- `Thread.java:1340`：`join(long, int)`
- `Thread.java` 中 `threadStatus`/`getState` 与 `VM.toThreadState`：重写时补精确锚点

## 8. 版本与边界

- 基于 JDK 11。
- 本文从 Java 层解释线程生命周期边界，不展开完整 HotSpot JavaThread / OSThread 创建实现。
- `sleep`、`interrupt` 等 API 的最终唤醒细节会受平台和阻塞点类型影响，正文必须区分 Java 契约与当前实现。
- 线程状态是 Java 层视图，不等于操作系统调度器全部内部状态。
- `wait` 的完整监视器协议不在本文展开，只在和 `sleep`/`join` 对照时点到为止。

## 9. 删除代码测试与最终验收标准

- 删除代码块后，读者仍能复述“Thread 对象怎样在 `start()` 时变成真实线程 → `run()` 为什么不启动线程 → sleep/join/wait 各在等什么 → join 为什么用 wait/notify → interrupt 为什么是协作请求 → 状态枚举如何回扣这些动作”。
- 必须把 `start` 和 `run` 的分界线讲透。
- 必须把 `join` 讲成事件等待，不是轮询技巧。
- 必须把中断讲成‘设置标志 + 阻塞点响应 + 代码协作退出’协议。
- 结尾要自然引到 `02-threadlocal.md`。
