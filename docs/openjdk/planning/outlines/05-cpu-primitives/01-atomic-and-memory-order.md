# 01. 原子操作与内存屏障 — LOCK cmpxchg 为什么这么贵？

> 🔴 Deep | 9 KP 中的 3 个核心机制
> 读者处境: volatile 和 synchronized 的最终硬件原语——`lock cmpxchg`。这 1 字节前缀的代价远超你想象。

### 1. Atomic — x86 LOCK vs ARM LL/SC loop

场景: 两个线程同时 `Atomic::cmpxchg(&flag, old_val, new_val)`。硬件怎么保证只有一个成功？

**x86: `lock cmpxchg [mem], rX`** (`atomic.hpp:40`):
- CMPXCHG 本身不是原子的——必须加 LOCK 前缀
- LOCK 做了什么: 锁定内存总线+锁定 cache line (MESI exclusive state)
- [x86: MESI protocol (Modified/Exclusive/Shared/Invalid)——LOCK cmpxchg 时 CPU 把 cache line 置为 Modified。其他 CPU 同一 cache line 被 Invalidated。它们下次访问→cache miss→重新从内存读 (100-200ns)。这才是 LOCK 的真正代价——不是 1 字节前缀本身的开销——是所有其他 CPU 的 cache miss]
- 源码: `atomic.hpp:80` 模板——`Atomic::add/fetch_and_add` → `lock xadd`——同 MESI 机制
- 模板化 OrderSelect: `Atomic::load<memory_order_release>` → 编译期选择合适 barrier 强度 (`atomic.hpp:120`)

**ARM: `ldrex + strex loop`** (对比):
- ldrex (load exclusive): 标记 cache line——CPU 记住"我正在观察这个地址"
- strex (store exclusive): 如果地址未被其他 CPU 修改→写入成功 (返回 0)；否则→loop 重试
- [x86: LOCK 是"悲观锁"——先锁定总线再操作。LL/SC 是"乐观锁"——先操作再检查是否被修改。LL/SC 无锁总线——更省电——但高竞争时 loop 可能 fail 多次——延迟不可预测]

### 2. OrderAccess — JVM 四种 barrier

**四种屏障** (`orderAccess.hpp:50-85`):
- loadload: 两个 load 的顺序——x86 TSO 天生保证 (no-op)
- loadstore: load 在后续 store 前完成——x86 TSO 天生保证
- storestore: GC write barrier——card dirty 标记在后续 store 前可见
- storeload: volatile 写后读——x86 TSO **不保证**——需要 mfence 或 lock 指令
- [x86: TSO (Total Store Order)——store buffer + in-order commit。store→store buffer→L1 cache——后续 load 可能先于 store 完成 (store buffer 尚未 commit)。storeload barrier 必须 flush store buffer——mfence 或 `lock add $0, (%rsp)`]

**UseMembar flag** (`orderAccess.cpp:22`):
- UseMembar=false → 序列化页替代 mfence (Domain 1 OS 实现)
- [x86: mfence = 33-100 cycles——阻塞 CPU pipeline。序列化页 mprotect = 1 次系统调用 + IPI → ~1µs。如果 safepoint 间隔中 storeload barrier 数量 >20 → mprotect 比累积 mfence 开销小]

### 3. SafeFetch — 不 crash 的"尝试读"

**SafeFetch32 / SafeFetchN** (`safefetch.inline.hpp:32-45`):
- 场景: JVMTI GetLocalVariable——读栈上的局部变量——栈帧可能已无效
- 实现: sigsetjmp 保存所有寄存器 + 信号掩码→mov 读目标地址→正常→返回 true；SIGSEGV→siglongjmp 回恢复点→返回 false
- [C++: sigsetjmp/siglongjmp——POSIX 非局部跳转。sigsetjmp 保存完整的 jmp_buf (16 个 GPR + 8 个 x87 ST + 16 个 XMM + signal mask) = ~200B。siglongjmp 恢复全部——程序在 sigsetjmp 位置继续执行。比 C++ try/catch 强——SIGSEGV 不能被 try/catch 捕获]
- [man 3 sigsetjmp] [man 3 siglongjmp]

---

### 核心悬念

**"LOCK 1 字节——所有其他 CPU 的 cache miss——这才是真正的代价。"** — 不只是单条指令的开销。MESI protocol invalidation——所有其他核心的相同 cache line 被 Invalid——下次访问 100-200ns 延迟 (cache miss 从 L3/内存重读)。SafeFetch 用 sigsetjmp 在零开销正常路径和 ~100ns 异常路径之间做极致 tradeoff。下一篇: RegisterMap——JIT 怎么告诉 GC "R12 里是 String，不是 int"？

> → [02-registermap-and-frame-anchor.md](02-registermap-and-frame-anchor.md)
