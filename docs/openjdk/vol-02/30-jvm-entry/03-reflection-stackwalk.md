# 03. Method.invoke() 在 JVM 里怎么实现?— Reflection + StackWalk

> **前置依赖**:[30-jvm-entry/02 — C++ 怎么调用 Java 方法?— JavaCalls + NativeLookup](openjdk/vol-02/30-jvm-entry/02-java-calls.md):反射的调用就是 JavaCalls;[30-jvm-entry/01 — System.currentTimeMillis() 怎么进入 JVM?— JVM Entry Points](openjdk/vol-02/30-jvm-entry/01-jvm-entry-points.md):JVM_InvokeMethod 是入口之一;[24-frame/02 — 编译代码内联了 3 层——怎么看到源级方法?— Virtual Frame](openjdk/vol-02/24-frame/02-virtual-frame.md):栈遍历的流;[08-interpreter/04 — 符号引用怎么变成直接引用?— LinkResolver + Rewriter](openjdk/vol-02/08-interpreter/04-linkresolver-rewriter.md):invoke 里的方法解析
> → **后续**:[32-jfr/01 — JFR 怎么在每个线程上采集事件?— Recorder Engine](openjdk/vol-02/32-jfr/01-recorder-engine.md)
> 关联域: 31-unsafe(反射字段访问走 Unsafe)、29-method-handles(invoke 的另一族)、16-code-cache

`Method.invoke(obj, args)` 是 Java 侧最常见的"动态调用"。它的完整链路涉及 Java 侧的 access check 体系、JVM 侧的 `JVM_InvokeMethod`、以及 `Reflection::invoke` 的五段打包。本篇要回答的核心问题:

1. `Method.invoke` 的最后一跳——JVM 侧拿到参数后怎么解析、怎么打包、怎么调 JavaCalls?
2. `JVM_GetCallerClass` 为什么能跳过 `Method.invoke` 的反射帧?
3. StackWalker 的隐藏帧过滤,到底是 hotspot 做还是 Java 侧做?

答案会反复落到一句话:**`Method.invoke` 的最后一跳是 `JVM_InvokeMethod` → `Reflection::invoke_method`(slot 编号定位方法)→ `invoke` 五段(方法解析 → 参数个数 → 拆箱/扩宽/打包 → JavaCalls → InvocationTargetException 包装)。`JVM_GetCallerClass` 用 `security_next` 跳过三类内部帧。StackWalker 隐藏帧**双轨过滤**:hotspot 滤 `@Hidden`(LambdaForm),Java 侧滤反射帧。**

---

## 1. 开场困惑——"Method.invoke 的完整链路"

`Method.invoke(obj, args)` 在 Java 侧的完整链路（用 `StackWalker` 的 `SHOW_HIDDEN_FRAMES` 选项把反射帧全亮出来）:

```
ReflectionDemo.target
jdk.internal.reflect.NativeMethodAccessorImpl.invoke0     ← native 方法
jdk.internal.reflect.NativeMethodAccessorImpl.invoke
jdk.internal.reflect.DelegatingMethodAccessorImpl.invoke
java.lang.reflect.Method.invoke
```

**`Method.invoke`(Java)→ `DelegatingMethodAccessorImpl`(默认委托)→ `NativeMethodAccessorImpl`(native 版本)→ `invoke0`(native)→ JVM_InvokeMethod**。但访问检查不在这里——Java 侧的 `MethodAccessor` 体系与 `Reflection.verifyAccess` 已经完成权限判定并决定是否放行,JVM 侧只负责组装调用。

---

## 2. 两个朴素方案为什么都不对

### 方案一: 每次反射调用都重新解析方法名

如果不通过 slot 编号定位,而是每次反射调用都用名字+签名去查方法表,虽然也能找到方法,但每次都要遍历类的所有方法——反射已经比直接调用慢,加上名字解析更慢。Java 的 Method 镜像在构造时（`Method` 类的构造函数）已经通过名字解析算出了 slot 编号,后面 `invoke` 时直接用 `klass->method_with_idnum(slot)` 定位,不再过名字解析。**slot 是反射调用的"缓存"**。

### 方案二: 反射调用不做访问检查

另一个极端是认为反射调用天然可以绕过访问控制——不对,`setAccessible(true)` 需要显式调用。从 Java 8 开始,`Method.invoke` 默认检查调用者有权限访问目标方法,检查由 Java 侧的 `Reflection.verifyAccess` 完成;JVM 侧的 `JVM_GetCallerClass` 只提供"调用者是谁"的信息,不执行检查本身。

---

## 3. 反射调用——JVM_InvokeMethod → invoke 五段

### JVM_InvokeMethod: 栈空间检查 + 参数解析

`invoke0` 的 JVM 侧入口是 `JVM_InvokeMethod`(jvm.cpp:3571-3593): 先做 **栈空间检查**(`JVMInvokeMethodSlack`,留出反射栈余量),resolve 三个参数(method 镜像/接收者/参数数组),然后进 `Reflection::invoke_method`:

```cpp
// jvm.cpp:3571-3593(截取核心,逐字)
JVM_ENTRY(jobject, JVM_InvokeMethod(JNIEnv *env, jobject method, jobject obj, jobjectArray args0))
  JVMWrapper("JVM_InvokeMethod");
  Handle method_handle;
  if (thread->stack_available((address) &method_handle) >= JVMInvokeMethodSlack) {
    method_handle = Handle(THREAD, JNIHandles::resolve(method));
    Handle receiver(THREAD, JNIHandles::resolve(obj));
    objArrayHandle args(THREAD, objArrayOop(JNIHandles::resolve(args0)));
    oop result = Reflection::invoke_method(method_handle(), receiver, args, CHECK_NULL);
    ...
```

### Reflection::invoke_method: 从 Method 镜像里取出定位信息

`Reflection::invoke_method`(reflection.cpp:1257-1279)从 Method 镜像里取出关键信息:

```cpp
// reflection.cpp:1257-1278(截取核心,逐字)
oop Reflection::invoke_method(oop method_mirror, Handle receiver, objArrayHandle args, TRAPS) {
  oop mirror             = java_lang_reflect_Method::clazz(method_mirror);
  int slot               = java_lang_reflect_Method::slot(method_mirror);
  bool override          = java_lang_reflect_Method::override(method_mirror) != 0;
  objArrayHandle ptypes(THREAD, objArrayOop(java_lang_reflect_Method::parameter_types(method_mirror)));
  ...
  InstanceKlass* klass = InstanceKlass::cast(java_lang_Class::as_Klass(mirror));
  Method* m = klass->method_with_idnum(slot);
```

**Method 镜像里装着定位信息**: 声明类(`clazz`)、**slot 编号**(`method_with_idnum` 直接取,不经名字解析)、`override`(setAccessible 标志)、参数类型与返回类型镜像。

### invoke 五段

两者汇到共享的 `invoke`(reflection.cpp:1072-1252),五段:

1. **方法解析**(:1088-1151): `klass->initialize`;静态直接用;实例方法检查 receiver(空→NPE、`is_a` 不符→"object is not an instance of declaring class");私有/`<init>` 直接用,接口走 `resolve_interface_call`,可覆写方法按 vtable 索引解析;
2. **参数个数检查**(:1175-1178,"wrong number of arguments");
3. **参数打包**(:1180-1225): 基本类型参数 `unbox_for_primitive` 拆箱 → 必要时 `widen` 扩宽(窄→宽,如 int→long)→ `push_int/long/float/double`;对象参数 `is_a` 类型检查 + `push_oop`(Handle)——**全部打进 30-02 的 JavaCallArguments**;
4. **`JavaCalls::call(&result, method, &java_args)`**(:1230)——30-02 的桥。注释(:1227-1228): "All oops (including receiver) is passed in as Handles";
5. **结果与异常**: 方法抛异常 → 清掉并**包装成 `InvocationTargetException`**(:1232-1245,JVMTI 内部标志复位);成功 → 基本类型结果 `narrow`(宽→窄)+ `Reflection::box` 装箱(:1250-1251)。

---

## 4. JVM_GetCallerClass——谁是调用者

`JVM_GetCallerClass`(jvm.cpp:706-742)是"权限检查的前置服务"。注释先画出调用栈布局:

```cpp
// jvm.cpp:708-724(截取核心,逐字)
  // Getting the class of the caller frame.
  //
  // The call stack at this point looks something like this:
  //
  // [0] [ @CallerSensitive public sun.reflect.Reflection.getCallerClass ]
  // [1] [ @CallerSensitive API.method                                   ]
  // [.] [ (skipped intermediate frames)                                 ]
  // [n] [ caller                                                        ]
  vframeStream vfst(thread);
  // Cf. LibraryCallKit::inline_native_Reflection_getCallerClass
  for (int n = 0; !vfst.at_end(); vfst.security_next(), n++) {
```

遍历用 **`security_next()`**——安全栈遍历,跳过"内部帧"。`Method::is_ignored_by_security_stack_walk`(method.cpp:1268-1282)列出三类:

- **`Method.invoke` 本身**(intrinsic `_invoke`);
- **`MethodAccessorImpl` 子类**(反射辅助帧);
- **MethodHandle 内部适配帧**(LambdaForm)。

遍历规则: frame 0 必须是 `_getCallerClass` intrinsic(:729-733,否则 InternalError);frame 0/1 都必须带 `@CallerSensitive`(:736-739);之后**第一个没被忽略的帧**的持有者类就是调用者(:740-742)。`@CallerSensitive` 注解由类文件解析时收集(`MethodAnnotationCollector::apply_to`,classFileParser.cpp:2172-2185)。

---

## 5. StackWalker——分页取帧 + 双轨过滤

`StackWalker.walk` 的 native 面是 `JVM_CallStackWalk`(jvm.cpp:552-578)→ `StackWalk::walk`(stackwalk.cpp:332-360): 按 mode 选流——**`JavaFrameStream`**(默认,内部是 `vframeStream _vfst`,stackwalk.hpp:76-90)或 `LiveFrameStream`(JIT 栈寄存器映射)。`fetchFirstBatch`(:363)先**跳过 StackWalker 自身帧**(`StackWalker_klass`/`AbstractStackWalker_klass`,:378-384),然后 `fill_in_frames`(:108-145)逐帧填充。

**隐藏帧的过滤在两层,分工不同**:

```cpp
// stackwalk.cpp:123-137(截取核心,逐字)
    // skip hidden frames for default StackWalker option (i.e. SHOW_HIDDEN_FRAMES
    // not set) and when StackWalker::getCallerClass is called
    if (!ShowHiddenFrames && (skip_hidden_frames(mode) || get_caller_class(mode))) {
      if (method->is_hidden()) {
        ...
        continue;
      }
    }
```

- **HotSpot 侧**: `skip_hidden_frames(mode)`(stackwalk.hpp:133-135,`SHOW_HIDDEN_FRAMES` 位未置时跳过)**只过滤 `is_hidden()` 的帧**——`@LambdaForm.Hidden` 注解的方法(解析时设置,classFileParser.cpp:2180),即 MethodHandle 的 LambdaForm 内部帧;
- **Java 侧**: 反射帧(NativeMethodAccessorImpl 等)由 `StackStreamFactory.java:249-268`(`skipReflectionFrames`/`isReflectionFrame` 按类判断)过滤——hotspot 把 `invoke0/invoke/DelegatingMethodAccessorImpl/Method.invoke` 全部 fill 进了数组,但默认 Java 输出只剩业务帧。**hotspot 的 `is_hidden` 只管 LambdaForm,反射帧过滤在 Java 侧。**

**分页**: 帧数组用完后 `JVM_MoreStackWalk`(jvm.cpp:580-601)→ `fetchNextBatch` 续取——`StackWalker` 的流式遍历按批消费,批大小自适应: 首批 = `Math.min(Math.max(walker.estimateDepth(), SMALL_BATCH), LARGE_BATCH_SIZE)`,后续批次翻倍直到 32 封顶。`BaseFrameStream` 用 magic 校验跨批次的有效性(stackwalk.cpp:42-88)。

---

## 6. 误解澄清与收网

1. **反射调用是否每次重新解析方法名?** 不是。Method 镜像构造时已算出 slot 编号,`invoke` 时用 `klass->method_with_idnum(slot)` 直接定位,不过名字解析。
2. **访问检查在哪里做?** Java 侧。`Method.setAccessible` 的 override 标志传递到 JVM 侧,但 JVM 侧不据此检查;访问检查由 Java 侧的 `MethodAccessor` 体系与 `Reflection.verifyAccess` 完成。
3. **`JVM_GetCallerClass` 跳过哪三类帧?** `Method.invoke` 本身(intrinsic)、`MethodAccessorImpl` 子类(反射辅助帧)、MethodHandle 内部适配帧(LambdaForm)。
4. **StackWalker 的隐藏帧过滤是 hotspot 做还是 Java 侧做?** 双轨:hotspot 滤 `@Hidden`(LambdaForm),Java 侧滤反射帧。
5. **StackWalker 分页怎么分?** 首批自适应大小,后续翻倍到 32 封顶,`BaseFrameStream` 用 magic 校验跨批次有效。

把这一篇压成三句话:

- **`Method.invoke` 的 JVM 侧是 invoke 五段**:方法解析 → 参数个数 → 拆箱/扩宽/打包 → JavaCalls → InvocationTargetException 包装。
- **`JVM_GetCallerClass` 用 `security_next` 跳过三类内部帧**,交出调用者类。
- **StackWalker 隐藏帧双轨过滤**:hotspot 滤 `@Hidden`(LambdaForm),Java 侧滤反射帧。

反射是"主动查"——还有一套"被动采样"的观测通道: JFR 在每个线程上采集事件,它的采集引擎怎么运转?下一篇: 32 域 JFR Recorder Engine。

> → [32-jfr/01 — JFR 怎么在每个线程上采集事件?— Recorder Engine](openjdk/vol-02/32-jfr/01-recorder-engine.md)