# async-profiler 详细交接文档

> 交接对象：下一个 AI
> 交接日期：2026-08-19
> 项目源码：`/data/workspace/source-code/code/spring/async-profiler/`
> 正式文章目录：`/data/workspace/source-code/openjdk-book/docs/openjdk/vol-async-profiler/`
> 当前状态：目录式写作仍是 **24 篇正文 + README/HANDOFF/HANDOFF-DETAILED**；但本卷已经进入**部分篇章完成方法论回炉、全卷尚未收口**的阶段。
> 
> 当前最重要的阶段摘要：
> 
> - AP-1、AP-2、AP-3、AP-4 前半（到 `04-stack-symbols/02-symbol-resolution.md`）已经完成至少一轮 `rewrite-plan -> deep review -> rewrite`，多数还做过一轮深修/回归。
> - AP-5、AP-6 现已完成一轮 `rewrite-plan -> deep review -> rewrite`，并进入二轮 deep review / consistency pass 候选集。
> - AP-0、AP-4 后半（`04-stack-symbols/03-04`）仍主要停留在事实稿/旧结构阶段，尚未进入本轮方法论回炉。
> - 所以下一任 AI 的工作重点不是补篇，而是先把**未回炉篇**继续纳入 `rewrite-plan -> deep review -> rewrite -> consistency pass`，再对 AP-5/AP-6 等已回炉篇做术语统一与一致性精修。 

---

## 1. 先读什么

按顺序阅读：

1. 本文档：`/data/workspace/source-code/openjdk-book/docs/openjdk/vol-async-profiler/HANDOFF-DETAILED.md`
2. **写作风格参考**：`/data/workspace/source-code/openjdk-book/docs/openjdk/WRITING-GUIDELINES.md`
3. **方法论复盘**：`/data/workspace/source-code/book/成长之路/tmp-question/training-camp/source-code/issue/源码范围规划复盘方法论.md`
4. 方法论通用档案：`/data/workspace/source-code/book/成长之路/tmp-question/training-camp/source-code/analysis/source-analysis/issue/源码分析深审缺陷档案.md`
5. 最新对照卷：`/data/workspace/source-code/openjdk-book/docs/openjdk/vol-arthas/`（已经完成整卷 `rewrite-plan -> deep review -> rewrite -> consistency pass`）
6. 卷入口：`/data/workspace/source-code/openjdk-book/docs/openjdk/vol-async-profiler/README.md`
7. 简版交接：`/data/workspace/source-code/openjdk-book/docs/openjdk/vol-async-profiler/HANDOFF.md`
8. 规划交接：`/data/workspace/source-code/book/成长之路/tmp-question/training-camp/source-code/analysis/source-analysis/async-profiler/HANDOFF-ASYNC-PROFILER.md`
9. 当前已生成的 `*.rewrite-plan.md` 文件，尤其是本次已回炉篇目的 plan 状态

不要把 `source-analysis/async-profiler/outlines/` 当成正式文章目录；那里仍然只是规划、questions、验证和深审输入材料。

---

## 2. 当前卷的真实阶段判断

### 2.1 不要再用旧判断

以下两类旧判断都已经**过时**：

- 把 24 篇正文统称为“都只是事实稿”；
- 把当前阶段统称为“整卷还没开始方法论回炉”。

它们曾经大体正确，但**现在不再准确**。

### 2.2 现在的正确判断

现在要把正文分成两类：

1. **已经完成至少一轮方法论回炉的篇**
   - 已经走过：`rewrite-plan -> deep review -> rewrite`
   - 多数还做过一次基于 review findings 的“深修 + 回归校验”
2. **仍主要停留在事实稿/旧结构的篇**
   - 可能事实正确
   - 但尚未按新方法论重写

所以，下一任 AI 接手时，不要再从“是否有 24 篇正文”这个维度判断进度，而要从：

- 哪些篇已有 `rewrite-plan.md`
- 哪些篇正文已经按问题驱动重写
- 哪些篇已经经过 deep review 修补
- 哪些篇还没开始方法论回炉

来判断。

---

## 3. 当前目录结构

```text
openjdk-book/docs/openjdk/vol-async-profiler/
  README.md
  HANDOFF.md
  HANDOFF-DETAILED.md
  00-usage/
    01-build-attach.md
    02-events-options.md
    03-output-flamegraph.md
    04-arthas-integration.md
  01-startup-attach/
    01-build-attach.md
    01-build-attach.rewrite-plan.md
    02-arguments-struct.md
    02-arguments-struct.rewrite-plan.md
    03-attach-fdtransfer.md
    03-attach-fdtransfer.rewrite-plan.md
  02-sampling-core/
    01-sampling-core.md
    02-event-engines.md
    02-event-engines.rewrite-plan.md
    03-allocation-events.md
    03-allocation-events.rewrite-plan.md
    04-lock-wall-events.md
    04-lock-wall-events.rewrite-plan.md
  03-jvm-integration/
    01-agent-jvmti.md
    01-agent-jvmti.rewrite-plan.md
    02-bytecode-rewriter.md
    02-bytecode-rewriter.rewrite-plan.md
    03-vmstructs-stackwalk.md
    03-vmstructs-stackwalk.rewrite-plan.md
    04-java-api-bridge.md
    04-java-api-bridge.rewrite-plan.md
  04-stack-symbols/
    01-register-walking.md
    01-register-walking.rewrite-plan.md
    02-symbol-resolution.md
    02-symbol-resolution.rewrite-plan.md
    03-frame-naming.md
    04-storage-alloc.md
  05-output-formats/
    01-flamegraph-html.md
    02-jfr-recorder.md
    03-otlp-converter.md
  06-java-api/
    01-java-api.md
    02-helper-closure.md
```

注意：`rewrite-plan.md` 只代表“已经进入方法论流程”，**不自动等于这篇已经彻底收口**。

---

## 4. 当前方法论回炉进度盘点

下面这部分是本次交接最重要的信息。

### 4.1 已完成 `rewrite-plan + deep review + rewrite`，且做过一轮深修/回归的篇

> 这里的“已回炉篇”表示：已经进入二轮 deep review / consistency pass 的候选集，**不是绝对禁止再改的定稿集**。下一任 AI 若发现术语漂移、桥接不一致、残余结构问题，仍然可以继续精修，但不要再把这些篇当成“从零开始是否需要 plan”的对象。

这些篇目已经不再是旧的事实稿形态，下一任 AI 不要从零重新审成“是否需要 plan”，而应当：

- 先读正文
- 再读同目录的 `*.rewrite-plan.md`
- 视需要做二轮 deep review 或一致性精修

#### 01 启动与 attach

- `01-startup-attach/01-build-attach.md`
  - 已重构成：“不能重启 JVM 时，采样器如何进门”
  - 已补：`jattach` 控制通道、HotSpot attach listener 唤醒、`fdtransfer` 启动屏障、C API 旁路
- `01-startup-attach/02-arguments-struct.md`
  - 已重构成：“一条参数串怎样变成运行配置”
  - 已补：`Arguments::parse()`、动作/输出/事件分层、`eventMask()`、默认值、`save()`、跨文件枚举契约
- `01-startup-attach/03-attach-fdtransfer.md`
  - 已重构成：“控制通道 vs 资源通道双通道进门”
  - 已补：`run_fdtransfer()` 生命周期、HotSpot attach 细节、fdtransfer 客户端闭环、`kallsyms` 旁路

#### 02 采样核心

- `02-sampling-core/01-sampling-core.md`
  - 已重构成：“样本进入记录链的主路径”
  - 已补：`CONCURRENCY_LEVEL=16`、单次尝试 3 槽、ASGCT/VM walker/JVMTI 分支、`recordExternal*` 差异、signal 自保护
  - **工件边界**：这篇正文已完成深修，但当前目录里还没有独立的 `01-sampling-core.rewrite-plan.md`；若下一任 AI 继续接手该篇，建议优先补齐这个 plan 工件，再做二轮 review
- `02-sampling-core/02-event-engines.md`
  - 已重构成：“来源语义先分叉，记录后端再统一”
  - 已补：`selectEngine()` / `selectAllocEngine()`、CPU perf/itimer/ctimer 选择、wall 双路径、native hooks 三类角色
- `02-sampling-core/03-allocation-events.md`
  - 已重构成：“JVM object family vs native memory family”
  - 已补：`selectAllocEngine()` 顺序、ObjectSampler + LiveRefs、AllocTracer trap 时序、malloc sample vs free event-only
- `02-sampling-core/04-lock-wall-events.md`
  - 已重构成：“等待语义 + 采样器自保护”
  - 已补：LockTracer monitor + park 路径、`CPU_ONLY/WALL_BATCH/WALL_LEGACY`、`recordWallClock()` 回灌时机、RateLimit/ThreadFilter/ProcessSampler 主线化

#### 03 JVM 集成

- `03-jvm-integration/01-agent-jvmti.md`
  - 已重构成：“bootstrap 与 attach 两条 JVM 集成时序”
  - 已补：`_global_args._preloaded`、`ready()` 先后顺序、OpenJ9 capability 分支、notification/ready/function-table 边界、`VM::tryAttach()` 旁路
- `03-jvm-integration/02-bytecode-rewriter.md`
  - 已重构成：“只插几条指令，为什么会牵动整套 class 文件”
  - 已补：`Instrument::start()` 时序、`ClassFileLoadHook` 双分支、`relocation_table` 是偏移增量表、第二遍只修 jump、Allocate 失败边界、retransform undo 边界
- `03-jvm-integration/03-vmstructs-stackwalk.md`
  - 已重构成：“地址归属 → JVM 地图 → walker 选路 → 逻辑帧恢复”
  - 已补：`resolveOffsets()` capability bits、`getNativeTrace()` 选路、`walkVM()` 前提、`patchSafeFetch()`/线程桥边界、CodeHeap/CodeCache 两级角色
- `03-jvm-integration/04-java-api-bridge.md`
  - 已重构成：“Java 世界只是桥，参数和执行真相仍在 native”
  - 已补：`execute0/execute1` vs `start0/stop0` 双入口、`OK` 返回契约、`RegisterNatives` 的 shaded 动机、Java/C API 载体差异

#### 04 栈与符号

- `04-stack-symbols/01-register-walking.md`
  - 已重构成：“寄存器快照 → 架构适配 → 中间态修正 → 防御性 FP 行走”
  - 已补：真实文件名 `stackFrame_x64.cpp`、AArch64 差异、`unwind*` 中间态链、`checkInterruptedSyscall()` 平台分叉、`unwindAtomicStub()` 边界
- `04-stack-symbols/02-symbol-resolution.md`
  - 已重构成：“库归属 → ELF 表 → debug fallback → PLT 修正 → ABI 解码”
  - 已补：`.symtab` / dynamic section / GNU hash、build-id / debuglink / debuginfod、`.plt` 合成、kernel symbols 旁路、Rust/C++ demangle 分流

### 4.2 已有事实稿，但还**没有**进入本轮方法论回炉的篇

这些篇目目前仍然更接近“事实正确 + 原理覆盖完整”的旧稿形态，下一任 AI 应优先按新方法论接手：

#### 00 使用与衔接（仍未回炉）

- `00-usage/01-build-attach.md`
- `00-usage/02-events-options.md`
- `00-usage/03-output-flamegraph.md`
- `00-usage/04-arthas-integration.md`

#### 04 栈与符号（尚未回炉）

- `04-stack-symbols/03-frame-naming.md`
- `04-stack-symbols/04-storage-alloc.md`

#### 05 输出格式（现已回炉）

- `05-output-formats/01-flamegraph-html.md`
- `05-output-formats/02-jfr-recorder.md`
- `05-output-formats/03-otlp-converter.md`

#### 06 Java API/helper（现已回炉）

- `06-java-api/01-java-api.md`
- `06-java-api/02-helper-closure.md`

---

## 5. 下一任 AI 的正确接手方式

### 5.1 不要再回到“先补篇”思维

本卷已经不存在“缺少主题版图”的问题。下一阶段**不是补篇优先**，而是：

1. 先把未回炉篇逐篇纳入 `rewrite-plan -> deep review -> rewrite`
2. 再做全卷一致性精修

### 5.2 推荐接手顺序

优先顺序建议如下：

1. `04-stack-symbols/03-frame-naming.md`
2. `04-stack-symbols/04-storage-alloc.md`
3. `00-usage/01-build-attach.md`
4. `00-usage/02-events-options.md`
5. `00-usage/03-output-flamegraph.md`
6. `00-usage/04-arthas-integration.md`
7. AP-5 / AP-6 已回炉篇的二轮 deep review / consistency pass

### 为什么这样排

- `04-frame-naming` 和 `04-storage-alloc` 仍是当前最典型的“事实重、容易被代码节点牵骨架”的未回炉篇。
- `00-usage` 仍偏面向用户；现在主干机制篇和输出/API 篇的术语已经进一步稳定，更适合整体回炉。
- AP-5 / AP-6 已完成一轮方法论回炉，后续应转入术语统一、桥接补强和一致性精修，而不是再当作未回炉篇从零开工。

---

## 6. 已知方法论问题分布

### 6.1 已回炉篇的现状

这些篇已经不再是旧稿，但仍可能有以下二轮精修空间：

- 某些篇还可以再补厚失败方案推演
- 个别篇的中段路标仍可更硬
- 某些篇的跨篇术语一致性还没全卷统一

### 6.2 未回炉篇的高概率问题

这些篇大概率仍有以下问题：

- 说明文/手册味重
- 代码节点牵骨架
- 缺少事故场景与读者困惑
- 失败方案不足
- “为什么不能更简单”没有打透
- 路标、收网和桥接还不够硬

---

## 7. 当前已知重要事实与边界（继续写作时必须尊重）

这些边界仍然有效，下一任 AI 不要重新踩坑：

- `src/main/main.cpp` 才是 CLI 入口，不是 `src/main` 目录本身。
- `run_jattach()` 在 `src/main/main.cpp:365-383`。
- `fdtransfer` 服务端在 `src/main/fdtransferServer_linux.cpp`。
- `recordSample()` 是核心，但不是唯一记录入口；还有 `recordExternalSample()`、`recordExternalSamples()`、`recordEventOnly()`。
- `CPU` 事件不是单一路径：perf / itimer / ctimer / cpuEngine 需要分开表述。
- `selectAllocEngine()` 决定 JVM alloc 前端；ObjectSampler 不是所有 JVM/模式的固定主入口。
- `AllocTracer` 不能笼统写成 alloc 主路径；它是 fallback/trap 路径。
- `lock` 事件不是“每次竞争都完整输出”，而是累计等待时间达到阈值后采样。
- `LockTracer::stop()` 不恢复 `Unsafe::park` hook（JDK-8369219）。
- `BytecodeRewriter` 是 instrumentation/latency 路径的手写改写器，不代表所有事件都改字节码。
- `VMStructs::ready()` 调的是 `resolveOffsets()`、`patchSafeFetch()`、`initThreadBridge()`，不是重新扫描全部 VMStructs 表。
- `execute0` 有文件时返回 `"OK"`，不是一律返回完整文本。
- `StackFrame` 不是纯 getter；它还承担一部分中间态修正。
- `stackFrame_x64.cpp` 才是当前 x86-64 文件，**不要再写成不存在的 `stackFrame_x86.cpp`**。
- `.plt`/relocation 名字合成只在 `use_debug` 分支下处理。
- kernel symbol 路径是 `/proc/kallsyms` 旁路，不是普通 ELF 文件路径。
- `FlameGraph` 的 Trie 是输出期前缀聚合，不是 `CallTraceStorage` 的 hash 表，也不是浏览器 tree view 的 DOM。
- `minwidth` 在输出阶段 cutoff，不改采样期计数。
- `recordEvent()` 常态写 `RecordingBuffer`，但 flush 可在同一路径触发。
- JFR stack/method/class/symbol pools 在 chunk 结束阶段补齐，不是事件写入时完整物化。
- OTLP 当前只提供最小兼容 dictionary，不是完整 OTel resource/profile exporter。
- `Recording.getThreadLocalBuffer()` 暴露的是 native TLD 的 `DirectByteBuffer` 视图，不是稳定 Java 对象。

---

## 8. 交接给下一任 AI 的推荐工作流

### 对于未回炉篇

必须严格按：

1. 读正文现稿
2. 读关键源码
3. 写 `*.rewrite-plan.md`
4. 做 deep review（先出 findings）
5. 再重写正文
6. 再做一轮深修/回归校验

### 对于已回炉篇

不要直接重写。先做：

1. 读正文
2. 读同目录 `*.rewrite-plan.md`
3. 再做一次针对性的二轮 deep review
4. 只有确认有明显结构/事实/边界问题，才继续修改

### 绝对不要做的事

- 不要再回到“先补篇，再说方法论”的旧路线
- 不要因为篇目已经存在，就跳过 `rewrite-plan`
- 不要边审边改，必须先出 deep review 再动手
- 不要把“已经有 facts”误判成“已经收口”

---

## 9. 推荐验证命令

在 `/data/workspace/source-code/openjdk-book` 下执行：

### 检查目录式链接

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

### 检查文章数量

```bash
find docs/openjdk/vol-async-profiler -type f -name '*.md' | sort
```

### 检查 rewrite-plan 覆盖

```bash
find docs/openjdk/vol-async-profiler -type f -name '*.rewrite-plan.md' | sort
```

### 检查每篇结构标记

```bash
grep -R -n '场景：\|关键设计（斜体）\|\[模式:\|跨层标注' docs/openjdk/vol-async-profiler
```

### 检查关键源码路径

```bash
find /data/workspace/source-code/code/spring/async-profiler/src -maxdepth 2 -type f | sort
```

### 检查交接文档状态一致性

```bash
grep -rn '部分篇章完成方法论回炉、全卷尚未收口' docs/openjdk/vol-async-profiler/HANDOFF-DETAILED.md
grep -rn '已回炉篇' docs/openjdk/vol-async-profiler/HANDOFF-DETAILED.md
grep -rn '仍待进入方法论回炉的篇' docs/openjdk/vol-async-profiler/HANDOFF-DETAILED.md
```

---

## 10. 接手后的最短正确动作

如果你是下一任 AI，推荐第一步直接做：

1. 读本文档
2. 读 `WRITING-GUIDELINES.md`
3. 打开 `05-output-formats/01-flamegraph-html.md`
4. 先写它的 `01-flamegraph-html.rewrite-plan.md`
5. 再做该篇 deep review

不要直接改正文。

---

## 11. 当前交接总结

### 已进入方法论回炉并深修过的篇

- `01-startup-attach/01-build-attach.md`
- `01-startup-attach/02-arguments-struct.md`
- `01-startup-attach/03-attach-fdtransfer.md`
- `02-sampling-core/01-sampling-core.md`
- `02-sampling-core/02-event-engines.md`
- `02-sampling-core/03-allocation-events.md`
- `02-sampling-core/04-lock-wall-events.md`
- `03-jvm-integration/01-agent-jvmti.md`
- `03-jvm-integration/02-bytecode-rewriter.md`
- `03-jvm-integration/03-vmstructs-stackwalk.md`
- `03-jvm-integration/04-java-api-bridge.md`
- `04-stack-symbols/01-register-walking.md`
- `04-stack-symbols/02-symbol-resolution.md`

### 仍待进入方法论回炉的篇

- `00-usage/*`
- `04-stack-symbols/03-frame-naming.md`
- `04-stack-symbols/04-storage-alloc.md`

这就是下一阶段仍未回炉的主战场。

### 已在本轮完成回炉、待二轮一致性精修的篇

- `05-output-formats/01-flamegraph-html.md`
- `05-output-formats/02-jfr-recorder.md`
- `05-output-formats/03-otlp-converter.md`
- `06-java-api/01-java-api.md`
- `06-java-api/02-helper-closure.md`
