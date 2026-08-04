# 16.1 interpreter_init —— 初始化链与代码存储

> **本文定位**：沿 `init_globals()` → `interpreter_init()` → `TemplateInterpreter::initialize()` 追踪解释器初始化，回答解释器代码为什么必须在方法加载前生成，以及 `CodeCache`、`BufferBlob`、`StubQueue`、`InterpreterCodelet` 分别扮演什么角色。
>
> **前置依赖**：[15.1 LatestMethodCache](../ch13/01-latest-method-cache.md)——了解 `universe_init()` 阶段仍未加载 primordial classes。
>
> **JDK 版本**：本文基于 **OpenJDK 11u、x86-64、正常启用 Template Interpreter 的 HotSpot 构建**。

---

## 1. 先限定范围：这里是哪一种解释器

提到“解释器”，最容易想到下面这种中央循环：

```c
while (true) {
  switch (*bcp++) {
    case _iconst_0: /* 将 0 压入操作数栈 */ break;
    case _iload_1:  /* 读取局部变量 1 */    break;
    case _iadd:     /* 两个 int 相加 */     break;
    // ...
  }
}
```

循环每次读取一条字节码，再通过 `switch` 选择它的 C/C++ 实现。

本文讨论的 JDK 11u x86-64 HotSpot 正常构建走的是 **Template Interpreter**：JVM 启动时先为字节码和各种解释器入口生成本地机器码，运行时再跳进这些机器码片段。粗略模型是：

```text
当前 bytecode + 当前 TosState
              │
              ▼
       dispatch table entry
              │
              ▼
    generated machine-code handler
              │
              ▼
       下一个 handler / 其他控制流
```

`TosState` 表示 dispatch 边界处解释器缓存的栈顶值类别/表示方式，不是整个 Java 操作数栈的状态，也不只是当前字节码的 Java 结果类型。

这两种模型的核心区别是**调度结构**：前者围绕一个中央 C/C++ `switch`，后者执行启动期生成的 handler，并在普通、非自行 dispatch 的模板路径上以 dispatch-table/threaded-style dispatch 连接 handler。branch、return、invoke 等特殊控制流模板可能自行 dispatch，或者离开普通的“下一 handler”路径。

这里需要先加三条边界：

1. HotSpot 源码中仍保留 portable C++ interpreter 等其他配置，不能把本文结论扩大成“任何 HotSpot 都绝不使用 C++ 字节码解释器”。
2. 每个已定义 opcode 都会进入一次带该 bytecode 标识的 `CodeletMark` 生成范围，通常形成按 opcode 组织的 Codelet；但 dispatch address 与 Codelet 并非严格一一对应：多个 `TosState` 可以共享地址，非法状态和未定义 opcode 可以指向共享 error Codelet，wide entry 也位于同一个 opcode 的生成范围内。这部分放到 16.2 展开。
3. 一个被解释执行的 Java 方法仍然对应一个 interpreter activation frame。Codelet 是机器码组织单位，不是“每条字节码都创建一个 Java 栈帧”。

Template Interpreter 是否让某种 CPU 的间接分支更容易预测，需要结合处理器和实际字节码序列测量。仅从这里的源码可以确定的是：**它没有使用中央 C++ switch，并且可以生成平台相关、按解释器状态专门化的 handler。**

---

## 2. `interpreter_init()` 在启动链中的位置

### 2.1 `init_globals()` 的真实顺序

`init.cpp` 先在声明处标明两个约束：

```cpp
/* === src/hotspot/share/runtime/init.cpp:56-68 === */

void codeCache_init();
// ...
jint universe_init();          // depends on codeCache_init and stubRoutines_init
// depends on universe_init, must be before interpreter_init (currently only on SPARC)
void gc_barrier_stubs_init();
void interpreter_init();       // before any methods loaded
void invocationCounter_init(); // before any methods loaded
void accessFlags_init();
void templateTable_init();
void InterfaceSupport_init();
void universe2_init();  // ... loads primordial classes
```

真正执行时的次序是：

```cpp
/* === src/hotspot/share/runtime/init.cpp:101-125 === */

jint init_globals() {
  HandleMark hm;
  management_init();
  bytecodes_init();
  classLoader_init1();
  compilationPolicy_init();
  codeCache_init();
  VM_Version_init();
  os_init_globals();
  stubRoutines_init1();
  jint status = universe_init();
  if (status != JNI_OK)
    return status;

  gc_barrier_stubs_init();
  interpreter_init();
  invocationCounter_init();
  accessFlags_init();
  templateTable_init();
  InterfaceSupport_init();
  VMRegImpl::set_regName();
  SharedRuntime::generate_stubs();
  universe2_init();
  javaClasses_init();
  // ...
```

只保留本章相关节点，可以画成：

```text
codeCache_init()
      │
      ▼
universe_init()
      │
      ▼
gc_barrier_stubs_init()
      │
      ▼
interpreter_init()          ← 生成并发布解释器代码
      │
      ▼
invocationCounter_init()
      │
      ▼
templateTable_init()        ← 后文会看到：正常路径中是幂等重复调用
      │
      ▼
universe2_init()            ← 开始加载 primordial classes
```

### 2.2 CodeCache 不是由 Universe 初始化的

解释器生成的是可执行机器码，因此必须先有可执行代码存储空间。这个前置条件由 `codeCache_init()` 建立：它位于 `universe_init()` 之前，而 `init.cpp` 也明确写着 `universe_init()` 依赖 `codeCache_init()`。

所以准确的依赖关系是：

```text
codeCache_init()
  ├─ 为后续运行时代码提供 CodeCache
  ├─ universe_init() 依赖它
  └─ interpreter_init() 随后从 CodeCache 获得解释器代码空间
```

不能说“CodeCache 在 `universe_init()` 中初始化”。Universe 是解释器初始化之前必须就绪的一部分 VM 基础设施，但它不是 CodeCache 的创建者。

### 2.3 为什么必须 `before any methods loaded`

`interpreter_init()` 与 `invocationCounter_init()` 的声明旁都写着 `before any methods loaded`，而 `universe2_init()` 的注释明确说它会加载 primordial classes。

这里的直接依赖发生在 holder 链接方法时。`Method::link_method()` 会为普通非共享方法查询并安装解释器入口：

```cpp
/* === src/hotspot/share/oops/method.cpp:1075-1103（节选） === */

// Called when the method_holder is getting linked. Setup entrypoints so the method
// is ready to be called from interpreter, compiler, and vtables.
void Method::link_method(const methodHandle& h_method, TRAPS) {
  // ...
  if (!is_shared()) {
    assert(adapter() == NULL, "init'd to NULL");
    address entry = Interpreter::entry_for_method(h_method);
    assert(entry != NULL, "interpreter entry must be non-null");
    // Sets both _i2i_entry and _from_interpreted_entry
    set_interpreter_entry(entry);
  }
  // ...
}
```

因此，关键不是“每创建一个 `Method` 就马上执行它”，而是：**普通非共享方法在 holder 链接过程中安装解释器入口时，解释器 method-entry table 必须已经生成。** 这里要区分 class/method parsing、`Method` 对象创建、holder linking、入口安装和首次执行，它们不是同一个时刻。

CDS shared method 是一个特例：`Method::link_method()` 对它调用 `Interpreter::entry_for_cds_method()`，校验归档时保存的入口；解释器生成 method entry 时也会更新 CDS entry table。上面的直接 `entry_for_method()` 路径针对普通非共享方法。

因此启动期有一个清晰的分界：

```text
interpreter_init() 之前：
  VM 基础设施、CodeCache、Universe、必要的 barrier stubs 已就绪
  尚未进入 universe2_init() 所代表的 primordial-class 加载阶段

interpreter_init() 之后：
  解释器代码与入口地址已经生成并发布
  universe2_init() 才开始加载 primordial classes/methods
```

至于 `invocationCounter_init()` 为什么紧跟在后，源码在这里给出的直接约束同样是“必须早于方法加载”。仅凭相邻顺序不能进一步推导出“InvocationCounter 依赖解释器入口”之类没有调用链证据的结论。

---

## 3. 外层 `interpreter_init()` 做了四件事

`interpreter_init()` 本身很短：

```cpp
/* === src/hotspot/share/interpreter/interpreter.cpp:115-134 === */

void interpreter_init() {
  Interpreter::initialize();
#ifndef PRODUCT
  if (TraceBytecodes) BytecodeTracer::set_closure(BytecodeTracer::std_closure());
#endif // PRODUCT

  Forte::register_stub(
    "Interpreter",
    AbstractInterpreter::code()->code_start(),
    AbstractInterpreter::code()->code_end()
  );

  if (JvmtiExport::should_post_dynamic_code_generated()) {
    JvmtiExport::post_dynamic_code_generated("Interpreter",
                                             AbstractInterpreter::code()->code_start(),
                                             AbstractInterpreter::code()->code_end());
  }
}
```

四步职责如下：

| 步骤 | 作用 | 是否生成解释器机器码 |
|---|---|---|
| `Interpreter::initialize()` | 初始化解释器、生成并保存代码和入口 | **是** |
| `BytecodeTracer::set_closure(...)` | 非 product 构建下配置字节码跟踪 | 否 |
| `Forte::register_stub(...)` | 将整个解释器代码地址范围注册给性能分析工具 | 否 |
| `post_dynamic_code_generated(...)` | 通知 JVMTI 有一段名为 `Interpreter` 的动态代码 | 否 |

因此，真正的主线是第一句。其余三步解决的是调试、性能分析和 JVMTI 可见性问题。

`Interpreter` 在正常 Template Interpreter 构建中对应 `TemplateInterpreter`。下面进入真正的初始化主体。

---

## 4. `TemplateInterpreter::initialize()`：描述符、空间、生成器

### 4.1 非 `CC_INTERP` 构建中的完整函数主体

```cpp
/* === src/hotspot/share/interpreter/templateInterpreter.cpp:42-71 === */

void TemplateInterpreter::initialize() {
  if (_code != NULL) return;

  assert((int)Bytecodes::number_of_codes <= (int)DispatchTable::length,
         "dispatch table too small");

  AbstractInterpreter::initialize();

  TemplateTable::initialize();

  // generate interpreter
  { ResourceMark rm;
    TraceTime timer("Interpreter generation", TRACETIME_LOG(Info, startuptime));
    int code_size = InterpreterCodeSize;
    NOT_PRODUCT(code_size *= 4;)
    _code = new StubQueue(new InterpreterCodeletInterface, code_size, NULL,
                          "Interpreter");
    TemplateInterpreterGenerator g(_code);
    _code->deallocate_unused_tail();
  }

  if (PrintInterpreter) {
    ResourceMark rm;
    print();
  }

  // initialize dispatch table
  _active_table = _normal_table;
}
```

这段代码可以拆成六步。

### 4.2 第一步：防止重复初始化

```cpp
if (_code != NULL) return;
```

`_code` 是解释器的 `StubQueue*`。一旦它存在，说明解释器代码空间已经建立，后续重复调用直接返回。

### 4.3 第二步：初始化抽象解释器基础状态

```cpp
AbstractInterpreter::initialize();
```

`AbstractInterpreter::initialize()` 会重置按参数启用的字节码计数/直方图设施，并首次调用 `InvocationCounter::reinitialize(DelayCompilationDuringStartup)`，重算 `InvocationCounter` 共享的状态编码和阈值参数：

```cpp
/* === src/hotspot/share/interpreter/abstractInterpreter.cpp:55-65 === */

void AbstractInterpreter::initialize() {
  if (_code != NULL) return;

  if (CountBytecodes || TraceBytecodes || StopInterpreterAt) BytecodeCounter::reset();
  if (PrintBytecodeHistogram)                                BytecodeHistogram::reset();
  if (PrintBytecodePairHistogram)                            BytecodePairHistogram::reset();

  InvocationCounter::reinitialize(DelayCompilationDuringStartup);
}
```

这里初始化的是 `InvocationCounter` 的共享参数，不是尚未创建的每个 `Method` 所内嵌的计数器实例。稍后的顶层 `invocationCounter_init()` 会再次调用同一个 `reinitialize()`；它与 TemplateTable 不同，并没有通过 `_is_initialized` guard 直接短路。

### 4.4 第三步：先初始化 TemplateTable

```cpp
TemplateTable::initialize();
```

`TemplateTable` 保存每条字节码的模板描述符，包括输入/输出 `TosState`、flags、generator function 和参数。生成器必须先知道每条字节码应该调用哪个“代码生成配方”，随后才能发射机器码。

这一步**初始化的是模板描述符，不是最终机器码**。下面是根据 `templateTable.cpp:244-264` 简化、重排的示意代码：

```cpp
/* === src/hotspot/share/interpreter/templateTable.cpp:244-264（简化示意） === */

void TemplateTable::initialize() {
  if (_is_initialized) return;

  // ...
  def(Bytecodes::_nop,
      /* flags */, vtos, vtos, nop, /* argument */);
  def(Bytecodes::_aconst_null,
      /* flags */, vtos, atos, aconst_null, /* argument */);
  def(Bytecodes::_iconst_0,
      /* flags */, vtos, itos, iconst, 0);
```

具体模板如何注册留给 ch17；描述符如何变成 Codelet 留给 16.2。本文只需要确定时序：**TemplateTable 先就绪，generator 后运行。**

### 4.5 第四步：创建解释器专用 StubQueue

```cpp
int code_size = InterpreterCodeSize;
NOT_PRODUCT(code_size *= 4;)
_code = new StubQueue(new InterpreterCodeletInterface, code_size, NULL,
                      "Interpreter");
```

`InterpreterCodeSize` 给出请求的 queue/code-content capacity；实际 blob allocation 和可用 content size 还受对齐、CodeBlob header 与 CodeHeap 分配粒度影响。非 product 构建为了额外调试代码，把请求容量扩大为四倍。

注意：这是**预留容量**，不等于最终实际代码大小。真实占用还受架构、构建类型、JVM 参数和具体 JDK 更新版本影响，不能据此随意给出一个固定的“解释器总共多少 KB”。

### 4.6 第五步：构造 generator，并立即生成全部解释器代码

源码表面只写了：

```cpp
TemplateInterpreterGenerator g(_code);
```

但构造函数内部直接调用 `generate_all()`：

```cpp
/* === src/hotspot/share/interpreter/templateInterpreterGenerator.cpp:38-42 === */

TemplateInterpreterGenerator::TemplateInterpreterGenerator(StubQueue* _code)
  : AbstractInterpreterGenerator(_code) {
  _unimplemented_bytecode    = NULL;
  _illegal_bytecode_sequence = NULL;
  generate_all();
}
```

因此这不是“只创建一个生成器对象，稍后再生成”，而是：

```text
构造 TemplateInterpreterGenerator
              │
              └─ generate_all()
                    ├─ 辅助入口
                    ├─ 返回/异常/safepoint 等入口
                    ├─ 方法入口
                    ├─ 字节码 Codelet
                    └─ 反优化入口等
```

这些代码在 VM 启动期 eager 生成，不等到应用方法首次遇到某条字节码时再按需生成。具体生成顺序与 Codelet 生命周期将在 16.2 展开。

### 4.7 第六步：收缩空间并发布 active table

```cpp
_code->deallocate_unused_tail();
// ...
_active_table = _normal_table;
```

生成结束后，`deallocate_unused_tail()` 把预留但未使用的尾部空间归还给 CodeCache。随后把 normal dispatch table 的内容复制到 active table，设置正常模式下的初始活动调度表。

到这里，各组件职责可以总结为：

| 组件/操作 | 职责 |
|---|---|
| `AbstractInterpreter::initialize()` | 建立共享解释器基础状态 |
| `TemplateTable::initialize()` | 注册字节码模板描述符 |
| `new StubQueue(...)` | 为解释器 Codelet 准备可执行存储 |
| `TemplateInterpreterGenerator g(_code)` | 构造时调用 `generate_all()` 发射机器码 |
| `deallocate_unused_tail()` | 归还预留空间中未使用的尾部 |
| `_active_table = _normal_table` | 将 normal table 条目复制为初始 active table，设置正常模式下的活动调度表 |

---

## 5. 解释器代码到底存在哪里

### 5.1 从 CodeCache 到 InterpreterCodelet

`StubQueue` 构造函数揭示了 backing storage 的来源：

```cpp
/* === src/hotspot/share/code/stubs.cpp:67-81 === */

StubQueue::StubQueue(StubInterface* stub_interface, int buffer_size,
                     Mutex* lock, const char* name) : _mutex(lock) {
  intptr_t size = align_up(buffer_size, 2*BytesPerWord);
  BufferBlob* blob = BufferBlob::create(name, size);
  if (blob == NULL) {
    vm_exit_out_of_memory(size, OOM_MALLOC_ERROR,
                          "CodeCache: no room for %s", name);
  }
  _stub_interface  = stub_interface;
  _buffer_size     = blob->content_size();
  _buffer_limit    = blob->content_size();
  _stub_buffer     = blob->content_begin();
  _queue_begin     = 0;
  _queue_end       = 0;
  _number_of_stubs = 0;
}
```

`BufferBlob::create()` 从 CodeCache 获得一块可执行代码空间。`StubQueue` 自身是单独分配在 C heap 上的管理对象，通过 `_stub_buffer` 和边界字段管理这块 blob 的 content 区域；真正放置在 content 中的是一个个 `InterpreterCodelet`：

```text
StubQueue（C heap 管理对象）
└─ 管理 BufferBlob("Interpreter").content（CodeCache 中）
   ├─ InterpreterCodelet #1
   ├─ InterpreterCodelet #2
   ├─ InterpreterCodelet #3
   └─ ...
```

### 5.2 四个概念不能混为一谈

| 概念 | 所在层级 | 管理粒度 | 本章中的角色 |
|---|---|---|---|
| `CodeCache` | 最外层 | 管理 VM 生成的可执行代码空间及 CodeBlob | 提供可执行地址空间 |
| `BufferBlob` | CodeCache 内的一个 CodeBlob | 一整块 backing storage | 承载解释器 StubQueue |
| `StubQueue` | C heap 上的管理对象 | 通过 `_stub_buffer` 管理 BufferBlob content，request/commit/remove stub | 管理多个 Codelet |
| `InterpreterCodelet` | BufferBlob content 中的 queue entry | 解释器生成时的 allocation/metadata unit | 记录描述、可选 bytecode tag 和 code range；通常包含生成指令，但入口复用时不保证有独立的非空代码 |
| `nmethod` | CodeCache 中另一类 CodeBlob | 每个编译方法独立管理 | 保存 JIT 编译方法及其元数据 |

所以，“解释器代码和 JIT 编译代码都驻留在 CodeCache”在地址空间层面是成立的，但不能继续推导为：

```text
错误：每个 InterpreterCodelet 都是一个与 nmethod 并列的独立 CodeBlob
```

更准确的管理关系是：

```text
本文的主 Template Interpreter _code：
  StubQueue（C heap）→ 管理一个 BufferBlob.content → 多个 InterpreterCodelet

JIT：
  多个独立管理的 nmethod CodeBlob
```

`InterpreterCodeletInterface` 与 `StubQueue` 都是这条路径上的 VM-lifetime C-heap 对象；`BufferBlob` 提供 CodeCache 中的代码存储。queue/interface 并不物理位于 blob 内，也没有普通 RAII teardown。native signature handlers、调用适配器等其他解释器相关辅助代码还可能使用别的 blob 或稍后的生成路径，因此这里的“一个 BufferBlob”只描述 `_code` 所指的主 Template Interpreter queue。

`nmethod` 还携带依赖、oop map、反优化、卸载等编译方法生命周期所需的元数据。Codelet 不是“更小的 nmethod”。

同样，两者共享 CodeCache 也不是 OSR 成立的充分原因。OSR 还需要回边计数、编译策略、特定 BCI 的 OSR nmethod 和 frame-state migration，这些将在 16.3 只做边界介绍。

### 5.3 为什么生成后要归还 unused tail

StubQueue 创建时按 `InterpreterCodeSize` 预留空间，生成结束时实际使用量通常小于容量：

```cpp
/* === src/hotspot/share/code/stubs.cpp:92-98 === */

void StubQueue::deallocate_unused_tail() {
  CodeBlob* blob = CodeCache::find_blob((void*)_stub_buffer);
  CodeCache::free_unused_tail(blob, used_space());
  _buffer_size = blob->content_size();
  _buffer_limit = blob->content_size();
}
```

这一步先通过 `_stub_buffer` 找到所属 CodeBlob，再按 `used_space()` 收缩未使用尾部。解释器保留已经提交的 Codelet，不继续占着整块最大预留容量。

---

## 6. StubQueue 不是一个简单 bump allocator

### 6.1 通用实现是 wrap-around queue

`stubs.cpp` 开头直接写明：

```cpp
/* === src/hotspot/share/code/stubs.cpp:35-61 === */

// Implementation of StubQueue
//
// Standard wrap-around queue implementation;
// ...
// a) contiguous state: all queue entries in one block (or empty)
//
// b) non-contiguous state: queue entries in two blocks
```

它维护 `_queue_begin`、`_queue_end` 和 `_buffer_limit`，既可以处于连续状态，也可以在尾部放不下新 stub 时绕回 buffer 开头。公开操作包括：

```text
request(size)  → 找到并初始化一块候选 stub 空间
commit(size)   → 提交实际使用大小并推进 queue_end
remove_first() → 从队头移除 stub，必要时恢复 wrap-around 状态
```

例如 `request()` 在尾部放不下时会设置 `_buffer_limit`，再把 `_queue_end` 置零，以尝试从 buffer 开头分配：

```cpp
/* === src/hotspot/share/code/stubs.cpp:118-150（节选） === */

if (_queue_end + requested_size <= _buffer_size) {
  // code fits in at the end
  stub_initialize(s, requested_size, strings);
  return s;
} else {
  // stub doesn't fit in the queue end => wrap around
  _buffer_limit = _queue_end;
  _queue_end = 0;
}
// ... initialize from the first block when space is available
```

因此，从数据结构本身看，把 StubQueue 称作“只有一个指针不断向后移动的 bump allocator”是不准确的。

### 6.2 解释器为什么看起来像单调分配

通用 StubQueue 支持回绕和移除，不代表每个使用者都会用到全部能力。Template Interpreter 的生成过程是：

```text
VM 启动
  → 连续 request/commit Codelet
  → generate_all() 完成
  → deallocate_unused_tail()
  → 解释器代码常驻使用
```

解释器 Codelet 不会像短生命周期 stub 那样逐个 `remove_first()`。`StubQueue` 的析构函数注释甚至说明当前 StubQueue 从不销毁：

```cpp
/* === src/hotspot/share/code/stubs.cpp:84-89 === */

StubQueue::~StubQueue() {
  // Note: Currently StubQueues are never destroyed ...
  Unimplemented();
}
```

所以对**解释器这一条具体使用路径**，分配表现近似“启动时单调追加，随后常驻”；但这只是使用模式，不是 StubQueue 的完整数据结构定义。

---

## 7. 为什么后面还有一个 `templateTable_init()`

这是启动顺序中最容易产生误解的地方：

```text
interpreter_init()
invocationCounter_init()
templateTable_init()
```

如果只看函数名，很容易得出错误结论：

```text
错误理解：
interpreter_init() 先建立空解释器
  → templateTable_init() 稍后才初始化模板并生成字节码机器码
```

但我们已经看到，`TemplateInterpreter::initialize()` 内明确先调用了：

```cpp
TemplateTable::initialize();
```

而 `TemplateTable::initialize()` 自己有幂等 guard，并在所有通用与平台相关模板注册完成后设置状态：

```cpp
/* === src/hotspot/share/interpreter/templateTable.cpp:244-245, 526-531（节选） === */

void TemplateTable::initialize() {
  if (_is_initialized) return;
  // ... register templates ...
  pd_initialize();

  _is_initialized = true;
}
```

实际时间线是：

```text
interpreter_init()
  └─ TemplateInterpreter::initialize()
       ├─ TemplateTable::initialize()
       │    └─ 第一次有效调用：注册模板描述符
       └─ TemplateInterpreterGenerator(...)
            └─ generate_all()：生成机器码

稍后：templateTable_init()
  └─ TemplateTable::initialize()
       └─ _is_initialized == true，直接返回
```

所以，在本文的非 `CC_INTERP` Template Interpreter 构建中，顶层 `templateTable_init()` 会再次调用 `TemplateTable::initialize()`，随后由 guard 返回；在 `CC_INTERP` 构建中，这个顶层包装函数的函数体本身为空。无论哪一种情况，它都不是本文主解释器机器码首次生成的位置。

### 7.1 ch14 与 ch17 怎么划分

虽然顶层 `templateTable_init()` 的有效工作已经提前发生，后续章节仍然有独立分析价值：

| 章节 | 回答的问题 |
|---|---|
| 16.1（本文） | TemplateTable 在整体初始化链中何时就绪？解释器代码存在哪里？ |
| 16.2 | 描述符如何经过 generator 和 CodeletMark 变成机器码？ |
| ch17 | `TemplateTable::initialize()` 如何为每种字节码注册 flags、TosState、generator 和参数？ |

章节名按 `init_globals()` 的顶层函数顺序组织，但源码依赖可以发生在该顶层包装函数被显式调用之前。这里正是一个典型例子。

---

## 8. 完整链路总结

把本文所有内容放到一张图中：

```text
init_globals()
│
├─ codeCache_init()
│    └─ 建立可执行代码存储基础
│
├─ universe_init()
│    └─ 初始化解释器依赖的 VM 基础设施
│
├─ gc_barrier_stubs_init()
│    └─ 必须先于 interpreter_init
│
├─ interpreter_init()
│    │
│    ├─ Interpreter::initialize()
│    │    └─ TemplateInterpreter::initialize()
│    │         ├─ guard: _code != NULL ? return
│    │         ├─ AbstractInterpreter::initialize()
│    │         ├─ TemplateTable::initialize()
│    │         │    └─ 注册模板描述符
│    │         ├─ new StubQueue(..., "Interpreter")
│    │         │    └─ BufferBlob::create()
│    │         │         └─ 从 CodeCache 获得 backing storage
│    │         ├─ TemplateInterpreterGenerator(_code)
│    │         │    └─ generate_all()
│    │         │         └─ 生成多个 InterpreterCodelet
│    │         ├─ deallocate_unused_tail()
│    │         └─ _active_table = _normal_table
│    │
│    ├─ 可选 BytecodeTracer
│    ├─ Forte 注册解释器代码范围
│    └─ JVMTI 动态代码通知
│
├─ invocationCounter_init()
│
├─ templateTable_init()
│    └─ 幂等重复调用，正常路径中直接返回
│
└─ universe2_init()
     └─ 加载 primordial classes/methods
```

读完本文，应当能回答四个问题：

1. **为什么解释器必须早于方法加载？**
   因为方法链接和执行入口选择需要稳定的解释器 entry address。

2. **TemplateTable 什么时候第一次初始化？**
   在 `interpreter_init()` 内的 `TemplateInterpreter::initialize()` 中，而不是等后面的顶层 `templateTable_init()`。

3. **解释器机器码存在哪里？**
   CodeCache 中有一个作为 backing storage 的 `BufferBlob`；其 content 由 `StubQueue` 管理，内部包含多个 `InterpreterCodelet`。

4. **为什么不能把 Codelet 当成 nmethod？**
   Codelet 是 StubQueue 内部的 stub；nmethod 则是 CodeCache 独立管理的编译方法 CodeBlob，两者管理粒度和生命周期不同。

下一篇 **16.2 从 Template 描述符到 Codelet** 将进入 `generate_all()`，追踪一个模板如何通过 `InterpreterMacroAssembler` 发射机器码，并由 `CodeletMark` 完成 request、flush 与 commit。
