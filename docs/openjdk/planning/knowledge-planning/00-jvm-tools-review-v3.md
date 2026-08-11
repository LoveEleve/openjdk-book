# 域 00 深度 REVIEW 报告 v3 — 字段级契约 + 工具侧对照 + 素材就绪度

> 2026-08-11 | v3 | 依据: jfr metadata 字段级抽查 + async-profiler 源码(jfrMetadata.cpp)事件输出对照 + Arthas KP 命令映射 + 素材实测盘点
> 层级说明: v1=工具→域, v2=事件→域(170 契约), v3=**字段级契约 + 工具侧对照完成度 + 素材就绪度**

---

## 一、事件字段级契约(抽查 5 个关键事件,写作引用字段名用)

> 字段是"事件内部契约"——写文章引用字段名比笼统说"事件"精确。

| 事件 | 关键字段(实测) | 写作用途 |
|---|---|---|
| jdk.SafepointBegin | startTime(TICKS)/duration(TICKS)/eventThread/**SafepointId/safepoint 类型字段** | 域 18: "safepoint 耗时 = duration 字段" |
| jdk.GCPhasePause | startTime/duration/eventThread/**GCId/name** | 域 25: "GC pause = duration + GCId 关联" |
| jdk.Compilation | compileId(Unsigned@CompileId)/**Compiler/C1 or C2 标志**/方法/字节码大小 | 域 13: "compileId 是编译批次主键" |
| jdk.ExecutionSample | startTime/sampledThread/stackTrace/**state**(STATE_RUNNABLE/INTERPRETED 等) | 域 08/24: "state 区分解释/编译执行" |
| jdk.JavaMonitorEnter | startTime/duration/eventThread/stackTrace/**monitorClass** | 域 19: "阻塞时长 + 锁对象类" |

> 结论: 字段级契约完整可用,写作素材可直接引用字段名(如 "GCPhasePause.duration" 跨 GCId 关联)。

---

## 二、async-profiler JFR 输出 vs JDK 事件(格式兼容实证)

**async-profiler 写的 JDK 事件(源码实测, 15 个)**:
jdk.ExecutionSample / GCHeapSummary / ThreadPark / JavaMonitorEnter / ObjectAllocationInNewTLAB / ObjectAllocationOutsideTLAB / CPULoad / CPUInformation / OSInformation / JVMInformation / ActiveRecording / ActiveSetting / InitialSystemProperty / NativeLibrary + **自定义 jdk.MethodTrace**(jfrMetadata.cpp 实证)

**对照结论**:
- async-profiler 用 **JDK 事件名**写入(子集 15/170)——JMC/JFR CLI 能直接读它的输出 = **格式兼容的实证**(域 32 格式契约,AP-5 jfrMetadata 对齐)
- **差异面**: async-profiler 不写 GC/编译/safepoint 事件(那是 JDK 专属)——它写的是"采样/锁/分配"面;JDK JFR 写"全生命周期"面——**两工具输出互补,不是竞争**
- **写作价值**: 域 32 文章可引用"同一 .jfr 文件两种读者 + 两种写者"——JDK 写全量、async-profiler 写子集+MethodTrace,格式契约是共同基础

---

## 三、Arthas 命令 → JVM 域映射(工具侧对照补全)

> 与 JMC 29 页签、jcmd 50 命令并列的第三张"命令→域"表

| Arthas 命令 | JVM 域 | 对照素材 |
|---|---|---|
| thread / thread -b | 17-threads、19-sync | jstack/JMC ThreadsPage/LockInstancesPage 三对照 |
| dashboard | 33-jmx、09-memory | jconsole/JMC 实时控制台 |
| jvm | 33-jmx | MBean 树清单 |
| vmoption | 03-flags | jcmd VM.flags/VM.set_flag |
| memory | 09-memory | jmap -histo/JMC HeapPage |
| heapdump | 37-heap-dumper | jmap -dump/jcmd GC.heap_dump/MAT |
| profiler | 32-jfr、18-safepoint | async-profiler/JFR/火焰图 |
| sc / jad / dump-class | 07-classfile、08-interpreter | javap -v(同字节码面) |
| trace / watch | 28-jvmti、47-instrumentation | JVMTI 事件面(字节码插桩) |
| monitor | 19-sync、21-runtime | JavaMonitorEnter 事件 |
| ognl | 31-unsafe(间接) | 表达式引擎(无域直接对应) |
| logger / sysprop / sysenv | 04-logging、03-flags | jcmd VM.log/VM.system_properties |
| redefine / retransform | 28-jvmti、47-instrumentation | ClassRedefinition 事件 |

> 结论: Arthas 的命令面集中在"类/线程/锁/内存/字节码"——与 JMC/jcmd 的覆盖面**高度重叠但视角不同**(Arthas=应用层增强,JDK 工具=原生层);域 31-unsafe 唯一间接入口是 Arthas ognl。

---

## 四、43 域素材就绪度盘点(连接 REVIEW 与实操)

> 就绪 = 已有实测输出可直接引用;半就绪 = 有数据但需阶段实操补全;空 = 无任何实测素材

| 状态 | 域 | 已有素材 |
|---|---|---|
| ✅ 就绪 | 01/03/07/09/10/13/16/17/18/20/22/24/25/26/32/43/48(17 域) | rec-demo.jfr 90 类事件(SafepointBegin 2710 条等)+ jcmd 实测输出 |
| 🟡 半就绪 | 06/37(有 heap.hprof + MAT 报告,未做 histo/支配树深度分析)、19(jsnap 锁计数有,LockInstancesPage 截图无)、41(jimage/jlink 有,截图无)、38(jsnap 有)、28/47(事件名有,实测无) | 待阶段 3/5/1 补 |
| 🔴 空 | 02-assembler、04-logging(VM.log 语法有,配置输出无)、08(有 state 字段但无 INTERPRETED 采样实证)、11-cds、12-ci、14-c1、15-c2(CompilerInlining 未触发)、21、23、27、29、30、31、34、40、42、44、45、46、47 | 需阶段 2/4/5 补或接受"源码分析域"定位 |
| ✗ 无途径 | 05、29、30、31、45 | 走源码分析(已定) |

**关键行动**:
1. 阶段 1 收尾 = 补 19/28/47 页签截图(LockInstancesPage 等)
2. 阶段 4 = 补 15-c2 素材(CompilerInlining 需触发内联,用 busy demo + LogCompilation)
3. 阶段 5 = 补 06 对象头截图 + 46 SA
4. 08-interpreter 实证: 用解释执行模式(`-Xint` demo)录 JFR → ExecutionSample state=INTERPRETED

---

## 五、建议行动(v3)

1. **素材目录规范**: `materials/screenshots/`(已建)+ `materials/commands/`(命令输出文本归档)——素材统一入库
2. **素材就绪度表进入 KP**: 05 节后新增"素材就绪度"节(四表),实操时按表补缺
3. **08 解释器实证任务**: `-Xint` demo 录 JFR,拿到 state=INTERPRETED 样本(阶段 1 顺手完成)
4. **async-profiler 输出对照入篇 1**: "两种写者"素材(JMC/jfr 读同一个文件,JDK 写 170 事件、AP 写 15+MethodTrace)
5. **Arthas 命令→域表入 KP 02 节**: 三张命令→域表并列(JMC 29 页签/jcmd 50 命令/Arthas 命令)
