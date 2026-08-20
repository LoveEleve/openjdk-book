# Ch8-04 `04-pooledbuf-lifecycle.md` review notes

## 第一轮：事实核对

### 已核对的核心结论

1. `PooledByteBuf.deallocate()` 当前实现确实先走 `chunk.arena.free(chunk, tmpNioBuf, handle, maxLength, cache)`，后走 `recyclerHandle.unguardedRecycle(this)`；并且在此之前会把 `this.handle` 置为 `-1`、把 `memory` 置空，证据：`buffer/src/main/java/io/netty/buffer/PooledByteBuf.java:173`。
2. `PooledByteBuf.retainedDuplicate()` / `retainedSlice(...)` 当前分别创建 `PooledDuplicatedByteBuf` / `PooledSlicedByteBuf`，证据：`buffer/src/main/java/io/netty/buffer/PooledByteBuf.java:146`、`buffer/src/main/java/io/netty/buffer/PooledByteBuf.java:157`。
3. `AbstractPooledDerivedByteBuf.init(...)` 当前确实先 `wrapped.retain()`，再建立 `parent` 与 `rootParent` 关系，证据：`buffer/src/main/java/io/netty/buffer/AbstractPooledDerivedByteBuf.java:62`。
4. `AbstractPooledDerivedByteBuf.deallocate()` 当前顺序是：暂存 `parent`，清空 `this.parent`/`this.rootParent`，`recyclerHandle.unguardedRecycle(this)`，最后 `parent.release()`，证据：`buffer/src/main/java/io/netty/buffer/AbstractPooledDerivedByteBuf.java:85`。
5. `UnpooledHeapByteBuf.deallocate()` 当前仅执行 `freeArray(array)` 并将 `array` 置为空数组，证据：`buffer/src/main/java/io/netty/buffer/UnpooledHeapByteBuf.java:547`。
6. leak-aware 包装入口在 `AbstractByteBufAllocator.toLeakAwareBuffer(...)`，其中通过 `AbstractByteBuf.leakDetector.track(buf)` 创建跟踪器，证据：`buffer/src/main/java/io/netty/buffer/AbstractByteBufAllocator.java:40`。
7. `SimpleLeakAwareByteBuf.release()` 只有在底层 `super.release()` 返回 `true` 时才关闭 tracker，证据：`buffer/src/main/java/io/netty/buffer/SimpleLeakAwareByteBuf.java:143`。
8. `SimpleLeakAwareByteBuf.unwrappedDerived(...)` 遇到 `AbstractPooledDerivedByteBuf` 时，会更新其 parent，并通过 `trackForcibly(derived)` 强制跟踪，证据：`buffer/src/main/java/io/netty/buffer/SimpleLeakAwareByteBuf.java:191`。
9. `ResourceLeakDetector.track(...)` 与 `trackForcibly(...)` 的职责分别是普通采样跟踪和强制跟踪，证据：`common/src/main/java/io/netty/util/ResourceLeakDetector.java:253`、`common/src/main/java/io/netty/util/ResourceLeakDetector.java:266`。
10. `ResourceLeakDetector.reportLeak()` 当前只负责从引用队列拉取历史泄漏并打印报告，不负责回收业务资源，证据：`common/src/main/java/io/netty/util/ResourceLeakDetector.java:311`。
11. `AdaptivePoolingAllocator.allocate(...)` 存在独立入口，说明它在当前仓库中与 `PooledByteBuf` 体系并存，证据：`buffer/src/main/java/io/netty/buffer/AdaptivePoolingAllocator.java:254`。

### 已刻意避免的旧误解

- 没有把 `deallocate()` 写成“普通 free”。
- 没有把派生对象释放顺序写成“先 parent.release 再 recycle 自己”。
- 没有把 leak detector 写成自动回收器。
- 没有把 `AdaptivePoolingAllocator` 写成 `PooledByteBufAllocator` 的简单升级版。

## 第二轮：因果审

### 因果链是否站得住

1. “双归还”结论有直接源码托底：一个方法里确实包含 `arena.free(...)` 与 `recyclerHandle.unguardedRecycle(this)` 两个动作，且分别对应底层内存回池与对象回 Recycler，不是纯叙事推断。
2. “派生对象先 recycle 再 release parent” 的理由不是作者臆测，而是当前源码注释直接说明：如果不先保存 parent，再 recycle 之后同一对象可能被重新获取并 `init(...)`，导致对错误 parent 调用 `release()`，证据：`buffer/src/main/java/io/netty/buffer/AbstractPooledDerivedByteBuf.java:87`。
3. “忘记 release 会同时卡住底层内存回程与对象外壳回程” 是由 `deallocate()` 根本不执行推导出来的，而不是凭经验口号。只要 refCnt 不归零，`arena.free(...)` 和 `unguardedRecycle(this)` 两步都不会发生。
4. “泄漏检测是观测链，不是回收链” 由 `track/trackForcibly` 与 `reportLeak` 的实现边界支撑；文中没有把 `ResourceLeakDetector` 扩大解释成自动修复器。

### 需要明确标记为推断的地方

- “对象回 Recycler 前，不应还挂着上一轮尚未退回池化体系的底层占用信息” 是基于当前清字段与顺序的设计推断，不是源码注释原句。正文已把它写成实现意图层的解释，没有伪装成注释直译。
- `AdaptivePoolingAllocator` 不纳入主线，是篇章边界决策，不是说两者没有任何可比性。正文已限定为“不能直接套用同一套生命周期描述”。

## 第三轮：结构审

### 结构是否按理解路径推进

当前结构为：

1. 开场收束前 3 篇留下的“怎么还”问题。
2. 先走 3 个失败方案，把最常见误解暴露出来。
3. 再进入原始 `PooledByteBuf` 双归还主线。
4. 然后对照 unpooled，说明 pooled 的额外代价。
5. 再进入派生视图的独立生命周期与释放顺序。
6. 收到泄漏后果与 leak detection 边界。
7. 最后单独收 `AdaptivePoolingAllocator` 的边界。
8. 收网并桥接 Bootstrap。

这个顺序符合“问题 -> 失败 -> 顿悟 -> 机制 -> 回收”，没有按源码文件顺序硬排。

### 结构风险检查

- 没有把 `AdaptivePoolingAllocator` 扩成第二主线，避免篇章失焦。
- 没有在前半段提前透支 Bootstrap 细节，只保留篇末导航。
- 派生视图放在双归还之后，避免读者在没建立“原始 pooled buffer 怎样退场”前就进入更细支线。

## 第四轮：读者审

### 删掉代码块后是否还能成立

通读正文，核心链路都以文字图和角色句表达：

- 两套资源分别归还给谁。
- 为什么原始 pooled buffer 与派生 pooled buffer 的释放顺序不同。
- 为什么 leak detector 只能发现问题，不能替代回收。

代码块只是证据位，不承担主骨架。删掉代码块后，读者仍可复述：

1. `PooledByteBuf` 的 `release()` 最终会走“双归还”。
2. retained 派生对象的危险点是对象池复用导致 release 打错 parent。
3. 泄漏会同时卡住底层内存与对象外壳的回程。

### 可能仍需注意的阅读负担

- “原始 pooled buffer 的风险”和“派生 pooled buffer 的风险”都涉及顺序，正文中已多次显式对照，避免读者把两者混成一个理由。
- `non-retained` 与 `retained` 的区分是必要内容，但已控制在一节内，不再额外展开更多 view 变体。

## 第五轮：边界审

### 已明确的边界

1. 只讨论 `PooledByteBuf` / `AbstractPooledDerivedByteBuf` 这条主线，不混讲 `AdaptiveByteBuf`。
2. 不重讲 `PoolArena.free(...)` 在 small/normal/huge 的全部内部细节，只复用前三篇结论。
3. 不把 leak detector 讲成 JVM 工具章节。
4. 不把当前实现外推成所有 Netty 历史版本都如此。

### 失败路径与风险是否覆盖

- 已覆盖：忘记 `release()` 的失败路径。
- 已覆盖：派生对象错误释放顺序可能导致对错误 parent 调用 `release()`。
- 已覆盖：共享数据不等于共享寿命，避免把派生视图讲成“只是一层窗口”。
- 未展开但已标注：direct 非池化底层最终释放给 JDK/平台的更深路径，不在本文范围内。

### Bug / issue 候选检查

本轮阅读没有形成新的“已确认源码缺陷”证据链。

- `AbstractPooledDerivedByteBuf.deallocate()` 中新增的“清空 parent/rootParent 便于 leak detection”注释，和当前实现一致，没有发现文义冲突。
- `PooledByteBuf.deallocate()` 的顺序与字段清理也没有形成可证实缺陷线索。

结论：本篇未发现需要单列 issue 候选的真实缺陷；只有需要在正文中强调的风险边界，已通过释放顺序与 leak 检测小节覆盖。

## 第六轮：依赖审

### 前置依赖是否真实存在

- Ch4 `01-dual-index-and-refcnt.md`：已存在，且本篇确实硬依赖引用计数语义。
- Ch4 `04-views-and-zerocopy.md`：已存在，且本篇复用“共享数据不等于共享寿命”。
- Ch8 `01-allocator-and-arena.md`、`02-chunk-and-buddy.md`、`03-subpage-and-threadcache.md`：均已存在，且本篇复用 Arena / Chunk / Subpage / ThreadCache 的回程模型。

### 后续桥接是否克制

- 篇末只导航到 Bootstrap 作为“基础设施首次汇合”，没有提前讲 `bind()` 的细节。
- 没有创建未验证的跨域知识边。

## 机械检查

### 禁用词扫描目标

- 此处不再赘述
- 不再展开
- 类似地
- 同理
- 依此类推
- 篇幅所限
- 显然
- 容易看出
- 细节读者自行阅读源码

预期：正文不应命中这些偷懒词。

### 行号引用检查目标

需要二次 grep / read 验证所有 `file:line` 是否仍有效，重点包括：

- `buffer/src/main/java/io/netty/buffer/PooledByteBuf.java:173`
- `buffer/src/main/java/io/netty/buffer/AbstractPooledDerivedByteBuf.java:85`
- `buffer/src/main/java/io/netty/buffer/SimpleLeakAwareByteBuf.java:191`
- `common/src/main/java/io/netty/util/ResourceLeakDetector.java:311`

### 删码测试目标

删除全部 fenced code block 后，正文仍应保留：

- 双归还主线
- pooled vs unpooled 对照
- retained 派生对象释放顺序
- 泄漏后果与检测边界
- Adaptive allocator 边界说明
