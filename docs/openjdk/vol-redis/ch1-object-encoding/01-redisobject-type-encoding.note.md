# vol-redis R-1 redisObject 类型系统 — note

## 本篇主张

- `redisObject` 不是"存值的结构体"，而是 **类型-编码开关**：`type` 决定逻辑语义，`encoding` 决定物理布局。
- 同一个 `type` 可以有多种 `encoding`，编码选择是"内存 vs 性能"的运行时决策。
- `redisObject` 是所有数据结构卷的地基，R-3 到 R-10 每一种结构都是 `encoding` 字段的展开。

## 本篇边界

- 不展开 SDS 内部实现（R-4 覆盖）。
- 不展开具体数据结构的完整算法（R-3~R-10 覆盖）。
- 只在需要时点到编码升级路径。

## 下篇桥接

- R-4 SDS 将展开 String 编码的两种实际存储载体——SDS 字符串的 5 种 header、二进制安全与预分配策略。