# HashMap 的 key 为什么不能是可变对象？

> 适用：Java 技术专家 / 高级工程师面试
> 关联正文：`09-map-hash/01-hashmap-storage-hash`、`03-object-system/01-object-contract-references`
> 版本边界：下文引用的 `HashMap.java`、`Object.java` 行号均为 JDK 11 源码，不同版本可能不同。

## 题目

为什么 HashMap 建议用不可变对象做 key？如果一个可变对象作为 key 放进 HashMap，然后它的字段变了，会发生什么？

## 常见答法

> 因为可变对象作为 key，hashCode 会变，导致 HashMap 找不到原来的 key。

这个答法方向对，但只说对了"结果"，没讲透"机制"。真正的问题是：**HashMap 在 put 时按 hash 算了一次桶位、在 get 时按新的 hash 再算一次桶位，两次算到的位置很可能不一样，所以 key 就"丢了"——它还在数组里，但从业务视角再也拿不出来了。** 这里面有两条独立的契约在起作用，只答"hashCode 会变"会把它们混成一件事。

## 追问一：HashMap 是用 hashCode 定位，还是用 equals 定位？

> 答：先用 hashCode 找桶，再用 equals 确认。

对，这是关键。JDK 11 里，put/get 的第一步是 `hash(key)`（`HashMap.java:338`）加 `(n - 1) & hash`（`HashMap.java:566`、`:626`）定位桶，第二步才是桶内用 `equals` 确认是不是同一个 key。

所以：

- **hashCode 决定"你大概在哪个桶"**
- **equals 决定"桶里哪个是你要找的东西"**

如果 key 的 hashCode 变了，可能连"你大概在哪个桶"都换了，equals 根本来不及上场——这就是"值还在，但找不到了"的机制根源。

## 追问二：那你改完 key 字段后，那个 key 还在数组里吗？

> 答：还在，它在旧 hash 对应的桶里。

对。对象放在数组里并没有消失，只是它现在"应该待的位置"变了。新的 put 或 get 会按**变化后的 hash** 定位到另一个桶，于是旧的桶里那个 key 就"不可达"了。

这个补刀很关键，因为很多人会以为"key 改了以后就消失了"或者"会被 GC 掉"。实际上不会——它占着旧桶里的一个 Node，只是新查询再也够不到它，相当于一个"逻辑泄漏"的风险叠加在结构错位上。

## 追问三：那 equals 相等的对象 hashCode 一定相等吗？

> 答：必须相等，这是 Object 契约的一部分。

对。JDK 11 里 `Object.hashCode()`（`Object.java:109`）是 native，`equals`（`:157`）默认是引用比较。当你覆写 equals 时，契约强制你同时覆写 hashCode，保证 **equals 相等的对象 hashCode 必然相等**。这条契约保证了"hashCode 找桶"不会把 equals 应该相等的两个对象分到不同的桶。

所以不可变 key 的价值就在于：**从放进集合到取出集合，hashCode 和 equals 都不会变**——桶位置稳定，equals 语义稳定，整条定位链路永远可复现。

## 源码证据

- `hash(Object)`（`HashMap.java:338`）：对 key 做扰动
- `(n - 1) & hash`（`:566`、`:626`）：put 和 get 的桶位定位
- `Object.hashCode()`（`Object.java:109`）与 `equals`（`:157`）：equals/hashCode 契约的源头
- `HashMap` 桶内遍历用 equals 确认最终命中

## 一句话顿悟

**"key 不可变"保护的不是对象本身，而是"hashCode 定位桶 + equals 确认命中"这条链路的稳定性。** 可变 key 的问题不是"hashCode 会变"这一个事实，而是它同时破坏了桶位定位和 equals 确认两条契约——值还在，但无论是桶还是确认都找不回它。面试官真正想听的不是你会背"HashMap 建议不可变 key"，而是知道 put/get 的两步定位里，哪一步坏了的机制。