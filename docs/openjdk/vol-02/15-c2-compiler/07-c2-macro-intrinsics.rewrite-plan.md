# 15-c2-compiler/07-c2-macro-intrinsics 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释为什么 C2 要把 `Allocate/Lock/Unlock/ArrayCopy` 这类高层节点故意保留到优化后期，再由 `PhaseMacroExpand` 统一裁决“消失还是展开”

## 1. 核心困惑

**既然 C2 迟早都要把这些高层操作降成机器节点，为什么不在 Parse 后、甚至 Matcher 前就早点展开？为什么 `PhaseMacroExpand` 不是“统一翻译”，而是“先问能不能消，再决定怎么展开”？**

## 2. 一句话顿悟

**宏节点不是编译器偷懒没降完的节点，而是延迟决策的载体。C2 故意让它们活到优化后期：能消的零成本消失，不能消的再按当前最成熟的信息展开。**

## 3. 结构

1. 开场：为什么这些高层节点要留到最后
2. 两个误解：Parse 后就展开 / 一直留着最后统一翻译
3. `expand_macro_nodes`：最后审判
4. 分配的两条出路：先问能不能不存在，再问怎么存在
5. 锁的两条出路：锁消除与锁展开
6. 为什么 arraycopy 要先于 allocate 展开
7. 为什么前半程需要看到“高层语义”
8. MacroExpand 之后还要再跑 IGVN
9. 收网

## 4. 证据清单

- `src/hotspot/share/opto/compile.cpp:2432-2436`
- `src/hotspot/share/opto/macro.cpp:2645-2777`
- `src/hotspot/share/opto/macro.cpp:1091-1144`
- `src/hotspot/share/opto/macro.cpp:2182-2272`
- `src/hotspot/share/opto/macroArrayCopy.cpp:1106-1157`

## 5. 完成后 review

- 能否复述“先问能不能消，再问怎么展开”
- 是否讲清 allocate / lock / arraycopy 的三条命运
- 是否完成禁用词、链接、`file:line`、删码、`git diff --check` 校验