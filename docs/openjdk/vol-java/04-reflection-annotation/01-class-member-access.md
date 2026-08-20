# Class 反射视图：为什么拿到 `Method` 还会慢

> 本文基于 JDK 11 `java.base` 的 `Class`、`Method`、`Field` 和 `Constructor` 实现。`Class` 是 JVM 提供给 Java 层的元数据视图；`ReflectionData`、root/copy 和 accessor 共享是 JDK 11 当前实现，不是 Java 反射规范规定的唯一缓存方式。本文只解释 `forName` 的初始化边界，完整类加载链留到域 07。
> **前置依赖**：[Object 的方法契约与对象生命周期](../03-object-system/01-object-contract-references.md)
> **后续**：[MethodAccessor 与反射调用](02-methodaccessor.md)

## 框架启动时的两颗雷

一个老式 JDBC 应用启动时执行：

```java
// 用法示意(API 形式,非源码片段)
Class<?> driverClass = Class.forName("com.mysql.jdbc.Driver");
```

开发者的主观意图可能只是“根据配置找到这个类”。但驱动类的静态初始化可能顺手完成注册，于是“拿到 Class”变成了“执行一段静态代码”。这不是 `Class.forName` 偶然做多了事情，而是它的默认契约就包含初始化。

另一边，容器扫描 Bean 时反复调用 `getDeclaredMethods()`、`getMethod()` 和 `getDeclaredFields()`。有人会说：“JDK 不是已经缓存反射结果了吗？”可实际性能仍然不稳定：第一次访问要向 VM 索取元数据，缓存可能被回收或因类重定义失效，而且对外返回的反射对象还不能直接把内部缓存原样交出去。

两个现场看似一个是初始化问题，一个是性能问题，背后却是同一个事实：

**`Class` 不是一个普通的 Java 数据对象，而是 JVM 元数据在 Java 层的视图中枢。调用者通过它请求加载、初始化、成员和注解；JDK 必须在副作用、缓存和访问状态隔离之间做取舍。**

```text
调用者
  │
  ├── Class.forName：请求类，并可能要求初始化
  ├── getMethods：请求 public 成员视图
  └── getDeclaredMethods：请求本类成员视图
          │
          ▼
Class（JVM 元数据的 Java 门面）
  ├── native：向 VM 索取类和成员信息
  ├── ReflectionData：缓存 root 成员视图
  └── Method/Field/Constructor：对外提供隔离的反射对象
```

这篇文章要解决的不是“反射 API 有哪些方法”，而是三个连续问题：为什么 `forName` 会点燃静态初始化；为什么有缓存仍然不能把重复反射当成零成本；以及为什么 JDK 宁可复制 `Method` 对象，也不复制底层 accessor。

## 一、`Class.forName`：你以为在取地址，它可能已经点火

### 先推演最容易犯的错

假设一个框架只想确认某个类是否存在，于是使用 `Class.forName(name)`。如果把它理解成“按名字查一个 `Class` 对象”，那么下面两个判断似乎都成立：

1. 这个调用只会加载，不会执行用户代码。
2. 它和 `ClassLoader.loadClass(name)` 只是两种写法。

这两个判断都不可靠。类加载、链接和初始化是不同阶段；`forName` 的一参入口把“找到类”和“要求初始化”绑定在了一起。静态初始化器可能注册驱动、创建线程、读取配置，甚至抛出初始化异常。框架如果只是做扫描，却没有意识到这个副作用，启动阶段就可能执行不该提前执行的代码。

### 一参入口默认把 `initialize` 设为 `true`

带着“初始化开关究竟在哪里”的问题看 JDK 11 源码：

```java
// Class.java:311-316
@CallerSensitive
public static Class<?> forName(String className)
            throws ClassNotFoundException {
    Class<?> caller = Reflection.getCallerClass();
    return forName0(className, true, ClassLoader.getClassLoader(caller), caller);
}
```

关键不是方法名，而是传给 native `forName0` 的第二个参数：一参版本固定传入 `true`。因此默认 `Class.forName("X")` 不只是定位类，还要求对尚未初始化的类执行初始化。

三参版本才把选择权交给调用者：

```java
// Class.java:379-399
@CallerSensitive
public static Class<?> forName(String name, boolean initialize,
                               ClassLoader loader)
    throws ClassNotFoundException
{
    Class<?> caller = null;
    SecurityManager sm = System.getSecurityManager();
    if (sm != null) {
        caller = Reflection.getCallerClass();
        if (loader == null) {
            ClassLoader ccl = ClassLoader.getClassLoader(caller);
            if (ccl != null) {
                sm.checkPermission(
                    SecurityConstants.GET_CLASSLOADER_PERMISSION);
            }
        }
    }
    return forName0(name, initialize, loader, caller);
}
```

`initialize=false` 的意思不是“完全不接触这个类”，而是加载、链接后不主动执行初始化。它适合需要拿到类型信息、但不想在扫描阶段触发静态块的场景。真正的类加载器委派、类文件查找和 VM 内部 `Class` 创建不在这两个 Java 方法里完成；这里能确定的是，Java 层把初始化意图传给 VM，VM 再按该意图推进类生命周期。

### 为什么 JDBC 驱动会靠这个副作用注册

老式 JDBC 的典型模式是：驱动类的静态初始化器调用 `DriverManager.registerDriver`。应用只要按类名调用默认 `forName`，初始化动作就会发生，注册也随之发生。

所以“`Class.forName` 能注册驱动”并不是 `Class` 对象拥有注册能力，而是调用者利用了类初始化副作用。真正的角色关系是：

```text
框架调用 Class.forName(name)
   → Class 把 initialize=true 交给 VM
   → VM 初始化目标类
   → 目标类的静态初始化器执行
   → 静态代码完成驱动注册
```

失败方案是用 `Class.forName` 做大规模类扫描，却把所有静态初始化都当成安全的元数据读取。更稳妥的做法是根据目的选择入口：只想定位类型时，显式使用 `forName(name, false, loader)`；确实依赖静态注册时，才让初始化发生，并把副作用当成启动流程的一部分管理。

这里还要划清与 `loadClass` 的边界：`ClassLoader.loadClass` 的默认行为是不初始化目标类，完整的加载、链接、委派和初始化时序属于域 07。本文只保留一个足够支撑使用判断的结论：**`forName(name)` 默认初始化，`forName(name, false, loader)` 可以关闭这一步。**

**路标：到这里先不要把 `Class` 当成“类的副本”。它更像一个由 VM 管理的视图入口；`forName` 只是通过这个入口请求类，并且默认附带初始化要求。接下来要看的是，同一个视图为什么还会产生大量反射对象。**

## 二、反射为什么仍然慢：缓存只省掉了第一层成本

### “JDK 有缓存”为什么不能推出“调用零成本”

现在换一个生产场景：框架启动时对同一个类调用很多次 `getDeclaredMethods()`。如果 JDK 每次都从 VM 重新枚举元数据，成本当然很高；因此 `Class` 内部确实有反射缓存。

但另一个极端判断同样错误：既然有缓存，应用就可以无限次调用 `getMethods()`，不需要保存任何 `Method`。缓存只说明 JDK 不必每次重新向 VM 索取同一批 root 成员，不代表每次 API 调用返回的对象、数组和视图处理都可以全部复用。

### 未命中时才向 VM 索取 root 方法

`privateGetDeclaredMethods` 的流程正好体现了这一层分工：

```java
// Class.java:3158-3174
private Method[] privateGetDeclaredMethods(boolean publicOnly) {
    Method[] res;
    ReflectionData<T> rd = reflectionData();
    if (rd != null) {
        res = publicOnly ? rd.declaredPublicMethods : rd.declaredMethods;
        if (res != null) return res;
    }
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

角色时序是：

```text
getDeclaredMethods
   → Class 取 ReflectionData
   ├── 命中 declaredMethods：直接拿 root 数组
   └── 未命中：调用 native getDeclaredMethods0
                    → 过滤结果
                    → 写回 ReflectionData
```

这套缓存省掉的是“重新向 VM 枚举并构造 root 成员”的成本。`getDeclaredMethods0` 是 native 入口，Java 源码不会展示 VM 侧如何遍历类元数据；但调用位置足以说明 Java 层的分界：只有没有可用缓存时，才向 VM 请求新数组。

### `getMethods` 还要处理 public 继承视图

`getDeclaredMethods` 只关心当前类声明的方法；`getMethods` 要得到 public 方法视图，还要把父类的 public 方法递归合并。JDK 11 在 `privateGetPublicMethods` 中先处理当前类，再向父类继续取：

```java
// Class.java:3180-3199
private Method[] privateGetPublicMethods() {
    Method[] res;
    ReflectionData<T> rd = reflectionData();
    if (rd != null) {
        res = rd.publicMethods;
        if (res != null) return res;
    }

    PublicMethods pms = new PublicMethods();
    for (Method m : privateGetDeclaredMethods(/* publicOnly */ true)) {
        pms.merge(m);
    }
    Class<?> sc = getSuperclass();
    if (sc != null) {
        for (Method m : sc.privateGetPublicMethods()) {
            pms.merge(m);
        }
    }
```

因此“反射慢”至少有三种来源：

1. 首次访问向 VM 索取类成员元数据。
2. 生成和包装 `Method`、`Field`、`Constructor` 等 Java 反射对象。
3. 为 public 视图做过滤、覆盖和继承合并。

缓存主要缓解第一层，也缓存部分中间结果；它不能让每一次面向调用者的 API 都返回同一组可变状态对象。

### `ReflectionData` 不是永久缓存

`ReflectionData` 保存多个成员数组，但它被一个 `SoftReference` 持有，并记录创建时的 `classRedefinedCount`：

```java
// Class.java:2941-2970
private static class ReflectionData<T> {
    volatile Field[] declaredFields;
    volatile Field[] publicFields;
    volatile Method[] declaredMethods;
    volatile Method[] publicMethods;
    volatile Constructor<T>[] declaredConstructors;
    volatile Constructor<T>[] publicConstructors;
    final int redefinedCount;
}

private transient volatile SoftReference<ReflectionData<T>> reflectionData;
private transient volatile int classRedefinedCount;
```

读取缓存时，两个条件必须同时满足：SoftReference 仍然能取到对象，且缓存记录的重定义次数等于当前类的重定义次数。

```java
// Class.java:2973-2984
private ReflectionData<T> reflectionData() {
    SoftReference<ReflectionData<T>> reflectionData = this.reflectionData;
    int classRedefinedCount = this.classRedefinedCount;
    ReflectionData<T> rd;
    if (reflectionData != null &&
        (rd = reflectionData.get()) != null &&
        rd.redefinedCount == classRedefinedCount) {
        return rd;
    }
    return newReflectionData(reflectionData, classRedefinedCount);
}
```

这两个失效条件分别对应两种现实：内存压力下，JVM 可以回收反射缓存；JVMTI 重定义类或父类后，原来的成员视图可能不再代表当前类结构。下一次访问必须重建，而不是继续相信旧数组。

**这里的关键不是“JDK 有没有缓存”，而是“缓存到底缓存了哪一层”。它缓存的是面向 JDK 内部使用的 root 视图，不是一个可以无条件发给所有调用者的永久对象池。**

## 三、为什么反射对象必须复制，而 accessor 反而要共享

### 最直觉的优化会破坏 `setAccessible`

如果同一个类的方法信息已经在 `ReflectionData` 中，最简单的优化就是把缓存里的 root `Method` 直接返回给所有调用者。这样既不用创建新对象，也不用维护 root/copy 关系。

问题在于反射对象不是纯只读描述。`Method`、`Field` 和 `Constructor` 都继承了 `AccessibleObject` 的访问状态。调用者 A 对自己的反射对象执行 `setAccessible(true)`，不应该改变调用者 B 对同一成员的访问语义。

如果大家共享同一个 `Method`，访问权限状态就变成全局可变状态：

```text
调用者 A：setAccessible(true)
        ↓
共享 Method.override 被改变
        ↓
调用者 B 也被动获得同样的访问状态
```

因此 JDK 不能直接暴露缓存里的 root 对象。它必须给调用者一个独立的 Java 反射对象，同时还要找到不重复创建底层执行器的办法。

### `Method.copy()` 解释了 root/copy 设计

JDK 11 的 `Method.copy()` 注释直接说明了动机：由于 `AccessibleObject` 的 accessibility 位，每次从 `Class` 暴露成员时需要制造新的反射对象；但这些对象仍然指向同一个 VM 方法。

```java
// Method.java:149-166
Method copy() {
    if (this.root != null)
        throw new IllegalArgumentException("Can not copy a non-root Method");

    Method res = new Method(clazz, name, parameterTypes, returnType,
                            exceptionTypes, modifiers, slot, signature,
                            annotations, parameterAnnotations, annotationDefault);
    res.root = this;
    res.methodAccessor = methodAccessor;
    return res;
}
```

结构可以这样理解：

```text
Class 内部保存 root Method
   ├── 对外 copy A：独立的 AccessibleObject 状态
   ├── 对外 copy B：独立的 AccessibleObject 状态
   └── root/copy：共享同一个底层 MethodAccessor
```

这不是“为了复杂而复杂”。它同时满足两个冲突要求：

- Java 层反射对象必须隔离，避免一个调用者改变另一个调用者的 `override` 状态。
- 对同一个底层方法，调用执行器、膨胀计数和生成结果应尽量共享，避免每拿一次 `Method` 都重新构建执行路径。

### accessor 是如何沿 root 传播的

`Method.invoke` 只负责检查访问状态、取 accessor、转发调用：

```java
// Method.java:555-566
{
    if (!override) {
        Class<?> caller = Reflection.getCallerClass();
        checkAccess(caller, clazz,
                    Modifier.isStatic(modifiers) ? null : obj.getClass(),
                    modifiers);
    }
    MethodAccessor ma = methodAccessor;
    if (ma == null) {
        ma = acquireMethodAccessor();
    }
    return ma.invoke(obj, args);
}
```

当 copy 还没有自己的 accessor 时，`acquireMethodAccessor` 先沿 root 查找；如果 root 也没有，才通过 `ReflectionFactory` 创建，并把结果向 root 传播：

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

所以同一个底层方法的多个 `Method` copy，最终可以使用同一个 accessor。下一篇会继续追这个 accessor：它不是一个固定实现，而是先经过委托和 native 路径，再可能膨胀成运行时生成的字节码。

### Field 和 Constructor 也遵守同一取舍

字段需要同时维护普通访问器和 override 访问器：

```java
// Field.java:80-90
// Cached field accessor created without override
private FieldAccessor fieldAccessor;
// Cached field accessor created with override
private FieldAccessor overrideFieldAccessor;
// For sharing of FieldAccessors. This branching structure is
// currently only two levels deep (i.e., one root Field and
// potentially many Field objects pointing to it.)
private Field               root;
```

取用时根据当前对象的 `override` 状态选择对应分支；没有就沿 root 查找，仍然没有才创建并向 root 传播：

```java
// Field.java:1081-1106
private FieldAccessor getFieldAccessor(Object obj)
    throws IllegalAccessException
{
    boolean ov = override;
    FieldAccessor a = (ov) ? overrideFieldAccessor : fieldAccessor;
    return (a != null) ? a : acquireFieldAccessor(ov);
}

private FieldAccessor acquireFieldAccessor(boolean overrideFinalCheck) {
    FieldAccessor tmp = null;
    if (root != null) tmp = root.getFieldAccessor(overrideFinalCheck);
    if (tmp != null) {
        if (overrideFinalCheck)
            overrideFieldAccessor = tmp;
        else
            fieldAccessor = tmp;
    } else {
        tmp = reflectionFactory.newFieldAccessor(this, overrideFinalCheck);
        setFieldAccessor(tmp, overrideFinalCheck);
    }
    return tmp;
}
```

构造器的 `newInstance` 也先读取自己的 accessor，缺失时再走 `acquireConstructorAccessor`；它和方法的 root 共享结构是同一类设计。反射 API 的三个成员家族因此形成统一模式：**外部对象隔离访问状态，内部 accessor 尽量复用执行能力。**

## 四、Class 不只缓存成员，也缓存注解视图

这里先停下来做一个路标。本文的主题不是注解，但如果只把 `ReflectionData` 当成某个方法数组的优化，会低估 `Class` 的角色。JDK 11 还用同样的“懒创建 + 版本校验 + 缓存视图”思路处理注解数据。

`getAnnotation` 和 `getDeclaredAnnotation` 都不是直接扫描 class 文件字节：

```java
// Class.java:3649-3653
public <A extends Annotation> A getAnnotation(Class<A> annotationClass) {
    Objects.requireNonNull(annotationClass);
    return (A) annotationData().annotations.get(annotationClass);
}
```

`annotationData()` 会校验当前缓存是否仍对应 `classRedefinedCount`；失效后重新解析并通过 CAS 安装新数据：

```java
// Class.java:3738-3753
private AnnotationData annotationData() {
    while (true) {
        AnnotationData annotationData = this.annotationData;
        int classRedefinedCount = this.classRedefinedCount;
        if (annotationData != null &&
            annotationData.redefinedCount == classRedefinedCount) {
            return annotationData;
        }
        AnnotationData newAnnotationData = createAnnotationData(classRedefinedCount);
        if (Atomic.casAnnotationData(this, annotationData, newAnnotationData)) {
            return newAnnotationData;
        }
    }
}
```

这段代码此处只承担一个结论：`Class` 是反射信息的缓存和视图中枢。成员、注解等不同信息都需要面对懒解析、并发安装和类重定义失效。下一篇讲 `MethodAccessor`，实际上是在继续追踪这个视图中某个成员的“执行出口”。

## 收网：反射的三个使用规则

回到开头两个现场。

驱动加载时，问题不是 `Class` 对象神秘地注册了驱动，而是默认 `forName` 把初始化要求传给了 VM，静态初始化器完成了注册。只想扫描类型时，必须明确是否允许初始化副作用。

框架反复获取成员时，问题也不只是“native 慢”。JDK 通过 `ReflectionData` 缓存 root 成员，避免每次重新向 VM 索取；但对外对象还要保持访问状态隔离，所以 `Method`/`Field`/`Constructor` 必须复制。为了不让复制带来更大的调用代价，底层 accessor 又沿 root 共享。

把整条机制压缩成一张图：

```text
Class.forName(name)
   → forName0(name, true, loader, caller)
   → 类加载/链接/初始化
   → 可能触发静态注册

getDeclaredMethods()
   → ReflectionData 命中？
   ├── 是：复用 root 成员视图
   └── 否：向 VM 索取并缓存
          ↓
     对外复制 Method
          ↓
     copy 隔离 override，root 共享 MethodAccessor
```

实际使用时记住三条规则：

1. 只想拿类型信息时，不要把默认 `Class.forName` 当成无副作用查询；明确使用 `initialize=false` 的入口。
2. 不要把 JDK 内部 `ReflectionData` 缓存理解成应用无需缓存 `Method`/`Field` 的理由；高频框架路径仍应复用自己的反射对象。
3. 看到 root/copy 时，不要把它看成无意义的对象复制；它是 `setAccessible` 状态隔离与 accessor 共享之间的折中。

到这里，`Class` 已经把成员交给了 `Method`，但 `Method.invoke` 还没有真正调用目标方法。下一篇继续追问：同一个 accessor 为什么先走 native，又为什么调用次数增加后会现场生成字节码？

> → 下一篇：[MethodAccessor 与反射调用](02-methodaccessor.md)
