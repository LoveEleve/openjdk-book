# 22-deoptimization/01-deopt-decision 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释编译代码为什么会在某个点突然“承认自己跑不下去”，以及 HotSpot 如何把“为什么回退”和“回退后怎么办”拆成编译期预设 + 运行时 trap 历史调节的两层决策系统

## 1. 选题判断

现稿已有较强事实基础：
- `DeoptReason` / `DeoptAction`
- `trap_request` 位域编码
- `GraphKit::uncommon_trap`
- `uncommon_trap_inner`
- `query_update_method_data`
- `trap_state_reason/add_reason`
- `PerBytecodeTrapLimit` / `per_method_trap_limit`

但当前正文更像“枚举 + 位域 + MDO”堆叠。真正该打穿的读者困惑更集中：

**JIT 代码在运行时为什么不是简单地“遇到问题就 deopt 回解释器”，而要区分这么多 reason、action、per-bci/per-method 历史、trap_request 位域和阈值？到底是谁决定‘这次只回解释器看看’、‘这次立刻 make_not_entrant’、‘这次永远别再编了’——编译器还是运行时？**

这才是本篇最该回答的问题。

## 2. 一句话顿悟

**Deopt 决策不是运行时现想现算的一张静态查表，而是两层协议：编译器在每个假设点预先写下“如果这里出事，默认该采取什么 action”，运行时再结合该方法/该字节码位置过去已经出过几次事、是否已经重编过、是否触发全方法上限，决定是否升级动作。也就是说，Reason 解释‘为什么这次出事’，Action 解释‘先怎么处理’，MDO trap 历史则负责‘别在同一个坑里无限重编死循环’。**

## 3. 总图

```text
编译期
  GraphKit::uncommon_trap(reason, action, ...)
    └─ 把默认 action 编进 trap_request

运行时触发
  uncommon_trap(trap_request)
    ├─ 解包 reason / action / debug_id
    ├─ uncommon_trap_inner
    └─ query_update_method_data
         ├─ per-bci trap_state
         └─ per-method trap_hist counters

最终动作
  ├─ Action_none               -> 只解释执行
  ├─ Action_maybe_recompile    -> 先留旧代码，可能重编
  ├─ Action_reinterpret        -> make_not_entrant + reprofile
  ├─ Action_make_not_entrant   -> 立刻退场等待重编
  └─ Action_make_not_compilable-> 永久放弃该编译级别
```

## 4. 结构大纲与字数预算

### 第一节：开场困惑——为什么“回退”不是一个单一按钮

目标约 1200 字。

- 从一次类型切换或 trap 日志切入
- 点出：不是所有 deopt 都同样严重，也不是每次都该立刻杀掉 nmethod
- 埋主线：决策系统在回答两个问题——为什么出事、接下来怎么办

### 第二节：两个朴素理解为什么都不对

目标约 1800 字。

必须推演：
1. 运行时根据 reason 现查一张固定 reason→action 表
2. 只要某点 deopt 过一次，就应该立刻永久放弃编译

结论：
- action 很多时候是编译期先写死的默认意图
- 运行时更像在用 trap 历史对默认动作加“防抖/止损”

### 第三节：Reason 与 Action——为什么 HotSpot 要把“原因”和“处置”拆开

目标约 2200 字。

- `DeoptReason` 的 per-bytecode / per-method 分层
- `DeoptAction` 五类策略
- 说明二者不是一一映射表，而是正交维度
- 路标：Reason 讲“为什么出事”，Action 讲“先怎么办”

### 第四节：trap_request——为什么一次回退要压成一个整型协议字

目标约 1800 字。

- `_action_bits/_reason_bits/_debug_id_bits`
- `make_trap_request`
- `trap_request_reason/action/debug_id/index`
- 说明 `trap_request` 和 `trap_state` 不是同一件事

### 第五节：编译器预设——为什么默认 action 来自 `GraphKit::uncommon_trap`

目标约 1800 字。

- `GraphKit::uncommon_trap(reason, action, ... )`
- 编译器在不同假设点如何选 action
- 强调运行时不是从零决定动作，而是在消费编译期写好的意图

### 第六节：运行时调节——为什么 `uncommon_trap_inner` 还要加 trap 历史的 hysteresis

目标约 2400 字。

- `Flush the nmethod if necessary and desirable` 那段设计注释
- `Action_maybe_recompile` / `reinterpret` / `make_not_entrant` / `make_not_compilable`
- 三种防死循环措施
- `PerBytecodeTrapLimit` / `per_method_trap_limit`
- 说明运行时是在给编译器默认 action 加“升级和止损”

### 第七节：MDO 里的账——per-bci trap_state 与 per-method trap_hist 为什么要并存

目标约 2200 字。

- `query_update_method_data`
- `trap_state_reason/has_reason/add_reason`
- `Reason_many` 与 `DS_RECOMPILE_BIT`
- `MethodData::_trap_hist`
- 解释 per-bci 粗粒度格与 per-method 计数数组的分工

### 第八节：误解澄清与收网

目标约 1300 字。

至少回答：
1. action 是否由运行时现查 reason 表得到
2. trap_request 与 trap_state 是否同一编码
3. `Action_none` 是否也会更新 trap 历史并失效代码
4. `PerBytecodeTrapLimit` 是否就是一个精确计数器阈值
5. `Reason_many` 是否是一个真实 trap 原因来源

## 5. 失败方案必须写进正文

1. 把 reason 和 action 理解成一张固定映射表
2. 把 `trap_request` 和 MDO `trap_state` 混成同一个编码层
3. 认为任意 deopt 一发生就应立刻永久放弃该方法编译

## 6. 证据清单

- `src/hotspot/share/runtime/deoptimization.hpp:42`：`DeoptReason`
- `src/hotspot/share/runtime/deoptimization.hpp:108`：`DeoptAction`
- `src/hotspot/share/runtime/deoptimization.hpp:117`：位域宽度
- `src/hotspot/share/runtime/deoptimization.hpp:303`：`trap_request_reason/action/debug_id/index`
- `src/hotspot/share/runtime/deoptimization.hpp:334`：`make_trap_request`
- `src/hotspot/share/runtime/deoptimization.hpp:356`：`trap_state_*` 接口说明
- `src/hotspot/share/runtime/deoptimization.hpp:408`：`per_method_trap_limit`
- `src/hotspot/share/opto/graphKit.hpp:733`：`GraphKit::uncommon_trap(reason, action, ...)`
- `src/hotspot/share/runtime/deoptimization.cpp:1745`：防死循环设计注释
- `src/hotspot/share/runtime/deoptimization.cpp:1793`：`Action_*` switch
- `src/hotspot/share/runtime/deoptimization.cpp:1857`：`query_update_method_data`
- `src/hotspot/share/runtime/deoptimization.cpp:1875`：`PerBytecodeTrapLimit`
- `src/hotspot/share/runtime/deoptimization.cpp:1907`：per-method trap limit
- `src/hotspot/share/runtime/deoptimization.cpp:1989`：`query_update_method_data`
- `src/hotspot/share/runtime/deoptimization.cpp:2114`：`DS_RECOMPILE_BIT`
- `src/hotspot/share/runtime/deoptimization.cpp:2118`：`trap_state_reason`
- `src/hotspot/share/runtime/deoptimization.cpp:2149`：`trap_state_add_reason`
- `src/hotspot/share/oops/methodData.hpp:1984`：`_trap_hist`
- `src/hotspot/share/runtime/globals.hpp:1788`：`PerBytecodeTrapLimit`

## 7. 必须明确的边界

- 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
- 本篇只讲“是否回退、怎么选 action”的决策半边，不展开 unpack 帧重建细节
- 依赖失效入口已在 16-05 讲过，这里只在必要处回接，不重讲整条收尸链
- JVMCI 特例只点边界，不展开
- 下一篇若讲 unpack，应自然承接“决策已定，怎么执行退回”

## 8. 完成后 review

- 删除代码后，能否复述“编译器预设 action，运行时再用 trap 历史防抖和止损”
- 是否清楚区分 reason、action、trap_request、trap_state 四层
- 是否讲清 `Action_none` 与 `Action_make_not_entrant` 的边界
- 是否说明 per-bci 与 per-method 两套记账为什么要并存
- 是否完成删码测试、禁用词、链接、`file:line`、`git diff --check` 校验
