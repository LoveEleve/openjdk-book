# 域 48 Utilities — Pass 1 轮廓记录

> 日期: 2026-08-17 | 范围: HotSpot utilities/ 及已落盘的 48-utils 四篇正文
> 规划状态: 既有正文已提交，本轮补齐规划与证据链，不重复写正文

## 已存在正文

- `vol-02/48-utilities/01-vmerror.md`
- `vol-02/48-utilities/02-concurrent-bitmap.md`
- `vol-02/48-utilities/03-stream-exception.md`
- `vol-02/48-utilities/04-utf8-json-decoder.md`

## 四篇主题边界

1. **VMError**：致命错误报告、错误处理阶段、崩溃现场输出
2. **ConcurrentBitmap**：并发 bitmap 的位操作、原子更新与扫描
3. **Stream/Exception**：HotSpot 内部 stream 抽象与异常/错误传播工具
4. **UTF8/JSON decoder**：轻量输入解析器、边界处理与无分配/低分配路径

## Pass 1 观察

- 48-utils 不是一个单一模块，而是多个低层工具被不同运行时子系统复用。
- 四篇正文的共同主线应是：工具类如何把复杂的 JVM 机制压缩成可复用的低层契约。
- `VMError` 偏故障路径；bitmap 偏并发数据结构；stream/exception 偏控制流；UTF8/JSON 偏输入解析。
- 需要特别区分：正文已经写作完成，本轮重点是把每篇的源码边界、依赖关系、证据锚点和跨篇衔接补齐。

## 标记问题

1. `VMError` 的报告流程是否与 signal/safepoint 域形成正确 OUTBOUND？
2. `ConcurrentBitmap` 的并发写入到底使用什么原子语义，扫描是否允许读到中间态？
3. stream/exception 工具中哪些是 HotSpot 自有抽象，哪些只是薄包装？
4. UTF8/JSON decoder 的输入边界、非法字节和终止条件如何处理？
5. 四篇正文之间是否存在重复的“低层工具/无分配”表述？
6. 既有正文中的所有源码行号是否仍与 jdk11u 工作树一致？
7. 每篇是否都有明确的依赖前置、核心悬念和下一篇 OUTBOUND？
8. 48-utils 是否应继续拆分更多篇，还是四篇已经覆盖规划边界？

## 交接结论

- 48-utils 是当前唯一下一域，未发现其他 AI 的未提交改动或规划占用。
- 本轮先补 Pass 1；下一步逐篇读取既有正文与对应源码，建立 Pass 2 闭环及深审记录。
