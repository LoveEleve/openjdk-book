# 34-jmx/02 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `ObjectName`、`Repository`、`DefaultMBeanServerInterceptor`。本文聚焦 JMX 命名空间、ObjectName 规范化、模式匹配与注册表结构；MBean 类型细节放到下一篇。
> 目标：把“ObjectName 与注册机制”改写成一篇围绕“JMX 之所以能像文件系统一样批量发现和精确定位运行时对象，关键不在于它用了一个字符串，而在于这个字符串会被解析、规范化、索引进 Repository，再配合模式匹配与生命周期钩子形成真正的管理命名空间”展开的机制文章。

## 1. 读者困惑

- `java.lang:type=Memory` 到底是什么，为什么它不是随便起的字符串？
- 为什么 `name=Heap,type=Memory` 和 `type=Memory,name=Heap` 会被当成同一个 MBean？
- `queryNames(new ObjectName("*:*"))` 为什么能列出整棵 JMX 树，它底层靠什么做批量发现？
- Repository 为什么要做成 domain 分桶 + canonical key 索引的双层结构？
- `registerMBean` 到底在哪一步决定“重复注册”或“名称被修改/拒绝”？

## 2. 一句话顿悟

**ObjectName 的价值从来不在“能写成字符串”，而在“它会被解析成管理命名空间里的规范地址”。`domain:key=value` 先经过规范化，得到唯一 canonical 形式，再被 Repository 按 domain 分桶、按 canonical 属性串索引；JMX 因而同时获得了精确寻址、模式查询和重复注册检测能力。`registerMBean` 则把名字校验、生命周期钩子和最终入表连成了对象获得管理身份的全过程。**

## 3. 旧稿优点与问题

### 保留

- 已抓到 `ObjectName` 构造/规范化、`isPattern`、Repository 双层 Map、读写锁和 registerMBean 钩子流程。
- 已把 `queryNames("*:*")` 与 JConsole 左侧树联系起来，这个例子非常好。
- 已指出 canonicalName 与重复注册检测，这是本文关键。

### 必须重写

- 旧稿偏术语分栏，需要先立住总问题：为什么 JMX 能既精确定位又批量发现对象。
- ObjectName、Repository、register 流程要统一到“管理命名空间建立”这条主线上。
- 双层 Map 的解释要服务于“为什么既要 domain 隔离又要 O(1) 精确定位”。
- preRegister/postRegister 要讲成“对象拿到管理身份前后的生命周期钩子”，而不是孤立源码点。

## 4. 理解路径

### 第一节：从“`java.lang:type=Memory` 为什么不是随便起的字符串”开场

用 JConsole 树节点开场。先立住总问题：JMX 需要一套既能跨进程传输、又能批量查询、还能保证唯一性的运行时地址系统。

### 第二节：ObjectName 为什么首先是规范地址，而不是显示字符串

证据：
- `ObjectName.java:226`：类定义
- `ObjectName.java:363`：`_canonicalName`
- `ObjectName.java:418/1404/1406`：`construct(String)` 与构造
- `ObjectName.java:836/1618`：canonical 生成与读取

主线：
- 构造时就会解析并规范化。
- 属性顺序不同但属性集相同，会压到同一 canonicalName。
- 这解释了为什么字符串顺序变化不影响唯一身份。

### 第三节：模式匹配为什么让 ObjectName 不只是“唯一键”，还是批量发现语言

证据：
- `ObjectName.java:1470`
- `ObjectName.java:2009/2013/2014`
- `DefaultMBeanServerInterceptor.java:512`
- `Repository.java:508`

主线：
- `isPattern()` 判断它是否带通配语义。
- `queryNames` 通过模式匹配 + QueryExp 批量发现对象。
- JConsole 左侧树和监控系统发现机制都建立在这条能力上。

### 第四节：Repository 为什么是 domain 分桶 + canonical 属性串索引的双层结构

证据：
- `Repository.java:52/84`
- `Repository.java:286/299`
- `Repository.java:326/328/336`
- `Repository.java:384/508`

主线：
- 外层 key = domain，内层 key = canonical key property list string。
- 精确寻址先取 domain 桶，再取 canonical key，接近 O(1)。
- 模式查询再按 domain 或全表遍历。
- 这解释了“精确快、模式贵”的复杂度分化。

### 第五节：registerMBean 为什么不是“过了合规就放进表里”

证据：
- `DefaultMBeanServerInterceptor.java:295/305/313`
- `DefaultMBeanServerInterceptor.java:908/955/963`
- `DefaultMBeanServerInterceptor.java:988/1005`
- `Repository.java:384`

主线：
- 先做合规检查；
- 再执行 `preRegister`，对象可改名或拒绝注册；
- 再真正进 Repository；
- 最后 `postRegister` 通知结果。
- 这说明“拿到管理身份”本身就是一个受控生命周期过程。

### 第六节：为什么重复注册检测会落到 canonicalName 上

主线：
- 如果同一 domain + 同一属性集的不同书写形式被视为不同对象，JMX 命名空间就会失去唯一性。
- canonical 形式让重复注册检测有稳定依据。
- 这把名称规范化和注册冲突问题收束到同一根上。

## 5. 失败方案清单

1. 把 ObjectName 当成人类可读标签，忽略其规范化与唯一性要求。
2. 认为属性顺序不同就代表不同 MBean 名称。
3. 把 `queryNames("*:*")` 当成简单字符串过滤，不看 Repository 模式查询成本。
4. 以为 `registerMBean` 只做合规检查后直接入表。
5. 忽略生命周期钩子，在注册前后不处理资源和名称调整。

## 6. 误解清单

1. ObjectName 的字符串长什么样只影响显示，不影响实际寻址。
2. JMX 左侧树是把所有 MBean 名字线性扫一遍拼出来的。
3. Repository 两层结构只是历史实现细节，与性能和命名空间无关。
4. `preRegister` 只是通知对象即将注册，不能真正影响名称或结果。
5. 重复注册检测只看原始输入字符串是否完全一致。

## 7. 证据清单

- `ObjectName.java:226/363/418/836/1404/1406/1470/1618/2009/2013/2014`
- `Repository.java:52/84/286/299/326/328/336/384/508`
- `DefaultMBeanServerInterceptor.java:295/305/313/512/908/955/963/988/1005`

## 8. 版本与边界

- 基于 JDK 11。
- 本篇聚焦命名与注册表，不展开 MBeanInfo 生成和 MXBean 开放类型映射。
- QueryExp 只作为过滤接口点到为止，不细拆表达式语法。
- 远程连接器的名字传输问题留到 JMX 远程篇。

## 9. 删除代码测试与最终验收标准

- 删除代码块后，读者仍能复述“为什么 ObjectName 是规范地址 → 为什么它既能唯一定位又能模式发现 → Repository 双层结构如何支撑精确定位与批量查询 → registerMBean 如何通过钩子和入表让对象获得管理身份 → 重复注册为什么看 canonicalName”。
- 必须把命名空间和注册机制讲成一条线。
- 必须自然引到 `03-mbean-types-mxbean.md`。
