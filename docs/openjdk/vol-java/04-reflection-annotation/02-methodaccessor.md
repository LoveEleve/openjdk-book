# MethodAccessor：反射为什么不是一直都慢

> 本文基于 JDK 11 `java.base` 的 `Method`、`Constructor` 和 `jdk.internal.reflect.*` 反射实现。`DelegatingMethodAccessorImpl`、`NativeMethodAccessorImpl`、`MethodAccessorGenerator` 以及字段的 `UnsafeFieldAccessorFactory` 都属于 JDK 11 当前实现，不是 Java 反射规范要求的唯一方案。模块封装与 `InaccessibleObjectException` 已在上一章展开，这里只聚焦反射调用成本与执行器切换。
> **前置依赖**：[Class 反射视图：为什么拿到 `Method` 还会慢](01-class-member-access.md)
> **后续**：[动态代理与访问控制](03-proxy-access.md)

## 框架已经缓存了 `Method`，为什么还是慢

上一章已经把第一个误解拆掉了：框架如果反复 `getMethod()`，当然会慢，因为即使 `Class` 有 `ReflectionData`，JDK 仍然会复制 `Method` 对象。很多框架也因此学会了第一层优化：把 `Method` 缓存起来。

可问题并没有到此结束。一个 ORM、序列化框架或依赖注入容器，可能在热路径上对同一个 setter、getter 或构造器调用几十万次。这个时候，成员对象明明已经缓存好了，`Method.invoke(obj, args)` 仍然可能成为可见的 CPU 消耗点。

这说明现在的问题不再是“有没有重复找 `Method`”，而是“同一个 `Method` 被反复调用时，JDK 到底如何执行它”。真正的复杂性不在 `Method` 对象表面，而在它背后的 accessor。

```text
热路径
  → Method.invoke(obj, args)
      ├── 访问检查
      ├── 取 MethodAccessor
      └── 交给真正的执行器
             ├── native 调用
             └── generated 字节码调用
```

这篇只回答一件事：**JDK 11 为什么不把“反射调用”做成一条固定路径，而是先走 native，再按热度切成字节码实现；以及为什么字段访问器又偏偏不是这条路线。**

## 一、`Method.invoke` 本体很短，复杂性被藏在 accessor 后面

### 先排除第一个误判

很多人看到“反射慢”，会自然以为 `Method.invoke` 本身一定做了很重的事情：也许它自己在 Java 层拼了很长的状态机，也许它每次都重新查找目标方法，也许它直接在这里决定使用 JNI 还是字节码。

实际并不是这样。`Method.invoke` 的角色更像一个统一入口，它负责把访问控制和执行器调度接起来，但并不亲自持有“真正执行目标方法”的复杂逻辑。

### `invoke` 的三步：检查、取 accessor、转发

看 JDK 11 的实现：

```java
// Method.java:552-566
public Object invoke(Object obj, Object... args)
    throws IllegalAccessException, IllegalArgumentException,
       InvocationTargetException
{
    if (!override) {
        Class<?> caller = Reflection.getCallerClass();
        checkAccess(caller, clazz,
                    Modifier.isStatic(modifiers) ? null : obj.getClass(),
                    modifiers);
    }
    MethodAccessor ma = methodAccessor;             // read volatile
    if (ma == null) {
        ma = acquireMethodAccessor();
    }
    return ma.invoke(obj, args);
}
```

这段代码只有三件事：

1. 如果当前反射对象没有被 `setAccessible(true)`，就做访问检查。
2. 读取当前 `Method` 持有的 `methodAccessor`；没有就现场拿一个。
3. 把调用转发给 `ma.invoke(obj, args)`。

因此，把“反射慢”完全归咎于 `Method.invoke` 这个 Java 方法本身，是第一个失败方案。真正的执行成本大头在 `MethodAccessor` 之后，而不是前面这几行门面代码。

### 同一个底层方法不会为每个 `Method` copy 重造执行器

上一章已经讲过 root/copy 结构：`Class` 对外暴露的是 `Method` copy，而不是 root。现在要补上第二层事实：copy 之间仍然会沿 root 共享 accessor，不会因为你拿到了第二个 `Method` 对象，就重新生成一套执行器。

`acquireMethodAccessor` 很直白：

```java
// Method.java:623-637
private MethodAccessor acquireMethodAccessor() {
    MethodAccessor tmp = null;
    if (root != null) tmp = root.getMethodAccessor();
    if (tmp != null) {
        methodAccessor = tmp;
    } else {
        tmp = reflectionFactory.newMethodAccessor(this);
        setMethodAccessor(tmp);
    }

    return tmp;
}
```

它先沿 root 看有没有已经生成好的 accessor；有就直接复用，没有才通过 `ReflectionFactory` 创建新的，再向 root 传播。

```text
Method copy A.invoke()
   → copy A 没有 accessor
   → 去 root 看
       ├── root 已有：直接共享
       └── root 没有：让 ReflectionFactory 创建，并传播回 root
```

这意味着高频调用真正值得研究的对象，不是 `Method` 这个壳子，而是所有 copy 共享的 accessor 执行器。接下来就该问：既然这是共享执行器，JDK 为什么不直接一次性把它做成最快的样子？

## 二、为什么不是“一开始就最快”：Delegating → Native → Generated 三层

### 两种最直觉的方案，其实都不划算

如果只追求最终性能，最容易想到的做法是：第一次反射调用就直接生成一份专用字节码类，后面所有调用都走“接近直接调用”的路线。

反过来，如果只追求实现简单，也可以永远使用 native 入口，让 JVM 内部去处理一切。

这两种方案恰好对应两种失败：

- **总是提前生成字节码**：每个低频 `Method` 在第一次调用时都要支付类生成、类定义和实例化成本；启动期和低频路径会吃亏。
- **总是停留在 native**：高频调用始终跨 JNI 边界，热路径成本压不下去。

JDK 11 的选择是把这两个成本拆开，让低频方法先用能马上工作的 native 方案顶上，高频方法再切换到更适合长期跑的字节码实现。

### `ReflectionFactory` 默认先给你一层 Delegating 壳子

真正的执行器是由 `ReflectionFactory.newMethodAccessor` 造出来的：

```java
// ReflectionFactory.java:189-220
public MethodAccessor newMethodAccessor(Method method) {
    checkInitted();

    if (Reflection.isCallerSensitive(method)) {
        Method altMethod = findMethodForReflection(method);
        if (altMethod != null) {
            method = altMethod;
        }
    }

    Method root = langReflectAccess.getRoot(method);
    if (root != null) {
        method = root;
    }

    if (noInflation && !ReflectUtil.isVMAnonymousClass(method.getDeclaringClass())) {
        return new MethodAccessorGenerator().
            generateMethod(method.getDeclaringClass(),
                           method.getName(),
                           method.getParameterTypes(),
                           method.getReturnType(),
                           method.getExceptionTypes(),
                           method.getModifiers());
    } else {
        NativeMethodAccessorImpl acc =
            new NativeMethodAccessorImpl(method);
        DelegatingMethodAccessorImpl res =
            new DelegatingMethodAccessorImpl(acc);
        acc.setParent(res);
        return res;
    }
}
```

默认路径不是“直接给一个 native accessor”，而是先创建 `NativeMethodAccessorImpl`，再套上一层 `DelegatingMethodAccessorImpl`。这三层角色是：

```text
Method.methodAccessor
   → DelegatingMethodAccessorImpl
        → 启动阶段：NativeMethodAccessorImpl
        → 过阈值后：GeneratedMethodAccessor
```

Delegating 层的存在很像一个稳定的插座。`Method.invoke` 永远拿着同一个对外入口，底下接的是 native 还是 generated，并不需要调用方重新感知或替换引用。

### Delegating 看似只转发，实际上负责“无感换芯”

`DelegatingMethodAccessorImpl` 的实现极短：

```java
// DelegatingMethodAccessorImpl.java:33-48
class DelegatingMethodAccessorImpl extends MethodAccessorImpl {
    private MethodAccessorImpl delegate;

    DelegatingMethodAccessorImpl(MethodAccessorImpl delegate) {
        setDelegate(delegate);
    }

    public Object invoke(Object obj, Object[] args)
        throws IllegalArgumentException, InvocationTargetException
    {
        return delegate.invoke(obj, args);
    }

    void setDelegate(MethodAccessorImpl delegate) {
        this.delegate = delegate;
    }
}
```

它看起来“只是在转发”，但真正值钱的是 `setDelegate`。如果没有这一层，`Method.invoke` 以及 root/copy 共享出来的 accessor 引用，就不得不在切换时整体替换；而有了 Delegating，JDK 只要把里面的 delegate 从 native 换成 generated 即可，入口对象本身不用变。

这就是 Delegating 不能省掉的原因：它不是为了多一层抽象而多一层，而是为了让**运行时替换实现**这件事对所有 `Method` copy 都透明。

**路标：到这里先记住一件事。JDK 11 不是把“反射调用”直接优化到最好，而是先给你一个稳定入口，再根据热度决定这个入口里面接哪种实现。下面要看的就是，热度阈值到底怎么触发切换。**

## 三、第 16 次为什么才切：膨胀阈值与 `noInflation`

### 阈值不是“15 次后大概会变快”，而是源码里的计数逻辑

“反射调用超过 15 次就变快”是流传很广的一句话，但如果不读源码，读者很容易把它误记成“第 15 次开始切换”或者“所有反射都会在 15 次时突然优化”。

`NativeMethodAccessorImpl.invoke` 给出的是真实判断：

```java
// NativeMethodAccessorImpl.java:43-69
public Object invoke(Object obj, Object[] args)
    throws IllegalArgumentException, InvocationTargetException
{
    if (++numInvocations > ReflectionFactory.inflationThreshold()
            && !ReflectUtil.isVMAnonymousClass(method.getDeclaringClass())) {
        MethodAccessorImpl acc = (MethodAccessorImpl)
            new MethodAccessorGenerator().
                generateMethod(method.getDeclaringClass(),
                               method.getName(),
                               method.getParameterTypes(),
                               method.getReturnType(),
                               method.getExceptionTypes(),
                               method.getModifiers());
        parent.setDelegate(acc);
    }

    return invoke0(method, obj, args);
}
```

关键点有三个：

1. `numInvocations` 是在判断前先自增。
2. 比较条件是 `>`，不是 `>=`。
3. 即使过阈值，也不是所有类都能膨胀；VM anonymous class 会被排除。

默认阈值在 `ReflectionFactory` 里写死为 15：

```java
// ReflectionFactory.java:87-88
private static boolean noInflation        = false;
private static int     inflationThreshold = 15;
```

因此 JDK 11 默认语义更准确的说法是：**前 15 次仍走 native，第 16 次开始触发生成并替换 delegate。**

### 为什么不直接把阈值设成 0

阈值存在的理由并不是某个神秘常数，而是启动成本与长期运行成本之间的折中。

如果一个 `Method` 只调用两三次，那么生成一整个专用 accessor 类、再把它定义进 JVM，成本很可能比直接 native 调两三次还不划算。反过来，如果同一个 `Method` 在框架热路径上跑几十万次，那么持续的 JNI 边界成本就值得被一次性的生成成本换掉。

换句话说，15 不是规范要求，只是 JDK 11 当前实现的默认折中。它要回答的不是“15 最科学”，而是“给低频方法一个不至于太亏的启动方案，再给高频方法一个可逐渐转正的执行方案”。

### `noInflation=true` 会把生成成本前置

JDK 11 也允许调用者通过系统属性改变这条路线。`ReflectionFactory.checkInitted()` 会在模块系统初始化完成后延迟读取相关属性：

```java
// ReflectionFactory.java:682-710
static int inflationThreshold() {
    return inflationThreshold;
}

private static void checkInitted() {
    if (initted) return;
    if (!VM.isModuleSystemInited()) {
        return;
    }

    Properties props = GetPropertyAction.privilegedGetProperties();
    String val = props.getProperty("sun.reflect.noInflation");
    if (val != null && val.equals("true")) {
        noInflation = true;
    }

    val = props.getProperty("sun.reflect.inflationThreshold");
    if (val != null) {
        inflationThreshold = Integer.parseInt(val);
    }
```

这里的版本边界很重要：这些属性读取时机与模块系统初始化相关，是 JDK 11 的实现事实，不是 Java 反射 API 的抽象契约。

`noInflation=true` 的效果，不是“调大阈值”或者“让第 15 次更快”，而是直接跳过 native 期：

```java
// ReflectionFactory.java:205-212
if (noInflation && !ReflectUtil.isVMAnonymousClass(method.getDeclaringClass())) {
    return new MethodAccessorGenerator().
        generateMethod(method.getDeclaringClass(),
                       method.getName(),
                       method.getParameterTypes(),
                       method.getReturnType(),
                       method.getExceptionTypes(),
                       method.getModifiers());
}
```

这意味着性能调优不能机械理解成“打开 noInflation 就一定更快”。如果你的方法大多只是偶发调用，那么把生成成本全部前置，未必划算。JDK 默认路线正是为了避免低频路径一开始就付出这笔钱。

### generated accessor 不是黑箱，它真的是现场拼 class 文件

切换后的 generated accessor 也不是“JVM magically 变快”。它是 `MethodAccessorGenerator` 现场组装出来的一类字节码访问器：

```java
// MethodAccessorGenerator.java:68-84
public MethodAccessor generateMethod(Class<?> declaringClass,
                                     String   name,
                                     Class<?>[] parameterTypes,
                                     Class<?>   returnType,
                                     Class<?>[] checkedExceptions,
                                     int modifiers)
{
    return (MethodAccessor) generate(declaringClass,
                                     name,
                                     parameterTypes,
                                     returnType,
                                     checkedExceptions,
                                     modifiers,
                                     false,
                                     false,
                                     null);
}
```

也就是说，JDK 11 的反射调用并不是“本来就快，只是前面绕了一圈”，而是明确经历了执行器形态转换：**起步靠 native 顶住，热起来再为这个方法现场生成一个更适合长期调用的 accessor 类。**

## 四、`setAccessible(true)` 具体省掉了哪一层

### 它不是万能加速键，只是把一层检查拿掉

一说到反射优化，几乎一定会听到“记得 `setAccessible(true)`，会快很多”。这句话不完全错，但很容易被说得过头，好像一调用它，反射就几乎等于直接调用了。

对方法而言，`setAccessible(true)` 的收益首先落在 `Method.invoke` 开头的这一层：

```java
// Method.java:556-561
if (!override) {
    Class<?> caller = Reflection.getCallerClass();
    checkAccess(caller, clazz,
                Modifier.isStatic(modifiers) ? null : obj.getClass(),
                modifiers);
}
```

`override=true` 后，这段访问检查就不再执行。省掉的是“每次反射调用都做一次访问控制判断”的成本，而不是后面的参数包装、异常包装和 accessor 执行路径。

因此，第二个常见失败方案就是把 `setAccessible(true)` 理解成“反射已经差不多和直接调用一样快”。实际上它只去掉了一层；后面还有：

- `Object[] args` 带来的装箱与数组处理。
- `InvocationTargetException` 的异常包装语义。
- native 或 generated accessor 的实际执行成本。

### 字段这边省掉的是 accessor 选择分支里的普通访问路径

字段访问器的收益更容易看见。`Field.getFieldAccessor` 会根据 `override` 选择普通访问器还是 override 访问器：

```java
// Field.java:1081-1086
private FieldAccessor getFieldAccessor(Object obj)
    throws IllegalAccessException
{
    boolean ov = override;
    FieldAccessor a = (ov) ? overrideFieldAccessor : fieldAccessor;
    return (a != null) ? a : acquireFieldAccessor(ov);
}
```

也就是说，`setAccessible(true)` 不只是抽象上的“允许访问私有字段”，它还直接影响字段路径选择哪套 accessor 缓存。性能层面上，这比方法调用更接近“换一条准备好的执行路”。

不过这里也必须守住边界：上一章已讲过模块系统下 `setAccessible` 不是万能钥匙；本文只讨论一旦它成立之后，能省掉哪层运行期开销，不再重复模块封装话题。

## 五、为什么字段访问器没有跟方法一起“膨胀”

### 反射优化不是一条统一流水线

如果读者前面已经接受了“方法反射调用 = Delegating → Native → Generated”，很容易顺手把字段访问也想成同一条路线：先 native，再在热起来后生成某个 `GeneratedFieldAccessor`。

这正是这篇需要专门设置字段对照节的原因：**JDK 11 对字段访问走的是另一条优化路线。**

### `newFieldAccessor` 直接进 Unsafe 工厂

`ReflectionFactory.newFieldAccessor` 并没有像方法那样构造一条“Delegating + Native + Generated”的链，而是直接把工作交给 `UnsafeFieldAccessorFactory`：

```java
// ReflectionFactory.java:175-187
public FieldAccessor newFieldAccessor(Field field, boolean override) {
    checkInitted();

    Field root = langReflectAccess.getRoot(field);
    if (root != null) {
        if (root.getModifiers() == field.getModifiers() || !override) {
            field = root;
        }
    }
    return UnsafeFieldAccessorFactory.newFieldAccessor(field, override);
}
```

`UnsafeFieldAccessorFactory` 再根据字段类型、是否 static、是否 final/volatile 去挑选具体实现：

```java
// UnsafeFieldAccessorFactory.java:32-43
static FieldAccessor newFieldAccessor(Field field, boolean override) {
    Class<?> type = field.getType();
    boolean isStatic = Modifier.isStatic(field.getModifiers());
    boolean isFinal = Modifier.isFinal(field.getModifiers());
    boolean isVolatile = Modifier.isVolatile(field.getModifiers());
    boolean isQualified = isFinal || isVolatile;
    boolean isReadOnly = isFinal && (isStatic || !override);
    if (isStatic) {
        UnsafeFieldAccessorImpl.unsafe.ensureClassInitialized(field.getDeclaringClass());
```

字段访问器的分支多，是因为它要区分基本类型、对象类型、静态字段、实例字段、qualified 版本等，而不是因为它会像方法一样随热度更换整体执行策略。

### 核心加速点是“先算偏移，再按类型直读”

真正的关键在 `UnsafeFieldAccessorImpl` 构造时就把字段偏移算出来：

```java
// UnsafeFieldAccessorImpl.java:46-52
UnsafeFieldAccessorImpl(Field field) {
    this.field = field;
    if (Modifier.isStatic(field.getModifiers()))
        fieldOffset = unsafe.staticFieldOffset(field);
    else
        fieldOffset = unsafe.objectFieldOffset(field);
    isFinal = Modifier.isFinal(field.getModifiers());
}
```

方法调用的难点在“如何发起一次方法调用”；字段访问的难点更接近“如何高效定位字段位置并按类型读写”。因此 JDK 11 为字段选择了 Unsafe 偏移路线，而不是再做一次像方法反射那样的热度膨胀。

```text
Method.invoke
   → accessor 先 native，热后 generated

Field.get / set
   → 选中对应 UnsafeFieldAccessorImpl
   → 计算 fieldOffset
   → 按偏移和类型读写
```

这也解释了为什么“字段访问比方法反射更快”不能只回答成“因为字段更简单”。更准确的说法是：**JDK 11 为字段选了另一条启动即较轻量的执行路径，它不必像方法那样在 native 调用和字节码生成之间做热度切换。**

## 收网：反射性能不是一句“慢”，而是四层成本叠加

回到开头那个热路径场景。框架已经缓存了 `Method`，说明它解决了“每次重新找成员”的问题；但 `Method.invoke` 仍然可能慢，因为同一个成员对象背后还有独立的执行器策略。

整条链可以压缩成这样：

```text
Method.invoke
   → 未 override 时做访问检查
   → 读取共享的 MethodAccessor 入口
       → DelegatingMethodAccessorImpl
           → 前 15 次：NativeMethodAccessorImpl.invoke0
           → 第 16 次起：GeneratedMethodAccessor
   → 返回结果或包装异常
```

字段访问则是另一条线：

```text
Field.get / set
   → 依据 override 选择 accessor
   → UnsafeFieldAccessorFactory 按字段类型挑实现
   → 通过 objectFieldOffset / staticFieldOffset 读写
```

所以“反射为什么慢”的完整回答，不应再停在“动态、所以慢”。更准确的成本清单是：

1. 访问检查：`setAccessible(true)` 可以省掉这一层，但不是全部。
2. 参数与返回值包装：`Object[] args`、装箱拆箱、`InvocationTargetException` 都是反射契约成本。
3. 执行器形态：低频时 native，热起来后 generated，二者各有折中。
4. 对象类型差异：方法调用与字段读写在 JDK 11 中本来就不是同一条优化路线。

给生产实践收成三条规则：

1. **先缓存成员对象**，否则连 accessor 共享都吃不到。
2. **再决定是否用 `setAccessible(true)`**，它能省掉访问检查，但不会神奇消除所有反射成本。
3. **理解热路径是否值得膨胀**，不要把 JDK 的默认阈值当成万能调参答案，也不要把字段访问和方法调用的成本模型混为一谈。

到这里，JDK 已经证明自己不仅能在运行时调用方法，还能在运行时**生成新的辅助类**。下一篇再往前一步：如果一个 accessor 能动态生成，`$Proxy0` 这种完整代理类又是怎么被现场拼出来的？

> → 下一篇：[动态代理与访问控制](03-proxy-access.md)
