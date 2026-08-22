# HANDOFF — BIN 方法论重写交接文档

> 更新时间：2026-08-20
> 仓库：`/data/workspace/source-code/openjdk-book`
> 工作目录：`/data/workspace/source-code/openjdk-book`
> JDK 11 源码树：`/data/workspace/source-code/code/spring/jdk11/src`
> 用途：交给下一位 AI，继续按 BIN 技术作者方法论和项目写作规范，推进 `docs/openjdk/vol-java/` 正文系统性重写。

---

## 1. 当前总目标

本轮工作的核心目标不是"把源码讲对"，而是：

> **把旧的事实卡片式/源码平铺式文章，重写成删掉代码后仍然成立的技术文章。**

统一写法必须遵守：

- 先有读者困惑，再有源码证据
- 先有失败方案，再有顿悟与设计感
- 先用角色/动机/障碍组织主线，再让代码承担证明作用
- 正文结构必须是：**问题 → 失败方案 → 顿悟 → 机制拆解 → 收网**
- 代码是证据，不是骨架

---

## 2. 必读文件

开始任何新工作前，必须先读：

- `docs/openjdk/WRITING-GUIDELINES.md`（最高写作标准）
- `docs/HANDOFF-BIN-ARTICLE-REWRITE.md`（早期交接，记录方法论转向）
- `docs/HANDOFF-BIN-ARTICLE-REWRITE-2026-08-19.md`（上一版交接，含详细工作方法）
- 本文：`docs/HANDOFF-BIN-ARTICLE-REWRITE-2026-08-20.md`（最新交接，含本轮完整进度）

---

## 3. 当前真实进度

### 3.1 已完成闭环的域（正文 + plan + 轻量收束）

以下域已完成 BIN 化重写，并已补充 JDK 11 版本边界和"五个最容易混掉的边界"收束节：

#### `01-string`

- `01-storage-immutable.md`
- `02-equals-hashcode-compare.md`
- `03-build-concat.md`
- `04-encoding-unicode.md`

#### `02-number-math`

- `01-wrapper-cache-boxing.md`
- `02-bigdecimal.md`
- `03-ieee754-math.md`

#### `03-object-system`

- `01-object-contract-references.md`
- `02-system-runtime.md`
- `03-process-native.md`

#### `04-reflection-annotation`

- `01-class-member-access.md`
- `02-methodaccessor.md`
- `03-proxy-access.md`
- `04-annotation.md`

#### `07-classloader`

- `01-delegation-model.md`
- `02-builtin-classloaders.md`
- `03-resource-spi.md`

#### `08-collections`

- `01-arraylist.md`
- `02-linkedlist-vector.md`
- `03-deque-priorityqueue.md`
- `04-iterator-failfast.md`
- `05-arrays-sort.md`
- `06-collections.md`

#### `09-map-hash`

- `01-hashmap-storage-hash.md`
- `02-resize-treeify.md`
- `03-linkedhashmap-treemap.md`
- `04-map-family.md`

#### `14-threadpool`

- `01-ctl-worker.md`
- `02-execute-worker.md`
- `03-shutdown-reject.md`
- `04-futuretask-scheduled.md`
- `05-executors-selection.md`

#### `15-async`

- `01-cf-basics.md`
- `02-compose-exception.md`
- `03-forkjoinpool.md`
- `04-forkjointask.md`

#### `17-io-streams`

- `01-byte-streams.md`
- `02-reader-writer.md`
- `03-file-filesystem.md`

#### `18-serialization`

- `01-protocol-flow.md`
- `02-serialversion-custom.md`
- `03-security-filter.md`

#### `19-buffer-channel`

- `01-buffer-state-machine.md`
- `02-bytebuffer-family.md`
- `03-filechannel-mmap.md`

#### `21-selector-nio`

- `01-selector-mechanism.md`
- `02-epoll-platform.md`
- `03-socketchannel-blocking.md`

#### `24-time-date`

- `01-core-value-types.md`
- `02-duration-period.md`
- `03-zone-rules.md`
- `04-formatter-parse.md`
- `05-zoned-offset.md`
- `06-clock-best-practice.md`

#### `25-agent-diagnostic`

- `01-attach-mechanism.md`
- `02-instrumentation.md`
- `03-diagnostic-tools.md`

#### `32-unsafe`

- `01-unsafe-overview.md`
- `02-offheap-directbuffer.md`
- `03-cas-park.md`

#### `34-jmx`

- `01-jmx-architecture.md`
- `02-objectname-register.md`
- `03-mbean-types-mxbean.md`
- `04-notification.md`
- `05-remote-tools.md`
- `06-production-practice.md`

#### `39-jfr`

- `01-jfr-overview-event-model.md`
- `02-custom-event-annotation.md`
- `03-bytecode-instrumentation.md`
- `04-recording-config.md`
- `05-consumer-api.md`
- `06-production-practice.md`（深度重写，已收束）

---

### 3.2 本轮新增完成的轻量收束域

本轮已按统一轻量收束规则补齐版本边界与“五个最容易混掉的边界”节，并完成禁用词/占位锚点/格式检查的域如下：

#### `06-exceptions`

- `01-throwable-structure.md`
- `02-exception-hierarchy.md`

#### `10-concurrent-collections`

- `01-chm-storage-rw.md`
- `02-resize-count.md`
- `03-skiplist.md`
- `04-copyonwrite-concurrentqueue.md`
- `05-blocking-queues.md`
- `06-transfer-selection.md`

#### `11-thread-threadlocal`

- `01-thread-lifecycle.md`
- `02-threadlocal.md`
- `03-exception-random.md`

#### `12-lock-sync`

- `01-aqs-core.md`
- `02-await-wakeup.md`
- `03-reentrantlock-condition.md`
- `04-shared-tools.md`
- `05-stamped-readwrite.md`

#### `13-atomic`

- `01-atomicinteger-cas.md`
- `02-striped64-longadder.md`
- `03-reference-updater.md`

#### `16-stream`

- `01-stream-api-lambda.md`
- `02-pipeline-lazy.md`
- `03-intermediate-ops.md`
- `04-terminal-eval.md`
- `05-collectors.md`
- `06-spliterator-parallel.md`

#### `36-jdbc`

- `01-drivermanager-loading.md`
- `02-connection-transaction.md`
- `03-xa-2pc.md`

---

## 4. 统一工作方法

### 4.1 收束操作（当前主要任务）

当旧稿已经相当接近 BIN 成稿标准时，采用**轻量收束**：

1. **顶部元信息**：在 `> 基于 JDK 11 ...` 行补上版本边界描述，格式为：
   > 本文讨论的是 JDK 11 xxx 边界，不把这里的 xxx 外推成所有 JDK 版本或所有场景的统一规范。

2. **"五个最容易混掉的边界"节**：在收网段落之前插入，格式为：
   - 标题：`## N、五个最容易混掉的边界：xxx 不是 xxx，xxx 不是 xxx，xxx 不是 xxx，xxx 不是 xxx，xxx 不是 xxx`
   - 五条边界，每条一段，格式：`第 N，xxx 不是 xxx。……`
   - 最后一段总结：`把这五条边界记稳，……就不会重新塌回……它真正想讲的是：……`

3. **检查**：
   ```bash
   rg -n '后面会讲|展开\)|第 [2-9] 篇|域 \d+ 展开|此处不再赘述|不再展开|类似地|同理|依此类推|篇幅所限|显然|容易看出|细节读者自行阅读源码' <article>.md
   rg --pcre2 -n '\([^)]*\.java:(?!\d)' <article>.md
   rg -n '\(\d{3,4} 行\)' <article>.md
   ```
   三项均为 0 命中。

### 4.2 当旧稿需要较大改动时

不是所有文章都要推倒重写。如果旧稿已有 BIN 化结构但偏薄（<150 行），只需：

- 补强开头问题驱动
- 补上"最容易混掉的边界"节
- 做禁用词/占位锚点检查

如果旧稿仍是事实卡片/源码平铺结构，则需：

- 先建 `.rewrite-plan.md`（必须包含：读者困惑、一句话顿悟、旧稿问题、理解路径、失败方案清单、误解清单、证据清单、版本与边界、验收标准）
- 按"问题 → 失败方案 → 顿悟 → 机制拆解 → 收网"重写正文
- 代码是证据，不是骨架

### 4.3 检查规则

禁用词检查（必须 0 命中）：
```bash
rg -n '后面会讲|展开\)|第 [2-9] 篇|域 \d+ 展开|此处不再赘述|不再展开|类似地|同理|依此类推|篇幅所限|显然|容易看出|细节读者自行阅读源码' <article>.md
```

占位锚点检查（必须 0 命中）：
```bash
rg --pcre2 -n '\([^)]*\.java:(?!\d)' <article>.md
rg -n '\(\d{3,4} 行\)' <article>.md
```

质量自查：
- 删除代码块后，主线仍成立
- 小标题能还原"问题 → 失败 → 顿悟 → 机制 → 收网"
- 写清 JDK 11 版本边界
- 写清至少 3 个误解 / 失败方案
- 没有只靠代码堆出正文结构

---

## 5. 推荐执行顺序

按从易到难、从轻量收束到深度重写的顺序：

### 第一阶段：轻量收束（本轮已完成）

以下文章已按域顺序完成轻量收束，并补齐 JDK 11 版本边界与“五个最容易混掉的边界”节：

1. `02-number-math/02-bigdecimal.md`
2. `02-number-math/03-ieee754-math.md`
3. `03-object-system/01-object-contract-references.md`
4. `06-exceptions/01-throwable-structure.md`
5. `06-exceptions/02-exception-hierarchy.md`
6. `10-concurrent-collections/01-chm-storage-rw.md` ~ `06-transfer-selection.md`
7. `11-thread-threadlocal/01-thread-lifecycle.md` ~ `03-exception-random.md`
8. `12-lock-sync/01-aqs-core.md` ~ `05-stamped-readwrite.md`
9. `13-atomic/01-atomicinteger-cas.md` ~ `03-reference-updater.md`
10. `14-threadpool/01-ctl-worker.md`、`02-execute-worker.md`、`04-futuretask-scheduled.md`
11. `16-stream/01-stream-api-lambda.md` ~ `06-spliterator-parallel.md`
12. `36-jdbc/01-drivermanager-loading.md` ~ `03-xa-2pc.md`
13. `39-jfr/01-jfr-overview-event-model.md` ~ `05-consumer-api.md`

补充说明：`14-threadpool/05-executors-selection.md` 与 `39-jfr/06-production-practice.md` 原本已带收束节，本轮复查确认通过，无需追加改写。

### 第二阶段：全量复查与深度重写候选

如果某些文章经复查后发现仍需深度重写（不符合 BIN 结构），则：

1. 建 `.rewrite-plan.md`
2. 按"问题 → 失败方案 → 顿悟 → 机制 → 收网"重写
3. 做禁用词/占位锚点检查

当前第二阶段可分三档理解：

#### 2.1 已完成轻量收束并通过检查

- 见上文 3.1 与 3.2 所列文章；这些正文已补齐版本边界与“五个最容易混掉的边界”节
- 已完成一次 `docs/openjdk/vol-java/**` 正文全库终检：占位锚点、`(xxx 行)` 占位与重复收束节问题已清理
- 当前禁用词扫描剩余命中主要为极少数正则字面误伤场景，不再属于前向依赖或偷懒句式

#### 2.2 已完成深度精修的代表文章

目前已完成十四篇加深：
- `14-threadpool/01-ctl-worker.md`：补强开头的问题驱动和失败方案层，使正文更像完整 BIN 主线，而不只是骨架说明。
- `14-threadpool/02-execute-worker.md`：补强 `execute` 开头的三种失败方案与资源决策动机，把提交决策链与 Worker 生命周期更明确地压回同一主线。
- `14-threadpool/04-futuretask-scheduled.md`：清理重复收束层，把结果状态机与时间排序主线收口成单一边界节，避免文章尾部出现两套并行总结。
- `14-threadpool/05-executors-selection.md`：补强开头的三种失败姿势，把固定池/缓存池/定时池/ForkJoin 路线的隐藏边界更明确地压回“选型不是按名字拍板”的主线。
- `36-jdbc/01-drivermanager-loading.md`：补强开头的问题驱动与三种典型失败方案，把驱动发现、注册和 URL 路由更明确地压回同一主线。
- `36-jdbc/02-connection-transaction.md`：补强“拿到连接之后”这一层的事故场景与三种失败方案，把接口分工、事务边界与异常链统一压回调用方责任主线。
- `36-jdbc/03-xa-2pc.md`：补强跨库事务开头的失败方案层，把 XA 参与者协议、2PC 裁决流程与一致性代价更明确地压回同一主线。
- `39-jfr/01-jfr-overview-event-model.md`：补强开头的三种常见误用，把“事故后才开录制”“把 JFR 当持续 profiler”“把事件对象存在误当已记录”压回事件流主线。
- `39-jfr/02-custom-event-annotation.md`：补强自定义事件设计时的三种失败方案，把 Schema 设计、行为型注解和 EventFactory 的定位更明确地压回事件声明主线。
- `39-jfr/03-bytecode-instrumentation.md`：补强字节码增强开头的三种误解，把源码空壳、运行时编译协议与 EventHandler 控制链更明确地压回同一主线。
- `39-jfr/04-recording-config.md`：补强录制控制面的三种失败姿势，把 Recording、Configuration、EventSettings 的分层与预算语义更明确地压回同一主线。
- `39-jfr/05-consumer-api.md`：补强消费端三种失败理解，把流式读取、自描述 Schema 和多种消费者共享同一文件语义更明确地压回同一主线。
- `39-jfr/06-production-practice.md`：补强生产收官篇开头的三种失败姿势，把背景录制、预算边界和自动化闭环更明确地压回“既不太贵、又不太晚”的主线。
- `24-time-date/06-clock-best-practice.md`：补强 `now()` 作为隐式依赖的三种失败方案，把时间源控制、测试可重复性和存储/展示分层更明确地压回同一主线。

#### 2.3 仍可继续深修的候选方向

- `14-threadpool/03-shutdown-reject.md`：虽已成稿，但仍可与域 14 其余四篇做一次全章统一措辞与重复清理
- `16-stream` 全域：整组结构已较稳，后续更适合做整章统一复读，而不是零散逐篇加料
- `39-jfr` 全域：机制链已完整，后续更适合做全章一致性复读与措辞统一，而不是再拆散细改

---

## 5.1 下一阶段：JDK 11 扩展专题总计划

在 `docs/openjdk/vol-java/` 正文主线基本完成 BIN 化收束后，下一阶段不再以“逐篇补边界节”为主，而进入 **JDK 11 扩展层建设**。这里的“扩展”仍然以 JDK 11 为中心，不是脱离 JDK 11 另起炉灶去讲泛泛 JVM 或语言杂项，而是把围绕 JDK 11 正文必须补齐的外围层系统化整理出来。

扩展阶段统一分五层推进：

### 第一层：语言语义专题

目标：补齐“只讲源码还不够”的 Java/JDK 语义地基，让正文不再停在 API 事实层。

建议专题包括：
- 方法与分派：重载、重写、桥接方法、协变返回、默认方法冲突、静态方法隐藏
- 类型系统：泛型擦除、通配符、原始类型、数组协变、运行时类型检查
- 值与对象：值传递、装箱拆箱、包装类缓存、`==` / `equals`、对象身份与可变性
- 异常语义：checked / unchecked、suppressed、异常链、finally 边界
- 类与初始化：加载 / 链接 / 初始化、静态块、常量折叠、初始化触发条件
- 并发语义：happens-before、volatile、final 发布、锁语义、中断语义
- Lambda 与 invokedynamic：函数式接口、捕获语义、方法引用、LambdaMetafactory
- 反射与代理语义：反射调用、MethodHandle、JDK 动态代理、访问控制
- 集合与流语义：fail-fast、视图 vs 复制、惰性、短路、顺序约束
- 时间与 IO 语义：Clock、默认时区/编码、桥接流、File/Path、资源关闭边界

### 第二层：面试误区专题

目标：把高频误判点显式沉淀为专题，而不是散落在正文边缘。

优先主题包括：
- `submit` vs `execute` 的异常差异
- `ThreadLocal` 在线程池场景中的传递与泄漏
- `volatile++`、`AtomicLong` vs `LongAdder`
- `synchronized(count)` 与 `Integer++`
- `sorted().limit()`、`toMap()` 重复 key、`shutdownNow()` 返回值误解
- JFR 中 `commit()` / `dump()` / `profile` 等高频误解

### 第三层：面试要点专题

目标：把现有正文进一步提炼成“高频追问点 + 标准答题骨架”。

建议覆盖：
- 线程池：`ctl`、Worker、execute 路由、拒绝策略、定时池、工厂方法
- AQS：state、队列、SIGNAL、共享传播、公平性入口
- Stream：Pipeline / Sink、短路、Collector 五要素、Spliterator 并行条件
- JDBC：DriverManager、DataSource、事务边界、SQLException 链、XA / 2PC
- JFR：事件模型、Schema、字节码注入、录制控制、消费者 API、生产闭环
- GC / JVM：G1 日志阅读、对象存活路径、Safepoint / 线程 dump 代价

### 第四层：生产实践专题

目标：把 JDK 11 正文从“机制解释”扩展到“生产中怎样真正用”。

建议专题包括：
- 线程池生产治理：预热、动态参数、任务耗时监控、拒绝告警、JMX / Micrometer
- JFR 生产闭环：背景录制、告警触发、窗口 dump、脚本消费、事故复盘
- JDBC 连接池：事务清理、连接泄漏、活跃连接监控、超时与复用策略
- G1 GC 日志诊断：Young GC、RSet、Object Copy、Ref Proc、Humongous、停顿成因
- 反射/代理性能：MethodHandle、Lambda、反射调用分层选择
- 时间与时区：统一 Clock、UTC / 偏移 / 地区规则、跨环境时间错误

### 第五层：版本边界专题

目标：只在解释 JDK 11 必要时，引入 JDK 8 / 17 / 21 的最小对照。

建议范围：
- JDK 8 → 11：JFR、字符串实现、类加载器层次、模块化影响
- JDK 11 → 17 / 21：虚拟线程、GC 差异、JFR / 反射 / JIT 变化

规则：
- 一切对照都必须服务于讲清 JDK 11
- 对照内容单独标注，不得倒灌成 JDK 11 事实

### 首批可执行扩展专题建议

优先级最高的首批主题：
1. 线程池生产治理：预热、动态参数、可观测性与告警
2. `submit` vs `execute`：异常为什么表现不同
3. `ThreadLocal` 在线程池中的传递与泄漏边界
4. G1 GC 日志解读：从 Young GC 到停顿成因
5. Java 方法重载、重写与桥接方法
6. 泛型擦除、原始类型与数组协变
7. Java 值传递、装箱拆箱与对象身份

### tech-weekly 素材映射结论

`/data/workspace/tech-weekly` 中已确认与 JDK 11 扩展阶段直接相关的素材方向包括：
- 第 72 期：线程池动态参数、预热、可观测性、JMX / Micrometer、beforeExecute / afterExecute
- 第 77 / 81 / 82 期：`submit` vs `execute`、Tomcat 线程池、ThreadLocal 在线程池、`Integer++`、`synchronized(count)`
- 第 63 期：G1 GC 日志逐字段分析与参数案例
- 索引条目：Java 方法重载、覆盖、桥接、参数匹配、反射性能层次
- 第 60 期：Java 21 虚拟线程与升级影响（只作为 JDK 11 的最小版本对照素材）

这些素材可作为下一阶段扩展专题的来源，但写作时仍必须回到 JDK 11 主线，并重新按 BIN 方法论组织，而不是直接转抄周报材料。

### 查漏补缺：扩充分层后的完整主题清单

上一段落地后经二次审读，发现原有五层仍有遗漏，补充如下。

#### 语言语义层（补充）

- 字符串与驻留：`intern`、字符串常量池、常量折叠、String / StringBuilder / StringBuffer 取舍
- 枚举语义：`Enum` 行为、`values()/ordinal`、switch 对枚举、单例与序列化保证
- 注解语言语义：Retention / Target / Inherited / `@Repeatable` 与运行时注解代理
- 数组语义：数组协变、`ArrayStoreException`、数组 clone、多维数组
- 数值运算边界：溢出、移位、二进制提升、复合赋值陷阱（`s += 1`）
- 泛型方法与类型推断：PECS、目标类型、通配符捕获
- 可变参数与重载选择边界
- switch 语义：常量要求、fall-through、字符串 switch 的编译实现
- instanceof / 转型 / `ClassCastException` 边界
- 内部类 / 匿名类 / 局部类捕获语义
- 初始化与求值顺序：字段默认值、构造器调用链、副作用与 `finally` + `return`

#### 面试要点层（按域补齐）

- String 三兄弟、集合选型、四大引用与 GC 可达性
- JMM：`volatile` / `final` / happens-before / 锁升级
- 线程池闭环、CompletableFuture、并行流
- 类加载 + SPI + 模块系统（JPMS）
- 序列化安全、NIO 零拷贝
- GC / JVM：G1、对象存活路径、Safepoint
- 诊断工具链：`jps / jstack / jmap / jstat / jcmd / jfr` 各自的适用场景

#### 生产实践层（补充：排障类）

- 内存泄漏排查：heap dump 分析、类加载器泄漏
- CPU 飙高定位：线程转储、火焰图
- 线程池饥饿与死锁定位
- GC 调优策略：堆大小、目标停顿、region、并发线程
- 类加载冲突排查：NoClassDefFoundError / CNFE / 版本冲突
- 反序列化安全：gadget、序列化过滤
- 卡顿与阻塞定位
- JFR 与 JMX 联动诊断

#### 版本边界层（补充 JDK 11 本身上）

- JDK 11 新特性全览：`HttpClient`、Nestmates、局部变量 `var`、模块系统、ZGC（实验性）、二行式回收器、JFR 开源
- 移除 / 弃用项：Nashorn、Applet、Pack200、finalize 等
- JDK 8 → 11 的迁移要点：String 存储、G1 默认、JAXB 等移除影响
- JDK 11 → 17 / 21 的最小对照仍只作为边界说明

#### 新增一层：诊断工具与实战

- JDK 自带工具的正确使用与边界（`jps / jstack / jmap / jstat / jcmd / jfr`）
- Thread dump 阅读与定位方法
- Heap dump 分析入口与常见根因
- JDK 11 `-Xlog` GC 日志参数体系与解读门槛

#### 查漏后的首批候选补充专题

以下为新识别的优先候选，可与首批主题并行或排在其后：
- Java 枚举语义与 switch
- 字符串驻留、`intern` 与 String 三兄弟
- JMM：`volatile` / `final` / happens-before / 锁升级
- 数组语义与 `ArrayStoreException`
- 泛型方法、PECS 与类型推断
- 内存泄漏、CPU 飙高与线程 dump 定位
- JDK 11 新特性与移除项全览
- JDK 诊断工具链使用与边界

#### 扩展域目录结构

扩展阶段的内容统一放置于 `vol-java/` 下的四个新域：

| 域编号 | 域名称 | 内容范围 |
|--------|--------|----------|
| `40-java-lang` | 语言语义 | 重载/重写/桥接、泛型擦除、枚举、装箱、数组、varargs 等 |
| `41-interview` | 面试 | 误区与要点两系列，按篇标记 |
| `42-production-practice` | 生产实践 | 线程池治理、GC 诊断、内存泄漏、CPU 定位、诊断工具 |
| `43-version-boundary` | 版本边界 | JDK 8 → 11 → 21 最小对照 |

每个域内将来按 `01-xxx.md` 编号组织文章，保持与 `vol-java` 现有约定一致。

#### 扩展阶段写作进度

| 域 | 篇目 | 状态 | 说明 |
|----|------|------|------|
| `40-java-lang` | `01-overload-override-bridge.md` | 已完成 | 重载、重写与桥接方法：编译期选签名、运行期选实现、javac 补签名兼容 |
| `40-java-lang` | `02-type-erasure-raw-array.md` | 已完成 | 泛型擦除、原始类型与数组协变 |
| `40-java-lang` | `03-value-passing-boxing.md` | 已完成 | 值传递、自动装箱、IntegerCache 缓存、==/equals 分工 |
| `40-java-lang` | `04-enum-switch.md` | 已完成 | 枚举编译期生成、ordinal 陷阱、switch 跳转表、EnumSet/EnumMap 优化 |
| `40-java-lang` | `05-jmm-volatile-final.md` | 已完成 | JMM/happens-before、volatile 可见性、final 安全发布、synchronized 锁语义 |
| `40-java-lang` | `06-string-intern-family.md` | 已完成 | 字符串驻留、intern 代价、常量折叠、String/StringBuilder/StringBuffer 分工 |
| `40-java-lang` | `07-generics-pecs.md` | 已完成 | 泛型通配符、PECS 原则、类型推断、菱形推导 |
| `40-java-lang` | `08-reflection-performance.md` | 已完成 | 反射 inflate 机制、冷热路径、MethodHandle/lookup、模块边界 |
| `41-interview` | `01-misconception-submit-execute.md` | 已完成 | submit vs execute 异常差异：所有权转移、FutureTask 吞异常、afterExecute 边界 |
| `41-interview` | `02-threadlocal-threadpool.md` | 已完成 | ThreadLocal 线程池传递与泄漏：Inheritable 构造时复制、value 驻留、任务边界方案 |
| `42-production-practice` | `01-thread-pool-governance.md` | 已完成 | 线程池生产治理：预热、动态参数、beforeExecute/afterExecute、状态观测 |
| `42-production-practice` | `02-g1-gc-log.md` | 已完成 | G1 GC 日志解读：YGC 停顿字段、Ref Proc、Humongous、JDK8 PrintGCDetails vs JDK11 -Xlog |
| `42-production-practice` | `03-thread-dump-memory-leak.md` | 已完成 | 内存泄漏与 CPU 飙高定位：heap/thread dump 分工、ThreadMXBean、连续采样时机 |
| `42-production-practice` | `04-diagnostic-tools.md` | 已完成 | JDK 诊断工具链：jps/jstack/jstat/jmap/jcmd 分工与诊断路径 |
| `43-version-boundary` | `01-jdk11-features.md` | 已完成 | JDK 11 新特性与移除项：HttpClient/JFR/模块约束、Java EE/CORBA 移除、升级三问 |
| `40-java-lang` | — | 规划中 | 首批语言语义专题 |
| `43-version-boundary` | — | 规划中 | 首批版本对照专题 |

#### 第二次查漏补充：整域级空白与 JDK 11 专项特性

#### 缺失的整片 JDK 域

- `java.net.http.HttpClient`（JDK 11 招牌 JEP 321）：HTTP/1.1、HTTP/2、WebSocket、同步阻塞与基于 CompletableFuture 的异步调用；建议单独成域
- 国际化 / 本地化：`Locale`、`ResourceBundle`、`Collator`、`NumberFormat`、`MessageFormat`（全新空白域）
- 安全与加密：`java.security`（MessageDigest / Signature / Cipher / KeyStore / SecureRandom）、`AccessController`/`SecurityManager`（JDK 11 弃用边界，全新空白域）
- `VarHandle`（JDK 9 JEP 193）：更规范、更利于 JIT 的内存访问执行器，关联 13-atomic 与 32-unsafe
- `StackWalker`（JDK 9 JEP 259）：生产日志、调用边界分析的正式 API
- 模块系统 JPMS 的 `java.lang.module`：从类加载器扩展到模块描述、模块图与资源
- `Phaser` / `Exchanger`：并入共享同步工具族，补全 AQS 工具清单
- 编译期 API：`javax.tools`、`javax.annotation.processing`（注解处理器与 javac 集成）

#### 语言语义层（第二次补充）

- varargs 与泛型数组堆污染、`@SafeVarargs`
- 方法引用细分：静态 / 绑定实例 / 未绑定 / 构造器引用
- `var`（JDK 10）推断边界：局部变量可用，方法 / lambda 参数不可用
- 泛型 `new T[]` 的限制与 `Array.newInstance`、协变数组的堆污染
- 多 catch 与精确重抛（precise rethrow，JDK 7 起）

#### 生产实践层（第二次补充）

- 打包与部署：`jlink` 模块化镜像、CDS / AppCDS 启动优化、`jdeps` / `jdeprscan`
- JMH：JDK 性能测量方法论
- JUL 与 `java.lang.System.Logger`：JDK 自带日志与系统日志协议

#### 面试要点层（第二次补充）

- 安全与加密、国际化、HttpClient、模块系统的要点化整理
- 并发工具族补全：Phaser / Exchanger / 读写锁 / StampedLock

#### 新增候选专题（第二次查漏）

- HttpClient：同步、异步与HTTP/2 边界
- Java 国际化与 Locale 语义
- 安全、加密与 JDK 11 安全管理器边界
- VarHandle 与内存访问语义
- StackWalker 与调用栈分析
- 模块系统 JPMS 全貌
- varargs、堆污染与泛型数组
- jlink、CDS 与 JDK 11 启动优化
- JMH 与性能测量方法论

## 6. 版本边界说明

- 基于 JDK 11 `java.base`
- 每篇文章顶部必须有版本边界描述，说明本文讨论的是 JDK 11 的实现，不把这里的具体实现外推成所有 JDK 版本的统一规范
- JLS 规范最低保证与 JDK 实现扩展分开叙述
- 具体缓存/行为规则必须逐类核对，不能从一个类推导全部

---

## 7. 注意事项

- **不要跳过检查**：每次收束后必须跑禁用词和锚点检查，0 命中才算完成
- **不要破坏已有结构**：轻量收束只加"最容易混掉的边界"节和顶部边界描述，不改已有正文
- **保持编号一致**：插入新节后检查小标题编号是否连续（一、二、三、五、六 或 一~七）
- **"最容易混掉的边界"节有固定格式**：标题一行、五条边界各一段、总结一段
- **收网段落保持不动**：新节插在收网段落之前，不改收网内容

---

## 8. 质量验收标准

每篇文章完成后必须满足：

- [ ] 顶部有 JDK 11 版本边界描述
- [ ] 有"五个最容易混掉的边界"节（在收网之前）
- [ ] 禁用词检查 0 命中
- [ ] 占位锚点检查 0 命中
- [ ] 删除代码块后主线仍成立
- [ ] 小标题能还原"问题 → 失败 → 顿悟 → 机制 → 收网"
- [ ] 没有只靠代码堆出正文结构
