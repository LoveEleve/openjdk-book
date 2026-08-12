# 02. 输出与配置 — 从日志消息到 gc.log

> **前置依赖**:[01 — 标签与选择](01-tag-and-selection.md):标签、TagSet、选择器与六级级别
> → **后续**:[06-oops/01 — oop 与对象描述](openjdk/vol-02/06-oops/01-markoop-oopdesc.md)
> 关联域: 35-dcmd(VM.log 命令)、48-utilities(outputStream 抽象)

## 过滤器后面是什么

上一篇回答了 `-Xlog:gc*=debug` 的"选": 哪些消息、什么级别。但"选出来"不等于"看得见"——生产环境里 stdout 往往被 systemd 收走,GC 日志几天不看,文件已经涨到几个 GB。这篇把输出管道走完: 一条消息怎样同时落到 stdout 和文件、日志文件怎么轮转、以及为什么 `jcmd <pid> VM.log output=file=gc.log` 敲下去不需要重启,下一帧日志就换了去处。

## 1. 一个 TagSet,挂在多个输出上

### 1.1 场景: 同一句日志写两遍

调试时想让 gc 日志同时出现在终端(实时看)和文件(留档)——两个目标,一份 TagSet。这是 `LogTagSet` 里的 `_output_list` 字段(logTagSet.hpp:48)干的事。

### 1.2 写路径: 一条消息遍历一次链表

```cpp
// logTagSet.cpp:75-80(逐字)
void LogTagSet::log(LogLevelType level, const char* msg) {
  LogDecorations decorations(level, *this, _decorators);
  for (LogOutputList::Iterator it = _output_list.iterator(level); it != _output_list.end(); it++) {
    (*it)->write(decorations, msg);
  }
}
```

装饰对象构造一次,遍历输出链表逐个写。链表的形状值得看——它是有索引的排序单链表(logOutputList.hpp:33-41):

```cpp
// logOutputList.hpp:33-41(注释逐字)
// Data structure to keep track of log outputs for a given tagset.
// Essentially a sorted linked list going from error level outputs
// to outputs of finer levels. Keeps an index from each level to
// the first node in the list for the corresponding level.
// This allows a log message on, for example, info level to jump
// straight into the list where the first info level output can
// be found. The log message will then be printed on that output,
// as well as all outputs in nodes that follow in the list (which
// can be additional info level outputs and/or debug and trace outputs).
```

节点按"输出配置的阈值级别"排序: 阈值最粗(Error)的在头部,最细(Trace)的在尾部;`_level_start[LogLevel::Count]` 数组是每个级别的链表入口(logOutputList.hpp:55)。一条 info 消息调 `iterator(LogLevel::Info)`(logOutputList.hpp:135-138),从 `_level_start[Info]` 开始走到表尾——从这一节点起的所有输出,阈值都等于或细于 Info,也就是都接收这条消息;比 Info 更粗的 Warning/Error 输出在链头方向,一步跳过。选一次,写 N 个目标,级别语义天然成立。

- [C++: `LogOutput` 是抽象基类,两个纯虚 `write`(logOutput.hpp:100-101): 一个收单行字符串,一个收 LogMessageBuffer 迭代器(多行消息)。每个输出目标是一个子类实例——输出类型可扩展,链表与 TagSet 不感知具体输出]
- [C++: 迭代器带读者计数: 拷贝构造时 `increase_readers()`,析构时 `decrease_readers()`(logOutputList.hpp:100-116)。这解决"边写边改配置"的并发问题,见下]

### 1.3 关键设计 (斜体): *读不锁,配置侧等读者退场*

*配置变更(jcmd 改级别、删除输出)与日志写入并发发生。写路径不持锁: 进入时 `increase_readers()` 把 `_active_readers` 加一(logOutputList.hpp:135-137),退出时减一;删除节点前 `wait_until_no_readers()` 忙等读者数归零(logOutputList.cpp:44-49)——一次 write 的时间极短,忙等几乎不会真的空转;数归零才 `delete`。读不锁、写等读,每条消息的链表遍历零锁开销,热配置又不会留下悬垂指针。*

## 2. 一条消息怎么落盘

### 2.1 场景: 日志不能攒着

stdout/stderr/文件三类输出的基类是 `LogFileStreamOutput`——包着一层 `FILE*`(logFileStreamOutput.hpp:42-58)。它的 write 是这样(logFileStreamOutput.cpp:75-89):

```cpp
// logFileStreamOutput.cpp:75-89(截取核心,逐字)
int LogFileStreamOutput::write(const LogDecorations& decorations, const char* msg) {
  const bool use_decorations = !_decorators.is_empty();

  int written = 0;
  os::flockfile(_stream);
  if (use_decorations) {
    written += write_decorations(decorations);
    written += jio_fprintf(_stream, " ");
  }
  written += jio_fprintf(_stream, "%s\n", msg);
  fflush(_stream);
  os::funlockfile(_stream);

  return written;
}
```

每行: flockfile(stdio 的递归锁,多线程写同一 `FILE*` 不交错)→ 写装饰 → 写消息加换行 → **fflush** → funlockfile。

**关键设计 (斜体)**: *为什么每行都 fflush,不攒缓冲?因为 JVM 崩溃(segfault、OOM 死循环)时没人保证 C 库缓冲落盘——每行刷新,日志最多丢半行,而不是最后 4KB。代价是每行一次 write 系统调用;日志本就低频高价值,单行一次系统调用开销可忽略。*

- [POSIX: flockfile/funlockfile 是 stdio 的线程锁([man 3 flockfile]),与 JVM 自己的锁无关;os::flockfile 只是薄封装(os_posix.cpp:589-595)]
- [C++: 装饰排版 `write_decorations` 用 `[%-*s]` 逐个输出,`_decorator_padding` 记录每列历史最大宽度(logFileStreamOutput.cpp:53-73)——列对齐不是手算的,是运行时自动追宽]

### 2.2 512B 栈缓冲,超长再上堆

格式化入口在 `LogTagSet::vwrite`(logTagSet.cpp:110-139): 先往 512 字节的栈数组 vsnprintf;写不下才 `NEW_C_HEAP_ARRAY` 重新算长度再写(logTagSet.cpp:127-134)。

**关键设计 (斜体)**: *512B 覆盖绝大多数日志行,只有超长行才走 malloc。日志热路径上没有堆分配,就没有堆碎片、不扰动 GC;这与日志消息本身低频互补——调用次数少,单次要便宜。*

### 2.3 多行消息与旧接口适配

两个配套机制:

- **LogMessageBuffer**(logMessageBuffer.hpp:31-53): 一次要打多条、级别可能不同的行(如 GCTraceTime 的时间块),先攒进 buffer 再整体输出。它**不是**"1024B 栈上固定缓冲": 构造时指针全空,首次写入才 `initialize_buffers()` 堆分配 1024B 初始容量(logMessageBuffer.cpp:62-69),溢出按 2 倍 realloc(:29-37,:96-121)——消息再长也不截断,只是多分配一次。行级别不同,输出时按每个输出的阈值过滤行(`skip_messages_with_finer_level`,logMessageBuffer.cpp:71-77)。
- **LogStream**(logStream.hpp:34-55): `outputStream`(JVM 传统打印体系抽象,GC/JIT/class 加载打印都在用)到 ULF 的适配器。行缓冲 `LineBuffer` 内置 64B 小数组 `_smallbuf`——LogStream 在栈上时,小行直接攒在栈上,超长才 malloc(上限 1M 防泄漏,logStream.cpp:46-78);遇到 `'\n'` 才把整行交给日志管道(logStream.cpp:104-113),析构时把没换行的尾巴打出去(:116-121)。旧代码只需把 `tty->print(...)` 换成 `LogStream` 的写法,大量旧调用点就接进了新体系。

## 3. 文件输出: 命名、增长与轮转

### 3.1 场景: gc.log 无限膨胀

文件输出是 `LogFileOutput`(继承 LogFileStreamOutput)。三个常量决定默认行为(logFileOutput.hpp:42-46): 保留文件数 `DefaultFileCount = 5`、轮转阈值 `DefaultFileSize = 20 * M`、上限 `MaxRotationFileCount = 1000`。

### 3.2 文件名模板

文件名里的 `%p` 和 `%t` 是占位符(logFileOutput.cpp:35-43): `%p` = PID,`%t` = JVM 启动时间(`%Y-%m-%d_%H-%M-%S` 格式)。`make_file_name` 逐个替换(只替换**首个**出现的占位符,logFileOutput.cpp:359-440);两个字符串在 `LogConfiguration::initialize` 时由 `set_file_name_parameters` 填好(logFileOutput.cpp:54-63,logConfiguration.cpp:104)。

```cpp
// logFileOutput.cpp:35-39(逐字)
const char* const LogFileOutput::Prefix = "file=";
const char* const LogFileOutput::FileOpenMode = "a";
const char* const LogFileOutput::PidFilenamePlaceholder = "%p";
const char* const LogFileOutput::TimestampFilenamePlaceholder = "%t";
const char* const LogFileOutput::TimestampFormat = "%Y-%m-%d_%H-%M-%S";
```

于是 `-Xlog:gc*=debug:file=gc_%p_%t.log` 启动后真实文件名是 `gc_3725467_2026-08-12_09-30-00.log` 这个样子——同一目录跑多个 JVM,互不覆盖。

### 3.3 写与轮转: 记账、比较、换文件

每次写都记账并检查阈值(logFileOutput.cpp:273-289):

```cpp
// logFileOutput.cpp:273-289(截取核心,逐字)
int LogFileOutput::write(const LogDecorations& decorations, const char* msg) {
  if (_stream == NULL) {
    // An error has occurred with this output, avoid writing to it.
    return 0;
  }

  _rotation_semaphore.wait();
  int written = LogFileStreamOutput::write(decorations, msg);
  _current_size += written;

  if (should_rotate()) {
    rotate();
  }
  _rotation_semaphore.signal();

  return written;
}
```

`should_rotate()` 三个条件同时满足才转: filecount > 0、filesize > 0、`_current_size >= _rotate_size`(logFileOutput.hpp:71-73)。注意阈值不是"超了就把文件截掉",而是"写满后归档换新文件";信号量把写与转串行化,转的过程中不会有消息写到半截文件或已关闭的流。

`rotate()` 三步(logFileOutput.cpp:336-357): fclose 当前流 → `archive()`(把当前文件 rename 成 `gc.log.0` 这类编号,:309-324)→ 以追加模式 "a" 重新 fopen → 清零累计大小、编号加一(到 filecount 回绕 0,logFileOutput.hpp:75-80)。轮转期间日志会短暂不可写——被信号量挡住的消息在排队,不会丢。

**关键设计 (斜体)**: *轮转 = 归档 + 重建。rename 把当前文件原子地换成历史编号,新文件仍叫原名——旧日志完整保留(filecount 个历史),活跃文件永远叫同一个名字,`tail -f` 的读者不受影响。*

### 3.4 启动时的旧文件与特殊文件

`initialize` 时(logFileOutput.cpp:217-271):

- 目标已是 FIFO(命名管道): 强制 `_file_count = 0`,关掉轮转(:223-225)——管道没有"归档"的概念;
- 目标已存在且开了轮转: 先归档成 `.N` 再开新文件(:238-256)。`next_file_number` 在 0..filecount-1 里挑不存在的编号,全占满就挑最旧的(:110-157);
- filecount=0(用户显式关轮转)且目标是普通文件: 打开后立即 ftruncate 清空(:265-268)——语义变成"每次启动清空重写"。

### 3.5 手动轮转

jdk11u 里轮转触发只有两个: 自动(size 写满)+ 手动 jcmd。`jcmd <pid> VM.log rotate` 走 `LogConfiguration::rotate_all_outputs`(logConfiguration.cpp:584-589),对每个文件输出调 `force_rotate()`(logFileOutput.cpp:326-334)。

**这里要澄清一个流传很广的版本差异**: 常有人写"kill -USR2 触发日志轮转",但 jdk11u 里 SIGUSR2 只属于 Suspend/Resume 机制(os_linux.cpp:195 `SR_signum = SIGUSR2`),与日志无关。jdk11u 没有信号触发的日志轮转——想切轮转用 jcmd;想外部控制就用系统 logrotate 做 rename 归档,再发一次 `VM.log rotate` 让 JVM 打开新文件。

### 3.6 关键设计 (斜体): *换的是 FILE*,不是 fd*

*另一种常见描述是"内部用 `os::replace_fd`/dup2 原子替换文件描述符"——jdk11u 源码里没有这个调用。轮转实际是 FILE* 级别的关闭 + 重开(fclose/fopen)。文件描述符编号在 reopen 后可能变化,但写路径只认 FILE*,消息在信号量保护下不会落到旧流上;dup2 是为了让 fd **编号**不变的场景准备的,这里不需要。*

## 4. LogConfiguration: 一个引擎,两个入口

### 4.1 场景: 启动参数和 jcmd 敲的是同一套东西

`-Xlog:gc*=debug:file=gc.log` 在启动时解析,`jcmd <pid> VM.log what=gc*=debug output=file=gc.log` 在运行时解析——两者最终都进 `LogConfiguration::parse_log_arguments`(logConfiguration.cpp:403-459)。配置引擎不关心谁调用了它。

### 4.2 -Xlog 的四段拆解

arguments.cpp:2841-2861 把 `-Xlog` 交给 `parse_command_line_arguments`(logConfiguration.cpp:330-401): 按冒号切成最多 4 段(引号内的冒号跳过,Windows 盘符跳过):

```
-Xlog:gc*=debug:file=gc.log:uptime,level,tags:filesize=10m,filecount=5
      └what(选择)  └输出名   └装饰器        └输出选项
```

- 第一段 what: LogSelectionList 解析(上一篇);
- 第二段输出: 名字规范化——`gc.log` 自动补成 `file=gc.log`(`normalize_output_name`,logConfiguration.cpp:122-167);`#0` 表示按索引指输出(输出表 0=stdout、1=stderr,:108-110);
- 第三段装饰器: `LogDecorators::parse`;
- 第四段输出选项: filesize/filecount。filesize 用 `Arguments::atojulong` 解析,支持 K/M/G/T 后缀(arguments.cpp:786-827)。

`parse_log_arguments` 里,名字没找到就现场 `new` 一个 LogFileOutput 挂进输出表(logConfiguration.cpp:439-448);只有 `file=` 类型被支持,别的类型直接报 "Unsupported log output type"(:182-187)。

### 4.3 configure_output: 把配置刷到每个 TagSet

```cpp
// logConfiguration.cpp:216-227(截取核心,逐字)
void LogConfiguration::configure_output(size_t idx, const LogSelectionList& selections, const LogDecorators& decorators) {
  assert(ConfigurationLock::current_thread_has_lock(), "Must hold configuration lock to call this function.");
  ...
  LogOutput* output = _outputs[idx];

  output->_reconfigured = true;

  size_t on_level[LogLevel::Count] = {0};

  bool enabled = false;
  for (LogTagSet* ts = LogTagSet::first(); ts != NULL; ts = ts->next()) {
    LogLevelType level = selections.level_for(*ts);
```

配置的本质: **遍历全局 TagSet 链表,对每个 set 求出"这个输出在它上面是什么级别",写进它的 LogOutputList**(logConfiguration.cpp:216-274)。没有独立的"配置对象"——配置就是写进每个 TagSet 的数据结构,日志热路径每次读的就是这些结构,所以配置**下一帧即生效**: 不需要 flush 中间缓冲,不需要重启。

- [C++: 全程持 `ConfigurationLock`(信号量实现的锁,logConfiguration.cpp:55-78)。注释强调持锁期间线程禁止阻塞——配置时可能 new/delete 输出对象,而写路径不持锁,靠 §1.3 的读者计数保证安全]
- [C++: 多选择器语义: `LogSelectionList::level_for` 逐个尝试,**后命中的覆盖先命中**的(logSelectionList.cpp:92-103)。所以 `-Xlog:gc*=info,safepoint*=off` 里,带 safepoint 的日志被后一个选择器关掉;把 off 写在前面则无效]

### 4.4 关闭与旧旗标的收编

- `-Xlog:disable` 与 `jcmd VM.log disable` 同走 `disable_logging`(logConfiguration.cpp:294-300): 所有输出逐一下线——stdout/stderr 回到 "all=off",文件输出直接删除;
- 老日志旗标: `-XX:+TraceClassLoading` 这类在 Arguments 里有一张别名表(`aliased_logging_flags`,arguments.cpp:596-614),命中就打警告 "Will use -Xlog:... instead"(`log_deprecated_flag`,:996-1019),然后直接 `configure_stdout`(:1047/:1059/:1077);`-XX:+PrintGC/PrintGCDetails` 在 :3730-3745 各自转成 `gc`/`gc*` 的 stdout 配置;连 `-verbose:gc` 也是同一路径(:2405-2411)——全部以 stdout 为目标,跑的是同一个 `configure_output`。旧世界就这样整个搬进了新体系。

## 5. jcmd VM.log: 运行中的配置入口

`LogDiagnosticCommand` 是标准诊断命令(DCMD)的一个子类(logDiagnosticCommand.cpp:30-46)。7 个选项,与真实 JDK 的无参输出一致:

```
$ jcmd <pid> VM.log
Syntax : VM.log [options]

Options: (options must be specified using the <key> or <key>=<value> syntax)
	output : [optional] The name or index (#<index>) of output to configure. (STRING, no default value)
	output_options : [optional] Options for the output. (STRING, no default value)
	what : [optional] Configures what tags to log. (STRING, no default value)
	decorators : [optional] Configures which decorators to use. Use 'none' or an empty value to remove all. (STRING, no default value)
	disable : [optional] Turns off all logging and clears the log configuration. (BOOLEAN, no default value)
	list : [optional] Lists current log configuration. (BOOLEAN, no default value)
	rotate : [optional] Rotates all logs. (BOOLEAN, no default value)
```

`execute` 按选项分发(logDiagnosticCommand.cpp:64-96): disable → `disable_logging`;output/what/decorators 任一出现 → `parse_log_arguments`(与 -Xlog 同一入口);list → `describe`(遍历输出表逐个 describe,logConfiguration.cpp:481-491);rotate → `rotate_all_outputs`;什么都不给 → 打印用法。

命令在 `LogConfiguration::post_initialize` 注册(logConfiguration.cpp:86),由 `thread.cpp:3925` 触发;日志配置的初始化更早,在 `thread.cpp:3739` 的 `LogConfiguration::initialize`——JVM 一进入运行时,配置体系就已就绪。

- [实证: 素材库 `materials/commands/jcmd-VM.log.txt` 是真实 JDK 17.0.8.1 对无参 `VM.log` 的输出,选项清单与源码完全一致;[卷 T ch02](openjdk/vol-tools/ch02.md) 里 `VM.log` 一节有运行期配置示例]

## 6. 装饰器: 打印前的排版

### 6.1 12 种,不是 13

`DECORATOR_LIST`(logDecorators.hpp:41-53)一共 **12** 个: time、utctime、uptime、timemillis、uptimemillis、timenanos、uptimenanos、hostname、pid、tid、level、tags。默认开三个: uptime + level + tags(:72)。装饰的输出顺序固定按声明顺序(:56-58)——不是配置时的书写顺序。

### 6.2 一次生成,多处消费

装饰不是每条消息在每个输出各算一遍: `LogTagSet::log` 里构造一次 LogDecorations(logTagSet.cpp:76),写多个输出时复用;TagSet 侧维护的是**所有输出装饰器的并集**(`update_decorators`,logTagSet.cpp:58-64),每个输出只写自己的子集。时间戳的缓存是设计重点:

- 256B 栈缓冲,装饰文本拼在里面(logDecorations.hpp:33-35);
- `javaTimeMillis()` 每条消息至多调一次:`java_millis()` 把结果缓存进 `_millis`(logDecorations.cpp:61-66)——同一消息的多个输出、多行共用同一时间戳,时间线不抖;
- level 装饰不进缓冲,打印时才查名字(logDecorations.hpp:59-64,logDecorations.cpp:121-125)——因为多行消息里各行的级别不同;
- 输出侧 `[%-*s]` 对齐、`_decorator_padding` 追宽(logFileStreamOutput.cpp:53-73),列宽随内容自动增长。

**关键设计 (斜体)**: *装饰的构建成本与装饰数成正比,时间戳在消息内缓存一次,同一消息的多个输出、多行复用同一份结果;输出侧只做格式化拼接。在日志的低频高价值特性下,装饰层不会成为写盘路径的瓶颈。*

## 核心悬念

输出管道至此完整: 标签选择 → 级别过滤 → 多输出链表(读不锁、写等读)→ 装饰排版(消息级缓存)→ 文件轮转(rename 归档、无信号触发)→ 运行期热配置(一个引擎、-Xlog 与 jcmd 两个入口)。整个 logging 子系统 37 个文件、5,292 行,是 JVM 里典型的纯观测代码——不碰对象模型、不碰 GC 堆、不碰执行流,全部工作就是"把内部状态变成字符串,再挑个地方放下"。

但日志里那行 `[0.943s][info   ][gc     ] GC(0) ...` 报的,正是堆里对象的变化。对象在 JVM 里长什么样、对象头怎么编码、不同对象怎么分派——第 2 批的第 4 个域,从 06-oops 第一篇开始。

> → [06-oops/01 — oop 与对象描述](openjdk/vol-02/06-oops/01-markoop-oopdesc.md)
