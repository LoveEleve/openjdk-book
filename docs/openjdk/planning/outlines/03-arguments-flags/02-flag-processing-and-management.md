# 02. 解析 → Ergo → 约束 → jcmd — Flag 的完整生命周期

> 🔴 Deep | flag 处理与管理
> 读者处境: Flag 定义好了——启动时怎么从命令行字符串变成 C++ 值?运行时 jcmd 怎么改?
>
> ⚠️ 写作期修正(2026-08-12, vol-02/03-arguments-flags/02 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **ParallelGCThreads 公式不在 arguments.cpp:3700**——在 `Abstract_VM_Version::nof_parallel_worker_threads`(abstract_vm_version.cpp:366-402,ncpus<=8 → ncpus;否则 8+(ncpus-8)*5/8,注释含 72 CPU→48 的例子;calc_parallel_worker_threads@402 调 (5,8,8);G1 用 FLAG_SET_DEFAULT 落地,g1Arguments.cpp:80)
> - **堆自适应不是 RAMFraction**——jdk11u 用 **InitialRAMPercentage=1.5625/MaxRAMPercentage=25.0/MinRAMPercentage=50.0**(gc_globals.hpp:337/341/346);废弃的 *RAMFraction 自动转换(arguments.cpp:1735-1747);set_heap_size@1729(phys_mem=MIN2(physical_memory,MaxRAM)@1730-1732)
> - **"Flag_writelock mutex(jvmFlag.cpp:200)" 不存在**——jdk11u 无此锁,已删除
> - **"~28 个 flag" 无依据,删除**
> - find_flag 线性扫 ✓(jvmFlag.cpp:903-923,含 is_constant_in_binary 过滤 + locked flag 解锁检查 912-918);writeableFlags.cpp 在 share/services/(非 runtime/flags)

### 1. "命令行解析 — 一个解析器,四种来源"

**parse_each_vm_init_arg**(`arguments.cpp:2380`,origin 参数):
```
四种来源同解析器(arguments.cpp:2216-2236): JIMAGE_RESOURCE / ENVIRON_VAR(JAVA_TOOL_OPTIONS) / COMMAND_LINE / ENVIRON_VAR(JAVA_OPTS)
find_flag(jvmFlag.cpp:903-923): O(n) 线性扫 flagTable + is_constant_in_binary(product 过滤 develop/notproduct) + is_unlocked 检查(diagnostic/experimental 需 -XX:+UnlockDiagnosticVMOptions)
别名: obsolete/aliased 表(arguments.cpp:539-590)
聚合互斥: set_aggressive_opts_flags(arguments.cpp:1955)
```
- 关键设计: **一个解析器四种来源**——origin 决定优先级;线性扫够用(启动期一次)。

### 2. "Ergonomics — 平台自适应"

**ParallelGCThreads**(`abstract_vm_version.cpp:366-402`):
```
ncpus <= 8 → ncpus;否则 8 + (ncpus-8)*5/8(注释:"diminishing returns... 72 cpu → 48 worker")
calc_parallel_worker_threads = nof_parallel_worker_threads(5, 8, 8)(402);G1: FLAG_SET_DEFAULT(g1Arguments.cpp:80)
堆(set_heap_size, arguments.cpp:1729): phys_mem = MIN2(physical_memory, MaxRAM)(1730-1732)
  MaxHeapSize = phys_mem * MaxRAMPercentage/100(MaxRAMPercentage=25.0, gc_globals.hpp:337)
  InitialRAMPercentage=1.5625(gc_globals.hpp:346, = 1/64);MinRAMPercentage=50.0(341)
  废弃 flag 转换: *RAMFraction → 100.0/fraction(arguments.cpp:1735-1747)
```
- 关键设计: **公式 + Origin=ERGONOMIC + 兼容转换**三件套——"用户指定 > 平台自适应"由 Origin 保证。

### 3. "打印:PrintFlagsInitial vs PrintFlagsFinal"

**两个开关**(`arguments.cpp:3681-3683` + `3711`):
```
PrintFlagsInitial: 解析处打印 + vm_exit(3681-3683);PrintFlagsFinal: ergo 后打印(3711)
都是 JVMFlag::printFlags(jvmFlag.cpp:1488)
Initial vs Final 的 diff = ergo 行为审计({ergonomic} 标注)
```
- 关键设计: **两拍快照,差异即 ergo 决策**——黑盒自适应的可审计化。

### 4. "运行时管理:jcmd"

**VM.flags / VM.set_flag**(`diagnosticCommand.cpp:241-247` + `writeableFlags.cpp:243-265`):
```
PrintVMFlagsDCmd(diagnosticCommand.cpp:241,DCmd 工厂@82)
WriteableFlags::set_flag(writeableFlags.cpp:243-265): find_flag → is_writeable() 检查 → setter 分派
  → 只有 MANAGEABLE/product_rw 可改(分类即不变量);UseG1GC 结构性 flag 不可运行中改
  → set 触发约束/范围检查
```
- 关键设计: **"能改"= 行为开关,"不能改"= 结构决策**——分类写死不变量。

---

### 核心悬念

**"`-XX:+UseG1GC` 的一生: 四来源解析 → find_flag 线性扫 → set 分派 → ergo(5/8 公式 + 25% 堆)→ PrintFlagsFinal 审计 → jcmd 运行时改。flag 只是'值'——JVM 怎么用它控制输出?`-Xlog:gc*=debug` 的标签体系怎么过滤 60+ 种日志?"** — 下一篇: Logging。

> → [04-logging/01-tag-and-selection.md](../04-logging/01-tag-and-selection.md)
