# 02. 选中的日志怎么变成 `gc.log`？— 输出与配置

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64` 讨论
> **前置依赖**：[01 — 标签与选择](01-tag-and-selection.md)：标签、TagSet、选择器与级别阈值
> → **关联**：35-dcmd（`VM.log` 命令）、48-utilities（`outputStream` 抽象）

## 先回答“选中了”，再回答“写到哪里”

上一篇解决的是：

```text
-Xlog:gc*=debug
```

如何匹配带有 `gc` 标签的日志点。

但匹配成功只说明：

> 这条日志允许进入某个输出目标的级别范围。

它还没有回答：

- 输出目标到底是 stdout、stderr 还是文件？
- 同一条消息能不能同时写多个目标？
- `[0.943s][info][gc]` 这类前缀是谁生成的？
- 文件什么时候轮转？
- 运行中执行 `jcmd <pid> VM.log`，为什么不需要重启 JVM？

这篇把“选中之后”的管道走完。

先给完整链路：

```text
配置字符串
    ↓
解析 what / output / decorators / output options
    ↓
遍历静态 LogTagSet
    ↓
把每个输出对每个 TagSet 的 level 写入 LogOutputList
    ↓
日志到达 TagSet
    ↓
按 level 入口遍历多个 LogOutput
    ↓
构造 LogDecorations
    ↓
写入 FILE* / 文件，刷新流
    ↓
文件达到阈值时关闭、归档、重开
```

整篇最重要的一句话是：

**配置阶段把“哪些 TagSet 应该写到哪个输出、允许到什么级别”预先写进每个 TagSet 的输出索引；写入阶段不重新解析配置，只按索引找到输出并完成格式化。**

---

## 一、一个 TagSet 为什么可以同时挂多个输出

### 1.1 同一条 GC 日志，既要实时看，也要留档

调试 JVM 时很常见：

- 终端里实时看 GC
- 文件里保存完整记录

例如：

```text
-Xlog:gc*=debug:stdout -Xlog:gc*=debug:file=gc.log
```

这里用两次 `-Xlog` 配置把同一选择规则分别应用到 stdout 和文件输出；这不是“同一份日志先写 stdout，再由 stdout 重定向到文件”。

HotSpot 的模型是：

```text
一个 LogTagSet
  └─ 一个 LogOutputList
       ├─ stdout 输出对象
       └─ 文件输出对象
```

每个 `LogTagSet` 自己维护与输出对象的关联。输出目标不是日志消息临时决定的，而是在配置阶段写入 TagSet 的输出列表。

### 1.2 `LogOutputList` 是按级别组织的链表

`logOutputList.hpp:33-41` 对这个结构的描述是：

- 它为一个 TagSet 保存输出目标
- 节点按输出阈值从粗到细排序
- 每个级别有一个入口索引

可以把它抽象成：

```text
Error 输出
    ↓
Warning 输出
    ↓
Info 输出
    ↓
Debug 输出
    ↓
Trace 输出
```

假设某个 TagSet 配置了：

```text
stdout: warning
file: debug
```

那么一条 `info` 消息：

- 不应该写 stdout，因为 stdout 只接收 warning 及以上
- 应该写 file，因为 file 接收 debug 及以上

如果每次都从链表头开始检查所有输出，当然也能实现，但会重复做级别判断。

HotSpot 的做法是维护 `_level_start`：

```text
消息级别是 info
    ↓
直接跳到 info 入口
    ↓
遍历 info 以及更细的输出
```

这样更粗的 warning/error 输出已经在入口前被跳过，更细的 debug/trace 输出会被顺带访问。

### 1.3 “写一份消息，输出 N 份”

`LogTagSet::log` 的核心路径在 `logTagSet.cpp:70-80`：

```cpp
void LogTagSet::log(LogLevelType level, const char* msg) {
  LogDecorations decorations(level, *this, _decorators);
  for (LogOutputList::Iterator it = _output_list.iterator(level);
       it != _output_list.end(); it++) {
    (*it)->write(decorations, msg);
  }
}
```

这里有两个值得分开的动作：

1. 为这条消息构造一次 `LogDecorations`
2. 从合适的级别入口开始，依次调用多个输出对象的 `write`

所以一条消息可以同时进入：

- stdout
- stderr
- 一个或多个文件输出

而 TagSet 不需要知道输出对象的具体实现，只依赖 `LogOutput` 抽象接口。

### 1.4 配置变化时，正在写的输出怎么办

运行中可能发生这样的并发：

```text
线程 A：正在遍历 LogOutputList 并写日志
线程 B：通过 jcmd 删除或替换某个输出
```

如果线程 B 直接释放输出节点，线程 A 就可能继续访问悬空指针。

`LogOutputList::Iterator` 使用读者计数解决这个问题：

- 迭代器创建或复制时增加 active readers
- 迭代器销毁时减少 active readers
- 配置侧删除节点前等待读者归零

相关实现位于 `logOutputList.hpp:100-138` 和 `logOutputList.cpp:44-49`。

这不是把写路径变成一把大锁。它更接近：

```text
写入线程：登记自己正在读列表，然后无锁遍历
配置线程：修改前等待现有读者离开
```

因此两类同步职责是分开的：

- 写路径的迭代安全由 reader count 保护
- 配置数据结构的修改由配置侧同步机制保护

不能把它概括成“日志写入全程持 JVM 锁”。

---

## 二、一条消息怎样写进 stdout、stderr 或文件

### 2.1 三种流输出共享一条写入模型

stdout、stderr 和普通文件输出都可以通过 `LogFileStreamOutput` 这一层完成流式写入。

`logFileStreamOutput.cpp:75-89` 的核心顺序是：

```text
检查是否需要装饰
    ↓
锁住 FILE*
    ↓
写装饰器
    ↓
写空格、消息和换行
    ↓
fflush
    ↓
解锁 FILE*
```

源码核心可以概括为：

```cpp
os::flockfile(_stream);
if (use_decorations) {
  write_decorations(decorations);
  jio_fprintf(_stream, " ");
}
jio_fprintf(_stream, "%s\n", msg);
fflush(_stream);
os::funlockfile(_stream);
```

这里有三层边界不能混为一谈。

#### 第一层：`flockfile`

这是 C stdio 的流锁，防止多个 JVM 线程同时写同一个 `FILE*` 时互相交错。

它不是 Java 层的锁，也不是 `LogConfiguration` 的配置锁。

#### 第二层：`fflush`

`fflush` 把 C stdio 用户态缓冲刷新到对应的底层流。

它能降低“消息还停留在 stdio 缓冲区”的风险，但不等价于：

- `fsync`
- 存储设备已经持久化
- 机器断电后数据一定存在

所以应当把它准确描述成：

> 每行完成后刷新 C stdio 流。

不能把它夸大成“日志已经安全落盘”。

#### 第三层：输出对象的具体实现

`LogOutput` 是抽象接口。不同输出对象可以有不同的目标和附加行为，而公共写入层负责把装饰和消息写入对应流。

### 2.2 为什么 `LogTagSet::log` 先构造装饰，再写多个输出

一条消息可能同时写多个目标。如果每个目标单独构造时间、线程号、标签等信息，就会产生两个问题：

- 同一条消息在不同目标上的时间戳可能不一致
- 相同装饰被重复计算

因此 `LogTagSet::log` 先创建一次 `LogDecorations`，然后把它传给每个输出对象。

这个对象表达的是：

```text
这条消息自身的 level、TagSet 和已选中的装饰信息
```

输出对象只负责把自己需要的装饰字段写出来。

### 2.3 普通日志行的格式化缓冲

日志调用常常先经过 `LogTagSet::vwrite`。在 JDK 11u 中，它会先尝试使用固定大小的栈缓冲格式化消息；超出空间后再计算所需长度并分配更大的堆缓冲。

这条路径的设计目标是：

```text
常见短消息：不需要堆分配
异常长消息：允许 fallback，而不是截断
```

因此“日志写入不分配内存”不是无条件保证。更准确的表述是：

> 常见长度的格式化先走栈缓冲；超长消息会进入额外分配路径。

日志的详细实现仍然要和消息是否多行、输出对象是否需要额外状态分开看。

### 2.4 `LogMessageBuffer`：多行消息不是一条长字符串

有些调用点需要一次产生多行日志，且不同的行可能拥有不同级别。

`LogMessageBuffer` 的职责是：

- 暂存多条消息行
- 记录每行的 level
- 让不同输出按照自己的阈值跳过不应接收的行

它不是一个永远固定在栈上的 1024 字节缓冲。源码中的设计是：

- 初始状态不立即创建全部存储空间
- 首次写入时初始化缓冲区
- 需要更多空间时扩容

所以它解决的是“把多行消息作为一组交给输出层”，不是“保证所有消息都没有堆分配”。

### 2.5 `LogStream`：旧 `outputStream` 世界的适配器

HotSpot 里还有大量传统的 `outputStream` 调用点。`LogStream` 让这部分代码可以接入 Unified Logging：

```text
旧式 outputStream 写入
    ↓
LogStream 行缓冲
    ↓
遇到换行时提交给日志输出
```

它的关键语义是“按行提交”：

- 写入过程中先积累字符
- 遇到换行时把完整行交给日志系统
- 对没有换行的尾部，析构时也有收尾处理
- 超长行可以扩展缓冲，但有实现上的大小保护

因此 `LogStream` 不是另一套输出系统，而是把旧接口接进统一选择、装饰和输出管道的桥。

---

## 三、装饰器是排版层，不是选择层

### 3.1 标签决定“选不选”，装饰器决定“怎么显示”

这两个概念很容易混淆：

```text
标签 / level
  → 决定日志是否进入某个输出

decorator
  → 决定进入之后，行前面显示什么
```

例如：

```text
-Xlog:gc*=debug:file=gc.log:uptime,level,tags
```

这里：

- `gc*=debug` 是选择规则
- `file=gc.log` 是输出目标
- `uptime,level,tags` 是排版字段

装饰器不会扩大 `gc*` 的匹配范围。

### 3.2 JDK 11u 的装饰器集合

`logDecorators.hpp:41-72` 定义了当前实现支持的装饰字段，例如：

- `time`
- `utctime`
- `uptime`
- `timemillis`
- `uptimillis`
- `timenanos`
- `uptimenanos`
- `hostname`
- `pid`
- `tid`
- `level`
- `tags`

当前实现有默认装饰器组合；也可以用 `none` 清除装饰。

这里必须保留版本边界：

- 字段全集可能随 JDK 版本变化
- 默认组合可能变化
- 输出顺序由实现定义，不应假设完全按照命令行书写顺序重新排列

### 3.3 `LogDecorations`：一次生成，多处消费

当一个 TagSet 的消息要写多个输出时，`LogTagSet::log` 会先构造一个 `LogDecorations`，再传给每个输出。

TagSet 侧还会维护当前输出所需装饰器的合并结果，相关逻辑在 `logTagSet.cpp:58-64`。

可以把职责拆成两层：

```text
TagSet / LogDecorations
  → 准备这条消息可用的装饰值

LogOutput
  → 只写自己配置要求的字段
```

时间类装饰的计算结果可以缓存，避免同一条消息在多个输出上反复获取时间。

而 level 等部分值需要按行处理，因为多行消息中的每行可能有不同级别。

### 3.4 列对齐属于输出侧状态

文件/流输出在写装饰器时可以记录各列的历史最大宽度，从而让类似：

```text
[info   ]
[warning]
```

保持较稳定的列宽。

这不是日志选择逻辑，也不是 TagSet 的属性，而是具体输出对象的排版状态。

如果 stdout 和 file 使用不同装饰配置，它们可以拥有不同的排版结果；一条消息共享的是语义上的装饰数据，不是强制共享最终文本布局。

---

## 四、文件输出：从 `gc.log` 到历史归档

### 4.1 文件输出多了什么状态

`LogFileOutput` 在流输出之上增加了文件管理：

- 当前文件名
- 当前 `FILE*`
- 当前累计大小
- 轮转文件数量
- 轮转阈值
- 历史归档编号

JDK 11u 的默认值在 `logFileOutput.hpp:42-46` 定义，包括默认文件数量和默认大小；这些常量是实现细节，不能泛化成所有 JDK 版本的固定行为。

### 4.2 `%p` 与 `%t` 是文件名占位符

文件配置可以写成：

```text
file=gc_%p_%t.log
```

在 `logFileOutput.cpp:35-43` 的实现中：

- `%p` 替换为进程 PID
- `%t` 替换为 JVM 启动时间格式化结果

它们影响的是文件名，不是每行日志的装饰器。

例如多个 JVM 使用同一个模板时，可以得到彼此区分的文件名，而不是简单地全部打开同一个 `gc.log`。

占位符展开的具体替换次数、时间格式和异常路径都属于当前实现边界，应以对应版本源码为准。

### 4.3 自动轮转的基本链路

文件输出每次写入后会更新累计字节数，并判断是否满足轮转条件。核心过程可以概括为：

```text
等待轮转同步
    ↓
写入当前 FILE*
    ↓
累计 written
    ↓
检查 filecount、filesize 和当前大小
    ↓
需要时 rotate
    ↓
释放同步
```

轮转不是“到阈值时直接把当前文件截断”。更准确的过程是：

```text
关闭当前流
    ↓
把当前文件归档为带编号的历史文件
    ↓
以追加模式重新打开原文件名
    ↓
清零当前大小等状态
```

这样活跃文件仍然使用原来的名字，历史内容进入编号文件。

### 4.4 为什么轮转需要单独同步

写线程可能同时到达轮转检查：

```text
线程 A：写入并发现达到阈值
线程 B：也写入并发现达到阈值
```

如果两个线程同时关闭、归档和重开，文件状态会失序。

`LogFileOutput` 使用 `_rotation_semaphore` 把写入与轮转过程串行化。这里要准确理解它保护的范围：

- 防止文件输出的写入与轮转同时操作同一流状态
- 保证关闭、归档、重开过程不被另一个轮转并发打断

它不是整个 JVM 日志系统的全局锁，也不替代 `FILE*` 的流锁和配置侧同步。

### 4.5 启动时已有文件、FIFO 和 filecount=0

文件输出初始化时还要处理目标路径的不同状态：

- 目标是普通文件，且已有旧内容
- 目标是 FIFO/命名管道
- 用户关闭轮转
- 历史编号文件已经存在

这些分支不能用一句“打开文件并追加”概括。

当前 JDK 11u 代码对它们有专门处理，包含：

- 对 FIFO 不采用普通文件轮转语义，并把文件数量置为 0
- 已有普通文件且启用轮转时，先选择归档编号、归档旧文件，再打开活动文件
- `filecount=0` 时，普通文件打开后会执行 `ftruncate`，因此启动时会清空已有内容

具体行为以 `logFileOutput.cpp:217-271` 为准。尤其不要把 `filecount=0` 简化成所有版本都相同的“永远追加”或“永远不覆盖”。

### 4.6 自动轮转和手动轮转是两个入口

当前 JDK 11u 至少有两类轮转入口：

```text
自动：写入后达到大小阈值
手动：jcmd <pid> VM.log rotate
```

手动入口最终走 `LogConfiguration::rotate_all_outputs`，对支持轮转的文件输出执行强制轮转；`LogFileOutput::force_rotate` 在 `filecount=0` 时直接返回，因为此时没有可用的归档轮转配置。

还要特别保留版本边界：

- JDK 11u 的 `SIGUSR2` 是 Linux 线程挂起/恢复相关信号
- 不能把它写成当前 Unified Logging 的日志轮转信号
- 外部日志管理工具和 JVM 内部轮转是不同层次的机制

### 4.7 轮转换的是流，不要写成 fd 原子替换

当前 JDK 11u 的文件轮转实现是：

```text
fclose
    ↓
归档/rename
    ↓
fopen
```

因此应该描述为 `FILE*` 级别的关闭和重开。

不要无依据地写成：

- 使用 `dup2` 保持文件描述符编号
- 使用 `os::replace_fd` 原子替换 fd
- 所有读者都自动跟随旧 fd

这些是其他日志系统可能采用的策略，但不是这里已经核实的 JDK 11u 轮转路径。

---

## 五、`LogConfiguration`：`-Xlog` 和 `jcmd` 为什么能共用一套引擎

### 5.1 配置不是每次写日志时重新解释

如果每条日志都重新解析：

```text
-Xlog:gc*=debug:file=gc.log:uptime,level,tags:filesize=10m,filecount=5
```

那么写日志的热路径就会不断处理字符串、标签和文件参数。

HotSpot 的做法是把配置工作提前：

```text
配置阶段：解析并下发到每个 TagSet
写入阶段：直接读取 TagSet 当前的输出列表
```

所以配置的结果不是一棵只供查询的独立配置树，而是被落实到各个 TagSet 的 `LogOutputList` 中。

### 5.2 `-Xlog` 配置字符串的四个部分

`-Xlog` 的典型形式是：

```text
-Xlog:gc*=debug:file=gc.log:uptime,level,tags:filesize=10m,filecount=5
       └ what       └ output   └ decorators     └ output options
```

在 `logConfiguration.cpp` 的解析路径中，这些部分分别承担不同职责：

1. `what`：解析标签选择和 level
2. `output`：选择 stdout、stderr 或文件输出对象
3. `decorators`：解析每行要显示的字段
4. `output options`：解析文件大小、文件数量等输出参数

这四部分不是同一类配置：

```text
what             → 选择哪些 TagSet、什么级别
output           → 写到哪个输出对象
Decorators       → 行前显示什么
output options   → 输出对象如何管理文件
```

输出名还会经过规范化。一个普通文件名可以被识别为文件输出形式；已存在的输出对象则可以复用，而不是每次都盲目创建新对象。

### 5.3 `configure_output`：把选择结果写入所有 TagSet

`LogConfiguration::configure_output` 的关键工作在 `logConfiguration.cpp:216-274`：

```text
拿到一个输出对象
    ↓
遍历 LogTagSet::_list
    ↓
对每个 TagSet 调 selections.level_for(*ts)
    ↓
得到该输出在这个 TagSet 上的 level
    ↓
更新这个 TagSet 的 LogOutputList
    ↓
更新需要的 decorators
```

这一步是整个输出系统的桥：

- 上游是上一篇讲的选择器规则
- 下游是每个 TagSet 的实际输出链表

例如：

```text
what = gc*=debug
output = file=gc.log
```

配置阶段不会创建一个抽象的“未来 gc 日志订阅”。它会遍历已登记的 TagSet，并把命中的 level 直接写入对应 TagSet 的文件输出列表。

因此新配置的生效表现是：

```text
后续日志写入时读取新的 OutputList
```

而不是等待 JVM 重启后重新发现日志点。

### 5.4 配置锁和写路径保护不是一回事

配置阶段会使用 `ConfigurationLock` 保护配置引擎自身的变更。

但日志写路径不依赖持有这把配置锁来完成每条消息输出。写入侧还有：

- `LogOutputList` 迭代器的 reader count
- `FILE*` 的流锁
- 文件轮转自己的同步对象

它们分别解决不同问题：

| 机制 | 保护对象 |
| --- | --- |
| `ConfigurationLock` | 配置对象和输出表的修改过程 |
| reader count | 写线程遍历列表时输出节点不被提前释放 |
| `flockfile` | 同一 `FILE*` 的并发字符写入 |
| rotation semaphore | 文件流关闭、归档、重开的串行化 |

不能把这些锁合并成一句“日志系统有一把全局锁”。

### 5.5 `-Xlog:disable` 和旧日志参数如何进入同一体系

关闭日志时，`-Xlog:disable` 与 `jcmd VM.log disable` 进入统一的禁用路径，清理或关闭当前输出配置。

JDK 还需要兼容旧参数，例如旧的 GC 或类加载日志开关。它们在参数处理阶段被识别后，转换成对应的 Unified Logging 配置，再进入同一个配置引擎。

这带来的实际效果是：

```text
旧入口不同
    ↓
最终仍然写入同一套 TagSet / OutputList / Output 对象
```

所以旧 flag 不是绕过 Unified Logging 的第二条写入管道，而是兼容层入口。

---

## 六、`jcmd VM.log`：运行期配置的入口

### 6.1 它不是另一套日志系统

`LogDiagnosticCommand` 提供 `VM.log` 诊断命令。它的参数包括：

- `output`
- `output_options`
- `what`
- `decorators`
- `disable`
- `list`
- `rotate`

这些选项对应的不是一套独立实现，而是 `LogConfiguration` 已经提供的操作：

```text
VM.log what/output/decorators
    → parse_log_arguments

VM.log list
    → describe 当前输出配置

VM.log rotate
    → rotate_all_outputs

VM.log disable
    → disable_logging
```

### 6.2 为什么改完配置，下一条日志就可能换目标

因为运行期配置的核心动作是：

```text
遍历静态 TagSet
    ↓
更新每个 TagSet 的 LogOutputList
```

写入路径本来就从这个列表读取目标。因此配置更新完成后，后续日志可以直接看到：

- 新输出目标
- 新 level
- 新装饰器
- 文件输出的新参数

这不意味着正在执行的任意一条日志调用会被强行中断并重写。更准确地说：

> 配置变更在安全更新现有数据结构后，影响后续经过写路径的日志。

### 6.3 `list` 观察的是什么

`VM.log list` 通过配置引擎描述当前输出状态。它关注的是：

- 当前有哪些输出对象
- 每个输出配置了哪些选择器和装饰器
- 文件输出的相关选项

它不是把 JVM 所有历史日志重新读取出来，也不是扫描日志文件内容。

---

## 七、收网：配置索引与写入管道

把上一篇和本篇接起来：

```text
上一篇：选择层
  标签表达式 → LogSelection
  LogSelection → 某个 TagSet 的 level

本篇：输出层
  level + output → 写入 TagSet 的 LogOutputList
  日志到达 TagSet → 按 level 入口遍历输出
  输出对象 → decorations + message + flush
  文件输出 → 计数 + 阈值判断 + 轮转
  jcmd VM.log → 更新同一套配置结构
```

现在可以准确回答最开始的命令：

```text
-Xlog:gc*=debug:file=gc.log:uptime,level,tags:filesize=10m,filecount=5
```

它不是让每条 GC 日志临时解析一次完整字符串，而是：

1. 配置阶段把 `gc*` 转成选择规则
2. 遍历已注册的 `LogTagSet`
3. 对命中的 TagSet，把文件输出的级别写进 `LogOutputList`
4. 日志到达时，从对应 level 入口遍历文件输出
5. 使用指定 decorators 生成行前信息
6. 写入当前 `FILE*` 并刷新 C stdio 流
7. 达到文件阈值后执行关闭、归档和重开

这就是 Unified Logging 的输出边界：

```text
选择层决定“这条消息是否进入某个输出”
输出层决定“进入后如何排版、写流和管理文件”
```

两层之间通过每个 TagSet 的 `LogOutputList` 连接。

这也解释了为什么运行期 `jcmd VM.log` 能够生效：它改变的是这些已经存在的输出关联，而不是让日志点重新注册或让写路径重新解释整套命令行。
