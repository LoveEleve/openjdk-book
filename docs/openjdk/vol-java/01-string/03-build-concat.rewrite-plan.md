# 01-string/03 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `java.base`；字符串拼接涉及 JEP 280 与 invokedynamic。
> 目标：解释可变构建器、线程安全构建器、编译期/运行期拼接为何采用不同策略。

## 1. 读者困惑

- 循环 append 为什么不会每次都重新分配？
- `StringBuilder` 默认容量与扩容公式到底是什么？
- `StringBuffer` 的慢是锁慢、复制慢，还是缓存策略不同？
- JDK 11 的 `a + b + c` 为什么不能继续用 JDK 8 的 StringBuilder 答案？
- `StringJoiner` 解决了什么实际错误？

## 2. 一句话顿悟

**构建器把不可变 String 暂时变成可变缓冲区：扩容负责摊平复制成本，StringBuffer 用锁保护共享缓冲，JDK 9+ 则把 `+` 拼接策略推迟到 invokedynamic，让运行时按类型和布局选择实现。**

## 3. 旧稿问题

- 旧稿源码证据充分，但仍按 AbstractStringBuilder → StringBuffer → JEP 280 的资料顺序推进。
- 没有从“循环构建为什么不能每次 new String”事故开场。
- 扩容的几何级数、coder 膨胀、toString 复制之间缺少一条成本主线。
- StringBuffer 的同步与缓存虽然详细，但缺少“共享可变缓冲为什么必须加锁”的失败方案。
- JEP 280 部分需要明确区分：编译期常量折叠、运行期 invokedynamic、显式 StringBuilder 三种路径。
- 需要明确 JDK 11 当前实现、JDK 8 历史字节码和 JEP 280 设计目标的边界。

## 4. 理解路径

### 第一节：事故开场——循环拼接为什么会制造两种浪费

- 每次 `+` 都创建新 String 的失败成本。
- 每次 append 都固定增长的失败成本。
- 得出“需要可变缓冲区 + 指数扩容 + 最后一次性冻结”的顿悟。

### 第二节：AbstractStringBuilder——可变缓冲区如何装下 String

证据：
- 字段 `value/coder/count`。
- 默认容量 16。
- `append(String)` 的“保证容量 → 写数据 → 更新 count”。
- coder 不一致时整体 inflate。

### 第三节：扩容——为什么是 ×2 + 2

证据：
- `ensureCapacityInternal`、`newCapacity`、`MAX_ARRAY_SIZE`、`hugeCapacity`。
- 失败方案：固定增量导致 O(n²)。
- 预分配与 trim 的生产选择。

### 第四节：StringBuilder/StringBuffer——可变性如何与并发冲突

- Builder：无同步，适合线程封闭。
- Buffer：方法级 synchronized，适合共享但锁粒度粗。
- toString：Builder 必须复制；Buffer 可缓存不可变快照并复用内部数组。
- 失败方案：共享可变缓冲不加锁、toString 直接共享可变数组。

### 第五节：JEP 280——`+` 拼接不再等于 StringBuilder

- 编译期常量直接折叠。
- 运行期表达式生成 invokedynamic。
- StringConcatFactory/Helper 在运行时决定拼接布局。
- 失败方案：固定编译成 StringBuilder 导致策略被锁死、扩容与复制不可优化。

### 第六节：StringJoiner 与收网

- 分隔符、前缀、后缀与空值策略。
- 回收三条构建路径：手写 Builder、共享 Buffer、编译器 indy。
- 下一篇进入编码与 Unicode，解释 coder 如何从输入字节产生。

## 5. 失败方案清单

1. 循环中每次 `new String`：大量临时对象与复制。
2. 缓冲区固定增量扩容：整体复制成本趋向 O(n²)。
3. 共享 StringBuilder 不加锁：count/value 更新竞态。
4. `toString` 直接共享可变数组：后续 append 会污染已返回 String。
5. 所有 `+` 固定编译成 StringBuilder：运行时无法针对类型/编码布局优化。

## 6. 误解清单

1. StringBuilder 默认容量是 0——JDK 11 默认 16。
2. 扩容永远严格两倍——实际是 `(oldCapacity << 1) + 2`，还受 minimum/溢出边界影响。
3. StringBuffer 只是“加了一个 synchronized”——还涉及 toStringCache 失效与快照复用。
4. JDK 11 的所有 `+` 都走 invokedynamic——编译期常量仍可直接折叠。
5. `toString` 总是复制全部内容——StringBuffer 的缓存路径可共享不可变快照。

## 7. 证据清单

- `AbstractStringBuilder.java:56/60-70`：缓冲字段。
- `AbstractStringBuilder.java:84-92`：容量初始化。
- `AbstractStringBuilder.java:168-175`：扩容入口。
- `AbstractStringBuilder.java:197-218`：×2+2 与边界。
- `StringBuilder.java:102-104`：默认容量。
- `StringBuffer.java:120/313/715`：缓存、同步 append、toString。
- `StringConcatHelper.java:97`：拼接辅助逻辑。
- `StringJoiner.java:198`：分隔符添加。

## 8. 版本与边界

- JDK 11 `StringBuilder/StringBuffer` 继承 AbstractStringBuilder。
- JDK 8 的 StringBuilder 字节码结论不能直接外推到 JDK 11。
- JEP 280 讲的是编译器/运行时拼接策略，不等于所有字符串 API 都使用同一实现。
- Compact Strings 的 coder 膨胀与拼接策略属于 JDK 当前实现细节。

## 9. 验收标准

- 开头先讲循环拼接/扩容事故，再引出构建器。
- 至少展开 5 个失败方案。
- 先给构建路径总图，再上源码。
- 每段代码前说明证明目标。
- 删除代码后仍能复述“可变缓冲 → 指数扩容 → 冻结 String / indy 拼接”的主线。
- 禁用词扫描与 `file:line` 全量核验通过。
