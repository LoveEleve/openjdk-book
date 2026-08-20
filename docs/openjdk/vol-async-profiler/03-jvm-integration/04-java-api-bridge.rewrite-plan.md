# 04-java-api-bridge 重写规划

> 状态：正文已重写，待 deep review
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 目标：把当前“execute0/execute1/RegisterNatives 说明文”重写成一篇围绕“Java 世界怎样把字符串命令、安全加载、线程过滤和 Recording helper 接到同一个 native profiler 内核上”的机制文章

## 1. 读者困惑

- Java API 为什么不是另一套 profiler 实现，而只是桥？
- `execute0`、`execute1`、`start0/stop0` 为什么同时存在？
- `execute0` 为什么有文件时只返回 `OK`，而不是统一返回完整文本？
- `RegisterNatives` 为什么不直接靠固定 JNI 符号名，反而要走栈回溯找真实类？
- `filterThread0`、`getSamples`、`Recording` helper 这些接口为什么放在同一个桥接层？
- Java API 与 C API 共享的是哪一层，不共享的又是哪一层？

## 2. 一句话顿悟

**Java API bridge 真正统一的不是“Java 侧功能封装”，而是把 Java 字符串命令、强类型快捷入口、Recording helper 和 shaded 类加载差异全部接到同一个 native `Arguments → Profiler::runInternal` 内核上；JNI 这一层只负责类型转换、异常映射、输出承载和类绑定。**

## 3. 总图

```text
AsyncProfiler.java / Recording.java
  → start0 / stop0 / execute0 / execute1 / getSamples / filterThread0
    → javaApi.cpp
      → Arguments or direct Profiler entry
        → Profiler::runInternal / start / stop / ThreadFilter / RecordingAPI
          → native engine / recorder / output
```

## 4. 版本与边界

- `start0`/`stop0` 是强类型快捷入口；`execute0`/`execute1` 是字符串协议入口，不能混写成同一种 API。
- `execute0` 有输出文件时只返回 `"OK"`，这是 JNI 返回契约，不是 profiler 统一结果模型。
- `execute1` 明确拒绝 output file，保证返回值是唯一二进制结果通道。
- `RegisterNatives` 的运行时类发现主要服务 shaded/重命名场景；它不是所有 native 入口都必须经过的唯一注册方式。
- `filterThread0`、`getSamples`、`Recording.emitSpan` 等 helper 共享的是同一个 native profiler 状态，不等于它们都走 `Arguments::parse()`。
- Java API 与 C API 共享 profiler 内核，但参数承载、错误呈现和输出载体不同。

## 5. 结构大纲

### 第一节：为什么 Java API 不是另一套 profiler

把 Java 世界里的 `execute`/`start`/`dump` 看成桥而不是内核。

### 第二节：字符串入口与强类型快捷入口为什么要并存

`execute0/execute1` vs `start0/stop0/getSamples/filterThread0`。

### 第三节：`execute0` / `execute1` 的返回契约与异常映射

jstring/byte[]/FileWriter/IOException/IllegalArgumentException/IllegalStateException。

### 第四节：`filterThread0`、Recording helper 与桥接层为什么还在同一个文件里

样本计数、线程过滤、DirectByteBuffer、span 事件。

### 第五节：`RegisterNatives` 为什么要运行时找真实 AsyncProfiler 类

shaded、System.load/loadLibrary 栈回溯、真实类绑定。

### 第六节：Java API 与 C API 共享内核，但不共享载体

Arguments/Profiler 共享，异常/回调/返回值契约不同。

### 第七节：收网——Java 世界只是桥，参数和执行真相仍在 native

## 6. 证据清单

- `src/javaApi.cpp:25-173`
- `src/javaApi.cpp:177-224`
- `src/api/one/profiler/AsyncProfiler.java:25-300`
- `src/asprof.cpp:26-52`
- 必要时补 `RecordingAPI` 的注册/clock/update 边界

## 7. 完成后检查

1. 删除代码块后仍能复述“Java API 只是桥，native Arguments/Profiler 才是内核”。
2. 至少展开 4 个失败方案或误解。
3. 区分 `execute0/execute1` 与 `start0/stop0` 两类入口。
4. 区分 `Arguments::parse()` 路径与直接 `Profiler::start/stop` 路径。
5. 写清 `RegisterNatives` 的 shaded 动机和类发现顺序。
6. 每个 `file:line` 重新核对，链接、结构标记和禁用词通过。
