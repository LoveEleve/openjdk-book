# 02. System.arraycopy 为什么能比手写循环快 3 倍?— Arraycopy 向量化

> **前置依赖**:[23-stub/01 — StubRoutines 全局桩](01-stub-entry.md):本篇的桩就是 01 篇 `generate_all` 里那一行 arraycopy 生成的,_code2/StubCodeGenerator/StubCodeMark/参数寄存器约定都是它的骨架;[06-oops/03 — InstanceKlass 与数组](openjdk/vol-02/06-oops/03-instanceklass-arrayklass.md):数组头 16 字节、length 偏移与元素地址计算是桩的输入前提;[06-oops/05 — Access API](openjdk/vol-02/06-oops/05-access-api-barrier.md):对象数组拷贝的 GC 写屏障在本篇的 oop 变体里就地执行
> → **后续**:[23-stub/03 — AES、SHA、大数运算](03-crypto-math.md)
> 关联域: 02-assembler(机器码生成)、13-jit(ArrayCopyNode 分派)、25-gc(写屏障)

## 一个高频调用,启动时就备好的汇编

`System.arraycopy(src, 0, dst, 0, 1000000)` 是 JDK 内部的高频调用: 集合扩容、字符串拼接、流拷贝,一天被调上亿次。手写 for 循环让 C2 向量化也能拷贝,为什么还要专门的桩?因为桩在启动时就把最宽的向量拷贝循环生成了,编译代码到它只是**一条 call**;而手写循环即使被 C2 向量化,也受别名分析限制、要和边界检查混在一起,指令序列不如启动时预生成的专用桩。实测同一台机器上,1K 数组 arraycopy 比 C2 编译后的手写循环快 3.2 倍([实证: materials/commands/23-arraycopy-bench.txt])。这一篇拆开这套桩: 入口表怎么组织、向量化怎么分级、重叠怎么安全、对象数组为什么不能裸拷、fill 为什么比 copy 还快。

## 1. 入口表: 一个 arraycopy,四宽两向十几个桩

### 为什么不是"一个桩"

arraycopy 的参数只有 src/dst/位置/长度,但底层要按**元素宽度**挑最快的拷贝循环——byte 数组一次能拷 64 字节;引用数组每个元素 4/8 字节(看压缩 oop 开关),走同一套向量循环,但拷贝前后必须处理 GC 屏障。于是入口不是函数而是**一张表**,声明在 stubRoutines.hpp:126-137(截取核心,逐字):

```cpp
// stubRoutines.hpp:126-137(截取核心,逐字)
  // Leaf routines which implement arraycopy and their addresses
  // arraycopy operands aligned on element type boundary
  static address _jbyte_arraycopy;
  static address _jshort_arraycopy;
  static address _jint_arraycopy;
  static address _jlong_arraycopy;
  static address _oop_arraycopy, _oop_arraycopy_uninit;
  static address _jbyte_disjoint_arraycopy;
  static address _jshort_disjoint_arraycopy;
  static address _jint_disjoint_arraycopy;
  static address _jlong_disjoint_arraycopy;
  static address _oop_disjoint_arraycopy, _oop_disjoint_arraycopy_uninit;
```

第一组(无 disjoint 后缀)是 conjoint 桩——src/dst 可能重叠,桩内先测;第二组是 disjoint 桩——调用方已保证不重叠(或可降序),免测试直接正序。注释 "Leaf routines" 点明: 这些是**叶子例程**,被编译代码直接 call,不查 safepoint——纯内存操作,不建 C++ 运行时帧(只有栈回溯用的 enter/leave)。再往下还有两组: arrayof_* 变体(stubRoutines.hpp:143-152)假设 src/dst 都 HeapWord 对齐,以及三个"推荐但可选"的入口(stubRoutines.hpp:154-157,截取核心,逐字):

```cpp
// stubRoutines.hpp:154-157(截取核心,逐字)
  // these are recommended but optional:
  static address _checkcast_arraycopy, _checkcast_arraycopy_uninit;
  static address _unsafe_arraycopy;
  static address _generic_arraycopy;
```

### 生成: 4 个宽度 × 2 个方向

所有入口由 generate_arraycopy_stubs(stubGenerator_x86_64.cpp:2866)一次生成,8 个生成函数: byte/short/int_oop/long_oop 四宽,每宽 disjoint/conjoint 一对(:1473/:1576/:1676/:1792/:1884/:1980/:2081/:2177)。注意 **int_oop 和 long_oop 一个函数管两种**——is_oop 参数决定是否加 GC 屏障(§4),基本类型与引用数组共用同一套拷贝循环。jbyte 对的生成(stubGenerator_x86_64.cpp:2875-2878,截取核心,逐字):

```cpp
// stubGenerator_x86_64.cpp:2875-2878(截取核心,逐字)
    StubRoutines::_jbyte_disjoint_arraycopy  = generate_disjoint_byte_copy(false, &entry,
                                                                           "jbyte_disjoint_arraycopy");
    StubRoutines::_jbyte_arraycopy           = generate_conjoint_byte_copy(false, entry, &entry_jbyte_arraycopy,
                                                                           "jbyte_arraycopy");
```

**关键设计 (斜体)**: *disjoint 桩先生成,`entry` 记下它内部的"Entry:"标签;conjoint 桩把 disjoint 入口当 nooverlap_target 传给 overlap 测试——无重叠直接跳进 disjoint 主体。所以 conjoint 桩 = overlap 测试 + disjoint 桩,不是两套拷贝循环。arrayof_* 更极端: 生成函数的 aligned 参数标注 "ignored"(stubGenerator_x86_64.cpp:1456,conjoint 版 :1563 同),12 个 arrayof 入口全部别名到普通入口(stubGenerator_x86_64.cpp:2945-2962,注释 "We don't generate specialized code for HeapWord-aligned source arrays")——x86 上对齐假设换不来更快的代码。*

### 调用方怎么挑: 类型×对齐×方向的三维矩阵

C2 宏展开时调 select_arraycopy_function(stubRoutines.cpp:511-522,截取核心,逐字):

```cpp
// stubRoutines.cpp:511-522(截取核心,逐字)
// constants for computing the copy function
enum {
  COPYFUNC_UNALIGNED = 0,
  COPYFUNC_ALIGNED = 1,                 // src, dest aligned to HeapWordSize
  COPYFUNC_CONJOINT = 0,
  COPYFUNC_DISJOINT = 2                 // src != dest, or transfer can descend
};

// Note:  The condition "disjoint" applies also for overlapping copies
// where an descending copy is permitted (i.e., dest_offset <= src_offset).
address
StubRoutines::select_arraycopy_function(BasicType t, bool aligned, bool disjoint, const char* &name, bool dest_uninitialized) {
```

类型映射是**四宽共享**: boolean 并进 byte(T_BOOLEAN/T_BYTE→jbyte)、char 并进 short(T_CHAR/T_SHORT→jshort)、float 并进 int(T_INT/T_FLOAT→jint)、double 并进 long(T_DOUBLE/T_LONG→jlong),对象走 oop(T_ARRAY/T_OBJECT,带 dest_uninitialized 挑 uninit 变体)。aligned 命中挑 arrayof_* 别名,disjoint 命中挑 disjoint 桩——2×2×4 个格子加上 oop 的 uninit,就是基本类型矩阵的全部。其中 boolean 数组是 jbyte 桩(stubRoutines.cpp:536-543),char 数组是 jshort 桩(:544-550)——**JVM 不为 boolean 单独造轮子**,拷贝的机器语义和 byte 一样。

## 2. 向量化分级: 生成期定档,没有 rep_movsb

### 大纲说 rep_movsb,源码里没有

写大纲时以为 arraycopy 的顶级路径是 ERMSB 的 rep_movsb——**jdk11u 整个 x86 目录里没有 rep_movsb**(全库 grep 零命中)。rep_stosb 只用于 C2 生成的对象清零代码(§5),arraycopy 的向量化走的是另一条路: 按寄存器宽度分级。

### 分级真相: copy_bytes_forward

拷贝主体是宏函数 copy_bytes_forward(stubGenerator_x86_64.cpp:1246-1342,正向)与 copy_bytes_backward(:1354-1451,反向)。分级由**生成期的两个开关**决定——桩生成时代码路径就定死了,不是运行时跳转:

1. UseUnalignedLoadStores(SSE2+ 机器默认自动开,vm_version_x86.cpp:1294-1295): 决定用可不对齐的 movdqu/vmovdqu,还是退化为 movq;
2. UseAVX: 启动期 CPUID 探测写入(默认 3,globals_x86.hpp:121;探测甚至用一段 SEGV 测试验证 YMM/ZMM 跨信号处理能否恢复,vm_version_x86.cpp:363-368)。

UseAVX > 2(机器有 AVX-512)时,stub 里**同时嵌两条循环**,运行时按长度分派(stubGenerator_x86_64.cpp:1255-1283,截取核心,逐字):

```cpp
// stubGenerator_x86_64.cpp:1255-1283(截取核心,逐字)
      if (UseAVX > 2) {
        Label L_loop_avx512, L_loop_avx2, L_32_byte_head, L_above_threshold, L_below_threshold;

        __ BIND(L_copy_bytes);
        __ cmpptr(qword_count, (-1 * AVX3Threshold / 8));
        __ jccb(Assembler::less, L_above_threshold);
        __ jmpb(L_below_threshold);

        __ bind(L_loop_avx512);
        __ evmovdqul(xmm0, Address(end_from, qword_count, Address::times_8, -56), Assembler::AVX_512bit);
        __ evmovdqul(Address(end_to, qword_count, Address::times_8, -56), xmm0, Assembler::AVX_512bit);
        __ bind(L_above_threshold);
        __ addptr(qword_count, 8);
        __ jcc(Assembler::lessEqual, L_loop_avx512);
        __ jmpb(L_32_byte_head);

        __ bind(L_loop_avx2);
        __ vmovdqu(xmm0, Address(end_from, qword_count, Address::times_8, -56));
        __ vmovdqu(Address(end_to, qword_count, Address::times_8, -56), xmm0);
        __ vmovdqu(xmm1, Address(end_from, qword_count, Address::times_8, -24));
        __ vmovdqu(Address(end_to, qword_count, Address::times_8, -24), xmm1);
        __ bind(L_below_threshold);
        __ addptr(qword_count, 8);
        __ jcc(Assembler::lessEqual, L_loop_avx2);

        __ bind(L_32_byte_head);
        __ subptr(qword_count, 4);  // sub(8) and add(4)
        __ jccb(Assembler::greater, L_end);
      } else {
```

**关键设计 (斜体)**: *阈值分支是桩里唯一的运行时分派——AVX3Threshold 默认 4096 字节(globals_x86.hpp:224): 小拷贝用 512 位反而亏,因为 AVX-512 会压低主频、功耗翻倍,大拷贝才值得。AVX2 vs SSE2 的宽度之争则在生成期定死——UseAVX 是启动时 CPUID 的产物,桩只为这台机器生成一份,循环体里少一条跳转。*

分级总表: 512 位 evmovdqul(64 字节/迭代,仅大拷贝)→ 256 位 vmovdqu ×2(64 字节)→ 128 位 movdqu ×4(64 字节)→ 无 movdqu 时 movq ×4(32 字节)。每级循环体都是 64 字节/迭代——**用更宽的寄存器省指令数,而不是提高单次吞吐**。循环尾部另有 32 字节收尾(:1280-1318),并在 UseAVX>=2 时用 vpxor 清 YMM 高半(:1319-1323,注释 "clean upper bits of YMM registers")、出口 vzeroupper(:1550)——避免 AVX-SSE 切换的过渡惩罚。

### 负计数技巧

正向循环用**负索引计数**(stubGenerator_x86_64.cpp:1507-1509,截取核心,逐字):

```cpp
// stubGenerator_x86_64.cpp:1506-1509(截取核心,逐字)
    // Copy from low to high addresses.  Use 'to' as scratch.
    __ lea(end_from, Address(from, qword_count, Address::times_8, -8));
    __ lea(end_to,   Address(to,   qword_count, Address::times_8, -8));
    __ negptr(qword_count); // make the count negative
```

循环里不再加减指针,而是 `Address(end_from, qword_count, Address::times_8, -56)` 这种**一个寻址表达式同时用索引与位移**,每轮只 `addptr(qword_count, 8)`——省掉两个指针的更新,地址计算完全交给寻址硬件。

### 实证: 宽度之争的真实收益

实测(materials/commands/23-arraycopy-bench.txt,AMD EPYC 9K65,TencentKona 17,各 UseAVX 档独立 JVM,byte[] 拷贝):

| 数组大小 | UseAVX=0 | UseAVX=2 | UseAVX=3 | 手写循环(UseAVX=3) |
|---|---|---|---|---|
| 1K | 55.0 GB/s | 62.0 GB/s | 68.3 GB/s | 21.2 GB/s(3.2x) |
| 64K | 77.1 | 77.0 | 78.3 | 40.1(2.0x) |
| 4M | 39.5 | 39.6 | 40.2 | 44.7(0.9x) |
| 32M | 21.4 | 22.0 | 21.7 | 24.3(0.9x) |

三条结论: ①小数组(缓存驻留)是桩的舞台,1K 时比 C2 向量化的手写循环快 3.2 倍——"3x 加速"的出处;②SSE2→AVX2 的宽度收益在 1K 时 +24%(55→68 GB/s),64K 以上被抹平(77 vs 78);③4M/32M 数据超出缓存后两者都趋同于内存带宽瓶颈,指令宽度毫无意义。桩的设计者知道这一点,所以分级只在值得的地方生效。

## 3. 重叠: conjoint 必须倒着拷

### 测试: 几句汇编

conjoint 桩一进来先做 array_overlap_test(stubGenerator_x86_64.cpp:1173-1191,截取核心,逐字):

```cpp
// stubGenerator_x86_64.cpp:1173-1191(截取核心,逐字)
  void array_overlap_test(address no_overlap_target, Label* NOLp, Address::ScaleFactor sf) {
    const Register from     = c_rarg0;
    const Register to       = c_rarg1;
    const Register count    = c_rarg2;
    const Register end_from = rax;

    __ cmpptr(to, from);
    __ lea(end_from, Address(from, count, sf, 0));
    if (NOLp == NULL) {
      ExternalAddress no_overlap(no_overlap_target);
      __ jump_cc(Assembler::belowEqual, no_overlap);
      __ cmpptr(to, end_from);
      __ jump_cc(Assembler::aboveEqual, no_overlap);
    } else {
      __ jcc(Assembler::belowEqual, (*NOLp));
      __ cmpptr(to, end_from);
      __ jcc(Assembler::aboveEqual, (*NOLp));
    }
  }
```

语义就两句: `to <= from`(目标从头就不超过源)或 `to >= from+count`(目标完全在源后面)都无重叠 → 跳 disjoint 入口正序拷贝;否则重叠 → 走倒序循环。注释还点破一个特例: **降序拷贝时 `dest_offset <= src_offset` 也算 disjoint**(stubRoutines.cpp:519-520)——C2 证明不了重叠时,桩用几条指令现场测。

### 倒序: 同一套循环,索引方向反过来

copy_bytes_backward(stubGenerator_x86_64.cpp:1354-1451)与正向的宽度分级完全一致(512/256/128 位,64 字节/迭代),只是地址从 `[from + count*8 - 偏移]` 变成 `[from + count*8 + 0]` 从首端开始、索引递增——倒序循环不移动指针,从零偏移向高地址推进。conjoint 桩主体 = overlap 测试 + 这个倒序循环(conjoint_byte_copy :1598 测试,:1645 倒序)。

### 为什么手写循环做不到

C2 展开 System.arraycopy 时,只有两个偏移都是常量且 `src_off >= dst_off`(或两偏移相同)才敢声明 disjoint(basictype2arraycopy,macroArrayCopy.cpp:216-244,注释 "We can also treat a copy with a destination index less that the source index as disjoint since a low->high copy will work correctly in this case")——否则一律交给 conjoint 桩现场测。而普通手写循环里,C2 面对同一数组上可能重叠的读写,没有这个运行时判定,只能保守生成检查或退化。

[实证:] 重叠语义正确性——bench 输出 `overlap forward: 0 1 2 3 0 1 2 3 4 5 6 7 12 13 14 15`(materials/commands/23-arraycopy-bench.txt): 把 `ov[0..7]` 拷到 `ov[4..11]`（正方向重叠）,结果与 memmove 一致——源中被覆盖的部分用的是已复制的值,而不是被破坏后的值。

## 4. 对象数组: 不能裸拷

### barrier 包夹

对象数组的拷贝循环与 int/long 完全共用,is_oop 参数只改一处: 循环前后包上 GC 屏障。generate_disjoint_int_oop_copy(stubGenerator_x86_64.cpp:1913-1923,截取核心,逐字):

```cpp
// stubGenerator_x86_64.cpp:1913-1923(截取核心,逐字)
    DecoratorSet decorators = IN_HEAP | IS_ARRAY | ARRAYCOPY_DISJOINT;
    if (dest_uninitialized) {
      decorators |= IS_DEST_UNINITIALIZED;
    }
    if (aligned) {
      decorators |= ARRAYCOPY_ALIGNED;
    }

    BasicType type = is_oop ? T_OBJECT : T_INT;
    BarrierSetAssembler *bs = BarrierSet::barrier_set()->barrier_set_assembler();
    bs->arraycopy_prologue(_masm, decorators, type, from, to, count);
```

G1 下 prologue 是 SATB 预写屏障: 先检查本线程标记是否进行中(satb_mark_queue_active),只有并发标记阶段才动作——把目标范围内**被覆盖的旧引用**整段入 SATB 队列(整段一次运行时调用 write_ref_array_pre_oop_entry,压缩 oop 下换 _narrow_ 版,g1BarrierSetAssembler_x86.cpp:44);epilogue 是卡表标记(:1950)——06-05 的 Access API 在这里以汇编形式落地。uninit 变体(`_oop_arraycopy_uninit` 等)给"紧耦合的新分配数组"用: 目标内容还没初始化,没有旧引用可入队,prologue 整个被 `if (!dest_uninitialized)` 守卫跳过(g1BarrierSetAssembler_x86.cpp:46-48)——C2 在分配+拷贝合并时选它(ReduceBulkZeroing 路径,macroArrayCopy.cpp:302-325)。

### checkcast: 逐元素验类型,失败报数退出

两个数组元素类型不同且不能静态证明子类型时,走 checkcast 桩(generate_checkcast_copy,stubGenerator_x86_64.cpp:2293): 逐元素 load oop → 空值直接过 → load_klass → 子类型检查(generate_type_check :2258,fast path 用超级类缓存偏移 ckoff),循环主体(stubGenerator_x86_64.cpp:2420-2427,截取核心,逐字):

```cpp
// stubGenerator_x86_64.cpp:2420-2427(截取核心,逐字)
    // ======== loop entry is here ========
    __ BIND(L_load_element);
    __ load_heap_oop(rax_oop, from_element_addr, noreg, noreg, AS_RAW); // load the oop
    __ testptr(rax_oop, rax_oop);
    __ jcc(Assembler::zero, L_store_element);

    __ load_klass(r11_klass, rax_oop);// query the object klass
    generate_type_check(r11_klass, ckoff, ckval, L_store_element);
```

检查失败的返回协议是 **-1^K**(K=已成功拷过的元素数,stubGenerator_x86_64.cpp:2430-2438,注释 "Register rdx = -1 * number of *remaining* oops"): C2 拿到后恢复现场、把剩余部分交给慢路径(macroArrayCopy.cpp:577-578,注释 "The returned value is either 0 or -1^K, where K = number of partially transferred array elements")——**已拷的部分由桩顺手做完 GC 屏障,不浪费**。

### 谁在调用: 三条路

- **解释器**: System.arraycopy 是 native 方法,解释器直接 JNI → JVM_ArrayCopy(jvm.cpp:324-340)→ `s->klass()->copy_array` → C++ 拷贝(TypeArrayKlass::copy_array,typeArrayKlass.cpp:126,ArrayAccess 原子语义)——**解释器根本不用桩**;
- **C1**: do_ArrayCopy(c1_LIRGenerator.cpp:3054)→ emit_arraycopy(c1_LIRAssembler_x86.cpp:3049): 元素类型未知 → 存好参数调 generic 桩(它做全部检查再分派);类型已知 → 直接 call 对应宽度的桩;
- **C2**: vmIntrinsics::_arraycopy → inline_arraycopy(library_call.cpp:4743)→ ArrayCopyNode → 宏展开 generate_arraycopy(macroArrayCopy.cpp:278)→ basictype2arraycopy 定 aligned/disjoint → select_arraycopy_function 挑桩 → **make_leaf_call**(macroArrayCopy.cpp:1100): 叶子调用,无 safepoint 检查、不建运行时帧——桩是纯内存操作,oop 变体的屏障就地做,不需要进 safepoint。

## 5. fill: 广播一个值,纯写比拷贝还快

### 两段式生成

fill 桩(generate_fill,stubGenerator_x86_64.cpp:1756-1775)比 arraycopy 简单: 6 个入口(_jbyte/_jshort/_jint_fill 与 arrayof 版,:2937-2942),外层只是 enter + 一个宏 + vzeroupper,本体在 MacroAssembler::generate_fill(macroAssembler_x86.cpp:7447)。开头先把小值广播成 dword(macroAssembler_x86.cpp:7469-7482,截取核心,逐字):

```cpp
// macroAssembler_x86.cpp:7469-7482(截取核心,逐字)
  if (t == T_BYTE) {
    andl(value, 0xff);
    movl(rtmp, value);
    shll(rtmp, 8);
    orl(value, rtmp);
  }
  if (t == T_SHORT) {
    andl(value, 0xffff);
  }
  if (t == T_BYTE || t == T_SHORT) {
    movl(rtmp, value);
    shll(rtmp, 16);
    orl(value, rtmp);
  }
```

byte 值 0x5a 变成 0x5a5a5a5a,一次写 4 字节。不足 8 字节的短数组按元素填(:7484,注释 "Short arrays (< 8 bytes) fill by element"),大数组进向量循环——**fill 桩没有 rep_stosb**: 分级是 AVX-512 的 64 字节循环(vpbroadcastd + evmovdqul,同样受 AVX3Threshold 门控)、AVX2 的 64 字节(vpbroadcastd + vmovdqu ×2)、SSE2 的 32 字节(pshufd + movdqu)。AVX-512 段(macroAssembler_x86.cpp:7554-7576,截取核心,逐字):

```cpp
// macroAssembler_x86.cpp:7554-7576(截取核心,逐字)
        if (UseAVX > 2) {
          // Fill 64-byte chunks
          Label L_fill_64_bytes_loop_avx3, L_check_fill_64_bytes_avx2;

          // If number of bytes to fill < AVX3Threshold, perform fill using AVX2
          cmpl(count, AVX3Threshold);
          jccb(Assembler::below, L_check_fill_64_bytes_avx2);

          vpbroadcastd(xtmp, xtmp, Assembler::AVX_512bit);

          subl(count, 16 << shift);
          jccb(Assembler::less, L_check_fill_32_bytes);
          align(16);

          BIND(L_fill_64_bytes_loop_avx3);
          evmovdqul(Address(to, 0), xtmp, Assembler::AVX_512bit);
          addptr(to, 64);
          subl(count, 16 << shift);
          jcc(Assembler::greaterEqual, L_fill_64_bytes_loop_avx3);
          jmpb(L_check_fill_32_bytes);

          BIND(L_check_fill_64_bytes_avx2);
        }
```

### rep_stosb 在哪: C2 的对象清零

大纲以为 fill 用 rep_stosb——错了。**rep_stosb(ERMS)属于 C2 生成的对象清零代码**: ClearArray 节点在 x86_64.ad 里调 clear_mem 宏(x86_64.ad:11257),宏内 UseFastStosb 开着才用 rep_stosb,否则 UseXMMForObjInit 用 XMM 清零,再退 rep_stos(macroAssembler_x86.cpp:6012-6020)。UseFastStosb 默认 false,ERMS 机器自动开(vm_version_x86.cpp:1471-1479)——这台 AMD 实测是 false(PrintFlagsFinal),C2 清零走 XMM 路径。

[实证:] fill 是纯 store、不读内存,带宽优势比 copy 更明显——64K 填充 UseAVX=0(SSE2 32 字节)85.8 GB/s,UseAVX=2/3(64 字节)137-139 GB/s(23-arraycopy-bench.txt)。同样 64K 下 copy 只有 78 GB/s: 写比拷快,因为不需要加载。

### 一个反例: zero_aligned_words 不是桩

stubRoutines.hpp:166-167 声明 `_zero_aligned_words`("zero heap space aligned to jlong (8 bytes)")——看着像 zero 桩的一员。但它的默认值是 C++ 函数 Copy::zero_to_words(stubRoutines.cpp:110),x86 生成器从不覆盖它,整个 hotspot 树也找不到调用者。**声明 ≠ 有实现**: 表里有些入口是历史遗留,别看到名字就以为有汇编。

## 核心悬念

System.arraycopy 的桩拆完了: 入口表按 4 宽度 × 2 方向组织,8 个生成函数 + 12 个别名;向量化在生成期按 UseAVX 定档(SSE2/AVX2/AVX-512),唯一运行时分支是 AVX3Threshold=4096 字节——实测 1K 拷贝比手写循环快 3.2 倍,64K 以上被带宽抹平;重叠靠 array_overlap_test 现场判定,倒序循环复用同一套向量化;对象数组用 barrier 包夹,checkcast 失败报 -1^K 交给调用方;fill 广播值,纯写比拷贝还快。但 01 篇 generate_all 的清单里,和 arraycopy 并列的还有一批更神秘的名字: AES、SHA-1/256/512、GHASH、CRC32、BigInteger 乘法……它们也是手写汇编,而且靠 CPU 的专用指令。下一篇: Crypto 与 Math intrinsics。

> → [23-stub/03 — AES、SHA、大数运算](03-crypto-math.md)
