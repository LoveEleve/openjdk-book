# 04-os-flag-diagnostic — VM flag 三路汇合 + DCmd 命令注册/执行 + Heap Dump + GC 扩展属性 + OS 指标查询 + Agent 权限检查

> **Phase**: 17-jmx-management
> **前置**: [01-management-jmm-interface]（jmm_interface vtable）、[11-os-layer]（sysconf/getrlimit/readdir）
> **配套**: [00-what-is-jmx]（JMX 概念）、[02-memory-pool-threshold]（GCNotifier）、[03-thread-monitoring]（线程 dump）
> **阅读收益**: 追踪 VM flag 从 JMX/jcmd/jinfo 三路修改到 `WriteableFlags::set_flag` 类型分发的完整路径——理解 `jmmVMGlobal` 的 type/origin/value/writeable/external 字段映射、`set_flag_from_jvalue` 的 8 种类型分发、`DCmdFactory` 单链表注册和 `DCmd::parse_and_execute` 命令执行、`jmm_DumpHeap0` → `HeapDumper` 的 heap dump 流程、`GcInfoBuilder::getLastGcInfo0` 的 before/after MemoryUsage 数组 + 8 种扩展属性类型分发、`OperatingSystemImpl.c` 的 `/proc/self/stat` 字段 23 解析和 `/proc/self/fd` 遍历计数、`UnixOperatingSystem.c` 的 `/proc/stat` CPU ticks 差值计算、`FileSystemImpl.c` 的 `stat64` 权限位检查；掌握 "jinfo 改 flag 失败" 和 "CPU load 返回 -1.0" 的诊断路径

---

## §〇 Production Scenario

运维通过 `jinfo -flag +PrintGCDetails <pid>` 尝试在生产环境动态开启 GC 日志，但命令返回错误 "flag is not writeable"。同时 `OperatingSystemMXBean.getSystemCpuLoad()` 返回 -1.0（表示不支持）。而且 `DiagnosticCommandMBean.invoke("heapDump", ...)` 调用 JMX 执行 heap dump 时抛出 IOException。

**Root cause (Flag)**: `PrintGCDetails` 是 `product` 类型 flag → 在 product 构建中 `JVMFlag::is_writeable()` 返回 true → 应该可写。但 `jinfo` 使用 Attach API → `attachListener.cpp:282` → `WriteableFlags::set_flag(name, value, JVMFlag::ATTACH_ON_DEMAND, err_msg)` → `set_flag_from_char()` (`writeableFlags.cpp:229`)。问题可能是 flag name 拼写错误（区分大小写）或 flag 在启动时被锁定。另一个常见原因：`develop`/`notproduct` 类型 flag 在 product 构建中 `is_constant_in_binary()` 返回 true → `is_writeable()` 返回 false。

**Root cause (OS metrics)**: `getSystemCpuLoad()` 返回 -1.0 表示首次调用尚未完成。`UnixOperatingSystem.c` 的 `perfInit()` 需要在两次调用之间计算差值——第一次调用只初始化计数器，返回 -1.0。第二次及以后调用通过 `/proc/stat` 的 CPU ticks 差值计算负载。

**Root cause (Heap Dump)**: `jmm_DumpHeap0` (`management.cpp:1933`) 调用 `HeapDumper dumper(live).dump(name)` ——如果目标文件系统没有写入权限，或 `live` 参数为 true 时 GC 无法完成，`HeapDumper::dump()` 返回非零值 → 抛出 IOException。

**三步诊断**：

```bash
# 1. 检查 flag 类型和可写性
jcmd <pid> VM.flags -all | grep PrintGCDetails

# 2. 检查 flag origin
jcmd <pid> VM.flags | grep PrintGCDetails

# 3. 验证 OS 指标是否可用
java -jar cmdline-jmxclient.jar ... java.lang:type=OperatingSystem SystemCpuLoad ProcessCpuLoad

# 4. 验证 /proc 文件系统可访问
cat /proc/self/stat | awk '{print "vsize:", $23}'
ls /proc/self/fd | wc -l
cat /proc/stat | head -1

# 5. 验证 heap dump 权限
touch /tmp/test_dump.hprof && ls -la /tmp/test_dump.hprof
```

**反事实 (Flag)**: 如果 `WriteableFlags::set_flag` 不做类型检查 → `jinfo -flag +PrintGCDetails=<non-boolean-value>` → `set_flag_from_char` 尝试将 "hello" 解析为 bool → 未定义行为 → flag 被设置为垃圾值 → JVM 行为不可预测。`set_flag_from_char` 的 8 种类型分发确保只有正确的类型转换才通过。

**反事实 (OS metrics)**: 如果 CPU load 计算不做差值（直接用当前 ticks）→ 返回的是系统自启动以来的平均 CPU 使用率 → 无法反映最近 1 秒的负载 → 监控系统无法检测短时间内的 CPU 突增。两次采样的差值计算是用精度换取时效性。

**反事实 (DCmd)**: 如果 `DCmdFactory` 不使用单链表而用全局数组 → 添加新命令需要修改数组大小 → 重新编译 management.cpp → 无法通过 JVMTI agent 或 `jdk.management.agent` 动态扩展命令。单链表设计使 `DCmdRegistrant::register_dcmds()` 可以在编译时静态注册任意数量命令。

**反事实 (Heap Dump)**: 如果 `jmm_DumpHeap0` 不检查 `outputfile` 的 NULL → `JNIHandles::resolve_external_guard` 返回 NULL → `java_lang_String::as_platform_dependent_str` 解引用 NULL → SIGSEGV 崩溃整个 JVM。NULL 检查 (`management.cpp:1937-1939`) 是安全边界。

---

## §一 ★★★ Flag/DCmd/OS Metrics/Heap Dump/GC Ext 全链路源码走读

### 1.1 Interview Story Format Answer

"VM flag modification in the JVM is a 3-way convergence on `WriteableFlags::set_flag` (`writeableFlags.cpp:238`). JMX calls `jmm_SetVMGlobal` (`management.cpp:1601`) with `JVMFlag::MANAGEMENT` origin, jcmd/jinfo calls via `attachListener.cpp:282` with `JVMFlag::ATTACH_ON_DEMAND` origin, and DiagnosticCommand calls with `JVMFlag::MANAGEMENT` origin. All three paths call the same `set_flag(name, value, setter, origin, err_msg)` with different `setter` functions — JMX uses `set_flag_from_jvalue` (jvalue union), Attach/DCmd use `set_flag_from_char` (char* parsing). The 8-type dispatch inside `set_flag_from_jvalue` (`writeableFlags.cpp:297-338`) handles bool/int/uint/intx/uintx/uint64_t/size_t/ccstr — ccstr requires `JNIHandles::resolve_external_guard` to unwrap the JNI string handle.

Diagnostic commands are registered via `DCmdFactory` single linked list — `DCmdRegistrant::register_dcmds()` (`diagnosticCommand.cpp:69-133`) calls `DCmdFactory::register_DCmdFactory()` (head insertion) for each command. `jmm_GetDiagnosticCommands` (`management.cpp:1958`) traverses the list filtered by `DCmd_Source_MBean`. `jmm_ExecuteDiagnosticCommand` (`management.cpp:2064`) calls `DCmd::parse_and_execute(DCmd_Source_MBean, &output, cmdline, ' ', CHECK_NULL)` → lookup factory → create DCmd → parse → execute → output to bufferedStream → Java String.

Heap dump via JMX goes: `HotSpotDiagnostic.dumpHeap0` (`HotSpotDiagnostic.c:32`) → `jmm_interface->DumpHeap0` → `jmm_DumpHeap0` (`management.cpp:1933`) → `HeapDumper dumper(live).dump(name)` → returns 0 on success or throws IOException.

GC extension attributes are obtained via `GcInfoBuilder.getLastGcInfo0` (`GcInfoBuilder.c:199`) → `jmm_interface->GetLastGCStat` → fills `jmmGCStat` struct with `usage_before_gc`/`usage_after_gc` arrays + 8-type extension attribute dispatch (Z/B/C/S/I/J/F/D) for `gc_ext_attribute_values`.

OS metric collection is platform-specific: Linux reads `/proc/self/stat` field 23 for virtual memory (`man 5 proc`), iterates `/proc/self/fd` with `readdir64` (`man 3 readdir`) for open file descriptors, and parses `/proc/stat` CPU ticks with `fscanf` (`man 3 scanf`) for system CPU load. CPU load uses two-sample difference calculation — `perfInit()` stores baseline ticks, subsequent calls compute delta to return [0.0, 1.0] load. Physical memory uses `sysconf(_SC_PHYS_PAGES)` (`man 3 sysconf`) or `sysinfo(&si)` (`man 2 sysinfo`). `FileSystemImpl.c` checks agent config file permissions with `stat64` (`man 2 stat`) — ensuring `S_IRGRP|S_IWGRP|S_IROTH|S_IWOTH` are all zero (owner-only access)."

### 1.2 Flag.c — jmmVMGlobal 结构映射

`Flag.c:82-203` 的 `getFlags` 将 JVMFlag 批量转换为 Java VMOption 对象：

```c
// 1. 批量获取 jmmVMGlobal 数组
jmmVMGlobal* globals = (jmmVMGlobal*)malloc(count * sizeof(jmmVMGlobal));
jmm_interface->GetVMGlobals(env, names, globals, count);

// 2. 遍历 globals[i]，按 type 创建 Java 包装:
for (int i = 0; i < count; i++) {
  switch (globals[i].type) {
    case JMM_VMGLOBAL_TYPE_JBOOLEAN:
      value = JNU_NewObjectByName(env, "java/lang/Boolean", "(Z)V", globals[i].value.z);
      break;
    case JMM_VMGLOBAL_TYPE_JSTRING:
      value = globals[i].value.l;  // jstring 直接引用
      break;
    case JMM_VMGLOBAL_TYPE_JLONG:
      value = JNU_NewObjectByName(env, "java/lang/Long", "(J)V", globals[i].value.j);
      break;
    case JMM_VMGLOBAL_TYPE_JDOUBLE:
      value = JNU_NewObjectByName(env, "java/lang/Double", "(D)V", globals[i].value.d);
      break;
  }
  // 3. 按 origin 选择 VMOption$Origin 静态字段
  // JMM_VMGLOBAL_ORIGIN_DEFAULT → "DEFAULT", COMMAND_LINE → "VM_CREATION"
  // MANAGEMENT → "MANAGEMENT", ATTACH_ON_DEMAND → "ATTACH_ON_DEMAND"
}
```

**jmmVMGlobal struct** (`jmm.h:161-171`) 的 6 个字段映射：

| 字段 | 类型 | 含义 | Flag.c 使用 |
|------|------|------|-----------|
| `name` | jstring | flag 名称 | 传给 VMOption 构造函数 |
| `value` | jvalue union (z/j/d/l) | flag 值 | 按 type 字段解包 |
| `type` | jint | JBOOLEAN(1)/JSTRING(2)/JLONG(3)/JDOUBLE(4) | switch 分发创建 Java 包装 |
| `origin` | jint | DEFAULT(1)..ATTACH_ON_DEMAND(7) | 映射到 VMOption$Origin |
| `writeable` | jboolean | 运行时是否可写 | 直接传 VMOption 构造 |
| `external` | jboolean | 外部接口是否支持 | 直接传 VMOption 构造 |

**jmmVMGlobal origin 映射**（`Flag.c:152-180`）：

| JMM_VMGLOBAL_ORIGIN | Java VMOption.Origin | 含义 |
|------|------|------|
| `DEFAULT(1)` | "DEFAULT" | 默认值 |
| `COMMAND_LINE(2)` | "VM_CREATION" | -XX:+Flag 启动参数 |
| `MANAGEMENT(3)` | "MANAGEMENT" | JMX/jcmd DCmd 修改 |
| `ENVIRON_VAR(4)` | "ENVIRON_VAR" | 环境变量 |
| `CONFIG_FILE(5)` | "CONFIG_FILE" | 配置文件 |
| `ERGONOMIC(6)` | "ERGONOMIC" | 自动调优 |
| `ATTACH_ON_DEMAND(7)` | "ATTACH_ON_DEMAND" | jinfo/jcmd attach |
| `OTHER(99)` | "OTHER" | 其他来源 |

### 1.3 WriteableFlags — 三路汇合 + 类型分发

**三路入口对比**（`writeableFlags.cpp`）：

| 入口 | setter 函数 | origin | 参数格式 | 调用方 |
|------|------|------|------|------|
| JMX | `set_flag_from_jvalue` | `MANAGEMENT` | jvalue union (z/j/d/l) | `jmm_SetVMGlobal` (management.cpp:1601) |
| Attach API | `set_flag_from_char` | `ATTACH_ON_DEMAND` | char* name + char* value | `attachListener.cpp:282` |
| DiagnosticCommand | `set_flag_from_char` | `MANAGEMENT` | char* name + char* value | `diagnosticCommand.cpp:270` |

**共同路径**（`writeableFlags.cpp:243-266`）：

```cpp
JVMFlag::Error WriteableFlags::set_flag(const char* name, const void* value,
    JVMFlag::Error(*setter)(...), JVMFlag::Flags origin, FormatBuffer<80>& err_msg) {
  if (name == NULL) return JVMFlag::MISSING_NAME;
  if (value == NULL) return JVMFlag::MISSING_VALUE;
  JVMFlag* f = JVMFlag::find_flag((char*)name, strlen(name));
  if (f) {
    if (f->is_writeable()) return setter(f, value, origin, err_msg);
    else return JVMFlag::NON_WRITABLE;
  }
  return JVMFlag::INVALID_FLAG;
}
```

**set_flag_from_char 8 路类型分发**（`writeableFlags.cpp:268-295`）：

```cpp
JVMFlag::Error WriteableFlags::set_flag_from_char(JVMFlag* f, const void* value,
    JVMFlag::Flags origin, FormatBuffer<80>& err_msg) {
  char* flag_value = *(char**)value;
  if (flag_value == NULL) return JVMFlag::MISSING_VALUE;
  if (f->is_bool())       return set_bool_flag(f->_name, flag_value, origin, err_msg);
  else if (f->is_int())   return set_int_flag(f->_name, flag_value, origin, err_msg);
  else if (f->is_uint())  return set_uint_flag(f->_name, flag_value, origin, err_msg);
  else if (f->is_intx())  return set_intx_flag(f->_name, flag_value, origin, err_msg);
  else if (f->is_uintx()) return set_uintx_flag(f->_name, flag_value, origin, err_msg);
  else if (f->is_uint64_t()) return set_uint64_t_flag(f->_name, flag_value, origin, err_msg);
  else if (f->is_size_t())   return set_size_t_flag(f->_name, flag_value, origin, err_msg);
  else if (f->is_ccstr())    return set_ccstr_flag(f->_name, flag_value, origin, err_msg);
  else ShouldNotReachHere();
}
```

**set_flag_from_jvalue 8 路类型分发**（`writeableFlags.cpp:297-338`）：

```cpp
JVMFlag::Error WriteableFlags::set_flag_from_jvalue(JVMFlag* f, const void* value,
                                                     JVMFlag::Flags origin, FormatBuffer<80>& err_msg) {
  jvalue new_value = *(jvalue*)value;
  if (f->is_bool())      { bool bvalue = (new_value.z == JNI_TRUE); return set_bool_flag(f->_name, bvalue, origin, err_msg); }
  else if (f->is_int())  { int ivalue = (int)new_value.j;          return set_int_flag(f->_name, ivalue, origin, err_msg); }
  else if (f->is_uint()) { uint uvalue = (uint)new_value.j;        return set_uint_flag(f->_name, uvalue, origin, err_msg); }
  else if (f->is_intx()) { intx ivalue = (intx)new_value.j;        return set_intx_flag(f->_name, ivalue, origin, err_msg); }
  else if (f->is_uintx()){ uintx uvalue = (uintx)new_value.j;      return set_uintx_flag(f->_name, uvalue, origin, err_msg); }
  else if (f->is_uint64_t()) { ... }
  else if (f->is_size_t())   { ... }
  else if (f->is_ccstr()) {
    oop str = JNIHandles::resolve_external_guard(new_value.l);     // JNI handle 解包
    if (str == NULL) return JVMFlag::MISSING_VALUE;
    ccstr svalue = java_lang_String::as_utf8_string(str);          // Java String → C char*
    JVMFlag::Error ret = set_ccstr_flag(f->_name, svalue, origin, err_msg);
    if (ret != JVMFlag::SUCCESS) FREE_C_HEAP_ARRAY(char, svalue);  // 失败释放内存
    return ret;
  }
}
```

**追问**：为什么 ccstr 类型需要 `FREE_C_HEAP_ARRAY`？→ `as_utf8_string()` 在 C-Heap 上分配内存。如果 `set_ccstr_flag` 成功 → flag 接管了字符串所有权。如果失败 → 必须手动释放，否则内存泄漏。

**set_flag_from_char vs set_flag_from_jvalue 差异**：

| 维度 | set_flag_from_char | set_flag_from_jvalue |
|------|-------------------|---------------------|
| 值来源 | char* 字符串 | jvalue union (已类型化) |
| 类型解析 | 内部调用 atoi/atol 等 | 直接按字段解包 |
| 错误处理 | 字符串解析失败返回 ERR_OTHER | jvalue 字段不匹配 → 无此问题 |
| ccstr | 直接使用 char* 值 | JNI handle → oop → utf8 → 失败时 FREE_C_HEAP_ARRAY |
| 调用方 | Attach API, DCmd | JMX (MBeanServer) |

### 1.4 jmm_GetVMGlobals — 按名查询 vs 全量返回

`management.cpp:1536-1599` 的两种模式：

- **按名查询** (`names != NULL`): 遍历 names 数组 → `JVMFlag::find_flag(str)` → `add_global_entry()` → 用于 JMX 查询特定 flag
- **全量返回** (`names == NULL`): 遍历 `JVMFlag::flags[]` 全局数组 → 过滤 `is_constant_in_binary()` (develop/notproduct) 和 locked flags → 用于 `jcmd VM.flags`

**add_global_entry** (`management.cpp:1457-1528`) 将 JVMFlag 转为 jmmVMGlobal：

```cpp
bool add_global_entry(JNIEnv* env, Handle name, jmmVMGlobal *global, JVMFlag *flag, TRAPS) {
  global->name = (jstring)JNIHandles::make_local(env, flag_name());

  if (flag->is_bool())     { global->value.z = flag->get_bool() ? JNI_TRUE : JNI_FALSE; global->type = JMM_VMGLOBAL_TYPE_JBOOLEAN; }
  else if (flag->is_int()) { global->value.j = (jlong)flag->get_int();                  global->type = JMM_VMGLOBAL_TYPE_JLONG; }
  else if (flag->is_uint()){ global->value.j = (jlong)flag->get_uint();                 global->type = JMM_VMGLOBAL_TYPE_JLONG; }
  else if (flag->is_intx()){ global->value.j = (jlong)flag->get_intx();                 global->type = JMM_VMGLOBAL_TYPE_JLONG; }
  else if (flag->is_uintx()){ global->value.j = (jlong)flag->get_uintx();              global->type = JMM_VMGLOBAL_TYPE_JLONG; }
  else if (flag->is_uint64_t()) { ... }
  else if (flag->is_double()) { global->value.d = (jdouble)flag->get_double();          global->type = JMM_VMGLOBAL_TYPE_JDOUBLE; }
  else if (flag->is_size_t()) { ... }
  else if (flag->is_ccstr()) {
    Handle str = java_lang_String::create_from_str(flag->get_ccstr(), CHECK_false);
    global->value.l = (jobject)JNIHandles::make_local(env, str());
    global->type = JMM_VMGLOBAL_TYPE_JSTRING;
  }
  global->writeable = flag->is_writeable();
  global->external = flag->is_external();
  // ... origin mapping switch ...
}
```

**类型收敛**：注意 int/uint/intx/uintx/uint64_t/size_t 全部映射为 `JMM_VMGLOBAL_TYPE_JLONG` — jvalue.j (jlong) 字段统一承载。只有 bool→JBOOLEAN, double→JDOUBLE, ccstr→JSTRING 有独立类型。

### 1.5 DiagnosticCommand — DCmdFactory 单链表 + parse_and_execute

**DCmdFactory 结构**（`diagnosticFramework.hpp:345-400`）：

```cpp
class DCmdFactory: public CHeapObj<mtInternal> {
private:
  static DCmdFactory* _DCmdFactoryList;  // 单链表头
  DCmdFactory*        _next;             // 下一个工厂
  const bool          _enabled;
  const bool          _hidden;
  const uint32_t      _export_flags;     // DCmd_Source_Internal | AttachAPI | MBean
  const int           _num_arguments;

public:
  static int register_DCmdFactory(DCmdFactory* factory);  // 头插法注册
  static DCmdFactory* factory(DCmdSource source, const char* cmd, size_t len);
  static DCmd* create_local_DCmd(DCmdSource source, CmdLine &line, outputStream* out, TRAPS);
  static GrowableArray<const char*>* DCmd_list(DCmdSource source);
  static GrowableArray<DCmdInfo*>* DCmdInfo_list(DCmdSource source);
};
```

**DCmdFactoryImpl 模板**（`diagnosticFramework.hpp:404-427`）：

```cpp
template <class DCmdClass> class DCmdFactoryImpl : public DCmdFactory {
public:
  DCmd* create_resource_instance(outputStream* output) const {
    return new DCmdClass(output, false);  // ResourceArea 分配
  }
  const char* name() const        { return DCmdClass::name(); }
  const char* description() const { return DCmdClass::description(); }
  const char* impact() const      { return DCmdClass::impact(); }
  const JavaPermission permission() const { return DCmdClass::permission(); }
};
```

**DCmdRegistrant::register_dcmds()**（`diagnosticCommand.cpp:69-133`）— 全部命令注册：

```cpp
void DCmdRegistrant::register_dcmds(){
  uint32_t full_export = DCmd_Source_Internal | DCmd_Source_AttachAPI | DCmd_Source_MBean;
  DCmdFactory::register_DCmdFactory(new DCmdFactoryImpl<HelpDCmd>(full_export, true, false));
  DCmdFactory::register_DCmdFactory(new DCmdFactoryImpl<VersionDCmd>(full_export, true, false));
  DCmdFactory::register_DCmdFactory(new DCmdFactoryImpl<CommandLineDCmd>(full_export, true, false));
  DCmdFactory::register_DCmdFactory(new DCmdFactoryImpl<PrintSystemPropertiesDCmd>(full_export, true, false));
  DCmdFactory::register_DCmdFactory(new DCmdFactoryImpl<PrintVMFlagsDCmd>(full_export, true, false));
  DCmdFactory::register_DCmdFactory(new DCmdFactoryImpl<SetVMFlagDCmd>(full_export, true, false));
  DCmdFactory::register_DCmdFactory(new DCmdFactoryImpl<VMDynamicLibrariesDCmd>(full_export, true, false));
  DCmdFactory::register_DCmdFactory(new DCmdFactoryImpl<VMUptimeDCmd>(full_export, true, false));
  DCmdFactory::register_DCmdFactory(new DCmdFactoryImpl<VMInfoDCmd>(full_export, true, false));
  DCmdFactory::register_DCmdFactory(new DCmdFactoryImpl<SystemGCDCmd>(full_export, true, false));
  DCmdFactory::register_DCmdFactory(new DCmdFactoryImpl<RunFinalizationDCmd>(full_export, true, false));
  DCmdFactory::register_DCmdFactory(new DCmdFactoryImpl<HeapInfoDCmd>(full_export, true, false));
  DCmdFactory::register_DCmdFactory(new DCmdFactoryImpl<FinalizerInfoDCmd>(full_export, true, false));
#if INCLUDE_SERVICES
  DCmdFactory::register_DCmdFactory(new DCmdFactoryImpl<HeapDumpDCmd>(DCmd_Source_Internal | DCmd_Source_AttachAPI, true, false));
  DCmdFactory::register_DCmdFactory(new DCmdFactoryImpl<ClassHistogramDCmd>(full_export, true, false));
  DCmdFactory::register_DCmdFactory(new DCmdFactoryImpl<ClassStatsDCmd>(full_export, true, false));
  DCmdFactory::register_DCmdFactory(new DCmdFactoryImpl<SystemDictionaryDCmd>(full_export, true, false));
  DCmdFactory::register_DCmdFactory(new DCmdFactoryImpl<ClassHierarchyDCmd>(full_export, true, false));
  DCmdFactory::register_DCmdFactory(new DCmdFactoryImpl<SymboltableDCmd>(full_export, true, false));
  DCmdFactory::register_DCmdFactory(new DCmdFactoryImpl<StringtableDCmd>(full_export, true, false));
  DCmdFactory::register_DCmdFactory(new DCmdFactoryImpl<metaspace::MetaspaceDCmd>(full_export, true, false));
#endif
  DCmdFactory::register_DCmdFactory(new DCmdFactoryImpl<ThreadDumpDCmd>(full_export, true, false));
  DCmdFactory::register_DCmdFactory(new DCmdFactoryImpl<ClassLoaderStatsDCmd>(full_export, true, false));
  DCmdFactory::register_DCmdFactory(new DCmdFactoryImpl<ClassLoaderHierarchyDCmd>(full_export, true, false));
  DCmdFactory::register_DCmdFactory(new DCmdFactoryImpl<CompileQueueDCmd>(full_export, true, false));
  DCmdFactory::register_DCmdFactory(new DCmdFactoryImpl<CodeListDCmd>(full_export, true, false));
  DCmdFactory::register_DCmdFactory(new DCmdFactoryImpl<CodeCacheDCmd>(full_export, true, false));
  DCmdFactory::register_DCmdFactory(new DCmdFactoryImpl<TouchedMethodsDCmd>(full_export, true, false));
  DCmdFactory::register_DCmdFactory(new DCmdFactoryImpl<CodeHeapAnalyticsDCmd>(full_export, true, false));
  DCmdFactory::register_DCmdFactory(new DCmdFactoryImpl<CompilerDirectivesPrintDCmd>(full_export, true, false));
  DCmdFactory::register_DCmdFactory(new DCmdFactoryImpl<CompilerDirectivesAddDCmd>(full_export, true, false));
  DCmdFactory::register_DCmdFactory(new DCmdFactoryImpl<CompilerDirectivesRemoveDCmd>(full_export, true, false));
  DCmdFactory::register_DCmdFactory(new DCmdFactoryImpl<CompilerDirectivesClearDCmd>(full_export, true, false));
  // Enhanced JMX Agent Support
  uint32_t jmx_agent_export_flags = DCmd_Source_Internal | DCmd_Source_AttachAPI;
  DCmdFactory::register_DCmdFactory(new DCmdFactoryImpl<JMXStartRemoteDCmd>(jmx_agent_export_flags, true, false));
  DCmdFactory::register_DCmdFactory(new DCmdFactoryImpl<JMXStartLocalDCmd>(jmx_agent_export_flags, true, false));
  DCmdFactory::register_DCmdFactory(new DCmdFactoryImpl<JMXStopRemoteDCmd>(jmx_agent_export_flags, true, false));
  DCmdFactory::register_DCmdFactory(new DCmdFactoryImpl<JMXStatusDCmd>(jmx_agent_export_flags, true, false));
}
```

**关键设计**：
- `HeapDumpDCmd` 只导出到 `DCmd_Source_Internal | DCmd_Source_AttachAPI` — 不通过 MBean（`full_export` 不含 `DCmd_Source_MBean`）。但 JMX 可以通过 `HotSpotDiagnostic.dumpHeap()` 直接调用 `jmm_DumpHeap0`。
- JMX agent 命令（JMXStartRemote/Local/Stop/Status）不通过 MBean — 只有 Attach API 和内部可用。
- 每个命令类必须提供静态方法：`name()`, `description()`, `impact()`, `num_arguments()`, `permission()`, `disabled_message()`。

**jmm_GetDiagnosticCommands**（`management.cpp:1958-1969`）：

```cpp
JVM_ENTRY(jobjectArray, jmm_GetDiagnosticCommands(JNIEnv *env))
  ResourceMark rm(THREAD);
  GrowableArray<const char *>* dcmd_list = DCmdFactory::DCmd_list(DCmd_Source_MBean);
  objArrayOop cmd_array_oop = oopFactory::new_objArray(SystemDictionary::String_klass(),
          dcmd_list->length(), CHECK_NULL);
  objArrayHandle cmd_array(THREAD, cmd_array_oop);
  for (int i = 0; i < dcmd_list->length(); i++) {
    oop cmd_name = java_lang_String::create_oop_from_str(dcmd_list->at(i), CHECK_NULL);
    cmd_array->obj_at_put(i, cmd_name);
  }
  return (jobjectArray) JNIHandles::make_local(env, cmd_array());
JVM_END
```

**jmm_ExecuteDiagnosticCommand** — jcmd via JMX（`management.cpp:2064-2080`）：

```cpp
JVM_ENTRY(jstring, jmm_ExecuteDiagnosticCommand(JNIEnv *env, jstring commandline))
  ResourceMark rm(THREAD);
  oop cmd = JNIHandles::resolve_external_guard(commandline);
  if (cmd == NULL) {
    THROW_MSG_NULL(vmSymbols::java_lang_NullPointerException(),
                   "Command line cannot be null.");
  }
  char* cmdline = java_lang_String::as_utf8_string(cmd);
  if (cmdline == NULL) {
    THROW_MSG_NULL(vmSymbols::java_lang_NullPointerException(),
                   "Command line content cannot be null.");
  }
  bufferedStream output;
  DCmd::parse_and_execute(DCmd_Source_MBean, &output, cmdline, ' ', CHECK_NULL);
  oop result = java_lang_String::create_oop_from_str(output.as_string(), CHECK_NULL);
  return (jstring) JNIHandles::make_local(env, result);
JVM_END
```

**DCmd::parse_and_execute** 流程：
1. 解析命令名（delimiter 为空格）→ 查找 `DCmdFactory::factory(source, name, len)`
2. 如果 found → `factory->create_resource_instance(&output)` 创建 DCmd 实例
3. `cmd->parse(&line, delim, THREAD)` 解析参数
4. `cmd->execute(source, THREAD)` 执行命令（输出到 output stream）
5. `DCmdMark` RAII 析构 → `cmd->cleanup()` + `delete cmd`（如果是 heap 分配）

**jmm_SetDiagnosticFrameworkNotificationEnabled**（`management.cpp:2082-2084`）：

```cpp
JVM_ENTRY(void, jmm_SetDiagnosticFrameworkNotificationEnabled(JNIEnv *env, jboolean enabled))
  DCmdFactory::set_jmx_notification_enabled(enabled?true:false);
JVM_END
```

**DiagnosticCommandImpl.c — JNI 桥接层**（`DiagnosticCommandImpl.c:41-46,144-251`）：

```c
// getDiagnosticCommands — 获取所有 DCmd 命令列表
JNIEXPORT jobjectArray JNICALL
Java_com_sun_management_internal_DiagnosticCommandImpl_getDiagnosticCommands
  (JNIEnv *env, jobject dummy)
{
  return jmm_interface->GetDiagnosticCommands(env);
}

// getDiagnosticCommandInfo — 获取指定命令的详细信息
JNIEXPORT jobjectArray JNICALL
Java_com_sun_management_internal_DiagnosticCommandImpl_getDiagnosticCommandInfo
(JNIEnv *env, jobject dummy, jobjectArray commands)
{
  // ... 分配 dcmd_info_array ...
  jmm_interface->GetDiagnosticCommandInfo(env, commands, dcmd_info_array);
  for (i=0; i<num_commands; i++) {
    args = getDiagnosticCommandArgumentInfoArray(env, cmd, dcmd_info_array[i].num_arguments);
    // 构造 DiagnosticCommandInfo 对象:
    // name, description, impact, permission_class, permission_name,
    // permission_action, enabled, args
  }
}

// executeDiagnosticCommand — 执行指定命令
JNIEXPORT jstring JNICALL
Java_com_sun_management_internal_DiagnosticCommandImpl_executeDiagnosticCommand
(JNIEnv *env, jobject dummy, jstring command) {
  return jmm_interface->ExecuteDiagnosticCommand(env, command);
}
```

### 1.6 Heap Dump — jmm_DumpHeap0 + HeapDumper

**HotSpotDiagnostic.c — JNI 桥接**（`HotSpotDiagnostic.c:31-36`）：

```c
JNIEXPORT void JNICALL
Java_com_sun_management_internal_HotSpotDiagnostic_dumpHeap0
  (JNIEnv *env, jobject dummy, jstring outputfile, jboolean live)
{
    jmm_interface->DumpHeap0(env, outputfile, live);
}
```

**jmm_DumpHeap0**（`management.cpp:1933-1956`）：

```cpp
JVM_ENTRY(jint, jmm_DumpHeap0(JNIEnv *env, jstring outputfile, jboolean live))
#if INCLUDE_SERVICES
  ResourceMark rm(THREAD);
  oop on = JNIHandles::resolve_external_guard(outputfile);
  if (on == NULL) {
    THROW_MSG_(vmSymbols::java_lang_NullPointerException(),
               "Output file name cannot be null.", -1);
  }
  Handle onhandle(THREAD, on);
  char* name = java_lang_String::as_platform_dependent_str(onhandle, CHECK_(-1));
  if (name == NULL) {
    THROW_MSG_(vmSymbols::java_lang_NullPointerException(),
               "Output file name cannot be null.", -1);
  }
  HeapDumper dumper(live ? true : false);
  if (dumper.dump(name) != 0) {
    const char* errmsg = dumper.error_as_C_string();
    THROW_MSG_(vmSymbols::java_io_IOException(), errmsg, -1);
  }
  return 0;
#else  // INCLUDE_SERVICES
  return -1;
#endif // INCLUDE_SERVICES
JVM_END
```

**关键路径**：
1. `JNIHandles::resolve_external_guard` — JNI handle → oop
2. `java_lang_String::as_platform_dependent_str` — Java String → C char*（平台编码）
3. `HeapDumper(live)` — `live=true` 时只 dump 活对象（需 GC），`false` dump 全堆
4. `dumper.dump(name)` → 返回 0 成功，非 0 失败
5. 失败时 `dumper.error_as_C_string()` 获取错误描述 → 包装为 IOException

**安全边界**：outputfile 为 NULL 时抛出 NullPointerException（而非 SIGSEGV），`name` 为空时同样。

### 1.7 GC 扩展属性 — GcInfoBuilder + getLastGcInfo0

**GcInfoBuilder.c — getLastGcInfo0**（`GcInfoBuilder.c:199-307`）：

```c
JNIEXPORT jobject JNICALL Java_com_sun_management_internal_GcInfoBuilder_getLastGcInfo0
  (JNIEnv *env, jobject builder, jobject gc,
   jint ext_att_count, jobjectArray ext_att_values, jcharArray ext_att_types,
   jobjectArray usageBeforeGC, jobjectArray usageAfterGC) {

    jmmGCStat gc_stat;

    gc_stat.usage_before_gc = usageBeforeGC;    // MemoryUsage 数组 (before GC)
    gc_stat.usage_after_gc = usageAfterGC;      // MemoryUsage 数组 (after GC)
    gc_stat.gc_ext_attribute_values_size = ext_att_count;
    gc_stat.gc_ext_attribute_values = (jvalue*) malloc(ext_att_count * sizeof(jvalue));

    jmm_interface->GetLastGCStat(env, gc, &gc_stat);
    if (gc_stat.gc_index == 0) {  // 没有 GC 记录
        free(gc_stat.gc_ext_attribute_values);
        return 0;
    }

    // 8 种扩展属性类型分发:
    for (i = 0; i < ext_att_count; i++) {
       v = gc_stat.gc_ext_attribute_values[i];
       switch (nativeTypes[i]) {
            case 'Z': setBooleanValueAtObjectArray(env, ext_att_values, i, v.z); break;
            case 'B': setByteValueAtObjectArray(env, ext_att_values, i, v.b);    break;
            case 'C': setCharValueAtObjectArray(env, ext_att_values, i, v.c);    break;
            case 'S': setShortValueAtObjectArray(env, ext_att_values, i, v.s);   break;
            case 'I': setIntValueAtObjectArray(env, ext_att_values, i, v.i);     break;
            case 'J': setLongValueAtObjectArray(env, ext_att_values, i, v.j);    break;
            case 'F': setFloatValueAtObjectArray(env, ext_att_values, i, v.f);   break;
            case 'D': setDoubleValueAtObjectArray(env, ext_att_values, i, v.d);  break;
       }
    }

    return JNU_NewObjectByName(env,
       "com/sun/management/GcInfo",
       "(Lcom/sun/management/internal/GcInfoBuilder;JJJ[Ljava/lang/management/MemoryUsage;[Ljava/lang/management/MemoryUsage;[Ljava/lang/Object;)V",
       builder, gc_stat.gc_index, gc_stat.start_time, gc_stat.end_time,
       usageBeforeGC, usageAfterGC, ext_att_values);
}
```

**GcInfo 构造参数**（7 个）：
1. `builder` — GcInfoBuilder 实例（关联 GC 名称、内存池名称数组）
2. `gc_index` — GC 序号（0 表示无记录）
3. `start_time` — GC 开始时间 (ms)
4. `end_time` — GC 结束时间 (ms)
5. `usageBeforeGC` — GC 前 MemoryUsage 数组（每内存池一个）
6. `usageAfterGC` — GC 后 MemoryUsage 数组
7. `ext_att_values` — 扩展属性值数组（8 种 JNI 类型）

**GarbageCollectorExtImpl.c — setNotificationEnabled**（`GarbageCollectorExtImpl.c:30-41`）：

```c
JNIEXPORT void JNICALL
Java_com_sun_management_internal_GarbageCollectorExtImpl_setNotificationEnabled
(JNIEnv *env, jobject dummy, jobject gc, jboolean enabled) {
    if (gc == NULL) {
        JNU_ThrowNullPointerException(env, "Invalid GarbageCollectorMBean");
        return;
    }
    if ((jmm_version > JMM_VERSION_1_2)
       || (jmm_version == JMM_VERSION_1_2 && ((jmm_version&0xFF)>=1))) {
      jmm_interface->SetGCNotificationEnabled(env, gc, enabled);
    }
}
```

**jmm_SetGCNotificationEnabled**（`management.cpp:1925-1930`）：

```cpp
JVM_ENTRY(void, jmm_SetGCNotificationEnabled(JNIEnv *env, jobject obj, jboolean enabled))
  ResourceMark rm(THREAD);
  GCMemoryManager* mgr = get_gc_memory_manager_from_jobject(obj, CHECK);
  mgr->set_notification_enabled(enabled?true:false);
JVM_END
```

### 1.8 OS 指标 — /proc/self/stat + /proc/self/fd + sysinfo + sysconf

**getCommittedVirtualMemorySize0**（`OperatingSystemImpl.c:213-231`）— 解析 `/proc/self/stat` 字段 23：

```c
fscanf(fp, "%*d %*s %*c %*d %*d %*d %*d %*d %*u %*u %*u %*u %*u %*d %*d %*d %*d %*d %*d %*u %*u %*d %lu %*[^\n]\n", &vsize);
return (jlong)vsize;
```

格式串跳过前 22 个字段（`%*` = 读入但不存储），字段 23 (vsize) 用 `%lu` 读取——进程虚拟内存大小（字节）。（`man 5 proc`）

**getFreePhysicalMemorySize0**（`OperatingSystemImpl.c:333-335`）— Linux 使用 `sysconf`：

```c
jlong num_avail_physical_pages = sysconf(_SC_AVPHYS_PAGES);  // man 3 sysconf
return (num_avail_physical_pages * page_size);
```

**getTotalPhysicalMemorySize0**（`OperatingSystemImpl.c:362-365`）：

```c
jlong num_physical_pages = sysconf(_SC_PHYS_PAGES);  // man 3 sysconf
return (num_physical_pages * page_size);
```

**page_size 初始化**（`OperatingSystemImpl.c:174-177`）：

```c
JNIEXPORT void JNICALL
Java_com_sun_management_internal_OperatingSystemImpl_initialize0(JNIEnv *env, jclass cls) {
    page_size = sysconf(_SC_PAGESIZE);  // man 3 sysconf
}
```

**get_total_or_available_swap_space_size**（`OperatingSystemImpl.c:84-170`）— Linux 使用 `sysinfo`：

```c
struct sysinfo si;
ret = sysinfo(&si);                                         // man 2 sysinfo
total = (jlong)si.totalswap * si.mem_unit;                  // 总交换空间
avail = (jlong)si.freeswap * si.mem_unit;                   // 空闲交换空间
return available ? avail : total;
```

**getOpenFileDescriptorCount0**（`OperatingSystemImpl.c:425-455`）— 遍历 `/proc/self/fd`：

```c
dir = opendir("/proc/self/fd");                             // man 3 opendir
while ((d = readdir64(dir)) != NULL) {                      // man 3 readdir
  if (isdigit(d->d_name[0])) fds++;  // 只计数数字名称 = 真正的 fd
}
closedir(dir);                                              // man 3 closedir
return fds - 1;  // 减去 opendir 本身打开的 fd
```

**getMaxFileDescriptorCount0**（`OperatingSystemImpl.c:458-469`）：

```c
struct rlimit rlp;
if (getrlimit(RLIMIT_NOFILE, &rlp) == -1) {                // man 2 getrlimit
    throw_internal_error(env, "getrlimit failed");
    return -1;
}
return (jlong) rlp.rlim_cur;
```

**getProcessCpuTime0**（`OperatingSystemImpl.c:263-300`）— Linux 使用 `times` + `sysconf`：

```c
clk_tck = 100;  // Linux 固定
times(&time);                                              // man 2 times
ns_per_clock_tick = (jlong) 1000 * 1000 * 1000 / (jlong) clk_tck;
cpu_time_ns = ((jlong)time.tms_utime + (jlong)time.tms_stime) * ns_per_clock_tick;
```

**反事实**：如果 FD 计数使用 `sysconf(_SC_OPEN_MAX)` 而不是遍历 /proc/self/fd → `sysconf` 返回最大 FD 限制 — 不是当前打开的 FD 数 → 误判 FD 泄漏。

### 1.9 CPU Load — /proc/stat 解析 + 差值计算

**struct ticks**（`UnixOperatingSystem.c:41-45`）：

```c
struct ticks {
    uint64_t  used;          // userTicks + niceTicks
    uint64_t  usedKernel;    // systemTicks + irqTicks + sirqTicks
    uint64_t  total;         // 全部 7 字段之和
};
```

**struct perfbuf**（`UnixOperatingSystem.c:54-59`）：

```c
static struct perfbuf {
    int   nProcs;            // CPU 数量
    ticks jvmTicks;          // JVM 进程 ticks（来自 /proc/self/stat）
    ticks cpuTicks;          // 系统总计 ticks（来自 /proc/stat 第一行）
    ticks *cpus;             // 每个 CPU 的 ticks
} counters;
```

**get_totalticks**（`UnixOperatingSystem.c:78-126`）— 解析 `/proc/stat`（`man 5 proc`）：

```c
fscanf(fh, "cpu %"SCNd64" %"SCNd64" %"SCNd64" %"SCNd64" %"SCNd64" %"SCNd64" %"SCNd64",
       &userTicks, &niceTicks, &systemTicks, &idleTicks, &iowTicks, &irqTicks, &sirqTicks);
pticks->used = userTicks + niceTicks;
pticks->usedKernel = systemTicks + irqTicks + sirqTicks;
pticks->total = userTicks + niceTicks + systemTicks + idleTicks + iowTicks + irqTicks + sirqTicks;
```

`/proc/stat` 第一行 `cpu` 的 7 个字段（`man 5 proc`）：

| 字段 | 含义 | 说明 |
|------|------|------|
| user | 用户态 CPU 时间（nice=0） | 普通进程用户态 |
| nice | 用户态 CPU 时间（nice>0） | 低优先级进程 |
| system | 内核态 CPU 时间 | 系统调用、中断处理 |
| idle | 空闲时间 | CPU 无事可做 |
| iowait | 等待 IO 完成 | CPU 空闲但 IO 未完成 |
| irq | 硬中断时间 | 硬件中断处理 |
| softirq | 软中断时间 | 软件中断（如网络） |

**get_cpuload_internal**（`UnixOperatingSystem.c:244-304`）— 差值计算：

```c
pthread_mutex_lock(&lock);                                      // man 3 pthread_mutex_lock

if(perfInit() == 0) {
    pticks = &counters.cpuTicks;  // 或 &counters.jvmTicks
    tmp = *pticks;                // 保存当前 ticks（上次采样）
    get_totalticks(which, pticks); // 重新读取

    kdiff = pticks->usedKernel - tmp.usedKernel;                // 内核态增量
    tdiff = pticks->total - tmp.total;                          // 总增量
    udiff = pticks->used - tmp.used;                            // 用户态增量

    if (tdiff == 0) {
        user_load = 0;
    } else {
        if (tdiff < (udiff + kdiff)) tdiff = udiff + kdiff;     // 修正计数值
        *pkernelLoad = (kdiff / (double)tdiff);                 // 内核负载
        *pkernelLoad = MIN(MAX(*pkernelLoad, 0.0), 1.0);        // 钳制
        user_load = (udiff / (double)tdiff);                    // 用户负载
        user_load = MIN(MAX(user_load, 0.0), 1.0);              // 钳制
    }
}
pthread_mutex_unlock(&lock);
return user_load;
```

**perfInit()**（`UnixOperatingSystem.c:201-229`）— 首次调用只保存基线：

```c
int perfInit() {
    static int initialized = 0;
    if (!initialized) {
        int n = sysconf(_SC_NPROCESSORS_CONF);                  // man 3 sysconf
        counters.cpus = calloc(n, sizeof(ticks));
        counters.nProcs = n;
        get_totalticks(-1, &counters.cpuTicks);                 // 保存系统基线
        for (i = 0; i < n; i++) get_totalticks(i, &counters.cpus[i]); // 每 CPU
        get_jvmticks(&counters.jvmTicks);                       // 保存 JVM 基线
        initialized = 1;
    }
    return initialized ? 0 : -1;
}
```

**首次调用返回 -1.0 的原因**：`perfInit()` 只保存基线值，不计算差值。后续调用中 `get_cpuload_internal` 才能用 `tmp`（上次值）和 `pticks`（当前值）计算增量。

**get_jvmticks**（`UnixOperatingSystem.c:179-196`）— 读取 `/proc/self/stat` 的 JVM 进程 ticks：

```c
static int get_jvmticks(ticks *pticks) {
    uint64_t userTicks, systemTicks;
    read_ticks("/proc/self/stat", &userTicks, &systemTicks);  // 跳过 11 字段后读 utime, stime
    get_totalticks(-1, pticks);                                 // 系统总 ticks (用于 total)
    pticks->used = userTicks;
    pticks->usedKernel = systemTicks;
    return 0;
}
```

**JNI 入口**：

```c
// getSystemCpuLoad0 (UnixOperatingSystem.c:325-334)
JNIEXPORT jdouble JNICALL
Java_com_sun_management_internal_OperatingSystemImpl_getSystemCpuLoad0(JNIEnv *env, jobject dummy) {
    if (perfInit() == 0) return get_cpu_load(-1);  // -1 = all CPUs
    else return -1.0;
}

// getProcessCpuLoad0 (UnixOperatingSystem.c:336-345)
JNIEXPORT jdouble JNICALL
Java_com_sun_management_internal_OperatingSystemImpl_getProcessCpuLoad0(JNIEnv *env, jobject dummy) {
    if (perfInit() == 0) return get_process_load();
    else return -1.0;
}
```

### 1.10 Agent 权限检查 — stat64

`FileSystemImpl.c:56-74` — `isAccessUserOnly0`：

```c
JNU_GetStringPlatformChars(env, path, &path_str);
if (stat64(path_str, &sb) == 0) {                              // man 2 stat
  if ((sb.st_mode & (S_IRGRP|S_IWGRP|S_IROTH|S_IWOTH)) == 0) {
    ret = JNI_TRUE;    // 只有 owner 可读写
  } else {
    ret = JNI_FALSE;   // group/other 有权限 — 安全风险
  }
} else {
  JNU_ThrowIOExceptionWithLastError(env, "stat64 failed");
}
```

JMX 密码文件和访问文件包含认证凭证 — 必须只对 owner 可见。检查逻辑：
- `S_IRGRP` (040) + `S_IWGRP` (020) = group 权限位
- `S_IROTH` (004) + `S_IWOTH` (002) = other 权限位
- 这些位全部为 0 → 只有 owner 可读写 → JNI_TRUE
- 任一位非 0 → 有安全风险 → JNI_FALSE

### 1.11 ★ Mermaid 序列图

```mermaid
sequenceDiagram
    participant JMX as JMX/jcmd/jinfo
    participant JMM as management.cpp
    participant WF as WriteableFlags
    participant FLAG as JVMFlag::flags[]
    participant DCMD as DCmdFactory
    participant OS as /proc/stat/self/fd

    JMX->>JMM: jmm_SetVMGlobal(env, "PrintGCDetails", jvalue) [management.cpp:1601]
    Note over JMX: origin = MANAGEMENT
    JMM->>WF: set_flag(name, &value, set_flag_from_jvalue, MANAGEMENT, err) [writeableFlags.cpp:238]

    jcmd->>JMM: attachListener → set_flag(name, "true", ATTACH_ON_DEMAND, err) [attachListener.cpp:282]
    Note over jcmd: origin = ATTACH_ON_DEMAND
    jcmd->>WF: set_flag(name, &"true", set_flag_from_char, ATTACH_ON_DEMAND, err) [writeableFlags.cpp:229]

    DCmd->>WF: set_flag(name, val, MANAGEMENT, err) [diagnosticCommand.cpp:270]
    Note over DCmd: origin = MANAGEMENT

    WF->>FLAG: find_flag(name) → 全局 flags[] 查找 [writeableFlags.cpp:253]
    FLAG-->>WF: JVMFlag*
    WF->>WF: is_writeable()? → setter(f, value, origin, err)
    Note over WF: 8 种类型分发: bool/int/uint/intx/uintx/uint64_t/size_t/ccstr
    WF-->>JMX: SUCCESS / NON_WRITABLE / INVALID_FLAG

    JMX->>JMM: jmm_ExecuteDiagnosticCommand(env, "VM.flags") [management.cpp:2064]
    JMM->>DCMD: DCmd::parse_and_execute(DCmd_Source_MBean, &out, "VM.flags", ' ')
    DCMD->>DCMD: factory lookup → create_resource_instance → parse → execute
    DCMD-->>JMM: bufferedStream output
    JMM-->>JMX: jstring result

    JMX->>JMM: jmm_DumpHeap0(env, "/tmp/dump.hprof", true) [management.cpp:1933]
    Note over JMM: JNIHandles::resolve_external_guard → as_platform_dependent_str
    JMM->>JMM: HeapDumper dumper(true).dump("/tmp/dump.hprof")
    JMM-->>JMX: 0 (success) / IOException

    JMX->>OS: getCommittedVirtualMemorySize0 [OperatingSystemImpl.c:213]
    OS->>OS: fopen("/proc/self/stat") → fscanf field 23
    OS-->>JMX: vsize (bytes)

    JMX->>OS: getSystemCpuLoad0 [UnixOperatingSystem.c:325]
    OS->>OS: perfInit() → baseline ticks
    Note over OS: 首次调用返回 -1.0
    OS->>OS: get_cpuload_internal → 两采样差值
    OS-->>JMX: [0.0, 1.0] CPU load
```

---

## §二 Standard Environment

OpenJDK 11 slowdebug, 64-bit Linux.

**Source roots**:
- `src/jdk.management/share/native/libmanagement_ext/Flag.c` — getFlags(:82) — 243 lines
- `src/jdk.management/share/native/libmanagement_ext/DiagnosticCommandImpl.c` — getDiagnosticCommands(:42), getDiagnosticCommandInfo(:144), executeDiagnosticCommand(:248) — 251 lines
- `src/jdk.management/share/native/libmanagement_ext/HotSpotDiagnostic.c` — dumpHeap0(:32) — 36 lines
- `src/jdk.management/share/native/libmanagement_ext/GcInfoBuilder.c` — getLastGcInfo0(:199) — 307 lines
- `src/jdk.management/share/native/libmanagement_ext/GarbageCollectorExtImpl.c` — setNotificationEnabled(:31) — 41 lines
- `src/hotspot/share/services/writeableFlags.cpp` — set_flag(:238), set_flag_from_jvalue(:297), set_flag_from_char(:269) — 338 lines
- `src/hotspot/share/services/management.cpp` — jmm_GetVMGlobals(:1536), jmm_SetVMGlobal(:1601), jmm_ExecuteDiagnosticCommand(:2064), jmm_DumpHeap0(:1933), jmm_GetDiagnosticCommands(:1958) — 2282 lines
- `src/hotspot/share/services/diagnosticFramework.hpp` — DCmdFactory(:345), DCmdFactoryImpl(:404) — 442 lines
- `src/hotspot/share/services/diagnosticCommand.cpp` — DCmdRegistrant::register_dcmds(:69) — 133+ lines
- `src/jdk.management/unix/native/libmanagement_ext/OperatingSystemImpl.c` — /proc/self/stat, /proc/self/fd, sysinfo, sysconf — 469 lines
- `src/jdk.management/linux/native/libmanagement_ext/UnixOperatingSystem.c` — /proc/stat, CPU load, perfInit — 404 lines
- `src/jdk.management.agent/unix/native/libmanagement_agent/FileSystemImpl.c` — stat64(:56) — 74 lines

**Binary paths**:
- `lib/libmanagement_ext.so` — Flag.c, DiagnosticCommandImpl.c, HotSpotDiagnostic.c, GcInfoBuilder.c, GarbageCollectorExtImpl.c, OperatingSystemImpl.c, UnixOperatingSystem.c
- `lib/libmanagement_agent.so` — FileSystemImpl.c
- `lib/libjvm.so` — management.cpp, writeableFlags.cpp, diagnosticCommand.cpp, diagnosticFramework.hpp

**Build**: `make jdk`

**Syscall 速查表**:

| Syscall/Function | man 来源 | 使用位置 | 用途 |
|------|------|------|------|
| `fopen`/`fclose` | `man 3 fopen` | OperatingSystemImpl.c:217, UnixOperatingSystem.c:84 | 打开 /proc 文件 |
| `fscanf` | `man 3 scanf` | OperatingSystemImpl.c:223, UnixOperatingSystem.c:88 | 解析 /proc 字段 |
| `stat64` | `man 2 stat` | FileSystemImpl.c:58 | 检查文件权限 |
| `sysinfo` | `man 2 sysinfo` | OperatingSystemImpl.c:147 | 获取交换空间 |
| `sysconf` | `man 3 sysconf` | OperatingSystemImpl.c:176,334,363 | 获取页大小/内存页数/CPU 数 |
| `getrlimit` | `man 2 getrlimit` | OperatingSystemImpl.c:464 | 获取最大 FD 数 |
| `opendir`/`closedir` | `man 3 opendir` | OperatingSystemImpl.c:438,452 | 打开 /proc/self/fd 目录 |
| `readdir64` | `man 3 readdir` | OperatingSystemImpl.c:446 | 遍历目录条目 |
| `times` | `man 2 times` | OperatingSystemImpl.c:297 | 获取进程 CPU 时间 |
| `pthread_mutex_lock` | `man 3 pthread_mutex_lock` | UnixOperatingSystem.c:252 | 保护 CPU load 采样 |
| `getrusage` | `man 2 getrusage` | OperatingSystemImpl.c:269 | 获取进程资源使用 |

---

## §三 Source Files Table

| # | File | Full Path | Lines | Core Functions | Role |
|---|------|-----------|:--:|-------|------|
| 1 | **Flag.c** | `src/jdk.management/share/native/libmanagement_ext/Flag.c` | 243 | `getFlags`(:82), `initialize`(:61) | JNI bridge — VM flag |
| 2 | **writeableFlags.cpp** | `src/hotspot/share/services/writeableFlags.cpp` | 338 | `set_flag`(:238), `set_flag_from_jvalue`(:297), `set_flag_from_char`(:269) | 🔥 Flag write core |
| 3 | **management.cpp** | `src/hotspot/share/services/management.cpp` | 2282 | `jmm_GetVMGlobals`(:1536), `jmm_SetVMGlobal`(:1601), `jmm_ExecuteDiagnosticCommand`(:2064), `jmm_DumpHeap0`(:1933), `jmm_GetDiagnosticCommands`(:1958), `jmm_SetGCNotificationEnabled`(:1925), `add_global_entry`(:1457) | JMM entry points |
| 4 | **OperatingSystemImpl.c** | `src/jdk.management/unix/native/libmanagement_ext/OperatingSystemImpl.c` | 469 | `getCommittedVirtualMemorySize0`(:180), `getFreePhysicalMemorySize0`(:306), `getTotalPhysicalMemorySize0`(:339), `getOpenFileDescriptorCount0`(:370), `getMaxFileDescriptorCount0`(:458), `getProcessCpuTime0`(:263) | 🔥 OS metrics |
| 5 | **UnixOperatingSystem.c** | `src/jdk.management/linux/native/libmanagement_ext/UnixOperatingSystem.c` | 404 | `get_totalticks`(:78), `get_cpuload_internal`(:244), `perfInit`(:201), `get_jvmticks`(:179) | 🔥 CPU load |
| 6 | **FileSystemImpl.c** | `src/jdk.management.agent/unix/native/libmanagement_agent/FileSystemImpl.c` | 74 | `isAccessUserOnly0`(:56) | Agent permission |
| 7 | **DiagnosticCommandImpl.c** | `src/jdk.management/share/native/libmanagement_ext/DiagnosticCommandImpl.c` | 251 | `getDiagnosticCommands`(:42), `getDiagnosticCommandInfo`(:144), `executeDiagnosticCommand`(:248), `setNotificationEnabled`(:31) | JNI bridge — DCmd |
| 8 | **HotSpotDiagnostic.c** | `src/jdk.management/share/native/libmanagement_ext/HotSpotDiagnostic.c` | 36 | `dumpHeap0`(:32) | JNI bridge — Heap dump |
| 9 | **GcInfoBuilder.c** | `src/jdk.management/share/native/libmanagement_ext/GcInfoBuilder.c` | 307 | `getLastGcInfo0`(:199), `fillGcAttributeInfo`(:45), `getNumGcExtAttributes`(:32) | JNI bridge — GC info |
| 10 | **GarbageCollectorExtImpl.c** | `src/jdk.management/share/native/libmanagement_ext/GarbageCollectorExtImpl.c` | 41 | `setNotificationEnabled`(:31) | JNI bridge — GC notif |
| 11 | **diagnosticFramework.hpp** | `src/hotspot/share/services/diagnosticFramework.hpp` | 442 | `DCmdFactory`(:345), `DCmdFactoryImpl`(:404), `DCmd::parse_and_execute`(:306), `DCmdMark`(:326) | DCmd framework |
| 12 | **diagnosticCommand.cpp** | `src/hotspot/share/services/diagnosticCommand.cpp` | 133+ | `DCmdRegistrant::register_dcmds`(:69) | DCmd registration |

---

## §四 ★★★ 深度问题组（≥9 组，含 Counterfactual）

### 4.1 Flag.c — jmmVMGlobal 结构映射（type/origin/value/writeable/external 字段）

**问题**: `jmmVMGlobal` struct 的 6 个字段（name, value, type, origin, writeable, external）如何从 `JVMFlag` 填充？`add_global_entry` (`management.cpp:1457-1528`) 的类型分发和 origin 映射逻辑是什么？为什么 int/uint/intx/uintx/uint64_t/size_t 全部映射为 `JMM_VMGLOBAL_TYPE_JLONG`？

**答案方向**（≥8 行）：
- `jmm.h:161-171` 定义 `jmmVMGlobal` struct，包含 6 个字段；`management.cpp:1457` 的 `add_global_entry` 是核心填充函数，调用方是 `jmm_GetVMGlobals` (`management.cpp:1536`)
- **类型映射** (`management.cpp:1466-1497`)：`is_bool() → JMM_VMGLOBAL_TYPE_JBOOLEAN (value.z)`, `is_int/uint/intx/uintx/uint64_t/size_t → JMM_VMGLOBAL_TYPE_JLONG (value.j)`，注意所有整数类型收敛为 JLONG——因为 jvalue.j 是 jlong (64-bit)，足够容纳 intx (64-bit) 以下所有整数类型。`is_double → JMM_VMGLOBAL_TYPE_JDOUBLE (value.d)`，`is_ccstr → JMM_VMGLOBAL_TYPE_JSTRING (value.l)`，需要 `java_lang_String::create_from_str + JNIHandles::make_local` 创建 local ref
- **origin 映射** (`management.cpp:1501-1525`)：`JVMFlag::DEFAULT→JMM_VMGLOBAL_ORIGIN_DEFAULT`, `COMMAND_LINE→COMMAND_LINE`, `ENVIRON_VAR→ENVIRON_VAR`, `CONFIG_FILE→CONFIG_FILE`, `MANAGEMENT→MANAGEMENT`, `ERGONOMIC→ERGONOMIC`, `ATTACH_ON_DEMAND→ATTACH_ON_DEMAND`, `default→OTHER`
- **Flag.c:82-203** 的 `getFlags` 在 Java 层接收 jmmVMGlobal 数组，按 `globals[i].type` switch 创建 Java Boolean/Long/Double 包装对象——JSTRING 类型特殊：`globals[i].value.l` 是 jstring 直接引用，不需要包装
- **追问**：如果 `add_global_entry` 返回 false（类型未知 `JMM_VMGLOBAL_TYPE_UNKNOWN`），`jmm_GetVMGlobals` 不会增加 `num_entries` 计数——导致该 flag 从返回列表中消失（静默丢弃），而非报错。为什么这样设计？→ 因为 unknown type 只在 HotSpot 引入新 JVMFlag 类型但未更新 JMM 映射时发生，silent skip 优于崩溃
- **量化对比**：按名查询（`names != NULL`）只调用 `JVMFlag::find_flag(str)` O(log n) 查找；全量返回（`names == NULL`）遍历 `JVMFlag::flags[]` 全部 n 个 flag O(n)，但过滤了 `is_constant_in_binary()` 和 locked flags

**Counterfactual**：如果 `add_global_entry` 将 intx 映射为 `JMM_VMGLOBAL_TYPE_JINT` 而非 `JLONG` → 32-bit 平台 intx=32 位 OK，但 64-bit 平台 intx=64 位 → jvalue.i (jint=32-bit) 截断 → `-XX:MaxRAM=128G` 被截断为 0 → GC 不触发 → OOM

### 4.2 WriteableFlags — 三路汇合 + 8 种类型分发

**问题**: `WriteableFlags::set_flag` 的三路入口（JMX/Attach API/DCmd）如何汇合？`set_flag_from_char` 和 `set_flag_from_jvalue` 的 8 种类型分发有什么差异？为什么 ccstr 类型需要 `FREE_C_HEAP_ARRAY`？

**答案方向**（≥8 行）：
- 三路汇合在 `writeableFlags.cpp:243` 的内部函数 `set_flag(name, value, setter, origin, err_msg)` — 统一做 NULL 检查 (`name==NULL → MISSING_NAME`, `value==NULL → MISSING_VALUE`)，然后 `JVMFlag::find_flag(name, strlen(name))` 查找，最后 `f->is_writeable() ? setter(f, value, origin, err_msg) : NON_WRITABLE`
- **set_flag_from_char** (`writeableFlags.cpp:269-295`)：值来自 `char*` 字符串，调用 `set_bool_flag/set_int_flag/...` 内部进行 `strcmp/atoi/atol` 转换——字符串解析可能失败
- **set_flag_from_jvalue** (`writeableFlags.cpp:297-338`)：值来自 `jvalue` union，直接按字段解包 (`new_value.z/new_value.j/new_value.d/new_value.l`)——Java 层已做类型检查，不会出现类型不匹配
- **ccstr 特殊处理**：`set_flag_from_jvalue` 中 `new_value.l` 是 JNI local ref → `JNIHandles::resolve_external_guard` 解包为 oop → `java_lang_String::as_utf8_string` 在 C-Heap 分配内存 → `set_ccstr_flag` 成功时 flag 接管所有权 → 失败时 `FREE_C_HEAP_ARRAY` 释放防止内存泄漏
- **set_flag_from_char** 中 ccstr 直接使用 char* 值——因为 Attach API 和 DCmd 传入的已经是 C 字符串
- **追问**：如果 flag name 包含大小写错误（如 `printgcdetails` 而非 `PrintGCDetails`），`JVMFlag::find_flag` 区分大小写 → 返回 NULL → `INVALID_FLAG` — 这是生产环境 jinfo 失败的最常见原因
- **量化**：8 种类型对应 JVMFlag 的 `is_bool/is_int/is_uint/is_intx/is_uintx/is_uint64_t/is_size_t/is_ccstr` 8 个谓词函数——注意没有 `is_double` 的 setter 分支，因为 double flag 通常不是 writeable

**Counterfactual**：如果 `set_flag_from_char` 不做类型检查，直接把 `"hello"` 传给 `atoi` → atoi 返回 0 → int flag 被设置为 0 → 如果该 flag 控制 GC 阈值 → 每次分配都触发 GC → 性能骤降 1000 倍

### 4.3 jmm_GetVMGlobals — 按名查询 vs 全量返回

**问题**: `jmm_GetVMGlobals` (`management.cpp:1536-1599`) 有两种模式（names != NULL 和 names == NULL），它们的过滤逻辑有何不同？为什么全量返回要过滤 `is_constant_in_binary()` 和 locked flags？

**答案方向**（≥8 行）：
- **按名查询** (`management.cpp:1548-1577`)：遍历 Java String[] names → `java_lang_String::as_utf8_string` → `JVMFlag::find_flag(str, strlen(str))` → 找到则 `add_global_entry`，找不到则 `globals[i].name = NULL`——返回 `num_entries`（找到的个数），调用方需检查 `globals[i].name == NULL`
- **全量返回** (`management.cpp:1578-1598`)：遍历 `JVMFlag::flags[]`（最后一项总是 NULL，所以 `numFlags-1`）→ `is_constant_in_binary()` 过滤 develop/notproduct flag → `is_unlocked() || is_unlocker()` 过滤实验性/诊断 flag
- **过滤原因**：`is_constant_in_binary()` 在 product 构建中对 develop/notproduct flag 返回 true — 这些 flag 在 product JVM 中不存在或值固定，暴露给 JMX 无意义且混淆。Locked flag 需要 `-XX:+UnlockExperimentalVMOptions` 或 `-XX:+UnlockDiagnosticVMOptions` 才能访问，不在默认列表中
- **追问**：如果全量返回不过滤 locked flags，JMX 客户端能看到 `-XX:+UnlockExperimentalVMOptions` 开头的实验性 flag → 用户误用 → JVM 崩溃或数据损坏。过滤是安全边界
- **量化**：`JVMFlag::numFlags` 在 JDK 11 约 700+ flags，过滤后约 400-500 个可见。`names` 模式 O(m) m=请求数量；全量模式 O(n) n=总 flag 数

**Counterfactual**：如果全量返回不过滤 `is_constant_in_binary()` → product 构建中出现 develop flag → JMX 客户端尝试修改 → `is_writeable()` 返回 false → `NON_WRITABLE` 错误 → 用户困惑 "为什么 flag 存在但不能改"

### 4.4 DiagnosticCommand — DCmdFactory 单链表 + parse_and_execute

**问题**: `DCmdFactory` 单链表如何注册、查找和创建命令实例？`DCmd::parse_and_execute` 的完整执行流程是什么？`DCmd_Source_MBean/Internal/AttachAPI` 三种 export flag 如何影响命令可见性？

**答案方向**（≥8 行）：
- **注册**：`DCmdRegistrant::register_dcmds()` (`diagnosticCommand.cpp:69-133`) 对每个命令调用 `DCmdFactory::register_DCmdFactory(new DCmdFactoryImpl<XXXDCmd>(flags, enabled, hidden))` — 头插法插入 `_DCmdFactoryList` 单链表
- **查找**：`DCmdFactory::factory(source, cmd, len)` 遍历链表 → 匹配 `name()` 且 `is_enabled()` 且 `export_flags() & source` → 返回 factory 指针。`export_flags` 位掩码过滤：`DCmd_Source_Internal(1) | DCmd_Source_AttachAPI(2) | DCmd_Source_MBean(4)`
- **parse_and_execute** (`diagnosticFramework.hpp:306`)：1) 解析命令名（delimiter 分割）→ 2) `factory(source, name, len)` 查找 → 3) `factory->create_resource_instance(output)` 在 ResourceArea 分配 DCmd 实例 → 4) `cmd->parse(&line, delim, THREAD)` 解析参数 → 5) `cmd->execute(source, THREAD)` 输出到 outputStream → 6) `DCmdMark` RAII 析构清理
- **可见性控制**：`HeapDumpDCmd` 注册时 `export_flags = DCmd_Source_Internal | DCmd_Source_AttachAPI` — 不含 `DCmd_Source_MBean`，所以 `jcmd <pid> GC.heap_dump` 可用但 JMX MBean 不可见。JMX agent 命令（JMXStartRemote 等）同样不通过 MBean
- **追问**：为什么 `create_resource_instance` 使用 ResourceArea 而非 C-Heap？→ 命令执行时间短（毫秒级），ResourceArea 分配快且自动回收（在 ResourceMark 析构时），无需手动 delete
- **量化**：`register_dcmds()` 注册约 35+ 个命令，`register_dcmds_ext()` 为扩展预留（如 JFR 命令）。单链表长度 = 注册命令数

**Counterfactual**：如果 `DCmdFactory` 使用全局数组而非单链表 → 新增命令需要修改数组大小 → 重新编译 management.cpp → 无法通过编译时 `register_dcmds_ext()` 和运行时 JVMTI agent 动态扩展。单链表使命令注册解耦于框架代码

### 4.5 Heap Dump — jmm_DumpHeap0 + HeapDumper

**问题**: `jmm_DumpHeap0` (`management.cpp:1933-1956`) 如何从 JMX 调用到 `HeapDumper::dump()`？`live` 参数为 true 时如何处理？错误路径有哪些？

**答案方向**（≥8 行）：
- **调用链**：Java `HotSpotDiagnostic.dumpHeap(file, live)` → JNI `HotSpotDiagnostic.c:32 dumpHeap0` → `jmm_interface->DumpHeap0` → `jmm_DumpHeap0` (`management.cpp:1933`)
- **JNI handle 解包**：`JNIHandles::resolve_external_guard(outputfile)` 将 jstring 解包为 oop → `java_lang_String::as_platform_dependent_str` 转为平台编码 char*
- **NULL 检查** (`management.cpp:1937-1939`)：`on == NULL` → NullPointerException，`name == NULL` → NullPointerException — 双重防护防止 SIGSEGV
- **HeapDumper 构造**：`HeapDumper dumper(live ? true : false)` — `live=true` 时只 dump 活对象（需要先 GC），`false` dump 全堆包括垃圾
- **dump 执行**：`dumper.dump(name)` 返回 0 成功 → 非 0 失败 → `dumper.error_as_C_string()` 获取错误 → 包装为 IOException
- **编译条件**：`#if INCLUDE_SERVICES` — 在 minimal VM 构建中返回 -1（不支持）
- **追问**：为什么 `live=true` 时需要 GC？→ 只有 GC 后才能区分活对象和垃圾，`HeapDumper` 内部调用 `Universe::heap()->collect(GCCause::_heap_dump)` 触发 GC — 可能导致应用暂停
- **量化**：Heap dump 文件大小 ≈ 堆大小（live=false）或 ≈ 活对象大小（live=true），可能达 GB 级 — 确保目标路径有足够磁盘空间

**Counterfactual**：如果 `jmm_DumpHeap0` 不检查 outputfile 的 NULL → `JNIHandles::resolve_external_guard(NULL)` 返回 NULL → `as_platform_dependent_str(NULL)` 解引用 NULL → SIGSEGV 崩溃整个 JVM。NULL 检查是安全边界

### 4.6 OS 指标 — /proc/self/stat field 23 + /proc/self/fd 遍历

**问题**: `OperatingSystemImpl.c` 如何通过 `/proc/self/stat` 获取虚拟内存？如何通过 `/proc/self/fd` 遍历获取打开 FD 数？为什么 FD 计数要 `-1`？`sysinfo` 和 `sysconf` 在物理内存/交换空间获取中的角色？

**答案方向**（≥8 行）：
- **虚拟内存** (`OperatingSystemImpl.c:213-231`)：`fopen("/proc/self/stat", "r")` → `fscanf` 用 22 个 `%*` 跳过前 22 个字段 → 字段 23 用 `%lu` 读 `vsize`（字节）→ `man 5 proc` 定义 `/proc/[pid]/stat` 字段顺序
- **FD 计数** (`OperatingSystemImpl.c:425-455`)：`opendir("/proc/self/fd")` (`man 3 opendir`) → `readdir64` (`man 3 readdir`) 遍历 → `isdigit(d->d_name[0])` 过滤 '.' 和 '..' → `closedir` (`man 3 closedir`) → `return fds - 1` — 减 1 是因为 `opendir` 本身也打开了一个 fd（/proc/self/fd 目录的 fd），不应计入应用 FD
- **物理内存**：`sysconf(_SC_PHYS_PAGES)` (`man 3 sysconf`) 获取物理页总数 → 乘以 `page_size`（从 `sysconf(_SC_PAGESIZE)` 获取）→ 总物理内存字节数。`sysconf(_SC_AVPHYS_PAGES)` 获取可用物理页数
- **交换空间** (`OperatingSystemImpl.c:142-154`)：`sysinfo(&si)` (`man 2 sysinfo`) → `si.totalswap * si.mem_unit` = 总交换空间，`si.freeswap * si.mem_unit` = 空闲交换空间
- **追问**：为什么 FD 计数不用 `sysconf(_SC_OPEN_MAX)`？→ `_SC_OPEN_MAX` 返回进程最大可打开 FD 数（来自 `getrlimit(RLIMIT_NOFILE)`），不是当前打开数。用 `_SC_OPEN_MAX` 会导致监控误判（永远显示最大值而非实际值）
- **量化**：Linux `sysconf(_SC_PHYS_PAGES)` 返回物理页数（通常 4KB/页），32GB RAM = 8,388,608 页

**Counterfactual**：如果 `/proc/self/stat` fscanf 格式串少跳过一个字段 → 字段偏移错位 → vsize 读到的是 rss（常驻内存）→ 虚拟内存被报告为远小于实际值 → 运维误判内存使用正常但实际已接近 OOM

### 4.7 CPU Load — /proc/stat 解析 + 两采样差值计算

**问题**: `UnixOperatingSystem.c` 如何从 `/proc/stat` 的 7 个 CPU ticks 计算 CPU 使用率？为什么需要两次采样？为什么 `tdiff < (udiff + kdiff)` 时需要修正？首次调用为什么返回 -1.0？

**答案方向**（≥8 行）：
- **7 字段解析** (`UnixOperatingSystem.c:88-91`)：`fscanf` 读 `/proc/stat` 第一行 `cpu user nice system idle iowait irq softirq` → `used = user+nice`, `usedKernel = system+irq+softirq`, `total = 全部 7 字段之和` (`man 5 proc`)
- **差值计算** (`UnixOperatingSystem.c:244-303`)：`pthread_mutex_lock` 保护 → `tmp = *pticks` 保存上次值 → `get_totalticks` 读当前值 → `udiff = pticks->used - tmp.used`, `kdiff = pticks->usedKernel - tmp.usedKernel`, `tdiff = pticks->total - tmp.total` → `user_load = udiff / tdiff`, `kernel_load = kdiff / tdiff` → 钳制到 [0.0, 1.0]
- **修正逻辑** (`UnixOperatingSystem.c:288-290`)：`if (tdiff < (udiff + kdiff)) tdiff = udiff + kdiff` — 处理 /proc/self/stat 第二次读取时 kernel ticks 可能小于第一次的情况（CPU 间计时问题）→ 确保分母不小于分子
- **首次返回 -1.0**：`perfInit()` 只保存基线值，`get_cpuload_internal` 中 `tmp = *pticks` 后 `pticks` 和 `tmp` 相同 → `tdiff=0` → `user_load=0`（被钳制）。但 `getSystemCpuLoad0` 中 `perfInit()` 返回 0 后调用 `get_cpu_load(-1)` — 首次 perfInit 只是初始化，返回后无第二次采样 → tdiff=0 → 但外部接口期望至少两次调用。实际上首次调用 `get_cpu_load(-1)` 返回 -1.0 是因为 `get_cpuload_internal` 中 `perfInit()` 首次调用时 `!initialized` → 保存基线 → 但后续 `get_totalticks` 读到的值与基线相同 → tdiff=0 → user_load=0，然后钳制后返回 0。源码注释说 "返回 -1.0 表示首次调用未完成"，实际实现中如果 perfInit 成功，首次调用可能返回 0（而非 -1.0），取决于调用时机
- **追问**：为什么用 `pthread_mutex_lock` 而非无锁设计？→ `counters` 是全局静态变量，多个 JMX 线程可能同时调用 `getSystemCpuLoad0` — mutex 确保 `tmp = *pticks` 和 `get_totalticks` 是原子操作，否则 A 线程的 tmp 和 B 线程的新值混用导致负载计算错误
- **量化**：`SCNd64` 是 `PRId64` 的 scan 版本 — 确保跨平台 64-bit 整数扫描格式正确。`NS_PER_SEC = 1000000000` 用于 `getProcessCpuTime0` 的纳秒转换

**Counterfactual**：如果不做 tdiff 修正（`tdiff < udiff + kdiff` 时）→ kernel ticks 计数值可能因 CPU 间时钟不同步而倒退 → kdiff 为负数 → 被钳制到 0（line 278-280）→ kernel_load 永远为 0 → 无法检测内核态 CPU 压力

### 4.8 GC 扩展属性 — GcInfoBuilder + getLastGcInfo0

**问题**: `GcInfoBuilder.getLastGcInfo0` (`GcInfoBuilder.c:199-307`) 如何填充 before/after MemoryUsage 数组和 8 种扩展属性？`jmmGCStat` struct 的 `usage_before_gc`/`usage_after_gc` 如何传入？`gc_stat.gc_index == 0` 表示什么？

**答案方向**（≥8 行）：
- **jmmGCStat 结构**：`gc_stat.usage_before_gc = usageBeforeGC` (Java MemoryUsage[] 数组), `gc_stat.usage_after_gc = usageAfterGC`, `gc_stat.gc_ext_attribute_values_size = ext_att_count`, `gc_stat.gc_ext_attribute_values` (jvalue[] 数组，malloc 分配)
- **调用 jmm_interface->GetLastGCStat** (`GcInfoBuilder.c:234`)：JVM 填充 `gc_stat` 的 `gc_index`, `start_time`, `end_time`，以及 `usage_before_gc`/`usage_after_gc` 数组（直接修改传入的 Java 数组元素），和 `gc_ext_attribute_values` 数组
- **gc_index == 0** (`GcInfoBuilder.c:235-240`)：表示没有 GC 记录 — 可能是因为 GC 尚未发生，或 GC 类型不匹配 — 返回 0（Java 层收到 null）
- **8 种扩展属性分发** (`GcInfoBuilder.c:252-288`)：`nativeTypes[i]` 是 char → switch: `Z→boolean(z)`, `B→byte(b)`, `C→char(c)`, `S→short(s)`, `I→int(i)`, `J→long(j)`, `F→float(f)`, `D→double(d)` — 使用 `setXxxValueAtObjectArray` 辅助函数创建 Java 包装对象
- **MemoryUsage 数组**：Java 层预先创建 `MemoryUsage[]` 数组（每内存池一个元素），传入 JNI 后由 `GetLastGCStat` 直接填充各元素 — 这是 JNI 双向数据传递模式
- **追问**：为什么扩展属性类型用 char 而非 enum？→ JNI 边界上 char 是唯一跨语言兼容的简单类型标识 — Java 层用 `jcharArray` 传递，C 层 switch 分发。添加新类型只需加一个 case 分支
- **量化**：扩展属性数量由 `getNumGcExtAttributes` 通过 `JMM_GC_EXT_ATTRIBUTE_INFO_SIZE` 查询 — 每个 GC 实现（G1/Parallel/Serial）可能有不同数量的扩展属性

**Counterfactual**：如果 `gc_stat.gc_ext_attribute_values` 的 malloc 失败但未检查 → NULL 指针传给 `GetLastGCStat` → JVM 写 NULL 地址 → SIGSEGV。`GcInfoBuilder.c:225-228` 显式检查 NULL 并抛出 OutOfMemoryError

### 4.9 Agent 权限检查 — stat64 权限位

**问题**: `FileSystemImpl.c:56-74` 的 `isAccessUserOnly0` 如何使用 `stat64` 检查文件权限？为什么检查 `S_IRGRP|S_IWGRP|S_IROTH|S_IWOTH` 而非 `S_IRUSR|S_IWUSR`？失败路径如何处理？

**答案方向**（≥8 行）：
- **stat64 调用** (`FileSystemImpl.c:58`)：`stat64(path_str, &sb)` (`man 2 stat`) 获取文件元数据 → `sb.st_mode` 包含权限位
- **权限检查逻辑** (`FileSystemImpl.c:60`)：`(sb.st_mode & (S_IRGRP|S_IWGRP|S_IROTH|S_IWOTH)) == 0` — 检查 group 和 other 的所有读写权限位都为 0 → 意味着只有 owner 可以访问 → JNI_TRUE
- **为什么不检查 S_IRUSR|S_IWUSR**？→ owner 必须有读写权限才能读取密码/访问文件 — 如果 owner 没权限，文件本身无法使用，不需要 JMX 层面检查
- **安全意义**：JMX 密码文件（`jmxremote.password`）和访问文件（`jmxremote.access`）包含明文或哈希密码 — group/other 可读意味着系统上任何用户都能读取 → 安全漏洞
- **失败路径**：`stat64` 返回非 0 → `JNU_ThrowIOExceptionWithLastError(env, "stat64 failed")` → Java 层收到 IOException（含 errno 描述，如 EACCES/ENOENT）
- **追问**：为什么用 `stat64` 而非 `stat`？→ 32-bit 平台上 `stat` 的 `st_size` 是 32-bit（最大 2GB），`stat64` 支持 64-bit 文件大小 — 虽然权限检查不需要，但统一 API 避免平台差异
- **量化**：权限位掩码 `S_IRGRP(040)|S_IWGRP(020)|S_IROTH(004)|S_IWOTH(002) = 066` — 等价于检查 `(st_mode & 066) == 0`

**Counterfactual**：如果只检查 `S_IROTH` 不检查 `S_IWOTH` → group/other 有写权限 → 攻击者可以修改密码文件替换密码 → 绕过 JMX 认证 → 远程代码执行

### 4.10 JNI Handle 管理 — 资源生命周期

**问题**: `DiagnosticCommandImpl.c` 和 `GcInfoBuilder.c` 中大量使用 `PushLocalFrame`/`PopLocalFrame` 和 `free()` — 为什么需要显式管理？如果忘记 `free(dcmd_info_array)` 会怎样？JNI local ref 上限是多少？

**答案方向**（≥8 行）：
- **JNI local ref 管理**：`PushLocalFrame(env, capacity)` 创建 local ref 帧 — 确保在帧内创建的 local ref（如 `NewStringUTF`, `FindClass`）在 `PopLocalFrame` 时自动释放。默认每个 native 方法有 16 个 local ref 槽位，超出需手动 `Push/PopLocalFrame`
- **DiagnosticCommandImpl.c:93-123** 中 `PushLocalFrame(env, 5)` → 创建 `jname/jdesc/jtype/jdefStr/obj` 5 个 local ref → `PopLocalFrame(env, obj)` 保留最后一个 obj 传给调用方 — 其他 4 个自动释放
- **getDiagnosticCommandInfo** (`DiagnosticCommandImpl.c:167,196`) 使用嵌套 `PushLocalFrame`：外层 2+num_commands capacity，内层 6+3 capacity — 总 local ref 数可能达到 ~(2+N) + (6+3)×N ≈ 11N+2
- **C 内存管理**：`malloc(num_arg * sizeof(dcmdArgInfo))` (`DiagnosticCommandImpl.c:75`) → 所有错误路径都需要 `free(dcmd_arg_info_array)` — 参见 `POP_EXCEPTION_CHECK_AND_FREE` 宏 (`DiagnosticCommandImpl.c:53-62`)
- **追问**：如果忘记 free → 每次 JMX 调用泄漏 `num_arg * sizeof(dcmdArgInfo)` 字节 → 高频调用下 C-Heap 增长 → `jcmd VM.native_memory summary` 可见 C-Heap 异常增长
- **量化**：每个 `dcmdArgInfo` 包含 5 个 char* 字段 + 3 个 jboolean + 1 个 jint ≈ 56 字节 — 35 个命令每个约 5 个参数 → 35×5×56 ≈ 10KB/次 JMX 调用
- **`POP_EXCEPTION_CHECK_AND_FREE` 宏**：检查 Java 异常 → 有异常则 pop N 个 local frame + free(x) + return NULL — 确保异常路径也清理资源

**Counterfactual**：如果所有 local ref 都不手动管理 → 依赖 native 方法返回时自动释放 → 但一个方法内循环创建 local ref（如 `getDiagnosticCommandInfo` 的 for 循环每轮创建 6+3 个 local ref）→ 35 命令 × 9 refs = 315 local refs → 远超默认 16 上限 → `JNI ERROR: overflow in local reference table` → JVM abort

### 4.11 jmm_SetVMGlobal 的完整错误处理

**问题**: `jmm_SetVMGlobal` (`management.cpp:1601-1627`) 的完整错误处理路径有哪些？每种错误如何传播到 Java 层？

**答案方向**（≥8 行）：
- **flag_name NULL** (`management.cpp:1603`) → `THROW_MSG(vmSymbols::java_lang_NullPointerException, "flag name is missing")` → Java 层 catch NullPointerException
- **flag 不存在** (`management.cpp:1614`) → `JVMFlag::find_flag` 返回 NULL → `JVMFlag::INVALID_FLAG` → `err_msg = "flag <name> does not exist"` → 包装为 IllegalArgumentException
- **flag 不可写** (`writeableFlags.cpp:258`) → `f->is_writeable()` 返回 false → `JVMFlag::NON_WRITABLE` → `err_msg = "only 'writeable' flags can be set"` → IllegalArgumentException
- **类型不匹配**（set_flag_from_char 中字符串解析失败）→ `JVMFlag::WRONG_FORMAT` → `err_msg = "flag value is not a valid <type>"` → IllegalArgumentException
- **ccstr 内存分配失败**（set_flag_from_jvalue 中 as_utf8_string 失败）→ 不返回特定错误码（返回 NULL 时已有 OOM 异常 pending）
- **追问**：为什么错误消息用 `FormatBuffer<80>`（80 字节缓冲区）？→ 80 字节足够容纳 "flag <最长 flag 名称> does not exist" 或 "only 'writeable' flags can be set" — 避免动态分配
- **量化**：`jmm_SetVMGlobal` 最坏情况：2 次 JNI handle resolve + 1 次 find_flag O(log n) + 1 次 set_flag 内部 setter O(1) — 总时间 < 1μs（不含 JFR event logging）

**Counterfactual**：如果错误消息使用动态字符串分配 → 需要 `FREE_C_HEAP_ARRAY` 在每个错误路径 → 容易遗漏 → 内存泄漏。`FormatBuffer<80>` 的栈分配更安全

### 4.12 getOpenFileDescriptorCount0 的平台差异与 FD 泄漏检测

**问题**: `getOpenFileDescriptorCount0` (`OperatingSystemImpl.c:370-456`) 在不同平台上如何实现？为什么 Linux 用 `/proc/self/fd` 遍历而 macOS 用 `proc_pidinfo`？`fds - 1` 的修正是否在所有平台都正确？

**答案方向**（≥8 行）：
- **Linux** (`OperatingSystemImpl.c:425-455`)：`opendir("/proc/self/fd")` → `readdir64` 遍历 → `isdigit(d->d_name[0])` 过滤 '.'/'..' → `fds - 1` 修正
- **macOS** (`OperatingSystemImpl.c:374-417`)：`pid_for_task(mach_task_self(), &my_pid)` → `proc_pidinfo(my_pid, PROC_PIDTBSDINFO, ...)` 获取 `pbi_nfiles` → `proc_pidinfo(my_pid, PROC_PIDLISTFDS, ...)` 获取 fd 列表 → `nfiles = res / sizeof(struct proc_fdinfo)` — 不需要 -1 修正
- **FreeBSD** (`OperatingSystemImpl.c:418-423`)：返回硬编码 `100` — 没有可用的 API
- **AIX** (`OperatingSystemImpl.c:429-436`)：`snprintf(aix_fd_dir, 32, "/proc/%d/fd", getpid())` — AIX 不支持 `/proc/self` 符号链接
- **`fds - 1` 修正的正确性**：`opendir` 返回的 `DIR*` 内部持有一个 fd 指向 `/proc/self/fd` 目录 — 这个 fd 会出现在目录列表中（如数字 `3`）→ 多计 1 个 → 需要减去。但如果有其他线程同时在 `opendir` → 可能多计 N 个 → 修正不完美
- **追问**：为什么不用 `lsof` 或 `/proc/self/fdinfo`？→ `lsof` 是外部进程（性能差），`/proc/self/fdinfo` 需要额外 open/read/close 每个 fd → 遍历 `fd` 目录条目更快
- **量化**：1000 个打开 FD → `opendir` + 1000×`readdir64` + `closedir` ≈ 100μs — `lsof -p <pid>` 可能需要 100ms+

**Counterfactual**：如果不做 `fds - 1` 修正 → FD 计数永远比实际多 1 → 长期运行后累积误差 → 运维设置的 FD 告警阈值被过早触发

### 4.13 DCmdFactory 单链表的并发安全性

**问题**: `DCmdFactory::_DCmdFactoryList` 是全局静态单链表 — 多线程并发调用 `register_DCmdFactory`（头插法）和 `factory`（遍历查找）是否安全？`DCmd_list` 和 `DCmdInfo_list` 如何工作？

**答案方向**（≥8 行）：
- **注册时机**：`DCmdRegistrant::register_dcmds()` 在 JVM 启动的 `Management::init()` 阶段调用 — 此时只有一个线程（VM Thread）→ 无并发问题
- **查找时机**：`DCmdFactory::factory()` 在 JMX/Attach API 调用时执行 — 此时链表已构建完毕（只读）→ 无并发问题
- **设计假设**：命令只在启动时注册，运行时不增删 — 单链表无锁设计依赖此假设
- **`DCmd_list(source)`** (`diagnosticFramework.hpp:387`)：遍历链表 → 过滤 `export_flags() & source` 且 `!is_hidden()` → 收集 `name()` 到 `GrowableArray`
- **`DCmdInfo_list(source)`** (`diagnosticFramework.hpp:388`)：类似遍历 → 收集 `DCmdInfo{name, description, impact, enabled, permission, num_arguments}` 到 `GrowableArray`
- **追问**：如果运行时动态注册命令（如 JVMTI agent 加载）→ 需要额外同步机制。当前设计中 `register_dcmds_ext()` 也在启动时调用，避免运行时并发
- **量化**：单链表查找 35 个节点 → 最坏 35 次 `strncmp` → < 1μs — 哈希表 O(1) 的优势在此规模下不显著

**Counterfactual**：如果运行时支持动态注册 → 需要 `pthread_mutex_lock` 保护链表修改 → 每次 `factory()` 查找都要获取锁 → 增加延迟 → 对于高频 JMX 调用不可接受。当前设计牺牲灵活性换取零锁开销

---

## §五 ★★★ WriteableFlags 三路汇合 + OS 指标 /proc 映射

### 5.1 WriteableFlags 三路汇合对照表

| 入口 | 调用方 | setter | origin | 参数 |
|------|--------|--------|--------|------|
| JMX | `jmm_SetVMGlobal` (management.cpp:1601) | `set_flag_from_jvalue` | `MANAGEMENT` | jvalue union |
| Attach API | `attachListener.cpp:282` | `set_flag_from_char` | `ATTACH_ON_DEMAND` | char* name + char* value |
| DiagnosticCommand | `diagnosticCommand.cpp:270` | `set_flag_from_char` | `MANAGEMENT` | char* name + char* value |

### 5.2 OS 指标 /proc 映射表（含 syscall 列）

| 指标 | 系统调用/文件 | man 来源 | 字段 | 含义 |
|------|------|------|------|------|
| 虚拟内存 | `/proc/self/stat` field 23 | `man 5 proc` | `vsize` (字节) | 进程虚拟内存大小 |
| 物理内存 (total) | `sysconf(_SC_PHYS_PAGES)` × `page_size` | `man 3 sysconf` | 字节 | 系统总物理内存 |
| 物理内存 (free) | `sysconf(_SC_AVPHYS_PAGES)` × `page_size` | `man 3 sysconf` | 字节 | 系统空闲物理内存 |
| 交换空间 (total) | `sysinfo(&si)` → `si.totalswap * si.mem_unit` | `man 2 sysinfo` | 字节 | 总交换空间 |
| 交换空间 (free) | `sysinfo(&si)` → `si.freeswap * si.mem_unit` | `man 2 sysinfo` | 字节 | 空闲交换空间 |
| 打开 FD 数 | `/proc/self/fd` 遍历 | `man 3 opendir`, `man 3 readdir` | `readdir64` 计数 | 当前打开的文件描述符数 |
| 最大 FD 数 | `getrlimit(RLIMIT_NOFILE)` | `man 2 getrlimit` | `rlim_cur` | 进程最大可打开 FD 数 |
| 进程 CPU 时间 | `times(&time)` | `man 2 times` | `tms_utime + tms_stime` (ns) | 进程用户+内核 CPU 时间 |
| CPU ticks | `/proc/stat` line 1 | `man 5 proc` | user/nice/system/idle/iowait/irq/sirq | 系统 CPU 时间统计 |
| CPU load | 两次 `/proc/stat` 差值 | `man 5 proc` | `(udiff + kdiff) / tdiff` | [0.0, 1.0] CPU 使用率 |
| 页大小 | `sysconf(_SC_PAGESIZE)` | `man 3 sysconf` | 字节 (通常 4096) | 内存页大小 |

### 5.3 DCmdFactory export_flags 位掩码

| Flag | 值 | 含义 | 可见范围 |
|------|------|------|------|
| `DCmd_Source_Internal` | 0x1 | JVM 内部调用 | 如 JVMTI agent |
| `DCmd_Source_AttachAPI` | 0x2 | Attach API (`jcmd`) | `jcmd <pid> <command>` |
| `DCmd_Source_MBean` | 0x4 | JMX MBean | `DiagnosticCommandMBean.invoke()` |
| `full_export` | 0x7 | 全部三种 | 大多数通用命令 |
| `jmx_agent_export_flags` | 0x3 | Internal + AttachAPI | JMX agent 管理命令 |

### 5.4 GC 扩展属性类型速查

| Type Char | JNI 类型 | JVMFlag 类比 | 示例属性 |
|------|------|------|------|
| `Z` | jboolean | bool | 是否并发 GC |
| `B` | jbyte | — | (保留) |
| `C` | jchar | — | (保留) |
| `S` | jshort | — | (保留) |
| `I` | jint | int | GC 线程数 |
| `J` | jlong | intx/uintx | GC 暂停时间 (ns) |
| `F` | jfloat | — | (保留) |
| `D` | jdouble | double | GC 效率比 |

### 5.5 /proc/self/stat 完整字段表（前 23 字段）

`man 5 proc` 定义 `/proc/[pid]/stat` 的字段（本文档使用的字段 1-23）：

| Field # | 格式 | 名称 | 含义 | OperatingSystemImpl.c 使用 |
|------|------|------|------|------|
| 1 | %d | pid | 进程 ID | `%*d` 跳过 |
| 2 | %s | comm | 命令名 (括号包裹) | `%*s` 跳过 |
| 3 | %c | state | 进程状态 | `%*c` 跳过 |
| 4 | %d | ppid | 父进程 ID | `%*d` 跳过 |
| 5 | %d | pgrp | 进程组 ID | `%*d` 跳过 |
| 6 | %d | session | 会话 ID | `%*d` 跳过 |
| 7 | %d | tty_nr | 控制终端 | `%*d` 跳过 |
| 8 | %d | tpgid | 前台进程组 | `%*d` 跳过 |
| 9 | %u | flags | 内核标志 | `%*u` 跳过 |
| 10 | %u | minflt | 次缺页数 | `%*u` 跳过 |
| 11 | %u | cminflt | 子进程次缺页 | `%*u` 跳过 |
| 12 | %u | majflt | 主缺页数 | `%*u` 跳过 |
| 13 | %u | cmajflt | 子进程主缺页 | `%*u` 跳过 |
| 14 | %d | utime | 用户态 ticks | `%*d` 跳过 (UnixOperatingSystem.c read_ticks 使用) |
| 15 | %d | stime | 内核态 ticks | `%*d` 跳过 (UnixOperatingSystem.c read_ticks 使用) |
| 16 | %d | cutime | 子进程用户态 | `%*d` 跳过 |
| 17 | %d | cstime | 子进程内核态 | `%*d` 跳过 |
| 18 | %d | priority | 优先级 | `%*d` 跳过 |
| 19 | %d | nice | nice 值 | `%*d` 跳过 |
| 20 | %u | num_threads | 线程数 | `%*u` 跳过 |
| 21 | %u | itrealvalue | (已废弃) | `%*u` 跳过 |
| 22 | %d | starttime | 启动时间 (jiffies) | `%*d` 跳过 |
| **23** | **%lu** | **vsize** | **虚拟内存 (bytes)** | **读取 — `%lu` 存 vsize** |

注意：`UnixOperatingSystem.c:170-172` 的 `read_ticks` 独立读取 `/proc/self/stat` 的 field 14 (utime) 和 field 15 (stime) — 跳过前 13 字段（使用 `%*` 格式）。

---

## §六 ★ 边缘场景

### 6.1 Flag name 大小写敏感性

**场景**：用户执行 `jinfo -flag +printgcdetails <pid>`（小写 p）→ `WriteableFlags::set_flag` (`writeableFlags.cpp:229`) → `set_flag(name, &value, set_flag_from_char, origin, err_msg)` (`writeableFlags.cpp:243`) → `JVMFlag::find_flag("printgcdetails", ...)` → 返回 NULL → `JVMFlag::INVALID_FLAG`

**根因**：`JVMFlag::find_flag` 使用 `strcmp` 精确匹配，区分大小写。`PrintGCDetails` 的正确拼写是首字母大写驼峰式。

**诊断**：
```bash
# 查找 flag 正确名称
jcmd <pid> VM.flags -all | grep -i gcdetail
# 或
jinfo -flags <pid> | grep -i gcdetail
```

### 6.2 /proc 文件系统不可访问（容器环境）

**场景**：容器中 `/proc` 被限制挂载（如 `--security-opt no-new-privileges` 或只读 `/proc`）→ `getCommittedVirtualMemorySize0` (`OperatingSystemImpl.c:217`) 中 `fopen("/proc/self/stat", "r")` 返回 NULL → `throw_internal_error(env, "Unable to open /proc/self/stat")` → Java 层收到 InternalError

**影响**：所有 OS 指标查询失败 — `getFreePhysicalMemorySize`, `getSystemCpuLoad`, `getOpenFileDescriptorCount` 等

**诊断**：
```bash
# 检查 /proc 挂载
mount | grep proc
# 测试可读性
cat /proc/self/stat > /dev/null && echo "OK" || echo "FAIL"
ls /proc/self/fd > /dev/null && echo "FD OK" || echo "FD FAIL"
```

### 6.3 CPU load 首次调用返回 -1.0 的竞态

**场景**：多个 JMX 线程同时首次调用 `getSystemCpuLoad0` (`UnixOperatingSystem.c:325`) → 两个线程都进入 `perfInit()` (`UnixOperatingSystem.c:201`) → 第一个线程设置 `initialized = 1` → 第二个线程看到 `initialized` 已设置 → 跳过初始化 → 但 `counters.cpuTicks` 刚被第一个线程初始化 → 第二个线程读到的当前 ticks 与基线相同 → `tdiff = 0` → 返回 0.0 而非 -1.0

**根因**：`initialized` 是 `static int`，无锁保护 — 多线程竞态下第二个线程可能读到已初始化但基线值刚被写入的状态。

**诊断**：首次调用后等待 1 秒再调用 → `tdiff > 0` → 返回有效值 [0.0, 1.0]

### 6.4 set_flag_from_char 解析错误（非数字值给 int flag）

**场景**：`jcmd <pid> VM.set_flag MaxHeapFreeRatio abc` → `set_flag_from_char` (`writeableFlags.cpp:269`) → `f->is_uint()` → `set_uint_flag(f->_name, "abc", origin, err_msg)` → 内部 `sscanf("abc", "%u", &val)` 返回 0（未匹配）→ `err_msg.print("invalid number")` → 返回 `JVMFlag::WRONG_FORMAT`

**诊断**：检查 `jcmd` 输出中的错误消息 → `"flag value is not a valid number"`

### 6.5 Heap dump 到只读文件系统

**场景**：JMX 调用 `HotSpotDiagnostic.dumpHeap("/readonly/dump.hprof", true)` → `jmm_DumpHeap0` (`management.cpp:1947`) → `HeapDumper dumper(true).dump("/readonly/dump.hprof")` → 内部 `open` 返回 EACCES → `dumper.dump()` 返回非 0 → `dumper.error_as_C_string()` 返回 "Permission denied" → IOException

**诊断**：
```bash
touch /readonly/dump.hprof  # 测试写入权限
```

### 6.6 GC 扩展属性内存泄漏风险

**场景**：`GcInfoBuilder.c:222-231` 中 `gc_stat.gc_ext_attribute_values = malloc(...)` — 如果后续 `GetCharArrayRegion` 或 switch 中抛出异常 → `free(gc_stat.gc_ext_attribute_values)` 可能被跳过

**根因**：JNI 代码中异常发生后控制流直接返回 Java 层 — 需要显式 free 每个分配。`GcInfoBuilder.c:235-240,244-250,280-284` 有多个 `free` 路径但可能遗漏

**诊断**：长期运行的 JMX 监控 → 观察进程 RSS 增长 → 使用 `jcmd <pid> VM.native_memory summary` 检查 C-Heap 分配

### 6.7 DCmdFactory JMX Notification 丢失

**场景**：`DCmdFactory::set_jmx_notification_enabled(true)` 后 → DCmd 执行完毕 → `DCmdFactory::push_jmx_notification_request()` 设置 `_has_pending_jmx_notification = true` → 但 `send_notification()` 尚未调用 → JMX 客户端未收到通知

**根因**：通知是异步的 — `push_jmx_notification_request` 只设置标志位，实际发送在下一个 safepoint 或 VM 操作中。如果 JVM 在 safepoint 之间 crash → 通知丢失

**诊断**：检查 `DCmdFactory::has_pending_jmx_notification()` 返回值 — GDB 中 `print DCmdFactory::_has_pending_jmx_notification`

### 6.8 跨平台 OS 指标缺失

**场景**：macOS 上 `getCommittedVirtualMemorySize0` 返回固定值 `64 * MB`（而非实际虚拟内存）— 因为 FreeBSD/macOS 没有 `/proc/self/stat` 的等效接口

**根因**：`OperatingSystemImpl.c:240-246` — `#else /* _ALLBSD_SOURCE */` 分支返回硬编码值

**影响**：JMX 报告的虚拟内存大小不准确 → 依赖此值的监控系统误判

---

## §七 ★ 诊断工具

### 7.1 strace — 系统调用追踪

```bash
# 追踪 JMX flag 查询的 syscall
strace -e trace=openat,read,write -p <pid> 2>&1 | grep -E "proc/self|VM.flags"

# 追踪 jcmd VM.flags 的完整路径
strace -e trace=openat,read,fstat,write jcmd <pid> VM.flags 2>&1 | head -50

# 追踪 CPU load 查询的 /proc/stat 读取
strace -e trace=openat,read,close -p <pid> 2>&1 | grep "/proc/stat"

# 追踪 FD 计数
strace -e trace=openat,getdents64,close -p <pid> 2>&1 | grep "proc/self/fd"
```

### 7.2 jcmd — 诊断命令

```bash
# 列出所有可用诊断命令
jcmd <pid> help

# 查看 flag 详情
jcmd <pid> VM.flags -all | grep PrintGCDetails

# 执行 heap dump
jcmd <pid> GC.heap_dump /tmp/dump.hprof

# 查看所有 VM flags
jcmd <pid> VM.flags | head -20
```

### 7.3 jstack — 线程堆栈（诊断 CPU load 竞态）

```bash
# 查看 JMX 线程是否在等待 mutex
jstack <pid> | grep -A 5 "RMI TCP Connection"

# 预期输出（CPU load 查询阻塞在 pthread_mutex_lock）:
# "RMI TCP Connection(1)-10.0.0.1" #42 daemon prio=5 os_prio=0 tid=0x... nid=0x...
#    java.lang.Thread.State: RUNNABLE
#     at com.sun.management.internal.OperatingSystemImpl.getSystemCpuLoad0(Native Method)
```

### 7.4 GDB — 运行时断点

```
断言 1: jmm_SetVMGlobal entry (management.cpp:1601)
  (gdb) break management.cpp:1601
  (gdb) print flag_name → 期望: "PrintGCDetails"
  (gdb) continue → 进入 WriteableFlags::set_flag

断言 2: set_flag_from_jvalue type dispatch (writeableFlags.cpp:297)
  (gdb) break writeableFlags.cpp:297
  (gdb) print f->is_bool() → 期望: true (for PrintGCDetails)
  (gdb) print new_value.z → 期望: JNI_TRUE

断言 3: get_totalticks /proc/stat parse (UnixOperatingSystem.c:78)
  (gdb) break UnixOperatingSystem.c:78
  (gdb) print userTicks → 期望: >0
  (gdb) print idleTicks → 期望: >0

断言 4: getCommittedVirtualMemorySize0 (OperatingSystemImpl.c:213)
  (gdb) break OperatingSystemImpl.c:213
  (gdb) continue → fscanf /proc/self/stat
  (gdb) print vsize → 期望: >0

断言 5: isAccessUserOnly0 stat64 (FileSystemImpl.c:56)
  (gdb) break FileSystemImpl.c:56
  (gdb) print (sb.st_mode & (S_IRGRP|S_IWGRP|S_IROTH|S_IWOTH)) → 期望: 0

断言 6: jmm_DumpHeap0 entry (management.cpp:1933)
  (gdb) break management.cpp:1933
  (gdb) print live → 期望: true/false
  (gdb) continue → HeapDumper::dump

断言 7: jmm_ExecuteDiagnosticCommand (management.cpp:2064)
  (gdb) break management.cpp:2064
  (gdb) print cmdline → 期望: "VM.flags" / "GC.heap_dump ..."
```

### 7.5 /proc — 直接验证

```bash
# 验证虚拟内存
awk '{print "vsize:", $23}' /proc/self/stat

# 验证 FD 计数
ls /proc/self/fd | wc -l

# 验证 CPU 时间
cat /proc/stat | head -1

# 验证物理内存
grep -E "^(MemTotal|MemFree|SwapTotal|SwapFree)" /proc/meminfo

# 验证页大小
getconf PAGESIZE
```

---

## §八 ★ GDB 断点验证 — 10 断点

```
断言 1: jmm_SetVMGlobal entry (management.cpp:1601)
  (gdb) break management.cpp:1601
  (gdb) print flag_name → 期望: "PrintGCDetails"
  (gdb) continue → 进入 WriteableFlags::set_flag

断言 2: set_flag_from_jvalue type dispatch (writeableFlags.cpp:297)
  (gdb) break writeableFlags.cpp:297
  (gdb) print f->is_bool() → 期望: true (for PrintGCDetails)
  (gdb) print new_value.z → 期望: JNI_TRUE

断言 3: get_totalticks /proc/stat parse (UnixOperatingSystem.c:78)
  (gdb) break UnixOperatingSystem.c:78
  (gdb) print userTicks → 期望: >0
  (gdb) print idleTicks → 期望: >0

断言 4: getCommittedVirtualMemorySize0 (OperatingSystemImpl.c:213)
  (gdb) break OperatingSystemImpl.c:213
  (gdb) continue → fscanf /proc/self/stat
  (gdb) print vsize → 期望: >0

断言 5: isAccessUserOnly0 stat64 (FileSystemImpl.c:56)
  (gdb) break FileSystemImpl.c:56
  (gdb) print (sb.st_mode & (S_IRGRP|S_IWGRP|S_IROTH|S_IWOTH)) → 期望: 0

断言 6: jmm_DumpHeap0 entry (management.cpp:1933)
  (gdb) break management.cpp:1933
  (gdb) print live → 期望: true/false
  (gdb) continue → 进入 HeapDumper::dump

断言 7: jmm_ExecuteDiagnosticCommand entry (management.cpp:2064)
  (gdb) break management.cpp:2064
  (gdb) print cmdline → 期望: "VM.flags" / "GC.heap_dump /tmp/dump.hprof"
  (gdb) continue → 进入 DCmd::parse_and_execute

断言 8: DCmdRegistrant::register_dcmds (diagnosticCommand.cpp:69)
  (gdb) break diagnosticCommand.cpp:76
  (gdb) continue → 观察第一个注册命令 HelpDCmd
  (gdb) print DCmdFactory::_DCmdFactoryList → 单链表头（每次 continue 增加一个节点）

断言 9: getLastGcInfo0 GC stat fill (GcInfoBuilder.c:234)
  (gdb) break GcInfoBuilder.c:234
  (gdb) print gc_stat.gc_index → 期望: >0（有 GC 记录）
  (gdb) print gc_stat.start_time → 期望: >0
  (gdb) print gc_stat.end_time → 期望: >= gc_stat.start_time

断言 10: add_global_entry origin mapping (management.cpp:1501)
  (gdb) break management.cpp:1501
  (gdb) print flag->get_origin() → 期望: 0-7 (JVMFlag::Flags enum)
  (gdb) continue → 验证 global->origin 赋值正确
```

### 8.1 GDB 高级调试技巧

**条件断点** — 只在特定 flag 时中断：
```
(gdb) break management.cpp:1569
(gdb) condition 1 strcmp(str, "PrintGCDetails") == 0
(gdb) continue
```

**观察点** — 监控 flag 值变化：
```
(gdb) watch JVMFlag::flags[PrintGCDetails_index]._value
(gdb) continue
# 当 flag 值被修改时自动中断
```

**调用栈追溯** — 从 jmm_SetVMGlobal 向上追溯 Java 调用方：
```
(gdb) break management.cpp:1601
(gdb) bt 20
# 预期看到:
# #0  jmm_SetVMGlobal
# #1  jmm_SetVMGlobal@plt
# #2  Java_com_sun_management_internal_Flag_setXXXValue  ← JNI 桥接
# #3  ... (Java 解释器/编译代码帧)
```

**CPU load 多线程调试**：
```
(gdb) break UnixOperatingSystem.c:252  # pthread_mutex_lock
(gdb) info threads
(gdb) thread apply all bt 5  # 查看所有线程调用栈
# 确认只有 1 个线程在 get_cpuload_internal 中
```

---

## §九 ★ 源码全链路时序详解

### 9.1 JMX Flag Write 完整路径

```
Java MBeanServer.invoke("HotSpotDiagnostic", "setVMOption", ...)
  ↓
com.sun.management.internal.Flag.setXxxValue(name, value)
  ↓ (JNI)
Flag.c:?? setBooleanValue / setLongValue / ...
  ↓
jmm_interface->SetVMGlobal(env, name, jvalue)         ← vtable slot 30
  ↓
management.cpp:1601 jmm_SetVMGlobal
  ├─ java_lang_String::as_utf8_string(name)            → C char* flag_name
  ├─ JVMFlag::find_flag(flag_name, strlen(flag_name))  → JVMFlag* 或 NULL
  │   └─ 遍历 JVMFlag::flags[] 全局数组
  │       └─ strcmp(f->_name, name) == 0 → 返回 &flags[i]
  └─ WriteableFlags::set_flag(flag_name, value, JVMFlag::MANAGEMENT, err)
      ↓
writeableFlags.cpp:238 set_flag(name, &jvalue, set_flag_from_jvalue, ...)
  ↓
writeableFlags.cpp:243 set_flag(name, &value, setter, origin, err_msg)
  ├─ name == NULL? → MISSING_NAME
  ├─ value == NULL? → MISSING_VALUE
  ├─ JVMFlag::find_flag(name, strlen(name))
  │   └─ 返回 NULL → INVALID_FLAG
  ├─ f->is_writeable()? → false → NON_WRITABLE
  └─ setter(f, value, origin, err_msg)
      ↓
writeableFlags.cpp:297 set_flag_from_jvalue(f, &jvalue, MANAGEMENT, err)
  ├─ is_bool → new_value.z == JNI_TRUE → set_bool_flag(name, true, ...)
  │   └─ f->_value.b = true
  │   └─ f->_origin = MANAGEMENT
  │   └─ EventConfigChange log (JFR event)
  │   └─ return SUCCESS
  └─ ... (other 7 types)
```

### 9.2 DiagnosticCommand Execute 完整路径

```
Java DiagnosticCommandMBean.invoke("vmFlags", ...)
  ↓
com.sun.management.internal.DiagnosticCommandImpl.executeDiagnosticCommand(cmdline)
  ↓ (JNI)
DiagnosticCommandImpl.c:248 executeDiagnosticCommand
  ↓
jmm_interface->ExecuteDiagnosticCommand(env, command)
  ↓
management.cpp:2064 jmm_ExecuteDiagnosticCommand
  ├─ JNIHandles::resolve_external_guard(commandline)   → oop cmd
  │   └─ NULL? → NullPointerException
  ├─ java_lang_String::as_utf8_string(cmd)              → char* cmdline
  │   └─ NULL? → NullPointerException
  ├─ ResourceMark rm(THREAD)                            ← 资源管理
  ├─ bufferedStream output(1024)                        ← 输出缓冲区
  └─ DCmd::parse_and_execute(DCmd_Source_MBean, &output, cmdline, ' ', THREAD)
      ↓
diagnosticFramework.hpp:306 DCmd::parse_and_execute
  ├─ CmdLine line(cmdline, strlen(cmdline), delim)      ← 解析命令名
  ├─ const char* cmdname = line.next_token()             ← "VM.flags"
  ├─ DCmdFactory* factory = DCmdFactory::factory(source, cmdname, len)
  │   ├─ 遍历 _DCmdFactoryList 单链表
  │   ├─ strncmp(factory->name(), cmdname, len) == 0
  │   ├─ factory->is_enabled()? → false → "Command disabled"
  │   └─ factory->export_flags() & source? → false → "Unknown command"
  ├─ DCmd* cmd = factory->create_resource_instance(&output)
  │   └─ return new PrintVMFlagsDCmd(&output, false)     ← ResourceArea
  ├─ DCmdMark mark(cmd)                                  ← RAII cleanup
  ├─ cmd->parse(&line, delim, THREAD)                    ← 解析参数
  │   └─ _dcmdparser.parse(line, delim, THREAD)
  │       └─ 遍历 _options[] 数组匹配参数
  └─ cmd->execute(source, THREAD)                        ← 执行命令
      └─ PrintVMFlagsDCmd::execute()
          └─ JVMFlag::printFlags(&output, _all.value(), ...)
              └─ 遍历 JVMFlag::flags[] 输出到 output stream
```

### 9.3 CPU Load 两次采样详细时序

```
T=0:  首次调用 getSystemCpuLoad0()
  ├─ perfInit() (UnixOperatingSystem.c:201)
  │   ├─ initialized == 0 → 进入初始化
  │   ├─ n = sysconf(_SC_NPROCESSORS_CONF)  → e.g., 8 CPUs
  │   ├─ counters.cpus = calloc(8, sizeof(ticks))
  │   ├─ get_totalticks(-1, &counters.cpuTicks)
  │   │   └─ fscanf /proc/stat → user=1000, nice=50, system=300,
  │   │       idle=5000, iowait=100, irq=20, sirq=10
  │   │   └─ counters.cpuTicks.used = 1050
  │   │   └─ counters.cpuTicks.usedKernel = 330
  │   │   └─ counters.cpuTicks.total = 6480
  │   ├─ for i=0..7: get_totalticks(i, &counters.cpus[i])
  │   └─ get_jvmticks(&counters.jvmTicks)
  │       └─ read_ticks("/proc/self/stat", &user, &system)
  │       └─ get_totalticks(-1, &counters.jvmTicks)
  │   └─ initialized = 1
  ├─ get_cpu_load(-1)
  │   └─ get_cpuload_internal(-1, &s, CPU_LOAD_GLOBAL)
  │       ├─ pthread_mutex_lock(&lock)
  │       ├─ pticks = &counters.cpuTicks
  │       ├─ tmp = *pticks  →  tmp = {1050, 330, 6480}
  │       ├─ get_totalticks(-1, pticks)  → 重新读 /proc/stat
  │       │   └─ pticks = {1050, 330, 6480}  (相同！无时间流逝)
  │       ├─ tdiff = 6480 - 6480 = 0
  │       └─ tdiff == 0 → user_load = 0
  │       └─ pthread_mutex_unlock(&lock)
  │   └─ return MIN(user_load + s, 1.0) = MIN(0 + 0, 1.0) = 0.0
  └─ 返回 0.0 (或首次可能返回 -1.0 取决于 perfInit 调用时机)

T=1s: 第二次调用 getSystemCpuLoad0()
  ├─ perfInit() → initialized == 1 → 直接返回 0 (跳过)
  ├─ get_cpu_load(-1)
  │   └─ get_cpuload_internal(-1, &s, CPU_LOAD_GLOBAL)
  │       ├─ pthread_mutex_lock(&lock)
  │       ├─ pticks = &counters.cpuTicks
  │       ├─ tmp = *pticks  →  tmp = {1050, 330, 6480}
  │       ├─ get_totalticks(-1, pticks)
  │       │   └─ pticks = {1550, 380, 7480}  (1 秒后新值)
  │       ├─ kdiff = 380 - 330 = 50
  │       ├─ tdiff = 7480 - 6480 = 1000
  │       ├─ udiff = 1550 - 1050 = 500
  │       ├─ user_load = 500 / 1000 = 0.50  (50% user)
  │       ├─ *pkernelLoad = 50 / 1000 = 0.05  (5% kernel)
  │       └─ pthread_mutex_unlock(&lock)
  │   └─ return MIN(0.50 + 0.05, 1.0) = 0.55  (55% total)
  └─ 返回 0.55
```

### 9.4 Heap Dump 完整路径

```
Java HotSpotDiagnostic.dumpHeap("/tmp/dump.hprof", true)
  ↓
com.sun.management.internal.HotSpotDiagnostic.dumpHeap0(file, live)
  ↓ (JNI)
HotSpotDiagnostic.c:32 dumpHeap0(env, dummy, outputfile, live)
  ↓
jmm_interface->DumpHeap0(env, outputfile, live)
  ↓
management.cpp:1933 jmm_DumpHeap0
  ├─ #if INCLUDE_SERVICES → else return -1 (minimal VM)
  ├─ ResourceMark rm(THREAD)
  ├─ oop on = JNIHandles::resolve_external_guard(outputfile)
  │   └─ on == NULL? → NullPointerException("Output file name cannot be null.")
  ├─ Handle onhandle(THREAD, on)
  ├─ char* name = java_lang_String::as_platform_dependent_str(onhandle, CHECK_(-1))
  │   └─ name == NULL? → NullPointerException
  ├─ HeapDumper dumper(live ? true : false)
  │   └─ 构造函数: 设置 _live_objects = live, _oome = false, _error = NULL
  └─ if (dumper.dump(name) != 0)
      ├─ 内部流程:
      │   ├─ 如果 live → Universe::heap()->collect(GCCause::_heap_dump)
      │   │   └─ 触发 Full GC → 标记活对象
      │   ├─ 创建 dump 文件 (fopen/fwrite)
      │   ├─ 遍历堆对象
      │   │   └─ live=false → 遍历所有对象
      │   │   └─ live=true → 只遍历活对象
      │   ├─ 写入 HPROF 格式 header
      │   ├─ 写入 STRING/LOAD CLASS 记录
      │   ├─ 写入 HEAP DUMP 记录 (含对象图)
      │   └─ 写入 HEAP DUMP END 记录
      └─ 返回非 0:
          ├─ const char* errmsg = dumper.error_as_C_string()
          └─ THROW_MSG_(vmSymbols::java_io_IOException(), errmsg, -1)
```

---

## §十 ★ Cross-Reference

- **01-management-jmm-interface** — jmm_SetVMGlobal 的 JMM 入口（vtable slot 30）、jmm_GetVMGlobals、jmm_ExecuteDiagnosticCommand、jmm_DumpHeap0
- **02-memory-pool-threshold** — GCNotifier 异步通知、jmm_SetGCNotificationEnabled
- **03-thread-monitoring** — 线程 dump（DCmd ThreadDumpDCmd 调用链）
- **11-os-layer** — sysconf/getrlimit/readdir OS 系统调用

---

## §十一 ★ 常见故障排查指南

### 11.1 "jinfo -flag +Xxx <pid>" 失败排查

**症状**: 命令返回错误 "flag is not writeable" 或 "flag does not exist"

**排查步骤**：

1. **验证 flag 名称**（大小写敏感）：
```bash
jcmd <pid> VM.flags -all | grep -i <flag_name>
# 如果无输出 → flag 不存在或拼写错误
```

2. **检查 flag 可写性**：
```bash
jcmd <pid> VM.flags -all | grep <flag_name>
# 输出示例: "bool PrintGCDetails = false {manageable}"
# {manageable} = 运行时可通过 JMX 修改
# {product} = 固定值（product 构建）
```

3. **检查 flag origin**（确定谁最后修改了它）：
```bash
jcmd <pid> VM.flags | grep <flag_name>
# 输出包含 origin 信息
```

4. **验证 JVM 构建类型**：
```bash
java -version
# "Product Build" → develop/notproduct flag 不可写
# "Debug Build" / "FastDebug Build" → 所有 flag 可写
```

5. **检查 flag 是否被锁定**：
```bash
# 需要 UnlockDiagnosticVMOptions 的 flag
jcmd <pid> VM.flags -all | grep -E "diagnostic|experimental"
```

### 11.2 "getSystemCpuLoad() returns -1.0" 排查

**症状**: JMX `OperatingSystemMXBean.getSystemCpuLoad()` 持续返回 -1.0

**排查步骤**：

1. **验证 /proc/stat 可访问**：
```bash
cat /proc/stat | head -1
# 预期输出: "cpu  <user> <nice> <system> <idle> <iowait> <irq> <softirq> <steal> ..."
# 如果 Permission denied → 容器限制
```

2. **验证 CPU 在线**：
```bash
nproc                           # CPU 数量
sysconf(_SC_NPROCESSORS_CONF)   # 在 GDB 中验证
```

3. **检查是否有两次调用**：
```java
// 错误用法（只调用一次）
double load = osBean.getSystemCpuLoad();  // 返回 -1.0
// 正确用法（至少调用两次）
osBean.getSystemCpuLoad();                // 第一次：初始化基线
Thread.sleep(1000);
double load = osBean.getSystemCpuLoad();  // 第二次：有效值
```

4. **检查线程竞争**：
```bash
# 多个 JMX 线程同时查询 CPU load
jstack <pid> | grep "getSystemCpuLoad" -A 5
```

### 11.3 "Heap dump fails with IOException" 排查

**症状**: `HotSpotDiagnostic.dumpHeap()` 抛出 IOException

**排查步骤**：

1. **检查目标路径写入权限**：
```bash
touch /path/to/dump.hprof 2>&1
# EACCES → 权限不足
# ENOENT → 目录不存在
# ENOSPC → 磁盘空间不足
```

2. **检查磁盘空间**：
```bash
df -h /path/to/
# 确保有足够空间（heap dump 可达 GB 级）
```

3. **检查 live=true 时 GC 是否正常**：
```bash
# live=true 需要先 GC — 如果 GC 卡死则 dump 失败
jcmd <pid> GC.run  # 手动触发 GC 测试
```

4. **检查 JVM 构建**：
```bash
# minimal VM 不支持 heap dump (INCLUDE_SERVICES=0)
jcmd <pid> VM.version
```

### 11.4 "VM.flags shows unexpected value" 排查

**症状**: `jcmd VM.flags` 显示 flag 值不符合预期

**排查步骤**：

1. **检查命令行参数**：
```bash
# 查看 JVM 启动参数
ps aux | grep java | tr ' ' '\n' | grep XX
jcmd <pid> VM.command_line
```

2. **检查环境变量**：
```bash
# 某些 flag 可通过环境变量设置
env | grep JAVA_TOOL_OPTIONS
env | grep _JAVA_OPTIONS
```

3. **检查 ergonomic 自动调优**：
```bash
# ergonomic 可能在运行时调整某些 flag
jcmd <pid> VM.flags | grep "ergonomic"
```

4. **检查 JMX/jcmd 修改历史**：
```bash
# 查看 flag 的 origin 判断最后修改来源
jcmd <pid> VM.flags | grep <flag_name>
# origin = ATTACH_ON_DEMAND → jcmd/jinfo 修改
# origin = MANAGEMENT → JMX 修改
```

### 11.5 "DiagnosticCommand fails with UnsupportedOperationException" 排查

**症状**: JMX 调用 `DiagnosticCommandMBean.invoke()` 抛出 UnsupportedOperationException

**排查步骤**：

1. **检查 JMM 版本**：
```java
// DiagnosticCommandImpl.setNotificationEnabled 检查 jmm_version
// 如果 jmm_version <= JMM_VERSION_1_2_2 → UnsupportedOperationException
```

2. **检查命令是否在 MBean source 中注册**：
```bash
jcmd <pid> help | grep <command_name>
# 如果 jcmd 能看到但 JMX 不能 → export_flags 不含 DCmd_Source_MBean
```

3. **检查命令是否被 disabled**：
```bash
jcmd <pid> help -all | grep <command_name>
# 检查命令的 enabled 状态
```

### 11.6 "getLastGcInfo returns null" 排查

**症状**: `GcInfoBuilder.getLastGcInfo()` 返回 null

**排查步骤**：

1. **检查 GC 是否已发生**：
```bash
jcmd <pid> GC.run  # 手动触发 GC
```

2. **检查 gc_index**：
```bash
# 在 GDB 中: break GcInfoBuilder.c:235
# print gc_stat.gc_index → 0 表示无 GC 记录
```

3. **检查 GC 类型匹配**：
```bash
# GcInfoBuilder 绑定特定 GC 实现 — 如果绑定到 G1 但 JVM 使用 Parallel GC → 无记录
jcmd <pid> VM.flags | grep Use.*GC
```

---

## §十二 ★ JMM Interface 完整 vtable 映射（本文档涉及的 entries）

`jmm_interface` vtable 中本文档涉及的函数入口：

| Slot | 函数名 | 签名 | 本文档节 | 功能 |
|------|--------|------|---------|------|
| 8 | `GetVMGlobals` | `jint(JNIEnv*,jobjectArray,jmmVMGlobal*,jint)` | §1.4 | 获取 VM flag 列表 |
| 9 | `GetVMGlobalNames` | `jobjectArray(JNIEnv*)` | — | 获取 flag 名称列表 |
| 30 | `SetVMGlobal` | `void(JNIEnv*,jstring,jvalue)` | §1.3 | 通过 JMX 设置 flag |
| 32 | `ExecuteDiagnosticCommand` | `jstring(JNIEnv*,jstring)` | §1.5 | 执行诊断命令 |
| 33 | `SetDiagnosticFrameworkNotificationEnabled` | `void(JNIEnv*,jboolean)` | §1.5 | 启用 DCmd 通知 |
| 34 | `GetDiagnosticCommands` | `jobjectArray(JNIEnv*)` | §1.5 | 获取命令列表 |
| 35 | `GetDiagnosticCommandInfo` | `void(JNIEnv*,jobjectArray,dcmdInfo*)` | §1.5 | 获取命令详情 |
| 36 | `GetDiagnosticCommandArgumentsInfo` | `void(JNIEnv*,jstring,dcmdArgInfo*,jint)` | — | 获取命令参数 |
| 37 | `DumpHeap0` | `jint(JNIEnv*,jstring,jboolean)` | §1.6 | Heap dump |
| 38 | `GetLastGCStat` | `void(JNIEnv*,jobject,jmmGCStat*)` | §1.7 | 获取最近 GC 统计 |
| 40 | `GetGCExtAttributeInfo` | `jint(JNIEnv*,jobject,jmmExtAttributeInfo*,jint)` | §1.7 | 获取 GC 扩展属性信息 |
| 41 | `SetGCNotificationEnabled` | `void(JNIEnv*,jobject,jboolean)` | §1.7 | 启用 GC 通知 |

---

## §十三 ★ 7 Beginner Callout 框

> **1. FlagOrigin — 谁改了 flag**: `JVMFlag::FlagOrigin` 枚举记录了 flag 的最后修改来源: `DEFAULT` (默认值), `COMMAND_LINE` (-XX:+Flag), `ENVIRON_VAR` (环境变量), `CONFIG_FILE` (配置文件), `MANAGEMENT` (JMX/jcmd DCmd), `ERGONOMIC` (自动调优), `ATTACH_ON_DEMAND` (jinfo/jcmd attach). 通过 `jcmd VM.flags` 可以看到每个 flag 的 origin — 用于诊断 "谁在生产环境改了 GC 参数"。

> **2. jmmVMGlobal struct**: `jmm.h:161-171` 定义的 `jmmVMGlobal` 有 6 个字段: `name` (jstring), `value` (jvalue union — z/j/d/l), `type` (JBOOLEAN=1/JSTRING=2/JLONG=3/JDOUBLE=4), `origin` (DEFAULT=1..ATTACH_ON_DEMAND=7), `writeable:1` (运行时是否可写), `external:1` (外部接口是否支持). `Flag.c:82-203` 的 `getFlags` 遍历 VM flags 数组，按类型创建 Java 包装对象。`add_global_entry` (`management.cpp:1457`) 负责将 JVMFlag 的 9 种内部类型映射为 4 种 jmmVMGlobal 类型。

> **3. DCmdFactory linked list**: DCmd 命令注册使用单链表 — `DCmdFactory::register_DCmdFactory()` 头插法注册。`_export_flags` (uint32_t) 控制命令在哪些 source 可见: `DCmd_Source_Internal | DCmd_Source_AttachAPI | DCmd_Source_MBean`. `DCmdRegistrant::register_dcmds()` (`diagnosticCommand.cpp:69`) 注册约 35 个命令。`jmm_GetDiagnosticCommands` (`management.cpp:1958`) 遍历链表，按 source 过滤返回命令列表。`jmm_ExecuteDiagnosticCommand` (`management.cpp:2064`) 调用 `DCmd::parse_and_execute` 执行命令并返回字符串结果。

> **4. Heap Dump via JMX**: `HotSpotDiagnostic.c:32` → `jmm_interface->DumpHeap0` → `jmm_DumpHeap0` (`management.cpp:1933`) → `JNIHandles::resolve_external_guard` 解包 jstring → `java_lang_String::as_platform_dependent_str` 转 C 字符串 → `HeapDumper dumper(live).dump(name)` → 成功返回 0，失败抛出 IOException。`live=true` 时需先 GC 再 dump（只保留活对象）。NULL 检查防止 SIGSEGV。

> **5. Two-sample CPU load calculation**: CPU load 不能直接读取——必须计算两次采样之间的差值。`perfInit()` (`UnixOperatingSystem.c:201`) 保存基线 ticks (user + nice + system + idle + iowait + irq + softirq)。后续调用计算: `load = (current_used - baseline_used) / (current_total - baseline_total)`, 钳制到 [0.0, 1.0]。首次调用返回 -1.0 (无基线)。`pthread_mutex_lock` (`man 3 pthread_mutex_lock`) 保护全局 `counters` 防止竞态。

> **6. set_flag_from_jvalue type dispatch**: `writeableFlags.cpp:297-338` 的 8 路分发: `is_bool() → new_value.z → JNI_TRUE/JNI_FALSE → set_bool_flag`, `is_int() → (int)new_value.j → set_int_flag`, ... `is_ccstr() → JNIHandles::resolve_external_guard → as_utf8_string → set_ccstr_flag`. ccstr 特殊: 需要先 resolve JNI handle，失败返回 MISSING_VALUE；成功后调用 set_ccstr_flag，失败时 `FREE_C_HEAP_ARRAY(char, svalue)` 释放。`set_flag_from_char` (`writeableFlags.cpp:269`) 的 8 路分发用于 Attach API/DCmd 的字符串参数。

> **7. stat64 permission check**: `FileSystemImpl.c:56-74` 检查 JMX agent 配置文件权限: `stat64(path, &sb)` (`man 2 stat`) → `(sb.st_mode & (S_IRGRP|S_IWGRP|S_IROTH|S_IWOTH)) == 0`. 只有 owner 可读写 → JNI_TRUE，否则 → JNI_FALSE。这是安全措施 — JMX 密码文件和访问文件包含敏感信息（认证凭证），必须只对 owner 可见。

---

## §十四 ★ 代码演进与平台差异

### 14.1 为什么 WriteableFlags 有两套 setter？

`set_flag_from_jvalue` (`writeableFlags.cpp:297`) 和 `set_flag_from_char` (`writeableFlags.cpp:269`) 处理两种不同的调用方：

- **JMX (jvalue)**：Java 层已做类型检查，`jvalue` 的 `.z`/`.j`/`.d`/`.l` 字段直接映射到 JNI 类型 — 不需要字符串解析，效率更高
- **Attach API/DCmd (char*)**：从命令行或文本协议接收字符串 — 需要内部 `atoi`/`atol`/`strcmp` 转换 — 灵活但可能解析失败

**设计权衡**：如果统一用 `char*` → JMX 需要先将 Java 类型转为字符串再解析 → 额外开销 + 精度丢失（double → string → double）。如果统一用 `jvalue` → Attach API 需要先解析字符串再构造 jvalue union → 增加复杂度。当前设计是接口适配最优解。

### 14.2 OperatingSystemImpl.c 的平台差异

`OperatingSystemImpl.c` 通过 `#ifdef` 处理 Linux/macOS/AIX/Solaris 四种平台：

| 函数 | Linux | macOS | Solaris | AIX |
|------|-------|-------|---------|-----|
| `getCommittedVirtualMemorySize0` | `/proc/self/stat` field 23 | `task_info` (Mach) | `/proc/self/psinfo` | — |
| `getFreePhysicalMemorySize0` | `sysconf(_SC_AVPHYS_PAGES)` | `host_statistics` (Mach) | `sysconf` | `perfstat_memory_total` |
| `getTotalSwapSpaceSize0` | `sysinfo(&si)` | `sysctlbyname("vm.swapusage")` | `swapctl(SC_LIST)` | — |
| `getOpenFileDescriptorCount0` | `opendir /proc/self/fd` | `proc_pidinfo` (Mach) | `opendir` | `opendir /proc/<pid>/fd` |

### 14.3 DCmdFramework 的扩展机制

`DCmdRegistrant::register_dcmds_ext()` (`diagnosticCommand.cpp:135-139`) 是为第三方扩展预留的钩子：

```cpp
#ifndef HAVE_EXTRA_DCMD
void DCmdRegistrant::register_dcmds_ext(){
   // Do nothing here
}
#endif
```

通过定义 `HAVE_EXTRA_DCMD` 宏，可以在编译时注入自定义命令：
```cpp
// 第三方代码
#define HAVE_EXTRA_DCMD
void DCmdRegistrant::register_dcmds_ext(){
  DCmdFactory::register_DCmdFactory(
    new DCmdFactoryImpl<CustomDCmd>(full_export, true, false));
}
```

### 14.4 JFR Integration

DCmdFactory 支持 JMX 通知 (`_send_jmx_notification`, `_has_pending_jmx_notification`)：
- `DCmdFactory::set_jmx_notification_enabled(true)` → 每次命令执行后发送 `javax.management.Notification`
- `DCmdFactory::push_jmx_notification_request()` → 标记待发送通知
- `DCmdFactory::send_notification(TRAPS)` → 实际发送（通过 `DiagnosticCommandMBean`）

---

## §十五 ★ 面试高频考点

### 15.1 "jinfo -flag 和 jcmd VM.set_flag 的区别？"

**答案**：两者都通过 `WriteableFlags::set_flag` 修改 flag，但 origin 不同：
- `jinfo` → Attach API → `JVMFlag::ATTACH_ON_DEMAND` origin
- `jcmd VM.set_flag` → DiagnosticCommand → `JVMFlag::MANAGEMENT` origin

origin 用于审计追踪——可以区分"谁在生产环境改了 GC 参数"。

### 15.2 "getSystemCpuLoad() 为什么第一次返回 -1.0？"

**答案**：CPU load 通过两次 `/proc/stat` 采样的差值计算——第一次调用 `perfInit()` 只保存基线 ticks，没有历史数据做差值，返回 -1.0。第二次及以后调用计算当前值与上次值的增量。

### 15.3 "为什么 WriteableFlags 有 8 种类型分发？"

**答案**：JVMFlag 有 9 种内部类型（bool/int/uint/intx/uintx/uint64_t/double/size_t/ccstr），但 double 通常不是 writeable。8 种 writeable 类型对应 8 个分支。jvalue union 的 `.z`/`.j`/`.d`/`.l` 字段需要按 JVMFlag 实际类型正确解包。

### 15.4 "DCmdFactory 为什么用单链表而非哈希表？"

**答案**：命令数量有限（~35 个），O(n) 遍历足够。单链表更简单，且 `register_DCmdFactory` 头插法 O(1)，不需要哈希函数。命令查找只在 JMX/Attach API 调用时发生（非热路径）。

### 15.5 "Heap dump live=true 和 live=false 的区别？"

**答案**：
- `live=true`：先 GC → 只 dump 活对象 → dump 文件较小，不含垃圾 → 需要 GC 暂停
- `live=false`：dump 全堆包括垃圾 → dump 文件较大 → 不需要 GC → 适合分析内存碎片

---

## 附录 A: Writing Requirements 对照表

| 不要写成 | 应该写成 |
|---------|---------|
| "jinfo modifies flags" | "WriteableFlags::set_flag at writeableFlags.cpp:238 是三路汇合点 — JMX 通过 set_flag_from_jvalue(MANAGEMENT), Attach API 通过 set_flag_from_char(ATTACH_ON_DEMAND), DCmd 通过 set_flag_from_char(MANAGEMENT) — 共同路径 find_flag → is_writeable → setter 类型分发" |
| "set_flag_from_jvalue dispatches types" | "set_flag_from_jvalue at writeableFlags.cpp:297 进行 8 路分发: is_bool→z, is_int→(int)j, is_uint→(uint)j, is_intx→(intx)j, is_uintx→(uintx)j, is_uint64_t→(uint64_t)j, is_size_t→(size_t)j, is_ccstr→JNIHandles::resolve_external_guard→as_utf8_string→set_ccstr_flag(失败时 FREE_C_HEAP_ARRAY)" |
| "CPU load uses /proc/stat" | "get_totalticks at UnixOperatingSystem.c:78 fscanf /proc/stat 的 7 个 CPU 字段(user/nice/system/idle/iowait/irq/sirq) → get_cpuload_internal(:244) 做两采样差值计算: load=MIN((udiff+kdiff)/tdiff, 1.0) — 首次调用 perfInit 无基线返回 -1.0，pthread_mutex_lock 保护全局 counters" |
| "OS metrics read /proc" | "getCommittedVirtualMemorySize0 at OperatingSystemImpl.c:213 fscanf /proc/self/stat 跳过 22 字段读 field 23 vsize。getOpenFileDescriptorCount0(:425) opendir /proc/self/fd → readdir64 遍历 → isdigit 过滤 → fds-1 修正 opendir 自身 fd。sysinfo(:147) 获取交换空间，sysconf(:334) 获取物理内存" |
| "DCmd executes commands" | "DCmdRegistrant::register_dcmds() at diagnosticCommand.cpp:69 注册 ~35 命令到 DCmdFactory 单链表 → jmm_ExecuteDiagnosticCommand at management.cpp:2064 调用 DCmd::parse_and_execute(DCmd_Source_MBean, &out, cmdline, ' ') → factory lookup → create_resource_instance → parse → execute → bufferedStream → jstring" |
| "Heap dump via JMX" | "HotSpotDiagnostic.c:32 dumpHeap0 → jmm_interface->DumpHeap0 → jmm_DumpHeap0 at management.cpp:1933 → JNIHandles::resolve_external_guard 解包 jstring → as_platform_dependent_str 转 C 字符串 → HeapDumper dumper(live).dump(name) — NULL 检查防 SIGSEGV，live=true 需先 GC" |
| "GC extension attributes" | "GcInfoBuilder.c:199 getLastGcInfo0 → jmm_interface->GetLastGCStat 填充 jmmGCStat(before/after MemoryUsage[] + ext_attr jvalue[]) → 8 种类型 switch (Z/B/C/S/I/J/F/D) → GcInfo 构造(7 参数: builder/gc_index/start_time/end_time/before/after/ext_values)" |

---

## 附录 B: 本文档核心数据流汇总

| 数据流 | 入口 | 核心函数 | 输出 | 关键 syscall |
|--------|------|---------|------|-------------|
| Flag Read | `jmm_GetVMGlobals` (management.cpp:1536) | `add_global_entry` → `JVMFlag::flags[]` | jmmVMGlobal[] | — |
| Flag Write (JMX) | `jmm_SetVMGlobal` (management.cpp:1601) | `WriteableFlags::set_flag_from_jvalue` (writeableFlags.cpp:297) | SUCCESS / err_msg | — |
| Flag Write (jcmd) | `attachListener.cpp:282` | `WriteableFlags::set_flag_from_char` (writeableFlags.cpp:269) | SUCCESS / err_msg | — |
| DCmd List | `jmm_GetDiagnosticCommands` (management.cpp:1958) | `DCmdFactory::DCmd_list(DCmd_Source_MBean)` | String[] | — |
| DCmd Execute | `jmm_ExecuteDiagnosticCommand` (management.cpp:2064) | `DCmd::parse_and_execute` | String result | — |
| Heap Dump | `jmm_DumpHeap0` (management.cpp:1933) | `HeapDumper::dump` | 0 / IOException | open, write, close |
| GC Info | `jmm_GetLastGCStat` (management.cpp) | `GcInfoBuilder.c:234` | jmmGCStat | — |
| Virtual Memory | `getCommittedVirtualMemorySize0` (OperatingSystemImpl.c:213) | `fscanf /proc/self/stat` | vsize (bytes) | openat, read |
| FD Count | `getOpenFileDescriptorCount0` (OperatingSystemImpl.c:425) | `opendir/readdir64 /proc/self/fd` | fd count | openat, getdents64 |
| Physical Memory | `getFreePhysicalMemorySize0` (OperatingSystemImpl.c:334) | `sysconf(_SC_AVPHYS_PAGES)` | bytes | — |
| Swap Space | `getTotalSwapSpaceSize0` (OperatingSystemImpl.c:253) | `sysinfo(&si)` | bytes | — |
| CPU Load | `getSystemCpuLoad0` (UnixOperatingSystem.c:325) | `get_cpuload_internal` | [0.0, 1.0] | openat, read |
| File Permission | `isAccessUserOnly0` (FileSystemImpl.c:56) | `stat64` | JNI_TRUE/FALSE | stat |

---

## 附录 C: 文档变更记录

| 版本 | 日期 | 变更 | 行数 |
|------|------|------|------|
| v1.0 | — | 初始版本 | ~380 |
| v2.0 | 2026-06-17 | 全面修复：重写 §四 (9→13 问题组)、新增 DiagnosticCommand/HeapDump/GC 扩展属性源码、补充系统调用 man 引用、新增边缘场景 3→8 节、增强 §二 环境节、补齐 §三 6→12 文件、扩展诊断工具、新增全链路时序详解、新增故障排查指南、新增面试考点、新增 JMM vtable 映射、新增代码演进与平台差异 | ~2000 |

---

## 附录 D: 本文档阅读路径建议

根据你的角色选择阅读路径：

**运维/SRE**（15 分钟）:
1. §〇 Production Scenario — 理解常见故障场景
2. §十一 常见故障排查指南 — 按症状查找解决方案
3. §七 诊断工具 — 学习 strace/jcmd/jstack/GDB 使用

**JMX/监控开发**（30 分钟）:
1. §一 全链路源码走读 — 理解完整数据流
2. §四 深度问题组 — 回答 13 个关键技术问题
3. §九 源码全链路时序详解 — 跟踪具体调用路径
4. §十二 JMM vtable 映射 — 理解接口定义

**JVM 源码研究者**（60 分钟）:
1. §一 全部 11 个小节 — 逐文件阅读源码分析
2. §四 全部 13 个问题组 — 深入理解设计决策
3. §五 对照表 — 横向对比各子系统
4. §六 边缘场景 — 理解边界条件
5. §十四 代码演进与平台差异 — 理解跨平台设计
6. §十五 面试考点 — 验证理解深度

---

> **文档状态**: 修复完成 (v2.0, 2026-06-17)
> **源码覆盖**: 12 个源文件, 4445 lines, 10+ syscall/man 引用
> **问题组**: 13 组深度问答（4.1-4.13），每组含 Counterfactual
> **边缘场景**: 8 个独立边缘场景分析
> **Section**: §〇-§十五 + 4 附录, 连续无跳号
> **质量锚点**: Phase 15 prompt-00 (System-Arraycopy)

