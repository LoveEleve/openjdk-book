# IDEAS — Obsidian 知识图谱(待做,先记录)

> 2026-08-11 用户提议 | 状态: 记录待做,后续整体实施

## 想法

用 Obsidian 打开 openjdk-book 文档树,利用 **Graph View(图谱视图)** 把项目知识关系可视化:

- 每个 .md 文档 = 一个节点
- 文档间链接 = 边(Obsidian 需要 `[[wiki-link]]` 格式)
- 形成"星云图": 按簇(域/卷/素材)着色,点节点看关联

## 为什么适合本项目

项目天然是图结构,且关系已存在:

| 关系 | 现状 |
|---|---|
| 48 域目录 + 213 大纲 | planning/outlines/,大纲内互相引用 |
| 域 → 工具 → 素材 | KP 01 工具→域矩阵;materials/INDEX.md 域→文件 |
| 文章 → 域 | 卷 T 每篇有"跨域桥"节(如 ch01 → 32-jfr/25-gc/...) |
| 170 JFR 事件 × 48 域 | KP 05 索引表 |
| 旧卷 1-bak 背景章 | safepoint/frame 等背景章节可挂到新域文章 |

图谱价值: 写某域文章时,一眼看到"这个域连着什么"(大纲/素材/旧章节/工具文章),查漏补缺。

## 前置条件(后续实施时)

0. **【定案】不动原文档**: 不做任何批量转换——后续把需要入图谱的文档**整体复制一份**到独立目录(如仓库外 `obsidian-vault/` 或单独分支),在副本上操作(转 wiki-link、建图谱),**现有 docsify 站点与内容零影响**
1. 文档链接格式: 项目用 `[文字](路径)`(docsify 格式),Obsidian 图谱认 `[[路径]]`——在副本上批量转换,原仓库不动
2. 用 Obsidian 打开副本目录(`obsidian-vault/`)
3. 图谱按目录分簇: planning/outlines(48 域)、vol-tools(7 篇)、vol-01-bak(14 章)、materials(素材)
4. 可考虑: 用 graph view 的 groups 规则按目录着色,或 JSON 预设

## 替代方案(对比)

- **现有**: codebase-memory MCP 已对源码建知识图谱(函数/调用/类),但那是代码不是文档
- **轻量**: 不装 Obsidian,写脚本把 md 链接导出成 graphml/json,再用任意图工具渲染(同样在副本上做)
- **极致**: 文档关系生成 mermaid graph 嵌入 README

## 决策点(实施前问)

- 副本同步策略: 复制一次 vs 每次更新后重新复制(或软链/同步脚本)
- 图谱粒度: 全仓库 or 仅 planning+vol-tools
