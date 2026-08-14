# 03. Method.invoke() 在 JVM 里怎么实现?— Reflection + StackWalk

> **前置依赖**:[30-jvm-entry/02 — C++ 怎么调用 Java 方法?— JavaCalls + NativeLookup](openjdk/vol-02/30-jvm-entry/02-java-calls.md):反射的调用就是 JavaCalls;[30-jvm-entry/01 — System.currentTimeMillis() 怎么进入 JVM?— JVM Entry Points](openjdk/vol-02/30-jvm-entry/01-jvm-entry-points.md):JVM_InvokeMethod 是入口之一;[24-frame/02 — 编译代码内联了 3 层——怎么看到源级方法?— Virtual Frame](openjdk/vol-02/24-frame/02-virtual-frame.md):栈遍历的流;[08-interpreter/04 — 符号引用怎么变成直接引用?— LinkResolver + Rewriter](openjdk/vol-02/08-interpreter/04-linkresolver-rewriter.md):invoke 里的方法解析
> → **后续**:[32-jfr/01 — JFR 怎么在每个线程上采集事件?— Recorder Engine](openjdk/planning/outlines/32-jfr/01-recorder-engine.md)
> 关联域: 31-unsafe(反射字段访问走 Unsafe)、29-method-handles(invoke 的另一族)、16-code-cache

## 反射调用的链路长什么样

`Method.invoke(obj, args)` 是 Java 侧最常见的"动态调用"。它的完整链路[实证](planning/outlines/00-jvm-tools/materials/commands/30-reflection-stackwalk-demo.txt)里一镜到底(用 `StackWalker` 的 `SHOW_HIDDEN_FRAMES` 选项把反射帧全亮出来):

```
ReflectionDemo.target
jdk.internal.reflect.NativeMethodAccessorImpl.invoke0     ← native 方法
jdk.internal.reflect.NativeMethodAccessorImpl.invoke
jdk.internal.reflect.DelegatingMethodAccessorImpl.invoke
java.lang.reflect.Method.invoke
```

**`Method.invoke`(Java)→ `DelegatingMethodAccessorImpl`(默认委托)→ `NativeMethodAccessorImpl`(native 版本)→ `invoke0`(native)→ JVM_InvokeMethod**。本篇拆最后一跳(反射的 C++ 实现)与栈遍历(JVM_GetCallerClass/StackWalker)。

## 1. 反射调用: JVM_InvokeMethod → Reflection::invoke

`invoke0` 的 JVM 侧入口是 `JVM_InvokeMethod`(jvm.cpp:3571-3595): 先做**栈空间检查**(`JVMInvokeMethodSlack`,留出反射栈余量),resolve 三个参数(method 镜像/接收者/参数数组),然后进 `Reflection::invoke_method`(reflection.cpp:1257-1280):

```cpp
// reflection.cpp:1257-1278(截取核心,逐字)
oop Reflection::invoke_method(oop method_mirror, Handle receiver, objArrayHandle args, TRAPS) {
  oop mirror             = java_lang_reflect_Method::clazz(method_mirror);
  int slot               = java_lang_reflect_Method::slot(method_mirror);
  bool override          = java_lang_reflect_Method::override(method_mirror) != 0;
  objArrayHandle ptypes(THREAD, objArrayOop(java_lang_reflect_Method::parameter_types(method_mirror)));

  oop return_type_mirror = java_lang_reflect_Method::return_type(method_mirror);
  BasicType rtype;
  if (java_lang_Class::is_primitive(return_type_mirror)) {
    rtype = basic_type_mirror_to_basic_type(return_type_mirror, CHECK_NULL);
  } else {
    rtype = T_OBJECT;
  }

  InstanceKlass* klass = InstanceKlass::cast(java_lang_Class::as_Klass(mirror));
  Method* m = klass->method_with_idnum(slot);
  ...
```

**Method 镜像里装着定位信息**: 声明类(`clazz`)、**slot 编号**(`method_with_idnum` 直接取,不经名字解析)、`override`(setAccessible 标志)、参数类型与返回类型镜像。`invoke_constructor`(:1282)同构,多两步: `klass->initialize` + 分配实例。

两者汇到共享的 `invoke`(reflection.cpp:1072-1255),五段:

1. **方法解析**: `klass->initialize`;静态直接用;实例方法检查 receiver(空→NPE、`is_a` 不符→"object is not an instance of declaring class");私有/`<init>` 直接用,接口走 `resolve_interface_call`,可覆写方法按 vtable 索引解析(:1088-1148);
2. **参数个数检查**(:1175-1178,"wrong number of arguments");
3. **参数打包**(:1180-1225): 基本类型参数 `unbox_for_primitive` 拆箱 → 必要时 `widen` 扩宽(窄→宽,如 int→long)→ `push_int/long/float/double`;对象参数 `is_a` 类型检查 + `push_oop`(Handle)——**全部打进 30-02 的 JavaCallArguments**;
4. **`JavaCalls::call(&result, method, &java_args)`**(:1233)——30-02 的桥。注释(:1229): "All oops (including receiver) is passed in as Handles";
5. **结果与异常**: 方法抛异常 → 清掉并**包装成 `InvocationTargetException`**(:1234-1249,JVMTI 内部标志复位);成功 → 基本类型结果 `narrow`(宽→窄)+ `Reflection::box` 装箱(:1251-1254)。

**access check 在哪**: override 标志从镜像读出后传给 invoke(参数,:1076),但 **C++ 侧并不据此检查**——访问检查(public/私有/包可见)在 **Java 侧**(`MethodAccessor` 体系与 `Reflection.verifyAccess`)已经完成并决定调用是否放行;JVM 侧提供的是**调用者身份**——`JVM_GetCallerClass`。

## 2. 谁是调用者: JVM_GetCallerClass

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

遍历用 **`security_next()`**——安全栈遍历,跳过"内部帧": `Method::is_ignored_by_security_stack_walk`(method.cpp:1268-1276)列出三类——`Method.invoke` 本身(intrinsic `_invoke`)、**`MethodAccessorImpl` 子类**(反射辅助帧)、MethodHandle 内部适配帧(LambdaForm)。遍历规则: frame 0 必须是 `_getCallerClass` intrinsic(:729-733,否则 InternalError "must only be called from Reflection.getCallerClass");frame 0/1 都必须带 `@CallerSensitive`(:736-739);之后**第一个没被忽略的帧**的持有者类就是调用者(:740-742)。`@CallerSensitive` 注解由类文件解析时收集(`MethodAnnotationCollector::apply_to`,classFileParser.cpp:2172-2185)。

## 3. StackWalker: 分页取帧 + 三层过滤

`StackWalker.walk` 的 native 面是 `JVM_CallStackWalk`(jvm.cpp:552-578)→ `StackWalk::walk`(stackwalk.cpp:332-360): 按 mode 选流——**`JavaFrameStream`**(默认,内部是 `vframeStream _vfst`,stackwalk.hpp:76-90,24 域)或 `LiveFrameStream`(JIT 栈寄存器映射)。`fetchFirstBatch`(:363)先**跳过 StackWalker 自身帧**(`StackWalker_klass`/`AbstractStackWalker_klass`,:378-384),然后 `fill_in_frames`(:108-145)逐帧填充。

**隐藏帧的过滤在两层,分工不同**([实证:](planning/outlines/00-jvm-tools/materials/commands/30-reflection-stackwalk-demo.txt) 用 `-Xlog:stackwalk=debug` 对照):

```cpp
// stackwalk.cpp:123-137(截取核心,逐字)
    // skip hidden frames for default StackWalker option (i.e. SHOW_HIDDEN_FRAMES
    // not set) and when StackWalker::getCallerClass is called
    if (!ShowHiddenFrames && (skip_hidden_frames(mode) || get_caller_class(mode))) {
      if (method->is_hidden()) {
        LogTarget(Debug, stackwalk) lt;
        if (lt.is_enabled()) {
          ...
        }
        continue;
      }
    }
```

- **HotSpot 侧**: `skip_hidden_frames(mode)`(stackwalk.hpp:133-135,`SHOW_HIDDEN_FRAMES` 位未置时跳过)**只过滤 `is_hidden()` 的帧**——`@LambdaForm.Hidden` 注解的方法(解析时设置,classFileParser.cpp:2180),即 MethodHandle 的 LambdaForm 内部帧;
- **Java 侧**: 反射帧(NativeMethodAccessorImpl 等)由 `StackStreamFactory.java:249-268`(`skipReflectionFrames`/`isReflectionFrame` 按类判断)过滤——实证日志里 hotspot 把 `invoke0/invoke/DelegatingMethodAccessorImpl/Method.invoke` 全部 fill 进了数组,但默认 Java 输出只剩业务帧。**大纲想象的"反射帧过滤在 stackwalk.cpp"是错的,它在 Java 侧**;hotspot 的 `is_hidden` 只管 LambdaForm。

**分页**: 帧数组用完后 `JVM_MoreStackWalk`(jvm.cpp:580-601)→ `fetchNextBatch` 续取——`StackWalker` 的流式遍历按批消费,批大小自适应(StackStreamFactory.java:545-556): 首批 = `Math.min(Math.max(walker.estimateDepth(), SMALL_BATCH), LARGE_BATCH_SIZE)`(SMALL_BATCH=8、LARGE_BATCH_SIZE=256、BATCH_SIZE=32,:68-70),后续批次**翻倍直到 32 封顶**([实证:] 30-reflection-stackwalk-demo.txt 日志首次 batch size 6=estimateDepth 估计值,续批 12);`BaseFrameStream` 用 magic 校验跨批次的有效性(stackwalk.cpp:42-88)。

## 核心悬念

反射与栈遍历拆完: `Method.invoke` 的最后一跳是 `JVM_InvokeMethod` → `Reflection::invoke_method`(slot 定位)→ `invoke` 五段(方法解析/参数个数/拆箱-扩宽-打包/JavaCalls/InvocationTargetException 包装+装箱),权限检查在 Java 侧、`JVM_GetCallerClass` 用 `security_next` 跳过三类内部帧后交出调用者类;`StackWalker` 分页取帧,**隐藏帧双轨过滤**(hotspot 滤 LambdaForm 的 `@Hidden`,Java 侧滤反射帧)。`reflectionAccessorImplKlassHelper`(oops/reflectionAccessorImplKlassHelper.hpp)则是另一族用途——诊断工具(heapInspection/metaspace 打印)识别 GeneratedMethodAccessor 类并显示它的调用目标。

反射是"主动查"——还有一套"被动采样"的观测通道: JFR 在**每个线程上**采集事件(方法采样/线程转储/分配剖面),它的采集引擎怎么运转?下一篇: 32 域 JFR Recorder Engine。

> → [32-jfr/01 — JFR 怎么在每个线程上采集事件?— Recorder Engine](01-recorder-engine.md)
