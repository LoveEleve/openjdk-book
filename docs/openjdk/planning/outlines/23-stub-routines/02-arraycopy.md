# 02. System.arraycopy() 在底层怎么跑？— Arraycopy 向量化

> 🔴 Deep | 2 KP 中的性能核心
> 读者处境: `System.arraycopy(src, 0, dst, 0, 1000000)` — JIT 生成 intrinsics(向量化 memcpy)还不够好——JVM 在启动时预生成了手写汇编桩，用 SSE/AVX 达到 ~3x 加速。

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

**"arraycopy stub 根据 CPU feature 自动选 best path——ERMSB→AVX-512→AVX2→SSE2→rep_movsb。conjoint 路径用 backward copy 处理 overlap。fill 用 rep_stosb 或向量化。全部是手写 x86 汇编放进 _code2。"** — 但 AES 加密和 SHA 哈希是怎么加速的？下一篇: Crypto。

> → [03-crypto-math.md](03-crypto-math.md)
