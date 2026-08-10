# PROMPT: 请撰写 02-ClassFileLoadHook.md

## §〇 Production Scenario（必须真实出现在文档 §〇 中）

**症状**：Agent 的 ClassFileTransformer 修改了字节码但类加载后行为与预期不符。使用 `-Xlog:instrument` 追踪发现 transformer 被调用但返回的字节码似乎未被使用。或者更严重的情况——agent 触发了无限递归导致 `StackOverflowError`。

**根因分析**：ClassFileLoadHook (CFLH) 事件链涉及 4 层调用栈：

```
JVM C++ (klassFactory.cpp:110)
  → JvmtiExport (jvmtiExport.cpp:1017)
    → JvmtiClassFileLoadHookPoster (jvmtiExport.cpp:836)
      → post_all_envs: non-retransformable (第一遍) → retransformable (第二遍)
        → post_to_env: 调用 agent 注册的 callback
          → libinstrument (InvocationAdapter.c:625)
            → eventHandlerClassFileLoadHook
              → tryToAcquireReentrancyToken (Reentrancy.c:105) ← 重入保护
              → transformClassFile (JPLISAgent.c:797)
                → JNI 调用 Java TransformerManager.transform() (TransformerManager.java:168)
                  → 遍历 Transformer 链
                    → ClassFileTransformer.transform() 返回修改后 byte[]
                → JVMTI Allocate 分配 native buffer
              → releaseReentrancyToken (Reentrancy.c:147)
    → copy_modified_data (jvmtiExport.cpp:988)
      → NEW_RESOURCE_ARRAY 复制到 resource area
      → Deallocate agent 内存
```

最常见的问题：
1. **重入死循环**：transformer 的 `transform()` 中调用了 `Class.forName()` 触发新类加载 → 又触发 CFLH → 又进入 transformer → 又 `Class.forName()` → 无限递归。JPLIS 的 `tryToAcquireReentrancyToken` (Reentrancy.c:105) 通过 TLS 标记检测到此情况，短路跳过——但如果是不同线程的相互触发则无法防护。
2. **修改被覆盖**：non-retransformable agent 先看到原始 bytes 并修改，但 retransformable agent 在第二遍中在其基础上继续修改，如果后者返回 null → 最终 bytes 是第一遍修改后的版本。但如果 retransformable agent 返回了不同的修改 → 覆盖前者。
3. **内存泄漏**：agent 的 callback 通过 `new_data` 返回修改后的 bytes（由 agent 调用 `malloc` 分配），如果 `post_to_env` 的链式释放逻辑出错 → 泄漏。

**三步诊断**（直接写进 §〇）：

```bash
# 1. 确认 CFLH 事件是否被触发
java -Xlog:instrument=trace -javaagent:agent.jar -version 2>&1 | grep "ClassFileLoadHook"
# 期望: [instrument] transform: class=com/example/Foo, loader=sun.misc.Launcher$AppClassLoader
# 无输出 → CFLH 事件未注册或 agent 未调用 addTransformer

# 2. 检查 transformer 是否被调用
jcmd <pid> VM.classloader_stats  # 查看类加载统计
# 如果只有 bootstrap classes → premain 的 addTransformer 未生效（可能在 VMInit 之后）

# 3. GDB 断点验证 CFLH 链路
gdb -ex "break klassFactory.cpp:110" \
    -ex "break jvmtiExport.cpp:934" \
    -ex "break InvocationAdapter.c:625" \
    -ex "break JPLISAgent.c:797" \
    -ex "break Reentrancy.c:105" \
    -ex "run" \
    -ex "print h_name->as_C_string()" \
    -ex "print _curr_len" \
    -ex "print _has_been_modified" \
    --args java -javaagent:agent.jar com.example.Main
```

**反事实**：如果 CFLH 没有 retransformable/non-retransformable 两遍遍历 → 所有 agent 只看到原始 bytes → retransformable agent 的修改会丢失 non-retransformable agent 的修改 → agent 之间无法组合使用（如一个 agent 添加日志字节码，另一个 agent 添加性能监控字节码）→ Java agent 生态的模块化（多个 agent 同时工作）完全失效。JVMTI 的两遍遍历设计确保了 agent 的组合性：第一遍 non-retransformable（"不可撤销"的修改），第二遍 retransformable（"可撤销"的修改，保留原始 bytes 以便 RetransformClasses 回退）。

---

## §一 Task + Narrative + De-glamorization + Beginner Callouts

### Task

Reading this prompt, you will produce a document that traces the COMPLETE ClassFileLoadHook event pipeline from JVM class loading through JVMTI event dispatch to Java Transformer chain execution. This is NOT a tutorial on "how to write a ClassFileTransformer" — it's ENGINEERING documentation on HOW the JVM implements bytecode transformation in source-code-specific detail.

Reader completed **01-Agent-Loading** (JPLISAgent creation, VMInit callback, setLivePhaseEventHandlers), **09-native-interface** (JNI_ENTRY/JVM_ENTRY macros), **03-object-model** (Klass hierarchy). This doc: **how a class file byte array flows through the ClassFileLoadHook pipeline and gets modified by registered transformers** — from `KlassFactory::check_class_file_load_hook` at klassFactory.cpp:110 to `ClassFileTransformer.transform()` return value being memcpy'd into the JVM's class parser.

### Interview Story Format Answer（必须出现在 §一 末尾）

"Every class loaded by the JVM passes through `KlassFactory::create_from_stream` at klassFactory.cpp:166. Before the `ClassFileParser` sees the bytes, `check_class_file_load_hook` at klassFactory.cpp:110 checks `JvmtiExport::should_post_class_file_load_hook()` — a single boolean flag gate that avoids the entire pipeline when no agent is interested. When active, `post_class_file_load_hook` at jvmtiExport.cpp:1017 creates a stack-allocated `JvmtiClassFileLoadHookPoster` that orchestrates a two-pass traversal of all JVMTI environments. The first pass (non-retransformable agents, jvmtiExport.cpp:911-921) skips retransform scenarios because those agents already modified the bytes during original load. The second pass (retransformable agents, jvmtiExport.cpp:923-931) runs in all scenarios with `caching_needed=true`, meaning if any agent modifies the data and the original hasn't been cached yet, the poster saves a copy via `os::malloc` into a `JvmtiCachedClassFileData` structure — this is the safety net that allows `RetransformClasses` to revert. Each agent callback at jvmtiExport.cpp:944-952 receives `_curr_data` and `_curr_len` — the current 'winning' bytes (possibly already modified by a previous agent in the chain). The agent returns `new_data` via `os::malloc`. If `new_data != NULL`, the poster caches the pre-modification bytes (if retransformable + first modification), deallocates the previous agent's data via `_curr_env->Deallocate()`, and promotes `new_data` to `_curr_data`. After all agents are called, `copy_modified_data` at jvmtiExport.cpp:988 copies the final bytes from agent heap to `NEW_RESOURCE_ARRAY` (thread-local resource area) and deallocates the last agent's buffer. The libinstrument layer adds two critical safety mechanisms: `tryToAcquireReentrancyToken` at Reentrancy.c:105 uses JVMTI thread-local storage with a sentinel value to detect recursive CFLH invocations on the same thread (common when transformers call `Class.forName()`), and `preserveThrowable`/`restoreThrowable` at JavaExceptions.c:336/348 ensures that exceptions thrown by transformers don't corrupt the JNI environment for the original class loading operation."

### Beginner Callout Boxes（文档中必须出现的 7 个 callout 框）

1. **should_post_class_file_load_hook 门控**: `jvmtiExport.hpp:333` 的内联函数 `should_post_class_file_load_hook()` 是零开销门控——返回一个 `static bool _should_post_class_file_load_hook`，由 `JvmtiEventController::recompute_enabled()` 在 agent 注册/注销事件时原子更新。`JVMTI_ONLY` 宏保证当 `INCLUDE_JVMTI` 编译标志为 false 时，编译器消除整个调用路径。在无 agent 的 JVM 上，`check_class_file_load_hook` 的开销仅为一个 bool 读取 + 分支预测（几乎总是 not taken）。

2. **JvmtiClassFileLoadHookPoster 的两遍遍历**: 第一遍 non-retransformable agents (jvmtiExport.cpp:911-921) 仅在 load/redefine 时调用（retransform 时跳过），caching_needed=false。第二遍 retransformable agents (jvmtiExport.cpp:923-931) 在所有场景调用，caching_needed=true。设计原因：non-retransformable agents 的修改是"一次性"的——一旦修改就无法通过 RetransformClasses 回退。retransformable agents 需要缓存原始 bytes 以便回退。Retransform 时 non-retransformable agents 不应再次参与——它们已经在原始 load 时修改过了。

3. **TLS 重入保护**: `tryToAcquireReentrancyToken` (Reentrancy.c:105) 使用 JVMTI `SetThreadLocalStorage`/`GetThreadLocalStorage` API 实现单线程重入检测。哨兵值：`JPLIS_CURRENTLY_INSIDE_TOKEN = 0x7EFFC0BB`，`JPLIS_CURRENTLY_OUTSIDE_TOKEN = 0`。如果当前线程已在 CFLH 回调内部（TLS == INSIDE_TOKEN），返回 JNI_FALSE 跳过 transform。设计原因：transformer 的 `transform()` 方法中调用 `Class.forName()` 会触发新类加载 → 再次触发 CFLH → 同一线程再次进入 `eventHandlerClassFileLoadHook` → 无限递归。TLS 检测短路此循环，让内层类加载正常进行（不经过 transformer）。

4. **链式内存管理**: 每个 agent 的 `new_data` 由 agent 通过 `os::malloc` 分配。`post_to_env` 在 agent 修改数据后：先缓存原始 bytes（如果 retransformable + 首次修改），再 `_curr_env->Deallocate(_curr_data)` 释放前一个 agent 的数据，然后 `_curr_data = new_data` 接力。最终 `copy_modified_data` 将胜出数据从 agent 堆复制到 `NEW_RESOURCE_ARRAY`（resource area）并释放最后一个 agent 的 buffer。这确保了 agent 分配的内存不会泄漏——每一步修改都有对应的 Deallocate。

5. **Resource Area vs Agent Heap**: 原始 class bytes 来自类路径文件映射或 CDS archive（进程生命周期）。Agent 返回的 `new_data` 分配在 C heap（`os::malloc`）。修改后的最终 bytes 通过 `NEW_RESOURCE_ARRAY` 分配在当前线程的 resource area 中——这是一个 arena-style 分配器，内存生命周期与最近的 `ResourceMark` 绑定。`copy_modified_data` 的存在是因为调用者（`KlassFactory`）期望 class bytes 在 resource area 中。

6. **Transformer 链的异常隔离**: `TransformerManager.transform()` (TransformerManager.java:168) 遍历 transformer 链时，每个 transformer 的 `transform()` 调用包裹在独立的 try-catch 中。如果一个 transformer 抛出异常，异常被吞掉（不影响后续 transformer），该 transformer 的修改被丢弃（继续使用之前的 buffer）。这保证了单个 transformer 的 bug 不会破坏整个 agent 链。

7. **preserveThrowable/restoreThrowable 异常透明性**: `eventHandlerClassFileLoadHook` (InvocationAdapter.c:625) 在调用 `transformClassFile` 之前保存 JNIEnv 的当前异常（`preserveThrowable`），调用后恢复（`restoreThrowable`）。原因：JVMTI 调用 CFLH 回调时，JNIEnv 可能已有异常（调用者不关心）。但 `transformClassFile` 内部要做大量 JNI 调用——有异常时 JNI 调用行为未定义。保存→清除→处理→恢复确保异常在回调前后完全透明。

---

## §二 Standard Environment

OpenJDK 11 slowdebug, 64-bit Linux。

Source roots:
- `src/hotspot/share/classfile/klassFactory.cpp` — check_class_file_load_hook (:110), check_shared_class_file_load_hook (:45), create_from_stream (:166)
- `src/hotspot/share/prims/jvmtiExport.cpp` — JvmtiClassFileLoadHookPoster (:836-998), post_class_file_load_hook (:1017)
- `src/hotspot/share/prims/jvmtiExport.hpp` — should_post_class_file_load_hook (:333)
- `src/hotspot/share/prims/jvmtiEventController.cpp` — set_should_post_class_file_load_hook (:609)
- `src/java.instrument/share/native/libinstrument/InvocationAdapter.c` — eventHandlerClassFileLoadHook (:625)
- `src/java.instrument/share/native/libinstrument/JPLISAgent.c` — transformClassFile (:797), setLivePhaseEventHandlers (:623), checkCapabilities (:659)
- `src/java.instrument/share/native/libinstrument/Reentrancy.c` — tryToAcquireReentrancyToken (:105), releaseReentrancyToken (:147)
- `src/java.instrument/share/native/libinstrument/JavaExceptions.c` — preserveThrowable (:335), checkForAndClearThrowable (:371)
- `src/java.instrument/share/classes/sun/instrument/TransformerManager.java` — transform (:168), addTransformer (:92)
- `src/java.instrument/share/classes/java/lang/instrument/ClassFileTransformer.java` — transform (:197, :236)

Build: `make jdk`

Key binaries:
- `build/linux-x86_64-normal-server-slowdebug/jdk/lib/server/libjvm.so` — klassFactory.cpp + jvmtiExport.cpp
- `build/linux-x86_64-normal-server-slowdebug/jdk/lib/libinstrument.so` — InvocationAdapter.c + JPLISAgent.c

System calls: `mmap` (man 2 mmap, class file mapping), `os::malloc` (agent heap allocation), JVMTI `Allocate`/`Deallocate` (man 3 Allocate)

---

## §三 Source Files Table

| # | File | Full Path | Lines | Core Functions | Role |
|---|------|-----------|:--:|-------|------|
| 1 | **klassFactory.cpp** | `src/hotspot/share/classfile/klassFactory.cpp` | 236 | `check_class_file_load_hook`(:110), `check_shared_class_file_load_hook`(:45), `create_from_stream`(:166) | 🔥 类加载 CFLH 入口——是否触发 + 修改后 stream 重建 |
| 2 | **jvmtiExport.cpp** | `src/hotspot/share/prims/jvmtiExport.cpp` | 2999 | `JvmtiClassFileLoadHookPoster`(:836), `post`(:902), `post_all_envs`(:910), `post_to_env`(:934), `copy_modified_data`(:988), `post_class_file_load_hook`(:1017) | 🔥 CFLH 事件调度器——两遍遍历 + 链式内存管理 |
| 3 | **jvmtiExport.hpp** | `src/hotspot/share/prims/jvmtiExport.hpp` | ~340 | `should_post_class_file_load_hook`(:333) | 零开销门控 |
| 4 | **InvocationAdapter.c** | `src/java.instrument/share/native/libinstrument/InvocationAdapter.c` | 986 | `eventHandlerClassFileLoadHook`(:625) | libinstrument CFLH 回调入口 |
| 5 | **JPLISAgent.c** | `src/java.instrument/share/native/libinstrument/JPLISAgent.c` | 1604 | `transformClassFile`(:797), `setLivePhaseEventHandlers`(:623), `checkCapabilities`(:659) | 🔥 核心 transform——JNI marshall → 调用 Java → unmarshall |
| 6 | **Reentrancy.c** | `src/java.instrument/share/native/libinstrument/Reentrancy.c` | 165 | `tryToAcquireReentrancyToken`(:105), `releaseReentrancyToken`(:147) | TLS 重入保护 |
| 7 | **JavaExceptions.c** | `src/java.instrument/share/native/libinstrument/JavaExceptions.c` | 419 | `preserveThrowable`(:335), `checkForAndClearThrowable`(:371) | 异常保存/恢复 |
| 8 | **TransformerManager.java** | `src/java.instrument/share/classes/sun/instrument/TransformerManager.java` | 254 | `transform`(:168), `addTransformer`(:92), `removeTransformer`(:105) | Java 层 Transformer 链管理 |
| 9 | **ClassFileTransformer.java** | `src/java.instrument/share/classes/java/lang/instrument/ClassFileTransformer.java` | 252 | `transform`(legacy, :197), `transform`(module-aware, :236) | Transformer 接口 |

---

## §四 Deep Dive Question Groups（≥6，EXACT questions + answer directions）

### 4.1 ★★★ check_class_file_load_hook — CFLH 入口门控

```
问题：
  ① check_class_file_load_hook (klassFactory.cpp:110-163) 的完整逻辑是什么？
      答案方向:
        1. should_post_class_file_load_hook() (:119) — 门控检查，无 agent 时直接返回原始 stream
        2. 提取 cached_class_file (:131-140):
           - 从 jt->jvmti_thread_state() 读取 class_being_redefined
           - 如果是 redefine/retransform 路径 → class_being_redefined->get_cached_class_file()
           - 使用 jt->jvmti_thread_state() 而非 JvmtiThreadState::state_for(jt)
             → 后者在不存在时会分配新的 JvmtiThreadState（避免 7126851 bug）
        3. 准备指针 (:142-143):
           - ptr = const_cast<unsigned char*>(stream->buffer())
           - end_ptr = ptr + stream->length()
           - 传递 unsigned char** 以便 post_class_file_load_hook 写回修改后的指针
        4. JvmtiExport::post_class_file_load_hook(name, ..., &ptr, &end_ptr, &cached_class_file) (:145)
        5. 检测修改 (:152-158):
           - ptr != stream->buffer() → agent 修改了数据
           - 创建 new ClassFileStream(ptr, end_ptr - ptr, source, need_verify)
      
      追问: 为什么 const_cast 是安全的？
      → ClassFileStream::buffer() 返回 const unsigned char* 表示"不应修改"。
        但 CFLH 的设计目的就是允许 agent 修改字节码。const_cast 是对这个设计意图
        的显式承认——"我知道这违反了 const 契约，但这是 CFLH 机制的核心需求"。

  ② Counterfactual: 如果 CFLH 返回的修改后 bytes 直接传给 ClassFileParser 而不创建新的 ClassFileStream？
      答案方向: ClassFileStream 不仅持有 buffer 指针，还持有 source()（类文件来源，如
      "app.jar") 和 need_verify() 标志。如果直接替换 buffer → source 信息丢失 → 错误
      消息无法报告类文件来源 → "ClassFormatError at unknown source"。新 ClassFileStream
      保留了原始 stream 的 source 和 need_verify，只替换了 buffer 和长度。
```

### 4.2 ★★★ JvmtiClassFileLoadHookPoster — 两遍遍历设计

```
问题：
  ① post_all_envs (jvmtiExport.cpp:910-932) 的两遍遍历逻辑是什么？
      答案方向:
        第一遍 (non-retransformable, :911-921):
          if (_load_kind != jvmti_class_load_kind_retransform) {
            // 仅在 load/redefine 时调用——retransform 时跳过
            for each JvmtiEnv:
              if (!env->is_retransformable() && env->is_enabled(CFLH))
                post_to_env(env, false)  // caching_needed=false
          }
        
        第二遍 (retransformable, :923-931):
          for each JvmtiEnv:
            if (env->is_retransformable() && env->is_enabled(CFLH))
              post_to_env(env, true)  // caching_needed=true
      
      追问: 为什么第一遍在 retransform 时跳过？
      → Non-retransformable agents 在原始类加载时已经看到了原始 bytes 并做了修改。
        Retransform 的语义是"用当前 bytes 重新调用 retransformable agents"——
        non-retransformable agents 不应该在 retransform 中再次修改（否则它们的修改
        会被重复应用）。跳过它们保证了 retransform 只影响 retransformable agents 的修改。

  ② Counterfactual: 如果只有一遍遍历——所有 agent 按注册顺序调用一次？
      答案方向: Non-retransformable agent 先注册 → 先看到原始 bytes → 修改。
        Retransformable agent 后注册 → 看到 non-retransformable agent 修改后的 bytes
        → 在其基础上继续修改 → 原始 bytes 丢失 → RetransformClasses 时无法回退到
        原始状态（因为 retransformable agent 的"基准"不再是原始 bytes）。
        两遍遍历确保了 retransformable agents 始终可以知道"原始 bytes 是什么"——
        因为它们总是在第一遍 non-retransformable 修改之后才开始，原始 bytes 被缓存。
```

### 4.3 ★★★ post_to_env — 单 agent 回调与链式内存管理

```
问题：
  ① post_to_env (jvmtiExport.cpp:934-986) 的链式内存管理逻辑是什么？
      答案方向:
        1. Early phase 过滤 (:935-937):
           env->phase() == JVMTI_PHASE_PRIMORDIAL && !env->early_class_hook_env() → return
           (只有设置了 early_class_hook_env 的 env 才能在 Primordial phase 收到事件)
        
        2. 线程状态转换 (:943):
           JvmtiJavaThreadEventTransition jet(_thread)
           → 将线程从 _thread_in_vm 切换到 _thread_in_native
        
        3. 调用 agent callback (:944-952):
           (*callback)(env, jni_env, class_being_redefined, loader, name, 
                        protection_domain, _curr_len, _curr_data, &new_len, &new_data)
        
        4. 如果 new_data != NULL (:953-984):
           a. caching_needed && *_cached_class_file_ptr == NULL (:956-970):
              用 os::malloc 分配 JvmtiCachedClassFileData
              memcpy _curr_data 到 p->data（缓存被修改前的 bytes）
           b. _curr_data != *_data_ptr (:972-977):
              _curr_env->Deallocate(_curr_data)  ← 释放前一个 agent 的数据
           c. _curr_data = new_data; _curr_len = new_len (:979-981)
              _curr_env = env (:984)  ← 记录当前数据的所有者
      
      追问: 为什么需要 _curr_env 字段？
      → 每个 agent 的 new_data 由 agent 自己分配（os::malloc）。释放时需要知道
        是哪个 agent（哪个 JvmtiEnv）分配了它——因为 Deallocate 是 JvmtiEnv 的方法。
        _curr_env 记录了"当前 _curr_data 是哪个 env 分配的"，以便下一个 agent
        修改时正确释放。

  ② Counterfactual: 如果使用统一的 free() 而非 env->Deallocate()？
      答案方向: Agent 可能使用自定义内存分配器（通过 JVMTI SetEnvironmentLocalStorage
      和自定义 Allocate/Deallocate）。如果 JVM 用 free() 释放 agent 用自定义分配器
      分配的内存 → double-free / heap corruption。env->Deallocate() 保证使用与 agent
      分配时相同的分配器——这是 JVMTI 规范的内存管理契约。
```

### 4.4 ★★★ transformClassFile — JNI marshall/unmarshall

```
问题：
  ① transformClassFile (JPLISAgent.c:797-927) 如何将 C 参数 marshall 为 Java 对象并调用 transform？
      答案方向:
        阶段 0 — 重入保护 (:818-820):
          shouldRun = tryToAcquireReentrancyToken(jvmti(agent), NULL)
          !shouldRun → return（已在 CFLH 内部，短路跳过）
        
        阶段 1 — Marshall (:823-846):
          NewStringUTF(name) → classNameStringObject
          NewByteArray(class_data_len) → classFileBufferObject
          SetByteArrayRegion → 将 C 的 class_data 拷贝到 Java byte[]
        
        阶段 2 — 获取 Module (:850-858):
          首次加载 → getModuleObject() 通过 JVMTI GetNamedModule 查找
          Redefine/retransform → 传 NULL，Java 端从 classBeingRedefined.getModule() 获取
        
        阶段 3 — JNI 上行调用 (:859-873):
          CallObjectMethod(mInstrumentationImpl, mTransform, 
                           module, loader, className, classBeingRedefined,
                           protectionDomain, classFileBuffer, is_retransformer)
          → 进入 Java 层 InstrumentationImpl.transform()
        
        阶段 4 — Unmarshall (:876-918):
          如果 transformedBufferObject != NULL:
            GetArrayLength → transformedBufferSize
            JVMTI Allocate(transformedBufferSize, &resultBuffer)  ← 必须用 JVMTI 分配
            GetByteArrayRegion → 从 Java byte[] 拷到 native buffer
            *new_class_data_len = transformedBufferSize
            *new_class_data = resultBuffer
        
        阶段 5 — 释放重入令牌 (:921-922):
          releaseReentrancyToken(jvmti(agent), NULL)
      
      追问: 为什么 resultBuffer 必须用 JVMTI Allocate 而非 malloc？
      → JVMTI 规范要求 agent 返回的 new_class_data 由 JVMTI Allocate 分配。
        调用者（post_to_env）会使用 env->Deallocate() 释放——两者必须配对。
        使用 malloc 会导致 Deallocate 时 heap corruption。

  ② Counterfactual: 如果 transformClassFile 不做重入保护？
      答案方向: 典型场景：transformer 的 transform() 中调用 Class.forName("com.example.Helper")
      → Helper 类触发类加载 → 再次进入 CFLH → 同一线程再次进入 transformClassFile
      → 再次调用 transformer → 再次 Class.forName → StackOverflowError。
      重入保护检测到 TLS 已设置 INSIDE_TOKEN → 返回 false → 内层类加载跳过 CFLH
      → Helper 类正常加载（不被 transform）→ transformer 的 Class.forName 成功返回
      → 外层 CFLH 继续处理原始类。
```

### 4.5 ★★★ TransformerManager — Java 层 Transformer 链

```
问题：
  ① TransformerManager.transform() (TransformerManager.java:168-217) 如何遍历 Transformer 链？
      答案方向:
        1. getSnapshotTransformerList() (:177) — 获取当前 transformer 数组快照（无锁读取）
        2. bufferToUse = classfileBuffer (:179) — 初始使用原始字节码
        3. for each TransformerInfo (:182-204):
           try {
             transformedBytes = transformer.transform(module, loader, className,
                                                       classBeingRedefined,
                                                       protectionDomain, bufferToUse)
           } catch (Throwable t) {
             // 吞掉异常！不让一个 transformer 影响其他 (:195-198)
           }
           if (transformedBytes != null) {
             someoneTouchedTheBytecode = true
             bufferToUse = transformedBytes  // 链式传递
           }
        4. 返回: someoneTouchedTheBytecode ? bufferToUse : null (:216)
      
      追问: 为什么使用"不可变数组快照"而非同步遍历？
      → 注释 (:65-75) 说明：transform 是热路径（每次类加载都调用），
        addTransformer/removeTransformer 是冷路径（通常在 premain 中调用一次）。
        用复制换无锁读取——写时复制整个数组（~200ns），读时直接引用当前数组（~5ns）。
        如果用 synchronized 或 ReadWriteLock → 每次 transform 都要获取锁 → ~50ns 额外开销。

  ② Counterfactual: 如果 transformer 异常不隔离——一个异常终止整个链？
      答案方向: Agent A 的 transformer 抛出 NullPointerException → 链中断
      → Agent B 的 transformer 永远看不到这个类 → Agent B 的功能部分失效
      → 用户报告 "agent B 不工作" 但根因在 agent A → 诊断噩梦。
      异常隔离是 agent 生态兼容性的基础——一个 buggy agent 不能破坏其他 agent。
```

### 4.6 ★★★ Reentrancy.c — TLS 重入保护机制

```
问题：
  ① tryToAcquireReentrancyToken (Reentrancy.c:105-144) 的实现原理是什么？
      答案方向:
        1. GetThreadLocalStorage(jvmtienv, thread, &storedValue) (:112-115)
        2. if (storedValue == JPLIS_CURRENTLY_INSIDE_TOKEN) → return JNI_FALSE (:120-121)
           // 已在 CFLH 内部 → 拒绝重入
        3. 否则: assert storedValue == OUTSIDE_TOKEN → confirmingTLSSet(INSIDE_TOKEN) → return JNI_TRUE
      
      confirmingTLSSet (:67-86) 的验证逻辑:
        SetThreadLocalStorage(jvmtienv, thread, newValue)
        GetThreadLocalStorage → assert 值等于 newValue
        （注释 :48-49 说明：JVMTI 有一个 bug——set to 0 可能失败，所以需要读回验证）
      
      追问: 为什么使用 JVMTI TLS 而非 pthread TLS？
      → JVMTI TLS 是 JVM 管理的每线程存储，agent 不需要知道底层线程实现。
        使用 pthread TLS (__thread / pthread_getspecific) 会绕过 JVMTI 抽象层
        → 如果 JVM 使用自定义线程实现（如 Project Loom 的虚拟线程），pthread TLS 不可靠。

  ② Counterfactual: 如果使用全局锁而非 TLS 做重入保护？
      答案方向: 全局锁 → 同一时间只有一个线程能执行 CFLH → 多线程类加载被串行化
      → 启动时间从 2s 变为 20s（100 个线程并行加载类，每个都要等锁）。
      TLS 是无锁设计——每个线程独立判断自己的重入状态，零竞争。
```

### 4.7 ★★★ copy_modified_data — Resource Area 复制

```
问题：
  ① copy_modified_data (jvmtiExport.cpp:988-997) 为什么需要复制数据？
      答案方向:
        1. if (_curr_data != *_data_ptr) (:991) — 只有确实被修改过才执行
        2. *_data_ptr = NEW_RESOURCE_ARRAY(u1, _curr_len) (:992)
           → 在 thread resource area 中分配
        3. memcpy(*_data_ptr, _curr_data, _curr_len) (:993)
           → 从 agent 分配的 heap 复制到 resource area
        4. *_end_ptr = *_data_ptr + _curr_len (:994)
           → 更新结束指针
        5. _curr_env->Deallocate(_curr_data) (:995)
           → 释放 agent 分配的内存
      
      追问: 为什么不能直接使用 agent 分配的内存作为最终结果？
      → Agent 用 os::malloc 分配的内存不在 JVM 的内存管理体系中。
        ClassFileParser 期望 class bytes 在 resource area 或 GC heap 中。
        如果直接使用 agent 内存 → parser 可能持有指针跨越多个 ResourceMark
        → resource area 被释放后 agent 内存仍在 → 不一致的内存生命周期。
        复制到 resource area 统一了内存管理——class bytes 的生命周期与
        最近的 ResourceMark 绑定。

  ② Counterfactual: 如果复制后不释放 agent 内存（_curr_env->Deallocate）？
      答案方向: 每次类加载泄漏 ~10KB（平均 class 大小）→ 加载 10000 个类
      → 泄漏 ~100MB → 长时间运行的服务器（如应用服务器加载数千个类）
      → 内存持续增长 → OOM。Deallocate 是 CFLH 管道中唯一释放 agent 内存的点。
```

### 4.8 ★★★ CDS 共享类的 CFLH 处理

```
问题：
  ① check_shared_class_file_load_hook (klassFactory.cpp:45-107) 与常规 CFLH 有何不同？
      答案方向:
        1. 编译守卫: #if INCLUDE_CDS && INCLUDE_JVMTI (:52)
           → CDS 或 JVMTI 任一未编译时，整个函数体为空，直接返回 NULL
        
        2. 重新打开 CDS stream (:60-62):
           if (cfs == NULL) → FileMapInfo::open_stream_for_jvmti(ik)
           → 从 CDS archive 重新读取原始 class bytes
           → CDS 共享类直接从 archive 映射，不一定有现成的 stream 对象
        
        3. 修改后重新解析类 (:78-91):
           如果 agent 修改了字节码（old_ptr != ptr）:
             创建 ClassFileParser → create_instance_klass(true, ...)
             → changed_by_loadhook=true 标记
             → 返回新的 InstanceKlass（而非修改 stream）
           （常规 CFLH 只返回新 stream，解析由 create_from_stream 继续完成）
        
        4. Bootstrap loader package 注册 (:96-99):
           如果 class_loader.is_null() → ClassLoader::add_package(name, path_index)
      
      追问: 为什么共享类需要重新解析而非只替换 stream？
      → CDS 共享类的 InstanceKlass 已经从 archive 映射到了内存（包含 vtable、
        itable、constant pool 等元数据）。如果只替换 class bytes → 已映射的
        Klass 元数据与新 bytes 不一致 → 类型系统损坏。必须从头重新解析创建新的
        InstanceKlass。

  ② Counterfactual: 如果 CDS 类不支持 CFLH——agent 修改被忽略？
      答案方向: 所有使用 AppCDS 的应用 → agent 对共享类（如 java.lang.String,
        java.util.HashMap）的修改全部失效 → APM 工具的字节码增强只能覆盖应用类
        不能覆盖 JDK 核心类 → 监控盲区。CDS 类 CFLH 支持是正确性要求而非性能优化。
```

---

## §五 Article Structure

```
§〇 生产场景 — ClassFileLoadHook 管道问题诊断
  ★ 真实症状: transformer 被调用但字节码未生效 / StackOverflowError 重入
  ★ Root cause: retransformable 覆盖 non-retransformable 修改 / 重入保护缺失
  ★ 三步诊断: Xlog:instrument → jcmd VM.classloader_stats → GDB 断点
  ★ 反事实: 无两遍遍历 → agent 组合性失效

§一 ★★★ ClassFileLoadHook 全链路源码走读
  ❓ 这不是 transformer 开发教程——这是 JVM 如何将 class bytes 流经 transform 管道
  1.1 klassFactory.cpp:110 check_class_file_load_hook → 门控 + cached_class_file 提取
  1.2 jvmtiExport.cpp:1017 post_class_file_load_hook → 创建 JvmtiClassFileLoadHookPoster
  1.3 jvmtiExport.cpp:854 JvmtiClassFileLoadHookPoster 构造 → load_kind + class_being_redefined 提取
  1.4 jvmtiExport.cpp:910 post_all_envs → non-retransformable (第一遍) → retransformable (第二遍)
  1.5 jvmtiExport.cpp:934 post_to_env → 单 agent 回调 + 链式内存管理 (cache → deallocate → promote)
  1.6 InvocationAdapter.c:625 eventHandlerClassFileLoadHook → 异常保存 + 重入保护 + transformClassFile
  1.7 JPLISAgent.c:797 transformClassFile → JNI marshall → CallObjectMethod → unmarshall
  1.8 TransformerManager.java:168 transform → 无锁快照遍历 + 异常隔离
  1.9 Reentrancy.c:105 tryToAcquireReentrancyToken → TLS sentinel 重入检测
  1.10 jvmtiExport.cpp:988 copy_modified_data → NEW_RESOURCE_ARRAY + Deallocate
  1.11 ★ Mermaid: CFLH 全链路序列图 — 6 lanes: Class Loading / JVM C++ / JVMTI / libinstrument C / JNI Bridge / Java Transformer
       Flow: create_from_stream → check_class_file_load_hook → post_class_file_load_hook
       → JvmtiClassFileLoadHookPoster → post_all_envs (pass 1 + pass 2) → post_to_env × N
       → eventHandlerClassFileLoadHook → tryToAcquireReentrancyToken → transformClassFile
       → JNI CallObjectMethod → TransformerManager.transform → for each transformer
       → copy_modified_data → NEW_RESOURCE_ARRAY → return modified stream
  1.12 ★ 面试 Story Format 答案 — 从 should_post_class_file_load_hook 到 copy_modified_data 的完整叙事

§二 ★★★ 7 Beginner Callout 框
  2.1 should_post_class_file_load_hook 门控
  2.2 JvmtiClassFileLoadHookPoster 两遍遍历
  2.3 TLS 重入保护
  2.4 链式内存管理
  2.5 Resource Area vs Agent Heap
  2.6 Transformer 链异常隔离
  2.7 preserveThrowable/restoreThrowable 异常透明性

§三 ★★ CFLH 性能剖析
  ❓ CFLH 对类加载性能的影响
  ❓ 多 transformer 的链式开销
  3.1 门控开销: should_post_class_file_load_hook → 1 bool 读取 + 分支预测 ~0.3ns
  3.2 单 transformer 开销: JNI marshall (~500ns) + Java transform (~5µs typical) + unmarshall (~200ns) ≈ 6µs
  3.3 N 个 transformer: 每个 ~6µs × N（线性扩展，无锁读取）
  3.4 重入保护: TLS Get/Set ~50ns × 2（获取+释放）

§四 ★ GDB 断点验证 — 8 断点完整 CFLH trace
  断言 1: klassFactory.cpp:119 should_post → verify flag value
  断言 2: jvmtiExport.cpp:1027 JvmtiClassFileLoadHookPoster 构造 → verify load_kind
  断言 3: jvmtiExport.cpp:911 post_all_envs 第一遍入口 → verify non-retransformable count
  断言 4: jvmtiExport.cpp:923 post_all_envs 第二遍入口 → verify retransformable count
  断言 5: jvmtiExport.cpp:944 post_to_env callback → verify _curr_data / _curr_len
  断言 6: InvocationAdapter.c:625 eventHandlerClassFileLoadHook → verify exception state
  断言 7: JPLISAgent.c:818 tryToAcquireReentrancyToken → verify TLS sentinel
  断言 8: jvmtiExport.cpp:991 copy_modified_data → verify _curr_data != *_data_ptr

§五 ★ Cross-Reference
  ❓ 01-Agent-Loading — JPLISAgent 创建 + setLivePhaseEventHandlers (本文的前置)
  ❓ 05-JVMTI-Core — JvmtiEnv 迭代器 + event controller (post_all_envs 的底层)
  ❓ 04-Redefine-Classes — retransform 路径 + VM_RedefineClasses (cached_class_file 的消费者)
  ❓ 03-object-model — Klass hierarchy + InstanceKlass (check_shared_class_file_load_hook 的返回类型)
```

---

## §六 Writing Requirements

1. **Every paragraph opens with WHY** — "Because retransformable agents must be able to revert to original bytes, post_all_envs uses two-pass traversal with caching_needed=true in the second pass..." — not WHAT.

2. **3-5 lines source code per claim** — paste relevant C code from klassFactory.cpp / jvmtiExport.cpp / JPLISAgent.c / Reentrancy.c / TransformerManager.java, do not describe it.

3. **Mermaid** — CFLH 全链路序列图。6 lanes: Class Loading / JVM C++ / JVMTI / libinstrument C / JNI Bridge / Java Transformer。完整流程: `create_from_stream` → `check_class_file_load_hook` → `post_class_file_load_hook` → `JvmtiClassFileLoadHookPoster` 构造 → `post_all_envs` (pass 1: non-retransformable + pass 2: retransformable) → `post_to_env` × N → `eventHandlerClassFileLoadHook` → `tryToAcquireReentrancyToken` → `transformClassFile` → JNI `CallObjectMethod` → `TransformerManager.transform` → for each transformer → `copy_modified_data` → `NEW_RESOURCE_ARRAY` → return modified `ClassFileStream`。Annotate every step with file:line.

4. **GDB session** — 8 breakpoints with exact file:line numbers:
   - `klassFactory.cpp:119` should_post check — verify gate boolean
   - `jvmtiExport.cpp:1027` Poster 构造 — verify _load_kind and _class_being_redefined
   - `jvmtiExport.cpp:911` pass 1 entry — verify non-retransformable agent count
   - `jvmtiExport.cpp:923` pass 2 entry — verify retransformable agent count
   - `jvmtiExport.cpp:944` callback invocation — verify _curr_data/_curr_len before agent call
   - `InvocationAdapter.c:625` eventHandlerCFLH — verify exception preservation
   - `JPLISAgent.c:818` reentrancy check — verify TLS sentinel value
   - `jvmtiExport.cpp:991` copy check — verify data was modified (_curr_data != *_data_ptr)
   Each with expected variable values to verify.

5. **7 Beginner callout boxes** — exact text from §一: should_post gate, two-pass traversal, TLS reentrancy, chain memory management, Resource Area vs Agent Heap, transformer exception isolation, preserveThrowable/restoreThrowable.

6. **Cross-reference at three points**:
   - At `setLivePhaseEventHandlers` → "→ 01-Agent-Loading for how the CFLH callback was registered"
   - At `post_all_envs` JvmtiEnvIterator → "→ 05-JVMTI-Core for JvmtiEnv lifecycle and event controller"
   - At `cached_class_file` → "→ 04-Redefine-Classes for how RetransformClasses consumes the cached bytes"

7. **Story-format interview answer** — at §一末尾: 从 `ClassFileParser` 要解析字节码到 transformer 链执行完毕的叙事。Three parts: "Gate check + Poster creation" + "Two-pass agent callback chain" + "Marshalling + Java transform + result propagation".

8. **"不要写成→应该写成" 对照表** (必须在 §六 中出现):
   | 不要写成 | 应该写成 |
   |---------|---------|
   | "CFLH event is posted to agents" | "JvmtiClassFileLoadHookPoster::post_all_envs at jvmtiExport.cpp:910 iterates JvmtiEnvIterator in two passes: non-retransformable (:911-921, skipping retransform scenarios) then retransformable (:923-931, with caching_needed=true)" |
   | "Agent modifies class bytes" | "post_to_env at jvmtiExport.cpp:944 calls (*callback)(env, jni_env, ..., _curr_len, _curr_data, &new_len, &new_data) — agent allocates new_data via os::malloc. If new_data != NULL, the poster caches pre-modification bytes (:956-970), deallocates previous agent's data via _curr_env->Deallocate() (:972-977), and promotes new_data to _curr_data (:979-981)" |
   | "Reentrancy protection prevents recursion" | "tryToAcquireReentrancyToken at Reentrancy.c:105 reads JVMTI thread-local storage via GetThreadLocalStorage (:112). If storedValue == JPLIS_CURRENTLY_INSIDE_TOKEN (0x7EFFC0BB), returns JNI_FALSE (:120-121) — short-circuiting the entire transform pipeline for this invocation" |
   | "Transformer chain processes bytecode" | "TransformerManager.transform at TransformerManager.java:168 calls getSnapshotTransformerList() (:177) for lock-free read of the transformer array, then iterates: try { transformedBytes = transformer.transform(...) } catch(Throwable) { /* swallowed */ } (:195-198), updating bufferToUse = transformedBytes if non-null (:199-202) — chain-passing semantics" |
   | "Modified bytes are copied to resource area" | "copy_modified_data at jvmtiExport.cpp:988 checks _curr_data != *_data_ptr (:991), then *_data_ptr = NEW_RESOURCE_ARRAY(u1, _curr_len) (:992), memcpy (*_data_ptr, _curr_data, _curr_len) (:993), and _curr_env->Deallocate(_curr_data) (:995) — moving data from agent heap to thread resource area and freeing agent memory" |

---

## §七 Output Format

- Markdown file, named `02-ClassFileLoadHook.md`
- Output path: `/data/workspace/openjdk-cut-new/probe_md/18-agent-instrument/docs/`
- 元信息头:

```
> **阶段**：[18-agent-instrument]
> **前置**：[01-Agent-Loading]（JPLISAgent 创建 + setLivePhaseEventHandlers）、[09-native-interface]（JNI 调用约定）、[03-object-model]（Klass 层次结构）
> **配套**：[04-Redefine-Classes]（retransform 路径 + cached_class_file 消费）、[05-JVMTI-Core]（JvmtiEnv 迭代器 + event controller）
> **后续依赖本文**：[04-Redefine-Classes]（依赖本文缓存的原始 class bytes）
> **阅读收益**：追踪 ClassFileLoadHook 事件从 KlassFactory 到 Java Transformer 链的完整 6 层管道——理解 should_post_class_file_load_hook 门控的零开销设计、JvmtiClassFileLoadHookPoster 两遍遍历（non-retransformable → retransformable）的 agent 组合性保证、post_to_env 的链式内存管理（cache → Deallocate → promote）、transformClassFile 的 JNI marshall/unmarshall 与 JVMTI Allocate 契约、Reentrancy TLS 重入保护机制、TransformerManager 的无锁快照遍历与异常隔离；掌握 CFLH 管道中的 4 种内存区域（原始映射/agent heap/resource area/JVMTI Allocate）及其生命周期
```

- 目标行数: 400+ lines

---

## §八 Prohibited（≥8）

- ❌ 只说 "ClassFileLoadHook modifies class bytes" 而不展示完整管道 — 必须从 klassFactory.cpp:110 到 copy_modified_data 完整源码
- ❌ 不解释两遍遍历的设计原因 — 必须展示 non-retransformable vs retransformable 的语义差异和组合性保证
- ❌ 不解释链式内存管理 — 必须展示 cache → Deallocate → promote 三步操作及其内存安全含义
- ❌ 忽略重入保护 — 必须展示 tryToAcquireReentrancyToken 的 TLS sentinel 机制和为什么需要读回验证
- ❌ 不展示 JNI marshall/unmarshall — 必须展示 NewStringUTF → NewByteArray → SetByteArrayRegion → CallObjectMethod → GetArrayLength → JVMTI Allocate → GetByteArrayRegion 完整序列
- ❌ 忽略 copy_modified_data — 必须展示为什么需要从 agent heap 复制到 resource area
- ❌ 不解释 TransformerManager 的快照设计 — 必须展示无锁读取 + 写时复制的设计权衡
- ❌ 不做 GDB 断点 trace — 至少 8 个断点覆盖门控 → 两遍遍历 → callback → marshall → transform → reentrancy → copy
- ❌ 忘记 CDS 共享类的 CFLH 特殊处理 — 必须展示 check_shared_class_file_load_hook 与常规路径的差异
- ❌ 不要写成 Java agent 开发教程或 ASM/ByteBuddy 使用指南

---

## §九 Required（≥8）

- ✅ **★ Mermaid 全链路序列图** — 6 lanes: Class Loading / JVM C++ / JVMTI / libinstrument C / JNI Bridge / Java Transformer — 完整 CFLH 管道
- ✅ **★ 两遍遍历源码展示** — jvmtiExport.cpp:910-932 post_all_envs 完整逻辑 + 设计原理
- ✅ **★ post_to_env 链式内存管理** — jvmtiExport.cpp:934-986 完整 cache/Deallocate/promote 三步
- ✅ **★ transformClassFile 完整源码** — JPLISAgent.c:797-927 从重入保护到 JVMTI Allocate
- ✅ **★ tryToAcquireReentrancyToken 源码** — Reentrancy.c:105-144 完整 TLS 检测逻辑
- ✅ **★ TransformerManager.transform 源码** — TransformerManager.java:168-217 无锁遍历 + 异常隔离
- ✅ **★ 7 Beginner Callout 框** — exact text from §一
- ✅ **★ 面试 Story Format 答案** — §一末尾，叙事：门控 → Poster 构造 → 两遍遍历 → callback → transform → copy
- ✅ **★ GDB 断点 ≥8 条** — 精确到 file:line，每断点有预期变量值
- ✅ **★ "不要写成→应该写成" 对照表** — §六 中 ≥5 行
- ✅ **★ 交叉引用** — 01-Agent-Loading, 05-JVMTI-Core, 04-Redefine-Classes, 03-object-model
- ✅ **★ CDS 共享类 CFLH** — check_shared_class_file_load_hook 的重新解析逻辑

---

## §十 GDB Verification（≥7 assertions）

```
断言 1: should_post_class_file_load_hook 门控 (klassFactory.cpp:119)
  (gdb) break klassFactory.cpp:119
  (gdb) print JvmtiExport::should_post_class_file_load_hook() → 期望: true (agent 注册了 CFLH)
  (gdb) continue (如果 false → 直接返回原始 stream，跳过所有后续断点)

断言 2: JvmtiClassFileLoadHookPoster 构造 (jvmtiExport.cpp:870)
  (gdb) break jvmtiExport.cpp:870 (_state = ...)
  (gdb) print _thread->jvmti_thread_state() → 期望: 非 NULL 或 NULL (取决于调用场景)
  (gdb) continue → 进入 :894 clear_class_being_redefined()
  (gdb) print _load_kind → 期望: 0 (load) / 1 (redefine) / 2 (retransform)

断言 3: post_all_envs 第一遍入口 (jvmtiExport.cpp:911)
  (gdb) break jvmtiExport.cpp:911
  (gdb) print _load_kind → 期望: 非 retransform 时进入
  (gdb) continue → 遍历 non-retransformable JvmtiEnv
  (gdb) print env->is_retransformable() → 期望: false
  (gdb) print env->is_enabled(JVMTI_EVENT_CLASS_FILE_LOAD_HOOK) → 期望: true

断言 4: post_all_envs 第二遍入口 (jvmtiExport.cpp:923)
  (gdb) break jvmtiExport.cpp:923
  (gdb) print env->is_retransformable() → 期望: true
  (gdb) print caching_needed → 期望: true
  (gdb) continue → 进入 post_to_env

断言 5: post_to_env callback 调用 (jvmtiExport.cpp:944)
  (gdb) break jvmtiExport.cpp:944
  (gdb) print _curr_len → 期望: 原始 class bytes 长度
  (gdb) print _curr_data[0..3] → 期望: 0xCAFEBABE (Java class magic)
  (gdb) continue → agent callback 执行
  (gdb) break jvmtiExport.cpp:953 (new_data check)
  (gdb) print new_data → 期望: NULL (未修改) 或 非 NULL (已修改)

断言 6: eventHandlerClassFileLoadHook (InvocationAdapter.c:638)
  (gdb) break InvocationAdapter.c:638 (getJPLISEnvironment)
  (gdb) print environment → 期望: 非 NULL
  (gdb) break InvocationAdapter.c:642 (preserveThrowable)
  (gdb) print outstandingException → 期望: NULL (正常情况) 或 非 NULL (有预存异常)
  (gdb) continue → transformClassFile 执行

断言 7: tryToAcquireReentrancyToken (Reentrancy.c:112)
  (gdb) break Reentrancy.c:112
  (gdb) print storedValue → 期望: 0 (JPLIS_CURRENTLY_OUTSIDE_TOKEN)
  (gdb) continue → 应获取令牌
  (gdb) break Reentrancy.c:130 (确认设置成功)
  (gdb) print → confirmingTLSSet 已设置 INSIDE_TOKEN

断言 8: copy_modified_data (jvmtiExport.cpp:991)
  (gdb) break jvmtiExport.cpp:991
  (gdb) print _curr_data → 期望: agent 分配的地址
  (gdb) print *_data_ptr → 期望: 原始 stream buffer 地址
  (gdb) print _curr_data != *_data_ptr → 期望: true (agent 修改了数据)
  (gdb) continue 经过 memcpy
  (gdb) print *_data_ptr[0..3] → 期望: 0xCAFEBABE (修改后的数据仍以 magic 开头)
  (gdb) print _curr_env → 期望: 最后修改的 agent 的 JvmtiEnv
```

---

## §十一 与 README 和同组 prompt 的连续性

1. **从 README §二.2 承接**：本文展开 README 中 "02 — ClassFileLoadHook 与字节码转换"——从类加载触发 CFLH 到 Transformer 链执行完毕的完整代码级解答。

2. **同组边界**: 本文覆盖 ClassFileLoadHook 事件管道（CFLH 事件触发 → JVMTI 调度 → libinstrument transform → Java Transformer 链）；01 覆盖 Agent 加载（前置——创建 JPLISAgent 并注册 CFLH 回调）；04 覆盖 Redefine/Retransform（后置——消费本文缓存的原始 bytes）；05 覆盖 JVMTI 核心基础设施（JvmtiEnv 迭代器 + event controller）。

3. **全部文档共享 §一 开头语**: "Reader completed 01-Agent-Loading (JPLISAgent creation, setLivePhaseEventHandlers), 09-native-interface (JNI calling conventions), 03-object-model (Klass hierarchy). This doc: how a class file byte array flows through the ClassFileLoadHook pipeline and gets modified by registered transformers."
