# 15-c2-compiler/06-c2-codegen 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释为什么理想图和寄存器分配结果仍然不能直接发码，以及 `Matcher + GCM + Output` 如何把平台规则、成本、调度和编码真正压进机器码

## 1. 选题判断

现稿已经覆盖大量关键事实：
- .ad / adlc / instruct 规则
- `Matcher::match` / `match_tree` / `ReduceInst`
- GCM 与 block frequency
- `Compile::Output`
- x86 peephole 实际为空

但主线仍偏“ADL / Matcher / GCM / Output”四段式说明书。真正该打穿的读者困惑要更集中：

**Ideal Graph 已经优化完了，寄存器也已经分好，为什么 C2 还不能直接发码？平台差异、寻址模式折叠、调度与重定位信息到底还缺什么，才逼得它必须再接一层 `Matcher + Output` 的机器节点世界？**

这才是本篇应回答的核心问题。

## 2. 一句话顿悟

**C2 在寄存器分配之前和之后都还缺一层“平台语义降级”：Ideal Graph 表达的是平台无关运算关系，寄存器分配表达的是谁占哪个资源，但两者都还没回答“x86 上这一团子图最便宜该变成哪条指令、哪些 load 能折进使用者、哪些分支该怎样布局、哪些重定位和 prolog/epilog 必须同时生成”。Matcher 用 .ad 规则把理想节点归约成 MachNode，GCM 再按频率和依赖安排顺序，Output 最后把这些机器节点真正落成 CodeBuffer 里的字节。**

## 3. 总图

```text
Ideal Graph（平台无关）
  │
  ├─ Matcher
  │    ├─ .ad 规则 / ins_cost / ins_encode
  │    ├─ label + reduce
  │    └─ Ideal subtree -> MachNode
  │
  ├─ GCM / BlockLayout
  │    └─ 频率、支配、布局、指令顺序
  │
  └─ Output
       ├─ prolog / epilog
       ├─ BuildOopMaps
       ├─ emit 到 CodeBuffer
       └─ nmethod 安装前的最后落地
```

## 4. 结构大纲与字数预算

### 第一节：开场困惑——理想图和寄存器都准备好了，为什么还不能直接发码

目标约 1300 字。

- 从上一章寄存器分配完成接过来
- 提出问题：节点语义 != 平台指令语义
- 引出平台差异、寻址折叠、调度、重定位四类缺口

### 第二节：两个朴素理解为什么都不对

目标约 1800 字。

必须推演：
1. 理想节点已经够接近机器，可以直接 emit
2. Matcher 只是最后做个“节点名翻译”

结论：
- Ideal Graph 没有回答平台模式选择与成本取舍
- Matcher 的实质是“标注 + 最小成本归约”，不是字符串翻译

### 第三节：.ad / ADL——为什么平台适配不是 scattered if/else，而是一套规则语言

目标约 2000 字。

- `instruct` 的 match/effect/opcode/ins_encode/ins_pipe/ins_cost
- adlc 生成 matcher DFA
- 为什么成本、编码、调度信息必须放在同一规则里

### 第四节：Matcher——为什么理想图要先被“压扁”为 MachNode 世界

目标约 2200 字。

- `Matcher::match`
- `find_shared`
- `xform`
- `match_tree`
- 最小成本规则选择
- `ReduceInst`
- load-fold into use 的意义

### 第五节：GCM 与 block layout——为什么指令顺序仍然是一个独立问题

目标约 1700 字。

- `do_global_code_motion`
- dominator tree
- block frequency
- uncommon trap 低频化
- schedule 早/晚放置
- block layout 的角色

### 第六节：Output——为什么发码不是“for each MachNode emit”这么简单

目标约 1900 字。

- `Compile::Output`
- prolog/UEP/epilog
- init buffer / schedule and bundle / BuildOopMaps / fill_buffer
- 解释 CodeBuffer、重定位、oop maps 在这里真正落地

### 第七节：peephole 空实现说明了什么

目标约 1200 字。

- `MachNode::peephole` 默认 `NULL`
- 说明 x86 上 C2 的主要优化不靠后端 peephole 打补丁
- 重点仍在 matcher 规则、图优化和前置调度

### 第八节：把四件事收回到同一个主线——平台语义降级

目标约 1300 字。

- .ad 提供平台规则
- Matcher 负责模式选择
- GCM 负责顺序与频率
- Output 负责真正落字节
- 解释为什么这不是“最后一层薄皮”而是完整平台化阶段

### 第九节：误解清单与收网

目标约 1200 字。

至少回答：
1. Matcher 是否只是节点名翻译
2. 理想图优化完后是否已经具备发码信息
3. GCM 是否只是美化块顺序
4. BuildOopMaps 是否属于 Matcher
5. peephole 是否是 C2 x86 后端的主要优化点

## 5. 失败方案必须写进正文

1. 优化完理想图就可以直接 emit 机器码
2. Matcher 只是最后做个简单 opcode 映射
3. 调度和块布局只是可有可无的后处理

## 6. 证据清单

- `share/opto/matcher.cpp:176-365`：`Matcher::match`
- `share/opto/matcher.cpp:1359-1429`：`match_tree`
- `share/opto/matcher.cpp:1653+`：`ReduceInst`（正文按需补）
- `share/opto/gcm.cpp:1612-1691`：`do_global_code_motion` / `estimate_block_frequency`
- `share/opto/output.cpp:57-157`：`Compile::Output`
- `share/opto/machnode.cpp:415-417`：peephole 空实现
- 现稿中的 x86.ad / x86_64.ad 规则引用继续沿用

## 7. 必须明确的边界

- 基于 JDK 11u C2 + x86_64
- 本篇聚焦平台化与发码管线，不展开下篇 `PhaseMacroExpand` 细节
- .ad 规则的 build-time 生成边界要明确：adlc 产物不在源码树
- PrintOptoAssembly / peephole 等 debug/develop/release 可见性边界要点明

## 8. 完成后 review

- 删除代码后，能否复述“Matcher/GCM/Output 解决的是平台语义降级，而不是简单翻译节点”
- 是否把 ADL、Matcher、调度、Output 收回到同一个问题上
- 是否清楚区分了：理想图语义、机器节点语义、最终字节布局 三个层次
- 是否完成删码测试、禁用词、file:line、链接、版本边界检查
