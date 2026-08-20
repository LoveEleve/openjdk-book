# 动态代理与访问控制：`$Proxy0` 为什么必须被造出来

> 本文基于 JDK 11 `java.base` 的 `Proxy`、`ProxyGenerator`、`AccessibleObject` 和 `sun.reflect.misc.ReflectUtil`。`proxyCache`、`ProxyBuilder`、`UNSAFE.defineClass` 以及命名模块下的代理类包名，都是 JDK 11 当前实现事实，不是 Java 代理 API 规定的唯一内部方案。CGLIB/ASM 只作对照，不展开其实现。
> **前置依赖**：[Class 反射视图](01-class-member-access.md)、[MethodAccessor：反射为什么不是一直都慢](02-methodaccessor.md)
> **后续**：[注解体系](04-annotation.md)

## 一个接口为什么能在运行时“长出实现”

MyBatis 的 mapper 接口没有实现类，Spring AOP 也常常只拿到一个接口类型。可业务代码照样能注入、能调用、能拿到返回值。站在 JVM 的角度看，这件事其实很怪：

接口本身没有方法体，JVM 又不能直接把一个 `InvocationHandler` 当成接口实例塞给调用方。只要代码真的写下：

```java
// 用法示意(API 形式,非源码片段)
UserMapper mapper = (UserMapper) Proxy.newProxyInstance(loader, new Class<?>[]{UserMapper.class}, handler);
```

那么运行时就必须出现一个真实对象；而只要有真实对象，背后就必须有一个真实类。

这正是动态代理最容易被讲虚的地方。很多人把它理解成“JDK 截获了接口调用”，好像接口方法天生可以被拦截、根本不需要新类。这是第一个失败方案。JDK 动态代理并不是在空中抓住一次调用，而是**先造出一个实现接口的新类，再让所有接口方法统一汇流到 `InvocationHandler.invoke`。**

```text
接口 + InvocationHandler
      │
      ▼
Proxy.newProxyInstance
      │
      ├── 找已有代理类构造器
      └── 没有就生成一个新的实现类
                │
                ▼
         代理类的每个接口方法
                │
                ▼
      InvocationHandler.invoke(proxy, method, args)
```

所以这篇文章要回答的，不是“JDK 代理有哪些 API”，而是三件更底层的事：

1. 为什么接口必须长出一个真的实现类。
2. 这个实现类 `$ProxyN` 是怎样被生成、命名和缓存的。
3. 为什么同样是反射时代常见的“黑魔法”，`setAccessible(true)` 在 JDK 9+ 以后却再也不是万能钥匙。

## 一、`newProxyInstance` 做的不是包回调，而是“找类或造类”

### 先拆掉“每次都重新生成代理类”的误解

最直觉的想法是：每次调用 `newProxyInstance`，JDK 就现场生成一个新的 `$Proxy0`、`$Proxy1`、`$Proxy2`…… 反正这些类都是运行时临时产物，生成一次和生成一百次好像没什么区别。

这会马上带来两个问题。第一，重复生成同一组接口对应的代理类纯属浪费；第二，代理类的构造器本身就是后续创建实例的入口，如果连构造器都不缓存，那么每次实例化都要重走整个造类链路。

JDK 11 的实现从一开始就没有走这条路。它缓存的不是代理实例，而是代理类构造器：

```java
// Proxy.java:298-299
private static final ClassLoaderValue<Constructor<?>> proxyCache =
    new ClassLoaderValue<>();
```

### 入口先取构造器，再决定要不要造类

公开入口 `newProxyInstance` 自己并不直接拼字节码。它先拿到一个构造器，再用这个构造器创建对象：

```java
// Proxy.java:997-1011
public static Object newProxyInstance(ClassLoader loader,
                                      Class<?>[] interfaces,
                                      InvocationHandler h) {
    Objects.requireNonNull(h);

    final Class<?> caller = System.getSecurityManager() == null
                                ? null
                                : Reflection.getCallerClass();

    Constructor<?> cons = getProxyConstructor(caller, loader, interfaces);

    return newProxyInstance(caller, cons, h);
}
```

这里的角色分工非常清楚：

- `newProxyInstance` 是对外门面。
- `getProxyConstructor` 决定“能不能复用已有代理类”。
- 真正没命中时，才进入构造器背后的造类流程。

`getProxyConstructor` 又按单接口和多接口两种情况分别查 cache；无论哪种情况，没命中时都会进入 `ProxyBuilder.build()`：

```java
// Proxy.java:405-429
private static Constructor<?> getProxyConstructor(Class<?> caller,
                                                  ClassLoader loader,
                                                  Class<?>... interfaces)
{
    if (interfaces.length == 1) {
        Class<?> intf = interfaces[0];
        if (caller != null) {
            checkProxyAccess(caller, loader, intf);
        }
        return proxyCache.sub(intf).computeIfAbsent(
            loader,
            (ld, clv) -> new ProxyBuilder(ld, clv.key()).build()
        );
    } else {
        final Class<?>[] intfsArray = interfaces.clone();
        if (caller != null) {
            checkProxyAccess(caller, loader, intfsArray);
        }
        final List<Class<?>> intfs = Arrays.asList(intfsArray);
        return proxyCache.sub(intfs).computeIfAbsent(
            loader,
            (ld, clv) -> new ProxyBuilder(ld, clv.key()).build()
        );
    }
}
```

因此，JDK 动态代理的第一层顿悟不是“它能生成类”，而是“**它总是优先找一个可复用的代理类构造器，只有没有的时候才造类**”。这也解释了为什么代理性能问题不能简单理解成“每次都编译字节码”。热路径上的同一组接口，造类成本通常只付一次。

## 二、为什么 JDK 代理必须依赖接口

### 如果不造接口实现类，JVM 根本没法交付对象

有了上一节的门面图，还得继续回答一个更根本的问题：为什么 JDK 代理总要求接口？很多回答只背一句“JDK 动态代理基于接口，CGLIB 基于继承”，但没有说清原因，于是这个结论听起来像 API 的任性限制。

真正的原因是：JDK 这套方案选择的是**生成一个实现接口的新类**。一旦设计前提定成“模板化生成接口实现类”，后面很多规则就顺着这个前提自动长出来了。

先看 `ProxyBuilder.defineProxyClass` 的包名与访问规则。JDK 11 在生成代理类前，先扫描接口列表，判断它们是否 public，以及它们来自哪个包：

```java
// Proxy.java:486-545
private static Class<?> defineProxyClass(Module m, List<Class<?>> interfaces) {
    String proxyPkg = null;
    int accessFlags = Modifier.PUBLIC | Modifier.FINAL;

    for (Class<?> intf : interfaces) {
        int flags = intf.getModifiers();
        if (!Modifier.isPublic(flags)) {
            accessFlags = Modifier.FINAL;
            String pkg = intf.getPackageName();
            if (proxyPkg == null) {
                proxyPkg = pkg;
            } else if (!pkg.equals(proxyPkg)) {
                throw new IllegalArgumentException(
                        "non-public interfaces from different packages");
            }
        }
    }
```

这里已经把约束写死了：如果代理要实现非公共接口，它自己就必须待在能访问这些接口的同包里；如果非公共接口来自不同包，那么同一个代理类就没法同时满足所有包访问条件，JDK 直接抛 `IllegalArgumentException`。

### 全 public 接口才能落到 `com.sun.proxy`

当接口全是 public 时，代理类包名才会走通用路径；命名模块和非命名模块又有细微差别：

```java
// Proxy.java:509-512
if (proxyPkg == null) {
    proxyPkg = m.isNamed() ? PROXY_PACKAGE_PREFIX + "." + m.getName()
                           : PROXY_PACKAGE_PREFIX;
}
```

这意味着代理类的“住址”不是任意的，而是由它要实现的接口集合反推出来的。类名本身则通过一个全局递增编号拼接：

```java
// Proxy.java:527-530
long num = nextUniqueNumber.getAndIncrement();
String proxyName = proxyPkg.isEmpty()
                            ? proxyClassNamePrefix + num
                            : proxyPkg + "." + proxyClassNamePrefix + num;
```

也就是说，`$Proxy0` 不是某个写死的 JDK 特殊类，而是“某个包 + `$Proxy` 前缀 + 递增编号”的产物。它之所以看起来像模板，是因为它本来就是模板生成出来的。

### 为什么不能直接代理普通类

到了这里，JDK 代理为什么要求接口，其实已经能自然推出：

- 它的字节码模板假设自己是在**实现接口**。
- 它的方法体模板也假设所有待转发的方法都可以统一收束到 `InvocationHandler.invoke`。
- 它的访问控制、包名选择和类定义策略，全都围绕“实现接口的新类”来组织。

如果把目标换成普通类，问题就变了。你不再是在生成“一个实现若干接口的新类”，而是在生成“一个继承已有类、还要处理 final、构造器、super 调用和任意已有方法体”的新类。这已经不是 `Proxy` 当前模板能覆盖的空间，而是 CGLIB/ASM 这类增强框架的问题域。

所以“JDK 代理不能代理普通类”不是偷懒结论，而是设计前提的必然结果。JDK 代理的价值恰恰在于：**只要你接受接口这个前提，它就能用一套高度固定的模板，在零外部依赖的前提下稳定生成代理类。**

## 三、`$ProxyN` 是怎样被现场拼出来的

### `ProxyBuilder` 负责把 class 文件字节交给 JVM

代理类的最终定义动作并不复杂：生成字节数组，再把它定义成类。`ProxyBuilder` 的这一段就是关键交付点：

```java
// Proxy.java:538-543
byte[] proxyClassFile = ProxyGenerator.generateProxyClass(
        proxyName, interfaces.toArray(EMPTY_CLASS_ARRAY), accessFlags);
try {
    Class<?> pc = UNSAFE.defineClass(proxyName, proxyClassFile,
                                     0, proxyClassFile.length,
                                     loader, null);
```

这段代码说明两件事：

1. `ProxyGenerator` 负责给出 class 文件字节。
2. `UNSAFE.defineClass` 负责把这些字节交给 JVM 定义成真正的类。

所以动态代理的“动态”不是虚词。这里真的发生了“运行时生成一个新的 Java 类，再加载到目标类加载器里”。

### `ProxyGenerator` 不是调用 javac，而是手工组装 class 文件

带着“JDK 到底是不是偷偷调了一次编译器”的疑问看入口就够了：`ProxyGenerator` 直接 new 出一个生成器，调用 `generateClassFile()`，然后把得到的字节数组返回给上层。

```java
// ProxyGenerator.java:333-338
static byte[] generateProxyClass(final String name,
                                 Class<?>[] interfaces,
                                 int accessFlags)
{
    ProxyGenerator gen = new ProxyGenerator(name, interfaces, accessFlags);
    final byte[] classFile = gen.generateClassFile();
```

这里先故意停在 `generateClassFile()`：对本文主线来说，真正要证明的是“JDK 自己构造了 class 文件字节”，而不是后面的调试保存分支。

这已经足以证明它不是去调用 `javac` 或依赖 ASM。JDK 11 自己维护了一套 class 文件生成器，把常量池、字段、方法等字节逐步写出来。对本文来说，最重要的不是 class 文件格式细节，而是代理方法体的模板几乎完全固定。保存生成文件的调试分支并不影响主线，这里不展开。

### 为什么所有接口方法看起来都像同一个套路

JDK 代理类的每个接口方法，本质上都在做同一套事：

1. 准备好这个接口方法对应的 `Method` 对象引用。
2. 把实参装进 `Object[] args`。
3. 调用 `InvocationHandler.invoke(this, method, args)`。

因此，代理类并没有“为每个业务接口单独设计逻辑”。它的方法体模式高度统一，差别主要体现在常量池里引用的是哪个接口方法。这种模板化正是它能无依赖生成类的原因，也是它不能轻松推广到普通类增强的原因。

换句话说，JDK 动态代理不是在理解你的业务逻辑，而是在复用一个固定公式：

```text
代理方法调用
   → 找到对应 Method 元数据
   → 组装参数数组
   → 全部汇流到 InvocationHandler.invoke
```

这条固定模板，比上一章 `MethodAccessor` 的 generated accessor 更进一步：上一章是在运行时生成一个“帮你调用某个方法”的辅助类；这一章是在运行时生成一个“实现若干接口并把所有方法汇流”的完整类。

## 四、`InvocationHandler` 为什么最容易写出死循环

### 失败方案：对 `proxy` 再做一次反射调用

理解了“所有接口方法都会汇流到 `InvocationHandler.invoke`”，就能看清动态代理最经典的坑。

有些人会在 handler 里写出这样的逻辑：

```java
// 用法示意(API 形式,非源码片段)
public Object invoke(Object proxy, Method method, Object[] args) throws Throwable {
    return method.invoke(proxy, args);
}
```

看起来像是“把这次调用再转发回去”，实际上它等于把代理对象又喂回代理链本身。

`InvocationHandler` 协议就一个方法：

```java
// InvocationHandler.java:93-96
public Object invoke(Object proxy, Method method, Object[] args)
    throws Throwable;
```

其中 `proxy` 不是目标对象，而是**当前代理对象本身**。因此，如果你在 handler 里再次对 `proxy` 做 `method.invoke(proxy, args)`，会发生：

```text
调用方 → $ProxyN.someMethod()
        → InvocationHandler.invoke(proxy, method, args)
        → method.invoke(proxy, args)
        → 再次进入 $ProxyN.someMethod()
        → 再次进入 InvocationHandler.invoke(...)
        → 无限递归
```

这就是为什么“handler 里不能对 proxy 再反射调用自己”不是背诵题，而是由代理结构决定的必然结果。

### 正确转发对象必须是 target，而不是 proxy

真正的 handler 职责，是在真实对象 target 之前或之后夹逻辑，而不是重新调用代理自己：

```text
调用方
  → 代理类方法
      → InvocationHandler.invoke(proxy, method, args)
           ├── 前置增强：日志、鉴权、事务
           ├── method.invoke(target, args)
           └── 后置增强：提交、清理、统计
```

这就是 Spring AOP、MyBatis Mapper、RPC 接口代理的共同骨架。代理类只是把入口统一导流，真正的“增强”都写在 handler 里；而 handler 之所以成立，前提正是前几节已经建立的事实：JDK 已经先造好了一个实现接口的新类。

## 五、`setAccessible(true)` 为什么不再是万能钥匙

### 先区分“造类”和“改访问标志”是两种完全不同的手段

动态代理和 `setAccessible(true)` 经常被一起放进“反射黑魔法”这个大篮子里，仿佛它们都是运行时越权手段，所以能力边界也应该差不多。

这其实是另一种失败方案。动态代理解决的是“接口没有实现类怎么办”；`setAccessible` 解决的是“已经有了这个成员，我能不能跳过 Java 语言级别访问检查”。它们不是同一层工具。

看 `AccessibleObject.setAccessible` 的实现就知道，它远没有大家想象中神秘：

```java
// AccessibleObject.java:182-193
@CallerSensitive
public void setAccessible(boolean flag) {
    AccessibleObject.checkPermission();
    setAccessible0(flag);
}

boolean setAccessible0(boolean flag) {
    this.override = flag;
    return flag;
}
```

JDK 11 在这里做的核心动作，其实只是把当前反射对象的 `override` 标志设成 true。它不会帮你生成类，不会帮你打开模块，也不会自动修复包访问问题。

### 为什么 JDK 9+ 以后它经常“不够用了”

把这件事放回真实故障里会更容易懂：框架过去反射某个 JDK 内部类或别的模块里的私有构造器时，习惯先 `setAccessible(true)`，然后再 `newInstance()` 或 `get()`。在 JDK 8 时代，这套经验经常有效；到了 JDK 9+，很多框架第一次启动就直接报 `InaccessibleObjectException`。

最容易犯的错，是把这个变化理解成“JDK 把 `setAccessible` 做弱了”。其实 `setAccessible` 自己几乎没变：它仍然只是修改当前反射对象的 `override` 标志。变化的是访问边界不再只有“private/protected/public”这一层，模块系统把“你所在模块有没有资格碰这个包里的成员”提到了更前面。

旧的包访问检查仍然存在。`ReflectUtil.checkPackageAccess` 至少说明：在成员修饰符检查之外，本来就还有包这一层守门员。

```java
// ReflectUtil.java:116-137
public static void checkPackageAccess(Class<?> clazz) {
    SecurityManager s = System.getSecurityManager();
    if (s != null) {
        privateCheckPackageAccess(s, clazz);
    }
}

private static void privateCheckPackageAccess(SecurityManager s, Class<?> clazz) {
    while (clazz.isArray()) {
        clazz = clazz.getComponentType();
    }
```

而 `setAccessible(true)` 只做这一点：

```text
拿到反射对象
   → setAccessible(true)
   → override = true
   → 后续 Method.invoke / Field.get 时跳过 Java 语言级别访问检查
```

它做不到的是下面这件事：

```text
跨模块访问某个未 opens 的包
   → 你连“有没有资格进这个包”都还没解决
   → override 改成 true 也不能替你打开模块边界
```

因此“为什么 JDK 9+ 以后还会报 `InaccessibleObjectException`”的正确回答不是“JDK 不让你用了”，而是：旧经验默认访问控制只有一层，现在至少变成了“模块/包边界 + 成员修饰符”两层。`setAccessible(true)` 只负责后一层，前一层需要 `opens` 或等价授权。

**这一节真正要收住的结论是：动态代理靠“造出一个新类”解决对象存在问题；`setAccessible` 靠“改一个已存在对象的访问标志”解决语言级别访问问题。模块系统把后者的权限边界抬高后，很多老框架才会突然失灵。**

## 收网：JDK 代理是在造类，`setAccessible` 只是在改标志

现在把全文的两条线收回到最开始的框架现场。

Spring AOP、MyBatis Mapper 之所以能把接口交给业务代码直接调用，不是因为 JVM 会“自动代理接口”，而是因为 `Proxy.newProxyInstance` 最终真的找到了或生成了一个实现这些接口的新类。这个新类的方法体又高度模板化：所有接口方法最终都汇流到 `InvocationHandler.invoke`。

把这条链再压缩一次：

```text
Proxy.newProxyInstance
   → getProxyConstructor
      ├── 命中 proxyCache：复用已有代理类构造器
      └── 未命中：ProxyBuilder.build
             → 计算包名与类名
             → ProxyGenerator.generateProxyClass
             → UNSAFE.defineClass
   → 用构造器创建代理对象
   → 代理方法统一进入 InvocationHandler.invoke
```

`InvocationHandler` 里之所以容易写出死循环，也正因为这个汇流太彻底：所有入口都回到同一个 handler，proxy 自己不能再被当成真实 target 调回去。

而 `setAccessible(true)` 这条线给出的启示刚好相反：它并没有也无法帮你“变出缺失的类”，它只是修改已有反射对象的 override 标志。JDK 9+ 以后很多框架在这里出问题，不是因为代理机制变了，而是因为模块封装让“仅靠 override 跳过检查”不再足够。

实际使用时只记住三条规则：

1. JDK 动态代理适用于**接口**，因为它本质是在运行时生成接口实现类，而不是增强任意类。
2. handler 里必须把调用转发到真实 target，而不是把 `proxy` 再喂回 `method.invoke`。
3. `setAccessible(true)` 只解决成员级反射访问的一部分问题；跨模块访问要靠 `opens` 或等价授权，而不是把 override 当万能钥匙。

下一篇进入注解体系。代理和反射已经证明：JVM 可以在运行时把接口变成行为、把成员变成调用。那贴在类和方法上的注解元数据，又是怎样从 class 文件字节变成运行时 `Annotation` 对象的？

> → 下一篇：[注解体系](04-annotation.md)
