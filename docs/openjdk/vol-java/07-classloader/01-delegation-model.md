# 01. 双亲委派模型与加载流程 — loadClass 三步骤、defineClass、自定义加载器

> **前置依赖**: [04-reflection-annotation/01 — Class 对象](../04-reflection-annotation/01-class-member-access.md)(forName 与类加载的关系)、[04-reflection-annotation/04 — 注解](..//04-reflection-annotation/04-annotation.md)(注解在加载时进入 Class 对象)
> → **后续**:[07-classloader/02 — 内置类加载器](02-builtin-classloaders.md)
> 关联: 内部卷 07-classfile-classloader 04-system-dictionary(加载器命名空间);JVM Spec: §5.3-5.5(加载/链接/初始化)

## 双亲委派,一行一行讲

"双亲委派模型"是类加载面试的必考题——但大多数人只能背结论("先问父类,父找不到自己找"),被追问"loadClass 源码长什么样""findClass 和 defineClass 谁该覆写""并发加载会不会重复"时就卡住了。

这篇把 `ClassLoader.loadClass` 逐行拆开: 三步骤的完整序列、findClass/defineClass 的模板方法契约、类加载锁的细粒度化、以及"加载"与"初始化"的分离。

## 1. "loadClass 的三步是什么" — 查缓存 → 委派父类 → 自己找

### 1.1 完整源码

`ClassLoader.loadClass(String, boolean)`(`ClassLoader.java:571-600`):

```java
// ClassLoader.java:571-600(截取核心,逐字)
protected Class<?> loadClass(String name, boolean resolve)
    throws ClassNotFoundException
{
    synchronized (getClassLoadingLock(name)) {
        // First, check if the class has already been loaded
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
                // ClassNotFoundException thrown if class not found
                // from the non-null parent class loader
            }

            if (c == null) {
                // If still not found, then invoke findClass in order
                // to find the class.
                long t1 = System.nanoTime();
                c = findClass(name);
                ...
```

### 1.2 三步拆解

1. **查缓存**(`ClassLoader.java:576`):`findLoadedClass(name)`——native `findLoadedClass0`(`ClassLoader.java:1289`)查"本加载器已加载"的缓存,已加载直接返回
2. **委派父类**(`ClassLoader.java:581`):`parent.loadClass(name, false)`——**先问父加载器**;parent 为 null(说明本加载器是委派链顶层)时走 `findBootstrapClassOrNull`(`ClassLoader.java:583`)直接问启动加载器
3. **自己找**(`ClassLoader.java:594`):父没找到(抛 CNFE 被吞,或返回 null)→ `findClass(name)` 自己找

### 1.3 为什么"先父后己"

**类一致性**: 同一个全限定名,全 JVM 只能有一个定义(由"加载器 + 类名"二元组决定,第 3 节展开)。`java.lang.String` 必须由 Bootstrap 加载——如果应用加载器先加载,`new String()` 引用的 String 与 `java.lang.String` 就不是同一个类,整个类型系统崩塌。委派保证**越靠核心的类越早被高层加载器加载**。

委派链的终点是**启动加载器**(parent 为 null 的顶层加载器)——启动加载器不是 ClassLoader 实例,它是 VM 本身。

关键设计(斜体):*"先父后己"保证核心类一致性;注意 `parent.loadClass(name, false)` 传的 resolve=false——委派只问"类对象存在吗",不做链接。面试区分: `ClassLoader.loadClass(name)`(public,不 resolve)vs `Class.forName(name)`(域 04,默认 initialize=true)——JDBC 驱动注册靠 forName 的初始化,loadClass 不触发。*

## 2. "findClass 和 defineClass 的分工" — 契约与边界

### 2.1 findClass:扩展点,默认抛异常

`findClass`(`ClassLoader.java:723-727`):

```java
// ClassLoader.java:723-727(截取核心,逐字)
protected Class<?> findClass(String name) throws ClassNotFoundException {
    throw new ClassNotFoundException(name);
}
```

默认实现就是抛异常——**它是留给子类覆写的扩展点**: 覆写它,读字节码,调 `defineClass`。

### 2.2 defineClass:交给 VM 的固定动作

`defineClass`(`ClassLoader.java:806` 起)是 `final` 方法——骨架固定,内部转 native:

```
defineClass(byte[], off, len) → ... → defineClass1(@1022,byte[] 版)/defineClass2(@1114,ByteBuffer 版)
                                        └── native(@1119/@1122):字节码 → Class 对象的唯一入口
```

字节码的校验、常量池解析、类定义全在 VM 侧完成——Java 侧只负责"提供字节"。

### 2.3 模板方法模式

整个设计是**模板方法模式**:

```
loadClass(骨架固定: 缓存 → 委派 → 找)
  └── findClass(可覆写: 子类提供字节)
        └── defineClass(final: 交给 VM)
```

**自定义类加载器的正确姿势: 只覆写 findClass**——读字节(文件/网络/解密)→ 调 defineClass。两个常见应用:

- **加密类加载器**:覆写 findClass,解密字节后 defineClass
- **热部署**:新加载器实例加载新版本类——类隔离(同名的两个版本由不同加载器定义,互不干扰)

关键设计(斜体):*如果覆写 loadClass 就绕过了双亲委派(不再先问父类)——这就是"打破双亲委派"的做法。面试答"自定义加载器覆写谁": findClass(提供字节)+ defineClass(交给 VM)是标准姿势;覆写 loadClass 是特殊场景(Tomcat 的 WebAppClassLoader 等)。*

## 3. "类加载锁与并发" — getClassLoadingLock

### 3.1 锁的语义

loadClass 整个方法体包在 `synchronized (getClassLoadingLock(name))`(`ClassLoader.java:574`)——防止**同一加载器**并发加载**同一个类**导致重复定义。锁的粒度由 `getClassLoadingLock`(`ClassLoader.java:669-680`)决定:

```java
// ClassLoader.java:669-680(截取核心,逐字)
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

- **默认**:返回 `this`——整个加载器一把全局锁,所有类加载串行(JDK1.5 时代)
- **并行能力加载器**:调 `registerAsParallelCapable()`(`ClassLoader.java:1623`)后,`parallelLockMap`(`ClassLoader.java:303` 的 ConcurrentHashMap)非 null——**每类名一把锁**(`putIfAbsent` 细粒度),不同类可以并发加载

### 3.2 锁只是优化,唯一性由 VM 保证

关键认知: Java 层的锁只是**避免重复加载的优化**——类的唯一性由 JVM 的 **systemDictionary** 保证("加载器 + 类名"二元组 → 唯一 Class 对象)。即使 Java 层锁漏了(两个线程并发走到 findClass),VM 侧在 **defineClass 时**也会做 systemDictionary 检查: 同一 (加载器, 类名) 重复定义会直接失败——`findLoadedClass0` 的 native 查询只是"查已加载缓存",不是唯一性的最终裁决。

**两个加载器能加载同一个类吗?能**——"同一个类"的定义 = 加载器 + 全限定名;不同加载器加载同名类就是两个类(命名空间隔离),这就是类隔离/热部署的机制基础。

关键设计(斜体):*"两个加载器加载同一个类"是能——这正是隔离的语义: 同名的两个类在不同命名空间互不可见。面试答出"类唯一性 = 加载器 + 类名二元组,VM 侧 systemDictionary 保证"就比背"双亲委派"高一档。*

跨层标注: [内部卷: 07-classfile-classloader 04-system-dictionary(加载器命名空间与类唯一性)]

## 4. "类什么时候被初始化" — 解析与初始化时机

### 4.1 resolve 参数是什么

`loadClass(name, resolve)` 的 `resolve=true` 时,加载完成后调 `resolveClass`(`ClassLoader.java:1222`):

```java
// ClassLoader.java:1222-1225(截取核心,逐字)
protected final void resolveClass(Class<?> c) {
    if (c == null) {
        throw new NullPointerException();
    }
    ...
```

resolve 对应 JVM 的**链接**阶段(verify/prepare/resolve)——Java 侧只控制"是否立即 resolve",默认调用(`ClassLoader.loadClass(name)`)传 false。

### 4.2 初始化:由"主动使用"触发

**初始化(静态块执行)不在 loadClass 触发**——由 JVM 的"主动使用"触发:

- `new` 实例
- 静态方法/静态字段访问
- `Class.forName(name)`(initialize=true,域 04)
- 反射调用/初始化子类等

所以 `ClassLoader.loadClass("com.mysql.jdbc.Driver")` 加载完类,**静态块不执行**、驱动不注册;`Class.forName(...)` 才会。

关键设计(斜体):*委派与初始化分离: loadClass 只保证"类对象存在",初始化推迟到真正使用。这是 JDBC 驱动"forName 注册 vs loadClass 不注册"差异的根源(域 04 已见)。面试"类什么时候初始化"答出"主动使用触发、loadClass 不触发"就完整。*

跨层标注: [JVM Spec: §5.3-5.5 加载/链接/初始化;内部卷 07-classfile-classloader]

## 核心悬念

双亲委派的三层"父母"是谁?——JDK11 已经没有 `sun.misc.Launcher` 了,替代者是 `jdk.internal.loader` 里的 **BootClassLoader / PlatformClassLoader / AppClassLoader**。三层的职责边界怎么划分?模块化之后类路径和模块路径怎么参与加载?下一篇: 内置类加载器。

> → [07-classloader/02 — 内置类加载器](02-builtin-classloaders.md)
