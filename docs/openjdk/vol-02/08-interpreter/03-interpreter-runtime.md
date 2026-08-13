# 03. 解释器怎么安全地调 C++？— InterpreterRuntime

> **前置依赖**:[08-interpreter/02 — 字节码→x86 机器码](02-template-interpreter.md):`calls_vm` 位的模板(ldc 736B/invokevirtual 1280B)执行到关键步骤要调 C++——本篇拆这个通道;[24-frame/01 — Physical Frame](openjdk/vol-02/24-frame/01-physical-frame.md):调用前要把帧信息记进 JavaFrameAnchor,栈遍历/GC 靠它;[19-sync/03 — Enter/Exit 与 Wait/Notify](openjdk/vol-02/19-sync/03-enter-exit-wait.md):monitorenter 的 runtime 入口调 fast_enter/slow_enter
> → **后续**:[08-interpreter/04 — LinkResolver + Rewriter](04-linkresolver-rewriter.md):本篇的 resolve_invoke/resolve_get_put 是 04 篇 LinkResolver 的入口
> 关联域: 24-frame(anchor/栈遍历)、19-sync(monitor)、17-threads(线程状态机)、13-jit(编译策略)

## 模板解决不了的事,交给 C++

02 篇的 `invokevirtual` 模板有 1280 字节——但它解决不了根本问题: 目标方法还没解析、对象还没分配、异常还不知道去哪找 handler。模板在关键节点 `call_VM` 调 C++(interpreterRuntime.cpp 的 46 个 IRT 宏入口加少数裸入口),C++ 干完把结果放回,模板继续。这一篇拆这个通道的骨架: 入口宏怎么保证"从 Java 安全进入 VM 再回来"、调用点怎么留证据(anchor)、计数与 OSR 怎么触发编译、以及解释器帧的 OopMap 缓存长什么样。

[实证:] Temurin OpenJDK 11.0.32: 解释器代码生成只要 **0.65ms**(startuptime 日志 "Interpreter generation, 0.0006472 secs");默认阈值 Tier3=2000/Tier4=15000(PrintFlagsFinal,见 materials/commands/08-interpreter-counterdemo.txt 附注);一个 3 万次调用的循环出现完整编译链(08-interpreter-counterdemo.txt): `tier 3`(C1 带 profiling)→ `% tier 4`(OSR,在循环 bci 4 处替换)→ `tier 4` 正常入口 → 旧版 `made not entrant`——这正是本篇计数机制的产物。

## 1. IRT_ENTRY: 从 Java 到 VM 的通道

### 入口宏: 不是 JRT_ENTRY,是 IRT_ENTRY

解释器 runtime 的入口都用 **IRT_ENTRY 家族**宏包装(interfaceSupport.inline.hpp:441-466,截取核心,逐字):

```cpp
// interfaceSupport.inline.hpp:441-466(截取核心,逐字)
// Definitions for IRT (Interpreter Runtime)
// (thread is an argument passed in to all these routines)

#define IRT_ENTRY(result_type, header)                               \
  result_type header {                                               \
    MACOS_AARCH64_ONLY(ThreadWXEnable __wx(WXWrite, thread));        \
    ThreadInVMfromJava __tiv(thread);                                \
    VM_ENTRY_BASE(result_type, header, thread)                       \
    debug_only(VMEntryWrapper __vew;)

...

#define IRT_ENTRY_NO_ASYNC(result_type, header)                      \
  result_type header {                                               \
    MACOS_AARCH64_ONLY(ThreadWXEnable __wx(WXWrite, thread));        \
    ThreadInVMfromJavaNoAsyncException __tiv(thread);                \
    VM_ENTRY_BASE(result_type, header, thread)                       \
    debug_only(VMEntryWrapper __vew;)

#define IRT_END }
```

大纲常写 "JRT_ENTRY"——那是 JNI 通道的宏(interfaceSupport.inline.hpp:468)。**JRT_ENTRY 与 IRT_ENTRY 的宏体几乎相同**(都是 `ThreadInVMfromJava` + `VM_ENTRY_BASE`),区别在用途语义: JRT 供 JNI/runtime 侧、IRT 专供解释器 runtime;真正禁用异步异常的是 **IRT_ENTRY_NO_ASYNC**(monitorenter 等用,`ThreadInVMfromJavaNoAsyncException`,析构不检查异步异常/挂起)。宏展开后每个入口函数体是:

1. `ThreadInVMfromJava __tiv(thread)`——RAII 状态转换: 构造函数 `trans_from_java(_thread_in_vm)` 把线程状态从 Java 切到 VM(interfaceSupport.inline.hpp:224-232),析构函数切回 Java 并检查特殊退出条件;
2. `VM_ENTRY_BASE`(:424-429)——`HandleMarkCleaner`(handle 生命周期管理)、`Thread* THREAD = thread`(CHECK 宏用的约定别名)、`os::verify_stack_alignment`;
3. `IRT_END` 的 `}` 闭合。

**关键设计 (斜体)**: *"安全进入 VM" = 状态机先行。Java 态的线程禁止阻塞(GC/锁等待都会卡死整个 JVM),`_thread_in_vm` 态才允许走到 safepoint/阻塞代码。模板侧只是 `call` 一条指令,真正的"身份切换"全在这两个宏里——RAII 保证异常路径也能正确切回。这也是 17-02 状态机的解释器侧入口。*

### at_safepoint: 空函数,但 IRT_END 会检查

02 篇第 6 段生成的 safepoint 入口指向 `InterpreterRuntime::at_safepoint`(interpreterRuntime.cpp:1176-1191,截取核心,逐字):

```cpp
// interpreterRuntime.cpp:1176-1191(截取核心,逐字)
IRT_ENTRY(void, InterpreterRuntime::at_safepoint(JavaThread* thread))
  // We used to need an explict preserve_arguments here for invoke bytecodes. However,
  // stack traversal automatically takes care of preserving arguments for invoke, so
  // this is no longer needed.

  // IRT_END does an implicit safepoint check, hence we are guaranteed to block
  // if this is called during a safepoint

  if (JvmtiExport::should_post_single_step()) {
    // We are called during regular safepoints and when the VM is
    // single stepping. If any thread is marked for single stepping,
    // then we may have JVMTI work to do.
    LastFrameAccessor last_frame(thread);
    JvmtiExport::at_single_stepping_point(thread, last_frame.method(), last_frame.bcp());
  }
IRT_END
```

函数体几乎为空——**safepoint 检查在状态转换本身**: `ThreadStateTransition::transition` 里"从→过渡态→序列化→`SafepointMechanism::block_if_requested`→到"三步走(interfaceSupport.inline.hpp:111-123),构造(Java→VM)与析构(VM→Java)各做一遍(注释 "IRT_END does an implicit safepoint check" 说的是析构那一次)。02 篇的轮询点把执行器引到这里,这里利用状态转换完成真正等待。

## 2. 调用点: 模板怎么把证据留好

### call_VM_base: 进 anchor,出检查

模板侧的 `call_VM` 最终走到 MacroAssembler::call_VM_base(macroAssembler_x86.cpp:2482-2550,截取核心,逐字):

```cpp
// macroAssembler_x86.cpp:2513-2525(截取核心,逐字)
  // push java thread (becomes first argument of C function)

  NOT_LP64(push(java_thread); number_of_arguments++);
  LP64_ONLY(mov(c_rarg0, r15_thread));

  // set last Java frame before call
  assert(last_java_sp != rbp, "can't use ebp/rbp");

  // Only interpreter should have to set fp
  set_last_Java_frame(java_thread, last_java_sp, rbp, NULL);

  // do the call, remove parameters
  MacroAssembler::call_VM_leaf_base(entry_point, number_of_arguments);
```

三条动作: ①LP64 下把 `r15_thread` 放进 c_rarg0——**C 函数的第一个参数永远是** `JavaThread*`;②`set_last_Java_frame` 把当前的 sp/fp 记进线程的 JavaFrameAnchor(24-01 拆过: 栈遍历的起点)——C++ 侧 `thread->last_frame()` 就是从 anchor 取,注意 pc 参数传 NULL 时不写 anchor 的 pc(macroAssembler_x86.cpp:799-802 "last_java_pc is optional");③`call_VM_leaf_base` 直接调用。返回后 `reset_last_Java_frame` 清 anchor(:2549),再检查 popframe/earlyret(JVMTI),最后 `check_exceptions` 看线程的 pending_exception——非空就跳 `StubRoutines::forward_exception_entry()`(异常转发桩,:2556-2568);若模板声明了结果寄存器,尾部 `get_vm_result` 把线程里的 vm_result 读到寄存器并清零(:2572-2574)——这就是模板侧"取回 C++ 结果"的机制。

**关键设计 (斜体)**: *"调用前留证据"让 C++ 侧什么都不用猜: `LastFrameAccessor`(interpreterRuntime.cpp:76-113)构造时 `thread->last_frame()` 一次取回帧,method/bcp/bci/cpCache entry/callee_receiver 全都能查——这就是为什么 runtime 函数签名只需要 `(JavaThread*, ...)`,不需要传帧指针。*

## 3. 三个典型入口: new、ldc、monitorenter

### new: 解析→校验→初始化→分配

`InterpreterRuntime::_new`(interpreterRuntime.cpp:217-243,截取核心,逐字):

```cpp
// interpreterRuntime.cpp:217-243(截取核心,逐字)
IRT_ENTRY(void, InterpreterRuntime::_new(JavaThread* thread, ConstantPool* pool, int index))
  Klass* k = pool->klass_at(index, CHECK);
  InstanceKlass* klass = InstanceKlass::cast(k);

  // Make sure we are not instantiating an abstract klass
  klass->check_valid_for_instantiation(true, CHECK);

  // Make sure klass is initialized
  klass->initialize(CHECK);

  ...
  oop obj = klass->allocate_instance(CHECK);
  thread->set_vm_result(obj);
IRT_END
```

四步: `pool->klass_at` 解析类常量(未加载则触发加载)→ 校验非抽象类 → `klass->initialize`(类初始化,可递归)→ `allocate_instance` 分配。结果 `thread->set_vm_result(obj)`——模板返回后从 `vm_result` 寄存器取回。注释解释了**快路径改写**: 类完全初始化后把 `new` 改写成 fast 版本(与 01 篇的重写机制呼应;带 finalizer/断点时故意不改写)。

### ldc: 常量解析,结果分两次放回

`ldc`(:148-160)走 LastFrameAccessor 拿方法/常量池,`pool->klass_at` 解析类常量,`set_vm_result(java_class)`。注意模板侧的分派: 只有常量池 tag 是 UnresolvedClass/UnresolvedClassInError/Class 才 call runtime(templateTable_x86.cpp:366-381),数字/字符串由模板直接处理。真正复杂的解析在 `resolve_ldc`(:161-215): `Bytecode_loadconstant::resolve_constant` 解析(含 condy 与 null sentinel 处理),非 fast_aldc 时还把**拆箱信息**装进 `vm_result_2`(TosState 移位 + 值偏移,解释器用它从装箱对象取原始值)。

### monitorenter: 偏斜→轻量→重量级

`monitorenter`(interpreterRuntime.cpp:749-767,截取核心,逐字):

```cpp
// interpreterRuntime.cpp:753-767(截取核心,逐字)
  if (PrintBiasedLockingStatistics) {
    Atomic::inc(BiasedLocking::slow_path_entry_count_addr());
  }
  Handle h_obj(thread, elem->obj());
  assert(Universe::heap()->is_in_reserved_or_null(h_obj()),
         "must be NULL or an object");
  if (UseBiasedLocking) {
    // Retry fast entry if bias is revoked to avoid unnecessary inflation
    ObjectSynchronizer::fast_enter(h_obj, elem->lock(), true, CHECK);
  } else {
    ObjectSynchronizer::slow_enter(h_obj, elem->lock(), CHECK);
  }
```

19 域拆过的锁三态在这里汇合: `UseBiasedLocking` 时 `fast_enter`(偏斜→轻量→膨胀逐级尝试),否则 `slow_enter`。入口用 **IRT_ENTRY_NO_ASYNC**(monitorenter 不允许异步异常打断——锁进入必须原子完成)。

## 4. InvocationCounter: 计数到阈值,不是递减到零

### 32 位计数器的布局

计数器是方法元数据里的一个 32 位字(invocationCounter.hpp:40-45,截取核心,逐字):

```cpp
// invocationCounter.hpp:40-45(截取核心,逐字)
class InvocationCounter {
  friend class VMStructs;
  friend class JVMCIVMStructs;
  friend class ciReplay;
 private:                             // bit no: |31  3|  2  | 1 0 |
  unsigned int _counter;              // format: [count|carry|state]
```

高 29 位是 count、第 2 位 carry、低 2 位 state。**计数是"递增到阈值"**——`increment()` 每次 `+= count_grain`(8),到达阈值触发;不是大纲说的"从 CompileThreshold 递减到 0"。阈值是静态变量 `InterpreterInvocationLimit`/`InterpreterBackwardBranchLimit`(invocationCounter.cpp:81-82),初始化时从 CompileThreshold 换算: InvocationLimit = CompileThreshold << 3(对齐计数器的 3 位状态区,:148),BackwardBranchLimit 还掺入 OnStackReplacePercentage 与 InterpreterProfilePercentage(:156-158)。

### 方法入口: 增量 + 掩码节流 + 溢出

方法进入解释器时 generate_normal_entry 里的 generate_counter_incr(templateInterpreterGenerator_x86.cpp:385-440)干活:

- **TieredCompilation 下**: `increment_mask_and_jump`(interp_masm_x86.cpp:1956-1967)——计数器 +8 写回,`andl(scratch, mask)` 后 `jcc(zero)` 跳溢出;**mask 编码"每 `2^k` 次才真正触发一次溢出判断"**(注释: "checking for negative value instead of overflow so we have a 'sticky' overflow test",:379-382)——这就是 `Tier*InvokeNotifyFreqLog` 通知频率的机械实现;
- **非 tiered**: 直接把 invocation + backedge 两个计数器求和,与 `InterpreterInvocationLimit` 比较(aboveEqual → overflow);
- 溢出 → generate_counter_overflow → 调 `InterpreterRuntime::frequency_counter_overflow`。

[实证:] 默认阈值(PrintFlagsFinal): `CompileThreshold=10000`(非 tiered 用)、**Tier3CompileThreshold=2000**、**Tier4CompileThreshold=15000**、`InterpreterProfilePercentage=33`。大纲的"C1=5000"是更早版本的数值。

### 回边: 只有向后分支计数

循环回边(向后分支)在分支模板里单独计数(templateTable_x86.cpp:2191-2200,截取核心,逐字):

```cpp
// templateTable_x86.cpp:2191-2200(截取核心,逐字)
  if (UseLoopCounter) {
    // increment backedge counter for backward branches
    // rax: MDO
    // rbx: MDO bumped taken-count
    // rcx: method
    // rdx: target offset
    // r13: target bcp
    // r14: locals pointer
    __ testl(rdx, rdx);             // check if forward or backward branch
    __ jcc(Assembler::positive, dispatch); // count only if backward branch
```

`testl(rdx, rdx)` 看分支偏移正负——**只有负偏移(向后跳,即循环回边)才计数**,if/else 的正向跳转不碰计数器。MethodCounters 懒创建(缺了先调 `build_method_counters`),tiered 下优先用 MDO 的 backedge 计数器+掩码(:2226-2231),溢出跳 `backedge_counter_overflow` → frequency_counter_overflow(OSR 请求,`branch_bcp` 非空)。

### frequency_counter_overflow: 策略决策 + OSR

溢出处理链(frequency_counter_overflow :1008-1045 + inner :1045-1108): `CompilationPolicy::policy()->event(method, ...)`(tiered 的 TieredThresholdPolicy 决策,决定编译层级)——这是 13-jit 域的主题,本篇只看解释器侧: **OSR 请求**(branch_bcp 非空)成功时,先强制 revoke 当前激活里所有有偏锁(:1072-1094,BasicObjectLock 要在 OSR 迁移中重建,偏斜状态会挡住迁移),再返回 osr nmethod 的入口地址,解释器在回边直接跳进编译代码——不经过方法入口,这就是 `%` 标记的 on-stack replacement。

[实证:] 08-interpreter-counterdemo.txt 的完整链条: `96 3 CounterDemo::sum`(tier 3)→ `97 % 4 ... @ 4`(OSR 进 tier 4,循环 bci 4)→ `98 4`(tier 4 正常入口)→ `96 made not entrant`(tier 3 版本废弃)——解释器计数驱动 C1 先编译,回边计数驱动 OSR 换 C2,全程无人工干预。

## 5. OopMapCache: 32 槽固定哈希,不是 LRU

### 结构: 每槽 2 位,3 步探测

解释器帧的 OopMap 缓存(24-01 铺垫过 per-Klass 挂载)本体在 oopMapCache.hpp:146-157(截取核心,逐字):

```cpp
// oopMapCache.hpp:146-157(截取核心,逐字)
class OopMapCache : public CHeapObj<mtClass> {
 static OopMapCacheEntry* volatile _old_entries;
 private:
  enum { _size        = 32,     // Use fixed size for now
         _probe_depth = 3       // probe depth in case of collisions
  };

  OopMapCacheEntry* volatile * _array;

  unsigned int hash_value_for(const methodHandle& method, int bci) const;
  OopMapCacheEntry* entry_at(int i) const;
  bool put_at(int i, OopMapCacheEntry* entry, OopMapCacheEntry* old);
```

**不是 LRU,没有 OopMapCacheSize flag**——固定 32 槽哈希表、冲突线性探测 3 步(注释 "Use fixed size for now")。大纲的"LRU + ~1024 entry per thread"是编造。每条 `OopMapCacheEntry` 是 2 位/槽的位图: 第 0 位 oop、第 1 位 dead(oopMapCache.hpp:76-78),`is_oop(offset)`/`is_dead(offset)`(:139-140)直接位测试。

### 完整链路: 01 篇的 can_trap 在这里收尾

整条链在 24-01 拆过: `Method::mask_for(method.cpp:237)` → `OopMapCache::compute_one_oop_map`(oopMapCache.cpp:597)→ `OopMapForCacheEntry`(:72,GenerateOopMap 子类)跑指令流分析。本篇补上 01 篇的伏笔: 分析里每过一个 can_trap 指令都要按 `do_exception_edge` 合并异常边状态(generateOopMap.cpp:1178)——多数 clvm 调用点(ldc/invoke/field 访问等)同时是 can_trap 点,它们的 OopMap 描述"调用瞬间解释器栈/局部变量里哪些槽是 oop"——GC 在 runtime 调用中扫描栈时,就靠这张图识别解释器帧的引用(24-01 的 oops_do 消费者)。注意 can_trap 与 calls_vm 是独立标志(01 篇的 def 表里 `iload` 有 clvm 位但 can_trap=false),别混为一谈。cache 的意义: 同一方法反复执行,分析只做一次,之后 `lookup(method, bci)` 直接命中(oopMapCache.cpp:172)。

## 核心悬念

解释器调 C++ 的通道拆完了: IRT_ENTRY 宏(Java→VM 状态转换 + HandleMark + 隐式 safepoint 检查)、调用点的 anchor 证据与 vm_result 回传、new/ldc/monitorenter 三个典型入口、计数到阈值(tiered 掩码节流 + 回边计数 + OSR 换层)、32 槽固定哈希的 OopMapCache。解释器侧到此闭环: 定义表、模板生成、dispatch、runtime 通道,一个完整的执行引擎。

但注意 03 篇反复出现的两个词: `pool->klass_at`、`LinkResolver::resolve_invoke`——**解析**。`invokevirtual` 模板执行时,方法还没定位、vtable 还没进 cpCache、getfield 的字段偏移还没算——这些"符号→直接引用"的工作是解释器执行链的最后一环,也是 JIT 编译的前提。下一篇拆它: LinkResolver 怎么从符号引用一步步走到 `Method*`/字段偏移,以及 Rewriter 为什么要在类加载时先做一遍字节码重写。

> → [08-interpreter/04 — LinkResolver + Rewriter](04-linkresolver-rewriter.md)
