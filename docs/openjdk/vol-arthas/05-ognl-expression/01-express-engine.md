# 13. 为什么一个表达式引擎会牵出最深的卸载边界？——OGNL 执行链、WeakReference 与 ClassLoader 可回收性

> 基于 `arthas` 当前源码实现讨论；本文聚焦 OGNL 表达式引擎本身的执行链与可卸载边界，不重复展开上一章 `SpyAPI -> AdviceListener` 回调链，也不把下一篇 `ognl` / `tt -s/-w` 的使用场景提前写成本篇主线。
> **前置依赖**：[13 —— 一张面板为什么不等于一套新监控系统？](../04-dashboard-runtime/02-dashboard-data.md)：知道 Arthas 里的表达式不只是命令行语法，而是具体服务于 watch、tt 和模型输出的运行时能力。
> → **后续**：OGNL 使用与类加载器绑定——`ognl`、`tt -s/-w` 和表达式副作用。
> 关联域：ThreadLocal、WeakReference、ClassResolver、反射可见性。
> 本篇所有源码锚点均已回对，不靠猜。

## 先看真正的冲突：一行表达式既要高频执行，又不能把 Arthas 自己永远钉死在线程里

场景：你在 `watch` 中写下：

```text
watch -e 'params[0] > 100' com.example.Service doBiz
```

对使用者来说，这只是一行条件表达式；对 Arthas 来说，它背后同时压着三类互相拉扯的要求：

- 表达式可能在每一次业务方法回调里高频执行，不能每次都从零构造一个执行器；
- 表达式又要能看到 Advice 里的 `params`、`target`、`throwExp`、`returnObj`，还要能读 private 字段；
- 更危险的是，表达式对象本身由 ArthasClassLoader 加载，如果被业务线程的 `ThreadLocal` 强引用长期保活，stop/detach 之后就可能把整个 ArthasClassLoader 钉死在内存里。

所以本篇真正要回答的不是：

> OGNL 语法怎么写？

而是：

> **为什么一行表达式背后，会同时牵出“高频执行开销”“运行时可见性”“类加载器卸载边界”这三个问题，而 Arthas 又是怎样把它们压进同一条表达式执行链里的？**

先把全篇总图立住：

```text
表达式字符串
  → ExpressFactory 给当前线程取一个可重建的 Express 入口
    → OgnlExpress 固定 OGNL 上下文策略
      → Advice 作为根对象绑定到上下文
        → ClassResolver 解释 @类@静态成员
          → is()/get() 执行条件判断或结果求值
```

这张图里最重要的一刀就是：

```text
Arthas 复用的是“线程级访问入口”
而不是强行保活某个由 ArthasClassLoader 加载的表达式对象
```

后面所有细节，都围绕这条边界展开。

---

## 一、先排除两个最直觉、也最容易出大问题的方案

### 1. 每次都 new 一个表达式执行器

一个最直觉的方案当然是：

```text
每次回调触发表达式
  → new 一个 OgnlExpress
    → 执行完就丢掉
```

这在功能上能跑通，但在 `watch` 这种高频场景里会带来不必要的对象构造和上下文初始化开销。表达式本身可能只是 `params[0] > 100` 这种很短的判断，却要在每次回调都重新 new 执行器，成本显然偏高。

### 2. 用 ThreadLocal 强引用复用 Express

第二个看似更聪明的方案是：

```text
给每个业务线程一个 ThreadLocal<Express>
  → 下次直接复用
```

这就把性能问题转成了更危险的卸载问题。因为 `Express` 对象是由 ArthasClassLoader 加载的，如果 ThreadLocal 的 value 里强引用着它，那么链路会变成：

```text
Thread
  → ThreadLocalMap
    → value
      → Express
        → ArthasClassLoader
```

业务线程往往活得很久；一旦它的 ThreadLocalMap 强引用了这个 Express，Arthas stop/detach 之后，ArthasClassLoader 也可能被连带留在内存里。

这就是本篇最关键的冲突：**你既想复用执行入口，又不能用强引用把整个表达式引擎和 ArthasClassLoader 永久拴在线程上。**

---

## 二、第一层：`ExpressFactory` 为什么要做成 `ThreadLocal<WeakReference<Express>>`

### 2.1 Arthas 真正复用的不是对象本身，而是“线程级入口”

`core/command/express/ExpressFactory.java:18-19` 定义的是：

```java
ThreadLocal<WeakReference<Express>>
```

这不是一个“小技巧”，而是对上面两种失败方案的正面回答：

- 不想每次都 new，所以保留线程级访问入口；
- 又不能强引用 Express，所以只保留 `WeakReference`。

换句话说，Arthas 复用的是：

```text
这个线程下次去哪里拿 Express
```

而不是：

```text
这个线程必须永远保住上一次那个 Express 对象
```

关键设计（斜体）：*复用的是访问入口，不是对象存活本身。*[模式: ThreadLocal + WeakReference + 自动重建] 线程可以长期存在，但 Express 对象在不再被强引用时应允许自然回收。

### 2.2 `threadLocalExpress(object)` 真正做了什么

`threadLocalExpress(object)` 在 `ExpressFactory.java:26-33`：

1. 取当前线程的 `WeakReference`；
2. 尝试 `reference.get()`；
3. 如果对象已经被 GC，就重新 new `OgnlExpress` 并放回新的 `WeakReference`；
4. 调 `reset().bind(object)`，清掉旧上下文并绑定当前根对象。

这说明 ExpressFactory 真正维护的是一种“可重建的局部缓存”语义：

- 在对象还活着时尽量复用；
- 一旦对象已被回收，就当作正常情况重建；
- 不把“对象必须一直活着”写成架构约束。

### 2.3 为什么这里必须显式 `reset().bind(object)`

`reset()` 和 `bind(object)` 连在一起并不是多余。前者清掉旧上下文，后者把这次 Advice 现场重新绑定成根对象。否则你复用到的可能是上一次命令或上一次方法调用遗留的上下文状态。

也就是说，Arthas 在这里复用的是执行器壳子，但每次都要重新绑定本次现场。

---

## 三、第二层：`OgnlExpress` 为什么要把 OGNL 的上下文策略提前固定下来

### 3.1 它不是简单调一次 `Ognl.getValue()`

`core/command/express/OgnlExpress.java:16-65` 并不是把表达式字符串直接扔给第三方库，而是在构造时就固定了三项策略：

1. `MEMBER_ACCESS = new DefaultMemberAccess(true)`（`:17`）；
2. `OgnlRuntime.setPropertyAccessor(Object.class, OBJECT_PROPERTY_ACCESSOR)`（`:28-30`）；
3. `new OgnlContext(MEMBER_ACCESS, classResolver, null, null)`（`:30`）。

这说明 Arthas 不是“随便拿 OGNL 来用”，而是在把 OGNL 收编进自己的表达式接口时，先把访问控制、属性访问器和类解析器都封装进一个固定上下文。

### 3.2 为什么 `get()` 和 `is()` 要分成两种语义

执行入口有两个：

```java
get(express) → Ognl.getValue(express, context, bindObject)
is(express)  → get(express) → 只接受 Boolean true
```

对应 `OgnlExpress.java:33-47`。

这条边界非常重要：

- `get()` 负责表达式求值，返回对象结果；
- `is()` 负责条件判断，只在结果是 `Boolean` 且为 true 时才算成立。

也就是说：

- 字符串 `"true"`
- 数字 `1`
- 其他“看起来 truthy” 的值

都不会被 `is()` 当成条件成立。

关键设计（斜体）：*条件判断采用严格 Boolean 语义，结果求值则保留 OGNL 的对象能力。*[模式: 适配器 + 策略上下文] Arthas 不把第三方表达式库的宽泛结果语义直接原样暴露给诊断命令的条件判断。

### 3.3 为什么这里必须提前固定策略，而不是交给调用方临时决定

如果访问器、MemberAccess、ClassResolver 都由调用方自己零散传入，那么：

- watch 的条件语义可能和 `ognl` 命令不一致；
- 一些命令能看 private 字段，另一些又不能；
- 类解析的 loader 选择可能在不同入口各写一套。

所以 OgnlExpress 在这里真正解决的是“策略一致性”，而不是简单封装第三方调用。

---

## 四、第三层：为什么 Advice 必须是表达式的根对象，而不是随手给一张 Map

### 4.1 表达式真正访问的是“结构化现场”

上一章的 `AdviceListenerAdapter.isConditionMet()` 和 `getExpressionResult()` 会把 Advice 交给表达式工厂。这里的 Advice 不是一张普通 Map，而是一次方法调用的结构化现场：

- `params`
- `returnObj`
- `throwExp`
- `target`
- `clazz`
- `method`
- `locals`
- 以及 listener 额外绑定进去的 `cost`

所以：

```text
params[0] > 100
```

并不是 OGNL 自己“知道”业务方法参数，而是它在 Advice 根对象上取 `params`。

### 4.2 为什么 `cost` 不是 Advice 的字段

这也是一个很值得保留的边界：`cost` 不是 Advice 自身的字段，而是 listener 计算后再绑定进表达式上下文的变量。这说明表达式引擎不是现场的产生者，它只消费：

- Advice 这种结构化现场；
- 以及 listener 补充进去的额外观测变量。

关键设计（斜体）：*表达式引擎不制造现场，它只在给定现场与补充上下文上做读取和求值。*[模式: 结构化根对象 + 附加绑定]

### 4.3 为什么不用普通 Map 直接喂给 OGNL

如果只塞一张任意结构的 Map：

- 字段语义会在不同命令里漂移；
- `method`、`target`、`locals` 的组织方式会散掉；
- 不同 listener 可能各自发明自己的表达式变量表。

Advice 作为统一根对象，恰恰是在保证：**不同命令看到的是同一套现场抽象。**

---

## 五、第四层：为什么 private 可见性和属性写保护必须分成两条边界

### 5.1 为什么 Arthas 故意放开 private/protected/package-private 访问

`core/command/express/DefaultMemberAccess.java:26-31` 控制 private、protected 和 package-private 访问。Arthas 使用：

```java
new DefaultMemberAccess(true)
```

这意味着表达式可以触达普通 Java 反射默认不可见的成员。

这对诊断是很有价值的：问题状态经常就藏在 private 字段、静态单例或内部对象里。若还坚持默认反射可见性，很多线上诊断场景会直接失明。

### 5.2 为什么“能访问”不等于“没有副作用”

但这里又必须主动收紧另一条边界：private 字段可见，不等于表达式从此就天然只读。

OGNL 表达式里的方法调用仍可能：

- 真正执行业务方法；
- 修改对象状态；
- 触发外部调用。

所以 Arthas 把“能看见”与“是否允许改写”拆开：

- `DefaultMemberAccess(true)` 放开诊断可见性；
- `ArthasObjectPropertyAccessor` 在 strict 模式下对属性写入施加限制。

关键设计（斜体）：*Arthas 放开的是诊断可见性，不是方法副作用豁免权。*[模式: 能力放开 + 写入闸门]

### 5.3 为什么这两条边界必须分开

如果把它们混成一句“OGNL 可以访问 private”，读者很容易误会成“表达式只是读数据，不会产生影响”。而实际上：

- 读字段是一回事；
- 调方法又是另一回事。

这也是下一篇必须继续讲清楚的风险边界。

---

## 六、第五层：`@类@静态成员` 为什么必须经过 ClassResolver，而且 loader 选择会改变结果

### 6.1 Advice 字段和 `@类@成员` 不是同一条解析路径

这是本篇最容易讲混的一点：Advice 根对象上的 `params`、`target`、`locals` 等字段，来自真实调用现场，不需要重新解析类；但如果表达式里写的是：

```text
@com.example.Config@INSTANCE
```

那就是另一条解析路径：必须先把字符串类名解析成真正的 `Class`。

### 6.2 为什么 ClassResolver 的选择会决定命中哪个版本

如果应用里存在多个 ClassLoader 和多个同名类，ClassResolver 选哪个 loader，就决定了表达式最终访问哪个版本。

默认 `OgnlExpress()` 用的是 `CustomClassResolver.customClassResolver`（`OgnlExpress.java:24-26`）；指定目标 ClassLoader 时，`ExpressFactory.unpooledExpress(classloader)`（`ExpressFactory.java:36-41`）会创建带 `ClassLoaderClassResolver` 的 OgnlExpress。

`ClassLoaderClassResolver` 在 `core/command/express/ClassLoaderClassResolver.java:12-28` 中直接用指定 loader 的 `loadClass(className)` 解析。

### 6.3 为什么 `-c <classloader-hash>` 有意义

这也解释了 `-c <classloader-hash>` 的真正意义：它不是改变 Advice 根对象，而是把：

```text
@类@静态成员
```

这类解析绑定到指定版本的类加载器世界。

关键设计（斜体）：*Advice 现场字段不需要再解析类；但静态类引用必须经过 ClassResolver，而 loader 选择就是结果的一部分。*[模式: ClassLoader 感知解析 + 缓存]

---

## 收网：Arthas 复用的是线程级表达式入口，不是把表达式对象永久钉在线程里

现在把整条链收成一张图：

```text
表达式字符串
  → ExpressFactory 给当前线程取一个 WeakReference 包裹的 Express 入口
    → OgnlExpress 固定 MEMBER_ACCESS / PropertyAccessor / ClassResolver 策略
      → reset().bind(Advice)
        → is()/get() 做严格 Boolean 条件判断或结果求值
          → Advice 提供现场，listener 提供 cost 等附加上下文
            → stop/detach 后 Express 可被回收，下次需要再自动重建
```

把这张图压成一句话，就是：

**Arthas 既不愿意在每次回调里从零 new 一个表达式执行器，也不能把由 ArthasClassLoader 加载的 Express 强引用在线程里；所以它通过 `ThreadLocal<WeakReference<Express>>` 复用线程级访问入口，再用 `OgnlExpress` 固定访问策略、用 Advice 统一现场根对象、用 ClassResolver 明确类版本边界，让表达式既能高频执行，又不会把 Arthas 自己钉死在业务线程上。**

到这里为止，主线其实只发生了四件事：

- 复用入口，不强保活对象；
- 固定策略，不把上下文语义散给调用方；
- 统一根对象，不让不同命令各造一套变量世界；
- 放开可见性，但保留副作用边界与 ClassLoader 边界。

这也解释了为什么一个看起来只是“字符串求值”的功能，会牵出整个 Arthas 最深的卸载设计：**真正危险的从来不是语法，而是表达式对象活在业务线程里、却由 ArthasClassLoader 加载时，谁该负责让它可复用、可访问、可回收。**

跨层标注：[ThreadLocal——线程级访问入口的缓存与 stop/detach 后卸载边界]；[WeakReference——允许 Express 对象自然回收并按需重建]；[AR-2 Advice——表达式根对象来自真实方法现场]；[AR-1 ClassLoader——静态类解析的版本边界]；[反射可见性——private 可见与写入/副作用边界分离]

本篇解决的是“为什么一个表达式引擎会同时牵出可见性、副作用和类加载器卸载边界”。下一篇继续进入真正的使用面：**`ognl`、`tt -s/-w` 和 `watch` 这些命令，怎样把这条表达式引擎链落到具体语法、类加载器选择和副作用风险上？**

**→ 下一篇：OGNL 使用场景与表达式副作用。**
