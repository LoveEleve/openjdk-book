# 域 37 Heap Dumper — 全视角提问验证

> 🟡 普通域 | 5 身份 | 8 问

## 1. Java 开发者 (2问)

1. `jmap -dump:live,file=dump.hprof <pid>` — 和 `-dump:all` 有什么区别？live 为什么要先 Full GC？
2. hprof binary 文件中的对象 ID 是堆地址吗？如果不是堆地址，MAT 怎么重建引用关系？

## 2. SRE/运维 (2问)

3. 10GB heap dump 写入一个 spinning disk — 不压缩 vs 压缩 on-the-fly 的 I/O 时间差多少？压缩是 CPU bound 还是 I/O bound？
4. `-XX:+HeapDumpOnOutOfMemoryError` 在 OOM 时 dump 会不会失败（heap 已满）？JVM 怎么处理这个冲突？

## 3. 框架/工具开发者 (2问)

5. MAT 解析 hprof 文件时怎么区分 byte[] content 和 int[] content？hprof 记录类型编码如何工作？
6. 我能从 JFR 录制中提取 heap dump 吗？还是 JFR 只触发 dump 文件？

## 4. 安全研究者 (1问)

7. hprof dump 包含对象的 field values——如果对象有 `private char[] password`——dump 文件能直接读到密码吗？OOM dump 自动上传到云服务——安全风险？

## 5. 性能工程师 (1问)

8. `-dump:live` 先触发 Full GC——对 100GB heap 的 STW 时间有多少？GC+遍历+写文件的时间分配？
