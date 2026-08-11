# 01. 字节码验证引擎 — ClassVerifier + StackMapTable

> 🔴 Deep | 逐方法 type-check bytecode
> 读者处境: `ClassLoader.loadClass("MaliciousClass")` — 在 JVM 定义 class 之前, Verifier 检查每个方法的字节码——operand stack 类型必须正确、branch target 必须有效、局部变量类型必须匹配 StackMapTable。类型错误→VerifyError——防止类型混淆攻击(integer→object pointer→crash JVM)。

### 1. "Verifier::verify — 入口"

场景: `ClassFileParser` 解析完 class → `Verifier::verify(klass, mode)`→决定是否需要验证→`ClassVerifier::verify_class()`→`verify_method()` 逐方法验证。

**Verifier::verify** (`verifier.cpp:140-200`):
```
bool Verifier::verify(InstanceKlass* klass, Mode mode, bool should_verify_class, TRAPS) (line 140):
  → should_verify_for(klass->class_loader(), should_verify_class) — 检查 -Xverify flag
  → is_eligible_for_verification(klass, should_verify_class) — bootstrap loader? array class?
  → ClassVerifier::verify_class(klass, mode, ...) — 逐方法验证
  → if VerifyError: log + throw
[C++: verifier.cpp:2913行——ClassVerifier 在 safepoint 外执行——不阻塞 GC]
```
- 源码: `verifier.cpp:140-200` (Verifier::verify) + `verifier.cpp:603-630` (ClassVerifier::verify_class)

- 关键设计: **-Xverify:none/remote/all** — `should_verify_for()` 根据 class loader 来源决定是否验证: bootstrap loader→默认不验证(trusted), 远程 class→默认验证。`-Xverify:all` 强制所有 class 验证, `-Xverify:none` 关闭全部——适合性能测试但牺牲安全。

### 2. "ClassVerifier::verify_method — 逐 method type-check"

场景: 方法 `int add(int a, int b) { return a + b; }` → bytecode: `iload_1, iload_2, iadd, ireturn` → Verifier type-check: 每个 iload 在 operand stack 上 push int→iadd pop two ints+push int→ireturn 期望栈顶=int→✅。`aload_1, ireturn` → aload push Reference→ireturn 期望 int→VerifyError!

**ClassVerifier::verify_method** (`verifier.cpp:630-700`):
```
ClassVerifier::verify_method(method, TRAPS) (line 630):
  → StackMapTable stackmap_table(&reader, &current_frame, max_locals, max_stack, code_data, code_length) (line 677)
  → 遍历 bytecode stream (RawBytecodeStream):
       each opcode → verify_opcode():
         • push/pop on operand stack → check type compatibility
         • branch target → verify target bci exists in StackMapTable
         • invoke → verify method descriptor + receiver type
         • field access → verify field class + type
         • new/newarray → verify class/array element type
  → verify_exception_handler_table — catch 类型检查(exc_type is Throwable subclass?)
  → verify_local_variable_table — 局部变量表一致
[C++: verifier.cpp:677 StackMapTable 构造 + verifier.cpp:1858 verify_stackmap_table]
```
- 源码: `verifier.cpp:630-680` (verify_method entry) + `verifier.cpp:1858-1900` (verify_stackmap_table)

- 关键设计: **StackMapTable 是 JDK 7+ 的 split verifier** — 只验证 branch targets(非每条指令)——与原 inferencing verifier(逐指令推导类型)不同。每个 branch target bci 在 StackMapTable 有对应的 `StackMapFrame`(locals+stack types)→Verifier 对比 current_frame 和 expected_frame→类型不匹配→VerifyError。**双精度/长整型占两个 slot** — doubles/longs consume two local variable slots and two stack slots→verifier 需跟踪 slot 2→type=Top。

---

### 核心悬念

**"Verifier::verify→ClassVerifier::verify_class→verify_method(StackMapTable JDK 7+ split verifier, 逐 opcode type-check operand stack)→VerifyError if 类型不匹配。"** — 下一篇: VerificationType 类型系统。

> → [02-verification-type.md](02-verification-type.md)
