# 03. Method.invoke() 在 JVM 里怎么实现？— Reflection + StackWalk

> 🟡 Working | 2 KP 中的反射实现
> 读者处境: `Method m = Foo.class.getDeclaredMethod("bar"); m.invoke(obj, args)`——反射调用在 JVM 中的实现经过 getCallerClass 权限检查→JavaCalls invoke→结果 unboxing。

### 1. "Reflection.invoke — 反射调用"

场景: `Method.invoke(obj, args)` → Java 层调 `NativeMethodAccessorImpl.invoke0` → JVM `JVM_InvokeMethod`。

**Reflection 实现** (`reflection.cpp:100-400 + reflectionUtils.cpp:40-200`):
```
Method.invoke():
  1. JVM_GetCallerClass() → check access(public/private)
  2. pack arguments(Object[] → JavaCallArguments)
  3. JavaCalls::call_virtual(method, args)
  4. unbox return value(Object → primitives)
```
- 源码: `reflection.cpp:100-400` invoke + `reflectionUtils.cpp:40-200` argument conversion
- 关键设计: getCallerClass 用 vframeStream(域24)前两个 frame→找到调用者类→权限检查。invoke 本身只是 JavaCalls 的包装——反射的真正开销在 argument packing/unpacking 和 access check, 不在 invocation
- [C++: `Unsafe_GetObjectVolatile` 等 Unsafe 方法被 reflection Field.get 调用——`Reflection::field_get` → `oopDesc::obj_field_acquire` → 直接读 field without access check]

### 2. "StackWalk — JVM_GetStackTrace 实现"

场景: `Thread.currentThread().getStackTrace()` → JVM_GetStackTrace → vframeStream fill → StackTraceElement[]。

**StackWalk** (`stackwalk.cpp:40-200):
```
JVM_GetStackTrace(thread, depth):
  vframeStream vfs(thread)         // 从当前帧遍历栈
  while (!vfs.at_end() && depth > 0):
    → StackFrameInfo(bci, method_name, class_name, file_name, line_number)
    → add_to_array(result)
    → vfs.next()
  → return result
```
- 源码: `stackwalk.cpp:40-200` + `vframeStream(域24)`
- 关键设计: filter 反射帧(Method.invoke/Constructor.newInstance)→只显示业务栈。JVM_GetCallerClass 也用同机制——但只返回调用的第二帧(跳过反射层)

---

### 核心悬念

**"Reflection durch JavaCalls + getCallerClass权限检查实现。StackWalk用vframeStream遍历栈→过滤反射帧。"** — 下一篇: 域31 Unsafe & WhiteBox。

> → 域31 Unsafe & WhiteBox
