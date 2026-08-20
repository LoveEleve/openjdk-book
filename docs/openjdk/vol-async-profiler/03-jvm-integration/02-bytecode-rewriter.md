# 02. 只插几条指令，为什么会牵动整套 class 文件 —— BytecodeRewriter、重定位表与失败回退

> **前置依赖**：[01 —— 从 `Agent_OnLoad` 到 JVMTI 回调](./01-agent-jvmti.md)：知道 `ClassFileLoadHook` 已经只是 JVMTI 接线板上的一个回调，notification 由 instrumentation 路径按需启停。
> → **后续**：VMStructs、JIT CodeCache 与栈行走
>
> 本篇基于当前 async-profiler 源码。重点是 instrumentation/latency 路径下的手写 class-file 改写器，不把它写成 CPU/alloc/lock/wall 通用主路径，也不把它等同于 Java ASM 框架。

## native profiler 为什么还要改 Java 字节码

场景：用户并不满足于“固定时刻打到哪条栈”，还想回答更尖锐的问题：某个方法进入之后过了多久才返回？某个调用驱动事件能不能精确挂在方法入口/出口上？这时周期采样已经不够，async-profiler 必须在类加载或重转换时，把少量观测逻辑织进目标方法的字节码里。

表面上看，需求只是“方法入口插几条指令，方法退出前再补几条指令”。但 class 文件不是一段能随手插字节的文本。只要 code array 的长度和布局发生变化，下面这些依赖 bytecode offset 的结构都会被牵动：

- jump target；
- exception table 的 start/end/handler；
- LineNumberTable；
- LocalVariableTable；
- StackMapTable；
- `max_stack` 与 `max_locals`。

因此，本篇真正要解释的不是“BytecodeRewriter 有哪些函数”，而是：**为什么只插几条指令，会把一个 native profiler 瞬间推到 class-file 级别的结构维护问题上。**

*关键设计（斜体）：* *BytecodeRewriter 的核心不是插入指令本身，而是让所有依赖旧 offset 的结构在改写后仍然一致。* [模式: 插桩动作小，结构连锁反应大]

## 先推翻四个最容易把字节码改写讲轻的直觉

### 只改 code array，别的表不用动

这是最常见的直觉错误。只要原始指令偏移发生变化，异常表、行号表、局部变量表和 StackMapTable 就不再对得上原来那套 offset。JVM 验证器和异常分派都不会替你“猜测新位置”。

### 普通插桩和 latency 插桩只是参数不同

当前实现里，普通入口插桩与 latency 插桩共用同一个大框架，但插入内容、局部变量需求、return 处理和跳转修复规模都不同。它们不是“同一段代码换个常量”就能描述清楚的。

### relocation table 就是统一加一个常数

如果方法里只有入口多了三个字节，看起来似乎所有后续地址都统一后移即可。但一旦 latency 模式在每个 return 点再插入一段逻辑、遇到 tableswitch/lookupswitch、遇到窄跳转和宽跳转共存，这个模型立即破产。重定位表保存的是**每个旧 offset 到新 offset 的局部映射**，不是全局常数偏移。

### 改写失败也可以把半成品 class bytes 交给 JVM 试试

BytecodeRewriter 明确不这么做。当前实现里，只有 `rewriteClass()` 完整成功，JVMTI 分配的新 class bytes 才会交还给 JVM；失败就释放目标缓冲并记录 `METHOD_TOO_LARGE`、`BAD_FULL_FRAME`、`JUMP_OVERFLOW` 等原因。它宁可放弃改写，也不把半成品 class 丢给验证器。

## 第一层：ClassFileLoadHook 不是一开机就乱拦类，而是 Instrument 路径按需拉起

上一章已经建立过一个边界：`ClassFileLoadHook` 的 callback 在 `VM::init` 时只是注册到了 JVMTI 接线板上，但 notification 并没有一直开着。真正把这条路径拉起来的是 `Instrument::start()`。

`src/instrument.cpp:1084-1100` 的顺序是：

1. `initialize()`；
2. `setupTargetClassAndMethod(args)`，准备匹配目标；
3. 根据 no_cpu_profiling 和 interval 设置内部状态；
4. 把 `_running = true`，让后续 `ClassFileLoadHook` 真的开始工作；
5. `SetEventNotificationMode(JVMTI_ENABLE, JVMTI_EVENT_CLASS_FILE_LOAD_HOOK, NULL)`；
6. `retransformMatchedClasses(jvmti)`。

也就是说，BytecodeRewriter 并不是“所有类一加载就默认改写”。当前实现先准备目标类/方法，再开启 `ClassFileLoadHook` notification，随后通过 retransform 触发目标类进入这条改写链。停止时则反向执行 `retransformMatchedClasses()` 撤销改写，再关闭 notification（`instrument.cpp:1103-1110`）。

这个时序非常重要，因为它把“JVMTI 接线板上已经有这个回调”与“当前真的要拿它改写类”分成了两步。只有这样，采样主路径才不会被无关类加载持续拖入字节码改写。

stop 时所谓“undo transformation”也要谨慎理解：`Instrument::stop()` 通过再次调用 `retransformMatchedClasses(jvmti)` 触发目标类重新走一遍 ClassFileLoadHook，而不是从某个缓存里把旧 class bytes 原样写回。真正使改写消失的关键，是此时 `_running` 已经被设成 false，`ClassFileLoadHook()` 看到这个门槛后直接返回，不再产出新的改写字节。

而 `ClassFileLoadHook()` 自己还有两条分支（`src/instrument.cpp:1236-1255`）：

- `name == NULL` 时，并不是直接放弃，而是创建一个带 `_targets` 的 rewriter，尝试从常量池里反查匹配类名；
- `name != NULL` 时，先按类名查 `findMethodTargets()`，只有命中目标后才创建 rewriter。

所以“目标匹配”并不是只有一条路径；类名可见时优先直接匹配，类名缺失时才退回常量池线索。

## 第二层：BytecodeRewriter 真正要维护的，不只是 method code

`BytecodeRewriter` 的方法声明集中在 `src/instrument.cpp:310-322`：

- `rewriteCode()`；
- `rewriteCodeForLatency()`；
- `rewriteLineNumberTable()`；
- `rewriteLocalVariableTable()`；
- `rewriteStackMapTable()`；
- `rewriteVerificationTypeInfo()`；
- `rewriteMethod()` / `rewriteAttributes()` / `rewriteCodeAttributes()` / `rewriteClass()`。

这套方法列表本身就透露出一个事实：当前改写器的关注点不是“只改 code array”。它至少要覆盖：

```text
class 级别
  → method 级别
    → Code attribute
      → jump / exception table
      → LineNumberTable
      → LocalVariableTable
      → StackMapTable / verification type info
```

这也是为什么 async-profiler 没把字节码改写写成一两个 helper 函数。它在 C++ 里自己承担了一整套 class-file 结构一致性的责任。

## 第三层：普通插桩与 latency 插桩，为什么不是同一段逻辑

### 普通插桩：方法入口先放一记 `invokestatic`

`rewriteCode()` 位于 `src/instrument.cpp:425-504`。它先读取 `Code` attribute 的 `max_stack`、`max_locals` 和 `code_length`，再创建 `relocation_table`。

如果 `latency == NO_LATENCY`，它做的事情非常直接：

- 在方法入口写入 `invokestatic` 指向 `_recordEntry_cpool_idx`；
- 紧跟一个 `nop`，用于避免 `tableswitch`/`lookupswitch` 重新对齐问题；
- 原始 code array 其余部分保持不变；
- `relocation_table` 全部填成固定的 `EXTRA_BYTECODES_SIMPLE_ENTRY`。

这说明普通插桩的变化主要集中在**入口前缀变长**，并不需要重写每个 return 点。

### latency 插桩：入口记时间，出口再把时间取出来

一旦 `latency >= 0`，`rewriteCode()` 就转交给 `rewriteCodeForLatency()`（`instrument.cpp:474-478`）。这里的第一步不是插 `recordEntry`，而是：

```text
invokestatic nanoTime
lstore start_time_local
```

对应 `instrument.cpp:513-517`。为此它还要先解析方法签名，计算参数和非 static receiver 占用的 local slot 数，再给 start_time 预留两个 slot（`:466-474`）。

随后在扫描原始 code 时，只要遇到 return 指令，就在该 return 前插入：

- `lload start_time_local`；
- 视 latency 是否为 0 决定是否插入额外常量；
- 调 `recordExit0` 或 `recordExit`。

因此 latency 模式的真正区别在于：**插桩点从“只改入口”变成“入口 + 每个出口”配对改写。**这也是它必须引入局部变量位移、跳转修复和更复杂重定位的原因。

*关键设计（斜体）：* *普通插桩解决“方法一进来就记录”；latency 插桩解决“入口记时、出口结算”。两者共用改写框架，但结构压力完全不同。* [模式: 入口插桩 vs 入口/出口配对插桩]

## 第四层：relocation table 为什么是整篇最核心的单一事实源

### 不是统一后移，而是每个旧 offset 都要知道自己多往右挪了多少

`rewriteCode()` 在 `src/instrument.cpp:445-450` 为原始 `code_length + 1` 分配 `relocation_table`，注释明确说它保存的是“对原始字节码每个 index，在修改后字节码中的右移量”。也就是说，这张表存的不是“新 offset 本身”，而是**旧位置要往右偏移多少字节**；后续普遍通过 `old + relocation_table[old]` 求出新位置。

这张表之所以必须存在，是因为：

- latency 模式在不同 return 点插入的字节数并不总是相同；
- jumps 可能是窄跳转、宽跳转、tableswitch、lookupswitch；
- LocalVariableTable、LineNumberTable、exception table 依赖的 start/end/handler 位置都不相同；
- code array 末尾后的“第一个位置”也可能被引用。

所以不能用“全部地址统一 +3”“全部地址统一 +9”这种方式偷懒。当前实现需要一张按旧 offset 编址的偏移增量表，谁来问位置，就按同一张表回答“它往右挪了多少”。

### latency 路径的“两步”不是空泛术语

`rewriteCodeForLatency()` 在 `src/instrument.cpp:523-527` 的注释写得非常直白：

```text
First scan: fill relocation_table and rewrite code.
```

真实过程是：

1. 第一遍边扫描原始 code、边把改写后的指令写进目标缓冲，同时填充 `relocation_table`；
2. 期间把 jump 相关的旧索引信息记到 `jumps` 向量里，但这一遍并不会真正回写新的 jump offset；
3. 第二遍只针对 jumps，用 `relocation_table` 把旧 jump target 修成新 jump target（`instrument.cpp:636-669`）；
4. 再把同一张表交给异常表和各种 Code 子属性修正路径。

因此当前实现既不是“所有输出都等第二遍才写”，也不是“完全单遍就够了”。更准确地说，是：**第一遍生成新 code 与偏移增量表；第二遍只修 jump；属性修正继续复用同一张表。**

### 例子：异常表和 code length 都在吃这张表

`rewriteCode()` 在 `src/instrument.cpp:481-495` 先用 `relocation_table[code_length]` 回填新的 code length；随后 exception table 的 start_pc、end_pc、handler_pc 也都是原值加 `relocation_table[old_pc]`。

而 `rewriteCodeAttributes()` 再把这张表继续传给：

- `rewriteLineNumberTable()`（`:879`）；
- `rewriteLocalVariableTable()`（`:883`）；
- `rewriteStackMapTable()`（`:886-887`）。

到这里可以先收一下主线：BytecodeRewriter 真正多出来的，不是“更多 if/else”，而是三件必须同时成立的事——记录每个旧位置向右偏了多少、专门修 jump、再让所有属性表共享同一张偏移增量表。

这正是所谓“单一事实源”：不是因为它优雅，而是因为 class 文件里每个 offset 相关结构都必须对同一套新旧映射达成一致。

*关键设计（斜体）：* *relocation table 不是实现小技巧，而是整套 class-file 修正链共享的位置真相。* [模式: 单一事实源 + 多消费者修正]

## 第五层：StackMapTable 为什么最容易把改写推向失败

前面的 exception table、LineNumberTable、LocalVariableTable 至少还是“旧 offset → 新 offset”的直观修正。StackMapTable 更麻烦，因为它同时描述了：

- 当前 frame 的 offset delta；
- 局部变量的数量与类型；
- 栈上的 verification type info；
- 某些 frame 结构是否还能用当前实现支持的方式重写。

`rewriteStackMapTable()` 与 `rewriteVerificationTypeInfo()` 位于 `src/instrument.cpp:715-815`、`:818-825`。只要 offset 移动、新增 local slot 或某种 full_frame 结构不被当前实现支持，就可能返回 `BAD_FULL_FRAME`。其中当前实现最明确拒绝的一种情况是：latency profiling 需要把新的 `long` 局部变量插进 full_frame，但扫描原 locals 后，字节槽位计数没能精确走到 `new_local_index`（`instrument.cpp:781-797`）。这不是“细节修不好顶多行号不准”，而是字节码验证层面的结构性失败。

因此当前实现选择得很保守：一旦遇到自己无法安全改写的 StackMap frame，就直接停止，宁可放弃这次 instrumentation，也不把可能过不了验证的 class bytes 交给 JVM。

## 第六层：失败时怎样回退，为什么 JVM 看不到半成品 class bytes

`BytecodeRewriter::rewrite()` 在 `src/instrument.cpp:341-375` 先用 `VM::jvmti()->Allocate()` 分配目标缓冲 `_dst`，然后调用 `rewriteClass()`。

- 如果 `Allocate()` 自己就失败，当前实现会直接返回，连 warning 都不会记录；
- 如果 `Result::OK`，就把 `_dst` 和 `_dst_len` 交给 `new_class_data` / `new_class_data_len`；
- 否则立即 `VM::jvmti()->Deallocate(_dst)`；
- 再根据失败类型记录 warning：`METHOD_TOO_LARGE`、`BAD_FULL_FRAME`、`JUMP_OVERFLOW`、`PROFILER_CLASS`、`ABORTED`。

也就是说，JVMTI 能看到的新 class bytes 有且只有一种情况：整个改写已经完成并被 `rewriteClass()` 判定成功。当前失败回退是“释放、警告、放弃改写”，而不是“返回一份尽力修过的 class 看 JVM 能不能接受”。

这条边界非常重要，因为它把 BytecodeRewriter 的风险控制原则说透了：**失败时宁可失去一次插桩能力，也不要污染 JVM 的类验证与加载路径。**

## 第七层：这条改写链服务的是调用驱动观测，不是周期采样替代品

到这里，整条链已经很清楚：

```text
Instrument::start
  → 准备 target/method + 开启 ClassFileLoadHook notification
    → retransformMatchedClasses
      → ClassFileLoadHook
        → BytecodeRewriter
          → 插入入口/出口代码
            → relocation_table
              → jumps / exception / line / local / StackMap 修正
                → 成功交付新 class bytes
                → 失败释放并跳过改写
```

这条路径再复杂，也不能把它误解成“async-profiler 的采样主路径”。CPU、alloc、lock、wall 这些章节建立过的主路径仍然是周期采样或事件驱动来源；BytecodeRewriter 服务的是另一种问题：**当你想观察某个方法调用驱动的进入/退出或延迟时，必须靠字节码改写把观测点精确放在方法边界上。**

换句话说：

- 周期采样回答“在这个时间点，程序大多在干什么”；
- BytecodeRewriter/latency 插桩回答“这个方法从进来到出去，中间发生了什么时长关系”。

它们是互补关系，不是替代关系。

本篇的一句话困惑是：**为什么一个 native profiler 只想插几条 Java 指令，却会突然不得不维护整套 class 文件结构？**

本篇的一句话顿悟是：**因为 bytecode offset 一变，所有依赖 offset 的结构都必须一起变；BytecodeRewriter 的真正核心不是插指令，而是维护 relocation table，并让 jumps、异常表、局部变量、行号和 StackMapTable 共享这张映射，成功才交付，失败就回退。**

*关键设计（斜体）：* *字节码改写的难点从来不是“写几条指令”，而是让所有偏移、验证和失败回退都保持一致。* [模式: 偏移统一修正 + 成功交付/失败回退]

[跨层标注：JVMTI `ClassFileLoadHook`——字节码改写入口；`Instrument::start/stop`——notification 启停与 retransform 边界；JVM class file `Code`/LineNumber/LocalVariable/StackMap——共同依赖 offset 的结构；BytecodeRewriter——native 手写转换器；Profiler latency/instrumentation——调用驱动观测路径]

## 下一篇：字节码结构修完之后，才轮到运行时栈恢复问题

这一篇先把“改写 class bytes”讲清。下一篇继续进入另一类结构恢复问题：

- HotSpot 内部偏移为什么要靠 VMStructs；
- native 栈为什么要分 FP、DWARF、VM walker；
- JIT CodeCache、Java 帧和 native 帧怎样重新拼成可读调用栈。

**→ 下一篇：VMStructs、CodeCache 与栈行走。**
