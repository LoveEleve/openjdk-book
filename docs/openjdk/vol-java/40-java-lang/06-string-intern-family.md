# 字符串驻留、intern 与 String 三兄弟：为什么同样的字符串，有时是同一个对象，有时不是

> 基于 JDK 11 `java.lang.String`（`String.java:3127` 的 `intern()`、`:146-185` 的 Compact Strings 存储）、`StringBuilder`（`:89`）、`StringBuffer`（`:111`）。本文讨论的是字符串常量池的驻留机制、`intern()` 的代价与边界、String/StringBuilder/StringBuffer 的分工，以及编译期字符串折叠的规则。`intern()` 是 native 方法，其行为由 JVM 实现，但 `String.intern` 的 API 契约是 JDK 11 可观测事实；常量折叠由 javac 执行，不是 JDK 运行时行为。
> **前置依赖**：[枚举语义与 switch](04-enum-switch.md)
> → **后续**：按扩展计划进入泛型方法与 PECS 或诊断工具专题

## 先看两个最容易答不完整的"String 题"

第一道题：`String a = "hello"; String b = "hello";` 和 `String c = new String("hello"); String d = new String("hello");`，`a == b` 和 `c == d` 分别是什么？很多人知道前者 true、后者 false，但被追问"为什么 `new String("hello")` 里的 `"hello"` 本身也驻留了——那 `new` 出来的是另一个对象还是同一个"，就容易卡住。

第二道题：`String s = "a" + "b" + "c"` 和 `String s = new StringBuilder().append("a").append("b").append("c").toString()`，字节码是否一样？很多人的第一反应是"不一样，第二个更高效"，但实际在 JDK 11 里，两个 `"a" + "b" + "c"` 会被编译器折叠成 `"abc"`，根本不需要 StringBuilder。

这两个问题背后是三个不同的机制在作怪：字符串常量池、编译期常量折叠、运行期拼接优化。把它们混成"String 留存"这一个概念，就会在面试和排障时对不上号。

这里至少有三个失败方案。

第一种失败方案，是把 `intern()` 当成"万能对象复用方法"，到处调。`intern()` 的代价是它要去常量池搜索、可能创建新字符串对象，而且会长期驻留在堆里，不会被 GC 回收。在高频调用或大字符串场景下，`intern()` 的代价可能远超它省下的对象成本。

第二种失败方案，是以为 `StringBuilder` 和 `StringBuffer` 的区别只是"线程安全"四个字。实际上它们的设计分歧不止于此：`StringBuffer` 在 JDK 1.0 就存在，所有方法都加锁；`StringBuilder` 是 JDK 1.5 加的，不加锁。但生产里"单线程用 StringBuilder，多线程用 StringBuffer"的说法并不完全正确——多线程操作同一个 StringBuilder 本来就不安全，而 StringBuffer 的锁粒度也是粗的，不一定比你自己在外层加锁好。

第三种失败方案，是以为 `String s = "a" + "b" + "c"` 在运行时才拼接，并且每次拼接都创建新字符串。实际上编译器在编译期就把常量字符串折叠了——`"a" + "b" + "c"` 直接变成 `"abc"`，根本没有运行时拼接。只有变量参与时（如 `"a" + s`）才会退到 StringBuilder 路径。

所以这三个失败方案指向同一个顿悟：**String 的"驻留"和"拼接"不是运行时行为，而是跨编译期和运行期两条线的协作。编译期做常量折叠和 intern 决定，运行期做 intern 查找和 GC 管理。把这两条线混在一起，就会把编译期做好的优化当成运行时"还要再优化一次"。**

## 一、字符串常量池与 `intern`：驻留的代价超出很多人想象

### 字符串常量池是编译期决定的

Java 里，字符串字面量（双引号声明的 `"hello"`）在编译期就被放入 class 文件的常量池。运行时，当类被加载时，这些常量会被解析并放入运行时常量池，最终驻留到堆里的字符串常量池中。这就是为什么 `"hello"` 和 `"hello"` 用 `==` 比较时指向同一个对象——它们来自同一个 class 文件常量池入口。

### `intern()` 是动态入池，代价比大部分人以为的高

`intern()`（`String.java:3127`）是一个 native 方法，它把当前字符串对象的内容去常量池里查找，如果池里已有内容相同的字符串，就返回池中的引用；如果池里没有，就把当前字符串对象入池。它的代价包括：

- 查找：需要在常量池中做内容匹配，大字符串或长链表下不便宜
- 入池：如果池里没有，当前字符串对象就永久驻留在堆里，且不会被 GC 回收
- 不可控：入池的字符串对象生命周期与 JVM 进程绑定，不能被主动释放

所以 `intern()` 适合的场景是"字符串内容有限且重复频繁、且内容不大"——类似有限枚举值的字符串表示。不适合的场景是"字符串内容动态、大量、长字符串"——那这个常量池就会变成驻留无上限的"内存黑洞"。

## 二、编译期常量折叠：`"a" + "b" + "c"` 在字节码里就是 `"abc"`

### JDK 11 的 javac 行为

如果你写 `String s = "a" + "b" + "c"`，javac 在编译期就会把它折叠成 `String s = "abc"`。因为所有操作数都是编译期常量。这个规则在 JLS 里有定义：常量表达式在编译期求值。

所以字节码不会调用 `StringBuilder`，不会调用 `String.concat`，甚至不会调用 `String` 的构造器。只有一个 `ldc "abc"` 指令，从常量池取字符串常量。这是零运行时开销。

### 变量参与时退到 StringBuilder

当至少有一个操作数不是编译期常量时（比如 `"a" + sb.toString()`），javac 会通过 `StringBuilder` 路径来拼接。JDK 11 的 javac 默认生成 `StringBuilder` 链，不会生成 `StringBuffer` 或 `String.concat`。

这就是为什么"手写 `StringBuilder` 代替 `+` 拼接"这个优化建议，在变量拼接场景下已经不成立了——编译器已经替你做了等价的事；只有在循环内拼接时，手动使用 `StringBuilder` 才有意义，因为编译器不会跨循环迭代优化。

到这里，驻留和折叠已经讲清了。接下来看 String 三兄弟——String、StringBuilder、StringBuffer——它们的分工不只是"线程安全"四个字。

## 三、String、StringBuilder、StringBuffer：三兄弟的分工不止于"线程安全"

### 三者的使用场景边界

- `String`：不可变，适合作为常量、键、共享数据
- `StringBuilder`（JDK 1.5，`StringBuilder.java:89`）：可变、无锁，适合单线程内频繁修改字符串
- `StringBuffer`（JDK 1.0，`StringBuffer.java:111`）：可变、有锁（几乎所有方法都 `synchronized`），适合多线程共享同一个 StringBuilder 的极少数场景

### 为什么"多线程用 StringBuffer"不是总正确

多线程环境下，多个线程同时操作同一个 `StringBuffer` 实例是安全的，但操作的原子性粒度是单个方法调用。如果你的业务逻辑需要"先 append 再 toString"作为一个整体原子，那单独的方法锁不够，仍然需要外部同步。所以 `StringBuffer` 的锁只防并发破坏内部结构，不防业务操作被穿插。

实际生产中，多线程环境下共享同一个可变字符串的场景本来就很少；大部分场景是每个线程自己持有 `StringBuilder`，最后再合并。这时候 `StringBuffer` 的每方法锁不仅不必要，还会带来不必要的竞争。

## 四、`new String("hello")` 到底创建了几个对象

这道经典面试题的本质是两层驻留。编译器在编译期已经把 `"hello"` 放入常量池，并且类加载时它已驻留。`new String("hello")` 的构造参数就是这个已驻留的 `"hello"` 字符串引用，而 `new` 关键字在堆上创建了一个新的字符串对象。所以如果你写 `String s = new String("hello")`，通常产生了两个对象：一个来自常量池驻留，一个来自 `new` 创建。

但 `new` 出来的这个新字符串的内容也是 `"hello"`，它和常量池里的 `"hello"` 内容相同、对象身份不同。这就是为什么 `new String("hello") == "hello"` 为 false——`==` 比的是对象身份，不是内容。

## 五个最容易混掉的边界：intern 不是万能复用，常量折叠不是运行时行为，拼接优化不是 `StringBuilder` 包办一切，StringBuffer 锁不是业务原子，new String 与字面量是两层驻留

第一，`intern()` 不是万能复用。它把对象永久驻留到常量池，代价是查找、不可回收，不适合大字符串或高频非重复内容。

第二，常量折叠不是运行时行为。`"a" + "b" + "c"` 在编译期就被折叠成 `"abc"`，字节码里只有一条 `ldc "abc"`，没有运行时拼接开销。变量拼接才退到 `StringBuilder`。

第三，拼接优化不是 `StringBuilder` 包办一切。编译器对单次拼接已自动使用 `StringBuilder`，手动重复写 `StringBuilder` 在这个场景下没有额外收益；只有循环内拼接才需要手动管理 `StringBuilder` 实例。

第四，`StringBuffer` 的锁不是业务原子。它的每方法锁只防内部结构被并发破坏，不防"先 append 再 toString"这类业务操作被穿插。

第五，`new String("hello")` 与字面量是两层驻留。字面量在编译期入池，`new` 在运行时创建新对象；两者内容相同但对象身份不同，`==` 为 false。理解了这两层驻留，这道题不需要背答案。

把这五条边界记稳，String 的驻留和拼接就不会再被简化成"String 不可变、StringBuilder 可变、StringBuffer 线程安全"的三句口诀。它真正想讲的是：字符串的生命周期从编译期就开始了——常量折叠、字面量驻留、运行期 intern、`StringBuilder` 拼接优化，是三条不同路径在同一个类型上的协作。

## 收网：String 的不可变与驻留，是编译期、类加载期、运行期三期协作的结果

回到开头两道题，现在能看清它们的分工了。

`"hello" == "hello"` 为 true，是因为编译期把两个字面量指向同一个常量池入口，类加载时这个入口被解析成同一个字符串对象。`new String("hello") == new String("hello")` 为 false，是因为 `new` 每次都创建新对象，与常量池无关。

`"a" + "b" + "c"` 编译后就是 `"abc"`，没有运行时拼接。`StringBuilder` 路径只在变量参与时才会被编译器调用。

把整篇压成一张总图：

```text
编译期
  → 字面量入常量池（class 文件）
  → 常量折叠："a"+"b"+"c" → "abc"
  → 变量拼接：生成 StringBuilder + append 链

类加载期
  → 运行时常量池解析
  → 字面量字符串驻留到堆

运行期
  → intern()：动态入池（查找 + 入池）
  → new String()：堆上新对象，与常量池无关
  → StringBuilder / StringBuffer：运行时拼接
```

所以当你再写 `String s = "hello"` 或 `s.intern()` 时，真正该记住的不是"String 不可变"或"intern 能省对象"，而是：**一个字符串的生命周期从编译期就开始了——常量折叠决定它是否被拼接，字面量驻留决定它是否被共享，`intern()` 决定它是否被永久保留，而 `+` 拼接是退到 `StringBuilder` 还是被折叠，全看操作数是不是编译期常量。**