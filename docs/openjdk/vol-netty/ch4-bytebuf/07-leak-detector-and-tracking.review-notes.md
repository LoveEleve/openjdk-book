# Ch4-07 Netty 内存泄漏检测与定位 — Review Notes

## 第一轮：事实审

### 已核对的核心结论

1. `ResourceLeakDetector` 当前默认级别是 `SIMPLE`，默认 `TARGET_RECORDS=4`、默认采样间隔 `128`，证据：`common/src/main/java/io/netty/util/ResourceLeakDetector.java:44`、`:48`、`:51`。  
2. `ResourceLeakDetector` 当前静态初始化会读取 `io.netty.leakDetection.level`、`targetRecords`、`samplingInterval`、`trackClose` 等开关，证据：`common/src/main/java/io/netty/util/ResourceLeakDetector.java:107`。  
3. `setLevel/getLevel` 当前允许运行时切换检测级别，证据：`common/src/main/java/io/netty/util/ResourceLeakDetector.java:157`。  
4. `isRecordEnabled()` 当前只有在 `ADVANCED/PARANOID` 且 `TARGET_RECORDS > 0` 时返回 true，证据：`common/src/main/java/io/netty/util/ResourceLeakDetector.java:275`。  
5. `track0()` 当前在 `PARANOID` 下全量跟踪，其他启用级别按采样间隔随机采样，证据：`common/src/main/java/io/netty/util/ResourceLeakDetector.java:280`。  
6. `AbstractByteBufAllocator.toLeakAwareBuffer()` 当前会先 `track(buf)`，再包成 `SimpleLeakAwareByteBuf` 或 `AdvancedLeakAwareByteBuf`，证据：`buffer/src/main/java/io/netty/buffer/AbstractByteBufAllocator.java:40`。  
7. `track/trackForcibly` 当前返回 `ResourceLeakTracker`，预期在资源 deallocate 时调用 `close(trackedObject)`，证据：`common/src/main/java/io/netty/util/ResourceLeakDetector.java:248`、`:266`。  
8. `SimpleLeakAwareByteBuf.release()` 当前在真正归零后会 `closeLeak()`，进而 `leak.close(trackedByteBuf)`，证据：`buffer/src/main/java/io/netty/buffer/SimpleLeakAwareByteBuf.java:142`、`:170`。  
9. `SimpleLeakAwareCompositeByteBuf.release()` 当前在 Composite 归零后同样会关闭 leak tracker，证据：`buffer/src/main/java/io/netty/buffer/SimpleLeakAwareCompositeByteBuf.java:33`。  
10. `ResourceLeakDetector` 当前维护 `allLeaks`、`refQueue`、`reportedLeaks` 三个核心结构，证据：`common/src/main/java/io/netty/util/ResourceLeakDetector.java:168`。  
11. `reportLeak()` 当前会轮询 `refQueue`，对已入队且未正确 close 的 tracker 生成日志，证据：`common/src/main/java/io/netty/util/ResourceLeakDetector.java:311`。  
12. `reportTracedLeak/reportUntracedLeak` 当前分别输出带 records 和不带 records 的两种文案，证据：`common/src/main/java/io/netty/util/ResourceLeakDetector.java:348`、`:359`。  
13. `DefaultResourceLeak.close(trackedObject)` 当前会 `close()` 后再 `reachabilityFence0(trackedObject)`，证据：`common/src/main/java/io/netty/util/ResourceLeakDetector.java:526`。  
14. `record0(...)` 当前在记录数超出 `TARGET_RECORDS` 后会按概率丢弃旧记录，证据：`common/src/main/java/io/netty/util/ResourceLeakDetector.java:478`、`:491`。  
15. `generateReport(...)` 当前会输出 `Recent access records`、`Created at`、重复记录数和超量丢弃记录数，证据：`common/src/main/java/io/netty/util/ResourceLeakDetector.java:589`、`:601`、`:618`、`:625`。  
16. `SimpleLeakAwareByteBuf.unwrappedDerived(...)` 当前会对部分派生对象执行 `trackForcibly(derived)`，证据：`buffer/src/main/java/io/netty/buffer/SimpleLeakAwareByteBuf.java:186`、`:196`。  
17. `AdvancedLeakAwareByteBuf.recordLeakNonRefCountingOperation(...)` 当前会在许多非引用计数操作前执行 `leak.record()`，除非 `acquireAndReleaseOnly` 开关开启，证据：`buffer/src/main/java/io/netty/buffer/AdvancedLeakAwareByteBuf.java:38`、`:63`。  
18. `ResourceLeakDetectorFactory` 当前支持全局替换工厂，也支持通过 `io.netty.customResourceLeakDetector` 注入自定义 detector，证据：`common/src/main/java/io/netty/util/ResourceLeakDetectorFactory.java:33`、`:95`。  
19. `ResourceLeakDetector.addExclusions(...)` 当前允许把框架内部噪声方法从报告堆栈中过滤掉，证据：`common/src/main/java/io/netty/util/ResourceLeakDetector.java:644`。

### 深审发现

1. **中风险：容易把 leak detector 写成自动修复工具。** 正文已反复强调它只能发现并辅助定位，不能替业务补 `release()`。  
2. **中风险：容易把日志触发时机写成“对象一泄漏就立刻报”。** 正文已限定为“对象不可达入队后，在后续 `reportLeak()` 中被报告”。  
3. **低风险：容易把 `touch()` 写成必然记录堆栈。** 正文已明确区分 Simple 与 Advanced，以及 `isRecordEnabled()` 的级别前提。  
4. **低风险：容易忽略派生视图的跟踪补线。** 正文已补 `trackForcibly(derived)` 这条事实。

## 第二轮：因果审

- ownership 协议可能被破坏 -> `refCnt` 不会自动归零 -> leak detector 需要存在：✅  
- allocator 出生点挂 tracker -> wrapper 负责 close tracker -> 未 close 时弱引用入队 -> 后续 `reportLeak()` 生成日志：✅  
- 默认不全量跟踪 -> 因为线上开销必须受控 -> `SIMPLE/ADVANCED/PARANOID` 是成本与定位信息的取舍：✅  
- Simple 负责闭环，Advanced 负责细粒度轨迹：✅  
- leak 日志是压缩证据链，不是完整历史回放：✅

未发现把实现推断写成确定源码事实的高风险段落。

## 第三轮：结构审

正文结构按“误会拆解 -> leak 定义 -> 总图 -> 级别与采样 -> wrapper 分工 -> 记录压缩 -> traced/untraced -> 工厂与排除表 -> 如何读日志 -> 收网”推进，没有按类文件顺序平铺。✅

失败方案已覆盖：
- 只靠 `refCnt`  
- 只靠 GC/finalize  
- 每个对象全量跟踪  
- 只记录创建点  
- 每次访问都无限保存历史  
- 不处理派生视图单独跟踪  
满足方法论要求。✅

## 第四轮：读者审

删除代码块后，正文仍应能复述：
- leak detector 检测的不是“对象活太久”，而是“tracker 没有正确 close 就先被 GC 发现”  
- allocator 如何把 ByteBuf 包成 leak-aware wrapper  
- `SIMPLE/ADVANCED/PARANOID` 的区别是成本与定位信息差异  
- Simple 和 Advanced wrapper 的责任边界  
- leak 日志为什么只有最近若干访问点而不是完整历史  
- 真正看到 leak 日志后该如何回到 ownership 协议查缺口  

当前正文满足这条删码要求。✅

## 第五轮：边界审

- 未把 leak detector 写成自动修理工。✅  
- 未把 `track()` 写成必然创建 tracker，保留了采样语义。✅  
- 未把日志触发时机写成实时同步监控。✅  
- 未把 `touch()` 写成默认必然记录堆栈。✅  
- 未把所有 leak-aware 派生类展开成矩阵，只抓了 ByteBuf 与 Composite 主线。✅

## 第六轮：依赖审

- 依赖 Ch4-01 的 `refCnt/release/deallocate` 基础，真实存在。✅  
- 依赖 Ch4-06 的 ownership 协议前置，真实存在。✅  
- 依赖 Ch4-04 的派生视图共享生命周期前置，真实存在。✅  
- 后续出站缓冲、HTTP/2 frame 只作桥接，没有把后文结论当前置。✅

## 机械检查

- 禁用词：`此处不再赘述 / 不再展开 / 类似地 / 同理 / 依此类推 / 篇幅所限 / 显然 / 容易看出 / 细节读者自行阅读源码` 均未命中。✅  
- 代码块：未使用 fenced code block。✅  
- 源码引用：已逐条核对。✅  
- 去掉代码块后正文仍成立：是。✅  
- 正文字符数：约 14,400。  
- 去掉常见 markdown 标记后的字符数：约 13,997。  
- 目标定位：重大机制篇，满足篇幅要求。✅

## 结论

当前正文主线已经建立：leak detector 不是回收器，而是 ownership 协议失守后的事故记录仪。Ch4-07 可作为后续 `ChannelOutboundBuffer / writability` 与 HTTP/2 frame release 规则的直接前置篇。