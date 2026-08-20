# 06. JPMS Modules：类能被找到，不代表你能用它

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64` 讨论。本文聚焦 JDK 11 的 JPMS 运行时元数据与访问检查边界，说明它如何叠加在上一章的 class loader / bootstrap visibility 之上。
> **前置依赖**：[05 — ClassLoader](05-classloader-hierarchy.md)：loader visibility、bootstrap bridge 与 CLD 生命周期已经建立；[01 — ClassFile 解析](01-classfile-parser.md)：`module-info.class` 的 `ACC_MODULE` 与相关属性在 parser 阶段如何被处理
> → **后续**：[07 — javaClasses](07-javaclasses-core-mirrors.md)
> 关联域：06-oops、07-classfile-classloader、30-jvm-entry

## 类已经能 load 到，为什么还会 `IllegalAccessError`

在没有模块系统的年代，很多人会把“类能被找到”和“类能被用”几乎当成一回事。一个 `public class` 只要 class loader 能把字节读进来，接下来就主要靠 Java 语言级别的访问修饰符决定是否可用。

JDK 9 以后，这条链被切成了更多层：

```text
类字节能否被定位和定义
  ≠
当前模块是否能读取目标模块
  ≠
目标包是否 export/open 给当前模块
  ≠
类/成员的 Java access flag 是否允许这次访问
```

所以 JPMS 时代最容易出现的一种新事故就是：

```text
类已经 load 到了
Class 对象也存在
但链接时抛 IllegalAccessError
或反射时抛 IllegalAccessException
```

这并不矛盾，因为“能找到类”只解决了第一道门，后面至少还剩 readability 和 export/open 两道门。

这篇真正要回答的问题是：

**JPMS 到底在上一章的 class loader / bootstrap visibility 之上又加了什么？为什么 `public` 仍然重要，却不再足以让另一个模块正常访问一个类？`ModuleEntry`、`PackageEntry`、`Module.isExported`、`Reflection.verifyModuleAccess`、`--add-exports`/`--add-opens`/`--add-reads` 又各自卡在哪一层？**

先把全篇主线画出来：

```text
类请求 / 反射请求
  │
  ├─ loader visibility（上一章）
  │    ├─ package -> module owner routing
  │    ├─ bootstrap visibility / search_append_only
  │    └─ 类字节是否能被定位并定义成 Class
  │
  ├─ readability gate
  │    └─ source module 是否 reads target module
  │         -> ModuleEntry::can_read(...)
  │
  ├─ export/open gate
  │    └─ target package 是否 export/open 给 caller
  │         -> PackageEntry / Java Module API
  │
  ├─ C++ linkage/access checks
  │    └─ Reflection::verify_class_access / LinkResolver
  │
  └─ Java reflection checks
       └─ Module.isExported / Reflection.verifyModuleAccess / AccessibleObject
```

一句话先记住：

**JPMS 没有替代 class loader，而是在“类能被找到”之后，再叠加两道门：先问模块能不能读，再问目标包有没有对你 export/open。**

---

## 一、三个看似更简单的方案，为什么都不够

### 1.1 只靠 class loader 委派决定可见性

最自然的旧世界直觉是：

```text
能 load 到 -> 就能用
```

但上一章已经说明，class loader / bootstrap 只解决“去哪里找 bytes”。JPMS 增加模块以后，一个类就算被 boot loader 从 runtime image 里成功定义，也不意味着任意其他模块都能链接到它。

否则模块内部包与公开 API 包就没有区别，模块化只剩下打包形式变化。

### 1.2 只加模块级可读性，不管 package export/open

另一个过度简化是：

```text
module A reads module B
  -> A 就能用 B 的所有 public class
```

这也不对。模块系统刻意把“读模块”和“看包”拆开：

- readability 决定 A 是否有资格把 B 当作依赖目标
- export/open 决定 B 的哪个包对 A 可见，以及以什么方式可见

如果只靠 reads，不再区分 package export/open，那模块里的内部实现包会和 API 包一起暴露给所有读取者。

### 1.3 只靠 Java `Module.isExported` 判断一切

还有一种常见误解是把模块访问理解成纯 Java API 问题：

```text
直接问 Module.isExported
  -> true 就能访问
  -> false 就不能访问
```

这也不完整。HotSpot 里至少有两条相关但不相同的检查路径：

- VM 链接时的 C++ 路径：`Reflection::verify_class_access` / `LinkResolver`
- Java 反射路径：`Reflection.verifyModuleAccess` / `Module.isExported`

Java `Module.isExported` 自己甚至明确声明：它**不检查** caller 是否 reads 当前模块。也就是说，它只覆盖“export/open 这一层”，不覆盖完整的模块访问判定。

所以本篇必须把三个问题拆开：

```text
类字节能否被 loader 找到
模块之间能否建立可读关系
目标包是否对你公开到相应程度
```

---

## 二、模块与包为什么必须分两层存

### 2.1 每个 non-anonymous CLD 都有 package table，并按需有 module table

模块元数据不是一张“全局模块表”扔在 VM 中央完事。它跟上一章的 loader linking domain 绑在一起：每个非匿名 `ClassLoaderData` 都会持有 package table，并按需创建 module table。

这说明模块系统首先承认一个前提：

```text
模块定义依附于某个 defining loader 的 linking domain
```

所以模块和包信息必须跟着 CLD 走，而不是飘成一个和 loader 无关的全局名字表。

### 2.2 `ModuleEntry` 记的是“读谁”，不是“导出谁”

`ModuleEntry` 的字段包括：

- `_module`
- `_pd`
- `_loader_data`
- `_reads`
- `_version`
- `_location`
- `_can_read_all_unnamed`
- `_has_default_read_edges`
- `_must_walk_reads`
- `_is_open`
- `_is_patched`

最关键的纠偏是：**这里没有 `_exports`。**

也就是说，模块条目不是“读和导出都记在模块级对象里”的一锅端。它记录的是：

```text
这个模块属于谁
它能读哪些模块
它是不是 open module
它是否被 patch 过
```

而“某个包到底 export 给谁”属于另一层结构。

### 2.3 `PackageEntry` 才是 export/open 的包级控制点

`PackageEntry` 保存：

- `_module`
- `_export_flags`
- `_qualified_exports`

因此 JPMS 的结构不是“模块有一个 exports 列表”，而是：

```text
ModuleEntry
  → 这个模块读谁

PackageEntry
  → 这个包对谁公开到什么程度
```

这样拆分的原因非常直接：模块里的包并不天然一视同仁。一个模块完全可能同时拥有：

- 对外 API 包
- 只对特定 friend module 导出的内部包
- 完全不导出的实现包

如果 exports 只挂在模块级，你根本没法表达这种差异。

### 2.4 `open module` 是模块级 override，不是 per-package `_opens` 列表

`ModuleEntry::_is_open` 容易被误讲成“这个模块有一张 opens 列表”。其实它表达的是更简单也更强的一件事：**整个模块是 open module。**

`PackageEntry` 的导出判断直接把 `module()->is_open()` 当成 override：只要模块 open，该模块中的包就按 unqualified export/open 语义处理。

所以：

```text
module-wide open
  ≠
某个包被单独 add-opens
```

这两个层次不能混在一起。

---

## 三、第一道门：类字节能不能被 loader 找到

### 3.1 上一章的 loader visibility 仍然先发生

JPMS 没有替代 class loader。对一个类请求来说，第一道门仍然是：

```text
当前 loader / boot path 能否物理定位到这个类的 bytes
```

在 boot loader 路径上，`SystemDictionary::load_instance_class` 先看 package 属于哪个 module，再决定 search boundary：是正常的 boot module/image 路径，还是 append-only 的 boot append 路径。

所以“模块可见性”首先有一个非常朴素的层面：**这个包到底归哪个 module/loader 管，VM 是否允许当前 loader 去那个地方找类字节。**

### 3.2 runtime image 查找本身就是 module-qualified 的

`ClassPathImageEntry::open_stream_for_loader` 不会对着整份 `lib/modules` 平铺暴力搜 class 名。它先：

1. 从类名提取 package
2. 从 package entry 找到所属 module
3. 再按 `/module/package/class` 这种路径去 jimage 查资源

这说明 module 在 boot loader 世界里的第一层作用不是“访问控制”，而是**定位类文件的命名空间边界**。

### 3.3 `search_append_only` 说明 boot loader 先做 module visibility，再决定搜索范围

上一章讲过 bootstrap path 的 `search_append_only`。这里要把它翻成模块语义：

如果一个类的 package 不在 boot loader 定义的 module 集合中，或属于 unnamed/append 范围，VM 就不会把它当成普通 runtime image 类去找，而是限制在 boot append 这条边界内。

所以“能不能找到类字节”这个问题，在 JPMS 时代已经带着 module/package owner 的前置判断了。

但请注意：**这仍然只是第一道门。** 就算类字节能找到、类也已经定义成功，后面还要过 reads 和 export/open 两道门。

---

## 四、第二道门：readability，为什么读不到模块就别谈类型访问

### 4.1 `ModuleEntry::can_read` 只回答“这个模块能不能把另一个模块当依赖”

`ModuleEntry::can_read` 在 `moduleEntry.cpp:115-145` 里的逻辑非常清楚：

- unnamed module 读所有模块
- 所有模块都默认可读 `java.base`
- 若有 `_has_default_read_edges` 且目标是特定 unnamed module，允许特殊默认读边
- 否则检查 `_reads` 列表中是否包含目标模块

它做的不是完整访问控制，只是回答：

```text
source module 对 target module 是否建立了 readable relation
```

### 4.2 `can_read` 不是 transitive graph 推导器

`_reads` 本身存的是 direct read edges。`can_read()` 没有在运行时做递归图遍历或传递闭包推导；模块分辨率阶段已经把需要的 direct readability 关系建好，运行时这里只是在查当前状态。

所以不要把 `can_read` 讲成“运行时动态求模块图可达性”。它更像：

```text
对已经构造好的 read edge 集合做查询
```

### 4.3 default read edges 不是普通模块图的默认规则

`_has_default_read_edges` 很容易被误读成“所有模块都有的默认读边”。源码注释明确指出，这个分支服务的是 JVMTI redefine/retransform / agent instrumentation 等特殊场景。

它只对：

- 目标模块 unnamed
- 且 loader data 属于 boot/null 或 system/app

这种特殊组合生效。

所以它绝不是“普通 named module 默认都能读 unnamed module”的通用规则。一定要把它写成**特例**。

### 4.4 `--add-reads` 修改的是这一层，不是 exports

这一层最重要的“走后门”工具是 `--add-reads`。它改变的是模块可读关系，而不是 package export 状态。

这条链路与 `--add-exports`/`--add-opens` 完全不同，后者修改的是下一层门。

到这里先收一个结论：**readability 只回答“你能不能把它当作依赖模块”，它不等于“你能用它的任意 public 包”。**

---

## 五、第三道门：export/open，为什么 public 仍然不够

### 5.1 `public` 仍然重要，但它不再是唯一门槛

现稿开头那句“public 不再对所有人可见”方向上没错，但表述必须更精确。

更准确的说法是：

```text
public 仍然是类/成员级访问前提
但跨模块访问时，还必须额外满足 read + export/open
```

也就是说，JPMS 没有让 `public` 失效，而是给它叠加了模块边界门槛。

### 5.2 `PackageEntry` 的三态：未导出、限定导出、未限定导出

`PackageEntry` 的状态大致可以理解成：

```text
未导出
导出给特定模块集合（qualified export）
导出给所有模块（unqualified export）
```

另外还有一个特殊状态：

```text
导出给所有 unnamed modules（ALL-UNNAMED）
```

这不是 unqualified export，而是一种带特殊目标集合的 qualified/export 语义。

### 5.3 `ALL-UNNAMED` 不是“对所有人都开”

这是模块选项中最容易被误解的地方之一。

`PKG_EXP_ALLUNNAMED` 的语义是：

```text
这个包对所有 unnamed modules 可见
```

它不等于：

```text
这个包无条件 export 给所有命名模块和无名模块
```

因此 `--add-exports ...=ALL-UNNAMED` 只是放宽到无名模块这群 caller，不是把包变成彻底 unqualified export。

### 5.4 open module / `--add-opens` 也不是 `--add-exports`

`open module` 是模块级 override；`--add-opens` 是运行时增加 open 语义。它们更偏向深反射路径，而不是普通编译/链接的“导出给谁”语义。

所以这三种状态必须严格分开：

```text
readable
  → 能把对方当依赖模块看

exported
  → 普通 public 类型/成员访问可通过包门槛

open
  → 深反射等需要更强包开放语义的场景可通过
```

### 5.5 导出状态是单向加强的

`PackageEntry` 的实现中，一个包的导出状态可以从更严格走向更宽松：

```text
未导出 -> qualified export -> unqualified export
```

但不能反过来收紧成“之前导出过，后来撤回成未导出”。就连 qualified export 列表中目标模块都被 GC 清掉后，HotSpot 也保留“这个包曾经进入过 qualified export 状态”的痕迹，避免状态非法逆转。

这点很有设计味道：JPMS 运行时附加开口以兼容/调试为主，状态倾向于单向增强，而不是频繁收紧。

### 5.6 `--add-exports` 修改的是这一层，而不是 reads

`--add-exports` 的整条链路是：

```text
HotSpot 参数解析
  -> jdk.module.addexports.N properties
  -> ModuleBootstrap decode
  -> Modules.addExports* facade
  -> JVM_AddModuleExports*
  -> HotSpot Modules::add_module_exports*
  -> PackageEntry export state 更新
```

注意其中根本没有 read edge 更新。也就是说，**`--add-exports` 不是在帮你“读这个模块”，而是在帮你“让这个包对你公开”。**

这和 `--add-reads` 必须严格拆开。

---

## 六、C++ 与 Java 两条检查路径：同一规则，不是同一个函数

### 6.1 VM 链接期：先 readability，再 export/open，失败抛 `IllegalAccessError`

C++ 路径最清楚的实现是 `Reflection::verify_class_access`。它的大致顺序是：

1. same module / unnamed 特例
2. `module_from->can_read(module_to)`
3. 若 target module open，直接通过
4. 否则检查 `PackageEntry`：
   - unqualified export
   - 或 qualified export 到 caller module
5. 失败则返回对应错误类型，`LinkResolver` 将其变成 `IllegalAccessError`

这说明 VM 路径是在真正链接类引用时重放 module policy，而不是只看 Java `Module` API 的结果。

### 6.2 Java reflection 路径：`Reflection.verifyModuleAccess` 主要做 export 检查

Java 反射侧的 `Reflection.verifyMemberAccess` 会先调用 `verifyModuleAccess`。而 `verifyModuleAccess` 的实现主要是：

```text
same module ?
否则调用 memberModule.isExported(pkg, currentModule)
```

关键边界在于：`Module.isExported(String, Module)` 自己明确声明——它**不检查** caller 是否 reads 当前模块。

所以不能写成：

```text
Java reflection 直接复用了 can_read + export 的完整 VM 逻辑
```

更准确是：Java reflection 在这一层显式重放自己的模块出口检查，而不是简单调用 VM 那个同名函数。

### 6.3 `AccessibleObject` 与深反射还会继续追加 open 要求

普通链接和普通反射看 export；而更深的反射访问（例如想直接打破封装）还会继续走 `isOpen` / `AccessibleObject` 相关逻辑。

这就是为什么“export”和“open”必须在叙事里拆开，而不是只用一句“模块有没有把包开放给你”带过。

### 6.4 这两条路径依赖的是同一底层状态，但不是同一个判断实现

这里的最佳表述应该是：

```text
Java 与 VM 共享的是底层 module/package state
不是同一个统一的检查函数
```

因此：

- VM 链接期用 VM 元数据和 C++ 检查路径
- Java reflection 用 Java `Module` API 和 `Reflection` helpers
- 两边表达同一套规则，但触发时机、异常类型和具体实现不相同

---

## 七、`--add-exports` / `--add-opens` / `--add-reads`：三条“走后门”的链路不要混

### 7.1 HotSpot 先做的只是把命令行变成内部属性

参数解析阶段，HotSpot 并不会一看到 `--add-exports` 就立刻改某个 `ModuleEntry` 字段。它只是把这些选项转成：

```text
jdk.module.addreads.N
jdk.module.addexports.N
jdk.module.addopens.N
```

后续由 Java 侧 `ModuleBootstrap` 在 boot layer 已建立后再 decode 和应用。

### 7.2 `--add-reads` 改的是第一道门

`--add-reads` 通过 `ModuleBootstrap` -> `Modules.addReads` -> JVM entry -> HotSpot `Modules::add_reads_module` 这条链，改变的是 source module 的 read edge。

也就是说，它解决的是：

```text
source module 能不能把 target module 当依赖
```

### 7.3 `--add-exports` 改的是第二道门

`--add-exports` 走的是 `Modules.addExports*` 路径，最终修改的是 `PackageEntry` export state：

- 对某个命名模块 qualified export
- 或对 `ALL-UNNAMED` 增加 all-unnamed export

它不创建 read edge。

### 7.4 `--add-opens` 改的是 open 语义，主要为深反射服务

`--add-opens` 和 `--add-exports` 解析链类似，但最终修改的是 open 语义。它主要服务于深反射，不应被讲成“只是更强一点的 export”。

### 7.5 default read edges 和 `--add-exports` 不是一回事

有些文章会把 instrumentation / JVMTI 里的 default read edges 和 `--add-exports` 混在一起，说成“模块走后门时会加默认读边”。

这里一定要拆开：

- default read edges 是 `ModuleEntry::can_read` 里的 JVMTI/instrumentation 特例
- `--add-exports` 只改 package export/open 这一层

否则“能读模块”和“包是否对你公开”又会重新揉回一团。

---

## 八、误解澄清：八个最容易写过头的判断

1. **public 是否在模块时代失效了？** 没有。public 仍然是类/成员级前提；JPMS 只是又叠加了 read + export/open 两道门。
2. **类被 loader 找到是否等于模块可访问？** 不等于。类字节可见、模块可读、包已导出/开放是不同层次。
3. **`ModuleEntry` 是否保存 exports？** 不保存。exports/open 的包级状态在 `PackageEntry`。
4. **`can_read` 是否就是完整访问检查？** 不是。它只做 readability；后面还要看 target package 是否 export/open 给 caller。
5. **`Module.isExported` 是否会检查 readability？** 不会。Java API 文档和实现都明确说明这一点。
6. **`--add-exports` 是否等于 `--add-reads`？** 不等于。前者改包导出，后者改模块读取关系。
7. **`ALL-UNNAMED` 是否等于 unqualified export？** 不等于。它是“对所有 unnamed modules 的特别导出”，不是对所有模块都无条件导出。
8. **open module / `--add-opens` 是否等于把模块读边放开？** 不等于。它影响的是包开放语义，而不是 source module 的 readability。

---

## 九、收网：JPMS 没有替代类加载，而是把“找到类”和“能用类”拆成了多道门

现在把全文压回最开始的问题：为什么类已经能 load 到，仍会 `IllegalAccessError`？

因为在 JPMS 时代，“能不能用这个类”至少拆成了四层：

```text
1. loader visibility
   -> 类字节能不能被当前 loader / bootstrap 路径定位并定义

2. readability
   -> caller module 是否 reads target module

3. export/open
   -> target package 是否对 caller export/open

4. Java access flags
   -> public/protected/package/private 等传统语言级规则
```

三句话收束全文：

- **JPMS 没有取代 class loader；它叠加在“类能被找到”之后。**
- **`ModuleEntry` 管的是模块能读谁，`PackageEntry` 管的是包对谁公开到什么程度。**
- **`--add-reads`、`--add-exports`、`--add-opens` 分别改的是不同门槛，不能混成一个“模块后门开关”。**

下一篇顺着文中反复出现的“镜像”继续：`java.lang.Module`、`java.lang.Class`、`String` 等核心 Java 对象在 HotSpot 里各自怎样和 native 元数据双向绑定。

> → [07 — javaClasses](07-javaclasses-core-mirrors.md)
