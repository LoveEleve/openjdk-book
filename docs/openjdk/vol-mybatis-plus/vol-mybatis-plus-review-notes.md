# vol-mybatis-plus 卷级六层审查笔记

> 审查基线：MyBatis-Plus 3.5.7 当前源码；正文 8 篇（MP-1 ~ MP-8）；对照卷 `vol-mybatis`。

## 结论

卷级审查完成。8 个域正文锚点已扫描并复核，所有引用对应的源码文件存在，行号均在当前文件范围内。物理目录不移动，卷级推荐阅读顺序为 `MP-1 -> MP-2 -> MP-3 -> MP-4 -> MP-5 -> MP-6 -> MP-7 -> MP-8`。

## 一、事实审

- 扫描 8 篇正文，共 120+ 个 `file:line` 引用。
- 所有引用对应的源码文件存在，行号均在当前文件范围内。
- 未发现跨篇重复锚点。
- 源码抽查确认：
  - `MybatisPlusAutoConfiguration.java:102` 为类注解起始，`:107` 为类声明，正文成立。
  - `MybatisPlusProperties.java:55` 为类声明，`:125` 为 `resolveMapperLocations()`，`:343` 为 `CoreConfiguration.applyTo(...)`，正文成立。
  - `BaseMapper.java:101` 为接口声明，`:108` 为 `insert(T entity)`，`:126` 为 `deleteById(Object, boolean useFill)`，正文成立。
  - `ServiceImpl.java:53` 为类声明，`:57` 为 `@Autowired protected M baseMapper`，`:278` 为 `executeBatch(...)`，正文成立。

## 二、因果审

跨篇链路成立：

- `MP-1 -> MP-2`：`MybatisConfiguration` 替换原生 Configuration 后，`DefaultSqlInjector` 才能批量注入增强版 MappedStatement。
- `MP-2 -> MP-3`：SQL 注入依赖 `TableInfo` 元数据确定表名、列名、主键。
- `MP-3 -> MP-4`：Wrapper 的条件构造需要 `TableInfo` 的字段映射。
- `MP-2 -> MP-5`：SQL 注入生成的 MappedStatement 是插件总线的拦截目标。
- `MP-5 -> MP-6`：插件总线先立住后，具体增强插件才能稳定挂上去。
- `MP-1~MP-6 -> MP-7`：Boot 装配桥自动把整套增强体系装起来。
- `MP-1~MP-7 -> MP-8`：`BaseMapper` / `IService` / `ServiceImpl` 是所有增强机制的最终收束点。

## 三、结构审

8 篇按四层组织：

- 核心主干层（MP-1 ~ MP-4）：Configuration 替换、SQL 注入、表元数据、Wrapper
- 机制补深层（MP-5 ~ MP-6）：插件总线、增强家族
- Boot 装配层（MP-7）：自动装配桥
- 应用边界层（MP-8）：BaseMapper / IService / ServiceImpl

物理目录为 `ch1` 到 `ch8`，与推荐阅读顺序一致，无目录重命名需求。

## 四、读者审

- MP-1 不依赖任何前篇，是入口。
- MP-2 依赖 MP-1 的 Configuration 替换语义；满足。
- MP-3 依赖 MP-2 的 SQL 注入语义；满足。
- MP-4 依赖 MP-3 的表元数据；满足。
- MP-5 依赖 MP-2 的 MappedStatement 生成；满足。
- MP-6 依赖 MP-5 的插件总线；满足。
- MP-7 依赖 MP-1~MP-6（HARD）；满足。
- MP-8 依赖 MP-1~MP-7（HARD）；满足。
- 未发现"前篇尚未建立却被后篇当作已知"的循环依赖。

## 五、边界审

边界总体清晰：

- MP-1 讲 Configuration 替换与 Mapper 注册，不提前讲 SQL 注入细节。
- MP-2 讲 SQL 注入，不重讲 Configuration 替换。
- MP-3 讲表元数据，不重讲 SQL 注入生成细节。
- MP-4 讲 Wrapper，不重讲表元数据解析。
- MP-5 讲插件总线，不重讲具体增强插件算法。
- MP-6 讲增强家族地图，不重讲插件总线注册细节。
- MP-7 讲 Boot 装配桥，不重讲 MP-1~MP-6 的内部实现。
- MP-8 讲应用边界层，不重讲 MP-1~MP-7 的增强机制。

与 `vol-mybatis` 的边界清晰：`vol-mybatis` 覆盖 MyBatis 原生体系，`vol-mybatis-plus` 覆盖 MP 增强体系。两卷对 `SqlSessionTemplate`、`MapperScannerConfigurer` 等的描述不重复，`vol-mybatis-plus` 只在需要时引用 `vol-mybatis` 的结论。

## 六、依赖审

- 依赖方向为 Configuration 替换 -> SQL 注入 -> 表元数据 -> Wrapper -> 插件总线 -> 增强家族 -> Boot 装配 -> 应用边界，无回环。
- 与 `vol-mybatis` 不矛盾：`vol-mybatis` 的 `S-1` 和 `S-2` 描述 MyBatis 原生 Spring/Boot 集成，`vol-mybatis-plus` 的 `MP-7` 描述 MP 增强版 Boot 装配，两卷互补不冲突。

## 修正记录

无。所有行号在写作时已核对。

## 验证记录

- 正文锚点脚本检查：8 篇共 120+ 个引用，坏引用 0 个。
- MyBatis-Plus 源码计数：`mybatis-plus-core` Java 文件约 300+ 个，`mybatis-plus-extension` Java 文件约 400+ 个。
- 该文档目录无独立 lint/typecheck 配置；本次以锚点扫描、源码上下文复核和 Markdown 结构检查作为等价校验。
