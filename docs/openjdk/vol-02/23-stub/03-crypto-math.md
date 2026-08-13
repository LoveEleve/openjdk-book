# 03. AES、SHA、大数运算 — Crypto + Math Intrinsics

> **前置依赖**:[23-stub/02 — Arraycopy 向量化](02-arraycopy.md):桩的生成骨架(UseAVX 定档/叶子调用/常数表入 CodeCache)在这里;[23-stub/01 — StubRoutines 全局桩](01-stub-entry.md):这批桩和 arraycopy 一样,由 `generate_all` 在启动期一次生成
> → **后续**:[24-frame/01 — Physical Frame](openjdk/vol-02/24-frame/01-physical-frame.md):桩和编译代码都住进栈,下一篇拆栈帧本身
> 关联域: 02-assembler(机器码生成)、13-jit(Intrinsic 分派)、41-zip-jimage(CRC 的另一位消费者)

## 一批"算得慢就换指令"的桩

上一篇文章的 arraycopy 桩解决"搬内存",这一篇解决"算数学": SHA-256 摘要、AES 加解密、CRC32 校验、BigInteger 乘法、Math.exp/sin。它们的共同点: 每种都有 CPU 专用指令(SHA-NI/AES-NI/CLMUL/BMI2)或预计算的常数表,Java 层实现再快也追不上。JVM 的做法是启动时把这些算法**手写成汇编桩**,JIT 把高频调用点直接替换成一条 call——实测关掉这些 intrinsic 后,SHA-256 慢 5.9 倍、CRC32 慢 14.4 倍([实证: materials/commands/23-crypto-bench.txt])。这一篇拆五个家族: SHA、AES+GHASH、CRC、BigInteger、Math。

## 1. SHA: 一条指令两个 round

### 生成条件: 为什么 SHA-256 只需要 SSE4.1

SHA 桩挂在 generate_all 的三个开关下(UseSHA1Intrinsics/UseSHA256Intrinsics/UseSHA512Intrinsics,stubGenerator_x86_64.cpp:6047-6067)。开关由 CPU 探测决定,最有意思的是 SHA-256 的开关条件(vm_version_x86.cpp:956-959,截取核心,逐字):

```cpp
// vm_version_x86.cpp:956-960(截取核心,逐字)
  if (supports_sse4_1() && UseSHA) {
    if (FLAG_IS_DEFAULT(UseSHA256Intrinsics)) {
      FLAG_SET_DEFAULT(UseSHA256Intrinsics, true);
    }
  } else if (UseSHA256Intrinsics) {
```

只要 SSE4.1 就能开——因为 SHA-256 桩有**两条实现路径**: 有 SHA-NI 硬件时用硬件,否则退化为 AVX2 软件实现。generate_sha256_implCompress(stubGenerator_x86_64.cpp:3772-3811,截取核心,逐字):

```cpp
// stubGenerator_x86_64.cpp:3772-3811(截取核心,逐字)
  address generate_sha256_implCompress(bool multi_block, const char *name) {
    assert(VM_Version::supports_sha() || VM_Version::supports_avx2(), "");
    __ align(CodeEntryAlignment);
    StubCodeMark mark(this, "StubRoutines", name);
    address start = __ pc();

    Register buf = c_rarg0;
    Register state = c_rarg1;
    Register ofs = c_rarg2;
    Register limit = c_rarg3;

    const XMMRegister msg = xmm0;
    const XMMRegister state0 = xmm1;
    const XMMRegister state1 = xmm2;
    const XMMRegister msgtmp0 = xmm3;

    const XMMRegister msgtmp1 = xmm4;
    const XMMRegister msgtmp2 = xmm5;
    const XMMRegister msgtmp3 = xmm6;
    const XMMRegister msgtmp4 = xmm7;

    const XMMRegister shuf_mask = xmm8;

    __ enter();

    __ subptr(rsp, 4 * wordSize);

    if (VM_Version::supports_sha()) {
      __ fast_sha256(msg, state0, state1, msgtmp0, msgtmp1, msgtmp2, msgtmp3, msgtmp4,
        buf, state, ofs, limit, rsp, multi_block, shuf_mask);
    } else if (VM_Version::supports_avx2()) {
      __ sha256_AVX2(msg, state0, state1, msgtmp0, msgtmp1, msgtmp2, msgtmp3, msgtmp4,
        buf, state, ofs, limit, rsp, multi_block, shuf_mask);
    }
    __ addptr(rsp, 4 * wordSize);
    __ vzeroupper();
    __ leave();
    __ ret(0);
    return start;
  }
```

参数列表暴露了 SHA 桩与 arraycopy 桩的差别: 多了 ofs/limit——**批量入口**,一次处理连续多个 512 位块,state 一直留在寄存器里,省掉每块的重载。这个多块版(Multi-Block,名字带 MB)和单块版是同一个生成函数(multi_block 参数),只是循环路径不同。

### 算法: 4 rounds 一组,message schedule 用硬件指令

SHA-256 的压缩函数每 64 个 round 处理一个 512 位块,其中 16 个消息字要先扩展成 64 个。SHA-NI 把这两件事都做成了指令: sha256rnds2 做压缩(带隐含源 xmm0,assembler_x86.cpp:4677,注释 "xmm0 is implicit additional source"),sha256msg1/msg2 + palignr 做消息扩展。核心循环每 16 字节块执行(macroAssembler_x86_sha.cpp:271-300,截取核心,逐字):

```cpp
// macroAssembler_x86_sha.cpp:271-300(截取核心,逐字)
  bind(loop0);
  movdqu(Address(rsp, 0), state0);
  movdqu(Address(rsp, 16), state1);

  // Rounds 0-3
  movdqu(msg, Address(buf, 0));
#ifdef _LP64
  pshufb(msg, shuf_mask);
#else
  pshufb(msg, ExternalAddress(pshuffle_byte_flip_mask));
#endif
  movdqa(msgtmp0, msg);
  paddd(msg, Address(rax, 0));
  sha256rnds2(state1, state0);
  pshufd(msg, msg, 0x0E);
  sha256rnds2(state0, state1);

  // Rounds 4-7
  movdqu(msg, Address(buf, 16));
#ifdef _LP64
  pshufb(msg, shuf_mask);
#else
  pshufb(msg, ExternalAddress(pshuffle_byte_flip_mask));
#endif
  movdqa(msgtmp1, msg);
  paddd(msg, Address(rax, 16));
  sha256rnds2(state1, state0);
  pshufd(msg, msg, 0x0E);
  sha256rnds2(state0, state1);
  sha256msg1(msgtmp0, msgtmp1);
```

**关键设计 (斜体)**: *一条 sha256rnds2 做 2 个 round,每条 16 字节块先用 paddd 把轮常数 K 加进消息再进 rnds2(共 4 rounds),轮常数表 k256 是预计算的静态数组(stubRoutines_x86.cpp:324,64 字节对齐),桩经 ExternalAddress 引用;输入消息先 pshufb 翻转字节序(大端网络序→小端寄存器序)。消息扩展与压缩交叉流水: sha256msg1/msg2 在压缩的间隙算下一组 W 值——硬件把 SHA 的 64 轮流水线化,软件查表实现没法比。*

SHA-1 同构(fast_sha1,macroAssembler_x86_sha.cpp:34),SHA-512 没有硬件指令,**纯 AVX2 软件实现**(sha512_AVX2 :1240,生成函数断言 requires_avx2+bmi2,stubGenerator_x86_64.cpp:3814-3815)——64 位消息字在 YMM 寄存器里用 vpsrlq/vpsllq 模拟循环移位。

### 实证: 硬件路径 vs 关掉 intrinsic

实测(materials/commands/23-crypto-bench.txt,AMD EPYC 9K65,16MB 数据): SHA-256 关掉 intrinsic 后 1537→262 MB/s(**5.9x**);SHA-512(AVX2 软件路径)815→438 MB/s(**1.9x**)。差距来源一目了然: SHA-NI 的硬件路径快 6 倍,AVX2 软件路径只快 2 倍。

## 2. AES: 一条指令一轮,密钥展开表直接复用 Java 的

### encryptBlock: 10/12/14 轮的骨架

AES-128 加密 = 1 次白化 XOR + 9 次 aesenc + 1 次 aesenclast。aesenc 一条指令完成一轮 SubBytes+ShiftRows+MixColumns+AddRoundKey(assembler_x86.cpp:1365)。generate_aescrypt_encryptBlock(stubGenerator_x86_64.cpp:3016)按密钥长度分派轮数(stubGenerator_x86_64.cpp:3038-3100,截取核心,逐字):

```cpp
// stubGenerator_x86_64.cpp:3038-3100(截取核心,逐字)
    // keylen could be only {11, 13, 15} * 4 = {44, 52, 60}
    __ movl(keylen, Address(key, arrayOopDesc::length_offset_in_bytes() - arrayOopDesc::base_offset_in_bytes(T_INT)));

    __ movdqu(xmm_key_shuf_mask, ExternalAddress(StubRoutines::x86::key_shuffle_mask_addr()));
    __ movdqu(xmm_result, Address(from, 0));  // get 16 bytes of input

    // For encryption, the java expanded key ordering is just what we need
    // we don't know if the key is aligned, hence not using load-execute form

    load_key(xmm_temp1, key, 0x00, xmm_key_shuf_mask);
    __ pxor(xmm_result, xmm_temp1);

    load_key(xmm_temp1, key, 0x10, xmm_key_shuf_mask);
    load_key(xmm_temp2, key, 0x20, xmm_key_shuf_mask);
    load_key(xmm_temp3, key, 0x30, xmm_key_shuf_mask);
    load_key(xmm_temp4, key, 0x40, xmm_key_shuf_mask);

    __ aesenc(xmm_result, xmm_temp1);
    __ aesenc(xmm_result, xmm_temp2);
    __ aesenc(xmm_result, xmm_temp3);
    __ aesenc(xmm_result, xmm_temp4);

    load_key(xmm_temp1, key, 0x50, xmm_key_shuf_mask);
    load_key(xmm_temp2, key, 0x60, xmm_key_shuf_mask);
    load_key(xmm_temp3, key, 0x70, xmm_key_shuf_mask);
    load_key(xmm_temp4, key, 0x80, xmm_key_shuf_mask);

    __ aesenc(xmm_result, xmm_temp1);
    __ aesenc(xmm_result, xmm_temp2);
    __ aesenc(xmm_result, xmm_temp3);
    __ aesenc(xmm_result, xmm_temp4);

    load_key(xmm_temp1, key, 0x90, xmm_key_shuf_mask);
    load_key(xmm_temp2, key, 0xa0, xmm_key_shuf_mask);

    __ cmpl(keylen, 44);
    __ jccb(Assembler::equal, L_doLast);

    __ aesenc(xmm_result, xmm_temp1);
    __ aesenc(xmm_result, xmm_temp2);

    load_key(xmm_temp1, key, 0xb0, xmm_key_shuf_mask);
    load_key(xmm_temp2, key, 0xc0, xmm_key_shuf_mask);

    __ cmpl(keylen, 52);
    __ jccb(Assembler::equal, L_doLast);

    __ aesenc(xmm_result, xmm_temp1);
    __ aesenc(xmm_result, xmm_temp2);

    load_key(xmm_temp1, key, 0xd0, xmm_key_shuf_mask);
    load_key(xmm_temp2, key, 0xe0, xmm_key_shuf_mask);

    __ BIND(L_doLast);
    __ aesenc(xmm_result, xmm_temp1);
    __ aesenclast(xmm_result, xmm_temp2);
    __ movdqu(Address(to, 0), xmm_result);        // store the result
    __ xorptr(rax, rax); // return 0
    __ leave(); // required for proper stackwalking of RuntimeStub frame
    __ ret(0);

    return start;
  }
```

**关键设计 (斜体)**: *密钥来源是 Java 侧已经展开好的轮密钥 int 数组——注释 "the java expanded key ordering is just what we need": Java 的密钥扩展结果与 AES-NI 需要的顺序一致,桩不用重新展开。唯一要处理的细节是字节序: Java 的 int[] 是小端,密钥字节要 pshufb 翻转(load_key :2988)。轮密钥逐组 load 进 XMM 后立即运算(load 与 aesenc 流水交错),分派只在 keylen 处出现——AES-128 一路直落,零分支。*

### CBC/CTR: 链式模式与并行解密

- CBC 加密(generate_cipherBlockChaining_encryptAESCrypt :3210): 每个明文块先 XOR 前一密文块(IV 或上一轮结果,存在 rvec 寄存器 :3220),链条天然串行;
- CBC 解密却可以并行: 密文块之间无依赖,只需在解密后 XOR。jdk11u 有两条并行实现——VAES+AVX512 的向量版(generate_cipherBlockChaining_decryptVectorAESCrypt :4317)与通用 SSE 版(Parallel :3400),按 CPU 能力二选一(stubGenerator_x86_64.cpp:6024-6030);
- CTR(counterMode_AESCrypt,:3916 向量版/:3998 Parallel): 计数器加密后与明文 XOR,同样可并行。

### GHASH: pclmulqdq 无进位乘法

AES-GCM 的认证标签需要 GF(2^128) 上的乘法——普通乘法器做不了,进位消除是关键。CLMUL 的 pclmulqdq 一条指令就是 64×64 无进位乘。generate_ghash_processBlocks(stubGenerator_x86_64.cpp:4650)把 128 位操作数拆成高低两半做 4 次 pclmulqdq 再交叉 XOR(stubGenerator_x86_64.cpp:4693-4703,截取核心,逐字):

```cpp
// stubGenerator_x86_64.cpp:4693-4703(截取核心,逐字)
    __ movdqu(xmm_temp3, xmm_temp0);
    __ pclmulqdq(xmm_temp3, xmm_temp1, 0);      // xmm3 holds a0*b0
    __ movdqu(xmm_temp4, xmm_temp0);
    __ pclmulqdq(xmm_temp4, xmm_temp1, 16);     // xmm4 holds a0*b1

    __ movdqu(xmm_temp5, xmm_temp0);
    __ pclmulqdq(xmm_temp5, xmm_temp1, 1);      // xmm5 holds a1*b0
    __ movdqu(xmm_temp6, xmm_temp0);
    __ pclmulqdq(xmm_temp6, xmm_temp1, 17);     // xmm6 holds a1*b1

    __ pxor(xmm_temp4, xmm_temp5);      // xmm4 holds a0*b1 + a1*b0
```

**关键设计 (斜体)**: *乘法在 GF(2^128) 上,普通乘法指令的进位链会污染结果——pclmulqdq 的"无进位"正是为它设计;4 个部分积(掩码 0/16/1/17 选高低半组合)XOR 交叉项,再模约简。有 AVX 时换 avx_ghash(macroAssembler_x86_aes.cpp:614,多块并行)。*

### 实证

AES-CBC 关掉 intrinsic: 496→166 MB/s(**3.0x**)。

## 3. CRC32: 指令、折叠、查表三件套

### kernel_crc32: 查表 + CLMUL 折叠

大纲说 CRC32 是"预计算 256-entry 表 → L1"——只有一半。generate_updateBytesCRC32(stubGenerator_x86_64.cpp:5185)主体是 kernel_crc32(macroAssembler_x86.cpp:9076): 先 `notl(crc)` 补码,16 字节对齐后进**向量折叠循环**——4 路并行 fold_128bit_crc32(用 pclmulqdq 无进位乘把 512 位一次性折进 CRC,:9138),尾部逐字节查表(_crc_table,stubRoutines_x86.cpp:132,来源注释见 :130)。**CRC32 的路径里没有 crc32 指令**——查表+折叠是它的全部。crc32 SSE4.2 指令属于 **CRC32C**: generate_updateBytesCRC32C(:5235)调 crc32c_ipl_alg2_alt2(macroAssembler_x86.cpp:9889),那里 crc32 指令与 pclmulqdq 折叠混用(:9671-9677)。AVX-512+VPCLMULQDQ 机器上的 CRC32 另有更宽的 kernel_crc32_avx512 变体(:9390,stubGenerator_x86_64.cpp:5190-5195)。

**关键设计 (斜体)**: *查表只是尾部与对齐的兜底,主体是"折叠"——pclmulqdq 把多块 CRC 一次归并,吞吐被拉高两个数量级。这解释了为什么实测差距最大: CRC32 关掉 intrinsic 后 44704→3110 MB/s(**14.4x**,materials/commands/23-crypto-bench.txt)。*

## 4. BigInteger: mulx + adcx/adox 双进位链

### multiply_to_len: BMI2 决定两条路径

generate_multiplyToLen(stubGenerator_x86_64.cpp:5297)是薄壳,算法在 MacroAssembler::multiply_to_len(macroAssembler_x86.cpp:8123)。内部按 BMI2 分派(macroAssembler_x86.cpp:8218-8236): 有 BMI2 走 multiply_128_x_128_bmi2_loop(:7989),没有则回退 multiply_128_x_128_loop(:7910)。BMI2 路径的核心(macroAssembler_x86.cpp:8030-8047,截取核心,逐字):

```cpp
// macroAssembler_x86.cpp:8030-8047(截取核心,逐字)
  mulxq(tmp4, tmp3, yz_idx1);  //  yz_idx1 * rdx -> tmp4:tmp3
  mulxq(carry2, tmp, yz_idx2); //  yz_idx2 * rdx -> carry2:tmp
  ...
    adcxq(tmp3, carry);
    adoxq(tmp3, yz_idx1);

    adcxq(tmp4, tmp);
    adoxq(tmp4, yz_idx2);

    movl(carry, 0); // does not affect flags
    adcxq(carry2, carry);
    adoxq(carry2, carry);
```

**关键设计 (斜体)**: *mulx 不碰标志位、单指令出 128 位积,adcx/adox 各维护一条独立的进位链——两条进位链并行推进,乘法累加的延迟被砍掉一半(大纲说的"双-carry-chain 并行度翻倍"这里是真的)。没有 BMI2 的老 CPU 用普通 mul+adc,进位链只有一条。*

squareToLen(:5407,平方只算一半三角)与 mulAdd(:5456)同族;还有顺带的 vectorizedMismatch(:5357,Arrays.mismatch 的 SIMD 版)。

### 一个反例: Montgomery 不是汇编桩

大纲列的 `_montgomeryMultiply/_montgomerySquare` 让人以为也是手写汇编——**不是**。stubGenerator 里它们只是把 C++ 函数地址登记进表(stubGenerator_x86_64.cpp:6111-6118):

```cpp
// stubGenerator_x86_64.cpp:6111-6118(截取核心,逐字)
    if (UseMontgomeryMultiplyIntrinsic) {
      StubRoutines::_montgomeryMultiply
        = CAST_FROM_FN_PTR(address, SharedRuntime::montgomery_multiply);
    }
    if (UseMontgomerySquareIntrinsic) {
      StubRoutines::_montgomerySquare
        = CAST_FROM_FN_PTR(address, SharedRuntime::montgomery_square);
    }
```

实现是 C++ 的 SharedRuntime::montgomery_multiply(sharedRuntime_x86_64.cpp:3811,32 位字 Montgomery)——C2 的 leaf 调用调进去的还是普通 C++ 函数。**入口表里挂着名字 ≠ 汇编桩**,登记的是函数指针。

## 5. Math: 把 Intel LIBM 搬进 CodeCache

### libm 桩的出身

Math.exp 的桩 generate_libmExp(stubGenerator_x86_64.cpp:5497)只做一件事: 调 MacroAssembler::fast_exp(macroAssembler_x86_exp.cpp:193)。这个文件的头注释说明了身世(macroAssembler_x86_exp.cpp:2-3):

```cpp
// macroAssembler_x86_exp.cpp:2-3(截取核心,逐字)
* Copyright (c) 2016, Intel Corporation.
* Intel Math Library (LIBM) Source Code
```

Intel 把自家的数学库移植成 HotSpot 宏汇编,7 个函数各占一个文件: fast_exp/sin/cos/tan/log/log10/pow(macroAssembler_x86_{exp,sin,cos,tan,log,log10,pow}.cpp)。全部用 XMM 寄存器,不碰 x87。

### exp 的归约+多项式骨架

fast_exp 的结构是教科书式归约(macroAssembler_x86_exp.cpp:193 起): 常数表(_cv/_shifter/_Tbl_addr,嵌在桩代码后的 DataSegment),先判范围(指数位与 32767/16527/15504 比较,超界走慢路径),然后乘 ln2 倒数取整得 N,把 x 归约进小的 ln2 分位区间,再乘多项式——系数表注释里直接标着浮点位型,能认出经典的阶乘倒数系数(如 0x3FC55555≈1/6、0x3FA55555≈1/24)。

**关键设计 (斜体)**: *数学桩的价值不在"更快"而在"一致": 多项式近似是确定性的,同一输入永远同一输出;而让 JIT 去调 libm 的 exp 是浮点环境差异的不可控因素。测出来也确实是 modest 的 1.7x(4.0 vs 7.0 ns/op,materials/commands/23-crypto-bench.txt)——它和 SHA/AES 的"换指令"不是一回事,是"把算法钉死在汇编里"。*

### 大纲的 "huge 输入" 桩: x86_32 专属

大纲列的 `_dlibm_sin_cos_huge`、`_dlibm_reduce_pi04l`、`_dlibm_tan_cot_huge` 确实在 stubRoutines.hpp:207-209 有声明——但**只在 x86_32 生成**(stubGenerator_x86_32.cpp:3849-3862),x86_64 里它们永远是 NULL。jdk11u 的 x86_64 数学桩把大输入归约做进了 fast_sin 本身。又是"声明有、实现无"的例子。

## 核心悬念

Crypto/Math 五个家族拆完: SHA 靠 sha256rnds2 一条指令两 round(无硬件时 AVX2 软件),AES 靠 aesenc 一轮一指令、密钥表直接复用 Java 展开结果,GHASH 靠 pclmulqdq 无进位乘,CRC 是指令+折叠+查表三件套,BigInteger 靠 mulx+adcx/adox 双进位链——而 Montgomery 桩名不副实,登记的是 C++ 函数;Math 是 Intel LIBM 的汇编移植,求的是确定性不是速度。它们的共同骨架还是 23-01 那套: 启动期生成、常数表随桩预计算、JIT 叶子调用。到这里,23 域的桩故事讲完——下一篇换个视角: 桩和编译代码都住进栈,栈帧本身长什么样?JVM 怎么表示一个栈帧?

> → [24-frame/01 — Physical Frame](openjdk/vol-02/24-frame/01-physical-frame.md)
