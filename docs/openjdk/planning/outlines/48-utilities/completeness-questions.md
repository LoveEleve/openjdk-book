# 域 48 Utilities — 全视角提问验证

> 🟡 大域 | 5 身份 | 8 问

## 1. Java 开发者 (2问)

1. JVM crash→hs_err_pid.log——文件中的 `[error occurred during error reporting]` 是什么意思？什么情况下 error reporter 自己也会 crash？
2. `String.intern()` 在 ConcurrentHashTable 中 lookup——如果两个线程同时 intern 同一个 String→第一个 insert→第二个 get 返回第一个的 entry。这个操作需要锁吗？

## 2. SRE/运维 (2问)

3. `-XX:ErrorFile=/var/log/jvm/hs_err_%p.log`→`%p` 是 PID——如果两个 JVM 同时 crash in same directory→`_first_error_tid` token 怎么跨进程工作？
4. hs_err_pid.log 中的 native stack trace 显示 `[0x00007f...]+0x20` 而非函数名——libjvm.so stripped→怎么用 `addr2line` 手动解析？

## 3. 性能工程师 (2问)

5. ConcurrentHashTable 的 resize 在 grow 时 rehash 所有 entries——10万 String intern→resize 多少次？rehash 的耗时多少？
6. BitMap::iterate 跳过全零 64-bit words——sparse 5% density 的 bitmap 比 dense 90% 快多少倍？

## 4. 安全研究者 (1问)

7. modified UTF-8 用 0xC0 0x80 编码 NUL——如果恶意 class file 包含 `C0 80 C0 80`→JVM 解析为 U+0000 U+0000→这是两个 null 还是一个？

## 5. 框架开发者 (1问)

8. `outputStream::print_cr` 最终调 `::fwrite`——GC log 每秒百万次 print→stringStream 的 2x grow 策略会不会导致频繁 realloc？
