# Interpreter — Pass 0+1 探索笔记

> vol-04 · 域 23 · 🔴 A | 2026-08-07

## Pass 0: 设计上下文

**关键 git 提交**：
- `6fe9839d40` JDK-8227338: `copy_table()` 不安全——dispatch table 拷贝没考虑到并发切换
- `e221522f10` JDK-8227117: single stepping 后 normal table 没有恢复——safepoint/dispatch table 交互 bug
- `1a1303e1a6` JDK-8203188: Zero 解释器添加 JEP-181 支持（Nest-based access control）
- `23c15b8f4c` JDK-8148871: deopt point 处表达式栈深度错误——解释器帧重建 bug

**演进趋势**：模板解释器本身稳定（x86 的 template 生成逻辑很少变），bug 集中在 dispatch table 切换（safepoint/normal 之间的原子切换）、与 JIT 的交互（deopt 帧重建）、以及 Zero 端口的兼容性。

## Pass 1: 结构扫描

### 包结构
```
share/interpreter/
  abstractInterpreter.hpp/cpp  — 抽象解释器基类（模板+C++ 双实现的共同接口）
  templateInterpreter.hpp/cpp  — 模板解释器（x86 主用）
  templateTable.hpp/cpp        — TemplateTable（202 个 template 注册表）
  bytecodes.hpp/cpp            — Bytecodes 枚举（200+ 字节码）
  invocationCounter.hpp        — 调用计数器（触发 JIT 编译的阈值）
  linkResolver.hpp/cpp         — 方法/字段解析（已归 ClassFile 域）
  bytecodeInterpreter.hpp/cpp  — C++ 解释器（Zero 端口用，3503 行）
  cppInterpreter.hpp/cpp       — C++ 解释器生成器

cpu/x86/
  templateInterpreterGenerator_x86.cpp — x86 平台 Template 机器码生成
  templateTable_x86.cpp                — x86 平台 TemplateTable 实现
```

### 架构图
```
init_globals() (init.cpp:116)
  └─ interpreter_init()
      └─ TemplateInterpreter::initialize()
          └─ TemplateInterpreterGenerator::generate_all()
              └─ 对每个 Template: generate() → MacroAssembler → CodeBuffer → CodeCache

运行时:
  Java method 第一次被调 → interpreter_entry
    └─ DispatchTable::table_for(tos)
        └─ _active_table[bytecode_index] → 跳转到对应 template 的机器码
            └─ 每执行完一个 template → 读下一个 bytecode → 再 dispatch
                └─ invocationCounter++ → 超过阈值 → JIT 编译
```

### 基本元素分解

1. **Template**：`Template`（`templateTable.hpp:44`）— 一个字节码的实现配方。`_flags`（uses_bcp/does_dispatch/calls_vm/is_wide）、`_tos_in/_tos_out`（TOS 缓存状态）、`generate()`（用 MacroAssembler 生成机器码）。

2. **TemplateInterpreter**：继承 `AbstractInterpreter`（`templateInterpreter.hpp:85`）。持有 `_active_table` / `_normal_table` / `_safept_table` 三张分发表。`initialize()` 调用 `TemplateInterpreterGenerator::generate_all()` 为所有 bytecode 生成 template。

3. **DispatchTable**：`DispatchTable`（`:65`）— `_table[TosState][bytecode_index]` 二维数组。`_active_table` 在正常执行和 safepoint 之间原子切换——不需要每个字节码执行时检查 safepoint flag。

4. **InvocationCounter**：`InvocationCounter`（`invocationCounter.hpp:40`）— 每个 Method 有两个计数器：`_invocation_counter`（方法调用次数）+ `_backedge_counter`（循环回边次数）。超过 `CompileThreshold` 触发 JIT 编译——这是解释器和 JIT 的连接点。

5. **TOS 缓存**：TosState 枚举（`itos/atos/vtos/ltos/ftos/dtos/btos/ztos`）— 模板解释器用栈顶缓存避免 push/pop。`iload_0` → `itos`（int 在栈顶），`iadd` → `itos,itos→itos`（期望两个 int 在栈顶）。如果 TOS 状态一致——跳过内存栈操作。

6. **AbstractInterpreter**：基类。定义 `MethodKind` 枚举（zerolocals/synchronized/native 等），`entry_point()` 根据方法类型返回不同入口（普通入口/synchronized 入口/native 入口）。

7. **CppInterpreter**（Zero 端口）：纯 C++ switch-case 字节码解释器（`bytecodeInterpreter.cpp:3503`）。本例剪版不编译——但抽象层代码存在（`bytecodeInterpreter.hpp/cpp`）。

### 标记问题（≥5）

1. **_active_table 和 _safept_table 怎么原子切换？** safepoint 请求时，所有线程都需要立即切换到 `_safept_table`。切换操作本身需要是原子的——用的是 `Atomic::store()` 还是 `OrderAccess::release_store()`？旧的 `_normal_table` 怎么处理？

2. **TOS 缓存的状态机有多少种组合？** `TosState` 有 9 种值（vtos/itos/atos/ltos/ftos/dtos/btos/ztos + 组合状态），`DispatchTable` 的 `_table[TosState][bytecode_index]` 意味着每种 TOS 状态 + 每种 bytecode 都有对应的 template——202×9 = 1818 个 entry？

3. **invocationCounter 怎么触发 JIT 编译？** `InterpreterRuntime::frequency_counter_overflow()` 在 counter 超过阈值时被调——具体怎么决定编译？C1 和 C2 的阈值不同吗——`TieredCompilation` 下有几套阈值？

4. **template 生成的机器码存在 CodeCache 的哪个 section？** `SECT_STUBS` 还是有自己的 section？Template 和 JIT 编译后的 nmethod 共享 CodeCache 吗？

5. **deopt 时怎么从编译帧重建解释器帧？** JDK-8148871——表达式栈深度错误意味着 template 执行到一半时 deopt，需要精确还原 template 执行前的字节码位置和栈状态。

6. **GC 屏障在解释器中怎么注入？** JDK-8199417——模板解释器如何为 `putfield`/`aastore` 等写操作注入 GC barrier？Template 生成时根据当前 GC 类型选择不同的 `generate()` 路径？

7. **dispatch table 跳转的性能开销是多少？** 每个字节码执行完都要 `_active_table[bytecode][tos]` → `jmp`——两次间接跳转。CPU 的分支预测器对间接跳转支持如何？`does_dispatch` flag 为 false 的 template 怎么链式执行节省 dispatch 开销？
