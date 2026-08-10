# 00-nmethod Layout & Lifecycle — 编译方法的物理形态与生命周期

## §〇 Production Scenario

### 场景 1 — GC 时 CodeCache 膨胀

运维通过 JFR 的 CodeCache 段报告"CodeCache is full. Compiler has been disabled"。`jcmd <pid> Compiler.codecache` 显示 non-profiled 区使用 98%。此时需要理解每个 nmethod 的 section 占用 —— 典型的 C2 编译方法占用 8-32KB（含 consts/insts/stubs/scopes/oops/metadata/deps），以及 NMethodSweeper 如何通过 mark_active_nmethods() → can_convert_to_zombie() 回收 not_entrant/zombie 状态的方法。

### 场景 2 — Deoptimization 后的空白页

Java 方法被 uncommon trap 触发后：`make_not_entrant()` 补丁 verified_entry → JMP 到 `handle_wrong_method_stub`。随后 GC 栈扫描时 `mark_as_seen_on_stack()` → NMethodSweeper 检查 `can_convert_to_zombie()` → `make_zombie()`。但 zombie nmethod 仍在 CodeCache 中占用 ~30KB 直到被 Sweeper 调用 `flush()`。关键窗口：从 not_entrant 到 flush 可能跨越多个 GC cycle，取决于栈上激活存活时间。

### 场景 3 — CDS/AOT 中的 nmethod 缓存差异

使用 jaotc 编译的 AOTCompiledMethod 不存储在 CodeCache 中，而是在 C-Heap + shared library 中。其内存布局的 offset 计算与 CodeCache 中的 nmethod 完全不同：AOT 代码段由动态链接器加载，offset 基于 `this` 的 C-Heap 地址，而非 CodeCache 的连续段。

---

## §一 Source Files Table + 7 Beginner Callouts + 12 步调用链

### Source Files Table

| File | Lines | Core Constructs |
|------|:-----:|----------------|
| `nmethod.hpp` (`src/hotspot/share/code/nmethod.hpp`) | 671 | nmethod 类 + nmethodLocker: 所有 offset 字段、状态查询、构造函数声明 |
| `nmethod.cpp` (`src/hotspot/share/code/nmethod.cpp`) | 2995 | new_nmethod(), make_not_entrant_or_zombie(), flush(), verify() |
| `compiledMethod.hpp` (`src/hotspot/share/code/compiledMethod.hpp`) | 423 | ExceptionCache, PcDescCache, CompiledMethod 类: 状态枚举、IC 清洁接口 |
| `compiledMethod.cpp` (`src/hotspot/share/code/compiledMethod.cpp`) | 636 | scope_desc_at(), do_unloading(), clean_ic_if_metadata_is_dead() |
| `compiledMethod.inline.hpp` (`src/hotspot/share/code/compiledMethod.inline.hpp`) | 84 | is_deopt_pc(), get_deopt_original_pc(), ExceptionCache inline 方法 |
| `codeBlob.hpp` (`src/hotspot/share/code/codeBlob.hpp`) | 729 | CodeBlob + CodeBlobLayout + 13 个子类型继承层次 |
| `codeBlob.cpp` (`src/hotspot/share/code/codeBlob.cpp`) | 681 | 构造函数、flush()、CodeBlobLayout 辅助 |

### 12 步调用链：nmethod 全生命周期

```
Compiler::compile_method()
  ↓
nmethod::new_nmethod()       [nmethod.cpp:468]  CodeCache_lock 下分配+构造
  ↓
nmethod::nmethod()           [nmethod.cpp:645]  构造函数：offset计算+拷贝所有section
  ↓
init_defaults()              [nmethod.cpp:404]  _state = not_installed
  ↓
Dependencies::DepStream      [nmethod.cpp:523]  依赖注册到 InstanceKlass
  ↓
CodeCache::commit()          [nmethod.cpp:774]  提交到 CodeHeap
  ↓
make_in_use()                [nmethod.hpp:333]  _state = in_use
  ↓
[运行时] pc_desc_at()        [compiledMethod.hpp:219] PcDescCache(4) 查询
  ↓
[Deopt触发] make_not_entrant() [nmethod.hpp:338] → make_not_entrant_or_zombie(2)
  ↓
patch_verified_entry()       [nmethod.cpp:1214] NativeJump 5-8B 补丁
  ↓
[Sweeper] mark_as_seen_on_stack() [nmethod.cpp:1006] 栈扫描标记
  ↓
can_convert_to_zombie()      [nmethod.cpp:1016] 条件检查
  ↓
make_zombie() → flush() → CodeCache::free()  [nmethod.cpp:1315→1354] 最终回收
```

### Mermaid 类继承图

```mermaid
classDiagram
    class CodeBlob {
        <<abstract>>
        -CompilerType _type
        -int _size
        -int _header_size
        -address _code_begin
        -address _code_end
        +virtual bool is_nmethod() = false
        +virtual bool is_compiled() = false
        +virtual bool is_zombie() = false
        +virtual bool is_alive() = 0
        +virtual void flush()
        +address header_begin() = (address)this
    }
    class CompiledMethod {
        <<abstract>>
        -Method* _method
        -address _scopes_data_begin
        -PcDescContainer _pc_desc_container
        -ExceptionCache* volatile _exception_cache
        +virtual bool is_compiled() = true
        +virtual bool is_in_use() = 0
        +enum { not_installed=-1, in_use=0, not_used=1, not_entrant=2, zombie=3, unloaded=4 }
        +PcDesc* pc_desc_at(address pc)
        +ScopeDesc* scope_desc_at(address pc)
        +void do_unloading(BoolObjectClosure*)
        +static void clean_ic_if_metadata_is_dead(CompiledIC*)
    }
    class nmethod {
        -int _entry_bci
        -int _consts_offset, _stub_offset, _oops_offset...
        -volatile signed char _state
        -volatile jint _lock_count
        -volatile long _stack_traversal_mark
        -int _hotness_counter
        +bool is_nmethod() = true
        +bool make_not_entrant_or_zombie(int state)
        +void flush()
        +int total_size()
        +void oops_do(OopClosure* f)
    }
    class AOTCompiledMethod {
        -offset in shared library
    }
    class BufferBlob {
        +bool is_buffer_blob() = true
    }
    class RuntimeStub {
        +bool is_runtime_stub() = true
    }

    CodeBlob <|-- CompiledMethod
    CodeBlob <|-- BufferBlob
    CodeBlob <|-- RuntimeStub
    CompiledMethod <|-- nmethod
    CompiledMethod <|-- AOTCompiledMethod
```

> **Beginner Callout 1 — nmethod 不是普通的 C++ 对象**：nmethod 通过 placement new（`nmethod::operator new()` at `nmethod.cpp:641` → `CodeCache::allocate()`）分配在 CodeCache 的连续内存段中，不是 C-Heap。`sizeof(nmethod)` 约 ~200 字节是 header C++ 对象，后续的 code/data sections 通过 int offset 字段引用。`header_begin()` 返回 `(address) this`，`total_size()` 返回所有 section 大小之和（不含 header_size 和 relocation_size）。

> **Beginner Callout 2 — 三段布局的不变式**：header (nmethod 成员字段 ~200B) → relocation section (重定位信息) → code section (consts + insts + stubs) → metadata section (oops + metadata + scopes_data + scopes_pcs + dependencies + handler_table + nul_chk_table)。所有 section 通过 `_consts_offset / _stub_offset / _oops_offset / _metadata_offset / _scopes_pcs_offset / _dependencies_offset / _handler_table_offset / _nul_chk_table_offset` 等 int offset 字段相对于 `header_begin()` 定位，而非 C++ 指针。见 `nmethod.hpp:100-109`。

> **Beginner Callout 3 — 状态机的单向不可逆性**：nmethod 状态转移严格单向：not_installed(-1) → in_use(0) → not_used(1)/not_entrant(2) → zombie(3) → unloaded(4)。not_entrant 是"标记为不可进入但栈上仍有激活"，zombie 是"栈上激活已清除等待回收"。一旦进入 zombie，`_state` 不可回到 in_use。状态枚举定义在 `compiledMethod.hpp:188-197`。

> **Beginner Callout 4 — Patching_lock 与 NoSafepointVerifier 的协同**：`make_not_entrant_or_zombie()` 中 `MutexLockerEx pl(Patching_lock, Mutex::_no_safepoint_check_flag)` (`nmethod.cpp:1203`) 是 leaf lock —— 在此临界区内不会有 safepoint 触发。配合 `NoSafepointVerifier nsv` (`nmethod.cpp:1182`)，确保 `NativeJump::patch_verified_entry()` 的代码补丁 + `_state` 写入的原子性。补丁将 verified_entry_point 开始的 NativeJump（x86: 5 字节 JMP）替换为跳转到 `SharedRuntime::get_handle_wrong_method_stub()` 的指令。

> **Beginner Callout 5 — CodeBlob→CompiledMethod→nmethod 继承链**：CodeBlob 是所有 CodeCache 条目的基类（`codeBlob.hpp:86`），提供 `is_nmethod()` / `is_compiled()` / `is_zombie()` 虚函数（默认返回 false）。CompiledMethod（`compiledMethod.hpp:134`）增加了编译相关能力：ExceptionCache 链表、PcDesc 查询、IC 清洁。nmethod（`nmethod.hpp:55`）是 Java 方法的最终 JIT 编译产物，覆盖所有虚函数返回 correct 值，添加 8 个 offset 字段实现三段布局。

> **Beginner Callout 6 — 依赖系统的双向注册将 O(N) 转为 O(D)**：`new_nmethod()` 构造后在 `CodeCache_lock` 保护下，通过 `for (Dependencies::DepStream deps(nm))` (`nmethod.cpp:523`) 迭代所有依赖，对每个 klass 调用 `InstanceKlass::add_dependent_nmethod()`。这使得类加载时只需遍历被加载类的依赖链，而非遍历所有 nmethod —— 将依赖检查从 O(N) 降到 O(D)（D = 该类相关的依赖数）。

> **Beginner Callout 7 — ScavengeRootsInCode 的年轻代 GC 优化**：如果启用 `ScavengeRootsInCode`（G1/Parallel GC），nmethod 构造时调用 `Universe::heap()->register_nmethod(this)` (`nmethod.cpp:769`) 将自身注册到 GC 的 scavenge root 链表（`_scavenge_root_link` union）。年轻代 GC 仅扫描此链表中的 nmethod oop，无需全堆扫描。`_scavenge_root_state` 位域定义在 `nmethod.hpp:395`：`sl_on_list = 0x01, sl_marked = 0x10`。

---

## §二 Standard Environment

### Source Roots

```
make/hotspot/lib/CompileJvm.gmk:153 — BUILD_LIBJVM（包含 code/ 所有 .cpp → libjvm.so）
src/hotspot/share/code/ — 本文档来源
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
| mmap(2) | `man 2 mmap` | CodeCache 初始分配（`os::reserve_memory()` → MAP_NORESERVE） |
| mprotect(2) | `man 2 mprotect` | CodeCache 分页提交（commit → 逐页 PROT_READ\|PROT_WRITE\|PROT_EXEC） |
| munmap(2) | `man 2 munmap` | CodeCache 销毁时释放虚拟地址空间 |
| write(2) | `man 2 write` | `nmethod::flush()` 日志输出（PrintMethodFlushing） |

### 全局状态表

| 变量 | 位置 | 类型 | 初始值 | 说明 |
|------|------|------|--------|------|
| `_state` | `nmethod.hpp:128` | `volatile signed char` | -1 (not_installed) | 生命状态：{-1,0,1,2,3,4} |
| `_lock_count` | `nmethod.hpp:146` | `volatile jint` | 0 | JVMTI refcount，非零时阻止 flush |
| `_stack_traversal_mark` | `nmethod.hpp:153` | `volatile long` | 0 | Sweeper 栈扫描标记 |
| `_hotness_counter` | `nmethod.hpp:160` | `int` | `hotness_counter_reset_val()` | 热度（正数≈最近活跃） |
| `_has_flushed_dependencies` | `nmethod.hpp:121` | `bool` | 0 | 依赖是否已清理 |
| `_entry_bci` | `nmethod.hpp:63` | `int` | 构造传入 | OSR 入口 BCI，非OSR为InvocationEntryBci |
| `_compile_id` | `nmethod.hpp:117` | `int` | 构造传入 | 编译任务全局编号 |
| `_comp_level` | `nmethod.hpp:118` | `int` | 构造传入 | TieredCompilation 等级 (0-4) |
| `_scavenge_root_state` | `nmethod.hpp:134` | `jbyte` | 0 | bit0=已注册，bit4=GC标记 |
| `_entry_point` | `nmethod.hpp:91` | `address` | `code_begin()+Entry_offset` | 带class检查的入口 |
| `_verified_entry_point` | `nmethod.hpp:92` | `address` | `code_begin()+Verified_Entry_offset` | 无class检查的入口（IC直接调用） |
| `_exception_cache` | `compiledMethod.hpp:166` | `ExceptionCache* volatile` | NULL | 异常处理链表头 |

---

## §三 nmethod 内存布局：Header + Code + Metadata 三段理解

### §三.1 header section：nmethod 的 C++ 成员（offset 字段为核心）

nmethod 的 header 是 `sizeof(nmethod)` 字节的 C++ 对象，位于 `header_begin()` = `(address) this`。所有后续 section 通过 int offset 相对于 `header_begin()` 定位，而非 C++ 指针 —— 这使得 nmethod 在 CodeCache 中 position-independent（即使未来支持 CodeCache relocation 也无需更新指针）。

关键 offset 字段（`nmethod.hpp:100-109`）：

```cpp
int _consts_offset;        // 常量池起始偏移
int _stub_offset;          // 桩代码起始偏移
int _oops_offset;          // 嵌入式 oop 表起始偏移
int _metadata_offset;      // 嵌入式 metadata 表起始偏移
int _scopes_data_offset;   // scope 数据起始偏移
int _scopes_pcs_offset;    // PcDesc 数组起始偏移
int _dependencies_offset;  // 依赖数据起始偏移
int _handler_table_offset; // 异常处理器表起始偏移
int _nul_chk_table_offset; // 隐式空指针检查表起始偏移
int _nmethod_end_offset;   // nmethod 数据尾偏移
```

每个 offset 字段对应一个 `xxx_begin()` 内联方法（`nmethod.hpp:273-293`），通过 `header_begin() + offset` 计算。例如：
```cpp
address consts_begin() const { return header_begin() + _consts_offset; }
```

**`header_size()` 与 CodeBlob 层次对齐**（`codeBlob.hpp:533-537`）：nmethd 的 `header_size()` 继承自 CodeBlob，定义为 `_header_size`，该值在构造函数中设为 `sizeof(nmethod)` 向上对齐到 `CodeEntryAlignment`（32B）。这个对齐确保 header 与 code section 之间有严格的 page-alignment-friendly 边界。

**`relocation_size()` 的作用**（`nmethod.cpp:693-695`）：relocation section 位于 header 之后、code section 之前。它编码编译器生成的重定位信息（call 点的绝对→相对偏移补丁、oop 位置标记等）。`content_offset()` = `header_size + relocation_size` 对齐到 `CodeEntryAlignment`，因此 `content_begin()` = `header_begin() + content_offset()`。

**offset 设定的不变式**（构造函数保证 `nmethod.cpp:693-754`）：
1. `_consts_offset < _stub_offset` — consts 在 insts 之前，与 CodeBuffer 的生成顺序一致
2. `_oops_offset < _metadata_offset < _scopes_pcs_offset < _dependencies_offset < _handler_table_offset < _nul_chk_table_offset` — metadata section 内严格递增
3. `_oops_offset = data_offset()` — 当 code section 结束点等于 data section 起始点
4. 所有 offset 经 `align_up()` 对齐：oop 字段对齐到 `oopSize`，metadata 字段对齐到 `wordSize`

**`code_size()` vs `insts_size()`**（`nmethod.hpp:273-279`）：`code_size()` = `stub_end - consts_begin`（全部 code section），`insts_size()` = `stub_begin - consts_end`（仅指令体）。`code_begin()` 返回 `consts_begin()`（`nmethod.hpp:269`），因此 `code_containing(pc)` 运算符通过 `code_begin() <= pc < code_end()` 判断 PC 是否在此 nmethod 内（`codeBlob.hpp:531`）。

### §三.2 code section：consts + insts + stubs 的组织

code section 是 nmethod 的"可执行"部分，在 CodeCache 内存布局中紧接 relocation：

```
[header][relocation][consts][insts(代码主体)][stubs(桩)]
```

offset 计算在构造函数（`nmethod.cpp:693-755`）中完成：

```
_consts_offset = content_offset() + code_buffer->total_offset_of(consts());   // :693
_stub_offset   = content_offset() + code_buffer->total_offset_of(stubs());     // :694
```

`content_offset()` = `content_begin() - header_begin()` = header_size + relocation_size 对齐后。`_oops_offset = data_offset()` (CodeBlob 的 data_offset，即 content 结束处，`:746`)。

**CodeBuffer 的 section 概念**：编译器（C2/C1）生成 CodeBuffer，其中分 4 个 section：insts（指令）、stubs（桩）、consts（常量）、code（整体）。nmethd 构造函数将这些 section 按顺序拷贝到连续内存中。

**Native wrapper 构造函数的不同**（`nmethod.cpp:550-639`）：Native method wrapper 不使用 CodeBuffer 再 layout，而是将所有 section offset 设置为 `data_offset()`（`:580-589`），因为 wrapper 没有独立的 consts/stubs/metadata 段。

### §三.3 metadata section：oops → scopes_data → scopes_pcs → deps → handlers → nul_chk

metadata section 位于 `data_offset()` 之后，是连续附加的多个子段。完整计算链（`nmethod.cpp:746-754`）：

```
_oops_offset       = data_offset();                                                   // :746
_metadata_offset   = _oops_offset       + align_up(total_oop_size(), oopSize);         // :747
scopes_data_offset = _metadata_offset   + align_up(total_metadata_size(), wordSize);   // :748
_scopes_pcs_offset = scopes_data_offset + align_up(debug_info->data_size(), oopSize);  // :750
_dependencies_offset = _scopes_pcs_offset + adjust_pcs_size(debug_info->pcs_size());   // :751
_handler_table_offset = _dependencies_offset + align_up(dependencies->size_in_bytes(), oopSize); // :752
_nul_chk_table_offset = _handler_table_offset + align_up(handler_table->size_in_bytes(), oopSize); // :753
_nmethod_end_offset   = _nul_chk_table_offset + align_up(nul_chk_table->size_in_bytes(), oopSize); // :754
```

注意关键细节：
1. **oop/metadata 索引 0 预留为 NULL**（`nmethod.hpp:362-363`）—— `oop_at(0)` 返回 NULL，实际 oop 从 `oops_begin()[0]` = index 1 开始
2. **`adjust_pcs_size()`**（`nmethod.cpp:372-378`）确保 PcDesc 数组大小既是 oopSize 又是 sizeof(PcDesc) 的倍数
3. **total_size()**（`nmethod.cpp:382-391`）只累加 7 段（consts + insts + stub + scopes_data + scopes_pcs + handler_table + nul_chk_table），不包含 header_size 和 relocation_size。此值被 `CodeCache::free()` 用于计算回收的 FreeBlock 大小，进而影响 CodeHeap 的空闲空间管理（当整个段被 `munmap(2)` 归还内核时，参见 `man 2 munmap` 关于 `MAP_NORESERVE` 区域的部分释放限制）

**三段布局的内存示意图**：

```
┌──────────────────────────────────────────────────────────────┐
│ header_begin() = (address) this                              │
│ [nmethod C++ 成员]  sizeof(nmethod) ≈ 200 bytes              │
├──────────────────────────────────────────────────────────────┤
│ [relocation info]  重定位表                                   │
├──────────────────────────────────────────────────────────────┤
│ content_begin()                                               │
│ [consts]  常量池 (doubles, longs, floats)                     │
│ [insts]   编译后的 x86 指令                                   │
│ [stubs]   桩代码 (异常/deopt/静态调用桩)                       │
│ data_offset() ──────────────────────────────────────────     │
│ [embedded oops]     oop[] 表，index 0 预留                   │
│ [embedded metadata] Metadata*[] 表，index 0 预留              │
│ [scopes_data]       DebugInfo 数据（压缩的栈帧信息）           │
│ [scopes_pcs]        PcDesc[] 数组（PC→scope 映射）            │
│ [dependencies]      编译依赖编码                               │
│ [handler_table]     ExceptionHandlerTable                    │
│ [nul_chk_table]     ImplicitExceptionTable                   │
│ data_end() ────────────────────────────────────────────      │
└──────────────────────────────────────────────────────────────┘
```

> **Counterfactual** — 如果每个 section 用独立 C++ 对象（new SectionData）而非内联在连续内存中？额外开销：每个独立对象至少增加 vtable 指针（8B）+ malloc header（16B）+ 内存碎片（~8B），8 个 section 额外 ~256B/每 nmethod × 10000 nmethod = ~2.5MB 额外开销。更关键的是 loss of cache locality —— 当前布局保证 PC 执行到访问 scope data 时的内存访问在同一 page 内，独立对象会导致跨 page 访问。

---

## §四 状态转换引擎：make_not_entrant_or_zombie() 全链

### §四.1 in_use → not_entrant：uncommon trap 异步补丁

`make_not_entrant_or_zombie()`（`nmethod.cpp:1161-1313`）是 nmethod 状态机的核心引擎。当 uncommon trap 触发时调用 `make_not_entrant()`（`nmethod.hpp:338-340`），它转发到 `make_not_entrant_or_zombie(not_entrant)`。

完整实现流程（`nmethod.cpp:1161-1313`）：

**阶段 0：快速路径检查**（`:1171-1177`）：
```cpp
if (_state == state) {
    return false;  // 已是目标状态，无需获取锁
}
```
这是安全的因为是 end-state —— nmethod 一旦进入 not_entrant/zombie 就不可回退。

**阶段 1：保护栈建立**（`:1179-1182`）：
```cpp
nmethodLocker nml(this);                    // 增加 _lock_count，防止并发 flush
methodHandle the_method(method());          // Handles 中保存 method，防止 GC 回收
NoSafepointVerifier nsv;                    // 禁止 safepoint —— 补丁代码必须是原子操作
```

**阶段 2：OSR 方法特殊路径**（`:1197-1200`）：
OSR nmethod 在获取 Patching_lock 之前先调用 `invalidate_osr_method()`，从 InstanceKlass::osr_nmethods_head 链表中移除。此顺序是为了避免与 Patching_lock 之间的死锁（两者都是 leaf lock）。

**阶段 3：Patching_lock 临界区**（`:1203-1261`）：
```cpp
MutexLockerEx pl(Patching_lock, Mutex::_no_safepoint_check_flag);
```
Patching_lock 是 per-CodeCache 的轻量 leaf lock，`_no_safepoint_check_flag` 确保临界区内不会进入 safepoint。

在锁内执行：
1. **CAS 双重检查**（`:1205-1209`）：另一个线程可能已执行状态转移
2. **NativeJump 补丁**（`:1213-1216`）：
   ```cpp
   if (!is_osr_method() && !is_not_entrant()) {
       NativeJump::patch_verified_entry(entry_point(), verified_entry_point(),
                   SharedRuntime::get_handle_wrong_method_stub());
   }
   ```
   将 `_verified_entry_point` 处开始的 NativeJump（x86: 5 字节 JMP）替换为跳转到 `handle_wrong_method_stub` 的指令。从此之后，所有通过 IC `vep()` 的调用都被重定向。
3. **decompile 计数**（`:1218-1222`）：`inc_decompile_count()` 更新 MethodData 的 `_decompile_count`
4. **zombie 取订**（`:1226-1229`）：如目标状态是 zombie，标记 `nmethod_needs_unregister = true`
5. **栈扫描标记 + StoreStore 屏障**（`:1235-1238`）：
   ```cpp
   if (state == not_entrant) {
       mark_as_seen_on_stack();
       OrderAccess::storestore();  // 确保 _stack_traversal_mark 写入先于 _state 写入可见
   }
   ```
   `OrderAccess::storestore()` 保证在其他 CPU 上 `_stack_traversal_mark` 的更新先于 `_state` 的更新被观测到，防止 `can_convert_to_zombie()` 看到新状态但旧栈标记的竞态窗口。
6. **状态写入 + 日志**（`:1241-1244`）：`_state = state; → log_state_change()`
7. **Method 解绑**（`:1256-1259`）：如果 `method()->code() == this`，调用 `method()->clear_code(false)`

**阶段 4：zombie 后处理**（`:1275-1301`）：
在 Patching_lock 释放后，如果状态是 zombie：
```cpp
MutexLockerEx mu(CodeCache_lock, Mutex::_no_safepoint_check_flag);
if (nmethod_needs_unregister) {
    Universe::heap()->unregister_nmethod(this);   // :1282
}
flush_dependencies(true);                         // :1284
```
`safepoint_check_flag` 保护 `unregister_nmethod()` 在 CodeCache_lock 下执行。完成后调用 `post_compiled_method_unload()` 通知 JVMTI agent，最后 `set_method(NULL)` 断开 Method 的指针。

### §四.2 not_entrant → zombie：Sweeper 协同与 can_convert_to_zombie

从 not_entrant 到 zombie 的转换由 NMethodSweeper 驱动：

1. **栈扫描标记**（`nmethod.cpp:1006-1011`）：GC safepoint 期间栈扫描调用 `mark_as_seen_on_stack()`，设置 `_stack_traversal_mark = NMethodSweeper::traversal_count()`

2. **可转换条件检查**（`nmethod.cpp:1016-1024`）：
   ```cpp
   return stack_traversal_mark()+1 < NMethodSweeper::traversal_count()
          && !is_locked_by_vm();
   ```
   需要在当前 traversal count 之后的 sweep pass 中才会被再次扫描 —— "+1" 保证了至少一个完整的 sweep cycle 来确认栈上激活已清空。`!is_locked_by_vm()` 检查 `_lock_count == 0`（JVMTI 正在使用时不转换）。

3. **Sweeper 调用 make_zombie()**（`nmethod.hpp:343`）：`make_zombie()` 转发到 `make_not_entrant_or_zombie(zombie)`，使用同一引擎。

**hotness_counter 的衰减与 restart**（`nmethod.hpp:160` + `nmethod.cpp:996-1004`）：`_hotness_counter` 初始化为 `NMethodSweeper::hotness_counter_reset_val()`（默认 40）。每轮 sweep cycle 通过 `dec_hotness_counter()`（`nmethod.hpp:496`）递减。非递减时表示方法近期活跃（IC 命中或栈上遍历），Sweeper 据此决定是否保留 in_use 方法。`make_not_entrant()` 时 hotness 清零（`:1200`），防止已不可用的 nmethod 被误会为活跃。

### §四.3 zombie → flush：CodeCache 回收

`flush()`（`nmethod.cpp:1315-1355`）在 `CodeCache_lock` 保护下执行：

```cpp
// 1. 清理 ExceptionCache 链表 (:1336-1342)
ExceptionCache* ec = exception_cache();
set_exception_cache(NULL);
while(ec != NULL) {
    ExceptionCache* next = ec->next();
    delete ec;
    ec = next;
}

// 2. 从 scavenge root 链表移除 (:1344-1346)
if (on_scavenge_root_list()) {
    CodeCache::drop_scavenge_root_nmethod(this);
}

// 3. 调用基类 flush (:1353)
CodeBlob::flush();  // 释放 ImmutableOopMapSet + CodeStrings

// 4. CodeCache 回收 (:1354)
CodeCache::free(this);
```

`CodeCache::free()` 将 nmethod 的 CodeHeap 段标记为空闲，加入 FreeBlock 链表供后续编译复用。此时并不一定调用 `munmap(2)` —— 空闲空间留在进程地址空间中等待其他 allocation 复用。

> **Counterfactual** — 如果删除 not_entrant 中间态，直接从 in_use→zombie？GC safepoint 时必须遍历所有线程栈标记 zombie，延迟从微秒级暴增到毫秒级（safepoint 代价）。not_entrant 的异步补丁 + 延迟回收将"停止新调用"与"清理栈上激活"解耦。另外，not_entrant 方法可在栈上激活清零后被 revivable（从 not_used 恢复，尽管实际不被使用）。

> **Counterfactual** — 如果用全局 Mutex 代替 Patching_lock 保护所有 nmethod 的状态转移？Patching_lock 是 per-CodeCache 的轻量锁，只保护 verified_entry patching 操作。全局锁会串行化所有 nmethod 的状态转换，在大量 uncommon trap 场景下成为瓶颈（估算：100 个线程同时 deopt 100 个不同 method，全局锁串行化 → ~1ms，Patching_lock 并发 → ~10μs）。

---

## §五 PcDesc 查找与 ScopeDesc 定位

### §五.1 PcDescCache(4-element LRU) 的设计与并发

PcDesc（PC Descriptor）将机器指令地址映射到调试信息（scope、字节码偏移）。每个 nmethod 包含一个 PcDesc 数组（`scopes_pcs_begin()` → `scopes_pcs_end()`），典型的 C2 编译方法有数百条 PcDesc。

**PcDescCache 结构**（`compiledMethod.hpp:80-96`）：
```cpp
class PcDescCache {
    enum { cache_size = 4 };
    volatile PcDescPtr _pc_descs[4];  // volatile 防止编译器重复读取
};
```

**为什么 cache_size = 4？**
- 与 L1 cache line（64B）对齐：4 × 8B = 32B，加上 cache 控制数据总和 ≈ 64B，适合一个 cache line
- 多线程共享时（注释提到"many threads are updating it"），volatile 共享访问使 cache line bouncing 抵消了更大缓存的收益

**查找流程**（`nmethod.cpp:323-357`）：
1. **Step 1**：检查 `_pc_descs[0]`（最近添加的）—— 高频 PC（同一调用点反复查询）大概率命中
2. **Step 2**：扫描 `_pc_descs[1..3]`，遇到 `pc_offset() < 0` 的哨兵值提前跳出
3. **Step 3**：缓存未命中，返回 NULL → 触发线性+radix 二分搜索

**PcDescSearch 封装**（`compiledMethod.hpp:98-112`）：
```cpp
class PcDescSearch {
    address _code_begin;   // 用于计算 pc_offset
    PcDesc* _lower;        // scopes_pcs_begin()
    PcDesc* _upper;        // scopes_pcs_end()
};
```

**PcDescContainer 的协作**（`compiledMethod.hpp:114-131`）：
```cpp
PcDesc* find_pc_desc(address pc, bool approximate, const PcDescSearch& search) {
    address base_address = search.code_begin();
    PcDesc* desc = _pc_desc_cache.last_pc_desc();
    if (desc != NULL && desc->pc_offset() == pc - base_address) {
        return desc;  // 快速路径：缓存直接命中
    }
    return find_pc_desc_internal(pc, approximate, search);
}
```

**find_pc_desc_internal 定位算法**（`nmethod.cpp:1814-1893`）：
1. **Range check**：`pc - base_address >= PcDesc::upper_offset_limit` → NULL
2. **Cache check**：再次查询 `_pc_desc_cache.find_pc_desc()`
3. **二分策略**：从上次成功的 `last_pc_desc()` 作为 split point，使用 fixed-radix step（4096 → 256 → 16 → 1）加速搜索，最后线性逼近
4. **Cache update**：找到后调用 `_pc_desc_cache.add_pc_desc(upper)` 插入 LRU

> **Counterfactual** — 如果 cache_size = 16？每次 cache miss 需要扫描 16 个元素（vs 4），在 cache line bouncing 场景下性能可能更差 —— 因为 16 个元素跨越 2-4 个 cache line，导致更多 cache miss。而且 volatile 访问的缓存一致性能使搜索开销大于收益。

### §五.2 scope_desc_at() → new ScopeDesc() 的延迟创建

当 GDB/StackWalker 需要栈帧信息时，调用 `scope_desc_at()`：

```cpp
// compiledMethod.hpp:224
ScopeDesc* scope_desc_at(address pc) {
    PcDesc* pd = pc_desc_at(pc);
    guarantee(pd != NULL, "scope must be present");
    return new ScopeDesc(this, pd->scope_decode_offset(), ...);  // 每次创建新对象
}
```

`ScopeDesc` 是延迟创建的 —— 只在需要时才分配 ResourceArea 对象，解码 scope_data 中的压缩调试信息。pd 的 `scope_decode_offset()` 指向 `scopes_data_begin()` 中的偏移，`obj_decode_offset()` 指向 oop 表的偏移。

---

## §六 GC 与 nmethod 的交互

### §六.1 oops_do()：嵌入式 oop 的 GC 根扫描

`oops_do()`（`nmethod.cpp:1601-1631`）遍历 nmethod 中的两类 oop 引用：
1. **指令流中直接嵌入的 oop**：通过 RelocIterator 遍历 `oop_type` 重定位，调用 `OopClosure::do_oop()`
2. **oops section 中的 oop**：调用 `f->do_oop(p)` 遍历 `oops_begin()` → `oops_end()`

**RelocIterator 的遍历机制**（`nmethod.cpp:1601-1631`）：`RelocIterator` 从 `relocation_begin()` 走到 `relocation_end()`，解码每个 relocation entry 的 type。`oop_type` relocation 标记代码中嵌入 oop 的位置（32 位绝对地址或 64 位压缩指针）。GC 在此处需要更新引用地址（对象移动后）。

**volatile barrier 的语义**（`nmethod.cpp:1603-1607`）：`is_zombie()` 检查通过 `OrderAccess::load_acquire()` 读取 `_state`，作为与 `make_not_entrant_or_zombie()` 中 `_state = state` 存储的配对屏障。这保证了：如果 oops_do 看到 zombie 状态，则它必然能看到对应的 not_entrant 补丁效果（NativeJump patch 已在 store-state 之前发生），避免扫描已被补丁覆盖的 oop 地址。

**oop index 0 预留规则**（`nmethod.hpp:362-363` + `nmethod.cpp:1613-1618`）：`oop_at(0)` 返回 NULL——索引 0 被显式预留。`oops_do()` 从 `oops_begin()` + `oopSize` 开始遍历（即 index 1），而非 `oops_begin()`。原因：RelocIterator 使用 0 作为哨兵值（"无 oop"），若索引 0 有真实 oop 会产生混淆。

**ScavengeRootsInCode 的交互**（`nmethod.cpp:1625-1629`）：当 `ScavengeRootsInCode` 开启时，年轻代 GC 只扫描 `scavenge_root_list` 上的 nmethod（而非全量），但 oops_do 本身仍扫描两类 oop。区别在于：被调用时机不同——年轻代 GC 遍历链表时只调用 oops_do 给已注册且标记为 `sl_marked` 的 nmethod。

注意 `is_zombie()` 检查：如果 `allow_zombie == false` 且 nmethod 是 zombie，assert 失败 —— zombie 不参与 GC 扫描（`:1603`）。

### §六.2 do_unloading()：GC 时卸载不可达 oop

`do_unloading()`（`compiledMethod.cpp:459-478`）在 GC 的标记阶段后调用：
```cpp
if (do_unloading_oops(low_boundary, is_alive)) {
    return;  // 此 nmethod 已因 oop 死亡而被 make_unloaded
}
```

`do_unloading_oops()`（`nmethod.cpp:1519-1535`）检查两类 oop：
1. **代码中直接嵌入的 oop**（`:1523-1532`）：通过 RelocIterator 遍历，`unload_if_dead_at()` 检查每个 oop 是否存活
2. **scopes 中的 oop**（`:1534`）：`do_unloading_scopes()` 遍历 `oops_begin()` → `oops_end()`，调用 `can_unload(is_alive, p)`

`can_unload()`（`nmethod.cpp:1402-1413`）在发现 oop 死亡时调用 `make_unloaded(obj)`，将 nmethod 转为 unloaded 状态。

**oops_reloc_begin() 的边界处理**（`compiledMethod.cpp:240-254`）：
```cpp
address low_boundary = verified_entry_point();
if (!is_in_use() && is_nmethod()) {
    low_boundary += NativeJump::instruction_size;  // 跳过 not_entrant 补丁区域
}
```
not_entrant 方法中 `_verified_entry_point` 处已被 NativeJump 补丁覆盖，原有 oop 可能被破坏 —— 将扫描起点后移一个 NativeJump 大小避免误报。

### §六.3 scavenge_root_list：年轻代 GC 的快速路径

**注册**（构造函数 `nmethod.cpp:769-771`）：
```cpp
if (ScavengeRootsInCode) {
    Universe::heap()->register_nmethod(this);
}
```
将 nmethod 加入 `CodeCache::scavenge_root_nmethods` 链表（通过 `_scavenge_root_link` union 字段）。年轻代 GC 只需扫描此链表，避免遍历所有 nmethod。

**位域定义**（`nmethod.hpp:395-395`）：
```cpp
enum { sl_on_list = 0x01,  // bit0: 已注册在scavenge root链表中
       sl_marked   = 0x10   // bit4: GC标记位（仅PRODUCT模式）};
```

---

## §七 依赖与 IC 的生命周期连接

### §七.1 clean_ic_if_metadata_is_dead()：IC 中的过时元数据

`clean_ic_if_metadata_is_dead()`（`compiledMethod.cpp:371-400`）在 GC 后清除 IC（Inline Cache）中的过时 metadata：

```cpp
if (ic->is_icholder_call()) {
    CompiledICHolder* cichk_metadata = ic->cached_icholder();
    if (cichk_metadata->is_loader_alive()) return;  // class loader 存活，IC 仍然有效
} else {
    Metadata* ic_metadata = ic->cached_metadata();
    if (ic_metadata != NULL) {
        if (ic_metadata->is_klass() && ((Klass*)ic_metadata)->is_loader_alive()) return;
        if (ic_metadata->is_method() && method->method_holder()->is_loader_alive()) return;
    }
}
ic->set_to_clean();  // 否则将 IC 设为 clean 状态
```

判断依据是 class loader 是否存活（`is_loader_alive()`），而非 metadata 对象本身 —— 因为 class unloading 会回收整个 class 层次。

### §七.2 flush_dependencies()：依赖链的反向清理

`flush_dependencies()`（`nmethod.cpp:1371-1398`）清除双向依赖关系：

```cpp
for (Dependencies::DepStream deps(this); deps.next(); ) {
    if (deps.type() == Dependencies::call_site_target_value) {
        MethodHandles::remove_dependent_nmethod(call_site, this);  // CallSite 依赖
    } else {
        Klass* klass = deps.context_type();
        if (delete_immediately || klass->is_loader_alive()) {
            InstanceKlass::cast(klass)->remove_dependent_nmethod(this, delete_immediately);
        }
    }
}
```

两个调用场景：
1. **zombie 时 `delete_immediately=true`**（zombie 后其他线程不应再访问依赖）
2. **GC 时 `delete_immediately=false`**（GC 期间可能有线程在遍历 InstanceKlass 的依赖图，使用 deferred deletion 避免竞争）

`_has_flushed_dependencies` 确保只执行一次（`:1375`）。

---

## §八 ExceptionCache：异常处理的缓存层

ExceptionCache（`compiledMethod.hpp:43-74`）是异常派发的运行时缓存，与编译时编码的 `handler_table` 不同：

```cpp
class ExceptionCache : public CHeapObj<mtCode> {
    enum { cache_size = 16 };
    Klass*   _exception_type;          // 异常类型（如 NullPointerException::klass()）
    address  _pc[cache_size];          // 抛出 PC 数组
    address  _handler[cache_size];     // handler 入口数组
    volatile int _count;              // 实际条目数
    ExceptionCache* _next;            // 链表下一个节点
};
```

**为什么用链表而非哈希表？**
- 每个 throw-catch 点通常只有 1-3 种异常类型
- `cache_size=16` 的线性扫描（最坏 16 次比较）比哈希计算（至少 30 cycles）更快
- 高频异常（`NullPointerException`）通常在 cache[0] 命中

**链表结构**：多个 ExceptionCache 节点通过 `_next` 链接，按异常类型分组。同一异常类型有多个 (pc, handler) 对（最多 16 个）。

**并发读 + 锁写模式**：
- 读取（`handler_for_exception_and_pc()`, `compiledMethod.cpp:143-156`）：不拿锁，通过 `_exception_cache` 的 volatile 读取遍历链表
- 写入（`add_handler_for_exception_and_pc()`, `:158-172`）：拿 `ExceptionCache_lock`，通过 `release_set_exception_cache()` → `OrderAccess::release_store()` 保证写入可见性

**flush 时清理**（`nmethod.cpp:1336-1342`）：
```cpp
ExceptionCache* ec = exception_cache();
set_exception_cache(NULL);
while(ec != NULL) {
    ExceptionCache* next = ec->next();
    delete ec;             // C-Heap delete，不是 CodeCache 内存
    ec = next;
}
```

---

## §九 Counterfactual 对比表

| 设计决策 | 当前实现 | 反事实替代 | 后果 |
|---------|---------|-----------|------|
| **offset vs 指针** | int offset 字段定位 section | C++ 指针指向各 section | 不支持 CodeCache relocation；GC 移动需更新所有 nmethod 指针 |
| **连续内存 vs 独立对象** | 所有 section 内联在连续内存中 | 每个 section 独立 new 对象 | 额外 ~200B/nmethod + cache locality 损失 |
| **not_entrant 中间态** | in_use → not_entrant → zombie | in_use 直接 → zombie | 需要 safepoint 遍历所有线程栈，延迟从 μs→ms 级 |
| **Patching_lock vs 全局Mutex** | per-CodeCache light lock | 全局 Mutex 串行化 | 多线程 deopt 场景成为瓶颈 (1ms vs 10μs) |
| **PcDescCache(4) vs (16)** | 4-element LRU | 16-element LRU | cache line bouncing 抵消收益，跨多 cache line |
| **ExceptionCache 链表 vs 哈希表** | 线性链表 scan ≤16 | 开放定址哈希表 | 哈希计算开销 > 线性扫描，cache[0] 已大概率命中 |
| **CodeCache::free() vs libc free()** | CodeHeap 内 FreeBlock 回收 | 直接 free() 归还 libc | 无法复用空间；munmap/mmap 重映射页表项开销 |
| **_lock_count vs 拷贝 nmethod** | JVMTI 引用计数延迟 flush | JVMTI 拷贝 nmethod 信息 | 每次 unload 约 200B 拷贝 × 数千个 = 500KB 额外分配 |
| **scavenge_root_list vs 全扫描** | 年轻代GC扫描注册链表 | 每次GC扫描所有nmethod | 无用扫描增加 GC 停顿时间（数千个 nmethod ≈ ms 级） |

---

## §十 诊断工具（jcmd + GDB + strace 三步验证）

### jcmd 工具

```bash
# 1. 查看 CodeCache 使用情况
jcmd <pid> Compiler.codecache
# 预期输出：每种 CodeBlobType 的使用百分比

# 2. 查看所有编译
jcmd <pid> Compiler.queue

# 3. 打印 JIT 编译日志（若启用了 -XX:+LogCompilation）
jcmd <pid> VM.log output="jit.log" output_options="filecount=0" what="codecache,sweep,nmethod"
```

### GDB Verification（≥8 assertions）

```gdb
# 1. 找到所有 nmethod
(gdb) p CodeCache::blob_count()
# 预期：> 0

# 2. 检查单个 nmethod 的状态
(gdb) p ((nmethod*)0x...) ->_state
# 预期：-1(not_installed), 0(in_use), 2(not_entrant), 3(zombie), 4(unloaded)

# 3. 验证 nmethod 布局的 section offset 一致性
(gdb) p ((nmethod*)0x...) ->_consts_offset
(gdb) p ((nmethod*)0x...) ->_stub_offset
(gdb) p ((nmethod*)0x...) ->_oops_offset
# 预期：_consts_offset < _stub_offset < _oops_offset（单调递增）

# 4. 验证 make_not_entrant 的效果
(gdb) b nmethod::make_not_entrant_or_zombie
(gdb) c
# 在断点处检查：_state 从 0 (in_use) → 2 (not_entrant) 转变

# 5. 检查 PcDesc 缓存
(gdb) p ((nmethod*)0x...) ->_pc_desc_container
(gdb) p ((nmethod*)0x...) ->_pc_desc_container._pc_desc_cache._pc_descs[0]
# 预期：非 NULL PcDesc 指针

# 6. 验证 ExceptionCache 链表
(gdb) p ((nmethod*)0x...) ->_exception_cache
(gdb) p ((nmethod*)0x...) ->_exception_cache->_next
# 预期：链表结构，每个节点包含 exception_type + pc[16] + handler[16]

# 7. 检查 scavenge root 注册
(gdb) p ((nmethod*)0x...) ->_scavenge_root_state
# 预期：0（未注册）或 1（已注册，如果 ScavengeRootsInCode）

# 8. 验证 _lock_count 的 JVMTI 使用
(gdb) p ((nmethod*)0x...) ->_lock_count
# 预期：通常为 0；如果 JVMTI CompiledMethodUnload 事件正在处理，> 0

# 9. 追踪 complete 的调用链
(gdb) b nmethod::nmethod
(gdb) bt
# 预期看到：new_nmethod → operator new(placement) → nmethod::nmethod

# 10. 验证 hotness_counter
(gdb) p ((nmethod*)0x...) ->_hotness_counter
# 预期：正整数，初始值 = NMethodSweeper::hotness_counter_reset_val()
```

### strace 验证 CodeCache 分配

```bash
# 追踪 JVM 启动期间的 mmap/mprotect 系统调用
strace -e trace=mmap,mprotect -f -o /tmp/jvm-syscalls.log java -XX:-TieredCompilation -Xbatch -version

# 预期输出中的关键模式：
# mmap(NULL, ..., PROT_NONE, MAP_PRIVATE|MAP_ANONYMOUS|MAP_NORESERVE, -1, 0) = CodeCache虚拟地址
# mprotect(addr, 4096, PROT_READ|PROT_WRITE|PROT_EXEC) = 0  # 逐页提交
```
详细 syscall 语义参见 `man 2 mmap`（`MAP_NORESERVE` 标志——预分配虚拟空间但不提交物理页）和 `man 2 mprotect`（`PROT_EXEC` + `PROT_WRITE` 同时存在的 W^X 含义——`deny_execmem` 可通过 `man 5 proc` 查看 `/proc/sys/kernel/yama/ptrace_scope` 相关控制）。`nmethod::flush()` 中的日志输出通过 `tty->print()` 底层调用 `write(2)`（`man 2 write`），如启用 `PrintMethodFlushing` 按 `ttyLocker` 保护输出。

---

## §十一 "不要写成→应该写成" 对照表

| 不要写成 | 应该写成 |
|---------|---------|
| "nmethod 有 _state 字段表示状态" | `_state` (`nmethod.hpp:128`) 是 `volatile signed char`（非 bool），包含 -1..4 共 6 个状态值。volatile 确保 Patching_lock 保护之外的快速检查（`is_in_use()` 可直接读 `_state` 而无锁） |
| "patch_verified_entry 修改入口代码" | `NativeJump::patch_verified_entry()` (`nmethod.cpp:1214`) 将 `_verified_entry_point` 开始的 NativeJump（x86: 5 字节 JMP）替换为跳转到 `handle_wrong_method_stub` 的指令。这是 not_entrant 状态的关键副作用 —— 之后所有通过 vep() 的 IC 调用都被重定向 |
| "PcDescCache 有 4 个元素的 LRU" | `PcDescCache(cache_size=4)` (`compiledMethod.hpp:83`)。注意 `volatile PcDescPtr _pc_descs[4]` (`:89`) 的并发安全：`find_pc_desc()` 首先检查 `_pc_descs[0]` 无需遍历，然后扫描 1-3。多线程共享通过 volatile 保证可见性，但注释 (`nmethod.cpp:327-331`) 指出 cache line bouncing 可能抵消收益 |
| "make_not_entrant_or_zombie 用 Patching_lock 保护" | `MutexLockerEx pl(Patching_lock, Mutex::_no_safepoint_check_flag)` (`nmethod.cpp:1203`) — leaf lock 确保临界区内无 safepoint，保护 patch + clear_code 的原子性。配合 `NoSafepointVerifier nsv` (`:1182`) 双重保证 |
| "flush 释放 nmethod 内存" | `CodeCache::free(this)` (`nmethod.cpp:1354`) 将 nmethod 的 CodeHeap 段标记为空闲 FreeBlock，供后续编译复用，不立即调用 `munmap(2)`。先前 `CodeBlob::flush()` (`:1353`) 只释放 ImmutableOopMapSet 和 CodeStrings 的 C-Heap 内存 |
| "nmethod::oops_do() 遍历嵌入 oop" | `oops_do()` (`nmethod.cpp:1601`) 通过 `oops_reloc_begin()` 计算边界，然后调用 `OopClosure::do_oop()`。注意 index 0 是预留的 NULL (`nmethod.hpp:362-363`)，所有实际 oop 从 index 1 开始 |
| "nmethodLocker 增加引用计数" | `lock_nmethod()` (`nmethod.cpp:2054`) 使用 `Atomic::inc(&nm->_lock_count)`，`unlock_nmethod()` (`:2062`) 使用 `Atomic::dec()`。JVMTI 的 `CompiledMethodUnload` 事件处理依赖此功能：在异步事件队列处理期间锁住 nmethod 防止 flush |
| "OrderAccess::storestore() 在 make_not_entrant 中" | `OrderAccess::storestore()` (`nmethod.cpp:1237`) 在 `mark_as_seen_on_stack()` 后确保 `_stack_traversal_mark` 的写入先于 `_state` 写入在任何其他 CPU 上可见，防止 `can_convert_to_zombie()` 看到新状态但旧栈标记的竞态窗口 |
| "total_size() 计算 nmethod 占用的总 CodeCache 空间" | `total_size()` (`nmethod.cpp:382-391`) 累加 7 个 sections (consts + insts + stub + scopes_data + scopes_pcs + handler_table + nul_chk_table)，不包括 header_size 和 relocation_size。这是 CodeCache 空间管理的核心指标 |
| "do_unloading 卸载不可达类" | `do_unloading()` (`compiledMethod.cpp:459`) 调用 `do_unloading_oops()` 遍历代码和 scopes 中的 oop，发现 oop 死亡则调用 `can_unload()` → `make_unloaded(obj)`，将 nmethod 标记为 unloaded |
| "ScavengeRootsInCode 优化年轻代 GC" | 构造函数 `nmethod.cpp:769-771` 中 `Universe::heap()->register_nmethod(this)` 将 nmethod 注册到 scavenge root 链表。年轻代 GC 只需扫描此链表，通过 `_scavenge_root_state` (`nmethod.hpp:395`): `sl_on_list=0x01, sl_marked=0x10` 管理注册状态 |

---

## §十二 Cross-Reference

### 前向依赖（本文档依赖的其他文档）

- **Phase 24 doc-00**（Core Containers）— `GrowableArray`/`ResourceHashtable` 在 `check_all_dependencies()` (`nmethod.cpp:1896`) 中使用
- **Phase 23**（logging）— `nmethod::log_new_nmethod()` (`nmethod.cpp:816`) 使用 `xtty` XML 日志
- **libjvm-analysis/05-jit-compiler/04-CodeCache-Sweeper.md** — nmethod 生命周期高层视角

### 后向供给（依赖本文档的后续文档）

- **prompt-01**（Debug Info & Metadata）— `scope_desc_at()` (`compiledMethod.hpp:224`) 创建 `ScopeDesc`，需要本文档的 `pc_desc_at()` 分析作为前置
- **prompt-02**（Dependencies, IC & Exceptions）— `CompiledIC` 行走和依赖注册依赖本文档的 nmethod 布局分析

### 相邻文档关系

- **doc-00**（本文）— 定义 code/ 的物体模型（nmethod 物理形态、内存布局、生命周期）
- **doc-01** — 解释 `pc_desc_at()` → `scope_desc_at()` 的内联帧恢复
- **doc-02** — 解释 IC（编译后内联缓存）的 patching 和依赖管理

### 关键源文件交叉引用

| 主题 | 文件:行号 | 关键函数/变量 |
|------|----------|-------------|
| nmethod 构造函数 | `nmethod.cpp:645-795` | `nmethod::nmethod()` — 完整 offset 计算 |
| new_nmethod 工厂 | `nmethod.cpp:468-547` | `new_nmethod()` — CodeCache_lock + 依赖注册 |
| 状态转换引擎 | `nmethod.cpp:1161-1313` | `make_not_entrant_or_zombie()` |
| 状态枚举定义 | `compiledMethod.hpp:188-197` | `not_installed=-1 ... unloaded=4` |
| PcDesc 缓存 | `compiledMethod.hpp:80-96` + `nmethod.cpp:311-367` | `PcDescCache` + `find_pc_desc()` |
| PcDesc 定位 | `nmethod.cpp:1814-1893` | `find_pc_desc_internal()` — radix 搜索 |
| ExceptionCache | `compiledMethod.hpp:43-74` + `nmethod.cpp:242-296` | `ExceptionCache` + `match()` |
| GC oop 扫描 | `nmethod.cpp:1601-1631` | `oops_do()` |
| GC unloading | `nmethod.cpp:1519-1535` + `compiledMethod.cpp:459-478` | `do_unloading_oops()` + `do_unloading()` |
| 依赖注册 | `nmethod.cpp:523-536` | `Dependencies::DepStream` |
| 依赖清理 | `nmethod.cpp:1371-1398` | `flush_dependencies()` |
| flush 回收 | `nmethod.cpp:1315-1355` | `flush()` → `CodeCache::free()` |
| nmethodLocker | `nmethod.hpp:630-669` + `nmethod.cpp:2044-2068` | `lock_nmethod()` / `unlock_nmethod()` |
| scavenge root | `nmethod.hpp:395-406` + `nmethod.cpp:769-771` | `_scavenge_root_state` + `register_nmethod()` |
| adjust_pcs_size | `nmethod.cpp:372-378` | PcDesc 数组对齐 |
| total_size 计算 | `nmethod.cpp:382-391` | 7 段累加 |

### nmethod::verify() — 运行时完整性检查

`nmethod::verify()`（`nmethod.cpp:2038-2116`）是 CodeCache 诊断的关键函数，在 `-XX:+VerifyCodeCache` 或 `debug` 模式下定期调用。验证项目包括：

1. **header 校验**：检查 `this` 地址在 CodeCache 范围内、`is_alive()` 状态合法
2. **section 一致性**：验证 `_consts_offset < _stub_offset`、`_oops_offset < _metadata_offset` 等单调性不变式（nmethod.cpp:2080-2098）
3. **PcDesc 有效性**：遍历 `scopes_pcs_begin()` → `scopes_pcs_end()` 检查每个 PcDesc 的 `scope_decode_offset()` 在合法范围内
4. **ExceptionCache 有效性**：遍历链表确认每个节点均在 C-Heap 且 `_count ≤ 16`
5. **oop/metadata 表边界**：检查 `oops_begin()` / `oops_end()` 指针在 data section 内
6. **scavenge root 一致性**（如果 `ScavengeRootsInCode`）：验证 `_scavenge_root_state` 与 `CodeCache::scavenge_root_nmethods` 链表匹配

`verify()` 在 debug fastdebug 构建中为完整版本，在 product 构建中为空操作（`#ifdef ASSERT` 编译）。

---

## §十三 Edge Cases — 四类关键边缘场景

### §十三.1 SELinux/AppArmor W^X 策略 → mprotect(PROT_EXEC) 返回 EACCES

**场景**：在启用了 `deny_execmem` 的 SELinux 策略或 AppArmor 配置的系统上（`setsebool deny_execmem on`），`mprotect(2)` 对 CodeCache 页面添加 `PROT_EXEC` 权限时返回 `EACCES`。

**根因**：CodeCache 通过 `mmap(MAP_NORESERVE)` 预分配虚拟空间后，以 `PROT_NONE` 持有。编译器提交代码时调用 `mprotect(addr, page_size, PROT_READ|PROT_WRITE|PROT_EXEC)`（参见 `man 2 mprotect`）。`deny_execmem` 限制任何映射同时具有 `PROT_WRITE` 和 `PROT_EXEC`（W^X 原则），`EACCES` 表示此系统不允许创建可写可执行的内存映射。

**HotSpot 处理**（`os::commit_memory()` → `os_linux.cpp`）：
- 如果 mprotect 失败，JVM 记录错误日志并 abort — CodeCache 无法运作
- 启动时可通过 `-XX:+UnlockDiagnosticVMOptions -XX:+CheckJNICalls` 检测环境
- 生产环境必须将 `deny_execmem = off` 或有针对 JVM 进程的 AppArmor 豁免规则

**验证**：
```bash
getsebool deny_execmem                    # 检查 SELinux boolean
grep jvm /etc/apparmor.d/*               # 检查 AppArmor 配置文件
strace -e mprotect java -version 2>&1 | grep EACCES
```

### §十三.2 LD_PRELOAD 劫持 mmap/munmap → CodeCache ENOMEM

**场景**：某些性能分析工具（如 Google perftools/tcmalloc、valgrind）通过 `LD_PRELOAD` 替换 `mmap(2)`/`munmap(2)` 实现自定义内存管理。如果 preload 库的 mmap 对 `MAP_NORESERVE` 区域施加了与实际不符的预留策略，CodeCache 预分配可能失败返回 `ENOMEM`。

**影响链**：
1. `CodeHeap::reserve()` → `os::reserve_memory()` → `mmap(NULL, size, PROT_NONE, MAP_PRIVATE|MAP_ANONYMOUS|MAP_NORESERVE, -1, 0)`（参见 `man 2 mmap`）
2. 如果 preload 的 mmap 包装拒绝 `MAP_NORESERVE`（例如需要立即提交物理页）或施加了更严格的对齐约束，返回 `(address)-1 (errno=ENOMEM)`
3. JVM 在启动时 (`init_globals()`) 创建 CodeCache，如果失败则 abort: `"Could not reserve enough space for code cache"` (`os_linux.cpp`)

**诊断**：
```bash
LD_PRELOAD=/path/to/suspicious.so strace -e mmap,mprotect,madvise java -version 2>&1 | grep -A5 MAP_NORESERVE
# 检查返回地址是否 (void*)-1
# 注意 MAP_NORESERVE 标志（0x400）是否出现在 mmap 参数中
cat /proc/<pid>/maps | grep -i codecache  # 验证 CodeCache 段是否存在
```

### §十三.3 CodeCache 满时分配失败 → Sweeper 触发 → 重试分配

**完整事件链**（CodeCache 空间耗尽场景）：

1. **分配失败检测**：`CodeCache::allocate()` 在 `CodeCache_lock` 保护下扫描 FreeBlockList，如果无合适的空闲块（或碎片化严重），返回 NULL
2. **Sweeper 唤醒**：`new_nmethod()`（`nmethod.cpp:478-487`）检测到 `blob == NULL` → 调用 `CompileBroker::handle_full_code_cache()` 设置 `_should_compile_new_jobs = false` + 通知 Sweeper
3. **Sweeper 第一轮**：`NMethodSweeper::sweep_code_cache()` 遍历所有 nmethod，降级 hotness_counter，将 `can_convert_to_zombie()` 为 true 的 nmethod 转为 zombie，`flush()` 释放空间
4. **重试分配**：`new_nmethod()` 再次调用 `CodeCache::allocate()`（nmethod.cpp:484），如果仍失败，可能：
   - 在 `CodeCache_lock` 释放后等待 safepoint（让更多 GC cycle 完成栈上激活清除）
   - 抛出 `VirtualMachineError("CodeCache is full")`（`nmethod.cpp:545`）
5. **compiler disabled**：如果连续失败，`CompileBroker` 永久禁用编译（`set_should_compile_new_jobs(false)`），JFR 报告 "Compiler has been disabled"

**并发竞态细节**：
- 在步骤 1 和步骤 4 之间，其他线程可能通过 flush zombie 释放了足够空间
- Sweeper 的 `_sweep_fractions_left` 计数控制每次 sweep 的扫描比例，避免长时间占用 CPU
- `-XX:StartAggressiveSweepingAt=<N>` 阈值控制何时启动强制 sweep（默认 10）
- `CodeCacheMinimumFreeSpace`（默认 500KB）定义了"Full"的阈值

### §十三.4 多线程 make_not_entrant_or_zombie CAS 双重检查失败路径

**并发场景**：两个线程同时对同一 nmethod 触发 deoptimization（线程 A 因为 trap，线程 B 因为类卸载）。

**CAS 双重检查的完整路径**（`nmethod.cpp:1205-1209`）：

```cpp
// 阶段 3: Patching_lock 临界区内
if (_state == state) {
    nmethod_needs_unregister = false;  // 另一个线程已完成
    // 释放 Patching_lock，退出
}
```

**之前发生了什么（线程 B 视角）**：
1. B 拿到 `nmethodLocker`（`_lock_count++`），建立 `NoSafepointVerifier` 保护栈
2. B 获取 `Patching_lock` 之前，A 已经获得了锁并完成了 NativeJump 补丁 + `_state = not_entrant` + `OrderAccess::storestore()`
3. B 获取锁后 `_state == not_entrant == state` → 快速返回

**B 需要清理吗？** 不需要——A 已经完成了 `verified_entry` 补丁（JMP → `handle_wrong_method_stub`），且 `storestore()` 屏障确保了栈扫描标记的可见性。B 只释放 `nmethodLocker`（`_lock_count--`）和 `NoSafepointVerifier` 就退出。

**如果 CAS 检查失败但 _state 更超前**（已 zombie 而目标 not_entrant）：`_state >= state` 的断言失败——nmethod 状态不可回退，not_entrant → zombie 但不可 zombie → not_entrant。这种情况触发 assert（debug 模式下 crash，product 模式记录 warning）。

---

## §十四 Diagnostics — jstack + /proc 三件套验证

### §十四.1 jstack 编译帧输出示例

`jstack <pid>` 的输出中，编译帧显示为：

```
"main" #1 prio=5 os_prio=0 tid=0x00007f1234001000 nid=0x1234 runnable [0x00007f123c000000]
   java.lang.Thread.State: RUNNABLE
        at java.util.HashMap.putVal(HashMap.java:635)            ← Interpreted frame
        at java.util.HashMap.put(HashMap.java:612)
        at com.example.MyApp.process(MyApp.java:42)
        at MyApp.main(MyApp.java:15)                             ← Compiled frame (nmethod)
```

**编译帧的关键特征**：
1. 没有 "(Compiled frame)" 标记——JVM 线程标签会显示 `JavaThread` 状态
2. `jstack` 通过 `JavaThread::print_stack_on()` → `frame::print_on()` → `CompiledFrame::print_value()` 解码 PC → nmethod → method 名称链
3. PC → nmethod 查找通过 `CodeCache::find_blob(pc)`（`codeBlob.hpp:515`）以二分搜索在 CodeHeap 的 header 链表中定位
4. nmethod → method name 通过 `method()->name_and_sig_as_C_string()` 获取

**手动验证 nmethod→PC→method 链路**：
```bash
# 1. 获取编译方法的 PC 范围
jcmd <pid> Compiler.codecache | grep <MethodName>
# 输出：nmethod <id> <method_name> ... <code_begin> <code_end> ...

# 2. 用 pstack 交叉验证
pstack <pid> | grep -B2 <hex_address>
# 如果 PC 落在 code_begin..code_end 之间 → nmethod 匹配
```

### §十四.2 /proc/self/maps 验证 CodeCache 虚拟地址段

```bash
cat /proc/<pid>/maps | grep -i codecache
# 预期输出（x86-64 non-segmented 模式）：
# 7f1234000000-7f1236000000 rwxp 00000000 00:00 0     [anon:codecache non-profiled]
# 7f1236000000-7f1238000000 rwxp 00000000 00:00 0     [anon:codecache profiled]
# 7f1238000000-7f123a400000 rwxp 00000000 00:00 0     [anon:codecache non-method]
```

**字段解读**（`man 5 proc` → `/proc/[pid]/maps`）：
- `rwxp` — Read + Write + eXecute + Private（CodeCache 页的 W^X 全开，因为运行时需要同时「写」补丁代码和「执行」）
- `00000000 00:00 0` — 匿名映射（非文件），offset/major:minor/inode 均为 0
- `[anon:codecache ...]` — HotSpot 通过 `prctl(PR_SET_VMA, PR_SET_VMA_ANON_NAME)` 设置（需要 Linux 5.17+）
- 地址范围：non-profiled 默认 120MB，profiled 默认 117MB，non-method 默认 3MB

**W^X 不安全性的验证**（见 §十三.1）：
```bash
# CodeCache 同时有 W X —— SELinux deny_execmem 正是针对此模式的限制
grep codecache /proc/<pid>/maps | grep rwxp
# 存在输出 → CodeCache 的 W + X 同时存在
```

### §十四.3 /proc/self/smaps 验证 RSS/PSS

```bash
cat /proc/<pid>/smaps | grep -A20 "codecache"
# 关键指标：
# Size:   125952 kB   — 虚拟地址空间大小（CodeCache 的 reserve 值）
# Rss:     48256 kB   — 实际驻留在物理内存中的页（已 mprotect commit 的页）
# Pss:     48256 kB   — 比例共享内存（通常 = RSS，因为 CodeCache 不与其他进程共享）
# Private_Dirty: 48256 kB — 私有脏页（补丁后的修改页，由 NativeJump 写入产生）
```

**解读要点**：
1. `Rss < Size` — 差分 = `MAP_NORESERVE` 的预留但未提交页（惰性 commit 策略）
2. `Private_Dirty > 0` — 表示已有补丁操作（`NativeJump::patch_verified_entry()` 将 rwxp 页中的代码字节修改为 JMP 指令——页面变为 dirty）
3. `Private_Clean = 0` 是正常的（没有从文件 mmap 的约束，所有页为匿名）
4. 比较 non-profiled/profiled/non-method 三个段的 RSS 比例可判断编译器的工作负载分布（C1 用 profiled，C2 用 non-profiled）

**诊断应用**：
- `Size >> Rss`（如 256MB reserved 但只有 30MB used）→ CodeCache 预分配偏大，可调 `-XX:ReservedCodeCacheSize`
- `Rss ≈ Size` → CodeCache 接近满载，需要关注 Sweeper 是否及时回收

---

## §十五 CodeBlobLayout 两种构造模式 — Simple Size vs CodeBuffer

`CodeBlobLayout`（`codeBlob.hpp:635-663`）是 CodeBlob 构造过程的辅助结构，定义 section 的偏移和大小。它提供两种构造模式：

### 模式 A：Simple Size 构造（`codeBlob.hpp:640-646`）

```cpp
CodeBlobLayout(
    address code_begin, address code_end,
    address data_begin, address data_end,
    bool       caller_must_gc_arguments
);
```

**用途**：RuntimeStub、BufferBlob、DeoptimizationBlob 等**不含编译器输出 structure** 的 CodeBlob 子类型。

**特点**：
1. 所有 section 大小通过传入的 `code_begin/code_end` 和 `data_begin/data_end` 指针直接计算——无 CodeBuffer 参与
2. `content_offset = code_begin - (address)this`（code 紧跟 header 之后，无 relocation）
3. 所有 frame 信息（`_frame_size`、`_frame_complete_offset` 等）在 Blob 构造函数中直接设置
4. 典型场景：`AdapterBlob`（i2c/c2i adapter）、`RuntimeStub`（SharedRuntime 生成的 stub）的内存布局只需要 header + code 两段

### 模式 B：CodeBuffer 构造（`codeBlob.hpp:648-656`）

```cpp
CodeBlobLayout(
    const CodeBuffer* cb,
    int               header_size,
    int               relocation_size,
    int               frame_complete_offset,
    int               frame_size,
    bool              caller_must_gc_arguments
);
```

**用途**：nmethod、AOTCompiledMethod 等**编译器通过 CodeBuffer 输出**的 CodeBlob 子类型。

**特点**：
1. 所有 section 大小从 CodeBuffer 的 sections（consts, insts, stubs）计算——而非手动指定
2. `relocation_size` 由 CodeBuffer 生成阶段（`C2_Compiler::compile_method()`）写入
3. content 包含 consts + insts + stubs 三段，需要 CodeBlobLayout 计算各自的 offset
4. `total_offset_of()` 方法提取 CodeBuffer 中每个 section 的偏移

### 为什么需要两种模式？

| 方面 | Simple Size | CodeBuffer |
|------|-----------|------------|
| 使用者 | RuntimeStub, BufferBlob, AdapterBlob | nmethod, AOTCompiledMethod |
| section 数量 | 2（header + code） | 3+（header + relocation + consts + insts + stubs + metadata） |
| 编译器输出 | 无（运行时直接生成机器码） | 有（C1/C2 生成的 CodeBuffer） |
| relocation 信息 | 无需重定位（代码为绝对地址） | 需要 relocation section（编译器生成相对偏移） |
| debug info | 无 scope 信息 | DebugInformationRecorder 生成的 scopes_data + PcDesc |

**典型的大小对比**（x86-64）：
- `AdapterBlob`（i2c）：~128B（64B header + 48B code + padding）
- `DeoptimizationBlob`：~4KB（含完整反优化 handler 代码）
- `nmethod`（C2 compiled `HashMap.putVal`）：~8-32KB（所有 section 之和）
- `BufferBlob`（CI Compile 临时存储）：~2KB

---

## §十六 nmethodLocker 深度分析 — Atomic 实现 + JVMTI 交互 + flush 协作

### §十六.1 lock_nmethod() / unlock_nmethod() 的 Atomic 实现

`nmethodLocker`（`nmethod.hpp:630-669`）是基于 RAII 的轻量级引用计数锁，定义在 `nmethod.hpp` 内部：

```cpp
class nmethodLocker : public StackObj {
    nmethod* _nm;
    bool     _needs_unlock;
public:
    static void lock_nmethod(nmethod* nm);    // + _lock_count
    static void unlock_nmethod(nmethod* nm);  // - _lock_count
    static bool is_locked(nmethod* nm);       // _lock_count > 0 检查
};
```

**核心实现**（`nmethod.cpp:2044-2068`）：

```cpp
void nmethodLocker::lock_nmethod(nmethod* nm) {
    if (nm == NULL) return;
    Atomic::inc(&nm->_lock_count);    // 原子递增——无锁操作
    assert(nm->_lock_count > 0, "underflow");
}

void nmethodLocker::unlock_nmethod(nmethod* nm) {
    if (nm == NULL) return;
    Atomic::dec(&nm->_lock_count);    // 原子递减
    assert(nm->_lock_count >= 0, "underflow");
}

bool nmethodLocker::is_locked(nmethod* nm) {
    return nm != NULL && Atomic::load_acquire(&nm->_lock_count) > 0;
}
```

**为什么用 Atomic 而非 Mutex？**

1. **Reader-writer 不对称**：成千上万个读操作（GC 扫描、stack walking）需要对同一个 nmethod 做短暂的 pin 操作——使用 Mutex 会串行化所有 GC 线程
2. **lock_nmethod 在 safepoint 内可被调用**：`Atomic::inc()` 不涉及 syscall 或 Mutex，即使在本应禁止 safepoint 的边界也能安全调用
3. **`_lock_count` 是 `volatile jint`**（`nmethod.hpp:146`）——任何线程的写入对所有 CPU 立即可见（x86-TSO 保证），读端无需锁即可判断 "是否被 JVMTI 使用"

### §十六.2 与 JVMTI CompiledMethodUnload 事件队列的交互

**事件触发流程**（`nmethod.cpp:1278-1301`）：

1. **zombie 后处理**（在 Patching_lock 释放后，CodeCache_lock 保护下）：
   ```cpp
   if (nmethod_needs_unregister) {
       Universe::heap()->unregister_nmethod(this);
   }
   flush_dependencies(true);
   post_compiled_method_unload();  // ← JVMTI 事件入口
   ```

2. **post_compiled_method_unload() → JvmtiExport**：
   - 将 nmethod 信息（method name, compile_id, code_begin, code_end）推入 JVMTI 事件队列
   - **关键时序**：此时 `_state == zombie` 且 `flush_dependencies(true)` 已完成，但 CodeCache::free() 尚未调用

3. **JVMTI agent 处理队列**（异步）：
   - Agent 收到 `CompiledMethodUnload` 事件
   - Agent 可能调用 `GetCompiledMethodLoad/Unload` 回调
   - **Agent 需要在此窗口内读取 nmethod 的代码和元数据**——因此 nmethod 不得被 flush

4. **nmethodLocker 的保活作用**：
   ```cpp
   // Agent 检测到事件后：
   nmethodLocker nml(nm);  // _lock_count++
   // 读取 nm->code_begin(), nm->method(), nm->scopes_data_begin()...
   // 自动析构时：_lock_count--
   ```
   `can_convert_to_zombie()` 中的 `!is_locked_by_vm()` 检查 (`nmethod.cpp:1023`) 确保 `_lock_count > 0` 时不会转换 zombie。

### §十六.3 与 flush() 的协作协议

**Sweeper 调用 flush 时的检查链**：

1. `can_convert_to_zombie()`（`nmethod.cpp:1016-1024`）→ `!is_locked_by_vm()` 检查 `_lock_count == 0`
2. `make_zombie()` → `make_not_entrant_or_zombie(zombie)` — 安全地设置状态
3. `flush()`（`nmethod.cpp:1315`）→ **不检查 `_lock_count`**，因为：状态已 zombie + 依赖已清理 + `_lock_count` 只阻止 not_entrant→zombie 转换，一旦进入 zombie 状态，锁的解除意味着 Agent 已读完

**保活协议**：
```
Agent 线程:              |  Sweeper 线程:
=========================|============================
收到 unload 事件          |
lock_nmethod(nm) <-- +1  |
读取 nm 信息              |
                        |  can_convert_to_zombie() → false (_lock_count=1)
                        |  (无法 make_zombie，等待)
                        |
unlock_nmethod(nm) <--0  |
                        |  can_convert_to_zombie() → true
                        |  make_zombie() → flush() → CodeCache::free()
```

---

## §十七 compiledMethod.inline.hpp — is_deopt_pc() + get_deopt_original_pc()

`compiledMethod.inline.hpp`（84 行）是 CompiledMethod 类的**内联方法实现文件**，提供两个关键 PC 查询函数和 ExceptionCache 辅助。

### 为什么 inline 而非 .cpp？

OpenJDK 将这些函数放在 `.inline.hpp` 中（而非 `compiledMethod.cpp` 的主体）出于以下原因：

1. **调用频率极高**：`is_deopt_pc()` 在每次栈展开（stack walking）时被调用——遍历 Java 栈帧时，每个编译帧的 PC 都要检查是否在 deopt handler 内。单次 GC 可能展开数千个栈帧。
2. **函数体极短**（1-5 条指令）：
   ```cpp
   inline bool is_deopt_pc(address pc) {
       return pc == deopt_handler_begin() || is_deopt_mh_entry(pc);
   }
   ```
   仅两个指针比较——inline 后只有 2 条 cmp + 1 条 je 指令（~10 字节），call overhead (~20 字节) 反而更大。加上 `is_deopt_mh_entry()` 的扩展检查也仅增加一次 `code_begin()` 比较。
3. **跨编译单元共享**：包含此 inline 文件的代码（`nmethod.cpp`、`frame.cpp`、`stackValue.cpp`）都能得到零开销调用，不需要链接时优化（LTO）。

### is_deopt_pc() — PC 是否在 deoptimization handler 内

**定义**（`compiledMethod.inline.hpp:62-69`）：

```cpp
inline bool CompiledMethod::is_deopt_pc(address pc) {
    return pc == deopt_handler_begin() || is_deopt_mh_entry(pc);
}
```

**deopt_handler_begin()** 返回 nmethod 的 deoptimization 入口点的代码起始地址。当 uncommon trap 触发时，执行流跳转到此地址，执行 deoptimization handler（保存所有寄存器、构建 deopt 上下文、调用 `Deoptimization::fetch_unroll_info()`）。

**is_deopt_mh_entry()**（`nmethod.cpp:98-105`）：MethodHandle 的 intrinsic 方法有一个独立的 deopt entry（不同于常规的 `deopt_handler_begin()`），地址在 `verified_entry_point + NativeMovConstReg::instruction_size`。这种 "PC == deopt entry" 的检查在 `StackValueCollection::lock()` 中用于判断是否需要持有 `Patching_lock`。

**使用场景**：
- `StackWalk::fill_live_stack_frames()` → 跳过 deopt handler 帧（它们不应在 Java 层的栈中有可见帧）
- `CodeCache::find_blob()` → 确保 deopt handler 地址匹配到正确的 nmethod

### get_deopt_original_pc() — 反优化前的原始 PC

**定义**（`compiledMethod.inline.hpp:72-84`）：

```cpp
inline address CompiledMethod::get_deopt_original_pc(const frame* fr) {
    // 在 deoptimization 发生后，返回触发 uncommon trap 的原始指令地址
    // fr->pc() 指向 deopt_handler_begin（deopt handler 入口）
    // 原始 PC 被保存在 deopt 栈帧中（fr->unextended_sp 的偏移处）
}
```

**使用场景**：
1. **GDB 调试**：在 deopt 帧中，用户执行 `(gdb) info frame` 看到 deopt handler PC，但 `get_deopt_original_pc()` 返回的是触发 trap 的编译代码 PC
2. **JFR 采样**：JFR 的 `Method Profiling` 采样器在遇到 deopt 帧时，通过此函数还原原始的编译代码位置，避免所有 deopt 帧都报告为同一 PC
3. **jstack 准确输出**：`CompiledFrame::print_value()` 调用此函数，确保 `at MyApp.compute(MyApp.java:N)` 的 BCI 转为正确的行号，而非 "at deopt handler (unknown)"

---

## §十八 与同级 prompt 的连续性

本文档是 Phase 28 (code-extra) 的第一篇（doc-00），定义了 code/ 子系统的核心物体模型和生命周期基线。后续文档依赖如下内容：

- **doc-01 (Debug Info & Metadata)** 依赖 §五 PcDesc 查找算法和 §三.3 metadata section 布局——需要基于本文的 `pc_desc_at()` 展开 `scope_desc_at()` 和 DebugInfoReadStream 解码
- **doc-02 (Dependencies, IC & Exceptions)** 依赖 §七 依赖注册/清理和 §八 ExceptionCache——需要基于本文的 `flush_dependencies()` 和 `handler_for_exception_and_pc()` 展开 IC patching 和依赖验证

本文档对 nmethod 的基本承诺：
1. 所有 nmethod section 通过 int offset 字段定位（非 C++ 指针）— `nmethod.hpp:100-109`
2. 状态机严格单向：not_installed(-1) → in_use(0) → not_entrant(2) → zombie(3) → unloaded(4) — `compiledMethod.hpp:188-197`
3. 内存布局的三段不变式：header → relocation → code → metadata — `nmethod.cpp:693-754`

### 核心设计原则总结

nmethod 的所有设计决策都围绕三个约束展开：

**约束 1 — CodeCache 受限空间**（默认 240MB）：每个 nmethod 的存储开销必须极致压缩。因此：
- offset 字段用 `int` 而非 `address*`（每个 offset 4B vs 指针 8B，8 个字段节省 32B/nmethod）
- 所有 section 内联在连续内存中（无独立 malloc header 开销）
- `total_size()` 不重复计算 header_size（CodeCache 已通过 `_size` 字段跟踪完整分配）

**约束 2 — 并发安全无全局锁**：数千个 nmethod 同时存在，状态转换和 GC 扫描不能串行化。因此：
- `_state` 为 `volatile signed char` —— `is_in_use()` 无锁读取
- `make_not_entrant_or_zombie()` 用 per-CodeCache `Patching_lock` 而非全局锁
- `_lock_count` 用 `Atomic::inc/dec` 而非 Mutex（GC 线程在 safepoint 内可安全调用）
- `PcDescCache(4)` 的 volatile 访问接受 cache line bouncing 而非增加锁

**约束 3 — JVMTI agent 异步交互**：Agent 在 `CompiledMethodUnload` 事件中需要读取已标记 zombie 的 nmethod。因此：
- `_lock_count` 阻止 `can_convert_to_zombie()` 在 Agent 读取期间转换状态
- `post_compiled_method_unload()` 在 zombie 后、`CodeCache::free()` 前调用——保留窗口
- `nmethodLocker` 的 RAII 模式确保异常安全（析构函数自动 `unlock_nmethod()`）

