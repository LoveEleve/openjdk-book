# 04. 注解体系 — 元模型、AnnotationParser 解析链、运行时注解

> 🔴 Deep | 域 04 反射与注解第 4 篇 | Layer 2
> 读者处境: 面试"注解怎么生效的?"+"@Autowired 为什么能注入?"——从元注解到字节流解析,注解机制的完整链条。

### 1. "注解的注解" — 元模型

场景: 写一个 @MyAnno 需要哪些前置知识?元注解怎么控制行为?

- `java/lang/annotation/` 13 个文件构成元模型:
  - `Retention.java` + `RetentionPolicy.java:37`(SOURCE 41/CLASS 48/RUNTIME 56)— **保留策略**: 源码/class 文件/运行时(反射可见)
  - `Target.java` + `ElementType` — 作用目标(类/方法/字段/参数/...)
  - `Inherited` — 子类继承父类注解
  - `Repeatable` — 重复注解容器(JDK8+)
  - `Documented`/`Native` — 文档/常量池标记
  - `Annotation.java` — 所有注解的公共接口(equals/hashCode/toString/annotationType)
- 关键设计 (斜体): *注解本质是"接口 + class 文件里的属性表"——@interface 编译后是接口,注解信息存在 class 文件 `RuntimeVisibleAnnotations` 属性;Retention 决定它留到哪一层*
- 面试: "@Retention 三个值区别"——RUNTIME 才能被反射读到(框架注解都是 RUNTIME)
- [内部卷: 07-classfile-classloader(注解属性解析在 class 文件层);JVM Spec §4.7.16]

### 2. "注解对象怎么来的？" — AnnotationParser 解析链

场景: `clazz.getAnnotation(MyAnno.class)` — 返回的 Annotation 对象从哪来?

- `Class.java:3649` `getAnnotation(Class)` → `annotationData().annotations.get(...)` — **AnnotationData 懒解析缓存**(`Class.java:3738`): 首次访问才 `AnnotationParser.parseAnnotations(getRawAnnotations(), ...)`(`Class.java:3757-3758`);`getDeclaredAnnotation`(3692)读 `declaredAnnotations`
- `sun/reflect/annotation/AnnotationParser.java:65` `parseAnnotations(byte[], constPool, container)` → `parseAnnotations2`(111)→ `parseAnnotation2`(231)— **逐字节解析注解属性表**: type→元素值(基本类型/枚举/Class/嵌套注解/数组)
- 特殊实现: 注解对象的成员访问走 `AnnotationInvocationHandler`(sun/reflect/annotation/)— 动态代理!`annotationType()` 等由代理方法映射到解析出的值表
- 关键设计 (斜体): *注解对象 = AnnotationInvocationHandler 动态代理(把注解接口方法映射到解析值),不是普通实现类——这就是为什么注解"接口方法没有实现却能调用";解析是**惰性**的: 只有 getAnnotation 才解析字节*
- 面试: "注解实现类在哪?"——没有实现类,是代理;面试加分点
- [C++: 内部卷 07-classfile 的注解属性存储;JVM Spec §4.7.16 RuntimeVisibleAnnotations]

### 3. "重复注解与继承" — getAnnotationsByType 语义

场景: `@MyAnno("a") @MyAnno("b")` 同一处标两次——JDK8 怎么支持?

- `Repeatable` 元注解: 声明容器注解 `@MyAnnos(MyAnno[])`
- `Class.java:3670` `getAnnotationsByType` — 自动在"单注解"和"容器注解"间查找合并
- `Inherited`: 继承语义在 `annotationData()` 层实现(`Class.java:3738`)——`annotations` 懒合并父类的 `superClass.annotationData().annotations`(3764),`declaredAnnotations` 不含;getAnnotations/getAnnotation 返回含继承视图,getDeclared* 只本类
- 关键设计 (斜体): *getAnnotationsByType 是"视图合并"——它同时查直接标注与容器包装;继承语义只在 getAnnotations 生效(declared 版本不查父类)——面试常考区别*
- 生产: Spring 的 @AliasFor/合成注解原理(在 AnnotationUtils 里读注解属性——域外但机制同源)

### 4. "框架注解驱动" — 机制闭环

场景: @Transactional/@Component 怎么让框架感知?——反射读注解 → 装配

- 流程: 类扫描(ASM 读 class,域外)→ Class 对象 → `getAnnotation`/`getDeclaredAnnotations` → 按注解类型分派处理
- 注解信息的消费方: Spring 的 AnnotatedElementUtils、MyBatis 的 @Mapper 扫描
- 关键设计 (斜体): *注解本身不执行任何代码——它只是"标签";所有行为来自读取方(框架的处理器)。面试"注解怎么生效"的完整答案: 编译期(APT)或运行期(反射)由读取方解释*
- 本域闭环: Class(读取入口)→ AnnotationParser(解析)→ AnnotationInvocationHandler(代理对象)→ 框架消费(Spring/MyBatis)
- [关联: 域 07 类加载(注解在 class 文件加载时进入 Class 对象)]

---

### 核心悬念

反射和注解都建立在"类已经加载"之上——那**类是谁加载的**?String 为什么一定被 Bootstrap ClassLoader 加载?双亲委派模型长什么样、怎么打破?——下一站: 域 07 类加载器。

> → 下一篇: 域 07 类加载器(07-classloader 系列) | 关联: 域 32 Unsafe(setAccessible 的底层)
