# Ch4-04 视图与零拷贝 — rewrite-plan

## 篇章定位

- 核心困惑：`slice/duplicate` 不复制数据，却让调用者拥有独立索引；如果 parent 被释放，派生视图还能不能用？`retained*` 与普通视图究竟差在哪里？
- 一句话顿悟：Netty 把“数据是否复制”和“生命周期是否续期”拆成两个独立选择；普通派生视图只共享存储并委托 parent 的 refCnt，retained 变体额外 retain，调用者必须显式承担这份 ownership。
- 篇章边界：重点讲 derived buffer、slice/duplicate/readSlice/retained*、索引调整、引用计数委托和悬空边界；ReadOnly/Unreleasable/Swapped 只讲必要包装语义，Composite 留 Ch4-05。

## 依赖

### HARD

- Ch4-01：双指针、refCnt、retain/release、ensureAccessible。
- Ch4-03：Heap/Direct 存储都能被视图复用；array/address 差异。
- Ch1 ByteBuffer view：slice/duplicate 共享存储但 position/limit 独立的基础对照。

### SOFT

- Ch4-02：allocator 创建派生 buffer 的路径。
- ByteBuf decorator/ownership：正文给最小解释。

### NAV

- Ch4-05：CompositeByteBuf 的多组件共享、释放和 consolidate。
- Ch8：池化派生 buffer 的具体实现。
- Ch5/Ch7：EventLoop/Pipeline 中 retained slice 的典型消费场景。

## 素材事实卡片

### 卡片 A：派生与 copy 的接口语义

- `ByteBuf.java:195-221`：derived buffer 共享内部数据表示，readerIndex/writerIndex/markers 独立；copy 才是独立副本；non-retained 方法不调用 retain，retained 方法增加引用计数。
- `AbstractByteBuf.java:1200-1233`：duplicate/slice/retainedDuplicate/retainedSlice 的入口实现。
- `AbstractByteBuf.java:885-897`：readSlice/readRetainedSlice 先检查 readable，再创建视图并推进 parent readerIndex。
- 普通 slice/duplicate 与 copy 的关键差异：共享存储 vs 复制内容。

### 卡片 B：派生访问和 adjustment

- `AbstractUnpooledSlicedByteBuf.java:32-53`：保存底层 buffer 与 adjustment；嵌套 slice 累加 adjustment 并扁平化 parent。
- `AbstractUnpooledSlicedByteBuf.java:217-235`：duplicate 通过全容量 slice 并恢复索引；slice 使用加过 adjustment 的 parent 索引。
- `AbstractUnpooledSlicedByteBuf.java:473-480`：`idx(index)=index+adjustment` 与边界检查。
- `UnpooledSlicedByteBuf.java:27-40`、`:82-85`：slice capacity 固定，读写委托 `unwrap()._get/_set(idx)`。
- `UnpooledDuplicatedByteBuf.java:28-35`：duplicate 共享 parent 索引空间但派生对象有独立 reader/writer index。
- 说明“底层相同、索引不同”而不是“slice 只保存两个 int”；派生对象仍有包装和生命周期语义成本。

### 卡片 C：引用计数全委托与 retained

- `AbstractDerivedByteBuf.java:34-49`：isAccessible/refCnt 委托 unwrap。
- `AbstractDerivedByteBuf.java:52-108`：retain/release/touch 委托 unwrap，派生对象无独立 refCnt。
- `AbstractByteBuf.java:1211-1233`：retained 变体实现为普通派生视图再 retain。
- 共享 parent refCnt 的结论：普通视图不会自动延长 parent 生命周期；释放 parent 会使视图不可访问；retained 视图会多持有一份 parent 引用，必须对应 release。
- 不把“slice.release() 释放 parent”写成无条件事实：release 委托 parent，但是否归零取决于 parent 当前 refCnt。

### 卡片 D：readSlice 与 readRetainedSlice

- `AbstractByteBuf.java:885-897`：两者都推进 parent readerIndex；差别在调用 slice 还是 retainedSlice。
- 普通 readSlice 适合视图只在 parent 当前 ownership 范围内消费；readRetainedSlice 适合把窗口交给生命周期可能独立的异步使用者。
- 不把 retained 自动变成线程安全或自动释放；仍需 release。

### 卡片 E：特殊包装

- `UnreleasableByteBuf.java:22-26`：包装目标，阻止用户改变 refCnt。
- `UnreleasableByteBuf.java:52-101`：普通/retained slice/duplicate 的特殊转发，retained 变体逻辑等价地返回普通视图。
- 可在正文误解段落简述 ReadOnly 与 Swapped 的“包装改变能力，不改变底层共享”原则；不展开它们所有方法。

## 理解路径

1. **从 copy 与 view 的选择切入**：同一份消息需要多个 handler 看不同区间，复制安全但成本高，view 便宜但共享风险高。
2. **建立两条轴**：共享数据表示 ≠ 共享生命周期；slice/duplicate 与 retained* 在两条轴上的组合不同。
3. **讲 slice 的本地窗口**：adjustment 把本地 index 翻译到 parent，独立 reader/writer index，固定 capacity，读写仍修改共享底层内容。
4. **讲 duplicate 的全量窗口**：全容量共享，索引状态独立；它不是 copy，也不是 parent 的索引别名。
5. **讲 readSlice/readRetainedSlice**：除了创建窗口，还推进 parent readerIndex；这是流式解析中最容易被忽略的副作用。
6. **讲 refCnt 委托**：派生对象的 refCnt/isAccessible/retain/release 都落到 unwrap；普通视图可能悬空，retained 变体显式延长寿命。
7. **补充特殊包装**：ReadOnly/Unreleasable/Swapped 都是不同维度的 decorator，不能把“共享底层”误认为“所有行为相同”。
8. **收网**：零拷贝不是免费安全，它把复制成本换成索引、ownership 和释放纪律。

## 失败方案推演

- 每次 handler 交接都 copy：生命周期简单但 CPU/内存带宽和延迟上升。
- slice 自动 retain：安全直觉更强，但每个短期视图都增加 parent 引用，释放配对变复杂；Netty 让 retained 变体显式表达 ownership。
- parent release 后继续使用普通 slice：派生对象仍有 Java 引用不等于底层资源仍活着。
- 用 duplicate 代替 slice：窗口没有收窄，可能让消费者读到不该看的区域。
- 用 slice 代替 readSlice：没有推进 parent readerIndex，解析循环可能反复处理同一段数据。
- 把 readRetainedSlice 当作“交给异步线程后自动管理”：retain 只延长引用，仍需接收者 release。

## 文章结构与预算

1. 零拷贝真正省掉了什么（1000-1300 字）
2. 两条轴：共享存储与共享寿命（1700-2200 字）
3. slice：窗口、adjustment、固定 capacity（1800-2300 字）
4. duplicate 与 readSlice：全量视图和消费推进（1600-2100 字）
5. retained 变体：把生命周期延长显式化（2000-2500 字）
6. 悬空、ReadOnly、Unreleasable、Swapped 边界（1500-1900 字）
7. 误解澄清与 Composite 桥接（1000-1300 字）

目标：删掉代码后的叙述性正文 9000-10500 字。

## 证据清单

- `ByteBuf.java:195-221`
- `AbstractByteBuf.java:885-897`
- `AbstractByteBuf.java:1200-1233`
- `AbstractDerivedByteBuf.java:34-49`
- `AbstractDerivedByteBuf.java:52-108`
- `AbstractUnpooledSlicedByteBuf.java:32-53`
- `AbstractUnpooledSlicedByteBuf.java:217-235`
- `AbstractUnpooledSlicedByteBuf.java:473-480`
- `UnpooledSlicedByteBuf.java:27-40`
- `UnpooledSlicedByteBuf.java:82-85`
- `UnpooledDuplicatedByteBuf.java:28-35`
- `UnreleasableByteBuf.java:22-26`
- `UnreleasableByteBuf.java:52-101`

## 边界清单

- 基于当前 Netty 源码；`AbstractDerivedByteBuf`/`DuplicatedByteBuf` 等部分内部基类标记 deprecated，正文以公开 ByteBuf 派生语义为主。
- slice/duplicate 共享底层数据，但不共享 readerIndex/writerIndex/marker；不把“共享数据”写成“共享所有状态”。
- 普通派生方法不增加 refCnt；retained 方法增加 parent ownership；release 委托是否归零取决于当前计数。
- 零拷贝视图不等于线程安全、不等于生命周期安全、不等于不可修改。
- slice capacity 固定为窗口长度；duplicate 视图覆盖 parent capacity，但索引独立。
- ReadOnly/Unreleasable/Swapped 只作为包装边界简述；Composite 的组件 ownership 留后续。

## 深审预警

- [ ] 明确普通 slice/duplicate 的 parent release 会使视图不可访问，不写成 JVM 对象自动消失。
- [ ] 明确 retained 变体的 release 配对责任。
- [ ] 明确 readSlice 推进 parent readerIndex，readRetainedSlice 也推进。
- [ ] 不把 adjustment 写成所有派生实现的统一字段，只限定当前 unpooled sliced implementation。
- [ ] 不把 AbstractDerived 的 deprecated 内部结构当成稳定公开 API。
- [ ] 代码块前说明它证明什么；删码后主线完整。
