# 15-c2-compiler/04-c2-loops 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释 C2 的循环层级优化：`CountedLoop` 识别、`PhaseIdealLoop` 建模、pre/main/post 分期、loop predication 和 SuperWord 向量化

## 1. 核心困惑

**为什么循环不能只靠普通图优化多跑几遍？`CountedLoop` 为什么是所有高级待遇的门票？pre/main/post 三段循环分别在替主循环背什么债？SuperWord 为什么不是最后撒一层语法糖，而是循环整形的兑现？**

## 2. 一句话顿悟

**循环优化先看形状，再谈节点；先证明整轮迭代有规律，再决定是否值得展开、去检查和向量化。C2 先把普通回边识别成 `CountedLoop`，再交给 `PhaseIdealLoop` 建立循环树和支配关系，随后按策略分成 pre/main/post，抬检查、做展开、做对齐，最后 SuperWord 才能在规则 main-loop 上把重复标量操作打包成向量。**

## 3. 结构

1. 开场：为什么循环要单独优化
2. 两个误解：普通图优化多跑几遍足够 / 向量化只是合并四条指令
3. `CountedLoop` 门票
4. `PhaseIdealLoop` 先建立循环世界
5. `iteration_split` 与 pre/main/post
6. loop predication
7. SuperWord
8. strip mining / pre-main-post / unroll 区分
9. 收网

## 4. 证据清单

- `src/hotspot/share/opto/loopnode.cpp:372-427`
- `src/hotspot/share/opto/loopnode.cpp:3096-3229`
- `src/hotspot/share/opto/loopTransform.cpp:3273-3371`
- `src/hotspot/share/opto/loopTransform.cpp:1396-1447`
- `src/hotspot/share/opto/loopTransform.cpp:1910-1972`
- `src/hotspot/share/opto/loopPredicate.cpp:1329-1352`
- `src/hotspot/share/opto/superword.cpp:97-157`
- `src/hotspot/share/opto/superword.cpp:450-535`

## 5. 完成后 review

- 能否复述“先识别整轮规律，再谈展开/去检查/向量化”
- 是否讲清 CountedLoop 门票和 pre/main/post 三段职责
- 是否讲清 SuperWord 不是独立魔法，而是循环整形的兑现
- 是否完成禁用词、链接、`file:line`、删码、`git diff --check` 校验