# 02. 线程怎么知道自己该停了？— Polling 与 NoSafepointVerifier

> 🔴 Deep | 2 KP 中的检测+保护
> 读者处境: Java 线程在解释器循环中跑——每 1000 条字节码指令后要检查"现在需要 safepoint 吗？"。这检查可以快（1 cycle 的 volatile read）也可以重（SIGSEGV→signal handler）。

> ⚠️ 写作期修正(2026-08-13, vol-02/18-safepoint/02 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **x86_64 默认 thread-local poll**(JDK10+ 起): `ThreadLocalHandshakes` pd product 默认 true(实证)→ `set_uses_thread_local_poll`(safepointMechanism.cpp:36-39);轮询=**testb 线程 _polling_page 字段第 3 位**(macroAssembler_x86.cpp:3744-3761/interp_masm_x86.cpp:832-834),**不触发 SIGSEGV**——01-os/04 的轮询页 SIGSEGV 是全局页模式(JDK11 x86 非默认)
> - **"Thread::_polling_page 地址切换" 半对**: JDK11 是**值方案**: armed=8|bad_page(受保护页)、disarmed=good_page(safepointMechanism.cpp:50-76);arm/disarm=一次 8 字节写 set_polling_page(safepointMechanism.inline.hpp:50-57);local_poll_armed=mask_bits_are_true(poll_word, poll_bit())(:32-35);非 Java 线程退化 global_poll(:38-46);block_if_requested 未 armed 直接 return(:55-60)
> - **"polling page 两个偏移 8 字节" 错(旧版)**: JDK11 是 bad/good **两个连续页**(实证日志 "SafePoint Polling address, bad (protected) page:0x..., good (unprotected) page:0x...",safepointMechanism.cpp:69);值兼作地址(某些路径 dereference 落在 bad/good 页)
> - **NoSafepointVerifier 伪代码全错(编造)**: 不是"记录 counter+析构断言";JDK11=**线程计数**(构造 `_allow_safepoint_count++`/`_allow_allocation_count++`,析构减,safepointVerifiers.hpp:89-104;thread.hpp:335 "If 0, thread allow a safepoint to happen");检查点 `check_for_valid_safepoint_state`(thread.cpp:995-1006)计数非零→fatal("Possible safepoint reached by thread that does not allow it");调用点=memAllocator.cpp:186(分配)/mutex.cpp:1370(阻塞)/vmThread.cpp:672(VM op);release 空实现;**NoGCVerifier 才是计数断言**(total_collections,safepointVerifiers.cpp:8-28);PauseNoSafepointVerifier 嵌套暂停;JRTLeafVerifier(interfaceSupport.inline.hpp:372)
> - **"local_poll 读 safepoint_state()->_thread_local_poll" 错**: 读 Thread::_polling_page 值(线程字段,thread.hpp:708)
> - **"ServiceThread::armed_value" 不存在(编造)**: 无此机制
> - **critical native(大纲第 3 节)不属于本篇**: check_for_lazy_critical_native(safepoint.cpp:781)是 18-01 begin/点名的一部分;Get/ReleasePrimitiveArrayCritical 属 27-jni 域
> - **悬念指向错**: 大纲 "→域 19 Synchronization" 过期(19 域已完结);正确指向 20-vm-operations/01-vm-operation.md
> - **实证**: 18-safepoint-polling-demo.txt(ThreadLocalHandshakes=true pd;轮询页地址日志;对照 -XX:-ThreadLocalHandshakes safepoint 照常)

### 1. "两种通知方式" — page trap vs thread local poll

场景: GC 需要 safepoint。VM thread 调 begin()→此时 200 个线程中有 195 个在 Java code 中(需要通知)，5 个在 native(不需要通知)。怎么最快地通知那 195 个？

**两种 Polling 机制** (`safepointMechanism.hpp:34-38`):
```
_global_page_poll:   所有线程共享一页→mprotect→SIGSEGV 广播
_thread_local_poll:  每线程一个 local flag→volatile read 检查
```
- 源码: `safepointMechanism.hpp:34-38` enum PollingType
- 关键设计: thread_local_poll(JDK10+) 比 global_page_poll 快得多——(1) 不走 mprotect syscall(在 safepoint begin 中)，(2) 不走 SIGSEGV 信号处理(在 Java thread 的 polling 路径中)。但 global_page_poll 仍有价值——它"强迫"线程停——线程没有显式 polling code 也会因为读那个地址而停

**global_page_poll 的工作原理** (`safepointMechanism.inline.hpp:35-50`):
```
1. VM thread 调 arm: mprotect(polling_page, 4096, PROT_NONE)
2. Java thread 在安全点(方法返回/循环回边)读 *polling_page:
   testl %eax, [polling_page_address]   // JIT 插入的指令
3. 因为 PROT_NONE→SIGSEGV→signal handler→SafepointMechanism::block_if_requested
4. 线程停住→safepoint 结束后 mprotect(PROT_READ)→恢复
```
- 源码: `assembler_x86.cpp:2700-2730` 生成 polling test 指令 + `os_linux_x86.cpp:500-530` signal handler 处理 SIGSEGV
- [x86: x86 下的 polling 指令是 `testl %eax, [address]`——这个 load 把值读入 eax 但不存回(没有 side effect)——如果页面可读→这条指令是 noop(忽略读出的值)。如果页面不可读→SIGSEGV→内核发信号→JVM handler 处理。关键是"不可读"是全局广播——所有正在执行 Java code 的线程都会在下一个 polling 点命中]
- [内核: mprotect 是 costly syscall——需要遍历进程的 VMA tree→找到对应的 page table entry→clear PTE_P(存在标志)→TLB shootdown(IPI 广播到所有核心刷新 TLB)。这就是为什么 thread_local_poll 更快——它跳过整个内核路径]

**_poll_bit = 8 区分 armed/disarmed** (`safepointMechanism.hpp:59-61`):
```
_poll_armed_value   = polling_page + 0  (需要 safepoint 时指向的地址)
_poll_disarmed_value = polling_page + 8  (正常时指向的地址)
```
- 源码: `safepointMechanism.hpp:59-61` `_poll_bit = 8`
- 关键设计: 同一页的两个偏移——base 可读(不需要 safepoint)，base+8 不可读(需要 safepoint)。Thread::_polling_page 存储当前活跃的地址。切换时只需要改 _polling_page 的值(8-byte write)——不需要两次 mprotect
- [x86: 两个地址相差 8 字节——在同一 4K 页内。mprotect 保护整个页——所以两个地址的 PROT 权限总是一起变。用不同偏移区分 armed/disarmed 而非两个 mprotect 调用——从 2 个 syscall 减到 1 个]
- [C++: `Thread::_polling_page` 是 `volatile void*`——写入方写新地址(path 切换 ARM→DISARM)，读取方读地址并 dereference。volatile 确保"写池→读页"的顺序——Java thread 不会"写了 ARM 但 CPU 还没从 cache 推送到内存"地遗漏 safepoint]

**thread_local_poll 流程** (`safepointMechanism.inline.hpp:50-75`):
```
local_poll(Thread* thread):
  1. 读 thread->safepoint_state()->_thread_local_poll  // 1 cycle volatile read
  2. 如果 is_armed → block_if_requested_slow()  // 走 safepoint 路径
  3. 如果 is_disarmed → return (noop, 1 cycle total)
```
- 源码: `safepointMechanism.inline.hpp:50-75` `local_poll()`
- 对比 global page poll: page trap ≈ 2 cycles(testl) + ???(signal delivery: 3-5 µs)。thread local ≈ 1 cycle(testb)。在 JIT 代码中——每条方法返回边、每个循环回边都插一条 polling check——1 cycle vs 3µs 的差异是 3000x
- [C++: `ServiceThread::armed_value` 存储 armed 状态——在 safepoint 开始时设为 armed→每个线程的 local poll 检查它。不是 thread-local——是 service thread 的全局标记。每个线程的 `_thread_local_poll` 只是 `ThreadSafepointState` 的一个字段缓存这个值]

### 2. "别在关键区间打断我" — NoSafepointVerifier

场景: 你正在修改 GC 的 CardTable——刚写到一半，safepoint 触发了——GC worker 开始扫描 CardTable——读到半改的数据→crash。怎么保证这种关键区间不被 safepoint 打断？

**NoSafepointVerifier 守卫** (`safepointVerifiers.hpp:37-52`):
```cpp
class NoSafepointVerifier : public StackObj {
  unsigned int _old_invocations;
public:
  NoSafepointVerifier() { // 构造: 记录当前 safepoint counter
    _old_invocations = SafepointSynchronize::_safepoint_counter;
  }
  ~NoSafepointVerifier() { // 析构: 断言 counter 没变
    assert(_safepoint_counter == _old_invocations,
           "safepoint 出现在禁止区域");
  }
};
```
- 源码: `safepointVerifiers.hpp:37-52` + `safepointVerifiers.cpp:38-55`
- 关键设计: ASSERT only — release 模式为空(`{}`)。验证原理: safepoint 触发时 `_safepoint_counter` 会递增——如果析构时 counter 变了→在这个区间内发生了 safepoint→assert 失败。不给生产增加开销——debug 开发时抓 bug
- [C++: `StackObj` = 栈上分配——对象构造/析构由编译器保证。从构造函数到析构函数的代码区域被保护——不必显式 release。如果中间抛异常→栈展开→析构仍调用——safepoint 检测不会遗漏]

**PauseNoSafepointVerifier** (`safepointVerifiers.hpp:59-70`):
```cpp
// 在 NoSafepointVerifier 保护区域内临时暂停验证:
PauseNoSafepointVerifier(NoSafepointVerifier& verifier) {
  _old_invocations = verifier._old_invocations;  // save
  verifier._old_invocations = _safepoint_counter; // reset
}
~PauseNoSafepointVerifier() {
  verifier._old_invocations = _old_invocations;   // restore
}
```
- 源码: `safepointVerifiers.cpp:70-95`
- 关键设计: 用于嵌套场景——外层禁止 safepoint，内层必须让 safepoint 发生(如 wait on lock)。Pause 恢复旧 counter→允许 safepoint→析构后重新禁止。断言在 Pause 析构时仍然全部覆盖

### 3. "谁在 native 跑着？" — JNI Critical Native + Lazy Check

场景: JNI Critical Native(GetPrimitiveArrayCritical)期间——线程在 native 但 JVM 需要等它回来才能在 safepoint 移动数组。如果一直等→GC 延迟飙升。但 JNI 规范说 critical native 应该是"短暂的"→JVM 选择相信程序员。

**check_for_lazy_critical_native** (`safepoint.hpp:157`):
```
safepoint 过程中:
  for each JavaThread(state == _thread_in_native):
    if (thread has active critical native) → 计入 _current_jni_active_count
    // 不能等 native code→safepoint 继续进行
```
- 源码: `safepoint.cpp:340-370` check_for_lazy_critical_native
- 关键设计: critical native 期间 JVM 承诺不移动对象——如果线程在 GetPrimitiveArrayCritical 和 ReleasePrimitiveArrayCritical 之间→safepoint 不能等它——否则 GC 无限延长。JVM 知道 critical 线程"承诺不会长时间持有锁"——如果超时→WARNING 日志
- 关键设计: 为什么不能阻塞等 critical native？因为 native 代码可能在做 IO——等 10ms→GC 延迟 10ms。JVM 的策略是"相信程序员"——不做硬性限制。但 `_current_jni_active_count` 提供监控——如果计数>0 且 safepoint 时间长→可以在日志中看到
- [C++: `_current_jni_active_count` 在 safepoint 期间用 Safepoint_lock 保护——其他线程可能正在进入/离开 critical native→需要锁确保计数准确。锁只保护计数器——不阻塞 native 代码执行]
- [C++: GetPrimitiveArrayCritical 返回直接指针（非 copy）→GC 不能移动数组→需要 pin 住 array 对象。safepoint 在检查到 active critical native 时跳过这个线程→GC 在这个 safepoint round 中不能 relocate 被 pinned 的对象——如果 pinned 对象太多→GC 碎片化]

**critical native 的约束契约**:
- JNI 规范: "critical 区间应该像持有锁一样短"
- ReleasePrimitiveArrayCritical 必须用 JNI_COMMIT(不回写) 或 0(回写) 参数调用
- 如果区间过长→GC 片段中 pinned 对象累积→堆碎片→最终 Full GC
- JVM 在 `-XX:+CheckJNICalls` 模式下可检查 Get/Release 配对是否正确

---

### 核心悬念

**"Safepoint 检测有两种方式——global page trap 用 mprotect+SIGSEGV 广播所有线程，thread local poll 用 1 cycle volatile read 逐个检查。NoSafepointVerifier 在 DEBUG 模式保护关键区间不被 safepoint 打断。"** — 下一篇: 域19 Synchronization——锁和 monitor 怎么和 safepoint 交互。

> → 域19 Synchronization
