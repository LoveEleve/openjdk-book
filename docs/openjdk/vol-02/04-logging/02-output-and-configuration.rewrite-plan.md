# 04-logging/02-output-and-configuration 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释日志完成 TagSet 选择后，如何通过输出链表、装饰器、文件输出和配置引擎变成可观察的日志流

## 1. 选题判断

本篇继续保留为独立专题，但不再按 `logFileOutput.cpp` 的源码顺序罗列接口。

统一问题：

**一条已经被 TagSet 选中的日志，如何同时写到 stdout、stderr 或文件？配置为什么能在运行期通过 `jcmd VM.log` 改变？文件轮转如何避免写到已关闭的流？**

## 2. 一句话顿悟

**Unified Logging 把“选中哪些日志”和“写到哪里”拆成两层：配置阶段遍历静态 TagSet，把每个输出的级别写入对应的 `LogOutputList`；写入阶段只从目标级别的链表入口开始遍历，并在输出对象内部完成装饰、刷新与文件轮转。**

## 3. 结构大纲

### 第一节：事故开场——选中了，不等于看得见

- `-Xlog:gc*=debug:file=gc.log` 的四个问题：谁接收、写几份、带什么前缀、何时换文件
- 选择层与输出层的边界
- 主链路预览：配置 → TagSet → OutputList → decorations → stream/file

### 第二节：一个 TagSet 如何挂多个输出

- `LogTagSet::_output_list`
- `LogOutputList` 按输出阈值排序
- `_level_start` 让消息从合适级别入口开始
- 一条消息为什么可同时写多个目标
- 迭代器 reader count 与配置删除的安全边界

### 第三节：一行消息如何写入流

- `LogTagSet::log` 生成 `LogDecorations`
- `LogFileStreamOutput::write`
- `flockfile`、写装饰、消息、换行、`fflush`
- stdout/stderr/file 流输出的共同基类
- 512 字节格式化栈缓冲与超长消息 fallback
- `LogMessageBuffer` 和 `LogStream` 的边界：多行与旧 `outputStream` 适配

### 第四节：装饰器不是日志选择器

- `LogDecorators` 的可选字段
- 默认装饰器与 `none`
- `LogDecorations` 一次构建、多输出复用
- 时间戳缓存、level 动态读取、输出侧列宽
- 配置顺序与实际输出顺序的边界

### 第五节：文件输出与轮转

- `LogFileOutput` 的默认 filecount/filesize
- `%p`、`%t` 文件名展开
- 当前文件、历史文件和 archive 编号
- 写入后计数、阈值判断、关闭/归档/重开
- `_rotation_semaphore` 的串行化作用
- FIFO、filecount=0、启动时已有文件
- 自动轮转与 `jcmd VM.log rotate`
- 明确 JDK 11u 不把 `SIGUSR2` 当日志轮转入口

### 第六节：配置引擎——`-Xlog` 与 `jcmd` 为什么共用一条路径

- `LogConfiguration::parse_log_arguments`
- what/output/decorators/output options 四段
- 输出对象表与 `file=` 规范化
- `configure_output` 遍历 TagSet 并写入 OutputList
- `ConfigurationLock` 与写路径 reader 保护的分工
- `disable`、旧日志 flag、运行期更新

### 第七节：收网——配置是写入 TagSet 的输出索引

```text
选择器：决定 TagSet 对某个输出的 level
配置：把 level 写入每个 TagSet 的 OutputList
写入：按 level 入口遍历多个输出
输出：装饰 + stream write + flush
文件：写后计数，必要时轮转
```

下一篇/关联边界：DCmd `VM.log` 作为运行期入口已在本篇涉及，不扩展到 DCmd 通用框架。

## 4. 必须展开的失败方案

1. 每条日志写入时重新解析完整 `-Xlog` 字符串
2. 每个输出都从链表头扫描，导致级别过滤重复发生
3. TagSet 只允许一个输出目标
4. 删除输出对象后立刻释放，不等待正在遍历的写线程
5. 直接截断正在写的文件而不归档重开
6. 把装饰器当成标签选择条件
7. 把 `jcmd VM.log` 误写成另一套独立配置系统

## 5. 必须澄清的误解

- `LogOutputList` 是每个 TagSet 的输出关联，不是全局单一输出队列
- `_level_start` 是按输出阈值建立的入口索引，不是新的日志过滤器
- `fflush` 表示刷新 C stdio 流，不等同于持久化到物理介质
- 文件轮转在当前 JDK 11u 中是 `FILE*` 关闭、归档、重开，不写成 fd 原子替换
- `%p`/`%t` 是文件名占位符，不是装饰器
- filecount=0 的语义需要按源码说明，不能泛化为“永不覆盖”
- 运行期配置修改的是现有 TagSet 的输出关联，不是让日志点重新注册

## 6. 证据清单

- `logTagSet.cpp:70-80`：TagSet 写路径
- `logOutputList.hpp:33-41, 55, 100-138`：排序链表、level 索引、读者计数
- `logOutputList.cpp:44-49`：等待读者退出
- `logFileStreamOutput.cpp:75-89`：流写、刷新、锁
- `logTagSet.cpp:110-139`：消息格式化缓冲
- `logMessageBuffer.cpp`：多行消息缓冲
- `logStream.cpp`：旧 `outputStream` 适配
- `logDecorators.hpp:41-72`：装饰器清单与默认值
- `logDecorations.cpp`：装饰值构造与缓存
- `logFileOutput.cpp/.hpp`：文件名、轮转、FIFO、启动初始化
- `logConfiguration.cpp`：解析、输出配置、关闭、轮转
- `logDiagnosticCommand.cpp`：`VM.log` 运行期入口

## 7. 版本边界

- 基于 OpenJDK 11u Unified Logging 实现
- 文件轮转默认值、装饰器数量、配置语法和内部锁策略可能随版本变化
- 本篇只讲输出与配置，不重新展开标签选择算法
- 本篇讨论 `jcmd VM.log` 的日志入口，不展开 DCmd 框架本身
- `fflush` 只说明 C stdio 层刷新，不承诺硬件持久化语义

## 8. 字数预算

- 正文目标：`10000-14000`
- 删除代码块后叙述性正文目标：`7000+`

## 9. 完成后 review

- 删除代码后能否复述“配置写入 OutputList、写入按级别入口遍历、输出完成装饰与刷新、文件输出负责轮转”的链路
- 是否区分 TagSet 选择、output level、decorator 和 file option
- 是否明确读者计数与配置锁的分工
- 是否验证 JDK 11u 的轮转入口和 `SIGUSR2` 边界
- 是否明确 `fflush` 不等同于物理持久化
- 是否完成 file:line、版本边界和禁用词检查
