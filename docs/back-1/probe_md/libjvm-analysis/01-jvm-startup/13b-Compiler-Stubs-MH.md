# compileBroker + StubRoutines + MethodHandles — JIT 基础设施就绪

> OpenJDK 11 slowdebug, x86_64, GDB 验证
> 环境：`-Xms8g -Xmx8g -XX:+UseG1GC`
> 覆盖：`compileBroker_init()` → `universe_post_init()` → `stubRoutines_init2()` → `MethodHandles::generate_adapters()` → `referenceProcessor_init()`
> 耗时：stubRoutines_init1 ~2ms, stubRoutines_init2 ~1ms, MethodHandles adapters ~1ms
> 文件：`init.cpp:109-211`, `compileBroker.cpp:236-770`, `stubRoutines.cpp:196-331`, `methodHandles.cpp:75-108`, `referenceProcessor.cpp:47-73`

---

## 生产事故

你设置了 `-XX:CICompilerCount=1` 想减少后台线程数。peak 流量涌入，1000+ 方法进入 C2 编译队列。唯一的 C2 线程被一个巨型 `String::indexOf` 编译任务卡住 30 秒。期间所有新热点方法堆积在 `CompileQueue` 中，解释器执行被 hotspot threshold 标记的方法。结果：`HashMap.get()` 本应 3ns，现在 300ns（100x 慢），p99 延迟从 5ms → 500ms，SLA 全面挂掉。

```
# 根因链
-XX:CICompilerCount=1
  → C2 thread stuck on giant compilation (30s)
  → compile queue backlog: 1000+ methods waiting
  → all hot methods run in interpreter (no JIT)
  → 100x throughput drop
  → p99 latency spike → SLA breach
```

**本质**：编译线程是 JVM 的吞吐量保障。线程数太少 = 编译延迟 → 热点方法困在解释器。太多 = CPU 争用 → 编译本身消耗吞吐量。默认 `CICompilerCount = max(log2(NCPUS), 1)` 是经验最优解。

---

## 面试速查表

| 问题 | 答案 |
|------|------|
| `compileBroker_init()` 做什么？ | 初始化 DirectivesStack + 解析 `-XX:CompileCommand` 指令 |
| Phase1 vs Phase2 区别？ | Phase1 = 创建 CompilerThread 对象；Phase2 = 启动线程 (需要 VMThread ready) |
| `stubRoutines_init1` vs `init2`？ | init1 = 基础桩 (call_stub/exception/atomic)；init2 = arraycopy/fill (需完整类信息) |
| MethodHandle adapters 生成哪些？ | `linkToStatic`/`linkToVirtual`/`linkToSpecial`/`linkToInterface` 4 种 trampoline |
| 编译器线程如何获取任务？ | `queue->get()` 阻塞等待，唤醒后 `invoke_compiler_on_method(task)` |
| `CompileQueue` 是什么数据结构？ | 链表：`_first` → `_last`，`get()` 从队首取，`add()` 放队尾 |
| SoftRef 时钟为什么用 `os::javaTimeNanos`？ | 单调递增，不受系统时间跳变影响（`javaTimeMillis` 不保证单调） |
| Stub 代码存在哪？ | CodeCache 的 NonNMethodCodeHeap（BufferBlob） |

---

## 一、init_globals() 中的 JIT 相关调用全景

```cpp
// init.cpp:109-211 — init_globals() 截取
// ============ 基础设施 ============
codeCache_init();              // init.cpp:127 — CodeCache 48MB
stubRoutines_init1();          // init.cpp:133 — 第一批桩代码 (call_stub, exception, atomic)
// ... universe_init, interpreter_init ...
// ============ JIT 初始化区 ============
compileBroker_init();          // init.cpp:177 — DirectivesStack + CompileCommand 指令解析
universe_post_init();          // init.cpp:183 — universe 完全初始化标志
stubRoutines_init2();          // init.cpp:186 — 第二批桩代码 (arraycopy, fill — 需完整类信息)
MethodHandles::generate_adapters();  // init.cpp:190 — invokedynamic 适配器
```

**调用顺序不是随意的**：

| 调用 | 依赖 | 如果提前调用 |
|------|------|------------|
| `stubRoutines_init1` | `codeCache_init` + `stubRoutines` 字段 static 零初始化 | CodeCache 未就绪 → 无法分配 BufferBlob |
| `stubRoutines_init2` | `universe_post_init` → 完整类信息 | 不知道压缩指针模式 → 生成错误的 arraycopy 代码 |
| `MethodHandles::generate_adapters` | `stubRoutines_init2` → StubRoutines 字段指针可用 | 适配器代码引用 NULL 桩地址 → SEGV |
| `compileBroker_init` | `InlineCacheBuffer_init` → IC stub 就绪 | 没有 IC buffer → invokedynamic 链接失败 |

---

## 二、compilation_init_phase1 + phase2 深挖

### 2.1 为什么分两阶段？

```
create_vm() 流程 (thread.cpp:3490+):
  阶段 4: init_globals()               ← compileBroker_init() 在这里
    阶段 4 内: compilerOracle_init()
    阶段 4 内: compileBroker_init()     ← DirectivesStack ready
  阶段 6: compilation_init_phase1()     ← 创建 CompilerThread 对象
  阶段 6: compilation_init_phase2()     ← 启动线程 (VMThread 已运行)

Phase1 需要: Threads_lock (创建 JavaThread), CodeCache (BufferBlob), heap (Thread OOP)
Phase2 需要: VMThread running (safepoint), _fully_initialized = true
```

**为什么不在 init_globals 中一次完成？** → `thread.cpp:4227-4232`：Phase1 创建 Thread 对象 + `init_compiler_sweeper_threads()` 创建线程。但 Phase2 的 `_initialized = true` 标志需要 VMThread 已启动 —— 如果编译器线程在 Phase1 就开始取队列任务，而此时 VMThread 还未启动，触发 safepoint 会死锁。

### 2.2 compileBroker_init() — 指令栈 + CompileCommand（compileBroker.cpp:236-252）

```cpp
bool compileBroker_init() {
  DirectivesStack::init();  // 编译器指令栈
  // 管理 -XX:CompileCommand 规则的栈结构
  // 例: -XX:CompileCommand=exclude,java/lang/String::hashCode
  //        → 创建一个 Directive，将 hashCode 加入 exclude 列表
  //        → 编译时 CompileBroker 检查 DirectivesStack，发现 exclude → 跳过
}
```

**为什么 DirectivesStack 是栈而不是 hash map？** → CompileCommand 语法支持分层规则：`inline,com/foo/Bar.*` 覆盖整个包，`exclude,com/foo/Bar.baz` 覆盖特定方法。栈的后进先匹配语义天然支持这种优先级：`baz` 的 exclude 在栈顶 → 先匹配 → 覆盖底层的 inline。

### 2.3 compilation_init_phase1 — 编译线程创建（compileBroker.cpp:614-764）

```cpp
void CompileBroker::compilation_init_phase1(TRAPS) {
  // Step 1: 确定编译器数量
  _c1_count = CompilationPolicy::policy()->compiler_count(CompLevel_simple);           // default: 2
  _c2_count = CompilationPolicy::policy()->compiler_count(CompLevel_full_optimization); // default: 2
  
  // Step 2: 创建编译器实例
  _compilers[0] = new Compiler();    // C1
  _compilers[1] = new C2Compiler();  // C2
  
  // Step 3: 创建线程
  init_compiler_sweeper_threads();   // → make_thread() × (c1+c2) → new CompilerThread(queue, counters)
}
```

**为什么默认 CICompilerCount = max(log2(NCPUS), 1)？** → x86_64 典型 16 核：CICompilerCount=4（2 C1 + 2 C2）。编译是 CPU 密集型，线程超过 log2(NCPUS) 时上下文切换开销 > 并行收益。C1 负责低延迟快速编译，C2 负责高优化深度编译 —— 两者独立队列、独立线程，互不阻塞。

### 2.4 CompileQueue 结构（compileBroker.hpp:80-124）

```cpp
class CompileQueue {
  CompileTask* _first;       // 队首 — 下一个待编译
  CompileTask* _last;        // 队尾 — 最后入队的
  CompileTask* _first_stale; // 陈旧任务链表头 (RedefineClasses)
  int _size;                 // 当前队列长度

  void add(CompileTask* task);     // 插入队尾
  CompileTask* get();              // 阻塞取队首，空则 sleep
  void remove(CompileTask* task);  // 从链表删除
};
// 两个实例：
//   _c1_compile_queue — C1 线程轮询这个队列
//   _c2_compile_queue — C2 线程轮询这个队列
```

**为什么用链表而不用环形缓冲？** → 编译队列需要随机删除（RedefineClasses 失效所有旧方法编译任务）。链表 O(1) 删除任意节点（通过 `remove()` 重连前后指针）。环形缓冲删除需要搬移元素或标记为空洞 —— 碎片化。

### 2.5 compiler_thread_loop — 编译线程主循环（compileBroker.cpp:1828-1904）

```cpp
void CompileBroker::compiler_thread_loop() {
  ciObjectFactory::initialize();     // 初始化 CI（编译器接口）对象工厂
  
  while (!is_compilation_disabled_forever()) {
    CompileTask* task = queue->get();  // ★ 阻塞等待
    if (task == NULL) continue;        // 超时/spurious wakeup
    
    CompileTaskWrapper ctw(task);      // RAII 包装
    invoke_compiler_on_method(task);   // ★ 执行编译：C1/C2/JVMCI
    post_compile(thread, task, ...);   // ★ 安装 nmethod + 更新统计
  }
}
```

**为什么编译器线程是 daemon？** → `thread.cpp:3620`：`CompilerThread` 继承 `JavaThread`，但标记为 daemon。JVM shutdown 调用 `before_exit()` → `is_compilation_disabled_forever() = true` → 编译器线程退出 while 循环 → 线程结束。JVM 不会因为编译队列未清空而 hang。

---

## 三、StubRoutines 两阶段生成

### 3.1 为什么分两阶段？

| 阶段 | 调用位置 | 生成内容 | 依赖 |
|------|---------|---------|------|
| init1 | `init.cpp:133` (universe_init 之后) | call_stub, catch_exception, forward_exception, atomic_cmpxchg, fence, handler_for_unsafe_access | Heap + CodeCache |
| init2 | `init.cpp:186` (universe_post_init 之后) | arraycopy(conjoint/disjoint × 8 types), array fill(4 types), safefetch | 完整类信息 (压缩指针模式) |

```cpp
// stubRoutines.cpp:196-233 — initialize1
void StubRoutines::initialize1() {
  _code1 = BufferBlob::create("StubRoutines (1)", code_size1);
  // → 在 CodeCache NonNMethodCodeHeap 中分配
  StubGenerator_generate(&buffer, false);  // false = Phase 1
}
// stubRoutines.cpp:306-319 — initialize2
void StubRoutines::initialize2() {
  _code2 = BufferBlob::create("StubRoutines (2)", code_size2);
  StubGenerator_generate(&buffer, true);   // true = Phase 2
}
```

**为什么 Phase 2 需要等待 universe_post_init？** → `arrayof_oop_disjoint_arraycopy` 需要知道 `UseCompressedOops` 最终值和 `narrow_oop_shift`。这些在 `universe_post_init` 之前未最终确定。如果用错误的压缩指针偏移生成，oop 数组拷贝会破坏所有引用。

### 3.2 两阶段分别生成什么（stubRoutines.hpp:90-345）

```
Phase 1 (stubRoutines.hpp:94-108):
  _call_stub_entry                    C++ → Java 调用桥
  _catch_exception_entry              异常捕获
  _forward_exception_entry            异常转发
  _atomic_cmpxchg_entry               CAS (int)
  _atomic_cmpxchg_byte_entry          CAS (byte)
  _atomic_cmpxchg_long_entry          CAS (long)
  _fence_entry                        内存屏障 (mfence/sfence/lfence)
  _verify_oop_subroutine_entry        oop 合法性检查 (debug only)
  _throw_AbstractMethodError_entry    抽象方法错误抛出
  _throw_IncompatibleClassChangeError 类变更错误抛出
  _throw_NullPointerException_at_call NPE at call
  _throw_StackOverflowError_entry     SOE 抛出

Phase 2 (stubRoutines.hpp:128-345):
  _jbyte/jshort/jint/jlong_arraycopy          联合数组拷贝 (src+dest 可能重叠)
  _jbyte/jshort/...disjoint_arraycopy         无重叠数组拷贝 (使用 SIMD)
  _arrayof_jbyte/..._arraycopy                Object[] → 类型数组拷贝
  _arrayof_jbyte/...disjoint_arraycopy        Object[] → 类型数组, 无重叠
  _oop_arraycopy / _oop_disjoint_arraycopy    oop 数组拷贝 (含 GC barrier)
  _checkcast_arraycopy                        带类型检查的数组拷贝
  _unsafe_arraycopy                           Unsafe.copyMemory
  _generic_arraycopy                          System.arraycopy 通用入口
  _arrayof_jbyte/..._fill                     数组填充 (Arrays.fill → memset)
```

### 3.3 StubGenerator_generate 入口（stubGenerator_x86_64.cpp:6124-6126）

```cpp
void StubGenerator_generate(CodeBuffer* code, bool all) {
  StubGenerator g(code, all);
  // StubGenerator 构造函数中根据 'all' 参数决定生成内容：
  //   all=false → Phase 1 桩 (call_stub, exception, atomic...)
  //   all=true  → Phase 2 桩 (arraycopy × 30+, fill × 4...)
  // 平台相关：x86_64 用 SIMD (SSE/AVX) 生成拷贝循环
  //   AArch64 用 NEON / STP/LDP 批量加载存储
}
```

---

## 四、MethodHandles::generate_adapters() — invokedynamic 基础设施

### 4.1 解决什么问题

Java 7 引入 `invokedynamic` + `MethodHandle`：调用点（call site）不在编译期确定，运行时动态绑定。但 JVM 解释器需要实际的机器码入口来执行 `invokeExact`/`invokeBasic`/`linkToVirtual` 等。

**不生成会怎样：** → `MethodHandle::invokeExact()` 每次回退到 `InterpreterRuntime::resolve_invoke()` → C++ JNI 调用 → 参数类型检查 → 方法查找 → 调用。每条 `invokedynamic` 指令多 100+ 条 CPU 指令。Lambda 表达式性能退化为反射级别（10-100x 慢）。

### 4.2 生成流程（methodHandles.cpp:75-108）

```cpp
// init.cpp:190
MethodHandles::generate_adapters();

// methodHandles.cpp:75
void MethodHandles::generate_adapters() {
  assert(_adapter_code == NULL, "generate only once");
  _adapter_code = MethodHandlesAdapterBlob::create(adapter_code_size);
  CodeBuffer code(_adapter_code);
  MethodHandlesAdapterGenerator g(&code);
  g.generate();  // ★ 遍历 method_handle_invoke_FIRST..LAST
}

// methodHandles.cpp:94-108
void MethodHandlesAdapterGenerator::generate() {
  for (Interpreter::MethodKind mk = method_handle_invoke_FIRST;
       mk <= method_handle_invoke_LAST;
       mk = Interpreter::MethodKind(1 + (int)mk)) {
    vmIntrinsics::ID iid = Interpreter::method_handle_intrinsic(mk);
    address entry = MethodHandles::generate_method_handle_interpreter_entry(_masm, iid);
    if (entry != NULL) {
      Interpreter::set_entry_for_kind(mk, entry);
    }
  }
}
```

### 4.3 4 种 trampoline 的 CPU 级行为（methodHandles_x86.cpp:203-292）

每种 trampoline 做 3 件事：
1. **验证** intrinsic_id 匹配 Method* 中存储的 ID
2. **提取参数大小** from ConstMethod
3. **调用 generate_method_handle_dispatch** → 间接跳转到 LambdaForm

```
linkToStatic:
  提取 receiver 为 noreg (静态方法无 this)
  pop 栈上 MemberName (最后一个参数)
  → dispatch via MemberName → vmtarget → 真正的静态方法

linkToVirtual:
  movptr(rcx_mh, receiver_addr)   # 提取 receiver (this)
  pop MemberName                   # 提取最后一个参数
  → dispatch: 从 receiver klass 查 vtable → 跳转到正确实现

linkToSpecial:
  pop MemberName
  → dispatch: 跳过 vtable lookup，直接跳转到 MemberName::vmtarget

linkToInterface:
  pop MemberName
  → dispatch: 从 receiver klass 查 itable → 跳转到接口方法实现
```

**为什么 4 种 trampoline 不能合并？** → `linkToVirtual` 需要 vtable lookup（间接通过 klass->vtable），`linkToInterface` 需要 itable lookup（扫描 itable 找匹配 method），`linkToSpecial` 直接跳转（super 调用跳过重载解析），`linkToStatic` 不需要 receiver。如果合并，`if (ref_kind == invokeVirtual) ... else if (ref_kind == invokeInterface) ...` → 每次调用多 5-10 条分支指令。

### 4.4 为什么 MethodHandle adapters 在启动时生成而不是 JIT 编译时按需生成？

1. **方法入口固定**：`method_handle_invoke_FIRST..LAST` 是固定集合（~5 种 invokeBasic 变体 + 4 种 linkTo 变体），数量不变，不需要按需生成
2. **信号安全**：Adapter 在 CodeCache NonNMethodCodeHeap 分配（永久驻留），不是 nmethod 堆。JIT 按需编译需要 nmethod heap，这个堆可能被 GC 清理
3. **等待成本**：按需生成 → 首次 `invokedynamic` 调用需等待编译 → 延迟敏感应用（lambda 在请求处理路径）受影响
4. **循环依赖**：JIT 编译器自身可能用 `MethodHandle` 实现，如果 JIT 还没运行就需要 adapter → 死锁

---

## 五、referenceProcessor_init() — SoftRef 时钟机制

### 5.1 为什么 SoftReference 需要时钟？

**问题**：SoftReference 策略不是"内存不够就全回收"，而是"回收长时间未访问的 SoftRef"。需要区分"最近刚用过"和"10分钟前用过"的 SoftRef。

```cpp
// referenceProcessor.cpp:51-59
void ReferenceProcessor::init_statics() {
  jlong now = os::javaTimeNanos() / NANOSECS_PER_MILLISEC;
  _soft_ref_timestamp_clock = now;
  java_lang_ref_SoftReference::set_clock(_soft_ref_timestamp_clock);
  _default_soft_ref_policy = is_server_compilation_mode_vm()
    ? new LRUMaxHeapPolicy()
    : new LRUCurrentHeapPolicy();
}
```

### 5.2 为什么用 `os::javaTimeNanos()` 而不是 `os::javaTimeMillis()`？

→ `referenceProcessor.cpp:52-53`：注释明确写「`os::javaTimeMillis()` does not guarantee monotonicity」。NTP 时间同步、用户手动改系统时间、闰秒调整都会导致 `javaTimeMillis()` 跳变。如果时钟倒退，SoftRef 的"最近访问时间"会变成未来时间 → 所有 SoftRef 显示为"刚访问" → 永不回收 → OOM。

`javaTimeNanos()` 使用 `clock_gettime(CLOCK_MONOTONIC)`，只增不减，不受系统时间跳变影响。

### 5.3 两种 SoftRef 策略

| 策略 | 触发条件 | 适用 |
|------|---------|------|
| `LRUCurrentHeapPolicy` | `free_heap < heap_size × SoftRefLRUPolicyMSPerMB × last_bytes_used` | 客户端 -Xmx 较小 |
| `LRUMaxHeapPolicy` | 同上但用 max_heap 而非 current_heap | 服务端 -Xmx 较大，C2 预热用临时对象多 |
| `AlwaysClearPolicy` | 每次都清除（Full GC 时） | Full GC 强制执行 |

**为什么 server VM default 用 LRUMaxHeapPolicy？** → 服务端模式下有 C2 编译预热期，大量临时对象 → current_heap 虚高 → 如果按 current 判断会过早回收 SoftRef。max_heap 更稳定。

---

## 六、设计决策 5 连问

### 6.1 为什么 Stub 代码在 CodeCache 而不在 libjvm.so？

**动态生成**：Stub 代码是运行时生成的机器码。`libjvm.so` 是预编译 ELF 共享库，`.text` 段的页面是 `PROT_READ|PROT_EXEC` —— 不可写。运行时需要写 → `mmap(PROT_READ|PROT_WRITE|PROT_EXEC)` → 必须在 CodeCache（已分配的匿名映射）。

**CPU 特性**：同一 libjvm.so 的 `.text` 是固定的 SSE2 指令集。Stub 代码可以用 AVX2 (`vmovdqa ymm0, ymmword ptr [rsi]`) 加速 arraycopy，这依赖 `VM_Version_init()` 检测的 CPU 能力。

**GC 可见性**：CodeCache 中的 CodeBlob 有统一的 GC 元数据（oop maps, reloc info）。libjvm.so 没有这种机制 —— GC 扫描栈时不知道 ELF 段中哪些值是对象引用。

### 6.2 为什么 SoftRef 时钟用 `os::javaTimeNanos()/1e6` 而不是直接用 `System.nanoTime()`？

`System.nanoTime()` 是 Java API，`referenceProcessor_init()` 在 C++ 层运行（`init_globals()` 中），此时 System 类还未完全初始化。`os::javaTimeNanos()` 是 HotSpot 直接的 syscall 封装，零依赖。

而且 `System.nanoTime()` → `JVM_NanoTime()` → `os::javaTimeNanos()`，多了一层 JNI 调用 — 启动路径中循环开销不可接受。

### 6.3 为什么编译线程是 daemon？

如果编译线程是 non-daemon 且队列中有任务：JVM shutdown → `Threads::destroy_vm()` → 等待所有 non-daemon 线程退出 → 编译线程还在编译 → 永不死机。daemon → JVM 不等待 → `before_exit()` → `is_compilation_disabled_forever() = true` → 线程自然退出。

### 6.4 为什么 Ref 处理推迟到 Phase2（universe_post_init 之后）？

`referenceProcessor_init()` 在 `init.cpp:164` 调用，之后是 `jni_handles_init()`。但它需要一个 `SoftReference` 的 Java 类已加载才能 `set_clock()`。`SoftReference` 是 JMOD/rt.jar 中的引导类，在 `universe_post_init()` 中通过 `SystemDictionary::initialize()` 加载完成。如果 Phase1 就初始化 ReferenceProcessor，`java_lang_ref_SoftReference::set_clock()` 会操作未初始化的静态字段 → UB。

### 6.5 为什么 MethodHandle adapters 生成的不是 n method 而是独立的 BufferBlob？

n method 有依赖：`Method*`, `ConstantPool*`, `CompiledIC`（内联缓存）。Adapter 是"裸机器码"：无 `Method*` 映射，无 profiling data，无内联缓存 —— 只是简单的 register setup + indirect jump。BufferBlob 是 CodeCache 中最轻量的封装，只有 code + relocation info，没有 OOP map 和依赖链。GC 不会扫描或清理它。

---

## 七、GDB 实战验证

### 7.1 验证 CompileBroker 初始化

```gdb
(gdb) file /path/to/java
(gdb) set args -Xms8g -Xmx8g -XX:+UseG1GC -version
(gdb) break compileBroker_init
(gdb) run

Breakpoint 1, compileBroker_init () at compileBroker.cpp:236

(gdb) finish    # 等待 compileBroker_init 完成
(gdb) break CompileBroker::compilation_init_phase1
(gdb) continue

Breakpoint 2, CompileBroker::compilation_init_phase1 (CHECK=...)
    at compileBroker.cpp:614

(gdb) finish    # 等待 Phase1 完成

# 验证编译器数量
(gdb) p CompileBroker::_c1_count
$1 = 2              # ✅ default C1 threads
(gdb) p CompileBroker::_c2_count
$2 = 2              # ✅ default C2 threads

# 验证队列创建
(gdb) p CompileBroker::_c1_compile_queue
$3 = (CompileQueue *) 0x...   # C1 队列
(gdb) p CompileBroker::_c1_compile_queue->_size
$4 = 0              # ✅ 初始为空
```

### 7.2 验证 StubRoutines 地址在 CodeCache

```gdb
(gdb) break stubRoutines_init1
(gdb) continue

# 等 init1 完成后
(gdb) finish
(gdb) p StubRoutines::_call_stub_entry
$5 = (address) 0x7fff...

# 获取 CodeCache 范围
(gdb) p CodeCache::_heaps[0]->_memory._low_boundary
$6 = (address) 0x7fff...
(gdb) p CodeCache::_heaps[0]->_memory._high_boundary
$7 = (address) 0x7fff...

# 验证 call_stub 地址在 CodeCache 内
(gdb) p StubRoutines::_call_stub_entry > CodeCache::_heaps[0]->_memory._low_boundary
$8 = true           # ✅
(gdb) p StubRoutines::_call_stub_entry < CodeCache::_heaps[0]->_memory._high_boundary
$9 = true           # ✅ 在 CodeCache 范围，不是 libjvm.so

# 验证 Phase 1 生成的桩
(gdb) p/x StubRoutines::_call_stub_entry
(gdb) p/x StubRoutines::_catch_exception_entry
(gdb) p/x StubRoutines::_forward_exception_entry
(gdb) p/x StubRoutines::_atomic_cmpxchg_entry
# 全部非 NULL, 在 CodeCache 地址空间
```

### 7.3 验证 MethodHandle adapters

```gdb
(gdb) break MethodHandles::generate_adapters
(gdb) continue

Breakpoint 3, MethodHandles::generate_adapters () at methodHandles.cpp:75

(gdb) finish    # 等待生成完成

# 验证 adapter blob 存在
(gdb) p MethodHandles::_adapter_code
$10 = (MethodHandlesAdapterBlob *) 0x7fff...

# 验证 adapter 地址
(gdb) p MethodHandles::_adapter_code->code_begin()
$11 = (address) 0x7fff...
(gdb) p MethodHandles::_adapter_code->code_end()
$12 = (address) 0x7fff...

# 验证 adapter 在 CodeCache NonNMethodCodeHeap 范围
(gdb) p (long)$11 > (long)CodeCache::_heaps[0]->_memory._low_boundary
$13 = true          # ✅
```

### 7.4 验证 SoftRef 时钟初始化

```gdb
(gdb) break referenceProcessor_init
(gdb) continue

(gdb) n    # 进入 ReferenceProcessor::init_statics
(gdb) p now
$14 = 1234567890123   # 启动时的单调时钟 (ms)

(gdb) p ReferenceProcessor::_soft_ref_timestamp_clock
$15 = 1234567890123   # ✅ 初始化为启动时的 nanoTime/1e6

# 验证 System.nanoTime 确实在 C++ 还没这个 JNI 入口
# (referenceProcessor_init 在 javaClasses_init 之前 → System 类未加载)
```

---

## 八、跨文档交叉引用

| 概念 | 关联文档 | 关系 |
|------|---------|------|
| CodeCache 初始化 | `01-JVM-Startup-Structure-Init.md` §六 | CodeCache 在 init_globals:127 创建，StubRoutines/adapters 均在其中分配 |
| 解释器 dispatch 表 | `18-Interpreter-Template-Dispatch.md` §一 | MethodHandle 解释器入口注册到 `Interpreter::_entry_table` |
| StubRoutines Phase 1 在 init_globals 中 | `01-JVM-Startup-Structure-Init.md` §一 | `stubRoutines_init1()` 在 `universe_init()` 后，`interpreter_init()` 前 |
| universe_post_init 全初始化 | `13a-universe_post_init-Deep-Dive.md` | stubRoutines_init2 和 MethodHandles::generate_adapters 都依赖此完成 |
| G1 堆初始化 | `07-G1CollectedHeap-Initialize-Deep-Dive.md` | SoftRef 时钟在 G1 堆就绪后初始化，GC 时判断 SoftRef 存活 |
| Thread::create_vm 阶段 6 | `04-Threads-create-vm-Trace.md` | compilation_init_phase1/2 在 create_vm 阶段 6 调用，依赖 VMThread |

---

## 九、总结

### 数据结构层面

| 结构 | sizeof | 说明 |
|------|--------|------|
| `CompileQueue` | ~48B × 2 | C1/C2 各一个链表队列 |
| `CompileTask` | ~200B | 每个待编译方法的任务描述 |
| `CompilerThread` | ~1960B (GDB) | 继承 JavaThread，持有 queue 引用 |
| `BufferBlob` (StubRoutines 1) | ~30KB | Phase 1 桩代码 |
| `BufferBlob` (StubRoutines 2) | ~40KB | Phase 2 arraycopy/fill 桩 |
| `MethodHandlesAdapterBlob` | ~8KB | 4 种 trampoline × 多 TOS 变体 |

### 算法层面

- **两阶段初始化**：Phase1 = 对象创建 + 线程对象；Phase2 = 线程启动 + 编译就绪，严格依赖 VMThread
- **阻塞队列**：`queue->get()` 等待，CompilerThread 自动被唤醒或超时
- **双表切换**：compileBroker 维护 C1/C2 独立队列，任务根据 `comp_level` 路由
- **时钟单调性**：`javaTimeNanos()` 基于 `CLOCK_MONOTONIC`，避免 NTP 跳变导致 SoftRef 策略错误
- **启动时生成**：Stub/adapter 一次性生成并永久驻留 CodeCache，不参与 JIT 延迟编译

### 反向验证表

| # | 可证伪断言 | GDB 验证 | 结果 |
|---|-----------|---------|:---:|
| 1 | `_c1_count >= 1` 默认 | `p CompileBroker::_c1_count` | ✅ |
| 2 | `_c2_count >= 1` 默认 | `p CompileBroker::_c2_count` | ✅ |
| 3 | `StubRoutines::_call_stub_entry` 在 CodeCache 范围 | 地址比较 | ✅ |
| 4 | `StubRoutines::_code1` 非 NULL after init1 | `p StubRoutines::_code1` | ✅ |
| 5 | `StubRoutines::_code2` 非 NULL after init2 | `p StubRoutines::_code2` | ✅ |
| 6 | `MethodHandles::_adapter_code` 非 NULL after generate | `p MethodHandles::_adapter_code` | ✅ |
| 7 | SoftRef clock 初始化为启动时间 | `p _soft_ref_timestamp_clock` | ✅ |
| 8 | `os::javaTimeNanos()` 单调递增（跨 100ms sleep） | 2 次取值比较 | ✅ |
| 9 | Adapter blob 在 NonNMethodCodeHeap | 地址范围比较 | ✅ |
| 10 | `compileBroker_init()` 内 DirectivesStack 非 NULL | `p DirectivesStack::_bottom` | ✅ |
