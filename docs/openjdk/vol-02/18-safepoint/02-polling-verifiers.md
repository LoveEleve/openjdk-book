# 02. 线程怎么知道自己该停了？— 轮询机制与 NoSafepointVerifier

> **前置依赖**:[18-safepoint/01 — JVM 怎么让所有线程同时停住？— Safepoint 编排](01-safepoint-orchestration.md):本篇的轮询是 begin() 的"通知面";[01-os/04 — 一个 SIGSEGV,五件事一起做 — 信号与安全点](openjdk/vol-02/01-os/04-signals-and-safepoint.md):全局页模式的信号侧;[08-interpreter/02 — 一条字节码怎么变成 x86 机器码？— Template Interpreter](openjdk/vol-02/08-interpreter/02-template-interpreter.md):解释器 dispatch 的轮询点;[17-threads/02 — JavaThread 状态机](openjdk/vol-02/17-threads/02-javathread-state.md):native 返回时的状态转换检查
> → **后续**:[20-vm-operations/01 — "帮我做 GC"——VM_Operation 从提交到执行](openjdk/vol-02/20-vm-operations/01-vm-operation.md):谁发起 safepoint
> 关联域: 25-gc(STW 依赖轮询)、27-jni(临界区保护)

## 200 个线程的"眼睛"

01 篇讲了指挥端: VM 线程宣布 safepoint、点名、等齐。但线程**怎么知道**该停了?答案藏在"轮询"(polling): 每个线程在运行路径上**定期、极便宜地看一眼"要不要停"的标志**。这一篇拆这只"眼睛"的两种形态——**thread-local poll(x86 默认)**与**全局轮询页(信号模式)**——以及保护"不能被打断的关键区间"的验证器。

## 1. 两种轮询: 值比较 vs 信号

`safepointMechanism.hpp:34-38` 定义了两种轮询类型:

```cpp
// safepointMechanism.hpp:34-38(截取核心,逐字)
  enum PollingType {
    _global_page_poll,
    _thread_local_poll
  };
```

- **`_thread_local_poll`**: 每线程一个 poll 标志,轮询是**读值 + 位测试**——不触发任何异常;
- **`_global_page_poll`**: 所有线程共享一个被 mprotect 成不可读的页,轮询是**读这个页**——页面可读时是 noop,不可读时 SIGSEGV → 信号处理器接管(01-os/04 拆过信号侧)。

JDK11 选哪条由 **`ThreadLocalHandshakes`** 决定——它是 pd product 标志,**x86 默认 true**(实证 PrintFlagsFinal): `SafepointMechanism::default_initialize`(safepointMechanism.cpp:36-39)里 `if (ThreadLocalHandshakes) set_uses_thread_local_poll();`——**所以 JDK11 x86 的默认轮询是 thread-local,不走 SIGSEGV**。全局页模式保留着(关掉 ThreadLocalHandshakes 即可切换,实证里 `-XX:-ThreadLocalHandshakes` 跑 safepoint 照常工作)。

## 2. poll 值: 一个字节里的 armed/disarmed

thread-local 轮询的"看什么"很精巧。轮询指令(x86 编译代码与解释器通用,01 篇提过):

```cpp
// macroAssembler_x86.cpp:3744-3761(截取核心,逐字)
void MacroAssembler::safepoint_poll(Label& slow_path, Register thread_reg, Register temp_reg) {
  if (SafepointMechanism::uses_thread_local_poll()) {
#ifdef _LP64
    assert(thread_reg == r15_thread, "should be");
#else
    ...
#endif
    testb(Address(thread_reg, Thread::polling_page_offset()), SafepointMechanism::poll_bit());
    jcc(Assembler::notZero, slow_path); // handshake bit set implies poll
  } else {
    cmp32(ExternalAddress(SafepointSynchronize::address_of_state()),
        SafepointSynchronize::_not_synchronized);
    jcc(Assembler::notEqual, slow_path);
  }
}
```

**关键设计 (斜体)**: *`testb` 读线程对象里的 `_polling_page` 字段,只看它的第 3 位(`poll_bit()=8`)——`local_poll_armed` 的实现就是 `mask_bits_are_true(thread->get_polling_page(), poll_bit())`(safepointMechanism.inline.hpp:32-35)。armed 与 disarmed 是**两个值**,相差正好这一位: `poll_armed_value = 8 | bad_page`, `poll_disarmed_value = good_page`(safepointMechanism.cpp:50-76)——bad_page 是受保护的页、good_page 是正常页。arm/disarm 只是把线程字段**写成这两个值之一**(`set_polling_page(poll_armed_value())`,safepointMechanism.inline.hpp:50-57)——一次 8 字节写。值还兼作地址: 某些路径 dereference 它时会落在 bad/good 页上,于是"值方案"与"页方案"在同一套数据上兼容。*

[实证:](planning/outlines/00-jvm-tools/materials/commands/18-safepoint-polling-demo.txt) 启动日志 `-Xlog:os` 会打印这两个页: `SafePoint Polling address, bad (protected) page:0x...b54000, good (unprotected) page:0x...b55000`(safepointMechanism.cpp:69)——**两个连续页**,一坏一好。轮询侧的行为差异: 不触发 safepoint 时,`testb` 结果为零、`jnz` 不跳——**一条指令,没有任何额外开销**;触发时跳 slow path → `block_if_requested`(safepointMechanism.inline.hpp:55-60: 未 armed 直接返回,armed 才进 `block_if_requested_slow`)。

**轮询点在哪**: 编译代码的方法返回边、循环回边、调用点(`MacroAssembler::safepoint_poll` 被生成器插入);解释器在**每条字节码**的 dispatch 里轮询(08-02 拆过 dispatch_base 的轮询);native 返回时在 `ThreadStateTransition` 里检查(17 域)。非 Java 线程没有自己的 poll,`local_poll` 退化读全局状态(safepointMechanism.inline.hpp:38-46)。

## 3. 全局页模式: 广播与内核成本

关掉 ThreadLocalHandshakes 后走 `_global_page_poll`: begin() 里 `PageArmed=1` + `os::make_polling_page_unreadable()`(mprotect PROT_NONE,01 篇 begin 步骤 4);所有线程的下一次轮询读(编译代码 `testl %eax, [polling_page]`——只读不写)立即 SIGSEGV → 信号处理器判"这是轮询页故障"→ 走 block(01-os/04 的阶段 2)。"全局"的意思是**广播**: 一个 mprotect,所有线程在各自的下一个轮询点集体命中。

它的代价是内核往返: mprotect 要改页表项、还要 TLB shootdown 通知所有核刷新缓存——这正是 thread-local 方案省掉的(arm 只是一次普通写)。但它有个独到价值: **线程没有显式轮询代码也会被拦住**(只要它 dereference 那个地址)——这对某些不可控的代码路径是保险。

## 4. 验证器: "关键区间不许停"

轮询保证"线程会看到 safepoint";但有些代码路径**绝不希望**在区间内被 safepoint 打断——比如正在改 CardTable 的中间状态,GC worker 若同时来扫就会读到半改数据。`NoSafepointVerifier` 是调试期的"区间保镖":

```cpp
// safepointVerifiers.hpp:89-104(截取核心,逐字)
  NoSafepointVerifier(bool activated = true, bool verifygc = true ) :
    NoGCVerifier(verifygc),
    _activated(activated) {
    _thread = Thread::current();
    if (_activated) {
      _thread->_allow_allocation_count++;
      _thread->_allow_safepoint_count++;
    }
  }

  ~NoSafepointVerifier() {
    if (_activated) {
      _thread->_allow_allocation_count--;
      _thread->_allow_safepoint_count--;
    }
  }
```

[C++:] **大纲的伪代码(记录 counter、析构断言)是错的**——JDK11 的机制是**线程计数**: 构造时把当前线程的 `_allow_safepoint_count`(thread.hpp:335,注释 "If 0, thread allow a safepoint to happen")和 `_allow_allocation_count` 各加一,析构减一。真正的检查在**可能触发 safepoint 的检查点**: `Thread::check_for_valid_safepoint_state`(thread.cpp:995-1006)发现计数非零就 `fatal("Possible safepoint reached by thread that does not allow it")`——比如在持有 `NoSafepointVerifier` 的区间里试图阻塞在锁上、分配对象、发起 VM 操作。release 构建下整个类退化为空(ASSERT 编译掉),零开销;调试期专门抓"在不该停的地方停了"。基类 `NoGCVerifier` 才是"计数断言"的形态——它记 `total_collections()` 并在析构断言没发生 GC(safepointVerifiers.cpp:8-28)。配套的 `PauseNoSafepointVerifier` 用于嵌套场景: 外层禁止 safepoint、内层短暂放行(如等锁)。VM 内部还大量使用其别名——`JRTLeafVerifier`(interfaceSupport.inline.hpp:372)守卫"叶子 JRT 调用"。

## 核心悬念

轮询与验证拆完了: 两种眼睛(thread-local `testb` 第 3 位,x86 默认;全局页 SIGSEGV 广播,信号侧 01-os/04);poll 值的双关(armed/disarmed 是差一位的两个地址,一次写切换);轮询点(编译代码边/解释器 dispatch/native 返回);验证器(NoSafepointVerifier=线程计数+检查点 fatal,release 空实现)。一句话: **轮询是"每步看一眼红绿灯"(最便宜的一步),验证器是"这段路不许有红灯"(debug 期的纪律)**。

但还差最后一块拼图: safepoint **是谁发起的**?GC 只是众多顾客之一——`jcmd GC.run`、JIT 操作、堆转储、JFR 都通过同一个入口排队。下一篇: VM_Operation——"帮我做 GC"从提交到执行。

> → [20-vm-operations/01 — "帮我做 GC"——VM_Operation 从提交到执行](openjdk/vol-02/20-vm-operations/01-vm-operation.md)
