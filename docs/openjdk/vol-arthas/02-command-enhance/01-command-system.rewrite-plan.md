# 01-command-system 重写规划

> 状态：重写前大纲
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 目标：把当前“Shell / Job / CLI / Command 四层说明”重构成一篇围绕“为什么一条回车不能直接等于一次方法调用，以及 Arthas 怎样把命令发现、参数解释和业务执行拆成彼此独立责任层”的机制文

## 1. 选题判断

这篇值得独立成篇，但不能继续写成：

- 注解怎么注册命令
- ShellLineHandler 怎么切 token
- JobController 怎么建 Process
- `cli().parse()` 怎么解析参数
- `AnnotatedCommandImpl` 怎么 `newInstance()`

这种按实现层分段的说明文。

更好的统一问题是：

**Arthas 明明只是让你在终端敲一行命令，为什么它不把这件事实现成一个巨大的字符串分发器，而要拆成 Shell、Job、Process、CLI 和命令实例五层？**

这样本篇就不再是“命令系统导览”，而会被收束成一条更硬的主线：

- 一次回车不是一次方法调用，而是一段带词法、管道、后台、参数与业务语义的工作流
- 发现命令、解析参数、运行命令必须分层，不然 shell 和业务命令会互相污染
- 命令类要自带元数据，但业务执行不能反过来理解 shell 细节

## 2. 读者困惑

- 为什么 `watch com.example.Service doBiz -x 3 -n 5` 一条回车，不能直接 `if (cmd.equals("watch"))` 然后调用一个方法？
- 为什么 Arthas 还要有 `jobs`、`fg`、`bg`、管道、后台任务这些 shell 语义？
- 为什么参数解析不能简单地在 `WatchCommand.process()` 里自己读字符串？
- 为什么每次执行都要 `newInstance()` 一个全新的命令对象？
- 为什么帮助、参数校验和命令执行会围绕同一份注解元数据展开？

## 3. 一句话顿悟

**Arthas 的一条回车不是一次简单的方法调用，而是一段要先被 shell 组织、再被 Job/Process 拆分、再被 CLI 还原成对象状态、最后才交给命令业务逻辑的执行链。也就是说，它通过分层把“怎么找到命令”“怎么解释参数”“命令真正做什么”拆成了彼此独立的责任面。**

## 4. 版本边界

正文开头必须明确：

- 基于 `arthas` 当前源码实现讨论
- 聚焦 Shell / Job / Process / CLI / AnnotatedCommand 这条命令执行链
- 不把后续 `watch` 的增强细节提前展开；那属于下一篇 `EnhancerCommand` / ByteKit 主题
- 不把 `profiler`、`thread` 等具体命令业务写成本篇主线；这里只把它们当作命令系统消费者
- 这里讲的是 Arthas 当前命令架构，不等于所有 CLI 工具都需要这套层次

## 5. 旧稿主要问题

### 5.1 已有优点

- 已经意识到“一次回车要穿过四层”
- 有 `BuiltinCommandPack`、`ShellLineHandler`、`JobControllerImpl`、`ProcessImpl`、`AnnotatedCommandImpl` 等关键锚点
- 已经看到 shell 内建命令与普通 Arthas 命令是两套责任
- 已经抓到“命令实例一次性 new + CLI 注解注入”这个关键边界

### 5.2 必须修复的问题

- 开场仍然偏结构说明，冲突感不够强
- 失败方案推演不够厚：为什么不能用巨大 if-else / switch 分发器、为什么不能让命令自己解析字符串，都还没打透
- `Shell -> Job -> Process -> CLI -> Command` 层次虽然齐，但还没完全收束成“为什么一次回车不能直接等于一次方法调用”
- 扩展性总结目前偏事后归纳，还没升到主判断
- 路标不够，读者还不容易区分哪些是 shell 责任，哪些是命令责任

## 6. 重写策略

本篇不按实现文件顺序推进，而按更强的问题链组织：

1. 先建立冲突：一次回车看似简单，为什么不能直接写成字符串分发器
2. 先排除两个错误直觉：
   - 所有命令都塞进一个巨大 if-else / switch
   - 每个命令自己解析自己的字符串参数
3. 再给总图：Shell 负责行级语义，Job/Process 负责执行单元，CLI 负责参数对象化，命令只负责业务
4. 然后分层拆：
   - 注解元数据如何替代集中式注册表
   - 一次回车为什么先变 Job，再变 Process
   - 参数解析为什么必须先于命令业务逻辑
   - 为什么命令实例必须是一次性的
5. 最后收束成“命令发现、参数解释、业务执行三层责任分离”的设计哲学

## 7. 结构大纲（按理解路径）

### 第一节：事故开场——一条回车，为什么不能直接等于一次方法调用

目标：建立真实困惑，而不是直接列四层。

要回答：

- `watch ...` 看上去只是一次回车
- 但它同时携带了 shell、管道、后台、参数和业务语义
- 本篇真正要追的不是“有几层”，而是“为什么必须分层”

预估字数：900-1100

### 第二节：先排除两个错误直觉——巨大字符串分发器，或每个命令自己解析字符串

目标：做失败方案推演。

要回答：

- 为什么“把所有命令写进一个 if-else / switch”看上去最直观
- 这种做法会带来什么：命令注册膨胀、help/校验/参数规则分裂、shell 内建和业务命令互相污染
- 为什么“每个命令自己读字符串”会让参数校验、默认值、帮助和对象状态再次散落
- 真正需要的是：命令发现、参数解释、业务执行分层

预估字数：1300-1600

### 第三节：第一层——命令类为什么要自带元数据，而不是依赖集中式注册表

目标：把注解驱动注册写成冲突解法。

要回答：

- `@Name`、`@Summary`、`@Description`、`@Option` 为什么属于命令自己
- `BuiltinCommandPack.initCommands()` 怎样围绕元数据收集命令
- `disabledCommands` 为什么在注册阶段就生效
- JFR 条件注册说明了什么：命令表不是永恒常量，而是运行时能力相关

证据锚点：

- `monitor200/WatchCommand.java:22-23`
- `WatchCommand.java:69`
- `command/BuiltinCommandPack.java:48-129`
- `BuiltinCommandPack.java:111-123`

预估字数：1600-2000

### 第四节：第二层——为什么一次回车要先变成 Job，再变成 Process

目标：把 shell 层职责写清楚。

要回答：

- `ShellLineHandler.handle(line)` 为什么先做 tokenize
- 为什么 `exit`、`jobs`、`fg`、`bg`、`kill` 要被 Shell 内建命令单独拦截
- 为什么普通命令要进入 `createJob(tokens)`
- 为什么管道意味着“一行命令 = 多个 Process”，而不是某个命令自己顺便支持 grep

证据锚点：

- `shell/handlers/shell/ShellLineHandler.java:29-62`
- `shell/system/impl/JobControllerImpl.java:80,146-154`
- `shell/system/impl/InternalCommandManager.java:36-47`
- `InternalCommandManager.java:137`

预估字数：1800-2200

### 第五节：第三层——参数为什么必须在命令执行前就还原成对象状态

目标：把 CLI 层写成“参数解释器”，而不是实现细节。

要回答：

- 为什么 help 检查和正式 parse 要分两次
- 为什么 parse 失败必须在 CLI 层返回，而不是放进命令业务逻辑里
- 为什么执行线程池要和终端读取、命令解析调用栈解耦
- 为什么 `AnnotatedCommandImpl` 每次都 `newInstance()` 一个新命令实例
- 为什么 `CLIConfigurator.inject()` 能把元数据变成对象状态

证据锚点：

- `shell/system/impl/ProcessImpl.java:315-371`
- `shell/command/impl/AnnotatedCommandImpl.java:73-86`

预估字数：1900-2300

### 第六节：第四层——为什么命令实例必须一次性，而不能复用单例

目标：把原型式命令对象写成并发与状态隔离的解法。

要回答：

- 为什么命令可以把执行状态放在实例字段里
- 为什么复用单例命令对象会引入并发污染和多终端串话风险
- 元数据共享与实例状态隔离是如何同时成立的

预估字数：1200-1500

### 第七节：收网——Arthas 不是在执行一条命令，而是在解释一段会话工作流

目标：把全文收成一句话并桥接下一篇。

必须点名：

- Shell 负责行级语义
- Job/Process 负责执行单元与管道
- CLI 负责把 token 变成对象状态
- 命令类只负责业务逻辑
- 下一篇进入 watch/enhancer 真正怎样改字节码

预估字数：800-1000

## 8. 必须展开的失败方案

至少要展开以下失败方案：

1. 把所有命令写成一个巨大 if-else / switch
2. 让每个命令自己解析字符串参数
3. 让 shell 内建命令和 Arthas 业务命令共用同一张命令表
4. 把一条管道命令当成某个业务命令自己的功能
5. 复用单例命令对象处理多个终端/多个执行会话

## 9. 本篇必须明确澄清的误解

1. 一条回车不等于一次简单的方法调用
2. 命令表不是永恒常量，会受运行时能力和 `disabledCommands` 影响
3. shell 内建命令不是普通 Arthas 业务命令
4. 参数解析失败不应该进入命令业务逻辑
5. 命令实例一次性创建，不等于元数据也要重复维护
6. `watch | grep` 不是 watch 命令自己实现 grep，而是 shell 把多个 Process 串起来

## 10. 证据清单（正文托底）

- `monitor200/WatchCommand.java:22-23`
- `WatchCommand.java:69`
- `command/BuiltinCommandPack.java:48-129`
- `BuiltinCommandPack.java:111-123`
- `shell/handlers/shell/ShellLineHandler.java:29-62`
- `shell/system/impl/JobControllerImpl.java:80,146-154`
- `shell/system/impl/InternalCommandManager.java:36-47`
- `InternalCommandManager.java:137`
- `shell/system/impl/ProcessImpl.java:315-371`
- `shell/command/impl/AnnotatedCommandImpl.java:73-86`

## 11. 字数预算

- 目标正文总字数：`8500-11000`
- 叙述性正文目标：`5500+`

## 12. 完成后必须通过的检查

1. 删除代码后，主线是否仍然成立
2. 是否清楚回答了“为什么一条回车不能直接等于一次方法调用”
3. 是否至少展开了 4 个失败方案
4. 是否把注解元数据、Job/Process、CLI parse、命令实例统一到同一条责任分离主线上
5. 是否避免提前展开下一篇的 Enhancer / ByteKit 字节码细节
6. 是否完成 `file:line` 重核与边界声明
