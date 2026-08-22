# 15-c2-compiler/03-c2-optimizations 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释为什么 C2 需要三套互补引擎——IGVN、CCP、Escape Analysis，以及它们如何在 `Compile::Optimize` 中交错运行：谁产出新事实，谁负责统一收敛，谁真正把分配删掉

## 1. 核心困惑

**Ideal Graph 已经有了，IGVN 也已经会做 `Ideal/Value/Identity`、类型传播和全局值编号，那后续优化为什么不能交给 IGVN 一把梭？为什么还要 CCP 和 Escape Analysis？这三者到底是并列关系，还是“两个产新事实，一个负责消化”的关系？**

## 2. 一句话顿悟

**图上存在的优化缺口不是一种：局部图形和值等价问题交给 IGVN；控制可达性与条件常量问题交给 CCP；对象去向与分配可消性交给 Escape Analysis。CCP 和 EA 更像专门负责产出新事实的引擎，而 IGVN 更像统一收敛器——每当图里冒出新常量、新死边或新别名关系，IGVN 就回来把它们沿整张图推到稳定。**

## 3. 结构

1. 开场：为什么 C2 还要三套引擎
2. 两个误解：IGVN 一把梭 / CCP 与 EA 只是再跑一遍图优化
3. IGVN 的真实地位：统一收敛器
4. CCP：从 `TOP` 出发的乐观前向传播
5. CCP 真正切掉的是不可达 region
6. Escape Analysis：对象去向不是 IGVN/CCP 能单独推出来的
7. ConnectionGraph：先构图，再传播，再筛可标量替换对象
8. EA 不是最后一刀：MacroExpand 才真正删除分配
9. 三引擎闭环与收网

## 4. 证据清单

- `src/hotspot/share/opto/compile.cpp:2308-2390`
- `src/hotspot/share/opto/phaseX.cpp:1811-1901`
- `src/hotspot/share/opto/phaseX.cpp:2043-2083`
- `src/hotspot/share/opto/escape.hpp:85-160`
- `src/hotspot/share/opto/escape.cpp:97-320`
- `src/hotspot/share/opto/macro.cpp:1091-1144`

## 5. 完成后 review

- 能否复述“CCP/EA 产新事实，IGVN 统一收敛”
- 是否讲清 CCP 的 `TOP` / 不可达 region 语义
- 是否讲清 EA 不等于立即删除分配
- 是否完成禁用词、链接、`file:line`、删码、`git diff --check` 校验