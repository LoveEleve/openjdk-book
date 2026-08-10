# MethodHandles 第一遍产出：invokedynamic 的引擎

> vol-04 · 域 31 · 🔴 A | Pass 1 扫描完成
> 源码：`prims/methodHandles.*` 1827行 + `classfile/javaClasses.*` MethodHandle相关类

## 核心架构

```
Java代码: Lambda → invokedynamic → bootstrap → CallSite
  │
  ▼
┌─────────────────────────────────────────────────────────────┐
│                   MethodHandles (AllStatic)                   │
│            (methodHandles.hpp:43, prims/ 根级支持)            │
│                                                              │
│  MemberName: JVM内部的方法/字段指针                            │
│  ┌──────────────────────────────────────────────────┐       │
│  │ resolve_MemberName(mname, caller, ...) → 填vmtarget│       │
│  │  vmtarget = Method* (指向具体实现)                  │       │
│  │  vmindex  = vtable index / field offset           │       │
│  └──────────────────────────────────────────────────┘       │
│                                                              │
│  Adapter Generation: LambdaForm → 字节码 → JIT编译            │
│  ┌──────────────────────────────────────────────────┐       │
│  │ generate_adapters() →MethodHandlesAdapterBlob    │       │
│  │  invokeBasic / linkToVirtual / linkToStatic等     │       │
│  │  每个 intrinsic 生成一个解释器入口 + 编译入口         │       │
│  │  "签名多态": 同一个 invokeBasic 接受任意参数签名     │       │
│  └──────────────────────────────────────────────────┘       │
│                                                              │
│  LambdaForm + MethodHandle 调用链:                            │
│  ┌──────────────────────────────────────────────────┐       │
│  │ MH.invokeExact(args)                               │       │
│  │   → MethodHandle.invokeBasic(Lform, args)          │       │
│  │     → LambdaForm 编译 (C2/C1 JIT)                  │       │
│  │       → 生成指定签名的 native adapter               │       │
│  │         → 执行实际方法 (vmtarget)                   │       │
│  └──────────────────────────────────────────────────┘       │
└─────────────────────────────────────────────────────────────┘
  │
  ▼
JIT 编译后的 LambdaForm 变成 nmethod → CodeCache
  下次调用直接进 JIT 版本, 跳过 LambdaForm 解释
```

## 基本元素分解

1. **MethodHandles** — `AllStatic` JVM 层面的 MethodHandle 支持。核心职责：MemberName 解析、adapter 生成、签名多态支持。持有 `_adapter_code` (MethodHandlesAdapterBlob) 缓存生成的 adapter 代码。`methodHandles.hpp:43`

2. **MemberName** — JVM 对 Java 方法/字段引用的内部表示（`java_lang_invoke_MemberName`）。`resolve_MemberName()` 从 Java 层的 MemberName 对象（name+type+class）解析出实际的 `vmtarget`（Method* 指针）+ `vmindex`（vtable 索引或字段偏移）。这是 invokedynamic 的"名字→实际目标"的解析层——类似 linkResolver 但对 MethodHandle 语义正确。`methodHandles.hpp:64`

3. **LambdaForm** — MethodHandle 的行为描述对象。Java (`java.lang.invoke.LambdaForm`)，一个 LambdaForm 由 Name[] 数组组成，每个 Name 是一个函数调用（参数+函数+结果）。LambdaForm 可通过 JIT 编译成高效的 nmethod——这是 MethodHandles 能接近直接调用的性能的关键。C2 的 `PhaseMacroExpand` 中有专门的 LambdaForm 处理逻辑。

4. **签名多态**（signature polymorphism） — MethodHandle.invokeExact() 和 invoke() 不遵循 Java 的类型检查规则——它们接受任意参数签名，由 JVM 检查是否与 MethodHandle 的 type 匹配。`is_signature_polymorphic()` / `is_signature_polymorphic_intrinsic()` 判断一个 intrinsic 是否是签名多态的。`methodHandles.hpp:97-111`

5. **invokeBasic / linkToVirtual / linkToStatic 等 intrinsics** — 12 个 MethodHandle 专用的 JVM intrinsic：`_invokeBasic`（LForm 入口）、`_linkToVirtual`（虚分派）、`_linkToStatic`（静态分派）、`_linkToSpecial`（直接父类调用）、`_linkToInterface`（接口分派）。每个 intrinsic 在 `MethodHandlesAdapterGenerator::generate()` 中生成一个解释器入口 stub。`methodHandles.cpp:91`

6. **MethodHandlesAdapterGenerator** — 生成 MethodHandle adapter 桩代码。继承 `StubCodeGenerator`，`generate()` 为每个 signature polymorphic intrinsic 生成一个拦截 stub——这些 stub 在解释器或编译代码调用 MH.invokeExact 时被触发，执行：签名校验→提取 MemberName 中的 vmtarget→调用目标方法。`methodHandles.hpp:210`

7. **CallSite** — invokedynamic 的调用点包装。`ConstantCallSite`（不可变，链接后不再改变）和 `MutableCallSite`（可变，`syncAll()` 让所有线程看到新目标）。`add_dependent_nmethod()` / `flush_dependent_nmethods()` 管理 CallSite 的依赖——当 CallSite target 改变时，所有依赖的 nmethod 被标记失效（需要重新链接）。`methodHandles.hpp:80-83`

8. **bootstrap method** — 每个 invokedynamic 指令对应一个 bootstrap 方法，在首次执行时调用，返回一个 CallSite。bootstrap 的结果被缓存——后续同一 invokedynamic 直接使用缓存的 CallSite，不再调用 bootstrap。这是 invokedynamic 的"惰性链接"机制——与 vtable resolution 的"主动链接"不同。

## 标记问题（≥5）

1. **[设计决策] 为什么 invokedynamic 需要 bootstrap 方法而不是直接指定目标？** — 目标在编译时未知，由运行时的语言环境决定（Lambda 的目标是合成方法、Groovy 的目标是动态查找）。bootstrap 方法是一段"目标选择逻辑"——它可以用任何方式创建 CallSite。

2. **[内联路径] LambdaForm 怎么从 MethodHandle.invokeExact 到 JIT 编译的 nmethod？** — 调用链 MH.invokeExact → MethodHandle.invokeBasic(LForm) → LambdaForm 被 JIT 编译 → 编译后的 LambdaForm 直接调用 vmtarget。第一次调用走解释器→编译后走 JIT 版本。

3. **[适配器生成] MethodHandlesAdapterGenerator 生成了什么代码？** — 12 个 intrinsic 每个在解释器入口需要什么？编译入口又需要什么？"签名多态"意味着同一个 invokeBasic 必须接受 `(II)I`、`(Ljava/lang/Object;)V`、`(DLjava/lang/String;)J` 等多种签名——adapter 怎么处理这种多态？

4. **[JIT 集成] C2 怎么优化 MethodHandle 调用？** — PhaseMacroExpand 中有专门的 MethodHandle 内联逻辑——如果 LambdaForm 足够简单（单指令），C2 可以直接内联跳过 LambdaForm→目标方法的 adapter 层。这叫"LambdaForm customization"。

5. **[跨域] invokedynamic class loading 与类加载器的交互** — bootstrap 方法的参数类型表在运行时常量池的 `CONSTANT_InvokeDynamic` 中。如果参数类型引用了未加载的类——解析会触发类加载，类加载期间 bootstrap 调用被阻塞？

6. **[并发安全] MutableCallSite 的线程安全** — `MutableCallSite.setTarget()` 改变目标后，`syncAll()` 必须让所有线程看到新目标。这怎么与 NMETHOD 失效配合？其他线程在执行旧 lambdaForm→旧 target 的过程中如果 CallSite 被修改——会发生什么？
