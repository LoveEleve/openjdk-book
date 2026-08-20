# 03-spy-dispatch 重写规划

> 状态：重写前大纲
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 目标：把当前“SpyAPI / SpyImpl / AdviceListenerManager / Advice / ThreadLocalWatch”重构成一篇围绕“业务字节码为什么只能依赖一个极薄门面，而真正的监听器分发又必须靠 ClassLoader 分桶、适配层和现场模型层层还原”的机制文

## 1. 选题判断

这篇值得独立成篇，但不能继续写成：

- `SpyAPI` 做什么
- `SpyImpl` 做什么
- `AdviceListenerManager` 怎么索引
- `Advice` 是什么
- `ThreadLocalWatch` 怎么计时

这种按组件分段的说明文。

更好的统一问题是：

**业务方法里只被织入了一句 `SpyAPI.atEnter(...)`，为什么最后却能精确地落到正确的 listener、正确的命令进程、正确的 ClassLoader 桶，甚至还能把调用现场和耗时一起还原出来？**

这样本篇就不再是“分发链导览”，而会被收束成一条更硬的回调还原链：

- 业务字节码为什么只能依赖稳定的静态门面
- 为什么 `SpyImpl` 不能直接靠类名做分发
- 为什么第一维必须先按 ClassLoader 分桶
- 为什么监听器还需要 `AdviceListenerAdapter` 来补上下文
- 为什么现场模型和耗时模型必须拆成两层责任

## 2. 读者困惑

- 业务方法里只插了一句 `SpyAPI.atEnter(...)`，为什么最后能落到正确的 `WatchAdviceListener` / `TraceAdviceListener`？
- 为什么 `SpyAPI` 不直接依赖某个具体 listener？
- 为什么 `AdviceListenerManager` 的第一维一定是 `ClassLoader`，而不是类名？
- 为什么同名类在不同 ClassLoader 下不会串台？
- 为什么 `Advice` 和 `ThreadLocalWatch` 不能合成一个对象一起解决？
- 为什么 stop 之后，残余 `SpyAPI` 调用不会继续打到已经销毁的命令？

## 3. 一句话顿悟

**业务字节码只能依赖一个稳定、极薄、全局可见的 `SpyAPI` 门面；真正的分发则在 Arthas 内部逐层展开：`SpyImpl` 先把回调还原成“ClassLoader + 类 + 方法 + 事件类型”，`AdviceListenerManager` 再按 ClassLoader 分桶与方法签名定位 listener，`AdviceListenerAdapter` 负责把稳定的 Spy 签名升级成命令层真正需要的上下文，而 `Advice` 与 `ThreadLocalWatch` 分别承担“现场快照”和“嵌套耗时”两种不同责任。**

## 4. 版本边界

正文开头必须明确：

- 基于 `arthas` 当前源码实现讨论
- 聚焦 `SpyAPI` 到 listener 的回调还原链
- 不重复展开上一篇 `Enhancer` 如何把 `SpyAPI` 调用织入方法；这里只把它当作上游输入
- 不把下一篇 watch/trace/tt 的 OGNL、表达式和模型渲染提前写成本篇主线
- 这里讲的是 Arthas 当前 listener 分发架构，不等于所有 Java agent 工具都采用这套 Spy 门面 + 分桶索引模型

## 5. 旧稿主要问题

### 5.1 已有优点

- 已经抓到“业务代码只喊一声，真正的监听器还在里面”这个问题
- `SpyAPI -> SpyImpl -> AdviceListenerManager -> AdviceListenerAdapter -> AdviceListener` 的主链已经在
- ClassLoader 分桶、方法描述符、弱引用 key、ProcessAware、`Advice` 与 `ThreadLocalWatch` 的证据都很强
- 末尾链路图已经很完整

### 5.2 必须修复的问题

- 当前骨架仍偏组件说明文，主问题不够集中
- 失败方案推演不够厚：为什么不能让业务字节码直接依赖 `SpyImpl` / listener、为什么不能只按类名分发、为什么现场与耗时不能混成一个对象，都还没打透
- `Advice` 与 `ThreadLocalWatch` 目前像两个并列附加机制，还没被收成“现场模型”和“耗时模型”两种责任
- 收网虽然有链路图，但还没把几个设计选择压成一个更强的总体判断

## 6. 重写策略

本篇不按组件顺序推进，而按更强的问题链组织：

1. 先建立冲突：业务字节码里只有一声 `SpyAPI` 调用，为什么最后能精确落到正确 listener
2. 先排除几个错误直觉：
   - 业务字节码直接依赖具体 listener
   - 只按类名/方法名分发
   - 一个对象同时承担现场与耗时
3. 再给总图：稳定门面 → ClassLoader 分桶分发 → 适配器补上下文 → Advice 现场模型 → ThreadLocalWatch 耗时模型
4. 然后分层拆：
   - `SpyAPI` 为什么必须极薄且可降级
   - `SpyImpl` 怎样把调用恢复成可分发维度
   - `AdviceListenerManager` 为什么先按 ClassLoader 分桶
   - `AdviceListenerAdapter` 为什么要把稳定签名升级成命令上下文
   - `Advice` / `ThreadLocalWatch` 为什么要责任分离
5. 最后收束成“稳定门面 + 分桶索引 + 上下文适配 + 模型分离”的设计哲学

## 7. 结构大纲（按理解路径）

### 第一节：事故开场——业务代码只喊了一声，为什么正确 listener 能听到

目标：建立真实困惑，而不是直接列组件。

要回答：

- 已织入的方法里只看到 `SpyAPI.atEnter(...)`
- 但实际要解决的是多 listener、多命令、多 ClassLoader、多事件类型的精确分发
- 本篇真正要追的不是“有哪些类”，而是“这一声调用怎样被层层还原成正确监听事件”

预估字数：900-1100

### 第二节：先排除几个错误直觉——直接依赖 listener、只按类名分发、把现场和耗时混在一起

目标：做失败方案推演。

要回答：

- 为什么业务字节码不能直接依赖 `WatchAdviceListener`
- 为什么只按 `className + methodName` 分发会在多 ClassLoader 与重载方法下串台
- 为什么耗时统计不能直接塞进现场对象里同步处理
- 真正需要的是：稳定门面、分桶索引、适配层、模型分离

预估字数：1300-1600

### 第三节：第一层——`SpyAPI` 为什么必须极薄、稳定、可降级

目标：把门面 + 策略 + 空对象写成冲突解法。

要回答：

- `SpyAPI` 的七个静态入口为什么只做转发
- `NOPSPY`、`spyInstance`、`INITED` 各自解决什么边界问题
- 为什么增强后的业务字节码永远不该依赖 `SpyImpl` 或 listener core 类
- 为什么 stop 后还能安全退回 NOP 路径

证据锚点：

- `spy/src/main/java/java/arthas/SpyAPI.java:24-27`
- `SpyAPI.java:58-87`
- `Enhancer.java:95-99`（桥接回指）

预估字数：1500-1800

### 第四节：第二层——`SpyImpl` 为什么先还原出 ClassLoader 与 MethodInfo

目标：把 `SpyImpl` 写成“事件归一化入口”。

要回答：

- `atEnter()` 怎样从 `clazz.getClassLoader()` 与 `methodInfo` 里恢复分发维度
- 为什么 `splitMethodInfo()` 必须发生在这里
- 为什么已结束的 Process 必须在这里就被跳过
- `atExit()` / `atExceptionExit()` 为什么共用同一套查询逻辑

证据锚点：

- `core/advisor/SpyImpl.java:28-50`
- `SpyImpl.java:53-98`
- `SpyImpl.java:204-217`

预估字数：1600-1900

### 第五节：第三层——为什么分发索引的第一维一定是 `ClassLoader`

目标：把 ClassLoader 分桶写成主冲突解法。

要回答：

- 为什么同名类在不同 ClassLoader 下不是同一个目标
- 为什么方法描述符必须进入 key
- trace 子调用为什么还要加 owner
- 为什么顶层 map 用 `ConcurrentWeakKeyHashMap<ClassLoader, ...>`
- 弱引用 key 为什么和类卸载边界直接相关

证据锚点：

- `AdviceListenerManager.java:101-116`
- `AdviceListenerManager.java:188-205`
- `AdviceListenerManager.java:212-223`

预估字数：1900-2300

### 第六节：第四层——`AdviceListenerAdapter` 为什么要补一层上下文，而不是直接把 Spy 签名暴露给命令层

目标：把 Adapter 写成“稳定签名与命令上下文解耦器”。

要回答：

- Spy 层签名为什么必须稳定
- 命令层为什么需要额外的 ClassLoader、`ArthasMethod`、Process、表达式与限次控制
- `ProcessAware` 为什么让已结束命令不再收到回调
- `abortProcess`、`isConditionMet`、`isLimitExceeded` 为什么属于这一层

证据锚点：

- `core/advisor/AdviceListenerAdapter.java:18-86`
- `AdviceListenerAdapter.java:132-161`
- `SpyImpl.skipAdviceListener()`（桥接回指）

预估字数：1800-2200

### 第七节：第五层——为什么 `Advice` 和 `ThreadLocalWatch` 必须分成“现场模型”与“耗时模型”

目标：把两者责任分离写清楚。

要回答：

- `Advice` 为什么表示的是“当前现场是什么”，而不是“耗时是多少”
- 四个工厂方法与位标志为什么能统一 before/return/throw/line 四种事件
- `ThreadLocalWatch` 为什么用固定容量 ring stack，而不是复杂对象塞进业务线程 `ThreadLocalMap`
- 为什么 stop/detach 后不能让业务线程留下可阻止类加载器回收的 Arthas 对象

证据锚点：

- `core/advisor/Advice.java:12-27`
- `Advice.java:147-150`
- `Advice.java:153-230`
- `Advice.java:232-274`
- `core/util/ThreadLocalWatch.java:9-36`

预估字数：1900-2300

### 第八节：收网——Arthas 不是在“直接调用 listener”，而是在重放一条可分桶、可适配、可降级的回调还原链

目标：把全文收成一句话并桥接下一篇。

必须点名：

- 稳定 `SpyAPI` 门面
- `SpyImpl` 事件归一化
- ClassLoader 分桶索引
- Adapter 上下文升级
- `Advice` / `ThreadLocalWatch` 模型分离
- 下一篇进入 watch/trace/tt 输出模型

预估字数：800-1000

## 8. 必须展开的失败方案

至少要展开以下失败方案：

1. 业务字节码直接依赖 `SpyImpl` / 具体 listener
2. 只按类名或 `className + methodName` 分发
3. 忽略方法描述符与 trace owner
4. 不区分已结束 Process，继续给已退出命令分发事件
5. 让 `Advice` 同时承担现场快照与嵌套耗时模型
6. 在线程 `ThreadLocalMap` 里挂复杂 Arthas 对象阻碍 stop/detach 后卸载

## 9. 本篇必须明确澄清的误解

1. 业务字节码并不是直接在调用具体 listener，而是在调用稳定门面
2. ClassLoader 不是一个附加过滤条件，而是分发索引的第一维
3. 方法名相同不等于同一个增强点，描述符必须进入 key
4. `Advice` 不是耗时模型，`ThreadLocalWatch` 也不是现场快照
5. stop 后残余 `SpyAPI` 调用并不会继续打到真实实现，而会退回 NOP/跳过路径
6. 多 listener 并不等于物理多次织入，这件事上一篇已经解决，本篇讲的是运行时逻辑分发

## 10. 证据清单（正文托底）

- `spy/src/main/java/java/arthas/SpyAPI.java:24-27`
- `SpyAPI.java:58-87`
- `Enhancer.java:95-99`
- `core/advisor/SpyImpl.java:28-50`
- `SpyImpl.java:53-98`
- `SpyImpl.java:204-217`
- `AdviceListenerManager.java:101-116`
- `AdviceListenerManager.java:188-205`
- `AdviceListenerManager.java:212-223`
- `core/advisor/AdviceListenerAdapter.java:18-86`
- `AdviceListenerAdapter.java:132-161`
- `core/advisor/Advice.java:12-27`
- `Advice.java:147-150`
- `Advice.java:153-230`
- `Advice.java:232-274`
- `core/util/ThreadLocalWatch.java:9-36`

## 11. 字数预算

- 目标正文总字数：`9000-12000`
- 叙述性正文目标：`6000+`

## 12. 完成后必须通过的检查

1. 删除代码后，主线是否仍然成立
2. 是否清楚回答了“为什么业务只喊一声，最终却能精确落到正确 listener”
3. 是否至少展开了 4 个失败方案
4. 是否把稳定门面、ClassLoader 分桶、Adapter 上下文升级、模型分离统一到同一条回调还原链上
5. 是否避免提前展开下一篇的 OGNL / 输出模型细节
6. 是否完成 `file:line` 重核与边界声明
