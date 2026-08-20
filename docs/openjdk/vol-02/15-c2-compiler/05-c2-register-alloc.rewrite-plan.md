# 15-c2-compiler/05-c2-register-alloc 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释 C2 为什么不采用 C1 的线性扫描，而要用 Chaitin 风格图着色寄存器分配；以及 spill-split-recycle 如何在更高编译成本下换来更好的全局寄存器利用率

## 1. 选题判断

现稿已有足量事实：
- `Register_Allocate`
- `PhaseLive` / `build_ifg_virtual` / `build_ifg_physical`
- LRG 的 `_cost/_area/_copy_bias`
- `Simplify`
- aggressive / conservative coalesce
- `Select`
- `Split` 与 `_trip_cnt` 循环

但结构仍偏“算法清单”。真正应该打穿的困惑更集中：

**C1 已经能用 LinearScan 很快把值放进寄存器了，C2 为什么还愿意付出更高的编译时间，去建干涉图、做 simplify/select、反复 spill-split-recycle？也就是说，前面那些全局图优化到底把值关系做复杂到了什么程度，逼得后端必须再引入一套全局图着色分配？**

这才是本篇最该回答的问题。

## 2. 一句话顿悟

**C2 不用 LinearScan，不是因为“图着色更高级”这么抽象，而是因为它前面已经把程序做成了更全局的优化结果：值跨块、跨 Phi、跨循环、跨机器节点的活跃关系更碎、更交叠，也更值得为更好的寄存器复用率多花一点编译时间。于是 C2 先把值压成 LRG，再把“同时活着”的关系编码成 IFG，用 simplify/select 着色；颜色不够就不满足于永久 spill，而是 split live range、重建 liveness/IFG、再来一轮，直到图能塞进有限寄存器。**

## 3. 总图

```text
Matcher 之后的机器节点
  │
  ├─ PhaseLive
  │    └─ 哪些值在哪些点同时活着
  │
  ├─ LRG / IFG
  │    ├─ LRG: 机器值的一组活跃关系与分配元数据
  │    └─ IFG: 同时活着 => 干涉边
  │
  ├─ simplify / coalesce / select
  │    └─ 图着色尝试给每个 LRG 找寄存器颜色
  │
  └─ spill -> split -> rebuild -> recolor
       └─ 用更高编译成本换更好的全局资源安排
```

## 4. 结构大纲与字数预算

### 第一节：开场困惑——C1 都能线性扫描，C2 为什么还要换武器

目标约 1300 字。

- 从 C1 LinearScan 对照开场
- 点出：C2 的全局优化让值关系更复杂
- 埋下主线：寄存器分配也必须从“局部顺序问题”变成“全局图问题”

### 第二节：两个朴素办法为什么都不够

目标约 1800 字。

必须推演：
1. 继续沿用 C1 的单遍 LinearScan
2. spill 后永久放栈，不再 split/recycle

结论：
- 单遍扫描更难利用 C2 已经做好的全局值关系
- 永久 spill 会把前面优化赢回来的运行时代码质量又还给内存访存

### 第三节：LRG 与 IFG——为什么先要把“同时活着”编码成图

目标约 2200 字。

- `PhaseLive`
- `build_ifg_virtual`
- 逆向扫描块
- copy 不定义新值/不干涉
- `_cost/_area/_copy_bias/score`
- IFG 是资源冲突的静态编码

### 第四节：simplify——为什么低度节点天然适合先压栈

目标约 1800 字。

- simplify 的低度引理直觉
- 候选 spill 的乐观选择
- 为什么“先删再染”适合寄存器图

### 第五节：coalesce——为什么 RA 还要顺手消 copy

目标约 1700 字。

- aggressive / conservative coalesce
- copy 不干涉的意义
- `_copy_bias`
- coalesce 既省指令，也减轻后续 split/spill 压力

### 第六节：Select——真正分颜色时在做什么

目标约 1700 字。

- 逆序弹栈
- 邻居颜色排除
- 栈槽也视为颜色块
- spill 只是阶段性失败，不是立即永久判决

### 第七节：Split —— 为什么 C2 不接受“一 spill 就长期住栈”

目标约 2300 字。

- `spill-split-recycle` 外层 while
- `Split` / `split_DEF` / `split_USE` / rematerialize（正文点到）
- rebuild liveness / IFG / coalesce / simplify / select
- `_trip_cnt` 工程上限
- 解释为什么 split 是整套算法的关键

### 第八节：为什么这仍然符合 C2 的总体哲学

目标约 1400 字。

- 前面做了全局图优化，后面值得做全局资源安排
- `cost/area/score` 的折中
- 更高编译成本换更好的机器码质量

### 第九节：误解清单与收网

目标约 1200 字。

至少回答：
1. Chaitin 是否只是“更慢但更高级”的 LinearScan
2. IFG 是否只是活跃区间的另一种表示法
3. spill 是否等于永久栈槽化
4. coalesce 是否只是可有可无的 copy 删除
5. `_trip_cnt` 上限是否说明算法没有任何收敛思路

## 5. 失败方案必须写进正文

1. 在 C2 上继续直接用 C1 的 LinearScan
2. spill 后永久住栈，不再 split/recycle
3. 不建 IFG，只按局部顺序分配

## 6. 证据清单

- `share/opto/compile.cpp:2528-2535`：`PhaseChaitin regalloc` 与 `Register_Allocate`
- `share/opto/chaitin.cpp:336-585`：`Register_Allocate` 主流程
- `share/opto/ifg.cpp:311-333`：`build_ifg_virtual`
- `share/opto/chaitin.hpp:56-67`：LRG 关键字段
- `share/opto/chaitin.cpp:99-109`：`score()` / `raw_score`
- `share/opto/chaitin.cpp:1199+`：Simplify
- `share/opto/chaitin.cpp:1447+`：Select
- `share/opto/chaitin.cpp:515-534`：spill-split-recycle while
- `share/opto/coalesce.cpp`：aggressive / conservative coalesce（正文按需补具体落点）

## 7. 必须明确的边界

- 基于 JDK 11u C2 当前寄存器分配实现
- 本篇聚焦寄存器分配，不展开 Matcher/发码细节（下一篇）
- 不把 RA 写成通用图着色教科书，而是解释 C2 的工程取舍
- 某些 verify/trace flags 仅 debug/develop 可见，release 以阶段计时和行为为主

## 8. 完成后 review

- 删除代码后，能否复述“C2 的 RA 是全局活跃关系图上的着色与拆分，不是单遍扫描”
- 是否把 LRG、IFG、simplify/select/split 收回到同一条主线
- 是否讲清了为什么 split/recycle 是整套算法的关键
- 是否完成删码测试、禁用词、file:line、链接、版本边界检查
