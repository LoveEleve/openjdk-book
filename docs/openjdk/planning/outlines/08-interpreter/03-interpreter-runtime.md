# 03. InterpreterRuntime — 解释器调 C++

> 🟡 Working | 13 KP 中的 3 个 runtime 机制
> 读者处境: `new`——TemplateInterpreter 不自己做——它调 C++ `InterpreterRuntime::_new()`——分配+初始化。
>
> ⚠️ 写作期修正(2026-08-13, vol-02/08-interpreter/03 已按真实源码成文 244 行,本大纲为规划期产物,机制描述以文章为准):
> - **"JRT_ENTRY 宏(save caller frame→ThreadInVMfromJava transition)" 错**: 解释器 runtime 是 **IRT_ENTRY 家族**(interfaceSupport.inline.hpp:441-466: IRT_ENTRY/IRT_ENTRY_NO_ASYNC/IRT_LEAF/IRT_END),JRT_ENTRY 是 JNI 通道(:468);JRT 与 IRT 宏体几乎相同,真正禁用异步异常的是 **IRT_ENTRY_NO_ASYNC**(ThreadInVMfromJavaNoAsyncException,monitorenter 用);宏体=ThreadInVMfromJava RAII 状态转换(trans_from_java,:224-232)+VM_ENTRY_BASE(HandleMark/THREAD/栈对齐,:424-429);**safepoint 检查在 ThreadStateTransition::transition 内**(interfaceSupport.inline.hpp:111-123: 过渡态→serialize_thread_state→SafepointMechanism::block_if_requested→到态,构造与析构两向都有;at_safepoint :1176-1191 函数体近空)
> - **"OopMapCache——LRU + hash + OopMapCacheSize ~1024 per thread" 编造**: 固定 **32 槽哈希 + 3 步冲突探测**(oopMapCache.hpp:149-151 "Use fixed size for now"),无 LRU、无 OopMapCacheSize flag(PrintFlagsFinal 无此项);每槽 2 位(oop_bit/dead_bit,:76-78),is_oop/is_dead 位测试(:139-140);lookup(method,bci);compute_one_oop_map(oopMapCache.cpp:597)→OopMapForCacheEntry(:72)指令流分析(24-01 铺垫的链)
> - **"InvocationCounter 从 CompileThreshold 递减→check 0" 错**: **递增到阈值**——_counter 32 位 [count(29)|carry(1)|state(2)](invocationCounter.hpp:40-45),increment 每次 += count_grain(8);阈值=静态变量 InterpreterInvocationLimit=CompileThreshold<<3(invocationCounter.cpp:148)、InterpreterBackwardBranchLimit 掺 OnStackReplacePercentage/InterpreterProfilePercentage(:156-158)
> - **"CompileThreshold 默认 C1=5000, C2=15000" 错**: JDK11 tiered 默认 **Tier3CompileThreshold=2000/Tier4CompileThreshold=15000/Tier2CompileThreshold=0**/CompileThreshold=10000(非 tiered)/InterpreterProfilePercentage=33(实证 PrintFlagsFinal,08-interpreter-counterdemo.txt)
> - **"每次 invoke→frequency_counter_overflow→check 0" 错**: 方法入口 generate_counter_incr(templateInterpreterGenerator_x86.cpp:385-440): tiered 用 increment_mask_and_jump 掩码节流(sticky overflow 注释 :379-382,Tier*InvokeNotifyFreqLog 的机械实现);非 tiered 求 invocation+backedge 和与 InterpreterInvocationLimit 比较;溢出→frequency_counter_overflow(:1008)→inner(:1045)→**CompilationPolicy::policy()->event(:1065)**(tiered 策略,13-jit 主题);**OSR 成功先强制 revoke 激活内所有有偏锁(:1072-1094)**;回边**仅向后分支计数**(templateTable_x86.cpp:2191-2200 testl(rdx,rdx) 正负判断),MethodCounters 懒创建(build_method_counters)
> - **行号漂移**: ldc :148-160(仅类常量场景,模板侧分派 templateTable_x86.cpp:366-381 tag 检查)/resolve_ldc :161-215/_new :217-243(klass_at→check_valid_for_instantiation→initialize→allocate_instance→set_vm_result,注释含 fast 版改写)/monitorenter :749-767(IRT_ENTRY_NO_ASYNC,UseBiasedLocking→fast_enter 否则 slow_enter);大纲 "interpreterRuntime.hpp:50-200" 是 hpp 入口声明表(60+ 入口)
> - **模板侧 call_VM(大纲未提)**: interp_masm call_VM_base(interp_masm_x86.cpp:282-306 save_bcp/断言 last_sp/restore)→MacroAssembler::call_VM_base(macroAssembler_x86.cpp:2482-2550): **c_rarg0=r15_thread(C 函数第一参数永远 JavaThread*)**/set_last_Java_frame(sp,fp,pc=NULL——**pc=NULL 时不写 anchor 的 last_Java_pc**,:799-802)/call_VM_leaf_base/reset_last_Java_frame(:2549)/check_and_handle_popframe+earlyret/check_exceptions→StubRoutines::forward_exception_entry(:2556-2568)/**尾部 get_vm_result 读回 vm_result 并清零(:2572-2574,模板取回结果的机制)**;LastFrameAccessor(interpreterRuntime.cpp:76-113)=StackObj,构造 thread->last_frame(),method/bcp/cache_entry/callee_receiver 全可查
> - **实证**: "Interpreter generation, 0.0006472 secs"(startuptime,解释器生成 0.65ms);CounterDemo 完整链 tier3→`%`tier4@4(OSR)→tier4→made not entrant(08-interpreter-counterdemo.txt,30000 次调用)

### 1. InterpreterRuntime — C++ runtime 入口

场景: 解释器执行 `new`→template 生成 `call InterpreterRuntime::_new(thread, constantPool, index)`→C++ 分配对象→GC OopMap 记录新对象在栈上的位置。

**runtime entry 宏** (`interpreterRuntime.hpp:50-200` + `interpreterRuntime.cpp`):
- `JRT_ENTRY(result_type, name)`: 宏——save caller frame→enter VM→`ThreadInVMfromJava` transition→C++ code→leave VM→restore frame→return
- `ldc(bool wide)`: 从 cpCache 加载常量——int/float/String/Class—→push to interpreter stack
- `_new(JavaThread*, ConstantPool*, index)`: `InstanceKlass::allocate_instance(THREAD)`→init→return oop
- [C++: `JRT_ENTRY` + `JRT_END`——enter VM=卡 safepoint→ThreadState: _thread_in_Java→_thread_in_vm。safepoint 检查: 只有在 _thread_in_vm 时才能 block。解释器在 Java 模式下——不能 block——必须先转 VM 模式]
- [C++: `JavaCalls::call(result, method, args, THREAD)`——C++ 调 Java 方法。RESOLVE_INVOKE——先调 LinkResolver 解析→再用 JavaCall 调 callee。不是直接跳——需要 JavaCalls 设置 Java 帧]
- `monitorenter(JavaThread*, BasicObjectLock*)`: `ObjectSynchronizer::fast_enter()`→biased lock→stack lock→inflated lock

**OopMapCache** (`oopMapCache.hpp.cpp` + `oopMapCache.cpp`):
- `InterpreterOopMap`——每个方法的 OOP 位置 bitmask——哪个局部变量/栈元素是 OOP
- [C++: OopMapCache——LRU cache + hash(method)→OopMap。`method()->oop_maps()`——如果未生成→compute——遍历 bytecodes→每个字节码的 stack effect→推断所有执行点的 OOP 位置→store in cache。capacity = `OopMapCacheSize` (默认 ~1024 entry per thread)。GC 时——每种方法用其 OopMap 扫描解释器帧]

### 2. InvocationCounter — OSR 触发

**InvocationCounter** (`invocationCounter.hpp.cpp`):
- `_counter` (int): 从 `CompileThreshold` 递减——每次 invoke→`InterpreterRuntime::frequency_counter_overflow()`→check 0→JIT compile
- `backedge_counter`: loop backedge——每个 backedge→counter--→0→OSR compile——在循环中间切换到 JIT
- [C++: TieredCompilation——`TieredThresholdPolicy::event(method, bci, level)`——根据当前 counter 决定下一编译层级 (C1/C2)。C1 profile→C2 compile——counter 值不同——让热点方法先 C1、再 C2 (profiling data accumulated)]
- `CompileThreshold`: 默认 C1=5000, C2=15000 (with TieredCompilation)

---

### 核心悬念

**"解释器不自己做 new——call C++ runtime→JRT_ENTRY→set thread state→allocate→return。"** — JRT_ENTRY/JRT_END 管理 safepoint 安全。OopMapCache——LRU 缓存一个方法的 OOP 位置——避免每次 GC 重新计算。下一个: LinkResolver——符号→直接引用。

> → [04-linkresolver-rewriter.md](04-linkresolver-rewriter.md)
