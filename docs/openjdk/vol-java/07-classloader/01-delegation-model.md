# 双亲委派与类加载流程：为什么不能谁先拿到字节谁说了算

> 本文基于 JDK 11 `java.base` 的 `ClassLoader` Java 层实现。`loadClass`、`findClass`、`defineClass`、`getClassLoadingLock` 等都以 JDK 11 源码为准；“类唯一性 = 加载器 + 类名”以及 `systemDictionary` 属于 JVM / HotSpot 事实，用来解释设计动机，但不展开 VM 内部全部细节。本文讨论的是 JDK 11 Java 层类加载骨架，不把这里的父链组织、扩展点分工和加载/初始化边界外推成所有 JVM 或所有类加载框架都必须遵守的统一规范。
> **前置依赖**：[Class 反射视图](../04-reflection-annotation/01-class-member-access.md)、[注解体系](../04-reflection-annotation/04-annotation.md)
> **后续**：[内置类加载器](02-builtin-classloaders.md)

## 如果谁先拿到字节谁说了算，类型系统会先出事

先看两个看似矛盾的场景。

第一个场景来自安全和一致性：假设应用自己的类加载器拿到一份自定义字节码，名字偏偏也叫 `java.lang.String`。如果 JVM 允许“谁先找到字节谁就定义这个类”，那么应用层就有机会先塞进一个假的 `String`。此时 `new String()`、`instanceof String`、方法签名里的 `String` 都会开始失去统一含义，整个类型系统会被污染。

第二个场景来自隔离：热部署、插件系统、Web 容器又恰恰需要“两个同名类能并存”。比如同一个 `com.foo.Service`，旧版本和新版本应该由不同加载器各自持有，彼此互不干扰。

这两个要求表面冲突：

```text
要求 A：核心同名类必须统一，不能被应用层伪造
要求 B：业务同名类在不同隔离域里又必须可以共存
```

JDK 的类加载设计，就是在这两个要求之间找平衡。双亲委派、`findClass/defineClass` 分工、类加载锁和“加载”/“初始化”分离，都是为了解决这个看起来别扭的组合题。

这篇文章不按 API 名字堆流程，而是沿着一个更有用的问题展开：**为什么类加载不能简单做成“自己先找字节，找到了就定义类”？**

## 一、`loadClass` 的三步不是口号，而是防污染与防重复的骨架

### 先推演最直觉的失败方案

如果完全站在自定义加载器作者的角度，最省事的思路当然是：

1. 我自己先去文件系统、网络或加密包里找字节。
2. 找到了就直接定义这个类。
3. 找不到再考虑问别人。

这个方案看起来最直接，却同时踩中了开头的两个雷：

- 它会让应用侧有机会抢先定义本该由更高层命名空间掌控的核心类。
- 它也会让同一加载器更容易重复定义同名类，破坏自身的一致性。

所以 JDK 11 的 `loadClass` 骨架刻意反着来：**先看自己是否已经加载，再问父加载器是否已经拥有这类定义，最后才轮到当前加载器自己去找。**

### JDK 11 的主骨架：缓存 → 委派 → 自己找

真正的骨架就在 `ClassLoader.loadClass(String, boolean)` 里：

```java
// ClassLoader.java:571-603
protected Class<?> loadClass(String name, boolean resolve)
    throws ClassNotFoundException
{
    synchronized (getClassLoadingLock(name)) {
        Class<?> c = findLoadedClass(name);
        if (c == null) {
            long t0 = System.nanoTime();
            try {
                if (parent != null) {
                    c = parent.loadClass(name, false);
                } else {
                    c = findBootstrapClassOrNull(name);
                }
            } catch (ClassNotFoundException e) {
            }

            if (c == null) {
                long t1 = System.nanoTime();
                c = findClass(name);
                ...
            }
        }
        if (resolve) {
            resolveClass(c);
        }
        return c;
    }
}
```

这段代码背后的角色顺序，比“先父后己”四个字更重要：

```text
loadClass(name)
   → 先拿这把类名对应的加载锁
   → 查本加载器是否已经加载过
   → 没有才委派给父加载器
   → 父也没有，自己才 findClass(name)
   → 需要的话再 resolveClass(c)
```

因此，“双亲委派”不是一个额外加在类加载之上的修辞，它就是 `loadClass` 主骨架里第二步的体现。而第一步查缓存、第三步自己找，也同样是骨架的一部分。

### 为什么“先问父类”不是礼貌，而是边界控制

这一步最容易被讲成家谱故事，好像“父加载器”只是一个层级设计。真正的动机其实更硬：**谁更靠近 JVM 核心命名空间，谁就应该更早对同名类拥有解释权。**

所以当 `parent != null` 时，当前加载器不会抢先 `findClass(name)`，而是先调用：

```java
// ClassLoader.java:580-584
if (parent != null) {
    c = parent.loadClass(name, false);
} else {
    c = findBootstrapClassOrNull(name);
}
```

这一步确保像 `java.lang.String` 这种名字，不会被应用加载器先一步“劫持”。而 `parent == null` 也不意味着“就没人管了”，而是说明当前已经走到了 Java 层父链的顶端，接下来直接问引导加载器边界。

失败方案因此可以说得更具体：如果你把 `loadClass` 改成“自己先 `findClass`，不行再问父类”，应用层就有机会抢在引导/平台/应用父链之前定义同名类。双亲委派不是为了显得有秩序，而是为了把这种抢占权关掉。

**路标：到这里先只记住三件事。第一，查缓存是为了防同一加载器重复劳动；第二，先问父类是为了同名类解释权上移；第三，自己找不是被禁止，而是被推迟到更后面。下面要看的，就是为什么自定义加载器通常只应该覆写 `findClass`。**

## 二、为什么自定义加载器通常只覆写 `findClass`

### 不是“JDK 要求你这么写”，而是骨架和扩展点本来就分开了

很多人第一次写自定义加载器，会本能地想覆写 `loadClass`。毕竟类加载不就发生在这里吗？既然我要自己控制加载，直接改主方法不是最自由？

这恰恰是第二个最常见的失败方案。因为 `loadClass` 不是“帮你取字节”的普通方法，它是整套加载策略的骨架：查缓存、委派父类、必要时再自己找。你一旦直接重写，就非常容易把双亲委派和重复加载保护一起绕掉。

JDK 11 在这里已经把扩展点留好了：`findClass` 默认什么都不做，只是抛异常。

```java
// ClassLoader.java:723-727
protected Class<?> findClass(String name) throws ClassNotFoundException {
    throw new ClassNotFoundException(name);
}
```

这等于在告诉子类：**如果轮到你自己找类，你可以在这里提供字节来源。至于前面的缓存和委派骨架，默认不要碰。**

### `findClass` 提供字节，`defineClass` 交给 VM 定义类

真正的职责分工还得再细一层。就算 `findClass` 是扩展点，它也不是“类真正定义完成”的地方。它更像一个承诺：当前加载器负责想办法提供一段字节，然后把这段字节交给 `defineClass`。

先看最外层入口：

```java
// ClassLoader.java:806-809
protected final Class<?> defineClass(byte[] b, int off, int len)
    throws ClassFormatError
{
    return defineClass(null, b, off, len, null);
}
```

再看名字更完整的版本，它最终落到 native：

```java
// ClassLoader.java:1016-1022
protected final Class<?> defineClass(String name, byte[] b, int off, int len,
                                     ProtectionDomain protectionDomain)
    throws ClassFormatError
{
    Class<?> c = defineClass1(this, name, b, off, len, protectionDomain, source);
```

`ByteBuffer` 路径也一样，最后还是进入另一条 native 入口：

```java
// ClassLoader.java:1114-1124
Class<?> c = defineClass2(this, name, b, b.position(), len, protectionDomain, source);
postDefineClass(c, protectionDomain);
return c;
}

static native Class<?> defineClass1(ClassLoader loader, String name, byte[] b, int off, int len,
                                    ProtectionDomain pd, String source);

static native Class<?> defineClass2(ClassLoader loader, String name, java.nio.ByteBuffer b,
                                    int off, int len, ProtectionDomain pd,
                                    String source);
```

这几段代码一起说明：

```text
findClass
   → 你负责找到字节
defineClass
   → JDK 负责把字节交给 VM
VM / native
   → 真正完成类定义、校验和生成 Class 对象
```

所以“自定义加载器通常只覆写 `findClass`”不是套路，而是模板方法模式的直接结果：`loadClass` 是骨架，`findClass` 是扩展点，`defineClass` 是固定把字节交给 VM 的动作。

### 什么时候才会故意覆写 `loadClass`

当然，并不是任何时候都绝不能碰 `loadClass`。像 Tomcat 的 WebAppClassLoader、某些热部署或隔离场景，确实会有意识地打破默认委派顺序。

但这恰恰说明：**覆写 `loadClass` 属于“我明确知道自己要绕过哪一段默认骨架”的特殊设计，而不是日常自定义加载器的起手式。**

普通场景下，你真正想解决的问题通常只是：类字节在文件里、网络里、加密包里，或者不是标准类路径来源。那就覆写 `findClass` 去提供字节，而不要顺手把整个委派骨架拆掉。

## 三、并发加载为什么不会把同一个类定义两次

### Java 层先用类名锁防抖

继续往下看另一个现实问题：如果两个线程同时让同一个加载器去加载 `com.foo.Bar`，会不会都走到 `findClass`，最后重复定义？

`loadClass` 一开始就把整个流程包在 `getClassLoadingLock(name)` 上：

```java
// ClassLoader.java:574-603
synchronized (getClassLoadingLock(name)) {
    Class<?> c = findLoadedClass(name);
    ...
}
```

默认情况下，这把锁可能就是整个加载器对象本身；而对注册了并行能力的加载器，JDK 11 可以把它细化成“每个类名一把锁”：

```java
// ClassLoader.java:669-680
protected Object getClassLoadingLock(String className) {
    Object lock = this;
    if (parallelLockMap != null) {
        Object newLock = new Object();
        lock = parallelLockMap.putIfAbsent(className, newLock);
        if (lock == null) {
            lock = newLock;
        }
    }
    return lock;
}
```

再看并行能力入口：

```java
// ClassLoader.java:1623
protected static boolean registerAsParallelCapable() {
```

这套设计的角色图应该这么看：

```text
同一加载器下多个线程 loadClass("com.foo.Bar")
   → 先竞争 className 对应的锁
   → 赢的线程继续查缓存 / 委派 / findClass
   → 其他线程等待或复用结果
```

因此，Java 层这把锁首先是在做“防抖”：避免同一个加载器里，对同一个类名的并发加载重复做昂贵工作。

### 但锁不是唯一性本身，命名空间才是最终裁决

如果只记住 `synchronized`，很容易又滑到另一个误解：仿佛类唯一性就是这把锁保证的。其实不是。

先看 `findLoadedClass`：

```java
// ClassLoader.java:1283
protected final Class<?> findLoadedClass(String name) {
```

它做的是“本加载器是否已经加载过这个类”的查询，这能避免重复定义和重复劳动。但类的最终唯一性，不是由 Java 层锁和缓存 alone 说了算，而是由**加载器 + 类名**这个命名空间组合，以及 VM 定义阶段的检查共同保证。

所以两个结论必须一起记：

1. **同一加载器 + 同一类名**：不能重复定义。Java 层锁和 `findLoadedClass` 会先尽量挡住，VM 定义阶段还会再兜底。
2. **不同加载器 + 同一类名**：可以并存。这不是漏洞，而是类隔离的基础。

这也解释了开头那两个看似冲突的需求为什么能同时成立：

```text
双亲委派
   → 尽量让核心同名类沿父链统一归属

加载器命名空间
   → 允许不同加载器各自持有同名业务类
```

因此“两个加载器能不能加载同一个类”这道面试题，不该只答“能”或“不能”。更准确的说法是：**如果类名相同但加载器不同，JVM 视它们为两个不同类；这正是热部署、插件隔离、Web 容器隔离能成立的前提。**

## 四、`loadClass` 完成后，为什么静态块还不一定执行

### 很多人把“类存在了”和“类初始化了”混成一件事

类加载的另一个高频误解，是把“得到了一个 `Class<?>`”直接等同于“这个类已经执行过静态初始化”。

这也是为什么 JDBC 驱动注册那类问题会反复出现：如果你用 `ClassLoader.loadClass("com.mysql.jdbc.Driver")`，类对象可能已经存在，但静态块并不会因此自动执行；而 `Class.forName(...)` 却会。

这不是两个 API 风格差异，而是类生命周期里“加载 / 链接 / 初始化”本来就被拆开了。

### public `loadClass(name)` 默认连 resolve 都不做

先看最外层入口：

```java
// ClassLoader.java:526-527
public Class<?> loadClass(String name) throws ClassNotFoundException {
    return loadClass(name, false);
}
```

也就是说，日常调用的 public `loadClass(name)` 默认连 `resolve` 都没要求做。只有受保护的二参版本在 `resolve=true` 时，才会继续调用 `resolveClass(c)`：

```java
// ClassLoader.java:1222-1225
protected final void resolveClass(Class<?> c) {
    if (c == null) {
        throw new NullPointerException();
    }
```

这里先要把两个术语分开：

- `resolve` 对应的是链接阶段里的一部分动作。
- 初始化则是静态块、静态字段初始化那一层“主动使用”语义。

### 初始化不是 `loadClass` 的职责

因此，`loadClass` 完成后我们能得到的结论更准确地说是：**这个类现在可以被找到并以 `Class<?>` 形式被引用了。**

至于它是不是已经执行静态初始化，要看后续是否发生了主动使用，比如：

- `new` 创建实例
- 访问静态字段或静态方法
- `Class.forName(name)` 那种默认带 `initialize=true` 的入口

这正好回勾域 04 的 JDBC 场景：`Class.forName("com.mysql.jdbc.Driver")` 会走初始化，所以可能顺手触发驱动注册；`loadClass("com.mysql.jdbc.Driver")` 不会仅靠这一步就完成注册。

这层分离的价值是：JDK 能把“类对象是否存在”和“静态副作用是否发生”拆开控制。否则，仅仅做类型扫描或可用性检测，都会意外触发业务副作用。

## 五、五个最容易混掉的边界：双亲委派不是礼貌顺序，findClass 不是 defineClass，loadClass 不是初始化保证，类加载锁不是类身份本体，null parent 也不是没人管

在收网之前，先把这一篇最容易记错的五条边界压实。

第一，双亲委派不是“有父子关系所以先礼貌问父类”的顺序约定。它真正保护的是同名类解释权上移：越靠近核心命名空间的加载器，越应该先决定这个名字归谁。

第二，`findClass` 也不是“把类定义出来”的地方。它负责的是提供字节来源；真正把字节交给 JVM 变成 `Class` 的，是 `defineClass` 和后面的 VM 路径。把这两步混在一起，就会把扩展点和类定义边界写乱。

第三，`loadClass` 更不是初始化保证。它完成的是“找到类、必要时 resolve”，并不自动意味着静态块已经执行。只要把它和 `Class.forName(..., true, ...)` 的语义混成一件事，很多类加载副作用问题都会被误讲。

第四，类加载锁也不是类身份的本体。它主要解决的是同一加载器里、同一类名的并发加载防抖问题；真正决定“这是不是同一个类”的，仍然是“加载器 + 类名”这对命名空间事实。

第五，`parent == null` 也不是“再往上就没人管了”。它代表的是 Java 层父链已经走到顶，接下来改由引导加载器边界继续裁决，而不是让当前加载器彻底自由发挥。

把这五条边界记稳，双亲委派这一篇就不会重新塌回“先父后己”四个字的口号印象。它真正想讲的是：类加载既要防核心类污染、防重复定义，又要给隔离和扩展留下空间，所以骨架、扩展点、命名空间和初始化时机必须被刻意拆开。

## 收网：双亲委派不是口号，而是一组互相制衡的设计

现在回到开头那两个看似打架的要求：

- 核心类不能被应用层随便伪造。
- 业务同名类又必须能在不同隔离域里共存。

JDK 11 的 Java 层加载骨架，正是用几条配合关系把这两个目标同时保住：

```text
loadClass
   → 先查本加载器已加载缓存
   → 再委派父加载器决定更高层同名类归属
   → 最后才让当前加载器 findClass
   → defineClass 把字节交给 VM
   → 是否初始化留给后续主动使用
```

因此，真正值得记住的不是“先父后己”四个字，而是它背后的四条规则：

1. **先查缓存**，是为了同一加载器别重复做已经完成的工作。
2. **先问父类**，是为了把同名类解释权优先交给更高层命名空间，保护核心类一致性。
3. **只覆写 `findClass`**，通常就足够给自定义加载器提供字节来源；`loadClass` 是骨架，不该随手拆。
4. **类唯一性看的是“加载器 + 类名”**，而不是“整个 JVM 里这个名字只能出现一次”。
5. **`loadClass` 不等于初始化**，它只保证类可被找到；静态副作用是否发生，要看后续是否主动使用。

下一篇继续回答另一个经常被讲旧的问题：JDK 11 里双亲委派链上的“三层父母”到底是谁？`String.class.getClassLoader()` 为什么是 `null`？模块化之后类路径和模块路径又是怎么分工的？

> → 下一篇：[内置类加载器](02-builtin-classloaders.md)
