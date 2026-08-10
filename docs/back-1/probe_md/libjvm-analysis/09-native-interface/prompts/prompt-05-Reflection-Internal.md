# PROMPT: 请撰写 05-Reflection-Internal.md

## 一、任务

撰写一篇深度的 JVM 源码分析文档，主题：**Reflection Internal — `Method.invoke()` 的 6 层调用路径、每层开销分析、MethodAccessor Inflation 机制、以及反射比直接调用慢 10-100 倍的根本原因**

### 核心故事线（禁止做源码翻译机！）

[09-04] 拆解了 `JVM_ENTRY` 宏系统——每当你看到 `JVM_ENTRY(jobject, JVM_InvokeMethod(...))`，你就知道 `ThreadInVMfromNative` RAII 被构造、`HandleMarkCleaner` 保护了 Handle 作用域、`JNIHandles::make_local()` 把 oop 转成 jobject。但 [09-04] 的工作到此为止——它解释了"入口"的设计，没有回答"进入之后发生什么"。

**本文的任务就是追踪 `JVM_InvokeMethod` 进入之后的完整旅程**：从 Java 层的 `Method.invoke()` 到 JNI 层的 `JVM_InvokeMethod`，到 C++ 层的 `Reflection::invoke_method`，到最底层的 `JavaCalls::call` → `StubRoutines::call_stub()` → 字节码执行。一共 **6 层**（不是 4 层，不是 3 层——每层都有自己的"减速带"）。

但本文不只是在做"调用链梳理"——那是最低级的知识输出。本文的真正价值在于**逐层回答"为什么慢"**：
- Layer 1-2（Java）：MethodAccessor 委派链 → 多一次虚调用；访问检查 → `Reflection.getCallerClass()` → `checkAccess()` → 每次调用都查 `override` flag → 即使 cache 了也浪费指令
- Layer 3（JNI native）：`invoke0()` 是 native 方法 → 触发 `native method entry` 的 `ThreadInVMfromNative` → Handle 创建（6 个 Handle/每次调用：method_handle, receiver, args array, parameter_types handle, return_type handle）→ 每个 Handle 是一次 `HandleArea` 分配
- Layer 4-5（C++ VM）：`Reflection::invoke_method` → `java_lang_reflect_Method::slot()`（查 InstanceKlass::methods() 数组）→ `reflected_method->is_static()` → `override` 检查 → 参数类型提取 → `unbox_for_primitive()`（每个参数拆箱 1 次）→ `widen()`（类型提升可能再做 1 次数值转换）→ 创建 `JavaCallArguments`（堆分配 1 次）→ 把 `Object[]` 中的每个元素 push 到 `JavaCallArguments`（每个参数一次 push_int/push_oop/push_long...）
- Layer 6（调用执行）：`JavaCalls::call` → `call_helper` → `StubRoutines::call_stub()`（一段汇编）→ 最终执行字节码

**对比直接调用**：javac 编译出 `invokevirtual` 字节码 → 解释器直接 dispatch → JIT 可以内联 → **0 层额外开销**（除了方法本身的计算）。

**Inflation 机制是本文的"aha moment"**：前 15 次反射调用走 `NativeMethodAccessorImpl`（每一层开销都付），第 16 次开始走 `GeneratedMethodAccessor`——JVM 在运行时生成一小段 bytecode class（一个完整的 `.class` 文件结构！），用 `invokevirtual` 直接调用目标方法。生成的 bytecode class 消去了 Layer 2（MethodAccessor 委派）和 Layer 3（JNI native 往返）的开销——但仍然要付参数打包/拆包的代价（Object[] 不可消除）。

### 核心叙事线

1. **★ 6 层完整调用路径 — 每层代码位置 + 每层的"减速带"** — 不要只贴"这里调那里"。每层必须回答：(a) 这层消耗了什么资源（CPU 指令？内存分配？状态转换？），(b) 直接调用有没有这一层？(c) 这层能否被 JIT 优化掉？**精确定位**：
   - Layer 1: `java.lang.reflect.Method.invoke()` — [JDK 源码，不在 HotSpot 中] — 调用 `ma.invoke(obj, args)`
   - Layer 2: `NativeMethodAccessorImpl.invoke()` — [JDK 源码] — 检查 inflate 阈值（`++numInvocations > 15`），有则触发 inflation → invoke0()
   - Layer 3: `invoke0()` → `JVM_InvokeMethod` — `jvm.cpp:3612-3634` — JVM_ENTRY 宏构造 ThreadInVMfromNative + HandleMarkCleaner
   - Layer 4: `Reflection::invoke_method()` — `reflection.cpp:1259-1284` — `java_lang_reflect_Method::slot()` 从 oop 找 Method*
   - Layer 5: `invoke()` (static helper) — `reflection.cpp:1075-1253` — 参数拆箱 + 类型展开 + JavaCallArguments 构造
   - Layer 6: `JavaCalls::call()` → `call_helper()` → `StubRoutines::call_stub()` — 进入解释器/编译代码
   **★ 关键发现：`Method::invoke()` 不存在于 HotSpot 中** — 搜索 2469 行的 `method.cpp` 无此函数。调用走 `JavaCalls::call()` 路径——这是 Java 调用约定（`JavaCallArguments` + `JavaValue`），不是 Method 对象上的成员函数。

2. **★★ Inflation 机制 — 为什么是 15？生成的是什么？** — `NativeMethodAccessorImpl` 第 49 行：`if (++numInvocations > ReflectionFactory.inflationThreshold())` → `ReflectionFactory.java:88` 默认值 = 15（可通过 `-Dsun.reflect.inflationThreshold=N` 调整）。触发后：`MethodAccessorGenerator.generateMethod()` 生成一个 `GeneratedMethodAccessor$N` 类（实为 JVM 通过 ClassDefiner 动态定义的一个 .class 字节数组，内含 `invoke()` 方法用的是 `invokevirtual` 字节码直接调目标方法）。追问：**生成的 bytecode class 长什么样？** → 它是一个完整的 `ClassFile` 结构（magic 0xCAFEBABE + version + constant_pool + method `invoke`），`invoke()` 方法体是：`aload_1; checkcast; aload_0; iconst_0; aload_2; <typed_aload>; invokevirtual <target>; <box return>; areturn`。追问：**为什么是 15 不是 10？** → 经验值——15 次调用就值得花生成 bytecode class 的成本（约 1ms）。如果设为 0 → 永远走 Native → 最慢。如果设为 1 → 第一次就生成 → 对一次性调用浪费了生成开销。

3. **★★★ 参数拆箱是开销之王 — Object[] 为什么不可消除？** — `reflection.cpp:1191-1223`：对 `Object[] args` 中的每个参数 → 取出 `type_mirror` → 如果是 primitive → `unbox_for_primitive()`（拆箱：Integer → int, Long → long...）→ 检查类型匹配 → `widen()` 如果需要类型提升 → `push_int/push_long/push_float...` 存入 `JavaCallArguments`。如果是对象 → `push_oop(get_handle(arg))`。**这个循环对每个参数执行** — 如果方法有 5 个 int 参数 → 5 次 unbox + 5 次 push。直接调用：`iload_1; iload_2; iload_3; iload_4; iload_5; invokevirtual` — 参数已经在局部变量表里，零拆箱。追问：**unbox_for_primitive() 内部做了什么？** → `reflection.cpp:106-112`：`if (arg == NULL) THROW_0(NullPointerException)` → 检查 `arg->klass()` 是否为对应的 wrapper 类（如 `java.lang.Integer`）→ 如果不是 → `IllegalArgumentException` → 如果是 → 提取 `value` 字段（可能走 `int_field()` 直接读偏移）→ 返回 jvalue。这就是"一次拆箱 = 一次 klass 检查 + 一次字段读取 + 一次 null 检查"。

4. **★★ `java_lang_reflect_Method::slot()` 的魔法 — 为什么 JVM 能 O(1) 从 Method 对象找到 C++ Method*** — `javaClasses.cpp` 的 `compute_offsets()` 在 JVM 初始化时扫描 `java.lang.reflect.Method` 类 → 找到 `slot` 字段的偏移 → 存为全局静态变量 `java_lang_reflect_Method::_slot_offset`。`reflection.cpp:1264` 调用 `java_lang_reflect_Method::slot(method_mirror)` → 内部是 `method_mirror->int_field(_slot_offset)` — 一次 offset-based 读取出 int 值 → 然后 `klass->method_with_idnum(slot)` 在 `InstanceKlass::methods()` 数组中 O(1) 索引。**全程无 GC barrier、无方法调用**。追问：**slot 值从哪来？** → 在 `reflection.cpp:864-925` 的 `Reflection::new_method()` 中——当 JDK 的 `Class.getDeclaredMethod()` 调用 → JVM 通过 JNI 返回一个 `java.lang.reflect.Method` 对象 → 构造时把 Method* 在 methods() 数组中的索引存入 slot 字段。这就是 [09-04]§四 提到的"字段偏移预计算基础设施"在反射中的直接应用。

5. **★★ `override` 标志的语义 — 不是"覆盖方法"是"绕过访问检查"** — `java.lang.reflect.Method.override` 字段（在 mirror 对象上）— 如果设置为 true（通过 `setAccessible(true)`）→ `reflection.cpp:1078` 的 `override` 参数传入 → 在 `invoke()` 内部（L1120+）影响访问检查：`if (!override) { Klass::check_access_for(...) } else { // skip check }`。**每次反射调用都读取这个字段** — 即使已经 setAccessible，仍然多了一次 oop 字段读取。追问：**为什么 JIT 不优化掉？** → override 字段在 heap 上（对象的字段），JIT 无法证明它不会改变 → 需要 GC barrier → 退化为每次调用都读。

6. **★★ `JavaCalls::call_helper` 的汇编桩 — 从 C++ 栈到 Java 栈的跳板** — `JavaCalls::call()`（`javaCalls.cpp:345`）→ `call_helper()`（L354）→ 构造 `JavaCallWrapper`（Handle/Resource/异常保护）→ `StubRoutines::call_stub()` (L450，一段汇编代码) → 汇编桩设置 Java 的 `sender_sp` → 跳到 `method->from_interpreted_entry()` → 解释器开始执行。**这是 C++ world 到 Java world 的"最后一跳"** — 此汇编桩不是反射专用的，`invokevirtual` 字节码的最终入口也走这里（解释器的 `TemplateTable::invokevirtual()` 里面）。反射只是走了一条更长的路到达这个入口。

7. **★★ 反射处理的异常包装 — InvocationTargetException 的特殊语义** — `reflection.cpp:1234-1247`：`JavaCalls::call()` 返回后检查 `HAS_PENDING_EXCEPTION` → 如果目标方法抛了异常 → `CLEAR_PENDING_EXCEPTION` → 构造 `InvocationTargetException(target_exception)` → `THROW_ARG_0(InvocationTargetException, ...)` 把原异常包装。**这额外多了一次异常对象分配和一次包装** — 直接调用不会做这个包装。追问：**JVMTI 在这个异常路径中有什么特殊处理？** → L1240-1242：如果当前线程是 JavaThread → `JvmtiExport::clear_detected_exception()` — 因为 JVMTI 已经报告了原异常，不清理会导致 JVMTI 重复报告。

### 禁止行为

- ❌ 把 6 层调用路径当作"函数调用列表"——每层必须标注它的"减速带"（具体消耗了什么资源），并和直接调用的对应环节对比
- ❌ 忽略 Inflation 的触发条件（numInvocations > 15）和生成物结构（一段 .class bytecode，不是 C 代码）
- ❌ 忽略参数拆箱循环（`reflection.cpp:1191-1223`）——这是反射开销最大的单点
- ❌ 不展开 `java_lang_reflect_Method::slot()` 的 O(1) 查找魔法——这是 [09-04]§四 的直接应用
- ❌ 忘记 `override` 标志的语义和每次调用的代价——它不是一次性的
- ❌ 忽略 [09-04] 的连接——`JVM_InvokeMethod` 的 JVM_ENTRY 宏展开已在 [09-04]§一 详细分析
- ❌ 不做和直接调用的逐环节对比表——这是读者理解"反射为什么慢"的唯一途径
- ❌ 忽略 InvocationTargetException 的异常包装开销——这不是"异常处理细节"，这是反射 API 的核心契约

### 要求行为

- ✅ **★ 6 层调用路径的完整泳道图** — 标注每层的类/函数名、源文件行号、线程状态（Java vs _thread_in_vm）、每层创建了多少 Handle
- ✅ **★ 每层开销的"减速带分析"** — 不是"慢"一个字，而是"多了一次 Klass 检查 + 一次字段偏移读 + 一个 Handle 分配"
- ✅ **★ Inflation 机制详解** — NativeMethodAccessorImpl 的计数器、阈值 15、GeneratedMethodAccessor 的 bytecode 结构、ClassDefiner 的类注册
- ✅ **★ 参数拆箱逐行分析** — `unbox_for_primitive()` → `widen()` → `push_*()` 的完整循环
- ✅ **★ 和直接调用的逐项对比表** — 6 层反射 vs 1 层直接调用，每列标注具体指令/操作
- ✅ **★ 和 [09-04] 的交叉引用** — `JVM_InvokeMethod` 的 JVM_ENTRY 宏、`slot()` 的 offset 预计算（[09-04]§四）、`HandleMarkCleaner` 的作用
- ✅ **★ GDB 可证伪断言 ≥10 条** — Inflation 阈值变更、slot 值验证、JVM_InvokeMethod 的 Handle 数量、JavaCalls::call 的调用栈层数
- ✅ **★ 生成的 bytecode class 的反编译分析** — 展示 GeneratedMethodAccessor 的 `invoke()` 方法字节码（反编译 java bytecode）

## 二、标准环境

- OpenJDK 11 slowdebug build
- `-Xms8g -Xmx8g -XX:+UseG1GC`
- 64 位 Linux x86
- ★ GDB 在 slowdebug build 中验证（`#ifdef ASSERT` 全部生效）

## 三、聚焦源文件

| # | 文件 | 完整路径 | 模块 | 核心方法/类（需验证行号） | 本文角色 |
|---|------|---------|------|---------------------|---------|
| 1 | `reflection.cpp` | `src/hotspot/share/runtime/reflection.cpp` | runtime | `invoke_method()`(:1259)、`invoke()`(:1075)、`invoke_constructor()`(:1287)、`unbox_for_primitive()`(:106)、`widen()`(:120)、参数拆箱循环(:1191-1223) | ★★★ 反射核心实现 — 调用路径 + 参数处理 |
| 2 | `jvm.cpp` | `src/hotspot/share/prims/jvm.cpp` | prims | `JVM_InvokeMethod`(:3612-3634)、`JVM_NewInstanceFromConstructor`(:3637-3647) | ★★ JVM 入口层 — [09-04] 的直接应用 |
| 3 | `nativeLookup.cpp` | `src/hotspot/share/prims/nativeLookup.cpp` | prims | `NativeLookup::lookup()`(:539)、`lookup_entry()`(:334)、`base_library_lookup()`(:555) | ★★ native 方法绑定 — invoke0() 如何找到 JVM_InvokeMethod |
| 4 | `javaCalls.cpp` | `src/hotspot/share/runtime/javaCalls.cpp` | runtime | `JavaCalls::call()`(:345)、`call_helper()`(:354)、`StubRoutines::call_stub()`(:450) | ★★ C++→Java 汇编桩 — 最后一跳 |
| 5 | `javaClasses.cpp` | `src/hotspot/share/classfile/javaClasses.cpp` | classfile | `compute_offsets()`（java_lang_reflect_Method::slot 的偏移计算）、`java_lang_reflect_Method::slot()` | ★★ 字段偏移预计算 — [09-04] 前瞻 |
| 6 | `javaClasses.hpp` | `src/hotspot/share/classfile/javaClasses.hpp` | classfile | `java_lang_reflect_Method` 类的 `slot`/`clazz`/`override` 访问器 | ★ 字段访问器定义 |
| 7 | `reflectionAccessorImplKlassHelper.cpp` | `src/hotspot/share/classfile/reflectionAccessorImplKlassHelper.cpp` | classfile | `is_generated_method_accessor()`(:100-103) — C++ 侧检测 GeneratedMethodAccessor | ★ Inflation 后类识别 |
| 8 | `NativeMethodAccessorImpl.java` | `jdk/src/java.base/share/classes/jdk/internal/reflect/NativeMethodAccessorImpl.java` | JDK | `invoke()`(:43) — inflation 检查、`invoke0()`(:62/69) — native 声明 | ★★ Inflation 触发器 + native 入口声明 |
| 9 | `ReflectionFactory.java` | `jdk/src/java.base/share/classes/jdk/internal/reflect/ReflectionFactory.java` | JDK | `inflationThreshold`(:88, 默认 15)、`noInflation`(:87) | ★ Inflation 参数配置 |

**跨模块说明**：反射的调用路径跨 5 个模块 — JDK(java.lang.reflect) → prims(jvm.cpp:JVM_InvokeMethod) → runtime(reflection.cpp:invoke_method) → runtime(javaCalls.cpp:call → call_stub) → interpreter/compiler。每个模块转换都意味着一次架构边界穿越。

## 四、必须深度走读的核心概念

> 以下不是答案——是必须从源码中挖掘答案的问题列表。每道题先定位源文件行号，再回答"为什么"，最后用 3-5 行关键源码做引证。

### 4.1 ★★★ 6 层调用路径 — 每层的代价

```
问题：
  ① 为什么 Layer 3（JNI native 往返）是 Inflation 后唯一可消除的一层？
      线索: NativeMethodAccessorImpl.invoke0() 是 native → GeneratedMethodAccessor 的 invoke() 是 Java bytecode
      答案方向: native 调用 → ThreadInVMfromNative 构造 + HandleMarkCleaner 构造 + ThreadInVMfromNative 析构 +
      trans_and_fence → ~100ns 的固定开销。GeneratedMethodAccessor 用 invokevirtual 字节码 → 无 Native→VM 状态转换 →
      解释器 CPU 开销（但如果被 JIT 编译→可消除大部分）。追问: 为什么其他层不可消除？→ Object[] 参数是反射 API 的契约
      → 只要调用 Method.invoke(Object obj, Object... args) → 参数打包/拆包不可消除。

  ② Layer 5 (invoke()) 的 ResourceMark 分配了多少内存？
      线索: reflection.cpp:1085  ResourceMark rm(THREAD)
      答案方向: ResourceMark 在 ResourceArea 中设 checkpoint → 后续所有 RA 分配（包括 signature stream、
      parameter type names 的临时字符串等）在此 checkpoint 前 → 函数返回时 RA 回滚 → 一次调用释放所有临时内存。
      追问: 如果没有 ResourceMark 会怎样？→ 临时内存累积在 ResourceArea 中 → 如果反射调用循环 10000 次 →
      ResourceArea 无限增长 → OOM。

  ③ 为什么 Handle 创建是每层都要反复做的事？
      答案方向: Layer 3 (JVM_InvokeMethod) 创建 method_handle + receiver + args_handle (3 个)。
      Layer 4-5 又通过 methodHandle()/Handle() 创建新的 Handle（虽然底层指向同一个 oop）。
      Handle 创建本身代价低（只是 HandleArea 推指针），但 Handle lifecycle 正确性要求 Strict 遵循
      HandleMark 作用域，否则死 Handle 过多。

  ④ 6 层调用中的线程状态变化（Java ↔ _thread_in_vm）
      答案方向: NativeMethodAccessorImpl.invoke0() (在 Java 中执行) → _thread_in_native(短暂) →
      ThreadInVMfromNative 构造 → _thread_in_vm → ... 反射逻辑 ... → ThreadInVMfromNative 析构 →
      _thread_in_native → invoke0() 返回 Java → _thread_in_Java。来回 3 次状态改变。
```

### 4.2 ★★ Inflation 机制

```
问题：
  ① 为什么生成的 bytecode class 不叫 GeneratedMethodAccessor 而叫 GeneratedMethodAccessor$N？
      答案方向: 每次 inflation 都生成一个新类（N 是递增的数字）→ 因为每个 Method 对象的参数类型/返回类型不同
      → bytecode 中对 invokevirtual 的 method ref 是硬编码的 → 必须每方法生成一份。
      追问: 这是个 class loader 漏洞吗？→ 如果无限反射不同方法 → 无限生成类 → 会 Metaspace 泄漏。
      JDK 设置了 `noInflation` 标志（`ReflectionFactory.java:87`）在某些情况下禁用它。

  ② `inflationThreshold` 在不同的 HotSpot 版本中变化过吗？
      答案方向: 默认 15 长期稳定。但在特定场景（如 `-Dsun.reflect.noInflation=true`）下直接走 Generated → 完全跳过 Native。
      这对于方法调用频率高的场景更优（启动时一次性生成，后续高速）。

  ③ MethodAccessorGenerator.generateMethod() 的 bytecode 生成过程是什么？
      答案方向: MethodAccessorGenerator（JDK 侧，不在 HotSpot 中）使用 ASM 或手动 bytecode 组装 →
      生成完整的 ClassFile → 通过 `Unsafe.defineAnonymousClass(hostClass, bytecode, cpPatches)` 注册到 VM。
      追问: 为什么是 anonymous class 而不是 defineClass？→ anonymous class 的生命周期绑定到 host class →
      当 method 对象被 GC → anonymous class 也可回收 → 避免 ClassLoader leak。

  ④ C++ 侧的 is_generated_method_accessor() 在哪用到？
      线索: reflectionAccessorImplKlassHelper.cpp:100-103
      答案方向: 在安全栈扫描（security stack walk）中排除反射方法 → 不对 GeneratedMethodAccessor 的 invoke()
      做权限检查 → 避免递归检查。这是 [09-04] 中提到过的安全栈扫描忽略机制的一个具体案例。
```

### 4.3 ★★★ 参数拆箱 — 为什么是开销之王

```
问题：
  ① unbox_for_primitive() 对 Integer → int 的拆箱进行了几次 JVM 操作？
      线索: reflection.cpp:106-112
      答案方向: (a) null check，(b) klass check (arg->klass() == java.lang.Integer::klass())，(c) 读取 value 字段
      (arg->int_field(_value_offset))，(d) 存入 jvalue。共 4 次操作，每次操作都涉及 oop 指针跟踪。
      ★ 如果 Integer 对象不在 L1 cache → 额外 ~4ns 延迟。

  ② widen() 何时被调用？代价多高？
      线索: reflection.cpp:120 + L1198-1200
      答案方向: 当参数的实际类型和形参类型不匹配时（如 byte → int, float → double）。
      调用 widen() → 对每种类型对做 switch 语句 → 隐式类型转换（JVM 内部规则，和 JLS 5.1.2/5.1.4 对应）。
      追问: widen() 有没有可能失败？→ 如果尝试 int → short（窄化）→ throw IllegalArgumentException。

  ③ push_oop/get_handle 做了几次 GC barrier？
      答案方向: 每个 Object[] 参数通过 get_handle(THREAD, arg) → 内部调用 Handle(THREAD, arg) 构造函数
      → 把 oop 存入 HandleArea。如果该 oop 刚被 GC 移动 → G1/Shenandoah 的 SATB barrier 捕获。
      追问: 直接调用有没有这层？→ 无 — 参数已在局部变量表（寄存器或栈），GC 通过 oopMap 自动跟踪。

  ④ JavaCallArguments 的 push 操作本身有多大代价？
      答案方向: push_int/push_long/push_oop → 调用 JavaCallArguments 的 append() → 向内部的 GrowableArray
      追加元素。如果数组满 → 分配新空间 + 复制。通常 1-2 次调用数组已分配好。
```

### 4.4 ★★ java_lang_reflect_Method::slot() — 为什么是 O(1)

```
问题：
  ① slot 值从哪来、由谁设置？
      线索: reflection.cpp:926-973 Reflection::new_method()
      答案方向: 当 Class.getDeclaredMethod() → JVM 创建 java.lang.reflect.Method mirror 对象时 →
      Reflection::new_method() → 找到 Method* m → 计算 slot = m 在 InstanceKlass::methods() 数组中的索引 →
      调用 java_lang_reflect_Method::set_slot(mirror, slot) → obj->int_field_put(slot_offset, slot)。
      追问: Class.getDeclaredMethod() 返回后，slot 就永远不变了吗？→ 对于普通类是的（methods() 数组不变）。
      但 [09-03] 的 VM_RedefineClasses 在 redefine 后可能改变方法表 → 需要更新的 slot 值。

  ② 如果 slot 值被错误设置（如指向不存在的方法），JVM 怎么处理？
      线索: reflection.cpp:1277-1280
      答案方向: method_with_idnum(slot) 返回 NULL → THROW_MSG_0(InternalError, "invoke").
      不会 segfault — 有 NULL 检查保护。

  ③ 为什么 slot 是 int 字段而不是保存 Method* 指针？
      答案方向: Method* 是 C++ 指针（native word 大小）→ 在 oop 中存指针不安全（GC 可能调整 Method*
      但 oop 中的 int 是稳定的）。如果存指针 → GC 每次压缩/重定位要扫描所有 Method mirror 对象更新指针
      → 代价太大。存 int 索引 → 实时查找 Method* → 任何时候 methods() 数组有效就得到正确指针。

  ④ slot 和 [05] 反射的关系是什么？
      答案方向: slot 是"从 Method mirror 找 C++ Method*"的唯一桥梁。没有 slot → 每次 invoke 都要
      遍历 InstanceKlass::methods() 数组做名称+签名匹配 → O(n) 开销 → 反射根本无法使用。
      slot 的 O(1) 查找是反射可行的前提条件。
```

### 4.5 ★★ JavaCalls::call → StubRoutines::call_stub() — 最后一跳

```
问题：
  ① JavaCallWrapper 做了什么保护？
      线索: javaCalls.cpp call_helper 中的 JavaCallWrapper
      答案方向: JavaCallWrapper 在 C++ 栈上创建 → 构造函数保存当前线程状态 + 设 HandleMark checkpoint
      + ResourceMark checkpoint → 析构时恢复。最终执行 call_stub 时 → C++ 栈帧上的 JavaCallWrapper
      作为"C++ 侧的 sentinel"保护 → 如果 Java 方法抛异常 → 异常处理走到 C++ 侧 → JavaCallWrapper
      dtor 执行 → Handle/Resource/ObjectMonitor 清理。

  ② StubRoutines::call_stub() 是怎么生成的？
      答案方向: 由 `StubGenerator::generate_call_stub()` 在启动时生成（`stubGenerator_x86_64.cpp` 或等价）。
      这是一段汇编代码 → 不经过 C++ 编译器 → 手工管理栈布局 → 用特定寄存器传参 → call 到 Method 的
      from_interpreted_entry。追问: 为什么是汇编而不是 C++？→ C++ 无法保证栈布局和寄存器约定 — 必须
      在"刚好在 Java 执行之前"的点做精确控制。

  ③ call_helper 中 L450 的 call 指令是什么？
      答案方向: `StubRoutines::call_stub()(function_ptr, result_addr, parameters, thread, ...)` — 
      这是通过函数指针调用汇编桩。不是 `call` 指令 — 是 C++ 函数指针调用 → 编译器生成 `call` 指令到
      汇编桩的入口 → 汇编桩再调整栈 → 跳入 Java。
```

### 4.6 ★★ 异常包装 — InvocationTargetException 的代价

```
问题：
  ① 为什么不能直接把目标方法的异常抛回去？
      答案方向: Java 反射规范要求 Method.invoke() 抛 InvocationTargetException。
      直接抛目标异常 → 调用方看不到 Method.invoke() 在调用栈上的异常原因 → 调试困难。
      InvocationTargetException 提供 getTargetException() 方法访问原异常。

  ② 异常路径分配了多少对象？
      答案方向: (a) PENDING_EXCEPTION 读取，(b) CLEAR_PENDING_EXCEPTION，(c) 构造 InvocationTargetException
      对象（含内部 target field），(d) THROW_ARG_0 宏 → 把新异常设为 pending。总计 1 个新对象分配 +
      1 个异常清除 + 1 个异常设置。★ 直接调用：只有 1 个异常对象分配（目标方法抛出的）。

  ③ JvmtiExport::clear_detected_exception() 出现的理由（L1240-1242）？
      答案方向: 在目标方法抛异常时 → JVMTI 的 ExceptionThrow 事件在目标方法的栈帧上触发 →
      检测到此异常。但它将被包装为 InvocationTargetException → 原异常被丢弃。JVMTI 若不清理 →
      报告的异常存活状态不准确。此处的调用保证 JVMTI 的异常追踪状态一致。
```

### 4.7 ★ 反射和 [09-04] [09-01] 的交叉

```
问题：
  ① JVM_InvokeMethod 的 JVM_ENTRY 宏展开后注入了哪些 RAII 对象？
      线索: interfaceSupport.hpp JVM_ENTRY 定义 + jvm.cpp:3612
      答案方向: ThreadInVMfromNative、HandleMarkCleaner。这两个 RAII 对象在 JVM_InvokeMethod 的
      整个生命期中有效 → 保证线程在 _thread_in_vm 状态 + Handle 不泄漏。
      追问: 如果 JVM_InvokeMethod 抛了异常 → ThreadInVMfromNative dtor 仍然执行？→ 是（RAII 保证），
      trans_and_fence 在 dtor 中执行 → 线程正确回到 _thread_in_native。

  ② JVM_InvokeMethod 内创建了几个 Handle？
      答案方向: method_handle(1)、receiver(1)、args()(1)—ojbArrayHandle 内部含 Handle → 至少 3 个。
      如果有 JvmtiExport::should_post_vm_object_alloc → 还有 ret_type Handle。共 3-4 个。
      这些 Handle 由 HandleMarkCleaner 的 dtor 自动释放（HandleArea 回滚）。

  ③ 反射调用和 ThreadInVMfromNative 的关系？
      答案方向: [09-01] 分析了 trans_from_native → poll safepoint → block 的完整路径。
      每次 Reflection 调用（通过 JVM_InvokeMethod）→ 都经过这一条路 → 如果 JVM 在 safepoint →
      反射调用会阻塞，这和直接调用的阻塞行为完全一样。
```

## 五、文章结构

```
§〇 源文件清单（跨 JDK + prims + runtime + classfile，标注模块归属和反射调用路径中的角色）

§一 ★★★ 6 层调用路径 — 完整泳道图 + 每层的"减速带"
  ❓ 为什么反射是 6 层而不是 3 层？
  ❓ 每层在调用路径中起什么作用？
  1.1 泳道图 — Layer 1-6 的线程状态、Handle 创建数、关键操作
  1.2 Layer 1-2（Java）: MethodAccessor 委派链 + Inflation 检查
  1.3 Layer 3（JNI）: JVM_InvokeMethod + JVM_ENTRY 宏的 RAII
  1.4 Layer 4-5（C++）: invoke_method + invoke + 参数拆箱
  1.5 Layer 6（汇编）: JavaCalls::call → StubRoutines::call_stub
  1.6 ★ 和直接调用的逐环节对比表

§二 ★★ Inflation 机制 — 从 Native 到 Generated
  ❓ 为什么是 15 次？谁决定的？
  ❓ 生成的 bytecode class 长什么样？
  2.1 NativeMethodAccessorImpl 的计数器和阈值检查
  2.2 GeneratedMethodAccessor 的 bytecode 结构（反编译展示）
  2.3 ClassDefiner 和 Unsafe.defineAnonymousClass
  2.4 noInflation 标志 — 什么情况下跳过 Native 路径
  2.5 C++ 侧的安全栈扫描识别（is_generated_method_accessor）

§三 ★★★ 参数拆箱 — 反射开销的"三王"之一
  ❓ 每次拆箱做了多少次 oop 操作？
  ❓ 为什么 widen() 是额外的一层开销？
  3.1 unbox_for_primitive() 逐行拆解（null check + klass check + field read）
  3.2 widen() 的类型转换矩阵
  3.3 JavaCallArguments::push_*() 的实现
  3.4 Object 参数和 primitive 参数的拆箱对比
  3.5 ★ 5 个 int 参数反射调用的完整开销计算（和直接调用的差异）

§四 ★★ 反射基础设施 — slot、override、method lookup
  ❓ 为什么 slot 是 O(1) 而不是 O(n)？
  ❓ override 标志为什么每次调用都要读？
  4.1 java_lang_reflect_Method::slot() 的 O(1) 魔法（[09-04]§四 承接）
  4.2 override 标志的语义和每次调用的代价
  4.3 Reflection::invoke_method 的 7 步操作
  4.4 和 VM_RedefineClasses 的冲突 — redefine 后 slot 值是否仍然有效

§五 ★★ 异常处理 — InvocationTargetException 的代价
  ❓ 为什么不能直接抛目标异常？
  ❓ 异常包装分配了多少额外对象？
  5.1 异常检测点（HAS_PENDING_EXCEPTION 在 JavaCalls::call 返回后）
  5.2 InvocationTargetException 构造 + THROW_ARG_0
  5.3 JVMTI 的 clear_detected_exception 清理
  5.4 和直接调用的异常路径对比

§六 ★★ 和 [09-04][09-01] 的交叉验证
  ❓ JVM_InvokeMethod 的 JVM_ENTRY 宏注入了什么？
  ❓ slot 的 offset 预计算在哪完成的？
  6.1 JVM_InvokeMethod 的 JVM_ENTRY 展开（[09-04]§一 直接应用）
  6.2 slot() 的 offset 预计算（[09-04]§四 承接）
  6.3 Handle 生命期管理（[09-02] 的 JNIHandleBlock 对比）
  6.4 反射调用中的 ThreadInVMfromNative（[09-01]§二）

§七 GDB 验证 + 可证伪断言（≥12 条）
  断言 1: JVM_InvokeMethod 的断点命中 → 查看 ThreadInVMfromNative 已构造
  断言 2: reflection.cpp:1264 的 slot() 返回值 → 实例 Klass::methods() 数组索引
  断言 3: reflection.cpp:1232 JavaCalls::call 的调用栈深度（≥6 层）
  断言 4: JVM_InvokeMethod 内创建的 Handle 数量（GDB 观察 HandleArea 变化）
  断言 5: Inflation 阈值变更（-Dsun.reflect.inflationThreshold=1）→ 第二次调用就走 Generated
  断言 6: GeneratedMethodAccessor 的类名验证（含 $N 后缀）
  断言 7: unbox_for_primitive 的 klass check 验证（Integer.class == arg->klass()）
  断言 8: override 字段的值在 setAccessible(true) 前后的变化
  断言 9: 参数拆箱循环的迭代次数 == ptypes 数组长度
  断言 10: InvocationTargetException 被抛出时 → PENDING_EXCEPTION 先被清除再设新异常
  断言 11: JVM_InvokeMethod 中 JavaCallArguments 存储的参数数量和 method->size_of_parameters() 一致
  断言 12: NativeLookup::lookup("invoke0") 的正确性验证（找到 JVM_InvokeMethod 地址）

  可证伪断言 1: 如果 inflation 被禁用 → 第 100 次调用仍然走 NativeMethodAccessorImpl
  可证伪断言 2: 如果Method.invoke() 返回后检查 slot → 和构造时的 slot 值相同（除非 redefine 改变）
  可证伪断言 3: 反射调用检查 override 标志时 → 不论标志是 true 还是 false → 都执行了字段读取操作
  可证伪断言 4: 把 -Dsun.reflect.inflationThreshold=0 → 第一次调用就生成 Generated → 查看类名
```

## 六、写作要求

1. **★ 6 层调用路径的泳道图是全文第一个核心交付物**：读者看后能画出从 Java 到汇编的完整路径，每层标注源文件行号、线程状态、Handle 数量。

2. **★ 每层必须标注"减速带"具体操作**：不是"有开销"，而是"unbox_for_primitive() 内执行了 null check + klass check + int field read，共 3 次 oop 操作"。

3. **★ Inflation 机制的"为什么 15"必须解释**：不只是"默认值是 15"，而是"为什么需要15次预热：前 15 次让 JIT 有机会编译 NativeMethodAccessorImpl.invoke() → 降低 Native 路径的开销。如果一开始就走 Generated → 浪费生成 bytecode class 的时间。"。

4. **★ 参数拆箱是开销分析的核心**：必须逐行走读 `reflection.cpp:1191-1223` 的参数拆箱循环，用 5 个 int 参数的具体例子展示每一步的操作。

5. **★ 和 [09-04] 的交叉引用必须精确到节**：[09-04]§一 JVM_ENTRY 宏展开、[09-04]§四 compute_offsets 的偏移预计算。

6. **★ slot() 的 O(1) 查找是 [09-04]§四 的直接应用**：必须展示完整的 `java_lang_reflect_Method::slot(mirror) → mirror->int_field(_slot_offset) → klass->method_with_idnum(slot) → InstanceKlass::methods()->at(slot)` 链。

7. **★ GDB 断言必须可执行**：指定确切的 breakpoint（如 `br reflection.cpp:1264`）、运行时条件（触发反射调用的 Java 代码），预期观察值。

8. **不要做"MethodHandles vs Reflection 性能对比"** — 那是 [09-06] 的职责。本文只需要在 Layer 6 提及 `JavaCalls::call` 和 MethodHandle 的 `linkToStatic` 都走同一个汇编桩。

9. **不要解释 Class.getDeclaredMethod() 的完整流程** — 这不是本文的叙事线。提及在 "Layer 4 之前" 即可。

## 七、输出格式

- Markdown 文件，命名为 `05-Reflection-Internal.md`
- 输出路径：`/data/workspace/openjdk-cut-new/probe_md/libjvm-analysis/09-native-interface/`
- 元信息头（标准环境 + 源文件清单 + 前置 [09-01][09-04] + 阅读收益 + "从 Method.invoke() 到底层调用的完整开销分析"的说明）
