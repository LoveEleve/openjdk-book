# Ch3-02 单线程 select 循环 — 六轮 Review Notes

## 第一轮：事实核对

逐条验证正文中的源码行号引用。

| 正文引用 | 核对结果 |
|---------|---------|
| `Selector.java:163-165` — select/select(timeout)/selectNow 唯一本质区别是是否阻塞及阻塞多久 | ✅ Selector.java:163-165 原文："Whether or not a selection operation blocks to wait for one or more channels to become ready, and if so for how long, is the only essential difference between the three selection methods." |
| `AbstractSelectableChannel.java:241-258` — channel close 时 cancel 所有 key | ✅ implCloseChannel() 在 :241 调用 implCloseSelectableChannel()，然后在 :252-258 遍历 copyOfKeys 逐一 `k.cancel()` |
| `AbstractSelector.java:88-94` — cancel 把 key 加进 cancelledKeys | ✅ cancelledKeys 字段在 :88，cancel(SelectionKey k) 方法在 :90-94，synchronized add |
| `SelectorImpl.java:244-268` — processDeregisterQueue 遍历 cancelledKeys，执行 implDereg、selectedKeys.remove、keys.remove、deregister | ✅ :248 取 cancelledKeys，:251-268 遍历，:257 implDereg，:259 selectedKeys.remove，:260 keys.remove，:263 deregister |
| `Selector.java:220-224` — key 在集合中不保证有效 | ✅ :220-224 原文："Keys may be cancelled and channels may be closed at any time. Hence the presence of a key in one or more of a selector's key sets does not imply that the key is valid or that its channel is open." |

事实全部通过，无偏差。

## 第二轮：因果链

1. "非阻塞已经不等了 → 但谁来统一等 → Selector → 但循环怎么写" — 开场因果链与 Ch3-01 末尾衔接正确。 ✅
2. "BIO 一线程一连接 → 线程数随连接涨 → NIO 一线程管所有就绪时机" — 对照逻辑正确，没有把 NIO 说成"完全不需要多线程"，而是限定在 I/O 等待层。 ✅
3. "select() 返回 → selectedKeys 取 key → 按 readyOps 分流 → 处理完 iter.remove()" — 四步闭环因果完整。 ✅
4. "Accept 分支只 accept 不够 → 还要 configureBlocking + register" — 与 Ch2-02 accept 返回阻塞 child 的事实衔接正确。 ✅
5. "Read 三种返回值 n>0/n==0/n==-1 各自处理" — 与 Ch2-01 read 返回值语义、Ch2-03 flip/process/compact 一致。 ✅
6. "OP_WRITE 按需注册 → 长期持有导致空转" — 与 Ch3-01 OP_WRITE 边界一致，因果成立。 ✅
7. "iter.remove() 清结果集 vs cancel() 清注册关系" — 两层职责区分正确。 ✅
8. "cancel 异步 → 下次 selection 才 deregister" — 与 SelectorImpl.processDeregisterQueue 调用时机一致。 ✅

因果链全部通过。

## 第三轮：结构

- 开场困惑 → 四步闭环 → 四类分支 → OP_WRITE → iter.remove vs cancel → 最小骨架 → Netty 桥接 → 收网。 ✅
- 从"模型"到"零件"到"拼装"再到"后继"，符合"问题 → 机制 → 回收"叙事弧。 ✅
- 每个分支统一采用"直觉 → 陷阱 → 正确心智模型"三段结构，内部一致。 ✅
- 未出现"先讲 cancel 再回到 selectedKeys"的跳序。 ✅

结构通过。

## 第四轮：读者理解

- "一个线程怎样同时管住所有连接"作为第一节标题，直觉引入好。 ✅
- 四步闭环用"等、取、分流、清理"四个动词锚定，容易记。 ✅
- Read 三种返回值用"第一种/第二种/第三种"而非"情况一/情况二"标记，语气更自然。 ✅
- OP_WRITE 段把"危险心智模型"和"正确心智模型"正反对比，读者能抓到差异点。 ✅
- iter.remove vs cancel 用"它不会...也不会...只是在说..."做了三层排除，减误读效果好。 ✅

理解通过。

## 第五轮：边界

- 明确"单线程 select loop 不等于所有业务逻辑都必须单线程执行"，只讨论 I/O 等待与最小 Reactor 骨架。 ✅
- 明确"本篇基于 JDK 11 Java 层行为，不把 epoll/kqueue 差异写成抽象规范"。 ✅
- 明确"OP_WRITE 在常见 socket 场景容易持续成立"，没有夸大成所有平台永久就绪。 ✅
- Netty 桥接只做导航，不提前展开 EventLoop/Pipeline 内部实现。 ✅
- 不把空轮询 bug 等工程陷阱提前展开，留到下一篇。 ✅

边界通过。

## 第六轮：依赖与前向引用

### 前向引用合规

- 后续篇章未定义术语没有提前使用。 ✅
- "下一篇进入 Selector 的工程陷阱"只在收网做导航，正文未提前展开。 ✅
- Netty EventLoop/Pipeline/ChannelOutboundBuffer 只在收网提及，正文未提前展开。 ✅

### 前置依赖回收

- Ch1 `flip/compact/clear` 状态机：在 Read 分支回扣 ✅
- Ch2-01 `read()` 返回值与部分进度：在 Read 分支回扣 ✅
- Ch2-02 `accept()` 返回阻塞 child + connect 两拍：在 Accept 和 Connect 分支回扣 ✅
- Ch2-03 `configureBlocking` 责任上浮 + `read→flip→process→compact` 循环：在 Accept 和 Read 分支回扣 ✅
- Ch3-01 register/三套集合/SelectionKey/四种事件/selectedKeys/wakeup/cancel：全篇回扣 ✅

### 完备性问题覆盖

| Ch3 完备性问题 | 本文是否覆盖 |
|:--:|:--:|
| 6. 完整的 select 循环怎么写？ | ✅ 四步闭环 + 最小骨架 |
| 7. cancel() 做了什么？key 以后还能用吗？ | ✅ 第五节 |
| 8. wakeup() 怎么打断正在阻塞的 select？ | ⚠️ 本篇未展开，Ch3-01 已给最小合同并在本篇 select 步骤中隐含使用；wakeup 在工程陷阱篇更合适 |
| 9. OP_WRITE 为什么几乎总是就绪？怎么避免？ | ✅ 第四节 |
| 架构师 1. NIO 一线程多连接 vs BIO 一线程一连接 | ✅ 第一节 |
| 架构师 2. 为什么 OP_WRITE 连续触发会让 NIO 退化为轮询？ | ✅ 第四节 |
| 架构师 3. wakeup 在多线程模型中的作用 | ⚠️ 同上，留到工程陷阱篇 |

说明：wakeup() 的工程级展开（多线程竞态、具体机制）更适合放到 Ch3 工程陷阱篇，Ch3-01 已给出最小合同，本篇在 select 步骤中隐含使用但未单独展开，这是合理的篇间拆分。

## 机械检查

### 禁用词

无禁用词。 ✅

### 行号引用

4 处源码行号引用全部核对通过。 ✅

### 删码测试

删除代码块后，正文逻辑完整可读，叙事没有断裂。 ✅

### 字数

- 总行数：384
- 去码后字符数：6923
- 去码去空白后字符数：6146
- 符合 6000+ 字预算。 ✅

## 结论

- Ch3-02 六轮 review 全部通过，无需修订。
- 可进入 Ch3-03（Selector 工程陷阱）。
