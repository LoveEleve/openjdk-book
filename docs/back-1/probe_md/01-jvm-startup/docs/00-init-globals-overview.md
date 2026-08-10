# 00-init-globals-overview — init_globals() 30 调用全链路总览与学习地图

> **Phase**: 01-jvm-startup
> **定位**: init_globals() 是 JVM 启动的"心脏"——在 `Threads::create_vm()` Stage 7 执行，按严格顺序初始化 30 个子系统
> **配套**: [00-JNI-CreateJavaVM]（init_globals 在 create_vm 全流程中的位置）
> **后续依赖本文**: 01-17 所有文档（本文是学习路线导航页）
> **阅读收益**: 理解为什么 init_globals 的 30 个调用必须按此精确顺序执行，掌握每个调用的前置依赖、失败短路路径、以及各个子系统间的数据流向

---

## §〇 核心问题：为什么 init_globals 的调用顺序不能乱？

```cpp
// src/hotspot/share/runtime/init.cpp:109-212
jint init_globals() {
  HandleMark hm;                          // RAII: 函数结束时自动释放 Handle
  management_init();                      // 1. JMX 管理接口
  bytecodes_init();                       // 2. 字节码表
  classLoader_init1();                    // 3. 类加载器第一阶段
  compilationPolicy_init();               // 4. 编译策略
  codeCache_init();                       // 5. 代码缓存（所有桩代码的载体）
  VM_Version_init();                      // 6. CPU 特性检测
  os_init_globals();                      // 7. OS 全局（空）
  stubRoutines_init1();                   // 8. 第一批桩代码
  jint status = universe_init();          // 9. 堆+元空间+符号表+String表
  if (status != JNI_OK) return status;    //    失败直接短路
  gc_barrier_stubs_init();                // 10. GC 屏障桩
  interpreter_init();                     // 11. 解释器
  invocationCounter_init();               // 12. 调用计数器
  accessFlags_init();                     // 13. 访问标志
  templateTable_init();                   // 14. 模板表
  InterfaceSupport_init();                // 15. 接口支持
  VMRegImpl::set_regName();               // 16. 寄存器名称
  SharedRuntime::generate_stubs();        // 17. 共享运行时桩
  universe2_init();                       // 18. Universe 第二阶段
  javaClasses_init();                     // 19. 核心类偏移量
  referenceProcessor_init();              // 20. 引用处理器
  jni_handles_init();                     // 21. JNI 句柄
  vmStructs_init();                       // 22. VM 结构体导出
  vtableStubs_init();                     // 23. 虚表桩
  InlineCacheBuffer_init();               // 24. IC 缓冲
  compilerOracle_init();                  // 25. 编译指令解析
  dependencyContext_init();               // 26. 依赖上下文
  if (!compileBroker_init())              // 27. 编译代理
    return JNI_EINVAL;                    //    失败 → JNI_EINVAL
  if (!universe_post_init())              // 28. Universe 后初始化
    return JNI_ERR;                       //    失败 → JNI_ERR
  stubRoutines_init2();                   // 29. 桩代码第二阶段
  MethodHandles::generate_adapters();     // 30. MH 适配器
  return JNI_OK;
}
```

**顺序的约束来自数据依赖链**：

```
management_init ──────────────────────────────────────────────────────────────┐
  └→ 创建 PerfData 计数器（后续所有子系统使用）                                │
                                                                              │
bytecodes_init ───────────────────────────────────────────────────────────────┤
  └→ 填充字节码元数据表（interpreter_init 需要）                               │
                                                                              │
classLoader_init1 ────────────────────────────────────────────────────────────┤
  └→ 加载 zip 库 + 设置 bootstrap 搜索路径（universe_post_init 加载类时需要）  │
                                                                              │
compilationPolicy_init ───────────────────────────────────────────────────────┤
  └→ 选择编译策略（codeCache_init 的行为依赖策略）                             │
                                                                              │
codeCache_init ───────────────────────────────────────────────────────────────┤
  └→ 分配 CodeCache 三段内存（所有后续桩代码的载体）                            │
                                                                              │
VM_Version_init ──────────────────────────────────────────────────────────────┤
  └→ 检测 CPU 特性（stubRoutines 的汇编路径选择依赖此结果）                     │
                                                                              │
stubRoutines_init1 ───────────────────────────────────────────────────────────┤
  └→ 生成原子操作桩（universe_init 中的 oop 验证需要 atomic_xchg）             │
                                                                              │
universe_init ★★★★★ ─────────────────────────────────────────────────────────┤
  └→ 创建 Heap + Metaspace + SymbolTable + StringTable                        │
  └→ 失败则整个 init_globals 短路返回                                         │
                                                                              │
gc_barrier_stubs_init ────────────────────────────────────────────────────────┤
  └→ 依赖 universe_init 设置 BarrierSet（G1 SATB 屏障等）                      │
                                                                              │
interpreter_init ─────────────────────────────────────────────────────────────┤
  └→ 在 CodeCache 中生成解释器 codelet（依赖 bytecodes_init + codeCache_init） │
                                                                              │
universe2_init ───────────────────────────────────────────────────────────────┤
  └→ 创建 8 种 TypeArrayKlass（依赖 Metaspace，在类加载之前）                  │
                                                                              │
javaClasses_init ─────────────────────────────────────────────────────────────┤
  └→ 计算 28 个核心类的字段偏移（依赖 universe2_init 创建 Klass）              │
                                                                              │
jni_handles_init ─────────────────────────────────────────────────────────────┤
  └→ 创建 OopStorage（依赖 universe_init 创建堆）                              │
                                                                              │
compileBroker_init ───────────────────────────────────────────────────────────┤
  └→ 初始化编译指令栈（依赖 compilerOracle_init 解析 CompileCommand）          │
  └→ 失败 → JNI_EINVAL                                                        │
                                                                              │
universe_post_init ───────────────────────────────────────────────────────────┤
  └→ 加载系统类 + 预分配异常 + vtable 重初始化                                 │
  └→ 依赖 compileBroker_init（编译器就绪后才能加载类）                          │
  └→ 失败 → JNI_ERR                                                           │
                                                                              │
stubRoutines_init2 ───────────────────────────────────────────────────────────┤
  └→ 生成 arraycopy/AES/SHA intrinsic（依赖 VM_Version_init + universe_init）  │
```

---

## §一 30 调用全景图（按执行顺序）

### 阶段 1: 基础设施层（#1-#5）

| # | 调用 | 行号 | 做什么 | 前置依赖 | 文档 |
|---|------|------|--------|---------|------|
| 1 | `management_init()` | 119 | 创建 JMX 接口、注册 22+ PerfData 计数器、DCmd 命令注册 | 无（PerfMemory 已在 vm_init_globals 中初始化） | [13-Management-Services] |
| 2 | `bytecodes_init()` | 120 | 填充 6 个静态数组（`_name[256]`, `_result_type[256]`, `_depth[256]`, `_lengths[256]`, `_java_code[256]`, `_flags[512]`） | 无 | [14-Interpreter-Bytecodes-TemplateTable] |
| 3 | `classLoader_init1()` | 123 | 30 PerfData 计数器 + 7 dlsym zip 函数指针 + bootstrap 搜索路径 | PerfMemory 就绪 | [22-ClassLoader-Init] ✅ |
| 4 | `compilationPolicy_init()` | 124 | 3 策略 switch → SimpleCompPolicy/StackWalkCompPolicy/TieredThresholdPolicy | 无 | [20-Compilation-Pipeline] §2 ✅ |
| 5 | `codeCache_init()` | 127 | CodeCache 三段堆 + CodeBlob 5 层体系 + nmethod 14 段布局 + Sweeper | compilationPolicy_init | [01-CodeCache] |

### 阶段 2: 运行时核心层（#6-#9）

| # | 调用 | 行号 | 做什么 | 前置依赖 | 文档 |
|---|------|------|--------|---------|------|
| 6 | `VM_Version_init()` | 131 | CPU 特性检测（cpuid 指令 → SSE/AVX/AES/RTM 等标志位） | 无 | [18-VM-Version-CPU-Detection] ✅ |
| 7 | `os_init_globals()` | 132 | 当前为空方法，预留 OS 层全局初始化扩展点 | 无 | ⚪ 空方法 |
| 8 | `stubRoutines_init1()` | 133 | 生成原子操作桩（atomic_xchg/cmpxchg/add）+ verify_oop 桩 | codeCache_init | [15-StubRoutines-SharedRuntime] |
| 9 | `universe_init()` | 137 | **最核心调用**：创建 G1CollectedHeap + Metaspace + SymbolTable + StringTable + G1Policy + G1ConcurrentMark | codeCache_init + stubRoutines_init1 | [02][03][04][05][08][09] |

> **错误路径**: `universe_init()` 返回非 `JNI_OK` → 直接 `return status`（行 139-140），跳过后续所有初始化。

### 阶段 3: 解释器层（#10-#17）

| # | 调用 | 行号 | 做什么 | 前置依赖 | 文档 |
|---|------|------|--------|---------|------|
| 10 | `gc_barrier_stubs_init()` | 144 | 通过双重虚函数分派调用当前 GC 的 barrier stub 生成器（G1 SATB 预写屏障） | universe_init 设置 BarrierSet | [16-Universe-Post-Init] |
| 11 | `interpreter_init()` | 145 | 在 CodeCache NonNMethod 段创建 StubQueue，生成 ~256 codelet + 方法入口 + 返回入口 | bytecodes_init + codeCache_init | [14-Interpreter-Bytecodes-TemplateTable] |
| 12 | `invocationCounter_init()` | 148 | 32 位单字编码 + 双状态机 + OSR 阈值补偿 | 无 | [20-Compilation-Pipeline] §1 ✅ |
| 13 | `accessFlags_init()` | 149 | assert `sizeof(AccessFlags) == sizeof(jint)` | 无 | [14-Interpreter-Bytecodes-TemplateTable] |
| 14 | `templateTable_init()` | 150 | 初始化 256 字节码的 Template 对象（flags + TosState 转换 + generator 函数指针） | 无 | [14-Interpreter-Bytecodes-TemplateTable] |
| 15 | `InterfaceSupport_init()` | 151 | 仅在 ASSERT 构建中设置 GC 压力测试种子 `srand(ScavengeALotInterval * FullGCALotInterval)` | 无 | [14-Interpreter-Bytecodes-TemplateTable] |
| 16 | `VMRegImpl::set_regName()` | 152 | 遍历 GPR(32)+FPR(16)+XMM(512)+KREG(8) → 填充 `regName[569]` 数组 | 无 | [14-Interpreter-Bytecodes-TemplateTable] |
| 17 | `SharedRuntime::generate_stubs()` | 153 | 生成 deopt blob + uncommon trap blob + exception blob + safepoint blob | codeCache_init + interpreter_init | [15-StubRoutines-SharedRuntime] |

### 阶段 4: 类型系统层（#18-#22）

| # | 调用 | 行号 | 做什么 | 前置依赖 | 文档 |
|---|------|------|--------|---------|------|
| 18 | `universe2_init()` | 157 | `Universe::genesis()`: 8 种 TypeArrayKlass + SystemDictionary + 5 空元数据数组 | universe_init | [21-Universe-Type-System] §1 ✅ |
| 19 | `javaClasses_init()` | 161 | `JavaClasses::compute_offsets()`: 28 个核心类字段偏移 | universe2_init | [21-Universe-Type-System] §2 ✅ |
| 20 | `referenceProcessor_init()` | 164 | `ReferenceProcessor::init_statics()`: 获取单调时钟 + 选择软引用 LRU 策略 | 无 | [16-Universe-Post-Init] |
| 21 | `jni_handles_init()` | 165 | 创建 2 个 OopStorage 实例（global/weak_global）+ JNIHandleBlock 分配块 | universe_init（堆存在） | [10-JNIHandle-CompileQueue-JVMTI] |
| 22 | `vmStructs_init()` | 167 | 导出 C++ 结构体布局给 SA 调试代理（仅 `INCLUDE_VM_STRUCTS` 编译） | 无 | [19-vmStructs-SA-Debug-Infra] ✅ |

### 阶段 5: 编译底座层（#23-#30）

| # | 调用 | 行号 | 做什么 | 前置依赖 | 文档 |
|---|------|------|--------|---------|------|
| 23 | `vtableStubs_init()` | 170 | 创建 256 槽哈希表用于缓存虚方法分派桩代码 | codeCache_init | [17-VTable-IC-Compiler-Infra] |
| 24 | `InlineCacheBuffer_init()` | 173 | 创建 10KB StubQueue 用于 IC 更新 stub | codeCache_init | [17-VTable-IC-Compiler-Infra] |
| 25 | `compilerOracle_init()` | 174 | 解析 `-XX:CompileCommand` 和 `.hotspot_compiler` 文件 | 无 | [17-VTable-IC-Compiler-Infra] |
| 26 | `dependencyContext_init()` | 175 | 创建 4 个 PerfCounter 追踪 nmethod 依赖桶的分配/释放/过期 | 无 | [17-VTable-IC-Compiler-Infra] |
| 27 | `compileBroker_init()` | 177 | CompilationLog + DirectivesStack + 指令文件解析（失败 → JNI_EINVAL） | compilerOracle_init | [20-Compilation-Pipeline] §3 ✅ |

> **错误路径**: `compileBroker_init()` 返回 `false` → `return JNI_EINVAL`（行 178-179）

| # | 调用 | 行号 | 做什么 | 前置依赖 | 文档 |
|---|------|------|--------|---------|------|
| 28 | `universe_post_init()` | 183 | 6 阶段：vtable/itables 重初始化 + 10 异常预分配 + known methods 缓存 | compileBroker_init | [21-Universe-Type-System] §3 ✅ |

> **错误路径**: `universe_post_init()` 返回 `false` → `return JNI_ERR`（行 184-185）

| # | 调用 | 行号 | 做什么 | 前置依赖 | 文档 |
|---|------|------|--------|---------|------|
| 29 | `stubRoutines_init2()` | 186 | 生成 arraycopy 24 入口 + AES/SHA intrinsic + CRC32 intrinsic | VM_Version_init + universe_post_init | [15-StubRoutines-SharedRuntime] |
| 30 | `MethodHandles::generate_adapters()` | 190 | 生成 MethodHandle 调用适配器桩代码（invokeBasic/linkToVirtual 等） | stubRoutines_init2 | [15-StubRoutines-SharedRuntime] |

---

## §二 init_globals 环境上下文

### 2.1 在 create_vm 全流程中的位置

```
create_vm() 10 个 Stage（详见 00-JNI-CreateJavaVM）:

Stage 0: JNI 入口验证 + VM_Version::early_initialize()
Stage 1: os::init()                    — OS 层初始化（信号、线程、时钟）
Stage 2: Threads::create_vm_init()     — VM 全局锁 + 性能计数器
Stage 3: outputStream_init()           — 日志输出初始化
Stage 4: vm_init_globals()             — 类型验证 + ChunkPool + EventLog
Stage 5: Agent 库加载                  — -agentlib/-agentpath
Stage 6: 主线程附加为 JavaThread       — Threads::attach_main_thread()
Stage 7: init_globals() ★ 本文         — 30 个子系统按序初始化
Stage 8: compilation_init_phase1/2()   — 编译器线程启动
Stage 9: 系统类加载 + 初始化           — SystemDictionary::initialize()
Stage 10: Live Phase                    — JVM 进入正常运行状态
```

### 2.2 前置条件（init_globals 被调用时已就绪的）

| 已就绪 | 由谁初始化 | 文档 |
|--------|-----------|------|
| ~90 个全局锁（Mutex/Monitor） | `vm_init_globals()` → `mutex_init()` | [06-Mutex] |
| PerfMemory 共享内存 | `vm_init_globals()` → `perfMemory_init()` | [07-PerfMemory] |
| ChunkPool 4 层分配器 | `vm_init_globals()` → `chunkpool_init()` | [12-vm-init-globals-basic-infra] |
| 基本类型大小验证（jbyte=1..jlong=8） | `vm_init_globals()` → `basic_types_init()` | [12-vm-init-globals-basic-infra] |
| EventLog 4 事件日志 | `vm_init_globals()` → `eventlog_init()` | [12-vm-init-globals-basic-infra] |
| 主线程已附加为 JavaThread | Stage 6: `Threads::attach_main_thread()` | [00-JNI-CreateJavaVM] |
| HandleMark 保护 | init_globals() 自身创建（行 110） | — |

### 2.3 错误短路路径（3 个）

```
init_globals() 开始
  │
  ├─ #1-#8: 无错误返回（全部 void）                      ← 不检查
  │
  ├─ #9 universe_init() → jint
  │   └─ status != JNI_OK → return status ────────────→ 短路！跳过 #10-#30
  │
  ├─ #10-#26: 无错误返回（全部 void）                     ← 不检查
  │
  ├─ #27 compileBroker_init() → bool
  │   └─ false → return JNI_EINVAL ───────────────────→ 短路！跳过 #28-#30
  │
  ├─ #28 universe_post_init() → bool
  │   └─ false → return JNI_ERR ──────────────────────→ 短路！跳过 #29-#30
  │
  └─ #29-#30: 无错误返回
  └─ return JNI_OK
```

### 2.4 关键源文件

| 文件 | 行数 | 内容 |
|------|------|------|
| `src/hotspot/share/runtime/init.cpp` | 242 | init_globals() + vm_init_globals() + exit_globals() |
| `src/hotspot/share/runtime/init.hpp` | ~30 | 函数声明 |

### 2.5 日志输出点

init_globals 在关键步骤输出 `INST_LOG_*` 日志（用于诊断启动性能）：

```
INST_LOG_RUNTIME: bytecodes 数量、代码缓存大小(KB)、stub 地址、堆大小(MB)
INST_LOG_INTERP:  解释器代码缓存使用量
INST_LOG_JIT:     deopt_blob 地址、vtableStubs 使用量、编译代理就绪
最终总结:         线程数、代码缓存(KB)、元空间(KB)、堆(MB)
```

---

## §三 学习路线：按执行顺序阅读文档

### 路线图

```
┌──────────────────────────────────────────────────────────────────────┐
│                     init_globals() 学习路线                          │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  📖 起点：读本文（10 分钟，建立整体印象）                              │
│       ↓                                                              │
│  📖 00-JNI-CreateJavaVM（了解 init_globals 在 create_vm 中的位置）     │
│       ↓                                                              │
│  ┌─ 阶段 1: 基础设施层 ──────────────────────────────────────────┐  │
│  │  📖 13-Management-Services       (#1 management_init)         │  │
│  │  📖 14-Interpreter-Bytecodes     (#2 bytecodes_init)          │  │
│  │  📖 本文 §四                      (#3 classLoader_init1)       │  │
│  │  📖 22-ClassLoader-Init           (#3 classLoader_init1) ✅ 新增    │  │
│  │  📖 20-Compilation-Pipeline §2    (#4 compilationPolicy_init) ✅     │  │
│  │  📖 01-CodeCache                  (#5 codeCache_init)               │  │
│  └────────────────────────────────────────────────────────────────┘  │
│       ↓                                                              │
│  ┌─ 阶段 2: 运行时核心层 ─────────────────────────────────────────┐  │
│  │  📖 18-VM-Version-CPU-Detection    (#6 VM_Version_init) ✅ 新增     │  │
│  │  📖 15-StubRoutines-SharedRuntime (#8 stubRoutines_init1)      │  │
│  │  📖 02-G1-Heap-Startup           (#9 universe_init → Heap)     │  │
│  │  📖 03-Metaspace                 (#9 universe_init → Meta)     │  │
│  │  📖 04-SymbolTable               (#9 universe_init → Symbol)   │  │
│  │  📖 05-StringTable               (#9 universe_init → String)   │  │
│  │  📖 08-G1-Policy-Analytics       (#9 universe_init → Policy)   │  │
│  │  📖 09-G1-Concurrent-Marking     (#9 universe_init → CMTask)   │  │
│  └────────────────────────────────────────────────────────────────┘  │
│       ↓                                                              │
│  ┌─ 阶段 3: 解释器层 ─────────────────────────────────────────────┐  │
│  │  📖 16-Universe-Post-Init §1.2   (#10 gc_barrier_stubs_init)   │  │
│  │  📖 14-Interpreter-Bytecodes     (#11-#16 解释器 6 调用)       │  │
│  │  📖 15-StubRoutines-SharedRuntime (#17 SharedRuntime stubs)    │  │
│  └────────────────────────────────────────────────────────────────┘  │
│       ↓                                                              │
│  ┌─ 阶段 4: 类型系统层 ───────────────────────────────────────────┐  │
│  │  📖 16-Universe-Post-Init        (#18-#20 + #28)               │  │
│  │  📖 10-JNIHandle-CompileQueue    (#21 jni_handles_init)        │  │
│  │  📖 19-vmStructs-SA-Debug-Infra    (#22 vmStructs_init) ✅ 新增   │  │
│  └────────────────────────────────────────────────────────────────┘  │
│       ↓                                                              │
│  ┌─ 阶段 5: 编译底座层 ───────────────────────────────────────────┐  │
│  │  📖 17-VTable-IC-Compiler-Infra  (#23-#26 编译底座 4 调用)     │  │
│  │  📖 10-JNIHandle-CompileQueue    (#27 compileBroker_init)      │  │
│  │  📖 16-Universe-Post-Init        (#28 universe_post_init)      │  │
│  │  📖 15-StubRoutines-SharedRuntime (#29-#30 桩代码收尾)         │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  🏁 终点：JVM 进入 Live Phase，开始接受 Java 代码                     │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

### 阅读顺序建议

**第一遍（快速概览，~2 小时）**：
1. 读本文 §〇-§二（理解整体框架）
2. 读 00-JNI-CreateJavaVM §init_globals 部分
3. 浏览本文 §一 的 30 调用表（不深入源码）

**第二遍（深度走读，~8 小时）**：
1. 按 5 个阶段顺序读：基础设施 → 运行时核心 → 解释器 → 类型系统 → 编译底座
2. 每读完一个阶段，回到 init.cpp 验证理解
3. 重点标注：universe_init (#9)、universe_post_init (#28)、compileBroker_init (#27) 三个有错误路径的调用

**第三遍（专家级，按需深入）**：
1. 追踪感兴趣的子系统的完整调用链（用 jvm-tracer）
2. 对比不同 GC 的 barrier 实现差异
3. 研究 CDS 对 init_globals 的加速机制

---

## §四 classLoader_init1() 详细走读（#3，本文独有覆盖）

### 4.1 调用链

```
init_globals() at init.cpp:123
  → classLoader_init1() at classLoader.cpp:1853
    → ClassLoader::initialize() at classLoader.cpp:1694-1765
```

### 4.2 ClassLoader::initialize() 三阶段

**阶段 A: PerfData 计数器创建（1697-1748）**

若 `UsePerfData=true`（默认），创建 ~30 个 PerfData 计数器：

```cpp
// classLoader.cpp:1697-1748
if (UsePerfData) {
  _perf_accumulated_time = PerfDataManager::create_counter(
    SUN_CLS, "time", PerfData::U_Ticks, CHECK);
  _perf_class_link_time = PerfDataManager::create_counter(
    SUN_CLS, "linkedTime", PerfData::U_Ticks, CHECK);
  _perf_class_verify_time = PerfDataManager::create_counter(
    SUN_CLS, "verifyTime", PerfData::U_Ticks, CHECK);
  // ... 更多计数器：类加载时间、类链接时间、锁竞争率等
}
```

这些计数器存储在 PerfMemory 中（[07-PerfMemory]），jstat 可读取。

**阶段 B: 加载 zip 库（1752）**

```cpp
// classLoader.cpp:1752
load_zip_library();
```

加载 `libzip.so`，获取 `ZIP_Open`/`ZIP_GetEntry`/`ZIP_ReadEntry` 等入口点。这些入口点用于后续读取 `rt.jar`/`jmod` 中的类文件。

> **为什么在这里加载？** zip 库是 C 库（不是 JVM 内部代码），其入口点函数指针是全局变量。后续类加载（`ClassLoader::load_classfile()`）会使用这些入口点——必须提前加载。

**阶段 C: 设置搜索路径（1754-1764）**

```cpp
// classLoader.cpp:1754-1764
#if INCLUDE_CDS
if (DumpSharedSpaces) {
  _shared_paths_misc_info->add_boot_classpath_args();
}
#endif
setup_bootstrap_search_path();
```

`setup_bootstrap_search_path()` 解析 `sun.boot.class.path` 系统属性，将 `rt.jar` 等 jar 文件路径添加到 Bootstrap ClassLoader 的搜索路径中。

> **为什么分 init1/init2？** init1 在 init_globals 早期执行（#3），只做轻量初始化（PerfData + zip 库 + 搜索路径）。init2 在 SystemDictionary 中更晚调用（类加载阶段），处理模块路径（`--patch-module`、`java.base` ModuleEntry）——此时 SymbolTable 已就绪，可以创建模块符号。

---

## §五 文档覆盖现状与缺口

### 5.1 覆盖统计

```
30 个调用:
  ✅ 充分覆盖 (★★★★): 20/30 = 67%  — 有专门文档深度走读
  ⚠️ 部分/浅覆盖:      7/30  = 23%  — 有提及但缺主路径代码走读
  ❌ 完全遗漏:          2/30  =  7%  — 无文档覆盖
  ⚪ 空方法:            1/30  =  3%  — os_init_globals（当前为空）
```

### 5.2 完全遗漏的调用

| 调用 | 重要性 | 说明 |
|------|--------|------|
| `classLoader_init1()` (#3) | 🟡 中 | **本文 §四 已覆盖**——PerfData 计数器 + zip 库 + 搜索路径 |

### 5.3 浅覆盖需要加深的调用

| 调用 | 现有文档 | 缺失内容 |
|------|---------|---------|
| `gc_barrier_stubs_init()` (#10) | 16-Universe §1.2 | 仅 1 小节，缺 G1 SATB 屏障的汇编生成细节 |
| `accessFlags_init()` (#13) | 14-Interpreter | 仅 sizeof 断言，缺 16 个标志位的语义映射 |
| `InterfaceSupport_init()` (#15) | 14-Interpreter | 仅 GC 压力种子，缺接口分派的数据结构 |
| `referenceProcessor_init()` (#20) | 16-Universe §1.5 | 缺 4 种引用（Soft/Weak/Phantom/Final）的处理队列初始化 |

---

## §六 常见问题

### Q1: 为什么 universe_init 失败要直接短路返回？

因为 universe_init 创建的是 JVM 最核心的数据结构——堆（Heap）、元空间（Metaspace）、符号表（SymbolTable）、字符串表（StringTable）。没有这些，后续所有初始化都无意义：解释器需要在 CodeCache 中分配（CodeCache 在堆外，但需要符号表验证类名），类型系统需要 Metaspace 存储 Klass，JNI handle 需要堆存在。

短路返回的错误码会被 `Threads::create_vm()` 捕获并传播到 JNI 层，最终 Java 进程以非零状态码退出。

### Q2: 为什么 stubRoutines 需要两阶段初始化？

```
stubRoutines_init1() (line 133) — 在 universe_init 之前
  → 只生成原子操作桩（atomic_xchg/cmpxchg/add）
  → 这些桩不依赖任何 Java 类型信息

stubRoutines_init2() (line 186) — 在 universe_post_init 之后
  → 生成 arraycopy 24 入口（依赖类型系统）
  → 生成 AES/SHA intrinsic（依赖 VM_Version_init 的 CPU 特性检测）
  → 生成 CRC32 intrinsic（依赖 CPU 特性）
```

如果合并为单阶段，必须在 universe_init + VM_Version_init + universe_post_init 全部完成后才能生成所有桩——但 `_call_stub_entry` 在 universe_init 之前的初始化步骤中就需要使用 → 循环依赖。两阶段分离打破循环依赖。

### Q3: init_globals 中哪些调用在 CDS 模式下跳过？

`UseSharedSpaces=true`（CDS 归档加载）时：
- `Universe::genesis()` (#18) 跳过 8 种 TypeArrayKlass 创建——从 CDS `ro`/`rw` 区域直接映射
- `JavaClasses::compute_offsets()` (#19) 跳过偏移量计算——从归档的 `serialize_offsets()` 恢复
- `universe_post_init()` (#28) 跳过 vtable/itable 重初始化——vtables 从归档恢复
- 但异常预分配、known method 缓存和 `heap()->post_initialize()` 始终执行——不依赖 CDS

### Q4: compileBroker_init 为什么返回 false 是 JNI_EINVAL 而不是 JNI_ERR？

`JNI_EINVAL`（无效参数）表示编译代理初始化失败通常是配置问题（如 `-XX:CompileCommand` 格式错误），不是系统资源不足。`JNI_ERR` 用于更严重的错误（如 universe_post_init 中系统类加载失败）。错误码的区分帮助诊断工具判断启动失败原因。

---

## §七 与已有文档的关系

| 本文档 | 已有文档 | 关系 |
|--------|---------|------|
| **本文 §一** 30 调用全景表 | 01-17 所有文档 | 本文是"目录"，各文档是"章节" |
| **本文 §二** 环境上下文 | 00-JNI-CreateJavaVM | 本文聚焦 init_globals 本身，00 文档覆盖 create_vm 全流程 |
| **本文 §三** 学习路线 | 全部 | 按执行顺序排列阅读路径 |
| **本文 §四** classLoader_init1 | 无 | 本文独有覆盖 |
| **本文 §五** 覆盖缺口 | 全部 | 指出需要补充的文档 |

---

## §八 下一步行动

1. ~~补 VM_Version_init~~ → [18-VM-Version-CPU-Detection] ✅
2. ~~补 vmStructs_init~~ → [19-vmStructs-SA-Debug-Infra] ✅
3. ~~编译系统主线合并~~ → [20-Compilation-Pipeline] ✅（3→1 篇，消除交叉重复）
4. ~~类型系统主线合并~~ → [21-Universe-Type-System] ✅（2→1 篇，消除交叉重复）
5. ~~补 classLoader_init1~~ → [22-ClassLoader-Init] ✅
6. **加深**: `gc_barrier_stubs_init`、`referenceProcessor_init` 等 4 个浅覆盖调用
7. **维护**: 每次新增文档后，更新本文 §一 的覆盖表
