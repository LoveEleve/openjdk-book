# 01-string/04 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `java.base`；StringCoding、Compact Strings、UTF-16 代理对和 Character 数据表。
> 目标：把“乱码/编码/API 事实卡片”重写成一条从字节边界到 Unicode 语义的完整诊断链。

## 1. 读者困惑

线上看到乱码时，真正的问题通常不是“String 会不会中文”，而是：

- UTF-8 字节为什么用 GBK 解出来会变成替代字符或错误文字？
- `new String(bytes)` 的默认 charset 到底从哪里来？
- JDK 11 的 `byte[] + coder` 与外部 UTF-8/GBK 字节是什么关系？
- Java 的 `length/charAt` 为什么把一个 emoji 看成两个位置？
- `Character.isDigit` 为什么不能用 ASCII 范围判断替代？

## 2. 一句话顿悟

**乱码发生在“字节 → 字符”的解码边界；JDK 11 先由 StringCoding 按 charset 解码，再把结果压缩为 Latin1 或保留 UTF16，之后 String API 还要区分 UTF-16 编码单元与 Unicode 码点。**

## 3. 旧稿问题

- 旧稿源码证据丰富，但仍按 StringCoding/双路径/codePoint/CharacterData 四块平铺。
- “UTF-8 存、GBK 读”的事故没有作为主线贯穿到最后。
- 快路径、ThreadLocal decoder、替代字符、Compact Strings 的关系没有形成一个诊断闭环。
- 代理对部分讲概念，缺少“length/charAt 与 codePoint API 的失败对照”。
- CharacterData 生成表的实现边界和“查表不是算法”需要更明确区分。
- 旧稿收尾跳到域 06，当前重写应优先完成本域的认知闭环，不把后续路线当作主线。

## 4. 重写策略

按一次乱码排查的理解路径组织：

1. 用错误 charset 解码制造事故，先定义“字节本身没有文字，charset 才赋予解释”。
2. 从 StringCoding 入口看 charset 名称/对象/默认值如何进入 decoder。
3. 解释快路径与通用 CharsetDecoder，以及错误输入为何变成 U+FFFD。
4. 解释解码结果如何进入 Compact Strings 的 LATIN1/UTF16 双路径。
5. 再从“中文/emoji 显示不对”转入 UTF-16 编码单元与码点。
6. 最后解释 CharacterData 的 Unicode 分类查表，收网为诊断流程。

## 5. 理解路径与结构

### 第一节：事故开场——同一组字节为什么在不同机器显示不同

- UTF-8 字节用 GBK 解码的失败示意。
- 默认 charset 让环境差异进入业务结果。
- 失败方案：把字节当字符、依赖默认 charset、只看终端字体。
- 顿悟：必须记录编码协议，并在字节/字符边界显式指定 charset。

### 第二节：StringCoding——解码入口与三种 charset 路径

证据：
- `String.java:461/502/592` 构造入口。
- `StringCoding.decode(:225-253)` 按 charsetName 分派。
- UTF-8/Latin1/ASCII 快路径与通用 StringDecoder。
- ThreadLocal SoftReference decoder 复用但不把 decoder 状态当业务共享状态。

### 第三节：解码失败——替代字符从哪里来

- CharsetDecoder 的 malformed/unmappable 输入。
- `CodingErrorAction.REPLACE` 与 U+FFFD。
- 失败方案：默认替换后继续存储，错误已经不可逆；生产要在边界选择 REPORT/REPLACE 策略。

### 第四节：解码结果——coder 如何选择内部存储

- 解码后的字符内容若全能 Latin1 表示，压缩成单字节；否则 UTF16。
- StringUTF16.compress 与 `byte[] + coder` 的关系。
- 重要边界：外部 UTF-8 的字节长度不等于 String 内部 value 长度。

### 第五节：字符与码点——emoji 为什么 length 是 2

- UTF-16 surrogate pair。
- `length/charAt` 是 code unit 视角。
- `codePointAt/charCount/codePointCount` 是 code point 视角。
- 失败方案：按 char 截断导致孤立代理、显示异常。

### 第六节：CharacterData——分类为什么查表

- `CharacterData.of` 按码点区间选择数据表。
- Unicode General Category 驱动 isLetter/isDigit/isWhitespace。
- 生成类/数据表是构建产物，不能把生成源码当手写算法。
- 失败方案：`ch >= '0' && ch <= '9'` 只能覆盖 ASCII。

### 第七节：收网——乱码诊断四步

1. 确定来源字节与协议 charset。
2. 禁止隐式默认 charset。
3. 检查 decoder 错误策略，避免 U+FFFD 掩盖坏数据。
4. 区分 byte length、char length、code point count。

## 6. 失败方案清单

1. 使用默认 charset 读取外部文件/网络协议。
2. 用错误 charset 解码后继续传播替代字符。
3. 把 UTF-8 字节长度当成 Java String 长度。
4. 用 `charAt`/substring 按 char 截断 emoji。
5. 用 ASCII 范围替代 Unicode Character 分类。

## 7. 误解清单

1. UTF-8 是 String 的内部存储格式——错误，UTF-8 是外部编码，String 内部是 JDK 实现的 Latin1/UTF16 表示。
2. `new String(bytes)` 跨平台稳定——错误，它依赖默认 charset。
3. 出现 U+FFFD 说明 JVM 随机改了字符——错误，它通常来自 decoder 的 REPLACE 策略。
4. `length()` 返回 Unicode 字符数——错误，它返回 UTF-16 code unit 数。
5. `isDigit` 只认 ASCII 0-9——错误，它依据 Unicode 分类数据。

## 8. 证据清单

- `String.java:461/502/592`：字节构造解码入口。
- `StringCoding.java:225-253`：charset 分派与快路径。
- `StringCoding.java:66-68/164-165`：decoder 缓存与错误策略。
- `StringCoding.java:181-210`：通用 decoder 与 coder 选择。
- `String.java:3269-3270`：LATIN1/UTF16 标志。
- `Character.java:8177/8219/8267`：代理/码点 API。
- `CharacterData.java:79-91/29`：分类表分派。

## 9. 版本与边界

- 基于 JDK 11 `java.base`，重点是 Compact Strings 实现。
- UTF-8/GBK 等外部 charset 行为由 Charset/CharsetDecoder 决定。
- CharacterData 子类可能是构建生成产物，不能把生成数据表等同手写 Java 算法。
- 具体默认 charset 取决于启动环境；生产不可依赖默认值。

## 10. 验收标准

- 开头有真实乱码事故，不以字段列表开场。
- 至少展开五个失败方案。
- 必须出现“字节 → charset decoder → 字符语义 → 内部 coder”的总图。
- 必须解释 U+FFFD、Compact Strings、代理对、Unicode 分类表。
- 删除代码后，读者仍能复述乱码诊断四步。
- 禁用词扫描、锚点核验与跨篇链接检查全绿。
