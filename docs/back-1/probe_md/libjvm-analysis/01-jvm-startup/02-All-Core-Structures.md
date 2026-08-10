# JVM 启动 — 全部核心数据结构（Metaspace/线程/符号/Safepoint/编译器）

> 基于 OpenJDK 11 slowdebug 源码分析
> 环境：`-Xms8g -Xmx8g -XX:+UseG1GC`

---

## 一、Metaspace — 类元数据存储

### 1.1 初始化链

```
Metaspace::global_initialize() (metaspace.cpp)
  └── VirtualSpaceList::VirtualSpaceList(8MB)
        ├── VirtualSpaceNode × N (每个 8MB commit 粒度)
        │     _reserved: mmap(PROT_NONE)
        │     _committed: mprotect(PROT_READ|PROT_WRITE) on demand
        └── (链状结构, 支持动态扩展)
      └── ChunkManager::ChunkManager()
            ├── ClassChunkManager (_chunks: Metachunk × N)
            └── NonClassChunkManager (_chunks: Metachunk × N)

ClassLoaderMetaspace (每个 ClassLoader 一个)
  └── SpaceManager (_class_space_mgr + _non_class_space_mgr)
        ├── BlockFreelist (已释放的块)
        └── InUseLists (当前使用的块)
```

### 1.2 数据结构尺寸

| 结构 | sizeof | 说明 |
|------|--------|------|
| `VirtualSpaceNode` | 208B ✅ | 8MB 的虚拟空间节点 |
| `Metachunk` | 64B ✅ | 元空间块 |
| `ChunkManager` | 可变 | 每个 ChunkIndex 一个 FreeList |
| `SpaceManager` | 104B ✅ | 管理一个 ClassLoader 的分配 |

### 1.3 启动时 Metaspace 使用

```
universe2_init 后:  4480KB (所有原始类)
javaClasses_init 后: 仍为 4480KB (计算偏移量, 不分配空间)
full -version 后:    ~10MB (加载 System.out, 命令行参数等)
```

**原始类 (primordial classes) 200 个**，每个 InstanceKlass 600B-2KB:
- Object: vtable_length=7, 约 600B
- String: vtable_length=12, 约 800B
- Class: vtable_length=9, 约 700B
- Thread: vtable_length=15, 约 1000B

---

## 二、线程系统

### 2.1 JavaThread 创建

```
JavaThread::JavaThread() (thread.cpp)
  ├── OSThread::OSThread()              (osThread.cpp:29)
  │     sizeof(OSThread) = 232B (GDB ✅)
  │     _thread_id = 0 (由 pthread_create 设置)
  │     _interrupted = false
  ├── 栈分配:
  │     stack_base: pthread_attr_getstack()
  │     stack_size: 默认 1MB (-Xss)
  │     guard_zone: 16384 bytes (4 pages, 栈溢出保护)
  └── 寄存器约定 (x86_64):
        rthread 永远指向 JavaThread* (快路径访问)
```

### 2.2 ThreadLocalAllocBuffer (TLAB)

```
TLAB 结构 (threadLocalAllocBuffer.hpp):
  _start: HeapWord*     ← TLAB 起始地址
  _top:   HeapWord*     ← 当前分配位置
  _end:   HeapWord*     ← TLAB 结束地址
  _desired_size: size_t ← 期望大小 (动态调整)
  _refill_waste_limit   ← 重填阈值

TLAB 大小计算:
  TLABSize = 2MB (默认, -XX:TLABSize)
  每个 Region (4MB) 可以容纳约 2 个 TLAB

每次 TLAB 重填 (refill):
  allocate_new_tlab: min_size=256, requested_size=65536 (524288B = 512KB)
  → 从 G1Allocator 的 _mutator_alloc_region 分配一个子块
  → 设置 _start, _top, _end
```

---

## 三、SymbolTable 与 StringTable

### 3.1 SymbolTable

```
SymbolTable (classfile/symbolTable.hpp):
  _the_table: Hashtable<Symbol*, mtSymbol>
    bucket_count: 20011 (初始)
    table_size:   20011 × sizeof(HashtableEntry) = ~160KB

Symbol 结构 (oops/symbol.hpp):
  _refcount: int   ← 引用计数
  _length: u2      ← UTF-8 长度
  _identity_hash: u2 ← 哈希值
  _body[1]: byte   ← 实际字节 (可变长度)

sizeof(Symbol) = 6 + utf8_length
```

### 3.2 StringTable

```
StringTable (classfile/stringTable.hpp):
  _local_table: 线程本地
  _main_table: 主表 (ConcurrentHashTable)

初始大小: ~10013 entries (StringTableSize 参数)
每个 entry: java.lang.String oop 指针

启动时 intern 数量: ~3000 个字符串常量
  (类名, 方法名, 异常消息, 系统属性, ...)
```

---

## 四、SystemDictionary — 类字典

```
SystemDictionary (classfile/systemDictionary.hpp):
  _dictionary: Dictionary (类名 → InstanceKlass 映射)
    hash_table_size: 107 (初始)
    每个 entry: DictionaryEntry
      _name:         Symbol* (类名)
      _klass:        Klass* (已加载的类)
      _loader_data:  ClassLoaderData*
      _hash:         u4 (哈希值)

ClassLoaderData 结构:
  _class_loader:        oop (ClassLoader 实例)
  _dictionary:          Dictionary (这个 ClassLoader 的类)
  _metaspace:           ClassLoaderMetaspace*
  _keep_alive:          bool
  _next:                ClassLoaderData* (链表)

ClassLoaderDataGraph 全局链表:
  _head: ClassLoaderData*  ← bootstrap CLD
    → 下一个 CLD (应用类加载器)
    → 下一个 CLD (自定义类加载器)
```

---

## 五、解释器基础设施

### 5.1 TemplateInterpreter 初始化

```
TemplateInterpreter::initialize() (templateInterpreter.cpp:42)
  ├── AbstractInterpreter::initialize()
  │     _code: StubQueue (InterpreterCodeletInterface, 274432 bytes)
  │
  ├── TemplateTable::initialize()
  │     256 个 Template (每条字节码一个)
  │     _desc_table[0..255] → template的入口
  │
  └── TemplateInterpreterGenerator::generate_all()
        └── 生成所有 InterpreterCodelet:
              ├── 方法入口: generate_normal_entry()
              ├── 本地方法: generate_native_entry()
              ├── 抽象方法: generate_abstract_entry()
              ├── 异常处理: generate_throw_exception()
              ├── 反优化: generate_deopt_entry_for_xxx()
              ├── invokedynamic: generate_method_handle_entry()
              └── 安全点检查: generate_safept_entry()

最终: StubQueue 占用 CodeCache 约 274KB
      256 条 Template 在 C++ 函数表中
```

### 5.2 Bytecode 表

```
Bytecodes 枚举 (bytecodes.hpp):
  _nop(0), _aconst_null(1), ..., 共 239 条

每条字节码:
  - name(): 名称 (如 "invokevirtual")
  - length(): 长度 (如 3)
  - format(): 格式 (如 "bjj")
  - result_type(): 栈结果类型

TemplateTable (templateTable_x86.cpp):
  _desc_table[239] → Template 入口
    每条 Template 对应一段手写 x86 汇编
```

---

## 六、编译器基础设施

### 6.1 CompileBroker 初始化

```
CompileBroker::compilation_init_phase1/phase2 (compileBroker.cpp)
  ├── CompilerThread: _c1_count = 1, _c2_count = 3
  │     (C1_count = CICompilerCount * 0.25, C2_count = CICompilerCount * 0.75)
  │     CICompilerCount 默认 = min(4, cpu_count - 1)
  │
  ├── CompileQueue: C1 队列 + C2 队列
  │     _first: CompileTask* (FIFO)
  │     _last:  CompileTask*
  │     _size:  int (队列长度)
  │
  └── CompileTask::_task_free_list (任务缓存池)
        初始: 空, 运行时动态分配
```

### 6.2 VtableStubs

```
VtableStubs::init() (vtableStubs.cpp)
  _table: VtableStub* [N]  (哈希表, 默认 N = 256)
  
  VtableStub 结构:
    _next: VtableStub*     (哈希冲突链)
    _is_vtable_stub: bool  (true=vtable, false=itable)
    _index: int             (虚方法在 vtable 中的索引)
    _code: 固定大小        (重写 this + jmp 目标)
    
  初始: 空 (桩按需创建)
  第一个桩: CodeCache 额外分配 48B
```

---

## 七、对象监视器基础设施

### 7.1 全局链表

```
ObjectSynchronizer (runtime/synchronizer.hpp):
  gBlockList: ObjectMonitor*  (pre-allocated block)
  gFreeList:  ObjectMonitor*  (free'd monitors)
  gOmInUseList: ObjectMonitor* (in-use monitors, MonitorInUseLists=true)

DeflateMonitorCounters (synchronizer.cpp:1741):
  nScavenged:    int   (本次降级回收的 Monitor 数)
  nInCirculation: int   (当前系统中 Monitor 总数)
  nInuse:         int   (当前使用中的 Monitor 数)

启动时: gBlockList 预分配若干 ObjectMonitor
         gFreeList = gBlockList
         gOmInUseList = NULL
```

---

## 八、信号处理器安装

### 8.1 信号处理注册

```
os::Linux::install_signal_handlers() (os_linux.cpp:5370)
  注册的信号:
    SIGSEGV (11):  段错误 → NullPointer/SOE
    SIGBUS  (7):   总线错误 → 内存访问
    SIGFPE  (8):   算术错误 → 除零
    SIGILL  (4):   非法指令
    SIGPIPE (13):  管道破裂 → 忽略
    SIGUSR2 (12):  线程挂起/恢复 (SR_handler)
    SIGTRAP (5):   调试断点
    ...

  每个信号:
    sigaction(sig, &sigAct, &oldAct)
      sigAct.sa_sigaction = signalHandler (统一处理器)
      sigAct.sa_flags = SA_SIGINFO | SA_RESTART
      oldAct: 保存旧的处理器 (用于信号链)

  信号链 (libjsig.so):
    如果 LD_PRELOAD=libjsig.so:
      libjsig_is_loaded = true
      JVM 处理器优先
      旧处理器通过信号链级联调用
```

---

## 九、完整结构体大小总表

| 分类 | 结构 | sizeof | 数量 | 总内存 |
|------|------|--------|------|--------|
| 堆 | G1CollectedHeap | 1864B | 1 | 1.9KB |
| 堆 | HeapRegionManager | 208B | 1 | 0.2KB |
| 堆 | G1HeapRegionTable | 48B | 1 | 48B |
| 堆 | HeapRegion | 432B | 2048 | ~864KB |
| 堆 | OtherRegionsTable | 136B | 2048 | 278KB |
| 堆 | G1ConcurrentMark | 1864B | 1 | 1.9KB |
| 堆 | G1CMTask | 392B | 8 | 3.1KB |
| 堆 | G1RemSet | 120B | 1 | 0.1KB |
| 堆 | G1HotCardCache | 384B | 1 | 0.4KB |
| 堆 | CardTable byte_map | — | 1 | ~16MB |
| 类 | InstanceKlass | ~600-2000B | ~200 | ~200KB |
| 类 | Klass base | 208B | ~200+ | ~40KB |
| 类 | Method | 216B | ~5000+ | ~1MB |
| 类 | ConstantPool | 可变 | ~200+ | ~500KB |
| 类 | Symbol | 6+len | ~10000+ | ~200KB |
| 类 | HashtableEntry | 20B | ~20000 | ~400KB |
| 线程 | JavaThread | ~2KB | 8-16 | ~20KB |
| 线程 | OSThread | 232B (GDB) | 8-16 | ~2KB |
| 线程 | TLAB | 144B | 每线程 | ~1KB |
| 编译器 | CompileQueue | 可变 | 2 | ~1KB |
| 编译器 | VtableStubs::_table | 8B×256 | 1 | 2KB |
| 解释器 | StubQueue (解释器) | ~274KB | 1 | ~274KB |
| 代码 | CodeCache total | 48MB | 1 | 48MB |
| 信号 | sigaction 数组 | 可变 | ~32 | ~1KB |
| **总计** | | | | **~67MB** |

注: 堆虚拟地址 reserved 8192MB, 但 commit 量远小于此 (初始约 20-50MB)。

---

## 十、GDB 验证清单

```gdb
# 所有可验证的地址 (来自 8GB 堆日志):
p ((G1CollectedHeap*)0x7ff13c044a50)->capacity()     → 8589934592
p HeapRegion::GrainBytes                              → 4194304
p G1CollectedHeap::heap()->hrm()->max_regions()       → 2048
p (size_t)CodeCache::max_capacity()                   → 50331648
p MetaspaceUtils::committed_bytes()                   → 4587520
p Threads::number_of_threads()                        → ~10
p (address)SharedRuntime::deopt_blob()                → 0x7f0bc5113090
p SystemDictionary::number_of_classes()               → (需估算)
```

---

## 📋 生产场景对应 — 结构体快速定位

| 事故 | 涉及结构 | GDB 定位 |
|------|---------|---------|
| 堆 OOM | G1CollectedHeap/HeapRegion | `p G1CollectedHeap::heap()->capacity()` |
| Metaspace OOM | VirtualSpaceNode/Metachunk | `p MetaspaceUtils::committed_bytes()` |
| 线程栈溢出 | JavaThread/stack_guard_pages | `info threads` → `p thread->_stack_base` |
| TLAB refill 慢 | TLAB/MutatorAllocRegion | `p thread->tlab().end() - thread->tlab().top()` |
| 类加载慢 | SystemDictionary/ConstantPool | `p SystemDictionary::number_of_classes()` |
| JIT 编译慢 | CompileQueue/CompileTask | `p CompileBroker::_c2_compile_queue->_size` |
| synchronized 竞争 | ObjectMonitor/gBlockList | `p ObjectSynchronizer::gOmInUseList` |
| 解释器性能 | StubQueue/TemplateTable | `p (size_t)AbstractInterpreter::code()->total_space()` |
| 信号处理器 crash | sigaction 数组 | `info signals` → 检查 SIGSEGV handler |
| CodeCache 满 | CodeCache/nmethod | `p CodeCache::max_capacity() - CodeCache::unallocated_capacity()` |

---

## 十一、总结

### 数据结构层面
JVM 启动创建了约 **67MB 的 C++ 数据结构**（不含堆虚拟空间 reserved 的 8GB）：
- GC 基础设施 ~17MB（CardTable byte_map 占大头）
- 类元数据 ~3MB
- CodeCache 48MB
- 线程/编译器/解释器 ~3MB

### 算法层面
- `mmap` + `mprotect` 管理虚拟空间，惰性 commit
- `G1RegionToSpaceMapper` 将 Page 粒度映射到 Region 粒度
- `G1CMBitMap` 双缓冲支持并发标记
- `TemplateInterpreter` 生成 274KB 汇编模板


---

## 补充 §2.2：TLAB refill 全流程

### 解决什么问题

Java 线程每秒分配数百万对象。TLAB（Thread-Local Allocation Buffer）让每个线程在自己的私有内存区域做指针碰撞分配，完全无锁。

### 源码追踪

**Step 1: TLAB::allocate() 分配尝试（threadLocalAllocBuffer.inline.hpp）**

```cpp
inline HeapWord* ThreadLocalAllocBuffer::allocate(size_t size) {
  invariants();
  HeapWord* obj = top();                    // ★ 读取当前 top
  // _pf_top = _top + alignment_reserve, 用于对齐
  if (pointer_delta(end(), obj) >= size) { // 空间足够?
    set_top(obj + size);                   // ★ 纯指针碰撞, 无 CAS, 无锁!
    invariants();
    return obj;
  }
  return NULL;                             // ★ TLAB 满, 返回 NULL
}
```

**Step 2: allocate_new_tlab() 获取新 TLAB（memAllocator.cpp）**

```cpp
// 当 TLAB 分配返回 NULL 时:
HeapWord* MemAllocator::allocate_inside_tlab(size_t word_size) {
  HeapWord* obj = _thread->tlab().allocate(word_size); // Step 1
  if (obj != NULL) return obj;
  // TLAB 满了, 需要重填
  return allocate_new_tlab(word_size);  // Step 3
}
```

**Step 3: G1Allocator::attempt_allocation()（g1Allocator.cpp）**

```cpp
// 从 MutatorAllocRegion 获取新 TLAB
HeapWord* G1Allocator::attempt_allocation(size_t word_size) {
  MutatorAllocRegion* alloc_region = &_mutator_alloc_region;
  // 先尝试 active alloc region
  HeapWord* result = alloc_region->attempt_allocation(word_size);
  if (result != NULL) return result;
  // 尝试 retained alloc region
  result = alloc_region->attempt_retained_allocation(word_size);
  if (result != NULL) return result;
  // 需要新的 Eden Region
  alloc_region->new_alloc_region();  // → 从 FreeRegionList 取
  return alloc_region->attempt_allocation(word_size);
}
```

### 完整序列图

```mermaid
sequenceDiagram
    participant JT as JavaThread
    participant T as TLAB
    participant MA as MemAllocator
    participant GA as G1Allocator
    participant MAR as MutatorAllocRegion
    participant HR as HeapRegion(Eden)

    JT->>T: allocate(size)
    T->>T: obj=top; top+=size
    T-->>JT: obj (fast path ✓)

    Note over JT,T: TLAB 满时:
    JT->>T: allocate(size)
    T-->>JT: NULL
    JT->>MA: allocate_inside_tlab(size)
    MA->>GA: attempt_allocation(65536)
    GA->>MAR: attempt_allocation()
    MAR-->>GA: NULL (当前 Eden 满)
    GA->>MAR: new_alloc_region()
    MAR->>HR: new HeapRegion(Free→Eden)
    MAR->>MAR: 设置 _alloc_region
    GA->>MAR: attempt_allocation()
    MAR-->>GA: 新 TLAB 地址
    GA-->>MA: 新 TLAB
    MA->>T: set_start/top/end
    T->>T: allocate(size)
    T-->>JT: obj (slow path)
```


---

## 补充 §三（SymbolTable）：Symbol 的创建与查找

### 源码（symbolTable.cpp:lookup + basic_add）

```cpp
// symbolTable.cpp: SymbolTable::lookup(const char* name, int len, unsigned int hash)
Symbol* SymbolTable::lookup(const char* name, int len, unsigned int& hash) {
  hash = hash_symbol(name, len);                    // ★ 计算 hash
  int index = hash_to_index(hash);                   // ★ bucket 索引
  for (Symbol* s = _buckets[index]._entry; s != NULL; s = s->next()) {
    if (s->equals(name, len)) { return s; }          // ★ 找到, 返回已有 Symbol
  }
  Symbol* sym = SymbolTable::create_symbol(name, len, hash); // 新分配
  basic_add(sym, index, hash);                       // ★ 插入 hashtable
  return sym;
}
```

**Symbol 的哈希算法（Symbol::hash()）:**
使用 `AltHashing？murmur3_32():java_hash()`。
对于大多数启动阶段的类名，使用 `java_hash()`——基于 UTF-8 字符的迭代哈希。

**为什么 Symbol 用 refcount 而不是 GC？**
- Symbol 存储在 Metaspace 中，不是 Java 堆对象
- refcount 简化了生命周期管理：`++` 当被引用时，`--` 当引用释放时，`0` 时回收
- 避免了 GC 扫描 Metaspace 的开销


---

## 补充 §四（SystemDictionary）：类查找流程

### 执行 `new Object()` 时如何找到 Object 的 InstanceKlass

源码追踪（systemDictionary.cpp:resolve_or_fail → Dictionary::find）:

```cpp
// systemDictionary.cpp
Klass* SystemDictionary::resolve_or_fail(Symbol* class_name, ...) {
  // Step 1: 查字典
  Klass* k = dictionary()->find(class_name);  // O(1) hash 查找
  if (k != NULL) return k;                    // ★ 已加载, 直接返回

  // Step 2: 类还没加载, 触发加载
  Klass* loaded = load_instance_class(class_name, loader, THREAD);
  // → ClassLoader::loadClass()
  //   → ClassFileParser::parseClassFile()
  //     → InstanceKlass 创建
  //       → Dictionary::add_klass() (注册)
  return loaded;                               // ★ 返回新加载的 InstanceKlass*
}
```

```cpp
// dictionary.cpp
Klass* Dictionary::find(Symbol* name) {
  unsigned int hash = compute_hash(name);
  int index = hash_to_index(hash);
  for (DictionaryEntry* e = bucket(index); e != NULL; e = e->next()) {
    if (e->hash() == hash && e->klass()->name() == name) {
      return e->klass();                       // ★ O(1) 平均, 哈希冲突链遍历
    }
  }
  return NULL;                                 // ★ 未找到
}
```

### ConstantPoolCache 加速

```
第一次: ldc #5 → ConstantPool::klass_at(5)
  → SystemDictionary::resolve_or_fail()
  → Dictionary::find("java/lang/Object")
  → 写入 ConstantPoolCache::_f1[5] = Klass*
     _flags[5].set_is_resolved()

后续: ldc #5 → 读取 _f1[5] → 直接返回 Klass*（纯内存读, 无哈希查找!）
```


---

## 补充 §六（编译器）：从解释执行到编译执行

### InvocationCounter 结构

```
Method::_method_counters (88B, Metaspace)
  ├── _invocation_counter (4B): 方法调用计数
  │     ┌───────────────────────────────┐
  │     │ state(2bits) | carry(1bit) | count(29bits) │
  │     │ state: wait_for_compile(1), wait_for_nothing(0) │
  │     │ carry: 溢出标志                │
  │     │ count_increment = 8            │
  │     └───────────────────────────────┘
  │     每方法入口: _invocation_counter += count_increment
  │
  └── _backedge_counter (4B): 回边计数 (循环)
        backward_branch_limit = 10700 (ProfileInterpreter=true)
```

### 编译触发

```
方法入口:
  1. _invocation_counter += 8
  2. 检查 carry bit → 是否溢出?
     溢出 → check: 总数 > CompileThreshold(10000)?
       YES → CompileBroker::compile_method(method, ...)
         → CompileQueue::add(CompileTask)
           → CompilerThread 异步编译
       NO → 重置并继续解释

编译后:
  Method::_from_compiled_entry → nmethod::_verified_entry_point
  Method::_from_interpreted_entry → c2i adapter (从解释器跳转到编译代码)

去优化:
  编译代码中发现需要回退 → Deoptimization::unpack()
  恢复解释器栈帧 → 继续解释执行
```
