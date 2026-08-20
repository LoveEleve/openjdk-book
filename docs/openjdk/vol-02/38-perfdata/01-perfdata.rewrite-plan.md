# 38-perfdata/01-perfdata 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释 `jstat` 一类外部工具为什么能在不走 JMX、不发 RPC 的情况下跨进程直接读到 JVM 里的 GC / 编译 / 运行时计数器，以及 HotSpot 怎样把计数器对象、共享内存布局、可访问时机和权限边界组织成一条稳定通道

## 1. 选题判断

现稿已经覆盖了不少事实：
- PerfData 类型层次、Variability/Units
- PerfDataEntry / PerfDataPrologue
- PerfMemory Linux 上的 mmap backing file
- 0755/0600 权限与安全检查
- `PerfMemory::set_accessible(true)`

但现在正文仍然偏“对象模型 + 文件实现 + 无锁特性”的事实拼接。真正该打穿的读者困惑更集中：

**`jstat` 凭什么能在另一个进程里每秒读到 JVM 内部的 GC / 编译 / 运行时数字，而且中间既没有 socket，也没有 JVMTI/JMX 风格的请求应答？这些数字到底住在哪里，谁创建它们，什么时候对外可见，为什么看起来像普通内存读写却又不会把 JVM 搞乱？**

这才是本篇最该回答的问题。

## 2. 一句话顿悟

**PerfData 不是“JVM 内部计数器顺手导出一下”，而是一条刻意设计的跨进程观测通道：JVM 内部继续用 C++ 对象管理计数器语义和命名，各子系统像注册本地对象一样注册 `PerfData`；同时这些对象把值投影到一块有固定二进制布局的共享内存区里。外部工具并不理解 HotSpot 对象，只认 `PerfDataPrologue + PerfDataEntry` 这套共享协议；Linux 上再用 `mmap` + backing file 把这块内存暴露给同用户进程读取。**

## 3. 总图

```text
JVM 内部
  子系统创建 PerfData 对象
    ├─ GC counters
    ├─ Runtime / OS counters
    └─ sampled helpers
        ↓
  PerfData 对象 (C heap)
    └─ _valuep 指向 PerfMemory 里的 data slot

共享通道
  PerfMemory
    ├─ Prologue: magic / version / accessible / used / entry_offset / num_entries
    └─ Entry[] : name + units + variability + data
        ↓
Linux 实现
  /tmp/hsperfdata_<user>/<pid>
    └─ mmap(MAP_SHARED)

外部工具
  jstat / jvmstat libraries
    └─ 只解析共享布局，不碰 JVM 内部对象
```

## 4. 结构大纲与字数预算

### 第一节：开场困惑——跨进程为什么能像读普通内存一样读到 JVM 数字

目标约 1200 字。

- 从 `jstat -gc` 每秒吐数据切入
- 点出反直觉：没有 RPC，没有主动上报，读方是另一个进程
- 埋主线：这是“对象在 JVM 内，值在共享区”的双层设计

### 第二节：两个朴素理解为什么都不对

目标约 1800 字。

必须推演：
1. `jstat` 是 JVM 主动推送数据，或者每秒走一轮 IPC/JMX
2. PerfData 就是一块共享内存，没有 JVM 内部对象层

结论：
- 这不是请求应答通道，而是共享布局通道
- 也不是裸共享内存，而是“对象语义 + 公共布局”分层

### 第三节：计数器对象——为什么 JVM 内部还要保留一套 C++ 对象模型

目标约 2100 字。

- `PerfData` 层次、Variability / Units
- `PerfDataManager` 作为对象工厂和列表管理者
- `_all / _sampled / _constants`
- 强调 JVM 内部还是按对象语义管理，不直接拿共享内存做业务对象

### 第四节：共享布局——为什么对外只暴露 `Prologue + Entry`

目标约 2200 字。

- `PerfDataPrologue`
- `PerfDataEntry` 固定头 + 变长 body
- Java 侧 jvmstat libraries 只认这套布局
- `create_entry` 的 8 字节对齐与 `_on_c_heap` fallback
- 路标：对外契约是布局，不是 C++ 类层次

### 第五节：对象与值分离——为什么 `_valuep` 指向共享区才是关键

目标约 1800 字。

- `PerfData` 对象在 C heap
- `_valuep` 指向 PerfMemory data slot
- 共享区不够时退回 C heap，JVM 继续跑但外部工具看不到
- 收回“本地对象 / 远端视图”主线

### 第六节：谁在创建这些计数器——不是中心批量生产，而是子系统各自注册

目标约 1800 字。

- `CollectorCounters` 创建 `sun.gc.collector.*`
- `StatSampler` 创建 `sun.rt.javaCommand` / `sun.os.hrt.ticks`
- name space 的含义与稳定性层级
- 说明 PerfData 更像统一注册表，而不是集中采样仓库

### 第七节：Linux 共享内存实现——为什么是 `/tmp/hsperfdata_<user>/<pid>` + mmap

目标约 2200 字。

- backing store file 的设计动机
- `mmap_create_shared`
- 目录 0755、文件 0600
- `is_directory_secure` / `is_file_secure`
- container/pid 冲突与 flock

### 第八节：可见性与“无锁”边界——为什么普通读写就够了

目标约 2100 字。

- `accessible` 何时置位
- `mark_updated` 与 `mod_time_stamp`
- 8 字节对齐写、计数器单调语义
- 不要夸大成“强并发一致性协议”
- 收回“观测允许稍旧，但不能乱结构”主线

### 第九节：误解澄清与收网

目标约 1300 字。

至少回答：
1. PerfData 是否等于 JMX
2. 外部工具是否理解 HotSpot 的 C++ 对象
3. 共享内存不足是否会让 JVM 功能失效
4. 0755 目录是否等于任何用户都能读数据
5. “无锁”是否等于完全不在乎可见性边界

## 5. 失败方案必须写进正文

1. 把 `jstat` 理解成一次次跨进程 RPC/JMX 拉取
2. 把 PerfData 理解成没有对象层的裸共享内存
3. 把“无锁”误解成“完全没有布局就绪和可见性协议”

## 6. 证据清单

- `share/runtime/perfData.hpp:97`：PerfData 类层次注释
- `share/runtime/perfData.hpp:252`：Variability 枚举
- `share/runtime/perfData.hpp:261`：Units 枚举
- `share/runtime/perfData.hpp:295`：`create_entry` 注释
- `share/runtime/perfData.hpp:289`：`_valuep`
- `share/runtime/perfData.cpp:40`：`PerfDataManager` 三个列表与 name spaces
- `share/runtime/perfData.cpp:125`：`PerfData::create_entry`
- `share/runtime/perfData.cpp:136`：8 字节对齐
- `share/runtime/perfData.cpp:141`：`_on_c_heap` fallback
- `share/runtime/perfMemory.hpp:62`：`PerfDataPrologue`
- `share/runtime/perfMemory.hpp:74`：`PerfDataEntry` 对外契约注释
- `share/runtime/perfMemory.cpp:235`：`mark_updated`
- `share/gc/shared/collectorCounters.cpp:37`：GC counters 命名空间与注册
- `share/runtime/statSampler.cpp:322`：`sun.rt.javaCommand`
- `share/runtime/statSampler.cpp:356`：`sun.os.hrt.ticks`
- `share/services/management.cpp:205`：启动完成后 `set_accessible(true)`
- `os/linux/perfMemory_linux.cpp:127`：Linux mmap + backing file 注释
- `os/linux/perfMemory_linux.cpp:142`：容器路径 `/proc/{vmid}/root/tmp`
- `os/linux/perfMemory_linux.cpp:850`：目录 0755
- `os/linux/perfMemory_linux.cpp:909`：文件 0600
- `os/linux/perfMemory_linux.cpp:935`：容器下 flock 竞争说明
- `os/linux/perfMemory_linux.cpp:1050`：`mmap_create_shared`

## 7. 必须明确的边界

- 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
- 本篇讲的是 PerfData 主通道，不展开 JFR/JMX/Attach 的其他观测路径
- “无锁”主要针对标量计数器读写，不夸大成全结构强一致性保证
- StatSampler 的周期采样逻辑放下一篇，不在这里抢写
- 外部 Java 解析库只点到“认布局”这一层，不展开 jvmstat 工具实现

## 8. 完成后 review

- 删除代码后，能否复述“对象在 JVM 内，值在共享区，布局是公共契约”
- 是否清楚说明 PerfData 不是 RPC/JMX，而是 mmap 共享布局通道
- 是否把 0755 目录 / 0600 文件这组权限设计讲清楚
- 是否清楚说明 accessible / mod_time_stamp 的边界作用
- 是否完成删码测试、禁用词、链接、`file:line`、`git diff --check` 校验
