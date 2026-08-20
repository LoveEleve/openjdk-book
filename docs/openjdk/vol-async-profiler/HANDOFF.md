# async-profiler 正式写作交接文档

> 交接对象：下一个 AI
> 交接日期：2026-08-19
> 项目源码：`/data/workspace/source-code/code/spring/async-profiler/`
> 正式文章：`/data/workspace/source-code/openjdk-book/docs/openjdk/vol-async-profiler/`
> 当前状态：目录式写作仍是 **24 篇正文**；AP-0~AP-6 主题版图已全部收束；但当前卷已经进入**部分篇章完成方法论回炉、全卷尚未收口**的阶段。下一任 AI 不应再把 24 篇统称为“都只是事实稿”，而应区分：哪些篇已进入 `rewrite-plan -> deep review -> rewrite`，哪些篇仍待回炉。

## 1. 先读什么

按顺序阅读：

1. 本文件：`/data/workspace/source-code/openjdk-book/docs/openjdk/vol-async-profiler/HANDOFF.md`
2. 卷入口：`/data/workspace/source-code/openjdk-book/docs/openjdk/vol-async-profiler/README.md`
3. 规划交接：`/data/workspace/source-code/book/成长之路/tmp-question/training-camp/source-code/analysis/source-analysis/async-profiler/HANDOFF-ASYNC-PROFILER.md`
4. 方法论通用档案：`/data/workspace/source-code/book/成长之路/tmp-question/training-camp/source-code/analysis/source-analysis/issue/源码分析深审缺陷档案.md`
5. 写作风格参考：`/data/workspace/source-code/openjdk-book/docs/openjdk/WRITING-GUIDELINES.md`
6. 目录结构参考：`/data/workspace/source-code/openjdk-book/docs/openjdk/vol-02/`、`vol-java/`

不要把 `source-analysis/async-profiler/outlines/` 当成正式文章目录；那里是规划和验证材料。正式成文只放 `openjdk-book/docs/openjdk/vol-async-profiler/`。

## 2. 当前正式文章

### AP-0 使用与衔接

- `00-usage/01-build-attach.md`
  - `make` → `build/bin/asprof`、PID/`jps`/应用名三种目标写法、`-d 30` 与 `start/stop` 两种工作流
  - 已约束：命令示例以当前 `README.md`、`docs/GettingStarted.md` 为准，不把规划稿里的旧命令写成现状事实
- `00-usage/02-events-options.md`
  - `-e cpu/alloc/lock/wall` 四类问题入口、`-d/-f/-i` 三颗常用旋钮、线程/过滤/`--memlimit` 的使用边界
  - 已约束：只把容器/perf 权限写成使用层提醒，不在 AP-0 提前展开源码机制细节
- `00-usage/03-output-flamegraph.md`
  - flamegraph/tree/collapsed/jfr/otlp 的消费方区分、JFR + `jfrconv` 离线工作流、火焰图读法
  - 已约束：`reverse`/`inverted`、`minwidth` 只讲使用语义，不把输出阶段行为误写成采样期机制
- `00-usage/04-arthas-integration.md`
  - Arthas 命令层与 async-profiler native 内核的上下层关系、先全景后下钻的排查路径、容器与权限边界
  - 已约束：明确 Arthas AR-6 只覆盖 Java 命令层，async-profiler 才是 native 采样引擎本体

### AP-1 启动与参数

- `01-startup-attach/01-build-attach.md`
  - CLI/main 入口、attach、参数交付、后续 native 入口
  - 重要路径：`src/main/main.cpp`、`src/arguments.cpp`
  - 已修复历史误写：入口是 `src/main/main.cpp`，不是 `src/main` 或 `main.cpp` 根目录
- `01-startup-attach/02-arguments-struct.md`
  - `Arguments::parse()`、8 类枚举、配置字段、单位和 timeout 解析
- `01-startup-attach/03-attach-fdtransfer.md`
  - `jattach`、load 归约、fdtransfer、perf fd 权限桥、collect 编排
  - fdtransfer 源码：`src/main/fdtransferServer_linux.cpp`

### AP-2 采样引擎

- `02-sampling-core/01-sampling-core.md`
  - `Profiler::recordSample()`、RateLimit、tryLock、ASGCT、JVMTI 回退、信号注册
- `02-sampling-core/02-event-engines.md`
  - CPU、alloc、lock、wall、native memory 的前端引擎分流
  - 已修复：`allocTracer` 不再被夸写成 alloc 主路径，只描述为 native 辅助路径
- `02-sampling-core/03-allocation-events.md`
  - AllocTracer、ObjectSampler、MallocTracer、hooks 和 `--live` 的边界
  - 已修复：`dumpLiveRefs()` 的定义位置与 stop 调用位置已区分
- `02-sampling-core/04-lock-wall-events.md`
  - LockTracer、WallClock、RateLimit、ProcessSampler、ThreadFilter
  - 已完成 lock/wall/AP-2 采样前端收束

当前正式文章总数：**24 篇**

AP-2 的 4 篇规划大纲已全部完成正式文章：

- `02-sampling-core/01-sampling-core.md`
- `02-sampling-core/02-event-engines.md`
- `02-sampling-core/03-allocation-events.md`
- `02-sampling-core/04-lock-wall-events.md`

### AP-3 JVM 集成

已完成：

- `03-jvm-integration/01-agent-jvmti.md`
  - Agent_OnLoad/OnAttach、JVMTI capabilities、16 个回调、VMInit/redefine hook
- `03-jvm-integration/02-bytecode-rewriter.md`
  - 手写 BytecodeRewriter、latency 插桩、relocation_table、StackMapTable
- `03-jvm-integration/03-vmstructs-stackwalk.md`
  - VMStructs 偏移、FP/DWARF/VM 栈行走和 CodeCache
- `03-jvm-integration/04-java-api-bridge.md`
  - execute0/execute1、RegisterNatives、shaded 兼容、C API 对照

### AP-4 栈与符号

已完成：

- `04-stack-symbols/01-register-walking.md`
  - StackFrame 寄存器访问、FP 链和安全边界
- `04-stack-symbols/02-symbol-resolution.md`
  - ELF 符号表、build-id/debuglink、demangle 和地址归属
- `04-stack-symbols/03-frame-naming.md`
  - Java jmethodID 命名、classMap、native demangle 和类型后缀
- `04-stack-symbols/04-storage-alloc.md`
  - `LinearAllocator`（CAS 推进 + reserve/tail 双槽）、`CallTraceStorage`（hash 去重 + 翻倍扩容）、`--memlimit` 停止接收新栈、`_overflow_trace` 哨兵、`storeCallTrace()` 失败与 overflow 是两条不同降级链

### AP-5 输出格式

已完成：

- `05-output-formats/01-flamegraph-html.md`
  - `CallTraceStorage` → `FrameName` → `FlameGraph` Trie → cpool/frame stream → `flame.html` Canvas/tree view
  - 已核对：默认视图是 Canvas，tree view 才构造 DOM；`minwidth` 在输出阶段过滤，不是采样期丢样；`reverse` 与 `inverted` 分属 native 栈顺序和浏览器绘制方向
- `05-output-formats/02-jfr-recorder.md`
  - `Recording` chunk/header/metadata/settings/cpool 手写 JFR writer
  - `recordEvent()` 通过 `lock_index` 进入并发 buffer；满缓冲会直接 flush/write
  - `writeStackTraces()`/`Lookup`/constant pool 在 chunk 结束时补齐
  - `--jfrsync` 是 JDK master recording + async-profiler 临时 recording，停止时 append 到目标文件
- `05-output-formats/03-otlp-converter.md`
  - `dumpOtlp()` 直接消费 `CallTraceStorage`，不经 JFR 中转
  - `ProtoBuffer` + `otlp.h` 字段常量手写 OTLP Profiles protobuf
  - dictionary-first：stack/function/location/string/attribute 先建索引，sample body 再引用
  - 当前边界：dummy mapping/link、仅 thread attribute、函数名级 location、另有 JFR→OTLP 的离线 Java converter

AP-5 已全部完成。

### AP-6 Java API

已完成：

- `06-java-api/01-java-api.md`
  - `AsyncProfiler.getInstance()` 的五级找库与预加载探针
  - `execute` 家族如何把 native `Arguments::parse()` 协议投影成 Java 便利方法
  - `Recording` 作为 state/clock/span helper，而不是主 profiler 入口
  - Java API / MXBean / C API 共用同一个 native 内核
- `06-java-api/02-helper-closure.md`
  - `Instrument` / `LockTracer` / `Recording` / `Span` / `JfrSync` 作为 Java 世界的最小收件箱
  - BytecodeRewriter、trusted RegisterNatives、DirectByteBuffer/TLS、clock bridge 与业务 span 的闭环
  - 已修正：`Span.endIfProfiled()` 只看 profiling sample 是否命中，不做业务语义判断；`Recording.getThreadLocalBuffer()` 暴露的是 native TLD 视图

AP-6 已全部完成。

## 4. 目录规范

必须对齐 `vol-02` / `vol-java`：

```text
vol-async-profiler/
  README.md
  HANDOFF.md
  00-usage/
    01-build-attach.md
    02-events-options.md
    03-output-flamegraph.md
    04-arthas-integration.md
  01-startup-attach/
    01-build-attach.md
    02-arguments-struct.md
    03-attach-fdtransfer.md
  02-sampling-core/
    01-sampling-core.md
    02-event-engines.md
    03-allocation-events.md
    04-lock-wall-events.md
  03-jvm-integration/
    01-agent-jvmti.md
    ...
```

不要创建：

```text
vol-async-profiler/ch06.md
vol-async-profiler/ch07.md
```

每个主题目录内从 `01-...md` 重新编号，不使用全卷连续编号。文章间链接必须使用相对路径，例如：

```text
01-sampling-core/01-sampling-core.md
01-startup-attach/03-attach-fdtransfer.md
```

## 5. 每篇文章必须遵守的方法论

每篇正式文章至少包含：

1. 真实生产场景，显式以 `场景：` 开头；
2. 源码文件路径、行号和方法名；
3. `关键设计（斜体）：`；
4. `[模式: ...]` 显式模式标注；
5. 跨层标注，async-profiler 优先使用 `[C++:/Linux:/perf_events:/x86:/JVMTI:/JFR:]` 语义；
6. 篇末总结、核心问题或下一篇桥；
7. 正文不能把规划中的推断写成源码事实；
8. 对 native 项目优先逐文件核验，尤其防止“文件名推断机制”。

async-profiler 的高风险 REVIEW 类型：

- 文件名推断错误；
- 把 JVMTI 事件误写成字节码插桩；
- 把 `ctimer`、`itimer`、perf、signal 混成同一路径；
- 把 Arthas 命令层能力误写成 async-profiler native 能力；
- 把 JFR/OTLP/flamegraph 的输出消费者混为一谈；
- 把“设计意图”误写成所有平台都必然成立的实现保证。

## 6. 当前已知事实与边界

- async-profiler 本体是 native 采样引擎，不是 Arthas 的 Java 命令层。
- Arthas AR-6 只覆盖 `ProfilerCommand → AsyncProfiler.execute()` 委托层。
- `Arguments::parse()` 在 `src/arguments.cpp:41-60`；CASE 表从 `:62` 起。
- `Arguments` 枚举和字段在 `src/arguments.h:30-288`。
- `run_jattach()` 在 `src/main/main.cpp:365-383`。
- CLI 动作/事件识别在 `src/main/main.cpp:415-470`。
- fdtransfer 注释和 perf buffer map 在 `src/main/fdtransferServer_linux.cpp:134-157`。
- `Profiler::recordSample()` 在 `src/profiler.cpp:402-493`。
- ASGCT 路径在 `src/profiler.cpp:350-385`。
- JVMTI 栈回退在 `src/profiler.cpp:387-399`。
- 信号注册在 `src/profiler.cpp:687-709`。
- perf_event 路径在 `src/perfEvents_linux.cpp:602-639`。

## 7. 继续写作的标准流程

以 AP-2 allocation 为例：

1. 读大纲：`source-analysis/async-profiler/outlines/ap2-sampling-engine/03-allocation-events.md`
2. 逐项读取对应源码文件；
3. 确认真实目录已存在，不要凭文件名猜路径；
4. 创建正式文件：`openjdk-book/docs/openjdk/vol-async-profiler/02-sampling-core/03-allocation-events.md`
5. 写正文，保持目录式编号；
6. 做第 1 轮 REVIEW：路径、行号、方法、数字；
7. 做第 2 轮 REVIEW：语义、平台边界、并发/信号安全；
8. 做第 3 轮 REVIEW：跨文章引用、方法论结构、措辞强度；
9. 发现问题就修复，再从对应轮次重新复验；
10. 更新 `README.md` 和本 `HANDOFF.md` 的完成状态。

## 8. 验证清单

从 `/data/workspace/source-code/openjdk-book` 执行：

```bash
find docs/openjdk/vol-async-profiler -maxdepth 2 -type f -name '*.md' | sort
```

检查所有相对链接：

```bash
python3 - <<'PY'
from pathlib import Path
import re
root = Path('docs/openjdk/vol-async-profiler')
for p in root.rglob('*.md'):
    for link in re.findall(r'\]\((\.\.?/[^)]+\.md)\)', p.read_text()):
        target = (p.parent / link).resolve()
        if not target.exists():
            print('BROKEN', p, link)
PY
```

检查每篇结构：

```bash
grep -R -n '场景：\|关键设计\|跨层标注' docs/openjdk/vol-async-profiler
```

检查 async-profiler 源码路径：

```bash
find /data/workspace/source-code/code/spring/async-profiler/src -maxdepth 2 -type f | sort
```

不要只检查文件名；必须打开文件核验方法和语义。

## 9. Arthas 参考卷

Arthas 已完成并已目录式迁移，可作为写作和 REVIEW 参考：

```text
/data/workspace/source-code/openjdk-book/docs/openjdk/vol-arthas/README.md
/data/workspace/source-code/openjdk-book/docs/openjdk/vol-arthas/HANDOFF.md  # 如存在，应优先读
```

Arthas 关键经验：每篇写完就 REVIEW；不能把“锚点存在”当成“语义正确”；要特别检查设计意图与当前实现的差异。

## 10. 当前下一步

优先执行：

```text
不要再补主题版图
→ 先处理未进入方法论回炉的篇：04-stack-symbols/03-04、00-usage/*
→ `05-output-formats/*`、`06-java-api/*` 已完成一轮 rewrite-plan -> deep review -> rewrite，后续以二轮 deep review / consistency pass 为主
→ 最后统一做 README / HANDOFF / 交叉引用 / 全卷一致性精修
```

不要把“已回炉篇”误判成绝对禁改；也不要把“已有正文”误判成“无需 plan”。有 `*.rewrite-plan.md` 的篇应先读 plan，再读正文，再决定是否做二轮 review。
