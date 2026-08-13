# 03. AES、SHA、大数运算 — Crypto + Math Intrinsics

> 🟡 Working | 2 KP 中的密码学加速
> 读者处境: `MessageDigest.getInstance("SHA-256").digest(data)` — JIT 把这段代码替换成 call `_sha256_implCompress` stub。这个 stub 是手写 x86 汇编——用 SHA-NI 硬件指令在每个压缩轮中处理 64 bytes。
>
> ⚠️ 写作期修正(2026-08-13, vol-02/23-stub/03 已按真实源码成文 306 行,23 域收官,本大纲为规划期产物,机制描述以文章为准):
> - **行号全漂移**: AES 系列实际 :3016-4701(stubGenerator_x86_64.cpp,非 1300-1700);SHA :3692-3890(非 1700-2100);CRC :5185-5296(非 stubRoutines_x86_64.cpp:100-200,预计算表在 **stubRoutines_x86.cpp**: crc_table :132、k256 :324);BigInteger :5297-5470(非 2200-2700);Math :5497-5700(非 2700-3200)
> - **"sha256rnds2 4 rounds in 1 instruction" 错**: 一条 rnds2 做 **2 个 round**;每 16 字节块 = paddd(K)+rnds2×2 = 4 rounds(macroAssembler_x86_sha.cpp:271-300);消息扩展 sha256msg1/msg2+palignr 与压缩交叉流水;K256 是**静态数组**(stubRoutines_x86.cpp:324)非 DataSegment
> - **SHA-256 双路径(大纲未提)**: supports_sha()→SHA-NI fast_sha256,否则 AVX2 sha256_AVX2(:507)——所以 UseSHA256Intrinsics 开关只需 **sse4_1+UseSHA**(vm_version_x86.cpp:956-960);SHA-512 **无硬件指令**纯 AVX2(断言 avx2+bmi2,stubGenerator_x86_64.cpp:3814-3815,sha512_AVX2 macroAssembler_x86_sha.cpp:1240,vpsrlq/vpsllq 模拟循环移位);MB 批量=ofs/limit 多块循环 state 驻寄存器
> - **AES 细节**: encryptBlock :3016,keylen {44,52,60} 分派(:3038-3100),密钥=Java 展开的轮密钥 int 数组直接复用(注释 "the java expanded key ordering is just what we need" :3044),pshufb 转小端(load_key :2988);CBC 解密并行两条路径(VAES+AVX512 向量版 :4317/SSE Parallel :3400,按 supports_vaes+avx512vl+dq 二选一 :6024-6030);CTR :3916/:3998
> - **GHASH**: 4 次 pclmulqdq(a0*b0/a0*b1/a1*b0/a1*b1,掩码 0/16/1/17)交叉 XOR(:4693-4703);AVX 版 avx_ghash(macroAssembler_x86_aes.cpp:614)
> - **CRC32 不是"纯查表"**(半对): kernel_crc32(macroAssembler_x86.cpp:9076)=查表对齐+**pclmulqdq 折叠**(fold_128bit_crc32 :9138)+尾部查表,**无 crc32 指令**;crc32 SSE4.2 指令属 **CRC32C**(crc32c_ipl_alg2_alt2 :9889,:9671-9677);AVX-512 版 kernel_crc32_avx512 :9390(VPCLMULQDQ)
> - **BigInteger**: multiply_to_len(macroAssembler_x86.cpp:8123)按 BMI2 分派(:8218-8236): BMI2→multiply_128_x_128_bmi2_loop(:7989,mulxq :8030+adcx/adox 双进位链 :8039-8047,adcx/adox 需 supports_adx);非 BMI2→multiply_128_x_128_loop :7910;**"montgomery* 是汇编桩" 错(编造)**: 登记的是 C++ SharedRuntime::montgomery_multiply(sharedRuntime_x86_64.cpp:3811,32 位字),CAST_FROM_FN_PTR(stubGenerator_x86_64.cpp:6111-6118);另有 vectorizedMismatch :5357、base64 :4933(大纲未提);开关是 C2 flag(c2_globals.hpp:718)
> - **Math**: 桩=generate_libmExp/Sin/Cos/Tan/Log/Log10/Pow(:5497-5699)→MacroAssembler::fast_*,**Intel LIBM 2016 移植**(macroAssembler_x86_exp.cpp 头注释 "Intel Math Library (LIBM) Source Code"),7 文件各一函数,全 XMM 无 x87;fast_exp 常数表 _cv/_shifter(嵌桩后),范围检查(32767/16527/15504)+ln2 倒数取整归约+多项式(系数 0x3FC55555≈1/6、0x3FA55555≈1/24);**_dlibm_sin_cos_huge/reduce_pi04l/tan_cot_huge 仅 x86_32 生成**(stubGenerator_x86_32.cpp:3849-3862),x86_64 恒 NULL——"声明有、实现无"又一例
> - 实证: materials/commands/23-crypto-bench.txt(AMD EPYC 9K65,TencentKona 17): SHA-256 1537→262 MB/s=**5.9x**;SHA-512(AVX2)815→438=1.9x;AES-CBC 496→166=3.0x;CRC32 44704→3110=14.4x;Math.exp 4.0→7.0 ns/op=1.7x(用 -XX:+UnlockDiagnosticVMOptions 关闭)

### 1. "一 round 64 bytes" — SHA 系列 intrinsics

场景: SHA-256 每 512-bit 块做 64 rounds 压缩。软件实现用 lookup table——stub 用 SHA-NI 指令直接硬件加速。

**SHA family** (`stubRoutines.hpp:179-183`):
```
_sha1_implCompress      → SHA-1 (160-bit, deprecated)
_sha1_implCompressMB    → SHA-1 Multi-Block (batch mode)
_sha256_implCompress    → SHA-256 (256-bit, 安全最低标准)
_sha256_implCompressMB  → SHA-256 Multi-Block
_sha512_implCompress    → SHA-512 (512-bit, 64-bit words)
_sha512_implCompressMB  → SHA-512 Multi-Block
```
- 源码: `stubGenerator_x86_64.cpp:1700-2100` generate_sha256_implCompress
- 关键设计: 每 round SHA-256 = message schedule(扩展 16→64 words)→64 rounds compression。SHA-NI 指令: `sha256rnds2 xmm0,xmm1, [rdi+64*4]`(4 rounds in 1 instruction)→加速 ~8x vs 软件。Multi-Block(MB): 处理多个 512-bit 块的连续数据→节省 state reload 开销
- [x86: SHA-NI = Intel SHA Extensions(2013+)。`sha256msg1/sha256msg2` 做 message schedule——32-bit rotate+shift+xor→`sha256rnds2` 做 4 rounds of compression。256 rounds→64 instructions→~2-3 cycles/round→~200 cycles per 64-byte block]

**AES + CBC/ECB/CTR + GHASH** (`stubRoutines.hpp:169-177`):
```
_aescrypt_encryptBlock/_aescrypt_decryptBlock — 单 block AES
_cipherBlockChaining_encryptAESCrypt — AES-CBC encrypt(IV chaining)
_electronicCodeBook_encryptAESCrypt — AES-ECB (无 chaining)
_counterMode_AESCrypt — AES-CTR (counter mode, stream cipher)
_ghash_processBlocks — GHASH(Galois field multiply for AES-GCM auth tag)
```
- 源码: `stubGenerator_x86_64.cpp:1300-1700` AES 系列
- [x86: AES-NI = `aesenc/aesenclast`(1 round) + `aeskeygenassist`(key expansion)。AES-128: 初始 XOR→9 aesenc→1 aesenclast = 10 rounds→~20 cycles total。CBC: 每块 XOR prev ciphertext→AES encrypt→XOR plaintext = 连锁开销 +2 cycles/block]
- 关键设计: GHASH 用 `pclmulqdq`(carry-less multiply)做 Galois field mult→AES-GCM 认证 tag 计算。用 precomputed H table(256 entries→8 KB L1)减少 multiply 次数→每次 GHASH 乘用 4 次 pclmulqdq+4 次 XOR

**CRC32/CRC32C/Adler32** (`stubRoutines.hpp:186-191`):
```
_updateBytesCRC32  — CRC32 校验(用预计算的 256-entry table → L1 cache)
_updateBytesCRC32C — CRC32C(Castagnoli variant, SSE4.2 crc32 指令)
_updateBytesAdler32 — Adler32(软实现, 2个 running sum)
```
- 源码: `stubRoutines_x86_64.cpp:100-200` 预计算 crc32/crc32c table
- [x86: `crc32 rax, [rsi]`(CRC32C) — 1 条指令做 1 次 CRC——自 SSE4.2(2008) 后的硬件支持。每 8 bytes 1 次 CRC→每 MB 125K CRC→~2 cycles/CRC→~250K cycles/MB]

### 2. "大整数乘法怎么做？" — BigInteger intrinsics

场景: `BigInteger.multiply()` — 用 openSSL 替代实现的 Java 版本×10RSA签名加速。stub 在 x86_64 上用 multiplyToLen/squareToLen/montgomery* 代替 Java 实现。

**BigInteger stubs** (`stubRoutines.hpp:193-197`):
```
_multiplyToLen      — 大整数乘法: schoolbook O(N²)或 Karatsuba
_squareToLen        — 大整数平方: 对称优化(仅算上半三角)
_mulAdd             — 乘加: a*b + c → 用于 Montgomery 乘
_montgomeryMultiply — Montgomery modular multiplication
_montgomerySquare   — Montgomery modular squaring
```
- 源码: `stubGenerator_x86_64.cpp:2200-2700` generate_multiplyToLen
- 关键设计: multiplyToLen 在 x86_64 上用 `mulx`(无flag carry)做 base 2^64 乘法。每64-bit word 乘另一64-bit word→128-bit product→用 adc(add with carry)累加。Intel Broadwell(2015)的 `adcx/adox` 双-carry-chain→两条独立的进位链 → 并行度翻倍

### 3. "数学函数也有 intrinsic？" — Math Transcendental

场景: `Math.sin(0.5)` — JIT 生成 intrinsic→call `_dsin` stub。stub 用 range reduction+多项式近似替代 C 库的 libm。

**Math stubs** (`stubRoutines.hpp:201-210`):
```
_dsin/_dcos/_dtan — 三角(用 range reduction + Taylor)
_dexp/_dlog/_dlog10/_dpow — 指数对数(exp: argument reduction+多项式)
_dlibm_sin_cos_huge — 大输入的范围归约(>2^63)
_dlibm_reduce_pi04l — π/4 精确归约(π 扩展精度)
```
- 源码: `stubGenerator_x86_64.cpp:2700-3200` generate_math_stubs
- 关键设计: x86 FSIN 硬件指令不精确(1e-15)→软件替代。range reduction: 输入 x>π/4→x'=x-N·π/2(用多精度π的 lookup table)→sin/cos 多项式仅需 [-π/4,π/4]。Taylor 14 项→1e-16 精度→> 2x 硬件FSIN精度
- [x86: `vmovsd xmm0,[rsi]; call __range_reduce; call __dsin_poly`——整个 float 操作在 xmm 寄存器中——不需要 x87 FPU。range reduction 是瓶颈(需要多精度乘法)→exp 用 argument reduction 将输入映射到 [-ln2/2,ln2/2]→6 项多项式≈ 2^-53 精度]

---

### 核心悬念

**"Crypto intrinsics 用 AES-NI/SHA-NI 硬件指令(实测 5.9x/14.4x),Math 用 Intel LIBM 多项式移植(求确定性非速度),大整数乘法用 mulx+adcx 双-carry-chain(Montgomery 例外:C++ 函数)。所有 stub 是手写 x86 汇编预生成在 _code2 中。"** — 下一篇: 域24 Frame & Stack Walking——JVM 怎么走栈。

> → 域24 Frame & Stack Walking
