# 12-ci/02-ci-typeflow-escape 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释 `ci` 镜像层已经给了编译器“对象视图”之后，为什么编译器仍然缺两张关键地图——每个程序点的类型地图，以及对象去向地图——并说明 `ciTypeFlow` 与 `BCEscapeAnalyzer` 如何用字节码级保守推导补上这两张地图

## 1. 选题判断

现稿素材完整，已经覆盖：
- `ciTypeFlow` 的 StateVector / meet / worklist / fixpoint / trap / exception edge / OSR
- `BCEscapeAnalyzer` 的乐观初始化、保守降级、位图状态、递归/规模限制
- C2 `escape.cpp` 如何消费 bcea 结果

但现稿主线更像“两台分析器说明书并列”，没有把它们都收回到一个共同困惑上。

真正的读者问题是：

**上一篇的 `ciObject` 只解决了“编译器怎么看见类和方法对象”，可编译器真正做字节码级优化时，仍然缺什么信息，才逼得它必须在字节码层把方法自己“再跑一遍”？**

也就是：
- 它为什么还需要“每个程序点的类型地图”？
- 它为什么还需要“对象会不会逃出方法”的去向地图？
- 这些信息为什么不能只靠 profile、只靠 verifier、或只靠 `ciMethod/ciField` 里的快照获得？

## 2. 一句话顿悟

**`ci` 镜像层给编译器的是“对象与元数据视图”，不是“执行到某个 bci 时程序状态会是什么”的答案。`ciTypeFlow` 和 `BCEscapeAnalyzer` 干的事，就是在不真的执行方法的前提下，用保守的字节码抽象解释再跑一遍方法体：前者算出每个程序点的类型状态，后者估计参数和新对象的去向。两者都不追求最精确，只追求对优化足够有用、对错误绝不冒险。**

## 3. 总图

```text
ci 镜像层
  └─ 解决：编译器如何安全持有类/方法/字段对象

但编译还缺两张地图
  ├─ 程序点类型地图：当前 locals/stack 里“是什么”
  └─ 对象去向地图：新对象/参数“会去哪”

ciTypeFlow
  ├─ StateVector 表示某个程序点的抽象状态
  ├─ 逐字节码模拟栈效果
  ├─ 控制流汇合时做 meet
  └─ worklist 迭代到 fixpoint

BCEscapeAnalyzer
  ├─ 用位图追踪参数/新分配对象身份
  ├─ 乐观起步：假设不逃逸
  ├─ 遇到写字段/调用/未知路径就降级
  └─ 结果喂给 ConnectionGraph / scalar replacement
```

## 4. 结构大纲与字数预算

### 第一节：开场困惑——为什么有了 `ciMethod` 还不够

目标约 1300 字。

- 用 `PrintInlining` / 类型 profile 现象开场
- 点破：类、方法、字段都看见了，不等于“知道某个 bci 上栈里是什么”
- 引出两张缺失地图：类型地图、对象去向地图

### 第二节：三个朴素办法为什么都不够

目标约 2000 字。

必须推演：
1. 只靠运行时 profile
2. 只靠 verifier/类元数据快照
3. 真执行一遍方法拿精确状态

结论：
- profile 覆盖面不够，没跑热的方法也要编译
- verifier 只负责合法性，不负责给优化提供足够细粒度的程序点状态
- 真执行一遍方法既不现实，也失去静态分析价值

### 第三节：`ciTypeFlow` 的本质——在字节码层搭一台“抽象 JVM”

目标约 1700 字。

- `ciTypeFlow` 输入：`ciMethod` + `ciMethodBlocks` + 可选 OSR bci
- `StateVector` 是“某个程序点的抽象 frame”
- locals + stack 共用数组
- 类型格（top/bottom/null/long2/double2）

### 第四节：为什么控制流一汇合，就必须做 meet

目标约 1900 字。

- `type_meet_internal` 规则
- top / bottom / null / primitive / Object / interface / array / LCA
- 精度下降但安全上升
- 与 verifier 同源但目标不同：这里是为优化服务的程序点类型收敛

### 第五节：为什么必须反复迭代到 fixpoint

目标约 1900 字。

- `get_start_state`
- `flow_block`
- 异常边与 `meet_exception`
- `flow_successors`
- worklist 到 fixed point
- loop clone / OSR 的特殊处理

### 第六节：`trap` 是什么——分析不是证明“这条路一定通”，而是发现“不敢继续信”

目标约 1300 字。

- unresolved klass / aaload / checkcast 等场景
- trap 记录 + bail out
- 分析结果宁可保守退出，也不产出错误状态

### 第七节：`BCEscapeAnalyzer` 的本质——不是对象图分析，而是“参数/新对象去向估算器”

目标约 2100 字。

- 类注释：fast + conservative + bytecode level
- 位图状态 `_arg_local/_arg_stack/_arg_returned/...`
- 为什么它不依赖 `ciTypeFlow`
- 乐观初始化：先假设不逃逸

### 第八节：为什么逃逸分析必须靠“降级”活着

目标约 2200 字。

- 抽象/native/未初始化/递归/超规模直接保守
- `putfield`/`putstatic`/数组读写/调用点如何降级
- 单形态 vs 多形态调用
- `_conservative` 的意义

### 第九节：这些结果最终怎么兑现成优化

目标约 1600 字。

- bcea 结果不是最终 EA 结论
- C2 `ConnectionGraph` 读取 `meth->get_bcea()`
- `is_return_allocated` / `is_arg_returned` / arg escape 如何影响对象节点与 scalar replacement
- 把“字节码级保守估计”与“IR 级全局逃逸分析”区分开

### 第十节：误解清单与收网

目标约 1200 字。

至少回答：
1. `ciTypeFlow` 是否等于 verifier
2. `ciTypeFlow` 是否在执行方法
3. bcea 是否等于 C2 最终逃逸分析
4. profile 是否可以完全替代类型流
5. 为什么这些分析宁可退化也不能猜

## 5. 失败方案必须写进正文

1. 只靠 profile 给出所有程序点类型信息
2. 只靠 verifier / `ciMethod` 快照就够了
3. 真执行一遍方法来拿最精确状态
4. 逃逸分析直接做全精度对象图，不做保守降级

## 6. 证据清单

- `share/ci/ciTypeFlow.hpp:35-68`：`ciTypeFlow` 输入与 OSR 边界
- `share/ci/ciTypeFlow.hpp:158-187`：`StateVector` 与类型格
- `share/ci/ciTypeFlow.cpp:363-416`：`get_start_state`
- `share/ci/ciTypeFlow.cpp:438-533`：`meet` / `meet_exception`
- `share/ci/ciTypeFlow.cpp:272-339`：`type_meet_internal`
- `share/ci/ciTypeFlow.cpp:551-582`：`aaload` + trap 示例
- `share/ci/ciTypeFlow.cpp:2326-2426`：`flow_block`
- `share/ci/ciTypeFlow.cpp:2727-2782`：`flow_types` / worklist / fixpoint
- `share/ci/bcEscapeAnalyzer.hpp:38-40`：类注释
- `share/ci/bcEscapeAnalyzer.hpp:45-66`：状态位图
- `share/ci/bcEscapeAnalyzer.hpp:124-147`：对外判定接口
- `share/ci/bcEscapeAnalyzer.cpp:1201-1206`：不依赖 `ciTypeFlow`，自己扫块
- `share/ci/bcEscapeAnalyzer.cpp:1233-1268`：乐观初始化
- `share/ci/bcEscapeAnalyzer.cpp:1300-1324`：跳过条件与保守降级
- `share/ci/bcEscapeAnalyzer.cpp:1354-1384`：结果写回 `MethodData`
- `share/opto/escape.cpp:970-997` / `:1154-1185`：C2 消费 bcea 结果

## 7. 必须明确的边界

- 基于 JDK 11u C2 路径；`ciTypeFlow`/bcea 都在 COMPILER2 下
- 本篇聚焦字节码级保守推导，不展开 Parse 阶段 IR 生成细节
- 不把 bcea 讲成最终逃逸分析；最终对象图分析在 C2 `ConnectionGraph`
- 不把 `trap` 讲成运行时必抛异常；这里是分析与编译策略的一部分

## 8. 完成后 review

- 删除代码后，能否复述“ci 镜像解决对象视图，类型流/逃逸解决程序状态视图”
- 是否把两台分析器都收回到“编译器为什么还得自己跑一遍字节码”这个问题上
- 是否明确区分了：profile、verifier、ci 镜像、类型流、bcea、ConnectionGraph 各自负责什么
- 是否完成删码测试、禁用词、file:line、链接、版本边界检查
