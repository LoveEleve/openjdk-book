# 值传递、装箱拆箱与对象身份：为什么 `100 == 100` 为 true，`200 == 200` 却为 false

> 基于 JDK 11 `java.lang.Integer`、`IntegerCache` 与 JLS 的值传递与装箱规则。本文讨论的是 Java 的值传递语义、自动装箱/拆箱的编译期行为，以及包装类缓存机制对 `==` 比较的影响。值传递是 JLS 语义，装箱拆箱由 javac 插入对 `valueOf`/`intValue` 的调用，`IntegerCache` 的具体缓存范围是 JDK 11 实现事实。
> **前置依赖**：[泛型擦除、原始类型与数组协变](02-type-erasure-raw-array.md)
> → **后续**：按扩展计划进入下一批生产实践或面试专题

## 先看一个面试里几乎必问、但总有人答不全的现象

```java
Integer a = 100;
Integer b = 100;
System.out.println(a == b);   // true

Integer c = 200;
Integer d = 200;
System.out.println(c == d);   // false
```

同一段代码，只改了数值，`==` 的结果就完全不同。很多人第一反应是"100 在某个范围内，200 不在"。这句话离正确答案只差两层：**为什么 100 和 200 在这里不是 int，而是 Integer；为什么同一个 Integer 值，有的能被复用，有的不能。**

这里至少有三个失败方案。

第一种失败方案，是把 `==` 当成"比较值相等"的通用操作。`==` 对基本类型比较的是数值，对引用类型比较的是对象身份。`Integer` 是引用类型，`a == b` 问的是"这两个变量是不是指向同一个 Integer 对象"，而不是"它们的数值是否相等"。

第二种失败方案，是把 `Integer a = 100` 理解成"直接把 100 赋值给一个 Integer 对象"。这行代码其实是 `Integer a = Integer.valueOf(100)`，javac 插入了一个自动装箱调用。`valueOf` 在 JDK 11 里会检查参数是否在缓存范围内，如果在就返回缓存对象，不在就 `new Integer`。所以 100 走缓存、200 不走缓存，原因不在 `==`，而在 `valueOf` 的实现。

第三种失败方案，是把"值传递"和"引用"当成两个对立的概念，以为 Java 对基本类型是值传递、对对象是引用传递。实际上 Java 全是值传递——你把引用类型变量传给方法时，传的是"引用的副本"，不是对象本身，也不是对象的引用传递。搞清楚什么叫"值就是引用的一份拷贝"，才能看懂为什么方法里改引用和改对象字段的效果不一样。

所以这三个失败方案指向同一个顿悟：**`Integer a = 100` 这行代码里同时发生了四件独立的事——值传递语义、自动装箱语法糖、`Integer.valueOf` 方法调用、`IntegerCache` 缓存机制。把它们混成一个"`==` 比较包装类"的问题，就永远只能背答案，不能推导。**

## 一、值传递：Java 里没有"引用传递"，只有"值的副本"

### 值传递说"形参得到的是实参的一份拷贝"

Java 的方法调用，形参接收的永远是实参的一份拷贝。对基本类型，拷贝的是数值本身。对引用类型，拷贝的是引用值（即内存地址）。

所以：

```java
void change(int x) {
    x = 10;          // 只改了形参副本，不影响实参
}

void changeRef(StringBuilder sb) {
    sb.append("x");  // 改的是副本指向的那个对象，所以原对象也变了
    sb = null;       // 只改了副本引用，不影响实参
}
```

第一个 `change` 里 `x = 10` 不会影响调用方的变量，因为传递的是数值的副本。第二个 `changeRef` 里 `sb.append("x")` 会影响调用的对象，因为副本指向的是同一个对象；但 `sb = null` 不会影响调用方的引用，因为改的是副本本身。这就是"值传递"的全部含义——**副本指向的对象可以改，但副本指向谁不受调用方控制。**

### 这道题常被误报成"Java 有引用传递"

这个误解的来源是：方法参数是引用类型时，你确实能通过它修改对象状态。这看起来像引用传递，但实际只是"副本指向同一个对象"的结果。真正的"引用传递"应该是形参能直接改变实参指向的变量，这在 Java 里不存在。

## 二、自动装箱：`Integer a = 100` 到底发生了什么

### javac 插入了 `Integer.valueOf(100)`

`Integer a = 100` 不是直接赋值，而是 javac 在编译期把它替换成 `Integer a = Integer.valueOf(100)`。同样地，`int b = a` 会被替换成 `a.intValue()`。

这条规则由 JLS 定义，javac 执行。所以 `Integer a = 100` 本质上是一个方法调用，不是纯粹的"用 int 初始化一个 Integer 引用"。

### 为什么这对面试题很重要

因为 `==` 比较的是对象身份，而 `Integer a = 100` 和 `Integer b = 100` 是两个独立的赋值语句，分别调用了两次 `Integer.valueOf(100)`。如果 `valueOf` 每次都返回新对象，`a == b` 就是 false。但 JDK 11 的 `valueOf` 对 100 使用了缓存，两次返回同一个对象，所以 `a == b` 是 true。

换句话说，`a == b` 是 true 不是"因为 `Integer` 比较特殊"，而是因为 **`valueOf` 的缓存机制让两个赋值指向了同一个对象**。

到这里，值传递和自动装箱已经讲清了。接下来这一节回答第三个问题：缓存到底是怎么实现的，范围有多大，能不能改。

## 三、`IntegerCache`：为什么能缓存，缓存到多少

### 缓存范围是 JDK 11 实现细节

`IntegerCache` 是 `Integer` 里的一个静态内部类（`Integer.java:997`），它的 `low` 固定为 `-128`（`Integer.java:998`），`high` 默认是 `127`（`Integer.java:1001`），但可通过系统属性 `java.lang.Integer.IntegerCache.high` 调整上限。

`valueOf(int i)` 的代码（`Integer.java:1056`）直接体现了这个缓存策略：

```java
public static Integer valueOf(int i) {
    if (i >= IntegerCache.low && i <= IntegerCache.high)
        return IntegerCache.cache[i + (-IntegerCache.low)];
    return new Integer(i);
}
```

所以 `Integer.valueOf(100)` 返回缓存对象，`Integer.valueOf(200)` 返回 `new Integer(200)`。

到这里，缓存的机制和范围已经讲清了。最后一节把问题拉回 `==` 和 `equals` 的分工，回答"到底什么时候该用哪个"。

### 面试题里"100 和 200"的边界

这道题之所以选 100 和 200，是因为它们分别落在缓存范围内和范围外。如果面试题换成了 `-128` 和 `-129`，原理一样：`-128` 在缓存内，`-129` 在外。如果换成 `127` 和 `128`，结果也是 `127 == 127` 为 true、`128 == 128` 为 false。知道缓存范围公式，就能推导任何数值，不需要背具体数字。

### `LongCache` 有相同规则

`Long.valueOf(long)` 的缓存范围也是 `-128` 到 `127`，与 `Integer` 一致。`Short` 也是。`Byte` 整个范围都不超出 `-128` 到 `127`，所以所有 Byte 缓存。`Double` 和 `Float` 不缓存，每次 `valueOf` 都返回新对象。

## 四、`==` 与 `equals`：什么时候该用哪个

### 包装类场景下，`==` 比较的是身份，不是值

`Integer a = 100; Integer b = 100; a == b` 为 true，是因为缓存让它们指向同一个对象。`Integer c = 200; Integer d = 200; c == d` 为 false，是因为 200 不在缓存，`valueOf` 新建了两个对象。

任何需要判断数值是否相等的地方，都应该用 `equals` 或 `intValue()` 比较，而不是 `==`。`Integer.equals` 比较的是内部的 `int value` 字段，与对象身份无关。

### 为什么 `new Integer(100) == new Integer(100)` 永远是 false

`new Integer(100)` 不管数值是多少，都跳过 `valueOf` 直接创建新对象。所以两个 `new` 出来的 `Integer(100)` 永远是不同对象，`==` 永远是 false。这也是面试里常被追问的变体：把 `Integer a = 100` 换成 `new Integer(100)`，结果就变了。

## 五个最容易混掉的边界：值传递不是引用传递，自动装箱不是直接赋值，缓存不是 `Integer` 专属，`==` 不是值比较，`new Integer` 不走缓存

第一，值传递不是引用传递。Java 只有值传递，形参永远是实参的副本；副本指向的对象状态可以改，但副本自身被改不影响实参。误以为"Java 有引用传递"，会在方法参数设计上绕弯路。

第二，自动装箱不是直接赋值。`Integer a = 100` 编译后是 `Integer a = Integer.valueOf(100)`，这不是"int 到 Integer 的隐式转换"，而是 javac 插入的方法调用。明白这一点，才看得懂缓存和 `new` 的区别。

第三，缓存不是 `Integer` 专属。`Long`、`Short`、`Byte` 的 `valueOf` 都有 `-128` 到 `127` 的缓存，`Double` 和 `Float` 没有。面试题把 `Integer` 换成 `Long` 结果一样，但换成 `Double` 就不同。

第四，`==` 不是值比较。引用类型上 `==` 比较的是对象身份，不是数值。包装类需要数值比较时，必须用 `equals` 或 `intValue()`。

第五，`new Integer` 不走缓存。`new Integer(100)` 每次创建新对象，不管数值是否在缓存范围内。`==` 比较永远为 false。面试里追问"如果用 `new` 会怎样"，就是在考察"`valueOf` 和 `new` 是两条完全不同的构造路径"。

把这五条边界记稳，`Integer ==` 的面试题就不再需要背答案。它真正想考察的是：值传递的语义、自动装箱的语法糖、`IntegerCache` 的实现细节，以及 `==` 和 `equals` 的分工——四件独立的事在一行代码里相遇，相遇的结果正好是那组 "100 为 true, 200 为 false" 的数字。

## 收网：`Integer a = 100` 不是一行简单的赋值，而是四层机制的一次相遇

回到开头那道题，`Integer a = 100` 和 `Integer b = 100` 这两行代码，各自经历的是：

1. 值传递语义：`a` 和 `b` 各自持有 Integer 引用的副本
2. 自动装箱：javac 把 `100` 编译成 `Integer.valueOf(100)`
3. `IntegerCache`：`valueOf` 检查 100 在缓存范围内，返回缓存对象
4. `==` 比较：比较的是两个引用是否指向同一个对象

`100` 和 `200` 的区别，只在于第 3 步：`IntegerCache` 的范围是 `-128` 到 `127`，`200` 不在此范围，`valueOf` 返回 `new Integer(200)`，两个新对象不相等。

把整篇压成一张总图：

```text
Integer a = 100
  → 不是 Integer a = 100
  → 而是 Integer a = Integer.valueOf(100)
  → valueOf 检查缓存：-128..127 → 返回缓存对象
  → 两个 100 指向同一个缓存对象 → a == b 为 true

Integer c = 200
  → 200 不在缓存范围
  → valueOf 返回 new Integer(200)
  → 两个 200 指向不同对象 → c == d 为 false
```

所以当你再看到 `Integer ==` 的面试题时，真正该记住的不是"100 和 200 的边界"，而是从这行代码里读出四层信息：值传递语义、自动装箱语法糖、`valueOf` 方法调用、`IntegerCache` 缓存范围。能拆到这四层，就不需要背任何边界数字。