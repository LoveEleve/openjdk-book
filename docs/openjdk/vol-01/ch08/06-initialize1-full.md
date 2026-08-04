# StubRoutines::initialize1() —— 完整知识体系

> **本文定位**：正文。本文把前面 5 篇文章的所有背景知识串在一起，逐行拆解 `StubRoutines::initialize1()` 的 13 行代码——不讲它"看起来是什么"，而是基于前面建立的知识体系解释它"每一步到底做了什么、内存中发生了什么事、执行前后全局状态如何变化"。
>
> **前置依赖**：本文假定你已经读完前面 5 篇文章——知道 stub 是什么（01）、StubRoutines 是什么（02）、BufferBlob 怎么分配（03）、汇编怎么写入（04）、StubGenerator 怎么组织（05）。如果还没读，本文中的概念会显得像从天而降。

---
## 1. initialize1() 被调用的位置

在 `init_globals()`（`init.cpp`）中，JVM 初始化的全局函数按顺序调用各个子系统的初始化。`stubRoutines_init1()` 排在较前的位置——在 CodeCache 初始化完成之后，在解释器启动之前：

```
init_globals()
  │
  ├── ... codecache_init() → CodeCache::initialize()  // 建立三个堆
  │
  ├── stubRoutines_init1()          // ← 本文的主角。生成 call_stub 等核心桩
  │     └── StubRoutines::initialize1()
  │
  ├── ... interpreter_init()        // 解释器启动——call_stub 已可用
  │
  └── ... call_initPhase1() → JavaCalls::call_static() → needs call_stub（此时必须可用）
```

**为什么 call_stub 必须在这时候可用？**

JVM 启动时要调用 `call_initPhase1()`——它内部通过 `JavaCalls::call_static()` 调用 Java 方法，而 `JavaCalls::call_static()` 需要 call_stub 作为 C → Java 的桥接入口。如果此时 `_call_stub_entry` 还是 NULL，JVM 物理崩溃——`call_stub()` 会返回一个 `CallStub` 函数指针值为 NULL，CPU 跳进虚空。

---

## 2. 逐行拆解

### 第 1 行：`if (_code1 == NULL)`

```
此前的全局状态:
  _code1 == NULL
  所有 _xxx_entry == NULL
```

这是幂等保护。`_code1` 在定义时初始化为 NULL（`stubRoutines.cpp:47`）。`initialize1()` 只执行一次——如果 `_code1` 不是 NULL（第二次调用），直接跳过。这是常见的"init guard"模式。

### 第 2 行：`ResourceMark rm`

`ResourceMark` 是 HotSpot 的线程本地资源管理机制。

HotSpot 中有一个 `ResourceArea`——每个线程都有一块预留内存，用于临时分配"生命周期限于当前函数的对象"。`ResourceMark` 是一个 RAII 标记——构造时记录当前分配位置，析构时回退到该位置（释放这期间分配的所有临时对象）。

**为什么 initialize1 需要 ResourceMark？**

`StubGenerator` 的 `generate_initial()` 在生成本地符号（`Label`、`Address` 等）时会分配一些临时对象。这些对象存在 `ResourceArea` 中。`ResourceMark` 保证 cleanup——构造后释放——不会累积。

### 第 3 行：`TraceTime timer(...)`

这行纯粹是启动计时——用 `-Xlog:startuptime` 可以看到 "StubRoutines generation 1: XXms" 的日志输出。对理解 initialize1 的实质不重要。

### 第 4 行：`_code1 = BufferBlob::create("StubRoutines (1)", code_size1)`

这是 initialize1 的核心操作之一。逐步骤发生了什么：

**步骤 1**：`code_size1 = 30000`（x86_64，从 `stubRoutines_x86.hpp:35` 读取）

**步骤 2**：`BufferBlob::create` 计算分配大小（`03-bufferblob-create.md` 详细拆解）：
```
unsigned int size = sizeof(BufferBlob);           // ≈ 104
size = CodeBlob::align_code_offset(size);         // → 128（对齐到 32 字节）
size += align_up(30000, oopSize);                 // → 128 + 30000 = 30128
```

**步骤 3**：锁住 `CodeCache_lock`，调用 `new (size) BufferBlob("StubRoutines (1)", size)`：
- placement new → `BufferBlob::operator new(size_t, unsigned)` → `CodeCache::allocate(30128, NonNMethod)`
- 从 NonNMethod 堆分配 30128 字节可执行内存
- 原地构造 BufferBlob 对象（`this` 就是分配地址）

构造链路：
```
BufferBlob("StubRoutines (1)", 30128)
  → RuntimeBlob(name, 104, 30128, frame_never_safe, 0)
    → CodeBlobLayout((address)this, 30128, 104, 0, 30128)
      算出:
        _code_begin = this + 128
        _code_end   = this + 30128
        _content_begin = this + 128
        _content_end   = this + 30128
    → CodeBlob(name, compiler_none, layout, -1, 0, NULL, false)
      存储坐标到 this 的成员字段
```

**执行后的状态**：

```
StubRoutines::_code1 = 某个地址（设为 P）

内存布局（从 P 开始）：
  [0, 128):   BufferBlob 的 C++ 字段（_name, _size, _header_size, _code_begin, ...）
  [128, 30128): 30000 字节的空白可执行 payload

P + 128 = _code1->content_begin()  ← payload 起始地址，待填充 x86 机器码
P + 30128 = _code1->content_end()  ← payload 终点

其他 StubRoutines 字段：
  _code2 == NULL
  所有 _xxx_entry == NULL（还没填）
```

### 第 5-7 行：OOM 检查

```cpp
if (_code1 == NULL) {
  vm_exit_out_of_memory(code_size1, OOM_MALLOC_ERROR, "CodeCache: no room for StubRoutines (1)");
}
```

如果 CodeCache 的 NonNMethod 堆没有 30128 字节空闲空间（且扩展失败），`BufferBlob::create` 返回 NULL。JVM 此时无法继续——没有 call_stub 就无法执行 Java 代码——所以直接 `vm_exit_out_of_memory` 报错退出。

注意：即使这个检查通过了，也不能保证 `BufferBlob::create` 返回了一个有效的 BufferBlob——但 placement new 保证返回有效的 `BufferBlob*`（placement new 不抛异常——它只是调用构造函数，真正的内存分配已在 CodeCache::allocate 中完成）。所以这里的 NULL 检查是针对 CodeCache 分配失败的场景，而不是 C++ 构造失败。

### 第 8 行：`CodeBuffer buffer(_code1)`

这行把 `_code1` 的 payload 包装成可写入的 CodeBuffer（`04-code-writing-chain.md` 第 4.2 节）：

```cpp
CodeBuffer::CodeBuffer(CodeBlob* blob) {
  initialize_misc("static buffer");
  initialize(blob->content_begin(), blob->content_size());
  verify_section_allocation();
}
```

`blob->content_begin()` = `P + 128`（payload 起始地址）。`blob->content_size()` = 30000（payload 大小）。

`initialize(P + 128, 30000)` 中：

```cpp
_insts.initialize(P + 128, 30000);
```

**执行后的状态**：

```
CodeBuffer buffer（栈上局部变量）:
  _total_start = P + 128
  _total_size  = 30000
  _insts._start = P + 128
  _insts._end   = P + 128     ← 初始时 _end == _start（还没写任何指令）
  _insts._limit = P + 128 + 30000 = P + 30128
  _consts._start = NULL       ← 未分配（stub 不需要常量段）
  _stubs._start  = NULL       ← 未分配（stub 不需要跳板段）
```

关键：`_insts._end == _insts._start`——还没往 payload 里写任何字节。

### 第 9 行：`StubGenerator_generate(&buffer, false)`

这行是 initialize1 的核心。逐步骤发生了什么（`05-stubgenerator.md` 详细拆解）：

```cpp
void StubGenerator_generate(CodeBuffer* code, bool all) {
  StubGenerator g(code, all);
}
```

**`StubGenerator g(code, false)`**——构造时：

1. `StubCodeGenerator(code)` 先执行：`_masm = new MacroAssembler(code)`，`MacroAssembler(code)` 内部 `Assembler(code)` 中 `AbstractAssembler(code)` 绑定 `_code_section = code->insts()`

2. `generate_initial()` 执行——17+ 轮"StubCodeMark → 手写 x86 汇编 → 赋值"循环：

```
第一轮: generate_forward_exception()
  StubCodeMark("StubRoutines", "forward_exception")
  __ enter(); ...（~50 条 x86 指令）
  StubRoutines::_forward_exception_entry = start
  ~StubCodeMark: flush + set_end + Forte/JVMTI注册

第二轮: generate_call_stub(&_call_stub_return_address)
  StubCodeMark("StubRoutines", "call_stub")
  __ enter(); __ subptr(rsp, 96); ...（~217 条 x86 指令）
  __ call(c_rarg1);
  return_address = __ pc();  // ♻ 记录 _call_stub_return_address
  StubRoutines::_call_stub_entry = start
  ~StubCodeMark: flush + set_end + Forte/JVMTI注册

第三至十七轮: generate_catch_exception(), generate_atomic_xchg(), ...
  每轮生成一段机器码，把入口地址赋给对应的 StubRoutines::_xxx_entry
```

**执行后 CodeBuffer._insts 的状态**：

```
_insts._start = P + 128
_insts._end   = P + 128 + written_bytes  ← 已写入了 ~2000+ 字节的 x86 机器码
_insts._limit = P + 30128

_insts.remaining() = _limit - _end ≈ 28000 字节
```

**执行后 StubRoutines 的状态**：

```
_code1 = P（BufferBlob in NonNMethod heap）

_code1->content_begin()          = P + 128  ← payload 起始地址

_call_stub_return_address        = P + 128 + return_addr_offset  ← call 后的下一条指令
_call_stub_entry                 = P + 128 + call_stub_offset     ← call_stub 第一条指令
_forward_exception_entry         = P + 128 + forward_exc_offset   ← forward_exception 第一条
_catch_exception_entry           = P + 128 + catch_exc_offset     ← catch_exception 第一条
_atomic_xchg_entry               = P + 128 + atomic_xchg_offset
_atomic_xchg_long_entry          = P + 128 + atomic_xchg_long_offset
_atomic_cmpxchg_entry            = P + 128 + atomic_cmpxchg_offset
_atomic_cmpxchg_byte_entry       = P + 128 + atomic_cmpxchg_byte_offset
_atomic_cmpxchg_long_entry       = P + 128 + atomic_cmpxchg_long_offset
_atomic_add_entry                = P + 128 + atomic_add_offset
_atomic_add_long_entry           = P + 128 + atomic_add_long_offset
_fence_entry                     = P + 128 + fence_offset
_throw_StackOverflowError_entry  = P + 128 + throw_soe_offset
_throw_delayed_StackOverflowError_entry = P + 128 + throw_delayed_offset
// ... CRC/math 条件生成为 NULL 或指向对应偏移

StubCodeDesc 全局链表（调试元数据）:
  _list → desc_call_stub(StubRoutines, call_stub, begin, end)
        → desc_forward_exception(StubRoutines, forward_exception, begin, end)
        → ...
        → NULL
  每个节点通过 begin/end 描述对应桩在 payload 中的坐标
```

### 第 10 行：`assert(code_size1 == 0 || buffer.insts_remaining() > 200, "increase code_size1")`

最后一条防线——验证 30000 字节够大。

`buffer.insts_remaining()` = `_insts._limit - _insts._end`。17+ 个桩的 x86 机器码总量大约 2000-3000 字节（call_stub 最大约 1200 字节，其他每个 < 200 字节）。30000 字节的余量超过 200 字节绰绰有余。

如果添加了新桩导致剩余空间 < 200 字节，assert 失败，JVM 在开发阶段直接终止——提示开发者增加 `code_size1` 的值并重新编译。

注意：`code_size1 == 0` 的分支是为了支持"无桩模式"（某些零配置场景），不常见。

---

## 3. 完整案例——initialize1 前后的全局状态

### 执行前（JVM 刚初始化完 CodeCache）

```
StubRoutines 状态:
  _code1:                      NULL
  _code2:                      NULL
  _call_stub_return_address:   NULL
  _call_stub_entry:            NULL
  _forward_exception_entry:    NULL
  _atomic_xchg_entry:          NULL
  ...（所有 address 字段全 NULL）

CodeCache NonNMethod 堆: 初始化完成，空闲空间 > 30128 字节

buffer._insts: 不存在（CodeBuffer 还没构造）

StubCodeDesc._list: 空（还没有任何 stub 被创建）
```

### 执行中——Line 4 执行后（BufferBlob 已分配）

```
StubRoutines._code1 = P

Memory at P:
  [0, 128):    C++ header（_name="StubRoutines (1)", _size=30128, ...）
  [128, 30128): 30000 字节空白的可执行内存（全是 0x00 或垃圾值）

P + 128 = code_begin = content_begin
P + 30128 = code_end = content_end

其他 StubRoutines 字段: 全 NULL
```

### 执行中——Line 8 执行后（CodeBuffer 已包装）

```
buffer（栈上）:
  _total_start = P + 128
  _total_size  = 30000
  _insts._start = P + 128
  _insts._end   = P + 128    ← 还没写东西
  _insts._limit = P + 30128
  _insts.remaining() = 30000
```

### 执行中——generate_call_stub 执行中

```
StubCodeMark mark("StubRoutines", "call_stub")
  → StubCodeDesc._list 指向新节点 (begin=P+128+call_stub_offset, end=NULL)

__ enter()           → push(rbp) → 0x55, mov(rsp, rbp) → 0x48 0x89 0xE5
  P + 128 + call_stub_offset + 0:  0x55
  P + 128 + call_stub_offset + 1:  0x48
  P + 128 + call_stub_offset + 2:  0x89
  P + 128 + call_stub_offset + 3:  0xE5

__ subptr(rsp, -rsp_after_call_off * wordSize)
  → 编码为 sub rsp, 96: 0x48 0x83 0xEC 0x60
  P + 128 + call_stub_offset + 4:  0x48
  P + 128 + call_stub_offset + 5:  0x83
  P + 128 + call_stub_offset + 6:  0xEC
  P + 128 + call_stub_offset + 7:  0x60

...（217 条指令逐条写入）

__ call(c_rarg1)      → 编码为 call rcx: 0xFF 0xD1
  P + ...: 0xFF 0xD1     ← call 指令
  P + ...: 下一条指令地址 → ♻ 这是 _call_stub_return_address

__ ret(0)             → 0xC3
  P + ...: 0xC3

~StubCodeMark:
  flush()
  set_end → desc.end = 当前 pc
  Forte/JVMTI 注册
```

### 执行后（initialize1 完全完成）

```
StubRoutines 状态:
  _code1:                      P（NonNMethod 堆中的 BufferBlob）
  _code2:                      NULL（等待 initialize2）

  _call_stub_return_address:   P + 128 + return_offset       ← 唯一值，帧判定
  _call_stub_entry:            P + 128 + call_stub_offset    ← call_stub 入口
  _forward_exception_entry:    P + 128 + forward_exc_offset
  _catch_exception_entry:      P + 128 + catch_exc_offset
  _atomic_xchg_entry:          P + 128 + atomic_xchg_offset
  ...17+ 个条目全非 NULL（条件生成的除外）

buffer（栈上）:
  _insts._end = P + 128 + total_written（~2000-3000 字节）
  _insts.remaining() ≈ 27000+ 字节  ← 证明 > 200，assert 通过

CodeCache NonNMethod 堆: 已分配 P 开始 30128 字节

StubCodeDesc._list: 17+ 个节点的链表，记录每个 stub 的 (group, name, begin, end)

后续: JVM 可以通过 StubRoutines::call_stub() 跳转进编译代码执行
```

---

## 4. initialize1 之后会发生什么

`initialize1()` 返回后，13 行代码的局部变量 `buffer` 和 `rm` 依次析构：

1. `buffer.~CodeBuffer()`——清理 CodeSection 的内部状态，但不释放 BufferBlob（BufferBlob 由 `_code1` 持有）
2. `rm.~ResourceMark()`——释放 StubGenerator 期间分配的临时资源
3. `timer.~TraceTime()`——记录耗时并打印日志

`_code1` 仍然有效——它保存在 `StubRoutines::_code1` 的 static 字段中。之后的 JVM 运行过程中：

- **解释器**：通过 `StubRoutines::call_stub()` 获取 `_call_stub_entry`，跳转执行编译后的 Java 方法
- **编译代码**：异常时通过 `StubRoutines::forward_exception_entry()` 跳回解释器
- **GC**：扫描线程栈时通过 `StubRoutines::returns_to_call_stub(pc)` 识别 entry_frame
- **JVMTI**：通过 `StubCodeDesc::desc_for(pc)` 获取 stub 名称用于栈回溯
- **运行时系统**：通过 `StubRoutines::atomic_xchg_entry()` 等执行原子操作

后续的 `initialize2()` 会生成更多桩（如 arraycopy），本文不展开。

---

## 0. 完整源码清单

### 0a. `stubRoutines.cpp` — initialize1() 函数（本文主体）

**文件**: `src/hotspot/share/runtime/stubRoutines.cpp`

```cpp
// ═══ lines 188-202 ═══
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
    assert(code_size1 == 0 || buffer.insts_remaining() > 200, "increase code_size1");
  }
}
```

### 0b. `stubRoutines.cpp` — stubRoutines_init1() 包装函数

**文件**: `src/hotspot/share/runtime/stubRoutines.cpp`

```cpp
// ═══ line 380 ═══
void stubRoutines_init1() { StubRoutines::initialize1(); }
```

### 0c. `stubRoutines_x86.hpp` — code_size1

**文件**: `src/hotspot/cpu/x86/stubRoutines_x86.hpp`

```cpp
// ═══ lines 34-37 ═══
code_size1 = 20000 LP64_ONLY(+10000)    // = 30000 on x86_64
code_size2 = 20000 LP64_ONLY(+13000)    // = 33000 on x86_64
```

### 0d. `stubRoutines.hpp` — 初始化后的 StubRoutines 字段

**文件**: `src/hotspot/share/runtime/stubRoutines.hpp`

```cpp
// ═══ lines 93-124 — 由 initialize1() 填充的核心字段 ═══
static BufferBlob* _code1;
static BufferBlob* _code2;

static address _call_stub_return_address;
static address _call_stub_entry;

static address _forward_exception_entry;
static address _catch_exception_entry;
static address _throw_StackOverflowError_entry;
static address _throw_delayed_StackOverflowError_entry;

static address _atomic_xchg_entry;
static address _atomic_xchg_long_entry;
static address _atomic_cmpxchg_entry;
static address _atomic_cmpxchg_byte_entry;
static address _atomic_cmpxchg_long_entry;
static address _atomic_add_entry;
static address _atomic_add_long_entry;
static address _fence_entry;

// ... arraycopy, math, CRC 字段（initialize2() 填充或条件生成）
```



## 5. 知识点体系（全部 5 篇背景文章 + 本文）

```
初始化前：StubRoutines 表中所有 address 字段 = NULL
  │
  ├─ 01-stub-what-is.md
  │   解释了为什么需要 stub、address 是什么、三种帧类型
  │
  ├─ 02-stubroutines-table.md
  │   解释 StubRoutines 这张表本身：字段分类、读写模式、AllStatic 模式
  │
  ├─ 03-bufferblob-create.md
  │   解释 BufferBlob::create 怎么从 CodeCache 的 NonNMethod 堆分配可执行内存
  │   CodeBlobLayout 怎么把裸内存切成 header + payload
  │
  ├─ 04-code-writing-chain.md
  │   解释怎么往 payload 里写 x86 机器码：
  │     CodeSection（三指针追踪写入位置）
  │     → Assembler（不用手翻 Intel 手册）
  │     → CodeBuffer（三段管理）
  │     → StubCodeGenerator + __ 宏（一行写作）
  │
  ├─ 05-stubgenerator.md
  │   解释 StubGenerator 怎么一次性生成 17+ 个桩
  │   每个桩的 StubCodeMark 怎么记录边界
  │   generate_initial() 怎么把所有入口地址填回 StubRoutines 表
  │
  └─ 06-initialize1-full.md（本文）
      全局预览：逐行拆解 13 行代码
      完整案例：执行前后全局状态变化
```


## 附录：initialize1 快速参考

| 行 | 代码 | 做了什么 |
|----|------|---------|
| 1 | `if (_code1 == NULL)` | 幂等保护——只初始化一次 |
| 2 | `ResourceMark rm` | 线程本地临时内存的 RAII 回收标记 |
| 3 | `TraceTime timer(...)` | 启动计时（日志用） |
| 4 | `BufferBlob::create(...)` | 从 NonNMethod 堆分配 30128 字节可执行内存，header 128 字节 + payload 30000 字节 |
| 5-7 | `if (_code1 == NULL)` | OOM 检查——CodeCache 没空间则终止 JVM |
| 8 | `CodeBuffer buffer(_code1)` | 把 payload 包装为 CodeSection，_end 指向 payload 起始 |
| 9 | `StubGenerator_generate(...)` | 创建 StubGenerator，构造时运行 generate_initial()，生成 17+ 个 x86 桩，填满 StubRoutines 表 |
| 10 | `assert(remaining() > 200)` | 验证 30000 字节够用，不够则增加 code_size1 |
