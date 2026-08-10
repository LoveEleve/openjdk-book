# PROMPT: 请撰写 04-os-flag-diagnostic.md

## §〇 Production Scenario（必须真实出现在文档 §〇 中）

运维通过 `jinfo -flag +PrintGCDetails <pid>` 尝试在生产环境动态开启 GC 日志，但命令返回错误 "flag is not writeable"。同时 `OperatingSystemMXBean.getSystemCpuLoad()` 返回 -1.0（表示不支持）。

Root cause (Flag): `PrintGCDetails` 是 `product` 类型 flag → 在 product 构建中 `JVMFlag::is_writeable()` 返回 true → 应该可写。但 `jinfo` 使用 Attach API → `attachListener.cpp:282` → `WriteableFlags::set_flag(name, value, JVMFlag::ATTACH_ON_DEMAND, err_msg)` → `set_flag_from_char()` (writeableFlags.cpp:298)。问题可能是 flag name 拼写错误（区分大小写）或 flag 在启动时通过 `-XX:+UnlockDiagnosticVMOptions` 锁定。另一个常见原因：`develop`/`notproduct` 类型 flag 在 product 构建中 `is_constant_in_binary()` 返回 true → `is_writeable()` 返回 false。

Root cause (OS metrics): `getSystemCpuLoad()` 返回 -1.0 表示首次调用尚未完成。`UnixOperatingSystem.c` 的 `perfInit()` (line 201-229) 需要在两次调用之间计算差值——第一次调用只初始化计数器，返回 -1.0。第二次及以后调用通过 `/proc/stat` 的 CPU ticks 差值计算负载。

**三步诊断**（直接写进 §〇）：

```bash
# 1. 检查 flag 类型和可写性
jcmd <pid> VM.flags -all | grep PrintGCDetails
# 如果 flag 不存在 → product 构建中 develop/notproduct flag 不可见
# 如果 flag 存在且 writeable=false → 被锁定或在当前构建中不可写

# 2. 检查 flag origin
jcmd <pid> VM.flags | grep PrintGCDetails
# origin 显示: COMMAND_LINE (启动参数), MANAGEMENT (JMX 修改), ATTACH_ON_DEMAND (jcmd/jinfo)

# 3. 验证 OS 指标是否可用
java -jar cmdline-jmxclient.jar ... java.lang:type=OperatingSystem \
  SystemCpuLoad ProcessCpuLoad
# 如果返回 -1.0 → 首次调用，等待后重试
# 如果持续返回 -1.0 → 平台不支持 (检查 os::is_thread_cpu_time_supported)

# 4. 验证 /proc 文件系统可访问
cat /proc/self/stat | awk '{print "vsize:", $23}'  # 虚拟内存
ls /proc/self/fd | wc -l                            # 打开文件描述符
cat /proc/stat | head -1                             # CPU ticks
```

**反事实 (Flag)**: 如果 `WriteableFlags::set_flag` 不做类型检查 → `jinfo -flag +PrintGCDetails=<non-boolean-value>` → `set_flag_from_char` 尝试将 "hello" 解析为 bool → 未定义行为 → flag 被设置为垃圾值 → JVM 行为不可预测。`set_flag_from_char` 的 7 种类型分发（bool/int/uint/intx/uintx/uint64_t/ccstr）确保只有正确的类型转换才通过。

**反事实 (OS metrics)**: 如果 CPU load 计算不做差值（直接用当前 ticks）→ 返回的是系统自启动以来的平均 CPU 使用率 → 无法反映最近 1 秒的负载 → 监控系统无法检测短时间内的 CPU 突增。两次采样的差值计算是用精度换取时效性——两次调用间隔越短，负载越反映最近状态。

---

## §一 Task + Narrative + De-glamorization + Beginner Callouts

### Task

Reading this prompt, you will produce a document that traces the **VM flag modification, diagnostic command execution, OS metric collection, and JMX agent file permission checking** pipelines. This covers: the 3-way convergence of `WriteableFlags::set_flag` (JMX + Attach API + DiagnosticCommand), the `DCmd::parse_and_execute` command dispatch chain, the 5-platform OS metric collection (Linux `/proc/self/stat`, `/proc/self/fd`, `/proc/stat`, `sysinfo`, `sysconf`), and the `FileSystemImpl.c` `stat64` permission check.

The reader has completed **01-management-jmm-interface** (jmm_interface vtable, JVM_ENTRY/JVM_LEAF), **11-os-layer** (sysconf/getrlimit/readdir). This doc: **how the JVM reads OS metrics, modifies flags at runtime, and executes diagnostic commands** — the "tools" layer of JMX.

### 文档按功能模块展开（共 8 个板块）：

| # | 板块 | 核心揭秘 | 目标行数 |
|---|------|---------|:---:|
| 1 | **Flag 管理 — jmmVMGlobal 结构映射** | Flag.c 的 6 个 JNI 函数 + jmmVMGlobal 的 type/origin/value/writeable 字段 | ~300 |
| 2 | **WriteableFlags — 三路汇合 + 类型分发** | set_flag 的 7 种类型分发 + 3 个 origin 值的审计含义 | ~300 |
| 3 | **DiagnosticCommand — jcmd 命令的 JMX 接口** | DCmdFactory 单链表注册 + DCmd::parse_and_execute + DiagnosticCommandImpl.c | ~300 |
| 4 | **Heap Dump — jmm_DumpHeap0** | HotSpotDiagnostic.c → HeapDumper::dump → HPROF 格式 | ~150 |
| 5 | **OS 指标 — /proc/self/stat + /proc/self/fd** | OperatingSystemImpl.c 的虚拟内存/FD/Swap 查询 + 5 平台差异 | ~350 |
| 6 | **CPU Load — /proc/stat 解析** | UnixOperatingSystem.c 的 perfInit + ticks 差值计算 | ~250 |
| 7 | **GC 扩展属性 — GcInfoBuilder** | getLastGcInfo0 的 before/after MemoryUsage 数组构造 | ~150 |
| 8 | **Agent 权限检查 — stat64** | FileSystemImpl.c 的 S_IRGRP/S_IWGRP/S_IROTH/S_IWOTH 权限位检查 | ~150 |

### Interview Story Format Answer（必须出现在 §一 末尾）

"VM flag modification in the JVM is a 3-way convergence on `WriteableFlags::set_flag` (writeableFlags.cpp:238). JMX calls `jmm_SetVMGlobal` (management.cpp:1601) with `JVMFlag::MANAGEMENT` origin, jcmd/jinfo calls via `attachListener.cpp:282` with `JVMFlag::ATTACH_ON_DEMAND` origin, and DiagnosticCommand calls with `JVMFlag::MANAGEMENT` origin. All three paths call the same `set_flag(name, value, setter, origin, err_msg)` with different `setter` functions — JMX uses `set_flag_from_jvalue` (jvalue union), Attach/DCmd use `set_flag_from_char` (char* parsing). The 7-type dispatch inside `set_flag_from_jvalue` (writeableFlags.cpp:297-338) handles bool/int/uint/intx/uintx/uint64_t/ccstr — ccstr requires `JNIHandles::resolve_external_guard` to unwrap the JNI string handle. OS metric collection is platform-specific: Linux reads `/proc/self/stat` field 23 for virtual memory (OperatingSystemImpl.c:213-231), iterates `/proc/self/fd` with `readdir64` for open file descriptors (line 425-455), and parses `/proc/stat` CPU ticks with `fscanf` for system CPU load (UnixOperatingSystem.c:78-126). CPU load uses two-sample difference calculation — `perfInit()` stores baseline ticks, subsequent calls compute delta to return [0.0, 1.0] load. `FileSystemImpl.c` checks agent config file permissions with `stat64` — ensuring `S_IRGRP|S_IWGRP|S_IROTH|S_IWOTH` are all zero (owner-only access)."

### Beginner Callout Boxes（文档中必须出现的 7 个 callout 框）

1. **FlagOrigin — 谁改了 flag**: `JVMFlag::FlagOrigin` 枚举记录了 flag 的最后修改来源: `DEFAULT` (默认值), `COMMAND_LINE` (-XX:+Flag), `ENVIRON_VAR` (环境变量), `CONFIG_FILE` (配置文件), `MANAGEMENT` (JMX/jcmd DCmd), `ERGONOMIC` (自动调优), `ATTACH_ON_DEMAND` (jinfo/jcmd attach). 通过 `jcmd VM.flags` 可以看到每个 flag 的 origin — 用于诊断 "谁在生产环境改了 GC 参数"。

2. **jmmVMGlobal struct**: jmm.h:161-171 定义的 `jmmVMGlobal` 有 6 个字段: `name` (jstring), `value` (jvalue union — z/j/d/l), `type` (JBOOLEAN=1/JSTRING=2/JLONG=3/JDOUBLE=4), `origin` (DEFAULT=1..ATTACH_ON_DEMAND=7), `writeable:1` (运行时是否可写), `external:1` (外部接口是否支持). Flag.c:83-203 的 `getFlags` 遍历 VM flags 数组，按类型创建 Java Boolean/Long/Double 包装对象，按 origin 选择 VMOption$Origin 常量。

3. **DCmdFactory linked list**: DCmd 命令注册使用单链表 — `DCmdFactory::register_DCmdFactory()` (diagnosticFramework.hpp:383) 头插法注册。`_export_flags` (uint32_t) 控制命令在哪些 source 可见: `DCmd_Source_Internal | DCmd_Source_AttachAPI | DCmd_Source_MBean`. `jmm_GetDiagnosticCommands` (management.cpp:1958) 遍历链表，按 source + enabled + !hidden 过滤返回命令列表。

4. **Two-sample CPU load calculation**: CPU load 不能直接读取——必须计算两次采样之间的差值。`perfInit()` (UnixOperatingSystem.c:201) 保存基线 ticks (user + nice + system + idle + iowait + irq + softirq)。后续调用计算: `load = (current_used - baseline_used) / (current_total - baseline_total)`, 钳制到 [0.0, 1.0]。首次调用返回 -1.0 (无基线)。两次调用间隔越短，负载越反映瞬时状态。

5. **set_flag_from_jvalue type dispatch**: writeableFlags.cpp:297-338 的 7 路分发: `is_bool() → new_value.z → JNI_TRUE/JNI_FALSE → set_bool_flag`, `is_int() → (int)new_value.j → set_int_flag`, `is_ccstr() → JNIHandles::resolve_external_guard → as_utf8_string → set_ccstr_flag`. ccstr 特殊: 需要先 resolve JNI handle，失败返回 MISSING_VALUE；成功后调用 set_ccstr_flag，失败时 `FREE_C_HEAP_ARRAY(char, svalue)` 释放。

6. **stat64 permission check**: FileSystemImpl.c:56-74 检查 JMX agent 配置文件权限: `stat64(path, &sb)` → `(sb.st_mode & (S_IRGRP|S_IWGRP|S_IROTH|S_IWOTH)) == 0`. 只有 owner 可读写 → JNI_TRUE，否则 → JNI_FALSE。这是安全措施 — JMX 密码文件和访问文件包含敏感信息（认证凭证），必须只对 owner 可见。

7. **jmmVMGlobalOrigin to VMOption.Origin mapping**: Flag.c:152-180 的 origin 映射: `JMM_VMGLOBAL_ORIGIN_DEFAULT(1) → "DEFAULT"`, `COMMAND_LINE(2) → "VM_CREATION"`, `MANAGEMENT(3) → "MANAGEMENT"`, `ENVIRON_VAR(4) → "ENVIRON_VAR"`, `CONFIG_FILE(5) → "CONFIG_FILE"`, `ERGONOMIC(6) → "ERGONOMIC"`, `ATTACH_ON_DEMAND(7) → "ATTACH_ON_DEMAND"`, `OTHER(99) → "OTHER"`. Java 层 `VMOption.getOrigin()` 返回这些字符串值。

---

## §二 Standard Environment

OpenJDK 11 slowdebug, 64-bit Linux.

Source roots:
- `src/jdk.management/share/native/libmanagement_ext/Flag.c` — 6 JNI 函数 (:82-243)
- `src/hotspot/share/services/writeableFlags.cpp` — set_flag(:238), set_flag_from_jvalue(:297), set_flag_from_char(:229)
- `src/hotspot/share/services/management.cpp` — jmm_GetVMGlobals(:1536), jmm_SetVMGlobal(:1601), jmm_GetVMGlobalNames(:1420), jmm_ExecuteDiagnosticCommand(:2064), jmm_DumpHeap0(:1933)
- `src/jdk.management/share/native/libmanagement_ext/DiagnosticCommandImpl.c` — getDiagnosticCommands(:41), executeDiagnosticCommand(:247), getDiagnosticCommandInfo(:144)
- `src/jdk.management/share/native/libmanagement_ext/HotSpotDiagnostic.c` — dumpHeap0(:31)
- `src/jdk.management/share/native/libmanagement_ext/GcInfoBuilder.c` — getLastGcInfo0
- `src/jdk.management/share/native/libmanagement_ext/GarbageCollectorExtImpl.c` — setNotificationEnabled
- `src/jdk.management/unix/native/libmanagement_ext/OperatingSystemImpl.c` — OS 指标 (:179-456)
- `src/jdk.management/linux/native/libmanagement_ext/UnixOperatingSystem.c` — CPU load (:78-304)
- `src/jdk.management.agent/unix/native/libmanagement_agent/FileSystemImpl.c` — stat64 (:56-74)

Build: `make jdk`

Key binaries:
- `build/linux-x86_64-normal-server-slowdebug/jdk/lib/libmanagement_ext.so`
- `build/linux-x86_64-normal-server-slowdebug/jdk/lib/libmanagement_agent.so`

---

## §三 Source Files Table

| # | File | Full Path | Lines | Core Functions | Role |
|---|------|-----------|:--:|-------|------|
| 1 | **Flag.c** | `src/jdk.management/share/native/libmanagement_ext/Flag.c` | 243 | `getFlags`(:82), `setLongValue`(:205), `setDoubleValue`(:212), `setBooleanValue`(:219), `setStringValue`(:226), `initialize`(:233) | JNI bridge — VM flag read/write |
| 2 | **writeableFlags.cpp** | `src/hotspot/share/services/writeableFlags.cpp` | 338 | `set_flag`(:238), `set_flag_from_jvalue`(:297), `set_flag_from_char`(:229) | 🔥 Flag write core — 3-way convergence |
| 3 | **management.cpp** | `src/hotspot/share/services/management.cpp` | 2282 | `jmm_GetVMGlobals`(:1536), `jmm_SetVMGlobal`(:1601), `jmm_GetVMGlobalNames`(:1420), `jmm_ExecuteDiagnosticCommand`(:2064), `jmm_DumpHeap0`(:1933) | JMM flag/dcmd entry points |
| 4 | **DiagnosticCommandImpl.c** | `src/jdk.management/share/native/libmanagement_ext/DiagnosticCommandImpl.c` | 251 | `getDiagnosticCommands`(:41), `getDiagnosticCommandInfo`(:144), `executeDiagnosticCommand`(:247), `setNotificationEnabled`(:31) | JNI bridge — jcmd via JMX |
| 5 | **HotSpotDiagnostic.c** | `src/jdk.management/share/native/libmanagement_ext/HotSpotDiagnostic.c` | 36 | `dumpHeap0`(:31) | JNI bridge — heap dump |
| 6 | **GcInfoBuilder.c** | `src/jdk.management/share/native/libmanagement_ext/GcInfoBuilder.c` | 307 | `getLastGcInfo0`, `getNumGcExtAttributes`, `fillGcAttributeInfo` | JNI bridge — GC extended attributes |
| 7 | **OperatingSystemImpl.c** | `src/jdk.management/unix/native/libmanagement_ext/OperatingSystemImpl.c` | 469 | `getCommittedVirtualMemorySize0`(:179), `getTotalSwapSpaceSize0`(:249), `getFreePhysicalMemorySize0`(:339), `getOpenFileDescriptorCount0`(:370), `getProcessCpuTime0`(:263) | 🔥 OS metrics — /proc/self/stat, /proc/self/fd, sysinfo |
| 8 | **UnixOperatingSystem.c** | `src/jdk.management/linux/native/libmanagement_ext/UnixOperatingSystem.c` | 404 | `perfInit`(:201), `get_totalticks`(:78), `get_cpuload_internal`(:244) | 🔥 CPU load — /proc/stat parsing |
| 9 | **FileSystemImpl.c** | `src/jdk.management.agent/unix/native/libmanagement_agent/FileSystemImpl.c` | 74 | `isAccessUserOnly0`(:56), `JNI_OnLoad`(:40) | Agent permission check — stat64 |
| 10 | **jmm.h** | `src/hotspot/include/jmm.h` | ~400 | `jmmVMGlobal`(:161-220), `jmmVMGlobalType`, `jmmVMGlobalOrigin` | Interface — VMGlobal struct definition |

---

## §四 Deep Dive Question Groups（9 组，全部含 Counterfactual + 答案方向）

### 4.1 ★★★ Flag.c — jmmVMGlobal 结构映射

```
问题：
  ① Flag.c:82-203 的 getFlags 如何将 JVMFlag 转换为 Java VMOption 对象？
      答案方向:
      1. malloc(count * sizeof(jmmVMGlobal)) 分配 C 结构数组
      2. jmm_interface->GetVMGlobals(env, names, globals, count) → management.cpp:1536
      3. 遍历 globals[i]，按 type 创建 Java 包装:
         JBOOLEAN → java/lang/Boolean (new Boolean(globals[i].value.z))
         JSTRING → 直接用 globals[i].value.l (jstring 引用)
         JLONG → java/lang/Long (new Long(globals[i].value.j))
         JDOUBLE → java/lang/Double (new Double(globals[i].value.d))
         其他类型 → continue 跳过
      4. 按 origin 选择 VMOption$Origin 静态字段:
         JMM_VMGLOBAL_ORIGIN_DEFAULT → origin_DEFAULT, ...
         JMM_VMGLOBAL_ORIGIN_OTHER → origin_OTHER
      5. JNU_NewObjectByName 构造 Flag Java 对象 (name, valueObj, writeable, external, origin)
      
  ② Counterfactual: 如果 getFlags 不使用 jmmVMGlobal 中间结构？
      答案方向: 每个 flag 单独 JNI 调用 → 500+ flags × 4 JNI 调用/flag = 2000+ JNI 调用
      → JMX 查询所有 flags 需要 2000 次 JNI 边界穿越 → 每次 JNI 调用 ~1μs → 总计 2ms。
      jmmVMGlobal 批量接口一次调用返回所有 flags → 1 次 JNI 调用 ~10μs。
      性能差异 200x。
```

### 4.2 ★★★ WriteableFlags — 三路汇合 + 类型分发

```
问题：
  ① WriteableFlags::set_flag (writeableFlags.cpp:238-295) 的三路入口各有什么特点？
      答案方向:
      入口 1 — JMX: jmm_SetVMGlobal (management.cpp:1601)
        → set_flag(name, &new_value, set_flag_from_jvalue, JVMFlag::MANAGEMENT, err_msg)
        → 参数: jvalue union (z/j/d/l), origin=MANAGEMENT
      
      入口 2 — Attach API: attachListener.cpp:282
        → set_flag(op->arg(0), op->arg(1), JVMFlag::ATTACH_ON_DEMAND, err_msg)
        → 参数: char* name + char* value, setter=set_flag_from_char, origin=ATTACH_ON_DEMAND
      
      入口 3 — DiagnosticCommand: diagnosticCommand.cpp:270
        → set_flag(_flag.value(), val, JVMFlag::MANAGEMENT, err_msg)
        → 参数: char* name + char* value, setter=set_flag_from_char, origin=MANAGEMENT
      
      共同路径 (set_flag, line 243):
        1. NULL 检查: name==NULL → MISSING_NAME, value==NULL → MISSING_VALUE
        2. JVMFlag::find_flag(name) → 全局 flags[] 数组查找
        3. f->is_writeable() → 权限检查
        4. setter(f, value, origin, err_msg) → 类型分发执行
      
  ② set_flag_from_jvalue (line 297-338) 的 7 路类型分发？
      答案方向:
      f->is_bool() → new_value.z → JNI_TRUE/JNI_FALSE → set_bool_flag
      f->is_int() → (int)new_value.j → set_int_flag
      f->is_uint() → (uint)new_value.j → set_uint_flag
      f->is_intx() → (intx)new_value.j → set_intx_flag
      f->is_uintx() → (uintx)new_value.j → set_uintx_flag
      f->is_uint64_t() → (uint64_t)new_value.j → set_uint64_t_flag
      f->is_size_t() → (size_t)new_value.j → set_size_t_flag
      f->is_ccstr() → JNIHandles::resolve_external_guard(new_value.l) → as_utf8_string → set_ccstr_flag
      
  ③ Counterfactual: 如果三个入口不记录 origin？
      答案方向: 修改 flag 后无法知道谁改的 → jinfo -flag 诊断时可能错误假设 flag 来源
      → 白费时间排查不在启动脚本中的配置。origin 提供变更溯源 — 在生产故障 "谁改了 GC 参数" 的场景中直接定位修改者。
```

### 4.3 ★★★ DiagnosticCommand — jcmd 的 JMX 接口

```
问题：
  ① jmm_ExecuteDiagnosticCommand (management.cpp:2064-2080) 如何执行 jcmd 命令？
      答案方向:
      1. 解析 jstring → cmdline (as_utf8_string)
      2. bufferedStream output — 输出缓冲区
      3. DCmd::parse_and_execute(DCmd_Source_MBean, &output, cmdline, ' ', CHECK_NULL)
         → 解析命令名 → 从 DCmdFactory 链表查找 → 创建 DCmd 实例 → 解析参数 → execute()
      4. output.as_string() → java.lang.String → JNI local ref
      
  ② DCmdFactory 链表如何管理命令注册？
      答案方向:
      diagnosticFramework.hpp:345-400 — DCmdFactory 单链表:
        - _next 指针 → 注册时头插法 (register_DCmdFactory, line 383)
        - _export_flags: 控制哪些 source 可用 (Internal|AttachAPI|MBean)
        - _enabled: 禁用时不能执行
        - _hidden: 不出现在 help 列表中
      DCmd_list(source): 遍历链表，按 source + enabled + !hidden 过滤
      
  ③ Counterfactual: 如果 DCmd 用 HashMap 而非单链表？
      答案方向: HashMap 查找 O(1) vs 单链表 O(N) → 但 DCmd 命令数通常 <100
      → O(N) 遍历 ~100 次 vs O(1) hash → 性能差异可忽略。
      单链表优势: (a) 无 hash 冲突 (b) 内存开销低 (c) 迭代顺序确定 (注册顺序 = help 输出顺序)。
```

### 4.4 ★★★ Heap Dump — jmm_DumpHeap0

```
问题：
  ① jmm_DumpHeap0 (management.cpp:1933-1956) 如何触发 Heap dump？
      答案方向:
      1. 解析 outputfile jstring → platform_dependent_str
      2. HeapDumper dumper(live ? true : false)
         live=true → 只 dump 存活对象 (触发 full GC 前)
         live=false → dump 全部对象
      3. dumper.dump(name) → 失败抛 IOException
      4. 条件编译: #if INCLUDE_SERVICES
      
  ② Counterfactual: 如果 live=true 时不触发 full GC？
      答案方向: 直接 dump 堆 → 包含大量死对象 → hprof 文件大小膨胀 3-5x
      → 分析工具加载时间增加 → 分析死对象浪费精力。
      full GC 的代价 (STW ~100ms) 换来了更小、更有用的 heap dump。
```

### 4.5 ★★★ OS 指标 — /proc/self/stat + /proc/self/fd

```
问题：
  ① getCommittedVirtualMemorySize0 (OperatingSystemImpl.c:213-231) 如何解析 /proc/self/stat？
      答案方向:
      fopen("/proc/self/stat") → fscanf 跳过前 22 个字段:
        格式串: "%*d %*s %*c %*d %*d %*d %*d %*d %*u %*u %*u %*u %*u %*d %*d %*d %*d %*d %*d %*u %*u %*d %lu"
        字段 1-22 用 %* 跳过，字段 23 (vsize) 用 %lu 读取
        返回: (jlong)vsize — 进程虚拟内存大小（字节）
      
      /proc/self/stat 格式 (man 5 proc):
        pid comm state ppid pgrp session tty tpgid flags minflt cminflt majflt cmajflt
        utime stime cutime cstime priority nice num_threads itrealvalue starttime
        vsize rss ...
        字段 23 = vsize = 虚拟内存字节数
      
  ② getOpenFileDescriptorCount0 (line 425-455) 如何统计打开的文件描述符？
      答案方向:
      opendir("/proc/self/fd") → 遍历 readdir64()
      → 对每个条目: isdigit(d->d_name[0]) → fds++ (只计数数字名称 = 真正的 fd)
      → 返回 fds - 1 (减去 opendir 本身打开的 fd)
      
  ③ Counterfactual: 如果 FD 计数使用 sysconf(_SC_OPEN_MAX) 而不是遍历 /proc/self/fd？
      答案方向: sysconf 返回最大 FD 限制 — 不是当前打开的 FD 数。
      实际打开 100 个 FD，ulimit -n = 65536 → sysconf 返回 65536 → 监控系统误判 FD 泄漏。
      /proc/self/fd 遍历返回精确的当前 FD 数 — 每个条目对应一个打开的文件。
```

### 4.6 ★★★ CPU Load — /proc/stat 解析

```
问题：
  ① get_totalticks (UnixOperatingSystem.c:78-126) 如何解析 /proc/stat？
      答案方向:
      fscanf(fh, "cpu %"SCNd64" %"SCNd64" %"SCNd64" %"SCNd64" %"SCNd64" %"SCNd64" %"SCNd64",
             &userTicks, &niceTicks, &systemTicks, &idleTicks,
             &iowTicks, &irqTicks, &sirqTicks)
      
      pticks->used = userTicks + niceTicks
      pticks->usedKernel = systemTicks + irqTicks + sirqTicks
      pticks->total = userTicks + niceTicks + systemTicks + idleTicks + iowTicks + irqTicks + sirqTicks
      
      /proc/stat 格式 (man 5 proc):
        cpu user nice system idle iowait irq softirq steal guest guest_nice
        7 个字段被读取 (steal/guest/guest_nice 被忽略)
      
  ② get_cpuload_internal (line 244-304) 的差值计算逻辑？
      答案方向:
      1. pthread_mutex_lock(&lock) — 保护全局计数器
      2. 保存当前 ticks → tmp
      3. 重新读取 ticks (get_totalticks)
      4. kdiff = pticks->usedKernel - tmp.usedKernel (负值取 0)
      5. tdiff = pticks->total - tmp.total
      6. udiff = pticks->used - tmp.used
      7. 用户负载 = udiff / tdiff
      8. 总负载 = MIN((udiff + kdiff) / tdiff, 1.0) — 钳制到 [0.0, 1.0]
      
      首次调用: perfInit() 只保存基线 → 返回 -1.0 (无历史数据)
      
  ③ Counterfactual: 如果不做差值计算（直接返回 ticks 比值）？
      答案方向: 返回系统自启动以来的平均 CPU 使用率 → 无法反映最近负载
      → 系统空闲 23.9 小时后满载 6 分钟 → 平均负载 ~1% → 监控系统不告警。
      差值计算使负载反映两次采样间的实际情况 → 两次调用间隔 1 秒 → 反映最近 1 秒负载。
```

### 4.7 ★★★ GC 扩展属性 — GcInfoBuilder

```
问题：
  ① GcInfoBuilder.getLastGcInfo0 如何获取 GC 扩展属性？
      答案方向:
      1. jmm_interface->GetLastGCStat(env, gcManager, &gc_stat)
      2. 遍历所有内存池 → 获取 before/after MemoryUsage
      3. gcExtItemCount 个扩展属性 (如 GC 线程数)
      4. 构造 CompositeData 返回
      
  ② Counterfactual: 如果 GC 扩展属性内联在标准 GarbageCollectorMXBean 中？
      答案方向: 标准 MXBean 的接口固定（由 JSR 174 定义）→ 无法添加 JVM 特有属性。
      GcInfoBuilder 允许 JDK 通过 CompositeData 动态添加属性 → 保持标准接口不变的同时
      暴露实现特有信息 → 向前兼容（老客户端忽略不认识的属性）。
```

### 4.8 ★★★ Agent 权限检查 — stat64

```
问题：
  ① FileSystemImpl.c:56-74 的 isAccessUserOnly0 如何检查文件权限？
      答案方向:
      1. JNU_GetStringPlatformChars → C 字符串路径
      2. stat64(path, &sb) → 获取文件状态
      3. (sb.st_mode & (S_IRGRP|S_IWGRP|S_IROTH|S_IWOTH)) == 0
         → 检查组和其他人的读/写权限位是否全部为 0
         → 全部为 0 → 只有 owner 可访问 → JNI_TRUE
         → 任一非 0 → JNI_FALSE
      4. stat64 失败 → IOException("stat64 failed")
      
  ② Counterfactual: 如果 Agent 不做权限检查？
      答案方向: JMX 密码文件和访问文件包含明文密码 → 如果 group/other 可读
      → 同一系统上的其他用户可以读取 JMX 认证凭证 → 获得 JMX 连接权限
      → 可以执行 heap dump、修改 VM flag → 安全漏洞 (CVE-2016-3427 类似)。
      isAccessUserOnly0 在 Agent 启动时检查配置文件权限 — 不符合要求则拒绝启动。
```

### 4.9 ★★★ jmm_GetVMGlobals — 按名查询 vs 全量返回

```
问题：
  ① jmm_GetVMGlobals (management.cpp:1536-1599) 的两种查询模式？
      答案方向:
      names != NULL (line 1548): 按名查询
        遍历 names 数组 → JVMFlag::find_flag(str) → add_global_entry() → 填充 jmmVMGlobal
        → 用于 JMX 查询特定 flag (如 jinfo -flag PrintGCDetails)
      
      names == NULL (line 1578): 全量返回
        遍历 JVMFlag::flags[] 全局数组 → 过滤 is_constant_in_binary() 和 locked flags
        → add_global_entry() → 填充 jmmVMGlobal
        → 用于 jcmd VM.flags 和 JMX getDiagnosticOptions()
      
      add_global_entry (line 1457-1528): 类型映射 + origin 映射
        is_bool() → JBOOLEAN, is_int/uint/intx/uintx/uint64_t/size_t → JLONG
        is_double() → JDOUBLE, is_ccstr() → JSTRING
        writeable = flag->is_writeable(), external = flag->is_external()
      
  ② Counterfactual: 如果全量查询不做 is_constant_in_binary 过滤？
      答案方向: develop/notproduct flag 在 product 构建中返回 → JMX 客户端看到
      这些 flag → 尝试修改 → set_flag 返回 NON_WRITABLE → 客户端困惑。
      过滤保持 JMX 接口与构建类型一致 — product 构建只暴露 product 和 diagnostic flag。
```

---

## §五 Article Structure

```
§〇 生产场景 — jinfo 改 flag 失败 + CPU load 返回 -1.0
  ★ 真实现象: jinfo -flag 返回 "not writeable", getSystemCpuLoad() 返回 -1.0
  ★ Root cause (Flag): develop/notproduct flag 在 product 构建中不可写
  ★ Root cause (OS): CPU load 首次调用无基线 → 返回 -1.0
  ★ 三步诊断: jcmd VM.flags -all → 检查 /proc 可访问性 → 重试 CPU load

§一 ★★★ Flag/DCmd/OS Metrics 全链路源码走读
  ❓ 这不是 jinfo 教程 — 这是 JVM 如何修改 flag、执行诊断命令、读取 OS 指标
  1.1 Flag.c — jmmVMGlobal 结构映射 + 6 个 JNI 函数
  1.2 WriteableFlags — 三路汇合 + 7 种类型分发
  1.3 DiagnosticCommand — DCmdFactory 链表 + parse_and_execute
  1.4 Heap Dump — jmm_DumpHeap0 → HeapDumper::dump
  1.5 OS 指标 — /proc/self/stat + /proc/self/fd + sysinfo
  1.6 CPU Load — /proc/stat 解析 + 差值计算
  1.7 GC 扩展属性 — GcInfoBuilder
  1.8 Agent 权限检查 — stat64
  1.9 ★ Mermaid: 三路 flag 设置 → WriteableFlags::set_flag → 7 种类型分发
  1.10 ★ 面试 Story Format 答案

§二 ★★★ 7 Beginner Callout 框
  2.1 FlagOrigin — 谁改了 flag
  2.2 jmmVMGlobal struct (6 fields)
  2.3 DCmdFactory linked list
  2.4 Two-sample CPU load calculation
  2.5 set_flag_from_jvalue type dispatch (7 types)
  2.6 stat64 permission check
  2.7 jmmVMGlobalOrigin to VMOption.Origin mapping

§三 ★★ WriteableFlags 三路汇合对照表
  ❓ JMX vs Attach vs DCmd: setter 函数、origin 值、参数格式

§四 ★★ OS 指标 — /proc 文件系统映射表
  ❓ /proc/self/stat field 23 → vsize, /proc/self/fd → fd count, /proc/stat → CPU ticks

§五 ★★ DCmdFactory 命令注册机制
  ❓ register_DCmdFactory 头插法 + _export_flags + DCmd_list 过滤

§六 ★ GDB 断点验证
  断言 1: jmm_SetVMGlobal entry → verify flag_name resolution
  断言 2: set_flag_from_jvalue type dispatch → verify type check
  断言 3: get_totalticks /proc/stat parse → verify fscanf
  断言 4: getCommittedVirtualMemorySize0 → verify /proc/self/stat field 23
  断言 5: isAccessUserOnly0 stat64 → verify permission bits

§七 ★ Cross-Reference
  ❓ 01-management-jmm-interface — jmm_SetVMGlobal 的 JMM 入口
  ❓ 02-memory-pool-threshold — GCNotifier 异步通知
  ❓ 11-os-layer — sysconf/getrlimit/readdir
```

---

## §六 Writing Requirements

1. **Every paragraph opens with WHY** — "Because JMX, jcmd, and jinfo all need to modify VM flags, WriteableFlags::set_flag serves as the single convergence point..." — not WHAT.

2. **3-5 lines source code per claim** — paste relevant code from Flag.c / writeableFlags.cpp / OperatingSystemImpl.c / UnixOperatingSystem.c, do not describe it.

3. **Mermaid** — Three entry points (JMX/Attach/DCmd) → WriteableFlags::set_flag → 7-type dispatch → JVMFlag::set_*.

4. **7 Beginner callout boxes** — exact text from §一.

5. **Cross-reference at four points**:
   - At `jmm_SetVMGlobal` → "→ 01-management-jmm-interface for JMM entry point"
   - At `WriteableFlags::set_flag` → "→ Attach API for attachListener entry"
   - At `sysconf/sysinfo` → "→ 11-os-layer for OS system calls"
   - At `/proc/self/stat` → "→ man 5 proc for /proc format"

6. **Story-format interview answer** — at §一末尾.

7. **3-way convergence table** — columns: entry (JMX/Attach/DCmd), setter function, origin value, parameter format

---

## §七 Output Format

- Markdown file, named `04-os-flag-diagnostic.md`
- Output path: `/data/workspace/openjdk-cut-new/probe_md/17-jmx-management/`
- 元信息头:

```
> **阶段**：[17-jmx-management]
> **前置**：[01-management-jmm-interface]（jmm_interface vtable）、[11-os-layer]（sysconf/getrlimit/readdir）
> **配套**：[00-what-is-jmx]（JMX 概念）、[02-memory-pool-threshold]（GCNotifier）、[03-thread-monitoring]（线程 dump）
> **阅读收益**：追踪 VM flag 从 JMX/jcmd/jinfo 三路修改到 WriteableFlags::set_flag 类型分发的完整路径——理解 jmmVMGlobal 的 type/origin/value/writeable 字段映射、set_flag_from_jvalue 的 7 种类型分发、DCmdFactory 单链表注册和 DCmd::parse_and_execute 命令执行、OperatingSystemImpl.c 的 /proc/self/stat 字段 23 解析和 /proc/self/fd 遍历计数、UnixOperatingSystem.c 的 /proc/stat CPU ticks 差值计算、FileSystemImpl.c 的 stat64 权限位检查；掌握 "jinfo 改 flag 失败" 和 "CPU load 返回 -1.0" 的诊断路径。
```

- 目标行数: 450+ lines

---

## §八 Prohibited（≥8）

- ❌ 只说 "jinfo modifies flags" 而不展示 WriteableFlags::set_flag 的三路汇合 — 必须展示 JMX/Attach/DCmd 三个入口的 origin 差异
- ❌ 不解释 set_flag_from_jvalue 的 7 种类型分发 — 必须展示 bool/int/uint/intx/uintx/uint64_t/ccstr 的完整分支
- ❌ 忽略 ccstr 类型的 JNI handle resolve — 必须展示 JNIHandles::resolve_external_guard + as_utf8_string + FREE_C_HEAP_ARRAY
- ❌ 不展示 DCmdFactory 单链表注册机制 — 必须展示 register_DCmdFactory 头插法 + _export_flags
- ❌ 不说 /proc/self/stat 的字段 23 是什么 — 必须展示 fscanf 格式串和 22 个 %* 跳过字段
- ❌ 忽略 CPU load 的两采样差值计算 — 必须展示 perfInit + get_cpuload_internal 的完整逻辑
- ❌ 忘记 /proc/self/fd 遍历的 fds-1 修正 — 必须解释 opendir 本身占用一个 fd
- ❌ 不展示 FileSystemImpl.c 的权限位检查 — 必须展示 S_IRGRP|S_IWGRP|S_IROTH|S_IWOTH
- ❌ 不做 GDB 断点 trace — 至少 5 个断点覆盖 flag 设置 → /proc 解析 → stat64
- ❌ 跳过 Heap dump 和 GC 扩展属性的 JNI 桥接 — 必须展示 HotSpotDiagnostic.c 和 GcInfoBuilder.c

---

## §九 Required（≥8）

- ✅ **★ Mermaid 三路 flag 设置序列图** — JMX/Attach/DCmd → WriteableFlags::set_flag → 7 类型分发
- ✅ **★ WriteableFlags 三路汇合对照表** — JMX vs Attach vs DCmd: setter, origin, param format
- ✅ **★ set_flag_from_jvalue 7 路类型分发完整源码** — writeableFlags.cpp:297-338
- ✅ **★ jmmVMGlobal struct 6 字段映射表** — type/origin/value/writeable/external/reserved
- ✅ **★ OS 指标 /proc 映射表** — /proc/self/stat(field23), /proc/self/fd, /proc/stat, sysinfo
- ✅ **★ CPU load 差值计算源码** — get_totalticks + get_cpuload_internal
- ✅ **★ 7 Beginner Callout 框** — exact text from §一
- ✅ **★ 面试 Story Format 答案** — §一末尾
- ✅ **★ GDB 断点 ≥5 条** — 精确到 file:line
- ✅ **★ 交叉引用** — 01 (JMM entry), 11 (OS layer), Attach API

---

## §十 GDB Verification（≥5 assertions）

```
断言 1: jmm_SetVMGlobal entry (management.cpp:1601)
  (gdb) break management.cpp:1601
  运行: JMX setVMOption("PrintGCDetails", true)
  (gdb) print flag_name → 期望: "PrintGCDetails"
  (gdb) continue → 进入 WriteableFlags::set_flag

断言 2: set_flag_from_jvalue type dispatch (writeableFlags.cpp:297)
  (gdb) break writeableFlags.cpp:297
  (gdb) print f->is_bool() → 期望: true (for PrintGCDetails)
  (gdb) print new_value.z → 期望: JNI_TRUE
  (gdb) continue → 进入 set_bool_flag

断言 3: get_totalticks /proc/stat parse (UnixOperatingSystem.c:78)
  (gdb) break UnixOperatingSystem.c:78
  (gdb) continue
  (gdb) print userTicks → 期望: >0
  (gdb) print systemTicks → 期望: >0
  (gdb) print idleTicks → 期望: >0

断言 4: getCommittedVirtualMemorySize0 (OperatingSystemImpl.c:213)
  (gdb) break OperatingSystemImpl.c:213
  (gdb) continue → fscanf /proc/self/stat
  (gdb) print vsize → 期望: >0 (进程虚拟内存字节)

断言 5: isAccessUserOnly0 stat64 (FileSystemImpl.c:56)
  (gdb) break FileSystemImpl.c:56
  (gdb) print path → 期望: management.properties 路径
  (gdb) continue → stat64
  (gdb) print sb.st_mode → 期望: 权限位
  (gdb) print (sb.st_mode & (S_IRGRP|S_IWGRP|S_IROTH|S_IWOTH)) → 期望: 0 (owner only)
```

---

## §十一 与 README 和同组 Prompt 的连续性

- 本文从 **README §四 文档规划** 的 04-os-flag-diagnostic.md 承接 — 覆盖 Flag/DiagnosticCommand/OS metrics/Agent
- **同组边界**:
  - 本文覆盖: Flag 管理、WriteableFlags 三路汇合、DCmd 命令执行、OS 指标查询、CPU load、Agent 权限检查
  - 04 ← 01 (management-jmm-interface): jmm_SetVMGlobal/jmm_ExecuteDiagnosticCommand 的 JMM 入口 → 本文展开 WriteableFlags/DCmd 后端
  - 04 → 02 (memory-pool-threshold): 无直接依赖，但共享 ServiceThread 基础设施
  - 04 → 03 (thread-monitoring): 无直接依赖
- 本文以 **§〇 的 jinfo 改 flag 失败 + CPU load -1.0** 作为生产场景

---

## §十二 Anti-Hallucination Checklist（生成后自检，必须逐项确认）

| # | 检查项 | 验证方式 |
|---|--------|---------|
| 1 | Flag.c getFlags line 82 | grep getFlags Flag.c |
| 2 | set_flag_from_jvalue 7 types = bool/int/uint/intx/uintx/uint64_t/ccstr | grep "is_bool\|is_int\|is_ccstr" writeableFlags.cpp |
| 3 | jmm_SetVMGlobal origin = JVMFlag::MANAGEMENT | grep MANAGEMENT management.cpp:1612 |
| 4 | attachListener origin = JVMFlag::ATTACH_ON_DEMAND | grep ATTACH_ON_DEMAND attachListener.cpp |
| 5 | /proc/self/stat fscanf format = 22 %* + 1 %lu (field 23) | grep "fscanf\|%lu" OperatingSystemImpl.c |
| 6 | /proc/self/fd 遍历 = opendir + readdir64 + fds-1 | grep "opendir\|readdir64\|fds" OperatingSystemImpl.c |
| 7 | /proc/stat fscanf = 7 fields (user/nice/system/idle/iowait/irq/sirq) | grep "fscanf.*cpu" UnixOperatingSystem.c |
| 8 | CPU load = (udiff + kdiff) / tdiff, clamp to [0,1] | grep "MIN\|udiff\|kdiff\|tdiff" UnixOperatingSystem.c |
| 9 | stat64 permission = S_IRGRP|S_IWGRP|S_IROTH|S_IWOTH | grep "S_IRGRP\|S_IWGRP\|S_IROTH\|S_IWOTH" FileSystemImpl.c |
| 10 | DCmdFactory register = 头插法 (_next = _list; _list = this) | grep "_next\|_list" diagnosticFramework.hpp |
| 11 | 文档中每个 file:line 引用都是真实行号 | 逐一 grep 验证 |
| 12 | §四 所有 9 组问题都有 Counterfactual 子问题 | 逐组检查 |
