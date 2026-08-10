# PROMPT: 请撰写 07-Unsafe-Implementation.md

## 一、任务

撰写一篇深度的 JVM 源码分析文档，主题：**Unsafe Implementation — `compareAndSwapInt()` 到 `lock cmpxchg` 的完整硬件链路、`park()/unpark()` 的 Parker 计数器机制与 pthread 映射、内存屏障在 x86 TSO 上的"零指令"哲学、`defineAnonymousClass()` 的特殊类加载路径**

### 核心故事线（禁止做源码翻译机！）

Java 程序员都知道 `AtomicInteger` 是线程安全的，但很少有人追问"线程安全"一个字背后的硬件真相。当你写 `atomicInt.compareAndSet(0, 1)` 时——JDK 层委派给 `Unsafe.compareAndSwapInt()` → `jdk.internal.misc.Unsafe` 的 native 方法 → JVM 中的 `Unsafe_CompareAndSetInt()` → `HeapAccess::atomic_cmpxchg_at()` → `Atomic::cmpxchg()` → x86 内联汇编 `lock cmpxchgl`。**这 6 层调用链把 Java 的一个 CAS 操作，精确定义为 CPU 的一条原子指令。** 理解了这个链，你就从"高级语言程序员"变成了"能看懂 CPU 指令集手册的人"。

[09-01] 讲线程状态转换、[09-04] 讲 JVM_ENTRY 宏——Unsafe 是这两个机制的特殊应用：Unsafe 函数也用 `UNSAFE_ENTRY` 宏（展开为 `JVM_ENTRY(static, ...)`，`unsafe.cpp:65-66`），所以同样注入 `ThreadInVMfromNative` RAII。但 `Unsafe_Park` 在此基础上又引入了 `ThreadBlockInVM`——**在一个 JVM 入口函数内发生两次线程状态改变**：native→VM（`UNSAFE_ENTRY`）→ blocked（`ThreadBlockInVM`）。这是 [09-01] 没有覆盖的"二阶状态转换"。

本文的另一个核心是 **Parker 的计数器机制怎么用 xchg + mutex + cond 的三层协议避免 lost wakeup**——这是 `LockSupport.park()` / `Futures.get()` / `Thread.sleep()` 的底层实现。理解了这个，你就理解了为什么 `unpark()` 可以在 `park()` 之前调用（permit 语义）。

### 核心叙事线

1. **★ CAS 的 5 层调用链 — Java 到 x86 `lock cmpxchg` 的逐层穿透** — `Unsafe_CompareAndSetInt()`（`unsafe.cpp:912-921`）→ `HeapAccess<>::atomic_cmpxchg_at()`（分配 oop 场景）或 `RawAccess<>::atomic_cmpxchg()`（off-heap 场景）→ `Atomic::cmpxchg(x, addr, e)` → `CmpxchgImpl::operator()` → `PlatformCmpxchg<4>()` → **内联汇编**: `lock cmpxchgl %1,(%3)`（`atomic_linux_x86.hpp:81-91`）。追问：**为什么 CAS 需要 `lock` 前缀？不是已经是原子指令了吗？** → 在多核系统中 `cmpxchg` 指令本身是原子的（CPU 保证不可中断），但 `lock` 前缀额外做了：锁缓存行 → 阻止其他核心的读写 → 保证 RMW（Read-Modify-Write）不被交叉。没有 `lock` → CPU 内原子但多核间不原子。追问：**`lock cmpxchgl` 的延迟是多少？** → L1 cache hit: ~20 cycles; L2 hit: ~40-60 cycles; contention: 100+ cycles。这就是所谓的 "CAS 开销 ≈ 50-100ns"。

2. **★★ HeapAccess vs RawAccess — 为什么 CAS 要区分堆上和堆外** — `Unsafe_CompareAndSetInt` 先检查 `p == NULL`（L914）→ NULL 表示 off-heap 地址 → `RawAccess<>::atomic_cmpxchg()`（直接读内存）。非 NULL 表示堆上对象 + offset → `HeapAccess<>::atomic_cmpxchg_at()`（通过 `AccessInternal::atomic_cmpxchg_at` 处理 GC barrier + compressed oop 解压）。★ 关键发现：**off-heap CAS 不需要 GC barrier** — 因为地址不在 GC 管理范围内。但堆上 CAS 需要——对象可能刚被 GC 移动，地址未更新。追问：**HeapAccess 的 MO_SEQ_CST 为什么重要？** → 见 3。

3. **★★★ `MemoryAccess<T>` 模板和 `GuardUnsafeAccess` — 为什么 getVolatile 是 `MO_SEQ_CST` 而 get 只是 `MO_UNORDERED`** — `unsafe.cpp:156-256`：`MemoryAccess<T>` 的 `get()` (:216) 使用 `HeapAccess<>::load_at()` — 默认 MO_UNORDERED → 无 barrier → 可能有 stale read。`get_volatile()` (:237-246) 使用 `HeapAccess<MO_SEQ_CST>::load_at()` → 触发 acquire barrier → 保证读取最新值。追问：**在 x86 TSO 上 acquire 真的需要 CPU 指令吗？** → 不需要——`OrderAccess::acquire()` 在 x86 上是 `compiler_barrier()`（`orderAccess_linux_x86.hpp:45`）——只是阻止编译器重排。但 Java Memory Model (JMM) 要求的 volatile read 语义（happens-before）可以通过 TSO 天然保证——x86 的 load 不会 reorder 过 store。★ 这就是 `putOrdered` 在 x86 上等价于普通写的原因——x86 TSO 已经保证了 store-store order → StoreStore barrier = compiler_barrier。

4. **★★ 内存屏障的分类和 x86 上的"空转"哲学** — `orderAccess_linux_x86.hpp:36-48` 定义了完整的 barrier 层次：(a) `loadload()` (:40) — x86 不需要 → `compiler_barrier()`。(b) `storestore()` (:41) — x86 也不需要（TSO 保证 store order）→ `compiler_barrier()`。(c) `loadstore()` (:42) — x86 也不需要 → `compiler_barrier()`。(d) `storeload()` (:43) — **这是唯一需要真正 CPU 指令的** → `fence()` (:48) → `lock; addl $0,0(%%rsp)`。追问：**为什么 storeload 是唯一需要硬件 fence 的？** → 因为 store buffer 的存在——写操作先进入 store buffer 然后异步写入 L1。后续的 load 可以从 L1 读——可能读到旧值。`lock; addl $0,0(%%rsp)` 会 flush store buffer → 保证之前的写对所有 CPU 可见。追问：**volatile write 为什么需要这个？** → JMM 要求 volatile write 不能和后续任何操作重排 → storeload = 完全屏障。这就是为什么 volatile 写比普通写慢 10-100 倍。

5. **★★★ Parker 的 counter 机制 — 如何用 xchg + mutex + cond 的三层协议避免 lost wakeup** — `Parker::park()`（`os_posix.cpp:2160-2243`）：**(1) 快速路径**：`Atomic::xchg(0, &_counter) > 0`（L2166）→ 原子 swap counter → 如果之前是 1 → consume permit → 立即返回（不等锁）。**(2) 中断检查**（L2174）。**(3) `ThreadBlockInVM`**（L2193）→ 线程状态 _thread_in_vm → _thread_blocked → 允许 safepoint。**(4) `pthread_mutex_trylock`**（L2198）→ 尝试获取 Parker 的私有 mutex → 如果失败（被 unpark 持有着）→ 放弃等待返回（隐含已经收到信号）。**(5) 双重检查 `_counter > 0`**（L2203）→ 如果在获取 mutex 之间 unpark 运行了 → _counter 被设为 1 → consume → 返回。**(6) `pthread_cond_wait`**（L2220）→ 在 _cond[REL_INDEX] 上等待。**Parker::unpark()**（L2245-2268）：获取 mutex → 读旧 counter → 设 _counter=1 → 记录当前 cond index → 释放 mutex → **在锁外 signal**（避免"侏儒信号问题"）。追问：**为什么 signal 在 unlock 之后？** → 注释（L2255-2261）说明："This provides particular benefit if the underlying platform does not provide wait morphing." 如果 signal 在锁内 → 被唤醒的线程立即尝试获取 → 但锁还被 holder 持有 → 立即 sleep → 上下文切换 → futrie wakeup。锁外 signal → 被唤醒的线程能立即拿到锁。追问：**lost wakeup 怎么防止的？** → 关键在于 xchg 在 trylock 之前：如果 unpark 在 xchg 之后、trylock 之前执行 → xchg 已经 consume 了旧 counter（0）→ unpark 设 counter=1 → trylock 成功 → double check 看到 counter=1 → 返回。如果 unpark 在 trylock 之后 → cond_signal 唤醒 wait。

6. **★★ `Unsafe_DefineAnonymousClass()` 的特殊类加载路径 — 为什么不走常规 ClassLoader** — `Unsafe_DefineAnonymousClass0()`（`unsafe.cpp:835-861`）→ `Unsafe_DefineAnonymousClass_impl()`（`unsafe.cpp:745-833`）：(a) 复制 class bytes 到 C-heap（`ArrayAccess<>::arraycopy_to_native()` L770），(b) 找到 host class（非匿名祖先类 L783-786），(c) 通过 `ClassFileParser` 解析 class → `SystemDictionary::parse_stream()` → 创建 `InstanceKlass`，(d) **不注册到任何 ClassLoader** → 生命周期由 host class 的 mirrors 决定 → 当 mirror 被 GC → anonymous class 也可回收。追问：**和普通类加载的本质区别？** → 普通类：`ClassLoader.defineClass()` → `SystemDictionary` 登记 → ClassLoader 持有引用 → 类不回收（除非 ClassLoader 被 GC）。匿名类：只被 mirror（Class 对象）引用 → mirror 存活则类存活 → 更灵活的 GC 语义。追问：**生成的 bytecode class（GeneratedMethodAccessor）为什么用 defineAnonymousClass？** → 因为每 Method 生成一个类 → 类数量 = 反射方法数 → 如果用普通 ClassLoader → 每个类永久占用 Metaspace → 泄漏。

7. **★ `Unsafe_AllocateInstance()` 的巧妙 — 不调构造函数** — `unsafe.cpp:366-369`：直接调用 `env->AllocObject(cls)` → JNI 的 `AllocObject` 只分配对象空间 + 设零 → **不调任何构造函数**。这就是为什么 `Unsafe.allocateInstance()` 可以绕过 `private` 构造函数创建对象（如 `java.lang.Class` 的内部实例）。追问：**这是否违反 Java 语义？** → 是——这是 JVM 的"后门"。只被 serializer（如 Kryo, Java Serialization）和 framework（如 Spring CGLIB）使用。JEP 320 (JDK 11+) 建议开发者不要直接使用 `Unsafe.allocateInstance()`——应使用 `MethodHandles.Lookup.defineClass()` 替代。

### 禁止行为

- ❌ 把 `atomic_linux_x86.hpp` 的内联汇编当"神秘的机器码"跳过——必须逐行注释每个寄存器的作用
- ❌ 忽略 `HeapAccess` 和 `RawAccess` 的 GC barrier 区别——off-heap CAS 不需要 barrier 是核心知识点
- ❌ 忽略 Parker 的 xchg-mutex-cond 三层协议的"为什么"——只说"有三层"不解释每层的必要性
- ❌ 忽略 x86 TSO 的内存屏障"零指令"哲学——StoreStore barrier 在 x86 上不是 fence，是 compiler barrier
- ❌ 把 `defineAnonymousClass()` 仅仅当"类加载的变体"——它是 GC 友好的类生命周期管理
- ❌ 忽略 [09-01] 的连接——Unsafe_Park 是"二阶线程状态转换"在 09 阶段的唯一案例
- ❌ 不解释 `Unsafe_GetObjectVolatile` vs `Unsafe_GetObject` 的根本区别——一个是 `MO_SEQ_CST` 一个是 `MO_UNORDERED`
- ❌ 忽略 `MemoryAccess<T>` 模板中 get/put/get_volatile/put_volatile 四个变体的差异

### 要求行为

- ✅ **★ CAS 5 层调用链的逐层穿透图** — 从 Unsafe_CompareAndSetInt 到 lock cmpxchgl 的每一层（Java → JNI → C++ VM → Atomic 模板 → 内联汇编），每层标注参数形式和返回值变化
- ✅ **★ 内联汇编逐行注释** — `lock cmpxchgl %1,(%3)` 的每个操作数含义、lock 前缀的作用、为什么用 volatile
- ✅ **★ Parker counter 状态自动机** — 从 0 到 1 的状态转换、xchg 的原子语义、mutex 保护窗口、cond wait 条件
- ✅ **★ Parker 的 park/unpark 竞态场景分析** — 至少 3 个真实竞态场景分析：(1) unpark before park, (2) park sees counter but xchg loses to unpark, (3) double park (counter already 0)
- ✅ **★ 内存屏障 x86 分类表** — loadload/storestore/loadstore/acquire/release/fence 在 x86 上的实现、需要的 CPU 指令、JMM 对应关系
- ✅ **★ putOrdered vs volatile write 的 micro-benchmark 对比** — 用汇编层的指令数证明为什么 putOrdered 更快
- ✅ **★ 和 [09-01][09-04] 的交叉验证** — `UNSAFE_ENTRY` → `JVM_ENTRY` 宏展开、`Unsafe_Park` 的 `ThreadBlockInVM` 二次状态转换
- ✅ **★ GDB 可证伪断言 ≥10 条** — CAS 内联汇编反汇编验证、Parker counter 读写、defineAnonymousClass 的 constPool 状态

## 二、标准环境

- OpenJDK 11 slowdebug build
- `-Xms8g -Xmx8g -XX:+UseG1GC`
- 64 位 Linux x86
- ★ GDB 在 slowdebug build 中验证（`#ifdef ASSERT` 全部生效）
- ★ 需要 `-XX:+PrintAssembly` 或 `perf record` 验证 x86 指令

## 三、聚焦源文件

| # | 文件 | 完整路径 | 模块 | 核心方法/类（需验证行号） | 本文角色 |
|---|------|---------|------|---------------------|---------|
| 1 | `unsafe.cpp` | `src/hotspot/share/prims/unsafe.cpp` | prims | `UNSAFE_ENTRY` 宏(:65)、`UNSAFE_LEAF`(:68)、`MemoryAccess<T>`(:156-256)、`Unsafe_CompareAndSetInt`(:912)、`Unsafe_CompareAndSetLong`(:923)、`Unsafe_Park`(:944)、`Unsafe_Unpark`(:965)、`Unsafe_DefineAnonymousClass0`(:835)、`Unsafe_DefineAnonymousClass_impl`(:745)、`Unsafe_AllocateInstance`(:366)、`Unsafe_LoadFence/StoreFence/FullFence`(:352-362) | ★★★ 全部 Unsafe 实现 — CAS/Park/Class 一个文件 |
| 2 | `unsafe.hpp` | `src/hotspot/share/prims/unsafe.hpp` | prims | `JVM_RegisterJDKInternalMiscUnsafeMethods`(:31)、`field_offset_to_byte_offset`(:35)、`field_offset_from_byte_offset`(:37) | ★ 接口声明 |
| 3 | `atomic_linux_x86.hpp` | `src/hotspot/os_cpu/linux_x86/atomic_linux_x86.hpp` | os_cpu | `PlatformCmpxchg<1>`(:67)、`PlatformCmpxchg<4>`(:81)、`PlatformCmpxchg<8>`(:123)、`PlatformXchg<4>`(:54)、`PlatformXchg<8>`(:111) | ★★★ CAS 内联汇编 — Java 到 CPU 的最后一步 |
| 4 | `orderAccess_linux_x86.hpp` | `src/hotspot/os_cpu/linux_x86/orderAccess_linux_x86.hpp` | os_cpu | `compiler_barrier()`(:36)、`loadload()`(:40)、`storestore()`(:41)、`acquire()`(:45)、`release()`(:46)、`fence()`(:48) | ★★★ 内存屏障 — x86 TSO 的"零指令"哲学 |
| 5 | `os_posix.cpp` | `src/hotspot/os/posix/os_posix.cpp` | os | `Parker::park()`(:2160-2243)、`Parker::unpark()`(:2245-2268) | ★★★ Parker 实现 — park/unpark 到 pthread 的映射 |
| 6 | `park.hpp` | `src/hotspot/share/runtime/park.hpp` | runtime | `Parker` 类定义(:48-73)、`_counter` volatile (:50)、`FreeList`(:72) | ★★ Parker 类结构 — counter 机制定义 |
| 7 | `os_posix.hpp` | `src/hotspot/os/posix/os_posix.hpp` | os | `PlatformParker`(:205-220) — pthread_mutex_t + pthread_cond_t | ★★ POSIX 同步原语定义 |
| 8 | `interfaceSupport.inline.hpp` | `src/hotspot/share/runtime/interfaceSupport.inline.hpp` | runtime | `ThreadBlockInVM` ctor/dtor (:297-306)、`ThreadInVMfromNative` ctor/dtor (:268-273) | ★★ 线程状态转换 — 二阶转换的 RAII |

**跨模块说明**：Unsafe 是 JVM 中最跨模块的子系统 — prims（unsafe.cpp）→ os_cpu（CAS/barrier 汇编）→ os（pthread Parker）→ runtime（线程状态）。每次调用跨越 4 个模块的边界。

## 四、必须深度走读的核心概念

> 以下不是答案——是必须从源码中挖掘答案的问题列表。每道题先定位源文件行号，再回答"为什么"，最后用 3-5 行关键源码做引证。

### 4.1 ★★★ CAS 的 5 层调用链与 `lock cmpxchg` 的硬件本质

```
问题：
  ① Unsafe_CompareAndSetInt 为什么分两条路径（HeapAccess vs RawAccess）？
      线索: unsafe.cpp:912-921
      答案方向: HeapAccess — 目标在 JVM 堆上 → 需要 compressed oop 解码 + GC barrier（SATB for G1）。
      RawAccess — 目标在 off-heap（DirectByteBuffer, native memory）→ 无 oop 语义 → 不需要 GC barrier。
      追问: 如果 off-heap CAS 错误地使用了 HeapAccess (p != NULL) → 会怎样？
      → assert_field_offset_sane 会 fire (检查 offset < MAX_OBJECT_SIZE) → 因为 heap 对象的 offset 必须合理。
      这个 assert 在 product build 中不存在 → 但读写可能走到随机的堆对象 → corrupt heap。

  ② PlatformCmpxchg<4>::operator() 的详细内联汇编每个寄存器/操作数的作用？
      线索: atomic_linux_x86.hpp:81-91
      答案方向: 
        __asm__ volatile (
          "lock cmpxchgl %1,(%3)"        // %1=exchange, (%3)=[dest] — ALWAYS 锁缓存行
          : "=a" (exchange_value)        // output: exchange_value = %0 = %eax 输出 (执行后的旧值)
          : "r" (exchange_value),        // input:  %1 的值 (新值) 放任意寄存器
            "a" (compare_value),         // input:  %2 = %eax (期望值 — cmpxchg 隐式比较 %eax)
            "r" (dest)                   // input:  %3 = %rdi/%rsi 目标地址
          : "cc", "memory");              // clobber: 条件码寄存器 + 内存屏障
      语义: if (*(int*)dest == %eax) { *(int*)dest = exchange; ZF=1 } else { %eax = *(int*)dest; ZF=0 }。
      追问: 为什么 "memory" clobber 被列出？→ 这是 GCC 编译屏障 — 告诉编译器内存可能被改变 —
      不要将 cmpxchg 重排到其他内存操作之间。

  ③ Atomic::xchg 和 Atomic::cmpxchg 的区别？
      线索: atomic_linux_x86.hpp:54 vs :81
      答案方向: xchg — 无条件交换（old = mem; mem = new）。xchg 本身隐含 lock 语义（x86 保证 —
      甚至不需要 lock 前缀！在 Intel 手册中 xchg 是隐式锁的内存操作）。
      cmpxchg — 有条件交换（if mem == expected then mem = new else skip）。必须在前面加 lock 前缀
      来保证多核原子性。追问: 为什么 Parker 用 xchg 而不是 cmpxchg？→ xchg 不需要比较 —
      无条件 consume counter — 这正是 permit 语义（总是消费）。

  ④ HeapAccess::atomic_cmpxchg_at 经历了哪些层到 Atomic::cmpxchg？
      答案方向: HeapAccess<MO_SEQ_CST>::atomic_cmpxchg_at(x, obj, offset, e)
      → AccessInternal::atomic_cmpxchg_at(x, obj, offset, e, MO_SEQ_CST)
      → BarrierSet::atomic_cmpxchg_at + decorators
      → RawAccessBarrier<MO_SEQ_CST>::atomic_cmpxchg(x, addr, e) [GS barrier 已处理]
      → Atomic::cmpxchg(x, addr, e)
      → CmpxchgImpl<T,T,T>::operator() → PlatformCmpxchg<sizeof(T)>::operator()
      → lock cmpxchg。共 5 层模板 + 汇编。
```

### 4.2 ★★★ Parker 的 counter 机制 — 三层协议防 lost wakeup

```
问题：
  ① 为什么 park() 需要 3 个步骤（xchg → trylock → recheck counter）而不是 1 个？
      线索: os_posix.cpp:2166, 2198, 2203
      答案方向: (a) xchg — 无锁快速路径: 如果 permit 已发 → 立即返回，不等锁（~5ns）。
      (b) trylock — 检查是否有 unpark 在进行: 如果 unpark 持锁 → 说明 unpark 正在操作 → park 马上会被唤醒 → 放弃等待。
      (c) recheck counter — 防止 xchg 和 trylock 之间的窗口: unpark 刚好在这个窗口执行 → counter 现在是 1 → consume → 返回。
      追问: 如果只有 xchg 一步 → 没有 mutex 保护 → 和 cond_wait 不同步 → 信号丢失。
      追问: 如果只有 trylock + cond_wait → 没有 xchg 快速路径 → 每次 park 都要进入 mutex → 慢。

  ② Parker 的 3 种竞态场景分析 — 哪个路径最微妙？
      场景 A (unpark before park): unpark 设 counter=1 → park xchg → 看到 counter=1 → 返回（快速路径）。✓
      场景 B (park sees counter=0, then unpark runs during ThreadBlockInVM): unpark 设 counter=1 + signal。
      但 condition variable 还没有 wait 在上面 → 信号丢失！→ 但 counter=1 → park 重新检查 counter=1 → 返回。✓
      场景 C (park xchg counter=0, unpark in window between xchg and trylock): unpark 设 counter=1 + mutex lock。
      park 在 trylock 时 → 要么 mutex 被 unpark 持有 → trylock 失败 → 返回（合理 ✓）。
      要么 mutex 马上被释放 → trylock 成功 → double check → counter=1 → 返回。✓
      追问: 哪个路径最微妙？→ 场景 B — 这就是为什么需要 double check counter: cond_signal 可能丢失（无人 wait），但 counter 永不错过。

  ③ 为什么 Parker 用 pthread_mutex_trylock 而不是 pthread_mutex_lock？
      线索: os_posix.cpp:2198
      答案方向: 如果用 lock → park 可能一直阻塞在 mutex 上（unpark 可能持锁时间较长）→ 
      线程在 _thread_blocked 状态 → 不能响应 safepoint → VMThread 的 safepoint begin 在此线程上 SPIN → 
      可能导致长时间 STW。trylock → 如果失败 → 立即返回 → park 退出 → 线程回到 _thread_in_vm → 
      如果 safepoint 正在进行 → 在 ThreadBlockInVM 的 dtor 中 block → 不影响 STW。
```

### 4.3 ★★ x86 TSO 的内存屏障"零指令"哲学

```
问题：
  ① 为什么 x86 上 storestore 不需要 CPU fence，但 ARM 上需要？
      线索: orderAccess_linux_x86.hpp:41
      答案方向: x86 的 TSO (Total Store Order) 模型保证: 所有 core 看到的 store 顺序一致。
      ARM 的 relaxed memory model → store 可以重排 → 需要 dmb ishst (Data Memory Barrier inner shareable, store only)。
      追问: Java 程序在 x86 上跑和在 ARM 上跑 → 同一个 volatile 写有什么不同的汇编？
      → x86: lock; addl $0,0(%%rsp) (storeload)。ARM: dmb ish (full barrier)。x86 约 20-50 cycles, ARM 可达 100+ cycles。

  ② 为什么 acquire 在 x86 上只是 compiler barrier？
      线索: orderAccess_linux_x86.hpp:45
      答案方向: x86 保证 load 不会 reorder over 其他 load → 自然的 load acquire 语义。
      只需要阻止编译器重排 → compiler_barrier() → __asm__ volatile ("" : : : "memory") → 0 CPU 指令。
      追问: ARM 上 acquire 需要什么？→ ldapr (load with acquire semantics) 或 dmb ishld → 需要 CPU 指令。

  ③ fence() 的实现 lock; addl $0,0(%%rsp) 为什么操作栈顶？
      线索: orderAccess_linux_x86.hpp:48
      答案方向: 这是最便宜的 lock 前缀指令 — addl $0 不改变任何值（加 0），但 lock 前缀强制 flush store buffer。
      操作栈的动机: 栈顶几乎一定在 L1 cache → 锁操作延迟最小。如果用任意内存地址 → 可能 cache miss → 额外 latency。
      追问: mfence 指令呢？→ Intel 也有 mfence → 但历史原因 HotSpot 用 lock; addl — 在某些旧 CPU 上 lock; addl 比 mfence 稍快。
      现代 CPU (Skylake+) → mfence ≈ lock; addl ≈ 30-40 cycles。JDK 14+ 的某些版本已切换到 mfence。

  ④ release_store 为什么用 xchg 而不是 lock addl？
      线索: orderAccess_linux_x86.hpp:59-104 PlatformOrderedStore 的 xchg 实现
      答案方向: release_store 的语义是 "store + release barrier (StoreLoad)" → 不仅保证此 store 对后续操作可见，
      还要保证之前的所有 store 也可见。xchg 是隐式全 barrier（自动 lock）+ 执行一次 store → 
      一步完成 store + barrier。lock; addl 只是 barrier 没有 store → 需要额外的 store 指令。
      xchg = store + barrier in 1 operation。追问: 这就是 putOrdered(storestore) vs putVolatile(storeload) 的关键 —
      putOrdered 在 x86 上就是普通 mov → 0 额外指令。
```

### 4.4 ★ Unsafe_DefineAnonymousClass — 不在 ClassLoader 中注册的类

```
问题：
  ① defineAnonymousClass 创建的类和 host class 是什么关系？
      线索: unsafe.cpp:783-786
      答案方向: host class 链 — 如果 host 本身也是匿名类 → 沿 host_klass 链向上 → 找到最上面的非匿名 Host。
      匿名类共享 Host 的 ClassLoader + ProtectionDomain + Package → 但不注册到 SystemDictionary →
      找不到 Class.forName() 的入口。追问: 如何保持 ClassLoader 不被回收？→ 匿名类通过 mirrors
      (Class 对象) 被引用 → 如果 mirror 被 GC → 匿名类可回收。这和普通类不同（ClassLoader 持有类引用）。
      但有一个 trick: `class_loader_data()->inc_keep_alive()` 在创建时增加引用计数 → 在 
      `Unsafe_DefineAnonymousClass0` 的 finally 块中 `dec_keep_alive()` (L856) → 释放此人工保持 →
      mirror 成为唯一引用。

  ② ClassFileParser 在匿名类场景中的特殊行为？
      答案方向: cp_patches_h 参数 — 让 JVM 可以"打补丁"匿名类的 constant pool — 
      把 symbolic references 替换为实际的 direct references。例如:
      generated bytecode 中有 `invokevirtual TargetClass.bar()` → 但 TargetClass.bar() 的常量池
      索引不知道 → 生成 fake 索引 → cp_patches 替换为正确的 Method* 引用。
      追问: 为什么普通 defineClass 不需要 cp_patches？→ 因为普通类的 CP 在编译时已经完全解析。

  ③ DEFINE_GETSETOOP_VOLATILE 模板生成的代码 的 volatile 读写和普通读写的汇编区别？
      线索: unsafe.cpp:329-350 宏定义 + MemoryAccess<T>::get_volatile(:237-246) vs get(:216-226)
      答案方向: get_volatile → HeapAccess<MO_SEQ_CST>::load_at()/RawAccess<MO_SEQ_CST>::load()
      → x86 上 acquire barrer → compiler_barrier (0 CPU 指令)。
      get → HeapAccess<>::load_at()/RawAccess<>::load() → MO_UNORDERED → 
      可能没有 barrier → 编译器可能将 load 提升到循环外 (hoist out of loop) → 读旧值。
      这就是 get 和 getVolatile 的性能差异: 不是硬件指令多寡 — 是编译器优化的许可 — get 可以被极端优化,
      getVolatile 告诉 compiler "每次都要读最新值" → 阻止 hoisting。
```

### 4.5 ★ Unsafe_Park 的"二阶线程状态转换"

```
问题：
  ① Unsafe_Park 内发生了多少次线程状态转换？
      线索: unsafe.cpp:944 + os_posix.cpp:2160
      答案方向: 3 次: (a) UNSAFE_ENTRY → ThreadInVMfromNative ctor → _thread_in_native → _thread_in_vm。
      (b) ThreadBlockInVM ctor → _thread_in_vm → _thread_blocked。如果 park 被唤醒 →
      ThreadBlockInVM dtor → _thread_blocked → _thread_in_vm。(c) UNSAFE_END → ThreadInVMfromNative dtor → 
      _thread_in_vm → _thread_in_native。追问: ThreadBlockInVM 在哪个文件的哪一行？→ 
      interfaceSupport.inline.hpp:297 (ctor → trans_and_fence(_thread_in_vm, _thread_blocked)),
      L306 (dtor → trans_and_fence(_thread_blocked, _thread_in_vm))。和 [09-01] 的 transition_from_native 
      对比: trans_and_fence 含 fence + block_if_requested，trans_from_native 含 poll + block。
      这里的 fence 保证 park 中的所有内存写在回到 _thread_in_vm 前对所有 CPU 可见。

  ② 为什么 Unsafe_Park 用 ThreadBlockInVM 而不是其他状态转换？
      答案方向: _thread_blocked 的线程在 safepoint begin 中被 roll_forward(_at_safepoint) 放行 —
      不需要等待。如果在 _thread_in_vm 中等待 cond_wait → safepoint 无法推进 → 死锁。
      ThreadBlockInVM 告诉 VMThread: "此线程在等 OS 级别的条件 — 不在操作 JVM 对象 — 放行。"
      追问: 为什么 ThreadToNativeFromVM 不是正确的？→ 那会转到 _thread_in_native → 虽然也被放行，
      但 park 是在 VM 中的操作（等 pthread 条件变量） — 应该在 _thread_blocked 中更精准。

  ③ 如果 ThreadBlockInVM 替换为 TransitionToVMFromBlocked 会怎样（错误地使用相反的类）？
      答案方向: TransitionToVMFromBlocked 是从 _thread_blocked → _thread_in_vm — 不是 _thread_in_vm → _thread_blocked。
      线程已经在 _thread_in_vm 中 — 试图转到一个不是当前状态的方向 → assert(thread_state == ...) fire → crash。
```

### 4.6 ★ 内存屏障的分类与 Java 层面的对应

```
问题：
  ① Unsafe_LoadFence / Unsafe_StoreFence / Unsafe_FullFence 在 x86 上的实际机器码是什么？
      线索: unsafe.cpp:352-362
      答案方向: LoadFence → acquire() → compiler_barrier → 0 指令。
      StoreFence → release() → compiler_barrier → 0 指令。
      FullFence → fence() → lock; addl $0,0(%%rsp) → ~30-40 cycles。
      追问: 这就是 VarHandle 的 getAcquire / setRelease / getVolatile / setVolatile 实现的背景知识。
      VarHandle 在 JIT 眼中直接展开为这些 barrier — 无额外方法调用开销。

  ② Unsafe field offset 到 byte offset 的转换 — 为什么需要两套 offset 概念？
      线索: unsafe.cpp:98-103
      答案方向: fieldOffset 是 JVM 内部的"对象内字段偏移"（如相对对象头的字节数）。
      byteOffset 是 Unsafe API 兼容的 "底层指针偏移" — HotSpot 在 openjdk 9+ 中对 object alignment 
      做了调整 → 两个偏移可能不同（如 compressed oop 场景中压缩 vs 未压缩的偏移差 4 倍）。
      追问: 这差异对 Unsafe 调用者的影响？→ 调用 `Unsafe.objectFieldOffset(f)` 得到 fieldOffset，
      然后 `Unsafe.getInt(obj, fieldOffset)` 内部调用 field_offset_to_byte_offset 转换后使用。
      如果直接传递 byteOffset → 读取错误的地址 → corruption。
```

## 五、文章结构

```
§〇 源文件清单（跨 prims + os_cpu + os + runtime，标注模块归属）

§一 ★★★ CAS 的 5 层调用链 — Java 到硬件 `lock cmpxchg` 的完整穿透
  ❓ 为什么需要 HeapAccess 和 RawAccess 两条路径？
  ❓ lock cmpxchg 的每个寄存器是怎么分配的？
  1.1 Layer 1 (Java): AtomicInteger.compareAndSet → Unsafe.compareAndSwapInt
  1.2 Layer 2 (JNI): Unsafe_CompareAndSetInt — UNSAFE_ENTRY 宏
  1.3 Layer 3 (Access): HeapAccess vs RawAccess — GC barrier 的分岔
  1.4 Layer 4 (C++ Atomic): Atomic::cmpxchg → CmpxchgImpl
  1.5 Layer 5 (x86 asm): PlatformCmpxchg<4> — lock cmpxchgl 逐行注释
  1.6 非 x86 平台上的 CAS (ARM LDREX/STREX, PPC ldarx/stdcx)

§二 ★★★ Parker 的 counter 机制 — park/unpark 到 pthread 的映射
  ❓ 为什么 counter 用 xchg 而不是 cmpxchg？
  ❓ 如何防止 lost wakeup？
  2.1 Parker 类结构 (park.hpp:48-73 + os_posix.hpp:205-220)
  2.2 park() 的 6 步执行流程 — xchg → int check → TBIVM → trylock → double check → cond_wait
  2.3 unpark() 的 4 步执行流程 — lock → counter=1 → unlock → cond_signal
  2.4 ★ 3 种竞态场景分析 — unpark before park / xchg-trylock window / double check 捕获
  2.5 JavaThreadParkedState 和 JVM TI 线程状态追踪

§三 ★★ x86 TSO 的内存屏障哲学 — "零指令"的底层理由
  ❓ 为什么 acquire/release 在 x86 上是 0 指令？
  ❓ StoreStore vs StoreLoad 在 JMM 中的确切对应？
  3.1 内存屏障分类 (loadload, storestore, loadstore, storeload) 与 x86 实现
  3.2 fence() = lock; addl $0,0(%%rsp) — 为什么操作栈指针？
  3.3 x86 TSO 的硬件保证 vs ARM Weak Ordering 的差异
  3.4 Java volatile read/write 在两种架构上的汇编对比

§四 ★ Unsafe 的方法全景 — 5 大类 60+ 个 native 方法
  ❓ 哪些是最常使用的？哪些是 JEP 320 建议不要用的？
  4.1 内存操作 (get/put/allocate/free/copy) — Compiler 常量折叠
  4.2 CAS 操作 (CompareAndSet/CompareAndExchange) — JSR-166 的基础
  4.3 线程操作 (park/unpark) — LockSupport 的实现
  4.4 类操作 (defineClass/defineAnonymousClass) — 动态代码生成
  4.5 内存屏障 (fence/loadFence/storeFence/fullFence) — VarHandle 的基础

§五 ★★ defineAnonymousClass — 匿名类的特殊生命周期
  ❓ 为什么匿名类可以被 GC 而普通类不能？
  ❓ cp_patches 参数的意义？
  5.1 匿名类的创建流程 (Unsafe_DefineAnonymousClass_impl)
  5.2 host klass chain 的遍历 (while host is anonymous → go up)
  5.3 ClassDefiner 和 ClassFileParser 的特殊处理
  5.4 keep_alive 的引用计数 — 和 ClassLoader-based 类的 GC 策略对比

§六 ★★ 和 [09-01][09-04] 的交叉验证
  ❓ UNSAFE_ENTRY 宏和在 [09-04] 中 JVM_ENTRY 的区别？
  ❓ Unsafe_Park 的二阶状态转换 — [09-01] 没覆盖的场景
  6.1 UNSAFE_ENTRY → JVM_ENTRY(static, ...) — 只是 static 前缀的区别
  6.2 UNSAFE_LEAF → JVM_LEAF — Unsafe 中的 LEAF 函数
  6.3 Unsafe_Park 的 ThreadBlockInVM → trans_and_fence → [09-01]§三
  6.4 GuardUnsafeAccess 的 try_lock 与 safepoint 的互动

§七 GDB 验证 + 可证伪断言（≥12 条）
  断言 1: Unsafe_CompareAndSetInt → HeapAccess → Atomic::cmpxchg → lock cmpxchgl 的完整调用栈
  断言 2: lock cmpxchgl 的反汇编验证（PrintAssembly 或 disas 命令）
  断言 3: Parker.park() 的 xchg → trylock → cond_wait 的步进执行
  断言 4: park() 前设 counter=1 (unpark before park) → park 看到 counter=1 → 快速路径返回
  断言 5: ThreadBlockInVM dtor 中的 trans_and_fence — state 从 _thread_blocked 变为 _thread_in_vm
  断言 6: fence() = lock; addl $0,0(%%rsp) 的汇编指令验证
  断言 7: acquire() 在 x86 上是 compiler_barrier → 无 CPU 指令 → GDB disas 验证
  断言 8: defineAnonymousClass 后 InstanceKlass::is_anonymous() == true
  断言 9: anonymous class 的 host klass 向上链到非匿名类
  断言 10: 两个线程 park 同一个 Parker → 第二个线程看到 counter=0 → cond_wait
  断言 11: counter 初始值为 0（Parker 构造）→ park → xchg 后变为 1 → park again → xchg → 再清零
  断言 12: getVolatile 和 get 在 x86 汇编层的差异（MOV + compiler barrier vs 纯 MOV）

  可证伪断言 1: 如果 enable JVM option -XX:+UnlockDiagnosticVMOptions → PrintAssembly → 
              验证 lock cmpxchg 前面确实有 lock 前缀字节 (0xF0)
  可证伪断言 2: park 时 ThreadBlockInVM 的构造改变 _thread_state → GDB print _thread_state → 
              值从 _thread_in_vm (6) 变为 _thread_blocked (10)
  可证伪断言 3: unpark before park → park 走 xchg 路径 (不进入 ThreadBlockInVM 的构造块)
  可证伪断言 4: defineAnonymousClass 后 class 不在 SystemDictionary 中 → 
              Class.forName(className) 找不到 → 返回 ClassNotFoundException
```

## 六、写作要求

1. **★ CAS 5 层调用链是全文第一个核心交付物**：必须包括从 Java 对象到 CPU 指令的精确行号、每层的参数形式（jobect → oop → compressed oop → T* → void* → int*）、返回值的逐步变形。

2. **★ 内联汇编必须逐行注释**：不是标注"这是 cmpxchg"，而是"`%1` 是 new value, `(%3)` 是 [dest address], `%eax` 隐式持有 expected value — Intel 手册 Vol 2A CMPXCHG 指令格式"。

3. **★ Parker 的 counter 状态自动机图**：从 counter=0 (no permit) 到 counter=1 (permit available) 的状态转移、由哪些操作触发转移、转移的原子性保证。

4. **★ 3 种真实竞态场景的详细时序分析**：用线程交织图展示 (a) unpark before park, (b) xchg → trylock window, (c) double check recheck 的精确时序。

5. **★ 内存屏障 x86 对比表**：loadload, storestore, loadstore, storeload, acquire, release, fence 七种 barrier 在 x86 上的 CPU 指令、周期数、ARM 等价指令、JMM 语义。

6. **★ 和 [09-01][09-04] 的交叉引用**：`Unsafe_Park` 的二阶状态转换（native→VM→blocked→VM→native）是 [09-01] 没有覆盖的三阶段状态变化——这是本文在 09 阶段的独特价值。

7. **★ GDB 断言必须可执行**：指定确切的 breakpoint + 运行时条件 + 预期输出。

8. **不要写 Unsafe API 的"最佳实践"或"安全替代"** — 本文是 JVM 源码分析，不是 Unsafe API 设计指南。

9. **不要写 JSR-166 的 lock-free 数据结构** — 本文的目标是理解"Unsafe CAS 怎么变成 CPU 指令"，不是"怎么用 CAS 写无锁队列"。

## 七、输出格式

- Markdown 文件，命名为 `07-Unsafe-Implementation.md`
- 输出路径：`/data/workspace/openjdk-cut-new/probe_md/libjvm-analysis/09-native-interface/`
- 元信息头（标准环境 + 源文件清单 + 前置 [09-01] + 阅读收益 + "Java 到硬件的完整穿透分析"的说明）
