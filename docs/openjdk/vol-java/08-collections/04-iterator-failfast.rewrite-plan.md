# 08-collections/04 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `Iterable`、`AbstractList`、`ArrayList`。本文聚焦增强 for、迭代器状态机、`modCount` / `expectedModCount`、`iterator.remove()` 与 fail-fast 语义；并发容器只作对照，不展开内部实现。
> 目标：把“迭代器与 fail-fast”改写成一篇围绕“为什么遍历时修改会抛 `ConcurrentModificationException`，以及为什么这不是并发安全保证”的机制文章，并顺带把增强 for 的底层、`iterator.remove()` 的知情同步和 `subList` 的联动检查讲清楚。

## 1. 读者困惑

- 为什么 `for (E e : list) list.remove(e)` 经常抛 `ConcurrentModificationException`？
- 迭代器为什么知道集合被改了？它记录的到底是什么？
- 为什么 `set` 往往没事，`add/remove/clear` 却容易触发 fail-fast？
- 为什么 `iterator.remove()` 安全，而 `list.remove()` 常常不安全？
- fail-fast 是线程安全机制吗，还是只是调试友好机制？
- `subList()` 背后为什么也会跟着检查 `modCount`？
- 增强 for、`Iterable.forEach`、`Iterator` 三者到底是什么关系？

## 2. 一句话顿悟

**fail-fast 的核心不是“阻止并发修改”，而是“让迭代器带着一份结构版本快照往前走”；只要外部结构被改，快照失配就尽早抛异常。`iterator.remove()` 之所以安全，不是因为它更强，而是因为它是知情修改者，能在修改后把自己的快照同步过去。**

## 3. 旧稿优点与问题

### 保留

- 已覆盖 `modCount`、`expectedModCount`、`checkForComodification()`、`Itr.remove()`。
- 已明确“结构性修改才计数，`set` 不算”的关键语义。
- 已有 fail-fast vs fail-safe 的对照和并发容器边界提醒。

### 必须重写

- 旧稿太像概念拆分，开头应先用“增强 for 删除元素为什么炸”作为主问题，把读者拉进状态机。
- `Iterable` / 增强 for / `Iterator` 的关系要更具体；不仅要说“会编译成迭代器”，还要用源码契约把 `Iterable` 放进去。
- `modCount` 需要强调它统计的是结构版本，不是线程同步版本。
- `iterator.remove()` 要讲成“知情修改 + 快照回填”的完整过程，而不是只记一句 `expectedModCount = modCount`。
- 可补入 `subList` 的 `modCount` 联动，帮助读者理解 fail-fast 是视图级一致性保护，而不只是单个迭代器技巧。

## 4. 理解路径

### 第一节：从最常见的崩溃场景开场

用：

```java
for (String s : list) {
    list.remove(s);
}
```

先提出错觉：我明明删的是当前元素，为什么集合不让我删？

主线：问题不在“能不能删”，而在“谁在负责遍历状态”。

### 第二节：增强 for 为什么最终落到迭代器

证据：
- `Iterable.java:34-48`：实现 `Iterable` 才能成为增强 for 目标，核心是 `iterator()`
- `Iterable.java:50-77`：默认 `forEach` 也表现得像 `for (T t : this)`

主线：
- 增强 for 并不是语法糖直接操作数组下标；对集合来说，它最终依赖 `iterator()`。
- 这为后面的 fail-fast 铺路：真正携带遍历状态的不是 for 语句，而是迭代器对象。

### 第三节：`modCount` 记录的到底是什么

证据：
- `AbstractList.java:357-361`：`expectedModCount` 注释可辅助理解
- `AbstractList` 中 `modCount` 字段的精确位置需要重读更靠前区域补齐
- `ArrayList.java:497-500`：`add` 增加 `modCount`
- `ArrayList.java:669-674`：`fastRemove` 增加 `modCount`
- `ArrayList.java:1081-1090`：`set` 路径可作为“不增加结构版本”的对照

主线：
- `modCount` 统计结构性修改：增删、清空、影响遍历结构的变化。
- 它不是锁，不保证原子性，也不为多线程建立内存可见性协议。
- `set` 不改变元素个数与遍历骨架，因此通常不算结构修改。

### 第四节：迭代器为什么能发现违规修改

证据：
- `AbstractList.java:354-361`：`lastRet` / `expectedModCount`
- `AbstractList.java:367-399`：`next()` + `checkForComodification()`

主线：
- 迭代器内部不仅有 `cursor`，还有 `expectedModCount` 快照。
- 每次 `next()` 前先比对当前 `modCount` 与快照；一旦失配就抛 `ConcurrentModificationException`。
- fail-fast 的哲学是“尽早暴露遍历结构已经不可信”，而不是“修复它”。

### 第五节：为什么 `iterator.remove()` 安全

证据：
- `AbstractList.java:381-395`：`remove()`
- `ArrayList.java:1093-1104`：`ListItr.add`
- `AbstractList.java:433-457`：`ListItr.set/add`

主线：
- 迭代器自己的 `remove()` 先校验，再委托外部列表修改，最后把 `expectedModCount = modCount` 同步回来。
- 这里真正重要的是“知情修改”：负责遍历状态的对象，亲自参与了结构修改，所以能修正自己的状态机。
- 外部直接 `list.remove()` 时，迭代器没有收到这次结构变化的正式通知，因此下次校验只能认为状态已失真并抛错。

### 第六节：fail-fast 不是并发安全，它只是尽早报警

证据：
- `Iterable.java:57-60`：默认 `forEach` 对修改底层源的行为是 unspecified
- 旧稿保留对 `CopyOnWriteArrayList` / `ConcurrentHashMap` 的对照，但无需展开源码

主线：
- fail-fast 既能由同线程错误用法触发，也可能由其他线程结构修改触发。
- 但它不是严格并发控制协议；即便有 `modCount`，非线程安全集合在并发修改下仍是未定义行为。
- 并发容器的弱一致/快照语义是另一套设计，不是 fail-fast 的加强版。

### 第七节：为什么 `subList` 也要跟着检查 `modCount`

证据：
- `ArrayList.java:1128-1133`：`subList` 语义注释
- `ArrayList.java:1151-1157`：SubList 构造时保存 `modCount`
- `ArrayList.java:1178-1186`：`get/size` 中 `checkForComodification()`
- `AbstractList.java:487-489`：子视图方法也检查 backing list 的 `modCount`

主线：
- fail-fast 保护的不只是单个迭代器，也包括“视图仍然建立在同一份结构上”的假设。
- `subList` 之所以危险，正是因为它是共享视图；一旦 backing list 在别处结构变化，视图中的索引和边界都可能失真。

### 第八节：收束到正确实践与下一篇

- 遍历删元素：`iterator.remove()` / `removeIf()` / 倒序删
- 遍历改值：通常可行，但要理解是否触发结构变化
- 并发遍历：换并发容器，不要指望 fail-fast 兜底

自然引到 `Arrays` 和排序工具。

## 5. 失败方案清单

1. 在增强 for 中直接调用 `list.remove(e)`。
2. 把 `modCount` 当成线程安全机制或锁。
3. 以为 `set`、`replace`、`sort` 等所有改动都会必然触发相同的 fail-fast 路径。
4. 用 `iterator.remove()` 前先连续两次 `remove()`，忽略 `lastRet` 状态机。
5. 以为“不抛 CME”就代表并发场景安全。
6. 对 `subList` 和原列表交叉结构修改，却期待视图仍然可靠。
7. 把 `Iterable.forEach` 误解成绕过迭代器的全新机制。

## 6. 误解清单

1. `ConcurrentModificationException` 一定意味着多线程并发。
2. fail-fast 的目标是修复遍历，而不是尽早报错。
3. 迭代器 remove 不抛异常，是因为它偷偷关闭了检查。
4. `modCount` 统计的是所有字段变化。
5. 增强 for 直接操作集合本体，不依赖 `Iterator`。
6. `subList` 只是复制出来的一段新列表，与原列表无关。
7. fail-safe 比 fail-fast 更正确；它只是换了一种一致性取舍。

## 7. 证据清单

- `Iterable.java:34-48`：增强 for 依赖 `iterator()`
- `Iterable.java:57-77`：默认 `forEach` 的等价语义
- `AbstractList.java:354-361`：`lastRet` / `expectedModCount`
- `AbstractList.java:367-399`：`next()` / `remove()` / `checkForComodification()`
- `AbstractList.java:433-457`：`ListItr.set/add`
- `AbstractList.java:487-489`：`subList` 方法也检查 backing list 的 `modCount`
- `ArrayList.java:497-500`：`add(E)` 结构修改
- `ArrayList.java:669-674`：`fastRemove`
- `ArrayList.java:1081-1090`：`set(E)` 不涉及结构变化
- `ArrayList.java:1128-1133`：`subList` 注释中的结构修改语义
- `ArrayList.java:1151-1157`：`SubList` 记录 `modCount`
- `ArrayList.java:1178-1186`：`SubList.get/size` 检查

## 8. 版本与边界

- 基于 JDK 11。
- 不在本文展开 `HashMap` 的 fail-fast 细节，先用 `AbstractList` / `ArrayList` 建立心智。
- 不展开 `CopyOnWriteArrayList`、`ConcurrentHashMap` 的源码，只做 fail-safe / 弱一致对照。
- 不做字节码反编译展示，增强 for 只从 `Iterable` 契约与迭代器责任角度解释。

## 9. 删除代码测试与最终验收标准

- 删除源码块后，读者仍能复述“增强 for 依赖 iterator → 迭代器保存 expectedModCount → 结构修改导致快照失配 → iterator.remove 是知情修改并回填快照 → fail-fast 只是尽早报错，不是并发安全 → subList 也依赖同一结构版本”。
- 必须明确 `modCount` 的作用边界：结构版本，不是并发控制。
- 必须把 `iterator.remove()` 与 `list.remove()` 的差异讲成‘谁在维护遍历状态机’。
- 必须说明 `subList` 的 fail-fast 检查与共享视图语义相关。
- 结尾要自然引到 `05-arrays-sort.md`。
