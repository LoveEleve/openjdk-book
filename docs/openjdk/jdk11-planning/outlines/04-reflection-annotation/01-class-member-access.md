# 01. Class 对象与成员获取 — forName、ReflectionData 缓存、native 边界

> 🔴 Deep | 域 04 反射与注解第 1 篇 | Layer 2
> 读者处境: 面试"Class.forName 和类加载的关系"+"getMethods 为什么慢"——Class 对象怎么来的、成员数组从哪拿的、缓存怎么做的。

### 1. "Class.forName 做了什么？" — 加载、链接、初始化

场景: `Class.forName("com.mysql.jdbc.Driver")` 驱动注册——为什么加载就够,而 forName 会执行静态块?

- `Class.java:312` `forName(String)` → `forName0`(native,`Class.java:380` 的三参版带 initialize 参数)
- 语义: forName(name) **默认 initialize=true** → 触发类初始化(静态块执行);而 `ClassLoader.loadClass` 不初始化(域 07)
- forName0 native → 内部调用 JVM 类加载(内部卷: 类加载链)——返回已加载类的 Class 对象(缓存于 VM)
- 关键设计 (斜体): *JDBC 驱动的"注册"就是靠 forName 的初始化副作用(静态块调 DriverManager.registerDriver);`Class.forName(name, false, loader)` 可跳过初始化——面试题"怎么加载类但不执行静态块"*
- 面试: "Class 对象谁创建的?"——类加载时由 VM 创建并缓存,forName/类引用返回同一对象
- [内部卷: 07-classfile-classloader 类加载链;Class 对象的 JVM 侧镜像 java_lang_Class]

### 2. "getMethods 为什么慢/为什么该缓存？" — ReflectionData 软引用缓存

场景: 生产代码每次调用都 getDeclaredMethods()——性能差的根源

- `Class.java:1899` `getMethods()` / `2304` `getDeclaredMethods()` — 首次调用走 native `getDeclaredMethods0`(`Class.java:3406`)→ 构造 Method 对象数组 → 过滤排序
- 缓存: `Class.java:2941` `ReflectionData<T>` — 持有 declaredFields/publicFields/declaredMethods/publicMethods/constructors 的 **volatile 数组快照**
- `Class.java:2973` `reflectionData()` — 懒创建,字段是 `SoftReference<ReflectionData<T>>`(`Class.java:2966`),内存不足时缓存可被回收,下次重建
- 关键设计 (斜体): *反射慢的真相: ① native 遍历类元数据 ② 为每个成员 new 一个 Method/Field 对象 ③ 过滤 public/继承合并——缓存只省 ①②,不省 ③(每次 getMethods 仍返回新数组);生产正确姿势: 自己缓存 Method 对象*
- `Method.java:150` 的 copy 分享机制: 每个 getMethod 调用返回 root 的 copy(共享 methodAccessor)——见第 2 篇
- 面试: "为什么多次 getMethod 开销大?"——反射对象是"新建的",缓存数组只是避免 native 重扫

### 3. "成员对象怎么来的？" — Method/Field/Constructor 结构

场景: `clazz.getMethod("foo").invoke(...)` — Method 对象里存了什么?

- `Method.java:85` — `private volatile MethodAccessor methodAccessor;` — 调用执行器(volatile,见第 2 篇)
- `Method.java:86-150` — root/copy 分享树: 每类成员一个 root,getMethod 返回 root 的浅拷贝(copy 共享 methodAccessor 与 slot)——**一个类的同一方法只生成一次 MethodAccessor**
- `Constructor.java:475` `newInstance(Object...)` → `acquireConstructorAccessor`(518)— 与 Method 同构
- `Field.java:81-83` — `fieldAccessor` / `overrideFieldAccessor`(setAccessible 后切换的访问器)
- 关键设计 (斜体): *反射对象的"拷贝-共享"设计: 成员对象可丢弃(每次 getMethod 都新建),但底层 accessor 全局共享——这是反射性能的最后防线*
- [C++: 内部卷 06-oops(成员元数据 Klass/Method 在 VM 侧的存储,Java 反射对象只是"视图")]

---

### 核心悬念

Method 对象拿到了,`invoke()` 到底怎么执行的?——三层 MethodAccessor: 先走 Delegating,首 15 次用 native,超过阈值后 JVM **现场生成字节码**。下一篇: 反射为什么慢 + JVM 怎么优化。

> → [02-methodaccessor.md](02-methodaccessor.md)
