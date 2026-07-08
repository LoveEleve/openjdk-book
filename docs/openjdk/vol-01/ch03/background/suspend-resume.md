# 前置概念：`_SR_lock` —— 线程自我挂起的信号锁

## 问题

JVM 需要在运行时暂停某个 Java 线程——比如 JVMTI agent 调用 `SuspendThread`、或 `Thread.suspend()`（已废弃）。你不能直接杀掉 OS 线程——线程可能正在持锁、正在栈上分配对象、正在 GC 安全区域内。必须让它**自己**在下一个安全点停下来。

`_SR_lock`（Suspend/Resume lock）和 `_suspend_flags` 就是这个协作式暂停机制的核心——它不是抢占式的"强杀"，而是"你下次路过安全点时，请停一下"。

## 字段定义

每个 `Thread` 对象上有一个 `Monitor* _SR_lock`（`thread.hpp:256`），一个 `volatile uint32_t _suspend_flags`（`thread.hpp:275`）。构造函数中初始化（`thread.cpp:273`）：

```cpp
_SR_lock = new Monitor(Mutex::suspend_resume, "SR_lock", true,
                       Monitor::_safepoint_check_sometimes);
_suspend_flags = 0;
```

`_suspend_flags` 的每一个 bit 是一个独立的状态标记。和本文相关的三个核心标记（`thread.hpp:258-268`）：

```cpp
enum SuspendFlags {
  _external_suspend  = 0x20000000U,  // 有人要求我暂停
  _ext_suspended     = 0x40000000U,  // 我已经停了
  _deopt_suspend     = 0x10000000U,  // deopt 要求我暂停
```

**deopt 是什么？** JIT 编译器在运行时把热点方法编译为机器码。编译基于某些假设——比如"类 A 没有子类"、"这个虚方法调用永远到同一个目标"。当这些假设后来被打破（比如新加载了一个类 A 的子类、或实现了某个接口改变了虚方法分派），已编译的机器码不再正确。JVM 需要把所有正在执行这段错误机器码的线程停下来，把它们的栈帧从编译帧回退到解释器帧——这个过程叫**反优化（deoptimization）**。

`_deopt_suspend` 就是为反优化服务的——它标记"因为 deopt 需要，请你暂停"。机制和 `_external_suspend` 一样：设置标记 → 目标线程在安全点检查 → `java_suspend_self()` → wait。
};
```

## 暂停和恢复的三步流程

### 第一步：设置标记——"请你暂停"

暂停请求者（通常是另一个线程，如 `JVMTI SuspendThread`）调用目标线程的 `set_external_suspend()`（`thread.inline.hpp:118-137`）：

```cpp
inline void JavaThread::set_external_suspend() {
  set_suspend_flag(_external_suspend);   // 原子设置标记位
}
```

`set_suspend_flag` 用 CAS 原子操作修改 `_suspend_flags`：

```cpp
inline void Thread::set_suspend_flag(SuspendFlags f) {
  uint32_t flags;
  do {
    flags = _suspend_flags;
  }
  while (Atomic::cmpxchg((flags | f), &_suspend_flags, flags) != flags);
}
```

CAS 循环保证即使多个请求者同时设置不同的标记位（如 `_external_suspend` 和 `_deopt_suspend`），彼此不会覆盖。

设置完标记后，请求者调用 `java_suspend()`（`thread.cpp:2377`）——它持有 `_SR_lock`，确认标记已设置，然后通过 VMThread 触发 safepoint，让目标线程在安全点被"抓"到。

### 第二步：自我挂起——`java_suspend_self()`

目标线程不会立刻停。它在下次路过安全点时，检查 `_suspend_flags`。入口在 `handle_special_runtime_exit_condition()`（`thread.cpp:2267`）：

```cpp
void JavaThread::handle_special_runtime_exit_condition(bool check_asyncs) {
  if (is_external_suspend_with_lock()) {
    java_suspend_self();              // <-- 自我挂起
  }
}
```

安全点检查发生在线程状态转换时——从 JNI 返回、从解释器返回、进入 safepoint 等场景。每种类别转换都有对应的检查点。

`java_suspend_self()`（`thread.cpp:2417`）是核心：

```cpp
int JavaThread::java_suspend_self() {
  if (is_exiting()) { clear_external_suspend(); return 0; }

  MutexLockerEx ml(SR_lock(), Mutex::_no_safepoint_check_flag);
```

持 `_SR_lock` 进入。这把锁保护下面的标志位读写和 wait/notify 的原子性。

```cpp
  while (is_external_suspend()) {
```

检查 `_external_suspend` 标记。只要这个标记还在（还没被 `java_resume` 清除），就继续等待。

```cpp
    this->set_ext_suspended();
```

设置 `_ext_suspended` 标记——声明"我已经挂起了"。这行执行后，`resume` 方可以通过 `is_ext_suspended()` 确认目标线程已经停在 `wait` 中。

```cpp
    while (is_ext_suspended()) {
      this->SR_lock()->wait(Mutex::_no_safepoint_check_flag);
```

在 `_SR_lock` 上 `wait`——原子释放锁并进入休眠。当 `java_resume()` 清除 `_ext_suspended` 并通过 `notify_all()` 唤醒此线程时，`wait` 返回，重新竞争 `_SR_lock`，继续循环。

```cpp
      // wait 被唤醒 → 重查 is_ext_suspended()
      // 如果 resume 已清除 → 退出内层循环
      // 如果又被设置了 → 继续 wait
    }
  }
}
```

外层 `while` 检查 `is_external_suspend()`——如果被唤醒时已经没有新的暂停请求，退出循环，返回。

### 第三步：恢复——`java_resume()`

恢复方持有 `Threads_lock`（通过 `MutexLocker ml(Threads_lock)` 进入），调用 `java_resume()`（`thread.cpp:2584`）：

```cpp
void JavaThread::java_resume() {
  assert_locked_or_safepoint(Threads_lock);

  MutexLockerEx ml(SR_lock(), Mutex::_no_safepoint_check_flag);
```

持 `_SR_lock` 做两件事——先清标记，再唤醒。

```cpp
  clear_external_suspend();
```

原子清掉 `_external_suspend` 标记——告诉目标线程"不再要求你暂停"。

```cpp
  if (is_ext_suspended()) {
    clear_ext_suspended();
    SR_lock()->notify_all();
  }
```

如果目标线程已经挂起（`_ext_suspended` 为 true），清掉 `_ext_suspended` 标记，然后 `notify_all()` 唤醒在 `SR_lock()->wait()` 中休眠的线程。

## 为什么不用简单的循环检查

`_suspend_flags` 是 volatile——暂停方设置标记后，目标线程可以轮询它。但轮询的问题：
- 目标线程可能在做长时间计算，不检查标记
- 即时检查到了，如何高效等待？spin-wait 浪费 CPU

所以设计分两层：
- **标记位**：暂存"有人要求暂停"的信息，目标线程在固定的安全点检查
- **`_SR_lock`**：wait/notify 的同步点——线程检查到标记后，在锁上调 `wait`，CPU 让给其他线程。恢复方清标记后 `notify_all`，休眠的线程被精准唤醒

## 信号路径——`SR_signum`（信号 12）

`_SR_lock` 只处理目标线程已经"到达安全点"后的挂起逻辑。但如果目标线程**不在安全点**——比如在 JNI 代码中运行，或正在执行纯计算循环——它可能长时间不检查 `_suspend_flags`。这时需要信号的强制打断：

1. 发起方调用 `os::SuspendedThreadTask::internal_do_task()`（`os_linux.cpp:5899`）
2. 内部调 `do_suspend()` → `pthread_kill(pid, SR_signum)` 向目标线程发信号 12
3. 目标线程的信号处理器 `SR_handler` 被中断执行
4. `SR_handler` 保存寄存器上下文（ucontext），设置挂起状态，进入 `sigsuspend` 等待
5. 发起方完成任务后调 `do_resume()` → 再发一次信号 12
6. `SR_handler` 被再次触发，退出 `sigsuspend`，恢复上下文继续执行

信号路径用于 `GetCallTrace`（获取线程栈轨迹）、JVMTI 的 `GetThreadState` 等需要**立即**暂停目标线程的场景。和 `_SR_lock` 路径的区别：

| | `_SR_lock` 路径 | `SR_signum` 路径 |
|--|:--:|:--:|
| 适用场景 | 目标线程在安全点附近 | 目标线程在 JNI/计算循环中 |
| 暂停方 | 目标线程自己 call `java_suspend_self` | 发起方 `pthread_kill` + 信号处理器强制中断 |
| 唤醒方式 | `notify_all` 唤醒 `wait` | 再次 `pthread_kill` 让信号处理器退出循环 |

`_SR_lock` 的构造函数中 `safepoint_check_sometimes` 表示这把锁有时在 safepoint 中被持有——挂起的线程本身就在 safepoint 中，允许这一特殊场景。
