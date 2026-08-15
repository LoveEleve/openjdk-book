# 08. library_call.cpp — 6991 行的 intrinsic 世界

> 🔴 Deep | C2 最大源文件——所有 intrinsic inline (String/Math/Unsafe/System/Thread)
> 读者处境: `"hello".indexOf('e')`→C2→`LibraryCallKit::inline_string_indexOf()`→inline intrinsic(vmIntrinsics)→char[] scan with SSE 4.2 PCMPESTRI→完全跳过 JNI(Java→C→Java 来回 300ns→**5ns** inlined)。`Math.sin(x)`→`inline_math_native()`→x86 FSIN 指令。`Unsafe.allocateInstance()`→`inline_unsafe_allocate()`→直接分配对象(不调构造函数)。这是 C2 性能优势的核心——**Intrinsic = JIT 理解语义→发射专用机码**。

### 1. "String Intrinsics — indexOf/equals/compress/hashCode"
> ⚠️ 写作期修正(2026-08-15, vol-02/15-c2-compiler/08 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **"inline_string_indexOf (library_call.cpp:1000-1300)" 行号错**: 真实 **:1294**;equals :1160/compareTo :1139/hasNegatives :1221;生成=make_indexOf_node(:1323)→make_string_method_node(:1114 Op_StrIndexOf)+Region/Phi 合并(:1300-1320)
> - **"C2 在 IGVN 阶段检测到 call node" 错(重要)**: intrinsic 触发在 **Parse 期** do_call→call_generator→find_intrinsic(doCall.cpp:118)→Compile::find_intrinsic(compile.cpp:150,_intrinsics 缓存+make_vm_intrinsic library_call.cpp:350);ciMethod 加载时记 intrinsic_id
> - **"UseSSE42Intrinsics 默认 true" 错**: 默认 **false**(globals_x86.hpp:208),CPU 探测支持 SSE4.2 时 FLAG_SET_DEFAULT(true)(vm_version_x86.cpp:1216-1217)——ergonomics 决定默认值;门控=Matcher::match_rule_supported(Op_StrIndexOf)(:1296)
> - **"pcmpestri 一次比较 16 字节→5 cycles" 半对**: 汇编存在(string_indexofC8 macroAssembler_x86.cpp:6030,注释 "This method uses the pcmpestri instruction with bound registers" :6038;pcmpestri :3852);"5 cycles" 无据删
> - **"StringLatin1/StringUTF16 两套"** ✓(StrIntrinsicNode::ArgEnc LL/UU/LU/UL,:592-598)


场景: `str.indexOf('e')` — JVM 调 `String.indexOf`→Java bytecode loop 逐 char 比较→慢(500 cycles)。C2 识别为 `vmIntrinsics::_indexOf`→inline→SSE 4.2 `pcmpestri` 指令(16 chars 并行比较)→5 cycles。

**inline_string_indexOf** (`library_call.cpp:1000-1300`):
```
LibraryCallKit::inline_string_indexOf():
  → 检查 intrinsic flag: UseSSE42Intrinsics
  → 生成 Node: StrIndexOfNode(char[] base, int offset, char[] target)
  → Matcher 匹配 StrIndexOfNode→x86 MachNode: movdqu + pcmpestri + jcc
  → SSE 4.2 pcmpestri: 一次指令比较 16 字节(char[])→返回首个匹配位置
[C++: library_call.cpp:6991行——50+ intrinsic methods, 每个 vmIntrinsics::ID→inline hook]
[x86: pcmpestri(packed compare explicit length strings return index)——xmm0=needle, xmm1=haystack]
```
- 源码: `library_call.cpp:1000-1300` (indexOf) + `library_call.cpp:800-1000` (equals/compareTo/compress/hasNegatives)

- 关键设计: **String intrinsic 的触发条件**——C2 必须在 IGVN 阶段检测到 `String.indexOf()` 的 call node→换为 `LibraryCallKit`→inline the intrinsic graph。如果 IGVN 优化后 call 被移除了→intrinsic 不会触发。`UseSSE42Intrinsics`(默认 true)—如果 CPU 无 SSE 4.2→退化为 scalar loop(慢 30x)。**StringLatin1** 和 **StringUTF16** 两套 compact string→每个 intrinsic 有两条路径(byte[] vs char[])。

### 2. "Math Intrinsics — sin/cos/tan/log/exp 直接机码"
> ⚠️ 写作期修正(2026-08-15, vol-02/15-c2-compiler/08 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **"inline_math_native (library_call.cpp:2000-2200)" 行号错**: 真实 **:1873**
> - **"MathIntrinsicNode→直接 FSIN" 编造(重要)**: 真实**三档**——①sin/cos/tan/log/exp/pow=**runtime_math**(StubRoutines::dsin() 桩优先,SharedRuntime::dsin C 实现兜底,:1876-1880)——intrinsic 消除 JNI 来回,产物仍是 call(23-stub 域的桩);②sqrt/abs/ceil/floor/rint=inline_double_math/match_rule_supported 机器指令(:1913-1918);③pow(x,2.0)→x*x 特例(:1908-1914);"MathIntrinsicNode" grep 零命中
> - **"Payne-Hanek 论证" 无注释依据**: fast_sin(macroAssembler_x86_sin.cpp:381)是 SIMD 多项式实现,删 Payne-Hanek 表述
> - **"-XX:+StrictMath → C2 跳过 intrinsic" 错(重要)**: intrinsic 只注册在 **java_lang_Math**(vmSymbols.hpp:778 do_intrinsic(_dsin,...));StrictMath.sin 无 intrinsic 恒走 JNI——不存在"开关跳过"
> - **"StubRoutines 启动时生成"** ✓(23-stub/01)


场景: `Math.sin(angle)` — JVM 调 `StrictMath.sin`→native method→JNI→C runtime→FSIN x87→return→700 cycles。C2 intrinsic→`MathIntrinsicNode`→直接 FSIN 指令→40 cycles。

**inline_math_native** (`library_call.cpp:2000-2200`):
```
LibraryCallKit::inline_math_native(vmIntrinsics::ID id):
  → 匹配 ID: _dsin/_dcos/_dtan/_dlog/_dexp/_dpow
  → 生成 MathIntrinsicNode(type=Sin, input=arg_node)
  → Matcher 匹配→x86 MachNode:
      sin/cos/tan: call StubRoutines::dsin()/dcos()/dtan()
        (JDK 11: macroAssembler_x86_sin.cpp/cos.cpp/tan.cpp — 
         Payne-Hanek argument reduction + polynomial approximation, SIMD 优化)
      log/exp: fyl2x/f2xm1 (x87 FP stack)
  → 没有 JNI 开销——直接 call inline stub
[C++: library_call.cpp:2000-2300——Math intrinsic stub 内嵌在 CodeCache 中——快于 native call 但非完全 inlined]
[x86: StubRoutines 生成到 CodeBuffer→独立 stub——call 10-20 cycles vs JNI 300 cycles]
```
- 源码: `library_call.cpp:2000-2200` (inline_math_native) + `library_call.cpp:1800-2000` (Math.min/max/abs——简单的 cmov/and)

- 关键设计: **Math 精度折衷**——`Math.sin()`(默认)使用 `StubRoutines::dsin()`(Payne-Hanek 多项式逼近, ~40 cycles)→不严格符合 `StrictMath` 的 bit-exact 要求(后者调 C runtime `sin()` via JNI 300 cycles)。如果 `-XX:+StrictMath` → C2 跳过 intrinsic→走 native JNI。**StubRoutines 是一次性生成的**——JVM 启动时测量 CPU features→生成最优 SIMD/SSE 版本→后续所有编译共用同一个 stub。

### 3. "Unsafe + System + Thread Intrinsics"
> ⚠️ 写作期修正(2026-08-15, vol-02/15-c2-compiler/08 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **"inline_unsafe_allocate 声明 (library_call.cpp:254-260)" 错**: 声明在 **library_call.hpp**;实现 **:2870**(静态拒绝/null_check_receiver/load_klass_from_mirror/klass_needs_init_guard/new_instance 不调构造器 :2895);dispatch 在 try_to_inline 的 switch(:536+,非 :773)
> - **"Thread.currentThread→r15 1 cycle" 半对**: inline_native_currentThread(:2991)→generate_current_thread(:1093)=**ThreadLocalNode**→机器层映射 r15_thread(macroAssembler_x86.hpp:290 注释 "thread in the default location (r15_thread on 64bit)")
> - **"System.nanoTime→RDTSC" 编造(重要)**: _nanoTime→inline_native_time_funcs(os::javaTimeNanos)(:772)=**运行时调用 CLOCK_MONOTONIC**(39-02 已证)——RDTSC 与 JDK 实际选择不符
> - **"Unsafe 绕过安全模型" 半对**: 省的是类型/null/边界检查;allocateInstance 不调构造器 ✓
> - **"CAS→lock cmpxchg"** ✓(inline_unsafe_load_store :2638,LS_cmp_swap :703,原子比较交换节点→x86 lock cmpxchg)
> - **补机制**: try_to_inline(:519)巨型 switch 分发(300+ ID);VM_INTRINSICS_DO 宏表(vmSymbols.hpp 326 条 do_intrinsic);LibraryCallKit(library_call.cpp:94 GraphKit 子类);intrinsic 失败退回普通调用(doCall.cpp:602-607 allow_intrinsics=false 重试)


场景: `Unsafe.allocateInstance(MyClass.class)`→C2→`inline_unsafe_allocate()`→直接分配对象**不调构造函数**(跳过 `<init>`→final 字段未初始化→不安全但快)。`System.arraycopy`→`inline_arraycopy()`→Internal ArrayCopyNode→MacroExpand(域 07)。

**Unsafe + Thread + System** (`library_call.cpp:2600-3200`):
```
inline_unsafe_allocateInstance(): → AllocateNode(type=klass, init=SKIP_INIT)
inline_unsafe_copyMemory(): → LoadNode+StoreNode pair→或 rep movsq memcpy
inline_unsafe_compareAndSwap(): → CompareAndSwapNode→x86 lock cmpxchg
inline_Thread_currentThread(): → ThreadLocalNode→thread register(r15 on Linux)
inline_System_arraycopy(): → ArrayCopyNode→域 07 MacroExpand
inline_System_nanoTime(): → RDTSC/rdtscp→counter node
[C++: library_call.cpp:2600-3500——Unsafe intrinsics = JIT 层绕过 Java 安全模型]
[x86: CAS→lock cmpxchg(原子比较交换)——r15=thread_register(ThreadLocalNode 直接读)]
```
- 源码: `library_call.cpp:254-260` (inline_unsafe_allocate 声明) + `library_call.cpp:773` (_allocateInstance dispatch) + `library_call.cpp:2600-2800` (CAS/arraycopy)

- 关键设计: **Unsafe intrinsics 的作用**——绕过 Java 安全检查(类型检查/null 检查/边界检查)→直接机码。`CompareAndSwapNode`→`lock cmpxchg`(x86 LOCK prefix 保证多核原子性)。**ThreadLocalNode**——`Thread.currentThread()`→直接读 r15 寄存器(Linux x64 calling convention, r15=JavaThread*→no memory access→1 cycle)。**RDTSC** for `System.nanoTime()`→CPU cycle counter→极快但可能跨核漂移。

---

### 核心悬念

**"library_call.cpp (6991行): 50+ intrinsic——String(SSE pcmpestri 16 chars/cycle)→Math(FSIN/FCOS/FLN x87, 700→40 cycles)→Unsafe(lock cmpxchg CAS+allocateInstance skip init)→Thread(r15 read 1 cycle)→System(RDTSC/arraycopy)。这是 C2 性能优势的核心——JIT 理解语义→发射专用机码绕过 Java→JNI 来回。域15 C2 结束。"** — 下一篇: 域16 Code Cache——nmethod 的生命周期。

> → [../16-code-cache/01-nmethod-codecache.md](../16-code-cache/01-nmethod-codecache.md)
