# 为什么 ConcurrentHashMap 的 value 不能为 null？

> 适用：Java 技术专家 / 高级工程师面试
> 关联正文：`10-concurrent-collections/01-chm-storage-rw`
> 版本边界：下文引用的 `ConcurrentHashMap.java` 行号均为 JDK 11 源码，不同版本可能不同。

## 题目

ConcurrentHashMap 为什么不允许 value 为 null？HashMap 明明允许 null value，为什么 CHM 不行？

## 常见答法

> 因为 CHM 不允许 value 为 null，否则会导致二义性——`get` 返回 null 时无法区分 key 不存在还是 value 就是 null。

这个答法方向对，但只说了一半。真正的关键不只是"无法区分"，而是"**在并发下即使想区分也区分不了**"。HashMap 允许 null value，是因为它是单线程的，可以先用 `containsKey` 判断再用 `get` 取，中间不会有别的线程插入。CHM 是并发的，即使你用 `containsKey` 判断了，另一个线程也可能在中间插入/删除，导致判断结果失效。

## 追问一：HashMap 为什么就不需要禁 null？它不是也有同样的二义性吗？

> 答：HashMap 是单线程的，可以先 containsKey 再 get，中间不会被别的线程插入，所以可以区分。

对。HashMap 允许 null value，因为它可以在同一线程里先 `containsKey(key)` 看看 key 在不在，再决定 `get(key)` 返回的 null 是"不存在"还是"值为 null"。这个判断和取值之间没有其他线程会改哈希表，所以结果是可靠的。

但 CHM 不行。即使你写了：

```java
if (map.containsKey(key)) {
    value = map.get(key);   // 可能返回 null
}
```

在 `containsKey` 和 `get` 之间，另一个线程可能正好把这个 key 删了。于是你的判断说"在"，`get` 却返回 null——这个 null 到底是"被删了"还是"本来 value 就是 null"？无法确定。

## 追问二：那为什么只禁 value，不禁 key？

> 答：key 为 null 会导致 spread(hashCode) 报 NPE，这是实现层面问题；而 value 为 null 会在查询结果上引入歧义，这是语义层面问题。两者被禁的原因不同。

对。key 为 null 被禁是因为 `spread(key.hashCode())`（`ConcurrentHashMap.java:1011`）会对 null 调 `hashCode()`，直接抛 NPE——这是实现层面必须禁。

而 value 为 null 被禁是为了避免"查询结果 null 的含义歧义"。value 不存在时 `get` 返回 null 作为默认信号已经够用；如果 value 也可以是 null，那 null 就从"没找到"变成"要么没找到要么找到了个 null"，歧义就出现了。

## 追问三：那有没有设计上的后果？比如想存 null 值怎么办？

> 答：需要用包装或哨兵。比如用 Optional、自定义 NullObject、或者明确约定"存一个特殊哨兵对象表示 null"。

对。CHM 禁 null 的代价就是：如果业务真的需要"key 存在但 value 为空"这个语义，必须自己处理。常见做法有：

- 用 `Optional<T>` 作为 value，空值存 `Optional.empty()`
- 用约定好的哨兵对象（如 `private static final Object NULL_SENTINEL = new Object()`）代替 null
- 用 `containsKey` 明确语义（但要注意 CHM 的弱一致性，containsKey 也可能不是实时准确）

## 源码证据

- `putVal` 开头 `if (key == null || value == null) throw new NullPointerException()`（`ConcurrentHashMap.java:1011`）：put 时直接禁 null
- `containsValue(Object value)` 开头同样拒绝 null（`:975-985`）：连 containsValue 也禁，避免 null 值二义性
- 对比 HashMap：允许 null value，因为单线程可以先 containsKey 再 get

## 一句话顿悟

**CHM 禁 null value 的根本原因是并发下的歧义不可消除——`get` 返回 null 在单线程里可以用 containsKey 排除，但在并发下 containsKey 和 get 之间随时可能被别的线程修改，这条判断不可靠。** 面试官真正想听的不是你会背"CHM 禁 null"，而是你知道"并发的关键不是 null 本身，而是'先查再取'这条序列在并发下不可原子化"。