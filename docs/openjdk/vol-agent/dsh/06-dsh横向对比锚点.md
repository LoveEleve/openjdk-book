# dsh 横向对比锚点

> 用途：从 dsh 第一卷中抽出后续与 OpenCode / Reasonix / Pi / Hermes 对比时可直接复用的比较维度。

---

## 一、dsh 整体画像

一句话定义：

> **dsh 是把 Agent 做成插件运行时框架的项目：没有特权核心，模型可见视图直接建立在 Session 事件源之上，产品行为由能力缝和插件组合定义。**

---

## 二、最核心的 10 个对比锚点

## D-A1 架构立场
- dsh 的做法：everything is plugin，没有特权核心
- 对比问题：其他项目的“核心”到底有多厚？哪些能力必须回到核心里？

## D-A2 执行骨架
- dsh 的做法：ReactLoopAgent + Phase 状态机 + turn/step 双层
- 对比问题：其他项目的复杂度中心在 loop、controller、session，还是事件瀑布？

## D-A3 事件分派语义
- dsh 的做法：emit / waterfall / serial / parallel 四模式直接进入运行时
- 对比问题：其他项目的扩展点是回调、hook，还是有明确分派语义？

## D-A4 会话真相层
- dsh 的做法：Session 日志是事件源，模型可见即已记录
- 对比问题：其他项目的模型视图与持久化真相层是不是同一个系统？

## D-A5 Surface 投影
- dsh 的做法：user / assistant / tool-result 三类事件定义模型可见视图
- 对比问题：其他项目如何把历史状态投影成 provider-visible messages？

## D-A6 能力缝
- dsh 的做法：Service Definition / Provider / Consumer 三角色
- 对比问题：其他项目的能力边界是接口抽象，还是也能换 provider 换产品？

## D-A7 可逆效果
- dsh 的做法：注册即 effect，reload / teardown 可预测回滚
- 对比问题：其他项目在热插拔、替换、卸载时靠什么收口？

## D-A8 共享执行世界
- dsh 的做法：fs / subprocess / shell / sandbox 指向同一世界边界
- 对比问题：其他项目的执行世界是统一的，还是各工具各自维护状态？

## D-A9 持久化插件化
- dsh 的做法：JSONL / SQLite / projection 都是订阅 Session 事件的插件
- 对比问题：其他项目的持久化是核心内建，还是外围订阅者？

## D-A10 框架即产品
- dsh 的做法：profile / bundle / plugin 组合直接决定产品形态
- 对比问题：其他项目的产品形态更多靠配置、核心开关，还是也靠运行时组合？

---

## 三、一句话结论

如果只用一句话概括 dsh：

> **它代表了 Agent 架构里最“框架化”的路线——不是把能力堆到一个核心里，而是把运行时、会话、工具、持久化和执行世界都做成插件与能力缝。**
