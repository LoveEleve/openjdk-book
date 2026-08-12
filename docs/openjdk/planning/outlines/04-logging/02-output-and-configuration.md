# 02. Output + 运行时热配置 — 从 log message 到 gc.log

> 🔴 Deep | 13 KP 中的 2 个核心机制
> 读者处境: Tag 过滤出了该输出什么——但输出到哪?能不能在运行时切换输出目标?
>
> ⚠️ 写作期修正(2026-08-12, vol-02/04-logging/02 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **LogOutputList 不是"简单单链表"**: 是**按输出阈值排序的链表 + `_level_start[Count]` 级别入口数组**(logOutputList.hpp:33-46 注释,:55)——info 消息从 `_level_start[Info]` 开始走到表尾,阈值细于等于 info 的输出都命中;错误级输出在链头方向跳过。`write` 虚函数在 logOutput.hpp:100-101(:46 是 InitialConfigBufferSize)
> - **无锁读 + 读者计数**: 迭代器拷贝时 increase_readers/析构时 decrease_readers(logOutputList.hpp:100-116),删除节点前 wait_until_no_readers 忙等(logOutputList.cpp:44-49)
> - **`os::replace_fd`/dup2 编造**: jdk11u 全树无此调用。轮转 = fclose → archive(rename 成 .N,logFileOutput.cpp:309-324)→ fopen("a") 重开(logFileOutput.cpp:336-357);信号量 _rotation_semaphore 串行化写与转(:273-289)
> - **SIGUSR2 信号轮转不存在**: jdk11u 只有 size 自动轮转 + `jcmd VM.log rotate` 手动轮转(force_rotate,:326-334);SIGUSR2 是 Suspend/Resume 机制(os_linux.cpp:195)
> - **轮转默认值**: filecount=5、filesize=20M(logFileOutput.hpp:42-43),上限 MaxRotationFileCount=1000(:46);filesize 用 Arguments::atojulong 支持 K/M/G/T 后缀(arguments.cpp:786-827);fifo 目标强制关轮转(:223-225)
> - **parse 行号漂移**: parse_command_line_arguments 在 logConfiguration.cpp:330-401(冒号切 4 段: what/output/decorators/output_options,引号与 Windows 盘符跳过);parse_log_arguments 在 :403-459(输出名规范化 foo→file=foo :122-167;#N 索引 :425-430;new_output 仅支持 file= :178-196);configure_output :216-274 遍历全部 TagSet 求级别并写入各 set 的 OutputList
> - **jcmd VM.log 是 1 个 DCMD 的 7 个选项,不是子命令**: output/output_options/what/decorators/disable/list/rotate(logDiagnosticCommand.cpp:30-46),execute :64-96 分发;disable → disable_logging(:294-300);rotate → rotate_all_outputs(:584-589)
> - **装饰器 12 种不是 13**: DECORATOR_LIST 含 time/utctime/uptime/timemillis/uptimemillis/timenanos/uptimenanos/hostname/pid/tid/level/tags(logDecorators.hpp:41-53);默认 uptime+level+tags(:72);顺序固定按声明(:56-58)
> - **时间缓存**: java_millis() 每消息至多一次,缓存进 _millis(logDecorations.cpp:61-66)——不是 :83;装饰缓冲 256B(logDecorations.hpp:33)
> - **LogMessageBuffer 不是"1024B 栈缓冲+truncate"**: 懒堆分配初始 1024B,溢出 2 倍 realloc 不截断(logMessageBuffer.cpp:62-69,:29-37);LogStream 的 LineBuffer 才是 64B 栈小缓冲(上限 1M,logStream.cpp:46-78)
> - **落盘无 fsync/O_SYNC**: flockfile → 装饰 → jio_fprintf → 每行 fflush → funlockfile(logFileStreamOutput.cpp:75-89);flockfile 是 stdio 锁(os_posix.cpp:589-595)
> - **旧旗标收编**: aliased_logging_flags 表 arguments.cpp:596-614 → log_deprecated_flag(:996-1019)→ configure_stdout(:1047/:1059/:1077);PrintGC/GCDetails :3730-3745;-verbose:gc :2405-2411

### 1. "LogOutput — 多输出管道"

场景: 同一类日志 (gc+task)——同时输出到 stdout (调试) 和 gc.log (持久化)——两个目标,一个 TagSet。

**LogOutputList 多输出链表**(`logOutputList.hpp:33-46` + `logTagSet.cpp:75-80`):
- 每 TagSet 一个 LogOutputList(`_output_list`,logTagSet.hpp:48);log(level,msg) 构造一次 LogDecorations,遍历链表逐个 write
- 排序链表从 Error(头)到 Trace(尾),`_level_start[level]` 让消息从对应级别直接跳进链表(logOutputList.hpp:55,:135-138)——"一条 info 消息只经过阈值 <= info 的输出"
- 无锁读: 迭代器读者计数,删除前等读者归零(logOutputList.hpp:100-116,logOutputList.cpp:44-49)
- LogOutput 抽象接口: 两个纯虚 write(logOutput.hpp:100-101): 单行 + LogMessageBuffer 迭代器
- [C++: 配置热切换与写入并发的核心——读不锁、写等读;每 TagSet 的配置就是这份链表数据结构本身]

**LogFileStreamOutput**(`logFileStreamOutput.cpp:75-89`):
- flockfile → write_decorations(`[%-*s]` 对齐,_decorator_padding 追宽 :53-73)→ jio_fprintf("%s\n") → **每行 fflush** → funlockfile
- [C++: 每行 fflush 为崩溃不丢日志;无 fsync/O_SYNC(大纲旧稿的 fsync 描述不存在)]
- stdout/stderr 是两个固定实例(LogStdoutOutput 默认 all=warning/LogStderrOutput all=off,logFileStreamOutput.hpp:60-88)

**LogFileOutput**(`logFileOutput.hpp` + `logFileOutput.cpp`):
- 文件名模板: `%p`=pid、`%t`=启动时间(%Y-%m-%d_%H-%M-%S)(cpp:35-43),只替换首个占位符(cpp:359-440)
- 默认 filecount=5、filesize=20M(hpp:42-43);filesize 解析支持 K/M/G/T(arguments.cpp:786-827)
- write 记账: 信号量 → 写 → _current_size += → should_rotate(文件数>0 且 size>0 且 _current_size>=_rotate_size,hpp:71-73)→ rotate(cpp:273-289)
- rotate: fclose → archive(rename 到 .N,:309-324)→ fopen("a") → 计数回绕(hpp:75-80)(cpp:336-357)
- 启动旧文件: 归档再开(:238-256,next_file_number 挑空号或最旧 :110-157);fifo 强制关轮转(:223-225);filecount=0 且普通文件则 ftruncate(:265-268)
- 手动轮转: jcmd VM.log rotate → rotate_all_outputs(logConfiguration.cpp:584-589)→ force_rotate(cpp:326-334)
- [C++: 轮转是 FILE* 级 close+reopen,不是 dup2;POSIX rename 原子保证任意时刻磁盘上有活跃文件]
- [版本差异: jdk11u **没有**信号触发轮转(SIGUSR2 是 Suspend/Resume,os_linux.cpp:195)]

### 2. "LogConfiguration — -Xlog + jcmd 共用引擎"

场景: JVM 启动时 `-Xlog:gc*=debug:gc.log`——运行 3 天后想关掉。`jcmd <pid> VM.log disable`——同一个配置引擎。

**-Xlog 解析**(`arguments.cpp:2841-2861` → `logConfiguration.cpp:330-401`):
- `-Xlog:gc*=debug:gc.log:filesize=10m,filecount=5` 冒号切 4 段: what/output/decorators/output_options(引号内冒号、Windows 盘符跳过)
- parse_log_arguments(:403-459): 输出名规范化(foo → file=foo,:122-167)→ find 或 new_output(仅 file=,:178-196)→ configure_output(:216-274)→ notify_update_listeners
- configure_output 本质: 遍历全局 TagSet 链表,对每个 set 求级别并写入其 LogOutputList——配置即数据结构,下一帧生效,无需重启
- 多选择器: level_for 后命中覆盖先命中(logSelectionList.cpp:92-103)
- [C++: ConfigurationLock 信号量锁(:55-78),持锁期间禁止阻塞]

**jcmd VM.log 子命令**(`logDiagnosticCommand.cpp:30-46`,`execute` :64-96):
- 7 个选项: output/output_options/what/decorators/disable/list/rotate(素材 jcmd-VM.log.txt 实证一致)
- disable → disable_logging(:294-300);list → describe(:481-491);rotate → rotate_all_outputs(:584-589)
- 注册于 post_initialize(logConfiguration.cpp:86,thread.cpp:3925);初始化更早(thread.cpp:3739)
- [C++: jcmd 与 -Xlog 共享 parse_log_arguments——引擎不关心调用方;改完下一帧自动生效,无需 flush 中间缓冲]

**旧旗标收编**: aliased_logging_flags(arguments.cpp:596-614)→ 警告 + configure_stdout(:1047/:1059/:1077);PrintGC/GCDetails :3730-3745;-verbose:gc :2405-2411——全部走同一 configure_output

### 3. "LogDecorations — 12 种装饰 + 时间缓存"

**装饰器**(`logDecorators.hpp:41-53`):
- 12 种: time/utctime/uptime/timemillis/uptimemillis/timenanos/uptimenanos/hostname/pid/tid/level/tags;默认 uptime+level+tags(:72);顺序固定按声明(:56-58)
- 每条消息构造一次 LogDecorations(logTagSet.cpp:76),多输出复用;TagSet 维护全部输出装饰器的并集(update_decorators,logTagSet.cpp:58-64)
- 256B 栈缓冲(logDecorations.hpp:33-35);java_millis 每消息至多一次缓存(logDecorations.cpp:61-66);level 装饰打印时才查名(:121-125);输出侧 [%-*s] 对齐追宽(logFileStreamOutput.cpp:53-73)
- [C++: 消息级缓存——同一消息多输出/多行共享时间戳,不重复调时钟]

**LogMessageBuffer**(`logMessageBuffer.hpp:31-53` + `logMessageBuffer.cpp`):
- 懒堆分配初始 1024B(initialize_buffers :62-69),溢出 2 倍 realloc(:29-37,:96-121),不截断
- 多行不同级别;输出时按输出阈值过滤行(skip_messages_with_finer_level,:71-77)
- [C++: 与大纲旧稿"栈上 1024B+truncate"相反——真实机制是惰性堆分配 + 增长]

**LogStream 适配**(`logStream.hpp:34-55` + `logStream.cpp`):
- outputStream 传统 API → ULF 适配;LineBuffer 64B 栈小数组,超长才 malloc(上限 1M,:46-78)
- 遇 '\n' 才交整行给日志管道(:104-113),析构清尾(:116-121)
- [C++: 兼容层——GC/JIT/Class 旧打印代码改传 LogStream 即接入 ULF]

---

### 核心悬念

**"怎么在不停 JVM 的情况下让所有 GC 日志从 stdout 切换到 gc.log？"** — `jcmd <pid> VM.log output=file=gc.log`——configure_output 把新配置写进每个 TagSet 的 OutputList,下一帧日志开始投到新文件;想轮转就 `VM.log rotate`。`-Xlog` 和 jcmd 共享引擎——配置引擎不关心"谁调用了我"——只做 configure_output。tag+selection+output 三层的完全解耦让运行时热配置成为可能。

> → domain 6: [oops — 对象模型](.../06-oops/01-markoop-oopdesc.md)
