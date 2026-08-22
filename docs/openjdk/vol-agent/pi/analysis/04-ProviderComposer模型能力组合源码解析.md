# Pi ProviderComposer 源码解析：多模型接入为什么要变成运行时组合层

> 解析对象：`coding-agent/src/core/provider-composer.ts`、`ai/src/provider/`、`ai/src/api/`
> 定位：Pi 第四份真正源码解析，验证“provider 组合 + 能力路由 + 上下文边界裁剪”这条模型能力主线。
> 关联机制分析：`pi/08-LLM与ProviderComposer：Pi 如何把多模型与多供应商能力接入运行时.md`

---

## 一、解析对象

- 文件名：`coding-agent/src/core/provider-composer.ts`、`ai/src/provider/`、`ai/src/api/`
- 行数范围：现有材料明确支持 `coding-agent/src/core/provider-composer.ts`、`ai/src/provider/`、`ai/src/api/` 的 provider 组合、能力选择和请求适配主流程；具体行号需回到对应仓库基线核对
- 核心函数/方法：provider 选择/组合、请求路由、结构化输出能力适配、上下文窗口裁剪
- 入口事件/命令：AgentSessionRuntime 准备发起一次模型请求
- 出口事件/返回：选中的 provider/model 组合、适配后的请求、受窗口保护的调用参数

## 二、调用链

```text
AgentSessionRuntime 准备请求模型
  → ProviderComposer 根据当前配置/登录态/能力需求选择 provider
  → 组合 provider / model / auth / api 细节
  → 若请求需要结构化输出则走 constrained sampling 能力
  → 调用前执行 context clamp / max tokens 裁剪
  → 生成 provider-specific request 并交给 ai/api 层发送
```

## 三、状态转换

| 状态 | 进入条件 | 离开条件 | 关键行 |
|------|----------|----------|--------|
| 待选择 | 运行时准备发起模型调用 | 找到匹配 provider/model | `provider-composer.ts` 选择段 |
| 已组合 | provider、model、auth、api 细节已确定 | 请求适配完成 | composer 收尾段 |
| constrained mode | 当前请求要求结构化输出 | 输出契约准备完成 | `ai/src/api/constrained-sampling` 相关段 |
| clamped | 请求接近上下文边界 | tokens 裁剪完成 | simple-options / clamp 段 |
| dispatched | provider-specific request 已形成 | api 层发送 | `ai/src/api/` 段 |

## 四、关键分支

| 分支 | 判断条件 | line | 结果 |
|------|----------|------|------|
| provider 切换 | 登录态/能力需求/模型配置变化 | `provider-composer.ts` 路由段 | 选择不同 provider 组合 |
| constrained sampling | 当前调用要求结构化对象 | api 能力段 | 输出进入 schema 约束模式 |
| context clamp | max tokens 超上下文窗口 | clamp 段 | 请求参数被裁进可执行边界 |
| auth 变化 | OAuth / API key / runtime credential 不同 | provider/auth 段 | 调用能力集合随认证态变化 |
| provider 差异适配 | 不同 provider API 形状不一致 | `ai/src/api/` 段 | runtime 继续看到统一能力抽象 |

## 五、数据流

- 输入来源：当前模型配置、登录态/credential、运行时能力需求、上下文 token 预算、结构化输出约束
- 传递路径：ProviderComposer → provider/api/auth/models 分层适配 → clamp / constrained sampling → API 请求
- 输出去向：provider-specific 调用参数、统一的模型能力结果、运行时后续 turn 的模型响应

## 六、测试契约

| 测试名 | 位置 | 验证内容 |
|--------|------|----------|
| provider/api 相关测试 | `ai` 与 `coding-agent` 测试集中 provider 组合相关用例 | 当前闭环材料未给出单一稳定测试文件名，需按仓库基线检索确认 |
| constrained/context 相关测试 | `ai/src/api` 与 runtime 相关用例 | 验证结构化输出与上下文窗口裁剪边界；具体测试文件需按仓库基线核对 |

## 七、总结

- 核心结论：Pi 的 ProviderComposer 不是配置器，而是把模型选择、认证、API 差异和调用边界统一收进运行时组合层。
- 可迁移点：多模型 Agent 不该把 provider 差异泄漏到 session/loop 层，而应集中在能力组合层消化。
- 易错点：把换模型理解成只换 model id；真正困难的是能力、认证和上下文边界也会一起变化。
