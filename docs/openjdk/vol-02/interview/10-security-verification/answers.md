# 10 · 安全、验证与运行时约束：专家答案锚点

## 1. 只有 link 期 verifier 能把“类型安全”从运行时检查提前成一次性证明

如果把类型检查推迟到解释器/JIT 执行时，就会出现两类问题：一是每次执行都要为栈槽/局部变量付类型检查成本，二是 JIT 无法建立在“字节码已经满足基本类型安全前提”之上，很多优化会失去基础。

所以 HotSpot 在 link 期逐方法 `verify_method`（`share/classfile/verifier.cpp:630`），对每个方法维护 locals/operand stack 的抽象类型状态，逐条模拟字节码。控制流汇合点用 StackMapTable 核对预期类型，不一致就抛 `VerifyError`，而不是等到运行时才在某条错误路径上崩溃。`-Xverify:none` 只是放弃这道证明，不改变语言类型语义——恶意字节码那时会“运气好”地执行到语义错误点。

## 2. VerificationType 用位段编码换取零分配、可判定的类型值

`VerificationType` 不是完整对象，而是 `Symbol*` 或压缩 `_data` 的 union（`share/classfile/verificationType.hpp:48`）。引用类型直接存 `Symbol*`（低 2 位天然为 0 作标志）；非引用类型把 TypeMask + category + descriminator 压进一个 uintptr_t。

`Long`/`Double` 占两个槽，次槽用显式的 `Long_2nd`/`Double_2nd`，而不是 Top/Bogus：这样 `pop_stack(Category2Query)` 弹出首槽后，次槽不能被错误当作独立值使用。narrow 类型（Boolean/Byte/Short/Char）只在方法签名转换时出现，因为 `i2b` 等指令推的是宽化后的 int。`top_type()` 就是 `bogus_type()` 的别名——Top 与 Bogus 在实现层已经合并（`verificationType.hpp:130`）。

## 3. 可赋值性检查必须触碰类层次，因此可能触发解析

只比较类型名字无法回答“A 是否可赋给 B”的继承/接口关系，所以 `is_reference_assignable_from`（`share/classfile/verificationType.cpp:79`）在同名、null、Object、数组递归之外，还要 `resolve_and_check_assignability` 解析类层次（`verificationType.cpp:47`）。

这就解释了为什么 StackMapTable 构造时“只认名字不解析”，但可赋值性检查“按需解析”：读类型项不需要类层次，判子类必须加载。CDS dump 场景会把某些可赋值性约束存入共享字典，运行时再 `check_verification_constraints` 兑现，避免 dump 期早期解析（见 05 域）。

## 4. `Uninitialized` 携带 bci，语义在整个构造阶段被锁定

`new` 产生的对象不能立刻当作普通类引用使用，`VerificationType` 用 `Uninitialized` 类型携带创建它的 `new` 指令的 bci（`share/classfile/verificationType.hpp:79`）。构造函数 `this` 用 `Uninitialized-This`（bci = -1）表示。

验证器追踪每个未初始化对象在哪些指令中被使用，哪些操作（如存取字段、返回、存入结构）会拒绝它。只有 `invokespecial <init>` 完成构造后，对象槽才从 `Uninitialized` 转成正式引用类型。因此“对象可见”的切换点在构造调用，而不在 `new`。

## 5. Unsafe 的安全边界是模块/调用者信任，不是方法内检查

`jdk.internal.misc.Unsafe` 靠模块系统封闭保障：它位于 java.base 内部包，非认可调用者无法引用，其 `getUnsafe()` 就是 `return theUnsafe`。`sun.misc.Unsafe.getUnsafe()` 则用 `@CallerSensitive` + 系统域 loader 检查拦截普通应用误用（`jdk.unsupported/.../sun/misc/Unsafe.java:95`）。

反射取 `theUnsafe` 后即可绕过该检查，因为它是“名字检查”不是“能力检查”。方法体本身不校验 offset 或类型。访问堆内字段必须走 `HeapAccess<>`（带 GC barrier，防止引用追踪漏掉并发写入，`unsafe.cpp:907`），堆外走 `RawAccess<>`（无引用语义）。`assert_field_offset_sane` 只在 debug 构建校验，release 零检查。

## 6. JPMS 是 loadable、readable、export、open 的多层门

“类能被 loader 找到”只解决第一道门；之后还要经过模块可读、包导出、包开放等层次。`ModuleEntry` 记录 reads/open/patched 等模块级状态，`PackageEntry` 管理包级 export/open（`share/classfile/packageEntry.cpp:44`）。VM linkage 走 `Reflection::verify_class_access`，Java reflection 走 `verifyModuleAccess`，是不同调用点。

因此 `--add-reads`、`--add-exports`、`--add-opens` 改变的不是同一道门；`Module.isExported` 也不等价于完整调用者 read 检查。模块 A reads B 但 B 不导出包时，静态链接通常因缺少 export 失败，深反射还需要 open。open module 放宽包反射开放，不等于自动建立 read edge。

## 7. 三者保护的是“类型自洽 + 命名访问自洽”，并保留一个信任后门

Verifier 保证执行时类型状态自洽，是编译与解释都能安全进行的前提；JPMS/反射检查保证命名访问遵循模块与访问控制语义，是跨越 Java 语言命名边界的约束；Unsafe 是 JDK 内部信任的后门，其成立前提是调用者已经自行承担安全与正确性责任，HotSpot 不为此检查内层地址。

因此 JVM 的安全不是一个单点闸门，而是“类型证明 + 模块边界 + 内部信任”的分层组合。跳过 verifier 会让 JIT/解释器失去类型安全保障；而 Unsafe 的任意地址访问 + 压缩 oop 位移不可见 + 堆外 RawAccess 的组合，会把内层异常行为放大成难以诊断的破坏。这也是为什么这些机制既不能互相替代，也不能简单关闭。

## 评分锚点

- **合格**：能说清 Verifier、JPMS、Unsafe 各自“管什么”。
- **良好**：能区分 loadable/readable/export/open，区分 verifier 的类型证明与运行时的类型转换错误。
- **专家级**：能用“类型自洽、命名访问自洽、内部信任后门”的分层框架，说明这三者为什么互相支撑、各自的安全不变量是什么、以及哪些破坏会先发生在哪一层。