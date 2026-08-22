# Druid D-3 StatFilter SQL 监控 — note

## 本篇主张

- StatFilter 不是"额外加的统计代码"，而是 Filter 链骨架上的 Before/After 钩子
- `ParameterizedOutputVisitorUtils.parameterize()` 合并字面量实现参数化统计

## 本篇边界

- 不展开 WallFilter 安全规则
- 不展开 Parser 内部算法

## 下篇桥接

- D-6 将展开 SQL Parser 体系架构