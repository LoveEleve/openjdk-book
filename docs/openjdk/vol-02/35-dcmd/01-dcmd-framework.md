# 01. jcmd Thread.print 怎么走到 DCmd 执行？— DCmd Framework

> **前置依赖**:[36-attach/01 — jcmd 怎么连接到运行中的 JVM?— AttachListener + Socket IPC](openjdk/vol-02/36-attach/01-attach-listener.md):Attach listener 怎么收命令、怎么把字符串送进 VM;[21-shared-runtime/01 — Runtime Stubs](openjdk/vol-02/21-shared-runtime/01-runtime-stubs.md):VMThread/VM_Operation 的执行语境;[25-gc-framework/03 — SoftReference 什么时候被清除？— Reference Processing](openjdk/vol-02/25-gc-framework/03-reference-processing.md):服务性接口里常见的 `TRAPS`/异常回传套路
> → **后续**:[35-dcmd/02 — 常用内置命令](02-builtin-commands.md)
> 关联域: 36-attach(命令入口)、33-jmx(MBean 导出)、17-threads(ServiceThread/VMThread)

`jcmd <pid> Thread.print` 看起来像个外部工具命令,但进 JVM 以后它就变成了 HotSpot 自己的一套小框架: **AttachListener 收字符串 → DCmd 框架按命令名找 factory → parser 解析参数 → 生成命令对象 → `execute()` 真正干活。** 这层框架的价值不在“能执行命令”——那谁都能写——而在它把三件事统一了: 一套文本协议(attach / jcmd)、一套对象模型(DCmd/Factory/Parser)、一套导出面(AttachAPI / MBean / Internal)。

---

## 1. attach 入口 — `jcmd` 只是把整条命令行交给 DCmd

### AttachListener 里的 `jcmd` 入口非常薄

`attachListener.cpp` 里真正的 `jcmd` 入口(attachListener.cpp:198-212):

```cpp
// attachListener.cpp:198-212(截取核心,逐字)
// A jcmd attach operation request was received, which will now
// dispatch to the diagnostic commands used for serviceability functions.
static jint jcmd(AttachOperation* op, outputStream* out) {
  Thread* THREAD = Thread::current();
  // All the supplied jcmd arguments are stored as a single
  // string (op->arg(0)). This is parsed by the Dcmd framework.
  DCmd::parse_and_execute(DCmd_Source_AttachAPI, out, op->arg(0), ' ', THREAD);
  if (HAS_PENDING_EXCEPTION) {
    java_lang_Throwable::print(PENDING_EXCEPTION, out);
    out->cr();
    CLEAR_PENDING_EXCEPTION;
    return JNI_ERR;
  }
  return JNI_OK;
}
```

这个入口故意做得很薄:

- Attach 层只负责把 `op->arg(0)` 这一整串文本交出来;
- source 明确标成 `DCmd_Source_AttachAPI`;
- 解析、查找、执行全丢给 `DCmd::parse_and_execute(...)`。

所以 **AttachListener 并不知道 `Thread.print`、`GC.heap_info` 这些命令各自怎么做。** 它只知道“这是一个 DCmd 命令行”。这也是 jcmd/attach 和 MBean 共用一套框架的基础。

### source 不是装饰品,它决定命令能不能被看到

`DCmdSource` 在 diagnosticFramework.hpp:36-40 里只定义了三个按位标志: `DCmd_Source_Internal`、`DCmd_Source_AttachAPI`、`DCmd_Source_MBean`。这不是简单的来源标签。后面 factory 查找时会拿它跟 `_export_flags` 做按位与,决定这条命令能不能从当前入口暴露出去。也就是说:

- 有些命令只给 Internal;
- 有些命令给 AttachAPI 但不给 MBean;
- 有些三条入口都能走。

大纲里那种“全局 table: command_name→factory”说法太扁平,漏掉了 **source 过滤** 这层。

---

## 2. 命令行模型 — 不是直接 split,而是 `CmdLine` + `DCmdArgIter`

### `CmdLine` 先把“命令名”和“参数区”切开

`CmdLine`(diagnosticFramework.hpp:52-71):

```cpp
// diagnosticFramework.hpp:52-71(截取核心,逐字)
// CmdLine is the class used to handle a command line containing a single
// diagnostic command and its arguments. It provides methods to access the
// command name and the beginning of the arguments. The class is also
// able to identify commented command lines and the "stop" keyword
class CmdLine : public StackObj {
private:
  const char* _cmd;
  size_t      _cmd_len;
  const char* _args;
  size_t      _args_len;
public:
  CmdLine(const char* line, size_t len, bool no_command_name);
...
  bool is_executable() const      { return is_empty() || _cmd[0] != '#'; }
  bool is_stop() const            { return !is_empty() && strncmp("stop", _cmd, _cmd_len) == 0; }
};
```

框架并不是上来就 `strtok`。它先抽象成 `CmdLine`:

- `_cmd/_cmd_len` 是命令名;
- `_args/_args_len` 是后面的参数文本;
- 还能识别 `#` 注释行和特殊的 `stop` 关键字。

这说明 `parse_and_execute` 设计时就不是只服务 `jcmd <pid> one-command` 这一种场景,而是支持**多行脚本式输入**。这点从后面的 `DCmdIter(cmdline, '\n')` 也能看出来。

### 真正的参数切词器支持引号和 `key=value`

`DCmdArgIter::next`(diagnosticFramework.cpp:67-145):

```cpp
// diagnosticFramework.cpp:67-145(截取核心,逐字)
bool DCmdArgIter::next(TRAPS) {
  if (_len == 0) return false;
...
  _key_addr = &_buffer[_cursor];
  bool arg_had_quotes = false;
  while (_cursor <= _len - 1 && _buffer[_cursor] != '=' && _buffer[_cursor] != _delim) {
    // argument can be surrounded by single or double quotes
    if (_buffer[_cursor] == '"' || _buffer[_cursor] == '\'') {
...
  if (_cursor <= _len -1 && _buffer[_cursor] == '=') {
    _cursor++;
    _value_addr = &_buffer[_cursor];
    bool value_had_quotes = false;
...
  } else {
    _value_addr = NULL;
    _value_len = 0;
  }
  return _key_len != 0;
}
```

这里已经把大纲里“split by whitespace → key=value”那种简化打破了。真实规则更细:

- 参数/值都支持单引号和双引号;
- 支持裸 argument(`Thread.print -l` 里的 `-l` 是 option 名,而 `help VM.flags` 里的 `VM.flags` 是位置参数);
- 支持 `key=value`;
- 引号不闭合会在 parse 阶段直接抛 `IllegalArgumentException`。

所以 DCmd 的文本协议不是“空格切一下”那么粗糙,而是一套**轻量但完整的 shell 风格参数协议**。

---

## 3. DCmdParser — option 看名字, argument 看位置

### 头文件把语法规则写明了

`DCmdParser` 的注释(diagnosticFramework.hpp:184-203):

```cpp
// diagnosticFramework.hpp:184-203(截取核心,逐字)
// The DCmdParser class can be used to create an argument parser for a
// diagnostic command. It is not mandatory to use it to parse arguments.
// The DCmdParser parses a CmdLine instance according to the parameters that
// have been declared by its associated diagnostic command. A parameter can
// either be an option or an argument. Options are identified by the option name
// while arguments are identified by their position in the command line. The
// position of an argument is defined relative to all arguments passed on the
// command line, options are not considered when defining an argument position.
// The generic syntax of a diagnostic command is:
//
//    <command name> [<option>=<value>] [<argument_value>]
//
// Example:
//
//    command_name option1=value1 option2=value argumentA argumentB argumentC
class DCmdParser {
```

这段注释直接说明了两个最关键的设计点:

1. **option 靠名字匹配**;
2. **argument 靠位置匹配,且 position 只在 arguments 之间计数,不把 options 算进去。**

所以 `help -all VM.flags` 这类命令的解析不是“按文本顺序盲拆”,而是 option 和 argument 两条链表各走各的。

### `parse()` 的流程: 先找 option,找不到再吃下一个位置参数

`DCmdParser::parse`(diagnosticFramework.cpp:190-221):

```cpp
// diagnosticFramework.cpp:190-221(截取核心,逐字)
void DCmdParser::parse(CmdLine* line, char delim, TRAPS) {
  GenDCmdArgument* next_argument = _arguments_list;
  DCmdArgIter iter(line->args_addr(), line->args_len(), delim);
  bool cont = iter.next(CHECK);
  while (cont) {
    GenDCmdArgument* arg = lookup_dcmd_option(iter.key_addr(),
            iter.key_length());
    if (arg != NULL) {
      arg->read_value(iter.value_addr(), iter.value_length(), CHECK);
    } else {
      if (next_argument != NULL) {
        arg = next_argument;
        arg->read_value(iter.key_addr(), iter.key_length(), CHECK);
        next_argument = next_argument->next();
      } else {
...
        THROW_MSG(vmSymbols::java_lang_IllegalArgumentException(), buf);
      }
    }
    cont = iter.next(CHECK);
  }
  check(CHECK);
}
```

这段流程非常值得记住:

- 每取出一个 token,先 `lookup_dcmd_option(...)`;
- 找到了按 option 读 value;
- 找不到,才把它塞给当前位置参数 `next_argument`;
- 再没有可吃的位置参数,直接报 `Unknown argument`;
- 全部 token 吃完后,最后统一 `check()` mandatory 约束。

也就是说 **验证发生在 parse 阶段,不是 execute 里临时 if/else。** 这让每条 DCmd 的 `execute()` 可以更专注业务本身。

### `check()` 单独负责 mandatory 校验

`DCmdParser::check`(diagnosticFramework.cpp:235-253):

```cpp
// diagnosticFramework.cpp:235-253(截取核心,逐字)
void DCmdParser::check(TRAPS) {
  const size_t buflen = 256;
  char buf[buflen];
  GenDCmdArgument* arg = _arguments_list;
  while (arg != NULL) {
    if (arg->is_mandatory() && !arg->has_value()) {
      jio_snprintf(buf, buflen - 1, "The argument '%s' is mandatory.", arg->name());
      THROW_MSG(vmSymbols::java_lang_IllegalArgumentException(), buf);
    }
    arg = arg->next();
  }
  arg = _options;
  while (arg != NULL) {
    if (arg->is_mandatory() && !arg->has_value()) {
      jio_snprintf(buf, buflen - 1, "The option '%s' is mandatory.", arg->name());
      THROW_MSG(vmSymbols::java_lang_IllegalArgumentException(), buf);
```

所以 DCmd 的“缺参报错”是框架级统一行为,不是每个命令自己手写一遍。大纲里说“参数验证在 parse 阶段”这点是对的,但真实实现比它说得更清楚: **parse 负责配对和读值,check 负责 mandatory 规则。**

---

## 4. DCmd/Factory — 真正的注册表不是 hash table,而是单链表

### `DCmd` 只是统一抽象,真正分发靠 factory

`DCmd` 与 `DCmdFactory`(diagnosticFramework.hpp:238-307,345-386):

```cpp
// diagnosticFramework.hpp:238-307,345-386(截取核心,逐字)
class DCmd : public ResourceObj {
protected:
  outputStream* const _output;
  const bool          _is_heap_allocated;
public:
  DCmd(outputStream* output, bool heap_allocated)
   : _output(output), _is_heap_allocated(heap_allocated) {}
...
  virtual void parse(CmdLine* line, char delim, TRAPS) {
    DCmdArgIter iter(line->args_addr(), line->args_len(), delim);
...
  virtual void execute(DCmdSource source, TRAPS) { }
...
  static void parse_and_execute(DCmdSource source, outputStream* out, const char* cmdline,
                                char delim, TRAPS);
};
...
class DCmdFactory: public CHeapObj<mtInternal> {
private:
  static DCmdFactory* _DCmdFactoryList;
...
  DCmdFactory*        _next;
...
  static int register_DCmdFactory(DCmdFactory* factory);
  static DCmdFactory* factory(DCmdSource source, const char* cmd, size_t len);
  static DCmd* create_local_DCmd(DCmdSource source, CmdLine &line, outputStream* out, TRAPS);
```

这里有两个经常被大纲误导的点:

1. **`DCmd` 基类自己就带默认 `parse()` 和 `execute()`**; 没 parser 的命令可以直接继承它,带参数的命令常继承 `DCmdWithParser`;
2. 注册表不是 hash table。头文件已经写死了 `_DCmdFactoryList` + `_next`——**它是单链表。**

所以按名字查命令时,真实行为是链表线性查找,不是哈希表 O(1) 查找。命令总数只有几十个,这里优化目标显然不是极限查找性能,而是简单和可维护。

### factory 查找时会做 source 过滤

`DCmdFactory::factory`(diagnosticFramework.cpp:496-511):

```cpp
// diagnosticFramework.cpp:496-511(截取核心,逐字)
DCmdFactory* DCmdFactory::factory(DCmdSource source, const char* name, size_t len) {
  MutexLockerEx ml(DCmdFactory_lock, Mutex::_no_safepoint_check_flag);
  DCmdFactory* factory = _DCmdFactoryList;
  while (factory != NULL) {
    if (strlen(factory->name()) == len &&
        strncmp(name, factory->name(), len) == 0) {
      if(factory->export_flags() & source) {
        return factory;
      } else {
        return NULL;
      }
    }
    factory = factory->_next;
  }
  return NULL;
}
```

这个查找流程很直白:

- 加 `DCmdFactory_lock`;
- 从 `_DCmdFactoryList` 头开始线性匹配名字;
- 名字相同后,还要看 `export_flags() & source`;
- source 不匹配时直接返回 `NULL`。

所以一个命令“存在但不可从当前入口调用”时,对调用方看起来和“不存在”是一样的: 都会在后面变成 `Unknown diagnostic command`。

### 注册也只是头插法,没有去重

`register_DCmdFactory`(diagnosticFramework.cpp:513-522):

```cpp
// diagnosticFramework.cpp:513-522(截取核心,逐字)
int DCmdFactory::register_DCmdFactory(DCmdFactory* factory) {
  MutexLockerEx ml(DCmdFactory_lock, Mutex::_no_safepoint_check_flag);
  factory->_next = _DCmdFactoryList;
  _DCmdFactoryList = factory;
  if (_send_jmx_notification && !factory->_hidden
      && (factory->_export_flags & DCmd_Source_MBean)) {
    DCmdFactory::push_jmx_notification_request();
  }
  return 0; // Actually, there's no checks for duplicates
}
```

大纲里说“注册到全局 table”没错,但漏了三个关键信息:

1. **头插单链表**;
2. **无重复检查**(源码注释直接写了);
3. 如果开启 JMX notification,并且命令对 MBean 可见且不 hidden,注册时还会顺便推送一条通知请求。

---

## 5. 启动时怎么注册 — 不是 JVM startup 任意时刻,而是 `DCmdRegistrant`

### 真正的注册表在 `diagnosticCommand.cpp`

`DCmdRegistrant::register_dcmds()`(diagnosticCommand.cpp:71-138):

```cpp
// diagnosticCommand.cpp:71-138(截取核心,逐字)
void DCmdRegistrant::register_dcmds(){
  // Registration of the diagnostic commands
  // First argument specifies which interfaces will export the command
  // Second argument specifies if the command is enabled
  // Third  argument specifies if the command is hidden
  uint32_t full_export = DCmd_Source_Internal | DCmd_Source_AttachAPI
                         | DCmd_Source_MBean;
  DCmdFactory::register_DCmdFactory(new DCmdFactoryImpl<HelpDCmd>(full_export, true, false));
  DCmdFactory::register_DCmdFactory(new DCmdFactoryImpl<VersionDCmd>(full_export, true, false));
  DCmdFactory::register_DCmdFactory(new DCmdFactoryImpl<CommandLineDCmd>(full_export, true, false));
...
  DCmdFactory::register_DCmdFactory(new DCmdFactoryImpl<ThreadDumpDCmd>(full_export, true, false));
...
  uint32_t jmx_agent_export_flags = DCmd_Source_Internal | DCmd_Source_AttachAPI;
  DCmdFactory::register_DCmdFactory(new DCmdFactoryImpl<JMXStartRemoteDCmd>(jmx_agent_export_flags, true,false));
```

这才是真正的“命令清单”。不是在每个命令类里自注册,也不是 management.cpp 里一张静态表,而是**`DCmdRegistrant` 集中调 `DCmdFactory::register_DCmdFactory(new DCmdFactoryImpl<...>)` 一条条挂进去。**

几个要点:

- `full_export = Internal | AttachAPI | MBean` 是最常见配置;
- 某些命令故意不给 MBean,比如 JMX agent 相关命令只导出 Internal + AttachAPI;
- `enabled/hidden` 也是注册时静态决定的初值。

所以**可见性和能力是 factory 元数据的一部分**,不是执行时临时判断。

---

## 6. 执行主循环 — create → parse → execute,资源清理由 `DCmdMark` 兜底

### `parse_and_execute` 支持多行命令和 `stop`

`DCmd::parse_and_execute`(diagnosticFramework.cpp:384-413):

```cpp
// diagnosticFramework.cpp:384-413(截取核心,逐字)
void DCmd::parse_and_execute(DCmdSource source, outputStream* out,
                             const char* cmdline, char delim, TRAPS) {

  if (cmdline == NULL) return; // Nothing to do!
  DCmdIter iter(cmdline, '\n');

  int count = 0;
  while (iter.has_next()) {
    if(source == DCmd_Source_MBean && count > 0) {
...
    }
    CmdLine line = iter.next();
    if (line.is_stop()) {
      break;
    }
    if (line.is_executable()) {
      ResourceMark rm;
      DCmd* command = DCmdFactory::create_local_DCmd(source, line, out, CHECK);
      assert(command != NULL, "command error must be handled before this line");
      DCmdMark mark(command);
      command->parse(&line, delim, CHECK);
      command->execute(source, CHECK);
    }
    count++;
  }
}
```

执行主循环顺序非常固定:

1. 用 `DCmdIter(cmdline, '\n')` 把整段文本切成多条命令;
2. MBean 来源只允许一条命令,多了直接 `Invalid syntax`;
3. `stop` 关键字会中断;
4. 跳过注释/空行;
5. `create_local_DCmd` 创建对象;
6. `parse()` 解析参数;
7. `execute()` 真执行。

所以 **“create 在 parse 前”** 这一点很重要: parser 并不是全局静态函数,而是绑在具体命令对象上的(`DCmdWithParser` 里带 `_dcmdparser`)。

### `DCmdMark` 负责 cleanup 和 delete

`DCmdMark`(diagnosticFramework.hpp:326-337):

```cpp
// diagnosticFramework.hpp:326-337(截取核心,逐字)
class DCmdMark : public StackObj {
  DCmd* const _ref;
public:
  DCmdMark(DCmd* cmd) : _ref(cmd) {}
  ~DCmdMark() {
    if (_ref != NULL) {
      _ref->cleanup();
      if (_ref->is_heap_allocated()) {
        delete _ref;
      }
    }
  }
};
```

这是框架里一个很容易忽略但很漂亮的 RAII 点:

- 每次命令对象创建完,马上绑一个 `DCmdMark`;
- 作用域退出时先 `cleanup()`;
- 如果命令对象是 C-heap 分配的,顺便 `delete`。

这解释了为什么 `parse_and_execute` 里哪怕中途抛异常,资源回收也还能比较整齐。大纲完全没提到这层托底。

### `create_local_DCmd` 只创建 resource-area 本地实例

`create_local_DCmd`(diagnosticFramework.cpp:524-535):

```cpp
// diagnosticFramework.cpp:524-535(截取核心,逐字)
DCmd* DCmdFactory::create_local_DCmd(DCmdSource source, CmdLine &line,
                                     outputStream* out, TRAPS) {
  DCmdFactory* f = factory(source, line.cmd_addr(), line.cmd_len());
  if (f != NULL) {
    if (!f->is_enabled()) {
      THROW_MSG_NULL(vmSymbols::java_lang_IllegalArgumentException(),
                     f->disabled_message());
    }
    return f->create_resource_instance(out);
  }
  THROW_MSG_NULL(vmSymbols::java_lang_IllegalArgumentException(),
             "Unknown diagnostic command");
}
```

两个错误出口都在这:

- 名字找不到 / source 不匹配 → `Unknown diagnostic command`;
- factory 存在但 disabled → `disabled_message()`。

而且这里明确走的是 `create_resource_instance(out)`。也就是说 `jcmd` 这条本地同步路径创建的是 **resource-area 命令对象**。只有异步/跨线程场景才需要 C-heap 实例。

---

## 核心悬念

**DCmd 框架真正统一的不是“命令怎么执行”,而是“字符串命令怎么被安全地变成命令对象”。** AttachListener 只转交文本,`CmdLine`/`DCmdArgIter` 负责切词,`DCmdParser` 负责 option/argument 绑定与 mandatory 校验,`DCmdFactory` 负责按 source 查找并创建对象,`DCmdMark` 负责清理善后。到这里,框架本身已经闭环。下一篇要看的就不是“怎么 dispatch”,而是**最常用的那些内置命令到底各自干了什么: `Thread.print`、`GC.heap_info`、`VM.flags`、`help` 这些命令的 execute 里真正走到了哪些 HotSpot 子系统。**

> → [02-builtin-commands.md](02-builtin-commands.md)
