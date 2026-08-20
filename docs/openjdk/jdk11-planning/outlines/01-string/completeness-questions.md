# 域 01: 字符串体系 — 完整性验证

> 全视角身份检查(≥5 身份): 场景/源码/设计/跨层/悬念 五维验证

## 身份 1: 面试官
- [x] "String 为什么不可变" — 01 篇 §2(final+不暴露+不修改,对应代码 String.java:44/140)
- [x] "equals vs ==" — 02 篇 §1(实现顺序:String.java:1002)
- [x] "hashCode 为什么 31" — 02 篇 §2(String.java:1501)
- [x] "new String("a") 创建几个对象 / intern" — 02 篇 §4(String.java:3127)
- [x] "StringBuilder/StringBuffer 区别 + 扩容" — 03 篇 §1-2(AbstractStringBuilder.java:200)
- [x] "String a+b+c 编译成什么" — 03 篇 §3(JEP 280, StringConcatFactory)
- [x] "JDK9 String 内存优化" — 01 篇 §1 / 04 篇 §2(JEP 254, coder)
- [x] "emoji 占几个 char / 字符串截断" — 04 篇 §3(codePointAt, Character.java:8267)

## 身份 2: 生产工程师
- [x] 乱码排查(getBytes/new String 编码链路) — 04 篇 §1(StringCoding.java:416)
- [x] 循环拼接性能(StringBuilder 预分配 ensureCapacity) — 03 篇 §1
- [x] 大量重复字符串内存(intern 权衡) — 02 篇 §4
- [x] emoji 截断 bug — 04 篇 §3

## 身份 3: 框架工程师(Spring/Netty/Dubbo)
- [x] 字符串作 Map key 的语义基础 — 02 篇 §1-2
- [x] 拼接/格式化在框架字符串处理中的成本 — 03 篇 §3

## 身份 4: 源码方法论文审查
- [x] 每个 section 有"场景:"句
- [x] 源码锚全部 file:line + 函数名(已 grep 验证: String.java:140/156/1002/1194/1501/3127/3269, AbstractStringBuilder.java:84/155/168/197/200, StringBuffer.java:120/203, StringCoding.java:416/615, StringUTF16.java:159/346, Character.java:8177/8219/8267)
- [x] 关键设计(斜体)每节存在
- [x] 跨层标注 [C++:/内部卷:/JVM Spec:/JEP]
- [x] 每篇结尾核心悬念 + OUTBOUND 桥
- [x] 无文字描述源锚(所有 (file:line) 均带数字)

## 身份 5: 完整性缺口检查
- [x] 存储(01)/语义(02)/构建(03)/编码(04) 四篇覆盖 String 全部面试主战场
- [x] Character/CharacterData 已覆盖(04 §4)
- [x] StringJoiner/join 已覆盖(03 §4)
- [x] 未覆盖项确认: String.format(委托 Formatter,域 24 文本格式化)✓ 已标注跨域
- [x] 未覆盖项确认: split 正则实现(域 25 正则已裁剪,标注: split 在 02 篇不展开,使用层了解)
- [ ] 待办: 大纲中 StringLatin1.equals 行号(392 附近)需在写作阶段精确定位(大纲标注"附近"的锚点写作时修正)
