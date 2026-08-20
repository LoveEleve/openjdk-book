# 15-c2-compiler/04-c2-loops 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释为什么循环在 C2 里是独立的一套优化世界，以及一旦某段控制流被识别成 `CountedLoop`，优化对象就从“单个节点”升级为“整轮迭代的形状、边界与分期方式”

## 1. 选题判断

现稿素材已经很强：
- `is_counted_loop`
- `build_and_optimize`
- `iteration_split_impl`
- `loop_predication_impl`
- `SuperWord::transform_loop` / `SLP_extract`
- pre/main/post 循环与 strip mining 的边界

但结构仍偏“识别 / 变换 / 向量化”三段式清单。真正该打穿的困惑更集中：

**为什么循环在 C2 里不是“普通图优化多跑几次”，而是要先被识别成 `CountedLoop`，再交给 `PhaseIdealLoop` 和 `SuperWord` 这套独立世界？一旦识别成功，为什么优化目标会从“单个节点更快”突然变成“整轮迭代如何分期、去检查、对齐、打包”？**

这才是本篇最该回答的问题。

## 2. 一句话顿悟

**循环之所以单独成章，是因为 C2 一旦确认一段控制流是 `CountedLoop`，它处理的不再是若干普通节点，而是一台“按固定步长重复运行”的机器。此时真正值得优化的对象，不是某次迭代里的局部表达式，而是整轮迭代的形状：能否拆成 pre/main/post 三段、能否把逐次检查提升成入口谓词、能否展开成规则步长、能否把相邻标量操作打成向量包。**

## 3. 总图

```text
一团带回边的普通控制流
  │
  ├─ 识别：这是不是 CountedLoop？
  │    └─ 单回边 / 计数比较 / 常量 stride / 可算 trip count
  │
  ├─ PhaseIdealLoop
  │    ├─ loop tree / dominators / counted_loop
  │    ├─ peeling / unswitch / full unroll
  │    ├─ loop predication
  │    └─ pre-main-post iteration split
  │
  └─ SuperWord
       ├─ main-loop / pre-loop / 对齐前提检查
       ├─ dependence graph
       ├─ pack / combine / schedule
       └─ 向量节点等待 matcher 落地
```

## 4. 结构大纲与字数预算

### 第一节：开场困惑——为什么循环值得一整套独立世界

目标约 1300 字。

- 从普通图优化和循环优化的差别开场
- 点出：循环的核心不是“某个节点能不能化简”，而是“整轮迭代有没有规律”
- 提前埋一句：循环优化先看形状，再谈节点

### 第二节：两个朴素理解为什么都不对

目标约 1800 字。

必须推演：
1. 循环只是普通块多执行几次，IGVN/CCP/EA 足够了
2. 向量化只是把相邻几条指令并成一条

结论：
- 没有 `CountedLoop` 识别，很多循环级变换无从谈起
- 向量化建立在分期、展开、对齐、谓词化等前置条件之上

### 第三节：识别——为什么 `CountedLoop` 是所有待遇的门票

目标约 2200 字。

- `is_counted_loop`
- header 形状、entry/backedge、IfTrue/IfFalse、CmpI
- stride / limit / invariant 限制
- 说明不满足这些形状时为何只能做有限 loop opts

### 第四节：`PhaseIdealLoop`——为什么循环先要被重构成“循环树”世界

目标约 2100 字。

- `build_and_optimize`
- build_loop_tree / beautify / dominators / build_loop_early/late / counted_loop
- 它不只是一个优化 pass，而是先重建循环世界的分析器

### 第五节：`iteration_split`——为什么 C2 不直接“展开几次”，而要先分期

目标约 2200 字。

- `iteration_split_impl`
- 非计数循环：partial peel / unswitch
- 计数循环：one-iteration / empty-loop / peel / unroll / RCE / align
- 说明“分期”是优化真正的对象

### 第六节：pre / main / post 三循环——每一段分别替主循环背什么债

目标约 2000 字。

- `insert_pre_post_loops`
- pre-loop：剥皮 / 对齐 / 提前处理检查
- main-loop：干净主体、展开、可向量化
- post-loop：零头与剩余检查
- 强调比“展开 4 次”更深的一层意义

### 第七节：loop predication——为什么要把逐次检查抬成整轮入口条件

目标约 1800 字。

- `loop_predication_impl`
- counted normal loop 限制
- predicate insertion points
- `Opaque` 边界只点到为止
- 讲清“每次检查”到“一次性整轮验证”的收益

### 第八节：SuperWord——为什么向量化要消费已经整理好的 main-loop

目标约 2200 字。

- `transform_loop`
- 计数循环 / pre-loop end / main-loop 门槛
- `SLP_extract`
- construct_bb / dependence_graph / adjacent refs / combine packs / schedule
- 向量化不是最后撒糖，而是循环整形的兑现

### 第九节：strip mining、vector post loop、unroll 的边界要说清

目标约 1400 字。

- strip mining 与 pre/main/post 的区别
- vector post loop / multiversioning 是另一层补充
- 防止概念混淆

### 第十节：误解清单与收网

目标约 1200 字。

至少回答：
1. 任何循环都能得到同样一套优化吗
2. `CountedLoop` 识别失败后还剩下什么手段
3. 向量化是否只是指令并包
4. strip mining 是否等于 pre/main/post
5. 预循环和后循环是否只是“多余代码”

## 5. 失败方案必须写进正文

1. 循环只是普通图优化多跑几次
2. 向量化不依赖展开、对齐、谓词化和 pre/post 分期
3. strip mining 与 pre/main/post 是同一个概念

## 6. 证据清单

- `share/opto/loopnode.cpp:372-431`：`is_counted_loop`
- `share/opto/loopnode.cpp:3062-3281`：`build_and_optimize`
- `share/opto/loopTransform.cpp:3273-3412`：`iteration_split_impl`
- `share/opto/loopTransform.cpp:1396-1455`：`insert_pre_post_loops`
- `share/opto/loopTransform.cpp:1910-1979`：`do_unroll`
- `share/opto/loopPredicate.cpp:1329-1408`：`loop_predication_impl`
- `share/opto/superword.cpp:97-191`：`transform_loop`
- `share/opto/superword.cpp:450-539`：`SLP_extract`
- `share/opto/compile.cpp:2308-2399` / `2344-2372`：循环阶段在总管线中的位置（现稿已有）

## 7. 必须明确的边界

- 基于 JDK 11u C2 当前实现
- 本篇聚焦循环层级的结构变换与 SuperWord，不展开最终寄存器分配
- 具体 SIMD 指令选择只点到 matcher/平台映射，不深挖指令表
- 某些 tracing flag 仅 debug/develop 可见，release 以行为对照为主

## 8. 完成后 review

- 删除代码后，能否复述“循环优化的核心是先把控制流识别成 CountedLoop，再把整轮迭代当作优化对象”
- 是否把 counted loop、iteration split、predication、SuperWord 收回到同一条主线
- 是否明确区分了 pre/main/post 与 strip mining 的边界
- 是否完成删码测试、禁用词、file:line、链接、版本边界检查
