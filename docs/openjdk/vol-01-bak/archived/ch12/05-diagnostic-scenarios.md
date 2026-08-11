# 12.5 实战诊断场景

> **本文定位**：前 4 篇的综合运用——将 jstat、jcmd、NMT、JFR 全部 7 条诊断通道横向联用，完成 4 种 Metaspace 生产问题的完整排查。每种场景按"现象 → 诊断指标 → 分步排查链 → 根因决策树"组织，内含具体命令和预期输出。
>
> **前置依赖**：12.1-12.4 全部——每条通道的开启方式、数据源、输出含义、性能代价已在前面讲透。本文只做横向联用，不重复解释单条通道。
>
> **JDK 版本**：本文基于 **JDK 11u**，命令示例使用 jdk11u-copy 验证。

---

## 场景 1：MU 持续增长从不回落 → 类泄漏

### 现象

`jstat -gc <pid> 5s` 连续观测，MU 从启动时的 0（首次 GC 后变为非零）持续上升，从未回落（以下为模拟泄漏场景数据，T+0 为 jdk11u-copy 实测值）：

```
# jstat -gc 每 5 秒一次 (T+5~T+20 为模拟泄漏趋势)
时刻  MC(KB)  MU(KB)  CCSC  CCSU  FGC
T+0    7168    6887   768   627   2     ← 实测
T+5    7168    6998   768   640   2     ← 模拟
T+10   7680    7210   768   652   2
T+15   7680    7450   768   680   2
T+20   8192    7800   768   701   2
```

MU 只涨不跌——典型类泄漏信号。

### 判断标准

| 指标 | 健康信号 | 泄漏信号 |
|------|---------|---------|
| MU 趋势 | 随 GC 上下波动 | 单向上升，从不回落 |
| FGC 计数 | 递增 | 递增但 MU 不降 |
| `jcmd show-loaders` | 各类 loader used 稳定 | 某个 loader used 持续增长 |
| NMT diff | mtClass committed 有升有降 | mtClass committed 只升不降 |

### 排查链路

```
Step 1: jstat 确认趋势 → Step 2: jcmd 定位元凶 CLD → Step 3: NMT diff 时间线确认 → Step 4: jmap 验证死活 → Step 5: 判定根因
```

**Step 1：`jstat` 确认趋势**（免费，不需要附加参数）

```bash
jstat -gc <pid> 5s       # 每 5s 采样，观察 MU 走势
```

**Step 2：`jcmd VM.metaspace show-loaders` 定位元凶 CLD**

```bash
jcmd <pid> VM.metaspace show-loaders=true
```

找 per-CLD 输出中 `used` 最大的那一行。注意区分三种 loader 类型：

- **`<bootstrap>`**：bootstrap class loader——通常最大（加载所有 JDK 核心类），正常范围几十 MB
- **`"app"` 实例**：应用类加载器——正常增长但快速回落到几十 MB
- **`<anonymous>` 或自定义 loader**：动态类加载器——**重点嫌疑对象**。如果有大量匿名 CLD 且每个的 used 都在增长 → 类泄漏

**Step 3：NMT baseline + diff 确认时间线**

```bash
jcmd <pid> VM.native_memory baseline
# 等 30 分钟
jcmd <pid> VM.native_memory summary.diff
```

查看 `Class` 行——如果 `committed` 的变化量持续为正：

```
-Class (reserved=... +24576KB, committed=... +128KB)
    (Metadata: committed=... +64KB)
```

committed 持续 + → 确认 Metaspace 在增长，而不是 jstat 的读数延迟。

**Step 4：`jmap -clstats` 验证 CLD 死活**

```bash
jmap -clstats <pid>
```

输出每一行的 `parent` 字段和 `loader` 大小。注意标注 `dead` 的 CLD——如果大量 CLD 标记为 dead 但对应的 Metaspace 内存没释放 → GC 频率不够或引用未清。

**Step 5：根因判定**

| 根因 | NMT diff 信号 | jcmd per-CLD 信号 | jmap -clstats 信号 |
|------|-------------|-----------------|-------------------|
| **动态类生成不缓存** | committed 持续 +，used 同步 + | 同一个或几个 CLD 的 used 持续增长 | 无 dead CLD，活跃 CLD 的类数持续增加 |
| **类加载器泄漏** | committed 持续 +，used 同步 + | 大量不同类型的 CLD，每个 used 都在增长 | 大量活跃 CLD + 少量 dead CLD |
| **ThreadLocal 持有 loader** | committed 和 used 都不降 | CLD 个数不断增加 | 新 CLD 持续出现，旧 CLD 不死 |
| **Groovy/JSP 动态编译** | committed + used 快速波动 | 短暂 CLD 大量出现又消失 | 大量短期活跃 CLD |

---

## 场景 2：MC >> MU → Metaspace 碎片化

### 现象

`jstat` 显示 MC（committed）远大于 MU（used），差距超过 50MB 且持续（模拟数据）：

```
# jstat -gc
MC=204800KB  MU=40960KB  差距=163840KB (80%)
```

### 判断标准

| 指标 | 健康 | 碎片化 |
|------|-----|--------|
| MC - MU 差距 | < 20% | > 50% 且持续 |
| Chunk freelists | 几 KB ~ 几十 KB | 几十 MB |
| `show-vslist` container_count | 大部分 Node 的 container_count > 0（有活跃 chunk，整个 Node 无法被 purge） |
| Full GC 后 MC | 回落到接近 MU | 下降不明显 |

### 排查链路

```
jstat 确认差距 → jcmd 看 freelist → GC.run 触发 GC → 判断 purge 效果 → 根因
```

**Step 1：`jstat` 确认差距**

```bash
jstat -gc <pid>
# MC=204800, MU=40960, 差距 = 160MB
```

**Step 2：`jcmd VM.metaspace` 检查 freelist 和 VS 详情**

```bash
jcmd <pid> VM.metaspace basic=true
```

关注 Chunk freelists 行——

```
Chunk freelists: (模拟数据)
   Non-Class:  120.50 MB    ← 堆积在 freelist 中！
       Class:   35.20 MB
        Both:  155.70 MB
```

如果 freelist 总���接近 MC-MU 差额 → **碎片化**——大量 chunk 已归还但未被复用，也无法整个 Node 被 purge。

**Step 3：`jcmd GC.run` 触发 Full GC，观测 purge 效果**

```bash
jcmd <pid> GC.run
# 等 5 秒让 GC 完成
jstat -gc <pid>      # 看 MC 是否回落
```

Full GC 后分两种结果：

- **MC 大幅下降（如从 200MB 降到 50MB）** → purge 成功（有空 Node 被整个 munmap）——正常，只是 GC 频率不够导致 Node 未及时释放
- **MC 下降不明显（如从 200MB 降到 180MB）** → 碎片化严重——freelist 中的 chunk 物理不连续，coalesce 失败，Node 不能整个释放

**Step 4：根因判定**

| 根因 | 特征 | 修复 |
|------|------|------|
| **chunk size class 不匹配** | 小 chunk 数量特别多（Specialized/Small） | 增大 `MetaspaceSize` 减少 chunk 频繁进出 |
| **大量小 CLD 动态创建** | CLD 数量持续增长（几百到上千个） | 类加载器池化 |
| **freelist 碎片化（JDK 11 局限）** | 上面两步后 MC 仍不降 | 升级 JDK 16+（JEP 387 per-granule uncommit） |

---

## 场景 3：OOM: Metadata space

### 现象

```
java.lang.OutOfMemoryError: Metaspace
# 或
java.lang.OutOfMemoryError: Compressed class space
```

### OOM 时的自动诊断——先看 GC 日志

**不要先手动 jcmd**——OOM 发生时 `Metaspace::report_metadata_oome` 已经自动做了 3 件事（`metaspace.cpp:1416-1465`）：

1. 提交 `EventMetaspaceOOM` JFR event
2. 写入 `Log(gc, metaspace, freelist, oom)` GC 日志——包含完整 `print_basic_report` 输出
3. 区分异常类型：`"Compressed class space"` vs `"Metaspace"`

所以先看 GC 日志——里面有 OOM 时刻的 automated diagnostics snapshot。

### 3 步排查

**Step 1：看当前限制**

```bash
jstat -gccapacity <pid>
# 列 MC(MetaspaceCapacity) vs MR(MetaspaceMax)
```

| MC ≈ MR？ | 含义 |
|-----------|------|
| MC ≈ MR（差距 < 10%） | committed 已接近 max——可能是真实容量不足 |
| MC << MR（差距 > 50%） | 不是总量问题——碎片化或 chunk 分配失败 |

**注意陷阱**：jstat MR = `reserved_bytes()`，不是 `MaxMetaspaceSize`。如果 `MaxMetaspaceSize` 未显式设置，MR 可能是 1GB（压缩类空间预约量），远大于实际上限。在这个场景下 MR 没有参考意义。JMX `MetaspacePool.getUsage().getMax()` 才是 `MaxMetaspaceSize`（或 -1 表示 unlimited）。

**Step 2：`jcmd VM.metaspace show-loaders` 找罪魁 CLD**

```bash
jcmd <pid> VM.metaspace show-loaders=true
```

找 per-CLD 输出中 `used` 最大的——是 `<bootstrap>` 还是自定义 loader？bootstrap 大可能正常（JDK 模块类），自定义 loader 大 → 这就是元凶。

**Step 3：根因分类矩阵**

| 根因 | MC 状态 | per-CLD 信号 | 异常消息 | 修复 |
|------|---------|-------------|---------|------|
| **类加载过多** | MC ≈ MaxMetaspaceSize | bootstrap CLD used 接近上限 | Metaspace | 增大 `-XX:MaxMetaspaceSize=256M` |
| **类泄漏** | MC 持续增长 | 特定自定义 CLD used 最大 | Metaspace | 修复引用泄漏 |
| **碎片化** | MC >> MU | Chunk freelist 大 | Metaspace | 场景 2 的修复方案 |
| **Compressed class space 满** | CCSC ≈ CompressedClassSpaceSize | Class space committed 接近 1GB | **Compressed class space** | 增大 `-XX:CompressedClassSpaceSize=2G` |
| **CDS 未开启浪费** | MC 只用了小部分 reserved | Non-class space reserved 1GB 但 committed 只有几 MB | Metaspace | 默认 `-Xshare:auto` 已开，检查 CDS 是否因地址冲突被禁用 |

**面试常问**：怎么区分 OOM 是 "类太多" 还是 "类泄漏"？

→ 用 `jcmd VM.metaspace show-loaders` 看 CLD 数量。如果有几百个不同的 CLD（不是几十个），且每个的 chunkSize 都在增长 → 泄漏。如果 CLD 数量正常（几个到几十个），但 bootstrap 的 used 特别大 → 类加载太多（正常业务需要更多空间）。

---

## 场景 4：fast load/unload 场景 Metaspace 不释放

### 现象

类快速加载 → GC 卸载 → NMT diff 和 jstat 显示 used 正常波动（类卸载生效），但 committed 居高不下。看起来像泄漏但 used 又没有单向增长。

### 判断标准

| 指标 | 泄漏 | fast load/unload |
|------|-----|-----------------|
| used 趋势 | 只升不降 | 有升有降 |
| committed 趋势 | 同步升 | 居高不下 |
| Full GC 后 MC | 不降 | 不降或微降 |
| jcmd freelists | 不大 | **很大**（几十到几百 MB） |

### 原因分析

不是泄漏——是 JDK 11 Metaspace 设计上的 trade-off：

```
类加载 → SpaceManager allocate → chunk 内 bump pointer
类卸载 → CLD dead → GC 回收 → CLD 析构 → chunk 归还 ChunkManager freelist
freelist chunk 等待同一 size class 的再次分配时复用
如果同一 size class 短期内没有新分配 → chunk 永远留在 freelist

purge（Metaspace::purge）只在 safepoint 且整 Node 全空时 munmap
  → container_count == 0 才行！
  → 如果 Node 里有哪怕一个 chunk 还在用，整个 Node 的 committed 都锁死
```

### 排查与缓解

**Step 1：确认是 fast load/unload 而不是泄漏**

```bash
# 看 used 是否在波动而非单向增长
jcmd <pid> VM.native_memory baseline; sleep 60; jcmd <pid> VM.native_memory summary.diff
```

如果 NMT diff 显示 used 有升有降但 committed 不降 → fast load/unload。

**Step 2：确认 freelist 大小**

```bash
jcmd <pid> VM.metaspace basic=true | grep "Chunk freelist"
```

如果 freelist 总量接近 committed - used 差额 → chunk 在 freelist 中等复用。

**Step 3：确认 purge 无法生效**

```bash
jcmd <pid> VM.metaspace show-vslist=true
```

看每个 VirtualSpaceNode 的 container_count——如果所有 Node 的 container_count > 0（都有活跃 chunk），purge 无法生效。全空 Node 才会被删除。

**Step 4：决策**

| 方案 | 适用场景 | 效果 |
|------|---------|------|
| **接受 trade-off** | 不产生实际内存压力（MC << 物理内存） | 最省事 |
| **CLD 池化** | 减少 CLD 总数 → 减少 Node 数 → 增加全空 Node 概率 | 中等效果 |
| **升级 JDK 16+** | per-granule uncommit（JEP 387） | 根本解决 |

---

## 5. 全场景诊断速查表

```
遇到以下情况...                        用这个排查链

MU 一直涨                               jstat 趋势 → jcmd per-CLD → NMT diff → jmap
MC 比 MU 大很多                         jstat 差距 → jcmd freelist → GC.run
OOM: Metaspace                          GC 日志（自动）→ MC vs MR → per-CLD → 根因矩阵
committed 下不来但 used 正常波动         NMT diff → jcmd freelist → show-vslist

需要事后分析                             JFR（只有它能回溯历史）
需要看 CLD 历史变化                      JFR ClassLoaderStatistics
需要长期监控                              jstat + JFR（NMT 有开销，按需开启）
```

---

## 6. 小结——5 篇文章的最终脉络

```
12.1 jstat + GC 日志   → 免费、零门槛、适合日常监控
12.2 jcmd VM.metaspace → 主动诊断、per-CLD 定位元凶
12.3 NMT               → 历史趋势、diff 判泄漏
12.4 JFR               → 事后回放、低开销生产可用
12.5 实战场景          → 前 4 篇的综合联用

读者读完 5 篇后应具备的能力：
  - 在生产环境不重启的情况下，用 jstat + jcmd 快速诊断 Metaspace 问题
  - 在需要趋势分析时，用 NMT baseline + diff 确认泄漏
  - 在需要事后审计时，用 JFR 回溯 OOM 前的完整 Metaspace 状态
  - 能区分"类泄漏"vs"碎片化"vs"正常增长"vs"CDS 未开"四种常见故障模式
```
