# 《OpenJDK HotSpot 源码深度分析》书籍规划 v2
> 开源电子书 — 无页数限制，全量覆盖，深度无上限

---

## §〇 核心理念变化

| 旧规划 (v1) | 新规划 (v2) |
|-----------|-----------|
| 纸质书 400 页 | 开源电子书，**无页数限制** |
| 压缩比 25:1，舍弃 95% | **全量覆盖**，已有分析全部纳入 |
| 16 章单册 | **8 卷多册**，每卷可独立阅读 |
| "忍痛割爱"不写 | **一个子系统都不放过** |

**这本书的野心**：成为 OpenJDK HotSpot 源码的**中文权威参考**——不是"入门读物"，而是工程师在排查 JVM 问题时的**源码级参考书**。

---

## §一 分卷规划（8 卷，~40 章）

### 第一卷：启动 — JVM 从零到一

> 覆盖 Phase 01-jvm-startup（22,208 行分析 → 书籍化）

```
第1章: java 命令到 JNI_CreateJavaVM
├── 1.1  libjli.so: 启动器全景 (JLI_Launch → LoadJavaVM)
├── 1.2  execve → dlopen("libjvm.so") → dlsym("JNI_CreateJavaVM")
├── 1.3  JNI_CreateJavaVM 入口: Atomic::xchg 单例保证
├── 1.4  JNI_CreateJavaVM_inner: 两层设计的安全理由
└── 1.5  Stage 0-2: OS init + 参数解析 + Safepoint 机制初始化

第2章: vm_init_globals — VM 线程阶段的 6 个初始化
├── 2.1  basic_types_init: 类型大小 + 压缩指针的全面影响
├── 2.2  mutex_init: 104 个全局 Mutex 的 Rank 18 级体系
├── 2.3  chunkpool_init: 4 级 ChunkPool (tiny→large) + LIFO free-list
├── 2.4  perfMemory_init: /tmp/hsperfdata 的 mmap 共享内存
├── 2.5  eventlog_init: 事件日志系统
└── 2.6  SuspendibleThreadSet_init: 暂停线程集

第3章: init_globals() 阶段 1 — 基础设施 (调用 #1-8)
├── 3.1  management_init: 23 PerfCounter + JMX 接口
├── 3.2  bytecodes_init: 256 条目字节码属性表（6 数组逐字段）
├── 3.3  classLoader_init1: 30 PerfData + 7 dlsym + bootstrap 搜索路径
├── 3.4  compilationPolicy_init: 3 种编译策略的选择
├── 3.5  codeCache_init: 3 段 CodeHeap + 4 个 GrowableArray + segmap
├── 3.6  VM_Version_init: CPU 特性位图 (42 个 Feature Flag)
├── 3.7  stubRoutines_init1: 18 个桩（原子/CAS/CRC32）
└── 3.8  阶段 1 依赖 DAG: 为什么这个顺序不能变

第4章: init_globals() 阶段 2 — 宇宙诞生 (调用 #9-17)
├── 4.1  universe_init: Java Heap + Metaspace + SymbolTable + StringTable
├── 4.2  G1 堆启动: mmap 2 步 (PROT_NONE → MAP_FIXED)
├── 4.3  6 个 Mapper 并行 commit + 2048 Region 创建
├── 4.4  gc_barrier_stubs_init: SATB + 脏卡屏障
├── 4.5  interpreter_init: AbstractInterpreter + StubQueue
├── 4.6  templateTable_init: 256 Template def + wide 模板
├── 4.7  SharedRuntime::generate_stubs: deopt/ic_miss/resolve/safepoint
└── 4.8  阶段 2 失败路径: universe_init 失败 → 短路返回

第5章: init_globals() 阶段 3 — 类型系统与编译 (调用 #18-31)
├── 5.1  universe2_init: 8 TypeArrayKlass + ObjectArrayKlass
├── 5.2  javaClasses_init: 30 个核心 Java 类字段偏移量
├── 5.3  jni_handles_init: Global + Weak Global OopStorage
├── 5.4  vtableStubs_init + InlineCacheBuffer_init + compilerOracle_init
├── 5.5  compileBroker_init: C1/C2 双队列 + CompilerThread 创建
├── 5.6  universe_post_init: 10 预分配异常 + known methods + 类初始化
├── 5.7  stubRoutines_init2 + MethodHandles::generate_adapters
└── 5.8  全书最重要的代码注释: init_globals() 源码逐行注解
```

### 第二卷：堆与 GC — G1 为主，多 GC 对比

> 覆盖 Phase 01 (02,08,09) + 全 GC Phase 分析

```
第6章: G1 堆的物理布局
├── 6.1  G1CollectedHeap: 39 个成员逐个分析
├── 6.2  HeapRegion: 4 种类型 × 2048 个 Region × Free List
├── 6.3  Card Table: _byte_map_base 偏移优化 + card_shift=9
├── 6.4  Block Offset Table: O(1) 对象起始地址查找
└── 6.5  辅助结构总开销: 512MB 堆 → ~76MB 辅助

第7章: 对象分配全链路
├── 7.1  TLAB (Thread-Local Allocation Buffer): bump-pointer 零锁
├── 7.2  TLAB 慢路径: refill → Eden 分配 → GC 触发
├── 7.3  PLAB: GC 线程专用 TLAB (Promotion LAB)
├── 7.4  Humongous 对象: 连续 Region 分配
└── 7.5  OOM: 预分配异常的 allocate_instance + set_message 两步机制

第8章: G1 Young GC 全流程
├── 8.1  VM_G1CollectForAllocation: VM_Operation 的 safepoint 协议
├── 8.2  RSet (Remembered Set): sparse → fine → coarse 三级粗化
├── 8.3  Evacuation: 根扫描 → 复制 → 引用更新
├── 8.4  PreservedMarks: evacuation failure 的 mark word 保存/恢复
└── 8.5  暂停时间分解: Logging + 诊断

第9章: G1 并发标记
├── 9.1  SATB 并发标记: TAMS + prev/next 双位图
├── 9.2  G1ConcurrentMark: 37 个初始化结构逐个分析
├── 9.3  标记栈: CMMarkStack 的 chunk 链表 + 溢出处理
├── 9.4  工作窃取: G1CMTaskQueue + ParallelTaskTerminator
├── 9.5  Remark 暂停: SATB 缓冲排空 + 引用处理
└── 9.6  精炼线程: G1ConcurrentRefine 的自适应激活

第10章: G1 策略与决策
├── 10.1 G1Policy: 28 个成员逐个分析
├── 10.2 G1Analytics: 17 个 TruncatedSeq 的预测模型
├── 10.3 G1IHOPControl: 自适应 IHOP 阈值
├── 10.4 G1MMUTrackerQueue: 64 元素环形队列
├── 10.5 SurvRateGroup: 对象存活率预测
├── 10.6 G1GCPhaseTimes: 28 Phase × N Worker 的阶段计时
├── 10.7 G1YoungGenSizer + AgeTable: 年轻代自适应
└── 10.8 Mixed GC + Full GC 回退

第11章: 其他 GC 实现对比
├── 11.1 Serial GC: DefNew + Tenured 的简单之美
├── 11.2 Parallel GC: ParallelScavenge + PSMarkSweep
├── 11.3 CMS: ConcurrentMarkSweep 的并发设计与问题
├── 11.4 ZGC: 染色指针 + 并发重映射
├── 11.5 Shenandoah: Brooks 指针 + 并发压缩
└── 11.6 5 种 GC 的全面对比表
```

### 第三卷：解释器 — 字节码执行的微观世界

> 覆盖 Phase 01 (14) 深度扩展

```
第12章: 字节码系统
├── 12.1 Bytecodes: 256 条字节码的 4 属性分类体系
├── 12.2 Bytecodes::def: 每个字节码的元数据表
├── 12.3 快速字节码 (fast_xxx): ldc/iload/aload 的特殊处理
├── 12.4 字节码重写: Rewriter 的常量池缓存优化
└── 12.5 字节码验证: Verifier 的类型安全保证

第13章: 模板解释器核心
├── 13.1 TemplateTable: 256 Template 的定义与组织
├── 13.2 Template::generate: 3 步流水线 (def → initialize → generate)
├── 13.3 _flags 四位详解: uses_bcp/does_dispatch/calls_vm/wide
├── 13.4 generator(arg): arg 的七类语义完整表
├── 13.5 wide 前缀字节码: 12 个 wide 变体的模板
└── 13.6 DispatchTable: 10 种入口点 (正常/OSR/回边/早期返回...)

第14章: 模板详解 — 逐类字节码的汇编生成
├── 14.1 加载/存储: iload/istore/aload/astore 系列
├── 14.2 算术: iadd/idiv/ishl 系列
├── 14.3 类型转换: i2l/d2i/i2b 系列
├── 14.4 控制流: goto/ifeq/tableswitch/lookupswitch
├── 14.5 方法调用: invokevirtual/invokeinterface/invokestatic/invokespecial
├── 14.6 对象操作: new/newarray/getfield/putfield
├── 14.7 同步: monitorenter/monitorexit
├── 14.8 异常: athrow/JSR/RET
└── 14.9 栈帧管理: 局部变量表 + 操作数栈的物理布局

第15章: GC 屏障在解释器中的实现
├── 15.1 BarrierSet: _bs 的多态分派
├── 15.2 G1 预写屏障: SATB 队列入队
├── 15.3 G1 后写屏障: Card Table mark
├── 15.4 数组存储屏障: aastore 的特殊处理
└── 15.5 不同 GC 的屏障对比 (G1/Parallel/ZGC/Shenandoah)

第16章: 解释器的诊断与优化
├── 16.1 -XX:+PrintInterpreter: 查看所有 Codelet 的汇编
├── 16.2 解释器性能分析: 每条字节码的周期数
├── 16.3 JSR 292: invokedynamic 的解释路径
├── 16.4 MethodHandles 适配器: 从解释入口到 MH 入口
└── 16.5 模板解释器的局限: 为什么需要 JIT
```

### 第四卷：编译 — C1 与 C2 的 JIT 世界

> 覆盖 Phase 01 (20) + Phase 22-c2-jit (待分析)

```
第17章: 编译触发与策略
├── 17.1 InvocationCounter: 32 位编码 + decay + carry
├── 17.2 CompilationPolicy: Simple → StackWalk → Tiered
├── 17.3 TieredThresholdPolicy: 5 级编译层次
├── 17.4 CompileBroker: C1/C2 双队列 + 任务窃取
├── 17.5 CompileTask: 从创建到完成的完整生命周期
└── 17.6 CompilerOracle: CompileCommand 指令解析

第18章: C1 编译器
├── 18.1 C1 架构总览: GraphBuilder → LIR → CodeGen
├── 18.2 HIR (High-level IR): 基本块 + 类型推断
├── 18.3 LIR (Low-level IR): 虚拟寄存器 + 线性扫描
├── 18.4 内联策略: 静态绑定 + CHA (Class Hierarchy Analysis)
├── 18.5 快速编译: 启动性能的关键
└── 18.6 C1 与 C2 的协作: 分层编译的平滑升级

第19章: C2 编译器 (I)
├── 19.1 C2 架构总览: Ideal Graph → Optimize → Matcher → CodeGen
├── 19.2 Ideal Graph: Node + Edge 的 IR 表示
├── 19.3 GVN (Global Value Numbering): 公共子表达式消除
├── 19.4 IGVN (Iterative GVN): 迭代优化框架
├── 19.5 类型系统: TypeInt/TypeLong/TypePtr 的格理论
└── 19.6 Phase 迭代: Compile → 多 Phase 遍历

第20章: C2 编译器 (II)
├── 20.1 逃逸分析: 栈上分配 + 标量替换
├── 20.2 锁优化: 锁粗化 + 锁消除
├── 20.3 循环优化: 循环展开 + 循环外提 + 向量化
├── 20.4 内联策略: 频率 + 大小 + 深度 + 层级
├── 20.5 Matcher: Ideal → MachNode 的指令选择
└── 20.6 Register Allocation: Chaitin 图着色

第21章: CodeCache 与编译产物管理
├── 21.1 nmethod 内存布局: header + reloc + scopes + metadata
├── 21.2 nmethod 生命周期: alive → not_entrant → zombie → unloaded
├── 21.3 IC (Inline Cache): 单态 → 双态 → 多态 → 清理
├── 21.4 Dependency: nmethod 的假设链 (CHA/class hierarchy)
├── 21.5 CodeCache Sweeper: 3 段堆的清扫 + 回退
├── 21.6 deoptimization: 从编译代码回到解释执行
└── 21.7 Bug 案例: CodeCache 满导致性能抖动的源码级分析
```

### 第五卷：内存 — 元空间与对象模型

> 覆盖 Phase 01 (03) + Phase 27-memory-extra

```
第22章: Metaspace 综述
├── 22.1 Why Metaspace: PermGen 的死亡与新生
├── 22.2 VirtualSpaceList: 虚拟空间链表
├── 22.3 VirtualSpaceNode: commit/uncommit 粒度
├── 22.4 ChunkManager: 3 级空闲链表
├── 22.5 Metachunk: 分配单元的内部布局
└── 22.6 CompressedClassSpace: 压缩类指针的 32 位地址空间

第23章: Metaspace 分配器
├── 23.1 ClassLoaderMetaspace: 每个类加载器的元空间
├── 23.2 SpaceManager: Class/Metadata 双管理器
├── 23.3 BlockFreelist: 已释放块的再利用
├── 23.4 Arena 分配器: bump-pointer + Chunk 链
├── 23.5 ChunkPool: 4 级池 + LIFO free-list
└── 23.6 MetaspaceGC: _capacity_until_GC 的阈值管理

第24章: OOP 对象模型
├── 24.1 oopDesc: mark word 的 32/64 位编码
├── 24.2 Klass 体系: InstanceKlass → ArrayKlass → TypeArrayKlass
├── 24.3 klassVtable: 虚函数表的布局与重写
├── 24.4 klassItable: 接口分派的 2 步查找
├── 24.5 ConstantPool: 常量池的内部结构
├── 24.6 Method/ConstMethod: 方法的字节码 + 元数据
└── 24.7 AccessFlags: 16 个 JVM 访问标志位

第25章: 压缩指针深度分析
├── 25.1 CompressedOops: 32 位引用指 64GB 堆的数学原理
├── 25.2 CompressedClassPointers: 类指针压缩
├── 25.3 基址模式 vs 零基址模式
├── 25.4 编码/解码的 x86 汇编实现
├── 25.5 压缩指针对 Object Layout 的影响
└── 25.6 NarrowOop 的类型安全: C++ 中的 checked_cast
```

### 第六卷：运行时 — 线程、锁、信号、Safepoint

> 覆盖 Phase 01 (06/11) + Phase 26-runtime-extra

```
第26章: 线程系统
├── 26.1 Thread 层次: Thread → NamedThread → JavaThread
├── 26.2 JavaThread 创建: C++ 对象 → OS 线程的 pthread_create
├── 26.3 ThreadLocalStorage: 线程局部存储
├── 26.4 ThreadState: _thread_state 的 10 状态机
├── 26.5 Handles: Handle/HandleMark 的 RAII 机制
├── 26.6 JNIHandleBlock: 块链表分配 + OopStorage 后端
├── 26.7 VMThread: JVM 的"管理员线程"
├── 26.8 ServiceThread + WatcherThread + Signal Dispatcher
└── 26.9 Thread-SMR: Safe Memory Reclamation

第27章: 同步与锁
├── 27.1 锁升级: 偏向锁 → 轻量级锁 → 重量级锁
├── 27.2 ObjectMonitor: cxq + EntryList + WaitSet 三队列
├── 27.3 ParkEvent: 线程阻塞/唤醒的底层实现 (pthread_cond_t)
├── 27.4 PlatformMonitor: 跨平台的 condition variable 包装
├── 27.5 JVM 内部锁: 104 个全局 Mutex 的 Rank 18 级体系
├── 27.6 锁的调试: -XX:+PrintMonitorInflation
└── 27.7 死锁检测: DeadlockCycle 的 graph 算法

第28章: Safepoint 机制
├── 28.1 Safepoint 协议: polling page → mprotect → SIGSEGV 处理
├── 28.2 SafepointMechanism: 全局/线程局部双页设计
├── 28.3 ThreadSafepointState: handle_polling_page_exception
├── 28.4 SafepointSynchronize: begin/end 的完整流程
├── 28.5 VM_Operation: 4 种模式 (no_safepoint/safepoint/gc/deopt)
├── 28.6 VMOperationQueue: 优先级队列 + 等待通知
├── 28.7 Safepoint 性能: PrintSafepointStatistics 日志解读
└── 28.8 Long Saftpoint 排查: 线程阻塞 + 页错误 + GC

第29章: 信号处理
├── 29.1 JVM 安装的信号处理器: 6 种信号 (SIGSEGV/SIGBUS/SIGFPE...)
├── 29.2 JVM_handle_linux_signal: 信号分发中心
├── 29.3 NullPointerException: SIGSEGV → oop 恢复 → 抛出 NPE
├── 29.4 StackOverflowError: SIGSEGV → 栈检查 → 抛出/扩展
├── 29.5 ImplicitNullChecks: SIGSEGV 代替显式 null check
├── 29.6 信号链 (libjsig): JVM + 第三方库信号共存
└── 29.7 信号安全: 异步信号安全的函数列表
```

### 第七卷：类加载与反射

> 覆盖 Phase 01 (22/21) + 其他 Phase 类加载分析

```
第30章: 类加载器体系
├── 30.1 ClassLoader 层次: Bootstrap → Platform → App
├── 30.2 ClassPathEntry: jimage/zip/directory 三种实现
├── 30.3 jimage 格式: JIMAGE → mmap → 完美哈希查找
├── 30.4 ClassPathZipEntry: dlopen("libzip.so") + fread
├── 30.5 ClassPathDirEntry: os::stat + fopen
├── 30.6 Lazy 机制: 启动时延迟创建路径条目
└── 30.7 CDS: Class Data Sharing 的归档与 mmap

第31章: 类加载流程
├── 31.1 SystemDictionary: JVM 的"类注册表"
├── 31.2 load_instance_class: 5 步加载 (load → verify → prepare → resolve → init)
├── 31.3 双亲委派: loadClass 的三级查找
├── 31.4 类链接: LinkResolver 的静态/动态解析
├── 31.5 类初始化: <clinit> 的线程安全执行
└── 31.6 类卸载: ClassLoaderDataGraph 的并发清理

第32章: 模块系统
├── 32.1 JDK 9 模块系统架构
├── 32.2 ModuleEntryTable + PackageEntryTable
├── 32.3 模块依赖图: readability + accessibility
├── 32.4 模块的初始化: call_initPhase2 + call_initPhase3
└── 32.5 无名模块 (Unnamed Module): 向后兼容

第33章: 反射与 JNI
├── 33.1 JNI 函数表: jni_NativeInterface 的 200+ 函数指针
├── 33.2 JNI 调用: jni_invoke_static/virtual/nonvirtual
├── 33.3 Reflection: Method::invoke 的 JNI 路径
├── 33.4 Unsafe: sun.misc.Unsafe 的 C++ 后端
├── 33.5 JVMCI: JVM Compiler Interface (Graal 的后端)
└── 33.6 JVMTI: 事件模型 + capabilities + agent 加载
```

### 第八卷：基础设施 — 日志、诊断、构建、JFR

> 覆盖 Phase 23/24/25/26/27/28/29 + 17/18/19/20

```
第34章: 统一日志框架 (UL)
├── 34.1 LogConfiguration: -Xlog 参数解析
├── 34.2 LogTagSet: 标签 + 级别的组合
├── 34.3 LogOutput: stdout/stderr/file 的输出管道
├── 34.4 LogDecorators: 时间/线程/级别/标签的格式化
├── 34.5 LogStream: 非阻塞环形缓冲 (async logging)
└── 34.6 各子系统的日志输出: gc/log/compilation/class+load...

第35章: 诊断与监控
├── 35.1 PerfData: /tmp/hsperfdata 的 mmap 共享内存
├── 35.2 jstat: PerfData 的读取链路
├── 35.3 JMX: Management 接口的全景 (MBean 注册 + 查询)
├── 35.4 jcmd: DiagnosticCommand 的 DCmd 框架
├── 35.5 jstack: ThreadDump 的实现
├── 35.6 jmap: HeapDump 的实现
└── 35.7 jinfo: VM flag 的动态修改

第36章: JFR — Java Flight Recorder
├── 36.1 JFR 架构: 事件模型 + 环形缓冲 + 磁盘写入
├── 36.2 JfrRecorder: 录制引擎的启动/停止
├── 36.3 JfrEvent: 150+ 内置事件类型
├── 36.4 JfrCheckpoint: 常量池的增量写入
├── 36.5 JfrStacktrace: 堆栈跟踪的高效编码
├── 36.6 JfrChunkWriter: 二进制 chunk 格式
└── 36.7 JFR 性能开销: 默认 1% 的实现保证

第37章: Serviceability Agent
├── 37.1 SA 架构: libsaproc.so + sa-jdi.jar
├── 37.2 vmStructs: 500+ 字段的 SA 类型信息
├── 37.3 Linux debugger: ptrace + core dump 读取
├── 37.4 Heap Analyzer: 堆的对象图遍历
├── 37.5 Class Browser: 类结构的离线分析
├── 37.6 CLHSDB: SA 的命令行调试工具
└── 37.7 后分析 (Post-mortem): core dump 中的 JVM 状态重建

第38章: 构建与裁剪
├── 38.1 configure 系统: autoconf → spec.gmk
├── 38.2 Main.gmk: 7 阶段构建管线
├── 38.3 HotSpot 编译: JVM_FEATURES 22 个 ifeq 的 5 层过滤
├── 38.4 镜像组装: jmod → jlink → exploded image
└── 38.5 自定义裁剪: JVM_FEATURES + JVM_VARIANTS + 模块禁用

第39章: NMT — Native Memory Tracking
├── 39.1 NMT 架构: MemTracker + MallocTracker + VirtualMemoryTracker
├── 39.2 malloc 拦截: os::malloc 的跟踪包装
├── 39.3 mmap 跟踪: VirtualMemory 的 reserve/commit 记录
├── 39.4 内存分类: mtGC/mtCode/mtClass 等 30+ 类别
├── 39.5 jcmd VM.native_memory: summary/detail/baseline 命令
└── 39.6 NMT 性能开销: 5-10% 的来源与优化

第40章: 工具函数与基础数据结构
├── 40.1 hashtable: BasicHashtable 的桶 + 单向链表
├── 40.2 ConcurrentHashTable: 无锁并发哈希表 (StringTable)
├── 40.3 GrowableArray: 动态数组的扩容策略
├── 40.4 ResourceMark: 资源区域 RAII 管理
├── 40.5 OopStorage: Oop 的并发安全存储
├── 40.6 Bitmap: CMBitMap + 并发位图
├── 40.7 WorkerThread: WorkGang 的并行任务分派
└── 40.8 其他: ELF/VtableDumper/DebugInfoRecorder...
```

---

## §二 全量内容估算

| 卷 | 标题 | 章节数 | 估计行数 |
|:---:|------|:---:|:---:|
| 1 | 启动 — JVM 从零到一 | 1-5 | ~15,000 |
| 2 | 堆与 GC — G1 为主 | 6-11 | ~18,000 |
| 3 | 解释器 — 字节码执行 | 12-16 | ~12,000 |
| 4 | 编译 — C1/C2 JIT | 17-21 | ~15,000 |
| 5 | 内存 — Metaspace/对象模型 | 22-25 | ~10,000 |
| 6 | 运行时 — 线程/锁/Safepoint | 26-29 | ~12,000 |
| 7 | 类加载与反射 | 30-33 | ~10,000 |
| 8 | 基础设施 — 日志/诊断/构建/JFR | 34-40 | ~18,000 |
| **合计** | 40 章 | **~110,000** |

每卷 300-600 页（电子书） → 全书 2400-4800 页，**约 3-5 万页**。

---

## §三 写作优先级

```
第1优先级 (第一卷) — 启动篇 — 读者第一印象，必须打磨到极致
第2优先级 (第二卷) — GC 篇 — JVM 最复杂的子系统，读者的真实需求
第3优先级 (第四卷) — 编译篇 — JVM 的核心价值，区分 JVM 与普通语言的标志
第4优先级 (第三卷) — 解释器篇 — 字节码是 Java 的基础，与编译篇衔接
第5优先级 (第五卷) — 内存篇 — 了解内存模型才能理解 GC
第6优先级 (第六卷) — 运行时篇 — 线程/锁/Safepoint
第7优先级 (第七卷) — 类加载篇 — 反射/JNI/JVMTI
第8优先级 (第八卷) — 基础设施篇 — 日志/诊断/构建/JFR/NMT
```

---

## §四 当前分析资产映射（不压缩，全量纳入）

| 卷 | 基于的 Phase 分析 | 当前行数 | 待补分析 |
|:---:|------|:---:|------|
| 1 | 01-jvm-startup (23 篇 doc + overview) | ~22,000 | Launcher 层补充 |
| 2 | 01 (02/08/09) + 全 GC Phase | ~8,000 | ZGC/Shenandoah 补充 |
| 3 | 01 (14) | ~1,538 | 14 类字节码汇编逐类展开 |
| 4 | 01 (17/20) + 22-c2-jit | ~2,600 | **C2 全面分析 (22-c2-jit 空)** |
| 5 | 01 (03/21) + 27-memory-extra | ~6,000 | Metaspace 运行时行为 |
| 6 | 01 (06/11) + 26-runtime-extra | ~9,000 | ObjectMonitor 完整分析 |
| 7 | 01 (22/21) + classfile 分析 | ~3,000 | Reflection 实现链 |
| 8 | 23-28 + 17-20 + 29 | ~50,000+ | 已有大量分析，整理纳入 |

---

## §五 开源发布策略

```
发布渠道:
  ├── GitHub Pages: book.openjdk-source.com (主站)
  ├── GitHub Repository: 全量 Markdown 源码
  ├── PDF/epub 生成: Pandoc/LaTeX 自动转换
  └── 在线阅读: mdBook 或 VuePress 渲染

版本策略:
  ├── v1.0 (JDK 11): 基于当前 OpenJDK 11 源码分析
  ├── v2.0 (JDK 17): 升级到 JDK 17 LTS
  └── v3.0 (JDK 21): 跟随最新 LTS

贡献模式:
  ├── 核心作者: 撰写正文 + 图表
  ├── 社区贡献: 勘误 + 补充案例 + 翻译汇编注释
  └── AI 辅助: 生成初稿 → 人工审核 → 严格验证
```

---

## §六 与市面书籍的差异化（开源电子书优势）

| 维度 | 纸质书 | 本书（开源电子书） |
|------|--------|------------------|
| 深度 | 受页数限制 | **无限制，全量覆盖** |
| 代码引用 | 少量片段 | **file:line 级别的完整追踪** |
| 更新 | 再版周期 2-3 年 | **Git 持续更新** |
| 图表 | 黑白印刷 | **彩色 + 可交互的 Mermaid 图** |
| 验证 | 读者无法复现 | **每章 GDB/jcmd 脚本可直接运行** |
| 读者参与 | 单向阅读 | **Issue/PR 驱动的社区勘误** |
| 多版本 | 一版一个 JDK 版本 | **分支管理多 JDK 版本** |
