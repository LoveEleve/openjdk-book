# 04. MacroAssembler — 把指令拼成"运行时"

> **前置依赖**:[02-assembler/03 — x86 指令集](03-x86-assembler-instruction-set.md):指令字节;02-assembler/01 — CodeBuffer/Label;45-math-library/01(Math 的真相——本篇第 4 节引用)
> → **后续**:[03-arguments-flags — 标志系统](openjdk/vol-02/03-arguments-flags/01-flag-definition-system.md)
> 关联域: 13-jit、18-safepoint、06-oops(压缩 oop 的伏笔)、23-stub

## 单条指令会了,运行时怎么办

JIT 生成的代码从来不只是"一串指令"——它要**调用 C++ 函数**(还得让 GC 找得到根)、要**配合 safepoint**(不能让线程停在不可暂停的地方)、要**保护栈**、要**搬运压缩后的对象指针**。这些"运行时语义"全部由 `MacroAssembler` 拼出来。这篇拆四个模板:call_VM 调用桥、safepoint 协作点、压缩 oop 编解码、硬件加速指令。

## 1. call_VM:JIT→C++ 的桥

### 1.1 场景:生成代码怎么调 C++

C2 生成的方法里,`Objects.hashCode` 等会调用 VM 函数。`call_VM`(macroAssembler_x86.cpp:2311)的结构很绕,但注释(2581-2589)解释了为什么:

```cpp
// macroAssembler_x86.cpp:2311-2325(截取核心,逐字)
void MacroAssembler::call_VM(Register oop_result,
                             address entry_point,
                             bool check_exceptions) {
  Label C, E;
  call(C, relocInfo::none);
  jmp(E);

  bind(C);
  call_VM_helper(oop_result, entry_point, 0, check_exceptions);
  ret(0);

  bind(E);
}
```

**中间多了一层 call**:`call(C)` 把 return address 压栈 → 跳去 helper 真正调 C++ → helper 里的 `ret(0)` 弹掉这个 return address → 回到 `jmp(E)` 之后。这层"假 call"的价值在 `call_VM_helper`(2579)的注释里:return address 留在栈上,`last_java_pc` 可以直接从 `last_java_sp[-1]` 取到——**safepoint 时 GC 要知道"这个 Java 帧正在执行哪条指令"**。

helper 往下是 `call_VM_base`(2482),关键动作:

```cpp
// macroAssembler_x86.cpp:2515-2526(截取核心,逐字)
  // push java thread (becomes first argument of C function)

  NOT_LP64(push(java_thread); number_of_arguments++);
  LP64_ONLY(mov(c_rarg0, r15_thread));

  // set last Java frame before call
  assert(last_java_sp != rbp, "can't use ebp/rbp");

  // Only interpreter should have to set fp
  set_last_Java_frame(java_thread, last_java_sp, rbp, NULL);
```

两个关键点:① **C 函数的第一个参数永远是 JavaThread 指针**(`mov(c_rarg0, r15_thread)`,2517——c_rarg0 = rdi,assembler_x86.hpp:74);② **进 C 之前 `set_last_Java_frame`**(2526)——把当前 rsp/rbp 记进 JavaThread 对象。set_last_Java_frame 上方的注释(5558-5562)说得很清楚:

```cpp
// macroAssembler_x86.cpp:5558-5562(注释逐字)
// Calls to C land
//
// When entering C land, the rbp, & rsp of the last Java frame have to be recorded
// in the (thread-local) JavaThread object. When leaving C land, the last Java fp
// has to be reset to 0. This is required to allow proper stack traversal.
```

没有这一步,GC 扫栈时在 native 调用里就断了——这正是 05-cpu/02 篇 JavaFrameAnchor 的主题,这里是它的汇编实现。

- [x86: SystemV 调用约定:c_rarg0-5 = rdi/rsi/rdx/rcx/r8/r9(前 6 个整数参数走寄存器),c_rarg0 定义见 assembler_x86.hpp:44/74;被调函数承诺不破坏 callee-saved(rbx/rbp/r12-r15),caller-saved(rax/rcx/rdx/rsi/rdi/r8-r11 + XMM)由 JIT 自己负责保存]

**关键设计 (斜体)**: *"中间 call"是 JVM 的巧思:正常情况下这段代码多了一条 call+ret 的开销,换来的却是"调用点即指令位置"——GC 在 safepoint 时能从 last_java_sp[-1] 读出 Java pc,而不用在 C++ 调用点埋额外的元数据。传 JavaThread 作为第一参数,让每个 VM 函数天然知道"谁在调我"(线程局部状态都从它取)。这一桥的设计决定了:JIT 代码调 C++ 的正确性,一半在 ABI,一半在"帧状态登记"。*

## 2. safepoint 协作点与栈保护

### 2.1 场景:每个方法入口都在"看表"

`MacroAssembler::safepoint_poll`(3744-3758)是**方法入口和循环回边**的轮询点:

```cpp
// macroAssembler_x86.cpp:3744-3758(截取核心,逐字)
void MacroAssembler::safepoint_poll(Label& slow_path, Register thread_reg, Register temp_reg) {
  if (SafepointMechanism::uses_thread_local_poll()) {
#ifdef _LP64
    assert(thread_reg == r15_thread, "should be");
#else
    ...
#endif
    testb(Address(thread_reg, Thread::polling_page_offset()), SafepointMechanism::poll_bit());
    jcc(Assembler::notZero, slow_path); // handshake bit set implies poll
  } else {
    cmp32(ExternalAddress(SafepointSynchronize::address_of_state()),
        SafepointSynchronize::_not_synchronized);
    jcc(Assembler::notEqual, slow_path);
  }
}
```

jdk11u 的默认路径是 **thread-local poll**(safepointMechanism.hpp:66):每个线程对象里有一个轮询字段(`Thread::_polling_page`,thread.hpp:346,"Thread local polling page"),`testb(thread + polling_page_offset, poll_bit)`——**1 字节的 test + 1 次条件跳**,正常路径零开销;要停线程时,JVM 置这个线程的 poll 位,线程在下一个入口/回边看到位被置 → 走 slow_path(handshake 或 safepoint)。备选路径(非 thread-local)是 `cmp32` 全局状态。

- [C++: thread-local poll 是 JDK 10+ 的演进(之前的全局轮询页靠 mprotect 页面权限 + SIGSEGV);置位 vs 改页权限,把"停线程"从系统调用级降为普通内存写——01-os/04 篇的轮询机制在这里看到 jdk11u 的真实形态]

方法入口的另一道保护在 `verified_entry`(5839):

```cpp
// macroAssembler_x86.cpp:5842-5847(注释逐字)
  // WARNING: Initial instruction MUST be 5 bytes or longer so that
  // NativeJump::patch_verified_entry will be able to patch out the entry
  // code safely. The push to verify stack depth is ok at 5 bytes,
  // the frame allocation can be either 3 or 6 bytes. So if we don't do
  // stack bang then we must use the 6 byte frame allocation even if
  // we have no frame. :-(
```

入口第一条指令必须 ≥5 字节——因为 JVM 要能在运行时**用一条 5 字节跳转整体替换入口**(类重定义/去优化时 patch 掉入口,01 篇的"补丁安全"纪律在这里是硬约束)。入口还负责**栈保护**:`generate_stack_overflow_check`(assembler.cpp:121)在 UseStackBanging 下往栈深处写一页(注释 123-130:Java 代码靠 stack banging 检测栈溢出,VM/native 不检测;`JavaCalls::call()` 保证 shadow zone 至少 n 页可用,入口只需 bang 一次)。

**关键设计 (斜体)**: *协作式暂停的两个要素:① 轮询点要"便宜"——1 字节 testb + 1 次预测成功的分支,方法入口/回边的成本可以忽略;② 入口要"可替换"——5 字节对齐的入口指令让 patch_verified_entry 能原子换掉整个入口。**协作(轮询)与强制(patch)的组合**,是 JVM 线程暂停机制的完整图景——安全点的"检查点"和类重定义的"换入口"在这里汇合。*

## 3. 压缩 OOP 的编解码

### 3.1 场景:32 位指针装 64 位堆

开启压缩 oop(-XX:+UseCompressedOops)时,堆里存的是 32 位指针。`encode_heap_oop`(5536-5548)把 64 位 oop 压成 32 位:

```cpp
// macroAssembler_x86.cpp:5536-5548(截取核心,逐字)
void MacroAssembler::encode_heap_oop(Register r) {
#ifdef ASSERT
  verify_heapbase("MacroAssembler::encode_heap_oop: heap base corrupted?");
#endif
  verify_oop(r, "broken oop in encode_heap_oop");
  if (Universe::narrow_oop_base() == NULL) {
    if (Universe::narrow_oop_shift() != 0) {
      assert (LogMinObjAlignmentInBytes == Universe::narrow_oop_shift(), "decode alg wrong");
      shrq(r, LogMinObjAlignmentInBytes);
    }
    return;
  }
  testq(r, r);
  cmovq(Assembler::equal, r, r12_heapbase);
  subq(r, r12_heapbase);
  shrq(r, LogMinObjAlignmentInBytes);
}
```

两种模式:① **零基址压缩**(`narrow_oop_base() == NULL`):堆从地址 0 开始,压缩 = `shrq(r, LogMinObjAlignmentInBytes)`(默认 3,对象 8 字节对齐,低 3 位恒 0);② **基址偏移压缩**:先 `testq + cmovq(r12_heapbase)`(null 变成 heap base 编码——用 heapbase 代表 null!)+ `subq(r12_heapbase)` + `shrq 3`。`r12_heapbase` 是 JIT 全程保留的堆基址寄存器。解码 `decode_heap_oop`(5599-5614)对称:`shlq 3`(+ 非零时 `addq r12_heapbase`)。

- [C++: 压缩的数学:zero-based 模式 = 地址 >> 3(绝对);heapbase 模式 = (地址 - heap_base) >> 3(相对)。选择取决于堆能否放回 32 位地址空间(06-oops 域会展开完整决策)]

**关键设计 (斜体)**: *压缩 oop 是"内存 vs 指令"的交换:32 位指针让堆容量翻倍(或堆引用占内存减半),代价是每次取用都要 2-3 条指令编解码。`cmovq` 处理 null 的编码是巧思——null 编成 heap_base 本身,解码时 `shlq + jccb(equal) + addq` 三步,零分支。这 3 条指令在每次字段访问时出现,是 JIT 生成代码里最常见的模式之一(06-oops 的伏笔)。*

## 4. 超越函数与硬件密码

### 4.1 场景:Math 与加密的"指令级加速"

**Math 的真相**(引用 45-math-library/01):64 位 JVM 的 `Math.sin` 走 C2 intrinsic → StubRoutines 的 SSE2 软件多项式(**不用 fsin**——大纲时期的"fsin/fcos/fyl2x/f2xm1"是旧实现,45-01 篇已实证);x87 只在 32 位路径残存。超越函数的"指令级加速"在 jdk11u 里主要体现在**加密**:

- **AES-NI**(macroAssembler_x86_aes.cpp,1290 行):`aesenc/aesenclast/aesdec/aesdeclast/aeskeygenassist`——一条指令完成一整轮 AES(SubBytes+ShiftRows+MixColumns+AddRoundKey);AVX-512 下是 `vaesenc` 等(36-54 行,512 位版)。JIT 在 `UseAESIntrinsics` 时调用生成模板,把 10-14 轮展开成纯指令序列
- **SHA-NI**(macroAssembler_x86_sha.cpp,1525 行):`sha1rnds4/sha256rnds2`——硬件哈希轮(62-87 行是 sha1 轮的展开)

- [x86: AES-NI 的两重价值:① 快——查表实现的 AES 每轮要 4 次 S-box 内存访问(依赖 key+plaintext),硬件指令零访存;② **constant-time**——查表实现的访存模式随数据变化,现代 CPU 的 cache timing 会泄露 key 信息(时序侧信道),指令实现固定周期,从根源消除]

**关键设计 (斜体)**: *"硬件加速"在 JVM 里的形态是**运行时探测 + 代码模板**:启动时 `VM_Version` 探测 CPU 特性(45-02 篇的时序依赖),`UseAESIntrinsics`/`UseSHA1Intrinsics` 等开关决定 C2 生成普通调用还是直接展开硬件指令模板。Java 层无感知——`Cipher.getInstance("AES")` 同一份代码,在有 AES-NI 的机器上自动变成零访存的指令序列。这和 Math intrinsic 是同一模式:语义不变,实现按硬件替换。*

## 核心悬念

"call_VM 的桥、thread-local poll 的协作点、压缩 oop 的编解码、AES/SHA 的硬件模板——MacroAssembler 把'运行时'缝进每一段生成代码。但这一切的前提是**开关**——UseAESIntrinsics、UseCompressedOops、UseStackBanging……这些 flag 定义在哪里、怎么被解析、怎么驱动代码生成?下一篇:Arguments & Flags——JVM 标志系统。"

> → [03-arguments-flags/01-flag-definition-system.md](openjdk/vol-02/03-arguments-flags/01-flag-definition-system.md)
