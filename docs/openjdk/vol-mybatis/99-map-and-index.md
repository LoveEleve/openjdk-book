# MyBatis 卷总图 / 总索引

## 一、整卷主图

```text
mybatis-config.xml / mapper resources
  -> Configuration
    -> MapperRegistry / MapperProxy / MapperMethod
      -> SqlSession
        -> Executor
          -> StatementHandler / ParameterHandler / ResultSetHandler
            -> Cache / Dynamic SQL / TypeHandler / ResultMap / Cursor
              -> Spring bridge
                -> Boot auto-configuration bridge
```

对应篇章：

- 配置启动：`M-1`
- 接口调用：`M-2`
- 会话与事务：`M-3`
- 执行链与 JDBC：`M-4`
- 缓存边界：`M-5`
- 动态 SQL 与插件：`M-6`
- 类型处理与结果装配：`M-7`
- Cursor 增量消费：`M-8`
- XML/注解双入口：`M-9`
- Spring 事务桥：`S-1`
- Boot 装配桥：`S-2`

## 二、推荐阅读顺序

`M-1 -> M-2 -> M-3 -> M-4 -> M-5 -> M-6 -> M-7 -> M-8 -> M-9 -> S-1 -> S-2`

这是“核心主干 -> 机制补深 -> Spring 集成 -> Boot 装配”的顺序，而不是目录包结构的镜像。

## 三、按问题找文章

### 1. 配置与注册问题

- 重复 statement / unresolved / namespace：`M-1`
- XML mapper 与注解 mapper 的关系：`M-9`

### 2. 调用入口问题

- mapper 接口为什么没有实现也能执行：`M-2`
- default method、Optional、Cursor、Map 返回值分发：`M-2`

### 3. 会话与事务问题

- `SqlSession` 什么时候提交、回滚、关闭：`M-3`
- Spring 里为什么不能手工 close/commit：`S-1`

### 4. 执行与 SQL 问题

- SQL 怎样落到 JDBC：`M-4`
- 动态 SQL、`<foreach>`、插件链：`M-6`

### 5. 映射与结果问题

- TypeHandler、反射、构造器映射、nested query：`M-7`
- Cursor 流式消费与 ResultHandler：`M-8`

### 6. 缓存与一致性问题

- 一级/二级缓存、TransactionalCache、BlockingCache：`M-5`

### 7. 装配与生态问题

- MyBatis 进入 Spring：`S-1`
- MyBatis 进入 Spring Boot：`S-2`

## 四、跨篇桥接总览

- `M-1 -> M-2`：配置元数据中心进入接口调用协议
- `M-2 -> M-3`：接口调用进入会话与事务责任边界
- `M-3 -> M-4`：会话进入真正执行链
- `M-4 -> M-5`：执行链里的本地/共享缓存被单独拉出
- `M-4 -> M-6`：执行链里的 `BoundSql` / 插件入口被单独拉出
- `M-6 -> M-7`：参数绑定之后，进入类型语义与结果装配语义
- `M-7 -> M-8`：对象图装配之后，再看增量消费协议
- `M-8 -> M-9`：结果消费层收束后，回到配置入口的双通道问题
- `M-9 -> S-1`：MyBatis 核心注册主线进入 Spring 会话/事务桥
- `S-1 -> S-2`：Spring 责任桥被 Boot 自动装配桥接起来

## 五、当前明确暂缓的卷级边界

- 生产排障层未单独成组
- 主题候选包括：
  - `cursor_cache_oom`
  - `blocking_cache`
  - `BatchExecutor` 整批回滚边界
  - 懒加载线程/生命周期边界

这意味着：本卷已经能回答“系统如何工作”，但“线上故障如何按专题排”仍是下一阶段补层。
## 七、跨卷位置

本卷是四卷体系第二阶段的入口：

- 本卷覆盖：MyBatis 原生体系（配置启动、MapperProxy、SqlSession、Executor、缓存、动态 SQL、类型映射、Cursor、XML/注解双入口、Spring/Boot 集成）
- 后续卷：`vol-mybatis-plus` — 以本卷为阅读前提，展开 MP 增强机制
- 无关卷：`vol-hikaricp` / `vol-druid` — ORM 与连接池正交，无交叉引用
