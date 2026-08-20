# 04-reflection-annotation/01 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `java.base` 的 `Class`、`Method`、`Field`、`Constructor` 反射实现；类加载器差异只点到 `forName` 的初始化语义，不在本文展开完整类加载链。
> 目标：把“forName / getMethods / Method 对象结构”改写成一篇围绕“框架为什么既离不开反射、又害怕它太慢和副作用太大”的机制文章，重点讲清 `Class` 只是 JVM 元数据视图、成员获取缓存只能省一半、反射对象为何必须拷贝但 accessor 必须共享。

## 1. 读者困惑

- 为什么 `Class.forName("com.mysql.jdbc.Driver")` 看起来只是拿一个 `Class`，却能触发驱动注册？
- 为什么框架每次都调 `getMethods()` / `getDeclaredMethods()` 会慢，JDK 不是已经有缓存了吗？
- 为什么反射每次拿到的 `Method`/`Field` 看起来都像新对象，JDK 还要费劲维护 root/copy 结构？
- 为什么 `setAccessible(true)` 不能直接把同一个 `Method` 对象共享给所有调用者？

## 2. 一句话顿悟

**`Class` 不是类本身，而是 JVM 暴露给 Java 的元数据视图；`forName` 解决的是“什么时候顺手初始化”，`ReflectionData` 解决的是“别每次都重新向 VM 索取成员”，而 root/copy + accessor 共享解决的是“调用者要独立的反射对象状态，但底层执行器不能重复造”。**

## 3. 旧稿优点与问题

### 保留

- 已覆盖 `forName` 默认初始化语义、`ReflectionData` 的 `SoftReference` 缓存、`classRedefinedCount` 失效条件、`Method` root/copy 结构。
- 已有准确源码锚点：`Class.java:312/380/3158/2941/2973`、`Method.java:85/149/623`、`Field.java:81/1081`、`Constructor.java:485/518`。
- 已能和下一篇 `MethodAccessor` 衔接，材料密度足够。

### 必须重写

- 当前还是按“forName 一节、缓存一节、成员结构一节”平铺素材，读者虽然记住结论，但还没真正建立“框架在担心什么”的主线。
- 文章缺少一个足够具体的开场事故：驱动加载副作用、Bean 扫描时反复反射、缓存错位导致性能问题这三件事还没有被收成同一个困惑。
- “缓存只省一半”的结论还不够立体，需要把 `privateGetDeclaredMethods` 的 root 方法数组、`copyMethods` 对外复制、`Method.copy()` 的注释一起串成一条失败方案推演。
- 旧稿只轻触 `AnnotationData`/`classRedefinedCount`，但没把它作为“同一个 Class 视图既缓存成员又缓存注解”的镜像对照，这会让读者误以为反射缓存只是个局部优化细节。
- 收尾还不够像 BIN 风格文章：需要回到“框架为什么一边缓存 Method，一边又要小心初始化副作用”，而不是只把下一篇当提纲连接。

## 4. 理解路径

### 第一节：一个框架启动事故，为什么同时踩中两颗雷

用两个常见现场合并开场：
1. 老式 JDBC 驱动靠 `Class.forName` 触发静态注册，框架只是“想拿到类”，却顺手执行了静态初始化。
2. 容器启动时反复做 `getDeclaredMethods()`、`getMethod()`，性能抖动明显；开发者以为“JDK 应该早就缓存了”。

把它们收束成一句问题：**反射拿到的是 JVM 已经存在的元数据视图，但“拿视图”可能附带初始化副作用，而“重复看视图”仍然会新建一堆 Java 反射对象。**

先给总图：

```text
Class.forName / clazz.getMethods / clazz.getDeclaredFields
        │
        ▼
Class 视图（JVM 元数据的 Java 门面）
        ├── 何时触发初始化
        ├── 如何缓存成员数组
        └── 如何复制 Method/Field/Constructor 对象
```

### 第二节：`forName` 不是拿一张门票，而是可能顺手点火

先推演失败方案：把 `Class.forName("X")` 当作“只是得到 `Class<?>`”的无副作用操作。再说明 JDK 11 默认 `initialize=true`，所以它不仅定位类，还要求初始化；静态块、副作用注册都会发生。

证据：
- `Class.java:312-316`：一参 `forName` 直接把 `true` 传入 `forName0`。
- `Class.java:320-339`：三参版文档明确写出 `initialize` 的语义，以及数组组件类型只加载不初始化的边界。
- `Class.java:380-398`：三参版把初始化控制交给调用者。

要写清楚的失败方案：
1. 把 `forName` 当成“只加载不初始化”。
2. 用它扫描一堆类，却没意识到静态块会执行。
3. 以为 `loadClass` 与 `forName` 只是语法差异。

收束：**拿 `Class` 视图本身不一定有副作用，但 `forName` 的默认入口故意把“拿视图”与“初始化”绑在了一起。**

### 第三节：`getMethods` 真正慢在哪，JDK 的缓存到底省了什么

先推演最直觉的判断：既然 `Class` 都缓存了反射结果，多次 `getMethods()` 应该几乎没有成本。然后拆穿这件事只对一半。

先看 `privateGetDeclaredMethods`：
- `Class.java:3155-3174`：缓存的是 root 方法数组；未命中才调 `getDeclaredMethods0`。
- `Class.java:2941-3000`：`ReflectionData` 是 `SoftReference` + `classRedefinedCount` 失效机制，不是永久强缓存。
- `Class.java:3177-3199`：public 方法还要继续做继承合并。

再补一张对比图：

```text
第一次 getDeclaredMethods
  → VM 元数据遍历(getDeclaredMethods0)
  → 构造 root Method[]
  → 放进 ReflectionData
后续 getDeclaredMethods
  → 读 ReflectionData
  → 仍要对外复制 Method 对象
```

这里必须明确三层成本：
1. VM 元数据扫描。
2. 反射成员对象创建。
3. public 视图的过滤/继承合并。

关键失败方案：
- 以为 JDK 缓存后就不必自己缓存 `Method`。
- 以为缓存永远存在，不会被 `SoftReference` 回收，也不会因 `RedefineClasses` 失效。
- 以为 `getDeclaredMethods` 和 `getMethods` 成本差不多。

### 第四节：为什么 `Method`/`Field` 必须拷贝，而 accessor 又必须共享

这一节是全文顿悟点。先让读者带着问题进入：既然 JDK 已缓存 root 成员数组，为何不把 root `Method` 直接返回给所有调用者？

证据：
- `Method.java:149-166`：`copy()` 注释明确说明，正是因为 `AccessibleObject` 里的 accessibility bit，必须为每次反射调用制造新的 Java 对象。
- `Method.java:623-652`：`acquireMethodAccessor` 先沿 root 查已有 accessor，没命中才创建，再向 root 传播。
- `Field.java:1081-1128`：字段同样维护 `fieldAccessor` / `overrideFieldAccessor` 两套 accessor，并沿 root 共享。
- `Constructor.java:485-529`：构造器路径与 Method 同构。

要形成的叙事：
1. 如果把同一个 `Method` 对象直接发给所有调用者，那么某个调用者 `setAccessible(true)` 会污染其他调用者看到的状态。
2. 因此 Java 层对象必须隔离；每次 `getMethod` 对外给的是 copy，而不是 root。
3. 但底层执行器如果也跟着每次重造，反射调用成本会彻底失控。
4. 所以 JDK 选择“对象拷贝，accessor 共享”。

总图：

```text
Class 缓存 root Method
   ├── 调用者 A 拿到 Method copy A（独立 override 状态）
   ├── 调用者 B 拿到 Method copy B（独立 override 状态）
   └── root / copy 共用一个 MethodAccessor
```

### 第五节：`ReflectionData` 与 `AnnotationData` 的镜像，说明 Class 真是“视图中枢”

用一小节路标补强整体观：`Class` 不只缓存成员数组，也缓存注解视图。

证据：
- `Class.java:3649-3714`：`getAnnotation`、`getAnnotationsByType`、`getDeclaredAnnotation` 统一走 `annotationData()`。
- `Class.java:3738-3785`：`AnnotationData` 与 `ReflectionData` 一样依赖 `classRedefinedCount`，并在需要时创建新缓存视图。

目的不是提前讲完注解，而是帮助读者建立：**Class 不是某个 API 的实现细节，而是整个反射域的缓存与视图中枢。** 这也让“下篇进入 MethodAccessor、后篇进入注解体系”更自然。

### 第六节：收网与下一篇钩子

回到开头的两个现场：
- 只是“拿类”却触发驱动注册，是因为 `forName` 默认顺手初始化。
- 只是“读成员”却仍然很慢，是因为 JVM 缓存了 root 视图，却没有也不能直接把同一份反射对象发给所有人。

最终收束成三条规则：
1. 只想拿 `Class` 而不想执行静态块时，要明确区分 `forName(..., false, loader)` 与默认 `forName`。
2. 生产框架不要把“JDK 有 ReflectionData 缓存”误解为“不需要缓存 Method/Field 对象”。
3. 理解 root/copy + accessor 共享，才能真正懂下一篇为什么 `Method.invoke` 会先拿到一个共享的 `MethodAccessor`，再进入膨胀与生成路径。

## 5. 失败方案清单

1. 把 `Class.forName("X")` 当作无副作用的“拿 Class”。
2. 用 `forName` 做大规模扫描，却没意识到静态初始化会被触发。
3. 以为 `loadClass` 和 `forName` 只是写法差异。
4. 以为 JDK 缓存后，多次 `getMethods()` 几乎零成本。
5. 以为 `ReflectionData` 缓存永不失效、永不回收。
6. 把 root `Method` 直接暴露给所有调用者，忽略 `setAccessible` 的状态污染。
7. 为每次 `Method` copy 都重新创建 accessor，导致调用成本爆炸。

## 6. 误解清单

1. `Class` 就是类本身；实际它是 JVM 类元数据的 Java 视图。
2. `Class.forName` 只负责加载，不负责初始化；默认入口恰恰会初始化。
3. `getDeclaredMethods()` 返回的就是内部缓存数组；对外仍会复制反射对象。
4. `ReflectionData` 是永久缓存；它受 `SoftReference` 和 `classRedefinedCount` 双重约束。
5. 反射慢只因为 native；成员对象复制和 public 视图合并同样重要。
6. `setAccessible(true)` 只是性能优化小开关；它直接决定为何必须给调用者独立的反射对象。
7. `Method`/`Field` 的 copy 是浪费；它是访问状态隔离的代价。

## 7. 证据清单

- `Class.java:312-316`：一参 `forName` 默认 `initialize=true`。
- `Class.java:320-339`：文档说明初始化与数组类边界。
- `Class.java:380-398`：三参 `forName` 的初始化开关。
- `Class.java:3155-3174`：`privateGetDeclaredMethods` 缓存 root 方法数组。
- `Class.java:3177-3199`：public 方法还要递归合并。
- `Class.java:2941-3000`：`ReflectionData`、`SoftReference`、`classRedefinedCount`。
- `Method.java:85-92`：`methodAccessor` 与 root 结构字段。
- `Method.java:149-166`：`Method.copy()` 的动机与共享 accessor 注释。
- `Method.java:555-566`：`invoke()` 读取 `methodAccessor`。
- `Method.java:623-652`：`acquireMethodAccessor` 沿 root 共享 accessor。
- `Field.java:81-90`：`fieldAccessor` / `overrideFieldAccessor` / root 字段。
- `Field.java:1081-1128`：字段 accessor 选择与共享。
- `Constructor.java:485-529`：构造器 accessor 路径与 Method 同构。
- `Class.java:3649-3714`：注解读取入口统一走 `annotationData()`。
- `Class.java:3738-3785`：`AnnotationData` 与继承注解合并。

## 8. 版本与边界

- 基于 JDK 11 `java.base`；`SecurityManager` 相关检查是当时实现现实，不能直接外推到后续版本策略。
- `forName0`、`getDeclaredMethods0` 是 native 入口，正文只依据 Java 侧契约和调用点说明，不臆测 VM 内部全部加载/枚举细节。
- `ReflectionData` 与 `AnnotationData` 的缓存结构是 JDK 11 当前实现，不是 Java 反射规范要求的唯一实现方式。
- `classRedefinedCount` 的失效语义建立在 JVMTI `RedefineClasses` 存在的前提下，属于 HotSpot/JDK 实现事实。
- 本文只点到 `loadClass` 与 `forName` 的初始化差别，完整类加载双亲委派留到域 07。

## 9. 删除代码测试与最终验收标准

- 删除代码块后，读者仍能复述“forName 默认初始化、ReflectionData 只缓存 root 视图、反射对象 copy 与 accessor 共享”的主线。
- 小标题能还原“事故 → 失败方案 → 视图 → 缓存 → copy/share → 收网”。
- 必须明确回答四问：谁触发反射视图、做了什么、失败会怎样、为什么不直接共享同一个 `Method` 对象。
- 至少展开 5 个失败方案，并用 `file:line` 逐一托底。
- 结尾要自然引到下一篇 `MethodAccessor`：既然 accessor 能共享，它到底怎么从 native 调用膨胀成生成字节码。 
