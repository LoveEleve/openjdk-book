# OpenCode ToolRegistry 源码解析：工具调用为什么必须经过结算管线

> 解析对象：`packages/core/src/tool/registry.ts`、`packages/core/src/tool/tool.ts`、`packages/core/src/tool-output-store.ts`
> 定位：OpenCode 第三份真正源码解析，验证“opaque tool handle + stale rejection + bounded output settlement”这条工具主线。
> 关联机制分析：`opencode/04-ToolRegistry与Tool Settlement：为什么工具调用不是普通函数调用.md`

---

## 一、解析对象

- 文件名：`packages/core/src/tool/registry.ts`、`packages/core/src/tool/tool.ts`、`packages/core/src/tool-output-store.ts`
- 行数范围：tool materialize / resolve / execute / output store 主流程段
- 核心函数/方法：工具注册、materialize、输入解码、执行结算、输出托管与 preview 生成
- 入口事件/命令：模型在当前 turn 中发出 tool call
- 出口事件/返回：结构化 tool result、bounded preview、完整输出托管引用、或 stale rejection / schema 错误

## 二、调用链

```text
模型产出 tool call
  → SessionRunner 收到工具意图
  → ToolRegistry 根据广告时句柄 materialize 工具
  → 校验当前注册身份是否仍一致
  → 按输入 schema 解码参数
  → 在统一 context 下执行工具
  → 按输出 schema 编码 / 投影结果
  → ToolOutputStore 生成 preview 并托管完整输出
  → 返回 settle 后的 tool result 给模型与事件流
```

## 三、状态转换

| 状态 | 进入条件 | 离开条件 | 关键行 |
|------|----------|----------|--------|
| 已广告 | 工具已向模型暴露名称与 schema | tool call 到达 | `tool.ts` / materialize 段 |
| 待解析 | registry 开始结算该调用 | 输入解码成功或失败 | `registry.ts` decode 段 |
| 执行中 | 输入 schema 通过 | execute 返回或抛错 | `registry.ts` execute 段 |
| 输出投影中 | 工具返回原始结果 | preview / full output 生成 | `tool-output-store.ts` 主流程 |
| settled | 结构化结果完整 | 返回给模型与事件层 | settlement 收尾段 |
| stale / invalid | 句柄失效或 schema 不匹配 | 生成拒绝结果 | stale rejection / validation 分支 |

## 四、关键分支

| 分支 | 判断条件 | line | 结果 |
|------|----------|------|------|
| stale rejection | 当前注册对象与广告时身份不一致 | `registry.ts` stale 检查段 | 拒绝执行旧工具意图 |
| 输入 schema 失败 | 模型参数不合法 | `registry.ts` decode 段 | 生成错误 tool result |
| 输出超大 | 完整输出超上下文预算 | `tool-output-store.ts` bounded output 段 | 历史仅保留 preview，完整结果托管 |
| location 覆盖 | location tool 覆盖 application tool | registry 解析段 | 选择当前 scope 正确工具 |
| 执行抛错 | tool execute 失败 | execute / settle 收尾段 | 失败语义进入模型可见结果 |

## 五、数据流

- 输入来源：模型 tool call、当前 runtime context、application/location tool 注册表
- 传递路径：tool handle → registry resolve → schema decode → execute → encode / project → output store
- 输出去向：模型可见 tool result、完整输出托管文件、durable 事件流中的工具结果记录

## 六、测试契约

| 测试名 | 位置 | 验证内容 |
|--------|------|----------|
| application tools / tool registry 测试 | `packages/core/test/application-tools.test.ts`、`packages/core/test/tool-*` | 验证工具注册、scope 覆盖、schema 契约与执行语义 |
| output store 相关测试 | `packages/core/test/tool-*` 相关集 | 验证超长输出托管、preview 截断与模型可见结果边界 |

## 七、总结

- 核心结论：OpenCode 的工具调用不是本地函数直调，而是 decode → execute → encode → bound → settle 的协议管线。
- 可迁移点：长跑 Agent 应把工具句柄做成受 runtime 控制的不透明值，并把完整输出与模型可见输出分层。
- 易错点：只按工具名执行而忽略 stale identity；这会让模型看到的旧能力与系统实际执行的新能力发生错配。
