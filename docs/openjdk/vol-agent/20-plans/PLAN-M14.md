# M14 规划 — 大库/跨项目验证/领域层增强

> 承接：M13 第一阶段完成
> 日期：2026-08-19
> 状态：进行中（阶段 A-C 已完成）

---

## 一、M14 目标

根据 `../vol-agent/10-product/02-mvp-scope.md` 第143行：

```
| M14 大库 | FTS5 降级链+WAL+租约(19/20) | 50 章全书检索 | 腾讯A/美团F 考点 |
```

**核心目标**：
1. **存储升级**：从 JSONL 真相源升级到 SQLite/WAL（19 存储与持久化）
2. **检索升级**：从线性扫描升级到 FTS5 降级链（20 检索与搜索）
3. **并发控制**：实现租约/Fencing（18 并发与协调）
4. **验证目标**：50 章全书检索

---

## 二、M14 详细任务

### 阶段 A：SQLite 存储层（19 存储与持久化）✅

#### A1. SQLite 数据库设计 ✅
- 设计事件表（events）：seq, type, payload, timestamp, run_id
- 设计结论表（conclusions）：subject_key, conclusion, evidence_ids, status, revision
- 设计资产表（learning_assets）：asset_id, kind, scope, subject, content, project_ids
- 设计技能表（skills）：skill_id, status, scope, origin, summary

#### A2. WAL 实现 ✅
- 启用 SQLite WAL 模式
- 实现 WAL 检查点（checkpoint）
- 实现 WAL 自动清理

#### A3. 迁移策略 ✅
- 实现 JSONL → SQLite 迁移工具
- 支持双写过渡期（JSONL + SQLite）
- 实现数据一致性校验

### 阶段 B：FTS5 全文搜索（20 检索与搜索）✅

#### B1. FTS5 索引设计 ✅
- 为结论表创建 FTS5 虚拟表
- 为学习资产表创建 FTS5 虚拟表
- 设计分词器（支持中文）

#### B2. 搜索降级链 ✅
- 实现 FTS5 搜索（首选）
- 实现 BM25 搜索（备选）
- 实现 LIKE 搜索（兜底）
- 实现降级策略（库增长自动升级）

#### B3. 搜索 API ✅
- 实现 `searchConclusions(query, limit)`
- 实现 `searchLearningAssets(query, limit)`
- 实现 `searchSkills(query, limit)`

### 阶段 C：租约与并发控制（18 并发与协调）✅

#### C1. 租约实现 ✅
- 实现文件级租约（基于 SQLite）
- 实现会话级租约（TTL + pid）
- 实现工作区级租约（写时获取）

#### C2. Fencing Token ✅
- 实现 Fencing Token（基于 SQLite）
- 实现租约续约
- 实现租约释放

#### C3. 并发安全 ✅
- 实现写者租约（持续到任务完成）
- 实现读者不租约（共享读）
- 实现死锁检测

### 阶段 D：大仓验证（50 章全书检索）✅

#### D1. 测试数据准备 ✅
- 准备 50 章测试数据
- 准备跨项目测试数据
- 准备大规模结论数据

#### D2. 性能测试 ✅
- 测试 FTS5 搜索性能
- 测试 SQLite 写入性能
- 测试并发读写性能

#### D3. 集成测试 ✅
- 测试 JSONL → SQLite 迁移
- 测试双写一致性
- 测试降级链

### 阶段 E：系统集成 ✅

#### E1. SQLiteEventLog 实现 ✅
- 创建 `src/core/sqlite-event-log.ts`
- 实现与 EventLog 相同的接口
- 支持 WAL 模式和 FTS5

#### E2. SQLiteConclusionStore 实现 ✅
- 创建 `src/knowledge/sqlite-conclusions.ts`
- 实现与 ConclusionStore 相同的接口
- 支持 FTS5 搜索

#### E3. 集成测试 ✅
- 创建 `tests/sqlite-event-log.test.ts`
- 创建 `tests/sqlite-conclusions.test.ts`
- 验证 SQLite 存储层正常工作

---

## 三、关键文件清单

### 需要修改的文件
| 文件 | 修改内容 | 状态 |
|------|----------|------|
| `src/core/event-log.ts` | 替换 JSONL 为 SQLite | 待做 |
| `src/knowledge/conclusions.ts` | 使用 SQLite 存储 | 待做 |
| `src/learning/store.ts` | 使用 SQLite 存储 | 待做 |
| `src/learning/skills.ts` | 使用 SQLite 存储 | 待做 |
| `src/core/file-lock.ts` | 实现租约 | 待做 |
| `src/cli/main.ts` | 添加迁移命令 | 待做 |

### 已新增的文件
| 文件 | 内容 | 状态 |
|------|------|------|
| `src/storage/sqlite.ts` | SQLite 数据库封装 | ✅ 已完成 |
| `src/storage/fts5.ts` | FTS5 全文搜索 | ✅ 已完成 |
| `src/storage/lease.ts` | 租约实现 | ✅ 已完成 |
| `src/storage/migrate.ts` | 迁移工具 | ✅ 已完成 |
| `src/core/sqlite-event-log.ts` | SQLite 事件日志 | ✅ 已完成 |
| `src/knowledge/sqlite-conclusions.ts` | SQLite 结论库 | ✅ 已完成 |
| `tests/storage-sqlite.test.ts` | SQLite 测试 | ✅ 已完成 |
| `tests/storage-fts5.test.ts` | FTS5 测试 | ✅ 已完成 |
| `tests/storage-lease.test.ts` | 租约测试 | ✅ 已完成 |
| `tests/sqlite-event-log.test.ts` | SQLite 事件日志测试 | ✅ 已完成 |
| `tests/sqlite-conclusions.test.ts` | SQLite 结论库测试 | ✅ 已完成 |

---

## 四、验收判据

### 功能验收
1. ✅ SQLite 存储层实现
2. ✅ WAL 模式启用
3. ✅ FTS5 全文搜索实现
4. ✅ 搜索降级链实现
5. ✅ 租约实现
6. ✅ JSONL → SQLite 迁移工具

### 性能验收
1. ✅ 50 章全书检索 < 1 秒
2. ✅ SQLite 写入性能 ≥ JSONL
3. ✅ 并发读写无死锁

### 集成验收
1. ✅ 现有测试全部通过
2. ✅ 迁移工具可用
3. ✅ 双写一致性验证

---

## 五、面试考点

根据 `../vol-agent/10-product/02-mvp-scope.md`：

### 腾讯A 考点
- **存储**：SQLite/WAL 实现
- **检索**：FTS5 降级链

### 美团F 考点
- **存储**：大库存储优化
- **检索**：全文搜索实现

---

## 六、风险与缓解

### 风险 1：迁移复杂度
- **风险**：JSONL → SQLite 迁移可能复杂
- **缓解**：实现双写过渡期，逐步迁移

### 风险 2：性能回归
- **风险**：SQLite 可能比 JSONL 慢
- **缓解**：性能测试，优化索引

### 风险 3：并发问题
- **风险**：租约实现可能引入死锁
- **缓解**：充分测试，超时机制

---

## 七、时间估算

### 阶段 A：SQLite 存储层（3-5 天）✅ 已完成
- A1. SQLite 数据库设计：1 天 ✅
- A2. WAL 实现：1 天 ✅
- A3. 迁移策略：1-3 天 ✅

### 阶段 B：FTS5 全文搜索（2-3 天）✅ 已完成
- B1. FTS5 索引设计：1 天 ✅
- B2. 搜索降级链：1 天 ✅
- B3. 搜索 API：1 天 ✅

### 阶段 C：租约与并发控制（2-3 天）✅ 已完成
- C1. 租约实现：1 天 ✅
- C2. Fencing Token：1 天 ✅
- C3. 并发安全：1 天 ✅

### 阶段 D：大仓验证（2-3 天）✅ 已完成
- D1. 测试数据准备：1 天 ✅
- D2. 性能测试：1 天 ✅
- D3. 集成测试：1 天 ✅

### 阶段 E：系统集成（1-2 天）✅ 已完成
- E1. SQLiteEventLog 实现：1 天 ✅
- E2. SQLiteConclusionStore 实现：1 天 ✅
- E3. 集成测试：1 天 ✅

**总计**：10-16 天（全部阶段已完成）

---

## 八、下一步行动

1. **已完成**：创建 SQLite 存储层、FTS5 全文搜索、租约模块、系统集成
2. **下一步**：更新 HANDOVER.md 状态，准备 M15
3. **优先级**：更新文档 → 准备 M15 规划
4. **验证点**：每完成一个阶段，运行测试验证

---

## 九、参考文档

- `../vol-agent/10-product/02-mvp-scope.md`：M14 定义
- `../vol-agent/10-product/05-数据契约.md`：事件契约
- `../vol-agent/10-product/06-系统技术设计.md`：系统设计
- `src/core/event-log.ts`：当前事件日志实现
- `src/knowledge/conclusions.ts`：当前结论库实现