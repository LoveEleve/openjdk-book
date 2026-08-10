# PROMPT: 请撰写 07-PerfMemory.md

## ⚠️ 关键：本 prompt 是导航地图，不是预制答案。你必须亲自读源码。

## §〇 Production Scenario

`jstat -gc <pid>` → `PerfMemory::attach(user, pid, PERF_MODE_RO)` → `open(/tmp/hsperfdata_user/pid, O_RDONLY|O_NOFOLLOW)` → `is_directory_secure(dirname)` 防 symlink 攻击 → `mmap(PROT_READ, MAP_SHARED)` → 验证 Prologue magic `0xc0c0feca` + byte_order → `entry_offset` 遍历 PerfDataEntry 链表 → 匹配 `"sun.gc.generation.0.space.0.capacity"` → 返回 value。延迟 ~1µs/counter, 0 RPC, 0 序列化。**Post-mortem**: JVM crash 后文件仍在 `/tmp`, jstat 仍能读取最终状态——这是 mmap+文件（非 socket）的核心优势。

## §一 Task + Narrative + Beginner Callouts

### Interview

"`perfMemory_init()` 调用 `PerfMemory::initialize()`: `get_capacity()` → `PerfDataMemorySize=32KB` 对齐到 `vm_allocation_granularity=4KB` → `create_memory_region(capacity)`: `mmap_create_shared(size)` → `mkdir /tmp/hsperfdata_user/` (权限 0700, 防 symlink) → `open(filename, O_RDWR|O_CREAT|O_NOFOLLOW, 0600)` → `ftruncate(fd, size)` + 逐页写 1B 确保磁盘预留 → `mmap(0, size, PROT_READ|PROT_WRITE, MAP_SHARED, fd, 0)` → `close(fd)` (mmap 后 fd 可关) → `memset(mapAddress, 0, size)`。写 PerfDataPrologue header: magic `0xc0c0feca` (大端则 `0xcafec0c0`), byte_order=BYTE_ORDER, major=1/minor=0, entry_offset=sizeof(Prologue)=~40B, num_entries=0 → `OrderAccess::release_store(&_initialized, 1)`。计数器通过 `PerfMemory::alloc(size)` bump-pointer 分配: `_top + size >= _end` → overflow → `_top += size` → `prologue->used++`。PerfDataEntry 变长布局: `entry_length`(4B)+`name_offset`(4B)+`vector_length`(4B)+`data_type`(1B)+`flags`(1B)+`data_units`(1B)+`data_variability`(1B)+`data_offset`(4B)→fixed header 20B + 变长 `data_name[]+data_pad[]+data_item[]`。PerfDataManager 维护 3 列表: `_all`(全部)、`_sampled`(V_Variable/V_Monotonic)、`_constants`(V_Constant)。CounterNS 3 层: `java.*`(stable supported, ns%3==1)、`com.sun.*`(unstable supported, ns%3==2)、`sun.*`(unstable unsupported, ns%3==0)。jstat attach: `mmap_attach_shared()` → `open(O_RDONLY|O_NOFOLLOW)` → `is_directory_secure` 安全检查 → `mmap(PROT_READ, MAP_SHARED)` → 解析 entry 链表。并发模型: 写端 `PerfDataMemAlloc_lock` 互斥 → 读端 MAP_SHARED 页一致性 + x86 TSO → 无锁零拷贝。"

### Callouts（≥7）

1. **magic 0xc0c0feca**: Prologue 第一个 4B → 验证文件完整性。大端的 byte-swapped 版本 0xcafec0c0。`PerfMemory::is_initialized()` 用 `load_acquire` 读 `_initialized`。
2. **bump-pointer alloc**: `PerfMemory::alloc()` 用 `PerfDataMemAlloc_lock` 保护 → 检查 `_top+size>=_end` → bump → 更新 prologue。无 free 操作——分配即永久。
3. **CounterNS 公式**: `JAVA_NS=1, COM_NS=2, SUN_NS=3` → 子系统 base=N → `JAVA=N+0, COM=N+1, SUN=N+2` → `is_stable_supported(ns)=ns%3==1`。
4. **PerfCounter vs PerfLongVariable**: PerfCounter(V_Monotonic) 只增不减 → jlong in shmem。PerfLongVariable(V_Variable) 任意变 → 支持 pointer 或 helper 采样模式。PerfStringVariable → char[] in shmem with null terminator。
5. **StatSampler 采样**: `_sampled` 列表中 V_Variable/V_Monotonic 的计数器 → `StatSampler::sample()` → 读取 `_valuep`(pointer mode) 或 `_sample_helper->take_sample()`(helper mode) → 写入 shmem。
6. **jstat 安全**: `is_directory_secure(dir)` 检查 owner match + no group/other write + no sticky bit → 防 symlink 替换 `/tmp/hsperfdata_user/` 的攻击。
7. **release/acquire 同步**: `_initialized` 用 `release_store`(init side) / `load_acquire`(attach side) → 保证 jstat 看到完整 Prologue。mod_time_stamp 用 `os::elapsed_counter()` 无 barrier → 弱一致性但安全。

## §四 Deep Dive Question Groups（≥6）

4.1 ★★★ mmap 创建: open(O_CREAT|O_EXCL|O_NOFOLLOW)+ftruncate→mmap(MAP_SHARED)→close(fd)→write magic → 文件生命周期
4.2 ★★★ PerfDataPrologue 字节布局: magic(4B)+byte_order(1B)+major(1B)+minor(1B)+padding(1B)+accessible(1B)+used(4B)+overflow(4B)+mod_time_stamp(8B)+entry_offset(4B)+num_entries(4B)
4.3 ★★★ PerfDataEntry 变长布局: fixed header 20B + data_name[name_len] + data_pad[pad_bytes] + data_item[dsize*dlen] → 如何计算 entry_length
4.4 ★★★ CounterNS map: ns_to_string(ns) 映射 → _name_spaces[] 数组 → 稳定性分类公式 ns%3
4.5 ★★★ PerfDataManager 3 列表 + StatSampler: _all/_sampled/_constants 分类逻辑 → PerfLongVariant 两种采样模式 → sample() 实现
4.6 ★★★ jstat attach 安全路径: mmap_attach_shared→open(O_RDONLY|O_NOFOLLOW)→is_directory_secure 检查→mmap(PROT_READ, MAP_SHARED)→verification
4.7 ★★★ 并发模型与 Post-Mortem: 写端互斥锁 vs 读端无锁 → MAP_SHARED 页一致性 + x86 TSO → crash 后文件可读 → 对比 JMX RPC 的不可能

## §六 不要写成→应该写成

| 不要写成 | 应该写成 |
|---------|---------|
| "PerfMemory 是共享内存" | "`open(O_CREAT\|O_EXCL, 0600)`→`ftruncate(32KB)`→`mmap(PROT_RW, MAP_SHARED)`→写 Prologue magic 0xc0c0feca→`release_store(&_initialized,1)`→`PerfMemory::alloc()` bump-pointer 写 PerfDataEntry" |
| "jstat 读取计数器" | "`attach(user,pid)`: `open(O_RDONLY\|O_NOFOLLOW)`→`is_directory_secure` 安全检查→`mmap(PROT_READ, MAP_SHARED)`→验证 magic+byte_order→遍历 PerfDataEntry→按 name 匹配返回 data → 0 RPC,~1µs/counter" |
| "CounterNS 命名空间" | "`ns_to_string(ns)`→`_name_spaces[ns]`(如 `\"java.gc\"`). `ns%3==1`=stable,`ns%3==2`=unstable supported,`ns%3==0`=unsupported" |

## §八 Prohibited（≥8）
❌ 不画 mmap 布局 → ❌ 不展开 Prologue 字节布局 → ❌ 不解释 PerfDataEntry 变长 → ❌ 不列 CounterNS 映射 → ❌ 不画 jstat attach 路径 → ❌ 不说并发模型 → ❌ 不提 Post-Mortem → ❌ 不写 GDB

## §九 Required（≥8）
✅ ★ Mermaid 3 图: mmap 创建+PerfDataEntry 布局+jstat attach ✅ ★ Prologue 字节级布局图 ✅ ★ PerfDataEntry 变长结构图 ✅ ★ CounterNS 公式推导 ✅ ★ PerfCounter 类层次 ✅ ★ jstat attach 完整路径源码 ✅ ★ 面试 Story ✅ ★ GDB 7 断点

## §十 GDB

断言1: mmap→`print PerfMemory::_start`+`print *(int*)_start`(0xc0c0feca)
断言2: prologue→`print _prologue->entry_offset, num_entries`
断言3: entry→`print entry->name_offset`→`print (char*)entry+name_offset`
断言4: alloc→break `PerfMemory::alloc`→`print _top before/after`
断言5: CounterNS→`print _name_spaces[JAVA_GC]`("java.gc")
断言6: attach→break `mmap_attach_shared`→check is_directory_secure
断言7: StatSampler→break `PerfLongVariant::sample`→`print take_sample()`

路径: `docs/07-PerfMemory.md`

---

## §十一 Continuity

- 00-JNI-CreateJavaVM 的 `vm_init_globals` step 4 `perfMemory_init()` → 本文展开。
- `management_init()` (init_globals step 1) 创建的最初 23 个 PerfCounter 存储在本文的 PerfMemory 中。
- 与 06-Mutex 同级（同属 vm_init_globals 子步骤）。

---

## §四 详细答案方向

### 4.1 mmap 创建
`create_sharedmem_resources(name, size)`: `mkdir /tmp/hsperfdata_<user>/`(0700)→`open(name, O_RDWR|O_CREAT|O_NOFOLLOW, S_IRUSR|S_IWUSR)`→`ftruncate(fd,size)`→逐页写 1B 确保磁盘空间预留→`mmap(0, size, PROT_RW, MAP_SHARED, fd, 0)`→`close(fd)`→`memset(map,0,size)`。mmap 后 fd 可关闭——映射仍然有效（内核保持页引用）。
追问: 为什么 fd 可以关？→ MAP_SHARED 映射基于 inode，不是基于 fd。内核通过 inode + offset 维护页映射。
反事实: 如果 fd 不关 → 每个 PerfMemory 消耗 1 fd → fd 泄漏风险。

### 4.2 PerfDataPrologue 字节布局
`sizeof(PerfDataPrologue)` = magic(4B)+byte_order(1B)+major_version(1B)+minor_version(1B)+_reserved(1B)+accessible(1B)+used(4B)+overflow(4B)+mod_time_stamp(8B)+entry_offset(4B)+num_entries(4B) = ~33B + padding = ~40B。
magic=`0xc0c0feca`→大端 `0xcafec0c0`。byte_order=`BYTE_ORDER`(本机端序)。
追问: `accessible` 字段含义？→ `set_accessible(true)` 在 `record_vm_startup_time()` 后调用——作为"数据就绪"信号。
反事实: 如果没有 magic → 错误打开非 PerfMemory 文件 → 解析垃圾数据 → 未定义行为。

### 4.3 PerfDataEntry 变长布局
fixed header: `entry_length`(4B)+`name_offset`(4B)+`vector_length`(4B)+`data_type`('J'/'B'/etc)(1B)+`flags`(1B)+`data_units`(1B)+`data_variability`(1B)+`data_offset`(4B)=20B。变长: `data_name[name_len]` + `data_pad[pad_to_dsize_boundary]` + `data_item[dsize*dlen]`。`create_entry()` 计算: `entry_length = sizeof(PerfDataEntry) + name_len + pad_length + dsize*dlen` 对齐到 8。
追问: data_type 编码: 'B'=byte, 'Z'=boolean, 'J'=long, 'I'=int, 'S'=short, 'C'=char, 'D'=double, 'F'=float, 'V'=void, 'L'=object, '[' = array。
反事实: 如果 PerfDataEntry 用固定大小 → PerfStringVariable (max_length+1 bytes) 必须预留最大 → 浪费。

### 4.4 CounterNS 映射
`ns_to_string(ns)` 查 `_name_spaces[ns]`: `_name_spaces[JAVA_GC=4]="java.gc"`, `_name_spaces[COM_GC=5]="com.sun.gc"`, `_name_spaces[SUN_GC=6]="sun.gc"`。稳定性: `ns%3==1`=stable(`java.*`), `ns%3==2`=unstable supported(`com.sun.*`), `ns%3==0`=unsupported(`sun.*`)。
追问: 为什么 java.* 是 stable？→ JCP 规范要求 jstat 等工具的计数器名称稳定——工具链依赖。
反事实: 无命名空间 → 所有计数器平级 → 工具不知道哪些可靠哪些可能变化。

### 4.5 PerfDataManager 3 列表 + StatSampler
`add_item(p)` 检查 `p->variability()`: V_Constant → `_constants->append(p)`。V_Variable/Monotonic → `_sampled->append(p)`。全部→`_all->append(p)`。StatSampler 周期性遍历 `_sampled` 列表，对每个调用 `p->sample()`: pointer mode→`*_valuep=*_sampled`; helper mode→`*(jlong*)_valuep=_sample_helper->take_sample()`。
追问: take_sample() 示例？→ `ThreadService::ThreadCountHelper::take_sample()` 遍历 ThreadsList 计数。
反事实: 无采样模式 → 必须在每次修改时写 shmem → 高频计数器 (live_threads) 的大量 shmem write → 内存带宽瓶颈。

### 4.6 jstat attach 安全
`mmap_attach_shared(user, vmid, PERF_MODE_RO)`: `get_user_tmp_dir(user)→/tmp/hsperfdata_user/`→`is_directory_secure(dir)`: 检查 `stat.st_uid==geteuid()` && `!(stat.st_mode & (S_IWGRP|S_IWOTH))` && `!(stat.st_mode & S_ISVTX)` → `open(rfilename, O_RDONLY|O_NOFOLLOW)` → `::mmap(0,size,PROT_READ,MAP_SHARED,fd,0)` → `close(fd)` → 返回 addr+size。PERF_MODE_RW 当前 #ifdef LATER 禁用。
追问: sticky bit 检查原因？→ sticky bit on /tmp 表示删除限制——在这种目录下创建文件有额外安全检查，跳过以防 symlink 漏洞。

### 4.7 并发模型与 Post-Mortem
写端: `PerfMemory::alloc()` 用 `PerfDataMemAlloc_lock` (leaf rank, `_safepoint_check_always`) 保护。写计数器: `*counter->_valuep = value` (plain write)。读端(jstat): `PROT_READ mmap` 无锁。可见性依赖: MAP_SHARED 页级一致性 (read sees latest committed page) + x86 TSO (plain write not reordered after prior writes)。`_initialized` release/acquire 保证 jstat 看到完整 Prologue。Post-Mortem: crash 后文件在磁盘 → jstat 仍可 attach → mmap→读取 → 保留最终态快照。
追问: 为什么不用 msync？→ MAP_SHARED on Linux 自动 dirty page writeback（内核 pdflush），jstat 读同一 page cache → 不需要主动 flush。
反事实: 用 JMX RPC → crash 后 TCP 断开 → 信息永远丢失 → 而 PerfMemory 的 crash dump 可比。
