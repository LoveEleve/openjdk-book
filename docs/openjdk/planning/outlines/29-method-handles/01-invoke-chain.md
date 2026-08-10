# 01. invokeExact 怎么做到 50x faster than reflection？— MH invoke 链路

> 🔴 Deep | 1 KP 中的核心调用
> 读者处境: `MethodHandle mh = lookup.findVirtual(Foo.class, "bar", ...)` → `mh.invokeExact(obj, arg)`。这是 JVM 最快的方法调用方式——不经过 JNI、不经过反射——直接走 LambdaForm→JIT 编译。

### 1. "MH→LambdaForm→nmethod" 调用链

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

> → [02-x86-adapter.md](02-x86-adapter.md)
