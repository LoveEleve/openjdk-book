# 前置概念：从 __ push(rbp) 到 *_end = 0x55 —— 机器码写入的四层抽象

> **本文定位**：背景知识文章。你要理解的是 `initialize1()` 中的这一行代码：
>
> ```cpp
> CodeBuffer buffer(_code1);
> ```
>
> 和这一行背后隐含的问题——怎么把一行 `push(rbp)` 变成 code cache payload 里的一个字节 `0x55`。
>
> 本文是一本电子书的章节——不限制长度。每一行源码都被拆开、每一步数据结构的操作都被展示。
>
> **前置依赖**：前文 `03-bufferblob-create.md` 已解释 `_code1` 是什么——一个 30128 字节的可执行内存块，前 128 字节是 header，后 30000 字节是可写入的 payload。本文解释怎么往 payload 里写东西。
>
> **阅读提示**：本文涉及四层抽象（CodeSection → CodeBuffer → Assembler → StubCodeGenerator），每层解决一个独立问题。每层只讲它核心解决的问题——不跨层混合。

---
## 1. 问题——裸指针不够用

### 1.1 你已经有了 payload 起始地址

如果本文不讨论任何抽象层，你能做的操作是：

```cpp
address p = _code1->content_begin();  // payload 起始地址，类型 unsigned char*
*p = 0x55;   // push rbp 的机器码
p++;
*p = 0x48;   // mov rbp, rsp 的前缀
p++;
*p = 0x89;   // mov rbp, rsp 的 modrm byte
p++;
```

这能工作——只对三条指令的话。但很快你会发现三个问题：

1. **地址追踪**：写 200 条指令，忘掉 p 的位置就找不到"写到哪里了"
2. **指令编码**：你得自己记住 `push rbp = 0x55`、`call rax = 0xff 0xd0`、`lock cmpxchg` 的编码取决于 MOD/RM byte 和 SIB byte
3. **多段管理**：编译器不止生成指令——还有常量表（浮点常量）和跳板代码（stub）。一个裸指针没法容纳三块独立区域

**HotSpot 的回答是四层抽象**：

| 层 | 类/机制 | 核心问题 |
|----|---------|---------|
| 1 | CodeSection | 地址追踪：知道写到哪了、还剩多少空间 |
| 2 | CodeBuffer | 多段管理：指令和常量、跳板分开 |
| 3 | Assembler | 指令编码：不用手翻 Intel 手册 |
| 4 | StubCodeGenerator + `__` 宏 | 写作便利：`__ push(rbp)` 一行完成 |

---

## 2. CodeSection —— 带写入位置标记的内存区间

### 2.1 完整字段

CodeSection 实际有 13 个字段（`codeBuffer.hpp:86-98`）：

```cpp
address     _start;           // 内容起始——固定不变
address     _mark;            // 用户标记——通常指向某条指令开头
address     _end;             // 当前写入位置——每次 emit 后前进
address     _limit;           // 最大允许写入位置——_end 不能超过它
relocInfo*  _locs_start;      // 重定位信息起始
relocInfo*  _locs_end;        // 重定位信息当前写入位置
relocInfo*  _locs_limit;      // 重定位信息上限
address     _locs_point;      // 最后重定位的位置
bool        _locs_own;        // 重定位信息是否自己分配
bool        _frozen;          // 一旦冻结就不能再扩展
bool        _scratch_emit;    // 临时写入模式
char        _index;           // 我是哪个段（SECT_INSTS / SECT_STUBS / SECT_CONSTS）
CodeBuffer* _outer;           // 所属的 CodeBuffer
```

这 13 个字段分两组：

| 组 | 字段 | 做什么 | stub 用吗 |
|----|------|--------|----------|
| 写入控制 | `_start _end _limit _mark _frozen _outer _index _scratch_emit` | 管理"写到哪了、还能写多少" | 全用 |
| 重定位追踪 | `_locs_start _locs_end _locs_limit _locs_point _locs_own` | 记录指令中哪些字节是 oop 引用——GC 移动对象后要更新 | **不用**（stub 不引用 oop） |

对于本文要讲的 stub 写入场景，重定位追踪组的字段值全为零——stub 不需要。写入控制组才是主角。重定位追踪组的详细讲解留在后续讲 nmethod（JIT 编译的 Java 方法）的章节。

### 2.2 写入控制组的字段 —— 哪些在 emit 时用到

写入控制组 8 个字段中，每次 emit 都会碰到的实际有 6 个：

| 字段 | emit 时做什么 | 调用的方法 |
|------|-------------|----------|
| `_end` | 读当前写入位置，写完前进 | `end()` → 写入 → `set_end(_end + 1)` |
| `_limit` | 越界检查 | `set_end()` 内 `assert(allocates2(...))` |
| `_start` | 区间验证 | `allocates2()` 检查 `pc >= _start` |
| `_mark` | 指令边界标记 | `__ pc()` 前 `set_mark()`，构造时 `clear_mark()` |
| `_outer` | 访问所属 CodeBuffer | `AbstractAssembler::code()` |
| `_index` | 识别段编号 | `AbstractAssembler::sect()` |

剩下的 `_frozen` 和 `_scratch_emit` 只在边界场景用——`_frozen` 是 freeze/expand 时检查的（stub 生成不触发），`_scratch_emit` 是临时缓冲区模式标记。

但这 6 个字段中，emit 操作的**核心循环**只需要明白 3 个：

初始化时 `_end == _start`（还没写任何东西）：

```
___start = p___ → 这一刻：_end == _start == p
_limit = p + 30000
                                           _limit = p + 30000
```

### 2.3 emit_int8 —— 最简单的写入操作

```cpp
void CodeSection::emit_int8(int8_t x) {
  *((int8_t*) end()) = x;            // 步骤 1: 在 _end 位置写 1 个字节
  set_end(end() + sizeof(int8_t));   // 步骤 2: _end 前进 1 个字节
}

void CodeSection::set_end(address pc) {
  assert(allocates2(pc), "not in CodeBuffer memory");
  _end = pc;
}
```

**逐步骤拆解**：

```
emit_int8(0x55) 执行前：
  _start = p, _end = p, _limit = p + 30000
  (还没写任何东西，_end == _start)

步骤 1: *((int8_t*)_end) = 0x55
  → 内存 p[0] = 0x55

步骤 2: _end = _end + 1
  → _start = p, _end = p + 1, _limit = p + 30000
  (已写 1 字节，_end 前进了一步)

再调一次 emit_int8(0x48)：
  → 内存 p[1] = 0x48
  → _start = p, _end = p + 2, _limit = p + 30000
```

`set_end` 做越界检查：`allocates2(pc)` 检查 `pc >= _start && pc <= _limit`。如果 `_end` 超过 `_limit`，assert 失败、JVM 直接终止——没有静默越界写入的可能性。

### 2.4 CodeSection 提供了什么

对比直接操作裸指针：

| | 裸指针 | CodeSection |
|---|---|---|
| 当前位置 | `p` 变量，丢失后无法恢复 | `_end` 永远记录 |
| 剩余空间 | 需要额外变量追踪 | `remaining()` = `_limit - _end` |
| 越界检查 | 无 | `set_end` 的 assert——越界就崩溃 |
| 已写大小 | 需要额外变量 | `size()` = `_end - _start` |

CodeSection 解决的问题是：**你在写机器码的过程中，不需要同时管理"写到哪了"这个状态。`_end`替你记着。**

---

## 3. CodeBuffer —— 不只一段代码

### 3.1 为什么需要三段

CodeSection 解决了"往哪写"——但你只有一个 CodeSection，只能管一段连续空间。代码生成不止有纯指令，编译后的 Java 方法还需要：
- **常量表**：浮点常量、跳转表地址——不是可执行代码但必须离指令近（rip 相对寻址范围 2GB）
- **stub 跳板**：编译代码调用 VM 运行时 C++ 函数时需要 trampoline 处理 ABI 差异

CodeBuffer 把 BufferBlob 的 payload 切成三个独立的 CodeSection：

```cpp
CodeSection _consts;  // 常量段
CodeSection _insts;   // 指令段（主要的）
CodeSection _stubs;   // stub 段（trampoline 等）
```

（注意：CodeBuffer 的 `_stubs` 和 StubRoutines 的 stub 是完全不同的概念。`call_stub`、`forward_exception` 等 StubRoutines 桩是手写汇编，写在 **`_insts` 段**里。`_stubs` 段存放的是 JIT 编译器生成的 trampoline——编译代码要调 `SharedRuntime::throw_StackOverflowError()` 这种 C++ 运行时函数时，不能直接 call（C ABI 和 Java 帧寄存器约定不同），需要在中间插一段小跳板做寄存器翻译。）

### 3.2 三段如何划分——初始化时全给 _insts

`initialize1()` 中这行代码：

```cpp
CodeBuffer buffer(_code1);
```

走 `CodeBuffer(CodeBlob*)` 构造函数（`codeBuffer.cpp:87-91`）：

```cpp
CodeBuffer::CodeBuffer(CodeBlob* blob) {
  initialize_misc("static buffer");           // 初始化控制字段
  initialize(blob->content_begin(), blob->content_size());  // 建立三段
  verify_section_allocation();                // 验证三段不重叠
}
```

**第一步：`initialize_misc("static buffer")`**（`codeBuffer.hpp:395`）

```cpp
void initialize_misc(const char * name) {
  _name            = name;          // "static buffer"
  _before_expand   = NULL;          // 还没 expand 过
  _blob            = NULL;          // 还没关联 BufferBlob（后面 initialize() 会设置）
  _oop_recorder    = NULL;          // stub 不需要重定位
  _decode_begin    = NULL;          // 反汇编起点暂为空
  _overflow_arena  = NULL;          // 溢出区暂为空
  _code_strings    = CodeStrings(); // 空注释表
  _last_insn       = NULL;          // 最后一条指令标记
}
```

全是 NULL 初始值——就是给 CodeBuffer 的控制字段清零。

**第二步：`initialize(blob->content_begin(), blob->content_size())`**——三段划分

```cpp
void initialize(address code_start, csize_t code_size) {
  _consts.initialize_outer(this, SECT_CONSTS); // 记所属 CodeBuffer + 段编号
  _insts.initialize_outer(this,  SECT_INSTS);
  _stubs.initialize_outer(this,  SECT_STUBS);
  _total_start = code_start;
  _total_size  = code_size;
  _insts.initialize(code_start, code_size);    // ★ 整个 payload 全给 _insts
}
```

`initialize_outer`（`codeBuffer.hpp:118-121`）做的事很简单：

```cpp
void CodeSection::initialize_outer(CodeBuffer* outer, int index) {
  _outer = outer;   // 让我知道"我属于哪个 CodeBuffer"——后续 expand 时需要找到它
  _index = index;   // 让我知道"我是哪个段"——SECT_CONSTS=0, SECT_INSTS=1, SECT_STUBS=2
}
```

每个 CodeSection 需要两个信息：
- `_outer`：指向所属的 CodeBuffer。Assembler 通过 `code_section()->outer()` 就能找到 CodeBuffer
- `_index`：标记自己的段编号。后续 `code_section(n)` 靠编号取到对应的段

**CodeBuffer 和 CodeSection 对象自己在哪？就在 `initialize1()` 的栈帧里，和普通局部变量一样。**

`CodeBuffer buffer(_code1)` 和 `int x = 5` 是一个道理——都是 C++ 局部变量声明。编译器自动在栈上为 `buffer` 留好空间（不需要 `new`，不需要 `malloc`），函数结束时自动析构。三个 CodeSection（`_consts`、`_insts`、`_stubs`）是 CodeBuffer 的直接成员字段（不是指针），跟着嵌在 `buffer` 的栈内存里。它们都是"管家"——不占 payload 内存，只存指针指向 payload：

```
C 栈（普通内存）                              CodeCache（可执行内存，mmap）
────────────────────────────────             ───────────────────────────────
buffer（CodeBuffer 栈对象）                   BufferBlob payload（30000B）
  _total_start ──────────────────────────→   start+128
  _total_size = 30000
  _consts（CodeSection 栈对象）               _consts._start = NULL（未分配）
    _start = NULL, _end = NULL, _limit = NULL
  _insts（CodeSection 栈对象）                payload 内存
    _start ──────────────────────────────→   start+128
    _end  ──────────────────────────────→   start+128（还没写）
    _limit ─────────────────────────────→   start+128+30000
  _stubs（CodeSection 栈对象）                _stubs._start = NULL（未分配）
    _start = NULL, _end = NULL, _limit = NULL
```

每次 `emit_int8(0x55)`：往 `_end` 指向的 payload 位置写一个字节（写进 CodeCache 可执行内存），然后把栈上 `_insts._end` 加 1——管家记下"写到这里了"。

> **关键区分**：CodeBuffer 和 CodeSection 是"笔"——只管写。BufferBlob 是"纸"——存写下来的内容。`initialize1()` 返回后，笔（栈上的 CodeBuffer/CodeSection）析构了，但纸（BufferBlob payload 里的 x86 机器码）完好无损地留在 CodeCache 可执行内存里，由 `StubRoutines::_code1` 静态字段持有。后续 JVM 运行时直接通过 `_call_stub_entry` 等地址跳到这些机器码执行——完全不需要 CodeBuffer。

三段划分的策略不是"预先均分"——而是**一开始全给 `_insts`，`_consts` 和 `_stubs` 从 `_insts` 咬**：

```
初始化后：
  _total_start = payload 起始地址
  _total_size  = 30000

  _insts._start = payload 起始, _insts._limit = payload 起始 + 30000
  _consts._start = NULL    ← 未分配
  _stubs._start  = NULL    ← 未分配
```

为什么这样？因为 stub 生成只需要指令段——没有常量、没有跳板。把 30000 字节全给 `_insts` 是最直接的。如果将来 JIT 编译 Java 方法时需要常量段和跳板段，`initialize_section_size` 会让 `_consts` 从 `_insts` 开头咬走一段、`_insts._start` 自动往后挪——但这发生在 JIT 编译阶段，不在本文的 stub 生成范围。

**第三步：`verify_section_allocation()`**——验证三段不重叠、不越界。对于 stub 生成场景（`_consts` 和 `_stubs` 都未分配），这个校验基本没做什么。

### 3.3 三段扩张机制（本文略过）

如果需要常量段或 stub 段，CodeBuffer 从 `_insts` 开头切空间：
3. 如果 payload 总空间不够，`expand` 分配更大的 BufferBlob，把现有内容拷贝过去

`initialize1()` 的 stub 生成不触发扩张——30000 字节对核心桩来说绰绰有余。

---

## 4. Assembler —— 不查 Intel 手册

### 4.1 问题：怎么把指令编码成字节

CodeSection 和 CodeBuffer 解决了"写在哪里"——但你还需要知道**写什么**。你得算出 `push rbp = 0x55`——因为 x86 的 `PUSH r64` 指令编码为 `0x50 + r`（r 的低 3 位），rbp 编码为 5，`0x50 | 5 = 0x55`。

换成 `call rax`？`0xff 0xd0`。换成 `mov [rsp+0x20], rbx`？编码取决于是否使用 SIB byte。换成 `lock cmpxchg [rsi], rdx`？前缀 + 操作码 + MOD/RM + SIB——可能 4-5 个字节。

**Assembler 解决这个问题**：你知道 x86 指令的名字（`push rbp`），Assembler 负责算出对应的机器码编码。

### 4.2 AbstractAssembler —— 绑定到 CodeBuffer._insts

`AbstractAssembler` 是 Assembler 的基类。构造函数绑定到 CodeBuffer 的 insts 段：

```cpp
// assembler.cpp:42-52
AbstractAssembler::AbstractAssembler(CodeBuffer* code) {
  CodeSection* cs = code->insts();   // 拿到 CodeBuffer 的 _insts 段
  _code_section = cs;                // 绑定——之后所有 emit 操作都写到这里
}
```

之后 `AbstractAssembler` 提供 emit 的代理方法：

```cpp
void emit_int8(int8_t x) { code_section()->emit_int8(x); }
```

`code_section()` 返回构造函数中绑定的 `_code_section`。当你调用 `Assembler::push(rbp)` 时，最终 emit 的字节落到了 CodeBuffer._insts 里。

### 4.3 push(Register) —— 一条指令的编码过程

```cpp
// assembler_x86.cpp:4443-4447
void Assembler::push(Register src) {
  int encode = prefix_and_encode(src->encoding());
  emit_int8(0x50 | encode);
}
```

**第一步：prefix_and_encode(5)**

```cpp
int Assembler::prefix_and_encode(int reg_enc, bool byteinst) {
  if (reg_enc >= 8) {
    prefix(REX_B);    // 寄存器 r8-r15 需要 REX prefix
    reg_enc -= 8;
  }
  return reg_enc;
}
```

`rbp` 的编码是 5。`5 < 8`，不需要 REX prefix，直接返回 5。

如果寄存器是 `r12`（编码 12）：`12 >= 8`，先输出 REX_B 前缀字节 `0x41`，再返回 `12 - 8 = 4`。最终机器码 = `0x41 0x54`。

**第二步：emit_int8(0x50 | 5)**

`0x50 | 5 = 0x55`。调用 `AbstractAssembler::emit_int8(0x55)`——转发给绑定的 CodeSection。最终 CodeSection 做 `*_end = 0x55; _end++`。

### 4.4 完整链路：push(rbp) → 0x55

```
Assembler::push(rbp)
  prefix_and_encode(5)
    5 < 8 → 不需要 REX → 返回 5
  emit_int8(0x50 | 5)           // 0x55
    → AbstractAssembler::emit_int8(0x55)   // assembler.hpp:281
      → CodeSection::emit_int8(0x55)       // codeBuffer.hpp:203
        → *((int8_t*)_end) = 0x55          // 字节写入 payload
        → _end++                            // 指针前进
```

**执行前后状态**：

```
执行前: _end = payload + offset
执行后: payload[offset] = 0x55
        _end = payload + offset + 1
```

---

## 5. StubCodeGenerator + __ 宏 —— 一行写作

### 5.1 StubCodeGenerator —— 持有汇编器

`StubCodeGenerator` 是一个很小的类（`stubCodeGenerator.hpp:97`），它只做一件事：**持有一个 `MacroAssembler*`，命名为 `_masm`**。

```cpp
class StubCodeGenerator : public StackObj {
 protected:
  MacroAssembler* _masm;   // ← 这就是之后写 stub 代码要用的那个指针
 public:
  StubCodeGenerator(CodeBuffer* code) {
    _masm = new MacroAssembler(code);  // 构造时创建 MacroAssembler，传入 CodeBuffer
  }
};
```

`MacroAssembler(code)` 内部走 `Assembler(code)` → `AbstractAssembler(code)`（第 4.2 节讲过的绑定链路），最终 `_masm` 的 `_code_section` 指向 `code->_insts`。之后所有 `_masm->xxx()` 调用，字节都写进 CodeBuffer 的 insts 段。

### 5.2 但每次写 `_masm->` 太冗长

```cpp
// 太冗长:
_masm->push(rbp);
_masm->movq(Address(rbp, -40), rdi);
_masm->call(rcx);

// 期望:
__ push(rbp);
__ movptr(call_wrapper, c_rarg0);
__ call(c_rarg1);
```

### 5.3 MacroAssembler vs Assembler

`Assembler` 提供底层指令编码（`push`、`call`、`ret`、`mov` 等）。
`MacroAssembler` 继承 Assembler，增加了复合指令（`enter`、`leave`、`align`、`call_VM` 等）。

例如 `__ enter()` 展开为（由 MacroAssembler 提供）：

```asm
push rbp
mov  rbp, rsp
```

而 `__ push(rbp)` 走 Assembler 的底层 `push(Register)`。`__` 宏可以访问两个层级的方法，因为 MacroAssembler 继承自 Assembler。

### 5.4 __ 宏的定义

```cpp
// stubGenerator_x86_64.cpp:54-56
#define __ _masm->
#define a__ ((Assembler*)_masm)->
```

效果：

```cpp
__ push(rbp);        // 展开为: _masm->push(rbp)
__ movptr(Address(rbp, -40), rdi);
__ call(c_rarg1);
```

`a__` 用于强制调用 Assembler（非 MacroAssembler）版本的方法——当两个层级有同名方法时用 `a__` 指定下层版本。

### 5.5 完整写入链路

```
initialize1() 中:
  StubCodeGenerator(&buffer)          // 构造
    _masm = new MacroAssembler(&buffer)
      → _code_section = &buffer._insts
    __ push(rbp);
      → _masm->push(rbp)
        → Assembler::push(rbp)
          → emit_int8(0x55)
            → CodeSection::emit_int8(0x55)
              → *_end = 0x55
              → _end++
```

> `generate_initial()` 怎么组织多个 stub——那是下一篇文章（05-stubgenerator.md）的主题。

---

## 0. 完整源码清单

### 0a. `codeBuffer.hpp` — CodeSection 类（三指针模型）

**文件**: `src/hotspot/share/asm/codeBuffer.hpp`

```cpp
// ═══ lines 80-245 — CodeSection 完整类 ═══
class CodeSection {
  address     _start;           // first byte of contents (instructions)
  address     _mark;            // user mark, usually an instruction beginning
  address     _end;             // current end address
  address     _limit;           // last possible (allocated) end address

 public:
  address     start() const         { return _start; }
  address     end() const           { return _end; }
  address     limit() const         { return _limit; }
  csize_t     size() const          { return (csize_t)(_end - _start); }
  csize_t     remaining() const     { return (csize_t)(_limit - _end); }

  void        set_end(address pc)   { _end = pc; }

  // ═══ line 203 — 核心写入 ═══
  void emit_int8(int8_t x)  { *((int8_t*)end()) = x; set_end(end() + sizeof(int8_t)); }

  void initialize(address start, csize_t size = 0) {
    _start = start;
    _mark  = NULL;
    _end   = start;
    _limit = start + size;
  }
};
```

### 0b. `codeBuffer.hpp` — CodeBuffer 类（三个 CodeSection）

**文件**: `src/hotspot/share/asm/codeBuffer.hpp`

```cpp
// ═══ lines 340-530 — CodeBuffer 核心 ═══
class CodeBuffer: public StackObj {
  enum {
    SECT_CONSTS = SECT_FIRST,
    SECT_INSTS,
    SECT_STUBS,
    SECT_LIMIT
  };

  CodeSection  _consts;             // constants, jump tables
  CodeSection  _insts;              // instructions (the main section)
  CodeSection  _stubs;              // stubs (call site support), deopt, exception handling

  address      _total_start;        // alias for insts.start()
  csize_t      _total_size;         // alias for insts.capacity()

 public:
  CodeSection* insts()  { return &_insts;  }
  CodeSection* stubs()  { return &_stubs;  }
  CodeSection* consts() { return &_consts; }

  csize_t insts_remaining() const { return _insts.remaining(); }

  // ═══ line 411 — initialize ═══
  void initialize(address code_start, csize_t code_size) {
    _consts.initialize_outer(this, SECT_CONSTS);
    _insts.initialize_outer(this,  SECT_INSTS);
    _stubs.initialize_outer(this,  SECT_STUBS);
    _total_start = code_start;
    _total_size  = code_size;
    _insts.initialize(code_start, code_size);
  }
};
```

### 0c. `codeBuffer.cpp` — CodeBuffer(CodeBlob*) 构造函数

**文件**: `src/hotspot/share/asm/codeBuffer.cpp`

```cpp
// ═══ lines 87-91 ═══
CodeBuffer::CodeBuffer(CodeBlob* blob) {
  initialize_misc("static buffer");
  initialize(blob->content_begin(), blob->content_size());
  verify_section_allocation();
}
```

### 0d. `assembler.hpp` — AbstractAssembler 类

**文件**: `src/hotspot/share/asm/assembler.hpp`

```cpp
// ═══ lines 205-316 — AbstractAssembler 核心 ═══
class AbstractAssembler : public ResourceObj {
 protected:
  CodeSection* _code_section;          // section within the code buffer
  OopRecorder* _oop_recorder;

 public:
  // ═══ lines 281-284 — emit 代理 ═══
  void emit_int8( int8_t  x) { code_section()->emit_int8(x); }
  void emit_int16(int16_t x) { code_section()->emit_int16(x); }
  void emit_int32(int32_t x) { code_section()->emit_int32(x); }
  void emit_int64(int64_t x) { code_section()->emit_int64(x); }

  CodeSection* code_section() const { return _code_section; }
  address pc() const { return code_section()->end(); }
};
```

### 0e. `assembler_x86.cpp` — Assembler::push(Register) 实现

**文件**: `src/hotspot/cpu/x86/assembler_x86.cpp`

```cpp
// ═══ lines 4443-4447 ═══
void Assembler::push(Register src) {
  int encode = prefix_and_encode(src->encoding());
  emit_int8(0x50 | encode);
}

// ═══ lines 8280-8288 ═══
int Assembler::prefix_and_encode(int reg_enc, bool byteinst) {
  if (reg_enc >= 8) {
    prefix(REX_B);
    reg_enc -= 8;
  } else if (byteinst && reg_enc >= 4) {
    prefix(REX);
  }
  return reg_enc;
}
```

### 0f. `macroAssembler_x86.hpp` — MacroAssembler 构造

**文件**: `src/hotspot/cpu/x86/macroAssembler_x86.hpp`

```cpp
// ═══ line 79 ═══
MacroAssembler(CodeBuffer* code) : Assembler(code) {}
```

### 0g. `stubCodeGenerator.cpp` — StubCodeGenerator 构造

**文件**: `src/hotspot/share/runtime/stubCodeGenerator.cpp`

```cpp
// ═══ lines 68-71 ═══
StubCodeGenerator::StubCodeGenerator(CodeBuffer* code, bool print_code) {
  _masm = new MacroAssembler(code);
  _print_code = PrintStubCode || print_code;
}
```

### 0h. `stubGenerator_x86_64.cpp` — __ 宏定义

**文件**: `src/hotspot/cpu/x86/stubGenerator_x86_64.cpp`

```cpp
// ═══ lines 54-56 ═══
#define __ _masm->
#define a__ ((Assembler*)_masm)->
```


---

## 6. 总结——四层一起看

把四层放在同一块物理内存上：

```
BufferBlob payload (30000 bytes, 从 start+128 开始)
|
+-- CodeSection _insts       —— 第 1 层：三指针追踪写入位置
|   _start = payload起始
|   _end   = _start         （初始化时还没写）
|   _limit = _start + 30000
|       |
|       +-- CodeBuffer      —— 第 2 层：三段管理（本文场景只有 _insts）
|       |   CodeBuffer(_code1) → _insts.initialize(payload_begin, 30000)
|       |       |
|       |       +-- Assembler       —— 第 3 层：指令编码
|       |       |   push(rbp) → 0x50|5 → 0x55
|       |       |   emit_int8(0x55) → CodeSection::emit_int8
|       |       |
|       |       +-- StubCodeGenerator + __ 宏 —— 第 4 层：写作便利
|       |           StubCodeGenerator(&buffer)
|       |             _masm = new MacroAssembler(&buffer)
|       |             #define __ _masm->
|       |             __ push(rbp) → 一行完成
```

**每层的问题和答案**：

| 层 | 解决的问题 | 答案 |
|----|-----------|------|
| CodeSection | 写到哪了？ | `_end` 记着。`emit_int8` 写入 + 前进 |
| CodeBuffer | 写到哪一段？ | `_insts`、`_stubs`、`_consts` 三段独立 |
| Assembler | 写什么编码？ | `push(rbp)` → `0x55`。不用手翻 Intel 手册 |
| StubCodeGenerator | 怎么写？ | `__ push(rbp)` 一行搞定 |

---

**接下来**：下一篇文章（`05-stubgenerator.md`）会解释 `StubGenerator_generate(&buffer, false)` 做了什么——`generate_initial()` 如何生成 17+ 个桩并把入口地址填回 `StubRoutines` 表。
