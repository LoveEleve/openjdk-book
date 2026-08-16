# 02. 怎么不重启 JVM 替换一个类的字节码？— RedefineClasses

> **前置依赖**:[28-jvmti/01 — JVMTI Agent 怎么工作？— Agent 架构与事件系统](openjdk/vol-02/28-jvmti/01-agent-architecture.md):env/capability(44 位、四集合、`can_redefine_classes` 在 always 集)/事件系统/函数表接口已拆;[08-interpreter/04 — 符号引用怎么变成直接引用？— LinkResolver + Rewriter](openjdk/vol-02/08-interpreter/04-linkresolver-rewriter.md):常量池/cpCache 与 Rewriter 重写的先例;[13-jit-framework/01 — 谁决定编译、怎么排队、谁执行？— CompileBroker 编译队列](openjdk/vol-02/13-jit-framework/01-compile-broker-queue.md):nmethod 生命周期与失效语义;[24-frame/03 — deopt 怎么从编译帧重建解释器帧？— Deopt 重建 + GC 扫描](openjdk/vol-02/24-frame/03-deopt-gc-scan.md):deopt 重建帧的机制
> → **后续**:[03-auxiliary — JVMTI 辅助设施](03-auxiliary.md)
> 关联域: 28-jvmti(接口层)、07-classfile-classloader(类解析)、13-jit(编译失效)、24-frame(deopt)、27-jni(jmethodID)

## 生产环境不想重启

线上出了 bug,修好代码重新部署要重启 JVM——几十 GB 的堆、几十分钟的启动、一堆长连接,重启的代价很大。JVMTI 的 `RedefineClasses` 让你**在运行中替换一个类的字节码**: 旧方法的调用者继续工作,新代码对后续调用生效。本篇拆这个"原地换类"的机制——它不是一个函数,而是一个**三阶段的 VM 操作**(解析在 Java 线程、安装在 VM 线程 safepoint),加上常量池合并、字节码重写、方法等价比较、编译代码失效、旧版本追踪五件配套工作。

## 1. 全景: 一个 VM 操作的三阶段

`JvmtiEnv::RedefineClasses`(jvmtiEnv.cpp:457-462)把参数直接包装成 `VM_RedefineClasses` 交给 VMThread:

```cpp
// jvmtiEnv.cpp:456-462(截取核心,逐字)
jvmtiError
JvmtiEnv::RedefineClasses(jint class_count, const jvmtiClassDefinition* class_definitions) {
//TODO: add locking
  VM_RedefineClasses op(class_count, class_definitions, jvmti_class_load_kind_redefine);
  VMThread::execute(&op);
  return (op.check_error());
} /* end RedefineClasses */
```

为什么必须是 VM 操作? **重定义要在 safepoint 里改共享的 InstanceKlass**,而且解析新类(会加载别的类、跑字节码验证)不能在 safepoint 里做——所以三阶段分工(jvmtiRedefineClasses.hpp:58-99 的权威注释):

| 阶段 | 执行者 | 干什么 |
|---|---|---|
| `doit_prologue()`(:117-183) | **JavaThread**(去 safepoint 路上) | 参数校验 → `load_new_class_versions`(:1116): **解析 scratch_class(用被改类的 loader 与保护域)** → link → 有效性检查 → 字节码验证 → **合并常量池+重写字节码** → Rewriter 建 cpCache → 存到实例字段 |
| `doit()`(:185-240) | **VMThread(safepoint 内)** | 逐类 `redefine_single_class`(:3926): 清 breakpoints → **失效依赖编译代码** → 方法三分类 → **与 scratch_class 互换 methods/常量池等** → 标记 obsolete/EMCP → 重建 vtable/itable → 登记 previous version;然后全堆调整(AdjustAndCleanMetadata + ResolvedMethodTable) |
| `doit_epilogue()`(:242-265) | JavaThread | 解锁、释放 `_scratch_classes`、打计时日志 |

*关键设计: "解析"与"安装"分离。解析要跑验证器、可能要加载别的类、可能抛异常——必须在一个普通 Java 线程上做(注释 "A JavaThread must do the above work");安装要原子地改堆内结构——必须在 safepoint 里做。两半之间用 VM 操作的实例字段传 scratch_class。*

## 2. doit_prologue — 解析"新"类

### 2.1 同一个类加载器,同一个名字

`load_new_class_versions`(jvmtiRedefineClasses.cpp:1116-1312)对每个要改的类:

```cpp
// jvmtiRedefineClasses.cpp:1147-1167(截取核心,逐字)
    ClassFileStream st((u1*)_class_defs[i].class_bytes,
                       _class_defs[i].class_byte_count,
                       "__VM_RedefineClasses__",
                       ClassFileStream::verify);

    // Parse the stream.
    Handle the_class_loader(THREAD, the_class->class_loader());
    Handle protection_domain(THREAD, the_class->protection_domain());
    // Set redefined class handle in JvmtiThreadState class.
    // This redefined class is sent to agent event handler for class file
    // load hook event.
    state->set_class_being_redefined(the_class, _class_load_kind);

    InstanceKlass* scratch_class = SystemDictionary::parse_stream(
                                                      the_class_sym,
                                                      the_class_loader,
                                                      protection_domain,
                                                      &st,
                                                      THREAD);
    // Clear class_being_redefined just to be sure.
    state->clear_class_being_redefined();
```

三个要点: ①`parse_stream` 用的**就是被改类的 loader 和保护域**——新类与旧类在同一个加载器里,这也是"为什么类名不能变"的根源;②`class_being_redefined` 记在线程状态里——**重定义的解析路径也会触发 ClassFileLoadHook 事件**(klassFactory.cpp:110-160 的 `check_class_file_load_hook`: 解析任何类前查线程的 `get_class_being_redefined()`,非空则把原类缓存的字节作为 `cached_class_file` 传给 agent——agent 可以在 redefine 过程中再改一次字节码);③`__VM_RedefineClasses__` 是伪文件名(仅日志用)。

解析后的步骤(:1197-1305): 未链接则 `link_class` → **`compare_and_normalize_class_versions`**(:776)做有效性检查 → `Verifier::verify`(:1242,字节码验证,失败→`JVMTI_ERROR_FAILS_VERIFICATION`)→ **`merge_cp_and_rewrite`**(:1258,§3)→ `Rewriter::rewrite`+`link_methods`(:1291-1294,cpCache 建立,08-interpreter/04 的机制复用)。

### 2.2 schema 冻结: 方法集必须完全一致

`compare_and_normalize_class_versions` 强制"新类与旧类的**方法集合完全一致**"——同 name+同 signature 一一对应,多余或缺失都拒绝:

[实证](materials/commands/28-jvmti-redefine-demo.txt)(素材 E): v2 少了 `<clinit>`(static 块)与 native 声明 → **67 (UNSUPPORTED_REDEFINITION_METHOD_DELETED)**;v3 加了 `brandNew()` → **63 (UNSUPPORTED_REDEFINITION_METHOD_ADDED)**(jvmti.h:365/:369)。方法**体**可以随便改(→obsolete,§4/§5),但**方法集**(以及字段/修饰符/继承结构)在 JDK11 一律冻结——这是 HotSwap 语义的核心约束: 所有现有调用点(jmethodID、vtable 槽、编译代码里的调用)的位置都不能变。

*关键设计: 为什么只能改方法体?因为"位置不变"是热替换可行性的基础。jmethodID 在 27-jni/03 拆过——它指向 Method;vtable 槽位、编译代码里的直接调用都假设方法集合稳定。加/删方法会让所有现存引用错位,所以宁可拒绝。*

## 3. 常量池合并 — 两个池合成一个

### 3.1 为什么不能直接换池

最直觉的做法: 把 scratch_class 的常量池直接装进 the_class。**不行**——旧方法可能还在栈上执行,它们的字节码引用的是**旧常量池的索引**。所以必须**合并**: 新池 = 旧池 ∪ 新池,旧索引保持有效,新索引追加(jvmtiRedefineClasses.hpp:102-109 的注释原文 "we cannot just replace the constant pool in the_class with the constant pool from scratch_class because that could confuse obsolete methods that may still be running")。

合并的单元是条目。注释把 11 种条目分成三类(:118-131):

```
Direct(直接):          JVM_CONSTANT_{Double,Float,Integer,Long,Utf8}      ← 只含数据
Indirect(间接):        JVM_CONSTANT_{Class,NameAndType,String}            ← 引用 1-2 个 Direct
Double-indirect(双重): JVM_CONSTANT_{Fieldref,Methodref,InterfaceMethodref} ← 引用 2 个 Indirect
```

### 3.2 合并算法: 复制旧池 + 追加新条目 + 映射

`merge_constant_pools`(jvmtiRedefineClasses.cpp:1363-1545)两段式: **Pass 0 把旧池整体复制到合并池**(索引原样保留,只有 `JVM_CONSTANT_Class` 回退成 `UnresolvedClass`——注释 "this means that any code using old_cp does not have to change";这也是"旧索引保持有效"的机制落点);**Pass 1+ 按索引顺序走 scratch 池**: 条目已在合并池里(比较=逐层解引用比数据,注释算了 Fieldref 要 16 次解引用,:170-174)→ 跳过;不在 → `append_entry`(:296)追加(间接条目先递归追加被引用项)。**新旧索引不同 → 记入 `_index_map_p` 索引映射表**(`map_index` :1317)。

`merge_cp_and_rewrite`(:1568-1704)收尾——**映射表非空就必须重写字节码里的索引**:

```cpp
// jvmtiRedefineClasses.cpp:1636-1701(截取核心,逐字)
  if (_index_map_count == 0) {
    // there is nothing to map between the new and merged constant pools
    ...
      // Replace the new constant pool with a shrunken copy of the
      // merged constant pool
      set_new_constant_pool(loader_data, scratch_class, merge_cp, merge_cp_length,
                            CHECK_(JVMTI_ERROR_OUT_OF_MEMORY));
    ...
  } else {
    ...
    // We have entries mapped between the new and merged constant pools
    // so we have to rewrite some constant pool references.
    if (!rewrite_cp_refs(scratch_class, THREAD)) {
      return JVMTI_ERROR_INTERNAL;
    }
    ...
    set_new_constant_pool(loader_data, scratch_class, merge_cp, merge_cp_length,
                          CHECK_(JVMTI_ERROR_OUT_OF_MEMORY));
  }
```

`rewrite_cp_refs`(:1708-1799)重写范围: nest 属性、**方法字节码**(`rewrite_cp_refs_in_methods` :1816→`rewrite_cp_refs_in_method` :1853)、类/字段/方法的注解(含类型注解)、stack map、source_file_name/generic_signature 索引。方法字节码的重写=大纲里"relocator"的职责,但主角不是它: **CP 索引重写是 `rewrite_cp_refs_in_method` 逐字节码扫描完成的**(凡带 CP 索引的指令(ldc/ldc_w/field/invoke 系)把索引换成合并池里的新索引,代码注释 "This code was adapted from Rewriter::rewrite_method()");**只有索引超过 255 需要把 2 字节的 `ldc` 换成 3 字节的 `ldc_w` 时,才调用 `Relocator` 插入字节空间**(runtime/relocator.hpp:45 `insert_space_at` :48,注释 "ldc is 2 bytes and ldc_w is 3 bytes",:1914-1919)——relocator.cpp(780 行)在 share/runtime/ 不在 prims,且只是字节码空间调整工具。

[实证](materials/commands/28-jvmti-redefine-demo.txt)(素材 B): 用 v1 的**原字节**重定义自己 → `merge_cp_len=143, index_map_len=0`——新旧池完全等价,零映射,跳过重写。

## 4. MethodComparator — 方法"变没变"的判定

方法被互换后(§5),每个旧方法要定级: **EMCP 还是 obsolete**。判定器是 `MethodComparator`(methodComparator.hpp:33-54):

```cpp
// methodComparator.cpp:40-69(截取核心,逐字)
bool MethodComparator::methods_EMCP(Method* old_method, Method* new_method) {
  if (old_method->code_size() != new_method->code_size())
    return false;
  if (check_stack_and_locals_size(old_method, new_method) != 0) {
    ...
    return false;
  }

  _old_cp = old_method->constants();
  _new_cp = new_method->constants();
  BytecodeStream s_old(old_method);
  BytecodeStream s_new(new_method);
  _s_old = &s_old;
  _s_new = &s_new;
  Bytecodes::Code c_old, c_new;

  while ((c_old = s_old.next()) >= 0) {
    if ((c_new = s_new.next()) < 0 || c_old != c_new)
      return false;

    if (! args_same(c_old, c_new))
      return false;
  }
  return true;
}
```

EMCP(Equivalent Method, Constant Pool)的定义——类头注释: "two versions of the same method are EMCP, if they don't differ on the source code level. Practically, we check whether the only difference between method versions is some constantpool indices embedded into the bytecodes, and whether these indices eventually point to the same constants"——**字节码必须逐条相同,CP 索引可以不同但指向的常量必须相同**。所以:

- 前置检查: code_size 相同 + max_stack/max_locals/参数个数相同(`check_stack_and_locals_size` :316-324);
- **逐字节码比较**: opcode 不同即失败;
- **操作数按类型处理**(`args_same` :71-264): 带 CP 索引的指令(new/checkcast/instanceof/getstatic/putfield/invoke 系/ldc 系)比**索引指向的常量**(klass/name/signature/常量值,`pool_constants_same` :266 递归比);**分支指令(`goto`/`if*`)比偏移量本身**;bipush/sipush/iinc/load/store 比操作数。

大纲说"branch 指令: 比较 jump target 对应的 bytecode 是否相同"——**错**: 真实实现比较**偏移量相等**(`get_offset_s2(c_old) != get_offset_s2(c_new)`)——跳得一样远就行,不比较目标字节码。

*关键设计: 比较的目标不是"语义相同"(不可判定),而是"**能不能保留旧结构**"。EMCP 判定通过 → 旧方法不必作废: jmethodID 新旧共享(§5.4 的重定向机制)、断点通用、栈上旧帧继续跑——这是热替换性能友好的核心。判定失败 → 方法 obsolete(§5)。*

## 5. doit — 安装与失效

### 5.1 redefine_single_class: 互换 + 标记 + 重建

safepoint 里逐类安装(`redefine_single_class`,jvmtiRedefineClasses.cpp:3926-4186):

```
① 清 breakpoints(:3940-3942)
② flush_dependent_code(:3944,§5.2)
③ 方法三分类: compute_added_deleted_matching_methods(:3843,双游标归并
   按 name+signature 排序的方法数组 → matching/added/deleted)
④ update_jmethod_ids(:3511): matching 旧方法的 jmethodID → 指向新方法;
   deleted 的 → 指向 NSME(NoSuchMethodError 哨兵)
⑤ 互换(:4008-4019):
   the_class->set_methods(新方法数组);scratch_class->set_methods(旧数组)(防 GC+可回滚)
   the_class->set_constants(新池);scratch_class->set_constants(旧池)
   method_ordering/inner_classes 同样互换
⑥ check_methods_and_mark_as_obsolete(:3534,§4 的定级落点)
⑦ transfer_old_native_function_registrations(:3798): native 方法注册(含前缀)迁移
⑧ 重建 vtable/itable(:4085-4097): the_class->vtable().initialize_vtable(...)
⑨ 属性替换: source_file_name/source_debug_extension/annotations/minor-major
   version/enclosing_method/fingerprint(:4101-4147)
⑩ the_class->set_has_been_redefined();add_previous_version(:4159,§5.3)
⑪ oop_map_cache 清 obsolete 引用(:4166-4170);日志 "redefined name=..., count=N"(:4177-4179)
```

方法定级(`check_methods_and_mark_as_obsolete`,:3534-3668): EMCP 的旧方法 **`set_is_old()` 但不 obsolete**——同 jmethodID,断点对所有版本通用(注释 :3613-3619);不 EMCP 的 **`set_is_obsolete()`** + 分配新 method_idnum(obsolete 方法在 jmethodID 缓存里占新条目);deleted 方法三标全打(is_deleted+is_old+is_obsolete)。**Method 的 is_old/is_obsolete/is_deleted 是 access_flags 的位**(method.hpp:761-766)。

*关键设计: 交换而非复制。the_class 与 scratch_class 互换整个 methods/constants 数组——旧结构被"存"进 scratch_class 里,既防止 GC 回收仍在栈上执行的旧方法,又便于错误回滚;obsolete 方法由 constant_pool 的 on_stack 标记决定何时真正释放(§5.3)。*

### 5.2 编译代码失效: 只动依赖者

`flush_dependent_code`(jvmtiRedefineClasses.cpp:3819-3842)处理"栈上/缓存里的编译代码"——它们编译时基于旧字节码的假设(内联、类型画像、方法内的方法体)全部作废:

```cpp
// jvmtiRedefineClasses.cpp:3819-3841(截取核心,逐字)
void VM_RedefineClasses::flush_dependent_code(InstanceKlass* ik, TRAPS) {
  assert_locked_or_safepoint(Compile_lock);

  // All dependencies have been recorded from startup or this is a second or
  // subsequent use of RedefineClasses
  if (JvmtiExport::all_dependencies_are_recorded()) {
    CodeCache::flush_evol_dependents_on(ik);
  } else {
    CodeCache::mark_all_nmethods_for_deoptimization();
    ...
    // Make the dependent methods not entrant
    CodeCache::make_marked_nmethods_not_entrant();

    // From now on we know that the dependency information is complete
    JvmtiExport::set_all_dependencies_are_recorded(true);
  }
}
```

两条路: **依赖已记录**(can_redefine_classes 在 ONLOAD 声明过 → 编译器从启动就登记依赖,jvmtiManageCapabilities.cpp:323-328)→ `flush_evol_dependents_on`(codeCache.cpp:1292)只失效**依赖该类进化**的 nmethod(mark_for_evol_deoptimization → deoptimize_dependents → make_marked_nmethods_not_entrant);否则首次退化为全量失效并从此记录依赖。

[实证](materials/commands/28-jvmti-redefine-demo.txt)(素材 C): main 热循环 1.5s 让 `sayHello` 被 C1 level 1 编译、`main` level 3 编译;redefine 时刻两个 nmethod **同刻 made not entrant**——且只有这两个(启动期编译的 `Object::<init>` 等不受影响),**精确失效**的证据。此后调用重新走解释器/重新编译,新字节码生效。

### 5.3 旧版本追踪: previous versions 链

obsolete 方法可能还在栈上执行——不能立即释放。`add_previous_version`(instanceKlass.cpp:3901-3957)把 scratch_class(装着旧 methods/旧池)挂到 InstanceKlass 的 `_previous_versions` 链上,关键判定是**常量池是否 on_stack**:

```cpp
// instanceKlass.cpp:3901-3954(截取核心,逐字)
void InstanceKlass::add_previous_version(InstanceKlass* scratch_class,
                                         int emcp_method_count) {
  ...
  // If the constant pool for this previous version of the class
  // is not marked as being on the stack, then none of the methods
  // in this previous version of the class are on the stack so
  // we don't need to add this as a previous version.
  ConstantPool* cp_ref = scratch_class->constants();
  if (!cp_ref->on_stack()) {
    log_trace(redefine, class, iklass, add)("scratch class not added; no methods are running");
    ...
    scratch_class->class_loader_data()->add_to_deallocate_list(scratch_class);
    return;
  }
  ...
  // Add previous version if any methods are still running.
```

`on_stack` 是 ConstantPool 的一个位(constantPool.hpp:198),由 redefine 时的 **metadata 标记**(`MetadataOnStackMark`,jvmtiRedefineClasses.cpp:204)统一设置——safepoint 里把**栈上执行中的方法、CodeCache 里的 nmethod、编译队列、断点引用的方法**全部标 on_stack(metadataOnStackMark.cpp:48-73,类头注释 "so that it can't be deleted during class redefinition")。每次 redefine 先 `purge_previous_version_list`(instanceKlass.cpp:3747): 遍历链,**池不在栈上的版本 → 解链 + 清 jmethodID + 进 ClassLoaderData 的 deallocate 列表**(类卸载时真正释放)。

[实证](materials/commands/28-jvmti-redefine-demo.txt)(素材 D): 连续 redefine 两次——第二次时 `previous version ... is alive`(v2 版本: v2 的 main 正在跑);程序退出前 GC 后 `previous version ... is dead.`(某版本池不在栈上)→ 解链+deallocate。

### 5.4 全堆调整与 jmethodID

doit 的最后三件事(:212-227): **AdjustAndCleanMetadata**(遍历 ClassLoaderDataGraph,调整其他类里指向旧方法的 cpCache/vtable 引用)、**`ResolvedMethodTable::adjust_method_entries`**(resolvedMethodTable.cpp:204-235,safepoint 里把方法句柄的 vmtarget 从旧方法换成新方法,deleted 的换 NSME——JSR-292 支持)、`JvmtiExport::set_has_redefined_a_class()`(通知全 VM"类被改过",后续反优化等策略以此为据)。

jmethodID 的语义(27-jni/03 的 8 维度校验还记着): **matching 方法的已分发 jmethodID 被重定向到新方法**(`update_jmethod_ids` :3511-3533 的 `Method::change_method_associated_with_jmethod_id`)——EMCP 版本由此共享同一 jmethodID、断点对所有版本通用(注释 :3613-3619 "An EMCP method has the same jmethodID as the current method");**obsolete 方法被分配新的 method_idnum**(:3627-3631,与当前方法不同 id,未来 jmethodID 缓存新条目);**deleted 方法的 jmethodID 指向 `Universe::throw_no_such_method_error()`**——已持有旧 id 的代码后续解析得到 NSME。

## 6. 实证: 一次完整热替换

[实证](materials/commands/28-jvmti-redefine-demo.txt): 自写 agent + Java 侧 native 方法调 `RedefineClasses`(素材 A),三个观察窗: ①`-Xlog:redefine+class+obsolete+mark=trace`——改 `sayHello`/`extra`/`main` 方法体后 `mark ... as obsolete` ×3 + `EMCP_cnt=4, obsolete_cnt=3`(native 声明与 static 块等价);②`-Xlog:redefine+class+load=info`——`redefined name=HotSwapDemo, count=1`;③`-Xlog:redefine+class+timer=info`——`vm_op: all=1 prologue=0 doit=1`,`redefine_single_class: phase1=1 phase2=0`(本机 safepoint 内安装 1ms)。重定义后 `sayHello()="hello-v2-CHANGED"`、`extra()=42` 立即生效;ClassFileLoadHook 回调在 redefine 的解析路径也触发(`redefining=YES`,§2.1 的 `class_being_redefined` 机制)。

## 核心悬念

热替换链路全通: **三阶段 VM 操作**(JavaThread 解析/VMThread 安装)、**schema 冻结**(方法集必须一致,否则 63/67 拒绝)、**常量池合并**(三类条目+索引映射+字节码重写,relocator.cpp 只是空间调整配角)、**EMCP 判定**(逐字节码+索引所指常量等价)、**安装**(互换 methods/池+标记 obsolete+重建 vtable)、**编译失效**(依赖精确失效 made not entrant)、**旧版本追踪**(on_stack 决定 previous version 生死)。——但有两个辅助机制藏在角落: 重定义**没改**的类,agent 怎么拿到它的字节码(RetransformClasses 的 `JvmtiClassFileReconstituter`)?JVMTI 还能给对象打 tag、遍历堆——下一篇: 辅助设施。

> → [03-auxiliary — JVMTI 辅助设施](03-auxiliary.md)
