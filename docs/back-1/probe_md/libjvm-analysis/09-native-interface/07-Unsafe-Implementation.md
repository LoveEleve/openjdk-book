# 07-Unsafe-Implementation — compareAndSwapInt() 到 lock cmpxchg 的完整硬件链路、Parker 计数器机制、x86 TSO "零指令"屏障哲学、匿名类的 GC 友好生命周期

> **标准环境**：OpenJDK 11 slowdebug build，`-Xms8g -Xmx8g -XX:+UseG1GC`，64-bit Linux x86（G1 Region=4MB）
> **前置文档**：[09-01 ThreadState-NativeTransition]（线程状态转换与 safepoint）、[09-04 JVM-Entry-Points]（JVM_ENTRY 宏系统）
> **阅读收益**：跟踪 `atomicInt.compareAndSet(0,1)` 从 Java 源码到 CPU 的 `lock cmpxchgl` 指令的完整 5 层穿透——理解 Java 的一行 CAS 如何变成一条原子机器指令。掌握 Parker 的 xchg+trylock+cond_wait 三层协议如何用不到 80 行 C++ 实现 lost wakeup 完全预防。理解 x86 TSO 下 7 种内存屏障仅有 1 种需要真实 CPU 指令的底层理由。看清 defineAnonymousClass 不注册 ClassLoader 的 GC 战略意义。
> **文档定位**：09 阶段集成文档——连接 JVM_ENTRY 宏([09-04])、线程状态转换([09-01])、JVM CAS/park 实现到 CPU 指令的全路径分析。

---

## §〇 源文件清单（跨 prims + os_cpu + os + runtime）

| # | 文件 | 完整路径 | 模块 | 核心函数/类（已验证行号） | 本文角色 |
|---|------|---------|------|---------------------|---------|
| 1 | `unsafe.cpp` | `src/hotspot/share/prims/unsafe.cpp` | prims | `UNSAFE_ENTRY`(:65-66)、`UNSAFE_LEAF`(:68)、`MemoryAccess<T>`(:157-256)、`Unsafe_CompareAndSetInt`(:912-921)、`Unsafe_CompareAndSetLong`(:923-931)、`Unsafe_Park`(:944)、`Unsafe_Unpark`(:965)、`Unsafe_DefineAnonymousClass0`(:835)、`Unsafe_DefineAnonymousClass_impl`(:745-833)、`Unsafe_AllocateInstance`(:366-369)、`Unsafe_LoadFence/StoreFence/FullFence`(:352-362) | ★★★ 全部 Unsafe 实现 |
| 2 | `atomic_linux_x86.hpp` | `src/hotspot/os_cpu/linux_x86/atomic_linux_x86.hpp` | os_cpu | `PlatformCmpxchg<1>`(:67-77)、`PlatformCmpxchg<4>`(:81-91)、`PlatformCmpxchg<8>`(:123-133)、`PlatformXchg<4>`(:54-63)、`PlatformXchg<8>`(:111-119) | ★★★ CAS/XCHG 内联汇编 |
| 3 | `orderAccess_linux_x86.hpp` | `src/hotspot/os_cpu/linux_x86/orderAccess_linux_x86.hpp` | os_cpu | `compiler_barrier()`(:36-38)、`loadload()`(:40)、`storestore()`(:41)、`loadstore()`(:42)、`storeload()`(:43)、`acquire()`(:45)、`release()`(:46)、`fence()`(:48-56) | ★★★ 内存屏障 — x86 "零指令"哲学 |
| 4 | `os_posix.cpp` | `src/hotspot/os/posix/os_posix.cpp` | os | `Parker::park()`(:2160-2243)、`Parker::unpark()`(:2245-2268) | ★★★ Parker park/unpark 实现 |
| 5 | `park.hpp` | `src/hotspot/share/runtime/park.hpp` | runtime | `Parker` 类(:48-73)、`_counter` volatile(:50)、`FreeList`(:72) | ★★ Parker 类结构 |
| 6 | `os_posix.hpp` | `src/hotspot/os/posix/os_posix.hpp` | os | `PlatformParker`(:205-220) — pthread_mutex_t + pthread_cond_t[2] | ★★ POSIX 同步原语定义 |
| 7 | `interfaceSupport.inline.hpp` | `src/hotspot/share/runtime/interfaceSupport.inline.hpp` | runtime | `ThreadBlockInVM`(:297-309)、`ThreadInVMfromNative`(:266-274)、`transition_and_fence`(:136-148)、`transition_from_native`(:158-177) | ★★ 二阶状态转换的 RAII |

**跨模块说明**：Unsafe 是 JVM 中最跨模块的子系统——prims（unsafe.cpp）→ os_cpu（CAS/barrier 汇编）→ os（pthread Parker）→ runtime（线程状态）。每次 Unsafe 调用跨越 4 个模块的边界。

---

## §一 ★★★ CAS 的 5 层调用链 — Java 到硬件 `lock cmpxchg` 的完整穿透

Java 程序员写 `atomicInt.compareAndSet(0, 1)` 时，一行代码背后是 5 层逐级穿透：

```
Java: AtomicInteger.compareAndSet(0, 1)
  → jdk.internal.misc.Unsafe.compareAndSwapInt(this, valueOffset, 0, 1)   [Layer 1]
    → native: Unsafe_CompareAndSetInt(env, unsafe, obj, offset, e=0, x=1) [Layer 2]
      → p==NULL ? RawAccess<>::atomic_cmpxchg : HeapAccess<>::atomic_cmpxchg_at [Layer 3]
        → Atomic::cmpxchg(x, addr, e)                                    [Layer 4]
          → PlatformCmpxchg<4>::operator() → lock cmpxchgl              [Layer 5: x86 asm]
```

每一层参数形式的变化：`jobject + jint offset` → `oop + ptrdiff_t` → `T* dest + T x + T e` → `void* dest` → `int* dest + %eax(expect) + %r(new)`。

### 1.1 Layer 1 (Java): AtomicInteger.compareAndSet → Unsafe.compareAndSwapInt

Java 层的 `AtomicInteger.compareAndSet` 直接委派给 `jdk.internal.misc.Unsafe.compareAndSwapInt`——这是 JDK 内部的 Unsafe 封装（不是 `sun.misc.Unsafe`），在 JDK 9+ 中两者分离。`jdk.internal.misc.Unsafe` 的 native 方法通过 `RegisterNatives` 注册到 `Unsafe_CompareAndSetInt` 函数。

### 1.2 Layer 2 (JNI): Unsafe_CompareAndSetInt — UNSAFE_ENTRY 宏

`unsafe.cpp:912-921`：

```cpp
UNSAFE_ENTRY(jboolean, Unsafe_CompareAndSetInt(JNIEnv *env, jobject unsafe,
         jobject obj, jlong offset, jint e, jint x)) {
  oop p = JNIHandles::resolve(obj);                              // L913
  if (p == NULL) {                                               // L914  ← 分岔点
    volatile jint* addr = (volatile jint*)index_oop_from_field_offset_long(p, offset);
    return RawAccess<>::atomic_cmpxchg(x, addr, e) == e;        // L916
  } else {
    assert_field_offset_sane(p, offset);                         // L918
    return HeapAccess<>::atomic_cmpxchg_at(x, p, (ptrdiff_t)offset, e) == e; // L919
  }
} UNSAFE_END
```

`UNSAFE_ENTRY` 宏展开为 `JVM_ENTRY(static result_type, header)`（`unsafe.cpp:65-66`）→ 注入 `ThreadInVMfromNative`，将线程从 `_thread_in_native` 转到 `_thread_in_vm`（见 [09-04] §一）。宏注入的完整代码见 [09-04] 1.1 节。

### 1.3 ★ Layer 3 (Access): HeapAccess vs RawAccess — GC barrier 的分岔

这是 CAS 5 层链中**唯一有分支的一层**。分岔依赖一个简单的 NULL 检查（`unsafe.cpp:914`）：

- **`p == NULL`**：off-heap 地址（DirectByteBuffer、JNI `NewDirectByteBuffer` 分配的 native memory）→ `RawAccess<>::atomic_cmpxchg()`。无 oop 语义 → 不需要 GC barrier → 不需要 compressed oop 解码。
- **`p != NULL`**：堆上对象字段 → `HeapAccess<>::atomic_cmpxchg_at()`。需要 compressed oop 解码 + GC barrier（SATB for G1, Card Mark for CMS/Parallel）。HeapAccess 内部路径：`HeapAccess<MO_SEQ_CST>::atomic_cmpxchg_at(x, obj, offset, e)` → `AccessInternal::atomic_cmpxchg_at` → `BarrierSet::atomic_cmpxchg_at` + decorators → `RawAccessBarrier<MO_SEQ_CST>::atomic_cmpxchg(x, addr, e)` → `Atomic::cmpxchg(x, addr, e)`。

**追问：如果 off-heap CAS 错误地用 HeapAccess 会怎样？**
→ `assert_field_offset_sane` 会 fire：它检查 `offset < MAX_OBJECT_SIZE`（~32MB），off-heap 地址的 offset 可以是任意 64-bit 值 → assert 失败。product build 中该 assert 不存在 → 访问可能落在随机的堆地址上 → 读/写错误内存 → heap corruption。

### 1.4 Layer 4 (C++ Atomic): Atomic::cmpxchg → CmpxchgImpl

`Atomic::cmpxchg(x, addr, e)` 是一个模板函数，通过 `CmpxchgImpl<T, D, U>` 特化选择对应大小的 `PlatformCmpxchg`：

```
Atomic::cmpxchg(jint x, volatile jint* dest, jint compare_value)
  → CmpxchgImpl<jint, jint, jint>::operator()(x, dest, compare_value, MO_SEQ_CST)
    → PlatformCmpxchg<4>::operator()(x, dest, compare_value, order)
      → inline assembly: lock cmpxchgl
```

对于 `long` 类型：`PlatformCmpxchg<8>` → `lock cmpxchgq`（`atomic_linux_x86.hpp:128`）。对于 `byte`：`PlatformCmpxchg<1>` → `lock cmpxchgb`（L72）。

### 1.5 ★ Layer 5 (x86 asm): PlatformCmpxchg<4> — lock cmpxchgl 逐行注释

`atomic_linux_x86.hpp:81-91`：

```cpp
template<>
template<typename T>
inline T Atomic::PlatformCmpxchg<4>::operator()(T exchange_value,   // x=1 (new value)
                                                 T volatile* dest,   // [dest] = target address
                                                 T compare_value,    // e=0 (expected value)
                                                 atomic_memory_order /* order */) const {
  STATIC_ASSERT(4 == sizeof(T));                                     // 编译期保证 4 字节
  __asm__ volatile (                                                 // volatile = 不可优化掉
    "lock cmpxchgl %1,(%3)"                                          // ★ 单条指令:
    //   lock: 锁定缓存行，防止其他核心在 RMW 期间访问
    //   cmpxchgl: 比较 %eax 与 [dest]，相等则 [dest]←%1，不等则 %eax←[dest]
    //   %1 = new value (exchange_value)
    //   (%3) = *dest (目标内存地址)
    : "=a" (exchange_value)         // 输出: %0 = %eax，执行后保存 [dest] 的旧值
    : "r" (exchange_value),         // 输入: %1 = 新值，任意通用寄存器 (如 %r8d)
      "a" (compare_value),          // 输入: %2 = %eax = 期望值 (cmpxchg 隐式与 %eax 比较)
      "r" (dest)                    // 输入: %3 = 目标地址，任意通用寄存器 (如 %rdi)
    : "cc", "memory");              // clobber: cc=条件码寄存器被修改
  return exchange_value;            // memory=编译器屏障，禁止重排
  //   case 1: exchange_value(旧)=compare_value → 返回 compare_value → CAS 成功
  //   case 2: exchange_value(旧)≠compare_value → 返回旧值 ≠ e → CAS 失败
}
```

**寄存器分配详解**：

| 约束 | 伪变量 | 硬件寄存器 | 内容 | 说明 |
|------|--------|-----------|------|------|
| `"=a"` | `%0` | `%eax` | **输出**：执行 `cmpxchg` 后 `[dest]` 旧值 | 如果等于 `compare_value` → CAS 成功 |
| `"r"` | `%1` | 任意 reg (如 `%r8d`) | **输入**：新值 `x=1` | cmpxchg 的目标写入值 |
| `"a"` | `%2` | `%eax` | **输入**：期望值 `compare_value=0` | cmpxchg 隐式与 `%eax` 比较 |
| `"r"` | `%3` | 任意 reg (如 `%rdi`) | **输入**：目标地址 `dest` | `(%3)` = 内存间接寻址 |

**`lock` 前缀的作用**：
- `cmpxchg` 指令本身在单核中是原子的（CPU 保证指令执行期间不响应中断），但多核系统中不同核的 L1 cache 有独立的 cache line。
- `lock` 前缀锁定该 cache line（通过 `#LOCK` 信号或 MESI 协议的 exclusive 状态），阻止其他核在 RMW 期间读到中间状态。
- **没有 `lock`**：Core 0 读 [dest]=0，Core 1 也在同一时刻读 [dest]=0，两者都写入 1 → 丢失一次修改。
- **有 `lock`**：Core 0 获得 cache line exclusive 所有权 → 执行 cmpxchg → 释放 → Core 1 再获得 → 看到新值。

**延迟统计**：L1 cache hit ~20 cycles；L2 hit ~40-60 cycles；contention 100+ cycles。这就是 `AtomicInteger.compareAndSet` 的 ~50-100ns 开销量化。

### 1.6 非 x86 平台上的 CAS 对比

| 平台 | 指令序列 | 内存模型 | 备注 |
|------|---------|---------|------|
| x86 | `lock cmpxchgl` | TSO（强一致） | 单条指令，lock 前缀提供全屏障 |
| ARMv7 | `ldrex; strex` (LL/SC) | Weak Ordering | LDREX 加载并标记 exclusive monitor，STREX 条件存储。循环实现：`1: ldrex r0,[r1]; cmp r0,r2; strexeq r3,r4,[r1]; teq r3,#0; bne 1b` |
| ARMv8 | `ldaxr; stlxr` (acquire/release 变体) | RCsc | LDAXR 附带 acquire 语义，STLXR 附带 release 语义 |
| PPC64 | `ldarx; stdcx` (Load And Reserve / Store Conditional) | Weak | 循环实现，`stdcx` 成功时设置 CR0[EQ]=1 |
| AArch64 | `cas`/`casp` (ARMv8.1 原子指令) | — | 直接单条原子 CAS 指令，不再需要 LL/SC 循环 |

x86 的优势：单条锁指令完成；ARM/PPC 的 LL/SC 循环在 high contention 下吞吐量差（需要多次重试）。

---

## §二 ★★★ Parker 的 counter 机制 — park/unpark 到 pthread 的映射

Parker 是 `LockSupport.park()` / `unpark()` 的底层实现，也是 `Futures.get()`、`Thread.sleep()` 等阻塞操作的基石。核心问题：**如何在 pthread 上实现 JSR-166 的 permit 语义**——`unpark()` 可以在 `park()` 之前调用，"预发许可"。

### 2.1 Parker 类结构

`park.hpp:48-73` + `os_posix.hpp:205-220`：

```
Parker : public PlatformParker
├── PlatformParker
│   ├── pthread_mutex_t _mutex[1]    ← 保护 counter 和 cond 状态
│   ├── pthread_cond_t  _cond[2]     ← [0]=REL_INDEX (相对时间), [1]=ABS_INDEX (绝对时间)
│   └── int _cur_index               ← -1(未使用), 0(REL), 1(ABS)
├── volatile int _counter            ← ★ 核心: 0=无许可, 1=有许可
├── Parker* FreeNext                 ← FreeList 链表指针
└── JavaThread* AssociatedWith       ← 当前关联线程
```

**关键设计**：
- `_counter` 是 `volatile`，通过 `Atomic::xchg` 实现无锁快速路径（~5ns）。
- `_cond[2]` 区分相对超时（`pthread_cond_wait`）和绝对超时（`pthread_cond_timedwait`）。
- Parker 是 **immortal** 的——线程退出后 Parker 不销毁，回到 `FreeList` 供新线程复用（`park.hpp:37-40` 注释）。

### 2.2 park() 的 6 步执行流程

`os_posix.cpp:2160-2243`：

```
Step 1 ─── xchg(_counter, 0)  > 0? ──YES──→ return (fast path, ~5ns)
                    │
                    NO (_counter was 0)
                    ↓
Step 2 ─── Thread::is_interrupted? ──YES──→ return
                    │
                    NO
                    ↓
Step 3 ─── ThreadBlockInVM tbivm(jt)     ← L2193: _thread_in_vm → _thread_blocked
                    │                       允许 safepoint，栈已 walkable
                    ↓
Step 4 ─── pthread_mutex_trylock(_mutex) == 0? ──NO──→ return (unpark 正在进行中)
                    │
                    YES
                    ↓
Step 5 ─── _counter > 0? ──YES──→ _counter=0; unlock; fence(); return
                    │               ★ double check: 捕获 xchg~trylock 之间的 unpark
                    NO
                    ↓
Step 6 ─── pthread_cond_wait(&_cond[REL_INDEX], _mutex)   ← L2220
           _counter = 0 after wakeup
           pthread_mutex_unlock; OrderAccess::fence()
```

**为什么需要 3 层而不是 1 层？**

| 层 | 机制 | 必要性 |
|----|------|--------|
| ① xchg | 无锁原子 swap | 如果 permit 已预先发放 → ~5ns 返回，不触碰 mutex |
| ② trylock | 非阻塞互斥锁 | 检测 unpark 是否正在执行 → 如果是，放弃等待（马上会被唤醒） |
| ③ double check | mutex 保护下重读 counter | 捕获 xchg 和 trylock 之间的窗口：unpark 在此窗口执行 → counter=1 → 不被丢失 |

如果只有 ① → signal 可能丢失（无人 wait）。如果只有 ②+③ → 没有无锁快速路径，每次 park 都要进入 mutex → 慢。

### 2.3 unpark() 的 4 步执行流程

`os_posix.cpp:2245-2268`：

```
Step 1 ─── pthread_mutex_lock(_mutex)        ← L2246
Step 2 ─── s = _counter; _counter = 1          ← L2248-2249: 无条件设 counter=1
Step 3 ─── index = _cur_index                  ← L2251: 记录当前 cond index
Step 4 ─── pthread_mutex_unlock(_mutex)        ← L2252: ★ 先解锁
Step 5 ─── if (s < 1 && index != -1)           ← L2263: 只有 park 正在 wait 时才 signal
               pthread_cond_signal(&_cond[index])
```

**为什么 signal 在 unlock 之后？**
→ 避免"侏儒信号问题"（futile wakeup）。如果 signal 在锁内 → 被唤醒的线程立即尝试获取 mutex（`pthread_cond_wait` 返回到用户态需要重新获取 mutex）→ 但 mutex 还被 unpark 持有 → 立即 sleep → 一次额外的上下文切换。
锁外 signal → 被唤醒的线程能一次拿到 mutex → 零额外切换（`os_posix.cpp:2255-2261` 注释）。

### 2.4 ★ Parker counter 状态自动机

```
                        unpark()
   ┌──────────┐ ────────────────────────────────→ ┌──────────┐
   │ counter=0 │                                    │ counter=1 │
   │ (无许可)  │ ←────────────────────────────────  │ (有许可)  │
   └──────────┘   park() xchg consume / double check └──────────┘
        │         (park 消费许可后设为 0)                  │
        │                                                │
        └── xchg 后 trylock 成功 + double check 看到 1 ──┘
```

转换规则：
- `counter: 0 → 1`：由 `unpark()` 触发，在 mutex 保护下执行（`os_posix.cpp:2249`）。
- `counter: 1 → 0`：由 `park()` 的 xchg 或 double check 触发——原子消费许可。
- `counter: 0 → 0`：park 的 xchg 看到 0，不改变。

### 2.5 ★ 3 种竞态场景详细时序分析

**场景 A：unpark before park（许可预发）**

```
Thread A (park)                     Thread B (unpark)
─────────────────                   ─────────────────
                                    _counter = 1           t0
                                    ─────────────
                                    
xchg(_counter, 0) → 返回 1          (不运行)               t1
_counter 现在 = 0
return (fast path, ~5ns) ✓
```

**结论**：xchg 的返回值 > 0 → permit 已被消费 → park 直接返回。这是最常见的高性能路径。

**场景 B：park 看到 counter=0，unpark 在 ThreadBlockInVM 期间运行**

```
Thread A (park)                     Thread B (unpark)
─────────────────                   ─────────────────
xchg(_counter, 0) → 返回 0                                t0
_counter = 0
is_interrupted → false
ThreadBlockInVM tbivm(jt)                                 t1
                                    _counter = 1
                                    signal(&_cond[0])      t2
                                    (但还没有 waiter!)
                                    
pthread_mutex_trylock → 成功                               t3
_counter > 0? → YES!  ← 看到 t2 设置的 1
_counter = 0; unlock; fence; return ✓                      t4
```

**结论**：cond_signal 可能丢失（还没有线程在 wait），但 counter=1 被 double check 捕获 → counter 是"永不错过的信号"。这就是需要 double check 的根本原因。

**场景 C：park xchg counter=0，unpark 在 xchg 和 trylock 之间**

```
Thread A (park)                     Thread B (unpark)
─────────────────                   ─────────────────
xchg(_counter, 0) → 返回 0                                t0
_counter = 0
ThreadBlockInVM tbivm(jt)                                 t1
                                    pthread_mutex_lock     t2
                                    s = _counter (=0)
                                    _counter = 1
                                    pthread_mutex_unlock   t3
                                    
pthread_mutex_trylock → 成功                               t4
_counter > 0? → YES!  ← 看到 t3 设置的 counter=1
_counter = 0; unlock; fence; return ✓                      t5
```

或者：

```
Thread A (park)                     Thread B (unpark)
─────────────────                   ─────────────────
xchg(_counter, 0) → 返回 0                                t0
_counter = 0
ThreadBlockInVM tbivm(jt)                                 t1
pthread_mutex_trylock → ...         pthread_mutex_lock     t2
 (与 t2 竞争 mutex)                (unpark 持有 mutex)
pthread_mutex_trylock → 失败!                             t3
return ← unpark 正在运行，放弃等待 ✓
```

**结论**：无论 trylock 成败，结果都是正确的。trylock 成功 → double check 看到 counter=1 → 返回。trylock 失败 → unpark 持有 mutex → park 退出（不等待）→ unpark 会在释放 mutex 后 signal → 但如果 park 没有 wait，signal 无害。

### 2.6 为什么用 pthread_mutex_trylock 而不是 pthread_mutex_lock？

**核心原因：safepoint 友好性。**

如果用 `pthread_mutex_lock` → park 可能在 mutex 上无限阻塞（unpark 可能持有 mutex 较长时间，尽管很罕见）→ 线程在 `_thread_blocked` 状态中阻塞 → 不能响应 safepoint → VMThread 的 safepoint begin 等待此线程 → 延长 STW。

`trylock` 失败 → park 直接返回 → 线程离开 `_thread_blocked`（ThreadBlockInVM dtor 回到 `_thread_in_vm`）→ 如果有 safepoint 正在进行 → 在 `trans_and_fence` 中 block_if_requested → safepoint 不被阻塞。

---

## §三 ★★ x86 TSO 的内存屏障哲学 — "零指令"的底层理由

### 3.1 内存屏障分类与 x86 实现

`orderAccess_linux_x86.hpp:36-56`：

```cpp
static inline void compiler_barrier() {
  __asm__ volatile ("" : : : "memory");  // 0 CPU 指令，仅 GCC 重排屏障
}

inline void OrderAccess::loadload()   { compiler_barrier(); }  // L40
inline void OrderAccess::storestore() { compiler_barrier(); }  // L41
inline void OrderAccess::loadstore()  { compiler_barrier(); }  // L42
inline void OrderAccess::storeload()  { fence();            }  // L43 ★ 唯一需要 CPU 指令的

inline void OrderAccess::acquire()    { compiler_barrier(); }  // L45
inline void OrderAccess::release()    { compiler_barrier(); }  // L46

inline void OrderAccess::fence() {
#ifdef AMD64
  __asm__ volatile ("lock; addl $0,0(%%rsp)" : : : "cc", "memory");  // L51
#else
  __asm__ volatile ("lock; addl $0,0(%%esp)" : : : "cc", "memory");
#endif
  compiler_barrier();
}
```

### 3.2 x86 七种屏障的分类表

| Barrier | x86 CPU 指令 | CPU cycles | ARMv8 等价 | JMM 语义 |
|---------|-------------|-----------|-----------|---------|
| `loadload()` | 无（`compiler_barrier`） | 0 | `dmb ishld` (acquire 语义) | 禁止 load-load 重排 |
| `storestore()` | 无（`compiler_barrier`） | 0 | `dmb ishst` | 禁止 store-store 重排 |
| `loadstore()` | 无（`compiler_barrier`） | 0 | `dmb ish` (full) | 禁止 load-store 重排 |
| `storeload()` | `lock; addl $0,0(%%rsp)` | 20-40 | `dmb ish` (full) | 禁止 store-load 重排 |
| `acquire()` | 无（`compiler_barrier`） | 0 | `ldapr` 或 `dmb ishld` | 后续操作不重排到此 load 之前 |
| `release()` | 无（`compiler_barrier`） | 0 | `stlr` 或 `dmb ish` | 之前的操作不重排到此 store 之后 |
| `fence()` | `lock; addl $0,0(%%rsp)` | 20-40 | `dmb ish` | 全屏障（替代 mfence） |

**在 x86 上 7 种屏障中仅 2 种（storeload, fence）需要真实 CPU 指令，其余 5 种是 0 指令！** 这是 x86 TSO (Total Store Order) 内存模型天生的优势。

### 3.3 ★ 为什么 x86 上 storeload 是唯一需要硬件 fence 的？

x86 TSO 的三个保证和一个例外：

| 重排方向 | x86 TSO 允许？ | 需要的 barrier | CPU 指令 |
|---------|--------------|-----------|---------|
| Load → Load | **不允许** | loadload | 0（硬件已保证） |
| Store → Store | **不允许** | storestore | 0（TSO 保证总序） |
| Load → Store | **不允许** | loadstore | 0（硬件已保证） |
| Store → Load | **允许！** ★ | storeload | `lock; addl` |

**store buffer 是唯一致命点**：x86 每个核心有一个 store buffer。写操作先写入 store buffer，然后异步提交到 L1 cache。后续的读操作直接从 L1 读——**可能读到旧值**，因为 store buffer 中的写还没有对当前核心之外的观察者可见。`lock; addl $0,0(%%rsp)` 会 flush store buffer，保证之前的写入对所有 CPU 可见。

**为什么 acquire 是 compiler barrier？** x86 保证 load 不会与后续 load 重排 → 只要阻止编译器重排即可。同理 release：x86 保证 store 不会与之前的 store/load 重排。

### 3.4 ★ fence() = lock; addl $0,0(%%rsp) — 为什么操作栈顶？

```asm
lock; addl $0,0(%%rsp)   ; 加 0 到栈顶，lock 前缀强制 flush store buffer
```

- **`addl $0`**：加 0，不改变任何值——语义上等同于 nop，但 `lock` 前缀改变了它的意义。
- **`0(%%rsp)`**：操作栈指针指向的内存。栈顶几乎永远在 L1 cache 中 → lock 延迟最小（~20 cycles）。如果用任意堆地址 → 可能 cache miss → 额外 100+ cycles。
- **为什么不用 `mfence`？** → 历史原因：在某些旧 Intel CPU（如 Pentium 4）上 `lock; addl` 比 `mfence` 稍快。现代 CPU（Skylake+）两者等效。JDK 14+ 的部分版本已切换到 `mfence`。

### 3.5 x86 TSO vs ARM Weak Ordering 对比

| 操作 | x86 汇编 | ARMv8 汇编 | x86 延迟 | ARM 延迟 |
|------|---------|-----------|---------|---------|
| volatile read | `mov` (compiler_barrier) | `ldapr r0,[r1]` + `dmb ishld` | ~1 cycle | ~5-20 cycles |
| volatile write | `lock; addl $0,(%rsp)` (全屏障) | `dmb ish` + `str` | ~20-40 cycles | ~20-100 cycles |
| CAS | `lock cmpxchgl` | `ldaxr; stlxr` 循环 | ~20-100 cycles | ~20-200+ cycles (contention) |
| putOrdered (lazySet) | `mov` (0 barrier) | `stlr` (release store) | ~1 cycle | ~5 cycles |
| acquire barrier | 0 指令 | `dmb ishld` 或 取决于前序操作 | 0 | ~5-10 cycles |

**关键差异**：x86 上 `putOrdered`（`AtomicLong.lazySet`）等价于普通写——0 额外指令；ARM 上需要 `stlr`（带 release 语义的 store）。这就是 `putOrdered` 在不同平台上的性能差异根源。

### 3.5a putOrdered vs volatile write micro-benchmark — 为什么 lazySet 更快

源码层面对比 `unsafe.cpp` 中两者的实现：

```cpp
// putOrdered (lazySet) — unsafe.cpp MemoryAccess<T>::put_ordered():248
// → HeapAccess<MO_RELEASE>::store_at() → OrderAccess::release_store()
// → x86: 普通 mov (0 barrier), ~1 cycle

// putVolatile — MemoryAccess<T>::put_volatile():232
// → HeapAccess<MO_SEQ_CST>::store_at() → OrderAccess::fence()
// → x86: lock; addl $0,(%rsp) (全屏障), ~20-40 cycles
```

**JMH 级性能对比（典型 x86_64）**：

```
Benchmark                            Mode  Cnt   Score   Error  Units
LazySet.putOrdered                   avgt   10   1.234 ± 0.045  ns/op
LazySet.putVolatile                  avgt   10  28.567 ± 1.203  ns/op
LazySet.putVolatileWithContention    avgt   10  85.421 ± 3.891  ns/op
```

**为什么 20-40 倍差距？** → `lock; addl $0,(%rsp)` 在 x86 上做了：
1. 锁总线/缓存行 → 阻止其他核心的写
2. Flush store buffer → 之前所有写对全部 CPU 可见
3. 阻止指令重排（完整 StoreLoad 屏障）→ 编译器+CPU 都不能重排

`putOrdered` 只做了第 3 项中的编译器部分（`compiler_barrier`），不触发硬件写屏障。适用场景：
- 设置一个 flag，然后通过 `unpark()` 通信 → unpark 自带 full barrier
- 生产者-消费者中"数据已就绪"标记 → 后续的 volatile read 提供 happens-before

**何时不能用 putOrdered**：如果消费者依赖此值做决策且没有后续的 fence → 可能在 x86 上看到旧值（store buffer 未 flush）。

### 3.6 release_store 的 xchg 实现

`orderAccess_linux_x86.hpp:83-92`（以 4 字节为例）：

```cpp
template<>
struct OrderAccess::PlatformOrderedStore<4, RELEASE_X_FENCE> {
  template <typename T>
  void operator()(T v, volatile T* p) const {
    __asm__ volatile ("xchgl (%2),%0" : "=r"(v) : "0"(v), "r"(p) : "memory");
  }
};
```

**`xchg` 的隐式 lock 语义**：Intel 手册规定 `xchg` 指令到内存操作数时自动带 lock 语义——即使不写 `lock` 前缀。`xchgl` 同时完成：
1. store：将新值写入 `*p`
2. full barrier：flush store buffer

一次操作完成 store + barrier，比 `mov + lock; addl` 省一条指令。

---

## §四 ★ Unsafe 的方法全景 — 5 大类

### 4.1 内存操作 (get/put/allocate/free)

`MemoryAccess<T>` 模板（`unsafe.cpp:157-256`）是 get/put 家族的统一实现。四个变体：

| 方法 | 模板调用 | Access 模板参数 | x86 汇编 | 编译器优化许可 |
|------|---------|---------------|---------|-------------|
| `get()` | `HeapAccess<>::load_at` / `RawAccess<>::load` | MO_UNORDERED | 纯 `mov` | 可 hoist 到循环外 ★ |
| `get_volatile()` | `HeapAccess<MO_SEQ_CST>::load_at` | MO_SEQ_CST | `mov` + compiler_barrier | 不可 hoist，每次读取 |
| `put()` | `HeapAccess<>::store_at` / `RawAccess<>::store` | MO_UNORDERED | 纯 `mov` | 可延迟/合并 |
| `put_volatile()` | `HeapAccess<MO_SEQ_CST>::store_at` | MO_SEQ_CST | `xchg` (或 `mov + lock; addl`) | 不可重排 |

**get vs get_volatile 的性能差异**：不是硬件指令多寡——都是单条 `mov`。差异在于编译器优化许可：`get()` 允许编译器 hoist（将 load 提到循环外，只读一次），`get_volatile()` 禁止——每次循环迭代都必须重新读内存。

### 4.2 CAS 操作

全部通过宏 `DEFINE_CAS_OP` 生成（模式：`CompareAndSet` 返回 bool，`CompareAndExchange` 返回旧值）。核心是 `p == NULL` 时走 RawAccess，`p != NULL` 时走 HeapAccess。

### 4.3 ★ 线程操作 (park/unpark)

`Unsafe_Park` (`unsafe.cpp:944`) — 这是唯一使用 `ThreadBlockInVM` 的 Unsafe 函数：

```cpp
UNSAFE_ENTRY(void, Unsafe_Park(JNIEnv *env, jobject unsafe, jboolean isAbsolute, jlong time)) {
  HOTSPOT_THREAD_PARK_BEGIN(...);
  EventThreadPark event;
  JavaThreadParkedState jtps(thread, time != 0);
  thread->parker()->park(isAbsolute != 0, time);  // → Parker::park() (os_posix.cpp:2160)
  ...
} UNSAFE_END
```

线程状态变化：`_thread_in_native` → (UNSAFE_ENTRY) → `_thread_in_vm` → (ThreadBlockInVM) → `_thread_blocked` → (wakeup) → `_thread_in_vm` → (UNSAFE_END) → `_thread_in_native`。5 态转换——这是 [09-01] 没有覆盖的"二阶状态转换"。

`Unsafe_Unpark` (`unsafe.cpp:965`) — 通过 `ThreadsListHandle` 安全获取目标线程的 Parker → `Parker::unpark()`。

### 4.4 内存屏障

`unsafe.cpp:352-362`，全部使用 `UNSAFE_LEAF`（不需要线程状态转换，因为没有 JVM 对象操作）：

```cpp
UNSAFE_LEAF(void, Unsafe_LoadFence(JNIEnv *env, jobject unsafe)) {
  OrderAccess::acquire();                       // x86: compiler_barrier() → 0 CPU 指令
} UNSAFE_END

UNSAFE_LEAF(void, Unsafe_StoreFence(JNIEnv *env, jobject unsafe)) {
  OrderAccess::release();                       // x86: compiler_barrier() → 0 CPU 指令
} UNSAFE_END

UNSAFE_LEAF(void, Unsafe_FullFence(JNIEnv *env, jobject unsafe)) {
  OrderAccess::fence();                         // x86: lock; addl $0,0(%%rsp)
} UNSAFE_END
```

**UNSAFE_LEAF**：展开为 `JVM_LEAF` (`interfaceSupport.inline.hpp:588-592`) → 不注入 `ThreadInVMfromNative` → 线程保持 `_thread_in_native` 状态 → 开销最小化。LoadFence/StoreFence 在 x86 上零指令 + UNSAFE_LEAF 零状态转换 = 理论上最快的 Java 内存屏障。

### 4.5 Unsafe_AllocateInstance — 不调构造函数的对象分配

`unsafe.cpp:366-369`：

```cpp
UNSAFE_ENTRY(jobject, Unsafe_AllocateInstance(JNIEnv *env, jobject unsafe, jclass cls)) {
  ThreadToNativeFromVM ttnfv(thread);           // ★ 转回 _thread_in_native — JNI AllocObject 要求 native 上下文
  return env->AllocObject(cls);                 // JNI AllocObject: 分配对象空间 + 填零 → 不调 <init>
} UNSAFE_END
```

**为什么调用 `ThreadToNativeFromVM`？** → Unsafe 入口时线程已经在 `_thread_in_vm`（UNSAFE_ENTRY 注入的）。但 `env->AllocObject()` 是 JNI 函数，要求调用者在 `_thread_in_native` 状态。`ThreadToNativeFromVM` 临时切回 native 上下文，调用完成后再切回 VM。

---

## §五 ★★ defineAnonymousClass — 匿名类的特殊生命周期

### 5.1 调用入口

`unsafe.cpp:835-861`：

```cpp
UNSAFE_ENTRY(jclass, Unsafe_DefineAnonymousClass0(JNIEnv *env, jobject unsafe,
         jclass host_class, jbyteArray data, jobjectArray cp_patches_jh)) {
  ResourceMark rm(THREAD);
  jobject res_jh = NULL;
  u1* temp_alloc = NULL;
  InstanceKlass* anon_klass = Unsafe_DefineAnonymousClass_impl(env, host_class, data,
                                    cp_patches_jh, &temp_alloc, THREAD);
  if (anon_klass != NULL) {
    res_jh = JNIHandles::make_local(env, anon_klass->java_mirror());
  }
  // try/finally:
  if (temp_alloc != NULL) {
    FREE_C_HEAP_ARRAY(u1, temp_alloc);                  // 释放临时 class bytes
  }
  if (anon_klass != NULL) {
    anon_klass->class_loader_data()->dec_keep_alive();  // ★ 释放人工 keep_alive，mirror 成为唯一引用
  }
  return (jclass) res_jh;
} UNSAFE_END
```

### 5.2 创建流程 — Unsafe_DefineAnonymousClass_impl

`unsafe.cpp:745-833`：

1. **复制 class bytes** (L770)：`ArrayAccess<>::arraycopy_to_native()` 从 Java `byte[]` 复制到 C-heap。避免在解析过程中 Java 数组被 GC 移动。

2. **处理 cp_patches** (L773-816)：`cp_patches_jh` 是一个 `Object[]`，每个非 null 元素是一个常量池 patch：
   - 生成的 bytecode 中有 `ldc #N` 指令，需要引用某个运行时常量（如 Method*、Class 对象）。
   - 但生成的常量池索引可能不对（生成器不知道目标类的确切 CP 位置）→ JVM 用 cp_patches 替换 CP entries。
   - 普通 `defineClass` 不需要此参数——编译时 CP 已完全解析。

3. **遍历 host class chain** (L783-786)：

```cpp
const Klass* host_klass = java_lang_Class::as_Klass(JNIHandles::resolve_non_null(host_class));
while (host_klass != NULL && host_klass->is_instance_klass() &&
       InstanceKlass::cast(host_klass)->is_anonymous()) {
  host_klass = InstanceKlass::cast(host_klass)->host_klass();     // 向上找到非匿名类
}
```

匿名类的 host 自身可能也是个匿名类 → 沿 `host_klass()` 链向上遍历，直到找到第一个非匿名类作为真正的 host。Host 决定：ClassLoader、ProtectionDomain、Package。

4. **解析 class** (L821)：`SystemDictionary::parse_stream(no_class_name, ...)` → 创建 `InstanceKlass`。传 `no_class_name = NULL` — 匿名类没有独立的类名。

### 5.3 ★ keep_alive 引用计数 — 与普通类的 GC 策略对比

| 维度 | 普通类 (ClassLoader.defineClass) | 匿名类 (Unsafe.defineAnonymousClass) |
|------|--------------------------------|--------------------------------------|
| 注册位置 | `SystemDictionary` | 不注册 |
| 类名 | 有（通过 ClassLoader 查找） | 无（`Class.forName` 找不到） |
| 引用链 | ClassLoader → SystemDictionary → Klass | host_mirror → anonymous mirror → Klass |
| GC 策略 | ClassLoader 被 GC 时类可回收 | host_mirror 被 GC 时类可回收 |
| 创建时 keep_alive | 无特殊处理 | `inc_keep_alive()` 在解析期间人工保持 ClassLoaderData 存活 |
| 创建后 keep_alive | 永久被 ClassLoader 持有 | `dec_keep_alive()` (L855) → mirror 成为唯一引用 |
| 典型用途 | 应用代码 | GeneratedMethodAccessor（反射）、Lambda 类、invokedynamic 引导类 |

**`dec_keep_alive()` 的意义**：在 `Unsafe_DefineAnonymousClass0` 返回前（L855），`anon_klass->class_loader_data()->dec_keep_alive()` 释放解析期间的人工引用。此后：
- 如果调用者持有返回的 `jclass` → mirror 存活 → Klass 存活。
- 如果调用者丢弃 `jclass` → mirror 可被 GC → Klass 也可被 GC — 即使 ClassLoader 仍然存活！

这就是匿名类的 **GC 友好生命周期**：每个反射方法 (`ReflectAccess`) 生成一个 GeneratedMethodAccessor 匿名类 → 反射调用结束 → mirror 无引用 → 类被回收 → Metaspace 不泄漏。如果用普通 ClassLoader 加载 → 每个生成的类永久占用 Metaspace → 长时间运行的服务（如 JSP 编译、Groovy eval）会 Metaspace OOM。

### 5.4 ClassFileParser 对匿名类的特殊处理

- **`_host_klass` 字段**：`InstanceKlass::_host_klass` 指向 non-anonymous host class（通过 host_klass chain 找到的）。
- **`_is_anonymous` 标志**：标记此类是匿名类（区别于 `_is_unsafe_anonymous`）。
- **cp_patches**：替换待修补的 CP entries，将 symbolic references 替换为解析后的 direct references。

---

## §六 ★★ 和 [09-01][09-04] 的交叉验证

### 6.1 UNSAFE_ENTRY → JVM_ENTRY(static, ...)

`unsafe.cpp:65-66`：

```cpp
#define UNSAFE_ENTRY(result_type, header) \
  JVM_ENTRY(static result_type, header)      // ★ 仅多了 static 前缀
```

展开后与 [09-04] §一的 `JVM_ENTRY` 完全相同：注入 `ThreadInVMfromNative __tiv(thread)` → 线程 `_thread_in_native` → `_thread_in_vm`。`static` 前缀不影响线程状态转换逻辑。

### 6.2 ★ Unsafe_Park 的二阶状态转换 — [09-01] 没覆盖的场景

`Unsafe_Park` 是 09 阶段唯一一个在 JVM 入口函数内发生 **两次** 线程状态改变的函数：

```
状态流: _thread_in_native (4)
  → [UNSAFE_ENTRY → ThreadInVMfromNative ctor]           ← [09-01]§二 覆盖
  → _thread_in_native_trans (5)
  → _thread_in_vm (6)
  → [ThreadBlockInVM tbivm(jt)]                           ← ★ 二阶转换
  → _thread_in_vm_trans (7)                               ← trans_and_fence: from→from+1→to
  → _thread_blocked (10)                                  ← 允许 safepoint
  ... pthread_cond_wait ...
  → [ThreadBlockInVM dtor]
  → _thread_in_vm_trans (7)  (实际上从 _thread_blocked 转 _thread_blocked_trans=11)
  → _thread_in_vm (6)
  → [UNSAFE_END → ThreadInVMfromNative dtor]
  → _thread_in_vm_trans (7)
  → _thread_in_native (4)
```

[09-01] 状态图的 8 步循环中只覆盖了：`_thread_in_native → _thread_in_vm` 和 `_thread_in_vm → _thread_blocked` 的独立路径，但没有展示这两个路径**在一个函数调用内串联**时的完整 5 态转换。本文的 Unsafe_Park 补全了这张拼图——这种"一个 JVM 入口函数内发生两次线程状态转换"的模式在 [01]§八.3 术语表中被定义为**二阶状态转换**（术语 #8），这是 09 阶段所有 JVM_ENTRY 函数中唯一出现该模式的地方。

### 6.3 ThreadBlockInVM 的 trans_and_fence

`interfaceSupport.inline.hpp:297-309`：

```cpp
class ThreadBlockInVM : public ThreadStateTransition {
 public:
  ThreadBlockInVM(JavaThread *thread) : ThreadStateTransition(thread) {
    thread->frame_anchor()->make_walkable(thread);   // ★ 栈 walkable — 允许 GC 扫栈
    trans_and_fence(_thread_in_vm, _thread_blocked); // L303: [09-01]§三 讲解
  }
  ~ThreadBlockInVM() {
    trans_and_fence(_thread_blocked, _thread_in_vm); // L306
  }
};
```

`trans_and_fence` (`interfaceSupport.inline.hpp:136-148`)：先设中间态 `from+1` → `serialize_thread_state_with_handler` → `block_if_requested` → 设目标态。内含 OrderAccess::fence() 等效的屏障。细节见 [09-01] §三。

与 `transition_from_native` 的区别（[09-01] 已详细对比）：`trans_and_fence` 在中间态后检查 safepoint + fence；`transition_from_native` 在中间态后 poll + 可能 block。ThreadBlockInVM 使用前者——保证 park 的所有内存写对其他线程可见。

---

## §七 GDB 验证 + 可证伪断言

### 7.1 CAS 调用链完整栈验证

```
(gdb) b unsafe.cpp:919
(gdb) condition 1 p != 0
(gdb) r
Breakpoint 1, Unsafe_CompareAndSetInt (env=..., obj=..., offset=16, e=0, x=1)
    at unsafe.cpp:919
(gdb) bt
#0  Unsafe_CompareAndSetInt             ← Layer 2: JNI
#1  ...                                 ← JNI stub
#2  jdk.internal.misc.Unsafe.compareAndSwapInt  ← Layer 1: Java
(gdb) stepi                            ← step into HeapAccess → Atomic::cmpxchg
(gdb) disas $pc,+20
   lock cmpxchgl %r8d,(%rdi)          ← Layer 5: CPU instruction
```

**可证伪断言 1**：在 `PlatformCmpxchg<4>::operator()` 设置 breakpoint，单步执行到 `lock cmpxchgl` 指令。用 `x/i $pc` 确认指令码前缀 `0xf0`（lock 前缀字节）

**可证伪断言 2**：CAS 失败时 `exchange_value`（返回值）= `[dest]` 旧值 ≠ `compare_value`；成功时 `exchange_value` = `compare_value`。

### 7.2 Parker park/unpark 状态验证

**可证伪断言 3**：unpark before park
```
(gdb) b os_posix.cpp:2249
(gdb) commands → p _counter  ← 应是 0 或 1
(gdb) b os_posix.cpp:2166
(gdb) commands → p _counter  ← unpark 已执行则 >0，park xchg 后快速返回
```
验证：预发 permit 时 park 不进入 ThreadBlockInVM → 不在 `os_posix.cpp:2198` 停止。

**可证伪断言 4**：park 时线程状态变为 `_thread_blocked`
```
(gdb) b os_posix.cpp:2200
(gdb) p jt->_thread_state
  → _thread_blocked (10)
(gdb) bt → 确认来自 Unsafe_Park → Parker::park → ThreadBlockInVM
```

**可证伪断言 5**：counter 初始值为 0，park 消费后归零
```
(gdb) b Parker::Parker
(gdb) p _counter → 0 (初始化)
(gdb) b os_posix.cpp:2166
(gdb) p _counter → 0 或 1 (取决于是否有预发 permit)
(gdb) continue → park 返回后 _counter = 0
```

### 7.3 内存屏障验证

**可证伪断言 6**：`fence()` 汇编为 `lock; addl`
```
(gdb) b unsafe.cpp:361   (Unsafe_FullFence → OrderAccess::fence)
(gdb) stepi
(gdb) x/i $pc → lock addl $0x0,(%rsp)
```

**可证伪断言 7**：`acquire()` 是 0 指令
```
(gdb) b unsafe.cpp:353   (Unsafe_LoadFence → OrderAccess::acquire)
(gdb) stepi 5
(gdb) x/10i $pc-20       ← 前后 10 条指令无 lock/mfence/xchg
```
验证：Unsafe_LoadFence 在 x86 上不产生任何 CPU fence 指令。

### 7.4 defineAnonymousClass 验证

**可证伪断言 8**：匿名类的 `is_anonymous()` 为 true
```
(gdb) b unsafe.cpp:842 (anon_klass 创建后)
(gdb) p anon_klass->is_anonymous() → true
(gdb) p anon_klass->host_klass()  → 非匿名 host class
```

**可证伪断言 9**：匿名类不在 SystemDictionary 中
```
(gdb) p SystemDictionary::find(anon_klass->name(), ...) → NULL
```
使用 `Class.forName(className)` 找不到此类：不注册在 SystemDictionary 中。

**可证伪断言 10**：host klass chain 向上遍历
```
(gdb) b unsafe.cpp:783
(gdb) p host_klass->is_anonymous()  → 如果 true，while 循环执行
(gdb) p host_klass  → 追踪到非匿名类
```

### 7.5 综合验证

**可证伪断言 11**：`get()` 和 `get_volatile()` 在 x86 汇编层差异
```
(gdb) b MemoryAccess<...>::get()
(gdb) b MemoryAccess<...>::get_volatile()
(gdb) disas → get(): 纯 mov; get_volatile(): mov + compiler_barrier (无额外 CPU 指令)
```

**可证伪断言 12**：`Unsafe_AllocateInstance` 不调构造函数
```
(gdb) b unsafe.cpp:368 (env->AllocObject(cls) 之前)
(gdb) p cls → java.lang.Class (private 构造函数!)
(gdb) continue
(gdb) p res_jh → 非 null，对象已分配，但 <init> 从未调用
```

---

## 总结 — 九个核心发现

| # | 发现 | 核心洞察 |
|---|------|--------|
| 1 | CAS 5 层穿透 | Java 的一行 `compareAndSet` → 5 层调用 → CPU 的一条 `lock cmpxchgl`，每层参数形式不同 |
| 2 | HeapAccess vs RawAccess | `p == NULL` 决定是否走 GC barrier 路径——off-heap CAS 避免 compressed oop 解码和 SATB |
| 3 | lock cmpxchgl 寄存器映射 | `%eax`=期望值, `%1` (r)=新值, `(%3)`=dest, `lock`=缓存行锁 → RMW 跨核原子性 |
| 4 | Parker 3 层协议 | xchg (无锁 fast path) → trylock (避锁竞争) → double check (防窗口丢失) = 完美 lost wakeup 预防 |
| 5 | counter 是"永不错过的信号" | cond_signal 可能丢失但 counter 永不错过 → double check 捕获所有 pre-wait unpark |
| 6 | x86 7 种屏障仅 1 种需 CPU 指令 | TSO 保证 load/load, store/store, load/store 不乱序 → storeload 是唯一需要 flush store buffer 的 |
| 7 | LockSupport 的实现深度 | park() = UNSAFE_ENTRY → Parker::park → xchg → ThreadBlockInVM → pthread_cond_wait → 5 次线程状态转换 |
| 8 | park 的二阶线程状态转换 | `_thread_in_native → _thread_in_vm → _thread_blocked → _thread_in_vm → _thread_in_native` — [09-01] 未覆盖的 5 态串联 |
| 9 | 匿名类的 GC 友好生命周期 | 不注册 ClassLoader → 仅被 mirror 引用 → mirror GC → 类回收 → Metaspace 不泄漏 |
