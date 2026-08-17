# 02. jcmd 可以做什么？— 内置命令详解

> **前置依赖**:[35-dcmd/01 — jcmd Thread.print 怎么走到 DCmd 执行？— DCmd Framework](01-dcmd-framework.md):命令如何进入 factory、parser 和 `execute()` 已经闭环;[36-attach/01 — jcmd 怎么连接到运行中的 JVM?— AttachListener + Socket IPC](openjdk/vol-02/36-attach/01-attach-listener.md):本地 attach 通道与 `jcmd` 请求入口;[33-jmx/01 — JMX 怎么把 JVM 暴露出去？](openjdk/vol-02/33-jmx/01-memory-service.md):DCmd 的 MBean 导出面
> → **后续**:[36-attach/01 — jcmd 怎么连接到运行中的 JVM?— AttachListener + Socket IPC](openjdk/vol-02/36-attach/01-attach-listener.md)
> 关联域: 26-g1-gc(GC 命令)、21-shared-runtime(线程与 VM 操作)、34-nmt(NMT 命令)

`jcmd` 不是一个只有“列命令”的工具。它把很多 HotSpot 内部能力包成 DCmd: 看版本、查 flags、改可写 flag、触发 GC、打印 heap、抓线程、做 histogram。每条命令表面上都是一个名字,但 execute() 里面可能直接调用 `Universe::heap()`,也可能创建 `VM_Operation` 交给 VMThread,还可能调用 Java 方法或外部子系统。

先把大纲中的一个误导点拆掉: **JDK 11 的 DCmd 清单不是固定的“VM/Thread/GC/NMT/JFR 五大类约 30 个”**。HotSpot `diagnosticCommand.cpp` 注册的是一批平台/服务命令;NMT、JFR 还可以由各自模块提供命令或工具接口。本文只按 JDK 11 源码中能直接核对的内置 DCmd,回答“常用命令 execute 到底做了什么”。

---

## 1. VM 类命令 — 查询、修改,不等于都走同一套逻辑

### `VM.version`: 只是拼版本信息

`VersionDCmd::execute`(diagnosticCommand.cpp:227-238):

```cpp
// diagnosticCommand.cpp:227-238(截取核心,逐字)
void VersionDCmd::execute(DCmdSource source, TRAPS) {
  output()->print_cr("%s version %s", Abstract_VM_Version::vm_name(),
          Abstract_VM_Version::vm_release());
  JDK_Version jdk_version = JDK_Version::current();
  if (jdk_version.patch_version() > 0) {
    output()->print_cr("JDK %d.%d.%d.%d", jdk_version.major_version(),
            jdk_version.minor_version(), jdk_version.security_version(),
            jdk_version.patch_version());
  } else {
    output()->print_cr("JDK %d.%d.%d", jdk_version.major_version(),
            jdk_version.minor_version(), jdk_version.security_version());
  }
}
```

`VM.version` 没有 parser,也不需要 VMThread。它直接从 `Abstract_VM_Version` 与 `JDK_Version` 读取信息写到 command output。这个命令的价值是建立一个参照系:后面所有 flag、GC、线程输出,都应该知道自己对应的是哪个 VM build。

### `VM.flags`: 默认只打已设置 flags,`-all` 才打全部

`PrintVMFlagsDCmd`(diagnosticCommand.hpp:117-135)注册了一个 `-all` option;执行逻辑(diagnosticCommand.cpp:241-253):

```cpp
// diagnosticCommand.cpp:241-253(截取核心,逐字)
PrintVMFlagsDCmd::PrintVMFlagsDCmd(outputStream* output, bool heap) :
                                   DCmdWithParser(output, heap),
  _all("-all", "Print all flags supported by the VM", "BOOLEAN", false, "false") {
  _dcmdparser.add_dcmd_option(&_all);
}

void PrintVMFlagsDCmd::execute(DCmdSource source, TRAPS) {
  if (_all.value()) {
    JVMFlag::printFlags(output(), true);
  } else {
    JVMFlag::printSetFlags(output());
  }
}
```

这里有一个很容易被用户输出误导的区别:

- `jcmd <pid> VM.flags` 默认调用 `JVMFlag::printSetFlags`,只看当前被设置过的 flags;
- `jcmd <pid> VM.flags -all` 才调用 `JVMFlag::printFlags(output(), true)`,打印完整 flag 集合。

所以“VM.flags = 所有 `-XX:` 参数”不准确。默认输出是**已设置集合**,不是整个 flag universe。

### `VM.set_flag`: 解析只是第一关,真正限制在 `WriteableFlags`

`SetVMFlagDCmd` 的参数声明和执行(diagnosticCommand.cpp:266-286):

```cpp
// diagnosticCommand.cpp:266-286(截取核心,逐字)
SetVMFlagDCmd::SetVMFlagDCmd(outputStream* output, bool heap) :
                                   DCmdWithParser(output, heap),
  _flag("flag name", "The name of the flag we want to set",
        "STRING", true),
  _value("string value", "The value we want to set", "STRING", false) {
  _dcmdparser.add_dcmd_argument(&_flag);
  _dcmdparser.add_dcmd_argument(&_value);
}

void SetVMFlagDCmd::execute(DCmdSource source, TRAPS) {
  const char* val = NULL;
  if (_value.value() != NULL) {
    val = _value.value();
  }

  FormatBuffer<80> err_msg("%s", "");
  int ret = WriteableFlags::set_flag(_flag.value(), val, JVMFlag::MANAGEMENT, err_msg);

  if (ret != JVMFlag::SUCCESS) {
    output()->print_cr("%s", err_msg.buffer());
  }
}
```

它不是“把任意 flag 的内存改掉”:

1. parser 要求第一个 argument 是 flag 名;
2. 第二个 argument 是可选值;
3. execute 把请求交给 `WriteableFlags::set_flag(..., JVMFlag::MANAGEMENT, ...)`;
4. 能不能改、值是否合法、是否允许 MANAGEMENT 修改,由 flag subsystem 决定。

因此 `VM.set_flag` 是一个受约束的运行时管理入口,不是通用写内存接口。

### `VM.uptime`: option 会改变输出格式,不会改变计时来源

`VMUptimeDCmd`(diagnosticCommand.cpp:414-427):

```cpp
// diagnosticCommand.cpp:414-427(截取核心,逐字)
VMUptimeDCmd::VMUptimeDCmd(outputStream* output, bool heap) :
                           DCmdWithParser(output, heap),
  _date("-date", "Add a prefix with current date", "BOOLEAN", false, "false") {
  _dcmdparser.add_dcmd_option(&_date);
}

void VMUptimeDCmd::execute(DCmdSource source, TRAPS) {
  if (_date.value()) {
    output()->date_stamp(true, "", ": ");
  }
  output()->time_stamp().update_to(tty->time_stamp().ticks());
  output()->stamp();
  output()->print_cr(" s");
}
```

`VM.uptime` 的 `-date` 只是给输出增加日期前缀;真正的时间戳来自 `tty->time_stamp()`。这类命令很薄,但它仍然受 DCmd parser 和统一 output stream 约束。

---

## 2. GC 类命令 — 同一个“触发”,不同的 VM 操作重量

### `GC.run`: 直接调用 heap 的 collect

`SystemGCDCmd::execute`(diagnosticCommand.cpp:444-446):

```cpp
// diagnosticCommand.cpp:444-446(截取核心,逐字)
void SystemGCDCmd::execute(DCmdSource source, TRAPS) {
  Universe::heap()->collect(GCCause::_dcmd_gc_run);
}
```

这条命令没有 parser,execute 也只有一行。重要的是 cause:它不是普通 Java 代码里随便传的字符串,而是专门的 `GCCause::_dcmd_gc_run`。具体是 concurrent、young、full 还是被策略拒绝,由当前 GC 实现和 policy 决定;不能把这行 DCmd 代码直接等同于“必然 Full GC”。

### `GC.heap_info`: 打印 heap,但会拿 `Heap_lock`

`HeapInfoDCmd::execute`(diagnosticCommand.cpp:457-460):

```cpp
// diagnosticCommand.cpp:457-460(截取核心,逐字)
void HeapInfoDCmd::execute(DCmdSource source, TRAPS) {
  MutexLocker hl(Heap_lock);
  Universe::heap()->print_on(output());
}
```

这条命令看起来只是查询,但它不是无锁读几个计数器:

- 先拿 `Heap_lock`;
- 再调用 `Universe::heap()->print_on(output())`。

因此线上执行 `GC.heap_info` 也会进入 heap 的同步协议,只是它不主动请求一次 GC。**“查询命令”不等于“零同步成本”。**

### `GC.class_histogram`: 通过 VMThread 执行堆检查

`ClassHistogramDCmd::execute`(diagnosticCommand.cpp:556-567):

```cpp
// diagnosticCommand.cpp:556-567(截取核心,逐字)
ClassHistogramDCmd::ClassHistogramDCmd(outputStream* output, bool heap) :
                                       DCmdWithParser(output, heap),
  _all("-all", "Inspect all objects, including unreachable objects",
       "BOOLEAN", false, "false") {
  _dcmdparser.add_dcmd_option(&_all);
}

void ClassHistogramDCmd::execute(DCmdSource source, TRAPS) {
  VM_GC_HeapInspection heapop(output(),
                              !_all.value() /* request full gc if false */);
  VMThread::execute(&heapop);
}
```

`GC.class_histogram` 才是重量明显不同的一条:

- 默认 `_all=false`,构造 `VM_GC_HeapInspection(..., true)` 请求 full GC;
- `-all` 时不请求这一步;
- 无论如何都通过 `VMThread::execute(&heapop)` 把 VM 操作交给 VMThread。

所以大纲里“全堆 class histogram”还不够精确:默认模式可能先做一次 full GC,`-all` 才是不主动要求只看全部对象的路径。

### `GC.heap_dump`: 参数校验和 full GC 也在 DCmd 里编排

`HeapDumpDCmd::execute`(diagnosticCommand.cpp:509-543):

```cpp
// diagnosticCommand.cpp:509-543(截取核心,逐字)
HeapDumpDCmd::HeapDumpDCmd(outputStream* output, bool heap) :
                           DCmdWithParser(output, heap),
  _filename("filename","Name of the dump file", "STRING",true),
  _all("-all", "Dump all objects, including unreachable objects",
       "BOOLEAN", false, "false"),
  _gzip("-gz", "If specified, the heap dump is written in gzipped format "
                "using the given compression level. 1 (recommended) is the fastest, "
                "9 the strongest compression.", "INT", false, "1"),
  _overwrite("-overwrite", "If specified, the dump file will be overwritten if it exists",
           "BOOLEAN", false, "false") {
  _dcmdparser.add_dcmd_option(&_all);
  _dcmdparser.add_dcmd_argument(&_filename);
  _dcmdparser.add_dcmd_option(&_gzip);
  _dcmdparser.add_dcmd_option(&_overwrite);
}

void HeapDumpDCmd::execute(DCmdSource source, TRAPS) {
  jlong level = -1;
  if (_gzip.is_set()) {
    level = _gzip.value();
    if (level < 1 || level > 9) {
      output()->print_cr("Compression level out of range (1-9): " JLONG_FORMAT, level);
      return;
    }
  }
  HeapDumper dumper(!_all.value());
  dumper.dump(_filename.value(), output(), (int) level, _overwrite.value());
}
```

这条命令展示了 DCmd 的典型组合:

- parser 负责 filename、`-all`、`-gz`、`-overwrite`;
- execute 负责压缩级别范围校验;
- `_all=false` 时构造 `HeapDumper(true)` 请求 GC;
- 最终把文件名、输出流、压缩级别和覆盖策略交给 `HeapDumper`。

这里的 `-all` 语义和 `GC.class_histogram -all` 相似:默认倾向于先清理不可达对象,显式 `-all` 才保留全部对象。

---

## 3. Thread.print — 一个命令连续触发三次 VM 操作

### 参数不是“打印栈开关”,而是两个独立 option

`ThreadDumpDCmd`(diagnosticCommand.cpp:633-639):

```cpp
// diagnosticCommand.cpp:633-639(截取核心,逐字)
ThreadDumpDCmd::ThreadDumpDCmd(outputStream* output, bool heap) :
                               DCmdWithParser(output, heap),
  _locks("-l", "print java.util.concurrent locks", "BOOLEAN", false, "false"),
  _extended("-e", "print extended thread information", "BOOLEAN", false, "false") {
  _dcmdparser.add_dcmd_option(&_locks);
  _dcmdparser.add_dcmd_option(&_extended);
}
```

`Thread.print` 的 `-l` 和 `-e` 都是 parser option:

- `-l`:打印 `java.util.concurrent` locks;
- `-e`:打印扩展线程信息。

它们不是 position arguments,因此 `Thread.print -l -e` 会由 DCmdParser 按 option 名绑定。

### execute 顺序: stacks → JNI handles → deadlocks

`ThreadDumpDCmd::execute`(diagnosticCommand.cpp:641-653):

```cpp
// diagnosticCommand.cpp:641-653(截取核心,逐字)
void ThreadDumpDCmd::execute(DCmdSource source, TRAPS) {
  // thread stacks
  VM_PrintThreads op1(output(), _locks.value(), _extended.value());
  VMThread::execute(&op1);

  // JNI global handles
  VM_PrintJNI op2(output());
  VMThread::execute(&op2);

  // Deadlock detection
  VM_FindDeadlocks op3(output());
  VMThread::execute(&op3);
}
```

这解释了为什么 `Thread.print` 的输出不只是一堆 Java 栈:

1. `VM_PrintThreads` 打线程栈;
2. `VM_PrintJNI` 打 JNI global handles;
3. `VM_FindDeadlocks` 做死锁检测。

三个 `VM_Operation` 顺序执行,所以 `Thread.print` 不是一个“直接遍历 JavaThread 的函数”,而是一个**把三件 VM 级诊断工作串起来的薄编排器**。

---

## 4. Help 与命令清单 — help 也走同一张 factory 表

### `help` 不维护第二份命令清单

`HelpDCmd::execute`(diagnosticCommand.cpp:160-214)调用 `DCmdFactory::DCmd_list(source)` 或按名称调用 `DCmdFactory::factory(source, ...)`。因此 `jcmd <pid> help` 展示的命令集合和前一篇讲的 source/export/hidden 规则是同一份数据,不会另外维护一张 help 专用表。

`HelpDCmd` 的 parser 在 diagnosticCommand.cpp:147-153 注册了 `-all` option 与 `command name` argument;它支持三种形态:

- 无参数:列当前 source 可见的命令;
- `help -all`:列全部可见命令及 disabled 标记;
- `help VM.flags`:打印指定 factory 的描述、impact、permission 和具体 command help。

所以 help 本身也是一个普通 DCmd,只是它的 execute 读取的是 `DCmdFactory` 元数据。

### `VM.set_flag` 与 `help` 共同说明权限是元数据

`DCmdInfo` 在 diagnosticFramework.hpp:122-149 里暴露 name、description、impact、permission、argument count 和 enabled 状态。`HelpDCmd` 会把这些元数据打印出来;JMX 则通过 `DCmdInfo_list` 读取同一套信息。也就是说命令的“能不能远程调用、需要什么 Java Permission、对 VM 影响多大”不是命令输出临时猜的,而是 factory/command class 的静态元数据。

---

## 核心悬念

**内置 DCmd 不是一堆同质 wrapper:** `VM.version` 是纯读取,`VM.flags` 是 flag table 查询,`VM.set_flag` 经过 `WriteableFlags` 约束,`GC.run` 直达 heap collect,`GC.class_histogram` 和 `Thread.print` 会创建 VM 操作,`GC.heap_dump` 还会编排 full GC、压缩和文件输出。**下一篇看这些命令背后的 Attach 连接细节:** 本地 `jcmd` 怎样找到目标 JVM、怎样建立 socket、怎样把 attach operation 送到 listener。

> → [36-attach/01-attach-listener.md](openjdk/vol-02/36-attach/01-attach-listener.md)
