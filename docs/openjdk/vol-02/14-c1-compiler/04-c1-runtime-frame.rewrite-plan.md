# 14-c1-compiler/04-c1-runtime-frame 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释 C1 机器码遇到复杂或罕见路径时，如何通过 Runtime1 进入 VM 代码，以及 FrameMap、OopMap、CodeEmitInfo 如何让这次跳转仍然保留 Java 帧、活跃 oop、异常和去优化语义

## 1. 选题判断

现稿事实基础很强：
- Runtime1 stub 表与 `generate_blob` / `generate_blob_for`
- `new_instance/new_type_array/new_object_array/new_multi_array`
- `vm_result` 返回值通道
- `FrameMap` 的 calling convention / frame size / spill / monitor 布局
- `LIR_Assembler` patching / `CodeEmitInfo`
- OopMap 的构造位置

真正该打穿的困惑更集中：

**机器码撞上分配失败、锁竞争、异常、首次解析、patch、去优化这些复杂路径时，为什么不能自己硬扛？Runtime1 到底解决了什么？FrameMap/OopMap/CodeEmitInfo 三者分别补哪一个漏洞，才能让机器码“逃生”之后仍然是合法的 JVM 执行状态？**

## 2. 一句话顿悟

**Runtime1 解决“复杂动作交给谁”，FrameMap 解决“值在当前帧哪里”，OopMap 解决“哪些位置此刻是活跃 oop”，CodeEmitInfo 解决“如何把当前机器状态解释回 Java bytecode 语义”。四者合起来，机器码才能把慢路径、异常和去优化安全交给 VM。**

## 3. 总图

```text
C1 机器码快路径
  ↓ 遇到复杂/罕见路径
Runtime1 stub
  ├─ 分配/锁/异常/patch/deopt
  └─ 进入 C++ VM helper

FrameMap
  ├─ 参数位置
  ├─ spill 槽
  ├─ monitor 区
  └─ frame size

LinearScan
  └─ 在调用点/安全点构造 OopMap

CodeEmitInfo
  ├─ bytecode bci
  ├─ ValueStack / scope
  ├─ exception handlers
  └─ debug info / force reexecute
```

## 4. 结构大纲

### 第一节：开场困惑——机器码怎么安全“逃生”

- 从分配失败/锁竞争/异常/去优化切入
- 点出：不能把所有复杂逻辑都内联在 C1 机器码里
- 埋主线：Runtime1 负责“跳出去”，FrameMap/OopMap/CodeEmitInfo 负责“还能回来”

### 第二节：两个朴素方案为什么都不行

1. 所有复杂操作都直接内联在 C1 机器码里
2. C1 直接 call 任意 C++ 函数,不需要统一入口和状态描述

### 第三节：Runtime1 是什么——一张预生成的 C1 运行时 stub 表

- Runtime1 类注释与 `RUNTIME1_STUBS`
- `generate_blob` / `generate_blob_for` / `_blobs`
- 不是每个 nmethod 都生成一份
- 哪些 stub 不需要 oop map

### 第四节：对象分配为例——快路径内联,慢路径进 `JRT_ENTRY`

- `new_instance` / `new_type_array` / `new_object_array` / `new_multi_array`
- `vm_result` 约定
- 慢路径和快路径边界

### 第五节：FrameMap——机器帧不是随便摆栈槽

- calling convention
- argument locations
- finalize_frame
- spill / monitor / reserved argument area 布局
- FrameMap 只解决“位置”

### 第六节：OopMap 不在 FrameMap 里建，而在 LinearScan / CodeEmitInfo 链里生成

- `compute_oop_map`
- `CodeEmitInfo::record_debug_info`
- OopMap 是 safepoint 上下文相关描述，不是静态表

### 第七节：CodeEmitInfo——异常和去优化还需要 bytecode 状态

- scope / ValueStack / exception handlers / oopMap / deopt flag
- patching epilog / force_reexecute
- 区分 FrameMap vs OopMap vs CodeEmitInfo

### 第八节：与 InterpreterRuntime 的分工

- 入口不同,底层 helper 可共享
- Runtime1 固定 C1 机器帧进入 VM 的协议

### 第九节：误解澄清与收网

## 5. 失败方案

1. 所有复杂操作都直接内联在 C1 机器码里
2. C1 直接 call 任意 C++ 函数，不需要统一入口和状态描述

## 6. 证据清单

- `src/hotspot/share/c1/c1_Runtime1.hpp:36-74`
- `src/hotspot/share/c1/c1_Runtime1.cpp:194-279`
- `src/hotspot/share/c1/c1_Runtime1.cpp:346-405`
- `src/hotspot/share/c1/c1_FrameMap.cpp:54-97`
- `src/hotspot/share/c1/c1_FrameMap.cpp:156-214`
- `src/hotspot/share/c1/c1_LinearScan.cpp:2415-2444`
- `src/hotspot/share/c1/c1_IR.hpp:251-275`
- `src/hotspot/share/c1/c1_IR.cpp:216-221`
- `src/hotspot/share/c1/c1_LIRAssembler.cpp:37-97`

## 7. 完成后 review

- 删除代码后，能否复述 Runtime1 / FrameMap / OopMap / CodeEmitInfo 四分工
- 是否讲清 `vm_result` 与 slow path
- 是否讲清 OopMap 不等于 FrameMap
- 是否完成删码测试、禁用词、链接、`file:line`、`git diff --check` 校验