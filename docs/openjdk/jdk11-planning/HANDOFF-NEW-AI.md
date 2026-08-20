# HANDOFF — JDK 11 Java 层面源码分析(规划完成,写作进行中)

> 2026-08-16 | 25/25 域规划完成(100%): 25 KP / 100 大纲 / 25 completeness | 文章写作: 50/100 篇(14 域)
> 本文件是唯一交接入口: 新 AI 读本文件 → 读 00-domain-discovery-v2.md → 读 00-domain-writing-order.md → 按顺序写作
> 配套文档: 内部卷 HANDOFF-NEW-AI.md(规划/planning/ 目录,HotSpot C++ 层,49 域);写作规范 WRITING-GUIDELINES.md(docs/openjdk/ 根)

---

## ⚡ 第一个行动

```
1. 读本交接文档
2. 读 jdk11-planning/00-domain-discovery-v2.md — 25 域权威清单(三常用裁剪版)
3. 读 jdk11-planning/00-domain-writing-order.md — 6 层写作拓扑(写作顺序权威依据)
4. 读 docs/openjdk/WRITING-GUIDELINES.md — 去 AI 味/依赖驱动/源码+解释的写作规范
5. 读 outlines/01-string/01-storage-immutable.md(大纲)+ vol-java/01-string/01-storage-immutable.md(已写文章示范)
6. 当前进度: 14 域 50 篇完成;下一篇 = outlines/16-stream/02-pipeline-lazy.md(域 16 Stream 第 2 篇)
7. 每篇文章: KP → 大纲 → 文章 → 自查(命令见 §六)→ 停下汇报 → 下一篇
```

---

## §零 当前进度

### 规划阶段(已完成 100%)

| 层 | 域 | 篇数 | 状态 |
|:--:|-----|:--:|:--:|
| Layer 0 | 01 字符串(4)/06 异常(2) | 6 | ✅ |
| Layer 1 | 02 数字数学(3)/03 对象系统(3)/11 线程 ThreadLocal(3) | 9 | ✅ |
| Layer 2 | 04 反射注解(4)/07 类加载(3)/08 集合(6)/17 IO(3)/24 时间(6)/32 Unsafe(3) | 25 | ✅ |
| Layer 3 | 09 Map(4)/13 原子(3)/18 序列化(3)/19 BufferChannel(3)/36 JDBC(3) | 16 | ✅ |
| Layer 4 | 12 锁同步器(5)/16 Stream(6)/21 Selector(3)/34 JMX(6)/39 JFR(6) | 26 | ✅ |
| Layer 5 | 10 并发集合(6)/14 线程池(5)/25 Agent 诊断(3) | 14 | ✅ |
| Layer 6 | 15 异步编程(4) | 4 | ✅ |
| **合计** | **25 域** | **100 篇** | **25/25 ✅** |

### 文章写作阶段(进行中 50/100)

| 层 | 域 | 完成 | 行数 | 状态 |
|:--:|-----|:--:|:--:|:--:|
| L0 | 01 字符串(4)/06 异常(2) | 6/6 | 1596 | ✅ |
| L1 | 02 数字数学(3)/03 对象系统(3)/11 线程(3) | 9/9 | 1870 | ✅ |
| L2 | 04 反射(4)/07 类加载(3)/08 集合(6)/09 Map(4) | 17/17 | 2555 | ✅ |
| L3 | 13 原子(3)/18 序列化(3)/19 Buffer(3)/36 JDBC(3) | 12/12 | 2699 | ✅ 全部收官 |
| L4 | 12 锁同步器(5)/16 Stream(1) | 6/26 | 1010 | ⏳ 下一篇: 16/02 |
| **合计** | **14 域** | **50/100** | **9730** | — |

详细进度表与每篇要点见 `HANDOFF-DETAILED.md`(v3)。

---

## §一 目录结构

```
docs/openjdk/
├── WRITING-GUIDELINES.md            ← 写作规范(去 AI 味/依赖驱动/源码+解释)
├── SESSION-HANDOFF.md               ← 内部卷会话交接(勿混用)
├── planning/                        ← 内部卷规划(HotSpot C++,49 域)——跨层引用用
├── jdk11-planning/                  ← ★ 本卷规划(Java 层面,25 域)
│   ├── 00-domain-discovery-v2.md    ← 25 域权威清单 + 纳入/排除
│   ├── 00-domain-writing-order.md   ← 6 层写作拓扑(写作顺序)
│   ├── HANDOFF-NEW-AI.md            ← 本文件
│   ├── knowledge-planning/          ← 25 份 KP(四章: 提取/聚合/分级/聚类)
│   └── outlines/                    ← 25 个子目录
│       ├── {域}/0N-*.md             ← 100 篇 v5 大纲(40 行左右)
│       └── {域}/completeness-questions.md  ← 25 份完整性验证
└── vol-java/                        ← ★ 本卷文章(HotSpot 内部卷对应 vol-02)
    ├── 01-string/ ... 36-jdbc/      ← 14 个域目录(50 篇)
    └── ...(按域建目录,与 outlines 同构)
```

**源码树**: `/data/workspace/source-code/code/spring/jdk11/`(已裁剪,git 可恢复)

---

## §二 源码树状态(裁剪历史,勿再动)

保留 11 个模块:
`java.base`(核心)/ `java.instrument`(域 25)/ `java.management`(域 34)/ `java.sql`(域 36)/ `jdk.attach`(域 25)/ `jdk.charsets`(附属)/ `jdk.jcmd`(域 25,用户明确要求保留)/ `jdk.jfr`(域 39)/ `jdk.management`(域 34)/ `jdk.management.jfr`(域 34)/ `jdk.unsupported`(域 32)

已删除 13 个模块(引用验证零冲突,`git checkout HEAD -- src/{模块}` 可恢复): java.compiler / java.logging / java.management.rmi / java.net.http / java.naming / java.rmi / java.sql.rowset / java.transaction.xa / java.xml / jdk.httpserver / jdk.management.agent / jdk.net / jdk.zipfs

**关键决策记录**(教训,勿重蹈):
1. **jdk.jcmd 曾误删**——用户上轮明确要求加回,下轮又删 → 必须检查用户历史指令
2. **java.instrument + jdk.attach 按"框架常用"补回**(Arthas/APM 生态核心)
3. **jdk.jfr + java.management 按"生产可观测性"补回**
4. **java.transaction.xa 不恢复**——用户裁决: 纯接口无实现,作为域 36 第 3 篇(面试向 XA/2PC)大纲保留概念
5. **java.base 内包不裁剪**——引用链(System→java.security→sun.security;java.text→sun.text;java.net→sun.net.www)剪不断,保留在树但不在分析范围
6. **平台目录裁剪**: 各模块下 windows/macosx/solaris/aix 已删;unix/linux/share 保留(linux 构建仅编译这三者,`make/common/Modules.gmk:244-248` 依据)

---

## §三 方法论 v5 标准(内联完整版)

### 每篇文章的标准格式

每个机制段落必须包含四要素:

```
### N. 机制名 — 一句话描述

场景: [读者为什么要看这个——具体场景,一句话]
[技术描述 + file:line + 函数名]

关键设计 (斜体):
*[为什么这样实现——设计决策、tradeoff]*

[C++: ...] [x86: ...] [内核: ...]   ← 跨层标注
[JVM Spec: §N]                      ← 规范引用
[内部卷: 域号-篇名]                  ← 内部卷引用(需核实篇目存在)
```

### 五维检查表

| 维度 | 检查项 |
|:--:|------|
| 场景 | 每个 section 开头有"场景:"句(文章阶段可融入叙事,但必须有场景引入) |
| 源码 | 有 `file:line` + 函数名 + 调用链(禁止 `:key logic` 文字描述) |
| 关键设计 | 有"关键设计"解释 why |
| 跨层 | 标注合理(纯 Java 域可用 [关联: 域 N] 或 [算法:]) |
| 核心悬念 | 每篇末尾有核心悬念 + OUTBOUND 桥 |

### 巨型域拆分规则

- 源码 >30,000 行 或 文件 >100 → 巨型域
- 巨型域需拆 6 篇左右,分段写作(先 3-4 篇 → pause 自查 → 补齐)
- 本卷巨型域: 08(32K)/10(30K)/16(29K)/24(57K)/34(100K)/39(40K)

---

## §四 缺陷档案(写作阶段实测踩坑,最高优先)

> ⚠️ 缺陷档案已扩展(v3): 完整 18 条新缺陷见 `HANDOFF-DETAILED.md` §4;共性根因扩至 10 条、纪律扩至 20 条。

### 0. 本轮新教训速查(13/18/19/36/12/16 域,必读)

1. **归属类断言必须读方法体**: SIGNAL 是设**前驱**的(非自己);写锁走 tryAcquire(独占)、读锁走 tryAcquireShared(共享)——两者混淆过
2. **短路求值必须推演**: `(cs = cells) != null || !casBase(...)`——表建成后 casBase 根本不执行(13-02)
3. **javap 验证接口签名/常量**: `javap --module java.transaction.xa -constants XAResource`(源码树外模块;commit 第二参是 boolean 非 TMONEPHASE)
4. **时序图箭头 = 语义**: XA_OK 返回方向画错过(36-03)
5. **数量断言 ls 实测**: Buffer 是 7 种非 8 种(无 BooleanBuffer)
6. **跨篇三步走**: ls 目录 → grep 内容 → 再引用(前置依赖指向未写域 17/10 各犯一次)
7. **Javadoc 是源码**: peek 要求 non-interfering;降级语义、不可重入都有 Javadoc 依据
8. **行号必须 grep -n**: sed 目测重犯(Semaphore "Uses AQS state" 实 168-169 非 172)

### 1. API 推断编造(⚠️ 写作阶段最高发——已实踩 3 次)

**症状**: 凭记忆/通用知识写"代码片段",与真实源码不符
**检测**: 文章里每个代码块必须与源码逐字核对(`sed -n` 对照)
**实踩案例**(vol-java/01-string/02 篇,全部已修):
- equals 编造 `COMPACT_STRINGS` 判断 + `||` 双路径 → 真实是 `coder() == aString.coder()` + 三元分派
- hashCode 编造 `hashIsZero` 字段 → 真实是 `h == 0 && value.length > 0`(空串不缓存)
- compareTo 编造单方法形态 → 真实是两段式(106 包装 + 112 核心)

### 2. 文字描述源锚(规划阶段最高发)

**检测**: `grep -rncP '\([^)]*\.java:(?!\d)' {目录}/` — 任何匹配即缺陷
**含义**: `(xxx.java:` 后必须跟数字行号,不允许只有文件名

### 3. 裸锚

**检测**: `grep -rnP '\([^)]*\.java\)' {目录}/ | grep -vP '\.java:\d'`
**含义**: 括号内文件引用必须带 :行号

### 4. 锚点偏移(行号存在但内容不符/行号过界)

**检测**: 锚点全量验证脚本(见 §六 命令 4)——文件存在 + 行号 ≤ 文件行数
**实踩案例**: String.java:44(实为 import,class 在 125)/StringBuilder:99→103/StringLatin1:392→93 等 20+ 处

### 5. 类名/API 名编造

**实踩案例**: MBeanServerImpl(实为 JmxMBeanServer)/FieldAccessorGenerator(不存在)/DefaultZoneRulesProvider(实为 TzdbZoneRulesProvider)/casNext(实为 VarHandle NEXT.compareAndSet)/scan(实为 nextTaskFor)/DirectByteBuffer 在 src 树(实为模板生成)/DoubleToDecimal(JDK11 实为 FloatingDecimal)

### 6. JDK 版本差异

- JDK11 CAS 命名: 内部版 compareAndSetInt(非 compareAndSwapInt,公开版保留旧名)
- JDK11 反射实现: jdk.internal.reflect(71 文件,非 sun.reflect)
- JDK11 类加载器: jdk.internal.loader.ClassLoaders(非 sun.misc.Launcher)
- JDK11 原子数组: VarHandle(非 Unsafe 偏移)
- ArrayDeque: dec/inc 条件回绕(非 2 的幂 mask)

---

## §五 内部卷引用速查(跨层标注用,引用前核对篇目)

| 本卷域 | 内部卷引用(planning/outlines/) | 用途 |
|---|---|---|
| 01 字符串 | 07-classfile-classloader 03-symbol-string-table | stringTable/intern 驻留 |
| 02 数字数学 | 05-cpu-primitives(内存序)/23-stub-routines(数学 stub) | 数学函数 native |
| 03 对象系统 | 06-oops 01-markoop-oopdesc(hash 位)/01-os(时钟)/30-jvm-entry(启动) | Object native/时间/启动 |
| 04 反射注解 | 07-classfile-classloader(注解属性)/27-jni(调用边界) | 注解字节/反射调用 |
| 07 类加载 | 07-classfile-classloader(systemDictionary)/06-jpms-modules/41-zip-jimage | 加载链/模块/镜像 |
| 08 集合 | 23-stub-routines 02-arraycopy | arraycopy 性能 |
| 11 线程 ThreadLocal | 17-threads(全部 4 篇) | 线程对象/状态机/中断 |
| 12 锁同步器 | 19-synchronization(全部) | synchronized 对照/偏向锁 |
| 13 原子类 | 05-cpu-primitives 01-atomic-and-memory-order/06-oops(布局) | CAS 硬件/@Contended |
| 14 线程池 | 17-threads(线程创建) | 线程生命周期 |
| 16 Stream | (无强引用;ForkJoin 关联域 15) | — |
| 19 BufferChannel | 01-os(虚拟内存/页缓存)/41-zip-jimage(格式) | mmap/格式设计 |
| 21 Selector | 01-os(平台层)/36-attach | 系统调用/套接字 |
| 24 时间日期 | 01-os(时钟来源) | 时间戳 |
| 25 Agent | 36-attach(01-attach-listener/02-jdk-attach)/28-jvmti | attach native/类重定义 |
| 32 Unsafe | 05-cpu-primitives/09-memory-core(堆外)/34-nmt | CAS/内存/NMT |
| 34 JMX | 33-jmx-management(平台 MBean 数据源)/35-dcmd | 平台 MBean/诊断命令 |
| 39 JFR | 32-jfr(01-06 全部) | 录制引擎/缓冲/文件格式 |

注: 内部卷篇目以 `planning/outlines/{域}/` 实际文件为准,引用前 `ls` 核对;篇名写"域号-子目录-篇号",如 `07-classfile-classloader 03-symbol-string-table`。

---

## §六 启动命令与准则

### 自查命令(每篇文章/大纲完成后必须执行)

```bash
# 1. 文字描述源锚(应为空)
grep -rncP '\([^)]*\.java:(?!\d)' {目录}/ | grep -v ":0"

# 2. 裸锚(应为空)
grep -rnP '\([^)]*\.java\)' {目录}/ | grep -vP '\.java:\d'

# 3. 四要素抽查
grep -c '场景:' {文件} && grep -c '关键设计' {文件} && grep -c '核心悬念' {文件}

# 4. 锚点全量验证(文件存在+行号在界)
grep -rhoP '[\w/]+\.java:\d+' {目录}/ | grep -oP '[\w/]+\.java:\d+' | sort -u | \
while IFS=: read f l; do \
  real=$(find /data/workspace/source-code/code/spring/jdk11/src -name "$(basename $f)" | head -1); \
  if [ -n "$real" ] && [ "$l" -le "$(wc -l < "$real")" ]; then :; else echo "BAD $f:$l"; fi; \
done
# 注意: 同名文件多时(如 Event.java),验证结果需人工核对路径;completeness 中勿用缩写(AQS.java→AbstractQueuedSynchronizer.java)

# 5. 代码片段逐字核对(写作阶段必做)
sed -n '开始行,结束行p' {源码文件}   # 与文章代码块逐字对照

# 6. 内部卷引用篇目核对
ls /data/workspace/source-code/openjdk-book/docs/openjdk/planning/outlines/{域}/  # 引用前先确认篇目存在
```

### 文章写作准则

- 每篇: KP → outlines 大纲 → vol-java/{域}/ 文章(300-500 行,内部卷样例约 139-200 行,以内容完整为准)
- 不要一次写多篇——逐篇写完 → 自查 → 停下汇报 → 下一篇
- 巨型域分段: 先 3-4 篇 → pause 自查 → 继续 3-4 篇
- 代码片段必须逐字对照源码(§四 1);注释里写"截取核心,逐字"
- 风格: 去 AI 味(叙事而非模板,见 WRITING-GUIDELINES.md)——从"为什么"开始,禁止"### 0. 问题"式模板
- 前置依赖块: 只列真实被正文使用的前置(依赖驱动排序);未写文章不引用或指向大纲
- 禁止前向引用: "后面会讲"→ 重排或删除

---

## §七 关键教训(不可忘记)

1. **AI 自写也会编造——不因"自己写的"跳过验证**: 代码片段逐字核对是写作阶段的第一纪律
2. **用户指令历史要检查**: jdk.jcmd 曾因不看历史被误删两次
3. **grep 全绿 ≠ 内容没问题**: 锚点行号存在 ≠ 内容正确(20+ 处行号存在但内容不符)
4. **源码树位置注意**: 同名文件(Event.java×3)、平台目录(linux/classes)、模板生成(不在 src 树)、jdk.internal 包
5. **交叉模块引用**: 裁剪前必须 grep 引用验证;java.base 内包剪不断(引用链)
6. **JDK 版本差异**: 本卷全部基于 JDK11 源码,引用 JDK8 旧名/JDK19 新特性都是编造

---

## §八 完成态验证清单

```
✅ 25/25 knowledge-planning/*.md 存在
✅ 25/25 outlines/{域}/ 目录存在
✅ 25/25 completeness-questions.md 存在
✅ 100/100 大纲(域 01:4 02:3 03:3 04:4 06:2 07:3 08:6 09:4 10:6 11:3 12:5 13:3 14:5 15:4 16:6 17:3 18:3 19:3 21:3 24:6 25:3 32:3 34:6 36:3 39:6)
✅ 全量文字锚 = 0 / 全量裸锚 = 0(每域自查通过)
✅ 25 域均经两轮深度 review(锚点实测/编造检测/内部卷篇目核对)
✅ 文章 50/100(14 域;L3 五域全部收官;下一篇 16/02)
```

---

## §九 改动记录

| 日期 | 变更 |
|------|------|
| 2026-08-13 | 源码树裁剪(模块级 20 删 + jdk.jcmd/instrument/attach/jfr/management 恢复;平台目录 windows/macosx/solaris/aix 删) |
| 2026-08-13 | 域发现 v1(41 域)→ v2(22 域,三常用裁剪)→ v2.2(25 域,恢复 Agent/JMX/JFR) |
| 2026-08-13~14 | 25 域 KP+大纲+completeness 全部完成;每域两轮深度 review |
| 2026-08-14 | 文章写作启动: 01-string 01/02 篇完成(02 篇自查修复 3 处编造) |
| 2026-08-15 | 32 篇完成(9 域);HANDOFF-DETAILED v2 创建 |
| 2026-08-16 | **50 篇完成(14 域,9730 行)**: 新增域 13/18/19/36/12 全部收官 + 域 16 第 1 篇;全部两轮深审;HANDOFF-DETAILED v3(缺陷档案+纪律+自查命令扩展) |
