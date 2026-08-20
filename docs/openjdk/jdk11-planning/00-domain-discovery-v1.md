# OpenJDK 11 Java 层面域发现 v1 — 源码树全覆盖版

> 2026-08-13 | v1 初版(纯 Java 层,区别于内部卷的 HotSpot C++ 层)
>
> 数据来源: `/data/workspace/source-code/code/spring/jdk11/src/` 裁剪后源码树(已按范围说明裁剪)
> 扫描方法: `find` 统计文件数 + `cat | wc -l` 统计行数,逐包验证;巨型域判定按内部卷规则(>30,000 行或 >100 文件)
> 全量数据: 24 模块 / 6,149 个 Java 文件 / 98MB(java.base 1,067,536 行 / 2,741 文件)

---

## 范围说明

**纳入**: 24 个纯 Java 平台模块 — java.base(核心) + java.compiler/java.instrument/java.logging/java.management/java.management.rmi/java.naming/java.net.http/java.rmi/java.sql/java.sql.rowset/java.transaction.xa/java.xml + jdk.attach/jdk.charsets/jdk.httpserver/jdk.jfr/jdk.jcmd/jdk.management/jdk.management.agent/jdk.management.jfr/jdk.net/jdk.unsupported/jdk.zipfs

**排除(已物理裁剪,git 可恢复)**:
- 桌面/过时: java.desktop、java.datatransfer、jdk.accessibility、jdk.unsupported.desktop、jdk.jsobject
- 工具链: jdk.compiler(命令行 javac)、jdk.javadoc、jdk.jlink、jdk.jartool、jdk.jdeps、jdk.pack、jdk.rmic、jdk.jshell、jdk.editpad
- 脚本/实验: jdk.scripting.nashorn、jdk.scripting.nashorn.shell、jdk.dynalink、jdk.internal.vm.ci、jdk.internal.vm.compiler、jdk.aot
- native 安全库: jdk.crypto.cryptoki/ec/mscapi/ucrypto、jdk.security.jgss、jdk.security.auth、java.security.jgss/sasl
- 边缘/数据: java.prefs、java.scripting、java.se(纯聚合描述)、java.smartcardio、jdk.localedata(纯数据)
- 非 Java 层: hotspot/、bsd/、linux/、solaris/、demo/、sample/、utils/(内部卷有独立源码树 `/data/workspace/jdk11u`)
- 平台目录: 各模块下 windows/macosx/solaris/aix(linux 构建仅编译 share+unix+linux,见 `make/common/Modules.gmk:244-248`)

**与内部卷(C++ 层)边界**: 本规划只分析 Java 代码(java.*/javax.*/sun.*/com.sun.*/jdk.internal.*)。机制涉及 native 时:
- 底层 VM 实现(对象模型/类加载/锁/GC/JIT)→ 内部卷,Java 层只写 API 语义 + 跨层标注 [C++:]/[JVM Spec:]
- JDK native 方法实现(java.base 的 .c 文件)→ 跨层标注 [native: sun/nio/ch/FileDispatcherImpl.c:xxx],不展开 C 代码

---

## 一、域清单(41 域 / 12 组)

### Group 1 语言基础核心(6 域)

| 域 | 名称 | 主要源路径 | 文件/行 | 巨型 |
|:--:|------|-----------|:--:|:--:|
| 01 | 字符串体系 | java/lang/{String,StringBuilder,StringBuffer,AbstractStringBuilder,StringCoding,StringUTF16,StringLatin1,StringJoiner,Character,CharSequence}.java | ~12 / ~9K | |
| 02 | 数字与数学 | java/lang/{Number,Integer,Long,Double,Float,Short,Byte,Boolean,Math,StrictMath}.java + java/math/(BigInteger,BigDecimal) + sun/misc/FloatingDecimal | ~20 / ~17K | |
| 03 | 对象与系统 | java/lang/{Object,System,Runtime,ProcessBuilder,ClassValue,ThreadGroup?}.java + sun/misc/{VM,Signal}.java | ~15 / ~8K | |
| 04 | 反射体系 | java/lang/Class + java/lang/reflect/(33) + sun/reflect/(65) | ~100 / ~19K | |
| 05 | 注解与模块 | java/lang/annotation/ + java/lang/module/(11) + java/compiler(javax/lang/model)(117) | ~140 / ~25K | |
| 06 | 异常体系 | java/lang/{Throwable,Exception,Error}+全部异常类 + StackTraceElement | ~60 / ~8K | |

### Group 2 类加载(1 域)

| 域 | 名称 | 主要源路径 | 文件/行 | 巨型 |
|:--:|------|-----------|:--:|:--:|
| 07 | 类加载器与链接 | java/lang/ClassLoader + sun/misc/Launcher + jdk/internal/loader/ | ~20 / ~7K | |

### Group 3 集合(3 域)

| 域 | 名称 | 主要源路径 | 文件/行 | 巨型 |
|:--:|------|-----------|:--:|:--:|
| 08 | 集合框架 | java/util/{Collection,List,Set,Queue,Iterator,ArrayList,LinkedList,Vector,Stack,Arrays,Collections,Abstract*}.java | ~60 / ~40K | 🔴 |
| 09 | Map 与哈希 | java/util/{Map,HashMap,LinkedHashMap,TreeMap,WeakHashMap,IdentityHashMap,EnumMap,EnumSet,Hashtable,Properties}.java | ~20 / ~25K | |
| 10 | 并发集合 | java/util/concurrent/{ConcurrentHashMap,ConcurrentSkipList*,CopyOnWrite*,ConcurrentLinked*,BlockingQueue 族}.java | ~25 / ~30K | 🔴 |

### Group 4 并发(5 域)

| 域 | 名称 | 主要源路径 | 文件/行 | 巨型 |
|:--:|------|-----------|:--:|:--:|
| 11 | 线程与 ThreadLocal | java/lang/{Thread,ThreadLocal,InheritableThreadLocal}.java + java/util/concurrent/ThreadLocalRandom | ~10 / ~8K | |
| 12 | 锁与同步器 | java/util/concurrent/locks/(AQS,ReentrantLock,ReadWriteLock,StampedLock,Condition) + {CountDownLatch,CyclicBarrier,Semaphore,Phaser,Exchanger}.java | ~20 / ~20K | |
| 13 | 原子类 | java/util/concurrent/atomic/(Atomic*,LongAdder,Striped64) | ~17 / ~8K | |
| 14 | 线程池与任务 | java/util/concurrent/{ThreadPoolExecutor,ScheduledThreadPoolExecutor,Executors,FutureTask,CompletionService,Executor*}.java | ~15 / ~10K | |
| 15 | ForkJoin 与 CompletableFuture | java/util/concurrent/{ForkJoinPool,ForkJoinTask,CompletableFuture,CompletionStage,CountedCompleter}.java | ~10 / ~15K | |

### Group 5 函数式(1 域)

| 域 | 名称 | 主要源路径 | 文件/行 | 巨型 |
|:--:|------|-----------|:--:|:--:|
| 16 | Stream 与函数式接口 | java/util/stream/(37) + java/util/function/(44) + java/util/{Optional,Spliterator,PrimitiveIterator}.java | ~90 / ~30K | 🔴 |

### Group 6 IO(2 域)

| 域 | 名称 | 主要源路径 | 文件/行 | 巨型 |
|:--:|------|-----------|:--:|:--:|
| 17 | 字节流与字符流 | java/io/ 流层次(InputStream/OutputStream/Reader/Writer/File/FileDescriptor 等,除序列化) | ~70 / ~25K | |
| 18 | 序列化 | java/io/{Serializable,ObjectInputStream,ObjectOutputStream,ObjectStreamClass,ObjectStreamConstants,Externalizable}.java | ~15 / ~9K | |

### Group 7 NIO(3 域)

| 域 | 名称 | 主要源路径 | 文件/行 | 巨型 |
|:--:|------|-----------|:--:|:--:|
| 19 | Buffer 与 Channel 核心 | java/nio/(Buffer 家族) + java/nio/channels/{FileChannel,Channels} + sun/nio/ch/{FileChannelImpl,FileDispatcher} + DirectByteBuffer | ~40 / ~20K | |
| 20 | 文件系统 NIO.2 | java/nio/file/(78) + sun/nio/fs/(UnixPath,LinuxFileSystem 等) | ~100 / ~25K | 🔴 |
| 21 | Selector 与网络 Channel | java/nio/channels/{SocketChannel,ServerSocketChannel,Selector,SelectionKey,Asynchronous*}.java + sun/nio/ch/{SelectorImpl,EPollSelectorImpl,SocketChannelImpl} | ~40 / ~25K | |

### Group 8 网络(2 域)

| 域 | 名称 | 主要源路径 | 文件/行 | 巨型 |
|:--:|------|-----------|:--:|:--:|
| 22 | 传统网络 | java/net/{Socket,ServerSocket,InetAddress,URL,URLConnection,HttpURLConnection,Proxy}.java + sun/net/www/(HttpURLConnection 实现) + sun/net/spi | ~100 / ~35K | 🔴 |
| 23 | HttpClient | java/net/http/(142 文件,java.net.http 模块) | 142 / ~30K | 🔴 |

### Group 9 时间与文本(3 域)

| 域 | 名称 | 主要源路径 | 文件/行 | 巨型 |
|:--:|------|-----------|:--:|:--:|
| 24 | 时间日期 | java/time/(86 文件全量) | 86 / ~57K | 🔴 |
| 25 | 正则 | java/util/regex/(Pattern,Matcher) | 10 / ~10K | |
| 26 | 文本与格式化 | java/text/(42) + sun/text/(54) | 96 / ~47K | 🔴 |

### Group 10 安全(5 域)

| 域 | 名称 | 主要源路径 | 文件/行 | 巨型 |
|:--:|------|-----------|:--:|:--:|
| 27 | JCA 框架与摘要签名 | java/security/ 核心(Provider,MessageDigest,Signature,SecureRandom) + sun/security/{jca,provider,util} | ~120 / ~45K | 🔴 |
| 28 | 证书与密钥库 | java/security/{cert,KeyStore,Key} + sun/security/{x509,pkcs,pkcs8,pkcs10,pkcs12} | ~120 / ~45K | 🔴 |
| 29 | 对称加密与 MAC | javax/crypto/(54) + com/sun/crypto/provider + sun/security/jca | ~80 / ~25K | |
| 30 | TLS 与 SSL | javax/net/ssl/(45) + sun/security/ssl/(~90) + sun/security/validator + com/sun/net/ssl | ~140 / ~70K | 🔴🔴 |
| 31 | 认证与 GSS | javax/security/auth/(47) + javax/security/cert + sun/security/{auth,krb5,ntlm} | ~90 / ~25K | |

### Group 11 平台服务(9 域)

| 域 | 名称 | 主要源路径 | 文件/行 | 巨型 |
|:--:|------|-----------|:--:|:--:|
| 32 | Unsafe 与本地内存 | sun/misc/Unsafe + jdk/unsupported/ + jdk/internal/misc/ + sun/nio/ch/DirectBuffer | ~20 / ~8K | |
| 33 | 日志 | java/util/logging/(22) | 22 / ~10K | |
| 34 | JMX | java/management/(330) + sun/management/ + jdk/management(+.agent,.jfr) | ~380 / ~60K | 🔴 |
| 35 | JNDI | java/naming/(197) + com/sun/jndi/ | 197 / ~45K | 🔴 |
| 36 | JDBC | java/sql/(75) + java/sql/rowset/(53) + java/transaction/xa/ | 133 / ~30K | 🔴 |
| 37 | RMI | java/rmi/(123) + sun/rmi/ + java/management/rmi/ | ~140 / ~40K | 🔴 |
| 38 | XML 处理 | java/xml/(1,848 文件,JAXP DOM/SAX/StAX/XPath/XSLT/DTD) | 1848 / ~150K | 🔴🔴 |
| 39 | JFR | jdk/jfr/(178) + jdk/management/jfr/ | 192 / ~40K | 🔴 |
| 40 | 诊断与工具 | jdk/attach/(13) + jdk/jcmd/(39) + java/instrument/(10) + jdk/internal/jvmstat? | 62 / ~15K | |
| 41 | 辅助服务 | jdk/httpserver/(44) + jdk/zipfs/(15) + java/util/{zip,jar}/ + jdk/net/(8) | ~100 / ~25K | |

---

## 二、巨型域标注与拆分规则(参照内部卷)

- 规则: 源码 >30,000 行 或 文件 >100 → 巨型域,需拆 6-8 篇(域 38 拆 10+ 篇)
- 分段写作策略: 巨型域先写 3-4 篇 → pause 自查(四要素 grep)→ 补齐 → 再写 3-4 篇
- 已知巨型域: 08(集合框架 40K)、10(并发集合 30K)、16(Stream 30K)、20(NIO.2 文件系统)、22(传统网络 35K)、23(HttpClient 30K)、24(时间日期 57K)、26(文本格式化 47K)、27(28K,证书)、30(TLS 70K)、34(JMX 60K)、35(JNDI 45K)、36(JDBC 30K)、37(RMI 40K)、38(XML 150K)、39(JFR 40K)

## 三、写作顺序依据

`00-domain-writing-order.md` — 依赖拓扑排序(读者知识前置,非代码调用关系)

## 四、v1 待审项

- [ ] 域 05 是否并入 java.compiler 的 javax.lang.model(117 文件)——或降级为附属小节
- [ ] 域 26 与域 16 的 sun.text 边界(NumberFormat 与 Stream 无关,边界清晰,待 KP 验证)
- [ ] 域 31 是否保留(krb5 生产常用但面试低频)——可降级合并进 27
- [ ] 域 41 的 java.util.zip/jar 是否独立成域(压缩算法属于实现细节,面试低频)
- [ ] 域 19 的 AsynchronousChannel 家族(面试低频)是否降级为小节
