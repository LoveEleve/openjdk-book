# 域 00 深度 REVIEW 报告 v4 — 配置契约层 + AP 实测

> 2026-08-11 | v4 | 依据: default.jfc/profile.jfc 配置对比(实测)+ async-profiler 4.4 实操(attach/火焰图/jfrsync)+ merged2.jfr 事件分析
> 层级说明: v1=工具→域, v2=事件→域, v3=字段级+工具侧对照, v4=**JFR 配置契约层(threshold/period 决定素材量)+ AP 4.4 实测**

---

## 一、配置层契约(default.jfc vs profile.jfc)——决定素材采集策略

**事件开启数**(实测):
- default.jfc: 82 个 enabled / profile.jfc: 83 个 enabled
- profile ⊇ default(独有 4 个): CompilationFailure、JavaMonitorInflate、PromoteObjectInNewPLAB、PromoteObjectOutsidePLAB

**threshold/period 差异(关键!决定素材量)**:

| 事件 | default | profile | 影响 |
|---|---|---|---|
| SafepointBegin | **threshold 10ms**(只记 >10ms!) | 0ms(全部) | 域 18: default 会漏掉绝大多数 safepoint |
| JavaMonitorEnter | 20ms | 10ms | 域 19: 短锁竞争 default 看不到 |
| ThreadSleep/ThreadPark | 20ms | 10ms | 域 17: 短睡眠被滤掉 |
| ExecutionSample | 间隔 20ms | 10ms | 域 24/32: 采样密度差一倍 |
| ObjectAllocationSample | 同(默认打开) | 同 | - |

**结论(素材策略)**:
1. **写 safepoint/锁/IO/采样文章,必须用 profile 设置**(`settings=profile`)——default 的 threshold 会系统性漏数据(rec.jfr 的 math-game 录制数据少,正是 default 配置)
2. default 定位 = 生产低开销持续录制(<1% 开销),profile 定位 = 诊断期精细采样
3. 写作素材: "同 30 秒,default 录 X 条 safepoint,profile 录 Y 条" 是域 18/25 的现成对比实证

---

## 二、async-profiler 4.4 实测(两种写者机制验证)

**版本确认**: Arthas 仓库 .so = **async-profiler 4.4**(strings 实证)——非"旧版",是较新版本

**实测结果**:
| 操作 | 结果 |
|---|---|
| agentpath 启动采样(CPU) | ✅ 采样成功,火焰图 `ap-flame.html` 生成 |
| attach 到已运行进程(`=start,event=cpu`) | ✅ "Profiling started",独立采样 |
| **独立 JFR 输出**(`agentpath=start,event=cpu,file=x.jfr` + SIGTERM flush) | ✅ **打通(v4 终版)**: `ap-target.jfr` 238KB/20s/格式 2.0/**ExecutionSample 6282 条**/CPULoad/GCHeapSummary——**已被 jfr CLI 成功解析**("两种写者"完整实证) |
| jfrsync=<.jfc 路径>(写 JDK JFR recording) | ✅ **完全打通(v4 终版)**: JDK21 + `jfrsync=profile.jfc` → ap21-sync.jfr(27MB/35s,格式 2.1)——一个文件同时含 JDK 全量事件(GCPhaseParallel 83万/SafepointBegin 1548)+ AP 采样;关键: jfrsync 的值必须是合法 JFR 配置(路径或 "default"/"profile") |
| JFR 内 MethodTrace 事件 | 独立模式不写(JDK JFR 内 MethodTrace 未验证,不影响独立模式) |

**"两种写者"实证达成(双模式)**:
- **独立模式**(JDK17/21 通用): AP 写独立 .jfr(格式 2.0,ExecutionSample 6282 条)
- **jfrsync 模式**(JDK21,推荐): `jfrsync=<.jfc路径或名>` → AP 启动 JDK JFR recording,**一个文件含 JDK 全量事件 + AP 采样**(ap21-sync.jfr: GCPhaseParallel 83万 + SafepointBegin 1548 + ObjectAllocationSample 5180)

**两种模式正确用法(归档到执行计划 A7)**:
```
# 模式 1: 独立 JFR 输出(JDK17/21)
java -agentpath:<so>=start,event=cpu,file=<out>.jfr -jar app.jar
kill -SIGTERM <pid>    # AP flush 采样

# 模式 2: jfrsync 合并输出(JDK21,一个文件两种来源)
java -agentpath:<so>=start,event=cpu,jfrsync=/path/profile.jfc,file=<out>.jfr -jar app.jar
kill -SIGTERM <pid>    # 合并落盘
```
> 坑: jfrsync 的值 = JFR 配置(路径或 "default"/"profile"),传 "true"/事件名会报 NoSuchFileException

---

## 三、素材库新增(本 REVIEW 期间实测产物)

| 文件 | 大小 | 内容 | 归入 |
|---|---|---|---|
| merged.jfr | 161MB | JFR.start 60s(Demo,default 配置) | materials/jfr-recordings/ |
| merged2.jfr | 127MB | JFR.start 60s + AP attach(采样面) | materials/jfr-recordings/ |
| ap-flame.html | 13KB | AP 4.4 CPU 火焰图 | materials/screenshots/ |
| ap-demo.log | - | AP attach 过程(Profiling started) | materials/commands/ |

> Demo.java 寿命已改为 600s(避免反复重启),源码存 /data/tmp/opencode/Demo.java

---

## 四、就绪度增量更新

- A7(async-profiler 录 JFR)从"待验证"改为"🔶 部分验证": 火焰图 ✅ / jfrsync ❌(风险表已列回退)
- 配置契约结论进入执行计划 B1: 素材采集统一用 `settings=profile`(除 default 对比素材外)

---

## 五、建议行动(v4)

1. **执行计划 B1 更新**: 录制命令统一 `JFR.start ... settings=profile`;增加"default vs profile 对比素材"任务(B1.9,1 个 30s 对比实验)
2. **A7 状态改 🔶**: jfrsync 作为遗留验证项(新版 AP converter 或参数修正);写作表述用"格式兼容设计"
3. **配置契约进 KP**: KP 新增 10 节"配置契约"(default/profile 差异表)——素材采集策略依据
4. **风险表更新**: 已有"事件未触发"风险,补充"threshold 过滤"维度(default 会漏短事件)
