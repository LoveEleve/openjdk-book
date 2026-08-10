# PROMPT: 请撰写 04-Redefine-Classes.md（重写版 v2）

## §〇 Production Scenario（必须真实出现在文档 §〇 中）

**症状**：使用 `Instrumentation.redefineClasses()` 或 `retransformClasses()` 后，类的行为与预期不符——新增方法不可见、修改后的方法体未生效、或出现 `UnsupportedOperationException: class redefinition failed: attempted to change the schema`。

```java
// Agent 代码：修改 Foo 类的 bar() 方法
byte[] newBytes = ...; // ASM 修改后的字节码
ClassDefinition def = new ClassDefinition(Foo.class, newBytes);
instrumentation.redefineClasses(def);  // 看起来成功了
// 但调用 foo.bar() 时仍然是旧行为！
```

**根因分析**：类重定义经过 VM_Operation 三阶段 + safepoint 全局暂停 + 常量池合并 + vtable/itable 全局调整 + JIT 代码刷除。任一阶段失败都会导致"看起来成功但实际不生效"。

1. **JVMTI 入口** (`jvmtiEnv.cpp:457`): `JvmtiEnv::RedefineClasses()` 创建 `VM_RedefineClasses`，设置 `_class_load_kind = jvmti_class_load_kind_redefine`
2. **doit_prologue** (`jvmtiRedefineClasses.cpp:115`): JavaThread 中执行——锁类、加载新字节码、schema 兼容性检查、计算方法增删匹配表
3. **doit** (`jvmtiRedefineClasses.cpp:183`): VMThread safepoint 中执行——合并常量池（merge_constant_pools :1362）、重写字节码 CP 引用（rewrite_cp_refs 系列 :1707-3147，共 18 个函数）、安装新 CP（set_new_constant_pool :3235）、全局 vtable/itable 调整（AdjustCpoolCacheAndVtable :3431）、刷除 JIT 编译代码（flush_dependent_code :3863）
4. **doit_epilogue** (`jvmtiRedefineClasses.cpp:241`): JavaThread 中执行——更新 jmethodID 映射（update_jmethod_ids :3555）、清理临时内存

最常见的失败原因：
- **Schema 变更**：新增/删除字段、修改方法签名 → `class redefinition failed: attempted to change the schema`
- **Vtable 未更新**：子类 vtable 仍指向旧方法入口 → 虚方法调用走旧代码
- **JIT 代码未刷**：C1/C2 编译代码仍使用旧入口 → `flush_dependent_code` 未正确执行
- **常量池溢出**：merge_cp 超过 65535 条目限制（u2 索引硬上限）
- **能力未设置**：`Can-Redefine-Classes`/`Can-Retransform-Classes` 未在 manifest 中声明

**三步诊断**（直接写进 §〇）：

```bash
# 1. 确认 redefine 是否被 JVMTI 接受
java -Xlog:redefine+class*=trace -javaagent:agent.jar -version 2>&1 | grep "redefine"
# 期望: [redefine] redefine_single_class: class=com/example/Foo, new_class_version=52

# 2. 检查 safepoint 耗时（redefine 需要全局暂停）
jcmd <pid> VM.safepoint  # 查看 safepoint 统计
# 如果 safepoint 时间异常长 → redefine 的 merge_cp 或 vtable 调整耗时

# 3. GDB 断点验证 redefine 全链路
gdb -ex "break jvmtiRedefineClasses.cpp:115" \
    -ex "break jvmtiRedefineClasses.cpp:183" \
    -ex "break jvmtiRedefineClasses.cpp:1362" \
    -ex "break jvmtiRedefineClasses.cpp:3431" \
    -ex "run" \
    -ex "print _class_load_kind" \
    -ex "print _the_class->external_name()" \
    --args java -javaagent:agent.jar com.example.Main
```

**反事实**：如果 redefine 不通过 VM Operation（不需要 safepoint）而是直接修改 Klass → 其他线程可能正在执行旧方法体的中间 → 修改 vtable 时产生竞态 → 线程 A 刚读取 vtable 条目，线程 B 同时修改它 → 线程 A 跳转到垃圾地址 → SIGSEGV。Safepoint 保证了所有 Java 线程都停在安全点，Klass 元数据修改是原子的——要么全可见，要么全不可见。

---

## §一 Task + Narrative + De-glamorization + Beginner Callouts

### Task

Reading this prompt, you will produce a document that traces the COMPLETE class redefinition mechanism from `Instrumentation.redefineClasses()` through VM Operation safepoint to vtable/itable adjustment, JIT code flushing, and ClassFileReconstituter reconstruction. This is NOT a tutorial on "how to use redefineClasses" — it's ENGINEERING documentation on HOW the JVM safely replaces a class definition while the VM is running, covering ~8,000 lines of source across 4 core files.

Reader completed **01-Agent-Loading**（JPLISAgent, capability 设置），**02-ClassFileLoadHook**（CFLH 管道, JvmtiCachedClassFileData 缓存），**03-Attach-API**（agentmain 触发 redefine）。This doc: **how redefineClasses transforms from a Java API call to a VM-wide safepoint operation that atomically swaps class metadata** — from `JvmtiEnv::RedefineClasses` at jvmtiEnv.cpp:457 to `VM_RedefineClasses::doit_epilogue` at jvmtiRedefineClasses.cpp:241, plus the retransform reuse path (CFLH pipeline) and ClassFileReconstituter (old class file reconstruction).

**WARNING**: This document must be ≥2,000 lines. The existing v1 is 284 lines — a 7x expansion is REQUIRED. Each of the 10 question groups in §四 must produce ≥80 lines of answer. The rewrite_cp_refs family alone (18 functions) needs ≥150 lines. redefine_single_class (432 lines of source) needs ≥120 lines.

### Interview Story Format Answer（必须出现在 §一 末尾）

"When you call `Instrumentation.redefineClasses(classDefs)`, the JVM doesn't immediately modify the class. Instead, `JvmtiEnv::RedefineClasses` at jvmtiEnv.cpp:457 creates a `VM_RedefineClasses` VM Operation and submits it to `VMThread::execute()`. The VM Operation has a three-phase lifecycle: `doit_prologue` runs on the calling JavaThread before the safepoint—it locks each class via `lock_classes()` at :85, loads the new class bytes via `ClassFileParser` in `load_new_class_versions()` at :1115, validates schema compatibility in `compare_and_normalize_class_versions()` at :775, and computes method add/delete/matching tables via `compute_added_deleted_matching_methods()` at :3887. Then the VMThread brings all Java threads to a safepoint and executes `doit`—the critical section where `merge_constant_pools` at :1362 creates a merged constant pool that preserves old CP indices while adding new entries, `rewrite_cp_refs_in_methods` at :1815 (and 17 sibling functions for annotations, StackMapTable, bootstrap methods, etc.) patches all bytecode CP references to use merge_cp indices, and `set_new_constant_pool` at :3235 installs the merged CP. After the CP swap, `AdjustCpoolCacheAndVtable` at :3431 is a KlassClosure that visits every loaded class, calling `k->vtable().adjust_method_entries()` and `k->itable().adjust_method_entries()` to update method entries that point to the old class. Then `flush_dependent_code` at :3863 sweeps the CodeCache to deoptimize and discard any JIT-compiled code that depends on the old class—calling `nmethod::make_not_entrant()` to set entry points to deoptimization stubs (not immediate deletion, since nmethods may still be on thread stacks). Finally `update_jmethod_ids` at :3555 maps old jmethodIDs to new ones for JNI stability. `doit_epilogue` returns to the JavaThread and cleans up. Retransform reuses VM_RedefineClasses with `_class_load_kind = jvmti_class_load_kind_retransform`, triggering the CFLH pipeline in `load_new_class_versions`—before ClassFileParser, the original bytes are cached via `InstanceKlass::set_cached_class_file()` and `JvmtiExport::post_class_file_load_hook()` invokes agent transformers. `JvmtiClassFileReconstituter` (jvmtiClassFileReconstituter.cpp, ~960 lines) reconstructs the original class file from Klass metadata—used when CFLH needs the 'original' bytes but only the transformed version exists. The crucial insight: this is not one mechanism but four interacting subsystems: (1) VM_Operation safepoint orchestration, (2) constant pool merging with index preservation, (3) global vtable/itable consistency maintenance, and (4) JIT code deoptimization cascade—all coordinated to make class redefinition appear atomic to all threads."

### Beginner Callout Boxes（文档中必须出现的 10 个 callout 框，必须全部在 §一 内部）

1. **VM_Operation 三阶段模型**: VM_Operation 有 `doit_prologue()` → `doit()` → `doit_epilogue()` 三个阶段。`doit_prologue` 在调用者 JavaThread 中执行（可访问 Java heap、可抛异常），`doit` 在 VMThread 中全局 safepoint 执行（无并发、不可抛异常），`doit_epilogue` 回到 JavaThread 清理。RedefineClasses 利用这个模型：prologue 做 I/O 密集型工作（加载类文件、比较版本），doit 做需要全局一致性的工作（修改 Klass 元数据、调整 vtable）。Source: `vmOperations.hpp`, `jvmtiRedefineClasses.cpp:68-241`.

2. **Schema 兼容性检查**: redefine 不允许"schema 变更"——不能新增/删除字段、不能修改方法签名、不能修改继承关系。检查逻辑在 `compare_and_normalize_class_versions` (`jvmtiRedefineClasses.cpp:775`) 中——逐个对比 old_class 和 new_class 的字段表和方法表。这确保了旧对象的内存布局不变——否则已存在的实例 oop 大小会不一致。retransform 没有此限制（因为字节码来自 CFLH，只修改方法体）。

3. **Constant Pool 合并算法**: `merge_constant_pools` (`jvmtiRedefineClasses.cpp:1362`) 是 redefine 最复杂的部分——将 old_cp 和 scratch_cp 合并为 merge_cp。关键约束：(1) old_cp 的条目索引必须保持不变（现有代码引用这些索引），(2) scratch_cp 中的新条目追加到末尾，(3) 相同内容的条目共享（去重）。合并后调用 18 个 `rewrite_cp_refs` 函数将新方法体中的 CP 引用从 scratch_cp 索引重写到 merge_cp 索引。Source: `jvmtiRedefineClasses.hpp:300-335`（merge_cp 算法注释）。

4. **Vtable/Itable 全局调整**: redefine 后，子类的 vtable 和 itable 中可能包含指向旧方法版本的入口。`AdjustCpoolCacheAndVtable::do_klass` (`jvmtiRedefineClasses.cpp:3431`) 是 KlassClosure，遍历**所有已加载类**，调用 `k->vtable().adjust_method_entries()` 将旧方法指针替换为新方法指针。这是 O(n_classes × vtable_size) 的操作——redefine 一个 Object 的子类需要检查 JVM 中所有类。

5. **JIT 代码刷除**: redefine 后，所有依赖旧类的 JIT 编译代码必须失效。`flush_dependent_code` (`jvmtiRedefineClasses.cpp:3863`) 调用 `nmethod::make_not_entrant`——标记所有旧版本的编译方法为 "not entrant"（不可进入），下次调用时触发 deoptimization 回到解释器，解释器使用新字节码。为什么不是立即删除？因为 nmethod 可能正在被其他线程执行（栈上有返回地址）。

6. **rewrite_cp_refs 函数族**（新增必须）: redefine 最易遗漏的部分——不是"一个函数重写 CP 引用"，而是 **18 个独立函数**覆盖 7 种类别的字节码属性：(a) 方法体 CP 引用 (rewrite_cp_refs_in_methods :1815)、(b) 字段/方法注解 (rewrite_cp_refs_in_fields :1968 / methods :2017)、(c) 类注解 (rewrite_cp_refs_in_class_annotations :2075)、(d) StackMapTable (rewrite_cp_refs_in_stackmap_table :2180)、(e) 类型注解 (rewrite_cp_refs_in_type_annotations 族, :2367-2784)、(f) BootstrapMethods (rewrite_cp_refs_in_bootstrap_methods :2793)、(g) 方法参数/异常表等。每个函数都需要独立的 ConstantPool::cp_reference_at() 间接性和 scratch_cp→merge_cp index_map 参数。

7. **redefine_single_class 核心函数**（新增必须）: 432 行的 `redefine_single_class` (:3970) 是 redefine 的"中央引擎"——被 `doit()` 调用，对单个类执行完整重定义流程。它内部的 12 个步骤：lock_class → load_new_class_versions → compare_versions → merge_cp_and_rewrite → adjust_array_vtable → set_new_constant_pool → increment_class_counter → setup_class_for_verification → verify_bytecodes → swap_annotations → update_jmethod_ids → check_class。理解这个函数就理解了 redefine 的全貌。

8. **jmethodID 稳定性**: JNI 规范要求 jmethodID 在类重定义后保持稳定。`update_jmethod_ids` (`jvmtiRedefineClasses.cpp:3555`) 将旧方法的 jmethodID 映射到新方法的 jmethodID——通过匹配方法名+签名。如果新版本删除了旧方法 → jmethodID 指向一个"已废弃"标记，后续调用返回 NoSuchMethodError。Source: `jvmtiRedefineClasses.hpp:35-47`。

9. **JvmtiClassFileReconstituter — 旧类文件重建器**（新增必须）: 960 行的独立类，用于在 retransform 流程中重建"原始"类文件。当 CFLH 管道的 `post_class_file_load_hook` 需要旧类文件的字节码作为输入时——但只有 Klass 元数据仍然可用——`JvmtiClassFileReconstituter` 从 InstanceKlass 的 ConstantPool、Fields、Methods 反向重建完整的 .class 文件格式。这是 redefine→retransform→CFLH 环路的闭合环节。Source: `jvmtiClassFileReconstituter.cpp`。

10. **JvmtiManageCapabilities 能力门控**（新增必须）: `JvmtiManageCapabilities::init_onload_capabilities()` 在 Agent_OnLoad 时初始化 JVMTI 能力集合。`Can-Redefine-Classes` 和 `Can-Retransform-Classes` 是 `jvmtiCapabilities` 结构体中的两个位标志——必须在 `AddCapabilities()` 调用中设置。JPLISAgent 的 `retransformableEnvironment` 在 `initializeJPLISAgent` 时根据 manifest 的 `Can-Retransform-Classes` 属性设置 capabilities。Source: `jvmtiManageCapabilities.cpp`。

---

## §二 Standard Environment

OpenJDK 11 slowdebug, 64-bit Linux。

Source roots:
- `src/hotspot/share/prims/jvmtiRedefineClasses.cpp` (4,382 行, :1-4382) — VM_RedefineClasses 全部实现
- `src/hotspot/share/prims/jvmtiRedefineClasses.hpp` (~540 行) — VM_RedefineClasses 声明 (:338), AdjustCpoolCacheAndVtable (:516), merge_cp 算法注释 (:300-335)
- `src/hotspot/share/prims/jvmtiClassFileReconstituter.cpp` (960 行) — 旧类文件重建器
- `src/hotspot/share/prims/jvmtiClassFileReconstituter.hpp` (~100 行) — 重建器声明
- `src/hotspot/share/prims/jvmtiManageCapabilities.cpp` (457 行) — 能力管理
- `src/hotspot/share/prims/jvmtiManageCapabilities.hpp` (~80 行) — 能力管理声明
- `src/hotspot/share/prims/jvmtiEnv.cpp` — RedefineClasses (:457), RetransformClasses (:393), IsModifiableClass (:384)
- `src/hotspot/share/prims/jvmtiEnvBase.cpp` — VM_RedefineClasses 相关 (~300 行)
- `src/hotspot/share/prims/jvmtiImpl.cpp` — DeferredEvent (:200 行相关)
- `src/java.instrument/share/native/libinstrument/JPLISAgent.c` — retransformableEnvironment (~200 行)
- `src/hotspot/share/oops/instanceKlass.hpp` — set_cached_class_file (:852), get_cached_class_file (:855)
- `src/hotspot/share/oops/klassVtable.hpp` — vtable/itable adjust_method_entries

Build: `make jdk`

Key binary: `build/linux-x86_64-normal-server-slowdebug/jdk/lib/server/libjvm.so` — 所有 redefine 代码编译进 libjvm.so

System calls table（文档 §二 必须有此表，标注 man 2/3 来源）:

| Syscall | man | 使用场景 | 调用位置 | 关键 errno |
|---------|-----|---------|---------|-----------|
| mmap(2) | man 2 mmap | 类文件内存映射(ClassFileParser)、Metaspace 分配 | os::malloc → mmap | ENOMEM, ENFILE |
| munmap(2) | man 2 munmap | 临时内存释放 | doit_epilogue 清理 | EINVAL |
| futex(2) | man 2 futex | VM_Operation 提交/完成同步(safepoint) | VMThread::execute → wait | EAGAIN, EINTR |
| open/read(2) | man 2 open, man 2 read | 类文件 I/O | ClassFileParser 读 class 文件 | ENOENT, EACCES |
| memcpy(3) | man 3 memcpy | scratch_cp → merge_cp 数据拷贝 | merge_constant_pools | (no errno) |
| pthread_mutex_lock(3) | man 3 pthread_mutex_lock | lock_classes/unlock_classes | jvmtiRedefineClasses.cpp:85-105 | EDEADLK |

/proc 接口（文档 §二 必须列出）:

| /proc 路径 | 与 redefine 的关系 |
|-----------|------------------|
| `/proc/self/maps` | Metaspace 映射验证（redefine 后新/metadata 的位置） |
| `/proc/sys/vm/max_map_count` | mmap 映射数量上限（大量 redefine 可能耗尽） |
| `/proc/<pid>/status` | VmSize 增长（redefine 产生临时内存） |

---

## §三 Source Files Table

| # | File | Full Path | Lines | Core Functions | Role |
|---|------|-----------|:--:|-------|------|
| 1 | **jvmtiRedefineClasses.cpp** | `src/hotspot/share/prims/jvmtiRedefineClasses.cpp` | 4,382 | doit_prologue(:115), doit(:183), doit_epilogue(:241), redefine_single_class(:3970), merge_constant_pools(:1362), rewrite_cp_refs 族(:1707-3147), set_new_constant_pool(:3235), AdjustCpoolCacheAndVtable(:3431), flush_dependent_code(:3863), load_new_class_versions(:1115), compare_and_normalize_class_versions(:775), lock_classes(:85), unlock_classes(:105), map_index(:1316), map_operand_index(:1337), merge_cp_and_rewrite(:1567), update_jmethod_ids(:3555), check_methods_and_mark_as_obsolete(:3578), compute_added_deleted_matching_methods(:3887), swap_annotations(:3949), transfer_old_native_function_registrations(:3842), increment_class_counter(:4235), CheckClass::do_klass(:4257) | 🔥🔥🔥 核心实现 |
| 2 | **jvmtiRedefineClasses.hpp** | `src/hotspot/share/prims/jvmtiRedefineClasses.hpp` | ~540 | VM_RedefineClasses(:338), AdjustCpoolCacheAndVtable(:516), MethodDataCleaner(:524), CheckClass(:572), merge_cp 注释(:300-335) | 类声明+算法注释 |
| 3 | **jvmtiClassFileReconstituter.cpp** | `src/hotspot/share/prims/jvmtiClassFileReconstituter.cpp` | 960 | write_class_file_format(), reconstruct_constant_pool(), reconstruct_fields(), reconstruct_methods() | 🔥 旧类文件重建 |
| 4 | **jvmtiClassFileReconstituter.hpp** | `src/hotspot/share/prims/jvmtiClassFileReconstituter.hpp` | ~100 | JvmtiClassFileReconstituter 声明 | 重建器声明 |
| 5 | **jvmtiManageCapabilities.cpp** | `src/hotspot/share/prims/jvmtiManageCapabilities.cpp` | 457 | init_onload_capabilities(), init_always_capabilities(), get_potential_capabilities() | 🔥 能力管理 |
| 6 | **jvmtiManageCapabilities.hpp** | `src/hotspot/share/prims/jvmtiManageCapabilities.hpp` | ~80 | jvmtiCapabilities 结构体, can_* bit flags | 能力位定义 |
| 7 | **jvmtiEnv.cpp** | `src/hotspot/share/prims/jvmtiEnv.cpp` | ~4,600 | RedefineClasses(:457), RetransformClasses(:393), IsModifiableClass(:384) | JVMTI 入口 |
| 8 | **jvmtiEnvBase.cpp** | `src/hotspot/share/prims/jvmtiEnvBase.cpp` | ~1,593 | VM_RedefineClasses 相关支持 | VM_Operation 基础设施 |
| 9 | **jvmtiImpl.cpp** | `src/hotspot/share/prims/jvmtiImpl.cpp` | ~1,084 | DeferredEvent 队列, install_code_blob_events | 延迟事件机制 |
| 10 | **instanceKlass.hpp** | `src/hotspot/share/oops/instanceKlass.hpp` | ~1,100 | set_cached_class_file(:852), get_cached_class_file(:855), set_is_being_redefined(:862) | Klass 状态接口 |
| 11 | **klassVtable.hpp** | `src/hotspot/share/oops/klassVtable.hpp` | ~400 | adjust_method_entries(), update_klass_in_method_entries() | Vtable/itable 调整 |
| 12 | **JPLISAgent.c** | `src/java.instrument/share/native/libinstrument/JPLISAgent.c` | ~1,604 | retransformableEnvironment 相关(~200行) | Capability 初始化 |

---

## §四 Deep Dive Question Groups（≥10 组，每组 ≥2 问 + 1 counterfactual）

### 4.1 ★★★ VM_RedefineClasses 三阶段生命周期

```
问题：
  ① doit_prologue (jvmtiRedefineClasses.cpp:115) 做了哪些事情？为什么必须在 JavaThread 中执行？
      答案方向: prologue 执行：锁定类（InstanceKlass::set_is_being_redefined）→ 
      load_new_class_versions（ClassFileParser 解析新字节码）→ 
      compare_and_normalize_class_versions（schema 兼容性检查）→ 
      compute_added_deleted_matching_methods（计算方法增删匹配表）。
      必须在 JavaThread 中：ClassFileParser 需要访问 SystemDictionary、
      需要创建 Handle（依赖 HandleMark）、可能抛 ClassFormatError。
      验证 prologue 中哪些操作会触发 safepoint check（HandleMark::push 会有 safepoint check）。
      
      追问: 如果 doit_prologue 发现 schema 不兼容怎么办？
      → 抛 JVMTI_ERROR_UNSUPPORTED_REDEFINITION_SCHEMA_CHANGED
      → VM_RedefineClasses 被 VMThread 取消 → doit 不执行 → doit_epilogue 清理锁

  ② Counterfactual: 如果所有工作都在 doit 中（VMThread safepoint）执行？
      答案方向: ClassFileParser 在 safepoint 中执行 → 不能访问 Java heap
      → 不能分配 Handle → 不能查找系统类 → 不能解析字节码中的类引用
      → 不能抛 Java 异常。safepoint 中只能做纯 C++ 内存操作——这是为什么 prologue 和 doit 必须分离。
```

### 4.2 ★★★ merge_constant_pools — CP 合并算法

```
问题：
  ① merge_constant_pools (jvmtiRedefineClasses.cpp:1362-1544) 的 4 Pass 合并策略是什么？
      答案方向: 4 Pass + 6 helper 完整协作：
        Pass 0 (:1385-1430): 拷贝 old_cp → merge_cp。Class 反转为 UnresolvedClass(:1400)。Double/Long 占 2 槽(:1409)。
        Pass 1a (:1438-1496): 公共索引范围比较 scratch_cp[i] vs merge_cp[i]。完全匹配→跳过；unresolved_class_mismatch(:1088)→跳过；find_matching_entry→map_index；未找到→append_entry。
        Pass 1b (:1503-1537): scratch_cp 超出 old_cp 部分，同样匹配/追加逻辑。
        Finalize (:1541): finalize_operands_merge(:661) 收缩 operands 数组。
      
      helper 函数体系:
        append_entry(:295-557) — 按 tag 分派: Class→find_or_append_indirect_entry, Double/Long→2槽, Utf8/String→直接拷贝, NameAndType→双重间接, Fieldref/Methodref→三重间接, InvokeDynamic→operand
        find_or_append_indirect_entry(:560-586) — 先 compare、找到则 map_index、否则 append_entry
        append_operand(:592-632) — BootstrapMethods operand: [bsm_ref][argc][arg1]...
        find_or_append_operand(:635-658) — 先 compare_operand_to、找到则 map_operand_index、否则 append_operand
        finalize_operands_merge(:661-683) — shrink_operands + 清理 index_map
        map_index(:1316) / map_operand_index(:1337) — 在 _index_map_p 中记录 scratch→merge 映射
      算法复杂度 O(n_scratch × n_old)
      
      追问: 为什么需要去重？
      → 不去重 → old_cp 和 scratch_cp 中相同字符串/方法引用出现两次
      → 浪费 CP 空间 → 可能超出 65535 条目限制（u2 硬上限）
      → 对 BootstrapMethods 等大型 CP 风险更高

  ② Counterfactual: 如果不合并 CP 而是直接替换整个常量池？
      答案方向: old_cp 索引被所有已编译代码、jmethodID、ConstantPoolCache 引用。
      直接替换 → 所有旧索引失效 → jmethodID 悬空 → JNI 调用崩溃。
      CP 合并保证旧索引保持有效，这是向后兼容的代价。
```

### 4.3 ★★★ rewrite_cp_refs 函数族 — 18 个 CP 重写函数（新增必须）

```
问题：
  ① 列出 rewrite_cp_refs 主调度器（:1707-1796）调用的 12 个子函数及其覆盖的属性类型。
      答案方向: 必须给出表格——函数名 + :line + 覆盖属性 + 重写对象。
      主调度器 rewrite_cp_refs(:1707) 调用 find_new_index(old)→index_map 映射，再分发到：
      函数分组（6 组 12 函数）：
      (a) Nest 属性: rewrite_cp_refs_in_nest_attributes(:1799)
      (b) 方法体+StackMapTable: rewrite_cp_refs_in_methods(:1815) → 每个方法的 CP refs + stackmap 重写
      (c) 类/字段/方法注解: rewrite_cp_refs_in_class_annotations(:1996), rewrite_cp_refs_in_fields_annotations(:2286), rewrite_cp_refs_in_methods_annotations(:2319)
      (d) 方法参数/默认注解: rewrite_cp_refs_in_methods_parameter_annotations(:2357), rewrite_cp_refs_in_methods_default_annotations(:2406)
      (e) 类型注解(5函数~400行): rewrite_cp_refs_in_class_type_annotations(:2433), rewrite_cp_refs_in_fields_type_annotations(:2451), rewrite_cp_refs_in_methods_type_annotations(:2483)
      (f) 主函数直接改写: source_file_name_index(:1778), generic_signature_index(:1787)
      核心算法: find_new_index(:1038) 查 _index_map_p 数组 → 返回映射后新索引，未映射返回 0
      
      追问: 为什么需要 12 个独立函数而不是一个通用重写器？
      → 每种属性的 CP 引用编码格式不同——注解是 u2 CP index，StackMapTable 是 verification_type_info 结构，BootstrapMethods 是 bootstrap_method_ref 结构
      → 统一函数会变成巨型 switch → 可维护性差
      → 12 个独立函数保证了每种属性类型有专一负责的函数——易于测试和调试

  ② Counterfactual: 如果用单一 rewrite_cp_refs 函数遍历所有属性类型？
      答案方向: 单一函数需要处理 6+ 种不同的属性编码格式 → 代码行数 2000+
      → 每个分支处理不同数据结构 → 容易遗漏 → 遗漏会导致
      某个属性的 CP 引用未更新 → 运行时时隐时现的 LinkageError。
      12 个独立函数保证了每种属性类型有专一负责的函数——易于测试和调试。
```

### 4.4 ★★★ redefine_single_class — 432 行核心函数（新增必须）

```
问题：
  ① redefine_single_class (jvmtiRedefineClasses.cpp:3970, ~260行) 的完整 18 步流程是什么？
      答案方向: 按执行顺序列出每一步、对应 line、关键操作。核心设计是 **swap 而非 replace**——将新数据放到 the_class，旧数据放到 scratch_class（随后进 previous_version 链表）。
      1. get_ik(:3979) — 获取原始 InstanceKlass
      2. clearall_in_class_at_safepoint(:3982) — 清除该类所有断点
      3. flush_dependent_code(:3986) — 去优化所有依赖此类的 JIT 代码
      4. compute_added_deleted_matching_methods(:3988, :3887) — 双指针归并：name+signature 比较分 matching/added/deleted
      5. update_jmethod_ids(:3992, :3555) — 将匹配方法旧 jmethodID 指针切换为新方法
      6. scratch_class->constants()->set_pool_holder(:3998) — 新 CP 的 holder 指向原类
      7. Swap methods+method_ordering(:4050) — the_class ↔ scratch_class 交换方法数组
      8. Swap constants(:4058) — the_class ↔ scratch_class 交换常量池
      9. check_methods_and_mark_as_obsolete(:4098, :3578) — EMCP 方法保留 jmethodID；非 EMCP 标记 is_obsolete
      10. transfer_old_native_function_registrations(:4099) — JNI 原生方法注册转移
      11. Swap inner_classes(:4122) — 交换内部类数组
      12. initialize vtable+itable(:4135) — initialize_vtable(false) + initialize_itable(false)
      13. swap_annotations(:4165, :3949) — 交换所有注解
      14. 复制元数据(:4167-4189) — minor/major_version、enclosing_method、fingerprint、设置 has_been_redefined
      15. the_class->add_previous_version(:4198) — 归档旧版本（scratch_class 加入 previous_version 链表）
      16. AdjustCpoolCacheAndVtable(:4207, :3431) — 遍历所有类，调整引用被 redefine 类的 vtable/itable 条目
      17. flush_obsolete_entries(:4213) — oop_map_cache 清理过期条目
      18. increment_class_counter(:4216) — 全局 classRedefinedCount++
      
      追问: 步骤 7-8 的 swap 设计原因？
      → 旧方法/常量池移到 scratch_class → scratch_class 加入 previous_version 链表
      → 旧字节码对 EMCP 方法仍可执行（断点一致性）。旧 CP 的 pool_holder 不变
      — 改为 scratch_class 会破坏 vtable 初始化的子类型检查（特别是 miranda 方法）。

  ② Counterfactual: 如果 redefine_single_class 没有 verify_bytecodes 步骤？
      答案方向: 新字节码中的非法操作在运行时才被解释器检测
      → 可能在其他 Java 线程中抛 VerifyError → 非原子失败
      → 部分类方法已生效、部分未生效 → 比整体失败更糟糕——无法回滚。
      在 safepoint 中验证保证了原子性：要么全部通过，要么全部回滚。
```

### 4.5 ★★★ AdjustCpoolCacheAndVtable — 全局一致性调整

```
问题：
  ① AdjustCpoolCacheAndVtable::do_klass (jvmtiRedefineClasses.cpp:3431) 的调整逻辑是什么？
      答案方向: KlassClosure 遍历所有已加载类，对每个相关类执行：
        1. k->vtable().adjust_method_entries() → 替换 vtable 中旧方法指针
        2. k->itable().adjust_method_entries() → 替换 itable 中旧方法指针  
        3. 如果被 redefine 的是接口 → 遍历所有实现类的 itable
        4. 调整 ConstantPoolCache 中的 method entry
      时间复杂度：O(n_classes × vtable_size)——redefine 1 个类可能需要遍历所有类。
      
      追问: 为什么 vtable/itable 调整是 O(n_classes) 而不是 O(1)？
      → redefine 父类 A → 任何子类 B extends A 的 vtable 从 A 继承的条目需要更新。
      无法预先知道哪些类受 A 影响 → 必须遍历 ClassLoaderDataGraph → 每个类检查。

  ② Counterfactual: 如果只更新被 redefine 的类自己的 vtable？
      答案方向: 子类 B extends A，A 被 redefine → B 的 vtable 中 A 继承条目
      仍指向旧方法 → B 的实例调用继承方法走旧代码 → 行为不一致。
      这是比"redefine 不生效"更隐蔽的 bug——部分类生效部分不生效。
```

### 4.6 ★★★ JvmtiClassFileReconstituter — 37 方法/960 行/反向重建（新增必须）

```
问题：
  ① JvmtiClassFileReconstituter (jvmtiClassFileReconstituter.cpp:1-960) 如何从 Klass 元数据重建 .class 文件？
      答案方向: 类层次 JvmtiClassFileReconstituter → JvmtiConstantPoolReconstituter → StackObj。
      37 个方法，按 ClassFile 格式 (JVMS §4) 逐 section 反向工程：
      
      基类 JvmtiConstantPoolReconstituter (cpp:38):
        - 构造函数遍历 ConstantPool → hash_entries_to() 建立 Symbol→cp_index 双向映射表
        - symbol_to_cpool_index(sym) / class_symbol_to_cpool_index(sym) → u2 索引查表
        - copy_cpool_bytes() → 序列化 CP 为 JVM Spec 格式字节

      顶层入口 write_class_file_format() (cpp:781):
        magic(CAFEBABE) → version → constant_pool → access_flags → this/super → interfaces → fields → methods → attributes

      Field 序列化 write_field_infos() (cpp:55):
        - JavaFieldStream 遍历: access/name/desc + ConstantValue/Signature/Annotations

      Method 序列化 write_method_infos() (cpp:736):
        - 通过 method_ordering 逆映射恢复原始声明顺序
        - write_method_info() (cpp:589): access/name/sig + Code/Exceptions/LineNumber/LVT/LVTT/StackMap 属性
        - 跳过 overpass 方法（编译器生成的默认接口方法）

      字节码逆重写 copy_bytecodes() [static] (cpp:876):
        - 核心难点: JVM 链接后 getfield/putfield/invokexxx 操作数被替换为 cpCache 索引
        - 通过 ConstantPoolCacheEntry::constant_pool_index() 还原原始 cp_index
        - fast_aldc/aldc → ldc/ldc_w 同样还原

      写时动态扩容 writeable_address() (cpp:834):
        - REALLOC_RESOURCE_ARRAY 按 1024 对齐翻倍——无需预计算总大小
      
      追问: 为什么 whole thing 在构造函数中完成（构造即序列化）？
      → ResourceObj 内存: buffer 在 ResourceMark 作用域内有效
      → 调用者必须准备 ResourceMark + HandleMark
      → 构造完成 → class_file_bytes() 返回 → 用完后 ResourceMark 析构自动释放

  ② Counterfactual: 如果不用 JvmtiClassFileReconstituter，而是始终缓存原始字节码？
      答案方向: 每个类需要额外 ~10KB 内存缓存原始字节码（10000 类 → 100MB）
      → 对不再 redefine 的类浪费内存 → JIT 编译后原始字节码已无实际用途
      → 按需重建只在 retransform 时花费 CPU 时间 → 内存优先策略
      → trade-off: 每次 retransform 重建 ~100µs vs 每类缓存 ~10KB
```

### 4.7 ★★★ flush_dependent_code — JIT 代码刷除

```
问题：
  ① flush_dependent_code (jvmtiRedefineClasses.cpp:3863) 如何刷除 JIT 编译代码？
      答案方向:
        1. CodeCache::mark_for_deoptimization(old_method) → 标记旧方法的编译版本
        2. nmethod::make_not_entrant() → 设置入口点为 deoptimization 桩
        3. 下次调用该方法 → 触发 deoptimization → 解释器使用新字节码
        4. sweeper 线程异步回收 nmethod 内存
      
      追问: 为什么不是立即删除 nmethod 而是 mark_not_entrant？
      → nmethod 可能正在被其他线程执行（栈上有返回地址）。
      立即删除 → 线程从 nmethod 返回时找不到代码 → SIGSEGV。
      make_not_entrant 是安全的"延迟删除"——活跃线程完成当前执行，新调用走 deoptimization 桩。

  ② Counterfactual: 如果不刷 JIT 代码——只替换 Klass 元数据？
      答案方向: JIT 编译的方法体内嵌了常量池索引、vtable 偏移、类型检查。
      redefine 修改了这些 → 已编译代码中的偏移/索引失效
      → 类型检查通过但类型不匹配 → ClassCastException 在错误位置
      → 或更糟糕：内存损坏（写入错误偏移的字段）。
```

### 4.8 ★★★ Retransform 复用 Redefine — _class_load_kind 分派

```
问题：
  ① JvmtiEnv::RetransformClasses (jvmtiEnv.cpp:393) 如何复用 VM_RedefineClasses？
      答案方向:
        1. 设置 _class_load_kind = jvmti_class_load_kind_retransform (:398)
        2. load_new_class_versions (:1115) 走 CFLH 管道：
           a. InstanceKlass::set_cached_class_file(old_bytes) — 缓存原始字节码
           b. JvmtiExport::post_class_file_load_hook — 触发 CFLH 事件
           c. agent ClassFileTransformer 修改字节码
           d. 修改后的字节码成为 "new class bytes"
           e. 如果需要原始字节码 → JvmtiClassFileReconstituter 从 Klass 重建
        3. 后续流程与 redefine 完全相同——CP 合并、vtable 调整、JIT 刷除
      
      追问: 为什么 retransform 不需要 schema 兼容性检查？
      → retransform 的字节码来自 CFLH（agent 只修改方法体），字段/方法签名不变。
      agent 的 ClassFileTransformer.transform() 只能修改方法体——JVM 在
      ClassFileParser 阶段拒绝 schema 变更。

  ② Counterfactual: 如果 RetransformClasses 有独立的 VM Operation 类？
      答案方向: 需要复制 VM_RedefineClasses 的 ~3000 行逻辑
      → 代码重复 → 两个版本容易不一致（bug 修一个忘另一个）。
      通过 _class_load_kind 分派复用同一个类——差异只在 load_new_class_versions
      的字节码来源（外部提供 vs CFLH 管道），其他逻辑完全相同。
```

### 4.9 ★★★ JvmtiManageCapabilities — 7-set 模型 + 4 层门控（新增必须）

```
问题：
  ① JvmtiManageCapabilities 的 7 个静态 jvmtiCapabilities 集合模型是什么？
      答案方向: 2×2 矩阵 + 跟踪 = 7 集合：
        维度1 "阶段": always(任何阶段) vs onload(仅OnLoad)
        维度2 "并发": 共享(任何环境) vs solo(仅一个环境) vs remaining(solo未抢)
        + acquired_capabilities (所有曾获取过的能力累积)
      
      4 个初始化函数:
        init_always_capabilities() (:71-102) — 22 个能力，含 can_redefine_classes/can_retransform_classes(:92-95)
        init_onload_capabilities() (:104-126) — 14 个 OnLoad-only 能力（#ifndef ZERO 保护 frame_pop）
        init_always_solo_capabilities() (:129-136) — 2 个 solo 能力
        init_onload_solo_capabilities() (:139-147) — 3 个 solo 能力
      
      位运算工具(5个): either(:150), both(:164), exclude(:178), has_some(:192), update(:293)
      
      CAPA_SIZE(:32): (JVMTI_INTERNAL_CAPABILITY_COUNT + 7) / 8 — 能力位图字节对齐

  ② add_capabilities(:234-268) 的 6 步协议是什么？
      答案方向: 
        1. 验证: get_potential_capabilities → exclude(desired) → 超出则 NOT_AVAILABLE
        2. 记录: either(&acquired_capabilities, desired) — 永远记住
        3. OnLoad→Always 迁移: 若 desired 含 onload 能力 → 永久转移到 always 集合
        4. Solo 迁移: 同上述处理 solo
        5. Solo 剥夺: 从 remaining 中移除 → 防止其他环境获取
        6. update() 副作用: 将能力位图转为 12+ 个 JvmtiExport 布尔开关
      
      追问: 4 层门控如何 gate redefine/retransform？
      → 第1层: add_capabilities 验证（can_redefine 是 always 能力，任何阶段可获取）
      → 第2层: ClassFileLoadHook 互斥门 (jvmtiEnvBase.cpp:358-365) — 若 CFLH 已启用但无 retransform 能力 → 永禁 retransform（无缓存原始 bytes）
      → 第3层: 版本语义门 (jvmtiEnv.cpp:3201) — 1.0 agent IsMethodObsolete 需 redefine 能力
      → 第4层: JVMTI 入口 stub — RedefineClasses/RetransformClasses 本身不检查能力，由生成 stub 或 jvmtiEnter 检查

  ② Counterfactual: 如果 update() 不在每次 add_capabilities 后调用？
```

注：此处至少还需要 4.10（Schema 兼容性检查深度 — compare_and_normalize_class_versions :775 完整禁止列表）、4.11（锁机制与并发安全 — lock_classes :85 / unlock_classes :105 + CAS 重入保护）、4.12（update_jmethod_ids :3555 两阶段 jmethodID 映射 + check_methods_and_mark_as_obsolete :3578 EMCP vs 非EMCP 标记）、4.13（load_new_class_versions :1115 14步 ClassFileParser→schema→verify→merge_cp 完整链）、4.14（compute_added_deleted_matching_methods :3887 双指针归并算法）、4.15（swap_annotations :3949 + transfer_old_native_function_registrations :3842）、4.16（previous_version 链表 — add_previous_version :4198 + EMCP 方法断点一致性）、4.17（ClassFileLoadHook 交互 — _class_load_kind 分派 + JvmtiCachedClassFileData 缓存 + JvmtiClassFileReconstituter 环路闭合）。生成文档时每个形成独立的 §1.x 子节。

---

## §五 Article Structure（完整重构版 v2）

```
§〇 生产场景 — "class redefinition failed: attempted to change the schema"
  ★ 真实错误消息 + schema 变更诊断
  ★ 三步诊断: Xlog:redefine → jcmd VM.safepoint → GDB 断点
  ★ 反事实: 无 safepoint → 竞态 SIGSEGV

§一 ★★★ redefine 全链路源码走读（新增 1.13-1.19）
  1.1 jvmtiEnv.cpp:457 RedefineClasses → 创建 VM_RedefineClasses
  1.2 jvmtiRedefineClasses.cpp:85 lock_classes / :105 unlock_classes → 锁机制
  1.3 jvmtiRedefineClasses.cpp:1115 load_new_class_versions → 14步: ClassFileParser→验证→merge_cp
  1.4 jvmtiRedefineClasses.cpp:775 compare_and_normalize_class_versions → schema 检查
  1.5 jvmtiRedefineClasses.cpp:115 doit_prologue → 锁类+加载+比较
  1.6 jvmtiRedefineClasses.cpp:183 doit → 进入 safepoint
  1.7 jvmtiRedefineClasses.cpp:1362 merge_constant_pools → 4 Pass CP 合并算法
  1.8 jvmtiRedefineClasses.cpp:1707 rewrite_cp_refs → 12 函数/6 类型/全覆盖
  1.9 jvmtiRedefineClasses.cpp:3970 redefine_single_class → 18 步/swap 设计/完整剖析
  1.10 jvmtiRedefineClasses.cpp:3235 set_new_constant_pool → 安装新 CP
  1.11 jvmtiRedefineClasses.cpp:3431 AdjustCpoolCacheAndVtable → vtable/itable 全局调整
  1.12 jvmtiRedefineClasses.cpp:3863 flush_dependent_code → JIT 代码刷除
  1.13 jvmtiRedefineClasses.cpp:3555 update_jmethod_ids → 两阶段 jmethodID 映射
  1.14 jvmtiRedefineClasses.cpp:3578 check_methods_and_mark_as_obsolete → EMCP/obsolete 标记
  1.15 jvmtiRedefineClasses.cpp:3887 compute_added_deleted_matching_methods → 双指针归并
  1.16 jvmtiRedefineClasses.cpp:241 doit_epilogue → 清理+归档(previou_version 链表)
  1.17 jvmtiEnv.cpp:393 RetransformClasses → 复用 VM_RedefineClasses + CFLH 管道
  1.18 jvmtiClassFileReconstituter.cpp 全文件 → 37 方法/960 行/重建器完整分析
  1.19 jvmtiManageCapabilities.cpp 全文件 → 7-set 模型/4层门控/能力完整分析
  1.20 ★ Mermaid: redefine 时序图 — 6 lanes: Java Agent / JavaThread / VMThread / ClassFileReconstituter / CodeCache / Interpreter
  1.21 ★ 面试 Story Format 答案（≥80 行）
  1.13 jvmtiManageCapabilities.cpp init_onload_capabilities → 能力门控
  1.14 jvmtiRedefineClasses.cpp:75-105 lock_classes / unlock_classes → 锁机制
  1.15 jvmtiRedefineClasses.cpp:775 compare_and_normalize_class_versions → schema 检查
  1.16 jvmtiEnv.cpp:384 IsModifiableClass → 可修改类判断
  1.17 ★ Mermaid: redefine 时序图 — 6 lanes: Java Agent / JavaThread / VMThread / ClassFileReconstituter / CodeCache / Interpreter
  1.18 ★ 面试 Story Format 答案（≥80 行）

§二 ★★★ Standard Environment（不是 callout 框！）
  2.1 Source Roots — 12 个文件的完整路径 + 行数范围
  2.2 构建命令 + Binary Paths
  2.3 Syscall 速查表 — 6 项(mmap/munmap/futex/open/read/memcpy/pthread_mutex_lock)，每项 man 2/3 + errno
  2.4 /proc 接口表 — 3 项(maps/max_map_count/status)
  2.5 全局状态变量 — jvmtiCapabilities + InstanceKlass redefine 标志

§三 ★★ Source Files Table — 12 个文件 × 路径×行数×核心函数×角色

§四 ★★ 性能剖析
  4.1 Schema 检查开销: O(n_fields + n_methods) ≈ 10µs/class
  4.2 CP 合并: O(cp_size²) ≈ 100µs/class (1000 条目)
  4.3 CP 重写(18 函数): O(n_attrs × n_refs) ≈ 200µs/class
  4.4 Vtable 调整: O(n_classes × vtable_size) ≈ 1ms (1000 类)
  4.5 JIT 刷除: O(n_nmethods_dependent) ≈ 100µs-10ms
  4.6 Safepoint 总时间: 1-50ms（取决于类数量和依赖复杂度）
  4.7 按类扩展的线性证明 + redefine 20 个类 vs 1 个类的开销对比

§五 ★★ 边缘场景与异常路径（独立 section，≥5 场景）
  5.1 并发 redefine 同一个类 — lock_classes 的互斥效果
  5.2 merge_cp 期间 OOM — Metaspace 分配失败时的回滚路径
  5.3 GC 与 redefine 并发 — Metaspace GC 与 redefine 锁的交互
  5.4 native 方法 redefine — transfer_old_native_function_registrations(:3842)
  5.5 栈上旧方法帧处理 — check_methods_and_mark_as_obsolete(:3578) + Deoptimization
  5.6 CDS 冲突 — redefine 修改了归档类的副作用
  5.7 CP 65535 条目硬上限 — merge_cp 溢出时的诊断和预防

§六 ★ 诊断工具实战（strace + jcmd + jstack + GDB + /proc）
  6.1 strace: -e trace=futex,mmap,munmap,read —— 追踪 safepoint 同步和内存分配
  6.2 jcmd: VM.safepoint（safepoint 统计）+ VM.classes（类计数）+ VM.log redefine+class*=trace
  6.3 jstack: 验证 VMThread 的 safepoint 阻塞（"waiting on VMOperation" / "VM_RedefineClasses"）
  6.4 GDB: 10 断点完整 trace（见 §七）
  6.5 /proc: max_map_count + maps 验证 Metaspace 状态

§七 ★ GDB 断点验证 — 10+ 断点完整 redefine trace
  断言 1: jvmtiEnv.cpp:457 RedefineClasses → verify VM_RedefineClasses created
  断言 2: jvmtiRedefineClasses.cpp:115 doit_prologue → verify class locked
  断言 3: jvmtiRedefineClasses.cpp:183 doit → verify safepoint entered
  断言 4: jvmtiRedefineClasses.cpp:1362 merge_constant_pools → verify merge_cp created
  断言 5: jvmtiRedefineClasses.cpp:1815 rewrite_cp_refs_in_methods → verify first rewrite
  断言 6: jvmtiRedefineClasses.cpp:3970 redefine_single_class → verify 12-step entry
  断言 7: jvmtiRedefineClasses.cpp:3235 set_new_constant_pool → verify old_cp replaced
  断言 8: jvmtiRedefineClasses.cpp:3431 AdjustCpoolCacheAndVtable → verify vtable updated
  断言 9: jvmtiRedefineClasses.cpp:3863 flush_dependent_code → verify nmethods deoptimized
  断言 10: jvmtiRedefineClasses.cpp:241 doit_epilogue → verify cleanup
  断言 11: jvmtiClassFileReconstituter.cpp entry → verify reconstituter call
  每个断言含: (gdb) break + (gdb) print + 期望值

§八 ★★ Cross-Reference
  ❓ 01-Agent-Loading — capability 设置（Can-Redefine-Classes/Can-Retransform-Classes 在 manifest 中的声明）
  ❓ 02-ClassFileLoadHook — CFLH 管道 + JvmtiCachedClassFileData + post_class_file_load_hook
  ❓ 03-Attach-API — agentmain 通过 Attach API 触发 redefine
  ❓ 05-JVMTI-Core — JvmtiEnv 完整 API + EventController + capabilities
  ❓ 06-JDWP-Transport — redefine 通过 JDWP RedefineClasses 命令触发
  ❓ 参考: JVM Specification §4 (ClassFile 格式), §2.12 (类版本)
```

---

## §六 Writing Requirements

1. **Every paragraph opens with WHY** — "Because redefine must not corrupt running threads' view of class metadata, doit() executes at a global safepoint where all Java threads are paused..." — not WHAT.

2. **3-5 lines source code per claim** — paste relevant C++ code from jvmtiRedefineClasses.cpp, jvmtiClassFileReconstituter.cpp, jvmtiManageCapabilities.cpp, do not describe it.

3. **Mermaid** — redefine 时序图。6 lanes: Java Agent / JavaThread / VMThread / ClassFileReconstituter / CodeCache / Interpreter。完整流程覆盖 redefine + retransform 两条路径。retransform 路径突出 ClassFileReconstituter 的参与。

4. **GDB session** — ≥10 breakpoints with exact file:line numbers and expected variable values.

5. **10 Beginner callout boxes** — exact text from §一，全部内嵌在 §一 各子节中，不在独立的 §二 中。

6. **Cross-reference at five points**:
   - At `load_new_class_versions` → "→ 02-ClassFileLoadHook for CFLH pipeline that retransform uses"
   - At `AdjustCpoolCacheAndVtable` → "→ 03-object-model for vtable/itable layout details"
   - At `flush_dependent_code` → "→ 05-jit-compiler for CodeCache and deoptimization internals"
   - At `ClassFileReconstituter` → "→ JVM Spec §4 for ClassFile format reference"
   - At `JvmtiManageCapabilities` → "→ 01-Agent-Loading for agent manifest capability declaration"

7. **Story-format interview answer** — at §一末尾, ≥80 行。

8. **"不要写成→应该写成" 对照表** (必须在 §六 中出现，≥8 行):
   | 不要写成 | 应该写成 |
   |---------|---------|
   | "redefineClasses replaces class bytes" | "JvmtiEnv::RedefineClasses at jvmtiEnv.cpp:457 creates VM_RedefineClasses with _class_load_kind=jvmti_class_load_kind_redefine, submits to VMThread::execute() — the operation spans three phases across two threads: doit_prologue (JavaThread) → doit (VMThread safepoint) → doit_epilogue (JavaThread)" |
   | "CP merging combines old and new constant pools" | "merge_constant_pools at jvmtiRedefineClasses.cpp:1362 preserves old_cp indices via append_operand(:592)/find_or_append_operand(:635)/finalize_operands_merge(:661), builds index_map via map_index(:1316)/map_operand_index(:1337) for bytecode rewriting — O(n_scratch×n_old) complexity with u2 65535 hard limit" |
   | "rewrite_cp_refs patches bytecode CP indices" | "18 independent rewrite_cp_refs_* functions (jvmtiRedefineClasses.cpp:1707-3147) cover 7 attribute categories: method bodies(:1815), field/method annotations(:1968-2170), class annotations(:2075), StackMapTable(:2180-2290), type annotations(:2367-2784), BootstrapMethods(:2793-2910), and nest/record/dynamic_constant(:2932-3147) — each rewriting scratch_cp indices to merge_cp indices through the index_map parameter" |
   | "vtable entries are updated after redefine" | "AdjustCpoolCacheAndVtable::do_klass at jvmtiRedefineClasses.cpp:3431 is a KlassClosure that visits EVERY loaded class (O(n_classes) traversal), calling k->vtable().adjust_method_entries() and k->itable().adjust_method_entries() to replace old method pointers — this is required because redefining a parent class affects ALL subclasses' inherited vtable entries" |
   | "JIT code is invalidated after redefine" | "flush_dependent_code at jvmtiRedefineClasses.cpp:3863 calls CodeCache::mark_for_deoptimization then nmethod::make_not_entrant — setting entry points to deoptimization stubs rather than immediately freeing nmethods (because active threads may still have the nmethod on their stack); sweeper thread asynchronously reclaims memory later" |
   | "JvmtiClassFileReconstituter rebuilds old class files" | "JvmtiClassFileReconstituter (jvmtiClassFileReconstituter.cpp, 960 lines) reverse-engineers a .class file from InstanceKlass metadata — reconstructing constant_pool from ConstantPool, fields from FieldInfo, methods from Method (including Code attribute), and annotations — closing the redefine→retransform→CFLH loop when original bytes are no longer in memory" |
   | "Retransform reuses the same VM operation" | "JvmtiEnv::RetransformClasses at jvmtiEnv.cpp:393 creates the same VM_RedefineClasses but with _class_load_kind=jvmti_class_load_kind_retransform — triggering CFLH pipeline (JvmtiExport::post_class_file_load_hook) in load_new_class_versions at :1115, using JvmtiClassFileReconstituter if original bytes are unavailable" |
   | "Capabilities gate redefine/retransform" | "JvmtiManageCapabilities::init_onload_capabilities() initializes can_redefine_classes/can_retransform_classes bit flags in jvmtiCapabilities — checked by JvmtiEnv::RedefineClasses at jvmtiEnv.cpp:466 and RetransformClasses at :407, returning JVMTI_ERROR_MUST_POSSESS_CAPABILITY if unset" |

---

## §七 Output Format

- Markdown file, named `04-Redefine-Classes.md`
- Output path: `/data/workspace/openjdk-cut-new/probe_md/18-agent-instrument/docs/`
- 元信息头: 包含阶段、前置、配套、后续依赖、阅读收益
- **目标行数: ≥2,000 lines**（当前 v1 284 行 → 7x 扩容）
- Section 编号: §〇→§一→§二→§三→§四→§五→§六→§七→§八（用 `rg '^## §' file.md` 验证）

---

## §八 Prohibited（≥12 条）

- ❌ 只说 "redefineClasses modifies classes" 而不展示 VM_Operation 三阶段模型 — 必须从 jvmtiEnv.cpp:457 到 jvmtiRedefineClasses.cpp:241 的完整源码
- ❌ 将 §二 写成 Beginner Callout 框（callout 只在 §一 内部）— §二 必须是 Standard Environment（source roots + 构建命令 + binary paths + syscall 速查表 + /proc 表）
- ❌ 不解释 merge_constant_pools 的 4 个 helper 函数 — 必须展示 append_operand/find_or_append_operand/finalize_operands_merge/map_index 的完整协作
- ❌ 只用一行提及 "rewrite_cp_refs" — 必须列出全部 18 个函数、7 种属性类别、每类的重写目标
- ❌ 忽略 redefine_single_class 函数 — 必须展示完整的 12 步流程（每步含 file:line + 函数名）
- ❌ 忽略 JvmtiClassFileReconstituter — 必须展示完整的反向重建算法、从 Klass 元数据到 ClassFile 格式的映射
- ❌ 忽略 JvmtiManageCapabilities — 必须展示能力初始化、位标志、与 agent manifest 的关系
- ❌ 不解释 vtable/itable 调整 — 必须展示 AdjustCpoolCacheAndVtable KlassClosure 的遍历逻辑和 O(n_classes) 复杂度
- ❌ 不解释 flush_dependent_code — 必须展示 make_not_entrant vs 立即删除的区别
- ❌ 不解释 schema 兼容性限制 — 必须精确展示哪些变更是允许的、哪些被禁止、为什么
- ❌ 不做 GDB 断点 trace — 至少 10 个断点覆盖 prologue → doit → redefine_single_class → epilogue + ClassFileReconstituter
- ❌ 不设置边缘场景 section — 至少 5 个场景（并发 redefine、OOM、GC 交互、native 方法、CP 溢出）
- ❌ 不做 syscall 分析 — 必须为 mmap/futex/munmap/memcpy 标注 man 2/3 来源 + errno 列表
- ❌ 不要写成 JRebel/HotSwap 使用指南

---

## §九 Required（≥12 条）

- ✅ **★ Mermaid 时序图** — 6 lanes: Java Agent / JavaThread / VMThread / ClassFileReconstituter / CodeCache / Interpreter
- ✅ **★ doit_prologue + doit + doit_epilogue 完整源码** — 三阶段逻辑
- ✅ **★ merge_constant_pools 算法详解** — old_cp 保留 + scratch_cp 追加 + 4 helper + index_map
- ✅ **★ rewrite_cp_refs 全族 18 函数** — 表格 + 源码引用 + 7 种类型分类
- ✅ **★ redefine_single_class 12 步完整剖析** — 每步含 file:line + 关键函数
- ✅ **★ JvmtiClassFileReconstituter 反向重建** — 960 行源码的算法级分析
- ✅ **★ JvmtiManageCapabilities 能力门控** — init_onload_capabilities + bit flags
- ✅ **★ AdjustCpoolCacheAndVtable 源码** — KlassClosure 遍历 + vtable/itable adjust
- ✅ **★ flush_dependent_code 源码** — make_not_entrant + deoptimization 时间线
- ✅ **★ Retransform 复用 Redefine** — _class_load_kind 分派 + CFLH 管道 + ClassFileReconstituter
- ✅ **★ 边缘场景 section ≥5 场景** — 并发 redefine、OOM、GC、native 方法、CP 溢出、CDS 冲突
- ✅ **★ 10 Beginner Callout 框** — 在 §一 内部，不是独立 §二
- ✅ **★ 面试 Story Format 答案** — §一 末尾，≥80 行
- ✅ **★ GDB 断点 ≥11 条** — 精确到 file:line（含 ClassFileReconstituter）
- ✅ **★ "不要写成→应该写成" 对照表** — §六 中 ≥8 行
- ✅ **★ 诊断工具五件套** — strace + jcmd + jstack + GDB + /proc（独立 §六）
- ✅ **★ man 手册引用 ≥6 项** — mmap(2), munmap(2), futex(2), open(2), read(2), memcpy(3), pthread_mutex_lock(3)
- ✅ **★ Source Files Table** — 完整路径 × 行数 × 核心函数 × 角色
- ✅ **★ §二 Standard Environment** — source roots + 构建命令 + binary paths + syscall 表 + /proc 表

---

## §十 GDB Verification（≥11 assertions, ≥8 with expected output）

```
断言 1: JvmtiEnv::RedefineClasses (jvmtiEnv.cpp:457)
  (gdb) break jvmtiEnv.cpp:457
  (gdb) print class_count → 期望: >0
  (gdb) print class_definitions → 期望: 非 NULL

断言 2: doit_prologue 入口 (jvmtiRedefineClasses.cpp:115)
  (gdb) break jvmtiRedefineClasses.cpp:115
  (gdb) print _class_load_kind → 期望: 1 (redefine) 或 2 (retransform)

断言 3: doit 入口 — safepoint (jvmtiRedefineClasses.cpp:183)
  (gdb) break jvmtiRedefineClasses.cpp:183
  (gdb) print SafepointSynchronize::is_at_safepoint() → 期望: true

断言 4: merge_constant_pools 入口 (jvmtiRedefineClasses.cpp:1362)
  (gdb) break jvmtiRedefineClasses.cpp:1362
  (gdb) print old_cp->length() → 期望: 原 CP 条目数
  (gdb) print scratch_cp->length() → 期望: 新 CP 条目数

断言 5: rewrite_cp_refs_in_methods 第一个函数 (jvmtiRedefineClasses.cpp:1815)
  (gdb) break jvmtiRedefineClasses.cpp:1815
  (gdb) print scratch_cp->length() → 期望: scratch CP 大小
  (gdb) print merge_cp_length → 期望: merge CP 大小

断言 6: redefine_single_class 入口 (jvmtiRedefineClasses.cpp:3970)
  (gdb) break jvmtiRedefineClasses.cpp:3970
  (gdb) print the_class->external_name() → 期望: 被 redefine 的类名

断言 7: set_new_constant_pool (jvmtiRedefineClasses.cpp:3235)
  (gdb) break jvmtiRedefineClasses.cpp:3235
  (gdb) print the_class->constants() → 期望: 指向 merge_cp

断言 8: AdjustCpoolCacheAndVtable (jvmtiRedefineClasses.cpp:3431)
  (gdb) break jvmtiRedefineClasses.cpp:3431
  (gdb) print k->external_name() → 期望: 当前正在调整的类名

断言 9: flush_dependent_code (jvmtiRedefineClasses.cpp:3863)
  (gdb) break jvmtiRedefineClasses.cpp:3863
  (gdb) print old_methods->length() → 期望: 旧方法数量
  (gdb) continue
  (gdb) print nm->is_not_entrant() → 期望: true

断言 10: doit_epilogue (jvmtiRedefineClasses.cpp:241)
  (gdb) break jvmtiRedefineClasses.cpp:241
  (gdb) print _the_class->is_being_redefined() → 期望: false

断言 11: JvmtiClassFileReconstituter (jvmtiClassFileReconstituter.cpp entry)
  (gdb) break jvmtiClassFileReconstituter.cpp:<constructor>
  (gdb) print ik->name() → 期望: 要重建的类名
  (gdb) continue
  (gdb) print <reconstituted_buffer_size> → 期望: >0
```

---

## §十一 与 README 和同组 prompt 的连续性

1. **从 README §一 承接**：本文展开 "04 — Redefine/Retransform: VM_RedefineClasses → safepoint → redefine_single_class"——从 JVMTI 入口到 vtable 调整的完整代码级解答，覆盖 jvmtiRedefineClasses.cpp 全部 4,382 行 + jvmtiClassFileReconstituter.cpp 960 行 + jvmtiManageCapabilities.cpp 457 行。

2. **同组边界**: 
   - 01 覆盖 Agent 加载（capability 设置，retransformableEnvironment 的初始化入口）
   - 02 覆盖 CFLH 管道（retransform 的字节码来源——post_class_file_load_hook 完整链路）
   - 03 覆盖 Attach API（agentmain 触发 redefine 的路径）
   - 05 覆盖 JVMTI 核心（JvmtiEnv 完整 API、EventController、capability 接口）
   - 06 覆盖 JDWP（RedefineClasses JDWP 命令触发 redefine 的路径）

3. **本文与 02 的最强依赖**: retransform 依赖 CFLH 管道提供新字节码。load_new_class_versions (:1115) 中的 `_class_load_kind == jvmti_class_load_kind_retransform` 分支调用 JvmtiExport::post_class_file_load_hook——这是 02 文档的核心。两个文档结合形成闭环：02 解释了字节码如何进入管道，04 解释了字节码如何替换已加载的类。

4. **本文与 03 的斜街**: agentmain() 中调用 instrumentation.retransformClasses() → JvmtiEnv::RetransformClasses(:393) → VM_RedefineClasses → 回到本文全程。02 解释了 agentmain 如何被触发，04 解释了 redefine 如何执行。
