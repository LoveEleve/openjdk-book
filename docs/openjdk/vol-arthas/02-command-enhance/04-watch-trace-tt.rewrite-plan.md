# 04-watch-trace-tt 重写规划

> 状态：重写前大纲
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 目标：把当前“watch / trace / stack / tt / monitor / line”重构成一篇围绕“同一个 Advice/Spy 回调，为什么最终会长成完全不同的观察模型；而这些模型各自又在避免什么失真或误用”的机制文

## 1. 选题判断

这篇值得独立成篇，但不能继续写成：

- watch 怎么输出
- trace 怎么画树
- stack 怎么裁剪栈
- tt 怎么存历史
- monitor / line 是两个变体

这种并列功能说明文。

更好的统一问题是：

**同样是从上一章的 `SpyAPI -> AdviceListener` 回调链里拿到事件，为什么 `watch` 最后是一行现场、`trace` 是一棵树、`stack` 是一段业务栈、`tt` 又变成了可重放的历史记录？它们各自到底在防什么失真和误用？**

这样本篇就不再是“几个命令实现导览”，而会被收束成一条更硬的主线：

- 统一事件源如何分化成不同观察模型
- watch 怎样防多出口语义漂移
- trace 怎样防输出规模随调用次数线性爆炸
- stack 怎样防 Arthas 自己的栈帧污染业务视图
- tt 怎样避免把“历史记录”误写成“无副作用快照”

## 2. 读者困惑

- 同样一条 Advice 回调，为什么最后能长成四种完全不同的输出模型？
- 为什么 watch 要把 before/return/throw 都收敛到一个输出出口？
- 为什么 trace 不能把每次子调用都当成一条独立输出，而要合并成树？
- 为什么 stack 不能简单地把当前线程栈全打出来，而要先找到 SpyAPI 边界再裁？
- 为什么 tt 不能假装自己保存的是一个完全静态、无副作用的对象快照？

## 3. 一句话顿悟

**上一章的 Advice/Spy 回调只负责把事件送到 listener；真正决定用户最终看到什么的，是 listener 如何把同一批回调解释成不同的观察模型。watch 追求“单次调用现场”，trace 追求“合并后的调用树”，stack 追求“去掉 Arthas 自身污染后的业务栈”，tt 追求“可查询、可重放、但不伪装成无副作用快照的历史记录”。**

## 4. 版本边界

正文开头必须明确：

- 基于 `arthas` 当前源码实现讨论
- 聚焦 watch / trace / stack / tt / monitor / line 这些 listener 如何解释回调现场
- 不重复展开上一章的 `SpyAPI -> AdviceListenerManager` 分发细节；这里只把它当成上游输入
- 不把下一篇 OGNL 引擎细节提前写成本篇主线；这里只点到条件表达式与对象展开的消费点
- 这里讲的是 Arthas 当前 listener 输出模型，不等于所有 Java 诊断工具都这么表达运行时现场

## 5. 旧稿主要问题

### 5.1 已有优点

- 已经抓到了“同一条回调链，四种完全不同的观察方式”这个真实问题
- watch 的单一出口、trace 的树合并、stack 的 SpyAPI 边界裁剪、tt 的真实反射重放，这些关键事实都在
- 对 `ObjectVO`、`TraceTree`、`ThreadUtil`、`TimeTunnelAdviceListener` 等支撑结构有不错的锚点

### 5.2 必须修复的问题

- 当前骨架仍偏功能并列说明，主问题还不够集中
- 失败方案推演不够厚：watch 多出口漂移、trace 输出爆炸、stack 栈裁剪靠猜、tt 伪装成静态快照，这些都还没打透
- monitor / line 虽然可以压缩，但需要更明确的路标说明它们是分支变体，不是又开新主线
- 收网还没把“统一事件源 -> 不同观察模型”压成一条更大的判断

## 6. 重写策略

本篇不按命令种类平铺，而按更强的问题链组织：

1. 先建立冲突：同一条 Advice 回调链，为什么最后会长成不同的观察模型
2. 先排除几个错误直觉：
   - before/return/throw 各写各的输出逻辑
   - trace 每次子调用都独立展开
   - stack 直接打印当前线程完整栈
   - tt 号称自己保存了一个无副作用的完整快照
3. 再给总图：统一事件源 -> watch/trace/stack/tt 四种模型分化
4. 然后分层拆：
   - watch 的单一出口
   - trace 的节点合并树
   - stack 的 SpyAPI 边界裁剪
   - tt 的参数引用 + 真实反射重放
   - monitor / line 作为变体分支
5. 最后收束成“统一事件源，不同观察模型”的设计哲学

## 7. 结构大纲（按理解路径）

### 第一节：事故开场——同一条回调，为什么最后会长成四种完全不同的观察模型

目标：建立真实困惑，而不是直接列命令功能。

要回答：

- Advice 事件只是统一输入
- 但用户要看的可能是现场、树、栈、历史记录
- 本篇真正要追的不是“命令列表”，而是“同一事件源如何被解释成不同观察模型”

预估字数：900-1100

### 第二节：先排除几个错误直觉——多出口输出、独立 trace 节点、全栈打印、伪快照

目标：做失败方案推演。

要回答：

- 为什么 watch 不能让 before/return/throw 各写各的输出逻辑
- 为什么 trace 不能每次子调用都独立展开
- 为什么 stack 不能简单打印当前线程整段栈
- 为什么 tt 不能假装自己保存的是一个无副作用、深拷贝的历史快照
- 真正需要的是不同 listener 对同一事件源的不同解释模型

预估字数：1400-1700

### 第三节：第一层——watch 为什么要把四种回调收敛到一个输出出口

目标：把 watch 写成“单次调用现场模型”。

要回答：

- `before()` / `afterReturning()` / `afterThrowing()` / `isFinish()` 各自负责什么
- 为什么最终都要进 `watching()` 这一个统一出口
- 条件表达式、对象展开、限次终止为什么都应该集中在一个出口里
- `ObjectVO` 为什么属于展示模型，而不是 listener 自己递归打印

证据锚点：

- `core/command/monitor200/WatchAdviceListener.java:20`
- `WatchAdviceListener.java:33-35`
- `WatchAdviceListener.java:38-116`
- `arthas-model/src/main/java/com/taobao/arthas/model/ObjectVO.java:12-33`

预估字数：1800-2200

### 第四节：第二层——trace 为什么要把入口节点和子调用节点合成一棵树

目标：把 trace 写成“合并后的调用树模型”。

要回答：

- 入口节点和 invoke 子调用节点分别来自哪两套回调
- 为什么 `TraceTree.begin()` 要按“类、方法、行号”找已有子节点
- 为什么循环调用不能线性放大输出规模
- `deep == 0` 为什么是整棵树真正结束的判定点
- `TraceView` 为什么关注高亮最大耗时节点而不是简单列表化输出
- path 变体为什么是同一模型的另一种采集方式

证据锚点：

- `AbstractTraceAdviceListener.java:52-101`
- `TraceAdviceListener.java:23-27`
- `model/TraceTree.java:30-41`
- `view/TraceView.java:42-171`
- `PathTraceAdviceListener`

预估字数：2200-2600

### 第五节：第三层——stack 为什么要先找到 SpyAPI 边界，再一次裁掉 Arthas 自己的栈帧

目标：把 stack 写成“业务栈模型”。

要回答：

- 为什么用户想看的是业务栈，而不是 Arthas 自己的内部调用链
- 为什么裁剪边界不能靠“猜哪些类名像 Arthas”，而要靠 SpyAPI 这个稳定哨兵
- `ThreadUtil.getThreadStackModel()` 和 `findTheSpyAPIDepth()` 怎样配合
- `StackView` 为什么只是格式化器，不承担裁剪责任

证据锚点：

- `StackAdviceListener.java:33-76`
- `ThreadUtil.java:381-420`
- `ThreadUtil.java:438-497`
- `StackView.java:19-37`

预估字数：1700-2100

### 第六节：第四层——tt 为什么必须老实承认自己保存的是参数引用，而且重放是一场真实调用

目标：把 tt 写成“历史记录 + 真实重放模型”。

要回答：

- before 阶段为什么要把 `Object[]` 参数引用压入 ring stack
- 为什么这不是深拷贝快照
- `TimeFragment` 真正保存了什么
- `tt -i / -s / -w` 是怎么消费这些记录的
- `tt -p` 为什么不是观察操作，而是一场真实反射调用
- `ArthasMethod` 为什么是“描述符 -> 可调用 Method”这条桥

证据锚点：

- `core/command/monitor200/TimeTunnelAdviceListener.java:22,24-39,57-82,123`
- `TimeTunnelCommand.java:55-57,278-282,345-440,502-563`
- `ArthasMethod.java:26-102,155-164`

预估字数：2200-2600

### 第七节：第五层——monitor 与 line 为什么只是同一事件源下的两个变体分支

目标：给出路标，不让正文继续发散。

要回答：

- monitor 为什么把每次回调聚合成统计，而不是逐次渲染
- line 为什么消费 `atLine` 事件与局部变量
- 为什么这两者证明“增强层只负责喊一声，消费模型都在 listener 内部”

要求：这一节明确标为分支变体，赶时间可先记结论。

证据锚点：

- `monitor200/MonitorAdviceListener.java:67,72,186`
- `SpyLineInterceptor`

预估字数：900-1200

### 第八节：收网——Arthas 不是在“输出四种命令”，而是在用四种观察模型解释同一事件源

目标：把全文收成一句话并桥接下一篇。

必须点名：

- watch 的单次现场模型
- trace 的合并树模型
- stack 的业务栈模型
- tt 的历史记录 + 真实重放模型
- monitor / line 的分支变体
- 下一篇进入 OGNL / 表达式与输出模型

预估字数：800-1000

## 8. 必须展开的失败方案

至少要展开以下失败方案：

1. before/return/throw 各写各的输出逻辑
2. trace 每次子调用都独立生成节点
3. stack 直接打印当前线程全栈
4. tt 伪装成完整深拷贝、无副作用快照
5. monitor / line 各自重新造一套增强引擎

## 9. 本篇必须明确澄清的误解

1. Advice 是统一事件源，不等于最终输出模型
2. watch 不是三个分散输出点，而是一个统一出口
3. trace 的树不是“实际调用次数树”，而是“调用点合并树 + 统计累积”
4. stack 不是靠类名猜 Arthas 栈帧，而是靠 SpyAPI 哨兵边界裁剪
5. tt 保存的是参数引用与现场，不等于深拷贝快照
6. `tt -p` 是一次真实业务调用，不是无副作用重放
7. monitor / line 仍然复用同一增强与回调主链

## 10. 证据清单（正文托底）

- `core/command/monitor200/WatchAdviceListener.java:20,33-35,38-116`
- `arthas-model/src/main/java/com/taobao/arthas/model/ObjectVO.java:12-33`
- `AbstractTraceAdviceListener.java:52-101`
- `TraceAdviceListener.java:23-27`
- `model/TraceTree.java:30-41`
- `view/TraceView.java:42-171`
- `StackAdviceListener.java:33-76`
- `ThreadUtil.java:381-420,438-497`
- `StackView.java:19-37`
- `core/command/monitor200/TimeTunnelAdviceListener.java:22,24-39,57-82,123`
- `TimeTunnelCommand.java:55-57,278-282,345-440,502-563`
- `ArthasMethod.java:26-102,155-164`
- `monitor200/MonitorAdviceListener.java:67,72,186`

## 11. 字数预算

- 目标正文总字数：`9500-12500`
- 叙述性正文目标：`6500+`

## 12. 完成后必须通过的检查

1. 删除代码后，主线是否仍然成立
2. 是否清楚回答了“同一事件源为什么会长成不同观察模型”
3. 是否至少展开了 4 个失败方案
4. 是否把 watch/trace/stack/tt 统一到同一条 listener 消费主线上
5. 是否明确标出 monitor / line 是变体分支
6. 是否避免提前展开下一篇的 OGNL / 输出渲染细节
7. 是否完成 `file:line` 重核与边界声明
