# Ch5-03 epoll bug 与 Selector 重建 — rewrite-plan

## 篇章定位

- 核心困惑：Selector 已经有了策略选择和 selectedKeys 优化，为什么生产环境里仍会出现 CPU 100% 但 GC 正常、网络流量也不高的“空转”事故？Netty 为什么还要维护 `wakenUp`、`selectCnt` 和 `rebuildSelector0()` 这套看起来很重的防线？
- 一句话顿悟：EventLoop 的真正敌人不是“这次有没有 I/O”，而是“底层 selector 什么时候会在错误时机醒来或漏掉唤醒”；Netty 用三层手段处理三种不同故障：CAS+wakeup 补偿防时序丢唤醒，`selectCnt` 区分正常超时与异常连续提前返回，`rebuildSelector0()` 在确认 selector 已失去预期行为后整体迁移注册关系。
- 篇章边界：重点讲当前 `NioIoHandler` 的 wakeup 协议、premature select 检测、阈值配置与 selector 重建；不展开多线程 group 感知和 chooser，留 Ch5-04。

## 依赖

### HARD

- Ch3-03：JDK Selector 的空轮询、wakeup 竞态和 selectedKeys 边界。
- Ch5-01：EventLoop 主循环、canBlock、register 线程亲和。
- Ch5-02：SelectStrategy、selectedKeys plain/optimized 路径、`selectAgain`。

### SOFT

- JDK NIO/epoll 历史 bug 背景：正文只作背景，不把某个 bug ID 当作当前实现证明。
- 日志/SRE 故障排查：正文会给可观测信号。

### NAV

- Ch5-04：多线程 EventLoopGroup、chooser、特殊 loop。
- Ch6：重建/注册异步结果如何通过 Future/Promise 传播。
- Native transport 后续篇：epoll/kqueue 等后端的进一步差异。

## 素材事实卡片

### 卡片 A：wakeup 第一层防线

- `NioIoHandler.java:111`：`AtomicBoolean wakenUp`。
- `NioIoHandler.java:615-618`：只有非 executor 线程且 `compareAndSet(false, true)` 成功时才真正 `selector.wakeup()`。
- `NioIoHandler.java:433-466`：select 返回后再次检查 `wakenUp.get()`，必要时补一次 `selector.wakeup()`；注释明确描述“too early”竞态窗口。
- `NioIoHandler.java:736-744`：`selectNow()` finally 中若 `wakenUp` 仍为 true，再次 `selector.wakeup()` 恢复唤醒状态。
- 关键边界：这层防的是唤醒时序错位，不是 epoll 本身的 premature return bug。

### 卡片 B：premature select 检测

- `NioIoHandler.java:66-88`：`MIN_PREMATURE_SELECTOR_RETURNS = 3`；`SELECTOR_AUTO_REBUILD_THRESHOLD` 默认读系统属性 512，若 <3 则置 0（禁用）。
- `NioIoHandler.java:633-707`：`selectCnt` 在 `select()` 循环内部累积。
- `NioIoHandler.java:671-677`：只要 selectedKeys!=0、oldWakenUp、wakenUp.get()、或不能阻塞，就 break，这些都不是 bug 信号。
- `NioIoHandler.java:693-704`：当时间差显示这是正常 timeout，`selectCnt=1`；只有“不是 timeout，又连续返回”才走阈值检测。
- `NioIoHandler.java:709-714`：超过 `MIN_PREMATURE_SELECTOR_RETURNS` 会打 debug 日志。
- 关键边界：Netty 不把“单次 `select()==0`”定性为 bug，而是区分 timeout、wakeup、任务、interrupt 与连续提前返回。

### 卡片 C：重建路径

- `NioIoHandler.java:747-759`：`selectRebuildSelector(selectCnt)` 先 warn，再 `rebuildSelector0()`，再对新 selector 做一次 `selectNow()` 填充 selectedKeys。
- `NioIoHandler.java:255-302`：`rebuildSelector0()` 创建新 selector，遍历旧 selector keys，跳过失效 key 或已在新 selector 注册的 channel，对每个 handle 执行 `handle.register(newSelector)`，然后替换 `selector/unwrappedSelector` 并关闭旧 selector。
- 失败重注册时 `handle.cancel()`，见 `NioIoHandler.java:281-284`。
- 原子替换发生在循环迁移完成后，见 `NioIoHandler.java:287-289`。
- 关键边界：迁移不是复制底层 selected state，而是重新建立注册关系；未处理就绪事件的再可见性依赖内核缓冲区和后续 select，而不是把旧 selectedKeys 搬过来。

### 卡片 D：SRE 可观测信号

- `NioIoHandler.java:750-752`：warn 日志 “Selector.select() returned prematurely ... rebuilding Selector ...”。
- `NioIoHandler.java:709-714`：debug 日志连续提前返回次数。
- `NioIoHandler.java:684-687`：线程被 interrupt 时的 debug 日志，说明这不是 epoll bug，而是用户或库线程中断。
- `NioIoHandler.java:471-475`：`IOException` 时也会直接 rebuildSelector0()。
- 要在正文里区分：CPU 100% 但 GC 正常 + “prematurely returned”日志，是 selector 路径故障的典型信号；如果是 interrupt 日志，则属于另一类问题。

## 理解路径

1. **从 SRE 场景切入**：CPU 100%、GC 正常、流量不高，为什么 EventLoop 还在忙？
2. **先区分三类返回**：正常 timeout / wakeup / task 导致的返回，与“连续提前返回”不是一回事。
3. **讲第一层防线**：`wakenUp` CAS 和 select 返回后补 wakeup，解决“唤醒发生在坏窗口”问题。
4. **讲第二层检测**：`selectCnt` 只在可疑连续返回时增长，timeout 和有工作返回会重置；阈值可配置且 <3 即禁用。
5. **讲第三层恢复**：rebuildSelector0 不是清空 selectedKeys，而是重建 selector 并迁移注册。
6. **讲为什么迁移不等于丢连接**：注册关系迁移完成后，新 selector 再 `selectNow`，事件的再次可见性由内核可读/可写状态决定；但正文避免做超出源码的绝对承诺。
7. **讲可观测性与误判**：interrupt、IOException、premature select 各自日志和处理不同。
8. **收网**：这三层不是一个 bug 的三个重复补丁，而是“唤醒竞态 -> 可疑连续返回 -> 彻底重建”的递进防线。

## 失败方案推演

- 一看到 `select()==0` 就重建：正常 timeout/wakeup 也会触发，误伤过大。
- 只靠 wakeup CAS，不做连续提前返回检测：内核/selector 本身故障时仍会空转。
- 只记录日志，不自动重建：生产现场 CPU 会持续浪费，恢复依赖人工干预。
- 重建时只复制 selectedKeys，不重建注册关系：下轮 select 无法继续接管所有 channel。
- 重建前先关闭旧 selector 再迁移：会先打断现有注册集合，迁移窗口更危险。

## 文章结构与预算

1. CPU 100% 但没流量：故障场景引入（1000-1300 字）
2. 三类 select 返回先分清（1700-2200 字）
3. 第一层：wakeup CAS 与补偿唤醒（1800-2300 字）
4. 第二层：premature select 检测与阈值（2000-2500 字）
5. 第三层：rebuildSelector0 的迁移与边界（2000-2600 字）
6. 日志、误判与排查信号（1200-1600 字）
7. 收网与 Ch5-04 桥接（900-1200 字）

目标：删掉代码后的叙述性正文 9500-11000 字。

## 证据清单

- `NioIoHandler.java:66-88`
- `NioIoHandler.java:255-302`
- `NioIoHandler.java:433-466`
- `NioIoHandler.java:615-618`
- `NioIoHandler.java:630-744`
- `NioIoHandler.java:747-759`
- `NioIoHandler.java:471-475`
- `NioIoHandler.java:684-714`

## 边界清单

- 不把某个 JDK bug ID 当作当前源码事实的唯一证据；正文以 Netty 当前实现和注释为主。
- 不把单次 `select()==0` 或一次 `selectNow()==0` 写成 bug 判定条件。
- 不把 `SELECTOR_AUTO_REBUILD_THRESHOLD=512` 解释成固定时间窗口；它是次数阈值，不等于 51 秒之类固定时间。
- 不对“重建期间事件绝不丢失”作超出源码的绝对承诺；只说明注册迁移时序和后续 selectNow 的动作。
- wakeup CAS 防的是信号时序错位，不等于修复 epoll bug 本身。
- 线程 interrupt、IOException、premature select 要分开叙述，不混成同一类故障。

## 深审预警

- [ ] 修正大纲中“连续 512 次 select 都返回 0 一定是 bug”“约 51 秒后触发”的旧表述。
- [ ] 不把 `selectedKeys.isEmpty()` 当作源码里直接参与阈值判断的条件；当前实现靠时间和上下文分支。
- [ ] 说明 `selectCnt=1` 在 timeout、interrupt、rebuild 后都可能被设置，不是简单清零。
- [ ] 不把 wakeup 补偿逻辑和 epoll 假唤醒混为一个问题。
- [ ] 重建迁移讲清先迁移后替换再关闭旧 selector 的顺序。
- [ ] 如果深审中能从当前实现里定位出真实漏洞或边界缺口，按新增方法论记录为 issue 候选，不强行猜测。
