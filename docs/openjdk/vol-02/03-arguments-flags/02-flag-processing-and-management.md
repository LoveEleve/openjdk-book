# 02. 一个 flag 的完整生命周期：从字符串到受控状态变更

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64` 讨论
> **前置依赖**：[01 — Flag 定义体系](01-flag-definition-system.md)：变量、元数据和约束记录从哪里来
> → **后续**：[04-logging — 日志系统](../04-logging/01-tag-and-selection.md)
> 关联域：01-os、35-dcmd、38-perfdata

## 一个 `-XX:` 参数为什么要经过这么多道门

命令行里写下：

```text
-XX:+UseG1GC
```

看起来只是把一个 bool 设成 `true`。

但 HotSpot 真正处理它时，至少要回答：

- 这个字符串来自哪里
- `UseG1GC` 是不是当前版本和平台存在的 flag
- 这个 flag 是否已解锁
- `+` 代表的值能不能转换成它的真实类型
- 这个值是不是用户显式设置过
- 后面的 ergonomics 能不能覆盖它
- 约束应该现在检查，还是等堆和线程初始化之后再检查
- 运行中是否允许 `jcmd` 再次修改它

所以 flag 的生命周期不是一次赋值，而是一条状态变更管线：

```text
来源
  → 文本解析
  → 查找 flag 元数据
  → 权限/解锁检查
  → 按类型写入变量
  → 记录 Origin
  → ergonomics 只在合适时机调整默认值
  → range/constraint 分阶段检查
  → 打印、查询或受限管理
```

这篇要讲清的不是某个 setter 的实现，而是：

**同一个 flag 如何在不同来源、不同阶段和不同权限下，仍然保持可预测、可追踪、可校验。**

---

## 一、四种入口，为什么只需要一个解析器

### 1.1 flag 不只来自命令行

HotSpot 启动时可能接收多类参数来源：

- JIMAGE 资源中的启动参数
- `JAVA_TOOL_OPTIONS`
- 命令行参数
- `_JAVA_OPTIONS`
- 配置文件或其他 JVM 内部入口

它们的共同点是：最终都要解释类似 `-XX:+UseG1GC` 的文本。

最容易想到的实现是每种来源单独写一套解析器：

```text
命令行解析器
环境变量解析器
配置文件解析器
JIMAGE 解析器
```

这会产生一个危险：同样的 flag 语法，在不同入口可能出现不同的：

- 别名处理
- 解锁规则
- 类型转换
- Origin 记录
- 错误信息

所以 HotSpot 选择让多个来源进入同一条解析管线，只把“这次值来自哪里”作为参数传进去。

### 1.2 `parse_each_vm_init_arg`：同一条路径，不同 Origin

`arguments.cpp:2216-2236` 附近可以看到不同参数来源调用解析入口时传入不同 Origin：

```cpp
parse_each_vm_init_arg(vm_options_args,
                       &patch_mod_javabase,
                       JVMFlag::JIMAGE_RESOURCE);

parse_each_vm_init_arg(java_tool_options_args,
                       &patch_mod_javabase,
                       JVMFlag::ENVIRON_VAR);

parse_each_vm_init_arg(cmd_line_args,
                       &patch_mod_javabase,
                       JVMFlag::COMMAND_LINE);

parse_each_vm_init_arg(java_options_args,
                       &patch_mod_javabase,
                       JVMFlag::ENVIRON_VAR);
```

这段代码的设计意图很清楚：

```text
解析逻辑相同
值来源不同
Origin 随输入一起传递
```

因此：

- `JAVA_TOOL_OPTIONS` 和命令行不是同一个 Origin
- 后续覆盖判断可以区分用户显式参数与环境注入参数
- 打印结果可以解释“当前值是谁设置的”

### 1.3 命令行优先级不是解析器自己猜出来的

来源被按启动流程送入解析器，Origin 被记录在 flag 元数据里。

当一个 flag 多次出现时，最终值如何处理，不应该靠某个入口解析器自己猜“我是不是优先级更高”，而由统一 flag 写入逻辑根据来源和当前状态处理。

这就是 Origin 的第一层作用：

**它不是日志标签，而是状态覆盖规则的一部分。**

---

## 二、文本解析：`+`、`-`、`=` 如何找到真正的变量

### 2.1 `Arguments::parse_argument` 是语义分派入口

`arguments.cpp:1034` 的 `Arguments::parse_argument` 负责处理 `-XX:` 形式的参数。

它要先区分几类文本：

```text
-XX:+Flag       bool true
-XX:-Flag       bool false
-XX:Flag=value  带显式值的 flag
```

然后把“flag 名称”和“字符串值”分离，交给类型对应的写入函数。

`arguments.cpp:857` 附近的 setter 会根据目标 flag 的类型调用：

- `JVMFlag::set_bool`
- `JVMFlag::set_intx`
- `JVMFlag::set_uintx`
- `JVMFlag::set_size_t`
- `JVMFlag::set_ccstr`

这一步必须区分两种转换：

```text
字符串语法解析
  → “+” 是 true，“-” 是 false，“=123” 是文本值

类型转换
  → 把文本值转成 bool/intx/size_t/ccstr
```

如果 `-XX:ObjectAlignmentInBytes=16` 最终写进了一个整数变量，那么真正的类型检查要由 `set_intx` 这类类型 setter 完成，而不是把所有参数先放进一个字符串 Map。

### 2.2 `find_flag`：先找到元数据，再决定能不能写

flag 名称查找由 `JVMFlag::find_flag` 完成，源码在 `jvmFlag.cpp:903-923` 附近。

它会遍历 `flagTable[]`，比较当前条目的名字：

```cpp
for (JVMFlag* current = &flagTable[0];
     current->_name != NULL;
     current++) {
  if (str_equal(current->_name,
                current->get_name_length(),
                name, length)) {
    ...
    return current;
  }
}
return NULL;
```

很多人会问：为什么不建 HashMap？

因为这个查找主要发生在 JVM 启动参数处理阶段，而不是业务热路径：

- flag 数量虽然很多，但启动期查找次数有限
- 线性扫描实现简单
- 表项天然已经按连续数组组织
- 查找过程中还可以顺手完成锁定状态和 product 构建过滤

源码在找到条目后还会检查：

- product 构建中是否应该隐藏 develop/notproduct flag
- diagnostic/experimental 等 flag 是否已经解锁
- 当前调用方是否允许看到 locked flag

所以 `find_flag` 不只是名字查找器，它还是第一道权限门。

### 2.3 diagnostic/experimental flag 为什么不能直接写

有些 flag 不是给普通启动参数随便修改的。

`jvmFlag.cpp:346-373` 附近会检查 locked flag，并要求先启用对应的解锁选项，例如：

```text
-XX:+UnlockDiagnosticVMOptions
```

如果没有解锁，`-XX:+某个 diagnostic flag` 不会因为名字存在就直接生效。

这体现了 flag 的两层身份：

- 元数据表告诉 JVM “它存在、它叫什么、它是什么类型”
- KIND/解锁逻辑告诉 JVM “当前调用者有没有资格使用它”

### 2.4 alias 和 obsolete flag：兼容性也在解析阶段发生

JVM 不能因为 flag 改过名字，就让所有旧启动脚本立即失效。

参数解析阶段还可能处理：

- 别名
- 已废弃参数
- 旧参数到新参数的转换
- 某些参数组合的联动

所以文本解析不仅是字符拆分，还承担 JVM 启动兼容性的一部分。

### 2.5 失败方案：字符串 Map

如果所有参数先放进：

```text
Map<String, String>
```

再由各个子系统自己读取，问题会变成：

- 类型检查分散
- diagnostic 权限分散
- Origin 丢失
- alias 逻辑散落
- 范围和约束无法统一安排

HotSpot 让解析尽早回到 `JVMFlag` 元数据和真实变量上，后面所有阶段都围绕同一个实体继续处理。

---

## 三、Ergonomics：JVM 什么时候可以替你做决定

### 3.1 没有显式设置时，JVM 会自己算

很多 flag 不设置时并不是简单使用一个固定常量。

例如 `ParallelGCThreads`，JVM 会根据当前可用 CPU 数做 ergonomics 推导。

`abstract_vm_version.cpp:366-402` 的 `nof_parallel_worker_threads` 使用了分段公式：

```cpp
if (FLAG_IS_DEFAULT(ParallelGCThreads)) {
  unsigned int ncpus =
      (unsigned int)os::initial_active_processor_count();
  threads = (ncpus <= switch_pt)
          ? ncpus
          : (switch_pt + ((ncpus - switch_pt) * num) / den);
}
```

G1 路径会用类似 `5/8` 的分数和阈值计算线程数。

这个公式不是 Java 规范，而是 HotSpot 当前实现中的工程折中：

- CPU 少时，线程数可以接近 CPU 数
- CPU 很多时，继续一比一增加 GC 线程的收益递减
- 过多线程会增加调度和同步成本

### 3.2 `FLAG_IS_DEFAULT`：用户写过的值不能被悄悄覆盖

Ergonomics 最重要的保护不是公式，而是：

```text
只有 flag 仍然是默认来源时，自动调优才可以改它
```

因此：

```text
用户显式设置 ParallelGCThreads=4
    → Origin/状态不再是 DEFAULT
    → ergo 不应把它改成自动计算值

用户没有设置
    → flag 保持 DEFAULT
    → ergo 可以根据 CPU 和 GC 选择值
```

如果没有这个保护，用户就无法相信自己的显式参数。

这也是为什么下面两种说法完全不同：

- “JVM 会自动计算 ParallelGCThreads”——有条件
- “JVM 总会覆盖用户设置”——错误

### 3.3 堆大小也是平台输入的消费方

`Arguments::set_heap_size` 位于 `arguments.cpp:1729` 附近。

它会根据 `MaxRAM`、物理内存和百分比参数计算默认堆边界：

```cpp
julong phys_mem =
    FLAG_IS_DEFAULT(MaxRAM)
    ? MIN2(os::physical_memory(), (julong)MaxRAM)
    : (julong)MaxRAM;

if (FLAG_IS_DEFAULT(MaxHeapSize)) {
  julong reasonable_max =
      (julong)((phys_mem * MaxRAMPercentage) / 100);
}
```

这里要和前面的平台探测篇连接起来：

- 平台探测提供可用 CPU 和内存输入
- flag 定义体系提供默认值、来源和约束
- ergonomics 根据这些输入修改仍处于默认状态的 flag

如果用户显式设置 `-Xmx` 或 `MaxHeapSize`，就不能把它和“自动计算默认堆”混成一条路径。

### 3.4 老参数转换：兼容性也属于 ergonomics

HotSpot 还会把一些旧参数转换成新的百分比参数，例如：

```text
MaxRAMFraction
    → MaxRAMPercentage = 100.0 / MaxRAMFraction
```

这类转换的价值不是让新代码更漂亮，而是让老启动脚本继续工作。

它也再次说明：

**一个 flag 的当前值，不只取决于命令行里有没有直接写同名参数，还可能来自旧参数转换和平台自适应。**

### 3.5 失败方案：ergo 无条件覆盖

如果 ergonomics 无条件写入：

- 用户显式设置的 GC 线程数会被覆盖
- 用户指定的堆大小会被改掉
- 调优结果和启动命令不一致
- `PrintFlagsFinal` 也无法解释为什么值变化

所以 `FLAG_IS_DEFAULT` 是 JVM 参数系统里的一个核心不变量：

**自动决策只能填补用户没有明确指定的空白。**

---

## 四、约束检查：为什么要等到不同阶段再判断

### 4.1 AtParse：现在就能知道的错误，马上拒绝

纯数值范围可以在参数解析时检查。

例如：

```text
ObjectAlignmentInBytes 必须位于 8..256
```

这种错误不依赖堆是否已经创建，也不依赖 GC 线程数量。

越早拒绝越好：用户输入错误时，不需要让 JVM 继续初始化一大段系统再报错。

### 4.2 AfterErgo：等自动调优完成再检查组合关系

有些约束依赖 ergonomics 的结果。

如果 parse 阶段看到的是默认值，但后面 `apply_ergo()` 会根据平台把它改掉，那么过早检查可能拿到一个还没有最终确定的值。

`Threads::create_vm()` 在 `Arguments::apply_ergo()` 后会执行范围和约束检查，源码线索在 `thread.cpp:3748-3757` 附近。

这时检查的已经是：

```text
用户参数
  + 旧参数转换
  + 平台 ergonomics
  → 最终准备进入 VM 的值
```

### 4.3 AfterMemoryInit：内存状态出来以后才能判断的约束

有些 flag 关系依赖：

- 堆大小
- Metaspace 初始化结果
- 压缩指针布局
- 内存页或地址空间状态

这类约束在 `universe_init`、Metaspace 初始化之后才有足够输入。

`jvmFlagConstraintList.hpp:54-61` 定义了三个阶段：

```cpp
enum ConstraintType {
  AtParse         = 0,
  AfterErgo       = 1,
  AfterMemoryInit = 2
};
```

它们不是重复检查，而是把约束放到“最早能够正确判断”的时间点。

### 4.4 range 和 constraint 的区别

可以把它们先粗略分成：

```text
range
  → 单个值的静态数值边界

constraint
  → 依赖平台、其他 flag 或初始化状态的动态条件
```

范围和约束的具体记录由 `jvmFlagRangeList`、`jvmFlagConstraintList` 维护，检查阶段再遍历执行。

所以解析器不需要知道所有 GC、内存和平台规则；它只负责把值放进 flag 系统，后面的阶段根据自己的状态执行对应检查。

### 4.5 失败方案：所有错误都在 parse 阶段检查

如果所有约束都提前到 parse：

- 依赖 ergonomics 的规则看不到最终值
- 依赖内存初始化的规则没有足够上下文
- 错误报告可能把合法的中间状态误判成非法

如果所有约束都拖到启动末尾：

- 简单范围错误反馈太晚
- 初始化成本已经付出
- 错误定位更困难

三个阶段的价值就在于：

**每类规则选择自己最早且足够准确的检查时机。**

---

## 五、打印与审计：Initial 和 Final 之间发生了什么

### 5.1 `PrintFlagsInitial`：看声明/解析后的早期状态

`-XX:+PrintFlagsInitial` 在参数处理路径中打印初始 flag 状态，源码在 `arguments.cpp:3681-3683` 附近。

它适合回答：

- 这个 flag 默认是什么
- 当前定义是否存在
- 解析早期看到的值是什么

### 5.2 `PrintFlagsFinal`：看 ergonomics 后的最终状态

`PrintFlagsFinal` 的具体触发与打印流程要和 `PrintFlagsInitial` 分开核对，不能把源码中相邻的 `PrintFlagsWithComments` 分支当成它的实现。稳定的使用语义是：在 VM 启动完成参数处理和 ergonomics 调整后，打印最终 flag 状态。

它适合回答：

- JVM 最后采用了什么值
- 哪些值被标成 `{ergonomic}`
- 用户命令行与自动推导之间有什么差异

因此两者的差异本身就是诊断信息：

```text
Initial：早期定义/解析状态
Final：自动调优和后续初始化影响后的状态
```

### 5.3 Origin 让最终值可解释

如果只打印最终值：

```text
ParallelGCThreads = 8
```

你仍然不知道它来自：

- 默认值
- 命令行
- 环境变量
- ergonomics
- 管理接口

Origin 把这条因果链保留下来，但它不是单独决定一切覆盖关系的唯一开关。更准确地说：命令行、环境变量、默认值、自适应赋值等流程会共同依据当前来源和默认状态决定是否允许覆盖。

因此 `PrintFlagsFinal` 的来源列不是装饰，而是 JVM 自适应行为的审计线索。

---

## 六、运行期管理：为什么 jcmd 只能改一小部分 flag

### 6.1 查询和修改是两条不同的路径

`jcmd` 可以查询 JVM flag，也可以尝试修改某些 flag。

这两件事不能混为一谈：

```text
VM.flags
  → 读取并打印当前 flag 状态

VM.set_flag
  → 请求修改某个 flag
  → 需要额外的 writeable 权限
```

`VM.flags` 由 `PrintVMFlagsDCmd` 等诊断命令处理；写入则进入 `WriteableFlags::set_flag`。

### 6.2 `WriteableFlags::set_flag`：先查找，再检查可写身份

`share/services/writeableFlags.cpp:243-265` 附近的核心逻辑是：

```cpp
JVMFlag* f = JVMFlag::find_flag((char*)name, strlen(name));
if (f) {
  if (f->is_writeable()) {
    return setter(f, value, origin, err_msg);
  } else {
    err_msg.print("only 'writeable' flags can be set");
    return JVMFlag::NON_WRITABLE;
  }
}
```

它至少有两道门：

1. 名字必须存在
2. flag 必须被定义为可写

`JVMFlag::is_writeable()` 在 `jvmFlag.cpp:398-399` 附近把可写身份归纳为：

- `manageable`
- product 且 `read_write`
- 扩展写入列表注册

这说明运行期管理不是“找到变量地址就能写”。

### 6.3 为什么 GC 算法类 flag 通常不能热改

有些 flag 只影响行为细节：

- 日志级别
- 某些阈值
- 输出路径

它们有机会在运行期安全修改。

另一些 flag 影响已经建立的结构：

- 使用哪个 GC
- 堆布局
- 压缩指针模式
- 编译器或代码缓存的结构

JVM 已经运行起来后，再把这些结构性开关改掉，等于要求整个运行时重新搭建自己。

因此“可管理”不是一个方便性标签，而是一个安全承诺：

**修改这个值之后，已有运行时结构仍然知道如何继续工作。**

### 6.4 运行期修改仍然要经过 setter，但不能把它简单描述成“自动重跑启动期全部约束”。

`WriteableFlags` 并不是绕过 flag 系统直接改内存：它先通过 `JVMFlag::find_flag` 找到表项，检查 `is_writeable()`，再按输入类型调用对应 setter，并使用新的 Origin 写入。具体 setter 还会执行可写状态检查；而启动期的 range/constraint 阶段与运行期可写 setter 是两套需要分别核对的机制。

因此运行期修改至少要面对：

- 类型转换
- writeable 检查
- setter 的可重复设置/只允许一次等规则
- 具体 flag 的副作用与线程安全
- 该 flag 是否有适用于运行期的额外校验或管理实现

“能被 jcmd 修改”只代表它通过了 flag 系统的可写门，并不代表任何修改都能立即无副作用地改变整个 JVM 行为。

---

## 七、收网：flag 的状态变更管线

现在把一条 flag 的完整生命史重新画一遍：

```text
命令行/环境/JIMAGE/配置来源
    │
    ▼
Arguments::process_argument
    │
    ├─ 拆出名字和值
    ├─ 传入 Origin
    └─ 进入 parse_argument
    │
    ▼
JVMFlag::find_flag
    │
    ├─ 查表
    ├─ 过滤/解锁检查
    └─ 找到真实变量地址和类型
    │
    ▼
JVMFlag::set_bool/set_intx/set_ccstr/...
    │
    ├─ 类型写入
    └─ 记录来源
    │
    ▼
Arguments::apply_ergo
    │
    └─ 只调整仍处于默认状态的 flag
    │
    ▼
范围/约束阶段检查
    │
    ├─ AtParse
    ├─ AfterErgo
    └─ AfterMemoryInit
    │
    ├─ PrintFlagsInitial/Final 查询
    └─ jcmd VM.set_flag 仅允许受控写入
```

所以这篇真正讲清的不是“参数解析有几个函数”，而是一个 flag 如何在 JVM 中保持可控：

- 来源被记录，不让覆盖顺序变成猜测
- 名字通过元数据表找到真实变量，不使用无类型字符串 Map
- setter 按真实类型写入
- ergonomics 只填补默认值，不悄悄推翻用户显式配置
- 约束在正确阶段检查，不把所有规则挤进 parse
- 运行期管理通过 writeable 分类限制热修改范围
- Initial/Final 输出让自动调整过程可观察

如果压缩成三句话：

1. flag 处理不是赋值，而是一条带来源、权限、类型和约束的状态变更管线。
2. `FLAG_IS_DEFAULT` 保护用户显式配置，分阶段约束保护不同初始化时机的合法性。
3. 查询可以广泛进行，修改必须受 `writeable` 身份限制；结构性 flag 不能因为有管理接口就随便热改。

下一篇进入日志系统：

```text
-Xlog:gc*=debug
```

这次不再是 flag 如何保存和修改，而是日志标签、级别和输出选择如何把运行时事件筛出来。

> → [04-logging/01-tag-and-selection.md](../04-logging/01-tag-and-selection.md)
