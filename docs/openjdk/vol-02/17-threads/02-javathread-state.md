# 02. 线程怎么告诉 JVM "我不能 safepoint"？— JavaThread 状态机

> **前置依赖**:[17-threads/01 — Thread 层次体系](openjdk/vol-02/17-threads/01-thread-hierarchy.md):JavaThread 的 `_thread_state` 字段与 `run()` 里那次 `transition_and_fence` 在这里展开;[01-os/04 — 信号与安全点](openjdk/vol-02/01-os/04-signals-and-safepoint.md):轮询与 safepoint 的信号面;[09-memory-core/01 — Universe](openjdk/vol-02/09-memory-core/01-universe-heap.md):GC 停世界的协作前提
> → **后续**:[17-threads/03 — Thread-SMR](03-thread-smr-handshake.md)(线程退出后怎么保证不悬垂)
> 关联域: 01-os(信号)、17-threads(线程)、18-safepoint、27-jni(状态转换的消费方)

GC 要停世界时，不能把线程从任何位置硬停：线程若在 JNI native 代码里，栈上没有 Java 帧可恢复；若在解释器里，必须停在安全点（方法返回、循环回边、显式 poll 点）。所以每个 Java 线程随身带一个状态位——`_thread_state`，随时回答“我现在在哪、能不能停”。

本篇要回答的核心问题:

1. `JavaThreadState` 为什么不是普通的五态枚举，而要额外多出一套 trans 状态？
2. 状态切换为什么不是简单 `set + fence`，而是必须嵌进 safepoint 检查？
3. jdk11u 默认轮询为什么不再依赖全局 `mprotect` 轮询页，而改成线程本地轮询位？
4. 线程退出为什么还不能直接 `delete this`？

答案会反复落到一句话：**JavaThread 状态机的核心不是“标记线程在干什么”，而是“给 safepoint 一个可证明的协作协议”：真状态回答“我现在在哪”，trans 状态回答“我正在从 X 走向 Y”；每次进出 VM 的状态转换都顺手做一次 safepoint 检查；jdk11u 默认用线程本地轮询位代替全局页保护；线程退出则通过 `_terminated` 四态把“已经离开业务代码”与“还不能立刻回收对象身份”分开。**

---

## 1. 先试两个最自然的理解，看看为什么都不对

### 误解一：`_thread_state` 只是一个调试时看的枚举

如果它只是“当前在 Java / VM / native / blocked”的调试枚举，那普通五态就够了。

问题在于，safepoint 发起线程看见的不是静态快照，而是**正在变化的线程世界**。一个线程可能刚从 Java 进入 VM，还没来得及完全切过去；也可能刚从 VM 准备回 native。只知道“它原来在哪”和“它最后想去哪”还不够，必须知道**它现在正处在转换途中**。

这正是 trans 状态存在的意义：让 safepoint 发起方看见“我不在稳定态，我正在过桥”。

### 误解二：jdk11u 还在用“把全局轮询页 mprotect 成 PROT_NONE”的老办法

这是很多人脑子里默认的 safepoint 图像：要停世界时把全局 polling page 设成不可读，线程一读就 SIGSEGV。

但 jdk11u 在 64 位 x86 默认 `ThreadLocalHandshakes=true`，轮询已经变成**线程本地轮询位**。armed / disarmed 的差别不是页权限，而是每个线程自己 `_polling_page` 里某个 bit 的值。JIT 里对应的是一条 `testb` + 条件跳转，而不是页故障。

---

## 2. `JavaThreadState`：五个真身，两种过渡

`JavaThreadState` 定义在 `globalDefinitions.hpp`，不是在 `thread.hpp` 里。最关键的一句注释已经把设计意图点透：

```cpp
// globalDefinitions.hpp:888-905(截取核心,逐字)
// Given a state, the xxxx_trans state can always be found by adding 1.
//
enum JavaThreadState {
  _thread_uninitialized     =  0,
  _thread_new               =  2,
  _thread_new_trans         =  3,
  _thread_in_native         =  4,
  _thread_in_native_trans   =  5,
  _thread_in_vm             =  6,
  _thread_in_vm_trans       =  7,
  _thread_in_Java           =  8,
  _thread_in_Java_trans     =  9,
  _thread_blocked           = 10,
  _thread_blocked_trans     = 11,
  _thread_max_state         = 12
};
```

这不是“0-6 五个状态”的普通枚举，而是：

- 五个真状态：`_thread_new / _thread_in_native / _thread_in_vm / _thread_in_Java / _thread_blocked`
- 每个真状态对应一个 **+1 的 trans 过渡状态**

也就是说，奇数值不是“另一个稳定状态”，而是“**正在从 X 去 Y**”。

五个真状态的语义是：

- `_thread_new`：刚构造、还没就绪；
- `_thread_in_native`：在 JNI/native 代码里；
- `_thread_in_vm`：在 VM 内部执行，通常在碰 VM 数据结构；
- `_thread_in_Java`：在解释器、编译代码或 stub 里；
- `_thread_blocked`：阻塞在 monitor/sleep/park，已经在安全位置——这里的“安全”不是说它不持有任何 VM 资源，而是它已经不在继续执行 Java/VM 指令流，safepoint 可以把它视为静止态。

字段本身是 `volatile JavaThreadState _thread_state`（`thread.hpp:1038`）。在 x86 上通常直接读写 volatile 就够；在 PPC64/AArch64 等平台，访问还要额外加屏障。`thread.inline.hpp:146-150` 是 x86 路径的 acquire/load 版本。

---

## 3. 换状态那一瞬间：trans 三拍

### 为什么先写 `from+1`，再写 `to`

先记一个 API 面的小边界：`transition_from_java` / `transition_from_native` 只是对常见 from-state 的薄包装，真正的协议都落在底层 `transition(...)` 与 `transition_and_fence(...)` 上。

状态转换不只是“set + fence”，而是三拍：

```cpp
// interfaceSupport.inline.hpp:112-128(截取核心,逐字)
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
```

三拍是：

1. **先写 trans 状态 `from + 1`**：告诉 safepoint 发起线程“我正在从 X 往 Y 转换”；
2. **序列化线程状态**：保证别的线程能看到这次状态变化；
3. **`block_if_requested(thread)`**：把 safepoint 检查点嵌进转换里；如果此时正好发起 safepoint，这个线程就在这里自己停住；然后才写终态 `to`。

这就是 trans 状态的真正价值：safepoint 发起方不用猜“它到底已经到 Y 没有”，看到奇数态就知道“它在过桥，还没稳定下来”。

### 序列化：内存屏障或“伪远程 membar”

`serialize_thread_state_internal`(interfaceSupport.inline.hpp:82-97)有两条路：

- `UseMembar` 时直接 `OrderAccess::fence()`；
- 否则写序列化页，让 VM 线程做 pseudo remote membar。

所以状态切换的关键不只是“写一个值”，而是**让别的线程在 safepoint 协议里确实看见这个新值**。

### `transition_and_fence`

`transition_and_fence` 与普通 `transition` 的差别只在于序列化用带异常处理的版本，用来照顾某些平台/上下文里没有现成调用桩包裹的情况。核心三拍并没有变。`interfaceSupport.inline.hpp:136-148`

所以最该记住的一句话是：**状态切换本身就是 safepoint 协议的一部分，不是切完状态以后才去顺手检查一下。**

---

## 4. 线程本地轮询：jdk11u 默认不再靠全局页保护

`SafepointMechanism` 维护两种轮询类型：

- `global_page_poll`
- `thread_local_poll`。`safepointMechanism.hpp:34-46`

在 jdk11u 的 64 位 x86 默认配置里，`ThreadLocalHandshakes=true`，会选择线程本地轮询。

### armed/disarmed 是 bit，不是页权限

线程本地轮询的 armed/disarmed 不是靠 `mprotect`，而是靠每线程 `_polling_page` 里的某个 bit 值：

- arm：`set_polling_page(poll_armed_value())`
- disarm：`set_polling_page(0)`

判断函数也非常直接：

```cpp
// safepointMechanism.inline.hpp:32-35(截取核心,逐字)
bool SafepointMechanism::local_poll_armed(JavaThread* thread) {
  const intptr_t poll_word = reinterpret_cast<intptr_t>(thread->get_polling_page());
  return mask_bits_are_true(poll_word, poll_bit());
}
```

### JIT 里的一行轮询指令

JIT 生成的轮询点（方法返回、循环回边等）在 x86 上会变成：

```cpp
// macroAssembler_x86.cpp:3744-3756(截取核心,逐字)
void MacroAssembler::safepoint_poll(Label& slow_path, Register thread_reg, Register temp_reg) {
  if (SafepointMechanism::uses_thread_local_poll()) {
    ...
    testb(Address(thread_reg, Thread::polling_page_offset()), SafepointMechanism::poll_bit());
    jcc(Assembler::notZero, slow_path);
```

所以默认路径里**没有 SIGSEGV，只有一次内存读和位测试**。armed 时 bit=1，跳 slow_path 进 safepoint 流程；disarmed 时 bit=0，继续跑。

### 检查点在两处互补

- **轮询点**：覆盖正在执行的 Java/compiled code；
- **状态转换里的 `block_if_requested`**：覆盖进出 VM 的瞬间。

两者合起来，才构成完整的 safepoint 协议覆盖面。

---

## 5. 终止协议：线程退出为什么还不能直接删掉自己

线程退出也有自己的状态机。`thread.hpp:1044-1058` 定义了 `_terminated` 的四态：

```cpp
// thread.hpp:1044-1058(截取核心,逐字)
enum TerminatedTypes {
  _not_terminated = 0xDEAD - 2,
  _thread_exiting,
  _thread_terminated,
  _vm_exited
};
```

关键边界：

- `_thread_exiting`：`JavaThread::exit()` 已经进入；
- `_thread_terminated`：已经从 Threads 列表摘掉；
- `_vm_exited`：VM 整体结束了，但这个线程可能还卡在 native 代码里。

### 为什么不是立刻 `delete this`

`JavaThread::exit` 会释放 JNI 句柄块、移除栈保护页、唤醒 join 等待者，最后把自己从 Threads 列表移除。但这并不等于“别人再也不可能拿着它的指针”。

因此后面还要看它是不是仍在受别的遍历器/读者持有。如果还在列表里或仍可能被别人看到，就走 `smr_delete()` 交给 `ThreadsSMRSupport::smr_delete` 延迟回收；否则才允许直接 `delete this`。`thread.cpp:208-213`、`thread.cpp:1902-2101`

所以 `_terminated` 不是简单的 alive/dead 标记，而是把“业务逻辑结束了”和“对象身份现在可不可以安全回收”拆开的协议。

---

## 6. 误解澄清与收网

1. **`_thread_state` 只是调试枚举吗?** 不是。它是 safepoint 协议的一部分，trans 状态明确表达“我正在过桥”。
2. **状态切换只是 `set + fence` 吗?** 不是。真正的三拍是：写 trans → 序列化 → `block_if_requested` → 写终态。
3. **jdk11u 默认仍靠全局轮询页 `mprotect` 吗?** 不是。默认 64 位 x86 走线程本地轮询位。
4. **线程退出了就能立刻 `delete this` 吗?** 不行。还要经过 `_terminated` 与 SMR 的延迟回收协议。
5. **轮询和状态转换是两套独立 safepoint 机制吗?** 不是。它们是互补的两个检查点：一个覆盖 Java 代码执行中，一个覆盖进出 VM 的瞬间。

把这一篇压成三句话：

- **真状态 + trans 状态 + 检查点嵌在转换里**，共同构成 JavaThread 的 safepoint 协议。
- **jdk11u 默认用线程本地轮询位**，把“停世界”从全局页权限翻转降级成每线程一次 bit 测试。
- **线程退出不是 alive/dead 二元切换**，而是 `_terminated` 四态加上 SMR 延迟回收。

下一篇: Thread-SMR——线程对象退出后，别的线程可能还握着它的指针，怎么安全回收而不悬垂。

> → [17-threads/03 — Thread-SMR](03-thread-smr-handshake.md)