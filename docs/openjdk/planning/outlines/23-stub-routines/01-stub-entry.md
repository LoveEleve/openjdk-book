# 01. JVM 启动时预生成哪些汇编例程？— StubRoutines 全局桩

> ⚠️ 写作期修正(2026-08-13, vol-02/23-stub/01 已按真实源码成文~125 行,本大纲为规划期产物,机制描述以文章为准):
> - **两阶段**: _code1/_code2(stubRoutines.hpp:123-124);initialize1(stubRoutines.cpp:188-202)/initialize2(:275-283)=BufferBlob::create+StubGenerator_generate;时序=stubRoutines_init1(init.cpp:110)先于 universe_init(:111),init2(:144)在 universe2_init(:124)后;generate_initial(:5869 forward_exception/call_stub/catch_exception/atomic 8 个(:5889-5897)/throw 桩)/generate_all(:5971)
> - **throw 桩**(stubRoutines.hpp:97-101 声明): generate_throw_exception(stubGenerator_x86_64.cpp:5758)先记账帧布局(:5762-5765 "Information about frame layout at time of blocking runtime call...preserve callee-saved registers");"rbp 链弄乱"为流传解释,正文收敛到源码注释
> - **atomic 桩**: generate_atomic_xchg(:560-577)=movl+xchgl(自动 LOCK)+ret;参数注释 :569-572;"只有编译代码用桩"原因=解释器/VM 用 C++ 内联 Atomic::cmpxchg
> - StubCodeGenerator(stubCodeGenerator.hpp:97-110 _masm)+StubCodeMark(:113-126 桩名登记 StubCodeDesc);"stubCodeGenerator.hpp:35-80" 漂移
> - 悬念指向 02-arraycopy.md(标题 "02. Arraycopy 向量化——System.arraycopy 怎么做到 3x 加速")✓

> 🔴 Deep | 2 KP 中的桩入口表
> 读者处境: JVM 启动时不仅初始化数据结构——还生成一段手写汇编代码存进 CodeCache。异常抛出、原子CAS、call stub——这些高频操作直接从 CodeCache 跳桩而不走 C++ 函数调用。

### 1. "我有两本账簿" — _code1 + _code2 两阶段

场景: JVM 初始化有两阶段——部分 stub(exception throwing, call stub, atomic ops)在 Universe::genesis() 前就必须存在(因为 genesis 创建基本 oop 时需要 throw exception)。其余可以在 genesis 后生成。

**_code1/_code2 分配** (`stubRoutines.hpp:123-124`):
```
_code1: 第一个 BufferBlob — 初始 stub(阶段1, genesis前):
  - exception stubs (throw_AbstractMethodError/NullPointerException/StackOverflowError)
  - call_stub (Java→native 的调用入口)
  - forward_exception / catch_exception
  - atomic ops (xchg/cmpxchg/add)
  - safefetch32/N

_code2: 第二个 BufferBlob — 其余 stub(阶段2, genesis后):
  - arraycopy (所有类型+disjoint+conjoint+检查+fill)
  - crypto intrinsics (AES/SHA/CRC32/GHASH)
  - math transcendental (dsin/dcos/dexp/dlog/dpow)
  - BigInteger (multiplyToLen/squareToLen/montgomery*)
```
- 源码: `stubRoutines.hpp:93-230` 全地址声明 + `stubRoutines.cpp:90-150` initialize1/initialize2
- 关键设计: 分层分配不是"更大buffer"需求——是依赖顺序：exception stub 在 genesis 前就需要(genesis 中 allocate 失败可能抛 OOM→需要 throw_* stub)。_code1 约 ~4KB，_code2 约 ~40KB+。分离确保 genesis 前不失败
- [C++: `StubRoutines::initialize1()` 创建 StubGenerator→gen _code1→放入 CodeCache。`initialize2()` 用已有 StubGenerator→gen _code2→追加到 CodeCache。不是两个 Generator——同一个 generator 分两次调用 generate_all{"initial","continuation"}]

**StubGenerator 与 StubCodeGenerator** (`stubCodeGenerator.hpp:35-80`):
```cpp
class StubCodeGenerator: public StackObj {
  MacroAssembler* _masm;         // x86 汇编器
  CodeBuffer* _code_buffer;      // 当前 code buffer
  // 辅助方法: save/restore registers, create RuntimeStub
};
```
- 源码: `stubCodeGenerator.hpp:35-80` + `stubRoutines.hpp:87` friend class StubGenerator
- 关键设计: StubCodeGenerator 持有 MacroAssembler——每个 generate_* 函数通过 `__ emit_t` 调用 assembler 指令生成实际 x86 机器码(如 `__ movl(rscratch, 0)`→4 bytes 进 CodeBuffer)

### 2. "exception 是怎么抛的？" — throw stubs

场景: 编译代码在执行——发现 null→需要抛 NPE。不是调 SharedRuntime::throw_NullPointerException(C++ 函数)——是 call `_throw_NullPointerException_at_call_entry`(汇编 stub)。

**throw stub 列表** (`stubRoutines.hpp:97-101`):
```
_throw_AbstractMethodError_entry
_throw_IncompatibleClassChangeError_entry
_throw_NullPointerException_at_call_entry
_throw_StackOverflowError_entry
_throw_delayed_StackOverflowError_entry
```
- 源码: `stubRoutines.hpp:97-101` 声明 + `stubGenerator_x86_64.cpp:200-350` generate_throw_exception
- 关键设计: 为什么用 stub 而非 C++ 函数？编译代码的调用约定(rsp/rbp 一定是 compiled frame 的格式)→如果直接 call C++→C++ 的 prologue(push rbp; mov rbp,rsp)会把 rbp 链弄乱。stub 先处理帧格式→恢复 解释器/编译帧的 rbp→再调 C++ exception handler
- [x86: throw stub 的汇编: push exception_oop→set thread → call SharedRuntime::throw_xxx→从不返回。调用者不需要清理栈——stub 调用 `should_not_reach_here()`]

### 3. "原子操作——不用锁" — atomic stubs

场景: 需要原子 CAS 在 64-bit 变量上——但编译代码没有 lock cmpxchg64 指令→call `_atomic_cmpxchg_long_entry` stub。

**atomic stub 列表** (`stubRoutines.hpp:103-111`):
```
_atomic_xchg_entry          → lock xchg [dst], src
_atomic_xchg_long_entry     → lock cmpxchg8b
_atomic_cmpxchg_entry       → lock cmpxchg [dst], src
_atomic_cmpxchg_long_entry  → lock cmpxchg16b (64-bit 原子 CAS)
_atomic_add_entry           → lock xadd [dst], src
```
- 源码: `stubRoutines.hpp:103-111` + `stubGenerator_x86_64.cpp:360-430` generate_atomic_ops
- [x86: cmpxchg 在 rAX 中存 compare_value, rDX:rAX 中存 exchange_value(64-bit)。stub 从调用约定读这些值→执行 lock cmpxchg16b→返回 compare 结果。不调任何 C++——全汇编实现(~15 instructions)]
- [C++: 为什么 atomic stub 只用于编译代码？解释器(JIT fallback)用 C++ 内联 `Atomic::cmpxchg`——在 x86 上是内联汇编(lock cmpxchg)——不需要跳 stub。stub 用于 JavaThread 的状态避免 leave compiled frame]

---

### 核心悬念

**"StubRoutines 用 _code1/_code2 两阶段生成初始 stub(exception+atomic) 和后续 stub(arraycopy+crypto)。StubGenerator 通过分散的 generate_* 函数产生手写 x86 汇编放进 CodeCache。"** — 但 arraycopy 怎么做到 3x 加速？下一篇: Arraycopy 向量化。

> → [02-arraycopy.md](02-arraycopy.md)
