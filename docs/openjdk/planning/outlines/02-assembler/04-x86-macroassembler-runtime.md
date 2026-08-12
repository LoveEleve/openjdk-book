# 04. MacroAssembler — call_VM / safepoint / 压缩 oop / 硬件加速

> 🔴 Deep | 运行时代码模板
> 读者处境: 单条指令会了——call_VM(JIT→C++)、safepoint 协作、压缩 oop、AES/SHA 硬件模板。
>
> ⚠️ 写作期修正(2026-08-12, vol-02/02-assembler/04 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **safepoint_poll 过时**: jdk11u 默认 **thread-local poll**(SafepointMechanism::uses_thread_local_poll,safepointMechanism.hpp:66)——`testb(thread+polling_page_offset, poll_bit)` + jcc(Thread::_polling_page,thread.hpp:346);"全局轮询页 mprotect+SIGSEGV" 是旧机制(备选路径是 cmp32 全局状态,3744-3758)
> - **第 4 节 fsin 与 45域01 矛盾**: 64 位 Math 是 SSE2 软件多项式(45域01 实证,不用 fsin);本节改写为"Math 真相引用 + AES/SHA 硬件模板"(macroAssembler_x86_aes.cpp:1290行/vaesenc@36-54;macroAssembler_x86_sha.cpp:1525行/sha1rnds4@62)
> - 行号漂移: call_VM@2311(中间 call 技巧,注释 2581-2589)、call_VM_base@2482(c_rarg0=r15_thread@2517、set_last_Java_frame@2526,注释 5558-5562)、verified_entry@5839(5字节可补丁约束 5842-5847)、generate_stack_overflow_check 在 share/asm/assembler.cpp:121(非 macroAssembler_x86.cpp:2090)、encode_heap_oop@5536/decode@5599(非 2580/2620)
> - OOPMap 不在 call_VM 内生成(大纲"1690"是注释区);OopMap 是 nmethod 元数据,由编译器关联

### 1. "call_VM — JIT→C++ 调用桥"

**结构**(`macroAssembler_x86.cpp:2311-2325` + `2482-2545` + `2579-2600`):
```
call_VM(2311): call(C, none); jmp(E); bind(C); call_VM_helper; ret(0); bind(E)
  → 中间 call 的 return address 留在栈上: last_java_pc = last_java_sp[-1](注释 2581-2589)
call_VM_helper(2579): lea(rax, Address(rsp, wordSize))——last_java_sp(2593)
call_VM_base(2482):
  → mov(c_rarg0, r15_thread)(2517)——C 函数第一参数永远是 JavaThread
  → set_last_Java_frame(java_thread, last_java_sp, rbp, NULL)(2526)——进 C 前登记帧(注释 5558-5562: "required to allow proper stack traversal")
[x86: SystemV:c_rarg0-5 = rdi/rsi/rdx/rcx/r8/r9(assembler_x86.hpp:44/74);callee-saved rbx/rbp/r12-r15]
```
- 关键设计: **中间 call** = "调用点即指令位置"——GC 从 last_java_sp[-1] 读 Java pc,无需额外元数据;JavaThread 作第一参数,VM 函数天然知道调用者。

### 2. "safepoint 协作点与栈保护"

**safepoint_poll**(`macroAssembler_x86.cpp:3744-3758`):
```
thread-local poll(默认): testb(thread+polling_page_offset, poll_bit) + jcc notZero slow(1字节 test)
备选: cmp32(ExternalAddress(state), _not_synchronized) + jcc notEqual
[thread-local poll = JDK 10+ 演进; Thread::_polling_page(thread.hpp:346);置位 vs mprotect]
verified_entry(5839): 入口 ≥5 字节(NativeJump::patch_verified_entry 可整体替换,注释 5842-5847)
generate_stack_overflow_check(assembler.cpp:121): UseStackBanging + StackShadowPages——Java 代码靠 stack banging 检测溢出(注释 123-130)
```
- 关键设计: **协作(轮询)与强制(patch)组合**——轮询点 1 字节 testb 零成本;入口 5 字节可替换是类重定义/去优化的前提。

### 3. "压缩 oop 编解码"

**encode/decode**(`macroAssembler_x86.cpp:5536-5548` + `5599-5614`):
```
encode_heap_oop(5536): base==NULL → shrq(LogMinObjAlignmentInBytes,默认3)
  base!=NULL → testq+cmovq(r12_heapbase)+subq+shrq3(null 编成 heapbase!)
decode_heap_oop(5599): shlq3(+非零 addq r12_heapbase)——jccb 零分支
r12_heapbase: JIT 全程保留的堆基址寄存器
```
- 关键设计: **内存 vs 指令的交换**——32 位指针换 2-3 条编解码指令;null 编成 heapbase 的 cmovq 巧思(06-oops 伏笔)。

### 4. "超越函数与硬件密码"

**Math 真相**(引用 45域01): 64 位 SSE2 软件多项式,不用 fsin;x87 仅 32 位残存。
**AES/SHA**(`macroAssembler_x86_aes.cpp:1290` + `macroAssembler_x86_sha.cpp:1525`):
```
aesenc/aesenclast/aesdec/aesdeclast/aeskeygenassist;AVX-512 下 vaesenc(36-54)
sha1rnds4/sha256rnds2(62 起展开)
[x86: AES-NI = 一轮 AES 一条指令(零访存);constant-time——查表实现的 cache timing 侧信道消除]
```
- 关键设计: **运行时探测 + 代码模板**——UseAESIntrinsics/UseSHA 开关驱动 C2 生成硬件指令序列,Java 层无感知。

---

### 核心悬念

**"call_VM 桥、thread-local poll、压缩 oop、AES/SHA 模板——MacroAssembler 把'运行时'缝进生成代码。但这一切的前提是开关: UseAESIntrinsics/UseCompressedOops/UseStackBanging——flag 定义在哪、怎么解析、怎么驱动生成?"** — 下一篇: Arguments & Flags。

> → [03-arguments-flags/01-flag-definition-system.md](../03-arguments-flags/01-flag-definition-system.md)
