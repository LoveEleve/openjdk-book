# 02-jfr-recorder 重写规划

> 状态：现稿待回炉；本文件先做理解路径设计，不直接改正文
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 目标：把当前“Recording/metadata/cpool/JfrSync 说明文”重写成一篇围绕“async-profiler 不调用常规 JDK JFR writer，为什么仍能写出被 JMC/JFR reader 正确解释的 chunk 化 JFR 文件，而且还能在热路径与 chunk 收口之间分摊成本”的机制文章

## 1. 读者困惑

- async-profiler 没有在普通 `-o jfr` 路径里直接调用 `jdk.jfr.Recording`，为什么写出的文件还能被 JMC/JFR reader 识别？
- 为什么 JFR 输出不能像 flamegraph 一样，先聚合好结果再一次性导出？
- 为什么采样热路径只写 `event + tid + call_trace_id`，而 stack trace/method/class/thread 等对象关系要拖到 chunk 结束时再补？
- metadata、constant pool、chunk header patch 三者分别在补哪一层缺口？
- `lock_index` 为什么会一路贯穿到 JFR 输出，而不是 JFR writer 自己再加一层全局串行锁？
- `--jfrsync` 为什么不是“直接把 native 事件塞进 JDK Recording”，而是 master file + 临时文件 + append 的协同路径？

## 2. 一句话顿悟

**async-profiler 的 JFR writer 本质上是在 native 侧手写一套“JFR 可解释协议”：采样热路径只把事件和对象 ID 编码进分槽 buffer，chunk 结束时再把 stack trace、method、class、thread、string 等对象池补成 constant pool，并回填 chunk header；metadata 提前定义 reader 如何解释这些字节，`--jfrsync` 则只是把这套 native recording 与 JDK 自己的 recording 在文件层做协同。**

## 3. 总图

```text
Profiler::recordSample()
  → CallTraceStorage.put() / call_trace_id
    → FlightRecorder::recordEvent(lock_index, tid, trace_id, event_type, event)
      → RecordingBuffer[lock_index]
        → record* writer：event bytes
          → flushIfNeeded() / write()

chunk finish / switch
  → flush all buffers
    → writeCpool()
      → threads / stack traces / methods / classes / packages / symbols / strings
        → patch cpool size
          → patch chunk header
            → JFR reader / JMC
```

## 4. 版本与边界

- 本篇聚焦 async-profiler 当前 native `FlightRecorder` 实现，不把它写成 JDK Flight Recorder 内部 writer 的官方说明。
- 普通 `-o jfr` 路径依赖 native `Recording`/`flightRecorder.cpp`，不是直接依赖 Java `jdk.jfr.Recording`。
- metadata 不是装饰信息，而是 reader 解释 event bytes 与 constant pool 的类型契约。
- 热路径的 `recordEvent()` 会立即编码事件字段，并在 buffer 满时允许当前路径直接 `write()`；不能写成“永远只写内存、后台线程统一落盘”。
- chunk 结束时的 constant pool 与 flamegraph Trie 不是一回事；前者是稳定 ID 到对象关系的池，后者是可视化前缀聚合结构。
- `collectTraces()` 会重置 samples，避免 trace 跨 chunk 重复写入；这属于 async-profiler 当前 chunk 策略，不是 JFR 规范本身的要求。
- `--jfrsync` 是可选协同路径，依赖嵌入的 `JfrSync` helper 和 JDK JFR API，不代表普通 `-o jfr` 也走这条路径。

## 5. 现稿方法论差距审计

- 现稿事实覆盖已经很完整，但中段仍偏“格式组件说明”，读者未必能始终抓住“为什么热路径不能直接把完整 JFR 对象写出来”这一主冲突。
- metadata、event writer、constant pool、header patch 现在更像串行讲解的四块材料，还需要压成一条更硬的理解链：热路径只写最小事实，收口阶段再补对象关系。
- `lock_index` 与 AP-2 主线连接虽已写到，但还可以更明确地强调“JFR 没有另起一套全局串行模型”。
- `writeCpool()` 已覆盖池项列表，但“为什么 stack trace pool 不能在事件发生时直接物化”这一失败方案厚度还可以更强。
- `--jfrsync` 部分事实正确，但还可以更硬地区分“协议级 native writer”与“文件级协同 append”，避免读者把它误读成同一个 recording 里的双 writer 并发写。
- 需要更明显地回收 `callTraceStorage.cpp:128-129` 的 chunk 边界意义，否则 `collectTraces()` 重置 samples 的设计意图容易被当成实现细节跳过。

## 6. 重写策略

1. 用“JFR 文件不是日志行列表，reader 看到的是 schema + chunk + pool + event 关系网”开场。
2. 推演并否定至少四个直觉：
   - 每次采样直接调用 `jdk.jfr` API；
   - 每条事件都把完整 stack/method/class/thread 信息就地写进文件；
   - 热路径永远只写内存、停止时统一落盘；
   - `--jfrsync` 是把 native 事件直接注入 JDK 正在运行的 recording。
3. 给出总图：metadata 先立解释契约 → 热路径即时编码事件 + ID → chunk 结束补对象池 → patch header → reader 消费。
4. 分层讲：
   - Recording 构造时怎样先立起一个合法 chunk 骨架；
   - metadata 为什么是 reader 的类型系统；
   - `lock_index` 如何把采样主线接到 JFR buffer；
   - event writer 为什么只写字段和 ID；
   - `writeCpool()` 怎样把 trace/method/class/thread/string 补齐；
   - chunk switch 与 `_base_id` 怎样维持多 chunk 的对象 ID 边界；
   - `--jfrsync` 怎样在文件层协同 JDK 自带事件。
5. 收网时强调：本篇讲的是 native JFR-compatible writer，不是 JDK JFR 内核实现总论，也不是 OTLP/JFR converter 路径。

## 7. 结构大纲

### 第一节：事故开场——为什么 JFR 文件不是“把事件逐条写进去”

回答：reader 读到的不是裸事件流，而是依赖 metadata、constant pool 和 chunk header 的结构化二进制协议。

预估字数：900-1200

### 第二节：先排除四个错误直觉——直接调 Java API、每条事件就地写全对象、热路径永不 write、jfrsync 直接共写同一 recording

预估字数：1800-2400

### 第三节：第一层——`Recording` 为什么先搭 chunk 骨架，再接受事件

证据：`src/flightRecorder.cpp:237-330`、`src/flightRecorder.cpp:582-659`。

回答：`_buf`/`_fd`/`_memfd`/`_base_id`/`_chunk_size`/`_chunk_time` 的角色，header 占位、recording info、settings、系统信息的初始化顺序。

### 第四节：第二层——metadata 为什么不是注释，而是 reader 的类型系统

证据：`src/jfrMetadata.h:16-244`、`src/jfrMetadata.cpp:13-333`、`src/flightRecorder.cpp:598-629`。

回答：类型 ID、field flags、annotation、metadata event、字符串表，以及“数字只有被 schema 解释后才有意义”。

### 第五节：第三层——`lock_index` 怎样把采样主线接到 JFR 热路径

证据：`src/profiler.cpp:488-492`、`src/profiler.cpp:510-521`、`src/flightRecorder.cpp:1473-1532`。

回答：同一个并发槽继续用于 JFR buffer，event writer 的字段布局，`flushIfNeeded()` 的真实阻塞边界。

### 第六节：第四层——为什么事件只写 ID，而对象池要拖到 chunk 结束时再补

证据：`src/flightRecorder.cpp:844-1067`、`src/flightRecorder.cpp:962-1017`、`src/callTraceStorage.cpp:120-140`。

回答：stack trace/method/class/package/symbol/string pools 的职责，`collectTraces()` 重置 samples 的 chunk 语义，JFR pool 与 flamegraph Trie 的根本区别。

### 第七节：第五层——chunk 结束时为什么还要 patch cpool size、header 和 ticks frequency

证据：`src/flightRecorder.cpp:347-399`、`src/flightRecorder.cpp:402-422`。

回答：为什么开始时只能写占位值，为什么 stop 时才知道真正 chunk size / cpool offset / duration / ticks per sec，多 chunk 和 `_base_id` 的边界。

### 第八节：第六层——in-memory 模式改变了什么，没有改变什么

证据：`src/flightRecorder.cpp:314-316`、`src/flightRecorder.cpp:360-367`、`src/flightRecorder.cpp:424-427`。

回答：只改变暂存位置，不改变 JFR 结构与编码协议。

### 第九节：第七层——`--jfrsync` 为什么是文件级协同，而不是双 writer 共写同一 chunk

证据：`src/flightRecorder.cpp:1311-1467`、`src/helper/one/profiler/JfrSync.java:21-143`。

回答：master recording file、临时 recording、append 路径、built-in event disable、listener 回调 stop 顺序、JDK 可用性边界。

### 第十节：收网——native writer 真正拆开的，是“事件发生时必须做什么”和“reader 最终需要什么”

桥接下一篇 OTLP：为什么另一种消费者不复用 JFR 的 metadata/cpool/chunk 契约。

## 8. 必须展开的失败方案

1. 每条采样事件都可以直接调用 Java `jdk.jfr` API 生成事件对象。
2. 每条事件发生时就把完整 stack trace、method、class、thread 全写进文件，最直观也最准确。
3. 热路径只负责写内存，绝不会触发真正的 `write()`。
4. constant pool 只是可选优化，不影响 reader 正确性。
5. flamegraph Trie 与 JFR stack trace pool 都是“栈的结构”，所以可以混成一回事。
6. `--jfrsync` 是 native writer 和 JDK writer 同时向同一个 chunk 交错写数据。

## 9. 证据清单

- `src/flightRecorder.cpp:237-330`
- `src/flightRecorder.cpp:347-422`
- `src/flightRecorder.cpp:568-659`
- `src/flightRecorder.cpp:844-1067`
- `src/flightRecorder.cpp:1078-1299`
- `src/flightRecorder.cpp:1311-1554`
- `src/jfrMetadata.h:16-244`
- `src/jfrMetadata.cpp:13-333`
- `src/helper/one/profiler/JfrSync.java:21-143`
- `src/callTraceStorage.cpp:120-140`
- 必要时补 `src/profiler.cpp` 中 `_jfr.recordEvent()` 调用点和 `jfrsync` 拒绝非 Java 进程的边界

## 10. 完成后检查

1. 删除代码块后，读者仍能复述“metadata 契约 → 热路径事件编码 → chunk 结束补对象池 → patch header → reader 消费”。
2. 至少展开 4 个失败方案，而不是把 writer 组件平铺成清单。
3. 明确区分 metadata、event bytes、constant pool、chunk header 四层职责。
4. 明确区分普通 native JFR writer 与 `--jfrsync` 协同路径。
5. 明确区分 JFR stack trace pool 与 flamegraph Trie。
6. 不把 in-memory / chunk size / jfrsync helper 写成 JFR 规范本身；它们是 async-profiler 当前实现策略。
7. 每个 `file:line` 重新核对，链接、结构标记和禁用词通过。
