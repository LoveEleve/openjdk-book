# 01. invokeExact 怎么做到 50x faster than reflection？— MH invoke 链路

> 🔴 Deep | 1 KP 中的核心调用
> 读者处境: `MethodHandle mh = lookup.findVirtual(Foo.class, "bar", ...)` → `mh.invokeExact(obj, arg)`。这是 JVM 最快的方法调用方式——不经过 JNI、不经过反射——直接走 LambdaForm→JIT 编译。

### 1. "MH→LambdaForm→nmethod" 调用链
> ⚠️ 写作期修正(2026-08-16, vol-02/29-mh/01 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **"methodHandles.cpp:200-600" 行号漂移**: 文件 1610 行;核心: generate_adapters :75-90(启动 init.cpp:145 生成 MethodHandlesAdapterBlob)/init_MemberName :172/init_method_MemberName :219/resolve_MemberName :712;hpp 217 行无 LambdaForm 类(Java 侧 LambdaForm.java:123)
> - **"vmentry(平台 stub: argument shuffle)" 错(重要)**: vmentry 是 **MemberName**(LambdaForm.java:130 "low-level behavior, or null if not yet prepared");链接器路径 jump_to_lambda_form(methodHandles_x86.cpp:157-198)取链=MH→MH.form→LF.vmentry→MemberName.method→**ResolvedMethodName.vmtarget**→Method*(28-03 的登记表在此)
> - **漏 C2 常量折叠机制(核心,重要)**: doCall.cpp:141-152 MH 分支→CallGenerator::for_method_handle_call(callGenerator.cpp:799)→for_method_handle_inline(:824-957): **_invokeBasic 接收者是 Op_ConP 常量→get_vmtarget 直接内联目标**(:831-866,"receiver not constant" 失败 :861-863);**_linkTo* 尾部 MemberName 常量→get_vmtarget+签名一致性+CheckCastPP 转型(:886-915 注释 "we must cast the receiver and arguments to its actual types")+optimize_virtual_call(:932)+递归内联(:940)**;失败→for_mh_late_inline/for_direct_call
> - **"MemberName: method/vtable_index" 半对**: 真实=java_lang_invoke_MemberName 的 **vmtarget(ResolvedMethodName oop 引用)/vmindex(vtable index 或 offset)**(MemberName.java:74/:84 @Injected;javaClasses.hpp:1183/:1184)
> - **"50x faster than reflection" 是历史说法(实证)**: JDK11 实测 2000 万次: 直接 9ms/invokeExact(参数)52ms/invokeExact(**常量**)10ms/反射 218ms——invokeExact 比反射快 ~4-5 倍;常量 MH 与直接调用 1.11 倍
> - **签名多态**: 6 个 intrinsic(vmSymbols.hpp:1435-1441: _invokeGeneric/_invokeBasic/_linkToVirtual/_linkToStatic/_linkToSpecial/_linkToInterface,FIRST/LAST :1583-1585);MethodHandle.java:489 invokeExact @PolymorphicSignature native/:547 invokeBasic;解释器 method_handle_invoke_FIRST..LAST(abstractInterpreter.hpp:67-68)+invokehandle 模板(templateTable_x86.cpp:3939)
> - **链接器分派**: generate_method_handle_interpreter_entry(methodHandles_x86.cpp:203-290,_invokeGeneric/_compiledLambdaForm 返回 NULL :207-214)→generate_method_handle_dispatch(:292-489): invokeBasic→jump_to_lambda_form/linkToSpecial-Static→vmtarget/linkToVirtual→vmindex+lookup_virtual_method("same as TemplateTable::invokevirtual" :408-409)/linkToInterface→itable→jump_from_method_handle(:482)
> - **LambdaForm**: prepare()(:827-843,COMPILE_THRESHOLD 默认 0 MethodHandleStatics.java:71-72→compileToBytecode :857-878→InvokerBytecodeGenerator.generateCustomizedCode :688;解释器入口 generateLambdaFormInterpreterEntryPoint :840);编译产物=普通 Java 方法(基本类型签名)可被 C2 内联
> - **实证**: 29-mh-invoke-demo.txt(性能对照+PrintInlining: Invokers$Holder::invokeExact_MT force inline/checkExactType/checkCustomized/invokeBasic receiver not constant/反射 acquireMethodAccessor+装箱)

场景: invokeExact 的调用——Java code 调用 MH→JVM 通过 LambdaForm(内部表示的字节码适配器)→JIT 编译成 nmethod。

**invoke 链路** (`methodHandles.cpp:200-600 + methodHandles.hpp:40-150`):
```
Java code: mh.invokeExact(args)
  → MethodHandle::invokeBasic(args) 
    → MethodHandle::vmentry(平台 stub: argument shuffle)
      → LambdaForm (字节码管道的适配器)
        → MemberName (指向实际 target method)
          → target method (C2 compiled/interpreted)
```
- 源码: `methodHandles.cpp:200-600` invoke flow + `methodHandles.hpp:40-150` LambdaForm
- 关键设计: 为什么快？(1) 无反射(no Field.setAccessible/no Method.getName 查表)——MH 内部用 MemberName(类似 Method*)直连 target。(2) 无装箱(Object[] args)——参数通过 ricochet frame 传递, 类型在编译期确定。(3) C2 完全优化——LambdaForm 被 JIT 完全 inline+删除不用的 adapter→生成的代码与直接调用无差别
- [C++: LambdaForm 本质上是一小段特殊字节码——MethodHandle 编译器解析它→转成 C2 IR→optimize away dead adaptors→compile to machine code。编译后 invokeExact 就是一条直接 call 指令]

### 2. "MemberName — 内部方法指针"
> ⚠️ 写作期修正(2026-08-16, vol-02/29-mh/01 已按真实源码成文):
> - **"从 MethodHandle→MemberName→Method* 是两步指针跳" 对但落点错**: 真实=MemberName.vmtarget 是 **ResolvedMethodName oop**,再经 vmtarget 取 Method*(28-03 的 find_resolved_method 登记链)——"两步"实为三跳,且链接器路径是汇编直读字段(方法句柄的 vmtarget 在 jump_to_lambda_form 里甚至不经 MemberName 而经 LF.vmentry)
> - **"反射 O(N) vs MH O(1)" 简化**: 建句柄/拿 Method 都是一次性解析;调用时反射也 O(1)(MethodAccessor 缓存)——真正的差异在**调用点**(装箱/访问检查/虚分派 vs 编译期折叠),实证 4-5 倍非 50 倍
> - MemberName 初始化: init_MemberName(methodHandles.cpp:172)/init_method_MemberName(:219 CallInfo→vmtarget/vmindex)/init_field_MemberName(:333)

**MemberName** (`methodHandles.hpp:80-150`):
```
MemberName: 类似 JNI methodID 但更快
  - method: pointer to Method*
  - vtable_index: 虚方法索引
  - 从 MethodHandle→MemberName→Method* 是两步指针跳(无 hashtable 查找)
```
- 源码: `methodHandles.hpp:80-150` MemberName 定义 + `methodHandles.cpp:300-500` resolve
- 关键设计: 反射用 `getDeclaredMethod("bar", int.class)` → 遍历方法表→比较名字→找 Method。MH 用 lookup→直接拿 MemberName→存 pointer→去查表。两步 O(1) vs O(N)

---

### 核心悬念

**"MethodHandle invokeExact 走 LambdaForm + MemberName→JIT 直接 inline→生成的 nmethod 与直接方法调用无异——50x faster than reflection。"** — 下一篇: x86 adapter stubs。
> ⚠️ 悬念机制描述已过期(2026-08-16): "50x"是历史说法,JDK11 实证 ~4-5 倍(反射也优化);真正机制=**C2 常量折叠**(接收者/MemberName 常量→直接内联,1.11 倍)vs 链接器分派(非常量,5.78 倍)。正确总结见正文"核心悬念"。

> → [02-x86-adapter.md](02-x86-adapter.md)
