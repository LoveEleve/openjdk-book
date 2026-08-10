# 05-Reflection-Internal — Method.invoke() 的 6 层调用路径、Inflation 机制、参数拆箱、以及反射慢 10-100 倍的根本原因

> **元信息**
> - 标准环境：OpenJDK 11 slowdebug build，`-Xms8g -Xmx8g -XX:+UseG1GC`，64-bit Linux x86
> - 跨模块说明：JDK(java.lang.reflect) → prims(jvm.cpp) → runtime(reflection.cpp) → runtime(javaCalls.cpp) → interpreter/compiler，5 个模块跨越，4 次架构边界穿越
> - 前置文档：[09-04 JVM-Entry-Points]（JVM_ENTRY 宏系统）、[09-01 ThreadState-NativeTransition]（线程状态转换）
> - 前瞻文档：[09-06 MethodHandles + invokedynamic]（MethodHandles vs Reflection 性能对比）
> - 地位：09 阶段纵深文档，阅读顺序第四
> - 阅读收益：完整追踪 `Method.invoke()` 从 Java 到汇编的 6 层调用路径，理解每层的"减速带"具体消耗了哪些 CPU 指令/内存分配/状态转换。掌握 Inflation 机制如何消除 JNI 往返开销。理解 `unbox_for_primitive()` + `widen()` + `push_*()` 的参数拆箱循环为什么是反射开销之王。认知 `java_lang_reflect_Method::slot()` 的 O(1) 查找是反射 API 可行的前提条件

---

## §〇 源文件清单（跨 JDK + prims + runtime + classfile + os_cpu）

| # | 文件 | 路径 | 模块 | 核心函数/类（已验证行号） | 本文角色 |
|---|------|------|------|---------------------|---------|
| 1 | `reflection.cpp` | `src/hotspot/share/runtime/reflection.cpp` | runtime | `invoke_method()`(:1259-1284)、`invoke()`(:1074-1254)、`unbox_for_primitive()`(:106-112)、`widen()`(:120-218)、参数拆箱循环(:1191-1224)、`new_method()`(:864-925) | ★★★ 反射核心实现 |
| 2 | `jvm.cpp` | `src/hotspot/share/prims/jvm.cpp` | prims | `JVM_InvokeMethod`(:3612-3634)、`JVM_NewInstanceFromConstructor`(:3637-3647) | ★★ JVM 入口层 |
| 3 | `javaCalls.cpp` | `src/hotspot/share/runtime/javaCalls.cpp` | runtime | `JavaCalls::call()`(:345)、`call_helper()`(:354-459)、`StubRoutines::call_stub()`(:450) | ★★ C++→Java 汇编桩 |
| 4 | `javaClasses.cpp` | `src/hotspot/share/classfile/javaClasses.cpp` | classfile | `compute_offsets()`(:2737+)、`slot()`(:2773-2776)、`set_slot()`(:2778-2781)、`slot_offset`(:4212) | ★★ 字段偏移预计算 |
| 5 | `javaClasses.hpp` | `src/hotspot/share/classfile/javaClasses.hpp` | classfile | `java_lang_reflect_Method` 类中的 slot/clazz/override 访问器声明 | ★ 字段访问器定义 |
| 6 | `ReflectionFactory.java` | `jdk/src/java.base/share/classes/jdk/internal/reflect/ReflectionFactory.java` | JDK | `inflationThreshold` 默认 15、`noInflation` 标志 | ★ Inflation 参数配置 |
| 7 | `NativeMethodAccessorImpl.java` | `jdk/src/java.base/share/classes/jdk/internal/reflect/NativeMethodAccessorImpl.java` | JDK | `invoke()`→inflation 检查→`invoke0()` | ★★ Inflation 触发器 |
| 8 | `reflectionAccessorImplKlassHelper.cpp` | `src/hotspot/share/classfile/reflectionAccessorImplKlassHelper.cpp` | classfile | `is_generated_method_accessor()`(:100-103) | ★ C++ 侧 Inflation 后类识别 |

---

## §一 ★★★ 6 层调用路径 — 完整泳道图 + 每层的"减速带"

### 1.1 泳道图 — Layer 1-6 的线程状态、Handle 创建数、关键操作

```
Layer 1 (Java)  java.lang.reflect.Method.invoke()
│              ┌────────────────────────────────────────────┐
│              │ ① AccessibleObject.checkAccess()           │
│              │    → Reflection.getCallerClass()            │ ← 每次调用都做！
│              │    → checkAccess(klass, caller)             │ ← 即使 setAccessible，仍然读 override flag
│              │ ② ma.invoke(obj, args)                     │ ← MethodAccessor 虚调用
│              └────────────────────────────────────────────┘
│ 线程状态: _thread_in_Java    Handle 创建: 0                     减速带: override 字段读 + caller class 查+ access check
│
Layer 2 (Java)  NativeMethodAccessorImpl.invoke()
│              ┌────────────────────────────────────────────┐
│              │ ① ++numInvocations                         │ ← Atomic field increment
│              │ ② if (numInvocations > inflationThreshold) │ ← 默认 15 次，比较指令
│              │     → generateMethodAccessor()              │ ← 生成 bytecode class (~1ms)
│              │ ③ invoke0(method, obj, args)               │ ← ★ native 方法声明
│              └────────────────────────────────────────────┘
│ 线程状态: _thread_in_Java → ★ 进入 native                减速带: counter CAS + 阈值比较 + native entry overhead
│
Layer 3 (JNI)  invoke0() → JVM_InvokeMethod (jvm.cpp:3612)
│              ┌────────────────────────────────────────────┐
│              │ ① JVM_ENTRY 宏展开:                        │
│              │    → ThreadInVMfromNative __tiv(thread)    │ ← ctor: _native→_native_trans→poll→_vm
│              │    → HandleMarkCleaner __hm(thread)         │ ← push HandleMark checkpoint
│              │    → Thread* THREAD = thread               │ ← 异常传播管道
│              │ ② 创建 3 个 Handle:                        │
│              │    → method_handle(THREAD, resolve(method)) │
│              │    → receiver(THREAD, resolve(obj))         │
│              │    → objArrayHandle args(THREAD, args0)     │
│              │ ③ Reflection::invoke_method(...)           │
│              │ ④ JVM_END → ~__hm→~__tiv dtor              │ ← dtors: pop HandleMark + trans_and_fence
│              └────────────────────────────────────────────┘
│ 线程状态: _native(4)→_native_trans(5)→poll→_vm(6)→...→_vm_trans(7)→_native(4)
│ Handle 创建: ≥3                          减速带: 状态转换 ×2 + fence ×2 + Handle 分配 ×3
│
Layer 4 (C++)  Reflection::invoke_method (reflection.cpp:1259-1284)
│              ┌────────────────────────────────────────────┐
│              │ ① mirror = clazz(method_mirror)            │ ← obj_field read → oop
│              │ ② slot = slot(method_mirror)               │ ← ★ int_field(slot_offset) → O(1) index
│              │ ③ override = override(method_mirror) != 0  │ ← byte_field read → 每次调用都读！
│              │ ④ ptypes = parameter_types(method_mirror)  │ ← obj_field read → Object[] oop
│              │ ⑤ rtype = 解析 return_type → BasicType     │
│              │ ⑥ klass = InstanceKlass::cast(as_Klass())  │ ← mirror→Klass* 转换
│              │ ⑦ m = klass->method_with_idnum(slot)       │ ← ★ O(1) 数组索引
│              │ ⑧ methodHandle mh(THREAD, m)               │ ← Handle 创建
│              │ ⑨ invoke(klass, mh, receiver, override,    │ ← 调用 invoke() helper
│              │         ptypes, rtype, args, true, THREAD)  │
│              └────────────────────────────────────────────┘
│ 线程状态: _thread_in_vm                   Handle 创建: ≥3 (methodHandle + ptypes handle 等)
│ 减速带: 7-8 次 oop 字段读 + 1 次 int 字段读 + Klass* 转换 + Method* 数组索引
│
Layer 5 (C++)  invoke() helper (reflection.cpp:1074-1254)
│              ┌────────────────────────────────────────────┐
│              │ ① ResourceMark rm(THREAD)                  │ ← checkpoint RA allocation
│              │ ② klass->initialize(CHECK_NULL)            │ ← 可能触发 <clinit>!
│              │ ③ 静态/非静态判定 → 方法解析               │
│              │ ④ args->length() == ptypes->length() check │
│              │ ⑤ JavaCallArguments java_args(params)      │ ← ★ 堆分配参数数组
│              │ ⑥ ★★★ 参数拆箱循环 (L1191-1224):          │
│              │    for each arg:                            │
│              │      → type_mirror = ptypes->obj_at(i)     │ ← Object[] 读取
│              │      → arg = args->obj_at(i)                │ ← Object[] 读取
│              │      → is_primitive(type_mirror) →          │ ← Klass* 检查
│              │        → unbox_for_primitive(arg, &value)   │ ← null chk+klass chk+field rd
│              │        → if type_mismatch: widen(&value)    │ ← switch 语句
│              │        → push_int/push_long/push_oop...     │ ← GrowableArray::append()
│              │ ⑦ JavaCalls::call(&result, mh, &java_args) │ ← ★ 进入 Layer 6
│              │ ⑧ if HAS_PENDING_EXCEPTION →                │
│              │      wrap as InvocationTargetException      │ ← 额外对象分配 + 包装
│              │ ⑨ box(rvalue, rtype) → 返回装箱结果        │ ← 结果包装
│              └────────────────────────────────────────────┘
│ 线程状态: _thread_in_vm                   Handle 创建: 每参数≥1 Handle (arg_handle)
│ 减速带: ★ 参数拆箱循环 — 每个 primitive arg: null check + klass check + field read (3 oop ops) + 类型匹配 + push
│          如果 5 个 int 参数: 5×(null check + klass check + field read + push) = 20 oop 操作
│
Layer 6 (asm)  JavaCalls::call → call_helper → StubRoutines::call_stub
│              ┌────────────────────────────────────────────┐
│              │ ① call_helper:                             │
│              │    → compile_if_required(method, CHECK)    │ ← 可能触发 JIT 编译
│              │    → entry_point = from_interpreted_entry() │
│              │    → JavaCallWrapper(method, receiver,     │ ← RAII: HandleMark + ResourceMark
│              │        result, CHECK)                       │
│              │    → StubRoutines::call_stub()(             │ ← ★ 汇编桩:
│              │        link, result_addr, result_type,      │    设置 Java 栈帧
│              │        method, entry_point,                 │    → 跳转 method->from_interpreted_entry()
│              │        parameters, size, CHECK)             │    → 解释器/JIT 开始执行目标方法
│              └────────────────────────────────────────────┘
│ 线程状态: _vm(6)→_Java(8) → 执行目标方法 → _vm(6)         Handle: JavaCallWrapper 内部 HandleMark
│ 减速带: ★ 从 C++ 栈切换到 Java 栈 → 汇编桩设置 sender_sp + 栈帧
│         → 解释器开始: 字节码逐条解释 (除非已 JIT 编译)
│         → 如果目标方法也做反射 → 嵌套 6 层（递归反射开销倍增）
```

### 1.2 Layer 1-2（Java）: MethodAccessor 委派链 + Inflation 检查

**Layer 1** (`java.lang.reflect.Method.invoke()`) 的减速带：

| 操作 | 代码位置 | 消耗 | 直接调用有无？ | JIT 可优化？ |
|------|---------|------|-------------|-----------|
| `checkAccess()` | Method.invoke() 方法体 | 获取 caller class + permission check | ❌ 无 | ❌ checkAccess 依赖 call stack，无法内联消除 |
| `override` flag 读 | Field.getBoolean(method, "override") | 1 次 oop 字段读（堆上字段，需要 GC barrier） | ❌ 无 | ❌ JIT 无法证明 heap 字段不变 → 退化为每次读 |
| `ma.invoke(obj, args)` | 虚调用 dispatch | 1 次虚调用（vtable 查找） | ❌ 无 | ✅ 理论上 JIT 可 devirtualize，但 MethodAccessor 接口有多个实现 → 通常不行 |

**Layer 2** (`NativeMethodAccessorImpl.invoke()`) 的减速带：

```
++numInvocations                           // Atomic CAS (lock cmpxchg 或 lock xadd)
if (numInvocations > inflationThreshold) { // cmp 指令
    MethodAccessorGenerator.generateMethod(); // ★ 首次命中: 生成 bytecode class (~1ms)
    tmp.setDelegate(acc);                   // 替换 delegate
    acc.invoke(obj, args);                  // 递归用新 accessor 调用
}
invoke0(method, obj, args);               // ★ native 方法 → JNI 往返
```

`invoke0()` 是 native 声明，不是 Java 代码——这里触发的是**解释器 native method entry**（汇编序列：`movl [thread+state_offset], _thread_in_native` → `call *native_function`）。从此刻起，线程进入 native 世界，Layer 3 启动。

### 1.3 Layer 3（JNI）: JVM_InvokeMethod + JVM_ENTRY 宏的 RAII

**`JVM_InvokeMethod` 的完整展开** (`jvm.cpp:3612-3634`)：

这是 [09-04]§一 的直接应用。JVM_ENTRY 宏在此注入：

```cpp
// jvm.cpp:3612 — 宏展开等价代码:
extern "C" {                                                      // C linkage
  jobject JNICALL JVM_InvokeMethod(JNIEnv* env, jobject method, jobject obj, jobjectArray args0) {
    JavaThread* thread = JavaThread::thread_from_jni_environment(env);  // 取线程
    ThreadInVMfromNative __tiv(thread);               // ★① ctor: _native(4)→poll→_vm(6)
    // [VM_ENTRY_BASE 展开]
    InterfaceSupport::_number_of_calls++;              // ② 计数器
    HandleMarkCleaner __hm(thread);                    // ★③ Handle 作用域
    Thread* THREAD = thread;                           // ④ TRAPS 别名
    os::verify_stack_alignment();                      // ⑤ assert only

    // ===== 用户代码 (jvm.cpp:3613-3633) =====
    JVMWrapper("JVM_InvokeMethod");                    // ⑥ trace
    Handle method_handle;
    if (thread->stack_available((address) &method_handle) >= JVMInvokeMethodSlack) {  // ⑦ 栈检查
      method_handle = Handle(THREAD, JNIHandles::resolve(method));  // ★⑧ Handle 创建 #1
      Handle receiver(THREAD, JNIHandles::resolve(obj));            // ★⑨ Handle 创建 #2
      objArrayHandle args(THREAD, objArrayOop(JNIHandles::resolve(args0)));  // ★⑩ Handle 创建 #3
      oop result = Reflection::invoke_method(method_handle(), receiver, args, CHECK_NULL);  // ★⑪ 进入 Layer 4
      jobject res = JNIHandles::make_local(env, result);  // ⑫ oop→jobject
      if (JvmtiExport::should_post_vm_object_alloc()) {   // ⑬ JVMTI 回调（可能）
        oop ret_type = java_lang_reflect_Method::return_type(method_handle());
        // ret_type Handle 创建（临时）                             // ★⑭ Handle 创建 #4
        JvmtiExport::post_vm_object_alloc(...);
      }
      return res;
    } else {
      THROW_0(vmSymbols::java_lang_StackOverflowError());        // ⑮ 栈溢出
    }
    // ===== JVM_END (L3634) =====
    // ★ ~__hm() → pop_and_restore HandleMark    ← 释放 3-4 个 Handle
    // ★ ~__tiv() → trans_and_fence(_vm→_native) ← [01]§二 出口状态转换
```

**减速带量化**：

| 操作 | 开销类型 | 大致 cycles | 累积原因 |
|------|---------|------------|---------|
| `JNIHandles::resolve(method)` ×3 | 读 oop* 指针 | ~9 (3×3) | LocalRef 在 JNIHandleBlock 数组中 |
| `Handle(THREAD, oop)` ×3 | HandleArea 分配 | ~15 (3×5) | Arena top 指针推进 |
| `ThreadInVMfromNative` ctor | 状态转换+fence+poll | ~100 | [01]§二 三段式：set(trans)→fence→poll→block_if_requested→set(_vm) |
| `ThreadInVMfromNative` dtor | 状态转换+fence | ~40 | trans_and_fence: set(trans)→fence→block_if_requested→set(_native) |
| **合计固定开销** | | **~164 cycles** | **直接调用: 0 cycles** |

### 1.4 Layer 4-5（C++）: invoke_method + invoke + 参数拆箱

**Layer 4 — `invoke_method` 的 7 步操作** (`reflection.cpp:1259-1284`)：

```cpp
// L1263: mirror = java_lang_reflect_Method::clazz(method_mirror)
//   → method_mirror->obj_field(clazz_offset)               ← oop 字段读 #1

// L1264: slot = java_lang_reflect_Method::slot(method_mirror)
//   → method_mirror->int_field(slot_offset)                 ← ★ int 字段读 (O(1)!)

// L1265: override = java_lang_reflect_Method::override(method_mirror) != 0
//   → method_mirror->byte_field(override_offset)            ← oop 字段读 #2 (每次调用!)

// L1266: ptypes = java_lang_reflect_Method::parameter_types(method_mirror)
//   → method_mirror->obj_field(parameterTypes_offset)       ← oop 字段读 #3

// L1268: return_type_mirror = java_lang_reflect_Method::return_type(method_mirror)
//   → method_mirror->obj_field(returnType_offset)           ← oop 字段读 #4

// L1276: InstanceKlass* klass = InstanceKlass::cast(java_lang_Class::as_Klass(mirror))
//   → mirror→metadata_field → Klass* 转换

// L1277: Method* m = klass->method_with_idnum(slot)
//   → methods()->at(slot) → O(1) 数组索引

// L1281: methodHandle method(THREAD, m)
//   → Handle 创建 #5 (Layer 4 内部)
```

**Layer 5 — `invoke()` helper 的参数拆箱循环** (`reflection.cpp:1191-1224`)：

```
for (int i = 0; i < args_len; i++) {
    oop type_mirror = ptypes->obj_at(i);            // ① Object[] 读取 → oop 解引用
    oop arg = args->obj_at(i);                       // ② Object[] 读取 → oop 解引用
    if (java_lang_Class::is_primitive(type_mirror)) { // ③ Klass* 检查 (type_mirror->klass())
        jvalue value;
        BasicType ptype = basic_type_mirror_to_basic_type(type_mirror, CHECK_NULL);  // ④ 类型映射
        BasicType atype = Reflection::unbox_for_primitive(arg, &value, CHECK_NULL);  // ★⑤ 拆箱
        if (ptype != atype) {
            Reflection::widen(&value, atype, ptype, CHECK_NULL);                     // ⑥ 类型提升（可选）
        }
        switch (ptype) {                                  // ⑦ switch 分发
            case T_INT:    java_args.push_int(value.i);   break;   // ★⑧ push
            case T_LONG:   java_args.push_long(value.j);  break;
            // ... 7 more cases ...
        }
    } else {                                            // 对象参数分支
        if (arg != NULL) {
            Klass* k = java_lang_Class::as_Klass(type_mirror);
            if (!arg->is_a(k)) { THROW_MSG_0(...); }    // ⑨ 类型兼容性检查
        }
        Handle arg_handle(THREAD, arg);                  // ★⑩ 创建 Handle
        java_args.push_oop(arg_handle);                   // ★⑪ push Handle
    }
}
```

`push_int` / `push_long` / `push_oop` 最终调用 `GrowableArray<T>::append()` —— 向内部数组追加元素。如果数组满 → 分配新空间 + memcpy 复制。

### 1.5 Layer 6（汇编）: JavaCalls::call → StubRoutines::call_stub

```cpp
// javaCalls.cpp:345 — JavaCalls::call()
void JavaCalls::call(JavaValue* result, const methodHandle& method,
                     JavaCallArguments* args, TRAPS) {
  os::os_exception_wrapper(call_helper, result, method, args, THREAD);
}

// javaCalls.cpp:354-459 — call_helper() 核心步骤
// ① compile_if_required(method, CHECK)         — ★ 可能触发 JIT 编译 (ms 级)
// ② entry_point = method->from_interpreted_entry()
// ③ stack_shadow_pages_available() check         — 栈溢出保护
// ④ JavaCallWrapper link(method, receiver, ...)  — RAII: HandleMark + ResourceMark
// ⑤ StubRoutines::call_stub()(link, result_addr, result_type,
//        method, entry_point, parameters, size, CHECK)   — ★ 汇编桩跳板
```

**汇编桩 (`StubGenerator::generate_call_stub()`) 做了什么**：
- 设置 Java 的 `sender_sp`（C++ 调用者的栈顶地址）
- 将 `JavaCallArguments` 中的参数按 Java 调用约定放入正确寄存器/栈位置
- `call method->from_interpreted_entry()` — 跳入解释器
- 解释器设置 `last_Java_frame` → 开始执行目标方法字节码

### 1.6 ★ 和直接调用的逐环节对比表

| 操作 | 直接调用 (invokevirtual) | 反射调用 (Method.invoke) | 差距 |
|------|------------------------|------------------------|------|
| **调用前检查** | 无（编译器已做类型检查） | MethodAccessor.checkAccess() + override flag 读 | +1 虚调用 + 1 字段读 |
| **参数准备** | 参数已在局部变量表（寄存器/栈） | Object[] 拆箱 — 每个 primitive arg: null check + klass check + field read + push | +N×(3 oop ops) |
| **线程状态转换** | 0 次（一直在 _thread_in_Java） | 2 次完整往返：_native→_vm→_native（JNI downcall + upcall） | +2×(trans+fence+poll) ≈200 cycles |
| **Handle 分配** | 0 个 | 7-10+ 个（method_handle, receiver, args handle, 每参数 1 handle...） | +7 HandleArea 分配 |
| **方法查找** | 常量池索引 → 编译时已 resolve | slot() O(1)→method_with_idnum() 数组索引 | +1 int_field + 1 数组读 |
| **C++→Java 跳板** | 字节码直接 dispatch（解释器）或 inline（JIT） | JavaCalls::call_helper → call_stub → 解释器 | +多层函数调用 |
| **结果处理** | 结果已在返回值寄存器 | 若 primitive 返回值 → box() 装箱，若异常 → wrap InvocationTargetException | +1 对象分配 + 异常包装 |
| **JIT 可优化范围** | 整个方法体可内联、可逃逸分析、可标量替换 | ★ Inflation 后可消除 Layer 2-3，但 Object[] 拆箱+装箱不可消除（API 契约决定） | Object[] 是硬伤 |

**结论**：直接调用走的是"JIT 已编译的机器码 → cpu 直接执行"，0 层中间开销。反射走的是"6 层解释 + JNI 往返 + 参数拆箱/装箱"的最长路径。这就是"反射慢 10-100 倍"的根本原因——不是某一层特别慢，是每一层都叠加了自己独立的最小线性成本。

---

## §二 ★★ Inflation 机制 — 从 Native 到 Generated

### ❓ 为什么需要 15 次预热？

Inflation 的存在是因为 Layer 3（JNI native 往返）是可以消除的：
- `NativeMethodAccessorImpl.invoke0()` 是 native → 每次调用穿越 JNI 边界
- `GeneratedMethodAccessor.invoke()` 是纯 Java bytecode → 无 JNI 开销

**但为什么不是第 1 次就生成？** 生成 bytecode class 有代价（~1ms），包括：
1. 构造 ClassFile 结构（魔数 0xCAFEBABE + 版本 + 常量池 + 方法体）
2. `Unsafe.defineAnonymousClass()` 注册到 VM
3. 新类的 ClassLoader 数据登记

如果方法只调用 1-2 次 → 生成开销 > 调用节省 → 不划算。15 是经验平衡点——15 次 JNI 往返的累积开销 ≈ 生成一次 bytecode class 的成本。

### 2.1 NativeMethodAccessorImpl 的计数器和阈值检查

```
NativeMethodAccessorImpl.invoke() 伪代码:

int numInvocations = 0;  // 实例字段

Object invoke(Object obj, Object[] args) {
    checkAccess();  // Layer 1 已做，这里是二次检查

    if (++numInvocations > ReflectionFactory.inflationThreshold()) {
        // ★ 触发 Inflation
        MethodAccessorImpl acc = (MethodAccessorImpl)
            new MethodAccessorGenerator()
                .generateMethod(method.getDeclaringClass(),
                                method.getName(),
                                method.getParameterTypes(),
                                method.getReturnType(),
                                method.getExceptionTypes(),
                                method.getModifiers());
        parent.setDelegate(acc);    // ★ 替换 delegate
        return acc.invoke(obj, args);  // ★ 递归用 Generated 再调
    }

    return invoke0(method, obj, args);  // ★ native 方法
}
```

**阈值源** (`ReflectionFactory.java`)：
```java
private static int inflationThreshold = 15;   // 默认值
private static boolean noInflation = false;    // -Dsun.reflect.noInflation=true 时设 true
```

可通过 `-Dsun.reflect.inflationThreshold=N` 调整。设为 0 → 第一次就生成（跳过所有 native 路径），设为 `Integer.MAX_VALUE` → 永不 inflate（永远走 native）。

### 2.2 GeneratedMethodAccessor 的 bytecode 结构

生成的 `GeneratedMethodAccessor$N` 类是一个完整的 ClassFile，核心方法 `invoke()` 的字节码可反编译为：

```
public Object invoke(Object obj, Object[] args) throws ... {
    // arg1 (obj) → 强转为声明类
    // arg2 (args) → 传出参数表
    // 从 args[0], args[1], ... 中逐元素取出并 unbox
    // 调用 target.method(unboxed_args)
    // 将返回值 box 为 Object
}

对应的字节码结构:
aload_1                                // obj 参数
checkcast <declaring_class>            // ★ 类型转换
astore_3                               // 存到局部变量
aload_0                                // this
iconst_<idx>
aload_2                                // args 数组
aaload                                 // args[idx] → Object
checkcast <wrapper_class>              // ★ 包装类检查
invokevirtual <wrapper>.xxxValue()     // ★ 拆箱指令
iconst_<idx2> / iload_<idx2>           // 后续参数...
...
invokevirtual <target_method_ref>      // ★★★ 直接调用目标方法！
<box_return_value>                     // 如果返回类型是 primitive
areturn                                // 返回 boxed Object
```

**核心优势**：
- `invokevirtual <target_method_ref>` — 这是**真正的 JVM 字节码调用**，不经过 JNI，不经过 `ThreadInVMfromNative`
- JIT 可以内联整个生成的 `invoke()` 方法 → 最终变成直接调用 + 极少的拆箱/装箱指令
- 消去 Layer 2（delegation 虚调用）和 Layer 3（JNI 往返）

**Inflation 后剩余的开销**：Object[] 参数拆箱 + 返回值装箱 — 这是 API 契约决定的，无法消除。

### 2.3 ClassDefiner 和 Unsafe.defineAnonymousClass

`GeneratedMethodAccessor` 通过 `Unsafe.defineAnonymousClass(hostClass, bytecode, cpPatches)` 注册。和普通 `defineClass` 的区别：

| 维度 | defineClass | defineAnonymousClass |
|------|-----------|---------------------|
| 生命周期 | 绑定到 ClassLoader | 绑定到 host class（method 的 declaring class） |
| GC 行为 | ClassLoader 存活 → class 不回收 | host class 被 GC → anonymous class 可回收 |
| 名称 | 类加载器命名空间可见 | `hostClass/GeneratedMethodAccessor$N` — JVM 内部命名 |
| 用途 | 通用类加载 | 反射 inflation、Lambda 表达式 |

**为什么是 anonymous class 而不是 defineClass？** 如果每个反射目标方法都用一个普通 defineClass → 每次 inflation 创建一个新的 ClassLoader 命名空间条目 → ClassLoader 的 class list 无限增长 → ClassLoader 无法 GC → 内存泄漏。Anonymous class 的生命周期绑定到 host class → 当 method mirror 对象可回收时 → 生成的 accessor class 也可回收 → 避免泄漏。

### 2.4 noInflation 标志

`-Dsun.reflect.noInflation=true` 时：
- `ReflectionFactory.noInflation` 设为 `true`
- 所有 MethodAccessor 在**首次创建时就生成** GeneratedMethodAccessor
- 完全跳过 native 路径 → 对反射密集型应用（如 Spring、Hibernate）大幅提升性能
- 代价：启动时一次性生成所有反射 method 的 bytecode class → Metaspace 占用增加

### 2.5 C++ 侧的安全栈扫描识别

`reflectionAccessorImplKlassHelper.cpp:100-103` 的 `is_generated_method_accessor()`：

```cpp
bool ReflectionAccessorImplKlassHelper::is_generated_method_accessor(InstanceKlass* ik) {
  // 检查 ik 的名称是否匹配 GeneratedMethodAccessor$N 模式
  // 或检查 ik 的 host class 是否为 MethodAccessorGenerator 的宿主
}
```

此函数在**安全栈扫描**中被调用——当 JVM 遍历调用栈以确定访问权限时，遇到 GeneratedMethodAccessor 的 invoke() 帧会跳过它，继续向上查找原始调用者。否则 `Reflection.getCallerClass()` 会返回 GeneratedMethodAccessor 自己，导致权限检查失效。

---

## §三 ★★★ 参数拆箱 — 反射开销的"三王"之一

### 3.1 unbox_for_primitive() 逐行拆解

```cpp
// reflection.cpp:106-112
BasicType Reflection::unbox_for_primitive(oop box, jvalue* value, TRAPS) {
  if (box == NULL) {
    THROW_(vmSymbols::java_lang_IllegalArgumentException(), T_ILLEGAL);
    // ① null check → 如果是 null 但形参是 int → IAE
  }
  return java_lang_boxing_object::get_value(box, value);
  // ② get_value() 内部:
  //    → check klass of box object
  //       (box->klass() == java.lang.Integer::klass()
  //        || box->klass() == java.lang.Long::klass()
  //        || ...)
  //    → read value field: box->int_field(_value_offset)
  //       (或 long_field, float_field 等)
  //    → store to jvalue*
}
```

**每次 Integer→int 拆箱的 4 步操作**：
1. NULL check → `box == NULL` 比较 + 条件分支
2. klass check → `box->klass()` oop 解引用 → 和 `Integer::klass()` 比较
3. field read → `box->int_field(_value_offset)` — 读堆上 int 字段（offset-based）
4. store → `value->i = result` — 写入 jvalue

**直接调用完全不需要这 4 步** — `int x = 42` 在字节码层就是 `bipush 42` 或 `iconst_0` 等常量指令，或者已在局部变量表中。

### 3.2 widen() 的类型转换矩阵

```cpp
// reflection.cpp:120-178+
void Reflection::widen(jvalue* value, BasicType current_type, BasicType wide_type, TRAPS) {
  switch (wide_type) {
    case T_BYTE:    break;  // 不合法 → throw IAE
    case T_SHORT:   if (current_type==T_BYTE) value->s=(jshort)value->b; return;
                    break;  // 其他类型 → throw IAE
    case T_INT:     if (current_type==T_BYTE)  value->i=(jint)value->b; return;
                    if (current_type==T_CHAR)  value->i=(jint)value->c; return;
                    if (current_type==T_SHORT) value->i=(jint)value->s; return;
                    break;
    case T_LONG:    if (current_type==T_BYTE)  value->j=(jlong)value->b; return;
                    if (current_type==T_CHAR)  value->j=(jlong)value->c; return;
                    if (current_type==T_SHORT) value->j=(jlong)value->s; return;
                    if (current_type==T_INT)   value->j=(jlong)value->i; return;
                    break;
    case T_FLOAT:   if (current_type==T_BYTE)  value->f=(jfloat)value->b; return;
                    // ... 更多类型对 ...
    case T_DOUBLE:  if (current_type==T_BYTE)  value->d=(jdouble)value->b; return;
                    // ... 更多类型对 ...
  }
  // 如果走到这里 → 类型对不合法 → throw IllegalArgumentException
  THROW_MSG(vmSymbols::java_lang_IllegalArgumentException(), "argument type mismatch");
}
```

支持的类型提升方向：byte→short→int→long→float→double 和 char→int→long→float→double。注意：int→short 是非法的（窄化），直接抛 IAE。

**开销**：两次 switch 语句（外层 wide_type 选择，内层 current_type 匹配）→ 编译器生成跳转表 → ~10-20 cycles（按最差路径计，如 float→double 需经过 6 个 case 的穿透）。

### 3.3 JavaCallArguments::push_*()

```cpp
// push_int/push_long/push_float/push_double/push_oop
// 最终都调用 GrowableArray<T>::append()
void JavaCallArguments::push_int(jint value) {
  _parameters->append((intptr_t)value);
  // append() 内部:
  //   ① if _len == _max → grow(_max*2) → allocate + copy
  //   ② _data[_len++] = value
}
```

正常情况下 `method->size_of_parameters()` 已预先分配好空间 → append 不触发扩容 → 开销为 1 次数组写 + 长度自增 = ~5 cycles。

### 3.4 Object 参数和 primitive 参数的拆箱对比

| 操作 | Primitive 参数 (如 Integer → int) | Object 参数 |
|------|--------------------------------|-----------|
| null check | ✅ 抛 IAE | ❌ 允许 null |
| klass check | ✅ `box->klass() == Wrapper::klass()` | ✅ `arg->is_a(k)` |
| 值提取 | 读 value 字段 (int_field) | 直接 push oop |
| Handle 创建 | ❌ (jvalue 在栈上) | ✅ `Handle arg_handle(THREAD, arg)` |
| push 操作 | push_int / push_long / ... | push_oop(arg_handle) |
| **总开销** | null + klass + field + push ≈ 15-20 cycles | klass + handle + push ≈ 25-30 cycles |

### 3.5 ★ 5 个 int 参数反射调用的完整开销计算

**场景**：反射调用 `int add(int a, int b, int c, int d, int e)`

**直接调用**（JIT 编译后）：
```
mov  edi, DWORD PTR [rsi+0xc]    // a = args[0]
mov  edx, DWORD PTR [rsi+0x10]   // b = args[1]
mov  ecx, DWORD PTR [rsi+0x14]   // c = args[2]
...
call <add_method>                 // 直接跳转
// 总计: 5 mov + 1 call = ~10 cycles
```

**反射调用**（5 个 int 参数的拆箱循环）：
```
// ↓ 以下是对 Layer 3-5 的一次反射调用的开销累加
Layer 3: JVM_InvokeMethod 入口
  ThreadInVMfromNative ctor     ≈ 100 cycles
  Handle×3 创建                  ≈ 15 cycles
Layer 4: invoke_method
  7 次 oop 字段读                ≈ 21 cycles (7×3, 假设 L1 hit)
  slot() int字段读               ≈ 3 cycles
  method_with_idnum() 数组索引   ≈ 5 cycles
Layer 5: invoke()
  ResourceMark rm               ≈ 5 cycles
  5 次参数拆箱循环:
    每次: type_mirror obj_at     ≈ 3 cycles
           arg obj_at            ≈ 3 cycles
           is_primitive() check  ≈ 3 cycles
           unbox_for_primitive:
             null check          ≈ 1 cycle
             klass check         ≈ 3 cycles (oop deref + compare)
             field read          ≈ 3 cycles
           push_int              ≈ 5 cycles
    小计每参数:      ≈ 21 cycles
    5 参数合计:      ≈ 105 cycles
  JavaCallArguments 构造         ≈ 5 cycles
  JavaCalls::call → call_stub   ≈ 200 cycles (汇编桩 + 解释器入口)
  HAS_PENDING_EXCEPTION check   ≈ 1 cycle (fast path: no exception)
  box(rvalue, rtype)            ≈ 20 cycles (int→Integer 装箱)
Layer 3 dtor:
  HandleMarkCleaner dtor        ≈ 5 cycles
  ThreadInVMfromNative dtor     ≈ 40 cycles (trans_and_fence)

总计: 100+15+21+3+5+5+105+5+200+1+20+5+40 = ~525 cycles
```

**对比**：直接调用 ~10 cycles vs 反射 ~525 cycles → **约 50 倍差距**。这是单个 `add()` 的情况——实际方法越长，相对差距越小（方法本身的执行时间压倒了反射固定开销）。这就是"反射慢 **2-100 倍**"的范围来源：方法越短，反射开销占比越大。

---

## §四 ★★ 反射基础设施 — slot、override、method lookup

### 4.1 java_lang_reflect_Method::slot() 的 O(1) 魔法

**完整查找链**：

```
java.lang.reflect.Method 对象 (堆上)
  ├─ clazz: mirror (oop)     — 声明类的 Class 对象
  ├─ slot: int               — ★ 在 InstanceKlass::methods() 数组中的索引
  ├─ name: String            — 方法名
  ├─ parameterTypes: Class[] — 参数类型
  ├─ returnType: Class       — 返回类型
  └─ override: byte          — 访问控制绕过标志

// javaClasses.cpp:2773-2776 — slot() 实现
int java_lang_reflect_Method::slot(oop reflect) {
  return reflect->int_field(slot_offset);
  // ↓ 展开:
  // *(int*)((address)reflect + slot_offset)   ← 纯指针运算, 无 GC barrier
}

// reflection.cpp:1277 — 使用时
Method* m = klass->method_with_idnum(slot);
// ↓ 展开:
// klass->methods()->at(slot)                  ← 数组索引, O(1)
```

`slot_offset` 由 [04]§四 预计算——JVM 初始化时 `java_lang_reflect_Method::compute_offsets()` 一次性扫描 `java.lang.reflect.Method` 的字段布局，将 slot 字段的偏移量存入全局静态变量 `slot_offset`（`javaClasses.cpp:4212`）。此后所有 `slot()` 调用都是 offset-based 直接内存读取——全程 O(1)、无方法调用、无 GC barrier。

**为什么存 int 索引而不是 Method* 指针？**
- Method* 是 C++ 堆指针（Metaspace），oop 是 Java 堆指针
- GC 不会移动 Metaspace，但 Method* 在 **类重定义（redefine）时可能被替换**
- 如果 mirror 对象存 Method* 指针 → redefine 时需更新所有 mirror 对象的指针 → 代价极高
- 存 int 索引 → redefine 时 Method* 指针会变，但索引不变（只要方法表大小不变）→ 实时查找总是得到最新指针

**slot 值从哪来？** `Reflection::new_method()`（`reflection.cpp:864-925`）：

```cpp
// L870: int slot = method->method_idnum();                ← ★ 取 Method 在 methods() 中的索引
// L894: java_lang_reflect_Method::set_slot(mh(), slot);   ← ★ 写入 mirror 的 slot 字段
```

`set_slot()`（`javaClasses.cpp:2778-2781`）：
```cpp
void java_lang_reflect_Method::set_slot(oop reflect, int value) {
  reflect->int_field_put(slot_offset, value);  // 纯 offset 写入
}
```

本文只解释 slot 值从哪来（`Reflection::new_method()` 中设置）和为什么是 int 索引而非 Method* 指针。`slot_offset` 的**预计算机制**（`compute_offsets()` 的触发时机、`FIELD_COMPUTE_OFFSET` 宏展开、字段扫描流程）详见 [04]§四——那是 JVM 初始化时一次性完成的，此处不重复。

### 4.2 override 标志的语义和每次调用的代价

`override` 字段是 `java.lang.reflect.AccessibleObject` 上的一个 `boolean` 字段（在 mirror 对象中）。`setAccessible(true)` 将其设为 `true`。

**每次反射调用都必须读它** (`reflection.cpp:1265`)：
```cpp
bool override = java_lang_reflect_Method::override(method_mirror) != 0;
```

即使 `override==true`（已经 `setAccessible`），这个 `obj_field` 读操作仍然执行——因为 JVM 无法证明 heap 上的这个字段不会改变（在 C2 的逃逸分析范围之外）。每次反射调用多一次 oop 字段解引用。

### 4.3 Reflection::invoke_method 的 7 步操作

（已在 §1.4 中展开，此处总结）

```
Step 1: mirror = clazz(method_mirror)                    — obj_field read
Step 2: slot = slot(method_mirror)                       — int_field read   [★ O(1) magic]
Step 3: override = override(method_mirror) != 0          — byte_field read
Step 4: ptypes = parameter_types(method_mirror)           — obj_field read
Step 5: rtype = parse return_type                        — basic type mapping
Step 6: klass = InstanceKlass::cast(as_Klass(mirror))    — Klass* conversion
Step 7: m = klass->method_with_idnum(slot)               — array index lookup
```

共 **6 次 oop 字段读 + 1 次 int 字段读 + 1 次 Klass* 转换 + 1 次数组索引**。直接调用的对应步骤：0 次——编译时已 resolve 的方法引用在常量池中。

### 4.4 和 VM_RedefineClasses 的冲突

[09-03] 的 `VM_RedefineClasses` 可以在运行时替换类的方法表内容。新方法的 `Method*` 指针不同，但索引不变。`slot()` 返回的索引仍然指向正确位置 → 反射调用自动获得最新版本的方法。

**风险**：如果 redefine 删除了方法 → `method_with_idnum(slot)` 返回 NULL → `reflection.cpp:1278-1280` 抛出 `InternalError("invoke")`。如果 redefine 增加了方法 → slot 索引可能超出数组范围 → 同上。

---

## §五 ★★ 异常处理 — InvocationTargetException 的代价

### 5.1 异常检测点

```cpp
// reflection.cpp:1232
JavaCalls::call(&result, method, &java_args, THREAD);

// reflection.cpp:1234
if (HAS_PENDING_EXCEPTION) {
    // ★ 目标方法抛了异常
    oop target_exception = PENDING_EXCEPTION;       // ① 读 thread->_pending_exception → oop
    CLEAR_PENDING_EXCEPTION;                         // ② thread->_pending_exception = NULL
    if (THREAD->is_Java_thread()) {
        JvmtiExport::clear_detected_exception((JavaThread*)THREAD);  // ③ JVMTI 状态清理
    }
    JavaCallArguments args(Handle(THREAD, target_exception));  // ④ 创建 Handle 包装原异常
    THROW_ARG_0(vmSymbols::java_lang_reflect_InvocationTargetException(),  // ⑤ 构造 + throw
                vmSymbols::throwable_void_signature(),
                &args);
}
```

### 5.2 InvocationTargetException 构造 + THROW_ARG_0

异常包装路径分配的对象：
1. `InvocationTargetException` 实例（新对象分配，可能在 TLAB 中）
2. 原异常作为 target 字段存储在 ITE 中（不分配新对象，只是引用传递）
3. `THROW_ARG_0` 宏展开 → 调用 `Exceptions::_throw_msg()` → 设置 `thread->_pending_exception = ite_oop`

**直接调用的异常路径**：只有目标方法分配的异常对象 → 0 次包装。

### 5.3 JVMTI 的 clear_detected_exception 清理

```cpp
// reflection.cpp:1240-1242
if (THREAD->is_Java_thread()) {
    JvmtiExport::clear_detected_exception((JavaThread*)THREAD);
}
```

**时序**：
1. 目标方法抛出异常 → JVMTI 的 `ExceptionThrow` 事件在目标方法栈帧上触发 → JVMTI agent 记录此异常
2. 但此异常马上被 `CLEAR_PENDING_EXCEPTION` 清除
3. 新异常 `InvocationTargetException` 被设置
4. 如果不清除 JVMTI 的 detected exception 状态 → JVMTI agent 会认为"异常仍然在传播"但实际已被替换 → 重复报告或不正确的异常追踪
5. `clear_detected_exception` 重置 JVMTI 的异常追踪状态 → 新异常可以正确触发新一轮的 `ExceptionThrow` 事件

---

## §六 ★★ 和 [09-04][09-01] 的交叉验证

### 6.1 JVM_InvokeMethod 的 JVM_ENTRY 宏

`JVM_InvokeMethod`（`jvm.cpp:3612`）使用 `JVM_ENTRY` 宏，展开细节见 [04]§一——注入 `ThreadInVMfromNative`、`HandleMarkCleaner`、`THREAD` 别名，全程一致。

从反射视角看，这个 JVM_ENTRY 有两个独特之处：

**① 创建 Handle 数量 ≥ 3-4 个**：`method_handle`（L3618）、`receiver`（L3619）、`objArrayHandle args`（L3620），加上 JVMTI 回调中临时的 `ret_type` Handle（L3626-3629）。比典型的简单 JVM_ENTRY（如 `JVM_GC` 的 0 个）多了不少——每个 Handle 在 HandleArea 中分配，累积开销见 [04]§一.1.7。

**② 对反射调用额外的状态转换影响**：`ThreadInVMfromNative` ctor 的 `poll()`（详见 [01]§二）在每次反射调用入口都执行一次。如果 JVM 正处 safepoint → poll() 返回 true → 线程 block 直到 safepoint 结束。这不会发生在直接调用中——直接调用在 `_thread_in_Java` 中，safepoint 的 begin 阶段已经 block 了线程。

**③ dtor 的返回保护**：`JVM_END` → `~ThreadInVMfromNative()` → `trans_and_fence(_vm, _native)` → `block_if_requested` 再次检查——保证返回 native 前不带着中间态。

### 6.2 slot() 的 offset 预计算（[09-04]§四 承接）

```
[09-04]§四 讲解了:
  javaClasses.cpp 的 compute_offsets() 在 JVM 初始化时
  → 扫描 java.lang.reflect.Method 类
  → 找到 slot 字段的偏移
  → 存入全局静态变量 slot_offset (javaClasses.cpp:4212)

本文的应用:
  reflection.cpp:1264 → java_lang_reflect_Method::slot(method_mirror)
  → method_mirror->int_field(slot_offset)
  → 一次 offset-based 读 → 返回 int → 作为 methods() 数组索引
  → 全程无 GC barrier、无方法调用
```

### 6.3 Handle 生命期管理（[09-02] 对比）

| 维度 | JVM_InvokeMethod 内的 Handle | [09-02] 的 JNIHandleBlock |
|------|---------------------------|--------------------------|
| 存储位置 | 线程的 HandleArea (Arena) | JNIHandleBlock._handles[] (CHeapObj) |
| 管理方式 | HandleMarkCleaner → pop_and_restore | LocalRef → DeleteLocalRef / PopLocalFrame |
| 生命周期 | JVM_ENTRY 作用域内 | 当前 native frame 内 |
| 从 jobject 创建 | `Handle(THREAD, JNIHandles::resolve(jobject))` | `make_local(oop)` — 直接在 block 中分配 |

### 6.4 反射调用中的 ThreadInVMfromNative（[09-01]§二）

每次 `Method.invoke()` → `invoke0()` → `JVM_InvokeMethod` → `JVM_ENTRY` → `ThreadInVMfromNative` ctor → `transition_from_native()`。

如果 JVM 在反射调用到达时正处于 safepoint → `poll()` 返回 true → `check_safepoint_and_suspend_for_native_trans()` → `block()` → 线程阻塞直到 safepoint 结束。这与直接调用在 `_thread_in_Java` 中 poll safepoint 的行为完全一致——只是反射多走了一层 `_thread_in_native→_thread_in_vm` 的状态转换。

---

## §七 GDB 验证 + 可证伪断言（≥12 条）

### 断言 1：JVM_InvokeMethod 的断点命中 → 验证 ThreadInVMfromNative 已构造
```
(gdb) br jvm.cpp:3612
(gdb) cond 1 (int)thread->thread_state() == 6
# 条件：线程已在 _thread_in_vm(6) 中 → ThreadInVMfromNative ctor 已执行完毕
(gdb) p thread->thread_state()
# 预期输出: $1 = _thread_in_vm  (=6)
```

### 断言 2：reflection.cpp:1264 的 slot() 返回值 → InstanceKlass::methods() 数组索引
```
(gdb) br reflection.cpp:1264
(gdb) commands
> silent
> p slot
> p *((InstanceKlass*)klass)->methods()->at(slot)
> c
> end
# 预期：slot 为非负整数，methods()->at(slot) 返回的非 NULL Method* 的 name() 匹配目标方法
```

### 断言 3：reflection.cpp:1232 JavaCalls::call 的调用栈深度
```
(gdb) br reflection.cpp:1232
(gdb) bt
# 预期调用栈 (≥6 层):
# #0  invoke() at reflection.cpp:1232
# #1  Reflection::invoke_method at reflection.cpp:1283
# #2  JVM_InvokeMethod at jvm.cpp:3619
# #3  invoke0 (JNI native frame)
# #4  NativeMethodAccessorImpl.invoke() at NativeMethodAccessorImpl.java
# #5  Method.invoke() at Method.java
# #6  main / user code
```

### 断言 4：JVM_InvokeMethod 内创建的 Handle 数量
```
(gdb) br jvm.cpp:3614
(gdb) p thread->handle_area()→_hwm   # 记下当前 HandleArea high-water mark
(gdb) br jvm.cpp:3630                # return res 之前
(gdb) p thread->handle_area()→_hwm   # 期望比上次多了 3-4 个 Handle's worth 的偏移
# (每个 Handle 约占 1 个 oop* = 8 bytes)
```

### 断言 5：Inflation 阈值变更验证
```
# Java 程序:
# Method m = MyClass.class.getMethod("someMethod", ...);
# for (int i = 0; i < 20; i++) { m.invoke(obj); }

# JVM 参数: -Dsun.reflect.inflationThreshold=3
# 预期：第 4 次 invoke() 开始使用 GeneratedMethodAccessor
(gdb) br NativeMethodAccessorImpl.invoke
(gdb) cond 2 this.numInvocations == 4
# 第 4 次调用 → numInvocations 应是 4 → inflation 已在第 4 次触发
```

### 断言 6：GeneratedMethodAccessor 的类名验证
```
(gdb) # 在 Inflation 发生后打断点
(gdb) # 用 jmap 或 class_stats 查看:
# jcmd <pid> VM.class_hierarchy | grep GeneratedMethodAccessor
# 预期输出: .../GeneratedMethodAccessor$1 (或 $N)
```

### 断言 7：unbox_for_primitive 的 klass check 验证
```
(gdb) br java_lang_boxing_object::get_value
(gdb) commands
> silent
> p box->klass()
> p java_lang_Integer::klass()
> # 如果 arg 是 Integer → box->klass() == Integer::klass() → 应相等
> c
> end
```

### 断言 8：override 字段值在 setAccessible(true) 前后的变化
```
# Java 程序:
# Method m = MyClass.class.getMethod("foo");
# m.setAccessible(true);
# m.invoke(obj);  ← 在这里断点
(gdb) br reflection.cpp:1265
(gdb) p override
# 预期: override == 1 (true)
# 如果没有 setAccessible → override == 0 (false)
```

### 断言 9：参数拆箱循环的迭代次数 == ptypes 数组长度
```
(gdb) br reflection.cpp:1191
(gdb) p args_len
(gdb) p ptypes->_length
# 预期: args_len == ptypes->_length (两者相等)
# 循环条件: i < args_len → 迭代次数 = args_len
```

### 断言 10：InvocationTargetException 被抛出时 → PENDING_EXCEPTION 被先清除再设新异常
```
(gdb) br reflection.cpp:1236
(gdb) p target_exception           # 原异常 oop
(gdb) p thread->_pending_exception # 应在 L1237 已被清除 → NULL
(gdb) br reflection.cpp:1247       # THROW_ARG_0 之后
(gdb) p thread->_pending_exception # 设为 InvocationTargetException 实例
```

### 断言 11：JavaCallArguments 存储的参数数量和 method->size_of_parameters() 一致
```
(gdb) br reflection.cpp:1226
(gdb) p java_args.size_of_parameters()
(gdb) p method->size_of_parameters()
# 预期: 两者相等 (assert 验证)
```

### 断言 12：JVM_InvokeMethod 入口时 method_handle 不是 NULL
```
(gdb) br jvm.cpp:3619
(gdb) p method_handle.is_null()
# 预期: false — method mirror 在 Layer 1 已保证非 NULL
(gdb) p receiver.is_null()
# 可能为 true (static 方法)
```

### 可证伪断言

1. **如果 inflation 被禁用（-Dsun.reflect.noInflation=true）→ 第 100 次调用仍然走 GeneratedMethodAccessor** —不会走 NativeMethodAccessorImpl。即使阈值无用，也全程 Generated。
2. **如果 inflation 被禁用（-Dsun.reflect.inflationThreshold=Integer.MAX_VALUE）→ 第 1000 次调用仍然走 NativeMethodAccessorImpl** — `numInvocations > MAX_VALUE` 永远为 false → 永不 inflate。
3. **反射调用检查 override 标志时 → 不论标志是 true 还是 false → 都执行了字段读取操作** — 断点在 `reflection.cpp:1265`，执行 `si` 验证进入 `java_lang_reflect_Method::override()` 内部。
4. **如果 Method.invoke() 返回后检查 slot → 和构造时的 slot 值相同（除非 redefine 改变方法表）** — 两次 `java_lang_reflect_Method::slot(mirror)` 返回相同值。
5. **-Dsun.reflect.inflationThreshold=0 → 第一次调用就 inflate → 类名包含 GeneratedMethodAccessor$1** — 验证立即生成行为。

---

## 文档版本

- **v1.0** — 完整 6 层调用路径泳道图、Inflation 机制详解、参数拆箱逐行分析、InvocationTargetException 异常包装、GDB 可证伪断言 12 条、交叉引用 [09-04]§一 和 §四
