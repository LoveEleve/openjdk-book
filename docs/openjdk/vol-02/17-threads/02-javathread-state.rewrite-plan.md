# 17-threads/02-javathread-state 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释 JavaThread 如何通过 `_thread_state` 与轮询机制告诉 JVM“我现在在哪、能不能 safepoint”，以及线程退出为什么还要再多一层终止协议

## 1. 核心困惑

**GC 停世界前为什么一定要先问每个线程“你现在在哪”？`_thread_state` 为什么不是普通的五态枚举，而要额外多出一套 trans 状态？jdk11u 默认为什么不再靠全局轮询页 `mprotect`，而改成线程本地轮询位？线程退出为什么还不能直接 `delete this`？**

## 2. 一句话顿悟

**JavaThread 状态机的核心不是“标记线程在干什么”，而是“给 safepoint 一个可证明的协作协议”：真状态回答“我现在在哪”，trans 状态回答“我正在从 X 走向 Y”；每次进出 VM 的状态转换都顺手做一次 safepoint 检查；jdk11u 默认用线程本地轮询位代替全局页保护；线程退出则通过 `_terminated` 四态把“已经离开业务代码”与“还不能立刻回收对象身份”分开。**

## 3. 结构

1. 开场：停世界前先问每个线程“你在哪”
2. 两个误解：状态机只是调试枚举 / jdk11u 仍是全局轮询页
3. JavaThreadState：五个真身，两种过渡
4. trans 三拍：先写 from+1，再序列化，再 block_if_requested
5. 线程本地轮询：位测试而不是页故障
6. 终止协议：`_terminated` 四态
7. 收网

## 4. 证据清单

- `src/hotspot/share/utilities/globalDefinitions.hpp:888-905`
- `src/hotspot/share/runtime/thread.hpp:1038-1040`
- `src/hotspot/share/runtime/thread.inline.hpp:146-150`
- `src/hotspot/share/runtime/interfaceSupport.inline.hpp:82-97`
- `src/hotspot/share/runtime/interfaceSupport.inline.hpp:112-148`
- `src/hotspot/share/runtime/safepointMechanism.hpp:34-46`
- `src/hotspot/share/runtime/safepointMechanism.inline.hpp:32-70`
- `src/hotspot/cpu/x86/macroAssembler_x86.cpp:3744-3756`
- `src/hotspot/share/runtime/thread.hpp:1044-1058`
- `src/hotspot/share/runtime/thread.cpp:1902-2101`
- `src/hotspot/share/runtime/thread.cpp:208-213`

## 5. 完成后 review

- 能否复述“真状态 + trans 状态 + 检查点嵌在转换里”
- 是否讲清线程本地轮询与旧全局页机制差异
- 是否讲清 `_terminated` 四态不是简单 alive/dead
- 是否完成禁用词、链接、`file:line`、删码、`git diff --check` 校验