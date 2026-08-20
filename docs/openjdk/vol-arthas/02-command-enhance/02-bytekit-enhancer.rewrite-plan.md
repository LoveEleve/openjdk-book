# 02-bytekit-enhancer 重写规划

> 状态：重写前大纲
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 目标：把当前“Enhancer / ByteKit / retransform 链”重构成一篇围绕“已加载的方法为什么还能被热替换，以及 Arthas 怎样把‘找目标’和‘织入什么’拆成一条可重放、可去重、可回滚的增强链”的机制文

## 1. 选题判断

这篇值得独立成篇，但不能继续写成：

- `EnhancerCommand` 做什么
- `Enhancer.enhance()` 做什么
- `transform()` 做什么
- ByteKit 拦截器有哪些
- `inline=true` 是什么

这种按增强流程节点平铺的说明文。

更好的统一问题是：

**业务方法明明早就被 JVM 加载并运行了，Arthas 凭什么还能在不停机、不重编译的前提下把观察逻辑塞进去？而且连续 watch/trace 时，为什么不会把同一个方法越织越厚、越改越乱？**

这样本篇就不再是“动态增强实现导览”，而会被收束成同一条增强链上的几个硬问题：

- 如何找到当前 JVM 里已经加载的目标类
- 如何要求 JVM 重新把这些类交回给 Transformer
- 如何把“插在哪里、插什么”表达成可复用模板，而不是手写字节码
- 如何避免重复增强
- 如何保证写回后的字节码仍然类型正确、可 reset

## 2. 读者困惑

- `watch com.example.Service doBiz` 明明针对的是一个已经在跑的方法，为什么 Arthas 还能把监视逻辑塞进去？
- 它为什么不靠重新编译应用，也不要求业务代码主动依赖 Arthas？
- `watch`、`trace`、`monitor` 这些命令看起来不同，为什么都能复用同一条增强链？
- 连续执行多次 watch / trace，为什么不会把同一方法无限叠加增强？
- 字节码写回时，Arthas 为什么不会因为类加载器上下文不一致把目标类写坏？

## 3. 一句话顿悟

**Arthas 并不是在“重新生成一个新类替换旧类”，而是在当前 JVM 已加载类集合里先找到目标，再把自己注册成 Transformer，借 `retransformClasses()` 让 JVM 重新交回字节码；随后用 ByteKit 把“在哪些位置插入哪些 SpyAPI 调用”表达成模板式拦截器，并用位置过滤与缓存机制保证增强可去重、可写回、可恢复。**

## 4. 版本边界

正文开头必须明确：

- 基于 `arthas` 当前源码与 ByteKit 当前源码实现讨论
- 聚焦已加载类增强与 `retransformClasses()` 路径
- 不把 AdviceListenerManager 的分发细节提前展开；那属于下一篇
- 不把 JVM 字节码验证、JVMTI ClassFileLoadHook 细节展开成主线；这里只点到为止作为跨层证据
- 这里讲的是 Arthas 当前增强架构，不等于所有 Java agent 工具都采用 ByteKit + ASM 这套方案

## 5. 旧稿主要问题

### 5.1 已有优点

- 已经抓到“已加载方法怎样被塞进监视逻辑”这个真实困惑
- `EnhancerCommand -> Enhancer -> retransform -> transform -> ByteKit -> SpyAPI` 的主链已经在
- 已经有重复增强过滤、类加载器可见性、类型安全写回、`inline=true` 等关键证据
- 已经看到了 watch/trace 共用主链、按 listener 能力分化差异

### 5.2 必须修复的问题

- 当前骨架仍偏“流程说明文”，主问题还不够集中
- 失败方案推演不够厚：为什么不能重编译、不能靠代理包装、不能重复织入、不能在错误类加载器上下文里计算类型，都还没有打透
- `EnhancerCommand` 模板骨架、匹配搜索、ByteKit 模板、写回安全这几段目前像并列机制点，还没收成同一条链
- `inline=true` 和写回阶段的证据很强，但路标不够，读者不容易区分“主线必须懂”和“支撑证据”

## 6. 重写策略

本篇不按源码文件顺序推进，而按更强的问题链组织：

1. 先建立冲突：方法已经加载并运行，Arthas 还想临时塞入观测逻辑
2. 先排除几个错误直觉：
   - 重新编译应用
   - 让业务主动依赖 Arthas
   - 用反射代理包装一层
   - 每次增强都重新物理插入一遍 Spy 调用
3. 再给总图：`EnhancerCommand` 定骨架，`Enhancer` 找目标并触发 retransform，ByteKit 织入模板，位置过滤防重复，写回缓存供 reset
4. 然后分层拆：
   - 模板方法为什么能统一 `watch/trace/tt/...`
   - 已加载类为什么仍能被重新交回给 Transformer
   - 拦截器模板如何把“插在哪里”变成声明式能力
   - 为什么必须防重复增强
   - 为什么写回必须感知目标类加载器
5. 最后收束成“找目标 / 织入模板 / 去重 / 写回安全”四段式增强哲学

## 7. 结构大纲（按理解路径）

### 第一节：事故开场——方法都已经在跑了，Arthas 还能临时钻进去？

目标：建立真实困惑，而不是直接列增强链。

要回答：

- `watch com.example.Service doBiz` 面对的是已加载、已运行的方法
- Arthas 既不能要求业务重启，也不能要求业务代码预埋依赖
- 本篇真正要追的是“它怎样在当前 JVM 里改写已存在的方法”

预估字数：900-1100

### 第二节：先排除几个错误直觉——重编译、代理包装、重复织入

目标：做失败方案推演。

要回答：

- 为什么不能靠重新编译应用或重启 JVM
- 为什么不能简单做一层代理包装
- 为什么连续 watch / trace 不能每次都物理多插一套 Spy 调用
- 真正需要的是一条“可重放、可去重、可回滚”的增强链

预估字数：1300-1600

### 第三节：第一层——`EnhancerCommand` 为什么要把增强流程做成模板骨架

目标：把 `watch/trace/monitor/...` 共用增强主链写成冲突解法。

要回答：

- 为什么这些命令看起来不同，却共享“找类 → 注册增强器 → 重转换 → 收 Advice”这条主链
- `InvokeTraceable` 为什么能把 watch 和 trace 的差异翻译成“插不插 invoke 拦截器”
- 命令层真正变化的只是“匹配什么”和“事件回调给谁”

证据锚点：

- `core/command/monitor200/EnhancerCommand.java:39`
- `EnhancerCommand.java:193-292`
- `listener instanceof InvokeTraceable`

预估字数：1500-1800

### 第四节：第二层——已加载的类为什么还能重新交回给 Transformer

目标：把 `Enhancer.enhance()` 写成“找目标 + 重新进 transform 链”的解法。

要回答：

- `SearchUtils.searchClass()` / `searchSubClass()` 查找的不是 class 文件，而是已加载类对象集合
- `filter()` 为什么要剔除 Arthas 自身类、某些 loader、lambda 等
- `maxNumOfMatchedClass` 为什么是保护阀
- 为什么 `Enhancer` 要先把自己注册成 Transformer，再调用 `Instrumentation.retransformClasses()`
- 懒加载模式为什么属于同一增强链的另一种入口

证据锚点：

- `core/advisor/Enhancer.java:639-705`
- `Enhancer.java:546-560`
- `Enhancer.java:653`
- `Enhancer.java:663-697`
- `Enhancer.java:667-670`

预估字数：1800-2200

### 第五节：第三层——ByteKit 如何把“插什么、插到哪”变成模板而不是手写字节码

目标：把拦截器模板写成声明式织入解法。

要回答：

- `transform()` 拿到字节数组后，为什么先检查 `SpyAPI` 可见性
- 为什么要先转成 `ClassNode`
- `DefaultInterceptorClassParser`、`SpyInterceptor1/2/3`、trace/line 拦截器分别在表达什么能力
- `watch` 与 `trace` 差异为什么最终只是拦截器集合差异
- `inline=true` 为什么意味着插入的是直接指令，而不是反射调用

证据锚点：

- `Enhancer.java:154`
- `Enhancer.java:197-230`
- `core/advisor/SpyInterceptors.java:18+`
- `Enhancer.java:207-230`
- `inline=true`

预估字数：2200-2600

### 第六节：第四层——为什么连续 watch 不会把同一方法越织越厚

目标：把重复增强写成一个核心失败方案。

要回答：

- 什么叫“重复增强”
- `LocationFilter`、`GroupLocationFilter`、`InvokeContainLocationFilter` 如何识别已有 Spy 调用点
- 为什么允许挂多个 listener，但不允许同一类 Spy 调用被重复物理插入
- 监听器四元组注册为什么要放在真正织入成功之后

证据锚点：

- `Enhancer.java:252-278`
- `Enhancer.java:255-274`
- `Enhancer.java:334-336`

预估字数：1700-2100

### 第七节：第五层——为什么写回字节码必须感知目标类加载器

目标：把写回安全与 reset 能力写成增强链的最后一道边界。

要回答：

- 为什么要提升过低 class 版本
- 为什么要保留原始 `ClassReader` 与常量池复用
- `classBytesCache` 为什么是 reset 的前提
- 为什么 `getCommonSuperClass()` 不能偷懒用系统类加载器，而必须感知目标 loader
- 写回安全为什么和增强成功一样重要

证据锚点：

- `Enhancer.java:346-354`
- `Enhancer.java:196-198`
- `src/com/alibaba/bytekit/asm/ClassLoaderAwareClassWriter.java:12-36`

预估字数：1700-2100

### 第八节：收网——Arthas 不是在“改一个类”，而是在重放一条可去重、可恢复的增强链

目标：把全文收成一句话并桥接下一篇。

必须点名：

- 模板命令骨架
- 已加载类搜索 + retransform
- ByteKit 模板织入
- 重复增强过滤
- 写回缓存与类加载器上下文安全
- 下一篇进入 AdviceListenerManager 分发链

预估字数：800-1000

## 8. 必须展开的失败方案

至少要展开以下失败方案：

1. 重新编译或重启应用才能插入观测逻辑
2. 让业务代码主动依赖 Arthas
3. 给目标对象做一层代理包装就够了
4. 每次 watch / trace 都重复物理插入同类 Spy 调用
5. 在系统类加载器上下文里直接计算公共父类并写回字节码

## 9. 本篇必须明确澄清的误解

1. `watch com.example.Service doBiz` 不是在操作 class 文件，而是在操作当前 JVM 已加载类对象
2. `Enhancer` 不是普通服务类，它本身就是 `ClassFileTransformer`
3. watch 与 trace 不是两条完全不同的增强链，差异主要体现在 listener 能力与拦截器集合
4. 防重复增强不是“同一个命令只能执行一次”，而是“同一类 Spy 调用点不重复物理插入”
5. `inline=true` 不等于运行时反射调用，而是模板体内联成目标方法直接指令
6. 写回阶段如果忽略目标类加载器上下文，会把类写坏，而不是只影响性能

## 10. 证据清单（正文托底）

- `core/command/monitor200/EnhancerCommand.java:39`
- `EnhancerCommand.java:193-292`
- `core/advisor/Enhancer.java:639-705`
- `Enhancer.java:546-560`
- `Enhancer.java:653`
- `Enhancer.java:663-697`
- `Enhancer.java:667-670`
- `Enhancer.java:154`
- `Enhancer.java:197-230`
- `Enhancer.java:252-278`
- `Enhancer.java:313-336`
- `Enhancer.java:346-354`
- `core/advisor/SpyInterceptors.java:18+`
- `src/com/alibaba/bytekit/asm/ClassLoaderAwareClassWriter.java:12-36`

## 11. 字数预算

- 目标正文总字数：`9000-12000`
- 叙述性正文目标：`6000+`

## 12. 完成后必须通过的检查

1. 删除代码后，主线是否仍然成立
2. 是否清楚回答了“已加载方法为什么还能被热替换”
3. 是否至少展开了 4 个失败方案
4. 是否把“找目标 / 织入模板 / 去重 / 写回安全”统一到同一条增强链主线上
5. 是否避免提前展开下一篇的 AdviceListenerManager 分发细节
6. 是否完成 `file:line` 重核与边界声明
