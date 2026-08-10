# 02. C++ 怎么调用 Java 方法？— JavaCalls + NativeLookup

> 🔴 Deep | 2 KP 中的 C++→Java 调用桥
> 读者处境: GC worker 需要从 C++ 调 `Reference.enqueue()`(Java 方法)。JavaCalls 提供线程安全的 C++→Java 调用。

### 1. "JavaCalls — 三步调用"

场景: C++ 代码 call Java method——需要用 JavaCallArguments 打包参数→JavaCallWrapper 设 thread state→invoke。

**JavaCalls** (`javaCalls.hpp:50-150 + javaCalls.cpp:40-200`):
```cpp
void JavaCalls::call_static(JavaValue* result, Klass* klass,
    Symbol* name, Symbol* sig, JavaCallArguments* args, TRAPS) {
  JavaCallWrapper wrapper(method, HANDLE);
  // wrapper handles: ThreadInVMfromJava state transition
  // call method via interpreter or compiled entry
  method->invoke(result, args, THREAD);
}
```
- 源码: `javaCalls.hpp:50-150` + `javaCalls.cpp:40-200`
- 关键设计: JavaCallWrapper 是线程安全的关键——构造时 `ThreadInVMfromJava` 状态切换(Java→VM→Java)。C++ call Java 时必须回到 `_thread_in_Java` 状态——GC 才知道这个线程在 Java 代码中
- [C++: call_static + call_virtual + call_special + call_dynamic 四种调用模式对应 Java 的 invokestatic/invokevirtual/invokespecial/invokedynamic。每种通过 `method->invoke()` 走解释器或编译入口。参数传递通过 `JavaCallArguments` 封装的 oop 数组]

### 2. "NativeLookup — native 方法在哪里"

场景: Java 方法声明 `native void foo()`——JVM 去哪找 C 函数实现？

**NativeLookup** (`nativeLookup.hpp:40-100 + nativeLookup.cpp:50-250`):
```
NativeLookup::lookup(method, ...):
  1. Check JNI RegisterNatives table(agent registered)
  2. Check JNI_OnLoad registered methods
  3. Generate default JNI name(JNI_OnLoad style)
  4. Look up via dlsym(RTLD_DEFAULT, generated_name)
```
- 源码: `nativeLookup.cpp:50-250` lookup + `nativeLookup.hpp:40-100`
- 关键设计: JNI 函数名生成为 `Java_{package}_{class}_{method}` 格式。例如 `java.lang.Object.hashCode()`→`Java_java_lang_Object_hashCode`。如果 RegisterNatives 已注册→跳过 dlsym lookup(更快)

---

### 核心悬念

**"JavaCalls 用 JavaCallWrapper+state transition 实现 C++→Java 安全调用。NativeLookup 用 RegisterNatives 表→dlsym 查找 native 函数。"** — 下一篇: Reflection + StackWalk。

> → [03-reflection-stackwalk.md](03-reflection-stackwalk.md)
