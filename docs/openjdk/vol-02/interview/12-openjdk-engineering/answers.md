# 12 · OpenJDK 工程实践与源码推理：专家答案锚点

## 1. HotSpot 源码树的目录结构已经把“在哪找什么”画好了

HotSpot 的 `src/hotspot/` 按“share（跨平台）、cpu（ISA 相关）、os（操作系统抽象）、os_cpu（组合平台）”组织。GC 相关在 `share/gc/`，JIT 在 `share/opto/` 和 `share/c1/`，对象模型在 `share/oops/`，类加载在 `share/classfile/`，运行时在 `share/runtime/`，工具在 `share/services/`。

根据信号类型（如 `SIGSEGV`）可以快速定位到 `os_cpu/linux_x86/os_linux_x86.cpp` 的信号处理器；根据异常类型（如 `VerifyError`）反推到 `verifier.cpp`。`git log --oneline` 优先于 `grep -r`，因为 log 提供的是“什么提交改变了这个行为”，而 grep 只是“哪些文件包含这个字符串”。

## 2. 生成代码是 OpenJDK 构建系统的核心特征

`adlc` 从 `.ad` 文件生成 `ad_<arch>.cpp` 和 `matching_<arch>.cpp`。`.ad` 是手写的架构描述语言，`.ad` 文件描述指令模式、寄存器分配和匹配规则，`adlc` 将其编译成 C++ 代码。`jvmti.xml` 是 JVMTI 的唯一来源，通过 XSLT 生成 `jvmtiEnv.hpp`、`jvmtiEnter.cpp` 等文件。

`globals.hpp` 中的 flag 宏定义（如 `product(bool, ...)`）被 `jvmFlag` 宏系统展开成解析、序列化和打印函数。这些生成代码与人写代码的区别在于：生成代码不应被手改，而应修改其来源文件。

## 3. HotSpot 的验证体系需要分层：功能测试、WhiteBox、性能基准

功能测试走 JTReg（`hotspot/jtreg/`），但 JTReg 主要验证正确性，不擅长验证性能。性能验证需要：

- `-XX:+PrintCompilation` 观察编译行为变化；
- `-XX:+PrintGCApplicationStoppedTime` 或 JFR 的 safepoint 事件观察暂停变化；
- JMH 微基准测试避免 JIT 预热偏差；
- `-XX:-TieredCompilation` 常用于编译测试，因为强制只使用 C2 编译，排除 C1 干扰。

WhiteBox API 让测试代码直接调用 HotSpot 内部功能（如 `WB.forceCompile`、`WB.fullGC`），是功能测试和性能测试之间的桥梁。

## 4. HotSpot 的宏模式是“约定大于配置”的工程实践

`JVM_ENTRY`/`JVM_LEAF` 是 VM 入口宏，`JVM_ENTRY` 做线程状态转换，`JVM_LEAF` 不做（用于 `currentTimeMillis` 等极简函数）。`PRODUCT_RETURN`/`debug_only`/`NOT_PRODUCT` 是条件编译宏，`debug_only` 包裹的代码在生产构建中消失。

`TRAPS`/`CHECK`/`CHECK_` 是异常处理宏：`TRAPS` 声明线程句柄，`CHECK` 检查异常并返回，`CHECK_` 返回指定值。`ResourceMark`/`HandleMark` 是 RAII 守卫，管理 Arena 和 Handle 的局部生命周期。`SHENANDOAH_ONLY`/`CMSGC_ONLY` 等 GC 条件编译宏让代码在包含/不包含某 GC 的构建中自动适配。

## 5. 版本迁移的最常见陷阱是“默认值和行为改变，参数却未更新”

JDK 8→11：PermGen 已不存在，`-XX:PermSize`/`-XX:MaxPermSize` 被忽略，Metaspace 参数接管。G1 代替 CMS 成为默认 GC。`--illegal-access=permit` 过渡模式允许反射访问非导出模块。

JDK 11→17：偏向锁 JDK 15 默认禁用、JDK 17 代码保留但默认关闭，JDK 18 才彻底移除实现；`-XX:+UseBiasedLocking` 逐渐失效。ZGC 成为产品级。`-XX:+UseContainerSupport` 默认开启，容器内存/CPU 限制自动识别。

JDK 17→21：虚拟线程进入主线；分代 ZGC 作为实验性功能；G1 仍为默认 GC。`--illegal-access` 不再支持 permit，反射访问非导出模块直接失败。

偏向锁移除对低并发应用影响更大的原因是：低并发下偏向锁的“偏向”几乎总是命中，移出后每次同步都要走 CAS 轻量锁路径；高并发下偏向锁频繁撤销，原本就主要走轻量锁或重量锁路径。

## 6. 扩展 DCmd 需要修改三类文件：命令类、注册表和导出面

1. 继承 `DCmd` 或 `DCmdWithParser`，实现 `execute()` 方法；
2. 在 `diagnosticCommand.cpp` 的 `DCmdFactory` 注册表中添加工厂；
3. 设置 `DCmd_Source_Internal`/`AttachAPI`/`MBean` 控制导出面。

`execute()` 方法在构造函数完成参数解析后执行，参数解析在构造函数中完成，这样 `execute()` 可以专注于业务逻辑。`DCmd_Source_Internal` 命令只能通过 VM 内部代码调用，`DCmd_Source_AttachAPI` 可通过 `jcmd` 调用，`DCmd_Source_MBean` 可通过 JMX 调用。生产环境中，Internal 命令用于自检，AttachAPI 命令用于运维。

## 7. 读源码的深度决策：哪条路径是性能关键或不变量守护

性能关键路径（如 `InstanceRefKlass::oop_oop_iterate_discovery` 的引用发现、`OrderAccess::storeload` 的屏障）必须逐行理解，因为它们在每次操作中执行，错误代价极高。

平台适配代码（如 `os_linux_x86.cpp` 的信号处理）只需知道分派逻辑，因为它们是桥接代码，核心逻辑在 `share/` 中。

生成代码不应逐行读，而应读生成规则。测试代码优先级低于核心代码。优先读的函数是“hot path”和“不变量守护函数”——如 `Universe::genesis`（启动期不变量）、`Threads::create_vm`（启动顺序）、`SafepointSynchronize::begin`（全局协调）。

## 评分锚点

- **合格**：能说清源码目录结构、生成代码概念、JTReg 测试、JDK 8→11→17 的主要差异。
- **良好**：能解释入口宏、条件编译、DCmd 扩展步骤、WhiteBox 用途；能说出偏向锁移除的影响。
- **专家级**：能用“性能关键路径不变量守护函数”的优先级判断读源码的深度，并能设计一个完整的 DCmd 扩展方案。