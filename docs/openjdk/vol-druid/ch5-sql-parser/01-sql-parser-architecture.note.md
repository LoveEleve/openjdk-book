# Druid D-6 SQL Parser 架构 — note

## 本篇主张

- Druid 自建解析器不是"不会用现成工具"，而是需求更重
- 解析管道：Lexer → Parser → AST → Visitor → dialect
- 解析器是 StatFilter 和 WallProvider 的共同地基

## 本篇边界

- 不深入 Lexer / Token / AST 生成算法，控制在概览范围

## 下篇桥接

- D-4 将展开 WallFilter 如何利用解析器实现安全检查