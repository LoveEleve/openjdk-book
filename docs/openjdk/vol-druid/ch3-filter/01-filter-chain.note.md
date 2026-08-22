# Druid D-2 Filter 链 — note

## 本篇主张

- HikariCP 没有 Filter 链，Druid 用递归链做扩展点
- `pos/filterSize/nextFilter()` 构成递归推进
- `createChain()` / `recycleFilterChain()` 实现链复用

## 本篇边界

- 不展开 StatFilter / WallFilter 的具体实现

## 下篇桥接

- D-3 和 D-4 将展开 StatFilter 和 WallFilter