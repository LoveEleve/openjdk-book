# 03. 编译代码里抛了异常——JVM 怎么找 handler？— 异常处理 + 辅助

> 🔴 Deep | 3 KP 中的异常链路 + 辅助设施
> 读者处境: 编译代码执行 `a.length`——a 是 null→SIGSEGV。signal handler 发现这是个 compiled frame 中的隐式 NPE→需要决定: 抛 NPE 让 caller 处理，还是可以从这里恢复？

### 1. "这条指令抛了什么异常？" — Implicit Exceptions

场景: 编译代码不显式做 null check——直接用 `mov rdi, [rsi+12]`(rsi=null→SIGSEGV)。signal handler 需要区分是"真正的 crash" 还是 "JVM 可以恢复的隐式异常"。

**三种 ImplicitExceptionKind** (`sharedRuntime.hpp:188-192`):
```cpp
enum ImplicitExceptionKind {
  IMPLICIT_NULL,              // 解引用 NULL→伪装成 NPE
  IMPLICIT_DIVIDE_BY_ZERO,   // idiv with 0→SIGFPE→伪装成 ArithmeticException
  STACK_OVERFLOW              // 栈撞 guard page→SIGSEGV→伪装成 StackOverflowError
};
```
- 源码: `sharedRuntime.hpp:188-192` enum
- 关键设计: 编译代码不生成显式 null check——节省 instructions。代替: 用 SIGSEGV handler 检测 faulting PC 是否对应一个 "implicit null check site"。nmethod 的 `nul_chk_table` 记录了 "哪些 PC 有隐式 null check" →handler 检查 faulting_pc 是否在表中→是→抛 NPE；否→真正的 crash→vm_abort

**continuation_for_implicit_exception** (`sharedRuntime.hpp:201-203`):
```
SIGSEGV handler → SharedRuntime::continuation_for_implicit_exception():
  case IMPLICIT_NULL:
    → 查 nmethod 的 nul_chk_table[pc] → 有 → throw_NullPointerException()
    → 没有 → 真正的 segfault → vm_abort
  case IMPLICIT_DIVIDE_BY_ZERO:
    → throw_ArithmeticException()
  case STACK_OVERFLOW:
    → 先试 reserved zone(throw_delayed_StackOverflowError → enable_stack_reserved_zone)
    → 如果 reserved zone 也溢出 → throw_StackOverflowError_common(delayed=false)
```
- 源码: `sharedRuntime.cpp:1600-1750` continuation_for_implicit_exception
- [x86: SIGSEGV handler 读 cr2 寄存器(出错的地址)——如果 cr2=0→很可能 NULL 解引用。读 faulting instruction 的 opcode——如果是 `mov` 且 src=cr2→验证是 null check。误判的风险: 真正的 null deref 也被当成 NPE——但 Java 语义中 "null.foo = X" 就是 NPE——所以语义正确不需要区分]

**Stack overflow 两阶段** (`sharedRuntime.hpp:198-200`):
```
Phase 1: throw_delayed_StackOverflowError()
  → 设 reserved zone(额外 3 页 = 12KB) → enable_stack_reserved_zone
  → 给线程一个"逃生窗"来 unwind 当前帧
Phase 2: throw_StackOverflowError()  
  → reserved zone 也碰撞了 → 无法恢复 → throw StackOverflowError
```
- 关键设计: 两阶段因为帧 unwind 本身需要栈空间(调 exception handler→建异常对象→copy stack trace→print)——如果初始栈已经溢出→unwind 过程再次溢出。reserved zone 给了 unwind 足够空间

### 2. "handler 在哪？" — exception_handler 查找链

场景: compiled 代码中出了异常→需要找 handler。handler 可能在: (a) 同一 nmethod 的事处理表。(b) caller 的 nmethod。(c) interpreter frame。

**exception_handler_for_return_address** (`sharedRuntime.hpp:182-183`):
```
raw_exception_handler_for_return_address(thread, return_address):
  1. CodeCache::find_nmethod(return_address) → nmethod*
  2. nmethod->handler_table_begin → 查表: bci在异常范围?→handler pc
  3. 找到 → return handler address
  4. 未找到 → return NULL(交给 caller 处理)
```
- 源码: `sharedRuntime.cpp:1400-1550` raw_exception_handler_for_return_address
- [C++: handler_table 是异常表编码——每个 entry: {start_bci, end_bci, handler_bci, catch_type}——but compiled to {start_pc, end_pc, handler_pc, catch_type_index}。运行时解引用 catch_type_index→oop table→Klass check→匹配→跳 handler pc]

**compute_compiled_exc_handler** (`sharedRuntime.hpp:186-187`):
```
compiled 帧中异常处理:
  1. 同上找 nmethod handler table
  2. 找到 → return handler address(在同一个 nmethod 中)
  3. 未找到 → 栈展开: pop compiled frame → 在 caller 的 frame 继续查
     - 如果 caller 是 compiled → 回到步骤1
     - 如果 caller 是 interpreted → interpreter 接管异常处理
```
- 关键设计: 栈展开的迭代——每一帧都独立处理。"一次性扫描所有帧"比"逐帧 pop"更安全但更慢——JVM 选逐帧因为异常路径本身就罕见

### 3. "打不过，找帮手" — monitor helpers + math support

场景: 编译代码可以 inline 轻量锁(fast_enter cmpxchg)——但遇到 inflation 或 biased lock revoke 需要走 VM 慢路径。

**monitor_enter_helper** (`sharedRuntime.hpp:340-341`):
```
编译代码:
  cmpxchg → 成功 → return (fast path, ~20 cycles)
  cmpxchg → 失败 → call monitor_enter_helper(obj, lock, thread)
    → ObjectSynchronizer::fast_enter(处理 biased/BasicLock 升级)
    → ObjectSynchronizer::slow_enter(ObjectMonitor enter)
```
- 源码: `sharedRuntime.hpp:340-341` + `synchronizer.cpp:80-240` fast_enter/slow_enter
- 关键设计: monitor 入口是编译代码生成的——不是 SharedRuntime 独有的。SharedRuntime 只是提供了"慢路径进入 VM"的统一 wrapper

**Math transcendental 函数** (`sharedRuntime.hpp:137-143` + `sharedRuntimeTrans.cpp` + `sharedRuntimeTrig.cpp`):
```
dsin/dcos/dtan/dlog/dexp/dpow — 软件实现(当 CPU 无指令时)
f2i/d2l — IEEE 754 舍入模式设置后转换
montgomery_multiply — RSA crypto openSSL alternative
```
- 源码: `sharedRuntimeTrans.cpp:50-400` dsin 实现(泰勒级数)
- 关键设计: 这些是 Intel libm 的 fork——保留了精度但不依赖外部库。除零和 NaN 处理与 IEEE 754 一致

---

### 核心悬念

**"SharedRuntime 的异常处理通过 continuation_for_implicit_exception 区分隐式异常和真 crash——stack overflow 分两阶段(unwind 有逃生窗)。exception_handler 通过 nmethod 异常表查找 handler→未找到→逐帧展开。"** — 下一篇: 域22 Deoptimization——逆优化的完整引擎。

> → 域22 Deoptimization
