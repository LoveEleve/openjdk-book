# 01-express-engine 重写规划

> 状态：重写前大纲
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 目标：把当前“OGNL 执行链 / WeakReference / ClassResolver”重构成一篇围绕“为什么一行表达式会牵出高频执行、运行时可见性和类加载器卸载边界” 的机制文

## 1. 选题判断

这篇值得独立成篇，但不能继续写成：

- `ExpressFactory` 做什么
- `OgnlExpress` 做什么
- `DefaultMemberAccess` 做什么
- `ClassResolver` 做什么

这种按组件平铺的说明文。

更好的统一问题是：

**一行 `params[0] > 100` 这种表达式，为什么在 Arthas 里不只是“求值一次字符串”，而是同时牵出高频回调开销、Advice 现场可见性、private 成员访问、类版本解析以及 stop/detach 后的 ClassLoader 可回收边界？**

## 2. 读者困惑

- 为什么表达式不能每次回调都直接 new 一个执行器？
- 为什么又不能把它强引用在线程里反复复用？
- 为什么 Advice 必须是根对象，而 `cost` 要额外 bind？
- 为什么 `@类@静态成员` 的解析会受 ClassLoader 影响？
- 为什么 private 可见性和副作用风险必须分开看？

## 3. 一句话顿悟

**Arthas 的表达式引擎并不是在“简单执行一段 OGNL 字符串”，而是在用 `ThreadLocal<WeakReference<Express>>` 复用线程级访问入口、用 `OgnlExpress` 固定 OGNL 的访问策略、用 Advice 提供结构化现场、用 ClassResolver 绑定类版本，同时避免 Express 对象把 ArthasClassLoader 永久钉在线程里。**

## 4. 版本边界

- 基于 `arthas` 当前 Express/OGNL 集成实现讨论
- 聚焦表达式引擎本身的执行链与卸载边界
- 不把 watch/tt/ognl 的具体使用场景写成本篇主线；那些留给下一篇
- 这里讲的是 Arthas 当前 OGNL 集成策略，不等于所有表达式引擎都必须采用 WeakReference + Advice 根对象模型

## 5. 旧稿主要问题

### 已有优点
- 已经抓到 WeakReference 防止 ClassLoader 泄漏这个最关键边界
- `OgnlExpress`、Advice 根对象、ClassResolver、DefaultMemberAccess 的关键锚点都在
- 已经注意到 private 可见性与方法副作用不是一回事

### 必须修复
- 当前骨架仍偏组件说明文，主问题不够集中
- 失败方案推演不够厚：为什么不能每次都 new、为什么不能强引用复用、为什么 Advice 不能换成随手 Map，还没打透
- `ClassResolver` 与副作用边界还可以更好地收回到同一条主线：表达式何时可见、何时可回收、何时有风险

## 6. 重写策略

- 先建立冲突：一行表达式既要高频执行，又不能把 Arthas 永远留在线程里
- 先排除错误直觉：每次都 new、ThreadLocal 强引用复用、随手 Map 根对象
- 再给总图：WeakReference 入口 → OgnlExpress 策略 → Advice 根对象 → ClassResolver → is/get
- 最后收束成“复用入口、不保活对象；放开可见性、保留副作用边界”的设计哲学

## 7. 必须展开的失败方案

1. 每次回调都 new 一个 Express
2. 用 ThreadLocal 强引用永久复用 Express
3. 用随手 Map 代替 Advice 根对象
4. 把 private 可见性误当成无副作用许可
5. 忽略 ClassLoader 版本直接解析 `@类@静态成员`

## 8. 本篇必须明确澄清的误解

1. OGNL 在 Arthas 里不是简单字符串求值
2. 复用的是线程级入口，不是强保活对象
3. Advice 字段和 bind 变量不是同一来源
4. private 可见性和方法副作用不是同一边界
5. ClassResolver 选择会改变命中的类版本

## 9. 证据清单（正文托底）

- `ExpressFactory.java:18-19,26-41`
- `OgnlExpress.java:16-65`
- `DefaultMemberAccess.java:26-31`
- `ArthasObjectPropertyAccessor.java:13-17`
- `ClassLoaderClassResolver.java:12-28`
- `CustomClassResolver.java:15-44`
- `Constants.java:40`

## 10. 字数预算

- 目标正文总字数：`8500-11000`
- 叙述性正文目标：`5500+`

## 11. 完成后必须通过的检查

1. 删除代码后，主线是否仍然成立
2. 是否清楚回答了“为什么一行表达式会牵出卸载边界”
3. 是否至少展开了 4 个失败方案
4. 是否把 WeakReference、Advice、ClassResolver、MemberAccess 统一到一条主线
5. 是否完成 `file:line` 重核与边界声明
