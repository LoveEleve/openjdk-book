# 泛型方法、PECS 与类型推断：为什么 `? extends` 不能写，`? super` 不能读

> 基于 JDK 11 `java.util.Collection`（`Collection.java:490` 的 `addAll(Collection<? extends E>)`）、`java.util.Collections`（`Collections.java:178` 的 `sort` 签名、`:558` 的 `copy` 签名）以及 JLS 的通配符规则。本文讨论的是上界通配符（`? extends`）与下界通配符（`? super`）的读写限制、PECS 原则的推导，以及泛型方法中的类型推断行为。这些 API 签名是 JDK 11 可观测事实；PECS 原则是这些签名导出的设计规律，不是 JDK 源码的一部分。
> **前置依赖**：[泛型擦除、原始类型与数组协变](02-type-erasure-raw-array.md)
> → **后续**：按扩展计划进入反射性能或诊断工具专题

## 先看两个让人想不通的"泛型编译错误"

第一个错误：你写了一个 `List<? extends Number>`，想往里加一个 `Integer`，编译器报错。你的直觉是"`Integer` 是 `Number` 的子类，`? extends Number` 应该能接受它才对"。但编译器不同意，而且理由很具体：**`? extends` 表示"一种未知的具体类型，它可能是 Number 或其子类"，编译器不知道是哪一个，所以拒绝一切写入（除了 null）。**

第二个错误：你写了一个 `List<? super Integer>`，想从里取一个 `Integer` 出来赋值给 `Integer`，发现编译器返回的是 `Object`。直觉是"`? super Integer` 一定能装 Integer，拿出来应该也是 Integer"，但编译器不同意：**`? super` 表示"一种未知的具体类型，它可能是 Integer 或其父类"，编译器不知道是哪一个，所以只能保证拿到的是 `Object`。**

这两个错误背后是同一个规则：**通配符限制了"我往哪里放、我从哪里取"的权限，而权限的分配正是 PECS 原则在管理——Producer Extends（只读不写），Consumer Super（只写不读）。**

这里至少有三个失败方案。

第一种失败方案，是把 `? extends` 和 `? super` 当成"可以互换的声明方式"。它们不是"更灵活/更不灵活"的区别，而是"我负责读 / 我负责写"的职责分工。用错了方向，编译器就会报那些看似"莫名其妙"的错。

第二种失败方案，是以为泛型方法的类型推断"总能猜到我的意图"。类型推断是编译器根据实参类型和目标类型，在约束下推导出最具体的类型参数的过程。它不是你脑子里想的那个类型，而是"在约束下唯一能成立的类型"。

第三种失败方案，是以为 `? extends` 和 `<T extends>` 是一回事。前者是通配符（使用处），后者是类型参数边界（声明处），虽然限制效果相似，但约束位置不同。

所以这三个失败方案指向同一个顿悟：**PECS 不是"经验口诀"，而是 `? extends` 和 `? super` 在泛型容器的读写方法签名上自然导出的结果。`extends` 因为容器只能读（不能写），所以是 Producer；`super` 因为容器只能写（不能读），所以是 Consumer。**

## 一、`? extends` 为什么不能写：因为编译器不知道具体类型

### 上界通配符的行为

`List<? extends Number>` 表示"一个列表，其元素类型是 Number 或 Number 的某个子类，但具体是哪一个未知"。编译器知道它可能是 `List<Number>`、`List<Integer>` 或 `List<Double>`，但不知道是哪一个。

所以当你执行 `list.add(42)` 时，编译器会想：如果这个列表实际是 `List<Double>`，那 `42` 放进去就破坏了类型安全。因此，**除了 `null`，`? extends` 容器禁止一切写入。**

### 为什么读是安全的

读是安全的，因为不管容器实际是 `List<Number>`、`List<Integer>` 还是 `List<Double>`，你读出来的东西至少是 `Number`。所以 `? extends Number` 的 get 行为是：返回 `Number`。

这也是 `Collection.addAll(Collection<? extends E>)`（`Collection.java:490`）的设计原理——`addAll` 从源集合读元素，源集合是 `? extends E`，保证读出来的至少是 `E`，所以可以安全地添加到目标集合。

## 二、`? super` 为什么不能读：因为编译器不知道具体类型

### 下界通配符的行为

`List<? super Integer>` 表示"一个列表，其元素类型是 Integer 或 Integer 的某个父类，但具体是哪一个未知"。它可能是 `List<Integer>`、`List<Number>` 或 `List<Object>`。

所以写是安全的：你放一个 `Integer` 进去，不管实际列表是 `List<Integer>`、`List<Number>` 还是 `List<Object>`，`Integer` 都能被接受。

但读就不安全了：如果实际是 `List<Number>`，读出 `Number` 没问题；但如果实际是 `List<Object>`，读出 `Object` 不一定能赋值给 `Integer`。所以编译器保守地返回 `Object`——唯一能保证的类型。

### 典型应用：`Comparator<? super T>`

`Collections.sort(List<T> list, Comparator<? super T> c)`（`Collections.java:178`）的签名是 PECS 的经典应用。`Comparator` 是"消费"元素来比较的，所以是 Consumer，用 `? super T`。这意味着你给 `List<Integer>` 排序时，既可以用 `Comparator<Integer>`，也可以用 `Comparator<Number>`——因为 `Comparator` 是 Consumer，只要能消费 Integer 就行。

到这里，上界和下界各自的读写规则已经讲清了。接下来看 JDK 里一个同时用两种通配符的真实签名——它把 PECS 的两半直接摊在一行里。

## 三、PECS 在 JDK 中的实际证据：`Collections.copy`

### `copy` 的签名同时展示了 Producer 和 Consumer

`Collections.copy(List<? super T> dest, List<? extends T> src)`（`Collections.java:558`）把源集合的元素复制到目标集合。这里：

- `src` 是 Producer，只读不写，所以用 `? extends T`
- `dest` 是 Consumer，只写不读，所以用 `? super T`

这个签名正是 PECS 原则最直接的教材：**一个方法同时使用 `? extends` 和 `? super`，分别对应"从哪里读"和"往哪里写"。** 把这行签名看懂，PECS 就不需要背了。

到这里，通配符在读写上的分工已经讲透。接下来换一个角度：当类型参数不是写在占位符里、而是出现在泛型方法自己的声明里时，编译器是怎样帮你推断的。

## 四、泛型方法的类型推断：编译器不是猜谜，它是填空

### 泛型方法的类型参数由调用点推断

当你调用 `Collections.emptyList()` 时，如果没有给目标类型，编译器会推断为 `List<Object>`。如果你把结果赋值给 `List<String> strings = Collections.emptyList()`，编译器会根据目标类型推断为 `String`。

类型推断不是"猜你想输入什么"，而是在"实参类型"和"目标类型"的约束下，找到唯一满足所有约束的类型参数。

### 菱形 `<>` 与目标类型

`List<String> list = new ArrayList<>()` 的菱形 `<>` 让编译器根据左侧的目标类型推断类型参数为 `String`。但如果写成 `var list = new ArrayList<>()`，在 JDK 11 里，编译器会推断为 `ArrayList<Object>`——因为左侧没有目标类型，只有 `var` 本身的类型推断。

所以菱形不是"让编译器猜"，而是"让编译器根据上下文填空"。上下文越充分，推断越精确；上下文不足，就退到 `Object`。

## 五、通配符与类型参数边界的区别

`? extends Number`（通配符，使用处）和 `<T extends Number>`（类型参数边界，声明处）不是一回事。前者用在方法签名中，表示"这个位置可以接受任何 Number 子类"，后者用在类型参数声明时，限制 T 必须是 Number 的子类。

通配符适合"一次使用"的场景——你只在方法签名里用一次，不需要给这个类型取名字。类型参数边界适合"多次引用"的场景——你需要在整个类或方法里多次引用 T。

一个直观的取舍是：如果方法体里只有一处用到这个未知类型，`? extends` 就够；如果要在多个参数、返回值、方法体内部反复引用同一个类型，就必须换成 `<T extends>` 并给它命名。这也是为什么工具方法偏通配符、容器类偏类型参数的原因。

## 五个最容易混掉的边界：`? extends` 不能写因为不知道具体类型，`? super` 不能读因为不知道具体类型，PECS 不是背口诀而是看签名，类型推断不是猜谜而是填空，通配符不是类型参数

第一，`? extends` 不能写，因为编译器不知道容器的具体子类型是什么。它不是"限制了写入"而是"因为不知道具体类型所以只能什么都不写"。

第二，`? super` 不能读，因为编译器不知道容器的具体父类型是什么。它不是"限制了读取"，而是"因为不知道具体类型所以只能保守返回 Object"。

第三，PECS 不是背口诀。`Collections.copy(List<? super T>, List<? extends T>)` 的签名本身就展示了 Producer 和 Consumer 分别对应的通配符；看懂这个签名，比背"Producer Extends, Consumer Super"八个字更可靠。

第四，类型推断不是猜谜。编译器根据实参类型和目标类型做约束求解，不是"猜你想要什么"。菱形 `<>` 依赖上下文推断，上下文越明确推断越精确。

第五，`? extends Number`（通配符）和 `<T extends Number>`（类型参数边界）不是一回事。前者是使用处的占位，后者是声明处的约束；两者不能互换。

把这五条边界记稳，泛型通配符就不会再被简化成"extends 只读、super 只写"的机械记忆口诀。它真正想讲的是：`? extends` 和 `? super` 的行为不是"Java 故意限制你"，而是"编译器在不知道具体类型时的保守策略"——`extends` 保守到只读不写，`super` 保守到只写不读，两者合在一起，正好覆盖了"读数据的一方用 extends，写数据的一方用 super"的全部分工。

## 收网：`Collections.copy` 的签名就是 PECS 最好的教材

回到开头两个错误，现在能看清它们为什么是强制性的了。

`List<? extends Number>` 不能写，因为编译器不知道它是 `List<Integer>`、`List<Double>` 还是 `List<Number>`，任何具体类型的写入都可能破坏未知类型的安全。`List<? super Integer>` 不能读，因为编译器不知道它是 `List<Integer>`、`List<Number>` 还是 `List<Object>`，读出 `Object` 是最保守的选择。

把整篇压成一张总图：

```text
? extends T（Producer）
  → 容器可能是 T 或 T 的某个子类
  → 读：至少是 T，安全
  → 写：不知道具体子类型，禁止（仅 null 除外）

? super T（Consumer）
  → 容器可能是 T 或 T 的某个父类
  → 写：T 一定能放入，安全
  → 读：最多是 Object，不安全

PECS 的 JDK 证据
  → Collections.copy(List<? super T> dest, List<? extends T> src)
  → src 是 Producer，用 extends
  → dest 是 Consumer，用 super

类型推断
  → 菱形 <> 根据目标类型推断
  → 无上下文时退到 Object
```

所以当你再看到 `? extends` 或 `? super` 的编译报错时，真正该问的不是"我能不能用强制转换绕过"，而是：**这个位置是生产者还是消费者？生产者从容器读，用 `extends`；消费者往容器写，用 `super`。违反这个分工，报错就是编译器在保护类型安全，而不是在跟你作对。**