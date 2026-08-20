# ObjectName 与注册机制：为什么 JMX 能既精确定位对象，又像文件系统一样批量发现对象

> 本文基于 JDK 11 `ObjectName`、`Repository`、`DefaultMBeanServerInterceptor`。本文聚焦 JMX 命名空间、ObjectName 规范化、模式匹配与注册表结构；MBean 类型细节放到下一篇。本文讨论的是 JDK 11 JMX 命名与注册机制，不把这里的 canonical 规范化、Repository 双层索引和生命周期钩子流程外推成所有管理框架都必须遵守的统一规范。
> **前置依赖**：[JMX 架构全景](01-jmx-architecture.md)、[集合结构](../08-collections/01-arraylist.md)
> **后续**：[MBean 类型与 MXBean](03-mbean-types-mxbean.md)

## 先看一个最容易被低估的事实：`java.lang:type=Memory` 不是给人看的标签，而是管理命名空间里的正式地址

打开 JConsole 左侧树时，我们看到的每个节点都像一段简单字符串：`java.lang:type=Memory`、`java.lang:type=Threading`、`com.app:type=Order,name=Metrics`。最容易产生的误解，就是把它们当成“比较规范的名字”。

但 JMX 如果只是给对象起字符串标签，它根本支撑不了真正的管理动作。管理系统真正需要的是一套运行时地址体系：

- 能跨进程传输；
- 能唯一定位对象；
- 能支持批量模式查询；
- 能在注册时检测冲突；
- 能让管理端像浏览目录一样发现对象集合。

这也就是 `ObjectName` 真正的价值所在。它不是漂亮字符串，而是会被解析、规范化、索引进 Repository 的**管理地址**。JMX 之所以既能精确找到一个 MBean，又能用 `*:*` 把整个管理树批量列出来，根子都在这里。

## 一、为什么 `ObjectName` 首先是规范地址，而不是显示字符串

### 先看它的构造入口

JDK 11 里，`ObjectName` 定义在 `ObjectName.java:226`。核心字段 `_canonicalName` 在 `ObjectName.java:363`，字符串构造入口在：

- `ObjectName(String name)`：`ObjectName.java:1404`
- 里面调用 `construct(name)`：`1406`
- 真正解析逻辑在 `construct(String)`：`418`

这条链路已经说明一个关键事实：`ObjectName` 不是“把原始字符串原样存下来”，而是构造时就进入了解析和规范化流程。

### 为什么规范化是这套命名空间成立的前提

旧稿已经抓住了核心结果：规范化后的名字最终落进 `_canonicalName`，而 `getCanonicalName()` 在 `ObjectName.java:1618` 直接返回它。canonical 形式的生成则在 `ObjectName.java:836` 收口。

这意味着：

- `java.lang:type=Memory,name=Heap`
- `java.lang:name=Heap,type=Memory`

虽然输入字符串顺序不同，但只要 domain 相同、属性集相同，规范化之后就会落成同一个 canonical 形式。

这一步看起来像实现细节，实际上决定了命名空间是否稳定。如果同一个对象仅仅因为属性书写顺序不同就被当成两个不同名字，JMX 的地址系统马上就失去唯一性。

所以 ObjectName 的第一层价值，不是“可读”，而是**同一地址必须有同一规范表示。**

## 二、为什么 `ObjectName` 既能唯一定位，又能支持批量发现：它本身就是一套模式语言

### 先看模式能力从哪来

JDK 11 里，`isPattern()` 在 `ObjectName.java:1470`。旧稿已经点到：它通过压缩存储的标志位判断当前名字是否带有通配语义。

而在更后面的匹配相关实现里，`ObjectName.java:2009/2013/2014` 也进一步说明：是否是 pattern，会直接影响后续比较与匹配逻辑。

### 为什么这让 JMX 地址系统不只是“唯一键”，还是“发现语言”

如果 ObjectName 只有精确名称这一种形态，那管理端就只能在已知名字的前提下查单个对象。这对远程管理来说远远不够，因为你经常需要先做发现：

- 列出所有 MBean；
- 找出某个 domain 下全部对象；
- 按 `type=*` 批量筛选一类资源；
- 再在筛出来的集合上做进一步操作。

所以 `ObjectName` 不只是主键，它还是一门小型的管理寻址语言。`*:*` 不是技巧，而是在说“列出整个管理命名空间”；`java.lang:type=*` 则是在说“列出这个 domain 下所有这一类对象”。

### 为什么 JConsole 左侧树本质上就是一次批量查询

旧稿已经把链路抓出来了：`queryNames(pattern, query)` 会经过 `DefaultMBeanServerInterceptor.queryNames(...)`，位置在 `DefaultMBeanServerInterceptor.java:512`，最后落到 `Repository.query(...)`，位置在 `Repository.java:508`。

这说明 JConsole 左侧那棵树不是某种特殊 API 硬编码画出来的，而是管理端用 ObjectName 模式对命名空间做了一次批量发现。也就是说，**JMX 树形浏览本质上来自命名空间的模式查询能力。**

## 三、为什么 Repository 要做成“domain 分桶 + canonical 属性串索引”的双层结构

### 先看核心字段和定位路径

JDK 11 里，`Repository` 定义在 `Repository.java:52`。核心字段是：

- `domainTb`：`Repository.java:84`

它的类型正是旧稿提到的双层结构：外层按 domain，内层按 canonical key property list string 存放 `NamedObject`。

精确定位路径也很直白：

- `retrieveNamedObject(...)` 在 `Repository.java:286`
- 先 `domainTb.get(dom)`：`299`
- 再从该 domain 的内部表取对象

构造时：

- 读写锁在 `Repository.java:326`
- `domainTb = new HashMap<>(5)` 在 `328`
- 默认 domain 桶初始化在 `336`

### 为什么不能只用一个大 Map

如果只用一个全局大 Map，所有名字都扁平地混在一起，那么：

- domain 这一层命名空间隔离就会弱化；
- 模式查询按 domain 切桶的能力会变差；
- 精确查询虽然也能做，但无法自然利用 domain 作为第一层索引。

双层结构恰好同时满足两件事：

1. 先按 domain 分桶，把命名空间天然分区；
2. 再用 canonical 属性串在桶内做精确定位。

所以它并不是“实现上多套了一层 Map”，而是在把 JMX 的命名语义直接投影成注册表结构。

### 为什么这也解释了查询复杂度为什么会分化

一旦结构是双层的，复杂度特征就非常自然：

- 精确寻址：先取 domain 桶，再取 canonical key，接近 O(1)；
- 模式查询：根据 pattern 的范围决定是在某个桶里扫，还是跨全部桶遍历，所以代价会接近 O(n)。

这也就是为什么 JMX 能同时兼顾“精确定位很快”和“批量发现也能做，但成本更高”。它们本来就是两种不同形态的查询。

## 四、为什么 `registerMBean` 不只是“校验后放进表里”：对象拿到管理身份本身就是一个受控生命周期过程

### 先看注册的关键入口

旧稿已经抓到了核心链路：

- `DefaultMBeanServerInterceptor.registerMBean(...)`：`DefaultMBeanServerInterceptor.java:305`
- 其中先做 `Introspector.checkCompliance(...)`：`295/313`
- 再进入 `preRegister(...)`：`908`
- 再进入 `registerWithRepository(...)`：`955`
- 最后 `postRegister(...)`：`963`
- `preRegister` / `postRegister` 自身定义在 `988` / `1005`

这条链说明，注册动作本身就是一个完整的管理生命周期，而不是简单地“合规就写表”。

### 为什么 `preRegister` / `postRegister` 让注册变成了生命周期事件

`preRegister` 的重要性经常被低估。它不是一个纯通知回调，而是允许对象在真正入表之前参与过程：

- 它可以修改最终使用的 `ObjectName`；
- 也可以通过抛异常拒绝注册。

这意味着名称并不总是调用方输入什么就原样生效，对象自身也能参与自己管理身份的建立。

而 `postRegister` 则负责在注册结果尘埃落定后，让对象感知自己是否真的进入了管理空间。

所以“注册”在 JMX 里从来不只是数据结构变化，它还是**对象获得管理身份的生命周期事件。**

### 为什么真正入表时重复检测会落到 canonical 形式上

真正进入 Repository 的入口在 `Repository.addMBean(...)`，位置在 `Repository.java:384`。重复注册的判断之所以可靠，不是因为系统记住了你原始字符串长什么样，而是因为前面已经先把名字压成 canonical 形式。

这就把两个问题合成了一根线：

- 名称规范化保证“同一地址只有一种标准表示”；
- 入表检测基于这个标准表示判断是否冲突。

所以重复注册不是“字符串完全一样才算冲突”，而是“管理地址等价就算冲突”。

## 五、为什么命名空间、注册表和注册流程必须放在一起看：它们共同回答“一个对象怎样获得可管理身份”

如果只看 ObjectName，很容易把它理解成字符串规则；如果只看 Repository，又容易把它理解成注册表实现；如果只看 `registerMBean`，又像是在看一次生命周期回调流程。真正把它们放在一起，才会发现三者实际上回答的是同一个问题：

**一个运行中对象，怎样被放进 JMX 命名空间里，并从此能被精确定位、批量发现和安全调用。**

这条路径是：

1. 先把名称解析成规范地址；
2. 再通过生命周期钩子和合规校验决定能否进入管理空间；
3. 最后把对象放进 Repository 的双层索引结构里。

到这一步，一个普通对象才真正拥有了管理身份。没有这条链，JMX 只是若干接口名；有了这条链，它才变成一套真正可运转的管理命名空间。

## 六、五个最容易混掉的边界：ObjectName 不是标签，canonical 不是显示细节，模式查询不是精确查表，Repository 不是随便套两层 Map，register 也不是单纯入表动作

在收网之前，先把这一篇最容易记错的五条边界压实。

第一，`ObjectName` 不是人类随手起的标签。它真正承担的是管理命名空间里的正式地址职责：只有地址被标准化，MBean 才能被可靠定位、比较和判冲突。

第二，canonical 形式也不是“为了显示统一一点”的小细节。它真正值钱的地方，是把“同一组属性、不同书写顺序”的名字压成唯一标准表示，这样注册冲突、精确寻址和缓存索引才有稳定依据。

第三，模式查询更不是精确查表的另一种写法。精确寻址依赖 domain + canonical key 近似 O(1) 命中；模式查询则本来就要牺牲这份直接性，换来批量发现和通配能力。把两者混成一层，很容易对 JMX 查询成本产生错觉。

第四，Repository 也不是随便套两层 Map 就完事。它的双层结构正好把 JMX 命名语义投影进了数据结构里：外层先按 domain 分区，内层再按 canonical 属性串精确定位。少任何一层，这套命名空间要么失去隔离，要么失去高效定位。

第五，`registerMBean` 更不是“对象合规就放进表里”的单步动作。它在前后都挂着生命周期语义：`preRegister` 可以改名或拒绝，`postRegister` 才告诉对象最终结果。也就是说，注册并不只是数据结构变化，而是对象获得管理身份的完整过程。

把这五条边界记稳，ObjectName 与注册机制这一篇就不会重新塌回“字符串规则 + 注册表实现细节”的表面印象。它真正想讲的是：JMX 怎样把名字、索引和生命周期钩子绑成同一套管理命名空间。

## 收网：JMX 之所以能像文件系统一样批量发现和精确定位对象，根子不在字符串，而在规范化地址 + 分桶索引 + 生命周期入表

现在可以把整篇压成一条主线：

- `ObjectName` 不是显示标签，而是管理命名空间里的规范地址；
- canonical 形式保证同一地址只有一种标准表示；
- 模式匹配让它既能唯一定位，又能批量发现；
- Repository 用 domain 分桶 + canonical key 索引把这套命名语义落成结构；
- `registerMBean` 通过合规检查、生命周期钩子和入表动作，让对象真正获得管理身份；
- 重复注册检测也因此建立在 canonical 地址之上。

所以理解 `java.lang:type=Memory` 的正确角度，不是“这是一个固定写法的字符串”，而是：**这是 JMX 命名空间里的正式地址，JMX 用它来保证对象可寻址、可发现、可判冲突。** 一旦这套地址和注册机制建立起来，后面的 MBean 类型、MXBean 开放类型映射、远程连接器才有共同基础。

下一篇自然就会继续追问：名字和注册都立住了，MBean 的“管理描述”到底从哪来？标准 MBean 为什么能按命名约定自动被识别，MXBean 又怎样把复杂 Java 类型映射成开放类型，这就是 `03-mbean-types-mxbean.md` 要接着回答的问题。
