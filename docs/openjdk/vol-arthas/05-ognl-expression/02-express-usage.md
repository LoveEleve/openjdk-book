# 15. 同一套表达式引擎，为什么在不同命令里会做完全不同的事？——watch、ognl、tt 的生效点与副作用边界

> 基于 `arthas` 当前源码实现讨论；本文聚焦 watch / ognl / tt -s/-w 这些命令里的表达式生效点与副作用边界，不重复展开上一章 ExpressFactory / OgnlExpress / WeakReference 的底层可卸载设计，也不把下一篇 profiler 的细节提前写成本篇主线。
> **前置依赖**：[13 —— 为什么一个表达式引擎会牵出最深的卸载边界？](../05-ognl-expression/01-express-engine.md)：知道 Arthas 怎样用 `ThreadLocal<WeakReference<Express>>`、Advice 根对象和 ClassResolver 管住表达式引擎的可见性与回收边界。
> → **后续**：AR-6 Profiler——从插桩观察切换到采样观察。
> 关联域：Advice、TimeTunnel、ClassLoader 绑定、表达式副作用。
> 本篇所有源码锚点均已回对，不靠猜。

## 先看真正的分叉：同一套 OGNL 语法，为什么在不同命令里会承担完全不同的职责

场景：你在 Arthas 里会同时看到这些写法：

```text
watch -e 'params[0] > 100' 'params[0]' ...
ognl '@java.lang.System@out.println("hello")'
tt -s 'params[0] > 100'
tt -w 'returnObj'
```

如果只看语法，它们都像是在“执行一个 OGNL 表达式”。于是一个很自然的直觉就会冒出来：

> 既然底层引擎都是同一个，那这些命令应该只是把表达式字符串交给同一个黑盒执行，差别只在于输入参数不同。

这正是最容易讲糊的地方。

同样一套表达式引擎，在不同命令里其实承担的是完全不同的职责：

- 在 `watch` 里，表达式先是**守卫条件**，再是**输出投影**；
- 在 `ognl` 命令里，它脱离 Advice 现场，变成一个**独立执行器**；
- 在 `tt -s` 里，它像一个**批量筛选器**；
- 在 `tt -w` 里，它又更像一个**单条历史现场取值器**。

所以本篇真正要回答的不是：

> OGNL 语法怎么在这些命令里复用？

而是：

> **同样一套 OGNL 引擎，为什么在 `watch` 里它先是条件守卫、后是结果投影；在 `ognl` 命令里它又变成脱离 Advice 的独立执行器；在 `tt -s/-w` 里它还会在“批量筛选历史现场”和“单条历史取值”之间切换不同执行策略？这些差异为什么会直接决定副作用边界？**

先把全篇总图立住：

```text
同一套表达式引擎
  → watch：先 isConditionMet()，后 getExpressionResult()
  → ognl：脱离 Advice 的独立执行器
  → tt -s：批量遍历历史 Advice，用池化 Express 做筛选
  → tt -w：单条历史 Advice，用指定 ClassLoader 的一次性 Express 取值
```

这张图里最重要的一刀就是：

```text
表达式引擎本身并不决定副作用边界
真正决定边界的是：表达式在什么命令里、绑定什么上下文、以什么频率和策略被执行
```

后面所有细节，都围绕这条边界展开。

---

## 一、先排除几个最直觉、也最容易让表达式语义失真的方案

### 1. 把条件表达式和结果表达式合成一次求值

在 `watch` 里，用户常常会同时写：

- `-e 'params[0] > 100'`
- 最后的结果表达式 `'params[0]'`

一个最直觉的想法是：

> 反正都是 OGNL，为什么不一次求值把“该不该输出”和“输出什么”都做了？

这个方案会马上把两个不同职责混在一起：

- 条件表达式只需要回答 true/false；
- 结果表达式则可能返回复杂对象，还会触发对象展开与渲染。

如果条件还没过，就先去做复杂结果求值，你已经白白付出了表达式执行和对象处理成本；更糟的是，条件和结果在语义上也不再分明。

### 2. 把 `ognl` 命令当成只读查询器

另一种常见误解是：

> `ognl` 反正只是看对象值、看静态字段，应该天然是无副作用查询。

这也不成立。`ognl` 可以：

- 访问静态成员；
- 组装局部变量；
- 调用方法；
- 指定 ClassLoader 去解析某个类版本。

也就是说，它本质上更像一个“直接执行表达式的入口”，而不是“帮你安全看一眼对象”的只读工具。

### 3. 把 `tt -s` 和 `tt -w` 当成同一种场景

`tt -s` 和 `tt -w` 都是在历史 Advice 上执行表达式，于是也很容易被看成“只是命令参数不同”。

可它们面对的工作负载完全不同：

- `tt -s` 是对很多 TimeFragment 做批量筛选；
- `tt -w` 是对单个历史现场做一次性取值。

如果强行用同一策略：

- 批量筛选会承担不必要的一次性构造成本；
- 单条取值又可能丢失最关键的 ClassLoader 绑定精度。

所以本篇的核心不是“表达式引擎怎么复用”，而是“同一引擎在不同生效点上为什么必须换职责和执行策略”。

---

## 二、第一层：watch 为什么要先做条件守卫，再做结果投影

### 2.1 `watch` 里其实有两次完全不同的表达式语义

看这条命令：

```text
watch -e 'params[0] > 100' 'params[0]' com.example.Service doBiz
```

这里并不是“一条表达式在两个地方被顺手用了”，而是两个职责截然不同的表达式：

- `-e`：决定这次调用要不要留下记录；
- 最后的表达式：决定留下来之后到底输出什么。

所以 `AdviceListenerAdapter` 很克制地把这两件事拆成了两个方法：

- `isConditionMet(String conditionExpress, Advice advice, double cost)`（`AdviceListenerAdapter.java:132-135`）；
- `getExpressionResult(String express, Advice advice, double cost)`（`:137-139`）。

### 2.2 为什么条件守卫必须先于结果投影

`isConditionMet()` 的核心是：

```java
StringUtils.isEmpty(conditionExpress)
    || ExpressFactory.threadLocalExpress(advice)
        .bind(Constants.COST_VARIABLE, cost)
        .is(conditionExpress)
```

空条件直接放行；只有非空条件才进入 OGNL。

这说明 watch 的语义顺序非常明确：

```text
先判断值不值得留下
  → 再决定要展示什么
```

而 `getExpressionResult()` 则再次取 Express，绑定 `cost`，调用 `.get(express)` 返回任意对象。也就是说，watch 很可能在同一次回调里做两次 OGNL 求值——一次为了守门，一次为了取值。

关键设计（斜体）：*条件是守卫，结果是投影。*[模式: 守卫条件 + 结果投影] 不先过守门关，就不该进入昂贵或复杂的结果求值和对象展开。

### 2.3 为什么“同样字符串也不能自动共享结果”

即使条件表达式和结果表达式字符串碰巧相同，也不意味着 Arthas 会把它们自动合并成一次求值。因为它们在命令语义上代表的是两种职责：

- 一个回答“要不要留下”；
- 一个回答“留下什么”。

如果把职责揉成一次求值，watch 的可预测性就会开始模糊。

---

## 三、第二层：`cost`、Advice 根对象和变量绑定，为什么不是同一种来源

### 3.1 Advice 提供的是现场，`cost` 提供的是附加上下文

表达式里的：

```text
params[0]
target
returnObj
throwExp
clazz
method
```

都来自 Advice 根对象；而 `cost` 并不是 Advice 的字段，它是 listener 算出来之后，再绑定进表达式上下文的临时变量。

`cost` 的绑定键来自 `core/util/Constants.java:40`：

```java
public static final String COST_VARIABLE = "cost";
```

而旧的帮助文案在 `core/command/Constants.java:12-22` 里可能写成 `#cost`。这种时候，真正该信的是运行时实际绑定的键和值，而不是帮助文本遗留表述。

### 3.2 为什么 Advice 不是一张随手拼出来的 Map

Advice 代表的是结构化方法现场，不是一张任意拼接的 Map。OGNL 能直接访问 `params`、`target`、`returnObj` 等，是因为它把 Advice 当成根对象，而不是因为这些名字天生存在于 OGNL 世界里。

这条边界很重要：

- Advice 属性来自回调现场；
- `cost` 这类临时变量来自显式 `bind`。

如果把两者混成“表达式里总有一堆魔法变量”，你就很难再判断到底是谁在提供上下文。

关键设计（斜体）：*Advice 提供的是现场结构，`bind()` 提供的是这次求值额外需要的上下文。*[模式: 结构化根对象 + 显式附加变量]

### 3.3 为什么这会影响表达式的理解和调试

一旦表达式结果不对，排查就要分清：

- 是 Advice 根对象本身没有这个字段；
- 还是某个临时变量没有被正确绑定；
- 还是帮助文案和真实绑定名不一致。

这也是为什么本篇不把“变量可用列表”写成静态表，而要把变量来源本身讲清楚。

---

## 四、第三层：为什么 `ognl` 命令天然更强，也天然更危险

### 4.1 `ognl` 并没有一个天然的 Advice 根对象

`core/command/klass100/OgnlCommand.java:31-40` 定义了 `ognl` 命令。它的帮助示例已经暴露了能力边界：

```text
ognl '@java.lang.System@out.println("hello")'
ognl '@Demo@staticField'
ognl '#value1=@System@getProperty("java.home"), {#value1}'
ognl -c <classloader-hash> '@SomeClass@staticField'
```

与 watch 不同，`ognl` 并没有一个天然的 Advice 根对象。`OgnlCommand.process()` 会创建带目标 ClassLoader 的一次性 Express，并用 `bind(new Object())` 作为根对象（`OgnlCommand.java:103-107`）。

这说明 `ognl` 的核心定位不是“在当前调用现场里做条件判断”，而是“给你一个直接执行表达式的入口”。

### 4.2 为什么 `-c <classloader-hash>` 会直接改变表达式结果

`-c` 参数在 `OgnlCommand.java:49-69` 控制 ClassLoader hash。找到目标 loader 后，命令会用带指定 ClassLoader 的 Express 执行表达式。

这件事非常关键，因为一旦表达式里有：

```text
@SomeClass@staticField
```

解析命中哪个版本，完全取决于当前 Express 绑定的是哪个 ClassLoader 解析器。

也就是说，`ognl` 不是脱离类加载器世界的“通用查询器”，而是一个对 ClassLoader 边界非常敏感的运行时执行器。

### 4.3 为什么它的副作用边界比 watch 更直接

watch 的表达式至少还被包在：

- 先有方法回调；
- 再做条件判断；
- 再做结果投影；

这条链里。

而 `ognl` 更接近直接执行：你可以访问静态成员、组合变量、调用方法。它不天然附带“这是观察语义，不是执行语义”的保护带。

关键设计（斜体）：*`ognl` 不是 watch 的语法变体，而是一个更接近“立即执行表达式”的独立入口。*[模式: 独立执行器 + ClassLoader 绑定] 能力越强，副作用边界就越直接。

---

## 五、第四层：为什么 `tt -s` 和 `tt -w` 在历史现场上要选不同策略

### 5.1 `tt -s` 是批量筛选，不是单次取值

`TimeTunnelCommand.processSearch()` 在 `TimeTunnelCommand.java:398-440`：它会遍历已保存的 TimeFragment，对每个 fragment 的 Advice 执行搜索表达式：

```java
for (...) {
    Advice advice = ...;
    if (ExpressFactory.threadLocalExpress(advice).is(searchExpress)) {
        ...
    }
}
```

这里面对的是很多历史片段，所以更适合：

- 复用 ThreadLocal WeakReference 池里的 Express；
- 每次重新 bind 当前 Advice；
- 让大量筛选不必反复 new 完整执行器。

### 5.2 `tt -w` 是单条历史现场取值，不是批量筛选

`TimeTunnelCommand.processWatch()` 在 `TimeTunnelCommand.java:370-395`：

```java
ExpressFactory.unpooledExpress(advice.getLoader())
    .bind(advice)
    .get(watchExpress)
```

这里为什么不用同一个池？因为它面对的不是“成百上千条 Advice 的批量筛选”，而是：

- 一次；
- 单条；
- 对特定历史现场；
- 并且要更强调原始调用发生时的 ClassLoader 绑定。

也就是说：

- `tt -s`：要的是筛选效率；
- `tt -w`：要的是单条精度和 loader 绑定的明确性。

关键设计（斜体）：*同样面对历史现场，批量筛选和单条取值是两种完全不同的工作负载。*[模式: 池化筛选 + 一次性精确取值]

### 5.3 为什么这直接影响副作用边界

`tt -s` 更像“在很多历史片段上跑一个条件筛子”；
`tt -w` 更像“拿一条确定的历史现场做精确取值”。

它们虽然都在用同一套 OGNL 引擎，却不该共享同一种执行策略，否则要么浪费批量场景成本，要么损伤单条场景的上下文精度。

---

## 六、第五层：表达式是最后一道闸门，但不是零成本观察

### 6.1 表达式发生在回调之后，不等于它就免费

完整链路是：

```text
业务方法
  → SpyAPI / SpyImpl
    → listener.before / after
      → isConditionMet
        → OGNL Boolean 判断
          → getExpressionResult
            → WatchModel / TimeTunnelModel
```

表达式确实发生在：

- 字节码已经织入；
- 回调已经命中；
- listener 已经开始处理之后。

这意味着它不决定“类要不要增强”，但它仍然会决定：

- 这次事件是否输出；
- 输出什么对象；
- 要不要遍历复杂对象图；
- 要不要触发方法调用。

### 6.2 为什么“最后一道闸门”不等于“免费过滤器”

表达式求值仍然可能带来：

- 反射访问成本；
- 对象遍历与展开成本；
- 方法调用副作用；
- 类加载器解析成本。

所以条件应尽量写得窄，输出表达式也应避免无界展开。否则你虽然把表达式放在最后一道闸门上，但这道闸门自己可能已经很重了。

关键设计（斜体）：*表达式是最后一道闸门，不代表它没有成本；它只是把“要不要留下、留下什么”放到了回调链最末端去决定。*[模式: 最后闸门 + 成本显式化]

---

## 收网：同一引擎，不同生效点；生效点决定副作用边界

现在把整条链收成一张图：

```text
同一套 OGNL 引擎
  → watch：先 isConditionMet() 守门，再 getExpressionResult() 投影
  → ognl：脱离 Advice 的独立执行器，直接面向 ClassLoader 和方法调用
  → tt -s：批量遍历历史 Advice，复用 ThreadLocal 弱引用池做筛选
  → tt -w：绑定单条历史 Advice 和原始 loader，做一次性精确取值
```

把这张图压成一句话，就是：

**Arthas 并不是让一套 OGNL 引擎到处都做同一件事，而是让同一引擎在不同命令里承担不同职责：watch 先守门再投影，ognl 直接执行，tt 则在批量筛选和单条取值之间切换策略；也正因为生效点不同，副作用边界才会不同。**

到这里为止，主线其实只发生了四件事：

- 条件守卫和结果投影不能混成一次求值；
- Advice 根对象和 `cost` 绑定必须区分来源；
- `ognl` 的能力更强，所以风险也更直接；
- `tt -s` 与 `tt -w` 面对不同工作负载，因此必须切换不同策略。

这也解释了为什么同一套表达式引擎在 Arthas 里看起来像几个不同工具：**引擎没变，变化的是表达式在整条诊断链里的生效位置；而生效位置一变，副作用边界也就跟着变了。**

跨层标注：[AR-2 AdviceListenerAdapter——条件判断与结果求值的两个生效点]；[AR-2 Advice——表达式根对象的结构化现场]；[AR-2 TimeTunnel——历史 Advice 的批量筛选与单条取值]；[AR-1 ClassLoader——`-c` 与 `advice.getLoader()` 决定类解析边界]

本篇解决的是“为什么同一表达式引擎在 watch、ognl、tt 里会承担不同职责，以及这些职责各自的副作用边界是什么”。下一篇继续从插桩观察切换到另一种范式：**如果不想把表达式和字节码观察一直压在业务方法上，Arthas 为什么还需要委托 async-profiler 去做采样式观察？**

**→ 下一篇：Arthas Profiler 如何委托 async-profiler。**
