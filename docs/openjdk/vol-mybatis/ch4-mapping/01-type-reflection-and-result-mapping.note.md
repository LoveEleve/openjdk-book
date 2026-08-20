# M-7 类型处理、反射映射与结果装配 — note

## 本篇主张

- `TypeHandlerRegistry`、`Reflector`、`MetaObject`、`DefaultResultSetHandler` 共同构成对象图装配协议。
- 结果映射不是“反射 set 值”，而是值语义、属性语义和对象图语义的统一收束。
- 懒加载与 nested query 不是额外魔法，而是结果装配过程的一部分。

## 本篇边界

- 不展开 Cursor 生命周期专题。
- 不展开 Spring 集成后的 mapper 代理装配。
- 只在结果装配需要的位置点到缓存与执行器。

## 下篇桥接

- `M-8` 将专门收束 Cursor、ResultHandler 与增量结果消费。