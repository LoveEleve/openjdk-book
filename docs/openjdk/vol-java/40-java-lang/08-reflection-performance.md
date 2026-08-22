# 反射、MethodHandle 与动态代理的调用成本：慢在哪，为什么慢，什么时候值得绕过

> 基于 JDK 11 `jdk.internal.reflect.ReflectionFactory`（`ReflectionFactory.java:88` 的 `inflationThreshold = 15`、`NativeMethodAccessorImpl.java:49-62` 的 inflate 切换）、`java.lang.invoke.MethodHandles`（`MethodHandles.java:105` 的 `lookup()`）。本文讨论的是反射调用为什么初始慢、方法论上的"性能排序"为什么不可外推、以及 MethodHandle/lambda 在调用链上的位置。反射调用的 inflate 机制（先 native 调用、超过阈值后切换为字节码生成的 accessor）是 JDK 11 可观测实现；具体的"谁比谁快 N 倍"排序属于工程经验，不同 JVM、不同版本、不同调用形态下结果不同。
> **前置依赖**：[泛型方法、PECS 与类型推断](07-generics-pecs.md)
> → **后续**：按扩展计划进入诊断工具或线程转储专题

## 先看一个"越优化越慢"反直觉的调优案例

一个上游调用方来求助：某段反射调用很慢，于是他们在热路径上"预先做优化"——每次请求先 `getMethod`、再 `setAccessible(true)`，以为这样"免去了每次查找方法"的损耗。结果测下来反而更慢，因为热路径上多了一层 `getMethod` 的反射元数据查询，而真正的方法调用本身反而没省下多少。

这就是反射性能问题最典型的陷阱：**你以为慢的是"找方法"，其实慢的是"调用矩阵"本身；把优化放在"每次调用前重做一次元数据查找"上，等于在热路径上叠加了新的反射成本。**

这里至少有三个失败方案。

第一种失败方案，是拿一个固定的"性能排序表"当真理。tech-weekly 里确实流传过一种排序（直接调用 > MethodHandle > Java Compiler > Lambda > 反射），但这是某个环境下的工程观测，不是 JDK 规范。换一个 JVM、换一种调用形态（是否带参数、频率高低、JIT 是否已预热），排序就可能变化。

第二种失败方案，是以为反射调用天然"总是慢"。JDK 11 的反射有一个 inflate 机制：前若干次调用走 native 路径（`NativeMethodAccessorImpl`），超过阈值后生成本地字节码 accessor 作为 delegate（`NativeMethodAccessorImpl.java:49-62`），让 JIT 有机会进一步优化。同一个反射方法被反复调用、并且 JIT 有足够时间参与时，成本会逐渐摊薄。没有预热就量化反射性能，会把"冷启动成本"误当成"稳态成本"。

第三种失败方案，是把"绕过反射 = 一定更快"当成公理。MethodHandle 和 `LambdaMetafactory` 确实能让调用链更接近直接调用，但它引入了查找和绑定的复杂度；在低频场景下，这点提升可能完全被"多绕一层"的实现复杂性抵消。

所以这三个失败方案指向同一个顿悟：**反射性能问题要先区分"冷路径"和"热路径"。冷路径上，`getMethod` 的元数据查找、`setAccessible` 的权限处理、字节码生成 + native 切换都可能显性；热路径上，这些一次性成本被摊薄，真正决定开销的是调用链本身的形态。不区分冷热，就既看不清"为什么第一版慢"，也配不清"该往哪优化"。**

## 一、JDK 11 反射调用的 inflate 机制：先 native，超过阈值后切换为字节码 accessor

### 内部有两层 accessor，阈值是 15

JDK 11 的反射调用，`ReflectionFactory` 内部维护了一个 `inflationThreshold = 15`（`ReflectionFactory.java:88`）。反射方法首先被包装成两层 accessor：`NativeMethodAccessorImpl`（native 调用）外面再包一层 `DelegatingMethodAccessorImpl`（`ReflectionFactory.java:214-217`）。真正的切换发生在 `NativeMethodAccessorImpl.invoke()` 里：调用次数超过阈值后，用字节码生成器生成一个字节码 accessor，替换为 delegate（`NativeMethodAccessorImpl.java:49-62`）。

- 前 15 次调用：走 `NativeMethodAccessorImpl`（native 调用路径）
- 超过阈值后：生成字节码 accessor 并设为 delegate

这个"先 native、后字节码生成"的顺序，和我们直觉相反——通常我们会以为 native 更快。实际是：前几次调用量小，native 不至于成为瓶颈；而一旦方法被高频调用，JIT 可以对字节码生成的 accessor 做进一步优化，比原始 native 入口更有空间。

### 这对性能测量的影响

这意味着一个反射方法只在"首次几次调用"时走的是简单 native/生成路径，之后才进入"可被 JIT 深度优化"的稳定路径。如果你只在进程刚启动时测一次反射调用，测到的是冷路径成本；而线上经过反复调用的反射，实际已经进入了热路径。所以"反射快不快"必须分别测冷、热两态，不能用一个数字下结论。

## 二、为什么 "性能排序表" 只能当工程观测，不能当规范

### 排序依赖太多变量

tech-weekly 等工程资料里出现过类似"直接调用 > MethodHandle(static final) > Java Compiler > Lambda > Java 反射"的排序。它背后有一定道理：直接调用没有一层分派，MethodHandle 把动态派发收敛成接近直调，Lambda 最终落到 invokedynamic + LambdaMetafactory 的引导路径，反射自带 accessor 和权限处理。

但这些排序受变量影响很大：

- 方法是否带参数、参数类型是原始型还是引用型
- 调用频率是否跨过 inflate 阈值、JIT 是否有机会参与
- 是不是 static final 绑定的 MethodHandle（可以常量折叠）
- 平台、JIT 版本、JVM 供应商

### 能把这段排序当什么

这段话在文档里的作用是"给你一个方向感"：想压低调用成本时，优先级大致是从直接调用 → MethodHandle → Lambda → 反射的顺序探索优化空间。它不能作为"换上 MethodHandle 一定 N 倍加速"的承诺。真正的结论必须用你自己的基准、在你自己的调用形态下测出来。

到这里，反射"慢在哪、是不是总慢"已经讲清。接下来三节看两条更实际的东西：一是想和老反射抢访问权时，module 边界在那挡着；二是判断到底该不该绕过反射。

## 三、`MethodHandles.lookup()` 与模块对反射访问的限制

### lookup 是 caller-sensitive 的入口

`MethodHandles.lookup()`（`MethodHandles.java:105`）能创建连接调用者的查找对象。它内部携带调用者身份，因此对`private`/`protected` 的可见性判断与调用者类绑定。这就是为什么 `lookup()` 在 lambda 里或跨模块使用时表现会变——它不像反射 `setAccessible(true)` 那样可以无视访问控制强行打开（JDK 11 模块化之后，`setAccessible` 跨模块也受限）。

### 反射在 JDK 11 已经收紧

JDK 11 的 `AccessibleObject.setAccessible` 能打开无模块限制的包内访问，但对强封装模块内的类型，会抛 `InaccessibleObjectException`。这在模块化 JDK 下改变了"反射能绕开一切"的历史假设。

## 四、什么时候真的该绕过反射

### 该绕的场景

- 调用频率极高、且已确认反射是热点：用 MethodHandle 或直接接口/委托把调用链减薄
- 需要 `invokevirtual` 灵活的、可变的调用点：MethodHandle/绑定方法引用优于每次 `new` 一个 Method
- 需要在运行时动态拼装调用（框架、工具）：`LambdaMetafactory` 一次引导、之后按 lambda 形态调用

### 不该绕的场景

- 低频调用、一次性操作：`getMethod` 一次、`invoke` 若干次即可，绕开反射的收益微乎其微
- 业务价值不明的"用 MethodHandle 重写"：如果只是把反射换成 MethodHandle，却没减少调用次数、没让调用链更直，重构价值就很存疑

判断标准从来不是"反射 = 慢"，而是"这条热路径上，是不是真的多余付出了一层分派成本"。

## 五个最容易混掉的边界：慢是冷启动不是稳态，排序表是观测不是规范，lookup 是 caller-sensitive 不是万能，setAccessible 受模块限制，绕过反射不等于一定能变快

第一，慢往往是冷启动成本，不是稳态成本。反射调用在 inflate 阈值之后进入 JIT 可优化路径，没有预热的测量会把冷启动当成全程表现。

第二，性能排序表是工程观测，不是 JDK 规范。它随调用形态、参数类型、JIT 参与度变化；只能当优化方向感，不能当加速承诺。

第三，`MethodHandles.lookup()` 是 caller-sensitive 的。它的可见性判断跟调用者类绑定，不能像旧的反射 `setAccessible` 那样无差别强制打开。

第四，`setAccessible` 在 JDK 11 受模块边界限制。对强封装模块内的类型它会抛 `InaccessibleObjectException`，"反射能绕开一切"在模块化 JDK 下不再成立。

第五，绕过反射不等于一定更快。只有确认热路径上多余付出了一层分派成本、且换用 MethodHandle/接口后调用链确实更直，才值得换；低频场景的收益微乎其微。

把这五条边界记稳，反射性能问题就不会再被简化成"反射慢，所以用 MethodHandle"一句口诀。它真正想讲的是：反射调用的成本在冷、热路径下差异很大，inflate 机制决定了它的冷启动代价，而真正值得绕过的场景是"热路径上确实多付了一层分派成本"——判断它是热点、换对调用形态，才是优化的本质。

## 收网：反射的性能故事，是"冷热分离 + 调用形态"两个变量的函数

回到开头那个"越优化越慢"的案例，现在能看清它错在哪了。

它的错误不是"想优化反射"，而是把优化放在了错误的位置：每次请求都重复 `getMethod` + `setAccessible`，等于在热路径上不断叠加元数据查找。正确的优化方向是：如果确认反射是热点，就把调用链本身减薄（MethodHandle 或接口委托），而不是在每次调用前多绕一次反射元数据。

把整篇压成一张总图：

```text
反射调用
  → 冷路径：getMethod 元数据查找 + setAccessible 权限 + inflate 前 native/生成
  → 热路径：inflate 后字节码 accessor + JIT 可参与
  → 判断热点：测量要分冷/热两态

MethodHandle
  → lookup() 是 caller-sensitive
  → 绑定静态/实例方法，调用链更直
  → 值得用于高频、可变调用点

模块边界
  → setAccessible 受强封装模块限制
  → JDK 11 "反射绕开一切"不再成立

排序表
  → 方向感，不是规范
  → 优化前用自己环境测绘
```

所以当你再改一段反射代码时，真正该问的不是"反射是不是慢"，而是：**这条路径是冷还是热？如果热、且真的多付了一层分派成本，换成 MethodHandle 或接口委托才划算；如果冷，或成本已被 JIT 摊薄，绕开的收益多半不及它带来的复杂度和可读性成本。**