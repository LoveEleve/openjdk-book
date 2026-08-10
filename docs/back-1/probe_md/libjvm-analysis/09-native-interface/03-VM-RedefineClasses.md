# 03 — VM_RedefineClasses：用类重定义验证 VM_Operation 框架的普适性

> **元信息**
> - 标准环境：OpenJDK 11 slowdebug build，`-Xms8g -Xmx8g -XX:+UseG1GC`，64-bit Linux x86
> - 跨模块说明：`prims/`（jvmtiRedefineClasses + jvmtiEnv）+ `runtime/`（VM_Operation + VMThread）+ `classfile/`（MetadataOnStackMark）
> - 前置文档：[08-01 Safepoint-Protocol]、[08-02 Polling-Mechanism]、[08-03 VM-Operation-Framework]、[09-01 ThreadState-NativeTransition]、[09-04 JVM-Entry-Points]
> - 地位：09 阶段纵深文档，阅读顺序可与 05/06/07 并行
> - 阅读收益：拿着一套刚学的 VM_Operation 框架（入队、等票、safepoint begin/end、嵌套执行）去"解剖"一个真实的生产级 VM_Operation 子类——验证框架不是只给 GC 用的，而是 JVM 所有 STW 操作的统一调度器

> 本文聚焦「VM_Operation 框架对 redefine 是否同样适用」，而非 JVMTI 的 class 修改规格。
> 交叉引用：本文的每一步都与 [08-01]§五（block）、[08-02]§二（polling mechanism）、[08-03]§二（VM_Operation 框架）的 GC VM_Operation 路径对比验证。

---

## §〇 源文件清单

| 文件 | 模块 | 在 VM_Operation 框架中的角色 |
|---|---|---|
| `runtime/vmOperations.hpp` | runtime | VM_Operation 基类定义（Mode、虚函数表） |
| `runtime/vmOperations.cpp` | runtime | `VM_Operation::evaluate()` 实现，VM_ThreadStop、VM_Deoptimize 等具体 VM op 的 doit() |
| `runtime/vmThread.cpp` | runtime | `VMThread::execute()`（入队+等票）、`VMThread::loop()`（出队+执行）、`VMOperationQueue::add/remove_next` |
| `runtime/vmThread.hpp` | runtime | VMThread 类声明、_cur_vm_operation 声明 |
| `prims/jvmtiRedefineClasses.hpp` | prims | VM_RedefineClasses 类定义（338—554） |
| `prims/jvmtiRedefineClasses.cpp` | prims | doit_prologue/doit/doit_epilogue、lock_classes、load_new_class_versions、merge_cp_and_rewrite、redefine_single_class |
| `prims/jvmtiEnv.cpp` | prims | JvmtiEnv 入口：RedefineClasses()(457)、RetransformClasses()(393) |
| `classfile/metadataOnStackMark.hpp` | classfile | MetadataOnStackMark RAII 类型（栈上 metadata 标记，防止 redefine 期间回收正在执行的方法） |

---

## §一 ★★★ VM_RedefineClasses 类层次 — 逐虚函数重写 [08] 的框架

### 1.1 类继承图

```
CHeapObj<mtInternal>             // memory/allocation.hpp
  └── VM_Operation               // runtime/vmOperations.hpp:134
        ├── Mode _safepoint      // :137-141
        ├── virtual doit() = 0                // :180  纯虚函数
        ├── virtual doit_prologue() → true    // :181  默认空操作
        ├── virtual doit_epilogue() → {}       // :182  默认空操作
        ├── virtual evaluation_mode() → _safepoint  // :195
        ├── virtual allow_nested_vm_operations() → false  // :196
        └── virtual is_cheap_allocated() → false  // :197

  VM_RedefineClasses              // jvmtiRedefineClasses.hpp:338
    ├── VMOp_Type type() → VMOp_RedefineClasses   // :533
    ├── bool doit_prologue() override              // :534  → .cpp:115-181
    ├── void doit() override                       // :535  → .cpp:183-239
    ├── void doit_epilogue() override              // :536  → .cpp:241-264
    ├── bool allow_nested_vm_operations() → true   // :538  ★ 覆写为 true
    └── evaluation_mode() —— 不覆写，继承 _safepoint  // 注意：无 override
```

对比 GC 的 VM_Operation 子类（`vmOperations.hpp:67` `GenCollectFull`），它们**同样不覆写 `evaluation_mode()`**，都走默认 `_safepoint`。区别在于 `allow_nested_vm_operations()`：redefine 返回 `true`，大多数 GC op 维持默认 `false`（参见 [08-03]§二）。

### 1.2 evaluation_mode 为什么用默认 _safepoint

`VM_RedefineClasses` **没有**覆写 `evaluation_mode()`（`jvmtiRedefineClasses.hpp:533-536`）。这意味着：

```cpp
// vmOperations.hpp:195
virtual Mode evaluation_mode() const { return _safepoint; }
```

`_safepoint` 的含义（`vmOperations.hpp:137`）：blocking（阻塞调用线程）+ safepoint（所有 Java 线程必须停在 safepoint）+ C-heap allocated。这完全匹配 redefine 的需求：

- **必须阻塞调用线程**：JVMTI agent 调用 RedefineClasses 后，调用线程必须等待完成才能得到错误码 `_res`。
- **必须在 safepoint 中执行 doit()**：替换 method table、修改 constant pool、调整 vtable——这些操作都可能被正在执行的 Java 方法读到，必须在所有 Java 线程停止时原子完成。
- **不能从 VMThread 调用 doit_prologue()**：doit_prologue 需要 JavaThread 的 Handle 能力、异常处理、锁等待，VMThread 不具备这些能力（见 2.3）。

### 1.3 allow_nested_vm_operations() = true 的"嵌套"语义

```cpp
// jvmtiRedefineClasses.hpp:538
bool allow_nested_vm_operations() const { return true; }
```

`VM_Operation` 基类默认返回 `false`（`vmOperations.hpp:196`）。返回 `true` 意味着：**当 VMThread 正在执行 VM_RedefineClasses::doit() 时，允许其他 VM_Operation 作为"嵌套 op"被 push 和执行**。

这是 redefine 独有的需求——因为 doit() 中可能触发 **Metaspace 分配失败** → 需要 GC 回收 Metaspace → GC 本身也是一个 VM_Operation。如果没有这个覆写，`VMThread::execute()` 的 else 分支（嵌套路径）会直接 `fatal()` 崩溃（见 §四 4.1）。

对比其他允许嵌套的 VM_Operation：`VM_ThreadStop`（`:246`）、`VM_Deoptimize`（`:320`）、`VM_DeoptimizeFrame`（`:345`）、`VM_UnlinkSymbols`（`:374`）。它们也都返回 `true`，原因类似——deoptimize 可能触发 nmethod 清理、需要 CodeCache flush，这些也需要 safepoint。

### 1.4 静态数组的设计考量

```cpp
// jvmtiRedefineClasses.hpp:342-351
static Array<Method*>* _old_methods;
static Array<Method*>* _new_methods;
static Method**      _matching_old_methods;
static Method**      _matching_new_methods;
static Method**      _deleted_methods;
static Method**      _added_methods;
static int             _matching_methods_length;
static int             _deleted_methods_length;
static int             _added_methods_length;
static Klass*          _the_class;
```

**为什么 static**？注释（`:340-341`）明确说明：
```
// These static fields are needed by ClassLoaderDataGraph::classes_do()
// facility and the AdjustCpoolCacheAndVtable helper:
```

`ClassLoaderDataGraph::classes_do()` 只接受一个函数指针（`KlassClosure`），不接受额外参数。`AdjustCpoolCacheAndVtable`（`:516-521`）作为 `KlassClosure` 子类，在 `do_klass(Klass* k)` 回调中需要用到的 `_old_methods`、`_matching_new_methods` 等数据，只能通过 **VM_RedefineClasses 的 static 字段**传递。这是一个经典的「回调无法传参」→「static 字段传参」模式。

**为什么线程安全**？因为 doit() 在 **VMThread 的 safepoint 中执行**——此时所有 Java 线程都停止了，不存在并发写 static 字段的竞争。唯一可能的并发来自 VMThread 自身（嵌套 GC），但嵌套 GC 不访问这些字段。所以 static 在这里是安全的。

源码中也印证了这一点（`jvmtiRedefineClasses.hpp:76`）：
```
// Note: the above work must be done by the VMThread to be safe.
```

---

## §二 ★★ 从 JVMTI API 到 VM_Operation 入队 — 完整路径对比 [08-03]-GC

### 2.1 JvmtiEnv::RedefineClasses() → VMThread::execute() 的 8 步流程

从 JVMTI API 入口到 VM_Operation 入队完成，以下是完整的 8 步调用链。每一步都同时标注 GC VM_Operation 的对应步骤，验证框架的普适性。

```
【Step 1 — JVMTI 入口：创建 VM_Operation 对象】
  JvmtiEnv::RedefineClasses()                          // jvmtiEnv.cpp:457
  → VM_RedefineClasses op(class_count, class_defs,     // jvmtiRedefineClasses.cpp:68-76
                           jvmti_class_load_kind_redefine);
    → GC 对比：GenCollectForAllocation 用 PlacementNew 在栈上构造

【Step 2 — 调用 VMThread::execute()】
  JvmtiEnv::RedefineClasses()                          // jvmtiEnv.cpp:460
  → VMThread::execute(&op);                            // vmThread.cpp:686
    → GC 对比：完全相同的入口，无区别

【Step 3 — 线程类型判断】
  VMThread::execute(op)                                // vmThread.cpp:689
  → if (!t->is_VM_thread()) {  // 非 VMThread 分支
    skip_gcalot，check_for_valid_safepoint_state(true)
    → GC 对比：完全相同
    → ★ 此时线程状态：[01-ThreadState] 要求在 _thread_in_vm（见验证 §6.4）

  ★ 注意：我们走的是 if 分支，因为调用者是 JavaThread（JVMTI agent 线程）。

【Step 4 — doit_prologue() 在 JavaThread 上执行】
  VMThread::execute()                                  // vmThread.cpp:699
  → if (!op->doit_prologue()) return;  // 失败则取消
    → GC 对比：GC op 的 doit_prologue() 默认返回 true（空操作），不走这段

  ★ 这是 redefine 和 GC 的**第一个关键区别**。
  redefine 的 doit_prologue() 要做大量工作（见 §二 2.3）。

【Step 5 — 设置 calling_thread + priority】
  VMThread::execute()                                  // vmThread.cpp:704
  → op->set_calling_thread(t, Thread::get_priority(t));
    → GC 对比：完全相同

【Step 6 — ticket 机制：获取当前 completed_count 作为 ticket】
  VMThread::execute()                                  // vmThread.cpp:712-715
  → ticket = t->vm_operation_ticket();
    → GC 对比：完全相同（[08-03]§四 ticket 机制）

【Step 7 — 入队 VMOperationQueue】
  VMThread::execute()                                  // vmThread.cpp:720-733
  → VMOperationQueue_lock->lock_without_safepoint_check();
  → bool ok = _vm_queue->add(op);                      // :723 → vmThread.cpp:156-173
      → op->evaluate_at_safepoint() 为 true
      → queue_add_back(SafepointPriority, op);         // :168
  → op->set_timestamp(os::javaTimeMillis());           // :724
  → VMOperationQueue_lock->notify();                   // :725  ★ 唤醒 VMThread
  → VMOperationQueue_lock->unlock();
    → GC 对比：完全相同

【Step 8 — ticket 等待：阻塞调用线程，等待 VMThread 完成】
  VMThread::execute()                                  // vmThread.cpp:735-742
  → MutexLocker mu(VMOperationRequest_lock);           // ★ 阻塞点
  → while(t->vm_operation_completed_count() < ticket) {
      VMOperationRequest_lock->wait(!t->is_Java_thread());
    }
    → GC 对比：完全相同（[08-03]§四 等待机制）
```

关键观察：**除了 Step 4（doit_prologue 的实际内容），redefine 的入队流程和 GC 完全相同**。这就是 VM_Operation 框架的普适性——任何 `evaluation_mode() → _safepoint` 的操作都经过相同的入队→等票→出队→执行→通知路径。

### 2.2 JvmtiEnv::RetransformClasses() 的特殊入口

```cpp
// jvmtiEnv.cpp:393-451
JvmtiEnv::RetransformClasses(jint class_count, const jclass* classes) {
  // ...
  jvmtiClassDefinition* class_definitions =
      NEW_RESOURCE_ARRAY(jvmtiClassDefinition, class_count);
  // 循环：从原始 class 反编译出 class bytes
  for (index = 0; index < class_count; index++) {
    InstanceKlass* ik = InstanceKlass::cast(klass);
    if (ik->get_cached_class_file_bytes() == NULL) {
      // ★ 关键：在 JavaThread 上，尚未入 safepoint，从 VM 元数据反编译 class 文件
      JvmtiClassFileReconstituter reconstituter(ik);
      class_definitions[index].class_bytes =
          reconstituter.class_file_bytes();
    } else {
      class_definitions[index].class_bytes =
          ik->get_cached_class_file_bytes();
    }
  }
  VM_RedefineClasses op(class_count, class_definitions,
                        jvmti_class_load_kind_retransform);
  VMThread::execute(&op);
  return (op.check_error());
}
```

区别仅在于 `_class_load_kind`：
- `RedefineClasses` → `jvmti_class_load_kind_redefine`（用户提供新 class bytes）
- `RetransformClasses` → `jvmti_class_load_kind_retransform`（从 JVM 反编译 class bytes，再走 transform 流程）

其余路径**完全一致**（包括 `VM_RedefineClasses` 构造函数、`VMThread::execute()`、`doit_prologue()` 中的 `load_new_class_versions()`），因为同一套 `VM_RedefineClasses` 类实现两种 API。

### 2.3 doit_prologue() 在 JavaThread 上执行的关键意义 — vs VMThread 的限制

```cpp
// jvmtiRedefineClasses.cpp:115-181
bool VM_RedefineClasses::doit_prologue() {
  // L116-145: 参数校验（class_count, class_defs, class_bytes, is_modifiable_class）
  // ★ 这些检查涉及 JNIHandles::resolve_non_null()——需要 JavaThread 的 Handle 上下文

  lock_classes();     // L153 — 获取 RedefineClasses_lock，可能阻塞等待（需要 JavaThread）
  _res = load_new_class_versions(Thread::current());  // L156 ★ 核心：需要 JavaThread
  // 如果失败：unlock_classes，free scratch_classes，return false（取消 VM op）
}
```

`doit_prologue()` **必须**在 JavaThread 上执行，原因是：

| 能力 | JavaThread (doit_prologue) | VMThread (doit) |
|---|---|---|
| 分配 Handles | ✓ 有 HandleArea | ✓ 有 HandleMark，但限制严格 |
| 抛出/处理 Java 异常 | ✓ `HAS_PENDING_EXCEPTION`/`CLEAR_PENDING_EXCEPTION` | ✗ VMThread 不执行 Java 代码 |
| 获取 Monitor 锁并等待 | ✓ `lock_classes()` 用 `MutexLocker` 等待条件变量 | ✗ VMThread 不允许在 safepoint 中阻塞 |
| 解析 class 文件字节码 | ✓ `SystemDictionary::parse_stream()` 需要 JavaThread | ✗ |
| 触发 class loading 回调 | ✓ JVMTI ClassFileLoadHook 事件在 JavaThread 上触发 | ✗ |
| 分配 ResourceArea 内存 | ✓ ResourceMark 可用 | ✗ `evaluate_operation()` 中有 ResourceMark 但范围有限 |

源码注释（`jvmtiRedefineClasses.hpp:76`）明确说明：
```
// Note: A JavaThread must do the above work.
```

对比 GC VM_Operation：GC 的 `doit_prologue()` 使用基类默认实现（`vmOperations.hpp:181`）——直接返回 `true`，**不做任何事**。GC 不需要在 JavaThread 上做预处理，因为 GC 的工作全部在 doit() 中的 VMThread 上完成。

从 `load_new_class_versions()`（`jvmtiRedefineClasses.cpp:1115-1311`）可以看到 JavaThread 专属操作：
- `JvmtiThreadState *state = JvmtiThreadState::state_for(JavaThread::current())` (L1130)
- `SystemDictionary::parse_stream(...)` (L1159) —— 需要 Handle 保存 class loader 和 protection domain
- `the_class->link_class(THREAD)` (L1198) —— 可能抛出异常
- `Verifier::verify(...)` (L1241) —— 字节码验证，可能抛出 VerifyError
- `Rewriter::rewrite(scratch_class, THREAD)` (L1290) —— 字节码重写
- `merge_cp_and_rewrite(the_class, scratch_class, THREAD)` (L1257) —— CP 合并

### 2.4 ticket 等待 + VMOperationRequest_lock 阻塞 — [08-03] 验证

与 [08-03]§四 GC 路径完全相同：

```
JavaThread                         VMThread
  │                                  │
  ├─ ticket = vm_operation_ticket()  │
  ├─ _vm_queue->add(op)              │
  ├─ 入队完成，notify() ─────────────→ 被唤醒，dequeue
  │                                  ├─ SafepointSynchronize::begin()
  │  (在此阻塞)                       ├─ evaluate_operation(op)
  │                                  │    └→ op->evaluate() → op->doit()
  │                                  ├─ increment_vm_operation_completed_count()
  │                                  ├─ SafepointSynchronize::end()
  │                                  ├─ VMOperationRequest_lock->notify_all()
  │  ← 被唤醒 ←───────────────────  │
  ├─ ticket≤completed_count → 退出循环
  ├─ doit_epilogue()
  └─ 返回到 JVMTI agent
```

redefine 的关键不同点：`completed_count` 的递增时机在 **doit() 全部完成之后**（`evaluate_operation` → 递增 `completed_count`），而 **不是** doit_prologue 之后。这是因为 `doit_prologue()` 在 JavaThread 上执行，`evaluate_operation()` 时已经 `completed_count`，而 `doit_prologue` 在 `evaluate_operation` **之前**执行。

精确定位 `completed_count` 递增：`vmThread.cpp:436`：
```cpp
if (!op->evaluate_concurrently()) {
  op->calling_thread()->increment_vm_operation_completed_count();
}
```
此调用在 `evaluate_operation()` 的 `op->evaluate()`（调用 doit()）**之后**。

---

## §三 ★★★ doit() 内部 — modify class + 嵌套 safepoint

### 3.1 doit() 的 7 步操作

```cpp
// jvmtiRedefineClasses.cpp:183-239
void VM_RedefineClasses::doit() {
  Thread *thread = Thread::current();       // L186 — 此时是 VMThread
  HandleMark hm(thread);                    // L205 — VMThread 上的 HandleMark

  MetadataOnStackMark md_on_stack(true);     // L204 ★ Step 1: 标记栈上元数据
  for (int i = 0; i < _class_count; i++) {
    redefine_single_class(...);             // L209 ★ Step 2: 逐类替换 method table
  }

  MethodDataCleaner clean_weak_method_links; // L215 ★ Step 3: 清理 MethodData
  ClassLoaderDataGraph::classes_do(&clean_weak_method_links);  // L216

  if (_any_class_has_resolved_methods) {
    ResolvedMethodTable::adjust_method_entries(...);  // L221 ★ Step 4: 调整 JSR-292 resolved methods
  }

  JvmtiExport::set_has_redefined_a_class();  // L226 ★ Step 5: 设置全局标志

  // Step 6-7: CheckClass（调试）
  CheckClass check_class(thread);           // L234
  ClassLoaderDataGraph::classes_do(&check_class);  // L235
}
```

每一步都在 VMThread 的 safepoint 上下文中执行：
- 所有 Java 线程已停止 → 拷贝 method table 是安全的
- VMThread 上 HandleMark 保护临时 oop 不会被 GC 错误回收
- `MetadataOnStackMark` 确保正在栈上执行的方法不会被标记为 obsolete 进而被回收

对比 GC VM_Operation（`GenCollectFull::doit()`）：GC 的 doit() 也是 100% 在 VMThread+safepoint 中执行。区别是 GC 的 doit() **不需要** MetadataOnStackMark（GC 回收的是 Java 对象 heap，不是 metadata），而 redefine 修改的是 metadata（Method*、ConstantPool*），必须标记。

### 3.2 redefine_single_class() 的 method table 替换细节

```cpp
// jvmtiRedefineClasses.cpp:3970-4169+
void VM_RedefineClasses::redefine_single_class(
    jclass the_jclass, InstanceKlass* scratch_class, TRAPS) {
  // 1. 清理 breakpoints (L3983)
  jvmti_breakpoints.clearall_in_class_at_safepoint(the_class);

  // 2. 去优化依赖这个类的所有编译代码 (L3986)
  flush_dependent_code(the_class, THREAD);

  // 3. 保存旧 method table，获取新 method table (L3988-3989)
  _old_methods = the_class->methods();
  _new_methods = scratch_class->methods();

  // 4. 计算新增/删除/匹配的方法 (L3991)
  compute_added_deleted_matching_methods();

  // 5. 更新 jmethodID → 新的 Method* (L3992)
  update_jmethod_ids();

  // 6. ★★★ 核心替换 — swap method tables (L4050-4052)
  the_class->set_methods(_new_methods);          // the_class 现在指向新方法
  scratch_class->set_methods(_old_methods);      // scratch_class 持有旧方法（防止 GC）

  // 7. 替换 method_ordering (L4054-4056)
  // 8. ★★★ 替换 constant pool (L4058-4059)
  ConstantPool* old_constants = the_class->constants();
  the_class->set_constants(scratch_class->constants());
  scratch_class->set_constants(old_constants);

  // 9. 标记旧方法为 obsolete (L4098)
  check_methods_and_mark_as_obsolete();

  // 10. 重建 vtable/itable (L4135-4136)
  the_class->vtable().initialize_vtable(false, THREAD);
  the_class->itable().initialize_itable(false, THREAD);

  // 11. 替换 inner_classes, source_file, annotations, 版本号等 (L4122-L4169)
}
```

关键点：`the_class->set_methods(_new_methods)` (L4050) 是**一个指针赋值**——`the_class` 的 `_methods` 字段从指向旧 `Array<Method*>` 变为指向新 `Array<Method*>`。没有 deep copy，只是一个指针 swap。旧 array 被赋给 `scratch_class->_methods` 以防止被 GC 回收（scratch_class 在 doit_epilogue 中释放）。

### 3.3 已编译 nmethod 的处理——set_code(NULL) + 后续 flush

`flush_dependent_code()` (L3986) 是 redefine_single_class 的第一项实质操作。它处理**依赖正在被 redefine 的类的所有已编译方法**：

- **inline cache buffering** — 通过 `Klass::clean_weak_klass_links()` 清除 IC 缓存
- **deoptimize dependents** — 所有被内联为 dependency 的 nmethod → 标记为 deoptimize
- **make not entrant** — 这些 nmethod 被标记为非入口，下一次被调用时触发解释器 fallback

然而，**nmethod 的实际释放（flush）发生在 doit() 返回之后**。sweeper（NMethodSweeper）异步扫描被标记的 nmethod 并回收其 CodeBlob。这之所以安全，是因为 MetadataOnStackMark 确保正在栈上执行的方法不会被扫描。

### 3.4 ★ 嵌套 GC 的精确调用栈

redefine 过程中最关键的「aha moment」——**嵌套 GC 的发生路径**：

```
VMThread::loop()
  └→ SafepointSynchronize::begin()
      └→ evaluate_operation(cur_vm_operation)  // vmThread.cpp:571
          └→ op->evaluate()                     // vmOperations.cpp:58
              └→ VM_RedefineClasses::doit()     // jvmtiRedefineClasses.cpp:183
                  └→ redefine_single_class(...)    // :209
                      └→ the_class->set_methods(_new_methods)  // :4050
                          └→ ★ 新 method 中引用未解析的 CP entry
                      └→ the_class->vtable().initialize_vtable(...)  // :4135
                          └→ 需要访问 Metaspace 分配 KlassVtable 结构
                              └→ ★ Metaspace 不足 → 分配失败
                                  └→ 触发 GC（回收 Metaspace 中的废弃 metadata）
                                      └→ GC 需要 safepoint
                                          └→ ★ 但此时已经在 safepoint 中！
                                              └→ VMThread::execute(nested_gc_op)
                                                  // vmThread.cpp:747-779 (else 分支)
                                                  └→ 检测到已处于 safepoint
                                                      └→ 直接 op->evaluate()
                                                      （不重复 begin/end）
```

这个嵌套 GC 路径在第 §四 中详细拆解。

---

## §四 ★★★ 嵌套 VM_Operation 执行机制 — execute() 的 else 分支

### 4.1 execute() else 分支的 4 路径分支

```cpp
// vmThread.cpp:686-780
void VMThread::execute(VM_Operation* op) {
  Thread* t = Thread::current();

  if (!t->is_VM_thread()) {
    // === 路径 A: JavaThread 调用（正常入口）===
    // (Step 1-8 in §二 2.1)
    // 入队→等票→doit_prologue→doit→doit_epilogue

  } else {
    // === 路径 B: VMThread 自身调用（嵌套入口）===  ★ 关键段
    // vmThread.cpp:747-779
    assert(t->is_VM_thread(), "must be a VM thread");
    VM_Operation* prev_vm_operation = vm_operation();

    // ★ 检查 1: 外层 op 是否允许嵌套 (L751-757)
    if (prev_vm_operation != NULL) {
      if (!prev_vm_operation->allow_nested_vm_operations()) {
        fatal("Nested VM operation %s requested by operation %s",
              op->name(), vm_operation()->name());
      }
    }

    op->set_calling_thread(prev_vm_operation->calling_thread(),
                           prev_vm_operation->priority());  // L758

    HandleMark hm(t);                     // L764
    _cur_vm_operation = op;              // L765

    // ★ 分支点: op 需要 safepoint 吗？现在已在 safepoint 吗？ (L767-773)
    if (op->evaluate_at_safepoint() &&
        !SafepointSynchronize::is_at_safepoint()) {
      // ★ 路径 B1: 需要 safepoint，但不在 safepoint
      //   → 完整的 begin()+evaluate()+end()
      SafepointSynchronize::begin();
      op->evaluate();
      SafepointSynchronize::end();
    } else {
      // ★ 路径 B2: 不需要 safepoint，或已经在 safepoint
      //   → 直接 evaluate()，不重复 begin/end
      op->evaluate();
    }

    if (op->is_cheap_allocated()) delete op;  // L776
    _cur_vm_operation = prev_vm_operation;     // L778 ★ 恢复外层 op
  }
}
```

这 4 条路径的判定条件如下：

| 路径 | 当前在 safepoint? | 内层 op 需要 safepoint? | 行为 |
|---|---|---|---|
| **A (JavaThread)** | 否 | 是（_safepoint） | 入队 → 等待 VMThread 执行 |
| **B1 (嵌套，redefine → GC，不在 safepoint 时命中)** | 否 | 是 | `begin()` → `evaluate()` → `end()` |
| **B2a (嵌套，redefine → GC，典型情景)** | **是** | 是 | 直接 `evaluate()`（不重复 begin/end） |
| **B2b (嵌套，其他非 safepoint op)** | — | 否 | 直接 `evaluate()` |

**redefine 的嵌套 GC 走的正是 B2a**：已经在 VM_RedefineClasses 的 safepoint 中，GC 也需要 safepoint，但因为 safepoint 已在运行，所以**跳过 begin/end**，直接 evaluate()。

### 4.2 嵌套 GC 在 redefine 中的真实场景——Metaspace 分配失败

嵌套 GC 之所以在 redefine 中重要，是因为 redefine 触发了以下 Metaspace 分配：

1. **`ConstantPool::allocate()`** — 合并 CP 时需要分配新的 ConstantPool（`merge_cp_and_rewrite()` L1581-1584）
2. **`MetadataFactory::new_array<>()`** — 新 method table、method_ordering 等
3. **`KlassVtable::initialize_vtable()`** — 重建 vtable 结构 (`redefine_single_class` L4135)
4. **`KlassItable::initialize_itable()`** — 重建 itable 结构 (L4136)

其中第 3、4 项发生在 `redefine_single_class()` 的 **后半段**——即已经在 safepoint 中、method table 已经 swap 了一半的时候。如果此时 Metaspace 不足，**必须在此 safepoint 中完成 GC**，否则 redefine 将成为未完成状态。

对比 GC VM_Operation 的嵌套：GC **不**允许嵌套（`allow_nested_vm_operations()` 返回 `false`）。如果在 GC 中再触发 GC，会直接 `fatal()` 崩溃，因为 GC 内部不应该再触发 GC（这是 Metaspace 回收的逻辑边界）。

### 4.3 和 coalesce 的区别

嵌套（nesting）和 coalesce（合并）是两个不同概念：

| 维度 | 嵌套 (nesting) | 合并 (coalesce) |
|---|---|---|
| 触发方式 | VMThread 执行 doit() 中间，由内部代码主动调用 `VMThread::execute(nested_op)` | VMThread::loop() 中 `drain_at_safepoint_priority()` (vmThread.cpp:529) |
| 发生时机 | doit() **过程中** | doit() **之间**——两个独立的 op 一次性处理 |
| 调用关系 | 内层 op 在外层 op 的调用栈内部 | 不存在调用关系，是队列顺序处理 |
| 代码路径 | `VMThread::execute()` 的 else 分支 | `VMThread::loop()` 的 do-while 循环 |
| 示例 | redefine → Metaspace GC | N 个 JavaThread 同时提交 N 个 safepoint op |

两者可以同时发生：多个线程提交了 redefine 和 GC 请求。VMThread 通过 `drain_at_safepoint_priority()` (vmThread.cpp:574-609) 将它们合并一次 safepoint 执行。如果某个 redefine 在执行中间触发了嵌套 GC，这个 GC 则走嵌套路径。

### 4.4 allow_nested_vm_operations() 的隔离

```cpp
// vmThread.cpp:751-757
if (prev_vm_operation != NULL) {
  if (!prev_vm_operation->allow_nested_vm_operations()) {
    fatal("Nested VM operation %s requested by operation %s",
          op->name(), vm_operation()->name());
  }
}
```

这个检查的含义：**只有**明确声明 `allow_nested_vm_operations() → true` 的 VM_Operation 才能在 doit() 期间被嵌套。典型场景：

| 外层 op | allow_nested | 嵌套场景 |
|---|---|---|
| VM_RedefineClasses | true | Metaspace 不足 → CollectForMetadataAllocation |
| VM_ThreadStop | true | deoptimize top frame 可能需要 safepoint |
| VM_Deoptimize | true | make_not_entrant 后 sweeper 可能需要 safepoint |
| VM_DeoptimizeFrame | true | 类似 VM_Deoptimize |
| VM_UnlinkSymbols | true | symbols 清理可能需要 GC |
| GenCollectFull | **false** | GC 内部绝不能触发另一个 GC |

这个机制确保了**只有预知需要嵌套的 op 才能嵌套**，防止了非预期的 re-entrant safepoint 导致的数据结构损坏。

---

## §五 ★ merge_cp_and_rewrite() — Constant Pool 合并在 doit_prologue（JavaThread）中

### 5.1 合并算法概述

```cpp
// jvmtiRedefineClasses.cpp:1567-1703
jvmtiError VM_RedefineClasses::merge_cp_and_rewrite(
    InstanceKlass* the_class, InstanceKlass* scratch_class, TRAPS) {

  // 1. 分配 merge CP，长度 = old_cp.length + scratch_cp.length (L1570-1584)
  ConstantPool* merge_cp_oop = ConstantPool::allocate(loader_data,
                                                       merge_cp_length,
                                                       CHECK_(...));

  // 2. 建立 index_map：scratch_cp 的旧 index → merge_cp 的新 index (L1608-1614)
  _index_map_p = new intArray(scratch_cp->length(), scratch_cp->length(), -1);

  // 3. merge 本身 (L1618-1619)
  bool result = merge_constant_pools(old_cp, scratch_cp,
                                      &merge_cp, &merge_cp_length, THREAD);

  // 4. 如果有映射差异，重写字节码中的 CP 引用 (L1687-1688)
  if (_index_map_count > 0) {
    rewrite_cp_refs(scratch_class, THREAD);
  }

  // 5. 替换 scratch_class 的 constant pool 为 merge_cp 的缩简版 (L1695-1696)
  set_new_constant_pool(loader_data, scratch_class, merge_cp, ...);
}
```

`merge_constant_pools()` (L1362-1560) 的合并策略：
- **Pass 0**：copy old_cp → merge_cp，将 `JVM_CONSTANT_Class` 反转为 `JVM_CONSTANT_UnresolvedClass`（以使新的 verify 通过）
- **Pass 1**：遍历 scratch_cp，将 old_cp 中没有的唯一 entry **追加**到 merge_cp 末尾
- 追加过程中同步更新 `_index_map_p`（scratch_cp 的 index → merge_cp 的 index）

### 5.2 rewrite_cp_refs() 的字节码重写

```cpp
// jvmtiRedefineClasses.cpp:1707
bool VM_RedefineClasses::rewrite_cp_refs(InstanceKlass* scratch_class, TRAPS) {
  // 遍历 scratch_class 的所有 method
  //   对每个 method 的 bytecode：
  //     - 检查每条指令是否包含 CP 引用（ldc, invokevirtual, getfield 等）
  //     - 查到引用时：lookup _index_map_p → 找到 scratch_cp index 对应的 merge_cp index
  //     - 替换字节码中的 CP index 值
  // 同时重写 annotations、stack map table、verification type info 中的 CP 引用
}
```

关键点：这个重写发生在 `doit_prologue()` 阶段——即在进入 safepoint **之前**。为什么？
- 需要 `CHECK` 宏（可能抛出异常）→ 只能在 JavaThread
- 需要 ResourceArea 分配临时内存 → JVM thread 支持更好
- 字节码遍历消耗时间，不应在 safepoint（所有线程停止）中做

### 5.3 和 doit() 的 method table 替换的关系

`doit_prologue()` 中的 CP 合并和 `doit()` 中的 method table 替换是**严格解耦**的：

```
doit_prologue() (JavaThread)          doit() (VMThread, safepoint)
─────────────────────────────         ─────────────────────────────
parse class bytes                     MetadataOnStackMark
verify bytecodes                      swap method tables (指针赋值)
merge CP + rewrite CP refs            swap constant pools (指针赋值)
→ scratch_class 包含合并后的 CP       replace inner_classes
→ scratch_class 是"准备好待安装"的    rebuild vtable/itable
                                       mark old methods obsolete
                                       clean MethodData
```

`doit_prologue()` 准备好了 `scratch_class`，`doit()` 只需要做**指针 swap**——这是一个原子操作，在 safepoint 中确保其他线程看不到不一致的中间状态。

---

## §六 ★★ 和 [08-01][08-02][08-03] 的交叉验证

### 6.1 [08-03]§二 VM_Operation 基类虚函数 — 逐一对标 VM_RedefineClasses

| [08-03] 虚函数 | VM_Operation 默认实现 (vmOperations.hpp) | VM_RedefineClasses 覆写 (jvmtiRedefineClasses.hpp) | 与 GC 的异同 |
|---|---|---|---|
| `evaluation_mode()` | `_safepoint` (:195) | **不覆写**，使用默认 | GC 也不覆写（GC 在 VM_OPS_DO 模板中不声明 mode） |
| `allow_nested_vm_operations()` | `false` (:196) | **覆写** → `true` (:538) | GC 维持默认 `false` |
| `doit_prologue()` | `return true` (:181) | **覆写** → 参数校验+lock+load(:115-181) | GC 用默认空操作 |
| `doit()` | **纯虚函数** (:180) | **覆写** → 7 步操作 (:183-239) | GC 有自己的实现 |
| `doit_epilogue()` | `{}` (:182) | **覆写** → unlock+free (:241-264) | GC 用默认空操作 |
| `type()` | 纯虚 | `VMOp_RedefineClasses` (:533) | GC 对应 `VMOp_GenCollectFull` 等 |
| `is_cheap_allocated()` | `false` (:197) | **不覆写** | GC 的 `GenCollectForAllocation` 覆写为 `true` |

还记得 [08-03]§二 怎么讲 VM_Operation 虚函数表吗？GC 的 `GenCollectFull` 只覆写了 `doit()` 和几个标记位，其余全是默认行为。VM_RedefineClasses 在这里重写了 4 个虚函数——我们逐个看：`allow_nested_vm_operations()`→true（支持嵌套 GC）、`doit_prologue()`→300+ 行预处理（参数校验+锁+class 加载）、`doit()`→7 步核心操作、`doit_epilogue()`→解锁+释放。但有意思的是两者**都不覆写** `evaluation_mode()`——都走默认 `_safepoint`。这说明 `_safepoint` 模式不是 "GC 专用"，而是 "任何需要 STW 的操作" 的统一配置。

### 6.2 [08-03]§三 VMOperationQueue 入队 — redefine 的入队过程验证

```
VMOperationQueue::add()                               // vmThread.cpp:156
  → evaluate_at_safepoint() → true                   // :167
  → queue_add_back(SafepointPriority, op)            // :168  (不是 MediumPriority)

VMThread::loop()                                       // :465
  → _vm_queue->remove_next()                          // :479  → vmThread.cpp:176
    → _queue_counter 决定优先级 (Safepoint vs Medium) // :185-192
    → queue_remove_front(prio)                        // :194  → vmThread.cpp:104
```

还记得 [08-03]§三 怎么讲 VMOperationQueue 的优先级队列吗？`SafepointPriority` 和 `MediumPriority` 两个队列通过 `_queue_counter` 轮转避免饥饿。`VM_RedefineClasses` 走 `SafepointPriority`（因为 `_safepoint` 模式），和 GC 的 `GenCollectFull` 完全相同的入队优先级——再次验证 "框架不区分调用者"。

### 6.3 [08-01]§二 Safepoint begin/end — redefine 使用 begin/end 的验证

```cpp
// VMThread::loop() — 正常 safepoint 路径 (vmThread.cpp:560-618)
if (_cur_vm_operation->evaluate_at_safepoint()) {
  SafepointSynchronize::begin();                // :565
  evaluate_operation(_cur_vm_operation);         // :571 → 调用 doit()
  SafepointSynchronize::end();                  // :618
}
```

redefine 走这个路径，与 GC 完全相同——还记得 [08-01]§五 讲 VMThread 在 loop 中怎么包 safepoint 吗？`begin()` → `evaluate_operation()` → `end()` 三层嵌套，每个 safepoint 的 VM_Op 都这么过一遍。嵌套 GC 走 §四 4.1 的 B2a 路径——跳过 begin/end，因为它们已经被外层 savpoint 覆盖。

### 6.4 [09-01]§二 ThreadInVMfromNative — 调用 VMThread::execute() 前线程已进入 VM 状态

还记得 [09-01]§四 怎么讲 upcall 路径吗？JVMTI agent 调用 RedefineClasses() 进入 JVM 的过程，与 JavaThread 调用 `System.gc()` 进入 VM 的过程**完全相同**——都通过 `JVM_ENTRY` 宏（[04-JVM-Entry]§一）切换到 `_thread_in_vm` 状态，然后等待 safepoint。

唯一不同的是调用来源：GC 可以由 Java 代码（`System.gc()` → JVM_ENTRY → `GenCollectFull`）或 JVMTI（`ForceGarbageCollection`）触发；redefine 只能由 JVMTI agent 触发。但两者在 VMThread::execute() 之后的路径完全一致。

---

## §七 GDB 验证 + 可证伪断言

### GDB 验证点

| # | 验证点 | 断点位置 | 预期观察 |
|---|---|---|---|
| 1 | `evaluation_mode()` 返回 `_safepoint` | `vmOperations.hpp:195` 或 `VM_RedefineClasses::doit()` 内打印 `this->evaluation_mode()` | 值为 `_safepoint` (0) |
| 2 | `allow_nested_vm_operations()` 返回 `true` | `vmThread.cpp:754` 条件判断处 | `prev_vm_operation->allow_nested_vm_operations()` 为 true 时进入，否则 `fatal()` |
| 3 | 入队队列为 `SafepointPriority` | `vmThread.cpp:167-168` | `evaluate_at_safepoint()` 为 true → `queue_add_back(SafepointPriority, op)` |
| 4 | `doit_prologue()` 在 **JavaThread** 上执行 | `jvmtiRedefineClasses.cpp:115` 入口 | `Thread::current()->is_Java_thread()` 为 true |
| 5 | `doit()` 在 **VMThread** 上执行 | `jvmtiRedefineClasses.cpp:183` 入口 | `Thread::current()->is_VM_thread()` 为 true |
| 6 | GC 嵌套路径跳过 begin/end | `vmThread.cpp:767-773` | `is_at_safepoint()` 为 true，走 `else` 分支直接 evaluate() |
| 7 | `doit_epilogue()` 回到 **JavaThread** | `jvmtiRedefineClasses.cpp:241` 入口 | `Thread::current()->is_Java_thread()` 为 true |
| 8 | nested op 完成后恢复外层 op | `vmThread.cpp:778` | `_cur_vm_operation == prev_vm_operation` |

### 可证伪断言（≥12 条）

**断言 1**：`VM_RedefineClasses::evaluation_mode()` 返回 `_safepoint`，因为该类**不覆写**此虚函数（`jvmtiRedefineClasses.hpp:533-538` 中无此声明）。

**断言 2**：`VM_RedefineClasses::allow_nested_vm_operations()` 返回 `true`（`jvmtiRedefineClasses.hpp:538`），而基类默认返回 `false`（`vmOperations.hpp:196`）。

**证伪方法**：在 `vmThread.cpp:754` 处对 redefine 断点，`allow_nested` 必须为 true，否则执行 `fatal()`。

**断言 3**：`doit_prologue()` 中 `lock_classes()`（`jvmtiRedefineClasses.cpp:153`）使用了 `RedefineClasses_lock` 和 `wait()`，证明 doit_prologue 允许阻塞等待——这在 doit() 中绝对不可能（safepoint 中不能阻塞）（`jvmtiRedefineClasses.cpp:85-103`）。

**断 4**：`load_new_class_versions()` 在第 1159 行调用 `SystemDictionary::parse_stream()`，该函数需要 JavaThread 执行——如果 VMThread 调用它会导致崩溃。

**证伪方法**：在 `load_new_class_versions()` 入口 `assert(THREAD->is_Java_thread())`——如果 THREAD 是 VMThread 则立即 abort。

**断言 5**：`doit()` 在第 204 行创建 `MetadataOnStackMark md_on_stack(true)`——与 [08] GC 的关键区别是 GC 不需要此标记，因为 GC 不修改 metadata。

**断言 6**：`redefine_single_class()` 在第 4050 行执行 `the_class->set_methods(_new_methods)`——这是一个指针赋值而非 deep copy。旧 method table 被赋给 scratch_class（L4051）防止 GC。

**断言 7**：嵌套 GC 路径中，外层 op 的 `allow_nested_vm_operations()` 必须为 true，否则在 `vmThread.cpp:755` 处触发 `fatal()`。

**证伪方法**：修改 `VM_RedefineClasses::allow_nested` 返回 false，触发 Metaspace GC，观察 `fatal()` 日志。

**断言 8**：当嵌套 VM_Operation 发生时，如果当前已在 safepoint 且内层 op 也需要 safepoint，则走 `vmThread.cpp:771-772` 的 else 分支——跳过 `begin()/end()` 直接 `evaluate()`。

**断言 9**：`doit_epilogue()`（`jvmtiRedefineClasses.cpp:241-264`）在 JavaThread 上运行——不是 VMThread。

**证伪方法**：在 `doit_epilogue()` 入口调用 `assert(Thread::current()->is_Java_thread())`。

**断言 10**：`merge_cp_and_rewrite()` 在第 1581-1584 行分配 merge CP（`ConstantPool::allocate()`）——如果此分配发生在 safepoint 中（由 VMThread 执行），可能导致非预期的 Metaspace 分配不触发 GC（safepoint 中的 Metaspace 分配有特殊处理）。

**断言 11**：`apply_cp_refs()` 用 `_index_map_p` 映射 scratch_cp index → merge_cp index——如果任何 CP 引用未被正确重写（即 `_index_map_p` 中有遗漏），则字节码执行时会解析到错误的 CP entry → 方法行为异常。

**证伪方法**：构造一个包含 ldc/getfield/invokevirtual 的方法，redefine 后比较执行结果。

**断言 12**：`VMThread::execute()` 在第 436 行递增 `completed_count` 的时机在 **doit() 全部完成之后**——调用 do_epilogue 的调用方在 vmThread.cpp:745，此时 `completed_count` 已经被递增。

**断言 13**：`VM_RedefineClasses` 的静态字段（`_old_methods`, `_new_methods` 等）是线程安全的，因为它们只在 VMThread 的 safepoint 中被写入（`doit()` 入口在第 183 行，`Thread::current()` 是 VMThread）。

**断言 14**：`JvmtiEnv::RetransformClasses()` 和 `JvmtiEnv::RedefineClasses()` 共享相同的 `VM_RedefineClasses` 类——区别仅在于 `_class_load_kind`（`jvmti_class_load_kind_retransform` vs `jvmti_class_load_kind_redefine`）和 class bytes 来源（反编译 vs 用户提供）（`jvmtiEnv.cpp:448` vs `:459`）。

---

## §八 总结

`VM_RedefineClasses` 完全遵循了 VM_Operation 框架的所有机制点。与 GC VM_Operation 的对比总结：

| 框架机制点 | GC (GenCollectFull) | RedefineClasses | 框架一致性 |
|---|---|---|---|
| `evaluation_mode()` | `_safepoint` (默认) | `_safepoint` (默认) | ✓ 完全一致 |
| 入队 `VMOperationQueue` | `add()` → `SafepointPriority` | `add()` → `SafepointPriority` | ✓ 完全一致 |
| VMThread::loop() 出队 | `remove_next()` → `evaluate_operation()` | 同左 | ✓ 完全一致 |
| `SafepointSynchronize::begin/end` | loop 中 begin→evaluate→end | 同左 | ✓ 完全一致 |
| `doit_prologue()` | 默认 `true` (空操作) | 重写（参数校验、锁、class 加载） | 框架支持差异，但调用时机一致 |
| `doit()` | GC 回收 | method table swap + CP swap | 内容不同，但执行上下文一致（VMThread+safepoint） |
| `doit_epilogue()` | 默认 `{}` (空操作) | 重写（解锁、释放内存） | 框架支持差异，但调用时机一致 |
| `allow_nested` | `false` | **`true`** | 允许差异——redfine 需要嵌套 GC |
| ticket + 等票 | ticket → wait → completed_count | 完全一致 | ✓ 完全一致 |
| `VMOperationRequest_lock` | 阻塞等待 | 完全一致 | ✓ 完全一致 |

**核心结论**：VM_RedefineClasses 不是特殊的、绕过框架的 API——它**完全**通过 VM_Operation 框架完成。它与 GC VM_Operation 的区别仅在 `doit_prologue()` 内容和 `allow_nested_vm_operations()=true` 两个覆写上，其余所有环节（入队、等票、safepoint begin/end、嵌套 GC 路径、completed_count 递增、epilogue 后的恢复）都与 [08-01][08-02][08-03] 中学习的 GC 路径完全相同。这就是 VM_Operation 框架的普适性。
