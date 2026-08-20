# 域 04: 反射与注解 — 完整性验证

> 全视角身份检查(≥5 身份)

## 身份 1: 面试官
- [x] "Class.forName vs loadClass(初始化副作用)" — 01 篇 §1(Class.java:312/380)
- [x] "反射为什么慢/怎么缓存" — 01 篇 §2-3(ReflectionData 2941/2973、root/copy 分享)
- [x] "MethodAccessor 三层/膨胀阈值" — 02 篇 §1-2(NativeMethodAccessorImpl:49、inflationThreshold=15)
- [x] "setAccessible 提高性能的原因" — 02 篇 §3(overrideFieldAccessor)
- [x] "JDK 动态代理原理/$Proxy0" — 03 篇 §1-2(Proxy.java:997/298、ProxyGenerator.java:55/321)
- [x] "JDK 代理 vs CGLIB" — 03 篇 §1
- [x] "JDK9+ 反射受限/--add-opens" — 03 篇 §3(AccessibleObject.java:183、ReflectUtil)
- [x] "注解怎么生效/注解实现类在哪" — 04 篇 §2-3(AnnotationParser.java:65/231、AnnotationInvocationHandler)
- [x] "@Retention 三个值/重复注解" — 04 篇 §1/3(RetentionPolicy.java:37/41/48/56、getAnnotationsByType 3670)

## 身份 2: 生产工程师
- [x] 反射调用性能优化(缓存+setAccessible+阈值) — 02 篇 §4
- [x] 模块封装导致反射失败(框架报错排查) — 03 篇 §3
- [x] 自定义注解设计(Retention/Target 选择) — 04 篇 §1

## 身份 3: 框架工程师
- [x] Spring AOP 的 JDK 代理原理 — 03 篇 §1-2/4
- [x] MyBatis mapper 代理、Spring 注解驱动 — 03/04 篇
- [x] Spring @AliasFor/合成注解 — 04 篇 §3
- [x] 框架反射优化三板斧 — 02 篇 §4

## 身份 4: 源码方法论文审查
- [x] 场景句/源码锚(已验证 Class.java:312/380/1899/2304/2352/2941/2973/2990/3406/3649/3670/3692/3713/3758, Method.java:85/150/552/558/562/566, Field.java:81-83, Constructor.java:475/518, AccessibleObject.java:183/185, Proxy.java:298/417/997, ProxyGenerator.java:55/321/333, NativeMethodAccessorImpl.java:49, ReflectionFactory.java:88/189/207, AnnotationParser.java:65/111/121/231, RetentionPolicy.java:37/41/48/56)/关键设计/跨层([内部卷]/[JVM Spec]/[C++])/核心悬念+OUTBOUND
- [x] 无文字描述源锚(自查 grep 通过)
- [x] 域发现 v2 已同步: sun/reflect(65)→jdk/internal/reflect(71)+sun/reflect(annotation/generics/misc)

## 身份 5: 完整性缺口检查
- [x] 成员访问(01)/MethodAccessor(02)/代理与访问控制(03)/注解(04)四篇覆盖域全部面试主战场
- [x] sun/reflect/generics(泛型签名解析)🟢 Surface,KP 标注,未展开成篇
- [x] Class 类型判断族(isPrimitive/isInstance)🟢,并入 01 篇 §1 提及
- [x] Executable 基类(Method/Constructor 公共逻辑)并入 01/02 篇
- [x] 未覆盖确认: MethodHandle/invoke dynamic(面试偶尔)——标记为域外,OUTBOUND 提及
- [x] 二次 review 修正: FieldAccessorGenerator 不存在(字段访问器为 FieldAccessorImpl+Unsafe* 族,UnsafeFieldAccessoryFactory 创建);checkAccess 仅未 override 时调用(Method.java:556);noInflation 属性直连生成路径(ReflectionFactory.java:702/707);代理类包名规则(非公共接口同包/公共接口 com.sun.proxy,Proxy.java:508-512);ClassDefiner 走 Unsafe.defineClass(63);getAnnotation 走 annotationData() 缓存含 Inherited 合并(3738/3764)
- [x] ReflectionData SoftReference 锚点精确定位(2966)
- [ ] 待办: 04 篇 §2 的 AnnotationInvocationHandler 代理方法映射细节、02 篇 §3 的 FieldAccessor 生成路径写作时对照 UnsafeFieldAccessorFactory 实际实现
