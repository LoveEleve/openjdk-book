# Tomcat Ch11-01 类加载器泄漏与卸载失败 — 正文写作规划

## 文章定位

- 写作卷：`vol-tomcat`
- 章节：Ch11 ClassLoader Leak
- 篇：01 为什么应用停了，类空间却没退场
- 对应主题：Tomcat 完整卷的 **机制补深层（类加载后半段）**
- 文章类型：泄漏与卸载故障主线篇
- 正文状态：未开始

## 前置依赖

### HARD

- 读者应已读过 Ch10-01，知道 Tomcat 为什么必须为每个 WebApp 维持独立类空间，以及 `WebappClassLoaderBase` 为什么不只是普通加载器。
- 读者应已读过 Ch9-01，知道 Servlet 实例生命周期和容器卸载/销毁链条是如何成立的。

### SOFT

- 生产层故障排查专题会再次利用本篇，但本篇先聚焦“泄漏为什么会发生、Tomcat 当前怎么试图清理”。
- Session、async、线程模型等主线只在需要时作为泄漏源头举例，不升格为主叙事。

### NAV

- Ch11-02：线程 / ThreadLocal / 静态缓存 泄漏补篇（若需要）
- 生产层故障排查：Metaspace、类加载器残留、WebApp 卸载失败

## 一句话困惑

为什么一个 Web 应用明明已经停止、重载甚至被卸载了，老的类、老的实例、老的线程和老的静态状态却还可能留在 JVM 里，最后拖出一个完整的类加载器泄漏问题？

## 一句话顿悟

WebApp 真正退出，不只是“请求不再进来”，而是 **整套应用类空间都必须与线程、静态状态、反射缓存、JDBC 驱动、ThreadLocal 等引用链彻底脱钩**；Tomcat 的 `WebappClassLoaderBase.stop()/clearReferences()` 就是在尝试完成这件事。

## 读者理解路径

1. 从“为什么应用停了不等于类空间就卸掉了”切入。
2. 建立最小总图：`WebApp classes -> threads / ThreadLocal / static caches / drivers / reflective caches -> classloader still retained`。
3. 解释类加载器泄漏本质上不是“类文件没删”，而是“引用链还没断”。
4. 解释 `WebappClassLoaderBase.stop()` / `clearReferences()` 为什么存在。
5. 解释 Tomcat 为什么要清理 JDBC、线程、ObjectStreamClass caches、ThreadLocals、RMI targets 等。
6. 最后收束：Tomcat 可以帮忙清理，但并不意味着容器能完全替应用擦屁股。

## 失败方案推演

### 失败方案一：应用停了，请求没了，类自然就会被卸掉

这是最容易产生的直觉，因为从业务角度看：
- Context 停了
- 请求不来了
- 应用结束了

于是会自然觉得：
- 既然不再运行，那些类和对象也应该顺着就没了

问题在于，JVM 回收看的不是“业务意义上停没停”，而是：
- 还有没有活引用链
- ClassLoader 还能不能被触达

只要还有线程、ThreadLocal、缓存、驱动注册表、反射缓存等引用挂着，整个 WebApp 类空间就可能一起被拖住。

### 失败方案二：类加载器泄漏只是 ThreadLocal 的一个别名

ThreadLocal 确实是最常见的泄漏源之一，但如果把类加载器泄漏缩成“ThreadLocal 问题”，会低估整件事。

Tomcat 当前实现里要清理的远不止 ThreadLocal，还包括：
- JDBC 驱动
- 各种线程
- ObjectStreamClass caches
- RMI targets
- 其他跨类空间残留引用

也就是说，ThreadLocal 只是常见入口，不是全貌。

### 失败方案三：Tomcat 有 `clearReferences()`，所以容器会替应用完全兜底

这也是一个很危险的误解。

Tomcat 的确做了很多清理工作，但它能做的事情受限于：
- 它能不能识别那条引用链
- 它能不能安全地断掉那条链
- 断掉会不会带来副作用

所以 `clearReferences()` 更像容器在应用退场时的“尽力清场”，而不是“保证万无一失的垃圾回收魔法”。

## 必须澄清的误解

1. 类加载器泄漏不是“类文件没删”，而是“类空间仍被活引用链拖住”。
2. 请求停止不等于应用类空间已经退出。
3. ThreadLocal 只是常见泄漏源之一，不是全部。
4. `WebappClassLoaderBase.clearReferences()` 很重要，但不是万能橡皮擦。
5. 本篇讲的是卸载失败与引用清理主线，不是完整生产排障教程。

## 文章结构与字数预算

1. 困惑开场：为什么应用停了，类空间却没退场（800-1000 字）
2. 最小总图：类空间 -> 引用链 -> 卸载失败（1200-1500 字）
3. `stop()` / `clearReferences()`：Tomcat 为什么必须主动清理（1600-2200 字）
4. 线程 / ThreadLocal / JDBC / 缓存：典型残留源（2200-3000 字）
5. 为什么容器无法完全替应用兜底（1200-1800 字）
6. 收网总结：Tomcat 管的不只是加载，还要尽力帮助应用退场（800-1000 字）

目标叙述性正文：9500-12500 字；代码块不计入目标。

## 证据清单

写作时必须重新逐条验证：

- `org/apache/catalina/loader/WebappClassLoaderBase.java:1523` (`stop()`)
- `org/apache/catalina/loader/WebappClassLoaderBase.java:1574` (`clearReferences()`)
- `org/apache/catalina/loader/WebappClassLoaderBase.java:1642` (`clearReferencesJdbc()`)
- `org/apache/catalina/loader/WebappClassLoaderBase.java:1678` (`clearReferencesThreads()`)
- `org/apache/catalina/loader/WebappClassLoaderBase.java:2081` (`clearReferencesRmiTargets()`)
- `org/apache/catalina/loader/WebappClassLoaderBase.java:2151` (`clearReferencesObjectStreamClassCaches()`)
- 与 `clearReferencesThreadLocals` 相关字段/方法锚点

测试侧至少补：
- 与类加载器清理、重载、泄漏检测相关的测试

## 版本边界

- 当前分析对象：Tomcat `10.1.34`
- 本篇关注 Tomcat 当前的“类加载后半段”清理路径
- 不把生产排障脚本、MAT/arthas/jcmd 等工具直接混入本篇主线

## 与其他篇的边界

### 本篇要讲清

- 为什么类加载器泄漏会发生
- Tomcat 当前如何主动尝试清理残留引用
- 为什么容器清理不是万能兜底

### 本篇不深讲

- 生产排障具体命令与案例
- JVM 类卸载全景
- Spring Boot Loader 细节

这些留给生产层或其他专题。

## 写作后检查

- [ ] 开篇不是泄漏术语堆砌，而是“为什么应用停了类空间还不走”的困惑
- [ ] 至少 2 个失败方案，且有一个专门针对“Tomcat 会完全兜底”的误解
- [ ] 总图明确区分：类空间、引用链、清理动作、兜底边界
- [ ] 不把 `clearReferences()` 写成神奇开关
- [ ] 删除代码后主线仍成立
- [ ] 所有 `file:line` 写作时重新 grep 验证
- [ ] 通过一次性深审收口
