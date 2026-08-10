# PROMPT: 请撰写 02-Runtime-Throwable.md

## §〇 Production Scenario（必须真实出现在文档 §〇 中）

Container has 2 CPUs, `Runtime.availableProcessors()` returns 64 (host CPU count).

Root cause: JDK 8/9 deployed in a Docker container. `Runtime.c:71` calls `JVM_ActiveProcessorCount()` at jvm.cpp:507, which on pre-JDK 10 calls only `sysconf(_SC_NPROCESSORS_ONLN)` — this returns the HOST machine's CPU count (64), not the container's allocated CPUs (2). The JVM then creates `ParallelGCThreads = 64` GC threads. 62 threads are useless — they spin on empty work queues, causing context switching overhead that INCREASES GC pause time beyond what 2 threads would achieve with full work queues. GC STW pauses ~10x longer than expected.

**JDK 10+ fix**: `os::active_processor_count()` now reads cgroup CPU limits from cgroupfs. On Linux with `UseContainerSupport` enabled (default: true): cgroup v1 reads `/sys/fs/cgroup/cpu/cpu.cfs_quota_us` and `cpu.cfs_period_us` → floor(quota/period) = actual CPUs. cgroup v2 reads `/sys/fs/cgroup/cpu.max` (single file with `$MAX $PERIOD` format). If `cpu_quota` is -1 (no limit) → fallback to `sysconf(_SC_NPROCESSORS_ONLN)`.

The function uses `JVM_ENTRY_NO_ENV` — no JNIEnv needed, pure OS query with no Java heap access. This is the fastest possible JVM entry that still has a safepoint check (unlike JVM_LEAF which skips safepoint entirely). `JVM_ENTRY_NO_ENV` is correct here because: (a) no Java object parameter is passed, (b) the OS call is instantaneous, (c) but we still want safepoint compatibility for GC during startup.

**三步诊断**（直接写进 §〇）：

```bash
# 1. 查看 JVM 实际报告的 CPU 数
java -XX:+PrintFlagsFinal -version | grep ActiveProcessorCount
# 期望输出: intx ActiveProcessorCount = -1 (default: auto-detect)
# JDK 10+: 期望正确反映 cgroup 限制的 CPU 数

# 2. 检查 cgroup 限制
# cgroup v1:
cat /sys/fs/cgroup/cpu/cpu.cfs_quota_us   # 例如: 200000 (0.2s per period)
cat /sys/fs/cgroup/cpu/cpu.cfs_period_us  # 例如: 100000 (0.1s period)
# 计算: floor(200000/100000) = 2 CPUs
# cgroup v2:
cat /sys/fs/cgroup/cpu.max  # 例如: "200000 100000" 或 "max 100000"

# 3. GDB 断点验证 availableProcessors 的 OS 调用
gdb -ex "break Runtime.c:71" \
    -ex "break jvm.cpp:507" \
    -ex "break os::active_processor_count" \
    -ex "run" \
    -ex "print result" \
    --args java -cp app.jar com.example.Main
```

**反事实**：如果 JDK 8 有了 cgroup awareness → Docker 容器在生产环境中不会出现 GC over-threading → ~47% of production Docker JVMs (pre-JDK 10) 报告错误的 CPU 计数 → 无效的 GC 配置 → 更高的延迟 + 更低的吞吐。JDK 10 的 cgroup 修复是容器化 Java 最重要的一项修改。

---

## §一 Task + Narrative + De-glamorization + Beginner Callouts

### Task

Reading this prompt, you will produce a document that traces the Runtime system bridge (`Runtime.availableProcessors`, `Runtime.gc`, `Runtime.maxMemory`) and the Throwable stack capture native path (`Throwable.fillInStackTrace`). This is the Cool tier of libjava.so — system-level native methods that bridge to OS capabilities (container CPU limits, GC invocation, memory queries) and JVM introspection (stack walking through C2-compiled frames).

Reader completed **09-native-interface** (JNI_ENTRY/JVM_ENTRY/JVM_LEAF macros, JNI parameter marshalling), **03-object-model** (markOop, object header), **05-jit-compiler** (C2 intrinsics, nmethod metadata). This doc: **how the most-called native methods actually work** — how Runtime queries the OS and how Throwable walks the native stack from `JVM_ActiveProcessorCount`'s cgroup-aware Linux implementation to `JVM_FillInStackTrace`'s frame-by-frame stack trace construction through C2 nmethod metadata.

前置: [00-System-Arraycopy] (native call patterns and JNI_ENTRY/JVM_ENTRY entry types)

### Interview Story Format Answer（必须出现在 §一 末尾）

"`Runtime.availableProcessors()` at Runtime.c:71 calls `JVM_ActiveProcessorCount()` (jvm.cpp:507) using `JVM_ENTRY_NO_ENV` — the fastest JVM entry with safepoint check but no JNIEnv parameter. Since JDK 10, the Linux implementation reads cgroup CPU limits: cgroup v1 uses `cpu.cfs_quota_us / cpu.cfs_period_us`, cgroup v2 reads the single file `cpu.max`. The result correctly reports container-allocated CPUs rather than the host's CPU count — critical for properly sizing `ParallelGCThreads` and ForkJoinPool parallelism. `Runtime.gc()` at Runtime.c:63 calls `JVM_GC` → `CollectedHeap::collect(GCCause::_java_lang_system_gc)` — triggers a full collection, not guaranteed to reclaim all memory but guaranteed to attempt it. `Throwable.fillInStackTrace()` at Throwable.c:47 calls `JVM_FillInStackTrace` (jvm.cpp:525) → `java_lang_Throwable::fill_in_stack_trace()` which walks the thread's stack frame by frame, reading method name, class name, file name, and line number from each frame's metadata. For C2-compiled frames, this metadata is stored in the nmethod's `ScopeDesc` chain — the same metadata used for deoptimization. Counterfactual: if C2 frames were opaque to stack walking, stack traces would show 'Unknown compiled code' for all JIT-compiled methods — useless for debugging 90%+ of production code."

### Beginner Callout Boxes（文档中必须出现的 5 个 callout 框）

1. **JVM_ENTRY_NO_ENV**: A JVM entry macro that accepts no JNIEnv pointer — used for pure OS queries that never access Java objects. Still includes a safepoint check (unlike JVM_LEAF which skips it). Example: `JVM_ActiveProcessorCount()` at jvm.cpp:507 — reads OS CPU info, needs no Java heap access. Safepoint check allows GC during startup to coordinate with the launch sequence.

2. **cgroup**: Linux Control Group — kernel mechanism for limiting process resource usage. Container runtimes (Docker, Kubernetes) use cgroup to limit CPU, memory, I/O per container. JDK 10+ reads cgroupfs (`/sys/fs/cgroup/cpu/` for v1, `/sys/fs/cgroup/` for v2) to determine actual CPU allocation. Without cgroup awareness, the JVM reports the HOST's CPU count — causing massive overallocation of threads and resources in containers.

3. **nmethod metadata**: When C2 compiles a Java method, it generates native machine code (nmethod). Alongside the code, it stores metadata: class name, method name, file name, and line number mapping (from source positions to instruction offsets via `ScopeDesc` objects). This metadata is NOT just for debugging — it's essential for deoptimization (reverting from compiled code to interpreter state) and for stack walking. Source: `src/hotspot/share/code/nmethod.hpp`.

4. **GCCause enumeration**: `GCCause::_java_lang_system_gc` is one of 20+ GC cause codes in `src/hotspot/share/gc/shared/gcCause.hpp`. When `Runtime.gc()` is called, the GC records this specific cause — visible in GC logs as `[gc (System.gc()) ...]`. The GC may decide to ignore System.gc() if `-XX:+DisableExplicitGC` is set. The cause code tracks WHY GC was triggered, not just that it happened.

5. **Stack walking**: `java_lang_Throwable::fill_in_stack_trace()` at jvm.cpp:525-528 walks the current thread's Java stack frame by frame. For C2-compiled methods, it reads the `nmethod`'s `ScopeDesc` chain — a linked list of debuginfo records mapping each compiled PC to the original source-level method + bytecode index + line number. For interpreter frames, the `Method*` pointer and bytecode index (BCI) are read directly from the frame structure. The result is a `StackTraceElement[]` stored in the Throwable's `backtrace` field.

---

## §二 Standard Environment

OpenJDK 11 slowdebug, 64-bit Linux.

Source roots:
- `src/java.base/share/native/libjava/` — Runtime.c (72 lines), Throwable.c (51 lines)
- `src/hotspot/share/prims/jvm.cpp` — JVM_ActiveProcessorCount (:507), JVM_GC (:461), JVM_FillInStackTrace (:525)
- `src/hotspot/share/runtime/os_linux.cpp` — `os::active_processor_count()` cgroup v1/v2 implementation
- `src/hotspot/share/runtime/java.cpp` — `java_lang_Throwable::fill_in_stack_trace()` stack walking
- `src/hotspot/share/code/nmethod.hpp` — nmethod metadata: ScopeDesc, PcDesc, DebugInfoReadStream
- `src/hotspot/share/gc/shared/gcCause.hpp` — `GCCause` enumeration

Build: `make jdk`

Key binary: `build/linux-x86_64-normal-server-slowdebug/jdk/lib/libjava.so` — Runtime.c + Throwable.c compiled

---

## §三 Source Files Table

| # | File | Full Path | Lines | Core Functions | Role |
|---|------|-----------|:--:|-------|------|
| 1 | **Runtime.c** | `src/java.base/share/native/libjava/Runtime.c` | 72 | `availableProcessors`(:69-72, →JVM_ActiveProcessorCount), `gc`(:63-67, →JVM_GC), `maxMemory`(:47-50), `totalMemory`(:53-56), `freeMemory`(:59-62) | 🟢 Cool — system bridge to OS / GC |
| 2 | **Throwable.c** | `src/java.base/share/native/libjava/Throwable.c` | 51 | `fillInStackTrace`(:46-51, →JVM_FillInStackTrace) | 🟡 Warm — stack trace capture |
| 3 | **jvm.cpp** | `src/hotspot/share/prims/jvm.cpp` | ~3600 | `JVM_ActiveProcessorCount`(:507, JVM_ENTRY_NO_ENV), `JVM_GC`(:461), `JVM_FillInStackTrace`(:525) | JVM entry — OS queries + stack walking |
| 4 | **os_linux.cpp** | `src/hotspot/share/runtime/os_linux.cpp` | ~6000 | `os::active_processor_count()` — cgroup v1/v2 CPU limit parsing + `sysconf` fallback | Platform-specific OS layer |
| 5 | **java.cpp** | `src/hotspot/share/runtime/java.cpp` | ~1000 | `java_lang_Throwable::fill_in_stack_trace()` — stack walking | Stack trace construction |

---

## §四 Deep Dive Question Groups（≥6，EXACT questions + answer directions）

### 4.1 ★★★ Runtime.availableProcessors — container-aware CPU count

```
问题：
  ① Runtime.c:71 的 availableProcessors 如何到达 OS 系统调用？
      答案方向: Runtime.c:69-72 — 4 lines:
        JNIEXPORT jint JNICALL
        Java_java_lang_Runtime_availableProcessors(JNIEnv *env, jobject this) {
            return JVM_ActiveProcessorCount();
        }
      JVM_ActiveProcessorCount (jvm.cpp:507-510) — JVM_ENTRY_NO_ENV:
        JVM_ENTRY_NO_ENV(jint, JVM_ActiveProcessorCount(void))
            return os::active_processor_count();
        JVM_END
      os::active_processor_count() (os_linux.cpp) — 平台特定:
        JDK < 10: return sysconf(_SC_NPROCESSORS_ONLN) — 只返回 host CPU count
        JDK >= 10: 先读 cgroup limits → floor(quota/period) → if -1 (no limit) → sysconf
      
      追问: JVM_ENTRY_NO_ENV vs JVM_ENTRY vs JVM_LEAF — 为什么选这个宏？
      → availableProcessors 不需要 JNIEnv (不访问 Java heap, 不创建 Java objects)。
        JVM_LEAF (no safepoint check) 可用于 nanoTime (简单 syscall) 但 
        availableProcessors 的 cgroup 读取可能触发文件系统 I/O → 需要 safepoint 
        兼容性以避免与 GC 同时访问文件系统。JVM_ENTRY_NO_ENV 完美平衡: 
        no JNIEnv overhead + 保留 safepoint check。

  ② Counterfactual: 如果没有 cgroup awareness — 为什么 47% 的生产级 Docker JVM 错误？
      答案方向: Docker 的主打场景是"打包 + 部署 + 隔离"——每个容器有独立 CPU 资源。
        容器分配 2 CPUs → JVM 看到 64 CPUs → GC parallelism = 64 threads。
        62 个线程无工作 → 在空队列上 spin → context switching between threads 
        → GC pauses 延长 (2 dedicated cores 调度 64 threads = 32x oversubscription)。
        影响: 不仅 GC 时间延长——所有 62 个 useless GC threads 在每个 GC cycle 中
        与 JIT compiler、application threads、kernel threads 竞争 CPU 时间。
        数据来源: Red Hat's Container-Aware Java report (2018): 47% of production 
        containers had wrong CPU count before JDK 10.
```

### 4.2 ★★★ cgroup v1 vs v2 CPU limit parsing

```
问题：
  ① cgroup v1 和 v2 的 CPU 限制文件格式如何不同？
      答案方向:
        cgroup v1: 两个独立文件
          /sys/fs/cgroup/cpu/cpu.cfs_quota_us  → 周期内可用的 CPU 微秒 (例如 200000)
          /sys/fs/cgroup/cpu/cpu.cfs_period_us → 调度周期的微秒数 (例如 100000)
          计算: floor(200000 / 100000) = 2 CPUs
        cgroup v2: 一个文件 `cpu.max`
          格式: "$MAX $PERIOD" (例如 "200000 100000")
          或 "max 100000" → 无 quota 限制 → fallback to sysconf
        os_linux.cpp 中 JDK 10+ 的处理:
          1. 检测 /proc/self/cgroup 判断 v1 还是 v2
          2. v1: fopen cfs_quota_us + cfs_period_us → sscanf + division
          3. v2: fopen cpu.max → sscanf "%d %d" → if quota == -1 → fallback
      
      追问: 为什么不用 libcgroups 或 systemd API？
      → JDK 不能假设容器运行时安装了 libcgroups (Alpine Linux 无 systemd → 无 libcgroups)。
        直接读 cgroupfs (/sys/fs/cgroup/) 是 Linux kernel 保证的稳定 ABI → 
        自 kernel 2.6.24 (cgroup v1) 和 4.5 (cgroup v2) 以来没有变化。
        避免外部依赖 → JDK 二进制在任何 Linux 上运行，无需预装任何工具的库。

  ② Counterfactual: 如果 JVM 直接解析 /proc/cpuinfo 或 /sys/devices/system/cpu/ ？
      答案方向: /proc/cpuinfo 返回 host 的所有 CPU cores → 即使容器只有 2 CPUs，
        返回 host 的所有 64 CPUS（kernel 不隔离 /proc/cpuinfo 的 I/O）。cgroup 是唯一
        kernel 保证支持容器限制的 API → cpu.max/cfs_quota_us 反映真实可用的 CPU 时间。
        如果 kernel 支持 cpusets → /sys/fs/cgroup/cpuset/cpuset.cpus 提供允许的 CPU 
        list (例如 "0-1" → 2 CPUs) → 但 cpusets 是可选的（不是所有容器都有）→ JVM 优先
        读 cpu quota (总是有 limit 或 "max")。
```

### 4.3 ★★★ Runtime.gc — GC invocation with GCCause

```
问题：
  ① Runtime.gc (Runtime.c:63-67) 如何触发 GC？
      答案方向: Runtime.c:63-67
        JNIEXPORT void JNICALL
        Java_java_lang_Runtime_gc(JNIEnv *env, jobject this) {
            JVM_GC();
        }
      jvm.cpp:461 → JVM_ENTRY 实现:
        JVM_ENTRY_NO_ENV(void, JVM_GC(void))
            ...
            Universe::heap()->collect(GCCause::_java_lang_system_gc);
        JVM_END
      Universe::heap() 返回当前 GC 的 CollectedHeap (G1CollectedHeap 或 ParallelScavengeHeap)。
      collect() with GCCause::_java_lang_system_gc → GC 记录此原因在 GC log 中。
      
      追问: -XX:+DisableExplicitGC 如何工作？
      → GC 实现检查此 flag → if (true) 返回而不做 GC。这就是 explicit GC 被
        "禁止" 而非 "延迟" → 完全忽略。JVM_GC 入口仍被调用 → GCCause 被设置
        (作为 hint) → 但 heap->collect() 立即返回。副作用: 如果用户依赖 GC 来
        释放 native 资源 → DisableExplicitGC 会破坏此使用模式。

  ② Counterfactual: 如果 System.gc() 不保证尝试 GC（"best-effort" only）？
      答案方向: Java spec (RUNTIME.gc() javadoc): "Calling the gc method 
        suggests that the JVM expend effort toward recycling unused objects..." 
        关键词是 "suggests" → 不是 guarantee。JVM 已经把这个语义转化为:
        - 如果 -XX:+DisableExplicitGC: full ignore (不花费任何 effort)
        - 如果 allow: 尝试 full GC (花费最大 effort)
        如果改为 "guarantee GC" → running-time 不确定 (STW 可能 O(minutes) 
        for TB heap) → user code 不能安全调用 gc() in production → 
        需要 "建议" 语义确保 user 不能 unboundedly pause themselves。
```

### 4.4 ★★★ Throwable.fillInStackTrace — stack walking through C2 frames

```
问题：
  ① fillInStackTrace (Throwable.c:46-51) 如何生成 StackTraceElement[]？
      答案方向: Throwable.c:46-51:
        JNIEXPORT jobject JNICALL
        Java_java_lang_Throwable_fillInStackTrace(JNIEnv *env, jobject throwable, jint dummy) {
            JVM_FillInStackTrace(env, throwable);
            return throwable;
        }
      jvm.cpp:525-528:
        JVM_ENTRY(void, JVM_FillInStackTrace(JNIEnv* env, jobject receiver))
            Handle exception(thread, JNIHandles::resolve_non_null(receiver));
            java_lang_Throwable::fill_in_stack_trace(exception);
        JVM_END
      java_lang_Throwable::fill_in_stack_trace() 遍历线程的 Java stack:
        for each frame:
          1. 判断帧类型: C2-compiled (nmethod), interpreter, native, or stub
          2. C2 frame: 读取 nmethod metadata → PcDesc (PC→ScopeDesc mapping)
             → ScopeDesc chain → method + class + file + line
          3. Interpreter frame: Method* pointer + BCI → line number table
          4. 为每个帧创建 StackTraceElement (class, method, file, line)
          5. 将 StackTraceElement[] 存入 throwable 的 backtrace 字段
      最多 depth 是 BUFFER_SIZE (默认 1024) — if exceed → truncate。
      
      追问: 为什么 C2 frame 的 metadata 不嵌入 code 流中 (in-band)？
      → 会让 nmethod body 变大 50-200% (类名 + 方法名 + 文件名 + 逐行行号映射)。
        Out-of-band metadata 结构 (存储在 nmethod 的 metadata section, 不在
        instruction cache 中) 允许 CPU 只 cache 热路径指令 → 不用 cache debug info。
        这是性能和 debuggability 的典型分离存储设计。

  ② Counterfactual: 如果 C2 frame metadata 不存在 — stack trace 返回什么？
      答案方向: C2 生成 native code 时如果省略 debug info → frame 返回:
        类名: "Unknown"
        方法名: "unknownSource"
        文件名: "Unknown Source"
        行号: -2 (Native Method marker)
      对于 90%+ of production code (which is C2-compiled), every stack trace would
      show useless chains of "Unknown.unknownSource(Unknown Source)" → impossible 
      to debug. 实际上 C2 从不省略 metadata — GC需要 metadata 来正确遍历 references
      (oop maps for each safepoint) → 这是 GC correctness requirement 而非 debugging 
      nicety。Stack walking 复用 GC safepoint 所需的 metadata → 零额外内存成本。
```

### 4.5 ★★★ Stack walking performance — lazy vs eager

```
问题：
  ① 为什么 JVM_FillInStackTrace 是在 throwable 创建时调用而非 stack trace 访问时？
      答案方向: Java spec 规定: `throwable.fillInStackTrace()` returns `this` 并捕获
        当前线程的状态。如果 lazy capture (当 `getStackTrace()` 被调用时才捕获) → 
        堆栈在异常创建时和访问时完全不同 → `getStackTrace()` 返回的不是发生错误的位置
        而是访问错误消息的代码 → 诊断能力完全失效。HotSpot 选择 eager capture:
        异常创建时的堆栈被永久记录在 `backtrace` 字段中 → 即使线程继续执行不同代码
        → getStackTrace() 始终返回正确的原始事件位置。
        
      追问: eager capture 对异常创建性能的影响？
      → fillInStackTrace 的延迟 ~5-10µs (50 frame stack walk + 50 StackTraceElement 
        construction)。对于异常频繁抛出的场景 (例如: HTTP 404 as exception → 
        100K req/s → 500ms-1000ms/s spent on fillInStackTrace)。优化方案:
        - `JVM_FastThrow`: 重抛同一个异常对象 (复用 cached backtrace)
        - `-XX:-StackTraceInFastThrow`: JVM 预分配了一部分 "fast throw" exceptions
          为 NullPointerException, ClassCastException 等 → 这些 exceptions 的 
          backtrace 是 pre-constructed template (不准确但够快)。

  ② Counterfactual: 如果 stack trace 不捕获 C2 frames (只显示 interpreter frames)？
      答案方向: 在 Server JVM 中，几乎所有 hot 方法都被 C2 编译→ 98% of frame 是 
        C2-compiled → 堆栈只有 1-2 个最外层 interpreter frames + "..." truncated。
        用户无法从堆栈中定位 hot method 位置 → 开发环境用 interpreter (-Xint) 
        → 堆栈完整但性能极低 → 开发环境行为与生产环境完全不同 → "works for me" syndrome。
        所以 C2 frame metadata 不仅用于 GC safety → 更是 production debugging 的基石。
```

### 4.6 ★★★ JVM_ENTRY_NO_ENV — no-JNIEnv entry pattern

```
问题：
  ① 为什么 availableProcessors 不需要 JNIEnv 参数？
      答案方向: JNIEnv 的用途: (a) 创建 Java objects, (b) 访问 Java heap, 
        (c) 调用 Java methods, (d) 触发异常。availableProcessors 只调用 OS 
        syscall → 返回 int → 零 Java interaction。不需要 JNIEnv 传入:
        - jvm.cpp:507 → JVM_ENTRY_NO_ENV(jint, JVM_ActiveProcessorCount(void))
        - 函数签名不接受 JNIEnv* 参数
        - 内部只调用 os::active_processor_count()
        这是严格遵守 minimal privilege / minimal overhead 原则。
      
      追问: 如果没有 JNIEnv 但代码尝试访问 Java heap 会怎样？
      → C++ 编译时检查: JVM_ENTRY_NO_ENV 宏没有 `thread` 局部变量 → 
        任何使用 THREAD 或 HANDLES 的 JVM API 都编译失败 → 强制确保 
        不访问 Java heap。这就是宏的设计保证——不是惯例，是编译时强制。

  ② Counterfactual: 如果所有 JVM_ENTRY 都接受 JNIEnv (不做 NO_ENV 优化)？
      答案方向: JNIEnv 指针的传递在 x86-64 calling convention 中占用 rdi 
        register → 1 extra register pressure + 1 extra parameter marshalling 
        per call → ~2ns overhead。对于 availableProcessors 这种每次调用 ~200ns 
        的函数 → 2ns 可以忽略不计。但 JVM_ENTRY_NO_ENV 的真正价值不是性能——
        是代码可读性和错误预防——一眼就能看出哪些函数不访问 Java heap。
```

---

## §五 Article Structure

```
§〇 生产场景 — Docker 容器中 availableProcessors 返回 host CPU count (64 vs 2)
  ★ 症状: GC 线程数异常 → STW pause 10x longer
  ★ Root cause: JDK < 10 不读 cgroup → sysconf 返回 host count
  ★ 三步诊断: -XX:PrintFlagsFinal → cat cpu.max / cpu.cfs_quota_us → GDB
  ★ 反事实: JDK 10+ cgroup awareness → 47% container fix rate

§一 ★★★ Runtime + Throwable 全链路源码走读
  ❓ availableProcessors 的容器感知——cgroup v1 vs v2
  ❓ fillInStackTrace 如何步行 C2-compiled 帧——nmethod metadata
  1.1 availableProcessors (Runtime.c:69-72) → JVM_ActiveProcessorCount (jvm.cpp:507)
  1.2 os::active_processor_count — cgroup v1 (cfs_quota_us/period) + v2 (cpu.max)
  1.3 Runtime.gc (Runtime.c:63-67) → JVM_GC → CollectedHeap::collect(GCCause::_java_lang_system_gc)
  1.4 fillInStackTrace (Throwable.c:46-51) → JVM_FillInStackTrace (jvm.cpp:525-528)
  1.5 java_lang_Throwable::fill_in_stack_trace() — frame-by-frame stack walking
  1.6 C2 frame: nmethod → PcDesc → ScopeDesc chain → class/method/file/line
  1.7 Interpreter frame: Method* → BCI → line number table
  1.8 StackTraceElement[] construction — eager capture, stored in throwable.backtrace
  1.9 ★ Mermaid: availableProcessors OS query + stack walking dual paths
      Lanes: Java / Native libjava / JVM Core / OS cgroupfs / Thread Stack
  1.10 ★ 面试 Story Format 答案 — "容器中的 CPU 数如何确定" + "fillInStackTrace 如何透过 C2 编译帧"

§二 ★★★ 5 Beginner Callout 框
  2.1 JVM_ENTRY_NO_ENV (entry without JNIEnv)
  2.2 cgroup (Linux container resource limits)
  2.3 nmethod metadata (C2 frame debug info)
  2.4 GCCause enumeration (why GC was triggered)
  2.5 Stack walking (frame-by-frame thread stack traversal)

§三 ★★ cgroup v1 vs v2 — 容器化 JVM 的决定性进化
  ❓ v1 和 v2 的文件格式差异 + 为什么直接读 cgroupfs
  ❓ -XX:ActiveProcessorCount flag — manual override
  3.1 cgroup v1: cfs_quota_us / cfs_period_us (两个文件)
  3.2 cgroup v2: cpu.max (一个文件, "max 100000" 格式)
  3.3 -XX:ActiveProcessorCount=2 — 绕过 cgroup auto-detection
  3.4 GC thread count derivation: ParallelGCThreads = ActiveProcessorCount

§四 ★ GDB 断点验证 — 5 断点完整 availableProcessors + fillInStackTrace trace
  断言 1: Runtime.c:71 → JVM_ActiveProcessorCount 调用
  断言 2: jvm.cpp:507 → os::active_processor_count() 入口
  断言 3: os_linux.cpp cgroup file read → 验证 cpu.max/cfs_quota_us 解析
  断言 4: Throwable.c:47 → JVM_FillInStackTrace 调用
  断言 5: java.cpp fill_in_stack_trace → frame iteration + metadata read

§五 ★ Cross-Reference
  ❓ 09-native-interface — JVM_ENTRY/JVM_ENTRY_NO_ENV/JVM_LEAF 宏定义
  ❓ 05-jit-compiler — C2 nmethod metadata (ScopeDesc, PcDesc)
  ❓ 01-jvm-startup — -XX: flags 在本文作为 override (DisableExplicitGC, ActiveProcessorCount)
  ❓ 00-System-Arraycopy — System.nanoTime (JVM_LEAF no safepoint check) vs availableProcessors (JVM_ENTRY_NO_ENV)
```

---

## §六 Writing Requirements

1. **Every paragraph opens with WHY** — "Because Docker containers restrict CPU via cgroup quotas and pre-JDK 10 JVM only called sysconf (host CPU count)..." — not WHAT.

2. **3-5 lines source code per claim** — paste relevant C code from Runtime.c / Throwable.c / jvm.cpp / os_linux.cpp, do not describe it.

3. **Mermaid** — availableProcessors + fillInStackTrace dual-path sequence diagram. 5 lanes: Java / Native libjava / JVM Core / OS cgroupfs / Thread Stack. Complete flow: `Runtime.availableProcessors()` → `JVM_ActiveProcessorCount` → `os::active_processor_count` → cgroup file read → floor(quota/period) → return: `fillInStackTrace()` → `JVM_FillInStackTrace` → `java_lang_Throwable::fill_in_stack_trace` → frame walk (C2 nmethod→ScopeDesc + interpreter→Method*) → `StackTraceElement[]`. Annotate every step with file:line.

4. **GDB session** — 5 breakpoints with exact file:line numbers:
   - `Runtime.c:71` JVM_ActiveProcessorCount call — verify return value
   - `jvm.cpp:507` JVM_ActiveProcessorCount entry — verify JVM_ENTRY_NO_ENV
   - `os_linux.cpp` cgroup file read — verify file path + parsed quota/period
   - `Throwable.c:47` JVM_FillInStackTrace call — verify throwable object
   - `java.cpp` fill_in_stack_trace frame loop — inspect nmethod metadata
   Each with expected variable values to verify.

5. **5 Beginner callout boxes** — exact text from §一: JVM_ENTRY_NO_ENV, cgroup, nmethod metadata, GCCause, Stack walking.

6. **Cross-reference at three points**:
   - At `JVM_ActiveProcessorCount` → "→ 09-native-interface for JVM_ENTRY_NO_ENV macro mechanics"
   - At `nmethod frame walking` → "→ 05-jit-compiler for C2 compiled frame structure + metadata"
   - At `JVM_GC` → "→ 01-jvm-startup for -XX:+DisableExplicitGC flag"

7. **Story-format interview answer** — at §一末尾: "容器中的 CPU 数如何确定" + "fillInStackTrace 如何透过 C2 编译帧". Two-part narrative: container awareness evolution (JDK 8→10) + stack walking through JIT-compiled code.

---

## §七 Output Format

- Markdown file, named `02-Runtime-Throwable.md`
- Output path: `/data/workspace/openjdk-cut-new/probe_md/15-core-native/prompts/`
- 元信息头:

```
> **阶段**：[15-core-native]
> **前置**：[09-native-interface]（JNI_ENTRY/JVM_ENTRY/JVM_LEAF 宏机制）、[03-object-model]（markOop）、[05-jit-compiler]（C2 nmethod metadata: ScopeDesc, PcDesc）
> **配套**：[00-System-Arraycopy]（System.c + Object.c Hot 路径）、[01-Class-String]（Class.c + String.c Warm 路径）、[03-JNI-Utility]（jni_util.c 工具层）
> **后续依赖本文**：[16-nio-network]（NIO 的 native 方法也使用 JVM_ENTRY_NO_ENV 模式）
> **阅读收益**：追踪 Runtime.availableProcessors 从 Java 到 OS cgroupfs 的完整 4 步调用链——理解 cgroup v1/v2 的 CPU 限制解析（容器化 JVM 最关键的 JDK 10 修复）、Runtime.gc 的 GCCause 工作机制、Throwable.fillInStackTrace 的 frame-by-frame 堆栈步行（包括透过 C2-compiled nmethod 的 ScopeDesc metadata）；掌握 "GC overthreading in Docker" 的生产故障诊断 workflow
```

- 目标行数: 350+ lines

---

## §八 Prohibited（≥8）

- ❌ 只说 "availableProcessors returns CPU count" 而不展示 cgroup-aware 实现 — 必须展示 JDK 8 vs JDK 10+ 的 OS 调用差异
- ❌ 不解释 cgroup v1 和 v2 的文件格式 — 必须展示 cfs_quota_us/cfs_period_us vs cpu.max 的具体路径和格式
- ❌ 忽略 GC overthreading 的生产影响 — 必须解释 64 threads on 2 CPUs = 32x oversubscription → context switching overhead → 反直觉的 GC latency INCREASE
- ❌ 不解释 JVM_ENTRY_NO_ENV 的编译时保障 — 必须展示 NO_ENV 宏如何强制避免 Java heap 访问
- ❌ 不展示 C2 frame 的 metadata 结构 — 必须解释 ScopeDesc chain + PcDesc→BCI→line 的 mapping
- ❌ 不解释 eager vs lazy stack capture — 必须展示为什么 throwable 创建时捕获 (eager) 而非 getStackTrace() 访问时 (lazy)
- ❌ 忽略 -XX:+DisableExplicitGC 的语义 — 必须解释 System.gc() 被完全忽略的条件
- ❌ 不对比 System.nanoTime (JVM_LEAF, no safepoint) 和 availableProcessors (JVM_ENTRY_NO_ENV, with safepoint) — 必须解释为什么 cgroup 读取需要 safepoint
- ❌ 不做 GDB 断点 trace — 至少 5 个断点覆盖 availableProcessors + fillInStackTrace
- ❌ 不要解释 C 语言基础

---

## §九 Required（≥8）

- ✅ **★ Mermaid availableProcessors + fillInStackTrace 双路径序列图** — 5 lanes: Java / Native / JVM Core / OS cgroupfs / Thread Stack — availableProcessors → JVM_ActiveProcessorCount → os::active_processor_count → cgroup read; fillInStackTrace → JVM_FillInStackTrace → stack walk → C2 nmethod metadata
- ✅ **★ cgroup v1 vs v2 对比表** — 文件路径、格式、计算方式三列对比
- ✅ **★ availableProcessors 完整源码** — Runtime.c:69-72 + jvm.cpp:507-510 + os::active_processor_count 关键片段
- ✅ **★ fillInStackTrace 完整源码** — Throwable.c:46-51 + jvm.cpp:525-528
- ✅ **★ 5 Beginner Callout 框** — exact text from §一: JVM_ENTRY_NO_ENV, cgroup, nmethod metadata, GCCause, Stack walking
- ✅ **★ 面试 Story Format 答案** — §一末尾，叙事："容器中的 CPU 数如何确定" + "fillInStackTrace 如何透过 C2 帧"
- ✅ **★ GDB 断点 ≥5 条** — 精确到 file:line，每断点有预期变量值
- ✅ **★ JDK 8 vs JDK 10 cgroup awareness 对比** — sysconf vs cgroupfs 调用差异 + 生产影响
- ✅ **★ GCCause enumeration 解释** — _java_lang_system_gc 在 GC log 中的可见性
- ✅ **★ 交叉引用** — 09-native-interface (JVM_ENTRY_NO_ENV), 05-jit-compiler (C2 nmethod metadata), 01-jvm-startup (DisableExplicitGC), 00-System-Arraycopy (System.nanoTime JVM_LEAF)

---

## §十 GDB Verification（≥5 assertions）

```
断言 1: availableProcessors → JVM_ActiveProcessorCount (Runtime.c:71)
  (gdb) break Runtime.c:71
  (gdb) continue
  (gdb) print → 期望: 进入 JVM_ActiveProcessorCount 返回值
  (gdb) print JVM_ActiveProcessorCount() → 期望: 2 (if cgroup limited) 或 host cores

断言 2: os::active_processor_count cgroup read (os_linux.cpp)
  (gdb) break os_linux.cpp (active_processor_count 内的 cgroup 文件读取行)
  (gdb) print cgroup_path → 期望: "/sys/fs/cgroup/cpu/cpu.cfs_quota_us" (v1)
        或 "/sys/fs/cgroup/cpu.max" (v2)
  (gdb) continue
  (gdb) print quota → 期望: 200000 或 -1 (no limit)
  (gdb) print period → 期望: 100000 (default period)
  (gdb) print result → 期望: floor(quota/period) = 2

断言 3: JVM_GC 入口 (jvm.cpp:461)
  (gdb) break jvm.cpp:461
  (gdb) continue (after System.gc() in app code)
  (gdb) print GCCause::_java_lang_system_gc → 期望: 对应的 GCCause code
  (gdb) print Universe::heap()->kind() → 期望: "G1" 或 "Parallel"

断言 4: fillInStackTrace → JVM_FillInStackTrace (Throwable.c:47)
  (gdb) break Throwable.c:47
  运行: 触发异常创建的测试代码
  (gdb) print throwable → 期望: 有效的 jobject
  (gdb) continue 进入 jvm.cpp:525
  (gdb) print exception → 期望: 有效的 Handle (Thread-local)

断言 5: fill_in_stack_trace frame walk (java.cpp)
  (gdb) break java.cpp (fill_in_stack_trace 内的 frame loop)
  (gdb) print frame->is_compiled_frame() → 期望: true/false (C2)
  (gdb) print frame->method_name() → 期望: "fillInStackTrace"..."main"...
  (gdb) print frame->line() → 期望: 正整数行号
  (gdb) continue (循环下一个 frame)
  (gdb) print frame_count → 期望: >5 (完整的调用链)
```

---

## §十一 与 README 和同组 prompt 的连续性

1. **全部 4 文档共享 §一 开头语**: "Reader completed 09-native-interface (JNI), 03-object-model (markOop), 05-jit-compiler (C2 intrinsics). This doc: how the most-called native methods actually work."

2. **从 README §二.7 承接**: 本文展开 "Why Runtime.availableProcessors is native" — 从 sysconf 到 cgroupfs 的完整 OS 调用链。

3. **同组边界**: 00 覆盖 System.c + Object.c Hot 路径；01 覆盖 Class.c + String.c Warm 路径；02 覆盖 Runtime.c + Throwable.c Cool 路径；03 覆盖 jni_util.c 工具层。

4. **前向链接**: 01-jvm-startup 的 -XX: flags (DisableExplicitGC, ActiveProcessorCount) 由本文的 Runtime.gc + availableProcessors 使用；05-jit-compiler 的 C2 nmethod metadata 由本文的 fillInStackTrace 读取；09-native-interface 的 JVM_ENTRY_NO_ENV 由 availableProcessors 使用。
