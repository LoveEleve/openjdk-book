# 02. System.arraycopy() 在底层怎么跑？— Arraycopy 向量化

> 🔴 Deep | 2 KP 中的性能核心
> 读者处境: `System.arraycopy(src, 0, dst, 0, 1000000)` — JIT 生成 intrinsics(向量化 memcpy)还不够好——JVM 在启动时预生成了手写汇编桩，用 SSE/AVX 达到 ~3x 加速。
>
> ⚠️ 写作期修正(2026-08-13, vol-02/23-stub/02 已按真实源码成文 313 行,本大纲为规划期产物,机制描述以文章为准):
> - **"14 种变体/16 入口" 错**: 真实=stubRoutines.hpp:126-167 三组: conjoint 6(_jbyte/_jshort/_jint/_jlong/_oop/_oop_uninit_arraycopy,:128-132)+disjoint 6(:133-137)+**arrayof 12 别名(大纲没提,生成时 aligned 参数 "ignored" stubGenerator_x86_64.cpp:1462-1463,全部别名到普通入口 :2945-2962)**+可选 3(checkcast×2/unsafe/generic :154-157);8 个生成函数=4 宽(byte/short/int_oop/long_oop)×2 向(:1473/:1576/:1676/:1792/:1884/:1980/:2081/:2177),入口 generate_arraycopy_stubs :2866
> - **"generate_disjoint_copy/generate_conjoint_copy" 函数不存在(编造)**: 实际按宽度拆分 8 个;conjoint 桩=array_overlap_test(:1173-1191,to<=from 或 to>=end 无重叠)+跳入 disjoint 内部 entry(先生成 disjoint 存 entry,:2875-2878),重叠走 copy_bytes_backward(:1354-1451,同套向量化)
> - **"rep_movsb/ERMSB 分级" 全错(编造)**: jdk11u x86 全目录无 rep_movsb(grep 零命中);真实分级=生成期 UseAVX 定档(CPUID 探测,vm_version_x86.cpp:363-368 用 SEGV 测试 YMM/ZMM 跨信号恢复;UseAVX 默认 3 globals_x86.hpp:121;UseUnalignedLoadStores 默认开 :1294-1295): evmovdqul 512 位 64B→vmovdqu×2 256 位 64B→movdqu×4 128 位 64B→movq×4 32B;唯一运行时分支=AVX3Threshold(globals_x86.hpp:224 默认 4096)在 copy_bytes_forward :1255-1282
> - **"std; rep_movsb; cld 倒序" 错(编造)**: 倒序=copy_bytes_backward 同套向量循环;负计数技巧 :1507-1509(end=from+count*8-8,negptr 后寻址 [end+count*8-56] 省指针更新)
> - **"fill 用 rep_stosb" 错**: fill 桩(generate_fill :1756→MacroAssembler::generate_fill macroAssembler_x86.cpp:7447,先广播 dword :7469-7482,<8 字节逐元素 :7484)纯向量(vpbroadcastd+evmovdqul/vmovdqu,AVX3Threshold 门控 :7554-7576;SSE2 pshufd+movdqu 32B);**rep_stosb(ERMS,UseFastStosb,默认 false 自动开 vm_version_x86.cpp:1471-1479)属 C2 ClearArray 对象清零**(x86_64.ad:11257→clear_mem macroAssembler_x86.cpp:6012-6020)
> - **"_zero_aligned_words 是汇编桩" 错**: 是 C++ Copy::zero_to_words(stubRoutines.cpp:110),从不被 x86 生成器覆盖,全树无调用者——遗留入口
> - **"stubRoutines.hpp:128-157" 漂移**: :126-127 注释;conjoint :128-132;disjoint :133-137;arrayof :139-152;可选 :154-157;fill/zero :159-167;select_arraycopy_function 在 stubRoutines.cpp:522(映射: boolean→jbyte :536-543,char→jshort :544-550,float→jint,int 同,double→jlong,对象→oop 带 uninit)
> - **"stubGenerator_x86_64.cpp:600-900/900-1100/1100-1300" 行号全漂移**: array_overlap_test :1173;copy_bytes_forward :1246;copy_bytes_backward :1354;8 生成函数 :1473-2177;generate_fill :1756
> - **JIT 分派补充(大纲未提)**: C2=LibraryCallKit::inline_arraycopy(library_call.cpp:4743)→ArrayCopyNode→宏展开 generate_arraycopy(macroArrayCopy.cpp:278)→basictype2arraycopy(:216-244,常量偏移 src_off>=dst_off 判 disjoint)→select_arraycopy_function→make_leaf_call(:1100 叶子调用);C1=emit_arraycopy(c1_LIRAssembler_x86.cpp:3049,类型未知→generic);**解释器=JVM_ArrayCopy(jvm.cpp:324-340)→klass()->copy_array(typeArrayKlass.cpp:126)不用桩**;oop 变体 barrier 包夹(prologue=SATB 预屏障整段入队 g1BarrierSetAssembler_x86.cpp:44,uninit 跳过;epilogue=卡表标记);checkcast 失败返 -1^K(:2430-2438)
> - 实证: materials/commands/23-arraycopy-bench.txt(AMD EPYC 9K65,TencentKona 17,UseAVX 0/2/3 各档独立 JVM,byte[]): 1K arraycopy 55.0→68.3 GB/s(SSE2→AVX2 +24%),手写循环 21.2 GB/s=**3.2x**;64K 78.3 vs 40.1=2.0x;4M/32M 带宽瓶颈≈1.0x;64K fill AVX2/3 137-139 vs SSE2 85.8 GB/s

### 1. "14 种变体" — arraycopy entry table

场景: arraycopy 需要处理 8 种数据类型 × (conjoint overlap 路径 / disjoint 路径) = 理论上 16 个入口。每个入口是独立的汇编 stub——根据数据类型选择 best 的向量化宽度。

**arraycopy 入口表** (`stubRoutines.hpp:128-157`):
```
conjoint (src+dest 可能重叠):
  _jbyte_arraycopy, _jshort_arraycopy, _jint_arraycopy, _jlong_arraycopy
  _oop_arraycopy, _oop_arraycopy_uninit

disjoint (src+dest 不重叠——更优化):
  _jbyte_disjoint_arraycopy, _jshort_disjoint_arraycopy, _jint_disjoint_arraycopy, _jlong_disjoint_arraycopy
  _oop_disjoint_arraycopy, _oop_disjoint_arraycopy_uninit

检查版 (含类型检查):
  _checkcast_arraycopy — 逐元素 checkcast
  _unsafe_arraycopy — Unsafe.copyMemory
  _generic_arraycopy — 通用 fallback
```
- 源码: `stubRoutines.hpp:128-157` 全入口声明
- 关键设计: disjoint 路径可以 forward-copy(从低地址到高copy byte)，conjoint 路径如果是 src<dest→必须 backward-copy(从末端往首端copy)防止覆盖未copy的数据。14 个入口不是 14 个独立实现——generate_disjoint_copy 和 generate_conjoint_copy 各一次生成→按类型参数化(调整 stride=1/2/4/8 bytes)

### 2. "从 rep_movsb 到 AVX" — 向量化分级

场景: `generate_disjoint_copy` 生成一段汇编——检查 CPU feature→选最佳路径。

**向量化分级** (`stubGenerator_x86_64.cpp:600-900`):
```
Step 1: rep_movsb (ERMSB — Enhanced REP MOVSB)
  → CPU supports ERMSB? → rep_movsb 256+ bytes: ~1.5x of SSE
Step 2: AVX-512 (如果可用)
  → vmovdqu64 (zmm regs, 512-bit) — 64 bytes per copy
Step 3: AVX2
  → vmovdqu (ymm regs, 256-bit) — 32 bytes per copy
Step 4: SSE2 (fallback)
  → movdqu (xmm regs, 128-bit) — 16 bytes per copy
```
- 源码: `stubGenerator_x86_64.cpp:600-900` generate_disjoint_copy 分级逻辑
- 关键设计: 分级是按 CPU feature 降级的——运行时自动选 max available。generate_disjoint_copy 生成所有路径→用 conditional jump 选择(基于 use_avx/use_sse2 flags)。不是生成唯一路径——所有路径都在 stub 中(增加代码大小但避免多版本 stub)
- [x86: AVX2 256-bit copy = `vmovdqu ymm0,[rsi]; vmovdqu [rdi],ymm0; add rsi,32; add rdi,32; sub rcx,4; jnz loop` — 每迭代 32 bytes→1M bytes→~31250 iterations→~120K cycles→> 3x rep_movsb]

**conjoint backward copy 逻辑** (`stubGenerator_x86_64.cpp:900-1100`):
```
检查 overlap:
  if (src >= dest || dest >= src+length) → forward(无重叠)
  if (src < dest && dest < src+length) → src 的 end 覆盖到 dest 的开始→需要 backward
backward:
  rsi = src + length - stride
  rdi = dest + length - stride
  loop(递减指针→ copy→ mov rsi,length→ rep)
```
- [x86: backward copy = `std; rep_movsb; cld`(set direction flag→copy→clear direction flag)。只对首/尾部分未对齐的 bytes 用 rep_movsb——其余用向量化循环(rep_movsb = ~1.5 cycles/byte, AVX2 = ~0.25 cycles/byte)]

### 3. "fill 和 zero" — 额外辅助

场景: `Arrays.fill(arr, 0)` — 编译器生成 intrinsic→call `_jbyte_fill` stub。用 rep_stosb 或 向量化 fill。

**fill + zero stubs** (`stubRoutines.hpp:159-167`):
```
_jbyte_fill/_jshort_fill/_jint_fill (按类型 fill)
_arrayof_jbyte_fill 等 (按元素类型 fill, 对齐检查)
_zero_aligned_words — jlong 对齐零填充(heap 清零用)
```
- 源码: `stubGenerator_x86_64.cpp:1100-1300` generate_fill
- [x86: `rep_stosb` = 每字节 1 次 store → Intel 的 Fast String Operation 让 rep_stosb >500 bytes 时 ~0.25 cycles/byte——几乎无需向量化]

---

### 核心悬念

**"arraycopy stub 根据 CPU feature 生成期选 best 宽度——SSE2→AVX2→AVX-512(唯一运行时分支 AVX3Threshold=4096)。conjoint 路径用 array_overlap_test 判重叠、重叠走倒序。fill 纯向量(rep_stosb 属 C2 ClearArray 清零)。全部是手写 x86 汇编放进 _code2。"** — 但 AES 加密和 SHA 哈希是怎么加速的？下一篇: Crypto。

> → [03-crypto-math.md](03-crypto-math.md)
