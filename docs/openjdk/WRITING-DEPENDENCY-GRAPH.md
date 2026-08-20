# 源码正文写作依赖图谱

> 目标：为正文写作顺序、篇章前置依赖和后续知识脑图提供唯一的关系口径。
> 依赖定义：这里记录的是**读者理解依赖**，不是简单的源码 import 关系。

## 一、关系类型

### `HARD`

没有前置概念就无法理解当前文章主线。必须先写，或在当前文章开头补齐最小前置解释。

### `SOFT`

当前文章可以用局部解释完成闭环，但前置文章能显著降低认知负担。可作为链接和复用，不强制阻塞写作。

### `NAV`

只建立导航关系，不把后置文章的结论提前当成事实。适用于横向对照、工具视角和后续展开。

### `COMPARE`

两个机制存在可验证的对照关系，但没有先后依赖。用于知识脑图横向连接。

### `CONSUMES`

当前域消费另一个域产出的 API/协议/数据，但不等于读者必须先读完被消费域的全部内容。

## 二、OpenJDK 48 域写作拓扑

权威来源：`planning/knowledge-planning/00-domain-writing-order.md`。

```text
L0 地基:
01-os, 05-cpu-primitives, 45-math-library, 48-utilities

L1 原语:
02-assembler <- 05
03-arguments-flags <- 01
04-logging <- 01
06-oops <- 01,05
16-code-cache <- 01
38-perfdata <- 01
41-zip-jimage <- 01
42-core-native <- 01

L2 对象/类/线程:
07-classfile-classloader <- 06
09-memory-core <- 06
17-threads <- 01,05

L3 执行/帧/锁:
10-metaspace <- 07,09
19-synchronization <- 06,17
23-stub-routines <- 02,16
24-frame-stack <- 06,17
08-interpreter <- 06,07,02,24
31-unsafe <- 06,09
44-class-verification <- 07

L4 VM 核心:
11-cds <- 07,10
12-ci <- 06,07,24
13-jit <- 08,16
18-safepoint <- 17,24
20-vm-operations <- 17,18
27-jni <- 17,24
30-jvm-entry-points <- 08,02
32-jfr <- 06,13,17,18,24
34-nmt <- 01,09
36-attach <- 01,17
37-heap-dumper <- 06,09,18
39-runtime-monitoring <- 17,38
46-sa-postmortem <- 06,09,24

L5 JIT/GC 主体:
14-c1 <- 13,16,24
15-c2 <- 12,13,16,24
21-shared-runtime <- 06,13,24
25-gc-framework <- 06,09,17,18,24
28-jvmti <- 17,24,36
29-method-handles <- 06,07,13
33-jmx-management <- 09,39
43-nio-net <- 42

L6 上层:
22-deoptimization <- 15,24
26-g1 <- 09,18,25
35-diagnostic-commands <- 33,36
40-launcher <- 03,27,41
47-instrumentation <- 07,28
```

## 三、拓扑规则

- 依赖域必须先于当前域进入正文，除非标记为 `SOFT` 或 `NAV`。
- 同一层可以自由调整，但调整必须记录理由。
- `06 ↔ 07` 是概念循环：教学顺序固定 `06 → 07`。
- `17 ↔ 19` 是概念循环：教学顺序固定 `17 → 19`。
- 工具卷不是 OpenJDK 域的硬前置；工具素材作为正文中的验证/场景引用。
- 文章只允许引用已完成分析或已明确标记为 `NAV` 的后置域。

## 四、正文篇级依赖模型

每篇正文必须在头部或写作元数据中声明：

```yaml
id: 48-utilities-01-vmerror
hard_prerequisites:
  - 01-os-04-signals-and-safepoint
soft_prerequisites:
  - 05-cpu-01-atomic-and-memory-order
navigation:
  - 46-sa-postmortem
consumes:
  - 48-utilities-03-stream-exception
outbound:
  - 02-assembler-01-codebuffer-abstract-assembler
```

字段含义：

- `id`：稳定节点 ID，供知识脑图使用
- `hard_prerequisites`：必须先具备的文章
- `soft_prerequisites`：可复用但不阻塞的文章
- `navigation`：后续导航，不提前讲后文结论
- `consumes`：当前文章实际消费的接口/协议/数据
- `outbound`：篇末自然引出的下一篇或下一域

## 五、跨框架知识网络边

### 已确认的跨域边

- `Arthas AR-1` `COMPARE` `OpenJDK 36-attach/47-instrumentation`
- `Arthas AR-2` `CONSUMES` `OpenJDK 28-jvmti/47-instrumentation`
- `async-profiler AP-2` `CONSUMES` `OpenJDK 18-safepoint/24-frame-stack`
- `async-profiler AP-3` `CONSUMES` `OpenJDK 28-jvmti/16-code-cache`
- `async-profiler AP-4` `CONSUMES` `OpenJDK 24-frame-stack`
- `Micrometer MI-4` `CONSUMES` `Micrometer MI-1`
- `Micrometer MI-5` `CONSUMES` `Micrometer MI-1/MI-2/MI-3`
- `Micrometer Tracing MT-1` `CONSUMES` `Micrometer MI-6`
- `Spring Cloud Commons` `CONSUMES` `Spring Framework / Spring Boot`
- `Spring Cloud Gateway` `CONSUMES` `Spring Cloud Commons` load-balancer/discovery abstractions
- `Spring Cloud OpenFeign` `CONSUMES` `Feign` + `Spring Cloud Commons`
- `Spring Cloud Alibaba A-3/A-4/A-5` `CONSUMES` `Sentinel` 对应流控/熔断/网关适配器
- `Curator` `CONSUMES` `ZooKeeper` 会话/watch/节点机制
- `SofaJRaft` `COMPARE` `ZooKeeper` ZAB/一致性机制
- `ShardingSphere SS-2` `CONSUMES` `ShardingSphere infra/rewrite`
- `ShardingSphere SS-6` `CONSUMES` `ShardingSphere SS-2` rewrite decorator 扩展点
- `XXL-Job XJ-2` `CONSUMES` `XXL-Job XJ-1` TriggerParam 协议
- `XXL-Job XJ-4` `CONSUMES` `XXL-Job XJ-1/XJ-2` broadcast 参数传播

### 未经验证不得创建的边

- 只因两个项目都出现相同类名，不建立依赖边
- 只因两个项目都使用线程/锁，不建立实现复用边
- 只因文章篇末提到另一个域，不把它升级为硬前置
- 只因执行计划相邻，不推断存在源码或认知依赖

## 六、知识脑图节点与边格式

建议每篇正文对应一个稳定节点：

```text
Node:
  id: openjdk.24-frame-stack.01
  title: Frame 与栈帧
  domain: 24-frame-stack
  status: planned|outline|draft|reviewed|published
  source: jdk11u

Edge:
  from: openjdk.18-safepoint.01
  to: openjdk.24-frame-stack.01
  type: HARD|SOFT|NAV|COMPARE|CONSUMES
  reason: 停顿/采样流程需要理解帧遍历
  evidence: planning/knowledge-planning/00-domain-writing-order.md:37
```

## 七、正文写作前的依赖审查

每篇开始前检查：

- [ ] 当前节点 ID 唯一
- [ ] HARD 前置节点已经存在且状态至少为 `reviewed`
- [ ] 所有前置理由有源码/规划证据
- [ ] 没有把 NAV 误写成 HARD
- [ ] 没有引用未分析域的未验证结论
- [ ] `outbound` 指向真实存在或明确规划中的节点
- [ ] 依赖边不形成未解释的环
- [ ] 跨框架引用标记为 `COMPARE` 或 `CONSUMES`
- [ ] 正文头部声明与知识脑图边一致

## 八、当前执行策略

- OpenJDK 正文严格按 L0 → L6 拓扑推进。
- 本轮实际目录穷举已统一数字口径：核心 OpenJDK 机制域为 48 个、核心文章大纲 152 篇；另有工具域 `00-jvm-tools`，包含 7 篇工具文章。因此全部域目录为 49 个、全部文章大纲为 159 篇。旧 `HANDOFF-JVM-WRITING.md` 中的 49/49 域、158 篇大纲不准确，不得继续沿用。

- 先完成正文写作方法论与依赖图谱，再开始文章。
- 每篇文章写完后更新节点状态和边证据，不等整卷结束再补图谱。
- 若正文发现新硬依赖，暂停当前篇，回填依赖图，重新验证拓扑，再继续。
