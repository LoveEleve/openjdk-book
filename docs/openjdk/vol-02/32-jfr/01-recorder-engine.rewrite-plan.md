# 32-jfr/01-recorder-engine 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释 JFR 怎么在低开销下采集 130+ 种事件——per-thread buffer 写入、消息循环调度、chunk 文件轮转

## 1. 选题判断

现稿已有很强事实基础：
- `JfrThreadLocal` 的 `_java_buffer` / `_native_buffer`
- `JfrBuffer` 的 `_pos` / `_top` 双指针
- `JfrStorage::flush` → `flush_regular` 四级刷写链
- JFR Recorder Thread 消息循环（六种消息）
- `JfrChunkWriter` 文件头格式
- `JfrChunkRotation` 轮转

但现稿仍偏"写入侧一节 + 调度侧一节 + 文件侧一节"的机制并列。真正该打穿的读者困惑更集中：

**JFR 采集 130+ 种事件，怎么做到底开销？per-thread buffer 怎么避免锁竞争？满了怎么办？后台线程怎么调度？chunk 文件怎么组织？**

## 2. 一句话顿悟

**JFR 的低开销靠每线程两个 buffer（Java/native 分流，bump 分配写 `_pos`，`_top` 做刷写水位线），满了走四级刷写链（刷空→原地续→shelve→租大 buffer）。后台 JFR Recorder Thread 的消息循环处理六种消息（FULLBUFFER/ROTATE/DEADBUFFER 等）。chunk 文件自包含，关闭时回填头，可边录边读。**

## 3. 总图

```text
写入侧
  Thread._java_buffer / _native_buffer
    _pos (线程私有, bump 分配)
    _top (volatile, 刷写水位线)
  满 → flush_regular 四级
    ① 刷空 (flush_regular_buffer)
    ② 原地续 (memmove 未刷数据)
    ③ shelve + 租大 buffer (transient)
    ④ restore 换回

调度侧
  JFR Recorder Thread 消息循环
    FULLBUFFER → process_full_buffers
    ROTATE → rotate
    DEADBUFFER → scavenge
    START / SHUTDOWN

文件侧
  Chunk: FLR + 版本 + 6 头槽
    关闭时回填 (chunk 大小/checkpoint 偏移/时间戳)
    轮转: 阈值由 Java 侧 setFileNotification 设置
```

## 4. 结构大纲与字数预算

### 第一节：开场困惑——"130+ 种事件，怎么低开销"

目标约 1000 字。

- 从 JFR 采集 130+ 种事件切入
- 点出：直接写全局缓冲需要锁，高并发不可行
- 埋主线：per-thread buffer + 消息循环 + chunk 文件

### 第二节：两个朴素方案为什么都不对

目标约 1200 字。

必须推演：
1. 全局单一缓冲 + 锁保护（高并发下锁竞争严重）
2. 每事件类型一个缓冲（JFR 有 130+ 事件类型，管理开销大）

结论：
- per-thread buffer 避免锁竞争，Java/native 分流隔离开销差异

### 第三节：写入侧——每线程两个 buffer

目标约 2500 字。

- `JfrThreadLocal`（jfrThreadLocal.hpp:37-40）
- `JfrBuffer` 双指针（jfrBuffer.hpp:33-57）
- `JfrStorage::flush` → `flush_regular`（jfrStorage.cpp:489-529）
- 四级刷写链
- 默认大小：thread-local 8KB，global 512KB

### 第四节：调度侧——JFR Recorder Thread 消息循环

目标约 2000 字。

- 消息循环（jfrRecorderThreadLoop.cpp:40-86）
- 六种消息
- 启动时机（on_create_vm_1/2/3）

### 第五节：文件侧——chunk 格式与轮转

目标约 1800 字。

- `JfrChunkWriter::open`（jfrChunkWriter.cpp:54-70）
- 文件头：FLR + 版本 + 6 头槽
- 关闭时回填（:95-107）
- `JfrChunkRotation::evaluate`（jfrChunkRotation.cpp:62-66）

### 第六节：误解澄清与收网

目标约 1200 字。

## 5. 失败方案

1. 全局单一缓冲 + 锁保护
2. 每事件类型一个缓冲

## 6. 证据清单

- `src/hotspot/share/jfr/jfrThreadLocal.hpp:37-40`
- `src/hotspot/share/jfr/recorder/storage/jfrBuffer.hpp:33-57`
- `src/hotspot/share/jfr/recorder/storage/jfrStorage.cpp:489-529`
- `src/hotspot/share/jfr/recorder/service/jfrRecorderThreadLoop.cpp:40-86`
- `src/hotspot/share/jfr/recorder/service/jfrRecorder.cpp:84,193,223`
- `src/hotspot/share/jfr/recorder/storage/jfrChunkWriter.cpp:54-70`
- `src/hotspot/share/jfr/recorder/storage/jfrChunkWriter.cpp:95-107`
- `src/hotspot/share/jfr/recorder/repository/jfrChunkRotation.cpp:62-66`
- `src/hotspot/share/jfr/recorder/service/jfrOptionSet.cpp:165,168`
- `src/hotspot/share/jfr/jni/jfrJniMethod.cpp:116-118`

## 7. 完成后 review

- 删除代码后，能否复述"per-thread buffer、消息循环、chunk 文件"
- 是否讲清双指针和四级刷写链
- 是否讲清 chunk 自包含和关闭回填
- 是否完成删码测试、禁用词、链接、`file:line`、`git diff --check` 校验