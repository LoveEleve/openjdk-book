# 13-jit-framework/02-tiered-compilation-policy 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释 TieredCompilation 为什么不是“L0→L1→L2→L3→L4 顺着爬楼梯”，而是在启动延迟、profile 成熟度、编译器负载和 CodeCache 压力之间动态折中

## 1. 选题判断

现稿事实很足，已经覆盖：
- `CompLevel` 五层定义
- `common()` 里的转移图
- `call_predicate` / `loop_predicate`
- `threshold_scale` 反馈
- `event()` / `method_invocation_event()` / `method_back_branch_event()`
- `TieredStopAtLevel`

但现稿仍偏“阈值与转移说明书”。读者可能能记住很多数值，却未必真正回答开篇那个核心问题：

**既然 C2 终点最好，为什么 HotSpot 不是简单地“够热就直接上 C2”，或者“严格按 1→2→3→4 一级级升级”？它到底在平衡什么，才让分层策略看起来像一套会绕路、会降级、会提前建 MDO、还会受队列反馈影响的动态系统？**

这才是本篇真正的读者困惑。

## 2. 一句话顿悟

**TieredThresholdPolicy 不是在安排一条固定阶梯，而是在同时优化四件互相冲突的事：尽快让热点跑上机器码、尽快但不过量地收集 profile、别让慢编译器队列堵死、别让 CodeCache 压力把系统拖垮。于是它的本质不是“方法当前在几层”，而是“此刻最划算的下一跳是什么”。**

## 3. 总图

```text
解释器/旧代码触发事件
  │
  ├─ CALL 事件：普通入口升级？
  ├─ LOOP 事件：OSR 升级？
  │
  ├─ common() 看什么？
  │    ├─ 当前层级
  │    ├─ 调用/回边计数
  │    ├─ MDO 是否成熟
  │    ├─ C2 队列负载
  │    └─ CodeCache 反馈
  │
  └─ 结果不是固定爬楼梯
       ├─ 常规：0 -> 3 -> 4
       ├─ C2 忙：0 -> 2 -> 3 -> 4
       ├─ trivial：... -> 1
       ├─ C1 失败 / 不必重 profile：0 -> 4
       └─ 回边热点优先 OSR
```

## 4. 结构大纲与字数预算

### 第一节：开场困惑——为什么不能一步到 C2，也不能老老实实一级级爬

目标约 1300 字。

- 从启动期与热身期的冲突开场
- 提出两个错误直觉：直接上 C2 / 固定 1→2→3→4
- 埋下四个冲突目标：启动延迟、profile 成熟度、编译队列负载、CodeCache 压力

### 第二节：两个朴素策略为什么都不行

目标约 1800 字。

必须推演：
1. 所有热点直接上 C2
2. 所有方法一律顺序经过 1/2/3/4

结论：
- 直接上 C2 启动太慢、profile 还不成熟
- 固定爬楼梯会让 trivial 方法、队列压力、OSR 场景全都被不必要地拖慢

### 第三节：五层含义——为什么 1 不是“第一级台阶”而是特例终点

目标约 1700 字。

- `CompLevel` 枚举
- 讲清 0/1/2/3/4 的真实含义
- 重点纠正：常规路径不是 0→1→2→3→4
- `is_trivial()` 的特殊意义

### 第四节：`common()` 才是策略核心——下一跳不是固定的，而是动态计算的

目标约 2200 字。

- 解释 `common()` 的状态图注释
- 0→3→4、0→2→3→4、0→(3→2)→4、0→3→1、0→4
- 说明 `common()` 真正在权衡什么

### 第五节：阈值不是一个数，而是“两档计数 + 负载缩放”

目标约 2000 字。

- `call_predicate_helper` / `loop_predicate_helper`
- invocation / backedge / mixed threshold
- `threshold_scale`
- `CompileThresholdScaling`、队列反馈、CodeCache 反馈
- 让读者明白：阈值是会随系统状态变的

### 第六节：为什么 level 2 存在——它是“排队减速带”而不是过渡装饰

目标约 1500 字。

- `common()` 注释里的 30% 慢说明
- C2 队列忙时先上 limited profile
- Profile 不够成熟时留在 2 或解释器
- 让读者真正记住 2 的存在意义

### 第七节：事件分流——调用热点与循环热点为什么走两条路

目标约 2100 字。

- `event()` 分 CALL / LOOP
- `method_invocation_event()`：提前建 MDO、普通入口编译
- `method_back_branch_event()`：OSR 编译、顺便检查普通入口升级
- 解释“先 OSR 再普通编译”为什么是正常现象

### 第八节：MDO 什么时候提前建——profile 不是总要等 C1 到场

目标约 1400 字。

- `should_create_mdo()`
- `create_mdo()`
- Tier0ProfilingStartPercentage
- 讲清“解释器里先开 profile”是为了缩短等 C1 的时间

### 第九节：`TieredStopAtLevel`——为什么它不是“只剩前 N 级”，而是砍掉整套后续策略

目标约 1200 字。

- `MIN2(next_level, TieredStopAtLevel)`
- 1/3/4 三种常见调试用途
- 说明 stop level 改的是“可用终点集”

### 第十节：误解清单与收网

目标约 1200 字。

至少回答：
1. 分层是不是固定 0→1→2→3→4
2. level 1 是否是所有方法的第一站
3. C2 队列负载是否只影响排队，不影响升级层级
4. profile 是否一定要等 C1 full-profile 代码到场才开始收集
5. OSR 与普通编译是否各管各的、互不影响

## 5. 失败方案必须写进正文

1. 所有热点直接上 C2
2. 所有方法严格顺序经过 1/2/3/4
3. profile 只能等 level 3 代码到场后再收集

## 6. 证据清单

- `share/runtime/compilerDefinitions.hpp:54-63`：`CompLevel` 枚举（现稿已有引用）
- `share/runtime/tieredThresholdPolicy.hpp:169-208`：策略核心组件
- `share/runtime/tieredThresholdPolicy.cpp:44-80`：call/loop predicate helper
- `share/runtime/tieredThresholdPolicy.cpp:82-89`：`is_trivial`
- `share/runtime/tieredThresholdPolicy.cpp:558-574`：`threshold_scale`
- `share/runtime/tieredThresholdPolicy.cpp:639-648`：`should_create_mdo`
- `share/runtime/tieredThresholdPolicy.cpp:676-815`：状态图注释 + `common()`
- `share/runtime/tieredThresholdPolicy.cpp:819-841`：`call_event`
- `share/runtime/tieredThresholdPolicy.cpp:371-404`：`event()`
- `share/runtime/tieredThresholdPolicy.cpp:884-899`：`method_invocation_event`
- `share/runtime/tieredThresholdPolicy.cpp:903-963`：`method_back_branch_event`
- `share/runtime/tieredThresholdPolicy.cpp:408-439`：`compile()` 的回退/降级路径

## 7. 必须明确的边界

- 基于 JDK 11u tiered policy 当前实现，不外推到新版本不同策略
- 本篇聚焦策略决策，不深入 C1/C2 内部管线
- JVMCI/AOT 只在必要处点到，不展开
- 数值阈值以当前默认 flag 为例，但要强调它们会被 scaling 与反馈调整

## 8. 完成后 review

- 删除代码后，能否复述“分层策略不是爬楼梯，而是在动态选下一跳”
- 是否把层级、阈值、负载反馈、OSR、MDO 提前创建收成一条主线
- 是否明确区分了：编译层级、profile 成熟度、队列压力、CodeCache 压力各自扮演什么角色
- 是否完成删码测试、禁用词、file:line、链接、版本边界检查
