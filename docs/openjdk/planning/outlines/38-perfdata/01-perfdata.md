# 01. jstat -gc 的数据怎么实时读取？ — PerfData 架构

> 🔴 Deep | mmap 共享内存计数器
> 读者处境: `jstat -gc <pid> 1000ms` — 每 1s 输出 GC 计数/Eden 使用/Full GC 时间。这些数据不是 JMX 接口——是 PerfData 通过 mmap 共享内存暴露——**无 IPC 开销 (1 cycle read)**。
>
> ⚠️ 写作期修正(2026-08-12, vol-02/38-perfdata/01 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **"1 cycle read" 弱化**: 是普通内存读写的代价(无 IPC/序列化),不是字面 1 cycle;64 位无锁的前提=create_entry 8 字节对齐(perfData.cpp:151-153,align=sizeof(jlong)-1)+ x86-64 aligned store 原子 + 计数器单调语义容忍旧值(inc/add 直接写 _valuep,perfData.hpp:416-419)
> - **"~200 counters" 与"PerfDataManager 创建"不实**: 是各子系统初始化时各自注册(CollectorCounters collectorCounters.cpp:43-58 建 sun.gc.collector.<n>.time/invocations/lastEntryTime/lastExitTime,名称空间 name_space("collector",ordinal) perfData.cpp:373-377;StatSampler 建 sun.rt.javaCommand statSampler.cpp:322-324、sun.os.hrt.ticks :356-359);PerfDataManager::create_xxx 只注册挂列表(_all/_sampled/_constants perfData.cpp:40-42)
> - **PerfData 对象不是"模板别名 char[] buffer"**: 对象在 C 堆(CHeapObj),值 _valuep 指向共享区;共享区放 PerfDataEntry 固定头+变长 body(perfMemory.hpp:78-98);布局是公共契约(perfMemory.hpp:55-56 注释 "known by the PerfDataBuffer Java class libraries")
> - **目录权限 0700 错 → 实际 0755**(make_user_tmp_dir perfMemory_linux.cpp:852-853 注释原文 "create the directory with 0755 permissions");隔离靠**文件 0600**(create_sharedmem_file :909 open O_RDWR|O_CREAT|O_NOFOLLOW S_IRUSR|S_IWUSR);防 symlink: is_directory_secure :240/is_file_secure :417;容器 flock 竞争 :938-942
> - 类层次(perfData.hpp:97-107): PerfLongConstant(alias PerfConstant)/PerfLongVariable(alias PerfVariable)/PerfLongCounter(alias PerfCounter)/PerfString;Variability V_Constant=1/V_Monotonic=2/V_Variable=3(:255-262);Units 六种(:266-273)
> - 文件: PERFDATA_NAME="hsperfdata"(perfMemory.cpp:43),路径 /tmp/hsperfdata_<user>/<pid>(容器内 /proc/{vmid}/root/tmp/...,perfMemory_linux.cpp:142-146);mmap_create_shared :1056 起(mmap :1091);attach 侧 mmap_attach_shared :1181(RO 只读);unlink 在 delete_shared_memory :1133-1146(remove_file);残留清理 cleanup_sharedmem_files
> - Prologue(perfMemory.hpp:62-74): magic 0xcafec0c0/字节序/版本 2.0/accessible/used/overflow/mod_time_stamp/entry_offset/num_entries;accessible 在 VM 启动完成时置位(management.cpp:205-207);mod_time_stamp 由 mark_updated 更新(perfMemory.cpp:235-240)
> - 8 字节对齐(create_entry perfData.cpp:125-186);共享区满退回 C 堆(_on_c_heap,:159-161);UsePerfData 默认 true(globals.hpp:2419);PerfDataSaveToFile(globals.hpp:2423,保存 save_memory_to_file :82,调用 :1345-1346)
> - 实证: jstat-gc.txt 各列=计数器(YGC/YGCT=U_Events/U_Ticks,S0C/EC/OC=U_Bytes)

### 1. "PerfData — ~200 计数器系统"

场景: JVM 启动→PerfDataManager 创建 ~200 counters→每个有 name+type+value→结构体数组存储在 mmap 文件中→jstat open/read 直接访问内存。

**PerfData 计数器** (`perfData.hpp:40-200 + perfData.cpp:50-250`):
```
PerfLong           sun.gc.collector.0.time          → GC 累计时间(ms)
PerfCounter        sun.gc.collector.0.invocations    → GC 次数
PerfString         sun.rt.javaCommand                → JVM command line
PerfByteArray      sun.rt.createVmBeginTime          → VM 启动时间戳
PerfLongVariable   sun.os.hrt.ticks                  → 高精度计时器 ticks
PerfLongCounter    sun.gc.policy.collectors          → GC 回收器数量
[C++: perfData.hpp——PerfLong/PerfCounter/PerfString 只是 C++ 模板别名——实际存储为 char[] buffer]
```
- 源码: `perfData.hpp:40-200` (counter 类型定义) + `perfData.cpp:50-250` (PerfDataManager::create_long_counter 等)

- 关键设计: **Producer(JVM) 直接写 64-bit 值(普通内存写, ~1 cycle)** — Consumer(jstat) 通过 mmap 映射同一物理页→直接读内存(普通内存读, ~1 cycle)——**无 IPC/无 socket/无 JMX 序列化**。jstat 连接→open `/tmp/hsperfdata_<user>/<pid>`→读 header→找到 counter offset→value。

### 2. "PerfMemory — mmap 共享内存文件"

场景: JVM 在 `/tmp/hsperfdata_<user>/` 创建 `pid` 命名的文件→mmap→写入 perfdata header+counters→jstat 在另一个进程 mmap 同一文件。

**PerfMemory** (`perfMemory.hpp:40-100 + os/linux/perfMemory_linux.cpp:40-150`):
```
JVM: open("/tmp/hsperfdata_<user>/<pid>", O_CREAT|O_RDWR)
     → ftruncate(size) → mmap(MAP_SHARED, PROT_READ|PROT_WRITE)
     → 写入 PerfData header(count + entry offsets) + counter values

jstat: open(same file, O_RDONLY)
     → mmap(MAP_SHARED, PROT_READ) → 读 header → 根据 entry offset 读 counter value
[C++: perfMemory_linux.cpp——文件在 JVM exit 时 unlink——不存在残留 hsperfdata 文件]
[内核: mmap(MAP_SHARED) 映射同一文件→两个进程共享同一物理页→cache coherency 由 CPU cache coherence (MESI) 保证]
```
- 源码: `perfMemory.hpp:40-100` (共享内存接口) + `os/linux/perfMemory_linux.cpp:40-150` (Linux 实现)

- 关键设计: **目录权限隔离**——`/tmp/hsperfdata_<user>/` 目录 mode 为 0700——只有同一用户能读取 JVM performance counters。不同用户的 JVM 互不可见。**64-bit 原子写天然无锁**——x86 保证 64-bit aligned stores 对其他核心原子可见——不需要 volatile/java lock——只需要 C++ int64_t store→consumer 看到完整值。

---

### 核心悬念

**"PerfData ~200 counters 通过 mmap 共享内存暴露→jstat 直接读内存(无 IPC, 1 cycle)。PerfMemory 是 hsperfdata_<user>/<pid> 文件的 mmap wrapper——Producer atomic write → Consumer atomic read——64-bit 天然无锁。"** — 下一篇: StatSampler(周期性刷新 + 同步协议)。

> → [02-stat-sampler.md](02-stat-sampler.md)
