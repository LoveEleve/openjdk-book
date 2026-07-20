# 前置概念：StubGenerator —— 十七个桩的一次性代码工厂

> **本文定位**：背景知识文章。你要理解的是 `initialize1()` 中的这行代码：
>
> ```cpp
> StubGenerator_generate(&buffer, false);
> ```
>
> 这一行创建 `StubGenerator` 对象，在构造函数中一口气执行 `generate_initial()`，生成 17+ 个 x86 汇编桩并把每个桩的入口地址写回 `StubRoutines` 表。
>
> 本文是一本电子书的章节——不限制长度。每一行源码都被拆开、每一步数据结构的变化都被展示。
>
> **前置依赖**：前四篇文章分别解释了 stub 是什么（01）、StubRoutines 是什么（02）、BufferBlob 怎么分配（03）、汇编代码怎么写进 payload（04）。读者现在知道"有一块 30000 字节的可执行内存，CodeSection._end 指向写入位置，`__ push(rbp)` 可以向其中写 x86 指令"。
>
> **阅读提示**：本文不重复前文的写入链路，只聚焦 StubGenerator 的组织方式：构造函数分叉、generate_initial() 生成了哪些桩、StubCodeMark 怎么记录每个桩的边界。

---
## 1. 前置知识 —— RAII 和构造时生成

### 1.1 RAII（Resource Acquisition Is Initialization）

在 C++ 中，一个对象在栈上构造时，构造函数自动执行。对象离开作用域时，析构函数自动执行。

```cpp
{
  File f("data.txt");       // 构造：打开文件
  f.write("hello");
}                            // 析构：关闭文件——自动执行，不需要手动调用
```

StubGenerator 利用了这个模式：

```cpp
void StubGenerator_generate(CodeBuffer* code, bool all) {
  StubGenerator g(code, all);   // 构造：自动执行 generate_initial()
}                                // 析构：自动清理 _masm
```

不是：

```cpp
StubGenerator g(code);
g.generate_initial();   // 显式调用——可能被忘记
g.~StubGenerator();     // 显式析构——可能被遗漏
```

### 1.2 为什么用构造函数而不是显式调用

`StubGenerator` 只有一个构造入口（`StubGenerator(CodeBuffer*, bool)`），在构造函数中直接跑了生成逻辑。不会出现"构造了但没调 generate"的中间状态。

`StubGenerator_generate` 能调用 StubGenerator 是因为 StubGenerator 的构造函数是 `public` 的——`friend class StubRoutines` 只是允许 StubGenerator 读写 StubRoutines 的 `private` 字段（见 02 篇 1.2 节）。外部代码直接通过 `StubGenerator_generate` 调用即可。

---

## 2. StubGenerator 构造过程——一分叉

### 2.1 构造函数

```cpp
StubGenerator(CodeBuffer* code, bool all) : StubCodeGenerator(code) {
  if (all) {
    generate_all();
  } else {
    generate_initial();
  }
}
```

**执行顺序**：
1. `StubCodeGenerator(code)` 先执行——创建 `_masm = new MacroAssembler(code)`，绑定到 CodeBuffer._insts
2. 根据 `all` 参数分叉：`false` → `generate_initial()`，`true` → `generate_all()`

`initialize1()` 传 `false`——只走 `generate_initial()`。

### 2.2 all=false vs all=true

`all=false` 是本文研究的路径——走 `generate_initial()`，生成 17+ 个核心桩（call_stub、forward_exception、原子操作、异常桩），存储在 BufferBlob `_code1` 中。

`all=true` 会在后面另一篇初始化文章讲到，本文只关注 `all=false` 路径。`all=true` 路径（本文不展开）会生成更多桩，包括 arraycopy、加密等。

---

## 3. generate_initial() —— 17+ 个核心桩的顺序生成

**每行 `StubRoutines::_xxx_entry = generate_xxx()` 做两件事**：
1. 运行 `generate_xxx()`——内部用 `__ push(rbp)`、`__ call(r8)` 等宏逐条生成 x86 指令。这就是 04 篇讲的完整写入链路：`__` → `_masm->` → Assembler 编码 → CodeSection emit → BufferBlob payload 里被写入了字节。执行完后，BufferBlob 的 payload 里已经有了这段桩的完整机器码。
2. 返回这段机器码的入口地址（`__ pc()` 在第一条指令之前的值），赋给 `StubRoutines` 的对应字段。

所以看到 `StubRoutines::_call_stub_entry = generate_call_stub(...)` 这一行时，实际上 `generate_call_stub` 执行期间 BufferBlob payload 已经被写入了几百字节的 call_stub 机器码。赋给 `_call_stub_entry` 的只是"这段机器码从哪开始"——一个地址。

### 3.1 设置控制字

```cpp
void generate_initial() {
  create_control_words();
  // ...
}
```

`create_control_words()` 初始化了 11 个值（存在 7 个变量里）：

```
_fpu_cntrl_wrd_std   = 0x027F  // 舍入到最近，53-bit 模式，异常 masked
_fpu_cntrl_wrd_trunc = 0x0D7F  // 舍入到零，53-bit，异常 masked
_fpu_cntrl_wrd_24    = 0x007F  // 舍入到最近，24-bit
_fpu_cntrl_wrd_64    = 0x037F  // 舍入到最近，64-bit
_mxcsr_std           = 0x1F80  // MXCSR 标准值
_fpu_subnormal_bias1[]         // strict fp 乘除的 bias 常量（80-bit 值，存为 3 个 int）
_fpu_subnormal_bias2[]         // strict fp 乘除的 unbias 常量（80-bit 值，存为 3 个 int）
```

这些不是可执行代码——是数据常量。`_mxcsr_std` 是 SSE 浮点控制寄存器的标准值，`_fpu_cntrl_wrd_*` 是 x87 FPU 的控制字标准值，`_fpu_subnormal_bias` 两个数组是浮点异常值处理的常量。

它们被 call_stub 通过 `StubRoutines::addr_mxcsr_std()` 引用——call_stub 在跳进 Java 代码前，会检查当前浮点寄存器是否等于这些标准值，不等就用 `ldmxcsr` 覆写。所以 `create_control_words()` 必须排在 `generate_call_stub()` 之前执行。

每个值的位级含义属于 x86 FPU 体系知识，不影响理解 StubGenerator 的整体流程，本文不展开。

### 3.2 三大入口桩——异常、调用、捕获

```cpp
StubRoutines::_forward_exception_entry = generate_forward_exception();
StubRoutines::_call_stub_entry =
  generate_call_stub(StubRoutines::_call_stub_return_address);
StubRoutines::_catch_exception_entry = generate_catch_exception();
```

这三个在 `generate_initial()` 中排最前面，因为它们是 JVM 最早用到的三个 stub：

- **`_call_stub_entry`**：C++ 代码调用 Java 方法的唯一入口。JVM 启动最早执行的 Java 代码（`call_initPhase1()`）就要走它——没有 call_stub，JVM 无法执行任何 Java 方法。所以它必须最早被生成。**它的内部实现（4 步翻译、建 entry_frame、push 参数、call rcx）01 篇已经展开讲过了，本文不重复。**

- **`_forward_exception_entry`**：编译后的 Java 代码抛异常时的"出口"。编译代码检测到异常后，不是自己处理——它跳转到 forward_exception 桩，由这个桩保存当前编译帧的信息、然后跳回 C++ 的异常处理器。如果这个桩不存在，编译代码中的任何异常都会导致 JVM 崩溃（无处可跳）。

- **`_catch_exception_entry`**：用于"巨型方法调用"场景。当一个 Java 方法被大量不同子类覆写、JIT 无法确定具体调哪个版本时，它生成一段通用的 call site 代码，其中引用了 catch_exception 桩作为异常回退路径。

`forward_exception` 和 `catch_exception` 的内部汇编实现和 call_stub 不同（前者的帧布局不一样、跳转目标不一样），但生成模式相同：`StubCodeMark("StubRoutines", "xxx") → __ pc() 标记入口 → 逐条 x86 指令 → return start`。它们的逐行拆解复杂度相当，留给后续专门讲异常处理的章节。

注意 `generate_call_stub` 接受一个输出参数——`_call_stub_return_address` 被填充为 call 指令之后的下一条指令地址。这个值用于帧类型判定（01 篇 4.2 节讲过，栈遍历器用它识别 entry_frame）。

### 3.3 原子操作桩——8 个

```cpp
StubRoutines::_atomic_xchg_entry          = generate_atomic_xchg();
StubRoutines::_atomic_xchg_long_entry     = generate_atomic_xchg_long();
StubRoutines::_atomic_cmpxchg_entry       = generate_atomic_cmpxchg();
StubRoutines::_atomic_cmpxchg_byte_entry  = generate_atomic_cmpxchg_byte();
StubRoutines::_atomic_cmpxchg_long_entry  = generate_atomic_cmpxchg_long();
StubRoutines::_atomic_add_entry           = generate_atomic_add();
StubRoutines::_atomic_add_long_entry      = generate_atomic_add_long();
StubRoutines::_fence_entry                = generate_orderaccess_fence();
```

JVM 不能直接用 C++ 的 `std::atomic`——因为 JVM 需要裸 `lock xchg` / `lock cmpxchg` / `lock add` 指令加精确控制的内存屏障。`std::atomic` 的 `memory_order` 虽然映射到 x86 内存屏障，但 C++ 标准不保证映射是 HotSpot 需要的那种——而且 HotSpot 需要支持 JDK11 时代不存在的内存模型（如 TSO）。

每个原子操作桩通常只有 3-10 条指令——一条 `lock` 前缀 + 操作指令 + `ret`。最小粒度的 stub。

### 3.4 平台相关桩

```cpp
StubRoutines::x86::_get_previous_fp_entry = generate_get_previous_fp();
StubRoutines::x86::_get_previous_sp_entry = generate_get_previous_sp();
StubRoutines::x86::_verify_mxcsr_entry    = generate_verify_mxcsr();
```

这三个只在 x86/x86_64 上有定义（注意命名空间 `StubRoutines::x86::`）：

- `_get_previous_fp_entry` 和 `_get_previous_sp_entry`：用于栈帧回溯，从当前帧恢复上一个帧的 rbp 和 rsp
- `_verify_mxcsr_entry`：debug 构建中检查 MXCSR 寄存器是否符合标准值

### 3.5 异常桩——通过 C++ 函数指针生成

```cpp
StubRoutines::_throw_StackOverflowError_entry =
  generate_throw_exception("StackOverflowError throw_exception",
                           CAST_FROM_FN_PTR(address,
                                            SharedRuntime::throw_StackOverflowError));
StubRoutines::_throw_delayed_StackOverflowError_entry =
  generate_throw_exception("delayed StackOverflowError throw_exception",
                           CAST_FROM_FN_PTR(address,
                                            SharedRuntime::throw_delayed_StackOverflowError));
```

跟原子操作桩不同——`generate_throw_exception` 接受的不是手写 x86 指令，而是一个**C++ 函数指针**。它的工作方式是用 Assembler 自动生成一个 wrapper——设置 Java 帧、调用 C++ 函数、抛异常。

这与"手写 x86 汇编"不同——`generate_throw_exception` 也是手写汇编（它用 `__ enter()` / `__ call(RuntimeAddress(...))` / `__ leave()` 等指令手写了 wrapper 的结构），但包装的是 C++ 函数。

### 3.6 条件生成桩——CRC32 / 数学函数

```cpp
if (UseCRC32Intrinsics) {
  StubRoutines::_updateBytesCRC32 = generate_updateBytesCRC32();
}
if (UseCRC32CIntrinsics) {
  StubRoutines::_updateBytesCRC32C = generate_updateBytesCRC32C(supports_clmul);
}
if (VM_Version::supports_sse2() && UseLibmIntrinsic && InlineIntrinsics) {
  if (is_intrinsic_available(_dexp)) { StubRoutines::_dexp = generate_libmExp(); }
  if (is_intrinsic_available(_dsin)) { StubRoutines::_dsin = generate_libmSin(); }
  // ...
}
```

这些根据 JVM 启动参数和 CPU 能力决定是否生成。如果用户指定 `-XX:-UseCRC32Intrinsics`，对应桩不生成，`_updateBytesCRC32` 保持 NULL。后续 `java.util.zip.CRC32` 的调用会走纯 Java 路径或普通 C++ intrinsic。

### 3.7 汇总——generate_initial() 生成的桩列表

按源码顺序：

| 序号 | 方法 | 赋值字段 | 功能 | 指令数(约) |
|------|------|---------|------|----------|
| 1 | generate_forward_exception | `_forward_exception_entry` | 编译代码异常回溯 | ~50 |
| 2 | generate_call_stub | `_call_stub_entry` | C→Java 桥接 | ~217 |
| 3 | generate_catch_exception | `_catch_exception_entry` | 巨型方法异常捕获 | ~80 |
| 4 | generate_atomic_xchg | `_atomic_xchg_entry` | 原子交换（32-bit） | ~5 |
| 5 | generate_atomic_xchg_long | `_atomic_xchg_long_entry` | 原子交换（64-bit） | ~5 |
| 6 | generate_atomic_cmpxchg | `_atomic_cmpxchg_entry` | CAS（32-bit） | ~8 |
| 7 | generate_atomic_cmpxchg_byte | `_atomic_cmpxchg_byte_entry` | CAS（byte） | ~8 |
| 8 | generate_atomic_cmpxchg_long | `_atomic_cmpxchg_long_entry` | CAS（64-bit） | ~8 |
| 9 | generate_atomic_add | `_atomic_add_entry` | 原子加（32-bit） | ~5 |
| 10 | generate_atomic_add_long | `_atomic_add_long_entry` | 原子加（64-bit） | ~5 |
| 11 | generate_orderaccess_fence | `_fence_entry` | 内存屏障 | ~3 |
| 12 | generate_get_previous_fp | `x86::_get_previous_fp_entry` | 栈回溯取 rbp | ~5 |
| 13 | generate_get_previous_sp | `x86::_get_previous_sp_entry` | 栈回溯取 rsp | ~5 |
| 14 | generate_verify_mxcsr | `x86::_verify_mxcsr_entry` | 浮点控制检查 | ~10 |
| 15 | generate_throw_exception | `_throw_StackOverflowError_entry` | StackOverflowError | ~50 |
| 16 | generate_throw_exception | `_throw_delayed_StackOverflowError_entry` | 延迟 StackOverflowError | ~50 |
| 17+ | CRC32/CRC32C/math | 对应 static 字段 | 硬件加速 / intrinsic | 条件生成 |

---

## 4. StubCodeMark —— 每个桩的起止地址簿记员

### 4.1 问题：17 个桩写在同一个 BufferBlob 里，怎么分界？

`generate_initial()` 中每个 `generate_xxx()` 都往**同一个** BufferBlob（`_code1`）的同一个 payload 区域写 x86 指令——`BufferBlob::create` 只调用了一次，17 个桩的机器码全部挤在同一个 30000 字节 payload 里，一个接一个排列：

```
_code1 的 payload:
  [offset 0~217]    call_stub 的机器码
  [offset 217~267]  forward_exception 的机器码
  [offset 267~347]  catch_exception 的机器码
  [offset 347~...]  atomic_xchg 的机器码
  ...17 个桩依次往后排列...
```

**怎么区分哪个是哪个？** 机器码本身没有边界标记——`call_stub 最后一条 `ret` 的 `0xC3` 和 `forward_exception` 第一条 `push rbp` 的 `0x55` 只是一串连续的字节，看不出分界。区分靠的就是本节的 StubCodeMark——它把每个桩的起止地址存入 `StubCodeDesc` 全局链表，之后给定任意地址，遍历链表就能查到"在 call_stub 的第 52 字节"。

调试时，你看到栈回溯里有一个地址 `0x7fdc00001a34`，这是哪个桩？call_stub 里面的？forward_exception 里面的？如果只靠裸地址，你需要拿着 BufferBlob 的起始地址手动算偏移——但这串字节是机器码，没有边界标记。

**StubCodeMark 解决这个问题**：它在每个 `generate_xxx()` 的入口和出口自动记录"这一段从哪开始、到哪结束"，存进一个全局链表。之后任何地址都可以反查属于哪个桩。

### 4.2 怎么做到的——填充员（栈上）填充，记录本（堆上）永存

这里有两个对象，容易混淆：

| 对象 | 在哪 | 生命周期 |
|------|------|---------|
| `StubCodeMark` | 栈上局部变量 | 函数结束时析构 |
| `StubCodeDesc` | `new` 在 C++ 堆上 | **永不析构**，JVM 运行期一直存在 |

`StubCodeMark` 构造时 `new` 一个 `StubCodeDesc` 节点，把起始地址写进去、插入全局链表。析构时只做一件事：把结束地址补写到这个已经存在的 `StubCodeDesc` 节点上。`StubCodeMark` 自己析构了，但 `StubCodeDesc` 还活着。

每个 `generate_xxx()` 方法开头都有一行：

```cpp
StubCodeMark mark(this, "StubRoutines", "call_stub");
```

这行干了两件事：
1. `new StubCodeDesc("StubRoutines", "call_stub", pc_now)`——在堆上创建记录节点，存起始地址，插入全局链表头部
2. `StubCodeMark` 对象留在栈上——函数结束时自动析构，补写结束地址

`StubCodeMark` 是一个 C++ RAII 对象——构造时执行，函数结束时（无论正常返回还是异常）自动析构。

```
generate_call_stub() {
  StubCodeMark mark(this, "StubRoutines", "call_stub");
  // 构造时：创建一个 StubCodeDesc 节点，记下当前 pc（起始地址），插入全局链表

  address start = __ pc();
  __ push(rbp);
  ... 200+ 条 x86 指令 ...

  return start;
  // mark 析构时：记下当前 pc（结束地址），这样 desc 就有 (begin, end) 了
}
```

记录下来的信息存在 `StubCodeDesc` 节点里：

```cpp
// stubCodeGenerator.hpp:39-80
class StubCodeDesc {
  static StubCodeDesc* _list;       // 全局链表头
  static bool          _frozen;     // 冻结后不能再加节点

  StubCodeDesc* _next;              // 下一个节点
  const char*   _group;             // 分组名（如 "StubRoutines"）
  const char*   _name;              // stub 名称（如 "call_stub"）
  address       _begin;             // 起始地址（包含——stub 从这个地址开始）
  address       _end;               // 结束地址（不包含——stub 最后一个字节是 _end - 1）
};
```

节点构造时用头插法插入全局链表（`_next = _list; _list = this`），运行中的链表是：

```
_list → desc_call_stub("StubRoutines", "call_stub", begin=0x..., end=0x...)
      → desc_forward_exception("StubRoutines", "forward_exception", begin=0x..., end=0x...)
      → desc_catch_exception(...)
      → ...
      → NULL
```

之后 `StubCodeDesc::desc_for(pc)` 遍历这个链表，找到包含给定地址的节点，返回名称——栈回溯就能显示 `call_stub+0x34` 而不是裸地址。

> StubCodeMark 构造和析构内部还有 flush 写缓冲、Forte 性能分析器注册、JVMTI 事件通知等操作，属于调试和 profiling 基础设施，不影响 stub 生成的核心流程，本文不展开。

---

## 5. StubGenerator_generate —— 2 行包装

```cpp
void StubGenerator_generate(CodeBuffer* code, bool all) {
  StubGenerator g(code, all);
}
```

这 2 行的完整含义：

1. 在栈上构造 `StubGenerator g(code, false)`。构造函数立即跑完 `generate_initial()`——17 次 `StubCodeMark` 的构造/析构循环，每轮生成一段 x86 机器码并把入口地址赋给 `StubRoutines` 的对应字段。
2. `g` 离开作用域——析构 `~StubGenerator()` → `~StubCodeGenerator()` → `delete _masm`（释放 Assembler 内部资源）。
3. 函数返回时，CodeBuffer._insts 里已经有所有 stub 的完整二进制机器码。`StubRoutines` 的 17 个 `static address` 字段全指向 BufferBlob payload 里的正确偏移。

**没有返回值**——所有入口地址通过直接在 `generate_initial()` 中赋值 `StubRoutines::_xxx_entry = generate_xxx()` 写回了全局表。

---

## 0. 完整源码清单

### 0a. `stubGenerator_x86_64.cpp` — StubGenerator 类定义核心

**文件**: `src/hotspot/cpu/x86/stubGenerator_x86_64.cpp`

```cpp
// ═══ lines 54-56 — __/a__ 宏 ═══
#define __ _masm->
#define a__ ((Assembler*)_masm)->

// ═══ lines 69-80 — StubGenerator 类定义 ═══
class StubGenerator: public StubCodeGenerator {
 private:
 protected:
  address generate_call_stub(address& return_address);
  address generate_forward_exception();
  address generate_catch_exception();
  address generate_atomic_xchg();
  // ... 20+ 个 generate_xxx() 方法

 public:
  StubGenerator(CodeBuffer* code, bool all) : StubCodeGenerator(code) {
    if (all) {
      generate_all();
    } else {
      generate_initial();
    }
  }

  // ═══ lines 5869-5969 — generate_initial() ═══
  void generate_initial() {
    create_control_words();

    StubRoutines::_forward_exception_entry = generate_forward_exception();
    StubRoutines::_call_stub_entry =
      generate_call_stub(StubRoutines::_call_stub_return_address);
    StubRoutines::_catch_exception_entry = generate_catch_exception();

    StubRoutines::_atomic_xchg_entry          = generate_atomic_xchg();
    StubRoutines::_atomic_xchg_long_entry     = generate_atomic_xchg_long();
    StubRoutines::_atomic_cmpxchg_entry       = generate_atomic_cmpxchg();
    StubRoutines::_atomic_cmpxchg_byte_entry  = generate_atomic_cmpxchg_byte();
    StubRoutines::_atomic_cmpxchg_long_entry  = generate_atomic_cmpxchg_long();
    StubRoutines::_atomic_add_entry           = generate_atomic_add();
    StubRoutines::_atomic_add_long_entry      = generate_atomic_add_long();
    StubRoutines::_fence_entry                = generate_orderaccess_fence();

    StubRoutines::x86::_get_previous_fp_entry = generate_get_previous_fp();
    StubRoutines::x86::_get_previous_sp_entry = generate_get_previous_sp();
    StubRoutines::x86::_verify_mxcsr_entry    = generate_verify_mxcsr();

    StubRoutines::_throw_StackOverflowError_entry =
      generate_throw_exception("StackOverflowError throw_exception", ...);
    StubRoutines::_throw_delayed_StackOverflowError_entry =
      generate_throw_exception("delayed StackOverflowError throw_exception", ...);

    if (UseCRC32Intrinsics) {
      StubRoutines::_updateBytesCRC32 = generate_updateBytesCRC32();
    }
    // ... CRC32C, math intrinsics 条件生成 ...
  }
};

// ═══ line 6134 — 类声明结束 ═══
}; // end class declaration

// ═══ lines 6136-6138 — StubGenerator_generate 包装函数 ═══
void StubGenerator_generate(CodeBuffer* code, bool all) {
  StubGenerator g(code, all);
}
```

### 0b. `stubCodeGenerator.cpp` — StubCodeMark 构造/析构

**文件**: `src/hotspot/share/runtime/stubCodeGenerator.cpp`

```cpp
// ═══ lines 109-115 — StubCodeMark 构造函数 ═══
StubCodeMark::StubCodeMark(StubCodeGenerator* cgen, const char* group, const char* name) {
  _cgen  = cgen;
  _cdesc = new StubCodeDesc(group, name, _cgen->assembler()->pc());
  _cgen->stub_prolog(_cdesc);
  _cdesc->set_begin(_cgen->assembler()->pc());
}

// ═══ lines 117-127 — StubCodeMark 析构函数 ═══
StubCodeMark::~StubCodeMark() {
  _cgen->assembler()->flush();
  _cdesc->set_end(_cgen->assembler()->pc());
  assert(StubCodeDesc::_list == _cdesc, "expected order on list");
  _cgen->stub_epilog(_cdesc);
  Forte::register_stub(_cdesc->name(), _cdesc->begin(), _cdesc->end());
  if (JvmtiExport::should_post_dynamic_code_generated()) {
    JvmtiExport::post_dynamic_code_generated(_cdesc->name(), _cdesc->begin(), _cdesc->end());
  }
}
```

### 0c. `stubCodeGenerator.hpp` — StubCodeDesc 类

**文件**: `src/hotspot/share/runtime/stubCodeGenerator.hpp`

```cpp
// ═══ lines 39-92 — StubCodeDesc ═══
class StubCodeDesc: public CHeapObj<mtCode> {
  static StubCodeDesc* _list;     // 全局链表头
  static bool          _frozen;   // 是否冻结

  StubCodeDesc* _next;            // 下一个节点
  const char*   _group;           // 分组名（如 "StubRoutines"）
  const char*   _name;            // stub 名称（如 "call_stub"）
  address       _begin;           // 起始地址（含）
  address       _end;             // 结束地址（不含）

  StubCodeDesc(const char* group, const char* name, address begin, address end = NULL) {
    assert(!_frozen, "no modifications allowed");
    _next  = _list;
    _group = group;
    _name  = name;
    _begin = begin;
    _end   = end;
    _list  = this;                  // 头插法——新节点成为链表头
  }

  static StubCodeDesc* desc_for(address pc);  // 遍历链表查包含 pc 的节点
  static const char* name_for(address pc);     // 返回名称——调试用
};
```

### 0d. `stubRoutines_x86.hpp` — code_size1

**文件**: `src/hotspot/cpu/x86/stubRoutines_x86.hpp`

```cpp
// ═══ lines 34-37 ═══
code_size1 = 20000 LP64_ONLY(+10000)    // = 30000 on x86_64
code_size2 = 20000 LP64_ONLY(+13000)    // = 33000 on x86_64
```

## 6. 总结

| 知识点 | 解释 |
|--------|------|
| StubGenerator | `StubCodeGenerator` 的子类——拥有 20+ 个 `generate_xxx()` 方法。构造时根据 `all` 参数分叉 |
| generate_initial() | `all=false` 时调用——生成 17+ 个核心桩，每个桩 2-217 条 x86 指令 |
| generate_all() | `all=true` 时调用（ch20）——先跑 initial 再跑完整集合 |
| StubCodeMark | RAII 守卫——构造时建 `StubCodeDesc` 节点，析构时 flush + set_end + Forte/JVMTI 注册 |
| StubCodeDesc | 全局链表节点——(group, name, begin, end) 四元组。`desc_for(pc)` 遍历查 PC 所属 stub |
| StubGenerator_generate | 2 行包装——创建 StubGenerator 栈对象，构造时生完所有桩 |
| code_size1 | 30000 字节（x86_64）——BufferBlob payload 大小。最后 assert 检查至少剩 200 字节空间 |

**generate_initial() 执行完后的状态**：

```
StubRoutines 的 17+ 个 address 字段：全部非 NULL，指向 BufferBlob payload 中各自的偏移

_code1 → BufferBlob（NonNMethod 堆）
  _code1->content_begin()  → payload 起始地址
  _call_stub_entry          = content_begin() + offset_call_stub
  _forward_exception_entry  = content_begin() + offset_forward_exception
  _atomic_xchg_entry        = content_begin() + offset_atomic_xchg
  ...（17+ 个偏移）

StubCodeDesc 全局链表：
  _list → desc_call_stub → desc_forward_exception → desc_atomic_xchg → ... → NULL
  每个节点记录 (group, name, begin, end)
```

---

**接下来**：最后一篇文章（`06-initialize1-full.md`）把前面 5 篇文章的所有知识串起来，逐行拆解 `initialize1()` 的 13 行代码，展示从 NULL 表到完整函数指针表的全过程。
