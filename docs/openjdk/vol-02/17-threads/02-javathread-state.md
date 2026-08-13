# 02. 线程怎么告诉 JVM "我不能 safepoint"？— JavaThread 状态机

> **前置依赖**:[17-threads/01 — Thread 层次体系](openjdk/vol-02/17-threads/01-thread-hierarchy.md):JavaThread 的 `_thread_state` 字段与 run() 里那次 `transition_and_fence` 在这里展开;[01-os/04 — 信号与安全点](openjdk/vol-02/01-os/04-signals-and-safepoint.md):轮询与 safepoint 的信号面;[09-memory-core/01 — Universe](openjdk/vol-02/09-memory-core/01-universe-heap.md):GC 停世界的协作前提
> → **后续**:[17-threads/03 — Thread-SMR](03-thread-smr-handshake.md)(线程退出后怎么保证不悬垂)
> 关联域: 01-os(信号)、17-threads(线程)、18-safepoint、27-jni(状态转换的消费方)

## 停世界之前,先问每个线程"你在哪"

GC 要停世界时,不能把线程从任何位置硬停: 线程若在 JNI native 代码里,栈上没有 Java 帧可恢复;若在解释器里,必须停在安全点(方法返回、循环回边)。所以每个 Java 线程随身带一个状态位——`_thread_state`,随时回答"我现在在哪、能不能停"。这一篇拆开这个状态机: 状态有哪些、换状态瞬间怎么做(trans 状态 + 序列化)、jdk11u 的轮询机制(线程本地轮询而非全局页),以及线程退出的终止协议。

## 1. JavaThreadState: 五个真身,两种过渡

### 枚举: 为什么值是 0、2、4、6、8、10

状态枚举定义在 globalDefinitions.hpp:890-905(不在 thread.hpp,截取核心,逐字):

```cpp
// globalDefinitions.hpp:888-905(截取核心,逐字)
// Given a state, the xxxx_trans state can always be found by adding 1.
//
enum JavaThreadState {
  _thread_uninitialized     =  0, // should never happen (missing initialization)
  _thread_new               =  2, // just starting up, i.e., in process of being initialized
  _thread_new_trans         =  3, // corresponding transition state (not used, included for completness)
  _thread_in_native         =  4, // running in native code
  _thread_in_native_trans   =  5, // corresponding transition state
  _thread_in_vm             =  6, // running in VM
  _thread_in_vm_trans       =  7, // corresponding transition state
  _thread_in_Java           =  8, // running in Java or in stub code
  _thread_in_Java_trans     =  9, // corresponding transition state (not used, included for completness)
  _thread_blocked           = 10, // blocked in vm
  _thread_blocked_trans     = 11, // corresponding transition state
  _thread_max_state         = 12  // maximum thread state+1 - used for statistics allocation
};
```

流传的"0-6 五个状态"是错的——真实是**五个真状态 + 每个状态的 +1 trans 状态**,且值间隔 2。文件头的注释是钥匙: "Given a state, the xxxx_trans state can always be found by adding 1"。五个真状态的语义:

- `_thread_new`(2): 刚构造、还没就绪;
- `_thread_in_native`(4): 在 JNI native 代码里——**safepoint 不用等它**(没有 Java 帧可扫);
- `_thread_in_vm`(6): 在 VM 内部执行——**safepoint 必须等它**到安全点(它在碰 VM 数据结构);
- `_thread_in_Java`(8): 在解释器/编译代码里——safepoint 等它到轮询点;
- `_thread_blocked`(10): 阻塞在 monitor/sleep/park——已在安全位置。

字段本身是 `volatile JavaThreadState _thread_state`(thread.hpp:1038)——safepoint 发起线程读它时,必须保证读到的是该线程最新写出的值。注意 x86/PPC/AARCH64 的差异: x86 直接读 volatile;PPC64/AARCH64 上访问要加内存屏障(thread.hpp:1262-1275 的 #else 分支注释)。

## 2. 换状态那一瞬间: trans 状态与序列化

### 为什么先写 from+1,再写 to

状态转换不在"set + fence"这么简单——它是三拍(interfaceSupport.inline.hpp:103-148,截取核心,逐字):

```cpp
// interfaceSupport.inline.hpp:112-128(截取核心,逐字)
  // Change threadstate in a manner, so safepoint can detect changes.
  // Time-critical: called on exit from every runtime routine
  static inline void transition(JavaThread *thread, JavaThreadState from, JavaThreadState to) {
    assert(from != _thread_in_Java, "use transition_from_java");
    assert(from != _thread_in_native, "use transition_from_native");
    assert((from & 1) == 0 && (to & 1) == 0, "odd numbers are transitions states");
    assert(thread->thread_state() == from, "coming from wrong thread state");
    // Change to transition state
    thread->set_thread_state((JavaThreadState)(from + 1));

    InterfaceSupport::serialize_thread_state(thread);

    SafepointMechanism::block_if_requested(thread);
    thread->set_thread_state(to);

    CHECK_UNHANDLED_OOPS_ONLY(thread->clear_unhandled_oops();)
  }
```

三拍:

1. **先写 trans 状态 `from + 1`**(:120): 让 safepoint 发起者看到"这个线程正在从 X 往 Y 转换"——奇数 trans 状态就是给它的信号: 别急,等我到 Y;
2. **serialize_thread_state**(:122): 保证新状态被 safepoint 线程看到(见下);
3. **`SafepointMechanism::block_if_requested(thread)`**(:124): **safepoint 检查点就嵌在转换里**——若 safepoint 进行中,线程在这里自己阻塞;然后才写终态 `to`(:125)。

`transition_and_fence`(:136-148)与 transition 的差别只在序列化用带 SEH handler 的版本(:142)——Windows 上没有调用桩兜底时需要异常处理(注释 :130-135)。

### 序列化: 内存屏障或"伪远程 membar"

`serialize_thread_state_internal`(interfaceSupport.inline.hpp:82-97,截取核心,逐字):

```cpp
// interfaceSupport.inline.hpp:82-97(截取核心,逐字)
  static void serialize_thread_state_internal(JavaThread* thread, bool needs_exception_handler) {
    // Make sure new state is seen by VM thread
    if (os::is_MP()) {
      if (UseMembar) {
        // Force a fence between the write above and read below
        OrderAccess::fence();
      } else {
        // store to serialize page so VM thread can do pseudo remote membar
        if (needs_exception_handler) {
          os::write_memory_serialize_page_with_handler(thread);
        } else {
          os::write_memory_serialize_page(thread);
        }
      }
    }
  }
```

两条路: `OrderAccess::fence()`(内存屏障,常见配置)或**写序列化页**(`os::write_memory_serialize_page`,注释: "store to serialize page so VM thread can do pseudo remote membar")——线程把状态写进页,safepoint 发起线程读页时隐式同步,等于替对方做了远程屏障。这正是 01-04 讲 safepoint 时那个"序列化页"的落点。

**关键设计 (斜体)**: *trans 状态让"状态转换中"本身可见——safepoint 不需要猜"线程在从 X 到 Y 的路上会不会路过安全点",看到奇数状态就知道它在转换,等到 to 状态即可。而 block_if_requested 嵌在转换里,意味着"每次进出 VM 都是一次 safepoint 检查点"——检查免费搭在必经之路上。*

## 3. 轮询: jdk11u 的线程本地轮询

### 流传的 mprotect 是旧机制

流传说法"需要 safepoint 时把轮询页 mprotect 成 PROT_NONE,线程读到就 SIGSEGV"是 **JDK 11 之前**的全局轮询页机制。jdk11u 的 64 位 x86 默认 `ThreadLocalHandshakes=true`(globals_x86.hpp:100),轮询变成**线程本地**: 轮询页始终可读,armed 与否是**值**的差别。

`SafepointMechanism`(safepointMechanism.hpp:34-46)维护两种轮询类型(global_page_poll/thread_local_poll,:35-38)与两个值——`_poll_armed_value`/`_poll_disarmed_value`(:40-41);`default_initialize`(safepointMechanism.cpp:37-57)在 ThreadLocalHandshakes 时选线程本地轮询,armed 值就是 `poll_bit()`(一个特定位)。开关在每线程的 `_polling_page`(thread.hpp:346,1 讲讲过):

- **arm/disarm**(safepointMechanism.inline.hpp:65-70): `set_polling_page(poll_armed_value())` / `set_polling_page(0)`——改一个指针值,不是改页权限;
- **判断**(:32-35,截取核心,逐字):

```cpp
// safepointMechanism.inline.hpp:32-35(截取核心,逐字)
bool SafepointMechanism::local_poll_armed(JavaThread* thread) {
  const intptr_t poll_word = reinterpret_cast<intptr_t>(thread->get_polling_page());
  return mask_bits_are_true(poll_word, poll_bit());
}
```

### JIT 里的一行轮询指令

轮询点(方法返回、循环回边)的机器码由 `MacroAssembler::safepoint_poll` 生成(macroAssembler_x86.cpp:3744-3755,截取核心,逐字):

```cpp
// macroAssembler_x86.cpp:3744-3756(截取核心,逐字)
void MacroAssembler::safepoint_poll(Label& slow_path, Register thread_reg, Register temp_reg) {
  if (SafepointMechanism::uses_thread_local_poll()) {
#ifdef _LP64
    assert(thread_reg == r15_thread, "should be");
#else
    if (thread_reg == noreg) {
      thread_reg = temp_reg;
      get_thread(thread_reg);
    }
#endif
    testb(Address(thread_reg, Thread::polling_page_offset()), SafepointMechanism::poll_bit());
    jcc(Assembler::notZero, slow_path); // handshake bit set implies poll
  } else {
```

一次 `testb [r15_thread + polling_page_offset], poll_bit` + 一条条件跳转——**没有 SIGSEGV,只有一次内存读与位测试**。armed 时位为 1,跳 slow_path 进 safepoint 流程;disarmed 时位为 0,继续跑。注意与 01-04 的信号判决并不冲突: 01-04 的"si_addr 落在轮询页"分支对应**全局轮询路径**(ThreadLocalHandshakes 关闭或 handshake 的全局页),而 jdk11u 默认配置的线程本地轮询不触发页故障。

### 检查点在转换里

轮询的另一半是 `block_if_requested`(safepointMechanism.inline.hpp:58-63): 线程本地轮询已 armed 才进 `block_if_requested_slow` 真正阻塞——§2 的转换三拍里,它就是中间那一拍。解释器与 JIT 在轮询点各自调用,VM 代码靠状态转换检查——两条路合起来覆盖"Java 代码中"与"进出 VM 时"。

**关键设计 (斜体)**: *线程本地轮询把"停世界"的广播从"全局页权限翻转"降级为"每线程一个指针值",arm 一个线程与 arm 全部线程成本相同;而检查是 JIT 生成的一行 test+跳转,失手成本是内存读。轮询点+转换检查点两种机制互补: 前者覆盖执行中的 Java 代码,后者覆盖进出 VM 的瞬间。*

## 4. 终止协议: 线程退出的四态

### TerminatedTypes: 0xDEAD - 2 的哨兵

线程退出也有自己的状态机(thread.hpp:1041-1058,截取核心,逐字):

```cpp
// thread.hpp:1044-1058(截取核心,逐字)
  enum TerminatedTypes {
    _not_terminated = 0xDEAD - 2,
    _thread_exiting,                             // JavaThread::exit() has been called for this thread
    _thread_terminated,                          // JavaThread is removed from thread list
    _vm_exited                                   // JavaThread is still executing native code, but VM is terminated
                                                 // only VM_Exit can set _vm_exited
  };

  // In general a JavaThread's _terminated field transitions as follows:
  //
  //   _not_terminated => _thread_exiting => _thread_terminated
  //
  // _vm_exited is a special value to cover the case of a JavaThread
  // executing native code after the VM itself is terminated.
```

`_not_terminated = 0xDEAD - 2`(:1045): 哨兵值故意不从 0 开始——0xDEAD 是 VM 调试 pattern 家族的一员,`_not_terminated` 的值让"未初始化的内存"或"已被清掉的字段"几乎不可能误判成"活着"(注释 :1052-1054 给了正常转换链)。`_vm_exited` 是特殊分支: VM 已终止但线程还在 native 代码里,只有 VM_Exit 能设置(:1050)。

### 退出流程

`JavaThread::exit`(thread.cpp:1902-2101)是线程的收尾点: 释放 JNI 句柄块、移除栈保护页、**把自己从 Threads 列表移除**(调用点注释 :4334-4338 明说 "<-- no more Java code from this thread after this point -->"),内部还调 `ensure_join(this)`(:2015)唤醒 join 等待者。之后 `smr_delete()`(thread.cpp:208-213): 还在列表上就交给 `ThreadsSMRSupport::smr_delete`(延迟回收——03 篇),否则直接 `delete this`。

## 核心悬念

状态机到齐: 五个真状态(+1 的 trans 状态)用 `_thread_state` 回答"我在哪、能不能停";转换三拍(写 trans → 序列化 → block_if_requested → 写终态)把 safepoint 检查嵌进每次进出 VM;线程本地轮询用一行 test 指令替代全局页翻转(armed 值是位不是权限);终止四态用 0xDEAD-2 哨兵防僵尸误判。但你大概注意到了退出的最后一环: `smr_delete` 交给 `ThreadsSMRSupport`——**线程对象退出了,可别的线程可能正握着它的指针遍历列表**。直接 delete 就是悬垂指针。怎么安全回收?下一篇: Thread-SMR——hazard pointer 式的线程安全回收。

> → [17-threads/03 — Thread-SMR](03-thread-smr-handshake.md)
