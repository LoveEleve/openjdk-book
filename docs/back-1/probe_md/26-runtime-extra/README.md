# 26 — 运行时剩余 — libjvm.so (runtime/)

## §〇 概述

补充分析 runtime/ 中 173 文件（~90K 行）里已被大量引用但尚未深度覆盖的子机制。

**源码路径**：`src/hotspot/share/runtime/`

### BUILD_LIBRARY

属于 libjvm.so 内部编译：
```
make/hotspot/lib/CompileJvm.gmk:153 — BUILD_LIBJVM
```

---

## §一 已覆盖 vs 待覆盖

```
runtime/ (173 files, ~90K lines)

✅ 已覆盖（libjvm-analysis 深入文档）:
  threads (thread.cpp/hpp, 5,401+2,342)            → 07-thread-lock
  objectMonitor.cpp/hpp (2,495+343)                 → 07-thread-lock
  biasedLocking.cpp/hpp (890+195)                   → 07-thread-lock
  mutex.cpp/hpp (1,392+323)                         → 07-thread-lock
  synchronizer.cpp/hpp (2,014+207)                  → 07-thread-lock
  safepoint.cpp/hpp (1,519+281)                     → 08-safepoint
  deoptimization.cpp/hpp (2,452+468)                → 05-jit-compiler
  sharedRuntime.cpp/hpp (3,246+729)                 → 05-jit-compiler
  frame.cpp/hpp (1,397+472)                         → 12-cpu-layer
  jniHandles.cpp/hpp (687+207)                      → 09-native-interface

⏳ 待覆盖 — Phase 26 目标:
  handshake.cpp/hpp            527+101            线程握手协议
  threadSMR.cpp/hpp/inline    1181+373+96         Hazard Pointer 线程安全回收
  arguments.cpp/hpp           4380+680             JVM 参数解析全链路
  jvmFlag.cpp/hpp             1537+282            Flag 注册与查询
  jvmFlagConstraintList       368+101             Flag 约束验证
  jvmFlagRangeList            431+74              Flag 范围约束
  jvmFlagWriteableList        204+67              Flag 可写性管理
  jvmFlagConstraintsCompiler  407+74              Compiler flag 约束
  jvmFlagConstraintsRuntime   143+50              Runtime flag 约束
  vmOperations.cpp/hpp         514+534            VM_Operation 类型系统
  vmThread.cpp/hpp             817+189            VM Thread 主循环+等待队列
  javaCalls.cpp/hpp            648+271            Java 方法调用约定
  interfaceSupport             307+605            线程状态转换 RAII
  timer.cpp/hpp                177+99             JVM 计时系统
  statSampler.cpp/hpp          369+70             统计采样
  serviceThread.cpp/hpp        185+60             服务线程
  safepointMechanism           121+94+81          Safepoint 轮询机制
  perfData.cpp/hpp             621+973            PerfData 性能计数器
```

---

## §二 文档拆分规划

| 编号 | 标题 | 源文件数 | 源码行数 | 状态 |
|:---:|------|:---:|:---:|:---:|
| 00 | Handshake & ThreadSMR | 5 | ~2,200 | 待开始 |
| 01 | JVM Flag System | 8 | ~8,000 | 待开始 |
| 02 | VM Thread, VM Ops & Services | 10 | ~4,000 | 待开始 |

### doc-00: Handshake & ThreadSMR

handshake.cpp/hpp + threadSMR.cpp/hpp/inline

**关键问题**：
- Thread-local handshake 协议：arm/execute/wait 三步
- Global handshake vs per-thread handshake vs one-thread handshake
- HandshakeState + HandshakeClosure 抽象
- ThreadSMR 的 Hazard Pointer 实现：acquire/release/try_scan
- DeleteDeferredToken 和 java_lang_Thread::smr_delete() 协作

### doc-01: JVM Flag System

arguments.cpp/hpp + jvmFlag.cpp/hpp + jvmFlagConstraintList + jvmFlagRangeList + jvmFlagWriteableList + jvmFlagConstraintsCompiler + jvmFlagConstraintsRuntime

**关键问题**：
- Arguments::parse() 15 阶段解析管线（10 级优先级）
- JVMFlag 的三值类型系统（bool/intx/uintx/uint64_t/size_t/double/ccstr）
- Constraint + Range + Writeable 三层验证
- jvmFlagConstraintList::init() 注册机制
- -XX:+UnlockExperimentalVMOptions / -XX:+UnlockDiagnosticVMOptions
- aliased options (废弃/重命名 flag 映射)

### doc-02: VM Thread, VM Ops & Service Infrastructure

vmThread.cpp/hpp + vmOperations.cpp/hpp + javaCalls.cpp/hpp + interfaceSupport + timer.cpp/hpp + statSampler.cpp/hpp + serviceThread.cpp/hpp + safepointMechanism + perfData.cpp/hpp

**关键问题**：
- VM Thread 主循环：wait → execute → notify 消息驱动
- VM_Operation 继承树（40+ 子类）和优先级队列
- VM_Operation::evaluate_at_safepoint() vs evaluate_concurrently()
- javaCalls 的 call_virtual/call_static/call_special 三层
- ThreadBlockInVM/ThreadInVMfromNative/ThreadInVMfromJava RAII 转换
- PerfData 计数器模型（Counter/Value/Constant）和 /tmp/hsperfdata 文件

---

## §三 旧文档重叠

- `libjvm-analysis/07-thread-lock/` 覆盖线程核心生命周期，ThreadSMR/Handshake 未涉及
- `libjvm-analysis/08-safepoint/` 覆盖 Safepoint 协议，safepointMechanism 未深入
- `libjvm-analysis/01-jvm-startup/20-Arguments-Parse-Flow.md` 部分覆盖 Arguments
- `libjvm-analysis/07-thread-lock/12-JVM-ServiceThread.md` 部分覆盖 ServiceThread
- 旧文档标记互补，新文档补充详细实现

---

## §四 待完成

- [x] 遍历 runtime/ 确认遗漏文件
- [x] 确定 BUILD_LIBRARY 引用
- [ ] 写 prompt（并行 3 篇）
- [ ] 新会话生成文档
- [ ] Review
