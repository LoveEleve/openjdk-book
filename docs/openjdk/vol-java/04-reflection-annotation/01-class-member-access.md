# 01. Class 对象与成员获取 — forName、ReflectionData 缓存、native 边界

> **前置依赖**: [03-object-system/01 — Object 的方法契约](../03-object-system/01-object-contract-references.md)(Class 对象与 getClass)、[06-exceptions/01 — Throwable](../06-exceptions/01-throwable-structure.md)(ClassNotFoundException)
> → **后续**:[04-reflection-annotation/02 — MethodAccessor 与反射调用](02-methodaccessor.md)
> 关联: 内部卷 07-classfile-classloader(类加载链与 Class 对象)、06-oops(成员元数据在 VM 侧的存储)

## 两个高频问题,一个根源

`Class.forName("com.mysql.jdbc.Driver")` 为什么能"注册驱动"?`clazz.getMethods()` 为什么慢、该不该缓存?——这两个问题都指向同一个根源: **Class 对象是 VM 创建的元数据视图,Java 侧的一切反射操作都在消费这个视图**。

这篇拆三条线: forName 的加载-初始化语义、ReflectionData 软引用缓存的设计、以及 Method/Field/Constructor 成员对象的"拷贝-共享"结构。

## 1. "Class.forName 做了什么" — 加载、链接、初始化

### 1.1 默认 initialize=true

`Class.forName(String)`(`Class.java:312-316`):

```java
// Class.java:312-316(截取核心,逐字)
public static Class<?> forName(String className)
            throws ClassNotFoundException {
    Class<?> caller = Reflection.getCallerClass();
    return forName0(className, true, ClassLoader.getClassLoader(caller), caller);
}
```

**第二个参数 `true` 是关键词**: 传给 native `forName0`(`Class.java:402`)的 `initialize=true`——**要求类初始化**(执行静态初始化器/静态块)。三参版(`Class.java:380`)把这个选择权交给调用方:

```java
// Class.java:380-399(截取核心,逐字)
public static Class<?> forName(String name, boolean initialize,
                               ClassLoader loader)
    throws ClassNotFoundException
{
    ...
    return forName0(name, initialize, loader, caller);
}
```

### 1.2 语义:初始化是 forName 与 loadClass 的分水岭

- `Class.forName(name)`:**加载 + 链接 + 初始化**(静态块执行)——JDBC 驱动的"注册"就是靠这个副作用: 静态块里调 `DriverManager.registerDriver`,驱动类被初始化时自动注册
- `Class.forName(name, false, loader)`:初始化关掉——"怎么加载类但不执行静态块"的面试答案
- `ClassLoader.loadClass(name)`:只加载不初始化(加载链机制在 VM 侧,见内部卷 07-classfile-classloader)

`forName0`(native)内部走 JVM 的类加载链,返回的 Class 对象**由 VM 在类加载时创建并缓存**——同一个类,无论通过 forName、类引用还是 getClass 拿到,都是同一个 Class 对象。

关键设计(斜体):*forName 的默认行为是"初始化",这是历史包袱也是设计——JDBC 1.0 时代需要一种"用类名触发注册"的机制,初始化副作用被当成特性用。现代代码里 `Class.forName` 的用途主要是: ① 触发静态块(驱动注册)② 仅拿 Class 对象(此时用 initialize=false 更干净)。面试答"forName 默认初始化、loadClass 不初始化"是入门,能补一句"初始化副作用就是 JDBC 驱动注册的机制"就是源码级。*

跨层标注: [内部卷: 07-classfile-classloader(类加载链与 Class 对象;java_lang_Class 的 VM 侧镜像)]

## 2. "getMethods 为什么慢" — ReflectionData 软引用缓存

### 2.1 缓存优先,未命中才问 native

`getDeclaredMethods()`(`Class.java:2304`)→ `privateGetDeclaredMethods`(`Class.java:3158-3171`):

```java
// Class.java:3158-3171(截取核心,逐字)
private Method[] privateGetDeclaredMethods(boolean publicOnly) {
    Method[] res;
    ReflectionData<T> rd = reflectionData();
    if (rd != null) {
        res = publicOnly ? rd.declaredPublicMethods : rd.declaredMethods;
        if (res != null) return res;
    }
    // No cached value available; request value from VM
    res = Reflection.filterMethods(this, getDeclaredMethods0(publicOnly));
    if (rd != null) {
        if (publicOnly) {
            rd.declaredPublicMethods = res;
        } else {
            rd.declaredMethods = res;
        }
    }
    return res;
}
```

模式很清晰: **先查缓存,未命中才调 native `getDeclaredMethods0`(`Class.java:3406`)遍历 VM 侧元数据,结果存回缓存**。

### 2.2 ReflectionData:volatile 数组快照

`ReflectionData`(`Class.java:2941-2967`)是一个纯数据类:

```java
// Class.java:2942-2950(截取核心,逐字)
volatile Field[] declaredFields;
volatile Field[] publicFields;
volatile Method[] declaredMethods;
volatile Method[] publicMethods;
volatile Constructor<T>[] declaredConstructors;
volatile Constructor<T>[] publicConstructors;
```

每个成员类别一个 volatile 数组快照。注意:**缓存的是"root 成员数组"**(第 3 节的 root 概念),不是每次调用返回的副本。

### 2.3 软引用 + 失效机制

缓存的生命周期管理有两层(`Class.java:2966-3001`):

```java
// Class.java:2966 + 2970 + 2973-2982(截取核心,逐字)
private transient volatile SoftReference<ReflectionData<T>> reflectionData;

private transient volatile int classRedefinedCount;

private ReflectionData<T> reflectionData() {
    SoftReference<ReflectionData<T>> reflectionData = this.reflectionData;
    int classRedefinedCount = this.classRedefinedCount;
    ReflectionData<T> rd;
    if (reflectionData != null &&
        (rd = reflectionData.get()) != null &&
        rd.redefinedCount == classRedefinedCount) {
        return rd;
    }
    ...
```

- **SoftReference**:内存不足时缓存可被 GC 回收,下次访问重建——反射缓存是"可以牺牲"的缓存
- **classRedefinedCount**(`Class.java:2970`):VM 每次 JVMTI `RedefineClasses` 递增;`redefinedCount` 不一致说明缓存过期,重建(`reflectionData()`@`Class.java:2973` 的校验 + `newReflectionData`@`Class.java:2984` 的 CAS 替换)

### 2.4 慢的真相:缓存只省一半

`getMethods` 慢有三层成本:

1. **native 遍历类元数据**(首次,`getDeclaredMethods0`)
2. **为每个成员 new 一个 Method/Field 对象**
3. **过滤/排序/继承合并**(getMethods 要并上父类的 public 方法)

缓存只省 **①**(以及 ③ 的中间结果),**不省 ②**——每次 `getMethods()` 调用仍返回**新数组、新 Method 对象**(`copyMethods` 包装)。所以:

- 反射对象本身是"消耗品",每次获取都新建
- 生产正确姿势: **自己缓存 Method 对象**,而不是反复调 getMethod

关键设计(斜体):*反射慢的本质不是"native 调用"而是"每次新建对象"——缓存数组只是避免 native 重扫,无法避免对象工厂的成本。面试答"为什么多次 getMethod 开销大": 反射对象是新建的,缓存数组只是避免 native 重扫——能说出"自己缓存 Method"的生产姿势就完整了。*

## 3. "成员对象怎么来的" — Method/Field/Constructor 结构

### 3.1 Method:accessor + root/copy

`Method`(`java/lang/reflect/Method.java`)的核心字段(`Method.java:85`):

```java
// Method.java:85
private volatile MethodAccessor methodAccessor;
```

`methodAccessor` 是调用执行器(volatile——多线程共享,第 2 篇展开)。关键设计在 **root/copy 分享树**(`Method.java:149-165`):

```java
// Method.java:149-165(截取核心,逐字)
Method copy() {
    // This routine enables sharing of MethodAccessor objects
    // among Method objects which refer to the same underlying
    // method in the VM. (All of this contortion is only necessary
    // because of the "accessibility" bit in AccessibleObject,
    // which implicitly requires that new java.lang.reflect
    // objects be fabricated for each reflective call on Class
    // objects.)
    if (this.root != null)
        throw new IllegalArgumentException("Can not copy a non-root Method");

    Method res = new Method(clazz, name, parameterTypes, returnType,
                            exceptionTypes, modifiers, slot, signature,
                            annotations, parameterAnnotations, annotationDefault);
    res.root = this;
    // Might as well eagerly propagate this if already present
    res.methodAccessor = methodAccessor;
```

结构:

```
Class 持有 root Method(每个方法一个)
  └── getMethod() 返回 copy():浅拷贝新 Method,root 指向 root,copy 共享 root 的 methodAccessor
```

源码注释把动机说透了: **"accessibility" 位在 AccessibleObject 里,setAccessible 需要每个调用方有独立对象**(不然 A 线程 setAccessible(true) 会影响 B)——所以每次 getMethod 必须新建对象;但 **MethodAccessor 是共享的**,一个类的同一方法只生成一次 accessor。

### 3.2 Constructor/Field 同构

- `Constructor`(`Constructor.java:97`):`private volatile ConstructorAccessor constructorAccessor;`;`newInstance`(`Constructor.java:475`)→ 未初始化时 `acquireConstructorAccessor()`(`Constructor.java:518`)
- `Field`(`Field.java:81-83`):**两个 accessor**——`fieldAccessor`(普通)与 `overrideFieldAccessor`(`setAccessible(true)` 后切换,绕过访问检查)

关键设计(斜体):*"拷贝-共享"是反射性能的最后防线: 反射对象可丢弃(每次获取都新建,因为 accessibility 状态必须隔离),但底层 accessor 全局共享(每方法只建一次)——既满足 setAccessible 的隔离语义,又不重复付出 accessor 构建成本。面试答"getMethod 每次返回新对象但共享 accessor"就拿到了这道题的底层。*

跨层标注: [内部卷: 06-oops(成员元数据 Klass/Method 在 VM 侧的存储——Java 反射对象只是"视图")]

## 核心悬念

Method 对象拿到了,`invoke()` 到底怎么执行?——`methodAccessor` 不是简单实现: 三层 MethodAccessor,先走 Delegating,前 15 次用 native 调用,超过阈值后 JVM **现场生成字节码**(MethodAccessorGenerator),把反射调用优化成近乎直接调用。下一篇: 反射为什么慢 + JVM 的进阶优化。

> → [04-reflection-annotation/02 — MethodAccessor 与反射调用](02-methodaccessor.md)
