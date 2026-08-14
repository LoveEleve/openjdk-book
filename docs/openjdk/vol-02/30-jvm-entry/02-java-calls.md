# 02. C++ 怎么调用 Java 方法?— JavaCalls + NativeLookup

> **前置依赖**:[30-jvm-entry/01 — System.currentTimeMillis() 怎么进入 JVM?— JVM Entry Points](openjdk/vol-02/30-jvm-entry/01-jvm-entry-points.md):NativeLookup::lookup 与 JVM_* 注册链;[27-jni/01 — jobject 在 JVM 内部怎么存的?— JNI Handle 系统](openjdk/vol-02/27-jni/01-handle-system.md):JavaCallWrapper 的 active_handles 切换已在本地引用篇讲过;[13-jit-framework/01 — 谁决定编译、怎么排队、谁执行?— CompileBroker 编译队列](openjdk/vol-02/13-jit-framework/01-compile-broker-queue.md):call_helper 里的编译触发;[23-stub/01 — JVM 启动时预生成哪些汇编例程?— StubRoutines 全局桩](openjdk/vol-02/23-stub/01-stub-entry.md):call_stub 是什么
> → **后续**:[30-jvm-entry/03 — 反射与栈遍历](03-reflection-stackwalk.md)
> 关联域: 27-jni(native 方法的另一半)、31-unsafe(特殊表注册)、17-threads(线程状态)

## JVM 内部也要"调 Java"

30-01 讲的是 Java→JVM(native 方法找 JVM_*);反过来,JVM 内部(C++ 侧)经常要**调用 Java 方法**: 新线程的 `thread_entry`、反射的 Method.invoke、`System.gc` 前的 VM 操作、GC 后的回调——统一走 **JavaCalls**。它回答三个问题: 按什么语义找方法(call_special/virtual/static)、参数怎么安全地传(JavaCallArguments)、调用瞬间线程怎么切(JavaCallWrapper + call_stub)。这篇再补全 NativeLookup 的另一半: 用户 native 方法的名字是怎么生成、往哪里查的。

## 1. 三个入口,一个底层

`JavaCalls` 类(javaCalls.hpp:229-269)对外是三个语义入口——**没有大纲想象的 call_dynamic**:

```cpp
// javaCalls.cpp:188-201(截取核心,逐字)
void JavaCalls::call_virtual(JavaValue* result, Klass* spec_klass, Symbol* name, Symbol* signature, JavaCallArguments* args, TRAPS) {
  CallInfo callinfo;
  Handle receiver = args->receiver();
  Klass* recvrKlass = receiver.is_null() ? (Klass*)NULL : receiver->klass();
  LinkInfo link_info(spec_klass, name, signature);
  LinkResolver::resolve_virtual_call(
          callinfo, receiver, recvrKlass, link_info, true, CHECK);
  methodHandle method = callinfo.selected_method();
  assert(method.not_null(), "should have thrown exception");

  // Invoke the method
  JavaCalls::call(result, method, args, CHECK);
}
```

- **call_virtual**(:188): 按接收者实际类型解析虚调用(`LinkResolver::resolve_virtual_call`,08 域的解析器)选出 `selected_method`——就是 Java 侧 invokevirtual 的语义;
- **call_special**(:227): `<init>`/私有/超类调用(`resolve_special_call`),invokespecial 语义;
- **call_static**(:262): `resolve_static_call`,invokestatic 语义;
- **construct_new_instance**(:261): 分配实例 + 调 `<init>`,等价于 `new Klass(...)`。

解析出 methodHandle 后全部汇到低层 `call`(:268)→ `call_helper`(javaCalls.cpp:346)——真正的执行管线。

## 2. 参数打包: 只记 handle,不碰裸 oop

`JavaCallArguments`(javaCalls.hpp:76 起)是参数容器,注释自述 "faster, safer, and more convenient than using var-args"。核心设计在 push_oop 的注释(:104-108):

```cpp
// javaCalls.hpp:104-108(截取核心,逐字)
  // Helper for push_oop and the like.  The value argument is a
  // "handle" that refers to an oop.  We record the address of the
  // handle rather than the designated oop.  The handle is later
  // resolved to the oop by parameters().  This delays the exposure of
  // naked oops until it is GC-safe.
```

**打包时只记录 handle 的地址(或 jobject),不记录裸 oop**——因为从"参数打包"到"真正调用"之间可能经过 GC(可能分配、可能 safepoint),裸 oop 会悬空。每个槽带一个 `_value_state` 标记(:158-164: primitive/oop/handle/jobject)。**解析推迟到最后一刻**: `parameters()`(javaCalls.cpp:505-517)在调用 stub 之前统一把 handle/jobject 解析成裸 oop 写回数组:

```cpp
// javaCalls.cpp:486-518(截取核心,逐字)
  switch (state) {
  case JavaCallArguments::value_state_handle:
  {
    oop* ptr = reinterpret_cast<oop*>(value);
    return Handle::raw_resolve(ptr);
  }

  case JavaCallArguments::value_state_jobject:
  {
    jobject obj = reinterpret_cast<jobject>(value);
    return JNIHandles::resolve(obj);
  }
  ...
}

intptr_t* JavaCallArguments::parameters() {
  // First convert all handles to oops
  for(int i = 0; i < _size; i++) {
    uint state = _value_state[i];
    assert(state != value_state_oop, "Multiple handle conversions");
    if (is_value_state_indirect_oop(state)) {
      oop obj = resolve_indirect_oop(_value[i], state);
      _value[i] = cast_from_oop<intptr_t>(obj);
      _value_state[i] = value_state_oop;
    }
  }
  // Return argument vector
  return _value;
}
```

## 3. call_helper: 从 C++ 到解释器入口的十步

`call_helper`(javaCalls.cpp:346-475)是执行管线,按序:

1. **四断言**(:349-352): 调用者必须是 Java 线程;method 非空;**`!SafepointSynchronize::is_at_safepoint()`——"call to Java code during VM operation"**: safepoint 里所有 Java 线程都停着,没人能执行 Java 代码(VM 操作里要调 Java 得先结束 safepoint);`!handle_area()->no_handle_mark_active()`(NoHandleMark 区段内不许外调);
2. **参数校验**(:361-364): CheckJNICalls 时 `args->verify`(签名对参数);
3. **空方法直接返回**(:370-373);
4. **`CompilationPolicy::compile_if_required(method, CHECK)`**(:385)——调用前按分层策略决定是否触发编译(13 域);
5. **入口选择**: `method->from_interpreted_entry()`(:390),注释说明原因(:387-389): "Since the call stub sets up like the interpreter we call the from_interpreted_entry so we can go compiled via a i2c"——**从解释器入口进,若方法已编译则经 i2c 转换器跳到编译代码**;
6. **栈守卫恢复**(:399-413): 进 VM 时黄/红区守卫可能被禁用,回 Java 前 reguard + shadow pages 检查(栈溢出防线);
7. **`JavaCallWrapper link(method, receiver, result, CHECK)`**(:420)——27-01 拆过: 分配新 handle 块、`transition(vm→Java)`、保存/清空 last_Java_frame anchor、`set_active_handles(new_handles)`(javaCalls.cpp:54-115);析构反向(恢复块、`transition_from_java` 回 VM、`release_block` 旧块,:119-154)。**必须回到 `_thread_in_Java` 的原因**: 只有这个状态,GC 栈扫描才知道"这个线程正跑在 Java 代码里",它的帧、handle 块、anchor 才成为根;
8. **`StubRoutines::call_stub()(...)`**(:442)——调用共享的 call_stub(23 域): 参数是 link 地址、结果地址、返回类型、方法、入口点、参数数组、参数个数;
9. **结果回写**(:447-449 `result = link.result()`);
10. **oop 返回值跨 GC 保存**(:451-462): 把结果存进 `thread->vm_result()`,等出 JavaCallWrapper(可能阻塞)后取回——`vm_result` 是线程上专门放"待跨 GC 的返回值"的槽。

## 4. NativeLookup 补全: 名字怎么生成、往哪查

30-01 看了 `lookup`(:527)与 `lookup_base`(:330)的骨架,这里补全内部:

**名字生成**(nativeLookup.cpp:165-222): `pure_jni_name`(:165)= `Java_` + 类名(转义)+ `_` + 方法名——[实证:](planning/outlines/00-jvm-tools/materials/commands/30-java-calls-demo.txt) `nm` 显示 libjava.so 里 **207 个 `T Java_java_*_*` 符号**(`Java_java_io_Console_echo`...);`critical_jni_name`(:182)= `JavaCritical_` 前缀(临界 native);`long_jni_name`(:199)= 追加 `__` + 签名参数部分(去括号去返回类型,重载消歧);`compute_complete_jni_name`(:304-313)再按平台风格加前后缀(`os_style` 参数,Linux 无前后缀)。

**查找顺序**: `lookup_base`(:511)→`lookup_entry`(:327: 按 short 风格/带签名 long 风格/无 OS 前后缀三种名字逐一尝试)→核心在 `lookup_style`(:253): **按类加载器分流**——①系统类(loader 为 null,注释 :258-261 说明这是 bootstrapping 关键): 查**特殊表** `lookup_special_native_methods`(:263,7 条: `Java_jdk_internal_misc_Unsafe_registerNatives → JVM_RegisterJDKInternalMiscUnsafeMethods`、MethodHandleNatives、`Java_jdk_internal_perf_Perf_registerNatives → JVM_RegisterPerfMethods`、WhiteBox + JVMCI/JFR 条件条目——**JVM_* 函数挂上 native 方法的另一条通道**,31 域的 Unsafe/WhiteBox、38 域的 Perf 就走它)→ `os::dll_lookup(libjava)`(:265,dlsym 封装);②**应用类(loader 非空): `JavaCalls::call_static` 调 `ClassLoader.findNative(jni_name)`**(:277-285)——native 方法查找在这里**绕回 Java 侧**(用户类加载器决定找哪个库,`System.loadLibrary` 的链路),找到的地址经 `result.get_jlong()` 取回;③agent 库兜底(:293-297);仍未命中→`lookup_entry_prefixed`(:476,JVMTI 前缀方法)→`UnsatisfiedLinkError`(:522-527,[实证:] 30-java-calls-demo.txt: `'int NoImplDemo.notImplemented(int)'`——消息=方法名+签名)。

**两条解析路径的对照**: JVM_*(JDK 专属)走 30-01 的编译期链接;用户 native 方法走这里——名字生成后**按类加载器分流**(系统类在 libjava 里查、应用类经 `ClassLoader.findNative` 由用户类加载器定位库),或者更早被 RegisterNatives/JNI_OnLoad 注册过(has_native_function 直接跳过)。

## 核心悬念

桥的两头齐了: JavaCalls 是 JVM 内部调 Java 的通道——三个语义入口(call_special/virtual/static,**没有 call_dynamic**)解析出方法后走 call_helper: 参数只记 handle 最后一刻解析(GC 安全)、非 safepoint 断言、编译机会、解释器入口进(i2c 跳编译)、栈守卫、JavaCallWrapper 状态切换、call_stub 执行、vm_result 跨 GC 保结果;NativeLookup 补全: 名字三件套(Java_/JavaCritical_/__签名)、特殊表挂 JVM_*、libjava 里 dlsym、JVMTI 前缀、报 UnsatisfiedLinkError。

但有一族 Java 侧的调用绕过了 JavaCalls 的名字解析,直接走 JVM_* 的反射/栈操作: `Method.invoke`、`Class.getDeclaredMethods`、`StackWalker`——它们怎么在 C++ 侧实现?下一篇: 反射与栈遍历。

> → [30-jvm-entry/03 — 反射与栈遍历](03-reflection-stackwalk.md)
