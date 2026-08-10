# 01. jcmd Thread.print 怎么走到 DCmd 执行？— DCmd Framework

> 🔴 Deep | 1 KP 中的命令框架
> 读者处境: `jcmd <pid> Thread.print` → JVM attach listener 接收→解析为 DCmd→DCmdParser parse→dispatch to DCmdThreadPrint::execute()→print thread dump。

### 1. "DCmd Framework — 注册→解析→执行"

场景: JVM 启动→DCmdFactory 注册所有 ~30 命令到全局 DCmd table。每个 DCmd 有 name+description+parameters。

**DCmdFramework** (`services/diagnosticFramework.hpp:40-150 + diagnosticFramework.cpp:50-250`):
```cpp
class DCmd : public CHeapObj<mtInternal> {
  virtual void execute(DCmdSource source, TRAPS) = 0;
};
class DCmdFactory {
  static DCmd* create(DCmdSource, TRAPS); // factory method
};
// 注册: DCmdRegistrant::register_dcmd(new DCmdThreadPrint())
```
- 源码: `services/diagnosticFramework.hpp:40-150` + `diagnosticFramework.cpp:50-250`
- 关键设计: DCmdRegistrant 在 JVM startup 注册所有命令到 `DCmdTable`(hash table: command_name→DCmdFactory)。jcmd 输入→attach listener→`DCmd::parse_and_execute(cmdline)`→DCmdParser split name+args→table.lookup(name)→factory.create()→execute

### 2. "DCmdParser — 参数解析"

场景: `jcmd <pid> GC.run` (无参数) vs `jcmd <pid> VM.native_memory summary scale=KB`(有参数)

**DCmdParser** (`services/diagnosticArgument.hpp:40-120`):
```
DCmdParser::parse(cmdline):
  split by whitespace→first token=command name→remaining=key=value pairs
  → for each registered DCmdArgument: match key→parse value type→set
  → help: 'jcmd <pid> help VM.flags' → output description of all arguments
```
- 源码: `services/diagnosticArgument.hpp:40-120` + `diagnosticArgument.cpp:50-200`
- 关键设计: DCmdParser 使用 "key=value" 文本协议而非 JMX 的 Java object serialization——纯文本 jcmd 输出可 pipe 到 grep/awk 处理。参数验证在 parse 阶段(非 execute)—类型错误在 dispatch 前报错，不传给 DCmd

---

### 核心悬念

**"DCmdFactory 在 JVM 启动时注册 ~30 命令到全局 table。jcmd→attach listener→DCmdParser parse→dispatch to execute()。"** — 下一篇: 内置命令详解。

> → [02-builtin-commands.md](02-builtin-commands.md)
