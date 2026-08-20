# 04-reflection-annotation/04 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `java.base` 的 `java.lang.annotation` 元模型、`Class` 注解缓存、`sun.reflect.annotation.AnnotationParser` 与 `AnnotationInvocationHandler`；编译期 APT 与运行期框架扫描只作为消费边界，不展开实现细节。
> 目标：把“注解怎么生效”改写成一篇围绕“注解本身不会执行任何代码，真正发生的是 class 文件里的元数据被延迟解析成代理对象，再由读取方解释”的机制文章。

## 1. 读者困惑

- `@Transactional`、`@Autowired`、`@Mapper` 这些注解本身明明没有代码，为什么能驱动框架行为？
- `@interface` 编译后到底是什么，注解值存在哪里？
- `clazz.getAnnotation(X.class)` 返回的对象从哪来，为什么注解接口方法没有实现却能调用？
- `@Retention(SOURCE/CLASS/RUNTIME)` 的差别为什么会直接决定框架能不能读到它？
- `@Repeatable` 和 `@Inherited` 为什么一个是“重复合并”，一个是“继承视图”，两者不在同一层完成？

## 2. 一句话顿悟

**注解不是会执行逻辑的小对象，而是 class 文件里的元数据标签；JDK 11 只在真正有人读取时，才把这段字节流解析成 `Annotation` 代理对象。能不能读到取决于 `Retention`，读到之后怎么生效取决于读取方，而不是注解本身。**

## 3. 旧稿优点与问题

### 保留

- 已完整覆盖 `RetentionPolicy`、`Class.getAnnotation`/`annotationData`、`AnnotationParser.parseAnnotations`、`AnnotationInvocationHandler`、`getAnnotationsByType` 与 `@Inherited` 合并视图。
- 关键事实链准确：注解对象不是普通实现类，而是动态代理；注解本身不执行代码，行为来自读取方。
- 证据充足：`RetentionPolicy.java:37-56`、`Class.java:3649-3785`、`AnnotationParser.java:65/111/121/231`、`AnnotationInvocationHandler.java:43-91`。

### 必须重写

- 旧稿一上来就列元注解和链路，读者还没真正带着“为什么标签会生效”的困惑进入；需要更具体的事故或场景开场。
- “注解本身不执行代码”虽然写到了，但没有作为全文的首要失败方案先打破；很容易让读者还是把注解当成某种隐式回调。
- `AnnotationData` 与 `ReflectionData` 的镜像关系没有很好地服务叙事；这里只需保留“Class 延迟缓存注解视图”这个核心，不要让缓存实现细节吞掉主线。
- `@Repeatable` / `@Inherited` 现在写得像 API 行为清单，需要改成“为什么它们必须在不同层做合并”的机制对照。
- 收尾还不够像 BIN：需要回到 `@Transactional` / `@Autowired` 之类框架场景，把“读取方解释”收成最终顿悟，而不是停在链路描述。

## 4. 理解路径

### 第一节：为什么一个没代码的标签能让框架干活

用 Spring 或 MyBatis 的现场开头：某个类只多了一个 `@Transactional` 或 `@Mapper`，框架行为就变了。先让读者说出最常见误解：好像注解对象自己带着逻辑，运行时被“触发”了。

先给总图：

```text
源码里的 @Xxx
   → 编译进 class 文件属性表
   → 运行时有人读取时才解析
   → 解析成 Annotation 代理对象
   → 框架/编译器按注解类型解释
```

第一失败方案必须明确打掉：**注解本身不执行代码。**

### 第二节：`@interface` 不是魔法语法，而是“接口 + 保留策略”

先回答“注解到底是什么形态”：`@interface` 编译后是接口，行为能不能留到运行期，先由 `@Retention` 决定。

证据：
- `RetentionPolicy.java:37-56`

要推演的失败方案：
1. 以为 `CLASS` 和 `RUNTIME` 在反射下都能读到。
2. 以为 `SOURCE` 只是给编译器看一点提示，不影响运行期。
3. 以为框架读注解只要 class 文件里有记录就行，忽略 VM 是否保留到运行期。

这节不必把 13 个文件全部铺开，而要强调：`Retention` 决定“读不读得到”，`Target`/`Inherited`/`Repeatable` 决定“能标哪、合并哪”。

### 第三节：`getAnnotation` 为什么只是 Map 查询，真正的解析藏在哪

先制造反差：`Class.getAnnotation(X.class)` 看上去只是一次 Map 查询，读者容易误以为注解对象早就在类加载时构造好了。

证据：
- `Class.java:3649-3653`：`getAnnotation` 直接读 `annotationData().annotations`。
- `Class.java:3738-3785`：`annotationData()` 懒创建、`createAnnotationData()` 调 `AnnotationParser.parseAnnotations`。

要讲清的失败方案：
1. 以为类一加载，所有注解都会立刻解析成对象。
2. 以为 `AnnotationData` 只是个普通缓存，不会受 `classRedefinedCount` 影响。

收束：`Class` 维护的是**延迟解析后的注解视图**，不是 eager 预建对象池。

### 第四节：`AnnotationParser` 到底在解析什么

从 class 文件角度回答“注解值存在哪里”：`AnnotationParser` 解析的是 `RuntimeVisibleAnnotations` 这类属性表的字节流。

证据：
- `AnnotationParser.java:65-80`：公开入口。
- `AnnotationParser.java:111-131`：读注解数量并逐个解析。
- `AnnotationParser.java:231-243`：从 type_index 和签名解析出注解类型。

重点不是把字节布局讲成规范课，而是让读者知道：运行期拿到的注解对象，前身只是 class 文件里一段字节；JDK 只有在有人读取时才沿着这条链把字节翻译成结构化值。

### 第五节：为什么注解接口方法没有实现却能调用

这是全文顿悟点。先提出问题：如果 `@interface` 编译后只是接口，那么 `myAnno.value()` 到底是谁在实现？

证据：
- `AnnotationInvocationHandler.java:43-56`：它只接受真正的注解类型与成员值表。
- `AnnotationInvocationHandler.java:58-91`：`invoke` 对 `equals/hashCode/toString/annotationType` 做特殊处理，对普通成员从 `memberValues` 里取值。

要打掉的失败方案：
1. 以为每个注解类型都有一个编译器偷偷生成的实现类。
2. 以为注解对象只是个普通 Map。

收束成一句话：**注解对象 = 动态代理 + 成员值表。** 这也自然回勾上一篇动态代理，不用额外跳题。

### 第六节：`@Repeatable` 和 `@Inherited` 为什么一个看声明，一个看视图

把两个常被混淆的能力拆开：
- `getAnnotationsByType` 为什么会“自动展开容器注解”。
- `getAnnotation` / `getAnnotations` 为什么会看见父类的 `@Inherited` 注解。

证据：
- `Class.java:3670-3676`：`getAnnotationsByType` 走 `AnnotationSupport.getAssociatedAnnotations(annotationData.declaredAnnotations, ...)`。
- `Class.java:3759-3785`：`createAnnotationData` 合并父类 `@Inherited` 注解到 `annotations` 视图。
- `Class.java:3692-3714`：`getDeclaredAnnotation` / `getDeclaredAnnotations` 只看 `declaredAnnotations`。

关键对照：
- `@Repeatable` 是“同一位置多个声明如何合并”的问题，所以在 declared 视图层就能处理。
- `@Inherited` 是“父类视图是否投影进来”的问题，所以在 `annotations` 构造阶段处理。

### 第七节：收网与下一篇钩子

回到开头：`@Transactional` 并没有自己开事务，`@Autowired` 也没有自己注入。真正发生的是：
1. 注解被编译进 class 文件。
2. 运行时 `Class` 延迟读取并缓存注解视图。
3. `AnnotationParser` 把字节流解析成成员值。
4. `AnnotationInvocationHandler` 代理出注解对象。
5. Spring/MyBatis/编译器等读取方决定这些标签意味着什么。

再引到下一域：既然 `Class` 能读注解、反射、代理，那它自己又是谁加载进 JVM 的？

## 5. 失败方案清单

1. 把注解理解成“会自己执行逻辑的小对象”。
2. 以为 `@interface` 编译后不是接口，而是某种特殊 class。
3. 以为只要 class 文件里记了注解，反射就一定能读到，忽略 `Retention`。
4. 以为类一加载，所有注解都会立即解析成对象。
5. 以为每种注解都有一个编译器生成的实现类，而不是运行时代理。
6. 把 `@Repeatable` 和 `@Inherited` 都当成“读取时统一合并”，忽略它们分属不同层。
7. 把注解生效原因归结为“框架扫描了它”，却说不清扫描后拿到的到底是什么对象。

## 6. 误解清单

1. 注解本身会执行事务/注入等逻辑；真正执行逻辑的是读取方。
2. `RetentionPolicy.CLASS` 反射可见；只有 `RUNTIME` 才会被反射读取。
3. `getAnnotation` 每次都重新解析字节流；JDK 11 用 `AnnotationData` 做延迟缓存。
4. 注解对象是普通 POJO；它实际上是 `AnnotationInvocationHandler` 驱动的动态代理。
5. `getAnnotationsByType` 和 `getDeclaredAnnotationsByType` 只是名字差异；它们依赖的视图不同。
6. `@Inherited` 能让子类“声明”父类注解；它只是让某些读取视图包含父类注解。
7. 框架只要拿到注解类型名就够了；真正有用的是解析出的成员值表和代理对象。

## 7. 证据清单

- `RetentionPolicy.java:37-56`：SOURCE/CLASS/RUNTIME 语义。
- `Class.java:3649-3653`：`getAnnotation`。
- `Class.java:3670-3676`：`getAnnotationsByType`。
- `Class.java:3692-3714`：declared 注解读取入口。
- `Class.java:3738-3785`：`AnnotationData` 缓存与 `@Inherited` 合并。
- `AnnotationParser.java:65-80`：`parseAnnotations` 入口。
- `AnnotationParser.java:111-131`：批量解析注解。
- `AnnotationParser.java:231-243`：从字节流解析注解类型。
- `AnnotationInvocationHandler.java:43-56`：只接受合法注解类型。
- `AnnotationInvocationHandler.java:58-91`：注解方法调用映射到成员值表。

## 8. 版本与边界

- 基于 JDK 11 `java.base`；`sun.reflect.annotation` 属于当前实现包路径，不保证跨版本稳定。
- 本文讨论的是运行期反射读取链；APT、ASM 类扫描、Spring 合成注解等只作为消费方或对照边界，不展开实现。
- 注解 class 文件属性采用 JVM Spec §4.7.16 相关结构，但本文只提与理解主线直接相关的布局。
- `AnnotationData`/`classRedefinedCount` 是 JDK 11 当前缓存实现，不是注解 API 规范要求的唯一缓存方式。

## 9. 删除代码测试与最终验收标准

- 删除代码块后，读者仍能复述“class 文件标签 → 延迟解析 → 代理对象 → 读取方解释”的主线。
- 小标题能还原“为什么标签会生效 → 为什么不是立即解析 → 为什么能调用接口方法 → 为什么 repeatable/inherited 不在同一层处理 → 收网”。
- 必须先打掉“注解自己执行逻辑”的误解，再引入元模型与解析链。
- 必须把 `Retention`、`AnnotationParser`、`AnnotationInvocationHandler` 三者串成一条因果链，而不是平铺概念。
- 结尾必须回到框架现场，并自然引到类加载器主题。
