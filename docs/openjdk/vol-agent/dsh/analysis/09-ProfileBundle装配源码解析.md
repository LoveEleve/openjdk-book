# dsh Profile / Bundle 装配源码解析：插件运行时如何被装配成具体产品

> 解析对象：`boot/app-boot`、`bundle/`
> 定位：dsh 第九份真正源码解析，验证“profile + bundle + patch/overlay”这条产品装配主线。
> 关联机制分析：`dsh/07-高价值专题清单.md`

---

## 一、解析对象

- 文件名：`boot/app-boot`、`bundle/`
- 行数范围：bundle 组合、profile 选择、patch/overlay 覆盖、启动时插件装配主流程段
- 核心函数/方法：app boot、bundle 组装、profile 层序展开、patch 覆盖并加载最终插件集合
- 入口事件/命令：启动某一 dsh 产品形态或运行某个 profile
- 出口事件/返回：一组已装配好的 plugins/providers/config overlays，形成具体产品运行时

## 二、调用链

```text
应用启动
  → app-boot 读取 profile / bundle 配置
  → 按层序展开默认插件与 capability providers
  → 应用 patch / overlay 覆盖局部配置
  → 加载最终插件集合到 Cordis ctx
  → 形成当前产品形态的 runtime
```

## 三、状态转换

| 状态 | 进入条件 | 离开条件 | 关键行 |
|------|----------|----------|--------|
| booting | 应用刚启动 | profile/bundle 配置加载完成 | app-boot 入口段 |
| bundle resolved | 基础插件集合已展开 | overlay / patch 应用完成 | bundle 解析段 |
| patched | 局部覆盖已合并 | 插件正式装载 | patch/overlay 段 |
| runtime assembled | 插件装配进入 ctx | 开始提供服务 | plugin mount 段 |
| product shaped | 当前 profile 选择完成 | 切换 profile / reload | 启动收尾段 |

## 四、关键分支

| 分支 | 判断条件 | line | 结果 |
|------|----------|------|------|
| 不同 profile | 启动选择不同产品配置 | app-boot 选择段 | 获得不同 provider / plugin 组合 |
| overlay 覆盖 | 局部配置要覆盖 bundle 默认值 | patch/overlay 段 | 细粒度改变产品行为 |
| provider 替换 | profile 指向不同 capability provider | bundle 装配段 | 同一框架跑出不同产品形态 |
| 缺失依赖 | inject 需求未满足 | plugin mount 段 | 装配失败或等待条件满足 |
| reload/reassemble | 运行时重新装配 | reload 段 | 旧插件回滚，新组合生效 |

## 五、数据流

- 输入来源：profile 选择、bundle 定义、patch/overlay 配置、插件依赖声明
- 传递路径：boot config → bundle resolve → overlay merge → plugin mount → runtime assembled
- 输出去向：当前 dsh 产品形态所需的能力集合、provider 选择和运行时行为边界

## 六、测试契约

| 测试名 | 位置 | 验证内容 |
|--------|------|----------|
| boot/bundle 相关测试 | `boot/app-boot`、`bundle/` 测试集 | 验证 profile 展开、overlay 合并、插件装配顺序与依赖满足 |
| cordis/plugin 集成测试 | Cordis 插件运行时集成用例 | 验证装配后的 plugin 集合能形成稳定 runtime |

## 七、总结

- 核心结论：dsh 的产品形态不是靠核心开关硬编码出来的，而是通过 profile、bundle 和 patch/overlay 把插件运行时装配出来的。
- 可迁移点：如果希望“同一框架派生多个产品”，装配层应显式存在，并负责 provider 选择、默认组合和局部覆盖。
- 易错点：把 bundle 看成静态配置清单；实际上它是把能力缝、provider 和运行时依赖拼成具体产品的装配逻辑。
