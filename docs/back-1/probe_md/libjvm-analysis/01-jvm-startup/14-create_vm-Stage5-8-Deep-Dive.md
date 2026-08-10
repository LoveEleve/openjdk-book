⚠️ 本文档已被 17-call_initPhase2-3-Deep-Dive.md 替代。如需了解 Phase 5-8 详情，请直接阅读 17。

# create_vm() 阶段 5~8 — 从 VMThread 到 Live Phase

> OpenJDK 11 slowdebug
> 覆盖：VMThread 创建 → 核心 Java 类加载 → 编译器初始化 → Module 系统 → Live Phase → WatcherThread
> 时间线：~0.4s → ~2.0s（占总启动时间 87%）

---

## 零、GDB 验证 ✅

```
sizeof(VMThread)      = 888
sizeof(InstanceKlass) = 472
sizeof(ConstantPool)  = 72
sizeof(ReferenceProcessor) = 96
CICompilerCount       = 4       (= _c1_count + _c2_count)
_fully_initialized    = 1       (true, live phase 之后)
_init_completed       = 1       (true, stage5 后设置)
```

---

## 一、日志时间线

```
[0.226s] init_globals() completed
[0.230s] === PHASE: Core Java class loading (Object/Class/String/Thread) ===
[0.234s] set_init_completed() — basic VM init done
[0.422s] === PHASE: Compiler initialization (C1/C2/JVMCI) ===
[0.428s] === PHASE: Module system init — call_initPhase2 ===
[2.177s] === PHASE: Final system init — call_initPhase3 ===
[2.178s] === PHASE: Entering live phase — JVMTI post_vm_initialized ===
[2.184s] === PHASE: create_vm complete — JVM ready for application ===

耗时分解：
  阶段5 (核心类):    ~4ms
  阶段6 (编译器):    ~190ms
  阶段7 (Module):    ~1750ms  ← 占总时间 87%！
  阶段8 (Live):      ~6ms
```

---

## 二、VMThread 创建（L4102~L4124）— GC 协调器诞生

```cpp
// thread.cpp:4107
VMThread::create();
Thread * vmthread = VMThread::vm_thread();

os::create_thread(vmthread, os::vm_thread);  // pthread_create → 进入 VMThread::loop()

// ★ 等待 VMThread 就绪
{
    MutexLocker ml(Notify_lock);
    os::start_thread(vmthread);
    while (vmthread->active_handles() == NULL) {
        Notify_lock->wait();  // 阻塞等待 VMThread 完成初始化
    }
}
```

**为什么 VMThread 必须在 init_globals 之后创建？**
→ `init_globals()` 中 `mutex_init()` 创建了 `VMOperationQueue_lock` 等 VMThread 需要的锁
→ 必须先有锁，才能安全启动 VMThread 的事件循环

**VMThread 做什么？**
→ `VMThread::loop()` 是 JVM 的"后台总管"：
  1. `VMOperationQueue_lock->wait()`  — 等待 VM 操作入队
  2. 取出 VM_Operation（如 GC / DumpHeap / PrintThreads）
  3. 如果是 Safepoint 操作 → 调用 `SafepointSynchronize::begin()`
  4. 执行操作的 `doit()` → 调用 `SafepointSynchronize::end()`

---

## 三、阶段 5：核心 Java 类加载（L4150~L4163）

```cpp
// thread.cpp:4150
INST_PHASE_RUNTIME("Core Java class loading (Object/Class/String/Thread)");
initialize_java_lang_classes(main_thread, CHECK_JNI_ERR);
```

**`initialize_java_lang_classes()` 内部做的事**：

```
① 加载 java.lang.Object 的 Java 镜像
   → SystemDictionary::Object_klass() 已有 Klass（universe2_init 加载的）
   → 但还没有 Java 层面的 Class<Object> 对象
   → java_lang_Class::create_mirror() 创建镜像对象
   
② 加载 java.lang.Class
   → 同上：Klass 已存在，创建 Java 镜像
   
③ 加载 java.lang.String
   → 创建 String 类的镜像
   → 初始化 String 池（StringTable）
   
④ 加载 java.lang.Thread
   → 主线程现在是 C++ 的 JavaThread 对象
   → 但 Java 层面还没有 Thread 对象
   → 创建 java.lang.Thread 对象并关联到 main_thread
   → 这样 Thread.currentThread() 才能返回有效的 Thread 对象
   
⑤ 初始化 System 类
   → System.in / System.out / System.err → setIn0/setOut0/setErr0
   → System.initializeSystemClass() → 这个调用会触发大量类加载！
```

```cpp
quicken_jni_functions();   // 优化 JNI 函数表（用快路径替换慢路径）
StubCodeDesc::freeze();    // 不再生成新的 Stub 代码
set_init_completed();      // _init_completed = true
                           // ★ 从此刻起，异常处理 / assert 可以正常工作
```

---

## 四、日志系统双阶段切换（L4165~L4171）

```cpp
LogConfiguration::post_initialize();     // Unified logging 完全就绪
InstrumentLog::mark_jvm_logging_ready(); // ★ 此后 INST_LOG 走 -Xlog 通道
```

**为什么需要这个切换？**
→ init_globals() 阶段 `LogConfiguration::initialize()` 还没完成
→ 早期 INST_LOG 走文件日志（`/tmp/jvm_instrument_<pid>.log`）
→ `post_initialize()` 后 unified logging 就绪 → INST_LOG 走 stdout（`-Xlog`）
→ 这就是为什么启动日志分两段：早期在文件中，晚期在 stdout 中

---

## 五、阶段 6：编译器初始化（L4207~L4239）

```cpp
// thread.cpp:4208
INST_PHASE_RUNTIME("Compiler initialization (C1/C2/JVMCI)");

CompileBroker::compilation_init_phase1(CHECK_JNI_ERR);
// ★ Phase1：创建 compiler thread 对象（不启动线程）
//   内部：
//     _c1_count = 2, _c2_count = 2 (CICompilerCount=4, GDB)
//     创建 CompilerThread × 4（2 C1 + 2 C2）
//     每个线程分配 CompileQueue（c1_queue / c2_queue）

CompileBroker::compilation_init_phase2();
// ★ Phase2：启动 compiler 线程
//   每个 CompilerThread → os::create_thread → 进入 compiler_thread_entry()
//   线程等待编译任务入队

initialize_jsr292_core_classes(CHECK_JNI_ERR);
// 预初始化 MethodHandle / MethodType / CallSite 等 JSR292 类
// 为什么？→ 避免后续 class loading 死锁
//   这些类的方法可能在解释器中被内联，编译时需要 Klass 已就绪
```

**为什么分 Phase1/2？**
→ Phase1 创建线程对象（需要 heap 完成）
→ Phase2 启动线程（需要 init_globals 完成 + VMThread 运行）
→ 两步之间有依赖：Phase2 中 compiler thread 可能触发 safepoint，VMThread 必须已运行

---

## 六、阶段 7：Module 系统（L4243~L4264）— 最耗时的阶段

```cpp
// thread.cpp:4243-4264
INST_PHASE_RUNTIME("Module system init — call_initPhase2");
call_initPhase2(CHECK_JNI_ERR);
// ★ 初始化 Java 模块系统（ModuleLayer）
//   内部会加载 java.base 模块的所有导出类
//   这是最耗时的步骤：~1.75s
//   因为会触发大量类加载——java.base 包含 1000+ 个类！

INST_PHASE_RUNTIME("Final system init — call_initPhase3");
call_initPhase3(CHECK_JNI_ERR);
// ★ 继续模块系统初始化
//   + 安全管理器初始化
//   + 系统类加载器初始化

SystemDictionary::compute_java_loaders(CHECK_JNI_ERR);
// 缓存 _java_system_loader 和 _java_platform_loader
// 调用 ClassLoader.getSystemClassLoader() (Java 方法)
```

**为什么 Module 系统要 1.75 秒？**
→ `call_initPhase2()` 内部调用 Java 方法 `ModuleBootstrap.boot()`
→ 这会触发大量 ClassFileParser → SystemDictionary → link → init 流程
→ java.base 模块包含 java.lang / java.util / java.io 等 1000+ 类
→ 每个类都需要：解析字节码 → 创建 InstanceKlass → 链接 → 初始化虚表
→ 这就是 Java 启动慢的根源——不是 JVM C++ 代码慢，是类加载慢

---

## 七、阶段 8：Live Phase（L4282~L4340）

```cpp
// thread.cpp:4282-4340
INST_PHASE_RUNTIME("Entering live phase — JVMTI post_vm_initialized");
JvmtiExport::enter_live_phase();         // JVMTI 环境进入 live 阶段
JvmtiExport::post_vm_initialized();      // 通知 agent：VM 初始化完成

Management::initialize(THREAD);          // JMX Management Bean 初始化
StatSampler::engage();                   // 性能统计采样
BiasedLocking::init();                   // 偏向锁初始化

// WatcherThread 启动（如果 PeriodicTask 已注册）
{
    MutexLocker ml(PeriodicTask_lock);
    WatcherThread::make_startable();
    if (PeriodicTask::num_tasks() > 0) {
        WatcherThread::start();           // 创建 WatcherThread
    }
}

create_vm_timer.end();
INST_LOG_RUNTIME("Threads::create_vm() EXIT — vm_init_time=%.3fs", os::elapsedTime());
INST_PHASE_RUNTIME("create_vm complete — JVM ready for application");

return JNI_OK;
```

**Live Phase 之后，JVM 可以做什么？**
→ Java 主线程可以开始执行 `main()` 方法
→ JIT 编译器可以开始编译热点方法
→ GC 可以正常触发（Young GC / Mixed GC）
→ JVMTI agent 可以访问所有 JVM 状态

---

## 八、总结

| 阶段 | 核心操作 | 耗时 | 占比 |
|------|---------|------|------|
| VMThread | GC/Safepoint 协调器启动 | ~4ms | 0.2% |
| 阶段5 | Object/Class/String/Thread Java镜像 | ~4ms | 0.2% |
| 阶段6 | C1/C2 编译器线程创建+启动 | ~190ms | 9.5% |
| 阶段7 | **Module 系统 + 1000+类加载** | **~1750ms** | **87.5%** |
| 阶段8 | Live Phase + WatcherThread | ~6ms | 0.3% |
| **总计** | | **~2.0s** | |

### 关键发现

- **Module 系统是启动耗时的主犯**（87.5%）——不是 C++ 初始化慢，是 1000+ 个 Java 类的加载慢
- **两阶段日志切换**在阶段5完成——`InstrumentLog::mark_jvm_logging_ready()`
- **VMThread 是 JVM 的异步操作总线**——所有 GC、Safepoint、Dump 操作都通过它协调
- **编译器线程启动但不工作**——等待首次方法调用触发编译
