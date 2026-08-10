# Arguments/Flags（参数标志）— 文章大纲

> vol-01 · 域 04 · 🟡 B | 拓扑排序 #4 | 基于 Pass 0+1 探索
> 依赖：OS 抽象层（容器感知影响 ergonomic 默认值）

## 叙事计划

**开篇场景**：你给 JVM 传了 `-Xmx2g -XX:+UseG1GC`，但 JVM 实际用了 4GB 堆——因为 Docker 限制了 8GB 内存，ergonomic 自动把 `Xmx` 放大到了 25%。你传的参数不一定等于最终生效的值——中间经过了解析、工效学调整、约束检查、范围验证四道关卡。

**第一层：JVMFlag——每个 -XX 标志的数据结构**

`JVMFlag`（`flags/jvmFlag.hpp`）只有三个核心字段：`_type`（类型字符串）、`_addr`（指向全局变量的指针）、`_name`（标志名）。类型系统：`bool` / `int` / `uint` / `intx` / `uintx` / `size_t` / `double` / `ccstr`——类型安全访问通过 `get_bool()` / `set_bool()` 等强类型方法，不通过 void* 裸指针。

`globals.hpp`（2835 行）用 `product(bool, UseG1GC, ...)` 宏声明所有标志——编译期展开为全局变量声明 + JVMFlag 注册。`develop` / `diagnostic` / `experimental` / `notproduct` 等宏控制标志的可见性层级。

**第二层：命令行解析管线**

`Arguments::parse_vm_init_args()`（`arguments.cpp:2196`）→ `parse_each_vm_init_arg()`（`:2380`）逐条处理命令行参数。`-X` 前缀（`-Xmx`、`-Xss`）先处理，`-XX:` 前缀（`-XX:+UseG1GC`）后处理——后面的可以覆盖前面的。环境变量 `JAVA_TOOL_OPTIONS`（`parse_java_tool_options_environment_variable`）也在这一步处理，优先级低于命令行显式传参。

**第三层：工效学——ergonomic 自动调整**

`Arguments::apply_ergo()`（`arguments.cpp:3963`）在 flag 解析之后运行——根据硬件环境和已设标志自动调整其他标志。典型规则：没设 `-Xmx` → 按 `(物理内存 * MaxRAMPercentage) / 100` 计算默认堆大小（`MaxRAMPercentage` 有默认值 `25.0`，`gc_globals.hpp:337`）、没选 GC → 自动选 G1。容器内存限制在此覆盖 `MaxRAM`（`arguments.cpp:1731`），ergonomic 用 cgroup 的 limit 而非物理内存计算 `Xmx`。

**第四层：约束检查——flag 组合不能自相矛盾**

`JVMFlagConstraintList::check_constraints()`（`flags/jvmFlagConstraintList.hpp`）在每个 flag 被设置后和 `AfterErgo` 阶段运行。约束函数是签名固定的回调：如 `ObjectAlignmentInBytesConstraintFunc` 检查对齐值是否是 2 的幂且在 8-256 之间。有两个时机：`AtParse`（解析时立即检查）和 `AfterErgo`（工效学调整后检查）。

**第五层：范围验证——flag 的值不能溢出**

`JVMFlagRangeList::check_ranges()`（`flags/jvmFlagRangeList.hpp`）验证 flag 值在允许范围内。每个 flag 可选配 `range(min, max)` 宏。范围检查在 `AfterErgo` 阶段执行——因为工效学可能把值推到范围外。

**第六层：写权限——Runtime 后还能改吗**

`JVMFlagWriteableList::mark_startup()`（`flags/jvmFlagWriteableList.hpp:53`）在 `Threads::create_vm` 末尾调用——之后大部分 flag 被锁定为只读。但 `manageable` 和部分 `diagnostic` 标志可以在 Runtime 通过 JMX 或 jcmd 动态修改——`is_writeable()` 返回 true。这是 `jcmd VM.set_flag` 能工作的基础。

**设计权衡**

一、宏声明 vs 配置文件。`product(bool, UseG1GC, ...)` 宏在编译期展开为类型安全代码——优于运行时解析配置文件，因为类型错误在编译期捕获。

二、工效学 vs 显式配置。ergonomic 减少了"必须给参数"的负担，但代价是用户难以预测最终生效的值——`-XX:+PrintFlagsFinal` 是唯一真相源。

三、约束函数 vs 内联检查。约束是独立注册的函数指针——不嵌在 flag 定义宏中。这样新增约束不需要改 flag 声明，但约束分散在多个源文件中。

## 核心悬念

**你传的 `-Xmx2g`，JVM 最终用了多少？中间经过了解析、工效学调整、约束检查、范围验证四道关卡——每一道都可能改变最终值。**

**→ 下一域**：参数生效了，但你怎么知道 JVM 内部在干什么？总不能一直 `jcmd VM.flags` 吧。JVM 需要一套统一日志——用标签和级别控制输出，一行 `-Xlog:gc+heap=debug` 搞定。Logging 篇见。

## 预估

1 篇，6 层递进，预估 2000-2500 行。
