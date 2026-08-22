# 为什么 `HashSet` 本质上是 `HashMap`？

> 适用：Java 技术专家 / 高级工程师面试
> 关联正文：`08-collections/04-hashmap-linkedhashmap`
> 版本边界：下文引用的 `HashSet.java` 行号均为 JDK 11 源码，不同版本可能不同。

## 题目

为什么总有人说 `HashSet` 其实只是 `HashMap` 的一层壳？它明明是 Set，没有 key-value，为什么底层还要用 Map？

## 常见答法

> 因为 `HashSet` 底层就是 `HashMap`，把元素当 key，value 用一个固定对象占位。

这个答法方向对，但还差关键一点：**Set 想解决的核心问题，本来就是“某个元素在不在、能不能快速去重”，这和 Map 按 key 查找的能力天然同构。** `HashSet` 不是“懒得自己实现”，而是它真正需要的能力——哈希定位、判重、扩容、冲突处理——`HashMap` 已经完整提供了。

## 追问一：源码上它到底怎么复用 `HashMap`？

> 答：内部直接持有一个 `HashMap<E, Object>`，元素放 key，value 永远是同一个占位对象。

`HashSet` 里直接有一个字段：`private transient HashMap<E,Object> map`（`HashSet.java:96`）。同时它还定义了一个固定占位值 `PRESENT`（`:99`）。

所以 `add(e)`（`HashSet.java:219-220`）本质上就是 `map.put(e, PRESENT) == null`；`contains(o)`（`:203-204`）本质上就是 `map.containsKey(o)`；`remove(o)`（`:235`）也只是转成对 map 的删除。

也就是说，**HashSet 没有自己再发明一套“判重结构”，而是直接把 Set 元素映射成 Map 的 key。**

## 追问二：那为什么 value 可以随便放个占位对象？

> 答：因为 Set 根本不关心“值是什么”，它只关心“key 存不存在”。

Map 的世界里，每个 key 必须对应一个 value；Set 的世界里，只要知道元素存不存在就够了。于是 `HashSet` 选了最简单的办法：**把所有 value 都统一指向同一个哑元对象 `PRESENT`。**

这个设计说明得很直白：`HashSet` 复用 `HashMap`，只是借它的 key 管理能力，根本不消费 value 语义。value 在这里不是业务数据，只是让 `HashMap` 这个底层结构能跑起来的技术占位。

## 追问三：那 `HashSet` 和直接 `HashMap<K, Boolean>` 有什么差别？

> 答：语义更清晰，接口更小，也避免了把“占位值”暴露给调用方。

如果你自己用 `HashMap<K, Boolean>` 模拟 Set，确实也能做。但 `HashSet` 把这种模式标准化了：

- 对外暴露的是 Set 语义，不是 key-value 语义
- 调用方不用关心占位 value
- 底层实现仍然直接复用 `HashMap` 的哈希桶、扩容、树化、判重逻辑

所以 `HashSet` 的价值不是“它有一套不同的数据结构”，而是：**它把 Map 的 key-only 用法封装成了更准确的抽象。**

## 源码证据

- `HashMap<E,Object> map`（`HashSet.java:96`）：底层实际存储结构
- `PRESENT`（`:99`）：统一占位值
- `contains(o)`（`:203-204`）：直接走 `map.containsKey(o)`
- `add(e)`（`:219-220`）：直接走 `map.put(e, PRESENT)`
- `remove(o)`（`HashSet.java:235`）：删除也是委托给 map

## 一句话顿悟

**`HashSet` 本质上就是“只用 key、不关心 value 的 `HashMap` 包装层”。** 面试官真正想听的不是你会背"底层是 HashMap"，而是你知道 Set 的需求和 Map 的 key 查找能力为什么天然同构，以及 `PRESENT` 这种设计是在把“key-only”语义封装成更准确的 API。