# PROMPT: 请撰写 15-StubRoutines-SharedRuntime.md

## §〇 Production Scenario

### 场景 1: `System.arraycopy()` 的 native 调用如何到达 memmove

```java
System.arraycopy(src, 0, dst, 0, 1_000_000);
```

这条调用最终需要执行 ~1MB 的内存拷贝。JVM 不是直接调用 libc 的 memmove，而是通过 StubRoutines 中预生成的桩代码。`StubRoutines::initialize2()`（`stubRoutines.cpp:306`）调用 `generate_arraycopy_stubs()` 在 CodeCache 中生成 24 个 arraycopy 入口：jbyte/jshort/jint/jlong × conjoint/disjoint/arrayof × 2。C2 JIT 在编译 `System.arraycopy(int[], int[], ...)` 时，通过 `StubRoutines::select_arraycopy_function()` 选择对应类型的桩入口，生成 `call` 指令跳转到桩代码——完全绕过 JNI，零 safepoint 检查。

**三步诊断**：
```bash
# 1. 验证 arraycopy 桩已生成
gdb -ex "break stubRoutines.cpp:306" \
    -ex "run" \
    -ex "print StubRoutines::_jbyte_arraycopy" \
    --args java -jar app.jar
# 期望: 非 NULL 地址（CodeCache 中的桩入口）

# 2. 验证 C2 使用了桩而非 JNI 调用
java -XX:+PrintAssembly -XX:+UnlockDiagnosticVMOptions -jar app.jar 2>&1 | rg "call.*arraycopy"
# 期望: call 指令目标地址在 StubRoutines 范围内

# 3. strace 验证无 JNI 开销
strace -e write java -jar app.jar 2>&1 | rg memmove
# 期望: 无 memmove 系统调用（直接内存操作，不需要内核介入）
```

**反事实**：如果 arraycopy 每次调用都走 JNI → JNI_ENTRY（safepoint check + oop wrapping ~50ns）+ memmove（~5µs for 1MB）= ~5.05µs。桩代码直接跳转 → safepoint 检查省略 + 无 oop wrapping → ~5µs。差异仅 50ns（1%），但对高频小数组拷贝（每秒百万次 10 元素拷贝）→ 桩代码 50ns vs JNI 100ns → 2× 性能差距。

### 场景 2: `BigInteger.multiply()` 的大数乘法加速

```java
BigInteger a = new BigInteger("12345678901234567890");
BigInteger b = new BigInteger("98765432109876543210");
BigInteger c = a.multiply(b);
```

C2 JIT 将 `BigInteger.multiply()` intrinsic 替换为 `StubRoutines::_multiplyToLen` 桩的调用。该桩在 `initialize2()` 中条件生成（`UseMultiplyToLenIntrinsic && is_server_compilation_mode_vm()`）。桩代码使用 AVX-512 或 SSE 指令进行大数乘法——比纯 Java 循环快 5-10×。

**反事实**：如果 `_multiplyToLen` 桩未生成（条件不满足）→ C2 回退到 Java 实现（纯循环）→ 2048-bit 乘法从 ~2µs 变为 ~15µs → 7.5× 慢。桩代码的条件生成由 CPU 特性（AVX/SSE）和 JVM 模式（Server/Client）决定——Client VM 不生成此桩因为 Client 堆通常较小，大数运算不常见。

### 场景 3: 内联缓存未命中触发 `_ic_miss_blob`

```
# JVM crash: SIGSEGV in SharedRuntime::handle_wrong_method_ic_miss
```

方法 `foo.bar()` 被 JIT 编译后，其内联缓存（IC）指向 `A.bar()`。运行时实际调用的是 `B.bar()`（`B extends A` 并重写了 `bar`）。IC 检测到不匹配 → 跳转到 `_ic_miss_blob`（`sharedRuntime.cpp:106`）→ `SharedRuntime::handle_wrong_method_ic_miss()` → 解析正确的 `B.bar()` Method* → 返回新的入口地址。如果 `_ic_miss_blob` 未生成 → IC miss 时跳转到无效地址 → SIGSEGV。

---

## §一 Task + Narrative + Beginner Callouts

### Task

Reading this prompt, you will produce a document that traces the FOUR init_globals() calls that generate all CodeCache-resident stub routines. These stubs are pre-generated assembly code fragments that the JIT compiler and interpreter call directly — bypassing JNI, safepoint checks, and C++ virtual dispatch:

- `stubRoutines_init1()` — Phase 1 stubs: call_stub, exception, atomics, CRC32, libm math (line 133)
- `stubRoutines_init2()` — Phase 2 stubs: arraycopy 24 entries, AES/SHA intrinsic, safefetch, big integer, fill (line 186)
- `SharedRuntime::generate_stubs()` — resolve blobs + safepoint handlers + deopt blob (line 153)
- `MethodHandles::generate_adapters()` — MH signature-polymorphic method adapters (line 190)

Reader completed **01-CodeCache** (where all stubs live), **14-Interpreter** (bytecode dispatch that calls these stubs), **16-Universe-Post-Init** (type system stubs operate on). This doc: **how the JVM pre-generates ~140KB of assembly stubs in CodeCache that form the execution bridge between interpreted/compiled Java code and the C++ VM runtime — from call_stub (C→Java entry) to safefetch (crash-safe memory read) to AES-GCM encryption intrinsic**.

### Interview Story Format Answer（必须出现在 §一 末尾）

"`stubRoutines_init1()` at `stubRoutines.cpp:411` delegates to `StubRoutines::initialize1()` (37 lines, :196-233) which allocates `BufferBlob::create("StubRoutines (1)", 30000)` in CodeCache NonNMethodCodeHeap and calls `StubGenerator::generate_initial()` — producing 16 stubs: `_call_stub_entry` (C→Java call bridge), `_catch_exception_entry` (exception catcher for megamorphic calls), `_forward_exception_entry` (exception chain walker), 6 atomic operation stubs (xchg/cmpxchg/add for jint/jlong), `_fence_entry` (mfence/lfence/sfence barrier), `_get_previous_fp/sp_entry` (frame pointer/sp walker), `_verify_mxcsr_entry` (MXCSR validator), `_throw_StackOverflowError_entry` and `_throw_delayed_StackOverflowError_entry` (both RuntimeStubs with OopMaps), plus conditional stubs: CRC32/CRC32C update (UseCRC32Intrinsics), 7 libm math intrinsics (dexp/dlog/dlog10/dpow/dsin/dcos/dtan, gated by UseLibmIntrinsic+InlineIntrinsics), and 12 float/double constant table pointers. `stubRoutines_init2()` at :412 delegates to `StubRoutines::initialize2()` (102 lines, :306-408) which allocates `BufferBlob::create("StubRoutines (2)", 46300)` and calls `StubGenerator::generate_all()` — producing: 3 exception thrower RuntimeStubs (`_throw_AbstractMethodError_entry`, `_throw_IncompatibleClassChangeError_entry`, `_throw_NullPointerException_at_call_entry`), 4 x86 float-to-int/long fixup stubs (`_f2i_fixup` etc.), 11 float/double/vector sign mask/flip constants, `_verify_oop_subroutine_entry`, `generate_arraycopy_stubs()` producing 24 arraycopy entries (jbyte/jshort/jint/jlong × conjoint/disjoint × arrayof, plus checkcast/unsafe/generic), 6 array fill stubs (jbyte/jshort/jint × aligned/oop-aligned), AES intrinsic stubs (encryptBlock/decryptBlock/CBC/ECB/CTR, gated by UseAESIntrinsics/UseAESCTRIntrinsics with VAES+AVX512 sub-conditions), SHA intrinsic stubs (SHA-1/SHA-256/SHA-512 implCompress + multi-block MB versions), GHASH processBlocks (GCM), BASE64 encodeBlock, 5 BigInteger stubs (multiplyToLen/squareToLen/mulAdd/montgomeryMultiply/montgomerySquare, all C2-only), `_safefetch32_entry` and `_safefetchN_entry` (crash-safe memory reads with SIGSEGV fault PC/continuation PC pair), and `_vectorizedMismatch`. In ASSERT mode, `initialize2()` runs self-tests: TEST_ARRAYCOPY × 4 types, TEST_FILL × 3 types, TEST_COPYRTN × 4 types, safefetch validation. `SharedRuntime::generate_stubs()` at `sharedRuntime.cpp:101` (36 lines) generates: 6 resolve RuntimeStubs via `generate_resolve_blob()` — `_wrong_method_blob`, `_wrong_method_abstract_blob`, `_ic_miss_blob`, `_resolve_opt_virtual_call_blob`, `_resolve_virtual_call_blob`, `_resolve_static_call_blob` — each saves all live registers via `RegisterSaver`, sets `last_Java_frame`, calls the C++ resolve function, checks `pending_exception` (jumps to `_forward_exception_entry` on exception), restores registers, and jumps to the resolved target; 3 safepoint handler SafepointBlobs — `_polling_page_safepoint_handler_blob` (POLL_AT_LOOP), `_polling_page_return_handler_blob` (POLL_AT_RETURN), `_polling_page_vectors_safepoint_handler_blob` (C2/JVMCI only); `generate_deopt_blob()` for deoptimization (compiled frame → interpreter frame state reconstruction); `generate_uncommon_trap_blob()` (C2 only). `MethodHandles::generate_adapters()` at `methodHandles.cpp:75` (15 lines) creates `MethodHandlesAdapterBlob::create(adapter_code_size)` in CodeCache and loops over `Interpreter::method_handle_invoke_FIRST` to `method_handle_invoke_LAST`, calling `generate_method_handle_interpreter_entry()` for each signature-polymorphic intrinsic (`_invokeBasic`, `_linkToVirtual`, `_linkToStatic`, `_linkToSpecial`, `_linkToInterface`, `_invokeGeneric`), installing each entry into `Interpreter::_entry_table[mk]` via `set_entry_for_kind()`. The key architectural insight: these 4 calls collectively pre-generate ~140KB of assembly stubs in CodeCache NonNMethodCodeHeap — every cross-boundary call in the JVM (Java↔C++, interpreted↔compiled, normal execution↔exception, normal code↔intrinsic) routes through one of these pre-generated stubs, eliminating JNI overhead and safepoint checks from the hot path."

### Beginner Callout Boxes（文档中必须出现的 7 个 callout 框）

1. **StubRoutines 的两阶段设计**: Phase 1 (`initialize1`) 生成"早期可用"的桩——这些桩在 JVM 后续初始化步骤中立即被使用（如 `_call_stub_entry` 在 `generate_adapters` 中被调用，`_forward_exception_entry` 在 resolve blobs 中被引用）。Phase 2 (`initialize2`) 生成"后期可用"的桩——这些桩依赖 Metaspace（arraycopy 需要类型信息）、依赖 Universe（异常桩需要 Klass）、依赖 CPU 特性检测（AES/SHA 需要 VAES/AVX512 支持）。两阶段分离确保初始化顺序正确：Phase 1 桩 → universe_init → Phase 2 桩 → compileBroker_init。

2. **BufferBlob 在 CodeCache NonNMethodCodeHeap 中**: 所有 StubRoutines 桩代码通过 `BufferBlob::create(name, size)` 在 CodeCache 的 NonNMethodCodeHeap 中分配——与解释器 codelet（StubQueue）和 JIT 编译的 nmethod 共享空间。`StubRoutines (1)` 占 30KB，`StubRoutines (2)` 占 46.3KB，`MethodHandles adapters` 占 ~32KB。`jcmd <pid> Compiler.CodeHeap_Analytics` 可以看到这些 Blob。

3. **resolve blob 的 RegisterSaver + GC map 机制**: `generate_resolve_blob()`（`sharedRuntime_x86_64.cpp:3533-3608`）生成的每个 RuntimeStub 包含：RegisterSaver（保存所有 live registers 到栈）、`last_Java_frame` 设置（使 GC 能遍历栈）、C++ 函数调用（解析方法）、`pending_exception` 检查（有异常则跳转到 `_forward_exception_entry`）、`vm_result` 读取（解析后的目标地址）、寄存器恢复、`jmp rax` 跳转。GC map 标记哪些栈位置是 oop——GC 在 safepoint 时可以安全遍历这些桩的栈帧。

4. **SafepointBlob 的 polling page 协议**: `_polling_page_safepoint_handler_blob` 和 `_polling_page_return_handler_blob` 处理安全点轮询。JIT 编译的代码中嵌入 `test %eax, (%rax)` 指令——正常情况下 `(%rax)` 指向可读内存，指令执行通过。当 JVM 需要安全点时，`SafepointSynchronize::begin()` 调用 `mprotect` 将 polling page 设为不可读——`test` 指令触发 SIGSEGV → 信号处理器识别为安全点请求 → 跳转到 handler blob → 调用 `SafepointSynchronize::handle_polling_page_exception()` → 线程在安全点阻塞。

5. **safefetch 的 SIGSEGV 容错设计**: `_safefetch32_entry` 和 `_safefetchN_entry` 是 crash-safe 内存读取桩。它们包含两个特殊地址：`_fault_pc`（故障点 PC）和 `_continuation_pc`（恢复点 PC）。当读取的内存地址无效时，CPU 在 `_fault_pc` 处触发 SIGSEGV → JVM 信号处理器检测到 fault PC 匹配 → 将线程的 PC 设为 `_continuation_pc` → 返回默认值（0 或 -1）→ 调用者不会 crash。用于 SA 代理和 debug 场景中的安全内存访问。

6. **AES intrinsic 的条件层次**: `_aescrypt_encryptBlock` 无条件生成（使用 AES-NI 指令）。`_cipherBlockChaining_encryptAESCrypt` 和 `_electronicCodeBook_encryptAESCrypt` 有条件分支：如果 CPU 支持 VAES + AVX512VL + AVX512DQ → 使用 VAES 向量路径（512-bit 一次处理 4 个 AES 块）；否则 → 使用并行标量路径。`_counterMode_AESCrypt` 额外需要 AVX512BW。这些条件在运行时通过 `VM_Version::supports_vaes()` 等检测——同一份 libjvm.so 自适应不同 CPU。

7. **MethodHandlesAdapterBlob 与解释器 _entry_table 的集成**: `MethodHandles::generate_adapters()` 生成的适配器代码存储在 `MethodHandlesAdapterBlob` 中（CodeCache NonNMethodCodeHeap）。循环遍历 `method_handle_invoke_FIRST` 到 `method_handle_invoke_LAST`（6 个 MethodKind），每个调用 `generate_method_handle_interpreter_entry()` 生成独立的适配器。生成的入口地址通过 `Interpreter::set_entry_for_kind(mk, entry)` 写入 `AbstractInterpreter::_entry_table`——覆盖 `initialize_method_handle_entries()` 预设的 `AbstractMethodError` 默认入口。如果某个 intrinsic 的生成失败（`entry == NULL`），保持 AME 入口——调用该方法时抛出 AbstractMethodError 而非 crash。

---

## §二 Standard Environment

OpenJDK 11 slowdebug, 64-bit Linux.

Source roots:
- `src/hotspot/share/runtime/stubRoutines.cpp` — initialize1() (:196), initialize2() (:306)
- `src/hotspot/share/runtime/stubRoutines.hpp` — 所有 _*_entry 指针声明
- `src/hotspot/cpu/x86/stubRoutines_x86.cpp` — x86 特定桩（CRC32C table, :284）
- `src/hotspot/cpu/x86/stubRoutines_x86.hpp` — code_size1/2 常量 (:35)
- `src/hotspot/cpu/x86/stubGenerator_x86_64.cpp` — generate_initial() (:5858), generate_all() (:5960)
- `src/hotspot/share/runtime/sharedRuntime.cpp` — generate_stubs() (:101)
- `src/hotspot/cpu/x86/sharedRuntime_x86_64.cpp` — generate_resolve_blob() (:3533), generate_handler_blob() (:3372)
- `src/hotspot/share/prims/methodHandles.cpp` — generate_adapters() (:75)
- `src/hotspot/share/code/codeBlob.cpp` — MethodHandlesAdapterBlob::create() (:331)
- `src/hotspot/share/code/codeBlob.hpp` — MethodHandlesAdapterBlob 类 (:450)

Build: `make jdk`

Key binary: `build/linux-x86_64-normal-server-slowdebug/jdk/lib/libjvm.so`

**Syscall 速查**：

| Syscall | man | 用途 |
|---------|-----|------|
| `mmap` | man 2 mmap | CodeCache VirtualSpace 分配（BufferBlob 底层） |
| `mprotect` | man 2 mprotect | polling page 保护切换（RW→NONE）触发 safepoint |
| `sigaction` | man 2 sigaction | safefetch 的 SIGSEGV 处理器注册 |

**CodeCache Blob 速查**：

| Blob 名称 | 大小 (x86_64) | 生成函数 | Phase |
|-----------|:--:|---------|-------|
| "StubRoutines (1)" | 30,000B | generate_initial() | init1 |
| "StubRoutines (2)" | 46,300B | generate_all() | init2 |
| "wrong_method_stub" | ~1,000B | generate_resolve_blob() | SharedRuntime |
| "ic_miss_stub" | ~1,000B | generate_resolve_blob() | SharedRuntime |
| "resolve_opt_virtual_call" | ~1,000B | generate_resolve_blob() | SharedRuntime |
| "resolve_virtual_call" | ~1,000B | generate_resolve_blob() | SharedRuntime |
| "resolve_static_call" | ~1,000B | generate_resolve_blob() | SharedRuntime |
| "polling_page_safepoint_handler" | ~2,048B | generate_handler_blob() | SharedRuntime |
| "polling_page_return_handler" | ~2,048B | generate_handler_blob() | SharedRuntime |
| deopt_blob | ~4-8KB | generate_deopt_blob() | SharedRuntime |
| uncommon_trap_blob | ~2-4KB | generate_uncommon_trap_blob() | SharedRuntime |
| "MethodHandles adapters" | ~32KB | generate_adapters() | MethodHandles |
| **总计** | **~140KB** | | |

---

## §三 Source Files Table

| # | File | Full Path | Lines | Core Functions | Role |
|---|------|-----------|:--:|-------|------|
| 1 | **stubRoutines.cpp** | `src/hotspot/share/runtime/stubRoutines.cpp` | 614 | `initialize1()`(:196), `initialize2()`(:306) | 桩代码初始化调度器 |
| 2 | **stubRoutines.hpp** | `src/hotspot/share/runtime/stubRoutines.hpp` | 500+ | 所有 `_*_entry` 静态指针声明 | 桩入口指针声明 |
| 3 | **stubRoutines_x86.hpp** | `src/hotspot/cpu/x86/stubRoutines_x86.hpp` | 80+ | `code_size1 = 30000`, `code_size2 = 46300` | x86 缓冲区大小常量 |
| 4 | **stubGenerator_x86_64.cpp** | `src/hotspot/cpu/x86/stubGenerator_x86_64.cpp` | 6115 | `generate_initial()`(:5858), `generate_all()`(:5960) | x86_64 桩代码生成 |
| 5 | **sharedRuntime.cpp** | `src/hotspot/share/runtime/sharedRuntime.cpp` | 3246 | `generate_stubs()`(:101) | SharedRuntime 桩生成入口 |
| 6 | **sharedRuntime_x86_64.cpp** | `src/hotspot/cpu/x86/sharedRuntime_x86_64.cpp` | 4006 | `generate_resolve_blob()`(:3533), `generate_handler_blob()`(:3372), `generate_deopt_blob()`(:2813) | x86_64 resolve/blob 生成 |
| 7 | **methodHandles.cpp** | `src/hotspot/share/prims/methodHandles.cpp` | 1613 | `generate_adapters()`(:75), `generate_method_handle_interpreter_entry()` | MH 适配器生成 |
| 8 | **codeBlob.cpp** | `src/hotspot/share/code/codeBlob.cpp` | ~800 | `MethodHandlesAdapterBlob::create()`(:331) | MH AdapterBlob 分配 |
| 9 | **codeBlob.hpp** | `src/hotspot/share/code/codeBlob.hpp` | ~500 | `MethodHandlesAdapterBlob` 类(:450) | CodeBlob 类层次 |

---

## §四 Deep Dive Question Groups（≥6 组，每组含 counterfactual）

### 4.1 ★★★ StubRoutines::initialize1() — Phase 1 桩代码

```
问题：
  ① initialize1() (stubRoutines.cpp:196-233, 37 行) 生成哪些"早期可用"的桩？
      答案方向: 源码展示：
        BufferBlob* blob = BufferBlob::create("StubRoutines (1)", code_size1);
        // code_size1 = 20000 + 10000(LP64) = 30000 bytes (x86_64)
        CodeBuffer buffer(blob);
        StubGenerator g(&buffer, false);  // false = generate_initial() only
        
        generate_initial() (stubGenerator_x86_64.cpp:5858-5958) 生成：
        - _call_stub_entry: C++ → Java 调用桥接（C2I adapter 的前身）
        - _catch_exception_entry: megamorphic call 的异常捕获器
        - _forward_exception_entry: 异常处理链遍历器
        - 6 个原子操作桩: xchg (jint/jlong), cmpxchg (jint/jbyte/jlong), add (jint/jlong)
        - _fence_entry: mfence/lfence/sfence 内存屏障
        - _get_previous_fp/sp_entry: 栈帧遍历
        - _verify_mxcsr_entry: MXCSR 验证
        - _throw_StackOverflowError_entry (RuntimeStub, 含 OopMap)
        - _throw_delayed_StackOverflowError_entry (RuntimeStub)
        
        条件桩:
        - UseCRC32Intrinsics → _updateBytesCRC32 + _crc_table_adr
        - UseCRC32CIntrinsics → _updateBytesCRC32C + _crc32c_table_addr
        - UseLibmIntrinsic + InlineIntrinsics → _dexp/_dlog/_dlog10/_dpow/_dsin/_dcos/_dtan
      
      追问: 为什么 _throw_StackOverflowError_entry 是 RuntimeStub 而非裸地址？
      → RuntimeStub 包含 OopMap——GC 在 safepoint 时需要知道哪些寄存器/栈位置是 oop。
        裸地址没有 OopMap → GC 无法安全遍历 → 在抛出 StackOverflowError 时如果恰好
        触发 GC → 可能误将非 oop 值当作 oop 处理 → 内存损坏。

  ② Counterfactual: 如果 Phase 1 和 Phase 2 合并为单次生成？
      答案方向: Phase 2 的桩（arraycopy, AES/SHA）依赖 Metaspace（arraycopy 需要类型信息）
        和 CPU 特性检测（AES 需要 VM_Version_init 完成）。合并后 → 必须在 universe_init
        和 VM_Version_init 之后才能生成所有桩 → 但 _call_stub_entry 在 universe_init
        之前的初始化步骤中就需要使用 → 循环依赖。两阶段分离打破循环依赖。
```

### 4.2 ★★★ StubRoutines::initialize2() — Phase 2 桩代码

```
问题：
  ① initialize2() (stubRoutines.cpp:306-408, 102 行) 生成哪些"后期可用"的桩？
      答案方向: 源码展示 3 大类别：
        
        A. 异常桩 (RuntimeStub):
          _throw_AbstractMethodError_entry
          _throw_IncompatibleClassChangeError_entry
          _throw_NullPointerException_at_call_entry
        
        B. 数据操作桩:
          generate_arraycopy_stubs() → 24 个入口
          _jbyte_fill, _jshort_fill, _jint_fill (array fill)
          _arrayof_jbyte_fill, _arrayof_jshort_fill, _arrayof_jint_fill
        
        C. 加密/哈希 intrinsic (条件):
          UseAESIntrinsics → _aescrypt_encryptBlock/decryptBlock + CBC/ECB/CTR
          UseSHA1Intrinsics → _sha1_implCompress + _sha1_implCompressMB
          UseSHA256Intrinsics → _sha256_implCompress + _sha256_implCompressMB
          UseSHA512Intrinsics → _sha512_implCompress + _sha512_implCompressMB
          UseGHASHIntrinsics → _ghash_processBlocks
          UseBASE64Intrinsics → _base64_encodeBlock
        
        D. 大数运算 (C2 only):
          _multiplyToLen, _squareToLen, _mulAdd, _montgomeryMultiply, _montgomerySquare
        
        E. 其他:
          _verify_oop_subroutine_entry
          _safefetch32_entry + _fault_pc + _continuation_pc
          _safefetchN_entry + _fault_pc + _continuation_pc
          _vectorizedMismatch
          x86 浮点修复: _f2i_fixup, _f2l_fixup, _d2i_fixup, _d2l_fixup
          11 个浮点/向量常量表指针
        
        ASSERT 自测: TEST_ARRAYCOPY × 4, TEST_FILL × 3, TEST_COPYRTN × 4, safefetch test
      
      追问: 为什么 safefetch 需要 _fault_pc 和 _continuation_pc 两个地址？
      → SIGSEGV 信号处理器在检测到 fault PC 匹配后，将线程 PC 设为 continuation PC。
        这不是 try-catch——是 CPU 级别的控制流劫持。continuation PC 处的代码返回
        默认值（0 或 -1）→ 调用者不会 crash。用于 SA 代理读取可能无效的内存地址。

  ② Counterfactual: 如果 AES intrinsic 桩不检查 CPU 特性而直接生成 VAES 指令？
      答案方向: 在不支持 VAES 的 CPU 上执行 VAES 指令 → #UD (Undefined Opcode) 异常
        → SIGILL → JVM crash。条件生成确保同一份 libjvm.so 可以运行在不同 CPU 上——
        Intel Sandy Bridge（无 VAES）使用标量 AES-NI 路径，Intel Icelake（有 VAES）
        使用 512-bit VAES 向量路径。运行时 CPU 检测（VM_Version::supports_vaes()）
        在 VM_Version_init() 中完成，早于 initialize2()。
```

### 4.3 ★★★ SharedRuntime::generate_stubs() — resolve blob + safepoint blob

```
问题：
  ① generate_stubs() (sharedRuntime.cpp:101-136, 36 行) 生成的 resolve blob 如何工作？
      答案方向: generate_resolve_blob() (sharedRuntime_x86_64.cpp:3533-3608) 生成模板：
        1. RegisterSaver::save_live_registers() — 保存所有 caller-save 寄存器到栈
        2. set_last_Java_frame() — 设置 last_Java_sp/pc，GC 可遍历
        3. call C++ resolve function (e.g. SharedRuntime::handle_wrong_method)
        4. 添加 GC map — 标记 oop 位置
        5. 检查 pending_exception → 有异常则 jmp _forward_exception_entry
        6. 读取 vm_result (rax) = 解析后的目标地址, vm_result_2 (rbx) = Method*
        7. RegisterSaver::restore_live_registers()
        8. jmp rax — 跳转到解析后的方法入口
      
      6 个 resolve blob 共享相同的模板结构，区别仅在于调用的 C++ 函数：
        _wrong_method_blob → handle_wrong_method (虚方法分派失败)
        _wrong_method_abstract_blob → handle_wrong_method_abstract (abstract 方法)
        _ic_miss_blob → handle_wrong_method_ic_miss (内联缓存未命中)
        _resolve_opt_virtual_call_blob → resolve_opt_virtual_call_C
        _resolve_virtual_call_blob → resolve_virtual_call_C
        _resolve_static_call_blob → resolve_static_call_C
      
      追问: 为什么 resolve blob 不直接调用目标方法而是返回地址？
      → 解析操作可能涉及类加载（resolve_static_call 需要加载目标类）→ 类加载可能
        触发 safepoint → 栈上所有 oop 必须正确标记（通过 GC map）→ 解析完成后
        寄存器状态可能已被 GC 修改 → 必须先恢复寄存器再跳转。

  ② Counterfactual: 如果没有 resolve blob，IC miss 如何处理？
      答案方向: IC miss 需要从编译代码回到解释器 → 去优化（deoptimization）→ 解释器
        重新解析方法 → 重新进入编译代码。去优化的开销 ~1000ns（重建解释器帧 + 复制
        局部变量）。Resolve blob 直接在编译帧中调用 C++ 解析 → 不需要帧重建 → ~100ns。
        10× 更快。而且 resolve blob 不丢弃编译代码——下次调用直接命中正确的 IC 条目。
```

### 4.4 ★★★ MethodHandles::generate_adapters() — MH 适配器

```
问题：
  ① generate_adapters() (methodHandles.cpp:75-89, 15 行) 如何生成 MH 适配器？
      答案方向: 源码展示：
        _adapter_code = MethodHandlesAdapterBlob::create(adapter_code_size);
        CodeBuffer code(_adapter_code);
        MethodHandlesAdapterGenerator g(&code);
        g.generate();  // methodHandles.cpp:94-108
        
        generate() 循环:
        for (Interpreter::MethodKind mk = method_handle_invoke_FIRST;
             mk <= method_handle_invoke_LAST;
             mk = MethodKind(1 + (int)mk)) {
          vmIntrinsics::ID iid = method_handle_intrinsic(mk);
          address entry = generate_method_handle_interpreter_entry(_masm, iid);
          if (entry != NULL) {
            Interpreter::set_entry_for_kind(mk, entry);
          }
          // entry == NULL → 保持 AME 入口（在 initialize_method_handle_entries() 中预设）
        }
      
      覆盖的 intrinsic:
        _invokeBasic — 最基本 MH 调用，无类型转换
        _linkToVirtual — 虚方法分派
        _linkToStatic — 静态方法调用
        _linkToSpecial — 特殊方法（构造/私有/父类）
        _linkToInterface — 接口方法分派
        _invokeGeneric — 通用调用
      
      追问: 为什么 entry == NULL 时保持 AME 入口？
      → 某些 MH intrinsic 在特定平台可能无法生成（如平台不支持 MH 的某个变体）。
        保持 AME 入口确保调用该方法时抛出 AbstractMethodError 而非跳转到
        随机地址 → 优雅失败 vs crash。

  ② Counterfactual: 如果 MH 适配器使用解释器 codelet 而非独立 Blob？
      答案方向: 解释器 codelet 在 StubQueue 中——每个 codelet 需要 StubQueue 的
        commit() 机制（aligned_size + stub_initialize + _queue_end 推进）。
        MH 适配器是一次性大块分配（~32KB），不需要 codelet 粒度的管理。
        使用独立 BufferBlob 简化分配——单个 mmap 调用 vs StubQueue 的 commit 开销。
```

### 4.5 ★★★ arraycopy 桩的 24 入口体系

```
问题：
  ① generate_arraycopy_stubs() 为什么生成 24 个入口？
      答案方向: 24 = 4 种基本类型 (jbyte/jshort/jint/jlong) × 3 种变体 (conjoint/disjoint/arrayof) × 2
        加上 checkcast_arraycopy, unsafe_arraycopy, generic_arraycopy。
        
        conjoint: src 和 dst 可能重叠 → 使用 memmove 语义（从末尾向开头拷贝）
        disjoint: src 和 dst 保证不重叠 → 使用 memcpy 语义（更快，无方向检查）
        arrayof: oop 对齐的数组元素拷贝 → 使用 movq 而非 movb/movw/movd
        
        C2 JIT 通过 StubRoutines::select_arraycopy_function() 选择入口：
        - 已知类型 + 已知 disjoint → 直接使用 _jint_disjoint_arraycopy
        - 已知类型 + 未知重叠 → _jint_arraycopy（含方向检查）
        - Object[] → _arrayof_jint_arraycopy（oop 对齐）
      
      追问: 为什么 jbyte 也需要 arrayof 版本？
      → byte[] 元素是 1 字节，但 JVM 内部 oop 是 8 字节对齐。当 byte[] 的内容
        需要按 oop 粒度访问（如 GC 扫描），使用 arrayof 版本保证 8 字节对齐拷贝。

  ② Counterfactual: 如果只有 1 个通用 arraycopy 入口？
      答案方向: 通用入口需要运行时检查：类型检查（jbyte/jshort/jint/jlong？）、
        重叠检查（conjoint/disjoint？）、对齐检查（arrayof？）。每次 arraycopy
        增加 3 个条件分支 + 1 个 switch → ~15ns 额外开销。24 入口体系将决策
        从运行时移到 JIT 编译时 → C2 在编译时已知类型和重叠信息 → 直接选择
        最优入口 → 零运行时分支开销。
```

### 4.6 ★★★ polling page 安全点机制

```
问题：
  ① _polling_page_safepoint_handler_blob 如何与 mprotect 配合实现安全点？
      答案方向: 完整流程：
        1. JIT 编译的代码中嵌入: test %eax, (%rax)  // (%rax) 指向 polling page
        2. 正常执行: polling page 可读 → test 指令通过 → 继续执行
        3. JVM 需要安全点: SafepointSynchronize::begin() → mprotect(polling_page, PROT_NONE)
        4. 线程执行到 test 指令 → SIGSEGV (polling page 不可读)
        5. 信号处理器: 检测 fault PC 在 polling page 范围内 → 不是真正的 crash
        6. 跳转到 _polling_page_safepoint_handler_blob
        7. handler blob: 保存寄存器 → call SafepointSynchronize::handle_polling_page_exception()
        8. 线程在安全点阻塞 → GC 执行 → SafepointSynchronize::end()
        9. mprotect(polling_page, PROT_READ) → 恢复 polling page 可读
        10. handler blob: 跳过 test 指令 → 恢复寄存器 → ret
      
      追问: 为什么 POLL_AT_RETURN 和 POLL_AT_LOOP 需要不同的 handler？
      → POLL_AT_RETURN: test 指令在 ret 之前——返回地址已经在栈上，handler 不需要
        额外 push。POLL_AT_LOOP: test 指令在循环回边——返回地址不在栈上，handler
        需要 push 返回地址。两个 handler 的栈布局不同 → 需要不同的 SafepointBlob。

  ② Counterfactual: 如果没有 polling page，如何实现安全点？
      答案方向: 每个安全点位置插入显式的 safepoint check（call safepoint_check_function）
        → 每条回边和每个方法返回都增加 ~20ns 的 call/ret 开销 → 对计算密集型代码
        的吞吐量影响 ~5-10%。Polling page 使用内存保护机制——正常路径零开销（1 条
        test 指令 ~0.3ns），只在需要安全点时付出 SIGSEGV 处理开销（~500ns）。
```

### 4.7 ★★★ safefetch — crash-safe 内存读取

```
问题：
  ① _safefetch32_entry 如何在读取无效地址时不 crash？
      答案方向: 桩代码结构：
        _safefetch32_entry:     mov eax, [rdi]     ; 尝试读取，可能 SIGSEGV
        _fault_pc:              (SIGSEGV 发生点)   ; 信号处理器检查此处
        _continuation_pc:       mov eax, 0          ; 返回默认值 0
                                ret
        
        JVM 信号处理器逻辑（os_linux.cpp）:
        if (pc == StubRoutines::safefetch32_fault_pc()) {
          // 不是真正的 crash——是 safefetch 的预期 SIGSEGV
          ucontext->uc_mcontext.gregs[REG_RIP] = StubRoutines::safefetch32_continuation_pc();
          return true;  // 信号已处理
        }
      
      追问: 为什么 safefetch 在 Phase 2 而非 Phase 1 生成？
      → safefetch 依赖 JVM 信号处理器链已安装（os::init_2() → signal_init()）。
        Phase 1 时信号处理器可能尚未完全就绪。

  ② Counterfactual: 如果 safefetch 使用 try-catch 而非 SIGSEGV 劫持？
      答案方向: C++ try-catch 需要展开栈（unwind）→ 在 safefetch 的桩代码中
        没有 C++ 异常表（桩是裸汇编）→ try-catch 不可用。SIGSEGV 劫持是唯一
        能在汇编代码中实现"容错读取"的机制——信号处理器直接修改 PC，绕过
        崩溃指令，不需要栈展开。
```

### 4.8 ★★★ 桩代码的总内存开销与 CodeCache 占比

```
问题：
  ① ~140KB 的桩代码在 CodeCache 中占比多少？
      答案方向: 默认 NonNMethodCodeHeap 大小约 5MB（-XX:NonNMethodCodeHeapSize）。
        StubRoutines (1+2) + resolve blobs + handler blobs + deopt + MH adapters ≈ 140KB。
        占 NonNMethodCodeHeap 的 ~2.8%。其余空间被解释器 codelet (~256KB)、
        C2I/I2C 适配器（~100KB）、其他 RuntimeStub 使用。
        
        桩代码在 JVM 启动时一次性分配，之后不可变（BufferBlob 不可 resize）。
        code_size1=30000 和 code_size2=46300 是 x86_64 的硬编码常量——如果生成的
        代码超过此大小，assert(buffer.insts_remaining() > 200) 会触发失败。
      
      追问: 为什么 code_size2 (46.3KB) > code_size1 (30KB)？
      → Phase 2 生成的桩代码远比 Phase 1 多：arraycopy 24 入口 + AES/SHA intrinsic
        + 大数运算 + safefetch + fill + 浮点修复。这些 intrinsic 使用向量指令
        (AVX-512)，每个 intrinsic 的代码量远超 Phase 1 的简单原子操作。
```

---

## §五 Article Structure

```
§〇 生产场景
  ★ 场景 1: System.arraycopy() 的 native 调用如何到达 memmove（24 入口体系）
  ★ 场景 2: BigInteger.multiply() 的大数乘法加速（_multiplyToLen 桩）
  ★ 场景 3: 内联缓存未命中触发 _ic_miss_blob（resolve blob 机制）
  每个场景: 真实症状 + 三步诊断 + 反事实讨论

§一 ★★★ StubRoutines + SharedRuntime 4 调用全链路源码走读
  1.1 stubRoutines_init1() → initialize1() — 16 个 Phase 1 桩
  1.2 _call_stub_entry — C++ → Java 调用桥接
  1.3 原子操作桩 (6 个) + _fence_entry 内存屏障
  1.4 CRC32/CRC32C 条件桩 + libm 数学 intrinsic
  1.5 stubRoutines_init2() → initialize2() — 3 个异常桩 + 24 arraycopy 入口
  1.6 AES/SHA/GHASH/BASE64 intrinsic 条件层次
  1.7 大数运算桩 (5 个, C2 only) + safefetch + vectorizedMismatch
  1.8 ASSERT 自测 (TEST_ARRAYCOPY/TEST_FILL/TEST_COPYRTN)
  1.9 SharedRuntime::generate_stubs() — 6 resolve blob + 3 safepoint blob
  1.10 generate_resolve_blob() — RegisterSaver + GC map + pending_exception
  1.11 polling page + mprotect 安全点协议
  1.12 MethodHandles::generate_adapters() — MH intrinsic 适配器
  1.13 ★ Mermaid: StubRoutines 初始化序列图
      Lanes: init_globals / StubRoutines::init1 / StubRoutines::init2 / SharedRuntime / MethodHandles / CodeCache
  1.14 ★ 面试 Story Format 答案

§二 Standard Environment + syscall 速查表 + CodeCache Blob 速查表

§三 Source Files Table（9 个文件）

§四 ★★★ 7 Beginner Callout 框
  > **1. StubRoutines 的两阶段设计**
  > **2. BufferBlob 在 CodeCache NonNMethodCodeHeap 中**
  > **3. resolve blob 的 RegisterSaver + GC map 机制**
  > **4. SafepointBlob 的 polling page 协议**
  > **5. safefetch 的 SIGSEGV 容错设计**
  > **6. AES intrinsic 的条件层次**
  > **7. MethodHandlesAdapterBlob 与解释器 _entry_table 的集成**

§五 ★★★ 桩代码分类与 intrinsic 条件矩阵
  5.1 Phase 1 桩完整清单表（16 个 + 条件桩）
  5.2 Phase 2 桩完整清单表（50+ 个 + 条件分支）
  5.3 arraycopy 24 入口体系（4 类型 × 3 变体 + 通用）
  5.4 AES intrinsic 条件层次图（AES-NI → VAES → AVX512BW）
  5.5 SHA intrinsic 多块 (MB) 版本的设计意图
  5.6 大数运算桩的 C2-only 条件

§六 ★★★ resolve blob + safepoint blob + MH 适配器
  6.1 6 个 resolve blob 对比表（处理函数 + 触发场景）
  6.2 generate_resolve_blob() 的 8 步模板
  6.3 polling page + mprotect 安全点完整协议
  6.4 safefetch 的 SIGSEGV 劫持机制（fault_pc + continuation_pc）
  6.5 MH 适配器的 6 个 intrinsic + _entry_table 集成

§七 ★★ 条件分支 + CodeCache 内存开销
  7.1 intrinsic 条件矩阵表（UseCRC32 × UseAES × UseSHA × UseGHASH × ...）
  7.2 CodeCache Blob 大小明细表
  7.3 NonNMethodCodeHeap 占比分析

§八 ★ GDB 断点验证 — 8 断点
  断言 1: stubRoutines.cpp:196 — 验证 BufferBlob::create("StubRoutines (1)")
  断言 2: stubRoutines.cpp:306 — 验证 BufferBlob::create("StubRoutines (2)")
  断言 3: stubGenerator_x86_64.cpp:5858 — 验证 generate_initial() 入口
  断言 4: sharedRuntime.cpp:106 — 验证 _ic_miss_blob 生成
  断言 5: methodHandles.cpp:84 — 验证 MethodHandlesAdapterBlob::create
  断言 6: sharedRuntime_x86_64.cpp:3533 — 验证 RegisterSaver 保存
  断言 7: stubRoutines.cpp:321 — 验证 TEST_ARRAYCOPY 自测
  断言 8: stubRoutines.cpp:407 — 验证 safefetch 自测

§九 ★ Cross-Reference
  ❓ 01-CodeCache — BufferBlob 在 NonNMethodCodeHeap 中分配
  ❓ 14-Interpreter — _entry_table 集成 + _forward_exception_entry 使用
  ❓ 16-Universe-Post-Init — 异常桩需要的 Klass（OOM/NPE 等）
  ❓ 06-Mutex — safepoint 锁机制

§十 诊断工具
  ❓ jcmd <pid> Compiler.CodeHeap_Analytics — 验证 StubRoutines Blob
  ❓ GDB: print StubRoutines::_jbyte_arraycopy — 验证桩地址
  ❓ strace -e mprotect — 验证 polling page 保护切换
  ❓ /proc/<pid>/maps — 验证 CodeCache 映射

§十一 边缘场景
  ❓ code_size 不足 → assert insts_remaining > 200 失败
  ❓ safefetch 在非 JVM 信号上下文中的行为
  ❓ Client VM 跳过大数运算桩
  ❓ CDS 恢复时的桩代码重用
```

---

## §六 Writing Requirements

### "不要写成→应该写成"对照表

| 不要写成 | 应该写成 |
|---------|---------|
| "stubRoutines_init1 生成原子操作桩" | "initialize1() at stubRoutines.cpp:196 通过 BufferBlob::create("StubRoutines (1)", 30000) 在 CodeCache NonNMethodCodeHeap 分配 30KB → StubGenerator::generate_initial() 生成 _atomic_xchg_entry (lock xchg), _atomic_cmpxchg_entry (lock cmpxchg), _atomic_add_entry (lock xadd) 等 6 个原子操作桩——每个是 ~20 字节的汇编序列，通过 StubRoutines 静态指针暴露给 C1/C2 编译器" |
| "initialize2 生成 arraycopy 桩" | "initialize2() at stubRoutines.cpp:306 调用 generate_arraycopy_stubs() 生成 24 个 arraycopy 入口：jbyte/jshort/jint/jlong × conjoint(重叠安全, memmove 语义)/disjoint(不重叠, memcpy 语义)/arrayof(oop 对齐) × 2——C2 JIT 通过 StubRoutines::select_arraycopy_function() 在编译时选择最优入口，零运行时分支开销" |
| "generate_stubs 生成 resolve blob" | "generate_stubs() at sharedRuntime.cpp:101 通过 generate_resolve_blob() (sharedRuntime_x86_64.cpp:3533) 生成 6 个 RuntimeStub——每个含 RegisterSaver(保存所有 caller-save 寄存器), set_last_Java_frame(GC 可遍历), C++ 函数调用, GC map(标记 oop), pending_exception 检查(有异常→jmp _forward_exception_entry), vm_result 读取(rax=目标地址), 寄存器恢复, jmp rax" |
| "polling page 实现安全点" | "SafepointSynchronize::begin() 调用 mprotect(polling_page, PROT_NONE) 将 polling page 设为不可读 → JIT 代码中嵌入的 test %eax, (%rax) 触发 SIGSEGV → 信号处理器跳转到 _polling_page_safepoint_handler_blob → call handle_polling_page_exception() → 线程阻塞 → GC 执行 → end() 调用 mprotect(polling_page, PROT_READ) 恢复" |
| "safefetch 安全读取内存" | "_safefetch32_entry 桩在 mov eax, [rdi] 指令处标记 _fault_pc——读取无效地址时 SIGSEGV → JVM 信号处理器检测 fault_pc 匹配 → 设置 RIP=_continuation_pc → 执行 mov eax, 0 → ret 返回默认值 0——CPU 级别控制流劫持，非 try-catch" |
| "generate_adapters 生成 MH 适配器" | "generate_adapters() at methodHandles.cpp:75 创建 MethodHandlesAdapterBlob::create(~32KB) 在 CodeCache → 循环 method_handle_invoke_FIRST..LAST 为 6 个 intrinsic (_invokeBasic/_linkToVirtual/_linkToStatic/_linkToSpecial/_linkToInterface/_invokeGeneric) 生成适配器 → 通过 Interpreter::set_entry_for_kind() 写入 _entry_table——覆盖 initialize_method_handle_entries() 预设的 AME 入口" |
| "AES 桩使用 VAES 指令" | "_cipherBlockChaining_encryptAESCrypt 在 supports_vaes() && avx512vl && avx512dq 时使用 VAES 向量路径 (512-bit, 一次 4 AES 块)——否则回退到并行标量 AES-NI 路径。_counterMode_AESCrypt 额外需要 avx512bw。条件检测在 VM_Version_init() 中完成，initialize2() 中根据结果选择生成路径" |

---

## §七 Output Format

- Markdown file, named `15-StubRoutines-SharedRuntime.md`
- Output path: `/data/workspace/openjdk-cut-new/probe_md/01-jvm-startup/docs/`
- 元信息头:
```
> **Phase**: 01-jvm-startup
> **前置**: [01-CodeCache]（BufferBlob 在 NonNMethodCodeHeap 中分配）、[14-Interpreter]（_entry_table 集成 + _forward_exception_entry）、[16-Universe-Post-Init]（异常桩需要的 Klass）
> **配套**: [00-JNI-CreateJavaVM]（init_globals 在 create_vm 中的位置）
> **后续依赖本文**: [17-VTable-IC-Compiler-Infra]（编译基础设施使用这些桩）
> **阅读收益**: 追踪 init_globals 中 4 个桩代码生成调用——理解 StubRoutines 的两阶段设计（Phase 1: 16 个早期桩 30KB, Phase 2: 50+ 个后期桩 46KB）、arraycopy 的 24 入口体系（4 类型 × 3 变体 + 通用）、AES/SHA intrinsic 的运行时 CPU 检测条件层次、resolve blob 的 RegisterSaver + GC map + pending_exception 模板、polling page + mprotect 的安全点协议、safefetch 的 SIGSEGV 劫持容错、MethodHandlesAdapterBlob 与 _entry_table 的集成；掌握 "System.arraycopy 如何到达 memmove" 和 "BigInteger.multiply 如何到达 AVX-512 大数乘法桩" 的完整路径
```
- 目标行数: 1000-1200 lines
- Section 编号: `## §〇` 到 `## §十一`（连续无跳号）

---

## §八 Prohibited（≥8）

- ❌ 只说 "initialize1 生成桩代码" 而不展示 BufferBlob::create("StubRoutines (1)", 30000) 的分配 → 必须从 stubRoutines.cpp:196 源码开始
- ❌ 不展示 arraycopy 的 24 入口体系 → 必须列出 jbyte/jshort/jint/jlong × conjoint/disjoint/arrayof 的完整矩阵
- ❌ 忽略 resolve blob 的 RegisterSaver + GC map 机制 → 必须展示 8 步模板
- ❌ 不解释 polling page 的 mprotect 协议 → 必须展示 PROT_NONE → SIGSEGV → handler → PROT_READ 完整循环
- ❌ 忽略 safefetch 的 SIGSEGV 劫持 → 必须展示 fault_pc + continuation_pc 的 CPU 级别控制流劫持
- ❌ 不展示 AES intrinsic 的条件层次 → 必须展示 AES-NI → VAES+AVX512VL+AVX512DQ → AVX512BW 的条件链
- ❌ 忽略 ASSERT 自测 → 必须展示 TEST_ARRAYCOPY/TEST_FILL/TEST_COPYRTN 的测试逻辑
- ❌ 不做 GDB 断点 trace → 至少 8 个断点
- ❌ 不要解释 x86 汇编指令语义

---

## §九 Required（≥8）

- ✅ **★ Mermaid StubRoutines 初始化序列图** — 6 lanes: init_globals / StubRoutines::init1 / StubRoutines::init2 / SharedRuntime / MethodHandles / CodeCache
- ✅ **★ initialize1() 完整源码走读** — 37 行，BufferBlob + generate_initial + 16 桩清单
- ✅ **★ initialize2() 完整源码走读** — 102 行，generate_all + 50+ 桩清单 + ASSERT 自测
- ✅ **★ generate_resolve_blob() 8 步模板** — RegisterSaver + GC map + pending_exception
- ✅ **★ polling page + mprotect 安全点协议完整流程** — 10 步
- ✅ **★ arraycopy 24 入口矩阵表** — 4 类型 × 3 变体 + 3 通用
- ✅ **★ AES intrinsic 条件层次图** — AES-NI → VAES → AVX512BW
- ✅ **★ 7 Beginner Callout 框** — `> **` 块引用格式
- ✅ **★ 面试 Story Format 答案** — §一末尾
- ✅ **★ GDB 断点 ≥8 条** — 精确到 file:line
- ✅ **★ "不要写成→应该写成"对照表** — §六 中 7 行对照

---

## §十 GDB Verification（≥8 assertions）

```
断言 1: BufferBlob::create("StubRoutines (1)") (stubRoutines.cpp:196)
  (gdb) break stubRoutines.cpp:200
  (gdb) print code_size1 → 期望: 30000 (x86_64)
  (gdb) continue
  (gdb) print StubRoutines::_code1 → 期望: 非 NULL BufferBlob*

断言 2: generate_initial() 入口 (stubGenerator_x86_64.cpp:5858)
  (gdb) break stubGenerator_x86_64.cpp:5858
  (gdb) continue
  (gdb) print StubRoutines::_call_stub_entry → 期望: 非 NULL (已生成)
  (gdb) print StubRoutines::_forward_exception_entry → 期望: 非 NULL

断言 3: BufferBlob::create("StubRoutines (2)") (stubRoutines.cpp:306)
  (gdb) break stubRoutines.cpp:310
  (gdb) print code_size2 → 期望: 46300 (x86_64)
  (gdb) continue
  (gdb) print StubRoutines::_jbyte_arraycopy → 期望: 非 NULL

断言 4: _ic_miss_blob 生成 (sharedRuntime.cpp:106)
  (gdb) break sharedRuntime.cpp:106
  (gdb) continue
  (gdb) print SharedRuntime::_ic_miss_blob → 期望: 非 NULL RuntimeStub*

断言 5: MethodHandlesAdapterBlob::create (methodHandles.cpp:84)
  (gdb) break methodHandles.cpp:84
  (gdb) print adapter_code_size → 期望: ~32768 (32KB)
  (gdb) continue
  (gdb) print MethodHandles::_adapter_code → 期望: 非 NULL

断言 6: RegisterSaver::save_live_registers (sharedRuntime_x86_64.cpp:3533)
  (gdb) break sharedRuntime_x86_64.cpp:3533
  (gdb) print name → 期望: "wrong_method_stub" (第一个 resolve blob)
  (gdb) continue
  (gdb) print SharedRuntime::_wrong_method_blob → 期望: 非 NULL

断言 7: TEST_ARRAYCOPY 自测 (stubRoutines.cpp:321)
  (gdb) break stubRoutines.cpp:321
  (gdb) print StubRoutines::_jbyte_arraycopy → 期望: 非 NULL
  (gdb) continue → 自测通过（无 assert 失败）

断言 8: safefetch 自测 (stubRoutines.cpp:407)
  (gdb) break stubRoutines.cpp:407
  (gdb) print StubRoutines::_safefetch32_entry → 期望: 非 NULL
  (gdb) print StubRoutines::_safefetch32_fault_pc → 期望: 非 NULL
  (gdb) print StubRoutines::_safefetch32_continuation_pc → 期望: 非 NULL
```

---

## §十一 与 README 和同组文档的连续性

1. **从 README §init_globals 调用清单承接**：本文展开 init_globals 的第 8、29、17、30 次调用——从 call_stub 到 MH 适配器的完整代码级解答。

2. **与 01-CodeCache 的连接**：所有桩代码通过 BufferBlob::create() 在 CodeCache NonNMethodCodeHeap 中分配。codeCache_init() 在 stubRoutines_init1 之前执行。~140KB 占 NonNMethodCodeHeap 的 ~2.8%。

3. **与 14-Interpreter 的连接**：_forward_exception_entry 在解释器和编译代码的异常路径中被引用。MethodHandles::generate_adapters() 通过 set_entry_for_kind() 写入解释器的 _entry_table。

4. **与 16-Universe-Post-Init 的连接**：_throw_AbstractMethodError_entry 等异常桩依赖 Universe 中的预分配异常对象（Klass）。这些桩在 universe_post_init 之后才生成。

5. **与 06-Mutex 的连接**：safepoint blob 的 handle_polling_page_exception() 内部获取 Safepoint_lock——该锁在 06-Mutex 文档的 ~90 全局锁列表中定义。

6. **同组边界**：本文覆盖 CodeCache 中的桩代码（call_stub, arraycopy, AES/SHA intrinsic, resolve blob, MH 适配器）；14 覆盖解释器基础设施（字节码表 + 模板分发表）；17 覆盖编译基础设施（vtableStubs, InlineCacheBuffer）。
