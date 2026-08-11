# 02. 一个 jcmd,管住整个 JVM — 万能诊断命令

> 🟢 工具域 | 工具: jcmd/jps/jstat | 关联 JVM 域: 35-dcmd、03-flags、25-gc、20-vm-ops、04-logging、10-metaspace、11-cds、34-nmt
> 读者处境: 你要写 DCmd(域 35)的文章——jcmd 就是 DCmd 的客户端,它的每个子命令背后都是一个诊断命令类。
> 修订: 2026-08-11 v3——补 VM.events/VM.log/VM.cds/VM.metaspace/ManagementAgent 分组及对应域

### 1. "jcmd 帮你看全貌" — 子命令清单

场景: 先 `jcmd <pid> help` 看这个 JVM 支持什么。

- **进程**: `jps -l`(全类名)/`jcmd`(列出所有 JVM)
- **实测(2026-08-11, TencentKona JDK 17): 50 个子命令**,分十组——
  - **JFR**: `JFR.start/dump/stop/check/configure`——录制控制(域 32)
  - **GC**: `GC.heap_info`(堆配置+使用)、`GC.class_histogram`(类直方图)、`GC.heap_dump`(转储)、`GC.run`、`GC.finalizer_info`(域 25/37)
  - **类**: `VM.class_hierarchy`(继承树)、`VM.classloader_stats`、`VM.classloaders`(域 07)
  - **线程**: `Thread.print`(全线程栈,含锁)(域 17/24)
  - **配置**: `VM.flags`、`VM.set_flag`(改标志)、`VM.system_properties`、`VM.command_line`(域 03/40)
  - **编译**: `Compiler.codecache`、`Compiler.codelist`、`Compiler.queue`、`Compiler.directives_*`、`Compiler.perfmap`(域 13/16)
  - **JVMTI**: `JVMTI.agent_load`、`JVMTI.data_dump`(域 28/47)
  - **管理**: `ManagementAgent.start/stop/status`、`ManagementAgent.start_local`(域 33)
  - **VM 内部(v3)**: **`VM.events`**(编译事件+VM 操作事件——**域 20 直接素材**,实测)、**`VM.log`**(Logging 配置——**域 04**)、`VM.cds`(域 11)、`VM.metaspace`(域 10)、`VM.native_memory`(NMT——域 34)、`VM.stringtable`/`VM.symboltable`/`VM.systemdictionary`(域 07)
  - **信息**: `VM.info`、`VM.uptime`、`VM.version`、`VM.dynlibs`(域 48/27)、`System.trim_native_heap`
- [Java: 每个子命令 = 一个 `DiagnosticCommand` 实现(域 35);jcmd 是它的标准客户端——和 Arthas 命令体系(AR-2 篇 1)是"两种命令框架"的对照]

关键设计: **DCmd = JVM 内置的"arthas"**: jcmd 的能力(类/线程/堆/编译)和 Arthas 高度重合(AR-0 的 thread/sc/jvm)——但 DCmd 是 JVM 自带的、无侵入的;Arthas 是外部增强的、更强的。写作域 35 时: DCmd 框架(jcmd→DiagnosticCommand→VM 操作)是主线,Arthas 命令体系是"另一个世界的对照"。

### 2. "输出怎么读" — 三个典型输出

场景: 写作要引用真实输出,先亲手抓三个。

- `jcmd <pid> VM.flags`: 全部标志(`-XX:+UseG1GC`...)——域 03 素材(标志系统)
- `jcmd <pid> GC.heap_info`: 堆配置(`garbage-first heap total 4096M`)+ 各代占用——域 25 素材
- `jcmd <pid> Thread.print`: 线程栈 + 锁信息(`locked:`/`waiting to lock:`)— 域 17 素材
- `jcmd <pid> Compiler.codecache`: 代码缓存分段使用——域 16 素材(v1 大纲写的 `Compiler.codelayout` 实测不存在,JDK17 为 `Compiler.codecache`+`Compiler.codelist`)
- **v3 新增**: `jcmd <pid> VM.events`(编译/VM 操作事件——域 20/13 素材,实测 20 条编译事件)、`jcmd <pid> VM.metaspace`(元空间使用——域 10)、`jcmd <pid> VM.log`(日志配置——域 04)
- `jstat -gcutil <pid> 1000`: 每秒各代使用率百分比——GC 趋势快照(底层读 PerfData——域 38)

关键设计: **快照 vs 趋势**: jcmd(单点快照)与 jstat(周期趋势)互补——写作域 25 时"GC 观察"可以引用 jstat 的连续采样 + JFR 的事件流(域 32)。

### 3. "对照与写作素材"

- **DCmd vs Arthas 命令**: jcmd 无侵入(JVM 内置)vs Arthas 增强(字节码);两个框架的设计对照(AR-2 篇 1 的注解驱动 vs DCmd 的注解驱动——**同思想两实现**)
- **VM.flags vs arthas vmoption**: 都能看/改标志(AR-0 篇 5)
- 写作素材: "jcmd 输出样例"是域 03/25/35 文章的标准实证

生产注意: jcmd 无侵入零开销(读类/标志);Thread.print 有短暂停顿(安全点,域 18 相关)。

---

跨域桥: 命令框架 = Arthas AR-2 篇 1(注解驱动对照);标志 = Arthas AR-0 篇 5(vmoption);GC 输出 = 写作域 25/26;线程栈 = 域 17。
