# Ch3-03 Selector 工程陷阱 — 六轮 Review Notes

## 第一轮：事实核对

逐条验证正文中的源码行号引用（共 13 处，修订后 14 处）。

| 正文引用 | 核对结果 |
|---------|---------|
| `Selector.java:163-165` — select/select(timeout)/selectNow 唯一本质区别 | ✅ |
| `EPollSelectorImpl.java:112-120` — EPoll.wait 返回值赋给 numEntries | ✅ |
| `EPollSelectorImpl.java:121-130` — INTERRUPTED 重试逻辑 | ✅ |
| `EPollSelectorImpl.java:181-207` — processEvents 完整方法 | ✅ |
| `Selector.java:216-218` — selection 进行中 interest set 变更不影响当前轮 | ✅ |
| `EPollSelectorImpl.java:61-63` — fd0/fd1 interrupt fd 字段 | ✅ |
| `EPollSelectorImpl.java:76-94` — 构造器创建 pipe + 注册 fd0 | ✅ |
| `EPollSelectorImpl.java:249-262` — wakeup() 向 fd1 写字节 | ✅ |
| `EPollSelectorImpl.java:186-205` — processEvents 识别 fd0 + interrupted | ✅ |
| `EPollSelectorImpl.java:264-268` — clearInterrupt drain fd0 + 重置标志 | ✅ |
| ~~`Selector.java:254-256`~~ → `Selector.java:592-606` — wakeup 幂等合同 | ✅ 已修正：原引用 254-256 是 ConcurrentModificationException 段，wakeup 合同在 592-606 |
| `Selector.java:105-108` — selection 增加或更新 selected-key set | ✅ |
| `Selector.java:139-150` — key 已在 selected-key set 则按位并 | ✅ |
| `SelectorImpl.java:279-304` — processReadyEvents | ✅ |
| `Selector.java:145-150` — 旧 readiness 被保留 | ✅ |
| `SelectorImpl.java:244-268` — processDeregisterQueue | ✅ |
| `SelectorImpl.java:259` — selectedKeys.remove(ski) | ✅ |
| `Selector.java:220-224` — key 在集合中不等于有效 | ✅ |

发现一处行号错误已修正。

## 第二轮：因果链

1. "裸 NIO 能跑但不够生产级 → 三个坑的共同根源是底层语义透传" — 开场因果成立。 ✅
2. "select() 返回 0 正常 vs 连续返回 0 异常 → epoll_wait 假唤醒 → JDK 不检测 → CPU 100%" — 因果链完整，且把"JDK 能证明的"和"平台观测到的"做了区分。 ✅
3. "wakeup 解决等待打断 → fd1 写字节 → fd0 可读 → clearInterrupt drain → 竞态窗口但不丢唤醒" — 因果链与 EPollSelectorImpl 源码一致。 ✅
4. "selectedKeys 不是快照 → 不 remove → key 重复进入分支 + readyOps 不清零 + cancel 交叉窗口" — 三层后果递进正确。 ✅
5. "三个坑共同根源 → Netty 补保护层 → Ch4/Ch5 导航" — 收网因果成立。 ✅

因果链通过。

## 第三轮：结构

- 开场 → 空轮询 → wakeup 竞态 → selectedKeys 累积 → 收网。 ✅
- 每个坑统一采用"现象 → 源码路径 → 后果 → 为什么简单修复不够"的结构。 ✅
- 空轮询段特别做了"正常返回 0 vs 异常空转"的前置区分，防止读者过度反应。 ✅
- 收网把三个坑的共同根源收束为"底层语义透传、缺少工程保护层"，不散落。 ✅

结构通过。

## 第四轮：读者理解

- "一次返回 0 可能正常，连续、快速、无事件的返回 0 才值得怀疑" — 给了读者可操作的判断标准。 ✅
- wakeup 段用"三个不保证"收尾（不保证只打断一次、不保证有业务 key），防止误判。 ✅
- selectedKeys 累积用"两层后果 + cancel 交叉窗口"递进，不是简单重复 Ch3-01/02 的内容。 ✅
- iter.remove() 的角色定义为"消息确认"而非"清理集合"，这个比喻帮助理解。 ✅

理解通过。

## 第五轮：边界

- 明确"本篇基于 JDK 11 Linux EPollSelectorImpl，PollSelectorImpl/KQueueSelectorImpl 差异不展开"。 ✅
- 空轮询 bug 明确区分"JDK 源码能证明的传递路径"与"平台/内核观测到的假唤醒现象"，没有把空轮询写成 JDK 规范行为。 ✅
- Netty 的 rebuildSelector 解法只做 Ch5 导航，不提前展开。 ✅
- wakeup 竞态讨论限定在"不丢唤醒、但可能多唤醒一次"，不展开 Netty 的 wakeup 优化。 ✅
- 不写成"NIO 不能用于生产"，而是"裸 NIO 缺工程保护层"。 ✅

边界通过。

## 第六轮：依赖与前向引用

### 前向引用合规

- Ch4 ByteBuf、Ch5 EventLoop 只在收网做导航，正文未提前展开 EventLoop/Pipeline/ChannelOutboundBuffer 实现细节。 ✅
- 空轮询的 Netty 解法（SELECTOR_AUTO_REBUILD_THRESHOLD、rebuildSelector）只在收网一句话提及，不展开。 ✅

### 前置依赖回收

- Ch3-01 三套集合、SelectionKey/readyOps、wakeup/cancel 基本语义：全篇回扣 ✅
- Ch3-02 四步闭环、iter.remove vs cancel、OP_WRITE 按需注册：在 selectedKeys 累积段回扣 ✅
- Ch2 read 返回值、configureBlocking：在空轮询段间隔回扣 ✅

### 完备性问题覆盖

| Ch3 完备性问题 | 本文是否覆盖 |
|:--:|:--:|
| 4. selectedKeys() 为什么必须手动 remove？不 remove 会怎样？ | ✅ 第三节完整展开 |
| 8. wakeup() 怎么打断正在阻塞的 select？ | ✅ 第二节完整展开（含 Linux 实现与时序窗口） |
| 架构师 2. 为什么 OP_WRITE 连续触发会让 NIO 退化为轮询？ | Ch3-02 已覆盖，本节不重复 |
| 架构师 3. wakeup 在多线程模型中的作用 | ✅ 第二节 |

说明：本篇补上了 Ch3-01/02 未深入展开的 wakeup 和 selectedKeys 累积的生产级后果，Ch3 的完备性问题至此全覆盖。

## 机械检查

### 禁用词

无禁用词。 ✅

### 行号引用

14 处源码行号引用全部核对通过（一处已修正）。 ✅

### 删码测试

删除代码块后，正文逻辑完整可读，叙事没有断裂。 ✅

### 字数

- 总行数：327
- 去码后字符数：7133
- 去码去空白后字符数：6361
- 符合 6000+ 字预算。 ✅

## 深度 Review

### 发现 1：wakeup 竞态结论过于绝对（高风险，已修复）

原文把“竞态发生在 clearInterrupt 前后”直接归纳为“不会丢唤醒”，没有区分 JDK 原生 wakeup 的锁协议与上层事件循环为减少 wakeup 调用而维护的状态标志。JDK 的 `EPollSelectorImpl` 确实在 `interruptLock` 内保护 `interruptTriggered` 和 pipe 清理，见 `EPollSelectorImpl.java:249-268`；但 Netty 还维护 `wakenUp`，外部线程通过 CAS 决定是否调用 selector.wakeup，select 线程在 select 前后读取这个标志，见 `NioIoHandler.java:433-466`、`:614-618`。原文把两层协议混为一谈，可能让读者误以为任意上层 wakeup 优化都天然无丢唤醒风险。

修复：重写“为什么说它有竞态”一节，先说明 JDK 原生锁保护，再以 Netty `wakenUp` 为例解释真正的上层竞态窗口，并收紧为“JDK API 只保证唤醒 selection，不保证返回时有业务 key；上层标志协议必须自行证明时序正确”。

### 发现 2：混淆 epoll 返回条目数与 Selector 返回 key 数（中风险，已修复）

原文从 `numEntries == 0` 推导 `select()` 返回 0 没问题，但没有说明反向边界：`numEntries > 0` 也不等于有业务 key 被选中，因为 epoll 返回的唯一条目可能是内部唤醒 fd。`processEvents` 对 fd0 只设置 `interrupted`，不会更新业务 key，见 `EPollSelectorImpl.java:186-207`。

修复：补充 `select()` 返回值是“被更新的业务 key 数”而非底层描述符数，并明确只有唤醒 fd 就绪时最终也可能返回 0。

### 发现 3：唤醒 fd 被称为“普通 Socket”不准确（低风险，已修复）

原文“fd0 和普通 Socket 一样”会让读者误以为 JDK 的唤醒机制使用 SocketChannel。实际源码是在构造器中创建 pipe 并把 fd0 注册到 epoll，见 `EPollSelectorImpl.java:76-94`。

修复：改为“专门注册到 epoll 中的唤醒文件描述符”。

## 修订记录

- 修正 `Selector.java:254-256` → `Selector.java:592-606`（wakeup 幂等合同的真实行号位置）。
- 补充 epoll 描述符数与 Selector 业务 key 数的边界。
- 重写 wakeup 竞态分析，加入 Netty `NioIoHandler.wakenUp` 上层状态协议的源码证据。
- 修正唤醒 fd 的表述。

## 结论

- Ch3-03 六轮 review 与深度 review 完成，3 个问题已修正。
- Ch3 全部三篇完成，Ch3 完备性问题全覆盖。
- 可进入 Ch4 Netty ByteBuf。
