# 46-sa-postmortem/01-sa-postmortem 重写规划

> 基于 `OpenJDK 11u / Linux / x86_64 / jhsdb + saproc`
> 目标：解释 SA(Postmortem) 怎么在 JVM 死后仍然看堆——core 模式与活进程模式共享什么抽象、ELF 段表/ptrace/符号哈希表各自扮演什么角色

## 1. 选题判断

现稿事实基础很强：
- `ps_core.c` 的 map_info / core_lookup / core_read_data
- `ps_proc.c` 的 ptrace attach / process_read_data
- `symtab.c` 的符号表构建与哈希查找
- `JVM_GetManagement` 与 `Universe::_collectedHeap` 作为示例终点

真正该打穿的困惑更集中：

**JVM 都死了，怎么还能看堆？SA 到底是直接解析 HotSpot 私有格式，还是靠 ELF / ptrace 这些系统设施？为什么 `jhsdb jmap --heap --pid` 和 `--core` 两种模式看起来像一个工具？**

## 2. 一句话顿悟

**SA 并不理解“活 JVM”和“core 文件”两种不同世界，它只要求一个统一的“按地址读内存、按名字找符号”的抽象。core 模式靠 ELF program headers 建映射表、二分查段、pread 读字节；活进程模式靠 ptrace attach + `/proc/<pid>/maps` 建映射表、`PTRACE_PEEKDATA` 分片读字节；符号解析则统一走 ELF symtab/dynsym → 哈希表 → base+offset。**

## 3. 总图

```text
jhsdb / HotSpotAgent
  ├─ 活进程模式
  │    ptrace attach + waitpid(SIGSTOP)
  │    /proc/<pid>/maps -> map_info
  │    PTRACE_PEEKDATA 8-byte reads
  │
  ├─ core 模式
  │    ELF header + PT_LOAD program headers -> map_info
  │    sort map_info -> binary search
  │    pread(fd, buf, len, off)
  │
  └─ 共同部分
       symtab/dynsym -> hash lookup -> base + offset
       Universe::_collectedHeap -> Heap object -> GC-specific traversal
```

## 4. 结构大纲

### 第一节：开场困惑——JVM 都死了，怎么还能看堆

- 从 hs_err 只有栈、看堆要靠 SA 切入
- 点出：活进程和 core 两种模式共享一套“按地址读内存”抽象
- 埋主线：core / ptrace / symtab 三层

### 第二节：两个朴素方案为什么都不对

1. SA 只会解析 core 文件，不支持活进程
2. SA 直接理解 HotSpot 私有 core 格式

结论：它依赖的是 ELF / ptrace / 符号表这些系统设施，而不是 JVM 私有格式。

### 第三节：core dump 解析——ELF 段表 + 二分 + pread

- `add_map_info`
- `sort_map_array`
- `core_lookup` 二分
- `core_read_data` 分片 pread + 段尾补零
- class_share_maps 兜底

### 第四节：活进程读取——ptrace attach + PEEKDATA

- `verifyBitness`
- `Pgrab` / `ptrace_attach`
- `/proc/<pid>/maps` 建映射表
- `process_read_data` 8 字节对齐/非对齐合并
- SIGSTOP 期间目标进程暂停

### 第五节：符号解析——ELF symtab → 哈希表 → 堆入口

- `build_symtab_internal`
- `hcreate_r/hsearch_r`
- `search_symbol`
- `lookup_symbol`
- `.gnu_debuglink` / build-id debug 文件兜底
- `Universe::_collectedHeap` 终点

### 第六节：误解澄清与收网

## 5. 失败方案

1. SA 只会解析 core 文件
2. SA 直接解析 HotSpot 私有 core 格式

## 6. 证据清单

- `src/jdk.hotspot.agent/linux/native/libsaproc/ps_core.c:124-200`
- `src/jdk.hotspot.agent/linux/native/libsaproc/ps_core.c:382-465`
- `src/jdk.hotspot.agent/linux/native/libsaproc/ps_proc.c:66-116`
- `src/jdk.hotspot.agent/linux/native/libsaproc/ps_proc.c:275-292`
- `src/jdk.hotspot.agent/linux/native/libsaproc/ps_proc.c:450`
- `src/jdk.hotspot.agent/linux/native/libsaproc/symtab.c:329-432`
- `src/jdk.hotspot.agent/linux/native/libsaproc/symtab.c:569-587`
- `src/jdk.hotspot.agent/linux/native/libsaproc/libproc_impl.c:215-238`

## 7. 完成后 review

- 删除代码后，能否复述“活进程/core 共用按地址读内存抽象”
- 是否讲清 core 模式的 ELF 段表 + 二分 + pread
- 是否讲清活进程模式的 ptrace + PEEKDATA
- 是否讲清符号查找的哈希表与 base+offset
- 是否完成删码测试、禁用词、链接、`file:line`、`git diff --check` 校验