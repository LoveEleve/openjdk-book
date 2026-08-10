# Prompt-03: JNI 桥接 + 符号表解析

> **目标文档**: `probe_md/20-sa-postmortem/docs/03-JNI-Bridge-Symbol.md`
>
> **预计篇幅**: 2500-3500 行
>
> **质量锚点**: `probe_md/15-core-native/prompts/prompt-00-System-Arraycopy.md` (521 行, 12 个 Section)
>               `probe_md/20-sa-postmortem/prompts/prompt-00-SA-Architecture.md` (700 行)

---

## §〇 Production Scenario

**场景**: 生产环境 JVM crash 后，SA 的 `jhsdb jstack --pid <pid>` 成功获取了线程栈，但运维工程师发现输出的栈帧中混有大量未知符号（如 `0x00007f8a3c4d2f1e` 而非 `JavaThread::run()`）。工程师需要理解：

1. SA 的 Java 层 `LinuxDebuggerLocal.lookupByName("libjvm.so", "JavaThread::run")` 是如何通过 JNI 桥接层，最终在 `libjvm.so` 的符号表中找到 `JavaThread::run` 的地址的？
2. 为什么 `readBytesFromProcess0()` 返回的内存数据与 Java 层 `DebuggerBase` 的 PageCache 缓存的数据可能不一致？何时绕过缓存？
3. 当 SA 尝试反汇编 native 方法进行深度诊断时，`hsdis-amd64.so` 插件是如何被加载的？为什么用 `dlsym("decode_instructions_virtual")` 而非编译时链接？

**真实案例**: 某量化交易系统 JVM crash（`SIGSEGV`），`jhsdb jstack` 成功但符号解析失败——因为 `libjvm.so` 被 `strip` 过，仅保留 `.dynsym` 动态符号表。工程师通过安装 `debuginfo` 包（放置到 `/usr/lib/debug/usr/lib/jvm/java-17/lib/server/libjvm.so.debug`），让 SA 通过 `.gnu_debuglink` 机制找到完整符号表，成功解析出所有 C++ 符号。

**本文档目标**: 深入 `LinuxDebuggerLocal.c` 的 JNI 桥接层 + `symtab.c` 的 ELF 符号表解析 + `sadis.c` 的反汇编器插件接口，解释 Java→C→ELF 三层符号查找的完整链路。

---

## §一 Task + Narrative + Beginner Callouts

### Task

写出一篇深度技术文档，覆盖：

1. **JNI 桥接层全景**: `LinuxDebuggerLocal.java` 的 native 方法声明 → `LinuxDebuggerLocal.c` 的 JNI 函数实现 → `libsaproc` 内部 API 的完整调用链
2. **JNI 方法注册机制**: 为什么用静态显式方法表（`init0` 中 `GetFieldID`/`GetMethodID` 缓存）而非 `RegisterNatives`？
3. **符号查找链路**: `lookupByName0` → `lookup_symbol` → `symtab_lookup` → ELF `.symtab`/`.dynsym` 的完整路径
4. **symtab.c 深度**: ELF 符号表格式（`Elf64_Sym`）、`elf_hash` vs GNU hash、`.gnu_debuglink` 与 Build ID 的 debuginfo 查找机制
5. **sadis.c 反汇编桥接**: `hsdis` 插件加载（`dlopen`）、`decode_instructions_virtual` 函数指针获取（`dlsym`）、Java 回调桥接（`event_to_env`/`printf_to_env`）
6. **readBytesFromProcess0 的 PageCache 交互**: Java 层 PageCache vs Native 层 raw read，何时绕过缓存

### Narrative

文档应该以**数据流**为主线：

```
Java 层调用 (LinuxDebuggerLocal.lookupByName)
    ↓
JNI 桥接 (LinuxDebuggerLocal.c: Java_sun_jvm_hotspot_debugger_linux_LinuxDebuggerLocal_lookupByName0)
    ↓
libsaproc API (lookup_symbol in libproc.h)
    ↓
符号表查找 (search_symbol in symtab.c → hsearch_r FIND)
    ↓
若未找到 → 遍历下一个 lib_info → 回到上一步
    ↓
若找到 → 返回 symbol offset + base address = 绝对地址
    ↓
Java 层接收 jlong 地址 → 转换为 Address 对象
```

对于反汇编路径：

```
Java 层调用 (Disassembler.decode)
    ↓
JNI 桥接 (sadis.c: Java_sun_jvm_hotspot_asm_Disassembler_load_library)
    ↓
dlopen("hsdis-amd64.so", RTLD_LAZY | RTLD_GLOBAL)
    ↓
dlsym(handle, "decode_instructions_virtual")
    ↓
获得函数指针 → 返回给 Java 层缓存为 jlong
    ↓
Java 层调用 decode → JNI 桥接 (sadis.c: Java_sun_jvm_hotspot_asm_Disassembler_decode)
    ↓
通过函数指针调用 hsdis 的 decode_instructions_virtual
    ↓
hsdis 通过回调 (event_to_env/printf_to_env) 将反汇编结果传回 Java 层
```

### Beginner Callouts (≥7 个，只在 §一 内)

> **💡 初学者提示 1**: JNI（Java Native Interface）是 Java 调用 C/C++ 函数的标准机制。`LinuxDebuggerLocal.c` 中的每个 `Java_sun_jvm_hotspot_debugger_linux_LinuxDebuggerLocal_*` 函数，都对应 `LinuxDebuggerLocal.java` 中的一个 `native` 方法。命名规则：`Java_<包名>_<类名>_<方法名>`，用下划线替代点号和美元号。

> **💡 初学者提示 2**: `init0()` 方法（在 Java 层静态初始化时调用）缓存了所有需要的 `jfieldID` 和 `jmethodID`。这是 JNI 性能优化的标准做法——`GetFieldID`/`GetMethodID` 每次调用都需要字符串比较，缓存后才只需 O(1) 的指针解引用。

> **💡 初学者提示 3**: ELF 符号表有两种：`.symtab`（完整符号表，包含静态函数/变量，通常只在未 strip 的二进制或 debuginfo 中存在）和 `.dynsym`（动态符号表，仅包含导出的全局符号，供动态链接器使用）。SA 优先使用 `.symtab`，因为它能解析 C++ 的 `JavaThread::run` 这类符号。

> **💡 初学者提示 4**: `symtab.c` 使用 `hcreate_r`/`hsearch_r`（GNU C 库的哈希表 API）来加速符号查找。为什么不自己写哈希表？因为符号表可能包含几万个符号（libjvm.so 未 strip 时有 ~50000 个符号），手动实现的哈希表很难比经过几十年优化的 GNU libc 实现更高效。

> **💡 初学者提示 5**: `hsdis`（HotSpot Disassembler）是一个独立的共享库，不是 libjvm.so 的一部分。原因是：1) 反汇编器实现依赖第三方库（如 Capstone 或 binutils 的 opcodes）；2) 不同 CPU 架构需要不同的反汇编器；3) 可以独立更新反汇编器而不重新编译 JVM。

> **💡 初学者提示 6**: `sadis.c` 中的 `decode_env` 结构体是一个**回调状态容器**，它把 JNI 环境（`JNIEnv*`）、Java 层 `Disassembler` 对象、以及 Java 层 `InstructionVisitor` 对象打包在一起，传递给 hsdis 的回调函数。这是 C 回调函数访问 Java 层对象的经典模式。

> **💡 初学者提示 7**: `readBytesFromProcess0` 直接调用 `ps_pdread`（通过 `ps_prochandle_ops` vtable），绕过 Java 层的 PageCache。这意味着：如果 Java 层已经通过 `DebuggerBase.readBytes` 缓存了某页，再通过 `readBytesFromProcess0` 读取相同地址，会得到**不同的数据副本**（一个是缓存的，一个是 ptrace 实时读取的）。通常不导致问题，因为 debuggee 已被 ptrace 挂起，内存不会变化。

---

## §二 Standard Environment

### Source Roots

```
src/jdk.hotspot.agent/linux/native/libsaproc/LinuxDebuggerLocal.c   # JNI 桥接层 (580 行)
src/jdk.hotspot.agent/linux/native/libsaproc/symtab.c               # ELF 符号表解析 (607 行)
src/jdk.hotspot.agent/linux/native/libsaproc/symtab.h               # 符号表 API (50 行)
src/jdk.hotspot.agent/share/native/libsaproc/sadis.c                # 反汇编器插件桥接 (344 行)
src/jdk.hotspot.agent/share/classes/sun/jvm/hotspot/debugger/linux/LinuxDebuggerLocal.java  # Java JNI 声明层
src/jdk.hotspot.agent/share/classes/sun/jvm/hotspot/asm/Disassembler.java                  # Java 反汇编器接口
```

### ELF 背景知识（必须补充阅读）

本文档涉及大量 ELF 格式细节，写作者必须先用 `man 5 elf` 查看 ELF 格式手册，特别关注：

- **Symbol Table**: `man 5 elf` 的 "Symbol Table" 章节，理解 `Elf64_Sym` 结构体（`st_name`, `st_value`, `st_size`, `st_info`, `st_shndx`）
- **Section Header**: `SHT_SYMTAB` vs `SHT_DYNSYM` 的区别
- **String Table**: 符号名不直接存储在 `Elf64_Sym` 中，而是存储为 `.strtab`/`.dynstr` 中的偏移量
- **hash 表**: `SHT_HASH`（`elf_hash`）vs `SHT_GNU_HASH`（GNU hash，更高效）

### hsdis 插件路径

```
# hsdis 插件的标准搜索路径（由 sadis.c 定义）
JRE/lib/amd64/server/hsdis-amd64.so   # 与 libjvm.so 同目录
/usr/lib/jvm/java-17/lib/server/hsdis-amd64.so
# 或通过 java -Dsun.boot.library.path=/path/to/hsdis 指定
```

### Build Command

```bash
# 全量构建 (产出 libsaproc.so + sa-jdi.jar + hsdis 可选)
make images

# 单独构建 libsaproc.so
make hotspot-native

# 产出路径
images/jdk/lib/libsaproc.so
```

### Syscall 速查表

| Syscall/Function | 用途 | 手册页 |
|---------|------|--------|
| `dlopen(3)` | 加载 hsdis 共享库 | `man 3 dlopen` |
| `dlsym(3)` | 查找 `decode_instructions_virtual` 函数指针 | `man 3 dlsym` |
| `dlerror(3)` | 获取 dlopen/dlsym 的错误信息 | `man 3 dlerror` |
| `fopen(3)` / `fread(3)` | 读取 ELF 文件（symtab.c 中通过 libproc 的 `read_section_data`） | `man 3 fopen` |
| `hcreate_r(3)` / `hsearch_r(3)` / `hdestroy_r(3)` | 创建/查找/销毁哈希表（symtab.c 符号查找） | `man 3 hcreate_r` |
| `crc32`（GNU `gnu_debuglink_crc32`） | 验证 debuginfo 文件的 CRC（symtab.c:65-129） | 无独立 man 页，参见 `man 5 gdb` 的 "Separate Debug Files" 章节 |
| `snprintf(3)` | 构建调试文件路径（symtab.c 的 `build_id_to_debug_filename`） | `man 3 snprintf` |

---

## §三 Source Files Table

| 文件 | 路径 | 行数 | 核心内容 |
|------|------|------|----------|
| `LinuxDebuggerLocal.c` | `src/jdk.hotspot.agent/linux/native/libsaproc/` | 580 | **JNI 桥接层**: `init0`（jfieldID/jmethodID 缓存）、`attach0`（两重载：PID/core）、`lookupByName0`、`lookupByAddress0`、`readBytesFromProcess0`、`getThreadIntegerRegisterSet0`、`detach0`、`setSAAltRoot0` |
| `symtab.h` | `src/jdk.hotspot.agent/linux/native/libsaproc/` | 50 | **符号表 API 声明**: `struct symtab` 不透明类型 + 4 个函数（`build_symtab`, `destroy_symtab`, `search_symbol`, `nearest_symbol`） |
| `symtab.c` | `src/jdk.hotspot.agent/linux/native/libsaproc/` | 607 | **ELF 符号表解析核心**: `build_symtab_internal`（读取 ELF section、构建哈希表）、`open_file_from_debug_link`（`.gnu_debuglink` 处理）、`build_symtab_from_build_id`（Build ID 处理）、`search_symbol`（哈希查找）、`nearest_symbol`（偏移最近符号查找） |
| `sadis.c` | `src/jdk.hotspot.agent/share/native/libsaproc/` | 344 | **反汇编器插件桥接**: `load_library`（`dlopen`/`dlsym`）、`decode`（调用 hsdis）、`event_to_env`（事件回调桥接）、`printf_to_env`（输出回调桥接） |
| `LinuxDebuggerLocal.java` | `src/jdk.hotspot.agent/share/classes/sun/jvm/hotspot/debugger/linux/` | ~800 | **Java JNI 声明层**: `init0()`、`attach0`（两重载）、`detach0()`、`lookupByName0`、`lookupByAddress0`、`readBytesFromProcess0`、`getThreadIntegerRegisterSet0`、`createClosestSymbol`（JNI 回调） |
| `Disassembler.java` | `src/jdk.hotspot.agent/share/classes/sun/jvm/hotspot/asm/` | ~300 | **Java 反汇编器接口**: `load_library`（JNI 调用 sadis）、`decode`（JNI 调用 hsdis）、`handleEvent`（事件回调）、`rawPrint`（输出回调） |
| `libproc.h` | `src/jdk.hotspot.agent/linux/native/libsaproc/` | 108 | **libsaproc 公共 C API**: `lookup_symbol`（symtab.c 的入口）、`symbol_for_pc`（地址→符号反向查找）等 |
| `salibelf.h` | `src/jdk.hotspot.agent/linux/native/libsaproc/` | ~200 | **ELF 文件读取辅助 API**: `read_elf_header`、`read_section_header_table`、`read_section_data`、`find_base_address` |

---

## §四 Deep Dive Question Groups

### 问题组 1: JNI 方法注册机制——为什么用显式方法表而非 RegisterNatives？

**问题**: `LinuxDebuggerLocal.c:98-129` 的 `init0` 方法中，手动缓存了 `jfieldID` 和 `jmethodID`，但没有使用 `RegisterNatives` 来批量注册 JNI 方法。为什么？两种方案各有什么优劣？

**答案方向** (≥8 行):

在 `LinuxDebuggerLocal.c:98-129`，`init0` 方法在 Java 层静态初始化时调用（`LinuxDebuggerLocal.java` 的 `static { init0(); }`），手动缓存了 4 个 `jfieldID` 和 4 个 `jmethodID`：

```c
// LinuxDebuggerLocal.c:107-128
p_ps_prochandle_ID = (*env)->GetFieldID(env, cls, "p_ps_prochandle", "J");
threadList_ID = (*env)->GetFieldID(env, cls, "threadList", "Ljava/util/List;");
createClosestSymbol_ID = (*env)->GetMethodID(env, cls, "createClosestSymbol", ...);
// ... 共 8 个 ID 缓存
```

**两种方案对比**:

| 方案 | 实现方式 | 优点 | 缺点 |
|------|---------|------|------|
| **显式方法表（当前方案）** | `init0` 中手动 `GetFieldID`/`GetMethodID` | 简单、兼容旧 JDK、易于调试（GDB 中可直接打断点） | 每次 JNI 调用都需要通过缓存的 ID 访问，代码冗余 |
| **RegisterNatives** | 在 `JNI_OnLoad` 中调用 `RegisterNatives` 批量注册 | 更简洁、JVM 可内联优化、符合现代 JNI 最佳实践 | 需要维护方法表数组、旧 JDK 可能不兼容 |

**为什么选显式方法表？**
1. **历史兼容性**: SA 代码最早写于 2002 年（`LinuxDebuggerLocal.c:2` 版权 2002-2019），当时 `RegisterNatives` 的最佳实践尚未普及
2. **调试友好**: 每个 JNI 函数有独立的 C 函数名，GDB 中可直接 `break Java_sun_jvm_hotspot_debugger_linux_LinuxDebuggerLocal_attach0`
3. **简单性**: 对于只有 8 个 JNI 方法的类，`RegisterNatives` 的复杂性不值得

**Counterfactual（反事实讨论）**:
> 如果改用 `RegisterNatives`，需要在 `JNI_OnLoad` 中定义方法表数组：
> ```c
> static JNINativeMethod methods[] = {
>   {"init0", "()V", (void*)Java_sun_jvm_hotspot_debugger_linux_LinuxDebuggerLocal_init0},
>   {"attach0", "(I)V", (void*)Java_sun_jvm_hotspot_debugger_linux_LinuxDebuggerLocal_attach0__I},
>   // ...
> };
> ```
> 优点：JVM 可以对 `attach0` 等频繁调用的方法做内联优化。缺点：方法签名中的重载（`attach0__I` vs `attach0__Ljava_lang_String_2Ljava_lang_String_2`）需要手动处理，容易出错。

**量化对比**:
- `GetFieldID` 开销：~100ns/次（首次调用，需要字符串比较）
- 缓存后访问：`jlong ptr = (*env)->GetLongField(env, this_obj, p_ps_prochandle_ID)` → ~10ns/次（直接偏移访问）
- **结论**: 缓存的收益是 10x 性能提升，对于频繁调用的 `readBytesFromProcess0`（每次读取 1 页需要 1 次调用），必须缓存。

**源码引用**: `LinuxDebuggerLocal.c:61-68`（静态 ID 缓存变量）、`LinuxDebuggerLocal.c:98-129`（`init0` 实现）、`LinuxDebuggerLocal.java:102-119`（native 方法声明）

---

### 问题组 2: Worker 线程消息队列——为什么 JNI 调用不能直接用 ptrace？

**问题**: `LinuxDebuggerLocal.c` 中的 JNI 方法（如 `attach0`、`readBytesFromProcess0`）是如何与目标进程交互的？为什么不能通过 JNI 直接调用 `ptrace(2)`？Worker 线程的消息队列设计是什么？

**答案方向** (≥8 行):

**关键发现**: `LinuxDebuggerLocal.c` **不直接调用 ptrace**！所有内存读取和寄存器访问，都通过 `ps_prochandle` 的 `ops` vtable 分派到 `ps_proc.c`（Live Mode）或 `ps_core.c`（Postmortem Mode）的实现。

**调用链**:
```
Java: LinuxDebuggerLocal.readBytesFromProcess0(addr, numBytes)
  ↓ JNI
C: Java_sun_jvm_hotspot_debugger_linux_LinuxDebuggerLocal_readBytesFromProcess0
  ↓ 调用 ps_pdread (通过 ops->p_pread 函数指针)
C: process_read_data (ps_proc.c)  [Live Mode]
  ↓ 循环调用 ptrace(PTRACE_PEEKDATA)
或
C: core_read_data (ps_core.c)  [Postmortem Mode]
  ↓ 调用 pread(fd, buf, size, offset)
```

**为什么 JNI 层不直接用 ptrace？**
1. **跨平台抽象**: `LinuxDebuggerLocal.c` 是 Linux 特有的 JNI 层，但 `libsaproc` 的设计支持 Solaris/Windows。直接在 JNI 层调用 `ptrace` 会破坏抽象
2. **两模式支持**: Live Mode 用 `ptrace`，Postmortem Mode 用 `pread`。JNI 层不应该关心模式差异，通过 `ops` vtable 分派即可
3. **权限管理**: `ptrace` 需要 `CAP_SYS_PTRACE` 或 `ptrace_scope=0`（`/proc/sys/kernel/yama/ptrace_scope`）。这些检查在 `Pgrab`（`ps_proc.c`）中统一处理，而非 JNI 层

**Worker 线程消息队列（如果有）**:
> **注意**: 实际上 SA 的 `libsaproc` **没有 Worker 线程**！所有操作都是**同步阻塞**的：Java 层调用 JNI → JNI 调用 `ps_pdread` → 阻塞直到 `ptrace` 返回。这与 GDB 的 `gdbserver` 模式不同。
>
> 如果未来需要异步操作（如 `jhsdb` GUI 的"暂停/继续"按钮），可以引入 Worker 线程消息队列：
> - Java 层将请求放入 `BlockingQueue`
> - Worker 线程从队列取出请求，调用 `ps_pdread`
> - 结果通过 `Future<ReadResult>` 返回给 Java 层

**Counterfactual**:
> 如果 JNI 层直接调用 `ptrace(2)`，代码会是：
> ```c
> JNIEXPORT jbyteArray JNICALL Java_..._readBytesFromProcess0(JNIEnv *env, jobject this_obj, jlong addr, jlong numBytes) {
>   int pid = get_pid(env, this_obj);
>   for (int i = 0; i < numBytes; i += 8) {
>     long data = ptrace(PTRACE_PEEKDATA, pid, addr + i, 0);  // 直接系统调用
>     // ...
>   }
> }
> ```
> 缺点：(1) 无法支持 core dump 模式；(2) 与 Solaris/Windows 的 `libproc` 不兼容；(3) 缺少 `PageCache` 协调（Java 层缓存的是 `DebuggerBase` 的页，而非 `ptrace` 的原始返回值）。

**源码引用**: `LinuxDebuggerLocal.c:382-398`（`readBytesFromProcess0` 实现，调用 `ps_pdread`）、`libproc_impl.h:67-72`（`ops->p_pread` 函数指针定义）、`ps_proc.c:69-116`（`process_read_data` 的 `ptrace` 调用）

---

### 问题组 3: readBytesFromProcess0() 的 PageCache 交互——Java 层 PageCache vs Native 层 raw read

**问题**: `LinuxDebuggerLocal.c:382-398` 的 `readBytesFromProcess0` 直接调用 `ps_pdread`，绕过 Java 层 `DebuggerBase.java` 的 PageCache。这会导致什么问题？什么时候应该绕过缓存？

**答案方向** (≥8 行):

**两层缓存架构**:

| 层级 | 实现位置 | 缓存内容 | 缓存大小 | 用途 |
|------|---------|---------|---------|------|
| **Java 层 PageCache** | `DebuggerBase.java` | 4KB 页（对齐的虚拟地址） | 4096 页 × 4KB = 16MB | 减少 `readBytes` 调用次数 |
| **Native 层 raw read** | `ps_proc.c:process_read_data` | 无缓存（每次都调用 `ptrace`） | - | 直接读取 debuggee 内存 |

**调用路径对比**:

```
路径 1: Java 层通过 DebuggerBase.readBytes (有 PageCache)
  DebuggerBase.readBytes(addr, numBytes)
    → 检查 PageCache 是否命中
    → 未命中 → readPage(addr) → JNI → readBytesFromProcess0 → ps_pdread
    → 命中 → 直接返回缓存数据（不调用 JNI）

路径 2: Java 层直接调用 readBytesFromProcess0 (无 PageCache)
  LinuxDebuggerLocal.readBytesFromProcess0(addr, numBytes)  // 直接 JNI 调用
    → 无缓存检查
    → 直接调用 ps_pdread → ptrace(PTRACE_PEEKDATA)
```

**什么时候绕过 PageCache 是合理的？**
1. **实时性要求高**: 如 `lookupByAddress0` 需要读取 debuggee 内存来解析符号（虽然实际上符号查找是通过 `symtab` 缓存，不需要实时读取内存）
2. **避免缓存一致性问题**: 如果 debuggee 仍在运行（理论上 SA 应该挂起 debuggee，但 `jhsdb` GUI 模式可能不挂起），缓存的数据可能过时
3. **大块读取**: PageCache 以 4KB 页为单位，读取 1MB 数据时会有 256 次缓存检查开销。直接调用 `readBytesFromProcess0` 可以减少这 256 次检查

**实际问题**:
> `readBytesFromProcess0` 绕过 PageCache **不会导致错误**，因为：
> 1. SA 在 `attach0` 后通过 `ptrace(PTRACE_ATTACH)` 挂起了 debuggee（所有线程收到 `SIGSTOP`）
> 2. debuggee 内存不会变化，所以 PageCache 的数据永远是"正确的"
> 3. 绕过缓存只是**性能损失**（多了不必要的 `ptrace` 调用），而非正确性问题

**性能量化** (读取 4KB 数据):

| 方案 | ptrace 调用次数 | 时间开销 |
|------|-------------|---------|
| 通过 PageCache（冷启动） | 512 次（4KB ÷ 8 字节/次） | ~50-100 μs |
| 通过 PageCache（热命中） | 0 次 | ~1 μs（Java 层内存复制） |
| 绕过 PageCache（直接调用 readBytesFromProcess0） | 512 次 | ~50-100 μs |

**结论**: 应该**优先使用 PageCache**，只有在特殊场景（如需要读取不在页对齐边界上的小数据）才绕过。

**Counterfactual**:
> 如果 PageCache 在 Native 层实现（而非 Java 层），可以减少 JNI 调用开销。但这样会破坏 SA 的架构分层（Java 层应该负责高级逻辑，Native 层只做必要的系统调用）。实际上，HotSpot JVM 的 `ciReplay`（编译复现）就用了类似的 Native 层缓存，证明 Native 缓存是可行的。

**源码引用**: `LinuxDebuggerLocal.c:382-398`（`readBytesFromProcess0` 实现）、`DebuggerBase.java`（`readBytes` + `readPage`）、`ps_proc.c:69-116`（`process_read_data` 的 `ptrace` 循环）

---

### 问题组 4: symtab.c 的符号查找算法——elf_hash() vs GNU hash，为什么优先 .symtab 而非 .dynsym？

**问题**: `symtab.c:329-551` 的 `build_symtab_internal` 函数首先查找 `SHT_SYMTAB` section（完整符号表），如果没有才用 `SHT_DYNSYM`（动态符号表）。为什么？`elf_hash()` 和 GNU hash 有什么区别？

**答案方向** (≥8 行):

**ELF 符号表的两种类型**:

| 类型 | Section 名 | 包含的符号 | 用途 | 大小（libjvm.so） |
|------|-----------|---------|------|-------------------|
| `SHT_SYMTAB` | `.symtab` | **所有符号**（函数、变量、静态符号） | 调试（gdb、SA） | ~50,000 符号（未 strip） |
| `SHT_DYNSYM` | `.dynsym` | **仅导出的全局符号** | 动态链接（`ld.so`） | ~5,000 符号 |

**为什么优先 .symtab？**
1. **C++ 符号可见性**: `libjvm.so` 中的大部分符号是 `static` 或匿名命名空间中的，不会导出到 `.dynsym`。例如 `JavaThread::run()` 如果是 `static` 函数，只在 `.symtab` 中
2. **调试友好**: SA 的核心用途是**调试**（获取线程栈、解析符号），需要完整的符号表才能将程序计数器（PC）映射到函数名
3. **strip 的影响**: 如果 `libjvm.so` 被 `strip` 过，`.symtab` 会被删除，只保留 `.dynsym`。此时 SA 会退而求其次用 `.dynsym`，但符号覆盖率大幅下降

**elf_hash() vs GNU hash**:

| 算法 | 定义位置 | 冲突率 | 查找速度 | 使用情况 |
|------|---------|---------|---------|---------|
| `elf_hash` | System V ABI | 高（简单的移位异或） | 较慢 | 旧系统、`.hash` section |
| `GNU hash` | GNU libc 扩展 | 低（bloom filter + 分组） | 快 ~50% | 现代系统、`.gnu.hash` section |

**symtab.c 中的实现**:
```c
// symtab.c:416-432
// 使用 hcreate_r/hsearch_r（GNU libc 的哈希表 API）来构建内存中的符号查找表
htab_sz = n * 1.25;  // 哈希表大小 = 符号数 × 1.25（减少冲突）
rslt = hcreate_r(n, symtab->hash_table);
```

**注意**: `symtab.c` **没有实现 `elf_hash` 或 GNU hash** 的解析！它直接读取 ELF section 的数据，然后用 GNU libc 的 `hcreate_r` 构建自己的哈希表。ELF 文件中的 `.hash`/`.gnu.hash` section 只在动态链接器（`ld.so`）加载共享库时使用，SA 作为离线调试工具，不需要遵循相同的查找算法。

**Counterfactual**:
> 如果 SA 直接用 ELF 的 `.hash`/`.gnu.hash` section 做符号查找（而非构建独立的 `hsearch_r` 哈希表），可以节省内存（不需要 `symtab->strs` 和 `symtab->symbols` 数组）。但 `.hash`/`.gnu.hash` 的格式复杂（需要解析 bucket/chain 数组），且不支持"遍历所有符号"（需要实现 `nearest_symbol` 功能）。用 `hsearch_r` 是更简单且功能完备的方案。

**量化对比** (查找 `JavaThread::run` 符号):

| 方案 | 查找时间 | 内存占用 | 支持遍历 |
|------|---------|---------|---------|
| 遍历 `.symtab` 数组（线性查找） | O(n) = ~50,000 次比较 | 0（无额外内存） | 是 |
| 用 `hsearch_r` 哈希表（当前方案） | O(1) = ~1-2 次比较 | +16MB（哈希表） | 是（通过 `symtab->symbols` 数组） |
| 用 `.gnu.hash` section | O(1) = ~1 次比较 | 0（无额外内存） | 否（需要额外解析 `.symtab`） |

**源码引用**: `symtab.c:370-384`（优先选择 `SHT_SYMTAB`）、`symtab.c:416-432`（构建 `hsearch_r` 哈希表）、`symtab.c:569-592`（`search_symbol` 哈希查找）

---

### 问题组 5: lookup_symbol() 的库遍历顺序——遍历 lib_info 链表的顺序意味着什么？

**问题**: `libproc.h:98-99` 的 `lookup_symbol` 函数遍历 `lib_info` 链表，在每个库的 `symtab` 中查找符号。遍历顺序是什么？这意味着什么？`libjvm.so` 通常在链表的什么位置？

**答案方向** (≥8 行):

**lookup_symbol 的实现** (`libproc_impl.c`，具体函数在 `libproc.h` 中声明，在 `libproc_impl.c` 中实现):

```c
// 伪代码（基于 libproc.h:98-99 的声明和 libproc_impl.c 的实现）
uintptr_t lookup_symbol(struct ps_prochandle* ph, const char* object_name, const char* symbol_name) {
  lib_info* lib = ph->libs;
  while (lib != NULL) {
    if (object_name == NULL || strcmp(lib->name, object_name) == 0) {
      uintptr_t addr = search_symbol(lib->symtab, lib->base, symbol_name, NULL);
      if (addr != 0) return addr;
    }
    lib = lib->next;
  }
  return 0;  // 未找到
}
```

**遍历顺序 = 库加载顺序**:

`lib_info` 链表是通过 `add_lib_info`（`libproc_impl.c:115`）**尾插法**构建的，保持库加载顺序（从 `/proc/<pid>/maps` 或 core dump 的 `NT_FILE` note 中按地址升序读取）。

**典型 JVM 进程的库加载顺序**:

| 顺序 | 库名 | 说明 |
|------|------|------|
| 1 | `/usr/lib/jvm/java-17/bin/java`（可执行文件） | 第一个，基址最低 |
| 2 | `linux-vdso.so.1`（内核提供的虚拟 DSO） | 高地址，内核映射 |
| 3 | `/lib/x86_64-linux-gnu/libc.so.6` | 基础 C 库 |
| 4 | `/lib/x86_64-linux-gnu/libpthread.so.0` | POSIX 线程库 |
| 5 | `.../libjvm.so` | **HotSpot JVM**，通常在第 5-10 位 |
| ... | ... | ... |
| N | `/lib/x86_64-linux-gnu/libnss_dns.so.2` | 动态加载的库（如 DNS 解析器） |

**这意味着什么？**
1. **符号查找的性能**: 如果目标符号在 `libc.so.6` 中（如 `malloc`），会在遍历早期找到。如果在 `libjvm.so` 中，需要遍历 4-9 个库
2. **符号名冲突**: 如果多个库定义了同名符号（如 `malloc` 在 `libc.so.6` 和 `libtcmalloc.so` 中都存在），**先加载的库优先**（`libc.so.6` 的 `malloc` 会被返回）
3. **object_name 参数**: `lookupByName0` 可以传入 `object_name = "libjvm.so"`，此时只查找 `libjvm.so` 的符号表，跳过遍历

**libjvm.so 通常在链表的什么位置？**
- **Live Mode**: 通过 `/proc/<pid>/maps` 读取，按地址升序排列。`libjvm.so` 的基址通常比 `libc.so.6` 高（因为它是后来 `dlopen` 的），所以在链表的**中间偏后**位置
- **Postmortem Mode**: 通过 core dump 的 `NT_FILE` note 读取，顺序与 Live Mode 类似

**优化方向**:
> 如果 `lookup_symbol` 被频繁调用（如栈回溯时对每个 PC 调用 `symbol_for_pc`），遍历链表的开销会累积。可以用**哈希表缓存**（以 `symbol_name` 为 key，以 `addr` 为 value），但需要考虑内存占用和缓存失效（debuggee 内存变化时）。

**Counterfactual**:
> 如果 `lib_info` 改用**按库名哈希的哈希表**（而非链表），`lookup_symbol` 可以 O(1) 定位到指定库（当 `object_name != NULL` 时）。但对于 `object_name == NULL` 的遍历查找，哈希表反而需要遍历所有 bucket，退化到 O(n)。链表虽然 O(n)，但 n 通常 < 200，性能可接受。

**源码引用**: `libproc_impl.h:38-44`（`lib_info` 结构体定义）、`libproc_impl.c:115`（`add_lib_info` 尾插实现）、`symtab.c:569-592`（`search_symbol` 哈希查找）

---

### 问题组 6: sadis.c 的反汇编桥接——hsdis 插件加载机制，为什么用 dlsym 而非编译时链接？

**问题**: `sadis.c:115-186` 的 `load_library` 函数通过 `dlopen`/`dlsym` 动态加载 `hsdis` 插件。为什么不用编译时链接（如 `-lhsdis`）？`decode_instructions_virtual` 的函数签名是什么？

**答案方向** (≥8 行):

**hsdis 插件加载流程** (`sadis.c:115-186`):

```c
// sadis.c:157-164 (Linux 路径)
hsdis_handle = dlopen(libname, RTLD_LAZY | RTLD_GLOBAL);
if (hsdis_handle != NULL) {
  func = (uintptr_t)dlsym(hsdis_handle, "decode_instructions_virtual");
}
```

**为什么用运行时动态加载而非编译时链接？**

| 方案 | 实现方式 | 优点 | 缺点 |
|------|---------|------|------|
| **编译时链接**（`-lhsdis`） | 编译 `libsaproc.so` 时链接 `libhsdis.so` | 简单、编译期类型检查 | `libhsdis.so` 必须存在，否则 `libsaproc.so` 无法加载 |
| **运行时动态加载**（当前方案） | `dlopen` + `dlsym` | `hsdis` 可选安装、多版本共存、跨 CPU 架构灵活 | 需要手动管理函数指针、无类型检查 |

**核心原因**:
1. **hsdis 是可选组件**: SA 的核心功能（线程栈、内存读取）不依赖反汇编。如果用户没有安装 `hsdis`，`libsaproc.so` 仍应正常加载
2. **跨 CPU 架构**: `hsdis-amd64.so`、`hsdis-aarch64.so`、`hsdis-sparc.so` 是不同文件。编译时链接无法处理这种多架构共存
3. **多版本共存**: 用户可以同时安装基于 Capstone 的 `hsdis` 和基于 binutils 的 `hsdis`，通过替换 `.so` 文件切换
4. ** Licensing 问题**: `hsdis` 可能依赖 GPL 授权的 binutils。用动态加载可以避免 `libsaproc.so` 的 GPL 污染（虽然实际上 SA 是 GPL 的，但模块化设计仍有价值）

**decode_instructions_virtual 的函数签名** (`sadis.c:189-196`):

```c
// sadis.c:189-196
typedef void* (*decode_func)(uintptr_t start_va, uintptr_t end_va,
                             unsigned char* start, uintptr_t length,
                             void* (*event_callback)(void*, const char*, void*),
                             void* event_stream,
                             int (*printf_callback)(void*, const char*, ...),
                             void* printf_stream,
                             const char* options,
                             int newline);
```

**参数解释**:
- `start_va`/`end_va`: 反汇编的虚拟地址范围
- `start`/`length`: 机器码字节数组（从 debuggee 内存读取）
- `event_callback`/`printf_callback`: 两个回调函数，用于将反汇编结果传回 Java 层
- `options`: 反汇编选项（如 `-XX:+PrintAssembly` 的选项）
- `newline`: 是否在每个指令后换行

**回调桥接机制** (`sadis.c:210-278`):

```
hsdis 调用 event_callback (C 函数)
  ↓
event_to_env (sadis.c:210-228) 将其转换为 Java 调用
  ↓
Disassembler.handleEvent (Java 方法)
  ↓
返回结果给 hsdis（如"跳过此指令"）

hsdis 调用 printf_callback (C 函数)
  ↓
printf_to_env (sadis.c:231-278) 将其转换为 Java 调用
  ↓
Disassembler.rawPrint (Java 方法)
  ↓
输出反汇编文本到 InstructionVisitor
```

**Counterfactual**:
> 如果 `libsaproc.so` 编译时链接 `libhsdis.so`，`Java_sun_jvm_hotspot_asm_Disassembler_load_library` 函数就不需要了（JVM 启动时会自动加载依赖的 `.so`）。但这样会导致：1) 没有安装 `hsdis` 时 `libsaproc.so` 加载失败（`UnsatisfiedLinkError`）；2) 无法支持多 `hsdis` 版本共存；3) 跨架构构建复杂（需要为 each arch 编译不同的 `libsaproc.so`）。

**量化对比** (反汇编 100 条 x86-64 指令):

| 方案 | 反汇编时间 | 回调开销 | 总时间 |
|------|---------|---------|--------|
| hsdis (Capstone) | ~50 μs | ~200 μs（Java 回调） | ~250 μs |
| hsdis (binutils) | ~100 μs | ~200 μs（Java 回调） | ~300 μs |
| **瓶颈**: Java 回调开销占 80%，优化方向是批量回调（一次传递多条指令的反汇编结果） |

**源码引用**: `sadis.c:115-186`（`load_library` 实现）、`sadis.c:189-196`（`decode_func` 函数指针类型定义）、`sadis.c:210-228`（`event_to_env` 回调桥接）、`sadis.c:285-344`（`decode` JNI 方法）

---

## §五 Article Structure

文档应按以下结构组织（## 表示一级章节，### 表示二级章节）：

```
# 03 JNI 桥接 + 符号表解析 — LinuxDebuggerLocal.c + symtab.c + sadis.c 深度解析

## §一 JNI 桥接层全景：从 Java 调用到 Native 实现
### 1.1 LinuxDebuggerLocal.java 的 native 方法声明（8 个 JNI 方法）
### 1.2 LinuxDebuggerLocal.c 的 JNI 函数实现（命名规则、参数转换）
### 1.3 init0 的 jfieldID/jmethodID 缓存机制（性能优化）
### 1.4 两模式（Live/Postmortem）在 JNI 层的统一接口

## §二 符号查找链路深度分析
### 2.1 lookupByName0 的完整调用链（Java → JNI → libsaproc → symtab）
### 2.2 lookupByAddress0 的反向查找（地址 → 符号名 + 偏移）
### 2.3 lib_info 链表的遍历策略（按加载顺序、object_name 过滤）
### 2.4 search_symbol 的哈希查找算法（hsearch_r FIND）

## §三 symtab.c 深度：ELF 符号表解析
### 3.1 ELF 符号表格式背景（Elf64_Sym、st_name、st_value、st_size、st_info）
### 3.2 build_symtab_internal 的完整流程（读取 ELF section、构建哈希表）
### 3.3 .symtab vs .dynsym：为什么优先完整符号表？
### 3.4 debuginfo 查找机制（.gnu_debuglink、Build ID、/usr/lib/debug）
### 3.5 nearest_symbol 的实现（遍历符号表、找到包含给定偏移的符号）

## §四 readBytesFromProcess0 的 PageCache 交互
### 4.1 Java 层 PageCache 的工作原理（DebuggerBase.java、16MB 缓存）
### 4.2 Native 层 raw read 的实现（ps_pdread → ptrace/pread）
### 4.3 两层缓存的协调（何时命中、何时绕过、一致性保证）
### 4.4 性能量化：有/无 PageCache 的 ptrace 调用次数对比

## §五 sadis.c 反汇编桥接：hsdis 插件加载机制
### 5.1 hsdis 插件的作用（为什么 JVM 需要内嵌反汇编？）
### 5.2 load_library 的动态加载流程（dlopen、dlsym、错误处理）
### 5.3 decode_instructions_virtual 的函数签名（参数、返回值、回调机制）
### 5.4 回调桥接：event_to_env 和 printf_to_env（C → Java 的数据传递）
### 5.5 多架构支持：hsdis-amd64.so、hsdis-aarch64.so 的共存机制

## §六 边缘场景与诊断工具
### 6.1 符号表缺失（strip 过的 libjvm.so）→ 安装 debuginfo 包
### 6.2 hsdis 插件未安装 → 反汇编功能不可用，但不影响核心功能
### 6.3 ELF 格式错误（损坏的二进制文件）→ build_symtab_internal 返回 NULL
### 6.4 诊断工具五件套：jhsdb + nm + objdump + readelf + GDB

## §七 总结：JNI 桥接层设计的权衡
### 7.1 显式方法表 vs RegisterNatives：历史兼容性与现代最佳实践
### 7.2 运行时动态加载 vs 编译时链接：可选组件的设计模式
### 7.3 哈希表缓存 vs 线性遍历：符号查找的性能优化
### 7.4 两层缓存架构：Java 层 PageCache + Native 层 raw read 的协调

```

---

## §六 Writing Requirements

### 6.1 总体原则

1. **源码是证据（20%），原理是正文（80%）**: 不要写成源码翻译，要解释"为什么这么设计"
2. **每个技术断言必须标注 file:line 引用**: 如 `LinuxDebuggerLocal.c:107-128`
3. **量化对比优先**: 用表格/数字说明性能差距、内存占用、复杂度
4. **Counterfactual 讨论**: 每个设计决策都要讨论"如果选另一个方案会怎样"
5. **ELF 格式背景必须补充**: 遇到 `Elf64_Sym`、`SHT_SYMTAB`、`st_value` 等，先用 `man 5 elf` 查看详细格式

### 6.2 "不要写成→应该写成"对照表

| 不要写成 | 应该写成 |
|---------|---------|
| 只列 JNI 函数名和签名 | 解释每个 JNI 函数的用途、参数转换（jstring → C string）、错误处理（THROW_NEW_DEBUGGER_EXCEPTION） |
| 只说"symtab.c 解析 ELF 符号表" | 详细解释 `Elf64_Sym` 结构体的每个字段、`.symtab` section 的布局、哈希表的构建过程 |
| 只贴 hsearch_r 调用代码 | 解释为什么用 `hcreate_r`/`hsearch_r`（GNU libc 的哈希表 API），而非手动实现哈希表 |
| 只说"hsdis 通过 dlopen 加载" | 解释为什么用运行时动态加载（可选组件、多架构、多版本共存），而非编译时链接 |
| 只说"readBytesFromProcess0 绕过 PageCache" | 量化对比：有/无 PageCache 的 ptrace 调用次数、性能差距、是否导致正确性问题 |
| 只贴代码不解释 | 每个代码块后跟 3-5 行解释：这段代码的意图、关键点、与前后文的关联 |
| 只说"详见 man 手册" | 具体引用 man 章节（如 `man 5 elf` 的 "Symbol Table" 部分、`man 3 dlopen` 的 `RTLD_LAZY` 标志），并解释关键参数 |
| 只解释 Java 层或只解释 C 层 | 必须解释**完整调用链**：Java 层方法声明 → JNI 函数实现 → libsaproc 内部 API → 系统调用 |

### 6.3 源码阅读要求

1. **必须读源码**: 不要依赖 prompt 中的摘要，直接读 `.c` / `.h` / `.java` 文件
2. **用 man 手册验证系统调用和文件格式**: 遇到 `dlopen` / `hcreate_r` / ELF 格式等，立即 `man 3 dlopen` 或 `man 5 elf` 查看详细参数和格式
3. **追踪调用链**: 从 `lookupByName0` → `lookup_symbol` → `search_symbol`，完整追踪调用链
4. **对比 Live/Postmortem 实现**: 虽然本文档聚焦 JNI 桥接层和符号表，但需注意 `readBytesFromProcess0` 通过 `ops` vtable 分派到不同实现
5. **补充 ELF 背景知识**: 本文档涉及大量 ELF 细节，写作者必须先用 `man 5 elf` 学习，再写文档

---

## §七 Output Format

### 7.1 文件格式

- **格式**: GitHub Flavored Markdown (`.md`)
- **编码**: UTF-8
- **行宽**: 100 字符（方便终端阅读）

### 7.2 代码块格式

```c
// 代码块必须标注文件路径和行号范围
// 示例：
// LinuxDebuggerLocal.c:107-128

  p_ps_prochandle_ID = (*env)->GetFieldID(env, cls, "p_ps_prochandle", "J");
  CHECK_EXCEPTION;
  threadList_ID = (*env)->GetFieldID(env, cls, "threadList", "Ljava/util/List;");
  CHECK_EXCEPTION;
```

```java
// 示例：LinuxDebuggerLocal.java:102-118

    private native static void init0() throws DebuggerException;
    private native void attach0(int pid) throws DebuggerException;
    private native long lookupByName0(String objectName, String symbol) throws DebuggerException;
```

### 7.3 表格格式

使用 GitHub Flavored Markdown 表格，对齐列宽。

### 7.4 Callout 格式

使用 `> **💡 初学者提示 X**` 格式（仅在 §一 中，不重复）：

```markdown
> **💡 初学者提示 8**: 这是第 8 个 callout（如果需要超过 7 个）。
```

### 7.5 章节编号

使用 `## §一` `### 1.1` 格式，确保 `rg '^## §' file.md` 能验证连续无跳号。

---

## §八 Prohibited（≥8 条）

1. **禁止写成源码翻译**: 不要逐行解释代码，要提炼设计原理和权衡
2. **禁止遗漏 file:line 引用**: 每个技术断言必须标注源码位置（如 `LinuxDebuggerLocal.c:107-128`）
3. **禁止只列 JNI 函数签名不解释**: 每个 JNI 函数必须解释用途、参数转换、错误处理
4. **禁止跳过 counterfactual 讨论**: §四 的每个问题组必须包含"如果选另一个方案会怎样"
5. **禁止在 §一 以外添加 Beginner Callout**: Callout 只能在 §一 内，避免重复
6. **禁止遗漏 man 手册引用**: 每个系统调用/ELF 格式必须标注 `man 2 xxx`/`man 3 xxx`/`man 5 xxx`
7. **禁止写成科普文**: 本文档的目标读者是有 C 和 Linux 系统编程经验的工程师，不要解释"什么是 JNI"
8. **禁止遗漏边缘场景**: §六 必须包含 ≥4 个边缘场景（符号表缺失/hsdis 未安装/ELF 格式错误/PageCache 一致性）
9. **禁止混淆 Java 层和 Native 层的职责**: 明确标注每个函数/数据结构的所属层（Java JNI 声明层 vs JNI 桥接层 vs Native libsaproc 层）
10. **禁止遗漏 hsdis 的反汇编桥接机制**: §五 必须详细解释 `event_to_env` 和 `printf_to_env` 的回调桥接

---

## §九 Required（≥8 条）

1. **必须包含 JNI 桥接层全景图**: 用 ASCII art 或 Mermaid 绘制 Java → JNI → Native 的调用链（覆盖所有 8 个 JNI 方法）
2. **必须包含符号查找链路的完整调用链**: 从 `LinuxDebuggerLocal.lookupByName` 到 `search_symbol` 的每一步
3. **必须逐个解释 symtab.c 的核心函数**: `build_symtab_internal`、`search_symbol`、`nearest_symbol`、`destroy_symtab`
4. **必须在 §四 包含 ≥6 个深度问题组**: 每组含 counterfactual 讨论 + 量化对比 + 源码引用
5. **必须解释 ELF 符号表格式**: 用 `Elf64_Sym` 结构体字段解释符号表的布局（可引用 `man 5 elf`）
6. **必须包含 hsdis 插件加载的完整流程**: `dlopen` → `dlsym` → 函数指针缓存 → `decode` 调用
7. **必须包含边缘场景 section**: ≥4 个场景（符号表缺失/hsdis 未安装/ELF 格式错误/PageCache 一致性）
8. **必须使用 man 手册验证系统调用和文件格式**: `dlopen(3)`, `dlsym(3)`, `hcreate_r(3)`, `elf(5)`
9. **必须包含诊断工具五件套**: `jhsdb` + `nm` + `objdump` + `readelf` + `GDB`
10. **必须解释 readBytesFromProcess0 与 PageCache 的交互**: 两层缓存架构、性能量化、一致性保证

---

## §十 GDB Verification（≥7 断言）

以下是可以通过 GDB 验证的断言（在 Live Mode 中验证）：

### 断言 1: init0 正确缓存了 jfieldID 和 jmethodID

```gdb
# 附加到运行中的 JVM
gdb -p <pid>

# 在 init0 中打断点
break Java_sun_jvm_hotspot_debugger_linux_LinuxDebuggerLocal_init0

# 验证 p_ps_prochandle_ID 被正确缓存
print p_ps_prochandle_ID
# 期望: $1 = (jfieldID) 0x... (非 NULL)

# 验证 createClosestSymbol_ID 被正确缓存
print createClosestSymbol_ID
# 期望: $2 = (jmethodID) 0x... (非 NULL)
```

### 断言 2: lookupByName0 正确调用 lookup_symbol

```gdb
# 在 lookupByName0 中打断点
break Java_sun_jvm_hotspot_debugger_linux_LinuxDebuggerLocal_lookupByName0

# 验证参数传递正确
# jstring objectName → C string
# jstring symbolName → C string
# 调用 lookup_symbol(ph, objectName_cstr, symbolName_cstr)

# 可以单步执行到 lookup_symbol 函数
step
# 期望: 进入 lookup_symbol 函数
```

### 断言 3: symtab.c 的 search_symbol 使用 hsearch_r FIND

```gdb
# 在 search_symbol 中打断点
break search_symbol

# 验证 hsearch_r 的调用
# item.key = sym_name
# hsearch_r(item, FIND, &ret, symtab->hash_table)

# 如果找到符号，ret->data 应该指向 elf_symbol 结构体
print ret->data
# 期望: $1 = (void *) 0x... (非 NULL)
```

### 断言 4: readBytesFromProcess0 直接调用 ps_pdread（绕过 PageCache）

```gdb
# 在 readBytesFromProcess0 中打断点
break Java_sun_jvm_hotspot_debugger_linux_LinuxDebuggerLocal_readBytesFromProcess0

# 单步执行，观察是否调用 ps_pdread
step
# 期望: 调用 ps_pdread (通过 ops->p_pread 函数指针)

# 对比：在 DebuggerBase.readPage 中打断点
break DebuggerBase.readPage
# 如果 Java 层通过 PageCache 读取，会命中缓存，不调用 readBytesFromProcess0
```

### 断言 5: sadis.c 的 load_library 正确加载 hsdis

```gdb
# 在 load_library 中打断点
break Java_sun_jvm_hotspot_asm_Disassembler_load_1library

# 验证 dlopen 调用
# hsdis_handle = dlopen(libname, RTLD_LAZY | RTLD_GLOBAL)

# 验证 dlsym 调用
# func = (uintptr_t)dlsym(hsdis_handle, "decode_instructions_virtual")

print func
# 期望: $1 = (uintptr_t) 0x... (非 NULL，如果 hsdis 已安装)
```

### 断言 6: hsdis 的回调正确桥接到 Java 层

```gdb
# 在 event_to_env 中打断点（需要调试反汇编功能）
break event_to_env

# 验证回调参数
# event = "instruction ..." (反汇编结果)
# arg = (void*) instruction_address

# 单步执行，观察是否调用 Java 层的 Disassembler.handleEvent
step
# 期望: 调用 JNI CallLongMethod → Disassembler.handleEvent
```

### 断言 7: 符号查找遍历 lib_info 链表（验证顺序）

```gdb
# 在 lookup_symbol 中打断点
break lookup_symbol

# 验证 lib_info 链表的遍历顺序
# 第一个 lib 应该是可执行文件（如 /usr/lib/jvm/java-17/bin/java）
print lib->name
# 期望: "/usr/lib/jvm/java-17/bin/java"

# 继续遍历，验证 libjvm.so 的位置
# 通常需要遍历 4-9 个库后到达 libjvm.so
```

---

## §十一 与 README 和同组 prompt 的连续性

### 11.1 与 README 的关系

本文档是 Phase 20 的第 03 篇，对应 `probe_md/20-sa-postmortem/README.md` 中的：

- **§§ 03 - JNI 桥接 + 符号表解析** (`README.md` 中的文档拆分方案)
- 核心内容：`LinuxDebuggerLocal.c`（JNI 层） + `symtab.c`（符号表） + `sadis.c`（反汇编桥接）

**连续性保证**:
- 本文档覆盖 `LinuxDebuggerLocal.c`、`symtab.c`、`symtab.h`、`sadis.c` 四个文件
- prompt-00 已解释 `ps_prochandle` 核心数据结构，本文档在此基础上解释 JNI 桥接层
- prompt-01/prompt-02 已解释 Live/Postmortem Mode 的实现，本文档解释这两模式在 JNI 层的统一接口

### 11.2 与同组 prompt 的关系

| Prompt | 文件 | 与本文档的关系 |
|--------|------|---------------|
| prompt-00 | SA 架构 + 核心数据结构 | 基础：本文档的 JNI 桥接层依赖 prompt-00 的 `ps_prochandle` 解释 |
| prompt-01 | Live Debugging (ps_proc.c) | 本文档的 `readBytesFromProcess0` 调用 `ps_pdread`，分派到 `ps_proc.c` 的 `process_read_data` |
| prompt-02 | Postmortem Debugging (ps_core.c) | 本文档的符号查找同时适用于 Live 和 Postmortem Mode |
| prompt-03 (本文档) | JNI Bridge + Symbol (LinuxDebuggerLocal.c + symtab.c + sadis.c) | 独立：覆盖 JNI 层 + 符号表 + 反汇编桥接 |
| prompt-04 | SA Bootstrap (HotSpotAgent.java + TypeDataBase) | 本文档的 JNI 层是 SA Bootstrap 的一部分 |
| prompt-05 | Tools Pipeline (jstack/jmap/jinfo) | 本文档的符号查找是 jstack 获取符号名的基础 |

### 11.3 避免重复

- **不与 prompt-00 重复**: 本文档不重复解释 `ps_prochandle` 数据结构，只解释 JNI 层如何访问 `ps_prochandle`
- **不与 prompt-01/prompt-02 重复**: 本文档不展开 `process_read_data` 或 `core_read_data` 的实现细节，只解释 JNI 层如何调用它们
- **不与 prompt-04 重复**: 本文档不展开 SA Bootstrap 的流程（`HotSpotAgent.attach`），只解释 Bootstrap 完成后的 JNI 调用

---

## §十二 质量自检清单

写完文档后，逐项检查：

- [ ] §四 深度问题组 ≥6 组，每组含 counterfactual
- [ ] §八 Prohibited ≥8 条
- [ ] §九 Required ≥8 条
- [ ] §十 Verification ≥7 断言
- [ ] §四 答案方向 ≥8 行（随机抽取 3 个问题组验证）
- [ ] Beginner Callout ≥7 个，且只在 §一 内
- [ ] man 手册引用覆盖所有核心 syscall 和 ELF 格式（`man 3 dlopen`、`man 3 hcreate_r`、`man 5 elf`）
- [ ] 独立的边缘场景 section ≥4 场景
- [ ] §二 有 syscall/二进制/全局状态表
- [ ] 标题格式 `# NN-Name — Subtitle`
- [ ] 运行 `rg '^## §' file.md` 验证连续无跳号
- [ ] 总行数 ≥450 行（目标是 2500-3500 行）
- [ ] ELF 符号表格式背景已补充（`man 5 elf` 的 Symbol Table 章节）
- [ ] hsdis 的反汇编桥接机制已详细解释（回调桥接、函数指针类型定义）

---

## 附录: 关键源码位置速查

| 符号 | 文件:行号 | 说明 |
|------|----------|------|
| `init0` (JNI) | `LinuxDebuggerLocal.c:98-129` | jfieldID/jmethodID 缓存 |
| `attach0` (PID) | `LinuxDebuggerLocal.c:247-265` | 附加到运行中进程 |
| `attach0` (core) | `LinuxDebuggerLocal.c:272-302` | 附加到 core dump |
| `lookupByName0` | `LinuxDebuggerLocal.c:326-353` | 符号名 → 地址 |
| `lookupByAddress0` | `LinuxDebuggerLocal.c:360-375` | 地址 → 符号名 + 偏移 |
| `readBytesFromProcess0` | `LinuxDebuggerLocal.c:382-398` | 读取 debuggee 内存 |
| `getThreadIntegerRegisterSet0` | `LinuxDebuggerLocal.c:401-579` | 读取线程寄存器（多架构） |
| `detach0` | `LinuxDebuggerLocal.c:309-319` | 分离 debuggee |
| `build_symtab_internal` | `symtab.c:329-551` | 构建符号表（核心函数） |
| `search_symbol` | `symtab.c:569-592` | 符号查找（哈希表） |
| `nearest_symbol` | `symtab.c:594-607` | 最近符号查找（地址 → 符号） |
| `destroy_symtab` | `symtab.c:558-567` | 释放符号表 |
| `load_library` | `sadis.c:115-186` | 加载 hsdis 插件 |
| `decode` | `sadis.c:285-344` | 调用 hsdis 反汇编 |
| `event_to_env` | `sadis.c:210-228` | 事件回调桥接（C → Java） |
| `printf_to_env` | `sadis.c:231-278` | 输出回调桥接（C → Java） |
| `init0` (Java) | `LinuxDebuggerLocal.java:102` | Java 层静态初始化 |
| `lookupByName` (Java) | `LinuxDebuggerLocal.java:111` | Java 层符号查找入口 |

---

**END OF PROMPT**
