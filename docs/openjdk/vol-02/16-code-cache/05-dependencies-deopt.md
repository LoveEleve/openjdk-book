# 05. Dependencies 与 Deopt — JIT 的乐观假设与自救

> **前置依赖**:[02 — nmethod 结构](02-nmethod-structure.md):scopes/pcs 段、状态机;[03 — nmethod 生命周期](03-nmethod-lifecycle.md):依赖失效的清算链(DepChange → 反向索引 → VM_Deoptimize)、uncommon trap 的 action;[04 — Relocation 与 Inline Cache](04-relocation-ic.md):megamorphic 的 vtable/itable 桩
> → **后续**:[38-perfdata/01 — PerfData 架构](openjdk/vol-02/38-perfdata/01-perfdata.md)(第 2 批收官域)
> 关联域: 15-c2(编译期收集假设)、22-deopt(本篇主题的完整域)、07-classfile-classloader(类加载触发假设失效)

## 赌注与安全网

C2 敢内联 `animal.speak()`、敢把虚调用变成静态绑定,是因为编译时观察到了类层次——"现在只有 Dog 覆盖了 speak"。但**未来可能加载新类打破这个观察**。于是每个 nmethod 都带着一张"赌注清单": 依赖(Dependencies)记录"我赌了什么",类加载时对照验证,赌输了就 deopt——把正在执行的编译帧退回解释器,重新观察、重新编译。这张"赌注清单 + 自救流程"是 JIT 敢激进的前提: 优化可以错,但必须有账可查、有路可退。

## 1. 赌注清单: 十二种依赖

### 类型清单

依赖类型是枚举(dependencies.hpp:104-171,截取核心,逐字):

```cpp
// dependencies.hpp:104-171(截取核心,逐字)
  enum DepType {
    end_marker = 0,

    // An 'evol' dependency simply notes that the contents of the
    // method were used.  If it evolves (is replaced), the nmethod
    // must be recompiled.  No other dependencies are implied.
    evol_method,
    FIRST_TYPE = evol_method,

    // A context type CX is a leaf it if has no proper subtype.
    leaf_type,

    // An abstract class CX has exactly one concrete subtype CC.
    abstract_with_unique_concrete_subtype,

    // The type CX is purely abstract, with no concrete subtype* at all.
    abstract_with_no_concrete_subtype,

    // The concrete CX is free of concrete proper subtypes.
    concrete_with_no_concrete_subtype,

    // Given a method M1 and a context class CX, the set MM(CX, M1) of
    // "concrete matching methods" in CX of M1 is the set of every
    // concrete M2 for which it is possible to create an invokevirtual
    // or invokeinterface call site that can reach either M1 or M2.
    // That is, M1 and M2 share a name, signature, and vtable index.
    // We wish to notice when the set MM(CX, M1) is just {M1}, or
    // perhaps a set of two {M1,M2}, and issue dependencies on this.
    ...
    unique_concrete_method,       // one unique concrete method under CX
    ...
    abstract_with_exclusive_concrete_subtypes_2,
    ...
    exclusive_concrete_methods_2,
    ...
    unique_implementor, // one unique implementor under CX
    ...
    no_finalizable_subclasses,
    ...
    call_site_target_value,

    TYPE_LIMIT
  };
```

共 **11 种赌注**(枚举值 12 个,TYPE_LIMIT=12,其中 `end_marker` 是哨兵不算赌注)。按赌注对象分三族:

- **类层次赌注**(编译器敢做去虚拟化/内联的前提): `leaf_type`(没有子类)、`abstract_with_unique_concrete_subtype`(抽象类只有唯一具体子类)、`abstract_with_no_concrete_subtype`(纯抽象无实现)、`concrete_with_no_concrete_subtype`(具体类无子类)、`unique_implementor`(接口只有唯一实现者)、`abstract_with_exclusive_concrete_subtypes_2`(最多两个具体子类);
- **方法赌注**: `unique_concrete_method`(context 类下匹配的方法只有 M1 一个——vtable index 相同的所有可达实现只有它)、`exclusive_concrete_methods_2`(至多两个)、`evol_method`(方法内容被用过,重定义就得重编);
- **其他**: `no_finalizable_subclasses`(无需 finalizer 注册,可以跳过注册路径)、`call_site_target_value`(invokedynamic 的 CallSite 目标不变)。

每个赌注都是可验证的具体陈述,验证逻辑一一对应——不存在"这个类很重要"这类无法对账的断言。

### 编译时: 记账

C2 编译中每做一个基于类层次的优化,就调一次 `assert_xxx`(dependencies.hpp:359-389)把赌注记进 Dependencies 对象,比如 `assert_unique_concrete_method(ctxk, uniqm)`——"我赌 context 类下匹配 vtable index 的实现只有这一个"。记账实现 `assert_common_2`(dependencies.cpp:236 起)把赌注按类型分桶(`_deps[dept]` 数组),相邻同类赌注还会合并去重。

成文时赌注落到两个地方(16-02/03 讲过结构,这里看写入侧,new_nmethod 里 nmethod.cpp:512-534,截取核心,逐字):

```cpp
// nmethod.cpp:512-534(截取核心,逐字)
    if (nm != NULL) {
      // To make dependency checking during class loading fast, record
      // the nmethod dependencies in the classes it is dependent on.
      // This allows the dependency checking code to simply walk the
      // class hierarchy above the loaded class, checking only nmethods
      // which are dependent on those classes.  The slow way is to
      // check every nmethod for dependencies which makes it linear in
      // the number of methods compiled.  For applications with a lot
      // classes the slow way is too slow.
      for (Dependencies::DepStream deps(nm); deps.next(); ) {
        if (deps.type() == Dependencies::call_site_target_value) {
          // CallSite dependencies are managed on per-CallSite instance basis.
          oop call_site = deps.argument_oop(0);
          MethodHandles::add_dependent_nmethod(call_site, nm);
        } else {
          Klass* klass = deps.context_type();
          if (klass == NULL) {
            continue;  // ignore things like evol_method
          }
          // record this nmethod as dependent on this klass
          InstanceKlass::cast(klass)->add_dependent_nmethod(nm);
        }
      }
```

赌注本身进 nmethod 的 dependencies 段(编译期 `dependencies->copy_to(this)`,nmethod.cpp:760),同时**按 context 类登记反向索引**——每个被赌的类记下"谁在赌我"。注释点明了设计动机: 类加载时只需走被加载类的类层次、检查依赖它的 nmethod,而不是全量扫描(16-03 的清算链就是消费这个索引)。

### 运行时: 对账

新类加载 → `flush_dependents_on` → `DepChange`(16-03 讲过清算链)。对账的终点是逐条验证:`spot_check_dependency_at`(dependencies.cpp:2047-2056)先筛"这条赌注的 context 是否在受影响范围",命中就交给 `check_klass_dependency`(dependencies.cpp:1984-2026)按类型分派:

```cpp
// dependencies.cpp:1988-2020(截取核心,省略部分 case)
  Klass* witness = NULL;
  switch (type()) {
  case evol_method:
    witness = check_evol_method(method_argument(0));
    break;
  case leaf_type:
    witness = check_leaf_type(context_type());
    break;
  case abstract_with_unique_concrete_subtype:
    witness = check_abstract_with_unique_concrete_subtype(context_type(), type_argument(1), changes);
    break;
  case concrete_with_no_concrete_subtype:
    witness = check_concrete_with_no_concrete_subtype(context_type(), changes);
    break;
  case unique_concrete_method:
    witness = check_unique_concrete_method(context_type(), method_argument(1), changes);
    break;
  case unique_implementor:
    witness = check_unique_implementor(context_type(), type_argument(1), changes);
    break;
  case no_finalizable_subclasses:
    witness = check_has_no_finalizable_subclasses(context_type(), changes);
    break;
  ...
```

每个 `check_xxx` 重新遍历当时的类层次,返回一个"见证者"——如果找到了赌注声称不存在的东西(新子类、新实现、第二个方法),这条赌注就破了,witness 非 NULL,nmethod 被标记、走上 16-03 的收尸流程。**验证成本只在类加载时发生一次**,平时零开销。

**关键设计 (斜体)**: *赌注的粒度是"具体陈述"而不是"信任类层次"——验证函数按类型一对一实现,新增一种假设就是新增一个枚举值、一个 assert、一个 check。12 种赌注像 12 张契约: 编译器写"我赌了 X",加载器验证"X 还成立吗",打破即失效。*

## 2. 自救: deopt 的栈帧重建

### 入口: DeoptimizationBlob

依赖破了之后,栈上正在执行旧代码的帧要变回解释器帧。执行线程通过 `DeoptimizationBlob`(codeBlob.hpp:554 起)进入,它有四个入口(codeBlob.hpp:605-621):

- `unpack()`——正常 deopt: 重建帧后继续执行;
- `unpack_with_exception()`——deopt 并抛异常;
- `unpack_with_reexecution()`——重建后**重新执行**当前字节码;
- `unpack_with_exception_in_tls()`——C1 专用: 异常与 PC 在线程局部(注释 :613-617 原文 "Alternate entry point for C1 where the exception and issuing pc are in JavaThread::_exception_oop and JavaThread::_exception_pc instead of being in registers")。

### 重建流程: 两段 C++ + 汇编搭架

deopt 桩是手写汇编(x86 的 `generate_deopt_blob`,sharedRuntime_x86_64.cpp:2810 起),但它**不是纯汇编闭门造车**——汇编负责两件事: ①把现场(寄存器)完整保存;②调用两个 C++ 例程(sharedRuntime_x86_64.cpp:2849-2854 注释原文 "We call the first C routine, fetch_unroll_info()... Then we call the C routine unpack_frames()")。流程:

1. **收集内联链**(`fetch_unroll_info`,deoptimization.cpp:139 → `fetch_unroll_info_helper` :158): 从被 deopt 的编译帧出发,`vframe::new_vframe` 创建第一个 vframe,沿 `sender()` 一路收集**全部内联层**(注释 :180-181 原文 "Create a growable array of VFrames where each VFrame represents an inlined Java frame")——每层对应一个 `compiledVFrame`,内含该层的 ScopeDesc(02 篇的 scopes 链在这里消费);
2. **算重建方案**(`UnrollBlock`,deoptimization.cpp:514): 按每层帧大小算好"要铺多少栈";
3. **汇编铺帧**: 回到汇编,按 UnrollBlock 的描述在栈上铺出**骨架解释器帧**;
4. **填数据**(`unpack_frames`,deoptimization.cpp:623 → `vframeArray::unpack_to_stack`,vframeArray.cpp:567): 把每层的 locals/expressions/monitors 从 ScopeValue 解码填进骨架帧。

### 值在哪: Location 编码

第 4 步填的数据来自 `ScopeValue` 及其子类——描述"这个 Java 局部变量在编译代码里藏在哪"。位置编码在 `Location`(location.hpp:44-60):

```cpp
// location.hpp:45-60(截取核心,逐字)
  enum Where {
    on_stack,
    in_register
  };

  enum Type {
    invalid,                    // Invalid location
    normal,                     // Ints, floats, double halves
    oop,                        // Oop (please GC me!)
    ...
    narrowoop                   // Narrow Oop (please GC me!)
  };
```

一个 Location = 在哪(on_stack/in_register)+ 什么类型(normal/oop/narrowoop)+ 寄存器号或栈偏移。deopt 时从编译帧的寄存器/栈槽读出值,按 Type 决定要不要把窄 oop 解宽、把 oop 登记进新的解释器 oop map。

**关键设计 (斜体)**: *重建是"两段式": 汇编只做确定性最强的事(保存现场、铺骨架帧),所有决策(哪些帧、多大、值在哪)都交给 C++ 算好塞进 UnrollBlock——汇编保持极简,正确性集中在一处。解释器帧比编译帧大,所以先算出总账(UnrollBlock)再动手铺,不在重建中途临时决定。*

## 3. 两件配角: VtableStubs 与 CodeHeap Analytics

### VtableStubs: 多态调用的落地

16-04 讲过 megamorphic 的调用点指向 vtable/itable 桩——桩是什么?`VtableStubs` 按 **(is_vtable, vtable_index)** 哈希缓存桩(`find_stub`,vtableStubs.cpp:208-260,`VtableStubs_lock` 保护)——不是 per 类,桩本身不含类信息(itable 桩才带接口检查)。x86-64 的 vtable 桩指令序列(vtableStubs_x86_64.cpp:76-134,截取核心):

```cpp
// vtableStubs_x86_64.cpp:76-134(截取核心,省略 DebugVtables 段)
  // get receiver (need to skip return address on top of stack)
  assert(VtableStub::receiver_location() == j_rarg0->as_VMReg(), "receiver expected in j_rarg0");

  // Free registers (non-args) are rax, rbx

  // get receiver klass
  address npe_addr = __ pc();
  __ load_klass(rax, j_rarg0);
  ...
  // load Method* and target address
  start_pc = __ pc();
  __ lookup_virtual_method(rax, vtable_index, method);
  ...
  // rax: receiver klass
  // method (rbx): Method*
  // rcx: receiver
  address ame_addr = __ pc();
  __ jmp( Address(rbx, Method::from_compiled_offset()));
```

receiver 在 `j_rarg0`(x86-64 的 rdi);`load_klass` 取接收者 Klass;`lookup_virtual_method` 一次 mov 从 vtable 取 `Method*`;最后 `jmp [Method::from_compiled_offset]`——跳编译入口(没有编译代码时这个槽指向解释器适配)。vtable 桩是"查表 + 一跳",比 IC 的检查慢一点,但独立于调用点的缓存状态,永远可用。

### CodeHeap Analytics: 看住钱袋子

`jcmd <pid> Compiler.CodeHeap_Analytics` 的背后是 `CodeHeapState::aggregate`(codeHeapState.hpp:106): 按大小/年龄/编译器分组统计每段的块分布。[实证:] 素材里的输出(materials/commands/jcmd-Compiler.CodeHeap_Analytics.txt)开头就是 CodeCache 总览(Reserved 245760 KB / Committed 7488 KB / Unallocated 243224 KB)和 sweeper 统计——实际占用只有预留的 3%,离"CodeCache is full"很远;配合 16-03 讲的 `-XX:+PrintCodeCache`,定位"谁占了空间"就够用了。

## 核心悬念

16 域到此收官: 从 CodeBuffer 的临时工地到 CodeBlob/CodeHeap 的家(01),到 nmethod 的三扇门与八段身(02),到扫除器的生老病死(03),到 relocation/IC 的自描述(04),再到依赖与 deopt 的赌注和安全网(05)——一段编译代码的完整一生闭环: **编译时激进,记账(依赖);运行时对照,破账即失效(deopt);回收时谨慎(状态机+扫除器);GC 时自描述(relocation)**。下一域换一个视角: 这些机制运行时都靠"观测数据"做决策(jstat 看到的计数器、JFR 的事件),这些数据从哪来、怎么无锁更新?——域 38: PerfData 架构。

> → [38-perfdata/01 — PerfData 架构](openjdk/vol-02/38-perfdata/01-perfdata.md)
