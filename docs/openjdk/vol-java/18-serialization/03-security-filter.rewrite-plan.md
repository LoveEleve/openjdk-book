# 18-serialization/03 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `ObjectInputFilter`、`ObjectInputStream` 及默认反序列化流程。本文聚焦反序列化攻击面、gadget 链机制、JDK9+ 过滤器、模式串限制与生产白名单实践；不展开具体第三方 gadget 链源码。
> 目标：把“反序列化安全”改写成一篇围绕“危险不在某个单独 bug，而在于反序列化机制天然允许不可信数据驱动类加载、对象创建和钩子调用；ObjectInputFilter 只是把这条默认便利路径重新加上边界”的机制文章。

## 1. 读者困惑

- 为什么一段字节流居然能变成远程代码执行，这不是“读数据”而已吗？
- 反序列化漏洞到底依赖什么条件，为什么很多项目都天然满足？
- gadget 链为什么不是某个类本身有后门，而是多个“合法类”组合出危险路径？
- `ObjectInputFilter` 到底拦在哪，为什么它能同时防类黑白名单问题和资源炸弹？
- `maxdepth`、`maxrefs`、`maxbytes`、`maxarray` 这些限制在真实攻击里分别防什么？
- 为什么生产实践总强调白名单，而不是单纯拉一张黑名单？

## 2. 一句话顿悟

**Java 反序列化的危险不在“某个实现写错了”，而在机制本身天然允许：外部字节流决定要加载什么类、创建什么对象、自动调用哪些恢复钩子；一旦类路径上存在可被串起来的 gadget，这条数据通路就可能转化成代码执行。`ObjectInputFilter` 的作用不是让序列化 magically 安全，而是给这条默认无限制的对象图恢复流程加上类、深度、引用数、字节数和数组长度的显式闸门。**

## 3. 旧稿优点与问题

### 保留

- 已覆盖 gadget 链、ObjectInputFilter 三态接口、实例级/进程级配置、模式串限制与四类资源上限、防护清单。
- 已明确指出“类模式防 RCE、深度/数组/引用/字节限制防 DoS”，方向准确。
- 已把前两篇的 readObject/readResolve 钩子与本篇攻击面连起来，这是很好的主抓手。

### 必须重写

- 旧稿偏安全清单，需要先建立统一主问题：危险来自不可信数据驱动对象恢复机制本身，而不是某个孤立 bug。
- gadget 链部分要更强调“多个合法类被组合”，避免读者误会成只要不用某单个库就彻底安全。
- ObjectInputFilter 的三态和模式串要讲成“护栏系统”，不是 API 细节表。
- 生产规范要回到“禁用 / 白名单 / 限制 / 精简类路径”的层次化防线，而不只是 checklist。

## 4. 理解路径

### 第一节：从“为什么读一段字节流会变成代码执行”开场

承接前两篇：readObject0 会按流里的类描述创建对象，还会自动触发 readObject/readResolve。先立住总问题：反序列化不是被动读数据，而是由数据驱动类加载、对象实例化与钩子调用。

### 第二节：gadget 链为什么不是单个类有毒，而是合法行为被串成恶意路径

证据：
- `ObjectInputStream.java:1619`：`readObject0`
- `ObjectInputStream.java:1687`：`readOrdinaryObject`
- `ObjectInputStream.java:549-552` / `2233-2251`：readResolve 相关说明与时机
- 结合前篇 `ObjectStreamClass` 探测 write/read hooks 的锚点做回钩

主线：
- 类名来自字节流，钩子自动执行，这使不可信数据拥有“选择对象和触发行为”的能力。
- gadget 链不是某个类单独恶意，而是多个类的合法副作用被组合成危险调用链。
- 这就是为什么“类路径里存在 gadget 库 + 有不可信 readObject 入口”会天然形成风险面。

### 第三节：ObjectInputFilter 为什么是“在对象创建前加护栏”

证据：
- `ObjectInputFilter.java:103-119`：接口与 `checkInput`
- `ObjectInputFilter.java:126-176`：`FilterInfo`
- `ObjectInputFilter.java:184-197`：`Status`
- `ObjectInputStream.java:1329`：`filterCheck`
- `ObjectInputStream.java:1368-1369`：REJECTED 抛异常

主线：
- 过滤器不是替代反序列化，而是在对象图恢复过程中逐个节点做裁决。
- `ALLOWED/REJECTED/UNDECIDED` 三态让多个过滤维度叠加成为可能。
- 这要讲成一套“拦类 + 拦规模”的统一护栏，而不是单个 API。

### 第四节：模式串和四类限制为什么正好对应两大攻击面

证据：
- `ObjectInputFilter.java:257-282`：全局过滤器初始化来源
- `ObjectInputFilter.java:306`：`setSerialFilter`
- `ObjectInputFilter.java:383`：`createFilter`
- `ObjectInputFilter.java:575-594`：`parseLimit`
- `ObjectInputFilter.java:615-656`：`Global.checkInput`

主线：
- 类模式（允许/拒绝包名与类）主要防 gadget 类进入恢复链。
- `maxdepth/maxrefs/maxbytes/maxarray` 主要防深度炸弹、大数组、引用风暴和超大流量 DoS。
- 这四类限制不是随机拼凑，而是和攻击形态一一对应。

### 第五节：为什么黑名单不够，白名单才是默认思路

主线：
- 黑名单只能枚举已知危险类或库，新的 gadget 组合仍可能漏网。
- 白名单表达的是“只有这些业务 DTO / 基础类允许进入恢复流程”，从默认拒绝出发更符合最小攻击面原则。
- 要把“禁用 > 白名单 > 限制”这条防线优先级讲清楚。

### 第六节：资源炸弹为什么和 RCE 同样重要

证据：
- `ObjectInputStream.java:1819`：无类检查时也走 filterCheck（引用/深度等）

主线：
- 不是所有攻击都想执行代码，很多只想把 JVM 打爆：深度炸弹、大数组、引用风暴、超大字节流。
- 类模式对白这些没用，所以必须结合深度、引用数、数组长度、字节数限制。
- 这把“安全”从代码执行扩展到资源生存性问题。

### 第七节：生产规范为什么是分层防线，而不是单点修补

主线：
- 最好：不可信输入根本不用 Java 原生序列化。
- 必须用：实例级/进程级过滤器 + 白名单 + 四类限制。
- 再往上：删掉不必要 gadget 库、监控 InvalidClassException / StreamCorruptedException / filter reject 异常类型与频次。
- 重点是“把默认无边界机制改造成有边界的恢复流程”。

## 5. 失败方案清单

1. 把反序列化当成“读数据”，忽略它会驱动类实例化和钩子调用。
2. 只盯某一条已知 gadget 链，以为删掉一个依赖就彻底安全。
3. 只配类黑名单，不配白名单与资源上限。
4. 只防 RCE，不防深度炸弹、大数组和引用风暴。
5. 在对象已经开始被读取之后才想着设置过滤器。
6. 看到 JDK9+ 有 ObjectInputFilter 就以为默认已经足够安全。

## 6. 误解清单

1. 反序列化漏洞本质上是某个特定库的 bug。
2. gadget 链一定需要攻击者上传自定义字节码。
3. ObjectInputFilter 只负责类名白名单，不管资源攻击。
4. 黑名单足够长就能解决所有反序列化风险。
5. REJECTED 只是一个日志告警状态，不会真正阻止读取。
6. 只有网络入口才需要在意反序列化安全。

## 7. 证据清单

- `ObjectInputStream.java:1619`：`readObject0`
- `ObjectInputStream.java:1687`：`readOrdinaryObject`
- `ObjectInputStream.java:549-552`：readResolve 说明
- `ObjectInputStream.java:1329`：`filterCheck`
- `ObjectInputStream.java:1368-1369`：REJECTED 抛异常
- `ObjectInputStream.java:1819`：无类检查也走 filterCheck
- `ObjectInputFilter.java:103-119`：接口与 `checkInput`
- `ObjectInputFilter.java:126-176`：`FilterInfo`
- `ObjectInputFilter.java:184-197`：`Status`
- `ObjectInputFilter.java:257-282`：全局过滤器初始化
- `ObjectInputFilter.java:306`：`setSerialFilter`
- `ObjectInputFilter.java:383`：`createFilter`
- `ObjectInputFilter.java:575-594`：四类 limit 解析
- `ObjectInputFilter.java:615-656`：`Global.checkInput`

## 8. 版本与边界

- 基于 JDK 11。
- 本篇聚焦 JDK 自带防线和攻击面原理，不展开第三方利用工具和具体 gadget 代码细节。
- 不把 ObjectInputFilter 讲成唯一答案；它是边界控制，不是对不可信 Java 序列化输入的绝对豁免。
- 安全建议强调分层防线，不把“别用序列化”讲成抽象口号。

## 9. 删除代码测试与最终验收标准

- 删除代码块后，读者仍能复述“为什么反序列化危险来自数据驱动对象恢复机制本身 → gadget 链如何由多个合法类串起来 → ObjectInputFilter 如何在恢复路径上逐点裁决 → 类白名单与四类资源限制分别在防什么 → 生产上为什么要禁用/白名单/限流/精简类路径分层防守”。
- 必须把类模式防 RCE与 limit 防 DoS 讲成两条并行护栏。
- 必须自然收束整个 18 域。
