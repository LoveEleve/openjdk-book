# Druid D-5 shrink 维护体系 — note

## 本篇主张

- `shrink()` 一个方法管四件事，不是"清偿空闲连接"
- DestroyTask 和 CreateConnectionTask 是两条独立后台线路

## 本篇边界

- 不展开连接验证细节
- 不展开 Filter 链

## 下篇桥接

- D-7 将展开连接验证