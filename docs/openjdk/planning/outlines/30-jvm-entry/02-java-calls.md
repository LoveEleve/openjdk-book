# 02. C++ 怎么调用 Java 方法？— JavaCalls + NativeLookup

> 🔴 Deep | 2 KP 中的 C++→Java 调用桥
> 读者处境: GC worker 需要从 C++ 调 `Reference.enqueue()`(Java 方法)。JavaCalls 提供线程安全的 C++→Java 调用。

> ⚠️ 写作期修正(2026-08-14, vol-02/30-jvm-entry/02 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **"call_dynamic 四种调用模式" 编造**: JavaCalls(javaCalls.hpp:229-269)只有 **call_special(:227)/call_virtual(:188)/call_static(:262)** + construct_new_instance(:261) + 低层 call(:268)→call_helper(javaCalls.cpp:346);每入口先 LinkResolver 解析(08 域)再 call
> - **"method->invoke() 走解释器或编译入口" 编造**: 真实=call_helper 里 **StubRoutines::call_stub()**(javaCalls.cpp:442,23 域)以 `from_interpreted_entry`(:390)为入口——该字段是缓存:**已编译=i2c_entry,未编译=i2i_entry**(method.hpp:113 注释);编译触发=CompilationPolicy::compile_if_required(:385,13 域)
> - **"JavaCallWrapper 构造时 ThreadInVMfromJava" 半对**: 构造在 VM 状态,内部 ThreadStateTransition(vm→Java)(javaCalls.cpp:74);职责=分配新 handle 块+保存/清空 last_Java_frame anchor+set_active_handles(:54-115,27-01 已详);析构反向(:119-154)
> - **"lookup 4 步" 简化**: 真实=lookup(:527)has_native_function 检查跳过注册者→lookup_base(:330): lookup_entry(:255: 名字生成+**特殊表 lookup_special_native_methods :228-238**(Unsafe/MethodHandleNatives/WhiteBox registerNatives→JVM_Register*,JVM_* 挂 native 的另一通道,31 域呼应)+os::dll_lookup(libjava) :267)→lookup_entry_prefixed(:294 JVMTI 前缀)→UnsatisfiedLinkError(:337-344,"'" + 方法名+签名 + "'")
> - **名字生成**(nativeLookup.cpp:165-222,:304-313): Java_+类(转义)+方法(pure :165)/JavaCritical_(critical :182)/__+签名参数部分(long :199)/OS 前后缀(compute :304)
> - **缺机制(重要)**: ①**JavaCallArguments 只记 handle/jobject 地址,不记裸 oop**(push_oop 注释 javaCalls.hpp:104-108 "delays the exposure of naked oops until it is GC-safe";value_state :158-164;parameters() javaCalls.cpp:505-517 调用 stub 前统一解析,resolve_indirect_oop :486-503);②call_helper 十步: 非 safepoint 断言(:351 "call to Java code during VM operation")/参数校验(:361)/空方法(:370)/栈守卫恢复(:399-413)/vm_result 跨 GC 保 oop 结果(:451-462)
> - **悬念指向 03 ✓**(正确,保留)
> - **实证**: 30-java-calls-demo.txt(nm libjava.so 207 个 T Java_ 符号=名字格式;native 无实现→UnsatisfiedLinkError 'int NoImplDemo.notImplemented(int)')

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
