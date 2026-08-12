# 01. 原子操作与内存屏障 — LOCK cmpxchg 为什么这么贵？

> **前置依赖**：[01-os/04 — 信号与安全点](openjdk/vol-02/01-os/04-signals-and-safepoint.md)：序列化页(UseMembar 的替代物)；会读 x86 汇编
> → **后续**：[02 — SafeFetch 与平台层](02-safefetch-and-platform.md)
> 关联域: 19-sync(锁的原子原语)、06-oops(对象头 mark word 的 CAS)、31-unsafe(Unsafe.compareAndSet)

## volatile 和 synchronized,最终都汇到同一个 1 字节前缀

`volatile` 的读、`synchronized` 的进出、`AtomicInteger.compareAndSet`——所有 Java 并发最终都落到 CPU 的原子指令上。x86 上,它们是同一个前缀:**`lock`**。

```
lock cmpxchg [mem], rX     // 比较并交换
lock xadd  [mem], rX       // 加
lock addl  $0,0(%rsp)      // 内存屏障(storeload)
```

`lock` 是 1 个字节的前缀。它的代价远超你想象——不是这 1 字节本身的执行时间,而是**它让所有其他 CPU 都付出代价**。这一篇拆三件事:原子操作(LOCK 机制)、内存屏障(四屏障与 TSO)、SafeFetch(不 crash 的读)。

## 1. Atomic:LOCK 到底锁了什么

### cmpxchg 本身不是原子的

`CMPXCHG` 指令**不加锁时不是原子的**——读比较写之间,另一个 CPU 可能插进来。必须加 `lock` 前缀(atomic_linux_x86.hpp 的实现):

```cpp
// atomic_linux_x86.hpp:72 —— cmpxchg 8 位版本(截取核心)
__asm__ volatile ("lock cmpxchgb %1,(%3)"
                  : "=a" (exchange_value)
                  : "q" (exchange_value), "a" (compare_value), "r" (dest)
                  : "cc", "memory");
```

同文件的兄弟: `lock xaddl`(:45,add)、`lock cmpxchgl`(:86)、`lock xaddq`(:102,64 位 add)、`lock cmpxchgq`(:128,64 位 CAS)。Java 侧的入口是 `Atomic::cmpxchg`(atomic.hpp:129)和 `Atomic::fetch_and_add`(atomic.hpp:670)。

- [x86: MESI protocol(Modified/Exclusive/Shared/Invalid)——`lock` 前缀执行时,CPU 把目标 cache line 置为 Modified,**其他 CPU 持有同一 cache line 的副本被 Invalidated**。它们下次访问 → cache miss → 从 L3/内存重读(100-200ns)。**这才是 LOCK 的真正代价——不是 1 字节前缀,是所有其他 CPU 的 cache miss]**

**关键设计 (斜体)**: *为什么 JVM 的并发原语全都建立在 LOCK 上?x86 的 LOCK 是"悲观锁"——先锁总线/cache line 再操作,语义简单、延迟可预测;代价是每次原子操作都打断其他 CPU 的 cache。ARM 走另一条路:LL/SC(ldrex/strex)——"乐观锁",先操作再检查,无锁总线、更省电,但高竞争下可能循环重试。JVM 用 `Atomic` 抽象把这层差异完全藏起来——上层代码(锁、对象头 CAS)只面对同一套接口。*

## 2. OrderAccess:JVM 的四种屏障

### 四屏障与 TSO

JVM 把内存屏障抽象成四个操作(`orderAccess.hpp:258-261`):

```cpp
// orderAccess.hpp:258-261 —— 完整声明
class OrderAccess : private Atomic {
 public:
  // barriers
  static void     loadload();
  static void     storestore();
  static void     loadstore();
  static void     storeload();
```

- [x86: TSO(Total Store Order)——store 进 store buffer 后按序提交;**后续 load 可能先于之前的 store 完成**(store 还在 buffer 里没落到 cache)。因此 x86 天生保证 loadload/loadstore/storestore(load 和 store 各按序),**唯独 storeload 不保证**——volatile 写后读需要显式屏障]

x86 的实现(`orderAccess_linux_x86.hpp:40-53`)——**四屏障的真实面目是"三个 no-op + 一个真屏障"**:

```cpp
// orderAccess_linux_x86.hpp:40-53(截取核心,逐字)
inline void OrderAccess::loadload()   { compiler_barrier(); }
inline void OrderAccess::storestore() { compiler_barrier(); }
inline void OrderAccess::loadstore()  { compiler_barrier(); }
inline void OrderAccess::storeload()  { fence();            }

inline void OrderAccess::fence() {
   // always use locked addl since mfence is sometimes expensive
#ifdef AMD64
  __asm__ volatile ("lock; addl $0,0(%%rsp)" : : : "cc", "memory");
#else
  __asm__ volatile ("lock; addl $0,0(%%esp)" : : : "cc", "memory");
#endif
```

前三个屏障在 x86 上只是 `compiler_barrier()`——**硬件 TSO 已经保证了顺序,只需阻止编译器重排**(compiler_barrier 是纯编译期约束,零机器指令)。真正的硬件屏障只有一个:`storeload` → `fence()` → `lock addl $0,0(%rsp)`。注意注释:**"always use locked addl since mfence is sometimes expensive"**——把 0 加到栈顶是无意义操作,但 lock 前缀本身就是全屏障,还比 mfence 便宜。

- [x86: mfence ≈ 33-100 cycles,阻塞流水线;lock addl 是"老牌"全屏障——lock 前缀的指令天然是全屏障]

### UseMembar:换一种更便宜的屏障

`UseMembar` 标志(globals.hpp:253-256,平台相关默认)允许 JVM 用**序列化页**替代 mfence——就是第一篇(os 域 04)讲的页面权限切换屏障:

- [x86: 序列化页 mprotect ≈ 1 次系统调用 + TLB shootdown IPI ≈ 1µs;若 safepoint 间隔内需要的 storeload 屏障超过 ~20 次,序列化页比累积 mfence 便宜。这是"把屏障从指令换成内存页面"的极端优化——第一篇 os 域 04 的伏笔在这里兑现]

**关键设计 (斜体)**: *屏障也是可以"换实现"的。JVM 的 OrderAccess 四操作是接口,底下可以是 mfence、lock addl、或者一次 mprotect 系统调用——按平台和场景选最便宜的。这也是整本书反复出现的模式:把"语义"和"实现"分开,实现按机器特性替换。*

## 3. SafeFetch:不 crash 的"尝试读"

### 场景:读一个可能已失效的地址

JVMTI 的 `GetLocalVariable` 要读栈上的局部变量——但栈帧可能已经失效,地址可能已经不可访问。直接读会 SIGSEGV 崩溃。SafeFetch 解决"试读,读不到就返回错误值"(`safefetch.inline.hpp:32`):

```cpp
// safefetch.inline.hpp:32-41(截取核心,逐字)
inline int SafeFetch32(int* adr, int errValue) {
  assert(StubRoutines::SafeFetch32_stub(), "stub not yet generated");
  ...
  return StubRoutines::SafeFetch32_stub()(adr, errValue);   // 走生成的 stub
}
```

注意实现路径:最终调用的是 **`StubRoutines::SafeFetch32_stub()`——一段由 JVM 生成的汇编 stub**,stub 内部才是 sigsetjmp + mov + siglongjmp 的完整流程:

```
sigsetjmp 保存全部寄存器 + 信号掩码   ← 恢复点
    ↓
mov 读目标地址
    ↓
正常返回 → true | SIGSEGV → siglongjmp 跳回恢复点 → 返回 errValue
```

- [C++: sigsetjmp/siglongjmp——POSIX 非局部跳转。sigsetjmp 保存完整 jmp_buf(16 GPR + 8 x87 ST + 16 XMM + signal mask ≈ 200B);siglongjmp 恢复全部,程序从 sigsetjmp 位置继续。比 C++ try/catch 强——**SIGSEGV 不能被 try/catch 捕获**,只能靠信号]
- [man 3 sigsetjmp][man 3 siglongjmp]

**关键设计 (斜体)**: *为什么用"信号跳转"而不是检查地址合法性?检查"这个地址能不能读"本身就要试读(没有安全的查询 API)。SafeFetch 的选择是:正常路径零开销(一条 mov),异常路径才付 siglongjmp 的代价(约 100ns 量级)。这是"乐观执行 + 异常兜底"的极致 tradeoff——和 JIT 的隐式 null check 是同一个哲学家族。*

## 核心悬念

"LOCK 1 字节——所有其他 CPU 的 cache miss——这才是真正的代价。" MESI 的 invalidation 让每次原子操作都打断别的核心;SafeFetch 用 sigsetjmp 在零开销正常路径和 ~100ns 异常路径之间做极致 tradeoff。原子和屏障是"硬件告诉 JVM 的底线"——但 JIT 编译的代码还需要告诉 GC 另一件事:**R12 里到底是 String 还是 int**。下一篇:RegisterMap——JIT 怎么登记寄存器里的对象类型?

> → [02-safefetch-and-platform.md](02-safefetch-and-platform.md):SafeFetch 平台层与 RegisterMap
