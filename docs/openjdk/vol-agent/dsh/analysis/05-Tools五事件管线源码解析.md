# dsh Tools 源码解析：工具为什么不是函数，而是五事件协议管线

> 解析对象：`core/tools`、`docs/subsystems/tools`
> 定位：dsh 第五份真正源码解析，验证“pre/post/execute/code-dispatch-log/result 五事件 + 守卫管线”这条工具主线。
> 关联机制分析：`dsh/06-高价值专题清单.md`

---

## 一、解析对象

- 文件名：`core/tools` 相关实现
- 行数范围：工具注册、五事件分派、守卫检查、结果返回主流程段
- 核心函数/方法：tool definition、调用前守卫、执行分派、结果日志化与返回
- 入口事件/命令：模型在当前 step 中发出 tool call
- 出口事件/返回：tool result、guard reason、日志事件与模型可见结果

## 二、调用链

```text
模型发出 tool call
  → tools/pre 做调用前守卫与 ask 检查
  → tools/execute 真正执行工具能力
  → tools/code-dispatch-log 记录代码/命令级分派痕迹
  → tools/post 做收尾与结果整理
  → tools/result 生成模型可见结果并写入 session
```

## 三、状态转换

| 状态 | 进入条件 | 离开条件 | 关键行 |
|------|----------|----------|--------|
| 待守卫 | tool call 到达 | 通过或被阻止 | tools/pre 段 |
| 已授权 | ask/guard/check 通过 | 进入 execute | 守卫收尾段 |
| 执行中 | tool execute 开始 | 返回结果或抛错 | tools/execute 段 |
| 已记录 | 执行痕迹进入日志 | 进入结果投影 | code-dispatch-log 段 |
| 已返回 | result 事件写入 session | step 继续或结束 | tools/result 段 |
| blocked | guard/cancel/ask 失败 | 当前调用终止 | guard reason 分支 |

## 四、关键分支

| 分支 | 判断条件 | line | 结果 |
|------|----------|------|------|
| cancel 重查 | 调用中途信号取消或状态变化 | guard 段 | 阻止继续执行 |
| ask 审批 | 当前工具需要人工确认 | tools/pre 审批段 | pending/拒绝/放行 |
| guardReason | 策略监听器给出拒绝原因 | 守卫分支 | 返回结构化阻止结果 |
| execute error | 工具实现抛错 | execute 段 | 转成协议内错误结果 |
| result projection | 返回值需转成模型消息 | tools/result 段 | 生成模型可见 tool/result |

## 五、数据流

- 输入来源：tool call、工具参数、守卫策略、审批状态、当前 session/context
- 传递路径：pre guard → execute → code-dispatch-log → post → result
- 输出去向：session 事件日志、模型可见 tool/result、工具执行痕迹与守卫原因

## 六、测试契约

| 测试名 | 位置 | 验证内容 |
|--------|------|----------|
| tools 相关测试 | `core/tools` 测试集 | 验证五事件管线、守卫、ask 与错误返回语义 |
| agent-loop / session 集成测试 | 相关集成测试 | 验证 tool result 如何进入 step/session 主线 |

## 七、总结

- 核心结论：dsh 的工具不是本地函数调用，而是一条由事件、守卫和日志共同定义的协议管线。
- 可迁移点：如果系统强调插件化和可审计性，工具调用应显式分成 pre/execute/post/result 多阶段，而不是只暴露一个 execute。
- 易错点：把工具系统看成工具注册表；真正关键的是五事件把审批、守卫、执行、日志和模型可见结果串成了一个统一协议。
