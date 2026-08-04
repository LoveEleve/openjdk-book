# ch17 templateTable_init — TemplateTable 模板注册写作规划

> **源码基线**：OpenJDK 11u，x86-64，正常启用 Template Interpreter 的 HotSpot 构建。
>
> 本章不把结论泛化到所有架构和解释器配置；CC_INTERP 路径下 `TemplateTable::initialize()` 完全是空函数。

## ch17 目标

读者读完 3 篇后，能够回答以下问题：

1. **`Template` 类为什么只有 5 个字段？** —描述符设计极简：4-bit flag + tos_in/out + 函数指针 + 参数。bytecode ID 由指针减法反推，不需要单独存储。
2. **`def()` 如何注册 ~251 个模板描述符？** —6 个重载透明地将不同参数类型统一 cast 为 int，根据 wide flag 选择写入 `_template_table` 或 `_template_table_wide`。
3. **`TemplateTable::initialize()` 逐段做了什么？** —防重入、flag 常量、标准字节码注册、wide 注册、JVM 内部字节码注册、pd_initialize、设置 `_is_initialized`。
4. **x86 generator 函数有哪些结构模式？** —nop（最简）、iop2（参数分发）、iload（bytecode rewriting）、invokevirtual（多步骤）等典型模式。
5. **模板注册和模板代码生成为什么是两阶段？** —注册填充 C++ 数据结构（ch17），生成调用 `_gen(_arg)` 产生 x86 机器码（ch14/02 已涉及）。两者分离是生成器模式的核心。

**不要求掌握的内容**：

- 每个字节码模板产生的具体 x86 指令序列；
- Templates 在 200+ 字节码量级上的逐个枚举；
- CC_INTERP 路径的差异实现；
- intrinsic/MethodHandle 的平台细节。

---

## ch17 与 ch14 的边界

ch14 已经讲完了 Template Interpreter 的整体初始化流程（`TemplateInterpreter::initialize()`），其中包含对 `TemplateTable::initialize()` 的首次调用。ch17 聚焦于这个调用内部的注册机制——Template 描述符是什么、def() 如何工作、initialize() 逐段做什么。

关键事实：

```
interpreter_init()                           ← ch14 核心
  └─→ TemplateInterpreter::initialize()      ← ch14 核心
        └─→ TemplateTable::initialize()      ← 首次调用，真正注册 (~251 个模板)
              _is_initialized = true

templateTable_init()                         ← ch17 章节名
  └─→ TemplateTable::initialize()            ← 第二次调用，_is_initialized 防重入，直接返回
```

`templateTable_init()` 在 `init_globals()` 中是 trivial 单行委托。ch17 讨论的不是这个 trivial 委托本身，而是 `TemplateTable::initialize()` 内部的注册流程——无论通过哪条路径调用。

---

## 真实调用链

```
init_globals()                               ← init.cpp:101
  ├─→ interpreter_init()                     ← init.cpp:117
  │     └─→ TemplateInterpreter::initialize() ← templateInterpreter.cpp:42
  │           └─→ TemplateTable::initialize()  ← FIRST CALL (line 50)
  │                 ├─→ _is_initialized? no
  │                 ├─→ 注册 203 个标准字节码模板
  │                 ├─→ 注册 12 个 wide 模板
  │                 ├─→ 注册 36 个 JVM 内部字节码模板
  │                 ├─→ pd_initialize() (x86: 空)
  │                 └─→ _is_initialized = true
  │
  ├─→ templateTable_init()                   ← init.cpp:120
  │     └─→ TemplateTable::initialize()       ← SECOND CALL (templateTable.cpp:548)
  │           └─→ if (_is_initialized) return;  ← 防重入，直接返回
  │
  └─→ interpreter_init() 之后立即走到 set_entry_points_for_all_bytes()
        └─→ 使用注册好的模板描述符生成实际 x86 机器码
```

关键源码锚点：

- `src/hotspot/share/interpreter/templateTable.hpp:44-91` — Template 类 + TemplateTable 类声明
- `src/hotspot/share/interpreter/templateTable.cpp:42-55` — Template::initialize() / Template::bytecode()
- `src/hotspot/share/interpreter/templateTable.cpp:180-222` — def() 6 个重载
- `src/hotspot/share/interpreter/templateTable.cpp:244-531` — TemplateTable::initialize() 完整注册
- `src/hotspot/share/interpreter/templateTable.cpp:547-549` — templateTable_init() 单行委托
- `src/hotspot/share/interpreter/bytecodes.hpp:38-307` — Bytecodes::Code 枚举 (239 个)
- `src/hotspot/cpu/x86/templateTable_x86.cpp` — x86 generator 实现
- `src/hotspot/share/interpreter/templateInterpreterGenerator.cpp:276-402` — set_entry_points / generate_and_dispatch

---

## 理解顺序

```
Template 描述符是什么？5 个字段分别表示什么？
  ↓
def() 如何注册——6 个重载、参数多态、wide 分支
  ↓
bytecode() 指针减法——描述符不需要存储 bytecode ID
  ↓
TemplateTable::initialize() 逐段做了什么？
  ↓
flag 常量 (ubcp/disp/clvm/iswd) 编码了什么行为特征？
  ↓
x86 generator 有哪些结构模式？nop/iop2/iload/invokevirtual
  ↓
注册（填充结构体）与生成（产生机器码）为什么是两阶段？
```

---

## 文章结构（3 篇）

### 01 — Template 描述符：极简的数据结构

- [ ] **01-template-descriptor.md**

  **定位**：先回答"描述符是什么"——Template 类的 5 字段设计、def() 注册机制、数组结构。

  **Section 1. Template 类：只有 5 个字段**
  - `_flags` (4 bits: uses_bcp/does_dispatch/calls_vm/wide)
  - `_tos_in`, `_tos_out` (TosState 枚举)
  - `_gen` (函数指针 `void (*)(int)`)
  - `_arg` (传给 generator 的参数)
  - `initialize()` 简单赋值，`is_valid()` 判空

  **Section 2. bytecode() 指针减法**
  - 通过 `this - TemplateTable::_template_table` 反推 bytecode ID
  - 先查普通表，再查 wide 表
  - 内存零开销——不需要冗余存储 bytecode 编号

  **Section 3. _template_table 和 _template_table_wide**
  - 两个 `Template[239]` 静态数组
  - `Bytecodes::number_of_codes = 239`（203 标准 + 36 内部）

  **Section 4. def() 注册机制**
  - 6 个重载适配不同参数类型（无参+char filler / int / Operation / Condition / TosState / bool）
  - 核心逻辑：根据 `iswd` flag 选择数组，调用 `t->initialize()`
  - 参数统一 cast 为 int 存储

  **Section 5. _desc 和 transition()**
  - `_desc` 指向当前生成中的模板
  - `transition()` 只做 assert 检查，不生成代码
  - `_desc` 在 `Template::generate()` 中被设置为 `this`，指向当前正在生成代码的模板。调用链：`_desc = this → _gen(_arg) → masm->flush()`。`_desc` 不会被显式 NULL，仅在下次调用 `generate()` 时被覆盖。

  **关键源码**：
  - `src/hotspot/share/interpreter/templateTable.hpp:44-91`
  - `src/hotspot/share/interpreter/templateTable.cpp:42-55`
  - `src/hotspot/share/interpreter/templateTable.cpp:162-165`
  - `src/hotspot/share/interpreter/templateTable.cpp:180-222`

### 02 — TemplateTable::initialize()：251 个模板的批量注册

- [ ] **02-templatetable-initialize.md**

  **定位**：完整 walkthrough `TemplateTable::initialize()` 的 288 行（244-531），分段解读每类字节码的注册。

  **Section 1. 防重入 + flag 常量**
  - `_is_initialized` 检查
  - `ubcp/disp/clvm/iswd` 四个 flag 常量的含义

  **Section 2. 标准 Java 字节码注册（203 个）**
  - 按字节码类别分组解读：
    - 常量：nop/aconst_null/iconst_*/lconst_*/fconst_*/dconst_*/bipush/sipush/ldc/ldc_w/ldc2_w
    - 加载：iload/lload/fload/dload/aload
    - 存储：istore/lstore/fstore/dstore/astore
    - 栈操作：pop/pop2/dup/dup_x1/dup_x2/dup2/dup2_x1/dup2_x2/swap
    - 算术：iadd/ladd/fadd/dadd/isub/lsub/fsub/dsub/imul/lmul/fmul/dmul/idiv/ldiv/fdiv/ddiv/irem/lrem/frem/drem/ineg/lneg/fneg/dneg
    - 移位：ishl/lshl/ishr/lshr/iushr/lushr
    - 位运算：iand/land/ior/lor/ixor/lxor
    - 自增：iinc
    - 转换：i2l/i2f/i2d/l2i/l2f/l2d/f2i/f2l/f2d/d2i/d2l/d2f/i2b/i2c/i2s
    - 比较：lcmp/fcmpl/fcmpg/dcmpl/dcmpg
    - 条件跳转：ifeq/ifne/iflt/ifge/ifgt/ifle/if_icmp*/if_acmp*/ifnull/ifnonnull
    - 无条件跳转：goto/goto_w
    - 表跳转：tableswitch/lookupswitch
    - 子程序（deprecated）：jsr/ret/jsr_w
    - 返回：ireturn/lreturn/freturn/dreturn/areturn/return
    - 字段：getstatic/putstatic/getfield/putfield
    - 调用：invokevirtual/invokespecial/invokestatic/invokeinterface/invokedynamic
    - 对象：new/newarray/anewarray/arraylength/athrow/checkcast/instanceof/monitorenter/monitorexit
    - 多维数组：multianewarray

  **Section 3. Wide 字节码注册（12 个，写入 `_template_table_wide`）**
  - wide_iload/wide_lload/wide_fload/wide_dload/wide_aload
  - wide_istore/wide_lstore/wide_fstore/wide_dstore/wide_astore
  - wide_iinc
  - wide_ret
  - 注：`_breakpoint` 也在此代码段但无 `iswd` flag，注册到 `_template_table`（标准表）

  **Section 4. JVM 内部字节码注册（36 个）**
  - _fast_agetfield, _fast_bgetfield, _fast_cgetfield, _fast_dgetfield, _fast_fgetfield, _fast_igetfield, _fast_lgetfield, _fast_sgetfield (8 个 getfield)
  - _fast_aputfield, _fast_bputfield, _fast_zputfield, _fast_cputfield, _fast_dputfield, _fast_fputfield, _fast_iputfield, _fast_lputfield, _fast_sputfield (9 个 putfield)
  - _fast_aload_0, _fast_iaccess_0, _fast_aaccess_0, _fast_faccess_0
  - _fast_iload, _fast_iload2, _fast_icaload
  - _fast_invokevfinal, _fast_linearswitch, _fast_binaryswitch
  - _fast_aldc, _fast_aldc_w
  - _invokehandle
  - _return_register_finalizer
  - _nofast_getfield, _nofast_putfield, _nofast_aload_0, _nofast_iload
  - _shouldnotreachhere

  **Section 5. pd_initialize() 平台差异**
  - x86 上为空函数
  - 其他平台可能有额外初始化

  **关键源码**：
  - `src/hotspot/share/interpreter/templateTable.cpp:244-531`
  - `src/hotspot/share/interpreter/bytecodes.hpp:38-307`

### 03 — Generator 函数结构与注册到生成的闭环

- [ ] **03-generator-structure.md**

  **定位**：展示 x86 generator 函数的典型结构模式，并串联"注册 → 生成"两阶段闭环。

  **Section 1. nop——最简模式**
  - `transition(vtos, vtos)` 只做断言
  - 不生成任何 x86 指令

  **Section 2. iop2——参数分发模式**
  - 同一个 `iop2(Operation op)` 被 iadd/isub/imul/idiv/irem 等 6+ 个字节码共用
  - `def()` 传入不同 Operation 枚举值，generator 内部 switch 分发
  - 展示对应的 x86 指令生成（pop + 运算 + push）

  **Section 3. iload——bytecode rewriting 模式**
  - `iload()` → `iload_internal(RewriteControl)`
  - `RewriteFrequentPairs` 检测相邻 iload 对
  - `iload + iload → fast_iload2` 运行时 patch 字节码

  **Section 4. invokevirtual——多步骤复杂模式**
  - resolve cache、check null、load receiver、indirect call
  - 展示 `calls_vm` flag 的作用

  **Section 5. generate_and_dispatch()——注册到生成的闭环**
  - `set_entry_points_for_all_bytes()` 遍历 `_template_table`
  - `generate_and_dispatch(t)` 的三阶段：
    - profiling/tracing 前缀（可选）
    - `dispatch_prolog(tos_out)` — 跳表准备
    - `t->generate(_masm)` — 核心：`_desc = this → _gen(_arg)` 调用 x86 generator
    - `dispatch_epilog(tos_out)` — 跳转到下一条

  这节串起 ch17 全部内容：描述符注册（01）→ initialize（02）→ 注册到生成的完整闭环（03）。

  **关键源码**：
  - `src/hotspot/cpu/x86/templateTable_x86.cpp:245-248` (nop)
  - `src/hotspot/cpu/x86/templateTable_x86.cpp:1337-1351` (iop2)
  - `src/hotspot/cpu/x86/templateTable_x86.cpp:614-662` (iload)
  - `src/hotspot/share/interpreter/templateInterpreterGenerator.cpp:276-402`

---

## 写作进度

| 篇 | 状态 | 日期 |
|----|------|------|
| 01 Template 描述符：极简的数据结构 | ✅ 已完成 | 2026-07-26 |
| 02 TemplateTable::initialize()：251 个模板的批量注册 | ✅ 已完成 | 2026-07-26 |
| 03 Generator 函数结构与注册到生成的闭环 | — | — |

---

## 与前后章节的连接

```
ch14 interpreter_init
  │  TemplateInterpreter::initialize() 内首次调用 TemplateTable::initialize()
  │  然后调用 generate_all() 使用注册好的模板生成机器码
  ▼
ch17 templateTable_init
  ├─ 01：Template 5 字段 + def() + 数组结构
  ├─ 02：TemplateTable::initialize() 251 个模板注册 walkthrough
  └─ 03：x86 generator 结构模式 + 注册→生成闭环
  ▼
ch18 SharedRuntime::generate_stubs
     init_globals() 中紧跟 templateTable_init 之后的步骤
```

---

## 关键写作决策

### 为什么是 3 篇

1. **01 讲数据结构**：先建立 Template 类、def()、数组结构等概念基础。
2. **02 讲注册流程**：逐段 walkthrough `TemplateTable::initialize()` 的 288 行代码，按字节码类别分组。
3. **03 讲生成器结构 + 闭环**：展示 x86 generator 的四种结构模式，并串联注册到生成的完整流程。

三篇分别回答"是什么""怎么注册""注册后如何用"，与 ch14 三篇（何时建立/怎样生成/如何运行）形成对应。压成两篇会让 288 行注册代码挤在一起难以消化；拆成四篇会让 generator 示例与注册→生成闭环分离失去连贯性。

### 为什么不逐个分析 248 个字节码

ch17 关注注册机制而非 251 种字节码的完整清单。02 按类别分组解读代表性字节码的 flag 选择，展示分类规律即可。逐个列出与源码列表无异的字节码清单对读者理解机制无帮助。

### 为什么 03 要 include generate_and_dispatch

模板注册的最终目的就是给代码生成提供输入。如果 03 只讲 generator 不接回 `generate_and_dispatch()`，读者无法理解描述符的实际作用。这一节把 ch17 的注册内容与 ch14 的生成流程串成闭环。

### 为什么不过度展开 bytecode rewriting

iload 的 rewriting 模式只在 03 作为 generator 结构模式之一出现，不展开完整的 RewriteFrequentPairs 机制。完整 rewriting 属于 ch19 (universe2_init) 的范畴。

---

## 正文写作前的核对清单

- [ ] Template 5 字段解释完整，不含省略号
- [ ] bytecode() 指针减法逻辑正确（先普通再 wide，边界检查）
- [ ] def() 6 个重载的参数多态和核心调用路径清晰
- [ ] TemplateTable::initialize() 的 7 个步骤完整（防重入/缓存/flag/标准/wide/内部/pd）
- [ ] flag 常量 (ubcp/disp/clvm/iswd) 每个都有示例字节码说明
- [ ] x86 generator 四种模式的代码片段来自真实源码
- [ ] 注册→生成闭环的调用路径完整
- [ ] 不把 `templateTable_init()` 描述为"生成代码的步骤"
- [ ] 不声称 CC_INTERP 路径有模板注册
