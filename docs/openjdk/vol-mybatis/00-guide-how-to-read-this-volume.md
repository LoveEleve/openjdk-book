# 先读这一篇：怎样阅读这卷 MyBatis 源码分析

> 本文是整卷导读，回答这卷到底在讲什么、为什么这样排、怎样按问题回查。

## 这卷不是 SQL 标签手册，也不是 starter 配置手册

如果只看目录，你会看到：

- 配置启动
- Mapper 代理
- SqlSession 与事务
- Executor 执行链
- 缓存
- 动态 SQL
- 结果映射
- Cursor
- XML/注解双入口
- Spring 集成
- Boot 自动装配

如果没有导读，读者很容易把它误读成两种东西之一：

### 误解 1：这是一本 MyBatis XML/注解写法百科

不是。

这卷真正讲的是：

- MyBatis 如何把离散配置收束成元数据中心
- 如何把接口方法翻译成会话调用
- 如何把调用翻译成执行链、缓存、SQL 生成和结果装配
- 如何把这套责任世界接进 Spring 和 Spring Boot

### 误解 2：这是一些独立机制散文集

也不是。

这卷里的主题虽然看上去跨很多包，但它们都服务同一条主线：

**从配置与接口入口，到执行与装配，再到集成与装配桥。**

## 这卷真正建立的是四层视角

### 1. 核心主干层

回答：

- 配置怎么被装起来
- 接口怎么进入执行系统
- 会话和事务怎么收束
- 一次执行怎么真正落到 JDBC
- 会话与共享缓存怎么划边界

### 2. 机制补深层

回答：

- 动态 SQL 怎样生成 `BoundSql`
- 插件怎样精确切入核心接口
- 类型处理与对象图装配怎样协同
- Cursor 怎样增量消费结果
- XML 与注解入口怎样并流

### 3. Spring 集成层

回答：

- MyBatis 进入 Spring 后，`SqlSession` 为什么不再由业务代码直接关闭或提交
- mapper 接口怎样进入 Spring Bean 生命周期

### 4. Boot 装配层

回答：

- 为什么只加 starter 就能自动拥有 `SqlSessionFactory`、`SqlSessionTemplate` 和 mapper 扫描

## 推荐阅读路径

最稳的顺序就是：

1. `M-1` 配置启动与元数据构建
2. `M-2` Mapper 代理与方法分发
3. `M-3` SqlSession、事务与资源生命周期
4. `M-4` Executor 执行链与 JDBC 落地
5. `M-5` 缓存与一致性边界
6. `M-6` 动态 SQL、参数绑定与插件拦截
7. `M-7` 类型处理、反射映射与结果装配
8. `M-8` Cursor、ResultHandler 与增量结果消费
9. `M-9` XML 与注解 Mapper 双入口
10. `S-1` Spring 事务桥
11. `S-2` Boot 自动装配桥

这个顺序的好处是：

- 先把 MyBatis 本体主干立住
- 再补深那些已经在主干里出现、但不能只顺带一提的关键机制
- 最后再解释它如何进入 Spring 与 Spring Boot 的真实生态

## 按问题回查怎么读

- 配置为什么报重复 statement / unresolved：先看 `M-1`
- mapper 接口为什么找不到 statement：先看 `M-2`、`M-9`
- Session 什么时候 commit / rollback / close：先看 `M-3`
- SQL 到底如何落到 JDBC：先看 `M-4`
- 一级/二级缓存为什么不一致：先看 `M-5`
- 动态 SQL、`<foreach>`、插件为什么行为诡异：先看 `M-6`
- 结果映射、构造器映射、懒加载为什么异常：先看 `M-7`
- Cursor 为什么关闭、为什么不能多迭代器：先看 `M-8`
- Spring 环境里为什么不能手工 close Session：先看 `S-1`
- Boot 里为什么不写 `@MapperScan` 也可能生效：先看 `S-2`

## 这卷最不该怎么读

### 1. 只挑 XML、注解或 starter 看

这样会知道表层配置，但看不出它们最终并回哪条运行时主线。

### 2. 只挑缓存或动态 SQL 看

这样会知道局部机制，但不知道它们在 Session、Executor、结果装配里所处的位置。

### 3. 一上来只看 Spring / Boot 集成

这样会知道怎么装，却不知道装起来的那套 MyBatis 本体到底在跑什么。

## 当前这卷还缺什么

主干与集成层已经闭合，但生产排障层还没有单独成组。当前已经识别出的候选包括：

- 大结果集与 Cursor 边界
- 缓存一致性与阻塞锁
- BatchExecutor 批处理失败边界
- 懒加载线程与生命周期边界

所以这卷现在最适合的用途是：

- 系统理解 MyBatis 本体 + Spring/Boot 接桥
- 为后续生产层专题打地基
## 本卷在四卷体系中的位置

本卷是四卷体系的第二阶段——ORM 层入口：

```
第一阶段（数据源层）：
  vol-hikaricp（9篇）← 建立连接池的参照系
    └──→ vol-druid（9篇）← 以 HikariCP 为对照基准

第二阶段（ORM 层）：
  vol-mybatis（11篇）← 入口，先建立 MyBatis 原生体系
    └──→ vol-mybatis-plus（8篇）← 以 MyBatis 为阅读前提
```

本卷与 MyBatis-Plus 的关系：本卷是 `vol-mybatis-plus` 的阅读前提。MP 的所有增强机制（Configuration 替换、SQL 注入、Wrapper 等）都建立在 MyBatis 原生体系之上。建议先读本卷，再读 `vol-mybatis-plus`。本卷与 `vol-hikaricp` / `vol-druid` 正交，无交叉引用。
