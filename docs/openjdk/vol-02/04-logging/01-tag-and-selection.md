# 01. `-Xlog:gc*=debug` 到底是怎么选中日志的？— 标签与选择

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64` 讨论
> **前置依赖**：[03-arguments-flags/02 — flag 生命周期](../03-arguments-flags/02-flag-processing-and-management.md)：`-Xlog` 也是一个 flag 输入
> → **后续**：[02 — 输出与配置](02-output-and-configuration.md)：选中的日志往哪写、怎么加装饰和做轮转
> 关联域：18-safepoint、32-jfr、35-dcmd

## 先别把 `gc*` 看成一棵树

看到：

```text
-Xlog:gc*=debug
```

大多数人的第一反应是：

- `gc` 是父标签
- `heap`、`region`、`task`、`phases` 是它的子标签
- `gc*` 就是“gc 这棵子树下面所有日志”

这个理解很顺手，也很像很多现代日志系统的标签层级树。

但 HotSpot Unified Logging 在 JDK 11u 里的实现并不是这么工作的。

它根本没有一棵日志标签树。

它真正做的是：

```text
编译期
  → 把所有标签定义成一组扁平枚举值
  → 每条日志点绑定一个固定的 TagSet

运行期
  → 把 `gc*=debug` 解析成一个选择器
  → 用“标签子集匹配 + wildcard + level 阈值”去匹配 TagSet
```

所以这篇要讲清的不是“有哪些 gc 子标签”，而是：

**`gc*` 为什么看起来像前缀匹配，实际上却是“包含 gc 标签的任意 TagSet”；以及 HotSpot 如何用一套编译期固定标签集合支撑运行期的查询语法。**

先把整条链画出来：

```text
编译期：
  标签清单        → 扁平枚举值
  日志声明        → 固定 TagSet
  TagSet 注册     → 静态全局链表

运行期：
  -Xlog 字符串    → LogSelection 解析
  选择器列表      → 按顺序匹配 TagSet
  匹配成功        → 计算生效级别
  输出层          → 下一篇继续讲
```

一句话先记住：

**Unified Logging 不是“树上找节点”，而是“用选择器匹配一组编译期固定的标签集合”。**

---

## 一、为什么 HotSpot 不做标签树，而做扁平枚举

### 1.1 一条日志可能同时属于多个维度

如果日志系统是一棵树，那么每条日志点通常要先回答：

> 我属于哪个父节点？

但 HotSpot 的很多日志并不是只在一个维度里有意义。

例如同一条 GC 相关日志，可能同时涉及：

- `gc`
- `heap`
- `task`
- `phases`
- `region`

它到底应该挂在：

- `gc/heap`
- `gc/task`
- `gc/phases`

哪个子树下？

只要系统要求“每条日志点只能属于一条树路径”，这种多维属性就会变得 awkward：

- 放在 `gc/heap`，那按 task 维度筛的时候不自然
- 放在 `gc/task`，那按 phases 看又割裂
- 复制一份到多个子树，又会让声明和维护爆炸

这就是 HotSpot 没走树形结构的根本动机。

它真正需要的是：

**同一条日志点可以同时带多个平级标签，从多个维度被筛选。**

### 1.2 `LOG_TAG_LIST`：所有标签先变成一张平面表

HotSpot 在 `logTag.hpp:34-174` 用 `LOG_TAG_LIST` 统一列出标签：

```cpp
#define LOG_TAG_LIST \
  LOG_TAG(add) \
  LOG_TAG(age) \
  LOG_TAG(alloc) \
  ... \
  LOG_TAG(gc) \
  LOG_TAG(handshake) \
  LOG_TAG(heap) \
  ... \
  LOG_TAG(region) \
  LOG_TAG(remset) \
  ...
```

随后再把这张清单展开成枚举：

```cpp
enum type {
  __NO_TAG,
#define LOG_TAG(name) _##name,
  LOG_TAG_LIST
#undef LOG_TAG
  Count
};
```

这意味着：

```text
gc、heap、region、task、phases
全都是平级枚举值
```

没有：

- 父标签指针
- 子节点链
- 层级路径字符串
- 继承关系

这就是第一条必须打掉的直觉：

**HotSpot 的日志标签不是树节点，而是枚举值。**

### 1.3 为什么这比树更适合 JVM

一旦标签是扁平的，一条日志点就可以天然带多个标签：

```text
gc + heap
gc + region + task
gc + phases
```

这样筛选时就可以按不同维度看同一批日志：

- 想看所有 GC 日志：只要求包含 `gc`
- 想看只和堆有关的：要求 `gc+heap`
- 想看 task 级别的 GC 子活动：匹配 `gc+task`

树形系统很难同时优雅地表达这种“一个事件从多个维度都成立”的关系。

所以扁平枚举不是实现细节，而是整个 Unified Logging 的分类哲学。

---

## 二、`LOG_TAGS(...)`：每条日志点的身份在编译期就固定了

### 2.1 运行时不是给日志临时贴标签

另一种常见想象是：

- 某条日志要输出时
- 运行时代码现拼出它有哪些标签
- 再交给日志系统判断

HotSpot 没这么做。

它选择在编译期就把每条日志点的标签集合固定下来。

### 2.2 `LOG_TAGS(...)` 的真正作用

`logTag.hpp:176-185` 附近定义了：

```cpp
#define PREFIX_LOG_TAG(T) (LogTag::_##T)

#define LOG_TAGS_EXPANDED(T0, T1, T2, T3, T4, T5, ...) \
  PREFIX_LOG_TAG(T0), PREFIX_LOG_TAG(T1), PREFIX_LOG_TAG(T2), \
  PREFIX_LOG_TAG(T3), PREFIX_LOG_TAG(T4), PREFIX_LOG_TAG(T5)

#define LOG_TAGS(...) \
  EXPAND_VARARGS(LOG_TAGS_EXPANDED(__VA_ARGS__, _NO_TAG, _NO_TAG, _NO_TAG, _NO_TAG, _NO_TAG, _NO_TAG))
```

这套宏做的事并不神秘：

```text
log_debug(gc, heap)
    ↓
编译期被翻译成
LogTag::_gc, LogTag::_heap, LogTag::__NO_TAG, ...
```

也就是说，一条日志点在代码里写下 `gc, heap` 时，它的标签集合就已经在编译期固定成一组枚举值了。

### 2.3 为什么上限是 5 个标签

源码注释和 `MaxTags` 约束共同表达了一个事实：

**每条日志点最多支持 5 个标签。**

这不是任性限制，而是工程判断：

- 大多数日志点 1~3 个标签就够了
- 标签越多，声明噪声越大
- 匹配时需要比较的标签数也会增加
- 超过 5 个通常意味着这条日志分类本身已经失控

而且这里的上限不是运行期软限制，而是编译期静态约束：

- 宏会多塞一个哨兵参数
- 超限时触发编译期错误

所以标签数量控制也属于“编译期先把身份钉死”的一部分。

---

## 三、TagSet：每条日志点的标签组合最后去哪了

### 3.1 `LogTagSet` 不是查询语法，它是日志点身份

到这里我们已经有：

- 一组扁平的 `LogTag` 枚举
- 一条日志点通过 `LOG_TAGS(...)` 固定下来的标签参数

但运行时还需要一个对象来承接这组固定标签。

这就是 `LogTagSet`。

它表达的是：

```text
一条日志点到底绑定了哪些标签
```

而不是：

```text
用户想查询哪些标签
```

后者是 `LogSelection` 的事情，后面才讲。

### 3.2 `LogTagSetMapping`：模板实例化生成静态 TagSet

`logTagSet.hpp:136-157` 一侧定义了 `LogTagSetMapping` 模板。它的作用是：

- 根据一组编译期常量标签
- 实例化出一个静态 `LogTagSet`
- 让后续 `LogHandle`、`LogMessage` 直接引用它

所以一条日志点不是在运行时 new 一个 TagSet，而是：

```text
编译期模板实例化
    ↓
生成静态 TagSet 对象
    ↓
日志点直接引用这块静态对象
```

这样做有几个重要收益：

- 无需运行时分配
- 日志点身份稳定不变
- 匹配时只需读现成 TagSet
- 不存在“某条日志点忘记注册自己”的初始化竞态

### 3.3 `_list`：为什么 JVM 启动前就能知道“所有可配置日志类别”

`logTagSet.cpp:37-55` 里，`LogTagSet` 构造时会把自己挂到全局链表 `_list`：

```cpp
LogTagSet* LogTagSet::_list = NULL;

LogTagSet::LogTagSet(...)
  : _next(_list), _write_prefix(prefix_writer) {
  ...
  _list = this;
}
```

这意味着：

```text
每个静态 TagSet 在初始化时自动注册到全局链表
```

于是 JVM 不需要在运行时额外“发现有哪些日志点”。

例如：

- `jcmd VM.log list`
- 配置阶段遍历所有 tagset
- 更新 decorators 或输出规则

都可以从这条链表出发。

所以 `LogTagSet::_list` 的意义不是普通容器，而是：

**把所有编译期声明过的日志点身份，统一暴露给运行时配置层。**

### 3.4 失败方案：运行时动态注册日志点

如果 TagSet 在首次打印时才动态注册：

- 需要锁保护注册表
- 会有“某条日志点还没注册就被查询”的竞态
- 配置变更很难保证看到全集
- 初始化顺序更复杂

HotSpot 选择的是更静态的办法：

```text
编译期实例化
启动期静态构造
运行期只配置和匹配
```

这让日志系统更像一个只读索引，而不是动态发现系统。

---

## 四、选择器解析：`gc*=debug` 到底被拆成什么

### 4.1 `LogSelection::parse` 要处理的不是单个名字，而是一个小 DSL

Unified Logging 的查询语法看起来简单，其实包含几种语义：

```text
all

gc*=debug

gc+heap=trace

safepoint*=off
```

`LogSelection::parse` / `parse_internal` 的任务，不是把它们当普通字符串保存，而是拆成：

- 标签数组
- 是否 wildcard
- 级别阈值

### 4.2 `all`、`*` 和 `+` 分别是什么语义

`logSelection.cpp:95-152` 的解析过程大致是：

1. 特判 `all`
2. 检查是否有结尾 `*`
3. 用 `+` 分割标签表达式
4. 每个标签通过 `LogTag::from_string` 转成枚举
5. 非法标签报错，并尝试 `fuzzy_match`
6. 构造 `LogSelection`

这说明：

- `all` 是特殊关键字，不是普通标签名
- `*` 只在结尾时有特殊含义
- `+` 不是层级分隔，而是“这条日志点必须同时带这些标签”

因此：

```text
gc+heap
```

不是“heap 是 gc 的子节点”，而是：

```text
目标 TagSet 同时包含 gc 和 heap
```

### 4.3 错标签为什么能给你“Did you mean?”

解析时如果 `from_string` 找不到对应枚举，HotSpot 不只是静默失败，还会尝试 `fuzzy_match` 给出近似建议。

这体现出：

- 标签是编译期枚举，名字集合固定
- 所以运行时完全可以在固定全集上做近似匹配
- 这比开放字符串系统更容易提供稳定错误提示

所以 Unified Logging 不是“纯文本匹配”，而是：

**字符串只是用户输入形式，真正系统里运作的是枚举值。**

---

## 五、`gc*` 的真实语义：不是前缀匹配，而是子集匹配加数量豁免

### 5.1 `gc*` 最容易误读成什么

很多人会把：

```text
gc*
```

理解成：

- 前缀字符串匹配
- `gc` 开头的所有标签名
- `gc` 子树展开

这三种理解在 HotSpot 11u 里都不准确。

### 5.2 `selects(const LogTagSet&)` 真正做了什么

`logSelection.cpp:161-171` 的匹配逻辑很短：

```cpp
bool LogSelection::selects(const LogTagSet& ts) const {
  if (!_wildcard && _ntags != ts.ntags()) {
    return false;
  }
  for (size_t i = 0; i < _ntags; i++) {
    if (!ts.contains(_tags[i])) {
      return false;
    }
  }
  return true;
}
```

它揭示了真正语义：

```text
没有 wildcard：
  标签数必须相等
  且选择器里的每个标签都要出现在 TagSet 里

有 wildcard：
  不要求标签数相等
  只要求选择器里的标签是目标 TagSet 的子集
```

因此：

```text
gc*
```

真正表示的是：

> 任意 TagSet，只要包含 `gc` 标签，就匹配。

而：

```text
gc+heap
```

在没有 `*` 时表示：

> 目标 TagSet 的标签个数必须与选择器相同，且选择器中的 `gc`、`heap` 都必须出现在该 TagSet 中。

在 HotSpot 当前固定去重的 TagSet 语义下，这通常就表现为“精确的标签集合匹配”，但它不是字符串顺序匹配，也不是标签树路径匹配。

这就是本篇最核心的结论：

**`gc*` 的真实语义不是前缀展开，而是“包含 gc 的任意 TagSet”。**

### 5.3 为什么这比标签树更自然

一旦标签是平级枚举，最自然的匹配关系就是集合关系。

例如一条日志点带：

```text
gc + region + task
```

那么：

- `gc*` 可以命中
- `gc+task*` 可以命中
- `gc+heap` 不会命中
- `task*` 也可以命中

树形语义很难优雅表达这种“一条日志点同时属于多个横向维度”的筛选。

集合匹配则非常直接：

```text
选择器标签 ⊆ TagSet 标签
```

wildcard 只是放宽了“标签个数必须相等”这一限制，并没有引入树结构。

### 5.4 失败方案：按前缀字符串匹配 `gc*`

如果系统真的按前缀字符串解释：

- `gc+heap` 这种组合没法自然落在字符串前缀树上
- `task+gc` 和 `gc+task` 的顺序问题会很麻烦
- 同一条日志点的多维属性会被迫映射到路径结构

所以 HotSpot 用的是集合匹配，不是路径匹配。

---

## 六、级别阈值与多选择器顺序：为什么后写的能覆盖前写的

### 6.1 级别不是“等于”，而是阈值

`logLevel.hpp:54-66` 定义了几个级别：

- `Off`
- `Trace`
- `Debug`
- `Info`
- `Warning`
- `Error`

当选择器写成：

```text
gc*=debug
```

它的语义不是“只输出 debug 级别”，而是：

> 对命中的 TagSet，允许输出不低于 debug 阈值的消息。

因此 `debug`、`info`、`warning`、`error` 都可能进入输出，而 `trace` 会被排除。

### 6.2 `LogSelectionList::level_for`：后命中覆盖先命中

当有多个选择器时，顺序就变得重要。

例如：

```text
-Xlog:gc*=info,safepoint*=off
```

后者会覆盖前面对带 `safepoint` 标签集合的选择。

这是因为 `LogSelectionList::level_for` 会按顺序尝试，**后命中的选择器覆盖先命中的结果**。

所以多选择器不是“集合并”，更像是：

```text
先给所有 TagSet 一个候选级别
后面的规则可以改写前面的命中结果
```

### 6.3 `off` 的真正作用

`off` 不是“删除某个标签”，而是：

- 匹配仍然发生
- 只是把这个 TagSet 的最终输出级别设置为关闭

因此：

```text
gc*=info,safepoint*=off
```

更准确的理解是：

- 先把所有包含 `gc` 的 TagSet 设为 `info`
- 再把其中同时命中 `safepoint*` 的那部分设为 `off`

这也再次说明：

**选择器是一组按顺序执行的覆盖规则，不是静态分类树。**

---

## 七、收网：编译期固定身份，运行期做集合匹配

现在把整条链重新收回来：

```text
编译期
  │
  ├─ LOG_TAG_LIST        → 扁平枚举标签
  ├─ LOG_TAGS(...)       → 日志点的固定标签参数
  ├─ LogTagSetMapping    → 静态 TagSet
  └─ LogTagSet::_list    → 全局注册链表

运行期
  │
  ├─ -Xlog 字符串       → LogSelection 解析
  ├─ 标签表达式         → 标签数组 + wildcard + level
  ├─ selects()          → 子集匹配（可选数量豁免）
  └─ level_for()        → 多选择器顺序覆盖
```

所以 Unified Logging 的第一层机制其实很简单：

1. 标签和 TagSet 在编译期固定
2. 运行期只做解析、匹配和级别决策
3. `gc*` 的真实语义是“包含 gc 的任意 TagSet”

如果压缩成三句话：

- HotSpot 的日志标签是平级枚举，不是树
- 每条日志点在编译期就绑定了静态 TagSet
- `-Xlog` 在运行期通过“标签子集 + wildcard + 阈值 + 顺序覆盖”决定输出

到这里还只解决了：

> 哪些日志应该被选中？

下一篇才继续解决：

- 选中的日志往哪里写
- stdout、stderr、文件输出如何管理
- decorators 如何添加时间戳、level、tid 等前缀
- 文件轮转和配置字符串如何组织

> → [02-output-and-configuration.md](02-output-and-configuration.md)
