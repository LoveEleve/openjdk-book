# 03. Method.invoke() 在 JVM 里怎么实现？— Reflection + StackWalk

> 🟡 Working | 2 KP 中的反射实现
> 读者处境: `Method m = Foo.class.getDeclaredMethod("bar"); m.invoke(obj, args)`——反射调用在 JVM 中的实现经过 getCallerClass 权限检查→JavaCalls invoke→结果 unboxing。

> ⚠️ 写作期修正(2026-08-14, vol-02/30-jvm-entry/03 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **"reflection.cpp:100-400" 目录错**: reflection.cpp/reflectionUtils.cpp 在 **share/runtime/**(非 prims/);invoke_method :1257-1280,共享 invoke :1072-1255,invoke_constructor :1282
> - **"Reflection::field_get → obj_field_acquire" JDK8 旧版**: JDK11 反射字段访问走 Unsafe(Java 侧 Field.java),reflection.cpp 无 field_get
> - **"getCallerClass 用 vframeStream 前两个 frame" 半对**: JVM_GetCallerClass(jvm.cpp:706-742)用 **security_next()** 跳过 is_ignored_by_security_stack_walk 三类内部帧(method.cpp:1268-1276: Method.invoke intrinsic/MethodAccessorImpl 子类/MH 适配帧);规则=frame0 必须 _getCallerClass intrinsic(:729-733)/frame0-1 必须 @CallerSensitive(:736-739)/首个非 ignored 帧的 holder(:740-742);@CallerSensitive 解析时收集(classFileParser.cpp:2172-2185)
> - **"StackWalk filter 反射帧" 错(重要)**: 反射帧过滤在 **Java 侧**(StackStreamFactory.java:249-268 skipReflectionFrames/isReflectionFrame 按类判断)——实证 -Xlog:stackwalk=debug 显示 hotspot 把 invoke0/invoke/Delegating/Method.invoke 全 fill 进数组;hotspot 只过滤 **@LambdaForm.Hidden 帧**(is_hidden,stackwalk.cpp:123-137;注解收集 classFileParser.cpp:2180)
> - **缺机制(重要)**: ①Method 镜像定位=clazz+**slot 编号**(method_with_idnum)+override+ptypes/rtype;②invoke 五段: 方法解析(静态/私有/<init>/接口 resolve_interface_call/vtable)/参数个数/拆箱 unbox_for_primitive+widen+push/JavaCalls::call(:1233)/InvocationTargetException 包装(:1234-1249)+narrow+box(:1251-1254);③**override 标志 C++ 侧不用**(传给 invoke 但闲置,访问检查在 Java 侧);④分页: JVM_CallStackWalk(:552)→StackWalk::walk(:332)→fetchFirstBatch(跳 StackWalker 自身帧 :378-384)→fill_in_frames(:108-145);JVM_MoreStackWalk(:580)→fetchNextBatch;batchSize 默认 6(实证);⑤反射帧链(实证): Method.invoke→Delegating→NativeMethodAccessorImpl→invoke0
> - **悬念指向 31(已完结)错**: 正确=**32-jfr**(第 5 批)
> - **实证**: 30-reflection-stackwalk-demo.txt(SHOW_HIDDEN_FRAMES 反射链 6 帧;stackwalk 日志证明 hotspot 不过滤反射帧)

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
