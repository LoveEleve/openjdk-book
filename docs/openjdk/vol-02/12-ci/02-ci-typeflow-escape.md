# 02. 编译器怎么知道"类型"与"逃逸"？— ciTypeFlow + bcEscapeAnalyzer

> **前置依赖**:[12-ci/01 — JIT 怎么看到 Java 类？— ciObject 镜像体系](01-ci-overview-mirror.md):ciMethod 的懒字段 `_flow`/`_method_blocks` 在这里被填上;[08-interpreter/01 — 一条字节码的"档案"在哪？— Bytecode 定义表](openjdk/vol-02/08-interpreter/01-bytecodes-definition.md):类型流要逐条模拟字节码的栈效果;[44-class-verification/01 — 恶意字节码怎么被拦下？— ClassVerifier 类型检查引擎](openjdk/vol-02/44-class-verification/01-verifier.md):类型流的 meet 规则与验证器的类型系统同源;[09-memory-core/03 — Arena + ResourceArea — VM 自己的 C++ 内存分配器](openjdk/vol-02/09-memory-core/03-arena-resourcearea-allocation.md):分析结果全部活在 ciEnv 的 Arena 里
> → **后续**:[12-ci/03 — ciObjectFactory + ciReplay — ciObject 生命周期与编译回放](03-ci-factory-runtime.md):工厂的 GC 安全、编译重放与 MDO
> 关联域: 22-deopt(类型流陷阱导致 deopt)、25-gc(标量替换消除分配)、13-jit(C2 消费分析结果)

## 编译器还缺一张"类型地图"

01 篇的实证里,`@ 29 CiDemo$Square::area` 被内联,依据是 `TypeProfile (87426/87426) = CiDemo$Square`——那是**运行时收集**的剖面(解释器/低 tier 记下来的)。但剖面只覆盖调用点;编译器还需要回答更普遍的问题: **每个字节码位置,栈和局部变量的类型是什么?** 比如 `String.length()` 的 bci=5 是 invokevirtual,receiver 一定非空吗?`getfield` 的对象是数组吗?这些不能只靠 profile——方法体还没跑过几遍,但字节码就在那里,可以**静态推导**。ciTypeFlow 就是 C2 的推导器: 一个在字节码层面做**抽象解释**(abstract interpretation)的数据流分析。它是 C2 构建 IR 的前序: `parse1.cpp:427` 里 `_flow = method()->get_flow_analysis()`——类型流的结果决定解析器怎么处理每条字节码。

另一张地图是**对象去向**: `Point p = new Point(...); return p.area();` 这个对象会不会被存进字段、被返回、被传给别人?不会的话,C2 可以不真分配它(标量替换)。bcEscapeAnalyzer 在字节码层面做"快速、保守"的逃逸分析。这一篇拆这两台"推导机器"。

## 1. ciTypeFlow: 把方法体当"虚拟机"跑一遍

`ciTypeFlow`(ciTypeFlow.hpp:35)的输入: `ciMethod` + `ciMethodBlocks`(基本块,ciMethod 的另一个懒字段,`get_method_blocks` ciMethod.cpp:1317)+ 一个可选的 `osr_bci`(ciTypeFlow.hpp:57)——**支持从循环内任意 bci 开始的 OSR 分析**(构造时 `is_osr_flow()` 区分,:63)。创建入口是 `ciMethod::get_flow_analysis()`(ciMethod.cpp:352): 懒建 + 缓存(`if (_flow == NULL)`,ciMethod 构造时 `_flow = NULL`,01 篇的懒字段体系);OSR 版本 `get_osr_flow_analysis(osr_bci)`(:369)每次新分析。消费端是 C2 的解析器 `Parse`(parse1.cpp:427): 拿到 flow 后先查两件事——`failing()`(分析失败/中途放弃)就直接 `record_method_not_compilable`(:428-429),`has_irreducible_entry()`(不可归约循环)也特殊对待(:433);然后解析以 **flow 的块图为骨架**(`rpo_at`/`successors`/`exceptions`,parse1.cpp:1250/1274-1275)逐块生成 IR,OSR 场景还要用块类型(`local_type_at`/`monitor_count`,parse1.cpp:223/346)。

分析的核心数据结构是 **StateVector**——"某个程序点的类型信息汇总"(ciTypeFlow.hpp:158-160):

```cpp
// ciTypeFlow.hpp:175-187(截取核心,逐字)
    // Special elements in our type lattice.
    enum {
      T_TOP     = T_VOID,      // why not?
      T_BOTTOM  = T_CONFLICT,
      T_LONG2   = T_SHORT,     // 2nd word of T_LONG
      T_DOUBLE2 = T_CHAR,      // 2nd word of T_DOUBLE
      T_NULL    = T_BYTE       // for now.
    };
    static ciType* top_type()    { return ciType::make((BasicType)T_TOP); }
    static ciType* bottom_type() { return ciType::make((BasicType)T_BOTTOM); }
    static ciType* long2_type()  { return ciType::make((BasicType)T_LONG2); }
    static ciType* double2_type(){ return ciType::make((BasicType)T_DOUBLE2); }
    static ciType* null_type()   { return ciType::make((BasicType)T_NULL); }
```

内部是一个**类型格(lattice)**: `top`(未知,T_VOID 占位)、`bottom`(矛盾,T_CONFLICT)、以及 long/double 的"第二字"类型。`StateVector` 本体: `ciType** _types` 数组 + `_stack_size` + `_monitor_count`(ciTypeFlow.hpp:162-164)——**局部变量与栈共用一条数组**,`local(i)` 就是下标 i,`stack(s)` 是 `max_locals + s`(:221-229)。每个 StateVector 就是这份类型地图的一行。

**模拟字节码**: `apply_one_bytecode`(ciTypeFlow.cpp:868)是一个覆盖全字节码集的大 switch——`aload` → `load_local_object`、`monitorenter` → pop + monitor_count+1(:922-925)、`anewarray` → pop_int + `push_object(ciObjArrayKlass::make(...))`(:901-916,元素类没解析就 `trap`)。细节可见 44 域验证器同款的处理: **boolean/char/byte/short 统一压成 int**(`push_translate`,ciTypeFlow.cpp:540-552);**long/double 占两个槽**(`push_long` push 主类型+`long2_type`,ciTypeFlow.hpp:316-325)。模拟发现"这条路走不通"(如类未解析)就 `trap`(:464-465)——分析在此停止,编译路径依赖 trap 记录做 deopt 处理。

## 2. meet: 两条路径汇合时,类型怎么合并

控制流分支(if/else、循环)汇合时,两条路径的类型必须合并成一个——**meet 操作**,定义在 `StateVector::meet`(ciTypeFlow.cpp:438): 逐格比较,不同就 `type_meet(t1, t2)` 取新类型(:470-482);**返回是否发生变化**——这是迭代算法的"变化信号"。单格规则在 `type_meet_internal`(ciTypeFlow.cpp:272):

```cpp
// ciTypeFlow.cpp:272-310(截取核心,逐字)
ciType* ciTypeFlow::StateVector::type_meet_internal(ciType* t1, ciType* t2, ciTypeFlow* analyzer) {
  assert(t1 != t2, "checked in caller");
  if (t1->equals(top_type())) {
    return t2;
  } else if (t2->equals(top_type())) {
    return t1;
  } else if (t1->is_primitive_type() || t2->is_primitive_type()) {
    // Special case null_type.  null_type meet any reference type T
    // is T.  null_type meet null_type is null_type.
    if (t1->equals(null_type())) {
      if (!t2->is_primitive_type() || t2->equals(null_type())) {
        return t2;
      }
    } else if (t2->equals(null_type())) {
      if (!t1->is_primitive_type()) {
        return t1;
      }
    }

    // At least one of the two types is a non-top primitive type.
    // The other type is not equal to it.  Fall to bottom.
    return bottom_type();
  } else {
    // Both types are non-top non-primitive types.  That is,
    // both types are either instanceKlasses or arrayKlasses.
    ciKlass* object_klass = analyzer->env()->Object_klass();
    ciKlass* k1 = t1->as_klass();
    ciKlass* k2 = t2->as_klass();
    if (k1->equals(object_klass) || k2->equals(object_klass)) {
      return object_klass;
    } else if (!k1->is_loaded() || !k2->is_loaded()) {
      // Unloaded classes fall to java.lang.Object at a merge.
      return object_klass;
    } else if (k1->is_interface() != k2->is_interface()) {
      // When an interface meets a non-interface, we get Object;
      // This is what the verifier does.
      return object_klass;
```

规则一目了然: **top 是吸收元**(meet 掉任何类型);**null 是恒等元**(null meet 引用 = 引用);原语类型互不相遇 → **bottom**;两个引用: 一方是 Object → Object、未加载类 → Object、**接口与非接口相遇 → Object(源码注释明说 "This is what the verifier does"——44 域规则同源)**;数组 meet 数组要递归元素规则(ciTypeFlow.cpp:310-330,objArray meet objArray 逐元素 meet 再组数组);两个普通实例类 → `least_common_ancestor`(ciTypeFlow.cpp:334,ciKlass 侧找最近公共父类)。

**关键设计 (斜体)**: *meet 的语义是"精度的单调下降"——从精确类型往公共父类走,最后可能退到 Object。类型越精确,C2 能做的优化越多(devirtualize、精确字段类型);牺牲精度换安全: 编译器从不在类型上赌命,`trap` 与 meet 保证分析结果只可能"不够精确",不可能"错"。*

## 3. 主循环: 从入口跑到 fixpoint

`flow_types()`(ciTypeFlow.cpp:2727)是主流程: 入口块喂入初始状态(`get_start_state`,:363: 方法参数类型;OSR 时取非 OSR 分析在 osr_bci 处的块状态作起点)→ 深度优先把块逐个 `flow_block` → 有循环时先 `clone_loop_heads`(循环头克隆,让回边有独立的类型状态;**仅限 tier2+**,`comp_level >= CompLevel_full_optimization` 才做,:2747-2762)——然后进入 work list 迭代:

```cpp
// ciTypeFlow.cpp:2770-2782(截取核心,逐字)
  // Continue flow analysis until fixed point reached

  debug_only(int max_block = _next_pre_order;)

  while (!work_list_empty()) {
    Block* blk = work_list_next();
    assert (blk->has_post_order(), "post order assigned above");

    flow_block(blk, temp_vector, temp_set);

    assert (max_block == _next_pre_order, "no new blocks");
    assert (!failing(), "no more bailouts");
  }
```

`flow_block`(ciTypeFlow.cpp:2326)对块内字节码逐条模拟: 指令可能抛异常的(`can_trap`)先把异常边流出去(`flow_exceptions`,:2359-2362),再 `apply_one_bytecode`(:2364),块尾算后继(`flow_successors`,:2426)——后继块把本块状态 `meet` 进自己的进入状态,发生变化就重新入队。**循环因此会迭代多轮直到稳定**——这就是 fixpoint: 循环头的类型从第一次进入的"窄"逐渐 meet 到稳定的"宽",之后不再变化。

**异常处理器的状态**单独构造: `Block::compute_exceptions`(ciTypeFlow.cpp:1790)用 `ciExceptionHandlerStream` 遍历异常表,每个 handler bci 建一个块,记录捕获类型(catch-all → `Throwable_klass`,:1819-1823);`meet_exception`(ciTypeFlow.cpp:492)处理"沿异常边进来的状态": **局部变量照常 meet,但栈被重置——异常发生时栈上只有一个异常对象**(`set_stack_size(1)`,:499-501,栈顶与异常类型 meet,:527-535)。这就是大纲说的"handler 局部变量=try 块 locals + 栈深 1"——实现细节比大纲描述的更明确。

## 4. 逃逸分析: 对象到底出不出方法

类型地图解决了"是什么类型";bcEscapeAnalyzer 解决"对象去哪"。类注释自我定位(ciTypeFlow.cpp 同目录的 bcEscapeAnalyzer.hpp:38-40): *"a fast, conservative analysis of effect of methods on the escape state of their arguments. The analysis is at the bytecode level."*——**快速、保守、字节码级**。它不建 01 篇那套复杂图,而是把"哪些栈/局部变量槽里坐着参数"用位图追着走。

输入与 ciTypeFlow 无关(`do_analysis`,bcEscapeAnalyzer.cpp:1201: `_methodBlocks = _method->get_method_blocks()` 后 `iterate_blocks` 自己扫字节码)——大纲说"输入含 ciTypeFlow 结果"是错的。状态是几组 **VectorSet 位图**(bcEscapeAnalyzer.hpp:54-64): `_arg_local`(参数不逃逸当前方法)、`_arg_stack`(参数逃逸到调用链但不全局)、`_arg_returned`(可能被返回)、`_return_local`(返回值只含输入参数)、`_return_allocated`(返回值只含新分配的未逃逸对象)、`_allocated_escapes`(方法内分配有逃逸)。对外接口:

```cpp
// bcEscapeAnalyzer.hpp:124-147(截取核心,逐字)
  // The given argument does not escape the callee.
  bool is_arg_local(int i) const {
    return !_conservative && _arg_local.test(i);
  }

  // The given argument escapes the callee, but does not become globally
  // reachable.
  bool is_arg_stack(int i) const {
    return !_conservative && _arg_stack.test(i);
  }

  // The given argument does not escape globally, and may be returned.
  bool is_arg_returned(int i) const {
    return !_conservative && _arg_returned.test(i); }

  // True iff only input arguments are returned.
  bool is_return_local() const {
    return !_conservative && _return_local;
  }

  // True iff only newly allocated unescaped objects are returned.
  bool is_return_allocated() const {
    return !_conservative && _return_allocated && !_allocated_escapes;
  }
```

算法是"乐观 + 降级"(`initialize`,bcEscapeAnalyzer.cpp:1233): 起点把所有引用参数都标成 `_arg_local + _arg_stack`(:1242-1254,乐观: 假设它们不逃逸),然后逐字节码追踪——降级点各不相同: **putfield/putstatic 写引用值时,被写的值对象 → `set_global_escape`(可能被任何人读到,:876-878);putfield 的 receiver 本身 → `set_method_escape` + 记录被改偏移(:884-888)**;`aaload` 数组读 → 数组 `set_method_escape` + `set_dirty`(:488-492);调用点 `invoke`(:249)把被调方法的分析结果并进来——被调方说参数"栈逃逸但没返回" → `set_method_escape` 并**记录依赖**;否则 → `set_global_escape`(:336-339);**被调方法不是单形态**(有多个可能实现) → 所有实参直接 `set_global_escape` + `_unknown_modified`(:355-363)。`set_global_escape`(:167)清 local+stack 位,含分配对象时置 `_allocated_escapes`。**入口还有一串"直接不分析"的跳过条件**(do_analysis,:1302-1316): 抽象方法、native、持有者未初始化、**分析深度超 `MaxBCEAEstimateLevel`**、方法超 `MaxBCEAEstimateSize`——跳过=保持全保守。**递归有自己的防线**: `_parent` 指针串起"当前分析链",`is_recursive_call`(:206)沿这条链查 callee 是否已在栈上——递归调用不套娃分析(:316),直接按保守处理。保守模式 `_conservative` 下所有访问器返回 false(:49-50,什么都优化不了,但一定安全)。

**关键设计 (斜体)**: *这份分析刻意不精确——不追踪对象图,只追踪"参数/新分配"两类身份,任何看不懂的操作一律降级。它产出的是 C2 的**输入**,不是 C2 的结论: 真正的全局逃逸分析在 C2 的 `ConnectionGraph`(escape.cpp),后者把字节码级结论放进 IR 节点图里做全程序判断;bcea 的结论主要服务**调用点参数**——`meth->get_bcea()` 在 escape.cpp:970/:1154 被取用,判断"这个实参能不能安全优化"。*

## 5. 标量替换: 逃逸分析的兑现

对象不逃逸,优化能到什么程度?**标量替换**: 把 `new Point` 拆成 `x`、`y` 两个寄存器/局部变量,堆上不分配。注意大纲说的 `ciMethod::scalar_replacement_possible()` **不存在**——决定权在 C2: `ConnectionGraph::scalar_replaceable()`(escape.cpp:256/273)+ `find_scalar_replaceable_allocs`(:268)找出可替换的分配点,替换本身在 `PhaseMacroExpand`(macro.cpp)把 Allocate 节点展开成标量。逃逸分析的层次术语(NoEscape/ArgEscape/GlobalEscape)属于 C2 的 ConnectionGraph,不是 bcEscapeAnalyzer 的三档(后者是 local/stack/returned 的位图)。

[实证:](openjdk/planning/outlines/00-jvm-tools/materials/commands/12-ci-typeflow-escape-demo.txt) EscDemo 的两个方法: `noEscape` 循环 400 万次 `new Point`(对象只在方法内用),`escape` 循环 40 万次 `new Point` 后塞进 `ArrayList`。默认配置下 `noEscape: 1ms` vs `escape: 18ms`——分配被消除的痕迹;关闭 `-XX:-EliminateAllocations` 后 `noEscape: 5ms`、`escape: 9ms`——差异消失,两个方法都回到"真分配"的同一水平。PrintCompilation 确认 `noEscape` 被 C2 以 OSR(`%`)形式编译(tier3 `%`→tier4 `%`)。开关对照把"1ms 的功劳归于标量替换"钉死了: 同一份字节码、同一个 C2,唯一变量是分配消除开关。

## 核心悬念

两台推导机器拆完了: ciTypeFlow 用**类型格 + meet + work list fixpoint** 给每个程序点算出类型地图(异常边栈重置为单个异常对象、循环头克隆、OSR 入口特例);bcEscapeAnalyzer 用**乐观位图 + 降级**判断参数与方法内分配的去向,输出给 C2 的 ConnectionGraph,由 `scalar_replaceable` + PhaseMacroExpand 兑现为标量替换。一句话: **类型与逃逸,一个算"是什么",一个算"去哪",都是字节码层面的保守推导——精度可以降,安全不能丢。**

但这两台机器每次编译都要跑,ci 对象的创建与缓存、编译的可复现性(ciReplay)、剖面数据(ciMethodData)怎么管理?下一篇收束 ci 域: ciObjectFactory + ciReplay。

> → [12-ci/03 — ciObjectFactory + ciReplay — ciObject 生命周期与编译回放](03-ci-factory-runtime.md)
