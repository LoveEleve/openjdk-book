# 14-c1-compiler/04-c1-runtime-frame 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释 C1 为什么把复杂/罕见路径委托给 Runtime1，以及机器码跳入 C++ 后如何靠 FrameMap、OopMap、CodeEmitInfo 和 stub 约定保住 Java 语义

## 1. 选题判断

现稿已经覆盖：
- Runtime1 stub 宏表
- JRT_ENTRY 慢路径
- `new_instance` / 数组 / monitor
- FrameMap 帧布局
- OopMap 实际在 LinearScan 构建
- 与 InterpreterRuntime 的对照

但主线仍偏“Runtime1 清单 + FrameMap 字段说明”。真正的读者困惑应更集中：

**C1 生成的机器码为什么不能把所有事情都自己做完？当它在分配失败、类型解析、异常、锁竞争、去优化等场景跳进 C++ 时，JVM 怎么知道当前 Java 方法、活跃 oop、原始 bytecode 状态和返回位置，保证这次“逃生”之后还能正确继续？**

这才是 Runtime1 + FrameMap 作为一篇文章真正的闭环问题。

## 2. 一句话顿悟

**Runtime1 不是 C1 的失败补丁，而是它的架构分工：机器码负责高频快路径，复杂且罕见的动作统一跳到预先生成的 Runtime1 stubs，再进入 C++；FrameMap 把虚拟位置映射到实际帧布局，LinearScan 为 safepoint/调用生成 OopMap，CodeEmitInfo 保存 bytecode 状态与异常/去优化信息，于是 Runtime1 即使接管了控制流，也仍然能把当前 nmethod 当作一个可被 GC、异常处理和 deopt 正确理解的 JVM 帧。**

## 3. 总图

```text
C1 机器码快路径
  │
  ├─ 高频简单动作：内联完成
  │
  └─ 复杂/罕见动作
       │
       ▼
Runtime1 stub blob
  ├─ 保存/恢复约定
  ├─ OopMap / frame info
  ├─ 进入 JRT_ENTRY C++
  ├─ 分配/锁/异常/解析/patch/deopt
  └─ vm_result / TLS / 返回或转发

FrameMap + LinearScan + CodeEmitInfo
  └─ 让这次跳转仍然知道“Java 帧是什么”
```

## 4. 结构大纲与字数预算

### 第一节：开场困惑——机器码为什么还要跳 C++

目标约 1300 字。

- 从 `new`、锁、异常、首次解析、deopt 开场
- 推演“所有事情都内联生成机器码”的代价
- 引出 Runtime1 的分工：高频快路径 vs 复杂慢路径

### 第二节：两个朴素方案为什么不行

目标约 1700 字。

必须推演：
1. 所有操作都直接内联到 C1 机器码
2. 直接 call 任意 C++ 函数，不需要统一 stub/状态约定

结论：
- 代码膨胀、编译慢、异常/GC/deopt 语义难统一
- C++ 入口需要明确的线程状态、寄存器保存、OopMap、结果返回与异常转发约定

### 第三节：Runtime1 是什么——一张预生成 stub 表，不是一个普通函数库

目标约 1900 字。

- `RUNTIME1_STUBS`
- `generate_blob` / `generate_blob_for` / `initialize`
- RuntimeStub + CodeCache
- 入口地址由 `blob_for` 提供
- stub 分类：分配、锁、异常、解析 patch、deopt、counter

### 第四节：以对象分配为例——快路径内联，慢路径进入 `JRT_ENTRY`

目标约 2100 字。

- `new_instance` 的真实参数是 `Klass*`
- 初始化检查与 `allocate_instance`
- `thread->set_vm_result` 返回 oop
- 数组分配同理
- 解释为什么这是慢路径而不是所有 new 的路径

### 第五节：锁、异常、解析与 deopt——Runtime1 接管的不是一个场景

目标约 2000 字。

- monitorenter/exit
- range/null/div0/type exceptions
- patching stubs
- deoptimize / exception_handler_for_pc
- 共同点：复杂语义交给 C++，机器码保留入口与恢复信息

### 第六节：FrameMap——机器帧不是“栈槽数组”，而是一份 ABI 与 JVM 约定

目标约 1900 字。

- locals / monitors / spill / reserved args / ABI 区域
- CPU register mapping
- caller-save / callee-save
- framesize 与偏移
- 为什么 Runtime1 能按约定读写这些位置

### 第七节：OopMap 到底在哪里构建——FrameMap 不负责判断哪个槽是 oop

目标约 1800 字。

- `LinearScan::init_compute_oop_maps`
- `compute_oop_map`
- active oop intervals -> OopMap
- 调用点/safepoint 的 GC 扫描依据
- 纠正“FrameMap 自己构建 OopMap”的误解

### 第八节：CodeEmitInfo——异常和去优化为什么还需要 bytecode 状态

目标约 1800 字。

- `ValueStack` / `CodeEmitInfo`
- `state_before` / exception handlers / deoptimize_on_exception
- patching 与 force reexecute
- 让 C++/deopt 知道如何回到 Java 语义

### 第九节：Runtime1 与 InterpreterRuntime 的边界

目标约 1200 字。

- C1 编译代码走 Runtime1
- 解释器走 InterpreterRuntime
- 底层可能共享 allocate/monitor/exception helper
- 入口约定不同，调用载体不同

### 第十节：误解清单与收网

目标约 1200 字。

至少回答：
1. Runtime1 是否等于“C1 编译失败后的补救”
2. 所有 new 是否都走 Runtime1
3. `new_instance` 参数是否是 `ciKlass`
4. FrameMap 是否负责构建 OopMap
5. C++ 慢路径返回值是否普通 C++ return 就够

## 5. 失败方案必须写进正文

1. 所有复杂操作都内联在 C1 机器码
2. C1 直接调用任意 C++ 函数，不做统一 stub/帧/状态约定
3. 只保存寄存器/栈位置，不保存 bytecode 状态和 oopmap

## 6. 证据清单

- `share/c1/c1_Runtime1.hpp:36-74`：Runtime1 stub 表
- `share/c1/c1_Runtime1.hpp:81-138`：stub 生成与 OopMap
- `share/c1/c1_Runtime1.hpp:140-170`：runtime 入口
- `share/c1/c1_Runtime1.cpp:194-228`：生成 RuntimeStub blob
- `share/c1/c1_Runtime1.cpp:258-281`：初始化全部 stubs / `blob_for`
- `share/c1/c1_Runtime1.cpp:346-358`：`new_instance`
- `share/c1/c1_Runtime1.cpp:361-406`：数组分配慢路径
- `share/c1/c1_FrameMap.hpp:42-63`：帧布局总图
- `share/c1/c1_FrameMap.hpp:69-104`：FrameMap 字段与寄存器/帧区域
- `share/c1/c1_LinearScan.cpp:2415-2449`：OopMap 构建
- `share/c1/c1_IR.hpp:183-225`：CodeEmitInfo/OopMap 关系
- `share/c1/c1_LIRAssembler.cpp:37-46`：patching/force reexecute
- `share/c1/c1_Runtime1.cpp`：monitor/exception/deopt/patch 相关入口，正文按需补行号

## 7. 必须明确的边界

- 基于 JDK 11u C1 + x86_64
- 本篇聚焦 Runtime1、帧映射、oopmap、状态恢复，不深入 Runtime1 每个 stub 的汇编实现
- `FrameMap` 的平台寄存器表通过 `CPU_HEADER` 注入，正文以抽象职责为主
- InterpreterRuntime 只做边界对照，不重复 08 域内容

## 8. 完成后 review

- 删除代码后，能否复述“Runtime1 让机器码把复杂语义委托给 C++，FrameMap/OopMap/CodeEmitInfo 让委托过程仍是合法 JVM 执行”
- 是否把 Runtime1 和 FrameMap 收回到“机器码如何安全逃生”的同一个问题上
- 是否明确区分了快路径、慢路径、帧位置、oopmap、bytecode 状态各自的职责
- 是否完成删码测试、禁用词、file:line、链接、版本边界检查
