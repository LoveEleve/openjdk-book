# 前置概念：`ThreadSafepointState` —— 线程安全点状态机

## 问题

GC 触发 safepoint 时，VMThread 需要让所有 Java 线程停下来。但线程可能在不同状态——有的在解释器中执行字节码、有的在执行 JIT 编译的机器码、有的在 JNI native 代码中、有的在 VM 内部的某个锁上阻塞。

VMThread 不能暴力杀掉一个线程——它必须知道每个线程此刻在干什么、是否已经到达安全点、是否需要通知它"你该停了"。

`_safepoint_state` 就是每个线程上的"安全点状态机"——VMThread 通过它判断线程的状态，线程通过它参与安全点协议。

## 字段定义

`ThreadSafepointState` 对象在 JavaThread 构造时通过 `ThreadSafepointState::create(this)` 在 C-Heap 上分配，挂在 `_safepoint_state` 字段上（`thread.hpp:1040`）。五个字段：

```cpp
class ThreadSafepointState: public CHeapObj<mtThread> {
  volatile bool _at_poll_safepoint;   // 是否在 polling page 触发的安全点中
  bool          _has_called_back;     // VMThread 回调后标记
  JavaThread*   _thread;             // 所属线程
  volatile suspend_type _type;        // 核心：当前安全点状态
  JavaThreadState _orig_thread_state; // 安全点开始时的原始线程状态
};
```

核心是 `_type`——它只有三个值：

| 值 | 含义 |
|---|------|
| `_running` (0) | 线程尚未到达安全点，VMThread 需要继续等 |
| `_at_safepoint` (1) | 线程已经在安全点——因为正阻塞或已在 native 中 |
| `_call_back` (2) | 线程在 VM 代码中，执行完当前操作后主动回调 |

## VMThread 视角——怎么让所有线程停下

安全点开始时（`SafepointSynchronize::begin()`），VMThread 获取 `Threads_lock` 和 `Safepoint_lock`，然后遍历所有 JavaThread。对每个线程调用 `examine_state_of_thread()` 判断它在什么状态：

```
对每个 JavaThread：
  ├─ 已经被外部 suspend（ext_suspended）→ roll_forward(_at_safepoint)  ← 已停
  ├─ 在 native 中且栈可遍历（_thread_in_native）→ roll_forward(_at_safepoint)  ← 不在 Java 堆上操作
  ├─ 已被阻塞（_thread_blocked）→ roll_forward(_at_safepoint)  ← 没法动
  ├─ 在 VM 中（_thread_in_vm）→ roll_forward(_call_back)        ← 执行完当前操作后主动停
  └─ 在 Java 中（_thread_in_Java）→ 保持 _running               ← 等它自己遇到 polling 指令
```

`roll_forward(_at_safepoint)` 把线程的 `_type` 设为 `_at_safepoint`，然后调用 `signal_thread_at_safepoint()`——递减全局 `_waiting_to_block` 计数器。VMThread 在循环中等待这个计数器归零。归零时，所有线程要么已经在安全点（`_at_safepoint`），要么已经承诺回调（`_call_back`）。

`roll_forward(_call_back)` 把 `_type` 设为 `_call_back`，重置 `_has_called_back = false`。线程在 VM 代码中执行完当前操作后，会检测这个状态并主动调用 `SafepointSynchronize::block()` 把自己挂起。

## JavaThread 视角——怎么响应"你该停了"

线程在 Java 代码中执行时（`_thread_in_Java`），JIT 编译器在生成机器码时插入 polling 指令——访问一个特殊的 polling page。安全点开始时，VMThread 把 polling page 设为不可读（或设置线程本地的 polling bit）。线程执行到 polling 指令时触发 page fault → `handle_polling_page_exception()` → `SafepointMechanism::block_if_requested()` → `SafepointSynchronize::block()` → 线程把自己挂起在 `Threads_lock` 上等待安全点完成。

线程从 JNI native 返回时，在 `check_special_condition_for_native_trans()` 中也会检查 polling bit，如果被武装就进入 block。

解释器在每两个字节码之间也检查 safepoint。

## 安全点结束——重启所有线程

安全点操作完成（GC 完成标记/压缩），VMThread 调用 `SafepointSynchronize::end()`。遍历所有线程，对每个调用 `restart()`——把 `_type` 设回 `_running`，恢复 polling page（改为可读/解除武装），释放 `Threads_lock`。所有阻塞在锁上的线程重新竞争锁，拿到后继续执行。

## 两种 polling 模式

JDK 11 开始的线程本地 polling（`-XX:+ThreadLocalHandshakes`）：

- **全局 polling page**（已废弃）：VMThread 操作一整页内存的读写权限——所有线程共享同一页，安全点开始时设为不可读，结束时恢复。简单但有 scalability 问题。
- **线程本地 polling**：每个 `JavaThread` 有自己的 `_polling_page` 字段。安全点开始时，VMThread 遍历所有线程把各自的 polling 值设为 armed 值，结束时逐个 disarm。线程不需要访问共享页，cache 友好。

两种模式在 `SafepointMechanism` 的选择下发——上层 `block_if_requested()` 逻辑不感知模式差异。
