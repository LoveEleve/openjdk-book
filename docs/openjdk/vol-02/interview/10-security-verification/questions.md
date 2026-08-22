# 10 · 安全、验证与运行时约束：深度题目

## 1. 为什么 HotSpot 一定要在链接时验证字节码，而不是靠解释器/JIT 运行时再检查？

恶意字节码通过改一个操作码（如把 `iload_0` 改成 `aload_0`）就能把 int 当引用用。为什么只有 link 期的 type checking verifier 能拦住它，而运行时动态检查不能替代？

回答必须覆盖：

- 验证发生在 link 期、逐方法 `verify_method`、逐指令模拟类型流的原因；
- 局部变量和操作数栈的抽象状态如何在控制流上推进；
- 为什么“栈顶类型与指令要求不符”必须当场拒绝；
- 如果只在解释器/JIT 每次执行时检查，会失去什么安全前提和优化基础；
- `VerifyError` 与 running-time 错误（如 ClassCastException）的分工。

追问：为什么 `-Xverify:none` 时同一段恶意字节码能“照常算出结果”？如果控制流汇合点的类型状态互相矛盾，为什么只在运行时才暴露会在更晚点崩溃？

源码入口：`share/classfile/verifier.cpp:140`、`share/classfile/verifier.cpp:603`、`share/classfile/verifier.cpp:630`。

## 2. VerificationType 为什么能用“一个 union + 位段编码”装下所有类型？

帧里的每个槽是一个 `VerificationType`。为什么它不用完整对象层次，而用 `Symbol*` 或压缩 `_data` 的 union 编码？

回答必须覆盖：

- 引用类型直接存 `Symbol*`（低 2 位为 0 可当标志），非引用类型压缩进 `_data`；
- 低 2 位 TypeMask 如何区分 Reference/Primitive/Uninitialized/TypeQuery；
- 为什么 `Long`/`Double` 需要显式的 `Long_2nd`/`Double_2nd` 次槽类型；
- 为什么 narrow 类型（Boolean/Byte/Short/Char）只在方法签名转换时出现，而 `i2b` 等指令推 integer；
- Bogus/Top 在实现里为什么是同一个别名。

追问：如果次槽也用 `Top`（即 bogus）表示而不是显式 `2_2nd`，`pop_stack(Category2Query)` 后次槽为什么可能被错误地当作“未使用槽”放行？

源码入口：`share/classfile/verificationType.hpp:48`、`share/classfile/verificationType.hpp:62`、`share/classfile/verificationType.hpp:130`、`share/classfile/stackMapTable.cpp:300`。

## 3. `is_assignable_from` 为什么既做类型判定，又可能触发类解析？

验证器做可赋值性检查时，为什么不能只比较类型名字，而必须检查类层次，甚至触发类加载？

回答必须覆盖：

- 同名类型直接通过；null 赋给任何引用通过；
- 目标是 `java.lang.Object` → 任何对象/数组都通过；
- 数组对数组递归比较组件类型；
- 其余情况走 `resolve_and_check_assignability` 解析类层次；
- 为什么 StackMapTable 构造时不解析，而可赋值性检查却可能触发解析（也包括 CDS 的 verification constraint 推迟到运行时的分支）。

追问：如果验证器只读类型名字、从不解析类层次，哪种“恶意但 self-consistent”的字节码会被错误放行？CDS 下为什么把某些可赋值性约束延迟到运行时？

源码入口：`share/classfile/verificationType.hpp:267`、`share/classfile/verificationType.cpp:79`、`share/classfile/verificationType.cpp:47`。

## 4. `Uninitialized` 类型如何在整个构造阶段被追踪，直到 `invokespecial <init>` 后才变成正式类型？

`new` 出来的对象在 `VerificationType` 里为什么不直接是它的类，而是带 bci 的 `Uninitialized`？

回答必须覆盖：

- `Uninitialized` 编码如何携带创建它的 `new` 指令的 bci；
- 为什么未初始化对象不能在这些操作中被错误使用；
- 构造函数 `this` 用 `Uninitialized-This` 表示的原因；
- 哪些指令要求 `Uninitialized` 状态，哪些会推进它；
- 当 `<init>` 完成后，对象何时变成普通引用类型。

追问：如果一个未初始化对象在 `<init>` 前被存储到字段或返回，验证器如何拒绝？`reachable`/`initialized` 的切换点为什么是构造调用而非对象创建点？

源码入口：`share/classfile/verificationType.hpp:79`、`share/classfile/verifier.cpp:1652`。

## 5. Unsafe 的“不安全”到底由谁兜底：模块系统、caller 检查，还是完全不检查？

`jdk.internal.misc.Unsafe` 和 `sun.misc.Unsafe` 的权限模型为什么不同？Unsafe 方法体为什么本身不做任何地址/类型检查？

回答必须覆盖：

- `jdk.internal.misc.Unsafe` 用模块封闭保护，`getUnsafe()` 无运行时检查；
- `sun.misc.Unsafe.getUnsafe()` 用 `@CallerSensitive` + 系统域 loader 检查拦截误用；
- 反射拿 `theUnsafe` 后如何绕过 caller 检查；
- 为什么访问堆内字段走 `HeapAccess<>`（带 GC barrier），堆外走 `RawAccess<>`（无引用语义）；
- 为什么 `assert_field_offset_sane` 只在 debug 构建校验，release 构建零检查。

追问：如果一个库不经 Unsafe 直接对压缩 oop 字段做 get/put，GC 引用追踪会漏掉什么并发写入？`putOrdered` 与 volatile put 的屏障差异为什么也由 C2 编译期决定？

源码入口：`share/prims/unsafe.cpp:907`、`share/prims/unsafe.cpp:1035`、`java.base/share/classes/jdk/internal/misc/Unsafe.java:565`、`jdk.unsupported/share/classes/sun/misc/Unsafe.java:95`。

## 6. JPMS 的访问控制为什么是“loadable ≠ readable ≠ exported ≠ open”多层门，而不是一个布尔开关？

为什么 `public` 类在模块化后不再自动“能被任何地方访问”？`ModuleEntry` 和 `PackageEntry` 为什么必须分层保存，而不是只记“是否开放”？

回答必须覆盖：

- loader visibility、module readability、package export/open 的先后关系；
- `ModuleEntry` 记录 reads/open/patched，而 package export 属于 `PackageEntry` 层；
- VM linkage 的 `Reflection::verify_class_access` 与 Java reflection 的 `verifyModuleAccess` 是不同调用点；
- `--add-reads`/`--add-exports`/`--add-opens` 改变的不是同一道门；
- 为什么 `Module.isExported` 不能独自判定完整模块访问。

追问：如果模块 A reads B，但 B 不导出目标包，静态链接和深反射分别会怎样失败？open module 为什么不等同于自动创造了 read edge？

源码入口：`share/classfile/moduleEntry.cpp:115`、`share/classfile/packageEntry.cpp:44`、`share/runtime/reflection.cpp:491`、`java.base/share/classes/java/lang/Module.java:603`。

## 7. Verifier、JPMS、Unsafe 三者合起来，是在保护哪一条“运行时不变量”？

Verifier 证明类型安全、JPMS 约束模块访问、Unsafe 提供内部信任后门。它们各自保护的不变量是什么？真正的安全边界画在哪？

回答必须覆盖：

- Verifier 保护的是“字节码执行时类型状态自洽”；
- JPMS/反射检查保护的是“命名访问遵循模块与访问控制语义”；
- Unsafe 是“JDK 内部信任的后门”，不是“沙箱授权”，其不变量是“信任调用方已自行考虑安全”；
- HotSpot 不会为 Unsafe 的任意地址访问提供防护，它依赖调用方的正确性；
- 因此 JVM 的“安全”是分层自洽，不是单点闸门。

追问：如果 verifier 被跳过而 Unsafe 又被允许，会先破坏哪一层不变量？为什么“压缩 oop 位移不可见 + 堆外 RawAccess”这样的组合会放大绕过访问控制的风险？

源码入口：`share/classfile/verifier.cpp:140`、`share/prims/unsafe.cpp:907`、`share/runtime/reflection.cpp:491`。