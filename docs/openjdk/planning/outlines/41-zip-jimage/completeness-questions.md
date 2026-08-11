# 域 41 ZIP & JIMAGE — 全视角提问验证

> 5 身份 | 12 问 | 验证大纲是否覆盖读者真实问题

## 1. Java 应用开发者 (3问)

1. `ClassLoader.getResourceAsStream("foo.properties")` — 从 `app.jar` 中读取一个 properties 文件，底层 ZIP_Open 打开文件后怎么定位 `foo.properties` 这个 entry？
2. JAR 文件中的 class 是压缩存储的(DEFLATED)还是未压缩(STORED)？ZIP_ReadEntry 怎么知道用哪种方式解压？
3. `java --module-path myapp.jar` — 启动时 .jimage 文件在哪里？和 JAR 文件是什么关系？为什么还需要 .jimage？

## 2. JVM 性能工程师 (3问)

4. ZIP_GetEntry 的 O(1) hash lookup 和 ZIP_FindEntry 的 O(n) CEN 扫描——什么情况下会走慢路径？hash 冲突率多高？
5. JIMAGE 的 Minimal Perfect Hashing 声称"无碰撞"——如果两条不同路径字符串意外 hash 到同一位置，会发生什么？
6. ZIP 的 mmap(CEN+ENDHDR) vs JIMAGE 的 mmap(整个文件) — 为什么 JIMAGE 敢 mmap 整个文件而 ZIP 只 mmap 索引部分？两种策略的 trade-off 是什么？

## 3. JDK 工具开发者 (2问)

7. 如果我要写一个工具直接读取 .jimage 文件(不用 jrt: 文件系统)，需要调用哪些 JIMAGE API？ImageFileReader 的 C++ 类是公开可用的吗？
8. ZIP_GetEntry 的 hash table 大小是 total/2 强制奇数(`zip_util.c:694`)——为什么减半而不是加倍？odd-sized 表如何减少碰撞？

## 4. 安全研究者 (2问)

9. ZIP bomb 攻击——一个 10KB 的 zip 文件解压后变成 10GB。ZIP_ReadEntry 有什么防御？inflate 时有大小限制吗？
10. JIMAGE 的 magic `0xCAFEDADA` 验证——如果我构造一个 magic 正确的恶意 .jimage 文件，后续的 Redirect Table 索引会导致什么？ImageFileReader::open 有额外的安全验证吗？

## 5. 框架开发者 (2问)

11. 我写了一个自定义 ClassLoader 从加密的 JAR 中加载 class——我需要绕过 ZIP_GetEntry 直接读字节流。可以重用 ZIP_Open 的 CEN 解析但自己实现 ReadEntry 吗？
12. JDK 9+ 引入模块系统后—class loading 的数据源从 ZIP(JAR) 扩展到 JIMAGE(.jimage)—自定义 ClassLoader 能读写 .jimage 吗？
