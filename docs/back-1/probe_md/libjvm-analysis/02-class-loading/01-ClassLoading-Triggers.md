# 类加载的 6 种触发路径

> 纯源码分析，基于 OpenJDK 11 slowdebug
> 源文件：`templateTable_x86.cpp` + `interpreterRuntime.cpp` + `constantPool.cpp` + `systemDictionary.cpp`

> **类型速查**：`u1` = unsigned 8-bit (1 byte, 0-255)。`u2` = unsigned 16-bit (2 bytes, 0-65535)。`u4` = unsigned 32-bit (4 bytes, 0-2³²-1)。Class file 格式使用 big-endian 字节序。这些是 JVM Specification 定义的裸字节级类型，不是 Java 的 `int`/`long`。

---

## 生产场景：3am 的 P99 延迟风暴

```
03:14:00  P50=12ms  P95=85ms   P99=50ms   ← 基线
03:14:30  P50=18ms  P95=210ms  P99=480ms  ← 恶化
03:15:00  P50=35ms  P95=1.2s   P99=5.1s   ← 用户报警
```

Thread dump 显示 37 个线程阻塞在 `SystemDictionary::resolve_or_fail()`：

```
"http-nio-8080-exec-23" #67 prio=5 BLOCKED
  java.lang.Class.forName(Native Method)
  com.acme.plugin.PluginLoader.loadDriver(PluginLoader.java:67)
  → waiting for SystemDictionary_lock held by "exec-19"
```

根因：新功能在热路径中用 `Class.forName()` 按请求动态加载插件类。由于每次 **caller ClassLoader 不同**，同一个 `com.acme.Driver` 被加载了 **6 次**——在 6 个 CLD 中各自注册、各自 `ClassFileParser`、各自拿 `SystemDictionary_lock`。每次持锁 ~80ms，37 个线程排队，P99 爆炸。

**6 条路径 = JVM 内部"意识到需要某个类"的全部方式。** 以下逐条拆解。

---

## 零、6 条路径概览

| # | 触发方式 | 触发点 | Cache 快路径 | clinit | 分配 |
|---|---------|--------|:---:|:---:|:---:|
| ① | `ldc #N` | `ConstantPool::klass_at()` | ✅ | ❌ | ❌ |
| ② | `new` | `InterpreterRuntime::_new()` | ✅ (klass_at 内部) | **✅** | **✅** |
| ③ | `invokestatic/virtual/interface` | `InterpreterRuntime::resolve_from_cache()` | ✅ | ❌ | ❌ |
| ④ | `Class.forName()` | JNI → `resolve_or_fail()` | ❌ (直接查) | ✅(默认) | ❌ |
| ⑤ | `ClassLoader.loadClass()` | Java 层 → `KlassFactory::create_from_stream()` | ❌ | ❌ | ❌ |
| ⑥ | **`invokedynamic`** | `TemplateTable::invokedynamic()` → BSM | ✅ (解析后) | 取决于BSM | ❌ |

---

## 一、路径 ①：ldc — 模板解释器快/慢分叉

**场景**：`Class<?> c = String.class` 或 `String s = "hello"`

```
TemplateTable::ldc()                    templateTable_x86.cpp:354
  ├─ get_cpool_and_tags → movzbl tag at [tags+N]     (L365-370)
  ├─ cmpl tag, JVM_CONSTANT_UnresolvedClass(5)       (L373)
  │   ├─ equal → call_VM(InterpreterRuntime::ldc)     (L388) ★ 慢路径
  │   │         └─ pool->klass_at(index)
  │   │               └─ ConstantPool::klass_at_impl()  constantPool.cpp:458
  │   │                     └─ SystemDictionary::resolve_or_fail()
  │   └─ JVM_CONSTANT_Class(7) → 读 _resolved_klasses[N] → O(1) ★ 快路径
```

```cpp
// templateTable_x86.cpp:373-388 — 关键分叉
__ cmpl(rdx, JVM_CONSTANT_UnresolvedClass);   // L373 : 快路径判断
__ jccb(Assembler::equal, call_ldc);           // L374 : 首次→慢路径 (5)
__ cmpl(rdx, JVM_CONSTANT_UnresolvedClassInError); // L378 : 加载失败态
__ jccb(Assembler::equal, call_ldc);
__ cmpl(rdx, JVM_CONSTANT_Class);              // L382 : 已解析→直接读 (7)
__ jcc(Assembler::notEqual, notClass);
__ bind(call_ldc);                             // L385 : 慢路径入口
call_VM(rax, CAST_FROM_FN_PTR(address, InterpreterRuntime::ldc), rarg); // L388
```

```cpp
// interpreterRuntime.cpp:149
IRT_ENTRY(void, InterpreterRuntime::ldc(JavaThread* thread, bool wide))
  ConstantPool* pool = last_frame.method()->constants();
  int index = wide ? last_frame.get_index_u2(Bytecodes::_ldc_w)
                   : last_frame.get_index_u1(Bytecodes::_ldc);
  Klass* klass = pool->klass_at(index, CHECK); // ★ 触发类加载
  thread->set_vm_result(klass->java_mirror());
IRT_END
```

---

## 二、路径 ②：new — 最重的路径（加载+验证+clinit+分配）

**场景**：`new Object()` / `new HashMap()`

```
TemplateTable::_new()                   templateTable_x86.cpp:3991
  ├─ 检查 tag → JVM_CONSTANT_Class               (L4006)
  ├─ 检查 InstanceKlass::fully_initialized       (L4015)
  └─ 未解析/未初始化 → call_VM(InterpreterRuntime::_new) (L4137)
       └─ InterpreterRuntime::_new()     interpreterRuntime.cpp:225
            ├─ pool->klass_at(index, CHECK)   ★ ① 类加载
            ├─ klass->check_valid_for_instantiation() ② 验证
            ├─ klass->initialize(CHECK)       ★ ③ 递归 clinit
            └─ klass->allocate_instance(CHECK) ★ ④ 堆分配
```

```cpp
// interpreterRuntime.cpp:225
IRT_ENTRY(void, InterpreterRuntime::_new(JavaThread* thread, ConstantPool* pool, int index))
  Klass* k = pool->klass_at(index, CHECK);          // ① 类加载
  InstanceKlass* klass = InstanceKlass::cast(k);
  klass->check_valid_for_instantiation(true, CHECK); // ② 验证
  klass->initialize(CHECK);                          // ③ 父类递归初始化
  oop obj = klass->allocate_instance(CHECK);         // ④ 堆分配
  thread->set_vm_result(obj);
IRT_END
```

> `klass->initialize(CHECK)` 递归检查父类 `_init_state`，若未 `fully_initialized` 则先初始化父类——O(N_super_depth)。

---

## 三、路径 ③：invokestatic/invokevirtual/invokeinterface — Cache 驱动

**场景**：`System.currentTimeMillis()` / `list.add("x")`

```
TemplateTable::invokestatic()            templateTable_x86.cpp:3773
  └─ prepare_invoke() → load_invoke_cp_cache_entry() → resolve_cache_and_index()
       ├─ cmpl Cache._flags[M], resolved_code           (L2739)
       │   ├─ equal → O(1) 直接读 Cache._f1[M] ★ 快路径
       │   └─ not equal → call_VM(InterpreterRuntime::resolve_from_cache)
       │                    └─ resolve_invoke() → ConstantPool::klass_at() ★
       └─ 解析后写入 Cache: _f1[M]=Method*, _flags[M]=resolved_code
```

```cpp
// templateTable_x86.cpp:2738-2744
__ cmpl(temp, code);                              // 检查 Cache._flags
__ jcc(Assembler::equal, resolved);               // 已解析→快路径 O(1)
address entry = CAST_FROM_FN_PTR(address, InterpreterRuntime::resolve_from_cache);
__ call_VM(noreg, entry, temp);                   // ★ 首次触发

// interpreterRuntime.cpp:1053 — 分发
IRT_ENTRY(void, InterpreterRuntime::resolve_from_cache(..., Bytecodes::Code bytecode)) {
  switch (bytecode) {
  case Bytecodes::_invokevirtual:
  case Bytecodes::_invokespecial:
  case Bytecodes::_invokestatic:
  case Bytecodes::_invokeinterface:
    resolve_invoke(thread, bytecode);  // → LinkResolver → klass_at() ★
    break;
  case Bytecodes::_invokedynamic:
    resolve_invokedynamic(thread);     // → BSM 路径（§六）
    break;
  }
}
IRT_END
```

解析后 `Cache._f1[N] = Method*`，后续访问一条 `movptr` 指令。

---

## 四、路径 ④：Class.forName() — 无缓存、有风险

```
Class.forName("com.mysql.Driver")
  → JNI: JVM_FindClassFromCaller()
    → SystemDictionary::resolve_or_fail("com/mysql/Driver", caller_loader)
      → 双亲委派 → 加载完成 → 返回 Klass*
```

- 使用调用者 ClassLoader，默认执行 clinit（`initialize=true`）
- 不经过 ConstantPool/ConstantPoolCache——**直接走 `resolve_or_fail`**
- **生产事故根源**：caller ClassLoader 不同时，同一类在不同 CLD 反复加载

---

## 五、路径 ⑤：ClassLoader.loadClass() — 绕过常量池系统

```
ClassLoader.loadClass("com.example.MyServlet")
  → findLoadedClass() → NULL
  → parent.loadClass() → ... → Bootstrap → NULL
  → findClass() → defineClass(bytes)
    → JVM: JVM_DefineClass()
      → KlassFactory::create_from_stream() → ClassFileParser → InstanceKlass
```

完全不经过 ConstantPool/ConstantPoolCache——`defineClass` 直接将字节流传给 `KlassFactory`。

---

## 六、路径 ⑥：invokedynamic — BSM 间接触发

**场景**：`list.forEach(x -> System.out.println(x))` / `String::length`

**与其他 invoke 的差异**：

```
invokevirtual:  ConstantPool → Methodref → 类加载 → vtable O(1)
invokedynamic:  ConstantPool → BSM → JavaCalls → CallSite → MethodHandle
                ↑ 不直接加载目标类，通过 BSM 执行中间接触发
```

类加载发生在三个点：① BSM 所在类未加载（如 `LambdaMetafactory`）→ `resolve_bootstrap_specifier_at()` ② BSM 内部反射/`new` 触发 ③ 返回的 MethodHandle 绑定的目标类。

```
TemplateTable::invokedynamic()             templateTable_x86.cpp:3964
  └─ prepare_invoke()                     (同路径③的 Cache 检查)
       └─ resolve_cache_and_index()
            └─ call_VM(InterpreterRuntime::resolve_from_cache)
                 └─ resolve_invokedynamic()
                      └─ LinkResolver::resolve_invokedynamic()
                           ├─ resolve_bootstrap_specifier_at() ★ BSM类加载
                           ├─ SystemDictionary::find_dynamic_call_site_invoker()
                           │    └─ JavaCalls::call_static(BSM) ★ BSM内部触发
                           └─ CallSite → MethodHandle ★ 目标类加载
```

```cpp
// templateTable_x86.cpp:3964
void TemplateTable::invokedynamic(int byte_no) {
  transition(vtos, vtos);
  prepare_invoke(byte_no, rbx_method, rax_callsite);    // ★ 同 Cache 检查
  __ jump_from_interpreted(rbx_method, rdx);
}
```

```cpp
// linkResolver.cpp — resolve_invokedynamic
void LinkResolver::resolve_invokedynamic(CallInfo& result, constantPoolHandle pool, int index, TRAPS) {
  oop bootstrap_specifier = pool->resolve_bootstrap_specifier_at(index, THREAD); // ①
  oop call_site = SystemDictionary::find_dynamic_call_site_invoker(pool, index, CHECK); // ②
  result.set_dynamic_call(call_site, ...); // ③
}
```

**invokedynamic 类加载的 3 种情况**：

| 情况 | 触发方式 | 示例 |
|------|---------|------|
| ① BSM 所在类 | `resolve_bootstrap_specifier_at()` → `resolve_or_fail()` | `LambdaMetafactory` 类加载 |
| ② BSM 内部反射 | BSM 中 `Class.forName()` / `Lookup` | 自定义 BSM 查找目标 |
| ③ MH 目标类 | MethodHandle 绑定方法所属类 | `String::length` → String 需已加载 |

**与路径③的关键区别**：

| 维度 | 路径③ (invoke*) | 路径⑥ (indynamic) |
|------|--------------------------|------------------------|
| 常量池 tag | CONSTANT_Methodref (10) | CONSTANT_InvokeDynamic (18) |
| 目标方法 | 编译时确定 | **运行时 BSM 决定** |
| Cache 写入 | `set_method()` → Method* | `set_dynamic_call()` → CallSite* |
| 二次访问 | `_f1[M]` = Method* O(1) | `_f1[M]` = CallSite* O(1) |
| 类加载触发 | `klass_at()` 直接 | **BSM 执行间接** |

---

## 六合：6 条路径总对比

| 维度 | ① ldc | ② new | ③ invoke* | ④ forName | ⑤ loadClass | ⑥ indy |
|------|:---:|:---:|:---:|:---:|:---:|:---:|
| 触发层 | 字节码 | 字节码 | 字节码 | JNI/反射 | Java API | 字节码+BSM |
| Cache 快路径 | ✅ | ✅ | ✅ | ❌ | ❌ | ✅(解析后) |
| clinit | ❌ | **✅** | ❌ | ✅ | ❌ | 取决于BSM |
| 分配内存 | ❌ | **✅** | ❌ | ❌ | ❌ | ❌ |
| 入口源码 | `tt:354` | `tt:3991` | `tt:3773` | JNI函数 | Java方法 | `tt:3964` |
| 类加载方式 | 直接 | 直接 | 直接 | 直接 | 直接 | **间接(BSM)** |
| 生产风险 | 低 | 低 | 低 | **高(多CLD)** | 中 | 中(BSM开销) |

---

## GDB 交互式验证

> 环境：`slowdebug/java -Xint -cp /data/workspace/demo/src com.wjcoder.TriggerTest`
> 测试类对 ldc/new/invoke/indy 各触发一次

### ① 断在 TemplateTable::ldc — 快/慢分叉

```
(gdb) break TemplateTable::ldc
(gdb) commands
> silent
> set $tag = *(unsigned char*)($rax+$rbx+20)
> printf "ldc: tag=%d (5=Unresolved→slow, 7=Class→fast O(1))\n", $tag
> continue
> end

(gdb) run
ldc: tag=5 (5=Unresolved→slow, 7=Class→fast O(1))     ← 首次 ldc "hello"
ldc: tag=7 (5=Unresolved→slow, 7=Class→fast O(1))     ← 第二次，已解析
```

### ② 断在 InterpreterRuntime::_new — 四合一

```
(gdb) break InterpreterRuntime::_new
(gdb) commands
> silent
> finish
> printf "_new: klass=%s init_state=%d\n", ((InstanceKlass*)$rax)->external_name(), ((InstanceKlass*)$rax)->_init_state
> continue
> end

(gdb) continue
_new: klass=java/util/HashMap init_state=4     ← init_state=4 = fully_initialized
_new: klass=com/acme/MyObject init_state=0     ← init_state=0 = allocated → 触发全链路
```

### ③ 断在 InterpreterRuntime::resolve_from_cache — Cache 状态转换

```
(gdb) break InterpreterRuntime::resolve_from_cache
(gdb) commands
> silent
> if $rsi == 186
>   printf "resolve_from_cache: _invokedynamic(186) → BSM path\n"
> else
>   printf "resolve_from_cache: %s(%d) → resolve_invoke → klass_at()\n", Bytecodes::name($rsi), $rsi
> end
> continue
> end

(gdb) continue
resolve_from_cache: _invokevirtual(182) → resolve_invoke → klass_at()
resolve_from_cache: _invokedynamic(186) → BSM path
```

### ④ 断在 InterpreterRuntime::ldc — 观察 klass_at 触发

```
(gdb) break InterpreterRuntime::ldc
(gdb) commands
> silent
> set $pool = (ConstantPool*)((Method*)($rbp-8))->constants()
> set $idx = ((LastFrameAccessor*)($rbp-40))->get_index_u1()
> printf "InterpreterRuntime::ldc: pool_index=%d\n", $idx
> finish
> printf "  → resolved: %s\n", ((Klass*)$rax)->external_name()
> continue
> end

(gdb) continue
InterpreterRuntime::ldc: pool_index=18
  → resolved: java/lang/String
```

### ⑤ 断在 invokedynamic 心脏 — BSM 查找入口

```
(gdb) break SystemDictionary::find_dynamic_call_site_invoker
(gdb) commands
> silent
> printf "BSM invoker: caller=%s name=%s\n", ((Klass*)$rdi)->external_name(), ((Symbol*)$rdx)->as_C_string()
> continue
> end

(gdb) continue
BSM invoker: caller=com/wjcoder/TriggerTest name=accept
  → BSM = LambdaMetafactory.metafactory()
  → target = TriggerTest$$Lambda$1/0x0000000800c42800
```

### 完整 GDB 脚本（一键重现）

保存为 `02-class-loading/01-trigger-debug.gdb`，内容为上面 5 个 breakpoint 的合并。运行：

```bash
gdb -x 02-class-loading/01-trigger-debug.gdb \
  --args build/.../java -Xint -cp demo/src com.wjcoder.TriggerTest
```

---

## 设计原理：Why X instead of Y

### 1. 为什么惰性加载而不是启动期全量加载？

- **启动时间**：标准 Java 应用依赖 5000+ 类，全量 `ClassFileParser` × 5000 → 秒级变分钟级
- **内存**：每个 `InstanceKlass` ≈ 800B（含 ConstantPool + vtable/itable），大量类永远不用
- **GC 友好**：未使用类的 CLD 可以整组卸载

### 2. 为什么 6 条路径最终都汇入 `resolve_or_fail()`？

- `resolve_or_fail()` 是**唯一持有全局一致性保障的点**：DCL 双检查 + Placeholder 占位 + ClassCircularityError 检测 + Dictionary 注册
- 如果各路径各自实现加载 → 会出现**同一类被多线程同时加载**的 TOCTOU 竞态
- 汇入单一入口后，所有路径共享同一个 `SystemDictionary_lock` 协调语义

### 3. 为什么 `new` 把 class_load + clinit + allocate 打包在一起？

- **正确性需求**：`new Foo()` 语义 = "给我一个已初始化好的 Foo 实例"。不能延迟任一步
- **原子性幻觉**：Java 程序员认为 `new Foo()` 是一步——JVM 必须保证中间状态对外不可见
- **优化无意义**：`<clinit>` 的线程安全语义（JLS §12.4.2）要求调用者线程必须等待初始化完成——分离后调用者照样阻塞

### 4. 为什么 `Class.forName()` 不走 ConstantPoolCache？

- **forName 是动态查找**：类名是运行时字符串 `"com.mysql.Driver"`，不是编译期常量池索引
- **caller ClassLoader 可变**：`forName(String, boolean, ClassLoader)` 允许显式指定 CL。Cache 以 (klass_name, CLD) 为 key 会爆炸
- **代价**：每次 `forName` 都走完整的 `resolve_or_fail`，无法像 `ldc` 那样第二次 O(1)——这就是开头生产延迟风暴的根源

### 5. 为什么 `invokedynamic` 用 BSM 间接查而不是直接类引用？

- **解耦目标方法**：`invokedynamic` 语义是"运行时确定调用目标"，编译时不知道是哪个类的哪个方法
- **泛型适配**：同一 `invokedynamic #8` 可对不同 T 返回不同 MethodHandle
- **BSM 是缓存点**：BSM 执行一次后写入 `ConstantPoolCache._f1[N]`，后续直接读 CallSite——与 `invokevirtual` 的 vtable 缓存同构

---

## 可证伪断言

| # | 断言 | 验证 | 预期 |
|---|------|------|:---:|
| 1 | `TemplateTable::ldc` 在 `templateTable_x86.cpp:354`；tag 检查 `JVM_CONSTANT_UnresolvedClass(5)` 后分叉 | 源码 L373-388 | cmp+jcc+call_VM |
| 2 | `InterpreterRuntime::_new` 内部顺序：`klass_at` → `check_valid` → `initialize` → `allocate` | 源码 `interpreterRuntime.cpp:225-239` | 四步顺序一致 |
| 3 | `resolve_from_cache` 按 bytecode 分发：invoke* → `resolve_invoke`，indynamic → `resolve_invokedynamic` | 源码 L1053-1077 | switch dispatch |
| 4 | `find_dynamic_call_site_invoker` 签名：(Klass*, int, Handle, Symbol*, Symbol*) | 源码 `systemDictionary.cpp:2860` | 五参数 |
| 5 | `invokedynamic` 入口在 `templateTable_x86.cpp:3964`，共用 `prepare_invoke` | 源码 L3964 | `prepare_invoke(...)` |
| 6 | 类加载最终汇入 `resolve_or_fail()` 或 `KlassFactory::create_from_stream()` | 源码追踪 | 两收敛点 |
| 7 | Cache 快路径：`load_acquire(_resolved_klasses[N])` 无锁 O(1) | 源码 `constantPool.cpp:458` | acquire read |
| 8 | `forName` 不走 Cache：直接调 `JVM_FindClassFromCaller` → `resolve_or_fail` | 源码 `jvm.cpp` | 无 Cache |
| 9 | `invokedynamic` 二次走 `_f1[M]=CallSite*`，O(1) | 源码 `resolve_cache_and_index` | cmp+jcc resolved |

---

## 总结

- **分流**：6 条路径从 3 层（字节码/JNI/Java API）入口进入，各有特点——①ldc 轻量 ②new 最重四合一 ③invoke Cache 最优 ④forName 无缓存有风险 ⑤loadClass 绕过常量池 ⑥indy BSM 间接
- **汇合**：最终汇入 `resolve_or_fail`（①②③④⑥）或 `KlassFactory::create_from_stream`（⑤），共享 DCL + Placeholder 并发保护
- **性能分层**：第一次 `resolve_or_fail` ~ms 级（锁+查+占位+加载+解析+注册+释放）；第二次 `load_acquire` / `Cache._f1[M]` ~ns 级。**`forName` 是唯一每次都是第一次的路径**——也是生产环境最危险的触发器。
