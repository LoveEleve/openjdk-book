# OpenCode SystemContext 源码解析：上下文源为什么必须可比较、可刷新、可替换

> 解析对象：`packages/core/src/system-context/index.ts`、`packages/core/src/system-context/registry.ts`、`packages/core/src/session/context-epoch.ts`
> 定位：OpenCode 第四份真正源码解析，验证“Source 代数 + unavailable 语义 + context epoch/replace”这条长跑上下文主线。
> 关联机制分析：`opencode/05-SystemContext与Compaction：OpenCode 为什么能长跑而不散.md`

---

## 一、解析对象

- 文件名：`packages/core/src/system-context/index.ts`、`packages/core/src/system-context/registry.ts`、`packages/core/src/session/context-epoch.ts`
- 行数范围：source 定义、initialize / reconcile / replace、epoch 维护与 instruction context 合并主流程段
- 核心函数/方法：上下文 `Source` 加载、baseline 建立、快照比较、replace 提交、epoch 刷新
- 入口事件/命令：session 启动、指令/技能/环境等上下文源变化、压缩或恢复后重建上下文基线
- 出口事件/返回：稳定 baseline、增量 update、replacement ready/blocked、新的 context epoch

## 二、调用链

```text
session 启动或进入新 turn
  → SystemContext initialize 全量观察 source
  → 建立 baseline snapshot
  → 后续每轮 reconcile 当前 source 值与 snapshot
  → 判断 unchanged / updated / replacement ready / blocked
  → 满足条件时 replace 整体 generation
  → context epoch 刷新后供 SessionRunner 组装 request
```

## 三、状态转换

| 状态 | 进入条件 | 离开条件 | 关键行 |
|------|----------|----------|--------|
| 未初始化 | session 首次建立上下文 | initialize 完成 | `index.ts` initialize 段 |
| baseline 稳定 | 全部 source 已形成初始快照 | reconcile 检测到变化 | registry snapshot 段 |
| updated | source 有增量变化 | 被纳入当前上下文或等待 replace | reconcile update 分支 |
| replacement ready | 变化需要整体替换 | replace 成功或 blocked | replace ready 分支 |
| blocked | source unavailable 或替换条件未满足 | source 恢复可用 | unavailable / blocked 分支 |
| 新 epoch | replace / compaction / 恢复完成 | 下一次 source 变化 | `context-epoch.ts` 段 |

## 四、关键分支

| 分支 | 判断条件 | line | 结果 |
|------|----------|------|------|
| initialize unavailable | 首次加载 source 失败 | `index.ts` 初始化段 | `InitializationBlocked`，拒绝建立残缺基线 |
| reconcile unavailable | 已有 snapshot 但当前 source 暂不可用 | reconcile 段 | stale-while-revalidate，保留旧值 |
| replace unavailable | 准备整体替换时 source 不可用 | replace 段 | `ReplacementBlocked` |
| lazy render | 值层已判断变化但未必需要文本化 | registry / render 段 | 先做语义比较，再按需渲染文本 |
| instruction source 变化 | `AGENTS.md` / 内建指令集合变化 | instruction context 段 | 作为真实 source 进入 replace / update 逻辑 |

## 五、数据流

- 输入来源：技能、指令文件、环境、引用、系统配置等各类 context source
- 传递路径：source load → codec/baseline → snapshot reconcile → replace / epoch refresh
- 输出去向：provider-visible system context、session request baseline、压缩后恢复所依赖的一致性上下文基线

## 六、测试契约

| 测试名 | 位置 | 验证内容 |
|--------|------|----------|
| system-context 测试集 | `packages/core/test/system-context/*` | 验证 initialize / reconcile / replace、不同行为下 unavailable 语义与 snapshot 一致性 |
| instruction/context 相关测试 | `packages/core/test` 中 instruction / source 相关用例 | 验证指令域合并、排序与 source 更新行为 |

## 七、总结

- 核心结论：OpenCode 的 SystemContext 不是 prompt 拼接器，而是一个对上下文源做值比较、阻塞控制和整体替换的状态系统。
- 可迁移点：长跑 Agent 的 system context 最好建模成可比较的 source 集合，而不是每轮重拼字符串。
- 易错点：把 unavailable 当删除；真正成熟的系统应区分“暂时读不到”和“这个源已经被移除”。
