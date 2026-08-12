# 02. Flag 的完整生命周期 — 从命令行到 jcmd

> **前置依赖**:[03-arguments-flags/01 — Flag 定义体系](01-flag-definition-system.md):变量/表/约束的三次展开
> → **后续**:[04-logging — 日志系统](openjdk/vol-02/04-logging/01-tag-and-selection.md)
> 关联域: 35-dcmd(jcmd 命令框架)、38-perfdata、01-os(cgroup 感知)

## 一个 flag 的五种命运

`-XX:+UseG1GC` 从命令行字符串到 C++ bool,再到运行中被 jcmd 修改——flag 的一生要经过:**解析**(字符串→值)→ **ergonomics**(平台自适应)→ **检查**(约束/范围)→ **打印**(PrintFlagsFinal)→ **管理**(jcmd 改值)。上一篇讲完了定义,这篇走完剩下的路。

## 1. 命令行解析:一个解析器,四种来源

### 1.1 场景:-XX:+UseG1GC 怎么变成 true

解析入口 `parse_each_vm_init_arg`(arguments.cpp:2380),它接受一个 `origin` 参数——**同一个解析器被四种来源调用**(2216-2236):

```cpp
// arguments.cpp:2216-2236(截取核心,逐字)
  jint result = parse_each_vm_init_arg(vm_options_args, &patch_mod_javabase, JVMFlag::JIMAGE_RESOURCE);
  ...
  result = parse_each_vm_init_arg(java_tool_options_args, &patch_mod_javabase, JVMFlag::ENVIRON_VAR);
  ...
  result = parse_each_vm_init_arg(cmd_line_args, &patch_mod_javabase, JVMFlag::COMMAND_LINE);
  ...
  result = parse_each_vm_init_arg(java_options_args, &patch_mod_javabase, JVMFlag::ENVIRON_VAR);
```

`JAVA_TOOL_OPTIONS`、`_JAVA_OPTIONS`(arguments.cpp:3317/3321 的环境变量解析)、命令行、JIMAGE 资源——**都走同一个解析器,只是 origin 不同**(01 篇的 9 级 Origin 在这里第一次被使用)。解析 `-XX:Flag=value` 时,字符串值按 flag 的类型交给 `JVMFlag::set_bool`/`set_intx`/`set_ccstr`(01 篇已证,经 `_addr` 写变量)。

flag 名字怎么找到?`JVMFlag::find_flag`(jvmFlag.cpp:903-923)是**线性扫描**整个 flagTable:

```cpp
// jvmFlag.cpp:903-923(截取核心,逐字)
JVMFlag* JVMFlag::find_flag(const char* name, size_t length, bool allow_locked, bool return_flag) {
  for (JVMFlag* current = &flagTable[0]; current->_name != NULL; current++) {
    if (str_equal(current->_name, current->get_name_length(), name, length)) {
      // Found a matching entry.
      // Don't report notproduct and develop flags in product builds.
      if (current->is_constant_in_binary()) {
        return (return_flag ? current : NULL);
      }
      // Report locked flags only if allowed.
      if (!(current->is_unlocked() || current->is_unlocker())) {
        if (!allow_locked) {
          // disable use of locked flags, e.g. diagnostic, experimental,
          // etc. until they are explicitly unlocked
          return NULL;
        }
      }
      return current;
    }
  }
  // JVMFlag name is not in the flag table
  return NULL;
```

**不用哈希表,就是 O(n) 线性扫**:flag 名可能带别名(use_parallel_old 等 obsolete 别名链,arguments.cpp:539-590 的别名表),线性扫描可以顺着表项继续。还顺带做了两道门:**product 构建里 develop/notproduct 不报告**(908-910)、**locked flag(diagnostic/experimental)未解锁时拒绝**(912-918——解锁靠 `-XX:+UnlockDiagnosticVMOptions`)。

- [C++: 聚合参数联动:`set_aggressive_opts_flags`(arguments.cpp:1955)——AggressiveOpts/AggressiveUnboxing 触发 EliminateAutoBox/DoEscapeAnalysis/AutoBoxCacheMax 等一组 flag 的联动(FLAG_SET_DEFAULT 保护:用户已设的值不动)]

**关键设计 (斜体)**: *"一个解析器,四种来源"是 origin 体系的第一站:同样的字符串,来源不同,优先级不同(环境变量 < 命令行)。find_flag 的"线性扫 + 顺带解锁检查"把查找、版本过滤、权限检查合成一趟——800+ flag 的线性扫在启动期只跑一次,不值得为此建哈希表。*

## 2. Ergonomics:平台自适应

### 2.1 场景:你没设 ParallelGCThreads,JVM 自己算

并行 GC 线程数由 `Abstract_VM_Version::nof_parallel_worker_threads` 决定(abstract_vm_version.cpp:366-402),注释里直接写了设计意图和例子:

```cpp
// abstract_vm_version.cpp:366-402(截取核心,逐字)
unsigned int Abstract_VM_Version::nof_parallel_worker_threads(
                                                      unsigned int num,
                                                      unsigned int den,
                                                      unsigned int switch_pt) {
  if (FLAG_IS_DEFAULT(ParallelGCThreads)) {
    assert(ParallelGCThreads == 0, "Default ParallelGCThreads is not 0");
    unsigned int threads;
    // For very large machines, there are diminishing returns
    // for large numbers of worker threads.  Instead of
    // hogging the whole system, use a fraction of the workers for every
    // processor after the first 8.  For example, on a 72 cpu machine
    // and a chosen fraction of 5/8
    // use 8 + (72 - 8) * (5/8) == 48 worker threads.
    unsigned int ncpus = (unsigned int) os::initial_active_processor_count();
    threads = (ncpus <= switch_pt) ?
             ncpus :
             (switch_pt + ((ncpus - switch_pt) * num) / den);
```

公式:**ncpus ≤ 8 → ncpus;否则 8 + (ncpus-8)×5/8**(`calc_parallel_worker_threads` 调 `nof_parallel_worker_threads(5, 8, 8)`,402 行)。G1 在初始化时用 `FLAG_SET_DEFAULT(ParallelGCThreads, ...)`(g1Arguments.cpp:80)把算好的值写进 flag。注释里的"diminishing returns"就是设计理由:超过 8 线程后 GC 线程间竞争加剧,收益递减,所以取 5/8 的分数。

堆大小同样自适应(`Arguments::set_heap_size`,arguments.cpp:1729 起):

```cpp
// arguments.cpp:1729-1751(截取核心,逐字)
void Arguments::set_heap_size() {
  julong phys_mem =
    FLAG_IS_DEFAULT(MaxRAM) ? MIN2(os::physical_memory(), (julong)MaxRAM)
                            : (julong)MaxRAM;

  // Convert deprecated flags
  if (FLAG_IS_DEFAULT(MaxRAMPercentage) &&
      !FLAG_IS_DEFAULT(MaxRAMFraction))
    MaxRAMPercentage = 100.0 / MaxRAMFraction;
  ...
  if (FLAG_IS_DEFAULT(MaxHeapSize)) {
    julong reasonable_max = (julong)((phys_mem * MaxRAMPercentage) / 100);
```

- `phys_mem` = `MIN2(os::physical_memory(), MaxRAM)`(1730-1732)
- **MaxRAMPercentage = 25.0**(gc_globals.hpp:337,即 Xmx 默认 ≈ 物理内存 1/4)、MinRAMPercentage = 50.0(341)、InitialRAMPercentage = 1.5625(346,即 1/64)
- 老 flag(DefaultMaxRAMFraction 等)自动转换:`MaxRAMPercentage = 100.0 / MaxRAMFraction`(1735-1738)

**关键设计 (斜体)**: *ergo 的"自适应"不是魔法,是三个机制的组合:① 公式(线程数 5/8 递减、堆 25% 上限);② **"用户指定 > 平台自适应"靠 FLAG_IS_DEFAULT 保护实现**——ergo 只在 flag 还是默认值时才 set(FLAG_SET_ERGO_IF_DEFAULT 宏,globals_extension.hpp:308-312;arguments.cpp 的调用点同样先查 FLAG_IS_DEFAULT),用户显式设过(origin 非 DEFAULT)就不覆盖;③ 老 flag 的兼容转换——宁可维护转换表,不让老启动脚本失效。*

## 3. 打印:PrintFlagsInitial vs PrintFlagsFinal

### 3.1 场景:两个开关,一次诊断

`-XX:+PrintFlagsInitial` 在参数解析处直接打印并退出(arguments.cpp:3681-3683);`-XX:+PrintFlagsFinal` 在 ergo 完成后打印(3711)。两者都调 `JVMFlag::printFlags`(jvmFlag.cpp:1488)。

**Initial vs Final 的 diff 是 JVM 调优最快的诊断**:Initial 是"声明值",Final 是"ergo 之后的值"——`{ergonomic}` 标注揭示 JVM 悄悄改了什么。典型场景:容器 CPU quota 变化后 GC 线程数从 8 掉到 2,`grep ParallelGCThreads` 的 Final 输出直接给出答案。

- [C++: printFlags 的输出格式 `bool UseG1GC = true {product} {command line}`——类型、当前值、分类、origin 一列排开;Final 模式带 `{ergonomic}` 标注标明改动来源]

**关键设计 (斜体)**: *"打印"是 flag 体系的自我暴露:两个开关把"声明"和"最终生效"各拍一张快照,差异即 ergo 的行为。这个设计把黑盒自适应变成了可审计的决策——配合 jcmd 的运行时查询,flag 的每个状态转移都有据可查。*

## 4. 运行时管理:jcmd

### 4.1 场景:跑着的 JVM,想关掉 PrintGC

jcmd 的 `VM.flags` 命令由 `PrintVMFlagsDCmd` 实现(diagnosticCommand.cpp:241-247,DCmd 工厂注册在 82 行);`VM.set_flag` 走 `WriteableFlags::set_flag`(writeableFlags.cpp:243-265——注意它在 share/services/,不是 runtime/flags):

```cpp
// writeableFlags.cpp:243-265(截取核心,逐字)
JVMFlag::Error WriteableFlags::set_flag(const char* name, const void* value, JVMFlag::Error(*setter)(JVMFlag*,const void*,JVMFlag::Flags,FormatBuffer<80>&), JVMFlag::Flags origin, FormatBuffer<80>& err_msg) {
  ...
  JVMFlag* f = JVMFlag::find_flag((char*)name, strlen(name));
  if (f) {
    // only writeable flags are allowed to be set
    if (f->is_writeable()) {
      return setter(f, value, origin, err_msg);
    } else {
      err_msg.print("only 'writeable' flags can be set");
      return JVMFlag::NON_WRITABLE;
    }
  }
  ...
```

**只有 `is_writeable()` 的 flag 能改**——writeable = MANAGEABLE 或 product_rw 分类(01 篇的 KIND_MANAGEABLE/KIND_READ_WRITE)。为什么?`UseG1GC` 这类"结构性" flag 改变需要重启 GC(对象管理方式全变,运行中不可行);而 `PrintGC`/`HeapDumpPath` 这类"行为性" flag 改了立即生效。运行时的 set 会触发约束/范围检查(01 篇的 AtParse 关卡在运行时也生效)。

**关键设计 (斜体)**: *"能改"与"不能改"的分类不是随意定的:MANAGEABLE = 行为开关(日志、路径、阈值),product = 结构决策(GC 算法、堆布局)。运行时可改的 flag 必须满足"改完即时安全"——这个不变量写在分类里,而不是写在每个 set 的 if 里。*

## 核心悬念

"从 `-XX:+UseG1GC` 的字符串解析,到 ergo 的自适应,到 PrintFlagsFinal 的审计,再到 jcmd 的运行时修改——flag 的一生走完。但 flag 只是'值',JVM 怎么用这些值控制**输出**?`-Xlog:gc*=debug` 的标签体系怎么过滤 60+ 种日志?下一篇:Logging——统一日志的标签与选择。"

> → [04-logging/01-tag-and-selection.md](openjdk/vol-02/04-logging/01-tag-and-selection.md)
