# Prompt 00: nmethod Layout & Lifecycle — 编译方法的物理形态与生命周期

## §〇 Production Scenario（必须真实出现在文档 §〇 中）

**场景 1 — GC 时 CodeCache 膨胀**：
运维发现 JFR 的 CodeCache 段报告「CodeCache is full. Compiler has been disabled」，jcmd `<pid>` Compiler.codecache 显示 non-profiled 区使用 98%。需要理解 nmethod 各 section 占用的实际内存，以及 Sweeper 如何回收 not_entrant/zombie 的 nmethod。

**场景 2 — Deoptimization 后的空白页**：
Java 方法被 uncommon trap → make_not_entrant() → make_zombie()，但 zombie nmethod 仍在 CodeCache 中占据 ~30KB。需要理解状态转换的时间线，以及何时通过 make_not_entrant_or_zombie() 执行 NativeJump::patch_verified_entry() 的代码补丁。

**场景 3 — CDS 归档中的 nmethod 缓存**：
使用 AOT（jaotc）编译的方法需要了解 nmethod 的三段内存布局（header + code + metadata），因为 AOTCompiledMethod 不存储在 CodeCache 中而是在 C-Heap + shared library，offset 计算方式完全不同。

---

## §一 Task + Narrative + Beginner Callouts

### 叙事线索

本文追踪一次 C2 编译产物的物理形态与全生命周期：

1. **构造函数**（nmethod.cpp:645-795）：编译器产出 CodeBuffer → nmethod::nmethod() 将各部分（consts/insts/stubs/scopes/oops/metadata/deps）按照内存布局拷贝到连续的 CodeCache 段
2. **状态机初始化**（init_defaults():404）：_state = not_installed → 验证 → make_in_use() = in_use
3. **运行时查询**：scope_desc_at() → pc_desc_at() → PcDescCache(4-element LRU)
4. **状态退化**：uncommon trap → make_not_entrant() → patch_verified_entry → 所有新调用重定向到解释器
5. **Sweeper 协同**：mark_as_seen_on_stack() → can_convert_to_zombie() → make_zombie()
6. **最终销毁**：flush() → CodeCache::free() → 内存返还

### 7 个 Beginner Callout（只出现在 §一 内联）

> **Beginner Callout 1 — nmethod 不是普通的 C++ 对象**：nmethod 通过 placement new（CodeBlob::operator new）分配在 CodeCache 的连续内存段中，不是 C-Heap。它的 header（sizeof(nmethod) ~200 bytes）是一个 C++ 对象，后续的 code/data sections 通过 offset 指针引用。header_begin() 返回 `(address) this`，total_size() 返回所有 section 大小之和。

> **Beginner Callout 2 — 三段布局的不变式**：header (nmethod 成员字段) → code section (consts + insts + stubs) → metadata section (oops + metadata + scopes_data + scopes_pcs + dependencies + handler_table + nul_chk_table)。各 section 通过 _consts_offset / _stub_offset / _oops_offset / ... 等 int offset 字段定位，而非 C++ 指针。

> **Beginner Callout 3 — 状态机的单向性**：nmethod 状态转移是不可逆的：in_use → not_entrant → zombie → unloaded。not_entrant 是「标记为不可进入但栈上仍有激活」，zombie 是「栈上激活已清除等待回收」。一旦进入 zombie 就不可回到 in_use。

> **Beginner Callout 4 — Patching_lock 的关键作用**：make_not_entrant_or_zombie() 通过 Patching_lock（Mutex::_no_safepoint_check_flag）保护 verified_entry 的补丁操作。补丁用 NativeJump::patch_verified_entry() 将入口替换为跳转到 handle_wrong_method 的桩代码——任何通过旧入口的调用都会被重定向。

> **Beginner Callout 5 — CodeBlob→CompiledMethod→nmethod 的继承链**：CodeBlob 是所有 CodeCache 条目的基类（virtual is_nmethod/is_compiled/is_zombie），CompiledMethod 增加了编译相关功能（ExceptionCache、IC 清洁、PcDesc 查询），nmethod 是 Java 方法的最终编译产物。

> **Beginner Callout 6 — 依赖系统的双向注册**：new_nmethod() 构造后立即通过 for (Dependencies::DepStream deps(nm)) 迭代所有依赖，对每个 klass 调用 InstanceKlass::add_dependent_nmethod()。这使得类加载时只需遍历被加载类的依赖链，而非遍历所有 nmethod——将依赖检查从 O(N) 降到 O(D)（D = 该类相关的依赖数）。

> **Beginner Callout 7 — ScavengeRootsInCode 的特殊路径**：如果启用了 ScavengeRootsInCode（G1/Parallel），nmethod 构造时调用 Universe::heap()->register_nmethod(this) 将自身注册到 GC 的 scavenge root 列表中。这使得年轻代 GC 时能扫描 nmethod 中的 oop 指针，而无需全堆扫描。

---

## §二 Standard Environment

### Source Roots

```
make/hotspot/lib/CompileJvm.gmk:153  — BUILD_LIBJVM（包含 code/ 所有 .cpp）
src/hotspot/share/code/              — 本文档来源
```

### 构建命令

```bash
bash configure --with-debug-level=slowdebug --with-native-debug-symbols=internal
make hotspot
```

### Binary Paths

```
build/linux-x86_64-server-slowdebug/jdk/lib/server/libjvm.so
```

### Syscall 速查表

| 系统调用 | man 手册 | 在 nmethod 中的角色 |
|----------|----------|-------------------|
| mmap(2) | `man 2 mmap` | CodeCache 初始分配（CodeCache::initialize() → os::reserve_memory()） |
| mprotect(2) | `man 2 mprotect` | CodeCache 分页提交（commit_memory → 逐页 mprotect(PROT_RWX)） |
| munmap(2) | `man 2 munmap` | CodeCache 销毁时释放 |
| write(2) | `man 2 write` | nmethod::flush() 日志输出 |

### 全局状态表

| 变量 | 位置 | 类型 | 说明 |
|------|------|------|------|
| _state | nmethod.hpp:128 | volatile signed char | 当前状态（{-1..4}） |
| _lock_count | nmethod.hpp:146 | volatile jint | refcount 锁（JVMTI 使用） |
| _stack_traversal_mark | nmethod.hpp:153 | volatile long | 栈扫描标记（Sweeper 使用） |
| _hotness_counter | nmethod.hpp:160 | int | 热度计数器（决定回收优先级） |
| _has_flushed_dependencies | nmethod.hpp:121 | bool | 依赖是否已清除 |
| _entry_bci | nmethod.hpp:63 | int | OSR 入口字节码索引 |
| _compile_id | nmethod.hpp:117 | int | 编译任务 ID |
| _comp_level | nmethod.hpp:118 | int | 编译等级（0-4） |

---

## §三 Source Files Table

| File | Full Path | Lines | Core Constructs | Role |
|------|-----------|:-----:|----------------|------|
| nmethod.hpp | `src/hotspot/share/code/nmethod.hpp` | 671 | nmethod 类 + nmethodLocker | nmethod 完整头文件：所有 offset 字段、状态查询、构造函数声明 |
| nmethod.cpp | `src/hotspot/share/code/nmethod.cpp` | 2995 | new_nmethod(), make_not_entrant_or_zombie(), flush(), verify() | nmethod 整个生命周期实现 + 状态转换 + 日志 |
| compiledMethod.hpp | `src/hotspot/share/code/compiledMethod.hpp` | 423 | ExceptionCache, PcDescCache, PcDescContainer, CompiledMethod 类 | 编译方法中间层：状态定义、IC 清洁接口、GC unloading |
| compiledMethod.cpp | `src/hotspot/share/code/compiledMethod.cpp` | 636 | scope_desc_at(), do_unloading(), clean_ic_if_metadata_is_dead() | ExceptionCache 管理、PcDesc 查找、IC 卸载 |
| compiledMethod.inline.hpp | `src/hotspot/share/code/compiledMethod.inline.hpp` | 84 | is_deopt_pc(), get_deopt_original_pc() | deopt PC 检测 + ExceptionCache inline 访问 |
| codeBlob.hpp | `src/hotspot/share/code/codeBlob.hpp` | 729 | CodeBlob, CodeBlobLayout, RuntimeBlob, BufferBlob, SingletonBlob 等全体类 | CodeBlob 基类 + 整个继承层次（13 个子类型） |
| codeBlob.cpp | `src/hotspot/share/code/codeBlob.cpp` | 681 | constructor, flush(), print_*, verify() | CodeBlob 基类实现 + CodeBlobLayout 辅助 |

---

## §四 Deep Dive Question Groups（≥6 组，每组含 counterfactual）

### 4.1 nmethod 内存布局：为什么用 offset 而非指针？

① 分析 nmethod 构造函数（nmethod.cpp:645-795）中 `_consts_offset / _stub_offset / _oops_offset / _metadata_offset / _scopes_pcs_offset / _dependencies_offset / _handler_table_offset / _nul_chk_table_offset` 的完整计算链。

② 为什么使用 int offset 而非 C++ 指针？考虑 CodeCache relocation 的可能性：如果使用指针，GC 移动 CodeCache 时需要更新所有指针。offset 相对于 header_begin() 计算是 position-independent 的。

③ [counterfactual] 如果每个 section 用独立的 C++ 对象（new SectionData）而非内联在连续内存中？估算额外开销：每个独立对象至少增加 vtable 指针（8B）+ malloc header（16B）+ 内存碎片（~8B），8 个 section 额外 ~200B/每 nmethod × 10000 nmethod = 2MB 额外开销。

### 4.2 nmethod 状态机五态：为什么需要 not_entrant 中间态？

① 读取 make_not_entrant_or_zombie()（nmethod.cpp:1161-1313）的完整实现，追踪从 CAS 双重检查到 NativeJump::patch_verified_entry() 到 OrderAccess::storestore() 的顺序保证。

② 为什么有 not_entrant 中间态而非直接从 in_use→zombie？not_entrant 状态下，已在执行的方法可继续执行（栈上激活保留），但新调用被 patch 到 SharedRuntime::get_handle_wrong_method_stub()。这在 uncommon trap 后允许并发线程安全退出旧编译。

③ [counterfactual] 如果删除 not_entrant 态，直接从 in_use→zombie？GC safepoint 时必须遍历所有线程栈标记 zombie，延迟从微秒级暴增到毫秒级（safepoint 代价）。not_entrant 的异步补丁 + 延迟回收将「停止调用」与「清理栈上激活」解耦。

### 4.3 CodeBlob→CompiledMethod→nmethod 继承链：每个层次的职责边界

① 追踪 CodeBlob.hpp:86-246 的虚函数体系：is_nmethod()/is_compiled()/is_zombie() 的默认实现返回 false，子类覆盖后实现类型查询。

② 为什么需要 CompiledMethod 作为中间层而非直接将 ExceptionCache/PcDesc 放入 nmethod？因为 AOTCompiledMethod 也共享这些能力但不需要 nmethod 的特定 section layout（AOT 代码在共享库中）。

③ [counterfactual] 如果删除 CompiledMethod 层，让 nmethod 和 AOTCompiledMethod 分别实现相同的接口？代码重复量：ExceptionCache（~150 行 PcDesc 查找 + ~80 行 IC 清洁）将被复制到两个类中。

### 4.4 PcDesc 缓存：4 元素 LRU 的设计考量

① 读取 PcDescCache（compiledMethod.hpp:80-96 + nmethod.cpp:311-367）的 find_pc_desc() + match_desc() + add_pc_desc() 全流程。

② 为什么 cache_size = 4？与常见 L1 cache line（64B）对齐：4 × 8B = 32B，加上 cache 控制数据共 ~64B，适合一个 cache line。但在多线程并发查找时（注释提到「many threads are updating it」），volatile 共享访问使 cache line bouncing 抵消了 LRU 收益。

③ [counterfactual] 如果 cache_size = 16？每次 cache miss 需要扫描 16 个元素（vs 4），在 cache line bouncing 场景下性能可能更差——因为加载 16 个元素可能跨越 3-4 个 cache line，导致更多 cache miss。

### 4.5 make_not_entrant_or_zombie() 的并发安全

① 追踪 CAS 双检查（nmethod.cpp:1171-1176 和 :1205-1209）、nmethodLocker RAII（:1180）、methodHandle（:1181）、NoSafepointVerifier（:1182）的层次化保护。

② 为什么在 Patching_lock 内部需要 methodHandle 包装？因为 transition 到 zombie 后会 set_method(NULL)（:1301），但在此之前可能需要访问 method()（Deoptimization::inc_decompile_count）。methodHandle 在 GC safepoint 期间保持 method 不被回收。

③ [counterfactual] 如果用全局 Mutex 代替 Patching_lock 保护所有 nmethod 的状态转移？Patching_lock 是 per-CodeCache 的轻量锁，只保护 verified_entry pathing 操作。全局锁会串行化所有 nmethod 的状态转换，在大量 uncommon trap 场景下成为瓶颈（估算：100 个线程同时 deopt 100 个不同 method，全局锁串行化 → ~1ms，Patching_lock 并发 → ~10μs）。

### 4.6 flush() 与 CodeCache 回收：两步释放

① 跟踪 flush()（nmethod.cpp:1315-1355）：ExceptionCache 链表清理 → scavenge_root_list 移除 → JVMCI 引用 null 检查 → CodeBlob::flush() → CodeCache::free()。

② 为什么需要 CodeBlob::flush() 作为中间步骤？CodeBlob::flush() 是虚函数，不同子类有不同清理逻辑。nmethod 的 flush() 额外清理 ExceptionCache 和 scavenge root。

③ [counterfactual] 如果 CodeCache::free() 直接使用 free() 返回内存给 libc？CodeCache 使用 os::release_memory() → munmap(2) 回收虚拟地址空间，而非仅仅 free()。这样可以立即归还页表项，减少 TLB 压力。

### 4.7 new_nmethod() 的依赖注册：为什么在构造时内联而非延迟？

① 追踪 new_nmethod()（nmethod.cpp:468-547）中依赖注册段（:523-536）：for (Dependencies::DepStream deps(nm)) → klass->add_dependent_nmethod(nm)。

② 为什么在 CodeCache_lock 保护下完成注册？因为在此之后 nmethod 可以被 deoptimize，但 deoptimization 需要能在所有依赖类中找到当前 nmethod。如果在锁释放后才注册，存在窗口期。

③ [counterfactual] 如果延迟注册到 make_in_use() 之后？make_in_use() 之后 class loading 可能发生——此时类加载器检查依赖时会遗漏当前 nmethod，导致过时的编译代码残留。当前顺序确保「安装→可见→注册」三步原子化。

### 4.8 nmethodLocker：JVMTI 的引用计数保护

① 分析 nmethodLocker（nmethod.hpp:630-669）的 lock_nmethod()/unlock_nmethod() 通过 _lock_count 实现。

② 为什么需要引用计数？JVMTI 的 CompiledMethodUnload 事件需要在 nmethod 成为 zombie 后仍能访问其代码，直到事件处理完毕。nmethodLocker 在这期间防止 flush()。

③ [counterfactual] 如果不用引用计数，让 JVMTI 拷贝 nmethod 信息？每次 unload 事件需要拷贝 method→name→compile_id→entry point，典型 ~200B 字符串拷贝 × 每 GC cycle 数千个 unload = ~500KB 额外分配 + 拷贝开销。

### 4.9 ExceptionCache：为什么用链表而非哈希表？

① 分析 ExceptionCache（compiledMethod.hpp:43-74 + nmethod.cpp:242-296）的线性链表结构：match()/test_address() 遍历 count() 个元素。

② 为什么不用哈希表？每个 throw-catch 点通常只有 1-3 种异常类型，cache_size=16 的线性扫描（最坏 16 次比较）比哈希计算（至少 30 CPU cycles）更快。高频异常（NullPointerException）通常在 cache[0] 命中。

③ [counterfactual] 如果 ExceptionCache 用数组而非链表？更新时数组需要 memmove()，链表只需 prepend。prepend 的 release_store（`OrderAccess::release_store(&_exception_cache, ec)`）与并发读（不拿锁的 `_exception_cache` 访问）兼容。

---

## §五 Article Structure

建议文档由以下章节组成（序号与 section 编号对应）：

```
§〇  Production Scenario — 3 场景（CodeCache 膨胀/dtrace 丢失/工具链解码）
§一  Source Files Table + 7 Beginner Callouts + 12 步调用链
│   §一.1  继承链全景图（CodeBlob→CompiledMethod→nmethod）
│   §一.2  nmethod 构造函数：从 CodeBuffer 到连续内存
│   §一.3  状态机初始化：not_installed → in_use 的微秒之旅
§二  Standard Environment（SOURCE ROOTS:line + BUILD + BINARY + SYSCALL 表 + GLOBAL STATE 表）
§三  nmethod 内存布局：Header + Code + Metadata 三段理解
│   §三.1  header section：nmethod 的 C++ 成员（offset 字段）
│   §三.2  code section：consts + insts + stubs 的组织
│   §三.3  metadata section：oops → scopes_data → scopes_pcs → deps → handlers → nul_chk 的连续附加
§四  状态转换引擎：make_not_entrant_or_zombie() 全链
│   §四.1  in_use → not_entrant：uncommon trap 异步补丁
│   §四.2  not_entrant → zombie：Sweeper 协同与 can_convert_to_zombie
│   §四.3  zombie → flush：CodeCache 回收
§五  PcDesc 查找与 ScopeDesc 定位
│   §五.1  PcDescCache(4-element LRU) 的设计与并发
│   §五.2  scope_desc_at() → new ScopeDesc() 的延迟创建
§六  GC 与 nmethod 的交互
│   §六.1  oops_do()：嵌入式 oop 的 GC 根扫描
│   §六.2  do_unloading()：GC 时卸载不可达 oop
│   §六.3  scavenge_root_list：年轻代 GC 的快速路径
§七  依赖与 IC 的生命周期连接
│   §七.1  clean_ic_if_metadata_is_dead()：IC 中的过时元数据
│   §七.2  flush_dependencies()：依赖链的反向清理
§八  ExceptionCache：异常处理的缓存层
§九  Counterfactual 对比表（6 个大规模反事实）
§十  诊断工具（jcmd + GDB + strace 三步验证）
§十一  "不要写成→应该写成" 对照表
§十二  Cross-Reference
```

---

## §六 Writing Requirements

### 源码证据 vs 原理分析的黄金比例

本文档中的源码分析应占 20%，原理推理占 80%。只展示关键的 3-5 行代码（含 file:line 标注），重点回答 WHY 而非 HOW。

### "不要写成→应该写成" 对照表（≥8 行）

| 不要写成 | 应该写成 |
|---------|---------|
| "nmethod 有 _state 字段表示状态" | `_state` (nmethod.hpp:128) 是 `volatile signed char`（非 bool），包含 -1..4 共 6 个状态值。volatile 确保 Patching_lock 保护之外的快速检查（is_in_use() 可直接读 _state） |
| "patch_verified_entry 修改入口代码" | NativeJump::patch_verified_entry() 在 nmethod.cpp:1214 将 verified_entry_point 开始的 NativeJump（5/8 字节）替换为跳转到 handle_wrong_method_stub 的 JMP。这是 not_entrant 状态的关键副作用——之后所有通过 vep() 的调用都被重定向 |
| "PcDescCache 有 4 个元素的 LRU" | PcDescCache(cache_size=4) 在 compiledMethod.hpp:83 定义。注意 volatile PcDescPtr _pc_descs[4] 的并发安全：find_pc_desc() 首先检查最近添加的 _pc_descs[0]（无需遍历），然后扫描 1-3。多线程共享访问通过 volatile 保证可见性 |
| "make_not_entrant_or_zombie 用 Patching_lock 保护" | nmethod.cpp:1203 的 `MutexLockerEx pl(Patching_lock, Mutex::_no_safepoint_check_flag)` 是 leaf lock——不会有 safepoint 在此临界区触发。这确保了 patch + clear_code 的原子性 |
| "flush 释放 nmethod 内存" | nmethod.cpp:1354 的 `CodeCache::free(this)` 将 nmethod 段标记为空闲，但不一定立即调用 munmap(2)。CodeHeap 维持空闲段链表（FreeBlock 管理），供后续编译复用 |
| "nmethod::oops_do() 遍历嵌入 oop" | nmethod.hpp:498-499 的 oops_do() 通过 oops_size()/metadata_size() 计算范围，然后调用 OopClosure::do_oop()。注意 index 0 是预留的 NULL（nmethod.hpp:362-363），所有实际 oop 从 index 1 开始 |
| "nmethodLocker 增加引用计数" | nmethod.hpp:630-669 使用 `Atomic::add(&_lock_count, 1)` 和 `Atomic::add(&_lock_count, -1)` 实现引用计数。JVMTI 的 CompiledMethodUnload 事件处理依赖此功能：事件队列异步处理期间锁住 nmethod 防止被 flush |
| "OrderAccess::storestore() 在 make_not_entrant 中" | nmethod.cpp:1237 的 `OrderAccess::storestore()` 在 `mark_as_seen_on_stack()` 后确保 _stack_traversal_mark 的写入先于 _state 的写入在任何其他 CPU 上可见，防止 can_convert_to_zombie() 看到新状态但旧栈标记 |
| "total_size() 计算 nmethod 占用的总 CodeCache 空间" | nmethod.cpp:382 的 total_size() 累加 6 个 sections 的 size（consts + insts + stub + scopes_data + scopes_pcs + handler_table + nul_chk_table），不包括 header_size 和 relocation_size。这是 CodeCache 空间管理的核心指标 |

---

## §七 Output Format

- 标题：`# 00-nmethod Layout & Lifecycle — 编译方法的物理形态与生命周期`
- 每个 § 不限定行数，自然展开
- file:line 引用格式：`nmethod.cpp:1161`（精确到行）
- Mermaid ASCII 图用于内存布局和状态机
- Callout 框使用 `> **Beginner Callout N —` 格式，只在 §一
- Counterfactual 使用 `> **Counterfactual** —` 块引用嵌入各小节

---

## §八 Prohibited（≥8）

1. **禁止** 把 prompt 答案直接转录为文档正文——读源码后独立重新生成
2. **禁止** 用「XX 源码如下」+ 大段 copy-paste 源码的翻译模式——只引用关键 3-5 行
3. **禁止** 缺失 offset 计算链的精确 file:line 引用
4. **禁止** 用枚举列表替代状态机的因果分析（如「nmethod 有 in_use/not_entrant/zombie 三种状态」← 这是不完整的枚举，实际有 6 个值）
5. **禁止** 忽略 Patching_lock 与 NoSafepointVerifier 的配合关系
6. **禁止** 不讨论 _lock_count 与 nmethodLocker 的 JVMTI 用途
7. **禁止** 将 total_size() 的计算与 CodeCache::free() 中的实际回收混淆
8. **禁止** 不展示 CodeBlobLayout 的两种构造模式（简单 size vs CodeBuffer）
9. **禁止** 遗漏 PcDescCache 并发注释（nmethod.cpp:327-331）中的 cache line bouncing 分析
10. **禁止** 把 ExceptionCache 当作「异常处理表」——它是运行时缓存，handler_table 是编译时编码的

---

## §九 Required（≥8）

1. **必须** 包含 CodeBlob→CompiledMethod→nmethod 的 Mermaid 类继承图（每个类的关键虚函数标注）
2. **必须** 包含 nmethod 构造函数的完整 offset 计算源码（nmethod.cpp:693-754）并附 file:line
3. **必须** 包含 make_not_entrant_or_zombie() 的完整实现源码（nmethod.cpp:1161-1313）附 file:line
4. **必须** 在状态机讨论中展示 NativeJump::patch_verified_entry() 对 verified_entry_point 的修改
5. **必须** 展示 _scavenge_root_state 的 bit 位定义（nmethod.hpp:395-406）
6. **必须** 量化 PcDescCache 的命中率：_pc_descs[0] 大概率命中（同一 PC 反复查询），LRU 用于处理调用点附近的变化
7. **必须** 解释 ScavengeRootsInCode 为什么需要 register_nmethod/unregister_nmethod
8. **必须** 包含 ExceptionCache 的链表结构与 release_store 并发读模式
9. **必须** 展示 PcDescSearch（compiledMethod.hpp:98-112）如何将 code_begin + scopes_pcs 封装为搜索参数
10. **必须** 包含 nmethod.cpp:372-378 的 adjust_pcs_size() 对齐算法
11. **必须** 展现 flush() 中的 CodeCache::free() 与 CodeBlob::flush() 的两步关系
12. **必须** 在 §二 环境节中包含全局状态表（≥5 行）

---

## §十 GDB Verification（≥7 assertions）

```gdb
# 1. 找到所有 nmethod
(gdb) p CodeCache::blob_count()
# 预期：> 0

# 2. 检查单个 nmethod 的状态
(gdb) p ((nmethod*)0x...) ->_state
# 预期：0（in_use）或 3（zombie）

# 3. 验证 nmethod 布局的 section offset 一致性
(gdb) p ((nmethod*)0x...) ->_consts_offset
(gdb) p ((nmethod*)0x...) ->_stub_offset
(gdb) p ((nmethod*)0x...) ->_oops_offset
# 预期：_consts_offset < _stub_offset < _oops_offset < _metadata_offset（单调递增）

# 4. 验证 make_not_entrant 的效果
(gdb) b nmethod::make_not_entrant_or_zombie
(gdb) c
# 在断点处检查：_state 从 0(in_use) → 2(not_entrant) 转变

# 5. 检查 PcDesc 缓存
(gdb) p ((nmethod*)0x...) ->_pc_desc_container
# 预期：_pc_descs[0] != NULL

# 6. 验证 ExceptionCache 链表
(gdb) p ((nmethod*)0x...) ->_exception_cache
(gdb) p ((nmethod*)0x...) ->_exception_cache->_next
# 预期：链表结构，每个节点包含 exception_type + pc[] + handler[]

# 7. 检查 scavenge root 注册
(gdb) p ((nmethod*)0x...) ->_scavenge_root_state
# 预期：0（未注册）或 1（已注册）

# 8. 验证 hotness_counter
(gdb) p ((nmethod*)0x...) ->_hotness_counter
# 预期：正数，初始值 = hotness_counter_reset_val()
```

---

## §十一 与 README 和同组 prompt 的连续性

### 前向依赖（本文档依赖的其他 Phase 文档）

- Phase 24 doc-00（Core Containers）— GrowableArray/Hashtable 在 nmethod 统计中使用
- Phase 23（logging）— nmethod::log_new_nmethod() 使用 xtty XML 日志
- libjvm-analysis/05-jit-compiler/04-CodeCache-Sweeper.md — nmethod 生命周期高层

### 后向供给（本文档被其他 prompt 依赖）

- prompt-01（Debug Info & Metadata）— scope_desc_at() 创建 ScopeDesc，需要本文档的 pc_desc_at() 分析作为前置
- prompt-02（Dependencies, IC & Exceptions）— CompiledIC 行走和 dependencies 注册依赖本文档的 nmethod 布局分析

### 相邻 prompt 的协作

- doc-00 定义 code/ 的物体模型（nmethod 物理形态）
- doc-01 解释 pc_desc_at() → scope_desc_at() 的内联帧恢复
- doc-02 解释 IC（编译后内联缓存）的 patching 和依赖管理
