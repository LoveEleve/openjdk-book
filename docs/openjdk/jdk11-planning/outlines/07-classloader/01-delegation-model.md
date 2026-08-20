# 01. 双亲委派模型与加载流程 — loadClass 三步骤、defineClass、自定义加载器

> 🔴 Deep | 域 07 类加载器第 1 篇 | Layer 2
> 读者处境: 面试"双亲委派模型"是必考题——但能逐行讲出 loadClass 三步骤、说出 findClass/defineClass 契约的人不多。生产自定义 ClassLoader(热部署/加密类)也基于此。

### 1. "loadClass 的三步是什么？" — 查缓存 → 委派父类 → 自己找

场景: `classLoader.loadClass("com.Foo")` — 完整的执行序列

- `ClassLoader.java:571` `loadClass(String, boolean resolve)`:
  1. `synchronized (getClassLoadingLock(name))`(`ClassLoader.java:574`)— 类加载锁(防同一类并发加载)
  2. `findLoadedClass(name)`(576)— 查"本加载器已加载"的缓存(native findLoadedClass0)
  3. `parent.loadClass(name, false)`(581)— **先问父加载器**(parent 字段,`ClassLoader.java:243`)
  4. 父找不到 → `findClass(name)`(594)— 自己找
- 关键设计 (斜体): *"先父后己"是双亲委派的核心——保证 java.lang.String 永远由 Bootstrap 加载(类一致性: 同一类全 JVM 一个定义);委派链终点是启动加载器(null parent)*
- 面试: "loadClass vs forName vs ClassLoader.loadClass"——本方法 ③ 是受保护入口,外部用 `ClassLoader.loadClass(name)`(不 resolve)或反射 forName(域 04,可带 initialize)

### 2. "findClass 和 defineClass 的分工？" — 契约与边界

场景: 自定义 ClassLoader 只覆写 findClass——为什么不是覆写 loadClass?

- `ClassLoader.java:723` `findClass(String)` — **默认抛 ClassNotFoundException**;子类覆写点: 读字节 → 调 defineClass
- `ClassLoader.java:806` `defineClass(byte[], off, len)` → `defineClass2` native(`ClassLoader.java:1122`)— **字节码 → Class 对象的唯一入口**(校验/常量池解析在 VM)
- `ClassLoader.java:1283` `findLoadedClass` — 查缓存
- 关键设计 (斜体): *findClass 是"提供字节"的扩展点,defineClass 是"交给 VM"的固定动作——**模板方法模式**: loadClass 骨架固定,findClass 可覆写;自定义加载器 = 覆写 findClass 返回字节,不碰委派逻辑(若覆写 loadClass 就绕过了双亲委派)*
- 生产: 加密类加载器 = 解密字节 + defineClass;热部署 = 新加载器实例加载新版本类(类隔离)

### 3. "类加载锁与并发" — getClassLoadingLock

场景: 多线程同时 loadClass 同一类——会不会加载两次?

- `ClassLoader.java:574` synchronized(getClassLoadingLock(name)) — 每类名一把锁
- `ClassLoader.java:669` `getClassLoadingLock` — 默认返回 this(全局锁);`registerAsParallelCapable()`(`ClassLoader.java:1623`)注册的加载器用 `parallelLockMap` **每类名一把锁**(`putIfAbsent` 细粒度,669-676)
- 关键设计 (斜体): *JVM 层面 class 对象唯一性由"加载器+类名"二元组保证(内部卷 systemDictionary)——Java 层的锁只是避免同一加载器并发重复加载;findLoadedClass 的 native 查询是最终裁决*
- 面试: "两个加载器能加载同一个类吗?"——能(命名空间隔离),"同一个类"定义 = 加载器+全限定名
- [内部卷: 07-classfile-classloader(systemDictionary 与加载器命名空间)]

### 4. "类什么时候被初始化？" — 解析与初始化时机

场景: loadClass 之后类被"初始化"了吗?——resolve 参数是什么

- `loadClass(name, resolve)`: resolve=true 才调 `resolveClass`(链接阶段完成)
- 但 **初始化(静态块)不在 loadClass 触发**——由"主动使用"触发(域 04 forName(true)/new 实例/静态访问)
- 链接(verify/prepare/resolve)与初始化是 JVM 概念,Java 层只控制"是否立即 resolve"
- 关键设计 (斜体): *委派与初始化分离: loadClass 只保证"类对象存在",初始化推迟到真正使用——这是 JDBC 驱动"forName 注册"与"loadClass 不注册"差异的根源(域 04)*
- [JVM Spec §5.3-5.5: 加载/链接/初始化;内部卷 07-classfile]

---

### 核心悬念

双亲委派的三层"父母"是谁?——JDK11 没有 sun.misc.Launcher 了,替代者是 jdk.internal.loader 的 **BootClassLoader / PlatformClassLoader / AppClassLoader**。三层的职责边界、模块化后的新路径,下一篇见。

> → [02-builtin-classloaders.md](02-builtin-classloaders.md)
