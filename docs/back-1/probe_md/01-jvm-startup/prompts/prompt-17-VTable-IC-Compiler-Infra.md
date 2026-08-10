# PROMPT: 请撰写 17-VTable-IC-Compiler-Infra.md

## §〇 Production Scenario

### 场景 1: 虚方法调用触发 `vtable_index` 越界

```java
interface Service { void execute(); }
class Impl1 implements Service { public void execute() { ... } }
class Impl2 implements Service { public void execute() { ... } }
Service s = new Impl2();
s.execute();  // invokeinterface → itable lookup
```

`invokeinterface` 指令需要从 itable（接口方法表）中查找 `execute()` 的 Method*。itable 在 `universe_post_init()` 中通过 `reinitialize_itables()` 构建，但 `vtableStubs_init()` 创建了 256 槽哈希表用于缓存虚方法分派的桩代码。如果 `_receiver_location`（接收者寄存器位置）设置错误 → itable 查找到错误偏移 → 跳转到错误方法 → `AbstractMethodError` 或 SIGSEGV。

**三步诊断**：
```bash
# 1. 验证 vtableStubs 哈希表已创建
gdb -ex "break vtableStubs.cpp:299" \
    -ex "run" \
    -ex "print VtableStubs::_table[0]" \
    --args java -jar app.jar
# 期望: _table 非 NULL（已分配 256 个槽位）

# 2. 验证 receiver 寄存器位置
gdb -ex "print VtableStub::_receiver_location" \
    --args java -jar app.jar
# 期望: rcx 或 rax（平台相关）
```

**反事实**：如果没有 vtableStubs 哈希表 → 每次虚方法调用都需要遍历 vtable（O(vtable_size)）→ 每个 invokevirtual 增加 ~10 次内存访问。vtableStubs 缓存已生成的桩代码 → O(1) 哈希查找 → ~1 次内存访问。

### 场景 2: `-XX:CompileCommand` 配置不生效

```bash
java -XX:CompileCommand=exclude,com/example/Foo.bar -jar app.jar
# Foo.bar 仍然被 JIT 编译——CompileCommand 未生效
```

`compilerOracle_init()` (`compilerOracle.cpp:767`) 解析 `-XX:CompileCommand` 和 `-XX:CompileOnly` 参数。如果参数格式错误（如方法签名不匹配），`parse_from_line()` 解析失败但无错误提示 → 编译策略未应用。如果同时指定了 `.hotspot_compiler` 文件但未使用 `-XX:CompileCommandFile` → 文件被忽略并输出 warning。

### 场景 3: IC buffer 满导致 inline cache 更新失败

```
# JVM warning: ICBuffer full
```

`InlineCacheBuffer_init()` (`icBuffer.cpp:167`) 创建 10KB 的 `StubQueue` 用于存储 inline cache 更新 stub。当大量方法同时触发 IC 更新（如大规模反射调用或动态代理）→ IC buffer 可能填满 → 后续 IC 更新失败 → 方法调用回退到解释器 → 性能骤降。

---

## §一 Task + Narrative + Beginner Callouts

### Task

Reading this prompt, you will produce a document that traces the FOUR init_globals() calls that build the JVM's compilation infrastructure. These calls are lightweight (most <10 lines) but critical for JIT compilation correctness and performance:

- `vtableStubs_init()` — 256-slot vtable stub hash table (line 170)
- `InlineCacheBuffer_init()` — 10KB IC update StubQueue (line 173)
- `compilerOracle_init()` — CompileCommand/CompileOnly parsing (line 174)
- `dependencyContext_init()` — 4 PerfCounters for nmethod dependency tracking (line 175)

Reader completed **01-CodeCache** (where vtable stubs live), **10-JNIHandle-CompileQueue-JVMTI** (CompileQueue + CompilationPolicy), **15-StubRoutines-SharedRuntime** (resolve blobs for method dispatch). This doc: **how the JVM caches virtual method dispatch stubs, buffers inline cache updates, parses compiler directives, and tracks nmethod dependencies — the compilation infrastructure that bridges interpreted method dispatch to JIT-compiled code**.

### Interview Story Format Answer（必须出现在 §一 末尾）

"`vtableStubs_init()` at `vtableStubs.cpp:299` (3 lines) delegates to `VtableStubs::initialize()` (11 lines, :124-134) which sets `VtableStub::_receiver_location = SharedRuntime::name_for_receiver()` — the register that holds the receiver object during virtual dispatch (rcx on x86_64). It then allocates `_table[0..N-1]` — a hash table of `VtableStub*` pointers, N = `memory->code_cache_size / 1M` (typically 256). Each slot caches a generated vtable dispatch stub (a small code fragment that indexes into the vtable and jumps to the target method). `InlineCacheBuffer_init()` at `icBuffer.cpp:167` (3 lines) delegates to `InlineCacheBuffer::initialize()` (6 lines, :112-117) which creates `_buffer = new StubQueue(new ICStubInterface, 10*K, InlineCacheBuffer_lock, "InlineCacheBuffer")` — a 10KB StubQueue in C-Heap (NOT CodeCache!) protected by `InlineCacheBuffer_lock`. `init_next_stub()` creates a sentinel stub to mark the start. `compilerOracle_init()` at `compilerOracle.cpp:767` (22 lines) parses `CompileCommand` (e.g., `exclude,com/example/Foo.bar`) and `CompileOnly` (e.g., `com/example/*`) from the command line via `parse_from_string()`. If no command file is specified, it checks for the default `.hotspot_compiler` file and issues a warning if found but not loaded. It also validates print commands against `PrintAssembly` and `DebugNonSafepoints` flags. `dependencyContext_init()` at `dependencyContext.cpp:39` (3 lines) delegates to `DependencyContext::init()` (13 lines, :43-55) which conditionally creates 4 `PerfData` counters (if `UsePerfData=true`): `_perf_total_buckets_allocated_count` (nmethod buckets allocated), `_perf_total_buckets_deallocated_count` (nmethod buckets deallocated), `_perf_total_buckets_stale_count` (stale buckets), `_perf_total_buckets_stale_acc_count` (accumulated stale). The key architectural insight: these 4 calls collectively build the dispatch infrastructure that sits between the interpreter's bytecode dispatch and the JIT compiler's compiled code — vtable stubs accelerate virtual dispatch, IC buffer patches call sites when classes are loaded, CompileOracle controls what gets compiled, and DependencyContext tracks when compiled code must be invalidated."

### Beginner Callout Boxes（文档中必须出现的 5 个 callout 框）

1. **vtable vs itable**: vtable（虚函数表）存储实例方法的 Method* 指针——每个类一个 vtable，继承父类 vtable 并追加自己的方法。itable（接口方法表）存储接口方法的 Method* 指针——类实现的每个接口一个 itable。`invokevirtual` 走 vtable，`invokeinterface` 走 itable。vtableStubs 缓存的是 vtable 分派的桩代码——加速高频虚方法调用。

2. **VtableStub 哈希表的大小计算**: `_table` 大小 = `memory->code_cache_size / 1M`。默认 CodeCache 240MB → `_table` 有 240 个槽位。每个槽位是一个 `VtableStub*` 指针（8 字节）→ 240 × 8 = 1920 字节。哈希函数：`(vtable_index << 2) ^ (vtable_index >> (BitsPerInt - 2))` — 简单但有效的分布。

3. **IC buffer 在 C-Heap 而非 CodeCache**: `InlineCacheBuffer::_buffer` 是 C-Heap 分配的 StubQueue（10KB），不是 CodeCache。IC update stub 是临时性的——更新 inline cache 条目后 stub 即被废弃。放在 C-Heap 避免占用 CodeCache 空间。`InlineCacheBuffer_lock` 保护并发更新。

4. **CompileCommand 的三种格式**: `-XX:CompileCommand=exclude,com/example/Foo.bar`（排除方法）、`-XX:CompileCommand=compileonly,com/example/*`（仅编译指定类）、`-XX:CompileCommand=inline,com/example/Helper.help`（强制内联）。还支持 `print`（打印汇编）、`break`（在编译时断点）、`log`（记录编译日志）。多个命令用换行符或空格分隔。

5. **DependencyContext 的 nmethod 依赖跟踪**: 当 C2 编译方法 A 时，如果 A 内联了方法 B，A 的 nmethod 依赖 B 不被修改（如类重定义）。`DependencyContext` 为每个 nmethod 维护一个依赖桶（bucket）链表——当 B 被修改时，遍历桶找到所有依赖 B 的 nmethod 并标记为 `not_entrant`。4 个 PerfCounter 跟踪桶的分配/释放/过期统计。

---

## §二 Standard Environment

OpenJDK 11 slowdebug, 64-bit Linux.

Source roots:
- `src/hotspot/share/code/vtableStubs.cpp` — vtableStubs_init() (:299), VtableStubs::initialize() (:124)
- `src/hotspot/share/code/vtableStubs.hpp` — VtableStub 类, VtableStubs 类
- `src/hotspot/share/code/icBuffer.cpp` — InlineCacheBuffer_init() (:167), InlineCacheBuffer::initialize() (:112)
- `src/hotspot/share/code/icBuffer.hpp` — InlineCacheBuffer 类
- `src/hotspot/share/compiler/compilerOracle.cpp` — compilerOracle_init() (:767)
- `src/hotspot/share/compiler/compilerOracle.hpp` — CompilerOracle 类
- `src/hotspot/share/code/dependencyContext.cpp` — dependencyContext_init() (:39), DependencyContext::init() (:43)
- `src/hotspot/share/code/dependencyContext.hpp` — DependencyContext 类

Build: `make jdk`

---

## §三 Source Files Table

| # | File | Full Path | Lines | Core Functions | Role |
|---|------|-----------|:--:|-------|------|
| 1 | **vtableStubs.cpp** | `src/hotspot/share/code/vtableStubs.cpp` | ~300 | `vtableStubs_init()`(:299), `VtableStubs::initialize()`(:124) | vtable stub 哈希表 |
| 2 | **icBuffer.cpp** | `src/hotspot/share/code/icBuffer.cpp` | ~200 | `InlineCacheBuffer_init()`(:167), `InlineCacheBuffer::initialize()`(:112) | IC update buffer |
| 3 | **compilerOracle.cpp** | `src/hotspot/share/compiler/compilerOracle.cpp` | ~800 | `compilerOracle_init()`(:767), `parse_from_string()` | 编译指令解析 |
| 4 | **dependencyContext.cpp** | `src/hotspot/share/code/dependencyContext.cpp` | ~100 | `dependencyContext_init()`(:39), `DependencyContext::init()`(:43) | nmethod 依赖跟踪 |

---

## §四 Deep Dive Question Groups（≥4 组，每组含 counterfactual）

### 4.1 ★★★ vtableStubs_init() — 虚方法分派缓存

```
问题：
  ① VtableStubs::initialize() (vtableStubs.cpp:124-134, 11 行) 如何初始化分派缓存？
      答案方向: 源码展示：
        VtableStub::_receiver_location = SharedRuntime::name_for_receiver();
        // x86_64: rcx (C2 约定) 或 rax (C1 约定)
        
        int N = (int)((uint)memory->code_cache_size() / (1 * M));
        _table = new VtableStub*[N]();  // 全部初始化为 NULL
        // N 通常 = 240 (240MB CodeCache / 1MB)
        
        运行时: 当 JIT 遇到 invokevirtual 时，检查 _table[hash(vtable_index)]
        → NULL: 生成新的 VtableStub（在 CodeCache 中）→ 填入槽位
        → 非 NULL: 复用已有 stub（同一 vtable_index 的所有调用共享一个 stub）
      
      追问: 为什么 _receiver_location 是 rcx 而非 this 寄存器？
      → x86-64 的 C++ ABI 中 this 指针在 rdi——但 JIT 编译器使用自定义的寄存器约定。
        C2 使用 rcx 传递 receiver，C1 使用 rax。name_for_receiver() 返回平台特定的
        寄存器名称字符串（用于调试），实际的寄存器编号在 sharedRuntime 中定义。

  ② Counterfactual: 如果 vtableStubs 哈希表使用固定大小 256 而非基于 CodeCache？
      答案方向: CodeCache 大小可配置（-XX:ReservedCodeCacheSize）。240MB CodeCache → 240 槽位，
        但 1GB CodeCache → 1024 槽位。固定 256 在 1GB 时可能不足（hash 碰撞增加），
        在 32MB 时浪费（256 槽位太多）。基于 CodeCache 的自适应大小平衡了碰撞率和内存开销。
```

### 4.2 ★★ InlineCacheBuffer_init() — IC 更新缓冲

```
问题：
  ① InlineCacheBuffer::initialize() (icBuffer.cpp:112-117, 6 行) 创建了什么？
      答案方向: 源码展示：
        _buffer = new StubQueue(new ICStubInterface, 10*K, InlineCacheBuffer_lock, "InlineCacheBuffer");
        // StubQueue 在 C-Heap 分配（非 CodeCache!）
        // ICStubInterface 定义了 stub 的大小和对齐
        // InlineCacheBuffer_lock 保护并发访问
        init_next_stub();  // 创建 sentinel stub 标记起始位置
      
      追问: 为什么 IC buffer 在 C-Heap 而非 CodeCache？
      → IC update stub 是临时性的——更新 inline cache 条目（修改 call 指令的目标地址）
        后 stub 即被废弃。放在 C-Heap 避免占用 CodeCache 的宝贵空间（NonNMethodCodeHeap
        已被解释器 codelet、StubRoutines、resolve blob 占据 ~400KB）。

  ② Counterfactual: 如果 IC buffer 满了怎么办？
      答案方向: IC update 失败 → 方法调用回退到解释器（未链接状态）→ 下次调用时重新尝试
        IC update。性能影响：回退到解释器 ~100ns vs IC hit ~5ns → 20× 慢，但只在 IC buffer
        满的短暂窗口内发生。10KB buffer 通常足够（每个 IC stub ~20 字节 → 500 个并发更新）。
```

### 4.3 ★★ compilerOracle_init() — 编译指令解析

```
问题：
  ① compilerOracle_init() (compilerOracle.cpp:767-788, 22 行) 如何解析编译指令？
      答案方向: 源码展示：
        CompilerOracle::parse_from_string(CompileCommand, CompilerOracle::parse_from_line);
        CompilerOracle::parse_from_string(CompileOnly, CompilerOracle::parse_compile_only);
        
        if (CompilerOracle::has_command_file()) {
          CompilerOracle::parse_from_file();
        } else {
          struct stat buf;
          if (os::stat(".hotspot_compiler", &buf) == 0) {
            warning(".hotspot_compiler file is present but has been ignored. "
                    "Run with -XX:CompileCommandFile=.hotspot_compiler to load.");
          }
        }
        
        if (lists[PrintCommand] != NULL) {
          if (PrintAssembly) warning("CompileCommand contains 'print' but PrintAssembly also enabled");
          else if (FLAG_IS_DEFAULT(DebugNonSafepoints)) {
            warning("printing assembly enabled; turning on DebugNonSafepoints");
            DebugNonSafepoints = true;
          }
        }
      
      追问: 为什么 .hotspot_compiler 文件被忽略时需要 warning？
      → 用户在项目目录放置 .hotspot_compiler 文件期望它被加载——但 JVM 不会自动加载。
        这是常见的配置错误。warning 提示用户显式使用 -XX:CompileCommandFile。

  ② Counterfactual: 如果 CompileCommand 解析失败无提示？
      答案方向: 方法签名拼写错误 → 命令静默失败 → 用户期望排除的方法被编译 → 性能退化
        → 诊断困难（PrintCompilation 显示方法被编译，但用户认为已排除）。
        当前实现中 parse_from_line() 对解析失败只返回 false——不输出任何错误消息。
```

### 4.4 ★★ dependencyContext_init() — nmethod 依赖跟踪

```
问题：
  ① DependencyContext::init() (dependencyContext.cpp:43-55, 13 行) 创建了哪些 PerfCounter？
      答案方向: 源码展示（条件 UsePerfData）：
        _perf_total_buckets_allocated_count     — "nmethodBucketsAllocated" (SUN_CI)
        _perf_total_buckets_deallocated_count   — "nmethodBucketsDeallocated" (SUN_CI)
        _perf_total_buckets_stale_count         — "nmethodBucketsStale" (SUN_CI)
        _perf_total_buckets_stale_acc_count     — "nmethodBucketsStaleAccumulated" (SUN_CI)
        
        这些计数器在 jcmd PerfCounter.print 中可见。
        stale bucket: 依赖已被满足但桶尚未回收的条目。
        accumulated stale: 累计的过期桶总数。
      
      追问: 为什么依赖跟踪需要 PerfCounter？
      → 如果 nmethod 被频繁标记为 not_entrant（依赖破坏）→ _perf_total_buckets_stale_count
        持续增长 → 说明类重定义或类卸载过于频繁 → 性能问题。PerfCounter 提供量化指标。

  ② Counterfactual: 如果没有依赖跟踪？
      答案方向: 类重定义（JVMTI RedefineClasses）后，已编译的 nmethod 可能调用旧版本的方法
        → 类型系统不一致 → ClassCastException 或静默错误。DependencyContext 确保类重定义时
        所有依赖旧类的 nmethod 被标记为 not_entrant——下次调用时去优化并重新编译。
```

---

## §五 Article Structure

```
§〇 生产场景
  ★ 场景 1: 虚方法调用触发 vtable_index 越界
  ★ 场景 2: -XX:CompileCommand 配置不生效
  ★ 场景 3: IC buffer 满导致 inline cache 更新失败
  每个场景: 真实症状 + 三步诊断 + 反事实讨论

§一 ★★★ 编译底座 4 调用全链路源码走读
  1.1 vtableStubs_init() → VtableStubs::initialize() — 256 槽哈希表 + receiver 寄存器
  1.2 InlineCacheBuffer_init() → InlineCacheBuffer::initialize() — 10KB StubQueue (C-Heap)
  1.3 compilerOracle_init() — CompileCommand/CompileOnly 解析 + .hotspot_compiler warning
  1.4 dependencyContext_init() → DependencyContext::init() — 4 PerfCounter
  1.5 ★ 面试 Story Format 答案

§二 Standard Environment

§三 Source Files Table（4 个文件）

§四 ★★★ 5 Beginner Callout 框
  > **1. vtable vs itable**
  > **2. VtableStub 哈希表的大小计算**
  > **3. IC buffer 在 C-Heap 而非 CodeCache**
  > **4. CompileCommand 的三种格式**
  > **5. DependencyContext 的 nmethod 依赖跟踪**

§五 ★★★ vtable stub 哈希表 + IC buffer
  5.1 VtableStubs::initialize() 的 _receiver_location + _table 分配
  5.2 VtableStub 的哈希函数和碰撞处理
  5.3 IC buffer 的 StubQueue 结构 + InlineCacheBuffer_lock
  5.4 ICStubInterface 的 stub 大小和对齐定义

§六 ★★ CompileCommand + DependencyContext
  6.1 CompileCommand 的解析流程（parse_from_string → parse_from_line）
  6.2 CompileOnly 的类名模式匹配
  6.3 .hotspot_compiler 文件的 warning 机制
  6.4 print 命令与 PrintAssembly/DebugNonSafepoints 的交互
  6.5 DependencyContext 的 4 PerfCounter + bucket 链表结构

§七 ★ GDB 断点验证 — 5 断点
  断言 1: vtableStubs.cpp:124 — 验证 _receiver_location 设置
  断言 2: icBuffer.cpp:112 — 验证 StubQueue("InlineCacheBuffer", 10K) 创建
  断言 3: compilerOracle.cpp:767 — 验证 CompileCommand 解析
  断言 4: dependencyContext.cpp:43 — 验证 UsePerfData 条件和 PerfCounter 创建
  断言 5: vtableStubs.cpp:299 — 验证 _table 分配

§八 ★ Cross-Reference
  ❓ 01-CodeCache — vtable stub 在 CodeCache 中分配
  ❓ 10-JNIHandle-CompileQueue-JVMTI — CompileQueue + CompilationPolicy
  ❓ 15-StubRoutines-SharedRuntime — resolve blob 用于方法分派
  ❓ 14-Interpreter — invokevirtual/invokeinterface 的字节码分派

§九 诊断工具
  ❓ jcmd <pid> Compiler.CodeHeap_Analytics — 验证 vtable stub 在 CodeCache 中
  ❓ jcmd <pid> PerfCounter.print — 验证 dependencyContext 计数器
  ❓ -XX:+PrintCompilation — 验证 CompileCommand 生效
  ❓ GDB: print VtableStubs::_table — 验证哈希表
```

---

## §六 Writing Requirements

### "不要写成→应该写成"对照表

| 不要写成 | 应该写成 |
|---------|---------|
| "vtableStubs_init 创建哈希表" | "VtableStubs::initialize() at vtableStubs.cpp:124 (11 行) 设置 VtableStub::_receiver_location = SharedRuntime::name_for_receiver() (x86_64: rcx)，分配 _table = new VtableStub*[N]() — N = memory->code_cache_size/1M (默认 240)，每个槽位初始化为 NULL——运行时首次遇到 vtable_index 时生成 VtableStub 并缓存" |
| "IC buffer 存储 inline cache 更新" | "InlineCacheBuffer::initialize() at icBuffer.cpp:112 (6 行) 创建 _buffer = new StubQueue(new ICStubInterface, 10*K, InlineCacheBuffer_lock, "InlineCacheBuffer")——10KB StubQueue 在 C-Heap（非 CodeCache）分配，ICStubInterface 定义 stub 大小 (~20B) 和对齐，InlineCacheBuffer_lock 保护并发更新，init_next_stub() 创建 sentinel" |
| "compilerOracle_init 解析编译指令" | "compilerOracle_init() at compilerOracle.cpp:767 (22 行) 通过 parse_from_string(CompileCommand, parse_from_line) 解析 -XX:CompileCommand（exclude/compileonly/inline/print/break/log），parse_from_string(CompileOnly, parse_compile_only) 解析 -XX:CompileOnly。如果 .hotspot_compiler 文件存在但未用 -XX:CompileCommandFile 加载 → warning。print 命令与 PrintAssembly 冲突时 warning" |
| "dependencyContext_init 创建计数器" | "DependencyContext::init() at dependencyContext.cpp:43 (13 行) 在 UsePerfData=true 时创建 4 个 PerfCounter（SUN_CI 命名空间）：nmethodBucketsAllocated/Deallocated/Stale/StaleAccumulated——跟踪 nmethod 依赖桶的分配/释放/过期统计" |

---

## §七 Output Format

- Markdown file, named `17-VTable-IC-Compiler-Infra.md`
- Output path: `/data/workspace/openjdk-cut-new/probe_md/01-jvm-startup/docs/`
- 元信息头:
```
> **Phase**: 01-jvm-startup
> **前置**: [01-CodeCache]（vtable stub 在 CodeCache 中）、[10-JNIHandle-CompileQueue-JVMTI]（CompileQueue）、[15-StubRoutines-SharedRuntime]（resolve blob）
> **配套**: [14-Interpreter]（invokevirtual/invokeinterface 字节码）
> **阅读收益**: 追踪 init_globals 中编译底座的 4 个调用——理解 vtableStubs 的 256 槽哈希表（基于 CodeCache 大小自适应）+ receiver 寄存器位置设置、IC buffer 的 10KB C-Heap StubQueue（非 CodeCache）+ InlineCacheBuffer_lock 保护、compilerOracle 的 CompileCommand/CompileOnly 解析 + .hotspot_compiler warning、DependencyContext 的 4 PerfCounter nmethod 依赖跟踪；掌握 "虚方法调用如何缓存分派桩" 和 "CompileCommand 为何不生效" 的诊断路径
```
- 目标行数: 500-700 lines
- Section 编号: `## §〇` 到 `## §九`（连续无跳号）

---

## §八 Prohibited（≥8）

- ❌ 只说 "vtableStubs_init 初始化哈希表" 而不展示 _receiver_location 和 _table 分配 → 必须从 vtableStubs.cpp:124 源码开始
- ❌ 不解释 IC buffer 为何在 C-Heap 而非 CodeCache → 必须说明 IC stub 的临时性
- ❌ 忽略 .hotspot_compiler 文件的 warning 机制 → 必须展示 stat() 检查和 warning 输出
- ❌ 不做 GDB 断点 trace → 至少 5 个断点

---

## §九 Required（≥8）

- ✅ **★ VtableStubs::initialize() 完整源码走读** — 11 行，_receiver_location + _table
- ✅ **★ InlineCacheBuffer::initialize() 完整源码走读** — 6 行，C-Heap StubQueue
- ✅ **★ compilerOracle_init() 完整源码走读** — 22 行，CompileCommand + CompileOnly + .hotspot_compiler
- ✅ **★ DependencyContext::init() 完整源码走读** — 13 行，4 PerfCounter
- ✅ **★ 5 Beginner Callout 框** — `> **` 块引用格式
- ✅ **★ 面试 Story Format 答案** — §一末尾
- ✅ **★ GDB 断点 ≥5 条** — 精确到 file:line
- ✅ **★ "不要写成→应该写成"对照表** — §六 中 4 行对照

---

## §十 GDB Verification（≥5 assertions）

```
断言 1: _receiver_location 设置 (vtableStubs.cpp:124)
  (gdb) break vtableStubs.cpp:124
  (gdb) run
  (gdb) print SharedRuntime::name_for_receiver() → 期望: "rcx" (x86_64)

断言 2: StubQueue 创建 (icBuffer.cpp:112)
  (gdb) break icBuffer.cpp:112
  (gdb) continue
  (gdb) print InlineCacheBuffer::_buffer → 期望: 非 NULL StubQueue*
  (gdb) print InlineCacheBuffer::_buffer->total_size() → 期望: 10240

断言 3: CompileCommand 解析 (compilerOracle.cpp:767)
  (gdb) break compilerOracle.cpp:767
  (gdb) print CompileCommand → 期望: 命令行参数值（如 "exclude,com/example/Foo.bar"）

断言 4: PerfCounter 创建 (dependencyContext.cpp:43)
  (gdb) break dependencyContext.cpp:43
  (gdb) print UsePerfData → 期望: true
  (gdb) continue
  (gdb) print DependencyContext::_perf_total_buckets_allocated_count → 期望: 非 NULL

断言 5: _table 分配 (vtableStubs.cpp:299)
  (gdb) break vtableStubs.cpp:299
  (gdb) continue
  (gdb) print VtableStubs::_table → 期望: 非 NULL
  (gdb) print VtableStubs::_table[0] → 期望: NULL (初始)
```

---

## §十一 与 README 和同组文档的连续性

1. **从 README §init_globals 调用清单承接**：本文展开 init_globals 的第 23、24、25、26 次调用——编译底座 4 个轻量初始化。

2. **与 01-CodeCache 的连接**：VtableStub 在 CodeCache 中分配，IC buffer 在 C-Heap 中分配——两者互补使用 CodeCache 和非 CodeCache 存储。

3. **与 10-JNIHandle-CompileQueue-JVMTI 的连接**：CompileQueue 管理编译任务，CompilerOracle 控制哪些方法进入队列。

4. **与 15-StubRoutines-SharedRuntime 的连接**：resolve blob 处理未缓存的虚方法分派——vtable stub 缓存已解析的分派结果。

5. **与 14-Interpreter 的连接**：invokevirtual 和 invokeinterface 字节码触发虚方法分派——vtable stub 和 IC buffer 加速这些高频操作。
