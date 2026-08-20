# 01-dashboard-engine 重写规划

> 状态：重写前大纲
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 目标：把当前“Dashboard 定时引擎 / TimerTask”重构成一篇围绕“Dashboard 为什么不是一个简单 while(true) 循环，而是一条可暂停、可恢复、可失败终止、可快照替换的会话级刷新链”的机制文

## 1. 选题判断

这篇值得独立成篇，但不能继续写成：

- `DashboardCommand.process()` 做什么
- Timer 怎么创建
- `-n` 怎么计数
- `stop()` / `restart()` 怎么写
- `DashboardTimerTask.run()` 每 tick 采了什么

这种按定时器实现步骤平铺的说明文。

更好的统一问题是：

**用户眼里的 dashboard 只是一个“会自己刷新”的终端面板，为什么 Arthas 不能简单写成 `while(true) { collect(); sleep(interval); }`，而必须把它做成一个会话隔离、可取消、可恢复、按固定节拍刷新的定时引擎？**

这样本篇就不再是“TimerTask 导览”，而会被收束成一条更硬的刷新链：

- Dashboard 不是一次命令，而是一次会话级持续采样
- 刷新节拍、暂停恢复、退出、失败终止都属于同一个生命周期问题
- 每次 tick 不是改旧对象，而是重新组装一份快照模型
- 采集器和终端渲染必须分层，才能支持终端尺寸变化与周期性替换

## 2. 读者困惑

- `dashboard` 为什么不是一条执行完就结束的普通命令？
- 为什么 Arthas 不直接写一个 `while(true)` 循环刷新？
- 为什么每个 dashboard 会话都要 new 自己的 `Timer`？
- 为什么暂停 / 恢复不是简单停一停线程，而是 cancel 后重建 Timer？
- 为什么 tick 里要重新组装一份 `DashboardModel`，而不是原地改屏幕上的旧对象？
- 为什么定时任务异常不能静默掉，而必须终止命令？

## 3. 一句话顿悟

**Dashboard 不是一次命令调用，而是一条属于当前会话的持续刷新链：`DashboardCommand` 为每个会话创建独立的 daemon Timer，用固定节拍驱动 `DashboardTimerTask` 周期性组装新的 `DashboardModel` 快照；暂停、恢复、次数上限、失败终止与退出都围绕这条刷新链的生命周期来设计，而不是围绕一次同步方法调用来设计。**

## 4. 版本边界

正文开头必须明确：

- 基于 `arthas` 当前源码实现讨论
- 聚焦 Dashboard 的定时引擎与会话生命周期
- 不把各块数据具体来源（线程、内存、GC、Tomcat）扩写成本篇主线；这些留给下一篇 Dashboard 数据拼装
- 这里讲的是 Arthas 当前 Java Timer 模型，不等于所有终端 dashboard 都必须采用 `Timer + TimerTask`

## 5. 旧稿主要问题

### 5.1 已有优点

- 已经抓到“Dashboard 不是 while(true)”这个关键切口
- Timer / fixedRate / `-n` / stop / restart / `DashboardTimerTask.run()` 的关键锚点完整
- 已经看到采集引擎与终端视图之间通过 `DashboardModel` 隔离
- 已经指出每个会话都有独立 Timer，不共享全局刷新线程

### 5.2 必须修复的问题

- 当前骨架仍偏“TimerTask 实现说明文”，冲突感还不够强
- 失败方案推演不够厚：为什么不能 `while(true)`、为什么不能复用 cancel 后的 Timer、为什么不能在旧对象上原地更新，都还没打透
- fixedRate 语义虽然提到了，但还没完全收回到“面板追求节拍而不是固定延迟”的主线
- `DashboardTimerTask` 每 tick 的采集链讲得比较全，但还没完全压成“快照替换而不是状态原地突变”这个更大的判断

## 6. 重写策略

本篇不按代码执行顺序平铺，而按更强的问题链组织：

1. 先建立冲突：dashboard 看起来像一个会自己刷新的面板，但它不是普通命令
2. 先排除几个错误直觉：
   - `while(true) + sleep`
   - 全局共享一个刷新线程
   - cancel 后继续复用同一个 Timer
   - 直接原地修改旧表格对象
3. 再给总图：会话级 Timer → 固定节拍 tick → 组装快照模型 → appendResult → 视图刷新
4. 然后分层拆：
   - `DashboardCommand` 如何把普通命令变成持续会话
   - Timer / fixedRate 为什么服务于“节拍刷新”
   - 暂停 / 恢复 / `-n` / Ctrl-C / q 为什么都属于同一条生命周期
   - `DashboardTimerTask` 为什么每次都重建一份模型快照
   - 异常为什么必须终止命令而不是静默掉
5. 最后收束成“会话级刷新链 + 快照替换”的设计哲学

## 7. 结构大纲（按理解路径）

### 第一节：事故开场——为什么 Dashboard 不是一条执行完就结束的普通命令

目标：建立真实困惑，而不是直接讲 Timer。

要回答：

- `dashboard` 看起来像命令，实际上是一个持续刷新的会话
- 用户关心的是“面板为什么会持续更新”，不是“某个方法返回了什么”
- 本篇真正要追的是刷新链的生命周期

预估字数：900-1100

### 第二节：先排除几个错误直觉——`while(true)`、全局刷新线程、复用旧 Timer、原地改旧对象

目标：做失败方案推演。

要回答：

- 为什么不能直接 `while(running) { collect(); sleep(interval); }`
- 为什么每个会话不能共享一个全局刷新线程
- 为什么 cancel 后的 Timer 不能继续复用
- 为什么不能直接在旧表格对象上原地改字段

预估字数：1400-1700

### 第三节：第一层——`DashboardCommand` 为什么要把普通命令变成会话级定时器

目标：把 `process()` 写成“命令生命周期升级器”。

要回答：

- `new Timer("Timer-for-arthas-dashboard-" + sessionId, true)` 为什么带会话 id 且是 daemon
- 为什么注册 Ctrl-C、suspend/resume、end、q 这些处理器
- 为什么 `dashboard` 的生命周期从一开始就不是“一次 process() 返回”

证据锚点：

- `core/command/monitor200/DashboardCommand.java:76-109`

预估字数：1600-1900

### 第四节：第二层——为什么 Dashboard 选的是 fixedRate，而不是“上次结束后再等一会儿”

目标：把 fixedRate 写成“面板节拍模型”的核心。

要回答：

- `scheduleAtFixedRate` 的语义是什么
- 为什么面板更在意节拍，而不是严格的固定延迟
- 任务耗时过长时会怎样影响节奏
- 默认 `5000ms` 为什么是交互刷新折中，而不是魔法常数

证据锚点：

- `DashboardCommand.java:55-58`
- `DashboardCommand.java:68-72`
- `DashboardCommand.java:107-108`

预估字数：1500-1800

### 第五节：第三层——为什么暂停、恢复、次数上限、退出都属于同一条生命周期

目标：把 `-n`、Ctrl-C、suspend/resume、q 收成一条统一的刷新生命周期。

要回答：

- `-n` 为什么是“先 cancel / purge / end”，而不是多刷一次再退
- `stop()` 为什么必须 cancel 并置空 Timer
- `restart()` 为什么要重建 Timer 而不是复用原对象
- Ctrl-C、q、end 最终为什么都要落回“先停定时任务”

证据锚点：

- `DashboardCommand.java:111-125`
- `DashboardCommand.java:227-235`
- `DashboardInterruptHandler.java:20-24`

预估字数：1800-2200

### 第六节：第四层——为什么每次 tick 都要重新组装一份 `DashboardModel`

目标：把 `DashboardTimerTask.run()` 写成“快照替换链”，而不是定时字段更新。

要回答：

- 每个 tick 按什么顺序采集线程、CPU、内存、GC、运行时、Tomcat
- 为什么 `DashboardTimerTask` 要持有自己的 `ThreadSampler`
- 为什么每次是组装一个全量模型，而不是增量改旧对象
- `appendResult` 与 `DashboardView.draw()` 如何把采集与终端绘制解耦

证据锚点：

- `DashboardCommand.java:218-270`
- `DashboardCommand.java:238-263`
- `DashboardView.java:23-70`

预估字数：1900-2300

### 第七节：第五层——为什么定时任务异常必须终止命令，而不是静默消失

目标：把异常处理写成刷新链的失败安全边界。

要回答：

- 为什么 Timer 线程异常一旦静默掉，用户只会看到“面板不再刷新”这种最糟糕的表象
- `try/catch + process.end(-1, msg)` 真正保护了什么
- 为什么失败终止比“悄悄死掉”更符合诊断工具语义

证据锚点：

- `DashboardCommand.java:227-268`

预估字数：1200-1500

### 第八节：收网——Dashboard 不是 while(true)，而是一条会话级的固定节拍快照刷新链

目标：把全文收成一句话并桥接下一篇。

必须点名：

- 会话级 Timer
- fixedRate 节拍
- 生命周期控制
- `DashboardModel` 快照替换
- 下一篇数据来源

预估字数：800-1000

## 8. 必须展开的失败方案

至少要展开以下失败方案：

1. 用 `while(true) + sleep` 实现 dashboard
2. 所有 dashboard 会话共用一个全局刷新线程
3. cancel 后继续复用原 Timer
4. 每 tick 原地修改旧表格对象
5. TimerTask 抛异常后静默消失

## 9. 本篇必须明确澄清的误解

1. `dashboard` 不是一次普通命令调用，而是一条持续会话
2. fixedRate 追求的是刷新节拍，不是任务结束后的固定延迟
3. cancel 过的 Timer 不能复用
4. `DashboardModel` 是快照输出模型，不是长寿命可变状态对象
5. 采集器不直接操作屏幕光标，视图刷新发生在 `appendResult -> DashboardView.draw()` 之后
6. TimerTask 异常不会被故意吞掉，而是要结束命令

## 10. 证据清单（正文托底）

- `core/command/monitor200/DashboardCommand.java:55-58`
- `DashboardCommand.java:68-72`
- `DashboardCommand.java:76-109`
- `DashboardCommand.java:111-125`
- `DashboardCommand.java:218-270`
- `DashboardCommand.java:227-235`
- `DashboardCommand.java:238-263`
- `DashboardInterruptHandler.java:20-24`
- `DashboardView.java:23-70`

## 11. 字数预算

- 目标正文总字数：`8500-11000`
- 叙述性正文目标：`5500+`

## 12. 完成后必须通过的检查

1. 删除代码后，主线是否仍然成立
2. 是否清楚回答了“为什么 dashboard 不是 while(true)”
3. 是否至少展开了 4 个失败方案
4. 是否把 Timer、生命周期、快照组装、视图刷新统一到同一条会话刷新链上
5. 是否明确把具体数据来源留给下一篇
6. 是否完成 `file:line` 重核与边界声明
