# 03. 动态代理与访问控制 — Proxy 字节码生成、setAccessible、模块封装

> **前置依赖**: [04-reflection-annotation/01 — Class 对象与成员获取](01-class-member-access.md)(反射对象与访问检查)、[04-reflection-annotation/02 — MethodAccessor](02-methodaccessor.md)(UNSAFE.defineClass 与字节码生成的对照)
> → **后续**:[04-reflection-annotation/04 — 注解体系](04-annotation.md)
> 关联: 内部卷 06-jpms-modules(模块系统与 opens 语义)、07-classfile(类文件格式)

## 接口怎么变成可用对象

Spring AOP 的 JDK 代理、MyBatis 的 mapper 接口代理——`Proxy.newProxyInstance` 一行代码,让"只有声明没有实现"的接口在运行时变成可用对象。秘密是: **JVM 现场写了一个实现类**。`$Proxy0` 从哪来?字节码怎么生成?`setAccessible` 为什么 JDK9+ 可能失效?这篇把动态代理的完整链路和访问控制规则讲清楚。

## 1. "$Proxy0 是什么" — newProxyInstance 完整链路

### 1.1 入口:查缓存或生成

`Proxy.newProxyInstance`(`Proxy.java:997`):

```java
// Proxy.java:997-1011(截取核心,逐字)
public static Object newProxyInstance(ClassLoader loader,
                                      Class<?>[] interfaces,
                                      InvocationHandler h) {
    Objects.requireNonNull(h);

    final Class<?> caller = System.getSecurityManager() == null
                                ? null
                                : Reflection.getCallerClass();

    /*
     * Look up or generate the designated proxy class and its constructor.
     */
    Constructor<?> cons = getProxyConstructor(caller, loader, interfaces);

    return newProxyInstance(caller, cons, h);
}
```

两步: **① `getProxyConstructor`** ——查缓存或生成代理类并取构造器; **② `cons.newInstance(new Object[]{h})`**——把 InvocationHandler 作为构造参数,代理对象诞生。

### 1.2 缓存与生成:proxyCache + ProxyBuilder

代理类**生成一次、缓存复用**——`proxyCache`(`Proxy.java:298`,ClassLoaderValue 类型)按"接口列表 + 类加载器"缓存构造函数。未命中时 `ProxyBuilder.build()`(`Proxy.java:417`)执行:

```java
// Proxy.java:527-545(截取核心,逐字)
long num = nextUniqueNumber.getAndIncrement();
String proxyName = proxyPkg.isEmpty()
                        ? proxyClassNamePrefix + num
                        : proxyPkg + "." + proxyClassNamePrefix + num;

ClassLoader loader = getLoader(m);
trace(proxyName, m, loader, interfaces);

byte[] proxyClassFile = ProxyGenerator.generateProxyClass(
        proxyName, interfaces.toArray(EMPTY_CLASS_ARRAY), accessFlags);
try {
    Class<?> pc = UNSAFE.defineClass(proxyName, proxyClassFile,
                                     0, proxyClassFile.length,
                                     loader, null);
    reverseProxyCache.sub(pc).putIfAbsent(loader, Boolean.TRUE);
    return pc;
```

- **编号**:`nextUniqueNumber.getAndIncrement()`(@`Proxy.java:527`)——类名 `$Proxy` + 递增编号(`proxyClassNamePrefix = "$Proxy"`@`Proxy.java:477`)
- **字节码生成**:`ProxyGenerator.generateProxyClass`(@`Proxy.java:538`,第 2 节)
- **类定义**:直接 **`UNSAFE.defineClass`**(@`Proxy.java:541-543`)——不经标准 `ClassLoader.defineClass` 的包检查路径

### 1.3 包名规则

代理类放哪个包(`Proxy.java:500-512`):

- **存在非公共接口** → 与接口**同包**(非公共类必须有包访问权)
- **全部公共接口** → `com.sun.proxy`(`PROXY_PACKAGE_PREFIX`@`Proxy.java:511-512`;命名模块下是 `com.sun.proxy.<module>`)

包名冲突(非公共接口来自不同包)抛 IllegalArgumentException(@`Proxy.java:503-504`)。

关键设计(斜体):*代理类本质是"运行时编译的接口实现"——实现全部接口,每个方法体统一调 `InvocationHandler.invoke(this, method, args)`。生成一次缓存复用(proxyCache),不重复生成。面试"JDK 代理 vs CGLIB": JDK 代理**基于接口**(生成实现类),CGLIB 基于继承(生成子类,域外);Spring 默认: 有接口用 JDK 代理,否则 CGLIB。*

## 2. "代理类的字节码怎么生成的" — ProxyGenerator 手工组装

### 2.1 手工构造 class 文件

`ProxyGenerator`(`java/lang/reflect/ProxyGenerator.java:55`)是纯 Java 的**class 文件手工组装器**——没有 javac、没有 ASM 依赖。入口 `generateProxyClass`(`ProxyGenerator.java:321`)→ `generateClassFile`(`ProxyGenerator.java:338`): 用自研的 `ConstantPool` 类(`ProxyGenerator.java:1711`)+ `DataOutputStream`(`ProxyGenerator.java:518-519`)把常量池、字段、方法、接口方法桩逐字节写出来。

### 2.2 方法桩的形态

对每个接口方法,生成的桩方法做三件事:

1. 把对应 `Method` 对象放入常量池(Methodref 条目)
2. 把实参组装成 `Object[] args`
3. 方法体核心一条 `invokeinterface` 指令调用 `InvocationHandler.invoke(this, method, args)`(`ProxyGenerator.java:950-955` 的接口方法引用,签名 `(Ljava/lang/Object;Ljava/lang/reflect/Method;[Ljava/lang/Object;)Ljava/lang/Object;`)——**所有接口方法调用都汇到 InvocationHandler**

所以代理类的方法体是**固定模式**,与具体接口无关——差异只在常量池里的 Method 引用。

### 2.3 类定义的两条 Unsafe 路径

代理类字节码的加载有两条相关路径,容易混淆:

- **Proxy 路径**(本链路):`ProxyBuilder.build` 直接 `UNSAFE.defineClass`(`Proxy.java:541-543`)——类加载到**接口的加载器**
- **ClassDefiner 路径**(`jdk/internal/reflect/ClassDefiner.java:36`):内部也走 `unsafe.defineClass`(@`ClassDefiner.java:62`),但用 `DelegatingClassLoader`(新加载器委托给目标加载器)——这是 **MethodAccessorGenerator 生成 MethodAccessor 字节码类时**用的(`MethodAccessorGenerator.java:399`),与 02 篇的膨胀机制衔接

两条都是绕过标准 defineClass 的"特权加载"——生成的代码不需要类文件在磁盘上。

关键设计(斜体):*"手工写字节码"的意义: 零外部依赖,任何 JDK 都能生成;代价是只能生成固定模式的代理类——这就是 JDK 代理只支持接口的原因之一(接口方法的调用形态统一,可以模板化;类继承的增强需要分析任意方法体,模板做不了)。对比 ASM/Javassist(域外工具)的灵活性,JDK 内置方案选择"够用且无依赖"。*

跨层标注: [内部卷: 07-classfile(类文件格式: 常量池/方法描述符);对比: CGLIB/ASM 的增强类生成]

## 3. "setAccessible 能突破一切吗" — 模块强封装

### 3.1 setAccessible 本身很简单

`AccessibleObject.setAccessible`(`AccessibleObject.java:183-187`):

```java
// AccessibleObject.java:183-187(截取核心,逐字)
public void setAccessible(boolean flag) {
    AccessibleObject.checkPermission();
    setAccessible0(flag);
}

boolean setAccessible0(boolean flag) {
    this.override = flag;
    return flag;
}
```

注意:**它只是设一个 `override` 标志**(+ 安全管理器权限检查)——不做任何 native 调用、不检查模块。真正的访问检查发生在**后续实际访问时**(`Field.get`/`Method.invoke` 里的 `checkAccess`)。

### 3.2 检查链:模块 → 包 → 成员

JDK9+ 的实际访问检查分三层:

1. **模块层**:目标类所在模块是否对该模块 **opens**(`--add-opens` 或 module-info 声明)
2. **包层**:包是否可访问
3. **成员层**:Java 访问修饰符(private/protected/public)

**JDK 内部模块默认不 open**——反射 JDK 内部类(如 `java.lang.ref` 的私有成员)直接抛 `InaccessibleObjectException`,很多框架在 JDK9+ 踩过这个坑,解法是启动参数 `--add-opens`。`ReflectUtil.checkPackageAccess`(`sun/reflect/misc/ReflectUtil.java:116`)是包检查的遗留实现(安全管理器时代)。

关键设计(斜体):*setAccessible 不是"万能钥匙"——它只在"同模块或已 opens"的前提下跳过**成员层**的 Java 修饰符检查;模块系统把"能否反射"从成员级提升到模块级,私有成员跨模块访问必须有显式授权。面试点: "JDK9 后反射受限场景"——答出 InaccessibleObjectException + --add-opens 就完整。*

跨层标注: [内部卷: 06-jpms-modules(模块系统与 opens 语义)]

## 4. "InvocationHandler 里有什么" — 回调协议

### 4.1 协议:一个方法

`InvocationHandler`(`InvocationHandler.java:93`):

```java
// InvocationHandler.java:93-96(截取核心,逐字)
public Object invoke(Object proxy, Method method, Object[] args)
    throws Throwable;
```

三个参数: **proxy**(代理对象本身)、**method**(被调用的接口方法)、**args**(实参)。所有接口方法调用最终都汇到这里——这是"代理方法"的唯一出口。

### 4.2 两个经典陷阱

- **`method.invoke(proxy, args)` 死循环**:proxy 是代理对象,`method.invoke(proxy, ...)` 会再次进入代理 → 再次调 invoke → 无限递归。正确做法: 转发给**真实对象**(通过构造时传入的 target 引用),如 `method.invoke(target, args)`
- **返回类型强转**:invoke 的返回值会被代理类强转为接口声明的返回类型

### 4.3 AOP 的雏形

日志/事务/权限切面的实现就是"invoke 里的横切逻辑":

```
调用方 → $Proxy0.method() → h.invoke(proxy, method, args)
                                     ├── 前置增强(日志/鉴权)
                                     ├── method.invoke(target, args)  ← 真实调用
                                     └── 后置增强(提交/清理)
```

Spring AOP 的 `MethodInterceptor` 就是在 InvocationHandler 协议上再包一层: 每个 Aspect 变成拦截器链里的一个节点。

关键设计(斜体):*invoke 是"代理方法"的唯一出口——所有接口方法调用汇到这里,再分发给真实对象(反射)或增强逻辑。面试"为什么 invoke 里不能 method.invoke(proxy, args)"——死循环;答出"要先拿到真实对象(target 引用)"就是满分。*

## 核心悬念

反射能"看"类和成员、能调用、能代理——但**注解**呢?`@Transactional`、`@Autowired` 为什么有效?注解怎么从 class 文件的字节流变成 `Annotation` 对象?`@Retention(RUNTIME)` 和 `CLASS` 的区别在字节码层面是什么?Spring 怎么遍历注解?下一篇: 注解体系。

> → [04-reflection-annotation/04 — 注解体系](04-annotation.md)
