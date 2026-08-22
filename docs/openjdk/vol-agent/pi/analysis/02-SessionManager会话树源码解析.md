# Pi SessionManager 源码解析：JSONL 会话为什么是一棵探索树

> 解析对象：`coding-agent/src/core/session-manager.ts`
> 定位：Pi 第二份真正源码解析，验证“追加写 + parentId + leaf + branch”这条持久化主线。
> 关联机制分析：`pi/06-Session持久化与事实层：Pi 如何用会话树和存储组织长期状态.md`

---

## 一、解析对象

- 文件名：`coding-agent/src/core/session-manager.ts`
- 行数范围：session header、entry append、branch、load、createBranchedSession 主流程段
- 核心函数/方法：会话创建/加载、append entry、branch、branchWithSummary、createBranchedSession、header 快速读取
- 入口事件/命令：会话创建、继续执行、回退分支、导出新分支会话
- 出口事件/返回：JSONL entry 追加、`leaf` 迁移、分支摘要生成、可恢复会话树

## 二、调用链

```text
AgentSession 产生新条目
  → SessionManager 追加写入 JSONL
  → entry 带 id / parentId 挂到当前 leaf
  → 需要回退时 branch 移动 leaf
  → 需要压缩时 branch summary / compaction entry 写入
  → 需要导出时 createBranchedSession 提取当前分支
  → 下次加载时按 header + entries 重建会话树
```

## 三、状态转换

| 状态 | 进入条件 | 离开条件 | 关键行 |
|------|----------|----------|--------|
| 新会话 | 创建 session header | 首个有效 entry 写入 | `session-manager.ts` create 段 |
| 线性追加中 | 当前 leaf 指向最新 entry | branch / fork / compaction 改变未来写入位置 | append 段 |
| 分支中 | leaf 被移到历史 entry | 新 entry 继续追加形成新支线 | branch 段 |
| 摘要化分支 | 放弃旧路径但需保留背景 | summary 写入并继续新分支 | branchWithSummary 段 |
| 重新加载 | 从文件恢复 | 完成 header/entries 重建 | load / parse 段 |

## 四、关键分支

| 分支 | 判断条件 | line | 结果 |
|------|----------|------|------|
| 首条 assistant 前不落盘 | 尚无有效成果 | `session-manager.ts` 初始持久化策略段 | 避免产生垃圾会话 |
| branch | 用户或系统回到旧 entry | branch 段 | 只移动 leaf，不改旧历史 |
| createBranchedSession | 当前分支需导出独立成果 | branched session 段 | 把当前路径提取为新会话 |
| 坏行 / 断链容错 | JSONL 某行损坏或 parent 缺失 | load 容错段 | 保留内容并降级结构 |
| header 快速读取 | 仅需列举最近会话 | header scan 段 | 不加载完整历史 |

## 五、数据流

- 输入来源：AgentSession 产出的 message / custom / label / compaction / branch summary entries
- 传递路径：内存 entry → JSONL append → parentId / leaf 结构化组织 → load 时重建树
- 输出去向：可分支会话文件、分支导出会话、后续上下文重建所需的历史真相层

## 六、测试契约

| 测试名 | 位置 | 验证内容 |
|--------|------|----------|
| reducer / harness session 测试 | `agent/test/harness/reducer.test.ts` | 验证分支、压缩、继续执行时的会话行为 |
| SessionManager 相关测试 | `coding-agent` 测试集中 session 管理相关用例 | 验证 JSONL 加载、分支、导出与容错 |

## 七、总结

- 核心结论：Pi 的 SessionManager 存的不是线性聊天记录，而是一棵可回退、可分叉、可导出的探索树。
- 可迁移点：对分析型 Agent，branch 最好定义成“改变未来写入位置”，而不是复制或改写旧历史。
- 易错点：把 JSONL 看成简单日志；真正关键的是 `parentId`、`leaf`、summary entry 和容错加载共同定义了会话真相层。
