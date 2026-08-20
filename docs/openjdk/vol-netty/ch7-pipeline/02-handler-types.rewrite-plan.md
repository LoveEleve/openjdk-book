# Ch7-02 Handler 类型与 mask — rewrite-plan

## 篇章定位

- 核心困惑：Pipeline 的骨架已经有了，那为什么 handler 还要分 inbound、outbound、duplex、adapter、simple、combined 这么多类？Netty 又是怎么在运行时快速跳过不匹配的节点，而不是每次都挨个 `instanceof` 判断？
- 一句话顿悟：Handler 分类不是命名癖，而是在把“我处理哪一类事件”“我默认转发哪些事件”“我能不能复用实例”这些约束静态化；`ChannelHandlerMask` 再把这些能力预编成位掩码，让 `findContextInbound/Outbound` 用跳过规则快速找到下一个真正关心该事件的节点。
- 篇章边界：重点讲 inbound/outbound/duplex、adapter 的 `@Skip` 语义、`ChannelHandlerMask` 的位掩码与缓存、`@Sharable`/checkMultiplicity、`SimpleChannelInboundHandler` 的 autoRelease、`CombinedChannelDuplexHandler` 的双上下文代理；handler 生命周期和 initializer 放到后续篇。

## 依赖

### HARD

- Ch7-01：Pipeline 是 head/tail 哨兵包围的双向链表，Context 才是真正传播节点。
- Ch4 ByteBuf / Ch6 Promise：消息释放与出站 promise 语义会在 handler 类型里被引用。

### SOFT

- 反射/注解缓存：正文给最小解释。
- 责任链与 decorator：作为 Combined handler 和 adapter 的背景。

### NAV

- Ch7-03：Outbound buffer、write/flush 深入。
- Ch7-04：ChannelInitializer、pending callback、handlerAdded/Removed 生命周期。
- Ch10：decoder/encoder 作为 inbound/outbound 典型实例。

## 素材事实卡片

### 卡片 A：类型接口

- `ChannelInboundHandler.java:22-75`：9 个入站回调（含 exceptionCaught）。
- `ChannelOutboundHandler.java:23-99`：8 个出站回调；`read()` 在这里属于“请求读”的出站动作。
- `ChannelDuplexHandler.java:23-29`：组合 inbound + outbound 能力。
- 关键叙事：入站“收到/状态变化”与出站“请求执行 I/O 操作”不是一回事。

### 卡片 B：adapter + `@Skip`

- `ChannelInboundHandlerAdapter.java:20-145`：所有默认实现都是 `ctx.fire...` 转发，并打 `@Skip`。
- `ChannelOutboundHandlerAdapter.java:22-127`：所有默认实现都 `ctx.bind/write/flush...` 转发，并打 `@Skip`。
- `ChannelDuplexHandler.java:31-128`：出站默认转发同样打 `@Skip`。
- `ChannelHandlerMask.Skip` 注解定义在 `ChannelHandlerMask.java:188-204`，语义是“仅在该方法除了转发什么都不做时才允许跳过”。

### 卡片 C：mask 预计算

- `ChannelHandlerMask.java:35-63`：17 个 mask 位和 inbound/outbound 聚合位。
- `ChannelHandlerMask.java:65-85`：`FastThreadLocal<WeakHashMap<Class<? extends ChannelHandler>, Integer>>` 缓存 mask。
- `ChannelHandlerMask.java:91-164`：根据 handler 是否实现 inbound/outbound 接口先置全量位，再对每个方法检查 `@Skip` 决定清掉对应位。
- `ChannelHandlerMask.java:166-183`：`isSkippable` 通过反射拿方法并检查注解。
- 关键边界：不是每次传播动态反射检查，而是按 handler class 缓存一次 mask。

### 卡片 D：skipContext 与传播搜索

- `AbstractChannelHandlerContext` 当前文件中有 `findContextInbound/findContextOutbound`（需正文里核对具体实现位置）通过 executionMask 跳过不匹配节点。
- 当前传播不是“每个节点都进 if/else”，而是根据 mask 快速找到下一个需要处理该事件的 context。
- 如果绑定不同 executor，不能简单继续跳过，需要把线程归属一起纳入考虑；正文要以当前实现为准，不凭记忆写旧版 `skipContext` 细节。

### 卡片 E：Sharable / multiplicity

- 需要补读 `ChannelHandler.java` / `ChannelHandlerAdapter.java` / `DefaultChannelPipeline.checkMultiplicity()` 当前源码位置。
- 叙事目标：`@Sharable` 只是允许同一实例进入多个 pipeline，不是线程安全保证；非 sharable 重复添加应在 pipeline add 阶段失败。
- 如当前实现已不用 ThreadLocal 缓存 sharable 检查，要按当前源码修正大纲旧认知。

### 卡片 F：Simple / Combined

- `SimpleChannelInboundHandler` 需补读：autoRelease 何时释放、匹配失败是否转发。
- `CombinedChannelDuplexHandler.java:220-389`：入站和出站委托给各自 handler；`DelegatingChannelHandlerContext` 持有原 ctx 和具体 handler。
- 关键叙事：Combined 不是“把两个 handler 合并成一个类文件”，而是给一个 pipeline 位置上放了两套方向不同的委托。

## 理解路径

1. **先问为什么要有这么多 handler 类型**：因为 inbound/outbound 不是同一类事件，默认转发与实际处理也不是一回事。
2. **解释 inbound/outbound/duplex 的职责分工**：先建立“收到数据”和“请求写数据/读数据”是两个层面。
3. **解释 adapter 的意义**：用户多数只关心 1-2 个方法，其他默认转发；`@Skip` 让这种默认转发不必每次真的进入方法。
4. **解释 mask**：把 handler 能力静态编码成位掩码，传播时按位跳过不匹配节点。
5. **解释 sharable 与 multiplicity**：实例能否复用和线程安全不是同一个问题。
6. **解释 Simple 和 Combined**：一个解决消息释放策略，一个解决双向委托组合。
7. **收网**：handler 类型体系 + mask 让 Pipeline 不只是“能传播”，而是“只传播到真正该接这个事件的人”。

## 失败方案推演

- 所有 handler 都实现大而全的 duplex 接口：职责模糊，跳过规则失效，默认转发代码泛滥。
- 每次传播都用 `instanceof`/反射检查 handler 能力：长链高频传播会重复做相同判断。
- `@Sharable` 被当成线程安全承诺：同一实例内部可变状态会跨 Channel 串扰。
- SimpleInboundHandler 自动释放一切消息：如果消息仍需转发或异步持有，会提前释放。
- Combined 直接把两个 handler 串成两个独立 pipeline 节点：会暴露额外位置、顺序和移除时机问题，不等价于“逻辑上一个双向节点”。

## 文章结构与预算

1. 为什么 handler 还要分类型（1000-1300 字）
2. Inbound/Outbound/Duplex 的职责边界（1800-2300 字）
3. Adapter 与 `@Skip`：默认转发不是白跑（1700-2200 字）
4. Mask 预计算与跳过传播（2200-2800 字）
5. `@Sharable`、Simple、Combined 三类特殊问题（2200-2800 字）
6. 误解澄清与 Ch7-03/04 桥接（1000-1300 字）

目标：删掉代码后的叙述性正文 9500-11000 字。

## 证据清单

- `ChannelInboundHandler.java:22-75`
- `ChannelOutboundHandler.java:23-99`
- `ChannelDuplexHandler.java:23-128`
- `ChannelInboundHandlerAdapter.java:20-145`
- `ChannelOutboundHandlerAdapter.java:22-127`
- `ChannelHandlerMask.java:35-204`
- `AbstractChannelHandlerContext.java` 中 inbound/outbound 查找与传播相关位置
- `CombinedChannelDuplexHandler.java:220-389`
- `SimpleChannelInboundHandler.java` 当前实现相关位置（待补读后加精确行号）
- `ChannelHandler.java` / `ChannelHandlerAdapter.java` / `DefaultChannelPipeline.checkMultiplicity()` 相关位置（待补读后加精确行号）

## 边界清单

- `@Sharable` 只表示允许实例复用，不表示自动线程安全。
- `@Skip` 只适用于纯转发实现，覆盖后如果加入自定义逻辑就不应再被跳过。
- `read()` 在 outbound 侧表示“请求读”，不是“收到数据”。
- Mask 是按 handler class 缓存的当前实现优化，不外推为所有 pipeline 都必须有的机制。
- Combined handler 的一个 pipeline 位置里可能藏着两套方向不同的委托，上下文语义要按当前实现解释。

## 深审预警

- [ ] 补齐 `@Sharable`、`checkMultiplicity`、`SimpleChannelInboundHandler` 的当前源码证据，修正大纲旧说法。
- [ ] 不把 `@Skip` 写成“JVM 自动跳过”，它是 Netty 自己基于注解和 mask 的优化。
- [ ] 不把 `read()` 的出站含义讲成“读取到数据”。
- [ ] `skipContext` 的线程/executor 边界要按当前实现核对后再写，不能凭旧记忆推断。
- [ ] Combined handler 的 remove/add 顺序如需展开，必须先核对源码。
