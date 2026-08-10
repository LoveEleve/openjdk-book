# Interpreter（解释器）— 文章大纲（Pass 1 修订版）

> vol-04 · 域 23 · 🔴 A | 基于 Pass 0+1 探索笔记
> Pass 1 产出：7 基本元素 / 7 标记问题
>
> **→ 从 ClassFile**：类加载完了，每个方法存着 `Code` 属性——全是字节码。但 CPU 不认识 `iload`——模板解释器篇。

## 概念依赖

依赖 OOPs（Method 字节码）+ Assembler（MacroAssembler 生成 template）+ CodeCache（template 存储）。`init_globals()` → `interpreter_init()` → `TemplateInterpreter::initialize()` → `generate_all()`（`init.cpp:116`）。

## 叙事计划

**开篇场景**：你写的方法还没被 JIT 编译——JVM 怎么执行 `a + b`？不是逐条 if-else 判断 opcode（那是 Zero 端口的做法，太慢）。HotSpot 用模板解释器——每个字节码在 JVM 初始化时就预生成一小段机器码（template），解释执行就是从一个 template 跳到下一个 template——CPU 在执行机器码，不是 C++ 在解释。

**第一层：AbstractInterpreter——双解释器架构的统一接口**

`AbstractInterpreter`（`abstractInterpreter.hpp`）是模板解释器和 C++ 解释器的共同基类。定义 `MethodKind` 枚举——`zerolocals`（普通方法）、`synchronized`、`native`、`accessor` 等，不同 kind 有不同的入口点。`entry_point(kind)` 返回该方法的第一个 template 地址。双解释器架构中 Template 通过 `generate_all()` 填充入口表，CppInterpreter 通过 switch-case 解释——共享同一套接口。

**第二层：Template——字节码到机器码的配方**

`Template`（`templateTable.hpp:44`）用 `_flags`（uses_bcp/does_dispatch/calls_vm/is_wide 位标志）描述字节码属性，`_tos_in/_tos_out`（TOS 缓存状态：`itos/atos/vtos/ltos/ftos/dtos/btos/ztos`）描述栈效果。`generate()` 用 `MacroAssembler` 生成对应的机器码——`iload_0` 的 template 生成 `mov eax, [rsp+local_offset]` + reduce dispatch overhead。

**第三层：TemplateTable + DispatchTable——202 个 template 的二维矩阵**

`TemplateTable` 用 5 个 `def()` 重载（`templateTable.hpp:332-337`）注册每个字节码的 template——`def(Bytecodes::_iload, flags, itos, vtos, generator, arg)`。`templateTable_init()` 在 `interpreter_init()` 中被调——遍历所有 bytecode，调用 generator 生成机器码，填入 `DispatchTable`。

`DispatchTable`（`templateInterpreter.hpp:65`）是 `_table[TosState][bytecode_index]` 二维数组——每种 TOS 状态配合每种 bytecode 都有自己的 template 地址。正常执行用 `_active_table`，safepoint 请求时 `_active_table` 原子切换到 `_safept_table`——safept table 的 template 末尾多了一条 polling 指令。单个 `Atomic::store` 切换，不需每个字节码执行完都检查 safepoint flag。

**第四层：TOS 缓存——跳过栈操作的优化**

`TosState` 枚举（9 种值：`vtos` 空/`itos` int/`atos` object/`ltos` long 等）让模板解释器消除 push/pop。`iload_0` → `itos`（int 在栈顶）、`iadd` → `itos,itos→itos`（期望两个 int 在栈顶、产出一个 int）。如果前一个 template 输出的 TOS 状态和后一个期望的输入状态匹配——不需要内存栈 push/pop。template 之间通过 CPU 寄存器传递栈顶值——比 switch 解释器快 2-3 倍的核心原因。

**第五层：InvocationCounter——解释器和 JIT 的连接点**

`InvocationCounter`（`invocationCounter.hpp:40`）每个 Method 有两个：`_invocation_counter`（方法调用次数）+ `_backedge_counter`（循环回边次数）。每次 template 执行完 `invocation_counter++`，超过 `CompileThreshold` 时调 `InterpreterRuntime::frequency_counter_overflow()`——把方法提交给 `CompileBroker` 排队 JIT 编译。编译完成后 Method 的 `_from_interpreted_entry` 被更新为编译入口——下次调用直接进 JIT，不走解释器。

**第六层：template 生成的生命周期**

`TemplateInterpreterGenerator::generate_all()` 遍历所有 bytecode，对每个调 `Template::generate()` → `MacroAssembler` 生成机器码 → 写入 `CodeBuffer` → `StubCodeGenerator` 析构时 `flush` 到 CodeCache（`SECT_STUBS` section）。GC 屏障通过 template generator 的 `to_interp`/`to_compiled` 模式注入——`putfield` 的 template 在 G1 下生成 card mark 写屏障（`g1_write_barrier_post`），在 Serial GC 下无屏障。

**设计权衡**

一、dispatch table 二维数组 vs 间接跳转。每种 TOS 状态配每种 bytecode 需要 9×202=1818 个 template——但大部分 bytecode 只支持一两种 TOS 输入（`iload` 只需要 `vtos→itos`）。用 `def()` 的重载参数类型区分哪些 TOS 状态需要自己的 template。

二、原子 dispatch table 切换 vs per-bytecode safepoint check。全局切换省掉了每条 template 末尾的 `if (safepoint_requested) ...`——一个 `Atomic::store` 搞定。代价是两套 table 占用双倍内存（但 template 本身只存地址，每个 entry 8 字节 × 1818 ≈ 14KB × 2 = 28KB——可忽略）。

## 核心悬念

**解释执行不是 C++ 在 if-else 判断 opcode——是 202 个预生成机器码 template 在 CPU 上互相跳转，TOS 缓存让它们通过寄存器传值而不是内存栈 push/pop。**

**→ 下一域**：解释器在执行 `invokevirtual` 时怎么知道是 `Dog.speak()` 还是 `Cat.speak()`——vtable O(1) 定位 + Inline Cache 消除 99% 的虚调用开销。VTable 篇见。

## 预估

1 篇，6 层递进，预估 2500-3200 行。
