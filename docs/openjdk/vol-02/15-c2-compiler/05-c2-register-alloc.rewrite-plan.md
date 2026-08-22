# 15-c2-compiler/05-c2-register-alloc 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释 C2 为什么不用 LinearScan，而是用 `PhaseChaitin` 在全局干涉图上做着色、coalesce 与 spill-split-recycle

## 1. 核心困惑

**为什么 C2 愿意在寄存器分配阶段付出更高编译成本，用全局干涉图、着色、spill-split-recycle 来换更好的寄存器利用率？为什么 spill 不是“一旦落栈就永久住栈”？**

## 2. 一句话顿悟

**C2 不用 LinearScan，不是因为它嫌单遍扫描不够时髦，而是因为它前面已经把图优化到了值得认真安排资源的位置。于是它先把值压成 LRG，再把“同时活着”的关系编码成 IFG，用 simplify/select 着色；颜色不够时也不满足于永久 spill，而是 split live range、重建 liveness/IFG、再来一轮，直到全局活跃关系能塞进有限寄存器。**

## 3. 结构

1. 开场：为什么 C2 不用 LinearScan
2. 两个误解：沿用 C1 足够 / spill 了就住栈
3. LRG 与 IFG
4. `cost/area/copy_bias` 与分配代价
5. Simplify
6. coalesce
7. Select
8. split / recycle
9. 收网

## 4. 证据清单

- `src/hotspot/share/opto/ifg.cpp:311-329`
- `src/hotspot/share/opto/chaitin.cpp:336-425`
- `src/hotspot/share/opto/chaitin.cpp:517-582`
- `src/hotspot/share/opto/chaitin.cpp:1199-1273`
- `src/hotspot/share/opto/chaitin.cpp:1447-1540`
- `src/hotspot/share/opto/coalesce.cpp`
- `src/hotspot/share/opto/compile.cpp:2528`

## 5. 完成后 review

- 能否复述 IFG / simplify / select / split-recycle 主线
- 是否讲清 spill 不是终局
- 是否完成禁用词、链接、`file:line`、删码、`git diff --check` 校验