# 为什么 `String.substring()` 后来不再共享底层数组？

> 适用：Java 技术专家 / 高级工程师面试
> 关联正文：`40-java-lang/06-string-intern-family`
> 版本边界：下文引用的 `String.java`、`StringLatin1.java`、`StringUTF16.java` 行号均为 JDK 11 源码；`substring` 早期版本曾共享底层数组，JDK 11 已改为复制。

## 题目

为什么很多老资料都说 `substring()` 只是“视图切片”，但现在的 JDK 里却要复制新数组？这不是把性能做差了吗？

## 常见答法

> 因为以前共享底层数组会导致内存泄漏，所以后来改成复制。

这个答法方向对，但太快了。**真正的问题不是“共享就一定泄漏”，而是“一个很小的子串可能把一个很大的原始字符串整块留住”。** 这会让对象生命周期严重失真：业务上你以为只留下了 10 个字符，实际上 JVM 还得连着保住背后的整块数组。

## 追问一：JDK 11 的 `substring()` 现在到底怎么做？

> 答：不是共享底层 `value`，而是重新构造一个新 `String`，内部复制需要的那一段字节。

`String.substring(int beginIndex)`（`String.java:1835-1847`）和 `substring(int beginIndex, int endIndex)`（`:1872-1880`）在不是整串返回 `this` 的情况下，都会走 `StringLatin1.newString(...)` 或 `StringUTF16.newString(...)`。

这两个辅助方法并不是做“偏移视图”。例如 `StringLatin1.newString(...)`（`StringLatin1.java:714-715`）直接 `Arrays.copyOfRange(...)`；`StringUTF16.newString(...)`（`StringUTF16.java:1017-1025`）同样会 `Arrays.copyOfRange(...)`。也就是说，**子串现在拿到的是一份新的底层字节数组。**

## 追问二：为什么当初的共享设计会出问题？

> 答：因为小子串会无意间延长大数组的生命周期。

假设你从一个 10MB 的日志字符串里 `substring(0, 20)` 拿出一个小字段，如果子串只是共享原数组，那么这 20 个字符背后仍然引用着整块 10MB 存储。只要这个小子串还活着，大数组就不能回收。

这不是经典意义上“对象永远不可回收”的泄漏，更准确说是：**一个微小结果把一个巨型源对象错误地一起保活了。** 在缓存、解析、切字段这类场景里，这种生命周期失真会比那点复制成本更危险。

## 追问三：那复制不是更慢吗？为什么还值得？

> 答：是更贵一点，但它换来了更合理的对象生命周期和更稳定的内存占用。

共享切片的优势是省一次复制；复制切片的优势是子串大小和内存占用重新对齐。JDK 后来的取舍是：**宁可让 `substring()` 为结果真正付出一份对应大小的存储，也不要让一个很小的返回值偷偷绑住一个很大的源数组。**

所以这不是简单的“时间换空间”口号，而是 API 语义的修正：`substring()` 返回的是一个独立字符串值，不该在对象生命周期上暗中依赖原串的整块存储。

## 源码证据

- `String.value`（`String.java:140`）：JDK 11 底层是 `byte[]`
- `substring(int)`（`String.java:1835-1847`）：非整串时走 `StringLatin1.newString(...)` / `StringUTF16.newString(...)`
- `substring(int, int)`（`String.java:1872-1880`）：同样走新字符串构造路径
- `StringLatin1.newString(...)`（`StringLatin1.java:714-715`）：直接 `Arrays.copyOfRange(...)`
- `StringUTF16.newString(...)`（`StringUTF16.java:1017-1025`）：同样复制需要区间

## 一句话顿悟

**`substring()` 不再共享底层数组，不是因为“复制更快”，而是因为“值只剩一点点，内存却还绑着整块源数据”这个语义太危险。** 面试官真正想听的不是你会背"以前会内存泄漏"，而是你知道 JDK 后来的取舍是在修正对象生命周期，而不只是做一次性能权衡。