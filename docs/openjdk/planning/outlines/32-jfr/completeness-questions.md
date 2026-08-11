# 域 32 JFR — 全视角提问验证

> 🔴 巨型域 217文件 | 5 身份 | 12 问

## 1. Java 开发者 (3问)

1. `jcmd <pid> JFR.start name=profile settings=profile` — 这个命令启动后，JFR 怎么记录事件？per-thread buffer 怎么避免锁竞争？
2. 我的应用 GC 频繁——JFR 的 OldObjectSample 能自动检测到内存泄漏的 GC root path 吗？采样率由什么控制？
3. `.jfr` 文件为什么能"边录边看"？chunk format 和 constant pool 每 chunk 重复写有什么用？

## 2. JVM 性能工程师 (2问)

4. JFR 的 LEB128 编码对小值（如 event type id=3, timestamp delta=50ns）平均压缩多少？100MB recording 在磁盘上实际多大？
5. `jdk.ThreadDump` event 记录 1000 个线程——怎么在 JFR buffer 中存下所有 stack frames 而不溢出？

## 3. 框架/工具开发者 (3问)

6. 我要从 JMC 导出 JFR recording 到自定义格式——.jfr chunk format 的 constant pool 和 metadata 怎么自描述——我不需要 JFR metadata XML 就能解析吗？
7. JFR 的 ASM bytecode instrumentation 注入了哪些类？如果我自己的类被注入了——怎么验证和诊断？
8. `JfrJniMethod::start()` 从 Java `Recording.start()` → C++ JfrRecorder——中间的 JNI state transition(`_thread_in_native→_thread_in_vm`) 是怎么处理的？

## 4. SRE/运维 (2问)

9. JFR recording 大小增长到 chunk_size_limit(默认 12MB)时——rotation 怎么保证不丢事件？chunk 间的 event 顺序能保持吗？
10. 生产环境 `-XX:StartFlightRecording=settings=profile` JVM flag——JFR 的 overhead 主要来自哪里(buffer write/stack trace/compression)？

## 5. 安全研究者 (2问)

11. JFR recording 包含 `jdk.ThreadDump` events——这些 events 能把 thread stack variables 的值也 dump 出来吗（敏感数据泄露）？
12. `jcmd <pid> JFR.dump` — 任何 OS user 都能 dump 其他 user 的 JVM 的 JFR recording 吗？permission check 在哪里？
