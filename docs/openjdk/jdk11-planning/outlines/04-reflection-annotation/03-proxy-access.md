# 03. 动态代理与访问控制 — Proxy 字节码生成、setAccessible、模块封装

> 🔴 Deep | 域 04 反射与注解第 3 篇 | Layer 2
> 读者处境: Spring AOP 的 JDK 代理、MyBatis 的 mapper 接口代理——`$Proxy0` 类怎么来的?setAccessible 为什么 JDK9+ 可能失败?

### 1. "$Proxy0 是什么？" — newProxyInstance 完整链路

场景: `Proxy.newProxyInstance(loader, interfaces, handler)` — 接口怎么变成可用对象?

- `Proxy.java:997` `newProxyInstance(ClassLoader, Class<?>[], InvocationHandler)`:
  1. 校验接口(非接口/重复/包名冲突抛 IllegalArgumentException)
  2. 查缓存 `ClassLoaderValue<Constructor<?>> proxyCache`(`Proxy.java:298`)— **代理类缓存**
  3. 未命中 → `ProxyBuilder.build()`(`Proxy.java:417`)→ **字节码生成 + 类定义**
  4. 反射取构造器 → `newInstance(handler)` — 代理对象诞生
- 生成的类名: `$Proxy` + 递增编号(`Proxy.java:477/529-530`);包名规则(`Proxy.java:508-512`): 存在非公共接口 → 与接口同包;全公共接口 → `com.sun.proxy`(命名模块时为 `com.sun.proxy.<module>`,`ReflectUtil.java:255`)
- 关键设计 (斜体): *代理类本质是"运行时编译的接口实现"——每个代理类实现全部接口,方法体里统一调用 `InvocationHandler.invoke(this, method, args)`;生成一次缓存复用(proxyCache),不重复生成*
- 面试: "JDK 代理 vs CGLIB"——JDK 代理要求接口(基于接口生成实现类),CGLIB 基于继承(域外);Spring 默认策略

### 2. "代理类的字节码怎么生成的？" — ProxyGenerator 手工组装

场景: 面试追问——没有 javac,字节码哪来的?

- `java/lang/reflect/ProxyGenerator.java:55` — 手工构造 class 文件字节(ConstantPool/ByteVector 自研,无 ASM 依赖)
- `ProxyGenerator.java:321` `generateProxyClass(name, interfaces, accessFlags)` → `generateClassFile`(字节组装: 常量池/字段/方法/接口方法桩)
- 生成的每个接口方法: 把 Method 对象放入常量池(`Methodref`),方法体 = 构造 Object[] 参数 + 调 `h.invoke(this, method, args)`
- `ClassDefiner`(`jdk/internal/reflect/ClassDefiner.java:36`)defineClass(54)— 底层走 **Unsafe.defineClass**(63),不经标准 ClassLoader.defineClass 的包检查
- 关键设计 (斜体): *"手工写字节码"的意义: 零外部依赖,任何 JDK 都能生成;代价是只能生成固定模式的代理类——这与 ASM/Javassist(域外工具)的灵活性对比,是 JDK 代理只支持接口的原因之一*
- [C++: 内部卷 07-classfile 类文件格式(常量池/方法描述符);对比: CGLIB/ASM 的增强类生成]

### 3. "setAccessible 能突破一切吗？" — 模块强封装

场景: JDK9+ 反射私有字段报 InaccessibleObjectException——module 封装

- `AccessibleObject.java:183` `setAccessible(boolean)` → `setAccessible0`(185,native)
- 检查链: 模块可访问(opens)→ 包可访问 → 类成员访问(私有/保护)
- JDK9+ 规则: 跨模块访问私有成员必须 `--add-opens`;JDK 内部模块默认不 open(反射 JDK 内部类会失败——很多框架踩过的坑)
- `ReflectUtil.checkPackageAccess`(`sun/reflect/misc/ReflectUtil.java:116`)— 包访问检查(安全管理器时代遗留)
- 关键设计 (斜体): *setAccessible 不是"万能钥匙"——它只在"同模块/已 opens"前提下跳过 Java 访问修饰符检查;模块系统把"能否反射"提升到类加载与模块层面*
- 生产: 框架(如 Spring)会检查并提示 --add-opens;面试点: "JDK9 后反射受限场景"
- [内部卷: 06-jpms-modules(模块系统与 opens 语义)]

### 4. "InvocationHandler 里有什么？" — 回调协议

场景: 实现动态代理的核心——invoke 方法收到的参数

- `InvocationHandler.java:95` `Object invoke(Object proxy, Method method, Object[] args)`
- proxy: 代理对象本身(用于 method.invoke 会死循环——必须从接口调用);method: 被调用的接口方法(可以转发到真实对象)
- 经典应用: 日志/事务/权限切面——AOP 的"切面"本质是 invoke 里的横切逻辑
- 关键设计 (斜体): *invoke 是"代理方法"的唯一出口——所有接口方法调用都汇到这里,再分发给真实对象(反射)或增强逻辑;Spring AOP 的 MethodInterceptor 就是在这个协议上再包一层*
- 面试: "为什么 invoke 里不能 method.invoke(proxy, args)"——死循环;要先拿到真实对象(通过 target 引用)

---

### 核心悬念

反射能"看"类和成员,还能"读"——**注解**就是贴在类/方法上的元数据。Spring 为什么 @Transactional 有效?注解怎么从 class 文件字节流变成 Annotation 对象?下一篇: 注解体系。

> → [04-annotation.md](04-annotation.md)
