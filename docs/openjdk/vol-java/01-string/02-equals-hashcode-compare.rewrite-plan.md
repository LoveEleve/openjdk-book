# 01-string/02 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `java.base` 的 `String`、`StringLatin1`、`StringUTF16` 实现。
> 目标：把“equals/hashCode/compareTo 方法卡片”重写成一篇解释 String 为什么能作为值、Map key 与排序键的专题文章。

## 1. 读者困惑

读者会背 `==` 与 `equals` 的区别,但真正容易出错的是：

- `equals` 为什么先检查对象身份、类型、coder，再进入内容比较？
- hashCode 为什么可以缓存？为什么乘数偏偏是 31？
- 不同 coder 的两个字符串如何比较？
- compareTo 返回字符差值，为什么不是简单的 -1/0/1？
- equals、hashCode、compareTo、intern 分别服务哪一种容器/运行时场景？

## 2. 一句话顿悟

**String 的比较体系不是四个孤立 API：不可变内容让 hash 可以缓存，coder 分支让比较走专门路径，equals/hashCode 保证哈希容器契约，compareTo 提供排序全序，intern 则把稳定值接入 JVM 字符串池。**

## 3. 旧稿问题

### 保留的优点

- 已经识别 JDK 11 `equals` 先检查 coder,长度检查下沉到 Latin1/UTF16 实现。
- hash 缓存、31、compareTo 差值、intern 这四条证据链基本齐全。
- 有真实代码块与跨篇钩子。

### 必须重写的问题

- 旧稿仍以四个方法为目录,没有先回答“String 为什么能同时做 key、排序键和池对象”。
- `equals/hashCode/compareTo/intern` 之间的契约关系没有先画总图。
- “31 为什么好”容易写成未经证实的性能传说，正文必须区分源码事实、算法性质与经验解释。
- 没有充分推演失败方案：只比较引用、只比较 hash、把 compareTo 当布尔相等、可变内容配合 hash 缓存。
- `intern` 的编译期字面量、运行时 new、池中引用返回需要重新组织，避免只停留在面试结论。
- 需要明确 equals/compareTo 对 String 的一致性，以及这对 TreeMap/TreeSet 的边界意义。

## 4. 重写策略

不按方法出现顺序写,而按“一个值如何成为可靠的容器键”推进：

1. 从 HashMap 找不到 key 与 TreeMap 排序错乱的双重事故开场。
2. 推演只用 `==`、只用 hash、只返回布尔排序结果等朴素失败方案。
3. 建立总图：值相等 → hash 一致 → 排序全序 → intern 共享。
4. 再分别进入 equals 的快速失败路径、hash 的缓存与乘法、compareTo 的 coder 分派与前缀规则、intern 的池化边界。
5. 最后回到第一篇不可变结论，解释所有缓存/共享为什么成立。

## 5. 理解路径与结构

### 第一节：事故开场——一个 key 为什么会“消失”

- HashMap 需要 equals/hashCode 同时稳定。
- TreeMap 需要 compareTo 的全序与一致性。
- 只用 `==`、只比 hash、把 compareTo 当布尔值，各自为什么失败。
- 总图：

```text
String 内容稳定
   ├─ equals → 值相等
   ├─ hashCode → 哈希桶定位
   ├─ compareTo → 有序容器排序
   └─ intern → JVM 池中共享引用
```

### 第二节：equals——先拒绝不可能，再比较内容

证据：

- `String.java:1002-1011`：身份、类型、coder 分派。
- `StringLatin1.java:93`：长度检查与逐字节比较。
- `StringUTF16.java:269`：UTF-16 路径。

必须澄清：JDK 11 String 的显式 equals 主体不直接写长度检查；长度检查在专门编码路径中完成。说明 coder 不同的字符串不可能值相等。

### 第三节：hashCode——缓存为什么依赖不可变

证据：

- `String.java:1501`：缓存读取与首次计算。
- `String.java:156`：`hash` 字段默认 0。
- `StringLatin1/StringUTF16` hash 实现。

要区分：

- hash 相同不代表 equals 相同。
- 空字符串 hash=0 不必缓存。
- hash 恰好为 0 的非空字符串可能重复计算。
- 31 的源码事实是递推式；移位优化/分布解释必须标为算法分析，不冒充 JDK 注释结论。

### 第四节：compareTo——全序而不是相等判断

证据：

- `String.java:1194`：coder 分派与跨 coder 比较。
- `StringLatin1.java` / `StringUTF16.java` compareTo：逐字符/逐单元比较与前缀长度差。
- `equalsIgnoreCase:1143`、`compareToIgnoreCase:1257` 作为边界对照。

要讲清：

- 返回差值而非 -1/0/1 是合法 Comparable 约定。
- 前缀相同时长度差决定顺序。
- equals 为 true 时 compareTo 必为 0，但反向不应泛化到所有类型。

### 第五节：intern——值相等如何变成引用共享

证据：

- `String.java:3127` native intern。
- 字面量、运行时 new、池中已有/不存在三条路径。

失败方案：

- 用 `==` 代替 equals：只比较对象身份。
- 滥用 intern：把大量动态值推入池/堆，可能造成内存压力。

### 第六节：收网——四个 API 如何协作

收束四句：

- equals 回答“值是否相同”。
- hashCode 回答“去哪个哈希桶”。
- compareTo 回答“排序时谁在前”。
- intern 回答“是否复用池中的同值对象”。

回到第一篇：这些能力都建立在 String 内容不可变之上；自然钩到第三篇字符串构建与拼接。

## 6. 失败方案清单

1. 用 `==` 判断内容相等：同值不同对象失败。
2. 只比较 hash：哈希冲突会误判。
3. compareTo 只返回 -1/0/1：虽然可能满足符号语义，但丢失实现提供的差值信息，且不能代替 equals。
4. String 可变却缓存 hash：内容变化后 hash 与 key 定位脱节。
5. 所有动态字符串都 intern：池/堆压力不可控。

## 7. 误解清单

1. coder 不同就一定无法比较——错误，equals 不相等但 compareTo 有跨 coder 路径。
2. hash 相同就 equals——错误，哈希允许冲突。
3. compareTo 返回值只能是 -1/0/1——错误，Comparable 只要求负/零/正语义。
4. hash=0 表示没有计算过——对空串与 hash 恰好为 0 的字符串要分别看。
5. intern 会让所有 new String 变成同一个对象——错误，只有调用 intern 的返回值才是池引用。

## 8. 证据清单

- `String.java:1002`：equals 主体。
- `StringLatin1.java:93`：Latin1 equals。
- `StringUTF16.java:269`：UTF16 equals。
- `String.java:1501/156`：hash 缓存。
- `StringUTF16.java:346`：hash 递推。
- `String.java:1194`：compareTo 分派。
- `String.java:1143/1257`：忽略大小写对照。
- `String.java:3127`：intern native 门。

## 9. 版本与边界清单

- 基于 JDK 11 Compact Strings 实现。
- coder 分派、Latin1/UTF16 专门实现是当前 JDK 实现细节。
- 31 的性能/分布解释属于算法分析，不写成 JDK 规范保证。
- intern 的池实现属于 JVM/运行时层，Java 层只展示 native 入口。
- equals/hashCode/compareTo 的具体优化不能外推到所有 JVM 或未来 JDK。

## 10. 写作验收标准

- 开头先出现“HashMap key 消失/TreeMap 顺序异常”的具体困惑。
- 至少展开四个失败方案。
- 先给总图，再让源码分别证明四个 API 的职责。
- 解释 coder 分派、hash 缓存、31、差值排序、intern 引用返回。
- 删除代码后，仍能复述四 API 协作主线。
- 禁用词扫描全绿，所有 `file:line` 重新核验。
