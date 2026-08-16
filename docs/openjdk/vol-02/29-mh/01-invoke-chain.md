# 01. invokeExact 怎么做到 50x faster than reflection？— MH invoke 链路

> **前置依赖**:[28-jvmti/03 — 为每个对象打 tag — TagMap + 事件分派细节](openjdk/vol-02/28-jvmti/03-auxiliary.md):ResolvedMethodName/ResolvedMethodTable(方法句柄↔Method* 的登记表)已讲;[08-interpreter/04 — 符号引用怎么变成直接引用？— LinkResolver + Rewriter](openjdk/vol-02/08-interpreter/04-linkresolver-rewriter.md):方法解析/虚分派的先例;[15-c2/02 — Parse + GraphKit — 字节码→Ideal Graph](openjdk/vol-02/15-c2-compiler/02-c2-parse-graphkit.md):内联决策链(doCall.cpp 的 MH 分支)已讲;[13-jit-framework/01 — 谁决定编译、怎么排队、谁执行？— CompileBroker 编译队列](openjdk/vol-02/13-jit-framework/01-compile-broker-queue.md):编译产物如何进入 CodeCache
> → **后续**:[02-x86-adapter — ricochet frame 怎么传参数？— x86 Adapter Stubs](02-x86-adapter.md)
> 关联域: 28-jvmti(ResolvedMethodName 桥)、08-interpreter(解析)、15-c2(内联)、16-code-cache(nmethod)

## 先纠正标题: 50x 是历史说法

"invokeExact 比反射快 50 倍"是 JDK 7/8 时代的宣传口径——JDK 11 上反射自己也进化了(MethodAccessor 代码生成、消除大量检查),[实证](materials/commands/29-mh-invoke-demo.txt)(素材 A)的 2000 万次调用对照是: **直接调用 9ms / invokeExact(参数) 52ms / invokeExact(常量) 10ms / 反射 218ms**——invokeExact 比反射快 **~4-5 倍**,而**常量 MH 与直接调用几乎持平(1.11 倍)**。所以标题的问题应该这么答: 方法句柄的价值不是"比反射快多少",而是**让方法调用在编译期可达**——当 MethodHandle 是编译期常量时,C2 能把它折叠成一条直接调用,与 `foo.add(i)` 无异。本篇拆这条"可达"之路: 签名多态(§1)、两条调用路径(§2)、链接器汇编分派(§3)、LambdaForm(§4)、实证(§5)。

## 1. 签名多态 — invokeExact 为什么能在调用点"变型"

`MethodHandle.invokeExact` 的声明(MethodHandle.java:489):

```java
// MethodHandle.java:489-489(截取核心,逐字)
    public final native @PolymorphicSignature Object invokeExact(Object... args) throws Throwable;
```

`@PolymorphicSignature`(签名多态)是 JVMS 定义的特殊方法: **调用点的描述符就是实际签名**——`mh.invokeExact(foo, i)` 编译成描述符 `(LFoo;I)I` 的调用,而不是 `(Object...)Object`。这带来两个后果: ①**无装箱**——int 参数在字节码层面就是 int,javac 不为它生成 `Integer.valueOf`;②**调用点有精确类型**——C2 可以基于真实签名做优化。

JVM 侧把签名多态方法登记为 intrinsic。共 6 个(vmSymbols.hpp:1435-1441),按固定顺序: `_invokeGeneric`(MethodHandle.invoke)/`_invokeBasic`/`_linkToVirtual`/`_linkToStatic`/`_linkToSpecial`/`_linkToInterface`(FIRST_MH_SIG_POLY=invokeGeneric,LAST=linkToInterface,:1583-1585)。`invokeBasic` 是半内部入口(MethodHandle.java:547,`final native @PolymorphicSignature`,调用点签名限制为基本类型)——invokeExact 做完类型校验后转给它。

*关键设计: "调用点签名=真实签名"是 MH 性能的源头。反射的 `Method.invoke` 固定 `(Object...)Object`——参数必须装箱、返回值必须拆箱、每次调用做类型转换;签名多态让这些在编译期全部消失。*

## 2. 两条调用路径 — 编译期折叠 vs 运行时链接

C2 编译调用 `mh.invokeExact(...)` 的调用点时,走 `doCall` 的 MH 分支(doCall.cpp:141-152,注释 "MethodHandle.invoke* are native methods which obviously don't have bytecodes")→ `CallGenerator::for_method_handle_call`(callGenerator.cpp:799-822)→ `for_method_handle_inline`(:824-957)。**成败取决于一个条件: 接收者(或 MemberName)是不是编译期常量**:

```
for_method_handle_inline(callGenerator.cpp:824-957):
  _invokeBasic(:831): MH 接收者是 Op_ConP 常量?
    → 是: 取 get_vmtarget(常量 MH 的目标方法)→ call_generator 递归内联
           (receiver 常量即"编译期可达"——直接内联目标,与直接调用等价)
    → 否: "receiver not constant" → 返回 NULL
  _linkTo*(:868): 尾部 MemberName 参数是常量?
    → 是: get_vmtarget + 签名一致性检查(is_consistent_info)
           + receiver/参数 CheckCastPP 转型(注释 "In lambda forms we erase signature
             types...we must cast the receiver and arguments to its actual types" :886-889)
           + optimize_virtual_call(虚调用优化 :932) + 递归内联(:940)
    → 否: "member_name not constant" → 返回 NULL
  内联失败 → for_mh_late_inline(延迟内联)或 for_direct_call(链接器调用)
```

**常量折叠成功 → 内联目标方法,与直接调用无差别**(实证 1.11 倍);失败 → **链接器路径**(§3),靠运行时分派。这就是"快"与"不快"的分水岭——而 LambdaForm(§4)的存在,是为了把"非直接方法句柄"(bind/组合/类型转换等)也拆成一串可内联的小方法,让折叠尽量成功。

## 3. 链接器路径 — 解释器入口与汇编分派

非常量 MH 的调用怎么落地?启动时(init.cpp:145 的 init_globals 序列)`MethodHandles::generate_adapters`(methodHandles.cpp:75-90)生成 **MethodHandlesAdapterBlob**(独立 CodeBlob),为签名多态 intrinsic 生成**解释器入口**(`generate()` 循环 method_handle_invoke_FIRST..LAST;`generate_method_handle_interpreter_entry` 在 methodHandles_x86.cpp:203-290;其中 `_invokeGeneric`/`_compiledLambdaForm` 返回 NULL 不生成——它们经由 Java 侧 `MethodHandleNatives.linkMethod` 链接,:207-214)。

入口的核心是 `generate_method_handle_dispatch`(:292-489),按 intrinsic 分派:

```
invokeBasic(:327-329):   "indirect through MH.form.vmentry.vmtarget"
  → jump_to_lambda_form(:157-198): 三层字段链取 Method*
      MH → MH.form → LF.vmentry → MemberName.method → ResolvedMethodName.vmtarget → Method*
      (java_lang_invoke_MethodHandle::form_offset → LambdaForm::vmentry_offset
       → MemberName::method_offset → ResolvedMethodName::vmtarget_offset,javaClasses.hpp:1022/:1077/:1183/:1098)
linkToSpecial/Static(:390-404): MemberName.vmtarget(ResolvedMethodName)→ vmtarget(Method*)
linkToVirtual(:406-432):  MemberName.vmindex(vtable index)→ lookup_virtual_method(recv klass, index)
      ——注释 "same as TemplateTable::invokevirtual, minus the CP setup and profiling"
linkToInterface(:435-466): MemberName.clazz+vmindex → lookup_interface_method(itable)
  之后统一 jump_from_method_handle(:482)跳到 Method* 的 from_interpreted/from_compiled 入口
```

*关键设计: 链接器是"手写汇编的 invoke* 模板"。linkToVirtual 的注释点破本质——它做的正是 invokevirtual 字节码该做的事(接收者类型→vtable 槽),只是省掉了常量池解析与画像;invokeBasic 则直接穿透 MH 内部结构(三层 oop 字段)拿到目标 Method*。这是"两步指针跳"的落点: MemberName→ResolvedMethodName→Method*(两次 oop 字段读取),没有哈希表查找。*

## 4. LambdaForm — Java 侧生成的小方法

大纲说 "LambdaForm(字节码管道的适配器)"——真实的 LambdaForm(LambdaForm.java:123)是 **Java 侧生成的小方法**(字节码),每个 MethodHandle 的调用形态都对应一个 LF:

```java
// LambdaForm.java:123-130(截取核心,逐字)
class LambdaForm {
    final int arity;
    final int result;
    final boolean forceInline;
    final MethodHandle customized;
    @Stable final Name[] names;
    final Kind kind;
    MemberName vmentry;   // low-level behavior, or null if not yet prepared
```

`vmentry`(注释 "low-level behavior, or null if not yet prepared")就是 §3 链接器取的那个 MemberName——**懒准备**: `prepare()`(LambdaForm.java:827-843)在 `COMPILE_THRESHOLD == 0`(**默认 0**,MethodHandleStatics.java:71-72 的系统属性 `java.lang.invoke.MethodHandle.COMPILE_THRESHOLD`)时先 `compileToBytecode()`——用 `InvokerBytecodeGenerator.generateCustomizedCode` 生成定制字节码(:857-878,`vmentry = InvokerBytecodeGenerator.generateCustomizedCode(this, invokerType)`);其余情况退回 `generateLambdaFormInterpreterEntryPoint`(:840,解释器入口)。**LF 编译产物是普通 Java 方法**(基本类型签名)——由 `UNSAFE.defineAnonymousClass` 定义为**匿名类**里的静态方法(InvokerBytecodeGenerator.java:299-302;PrintInlining 里的 `Invokers$Holder` 就是这类匿名类),进入 CodeCache 后就能被 C2 当作普通方法内联。这就是"MH 调用 = 一串可内联小方法"的构造: 直接方法句柄的 LF 极小(invokeBasic 直达),组合方法句柄的 LF 是生成的字节码序列。

*关键设计: LambdaForm 把"调用形态"物化成字节码。组合 MH(filter/bind/转换类型)的 LF 由 LambdaFormEditor 编辑而来,再经 InvokerBytecodeGenerator 生成成一个小方法,方法体直接内联——于是复杂 MH 的性能损失只剩"生成字节码的常量性"问题。这与 28-01 的事件系统"把结论烫成标志"是同一思路: 运行时决策尽量前移到编译期/生成期。*

## 5. 实证: 折叠成功与失败的对照

[实证](materials/commands/29-mh-invoke-demo.txt): `MhDemo` 三种调用 2000 万次(素材 A):

| 调用方式 | 耗时 | vs 直接调用 |
|---|---|---|
| `foo.add(i)` 直接 | 9ms | 1.0 |
| `CONST_MH.invokeExact(foo, i)`(static final 常量) | 10ms | **1.11** |
| `mh.invokeExact(foo, i)`(方法参数) | 52ms | 5.78 |
| `Method.invoke(foo, i)` 反射 | 218ms | 24.2(且为 invokeExact 参数的 4.19 倍) |

PrintInlining 树(素材 B/C)印证: ①invokeExactCall 树里 `Invokers$Holder::invokeExact_MT (24 bytes) force inline by annotation`(Invokers 生成的带类型检查调用器,@ForceInline 强制内联)+ `checkExactType/checkCustomized`(类型/定制化检查,均 force inline)+ **`MethodHandle::invokeBasic(LI)I (0 bytes) receiver not constant`**(callGenerator.cpp:861-863 的失败打印——接收者非常量,走链接器);②反射树则是 `acquireMethodAccessor`(不内联)+ `MethodAccessorImpl::invoke no static binding` + `Integer::valueOf`(参数**装箱**)/`Integer::intValue`(返回值拆箱)——反射每次调用都在做 MH 编译期就做完的事。

## 核心悬念

invokeExact 的"快"拆完了: **签名多态**(调用点=真实签名,无装箱)、**两条路径**(C2 常量折叠=直接内联目标,1.11 倍;链接器=手写汇编分派,比反射仍快 4 倍)、**LambdaForm**(把调用形态物化成可内联小方法)、**MemberName→ResolvedMethodName→Method\* 两步指针跳**(28-03 的登记表在此登场)。——但有个细节没展开: 链接器的 `jump_from_method_handle` 跳到目标入口后,**参数怎么摆**?链接器路径上调用点的参数布局(解释器槽/寄存器)与目标方法的期望(c_rarg0-5/XMM/栈)不一致——谁来调?下一篇: x86 adapter stubs。

> → [02-x86-adapter — 方法句柄的调用约定怎么适配?— x86 adapter stubs](02-x86-adapter.md)
