# 02-DCmd-Diagnostic-Commands — DCmd 框架：工厂注册链、命令调度、RAII 保护

> **阶段**：[10-services-diag]
> **前置**：[10-01], [08-safepoint]
> **依赖本文**：[10-03], [10-04]
> **阅读收益**：理解 jcmd 40+ 诊断命令的注册/调度全链路——DCmdFactory 链表注册、parse_and_execute 的 9 步流程、DCmdMark RAII 异常安全

---

## §〇 源文件清单（跨 services 模块，标注每文件角色）

| # | 文件 | 路径 | 核心函数/类（行号） | 本文角色 |
|---|------|------|-------------------|---------|
| 1 | `diagnosticFramework.hpp` | `src/hotspot/share/services/diagnosticFramework.hpp` | `DCmd`(:238-308), `DCmdFactory`(:345-400), `DCmdParser`(:203-222), `DCmdMark`(:326-338), `DCmdWithParser`(:310-324) | ★★★ 框架核心 |
| 2 | `diagnosticFramework.cpp` | `src/hotspot/share/services/diagnosticFramework.cpp` | `DCmd::parse_and_execute()`(:384-413), `DCmdFactory::factory()`(:496-511), `register_DCmdFactory()`(:513-522), `create_local_DCmd()`(:524-536) | ★★★ 主入口 |
| 3 | `diagnosticCommand.hpp` | `src/hotspot/share/services/diagnosticCommand.hpp` | `HelpDCmd`, `VersionDCmd`, `ThreadDumpDCmd`(:448), `ClassHistogramDCmd`(:359), `VMInfoDCmd`(:243) | ★★ 命令定义 |
| 4 | `diagnosticCommand.cpp` | `src/hotspot/share/services/diagnosticCommand.cpp` | `DCmdRegistrant::register_dcmds()`(:69), 各命令 execute() | ★★ 注册表 |
| 5 | `diagnosticArgument.hpp` | `src/hotspot/share/services/diagnosticArgument.hpp` | `GenDCmdArgument`(:62), `DCmdArgument<T>`(:109) | ★ 参数类型 |
| 6 | `management.cpp` | `src/hotspot/share/services/management.cpp` | `Management::init()`(:97) → `register_dcmds()`(:148) | ★ 注册触发 |
| 7 | `attachListener.cpp` | `src/hotspot/share/services/attachListener.cpp` | `jcmd()`(:202-216) → `DCmd::parse_and_execute(DCmd_Source_AttachAPI, ...)` | ★ 入口 |

---

## §〇 生产场景——当你敲下 jcmd 命令时

### Thread.print -l：死锁检测

```bash
$ jcmd 12463 Thread.print -l
"http-nio-8080-exec-3" #39 daemon prio=5 tid=0x00007f8b24111800 nid=0x5cee waiting for monitor entry
   java.lang.Thread.State: BLOCKED (on object monitor)
        at com.example.service.LockService.methodB(LockService.java:47)
        - waiting to lock <0x0000000714d8af80>
        - locked <0x0000000714d8af90>

"http-nio-8080-exec-1" #37 daemon prio=5 tid=0x00007f8b24110000 nid=0x5cec waiting for monitor entry
   java.lang.Thread.State: BLOCKED (on object monitor)
        at com.example.service.LockService.methodA(LockService.java:35)
        - waiting to lock <0x0000000714d8af90>
        - locked <0x0000000714d8af80>

Found one Java-level deadlock:
=============================
"http-nio-8080-exec-3":
  waiting for ownable synchronizer 0x0000000714d8af80,
  which is held by "http-nio-8080-exec-1"
```

→ JVM 内部：`"Thread.print -l"` → `jcmd()` → `DCmd::parse_and_execute(DCmd_Source_AttachAPI)` → `factory("Thread.print")` 在 `_DCmdFactoryList` 单链表中线性搜索 → `DCmdFactoryImpl<ThreadDumpDCmd>` → `create_resource_instance()` → `DCmdMark` RAII 构造 → `parse("-l")` 将 `-l` 解析为 `_locks=true` → `execute()` → **三个 VM_Operation 依次入队**：`VM_PrintThreads`、`VM_PrintJNI`、`VM_FindDeadlocks`——每个都需要 **safepoint**。

### GC.class_histogram：内存泄漏排查第一步

```bash
$ jcmd 12463 GC.class_histogram | head -20
 num     #instances         #bytes  class name (module)
-------------------------------------------------------
   1:       1283952       225975552  [B (java.base@11.0.22)
   2:        513680        12328320  java.util.HashMap$Node
   3:        502446        12058704  java.lang.String
   4:        298774         9560768  java.util.concurrent.ConcurrentHashMap$Node
   5:        156860         7529280  com.example.entity.Order (app)
```

→ JVM 内部：`ClassHistogramDCmd::execute()` → `VM_GC_HeapInspection` → `VMThread::execute()` → **safepoint** → `SystemDictionary::classes_do()` 遍历所有 loaded Class → 统计实例数和字节数 → 按字节降序排列。

### VM.system_properties / VM.version / VM.native_memory：无需 safepoint

```bash
$ jcmd 12463 VM.system_properties
java.runtime.name=OpenJDK Runtime Environment
java.vm.version=11.0.22+9-LTS
file.encoding=UTF-8
```

→ `PrintSystemPropertiesDCmd::execute()` → `SystemProperty::print()` → 从 `SystemDictionary::_system_properties` 遍历——**不需要 safepoint**（只读静态 HashMap）。

### GC.run — 生产慎用

```bash
$ jcmd 12463 GC.run
```

→ `SystemGCDCmd::execute()` → `Universe::heap()->collect(GCCause::_dcmd_gc_run)` → **Full GC**。DCmd 框架本身只做字符串解析和命令调度——不判断这个命令是否危险。

---

## §一 ★★★ DCmdFactory 注册链——单向链表 + 头插法

### ❓ 为什么 40+ 命令用线性搜索而不是 hash map？

推理如下：
1. **命令数 ~40**：线性扫描 O(40) 的最坏情况是 40 次 `strncmp()`——约 400-800 CPU cycles（~150-300ns）。对于人工触发的诊断操作（非每秒几百次的高频调用），这个开销可忽略
2. **hash map 的内存/复杂度开销不值得**：需要 hash 函数、碰撞链表/开地址、rehash 逻辑——至少增加 200+ 行代码
3. **单向链表不依赖 malloc/free**：`_DCmdFactoryList` 的节点在 VM 启动时静态 new 出，之后只遍历不分配——信号安全，和 [04-VMError] 的设计理念一致
4. **简单性 > 极致性能**：和 JVM 的整体设计哲学一致

### 1.1 _DCmdFactoryList 全局链表结构

```cpp
// diagnosticFramework.cpp:381
DCmdFactory* DCmdFactory::_DCmdFactoryList = NULL;

// diagnosticFramework.hpp:349-353
class DCmdFactory: public CHeapObj<mtInternal> {
private:
  static DCmdFactory* _DCmdFactoryList;   // ★ 全局链表头
  DCmdFactory*        _next;              // ★ 单向链接
};
```

链表构建方式：**头插法**——每次注册插入链表头部：

```cpp
// diagnosticFramework.cpp:513-522
int DCmdFactory::register_DCmdFactory(DCmdFactory* factory) {
  MutexLockerEx ml(DCmdFactory_lock, Mutex::_no_safepoint_check_flag);
  factory->_next = _DCmdFactoryList;      // ① 新节点指向旧头部
  _DCmdFactoryList = factory;             // ② 头部指向新节点
  if (_send_jmx_notification && !factory->_hidden
      && (factory->_export_flags & DCmd_Source_MBean)) {
    DCmdFactory::push_jmx_notification_request();  // ③ 通知 JMX
  }
  return 0;  // Actually, there's no checks for duplicates
}
```

**ASCII 链表结构**：

```
_DCmdFactoryList (全局)
       │
       ▼
  ┌──────────────┐   _next   ┌──────────────┐   _next   ┌──────────────┐   _next
  │ MetaspaceDCmd │ ────────→ │ DebugOnCmd    │ ────────→ │ JMXStatus    │ ─────...→ NULL
  │ name="VM."   │           │ name="VM."    │           │ name="Mgmt." │
  │  metaspace"  │           │ start_java.." │           │  .status"    │
  └──────────────┘           └──────────────┘           └──────────────┘
       ▲                                                  (最后注册)
       │
    第 N 个注册（HEAD）               第 2 个注册           第 1 个注册（TAIL）
    (newest，线性查找最先命中)        (HelpDCmd)           (HelpDCmd，线性查找最后命中)
```

头插法的结果是：**后注册的先查到**。`register_dcmds()` 的注册顺序决定了 `help` 命令的输出顺序——`HelpDCmd` 最先注册，在链表最尾部（最后被遍历到），所以 `jcmd help` 的输出列表末尾是 `Compiler.directives_*` 系列（最后注册的）。

### 1.2 DCmdRegistrant::register_dcmds() 批量注册

```cpp
// diagnosticCommand.cpp:69-133
void DCmdRegistrant::register_dcmds(){
  uint32_t full_export = DCmd_Source_Internal | DCmd_Source_AttachAPI
                         | DCmd_Source_MBean;
  DCmdFactory::register_DCmdFactory(new DCmdFactoryImpl<HelpDCmd>(full_export, true, false));
  DCmdFactory::register_DCmdFactory(new DCmdFactoryImpl<VersionDCmd>(full_export, true, false));
  DCmdFactory::register_DCmdFactory(new DCmdFactoryImpl<CommandLineDCmd>(full_export, true, false));
  // ... ~35 more registrations ...
  // HeapDumpDCmd: only AttachAPI + Internal (NO MBean!)
  DCmdFactory::register_DCmdFactory(new DCmdFactoryImpl<HeapDumpDCmd>(
        DCmd_Source_Internal | DCmd_Source_AttachAPI, true, false));
  // ... rest ...
  // JMX agent commands: only AttachAPI + Internal
  uint32_t jmx_agent_export_flags = DCmd_Source_Internal | DCmd_Source_AttachAPI;
  DCmdFactory::register_DCmdFactory(new DCmdFactoryImpl<JMXStartRemoteDCmd>(jmx_agent_export_flags, true, false));
  // ...
}
```

**注册时机**：`Management::init()` → `register_dcmds()`（`management.cpp:148`）→ 在 VM 启动阶段的 `Management::init()` 中被调用，早于任何 jcmd 或 JMX 连接。

### 1.3 DCmdFactoryImpl<T> 模板——编译期绑定命令名和实现类

```cpp
// diagnosticFramework.hpp:404-427
template <class DCmdClass> class DCmdFactoryImpl : public DCmdFactory {
public:
  DCmdFactoryImpl(uint32_t flags, bool enabled, bool hidden) :
    DCmdFactory(DCmdClass::num_arguments(), flags, enabled, hidden) { }

  DCmd* create_resource_instance(outputStream* output) const {
    return new DCmdClass(output, false);          // ★ ResourceObj arena 分配
  }

  const char* name() const {
    return DCmdClass::name();                     // ★ 编译期绑定，如 "Thread.print"
  }
  const char* description() const {
    return DCmdClass::description();
  }
  const char* impact() const {
    return DCmdClass::impact();
  }
  const JavaPermission permission() const {
    return DCmdClass::permission();
  }
};
```

**为什么用模板而不是虚函数表？** 命令名字符串 `"Thread.print"` 是 `ThreadDumpDCmd::name()` 的静态方法返回值——模板在编译期就绑定了 `DCmdClass::name()`。如果用虚函数，每个 factory 子类需要重写 name()——代码量相同但有虚表开销。模板在编译期完全展开，零运行时开销。

### 1.4 factory() 线性搜索的完整实现

```cpp
// diagnosticFramework.cpp:496-511
DCmdFactory* DCmdFactory::factory(DCmdSource source, const char* name, size_t len) {
  MutexLockerEx ml(DCmdFactory_lock, Mutex::_no_safepoint_check_flag);
  DCmdFactory* factory = _DCmdFactoryList;
  while (factory != NULL) {
    if (strlen(factory->name()) == len &&              // ★ 先比长度（快速过滤）
        strncmp(name, factory->name(), len) == 0) {    // ★ 再比内容
      if(factory->export_flags() & source) {           // ★ 检查是否对此 source 导出
        return factory;
      } else {
        return NULL;        // 命令存在但对此 source 不可见
      }
    }
    factory = factory->_next;
  }
  return NULL;
}
```

**锁注释**：`DCmdFactory_lock` 使用 `Mutex::_no_safepoint_check_flag`——持有此锁时可能触发 safepoint 检查，但 safepoint 中不需要此锁。这意味着 `factory()` 可以在任何线程上下文中调用（包括 VMThread）。

**export_flags 过滤**：`HeapDumpDCmd` 注册时只给了 `DCmd_Source_Internal | DCmd_Source_AttachAPI`——不包含 `DCmd_Source_MBean`。所以 JMX 路径查 `HeapDumpDCmd` → `export_flags() & source` 为 0 → 返回 NULL。

### 1.5 DCmdRegistrant 是 Management 的 friend——为什么要耦合？

```cpp
// diagnosticFramework.hpp:439
friend class Management;
```

命令注册必须在 `Management` 初始化时触发——因为注册完成后需要推 JMX 通知（`send_notification()`）。如果 AttachListener 启动时独立注册，JMX client 在 `ManagementAgent.start` 之前就能调用 DCmd → MBean 不存在 → `createDiagnosticFrameworkNotification()` 失败。

这是 DCmd 框架的设计约束：**注册 = Management 初始化的一环**，不可分割。

---

## §二 ★★★ DCmd::parse_and_execute() 全路径——9 步命令执行

### 2.1 ASCII 9 步流程图（标注线程身份 + 行号）

```
AttachListener 线程 (JavaThread, 在 _thread_in_vm 中)
│
├─ Step 1: iter = DCmdIter(cmdline, '\n')         [diagnosticFramework.cpp:388]
│           │ 按 '\n' 分割多命令
│           │ 线程：JavaThread（AttachListener）
│
├─ Step 2: while (iter.has_next())                 [diagnosticFramework.cpp:391]
│           │ ★ JMX 特殊检查
│           │
├─ Step 3: if (source == DCmd_Source_MBean && count > 0)  [:392]
│           │    → THROW_MSG("Invalid syntax")     ← JMX 只允许单命令
│           │
├─ Step 4: CmdLine line = iter.next()              [:399]
│           │ → 从原始字符串中提取命令名 + 参数
│           │
├─ Step 5: DCmd* command = DCmdFactory::create_local_DCmd(source, line, out, CHECK)
│           │                                          [:405]
│           ├─ Step 5a: factory(source, cmd_name, len) [:526]
│           │              → 在 _DCmdFactoryList 中线性搜索 [:496]
│           │                持有 DCmdFactory_lock
│           ├─ Step 5b: f->create_resource_instance(out) [:532]
│           │              → new DCmdClass(out, false)  ← ResourceObj arena
│           │                返回 DCmd* (未解析参数)
│
├─ Step 6: DCmdMark mark(command)                  [:407]
│           │ StackObj RAII: 构造时无操作，析构时 cleanup() + delete
│
├─ Step 7: command->parse(&line, delim, CHECK)     [:408]
│           │ → DCmdParser::parse() [:190]
│           │   遍历 tokens，匹配参数名和值
│
├─ Step 8: command->execute(source, CHECK)         [:409]
│           │ ★ 此步可能进入 safepoint（见 §五）
│           │   线程可能从 JavaThread → VMThread（通过 VM_Operation）
│
└─ Step 9: ~DCmdMark()                              [automatic, :330]
            │ → command->cleanup()  ← 释放参数资源 [:331]
            │ → if (is_heap_allocated()) delete command [:333]
            │ ★ 异常路径（THROW_MSG → longjmp）也会触发
```

### 2.2 JMX 和 Attach 路径的行为差异

| 维度 | `DCmd_Source_AttachAPI` (0x2) | `DCmd_Source_MBean` (0x4) |
|------|------------------------------|--------------------------|
| **多命令** | 可以，用 `\n` 分隔 | **禁止** ← 第一步就 THROW_MSG |
| **可见命令** | 所有 `export_flags & 0x2` 的命令 | 只限于 `export_flags & 0x4` 的命令 |
| **典型入口** | `jcmd()` ([10-01]§一) | `DiagnosticCommandImpl.invoke()` via JMX |
| **权限模型** | SO_PEERCRED（本地套接字） | JMX 认证 + JavaPermission |

**为什么 JMX 禁止多命令？** 如果 JMX 远程调用可以执行 `"GC.run\nThread.print -l"`，攻击者可以一次请求执行多个命令绕过单次权限检查。逐条限制确保每个 command 独立检查 `JavaPermission`。

### 2.3 DCmdSource 三值的行为差异表

```
DCmd_Source_Internal  = 0x01U ← VM 内部调用（如 NMT 的定期报告）
DCmd_Source_AttachAPI = 0x02U ← 来自 jcmd / Attach 管道 [10-01]
DCmd_Source_MBean     = 0x04U ← 来自 JMX DiagnosticCommandMBean
```

| source | 多命令 | 权限检查 | export_flags 过滤 | 典型场景 |
|--------|--------|---------|------------------|---------|
| `Internal` (0x01) | 允许 | 无 | `flags & 0x01` | Management 内部调用 |
| `AttachAPI` (0x02) | 允许 | SO_PEERCRED | `flags & 0x02` | `jcmd <PID> <cmd>` |
| `MBean` (0x04) | **禁止** | JavaPermission | `flags & 0x04` | JConsole MBeans |

---

## §三 ★★ DCmdMark RAII——为什么不能省略

### 3.1 核心源码

```cpp
// diagnosticFramework.hpp:326-338
class DCmdMark : public StackObj {
  DCmd* const _ref;
public:
  DCmdMark(DCmd* cmd) : _ref(cmd) {}
  ~DCmdMark() {
    if (_ref != NULL) {
      _ref->cleanup();                           // ★ 回收参数资源
      if (_ref->is_heap_allocated()) {           // ★ heap 分配才 delete
        delete _ref;
      }
      // ResourceObj 分配的不需要 delete——arena 自动回收
    }
  }
};
```

### 3.2 异常安全的双重路径

```
正常路径：                          异常路径：
command->parse()                     command->parse()
command->execute()                   command->execute() → THROW_MSG
                                       → longjmp to CHECK point
  ↓ 返回                                ↓ 栈展开
  ↓                                   ~DCmdMark()
~DCmdMark()                             ├─ cleanup()     ← ★ 参数资源释放
  ├─ cleanup()     ← ★ 参数释放         └─ delete        ← ★ 命令对象释放
  └─ delete        ← ★ 命令释放
```

**为什么 `parse_and_execute()` 中的 `CHECK` 能触发栈展开？**

```cpp
// diagnosticFramework.cpp:405-409
DCmd* command = DCmdFactory::create_local_DCmd(source, line, out, CHECK);
// CHECK 展开为：THREAD); if (HAS_PENDING_EXCEPTION) return; (void)(0
DCmdMark mark(command);                           // ← 正常构造
command->parse(&line, delim, CHECK);               // ← CHECK 可能触发 longjmp
command->execute(source, CHECK);
// } ← ~DCmdMark() 在这里
```

如果 `create_local_DCmd` 内部抛出异常（`THROW_MSG_NULL`）→ `CHECK` 宏检测到 → `return` → **DCmdMark 还没有构造** → 不需要析构。

如果 `parse()` 或 `execute()` 内部抛出异常 → `CHECK` 宏触发 `longjmp` → **DCmdMark 已经在栈上** → 栈展开调用 `~DCmdMark()` → cleanup + delete。

### 3.3 ★ 如果 execute() 触发 GC（safepoint），DCmdMark 析构会被跳过吗？

**不会。** GC 在 safepoint 内由 VMThread 执行。JavaThread（AttachListener）在 safepoint 阻塞——调用栈完整保留。GC 完成后 VMThread 释放 safepoint → JavaThread 唤醒 → 继续执行 execute() 之后的代码 → 函数返回 → 栈展开 → ~DCmdMark() 执行。

GC 不破坏栈——DCmdMark 在栈上安全。

**时序验证**：

```
ThreadDumpDCmd::execute():
  → VMThread::execute(&op1)             ← 入队 VM_PrintThreads
    → VMThread 在下一个 safepoint 执行 op1.doit()
    → AttachListener 线程阻塞在 Threads_lock 上
    → op1 完成 → VMThread 唤醒 AttachListener
  → VMThread::execute(&op2)             ← 入队 VM_PrintJNI
  → VMThread::execute(&op3)             ← 入队 VM_FindDeadlocks
  → 返回

→ 函数继续 → parse_and_execute 的 while 循环继续
→ 循环结束 → ~DCmdMark() → cleanup + delete ← 始终执行
```

### 3.4 DCmdMark 和 VM_Operation 的 Scope 级别对比

| 维度 | DCmdMark | VM_Operation |
|------|----------|-------------|
| **作用域** | 单个命令执行期间 | 跨线程的 safepoint 操作 |
| **生命周期** | JavaThread 栈上 | C-heap 分配 + VMThread 执行队列 |
| **清理保证** | 栈展开自动 | 显式 delete（通过 VM_Operation::evaluate_at_safepoint） |
| **异常安全** | RAII 天然 | 需要每个 VM_Operation 自己处理 |
| **性能代价** | ~0（StackObj，不分配） | ~200ns（入队 + ticket + safepoint 同步） |

---

## §四 ★★ DCmdParser 参数解析模型

### 4.1 为什么需要类型化参数系统？strtok 不够吗？

**不够。** strtok 只能做纯字符串分割：

```
"Thread.print -l=true -e"
  → strtok: ["-l=true", "-e"]     ← 不知道 "-l" 是 bool 还是 string
  → 需要手动 strcmp("true") 转 bool
  → 无法验证参数名（-locks 误写为 -lock 静默忽略）
  → 无法提供默认值和必填检查
```

DCmdParser 提供类型化参数校验：

```cpp
// diagnosticCommand.cpp:628-633 — ThreadDumpDCmd 的参数定义
ThreadDumpDCmd::ThreadDumpDCmd(outputStream* output, bool heap) :
  _locks("-l", "print java.util.concurrent locks", "BOOLEAN", false, "false"),
  _extended("-e", "print extended thread information", "BOOLEAN", false, "false") {
  _dcmdparser.add_dcmd_option(&_locks);
  _dcmdparser.add_dcmd_option(&_extended);
}
```

`DCmdArgument<bool>` 模板自动处理 `"true"`/`"false"` 字符串到 bool 的转换（`diagnosticArgument.cpp:142-180`）。

### 4.2 参数类型表

| 类型 | 模板实例 | parse 方式 | 典型命令 |
|------|---------|-----------|---------|
| `DT_STRING` | `DCmdArgument<char*>` | `NEW_C_HEAP_ARRAY` 拷贝 | `HeapDumpDCmd::_filename` |
| `DT_BOOL` | `DCmdArgument<bool>` | 比较 `"true"`/`"false"` | `ThreadDumpDCmd::_locks` |
| `DT_INT` | `DCmdArgument<jlong>` | `sscanf` with `JLONG_FORMAT` | `HeapDumpDCmd::_gzip` |
| `DT_NANOTIME` | `DCmdArgument<NanoTimeArgument>` | 数字+单位（ns/us/ms/s/m/h/d） | `VMUptimeDCmd` |
| `DT_MEM_TYPE` | `DCmdArgument<MemorySizeArgument>` | 数字+乘数（K/M/G） | `NMTDCmd` |
| `DT_STRINGARRAY` | `DCmdArgument<StringArrayArgument*>` | 追加到 GrowableArray | `VM.class_stats` |

### 4.3 parse() 的执行流程

```cpp
// diagnosticFramework.cpp:190-221 — DCmdParser::parse()
void DCmdParser::parse(CmdLine* line, char delim, TRAPS) {
  DCmdArgIter iter(line->args_addr(), line->args_len(), delim);
  GenDCmdArgument* cur_arg = _arguments_list;
  bool new_arguments = false;
  while (iter.has_next()) {
    int pos = iter.position();
    char* token = iter.next(CHECK);

    // ① 先尝试匹配选项（-name=value 或 -name）
    GenDCmdArgument* arg = lookup_dcmd_option(token, pos);

    // ② 如果没匹配到选项，尝试匹配位置参数
    if (arg == NULL && cur_arg != NULL) {
      arg = cur_arg;
      cur_arg = cur_arg->next();
      new_arguments = true;
    }

    // ③ 解析值
    if (arg != NULL) {
      arg->read_value(token, pos, CHECK);
    }
  }
  check(CHECK);  // ④ 验证所有必填参数已 set
}
```

和 Attach 协议层（[10-01]§四 `\0` 分隔）的对比：Attach 层只做纯字节分割——"是什么命令"、"有几个参数"。DCmdParser 做高级的命名参数解析——"哪个参数对应哪个变量"、"值是什么类型"、"默认值是什么"。两个分层各司其职。

---

## §五 ★★ 4 个代表性 DCmd 走读

### 5.1 命令表

| 命令 | 实现类 | execute() 终点 | 需要 safepoint? | 影响级别 |
|------|--------|---------------|-----------------|---------|
| `Thread.print -l` | `ThreadDumpDCmd` | 3 次 `VMThread::execute()` | ★ 是（3 次） | **Medium** |
| `GC.class_histogram` | `ClassHistogramDCmd` | `VM_GC_HeapInspection` via VMThread | ★ 是 | **High** |
| `VM.info` | `VMInfoDCmd` | `VMError::print_vm_info()` | 否 | Low |
| `VM.native_memory` | `NMTDCmd` | `MemTracker::report()` | 否 | Low |

### 5.2 ThreadDumpDCmd — 需要 safepoint × 3

```cpp
// diagnosticCommand.cpp:636-648
void ThreadDumpDCmd::execute(DCmdSource source, TRAPS) {
  // ① 线程栈 dump
  VM_PrintThreads op1(output(), _locks.value(), _extended.value());
  VMThread::execute(&op1);                          // ← safepoint 1

  // ② JNI global handles
  VM_PrintJNI op2(output());
  VMThread::execute(&op2);                          // ← safepoint 2

  // ③ 死锁检测
  VM_FindDeadlocks op3(output());
  VMThread::execute(&op3);                          // ← safepoint 3
}
```

**为什么需要 3 次 safepoint 而不是 1 次？** 三个 `VM_Operation` 有依赖顺序——必须先获取线程栈，再分析 JNI 引用，最后做死锁检测。每个 `VM_Operation::evaluate_at_safepoint()` 返回的是独立结果，之间不需要持有锁（VMThread 在每次 `doit()` 调用之间处于 `end()` 状态）。

### 5.3 ClassHistogramDCmd — 需要 safepoint

```cpp
// diagnosticCommand.cpp:558-562
void ClassHistogramDCmd::execute(DCmdSource source, TRAPS) {
  VM_GC_HeapInspection heapop(output(),
                              !_all.value() /* request full gc if false */);
  VMThread::execute(&heapop);   // ← safepoint: 遍历 SystemDictionary + 统计实例
}
```

`safepoint 必要性`：`SystemDictionary::classes_do()` 在遍历 ClassLoaderData 链时要求 SystemDictionary 不改变——否则 C++ 迭代器（底层是 Hashtable 的 `BucketIterator`）会在并发插入时失效。

### 5.4 VMInfoDCmd — 不需要 safepoint

```cpp
// diagnosticCommand.cpp:435-437
void VMInfoDCmd::execute(DCmdSource source, TRAPS) {
  VMError::print_vm_info(_output);
}
```

`print_vm_info()` 只打印 VM 配置信息（JVM 版本、内存布局、系统属性等）——不遍历堆、不遍历线程栈、不读 SystemDictionary。纯读操作，不需要 heap consistency。但要注意：这些"只读"字段的访问没有锁保护——如果另一个线程同时修改它们（极少发生），可能读到不一致的值——但这是可接受的诊断命​​令行为。

### 5.5 NMTDCmd — 不需要 safepoint

```
NMTDCmd::execute()
  → MemTracker::report()     ← 只读 NMT 原子计数器
    → MallocMemorySummary::_snapshot ← 每次 os::malloc() 已更新
```

NMT 的计数器由 `MallocTracker::record_malloc()` 在每次 `os::malloc()` 中原子更新（`Atomic::add`）。报告时直接读——不需要一致性快照（最终一致性即可）。

### 5.6 safepoint 需要性分类

**需要 safepoint 的命令**（遍历需要一致性的数据结构）：
- `Thread.print` → 遍历所有线程栈
- `GC.class_histogram` → 遍历 SystemDictionary
- `GC.class_stats` → 遍历 SystemDictionary + 类统计
- `Compiler.queue` → 遍历编译队列
- `VM.class_hierarchy` → 遍历类层次
- `VM.symboltable` / `VM.stringtable` → 遍历符号/字符串表

**不需要 safepoint 的命令**（只读配置或原子计数器）：
- `VM.version`, `VM.command_line`, `VM.flags`, `VM.system_properties`
- `VM.info`, `VM.uptime`, `VM.dynlibs`
- `VM.native_memory` → 读 NMT 原子计数器
- `Compiler.directives_*` → 读写编译指令（不涉及 Java 堆）
- `GC.heap_info` → 读 GC 配置（需 Heap_lock 但非 safepoint）

---

## §六 ★ JMX MBean 对接 + 和 [10-01] 的连接

### 6.1 和 [10-01] 的精确连接

```
[10-01] attachListener.cpp:202  jcmd()
  │
  ├─ DCmd::parse_and_execute(
  │       DCmd_Source_AttachAPI,     ← source = 0x2
  │       out,                        ← bufferedStream → 最终 write_fully 发送
  │       op->arg(0),                 ← "Thread.print -l" 整个字符串
  │       ' ',                        ← delim = ' ' (DCmd 参数分隔)
  │       THREAD
  │  )
  │
  └─ → [10-02] diagnosticFramework.cpp:384  DCmd::parse_and_execute()
         → DCmdFactory::create_local_DCmd() → factory() → ThreadDumpDCmd
         → DCmdMark → parse → execute → cleanup → delete
```

这是 10-services-diag 阶段的核心连接点。后续 [10-03] 将分析这些 DCmd 命令的底层结果输出（sink）——`outputStream` 如何进入 `bufferedStream`，再通过 `write_fully()` 发回给客户端。

### 6.2 JMX DiagnosticCommandMBean 的转发路径

```
JMX 客户端 (JConsole / HTTP API / JMX REST)
  │
  ├─ MBeanServer.invoke(
  │     "com.sun.management:type=DiagnosticCommand",
  │     "Thread.print",
  │     new Object[] {"-l"},
  │     new String[] {"java.lang.String"}
  │  )
  │
  └─ → DiagnosticCommandImpl.invoke(cmdName="Thread.print", cmdLineArgs="-l")
        → DCmd::parse_and_execute(
              DCmd_Source_MBean,          ← source = 0x4 ★ 和 Attach 路径不同
              &output,
              cmdline,                    ← "Thread.print -l"
              ' ',
              CHECK_NULL
          )
```

JMX 路径走到完全相同的一行代码——`DCmd::parse_and_execute()`（`management.cpp:2077`）。唯一区别是 `source == DCmd_Source_MBean` → 禁止多命令 + 不同的 export_flags 过滤。

### 6.3 send_notification() 的 JMX 事件推送

新命令注册后，通过 `push_jmx_notification_request()` → `Service_lock->notify_all()` → ServiceThread 唤醒 → `send_notification_internal()` → `JavaCalls::call_virtual` 调用 `DiagnosticCommandImpl.createDiagnosticFrameworkNotification()` → JMX client 收到 MBean 变更通知。

```cpp
// diagnosticFramework.cpp:439-443
void DCmdFactory::push_jmx_notification_request() {
  MutexLockerEx ml(Service_lock, Mutex::_no_safepoint_check_flag);
  _has_pending_jmx_notification = true;
  Service_lock->notify_all();        // ★ 唤醒 ServiceThread
}
```

### 6.4 DisableAttachMechanism 不能阻止 JMX 的 DCmd 调用

`-XX:+DisableAttachMechanism` 的效果链：
```
DisableAttachMechanism=true
  → AttachListener::is_attach_supported() = false   [attachListener.hpp:110]
  → AttachListener::vm_start() 被跳过               [thread.cpp:4184]
  → 套接字文件 .java_pid<PID> 不存在
  → jcmd 无法 attach
```

但是 JMX MBeanServer 的 `invoke()` **不会**被 `DisableAttachMechanism` 影响——因为调用不经过 Attach 管道。`MBeanServer.invoke("com.sun.management:type=DiagnosticCommand", "Thread.print", ...)` 直接走到 `DCmd::parse_and_execute(DCmd_Source_MBean, ...)` → 照常执行。

**如果你想完全禁用诊断命令**，需要同时：
- `-XX:+DisableAttachMechanism`（阻止本地 jcmd）
- 不启动 JMX agent（不配置 `-Dcom.sun.management.jmxremote`）或限制 MBean 权限（policy file）

---

## §七 GDB 验证 + 可证伪断言

### 断言 1：_DCmdFactoryList 是有效的单向链表

```bash
(gdb) br diagnosticFramework.cpp:381
(gdb) p DCmdFactory::_DCmdFactoryList
# 预期：非 NULL
(gdb) p DCmdFactory::_DCmdFactoryList->_next
# 预期：非 NULL（至少还有第二个节点）
(gdb) p DCmdFactory::_DCmdFactoryList->name()
# 预期：某个命令名（取决于当前 head）
```

### 断言 2：factory() 线性搜索成功匹配

```bash
(gdb) br diagnosticFramework.cpp:499
(gdb) p name
# 预期："Thread.print" 字符串
(gdb) p len
# 预期：12（"Thread.print" 的长度）
(gdb) finish
(gdb) p factory
# 预期：#0 非 NULL，factory->name() == "Thread.print"
```

### 断言 3：register_DCmdFactory() 头插法正确

```bash
(gdb) br diagnosticFramework.cpp:515
(gdb) p factory
(gdb) p DCmdFactory::_DCmdFactoryList
# 预期：factory == _DCmdFactoryList（刚插入的在头部）
(gdb) p factory->_next
# 预期：等于旧 _DCmdFactoryList 值
```

### 断言 4：DCmd::parse_and_execute() 多命令分割

```bash
$ jcmd <PID> "VM.version\nVM.uptime"
(gdb) br diagnosticFramework.cpp:391
# 第一次命中：iter.has_next() = true（处理 "VM.version"）
# 第二次命中：iter.has_next() = true（处理 "VM.uptime"）
# 第三次：iter.has_next() = false → 退出 while
```

### 断言 5：JMX 路径拒绝多命令

```bash
# 通过 JMX 发送两个 '\n' 分隔的命令
(gdb) br diagnosticFramework.cpp:392
# 命中：source == DCmd_Source_MBean 且 count > 0
(gdb) n
# 预期：THROW_MSG → exception "Invalid syntax"
```

### 断言 6：DCmdMark 正常执行后析构

```bash
(gdb) br diagnosticFramework.hpp:331
# 命令执行完成后：
(gdb) p _ref
# 预期：非 NULL，指向刚才 create 的 DCmd 对象
(gdb) bt
# 预期：来自 parse_and_execute 的栈帧
# #0  DCmdMark::~DCmdMark at diagnosticFramework.hpp:331
# #1  DCmd::parse_and_execute at diagnosticFramework.cpp:413
```

### 断言 7：ThreadDumpDCmd::execute() 需要 safepoint

```bash
(gdb) br diagnosticCommand.cpp:639
# 在 ThreadDumpDCmd::execute() 中
(gdb) n  # 单步进入 VMThread::execute(&op1)
(gdb) bt
# 预期：AttachListener 线程的 bt 显示 VMThread::execute 的调用
# VMThread 在另一个线程中执行 VM_PrintThreads::doit()
```

### 断言 8：DCmdFactory::create_local_DCmd() 返回 ResourceObj

```bash
(gdb) br diagnosticFramework.cpp:532
# 在 create_resource_instance() 调用后
(gdb) p f->is_heap_allocated()
# 预期：大多数命令返回 false（ResourceObj arena 分配）
```

### 断言 9：Management::initialize() 中 register_dcmds() 被调用

```bash
(gdb) br management.cpp:148
# VM 启动时：
(gdb) n  # 单步进入 DCmdRegistrant::register_dcmds()
# 预期：此时 _DCmdFactoryList 正在被填充
```

### 断言 10：DCmdFactory::send_notification() 通知 JMX MBean

```bash
(gdb) br diagnosticFramework.cpp:464
(gdb) p k
# 预期：DiagnosticCommandImpl Klass 非 NULL
(gdb) finish → 继续执行 JavaCall
(gdb) p m
# 预期：非 NULL 的 DiagnosticCommandMBean instance
```

### 断言 11：DCmdParser::parse() 正确解析参数

```bash
$ jcmd <PID> Thread.print -l=true
(gdb) br DCmdParser::parse
(gdb) bt
# 预期：#0 在 parse() → #1 DCmdWithParser::parse → #2 parse_and_execute
(gdb) n  # 遍历 tokens
# 预期：-l=true → _locks._value = true
```

### 断言 12：DisableAttachMechanism=true 时 JMX 仍可执行 DCmd

```bash
$ java -XX:+DisableAttachMechanism ...
# 通过 JMX MBean 执行 GC.class_histogram
(gdb) br diagnosticFramework.cpp:385
# 预期：断点命中（JMX 路径不受 DisableAttachMechanism 影响）
(gdb) p source
# 预期：source == DCmd_Source_MBean (0x4)
```

---

## 核心发现总结

| # | 发现 | 核心洞察 |
|---|------|--------|
| 1 | 单向链表而非 hash map | ~40 命令 × 线性搜索 ≈ 150-300ns——对人工诊断操作足够，避免 hash map 的内存和代码复杂度 |
| 2 | DCmdMark RAII 异常安全 | `DCmdMark` 在栈上——无论正常返回还是 `THROW_MSG → longjmp`，`~DCmdMark()` 都执行 cleanup+delete |
| 3 | JMX 单命令限制 | `DCmd_Source_MBean` 时第一步就 THROW_MSG 拒绝多命令——防止远程攻击者绕过权限检查 |
| 4 | 模板化工厂编译期绑定 | `DCmdFactoryImpl<ThreadDumpDCmd>` 在编译期绑定 `name="Thread.print"`——零虚表开销 |
| 5 | DCmdRegistrant 耦合 Management | `register_dcmds()` 必须和 JMX 通知联动——不能由 AttachListener 独立触发 |
| 6 | 两个分层解析 | Attach 层 `\0` 分割做"是什么命令"，DCmdParser 做命名参数解析——各司其职 |
| 7 | safepoint 需要性因命令而异 | | 遍历 SystemDictionary/线程栈 → safepoint；读配置/计数器 → 不需要 |
| 8 | DisableAttachMechanism 不阻止 JMX | Attach 管道关了，JMX 的 `DiagnosticCommandMBean` 仍可通过 MBeanServer 执行 DCmd |
