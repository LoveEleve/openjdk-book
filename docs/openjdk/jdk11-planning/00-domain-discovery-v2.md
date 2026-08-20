# OpenJDK 11 Java 层面域发现 v2.2 — 三常用裁剪版

> 2026-08-13 | v2.2: 恢复 JMX/JFR 家族,25 域
> 数据来源: `/data/workspace/source-code/code/spring/jdk11/src/` 裁剪后源码树
> 变更: v2.1 基础上恢复 jdk.jfr(域 39)、java.management/jdk.management/jdk.management.jfr(域 34);jdk.management.agent 因依赖已删的 java.rmi/java.naming 链而放弃

---

## 范围说明

**纳入**: 25 个域,覆盖 7 个模块 — java.base + java.sql + java.instrument + jdk.attach + jdk.jcmd + java.management + jdk.management + jdk.management.jfr + jdk.jfr
**保留标准**: 生产常用(线上出问题要读源码) / 面试常用(高频考点) / 框架常用(Spring/Netty/Dubbo/MyBatis/Arthas 等底层依赖)

---

## 一、删除域清单及原因(v1 → v2)

| 删除域 | 理由 |
|--------|------|
| 20 文件系统 NIO.2 (Files/Path/WatchService) | 面试低频;API 使用层为主,源码分析价值低;框架只用 API 不读实现 |
| 22 传统网络 (Socket/HttpURLConnection) | 生产已被 HttpClient/框架替换;面试低频;sun.net.www 实现无通用价值 |
| 23 HttpClient | 面试低频;实现 (jdk.internal.net.http) 复杂且无框架依赖 |
| 25 正则 (java.util.regex) | 面试只问用法(分组/贪婪),无人深挖 Pattern 编译;生产看文档即可 |
| 27-31 安全五域 (JCA/证书/对称加密/TLS/认证) | 面试只问 HTTPS 流程/摘要概念,源码深度与学习收益不成比例;生产由 Spring Security 封装;内部卷 native 侧亦非重点 |
| 33 日志 JUL | 生产全用 SLF4J/log4j/logback,JUL 是兜底实现;面试低频 |
| 34 JMX | 生产监控走 JFR/JVM 工具(内部卷覆盖);源码分析价值低 |
| 35 JNDI | 面试只问 JNDI 注入概念;生产由 Spring 封装 |
| 37 RMI | 已过时(Dubbo 早期依赖),生产/面试均低频 |
| 38 XML | 1,848 文件 90% 是 com.sun.org.apache 移植实现,无学习价值;生产由框架解析 |
| 39 JFR | API 薄(178 文件),核心在 native(内部卷 32 域已覆盖) |
| 40 诊断工具 (attach/jcmd) | ❌ v2 误删,已恢复为域 25 | 面试"Arthas 原理"高频;生产诊断工具链;jcmd 用户明确要求保留 |
| 39 JFR | ❌ v2 误删,已恢复 | 生产可观测性核心(JFR 事件/录制),线上故障定位标配 |
| 34 JMX | ❌ v2 误删,已恢复 | 生产监控/告警核心(MBeanServer/Notification);jdk.management.agent 因依赖 RMI/JNDI 链放弃 |
| 41 辅助服务 (zipfs/httpserver/zip/jar) | 面试低频;zip 压缩算法无学习价值 |
| 26 文本格式化 | 合并入域 24:SimpleDateFormat 线程安全是面试点,与 java.time 对照写作 |
| 05 注解与模块 | 合并入域 04:注解机制(元注解/运行时注解)本质是反射读取,归入反射域;java.lang.module 面试低频删除 |

## 二、域清单(22 域 / 8 组)

### Group 1 语言基础核心(5 域)

| 域 | 名称 | 主要源路径 | 规模 | 巨型 |
|:--:|------|-----------|:--:|:--:|
| 01 | 字符串体系 | java/lang/{String,StringBuilder,StringBuffer,AbstractStringBuilder,StringCoding,StringUTF16,StringLatin1,StringJoiner,Character,CharSequence}.java | ~12 文件 ~9K 行 | |
| 02 | 数字与数学 | java/lang/{Number,Integer,Long,Double,Float,Short,Byte,Boolean,Math,StrictMath}.java + java/math/{BigInteger,BigDecimal}.java + sun/misc/FloatingDecimal | ~20 文件 ~17K 行 | |
| 03 | 对象与系统 | java/lang/{Object,System,Runtime,ProcessBuilder,ClassValue,ThreadGroup,SecurityManager}.java + sun/misc/{VM,Signal}.java | ~15 文件 ~8K 行 | |
| 04 | 反射与注解 | java/lang/Class + java/lang/reflect/(33) + jdk/internal/reflect/(71,MethodAccessor/FieldAccessor/Proxy 生成) + java/lang/annotation/(13) + sun/reflect/(annotation/generics/misc) | ~120 文件 ~21K 行 | |
| 06 | 异常体系 | java/lang/{Throwable,Exception,Error} + 全部异常/错误类 + StackTraceElement | ~60 文件 ~8K 行 | |

### Group 2 类加载(1 域)

| 域 | 名称 | 主要源路径 | 规模 | 巨型 |
|:--:|------|-----------|:--:|:--:|
| 07 | 类加载器与链接 | java/lang/ClassLoader(3061 行) + jdk/internal/loader/(9 文件:BuiltinClassLoader/ClassLoaders/BootLoader/URLClassPath) | ~10 文件 ~8K 行 | |

### Group 3 集合(3 域)

| 域 | 名称 | 主要源路径 | 规模 | 巨型 |
|:--:|------|-----------|:--:|:--:|
| 08 | 集合框架 | java/util/{Collection,List,Set,Queue,Iterator,ArrayList,LinkedList,Vector,Stack,ArrayDeque,PriorityQueue,Arrays,Collections,Abstract*}.java + DualPivotQuicksort/ComparableTimSort | ~28 文件 ~32K 行 | 🔴 |
| 09 | Map 与哈希 | java/util/{Map,HashMap,LinkedHashMap,TreeMap,WeakHashMap,IdentityHashMap,EnumMap,EnumSet,Hashtable,Properties,RandomAccess}.java | ~20 文件 ~25K 行 | |
| 10 | 并发集合 | java/util/concurrent/{ConcurrentHashMap,ConcurrentSkipListMap/Set,CopyOnWriteArrayList/Set,ConcurrentLinkedQueue/Deque,BlockingQueue 族,DelayQueue}.java | ~25 文件 ~30K 行 | 🔴 |

### Group 4 并发(5 域)

| 域 | 名称 | 主要源路径 | 规模 | 巨型 |
|:--:|------|-----------|:--:|:--:|
| 11 | 线程与 ThreadLocal | java/lang/{Thread,ThreadLocal,InheritableThreadLocal,ThreadGroup}.java + java/util/concurrent/ThreadLocalRandom | ~10 文件 ~8K 行 | |
| 12 | 锁与同步器 | java/util/concurrent/locks/ 全部 + {CountDownLatch,CyclicBarrier,Semaphore,Phaser,Exchanger}.java | ~25 文件 ~22K 行 | |
| 13 | 原子类 | java/util/concurrent/atomic/ 全部(Atomic*,LongAdder,Striped64) | ~17 文件 ~8K 行 | |
| 14 | 线程池与任务 | java/util/concurrent/{ThreadPoolExecutor,ScheduledThreadPoolExecutor,Executors,Executor*,Future*,Callable,Runnable,CompletionService}.java | ~20 文件 ~12K 行 | |
| 15 | 异步编程 | java/util/concurrent/{CompletableFuture,CompletionStage,ForkJoinPool,ForkJoinTask,RecursiveTask,CountedCompleter}.java | ~12 文件 ~15K 行 | |

### Group 5 函数式(1 域)

| 域 | 名称 | 主要源路径 | 规模 | 巨型 |
|:--:|------|-----------|:--:|:--:|
| 16 | Stream 与函数式接口 | java/util/stream/(37) + java/util/function/(44) + java/util/{Optional,Spliterator,PrimitiveIterator}.java | ~90 文件 ~30K 行 | 🔴 |

### Group 6 IO 与 NIO(4 域)

| 域 | 名称 | 主要源路径 | 规模 | 巨型 |
|:--:|------|-----------|:--:|:--:|
| 17 | IO 流体系 | java/io/ 流层次(InputStream/OutputStream/Reader/Writer/File/FileDescriptor/Buffered*/Piped*/Data*/Print*) | ~70 文件 ~25K 行 | |
| 18 | 序列化 | java/io/{Serializable,ObjectInputStream,ObjectOutputStream,ObjectStreamClass,ObjectStreamConstants,Externalizable}.java | ~15 文件 ~9K 行 | |
| 19 | Buffer 与 Channel | java/nio/{Buffer,ByteBuffer,CharBuffer,DirectByteBuffer,MappedByteBuffer}.java + java/nio/channels/{FileChannel,Channels,FileLock}.java + sun/nio/ch/{FileChannelImpl,FileDispatcherImpl,DirectBuffer}.java | ~45 文件 ~22K 行 | |
| 21 | Selector 与网络 NIO | java/nio/channels/{Selector,SelectionKey,SelectableChannel,SocketChannel,ServerSocketChannel,Asynchronous*}.java + sun/nio/ch/{SelectorImpl,SelectorProviderImpl,SocketChannelImpl,ServerSocketChannelImpl}.java + **linux/classes/sun/nio/ch/{EPollSelectorImpl,EPoll,EPollSelectorProvider}**(平台层) + unix/classes/sun/nio/ch/PollSelectorImpl | ~45 文件 ~25K 行 | |

### Group 7 时间与格式化(1 域)

| 域 | 名称 | 主要源路径 | 规模 | 巨型 |
|:--:|------|-----------|:--:|:--:|
| 24 | 时间日期与格式化 | java/time/(86,核心类) + java/text/{DateFormat,SimpleDateFormat,NumberFormat,DecimalFormat}.java | ~90 文件 ~58K 行 | 🔴 |

### Group 8 平台核心(5 域)

| 域 | 名称 | 主要源路径 | 规模 | 巨型 |
|:--:|------|-----------|:--:|:--:|
| 32 | Unsafe 与本地内存 | jdk/unsupported/(sun/misc/Unsafe 3 文件) + jdk/internal/misc/Unsafe(3727 行) + sun/nio/ch/DirectBuffer + java/nio 模板生成源(Direct-X-Buffer.java.template) | ~10 文件 ~9K 行 | |
| 36 | JDBC | java/sql/(75 接口与 DriverManager 机制) | 75 文件 ~10K 行 | |
| 25 | Agent 与诊断机制 | java/instrument/(10) + jdk/attach/(13) + jdk/jcmd/(39) — Instrumentation/ClassFileLoadHook、VirtualMachine attach、jcmd/jstack/jmap | 62 文件 ~15K 行 | |
| 34 | JMX | java/management/(330) + jdk/management/(23) + jdk/management/jfr/(14) | ~370 文件 ~60K 行 | 🔴 |
| 39 | JFR | jdk/jfr/(178) | 178 文件 ~40K 行 | 🔴 |

## 三、巨型域标注(规则同内部卷: >30K 行或 >100 文件)

🔴: 08(集合框架 40K)、10(并发集合 30K)、16(Stream 30K)、24(时间 58K)、34(JMX 60K)、39(JFR 40K)

## 四、写作顺序

见 `00-domain-writing-order.md`(v2 同步更新,8 层拓扑)

## 五、源码同步裁剪

**模块级已删除**(跨模块无引用,安全): java.compiler、java.logging、java.management.rmi、java.net.http、java.naming、java.rmi、java.sql.rowset、java.transaction.xa、java.xml、jdk.httpserver、jdk.management.agent、jdk.net、jdk.zipfs
保留模块: java.base、java.sql、java.instrument(域 25)、java.management(域 34)、jdk.attach(域 25)、jdk.jcmd(域 25)、jdk.jfr(域 39)、jdk.management(域 34)、jdk.management.jfr(域 34)、jdk.charsets(被 java.nio charset SPI 间接依赖)、jdk.unsupported(域 32)

**java.base 内包不做裁剪** — 引用验证结论(引用链,删则断):
- java.lang.System → java.security.AccessController/ProtectionDomain → sun.security.util(java/security 下 10+ 文件 import sun.security)
- java.text/{Bidi,CollationElementIterator,Normalizer} → sun.text
- java/net/{URL,Authenticator,SocksSocketImpl} → sun.net.{util,www}
- java/net/SecureCacheResponse → javax.net
- 处理: 安全/文本/网络包保留在树内维持引用完整,但**不在分析范围**(v2 域清单不含);分析时如涉及跨层引用,标注 [C++:]/[内部卷:],不展开

## 六、v2 待审项

- [ ] 域 15: ForkJoinPool 细节是否降级为小节(面试只问 CF,生产用 FJP 少)
- [ ] 域 21: Asynchronous* 家族(面试低频)是否降级
- [ ] 域 36: 是否只写 DriverManager 机制 + 核心接口,不深入协议
