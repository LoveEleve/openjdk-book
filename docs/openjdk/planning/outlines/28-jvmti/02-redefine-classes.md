# 02. 怎么不重启 JVM 替换一个类的字节码？— RedefineClasses

> 🔴 Deep | 2 KP 中的类热更新
> 读者处境: 生产环境出 bug——不想重启 JVM。JVMTI RedefineClasses 允许运行时替换字节码: parse new class→merge constant_pool→失效旧 nmethod→重新编译新方法。

### 1. "RedefineClasses — 全流程"
> ⚠️ 写作期修正(2026-08-16, vol-02/28-jvmti/02 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **"jvmtiRedefineClasses.cpp:200-800" 行号全错(重要)**: 文件 **4338 行**;核心函数: doit_prologue :117/doit :185/doit_epilogue :242/is_modifiable_class :267/compare_and_normalize_class_versions :776/load_new_class_versions :1116/merge_constant_pools :1363/merge_cp_and_rewrite :1568/rewrite_cp_refs :1708/rewrite_cp_refs_in_methods :1816/rewrite_cp_refs_in_method :1853/update_jmethod_ids :3511/check_methods_and_mark_as_obsolete :3534/flush_dependent_code :3819/compute_added_deleted_matching_methods :3843/redefine_single_class :3926
> - **缺三阶段 VM 操作骨架(重要)**: 真实=VM_RedefineClasses 三阶段(jvmtiRedefineClasses.hpp:58-99 权威注释): ①doit_prologue(JavaThread, 去 safepoint 路上)=参数校验+load_new_class_versions(解析 scratch_class/verify/合并池/重写字节码/Rewriter)——注释 "A JavaThread must do the above work";②doit(VMThread safepoint)=redefine_single_class(清 breakpoints/flush_dependent_code/三分类/互换 methods+常量池/标 obsolete/重建 vtable)+AdjustAndCleanMetadata+ResolvedMethodTable::adjust_method_entries+set_has_redefined_a_class;③doit_epilogue=清理
> - **"ClassFileParser re-parse" 简化**: 真实=SystemDictionary::parse_stream(the_class_sym, **the_class 的 loader+保护域**)(:1147-1167)——同一加载器,类名不变根源;解析路径经 class_being_redefined 也触发 ClassFileLoadHook(klassFactory.cpp:110-160)
> - **"replace vtable entries" 错**: 真实=互换 methods/常量池后 **vtable/itable 整体重建**(initialize_vtable/initialize_itable :4085-4097);互换语义=the_class->set_methods(新)/scratch_class->set_methods(旧)(防 GC 旧方法+可回滚 :4008-4019)
> - **"通知 agent CLASS_FILE_LOAD_HOOK event" 半对**: 事件在**解析路径**触发(load_new_class_versions 设 class_being_redefined);不是安装后单独通知
> - **EMCP vs obsolete(大纲漏,核心)**: MethodComparator::methods_EMCP 判"字节码逐条相同+CP 索引所指常量相同"(索引可不同);EMCP=is_old 不 obsolete(同 jmethodID,断点通用)/不 EMCP=set_is_obsolete+新 idnum/deleted 三标全打;update_jmethod_ids 把 matching 已分发 jmethodID 重定向新方法,deleted→NSME
> - **schema 冻结(实证)**: 方法集必须完全一致——加方法→63 METHOD_ADDED/删方法→67 METHOD_DELETED(jvmti.h:365/:369);字段/修饰符/继承结构也查(compare_and_normalize :776)

场景: agent 传 new class bytes→JVM 替换旧类的所有实例(metamorposis)。

**RedefineClasses 流程** (`jvmtiRedefineClasses.cpp:200-800`):
```
1. ClassFileParser re-parse new class bytes
2. compare old vs new constant_pool(merge identical entries, add new entries)
3. MethodComparator: 逐字节码比较每个方法
   - 字节码完全一致→方法保留(keep nmethod)
   - 字节码不同→方法需要新版本(need new compilation)
4. 更新 InstanceKlass:
   - replace vtable entries(新方法入口)
   - replace itable entries(接口方法)
5. 失效旧 nmethod (make_not_entrant) — GC 清理
6. 通知 agent: CLASS_FILE_LOAD_HOOK event
```
- 源码: `jvmtiRedefineClasses.cpp:200-800` + `methodComparator.cpp:40-200`
- 关键设计: 不是重新创建一个新 java.lang.Class 实例——而是**原地替换**旧 InstanceKlass 的 metadata。所有现有的 oop/引用仍然有效——它们指向的 class 对象不变——但 class 的 method/vtable/constant pool 已更新
- [C++: `ClassFileParser` parse new class 和旧 class 在同一个类加载器中→new InstanceKlass→merge旧InstanceKlass 的 annotations/fields→替换旧Klass的vtable。所有旧编译的方法→mark not_entrant→CompileBroker 收到通知可能重新编译新方法]

### 2. "MethodComparator — 旧方法≈新方法？"
> ⚠️ 写作期修正(2026-08-16, vol-02/28-jvmti/02 已按真实源码成文):
> - **"branch 指令: 比较 jump target 对应的 bytecode 是否相同" 错**: 真实=比较**偏移量相等**(methodComparator.cpp args_same :71-264,get_offset_s2(c_old) != get_offset_s2(c_new))——跳得一样远即可,不比目标字节码
> - **行号**: methods_EMCP :40/args_same :71/pool_constants_same :266/check_stack_and_locals_size :316;methodComparator.hpp 55 行,class :35
> - **判定细节**: 前置=code_size 相同+max_stack/max_locals/参数个数相同;带 CP 索引指令(new/checkcast/instanceof/field/invoke/ldc 系)比**索引所指常量**(pool_constants_same 递归);bipush/sipush/iinc/load/store 比操作数;EMCP 定义(类头注释)="only difference is constantpool indices...point to the same constants"
> - **EMCP 语义**: 旧方法 set_is_old 不 obsolete(同 jmethodID,断点通用,注释 :3613-3619);不 EMCP→set_is_obsolete+新 method_idnum(:3627-3631);deleted→三标全打;jmethodID 重定向在 update_jmethod_ids(:3511-3533)

**MethodComparator** (`methodComparator.hpp:40-80 + methodComparator.cpp:50-300`):
```
逐字节码比较:
  if (old_bytecodes[i] == new_bytecodes[i]) → 继续(method unchanged)
  else → 方法已变→需要新编译
  特殊处理:
    - ldc 指令: 比较 constant_pool entry 是否等效(new CP可能有不同的index)
    - branch 指令: 比较 jump target 对应的 bytecode 是否相同
```
- 源码: `methodComparator.cpp:50-300` + `relocator.cpp:40-200` 字节码重定位
- 关键设计: 逐字节码比较——不是为了判定"方法语义相同"(impossible in general)→而是为了决定"是否保留已有的 nmethod"。保守:遇到无法比较的→标记"方法已变"→失效 nmethod

### 3. "relocator — 字节码重写"
> ⚠️ 写作期修正(2026-08-16, vol-02/28-jvmti/02 已按真实源码成文):
> - **位置错+职责错(重要)**: relocator.cpp/hpp 在 **share/runtime/**(780 行,大纲写 prims);且**只是字节码空间调整工具**——真实 CP 索引重写主角=VM_RedefineClasses::rewrite_cp_refs_in_method(jvmtiRedefineClasses.cpp:1853,逐字节码扫描换合并池新索引,"adapted from Rewriter::rewrite_method()");Relocator 只在 **ldc→ldc_w 换格式**(索引>255 需 3 字节指令)时 insert_space_at(runtime/relocator.hpp:45/:48,注释 "ldc is 2 bytes and ldc_w is 3 bytes",调用点 :1914-1919)
> - **CP 合并两段式**: Pass 0 旧池整体复制(索引不动,Class→UnresolvedClass 回退,注释 "any code using old_cp does not have to change")+Pass 1 走 scratch 池 append_entry(:296)+_index_map_p 映射(:1317);映射非空→rewrite_cp_refs(:1708 重写范围: nest/方法字节码/各类注解/stack map/source_file/generic_signature)
> - **合并动机**: 不能直接换池——旧方法可能还在栈上,引用旧池索引(hpp:102-109 注释)

**Relocator** (`relocator.hpp:40-80 + relocator.cpp:40-200`):
```
修正新字节码中的引用:
  - constant_pool index changed→update ldc/invokevirtual index
  - line_number_table→新字节码偏移→调整
  - exception_table→新handler位置→调整
```
- 源码: `relocator.cpp:40-200`

---

### 核心悬念

**"RedefineClasses 原地替换 InstanceKlass metadata——MethodComparator 保留不变的方法的 nmethod——失效已变的方法→触发重编译。"** — 下一篇: 辅助设施。
> ⚠️ 悬念机制描述已过期(2026-08-16): 保留的不是"nmethod"而是"方法/jmethodID 结构"(EMCP 语义);编译代码统一失效(flush_evol_dependents_on 依赖精确 or 首次全量)。正确总结见正文"核心悬念"。

> → [03-auxiliary.md](03-auxiliary.md)
