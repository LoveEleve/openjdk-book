## 全视角提问：JFR (域32) | 10问
| # | 子主题 | 问题 | 覆盖 |
|:--:|------|------|:--:|
| 1 | buffer | 为什么 per-thread buffer 消除全局锁？ | ✅ 篇1 |
| 2 | chunk rotation | .jfr 文件为什么分 chunk？边录边读怎么实现？ | ✅ 篇1 |
| 3 | metadata | 130 种 event type 怎么定义？XML→C++ 生成流程？ | ✅ 篇2 |
| 4 | AsyncGetCallTrace | 安全点外栈采样——部分 trace 不一致怎么处理？ | ✅ 篇3 |
| 5 | LEB128 | JFR 变小值的平均压缩比？ | ✅ 篇4 |
| 6 | OldObjectSample | N 次采样一个 old object——采样率怎么控制？ | ✅ 篇5 |
| 7 | JNI | JFR.start() 从 Java 到 C++ 经过哪些调用？ | ✅ 篇6 |
| 8 | ASM | 哪些类被 JFR bytecode inject？大部分类可以避开吗？ | ✅ 篇6 |
| 9 | DCmd | jcmd JFR.dump 的命令解析流程？ | ✅ 篇6 |
| 10 | stack trace dedup | 怎么通过 hash table 去重复栈？ | ✅ 篇3 |
