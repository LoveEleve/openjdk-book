# 03. AES、SHA、大数运算 — Crypto + Math Intrinsics

> 🟡 Working | 2 KP 中的密码学加速
> 读者处境: `MessageDigest.getInstance("SHA-256").digest(data)` — JIT 把这段代码替换成 call `_sha256_implCompress` stub。这个 stub 是手写 x86 汇编——用 SHA-NI 硬件指令在每个压缩轮中处理 64 bytes。

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

**"Crypto intrinsics 用 AES-NI/SHA-NI 硬件指令达到 8x 加速——Math 用多项式近似替代硬件 FSIN 达到更高精度。大整数乘法用 mulx+adcx 双-carry-chain 并行度翻倍。所有 stub 是手写 x86 汇编预生成在 _code2 中。"** — 下一篇: 域24 Frame & Stack Walking——JVM 怎么走栈。

> → 域24 Frame & Stack Walking
