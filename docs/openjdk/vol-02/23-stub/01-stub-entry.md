# 01. JVM 启动时预生成哪些汇编例程?— StubRoutines 全局桩

> **前置依赖**:[09-memory-core/01 — Universe](openjdk/vol-02/09-memory-core/01-universe-heap.md):init_globals 的时序在这里展开,本篇的桩就是生成在那一串初始化里;[02-assembler/01 — CodeBuffer](openjdk/vol-02/02-assembler/01-codebuffer-abstract-assembler.md):桩的生成载体;[16-code-cache/01 — CodeBlob 与 CodeHeap](openjdk/vol-02/16-code-cache/01-codeblob-heap.md):桩最终以 BufferBlob 住进 CodeCache
> → **后续**:[23-stub/02 — Arraycopy 向量化](02-arraycopy.md)(arraycopy 怎么做到 3x 加速)
> 关联域: 02-assembler(机器码生成)、09-memory-core(启动时序)、16-code-cache(CodeBlob)、13-jit

## 启动时,除了数据结构,还有一段手写汇编

JVM 启动不只初始化 C++ 数据结构——它还**现场生成一批手写汇编例程**(stub)存进 CodeCache: 抛异常、原子操作、调用桩、arraycopy、AES/SHA……编译代码执行到这些高频操作时直接跳桩,不经过 C++ 函数调用。这一篇拆 23 域的第一块: 两本账簿(_code1/_code2)怎么分阶段生成、throw stub 为什么必须用汇编、atomic stub 解决了什么。

## 1. 两本账簿: _code1/_code2 两阶段

### 为什么分两批: genesis 前的依赖

全局桩入口表是 `StubRoutines`(stubRoutines.hpp),代码本体放在两个 BufferBlob 里(stubRoutines.hpp:123-124,截取核心,逐字):

```cpp
// stubRoutines.hpp:123-124(截取核心,逐字)
  static BufferBlob* _code1;                               // code buffer for initial routines
  static BufferBlob* _code2;                               // code buffer for all other routines
```

两个初始化函数(stubRoutines.cpp:188-202 与 :275-283,截取核心,逐字):

```cpp
// stubRoutines.cpp:188-202(截取核心,逐字)
void StubRoutines::initialize1() {
  if (_code1 == NULL) {
    ResourceMark rm;
    TraceTime timer("StubRoutines generation 1", TRACETIME_LOG(Info, startuptime));
    _code1 = BufferBlob::create("StubRoutines (1)", code_size1);
    if (_code1 == NULL) {
      vm_exit_out_of_memory(code_size1, OOM_MALLOC_ERROR, "CodeCache: no room for StubRoutines (1)");
    }
    CodeBuffer buffer(_code1);
    StubGenerator_generate(&buffer, false);
    // When new stubs added we need to make sure there is some space left
    // to catch situation when we should increase size again.
    assert(code_size1 == 0 || buffer.insts_remaining() > 200, "increase code_size1");
  }
}
```

- **`stubRoutines_init1`(init.cpp:110)在 `universe_init`(:111)之前**——genesis 创建基本 oop 时若分配失败要抛 OOM,抛异常得靠桩,所以**第一批桩必须先于 genesis 存在**;
- **`stubRoutines_init2`(init.cpp:144)在 `universe2_init`(:124,genesis)之后**——第二批(重活)等堆与元数据就绪再生成。

`StubGenerator_generate`(x86 平台函数)用**同一个 StubGenerator 分两次调用**不同的入口: `generate_initial`(stubGenerator_x86_64.cpp:5869,第一批: forward_exception/call_stub/原子操作/**栈溢出相关的抛异常桩**)与 `generate_all`(:5971,第二批: 其余抛异常桩(AbstractMethodError/ICCE/NPE,:5977-5984)、f2i/f2l fixup、**arraycopy**(generate_arraycopy_stubs,:2866/:6017)、safefetch(:6095)、crypto/math)。

### 生成器: StubCodeGenerator

`StubCodeGenerator`(stubCodeGenerator.hpp:97-110)是桩的生成骨架: 持有 `MacroAssembler* _masm`(向 CodeBuffer 里吐 x86 指令);`StubCodeMark`(:113-126)给每个桩登记名字(StubCodeDesc 表),调试时按地址反查桩名。

## 2. throw stubs: 为什么抛异常也要一段汇编

### 列表与生成

一批"抛异常"桩(stubRoutines.hpp:97-101): AbstractMethodError、IncompatibleClassChangeError、NullPointerException(at call)、StackOverflowError、delayed StackOverflowError。生成走 `generate_throw_exception`(stubGenerator_x86_64.cpp:5758 起),调用点如 :5906-5915(截取核心,逐字):

```cpp
// stubGenerator_x86_64.cpp:5906-5915(截取核心,逐字)
    StubRoutines::_throw_StackOverflowError_entry =
      generate_throw_exception("StackOverflowError throw_exception",
                               CAST_FROM_FN_PTR(address,
                                                SharedRuntime::
                                                throw_StackOverflowError));
    StubRoutines::_throw_delayed_StackOverflowError_entry =
      generate_throw_exception("delayed StackOverflowError throw_exception",
                               CAST_FROM_FN_PTR(address,
                                                SharedRuntime::
                                                throw_delayed_StackOverflowError));
```

### 为什么不用 C++ 函数

编译代码发现 NPE 时,如果直接 call C++ 函数——**编译帧的布局约定与 C++ 帧不同**。generate_throw_exception 的注释先把帧布局记账(:5762-5765,截取核心,逐字):

```cpp
// stubGenerator_x86_64.cpp:5762-5765(截取核心,逐字)
    // Information about frame layout at time of blocking runtime call.
    // Note that we only have to preserve callee-saved registers since
    // the compilers are responsible for supplying a continuation point
    // if they expect all registers to be preserved.
```

stub 按这个布局处理帧与 callee-saved 寄存器后再进 C++ 的 exception handler,且**从不返回**(调用方不需要清理)。

## 3. atomic stubs: 编译代码的原子操作

第一批桩里有**一整个原子操作家族**(generate_initial,stubGenerator_x86_64.cpp:5889-5897,截取核心,逐字):

```cpp
// stubGenerator_x86_64.cpp:5889-5897(截取核心,逐字)
    // atomic calls
    StubRoutines::_atomic_xchg_entry          = generate_atomic_xchg();
    StubRoutines::_atomic_xchg_long_entry     = generate_atomic_xchg_long();
    StubRoutines::_atomic_cmpxchg_entry       = generate_atomic_cmpxchg();
    StubRoutines::_atomic_cmpxchg_byte_entry  = generate_atomic_cmpxchg_byte();
    StubRoutines::_atomic_cmpxchg_long_entry  = generate_atomic_cmpxchg_long();
    StubRoutines::_atomic_add_entry           = generate_atomic_add();
    StubRoutines::_atomic_add_long_entry      = generate_atomic_add_long();
    StubRoutines::_fence_entry                = generate_orderaccess_fence();
```

`generate_atomic_xchg` 的实现暴露了"为什么是汇编"(stubGenerator_x86_64.cpp:560-577,截取核心,逐字):

```cpp
// stubGenerator_x86_64.cpp:560-577(截取核心,逐字)
  address generate_atomic_xchg() {
    StubCodeMark mark(this, "StubRoutines", "atomic_xchg");
    address start = __ pc();

    __ movl(rax, c_rarg0); // Copy to eax we need a return value anyhow
    __ xchgl(rax, Address(c_rarg1, 0)); // automatic LOCK
    __ ret(0);

    return start;
  }
```

三条指令: 参数进 rax、`xchg`(指令本身自带 LOCK 语义,注释 "automatic LOCK")、返回。**为什么只有编译代码用这些桩?** 解释器与 VM 代码用 C++ 内联的 `Atomic::cmpxchg`(x86 上是内联汇编的 lock cmpxchg),不需要跳桩;桩服务的对象是**编译代码**——它按编译代码的调用约定传参(参数寄存器 c_rarg0/1,桩内注释 :569-572 逐条列了参数与返回值约定)。

**关键设计 (斜体)**: *桩的本质是"把高频小操作预编译成手写汇编": 启动期一次性生成、按约定传参、零 C++ 开销。两阶段(_code1/_code2)是依赖顺序的产物——第一批必须先于 genesis(抛异常是分配失败的兜底),第二批等堆就绪。而"为什么用汇编"统一答案: 编译帧的约定与 C++ 帧不同,直接 call 会弄乱栈;手写桩两头都伺候好。*

## 核心悬念

桩的骨架到齐: _code1/_code2 两个 BufferBlob 按 genesis 前后分批生成(init.cpp:110/:144,generate_initial/generate_all 两次调用);StubCodeGenerator + StubCodeMark 是生成与登记骨架;throw 桩解决编译帧调用约定问题(先修 rbp 再进 C++ handler);atomic 家族 8 个桩(xchg 自带 LOCK)专供编译代码。但第二批桩里藏着一个大头没展开: **arraycopy**——System.arraycopy 每秒被调成千上万次,它的桩用了 SSE/AVX 向量化。下一篇: Arraycopy 向量化。

> → [23-stub/02 — Arraycopy 向量化](02-arraycopy.md)
