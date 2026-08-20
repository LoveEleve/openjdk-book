# 22-deoptimization/02-unpack-frames 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释 deopt 决策做完后，HotSpot 为什么不能直接“跳回解释器继续跑”，而必须先把编译帧打包成中间表示，再拆成一串可行走的解释器帧；并讲清 `vframeArray`、`UnrollBlock`、`unpack_on_stack` 各自在补哪一种语义缺口

## 1. 选题判断

现稿已有较强事实基础：
- `fetch_unroll_info` / `fetch_unroll_info_helper`
- `vframeArray` / `vframeArrayElement`
- `create_vframeArray`
- `UnrollBlock`
- `unpack_frames` / `unpack_to_stack` / `unpack_on_stack`
- `Interpreter::layout_activation`

但当前正文还是偏“pack/unpack 两段 + 单帧四步骤”的事实卡片。真正该打穿的读者困惑更集中：

**去优化的决定已经做完了，为什么 HotSpot 不能直接把 PC 改到解释器入口继续执行？为什么必须先构造 `vframeArray`、再算 `UnrollBlock`、再在栈上铺骨架帧、再逐层填 locals/expressions/monitors？一个编译帧里被内联压扁的几层 Java 语义，到底是怎样重新长回一串解释器帧的？**

这才是本篇最该回答的问题。

## 2. 一句话顿悟

**deopt 执行的难点从来不是“跳到解释器”，而是“恢复解释器此刻本应看到的 Java 语义现场”。编译帧已经把多层 Java 调用内联、把值塞进寄存器和栈槽、甚至把对象拆成标量。HotSpot 必须先把这份压缩语义打包成 `vframeArray + UnrollBlock`，再按解释器帧布局重新铺栈并填回 locals、表达式栈和锁，最后才能把控制权安全交还给解释器。**

## 3. 总图

```text
deopt 决策已完成
  ↓
fetch_unroll_info / helper
  ├─ 找到 deoptee compiled frame
  ├─ 沿 sender 链收集 compiledVFrame
  ├─ create_vframeArray      -> 语义快照
  └─ 计算 UnrollBlock        -> 栈尺寸预算

DeoptimizationBlob 汇编
  └─ 先在栈上铺 skeletal interpreter frames

unpack_frames
  └─ vframeArray::unpack_to_stack
       ├─ 给每层 element 指定 iframe
       └─ 从最老到最年轻 unpack_on_stack
            ├─ 选 bcp/pc 续点
            ├─ layout_activation
            ├─ 恢复 monitors
            └─ 恢复 locals/expressions/mdp
```

## 4. 结构大纲与字数预算

### 第一节：开场困惑——为什么“回到解释器”不是改个 PC 就完

目标约 1200 字。

- 从 deopt 决策已完成切入
- 点出：一个编译帧可能压扁了多层 Java 调用和局部状态
- 埋主线：真正难的是恢复 Java 语义现场，而不是控制流跳转本身

### 第二节：两个朴素理解为什么都不对

目标约 1800 字。

必须推演：
1. 只要把 PC 改到解释器入口就能继续
2. 只要按当前机器栈直接临时拼几个解释器帧，不需要中间表示

结论：
- 编译帧和解释器帧的语义密度不同
- 内联层、标量替换对象、监视器和 mdp 都要求先打包再拆包

### 第三节：pack 阶段——为什么 `fetch_unroll_info` 先收集 `compiledVFrame` 链

目标约 2200 字。

- `fetch_unroll_info`
- `fetch_unroll_info_helper`
- `vframe::new_vframe` 与 inlined Java frame 链
- `NoSafepointVerifier` 的边界
- 强调：先把“有哪些 Java 帧、每层值在哪”固定下来

### 第四节：`vframeArray`——为什么要有一份 C-heap 语义快照

目标约 2200 字。

- `vframeArray` / `vframeArrayElement` 布局
- locals / expressions / monitors
- `fill_in`
- 标量替换对象的重分配和字段回填只点必要边界
- 路标：`vframeArray` 不是栈帧本身，而是恢复蓝图

### 第五节：`UnrollBlock`——为什么要先算尺寸总账，再铺解释器骨架帧

目标约 1800 字。

- `frame_sizes` / `frame_pcs`
- oldest/youngest 索引方向相反
- `Interpreter::deopt_entry` 占位 pc
- 说明先预算栈空间是为了让汇编端先铺 walkable skeleton frames

### 第六节：`unpack_on_stack`——为什么单帧恢复要分 bcp/pc、layout、锁、mdp 四步

目标约 2400 字。

- `raw_bci` / `should_reexecute` / `exec_mode`
- `deopt_entry` / `deopt_reexecute_entry` / `deopt_continue_after_entry`
- `Interpreter::layout_activation`
- `move_to` 恢复锁
- `interpreter_frame_set_bcp/mdp`
- 强调“继续执行点”与“Java 局部状态”都要恢复

### 第七节：`unpack_to_stack` 与 `cleanup_deopt_info`——为什么还要 oldest→youngest 填充与最后清场

目标约 1700 字。

- `unpack_to_stack`
- caller/callee 参数传递
- `unwind_callee_save_values`
- `cleanup_deopt_info`
- 说明 deopt 不是只建新帧，还要把旧的中间快照与线程状态收尾

### 第八节：误解澄清与收网

目标约 1300 字。

至少回答：
1. deopt 是否等于简单跳回解释器入口
2. `vframeArray` 是否等于已经在栈上的解释器帧
3. `UnrollBlock` 是否只是尺寸数组
4. `deopt_continue_after_entry` 与 `deopt_reexecute_entry` 是否只是同一入口别名
5. oldest→youngest 的 unpack 顺序是否等于骨架帧铺设顺序

## 5. 失败方案必须写进正文

1. 只改 PC，直接跳回解释器
2. 不需要中间表示，现场按机器栈临时拼解释器帧
3. 把 pack 阶段和 unpack 阶段混成一个连续动作

## 6. 证据清单

- `src/hotspot/share/runtime/deoptimization.hpp:129`：`Unpack_exception/uncommon_trap/reexecute`
- `src/hotspot/share/runtime/deoptimization.hpp:172`：`create_vframeArray`
- `src/hotspot/share/runtime/deoptimization.hpp:176`：`UnrollBlock`
- `src/hotspot/share/runtime/deoptimization.hpp:253`：`fetch_unroll_info`
- `src/hotspot/share/runtime/deoptimization.hpp:269`：`cleanup_deopt_info`
- `src/hotspot/share/runtime/vframeArray.hpp:50`：`vframeArrayElement`
- `src/hotspot/share/runtime/vframeArray.hpp:121`：`vframeArray` 布局注释
- `src/hotspot/share/runtime/deoptimization.cpp:139`：`fetch_unroll_info`
- `src/hotspot/share/runtime/deoptimization.cpp:158`：`fetch_unroll_info_helper`
- `src/hotspot/share/runtime/deoptimization.cpp:184`：收集 inlined VFrames
- `src/hotspot/share/runtime/deoptimization.cpp:305`：`NoSafepointVerifier`
- `src/hotspot/share/runtime/deoptimization.cpp:310`：`create_vframeArray`
- `src/hotspot/share/runtime/deoptimization.cpp:377`：`frame_sizes/frame_pcs`
- `src/hotspot/share/runtime/deoptimization.cpp:514`：`UnrollBlock` 创建
- `src/hotspot/share/runtime/deoptimization.cpp:540`：`cleanup_deopt_info`
- `src/hotspot/share/runtime/deoptimization.cpp:623`：`unpack_frames`
- `src/hotspot/share/runtime/vframeArray.cpp:171`：`unpack_on_stack`
- `src/hotspot/share/runtime/vframeArray.cpp:192`：`deopt_entry`
- `src/hotspot/share/runtime/vframeArray.cpp:196`：`deopt_reexecute_entry`
- `src/hotspot/share/runtime/vframeArray.cpp:199`：`deopt_continue_after_entry`
- `src/hotspot/share/runtime/vframeArray.cpp:292`：`layout_activation`
- `src/hotspot/share/runtime/vframeArray.cpp:316`：监视器 `move_to`
- `src/hotspot/share/runtime/vframeArray.cpp:567`：`unpack_to_stack`
- `src/hotspot/cpu/x86/abstractInterpreter_x86.cpp:57`：`layout_activation` 骨架帧说明

## 7. 必须明确的边界

- 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
- 本篇聚焦 unpack 执行链，不重讲 deopt 决策与 trap 历史
- 汇编 deopt blob 只讲其“铺骨架帧”角色，不深挖每条汇编
- 标量替换对象重分配只点主线，不扩成完整逃逸分析回退专题
- 若后续切到 G1，要在结尾把“VM 内部控制路径已闭环”收干净

## 8. 完成后 review

- 删除代码后，能否复述“deopt 的难点是恢复 Java 语义现场，而不是跳 PC”
- 是否清楚区分 pack（收集/预算）与 unpack（铺帧/填充）
- 是否讲清 `vframeArray` 不是栈帧而是语义快照
- 是否说明 `exec_mode` / `should_reexecute` 如何决定续点
- 是否完成删码测试、禁用词、链接、`file:line`、`git diff --check` 校验
