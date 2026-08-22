# 15-c2-compiler/06-c2-codegen 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释 C2 从“平台无关图”走到“平台相关机器码”的最后一公里：`.ad` 规则、`Matcher`、全局代码调度、块布局和 `Compile::Output`

## 1. 核心困惑

**理想图和寄存器都已经准备好了，为什么 C2 还不能直接发码？平台差异、寻址折叠、调度和重定位信息到底还缺什么，才逼得它必须再接一层 `Matcher + Output` 的机器节点世界？**

## 2. 一句话顿悟

**Ideal Graph 表达的是平台无关的运算关系，寄存器分配表达的是谁占哪个资源，但两者都还没回答“x86 上这团子图最便宜该变成哪条指令、哪些 load 能折进使用者、哪些块该怎么摆、哪些字节与重定位信息该如何一起落地”。Matcher 用 `.ad` 规则把理想节点归约成 `MachNode`，GCM 与块布局决定指令顺序，`Output` 最后把这些机器节点真正压进 `CodeBuffer`。**

## 3. 结构

1. 开场：理想图为什么还不能直接发码
2. 两个误解：理想图已足够具体 / Matcher 只是节点名翻译器
3. `.ad` 规则系统
4. Matcher：标注 + 最小成本归约
5. GCM 与块布局
6. Output：完整方法壳落地
7. peephole 反证
8. 收网

## 4. 证据清单

- `src/hotspot/share/opto/matcher.cpp:176-345`
- `src/hotspot/share/opto/matcher.cpp:1359-1405`
- `src/hotspot/share/opto/matcher.cpp:1653-1726`
- `src/hotspot/share/opto/gcm.cpp:1612-1645`
- `src/hotspot/share/opto/output.cpp:57-156`
- `src/hotspot/share/opto/machnode.cpp:413-416`

## 5. 完成后 review

- 能否复述 `.ad` / Matcher / GCM / Output 的职责分工
- 是否讲清平台语义降级主线
- 是否完成禁用词、链接、`file:line`、删码、`git diff --check` 校验