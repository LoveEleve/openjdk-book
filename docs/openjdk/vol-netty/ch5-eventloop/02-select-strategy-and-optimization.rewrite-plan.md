# Ch5-02 SelectStrategy 与 selector 优化 — rewrite-plan

## 篇章定位

- 核心困惑：EventLoop 已经知道“有任务时别轻易阻塞”，那 runIo 这一轮到底怎么决定是 `select()`、`selectNow()` 还是直接继续？当 selected keys 多到成千上万时，JDK 原生 `HashSet + Iterator` 为什么会成为瓶颈？
- 一句话顿悟：SelectStrategy 决定的是“本轮 select 阶段的行为意图”，而不是整个 run() 的最终动作；Netty 再把 JDK 的 `selectedKeys` HashSet 注入成数组集合，用更少分配和更便宜遍历降低热点成本。
- 篇章边界：重点讲三态 SelectStrategy、DefaultSelectStrategy 的真实行为、`NioIoHandler.run/select` 配合、SelectedSelectionKeySet 与注入路径、optimized/plain 遍历和 `needsToSelectAgain`；epoll premature select/rebuild 留 Ch5-03，多线程 chooser 留 Ch5-04。

## 依赖

### HARD

- Ch5-01：EventLoop 单线程主循环、canBlock、MPSC、tailTasks、register 线程亲和。
- Ch3 Selector：select/selectNow/wakeup/selectedKeys 基础语义。

### SOFT

- Ch3-03：wakeup 竞态和 selectedKeys 累积的生产级风险。
- 反射/Unsafe 修改 JDK 私有字段：正文给最小解释，不展开 JVM 安全模型。

### NAV

- Ch5-03：premature select returns、CAS wakeup、防护与 rebuildSelector。
- Ch5-04：多线程 group/chooser/特殊 loop。
- JDK Selector 优化之外的 native transport（epoll/kqueue）后续篇。

## 素材事实卡片

### 卡片 A：SelectStrategy 语义

- `SelectStrategy.java:26-51`：`SELECT=-1`、`CONTINUE=-2`、`BUSY_WAIT=-3`；`>=0` 代表有工作要处理。
- `DefaultSelectStrategy.java:28-31`：`hasTasks ? selectSupplier.get() : SELECT`。
- 关键边界：DefaultSelectStrategy 并不直接在“有任务”时返回 `CONTINUE`；它让 `selectSupplier`（当前实现下通常是 `selectNow()`）先给出结果。
- `NioIoHandler.run()` 中对 `CONTINUE` 单独返回；其余 `>=0` 值会落到 `default` 路径，随后继续处理 selected keys / tasks。

### 卡片 B：NioIoHandler.run/select

- `NioIoHandler.java:420-469`：`calculateStrategy(selectNowSupplier, !context.canBlock())`；`CONTINUE` 直接返回 0，`BUSY_WAIT` 在 NIO 上 fall through 到 `SELECT`，`SELECT` 进入 `select(context, oldWakenUp)`。
- `NioIoHandler.java:478-488`：选择 plain 或 optimized selectedKeys 处理。
- `NioIoHandler.java:630-677`：`select()` 内部在有到期定时任务/不能阻塞时用 `selectNow()` 快速探测，真正的阻塞 select 取决于 timeoutMillis 和 wakeup 状态。
- 关键边界：DefaultSelectStrategy 的返回值只是“这一轮 select 阶段要不要阻塞”的起点；`run()` 还会结合 `oldWakenUp / wakenUp / !runner.canBlock()` 等条件决定何时 break。

### 卡片 C：SelectedSelectionKeySet

- `SelectedSelectionKeySet.java:25-46`：数组 + size，尾部 append，满了翻倍。
- `SelectedSelectionKeySet.java:48-62`：`remove` 永远 false，`contains` 线性扫描。
- `SelectedSelectionKeySet.java:95-108`：`reset()` 和 `reset(int start)` 清空数组区间。
- 关键边界：它不是通用 Set 替代品，只覆盖 Netty 需要的 add/reset/顺序遍历场景；`contains` 存在但不是优化目标。

### 卡片 D：Selector 注入

- `NioIoHandler.java:143-233`：`openSelector()` 创建原始 selector，若未禁用优化则尝试定位 `sun.nio.ch.SelectorImpl`。
- `NioIoHandler.java:186-216`：Java 9+ 优先 Unsafe field offset 注入 `selectedKeys/publicSelectedKeys`；失败则反射 `Field.set()`。
- `NioIoHandler.java:224-233`：注入失败时 `selectedKeys=null`，返回原始 selector；成功时包装成 `SelectedSelectionKeySetSelector`。
- `SelectedSelectionKeySetSelector.java:54-68`：每次 `select/selectNow` 前先 `selectionKeys.reset()`，再委托给原 selector。
- `NioIoHandler.java:151-153`：`io.netty.noKeySetOptimization` 可禁用。

### 卡片 E：optimized vs plain 遍历

- `NioIoHandler.java:510-515`：有 selectedKeys 数组就走 optimized，没有就走 plain iterator。
- `NioIoHandler.java:527-560`：plain 路径每次拿 iterator、`i.remove()`，`needsToSelectAgain` 时 `selectAgain()` 后重建 iterator。
- `NioIoHandler.java:563-583`：optimized 路径直接数组 for 循环，置空已处理槽位；`needsToSelectAgain` 时 `selectedKeys.reset(i + 1)` 再 `selectAgain()`，并把 `i=-1` 重新开始。
- `NioIoHandler.java:762-768`：`selectAgain()` 执行 `selector.selectNow()` 更新 SelectionKeys。
- 关键边界：optimized 并不是“完全不要清理”，而是把 per-key `iterator.remove()` 换成数组置空 + 批量 reset。

## 理解路径

1. **从 Ch5-01 的“有任务时别阻塞”继续追问**：到底谁在这一轮决定要不要 select？
2. **先讲 SelectStrategy 不是 run() 总调度器**：它只产出 select 阶段的策略值。
3. **再讲 DefaultSelectStrategy 的真实行为**：有任务时先 `selectNow` 试探，不是直接 CONTINUE。
4. **把 `NioIoHandler.run()` 的 switch 补齐**：为什么 `CONTINUE` 立即返回，`BUSY_WAIT` 在 NIO 上退化到 SELECT，`>=0` 值如何落到后续 selected keys 处理。
5. **再转向 selectedKeys 优化**：为什么 JDK HashSet/Iterator 会成为热点，SelectedSelectionKeySet 数组到底省掉了什么、又放弃了什么。
6. **讲注入路径与失败降级**：Unsafe/反射替换两个私有字段，失败时功能正确但性能退化。
7. **讲 optimized/plain 遍历与 `needsToSelectAgain`**：数组 reset 为什么从 `i+1` 开始，plain 路径为什么要重建 iterator。
8. **收网**：SelectStrategy 决定“这一轮是否值得阻塞”，数组优化决定“就绪结果如何更便宜地消费”，下一篇再讲 premature select/rebuild。

## 失败方案推演

- 有任务就永远跳过所有 select：I/O 可能长期看不见，丢掉“先探测一下有没有就绪”的机会。
- 每轮都阻塞 select：普通任务和定时任务响应延迟上升。
- 完全依赖 JDK selectedKeys HashSet：功能正确，但高频 Iterator/哈希操作成为热点。
- 数组优化仍保留随机删除/查找语义：会把简单数据结构重新拖回复杂集合，实现收益下降。
- 注入失败时直接报错终止：把性能优化提升成正确性前提，不合理；应降级到 plain 路径。

## 文章结构与预算

1. 本轮到底等不等 IO（1000-1300 字）
2. SelectStrategy 三态与 DefaultSelectStrategy 的真实行为（2000-2500 字）
3. `NioIoHandler.run()/select()` 如何消费策略值（1800-2300 字）
4. 为什么 JDK HashSet 不够：SelectedSelectionKeySet 数组模型（1700-2200 字）
5. Unsafe/反射注入与失败降级（1600-2100 字）
6. optimized/plain 遍历与 `needsToSelectAgain`（1700-2200 字）
7. 误解澄清与 Ch5-03 桥接（1000-1300 字）

目标：删掉代码后的叙述性正文 9000-10500 字。

## 证据清单

- `SelectStrategy.java:26-51`
- `DefaultSelectStrategy.java:28-31`
- `NioIoHandler.java:143-233`
- `NioIoHandler.java:420-515`
- `NioIoHandler.java:527-583`
- `NioIoHandler.java:630-768`
- `SelectedSelectionKeySet.java:25-108`
- `SelectedSelectionKeySetSelector.java:24-68`

## 边界清单

- 当前 NIO 实现中 `BUSY_WAIT` 不被真正支持，而是退化到 `SELECT`。
- DefaultSelectStrategy 的“有任务时 selectNow”是当前默认策略，不外推到所有自定义 SelectStrategy。
- `0` 不是 `SelectStrategy.CONTINUE` 常量本身，只是在当前 run 路径里会走非阻塞后的继续处理逻辑；不能把两者硬等号化。
- SelectedSelectionKeySet 是面向 Netty 当前消费模式的定制结构，不是通用 Set 替代品。
- Unsafe/反射注入是实现细节，失败时应降级 plain 路径；不要把它写成功能正确性的前提。
- `needsToSelectAgain` 与 epoll premature select/rebuild 不是同一个机制，后者留 Ch5-03。

## 深审预警

- [ ] 修正大纲里“hasTasks 时直接返回 CONTINUE”的旧认知。
- [ ] 不把 `selectNow() == 0` 直接说成返回 `CONTINUE` 常量；要区分策略返回值与 run() 效果。
- [ ] `SelectedSelectionKeySet.remove()` 永远 false 是源码事实，但要解释为什么不影响 Netty 的当前消费模式。
- [ ] `contains()` 线性扫描要作为边界补一句，避免读者误会它是通用高性能集合。
- [ ] 注入路径要强调同时替换 `selectedKeys` 和 `publicSelectedKeys` 两个字段。
- [ ] optimized 遍历里 `reset(i+1)` 的语义要说清：只清剩余未处理槽位，已处理槽位此前已手工置 null。
