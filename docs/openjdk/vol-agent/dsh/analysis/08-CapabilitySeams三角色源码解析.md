# dsh Capability Seams 源码解析：为什么换 provider 就能换产品行为

> 解析对象：跨包 Service Definition / Provider / Consumer 模式、`docs/capability-seams`
> 定位：dsh 第八份真正源码解析，验证“Service Definition + Provider + Consumer 三角色”这条能力缝主线。
> 关联机制分析：`dsh/07-高价值专题清单.md`

---

## 一、解析对象

- 文件名：能力缝相关跨包实现与 `docs/capability-seams`
- 行数范围：服务定义、provider 注册、consumer 注入与运行时绑定主流程段
- 核心函数/方法：service definition 声明、provider 安装、consumer 通过 ctx/inject 消费能力
- 入口事件/命令：某类能力（如 fs / shell / sandbox / session persistence）被框架或产品装配进运行时
- 出口事件/返回：消费者获得抽象能力，而具体 provider 可被替换、叠加或按产品配置切换

## 二、调用链

```text
框架定义某种 capability service
  → provider 插件把具体实现注册到 ctx
  → consumer 插件通过 inject / ctx 查找该 service
  → 运行时调用抽象能力而不 import 具体实现
  → 更换 provider 后，相同 consumer 自动获得新产品行为
```

## 三、状态转换

| 状态 | 进入条件 | 离开条件 | 关键行 |
|------|----------|----------|--------|
| service declared | 能力接口被定义 | provider 安装 | service definition 段 |
| provider mounted | 某个具体实现挂入 ctx | consumer 开始解析依赖 | provider apply 段 |
| consumer bound | inject 依赖满足 | 运行期调用能力 | consumer/inject 段 |
| provider swapped | profile/bundle 或 reload 更换实现 | consumer 重新绑定或继续使用抽象接口 | reload/swap 段 |
| disposed | provider 卸载 | 上下文回滚到前一层或无实现 | reversible effect 段 |

## 四、关键分支

| 分支 | 判断条件 | line | 结果 |
|------|----------|------|------|
| 无 provider | service 已定义但未安装实现 | inject 解析段 | consumer 等待或失配失败 |
| 多 provider 覆盖 | 同类 capability 有更上层实现 | ctx/provider 绑定段 | 当前产品行为被新 provider 改写 |
| reload / teardown | provider 被替换或卸载 | reversible effect 段 | 回滚旧实现，暴露新层级 |
| shared execution world | 多能力共享同一底层世界 | seam 组合段 | fs/subprocess/shell 看到同一环境边界 |
| provider change = product change | 更换 capability 实现 | bundle/profile 装配段 | 同一框架内生成不同产品形态 |

## 五、数据流

- 输入来源：service definition、provider 插件、consumer 插件、profile/bundle 装配选择
- 传递路径：定义抽象 capability → provider 注册实现 → consumer 运行时绑定 → reload/swap 时重组
- 输出去向：统一的能力消费接口、可替换 provider 行为、不同产品形态下的一致 consumer 代码

## 六、测试契约

| 测试名 | 位置 | 验证内容 |
|--------|------|----------|
| capability seam 相关测试 | 跨包能力缝测试集 | 验证 service/provider/consumer 三角色装配与替换语义 |
| cordis/context 相关测试 | Cordis 上下文与 effect 测试 | 验证 provider 安装、覆盖、卸载与回滚行为 |

## 七、总结

- 核心结论：dsh 的能力缝不是普通接口抽象，而是通过三角色把“能力定义”和“产品实现”拆开，从而让换 provider 直接等于换产品行为。
- 可迁移点：要做真正可替换的 Agent 框架，能力边界应至少拆成 definition/provider/consumer 三层，而不是只写一层 interface。
- 易错点：把 capability seam 看成依赖注入技巧；它真正值钱的是能把运行时行为、边界和产品形态一起抽象出来。
