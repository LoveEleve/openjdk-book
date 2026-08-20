# Ch4-07 Netty 内存泄漏检测与定位 — rewrite-plan

## 篇章定位

- 核心困惑：既然 Netty 已经有 `refCnt`，为什么还是会泄漏？而且真正出问题时，日志里那句 `LEAK: ByteBuf.release() was not called` 到底是怎么来的，它凭什么知道对象在哪里丢的？
- 一句话顿悟：`refCnt` 只提供“归零时显式回收”的能力，不保证业务一定会走到归零；`ResourceLeakDetector` 做的不是替你回收，而是把“本该被 release、却一直没有归零直到被 GC 发现”的对象采样跟踪起来，再通过 leak-aware wrapper、`touch()/record()` 和弱引用队列把最近访问轨迹打印出来。
- 文章边界：本篇主讲 `ResourceLeakDetector`、`ResourceLeakDetectorFactory`、`AbstractByteBufAllocator.toLeakAwareBuffer()`、`SimpleLeakAwareByteBuf`、`AdvancedLeakAwareByteBuf` 的工作链路，主讲 `SIMPLE/ADVANCED/PARANOID` 三种视角差异、`track/close/report` 的时序、日志是如何构造出来的，以及如何据此定位业务泄漏；不展开池化 arena 内部、不展开所有 leak-aware 派生类矩阵。

## 依赖

### HARD

- Ch4-01 `ch4-bytebuf/01-dual-index-and-refcnt.md`：理解 `refCnt`、`release()`、`deallocate()` 与 Direct/Pooled 生命周期。
- Ch4-06 `ch4-bytebuf/06-ownership-and-reference-counting.md`：理解 ownership 协议、`touch()` 的位置、为什么“没人调用最后一次 release”会构成真正的问题。
- Ch4-04 `ch4-bytebuf/04-views-and-zerocopy.md`：理解 slice / duplicate / retainedSlice 等派生视图共享生命周期。

### SOFT

- Ch8 memory pool：这里只需知道池化对象不会自动因业务结束而回池，正文不依赖 arena 细节。
- Ch7-03 `ch7-pipeline/03-outbound-buffer.md`：这里只用“出站缓冲区会 touch / 托管对象”作为辅助场景。

### NAV

- Ch7-03：出站缓冲为何要 `touch(msg)`。
- 后续篇（待写）：`ChannelOutboundBuffer + writability` 如何接管运行时托管区。
- Ch12 HTTP/2 后续篇：frame codec / multiplex handler 为什么还要继续强调 release 责任。

## 素材事实卡片

### 卡片 A：检测器的级别、采样和全局开关

- `ResourceLeakDetector.java:44-60`：旧/新 system property、默认级别 `SIMPLE`、默认 `TARGET_RECORDS=4`、默认采样间隔 `128`。
- `ResourceLeakDetector.java:107-137`：静态初始化读取 `io.netty.leakDetection.level`、`targetRecords`、`samplingInterval`、`trackClose`。
- `ResourceLeakDetector.java:157-165`：运行时可 `setLevel/getLevel`。
- `ResourceLeakDetector.java:275-277`：只有 `ADVANCED/PARANOID` 且 `TARGET_RECORDS > 0` 时才启用 record。
- `ResourceLeakDetector.java:280-288`：`PARANOID` 全量跟踪，其他级别按采样间隔随机采样。

### 卡片 B：检测器不是直接绑在业务代码上，而是绑在 allocator 包装点上

- `AbstractByteBufAllocator.java:40-49`：分配出来的 `ByteBuf` 会先 `track(buf)`，有 tracker 时再包成 `SimpleLeakAwareByteBuf` 或 `AdvancedLeakAwareByteBuf`。
- `AbstractByteBufAllocator.java:52-61`：`CompositeByteBuf` 同样走 leak-aware 包装。
- 结论：业务平时拿到的可能不是“裸 ByteBuf”，而是附带 leak tracker 的包装视图。

### 卡片 C：真正的“泄漏”定义是什么

- `ResourceLeakDetector.java:248-267`：`track/trackForcibly` 返回 tracker，预期在资源 deallocate 时 `close(trackedObject)`。
- `SimpleLeakAwareByteBuf.java:142-175`：`release()` 归零后会 `closeLeak()`，进而 `leak.close(trackedByteBuf)`。
- `SimpleLeakAwareCompositeByteBuf.java:33-62`：Composite 同理。
- 结论：Netty 定义的 leak 不是“对象还活着”，而是“对象没有正确 close tracker，就先被 GC 发现了”。

### 卡片 D：GC 怎么把‘没 release’变成日志

- `ResourceLeakDetector.java:168-173`：维护 `allLeaks`、`refQueue`、`reportedLeaks`。
- `ResourceLeakDetector.java:311-341`：`reportLeak()` 轮询 `refQueue`，对已进入队列且尚未 close 的 tracker 生成报告。
- `ResourceLeakDetector.java:348-366`： traced 与 untraced 两种日志文案差别。
- `DefaultResourceLeak.dispose/close/close(trackedObject)`：`allLeaks.remove(this)` + `clear()` + `reachabilityFence0(trackedObject)`。
- 结论：日志不是在对象丢失那一刻立即打印，而是在后续某次 `track()` 触发 `reportLeak()`，发现旧对象已经被 GC 入队却未成功 close 时打印。

### 卡片 E：访问轨迹是怎么记录出来的

- `DefaultResourceLeak.record0(...)`：用 TraceRecord 栈记录最近访问点，并在记录数超标时做概率丢弃。
- `TraceRecord`：保留 hint、堆栈、创建点；`generateReport()` 生成“Recent access records / Created at / dropped records”文案。
- `ResourceLeakDetector.addExclusions(...)`：允许把检测器自身噪声方法从堆栈中过滤掉。
- 结论：leak 日志看到的不是完整历史，而是“创建点 + 最近若干访问点”的压缩视图。

### 卡片 F：为什么有 Simple 和 Advanced 两层 wrapper

- `SimpleLeakAwareByteBuf`：主要负责在 `release()` 成功归零时 `closeLeak()`，并让派生视图共享/强制继承 tracker；`touch()` 自身是 no-op。
- `SimpleLeakAwareByteBuf.unwrappedDerived(...)`：对 `AbstractPooledDerivedByteBuf` 强制 `trackForcibly(derived)`，修复派生对象跟踪缺口。
- `AdvancedLeakAwareByteBuf.recordLeakNonRefCountingOperation(...)`：在非引用计数操作前也会 `record()`，除非 `acquireAndReleaseOnly` 开关开启。
- 结论：Simple 主要保证“最终能关 tracker”，Advanced 额外解决“泄漏时想知道最近怎么被用过”。

### 卡片 G：工厂与可替换性

- `ResourceLeakDetectorFactory.java:33-53`：全局单例工厂可替换，但必须在 Netty Bootstrap 前设置。
- `ResourceLeakDetectorFactory.java:95-198`：默认工厂支持通过 `io.netty.customResourceLeakDetector` 注入自定义 detector。
- 结论：检测器不是硬编码死的，Netty 把“如何创建 detector”也暴露成了一个前置扩展点。

## 理解路径

1. **从最常见误解开场**：`refCnt` 存在，不代表系统一定不会泄漏；因为协议可以被破坏。
2. **先澄清 leak 的定义**：Netty 检测的不是“对象活太久”，而是“该归零的 tracker 没关就先被 GC 碰到了”。
3. **画最小链路图**：allocator `track` -> leak-aware wrapper -> 运行时 `touch/record` -> `release` 时 `close` -> 若未 close 则后续 `reportLeak`。
4. **推演失败方案**：只靠 `refCnt`、只靠 GC、只打印创建点、为每次访问都保存完整历史，分别为什么不够或代价过高。
5. **讲级别与采样策略**：`SIMPLE` 为什么默认只采样，`ADVANCED/PARANOID` 为什么更贵但更容易定位。
6. **讲 wrapper 设计**：为什么 allocator 统一包装、为什么 Simple/Advanced 分层、为什么派生视图还要强制继承 tracker。
7. **讲日志如何形成**：弱引用队列、`reportLeak()`、`TraceRecord` 压缩报告、重复与超量丢弃。
8. **收网到排障心智**：看到一条 leak 日志时，读者应该怎么判断是 ownership 漏洞、派生视图遗漏，还是异步 write 失败路径没兜底。

## 失败方案推演

- 只靠 `refCnt`：能定义正确释放动作，但不能证明业务一定做到了。
- 只靠 GC/finalize：只能在很晚的时候发现问题，而且给不出业务调用轨迹。
- 每个对象都全量跟踪：生产环境开销过大，默认不能这么做。
- 只记录创建点：知道在哪里出生，不知道在哪里被最后错误持有或错误转移。
- 每次访问都无限堆栈保存：定位信息最全，但记录成本、内存和重复噪声都过高。
- 对派生视图不单独处理：slice/duplicate/retainedSlice 可能让日志只停在父对象层，定位断线。

## 文章结构与预算

1. 开场：为什么已经有 `refCnt`，泄漏问题还是会出现（1000-1400 字）
2. 澄清 leak 定义：Netty 到底在检测什么，不在检测什么（1400-1800 字）
3. 总图：allocator 包装、tracker、wrapper、close、report 的整条链（1800-2400 字）
4. 级别与采样：`SIMPLE/ADVANCED/PARANOID` 和 targetRecords / samplingInterval（1600-2200 字）
5. wrapper 设计：Simple 与 Advanced 的责任分工、派生视图为何额外复杂（1800-2400 字）
6. 日志生成：弱引用队列、`reportLeak()`、`TraceRecord` 与 report 压缩（1800-2400 字）
7. 定位方法：看到 leak 日志以后如何反推 ownership 破口（1200-1800 字）
8. 收网：桥接到出站缓冲、HTTP/2 frame 与后续排障篇（600-900 字）

目标：去掉代码块后的叙述性正文 9000-12000 字，最低不低于 8000 字。

## 证据清单

- `common/src/main/java/io/netty/util/ResourceLeakDetector.java:44-60`
- `common/src/main/java/io/netty/util/ResourceLeakDetector.java:107-165`
- `common/src/main/java/io/netty/util/ResourceLeakDetector.java:248-288`
- `common/src/main/java/io/netty/util/ResourceLeakDetector.java:311-366`
- `common/src/main/java/io/netty/util/ResourceLeakDetector.java:399-639`
- `common/src/main/java/io/netty/util/ResourceLeakDetector.java:644-666`
- `common/src/main/java/io/netty/util/ResourceLeakDetectorFactory.java:33-53`
- `common/src/main/java/io/netty/util/ResourceLeakDetectorFactory.java:95-198`
- `buffer/src/main/java/io/netty/buffer/AbstractByteBufAllocator.java:40-61`
- `buffer/src/main/java/io/netty/buffer/SimpleLeakAwareByteBuf.java:142-175`
- `buffer/src/main/java/io/netty/buffer/SimpleLeakAwareByteBuf.java:186-225`
- `buffer/src/main/java/io/netty/buffer/AdvancedLeakAwareByteBuf.java:38-67`
- `buffer/src/main/java/io/netty/buffer/AdvancedLeakAwareByteBuf.java:69-220`
- `buffer/src/main/java/io/netty/buffer/SimpleLeakAwareCompositeByteBuf.java:33-62`

## 边界清单

- 本篇不把 leak detector 写成自动修复工具；它只能发现并辅助定位，不能替业务补 `release()`。
- 本篇不把日志触发时机写成“对象一丢就立刻报”；真正触发点是后续 `reportLeak()` 检测到弱引用入队。
- 本篇不把 `ADVANCED/PARANOID` 写成默认生产建议；它们是定位模式，不是零成本常态。
- 本篇不把 `touch()` 写成必然记录堆栈；是否真正记录取决于级别与 wrapper 层实现。
- 本篇不完整展开所有 leak-aware 派生类，只抓 ByteBuf 与 CompositeByteBuf 主线。

## 深审预警

- [ ] 不把 `refCnt` 和 leak detector 的职责混写成一件事。
- [ ] 不把 `track()` 写成“必然创建 tracker”；要保留采样语义。
- [ ] 不把 leak 日志写成实时监控；它是带延迟的 GC 后报告。
- [ ] 不把 `SimpleLeakAwareByteBuf.touch()` 写成记录轨迹；当前类里它是 no-op，真正的细粒度记录来自 Advanced wrapper 与显式 `record()`。
- [ ] 不把派生视图的 leak 跟踪简单说成“继承父对象就行”；要写出 `trackForcibly(derived)` 这条修补路径。
- [ ] 代码块出场前先说明它要证明“采样”“关闭 tracker”还是“生成报告”的哪一步。