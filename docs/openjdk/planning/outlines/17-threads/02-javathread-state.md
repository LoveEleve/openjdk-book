# 02. 线程怎么告诉 JVM "我不能 safepoint"？— JavaThread 状态机

> 🔴 Deep | 4 KP 中的安全基石
> 读者处境: 线程正在执行 JNI native 代码——GC 来了需要 safepoint。线程不能停在 native 代码中间（不会有 Java frame 可以恢复）。线程必须告诉 JVM 自己是什么状态。
>
> ⚠️ 写作期修正(2026-08-13, vol-02/17-threads/02 已按真实源码成文~195 行,本大纲为规划期产物,机制描述以文章为准):
> - **"JavaThreadState 五状态 0-6(thread.hpp:1038)" 全错**: 枚举在 **globalDefinitions.hpp:889-905**——五个真状态 `0/2/4/6/8/10`(uninitialized=0/new=2/in_native=4/in_vm=6/in_Java=8/blocked=10)+**每个的 +1 trans 状态**(new_trans/in_native_trans/in_vm_trans/blocked_trans 用,new_trans/in_Java_trans 未用);注释 "Given a state, the xxxx_trans state can always be found by adding 1";字段=thread.hpp:1038 volatile;PPC64/AARCH64 访问需 membars(thread.hpp:1262-1275 #else 分支)
> - **"trans_and_fence = set(to)+OrderAccess::fence()" 错(机制简化)**: 真实=ThreadStateTransition::transition(interfaceSupport.inline.hpp:112-128)三拍: **先写 trans 状态 from+1**(:120)→ serialize_thread_state(:122)=OrderAccess::fence(UseMembar)或 **os::write_memory_serialize_page 伪远程 membar**(:82-97,"Make sure new state is seen by VM thread")→ **SafepointMechanism::block_if_requested(:124,safepoint 检查点嵌在转换里)**→ 写 to(:125);transition_and_fence(:136-148)差异仅在 serialize 用带 SEH 版本(:142,Windows 无调用桩注释 :130-135);transition_from_java(:153-156)不 block 直接写 to
> - **"safepoint 检查(safepoint.cpp)三 if" 大纲化**: jdk11u 的检查=轮询+block_if_requested(safepointMechanism.inline.hpp:58-63)
> - **"polling_page mprotect→SIGSEGV" 是 JDK11 前全局页机制**: jdk11u 64 位 x86 默认 **ThreadLocalHandshakes=true**(globals_x86.hpp:100)→**线程本地轮询**: SafepointMechanism(safepointMechanism.hpp:34-46,两种 PollingType :35-38)armed/disarmed 值是 poll_bit/0(:40-41);arm/disarm=set_polling_page(值)(inline:65-70);local_poll_armed=mask poll_bit(:32-35);JIT 轮询=safepoint_poll(macroAssembler_x86.cpp:3744-3756)=**一行 testb [r15_thread+polling_page_offset], poll_bit + jcc notZero,无 SIGSEGV**;01-04 的"si_addr 轮询页"信号分支对应**全局轮询路径**(ThreadLocalHandshakes 关)
> - **"Termination 四状态(thread.hpp:1044-1050)" 行号对但机制补全**: TerminatedTypes :1044-1050(_not_terminated=0xDEAD-2 :1045/_thread_exiting/_thread_terminated/_vm_exited 仅 VM_Exit 可设 :1050);正常链 _not_terminated=>_thread_exiting=>_thread_terminated(:1052-1054);**退出流程**: JavaThread::exit(thread.cpp:1902-2101,释放 JNI 句柄/移除栈保护页/从 Threads 列表移除,调用点注释 :4334-4338 "<-- no more Java code from this thread after this point -->")→**ensure_join(this) 在 exit 内部(:2015)**→smr_delete(thread.cpp:208-213→ThreadsSMRSupport,03 篇);**"post_run()/0xDEAD sentinel 防未初始化误判"为大纲叙述,真实注释只给转换链**
> - **第 3 轮 REVIEW 补充**: _thread_in_native "安全"有条件=无 last_Java_frame 或 anchor walkable(safepoint_safe safepoint.cpp:765-766);trans 状态的消费方=safepoint block 检查,trans 停留=fatal "Deadlock in safepoint code. Should have called back to the VM before blocking"(:889-896)
> - 悬念指向 03-thread-smr-handshake.md(标题 "03. Thread-SMR——hazard pointer 式的线程安全回收")✓

### 1. "我有五个状态" — JavaThreadState

场景: JVM 的 safepoint 机制靠什么知道"这个线程可以停了"？看 `_thread_state`。

**五状态定义** (`thread.hpp:1038`):
```
enum JavaThreadState {
  _thread_new           = 0,   // 刚构造，还没添加到 Threads list
  _thread_in_native     = 1,   // 在 JNI native 代码中
  _thread_in_vm         = 2,   // 在 VM 内部执行(不在 Java 中)
  _thread_in_Java       = 3,   // 在解释器或编译代码中执行
  _thread_blocked       = 4,   // 阻塞在 monitor/sleep/park
  _thread_blocked_trans = 5,   // 从 blocked→vm 的过渡(瞬时)
  _thread_in_native_trans = 6  // 从 native→vm 的过渡(瞬时)
};
```
- 关键设计: 每个状态对应 safepoint 的不同语义——`_thread_in_Java` 在 safepoint 时必须停在安全点。`_thread_in_native` 可以继续跑（没有 Java 栈帧需要扫描）。`_thread_in_vm` 在 safepoint 时必须阻塞（正在操作 VM 数据，不能让 GC 并发修改）

**Safepoint 检查：状态决定行为** (`safepoint.cpp`):
```
if (thread_state == _thread_in_Java) → 需要停到安全点（插 polling page check）
if (thread_state == _thread_in_native) → 不需要停（可以继续 native code）
if (thread_state == _thread_in_vm) → 必须阻塞（VM 操作中）
```
- [C++: `_thread_state` 是 `volatile JavaThreadState`——safepoint 线程读它时必须是这个线程最新写的值。不带 volatile → compiler 可能 reorder→safepoint 线程看到过期的状态→错误认为线程已阻塞]

### 2. "换状态那一瞬间" — trans_and_fence

场景: 线程从 Java 进入 VM——`set_thread_state(_thread_in_Java→_thread_in_vm)`——但这个写需要内存屏障才能被其他线程看到。

**trans_and_fence** (`interfaceSupport.inline.hpp:40-60`):
```cpp
inline void JavaThread::set_thread_state(JavaThreadState s) {
  _thread_state = s;
}

void trans_and_fence(JavaThreadState from, JavaThreadState to) {
  set_thread_state(to);  // 先写新状态
  OrderAccess::fence();  // StoreLoad barrier
  // 其他线程的 load(_thread_state) → 现在保证看到新值
}
```
- 关键设计: StoreLoad fence 是 x86 上的 `mfence` 或 ARM 上的 `dmb sy`——是最重的 barrier 因为它阻止 store 之后 load 的重排序。safepoint 检查路径: `load(_thread_state) → compare to safepoint-blocked`——如果这个 load 发生在 trans_and_fence 的 store 之前（reorder）→ 看到旧状态→ 错过了安全阻塞机会
- [x86: x86 的 TSO 模型保证 store→store 不重排但 store→load 可能重排。所以 trans_and_fence 在 x86 上至少是 `mfence` 或 `lock addl $0, (%rsp)`]

**转换模式**:
```
Java → VM:    trans_and_fence(_thread_in_Java→_thread_in_vm)
VM → Java:    trans_and_fence(_thread_in_vm→_thread_in_Java)
Native → VM:  trans_and_fence(_thread_in_native→_thread_in_vm)
VM → Native:  trans_and_fence(_thread_in_vm→_thread_in_native)
Blocked → VM: trans_and_fence(_thread_blocked→_thread_in_vm)
```
- [C++: 为什么 `_thread_blocked` 和 `_thread_in_vm` 需要区分？因为在 blocked 状态线程不应该做 VM 内存分配——Blocked→VM 的转换说明它已经离开了 blocking 原因（如 monitor enter 成功），现在可以安全操作 VM 数据]

### 3. "我走了，你们继续" — 线程终止协议

场景: 线程执行完 `run()` 的最后一行——它要从线程列表中移除。但其他线程可能正在遍历列表。

**Termination 四状态** (`thread.hpp:1044-1050`):
```
_not_terminated → _thread_exiting → _thread_terminated → _vm_exited
```
- `_not_terminated = 0xDEAD - 2`: 正常运行时
- `_thread_exiting`: `JavaThread::exit()` 已调用——清理 resource/handle/monitor
- `_thread_terminated`: 已从 Threads 列表移除——但 Thread 对象还在（等 smr_delete）
- `_vm_exited`: VM 正在退出——线程还在 native code 执行——不是 JavaThread 能控制的退出
- 关键设计: 0xDEAD - 2 不是一个简单的 0——防止未初始化内存误判（0xDEAD 是已知的 sentinel 模式）

**退出流程**:
```
1. JavaThread::exit() → _state → _thread_exiting
2. JavaThread::post_run() → Threads::remove(this) → _state → _thread_terminated
3. ThreadsSMRSupport::smr_delete(this) → 延迟回收（等所有 hazard ptr 释放）
```
- [C++: 删除不是 delete this——线程在 exit() 后不能访问自己的成员函数。退出逻辑通过 `ensure_join(JavaThread*)` 调用 os::join(osthread) 确保 OS 线程结束→然后 ThreadsSMRSupport::smr_delete 把 JavaThread* 放入延迟删除队列]

### 4. Safepoint 轮询 — 怎么把线程叫停？

场景: 线程在 Java code 中疯狂循环——它怎么知道"现在要 safepoint 了"？

**polling_page 机制** (`thread.hpp:346`):
```
_polling_page: 线程本地轮询页地址
```
- 线程定期读 `*_polling_page`——正常情况下该地址可读（返回 0）
- 需要 safepoint → 设为不可读（mprotect PROT_NONE）→ 线程读时 SIGSEGV → signal handler 进入 safepoint
- [x86: JIT 在方法返回/循环回边插 `testl %eax, [polling_page_address]` —— safepoint 时把那个地址 mprotect→SIGSEGV→JVM signal handler 处理→线程停住→safepoint 结束→mprotect 恢复]
- 源码: `safepointMechanism.inline.hpp` — `should_block(thread, pc)` → 检查 SafepointSynchronize::is_synchronizing()

---

### 核心悬念

**"Java 线程的状态机——5 状态 + trans_and_fence + termination 协议——这是 JVM 多线程安全的基石。每个状态转换都在说 '我现在可以被 safepoint 了' 或 '现在不行'。"** — 但线程退出后怎么保证不 UAF？下一篇: Thread-SMR。

> → [03-thread-smr-handshake.md](03-thread-smr-handshake.md)
