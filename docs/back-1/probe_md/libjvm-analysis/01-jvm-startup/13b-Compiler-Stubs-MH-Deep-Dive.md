# compileBroker + stubRoutines2 + MethodHandles — JIT 基础设施就绪

> OpenJDK 11 slowdebug
> 覆盖：compileBroker_init() → universe_post_init() → stubRoutines_init2() → MethodHandles::generate_adapters()

---

## 零、GDB 验证

```
sizeof(ReferenceProcessor) = 96    sizeof(ConstantPool) = 72
sizeof(CompilerThread)     = 1960  sizeof(DispatchTable) = 20480
sizeof(InstanceKlass)      = 472
CodeCache_capacity         = 48 MB
```

---

## 一、compileBroker_init() — 为什么分 Phase1/2？

### ① 解决什么问题

JIT 编译器的初始化不能一步完成——Phase1 创建线程对象（需要 heap 完成），Phase2 启动线程（需要 init_globals 完成 + VMThread 运行）。两步之间有严格的依赖关系。

### ② 源码

```cpp
// compileBroker.cpp:236
bool compileBroker_init() {
    DirectivesStack::init();
    // ★ 初始化编译器指令栈
    //   -XX:CompileCommand=exclude,java/lang/String::hashCode
    //   管理哪些方法该编译、哪些该排除
    return true;
}
```

**两阶段分别在哪里调用：**

```
create_vm() 阶段 6：
  CompileBroker::compilation_init_phase1()  ← 创建 CompilerThread 对象
    内部: _c1_count=2, _c2_count=2 (CICompilerCount=4, GDB)
          new CompilerThread × 4

  CompileBroker::compilation_init_phase2()  ← 启动线程
    os::create_thread → compiler_thread_entry()
    → 线程等待 compile queue 有任务
```

### ③ 为什么必须分两步

```
Phase1 在 init_globals() 中 compileBroker_init() 完成 — 此时 VMThread 尚未创建
  但 Phase2 中 compiler thread 可能触发 safepoint → 需要 VMThread
  → Phase2 必须推迟到 create_vm() 阶段 6（VMThread 已创建）

如果合为一步 → safepoint 请求无人处理 → 死锁
```

---

## 二、stubRoutines_init2() — 为什么 Stub 代码要分两阶段生成？

### ① 解决什么问题

第一批 Stub（init1）只需要堆地址和基本 CodeCache；第二批 Stub（init2）需要完整的类信息（如 `arrayof_oop_disjoint` 需要知道对象对齐方式）。universe_post_init 之前类信息不全。

### ② 两阶段内容

```
stubRoutines_init1():  基础 Stub（在 init_globals 早期，universe_init 之后）
  verify_oop             → 检查 oop 合法性
  call_stub              → C++ → Java 调用桥接
  catch_exception_entry  → 异常处理入口
  atomic_cmpxchg         → CAS 原子操作

stubRoutines_init2():  高级 Stub（在 universe_post_init 之后）
  arrayof_oop_disjoint  → 对象数组拷贝（无重叠）
  arrayof_oop_conjoint  → 对象数组拷贝（可能有重叠）
  → 需要知道压缩指针模式（base=0, shift=3 或 HeapBased）
```

### ③ 如果合为一步

```
stubRoutines_init1 时，SystemDictionary 尚未加载 Object → 对象大小未知
→ 无法生成正确的 array copy 代码（不知道 word size、压缩指针模式）
→ init2 推迟到 universe_post_init 之后 → 所有类信息齐全
```

---

## 三、MethodHandles::generate_adapters() — invokedynamic 的机器码支持

### ① 解决什么问题

Java 7 引入 `invokedynamic` 指令——调用点不固定，需要在运行时动态决定目标方法。但解释器只能执行固定的字节码→机器码映射。

**需要在 CodeCache 中生成一段"适配器"机器码**，能够根据 MethodHandle 的实际类型动态调整参数传递方式。

### ② 源码（init.cpp:190-191）

```cpp
MethodHandles::generate_adapters();
// → 在 CodeCache 中生成 invokedynamic 适配器
// → 包括：
//   - method_handle_invoke_* (invokeExact 的各种形式)
//   - method_handle_linkTo* (invokedynamic 的链接入口)
//   - 参数转换适配器（spread/collect/filter/...）
```

### ③ 如果没有生成

```
invokedynamic → 解释器遇到不认识的字节码 → 回退到 InterpreterRuntime
→ 每次调用都走 C++ 逻辑（JNI 调用成本 η 函数调用 ≫ 多条机器码跳转）
→ Lambda 表达式性能暴跌 10-100 倍
```

---

## 四、referenceProcessor_init() — SoftRef 为什么有时钟？

### ① 解决什么问题

SoftReference 的 GC 策略不是简单的"内存不足就回收"。需要区分"最近被访问过"的 SoftRef（不能回收）和"长期未访问"的 SoftRef（可以回收）。需要时钟来做判断。

### ② 源码

```cpp
// referenceProcessor.cpp:47-61
_soft_ref_timestamp_clock = os::javaTimeNanos() / NANOSECS_PER_MILLISEC;
java_lang_ref_SoftReference::set_clock(_soft_ref_timestamp_clock);

_always_clear_soft_ref_policy = new AlwaysClearPolicy();
// AlwaysClear: 每次都清除所有 SoftRef（用于 Full GC）
// LRUCurrentHeapPolicy: 仅在即将 OOM 时清除长时间未访问的 SoftRef
```

### ③ 如果没有时钟

```
内存紧张 → GC 需要回收 SoftReference
→ 没有时钟 → 不知道哪些 SoftRef 最近被用过 → 要么全回收（错误），要么全保留（OOM）
→ fm.lastModified < (now - TTL) 这种基础判断都做不了
```

---

## 五、总结

| 子函数 | 为什么在这个位置 | 核心输出 |
|--------|----------------|---------|
| compileBroker_init | 编译器指令栈就绪 | DirectivesStack |
| universe_post_init | 所有类信息齐全后的转折点 | _fully_initialized + OOM 预分配 |
| stubRoutines_init2 | 依赖完整类信息 | array copy / 异常处理 stub |
| MethodHandles::adapters | 依赖 stubRoutines + CodeCache | invokedynamic 适配器 |
| referenceProcessor_init | SoftRef 需要时钟 | 时钟 + 清除策略 |
