# 39-jfr/03 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `jdk.jfr.internal.EventInstrumentation`、`JVMUpcalls`、`EventHandler`。本文聚焦事件类重转换、ASM 注入和启用判断后的写入路径；录制配置放到下一篇。
> 目标：把“字节码增强机制”改写成一篇围绕“JFR 事件类之所以能从看起来像空壳的 Java API 变成真正可写入记录缓冲的对象，关键不在 Java 语法，而在运行时字节码注入：JVM 在合适时机把事件类重写成一条专用、低开销的写入路径”展开的机制文章。

## 1. 读者困惑

- 为什么 `Event.begin/end/commit` 在源码里看起来几乎像空实现，却又能真的把事件写进 JFR？
- JFR 事件类是在什么时候被“激活”的，为什么旧字节码会被重转换？
- `EventInstrumentation` 到底改写了什么，为什么需要 ASM？
- 注入后的 `commit` 实际会走向哪里，怎样连到 `EventHandler` 和缓冲写入路径？
- 为什么这种“源码空壳 + 运行时注入”的设计对 JFR 的低开销如此重要？

## 2. 一句话顿悟

**JFR 公开给用户的 `Event` API 故意做得很薄，因为真正的写入逻辑并不依赖这份表面方法体，而是靠 JVM 在事件类重转换时，用 `EventInstrumentation` 把 `begin/end/commit/isEnabled/shouldCommit` 等方法重写成直接面向 `EventHandler` 的专用路径。这样，事件未激活时几乎不付费，激活后又能避免通用反射开销，把“事件协议”编译成真正的低开销字节码。**

## 3. 旧稿优点与问题

### 保留

- 已抓到 `JVMUpcalls.onRetransform`、`EventInstrumentation`、ASM、`EventHandler` 与 Java/native 内建事件分流的关键落点。
- 已正确强调“空实现只是表面，真实逻辑靠注入”。
- 已把性能设计和注入链挂在一起，方向正确。

### 必须重写

- 旧稿偏实现片段罗列，需要先立住总问题：为什么 JFR 要把事件协议推迟到运行时编译。
- `JVMUpcalls`、`EventInstrumentation`、`EventHandler` 要统一到“从空壳 API 到专用写入路径”的主线上。
- ASM 改写要服务于“编译事件协议”，而不是单独介绍字节码库。
- native 直写事件和 Java 注入事件要讲成两类来源分工，而不是零散补充。

## 4. 理解路径

### 第一节：从“为什么源码里的 commit 看起来像空壳”开场

承接前两篇：事件 Schema 和事件协议都已建立。继续追问——真正的写入逻辑为什么不在源码方法体里。先立住总问题：JFR 把事件协议延迟到运行时编译。

### 第二节：JVM 为什么会在重转换时给事件类加仪表化

证据：
- `JVMUpcalls.java:37/53/62/68`

主线：
- JVM 通过 `onRetransform` 回调拿到旧字节码。
- 只有事件子类才走 `EventInstrumentation` 路径，其他内建事件走另一分支。
- 这说明“事件激活”不是类定义时静态写死，而是运行时按需重写。

### 第三节：`EventInstrumentation` 为什么本质上是在“编译事件协议”

证据：
- `EventInstrumentation.java:60/118/127/131/150/309/328/333/428/472`

主线：
- 先解析旧字节码为 `ClassNode`；
- 再按事件协议生成/替换方法体；
- 再重新写出字节码。
- 重点解释被补全的是 `begin/end/commit/isEnabled/shouldCommit` 等事件协议方法。

### 第四节：为什么注入后的路径会落到 `EventHandler`

证据：
- `EventInstrumentation.java:118/428/472`
- `EventHandler.java:40/61/66`

主线：
- 注入后的方法体不再是空壳，而是获取 event handler 并调用写入方法。
- handler 负责启用判断和阈值判断，再进入底层写入。
- 这把事件类与真正录制引擎连接起来。

### 第五节：为什么“源码空壳 + 运行时注入”比直接把逻辑写死在 `Event` 类里更合理

主线：
- 未注入、未启用时，事件类几乎不付费；
- 注入后路径针对具体事件类编译完成，避免通用反射与额外分派；
- 这让 JFR 能兼顾“不开时便宜”和“开了后也要低开销”。

### 第六节：为什么 Java 层自定义事件和 JVM native 事件要分成两条来源链

证据：
- `JVMUpcalls.java:68`
- 旧稿中 `jdk/jfr/events` 与 GC 事件缺席的线索

主线：
- Java 层自定义事件靠类注入激活；
- 一部分 JVM 内建事件由 native 直接产生，不必经过 Java 事件类注入。
- 这说明 JFR 事件来源本来就是双轨：Java 事件类 + JVM 内部事件。

## 5. 失败方案清单

1. 看到 `Event.commit()` 空壳实现，就以为 JFR 只是示例 API。
2. 以为事件类的真实逻辑都写在 `Event` 基类里，不需要重转换。
3. 把 ASM 当作独立知识点，不看它在这里承担的是事件协议编译工作。
4. 忽略 `EventHandler`，无法解释 commit 如何真正连到底层写入。
5. 把 GC 等 JVM 事件也误以为一定经过 Java 事件类注入。

## 6. 误解清单

1. `commit()` 空实现说明真正的 JFR 写入发生在别的普通工具类里，与事件类无关。
2. 事件类一旦编译完成，行为就固定了，不会再被 JVM 改写。
3. JFR 使用 ASM 只是为了方便生成一点辅助代码，与性能设计关系不大。
4. `EventHandler` 只是事件元数据对象，不参与启用判断和写入路径。
5. Java 层和 JVM 内建事件的激活方式完全相同。

## 7. 证据清单

- `JVMUpcalls.java:37/53/62/68`
- `EventInstrumentation.java:60/118/127/131/150/309/328/333/428/472`
- `EventHandler.java:40/61/66`
- 旧稿中的 `jdk.jfr.Event` 空壳方法线索（与第 1 篇呼应）

## 8. 版本与边界

- 基于 JDK 11。
- 本篇只讲 Java 层事件类注入与 handler 路径，不展开底层缓冲与刷盘实现细节。
- 不深入 ASM 指令级细节，只保留和事件协议改写直接相关的骨架。
- 录制配置和事件消费者 API 留到后续篇章。

## 9. 删除代码测试与最终验收标准

- 删除代码块后，读者仍能复述“为什么 `Event` 源码是空壳 → JVM 怎样在重转换时识别并改写事件类 → `EventInstrumentation` 怎样把事件协议编译成专用字节码 → 注入后如何落到 `EventHandler` → 为什么这套设计同时服务低开销和功能完整性 → Java 自定义事件与 native 事件来源为何双轨”。
- 必须把字节码注入讲成‘事件协议的运行时编译’，而不是 ASM 教程。
- 必须自然引到 `04-recording-config.md`。
