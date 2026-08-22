# 为什么 `Class.forName()` 可能触发类初始化，而 `ClassLoader.loadClass()` 通常不会？

> 适用：Java 技术专家 / 高级工程师面试
> 关联正文：`04-classload-mechanism/01-jvm-classload`、`02-parent-delegation`
> 版本边界：下文引用的 `Class.java`、`ClassLoader.java` 行号均为 JDK 11 源码，不同版本可能不同。

## 题目

为什么很多框架会刻意区分 `Class.forName()` 和 `ClassLoader.loadClass()`？为什么前者可能触发静态代码块执行，后者通常只是把类加载进来？

## 常见答法

> 因为 `forName()` 会初始化类，`loadClass()` 只会加载类，不会初始化。

这个答法方向对，但还差半步。**真正要讲清的是：`forName()` 的默认语义里就把 `initialize=true` 带进去了；而 `loadClass()` 的默认路径只负责 load + optional resolve，不负责 initialize。** 也就是说，两者差别不在"一个会双亲委派、一个不会"，而在"API 默认语义就不同"。

## 追问一：`Class.forName(String)` 为什么会触发初始化？

> 答：因为它内部直接调用的是 `forName0(..., true, ...)`，默认把 initialize 设成了 true。

`Class.forName(String className)`（`Class.java:312-316`）内部直接转发到 `forName0(className, true, ...)`。而它后面的 Javadoc 也写得很清楚：只有当 `initialize` 参数为 `true` 时，类才会被初始化（`Class.java:327-329`）。

所以 `Class.forName("Foo")` 不是单纯"把字节码找出来"，而是默认要求 JVM 把这个类初始化完毕。只要这个类此前还没初始化过，静态变量赋值、静态代码块都会在这一步发生。

## 追问二：那 `loadClass()` 到底做了什么？

> 答：它默认只是加载，必要时再 resolve，但不做 initialize。

`ClassLoader.loadClass(String name)`（`ClassLoader.java:526-528`）直接调用的是 `loadClass(name, false)`。注意这个 `false` 不是"不加载"，而是 `resolve=false`。后面的默认实现（`ClassLoader.java:571-605`）会做三件事：

- 先查 `findLoadedClass(name)`
- 再走父加载器委派
- 最后自己 `findClass(name)`

如果 `resolve` 为 `true`，才会在最后调 `resolveClass(c)`（`ClassLoader.java:602-603`）。但不管 resolve 是 true 还是 false，这条 API 默认都不负责初始化类。

## 追问三：那 resolve 和 initialize 又是什么关系？

> 答：resolve 是链接的一部分，initialize 是另一阶段；resolve 了也不等于初始化了。

很多人把"加载、链接、初始化"混成一步，这是面试里最常见的失误。`loadClass(name, true)` 最多只是把类加载并解析到可用状态，仍然不等于执行 `<clinit>`。真正触发初始化，通常要走到 `Class.forName(..., true, loader)`、首次主动使用静态字段/静态方法、创建实例等 JLS 规定的时机。

所以框架里如果只是想拿到 `Class<?>` 做扫描、注册、元数据分析，通常会更谨慎地避免立即初始化；如果就是要触发驱动注册、单例 holder、静态初始化副作用，才会故意用 `forName()`。

## 源码证据

- `Class.forName(String)`（`Class.java:312-316`）：直接走 `forName0(..., true, ...)`
- `Class.forName(..., boolean initialize, ClassLoader loader)` Javadoc（`Class.java:327-329`）：明确写了 `initialize=true` 才初始化
- `ClassLoader.loadClass(String)`（`ClassLoader.java:526-528`）：默认转到 `loadClass(name, false)`
- `ClassLoader.loadClass(String, boolean)`（`ClassLoader.java:571-605`）：负责 loaded-check、parent delegation、findClass、optional resolve
- `resolveClass(c)`（`ClassLoader.java:602-603`）：resolve 是链接阶段，不等于初始化

## 一句话顿悟

**`Class.forName()` 和 `ClassLoader.loadClass()` 的真正分界线，不是"谁更底层"，而是"默认是否带初始化语义"：`forName()` 默认 `initialize=true`，`loadClass()` 默认只 load（可选 resolve）不 initialize。** 面试官真正想听的不是你会背"forName 会执行静态代码块"，而是你知道这个差异来自 API 入口就不同，而不是来自双亲委派本身。