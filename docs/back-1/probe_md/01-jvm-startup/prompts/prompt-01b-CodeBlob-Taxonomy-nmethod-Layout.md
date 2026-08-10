# PROMPT: 请撰写 01b-CodeBlob-Taxonomy-nmethod-Layout.md

## ⚠️ 关键：本 prompt 是导航地图，不是预制答案。你必须亲自读源码。

- §四 答案方向是"指引"——告诉你去源码里找什么。不能直接抄到文档里。
- **必须逐个读取 §三 列出的源文件**（至少读核心段落），基于自己的源码理解来写文档。
- 源码是证据（20%），你基于源码的分析洞察是正文（80%）。
- **严禁**：把 prompt 的答案方向文字直接转录到文档中。你必须读源码后用自己的话写。

---

## §〇 Production Scenario

### Part A: CodeBlob 分类场景

```
$ jcmd <pid> Compiler.CodeHeap_Analytics aggregate

CodeHeap 'non-nmethods': size=5696Kb used=4256Kb max_used=4288Kb free=1440Kb
  1 AdapterBlob: 32Kb
  3 BufferBlob: 128Kb
  1 DeoptimizationBlob: 48Kb
  2 RuntimeStub: 64Kb
  1 SafepointBlob: 16Kb
  1 MethodHandlesAdapterBlob: 182Kb
  ... 更多 BufferBlob (stub routines, interpreter codelets) ...
```

NonNMethod heap 存了 8+ 种不同类型的 Blob，各自有不同的生命周期、栈帧需求和 OopMap 策略。理解每种 Blob 的继承关系和分配策略是理解 CodeCache 全貌的前提。

### Part B: nmethod 布局场景

```
$ jcmd <pid> Compiler.CodeHeap_Analytics MethodNames
# 输出所有 nmethod 的方法名和大小
# 例如: java.util.HashMap.getNode(I)Ljava/util/Node;  size=2048B
#       java.lang.String.hashCode()I                  size=512B
#       com.example.MyApp.process()V                  size=16384B
```

每个 nmethod 不仅是机器码——它包含 11 个内部区域（常量、桩代码、OopTable、MetadataTable、ScopesData、PcDesc、Dependencies、HandlerTable、NulChkTable），由 14 个偏移字段精确定义其二进制布局。理解这个布局是理解 GC 扫描、异常处理、栈回溯、去优化的基础。

**反事实**：如果 nmethod 没有分区域布局（所有数据混在一起）→ GC 不知道哪些字节是 oop 指针 → 要么全量扫描（O(n) 每 nmethod），要么误将整数当指针 → 对象被错误标记为 alive → 内存泄漏。分区域布局使 GC 只需遍历 OopTable 和 MetadataTable 两个密集数组，跳过代码和常量区域。

**三步诊断**：

```bash
# 1. 查看 NonNMethod heap 中的 Blob 类型分布
jcmd <pid> Compiler.CodeHeap_Analytics aggregate

# 2. 查看单个 nmethod 的布局和区域大小
jcmd <pid> Compiler.CodeHeap_Analytics MethodNames

# 3. GDB 验证 CodeBlobType 分发
gdb -ex "break CodeCache::allocate" \
    -ex "print blob_type" \
    -ex "print size" \
    -ex "run" \
    --args java -XX:+PrintCompilation MyApp
```

---

## §一 Task + Narrative + Beginner Callouts

### Task

本文分两部分深入 CodeCache 的 Blob 存储层。

**Part A — CodeBlob 继承体系全览**：从 CodeBlob 基类开始，逐层展开 14 种子类型的完整继承树——包括 BufferBlob（解释器/StubRoutines）、AdapterBlob（C2I/I2C 适配器）、RuntimeStub（编译代码调用 C++ 运行时）、SingletonBlob 及其 5 个子类（DeoptimizationBlob、UncommonTrapBlob、ExceptionBlob、SafepointBlob×3），以及 CompiledMethod 基类。重点回答：每种 Blob 分配在哪个 CodeHeap（CodeBlobType 枚举 → Heap 映射）、有栈帧还是无栈帧（frame_size 和 OopMap 策略）、operator new 如何通过 CodeCache::allocate 分发到正确的 Heap。

**Part B — nmethod 二进制内存布局**：nmethod 在内存中从低地址到高地址分为 12 个区域：Header → Relocation → Constants → Code → Stubs → OopTable → MetadataTable → ScopesData → PcDesc → Dependencies → HandlerTable → NulChkTable。14 个偏移字段（`_consts_offset` 到 `_nmethod_end_offset`）在构造器中顺序计算，每个偏移 = 前一个偏移 + align_up(前一区域大小, 对齐粒度)。重点回答：每个区域存什么、GC 如何遍历 OopTable、异常处理如何找到 HandlerTable、ScopeDesc 如何从 ScopesData + PcDesc 解码。

### Narrative

CodeCache 不只是"存编译代码的缓存"——它是一个 Blob 类型系统，每种 Blob 有不同的生命周期和内存策略。BufferBlob 是纯代码容器（无栈帧、无 OopMap），用于解释器和 StubRoutines——永不释放，用 bump-pointer 分配。RuntimeStub 有栈帧和 OopMap，用于编译代码调用 C++ 运行时。SingletonBlob 是全局唯一实例（DeoptimizationBlob、SafepointBlob×3），有真实栈帧，因为去优化和异常处理需要完整的执行环境。nmethod 是最复杂的 Blob——11 个内部区域由 14 个偏移字段定义，构造器中顺序计算每个区域的边界。

CodeBlobType 枚举（MethodNonProfiled=0, MethodProfiled=1, NonNMethod=2）决定每个 Blob 分配到哪个 CodeHeap。所有非 nmethod Blob 的 operator new 都调用 `CodeCache::allocate(size, CodeBlobType::NonNMethod)` → NonNMethod heap（bump-pointer）。nmethod 根据 compilation level 分配到 Profiled 或 NonProfiled heap（freelist）。

### Interview Story Format Answer（必须出现在 §一 末尾）

"CodeCache 里的每一个对象都是 CodeBlob 的子类。继承树分两大分支：RuntimeBlob（非编译代码）和 CompiledMethod（编译方法）。RuntimeBlob 下又分 BufferBlob（纯代码容器，无栈帧，用于解释器 Codelet、StubRoutines、Adapter、Vtable、MethodHandles）和 RuntimeStub（有栈帧+OopMap，用于编译代码→C++ 运行时的桥接）。SingletonBlob 是 RuntimeStub 的特殊化——全局唯一实例，有真实栈帧，用于去优化（DeoptimizationBlob，5 个入口偏移对应 5 种去优化场景）、异常展开（ExceptionBlob，仅 C2）、安全点轮询（SafepointBlob×3）和不常见陷阱（UncommonTrapBlob，仅 C2）。

所有非 nmethod Blob 的 operator new 都调用 `CodeCache::allocate(size, CodeBlobType::NonNMethod)`——分配在 NonNMethod heap，用 bump-pointer，永不释放。CodeBlobType 枚举（MethodNonProfiled=0, MethodProfiled=1, NonNMethod=2）定义了 CodeCache 三段堆的分配策略。

nmethod 是最复杂的 Blob——它在内存中按固定顺序排列 12 个区域：Header（nmethod C++ 对象）→ Relocation → Constants（doubles/longs/floats）→ Code（机器码）→ Stubs（异常/去优化处理器）→ OopTable（嵌入 oop 指针数组，GC 扫描入口）→ MetadataTable（嵌入 Metadata* 数组）→ ScopesData（DebugInfo，ScopeDesc 解码用）→ PcDesc（PC→scope 映射表）→ Dependencies（依赖断言编码）→ HandlerTable（异常处理器 BCI→PC 表）→ NulChkTable（隐式空指针检查 PC→handler 表）。14 个偏移字段在构造器中顺序计算：`_consts_offset = content_offset() + consts_size` → `_stub_offset = content_offset() + stub_size` → `_oops_offset = data_offset()` → 每个后续偏移 = 前一个偏移 + align_up(前区域大小, 对齐粒度)。GC 扫描 nmethod 时不遍历整个 CodeBlob——只遍历 OopTable（`oops_begin()` 到 `oops_end()`）和 MetadataTable（`metadata_begin()` 到 `metadata_end()`），两个紧凑的指针数组，O(嵌入对象数) 而非 O(总大小)。OopTable 和 MetadataTable 的索引都偏置 1（索引 0 保留给 NULL），这是 JVM 内部约定——0 表示'没有'，节省一个 NULL 检查分支。"

### Beginner Callout Boxes（≥7，必须出现在文档中）

1. **CodeBlob vs nmethod vs CodeBlob**: CodeBlob = 所有 CodeCache 中对象的基类（包括 RuntimeStub、BufferBlob、nmethod 等）。nmethod = JIT 编译的 Java 方法的 CodeBlob 子类。CodeBlobType = 枚举类型（MethodNonProfiled=0, MethodProfiled=1, NonNMethod=2），决定分配到哪个 CodeHeap。新手常混淆这三个概念——CodeBlob 是"是什么"，CodeBlobType 是"去哪"。

2. **CodeBlobType 枚举 → Heap 映射**: `MethodNonProfiled=0` → Non-Profiled nmethods heap（freelist）。`MethodProfiled=1` → Profiled nmethods heap（freelist）。`NonNMethod=2` → Non-nmethods heap（bump-pointer）。映射逻辑在 `CodeCache::get_code_heap(blob_type)`。分段模式下每个 type 对应独立 heap，非分段模式下全部映射到单一 heap（`All=3`）。

3. **bump-pointer vs freelist 再次强调**: NonNMethod heap 存的全是永不释放的 Blob（解释器、StubRoutines、SingletonBlob）→ bump-pointer 足够。Profiled/NonProfiled heap 存 nmethod（会被 sweep 回收）→ 必须用 freelist。选择 bump-pointer 还是 freelist 不是设计偏好——是生命周期决定的。

4. **frame_complete_offset 和 frame_never_safe**: `frame_complete_offset` 标记栈帧在哪个指令偏移处完全建立。GC 栈遍历时，如果 PC 在 frame_complete_offset 之前，说明栈帧未完全建立，不能安全遍历。`CodeOffsets::frame_never_safe` 表示此 Blob 永远不应被 GC 栈遍历——BufferBlob 和 SingletonBlob 都用这个值，因为它们是"胶水代码"而非 Java 方法。nmethod 的 frame_complete_offset 由编译器计算。

5. **nmethod 偏移链计算**: 构造器中的偏移计算是链式的——每个偏移 = 前一个偏移 + align_up(前区域大小, 对齐粒度)。这保证了各区域不重叠、对齐正确。链式设计使布局由 CodeBuffer 的生成内容自动决定，不需要手动指定每个区域大小。

6. **OopTable 索引偏置 1**: `oop_at(0)` 返回 NULL，`oop_at(1)` 返回数组第 0 个元素。原因是编译器中 oop 索引 0 被保留为"无 oop"标记——节省 NULL 检查。MetadataTable 同样偏置 1。这意味着 `oops_count()` 返回的是实际 oop 数+1。

7. **SingletonBlob vs BufferBlob 的关键区别**: SingletonBlob 有真实栈帧（`frame_size > 0`）和 OopMap——因为去优化/异常/安全点处理需要在栈上保存寄存器状态，GC 需要知道哪些寄存器存了 oop。BufferBlob 的 `frame_size = 0`，`oop_maps = NULL`——纯代码，不需要 GC 感知。

---

## §二 Standard Environment

OpenJDK 11 slowdebug, 64-bit Linux.

Source roots:
- `src/hotspot/share/code/codeBlob.hpp:38-47` — CodeBlobType enum（5 种类型）
- `src/hotspot/share/code/codeBlob.hpp:49-81` — 继承树注释（14 种子类型）
- `src/hotspot/share/code/codeBlob.hpp:86-246` — CodeBlob 基类（所有字段 + 构造函数）
- `src/hotspot/share/code/codeBlob.hpp:248-337` — CodeBlobLayout 布局计算辅助类
- `src/hotspot/share/code/codeBlob.hpp:340-462` — RuntimeBlob + BufferBlob + AdapterBlob + VtableBlob + MethodHandlesAdapterBlob
- `src/hotspot/share/code/codeBlob.hpp:468-727` — RuntimeStub + SingletonBlob + DeoptimizationBlob + UncommonTrapBlob + ExceptionBlob + SafepointBlob
- `src/hotspot/share/code/codeBlob.cpp:65-74` — CodeBlob::allocation_size（总大小计算）
- `src/hotspot/share/code/codeBlob.cpp:76-133` — CodeBlob 两个构造函数
- `src/hotspot/share/code/codeBlob.cpp:223-268` — BufferBlob::create + operator new
- `src/hotspot/share/code/codeBlob.cpp:389-400` — RuntimeStub + SingletonBlob operator new
- `src/hotspot/share/code/nmethod.hpp:55-119` — nmethod 所有字段声明
- `src/hotspot/share/code/nmethod.hpp:273-380` — nmethod 边界访问器 + oop_at/metadata_at/scope_desc_at
- `src/hotspot/share/code/compiledMethod.hpp:134-170` — CompiledMethod 基类位字段
- `src/hotspot/share/code/nmethod.cpp:645-800` — nmethod 构造器偏移计算（核心！11 步偏移链）
- `src/hotspot/share/runtime/sharedRuntime.cpp:82-97` — 全局 Blob 实例声明
- `src/hotspot/share/runtime/sharedRuntime.cpp:101-136` — generate_stubs() 创建序列

Build: `make jdk`
Key binary: `build/linux-x86_64-normal-server-slowdebug/jdk/lib/server/libjvm.so`

---

## §三 Source Files Table

| # | File | Full Path | Lines | Core Functions | Role |
|---|------|-----------|:--:|-------|------|
| 1 | **codeBlob.hpp** | `src/hotspot/share/code/codeBlob.hpp` | ~750 | CodeBlobType enum, CodeBlob 基类, CodeBlobLayout, 14 种子类型声明 | 🔥 类型系统定义——所有 Blob 的类声明和继承关系 |
| 2 | **codeBlob.cpp** | `src/hotspot/share/code/codeBlob.cpp` | ~500 | CodeBlob 构造, allocation_size, BufferBlob::create, operator new 分发 | 🔥 分配策略——operator new → CodeCache::allocate(blob_type) |
| 3 | **nmethod.hpp** | `src/hotspot/share/code/nmethod.hpp` | ~650 | nmethod 所有字段 + 边界访问器 + oop_at/metadata_at | 🔥 nmethod 完整字段声明 + 区域边界计算方法 |
| 4 | **nmethod.cpp** | `src/hotspot/share/code/nmethod.cpp` | ~2600 | nmethod 构造器偏移计算（645-800行，11步偏移链） | 🔥 核心！偏移链计算是理解 nmethod 布局的关键 |
| 5 | **compiledMethod.hpp** | `src/hotspot/share/code/compiledMethod.hpp` | ~450 | CompiledMethod 基类位字段 + ExceptionCache + PcDescContainer | nmethod 基类——4 个位字段 + 去优化标记 |
| 6 | **sharedRuntime.cpp** | `src/hotspot/share/runtime/sharedRuntime.cpp` | ~3000 | 全局 Blob 实例声明（82-97行）+ generate_stubs()（101-136行） | 全局单例 Blob 的创建位置 |
| 7 | **codeCache.hpp** | `src/hotspot/share/code/codeCache.hpp` | ~350 | get_code_blob_type(), get_code_heap() | CodeBlobType → Heap 映射逻辑 |

---

## §四 Deep Dive Question Groups（≥6）

### 4.1 ★★★ CodeBlob 完整继承树

问：CodeCache 中所有 CodeBlob 子类的完整继承关系是什么？每种子类在哪个 CodeHeap 中分配？

答案方向：读取 `codeBlob.hpp:49-81` 的继承树注释 + `codeBlob.hpp:38-47` 的 CodeBlobType 枚举。

继承树（14 种叶子类型）：
```
CodeBlob
├── RuntimeBlob（非编译代码）
│   ├── BufferBlob（纯代码容器，无栈帧）
│   │   ├── AdapterBlob（C2I/I2C 适配器）
│   │   ├── VtableBlob（虚方法表桩块）
│   │   └── MethodHandlesAdapterBlob（MethodHandle 适配器）
│   ├── RuntimeStub（有栈帧，编译代码→C++ 桥接）
│   └── SingletonBlob（全局唯一实例，有栈帧+OopMap）
│       ├── DeoptimizationBlob（去优化处理，5 个入口偏移）
│       ├── UncommonTrapBlob（仅 C2，不常见陷阱）
│       ├── ExceptionBlob（仅 C2，异常栈展开）
│       └── SafepointBlob（安全点轮询，3 个实例）
└── CompiledMethod（编译方法）
    ├── nmethod（JIT 编译的 Java 方法）
    └── AOTCompiledMethod（AOT 编译，不在 CodeCache）
```

分配策略：
- 所有 RuntimeBlob 子类 → `CodeCache::allocate(size, CodeBlobType::NonNMethod)` → NonNMethod heap（bump-pointer）
- nmethod → `CodeCache::allocate(size, get_code_blob_type(comp_level))` → Profiled 或 NonProfiled heap（freelist）

追问：BufferBlob 和 SingletonBlob 的核心区别是什么？
→ BufferBlob 无栈帧（`frame_size=0`）、无 OopMap（`_oop_maps=NULL`）——纯代码容器。SingletonBlob 有真实栈帧（`frame_size>0`）和 OopMap——因为去优化/异常/安全点处理需要保存寄存器状态，GC 需要 OopMap 来扫描栈上的 oop。

反事实：如果所有 Blob 类型都混在一个 Heap 中（不区分 NonNMethod/Profiled/NonProfiled）？
→ 永不释放的 SingletonBlob 和 BufferBlob 卡在中间 → nmethod 释放后的空洞无法被 bump-pointer 绕过 → 碎片化 → 明明总空闲够但连续空间不足 → CodeCache full 更早触发。三段设计把"永久"和"可回收"对象隔离，是碎片化防御的第一道防线。

### 4.2 ★★★ CodeBlobType → Heap 映射机制

问：`CodeBlobType` 枚举的 5 个值如何映射到具体的 CodeHeap？`get_code_blob_type(comp_level)` 如何根据编译层级决定 nmethod 的 heap？

答案方向：`codeCache.hpp` 中的 `get_code_heap(blob_type)` 和 `get_code_blob_type(comp_level)`。

`get_code_blob_type(comp_level)` 映射逻辑（`codeCache.cpp`）:
- `CompLevel_none` → `MethodNonProfiled`（native 方法）
- `CompLevel_simple`（C1 tier1）→ `MethodNonProfiled`
- `CompLevel_limited_profile`（C1 tier2）→ `MethodProfiled`
- `CompLevel_full_profile`（C1 tier3）→ `MethodProfiled`
- `CompLevel_full_optimization`（C2 tier4）→ `MethodNonProfiled`

关键洞察：tier1 和 tier4 都在 NonProfiled heap——因为 tier1 是"不收集 profile"的 C1 代码，tier4 是"profile 已用完"的 C2 代码。tier2 和 tier3 在 Profiled heap——因为它们的代码包含 profiling 逻辑。

追问：如果 `!SegmentedCodeCache`（非分段模式），所有 Blob 去哪？
→ `All=3` → 所有 Blob 分配到单一 heap。此时 `get_code_heap(All)` 返回唯一的 heap。

反事实：如果 tier1 和 tier4 分在不同 heap？
→ tier1→tier4 升级时 nmethod 需要跨 heap 迁移 → 需要复制代码和元数据 → 复杂性和性能开销大增。当前设计让升级只涉及 freelist 操作（在同一个 heap 内），不需要跨 heap 移动。

### 4.3 ★★★ CodeBlobLayout — 布局计算辅助类

问：`CodeBlobLayout` 类如何计算 CodeBlob 的内存布局？三种构造器分别对应什么场景？

答案方向：`codeBlob.hpp:248-337`。

三种构造器对应三种 Blob 创建场景：
1. **原始地址构造器**（`codeBlob.hpp:264-275`）：直接传入 code_begin/code_end/content_begin 等地址——用于已有代码缓冲区的 Blob（如 BufferBlob 从裸内存创建）
2. **原始偏移构造器**（`codeBlob.hpp:278-298`）：传入 start 地址 + size/header_size/relocation_size/data_offset——用于简单 Blob（BufferBlob），没有复杂的 CodeBuffer
3. **CodeBuffer 构造器**（`codeBlob.hpp:301-317`）：传入 CodeBuffer——用于完整 Blob（RuntimeStub、nmethod），CodeBuffer 包含 insts/stubs/consts/oop 等完整区域信息

布局计算逻辑：
- `_content_offset = align_code_offset(_header_size + _relocation_size)` — content 区域起始（跳过 header+relocation）
- `_code_offset = _content_offset + cb->total_offset_of(insts)` — 代码区域起始
- `_data_offset = _content_offset + align_up(cb->total_content_size(), oopSize)` — data 区域起始（content 结束）

追问：`align_code_offset()` 和普通 `align_up()` 有什么区别？
→ `align_code_offset()` 对齐到 `CodeEntryAlignment`（通常是 32 字节），确保代码入口点满足 CPU 的指令对齐要求。普通 `align_up()` 对齐到 `oopSize`（8 字节）或 `wordSize`。

### 4.4 ★★★ nmethod 偏移链计算 — 11 步构造

问：nmethod 构造器中 14 个偏移字段如何顺序计算？每一步计算依赖什么？为什么是链式的？

答案方向：`nmethod.cpp:693-754`，11 步偏移计算：

```
Step 1:  _consts_offset           = content_offset() + consts_size          // 常量区：doubles/longs/floats
Step 2:  _stub_offset             = content_offset() + stubs_size           // 桩代码区
Step 3:  _exception_offset        = _stub_offset + Exceptions_offset        // 异常处理器（在 stub 区内）
Step 4:  _oops_offset             = data_offset()                           // OopTable 起始 = data 区开始
Step 5:  _metadata_offset         = _oops_offset + align_up(oop_size, 8)   // MetadataTable 起始
Step 6:  scopes_data_offset       = _metadata_offset + align_up(metadata_size, 8)  // 局部变量！
Step 7:  _scopes_pcs_offset       = scopes_data_offset + align_up(data_size, 8)    // PcDesc 表
Step 8:  _dependencies_offset     = _scopes_pcs_offset + adjust_pcs_size(pcs_size) // 依赖编码
Step 9:  _handler_table_offset    = _dependencies_offset + align_up(dep_size, 8)   // 异常处理器表
Step 10: _nul_chk_table_offset    = _handler_table_offset + align_up(handler_size) // 空指针检查表
Step 11: _nmethod_end_offset      = _nul_chk_table_offset + align_up(nul_chk_size) // nmethod 结束
```

关键点：
- `data_offset()` 是 content 区域结束的边界——OopTable 从这里开始
- 每一步 = 前一步 + align_up(前一区域大小, 对齐粒度)
- `scopes_data_offset` 是局部变量（不是成员），因为 `_scopes_data_begin` 存在 CompiledMethod 基类中
- `adjust_pcs_size()` 确保 PcDesc 表大小同时是 `oopSize` 和 `sizeof(PcDesc)` 的倍数

追问：为什么 OopTable 起始 = data_offset()？data_offset 是怎么来的？
→ `data_offset() = _content_offset + align_up(total_content_size, oopSize)`——content 区域（代码+常量+桩）结束后，第一个 data 区域就是 OopTable。OopTable 存的是嵌入 oop 指针（如静态字段引用），GC 直接扫描这个指针数组。

反事实：如果偏移不是链式计算而是硬编码？
→ 每个区域的起始位置固定 → 但不同方法生成的代码大小差异巨大（HashMap.getNode ~2KB vs 简单 getter ~128B）→ 硬编码要么浪费空间（固定大区域），要么放不下（固定小区域）。链式计算让布局自适应代码大小，不浪费也不溢出。

### 4.5 ★★★ nmethod 内部区域详解

问：nmethod 的 12 个内存区域各存储什么数据？GC、异常处理、栈回溯分别访问哪些区域？

答案方向：

| 区域 | 存储内容 | 访问者 |
|------|---------|--------|
| Header | nmethod C++ 对象（所有偏移字段在此） | 所有操作 |
| Relocation | 重定位信息（代码中的地址需要修正的指令位置） | GC 移动对象后更新嵌入地址 |
| Constants | doubles/longs/floats 常量池 | 代码执行时 PC 相对寻址 |
| Code | JIT 编译的机器码 | CPU 执行 |
| Stubs | 异常处理器 + 去优化处理器（在 stub 区内的固定偏移） | 异常/去优化触发时 |
| OopTable | 嵌入 oop 指针数组（静态字段引用、Class 引用、String 常量） | GC 扫描（oops_do） |
| MetadataTable | 嵌入 Metadata* 数组（Method*、ConstantPool* 等） | GC/类卸载 |
| ScopesData | DebugInfo（压缩的 scope 数据：方法、BCI、局部变量、表达式栈） | ScopeDesc 解码 |
| PcDesc | PC→scope 映射表（每个 safepoint 一个条目） | 栈回溯、去优化 |
| Dependencies | 依赖断言编码（类层次、方法覆盖等） | 类加载时检查 |
| HandlerTable | 异常处理器 BCI→PC 映射表 | 异常抛出时查找 handler |
| NulChkTable | 隐式空指针/除零异常的 PC→handler 映射表 | 信号处理器 |

追问：GC 扫描 nmethod 时访问哪些区域？
→ `nmethod::oops_do()` 访问两个区域：
1. OopTable：`oops_begin()` 到 `oops_end()`——遍历指针数组，跳过 `Universe::non_oop_word()` 标记的槽位
2. 代码中的立即 oop（inline oops）：通过 `RelocIterator` 遍历重定位表，找到 `oop_type` 重定位条目

GC 不扫描 Constants/Code/ScopesData/PcDesc/Dependencies/HandlerTable——这些区域不含 oop 指针。分区布局使 GC 扫描 O(嵌入对象数) 而非 O(总 nmethod 大小)。

### 4.6 ★★★ CompiledMethod 位字段

问：CompiledMethod 基类的 4 个位字段（`_has_unsafe_access`、`_has_method_handle_invokes`、`_lazy_critical_native`、`_has_wide_vectors`）和 `_is_far_code` 各有什么用途？

答案方向：`compiledMethod.hpp:146-154`。

- `_has_unsafe_access:1`：nmethod 可能因 unsafe 内存访问触发 fault（如 `Unsafe.putLong` 访问非法地址）。信号处理器需要知道这个标记——如果 fault PC 在此 nmethod 中且此标记为 true → 可能是 unsafe 访问 → 抛出异常而非崩溃。
- `_has_method_handle_invokes:1`：包含 MethodHandle 调用。MethodHandle 的去优化路径不同——需要 `_deopt_mh_handler_begin` 入口。
- `_lazy_critical_native:1`：JNI critical native 的延迟模式。Critical native 在 native 执行期间阻止 GC——此标记控制何时释放 GC 锁。
- `_has_wide_vectors:1`：使用了 AVX-512 等宽向量寄存器。Safepoint 时需要保存/恢复这些寄存器——此标记告诉 safepoint handler 是否需要保存宽向量状态。
- `_is_far_code`：代码是否远离 CodeCache（需要远跳转指令）。AOT 代码可能不在 CodeCache 内——标记为 true 时使用 `far_call` 而非 `call`。

追问：为什么用位字段（`:1`）而不是 bool？
→ 4 个 bool 需要 4 字节（对齐后可能 8 字节）。4 个位字段只需要 1 个 int（4 字节）——每个 nmethod 节省 4 字节，数百万个 nmethod 节省数 MB。

### 4.7 ★★★ nmethod 入口点三重奏

问：nmethod 的 `_entry_point`、`_verified_entry_point`、`_osr_entry_point` 三个入口点的区别是什么？

答案方向：`nmethod.hpp:91-93`。

- `_entry_point`：标准入口——包含类检查。调用者跳转到此后，nmethod 先检查调用者的类是否与编译时假设的类匹配。不匹配 → 触发去优化（回解释器重新分派）。
- `_verified_entry_point`：已验证入口——无类检查。C2 内联后的直接调用使用此入口——编译器已证明调用者的类正确，跳过检查节省一个分支。
- `_osr_entry_point`：OSR（On-Stack Replacement）入口——从解释器跳到编译代码的中间位置（非方法开头）。用于长时间运行的循环——方法已被调用但尚未结束，需要"替换栈帧"进入编译代码。

追问：`entry_point()` 和 `verified_entry_point()` 在什么情况下不同？
→ 当 `method()->is_static()` 或方法被声明为 final 时——调用者的类只能是声明类 → 类检查恒为真 → 两个入口相同。当方法是虚方法时——调用者可能是子类 → `entry_point()` 包含类检查（cmp + jne → deopt），`verified_entry_point()` 跳过。

---

## §五 Article Structure

```
§〇 生产场景 — jcmd CodeHeap_Analytics 查看 Blob 类型分布 + nmethod 布局诊断
  ★ Part A: NonNMethod heap 中 8+ 种 Blob 类型的混合存储
  ★ Part B: nmethod 12 个内部区域 + 14 个偏移字段
  ★ 反事实: 如果不分区域 → GC 全量扫描 + 误将整数当指针

§一 ★★★ CodeBlob 继承体系 + nmethod 内存布局全链路源码走读
  1.1 CodeBlobType 枚举 → Heap 映射表（MethodNonProfiled=0, MethodProfiled=1, NonNMethod=2, All=3, AOT=4）
  1.2 CodeBlob 基类 — 所有字段 + CodeBlobLayout 布局计算
  1.3 ★ Mermaid: 完整继承树（14 种叶子类型 + CodeBlobType → Heap 映射）
  1.4 Part A: RuntimeBlob 分支
      1.4.1 BufferBlob（无栈帧、无 OopMap、bump-pointer）→ AdapterBlob/VtableBlob/MethodHandlesAdapterBlob
      1.4.2 RuntimeStub（有栈帧+OopMap）→ operator new → NonNMethod heap
      1.4.3 SingletonBlob（全局唯一实例）→ DeoptimizationBlob/UncommonTrapBlob/ExceptionBlob/SafepointBlob
  1.5 Part B: nmethod 分支
      1.5.1 ★ ASCII Art: nmethod 12 区域内存布局图（Header→Relocation→Constants→Code→Stubs→OopTable→MetadataTable→ScopesData→PcDesc→Dependencies→HandlerTable→NulChkTable）
      1.5.2 构造器中 11 步偏移计算源码（nmethod.cpp:693-754）
      1.5.3 各区域详解表（存什么 + 谁访问 + 为什么分区）
      1.5.4 OopTable + MetadataTable 索引偏置 1 机制
      1.5.5 nmethod 入口点三重奏（entry/verified_entry/osr_entry）
      1.5.6 CompiledMethod 基类位字段（_has_unsafe_access 等 4 个 :1 字段）
  1.6 operator new 分发链 — 所有 Blob 如何通过 CodeCache::allocate(blob_type) 进入正确的 Heap
  1.7 ★ 面试 Story Format 答案

§二 ★★★ 7 Beginner Callout 框（在 §一 内 inline）

§三 ★★ 异常路径分析
  3.1 SingletonBlob 分配失败 → fatal("Initial size of CodeCache is too small") → JVM 无法启动
  3.2 nmethod 偏移计算中某区域对齐溢出 → assertion 失败（debug build）→ 未定义行为（product build）
  3.3 CodeBlobType 映射错误 → nmethod 分配到错误的 heap → 碎片化 + 扩容策略失效

§四 ★ GDB 断点验证 — 8 断点
  断言 1: CodeBlobType 映射 — break CodeCache::allocate, print blob_type
  断言 2: BufferBlob::create — break codeBlob.cpp create, print name + buffer_size
  断言 3: SingletonBlob operator new — break codeBlob.cpp SingletonBlob::operator new
  断言 4: DeoptimizationBlob 入口偏移 — break deoptimization.cpp unpack_frames
  断言 5: nmethod 构造器偏移链 — break nmethod.cpp constructor, print each offset
  断言 6: nmethod OopTable 扫描 — break nmethod::oops_do, print oops_count
  断言 7: nmethod entry_point vs verified_entry_point — break nmethod constructor, print both
  断言 8: CompiledMethod 位字段 — break compiledMethod init_defaults, print _has_unsafe_access 等

§五 ★ Cross-Reference
  → 01-CodeCache.md: 三段堆架构（NonNMethod/Profiled/NonProfiled）、segmap、freelist、sweeper
  → 01c-nmethod-Runtime-Queries.md: 异常处理 + PC→Scope 映射 + 去优化入口
  → 01d-nmethod-Dependencies-IC.md: 依赖管理 + Inline Cache
  → 09-Interpreter-Init: 解释器 Codelet 是 BufferBlob 的子类
  → 12-CompileBroker-Init: nmethod 构造由 CompileBroker 触发
```

---

## §六 Writing Requirements

### 不要写成 → 应该写成

| 不要写成 | 应该写成 |
|---------|---------|
| "CodeBlob 有很多子类" | "继承树分两大分支：RuntimeBlob（BufferBlob→AdapterBlob/VtableBlob/MethodHandlesAdapterBlob + RuntimeStub + SingletonBlob→DeoptimizationBlob/UncommonTrapBlob/ExceptionBlob/SafepointBlob）和 CompiledMethod（nmethod + AOTCompiledMethod）。CodeBlobType 枚举的 5 个值（MethodNonProfiled=0, MethodProfiled=1, NonNMethod=2, All=3, AOT=4）决定分配到哪个 CodeHeap" |
| "BufferBlob 是代码容器" | "BufferBlob(name, size) 构造时 frame_size=0, oop_maps=NULL, frame_complete=frame_never_safe——纯代码容器，无 GC 感知。operator new → CodeCache::allocate(size, NonNMethod) → NonNMethod heap bump-pointer 分配" |
| "nmethod 有多个区域" | "nmethod 构造器中 11 步偏移链：_consts_offset = content_offset() + consts_size → _stub_offset → _oops_offset = data_offset() → _metadata_offset → scopes_data_offset → _scopes_pcs_offset → _dependencies_offset → _handler_table_offset → _nul_chk_table_offset → _nmethod_end_offset。每一步 = 前一步 + align_up(前一区域大小)" |
| "OopTable 存 oop" | "OopTable 是 (oop*)(header_begin() + _oops_offset) 到 (oop*)(header_begin() + _metadata_offset) 的指针数组。索引偏置 1：oop_at(0) 返回 NULL，oop_at(1) 返回数组第 0 个元素。GC 的 oops_do() 遍历此数组，跳过 Universe::non_oop_word() 标记的槽位" |
| "SingletonBlob 是全局唯一的" | "DeoptimizationBlob(code_begin + _unpack_offset) 是去优化入口，code_begin + _unpack_with_exception 是异常路径去优化入口，code_begin + _unpack_with_reexecution 是重执行去优化入口——5 个入口偏移对应 5 种去优化场景（含 JVMCI 的 uncommon_trap + implicit_exception_uncommon_trap）。SafepointBlob 有 3 个实例（vectors/loop/return），每个处理不同位置的安全点轮询" |

---

## §七 Output Format

路径: `/data/workspace/openjdk-cut-new/probe_md/01-jvm-startup/docs/01b-CodeBlob-Taxonomy-nmethod-Layout.md`

元信息头:
```
> **阶段**：[01-jvm-startup]
> **前置**：[01-CodeCache]（三段堆架构、segmap、freelist、sweeper——本文展开 CodeBlob 存储层）
> **配套**：[01c-nmethod-Runtime-Queries]（异常处理 + PC→Scope 映射 + 去优化入口）、[01d-nmethod-Dependencies-IC]（依赖管理 + Inline Cache）
> **后续依赖本文**：[09-Interpreter-Init]（解释器 Codelet 是 BufferBlob 子类）、[12-CompileBroker-Init]（编译任务产出 nmethod）
> **阅读收益**：掌握 CodeBlob 14 种子类型的完整继承树和分配策略（CodeBlobType→Heap 映射）、nmethod 的 12 区域二进制布局和 11 步偏移链计算、OopTable/MetadataTable 的索引偏置和 GC 扫描路径、SingletonBlob 5 个入口偏移的用途
```

---

## §八 Prohibited（≥8）

- ❌ 不画完整的 CodeBlob 继承树图 → 必须有 Mermaid 图展示 14 种叶子类型 + CodeBlobType 映射
- ❌ 不展示 nmethod 构造器的 11 步偏移计算源码 → 必须逐行粘贴并注释每一步的依赖
- ❌ 不解释 CodeBlobType 枚举 → Heap 映射 → 必须展示 get_code_heap() 和 get_code_blob_type() 的分发逻辑
- ❌ 不对比 BufferBlob vs SingletonBlob vs RuntimeStub 的 frame_size/OopMap 差异 → 必须有对比表
- ❌ 不解释 OopTable 索引偏置 1 → 必须展示 oop_at(0) 返回 NULL 的源码
- ❌ 不画 nmethod 12 区域内存布局 ASCII Art → 必须有从低地址到高地址的完整布局图
- ❌ 不展示 operator new → CodeCache::allocate(blob_type) 的分发链 → 必须粘贴各 Blob 类型的 operator new 源码
- ❌ 不解释 4 个 CompiledMethod 位字段的用途 → 必须有 _has_unsafe_access 等字段的场景说明
- ❌ 不解释 DeoptimizationBlob 的 5 个入口偏移各对应什么场景 → 必须列 unpack/unpack_with_exception/unpack_with_reexecution/unpack_with_exception_in_tls/uncommon_trap/implicit_exception_uncommon_trap 的用途
- ❌ 不解释 nmethod 三个入口点的区别 → 必须有 entry/verified_entry/osr_entry 的对比

---

## §九 Required（≥8）

- ✅ ★ Mermaid CodeBlob 完整继承树图（14 种叶子类型 + CodeBlobType→Heap 映射箭头）
- ✅ ★ nmethod 12 区域内存布局 ASCII Art（从 Header 到 NulChkTable 的地址递增布局）
- ✅ ★ nmethod 构造器 11 步偏移计算源码（nmethod.cpp:693-754 逐行注释）
- ✅ ★ BufferBlob vs SingletonBlob vs RuntimeStub 对比表（frame_size/OopMap/operator new/Heap）
- ✅ ★ CodeBlobType 枚举 → Heap 映射表 + get_code_blob_type(comp_level) 分发逻辑
- ✅ ★ operator new 分发链源码（BufferBlob/RuntimeStub/SingletonBlob 三种 operator new）
- ✅ ★ DeoptimizationBlob 5 个入口偏移表（偏移名 + 场景 + 调用者）
- ✅ ★ 面试 Story Format 答案（Part A + Part B 各一段）
- ✅ ★ GDB 断点 ≥8 条
- ✅ ★ 7 个 Beginner Callout 框

---

## §十 GDB Verification（≥7 assertions）

```
断言 1: CodeBlobType → Heap 映射 (codeCache.cpp allocate)
  (gdb) break CodeCache::allocate
  (gdb) print blob_type → 期望: 0(MethodNonProfiled) / 1(MethodProfiled) / 2(NonNMethod)
  (gdb) print heap->name() → 期望: 对应 heap 名称

断言 2: BufferBlob::create 分配 (codeBlob.cpp:223)
  (gdb) break codeBlob.cpp:223
  (gdb) print name → 期望: "Interpreter" / "StubRoutines" 等
  (gdb) print buffer_size → 期望: 对应大小
  (gdb) continue 经过 operator new
  (gdb) print blob → 期望: 非 NULL

断言 3: SingletonBlob::operator new → NonNMethod heap (codeBlob.cpp:389)
  (gdb) break codeBlob.cpp:389
  (gdb) print size → 期望: sizeof(SingletonBlob子类) + code_size
  (gdb) stepi 进入 CodeCache::allocate
  (gdb) print blob_type → 期望: 2 (NonNMethod)

断言 4: DeoptimizationBlob 入口偏移验证
  (gdb) break SharedRuntime::generate_deopt_blob (sharedRuntime.cpp)
  (gdb) print _deopt_blob->_unpack_offset → 期望: 非零有效偏移
  (gdb) print _deopt_blob->unpack() → 期望: code_begin() + _unpack_offset

断言 5: nmethod 构造器偏移链 (nmethod.cpp:693)
  (gdb) break nmethod.cpp:693
  (gdb) print _consts_offset → 期望: > sizeof(nmethod)
  (gdb) print _stub_offset → 期望: > _consts_offset
  (gdb) print _oops_offset → 期望: data_offset()
  (gdb) print _metadata_offset → 期望: > _oops_offset
  (gdb) print _nmethod_end_offset → 期望: == total_size

断言 6: nmethod OopTable GC 扫描 (nmethod.cpp oops_do)
  (gdb) break nmethod::oops_do
  (gdb) print oops_count() → 期望: >= 1 (至少有一个 NULL 哨兵)
  (gdb) print oops_begin()[0] → 期望: oop 或 Universe::non_oop_word()

断言 7: nmethod entry_point vs verified_entry_point
  (gdb) break nmethod.cpp constructor (after entry points set)
  (gdb) print _entry_point → 期望: code_begin() + offsets->value(Entry)
  (gdb) print _verified_entry_point → 期望: code_begin() + offsets->value(Verified_Entry)
  (gdb) print (_entry_point == _verified_entry_point) → 期望: static/final 方法时为 true

断言 8: CompiledMethod 位字段初始化 (compiledMethod.cpp init_defaults)
  (gdb) break compiledMethod.cpp:58
  (gdb) print _has_unsafe_access → 期望: 0
  (gdb) print _has_method_handle_invokes → 期望: 0
  (gdb) print _lazy_critical_native → 期望: 0
  (gdb) print _has_wide_vectors → 期望: 0
  (gdb) print _is_far_code → 期望: false
```

---

## §十一 Continuity

- 01-CodeCache.md 的 §1.1-1.3 覆盖了三段堆架构和分配策略 → 本文展开 CodeBlob 类型系统和 nmethod 内部布局
- 01c-nmethod-Runtime-Queries.md 将覆盖异常处理（ExceptionCache + HandlerTable）、PC→Scope 映射（PcDesc + ScopeDesc）、去优化入口（DeoptimizationBlob 的实际调用链）
- 01d-nmethod-Dependencies-IC.md 将覆盖依赖管理（Dependencies + DependencyContext）和 Inline Cache（CompiledIC + StubQueue）
- 后续依赖：09-Interpreter-Init 中解释器 Codelet 的分配使用 BufferBlob；12-CompileBroker-Init 中编译结果以 nmethod 形式提交到 CodeCache
