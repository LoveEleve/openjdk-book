# 注解体系：一个不会执行代码的标签，为什么能驱动框架

> 本文基于 JDK 11 `java.base` 的 `java.lang.annotation` 元模型、`Class` 注解缓存、`sun.reflect.annotation.AnnotationParser` 与 `AnnotationInvocationHandler`。`AnnotationData`、`AnnotationParser` 和 `sun.reflect.annotation` 包路径都属于 JDK 11 当前实现，不是 Java 注解 API 规定的唯一内部方案。APT、ASM 和 Spring 合成注解只作消费边界对照，不展开实现细节。本文讨论的是 JDK 11 运行时注解读取链，不把这里的懒解析缓存、代理对象形态和 `@Inherited` 视图合并方式外推成所有注解处理实现都必须遵守的统一规范。
> **前置依赖**：[Class 反射视图](01-class-member-access.md)、[动态代理与访问控制](03-proxy-access.md)
> **后续**：域 07 类加载器

## 一个不会执行代码的标签，为什么能让框架干活

某个类只多了一个 `@Transactional`，事务就有了；某个接口只多了一个 `@Mapper`，框架就开始给它注册代理；某个字段上贴了 `@Autowired`，容器就会往里塞依赖。

最常见的解释是：“框架扫描了注解，所以注解生效了。”这句话不能算错，但它几乎没有解释力。真正让人困惑的地方恰恰是：**注解本身没有方法体，也没有线程，更不会自己回调框架。一个不会执行代码的标签，为什么能驱动行为？**

先把最直觉、也最容易出错的想法打掉：注解本身并不会执行任何业务逻辑。`@Transactional` 不会自己开事务，`@Autowired` 不会自己找 Bean，`@Override` 也不会在运行时做任何事情。它们更像一张被贴进 class 文件里的标签，真正发生动作的是后续读取这张标签的人。

整条链先画出来：

```text
源码里的 @Xxx
   → 编译进 class 文件属性表
   → 运行时有人读取时才解析
   → 解析成 Annotation 代理对象
   → 框架 / 编译器 / 工具按注解类型解释
```

所以这篇文章真正要回答的是五件事：

1. `@interface` 到底是什么，它编译后会留下什么。
2. 为什么 `@Retention` 直接决定反射能不能读到注解。
3. 为什么 `getAnnotation()` 看起来像 Map 查询，但背后其实是延迟解析。
4. 为什么注解接口方法没有实现，却依然能 `myAnno.value()`。
5. 为什么 `@Repeatable` 和 `@Inherited` 虽然都像“合并”，却不在同一层完成。

## 一、`@interface` 不是魔法语法，而是“接口 + 保留策略”

### 先排除“只要写了注解，运行时就能拿到”的误解

很多人第一次写注解时，会自然以为：既然源码里有 `@Xxx`，编译后的程序总该在运行时把它留着；不然框架怎么读？

这正是注解机制的第一层陷阱。写在源码里，不代表一定能走到运行时；编进 class 文件，也不代表反射一定能看见。JDK 在这里明确分了几层保留策略。

### `RetentionPolicy` 决定标签能走到哪一层

JDK 11 的 `RetentionPolicy` 枚举把三种语义写得非常直接：

```java
// RetentionPolicy.java:37-56
public enum RetentionPolicy {
    SOURCE,
    CLASS,
    RUNTIME
}
```

如果只看名字还不够，Javadoc 更明确：

- `SOURCE`：编译器阶段就可以丢弃。
- `CLASS`：会写进 class 文件，但 VM 运行时不要求保留为反射可见数据。
- `RUNTIME`：编译进 class 文件，而且 VM 运行时保留，因此反射可以读取。

这立刻解释了一个常见失败方案：**把 `CLASS` 当成“运行时也能反射读到，只是比较少用”**。不是。`CLASS` 的重点是“留在 class 文件”，不是“留给反射”。真正能被 `Class.getAnnotation()` 看到的是 `RUNTIME`。

因此，像 Spring、MyBatis 这种要在运行时读取注解的框架，它们自己的关键注解必须选择 `RUNTIME`。相反，`@Override`、`@SuppressWarnings` 这类主要由编译器消费的注解，并不需要运行时一直活着。

### `@interface` 编译后首先是接口，而不是神秘对象

另一层容易被讲糊的地方是语法。`@interface` 看起来像在声明一种特殊结构，好像它编译后会生成某种带默认逻辑的“注解类”。实际上，JDK 的设计更朴素：`@interface` 编译后首先是一个接口，注解成员形如 `value()`、`name()` 也只是接口方法声明。

也就是说，源码层面上的注解至少拆成两块：

```text
@MyAnno(value = "x")
   ├── 注解类型：一个接口（@interface 编译后）
   └── 注解值：class 文件属性表中的元数据
```

这一步很重要，因为后文还要回答一个更大的疑问：既然它只是接口，那运行时那个 `myAnno.value()` 到底是谁在实现？

**路标：到这里先记住一个最重要的边界。注解不是自带行为的小对象；它先是接口，再是被保留到不同层次的元数据。只有当读取方真的去读它时，后面的机制才开始启动。**

## 二、`getAnnotation()` 为什么像 Map 查询：因为 JDK 故意延迟了解析

### 最直觉的想法：类一加载，注解对象就该都准备好

既然 class 文件里已经写着注解，很多人会顺手得出一个判断：类只要被加载进 JVM，这些注解对象也应该立刻都构造好。这样 `getAnnotation()` 才能足够快。

这套想法看上去合理，实际却会把很多根本没人会读的注解也提前解析掉。JDK 11 没有这样做。它选择的是：**类可以先加载，注解视图等真正有人访问时再懒解析。**

### `getAnnotation` 表面只有一次 Map 查询

JDK 11 的 `Class.getAnnotation` 几乎短得不像话：

```java
// Class.java:3649-3653
public <A extends Annotation> A getAnnotation(Class<A> annotationClass) {
    Objects.requireNonNull(annotationClass);

    return (A) annotationData().annotations.get(annotationClass);
}
```

调用方只看到了两件事：判空，然后从 `annotationData().annotations` 里按类型取值。这很容易让人误以为注解对象早就准备好了，`getAnnotation()` 只是查缓存。

其实真正的问题被藏在 `annotationData()` 里：**这个缓存并不是预先构造好的，它本身也是懒创建出来的注解视图。**

### `AnnotationData` 是延迟建立的注解视图

看 `annotationData()` 就清楚了：

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

这里有三件要记住的事：

1. `annotationData` 是按需创建，不是类加载时无条件准备。
2. 它会校验 `classRedefinedCount`，说明类被重定义后旧视图会失效。
3. 它通过 CAS 安装新视图，避免并发读取时重复覆盖。

所以“`getAnnotation` 只是查 Map”这个说法只说对了表层；深一层的事实是：**JDK 先用 `AnnotationData` 把 class 文件里的注解元数据延迟折叠成一份运行时视图，调用方之后才像查 Map 一样读取。**

### 解析真正发生在 `createAnnotationData`

懒解析的动作点就在 `createAnnotationData`：

```java
// Class.java:3756-3758
private AnnotationData createAnnotationData(int classRedefinedCount) {
    Map<Class<? extends Annotation>, Annotation> declaredAnnotations =
        AnnotationParser.parseAnnotations(getRawAnnotations(), getConstantPool(), this);
```

这里的角色关系应该这样理解：

```text
Class.getAnnotation(X)
   → annotationData()：已有视图？
      ├── 有：直接读
      └── 没有：createAnnotationData()
              → 拿到原始注解字节 getRawAnnotations()
              → AnnotationParser.parseAnnotations(...)
              → 构造 declared / inherited 视图
```

失败方案也因此很清楚：如果你把注解读取想成“类一加载就全解析”，那就看不到 JDK 为什么要多一层 `AnnotationData`。这层缓存存在的目的，正是把“运行时可能被读取的注解”从 class 文件字节懒惰地提升成 Java 侧可用的结构化视图。

## 三、`AnnotationParser` 到底在解析什么

### 不是在解析 Java 语法，而是在解析 class 文件属性表

到了 `AnnotationParser`，很多讲解开始飘到规范条文，最后让读者只记住一句“它会逐字节解析”。这句话没错，但如果不先说清它解析的到底是什么，读者还是会觉得离真实问题很远。

关键点只有一个：`AnnotationParser` 解析的不是源码里的 `@MyAnno(...)` 文本，而是 class 文件里诸如 `RuntimeVisibleAnnotations` 这种属性表的原始字节。

公开入口 `parseAnnotations` 非常直接：

```java
// AnnotationParser.java:65-80
public static Map<Class<? extends Annotation>, Annotation> parseAnnotations(
            byte[] rawAnnotations,
            ConstantPool constPool,
            Class<?> container) {
    if (rawAnnotations == null)
        return Collections.emptyMap();

    try {
        return parseAnnotations2(rawAnnotations, constPool, container, null);
```

它收到的是三个东西：原始字节、常量池，以及当前被解析的容器类。也就是说，到这里为止，JDK 手里拿到的还不是“注解对象”，只是“如何从 class 文件里找回注解信息所需的原料”。

### `parseAnnotations2` 先读数量，再逐个解析注解

下一层的 `parseAnnotations2` 把这段字节流包成 `ByteBuffer`，先读注解数量，再一个个往下拆：

```java
// AnnotationParser.java:111-131
private static Map<Class<? extends Annotation>, Annotation> parseAnnotations2(
            byte[] rawAnnotations,
            ConstantPool constPool,
            Class<?> container,
            Class<? extends Annotation>[] selectAnnotationClasses) {
    Map<Class<? extends Annotation>, Annotation> result =
        new LinkedHashMap<Class<? extends Annotation>, Annotation>();
    ByteBuffer buf = ByteBuffer.wrap(rawAnnotations);
    int numAnnotations = buf.getShort() & 0xFFFF;
    for (int i = 0; i < numAnnotations; i++) {
        Annotation a = parseAnnotation2(buf, constPool, container, false, selectAnnotationClasses);
```

这里不需要把 JVM Spec 的每一项字段都摊开。对读者理解真正有帮助的是：JDK 并不是“查个注册表就得到注解对象”，而是**真正在读一段字节数组，并按 class 文件约定的布局把它重新解释成注解类型和值。**

### `parseAnnotation2` 先认出注解类型，再认出成员值

最终最关键的动作在 `parseAnnotation2` 的开头：

```java
// AnnotationParser.java:231-243
private static Annotation parseAnnotation2(ByteBuffer buf,
                                           ConstantPool constPool,
                                           Class<?> container,
                                           boolean exceptionOnMissingAnnotationClass,
                                           Class<? extends Annotation>[] selectAnnotationClasses) {
    int typeIndex = buf.getShort() & 0xFFFF;
    Class<? extends Annotation> annotationClass = null;
    String sig = "[unknown]";
    try {
        sig = constPool.getUTF8At(typeIndex);
        annotationClass = (Class<? extends Annotation>)parseSig(sig, container);
```

这里先通过 `typeIndex` 和常量池找出“这到底是哪一种注解”，然后才会继续解析成员名和值。换句话说，注解对象的前身不是某个已经 new 好的 Java 对象，而是一串字节：

```text
rawAnnotations
   → ByteBuffer
   → type_index + member_value_pairs
   → 注解类型 + 成员值表
```

到这一步，JDK 才终于有机会把“不会执行代码的标签”还原成一份运行时可消费的数据结构。

## 四、为什么注解接口方法没有实现，却还能 `myAnno.value()`

### 如果 `@interface` 只是接口，运行时到底谁在实现它

这正是注解机制最容易让人产生“黑魔法感”的地方。既然前面已经承认：

- `@interface` 编译后是接口；
- class 文件里保存的是字节化的成员值；

那 `clazz.getAnnotation(MyAnno.class)` 返回的那个对象，为什么可以直接调用 `value()`、`name()`、`annotationType()`？

最常见的两个误解是：

1. 编译器偷偷为每个注解生成了一个实现类。
2. JDK 直接返回一个 Map，再用某种特殊语法帮你取值。

这两个答案都不对。JDK 11 走的是我们上一章刚讲过的那套机制：**动态代理。**

### `AnnotationInvocationHandler` 只接受真正的注解类型

它的构造器先做了一轮防守，确认你传进来的真的是一个注解接口：

```java
// AnnotationInvocationHandler.java:43-56
class AnnotationInvocationHandler implements InvocationHandler, Serializable {
    private final Class<? extends Annotation> type;
    private final Map<String, Object> memberValues;

    AnnotationInvocationHandler(Class<? extends Annotation> type, Map<String, Object> memberValues) {
        Class<?>[] superInterfaces = type.getInterfaces();
        if (!type.isAnnotation() ||
            superInterfaces.length != 1 ||
            superInterfaces[0] != java.lang.annotation.Annotation.class)
            throw new AnnotationFormatError("Attempt to create proxy for a non-annotation type.");
```

这里已经点明了它的角色：它手里拿着注解类型 `type`，也拿着按成员名组织好的 `memberValues`。也就是说，在 `AnnotationParser` 把字节流翻译成类型和值之后，下一步不是生成一个普通实现类，而是准备把这张“成员值表”挂到一个代理对象上。

### 普通注解成员访问，本质上就是从 `memberValues` 里取值

`invoke` 方法把几种特殊方法和普通成员访问分开处理：

```java
// AnnotationInvocationHandler.java:58-91
public Object invoke(Object proxy, Method method, Object[] args) {
    String member = method.getName();
    int parameterCount = method.getParameterCount();

    if (parameterCount == 1 && member == "equals" &&
            method.getParameterTypes()[0] == Object.class) {
        return equalsImpl(proxy, args[0]);
    }
    if (parameterCount != 0) {
        throw new AssertionError("Too many parameters for an annotation method");
    }

    if (member == "toString") {
        return toStringImpl();
    } else if (member == "hashCode") {
        return hashCodeImpl();
    } else if (member == "annotationType") {
        return type;
    }

    Object result = memberValues.get(member);
```

这段代码把机制说得很透：

- `equals`、`hashCode`、`toString`、`annotationType` 有专门逻辑。
- 其他普通注解成员访问，本质上就是拿方法名去 `memberValues` 里查值。
- 如果值是数组，还要 clone，避免外部直接改到内部状态。

因此 `myAnno.value()` 之所以能工作，不是因为注解接口天生带实现，也不是因为 JVM 有专门硬编码每个注解类型，而是因为：

```text
AnnotationParser 解析字节流
   → 得到成员值表 memberValues
   → AnnotationInvocationHandler 持有 type + memberValues
   → 动态代理拦截 myAnno.value()
   → 用方法名 "value" 去 memberValues 取结果
```

这一步也自然回勾上一章：动态代理不仅能拿来给接口造业务代理，也能拿来给注解接口造“只读元数据对象”。

## 五、`@Repeatable` 和 `@Inherited` 为什么不在同一层合并

### 它们都像“合并”，但回答的不是同一个问题

读者很容易把这两件事混成一句话：“JDK 会帮你把注解合并好。”但如果不拆开，后面 `getAnnotationsByType` 和 `getAnnotation` 的行为差异就会非常奇怪。

其实这两个能力在回答完全不同的问题：

- `@Repeatable` 问的是：**同一个声明位置上贴了多次同类注解，读取时如何把容器展开成多个条目？**
- `@Inherited` 问的是：**当我在子类上读注解时，要不要把父类的某些注解视图投影进来？**

一个发生在“同一声明位置的多值合并”，一个发生在“类层次结构的视图继承”。不在同一层处理，反而是合理结果。

### `getAnnotationsByType` 只基于 declared 视图做重复展开

`Class.getAnnotationsByType` 明确是从 `declaredAnnotations` 出发：

```java
// Class.java:3670-3676
public <A extends Annotation> A[] getAnnotationsByType(Class<A> annotationClass) {
    Objects.requireNonNull(annotationClass);

    AnnotationData annotationData = annotationData();
    return AnnotationSupport.getAssociatedAnnotations(annotationData.declaredAnnotations,
                                                      this,
                                                      annotationClass);
}
```

这意味着它解决的是“当前类自己声明了什么”这个问题，再由 `AnnotationSupport` 决定如何把容器注解和直接注解展开成统一结果。它并不天然关心父类有没有声明同名注解，因为那是另一层视图问题。

### `@Inherited` 在 `AnnotationData` 构造阶段进入 `annotations` 视图

父类注解的继承合并，发生在 `createAnnotationData` 构造 `annotations` 视图时：

```java
// Class.java:3759-3785
Class<?> superClass = getSuperclass();
Map<Class<? extends Annotation>, Annotation> annotations = null;
if (superClass != null) {
    Map<Class<? extends Annotation>, Annotation> superAnnotations =
        superClass.annotationData().annotations;
    for (Map.Entry<Class<? extends Annotation>, Annotation> e : superAnnotations.entrySet()) {
        Class<? extends Annotation> annotationClass = e.getKey();
        if (AnnotationType.getInstance(annotationClass).isInherited()) {
            if (annotations == null) {
                annotations = new LinkedHashMap<>((Math.max(
                        declaredAnnotations.size(),
                        Math.min(12, declaredAnnotations.size() + superAnnotations.size())
                    ) * 4 + 2) / 3
                );
            }
            annotations.put(annotationClass, e.getValue());
        }
    }
}
if (annotations == null) {
    annotations = declaredAnnotations;
} else {
    annotations.putAll(declaredAnnotations);
}
return new AnnotationData(annotations, declaredAnnotations, classRedefinedCount);
```

然后再把当前类自己的 `declaredAnnotations` 覆盖进去。于是 JDK 得到两张不同的视图：

```text
declaredAnnotations
   → 只看本类直接声明
   → 适合 getDeclaredAnnotation / getDeclaredAnnotations / repeatable 展开起点

annotations
   → 本类直接声明 + 父类 @Inherited 视图
   → 适合 getAnnotation / getAnnotations
```

所以“为什么 `@Repeatable` 和 `@Inherited` 不在同一层处理”的答案也就清楚了：一个在回答“同一位置的多值怎么展开”，一个在回答“类层次的视图要不要继承”。这两件事本来就不该挤进同一个 if 分支里。

## 六、五个最容易混掉的边界：注解本身不执行代码，CLASS 不等于反射可见，类加载不等于立即解析，注解对象不是普通 POJO，@Repeatable 也不是 @Inherited

在收网之前，先把这一篇最容易记错的五条边界压实。

第一，注解本身不会执行代码。`@Transactional` 不会自己开事务，`@Autowired` 不会自己注入；真正发生动作的，永远是后续读取并解释这张标签的框架、编译器或工具。把注解当成隐式回调，是注解域最初始的误解。

第二，`RetentionPolicy.CLASS` 不等于反射可见。它只说明注解被写进了 class 文件，不代表 VM 会把它保留成反射可读的运行时数据。真正能被 `getAnnotation()` 读到的，是 `RUNTIME`。

第三，类被加载也不等于注解对象已经全部构造好。JDK 11 的 `AnnotationData` 是按需懒解析的视图，只有真正有人调用 `getAnnotation()` 时，class 文件字节才会被翻译成可消费的注解数据。

第四，注解对象也不是普通 POJO。它本质上是一个由 `AnnotationInvocationHandler` 驱动的动态代理：手里握着注解类型和成员值表，方法访问只是拿方法名去表里取值。

第五，`@Repeatable` 更不是 `@Inherited` 的同义变体。前者解决“同一声明位置贴了多次同类注解怎么展开”，发生在 declared 视图层；后者解决“子类读取时要不要投影父类注解”，发生在 `annotations` 视图构造阶段。它们不在同一层完成合并。

把这五条边界记稳，注解体系这一篇就不会重新塌回“框架扫描注解所以生效”这种没有解释力的表面印象。它真正想讲的是：注解是一段被延迟解析、再被代理成对象、最后由读取方解释的元数据，而不是自带行为的小黑盒。

## 收网：注解从来不是行为，它只是被解释的元数据

现在回到开头那个让人困惑的问题：一个不会执行代码的标签，为什么能驱动框架？

因为真正发生的从来不是“注解自己做了什么”，而是下面这条链：

```text
源码里的 @Xxx
   → Retention 决定它能走到哪一层
   → 编译进 class 文件属性表
   → Class.getAnnotation 时才触发 AnnotationData 懒解析
   → AnnotationParser 把字节流翻译成注解类型 + 成员值表
   → AnnotationInvocationHandler 代理出 Annotation 对象
   → 框架 / 编译器 / 工具读取并解释这些值
```

于是几个最常见的问题都能落地了：

- 为什么有些注解运行时读不到？因为 `Retention` 决定它根本没被保留到反射可见层。
- 为什么 `getAnnotation()` 像查缓存？因为 JDK 先把 class 文件字节延迟折叠成 `AnnotationData` 视图。
- 为什么注解接口方法没有实现还能调用？因为返回的是一个动态代理对象，而不是编译器偷偷生成的实现类。
- 为什么 `@Repeatable` 和 `@Inherited` 表现不同？因为一个处理同一声明位置的多值展开，一个处理父类视图是否投影进来。

对实际工程来说，只要记住三条规则：

1. **注解本身不执行代码**；所有行为都来自读取方。
2. **运行时能不能读到，先看 `Retention`**；反射读取不是默认权利。
3. **把注解对象想成“代理出来的只读元数据视图”**，而不是普通 POJO。

到这里，域 04 已经把反射、代理、注解三件事都串起来了：`Class` 可以读元数据，代理可以把接口变成对象，注解可以把标签变成运行时视图。下一站进入类加载器，因为这些事情都有一个共同前提：这些类自己到底是谁、又是怎样被加载进 JVM 的？

> → 下一篇：域 07 类加载器
