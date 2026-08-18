# 04. 注解体系 — 元模型、AnnotationParser 解析链、运行时注解

> **前置依赖**: [04-reflection-annotation/01 — Class 对象与成员获取](01-class-member-access.md)(Class 的缓存模式)、[04-reflection-annotation/03 — 动态代理](03-proxy-access.md)(AnnotationInvocationHandler 就是代理)
> → **后续**:域 07 类加载器(07-classloader 系列,下一篇)
> 关联: 内部卷 07-classfile-classloader(注解属性在 class 文件层);JVM Spec: §4.7.16 RuntimeVisibleAnnotations

## 注解怎么"生效"的

`@Transactional`、`@Autowired` 天天用,但被追问"注解怎么生效的"时,大多数人的答案停在"框架扫描注解"的笼统层面。完整链条是: **@interface 编译成接口 → 注解信息进 class 文件属性表 → 运行时 AnnotationParser 逐字节解析 → AnnotationInvocationHandler 用动态代理实现接口 → 框架读取**。

这篇把元模型、解析链、重复注解与继承语义讲清楚,最后画上机制闭环。

## 1. "注解的注解" — 元模型

### 1.1 13 个文件构成元模型

`java/lang/annotation/` 下 13 个文件,核心是控制"注解行为"的元注解:

| 元注解 | 作用 |
|--------|------|
| `@Retention` | 保留策略——注解留到哪一层 |
| `@Target` | 作用目标(类/方法/字段/参数…) |
| `@Inherited` | 子类继承父类注解 |
| `@Repeatable` | 重复注解的容器(JDK8+) |
| `@Documented` / `@Native` | 文档化 / 常量池标记 |

**保留策略**(`RetentionPolicy.java:37` 的枚举)是面试第一问:

```java
// RetentionPolicy.java:37-56(枚举项截取,省略 javadoc;行内注释标注对应行号)
public enum RetentionPolicy {
    SOURCE,     // @41: 只留在源码,javac 后丢弃
    CLASS,      // @48: 留在 class 文件,但 VM 不保留(默认)
    RUNTIME     // @56: 留在 class 文件且 VM 保留(反射可见)
}
```

- **SOURCE**:编译期就没了——`@SuppressWarnings` 这类
- **CLASS**:留在 class 文件的属性表里,但**运行时读不到**——默认策略
- **RUNTIME**:反射能读到——**所有框架注解(Spring/MyBatis)必须 RUNTIME**

### 1.2 Annotation:所有注解的公共契约

`Annotation` 接口(`Annotation.java:44`)定义了四个方法: `equals`/`hashCode`/`toString` + `annotationType()`(`Annotation.java:135`,返回注解类型)。

关键设计(斜体):*注解本质是"接口 + class 文件里的属性表"——`@interface` 编译后就是普通接口,注解信息存在 class 文件的 `RuntimeVisibleAnnotations` 属性(§4.7.16);`@Retention` 决定这个属性留到哪一层(源码期丢弃/类文件保留/运行时可见)。面试"@Retention 三个值区别"答出"RUNTIME 才能被反射读到、框架注解都是 RUNTIME"就过关。*

## 2. "注解对象怎么来的" — AnnotationParser 解析链

### 2.1 入口:getAnnotation 读缓存

`Class.getAnnotation`(`Class.java:3649-3653`):

```java
// Class.java:3649-3653(截取核心,逐字)
public <A extends Annotation> A getAnnotation(Class<A> annotationClass) {
    Objects.requireNonNull(annotationClass);

    return (A) annotationData().annotations.get(annotationClass);
}
```

就是一次 Map 查询——`annotationData()`(`Class.java:3738`)返回缓存,结构是 `Map<注解类型, Annotation 对象>`。

### 2.2 annotationData:懒解析 + CAS 缓存

`annotationData()`(`Class.java:3738-3754`)与 01 篇的 ReflectionData **同构**:

- 懒创建: 首次访问才解析
- `classRedefinedCount` 校验(JVMTI RedefineClasses 后缓存失效)
- `Atomic.casAnnotationData` 并发安全替换

解析发生在 `createAnnotationData`(`Class.java:3758`):

```java
// Class.java:3758(截取核心,逐字)
AnnotationParser.parseAnnotations(getRawAnnotations(), getConstantPool(), this);
```

### 2.3 继承合并

`createAnnotationData` 解析完本类注解后,还要做**父类合并**(`Class.java:3763-3766`):

```java
// Class.java:3763-3766(截取核心,逐字,省略中间两行)
superClass.annotationData().annotations;
...
if (AnnotationType.getInstance(annotationClass).isInherited()) {
```

只合并父类中 `@Inherited` 标注的注解(第 3 节展开)。

### 2.4 AnnotationParser:逐字节解析

`AnnotationParser`(`sun/reflect/annotation/AnnotationParser.java:52`)把 class 文件里的注解属性字节流解析成 Map:

```
parseAnnotations(`AnnotationParser.java:65`) → parseAnnotations2(`AnnotationParser.java:111`) → parseAnnotation2(`AnnotationParser.java:231`,逐字节)
```

`parseAnnotation2`(`AnnotationParser.java:231`)按 JVM Spec §4.7.16 的布局逐字节读: 类型描述符 → 元素值(基本类型/枚举/Class/嵌套注解/数组)。

### 2.5 注解对象:动态代理!

解析出的值存进 Map——但 `getAnnotation` 返回的 `Annotation` 对象**没有实现类**。它由 `AnnotationInvocationHandler`(`sun/reflect/annotation/AnnotationInvocationHandler.java:43`)动态代理生成:

```java
// AnnotationInvocationHandler.java:43 + 58 + 75(截取核心,逐字)
class AnnotationInvocationHandler implements InvocationHandler, Serializable {
    ...
    public Object invoke(Object proxy, Method method, Object[] args) {
        ...
        } else if (member == "annotationType") {
```

- 代理的接口 = 注解接口
- 代理方法(如 `MyAnno.value()`)经 `invoke` **映射到解析出的值表**
- `annotationType()` 也有专门分支(`AnnotationInvocationHandler.java:75`)

这就是"注解接口方法没有实现却能调用"的机制答案:**代理在运行时实现了它**——第 3 篇的 Proxy 机制在这里又一次出场。

关键设计(斜体):*注解对象 = AnnotationInvocationHandler 动态代理,不是普通实现类——这是"接口即注解"设计的最妙处: @interface 只是接口,注解值由代理从解析表里取。解析是**惰性**的: 只有 getAnnotation 才解析字节流、建代理。面试"注解实现类在哪?"——没有实现类,是代理——这是加分点。*

## 3. "重复注解与继承" — getAnnotationsByType 语义

### 3.1 重复注解:容器包装

JDK8 前同一处只能标一次注解;`@Repeatable`(`java/lang/annotation/Repeatable`)改变了这一点: 声明一个**容器注解**,重复标注在字节码层被包装成容器:

```java
@Repeatable(MyAnnos.class)
@interface MyAnno { String value(); }

@interface MyAnnos { MyAnno[] value(); }   // 容器: 数组元素

@MyAnno("a") @MyAnno("b")                   // 字节码里其实是 @MyAnnos({@MyAnno("a"), @MyAnno("b")})
```

读取端 `getAnnotationsByType`(`Class.java:3670-3675`)做**视图合并**:

```java
// Class.java:3670-3675(截取核心,逐字)
public <A extends Annotation> A[] getAnnotationsByType(Class<A> annotationClass) {
    Objects.requireNonNull(annotationClass);

    AnnotationData annotationData = annotationData();
    return AnnotationSupport.getAssociatedAnnotations(annotationData.declaredAnnotations,
                                                      this,
                                                      annotationClass);
}
```

`AnnotationSupport.getAssociatedAnnotations` 同时查"直接标注"和"容器包装"——调用方无感知地拿到合并结果。

### 3.2 Inherited:继承视图

`@Inherited` 的语义在 `annotationData()` 层实现(2.3 节的合并):

- `annotations`(**含继承视图**):本类 + 父类 `@Inherited` 注解——`getAnnotations`/`getAnnotation` 用它
- `declaredAnnotations`(**仅本类**):不含父类——`getDeclaredAnnotations`/`getDeclaredAnnotation` 用它

注意 `getAnnotationsByType` 用的是 `declaredAnnotations`(`Class.java:3674`)——重复注解的合并只看本类声明。

关键设计(斜体):*getAnnotationsByType 是"视图合并"——同时查直接标注与容器包装;继承语义只在 getAnnotations 生效(declared 版本不查父类)。面试常考区别: getAnnotations(含继承)vs getDeclaredAnnotations(仅本类)vs getAnnotationsByType(重复注解合并)。Spring 的 @AliasFor 合成注解机制同源(读注解属性再合并,域外)。*

## 4. "框架注解驱动" — 机制闭环

### 4.1 注解不执行任何代码

最重要的一句话: **注解本身不执行任何代码——它只是"标签"**。`@Transactional` 不会自己开事务,`@Component` 不会自己注册 Bean。所有行为来自**读取方**(框架的处理器):

- **编译期**(APT/注解处理器):javac 期间处理——`@Override` 的编译检查就是编译器在读注解
- **运行期**(反射):框架用 `getAnnotation`/`getDeclaredAnnotations` 读,按注解类型分派处理

Spring 的 `AnnotatedElementUtils`、MyBatis 的 `@Mapper` 扫描,都是"读注解 → 分派"的消费方。

### 4.2 本域闭环

域 04 的完整链路:

```
Class(读取入口,getAnnotation)
  → AnnotationData(懒解析缓存,含继承合并)
    → AnnotationParser(逐字节解析属性表)
      → AnnotationInvocationHandler(动态代理实现注解接口)
        → 框架消费(Spring/MyBatis 读注解值,分派处理)
```

关键设计(斜体):*面试"注解怎么生效"的完整答案: 注解是标签,读取方解释——编译期 APT 或运行期反射。能画出一条"class 文件属性表 → AnnotationParser → 代理对象 → 框架消费"的链,就超过了"框架扫描注解"的笼统回答。*

## 核心悬念

反射和注解都建立在"类已经加载"之上——那**类是谁加载的**?`String` 为什么一定由 Bootstrap ClassLoader 加载?`Class.forName` 里的加载器参数又是谁?双亲委派模型长什么样、Spring 为什么必须打破它?——下一站进入类加载域: 从 `ClassLoader` 的 3000 行开始。

> → 下一篇: 域 07 类加载器(07-classloader 系列)| 关联: 内部卷 07-classfile-classloader
