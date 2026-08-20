# 04-logging/01-tag-and-selection 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：把 Unified Logging 的标签与选择器机制重写成“编译期固定标签集合如何在运行时被查询语法筛选”的专题文

## 1. 选题判断

本篇值得独立成篇，但不能继续按“标签宏 → TagSet → parse/selects”源码顺序平铺。

统一问题：

**`-Xlog:gc*=debug` 为什么能在启动后只打开一类日志？`gc*` 究竟是前缀匹配、标签树展开，还是别的什么？HotSpot 如何用编译期固定的标签集合支撑运行期查询语法？**

## 2. 一句话顿悟

**HotSpot 的 Unified Logging 不是给每条日志挂一棵标签树，而是给每条日志点绑定一个编译期固定的 TagSet；`-Xlog` 在运行时解析选择器，再用“标签子集 + 可选 wildcard + 级别阈值”去匹配这些 TagSet。**

## 3. 结构大纲

### 第一节：事故开场——`gc*` 为什么看着像树，其实不是树

- 直觉：`gc*` 像“gc 的所有子标签”
- 现实：标签是平级枚举，没有父子树
- 真问题：运行时到底如何决定“这条日志算不算 gc*”

### 第二节：标签——编译期固定的扁平枚举

- `LOG_TAG_LIST`
- `enum type`
- 扁平标签 vs 树形分类
- 为什么同一日志点可以同时带多个标签
- 5 个标签上限与编译期静态检查

### 第三节：TagSet——每条日志点的静态身份

- `LOG_TAGS(...)`
- `LogTagSetMapping` 模板实例化
- `LogTagSet::_list` 静态注册链表
- 一个日志点如何拥有固定 tagset
- 为什么运行时不做动态注册

### 第四节：选择器解析——字符串如何变成选择条件

- `LogSelection::parse`
- `all`
- `*` 后缀
- `+` 组合标签
- `from_string` / `fuzzy_match`
- 重复标签与非法标签报错

### 第五节：匹配——`gc*` 的真实语义是子集匹配

- `selects(const LogTagSet&)`
- wildcard 是否跳过 ntags 相等检查
- `gc*` = 包含 gc 的任意 tagset
- `gc+heap` = 必须精确两标签
- 级别阈值与 `Off/Trace/Debug/Info/Warning/Error`

### 第六节：多选择器与覆盖顺序

- `LogSelectionList::level_for`
- 后命中覆盖先命中
- `off` 选择器如何关掉子集
- 为什么顺序会影响结果

### 第七节：收网——日志系统的第一层边界

```text
编译期：标签枚举 + 日志点 TagSet 固定
运行时：解析选择器 → 匹配 TagSet → 决定 level
输出层：下一篇讲输出目标、装饰器和文件轮转
```

## 4. 必须展开的失败方案

1. 按树形前缀理解 `gc*`
2. 运行时动态给日志点挂标签
3. 允许无限标签组合
4. 多选择器不保留顺序
5. 非法标签不报近似建议

## 5. 必须澄清的误解

- `gc*` 不是前缀字符串匹配，也不是子节点展开
- 标签是平级枚举，不是继承树
- `TagSet` 是日志点身份，不是运行期每次打印临时组装
- `LogSelection` 选择的是 tagset，不是单个标签
- `Debug` 不是唯一输出级别，阈值比较还要考虑更高等级
- 多个 `-Xlog` 选择器是有顺序覆盖关系的

## 6. 证据清单

- `logTag.hpp:34-174`：`LOG_TAG_LIST`
- `logTag.hpp:176-185`：`LOG_TAGS`
- `logTag.hpp:188-212`：MaxTags / from_string / fuzzy_match
- `logTagSet.cpp:37-55`：`LogTagSet::_list` 静态注册
- `logTagSet.hpp:136-157`：`LogTagSetMapping`
- `logSelection.cpp:95-152`：解析
- `logSelection.cpp:161-171`：`selects`
- `logLevel.hpp:54-66`：级别枚举
- `logSelectionList.cpp:92-103`：后命中覆盖

## 7. 版本边界

- 基于 OpenJDK 11u Unified Logging 实现
- 标签数量、枚举内容、选择器语法可能随版本变化
- 本篇只讲“标签与选择”；装饰器、输出目标和轮转放下一篇
- `gc*` 的语义是当前实现的选择器匹配语义，不是通用日志 DSL 规范

## 8. 字数预算

- 正文目标：`9000-12000`
- 叙述性正文目标：`6000+`

## 9. 完成后 review

- 删除代码后能否复述“枚举标签 → 静态 tagset → 选择器解析 → 子集匹配 → 顺序覆盖”链路
- 是否明确 `gc*` 不等于树展开
- 是否区分编译期标签声明和运行期选择器
- 是否把 level 阈值和选择器顺序讲清楚
- 是否完成 file:line、版本边界和禁用词检查
