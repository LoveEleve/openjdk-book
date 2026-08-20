# 12. Dashboard 为什么不是一个 `while(true)`？——会话级 Timer、固定节拍与快照刷新链

> 基于 `arthas` 当前源码实现讨论；本文聚焦 Dashboard 的定时引擎与会话生命周期，不把线程/内存/GC/Tomcat 各块数据来源展开成主线，也不把下一篇数据拼装细节提前写进来。
> **前置依赖**：[11 —— CPU 最忙的线程，为什么未必是真堵点？](../03-thread-lock/03-blocking-deadlock.md)：知道线程、CPU 和锁数据分别从哪里来。
> → **后续**：Dashboard 数据拼装——线程、内存、GC、运行时和 Tomcat 指标从哪里来。
> 关联域：Java Timer、会话生命周期、快照模型输出。
> 本篇所有源码锚点均已回对，不靠猜。

## 先看一个最容易被低估的动作：你只是敲了 `dashboard`，为什么它却不像普通命令那样执行完就结束

场景：你在终端执行：

```text
dashboard
```

随后屏幕开始每隔几秒刷新一次。对用户来说，这像一个“自己会更新”的面板；但在源码层面，它已经不再像一条普通命令那样：

```text
输入一行
  → process()
    → 返回结果
      → 结束
```

于是一个极其自然的直觉就会冒出来：

> 既然它只是不断采集数据再刷新，那直接写成 `while(true) { collect(); sleep(interval); }` 不就行了？

这个想法看似简单，放到 Arthas 的真实环境里却会立刻撞墙：

- Dashboard 是**会话级功能**，不同终端会话互不该干扰；
- 它必须支持 Ctrl-C、q、暂停、恢复、次数上限 `-n`；
- 定时任务异常不能悄悄死掉；
- 刷新面板不应该原地修改某个长寿命对象，而应该输出一份新的快照模型；
- 采集引擎也不该自己去理解终端宽高和清屏细节。

所以本篇真正要回答的不是：

> Dashboard 的 TimerTask 里都采了哪些数据？

而是：

> **用户眼里的 dashboard 只是一个“会自己刷新”的终端面板，为什么 Arthas 不能简单写成 `while(true)` 循环，而必须把它做成一个会话隔离、可取消、可恢复、可失败终止、可快照替换的定时引擎？**

先把全篇总图立住：

```text
用户执行 dashboard
  → DashboardCommand 为当前会话创建独立 Timer
    → scheduleAtFixedRate 周期触发 DashboardTimerTask
      → 每次 tick 重新组装一份 DashboardModel 快照
        → process.appendResult(model)
          → 视图层按当前终端状态重新绘制
            → Ctrl-C / q / -n / suspend / end 再负责结束或重建这条刷新链
```

这张图里最重要的两刀是：

```text
dashboard 不是一次普通命令
而是一条属于当前会话的持续刷新链

每次刷新不是原地改旧对象
而是重新产出一份快照模型
```

后面所有细节，都围绕这两条边界展开。

---

## 一、先排除几个最直觉、也最容易把刷新链搞乱的方案

### 1.1 错觉一：用 `while(true) + sleep(interval)` 就够了

最直觉的实现当然是：

```java
while (running) {
    collect();
    Thread.sleep(interval);
}
```

这在单线程 demo 里可能没问题，但放到 Arthas 这种终端会话工具里，很快就会暴露缺陷：

- 这一整条循环会天然绑定在当前命令执行上下文里；
- Ctrl-C、q、pause/resume、次数上限等控制语义不好统一收束；
- 一旦异常抛出，用户看到的可能只是“面板不再刷新”，却不知道到底是哪一步挂了；
- 多个 dashboard 会话之间也不容易自然隔离。

也就是说，Dashboard 面对的不是“如何周期性跑一个函数”这么简单，而是：**如何让一条持续刷新链拥有和命令会话一样明确的生命周期。**

### 1.2 错觉二：所有 dashboard 会话共用一个全局刷新线程

另一个看似节省资源的方案是：

> 大家都在刷新 dashboard，不如整个 JVM 里就共享一个全局调度线程。

这会马上引入会话污染：

- 一个会话退出，另一个会话不该被影响；
- 一个会话暂停，另一个会话不该跟着停；
- 一个会话改成更短间隔，也不该牵动别的会话节拍。

所以对 Arthas 来说，dashboard 首先不是“一个系统级任务”，而是“一个用户会话自己拥有的持续刷新行为”。

### 1.3 错觉三：cancel 以后还能继续复用同一个 Timer

如果你把 Timer 看成“一个可停可启的按钮”，那会自然觉得：

> 暂停时 cancel，恢复时再拿同一个 Timer 继续 schedule 不就好了？

可 Timer 在 Java 语义里不是这么设计的：cancel 之后，原 Timer 线程已经终止，不能再被复用。也就是说，恢复不是“继续用旧对象”，而是**重建一条新的刷新链**。

### 1.4 错觉四：每次 tick 原地修改旧面板对象就行

最后一个很常见的直觉是：

> 反正屏幕上已经有一张表格了，每次 tick 在旧对象上改字段、改行号、改颜色就行。

这个想法会把采集层和渲染层粘到一起：

- 采集器必须知道终端宽高；
- 采集器必须自己处理清屏/重画协议；
- 一旦视图布局变化，采集逻辑也会跟着被污染。

Arthas 更克制的做法是：每次 tick 重新产出一份完整 `DashboardModel`，再交给视图层去决定怎样画出来。

---

## 二、第一层：`DashboardCommand` 为什么要把普通命令变成会话级定时器

### 2.1 dashboard 的 `process()` 从一开始就不是“一次调用后立刻返回”

`core/command/monitor200/DashboardCommand.java:76-109` 的 `process()` 里，最显眼的动作不是数据采集，而是：

```java
new Timer("Timer-for-arthas-dashboard-" + sessionId, true)
```

这里有两层含义：

- 名字里带 `sessionId`，说明 Timer 是为当前会话单独创建的；
- 第二个参数 `true` 表示 daemon 线程，说明它不该因为 Dashboard 自己的刷新线程而阻止 JVM 退出。

也就是说，Arthas 从这一步就已经明确把 dashboard 定义成：

```text
属于当前会话的一条独立刷新链
```

### 2.2 为什么还要注册 Ctrl-C、q、suspend/resume、end 这些处理器

`DashboardCommand.process()` 不是只 new 完 Timer 就结束。它还会注册：

- Ctrl-C 处理器；
- suspend / resume 处理器；
- end 处理器；
- stdin 的 q 退出处理器。

这说明 dashboard 的生命周期从一开始就不围绕“函数什么时候跑完”设计，而是围绕：

- 用户何时主动中断；
- 会话何时结束；
- 刷新何时被暂停；
- 刷新何时被重启。

关键设计（斜体）：*Dashboard 不是一条命令执行完就结束的同步调用，而是一次与用户会话绑在一起的持续刷新行为。*[模式: 会话级定时器 + 生命周期钩子] Timer 只是驱动器，真正要被管理的是这条刷新链的生死。

---

## 三、第二层：为什么 Dashboard 选的是 fixedRate，而不是“上次结束后再等一会儿”

### 3.1 面板真正追求的是“节拍感”，不是“执行完再补眠”

`DashboardCommand.java:107-108` 用的是：

```java
timer.scheduleAtFixedRate(new DashboardTimerTask(process), 0, getInterval())
```

而不是“上一轮结束后再 sleep 一个完整间隔”。这意味着 dashboard 把自己定义成一个**按时间节拍触发**的面板：

```text
0s、5s、10s、15s ... 这些时间点该刷就刷
```

而不是：

```text
上一轮采集花了多久
  → 结束后再等 5s
    → 下一轮再开始
```

### 3.2 为什么 fixedRate 更适合交互式面板

对面板来说，用户更在意的是“它看起来是按固定节奏刷新”，而不是“每次任务之间恰好留出相同空档”。

所以 fixedRate 的优势在于：

- 正常情况下，刷新节奏更贴近用户配置的时间拍点；
- 用户更容易建立“每隔几秒看一眼”的节奏感；
- 这是一个终端面板，而不是后台批处理任务。

### 3.3 为什么任务过慢时，这条节拍链反而更值得被注意

fixedRate 也有代价：如果某次采集时间过长，下一轮仍会受固定节拍影响，可能出现延迟执行或追赶。可这恰好暴露出另一个事实：**dashboard 本来就是一条有节拍要求的刷新链，任务慢了本身就是你该注意的异常信号。**

### 3.4 为什么 `5000ms` 不是某种神奇常数

默认间隔来自 `DashboardCommand.java:55-58`，也可以通过 `-i/--interval`（`:68-72`）调整。

这个值更像一个交互折中：

- 太短，面板会频繁刷新，干扰读屏，也更容易暴露抖动；
- 太长，用户又会觉得“这玩意儿不够实时”。

关键设计（斜体）：*fixedRate 不是技术炫技，而是在强调 Dashboard 追求的是会话内的刷新节拍。*[模式: 固定节拍调度]

---

## 四、第三层：为什么暂停、恢复、次数上限、退出都属于同一条生命周期

### 4.1 `-n` 为什么不是“多刷一次再退出”

`DashboardTimerTask.run()` 每次开头都会先检查次数上限（`DashboardCommand.java:227-235`）：

```java
if (count.get() >= getNumOfExecutions()) {
    timer.cancel();
    timer.purge();
    process.end(0, ...);
    return;
}
```

注意这里的顺序：先 cancel / purge / end，再 return。它不是“最后一次采完再顺便退掉”，而是明确把“次数到期”当成刷新链的生命周期终点。

### 4.2 为什么 `stop()` 必须 cancel 并置空 Timer

`DashboardCommand.java:111-117` 的 `stop()`：

```java
if (timer != null) {
    timer.cancel();
    timer.purge();
    timer = null;
}
```

这说明暂停/结束不是简单设置一个布尔位，而是把原刷新链明确终止并清掉引用。否则你根本不知道后面是不是还有旧 Timer 线程在后台每 5 秒悄悄采集一次数据。

### 4.3 为什么 `restart()` 必须重建 Timer，而不是复用旧对象

`DashboardCommand.java:119-125` 的 `restart()` 会在 Timer 已为空时重新 new 一个，再次 `scheduleAtFixedRate`。这不是实现随意，而是 Timer 语义决定的：**cancel 后的 Timer 线程已经死了，不能继续拿原对象恢复。**

所以恢复不是“让旧链醒过来”，而是“建一条新的刷新链”。

### 4.4 为什么 Ctrl-C、q、end 最终都要落回“先停定时任务”

`DashboardInterruptHandler.handle()`（`DashboardInterruptHandler.java:20-24`）会先取消它持有的 Timer，再把控制权交给父处理器；stdin 的 q 退出、会话 end，也最终都要让这条刷新链停掉。

关键设计（斜体）：*Dashboard 的所有退出路径首先都不是“结束一条命令”，而是“终止一条定时刷新链”。*[模式: 生命周期对称收口]

---

## 五、第四层：为什么每次 tick 都要重新组装一份 `DashboardModel`

### 5.1 Dashboard 不是在原地改一张旧表，而是在周期性产出新快照

真正的刷新任务在 `DashboardCommand.java:218-270` 的 `DashboardTimerTask.run()`。每次 tick 的顺序是：

1. 检查 `-n` 次数；
2. 创建 `DashboardModel`；
3. `ThreadUtil.getThreads()` 枚举线程；
4. `threadSampler.sample(threads)` 填充线程 CPU 与时间；
5. `MemoryCommand.memoryInfo()` 获取内存数据；
6. `addGcInfo()` 聚合 GC 数据；
7. `addRuntimeInfo()` 获取运行时与 OS 信息；
8. 尝试补充 Tomcat 数据；
9. `process.appendResult(dashboardModel)` 输出完整模型。

这里最重要的不是“它采了哪些字段”，而是：**每次 tick 都重新产出一份完整快照，而不是在旧对象上原地修修补补。**

### 5.2 为什么 `DashboardTimerTask` 要持有自己的 `ThreadSampler`

`DashboardTimerTask` 自己持有一个 `ThreadSampler`（`DashboardCommand.java:218-225`）。这说明 dashboard 跨 tick 会复用 CPU 基线状态，而不是每次刷新都像独立的 `thread -n` 命令那样从头开始。

也就是说，Dashboard 不是“每 5 秒临时执行一次 `thread -n` 的拼盘”，而是：

```text
在同一个会话刷新链里
持续复用采样器状态
周期性产出新的全量模型快照
```

### 5.3 为什么采集器不直接操作屏幕光标

`run()` 每次只是 `process.appendResult(dashboardModel)`。真正绘制发生在 `DashboardView.draw()`（`DashboardView.java:23-70`），视图层会根据当前终端宽高重新布局线程、内存/GC、运行时/Tomcat 三块区域。

这意味着采集层和渲染层被明确拆开：

- 采集层只负责这次快照里有什么；
- 视图层才负责这次快照怎样画出来。

关键设计（斜体）：*每次 tick 重建的是一份“当前系统快照”，而不是一块会被原地修改的长寿命面板对象。*[模式: 快照组装 + 视图替换]

---

## 六、第五层：为什么定时任务异常必须终止命令，而不是静默消失

### 6.1 Dashboard 最糟糕的失败方式，不是报错，而是悄悄不刷新了

如果定时任务异常被静默吃掉，用户看到的表象只会是：

- 面板停在某一帧；
- 好像“还在那儿”，但其实已经死了；
- 你不知道到底是线程采样坏了，还是 GC 采集坏了，还是 Tomcat 数据坏了。

这对诊断工具来说是最糟糕的体验：表面看没报错，实际上已经停止提供有效观察。

### 6.2 为什么 `process.end(-1, msg)` 比“悄悄死掉”更符合诊断语义

`DashboardCommand.java:227-268` 的 `run()` 主体被 `try/catch` 包住。采集或模型组装一旦抛异常，Dashboard 会记录日志，并用 `process.end(-1, msg)` 结束命令。

这其实是在明确声明：**一条失效的刷新链，不应该继续伪装成一个还活着的面板。**

关键设计（斜体）：*对 Dashboard 这种持续诊断链来说，显式失败终止比静默停止更诚实。*[模式: 失败可见性 + 命令终止]

---

## 收网：Dashboard 不是一个 `while(true)`，而是一条会话级、固定节拍的快照刷新链

现在把整条链收成一张图：

```text
1. 用户执行 dashboard
2. DashboardCommand 为当前会话创建独立 daemon Timer
3. fixedRate 按固定节拍触发 DashboardTimerTask
4. 每次 tick 重新组装一份完整 DashboardModel 快照
5. appendResult 把快照交给视图层重新绘制
6. Ctrl-C / q / -n / suspend / end 再统一收束到“终止或重建这条刷新链”
```

把这张图压成一句话，就是：

**Dashboard 不是一个简单的 `while(true)` 循环，而是一条属于当前会话的、按固定节拍推进的快照刷新链：`DashboardCommand` 负责为会话建立和销毁这条链，`DashboardTimerTask` 负责周期性生成新的 `DashboardModel`，视图层再负责把这份快照重画到终端上。**

到这里为止，主线其实只发生了四件事：

- dashboard 不是一次普通命令，而是一条持续会话；
- Timer 不是系统全局资源，而是每个会话自己的刷新驱动器；
- 每次刷新不是修改旧对象，而是替换一份新快照；
- 异常、次数上限、暂停恢复和退出，都是同一条刷新链的生命周期控制问题。

这也解释了为什么 Arthas 不能把 dashboard 简单写成 `while(true)`：**它真正要管理的不是“重复执行一个函数”，而是一条既要会刷新、又要会停、会恢复、会失败、还要和会话绑定的面板生命周期。**

跨层标注：[Java Timer——daemon 线程、fixedRate 调度与 cancel 生命周期]；[命令会话——Ctrl-C / q / end / suspend / resume 统一汇入生命周期控制]；[快照模型——`DashboardModel` 作为采集层与视图层的边界]；[视图刷新——`appendResult -> DashboardView.draw()` 的替换链]

本篇解决的是“为什么 Dashboard 不是一个简单 while(true)，而是一条会话级、固定节拍的快照刷新链”。下一篇继续进入这条链的内容面：**线程、CPU、内存、GC、运行时和 Tomcat 指标，到底分别从哪里来，又怎样被拼成这一张面板？**

**→ 下一篇：Dashboard 数据拼装与指标来源。**
