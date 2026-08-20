# 04-reflection-annotation/03 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `java.base` 的 `Proxy`、`ProxyGenerator`、`AccessibleObject` 和 `sun.reflect.misc.ReflectUtil`；`JPMS` 模块封装以 JDK 11 行为为准。CGLIB/ASM 仅作对照，不展开实现细节。
> 目标：把“JDK 动态代理 + setAccessible + 模块封装”改写成一篇围绕“JDK 为什么要现场造一个接口实现类，以及为什么这个时代 `setAccessible` 也不再是万能钥匙”的机制文章。

## 1. 读者困惑

- `Proxy.newProxyInstance` 为什么能把一个只有声明没有实现的接口变成可调用对象？
- `$Proxy0` 这种类到底是从哪来的，为什么 JDK 不直接拿 `InvocationHandler` 包一下接口就行？
- JDK 动态代理为什么必须要求接口，为什么不能直接代理普通类？
- `setAccessible(true)` 以前好像无往不利，为什么 JDK 9+ 以后还会报 `InaccessibleObjectException`？
- `InvocationHandler.invoke` 为什么不能 `method.invoke(proxy, args)`，死循环到底是怎么形成的？

## 2. 一句话顿悟

**JDK 动态代理不是“给接口包一层回调”，而是先生成一个真正实现接口的新类，再把所有接口方法统一汇流到 `InvocationHandler.invoke`；而 `setAccessible(true)` 只能修改反射对象的 override 状态，不能替你突破模块级封装，因此代理与反射访问控制从 JDK 9 开始被强行分层。**

## 3. 旧稿优点与问题

### 保留

- 已完整覆盖 `Proxy.newProxyInstance` → `proxyCache` → `ProxyBuilder.build` → `ProxyGenerator.generateProxyClass` → `UNSAFE.defineClass` 的主链。
- 已点到包名规则、`InvocationHandler` 死循环陷阱、`setAccessible` 与模块封装边界。
- 关键证据齐全：`Proxy.java:298/405/417/477/497/511/527/538/541/997`、`ProxyGenerator.java:321/333/337/338`、`AccessibleObject.java:182-193`、`ReflectUtil.java:116-137`。

### 必须重写

- 旧稿一开始就进入“缓存或生成”的机械流程，读者还没有先建立“接口本来没有实现、JDK 为什么必须造一个类”的动机。
- `setAccessible` 与动态代理是两条主线，旧稿只是并排讲，没有收成“同样是反射时代的越权手段，为什么一个是造类，一个是改标志”这层对照。
- “JDK 代理 vs CGLIB” 只给结论，缺少失败方案：为什么 JDK 代理不能直接代理普通类，这不是“作者偷懒”，而是生成策略限定的结果。
- `ProxyGenerator` 的说明偏百科式，需要把“固定模板方法体”写得更像一种不得不做的取舍，而不是字节码 trivia。
- 收尾需要回到框架现场：Spring AOP/MyBatis Mapper 为什么能用这套机制，JDK 9+ 又为什么让很多老框架在反射访问上栽跟头。

## 4. 理解路径

### 第一节：一个接口为什么能在运行时“长出实现”

用 Spring AOP 或 MyBatis Mapper 开场：业务代码注入的是接口，但运行时拿到的却是一个可执行对象。提出核心疑问：如果接口本身没有方法体，JDK 总得交出一个真正的类实例，否则 JVM 连 `invokevirtual` / `invokeinterface` 的目标对象都没有。

先画总图：

```text
接口 + InvocationHandler
      │
      ▼
Proxy.newProxyInstance
      │
      ├── 找已有代理类构造器
      └── 没有就生成一个实现接口的新类
                │
                ▼
         所有接口方法统一转发到 InvocationHandler.invoke
```

失败方案：把动态代理想成“JDK 偷偷拦截接口调用”，仿佛不需要真实类定义。要先让读者承认：JVM 需要一个真的类。

### 第二节：`newProxyInstance` 做的不是包回调，而是“找类或造类”

解释入口：`newProxyInstance` 先通过 `getProxyConstructor` 获取构造器，构造器来自缓存，缓存未命中才触发 `ProxyBuilder.build()`。

证据：
- `Proxy.java:298`：`proxyCache`。
- `Proxy.java:405-429`：`getProxyConstructor` 单接口/多接口路径。
- `Proxy.java:997-1011`：公开入口。

要写清的失败方案：
1. 以为每次都重新生成 `$ProxyN`。
2. 以为 JDK 代理对象只是 `InvocationHandler` 的某种 wrapper，不需要 constructor 缓存。

### 第三节：为什么 JDK 代理必须依赖接口

这是核心失败方案推演：为什么不能“直接代理普通类”？

从 `ProxyBuilder.defineProxyClass` 的包名与访问规则切入：
- 代理类最终是一个实现若干接口的新类，而不是目标类的子类。
- 非公共接口要求代理类和接口同包；全部公共接口才进 `com.sun.proxy`（命名模块下带模块名前缀）。
- 非公共接口来自不同包会直接抛异常。

证据：
- `Proxy.java:486-545`
- 尤其 `Proxy.java:497-512`、`527-545`

收束：JDK 动态代理的设计前提就是“接口方法的形态足够统一，能用模板生成一个实现类”。普通类增强需要继承和更复杂的方法体处理，这已经是 CGLIB/ASM 的问题空间，不是 `Proxy` 这套模板机制能解决的。

### 第四节：`$Proxy0` 的方法体为什么长得那么像

先回答“没有 javac 时字节码哪来”。`ProxyGenerator.generateProxyClass` 会现场拼出 class 文件字节。重点不是常量池细节，而是方法体模板：
1. 准备好对应 `Method` 对象引用。
2. 把实参装进 `Object[]`。
3. 统一调用 `InvocationHandler.invoke(this, method, args)`。

证据：
- `ProxyGenerator.java:321-338`
- `Proxy.java:538-543`

要明确的失败方案：
- 以为每个接口方法都能有任意复杂生成逻辑。
- 以为 JDK 代理支持类方法增强只是没开放 API。

强调：JDK 代理能做到“零外部依赖”，正因为它的方法体模板高度固定；这也是它必须站在“接口实现类”这边，而不是“任意字节码增强框架”这边。

### 第五节：`InvocationHandler` 为什么会死循环

把 `invoke(proxy, method, args)` 写成一个小事故：开发者在 handler 里偷懒，直接 `method.invoke(proxy, args)`，结果递归炸栈。

解释链：`proxy` 就是当前代理对象；你在 handler 里再用 `method.invoke(proxy, args)`，又会回到这个代理对象的方法入口，再次进入同一个 `InvocationHandler.invoke`。

要写清楚“正确转发对象”必须是目标对象 target，而不是 proxy 本身。这里同时把 AOP/Mapper 场景收回来：handler 的职责就是在真实对象前后夹逻辑，而不是重新调用代理自己。

### 第六节：`setAccessible(true)` 为什么不再是万能钥匙

这节要从“旧时代经验失效”的事故入手：框架以前对私有构造器/字段 `setAccessible(true)` 就能工作，JDK 9+ 却在跨模块访问时报 `InaccessibleObjectException`。

核心对照：
- `AccessibleObject.setAccessible` 本身只做权限检查并设置 `override` 标志。
- 它不负责打开模块、不负责处理包导出、更不负责给你增加 module opens。
- `ReflectUtil.checkPackageAccess` 说明旧的包访问检查仍在；模块层限制又在它之外加了一层更高边界。

证据：
- `AccessibleObject.java:182-193`
- `ReflectUtil.java:116-137`

失败方案：
1. 把 `setAccessible(true)` 当成“总能突破访问限制”。
2. 以为它和动态代理一样，都是“运行时黑魔法”，所以能力边界也一样。

要收成一句话：**代理造类解决的是“有没有实现类”，`setAccessible` 解决的是“已有成员能不能绕过 Java 语言级别访问检查”；模块系统把后者的权限边界抬高了。**

### 第七节：收网与下一篇钩子

把两条主线汇合：
- 动态代理是在运行时造一个新类，把接口方法都汇流到一个回调出口。
- `setAccessible` 只是修改反射对象的 override 状态，不能代替模块 opens。

回到框架现场：Spring AOP / MyBatis 能用 JDK 代理，是因为目标是接口且方法模板统一；JDK 9+ 老框架会因为模块封装踩坑，是因为它们把 `setAccessible` 当成了万能钥匙。

自然引到下一篇：代理和反射都把元数据变成了行为，那注解作为“元数据标签”又是怎样从 class 文件变成运行时对象的？

## 5. 失败方案清单

1. 把动态代理理解成“拦截接口调用”，忽略 JVM 仍然需要一个真实类定义。
2. 以为每次 `newProxyInstance` 都重新生成代理类，不会缓存构造器。
3. 以为 JDK 代理不能代理普通类只是 API 设计保守，忽略它本质是生成接口实现类模板。
4. 在 `InvocationHandler.invoke` 里对 `proxy` 再做 `method.invoke(proxy, args)`。
5. 以为 `setAccessible(true)` 仍然能跨模块突破所有访问限制。
6. 把 `setAccessible` 与动态代理混成同一种“黑魔法”，忽略它们解决的是不同层面的问题。
7. 以为 JDK 代理和 CGLIB 只是性能差异，忽略生成策略与适用对象完全不同。

## 6. 误解清单

1. `$Proxy0` 是 JVM 内建神秘类；它实际由 `ProxyGenerator` 现场拼出字节码。
2. 代理对象不需要真实构造器；JDK 实际缓存的是代理类构造器。
3. 只要给 `InvocationHandler` 一个接口就能工作；JVM 仍需要新类实现这些接口。
4. JDK 代理之所以要求接口只是历史偶然；它与固定模板方法体直接相关。
5. `setAccessible0` 是 native 或模块检查入口；它只是设置 `override` 标志。
6. 模块封装失败时再多调几次 `setAccessible(true)` 就行；真正缺的是 `opens` 或等价授权。
7. `method.invoke(proxy, args)` 只是多绕一层；实际上会递归回同一个 handler。

## 7. 证据清单

- `Proxy.java:298-299`：`proxyCache`。
- `Proxy.java:405-429`：`getProxyConstructor` 缓存/构建入口。
- `Proxy.java:451-462`：`checkProxyAccess`。
- `Proxy.java:472-545`：`ProxyBuilder`、包名规则、类名生成、`UNSAFE.defineClass`。
- `Proxy.java:997-1011`：`newProxyInstance` 公开入口。
- `ProxyGenerator.java:321-338`：`generateProxyClass` 与 `generateClassFile`。
- `AccessibleObject.java:182-193`：`setAccessible` / `setAccessible0`。
- `ReflectUtil.java:116-137`：包访问检查与代理类特殊处理。
- `InvocationHandler.java:93-96`：`invoke` 协议。

## 8. 版本与边界

- 基于 JDK 11；命名模块下代理类包名、模块封装行为与早期 JDK 不同。
- `UNSAFE.defineClass`、`ProxyGenerator` 和 `proxyCache` 属于 JDK 11 当前实现，不是 `Proxy` API 规范承诺的唯一实现方式。
- `setAccessible(true)` 的 override 语义属于反射 API；模块 opens 与 package access 是 JDK 9+ 运行时边界条件。
- CGLIB/ASM 只作为对照对象，不在本文展开具体字节码生成细节。

## 9. 删除代码测试与最终验收标准

- 删除代码块后，读者仍能复述“找或造代理类 → 模板方法体汇流到 handler → `setAccessible` 只改 override、不能打开模块”的主线。
- 小标题能还原“接口为何需要实现类 → 为什么必须缓存/生成 → 为什么 handler 会递归 → 为什么越权不再无条件有效 → 收网”。
- 必须把 JDK 代理要求接口的原因讲成设计约束，而不是结论记忆。
- 必须把 `setAccessible` 的边界讲清楚，不能把模块限制写成含糊经验。
- 结尾要自然衔接注解篇：既然运行时能把接口方法汇流到 handler，那 class 文件里的注解元数据又是怎样被读出来的。
