# HANDOFF-DETAILED — 卷 2(Java 层面)详细交接文档 v3

> 2026-08-16 | 本文是 `HANDOFF-NEW-AI.md` 的**详细版**——供新 AI 完整接续: 进度全表、每篇要点、深审缺陷档案、纪律清单、行动指引
> 本文档与本卷规划文档同步更新;快速入口仍是 `HANDOFF-NEW-AI.md`(第一行动清单)

---

## 0. 阅读顺序(新 AI 必读)

```
1. 本文件(HANDOFF-DETAILED.md)← 完整上下文
2. jdk11-planning/HANDOFF-NEW-AI.md          ← 快速行动清单
3. jdk11-planning/00-domain-discovery-v2.md  ← 25 域权威清单
4. jdk11-planning/00-domain-writing-order.md ← 6 层写作拓扑
5. docs/openjdk/WRITING-GUIDELINES.md        ← 写作规范(去 AI 味)
6. outlines/{域}/0N-*.md                     ← 待写文章的大纲
7. vol-java/{域}/0N-*.md                     ← 已写文章(风格与深度参照)
```

---

## 1. 项目概况

- **目标**: JDK 11 源码分析(Java 层面),按域写作教材级文章,与 HotSpot C++ 内部卷(vol-02)互补
- **规划**: 25 域 / 100 大纲 / 每域 completeness 验证,已 100% 完成
- **写作**: 进行中——**14 域 50 篇完成(9730 行)/ 100 篇计划**
- **方法论五维**: 场景 / 源码(file:line + 函数名 + 调用链)/ 关键设计(斜体)/ 跨层标注 / 核心悬念 + OUTBOUND 桥
- **写作铁律**: 代码块逐字对照源码、锚点全部实测、深审每篇必做、逐篇汇报

---

## 2. 进度全表(14 域 50 篇)

### Layer 0(完成 2/2 域)

| 域 | 篇 | 文章 | 行数 | 深审 |
|:--:|:--:|------|:--:|:--:|
| 01 字符串(4/4 ✅) | 1 | 01-storage-immutable | 143 | ✅(前期批次) |
| | 2 | 02-equals-hashcode-compare | 199 | ✅(前期批次) |
| | 3 | 03-build-concat | 422 | ✅×2 |
| | 4 | 04-encoding-unicode | 342 | ✅ |
| 06 异常(2/2 ✅) | 1 | 01-throwable-structure | 299 | ✅ |
| | 2 | 02-exception-hierarchy | 191 | ✅ |

### Layer 1(完成 3/3 域)

| 域 | 篇 | 文章 | 行数 | 深审 |
|:--:|:--:|------|:--:|:--:|
| 02 数字数学(3/3 ✅) | 1 | 01-wrapper-cache-boxing | 295 | ✅ |
| | 2 | 02-bigdecimal | 227 | ✅ |
| | 3 | 03-ieee754-math | 172 | ✅ |
| 03 对象系统(3/3 ✅) | 1 | 01-object-contract-references | 196 | ✅ |
| | 2 | 02-system-runtime | 198 | ✅ |
| | 3 | 03-process-native | 174 | ✅ |
| 11 线程 ThreadLocal(3/3 ✅) | 1 | 01-thread-lifecycle | 258 | ✅ |
| | 2 | 02-threadlocal | 173 | ✅ |
| | 3 | 03-exception-random | 177 | ✅ |

### Layer 2(完成 4/6 域)

| 域 | 篇 | 文章 | 行数 | 深审 |
|:--:|:--:|------|:--:|:--:|
| 04 反射注解(4/4 ✅) | 1 | 01-class-member-access | 195 | ✅ |
| | 2 | 02-methodaccessor | 189 | ✅ |
| | 3 | 03-proxy-access | 180 | ✅ |
| | 4 | 04-annotation | 195 | ✅ |
| 07 类加载器(3/3 ✅) | 1 | 01-delegation-model | 175 | ✅ |
| | 2 | 02-builtin-classloaders | 153 | ✅ |
| | 3 | 03-resource-spi | 165 | ✅ |
| 08 集合(6/6 ✅) | 1 | 01-arraylist | 167 | ✅ |
| | 2 | 02-linkedlist-vector | 133 | ✅ |
| | 3 | 03-deque-priorityqueue | 134 | ✅ |
| | 4 | 04-iterator-failfast | 121 | ✅×2 |
| | 5 | 05-arrays-sort | 124 | ✅ |
| | 6 | 06-collections | 122 | ✅ |
| 09 Map 哈希(4/4 ✅) | 1 | 01-hashmap-storage-hash | 128 | ✅ |
| | 2 | 02-resize-treeify | 133 | ✅ |
| | 3 | 03-linkedhashmap-treemap | 127 | ✅ |
| | 4 | 04-map-family | 114 | ✅ |

### Layer 3(完成 5/5 域 ✅ 全部收官)

| 域 | 篇 | 文章 | 行数 | 深审 |
|:--:|:--:|------|:--:|:--:|
| 13 原子类(3/3 ✅) | 1 | 01-atomicinteger-cas | 317 | ✅(两轮) |
| | 2 | 02-striped64-longadder | 332 | ✅(两轮) |
| | 3 | 03-reference-updater | 237 | ✅(两轮) |
| 18 序列化(3/3 ✅) | 1 | 01-protocol-flow | 277 | ✅(两轮) |
| | 2 | 02-serialversion-custom | 238 | ✅(两轮) |
| | 3 | 03-security-filter | 165 | ✅(两轮) |
| 19 BufferChannel(3/3 ✅) | 1 | 01-buffer-state-machine | 226 | ✅(两轮) |
| | 2 | 02-bytebuffer-family | 194 | ✅(两轮) |
| | 3 | 03-filechannel-mmap | 217 | ✅(两轮) |
| 36 JDBC(3/3 ✅) | 1 | 01-drivermanager-loading | 182 | ✅(两轮) |
| | 2 | 02-connection-transaction | 174 | ✅(两轮) |
| | 3 | 03-xa-2pc | 140 | ✅(两轮) |
| 12 锁同步器(5/5 ✅) | 1 | 01-aqs-core | 183 | ✅(两轮) |
| | 2 | 02-await-wakeup | 192 | ✅(两轮) |
| | 3 | 03-reentrantlock-condition | 194 | ✅(两轮) |
| | 4 | 04-shared-tools | 157 | ✅(两轮) |
| | 5 | 05-stamped-readwrite | 161 | ✅(两轮) |

### Layer 4(进行中——12/16 完成)

| 域 | 篇 | 文章 | 行数 | 深审 |
|:--:|:--:|------|:--:|:--:|
| 16 Stream(1/6 ⏳) | 1 | 01-stream-api-lambda | 123 | ✅(两轮) **下一篇: 16/02** |

### 待写(50 篇)

| 层 | 域(篇数) | 状态 |
|:--:|------|------|
| Layer 2 未完 | 17 IO(3)、24 时间(6)、32 Unsafe(3) | ⏳ |
| Layer 4 | 16 Stream(5)、21 Selector(3)、34 JMX(6)、39 JFR(6) | ⏳ **当前: 16/02** |
| Layer 5 | 10 并发集合(6)、14 线程池(5)、25 Agent(3) | ⏳ |
| Layer 6 | 15 异步(4) | ⏳ |

---

## 3. 每篇要点摘要(快速回顾已覆盖内容)

### 域 01-11(前期批次,见 v2 交接)

域 01 字符串/06 异常/02 数字数学/03 对象系统/11 线程/04 反射注解/07 类加载/08 集合/09 Map 的要点摘要已在前版交接中,此处省略(见 git 历史或直接读文章)。

### 域 13 原子类
- **01** volatile+偏移+Unsafe 三件套、compareAndSet 委托链、JDK11 命名考古(compareAndSwap→compareAndSet)、weak 变体弃用真相(plain 语义)、内存序变体矩阵、CAS 循环、ABA 预告
- **02** base+cells 分片、add 短路求值(表建成后 base 不执行)、longAccumulate 四类动作、NCPU 停扩、伪共享与 @Contended、LongAccumulator 可结合且可交换、DoubleAdder 位模式(无 double CAS 的根源)
- **03** AtomicReference VarHandle 同构、StampedReference Pair 打包、四参数 CAS 短路优化、FieldUpdater 三道校验+偏移、JDK 内部用法与反例、选型表

### 域 18 序列化
- **01** STREAM_MAGIC/TC_ 标记/SC_ 标志、writeObject0 按类型分派 vs readObject0 按标记分派、HandleTable 先登记后写字段(循环引用)、默认字段规则、newConstructorForSerialization(第一个非序列化超类构造器)
- **02** UID 双来源(显式/默认 SHA 摘要 7 步输入)、字段按名匹配(删字段也兼容)、readObjectNoData、私有 writeObject/readObject 反射探测、defaultWriteObject 语义、writeReplace/readResolve、Externalizable
- **03** gadget 链原理(数据驱动代码执行)、ObjectInputFilter 三态/四类限制、深度炸弹 DoS、生产规范清单

### 域 19 BufferChannel
- **01** 四状态字段与不变量(分步校验链)、flip/clear/rewind/mark-reset、remaining 语义、堆内 vs 堆外(IOUtil shadow 拷贝机制)
- **02** 模板生成体系(X-Buffer.java.template + GensrcBuffer.gmk)、wrap 零拷贝+ix 偏移、字节序 bigEndian/nativeByteOrder 快路径、asIntBuffer 视图、slice/duplicate
- **03** FileChannel 能力全景、mmap 页对齐细节+OOM 重试、MappedByteBuffer load/force、transferTo 三级降级(transferTo0 sendfile)、零拷贝 4 次 vs 2 次

### 域 36 JDBC
- **01** CopyOnWriteArrayList 注册表、三通道加载(执行顺序: 属性读→ServiceLoader→Class.forName)、getConnection 遍历+isDriverAllowed、TCCL 回退、DataSource 抽象演进
- **02** 接口四件套、事务边界(setAutoCommit/commit/rollback)、连接泄漏与资源三件套、SQLException 三要素+next 链(CAS 追加)
- **03** XAResource 接口(JDK 只出协议)、2PC 两阶段流程、三大问题(阻塞/单点/脑裂)、Seata AT 对比(源码树外,经 javap 验证)

### 域 12 锁同步器
- **01** AQS 模板方法四钩子、state(volatile+CAS)、CLH 队列(虚拟头+enq CAS 尾插)、SIGNAL 挂前驱、acquire/release 骨架
- **02** acquireQueued 循环+park、shouldParkAfterFailedAcquire 三分支(设前驱 SIGNAL 再 park 闭合竞态)、unparkSuccessor 从 tail 向前找、公平性 hasQueuedPredecessors、tryLock 无超时版插队
- **03** 可重入计数(state 计数+owner 追踪)、公平/非公平一行差异、ConditionObject 条件队列(await 五步/transferForSignal 转移)、选型矩阵
- **04** 共享模式 doAcquireShared+setHeadAndPropagate 级联、Semaphore 许可池、CountDownLatch 归零、CyclicBarrier(ReentrantLock+Condition 实现,非 AQS 共享!)
- **05** RWLock 高低 16 位拆分(写锁 tryAcquire 独占/读锁 tryAcquireShared 共享)、StampedLock 三模式+validate、tryConvertToWriteLock 三情形、选型注意点

### 域 16 Stream(进行中)
- **01** 中间 9 操作/终端 6 操作分类表、第一原理(中间惰性+终端触发)、短路分类、函数式四族、lambda invokedynamic(LambdaMetafactory)、数据源四种、Optional(orElse vs orElseGet 求值时机)

---

## 4. 深审历史与缺陷档案(按文章,最宝贵经验)

> 格式: 文章 | 修复点数(写作自查+深审合计,**约数**;数字非重点,重点是最严重列与共性根因)| 最严重问题 | 根因

### 前期批次(01-11 域,v2 交接)

| 文章 | 修复点 | 最严重(实质性) | 根因 |
|------|:--:|------|------|
| 01-storage-immutable | 记录不全 | 最早一篇(写作起点),深审通过;具体修复记录未留存 | 早期批次 |
| 02-equals-hashcode-compare | 3 | 抓到 3 处编造(equals 双路径/hashCode 缓存/compareTo 形态,缺陷档案 #1 实踩案例) | 编造防线 |
| 03-build-concat | 4 | 非同步方法只列 3 个(实 7 个)+行号错 | 枚举不完整、无行号目测 |
| 04-encoding-unicode | 2 | CharacterData.of 块标注 79-91(实 79-99) | 块标注范围目测 |
| 01-throwable | 7 | "自指导致 printStackTrace 死循环"错误(dejaVu 不循环) | 逻辑推导未对照源码 |
| 02-exception | 4 | "该类后续加载直接失败"不精确(JLS 12.4.2 是初始化失败) | 概念表述 |
| 01-wrapper-cache | ~16 | "System.identityHashCode 系有查表思路"编造(native) | 编造类比 |
| 02-bigdecimal | 3 | equals "第一道检查"不精确;Karatsuba 自相矛盾 | 表述 |
| 03-ieee754 | 4 | "JDK8 时代搬进 java.base"版本不准 | 版本史 |
| 01-object-contract | 3 | "异常不吞"错误断言(CleanerImpl 也吞@152-153) | 未读 CleanerImpl |
| 02-system-runtime | 4 | "beforeHalt 清理 DeleteOnExit"错误(槽位 2) | 未读 Shutdown 槽位注释 |
| 03-process-native | 3 | Signal.handle@171(实 164) | 行号+表述 |
| 01-class-member | 2 | 前向引用"域 07 展开";ReflectionData 范围偏移 | 前向引用、范围 |
| 02-methodaccessor | 4 | "FieldAccessorImpl 族(通用)"错误二分 | 未 ls 文件清单 |
| 03-proxy-access | 4 | "ConstantPool/ByteVector 工具"错误(无 ByteVector) | 类名未验证、行号 |
| 04-annotation | 6 | annotationData 3738-3753(实 3754);速记锚 | 范围、速记 |
| 01-delegation-model | 1 | "findLoadedClass0 是最终裁决"错误 | 机制理解 |
| 02-builtin-classloaders | 3 | "jdk.* 模块由 Platform 加载"错误(ModuleLoaderMap 列表制) | 未读 ModuleLoaderMap |
| 03-resource-spi | 0 | 全部通过 | — |
| 01-arraylist | 4 | "AbstractList.SubList"版本错误(JDK9+ 是 ArrayList.SubList) | JDK 版本差异 |
| 02-linkedlist-vector | 3 | 前向引用 ×2;peek 裸行号 | 前向引用 |
| 03-deque-priorityqueue | 4 | addLast 实际 302;offer 338-348 | 行号、前向引用 |
| 04-iterator-failfast | 2 | 域 10 详解(深审 2 全部通过) | 前向引用 |
| 05-arrays-sort | 1 | "大数组:双轴快排"错误(DPQ ≥286 先检测 run 归并) | 未读 DPQ 全貌 |
| 06-collections | 0 | 全部通过(8 处深挖) | — |
| 01-hashmap | 3 | 跨篇引用"域 11 HashSet"错误(实为域 03 第 1 篇) | 跨篇未核实 |
| 02-resize-treeify | 0 | 全部通过 | — |
| 03-linkedhashmap | 0 | 全部通过 | — |
| 04-map-family | 1 | "IdentityHashMap 容量非 2 的幂"错误(注释 MUST be power of two@173) | 沿袭大纲错误 |
| 01-thread-lifecycle | 9 | **批量行号偏移**(全部从无行号 sed 目测数错) | **无行号 sed 目测(最大教训)** |
| 02-threadlocal | 5 | 黄金分割数学错误(0x61c88647=(3-√5)/2,非(√5-1)/2) | 数学未验证 |
| 03-exception-random | 1 | GAMMA 数学验证(通过) | 数学 |

### 本轮批次(13/18/19/36/12/16 域,18 篇)

| 文章 | 修复点 | 最严重(实质性) | 根因 |
|------|:--:|------|------|
| 13-01 atomicinteger-cas | 8+8 | **lazySet 描述照抄 Javadoc 未读实现**(JDK11 里 putIntRelease 就是 putIntVolatile 别名);JDK-8077109 issue 号凭记忆 | 未读全方法、编造防线 |
| 13-02 striped64-longadder | 11+6 | **add() 短路求值机制错误**: 原文照搬大纲"先 casBase 失败再分片",实际 `(cs=cells)!=null \|\| !casBase` 使表建成后 base 根本不执行 | 未分析短路逻辑就照搬大纲 |
| 13-03 reference-updater | 6+5 | **set() "不检查直接换"错误**(源码 169 行有"值没变就不写"条件);"8 字节 CAS"未查压缩指针(默认 4 字节) | 未读方法体、平台直觉 |
| 18-01 protocol-flow | 7+8 | **baseWireHandle "留出低位给 TC_ 标记"编造动机**;前置依赖"不可变对象与引用替换"指向 13-01(实际在 13-03) | 编造类比、跨篇想当然 |
| 18-02 serialversion-custom | 9+6 | **matchFields 行号凭估计区间**(getName 匹配实为 2184,初写 2177);"删字段不兼容"逻辑错误(协议层面删字段也兼容) | 行号未 grep 绝对定位、逻辑未推演 |
| 18-03 security-filter | 4+6 | **ysoserial 年份(2015)与 CC 链触发点凭记忆**;"JDK17 强制允许列表"错误(JEP 415 是上下文过滤器) | 编造防线、版本史 |
| 19-01 buffer-state-machine | 4+4 | **前置依赖指向未写域 17**;"8 种 Buffer"错误(实 7 种,无 BooleanBuffer) | 跨篇未 ls、数量未实测 |
| 19-02 bytebuffer-family | 7+5 | **GensrcBuffer 生成器名字凭大纲未 find 验证**(后验证存在);duplicate 行号 88-96(实 87-94) | 编造防线、行号 |
| 19-03 filechannel-mmap | 5+4 | **map0 的 Javadoc 注释编造**(`/** */` 实为 `// Creates a new mapping` 单行);load 块"逐字"标注但内容是示意 | 逐字纪律违反 |
| 36-01 drivermanager | 4+5 | **三通道编号照搬大纲,未按源码执行序**(实际: 读属性→ServiceLoader→Class.forName);"域 10 并发集合"引用未写域×3 | 大纲纪律、跨篇未 ls |
| 36-02 connection-transaction | 3+6 | **setNextException 只引"292 区域"未读完整方法**(实际是 CAS 链尾追加 @299);"半提交状态"误用 2PC 概念 | 读全纪律、概念表述 |
| 36-03 xa-2pc | 4+4 | **时序图箭头方向错误**(XA_OK 返回画成相邻列);TMONEPHASE 误当 commit 第二参(实为 boolean onePhase,javap 验证) | 图未推演、接口签名凭印象 |
| 12-01 aqs-core | 5+5 | **SIGNAL 归属错误**: 原文"节点设置自己的 waitStatus",实际是**设置前驱**(pred.compareAndSetWaitStatus@867,初稿误标 861) | 读全纪律(谁改谁必须读方法体) |
| 12-02 await-wakeup | 3+5 | **tryLock(超时)可插队表述错误**: 实际无超时 tryLock 无条件 nonfairTryAcquire(FairSync 也插队!),超时版公平 | 未读 tryLock 两个版本 |
| 12-03 reentrantlock-condition | 3+4 | **transferForSignal 只讲主路径未读完整方法**(特殊分支 unpark 在尾部);"JDK6+ 性能相当"把业界共识冒充内部卷结论 | 读全纪律、编造防线 |
| 12-04 shared-tools | 3+4 | **Semaphore 行号凭 sed 目测**("Uses AQS state"实为 168-169,初写 172);setState(permits) 实为 176 | 无行号目测(第 11 篇重犯) |
| 12-05 stamped-readwrite | 3+5 | **写/读锁 AQS 模式归属错误**: 写锁用 tryAcquire(独占)@382、读锁用 tryAcquireShared(共享)@453,原文把两者混淆 | 凭"读写锁=共享"印象推断 |
| 16-01 stream-api-lambda | 3+2 | **"peek 唯一有副作用的中间操作"不精确**(Javadoc 要求 non-interfering);大纲引"域 04 StringConcatFactory"错误(实际在 01-string/03) | Javadoc 契约未读、跨篇未 grep |

---

### 共性根因 Top 10(两批次合并)

1. **无行号 sed 目测**——批量数错,最典型 11-01 一次错 5 处、12-04 Semaphore 又犯 → **必须 `grep -n` 或逐行 `sed -n 'Np'` 验证每个锚点**
2. **大纲锚点漂移被照搬**(DPQ、IdentityHashMap、jdk.* 归属、三通道顺序、13-02 短路逻辑)——**写作时一律重新 grep,大纲只当线索**
3. **未读完整源码就下断言**(CleanerImpl、Shutdown 槽位、ModuleLoaderMap、lazySet、set()、transferForSignal、setNextException、SIGNAL 归属、写读锁模式归属)——**机制/归属类断言必须读完整方法**
4. **代码块"逐字"标注名不副实**(map0 注释、load 示意、interrupted 示意)——**"逐字"必须逐字,截取要标 ...**
5. **数学/常数不验证**(0x61c88647、GAMMA、512 字节)——**数学论断程序验证**(python3 一行即可)
6. **接口签名/常量凭印象**(commit(Xid,boolean)、TMONEPHASE 值、XA_RB* 族)——**javap -constants 实测**(源码树外模块尤其)
7. **时序图/流程图箭头凭直觉排版**(36-03 的 XA_OK 方向)——**图也是内容,箭头方向必须推演数据流**
8. **数量断言未实测**("8 种 Buffer"实 7、"18 文件"应 ls 数)——**"几个/N 种"必须 ls/wc 实测**
9. **跨篇引用未三步走**(前置依赖指向未写域 17、域 10 引用、域 13 第 3 篇)——**ls 目录 → grep 内容 → 再引用**
10. **Javadoc 契约当"建议"**(peek non-interfering、Thread 注释)——**Javadoc 是源码的一部分,写断言前先读**

---

## 5. 方法论纪律(50 篇提炼的 20 条)

1. **锚点纪律**: 每个 `file:line` 用 `grep -n`/`sed -n 'Np'` 单独验证;禁止从无行号输出目测
2. **逐字纪律**: 代码块标注"逐字"必须与源码逐行一致;截取用 `...` 标记;行内注释标注行号需在块注释声明
3. **大纲纪律**: 大纲锚点是规划期线索,写作时全部重验(漂移率约 30%)
4. **读全纪律**: 描述机制前读完整方法/类(常被忽略的后半段藏着反例);**"谁改谁的状态/谁走哪个模式"类断言尤其必须读方法体**
5. **数学纪律**: 常数/概率/复杂度论断程序验证
6. **版本纪律**: JDK11 为准;JDK8 旧名/JDK9 新名/JDK17 特性(如 JEP 415)都是版本差异不是事实
7. **跨篇纪律**: 引用"域 N/第 N 篇"前确认该文已写且确有此内容——**ls 目录 + grep 内容三步走**
8. **前向引用纪律**: "后面会讲/第 N 篇展开/域 N 展开"一律改为事实陈述或"(域 N)"关联标注
9. **编造防线**: "我记得/类似地"的类比论断最易编造(identityHashCode、baseWireHandle、ysoserial 年份)→ 逐个验证
10. **类名纪律**: 引用的类名先 `grep -n "class Xxx"` 确认存在
11. **行数/文件数纪律**: 文章开头的"XXX 行"用 `wc -l` 实测;**"几个/N 种"类断言必须 ls 实测**
12. **五维检查**: 每节场景引入/源码锚/关键设计(斜体)/跨层标注/结尾核心悬念+OUTBOUND
13. **自查命令**: 每篇完成必跑 §9 全套(文字锚/裸锚/裸行号/锚点在界/代码块逐字)
14. **逐篇汇报**: 写完→自查→汇报(含修复清单)→停下等确认
15. **深审必做**: 每篇写作后用户会要求深审——把深审当写作的一部分(锚点内容正确性、逻辑正确性、跨篇一致性、数学验证)
16. **javap 纪律**: 接口签名/常量值/异常继承,用系统 JDK `javap --module {模块} -constants {类}` 实测(源码树外模块;注明验证来源,不写行号锚)
17. **图纪律**: 时序图/流程图/对比图也是内容——箭头方向、数据流、行列关系必须推演;画完默读一遍
18. **归属纪律**: "谁改谁/谁走哪个模式/谁调谁"断言读方法体确认(前驱 vs 自己、tryAcquire vs tryAcquireShared、CAS 链尾 vs cause 链)
19. **Javadoc 纪律**: Javadoc 是源码的一部分(契约/约束/语义)——写断言前先读相关 Javadoc(降级语义、non-interfering、不可重入)
20. **源码树外模块纪律**: 先确认模块是否在裁剪树(见 §6 清单)→ 不在则 javap 验证或只写规范语义并标注来源

---

## 6. 源码树状态(勿再动)

- **位置**: `/data/workspace/source-code/code/spring/jdk11/`(已裁剪,git 可恢复)
- **保留 11 模块**: java.base/java.instrument/java.management/java.sql/jdk.attach/jdk.charsets/jdk.jcmd/jdk.jfr/jdk.management/jdk.management.jfr/jdk.unsupported
- **已删 13 模块**(`git checkout HEAD -- src/{模块}` 可恢复): java.compiler/java.logging/java.management.rmi/java.net.http/java.naming/java.rmi/java.sql.rowset/java.transaction.xa/java.xml/jdk.httpserver/jdk.management.agent/jdk.net/jdk.zipfs
- **重要**: `java.transaction.xa` 已删——域 36 第 3 篇(XA/2PC)的 XAResource/Xid **无法本地验证**,本文用系统 JDK17 的 javap 验证接口签名(接口自 1.4 稳定,与 JDK11 一致),文中注明"不写行号锚点"
- **平台目录**: windows/macosx/solaris/aix 已删;unix/linux/share 保留
- **java.base 内包不裁剪**: 引用链剪不断,保留但不在分析范围
- **模板文件注意**: X-Buffer.java.template 等模板在 src 树(java/nio/),生成类(HeapByteBuffer/DirectByteBuffer)不在——锚点写模板文件;GensrcBuffer.gmk 在 make/gensrc/

---

## 7. 下一篇行动指引(域 16 Stream 第 2 篇)

```
1. 读 outlines/16-stream/02-pipeline-lazy.md(KP: knowledge-planning/16-stream.md)
2. 源码: java.base/java/util/stream/{AbstractPipeline(712),ReferencePipeline(739),Sink(362),StreamSupport}.java
   —— 重点: AbstractPipeline.evaluate(226 终端入口)/wrapAndCopyInto(473)/lazy 设计
3. 注意: 域 16 是巨型域(6 篇)——每篇写完自查+汇报,按 outline 顺序推进
4. 写作 → 自查(§9)→ 汇报 → 等确认 → 深审
```

---

## 8. 剩余路线图(50 篇)

```
Layer 2 未完: 17 IO(3) → 24 时间(6) → 32 Unsafe(3)
Layer 4:     16 Stream(5) → 21 Selector(3) → 34 JMX(6) → 39 JFR(6)  ← 当前在 Layer 4
Layer 5:     10 并发集合(6) → 14 线程池(5) → 25 Agent(3)
Layer 6:     15 异步(4)
```

---

## 9. 自查命令全集(每篇必跑)

```bash
cd vol-java/{域}
# 1. 文字描述源锚(应为空): (xxx.java: 后必须带数字
grep -rncP '\([^)]*\.java:(?!\d)' . | grep -v ":0"
# 2. 裸锚(应为空)
grep -rnP '\([^)]*\.java\)' . | grep -vP '\.java:\d'
# 3. 裸行号残留(应为空)
grep -nP '\(\d{3,4} 行\)' {文件}
# 4. 锚点全量验证(文件存在+行号在界)
grep -rhoP '[\w/-]+\.java(?:\.template)?:\d+' {文件} | sort -u | while IFS=: read f l; do \
  real=$(find /data/workspace/source-code/code/spring/jdk11/src -name "$(basename $f)" | head -1); \
  if [ -n "$real" ] && [ "$l" -le "$(wc -l < "$real")" ]; then :; else echo "BAD $f:$l"; fi; done
#   注意: 正则含 '-' 支持模板文件;同名文件优先匹配 java.sql/java.base 路径
# 5. 代码块逐字(自动比对, ... 为通配;多段用 "A-B + C-D" 标注)
python3 脚本: 块内容去缩进后与源码切片 diff;注意 ... 行无缩进会污染 min 计算,需排除
# 6. 四要素
grep -c '关键设计' {文件} && grep -c '核心悬念' {文件}
# 7. 前向引用
grep -nP '后面会讲|展开\)|第 \d 篇|域 \d+ 展开' {文件}
# 8. 内部卷篇目核对(引用前)
ls /data/workspace/source-code/openjdk-book/docs/openjdk/vol-02/{域}/
# 9. 跨篇三步走(引用"域 N/第 N 篇"前)
ls /data/workspace/source-code/openjdk-book/docs/openjdk/vol-java/  # ①目录存在
grep -rn "关键词" /data/workspace/source-code/openjdk-book/docs/openjdk/vol-java/{域}/*.md  # ②内容确实
# 10. javap 验证(源码树外模块/接口签名/常量值)
javap --module {模块} -constants {全限定类名}
```

---

## 10. 改动记录

| 日期 | 变更 |
|------|------|
| 2026-08-15 | v2 创建;9 域 32 篇完成(6021 行);域 01/06/02/03/11/04/07/08/09 全部深审 |
| 2026-08-16 | v3 更新;**新增 6 域 18 篇(3709 行)**: 域 13(3)/18(3)/19(3)/36(3)/12(5)共 17 篇 + 域 16 第 1 篇;全部两轮深审;缺陷档案新增 18 条;共性根因扩至 10 条;纪律扩至 20 条;新增 javap/图/归属/Javadoc/源码树外模块纪律与自查命令 9-10 |
| 2026-08-16 | 累计: **14 域 50 篇 9730 行**;Layer 3 全部收官(5/5);Layer 4 起点(12/5 + 16/1);下一篇: 域 16/02 流水线与惰性 |
