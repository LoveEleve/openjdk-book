# dsh Session 双后端持久化源码解析：核心只发事件，JSONL 与 SQLite 为什么都能接住

> 解析对象：`session/persistence-jsonl`、`session/persistence-sqlite`
> 定位：dsh 第六份真正源码解析，验证“核心只发 session 事件，持久化作为订阅插件接入”这条存储主线。
> 关联机制分析：`dsh/07-高价值专题清单.md`

---

## 一、解析对象

- 文件名：`session/persistence-jsonl`、`session/persistence-sqlite`
- 行数范围：session 事件订阅、append 持久化、flush 检查点、恢复加载主流程段
- 核心函数/方法：持久化插件注册、事件落盘/落库、flush 同步、恢复时重放 session 历史
- 入口事件/命令：Session 创建、session/event append、session/flush、session/disposed
- 出口事件/返回：JSONL 文件或 SQLite 记录中的 durable session 历史、恢复可读的事件序列

## 二、调用链

```text
Session 核心 append 事件
  → 发出 session/event
  → JSONL 持久化插件订阅并追加文件
  → SQLite 持久化插件订阅并写入表
  → session/flush 时两类后端完成耐久化检查点
  → 恢复时从文件/数据库重放事件序列
```

## 三、状态转换

| 状态 | 进入条件 | 离开条件 | 关键行 |
|------|----------|----------|--------|
| 新 session | `session/created` 发出 | 持久化插件建立后端上下文 | persistence 注册段 |
| append 中 | `session/event` 到达 | 写入 JSONL / SQLite 成功或失败 | append 持久化段 |
| flushed | `session/flush` 发起 | 后端完成检查点 | flush 段 |
| disposed | `session/disposed` 到达 | 句柄关闭 / 最终同步完成 | dispose 段 |
| recovered | 读取历史日志/表记录 | 重建 session 事件流 | load/replay 段 |

## 四、关键分支

| 分支 | 判断条件 | line | 结果 |
|------|----------|------|------|
| JSONL backend | 当前安装文件型后端 | JSONL 插件段 | 逐行追加、便于直接审计 |
| SQLite backend | 当前安装数据库后端 | SQLite 插件段 | 结构化查询、索引与恢复 |
| flush barrier | 上层要求 durable checkpoint | flush 段 | 调用方等待全部持久化完成 |
| listener isolation | 单个后端监听器失败 | persistence error handling | 失败隔离，不破坏事件核心语义 |
| replay restore | 需要恢复旧 session | load/replay 段 | 重新播出 durable 历史以重建状态 |

## 五、数据流

- 输入来源：session/created、session/event、session/flush、session/disposed 四类核心事件
- 传递路径：Session 事件流 → JSONL/SQLite 订阅插件 → durable file/db 记录 → 恢复重放
- 输出去向：可审计文件日志、可查询数据库记录、可恢复的 session 历史真相层

## 六、测试契约

| 测试名 | 位置 | 验证内容 |
|--------|------|----------|
| session persistence 相关测试 | `session/persistence-jsonl`、`session/persistence-sqlite` 测试集 | 验证 append、flush、dispose 与恢复重放语义 |
| session 核心集成测试 | `packages/core/session/tests/session.spec.ts` 等 | 验证持久化插件不破坏“模型可见即已记录”不变量 |

## 七、总结

- 核心结论：dsh 的持久化不是核心内建层，而是订阅 Session 事件流的插件；这正体现了“一切皆插件”的架构立场。
- 可迁移点：如果系统已经有稳定事件源，持久化最好退到订阅者层，而不是把每种后端写死进核心。
- 易错点：把 JSONL 和 SQLite 看成两套真相；真正真相仍是 Session 事件流，后端只是不同 durable 载体。
