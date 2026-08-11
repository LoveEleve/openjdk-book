# ch16 interpreter_init — Template Interpreter 写作规划

> **源码基线**：OpenJDK 11u，x86-64，正常启用 Template Interpreter 的 HotSpot 构建。
>
> 本章不把结论泛化到所有架构和解释器配置；源码树中的 portable C++ interpreter 属于另一种实现路径。

## ch16 目标

读者读完 3 篇后，能够回答以下问题：

1. **`interpreter_init()` 为什么必须在 primordial methods 加载前完成？**
   ——方法链接时需要稳定的解释器入口；同时，解释器机器码生成依赖已经初始化的 CodeCache、Universe 与 GC barrier stubs。
2. **`TemplateTable` 中的描述符如何变成可执行机器码？**
   ——`TemplateTable::initialize()` 先注册模板元数据，`TemplateInterpreterGenerator` 随后在 VM 启动期 eager 生成 Codelet。
3. **一个字节码是否只对应一个入口地址？**
   ——一个已定义字节码通常对应一个 `InterpreterCodelet`，但 Codelet 内可以包含多个 `TosState` 专用入口和一个 wide entry。
4. **普通 Java 方法如何进入解释器并在字节码之间跳转？**
   ——先选择 `MethodKind` 对应的方法入口，再使用 `TosState + bytecode` 索引 dispatch table，通过 threaded dispatch 跳到下一个 handler。
5. **Safepoint 与 OSR 在解释执行中处于什么位置？**
   ——safepoint 既涉及 active/normal/safept dispatch table 切换，也涉及选定控制流位置的 thread-local poll；OSR 则通过计数器、编译策略、迁移缓冲区和 OSR entry 完成解释态到编译态的转移。

**不要求掌握的内容**：

- 每个字节码模板产生的具体 x86 指令序列；
- 完整的解释器栈帧布局；
- 每一种 intrinsic/MethodHandle entry 的平台实现；
- 编译策略、CompileBroker 与 nmethod 生命周期的完整细节。

---

## 本章最先要纠正的直觉

对本章讨论的 JDK 11u x86-64 Template Interpreter，正常执行模型不是一个中央 C++ 循环：

```c
while (true) {
  switch (*bcp++) {
    case _iconst_0: /* ... */ break;
    case _iload_1:  /* ... */ break;
    case _iadd:     /* ... */ break;
  }
}
```

HotSpot 会在 VM 启动期生成架构相关的机器码 handler。普通模板完成后，通过 dispatch table 间接跳转到下一条字节码对应的入口：

```text
当前 TosState + 当前 bytecode
            │
            ▼
     dispatch table entry
            │
            ▼
  generated machine-code handler
            │
            ├─ 模板自行控制转移（does_dispatch）
            └─ 默认 dispatch epilog → 下一 handler
```

准确表述应是：

- 它消除了中央 C++ `switch` 的调度结构；
- 它允许生成架构相关的 handler，并按 `TosState` 专门化入口；
- handler 之间使用 threaded dispatch / 尾部间接跳转，而不是普通函数的 tail-call；
- 间接跳转的实际分支预测效果依赖 CPU 和运行中的字节码序列，本章不作无数据支撑的性能保证；
- 一个 Java 方法仍然拥有一个解释器 activation frame，并不是每个字节码各建一个 Java 栈帧。

---

## 真实初始化主线

`init_globals()` 中与本章相关的顺序如下：

```text
codeCache_init()
  ↓
universe_init()
  ↓
gc_barrier_stubs_init()
  ↓
interpreter_init()
  │
  └─ Interpreter::initialize()
       （正常 Template Interpreter 构建中解析为 TemplateInterpreter）
       │
       ├─ 防重复初始化检查
       ├─ AbstractInterpreter::initialize()
       ├─ TemplateTable::initialize()
       │    └─ 注册 flags / TosState / generator / argument
       ├─ 创建 BufferBlob-backed StubQueue
       ├─ 构造 TemplateInterpreterGenerator
       │    └─ generate_all()
       ├─ 归还 StubQueue 未使用的尾部空间
       └─ _active_table = _normal_table
  │
  ├─ 可选 BytecodeTracer 设置
  ├─ Forte::register_stub()
  └─ JVMTI dynamic-code-generated 通知
  ↓
invocationCounter_init()
  ↓
templateTable_init()
  └─ 再次调用 TemplateTable::initialize()；正常路径中因幂等检查直接返回
  ↓
universe2_init()
  └─ 开始加载 primordial classes/methods
```

关键源码锚点：

- `src/hotspot/share/runtime/init.cpp:101-125`
- `src/hotspot/share/interpreter/interpreter.cpp:115-134`
- `src/hotspot/share/interpreter/templateInterpreter.cpp:42-71`
- `src/hotspot/share/interpreter/templateTable.cpp:244-260`
- `src/hotspot/share/interpreter/templateInterpreterGenerator.cpp:40-42`

### 三个关键结论

1. **CodeCache 由 `codeCache_init()` 初始化，不是由 `universe_init()` 初始化。**
2. **首次有效的 `TemplateTable::initialize()` 发生在 `interpreter_init()` 内部。**
3. **顶层后置的 `templateTable_init()` 不负责生成字节码机器码。** 在正常 Template Interpreter 路径中，它是一次幂等重复调用。

这也是 ch16 与 ch17 必须重新划分边界的原因：

- ch16 讲 TemplateTable 如何参与解释器整体初始化和机器码生成；
- ch17 深入 TemplateTable 如何注册每个字节码的模板描述符；
- 不能再描述成“ch16 只搭 Codelet 框架，ch17 才生成字节码机器码”。

---

## 理解顺序

```text
启动时为什么需要 interpreter_init？
  ↓
TemplateTable 描述符何时初始化？
  ↓
解释器机器码存在哪里？
  ↓
generate_all() 在启动期生成了哪些内容？
  ↓
一个 Template 怎样经过 CodeletMark 变成机器码？
  ↓
方法如何选择 entry，普通方法如何进入 bytecode dispatch？
  ↓
TosState + bytecode 如何定位 handler？
  ↓
Safepoint table/poll 与 OSR 如何接入这条运行路径？
```

---

## 文章结构（3 篇）

### 01 — `interpreter_init`：初始化链与代码存储

- [ ] **01-interpreter-initialization.md**

  **定位**：先回答 `interpreter_init()` 到底初始化了什么，并建立 `CodeCache → BufferBlob → StubQueue → InterpreterCodelet` 的存储层级。

  **Section 1. 本章讨论的是哪一种解释器**
  - JDK 11u x86-64 正常构建使用 Template Interpreter；
  - portable C++ interpreter 是源码树中的另一种配置，不能把结论泛化为“HotSpot 永远没有 switch interpreter”；
  - generated handler + threaded dispatch 与中央 C++ switch 的结构差异。

  **Section 2. `init_globals()` 中的位置和前置依赖**
  - `codeCache_init()`、`universe_init()`、`gc_barrier_stubs_init()` 与 `interpreter_init()` 的真实顺序；
  - GC barrier stubs 必须先于解释器代码生成；
  - `interpreter_init()` 为什么标注为 `before any methods loaded`；
  - `universe2_init()` 在解释器之后加载 primordial classes。

  **Section 3. `TemplateInterpreter::initialize()` 的真实步骤**
  - 防重复初始化；
  - `AbstractInterpreter::initialize()`；
  - `TemplateTable::initialize()`；
  - 创建 `StubQueue`；
  - generator 构造时调用 `generate_all()`；
  - trim unused tail；
  - `_active_table = _normal_table`；
  - `interpreter_init()` 外层的 BytecodeTracer、Forte 与 JVMTI 工作。

  **Section 4. 解释器机器码存在哪里**
  - `StubQueue` 通过 `BufferBlob::create()` 获得 CodeCache-backed executable storage；
  - 一个 BufferBlob 承载解释器 StubQueue，内部保存多个 `InterpreterCodelet`；
  - `InterpreterCodelet` 不是与 `nmethod` 同粒度独立管理的 CodeBlob；
  - `nmethod` 有独立依赖、卸载和反优化生命周期，两者不可混为一谈。

  **Section 5. `StubQueue` 的准确定位**
  - 通用实现是 wrap-around queue，支持 request/commit/remove；
  - 解释器启动生成期间只追加、不会移除 Codelet，因此这条使用路径近似单调分配；
  - 不把整个 `StubQueue` 数据结构简化成 bump-pointer allocator。

  **Section 6. 为什么后面还有 `templateTable_init()`**
  - `TemplateTable::_is_initialized` 保证幂等；
  - 首次初始化已经在 `TemplateInterpreter::initialize()` 中完成；
  - 后置全局调用在正常路径中没有再次生成机器码；
  - 引出 ch17 对模板注册细节的分析。

  **关键源码**：
  - `src/hotspot/share/runtime/init.cpp`
  - `src/hotspot/share/interpreter/interpreter.cpp`
  - `src/hotspot/share/interpreter/templateInterpreter.cpp`
  - `src/hotspot/share/interpreter/templateTable.cpp`
  - `src/hotspot/share/code/stubs.cpp`

### 02 — 从 Template 描述符到 Codelet

- [ ] **02-codelet-generation.md**

  **定位**：回答一个已定义字节码如何在 VM 启动期从模板描述符变成一个包含若干 entry point 的 `InterpreterCodelet`。

  **Section 1. TemplateTable 保存的是生成配方**
  - `_template_table` 与 `_template_table_wide`；
  - flags、输入/输出 `TosState`、generator function 与 argument；
  - `TemplateTable::initialize()` 注册元数据，本身不发射最终机器码；
  - x86 的实际模板 generator 主要位于 `templateTable_x86.cpp`。

  **Section 2. `generate_all()` 生成的不只是字节码 handler**
  - slow signature、error、trace、return 等辅助入口；
  - native result handlers；
  - safepoint 与 exception entries；
  - method entries；
  - bytecode codelets，并同时安装 normal/wide entries；
  - safepoint dispatch table；
  - deoptimization entries。

  生成顺序必须以 `generate_all()` 源码为准，不概括成“方法入口 → 字节码 → dispatch table → 异常”。

  **Section 3. 字节码 Codelet 是启动期 eager 生成的**
  - `set_entry_points_for_all_bytes()` 遍历完整 dispatch table 域；
  - 每个 defined bytecode 在 VM 启动期调用 `set_entry_points(code)`；
  - undefined slot 指向 unimplemented entry；
  - 不存在“等业务代码第一次执行该字节码才生成”的 lazy 路径。

  **Section 4. 一个 Codelet 可以有多个入口**
  - 一个 defined bytecode 对应一个 `CodeletMark` 生成范围；
  - Codelet 内可包含 `btos/ztos/ctos/stos/atos/itos/ltos/ftos/dtos/vtos` 等 `TosState` 入口；
  - 支持 wide 的字节码还会安装 wide entry；
  - “一个字节码 = 一段机器码”是教学简化，不等于“一个字节码 = 一个地址”。

  **Section 5. `CodeletMark` 的 RAII 生命周期**
  - 构造：向 queue request 空间、初始化 `InterpreterCodelet` 元数据、建立 `InterpreterMacroAssembler`；
  - 生成：`Template::generate(_masm)` 发射平台机器码；
  - 析构：alignment、flush、计算 code size、commit；
  - 最后将调用方持有的 assembler 指针置空，表示当前 codelet 生成上下文结束；
  - 不声称析构函数 `delete` assembler，也不把“之后必然 segfault”当作语言级保证。

  **Section 6. 默认 dispatch 与自行 dispatch**
  - 普通模板完成后由 `dispatch_epilog()` 补上后续 dispatch；
  - `does_dispatch()` 模板自行生成控制转移；
  - 因此不能写“每个 Codelet 末尾都以同一种方式跳到下一字节码”。

  **关键源码**：
  - `src/hotspot/share/interpreter/templateTable.cpp`
  - `src/hotspot/share/interpreter/templateInterpreterGenerator.cpp:57-401`
  - `src/hotspot/share/interpreter/interpreter.cpp:84-112`
  - `src/hotspot/cpu/x86/templateTable_x86.cpp`
  - `src/hotspot/cpu/x86/interp_masm_x86.cpp`

### 03 — 方法入口、Threaded Dispatch 与运行时边界

- [ ] **03-entry-points-and-dispatch.md**

  **定位**：回答生成后的解释器如何运行：方法先选哪个入口，普通 Java 方法如何 dispatch，以及 safepoint 和 OSR 如何接入。

  **Section 1. MethodKind 不止四种**
  - 普通 Java：`zerolocals`；
  - synchronized Java：`zerolocals_synchronized`；
  - native / native synchronized；
  - abstract；
  - empty、accessor、intrinsic、MethodHandle 等 specialized entry；
  - “普通/synchronized/native/abstract”只能作为教学分组，不能冒充完整枚举。

  **Section 2. 并非所有入口都进入字节码 dispatch**
  - 普通解释执行的 Java 方法建立 frame 后进入 bytecode dispatch；
  - native 入口进入 JNI/native transition；
  - abstract 入口抛出 `AbstractMethodError`；
  - empty/accessor/intrinsic/MethodHandle 等可能走专门路径；
  - 因而删除“所有方法类型最终都通过 dispatch 表进入 Codelet”的结论。

  **Section 3. DispatchTable 的二维索引模型**
  - dispatch 不是单纯的 `bytecode → address` 数组；
  - 它按当前 cached `TosState` 和 bytecode 选择 entry；
  - `_normal_table`、`_safept_table`、`_active_table` 承担不同角色；
  - wide entry 另行维护；
  - x86 `dispatch_next()` 读取下一 bytecode、推进 BCP 并间接跳转。

  **Section 4. Threaded dispatch 的准确边界**
  - 默认模板通过 `dispatch_epilog/dispatch_next` 跳转；
  - branch、invoke、return、throw 以及 `does_dispatch()` 模板可能自行决定控制流；
  - 使用“threaded dispatch”“尾部间接跳转”，避免把 handler 当作普通函数 tail-call；
  - 编译后的机器码不执行解释器 bytecode dispatch，但不能把它概括成“改走 vtable/itable”：vtable/itable 解决的是部分动态调用目标解析问题。

  **Section 5. Safepoint-aware dispatch**
  - `_active_table` 可在 normal table 与 safepoint table 内容之间切换；
  - safepoint table entry 跳到按 `TosState` 生成的 safepoint handler；
  - x86 thread-local polling 还会在选定 branch/return dispatch site 以 `generate_poll=true` 发射显式 poll；
  - 不描述为“每个字节码末尾直接调用 `SafepointSynchronize::is_synchronizing()`”；
  - 不把每个普通 bytecode boundary 无条件称为显式 polling safepoint。

  **Section 6. 异常与反优化入口只讲生成边界**
  - `generate_all()` 会生成通用与专门的 exception entries；
  - deoptimization entries 也属于解释器生成物；
  - 本章不展开完整异常表查找与反优化 frame reconstruction；
  - 不在没有具体调用链证据时把通用异常处理强连到 ch15 `LatestMethodCache`。

  **Section 7. OSR：解释器与编译执行的边界**
  - loop backedge 更新计数器；
  - overflow 进入 `InterpreterRuntime::frequency_counter_overflow()` 和 compilation policy；
  - 编译可能排队异步发生，不能说“编译器在 safepoint 中编译”；
  - 获得有效 OSR nmethod 后，`SharedRuntime::OSR_migration_begin()` 打包解释器 locals/stack/locks；
  - 最后跳到 `nmethod::osr_entry()`；
  - 共享 CodeCache 不是 OSR 的充分原因，OSR 的关键是计数、策略、OSR nmethod 与 frame-state migration。

  **关键源码**：
  - `src/hotspot/share/interpreter/templateInterpreter.hpp:131-168`
  - `src/hotspot/share/interpreter/templateInterpreter.cpp:208-324`
  - `src/hotspot/share/interpreter/templateInterpreterGenerator.cpp:186-424`
  - `src/hotspot/cpu/x86/interp_masm_x86.cpp:798-893`
  - `src/hotspot/cpu/x86/templateTable_x86.cpp:2313-2365`
  - `src/hotspot/share/interpreter/interpreterRuntime.cpp:1008-1068`

---

## 写作进度

| 篇 | 状态 | 日期 |
|----|------|------|
| 01 `interpreter_init`：初始化链与代码存储 | ✅ 已完成 | 2026-07-25 |
| 02 从 Template 描述符到 Codelet | ✅ 已完成 | 2026-07-25 |
| 03 方法入口、Threaded Dispatch 与运行时边界 | ✅ 已完成 | 2026-07-26 |

---

## 与前后章节的连接

```text
ch15 LatestMethodCache
  │  仅作为 init_globals 启动顺序中的前章
  ▼
ch16 interpreter_init
  ├─ 01：初始化链 + BufferBlob/StubQueue/Codelet 存储层级
  ├─ 02：Template 描述符 + eager Codelet generation
  └─ 03：MethodKind entry + dispatch + safepoint + OSR 边界
  ▼
ch17 templateTable_init
     深入 TemplateTable::initialize() 如何注册模板描述符
     注：顶层 templateTable_init 在正常路径中是幂等重复调用，
         并不是字节码机器码首次生成的位置
```

---

## 关键写作决策

### 为什么仍然是 3 篇

1. **01 讲初始化和存储**：先建立启动时序与对象层级，避免一开始就陷入汇编模板。
2. **02 讲生成**：沿 `TemplateTable → Generator → CodeletMark → machine code` 回答代码如何产生。
3. **03 讲运行**：把 method entry、dispatch、safepoint 和 OSR 放回实际执行路径。

三篇分别回答“何时建立”“怎样生成”“如何运行”，边界清晰。继续拆分会让同一条初始化链过度碎片化；压成一篇则会混淆启动期生成与运行期执行。

### 为什么 ch16 必须讲到 TemplateTable

虽然顶层 `templateTable_init()` 是 ch17 的章节名，但正常 Template Interpreter 路径会在 `interpreter_init()` 内首次调用 `TemplateTable::initialize()`，随后立刻生成代码。因此 ch16 必须说明它在初始化链中的职责；ch17 再逐项深入模板注册表内容。

### 为什么不逐个分析 200 余种字节码模板

本章关注机制而非完整 x86 指令手册。选择 1～2 个代表性模板展示：

```text
Template descriptor
  → Template::generate(masm)
  → one codelet with TosState entries
  → dispatch
```

其余模板只作为查阅练习，不逐个展开。

### 为什么 OSR 只保留为边界小节

OSR 能说明解释执行如何过渡到编译执行，但完整机制属于编译策略、CompileBroker、nmethod 和 frame migration 专题。本章只追到：

```text
backedge counter overflow
  → compilation policy
  → valid OSR nmethod
  → OSR migration buffer
  → osr_entry
```

不展开编译队列与编译器内部实现。

### 为什么不写固定代码大小和分支预测结论

- 解释器代码大小受架构、product/debug build、JVM 参数和具体 JDK 更新版本影响；若正文需要数字，必须对指定构建实测并注明配置。
- threaded dispatch 消除了中央 C++ switch，但间接分支是否更易预测需要 benchmark 与处理器上下文，不能仅凭源码结构断言。

---

## 正文写作前的核对清单

- [ ] 初始化顺序与 `runtime/init.cpp`、`templateInterpreter.cpp` 一致。
- [ ] 明确 `TemplateTable::initialize()` 首次发生在 `interpreter_init()` 内。
- [ ] 不再把顶层 `templateTable_init()` 写成机器码生成阶段。
- [ ] 明确字节码 Codelet 是启动期 eager 生成，不是首次使用时 lazy 生成。
- [ ] 区分 BufferBlob、StubQueue、InterpreterCodelet 与 nmethod 的管理粒度。
- [ ] 将 dispatch 描述为 `TosState + bytecode → entry`。
- [ ] 区分 normal/safept/active table 切换与 selected-site thread-local polling。
- [ ] 不声称所有 MethodKind 最终进入普通字节码 dispatch。
- [ ] 不用 vtable/itable 概括编译代码的执行模型。
- [ ] 不声称编译在 safepoint 中同步完成。
- [ ] 准确描述 `CodeletMark` 的 flush/commit/置空行为，不写释放 assembler 或保证 segfault。
- [ ] 不保留无实测来源的固定代码大小、分支预测或 OSR 因果结论。
