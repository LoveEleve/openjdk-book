# 07. 业务代码只喊了一声，为什么正确的监听器就能听到？——SpyAPI、ClassLoader 分桶与回调还原链

> 基于 `arthas` 当前源码实现讨论；本文聚焦 `SpyAPI` 到 listener 的回调还原链，不重复展开上一章 `Enhancer` 如何把 `SpyAPI` 调用织进方法，也不把下一篇 watch/trace/tt 的 OGNL 与输出模型提前写成本篇主线。
> **前置依赖**：[06 —— 方法都已经在跑了，Arthas 凭什么还能临时钻进去？](../02-command-enhance/02-bytekit-enhancer.md)：知道目标方法已经被织入 `SpyAPI.atEnter/atExit` 等直接调用。
> → **后续**：`08. watch/trace/tt 的现场模型`——Advice、OGNL 条件、耗时和重放怎样变成用户可读输出。
> 关联域：ClassLoader 隔离、Java 反射/适配层、ThreadLocal 计时模型。
> 本篇所有源码锚点均已回对 Arthas 源码。

## 先看真正的冲突：业务字节码只喊了一声，为什么最后却能落到正确的 listener

场景：上一章已经把方法织进去了。业务线程真正跑到目标方法时，织入点里出现的只是这样一声调用：

```java
SpyAPI.atEnter(clazz, "doBiz|(...)", target, args)
```

从字节码视角看，这看起来非常朴素：一个稳定、全局可见的静态方法调用。

可它背后实际要解决的问题一点都不朴素：

- 同一时刻可能挂着多个 watch/trace/tt listener；
- 同名类可能由不同 ClassLoader 分别加载；
- 同名方法可能还有多个重载；
- 某些命令的 Process 可能已经结束，不该再继续接收事件；
- watch 需要“现场快照”，monitor 需要“耗时”，trace 还要区分 invoke 级事件。

所以本篇真正要回答的不是：

> `SpyAPI` 后面又调了哪些类？

而是：

> **业务方法里只被织入了一句 `SpyAPI.atEnter(...)`，为什么最后却能精确落到正确的 listener、正确的命令进程、正确的 ClassLoader 桶，甚至还能把调用现场和耗时一起还原出来？**

先把全篇总图立住：

```text
业务方法里的 SpyAPI.atEnter(...)
  → SpyAPI 只做稳定门面转发
    → SpyImpl 先把事件还原成 ClassLoader + 方法信息
      → AdviceListenerManager 按 ClassLoader 和签名分桶索引
        → 命中 AdviceListenerAdapter
          → Adapter 补齐命令层需要的上下文
            → Advice 形成现场快照
              → ThreadLocalWatch 负责嵌套耗时模型
                → WatchAdviceListener / TraceAdviceListener 真正消费事件
```

这张图里最重要的一刀就是：

```text
业务字节码只依赖一个稳定门面
真正的 listener 分发与上下文还原必须在 Arthas 内部分层完成
```

后面所有细节，都围绕这条边界展开。

---

## 一、先排除几个最直觉、也最容易失控的方案

### 1.1 错觉一：让业务字节码直接依赖具体 listener

一个最直觉的想法是：既然最终想通知 `WatchAdviceListener`、`TraceAdviceListener`，为什么不让织入后的业务代码直接调这些 listener？

这个想法的问题非常致命：业务字节码一旦直接依赖某个具体 listener，就会立刻把 Arthas 的内部实现细节冻死在目标应用的方法体里：

- listener 类型一改，业务字节码就得重新织入；
- 命令 stop/destroy 后，残余调用还可能继续打到一个已经销毁的实现；
- 具体 listener 还处在 ArthasClassloader 世界里，业务类加载器并不该直接依赖它。

也就是说，业务字节码需要的是一个**足够稳定、全局可见、可安全降级**的调用协议，而不是某个当前版本的具体实现类。

### 1.2 错觉二：只按类名和方法名分发

第二个直觉是：既然已经有 `className` 和 `methodName`，分发 listener 直接用这两个字段不就够了？

这会马上出问题：

- 两个不同 ClassLoader 可以同时加载同名类；
- 一个类里可以有多个同名重载方法；
- trace 还要区分方法内部不同 owner 的子调用点。

所以“只按类名和方法名分发”会把本应隔离的增强点错误合并，最后让不同 loader 下的同名类串台、不同签名的方法串台、不同 invoke 点串台。

### 1.3 错觉三：现场和耗时放一个对象里一起解决

第三个看似省事的方案是：一次回调里顺便把现场、耗时、线程上下文都塞进一个大对象，listener 直接拿来用。

这也不合适。因为“当前现场是什么”和“嵌套调用耗时怎么记”是两种不同责任：

- 现场快照要求事件语义清晰、对象语义统一；
- 耗时模型要求在嵌套调用下不丢栈、不串层，而且不能给业务线程留下阻碍卸载的复杂 Arthas 对象。

所以真正需要的不是“大一统对象”，而是：

```text
稳定门面
  → 归一化分发维度
    → ClassLoader 分桶索引
      → 命令上下文适配
        → 现场模型
          → 耗时模型
```

---

## 二、第一层：`SpyAPI` 为什么必须极薄、稳定、可降级

### 2.1 业务字节码为什么只能依赖一个薄门面

`SpyAPI` 的核心字段在 `spy/src/main/java/java/arthas/SpyAPI.java:24-27`：

- `public static final AbstractSpy NOPSPY`
- `private static volatile AbstractSpy spyInstance`
- `public static volatile boolean INITED`

业务字节码可调用的七个静态入口在 `SpyAPI.java:58-87`：

- `atEnter`
- `atExit`
- `atExceptionExit`
- `atBeforeInvoke`
- `atAfterInvoke`
- `atInvokeException`
- `atLine`

这七个入口本身几乎不承载复杂逻辑，它们只把调用转发给当前的 `spyInstance.atXxx(...)`。

这意味着增强后的业务方法永远只需要认识：

```text
java.arthas.SpyAPI
```

而不需要认识 `SpyImpl`、`AdviceListenerManager`、`WatchAdviceListener` 或任何 Arthas core 类。

### 2.2 为什么 stop 之后残余调用不会继续打到真实实现

上一章提过，`Enhancer.java:95-99` 会在类加载时把 `SpyImpl` 安装进 `SpyAPI`；而 stop / destroy 时又会把它切回 `NOPSPY`。

这就是 `NOPSPY`、`spyInstance`、`INITED` 三件套存在的真正意义：业务字节码里的调用协议不变，但内部实现可以替换，必要时还能安全降级成空实现。

关键设计（斜体）：*业务字节码需要一个冻结的调用协议，而不是一个冻结的实现。*[模式: 门面 + 策略 + 空对象] `SpyAPI` 是稳定协议，`spyInstance` 是当前策略，`NOPSPY` 则保证 stop 后残余调用也只能落到安全空路径。

### 2.3 为什么这一步不是“架构优雅”，而是热替换系统的前提

如果业务字节码直接依赖具体实现：

- stop 之后就很难把它平滑切断；
- 具体 listener 一变，所有已织入的方法都得重新认识新类型；
- 类加载隔离也会被打穿。

所以 `SpyAPI` 这层薄门面不是装饰，而是整个热替换系统能持续演化、持续 stop/reset 的前提。

---

## 三、第二层：`SpyImpl` 为什么先把回调还原成 `ClassLoader + MethodInfo`

### 3.1 这一步真正做的是“事件归一化”

`core/advisor/SpyImpl.java:28-50` 是 `atEnter()` 的主链：

1. 先从 `clazz.getClassLoader()` 取目标类加载器；
2. 用 `StringUtils.splitMethodInfo(methodInfo)` 拆开“方法名|方法描述”；
3. 调 `AdviceListenerManager.queryAdviceListeners()` 查 listener；
4. 遍历命中的 listener；
5. 如果对应 Process 已结束就跳过；
6. 否则调用 `adviceListener.before(...)`。

`atExit()` 与 `atExceptionExit()` 在 `SpyImpl.java:53-98` 走的是同一套模式，只是最后分别进 `afterReturning` 与 `afterThrowing`。

也就是说，`SpyImpl` 的第一职责不是“执行业务逻辑”，而是把业务字节码里那一句简化调用，还原成 Arthas 内部分发真正需要的几个维度：

```text
哪个 ClassLoader
哪个类
哪个方法名
哪个描述符
当前是哪类事件
```

### 3.2 为什么 `splitMethodInfo()` 不能留给后面再做

`methodInfo` 在织入阶段已经被压成了“方法名|描述符”这种紧凑协议。`SpyImpl` 这里把它拆开，不是实现小细节，而是因为后面分发索引的 key 就依赖这些分量。

如果这一步不在入口层统一完成，而留给后面的不同 listener 自己去拆，分发索引和命令逻辑就会重新散掉。

### 3.3 为什么已结束的 Process 必须在这里就被跳过

`SpyImpl.skipAdviceListener()` 在 `SpyImpl.java:204-217` 里判断：只要 Process 为 `null`，或状态已经是 `TERMINATED` / `STOPPED`，就不再把事件送给该 listener。

这一步非常关键，因为它保证的是：**织入点还留在业务方法里，不等于每次运行都必须继续打到早就退出的命令实例。**

所以 `SpyImpl` 在这里不只是转发器，它还是一个事件归一化和存活性筛选入口。

关键设计（斜体）：*Spy 层真正要做的不是“直接把事件推给 listener”，而是先把事件还原成稳定分发维度，再把已经失效的订阅者挡在门外。*[模式: 归一化入口 + 存活性过滤]

---

## 四、第三层：为什么分发索引的第一维一定是 `ClassLoader`

### 4.1 这不是附加过滤条件，而是第一维主键

`AdviceListenerManager` 的顶层索引在 `AdviceListenerManager.java:101-104`：

```java
ConcurrentWeakKeyHashMap<ClassLoader, ClassLoaderAdviceListenerManager>
```

这已经直接表明：`ClassLoader` 不是一个后补过滤条件，而是分发索引的第一维主键。

为什么？因为在 JVM 里：

```text
ClassLoader A → com.example.Service
ClassLoader B → com.example.Service
```

这两个 `Service` 虽然类名相同，但根本不是同一个 `Class`，也不该收到同一组 listener。

如果不先按 ClassLoader 分桶，你在运行时分发阶段就会把本该隔离的两份同名类世界错误揉到一起。

### 4.2 为什么方法描述符也必须进入 key

普通方法 key 在 `AdviceListenerManager.java:106-108`：

```text
className + methodName + methodDesc
```

这比只用 `className + methodName` 多出来的 `methodDesc` 非常关键。因为：

```java
void doBiz(String value)
void doBiz(String value, int retry)
```

方法名相同，但描述符不同。没有描述符，你根本分不清应该把哪个 listener 送给哪个重载方法。

trace 场景还要更多一维 `owner`（`AdviceListenerManager.java:110-112`），行号事件则要再加 `#lineNumber`（`:114-116`）。这说明分发索引的设计原则很清楚：**用最小但足够区分的签名，把不同增强点彻底拆开。**

### 4.3 为什么顶层 key 要是弱引用

`ConcurrentWeakKeyHashMap<ClassLoader, ...>` 还有另一个重要含义：当业务 ClassLoader 被卸载时，索引不应因为强引用继续把它拖在内存里。

如果这里用普通强引用 map，Arthas 自己的监听器索引就可能变成类卸载的阻碍物。弱 key 在这里不是并发容器选型小细节，而是 stop/detach 后内存边界的一部分。

关键设计（斜体）：*分发索引的第一维必须先按 ClassLoader 分桶，第二层才按方法签名细分；否则类隔离和类卸载边界都会被打穿。*[模式: 分桶索引 + 弱引用]

---

## 五、第四层：`AdviceListenerAdapter` 为什么要补一层上下文，而不是直接把 Spy 签名暴露给命令层

### 5.1 为什么 Spy 签名必须稳定，而命令上下文却必须更丰富

Spy 层的接口非常稳定，例如：

```java
before(Class<?> clazz, String methodName, String methodDesc,
       Object target, Object[] args)
```

这很合理，因为一旦它进入业务字节码，就不应该轻易再改。

但命令层真正需要的却不止这些：

- ClassLoader
- `ArthasMethod`
- 当前命令 Process
- 表达式求值能力
- `-n` 次数限制
- 达到上限后的中断能力

这就形成了一个明显冲突：**业务字节码需要稳定签名，命令层却需要不断扩充上下文。**

### 5.2 `AdviceListenerAdapter` 真正隔离了什么

`core/advisor/AdviceListenerAdapter.java:18-86` 正是在做这层隔离。

它把 Spy 层的 final 回调包装成命令层真正使用的抽象方法：

```java
before(clazz, methodName, methodDesc, target, args)
  → before(clazz.getClassLoader(),
           clazz,
           new ArthasMethod(clazz, methodName, methodDesc),
           target,
           args)
```

返回、异常、行号路径也都走同样的升级。

这意味着命令层无需接受“被字节码世界冻结的最小签名”，而可以在适配层之后获得：

- loader 维度
- `ArthasMethod`
- 当前 Process
- 表达式与限次辅助能力

### 5.3 为什么 `ProcessAware` 和 `abortProcess` 属于这一层

`AdviceListenerAdapter` 同时实现 `ProcessAware`，并集中放置：

- `isConditionMet`
- `getExpressionResult`
- `isLimitExceeded`
- `abortProcess`

这些能力都不应该进 Spy 层。因为 Spy 层的职责是稳定分发，而不是去理解 OGNL、命令终止、输出模型这些更高层的语义。

关键设计（斜体）：*Spy 签名一旦进入业务字节码就该尽量冻结，命令层所需的额外上下文与控制能力必须在后面补。*[模式: 适配器 + 语义升级] `AdviceListenerAdapter` 就是这条“稳定门面”与“命令语义世界”之间的绝缘层。

---

## 六、第五层：为什么 `Advice` 和 `ThreadLocalWatch` 必须分成“现场模型”与“耗时模型”

### 6.1 `Advice` 为什么表示的是“当前现场是什么”

`core/advisor/Advice.java:12-27` 里聚合了：

- ClassLoader
- Class
- `ArthasMethod`
- target 与 params
- return object / throwable
- 行号、局部变量、局部变量 Map
- `isBefore` / `isThrow` / `isReturn` / `isLine` 位标志

工厂方法：

- `newForBefore()`（`Advice.java:153-167`）
- `newForAfterReturning()`（`:170-185`）
- `newForAfterThrowing()`（`:188-203`）
- `newForLine()`（`:207-230`）

再加上 `Advice.java:147-150` 的 AccessPoint 位值，说明 `Advice` 的角色很明确：**它是一次回调现场的统一快照。**

它回答的是：“这次发生了什么、在哪个点发生、手里有哪些对象和变量”。

### 6.2 为什么耗时不能直接塞进 `Advice`

耗时看起来也像“现场的一部分”，但实际上它面对的是另一类问题：嵌套调用。

如果 A 调 B，而 A 和 B 都被增强，只在一个对象里放一个开始时间，B 的开始时间就会覆盖 A，最后 A 的耗时就脏了。

所以 Arthas 把耗时单独放进 `core/util/ThreadLocalWatch.java:9-36`：

- `DEFAULT_STACK_SIZE = 1024 * 4`
- 实际 `long[]` 长度是 `4097`
- `start()` 压栈（`:24-28`）
- `costInMillis()` 弹栈并算耗时（`:34-36`）

这不是“写法习惯”，而是责任切分：

- `Advice` 表示现场语义；
- `ThreadLocalWatch` 表示嵌套耗时模型。

### 6.3 为什么 `ThreadLocalWatch` 不把复杂 Arthas 对象塞进业务线程 `ThreadLocalMap`

源码注释已经明确说明：`ThreadLocalWatch` 用的是极简 `long[]`，避免 stop/detach 后业务线程的 `ThreadLocalMap` 里还挂着复杂 Arthas 对象，阻碍类加载器回收。

也就是说，这个固定容量 ring stack 的设计目标不是“最优雅地表达栈”，而是：

```text
优先保证 stop / detach 后不把 Arthas 对象残留在线程本地状态里
然后再在有限容量内支持嵌套耗时计算
```

关键设计（斜体）：*现场快照模型和耗时模型必须分离；前者追求语义统一，后者追求嵌套正确与 stop 后可卸载。*[模式: 不可变快照 + 固定容量计时栈]

---

## 收网：Arthas 不是在“直接调 listener”，而是在重放一条可分桶、可适配、可降级的回调还原链

现在把整条链收成一张图：

```text
1. 业务方法里只保留一个稳定的 SpyAPI 调用协议
2. SpyImpl 先把事件还原成 ClassLoader + 方法签名 + 事件类型
3. AdviceListenerManager 按 ClassLoader 分桶、按方法签名细分 listener
4. AdviceListenerAdapter 把稳定 Spy 签名升级成命令层真正需要的上下文
5. Advice 承担现场快照，ThreadLocalWatch 承担嵌套耗时模型
6. WatchAdviceListener / TraceAdviceListener 才真正消费这次事件
```

把这张图压成一句话，就是：

**Arthas 并不是让业务字节码直接调用某个具体 listener，而是让业务字节码只依赖一个稳定、可降级的 `SpyAPI` 门面；真正的 listener 分发则在 Arthas 内部被一步步还原为 ClassLoader 分桶、命令上下文、现场快照和耗时模型。**

到这里为止，主线其实只发生了四件事：

- 业务字节码需要稳定门面，而不是稳定实现；
- listener 分发必须先按 ClassLoader 和方法签名精确分桶；
- 命令层所需上下文不能污染 Spy 层签名，而要通过适配层升级；
- 现场模型与耗时模型必须拆开，才能同时兼顾语义统一、嵌套正确和 stop/detach 后的可卸载性。

这也解释了为什么业务代码只喊了一声 `SpyAPI`，最后却能精准命中正确 listener、正确命令进程、正确 ClassLoader 桶：**Arthas 不是在做一次简单回调，而是在重放一条可分桶、可适配、可降级的回调还原链。**

跨层标注：[ClassLoader——同名类隔离与弱引用分桶索引]；[Java 反射/适配层——稳定门面签名与命令语义上下文分离]；[ThreadLocal——耗时模型的嵌套栈与 stop 后卸载边界]；[AR-1 SpyAPI 注入——为什么业务字节码只能依赖一个 bootstrap 可见的静态门面]

本篇解决的是“为什么业务字节码只能依赖一个极薄门面，而真正的 listener 分发又必须靠 ClassLoader 分桶、适配层和模型分离逐层还原”。下一篇继续进入回调链的最后一层：**这些现场、耗时、表达式和限次规则，又怎样被 watch/trace/tt 组织成用户真正看到的输出？**

**→ 下一篇：watch/trace/tt 的现场模型。**
