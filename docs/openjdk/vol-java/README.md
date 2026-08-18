# 卷 Java · JDK 11 Java 层源码

> 按 JDK 11 Java 层源码与并发/IO/时间/诊断等主题组织的教材正文。每篇正文均按源码锚点、场景、关键设计、跨层关联与核心悬念编写，并经过逐篇自查与深度 REVIEW。

## 01-string
- [01. 为什么 String 是不可变的?— 存储结构、不可变保证、构造链](01-string/01-storage-immutable.md)
- [02. String 的相等、哈希与比较 — equals/hashCode/compareTo 逐行实现](01-string/02-equals-hashcode-compare.md)
- [03. 字符串构建与拼接 — 扩容算法、方法级同步、JEP 280](01-string/03-build-concat.md)
- [04. 字符编码与 Unicode — StringCoding 编解码链、双路径存储、代理对与查表](01-string/04-encoding-unicode.md)

## 02-number-math
- [01. 包装类、缓存与装箱 — IntegerCache 与 == 陷阱](02-number-math/01-wrapper-cache-boxing.md)
- [02. BigDecimal 与精确计算 — 存储结构、scale、舍入模式](02-number-math/02-bigdecimal.md)
- [03. 浮点数表示与 Math — IEEE-754、Double.toString、Math vs StrictMath](02-number-math/03-ieee754-math.md)

## 03-object-system
- [01. Object 的方法契约与对象生命周期 — 六方法 + 四种引用](03-object-system/01-object-contract-references.md)
- [02. System 与 Runtime 门面 — 时间、数组拷贝、属性、关闭钩子](03-object-system/02-system-runtime.md)
- [03. 进程与本地交互 — ProcessBuilder 启动流程、fork+exec、VM 初始化](03-object-system/03-process-native.md)

## 04-reflection-annotation
- [01. Class 对象与成员获取 — forName、ReflectionData 缓存、native 边界](04-reflection-annotation/01-class-member-access.md)
- [02. 反射调用 — MethodAccessor 三层体系与"反射为什么慢"](04-reflection-annotation/02-methodaccessor.md)
- [03. 动态代理与访问控制 — Proxy 字节码生成、setAccessible、模块封装](04-reflection-annotation/03-proxy-access.md)
- [04. 注解体系 — 元模型、AnnotationParser 解析链、运行时注解](04-reflection-annotation/04-annotation.md)

## 06-exceptions
- [01. Throwable 内部结构 — 堆栈快照、cause 链、suppressed 异常](06-exceptions/01-throwable-structure.md)
- [02. 异常类型体系与设计哲学 — checked/unchecked、Error 家族、生产规范](06-exceptions/02-exception-hierarchy.md)

## 07-classloader
- [01. 双亲委派模型与加载流程 — loadClass 三步骤、defineClass、自定义加载器](07-classloader/01-delegation-model.md)
- [02. JDK11 内建加载器体系 — Boot/Platform/App 三层、模块化双路径](07-classloader/02-builtin-classloaders.md)
- [03. 资源加载与打破委派 — URLClassPath、SPI、线程上下文加载器](07-classloader/03-resource-spi.md)

## 08-collections
- [01. ArrayList 与动态数组 — elementData、1.5x 扩容、默认容量](08-collections/01-arraylist.md)
- [02. LinkedList/Vector/Stack — 双向链表、同步数组、历史类定位](08-collections/02-linkedlist-vector.md)
- [03. ArrayDeque 与 PriorityQueue — 环形数组、二叉堆](08-collections/03-deque-priorityqueue.md)
- [04. 迭代器与 fail-fast — modCount、ConcurrentModificationException](08-collections/04-iterator-failfast.md)
- [05. Arrays 工具与排序 — DPQ vs TimSort、binarySearch、copyOf](08-collections/05-arrays-sort.md)
- [06. Collections 工具与包装器 — 防御编程三件套、算法工具](08-collections/06-collections.md)

## 09-map-hash
- [01. HashMap 的存储与哈希 — table、扰动、寻址、put/get 全流程](09-map-hash/01-hashmap-storage-hash.md)
- [02. HashMap 的扩容与树化 — resize、阈值、红黑树、JDK8 并发改进](09-map-hash/02-resize-treeify.md)
- [03. LinkedHashMap 与 TreeMap — 插入/访问序、LRU、红黑树](09-map-hash/03-linkedhashmap-treemap.md)
- [04. Map 家族与选型 — WeakHashMap/IdentityHashMap/EnumMap/Hashtable](09-map-hash/04-map-family.md)

## 10-concurrent-collections
- [01. ConcurrentHashMap 存储与读写 — CAS 三操作、putVal、无锁读](10-concurrent-collections/01-chm-storage-rw.md)
- [02. ConcurrentHashMap 扩容与计数 — sizeCtl、协助转移、分片计数](10-concurrent-collections/02-resize-count.md)
- [03. ConcurrentSkipListMap 跳表 — 多层索引、无锁有序](10-concurrent-collections/03-skiplist.md)
- [04. CopyOnWrite 与无锁队列 — 写时复制、CAS 链接](10-concurrent-collections/04-copyonwrite-concurrentqueue.md)
- [05. 阻塞队列家族 — BlockingQueue 契约、锁与条件、各实现](10-concurrent-collections/05-blocking-queues.md)
- [06. TransferQueue 与并发集合选型 — 传递语义、全景矩阵](10-concurrent-collections/06-transfer-selection.md)

## 11-thread-threadlocal
- [01. 线程的生命周期与调度原语 — start/run、join、sleep、中断](11-thread-threadlocal/01-thread-lifecycle.md)
- [02. ThreadLocal 原理与内存泄漏 — ThreadLocalMap 全解剖](11-thread-threadlocal/02-threadlocal.md)
- [03. 线程异常出口与 ThreadLocalRandom — uncaughtException 链、无锁随机数](11-thread-threadlocal/03-exception-random.md)

## 12-lock-sync
- [01. AQS 核心 — state、CLH 队列、模板方法](12-lock-sync/01-aqs-core.md)
- [02. AQS 的等待与唤醒 — acquireQueued、park、取消、公平性](12-lock-sync/02-await-wakeup.md)
- [03. ReentrantLock 与 Condition — 可重入、公平性、条件队列](12-lock-sync/03-reentrantlock-condition.md)
- [04. 共享模式与并发工具族 — Semaphore/CountDownLatch/CyclicBarrier](12-lock-sync/04-shared-tools.md)
- [05. StampedLock 与读写锁 — 读写分离、乐观读](12-lock-sync/05-stamped-readwrite.md)

## 13-atomic
- [01. AtomicInteger 与 CAS 封装 — volatile + CAS 循环、内存语义](13-atomic/01-atomicinteger-cas.md)
- [02. Striped64 与 LongAdder — 分片计数、伪共享、弱一致求和](13-atomic/02-striped64-longadder.md)
- [03. 引用原子与 FieldUpdater — AtomicReference、ABA 解、内存优化](13-atomic/03-reference-updater.md)

## 14-threadpool
- [01. TPE 核心 — ctl 状态机与 Worker 结构](14-threadpool/01-ctl-worker.md)
- [02. execute 流程与 Worker 生命周期 — 四步执行、任务取送](14-threadpool/02-execute-worker.md)
- [03. 线程池关闭与拒绝策略 — shutdown/Now、awaitTermination、四策略](14-threadpool/03-shutdown-reject.md)
- [04. FutureTask 与定时调度 — 任务状态机、ScheduledThreadPool](14-threadpool/04-futuretask-scheduled.md)
- [05. Executors 工厂与选型 — 工厂映射、参数调优、生产规范](14-threadpool/05-executors-selection.md)

## 15-async
- [01. CompletableFuture 基础 — 结果状态、依赖栈、thenApply 链](15-async/01-cf-basics.md)
- [02. CompletableFuture 组合与异常 — BiRelay、exceptionally、allOf/anyOf](15-async/02-compose-exception.md)
- [03. ForkJoinPool work-stealing — 双端队列、ctl 状态、窃取算法](15-async/03-forkjoinpool.md)
- [04. ForkJoinTask 与分治 — 任务状态机、fork/join、CountedCompleter](15-async/04-forkjointask.md)

## 16-stream
- [01. Stream 接口全景与函数式接口 — 中间/终端分类、Lambda 机制](16-stream/01-stream-api-lambda.md)
- [02. 流水线结构与惰性机制 — Pipeline 链、Sink 链、求值时机](16-stream/02-pipeline-lazy.md)
- [03. 中间操作实现 — 无状态包装、状态化操作、短路标记](16-stream/03-intermediate-ops.md)
- [04. 终端求值 — 归约框架、短路终端、evaluate 流程](16-stream/04-terminal-eval.md)
- [05. Collectors 与收集器 — Collector 契约、toMap/groupingBy、特征](16-stream/05-collectors.md)
- [06. Spliterator 与并行流 — 分割遍历、ForkJoin 引擎、使用陷阱](16-stream/06-spliterator-parallel.md)

## 17-io-streams
- [01. 字节流与装饰器模式 — InputStream 层次、read 循环、缓冲](17-io-streams/01-byte-streams.md)
- [02. 字符流与字节桥接 — Reader/Writer、StreamDecoder、编码链路](17-io-streams/02-reader-writer.md)
- [03. File 与平台文件系统 — 路径抽象、UnixFileSystem、操作语义](17-io-streams/03-file-filesystem.md)

## 18-serialization
- [01. 序列化协议与流程 — STREAM_MAGIC、TC_ 标记、引用跟踪](18-serialization/01-protocol-flow.md)
- [02. serialVersionUID 与自定义序列化 — 版本兼容、writeObject/readResolve](18-serialization/02-serialversion-custom.md)
- [03. 反序列化安全 — 攻击面、ObjectInputFilter、生产规范](18-serialization/03-security-filter.md)

## 19-buffer-channel
- [01. Buffer 抽象与状态机 — mark/position/limit/capacity 与翻转](19-buffer-channel/01-buffer-state-machine.md)
- [02. ByteBuffer 家族与生成体系 — 模板、wrap、视图、字节序](19-buffer-channel/02-bytebuffer-family.md)
- [03. FileChannel 与 mmap 零拷贝 — map、transferTo、文件锁](19-buffer-channel/03-filechannel-mmap.md)

## 21-selector-nio
- [01. Selector 抽象与选择机制 — 三件套、注册、select 流程](21-selector-nio/01-selector-mechanism.md)
- [02. epoll 实现与平台分层 — EPollSelectorImpl、native 三调用、与 select 对比](21-selector-nio/02-epoll-platform.md)
- [03. SocketChannel 与阻塞/非阻塞 — 模式切换、connect 三阶段、事件循环](21-selector-nio/03-socketchannel-blocking.md)

## 24-time-date
- [01. 核心值类型 — LocalDate/LocalTime/Instant 的不可变设计](24-time-date/01-core-value-types.md)
- [02. 时间运算 — plus/minus、Duration vs Period、between](24-time-date/02-duration-period.md)
- [03. 时区体系 — ZoneId/ZoneOffset/ZoneRules 与 DST](24-time-date/03-zone-rules.md)
- [04. 格式化与解析 — DateTimeFormatter 流程与线程安全](24-time-date/04-formatter-parse.md)
- [05. 组合类型 — ZonedDateTime/OffsetDateTime 与 DST 重叠](24-time-date/05-zoned-offset.md)
- [06. Clock 与时间最佳实践 — 可注入时钟、生产规范](24-time-date/06-clock-best-practice.md)

## 25-agent-diagnostic
- [01. Attach 机制 — 进程连接、套接字协议、SPI 架构](25-agent-diagnostic/01-attach-mechanism.md)
- [02. Instrumentation 与字节码增强 — 转换链、retransform、APM 原理](25-agent-diagnostic/02-instrumentation.md)
- [03. 诊断工具族与生产规范 — jcmd/jstack/jmap、排查流程](25-agent-diagnostic/03-diagnostic-tools.md)

## 32-unsafe
- [01. Unsafe 全景与能力边界 — 双入口、安全校验、API 地图](32-unsafe/01-unsafe-overview.md)
- [02. 堆外内存与 DirectBuffer — 分配、回收、OOM 排查](32-unsafe/02-offheap-directbuffer.md)
- [03. CAS 原语与线程控制 — compareAndSet、getAndAdd、park/unpark](32-unsafe/03-cas-park.md)

## 34-jmx
- [01. JMX 架构全景 — MBeanServer、三物件模型、注册-查询-调用](34-jmx/01-jmx-architecture.md)
- [02. ObjectName 与注册机制 — 寻址格式、模式匹配、Repository](34-jmx/02-objectname-register.md)
- [03. MBean 类型与 MXBean — 标准约定、动态描述、开放类型映射](34-jmx/03-mbean-types-mxbean.md)
- [04. 通知机制 — Notification 结构、并发分发、monitor/timer](34-jmx/04-notification.md)
- [05. JMX 远程与工具 — 连接器架构、RMI 传输、JConsole 原理](34-jmx/05-remote-tools.md)
- [06. JMX 生产实践 — 平台指标、DiagnosticCommand、自定义暴露](34-jmx/06-production-practice.md)

## 36-jdbc
- [01. DriverManager 与驱动加载机制 — 注册三通道、连接路由](36-jdbc/01-drivermanager-loading.md)
- [02. Connection 生命周期与事务控制 — 接口体系、事务边界、异常链](36-jdbc/02-connection-transaction.md)
- [03. XA 与 2PC — 分布式事务的理论地基(面试向)](36-jdbc/03-xa-2pc.md)

## 39-jfr
- [01. JFR 全景与事件模型 — 三物件、事件生命周期](39-jfr/01-jfr-overview-event-model.md)
- [02. 自定义事件与注解 — 事件子类、元数据、EventFactory](39-jfr/02-custom-event-annotation.md)
- [03. 字节码增强机制 — EventInstrumentation、ASM 注入、性能设计](39-jfr/03-bytecode-instrumentation.md)
- [04. 录制与配置 — Recording 生命周期、Configuration、事件设置](39-jfr/04-recording-config.md)
- [05. 消费者 API — RecordingFile 解析、RecordedEvent 访问](39-jfr/05-consumer-api.md)
- [06. JFR 生产实践 — jcmd 操作、飞行记录、性能评估](39-jfr/06-production-practice.md)
