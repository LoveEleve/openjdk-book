# 01-string/01 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 目标：把现有“String 字段与不可变事实卡片”重写成一篇删掉代码仍然成立的机制文章。
> 版本边界：JDK 11 `java.base`，重点讨论 Compact Strings；不把 JDK 11 实现外推成所有 JVM 的规范行为。

## 1. 读者困惑

读者真正困惑的不是“String 有哪些字段”，而是：

> `String` 明明只是一个对象，为什么它能安全地做 HashMap key、常量池对象、锁对象和跨线程共享？JDK 9 把 `char[]` 改成 `byte[] + coder` 后，又如何保证这种不可变性没有被性能优化破坏？

具体要解开四个追问：

- `String` 内部究竟存的是字符、字节还是编码后的结果？
- `final byte[]` 为什么还不够保证不可变？
- `substring/concat` 为什么不能原地修改？
- 外部可变数组如何进入 String，又在哪一步被隔离？

## 2. 一句话顿悟

**String 的不可变不是一个 `final` 关键字的结果，而是一条边界设计：外部输入先被复制/解码，内部只保存受控数组；类不能被继承，数组引用不能被替换，所有公开变换都返回新值；Compact Strings 只改变存储编码，不改变这条边界。**

## 3. 旧稿问题

### 保留的优点

- 已正确抓住 JDK 11 的 `byte[] + coder`。
- 已覆盖 `final/private`、substring 复制、包私有构造、StringCoding 解码。
- 已有 `file:line` 锚点和下一篇 equals/hashCode 的自然钩子。

### 必须重写的问题

- 仍然是“字段 → 方法 → 构造”的源码顺序，主问题“为什么能安全共享”不够强。
- `final`、`private`、不修改数组三层保证虽然出现，但没有先推演“只靠 final 会怎样失败”。
- 没有把外部可变输入、内部可信共享、操作返回新对象收成一条边界线。
- Compact Strings 讲成存储优化，但没有回答“为什么压缩不会改变 String 的值语义”。
- 缺少“失败方案推演”：共享外部数组、原地 substring、可变 String 子类、每次都复制所有内部数组分别有什么代价。
- 没有明确区分 JDK 11 当前实现、JDK 8 历史实现与 Java 语言层不可变语义。
- 原正文只有约 143 行，未达到本次重写所需的理解深度；本次不以字数为硬目标，但必须通过删码测试、陌生人测试和反向提纲测试。

## 4. 重写策略

不按 `String.java` 的字段/方法顺序写，而按读者建立“安全共享”心智模型的顺序写：

1. 先从 HashMap key 被修改会发生什么事故开场。
2. 推演最直觉的三个错误方案：可变 String、共享外部数组、原地 substring。
3. 得出 String 必须同时控制类、引用、数组内容和变换 API。
4. 再引出 JDK 11 的 `byte[] + coder`：这是存储层优化，不是语义层变化。
5. 用构造链证明外部数据如何被复制/解码，用 substring/concat 证明内部数据如何只读。
6. 最后收回四个收益：哈希缓存、共享/驻留、线程安全、安全边界，并自然接到 equals/hashCode。

## 5. 理解路径与结构

### 第一节：事故开场——如果 String 能变，哪些东西会先坏

目标：先建立“不可变是基础设施”的危机感，不先列字段。

要回答：

- String 作为 HashMap key 后，如果内容变化，为什么找不回原值？
- 常量池/跨线程共享为什么要求值不能被改？
- 只把 `String` 类声明为 final 是否足够？

准备的失败方案：

- 用可继承类伪装 String：子类可能改变行为。
- 只用 `final byte[]`：数组内容仍可原地修改。
- 对外直接保存调用方传入的 byte[]/char[]：调用方后续修改会污染 String。

预估：先讲清问题，不急着给完整答案。

### 第二节：JDK 11 的 String 到底存什么——压缩存储不改变值语义

目标：回答 `char[]` 为什么变成 `byte[] + coder`，并把优化与不可变分开。

证据：

- `String.java:125`：类 final。
- `String.java:140`：`private final byte[] value`。
- `String.java:153`：`private final byte coder`。
- `String.java:3269-3270`：LATIN1/UTF16 标记。

要讲清：

- Latin-1 可表示内容用单字节，其他内容用 UTF-16 路径。
- `coder` 是内部解释方式，不是业务可见的字符语义。
- 每次访问的分支成本是空间节省的代价。
- 不能把“典型字符串 80% Latin-1”等经验数字当作 JDK 11 源码事实，除非另有实证来源。

### 第三节：不可变的真正边界——类、引用、数组、操作

目标：证明 `final` 只是第一层。

证据：

- `String.java:125`：不能通过继承改变类行为。
- `String.java:140/153`：内部字段 private + final。
- `String.java:1835`：substring 的操作路径。
- `StringLatin1.java:714-716`：`Arrays.copyOfRange` 创建新数组。
- `String.java:1936`：concat 生成新值的入口。

文字总图：

```text
外部输入
  → 复制/解码
  → String 内部受控 byte[] + coder
  → 只读访问
  → substring/concat/replace 返回新 String
```

必须强调：`final` 防止引用替换，不防止数组元素修改；真正的不可变来自“不暴露 + 不原地修改 + 新数组/新对象”。

### 第四节：构造链——外部可变数据如何被隔离

目标：回答 `new String(char[])`、`new String(byte[], Charset)`、包内 byte[] 构造的差异。

证据：

- `String.java:235`：String 拷贝构造可安全共享已有 String 的内部数组。
- `String.java:467/507/592`：byte 输入经过 StringCoding.decode。
- `String.java:3252`：包私有 `String(byte[], byte)` 不复制。
- 对外 char[]/byte[] 构造与内部可信数组要明确区分。

失败方案推演：如果直接保存调用方的 char[]，调用方改数组后 String 内容会变化；因此外部边界必须复制/解码，包内可信路径才允许共享。

### 第五节：操作语义——为什么 substring 不能原地改

目标：从内存与共享角度解释“所有操作返回新值”。

证据：

- `substring(:1835)`：起点为 0 时可直接返回 this；其余路径进入 Latin1/UTF16 新 String。
- `StringLatin1.newString(:714)`：`Arrays.copyOfRange` 复制内容。
- `concat(:1936)`：拼接返回新 String。

版本边界：JDK 7 前 substring 曾共享大数组；JDK 11 不能用旧 offset 共享模型解释当前实现。

失败方案推演：原地修改会破坏所有共享者；旧式共享底层大数组又会让小 substring 持有巨型数组，造成保留内存问题。

### 第六节：收网——不可变为什么值得付出复制与分支成本

目标：把机制收回到读者最初的问题。

四个收益：

- 内容不变，hash 缓存可安全复用。
- 内容不变，常量池/驻留与共享不会被后续调用者改写。
- 内容不变，跨线程读取无需同步。
- 内容不变，类名、路径、协议字段等安全检查输入不会被中途篡改。

必须回收的反直觉点：

- `final` 不等于深不可变。
- `byte[]` 不等于字符语义改变。
- 内部包私有不复制不等于外部 API 可以不复制。
- JDK 11 当前实现不等于 Java 规范规定所有 JVM 都必须用 `byte[] + coder`。

最后自然引出：不可变成立后，String 才能安全进入 Map；下一篇继续讲 equals/hashCode/compareTo 的契约与实现。

## 6. 失败方案清单

正文必须展开至少以下四个方案：

1. String 可继承：子类改变语义，值对象不再可靠。
2. 只有 final 引用：数组元素仍可变。
3. 直接保存外部 char[]/byte[]：外部修改污染内部值。
4. substring 原地修改或永久共享大数组：破坏共享者或造成大数组长期保留。

## 7. 误解清单

1. `final byte[]` 会自动让数组内容不可变——错误。
2. `byte[] + coder` 意味着 String 变成“字节对象”——错误，它只是内部编码存储。
3. 所有 String 构造都复制数组——错误，包内可信构造允许共享。
4. substring 总是复制——错误，`beginIndex == 0` 可直接返回当前对象；其他路径走新数组。
5. `String` 不可变是 Java 规范强制 `byte[] + coder` 的结果——错误，这是 JDK 11 当前实现选择。

## 8. 证据清单

- `java.base/share/classes/java/lang/String.java:125`：String final 类。
- `String.java:140`：value 字段。
- `String.java:153`：coder 字段。
- `String.java:3269-3270`：LATIN1/UTF16 常量。
- `String.java:235`：String 拷贝构造。
- `String.java:467/507/592`：外部 byte 输入解码链。
- `String.java:1835`：substring。
- `StringLatin1.java:714-716`：新数组复制。
- `String.java:1936`：concat。
- `String.java:3252`：内部 byte[] + coder 构造。
- `String.java:156`：hash 缓存字段，作为下篇钩子。

## 9. 版本与边界清单

- 基于 JDK 11 `java.base` 的 `java.lang.String` 实现。
- `byte[] + coder` 是 JEP 254 之后的 JDK 实现细节，不是 Java 语言规范要求。
- 字段压缩与 Latin-1/UTF-16 分支是当前实现结论，不能外推到所有 JVM 或未来 JDK。
- JDK 7 前 substring 的底层数组共享是历史对照，不应混入 JDK 11 当前路径。
- StringCoding 与 Compact Strings 的更深编码细节放在本域第 4 篇，本文只建立构造链心智模型。

## 10. 写作验收标准

- 正文开头先出现“String 作为 Map key 若可变会怎样”的具体困惑。
- 至少有四个失败方案，并逐一说明为什么失败。
- 至少出现一张文字总图。
- 每段源码前先说明它要证明什么。
- 删除代码块后，仍能复述“外部隔离 → 内部受控 → 操作返回新值 → 安全共享”的主线。
- 扫描禁用词：不得出现“此处不再赘述”“不再展开”“显然”“容易看出”“篇幅所限”等偷步表达。
- 不以表格/源码字段顺序作为文章骨架。
