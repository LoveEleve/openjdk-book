# 04. 符号引用怎么变成直接引用？— LinkResolver + Rewriter

> **前置依赖**:[08-interpreter/03 — InterpreterRuntime](03-interpreter-runtime.md):本篇的 resolve_invoke/resolve_get_put 是 LinkResolver 的调用方;[08-interpreter/01 — Bytecode 定义表](01-bytecodes-definition.md):`bJJ` 的"大写 J = 原生字节序"在这里兑现——Rewriter 是那个改字节序的人;[06-oops/04 — 常量池与解析](openjdk/vol-02/06-oops/04-constantpool-method.md):ConstantPool 的条目结构是解析的输入
> → **后续**:[31-unsafe/01 — JVM 底层 API](openjdk/vol-02/31-unsafe-whitebox/01-unsafe-api.md):08 域收官,第 4 批下一站是 Unsafe 域
> 关联域: 06-oops(常量池/klassVtable)、13-jit(解析结果被编译器复用)、19-sync(解析会触发类初始化,可能进 monitor)

## 每次执行都解析一次?那太慢了

`invokevirtual #5`——#5 是常量池里一个符号引用(Methodref: 类名+名字+签名)。解释器每次走到这行,都要从符号找到 Method* 再找到 vtable 槽位吗?显然不是: **类加载时 Rewriter 先把 CP 索引换成 cpCache 索引(字节序翻转),首次执行时 LinkResolver 把解析结果写进 cpCache,之后每次执行直接命中**。这一篇拆这两段: 重写做了什么(不改变指令语义,只换索引)、解析怎么从符号一步步走到 Method*/字段偏移、解析结果以什么结构缓存。

[实证:] Temurin 11 的 PrintInterpreter 里存在 `fast_linearswitch` 192B/`fast_binaryswitch` 256B/`fast_aldc` 352B/`return_register_finalizer` 1248B 模板(08-interpreter-templates.txt)——这些"重写后的字节码"模板存在,证明类加载期的重写真的发生了(见第一节的实证)。javap -v 显示类文件里的符号引用形态(08-linkresolve-javap.txt): `#7 = Methodref #41.#42 // Integer.valueOf:(I)Ljava/lang/Integer;`、`#10 = Fieldref`、`#11 = InvokeDynamic #0:#50`——本篇拆的就是这些符号在 JVM 内部的命运。

## 1. Rewriter: 类加载时的一次性索引替换

### 重写什么: 指令不变,索引变

Rewriter 在类加载早期跑一遍所有方法(rewriter.cpp:524 的 rewrite_bytecodes,逐方法一次 forward 扫描),**不改指令语义,只改操作数**;出错时 `restore_bytecodes` 反扫还原(:78-88)。核心是 rewrite_member_reference(rewriter.cpp:168-181,截取核心,逐字):

```cpp
// rewriter.cpp:168-183(截取核心,逐字)
void Rewriter::rewrite_member_reference(address bcp, int offset, bool reverse) {
  address p = bcp + offset;
  if (!reverse) {
    int  cp_index    = Bytes::get_Java_u2(p);
    int  cache_index = cp_entry_to_cp_cache(cp_index);
    Bytes::put_native_u2(p, cache_index);
    if (!_method_handle_invokers.is_empty())
      maybe_rewrite_invokehandle(p - 1, cp_index, cache_index, reverse);
  } else {
    int cache_index = Bytes::get_native_u2(p);
    int pool_index = cp_cache_entry_pool_index(cache_index);
    Bytes::put_Java_u2(p, pool_index);
    if (!_method_handle_invokers.is_empty())
      maybe_rewrite_invokehandle(p - 1, pool_index, cache_index, reverse);
  }
}
```

`get_Java_u2`(大端读 CP 索引)→ `cp_entry_to_cp_cache`(CP 索引→cpCache 槽位)→ `put_native_u2`(小端写回)。**同一个 2 字节,从"类文件的 CP 下标"变成"内存里 cpCache 的下标",字节序也从大端翻成小端**——这就是 01 篇 `getfield "bJJ"` 大写 J 的来源。reverse 方向(CDS 归档/调试还原)完全可逆。

### 扫描主循环: 按字节码类型分派

scan_method(rewriter.cpp:370-511)逐条迭代(用 01 篇的 length_for/length_at 长度机制),按指令类型处理:

| 字节码 | 重写动作 | 行号 |
|---|---|---|
| `lookupswitch` | **指令本身替换**成 `fast_linearswitch`/`fast_binaryswitch`(按对数量阈值) | :394-402 |
| `invokespecial` | InterfaceMethodref 特例: 独立 cpCache 条目 | :404 |
| get/put static/field、invoke 系列 | CP 索引 → cpCache 索引(rewrite_member_reference) | :410-416 |
| `invokedynamic` | 专用 4 字节索引 + 独立解析引用条目 | :418 |
| `ldc`/`ldc_w` | String/MethodHandle/MethodType/引用型 condy → `fast_aldc`/`fast_aldc_w` | :420-427 |

**关键设计 (斜体)**: *注意两件大事不是 Rewriter 干的: ①`getfield → fast_igetfield` 是解释器运行时解析后 patch 的(02 篇),Rewriter 只换索引不改指令;②`newarray → fast_newarray` 不存在(01 篇的枚举里没有)——大纲常写的这个"重写"是编造的。Rewriter 唯一替换指令字节的是 lookupswitch(按 `BinarySwitchThreshold` 把线性/二分查找定死,把"数对数决定策略"从每次执行提前到类加载一次)。*

### invokedynamic: 为什么必须是 5 字节

rewrite_invokedynamic(rewriter.cpp:256-285)的处理与所有其他指令不同——注释解释了原因(rewriter.cpp:261-272,截取核心,逐字):

```cpp
// rewriter.cpp:261-272(截取核心,逐字)
    int cache_index = add_invokedynamic_cp_cache_entry(cp_index);
    int resolved_index = add_invokedynamic_resolved_references_entries(cp_index, cache_index);
    // Replace the trailing four bytes with a CPC index for the dynamic
    // call site.  Unlike other CPC entries, there is one per bytecode,
    // not just one per distinct CP entry.  In other words, the
    // CPC-to-CP relation is many-to-one for invokedynamic entries.
    // This means we must use a larger index size than u2 to address
    // all these entries.  That is the main reason invokedynamic
    // must have a five-byte instruction format.  (Of course, other JVM
    // implementations can use the bytes for other purposes.)
    // Note: We use native_u4 format exclusively for 4-byte indexes.
    Bytes::put_native_u4(p, ConstantPool::encode_invokedynamic_index(cache_index));
```

**每个 invokedynamic 调用点独占一个 cpCache 条目**(同一个 lambda 表达式出现两次就是两个 call site、两个条目)——因为每个调用点有自己的 CallSite 对象。条目数可能超过 2^16,所以操作数必须 4 字节——**这就是 invokedynamic 是 `bJJJJ` 5 字节格式的根本原因**(01 篇表格里那个"4 字节 cpCache 下标"的出处)。

### 重写把什么留下了

两处收尾重写:
- `maybe_rewrite_ldc`(rewriter.cpp:322-368): String/MethodHandle/MethodType/引用型 condy 的 ldc 替换成 `fast_aldc`/`fast_aldc_w`,操作数换成 resolved_references 数组的下标——模板侧直接按引用取,不再查常量池;
- `rewrite_Object_init`(rewriter.cpp:136-164): 启用 RegisterFinalizersAtInit 时,把 `Object.<init>` 的 `return` 字节替换成 `_return_register_finalizer`——01 篇枚举里那条神秘的私有字节码在这里落地(它让构造返回前注册 finalizer)。

[实证:] 08-interpreter-templates.txt 里 `fast_aldc`/`fast_linearswitch`/`fast_binaryswitch`/`return_register_finalizer` 各有独立模板(352B/192B/256B/1248B)——如果重写从未发生,这些模板永远不会被执行,但 JVM 仍然为它们生成了模板。

## 2. cpCache 条目: 解析结果的家

### 四个字段的布局

解析结果写进 ConstantPoolCache 的条目(cpCache.hpp:49-54 与 :132-142,截取核心,逐字):

```cpp
// cpCache.hpp:49-54(截取核心,逐字)
// _indices   [ b2 | b1 |  index  ]  index = constant_pool_index
// _f1        [  entry specific   ]  metadata ptr (method or klass)
// _f2        [  entry specific   ]  vtable or res_ref index, or vfinal method ptr
// _flags     [tos|0|F=1|0|0|0|f|v|0 |0000|field_index] (for field entries)
```

```cpp
// cpCache.hpp:132-142(截取核心,逐字)
class ConstantPoolCacheEntry {
  friend class VMStructs;
  friend class constantPoolCacheKlass;
  friend class ConstantPool;
  friend class InterpreterRuntime;

 private:
  volatile intx     _indices;  // constant pool index & rewrite bytecodes
  Metadata* volatile   _f1;       // entry specific metadata field
  volatile intx        _f2;       // entry specific int/metadata field
  volatile intx     _flags;    // flags
```

四个字: `_indices` 高 16 位存"解析时用的字节码"(b1/b2 两个槽,允许一个条目被两个字节码共享——如 invokespecial 与 invokevirtual 共用)、低 16 位存原始 CP 索引;`_f1` 是 Method*/Klass*;`_f2` 是字段偏移/vtable 索引/最终 Method*;`_flags` 编码 TosState+参数大小+条目类型。**"已解析"的判断是 `is_resolved(code)`: 条目里记录的字节码与当前执行的字节码一致(cpCache.inline.hpp:43-49)——所以一个条目被 `invokevirtual` 解析后,`invokespecial` 再用它就得重新解析(字节码不匹配)**。

### 并发写入协议: 先 flags,后 f1

invokedynamic 的写入(解析可能被多线程并发触发)有一套显式协议(set_method_handle_common,cpCache.cpp:350-360,截取核心,逐字):

```cpp
// cpCache.cpp:350-360(截取核心,逐字)
void ConstantPoolCacheEntry::set_method_handle_common(const constantPoolHandle& cpool,
                                                      Bytecodes::Code invoke_code,
                                                      const CallInfo &call_info) {
  // NOTE: This CPCE can be the subject of data races.
  // There are three words to update: flags, refs[f2], f1 (in that order).
  // Writers must store all other values before f1.
  // Readers must test f1 first for non-null before reading other fields.
  // Competing writers must acquire exclusive access via a lock.
  // A losing writer waits on the lock until the winner writes f1 and leaves
  // the lock, so that when the losing writer returns, he can use the linked
  // cache entry.
```

**写入顺序 flags → refs[f2] → f1,读者先读 f1(非空才算已解析)**,配合 resolved_references 数组的锁(`ObjectLocker`)——输掉的线程等赢家写完 f1,直接复用结果(:370-377 的 `if (!is_f1_null()) return;`)。失败则记录 ResolutionError(indy_resolution_failed),其他线程看到失败标记直接重抛同一个 LinkageError(:379-395)。**cpCache 的 f1 是"发布点"**——这个模式让解释器/编译器无锁读,写入方用锁串行化。普通 invoke 的写入走另一条无锁路径(set_direct_or_vtable_call,cpCache.cpp:318 起): 先写 flags/f2/f1,**`_indices` 里的字节码最后写**(注释 "The _indices field with the bytecode must be written last",cpCache.hpp:128),读者以 `is_resolved`(bytecode 匹配)判定完整——`_indices` 是发布点。还有两个故意"不解析"的场景: interface sender 的 invokespecial(每次执行都要查 receiver 是子类)与尚未初始化的类的 invokestatic(初始化检查不能跳过)——这些条目不写字节码,保持每次重检查。

## 3. LinkResolver: 五路入口,两种解析

### 入口全是薄包装

InterpreterRuntime 的 resolve_invoke(03 篇)按字节码调 LinkResolver 的五个入口(linkResolver.cpp:1652-1690,截取核心,逐字):

```cpp
// linkResolver.cpp:1652-1680(截取核心,逐字)
void LinkResolver::resolve_invokestatic(CallInfo& result, const constantPoolHandle& pool, int index, TRAPS) {
  LinkInfo link_info(pool, index, CHECK);
  resolve_static_call(result, link_info, /*initialize_class*/true, CHECK);
}

void LinkResolver::resolve_invokespecial(CallInfo& result, Handle recv,
                                         const constantPoolHandle& pool, int index, TRAPS) {
  LinkInfo link_info(pool, index, CHECK);
  resolve_special_call(result, recv, link_info, CHECK);
}

void LinkResolver::resolve_invokevirtual(CallInfo& result, Handle recv,
                                          const constantPoolHandle& pool, int index,
                                          TRAPS) {

  LinkInfo link_info(pool, index, CHECK);
  Klass* recvrKlass = recv.is_null() ? (Klass*)NULL : recv->klass();
  resolve_virtual_call(result, recv, recvrKlass, link_info, /*check_null_or_abstract*/true, CHECK);
}
```

`LinkInfo` 从 (pool, index) 解出"被引用的类/名字/签名/当前类"——所有后续检查的输入。五个入口把工作委托给"静态/特殊/虚/接口/handle"五条解析链 + resolve_field,自己只做 `recv->klass()` 这类准备。

### resolve_method: 解析主链的六步

类/接口方法解析的核心是 resolve_method(linkResolver.cpp:723-800),六步(linkResolver.cpp:724-790,截取核心,逐字):

```cpp
// linkResolver.cpp:724-790(截取核心,逐字)
  Handle nested_exception;
  Klass* resolved_klass = link_info.resolved_klass();

  // 1. For invokevirtual, cannot call an interface method
  if (code == Bytecodes::_invokevirtual && resolved_klass->is_interface()) {
    ...

  // 2. check constant pool tag for called method - must be JVM_CONSTANT_Methodref
  if (!link_info.tag().is_invalid() && !link_info.tag().is_method()) {
    ...

  // 3. lookup method in resolved klass and its super klasses
  methodHandle resolved_method(THREAD, lookup_method_in_klasses(link_info, true, false));

  // 4. lookup method in all the interfaces implemented by the resolved klass
  if (resolved_method.is_null() && !resolved_klass->is_array_klass()) { // not found in the class hierarchy
    resolved_method = methodHandle(THREAD, lookup_method_in_interfaces(link_info));

    if (resolved_method.is_null()) {
      // JSR 292:  see if this is an implicitly generated method MethodHandle.linkToVirtual(*...), etc
      resolved_method = lookup_polymorphic_method(link_info, (Handle*)NULL, (Handle*)NULL, THREAD);

  // 5. method lookup failed
  if (resolved_method.is_null()) {
    ...

  // 6. access checks, access checking may be turned off when calling from within the VM.
  Klass* current_klass = link_info.current_klass();
  if (link_info.check_access()) {
    assert(current_klass != NULL , "current_klass should not be null");
    // check if method can be accessed by the referring class
    ...
    // check loader constraints
    check_method_loader_constraints(link_info, resolved_method, "method", CHECK_NULL);
  }
```

①invokevirtual 遇接口类 → ICCE(必须用 invokeinterface);②CP 标签必须 Methodref;③**类层次查找**(lookup_method_in_klasses,按 JVM 规范的解析顺序: 声明类→父类→接口中最后声明的默认方法);④类层次没有 → 接口方法(默认方法)+ JSR 292 多态方法(linkToVirtual 等签名多态);⑤没有 → NoSuchMethodError;⑥**访问检查**(check_method_accessability 三向: 调用类/被引用类/声明类)+ **loader 约束检查**(两个 loader 对同一类名必须解析到同一类)。大纲的"Step 1-5"大致对,但"resolve_klass 先加载类"发生在 LinkInfo 构造(取 resolved_klass 时),不在 resolve_method 里。

### 虚分派: linktime 定方法,runtime 定槽位

resolve_virtual_call 分两半(linkResolver.cpp:1291-1405): linktime 半(linktime_resolve_virtual_method,:1300-1355)做检查(非 static、非 private 接口方法等)并拿到**解析方法**;runtime 半(runtime_resolve_virtual_method,:1358-1405)按 **receiver 的实际类**选最终方法(linkResolver.cpp:1367-1390,截取核心,逐字):

```cpp
// linkResolver.cpp:1366-1389(截取核心,逐字)
  // do lookup based on receiver klass using the vtable index
  if (resolved_method->method_holder()->is_interface()) { // default or miranda method
    vtable_index = vtable_index_of_interface_method(resolved_klass, resolved_method);
    assert(vtable_index >= 0 , "we should have valid vtable index at this point");

    selected_method = methodHandle(THREAD, recv_klass->method_at_vtable(vtable_index));
  } else {
    // at this point we are sure that resolved_method is virtual and not
    // a default or miranda method; therefore, it must have a valid vtable index.
    assert(!resolved_method->has_itable_index(), "");
    vtable_index = resolved_method->vtable_index();
    // We could get a negative vtable_index of nonvirtual_vtable_index for private
    // methods, or for final methods. Private methods never appear in the vtable
    // and never override other methods. As an optimization, final methods are
    // never put in the vtable, unless they override an existing method.
    // So if we do get nonvirtual_vtable_index, it means the selected method is the
    // resolved method, and it can never be changed by an override.
    if (vtable_index == Method::nonvirtual_vtable_index) {
      assert(resolved_method->can_be_statically_bound(), "cannot override this method");
      selected_method = resolved_method;
    } else {
      selected_method = methodHandle(THREAD, recv_klass->method_at_vtable(vtable_index));
    }
  }
```

**关键设计 (斜体)**: *解析时"符号 → 解析方法"是 linktime(只依赖声明类);"解析方法 → 实际方法"是 runtime(依赖 receiver 的实际类,每次执行不同)。解析结果落在类的 cpCache 里,同类内一次解析、全部调用点共享。vtable 索引本身在方法解析时就能定(虚方法在 vtable 里的槽位是类布局时确定的),执行时只需要 `recv_klass->method_at_vtable(index)` 一次访存——**这就是解释器/编译器分派的最快路径**。private/final 方法不进 vtable,标记 `nonvirtual_vtable_index` 后 selected = resolved(可静态绑定)。接口(默认/miranda)方法走 `vtable_index_of_interface_method` + receiver vtable。*

resolve_interface_call(:1411-1651)走 itable(接口方法表,按 (接口, 方法名) 双键查找,06 域的 klassVtable 铺垫过),解析结果同样进 `CallInfo`。

### 字段解析

resolve_field(linkResolver.cpp:948-1057): 类层次找字段 → 检查 final/static 语义与访问权限 → `fieldDescriptor` 给出**字段偏移**(实例字段 = 相对对象头的字节偏移;静态字段 = mirror 对象里的槽)。resolve_get_put(03 篇 :668)拿到 fieldDescriptor 后 `set_field` 写 cpCache(f1=持有类、f2=偏移、flags=类型),模板侧 getfield 执行时直接 `mov [obj + offset]`。

## 4. 两阶段时序: 谁在什么时候做什么

整条链的时序(以 `invokevirtual` 为例):

1. **类加载时**(Rewriter): CP 索引(大端)→ cpCache 索引(小端),指令字节不变(仅索引与字节序变化);例外是 lookupswitch/ldc/Object.<init> 的指令替换(第一节表格);
2. **首次执行**(解释器): 模板检查 cpCache 条目未解析 → `InterpreterRuntime::resolve_invoke`(03 篇)→ `LinkResolver::resolve_invokevirtual` → 六步解析 → 按 `CallInfo::call_kind` 写入 cpCache(interpreterRuntime.cpp:904-921: direct→`set_direct_call`、vtable→`set_vtable_call`、itable→`set_itable_call`,各自把 Method*/vtable 索引/接口 klass 写进 f1/f2)→ 模板 patch 指令;
3. **之后每次执行**: `is_resolved` 命中 → 直接 `method_at_vtable(f2)` 分派,零解析开销。

**关键设计 (斜体)**: *Rewriter 把"每次执行都查常量池"变成"每次执行直接读 cpCache",LinkResolver 把"每次执行都解析"变成"首次解析+永久缓存"。两道缓存各消掉一次成本: 前者的成本是索引换算+字节序,后者的成本是整条解析链。解释器/编译器/反射(java.lang.reflect)共用同一套解析与缓存——LinkResolver 是符号世界的唯一入口。*

## 核心悬念

LinkResolver + Rewriter 拆完了: 类加载时 Rewriter 把 CP 索引换成 cpCache 索引(字节序翻转)、lookupswitch/ldc 快化、invokedynamic 的 5 字节格式源自"每调用点一条目";cpCache 条目四字段 + f1 发布协议承载解析结果;LinkResolver 五路入口 + 六步解析主链 + linktime/runtime 两段式虚分派,最终都是"符号 → `Method*`/字段偏移 → 缓存"。解释器执行链至此彻底闭环: 定义表、模板、dispatch、runtime、解析,一个字节码从字节到执行的完整旅程。

08 域收官。下一个域换一条完全不同的路: 解释器/JIT 内部怎么执行只是半张图——Java 代码还能绕过一切检查直接访问内存,那就是 `sun.misc.Unsafe`。下一站: Unsafe 域的 direct memory 通道。

> → [31-unsafe/01 — JVM 底层 API](openjdk/vol-02/31-unsafe-whitebox/01-unsafe-api.md)
