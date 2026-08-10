# G1 GC 全视角提问 — 大纲完备性验证

> 2026-08-08 | 45692行源码 / 195文件
> 7 个身份 × 10 个主题 → 如果大纲不能回答这些"为什么"，就是不完备的

---

## 身份 1：开发者（"我要改 G1 代码"）

> 视角：修改/扩展 G1 实现的人。关心内部数据结构的约束、并发协议、边界条件。

**Region 模型**
- 为什么 Region 大小必须是 2 的幂？如果允许任意大小，哪些代码会崩溃？
- `HeapRegion::block_start()` 的 O(1) 实现依赖什么不变量？如果我改了 Region 内部布局，这个不变量会破吗？
- `G1HeapRegionAttr` 的 `is_in_reserved()` 为什么用地址范围判断而不是查表？

**GC 周期**
- `G1Policy::record_collection_pause_end()` 中的预测模型如果给错了输入，会导致什么后果？
- 为什么 `initial-mark` 必须 piggyback 在 young GC 上？能不能在 concurrent marking 内部单独触发？
- Mixed GC 的 CSet 选择如果选错了 Region——回收了"存活率极高"的 Old Region——代价是什么？

**Young GC**
- PLAB 的 `undo_allocation` 为什么需要？什么场景下 GC 线程已经"分配"了对象但后来需要回退？
- `G1ParScanThreadState::copy_to_survivor_space` 在 CAS 失败后，forwarding pointer 怎么保证"只有一个线程成功拷贝、其他线程用 forwarding pointer"？

**SATB 并发标记**
- SATB pre-barrier 和 JIT 编译的交互——如果在编译代码中 barrier 被错误地优化掉了，怎么检测？
- marking stack overflow 时，`CMTask::make_reclaimable` 处理的标记栈溢出对象——为什么这些对象在 remark 阶段需要重新扫描？

**RSet**
- RSet 从 sparse 升级到 fine 的触发条件？如果永远不升级——全堆扫描的代价多大？
- `PerRegionTable` 的 `add_reference` 中并发安全性怎么保证？多个 refinement 线程同时向同一个 Region 的 RSet 写 card——怎么避免丢失更新？

**Concurrent Refinement**
- refinement 线程和 mutator 线程共享 dirty card queue——队列满时谁负责扩容？扩容失败时怎么降级？
- green/yellow/red zone 的阈值怎么影响"refinement 赶不上 dirty 速度"的风险？

**Humongous**
- `StartHumongous` Region 的 `_humongous_start_region` 指向自己——这个自引用在 evacuation 时怎么处理？
- 为什么 Humongous 对象不能走 young GC 回收？如果强行回收会有什么问题？

**Full GC**
- G1 Full GC 的 compact 阶段——`G1FullGCCompactTask` 怎么保证"移动对象后所有引用都正确更新"？
- Full GC 的 marking 为什么不复用 SATB 的并发标记基础设施？

---

## 身份 2：性能工程师（"我怎么把 G1 调好"）

> 视角：线上服务 GC 频繁，需要调到最佳状态。关心参数的实际效果、监控指标、决策依据。

**Region 模型**
- `G1HeapRegionSize=1MB` vs `32MB`：什么场景选小的、什么场景选大的？一个线上经验法则是什么？
- 怎么从 gc log 判断 Region 大小选错了？有哪些指标是"Region size red flag"？

**GC 周期**
- IHOP 从默认 45% 升到 60%——什么场景这样做是对的？什么场景会导致 Full GC 频率翻倍？
- `GCPauseIntervalMillis` 和 `MaxGCPauseMillis` 的交互——如果设 `MaxGCPauseMillis=50` 但实际 mixed GC 总是 80ms，policy 在"强行截断"和"放弃目标"之间怎么选？
- Mixed GC 做 8 轮才把 Old 回收完，是正常的吗？什么时候需要担心？

**Young GC**
- young GC 频率太高（每秒 5 次）——怎么判断是该调大 young gen 还是该优化应用分配速率？
- PLAB waste 太高——怎么从日志里判断？调整哪个参数？

**SATB**
- SATB 的 floating garbage 多大才算正常？如果 floating garbage 导致 mixed GC 回收效率极低——怎么从日志判断是 SATB 的问题？
- `-XX:ParallelGCThreads` 和 `-XX:ConcGCThreads` 怎么配比？经验法则是什么？

**RSet**
- RSet 扫描占 young GC 停顿的 30%——怎么判断是"该减少 RSet"还是"该增加 refinement 线程"？
- `G1RSetUpdatingPauseTimePercent` 和 `G1ConcRefinementGreenZone` 怎么联调？

**Humongous**
- Humongous 对象频繁分配/释放导致 Full GC——怎么从日志确认是 humongous fragmentation？
- 什么场景应该用 `G1HeapRegionSize` 来避免 humongous fragmentation？

**Full GC**
- 线上 Full GC 从 0 次/天变成 2 次/小时——怎么定位是 IHOP 太低、humongous 碎片、还是 mixed GC 跟不上？
- `G1ReservePercent=10` 够吗？什么场景需要调高？

**预测模型**
- `G1Predictions` 的 `sigma`（标准差）变大了——意味着什么？对 pause time 目标有什么影响？
- 怎么从 gc log 的 `predicted` vs `actual` 看出预测模型校准有问题？

---

## 身份 3：架构师（"为什么 G1 长这样"）

> 视角：比较不同 GC 算法的设计权衡。关心"为什么选这个方案而不是那个"。

**整体**
- G1 为什么需要 Region 模型？能不能直接用 CMS 的 free list + 并发标记解决一切？
- Region 模型的哲学代价——灵活性 vs 复杂性——在哪几个具体机制中最能体现这个 tradeoff？
- G1 和 ZGC 的着色指针——为什么 G1 没走进着色指针的路？如果从零设计 G1，会选着色指针吗？

**SATB vs 增量更新**
- SATB 和 CMS 的 incremental update：为什么 G1 选 SATB？什么场景 SATB 反而比增量更新差？
- SATB 的"floating garbage"是 bug 还是 feature？从架构角度看？

**RSet 设计**
- Region 模型为什么必然需要 RSet？能不能用别的结构替代？
- RSet 的三级存储（sparse→fine→coarse）为什么不直接用一个固定大小的 bitmap？"升级"架构的好处是什么？

**混合回收**
- 为什么选择了"部分回收 Old"（mixed GC）而不是"全回收 Old"？如果做全回收 Old 会怎样？
- 多轮 mixed GC 的设计——为什么不是一轮做完？和 latency target 有什么关系？

**Humongous**
- 为什么不给 humongous 对象单独开一种 GC？如果专门回收 humongous，架构上会怎么改？
- Humongous 从 array allocation 的角度——为什么 Java 没有"分段大对象"的分配方式？

**Full GC**
- G1 的 Full GC 为什么不值得"优化"？从架构哲学看，G1 Full GC 应该慢还是有理由快？
- 如果让你设计 G1 V2，Full GC 你会怎么改？

---

## 身份 4：SRE/运维（"线上 G1 出问题了"）

> 视角：GC 问题排查。关心怎么从日志/监控/crash 中快速定位根因。

**日志**
- gc log 中 `To-space exhausted` 是什么意思？怎么排查？
- `Humongous allocation` 触发了 `Full GC`——日志中怎么确认是不是 humongous 导致的？
- `G1 Evacuation Pause` 的平均时间从 30ms 跳到 200ms——日志中哪几个字段能帮你看出来变化的原因？

**监控**
- Prometheus 的哪些 GC 指标是"不能只看平均值"的？为什么？
- `jstat -gcutil` 的 FGC 列突然从 0 跳到 1——接下来的 5 分钟你最该看什么？
- Young GC 频率（`jstat -gc 1000`）从 5 秒一次变成 0.8 秒一次——怎么判断是"分配速率翻了 6 倍"还是"young gen 被意外缩小了"？

**Crash**
- SIGSEGV 在 `G1ParScanThreadState::copy_to_survivor_space` 中——可能是什么原因？
- `guarantee(p != NULL) failed: should not be null` 在 `G1FullGCCompactTask`——怎么从 core dump 反推出哪个对象出了问题？

**降级**
- 线上 G1 Full GC 突然频繁——临时切到 `-XX:+UseParallelGC` 还是调高 `G1ReservePercent`？
- Mixed GC 的 `waste` 越来越高——降级 stop mixed gc 只做 young 会比 Full GC 好吗？

---

## 身份 5：研究者（"G1 vs 世界"）

> 视角：学术视角的比较。关心 G1 在 GC 算法谱系中的位置和局限性。

**与 CMS 对比**
- G1 的 pause time 目标在高分配速率下比 CMS 好——但吞吐量比 CMS 差——为什么？在哪几个机制上 G1 的 CPU 开销更大？
- CMS 的 concurrent mode failure 和 G1 的 evacuation failure——哪个对应用的影响更严重？为什么？

**与 ZGC 对比**
- ZGC 的 sub-millisecond pause 怎么做到的？G1 为什么做不到？
- G1 的 colored pointers 如果引入——需要改哪些根本假设？
- ZGC 的 concurrent compaction 和 G1 的 STW evacuation——哪个在"大堆（100GB+）"场景下更优？

**与 Shenandoah 对比**
- Shenandoah 的 Brooks forwarding pointer 和 G1 的 self-forwarding——哪个在并发 compaction 中开销更大？
- G1 的 RSet 和 Shenandoah 的 connection matrix——等价吗？性能差异在哪？

**局限性**
- G1 的 pause time 无论怎么调参都有下限——这个下限由哪些机制构成？理论极限是多少？
- 什么场景 G1 是"根本不适合"的？如果遇到这种场景，建议换什么 GC？

---

## 身份 6：编译器开发者（"JIT 怎么配合 G1"）

> 视角：C1/C2 编译器如何生成 GC 安全点和屏障代码。

- SATB pre-barrier 在 C2 的 `PhaseMacroExpand` 中怎么注入？为什么不能简单地"在每次 store 前插一条指令"？
- C2 的 `BarrierSetC2` 怎么优化连续的 GC barrier？什么条件下两个连续的 pre-barrier 可以合并？
- C1 的 `LIRGenerator` 怎么处理 card mark？和 C2 的差异在哪？
- C2 的 escape analysis 判定 NoEscape 后可以消除 barrier——这个优化在什么条件下会被"反优化"（deopt）？
- JIT 编译的 `nmethod` 中 GC 安全点（safepoint poll）怎么和 G1 的并发标记线程交互？

---

## 身份 7：学生（"我第一次看 G1"）

> 视角：从零理解。问"最自然"的问题——不预设任何 JVM 知识。

- "Garbage-First"这个名字到底是什么意思？为什么不是"Region-First"？
- GC 过程中应用还在跑——怎么做到"并发"的？CPU 只有 4 核，GC 和 app 怎么分 CPU？
- 一个对象的"一生"——从 `new` 到被回收——在 G1 中经历了哪些阶段？
- `std::atomic`、`CAS`、`memory_order` 这些在 G1 源码中到处出现——为什么一个 GC 需要这么多并发原语？
- 为什么 GC 线程和 Java 线程不能同时修改同一个对象？G1 用什么机制保证"不互相踩"？
- `evacuation` 这个词在 G1 中到底是什么意思？为什么不是"copy"或"move"？
- SATB 这个名字很抽象——能不能用"拍照"来类比？拍照式标记和"跟着看"式标记的区别是什么？
