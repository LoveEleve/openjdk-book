# 域 46: SA Postmortem — 知识规划

> 源码: jdk.hotspot.agent/linux/native/libsaproc/ | ~12文件/~3399行 | 🟡 普通域(1篇)

## 01 逐源提取

| Source File | Inferred Mechanism | Confidence |
|------------|-------------------|------------|
| ps_core.c (1134行) | **Core dump 解析**: ELF 文件解析→segment headers→load maps(libjvm.so/heap regions/stack segments), lookup addr→find mapped segment→read_raw, Java heap 读取(via libjvm debug symbols)→oop iterate | High |
| ps_proc.c (527行) | **Live process 读取**: /proc/<pid>/maps→load memory maps, /proc/<pid>/mem→read process memory, libjvm lookup(via dlopen+elf symbol table) | High |
| LinuxDebuggerLocal.c (584行) | **ptrace 调试**: ptrace(PTRACE_ATTACH)→attach to Java process→read registers/stack/memory→ptrace(PTRACE_DETACH), thread list→/proc/<pid>/task | High |
| symtab.c (607行) | **ELF 符号表**: ELF .symtab/.dynsym section→symbol lookup by name→find JVM debug symbols(Universe::_collectedHeap, SymbolTable, etc) | High |
| libproc_impl.c (421行) | **libproc 实现**: ps_prochandle 创建/销毁, read/write wrappers, shared library search(path+version+arch) | Medium |
| salibelf.c (126行) | **ELF 工具**: ELF header 验证, section header 解析, program header 遍历 | Low |

*6 知识点*

## 02 聚合

### P2 (2-4文件)
| KP | 出现文件 |
|----|---------|
| Core dump 解析引擎 | ps_core.c, salibelf.c |
| Live process 读取 | ps_proc.c, LinuxDebuggerLocal.c |
| ELF 符号表解析 | symtab.c, salibelf.c |

## 03 深度分类

### 🔴 Deep (1 KP)
| KP | 为什么 🔴 |
|----|---------|
| Core dump→Java heap 解析(ps_core.c) | `jhsdb jmap --core core.dump` 的核心——SA 不依赖 live JVM(通过 ptrace 或 core file)→独立进程读取 JVM 内部状态。ps_core.c 解析 core dump→找到 libjvm.so 的 load segment→ELT symbol table→look up `Universe::_collectedHeap`→HeapWord→oop iterate→dump objects。这是 JDK 的"事后诊断"唯一途径——JVM crash→core dump→SA→分析 |

### 🟡 Working (2 KP)
| KP | 为什么 🟡 |
|----|---------|
| ptrace attach + thread stack | ptrace attach→读取寄存器+stack→unwind frames→Java stack trace |
| /proc + ELF symbol table | /proc/<pid>/maps/mem→read memory maps + libjvm symbols→同一套机制 live or core |

### 🟢 Surface (1 KP)
| KP | 为什么 🟢 |
|----|---------|
| libproc wrapper | ps_prochandle 的 malloc/close/write 薄包装器 |

## 04 聚类 — 1篇

| 篇 | 标题 | 核心问题 |
|:--:|------|------|
| 1 | SA Postmortem | "jhsdb jmap 怎么从 core dump 中提取 Java heap？ptrace/open(/proc/pid/mem)/ELF symbol table 三条路径怎么协作？" |
