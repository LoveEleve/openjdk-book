# Hermes LifecycleLedger 源码解析：系统死后为什么还能解释上一生命发生了什么

> 解析对象：`gateway/lifecycle_ledger.py`、`gateway/shutdown_watchdog.py`
> 定位：Hermes 第三份真正源码解析，验证“哨兵状态机 + 心跳内存采样 + 不洁死亡归因”这条生命周期主线。
> 关联机制分析：`hermes/07-DeliveryLedger与LifecycleLedger：Hermes 如何把交付和生命周期做成可追责的持久层.md`

---

## 一、解析对象

- 文件名：`gateway/lifecycle_ledger.py`、`gateway/shutdown_watchdog.py`
- 行数范围：哨兵文件写入、启动读取、mark running/exited、heartbeat 采样与不洁死亡判定主流程段
- 核心函数/方法：生命周期哨兵写入、`mark_running`、`mark_exited`、启动时读取上一生命状态、shutdown watchdog 心跳采样
- 入口事件/命令：gateway 启动、正常退出、异常死亡后下次启动
- 出口事件/返回：上一生命正常/异常退出判断、最近心跳与内存样本、OOM 启发标注、当前生命新哨兵状态

## 二、调用链

```text
gateway 启动
  → 读取 lifecycle sentinel
  → 判断上一生命是 running 还是 exited
  → 若上一生命未正常收尾，则生成不洁死亡记录
  → 当前生命 mark_running
  → watchdog 定期写入 heartbeat + 内存样本
  → 正常退出时 mark_exited
  → 下次启动再读取并完成归因
```

## 三、状态转换

| 状态 | 进入条件 | 离开条件 | 关键行 |
|------|----------|----------|--------|
| 无哨兵 | 首次启动或哨兵已清理 | mark_running | `lifecycle_ledger.py` 初始化段 |
| running | 当前生命已注册为运行中 | 正常退出或进程被杀 | mark running 段 |
| exited | 当前生命正常收尾 | 下次启动覆盖为新 running | mark exited 段 |
| unclean death detected | 下次启动发现上一生命仍是 running | 当前生命吸收并记录归因 | 启动判定段 |
| heartbeat fresh | watchdog 周期采样成功 | 下一次采样或退出 | `shutdown_watchdog.py` 心跳段 |

## 四、关键分支

| 分支 | 判断条件 | line | 结果 |
|------|----------|------|------|
| 正常退出 | 当前 pid 与哨兵 owner 一致且能写 exited | `lifecycle_ledger.py` owner 检查段 | 上一生命被标记为 clean exit |
| 不洁死亡 | 下次启动读到 phase=running | 启动归因段 | 认定上一生命异常中断 |
| OOM 启发标注 | 最近心跳显示高内存/异常模式 | lifecycle 分析段 | 仅提示，不做强判定 |
| --replace 场景 | 新旧进程竞争哨兵 | owner 守卫段 | 旧进程不得覆盖新生命哨兵 |
| 原子写保护 | 写哨兵时可能崩溃 | temp + replace + fsync 段 | 避免半写垃圾破坏取证 |

## 五、数据流

- 输入来源：当前进程 pid、启动/退出事件、watchdog 心跳、内存采样、上一生命哨兵文件
- 传递路径：启动读取旧哨兵 → 记录当前生命 running → 周期心跳更新 → 退出时写 exited → 下次启动归因
- 输出去向：生命周期哨兵文件、异常死亡归因记录、最近内存样本与 OOM 启发信息

## 六、测试契约

| 测试名 | 位置 | 验证内容 |
|--------|------|----------|
| lifecycle ledger 相关测试 | Hermes 项目中 `gateway/lifecycle_ledger.py` 测试集 | 验证 running/exited 状态机、不洁死亡检测、owner 守卫与原子写 |
| shutdown watchdog 相关测试 | `gateway/shutdown_watchdog.py` 相关测试 | 验证心跳采样、最近内存样本保留与异常归因输入 |

## 七、总结

- 核心结论：LifecycleLedger 不是监控日志，而是让系统在下一生命里仍能解释上一生命如何结束的持久化归因设施。
- 可迁移点：长跑 Agent 如果关心崩溃可解释性，应把运行中 / 已退出写成显式哨兵状态机，并把最近心跳作为死亡前最后证据。
- 易错点：只记录当前是否活着而不记录 owner、phase 和最近样本；那样系统重启后无法解释异常死亡上下文。
