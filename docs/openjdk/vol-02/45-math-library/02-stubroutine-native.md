# 02. StubRoutines 生成管道 — 2443 行汇编是怎么"造"出来的

> **前置依赖**:[45-math-library/01 — Math.sin 的 2443 行](01-poly-approximation.md):fast_sin 本体、C2 对它的调用、StrictMath 的 fdlibm 语义
> → **后续**:[48-utilities/01 — vmError 引擎](openjdk/vol-02/48-utilities/01-vmerror.md):crash 时这些 stub 的名字会出现在 hs_err_pid.log 里
> 关联域: 16-codecache(BufferBlob/CodeBuffer)、23-stub(StubRoutines 机制)、27-jni(JNI 完整链路)、42-core-native(native 方法解析)

## 一段 C++ 程序,在 JVM 启动时"执行"出机器码

上一篇看到的 2443 行 `fast_sin` 汇编,不是用汇编器编译出来的,而是 **JVM 启动时由 C++ 代码逐条"生成"的**:`generate_libmSin` 里调用 `__ fast_sin(...)`,每次调用都往一块内存里写入真实的指令字节。这篇回答三个问题:这段生成代码在启动的哪个时刻跑?生成的机器码放在哪、怎么被找到?StrictMath 的 JNI 路径和它是什么关系?

## 1. 两阶段生成:stub 赶在 universe 之前

### 1.1 场景:启动时间线上的一次插入

JVM 启动的初始化函数 `init_globals`(init.cpp:100)有一个严格顺序,其中两行插在关键位置:

```cpp
// init.cpp:106-111(截取核心,逐字)
  codeCache_init();
  VM_Version_init();
  os_init_globals();
  stubRoutines_init1();
  jint status = universe_init();  // dependent on codeCache_init and
                                  // stubRoutines_init1 and metaspace_init.
```

`stubRoutines_init1`(109 行)在 `universe_init`(110 行)**之前**执行,而 `universe_init` 的注释明说它依赖 stubRoutines。为什么拆两次?`initialize1` 上方的注释给出了原因:

```cpp
// stubRoutines.cpp:182-184(注释逐字)
// Note: to break cycle with universe initialization, stubs are generated in two phases.
// The first one generates stubs needed during universe init (e.g., _handle_must_compile_first_entry).
// The second phase includes all other stubs (which may depend on universe being initialized.)
```

**phase 1 的 stub 被 universe 初始化本身需要**(比如 `_handle_must_compile_first_entry`),phase 2 的其余 stub 反而依赖 universe——循环依赖用"两阶段"拆开。数学 stub 属于 **phase 1**(`generate_initial`,见第 2 节):它们只依赖静态常量数据,不碰 universe,所以赶在宇宙创建前就位。

### 1.2 BufferBlob:CodeCache 里的一块"代码专属"内存

`initialize1`(stubRoutines.cpp:188-202)的完整动作:

```cpp
// stubRoutines.cpp:188-202(截取核心,逐字)
void StubRoutines::initialize1() {
  if (_code1 == NULL) {
    ResourceMark rm;
    TraceTime timer("StubRoutines generation 1", TRACETIME_LOG(Info, startuptime));
    _code1 = BufferBlob::create("StubRoutines (1)", code_size1);
    if (_code1 == NULL) {
      vm_exit_out_of_memory(code_size1, OOM_MALLOC_ERROR, "CodeCache: no room for StubRoutines (1)");
    }
    CodeBuffer buffer(_code1);
    StubGenerator_generate(&buffer, false);
    // When new stubs added we need to make sure there is some space left
    // to catch situation when we should increase size again.
    assert(code_size1 == 0 || buffer.insts_remaining() > 200, "increase code_size1");
  }
}
```

三步:① `BufferBlob::create` 在 CodeCache 里申请一块固定大小的区域(phase 1 是 30000 字节,phase 2 是 46300 字节——stubRoutines_x86.hpp:35-36,注释写着"simply increase if too small (assembler will crash if too small)");② 用这块区域构造 `CodeBuffer`(生成代码的"画布");③ `StubGenerator_generate(&buffer, false)` 跑生成器。`initialize2`(275-288 行)是同样的形状,只是换 `"StubRoutines (2)"` 和 `true`。生成完还有一道哨兵断言:`insts_remaining() > 200`——生成器写完至少还要剩 200 字节,防止将来加了 stub 不加大容量时悄悄越界(注释:assembler 会直接 crash,所以这里主动抓)。

- [C++: `BufferBlob` 是 `RuntimeBlob` 的子类(codeBlob.hpp:383)——CodeCache 里无方法元数据的"裸代码块";`BufferBlob::create` 在 `CodeCache_lock` 下经 `operator new` 走 `CodeCache::allocate(size, CodeBlobType::NonNMethod)`(codeBlob.cpp:224-237、264-267);`CodeBuffer` 是生成器的临时缓冲区(指令区/数据区/重定位区),生成完的机器码就在 blob 里,`_code1`/`_code2` 两个静态指针持有它们]
- [x86: `VM_Version_init`(init.cpp:107)在 stubRoutines 之前——stub 生成器会根据 CPU 特性(SSE/AVX 等)生成不同的指令,所以必须等 CPU 探测完]

**关键设计 (斜体)**: *为什么"启动时生成"而不是编译期写好?三个理由都在时间线上:① 依赖运行时探测——VM_Version 的 CPU 特性、UseLibmIntrinsic 等开关,编译期的静态代码做不到;② 依赖运行时初始化——BufferBlob 要进 CodeCache,而 codeCache_init 也是启动期动作;③ 一次生成、全生命周期复用——启动时的一次性成本,换来的是所有 Java 线程、所有 JIT 编译代码直接调用。生成器本质是一个"运行时汇编器":把 C++ 的 `__ mulsd(...)` 调用解释成机器码字节写进 CodeBuffer,2443 行 C++ 代码在启动时"执行"一遍,就得到一份机器码。*

## 2. generate_libmSin:一个 stub 的诞生现场

### 2.1 场景:从函数指针到机器码的 40 行

`generate_libmSin` 是生成 sin stub 的 C++ 函数(stubGenerator_x86_64.cpp:5617-5656),它属于 `generate_initial`(5869 行起)里 5928-5968 那一段数学 stub 生成区(第一篇 §5 已引)——所以 sin 的 stub 在 **phase 1**、universe_init 之前就生成完毕:

```cpp
// stubGenerator_x86_64.cpp:5617-5656(截取核心,逐字)
  address generate_libmSin() {
    StubCodeMark mark(this, "StubRoutines", "libmSin");

    address start = __ pc();

    const XMMRegister x0 = xmm0;
    ...
    BLOCK_COMMENT("Entry:");
    __ enter(); // required for proper stackwalking of RuntimeStub frame

#ifdef _WIN64
    __ push(rsi);
    __ push(rdi);
#endif
    __ fast_sin(x0, x1, x2, x3, x4, x5, x6, x7, rax, rbx, rcx, rdx, tmp1, tmp2, tmp3, tmp4);

#ifdef _WIN64
    __ pop(rdi);
    __ pop(rsi);
#endif

    __ leave(); // required for proper stackwalking of RuntimeStub frame
    __ ret(0);

    return start;
  }
```

`__` 是 `_masm`(MacroAssembler)的宏别名。`__ enter()`(macroAssembler_x86.cpp:2965-2968,生成 `push rbp; mov rbp,rsp`)——注释强调 "required for proper stackwalking of RuntimeStub frame":这个 stub 被 JIT 直接 call(上一篇的 RC_LEAF),它不是 Java 方法,但**栈回溯时必须有标准 frame 结构**才能安全 unwind。`__ fast_sin(...)` 一个调用就把上一篇那 2443 行全部"写"进 CodeBuffer。最后 `return start` 返回机器码入口地址。

StubCodeMark 是这段代码的"登记册"(stubCodeGenerator.hpp:34-37、115-129):

```cpp
// stubCodeGenerator.hpp:34-37、115-118(注释逐字摘录)
// A StubCodeDesc describes a piece of generated code (usually stubs).
// This information is mainly useful for debugging and printing.
...
// All stub code generating functions that use a StubCodeMark will be registered
// in the global StubCodeDesc list and the generated stub code can be identified
// later via an address pointing into it.
```

StubCodeMark 是栈上对象:构造时 `new StubCodeDesc(group, name, pc)` 把描述符挂进全局链表,entry point 定义为 prolog 之后(stubCodeGenerator.cpp:109-115);析构时 `flush()` 并记下 end。于是每段生成的 stub 都有名字、起止地址——这个链表的用途非常具体:**crash 栈回溯时把裸地址翻译成名字**(frame.cpp:683-687),以及在 `PrintStubCode` 下用 Disassembler 解码打印(stubCodeGenerator.cpp:83-101):

```cpp
// frame.cpp:683-687(截取核心,逐字)
    } else if (StubRoutines::contains(pc())) {
      StubCodeDesc* desc = StubCodeDesc::desc_for(pc());
      if (desc != NULL) {
        st->print("v  ~StubRoutines::%s", desc->name());
```

你在 hs_err_pid.log 的 native frames 里看到的 `v ~StubRoutines::libmSin` 就是这么来的。`StubRoutines::contains` 判断地址是否落在两个 blob 里(stubRoutines.hpp:239-242):

```cpp
// stubRoutines.hpp:239-242(逐字)
  static bool contains(address addr) {
    return
      (_code1 != NULL && _code1->blob_contains(addr)) ||
      (_code2 != NULL && _code2->blob_contains(addr)) ;
  }
```

生成完成后,`StubRoutines::_dsin = generate_libmSin()`(stubGenerator_x86_64.cpp:5960),常量区地址注册(5932-5945,上一篇 1.3 的表、常量都在这里登记),整个管道闭合。

**关键设计 (斜体)**: *"名字链"这个设计经常被忽略,但它解决的是调试刚需:生成的代码没有源码、没有符号表,crash 时如果只给一个裸地址,开发者要拿 disassembler 手工比对——StubCodeDesc 用约 40 字节的开销,让任何 pc 地址反查名字。生成代码的"可调试性"从第一天就设计进去,而不是事后补。*

## 3. 调用侧:一个 NULL 哨兵,四条路径

### 3.1 场景:同一段机器码,谁在什么条件下用它

`StubRoutines::_dsin` 声明为 `static address _dsin`(stubRoutines.hpp:205),初始值 NULL(stubRoutines.cpp:161),生成后被赋成机器码地址。访问器 `StubRoutines::dsin()`(stubRoutines.hpp:382)。所有使用者都遵循同一个模式:**先查 NULL,有就用 stub,没有就 fallback**。

- C2:library_call.cpp:1878(上一篇 §5 已引):`StubRoutines::dsin() != NULL ? runtime_math(..., StubRoutines::dsin(), "dsin") : runtime_math(..., FN_PTR(SharedRuntime::dsin), "SIN")`
- C1:c1_LIRGenerator_x86.cpp:881-887:`VM_Version::supports_sse2() && StubRoutines::dsin() != NULL` 才 `call_runtime_leaf(StubRoutines::dsin(), ...)`
- 兜底 `SharedRuntime::dsin`(sharedRuntimeTrig.cpp:760):fdlibm 的 C++ 移植(第一篇 §4.2)
- **解释器没有数学 intrinsic**:解释器执行 Math.sin 的方法体,里面是对 StrictMath.sin 的 native 调用——直接走 JNI。所以"Math.sin 快"只在 JIT 编译后成立,解释器下 Math 和 StrictMath 同路。

**关键设计 (斜体)**: *"函数指针 + NULL fallback"是 JVM 里最常用的运行时多态:生成器想生成就生成,使用者永远有一个可用路径。这保证任何配置组合(开关关掉、平台不支持)下语义都正确,只是快慢不同。四个使用方(两个编译器、一个共享运行时、JNI)互不知晓对方,靠一个全局指针协调。*

## 4. Math 与 StrictMath:规范允许的"分家"

### 4.1 场景:两个看似一样的方法,为什么一个用 stub、一个走 JNI?

Math.java 的类注释把规则写得明明白白(38-50 行):

```java
// Math.java:38-50(注释逐字摘录)
 * <p>Unlike some of the numeric methods of class
 * {@code StrictMath}, all implementations of the equivalent
 * functions of class {@code Math} are not defined to return the
 * bit-for-bit same results.  This relaxation permits
 * better-performing implementations where strict reproducibility is
 * not required.
 *
 * <p>By default many of the {@code Math} methods simply call
 * the equivalent method in {@code StrictMath} for their
 * implementation.  Code generators are encouraged to use
 * platform-specific native libraries or microprocessor instructions,
 * where available, to provide higher-performance implementations of
 * {@code Math} methods.
```

一句话:**StrictMath 要求位级一致,Math 允许更快**。于是:

| 调用方 | 路径 | 结果来源 |
|---|---|---|
| `Math.sin`(JIT 编译,默认开关) | C2/C1 → stub | Intel libm 汇编,误差 ULP 量级 |
| `Math.sin`(JIT 编译,stub 未生成) | C2/C1 → `SharedRuntime::dsin` | fdlibm 的 C++ 移植 |
| `Math.sin`(解释器) | 方法体 → StrictMath.sin → JNI | fdlibm 的 C 版 |
| `StrictMath.sin`(任何情况) | JNI → `Java_java_lang_StrictMath_sin`(StrictMath.c:37-41)→ `jsin` | fdlibm 的 C 版 |

`Math.sin`(Math.java:152-155)标着 `@HotSpotIntrinsicCandidate`,C2 编译时把它整个方法体替换成对 stub 的调用;而 `StrictMath.sin`(StrictMath.java:125)是 native,永远是 JNI。JNI 侧的 `jsin` 来自 libfdlibm(src/java.base/share/native/libfdlibm/,第一篇 §1.4 的 k_sin.c 就在里面),StrictMath.c:37-41 的转发简单到只有一行:

```c
// StrictMath.c:37-41(逐字)
JNIEXPORT jdouble JNICALL
Java_java_lang_StrictMath_sin(JNIEnv *env, jclass unused, jdouble d)
{
    return (jdouble) jsin((double)d);
}
```

**关键设计 (斜体)**: *为什么 StrictMath 不用 stub?因为规范要求"与 fdlibm 算法逐位一致",而 stub 是同一族算法的独立实现,最后一位可能有差异——位级一致只能靠"就是那份代码"。反过来,Math 的 javadoc 明说"not defined to return the bit-for-bit same results"并鼓励平台实现,于是 JDK 把 Intel 的优化汇编放进来。**规范层区分语义(StrictMath 精确、Math 快速),实现层跟进(JNI 给精确的、stub 给快的)**——这是整本书反复出现的"语义与实现分离"。*

- [C++: JNI 的 native 方法靠**命名约定**静态解析:Java 的 `java.lang.StrictMath.sin` 对应符号 `Java_java_lang_StrictMath_sin`(JNI 规范);libjava 里的 StrictMath.c 按此命名,加载时由 JNI 链接。域 42-core-native 会拆完整的 native 方法解析]

## 5. Float/Double 的位操作:union 技巧与一条 movd

### 5.1 场景:floatToRawIntBits 到底做了什么

`Float.floatToRawIntBits(float)`(Float.java:810,native)要返回 float 的原始位模式。它有一个"折叠 NaN"的兄弟 `floatToIntBits`——差异全在 Java 侧(Float.java:767-773):

```java
// Float.java:767-773(逐字)
    @HotSpotIntrinsicCandidate
    public static int floatToIntBits(float value) {
        if (!isNaN(value)) {
            return floatToRawIntBits(value);
        }
        return 0x7fc00000;
    }
```

`floatToIntBits` 是 Java 代码:`isNaN` 检查 + 折叠成 canonical NaN `0x7fc00000`;`floatToRawIntBits` 是 native("NOT collapsing NaNs",Float.c:46 注释)。JNI 实现是教科书级的 union(Float.c:48-57):

```c
// Float.c:48-57(逐字)
/*
 * Find the bit pattern corresponding to a given float, NOT collapsing NaNs
 */
JNIEXPORT jint JNICALL
Java_java_lang_Float_floatToRawIntBits(JNIEnv *env, jclass unused, jfloat v)
{
    union {
        int i;
        float f;
    } u;
    u.f = (float)v;
    return (jint)u.i;
}
```

union 让同一个内存位置有两种"读法"——`u.f` 写进去、`u.i` 读出来,位模式原样,零转换。Double 侧对称(Double.c:51-61,同构的 union;中间的 `jdouble_to_jlong_bits` 在 unix/windows 是**空宏**——jlong_md.h:87-88、80-81,只是位拷贝的占位符;canonical NaN 是 `0x7ff8000000000000L`,Double.java:858)。

但和 Math.sin 一样,JIT 下这条路也被替换:vmSymbols.hpp:816/822 注册了 `_floatToRawIntBits`/`_doubleToRawLongBits` 的 intrinsic(C2 直接生成位搬运指令,连 JNI 的边界都省了)。

**关键设计 (斜体)**: *"位重解释"和"数值转换"是两种完全不同的操作:转换是数学(4.0 → 0x40800000 需要算),重解释是零成本(就是换个角度看同一串字节)。union 在 C 里是编译器保证的别名机制;Java 没有 union,于是 native + JNI 提供,然后 JIT 用 intrinsic 把这条路也抄近道。raw/canonical 两种 NaN 语义不是实现细节而是 API 契约——raw 保真、canonical 归一,调用方按需选择。*

## 核心悬念

"stub 生成时登记的 StubCodeDesc 名字链,让 hs_err_pid.log 的 native frames 里出现 `~StubRoutines::libmSin` 而不是裸地址——但整份 hs_err_pid.log 是谁写的?SIGSEGV 之后,VMError 的几十个 step 如何依次输出寄存器、栈、线程、内存映射,如何防止两个线程同时 crash 时日志互相覆盖?下一篇:vmError——1901 行的 crash 报告引擎。"

> → [48-utilities/01-vmerror.md](openjdk/vol-02/48-utilities/01-vmerror.md):hs_err_pid.log 生成引擎与 first-error token
