# 12 · OpenJDK 工程实践与源码推理：深度题目

## 1. 接手一个 HotSpot 问题，怎么在 5 分钟内找到对应的源码文件？

HotSpot 源码树有 4000+ 文件。面对一个崩溃、性能或功能问题，你希望在哪几个目录里找答案，而不是一个个翻？

回答必须覆盖：

- 按子系统划分的顶层目录：`share/gc/`、`share/oops/`、`share/classfile/`、`share/runtime/`、`share/opto/`、`cpu/`、`os_cpu/`、`os/`；
- 为什么 `share/` 是跨平台代码，`cpu/` 和 `os/` 是平台相关；
- 如何根据信号/崩溃地址快速定位到 `os_linux_x86.cpp` 中的信号处理器；
- 如何根据异常类型（`VerifyError`、`NullPointerException`、`StackOverflowError`）反推触发点；
- 如何利用 `jcmd <pid> Compiler.codelist` 和 `+PrintCodeCache` 定位 JIT 生成代码。

追问：如果问题在 `share/` 中没有平台相关实现，怎么快速判断它是否在 `cpu/` 或 `os_cpu/` 中有覆盖？`grep -r` 和 `git log --oneline` 的先后顺序为什么是“先 log 后 grep”？

## 2. 编译 OpenJDK 时，哪些文件是“人写的”，哪些是“生成出来的”？

`adlc` 生成的 `ad_<arch>.cpp`、`matching_<arch>.cpp` 等文件经常让初学者误以为它们是手写汇编。如何区分手写代码与生成代码？

回答必须覆盖：

- `src/hotspot/` 下的人写代码 vs `build/` 下的生成代码；
- `adlc` 从 `.ad` 文件生成 `ad_<arch>.cpp` 和 `matching_<arch>.cpp` 的流程；
- `globals.hpp` 中的 flag 定义如何通过 `jvmFlag` 宏系统被展开成解析、序列化和打印函数；
- 为什么 `jvm.h`/`jvm.cpp` 的 `JVM_*` 函数是 JDK 与 HotSpot 之间的编译契约；
- 为什么 `jvmti.xml` 是 JVMTI 的唯一来源，`jvmtiEnv.hpp` 和 `jvmtiEnter.cpp` 都是生成产物。

追问：如果你在调试时看到 `ad_<arch>.cpp` 中被 break 住，怎么知道它对应的是哪个 `.ad` 规则？`globs.hpp` 中的宏展开和 `jvmtiGen` 的 XSLT 生成有什么共同点？

## 3. 修改 HotSpot 后，如何验证你的修改没有引入性能回归？

HotSpot 的性能测试和功能测试不是同一套体系。你用什么来确认你的修改没有让 GC 暂停变长、编译变慢或吞吐下降？

回答必须覆盖：

- JTReg 测试分类：`hotspot/jtreg/` 下的 `test/` 目录；
- WhiteBox API 如何让测试代码直接调用 HotSpot 内部功能（如强制 GC、编译方法、设置 flag）；
- 性能回归测试与功能测试的区别：`-XX:+PrintGCApplicationStoppedTime` 和 `-XX:+PrintCompilation` 日志做前后对比；
- 使用 `-XX:+PrintCompilation`、`-XX:+PrintGCApplicationStoppedTime` 等标志做前后对比；
- 为什么微基准测试（JMH）比 main 方法更可靠，以及 JMH 如何避免 JIT 预热偏差。

追问：如果你的修改只改了 C2 的循环优化，你会用哪类测试来覆盖？为什么 `-XX:-TieredCompilation` 常用于编译测试？

## 4. 读 HotSpot 源码时，哪些宏和模式是“关键路标”？

HotSpot 大量使用宏和约定来隐藏重复代码。如果不认识这些模式，读源码会非常吃力。

回答必须覆盖：

- `JVM_ENTRY`/`JVM_LEAF`/`UNSAFE_ENTRY` 等入口宏的作用；
- `PRODUCT_RETURN`/`debug_only`/`NOT_PRODUCT` 等条件编译宏；
- `SCOPE_EXTEND`/`ResourceMark`/`HandleMark` 等 RAII 守卫；
- `TRAPS`/`CHECK`/`CHECK_` 等异常处理宏；
- `SHENANDOAH_ONLY`/`CMSGC_ONLY`/`INCLUDE_` 等 GC 条件编译宏。

追问：为什么 `TRAPS` 宏在函数签名中很常见？`debug_only` 包裹的代码在生产构建中会怎样？`SCOPE_EXTEND` 在调试编译器图时有什么用？

## 5. 从 JDK 8 到 11 到 17 到 21，哪些是影响最大的 HotSpot 结构变化，你必须知道？

如果你在面试中自称“熟悉 HotSpot”，面试官可能问“你理解哪个版本的 HotSpot？”

回答必须覆盖：

- JDK 8：PermGen 的最后一版，偏向锁默认开启，G1 不是默认 GC；
- JDK 11：G1 成为默认 GC，Metaspace 完全替代 PermGen，CDS 支持 AppCDS；
- JDK 17：偏向锁 JDK 15 起默认禁用，JDK 17 中的代码仍保留但默认关闭；ZGC 成为产品级，`-XX:+UseContainerSupport` 默认；
- JDK 21：虚拟线程（Project Loom）进入主线，分代 ZGC 作为实验性功能，G1 仍是默认 GC；
- 跨版本迁移时最需要验证的配置：GC 参数、模块访问、`--illegal-access` 行为的改变。

追问：如果只改一个启动参数让 JDK 8 应用在 JDK 17 上能跑，最常见的问题是什么？为什么偏向锁移除对低并发应用的影响比高并发应用更大？

## 6. 如果让你在 HotSpot 中加一个“新的诊断命令”（类似 `jcmd VM.info`），你需要修改哪些文件？

这不是一个“写代码”的问题，而是“理解 HotSpot 的 DCmd 框架如何扩展”的问题。

回答必须覆盖：

- `DCmd` 类继承：`DCmdWithParser` 或 `DCmd`；
- 注册方式：在 `diagnosticCommand.cpp` 的 `DCmdFactory` 注册表中添加；
- `DCmd_Source_Internal`/`AttachAPI`/`MBean` 的导出面控制；
- `CmdLine`/`DCmdArgIter` 的参数解析协议；
- `jcmd` 命令如何通过 `AttachListener` → `DCmd::parse_and_execute` 到达你的命令实现。

追问：为什么你的 DCmd 实现需要 `execute()` 方法，而参数解析在构造函数中完成？`DCmd_Source_AttachAPI` 和 `DCmd_Source_Internal` 的区别在生产环境中意味着什么？

## 7. 面对 OpenJDK 源码，你用什么原则判断“这段代码该读多深”？

OpenJDK 源码 4000+ 文件，不可能全部读完。你用什么标准决定哪些代码必须逐行理解，哪些只需知道“它做什么”？

回答必须覆盖：

- 性能关键路径（如 `InstanceRefKlass::oop_oop_iterate_discovery`、`OrderAccess::storeload`）必须逐行；
- 平台适配代码（如 `os_linux_x86.cpp` 的信号处理）只需知道分派逻辑；
- 生成代码（如 `ad_<arch>.cpp`）只需知道生成规则，不该逐行读；
- 测试代码阅读优先级低于核心功能代码；
- 从“hot path”和“不变量守护函数”开始读，而不是从“初始化代码”开始。

追问：如果时间只够读 10 个函数，是哪 10 个？`Universe::genesis`、`Threads::create_vm`、`SafepointSynchronize::begin` 为什么是优先候选？