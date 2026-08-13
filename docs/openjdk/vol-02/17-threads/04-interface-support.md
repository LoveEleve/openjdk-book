# 04. 线程从 Java 进入 VM——这一瞬间怎么保证安全?— interfaceSupport

> **前置依赖**:[17-threads/02 — JavaThread 状态机](openjdk/vol-02/17-threads/02-javathread-state.md):ThreadStateTransition 的转换三拍在这里被 RAII 类套用;[17-threads/03 — Thread-SMR](openjdk/vol-02/17-threads/03-thread-smr-handshake.md):ThreadInVMForHandshake 是 03 篇 Handshake 的执行上下文;[01-os/04 — 信号与安全点](openjdk/vol-02/01-os/04-signals-and-safepoint.md):safepoint 检查点的消费者
> → **后续**:域 18 Safepoint(safepoint 怎么叫所有线程停住)
> 关联域: 17-threads(线程)、18-safepoint、27-jni(JNI 状态转换)、01-os(同步)

## 每一次进出 VM,都要付"状态转换税"

线程执行 `new Object()` 或 `synchronized` 或 JNI 调用,都会从 Java 代码进到 VM 内部再出来——每次进出都要改 `_thread_state`、过序列化、查 safepoint(02 篇的三拍)。漏一次: 线程停在错误状态,GC 可能扫到一半的栈,直接崩溃。但 JVM 里没有 `finally`——保证"漏不掉"靠的是 RAII: 一组在构造时进 VM、析构时出 VM 的守卫类,全部定义在 `interfaceSupport.inline.hpp`。这一篇是 17 域的收官篇: 守卫家族各是什么、被挂起时线程怎么"自愿停下"、以及这些守卫在哪些转换点站岗。

## 1. 守卫家族: 一进一出,构造析构

### 进 VM 的两个入口

从 Java 代码进 VM 与从 native 代码回 VM,是两个不同的类(interfaceSupport.inline.hpp:224-274,截取核心,逐字):

```cpp
// interfaceSupport.inline.hpp:224-274(截取核心,逐字)
class ThreadInVMfromJava : public ThreadStateTransition {
 public:
  ThreadInVMfromJava(JavaThread* thread) : ThreadStateTransition(thread) {
    trans_from_java(_thread_in_vm);
  }
  ~ThreadInVMfromJava()  {
    if (_thread->stack_yellow_reserved_zone_disabled()) {
      _thread->enable_stack_yellow_reserved_zone();
    }
    trans(_thread_in_vm, _thread_in_Java);
    // Check for pending. async. exceptions or suspends.
    if (_thread->has_special_runtime_exit_condition()) _thread->handle_special_runtime_exit_condition();
  }
};


class ThreadInVMfromNative : public ThreadStateTransition {
 public:
  ThreadInVMfromNative(JavaThread* thread) : ThreadStateTransition(thread) {
    trans_from_native(_thread_in_vm);
  }
  ~ThreadInVMfromNative() {
    trans_and_fence(_thread_in_vm, _thread_in_native);
  }
};
```

- **`ThreadInVMfromJava`**(:224-237): 构造用 `trans_from_java`(02 篇讲过: Java→VM 不阻塞、直接写状态,:227);析构做三件事——恢复黄页栈保护区(`stack_yellow_reserved_zone`,:230-232)、`trans` 回 Java(:233)、**检查特殊退出条件**(:235,异步异常/挂起/取消 deopt 都在这时处理)。注意它用的不是 trans_and_fence 而是 trans——从 Java 回 Java 的路径安全点语义已在 02 篇讲过;
- **`ThreadInVMfromNative`**(:266-274): 从 JNI native 代码回 VM 用 `trans_from_native`(带 safepoint 检查,:269),析构 `trans_and_fence` 回 native(:272)。

### 出 VM 的两个出口

VM→native 的守卫是 **`ThreadToNativeFromVM`**(:277-294,截取核心,逐字)——注意流传的类名 "ThreadInNativeFromVM" 在 jdk11u 不存在,方向搞反了:

```cpp
// interfaceSupport.inline.hpp:277-294(截取核心,逐字)
class ThreadToNativeFromVM : public ThreadStateTransition {
 public:
  ThreadToNativeFromVM(JavaThread *thread) : ThreadStateTransition(thread) {
    // We are leaving the VM at this point and going directly to native code.
    // Block, if we are in the middle of a safepoint synchronization.
    assert(!thread->owns_locks(), "must release all locks when leaving VM");
    thread->frame_anchor()->make_walkable(thread);
    trans_and_fence(_thread_in_vm, _thread_in_native);
    // Check for pending. async. exceptions or suspends.
    if (_thread->has_special_runtime_exit_condition()) _thread->handle_special_runtime_exit_condition(false);
  }

  ~ThreadToNativeFromVM() {
    trans_from_native(_thread_in_vm);
    assert(!_thread->is_pending_jni_exception_check(), "Pending JNI Exception Check");
    // We don't need to clear_walkable because it will happen automagically when we return to java
  }
};
```

离开 VM 前必须先 `make_walkable`(:283,让 GC 能走这个线程的栈),再 `trans_and_fence` 进 native(:284);析构用 `trans_from_native` 回来(:290,带 safepoint 检查)。**`ThreadBlockInVM`**(:297-309)是阻塞专用: 进入阻塞前同样 `make_walkable`(:302——注释 "Once we are blocked vm expects stack to be walkable"),`trans_and_fence(_thread_in_vm, _thread_blocked)`(:303),醒来后反着转回去(:306)。流传的"ThreadBlockInVM 析构里调 cross_modify_fence"在 jdk11u 不存在。

另外两个变体: `ThreadInVMForHandshake`(:185-222)——03 篇 Handshake 的执行上下文,构造时 make_walkable + 直接置 `_thread_in_vm`(:215),析构 `transition_back`(:188-204)恢复**原来的状态**并处理特殊条件——它是"借道 VM 办完事回到原状态"的守卫;**`ThreadInVMfromJavaNoAsyncException`**(:315-337)与 ThreadInVMfromJava 的区别只在析构不处理异步异常(注释 :325-330: 若处理就得 deopt,某些场景不能容忍,只处理挂起 :334-335)。

**关键设计 (斜体)**: *守卫家族的形状是"一进一出,构造析构配对": 进 VM 的类负责 trans 进,析构负责 trans 出 + 检查特殊条件。C++ 栈展开保证析构必然执行——异常路径也逃不掉,状态转换的配对因此不可能漏。四个类(加两个变体)把"进/出/阻塞/借道"四种方向全部覆盖,使用点只需要一行声明。*

## 2. 被要求"停一下": 自挂起协议

### _suspend_flags: 一个字段,六种含义

线程"自愿停"的旗标在 `_suspend_flags`(thread.hpp:259-275,截取核心,逐字):

```cpp
// thread.hpp:259-275(截取核心,逐字)
  enum SuspendFlags {
    // NOTE: avoid using the sign-bit as cc generates different test code
    //       when the sign-bit is used, and sometimes incorrectly - see CR 6398077

    _external_suspend       = 0x20000000U, // thread is asked to self suspend
    _ext_suspended          = 0x40000000U, // thread has self-suspended
    _deopt_suspend          = 0x10000000U, // thread needs to self suspend for deopt

    _has_async_exception    = 0x00000001U, // there is a pending async exception
    _critical_native_unlock = 0x00000002U, // Must call back to unlock JNI critical lock

    _trace_flag             = 0x00000004U  // call tracing backend
  };

  // various suspension related flags - atomically updated
  // overloaded for async exception checking in check_special_condition_for_native_trans.
  volatile uint32_t _suspend_flags;
```

高位三位是挂起家族(_external_suspend=问一句/_ext_suspended=已停/_deopt_suspend=为 deopt 停),低位是异步异常与 JNI 临界区解锁;注释提醒避开符号位(:260-261,CR 6398077)。

### 自挂起流程: 被要求,然后自愿

`java_suspend()`(请求方)只置 `_external_suspend` 位就返回——**不等待、不强制**(thread.hpp:223-225 注释: "java_suspend() does not wait for an external suspend request to complete. When it returns, the only guarantee is that the _external_suspend field is true");真正的停下发生在守卫析构的 `handle_special_runtime_exit_condition`(§1 的 :235)里: 发现 external_suspend 就调 `java_suspend_self`(thread.cpp:2415-2461,截取核心,逐字):

```cpp
// thread.cpp:2415-2461(截取核心,逐字)
int JavaThread::java_suspend_self() {
  int ret = 0;

  // we are in the process of exiting so don't suspend
  if (is_exiting()) {
    clear_external_suspend();
    return ret;
  }

  assert(_anchor.walkable() ||
         (is_Java_thread() && !((JavaThread*)this)->has_last_Java_frame()),
         "must have walkable stack");

  MutexLockerEx ml(SR_lock(), Mutex::_no_safepoint_check_flag);

  assert(!this->is_ext_suspended(),
         "a thread trying to self-suspend should not already be suspended");

  if (this->is_suspend_equivalent()) {
    // If we are self-suspending as a result of the lifting of a
    // suspend equivalent condition, then the suspend_equivalent
    // flag is not cleared until we set the ext_suspended flag so
    // that wait_for_ext_suspend_completion() returns consistent
    // results.
    this->clear_suspend_equivalent();
  }

  // A racing resume may have cancelled us before we grabbed SR_lock
  // above. Or another external suspend request could be waiting for us
  // by the time we return from SR_lock()->wait(). The thread
  // that requested the suspension may already be trying to walk our
  // stack and if we return now, we can change the stack out from under
  // it. This would be a "bad thing (TM)" and cause the stack walker
  // to crash. We stay self-suspended until there are no more pending
  // external suspend requests.
  while (is_external_suspend()) {
    ret++;
    this->set_ext_suspended();

    // _ext_suspended flag is cleared by java_resume()
    while (is_ext_suspended()) {
      this->SR_lock()->wait(Mutex::_no_safepoint_check_flag);
    }
  }

  return ret;
}
```

要点:

- **先断言栈可走**(:2424-2426)——自挂起时 GC 可能正在走栈,锚必须 walkable;
- 拿 `SR_lock`(:2428)后,`while (is_external_suspend())`(:2451): 置 `_ext_suspended`(:2453)后**内层循环在 SR_lock 上 wait**(:2456-2457),直到 `java_resume()` 清掉 `_ext_suspended`;
- 注释(:2442-2450)解释了为什么外层还要循环: 竞态下 resume 可能在拿到锁前就取消了请求——必须确认"不再有任何挂起请求"才能返回,否则栈可能正被对方走着(注释原话 "we can change the stack out from under it...cause the stack walker to crash")。

**关键设计 (斜体)**: *"请求-自愿"让挂起永远发生在安全位置: 请求方只置位不强制,线程在自己选择的安全点(守卫析构)检查并停下——绝不会在持有锁、执行 VM 关键路径时被硬挂起。SR_lock 的双层 wait(外部等请求清空、内部等 resume)处理了请求/取消的竞态。*

## 3. 守卫们在哪里站岗

守卫的使用点遍布所有"进出 VM"的入口:

- **JNI**: 每个 `JNI_ENTRY` 宏(如 `jni_CallStaticVoidMethod`)都套 `ThreadInVMfromNative`——JNI 代码从 native 回 VM 的统一通道;
- **解释器与 JIT 的 VM 调用**: `JRT_ENTRY` 宏(interfaceSupport.inline.hpp:468-474)套 `ThreadInVMfromJava`——`InterpreterRuntime::monitorenter`、`ObjectSynchronizer::fast_enter` 这些运行时服务入口都走它;解释器运行时入口的 `IRT_ENTRY`(:460-466)则套 `ThreadInVMfromJavaNoAsyncException`(为什么: 见 §1 变体段);
- **阻塞**: `ThreadBlockInVM` 出现在等待锁、sleep、park 的路径——进阻塞时让栈 walkable、状态转 `_thread_blocked`;
- **JNI 出 VM**: `ThreadToNativeFromVM` 在每个 JNI native 方法调用点。

配对是硬约束: 进的守卫与出的守卫成对出现,而 RAII 让配对"漏不掉"——这正是 17 域这四篇讲的状态机、转换、回收全部落地的执行面。

## 核心悬念

17 域收官: interfaceSupport 的守卫家族(ThreadInVMfromJava/ThreadInVMfromNative/ThreadToNativeFromVM/ThreadBlockInVM,加 ThreadInVMForHandshake 与 NoAsyncException 变体)把 02 篇的三拍转换包成"构造进、析构出"的 RAII——状态转换不可能漏,特殊条件(异步异常/挂起)在析构统一处理;自挂起协议让"被要求停"变成"安全位置自愿停"(SR_lock 双层 wait 处理竞态);守卫站在 JNI/解释器/运行时服务每个入口站岗。但这一切的前提是: 真的有人来"停世界"——safepoint 怎么把成百上千个线程都叫住、确认都安全?下一篇: 域 18 Safepoint。

> → 域 18 Safepoint
