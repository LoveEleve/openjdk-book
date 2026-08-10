# MethodHandles — 文章大纲

> vol-04 · 域 31 · 🔴 A | 基于 Pass 0+1 探索笔记
> Pass 1 产出：8 基本元素 / 6 标记问题
>
> **→ 从 Deoptimization**：解释器用 vtable 做 invokevirtual，JIT 用 inline cache 加速——但 JDK7 引入的 invokedynamic 指令呢？它不调固定方法——它调用 bootstrap 方法动态产生的 MethodHandle。Lambda 表达式、字符串拼接、记录类——这些现代 Java 都靠 invokedynamic + MethodHandles 实现。MethodHandles 篇见。

## 概念依赖

先修：Interpreter（MethodHandle 的 adapter 是解释器入口 stub）、C2（LambdaForm 通过 C2 编译成 nmethod）、Deoptimization（CallSite 变更时依赖的 nmethod 需要 deopt）、ClassFile（CONSTANT_InvokeDynamic 常量池项）。

MethodHandles 是 JVM 和 JDK 之间的"双向桥"——JDK 提供 LambdaForm/MethodHandle/CallSite（Java 层），JVM 提供 MemberName 解析、adapter 生成、JIT 内联（C++ 层）。两者协作实现 invokedynamic 的"惰性+动态"链接。

## 叙事计划

**开篇场景**：Java 8 引入 Lambda 表达式：`list.forEach(x -> System.out.println(x))`。编译器生成一个 `invokedynamic` 指令+一个合成方法 `lambda$main$0`。第一次执行 `invokedynamic` 时，bootstrap 方法被调——它创建了一个 `ConstantCallSite`，指向一个 `MethodHandle`（这个 MH 内部调用 `lambda$main$0`）。后续执行同一指令时，直接使用缓存的 CallSite——bootstrap 不再被调。这就是 invokedynamic：**编译时不知道目标，运行时由 bootstrap 决定目标，决定后就缓存**。

**第一层：invokedynamic — 为什么需要"动态链接"？**

传统 invokevirtual：编译时知道 receiver 类型（`Animal.speak()`），运行时在 vtable 中查。invokedynamic：编译时不知道目标——lambda 表达式的方法名是编译器合成的（`lambda$main$0`），不能硬编码到 class 文件。invokedynamic 的字节码格式：

```
invokedynamic #0, #0  // bootstrap=#0, name=accept, type=(Consumer)void
  BootstrapMethods:
    #0: invokestatic LambdaMetafactory.metafactory(...)
```

运行时步骤：
1. 首次执行 invokedynamic → 解析 CONSTANT_InvokeDynamic 常量池项 → 得到 bootstrap 方法引用 + name/type
2. 调用 bootstrap 方法（此处是 `LambdaMetafactory.metafactory`）→ 返回一个 `CallSite`
3. 缓存 CallSite 到 invokedynamic 指令所在位置
4. 后续执行同一 invokedynamic → 直接读取缓存的 CallSite → 调用 `CallSite.getTarget()` → execute

关键设计：bootstrap **只被调一次**。后续执行都走缓存——惰性链接的性能与普通 invoke 相当。

**第二层：MemberName — JVM 怎么"指向"一个方法？**

`java_lang_invoke_MemberName` 是 Java 层 MemberName 对象在 C++ 中的表示。一个 MemberName 包含：`name`（方法名）、`type`（MethodType——参数+返回类型）、`clazz`（所属类）、`flags`（IS_METHOD/IS_CONSTRUCTOR/IS_FIELD 位标志）、**`vmtarget`**（`Method*` 指针——这是 JVM 真正需要的）、**`vmindex`**（vtable 索引——如果是虚拟方法；或字段偏移——如果是字段）。

`resolve_MemberName()`（`methodHandles.hpp:64`）的工作：从 Java 层的 name+type+clazz 出发 → 在指定类的 vtable/itable 中查找 → 找到后填写 `vmtarget`（Method* 指针）和 `vmindex`（索引）。一旦 MemberName 被 resolve——它的 `vmtarget` 就指向目标方法的内存地址——可以直接 `jmp` 过去。

MemberName 和 linkResolver 的关系：linkResolver 做的是"符号引用→Method*"的通用解析。MemberName 做的是相同的事但面向 MethodHandle 的语义——支持 method reference kind（REF_invokeVirtual/REF_invokeStatic/REF_getField 等）、支持 speculative resolve（如果找不到方法，不抛异常，只填标记位）。

**第三层：签名多态 — invokeExact 怎么"接受任何签名"？**

普通的 Java 方法签名是固定的：`int add(int a, int b)`。MethodHandle.invokeExact 不能有固定签名——它可以调任何方法：`MH(x, y)` 返回 `int`，`MH(s)` 返回 `void`，`MH(1.0, "hello")` 返回 `long`。

JVM 用"签名多态 intrinsic"支持：`invokeGeneric`、`invokeBasic`、`linkToVirtual`、`linkToStatic`、`linkToSpecial`、`linkToInterface` 这 6 个 intrinsic 被 JVM 标记为 `is_signature_polymorphic = true`。当 C2 或解释器遇到这些 intrinsic 调用时，**不检查方法签名**——检查的是 MethodHandle 的 `type` 字段：

```
invokeExact(args) → 检查: args 的静态类型 == MH.type?
  YES → invokeBasic(LambdaForm, args)
  NO  → WrongMethodTypeException
```

解释器在 `MethodHandlesAdapterGenerator::generate()` 生成的 stub 中执行同名检查——检查通过后才跳转到实际的 LambdaForm。

**第四层：LambdaForm 编译 — 从解释到 nmethod**

`LambdaForm` 是 MethodHandle 的行为描述——它是一个 `Name[]` 数组，每个 `Name` 表示一个操作（参数加载→函数调用→结果存储）。例如 `MH = identity(int)` 的 LambdaForm 是单指令：`[result = invokeBasic(target, arg)]`。

LambdaForm 的执行路径：
1. 首次调用 → 解释 LambdaForm 的 Name[] → 每条指令走 `MethodHandle.linkTo*()` → 慢
2. JIT 检测到 LambdaForm 被反复调用 → C2 将 Name[] "customize" 为专用于当前签名的优化版本
3. Customized LambdaForm 被编译成 nmethod → 下次调用直接 `jmp` nmethod → 快

C2 的 PhaseMacroExpand 中有专门的 LambdaForm 处理：如果 LambdaForm 只有 1-3 条 Name（如简单 getter/setter），C2 可以将整条链（invokeExact→invokeBasic→LForm→target）内联为一个方法调用——消除 MH 的所有中间层开销。

**第五层：Adapter 生成 — 6 个 MethodHandle intrinsic 的入口 stub**

`MethodHandlesAdapterGenerator::generate()`（`methodHandles.cpp:91`）为 6 个 signature polymorphic intrinsic 生成解释器入口 stub。这些 stub 是"插入点"——无论从解释器还是 JIT 编译代码进入，都必须经过一个 adapter 完成 signature verification 和 LambdaForm 提取。

核心 intrinsics 及其语义：

| Intrinsic | 语义 | 适配器必须做的事 |
|------|------|------|
| `_invokeBasic` | "执行 MethodHandle 的 LambdaForm" | 从 MH 提取 LForm → 签名校验 |
| `_linkToVirtual` | "虚拟分派到 MemberName 指向的目标" | 从 MN 提取 vmtarget → 通过 vtable 查 → jmp |
| `_linkToStatic` | "静态分派到指定方法" | 直接 jmp 到 MN.vmtarget |
| `_linkToSpecial` | "调用父类的指定方法" | invokespecial 语义——不查 vtable |
| `_linkToInterface` | "接口分派" | itable 查 → jmp |

解释器在到达 invokeExact/invoke 字节码时，不执行正常的 invokevirtual dispatch——而是进入对应的 MethodHandle intrinsic adapter。adapter 用汇编实现（`generate_method_handle_interpreter_entry` + `generate_method_handle_dispatch`）以保证零 C++ 开销。

**第六层：CallSite — invokedynamic 的"链接结果"**

`CallSite` 是 invokedynamic 指令的运行时表示——它持有 MethodHandle target。两个变体：

- `ConstantCallSite`：初始化后不再改变。Lambda 表达式用它——lambda 的目标不变。
- `MutableCallSite`：target 可被 `setTarget()` 改变。动态语言实现用它——方法映射在运行时改变。

`add_dependent_nmethod(call_site, nm)`：当一个 nmethod 内联了 CallSite 的 target MH 时，注册依赖。如果 `CallSite.setTarget()` 被调——`flush_dependent_nmethods(call_site, target)` 将所有依赖 nmethod 标记为 `make_not_entrant`+触发 deoptimization——正在执行这些 nmethod 的线程退回解释器 → 新的 invokedynamic 链接到新 target。

这是 MethodHandles 框架中最"分布式"的设计——CallSite 变→nmethod 失效→deopt→重新链接——涉及的子系统跨越 MethodHandles、CodeCache、Deoptimization、JIT。

## 设计权衡

一、**bootstrap 只调一次 vs 每次重新 resolve**。一次性 bootstrap 的简单性使 invokedynamic 在链接后的性能与普通调用相当。代价是 bootstrap 在链接时调（不是类加载时）——如果 bootstrap 很复杂，invokedynamic 的首次执行有延迟。Lambda 表达式通过 `LambdaMetafactory` 使 bootstrap 非常轻量——几百 ns。

二、**LambdaForm 编译 vs MH 解释**。LambdaForm 可被 C2 编译成 nmethod——接近普通方法调用的性能。但 LambdaForm compilation 有"大小限制"——太复杂的 LForm（如具有分支/循环）不会被 customize，走解释路径。大多数 Lambda/LambdaForm（getter/setter/simple transform）是单指令——在编译后性能与直接方法调用相当。

三、**MutableCallSite 线程安全 vs 性能**。`setTarget()` + `flush_dependent_nmethods()` 保证所有线程最终看到新 target——但这需要 safepoint 同步（所有线程达到安全点才能失效 nmethod）。代价是 CallSite 变更的影响面大——如果有 100 个 nmethod 依赖这个 CallSite，它们全部被失效重编。

## 核心悬念

**invokedynamic 怎么让 JVM 在"编译时不知道该调什么方法"的前提下，运行时的调用性能仍然接近普通的 invokevirtual——通过 bootstrap 惰性链接 + LambdaForm JIT 编译 + adapter 生成——三者协作把"动态"变成了"JIT 后的静态"？**

**→ 卷 05**：ClassFile→Interpreter→VTable→ci→JIT→SharedRuntime→C1→C2→Deoptimization→MethodHandles——完整 vol-04 到此结束。vol-04 是"代码怎么在 JVM 中执行"的全部故事。卷 05 的主角是"可观测性"——当线上代码在运行时，jstack/jmap/jstat/JFR 怎么看到它的内部状态？JVMTI 篇见。

## 预估

1 篇，6 层递进 + 3 个设计权衡 + 卷边界桥（vol-04→vol-05），预估 2500-3500 行。
