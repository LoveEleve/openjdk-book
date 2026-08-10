# Prompt-02: Dependencies, IC & Exceptions — libjvm.so (code/)

## §〇 Production Scenario

**场景 1: 类进化触发 JIT 代码失效**  
线上应用通过 JMX 动态加载了新 jar，其中包含 `AbstractParser` 的新子类 `FasterParser`。先前 C2 编译了 `unique_concrete_method(AbstractParser, Parser::parse)` 依赖。新类加载后，JVM 调用 `Dependencies::check_unique_concrete_method()` 发现 witness class，将 nmethod 标记为 `not_entrant` → 下次 safepoint 被 sweeper 回收。用户观察到 JIT 重编译的 CPU 尖峰。诊断：`jcmd <pid> Compiler.CodeHeap_Analytics` + `-XX:+PrintCompilation`

**场景 2: IC stub 从单态退化为超多态**  
高频调用点 `list.get(i)` 被 C2 编译为 `monomorphic IC stub` 指向 `ArrayList.get()`。运行时遇到 `LinkedList` 实例 → IC 从 monomorphic → megamorphic → vtable dispatch。IC stub 在 `compiledIC.cpp:168-194` 执行 `set_to_megamorphic()` 原子补丁。诊断：`jcmd <pid> Compiler.CodeCache` 观察 non-entrant nmethod 比例 + `-XX:+PrintInlining`

**场景 3: 异常路径未覆盖导致 deopt**  
nmethod 不含 exception handler → 抛出时走 `SharedRuntime::exception_handler_for_return_address()` → 检查 `nmethod::handler_table_begin()` → 不在表中 → deoptimize。诊断：`strace -e write` 验证 `Uncommon trap` handler 写入 + `jstack` 确认 deopt 线程

---

## §一 Task + Narrative + Beginner Callouts

**任务**：深度分析 HotSpot dependencies system、compiled inline cache (IC) 和 exception handler table 三个紧密关联的 nmethod metadata 子系统。

**叙事线索**：  
JIT 编译器产生时，在 nmethod 中嵌入三类断言数据："我假设什么" (dependencies)、"如果调用目标变了怎么办" (IC stubs)、"异常发生时跳到哪里" (exception handler table)。运行时当这些断言被违反，需要原地纠正 (IC patching) 或废弃重编译 (dependency deopt)。

**7 个 Beginner Callout**：
1. Dependency 是"编译时乐观假设的运行时保证"——不是运行时校验，而是变更时的失效通知
2. IC (Inline Cache) 不是 JVM 解释器的专利——编译代码也有 IC stubs，只是补丁目标从 Method* 变成 NativeJump
3. exception handler table 不走 C++ 的 try/catch——全手工编码紧凑格式，汇编层跳转
4. DepChange 的 mark_for_deoptimization 不立即废弃 nmethod——只是设置标记，实际废弃在下一个 safepoint
5. compiledIC::set_to_megamorphic() 写入什么？——写入 vtable dispatch 指令 (5 字节 call)，替换原来的 direct call
6. exceptionHandlerTable 的编码按 bci 排序——二分查找 O(log n)
7. 三个子系统共享同一个 nmethod metadata section——dependencies_begin→dependencies_end→handler_table_begin→handler_table_end

---

## §二 Standard Environment

**Source roots**：
```
src/hotspot/share/code/dependencies.cpp        ← dependencies.hpp:1
src/hotspot/share/code/dependencyContext.cpp    ← dependencyContext.hpp:1
src/hotspot/share/code/compiledIC.cpp           ← compiledIC.hpp:1
src/hotspot/share/code/icBuffer.cpp             ← icBuffer.hpp:1
src/hotspot/share/code/exceptionHandlerTable.cpp ← exceptionHandlerTable.hpp:1
```

**Build**：
```bash
bash configure --with-debug-level=slowdebug
make jdk -j$(nproc)
```

**Binary**：`build/linux-x86_64-normal-server-slowdebug/jdk/lib/server/libjvm.so`

**Build entry**：`make/hotspot/lib/CompileJvm.gmk:153 BUILD_LIBJVM`

**Syscall 速查表**：

| Syscall | 用途 | man |
|---------|------|-----|
| write(2) | NativeJump::patch_verified_entry() | man 2 write |
| mprotect(2) | ICBuffer::finalize_stubs() 代码页 W^X 切换 | man 2 mprotect |
| futex(2) | DepChange GC safepoint 同步 | man 2 futex |

**全局状态表**：

| 变量 | 位置 | 类型 | 说明 |
|------|------|------|------|
| `nmethod::_dependencies` | nmethod.hpp | address | 依赖编码起始指针 |
| `nmethod::_handler_table` | nmethod.hpp | address | 异常表起始指针 |
| `CompiledIC::_ic_call` | compiledIC.hpp | NativeCall* | 当前 IC 调用指令 |
| `ICBuffer::_buffer` | icBuffer.cpp | address | IC stub 缓冲区 |
| `DependencyContext::_dependency_context_addr` | dependencyContext.hpp | nmethod** | 依赖链表头指针字段在 nmethod 中的偏移 |

---

## §三 Source Files Table

| File | Full Path | Lines | Core Constructs | Role |
|------|-----------|:-----:|----------------|------|
| dependencies.hpp | src/hotspot/share/code/dependencies.hpp | 815 | DepType enum (13类型), DepStream::next(), Dependencies::check_*, DepChange | 依赖断言定义+验证 |
| dependencies.cpp | src/hotspot/share/code/dependencies.cpp | 2185 | check_* 实现, DepStream::next(), encode_content_bytes() | 依赖断言运行时验证 |
| dependencyContext.hpp | src/hotspot/share/code/dependencyContext.hpp | 154 | DependencyContext::add_dependent_nmethod(), remove_all_dependents() | 依赖上下文管理器 |
| dependencyContext.cpp | src/hotspot/share/code/dependencyContext.cpp | 273 | add_dependent_nmethod() 原子插入, find_dependency() | 链表原子操作 |
| compiledIC.hpp | src/hotspot/share/code/compiledIC.hpp | 437 | CompiledIC::set_to_monomorphic(), set_to_megamorphic(), set_to_clean() | IC stub 补丁接口 |
| compiledIC.cpp | src/hotspot/share/code/compiledIC.cpp | 720 | set_to_megamorphic() 指令生成, is_optimized(), compute_monomorphic_entry() | IC 原子补丁实现 |
| icBuffer.hpp | src/hotspot/share/code/icBuffer.hpp | 146 | ICBuffer::initialize(), add_stub() | IC stub 缓冲区管理 |
| icBuffer.cpp | src/hotspot/share/code/icBuffer.cpp | 234 | add_stub() 分配, finalize_stubs() 权限切换 | stub 分配/提交 |
| exceptionHandlerTable.hpp | src/hotspot/share/code/exceptionHandlerTable.hpp | 166 | ImplicitExceptionTable, ExceptionHandlerTable, HandlerIterator | 异常表编码+解码 |
| exceptionHandlerTable.cpp | src/hotspot/share/code/exceptionHandlerTable.cpp | 231 | add_entry() 变长编码, handler_bci() 二分查找 | 异常表构造+查询 |

---

## §四 Deep Dive Question Groups

### 4.1 Dependencies 类型系统

① Dependencies::DepType 包含 11 个非 marker 类型 (evol_method→call_site_target_value)。逐个解释每个类型表达什么编译期乐观假设？以 `unique_concrete_method` 为例：`dependencies.hpp:141` 声明"CX 下 M1 是唯一的 concrete matching method"，对应 JIT 内联决策中的 receiver profiling 单态结论。

② **Counterfactual**：如果 Dependencies 不区分类型，只用一个通用的 "假设有效" 标志？编译器无法针对性做激进优化——`unique_concrete_method` 允许去虚拟化 (devirtualize)，`leaf_type` 允许 `checkcast` 省略。不区分类型意味着只能做最保守优化，丢失 ~10-20% 性能。

### 4.2 DepStream 状态机解码

① DepStream 如何从 nmethod 的 dependencies 起始地址解码依赖？构造函数 `dependencies.hpp:597-610` 创建 `CompressedReadStream`，`next()` → `dependencies.cpp` 读取 DepType tag → 根据 `dep_args(type)` 确定参数数量 → 逐参数解码 index → `recorded_metadata_at(index)` 从 OopRecorder 还原 Metadata*。`dependencies.cpp` 的具体实现是什么？

② **Counterfactual**：如果 DepStream 每调用一次 next() 都重新解析所有参数（而非累积状态）？当前是一次解析一个依赖 (type + N args)，O(total arguments)。如果每遍都解析全表，遍历 N 个依赖的成本从 O(N) 变成 O(N²)。DepStream 的缓存 `_xi[]` 是性能关键。

### 4.3 依赖检查与 GC 协作

① `Dependencies::check_dependency()` 如何与 GC class hierarchy 变更交互？当 `SystemDictionary::load_instance_class()` 加载新类时 → `KlassDepChange` 被创建 → `Universe::flush_dependents_on(changes)` → 遍历所有 nmethod → 调用 `DepStream::check_dependency()` → 返回 witness Klass* → `nmethod::mark_for_deoptimization()`。`dependencies.cpp` 中 check_klass_dependency 如何通过 is_concrete_klass / find_witness_AME 找到见证者？

② **Counterfactual**：如果依赖检查在每次 safepoint 都全量执行（而非惰性 DepChange）？保守假设：10K nmethod × 平均 5 dep × ~20 CPU cycles ~1ms。但 safepoint 频率 100ms，1ms 开销增加 1% 暂停时间。更关键是检查本身需要扫描 instanceKlass 的 subclass 链表，可能导致 cache thrash。DepChange 的 "only changed classes" 优化将检查范围从 O(all) 降到 O(changed)。

### 4.4 DependencyContext 的 per-nmethod 链表

① DependencyContext 如何在每个 Klass/Method 上维护"依赖我的 nmethod"列表？`dependencyContext.cpp` 的 `add_dependent_nmethod()` 和 `DependencyContext::remove_all_dependents()` 的实现是什么？`_dependency_context_addr` 是在 nmethod 中嵌入的链表 next 指针字段的偏移。链表插入使用 CAS 循环保证并发安全。为什么不能用全局锁保护？

② **Counterfactual**：如果每个 Klass 用一个 GrowableArray 存储依赖者而不用链表？nmethod 可能被 sweeper 回收 → 数组需要元素删除 → O(n)。链表删除只需 CAS 重排 next 指针，O(1)。且链表节点嵌入在 nmethod 内部（`_dependency_next` 字段），不额外分配内存。

### 4.5 IC stub 的状态转换

① compiledIC 的状态机：`set_to_monomorphic()` → `set_to_megamorphic()` → `set_to_clean()`。每个转换在汇编层写什么指令？`compiledIC.cpp:168-194` 的 `set_to_megamorphic()` 如何计算 vtable dispatch 的偏移地址？`set_to_clean()` 只是写入 `nop` 还是 `callee-saved` 的 stub 调用？

② **Counterfactual**：如果 IC 只支持 monomorphic/failed 两态而不用 megamorphic？megamorphic 是单态到超多态的性能中间态——vtable dispatch 比 full deopt 快 ~5-10×，比 monomorphic direct call 慢 ~2×。如果没有 megamorphic，遇到第三条 IC target 就要 deopt + recompile，重编译开销 >> vtable dispatch 开销。megamorphic 是"投降但不自杀"的设计。

### 4.6 IC stub 的原子补丁

① compiledIC 的补丁如何保证其他线程看到一致性视图？NativeJump::patch_verified_entry() → 写入 5 字节 `jmp` 指令 → 是否需要 InstructionCache::flush()？`compiledIC.cpp` 中 set_to_monomorphic 与 set_to_megamorphic 的写入协议有何不同？

② **Counterfactual**：如果 IC stub 补丁用 `mprotect + write + mprotect` 三重切换而非直接写入？三重切换需要 syscall（~2us），而直接 5 字节 write 是原子操作 (x86 TSO 保证)，~5ns。但 x86 保证 8 字节对齐内的 8 字节写原子——5 字节 `jmp rel32` 跨 8 字节边界时不满足对齐，可能被其他 CPU 看到半写指令。NativeJump 处理这个了吗？

### 4.7 icBuffer 的 stub 生命周期

① ICBuffer 如何管理 stub 空间的分配和回收？`icBuffer.cpp:add_stub()` 从固定 8KB buffer 中切分 `ICStub`（每条 ~20 字节）。什么时候 `finalize_stubs()` 被调用（`mprotect(PROT_READ | PROT_EXEC)`）？满 buffer 后新 stub 怎么分配？旧 buffer 中的 dead stub 如何回收？

② **Counterfactual**：如果每个 IC stub 单独 mmap 而不是集中分配？mmap 系统调用的成本 ~2us/stub，10K stubs = 20ms。集中 buffer 分配是 O(1) 指针推进。但缺点：buffer 满后需要新 buffer，dead stub 空间永不回收（直到 buffer 中所有 stub 都 dead 才能释放整块）。

### 4.8 exceptionHandlerTable 的变长编码

① exceptionHandlerTable 如何存储 handler_bci/scope_depth/pc_offset 三元组？`exceptionHandlerTable.cpp:add_entry()` 使用变长整数编码（类似 SLEB128 但非标准实现）。二分查找 `handler_bci()` 如何从压缩的字节数组中提取第 N 条 handler？为什么需要按 handler_bci 排序？

② **Counterfactual**：如果 exception handler 表用 C++ 的 `std::unordered_map<bci, Handler>` 而不用压缩数组？std 在 HotSpot 内部不可用（no C++ STL）。即使可用，unordered_map 每条 entry ~32 字节 vs 压缩编码 ~6-8 字节/条。nmethod 有 50K+ nmethod，每条 24 字节开销差异 → 1.2MB metadata 额外内存。

### 4.9 ImplicitExceptionTable 的人工编码陷阱

① ImplicitExceptionTable 是什么？`exceptionHandlerTable.hpp` 中定义了 `ImplicitExceptionTable`——不是 C++ 异常处理，而是 Java 隐式异常（NullPointerException/ArithmeticException）的 PC 映射。编译器生成的代码不显式调用 `athrow`，而是让硬件异常（SIGSEGV/SIGFPE）触发 → 信号处理器查找 ImplicitExceptionTable → 找到 handler bci → 重建 Java 栈帧 → 抛出异常。`exceptionHandlerTable.cpp` 中的构造和查询实现是什么？

② **Counterfactual**：如果隐式异常不在 nmethod 中预编码，而是让信号处理器遍历所有 nmethod 的 PCDesc 表查找？PCDesc 表通常 500-2000 条/nmethod，线性搜索 O(n) × 10K nmethod → 10M 次比较。预编码的 ImplicitExceptionTable 将查找降为 O(log n)，因为表按 pc 排序可二分查找。

---

## §五 Article Structure

```
§〇 生产场景 — 3 个真实场景含根因链路
§一 Source Files Table + Standard Environment + Beginner Callouts
§二 Dependencies 类型系统 — 13 DepType 逐个解释 + DepStream 解码协议
§三 DependencyContext — per-class 依赖链表 + 原子插入/遍历
§四 依赖验证路径 — DepChange → flush_dependents → check_dependency → mark_deopt
§五 compiledIC — 状态机 (mono/mega/clean) + 补丁协议 + vtable dispatch
§六 icBuffer — stub 分配/提交/Finalize + 内存管理
§七 exceptionHandlerTable — 变长编码 + 二分查找 + ImplicitExceptionTable
§八 三个子系统的 nmethod metadata section 布局 — 如何共存在同一段内存
§九 Interview Story — 追踪一次类加载触发 deopt → IC 重建 全过程
§十 GDB 断点验证 + strace/jstack 诊断
§十一 Cross-Reference — 与 Phase 28 其他文档的衔接
§十二 "不要写成→应该写成" 对照表
```

---

## §六 Writing Requirements

**不要写成 → 应该写成**：

| 不要写成 | 应该写成 |
|---------|---------|
| 列出 13 个 DepType 枚举值的机械翻译 | 解释每个类型表达的编译期"乐观假设"，以及假设被违反时的 witness 如何被找到 (dependencies.cpp:check_* 方法) |
| "DepStream::next() 读取压缩流" | 追踪 next() 的完整状态机：`read_int()` → type tag → `dep_args(type)` → for(0..argc) `read_int()` → `recorded_metadata_at(idx)` → 从 OopRecorder 还原 Metadata* (dependencies.cpp 具体实现) |
| "set_to_megamorphic 写入 vtable dispatch" | 追踪写入的是什么指令字节：x86 上是 `mov reg, [vtable_offset]` + `call reg`，含 vtable 偏移计算和 IcMiss 回退 (compiledIC.cpp:168-194) |
| "DependencyContext 用链表管理" | 解释为什么是 per-Klass 链表而非全局表：删除 O(1) vs O(n)，nmethod 内嵌节点无额外分配，CAS 并发安全 (dependencyContext.cpp:add_dependent_nmethod 实现) |
| "ICBuffer 管理 stub 内存" | 追踪 8KB buffer 的切分策略：ICStub 不是 malloc 出来的，是指针推进 + finalize_stubs() 的 mprotect(PROT_READ\|PROT_EXEC) (icBuffer.cpp:add_stub) |
| "exceptionHandlerTable 用变长编码" | 展示具体的编码格式：每个 entry 包括 handler_bci (ULEB128), scope_depth (1B), bci (ULEB128)，二分查找实现 (exceptionHandlerTable.cpp:handler_bci) |
| "ImplicitExceptionTable 处理 null check" | 解释编译器的 null-check 省略 (NPE → SIGSEGV) → 信号处理器查表 → 重建 Java 异常的 6 步路径，含 file:line 到每个关键函数 |
| "三个子系统是 nmethod metadata" | 画 ASCII 布局图：`dependencies_begin()→dependencies_end()→handler_table_begin()→handler_table_end()` 对应 nmethod 内存中的三段连续区域 |
| "DepChange 标记 nmethod not_entrant" | 追踪完整路径：SystemDictionary::load_class → KlassDepChange → Universe::flush_dependents_on → DepStream::check_dependency → nmethod::mark_for_deoptimization → sweeper::sweep → nmethod::make_zombie (dependencies.cpp 具体行号) |

---

## §七 Output Format

- 文件命名：`02-Dependencies-IC-Exceptions.md`
- 标题格式：`# 02-Dependencies, IC & Exceptions — 依赖、内联缓存与异常处理`
- 每个技术断言标注 `file:line`
- 代码片段 5-15 行，C++ 格式标注语言
- Mermaid 图：依赖验证全流程图 + IC 状态机图
- 至少 1 个 ASCII 内存布局图（nmethod metadata section 三段布局）

---

## §八 Prohibited

1. 不要写成 DepType 枚举的逐条翻译——每个 DepType 要解释"编译器为什么需要这个断言"
2. 不要把 DepStream::next() 写成"调用 read_int() 若干次"——要展示压缩流的状态机
3. 不要把 IC stub 补丁写成"写入 5 字节 jmp 指令"——要追踪 x86 指令序列的 ASCII 编码
4. 不要把 DependencyContext 链表写成"C++ 链表操作"——要解释 CAS 循环的并发语义
5. 不要把 exceptionHandlerTable 编码写成"变长整数"——要展示 ULEB128 逐字节解码过程
6. 不要忽略 ImplicitExceptionTable 和普通异常表的差异——前者是硬件信号→Java 异常的桥梁
7. 不要忽略 W^X (Write XOR Execute) 在 icBuffer 中的应用——finalize_stubs 前后的权限变化
8. 不要写成"依赖验证触发 deopt"——要追踪从 class loading 到 nmethod::make_zombie() 的完整 8 步链路
9. 不要省略 nmethod metadata section 的内存布局 ASCII 图
10. 不要写成结构概述——要有源码级函数跟踪

---

## §九 Required

1. 13 个 DepType 全部有解释 + WHY (至少 2-3 行/每类型)
2. DepStream::next() 的完整解码过程含 file:line
3. compiledIC::set_to_megamorphic() 的 x86 指令序列逐字节追踪
4. icBuffer::add_stub() 的切分策略源码分析
5. exceptionHandlerTable::add_entry() 的变长编码逐节分析
6. ImplicitExceptionTable::at() 的二分查找实现源码
7. nmethod metadata section 三段 ASCII 布局图
8. Mermaid 序列图：类加载→依赖检查→deopt→IC 重建
9. GDB ≥7 断言含预期输出
10. 至少 7 个 inline `> **Beginner Callout N —**` 格式
11. Counterfactual 嵌入到每个对应的 Q 组末尾
12. "不要写成→应该写成" 对照表含全部 9 行

---

## §十 GDB Verification

1. **break dependencies.cpp:check_klass_dependency** — 验证类加载触发依赖检查
2. **break compiledIC.cpp:set_to_megamorphic** — 验证 IC 退化时写入的指令字节
3. **break icBuffer.cpp:add_stub** — 验证 stub 分配的边界检查 (剩余空间 vs stub 大小)
4. **break exceptionHandlerTable.cpp:handler_bci** — 验证 handler 二分查找的中间点计算
5. **break dependencyContext.cpp:add_dependent_nmethod** — 验证 CAS 重试循环
6. **break nmethod.cpp:mark_for_deoptimization** — 验证依赖失败后 nmethod 状态变化
7. **print nm->dependencies_begin()@100** — 打印依赖编码原始字节
8. **break exceptionHandlerTable.cpp:add_entry 后** — 打印编码后的字节数组和原始三元组的对照

---

## §十一 与 README 和同组 prompt 的连续性

- **与 prompt-00 (nmethod Layout)**：nmethod metadata section 的内存布局是本文档三个子系统 (dependencies + handler_table + IC) 的容器——读者应先理解 00 中 的三段结构，再看本文各段内容的编码格式
- **与 prompt-01 (Debug Info)**：scopeDesc 和 pcDesc 是从 PC 找回 Java 栈帧的工具——exception handler table 的 `handler_bci` 查找后需要 `pcDesc→ScopeDesc` 来重建被 deopt 的帧
- **与 Phase 26 (runtime-extra)**：deoptimization 路径是依赖失效的最终结果
- **与 Phase 22 (c2-jit)**：compiledIC 的 monomorphic entry 来自 C2 的类型分析和 profiling
