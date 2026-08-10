# PROMPT: 请撰写 14-Interpreter-Bytecodes-TemplateTable.md

## §〇 Production Scenario

### 场景 1: 方法首次调用触发解释器执行

```java
// HotSpot 如何执行 add(1, 2)？
public int add(int a, int b) { return a + b; }
```

`add()` 第一次被调用时，`Method::link_method()`（`method.cpp:1084`）设置 `_from_interpreted_entry = Interpreter::entry_for_method(h_method)`。该入口指向 `TemplateInterpreterGenerator::generate_normal_entry()` 生成的 codelet。进入解释器后，`set_entry_points_for_all_bytes()` 遍历 `Bytecodes::flags()` 表，为 `iload_0`、`iload_1`、`iadd`、`ireturn` 这 4 个字节码找到对应的 codelet 地址，分派到 `TemplateTable::generate()` 生成的机器码模板。整个过程：`method entry codelet → dispatch loop → iload_0 codelet → iload_1 codelet → iadd codelet → ireturn codelet → return entry codelet`。

**三步诊断**：
```bash
# 1. 验证解释器 codelet 已生成
gdb -ex "break templateInterpreterGenerator.cpp:57" \
    -ex "run" \
    -ex "print AbstractInterpreter::code()->number_of_stubs()" \
    --args java -cp app.jar Main
# 期望: >200（所有字节码 codelet + 方法入口 + 返回入口）

# 2. 验证字节码属性表已填充
gdb -ex "break bytecodes.cpp:561" \
    -ex "run" \
    -ex "print Bytecodes::length_for(Bytecodes::_iload)" \
    -ex "print Bytecodes::depth(Bytecodes::_iadd)" \
    --args java -jar app.jar
# 期望: length=2, depth=-1

# 3. strace 验证解释器生成期间的系统调用
strace -e mmap,mprotect -f java -Xint -jar app.jar 2>&1 | head -20
# 期望: 解释器 codelet 生成期间的 mmap（CodeCache 分配）+ mprotect（RW→RX）
```

**反事实**：如果解释器使用 switch-case 分派而非 codelet 模板 → 每个字节码的执行都经过相同的 C++ switch → CPU 分支预测器被 256 个 case 淹没 → 分支预测失败率 ~50%（每 2 条字节码 1 次 mispredict）→ 每次 mispredict ~20 CPU cycles → 简单方法 4 字节码 × 20 cycles = 80 cycles 额外开销。Codelet 模板通过直接跳转（间接跳转到 codelet 地址）消除 switch-case，分支预测失败率 ~0%。

### 场景 2: `DelayCompilationDuringStartup` 导致方法永远不被编译

```bash
java -XX:+PrintCompilation -jar app.jar
# 输出中前 60 秒无任何编译事件 → 怀疑 DelayCompilationDuringStartup
```

`invocationCounter_init()`（`init.cpp:148`）调用 `InvocationCounter::reinitialize(DelayCompilationDuringStartup)`。当 `DelayCompilationDuringStartup=true`（默认），`wait_for_compile` 状态的 action 设为 `do_decay`（计数减半而非触发编译）。`do_decay()`（`invocationCounter.cpp:122-138`）每次溢出时将计数右移 1 位（除以 2）并保持至少为 1——方法永远无法达到编译阈值，因为每次溢出后计数减半。

**三步诊断**：
```bash
# 1. 检查 DelayCompilationDuringStartup 标志
java -XX:+PrintFlagsFinal -version 2>&1 | rg DelayCompilationDuringStartup
# 期望: DelayCompilationDuringStartup = true

# 2. 验证 do_decay 在生效
gdb -ex "break invocationCounter.cpp:122" \
    -ex "run" \
    -ex "print this->_counter" \
    --args java -jar app.jar
# 期望: 计数每次溢出后减半

# 3. 禁用后重新运行
java -XX:-DelayCompilationDuringStartup -XX:+PrintCompilation -jar app.jar
# 期望: 编译事件正常出现
```

**反事实**：如果不使用 do_decay 而直接触发编译 → JVM 启动后的前 10 秒内，数百个方法同时达到 CompileThreshold → 编译队列爆满 → 编译器线程（C1/C2）竞争 CPU → 启动延迟增加 ~2-5 秒。`do_decay` 将编译请求分散到启动后更长时间窗口，平滑 CPU 负载。

### 场景 3: `_fast_agetfield` 重写后的字节码在 SA 中显示为 "unknown"

`jcmd <pid> Compiler.CodeList` 显示方法的字节码中有 `_fast_agetfield`（opcode 247），但 class 文件中只有 `getfield`（opcode 180）。这是因为 `Rewriter::scan_method()`（`rewriter.cpp:370`）在类加载时使用 `Bytecodes::length_for()` 和 `Bytecodes::java_code()` 将 `getfield` 重写为 `_fast_agetfield`。`_fast_agetfield` 的 `java_code = _getfield`，但 `_name = "_fast_agetfield"`——调试工具需要同时理解这两种表示。

---

## §一 Task + Narrative + Beginner Callouts

### Task

Reading this prompt, you will produce a document that traces the SEVEN init_globals() calls that build the JVM's interpreter infrastructure. These calls collectively create the bytecode property tables (256 entries × 6 arrays), the template interpreter codelets (hundreds of assembly stubs in CodeCache), the bytecode template dispatch table (2 × 256 Template objects), the invocation counter state machine (CompileThreshold × 3 variants), and the VM register name mapping (569 entries):

- `bytecodes_init()` — 256 bytecode property tables (line 120)
- `interpreter_init()` — template interpreter codelets + StubQueue (line 145)
- `invocationCounter_init()` — CompileThreshold + OSR threshold + state machine (line 148)
- `accessFlags_init()` — sizeof assertion (line 149)
- `templateTable_init()` — 2 × 256 Template dispatch table (line 150)
- `InterfaceSupport_init()` — ASSERT: GC stress test seed (line 151)
- `VMRegImpl::set_regName()` — 569 register name entries (line 152)

Reader completed **01-CodeCache** (where interpreter codelets live), **13-Management-Services** (init_globals call sequence), **16-Universe-Post-Init** (type system that interpreter dispatches on). This doc: **how the JVM transforms 256 Java bytecode opcodes into executable machine code templates, computes method invocation thresholds, and maps x86 registers to VM register slots — the complete interpreter infrastructure that executes every Java method before JIT compilation**.

### Interview Story Format Answer（必须出现在 §一 末尾）

"`init_globals()` at `init.cpp:109` has 7 interpreter-related calls between `universe2_init()` (line 157) and `javaClasses_init()` (line 161). `bytecodes_init()` at `bytecodes.cpp:561` calls `Bytecodes::initialize()` (293 lines, bytecodes.cpp:268-560) which calls `def()` ~200 times to fill 6 static arrays: `_name[]` (opcode name strings), `_result_type[]` (TOS type after execution, e.g. T_INT for iload), `_depth[]` (stack depth change, e.g. -1 for iadd which pops 2 and pushes 1), `_lengths[]` (encoded as `(wide_len << 4) | len`, e.g. `(2 << 4) | 1 = 33` for iload), `_java_code[]` (maps HotSpot internal bytecodes like `_fast_agetfield` back to standard `_getfield`), and `_flags[]` (512 entries — 256 normal + 256 wide — each computed by `compute_flags()` from the format string like `"bi"` = byte + index). `interpreter_init()` at `interpreter.cpp:116` calls `TemplateInterpreter::initialize()` (templateInterpreter.cpp:42) which: (1) creates a `StubQueue` backed by `BufferBlob::create("Interpreter", code_size)` — the entire interpreter code lives in CodeCache as a BufferBlob; (2) constructs `TemplateInterpreterGenerator` whose `generate_all()` produces hundreds of codelets via `CodeletMark` RAII commit — method entry points, return entry points for all 10 TosStates, exception throwers, safepoint entries, deoptimization entries, and 256 bytecode-specific codelets; (3) calls `TemplateTable::initialize()` (288 lines, templateTable.cpp:244-531) which `def()`s 256 Template objects with flags (`ubcp` = uses bytecode pointer, `disp` = self-dispatch, `clvm` = calls VM), TosState transitions (vtos→itos for iload), and generator function pointers. `invocationCounter_init()` at `invocationCounter.cpp:201` calls `InvocationCounter::reinitialize(DelayCompilationDuringStartup)` (47 lines, :153-199) which defines a 2-state machine: `wait_for_nothing` → `do_nothing`, `wait_for_compile` → `do_decay` (startup) or `dummy_invocation_counter_overflow` (steady-state). It computes `InterpreterInvocationLimit = CompileThreshold << 3` (aligned to 3 non-count bits in the 32-bit counter), `InterpreterProfileLimit` (33% of CompileThreshold for profiling), and `InterpreterBackwardBranchLimit` (933% of CompileThreshold for OSR). `templateTable_init()` is a separate explicit call at line 150 — the Template objects describe what each bytecode needs (bcp access, VM calls, dispatch behavior) but the actual machine code is generated during `interpreter_init()`. `VMRegImpl::set_regName()` at `vmreg_x86.cpp:31` (38 lines) fills the 569-entry `regName[]` array by iterating GPR (32 slots on AMD64 — 16 registers × 2 slots each), FPR (16 slots — 8 x87 × 2), XMM (512 slots — 32 registers × 16 sub-slots for ZMM), KREG (8 slots — 8 mask registers × 1), plus 1 for EFLAGS. The key architectural insight: the interpreter infrastructure is split into DATA (bytecode properties + template descriptors + register names — populated in 6 of the 7 calls) and CODE (machine code codelets in CodeCache — populated in interpreter_init only). The data tables are queried at EXTREMELY high frequency: `Bytecodes::length_for()` has 15 direct callers across class loading, verification, C1/C2 compilation, OopMap generation, and bytecode rewriting — every bytecode parse in the JVM depends on these tables."

### Beginner Callout Boxes（文档中必须出现的 7 个 callout 框）

1. **Bytecodes 属性表 vs Template 表**: `Bytecodes::initialize()` 构建的是**静态属性表**（字节码名称、栈深度、结果类型、长度、标志位）——纯数据，不依赖 CPU 架构。`TemplateTable::initialize()` 构建的是**代码生成描述符**（Template 对象）——每个 Template 包含 TosState 转换 + 生成器函数指针 + 标志位（ubcp/disp/clvm），描述"如何为这个字节码生成机器码"。前者被 C1/C2/验证器/OopMap 使用，后者只被模板解释器生成器使用。

2. **StubQueue 在 CodeCache 中**: `TemplateInterpreter::initialize()` 创建 `StubQueue("Interpreter", code_size)`，其构造函数（`stubs.cpp:67-81`）调用 `BufferBlob::create()` —— 在 CodeCache 的 NonNMethod 区域分配。解释器的所有 codelet 与 JIT 编译的 nmethod 共享 CodeCache 空间。`codeCache_init()` (init.cpp:127) 在 `interpreter_init()` (init.cpp:145) 之前执行——CodeCache 必须先分配，解释器才能在其中生成代码。

3. **CodeletMark 的 RAII commit**: `CodeletMark` 是一个 RAII 类（`interpreter.hpp:84-106`）：构造时记录 `_masm` 的当前 `pc()` 位置，析构时调用 `AbstractInterpreter::code()->commit()` 将生成的机器码提交到 StubQueue。`StubQueue::commit()` (stubs.cpp:158) 计算 `committed_size = align_up(code_size, CodeEntryAlignment)`，调用 `stub_initialize()` 设置 stub 元数据，推进 `_queue_end` 指针，递增 `_number_of_stubs`。CodeletMark 是 Codelet 生成的"事务边界"——构造和析构之间生成的代码作为一个原子单元提交。

4. **_counter 的 32-bit 位布局**: `InvocationCounter::_counter` 是一个 32-bit int，布局为 `| count (29 bits) | carry (1 bit) | state (2 bits) |`。计数增量为 `count_grain = 8`（右移 3 位对齐），`CompileThreshold = 10000` 对应 `_counter = 80000`。carry 位是粘性进位（计数曾达上限后永久置位）。state 位编码 `wait_for_nothing(0)` 或 `wait_for_compile(1)`。这种紧凑布局允许用单个 32-bit CAS 原子操作更新计数+状态——无锁设计。

5. **TosState 的栈顶缓存**: 模板解释器使用 TosState 跟踪当前栈顶值的类型和位置（在寄存器中而非内存中）。`vtos` = 栈顶值未缓存（在内存中），`itos` = 栈顶 int 在寄存器中，`atos` = 栈顶引用在寄存器中。字节码模板通过 TosState 转换消除不必要的 push/pop：`iload (vtos→itos)` 从局部变量加载 int 到寄存器，`iadd (itos→itos)` 直接在寄存器中执行加法，`ireturn (itos→vtos)` 将寄存器值写回调用者。这是解释器性能优化的核心——避免内存往返。

6. **`_flags[]` 的 512 条目设计**: `_flags` 数组有 512 个 int（2048 字节），而非 256 个。前 256 个条目对应普通字节码（`flags(code)`），后 256 个对应 wide 变体（`flags(code + 256)`）。`compute_flags()` 解析 format 字符串（如 `"bi"` = byte + index, `"wbii"` = wide byte + wide index），生成标志位：`_fmt_has_j` (本地字节序索引), `_fmt_has_k` (Java 字节序索引), `_fmt_has_nbo` (网络字节序), `_fmt_not_variable` (固定长度) 等。wide 变体的 format 独立定义——有些字节码无 wide 形式（`aload_0` 的 wide_format = NULL）。

7. **VMReg 到 x86 物理寄存器的映射**: `VMRegImpl::set_regName()` 填充的 `regName[]` 数组映射 VM 寄存器号到字符串名称。AMD64 下 569 个条目：32 个 GPR 槽位（rax[0], rax[1], rcx[0], rcx[1], ...——每个 64-bit 寄存器占 2 个 VMReg slot，允许 32-bit 子视图），16 个 FPR 槽位（st0~st7 × 2），512 个 XMM 槽位（xmm0~xmm31 × 16，对应 512-bit ZMM 的 16 个 32-bit 子槽），8 个 KREG 槽位（k0~k7 × 1），1 个 EFLAGS。这是 C2 寄存器分配器 + SA 代理 + OopMap 打印的基础设施。

---

## §二 Standard Environment

OpenJDK 11 slowdebug, 64-bit Linux.

Source roots:
- `src/hotspot/share/interpreter/bytecodes.cpp` — Bytecodes::initialize() (:268)
- `src/hotspot/share/interpreter/bytecodes.hpp` — Bytecodes 类 + Code 枚举
- `src/hotspot/share/interpreter/interpreter.cpp` — interpreter_init() (:116)
- `src/hotspot/share/interpreter/templateInterpreter.cpp` — TemplateInterpreter::initialize() (:42)
- `src/hotspot/share/interpreter/templateInterpreterGenerator.cpp` — generate_all() (:57)
- `src/hotspot/share/interpreter/templateTable.cpp` — TemplateTable::initialize() (:244)
- `src/hotspot/share/interpreter/templateTable.hpp` — Template 类 + TemplateTable 类
- `src/hotspot/cpu/x86/templateTable_x86.cpp` — pd_initialize() (:50)
- `src/hotspot/share/interpreter/invocationCounter.cpp` — InvocationCounter::reinitialize() (:153)
- `src/hotspot/share/interpreter/abstractInterpreter.cpp` — AbstractInterpreter::initialize() (:55)
- `src/hotspot/share/interpreter/abstractInterpreter.hpp` — _code (StubQueue*), _entry_table[]
- `src/hotspot/share/code/stubs.cpp` — StubQueue 构造函数 (:67), commit() (:158)
- `src/hotspot/cpu/x86/vmreg_x86.cpp` — VMRegImpl::set_regName() (:31)
- `src/hotspot/share/utilities/accessFlags.cpp` — accessFlags_init() (:74)
- `src/hotspot/share/runtime/interfaceSupport.cpp` — InterfaceSupport_init() (:264)

Build: `make jdk`

Key binary: `build/linux-x86_64-normal-server-slowdebug/jdk/lib/libjvm.so`

**Syscall 速查**：

| Syscall | man | 用途 |
|---------|-----|------|
| `mmap` | man 2 mmap | CodeCache VirtualSpace 分配（解释器 StubQueue 底层） |
| `mprotect` | man 2 mprotect | CodeCache 内存保护切换（RW → RX 执行） |
| `clock_gettime` | man 2 clock_gettime | `os::javaTimeNanos()` — InvocationCounter 可能使用的时间源 |

**全局状态速查**：

| 变量 | 类型 | 大小 | 存储 | 说明 |
|------|------|------|------|------|
| `Bytecodes::_name[256]` | `const char*[]` | 2048B | BSS | 字节码名称字符串 |
| `Bytecodes::_flags[512]` | `int[]` | 2048B | BSS | 格式标志位（256 普通 + 256 wide） |
| `Bytecodes::_depth[256]` | `int[]` | 1024B | BSS | 栈深度变化 |
| `Bytecodes::_lengths[256]` | `int[]` | 1024B | BSS | 编码的字节码长度 |
| `Bytecodes::_result_type[256]` | `BasicType[]` | 1024B | BSS | 执行后 TOS 类型 |
| `Bytecodes::_java_code[256]` | `Code[]` | 1024B | BSS | 映射到标准 Java 字节码 |
| `AbstractInterpreter::_code` | `StubQueue*` | ~256KB | CodeCache | 解释器 codelet 缓冲区 |
| `TemplateTable::_template_table[256]` | `Template[]` | ~8KB | BSS | 普通字节码模板 |
| `TemplateTable::_template_table_wide[256]` | `Template[]` | ~8KB | BSS | wide 字节码模板 |
| `VMRegImpl::regName[569]` | `const char*[]` | 4552B | BSS | x86 寄存器名称映射 |

---

## §三 Source Files Table

| # | File | Full Path | Lines | Core Functions | Role |
|---|------|-----------|:--:|-------|------|
| 1 | **bytecodes.cpp** | `src/hotspot/share/interpreter/bytecodes.cpp` | 568 | `Bytecodes::initialize()`(:268), `def()`(:152/157), `compute_flags()`(:196) | 字节码属性表构建 |
| 2 | **bytecodes.hpp** | `src/hotspot/share/interpreter/bytecodes.hpp` | 500+ | Code 枚举, `length_for()`, `depth()`, `flags()`, `result_type()` | 字节码属性查询 API |
| 3 | **interpreter.cpp** | `src/hotspot/share/interpreter/interpreter.cpp` | 138 | `interpreter_init()`(:116), `CodeletMark` 类 | 解释器初始化入口 |
| 4 | **templateInterpreter.cpp** | `src/hotspot/share/interpreter/templateInterpreter.cpp` | 73 | `TemplateInterpreter::initialize()`(:42) | 模板解释器主入口 |
| 5 | **templateInterpreterGenerator.cpp** | `src/hotspot/share/interpreter/templateInterpreterGenerator.cpp` | ~500 | `generate_all()`(:57), `set_entry_points_for_all_bytes()`(:276) | Codelet 生成器 |
| 6 | **templateTable.cpp** | `src/hotspot/share/interpreter/templateTable.cpp` | 555 | `TemplateTable::initialize()`(:244), `def()`(:180-221) | Template 分发表初始化 |
| 7 | **templateTable.hpp** | `src/hotspot/share/interpreter/templateTable.hpp` | 359 | `Template` 类(:44), `TemplateTable` 类(:81) | Template 结构定义 |
| 8 | **templateTable_x86.cpp** | `src/hotspot/cpu/x86/templateTable_x86.cpp` | 4525 | `pd_initialize()`(:50), 各字节码的 generate 方法 | x86 字节码模板实现 |
| 9 | **invocationCounter.cpp** | `src/hotspot/share/interpreter/invocationCounter.cpp` | 207 | `InvocationCounter::reinitialize()`(:153), `do_decay()`(:122) | 调用计数器状态机 |
| 10 | **abstractInterpreter.cpp** | `src/hotspot/share/interpreter/abstractInterpreter.cpp` | ~500 | `AbstractInterpreter::initialize()`(:55), `set_entry_for_kind()`(:232) | 解释器基类 |
| 11 | **abstractInterpreter.hpp** | `src/hotspot/share/interpreter/abstractInterpreter.hpp` | 336 | `_code`(:109), `_entry_table[]`, MethodKind 枚举 | 解释器抽象接口 |
| 12 | **stubs.cpp** | `src/hotspot/share/code/stubs.cpp` | ~200 | `StubQueue` 构造函数(:67), `commit()`(:158) | StubQueue 实现 |
| 13 | **vmreg_x86.cpp** | `src/hotspot/cpu/x86/vmreg_x86.cpp` | 68 | `VMRegImpl::set_regName()`(:31) | x86 寄存器名映射 |
| 14 | **accessFlags.cpp** | `src/hotspot/share/utilities/accessFlags.cpp` | 76 | `accessFlags_init()`(:74) | sizeof 断言 |
| 15 | **interfaceSupport.cpp** | `src/hotspot/share/runtime/interfaceSupport.cpp` | 307 | `InterfaceSupport_init()`(:264) | GC 压力测试种子 |

---

## §四 Deep Dive Question Groups（≥6 组，每组含 counterfactual）

### 4.1 ★★★ Bytecodes::initialize() — 256 字节码 × 6 个属性数组

```
问题：
  ① Bytecodes::initialize() (bytecodes.cpp:268-560, 293 行) 如何通过 def() 构建 6 个属性数组？
      答案方向: 源码展示 def() 的 7 参数核心重载（:157-194）：
        void Bytecodes::def(Code code, const char* name, const char* format,
                            const char* wide_format, BasicType result_type,
                            int depth, bool can_trap, Code java_code) {
          int len = (format != NULL ? (int)strlen(format) : 0);
          int wlen = (wide_format != NULL ? (int)strlen(wide_format) : 0);
          _name[code]        = name;
          _result_type[code] = result_type;
          _depth[code]       = depth;
          _lengths[code]     = (wlen << 4) | (len & 0xF);
          _java_code[code]   = java_code;
          int bc_flags = 0;
          if (can_trap) bc_flags |= _bc_can_trap;
          if (java_code != code) bc_flags |= _bc_can_rewrite;
          _flags[code]       = compute_flags(format,      bc_flags);
          _flags[code + 256] = compute_flags(wide_format, bc_flags);
        }
      
      然后 :345-545 约 200 次 def() 调用覆盖所有 JVM 规范字节码 + HotSpot 内部字节码。
      compute_flags() (:196-265) 解析 format 字符串的每个字符：
        'b' → _fmt_not_variable（字节码本身占 1 字节）
        'w' → _fmt_not_variable | _fmt_not_simple（wide 前缀）
        'j' → _fmt_has_j（本地字节序无符号索引，连续 jj→_fmt_has_u2，jjjj→_fmt_has_u4）
        'k' → _fmt_has_k（Java 字节序无符号索引）
        'o' → _fmt_has_o（Java 字节序分支偏移）
        'c' → _fmt_has_c（有符号常量）
        ''（空串）→ _fmt_not_simple（变长字节码，如 tableswitch）
        NULL → _fmt_not_simple（无此形式）
      
      追问: _lengths 的编码 (wlen << 4) | (len & 0xF) 为什么限制为 15 字节？
      → 低 4 位存普通长度，高 4 位存 wide 长度。15 字节是 JVM 规范定义的最大字节码长度
        （事实上没有超过 5 字节的字节码：goto_w 5 字节 = opcode + 4 字节偏移）。

  ② Counterfactual: 如果字节码属性不是静态表而是每个 Method 内联存储？
      答案方向: 每个 Method 对象需要额外的 256 × (1 + 4 + 4 + 4 + 4 + 4) ≈ 5KB 属性数据
      → 10000 个方法 = 50MB 额外开销。静态表 14KB 被所有方法共享 → 空间效率 3500×。
      而且 Method 内联存储需要在类加载时复制属性 → 延长类加载时间。
```

### 4.2 ★★★ TemplateInterpreter::initialize() — StubQueue + Codelet 生成

```
问题：
  ① TemplateInterpreter::initialize() (templateInterpreter.cpp:42-73) 如何创建解释器代码？
      答案方向: 源码展示 4 步流程：
        Step 1 (:48): AbstractInterpreter::initialize() → 重置计数器 + InvocationCounter::reinitialize
        Step 2 (:57-58): _code = new StubQueue(InterpreterCodeletInterface, code_size, NULL, "Interpreter")
          StubQueue 构造函数 (stubs.cpp:67-81):
            BufferBlob* blob = BufferBlob::create(name, size)  // 在 CodeCache 中分配!
            _stub_buffer = blob->content_begin()
            _queue_begin = 0, _queue_end = 0, _number_of_stubs = 0
        Step 3 (:59): TemplateInterpreterGenerator g(_code) → generate_all()
          生成: 方法入口 (10 TosState × 多种入口) + 返回入口 (10 TosState) +
                异常抛出器 + 安全点入口 + 去优化入口 + 256 字节码 codelet
        Step 4 (:61): _code->deallocate_unused_tail() → CodeCache::free_unused_tail()
      
      追问: 为什么 StubQueue 需要 deallocate_unused_tail？
      → 初始 code_size 是预估的（~256KB），实际生成的 codelet 可能少于此值。
        未使用的尾部空间归还 CodeCache → JIT 编译器可使用更多空间。

  ② Counterfactual: 如果解释器不使用模板而使用 switch-case 分派？
      答案方向: 参见 §〇 场景 1 的反事实——CPU 分支预测器被 256 个 case 淹没。
      补充: switch-case 还需要在每次字节码执行后跳回主循环（1 次间接跳转），
      而 codelet 模板通过在每个 codelet 末尾直接嵌入下一个字节码的跳转地址
      （dispatch table 查表 + 间接跳转）实现 0-额外跳转开销的连续执行。
```

### 4.3 ★★★ TemplateTable::initialize() — Template 描述符

```
问题：
  ① TemplateTable::initialize() (templateTable.cpp:244-531, 288 行) 的 def() 如何描述一个字节码？
      答案方向: 源码展示 def() 的 7 参数核心重载（:186-200）：
        void TemplateTable::def(Bytecodes::Code code, int flags,
                                TosState in, TosState out, void (*gen)(int arg), int arg) {
          bool is_wide = (flags & iswd) != 0;
          Template* t = is_wide ? template_for_wide(code) : template_for(code);
          t->initialize(flags, in, out, gen, arg);
        }
      
      Template 的 flags 字段（templateTable.hpp:46-51）：
        bit 0: uses_bcp_bit — 需要 bcp 指向当前字节码（读操作数）
        bit 1: does_dispatch_bit — 模板自行分发（不需要主循环 dispatch）
        bit 2: calls_vm_bit — 模板调用 VM 运行时函数
        bit 3: wide_bit — 属于 wide 指令
      
      代表性示例：
        def(_iload,      ubcp|clvm, vtos, itos, iload,      _)  // 读 bcp + VM 调用
        def(_aload_0,    ubcp|clvm, vtos, atos, aload_0,    _)  // 可能触发重写
        def(_ifeq,       ubcp|clvm, itos, vtos, if_0cmp,    equal)
        def(_invokevirtual, ubcp|disp|clvm, vtos, vtos, invokevirtual, f2_byte)
        def(_return,     disp|clvm, vtos, vtos, _return,    vtos)  // 自行分发
        def(_goto,       ubcp|disp|clvm, vtos, vtos, _goto, _)
        def(_nop,        0,        vtos, vtos, nop,         _)      // 最简单
      
      追问: 为什么 invokevirtual 需要 disp 而 iload 不需要？
      → invokevirtual 的返回点在调用方法执行完毕后需要分发到调用方法的下一条字节码
        ——这是"自行分发"（self-dispatch），因为它不经过解释器主循环的字节码分派。
        iload 执行完毕后，控制流回到解释器主循环，由主循环分派到下一条字节码。

  ② Counterfactual: 如果 Template 描述符在每次 CodeCache 重建时重新计算？
      答案方向: Template 描述符本质是编译期常量——字节码的属性（是否读 bcp、是否调 VM、
        栈类型转换）不随 JVM 运行变化。TemplateTable::initialize() 在 init_globals 中
        只执行一次，Template 对象存储在静态 BSS 段。如果在每次 CodeCache 重建时重新计算
        → 每次 CDS 恢复或 CodeCache 扩容都需要重新遍历 256 个字节码 → 增加 ~1ms 启动延迟。
```

### 4.4 ★★★ InvocationCounter::reinitialize() — 编译阈值状态机

```
问题：
  ① InvocationCounter::reinitialize() (invocationCounter.cpp:153-199) 如何配置编译触发？
      答案方向: 源码展示：
        void InvocationCounter::reinitialize(bool delay_overflow) {
          InterpreterInvocationLimit = CompileThreshold << number_of_noncount_bits;  // :163
          InterpreterProfileLimit = ((CompileThreshold * InterpreterProfilePercentage) / 100)
                                    << number_of_noncount_bits;                       // :164
          if (ProfileInterpreter) {
            InterpreterBackwardBranchLimit = (CompileThreshold * 
              (OnStackReplacePercentage - InterpreterProfilePercentage)) / 100;      // :170
          } else {
            InterpreterBackwardBranchLimit = ((CompileThreshold * 
              OnStackReplacePercentage) / 100) << number_of_noncount_bits;           // :173
          }
          def(wait_for_nothing, 0, do_nothing);                                      // :156
          if (delay_overflow) {
            def(wait_for_compile, 0, do_decay);                                      // :158
          } else {
            def(wait_for_compile, 0, dummy_invocation_counter_overflow);             // :160
          }
        }
      
      number_of_noncount_bits = 3（_counter 位布局中 count 字段右移 3 位）。
      默认值: CompileThreshold=10000, InterpreterProfilePercentage=33, OnStackReplacePercentage=933。
      → InterpreterInvocationLimit = 80000（10000 << 3）
      → InterpreterProfileLimit = 26400（3300 << 3）
      → InterpreterBackwardBranchLimit = 90000（933*100 - 33*100）
      
      追问: 为什么 OSR 阈值（933%）远高于普通编译阈值（100%）？
      → 回边（backward branch）每次循环迭代都触发一次计数——一个循环 10000 次迭代
        产生 10000 次回边计数。普通方法调用每次调用才触发一次计数——一个方法调用
        10000 次才产生 10000 次计数。OSR 阈值需要 ~9× 基础阈值来补偿"循环迭代 > 方法调用"的频率差异。

  ② Counterfactual: 如果 DelayCompilationDuringStartup=false（do_decay 替换为直接触发编译）？
      答案方向: 参见 §〇 场景 2 的反事实——启动后 10 秒内数百个方法同时达到阈值 → 编译队列爆满。
      补充: do_decay 将计数减半后，下次溢出需要再翻倍 → 溢出间隔指数增长 → 自然形成
      "启动后 0→10s: 无编译, 10→30s: 低频编译, 30s+: 正常编译" 的分层启动策略。
```

### 4.5 ★★★ VMRegImpl::set_regName() — x86 寄存器名映射

```
问题：
  ① VMRegImpl::set_regName() (vmreg_x86.cpp:31-68) 如何构建 569 条目的寄存器名数组？
      答案方向: 源码展示 4 个 for 循环遍历 GPR → FPR → XMM → KREG：
        for (i = 0; i < ConcreteRegisterImpl::max_gpr; ) {
          regName[i++] = reg->name();
        #ifdef AMD64
          regName[i++] = reg->name();  // AMD64: 每个 GPR 占 2 个 VMReg slot
        #endif
          reg = reg->successor();
        }
        
        AMD64 下: max_gpr = 32, max_fpr = 48, max_xmm = 560, max_kpr = 568,
                  number_of_registers = 569（含 eflags）
        
        GPR (rax, rcx, rdx, rbx, rsp, rbp, rsi, rdi, r8~r15):
          每个 64-bit 寄存器占 2 个 VMReg slot → 16 × 2 = 32 条目
        FPR (st0~st7): 每个 80-bit x87 寄存器占 2 个 VMReg slot → 8 × 2 = 16 条目
        XMM (xmm0~xmm31): 每个 512-bit ZMM 寄存器占 16 个 VMReg slot → 32 × 16 = 512 条目
        KREG (k0~k7): 每个 64-bit 掩码寄存器占 1 个 VMReg slot → 8 × 1 = 8 条目
        EFLAGS: 1 个 VMReg slot
        
        剩余条目（如果 number_of_registers > max_kpr）填充 "NON-GPR-FPR-XMM-KREG"
      
      追问: 为什么 AMD64 下 GPR 占 2 个 VMReg slot？
      → C2 编译器使用 RegisterImpl::max_slots_per_register = 2，允许将 64-bit 寄存器
        拆分为两个 32-bit 视图。这对应 x86-64 的 REX 前缀机制——rax 的低 32 位是 eax。

  ② Counterfactual: 如果 regName 数组不存在，OopMap 打印用什么？
      答案方向: OopMap 存储的是 VMReg 编号（整数），没有名称数组时只能打印数字
      → 调试输出变为 "reg 42 = oop" 而非 "rdx = oop" → 可读性归零。
      SA 代理（Serviceability Agent）依赖 regName[] 解析 core dump 中的寄存器值。
```

### 4.6 ★★★ Bytecodes 属性查询 — 15+ 运行时调用者

```
问题：
  ① Bytecodes::length_for() 为什么有 15 个直接调用者？
      答案方向: 每个需要遍历字节码的子系统都需要知道每条指令的长度：
        - 类加载: Rewriter::scan_method() (:370) — 重写 getfield→_fast_agetfield 时需要跳过操作数
        - 验证: Verifier::verify_method() (:639) — 验证时需要知道字节码边界
        - OopMap: generateOopMap::mark_bbheaders_and_count_gc_points() (:410) — 计算 GC 安全点
        - C2: GraphKit::compute_stack_effects() (:1008) — 内联时需要栈帧影响
        - C1: LinearScan::check_stack_depth() (:2376) — 寄存器分配时需要栈深度
        - 字节码流: RawBytecodeStream::raw_next() — 每次 next() 调用 length_for
      
      追问: 为什么 length_for() 是 O(1) 查表而非计算？
      → 字节码长度不是数学公式——iload=2（opcode + index），iload_0=1（只有 opcode），
        tableswitch=可变（对齐填充 + 跳转表）。查表 O(1) 是最优方案。
        表在启动时一次性填充，运行时零开销。

  ② Counterfactual: 如果每个 Method 存储自己的字节码长度数组？
      答案方向: 每个 Method 额外 256 × 1B = 256B → 10000 方法 = 2.5MB。
        但最大问题是同步：如果 JVM 升级新增字节码 → 所有旧 Method 的数组长度不匹配
        → 需要重新遍历更新。静态表集中管理，升级只需改一个地方。
```

### 4.7 ★★★ 解释器 codelet 在 CodeCache 中的位置

```
问题：
  ① 解释器 codelet 在 CodeCache 的哪个 segment 中？
      答案方向: CodeCache 有三段：NonNMethod（存 stub/适配器/解释器）、Profiled（存 C1 编译的 nmethod）、
        NonProfiled（存 C2 编译的 nmethod）。解释器 codelet 在 NonNMethod segment 中。
        BufferBlob::create("Interpreter", code_size) → CodeCache::allocate(code_size, false)
        → 在 NonNMethodCodeHeap 中分配。与 01-CodeCache 文档的 NonNMethod segment 分析一致。
      
      追问: 解释器 codelet 和 JIT nmethod 在 CodeCache 中如何区分？
      → 解释器 codelet 是 BufferBlob 的一部分（CodeBlob 子类），nmethod 是另一个子类。
        CodeCache::blobs_do() 遍历所有 CodeBlob，通过 is_nmethod() / is_buffer_blob() 区分。
```

### 4.8 ★★★ accessFlags_init + InterfaceSupport_init + VMRegImpl — 轻量但关键

```
问题：
  ① 这三个轻量函数为什么不能省略？
      答案方向:
        accessFlags_init() — sizeof(AccessFlags) == sizeof(jint) 断言：如果 AccessFlags 类
        意外增加成员（如添加 _flags2），sizeof 从 4 变为 8 → 所有依赖 jint 大小的代码
        （如 class 文件解析中的 u4 读写）会静默错误。这个断言是编译期 + 运行期双重保险。
        
        InterfaceSupport_init() — ASSERT 下 srand(ScavengeALotInterval * FullGCALotInterval)：
        设置 GC 压力测试的随机种子为固定值，使 GC 触发模式可重现。仅在开发/测试构建中有效。
        
        VMRegImpl::set_regName() — 569 条目寄存器名映射：SA 代理（jhsdb, jmap, jstack 等
        core dump 分析工具）依赖 regName[] 解析寄存器值。没有这个数组，core dump 中
        的寄存器值只能显示为数字。

  ② Counterfactual: 如果 accessFlags_init 断言在 release 构建中被移除？
      答案方向: release 构建中 assert 被编译为空（NDEBUG 定义）。这意味着 sizeof 不一致
        的错误只在 debug 构建中被发现 → 可能进入生产环境。但 C++ ABI 保证 jint 是 4 字节
        ——只有类定义错误才会触发。实际风险极低。
```

---

## §五 Article Structure

```
§〇 生产场景
  ★ 场景 1: 方法首次调用触发解释器执行（method entry → dispatch → codelet 链）
  ★ 场景 2: DelayCompilationDuringStartup 导致方法永远不被编译（do_decay 循环）
  ★ 场景 3: _fast_agetfield 重写后 SA 显示 "unknown"（java_code 映射）
  每个场景: 真实症状 + 三步诊断 + 反事实讨论

§一 ★★★ Interpreter 初始化 7 调用全链路源码走读
  ❓ 这不是字节码教程 — 这是 JVM 如何构建解释器数据表 + 生成 256 codelet + 配置编译触发
  1.1 bytecodes_init() → Bytecodes::initialize() — def() × ~200 构建 6 个属性数组
  1.2 interpreter_init() → TemplateInterpreter::initialize() — StubQueue + generate_all()
  1.3 CodeletMark RAII commit — StubQueue::commit() 事务机制
  1.4 templateTable_init() → TemplateTable::initialize() — def() × 256 构建 Template 描述符
  1.5 invocationCounter_init() → InvocationCounter::reinitialize() — 2 状态 + 3 阈值
  1.6 VMRegImpl::set_regName() — 4 类寄存器遍历填充 569 条目
  1.7 轻量函数: accessFlags_init (assert), InterfaceSupport_init (srand)
  1.8 Bytecodes 属性查询的 15+ 运行时调用者（类加载/验证/C1/C2/OopMap）
  1.9 ★ Mermaid: Interpreter 初始化序列图
      Lanes: init_globals / Bytecodes / Interpreter / TemplateTable / InvocationCounter / CodeCache
  1.10 ★ 面试 Story Format 答案

§二 Standard Environment + 全局状态速查表 + syscall 速查表

§三 Source Files Table（15 个文件）

§四 ★★★ 7 Beginner Callout 框
  > **1. Bytecodes 属性表 vs Template 表**
  > **2. StubQueue 在 CodeCache 中**
  > **3. CodeletMark 的 RAII commit**
  > **4. _counter 的 32-bit 位布局**
  > **5. TosState 的栈顶缓存**
  > **6. _flags[] 的 512 条目设计**
  > **7. VMReg 到 x86 物理寄存器的映射**

§五 ★★★ 字节码属性表 + 编译阈值
  5.1 Bytecodes::def() 的两重重载 + compute_flags 格式字符串解析
  5.2 6 个属性数组的完整表（名称/深度/结果类型/长度/JavaCode/Flags）
  5.3 代表性字节码属性对比表（nop, iload, ifeq, invokevirtual, tableswitch）
  5.4 HotSpot 内部字节码的 _bc_can_rewrite 机制
  5.5 InvocationCounter 位布局 + CompileThreshold 计算
  5.6 do_decay vs do_nothing vs dummy_invocation_counter_overflow

§六 ★★★ 模板表 + Codelet 生成
  6.1 Template 类的 flags/TosState/generator 字段
  6.2 代表性 Template 定义对比表（iload, aload_0, ifeq, invokevirtual, goto, nop）
  6.3 TemplateInterpreterGenerator::generate_all() 生成的 codelet 分类
  6.4 CodeletMark → StubQueue::commit() 的完整流程
  6.5 StubQueue 在 CodeCache NonNMethod segment 中的位置

§七 ★★ 寄存器名映射 + 轻量函数
  7.1 VMRegImpl::set_regName() 4 类寄存器遍历
  7.2 ConcreteRegisterImpl 常量值表（AMD64 vs IA32）
  7.3 accessFlags_init 的 sizeof 断言设计意图
  7.4 InterfaceSupport_init 的 GC 压力测试种子

§八 ★ GDB 断点验证 — 8 断点
  断言 1: bytecodes.cpp:268 — 验证 Bytecodes::initialize 入口
  断言 2: bytecodes.cpp:157 — 验证 def() 填充 _name[iload]
  断言 3: templateInterpreter.cpp:58 — 验证 StubQueue 创建
  断言 4: templateTable.cpp:244 — 验证 TemplateTable::initialize 入口
  断言 5: invocationCounter.cpp:163 — 验证 InterpreterInvocationLimit 计算
  断言 6: vmreg_x86.cpp:33 — 验证 GPR 名称填充
  断言 7: abstractInterpreter.hpp:130 — 验证 AbstractInterpreter::code() 返回
  断言 8: stubs.cpp:158 — 验证 StubQueue::commit() 提交

§九 ★ Cross-Reference
  ❓ 01-CodeCache — StubQueue 在 CodeCache NonNMethod segment 中分配
  ❓ 13-Management-Services — init_globals 调用序列
  ❓ 16-Universe-Post-Init — 解释器分发的类型系统（Klass）
  ❓ 15-StubRoutines-SharedRuntime — i2c adapter 通过 code() 获取 StubQueue

§十 诊断工具
  ❓ jcmd <pid> Compiler.CodeList — 验证解释器 codelet 数量
  ❓ GDB: print Bytecodes::_name[iload] — 验证字节码名称表
  ❓ strace -e mmap,mprotect — 验证 CodeCache 分配
  ❓ /proc/<pid>/maps — 验证 CodeCache 映射区域

§十一 边缘场景
  ❓ CDS 恢复 vs 重新生成解释器 codelet
  ❓ TieredCompilation 下 CompileThreshold 的变化
  ❓ ZERO 解释器构建的初始化差异
  ❓ 解释器 codelet 耗尽 CodeCache 空间（InterpreterCodeSize 过小）
```

---

## §六 Writing Requirements

### "不要写成→应该写成"对照表

| 不要写成 | 应该写成 |
|---------|---------|
| "bytecodes_init() 初始化字节码表" | "Bytecodes::initialize() at bytecodes.cpp:268 通过 def() × ~200 次调用填充 6 个静态数组——_name[256] (const char*), _result_type[256] (BasicType), _depth[256] (int), _lengths[256] (int, 编码为 (wide_len<<4)\|len), _java_code[256] (Code, 内部字节码映射), _flags[512] (int, 前256普通+后256 wide)——compute_flags() 解析 format 字符串如 'bi'=byte+index, 'boo'=byte+2×offset" |
| "interpreter_init() 生成解释器代码" | "TemplateInterpreter::initialize() at templateInterpreter.cpp:42 创建 StubQueue(BufferBlob::create("Interpreter", code_size))——在 CodeCache NonNMethod segment 中分配 ~256KB。TemplateInterpreterGenerator::generate_all() 通过 CodeletMark RAII commit 生成 256 codelet + 方法入口 + 返回入口 + 异常抛出器 + 安全点入口 + 去优化入口" |
| "templateTable_init() 初始化模板表" | "TemplateTable::initialize() at templateTable.cpp:244 通过 def() × 256 次调用初始化 Template 对象——每个 Template 含 flags (ubcp/disp/clvm/wide), TosState 转换 (in→out), generator 函数指针——描述字节码的代码生成需求。实际机器码在 TemplateInterpreterGenerator::generate_all() 中生成" |
| "invocationCounter_init() 设置编译阈值" | "InvocationCounter::reinitialize() at invocationCounter.cpp:153 定义 2 状态状态机——wait_for_nothing→do_nothing, wait_for_compile→do_decay(startup)/dummy_overflow(steady)——计算 InterpreterInvocationLimit=CompileThreshold<<3, InterpreterProfileLimit=33%×CT<<3, InterpreterBackwardBranchLimit=933%×CT (OSR 需要 ~9× 补偿循环频率)" |
| "VMRegImpl::set_regName() 设置寄存器名" | "VMRegImpl::set_regName() at vmreg_x86.cpp:31 4 个 for 循环遍历 GPR(32 条目, AMD64 每个 64-bit 寄存器 2 slot)→FPR(16, x87×2)→XMM(512, ZMM 32×16)→KREG(8, 掩码×1)→填充 regName[569] 数组" |
| "Bytecodes::length_for() 返回字节码长度" | "Bytecodes::length_for() 是 O(1) 查表——从 _lengths[code] 中解码 len=lengths&0xF, wlen=lengths>>4。15 个直接调用者: Rewriter::scan_method(), Verifier::verify_method(), generateOopMap, GraphKit, LinearScan, RawBytecodeStream 等——每次字节码遍历都依赖此表" |
| "StubQueue 存储解释器代码" | "StubQueue at stubs.cpp:67 构造时调用 BufferBlob::create(name, size) 在 CodeCache NonNMethod segment 中分配 BufferBlob。_stub_buffer 指向 blob->content_begin()。commit() at :158 计算 aligned_size, 调用 stub_initialize() 设置元数据, 推进 _queue_end 指针——解释器 codelet 和 JIT nmethod 共享 CodeCache 空间" |

### 其他要求

- Mermaid 序列图 — 6 lanes: init_globals / Bytecodes / Interpreter / TemplateTable / InvocationCounter / CodeCache
- GDB 断点 ≥8 条 — 精确到 file:line，每断点有预期变量值
- 7 Beginner Callout 框 — exact text from §四（`> **` 块引用格式）
- 交叉引用 — 01-CodeCache, 13-Management-Services, 16-Universe-Post-Init, 15-StubRoutines-SharedRuntime
- 源码粘贴而非文字描述 — 每个技术断言 3-5 行源码

---

## §七 Output Format

- Markdown file, named `14-Interpreter-Bytecodes-TemplateTable.md`
- Output path: `/data/workspace/openjdk-cut-new/probe_md/01-jvm-startup/docs/`
- 元信息头:
```
> **Phase**: 01-jvm-startup
> **前置**: [01-CodeCache]（StubQueue 在 CodeCache 中分配）、[13-Management-Services]（init_globals 调用序列）、[16-Universe-Post-Init]（解释器分发的类型系统）
> **配套**: [00-JNI-CreateJavaVM]（init_globals 在 create_vm 中的位置）
> **后续依赖本文**: [15-StubRoutines-SharedRuntime]（i2c adapter 通过 code() 获取 StubQueue）
> **阅读收益**: 追踪解释器基础设施的 7 个初始化调用——理解 Bytecodes::initialize 的 def()×~200 构建 6 个属性数组（14KB 静态表）、TemplateInterpreter::initialize 的 StubQueue + generate_all 生成 256 codelet（CodeCache NonNMethod segment）、TemplateTable::initialize 的 256 Template 描述符（TosState 转换 + flags + generator）、InvocationCounter::reinitialize 的 2 状态状态机 + 3 阈值计算（do_decay 启动平滑）、VMRegImpl::set_regName 的 569 条目寄存器名映射（GPR→FPR→XMM→KREG）；掌握 "方法首次调用" 的 codelet 分派链路和 "DelayCompilationDuringStartup" 的 do_decay 机制
```
- 目标行数: 1000-1200 lines
- Section 编号: `## §〇` 到 `## §十一`（连续无跳号）

---

## §八 Prohibited（≥8）

- ❌ 只说 "bytecodes_init 初始化字节码" 而不展示 def() 的 7 参数核心重载和 compute_flags 格式解析 — 必须从 bytecodes.cpp:157 源码开始
- ❌ 不展示 StubQueue 在 CodeCache 中的分配 — 必须展示 BufferBlob::create → CodeCache::allocate 的完整链路
- ❌ 忽略 CodeletMark 的 RAII commit 机制 — 必须展示构造/析构 + StubQueue::commit() 的 aligned_size 计算
- ❌ 不解释 _counter 的 32-bit 位布局 — 必须展示 count(29) | carry(1) | state(2) 的布局 + number_of_noncount_bits=3
- ❌ 忽略 do_decay 的指数延迟机制 — 必须展示计数减半 (count >> 1) + 最小保持 1 + 下次溢出需要翻倍的数学原理
- ❌ 不展示 TosState 枚举 — 必须列出 11 个 TosState（btos~ilgl）和它们在栈上的槽位数
- ❌ 忽略 Bytecodes 查询方法的运行时调用者 — 必须列出 length_for() 的 15 个调用者和 flags() 的 13 个调用者
- ❌ 不解释 VMReg 到 x86 物理寄存器的映射 — 必须展示 GPR×2 slot 的 AMD64 特殊处理
- ❌ 不做 GDB 断点 trace — 至少 8 个断点覆盖 bytecodes_init → interpreter_init → templateTable_init → invocationCounter_init
- ❌ 不要解释 Java 字节码语义（这是 JVM 文档，不是 Java 教程）

---

## §九 Required（≥8）

- ✅ **★ Mermaid Interpreter 初始化序列图** — 6 lanes: init_globals / Bytecodes / Interpreter / TemplateTable / InvocationCounter / CodeCache
- ✅ **★ Bytecodes::initialize() 完整源码走读** — 293 行，def() × ~200 构建 6 个属性数组
- ✅ **★ TemplateInterpreter::initialize() 完整源码走读** — 32 行，StubQueue + generate_all + deallocate_unused_tail
- ✅ **★ TemplateTable::initialize() 完整源码走读** — 288 行，def() × 256 构建 Template 描述符
- ✅ **★ InvocationCounter::reinitialize() 完整源码走读** — 47 行，状态机 + 3 阈值
- ✅ **★ VMRegImpl::set_regName() 完整源码走读** — 38 行，4 类寄存器遍历
- ✅ **★ Bytecodes 查询方法调用者表** — length_for(15), flags(13), depth(3), result_type(2)
- ✅ **★ 7 Beginner Callout 框** — `> **` 块引用格式
- ✅ **★ 面试 Story Format 答案** — §一末尾
- ✅ **★ GDB 断点 ≥8 条** — 精确到 file:line，每断点有预期变量值
- ✅ **★ "不要写成→应该写成"对照表** — §六 中 7 行对照
- ✅ **★ 交叉引用** — 01-CodeCache / 13-Management-Services / 16-Universe-Post-Init / 15-StubRoutines-SharedRuntime

---

## §十 GDB Verification（≥8 assertions）

```
断言 1: Bytecodes::initialize 入口 (bytecodes.cpp:268)
  (gdb) break bytecodes.cpp:268
  (gdb) run
  (gdb) print Bytecodes::_is_initialized → 期望: false（首次初始化）
  (gdb) continue → 进入 def() 循环

断言 2: def() 填充 _name[iload] (bytecodes.cpp:157)
  (gdb) break bytecodes.cpp:161 if code == Bytecodes::_iload
  (gdb) print name → 期望: "iload"
  (gdb) print result_type → 期望: T_INT (10)
  (gdb) print depth → 期望: 1

断言 3: StubQueue 创建 (templateInterpreter.cpp:58)
  (gdb) break templateInterpreter.cpp:58
  (gdb) print code_size → 期望: ~262144 (InterpreterCodeSize, 256KB)
  (gdb) continue
  (gdb) print AbstractInterpreter::_code → 期望: 非 NULL StubQueue*

断言 4: TemplateTable::initialize 入口 (templateTable.cpp:244)
  (gdb) break templateTable.cpp:244
  (gdb) print Bytecodes::number_of_codes → 期望: 234 (当前字节码总数)
  (gdb) continue → 进入 def() 循环

断言 5: InterpreterInvocationLimit 计算 (invocationCounter.cpp:163)
  (gdb) break invocationCounter.cpp:163
  (gdb) print CompileThreshold → 期望: 10000 (默认)
  (gdb) continue
  (gdb) print InterpreterInvocationLimit → 期望: 80000 (10000 << 3)

断言 6: GPR 名称填充 (vmreg_x86.cpp:33)
  (gdb) break vmreg_x86.cpp:33
  (gdb) print reg->name() → 期望: "rax"
  (gdb) continue 经过第一个 GPR
  (gdb) print regName[0] → 期望: "rax"
  (gdb) print regName[1] → 期望: "rax" (AMD64 双 slot)

断言 7: AbstractInterpreter::code() 返回 (abstractInterpreter.hpp:130)
  (gdb) break abstractInterpreter.hpp:130
  (gdb) print AbstractInterpreter::_code → 期望: 非 NULL
  (gdb) print _code->_number_of_stubs → 期望: >200

断言 8: StubQueue::commit() (stubs.cpp:158)
  (gdb) break stubs.cpp:158
  (gdb) print _queue_end → 期望: 递增中（每次 commit 推进）
  (gdb) print _number_of_stubs → 期望: 递增中
```

---

## §十一 与 README 和同组文档的连续性

1. **从 README §init_globals 调用清单承接**：本文展开 init_globals 的第 2、11、12、13、14、15、16 次调用——从字节码表到寄存器名的完整代码级解答。

2. **与 01-CodeCache 的连接**：解释器 StubQueue 通过 BufferBlob::create() 在 CodeCache NonNMethod segment 中分配。codeCache_init() (init.cpp:127) 在 interpreter_init() (init.cpp:145) 之前执行——CodeCache 必须先分配。deallocate_unused_tail() 归还未用空间给 CodeCache。

3. **与 13-Management-Services 的连接**：本文覆盖的 7 个调用在 init_globals 调用序列中位于 management_init (line 119) 之后、javaClasses_init (line 161) 之前。

4. **与 16-Universe-Post-Init 的连接**：解释器分发的字节码（如 invokevirtual）依赖 Universe 中创建的 Klass 进行方法分派和类型检查。universe2_init() (line 157) 在 interpreter_init() (line 145) 之后——解释器初始化时 Universe 尚未完全就绪，解释器 codelet 生成使用静态的 Bytecodes 属性表而非 Klass。

5. **与 15-StubRoutines-SharedRuntime 的连接**：SharedRuntime::gen_i2c_adapter() 通过 AbstractInterpreter::code() 获取 StubQueue 引用，在其中生成 interpreter-to-compiled 桥接代码。i2c adapter 在 init_globals 第 29 次调用 (stubRoutines_init2) 之后才生成。

6. **同组边界**：本文覆盖解释器基础设施（数据表 + 模板描述符 + 寄存器名 + 计数器）；15 覆盖 CodeCache 中的桩代码（call_stub, arraycopy, AES/SHA intrinsic 等）；17 覆盖编译基础设施（vtableStubs, InlineCacheBuffer, compilerOracle）。
