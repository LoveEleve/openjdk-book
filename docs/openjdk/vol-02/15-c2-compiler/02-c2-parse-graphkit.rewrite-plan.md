# 15-c2-compiler/02-c2-parse-graphkit 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释 C2 前端如何把字节码一步步灌进 Ideal Graph——`Parse` 如何像抽象解释器一样推进 JVMState，`GraphKit` 如何把控制、内存、异常和 safepoint 状态织进图里

## 1. 核心困惑

**为什么 Parse 既像解释器、又像图构造器？GraphKit 又为什么必须维护一整份 JVMState map，而不是像普通 builder 一样只管 new 节点连边？**

## 2. 一句话顿悟

**C2 前端不是“顺序读字节码然后随手建图”，而是像解释器一样一步步推进抽象执行状态；区别只是，解释器推进的是具体值，Parse 推进的是由节点组成的 JVMState，而 GraphKit 负责把这份状态编进图里。**

## 3. 结构

1. 开场：Ideal Graph 到底怎么长出来
2. 两个误解：顺序 new 节点 / GraphKit 只是语法糖
3. Parse 按基本块驱动，不是线性扫字节码
4. `do_one_block` / `do_one_bytecode`
5. 内联是建图方式的一部分
6. GraphKit 维护 JVMState map
7. MergeMem：内存流也切片挂图
8. safepoint / 异常边必须 Parse 期接进图
9. OSR 证明 Parse 维护的是状态
10. 收网

## 4. 证据清单

- `src/hotspot/share/opto/parse1.cpp:425-427`
- `src/hotspot/share/opto/parse1.cpp:549-603`
- `src/hotspot/share/opto/parse1.cpp:631-712`
- `src/hotspot/share/opto/parse1.cpp:1489-1534`
- `src/hotspot/share/opto/parse2.cpp:1449-1602`
- `src/hotspot/share/opto/parse2.cpp:2014-2021`
- `src/hotspot/share/opto/parse2.cpp:2250-2252`
- `src/hotspot/share/opto/doCall.cpp:423-555`
- `src/hotspot/share/opto/callGenerator.cpp:84-110`
- `src/hotspot/share/opto/callnode.hpp:215-296`
- `src/hotspot/share/opto/graphKit.cpp:1477-1571`
- `src/hotspot/share/opto/parse1.cpp:2234-2300`
- `src/hotspot/share/opto/parse1.cpp:505-574`
- `src/hotspot/share/oops/method.cpp:1268-1282`
- `src/hotspot/share/classfile/classFileParser.cpp:2172-2185`

## 5. 完成后 review

- 能否复述 Parse 像解释器一样推进 JVMState
- 是否讲清 GraphKit 持有的是附着在 SafePointNode 上的 map
- 是否讲清内联是建图方式的一部分
- 是否完成禁用词、链接、`file:line`、删码、`git diff --check` 校验