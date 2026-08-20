# 04-reflection-annotation/02 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `java.base` 的 `Method`、`Constructor`、`jdk.internal.reflect.*` 反射调用实现；字段访问器以 `UnsafeFieldAccessorFactory` / `UnsafeFieldAccessorImpl` 为主。`JNI`、`MethodHandle`、`invokedynamic` 只作边界对照，不展开替代实现。
> 目标：把“反射为什么慢”重写成一篇围绕“同一个 Method 被调用千万次时，JDK 如何先用 native 顶上，再按热度切换到字节码实现”的机制文章；字段访问器部分只保留能说明‘为什么字段和方法不是同一套优化路线’的必要内容。

## 1. 读者困惑

- `method.invoke(obj, args)` 为什么比直接调用慢，慢到底慢在哪几层？
- JDK 11 为什么不一开始就生成字节码，反而要先走 native，再第 16 次才切换？
- `DelegatingMethodAccessorImpl` 这层看起来只是转发，为什么非要存在？
- `setAccessible(true)` 为什么会让反射快一些，它到底省掉了什么？
- 字段反射为什么没有走和方法一样的“native → generated”膨胀路线？

## 2. 一句话顿悟

**JDK 11 把反射调用拆成两种成本：低频调用怕生成太早，所以先走可立即使用的 native accessor；高频调用怕 JNI 边界太贵，所以再把同一个入口无感切换成字节码 accessor。`DelegatingMethodAccessorImpl` 保证这个切换对 `Method.invoke` 透明，而字段访问器则直接走 Unsafe 偏移，不和方法共用同一条策略。**

## 3. 旧稿优点与问题

### 保留

- 已经覆盖 `Method.invoke`、`ReflectionFactory.newMethodAccessor`、`NativeMethodAccessorImpl` 的膨胀阈值、`noInflation` 开关、字段访问器与 `Unsafe` 工厂。
- 关键证据完整：`Method.java:552/623`、`ReflectionFactory.java:87/88/189/205/214/682/701`、`NativeMethodAccessorImpl.java:43-69`、`DelegatingMethodAccessorImpl.java:33-48`、`UnsafeFieldAccessorFactory.java:32`、`UnsafeFieldAccessorImpl.java:46-52`、`Field.java:1081-1086`。
- 已经有“生成前 native、生成后字节码”的骨架，与 01 篇衔接自然。

### 必须重写

- 当前开头还是概念式问答，缺一个足够具体的生产现场，例如 Bean 装配热路径、序列化框架调用 setter、ORM 映射器长时间反射调用等，让读者先感到“为什么这 15 次阈值值得讲”。
- 旧稿直接从三层结构开讲，缺失最重要的失败方案：为什么不能“一开始就生成字节码”，以及为什么不能“永远只走 native”。
- 字段访问器部分信息多但叙事不够聚焦，容易把全文拖成“方法访问器 + 字段访问器百科”；需要明确它在本文的角色是对照物：说明反射优化不止一条路线。
- `setAccessible(true)` 的性能收益需要更精确地落到 `Method.invoke` 的 `if (!override)` 与 `Field.getFieldAccessor` 的 `overrideFieldAccessor` 选择，而不是笼统说“跳过检查”。
- 收尾应该回到“框架如何在热路径上管理反射成本”，而不是简单给出三板斧清单。

## 4. 理解路径

### 第一节：一个热路径为什么会被 `Method.invoke` 拖慢

用容器或 ORM 的热路径开场：框架已经把 `Method` 缓存好了，甚至也调用了 `setAccessible(true)`，但真正的瓶颈仍可能在千万次 `invoke`。说明现在的问题不再是“成员对象是否缓存”，而是“同一个 Method 的执行器到底长什么样”。

先给角色图：

```text
业务热路径
   → Method.invoke
      → 可见性检查
      → MethodAccessor 入口
         ├── native 调用
         └── generated 字节码调用
```

回钩上一篇：01 篇已经说明多个 Method copy 会共享同一个 accessor；这篇要回答 accessor 自己如何演化。

### 第二节：`Method.invoke` 本体很短，真正的复杂性在 accessor 背后

先打破“反射慢是因为 invoke 方法本身很长”的误解。读 `Method.invoke`：`checkAccess`、读取 `methodAccessor`、空则 `acquireMethodAccessor`、最后转发。强调它自己不决定 native 还是字节码，只是统一入口。

证据：
- `Method.java:552-566`：`if (!override)`、`MethodAccessor ma = methodAccessor`、`ma.invoke`。
- `Method.java:623-637`：`acquireMethodAccessor` 沿 root 查已有 accessor，没命中才让 `ReflectionFactory` 创建。

失败方案：
1. 以为 `Method.invoke` 本体就是主要成本。
2. 以为每个 Method copy 都会生成独立 accessor。
3. 以为 `setAccessible(true)` 会直接把反射变成“接近直接调用”，忽略后面的 accessor 路线。

### 第三节：为什么要有 Delegating → Native → Generated 三层

这是全文顿悟点。先推演两个失败方案：
- **一开始就生成字节码**：每个低频 Method 都付出生成类、加载类、实例化 accessor 的成本，启动阶段很亏。
- **永远只走 native**：高频调用始终跨 JNI 边界，热路径成本压不下去。

然后引出三层结构：
- `ReflectionFactory.newMethodAccessor` 默认返回 `DelegatingMethodAccessorImpl`，内部先包 `NativeMethodAccessorImpl`。
- `DelegatingMethodAccessorImpl` 只是转发，但它允许 parent 在运行时 `setDelegate`，于是入口对象不变，底层实现可换。
- `NativeMethodAccessorImpl` 统计次数，超过阈值后生成 `GeneratedMethodAccessor` 并替换委托目标。

证据：
- `ReflectionFactory.java:189-220`
- `DelegatingMethodAccessorImpl.java:33-48`
- `NativeMethodAccessorImpl.java:43-69`

总图：

```text
Method.methodAccessor
   → DelegatingMethodAccessorImpl
       → 起步: NativeMethodAccessorImpl
       → 过阈值后: GeneratedMethodAccessor
```

重点解释“委托层为什么不能省”：如果没有它，`Method` 已缓存的 accessor 引用就必须整体替换，多个 Method copy 之间的共享关系也会更别扭；而 Delegating 保证大家始终看到同一个入口壳子。

### 第四节：第 16 次为什么才切换，`noInflation` 又改变了什么

先回答面试最爱问的数字：默认阈值是 15，所以第 16 次开始走膨胀逻辑。解释这是 `++numInvocations > inflationThreshold` 的结果，而不是“>= 15”。

再讲两种失败思路：
1. 把阈值当作绝对最佳值；其实只是 JDK 11 默认折中。
2. 以为所有方法都能膨胀；VM anonymous class 例外。

补全边界：
- `ReflectionFactory.java:87-88`：`noInflation` 与 `inflationThreshold` 默认值。
- `ReflectionFactory.java:205-219`：`noInflation=true` 时直接 `generateMethod`。
- `ReflectionFactory.java:682-710`：系统属性读取时机与配置入口。
- `NativeMethodAccessorImpl.java:46-60`：阈值判断与 `ReflectUtil.isVMAnonymousClass` 例外。
- `MethodAccessorGenerator.java:68-84`：真正生成字节码 accessor 的入口。

要写清楚的版本边界：系统属性在 `ReflectionFactory.checkInitted()` 中延迟读取，而且等到模块系统初始化后才完成，这属于 JDK 11 启动实现事实。

### 第五节：`setAccessible(true)` 具体省掉了哪一层成本

把“setAccessible 会变快”从经验说法落到两条具体机制：
- 方法调用：`Method.invoke` 在 `!override` 时才做 `checkAccess`，因此 `setAccessible(true)` 省掉的是每次访问检查，不会跳过后面的 accessor 调用、boxing 和异常包装。
- 字段访问：`Field.getFieldAccessor` 依据 `override` 选择 `overrideFieldAccessor`，这使得字段路径能直接走已准备好的 override accessor。

这节要特别防止误导：`setAccessible(true)` 不是把反射变成直接调用，也不是模块限制下的万能钥匙。模块边界已经在 03 篇讲过，这里只保留性能层面的收益解释。

### 第六节：为什么字段访问器没有跟方法一起“膨胀”

先说明本文为什么需要这节：如果不做对照，读者很容易把“反射调用优化”误认为整个反射域都是同一条路。

讲法上只保留两个核心点：
- `ReflectionFactory.newFieldAccessor` 直接委托 `UnsafeFieldAccessorFactory.newFieldAccessor`。
- `UnsafeFieldAccessorImpl` 在构造时就计算 `objectFieldOffset` / `staticFieldOffset`，字段读取靠 Unsafe 偏移访问，不需要像方法调用那样再做“先 native、后 generated”的切换。

证据：
- `ReflectionFactory.java:175-187`
- `UnsafeFieldAccessorFactory.java:32-104`
- `UnsafeFieldAccessorImpl.java:46-52`
- `Field.java:1081-1086`

失败方案：把字段访问性能问题照搬到 MethodAccessor 的话术里，误以为字段也会在 15 次后生成某个 `GeneratedFieldAccessor`。

### 第七节：收网与下一篇钩子

回到开头热路径：
- 成员对象缓存只解决“你是不是每次都在重新找 Method”。
- `MethodAccessor` 三层切换解决“同一个 Method 被调用很多次时，执行路径是否值得优化”。
- `setAccessible(true)` 只减少其中一层检查，而不是消灭所有反射开销。
- 字段反射的优化路线不同，说明 JDK 面对不同操作类型会选择不同的性能折中。

收成“反射性能四项成本 + 两类优化路线 + 一条热度切换链”，并自然引到下一篇：既然 JDK 能现场生成字节码类，那 `$Proxy0` 又是怎样凭空出现的？

## 5. 失败方案清单

1. 以为 `Method.invoke` 本体就包含了主要成本，忽略真正的执行器在 accessor 后面。
2. 一开始就为所有反射方法生成字节码 accessor。
3. 永远只走 native 调用，不在热路径上切换实现。
4. 把 15 当成“第 15 次开始切换”，忽略源码实际是“> 15”。
5. 以为 `noInflation=true` 只是调大阈值，实际它会直接跳过 native 期。
6. 以为 `setAccessible(true)` 会让反射完全接近直接调用，忽略 boxing、异常包装和 accessor 转发。
7. 以为字段访问器也会像方法一样经历 `native → generated` 膨胀。

## 6. 误解清单

1. `Method` copy 之间不共享 accessor；上一篇已证明它们沿 root 共用底层执行器。
2. Delegating 层只是多余跳板；它正是运行时换实现的稳定入口。
3. 反射慢只因为 JNI；访问检查、参数包装、异常包装同样是成本。
4. 默认阈值 15 是 JVM 规范要求；它只是 JDK 11 当前实现默认值。
5. `sun.reflect.noInflation` 会让反射“总是更快”；低频场景下它可能把生成成本前置。
6. 字段访问器是通过生成字节码加速；JDK 11 这里主要走 Unsafe 偏移。
7. `setAccessible(true)` 同时解决访问控制和模块封装；模块边界不在本文解决。

## 7. 证据清单

- `Method.java:552-566`：`Method.invoke` 主入口。
- `Method.java:623-637`：`acquireMethodAccessor`。
- `DelegatingMethodAccessorImpl.java:33-48`：委托层与 `setDelegate`。
- `ReflectionFactory.java:87-88`：默认 `noInflation=false`、`inflationThreshold=15`。
- `ReflectionFactory.java:189-220`：`newMethodAccessor` 默认路径与 `noInflation` 直生成路径。
- `ReflectionFactory.java:682-710`：阈值与开关属性读取。
- `NativeMethodAccessorImpl.java:43-69`：计数、膨胀、native `invoke0`。
- `MethodAccessorGenerator.java:68-84`：字节码 accessor 生成入口。
- `ReflectionFactory.java:175-187`：字段 accessor 工厂入口。
- `Field.java:1081-1086`：字段 `override` 访问器选择。
- `UnsafeFieldAccessorFactory.java:32-104`：字段类型分流与 Unsafe accessor 工厂。
- `UnsafeFieldAccessorImpl.java:46-52`：字段偏移计算。

## 8. 版本与边界

- 基于 JDK 11 `java.base`；后续版本可能在反射调用优化上有不同实现与模块策略。
- `NativeMethodAccessorImpl` / `MethodAccessorGenerator` / `UnsafeFieldAccessorFactory` 属于 JDK 11 当前实现，不是 Java 反射 API 规范承诺。
- `sun.reflect.*` 属性为 JDK 兼容开关；是否建议业务显式调整取决于运行环境，正文不能写成普适调优处方。
- 字段访问器这里讨论的是 JDK 11 反射实现，不等于 `VarHandle`、`MethodHandle` 或字节码框架的替代路径。
- 模块封装与 `InaccessibleObjectException` 已在 03 篇展开；本文只提性能，不重复论证模块访问规则。

## 9. 删除代码测试与最终验收标准

- 删除全部代码块后，读者仍能复述“短入口 → 三层 accessor → 热度阈值切换 → 字段走另一条 Unsafe 路线”的主线。
- 小标题能够还原“热路径事故 → 失败方案 → 顿悟 → 机制 → 收网”。
- 至少解释三个失败方案：总是 native、总是 generated、把字段和方法混成同一路线。
- 对 `setAccessible(true)` 的收益必须说清具体省掉哪层，不得写成空泛经验话。
- 必须明确哪些是 JDK 11 当前实现，哪些只是 API 契约或热路径经验。
- 结尾自然衔接下一篇：如果 JDK 能给 Method 动态生成 accessor，那 `Proxy` 动态代理又是怎样生成整类字节码的。
