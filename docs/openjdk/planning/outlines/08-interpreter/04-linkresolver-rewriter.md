# 04. LinkResolver + Rewriter — 符号→直接引用 + 字节码重写

> 🔴 Deep | 13 KP 中的 2 个核心机制
> 读者处境: `invokevirtual #5`——#5 是什么？ConstantPool 第 5 个条目——LinkResolver 解析它→method address——Rewriter 把 #5 改成 cpCache index。

> ⚠️ 写作期修正(2026-08-13, vol-02/08-interpreter/04 已按真实源码成文 269 行,本大纲为规划期产物,机制描述以文章为准):
> - **行号全漂**: 五入口在 linkResolver.cpp:1652-1690(resolve_invokestatic :1652/invokespecial :1658/invokevirtual :1665/invokeinterface :1675/invokehandle :1685),resolve_static_call :1058、resolve_virtual_call :1291、resolve_interface_call :1411、resolve_field :948、resolve_method 主链 :723-800;大纲 "300-600/750-950/100-280" 全错
> - **"getstatic → fast_agetfield/putstatic → fast_aputfield" 编造**: getstatic/putstatic 无 fast 版本(01 篇枚举无 fast_sgetstatic 等);fast_agetfield 系列来自 _getfield;Rewriter 对字段指令只换 CP→cpCache 索引(rewrite_member_reference rewriter.cpp:168-183,put_native_u2 小端写回 = 01 篇 bJJ 大写 J 的来源),不改指令
> - **"newarray → fast_newarray" 编造**: 枚举里不存在该字节码;Rewriter 唯一替换指令字节的是 lookupswitch→fast_linearswitch/fast_binaryswitch(scan_method :394-402,按 BinarySwitchThreshold);getfield→fast_igetfield 是解释器运行时 patch(02 篇),不是 Rewriter
> - **"Rewriter::rewrite(:50-400)" 行号错**: rewrite 入口 :570;主循环 rewrite_bytecodes :524-569(逐方法 forward 一遍;出错 restore_bytecodes 反扫 :78-88);scan_method :370-511 按类型分派(invokespecial :404 InterfaceMethodref 独立条目/ldc :420-427→fast_aldc/String-MH-MT-引用型 condy)
> - **"invokedynamic #0 → invokedynamic cpCacheIndex" 半对**: 每个 invokedynamic 调用点独占 cpCache 条目(one per bytecode,注释 rewriter.cpp:263-272),u4 索引,**这就是 bJJJJ 5 字节格式的根本原因**;resolved_references 数组单独登记
> - **cpCache 结构(大纲未提)**: 四字段 _indices[b2|b1|index]/_f1(metadata)/_f2(vtable 索引或偏移)/_flags(cpCache.hpp:49-54,132-142);is_resolved=bytecode 匹配(cpCache.inline.hpp:43-49);**写入顺序 flags→refs[f2]→f1 锁协议**(set_method_handle_common cpCache.cpp:350-395,indy 专用,f1 发布点+ResolutionError 失败传播);普通 invoke 走 set_direct_or_vtable_call(:318 起)无锁,_indices 字节码最后写(cpCache.hpp:128),且 invokespecial(interface sender)/invokestatic(类未初始化)故意不标记 resolved
> - **resolve_invoke 写回分派(大纲未提)**: InterpreterRuntime::resolve_invoke 尾部按 CallInfo::call_kind 三写(set_direct_call/vtable_call/itable_call,interpreterRuntime.cpp:904-921),非 set_method_handle_common
> - **解析主链六步(linkResolver.cpp:723-800)**: ①invokevirtual 禁接口类(ICCE)②CP tag 必须 Methodref ③lookup_method_in_klasses ④接口默认方法+JSR292 多态 ⑤NoSuchMethodError ⑥check_method_accessability 三向(调用类/被引用类/声明类)+loader 约束;类加载在 LinkInfo 构造(resolved_klass 时),不在 resolve_method
> - **虚分派两段**: linktime_resolve_virtual_method(:1300-1355 检查)/runtime_resolve_virtual_method(:1358-1405: 接口默认-miranda→vtable_index_of_interface_method;普通→resolved_method->vtable_index(),nonvirtual_vtable_index 特例=private/final 可静态绑定,否则 recv_klass->method_at_vtable);解析结果在 per-class cpCache,非"全 JVM 共享"
> - **实证**: fast_linearswitch 192B/fast_binaryswitch 256B/fast_aldc 352B/return_register_finalizer 1248B 模板存在(08-interpreter-templates.txt,重写发生证据);javap -v Methodref/Fieldref/InvokeDynamic#0:BootstrapMethods 形态(08-linkresolve-javap.txt);rewrite_Object_init :136-164(RegisterFinalizersAtInit→return_register_finalizer 落地)


### 1. LinkResolver — 符号引用→直接引用

场景: 解释器执行 invokevirtual→`InterpreterRuntime::resolve_invoke()`→`LinkResolver::resolve_invokevirtual()`→查 cpCache→未解析→resolve→cpCache._f2=vtable index→返回。

**resolve_invokevirtual** (`linkResolver.cpp:300-600`):
- Step 1: `resolve_pool(bytecode, index, pool, CHECK)`→取 CONSTANT_Methodref→class_index+name_and_type_index
- Step 2: `resolve_klass(pool, class_index, CHECK)`→`SystemDictionary::resolve_or_fail`→已加载→return Klass*; 未加载→load class
- Step 3: `resolve_method(klass, name, signature, CHECK)`→`klass->lookup_method(name, signature)`→vtable scan (virtual) or itable scan (interface)→Method*
- Step 4: `check_accessibility(klass, method, CHECK)`→public/private/protected check→`Reflection::verify_class_access`
- Step 5: `ConstantPoolCacheEntry::set_method(bytecode, method, vtable_index, THREAD)`→set _f1 (Klass*), _f2 (vtable/field index), _flags (resolved+bytecode type)
- [C++: access check for protected——`Reflection::verify_class_access(caller, callee, resolved)`——三个 class: caller class/callee class/resolved class (声明方法的类)。只有 caller 是 resolved 的子类 → 允许。不是简单 public/private——是三向检查]
- [JVM Spec: §5.4.3 Resolution — method/field 解析规则——先尝试 class→lookup method→如果找不到→try superclass→找不到→NoSuchMethodError]

**resolve_invokeinterface** (`linkResolver.cpp:750-950`):
- 与 invokevirtual 相同——但 itable 扫描——`klass->itable_method_at(resolved_klass, itable_index)`——不是 vtable offset——因为接口方法没有固定 index

**field resolution** (`linkResolver.cpp:100-280`):
- getstatic/putstatic/getfield/putfield → `resolve_field`→field offset→`cpCache.set_field(bytecode, klass, field_index, field_offset, field_type, ...)`→_f2=field offset
- [C++: field offset——InstanceKlass 中 field 的相对偏移——instance field: oop+offset→field; static field: mirror klass+offset→static field]

### 2. Rewriter — 字节码重写

**Rewriter::rewrite** (`rewriter.cpp:50-400`):
- 类加载时一次性扫描所有方法 bytecodes——`rewrite_method(methodHandle, CHECK)`——把 cp index→cpCache index
- `_getstatic → fast_agetfield`, `_putstatic → fast_aputfield`——7 种 field access 的 quick forms——把 cp index 替换为 cpCache index
- `newarray → fast_newarray`——直接把 type code 放到 operand 里——省去 constant pool lookup
- [C++: `Rewrite::rewrite_invokedynamic(method, CHECK)`——lambda bootstrapping。`invokedynamic #0`→`invokedynamic cpCacheIndex`——cpCacheIndex 指向已解析的 CallSite。每个 invokedynamic call site 有独立的 cpCache entry]
- [C++: 为什么在类加载时重写？— 解释器每次 invoke 都要用 cpCache index。如果在解释器里每次都做 cp→cpCache 转换——每条 invoke 多 1 次 lookup——慢 5%。一次性重写——类加载时一次性——省掉所有后续 lookup]
- wide 重写: 宽版本的 load/store→format 标记为 "J"(2B index)→`rewrite_wide(方法, CHECK)`

---

### 核心悬念

**"invokevirtual #5——首次: LinkResolver resolve (100µs)→后续: cpCache._f2→vtable[offset](5ns)。"** — cpCache entry 在首次解析时 set——后续全部 hit。Rewriter 把 #5→cpCacheIndex 提前到类加载时——解释器每次直接读 cpCache。域 8 完成。Group 3 结束。

> → domain 9: [Memory 核心 — 虚拟内存之上的堆: universe/arena/resourceArea](../09-memory-core/01-universe-heap.md)
