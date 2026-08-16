# SESSION-HANDOFF — 主交接文档(唯一入口,非常详细版)

> **状态**: 2026-08-15 | 卷 2 写作中: **121/152 篇完成**(第 1 批 12 + 第 2 批 26 + 第 3 批 14 + 第 4 批 21 + 第 5 批 32 + 第 6 批 16) | 第 1-5 批**全部完结**;第 6 批(JIT/GC)进行中,**本会话 38 篇: 20-02 + 27-jni(3) + 30-jvm-entry(3) + 32-jfr(6) + 34-nmt(2) + 36-attach(2) + 37-heap-dumper(2) + 39-runtime-monitoring(2) + 46-sa(1) + 14-c1(4,14 域完结) + 15-c2(8,15 域完结) + 21-shared-runtime(3,21 域完结) + 25-gc-framework(1)**;下一篇 25-gc-framework/02(CollectedHeap+分配路径,25 域共 6 篇)** | **上下文已满,本文件为非常详细交接版**——新 AI 只读本文件即可继续,不要依赖旧会话记忆
> **接收者: 新 AI —— 只读本文件,按"十、下一步"执行**

---

## 〇、三十秒总览(先读这个)

**项目**: 写一本 OpenJDK 源码分析书("格物致知"),源码树 = jdk11u(`/data/workspace/jdk11u/src/hotspot/`)。

**当前正在做**: 卷 2 按 48 域依赖拓扑写源码文章,每篇严格按方法论: 读大纲 → **所有行号重新 grep 验证** → 写 → 代码块与源码逐字核对 → **深审 2 轮(用户常追加第 3/4 轮 REVIEW)** → 回填大纲 ⚠️ 块 → 提交 → README → HANDOFF。

**下一步(唯一,无选择)**: 21-shared-runtime/03(异常处理,大纲 `planning/outlines/21-shared-runtime/03-exception-handling.md`;**21 域收官篇**;21 域 01/02 篇已完结,悬念已指向 03)。

**铁律**: ① 一篇一篇写,写完自查+深审 2 轮合格再下一篇;② 大纲/KP 的行号与机制描述是"线索不是事实",写作时必须重 grep——**实测每篇大纲有 2-15 处机制错误或行号漂移,96 篇无一例外**;③ 代码块贴真实源码(截取可,编造不可)——凭记忆写值必错,**"记忆中的代码"也要 grep 验证存在性**(本会话两次编造代码块: 44-02 的 check_end_stack、11-01 的 is_loading_success);④ 每篇写完整理后做深审,**必须 2 轮**(第 2 轮逐机制回源码质疑——第 2 轮才能抓到"顺理成章"的机制错误);⑤ 发现错误→修正文章→**回填大纲 ⚠️ 块**(防下次抄错)→提交;⑥ REVIEW 时正文与大纲的行号要一起过;⑦ 脚本语法错误要立即发现;⑧ 用户会追问"是不是 Kona 的问题"——实证 JDK 与源码版本要匹配,已下载 Temurin OpenJDK 11.0.32(见 §九)。

---

## 一、项目全貌

| 卷 | 位置 | 状态 |
|---|---|---|
| 卷 0 地基 | `docs/openjdk/vol-00/`(4 章) | ✅ 旧会话完成,不动 |
| 卷 T 工具观测 | `docs/openjdk/vol-tools/`(ch01.md~ch07.md 共 7 篇) | ✅ 旧会话完成,写作时引用其素材做实证 |
| 卷 1-bak 启动 | `docs/openjdk/vol-01-bak/`(14 章) | ✅ 归档,不沿用 |
| **卷 2 运行时深处** | `docs/openjdk/vol-02/` | 🚧 **当前任务**,按 48 域依赖拓扑写 |
| 域规划 | `docs/openjdk/planning/` | 48 域权威清单(00-domain-discovery-v3.md)+ 每域 KP + 每域大纲(outlines/0X-*/) |
| 工具素材库 | `docs/openjdk/planning/outlines/00-jvm-tools/materials/` | ✅ 命令输出/截图/JFR 录制(gitignore,不入库) |
| 本交接文档 | `docs/openjdk/SESSION-HANDOFF.md` | 本文件 |

**git 仓库**: `/data/workspace/source-code/openjdk-book/`(remote: git@github.com:LoveEleve/openjdk-book.git,main 分支,每篇一提交一推送)
**JDK 工具**: **`/data/tmp/opencode/jdk11`(Temurin OpenJDK 11.0.32,与 jdk11u 源码同版本——实证首选!)**;`/data/tmp/opencode/jdk17`(Temurin 17,含 src.zip 可查新版本 API 变迁,31-01 用它验证 defineAnonymousClass 移除);`/opt/codev/TencentKona/bin/`(17.0.8.1,通用)
**实证工作目录**: `/data/tmp/opencode/acbench/`(bench 源码+wrapper 脚本;jniref/ 子目录有 JNI/JFR 系列 demo: JNIRefDemo/JNIFieldBench/JNICheckDemo/ReflectionDemo/SleepDemo)
**旧交接文档**(更早会话起点,可参考历史): `/data/workspace/source-code/book/成长之路/tmp-question/training-camp/source-code/analysis/source-analysis/HANDOFF.md`

---

## 二、卷 2 写作进度(精确到篇)

**写作顺序依据**: `docs/openjdk/planning/knowledge-planning/00-domain-writing-order.md`(48 域依赖拓扑 7 层,脚本验证自洽)

```
第 1 批(地基): 01(4) → 05(2) → 45(2) → 48(4)                     ✅ 完结 12/12
第 2 批(原语): 02(4) → 03(2) → 04(2) → 06(6) → 16(5) → 38(2) → 41(2) → 42(3)   ✅ 完结 26/26
第 3 批(对象/类): 07(7) → 09(3) → 17(4)                          ✅ 完结 14/14
第 4 批(执行/帧): 10(3) → 19(4) → 23(3) → 24(3) → 08(4) → 31(2) → 44(2)   ✅ 完结 21/21
第 5 批(VM 核心): **11 ✅ → 12 ✅ → 13 ✅ → 18 ✅ → 20 ✅(2/2) → 27 ✅(3/3) → 30 ✅(3/3) → 32 ✅(6/6) → 34 ✅(2/2) → 36 ✅(2/2) → 37 ✅(2/2) → 39 ✅(2/2) → 46 ✅(1/1)** ✅ **第 5 批 13/13 收官**
第 6 批(JIT/GC): 14 ✅ → 15 ✅(8/8) → 21 ✅(3/3) → **25 ✅(1/6)** → 28 → 29 → 33 → 43
第 7 批(上层): 22 → 26 → 35 → 40 → 47
```

**已完成 121 篇**(全部在 `docs/openjdk/vol-02/`):

| 域 | 篇 | 文件 | 状态 |
|---|---|---|---|
| 01-os | 1-4 | `01-os/` 4 篇 | ✅ 旧会话 |
| 05-cpu-primitives | 1-2 | `05-cpu-primitives/` 2 篇 | ✅ 旧会话 |
| 45-math-library | 1-2 | `45-math-library/` 2 篇 | ✅ 旧会话 |
| 48-utilities | 1-4 | `48-utilities/` 4 篇 | ✅ 旧会话 |
| 02-assembler | 1-4 | `02-assembler/` 4 篇 | ✅ 旧会话 |
| 03-arguments-flags | 1-2 | `03-arguments-flags/` 2 篇 | ✅ 旧会话 |
| 04-logging | 1-2 | `04-logging/` 2 篇 | ✅ 旧会话 |
| 06-oops | 1-6 | `06-oops/01`~`06` | ✅ 旧会话 |
| 16-codecache | 1-5 | `16-code-cache/` 5 篇 | ✅ 旧会话 |
| 38-perfdata | 1-2 | `38-perfdata/` 2 篇 | ✅ 旧会话 |
| 41-zip-jimage | 1-2 | `41-zip-jimage/` 2 篇 | ✅ 旧会话 |
| 42-core-native | 1-3 | `42-core-native/` 3 篇 | ✅ 旧会话 |
| 07-classfile-classloader | 1-7 | `07-classfile-classloader/` 7 篇 | ✅ 旧会话 |
| 09-memory-core | 1-3 | `09-memory-core/` 3 篇 | ✅ 旧会话 |
| 17-threads | 1-4 | `17-threads/` 4 篇 | ✅ 旧会话 |
| 10-metaspace | 1-3 | `10-metaspace/` 3 篇 | ✅ 旧会话 |
| 19-sync | 1-4 | `19-sync/` 4 篇 | ✅ 旧会话 |
| 23-stub | 1-3 | `23-stub/` 3 篇 | ✅ 旧会话 |
| 24-frame | 1-3 | `24-frame/` 3 篇 | ✅ 旧会话 |
| **08-interpreter** | 1-4 | `08-interpreter/01-bytecodes-definition.md`(308)/02-template-interpreter.md(330)/03-interpreter-runtime.md(244)/04-linkresolver-rewriter.md(269) | ✅ **08 域完结(前会话)** |
| **31-unsafe** | 1-2 | `31-unsafe-whitebox/01-unsafe-api.md`(151)/02-whitebox-forte.md(132) | ✅ **31 域完结(前会话)** |
| **44-class-verification** | 1-2 | `44-class-verification/01-verifier.md`(316)/02-verification-type.md(149) | ✅ **44 域完结,第 4 批收官(前会话)** |
| **11-cds** | 1-2 | `11-cds/01-cds-overview-dump.md`(138)+`02-cds-load-shared.md`(319) | ✅ **11 域完结(前会话)** |
| **12-ci** | 1-3 | `12-ci/01-ci-overview-mirror.md`(174)+`02-ci-typeflow-escape.md`(164)+`03-ci-factory-runtime.md`(128) | ✅ **12 域完结(前会话)** |
| **13-jit-framework** | 1-2 | `13-jit-framework/01-compile-broker-queue.md`(76)+`02-tiered-compilation-policy.md`(146) | ✅ **13 域完结(前会话)** |
| **18-safepoint** | 1-2 | `18-safepoint/01-safepoint-orchestration.md`(121)+`02-polling-verifiers.md`(97) | ✅ **18 域完结(前会话)** |
| **20-vm-operations** | 1-2 | `20-vm-operations/01-vm-operation.md`(103)+`02-background-init.md`(372) | ✅ **20 域完结(本会话)** |
| **27-jni** | 1-3 | `27-jni/01-handle-system.md`(171)+`02-jni-fast-path.md`(189)+`03-jni-check-platform.md`(79) | ✅ **27 域完结(本会话)** |
| **30-jvm-entry** | 1-3 | `30-jvm-entry/01-jvm-entry-points.md`(138)+`02-java-calls.md`(118)+`03-reflection-stackwalk.md`(111) | ✅ **30 域完结(本会话)** |
| **32-jfr** | 1-6 | `32-jfr/01-recorder-engine.md`(139)+`02-event-metadata.md`(47)+`03-periodic-sampling.md`(67)+`04-binary-writer.md`(95)+`05-leak-profiler.md`(88)+`06-jni-instrumentation.md`(61) | ✅ **32 域完结(本会话)** |
| **34-nmt** | 1-2 | `34-nmt/01-tracking.md`(164)+`02-nmt-report.md`(150) | ✅ **34 域完结(本会话)** |
| **36-attach** | 1-2 | `36-attach/01-attach-listener.md`(157)+`02-jdk-attach.md`(65) | ✅ **36 域完结(本会话)** |
| **37-heap-dumper** | 1-2 | `37-heap-dumper/01-heap-dumper.md`(77)+`02-compression-triggers.md`(59) | ✅ **37 域完结(本会话)** |
| **39-runtime-monitoring** | 1-2 | `39-runtime-monitoring/01-service-thread.md`(73)+`02-timer-stats.md`(66) | ✅ **39 域完结(本会话)** |
| **46-sa-postmortem** | 1 | `46-sa-postmortem/01-sa-postmortem.md`(61) | ✅ **46 域完结(本会话),第 5 批收官** |
| **14-c1-compiler** | 1-4 | `14-c1-compiler/01-c1-pipeline-ir.md`(88)+`02-c1-optimizations.md`(56)+`03-c1-register-codegen.md`(45)+`04-c1-runtime-frame.md`(61) | ✅ **14 域完结(本会话)** |
| **15-c2-compiler** | 1-8 | `01-c2-ideal-graph.md`(253)+`02-c2-parse-graphkit.md`(230)+`03-c2-optimizations.md`(138)+`04-c2-loops.md`(140)+`05-c2-register-alloc.md`(143)+`06-c2-codegen.md`(129)+`07-c2-macro-intrinsics.md`(74)+`08-c2-library-calls.md`(104) | ✅ **15 域完结(本会话)** |
| **21-shared-runtime** | 1-3 | `21-shared-runtime/01-runtime-stubs.md`(96)+`02-c2i-i2c-adapter.md`(120)+`03-exception-handling.md`(191) | ✅ **21 域完结(本会话)** |
| **25-gc-framework** | 1 | `25-gc-framework/01-barrier-access.md`(195) | 🚧 **25 域 1/6(本会话)** |

### 本会话 26 篇的 commit 清单(按 git log 为准,2026-08-14/15)

**20-vm-operations/02(后台任务与启动序列,20 域收官)**: 正文 4e942c1(372 行)→ 回填 ⚠️ 14 组 → README 7aae8ba(84/152,20 域完结,第 5 批 11/13)→ 素材 20-background-init-demo.txt→ **第 3 轮** e1a7c49(01 篇后续链接文本与 02 实际标题对齐;02 关联域去 04-logging 改 39-runtime-mon;设计意图表述收窄到注释原意;VMThread 优先级表述精确化"必须低于 WatcherThread")→ **第 4 轮** 1bc3a42(①ServiceThread 行号与职责对齐——serviceThread.hpp:30 类注释+:84 entry 循环,:107-139 JVMTI/GCNotifier/DCmd 三事件;②Agent 启动时序——线程列表 :3804 才初始化,代理在调用者线程上;③sleep 重算循环 :1435-1446;④关键设计引注回 :1369-1371 原意;⑤stubGenerator 注释 :5974-5976;⑥AbortVMOnVMOperationTimeout 补默认 false globals.hpp:528;⑦静态数组块补 task.cpp:32-33 标注;⑧ServiceThread 'GC 低内存通知'→'GC 通知(GCNotifier)';验证 develop flag 在 PRODUCT 下是 const 常量→CleanChunkPoolAsync 恒 true)

**27-jni/01(Handle 系统,27 域 1/3)**: 正文 f64d2af(171 行)→ 回填 ⚠️ 9 组 → README f64d2af 同提交(85/152)→ 素材 27-jni-handles-demo.txt→ **第 3 轮** 6d6b59f(参数 handle 机制精确化——编译代码 object_move sharedRuntime_x86_64.cpp:1157-1180+解释器 pass_object interpreterRT_x86_64.cpp:214-260;06-oops/01 链接文本对齐;jweak 对齐=weak_tag_alignment=2)→ **第 4 轮** 786af8f(①free list 成因精确化——由 rebuild_free_list 扫描清空槽构建(:548-575),非 DeleteLocalRef 直接串链;②OopStorage release 细节——CAS 清位 :575-587+延迟清理 :416;③悬念"函数表查 env"→"经 JNIEnv 函数表间接调用";④SIGQUIT 摘要行措辞)

**27-jni/02(JNI Fast Path,27 域 2/3)**: 正文 1ec9012(189 行)→ 回填 ⚠️ 10 组 → README 1ec9012 同提交(86/152)→ 素材 27-jni-fastpath-demo.txt→ 深审 2 轮(①quicken_jni_functions 在 create_vm **第三段**(thread.cpp:3916)非第四段;②fieldID 偏移=BitsPerWord-2(64 位 62 位),位布局注释 "30" 是 32 位遗留)第 3 轮无新增→ **第 4 轮** da75d76(①安全论证补全——对象移动必然伴随 counter 变号,投机读读到旧位置值也被二次校验丢弃;②补 counter wraparound(hpp:54-55);③"条件 5 选 1"歧义改"替换的 5 个条件";④验证 GetObjectField 普通实现=HeapAccess oop_load_at+make_local(jni.cpp:2076);⑤验证 jni_GetStaticIntField 仅函数表槽)

**27-jni/03(JNI Check + 平台层,27 域收官)**: 正文 9f523af(79 行)→ 回填 ⚠️ 10 组 → README 9f523af 同提交(87/152,27 域完结)→ 素材 27-jni-check-demo.txt→ 深审 2 轮(①JNI_ENTRY_CHECKED **不含 ThreadInVMfromNative**——不做整函数状态转换,校验点用 IN_VM 局部转换(与 JNI_ENTRY 的关键差异);②jniExport.hpp 不是 JNI 函数声明而是 JVMTI 接口导出器;jni_NativeInterface 实例在 jni.cpp:3528 非 3550;validate_handle :443/validate_object :469 非 :497)第 3 轮无新增→ **第 4 轮** 35f96a8(①校验维度表补'字段 ID 类型'行(checkStaticFieldID :256/checkInstanceFieldID :284)→ 7→8 维度与悬念一致;②尾部链接统一相对路径;③fatal 路径差异: 宏内非 Java 线程=直接 print+abort 无 JNI 栈)

**30-jvm-entry/01(JVM Entry Points,30 域 1/3)**: 正文 9ed479d(138 行)→ 回填 ⚠️ 9 组 → README 9ed479d 同提交(88/152)→ 素材 30-jvm-entry-demo.txt→ **第 3 轮** bd629f1(JVM_LEAF 判据表述补全——不碰堆+不创建引用+不抛异常+不阻塞,'主要判据'非'唯一';验证 JVM_StartThread 内部链 :2894/:2902)→ **第 4 轮** 328791b(①注册表行号 System.c:38;②JVM_ENTRY/JNI_ENTRY 差异只陈述事实;③libjvm.so 实际导出 **174 个 JVM_* + 5 个 jio_***;④JVM_MonitorWait :81 例证验证;⑤131 个 UND 全为 U;⑥PrintJNIResolving 由 -verbose:jni 设置 arguments.cpp:2413)

**30-jvm-entry/02(JavaCalls + NativeLookup,30 域 2/3)**: 正文 bf0d15f(118 行)→ 回填 ⚠️ 9 组 → README bf0d15f 同提交(89/152)→ 素材 30-java-calls-demo.txt→ **第 3 轮** 7521406(特殊表 3 条→7 条,补 Perf→JVM_RegisterPerfMethods 与 JVMCI/JFR 条件条目)→ **第 4 轮** 69c5f2e(①**查找流程重写**: 核心=lookup_style :253 按类加载器分流——系统类=特殊表 :263+libjava dll_lookup :265;**应用类=JavaCalls::call_static 调 ClassLoader.findNative :277-285(绕回 Java 侧,System.loadLibrary 链路)**;lookup_entry :327 只做三种名字风格;agent 兜底 :293-297;②四断言补 :352 no_handle_mark;③Windows _64 表述删(无 windows 源码))

**30-jvm-entry/03(Reflection + StackWalk,30 域收官)**: 正文 cfd6484(111 行)→ 回填 ⚠️ 10 组 → README cfd6484 同提交(90/152,30 域完结)→ 素材 30-reflection-stackwalk-demo.txt→ 深审 2 轮(①override 标志 C++ 侧不用;②双轨过滤: hotspot 滤 @LambdaForm.Hidden,Java 侧滤反射帧——大纲'stackwalk 滤反射帧'错,实证 -Xlog:stackwalk=debug 证明 hotspot 把反射帧全 fill)→ **第 4 轮** fcb05e2(①分页批大小在 StackStreamFactory.java:545-556: 首批=min(max(estimateDepth,8),256),后续翻倍至 32;实证 6=estimateDepth 估计值;②JVMInvokeMethodSlack=develop_pd globals.hpp:1919)

**32-jfr/01(Recorder Engine,32 域 1/6)**: 正文 0856326(139 行)→ 回填 ⚠️ 9 组 → README 0856326 同提交(91/152)→ 素材 32-jfr-recorder-demo.txt→ 深审 2 轮(per-thread 双 buffer 非 per-event-type;JfrThreadLocalBufferSize 编造;write_chunk_loop 编造;四 级刷写链;chunk 头回填实证)→ **第 3 轮** 474ccf4(JfrBuffer 表述精确化: 线性区非环形)→ **第 4 轮**(无正文改动;143 个事件类型实证,素材补记)

**32-jfr/02(Event Types + Metadata,32 域 2/6)**: 正文 1f5d2d3(47 行)→ 回填 ⚠️ 10 组 → README 1f5d2d3 同提交(92/152)→ 素材 32-jfr-metadata-demo.txt→ 深审 2 轮(①**metadata.xml 双端消费**: 构建期 GenerateJfrFiles→jfrEventClasses.hpp;jdk.jfr 资源 MetadataHandler:218 运行期解析;②jfrMetadataEventClass.cpp/TRACE_REQUEST_COMMIT 编造;③分类=层级 category)→ **第 3 轮** 418b993(采样器引用补行号)→ **第 4 轮** a2e168a(①'全部事件类型'限定'内置事件类型';②'XML 不会在运行期被解析'限定为 C++ 事件类;③143 vs 124 关系补注)

**32-jfr/03(Periodic Sampling,32 域 3/6)**: 正文 6daa7f1(67 行)→ 回填 ⚠️ 9 组 → README 6daa7f1 同提交(93/152)→ 素材 32-jfr-sampling-demo.txt→ 深审 2 轮(AGCT 采样错(31-02 已证 SuspendedThreadTask);JfrThreadSamplingInterval 编造;trace_id=u8 非 4 字节;45 个周期事件非 ~20;RequestEngine 驱动)→ **第 3 轮** 79a1216(函数名修正: jfr_set_method_sampling_interval)→ **第 4 轮** 5ae494d(①悬念段遗留'4 字节'改 8 字节——跨段一致性问题;②栈轨迹落盘 repository::write :100;③resolve_linenos 在 add 层验证)

**32-jfr/04(Binary Writer + Chunk Format,32 域 4/6)**: 正文 328c92f(95 行)→ 回填 ⚠️ 9 组 → README 328c92f 同提交(94/152)→ 素材 32-jfr-binary-demo.txt→ 深审 2 轮(①jfrBinaryWriter.cpp 编造(真实=WriterHost 模板);②magic 0xCAFEBABE 编造(实证 FLR\0);③jfrLeb128 编造(真实 Varint128EncoderImpl,compressed 恒 true);④负值 2 字节陷阱)→ **第 3 轮** 329733b(STRING_CONSTANT 表述收敛)→ **第 4 轮** a33ec4c(①'长度头用 be_write'修正(长度走 write 变长编码,数据体 be_write 直拷);②事件格式补 **u4 大小槽**(begin_event_write reserve :56-60/end_event_write 回填 :62-76))

**32-jfr/05(Old Object Sampling,32 域 5/6)**: 正文 b595e6b(88 行)→ 回填 ⚠️ 8 组 → README b595e6b 同提交(95/152)→ 素材 32-jfr-leakprofiler-demo.txt→ 深审 2 轮(①'每 N 字节采样'错(粒度=TLAB refill,AllocTracer 钩子);②span=分配增量;③双锁(JfrTryLock+自旋锁);本篇大纲较准)→ **第 3 轮** f3bdc94(quick reject 表述修正——栈记录在 sample 入口已发生)→ **第 4 轮** acb752b(补 **cutoff 机制**: EventEmitter::emit cutoff≤0 只发样本无链;默认 memory-leak-detection-cutoff=0ns)

**32-jfr/06(JNI Interface + Instrumentation + DCmd,32 域收官)**: 正文 f2a2c2f(61 行)→ 回填 ⚠️ 10 组 → README f2a2c2f 同提交(96/152,32 域完结)→ 素材 32-jfr-jni-instrumentation-demo.txt→ 深审 2 轮(①JfrClassAdapter 编造(真实=JfrEventClassTransformer::on_klass_creation,klassFactory.cpp:222 拦截 Event 子类);②'方法入口 ASM 插桩'错(注入=事件类 schema 5 方法壳+3 字段,急切模式调 EventInstrumentation);③JfrJniMethod::start/JfrDCmd/thread_local_jfr_ref 编造)→ **第 3 轮** c284e32(补实证引用)→ **第 4 轮** bacb90a(急切注入条件精确化: Jfr::is_recording() 或 force_instrumentation)

**34-nmt/01(NMT 追踪系统,34 域 1/2)**: 正文 cb24e2a(164 行,含大纲回填 ⚠️ 9 组)→ README 0f2abb7(97/152)→ 素材 34-nmt-tracking-demo.txt→ 深审 2 轮(①MallocHeader 位域(大小/类别/表索引)非指针;②minimal 构造直接 return 纯占位;③四档只降不升;④固定 4 帧栈;CURRENT_PC 仅 detail 真抓栈;⑤虚拟内存区域链表非 per-site 聚合;⑥OOM 自动降级;⑦链接文本对齐 4 个前置依赖;⑧悬念段跨段(PerfStringConstant 是 malloc 段/G1FromCardCache 是虚拟内存段))→ **第 3 轮** 58866ce(补追踪范围澄清: JNI 直接 libc malloc 不入账;跨段一致性复核;实证数字逐条对素材)→ **第 4 轮** 434708a(§5 Solaris 推断删改事实;§2 对齐注释行号精确化 :240-266;HANDOFF 素材数/commit 清单/§6.4 34 域源码位置/状态行笔误;SetJvmEnvironment 调用时机实证)

**34-nmt/02(NMT 报告与对比,34 域收官)**: 正文 3fba0d4(150 行,含大纲回填 ⚠️ 11 组)→ README 62e48f4(98/152,34 域完结)→ 深审 2 轮(①MemBaseline 无 diff 方法——diff 在 reporter 层(MemSummaryDiffReporter 带符号增量/MemDetailDiffReporter 双链归并),大纲 diff+threshold 全编造;②report_site 编造(真实 report_malloc_sites/report_virtual_memory_allocation_sites/report_virtual_memory_region);③NMTDCmd 注册在 Management::init 非 initialize_optional_support;④36-attach 链接标题对齐;⑤素材缺 committed 子段(正文引用超出素材→补素材 (A) 段 G1PageBasedVirtualSpace 栈);⑥scale: DCmd 默认 KB vs PrintNMTStatistics scale=1 字节(素材无后缀证据);⑦悬念指 35 过期→36-attach)→ **第 4 轮** c255130(§2 补 18 类实证;素材 (A) 段 'reserved and committed' 丢字修正+Virtual memory map:/Details: 标题行)

**36-attach/01(AttachListener + Socket IPC,36 域 1/2)**: 正文 3cbbe22(157 行,含大纲回填 ⚠️ 10 组)→ README eb9dbf4(99/152)→ 素材 36-attach-trigger-demo.txt→ 深审 2 轮(①attach-on-demand 懒启动(vm_start 清残留,StartAttachListener/ReduceSignalUsage 例外);②触发=attach_pid 文件+SIGQUIT 双条件(Signal 线程 SIGBREAK 二义: 无文件=线程转储,有文件=is_init_trigger uid 校验后 init,已初始化短路);③Attach Listener JavaThread dequeue→分派→complete(10 操作,jcmd=DCmd::parse_and_execute arg(0)——34-nmt/02 AttachAPI 通道衔接);④Linux socket .tmp bind+rename 原子出现,0600+SO_PEERCRED 双保险,NUL 分隔协议 v1/101 BADVERSION)→ **第 3 轮** cc3a38b(jcmd 失败结论修正: 34-nmt 会话目标 NMTDemo 3 秒即退出,非"容器不支持 attach")→ **第 4 轮** e19b9f3(signal_thread_entry 引用 341-382→341-389 与代码块对齐;detachall 表述精确化+Linux 空实现 :580-582;删"常用于容器场景"无依据推断)

**36-attach/02(JDK Attach API + loadAgent,36 域收官)**: 正文 80537ed(65 行,含大纲回填 ⚠️ 9 组)→ README a2f0430(100/152,36 域完结)→ 素材 36-attach-loadagent-demo.txt→ 深审 2 轮(①jdk.attach 三层封装(VirtualMachine.attach 遍历 provider/自 attach 门控 allowAttachSelf——34-nmt/02 失败根因实证);②API→10 操作名映射表+ManagementAgent.start DCmd 通道;③load 全链路(find_builtin_agent/dll_load dlopen 含 execstack 守卫/dlsym Agent_OnAttach/'return code: N' 协议/AgentInitializationException);④Java agent=instrument 库+agentmain(JPLIS,错误码翻译);⑤启动 Agent_OnLoad(vm_exit)vs attach Agent_OnAttach(报错)+JVMTI.agent_load DCmd 第三通道)→ 第 3/4 轮(复核无新问题)

**37-heap-dumper/01(HeapDumper + hprof 格式,37 域 1/2)**: 正文 b4d58cd(77 行,含大纲回填 ⚠️ 11 组)→ README 8800102(101/152)→ 素材 37-heap-dumper-demo.txt→ 深审 2 轮(①执行模型(VM_GC_Operation+AbstractGangTask,doit 内 ensure_parsability+可选 Full GC(GCLocker 跳过)+WorkGang 并行写);②hprof 格式(1.0.2 头/记录流/HEAP_DUMP_SEGMENT 0x1C 动态回填段头/END 0x2C);③JDK11 专有 sub-record 变体(CLASS_DUMP 无 serial=id+u4 stid+id×6+u4,INSTANCE/OBJ/PRIM_ARRAY 均带 STACK_TRACE_ID 常量 1);④对象 ID=地址(write_objectID 直写 oop 指针,class id=java mirror)——safepoint 必要性;⑤实证: 15MB 文件逐字节解析+live 对照(INSTANCE 104269→37782 -64%))→ **第 4 轮** da7f010(sub-record 头修正(跨段遗留): 真实=u1 tag+body 无 time/len,9 字节头只属于段记录;class id 字节示例归属 CLASS_DUMP)

**37-heap-dumper/02(流式压缩 + 多触发入口,37 域收官)**: 正文 5150644(59 行,含大纲回填 ⚠️ 11 组)→ README 5528a26(102/152,37 域完结)→ 素材 37-heap-dumper-gzip-oome-demo.txt→ 深审 2 轮(①压缩管线(DumpWriter→CompressionBackend 块队列→FileWriter;worker 线程与遍历并行但全程 safepoint 内,块 id 顺序落盘;GZipCompressor dlsym libzip 的 ZIP_GZip_Fully/InitParams,第一块带 HPROF BLOCKSIZE 注释);②五路触发(attach dumpheap/DCmd GC.heap_dump 唯一压缩路/JMX jmm_DumpHeap0/OOM cmpxchg 只报一次+不做 GC/GC 前后 full_gc_dump);③JFR 应急 dump 编造澄清)→ **第 3 轮** ba7fc4b(§1 隐含断言修正——快照拷贝受 ThreadCritical)→ **第 4 轮** e91ec98(OOM 段落"压缩器 out/tmp"断言修正——OOM 路无压缩器)

**39-runtime-monitoring/01(ServiceThread,39 域 1/2)**: 正文 f70b0c5(73 行,含大纲回填 ⚠️ 9 组)→ README de26701(103/152)→ 深审 2 轮(①事件驱动主循环(ThreadBlockInVM+Service_lock 下 5 条件检测、锁外处理、JVMTI 锁内 dequeue 锁外 post 防丢失唤醒);②NearMaxPriority 高优先级(prio=9 实证)——大纲'低优先级'错;③五类任务触发源(JVMTI deferred 队列+oops_do 保活/GCNotifier 链表 pushNotification 自 GCMemoryManager::gc_end/StringTable check_concurrent_work+concurrent_work grow 或 clean_dead/内存传感器 usage_sensor/DCmd JMX 通知,两处清异常防线程死);④JFR/OopStorage 澄清(非本线程任务);⑤与 WatcherThread 闹钟vs门铃分工)→ **第 4 轮** 32fe697(JMX 类名修正 GarbageCollectorImpl→GarbageCollectorExtImpl;ThreadBlockInVM 注释行号 :94-100;pushNotification→addRequest 确实 notify 验证)

**39-runtime-monitoring/02(Timer + Monitoring Services,39 域收官)**: 正文 6cfef46(66 行,含大纲回填 ⚠️ 10 组)→ README d7dff18(104/152,39 域完结)→ 素材 39-runtime-monitoring-timer-demo.txt→ 深审 2 轮(①计时家族(os::elapsed_counter=CLOCK_MONOTONIC clock_gettime(dlsym),elapsedTimer/TimeStamp/TraceTime 在 timerTrace.hpp 独立文件且输出走日志框架非 tty,GC phase 用 GCTraceTimeImpl 非 TraceTime);②三个 Monitoring Service=PerfData 读口(ClassLoadingService 类加载事件钩子更新/RuntimeService PerfCounter+TimeStamp/ThreadService 原子计数),JMX/JFR/jstat 同一份数据)→ **第 4 轮** 16a954e(initial_time_count 引用精确化 :177/:5565;ClassLoadingService=AllStatic 验证;record_safepoint 调用点验证)

**46-sa-postmortem/01(SA Postmortem,第 5 批收官域)**: 正文 e8526bc(61 行,含大纲回填 ⚠️ 9 组)→ README eff5880(105/152,第 5 批 13/13 收官)→ 素材 46-sa-postmortem-demo.txt→ 深审 2 轮(①core dump 解析(ELF PT_LOAD 段→add_map_info 链表 prepend→sort_map_array qsort→core_lookup 二分(大纲'线性 O(n)'错)→core_read_data pread 段内偏移+分数页补零);②活进程(verifyBitness/Pgrab ptrace attach+waitpid SIGSTOP/process_read_data 8 字节 PEEKDATA 非对齐三段式);③符号(ELF SHT_DYNSYM 默认/SYMTAB 优先,hcreate_r 哈希 O(1) 查找(大纲'线性遍历'错),lookup_symbol 全局搜所有库,debuglink/build-id debuginfo);④ps_prochandle 统一双数据源)→ 第 3/4 轮(复核无新问题)

**14-c1-compiler/01(C1 管线 + HIR,第 6 批开篇)**: 正文 0bbb913(88 行,含大纲回填 ⚠️ 9 组)→ README 35d344e(106/152,第 6 批开篇)→ 素材 14-c1-pipeline-demo.txt→ 深审 2 轮(①管线真相=三大步非六步(Compiler::compile_method 只构造 Compilation;build_hir/emit_lir/emit_code_body);②Canonicalizer 非独立阶段=append_with_bci 即时内联;③iload 零成本(state()->local_at 直接 push 不建 LoadLocal);④Phi=ValueStack setup_phi_for_stack/local 块合并创建)→ **第 4 轮** a256662(优化趟数三趟→四趟(补 eliminate_null_checks);iadd→arith_op(:2795)→ArithmeticOp(:1121)验证)

**14-c1-compiler/02(C1 优化,14 域 2/4)**: 正文 d7c79df(56 行,含大纲回填 ⚠️ 10 组)→ README b4e6586(107/152)→ 素材 14-c1-optimizations-demo.txt→ 深审 2 轮(①Canonicalizer 单遍即时(构造时 visit 一次,非"多趟");②x*1→log2_scale 移位、x/x 不存在;③do_If 化简为 Goto;④无内联(大纲编造);⑤C1 有 bcEscapeAnalyzer 浅层 escape;⑥flag 盘点(RangeCheckElimination product,其余 develop))→ **第 4 轮** 94a2793(CanonicalizeNodes 是 develop(:165)非 product;开篇语境;内联器引用修正;x*1 断言弱化)

**14-c1-compiler/03(LinearScan + LIR → x86 码,14 域 3/4)**: 正文 6ba2903(45 行,含大纲回填 ⚠️ 10 组)→ README 9d2f7ed(108/152)→ 素材 14-c1-register-codegen-demo.txt→ 深审 2 轮(①Interval=Range 链表非单一 [start,end];②spill 选 _use_pos 最晚(非"end 最远");③x86 peephole 空实现——LIR 优化=EdgeMoveOptimizer+ControlFlowOptimizer;④LinearScan 6800 行(大纲 400-800 低估);⑤do_linear_scan 全流程/activate_current 双路径)→ **第 4 轮** 428f011(peephole 引用错位修正: 注释在 hpp:160-161,空实现 x86.cpp:3994 只有 "// do nothing for now";TraceLinearScanLevel=develop 验证)

**14-c1-compiler/04(Runtime1 + FrameMap,14 域收官)**: 正文 9693e17(61 行,含大纲回填 ⚠️ 10 组)→ README 811f3ed(109/152,14 域完结,第 6 批 1/8)→ 素材 14-c1-runtime-frame-demo.txt→ 深审 2 轮(①Runtime1=JRT_ENTRY 家族逃生口(Klass* 非 ciKlass/set_vm_result TLS 返回/慢路径语义 TLAB 快速路径内联);②monitorenter→SharedRuntime 助手;③OopMap 在 LinearScan 构建(大纲"FrameMap 构建"错);④patch_code 懒链接;⑤StubID=RUNTIME1_STUBS 宏/generate_blob stub 进 CodeCache)→ 第 3/4 轮(复核无新问题)

**15-c2-compiler/01(C2 Ideal Graph: Node + Type + IGVN,15 域开篇)**: 正文 58e4a25(253 行,含大纲回填 ⚠️ 3 块 13 条)→ README 1992d9f(110/152,15 域 1/8,第 6 批 2/8)→ 素材 15-c2-ideal-graph-demo.txt→ 深审 2 轮(①**Ideal() 返回约定**: NULL=无变化(默认),改图必须返回新根(可 this),**禁止返回旧节点**(走 Identity)——大纲"返回 this(NOP)"错;②**AddNode `Node(0,in1,in2)` 的 0 是 NULL 控制槽**(addnode.hpp:44)——in(0) 存在但恒 NULL(控制无关可浮动,loopopts.cpp:1379),非"无 in(0) 槽";③**`igvn.cpp` 不存在**——hash_find_insert 在 phaseX.cpp:143;④**transform 五步非三环**: Ideal 循环→Value→singleton 常量→Identity→hash_find_insert,大纲漏 GVN 步;⑤**x+0/x*1 折叠发生在 Parse 期**单遍 PhaseGVN::transform_no_reclaim(phaseX.cpp:864-924+addnode.cpp:56-61),IGVN 价值=worklist 迭代+级联+全局 CSE+can_reshape;⑥**ptr_meet 表 Null∩NotNull=BotPTR**(type.cpp:2460-2468)——矛盾即死路径,大纲"放弃 nullness 变 Ptr"错;名字 **NOTNULL**(type.hpp:919);⑦xmeet 虚分派(非 meet_helper);⑧hash-cons 类型唯一不可变;⑨K=1024 死循环守卫(globalDefinitions.hpp:255);⑩**实证边界**: PrintIdeal/PrintIdealGraph notproduct 拒启、**PrintOptoAssembly diagnostic 但实现 NOT_PRODUCT**(compile.cpp:718-733/output.cpp:1554)release 静默、CITime 阶段树(GVN1/IGVN/GVN2)、javac 层折叠(bigsum 50 常量→bipush 50,3 字节);⑪IGVN 在 Optimize 中 6 处运行(compile.cpp:2247-2254/:2321/:2332/:2388-2391/:2424/:2454))→ **第 3 轮** 新修正 6 处(①PhiNode::Value 用 **meet_speculative**(cfgnode.cpp:1007)非 meet();②Parse 与 Optimize 之间夹 **PhaseRemoveUseless**(compile.cpp:841-844);③check_node_count 语义精确化(compile.hpp:907-914,余量 NodeLimitFudgeFactor×2);④AddNode::Identity 对称双侧检查表述;⑤实证表述精确化(编译事件非"C2 编译";cfold"level 1 为止");⑥大纲 ⚠️ 块统一为 `> 块级引用` 格式(3 块 13 条),HANDOFF"9 组"计数修正)

**15-c2-compiler/02(Parse + GraphKit,15 域 2/8)**: 正文 5e82ad9(230 行,含大纲回填 ⚠️ 3 块 15 条)→ README 5fe6151(111/152,15 域 2/8,第 6 批 3/8)→ 素材 15-c2-parse-graphkit-demo.txt→ 深审 2 轮(①**块驱动非线性读**: do_all_blocks RPO(parse1.cpp:632-733)→do_one_block→do_one_bytecode switch(parse2.cpp:1907),iload 直接 push(local(n)) 零成本(:2014-2033);②**do_load/do_arith/do_inline/add_node 全编造**——加/载在 switch 内联建节点,内联递归=ParseGenerator::generate→`Parse parser(jvms,...)`(callGenerator.cpp:84-111);③**do_call 在 doCall.cpp:423** 非 parse1.cpp;字段访问 do_field_access 在 parse3.cpp:76;④**MaxInlineLevel=15 非 9**(globals.hpp:1692),深度计 inline_level()=caller_jvms->depth()(parse.hpp:96-97);⑤**C1 也有深度/大小限制**+NestedInliningSizeRatio=90% 逐层衰减(c1_globals.hpp:177),大纲"C1 只 tiny methods depth≤2"错;⑥高频放宽 FreqInlineSize=**325**(x86_64);⑦**OopMap 错位**: parse 期 safepoint 捕获 JVMState(节点),机器 OopMap 在寄存器分配后 BuildOopMaps 构建(buildOopMap.cpp:566);⑧MergeMem 多切片(memnode.hpp:1403+,AliasIdxBot base/AliasIdxTop 哨兵);⑨add_safepoint 四件事(去重/内存克隆/轮询地址 thread-local 或全局页/挂 JVMState 链+root prec);⑩异常双路 throw_to_exit/catch_inline_exceptions;实证: PrintInlining 树三棵(C1 嵌套 90% 衰减 7 字节 d6 也 too large vs C2 高频 139 字节 big inline (hot) vs 16 层内联后第 17 层 d3 too deep)+OSR % 事件(OSRDemo loop @ 5))→ **第 3 轮** 新修正(①OSR 段落补全: load_interpreter_state(parse1.cpp:186+)用 fetch_interpreter_state(:104)逐槽恢复,填充侧=SharedRuntime::OSR_migration_begin(sharedRuntime.cpp:3036);②catch_inline_exceptions 补行号 doCall.cpp:836;③大纲 ⚠️ 计数修正 3 块 15 条;④C1 衰减计算精确化)

---

## 三、每篇写作流程(严格执行,不可省略)

```
1. 读大纲: planning/outlines/<NN>-<域>/<NN>-<篇>.md(注意 ⚠️ 写作期修正块)
2. 读 KP: planning/knowledge-planning/<NN>-<域>.md(若大纲信息不足)
3. 【铁律】验证大纲里所有 file:line 与"专有名词存在性"——逐个 grep/sed 核对,发现漂移用真实行号
   —— 实测: 大纲几乎每篇都有 2-15 处错误/漂移,绝不可照抄;行号对了名字也可能是假的(44-01 行号全对但缺机制,11-01 机制与行号双错)
4. 写正文到 vol-02/<NN>-<域>/<NN>-<篇>.md
5. 自查:
   - 代码块与源码逐字核对(python 脚本 /data/tmp/opencode/check.py: 提取块内行逐一比对源文件区间;"..." 可省略任意源行;strip 后判 "..."!)
   - 所有 file:line 范围验证(脚本: 文件名→目录映射,行号在 [1, 文件行数] 内)
   - 星号配对(代码 span 剔除后)、文字锚(文件名后无行号)、TODO 残留
   - 工具实证引用必须真实存在(materials/ 里 grep 到才引用)
6. git add + commit + push(信息: 域/篇/深审修正清单;中文)
7. 更新 vol-02/README.md 勾选进度(单独 commit)
8. 更新 SESSION-HANDOFF.md(进度+经验沉淀,单独 commit)
```

**深审流程(写完后主动做 2 轮;用户常追加"再深度 REVIEW"=第 3/4 轮,按同样方法再质疑)**:
```
第 1 轮: 通读全文 + 跑自查脚本(代码块/行号/星号/文字锚/TODO)
第 2 轮(最重要,专门抓"写对但机制是编的"):
    ① 写作时"凭记忆/凭直觉"补的机制描述——逐个回源码核对(识别信号: "所以/为什么能/自然"开头的推导段)
    ② 正文引用的 file:line 内容语义(不是存在性)
    ③ 数字自洽(全文 grep 关键数字,含默认值/枚举值)
    ④ 文字锚(文件名后无行号的引用)
    ⑤ 跨篇一致性: 本篇 OUTBOUND 悬念行描述、上篇悬念承诺的话题(逐条对照正文是否覆盖)
    ⑥ 元文档自查(HANDOFF/README 篇数)
第 3/4 轮(用户追加时): 重点抓前几轮没抓到的"顺理成章"错误——历史高发: 跨段遗留(改了正文没改悬念,如 32-03 的 4/8 字节)、隐含断言(如 32-05 的"录制停止即追链")、函数名/行号凭记忆(如 jfr_set_method_sampling_interval)
发现错误 → 修正文章 → 回填大纲(⚠️ 块)→ 提交
```

---

## 四、方法论体系(写作规范全集)

### 4.1 WRITING-GUIDELINES.md(`docs/openjdk/WRITING-GUIDELINES.md`,10 条)
1. 去 AI 味(写的是书,不是文档;无模板标题/无✅❌符号——README 可用 ✅,正文不可)
2. **依赖驱动排序(A 依赖 B,先写 B)** ← 48 域拓扑的依据
3. 从问题开始(先"为什么"再"是什么")
4. 禁止前向引用("后面会讲"=结构错了;跨域导航如"细节在 25-gc 域"可以,本域内不行)
5. 构造/运行时严格分离
6. 一个概念改三轮讲不通 → 删除
7. 说人话(先人话再源码术语)
8. **每句陈述有源码依据** + 书稿代码块纪律(见 4.3)
9. 画流程图(时间线/数据流)

### 4.2 v5 文章格式(每篇固定结构)
- 头部: `# NN. 标题 — 问题句` + `> **前置依赖**`(链接前文,文本与目标标题一致)+ `> → **后续**`(链接下一篇)+ `> 关联域`
- 开篇: 场景句(为什么问这个问题)
- 每机制段落四要素: 场景 → 技术描述(file:line+函数名) → **关键设计 (斜体)**(why)→ 跨层标注([C++:] [x86:] [实证:])
- 结尾: `## 核心悬念`(一段话总结本篇+桥到下一篇)+ `> → [下一篇](...)`
- 代码块: 首行标注 `// file.cpp:start-end(截取核心,逐字)`;标注范围必须与内容精确对应(含闭合括号行)
- 跨篇引用用相对/`openjdk/vol-02/...` 路径;**链接文本必须与目标文章标题一致**(已抓过多次;06-oops/01、13-jit/01、23-stub/01、24-frame/02、08-interpreter/04 等标题对齐)

### 4.3 书稿代码块纪律(血泪总结,每篇深审都靠它抓错)
1. **代码块 = 真实源码**: 截取可(省略模板/错误处理,用 "..." 占位),核心语句逐字,**禁止凭记忆写值/编码/常量/注释**
2. **行号写作时重新 grep**: 大纲/KP 是规划期产物,行号大量漂移——每篇实测都有 2-15 处漂移
3. **自查脚本**(/data/tmp/opencode/check.py): 文章每个 file:line 逐个核对;代码块与源码逐行 diff("..." 跳过);新文件先加 MAPPINGS(JDK 侧)/HS_MAP(hotspot 侧,单行 dict,追加时注意逗号);**EXTERNAL** 字典处理不在 SRC/HS 树内的文件(jdk.unsupported 的 Unsafe.java、jdk.jfr 的 Options.java/MetadataRepository.java/EventClassBuilder.java/RequestEngine.java/EventInstrumentation.java、java.base 的 jni.h 在 MAPPINGS)
4. **文件名必须 find 验证**: 目录/文件路径凭记忆必错(31 域目录是 31-unsafe-whitebox 不是 31-unsafe;reflection.cpp 在 share/runtime 非 prims;33-jmx 目录是 33-jmx-management)
5. **大纲的"篇数/数字"也要重验**: 进度表述以 outlines/ 实际文件数为准(32 域规划 6 篇非 4 篇!)

### 4.4 深审缺陷档案(`/data/workspace/source-code/book/成长之路/tmp-question/training-camp/source-code/issue/源码分析深审缺陷档案.md`,15 类)
- A 内容层: #1 事实错误 / #2 API 编造 / #3 文件名推断 / #4 跨项目转移 / #5 覆盖率 / #6 跨层不一致
- B 结构层: #7 文字锚 / #8 篇节标注 / #9 表格格式 / #10 数字自洽
- C 过程层: #11 范围规划不可信 / #12 待确认清零 / #13 一次一域 / **#14 书稿代码块编造(写作期高发)** / **#15 大纲描述与源码漂移**

---

## 五、素材库(写作时引用实证)

| 素材 | 位置 | 用途 |
|---|---|---|
| 素材索引 | `planning/outlines/00-jvm-tools/materials/INDEX.md` | 按域查素材的入口 |
| JFR 录制 | `materials/jfr-recordings/rec-demo.jfr` 等 | 事件计数实证 |
| 命令输出 | `materials/commands/` 150+ 文件 | jcmd/jstat/jmap/jfr 等真实输出 |
| 卷 T 文章 | `vol-tools/ch01.md`~`ch07.md` | 引用格式: "[卷 T ch02](openjdk/vol-tools/ch02.md)" |

**本会话新增素材 34 个**(全部 gitignore 不入库,在 materials/commands/):
- `20-background-init-demo.txt`(SIGQUIT "VM Periodic Task Thread" waiting on condition/BiasedLockingStartupDelay=0/PerfDataSamplingInterval=50)
- `27-jni-handles-demo.txt`(JNI demo: NewGlobalRef refType=2/NewWeakGlobalRef 地址 lsb=1 refType=3/参数变 local ref=1/deleteGlobal+GC 后弱引用清空/SIGQUIT "JNI global refs: 29, weak refs: 1" 基线 28/0/DeleteGlobalRef(local ref) SIGSEGV 实测)
- `27-jni-fastpath-demo.txt`(UseFastJNIAccessors=true 默认;2000 万次 GetIntField 快 1.4ns/次 vs 慢 15ns/次约 10 倍)
- `27-jni-check-demo.txt`(-Xcheck:jni 本地引用泄漏警告每 32 个/挂起异常警告/无 flag 对照 0 警告)
- `30-jvm-entry-demo.txt`(-verbose:jni Registering vs Dynamic-linking;nm libjava.so 131 个 U JVM_*@SUNWprivate_1.1;libjvm.so 174 个 JVM_* 导出)
- `30-java-calls-demo.txt`(nm libjava.so 207 个 T Java_ 符号;UnsatisfiedLinkError 格式;lookup_style 分流)
- `30-reflection-stackwalk-demo.txt`(SHOW_HIDDEN_FRAMES 反射链 6 帧;-Xlog:stackwalk=debug 证明 hotspot 不过滤反射帧)
- `32-jfr-recorder-demo.txt`(xxd 文件头 FLR\0+版本 2.0+chunk_size 回填=文件大小;bin/jfr summary: Version 2.0/Chunks 1/143 个 jdk.* 类型)
- `32-jfr-metadata-demo.txt`(jfr print --events 按 metadata schema 解析实例;category 层级统计)
- `32-jfr-sampling-demo.txt`(jfr print ExecutionSample 实例: sampledThread/state/完整栈)
- `32-jfr-binary-demo.txt`(jfr print --xml 还原 CPULoad 字段;Varint128 结构;字符串编码)
- `32-jfr-leakprofiler-demo.txt`(采样链/路径追踪/序列化源码核对)
- `32-jfr-jni-instrumentation-demo.txt`(转换器/JNI 表/DCmd 链核对)
- `37-heap-dumper-gzip-oome-demo.txt`(gzip 流式压缩实证: 自 attach+executeJCmd GC.heap_dump -gz=1,文件头 1f8b 0810+FCOMMENT+"HPROF BLOCKSIZE=1048576" 注释,1318476 vs 15430735=12x,python gzip 解压还原 JAVA PROFILE 头;OOM 自动 dump: -Xmx64m+HeapDumpOnOutOfMemoryError→java_pid<pid>.hprof 34MB,顺序=OOM 消息→dump→异常;GC.heap_dump filename 是位置参数)
- `37-heap-dumper-demo.txt`(hprof 文件逐字节解析: 19 字节头 "JAVA PROFILE 1.0.2\0"+u4 id_size=8+u8 时间戳;顶层记录 UTF8 49109/LOAD_CLASS 2211/FRAME 30/TRACE 8/SEGMENT 16/END;段内 INSTANCE 104269/PRIM_ARRAY 34837/OBJ_ARRAY 23378/CLASS_DUMP 2021/STICKY 1601/JNI_GLOBAL 64/THREAD_OBJ 7;live 对照 6.0MB/4 段/INSTANCE 37782(-64%);JDK11 变体验证: CLASS_DUMP 无 serial(64 字节头)/INSTANCE 含 object id+stid;触发=HotSpotDiagnostic.dumpHeap 需 jmxremote 加载 libmanagement)
- `14-c1-runtime-frame-demo.txt`(Runtime1 机制定位: StubID 宏/JRT_ENTRY 家族/Klass* 参数/set_vm_result/SharedRuntime 锁助手/patch_code;OopMap 在 LinearScan;nmethod header stub code=48/oops=8)
- `14-c1-register-codegen-demo.txt`(LinearScan 机制定位: do_linear_scan 全流程/Interval=Range 链表/alloc_locked_reg 选 use_pos 最晚/x86 peephole 空实现+EdgeMoveOptimizer/LIR_Assembler emit 链)
- `14-c1-optimizations-demo.txt`(C1 优化 flag 类型盘点: RangeCheckElimination=product 可关,UseC1Optimizations 等 develop 不可关;PrintAssembly 无 hsdis 只输出 nmethod header(C1 main code 352>C2 224);机制源码定位)
- `14-c1-pipeline-demo.txt`(PrintCompilation 实证: "230 b 3 C1Demo::sum (23 bytes)"/231 % OSR/made not entrant;-Xlog:jit+compilation 等价;PrintIR/PrintLIR notproduct 说明;管线三大步源码定位)
- `15-c2-ideal-graph-demo.txt`(C2 编译事件: IGVNDemo idn/phi 编到 level 4、cfold 常量方法 level 1、旧 nmethod made not entrant;PrintInlining 内联树 diagnostic 可用;PrintIdeal/PrintIdealGraph notproduct 拒启错误信息原文;PrintOptoAssembly 接受但 release 静默;CITime 阶段树 Parse/Optimize(GVN1/IGVN/Cond Const Prop/GVN2)/Matcher/Scheduler/Regalloc;bigsum 50 常量 javac 折叠成 bipush 50→3 字节)
- `21-runtime-stubs-demo.txt`(IC miss 实证: ICDemo 双态调用点(Circle/Square 各半)PrintInlining 显示 TypeProfile (20650/41300 counts)+两路 inline (hot)——类型画像驱动的双态分支内联;IC3Demo 三态(Tri 加入)显示 virtual call——不内联走 vtable;flag: TraceCallFixup develop(globals.hpp:486)/ICMissHistogram notproduct(:1453);源码核对: generate_stubs 顺序/handle_ic_miss_helper :1552/DeoptimizationBlob 4 变体 codeBlob.hpp:558-562/generate_deopt_blob x86 层 :2810)
- `21-exception-handling-demo.txt`(-Xlog:exceptions=info 全链路: (A) 隐式 NPE 编译代码 "thrown [sharedRuntime.cpp, line 606]"+固定 throwing PC+"continuing at PC";(B) 显式 athrow try-catch 同 nmethod(handler 与抛点差 16 字节);(C) 隐式除零 SIGFPE→ArithmeticException;(D) 跨帧逃逸: 编译 escape→解释器 escapeMain at bci 8;(E) SOE 同一 oop 沿栈逐帧传播 24395 条;ExceptionDemo.java 五场景源)
- `25-gc-barrier-demo.txt`(-Xlog:gc+phases=debug 阶段树: Update RS/Scan RS/Evacuate,2 亿次老对象引用写后 Update RS 处理卡片(barrier 工作量在 GC 侧可见);PrintAssembly 无 hsdis nmethod header: C1 1248/1344 vs C2 576;flag 盘点: ReduceInitialCardMarks {C2 product} true/UseCondCardMark {product} false/UseG1GC ergonomic;标签可用性: gc+barrier/remset/phases 可用,gc+cardtable 无效;源码级: store_check 汇编 shr9+movb 0/g1_write_barrier_pre SATB 链/C2 IdealKit 同构;GcPhaseDemo/BarrierDemo.java)
- `15-c2-macro-demo.txt`(PrintInlining: System.arraycopy→"intrinsic"(0 字节 native 被替换)+lockElim(synchronized(new Object()) 锁消除候选)整体内联+Object.<init> 内联;CITime Macro Expand/Macro Eliminate 阶段;源码核对: expand_macro_nodes 编排/eliminate_locking_node/expand_lock_node fast-slow/expand_arraycopy_node+generate_arraycopy;flag: PrintEliminateLocks notproduct(c2_globals.hpp:508)/ReduceBulkZeroing product(:263))
- `15-c2-codegen-demo.txt`(CITime Code_Gen 阶段: Matcher/Scheduler/Regalloc/Block Ordering/Peephole/Build OOP maps/Code Installation;源码核对: MachNode::peephole 默认 NULL(machnode.cpp:415)、.ad 三文件行数 36815、addI 变体 x86_64.ad:7473-7519、Compile::Output output.cpp:57、do_global_code_motion gcm.cpp:1612;flag 类型: OptoPeephole develop_pd/PrintOptoPeephole notproduct)
- `15-c2-register-alloc-demo.txt`(CITime Regalloc 阶段树: RADemo.heavy 32 局部变量高寄存器压力——Regalloc 0.001s 下 Ctor Chaitin/Build IFG(virt+phys)/Compute Liveness/Regalloc Split/Postalloc Copy Rem/Fixup Spills/Coalesce 1-3/Simplify/Select;RA flag 类型: OptoCoalesce develop(c2_globals.hpp:244)/VerifyRegisterAllocator notproduct(:285)/VerifyGraphEdges notproduct(:276)/OptoRegScheduling+OptoBundling product_pd;heavy 编译事件 level 4)
- `15-c2-loops-demo.txt`(OSR 编译事件: LoopDemo2.run "1 % 3 run @ 6" 回边 bci;计算密集循环 C1 vs C2: level 3 慢 3.7 倍(9649 vs 2613ms);flag 拆分(-Xbatch reps=2000000): 默认 2410ms vs -XX:-UseSuperWord 3822ms(+59%) vs -XX:LoopUnrollLimit=1 4105ms(+70%);CITime IdealLoop 0.006s 占 Optimize 全部;flag 类型核对 UseSuperWord product/LoopStripMiningIter 默认 0/TraceSuperWord notproduct;短运行性能对照噪声 ±20% 不可靠的教训)
- `15-c2-optimizations-demo.txt`(EA 开关对照: EADemo 2 亿次循环 new Point 不逃逸——EA 开 0 次 GC 70ms vs -XX:-EliminateAllocations 关 6 次 GC Pause(570M/次)459ms 6.5 倍;sum 的 OSR 编译事件(1 % 3 @ 4 → 3 % 4 @ 4);javac 常量折叠 javap 证据: constCond if(1==1)→bipush 10 2 字节、mode 的 static final MODE=3 也被折成 x*2;flag 类型核对: DoEscapeAnalysis/EliminateAllocations product(c2_globals.hpp:527/:540)、PrintEliminateAllocations notproduct(:543))
- `15-c2-parse-graphkit-demo.txt`(PrintInlining 内联树三棵: ①C1 树——嵌套 90% 衰减,7 字节 d6 也 "callee is too large";②C2 树——16 层内联后第 17 层 d3 "inlining too deep"(MaxInlineLevel=15);③C2 高频树——139 字节 big "inline (hot)"(FreqInlineSize=325);编译事件: 每个 d* 方法被 C1 独立编译到 level 3;OSR 事件: OSRDemo "1 % 3 loop @ 5" % 标记+回边 bci+made not entrant)
- `46-sa-postmortem-demo.txt`(jhsdb 双模式实证: --pid 活进程 ptrace attach 成功(G1 23 threads/Heap Configuration/regions 7630);--core 离线解析 gcore 19GB core;jstack 解 Interpreted frame;attach 失败教训=目标进程已退出;SA 源码定位)
- `39-runtime-monitoring-timer-demo.txt`(jstat -class Loaded 1841/Bytes 3798.0 直接读 PerfCounter 无需 attach;gc+phases 四阶段毫秒(GCTraceTimeImpl);jcmd GC.run 触发 GC 成功——jcmd attach 容器可用修正;计时器家族定位)
- `36-attach-loadagent-demo.txt`(自 attach+loadAgentPath 加载自定义 JVMTI agent 全链路: Agent_OnAttach 收到 options='hello-attach'/返回 -1→AgentInitializationException rc=-1/properties 与 ManagementAgent.start_local 走 attach 通道/退出 Agent_OnUnload;需 -Djdk.attach.allowAttachSelf=true)
- `36-attach-trigger-demo.txt`(attach 触发链实证: touch .attach_pid+SIGQUIT→"Attach triggered" 日志+socket srw------- 0600 出现;无文件 kill -3=线程转储(信号二义);已初始化短路;转储含 "Attach Listener" #23 与 "Signal Dispatcher" #4;strace stat 证据;环境事实: 容器常驻 JMC/VisualVM 自动 attach 新 JVM(~1.6s)致"无信号也触发"假象,/tmp 堆积 .java_pid* 残留,os::get_temp_directory() Linux 写死 /tmp;jcmd 10500ms 超时更可能是目标进程已退出)
- `34-nmt-tracking-demo.txt`(NMTDemo summary 退出报告 82 行: Total reserved=18058807559/committed=1165695239,20 类,thread #18,"malloc=343389 #3287",tracking overhead=263488;detail 段: 虚拟内存区域+4 帧栈/malloc callsite 段 4 帧(PerfStringConstant 等)/线程栈 reserved 1048576+committed 8192 守卫页)备注: -XX:+PrintNMTStatistics 需先 -XX:+UnlockDiagnosticVMOptions(diagnostic flag)

**旧素材 19 个**(前会话): 08-bytecodes-javap / 08-interpreter-templates / 08-interpreter-counterdemo / 08-linkresolve-javap / 08-unsafe-demo / 08-whitebox-demo / 08-verifier-demo / 08-verificationtype-javap / 08-cds-demo / 08-cds-dump-full / 11-cds-load-demo / 12-ci-inlining-demo / 12-ci-typeflow-escape-demo / 12-ci-replay-demo / 13-jit-broker-demo / 13-jit-tiered-demo / 18-safepoint-demo / 18-safepoint-polling-demo / 20-vmops-demo

**引用纪律**: 工具实证必须真实存在——引用前 grep materials/ 验证;素材缺失的实证不要引用,改为布局推导。

---

## 六、本会话实战经验(最重要,新 AI 必读;6.1-6.51 旧会话沉淀,6.52-6.74 本会话 23 篇新沉淀)

### 6.0 本会话精华速查(新 AI 写 21-03 前必读)

**本会话覆盖**: 15-c2 域 8 篇全完结(C2 全管线: Ideal Graph/Parse/IGVN-CCP-EA/循环/Chaitin/Matcher/宏展开/intrinsic)+ 21-shared-runtime 2 篇(桩/c2i-i2c)。21-03(异常)是 21 域收官篇,之后的 25-gc 是第 6 批最大域。

**大纲漂移的六大高发类型**(15-c2+21 域 10 篇实测,共 148 处漂移,每篇 13-17 处——15-c2 八篇 13/15/13/17/15/15/14/17,21 域两篇 14/15):
1. **函数名编造**: do_load/do_arith/do_inline/add_node(02 篇)、add_constraint(04)、eliminate_locking_nodes→eliminate_locking_node 单数(07)、PhaseOutput(06)、MathIntrinsicNode(08)、generate_c2i_adapter→gen_c2i_adapter(21-02)——**大纲的函数名是不可信字段,一律 grep**
2. **行号全错**: handle_ic_miss_helper 1100-1300→1552、Simplify 200-330→1199、inline_string_indexOf 1000-1300→1294、generate_stubs 280-400→99——**大纲行号多是规划期估算,差几百行**
3. **机制编造(最严重)**: Ideal() 返回 this(01)、CCP 从 BOTTOM 逆风(03)、ArgEscape 转寄存器(03)、Strip Mining=主尾模型(04)、_hint_color(05)、peephole 消 mov(06)、CoarsenedLockNode cmpxchg(07)、nanoTime RDTSC(08)、push rbp 建帧(21-02)——**机制描述全部回源码验证**
4. **帧/汇编模型错位**: c2i adapter frameless(21-02)、OopMap 张冠李戴(21-02)、"栈溢出边缘不调 C++"是推断(21-01)
5. **归属错**: do_call 在 doCall.cpp 非 parse1.cpp(02)、find_callee_method 是入口帧场景(21-01)、intrinsic 触发在 Parse 期非 IGVN(08)
6. **数字无据**: c2i 200 条/i2c 40 条(21-02)、1 cycle(21-01)、5 cycles(08)、5-10% penalty(04)——**性能数字无源码依据一律删**

**深审第 3/4 轮的高发错误**(用户追加 REVIEW 时重点):
- **跨段遗留**(改了正文没改悬念): 32-03 的 4/8 字节、03 篇四步→五步同源错误出现 5 处——修正后全文 grep 同源表述
- **跨篇断言**: rep movsq(07,实际向量循环)、VDSO(08,39-02 未提)——**跨篇引用只保留目标篇实证过的内容**
- **flag 类型凭记忆**: TraceLoopOpts develop 非 notproduct(04)、UseSSE42Intrinsics 默认 false+ergonomics(08)
- **术语对齐**: megamorphic=vtable/itable(21-01 第 3 轮)、FALSE IC miss 与 icholder 呼应(21-01)

**HANDOFF §6 追加新节**: 已连续 9 次因"new 含旧节标题"导致新节插到标题前——**强制顺序**: 独立文本→## 七、前插入→grep -n "### 6.6" 校验→再做其他**

**实证工具箱**(本会话沉淀,release 可用的):
- PrintInlining(diagnostic)= 内联决策树/类型画像(双态 vs 三态)/intrinsic 标记——**虚调用与 intrinsic 的主观察窗**
- -Xlog:jit+compilation=debug(product)= 编译事件(OSR %/made not entrant)
- CITime(product)= 阶段树(Parse/Optimize 各子阶段/Matcher/Regalloc/Output)
- PrintCompilation+Verbose 不可用(Verbose 是 develop)
- EA 开关对照(EliminateAllocations product)= 标量替换量级实证(0 次 GC vs 6 次)
- 循环性能对照需 -Xbatch+超长运行(容器噪声 ±20%,短运行不可靠)
- 已探明的 flag 边界: PrintIdeal/PrintIdealGraph notproduct(拒启)、PrintOptoAssembly diagnostic 但 NOT_PRODUCT(静默)、TraceCallFixup/ICMissHistogram/TraceSuperWord 不可用



### 6.1 大纲漂移的规律(96 篇全部出现,2-15 处/篇;前会话沉淀 02/03/04/45/48/06/16/38/41/42/07/09/17/10/19/23/24/08/31/44/11/12/13/18 域,本会话沉淀 20/27/30/32 域)
**任何机制描述/行号/值/专有名词,一律当"线索"而非"事实"**。高频漂移类型:
1. **机制编造**(最严重): 大纲把"想当然的实现"写成机制——实证全部是编造
2. **版本漂移**: 大纲写的是 JDK 8/其他版本的机制(31-01 的 CAS 单路径是 JDK8 形态;30-03 的 field_get 是 JDK8 反射)
3. **行号漂移**: 大纲行号与实际差几十到几百行
4. **文件名漂移**: 目录/文件路径凭记忆必错(31 域目录 31-unsafe-whitebox;reflection.cpp 在 share/runtime;33-jmx 目录 33-jmx-management;32 域规划 6 篇非 4 篇)
5. **"声明有、实现无"**: 入口表里挂名的 ≠ 有实现(TRACE_REQUEST_COMMIT/jfrLeb128/jfrBinaryWriter/JfrThreadLocalBufferSize/JfrDCmd 等 grep 零命中)
6. **悬念指向错**: 大纲的"下一篇"常常过期(44-02 指 45 已完结;27/30/32 域大纲悬念多为规划期产物,按 writing-order 实际批次为准)

### 6.2 写作期"凭记忆"错误(自查 diff 抓出的真实案例,每篇深审必有)
- 08 域: "0xCB-0xFF 未分配区"错(实际 0xCB-0xEE 是 fast 系列);is_aload 点名原因错
- 31 域: "JRT_ENTRY"错(解释器是 IRT_ENTRY);"JFR 用 Forte"错
- 44 域: "i2b 推 Byte 类型"错;"pop 扣两槽"错
- 11 域: "link_and_serialize"不存在;classlist 行数无依据
- 27 域: jweak 对齐 8 字节错(weak_tag_alignment=2);"函数表查 env"表述
- 30 域: "dlsym 动态查找"错(编译期符号);Windows _64 表述(源码树无 windows);"函数表唯一读入口"过强
- 32 域: "4 字节 id"错(traceid=u8 8 字节);"长度头用 be_write"错(长度走变长编码);"每 N 字节采样"错(TLAB refill 粒度);"录制停止即追链"错(cutoff 门控)
- **教训**: 凡代码块里的值/编码/常量/注释,写完必须用 sed 逐行对照;数字先数后写;推导段("所以/为什么能")必须回源码找依据

### 6.3 写作期血泪(最高优先级)
- **记忆代码编造**: 44-02 的 check_end_stack、11-01 的 is_loading_success(自查脚本逐行 diff 当场抓出)——写代码块宁可多抄几行真实代码,绝不"凭记忆补全"
- **块标注范围反复错**: 用 python 脚本"内容跨度自动对齐"(从标注起点逐行匹配到块末行,输出真实终点行号)一次解决
- **反引号/星号配对**: 一个漏掉的反引号让全篇星号统计全乱;`JVM_*`/`jdk.*` 等通配符星号必须反引号包裹
- **跨段遗留**: 改了正文没改悬念(32-03 的 4/8 字节)——第 4 轮专门抓这类
- **实证工具**: jcmd attach 在当前容器不可用(超时 10500ms)——用 kill -3(SIGQUIT)线程转储或命令行 -Xlog;-verbose:jni(PrintJNIResolving)非 -Xlog:jni,resolve(JDK11 无此标签)

### 6.4 平台/环境事实(写作时已确认)
- **jdk11u 源码树只含 x86 平台**(cpu/ 只有 x86,os/ 只有 linux/posix)——不要断言其他平台的实现细节;Windows 细节无从验证
- 常用实证: **Temurin OpenJDK 11.0.32 在 /data/tmp/opencode/jdk11**(与 jdk11u 同版本,实证首选);Temurin 17 在 /data/tmp/opencode/jdk17(含 src.zip 验证 API 变迁);TencentKona 17/21 在 /opt/codev/
- **本会话关键源码位置**: 20 域: task.hpp/cpp(PeriodicTask 静态数组 10 槽,execute_if_pending 累加,task.cpp:49-78/80-92/110-154)/thread.cpp(WatcherThread :1367-1562,create_vm :3702-4091: vm_init_globals :3809/init_globals :3846/VMThread :3868-3888/周期任务 :4047-4055/WatcherThread :4066-4078)/init.cpp(vm_init_globals :90-98 7 步,init_globals :101-160 30 函数)/biasedLocking.cpp(EnableBiasedLockingTask :79-92,update_heuristics :321-372)/statSampler.cpp(StatSamplerTask :42-46)/arena.cpp(ChunkPoolCleaner :169-177);27 域: jniHandles.hpp/cpp/inline.hpp(make_local :52-87/make_global :101-122/make_weak_global :125-146/allocate_handle 四段 :481-546/rebuild :548-575/resolve_impl :52-66)/oopStorage.hpp/cpp(allocate :410-477,CAS release :575-587)/jniFastGetField_x86_64.cpp(投机 stub :56-138)/jniCheck.cpp(JNI_ENTRY_CHECKED :91-104/functionEnter :222-228/functionExit :239-252 泄漏检查/jni_functions_check :2304-2323)/jfieldIDWorkaround.hpp(BitsPerWord-2 偏移);30 域: jvm.cpp(JVM_CurrentTimeMillis :271/GetCallerClass :706/DefineClass :949/StartThread :2857/InvokeMethod :3571)/jvm.h(182 个 JNIEXPORT,三段注释 :38-55)/System.c(:39 注册表)/nativeLookup.cpp(pure_jni_name :165/特殊表 :228-238/lookup_style :253 分流/ClassLoader.findNative :277-285)/javaCalls.cpp(call_helper :346-475 十步/JavaCallWrapper :54-154)/reflection.cpp(invoke_method :1257/invoke :1072-1255 五段)/stackwalk.cpp(fill_in_frames :108-145 is_hidden 过滤)/StackStreamFactory.java(批大小 :545-556);32 域: jfrThreadLocal.hpp(双 buffer :39-40)/jfrStorage.cpp(flush :480-559)/jfrRecorderThreadLoop.cpp(消息循环 :40-86)/jfrChunkWriter.cpp(open :54-70/write_header :95-107)/jfrEncoders.hpp(Varint128 :159-210)/jfrWriterHost.inline.hpp(write 分派 :84-89/be_write :118/utf8 :92-100/事件大小槽 jfrEventWriterHost.inline.hpp :56-76)/jfrEventClassTransformer.cpp(on_klass_creation :1515/5 方法壳 :120-145)/jfrPeriodic.cpp(45 个 TRACE_REQUEST_FUNC)/RequestEngine.java(execute :66-85/doPeriodic :184)/objectSampler.cpp(sample :138-153/add :155-199/span :167)/pathToGcRootsOperation.cpp(doit :81-131/EdgeQueue 5% :59-63/BFS-DFS :112-124)/objectSampleCheckpoint.cpp(write :398-409)/leakProfiler.cpp(start :41-77)
- **JDK 侧**: jdk.jfr/internal(MetadataRepository.java:66-86/EventClassBuilder.java:45/EventInstrumentation.java:60/RequestEngine.java/Options.java:44-46);jdk.jfr 资源 metadata.xml(Copy-jdk.jfr.gmk);jfc 配置(default.jfc ExecutionSample 20ms/profile 10ms;OldObjectSample cutoff=0ns)
- **本会话关键源码位置补(34 域)**: mallocTracker.hpp(MallocHeader 位域 :246-302/MallocMemorySummary :187-237)/mallocSiteTable.hpp/cpp(511 桶 :118-122,lookup_or_add :142-185,静态表+伪栈防递归 :75-113/:201-205,AccessLock :128-166/cpp:243-265)/memTracker.hpp/cpp(CURRENT_PC/CALLER_PC :88-91,init_tracking_level :58-96 环境变量 NMT_LEVEL_<pid>,transition_to 只降不升 :164-184)/nmtCommon.hpp(四档 :35-41,栈深 4 :45)/allocation.hpp(MEMFLAGS 20 类 :114-141)/nativeCallStack.cpp(采集 :33-56,hash :83-95)/os_posix.cpp(get_native_stack 帧指针链 :120-140)/virtualMemoryTracker.cpp(add_reserved_region :332-392/remove_released_region 切割 :437-488/snapshot_thread_stacks :566-569)/java.c(launcher SetJvmEnvironment :825-880,调用点 :303 在 LoadJavaVM 前)/os.cpp(malloc :685-742/free :801-821/reserve_memory :1759-1790)
- **本会话关键源码位置补(36 域)**: attachListener.cpp(操作函数表 10 个 :324-336/jcmd=DCmd::parse_and_execute(arg(0)) :200-212/init 创建线程 :423-475/attach_listener_thread_entry :344-406)/attachListener_linux.cpp(懒启动 init_at_startup :520-526/vm_start 清残留 :460-476/is_init_trigger 文件触发+uid 防伪 :530-560/socket .tmp bind+rename :181-241/SO_PEERCRED :346-383/NUL 分隔协议 read_request :249-338/complete :408-434)/os.cpp(SIGBREAK 信号二义 :341-389)/jdk.attach(VirtualMachineImpl.java 客户端握手 :54-123+execute NUL 协议 :145-231/HotSpotVirtualMachine.java 自 attach 门控 :56-57/:72-76+loadAgentLibrary :86-111+loadAgent=instrument :135-172)/jvmtiExport.cpp(load_agent_library :2638-2722/dlsym Agent_OnAttach)/jvm_md.h(AGENT_ONLOAD/ATTACH 符号 :43/:45)
- **本会话关键源码位置补(37 域)**: heapDumper.cpp(HeapDumper::dump :1931-1984/VM_HeapDumper :1477 起 doit :1775-1806/work :1809-1894 十一步产出/dump_class_and_array_classes :994-1033 CLASS_DUMP 无 serial/dump_instance :969-987/dump_object_array :1145-1159/dump_prim_array :1179-1193/write_objectID=地址 :526-533/write_classID=java mirror :553-555/start_sub_record :575-603 段头动态回填/HEAP_DUMP_SEGMENT=0x1C END=0x2C :307-342)/heapDumperCompression.cpp(load_gzip_func dlsym libzip :77-91/compress :121-139 HPROF BLOCKSIZE 注释 :125-132/CompressionBackend get_new_buffer :381-444/thread_loop :277-303/finish_work 按 id 写 :461-482)/gcTraceTime.hpp(GCTraceTimeImpl :46-65)/diagnosticCommand.cpp(HeapDumpDCmd :510-544,注册 :92)/debug.cpp(report_java_out_of_memory cmpxchg 只报一次 :322-337)/collectedHeap.cpp(full_gc_dump :514-528)/classLoadingService.cpp(notify_class_loaded :148-166)
- **本会话关键源码位置补(39 域)**: serviceThread.cpp(service_thread_entry :84-143 5 条件检测 :105-109/enqueue_deferred_event :145-153/oops_do 保活 :155-179/initialize NearMaxPriority :74)/gcNotifier.cpp(pushNotification→addRequest notify :45-64/sendNotification 清异常 :165-172)/stringTable.cpp(trigger_concurrent_work :226-230/check_concurrent_work :520-535/concurrent_work :539-549)/memoryManager.cpp(gc_end pushNotification :295)/lowMemoryDetector.cpp(has_pending_requests :41-51)/timer.hpp(elapsedTimer :32-50/TimeStamp :53-73/TraceCPUTime :75-90)/timerTrace.hpp(TraceTime 独立文件 :46+,日志框架输出 TRACETIME_LOG :57-59)/os_linux.cpp(elapsed_counter :1435-1437=CLOCK_MONOTONIC javaTimeNanos :1555-1569,dlsym :1489-1491)/runtimeService.hpp(PerfCounter+TimeStamp :34-51)/threadService.hpp(原子计数 :53-101)
- **本会话关键源码位置补(46 域)**: jdk.hotspot.agent/linux/native/libsaproc/(ps_core.c add_map_info 链表 prepend :124-134/core_lookup 二分 :153-175/sort_map_array qsort :382-421/core_read_data pread :431-465/class_share_maps 兜底 :189-200;ps_proc.c process_read_data 8 字节三段式 :66-116/ptrace_attach :275-292/Pgrab :450;symtab.c build_symtab_internal :329+ 默认 DYNSYM 优先 SYMTAB/hcreate_r 哈希 :416-432/search_symbol :569-587/debuglink :261/build-id :305;LinuxDebuggerLocal.c attach0 :251/verifyBitness :196-210;libproc_impl.c lookup_symbol 全局搜 :215-238)
- **本会话关键源码位置补(14-c1 域)**: c1_Compiler.cpp(Compiler::compile_method 只构造 Compilation :246)/c1_Compilation.cpp(compile_method :429/compile_java_method :370-405/build_hir :141-258/emit_lir :252-278/install_code :410)/c1_GraphBuilder.cpp(4428 行: BlockListBuilder make_block_at :152+/append_with_bci :2299-2352(Canonicalizer 即时 :2300-2302+LVN :2308-2319+bailout :2328)/load_local :935-940 零成本/If :1227/Goto :1208/Return :1599/Throw :2275/invoke :1841)/c1_Instruction.hpp(LEAF/BRANCH 宏: Phi :641/Local :697/Constant :724/ArithmeticOp :1060/Invoke :1243/NewInstance :1292/BlockBegin :1601/Goto :1859/If :1970/Return :2149/Throw :2171/Base :2190/HASHING 宏 :243-271)/c1_ValueStack.cpp(setup_phi :178-191)/c1_Canonicalizer.cpp(do_Op2 三段 :77-180+/do_If :712+/imul 幂转移位 :960-977)/c1_ValueMap.cpp(find_insert :109-149 跨块 pin :130-136)/c1_Optimizer.cpp(eliminate_null_checks :1155/NullCheckEliminator :553)/c1_RangeCheckElimination.cpp(eliminate :46 has_access_indexed :47)/c1_LinearScan.cpp(6800 行: do_linear_scan :3100-3130/allocate_registers :1656-1690/activate_current :5792-5855/find_locked_reg use_pos 最晚 :5504-5524/split_for_spilling :5227/EdgeMoveOptimizer :5861)/c1_LinearScan.hpp(Interval=Range 链表 :455-470/:501+)/c1_LIRAssembler.cpp(emit_code :214/emit_lir_list :268/emit_op0/1/2 :598/:504/:695)/c1_Runtime1.cpp(JRT_ENTRY 家族: new_instance :346-359(Klass*+set_vm_result)/monitorenter :693-704→SharedRuntime 助手/monitorexit JRT_LEAF :706-716/patch_code :834/:1271/generate_blob :194)/c1_Runtime1.hpp(RUNTIME1_STUBS 宏 :40-65+)/c1_FrameMap.cpp(构造 :156/framesize :190-191)/c1_FrameMap_x86.cpp(initialize :160-206 rax=3/rbx=2/caller_save :203-206)/c1_LIRAssembler_x86.cpp(peephole 空实现 :3994)
- **本会话关键源码位置补(15-c2 域)**: node.hpp(Node 类 :210,_in/_out :282-283,_cnt/_max :291/:293,arena new/delete NOP :231-240,Opcode :786,DEFINE_CLASS_QUERY :792-800,flags 枚举 :736-757,三个钩子 :977-986)/node.cpp(Ideal 默认+铁律注释 :1091-1146,Identity 默认 :1081-1083,Value 默认 :1087-1089,Node 构造 :320+,Init :294)/type.hpp(Type :74,TYPES 枚举 :78-118,TOP/BOTTOM :412-421,meet :224-226,xmeet :241,dual :236-238,TypeInt :537,TypePtr :813,NULL_PTR/NOTNULL :918-919,TypeFunc 槽 :1519-1525)/type.cpp(TypeInt::make hashcons :1429-1449/hashcons :707-745/xmeet "Expand covered set" :1487-1489/xdual 翻转 :1494-1497/ptr_meet 表 :2460-2468/ptr_dual :2572-2574/不同类 LCA :3977-3986/不同常量 NotNull :3963-3972)/phaseX.cpp(PhaseIterGVN ctor for_igvn :992-993/hash_find_insert :143-198/apply_ideal :838/apply_identity :846/transform_no_reclaim 单遍 :864-924/optimize 主循环 :1223-1251/transform_old 五步 :1283-1402/remove_globally_dead_node :1413/subsume_node :1527/add_users_to_worklist :1611-1620)/phaseX.hpp(NodeHash :53-117,insert_limit 75% :82-83,PhaseValues _table :375,PhaseIterGVN :451-583)/compile.cpp(Optimize :2220,IGVN 6 处 :2247-2254/:2321/:2332/:2388-2391/:2424/:2454,for_igvn 注释 :757,Parse 用 PhaseGVN :764,PrintIdeal dump :884-899,PrintOptoAssembly NOT_PRODUCT :718-733)/compile.hpp(node_arena :452/type_arena :481/record_for_igvn :1078)/addnode.hpp(AddNode Node(0,in1,in2) :44)/addnode.cpp(AddNode::Identity :56-61/hash 交换律 :50-52/Ideal 常数下沉 :111-203)/mulnode.cpp(MulNode::Identity :52-61)/cfgnode.cpp(PhiNode::Value :918-1009)/memnode.hpp(MemNode 槽枚举 :52-58)/opcodes.hpp(枚举由 classes.hpp 生成 :31-49)/parse1.cpp(build_start_state :813/ParmNode transform :831/merge_common Region :1659-1665/Phi ensure_phi :1744-1745/phi set_req :1756-1772)/parse2.cpp(iadd :2250-2253/do_ifnull :1448-1526)/parse3.cpp(do_get_xxx :144-210)/graphKit.cpp(make_load ctl+mem+adr :1514-1540)/connode.hpp(ConNode :37)/c2_globals.hpp(PrintIdeal notproduct :101/PrintOptoAssembly diagnostic :147/PrintInlining diagnostic :657/PrintIdealGraph notproduct :371-391/NodeLimitFudgeFactor :471)/globalDefinitions.hpp(K=1024 :255)/phasetype.hpp(阶段枚举 :28-63)/loopnode.hpp(sea of nodes :992)/domgraph.cpp(sea of nodes :386)/loopopts.cpp("no control edge can float" :1379);02 篇: parse1.cpp(Parse ctor :390/_flow=get_flow_analysis :427/do_all_blocks RPO :632-733/do_one_block :1465/do_one_bytecode 调用 :1529/return_values :860/do_method_entry :1183-1226/dtrace+FastLock shared_lock :1216/计数器 :1223-1225/add_safepoint 四件事 :2234-2309/去重 :2246-2251/内存克隆 :2273-2275/轮询地址 :2286-2296/root prec :2305-2308/do_exceptions 双路 :905-932/throw_to_exit :938/catch_inline_exceptions :926/merge_common Region :1659-1665/Phi ensure_phi :1744-1745/OSR load_interpreter_state :570-574/OSR tf :521)/parse2.cpp(do_one_bytecode switch :1907/iload push(local) :2014-2033/iadd :2250-2253/do_ifnull :1449/do_if :1529/invoke→do_call :2799-2805)/parse3.cpp(do_field_access :76/do_get_xxx :144)/doCall.cpp(do_call :423-1142/call_generator :65-220/intrinsic :118/MH :141-152/ok_to_inline 调用 :165-177/dec_sp+sync_jvms :548-549/cg->generate :593/返回值已入栈 :620)/callGenerator.cpp(ParseGenerator :64-111/for_inline :263-266/DirectCallGenerator :133+)/bytecodeInfo.cpp(should_inline :115-200/高频 bump :170-182/冷点已编译检查 :183-190/too big :191-198/深度检查 :400-407/递归 :436-439/build_inline_tree_for_callee :644-674/ok_to_inline :547)/parse.hpp(inline_level=stack_depth :96-97/maybe_add_safepoint :493-497)/graphKit.hpp(GraphKit :58/_map :64/gvn() PhaseGVN& :93/control/i_o :471-472/memory :489-491)/graphKit.cpp(memory(alias_idx) :1477-1482/set_all_memory :1493-1497/make_load ctl+mem+adr :1514-1534/store_to_memory+set_memory :1542-1578/add_safepoint_edges :842)/callnode.hpp(JVMState :194-293 槽位布局 :230-238/StartNode :65/StartOSRNode :91-98/ParmNode :101-106/SafePointNode :323+/_oop_map :337/ReturnNode :122)/memnode.hpp(MergeMemNode :1403/memory_at/set_memory_at :1423-1430/base_memory :1432-1433/empty_memory :1436)/buildOopMap.cpp(注释 "after all scheduling" :39/BuildOopMaps :566/Compile::BuildOopMaps)/compile.cpp(Optimize 调用 :874/PhaseRemoveUseless :841-844/StartNode :786-790/build_start_state 调用 :793/call_generator 初始 :799-801)/globals.hpp(MaxInlineSize :1710/MaxInlineLevel :1692/MaxRecursiveInlineLevel :1698/MaxTrivialSize :1720/MinInliningThreshold :1722/InlineSmallCode :1705)/c2_globals_x86.hpp(FreqInlineSize :47)/c1_globals.hpp(NestedInliningSizeRatio :177)/c1_GraphBuilder.cpp(嵌套衰减 :700-705/深度大小检查 :3801-3803);03 篇: phaseX.cpp(PhaseCCP 构造 :1812-1818(Wegman & Zadeck 注释 :1811)/analyze 全 TOP 乐观 :1847-1957/ccp_type_widens :1830-1831/do_transform :1984-1989/transform 从 root+safepoint 克隆 :1994-2039/transform_once 常量+Region 切割 :2043-2113/saturate :2116-2124)/ifnode.cpp(IfNode::Value :51-67 ZERO→IFFALSE/ONE→IFTRUE)/multnode.cpp(ProjNode::Value=proj_type :158-161)/escape.hpp(设计注释+JavaObject 清单 :85-107/EscapeState 枚举 :153-161/PointsToNode :131-200)/escape.cpp(do_analysis :97-116/compute_escape 五步 :118-343/add_node_to_connection_graph :367-1000+/add_final_edges :202-206/complete_connection_graph :1220+/find_non_escaped_objects :1235 传播/adjust_scalar_replaceable_state :1757/optimize_ideal_graph :1980/split_unique_types :3058,AliasLevel>=3 门控 :321/LocalVar 映射 :3223-3232)/macro.cpp(eliminate_macro_nodes :2567-2641/eliminate_allocate_node 四道门 :1091-1156/can_eliminate_allocation :1114/scalar_replacement :759/process_users_of_allocation store 删除 :946-1010/eliminate_gc_barrier :967/expand_macro_nodes :2645+)/compile.cpp(EA 编排 :2307-2337: do_analysis :2316/igvn.optimize :2321/eliminate_macro_nodes :2328-2333;CCP :2375-2391)/c2_globals.hpp(DoEscapeAnalysis :527/EliminateAllocations :540/PrintEliminateAllocations :543/TracePhaseCCP :632/EliminateLocks :493);04 篇: loopnode.cpp(PhaseIdealLoop::build_and_optimize :3062-3431+/is_counted_loop :372-500/build_loop_tree :3810/counted_loop :3220/insert_loop_limit_check :327/beautify_loops :3154/Dominators :3180/reassociate :3302/policy_range_check 标记 :3321-3323)/loopTransform.cpp(iteration_split :3420/iteration_split_impl :3273/do_one_iteration_loop :3283/do_remove_empty_loop :3287/partial_peel :3296/do_peeling :588/policy_unswitching :3303/do_unswitching loopUnswitch.cpp/policy_maximally_unroll :3326/policy_unroll :759 factor=4 :782/policy_range_check :3350/insert_pre_post_loops :1396/do_unroll :1910 limit 调整 :1942-1984/update_main_loop_skeleton_predicates :1972/do_range_check :2520)/loopPredicate.cpp(loop_predication :1505/loop_predication_impl :1329)/loopnode.hpp(OuterStripMinedLoopNode :441/skip_strip_mined :303)/superword.cpp(transform_loop :97-191 门控: vector_width_in_bytes :100/find_pre_loop_end :153-164/slp_max_unroll :125/SLP_extract :450/construct_bb :2793/dependence_graph/combine_packs :1552/output :2282/align_initial_loop_index :2298/unrolling_analysis :194)/x86.ad(loadV4→movd :3034/loadV16→movdqu :3098/vadd2I→paddd-vpaddd :6325-6345)/c2_globals.hpp(UseSuperWord :333 product/LoopMaxUnroll :179/LoopStripMiningIter :755 默认 0/UseLoopPredicate :222/PartialPeelLoop :308)/c2_globals_x86.hpp(LoopUnrollLimit :55 AMD64=60/SuperWordLoopUnrollAnalysis :84);05 篇: chaitin.cpp(Register_Allocate :336-570+ 编排: de_ssa :373/gather_lrg_masks+live :386-387/stretch_base_pointer :397/build_ifg_virtual :409/aggressive coalesce :425-426+insert_copies :429/build_ifg_physical :450/must_spill 预分裂 :462/Simplify :1199-1310+ 低度入栈 :1206-1261+score 选候选 :1266-1274/Select :1447-1541+ re_insert :1469+SUBTRACT :1503+choose_color :1529+chunk 滚动 :1538-1541/spill-split-recycle :522-570 trip_cnt 24/27 :523-529/compact :542/raw_score :99/score :103-113)/chaitin.hpp(LRG :50-67:_cost :56/_area :57/score() :58/_risk_bias :66/_copy_bias :67/bias_color :689)/ifg.cpp(build_ifg_virtual 逆向扫描 :311-333/Copy 不干涉 :350-352/interfere_with_live :291/build_ifg_physical+Pressure :821-836)/coalesce.cpp(coalesce_driver :128-134 按块频率/aggressive coalesce :447/conservative :798/insert_copies :213)/reg_split.cpp(Split :496/split_DEF :148/split_USE :190/split_Rematerialize :318)/live.cpp(PhaseLive :395 行)/regalloc.cpp(130 行入口)/c2_globals.hpp(OptoCoalesce develop :244/VerifyRegisterAllocator notproduct :285)/c2_globals_x86.hpp(INTPRESSURE :51=13/FLOATPRESSURE :52);06 篇: matcher.cpp(Matcher::match :176-385+ 流程: find_shared :310/新旧空间 :322/xform 递归 :343-345/xform :979/match_tree :1359-1428 最小 cost 匹配 :1386-1394/ReduceInst :1653/ReduceInst_Chain_Rule :1767/soft_match_failure)/output.cpp(Compile::Output :57/MachPrologNode :71-77/emit 循环 n->emit(*cb,_regalloc) :1394)/gcm.cpp(do_global_code_motion :1612-1630/estimate_block_frequency :1625 uncommon trap 压低 :1629-1636/global_code_motion :1458/schedule_early :308/schedule_late :1280)/machnode.cpp(MachNode::peephole 默认 NULL :415-417)/phaseX.cpp(PhasePeephole 框架 :2140-2159 do_transform)/block.cpp(PhaseBlockLayout Trace :871+)/compile.cpp(Code_Gen 编排 :2476-2580: matcher.match :2489-2497/PhaseCFG GCM :2514-2518/Chaitin :2523-2533/块排序 :2535-2544/Peephole :2546-2550/postalloc_expand :2552-2555/Output :2557-2560)/x86_64.ad(addI_rReg :7473/imm :7484/mem ins_cost(125) :7495/mem_rReg :7507/mem_imm :7519)/x86.ad(9834 行共享指令)/x86_32.ad(13656 行)/share/adlc(GensrcAdlc.gmk 构建 adlc;dfa.cpp DFA_PRODUCTION 生成;ad_x86_64.cpp 生成物不在源码树)/c2_globals.hpp(OptoPeephole develop_pd :150/PrintOptoPeephole notproduct :162)/c2_globals_x86.hpp(OptoPeephole :79 默认 true);07 篇: macro.cpp(expand_macro_nodes :2645-2778: 最后消除 :2647/节点预算 macro_count*300 :2653/Opaque1-2 LoopLimit MaxL-MinL→CMoveL OuterStripMinedLoop 清理 :2656-2721/arraycopy 先行 :2723-2740 注释 "For ReduceBulkZeroing...before the allocate nodes are expanded"/主循环 :2744-2771/IGVN+BarrierSet 收尾 :2773-2777;eliminate_allocate_node :1091/scalar_replacement :759/process_users_of_allocation :946/expand_allocate :1981/expand_allocate_common :1286-1355+ fast-slow Region+initial_slow_test(dtrace/!UseTLAB 强制慢 :1321-1326)/expand_allocate_array :1987/eliminate_locking_node :2182-2255/MemBarAcquire-ReleaseLock 删除 :2223-2250/expand_lock_node :2259-2266 fast_lock_region+slow_path/mark_eliminated_locking_nodes :2577/expand_unlock_node :2497)/macroArrayCopy.cpp(expand_arraycopy_node :1106+形态分派 clonebasic/copyof-cloneoop/generate_arraycopy :278+编译期检查 :1154-1157)/callnode.hpp(SafePointScalarObjectNode :492-503 _first_index/_n_fields)/c2_globals.hpp(PrintEliminateLocks notproduct :508/EliminateLocks product :493/ReduceBulkZeroing product :263)/compile.cpp(macroExpand 调用 :2432-2440);08 篇: library_call.cpp(LibraryCallKit :94/try_to_inline 巨型 switch :519-608+/inline_string_indexOf :1294/make_indexOf_node :1323/make_string_method_node :1114 Op_StrIndexOf/inline_string_equals :1160/inline_string_compareTo :1139/inline_hasNegatives :1221/inline_math_native :1873-1960+ runtime_math(StubRoutines::dsin 优先/SharedRuntime 兜底)/pow(2.0)→x*x :1908-1914/sqrt-abs-ceil match_rule_supported :1913-1918/inline_unsafe_allocate :2870-2895 new_instance 不调构造器/inline_native_currentThread :2991/generate_current_thread :1093-1103 ThreadLocalNode/inline_native_time_funcs :772 os::javaTimeNanos/inline_unsafe_load_store :2638/compareAndSet→LS_cmp_swap :703/make_vm_intrinsic :350)/vmSymbols.hpp(VM_INTRINSICS_DO 326 条 do_intrinsic/class vmIntrinsics :1567/do_intrinsic(_dsin, java_lang_Math) :778/LAST_COMPILER_INLINE :1582)/compile.cpp(find_intrinsic :150-163 缓存)/globals_x86.hpp(UseSSE42Intrinsics 默认 false :208)/vm_version_x86.cpp(FLAG_SET_DEFAULT true :1216-1217)/macroAssembler_x86_sin.cpp(fast_sin :381)/macroAssembler_x86.cpp(string_indexofC8 :6030+pcmpestri 注释 :6038/pcmpestri :3852)/macroAssembler_x86.hpp(r15_thread 注释 :290)/c2_globals.hpp(PrintIntrinsics diagnostic :657);21-01 篇: sharedRuntime.cpp(generate_stubs :99-123: 3 wrong/ic_miss resolve_blob :100-102+3 resolve :103-105+polling 3 变体 :108-116+deopt :118+uncommon_trap COMPILER2 :121/handle_wrong_method_ic_miss :1421-1440 JRT_BLOCK_ENTRY+set_vm_result_2+verified_code_entry/handle_ic_miss_helper :1552-1641+: find_callee_info :1559/reresolve_call_site 静态绑定 :1571-1583/CompiledIC_lock 修补 :1617+/is_optimized :1625/is_icholder_call :1633/find_callee_method(入口帧场景) :1213)/sharedRuntime.hpp(静态成员 :57-68/handle_ic_miss_helper 声明 :335)/codeBlob.hpp(DeoptimizationBlob :554-583: 4 个 unpack 偏移 :558-562)/sharedRuntime_x86_64.cpp(generate_deopt_blob :2810)/globals.hpp(TraceCallFixup develop :486/ICMissHistogram notproduct :1453);21-02 篇: sharedRuntime_x86_64.cpp(gen_c2i_adapter :585-731: patch_callers_callsite :596/栈布局输入 :603/extraspace :606-614/senderSP r13 :619/尾部 interpreter_entry_offset+jmp :716-717/gen_i2c_adapter :733-842+: frameless 注释 :748-763/r13 senderSP :739/VerifyAdapterCalls :768-793/16 字节对齐 :816/from_compiled_offset :828/generate_i2c2i_adapters :943-992: i2c_entry :949/c2i_unverified_entry :962-984 holder 检查+编译检查/c2i_entry :986/AdapterHandlerLibrary::new_entry fingerprint :991/c_calling_convention :994+: c_rarg0-5 :1011-1013/c_farg0-7 :1014-1017/栈参数 2 VMReg :1040-1041/OopMap 只在 save_live_registers :157 与 native wrapper :1159)/method.hpp(from_compiled_offset :697/from_interpreted_offset :709)/abstractInterpreter.hpp(stackElementSize :236=8 字节)

### 6.5 实证方法论新增(本会话沉淀)
- **JNI 系列**: 自写 JNI demo(gcc -shared -fPIC -I$JAVA_HOME/include);printf 要 fflush(stdout)(重定向全缓冲丢输出);GetObjectRefType 常量 1/2/3;jobject 参数是 local ref(传回 Java 再传回变 refType=1)
- **性能对照**: -XX:-UseFastJNIAccessors 开关,2000 万次 GetIntField 快 1.4ns vs 慢 15ns(10 倍)
- **-Xcheck:jni**: 泄漏警告每 32 个(33/66/99);挂起异常警告;无 flag 对照 0 警告
- **-verbose:jni**: [Dynamic-linking] vs [Registering] 对照(注册链实证)
- **nm 实证**: libjava.so/libjvm.so 的导出/UND 符号(JVM_* 174/jio_* 5/Java_ 207/U 131)
- **StackWalker**: SHOW_HIDDEN_FRAMES 亮反射帧;-Xlog:stackwalk=debug 证明过滤位置
- **JFR**: -XX:StartFlightRecording=filename=...,settings=profile;xxd 文件头;bin/jfr summary/print(--events 需 filter 参数;--xml);-Xlog:jfr+system=info(注意 -Xlog 尾逗号语法错误)
- **jcmd attach 可用性(36/39 域修正)**: 早期"容器 attach 超时"结论已两次修正——①34-nmt 会话失败更可能是目标进程已退出(NMTDemo 3 秒即结束)或 /proc 路径;jcmd 失败报 "Unable to open socket file /proc/<pid>/root/tmp/.java_pid<pid> ... 10500ms";②**attach listener 启动后 jcmd 直接可用**(36 域触发实证),39 域实测 `jcmd <pid> GC.run` 成功("Command executed successfully");容器常驻 JMC/VisualVM 会自动 attach 新 JVM(~1.6s)导致"无信号也触发"假象
- **自 attach 实证路径**: `-Djdk.attach.allowAttachSelf=true` 可自 attach(36-attach/02 全链路 loadAgent 实证;HotSpotVirtualMachine.java:74-76 门控);executeJCmd 需 --add-exports jdk.attach/sun.tools.attach=ALL-UNNAMED + cast HotSpotVirtualMachine
- **jstat 免 attach**: 直接读 hsperf 文件(jstat -class 显示 ClassLoadingService PerfCounter)
- **PrintIR/PrintLIR/PrintCFG 是 notproduct**(release 无);HIR/LIR 图只能源码推演;PrintAssembly 无 hsdis 只输出 nmethod header(main code/stub code/oops/metadata 尺寸);C1 优化 flag 多数 develop(RangeCheckElimination 是 product 可开关)
- **jhsdb 双模式**(46 域): --pid 活进程 ptrace attach(目标必须活着);--core 离线解析(gcore 生成 core,容器 core_pattern=core)
- **SIGQUIT(kill -3)线程转储替代 jcmd** 仍是通用实证手段

### 6.6-6.20 旧会话经验(06/16/38/41/42/07/09/17/10/19/23/24 域)——略,详见 git 历史

### 6.21 08-01(Bytecode 定义表,大纲 11 处漂移含 3 处机制编造,2026-08-13)
- **"5 个静态数组含 format 表" 错**: 6 个数组(_name/_result_type/_depth/_lengths/_java_code/_flags,bytecodes.hpp:339-346),**无 _format 数组**——format 由 compute_flags(:206-276)预编译成位掩码;_lengths 一字节两用(低 4 位短长/高 4 位 wide 长,:397-398);_flags 512 槽双页(:345,432-435)
- **"def 宏展开" 错**: C++ 静态函数 7/8 参数(code,name,format,wide_format,result_type,depth,can_trap[,java_code]);239 条 def 启动一次填充(.bss 非 .data)
- **"Format: b=1B signed/j=4B branch offset" 全错**: b=opcode 本身、c=signed constant、i=local index、**j=2B CP cache index**、k=CP index、o=branch offset;大写=原生字节序(实际只有 J 出现,:244);长度=format 字符数;变长 format=""
- **"256 条(255=impdep2)" 错**: 枚举 203 成员(0x00-0xCA,含保留 wide/breakpoint)+36 私有=239;0xEF-0xFF 17 个未定义;load/store 50 条非 ~60
- **"upper 4 bits 分组" 编造**: 段布局是规范历史安排;HotSpot 分组=区间谓词(is_aload 枚举不连续等),消费者 verifier.cpp:754/templateInterpreter.cpp:254/deoptimization.cpp:705-722
- **"can_trap 用于 loop optimization" 编造**: 真实=GenerateOopMap::do_exception_edge(generateOopMap.cpp:1178);C1 自建 _can_trap 表(c1_GraphBuilder.cpp:2976-3034)
- **"stack_effect/_unknown_depth" 编造**: 不存在;depth 恒静态(invoke 系 -1);T_ILLEGAL 表达"栈顶类型由上下文决定"
- **变长仅三条**: wide/tableswitch/lookupswitch(special_length_at :90-137);breakpoint 走 raw_special_length_at(:151-158)
- 实证: 08-bytecodes-javap.txt

### 6.22 08-02(Template Interpreter,大纲 11 处漂移含 3 处机制编造 + 第 3 轮 REVIEW,2026-08-13)
- **"generate_all 三步" 错**: 真实十一段(templateInterpreterGenerator.cpp:57-263)
- **寄存器错**: x86_64 下 rlocals=r14、rbcp=r13(templateTable_x86.cpp:46-47);dispatch=lea+jmp [table+rbx*8](interp_masm_x86.cpp:826-846)
- **"iload_0 模板 push(rax)+advance" 错**: 生成器=iload(int n)(templateTable_x86.cpp:878-881)仅 3 行;advance/dispatch 由 generate_and_dispatch 统一(:377-401)
- **实证尺寸**: iload_0=96B vs iload=192B;iconst 7 个全 96B;iadd 64B;ldc 736B;invokevirtual 1280B;271 codelets avg 404B
- **入口点家族**: DispatchTable::_table[10][256];set_short_entry_points 序言(:345-362);set_vtos_entry_points 压栈序言(x86:1765-1794);tosca=栈顶留寄存器(globalDefinitions.hpp:819-832)
- **safepoint 轮询内联**: dispatch_base 每字节码 testb(:826-834);notice_safepoints **整表拷贝**(copy_table,templateInterpreter.cpp:293-325)
- **第 3 轮**: wide 链=_wide 模板 jump _wentry_point(:4504-4510);iadd=pop_i+addl(iop2 :1337-1340);deopt 三态;字节码表初始化=bytecodes_init(init.cpp:104)

### 6.23 08-03(InterpreterRuntime,大纲 8 处漂移含 3 处机制编造 + 第 3 轮 REVIEW,2026-08-13)
- **"JRT_ENTRY" 错**: 解释器 runtime 用 **IRT_ENTRY 家族**(interfaceSupport.inline.hpp:445-466);JRT 是 JNI 通道(:468)
- **"OopMapCache LRU" 编造**: 固定 32 槽哈希+3 步探测(oopMapCache.hpp:149-151),无 LRU
- **"递减到 0" 错**: 递增到阈值(count_grain=8);JDK11 默认 Tier3=2000/Tier4=15000/Tier2=0,CompileThreshold=10000,InterpreterProfilePercentage=33
- **计数器机械**: generate_counter_incr(templateInterpreterGenerator_x86.cpp:385-440) tiered 用 increment_mask_and_jump 掩码节流;回边仅向后分支(:2191-2200);OSR 成功先 revoke 有偏锁(:1072-1094)
- **模板侧 call_VM 链**: interp_masm call_VM_base(interp_masm_x86.cpp:282-306)→macroAssembler(:2482-2550): c_rarg0=r15_thread、set_last_Java_frame **不写 anchor pc**(:799-802)、check_exceptions→forward_exception_entry(:2556-2568)、尾部 get_vm_result 读回(:2572-2574)
- **第 3 轮**: safepoint 检查在 ThreadStateTransition::transition 内(interfaceSupport.inline.hpp:111-123);increment_mask_and_jump=+8 写回→andl(mask)→jcc(:1956-1967);入口 46 个 IRT 宏
- 实证: CounterDemo tier3→`%`tier4@4→tier4→made not entrant

### 6.24 08-04(LinkResolver + Rewriter,08 域收官,大纲 10 处漂移含 3 处机制编造 + 第 3 轮 REVIEW,2026-08-13)
- **"getstatic→fast_agetfield" 编造**: getstatic/putstatic 无 fast 版本;Rewriter 对字段/方法指令只换 CP→cpCache 索引(rewrite_member_reference rewriter.cpp:168-183)
- **"newarray→fast_newarray" 编造**: 枚举里不存在;Rewriter 替换指令字节只有两类=lookupswitch→fast_*switch(:394-402)与 ldc→fast_aldc((*bcp)=_fast_aldc :355);rewrite 时机=instanceKlass.cpp:851-857 rewrite_class
- **invokedynamic**: 每调用点独占 cpCache 条目→u4 索引→**bJJJJ 5 字节格式的根本原因**;rewrite_Object_init :136-164
- **cpCache**: 四字段 _indices[b2|b1|index]/_f1/_f2/_flags(cpCache.hpp:49-54,132-142);indy 写入=set_method_handle_common 锁协议(f1 发布点,:350-395)
- **虚分派两段**: linktime(:1300-1355)/runtime(:1358-1405: nonvirtual_vtable_index 特例)
- **第 3 轮**: 指令替换两类修正自相矛盾;fast_* 只能由 Rewriter 产生(javac 不产)
- 实证: fast_linearswitch 192B/fast_binaryswitch 256B/fast_aldc 352B 模板;javap -v 链

### 6.25 31-01(Unsafe 底层 API,31 域开篇,大纲 9 处漂移含 2 处机制编造 + 第 3 轮 REVIEW,2026-08-13)
- **CAS 单路径错(JDK8 形态)**: JDK11 双路径=obj==NULL→RawAccess / obj!=NULL→HeapAccess::atomic_cmpxchg_at(06-05 access API);index_oop_from_field_offset_long(unsafe.cpp:122-135)
- **"getUnsafe 检查 caller" 半对**: jdk.internal.misc.getUnsafe() 无检查;sun.misc.getUnsafe() 才有(@CallerSensitive+getCallerClass+VM.isSystemDomainLoader);反射拿 theUnsafe 可绕(JDK11 permit 模式实测)
- **allocateInstance=env->AllocObject**(不调构造器,实证 x=0)
- **方法表 40 条**("~200 方法" 虚高);C2 intrinsic 接线注释 :1112-1115
- **park/unpark**: Parker 是 01-os/03 拆过的原语(19 域是 ParkEvent,两套);Unpark 走 ThreadsListHandle(17-03 SMR)
- **defineAnonymousClass JDK11 无 deprecated;JDK17 已移除**(实测 Temurin 17 src.zip)
- 实证: 08-unsafe-demo.txt

### 6.26 31-02(WhiteBox + Forte,31 域收官,大纲 6 处漂移含 2 处机制编造 + 第 3 轮 REVIEW,2026-08-13)
- **"WB_ENTRY 简化版 JVM_ENTRY" 错**: WB_ENTRY=JNI_ENTRY+ClearPendingJniExcCheck(whitebox.inline.hpp:33-37);WhiteBoxAPI diagnostic flag(globals.hpp:2600);JVM_RegisterWhiteBoxMethods 双门控(:2348-2361);方法表 178 条(:2114-2342)
- **"Forte——JFR 用" 错(重要)**: JDK11 JFR 采样器不用 AsyncGetCallTrace,用 **os::SuspendedThreadTask**(jfrThreadSampler.cpp:114);AGCT 是外部 profiler 的导出符号(jvm_sym.ver:6)
- **AGCT 机制**: 错误码 ticks_*(forte.cpp:50-60);入口检查 :523-556;三族两路分派 :570-628;find_initial_Java_frame :296-330;vframeStreamForte forte_next :116;ThreadInAsgct(:559,类定义 thread.hpp:777);jmethodID 类加载时预分配
- **实证方法论**: 最小 WhiteBox 兼容类(bootclasspath/a 加载);不开 flag→UnsatisfiedLinkError;native 方法签名必须与方法表 JNI 签名一致
- **第 3 轮**: ThreadInAsgct 实际 forte.cpp:559;gc 竞态注释 :588-590
- 实证: 08-whitebox-demo.txt

### 6.27 44-01(ClassVerifier 类型检查引擎,大纲行号全对(07-02 已验过),补充机制 7 条 + 第 3 轮 REVIEW,2026-08-13)
- **VerificationType 真 union**: Symbol* 指针或编码数据(verificationType.hpp:48-62);低 2 位 TypeMask+第二字节类别+高字节 descriminator;BciMask=0xffff<<8;BciForThis=(u2)-1
- **is_assignable_from 判定树**(verificationType.hpp:267-298);接口特例: 数组只可赋 Cloneable/Serializable(verificationType.cpp:47-77)
- **Uninitialized 生命周期**: new→uninitialized_type(bci)(verifier.cpp:1652-1654);verify_invoke_init(:2371-2420);initialize_object 全帧替换(stackMapFrame.cpp:57-70)
- **invoke 四层检查**(verifier.cpp:2600-2655);<init> 必须 void(:2725-2742)
- **VerifyError 路径**: verify_error 只记录(:1978-1993),Verifier::verify 尾部 THROW_MSG_(:239);failover(:184-192,版本<51)
- 实证: 08-verifier-demo.txt(iload_0→aload_0 一字节修改)

### 6.28 44-02(VerificationType 类型系统,第 4 批收官,大纲 7 处漂移含 2 处机制编造 + 第 3 轮 REVIEW,2026-08-13)
- **"Top vs Bogus 不同" 错**: top_type()=bogus_type() 别名(verificationType.hpp:130-131)
- **"Byte/Char 来自 i2b" 错**: 窄化类型来自**方法签名**(change_sig_to_verification_type stackMapFrame.cpp:115-118)
- **pop 只弹一槽**(stackMapFrame.cpp:199),category2 次槽自然落 _stack_size 之外
- **悬念指向错**: 大纲→域 45 已完结;正确 11-cds
- **写作期血泪**: 块内代码凭记忆混入不存在的 check_end_stack/grep 零命中
- **第 3 轮**: 实证解读修正([ long, long ] 是 2 个 long 变量,双槽证据=原始字节 number_of_locals=4 vs 类型项 2 个 fd 00 05 04 04 04)
- 实证: 08-verificationtype-javap.txt

### 6.29 11-01(CDS 全景与 Dump,第 5 批开篇,大纲 8 处漂移含 2 处机制编造 + 第 3 轮 REVIEW,2026-08-13)
- **"magic 0xF00BAAA2" 错**: 真实 0xF00BABA2(filemap.hpp:37)
- **"5 个 space mc/rw/ro/md/od" 错**: JDK11=**8 槽位**(metaspaceShared.hpp:66-85),实证 dump 用 6 个
- **"link_and_serialize" 编造**: 真实=link_and_cleanup_shared_classes(:1680)+VM_PopulateDumpSharedSpace::doit(:1333-1410): Metaspace::freeze→CollectClassesClosure→rewrite_nofast_bytecodes_and_calculate_fingerprints(:550)→combine_shared_dictionaries→**remove_java_mirror_in_classes(:501)与 remove_unshareable_in_classes(:489)两个独立函数**→ArchiveCompactor(压实+重定位)→dump_symbols/dump_java_heap_objects→relocate_well_known_klasses
- **指针重定位本质**: narrow_klass_base 与归档基址重合是**主动设计**(Universe::set_narrow_klass_base(_shared_rs.base()),:305)
- **写作期血泪 2**: preload_classes 块又凭记忆编了 is_loading_success(真实 ClassLoaderExt::load_one_class)——第二次犯
- 实证: 08-cds-demo.txt+08-cds-dump-full.txt

### 6.30 11-02(CDS Load 端,11 域收官,大纲 13 处漂移含 3 处编造 + 深审 2 轮,2026-08-13)
- **"MAP_SHARED" 错(重要)**: os::pd_map_memory(os_linux.cpp:6129)**flags=MAP_PRIVATE**(:6133),addr 非空才 |= MAP_FIXED(:6145-6146);跨进程共享页来自 file-backed 页缓存
- **"map_regions()" 编造**: 真实=map_shared_spaces(metaspaceShared.cpp:2034): reserve_shared_memory(filemap.cpp:869)→逐区 map_region(:891)→validate_shared_path_table(:2058);布局断言 mc_top==rw_base==ro_base==md_top(:2069-2071)
- **"initialize_shared_spaces :700-1000" 错**: 装配在 :2100;映射在 initialize_runtime_shared_and_meta_spaces(:216,metaspace.cpp:1305)
- **"shared dictionary 在 CompactHashtable" 错**: 共享字典=SharedDictionary:Dictionary(systemDictionaryShared.hpp:162,链表桶);CompactHashtable 只管符号/字符串
- **深审抓到的实质错误**: ①init_state 直接 loaded 错(dump 重置为 allocated,load 端 add_to_hierarchy 设回);②java_mirror 半对(可归档存 raw archived mirror);③cpCache 不空,是 resolved_references 要重建;④mc 区 trampoline 机制(unlink_method 设 cds entry,load 时 method_entry 宏重写;adapter 走 _adapter_trampoline 运行期填);⑤C++ vtable 克隆(dump 清零 load 现拷)
- **第 3 轮**: ①SymbolTable::lookup 顺序(symbolTable.cpp:242-258,初始先动态后共享,"最近命中方优先");②_adapter_trampoline 在 ConstMethod(constMethod.hpp:212);③MAP_FIXED 占用即静默替换,靠 base != requested_addr 兜底;④rw/mc 写脏 COW;⑤lookup_from_stream 调用点 :1072
- 实证: 11-cds-load-demo.txt

### 6.31 12-01(ciObject 镜像体系,12 域开篇,大纲 9 处漂移含 3 处编造 + 深审 2 轮,2026-08-13)
- **"JIT 编译运行在 safepoint 中" 错(重要)**: 编译在编译线程并发跑,GC 时只是阻塞;GC 安全=双通道引用——oop→JNI local handle(ciObject.cpp:53-59),Metadata(Metaspace 不移动)→裸指针
- **"unique_concrete_method / DFA / _implementors 列表" 编造**: 真实=implementor() 三态指针(ciInstanceKlass.hpp:70-74)+unique_concrete_subklass(:370)=up_cast_abstract(:376)
- **"is_c1_compilable 检查方法大小/MDO" 错**: =Method access_flags 位(is_not_c1_compilable,method.hpp:949)
- **"is_constant=final+static" 太粗**: 完整判定(ciField.cpp:257-291)=static final(排除 System.in/out/err)/@Stable/trust_final_non_static_fields/CallSite.target 特例
- **工厂双缓存**: _ci_metadata 排序数组二分(:292-335)+_non_perm_bucket[61] 哈希(:67-68/:238-259)
- **缺机制补录**: ①共享类 update_if_shared(ciInstanceKlass.hpp:109-113,init_state 现算);②hotswap 检查 Dependencies::check_evol_method(ciMethod.cpp:102-110);③依赖登记 Dependencies;④unloaded 镜像 is_loaded;⑤解释器计数快照
- **第 3 轮**: ①ciEnv 的 Arena 是 C 堆 mtCompiler 非资源区;②is_interface 基类仍 virtual(ciKlass.hpp:97);③update_if_shared 是"快照值与查询目标不一致才现算";④构造快照确认
- 实证: 12-ci-inlining-demo.txt

### 6.32 12-02(ciTypeFlow + bcEscapeAnalyzer,12 域 2/3,大纲 10 处漂移含 4 处编造 + 深审 2 轮,2026-08-13)
- **"common_type / ciType::top" 名字错**: 真实=StateVector::type_meet/type_meet_internal(ciTypeFlow.cpp:272);类型格=top(T_VOID 占位)/bottom(T_CONFLICT)/long2/double2/null;meet 规则: 接口与非接口→Object(注释 "This is what the verifier does",:299-303,44 域同源)
- **"ConnectionGraph 在 BCEscapeAnalyzer 里" 错**: ConnectionGraph=C2 opto/escape.cpp(:320);bcEscapeAnalyzer="fast, conservative analysis...at the bytecode level"(bcEscapeAnalyzer.hpp:38-40),输入=ciMethod+ciMethodBlocks(**与 ciTypeFlow 无关**);三档术语 NoEscape/ArgEscape/GlobalEscape 属 ConnectionGraph(escape.hpp:155-160)
- **"ciMethod::scalar_replacement_possible()" 不存在**: 真实=ConnectionGraph::scalar_replaceable(escape.cpp:256/273)
- **算法**: 乐观初始化+降级(putfield 被写值→set_global_escape;invoke 单形态→set_method_escape+记依赖,非单形态→全 global+_unknown_modified;递归 _parent/_level)
- **第 3 轮**: ①is_recursive_call 语义=递归检测(沿 _parent 链,:206-207);②get_start_state :363;③Parse 消费以 flow 块图为骨架;④do_analysis 跳过条件(:1302-1316): abstract/native/未初始化/_level>MaxBCEAEstimateLevel/大小>MaxBCEAEstimateSize
- **实证方法论**: 开关对照实验(-XX:-EliminateAllocations 标量替换证明)
- 实证: 12-ci-typeflow-escape-demo.txt

### 6.33 12-03(ciObjectFactory + ciReplay,12 域收官,大纲 9 处漂移含 4 处编造 + 深审 2 轮,2026-08-13)
- **"析构遍历释放" 编造**: ciEnv::~ciEnv(ciEnv.cpp:215)只有两件事=remove_symbols+set_env(NULL);所有 ci 对象在 _ciEnv_arena,Arena 一次释放
- **"ciEnv::initialize_from_replay" 编造**: 真实=jni.cpp:4050 `if (ReplayCompiles) ciReplay::replay(thread)`(debug-only)→replay_impl(ciReplay.cpp:1074)→编译照常走工厂+initialize 钩子(:1115/:1206 回填录制值)
- **"ciMethodData 一次性复制" 错**: 懒创建 ensure_method_data(ciMethod.cpp:965);load_data(ciMethodData.cpp:170)=原子拷贝 MDO 头+data 进 ciEnv Arena(:205-215,注释 "Any concurrently executing threads may be changing the data as we copy it")
- **"防止 safepoint 中 MDO 被 GC 修改" 错**: MDO 在 Metaspace 不移动;真问题是解释器并发写 MDO→快照保自洽
- **replay 文件格式**(实证解读): ciMethod 行=invocation/backedge raw+解释器计数+throwout+instructions_size(**9 486889 1 0 -1 不是 code_size!**);ciMethodData 行=_state+mileage+orig+data+oops 段;compile 行=entry_bci+comp_level+内联树
- **录制三途径**: DumpReplayDataOnError(product 默认 true)/CompileCommand DumpReplay/SA core;**ReplayCompiles 是 develop**
- **第 3 轮**: ①ciInstanceKlass 行=is_linked/is_initialized/cp_length+**常量池 tags**(ciInstanceKlass.cpp:713);②staticfield 行=**static final 字段**;③orig 段=头部原始字节(小端);④共享镜像长命 Arena 例外
- 实证: 12-ci-replay-demo.txt

### 6.34 13-01(CompileBroker 编译队列,13 域 1/2,大纲 7 处漂移含 3 处编造 + 深审 2 轮,2026-08-13)
- **"compute_priority 优先级排序" 编造**: 双 FIFO 队列(_c1/_c2_compile_queue,compileBroker.hpp:179-180);**取任务时 select_task 按 weight 重选热点**(tieredThresholdPolicy.cpp:285-312;weight=(rate+1)×(inv+1)×(backedge+1) :529-533;rate=每 ms 事件数 update_rate :471-500)
- **"状态机 in_queue→assigned→..." 编造**: 只有 _is_complete/_is_success/_is_blocking(compileTask.hpp:83-85);"进行中"=CompileTaskWrapper 存活期
- **"超时 2min" 编造**: _time_queued 只用于日志;无超时取消
- **"c1 1 线程/c2 2 线程" 半对**: CI_COMPILER_COUNT=2 但 LP64 默认 CICompilerCountPerCPU 自适应;实证本机 15
- **缺机制**: ①CompileReason 九种(compileTask.hpp:48-59)+purge_stale_tasks(is_stale :509-520,TieredCompileTaskTimeout=50ms;is_old 5万/50万不移除 rate 清零);②compile_id=全局递增(assign_compile_id :1479);③拒绝链;④执行段(push_jni_handle_block→ciEnv→compile_method→post_compile=mark_success+查 task->code(),nmethod 注册在 ciEnv::register_method);⑤code cache 满: UseCodeCacheFlushing 暂停可恢复否则 disable_compilation_forever(:2319-2329)
- **实证方法论**: CIPrintCompileQueue diagnostic 可用;compile_id 与 DumpReplay compid 同源
- 实证: 13-jit-broker-demo.txt

### 6.35 13-02(TieredThresholdPolicy,13 域收官,大纲 8 处漂移含 2 处编造 + 深审 2 轮,2026-08-13)
- **"L0→L1→L2→L3→L4 阶梯" 错(重要)**: 权威转换图(tieredThresholdPolicy.cpp:676-712 注释): **a. 0→3→4 常规;b. 0→2→3→4(C2 队列负载);c. 0→(3→2)→4;d. →1 仅 trivial;e. 0→4(C1 失败)**。**L1 是终点不是阶梯**
- **"5000/5000/15000" 编造**: 两档 predicate: 解释器→C1=Tier3 200/100/2000;C1→C2=Tier4 5000/600/15000;回边 Tier3BackEdge=60000/Tier4BackEdge=40000
- **事件机制**: event(:371)分派两路——method_invocation_event(:884)/method_back_branch_event(:903: OSR compile 入口=回边 bci :918+借机普通编译 :921-932);call_event OSR 均衡(:827-834)
- **第 3 轮**: ①level 3→4 判定用 **MDO 计数增量**(invocation_count_delta/backedge_count_delta,common :802-803);would_profile false 直接升 4(:807-809);②should_create_mdo 语义: 计数达 C1 阈值的 **200%**(Tier0ProfilingStartPercentage)才建 MDO
- 实证: 13-jit-tiered-demo.txt

### 6.36 18-01(Safepoint 编排,18 域 1/2,大纲 8 处漂移含 2 处编造 + 深审 2 轮,2026-08-13)
- **"两阶段 spin→block" 简化**: 真实三档递进(safepoint.cpp:390-398): SpinPause→naked_yield(4000 次前)→naked_short_sleep(1);然后 Safepoint_lock->wait(:423),最后线程 notify_all 唤醒 VM 线程(:866-867)
- **"safepoint_counter 快速路径=一条 testb+jnz" 简化**: JDK11=jniFastGetField 汇编: 偶数→投机读字段+**二次加载 counter 校验**(双加载防读取中 GC);counter 消费者还有 ciMethodData::has_safepointed+在 dependencyContext 断言
- **"end 里 Safepoint_lock->notify_all" 错**: 等待线程阻塞在 **Threads_lock**(block :882),end() unlock 放行(:590)
- **"SerialSafepointCleanupTask 串行 7 项" 类名编造**: 真实=do_cleanup_tasks(safepoint.cpp:731)→**ParallelSPCleanupTask::work**(:647): 线程级+7 子任务;GC WorkGang 并行或 VM 线程串行(:741-753);cleanup 在 begin() 内(:481)
- **no_op_safepoint**: vmThread.cpp:440 no_op_safepoint_needed;实证 "Entering safepoint region: Cleanup"
- **第 3 轮**: ①x86_64 默认 thread-local poll(THREAD_LOCAL_POLL);编译代码/解释器轮询=testb 线程 _polling_page 字段,**不触发 SIGSEGV**——01-os/04 是全局页模式,JDK11 x86 非默认;**注: 18-02 第 3 轮(06086f2)修正——编译代码(C1/C2)轮询是 deref 方式,armed 时仍真 SIGSEGV,以 18-02 为准**;②serialize_thread_states 只在 !UseMembar 时执行
- 实证: 18-safepoint-demo.txt

### 6.37 18-02(轮询与 NoSafepointVerifier,18 域收官,大纲 10 处漂移含 4 处编造 + 深审 2 轮,2026-08-13)
- **"NoSafepointVerifier 伪代码" 编造**: JDK11=**线程计数**(safepointVerifiers.hpp:89-104: 构造 _allow_safepoint_count++/_allow_allocation_count++,析构减;检查点 check_for_valid_safepoint_state(thread.cpp:995-1006)计数非零→fatal);调用点=memAllocator.cpp:186/mutex.cpp:1370/vmThread.cpp:672;release 空实现;**NoGCVerifier 才是计数断言**(total_collections,safepointVerifiers.cpp:8-28)
- **"ServiceThread::armed_value" 编造**: 不存在
- **"Thread::_polling_page 地址切换" 半对**: JDK11=值方案——armed=8|bad_page(受保护)、disarmed=good_page(safepointMechanism.cpp:50-76);arm/disarm=set_polling_page 一次写(:50-57);local_poll_armed=mask_bits_are_true(:32-35)
- **"polling page 两个偏移 8 字节" 错(旧版)**: JDK11=bad/good **两个连续页**(实证日志 "SafePoint Polling address, bad (protected) page / good (unprotected) page")
- **x86 默认**: ThreadLocalHandshakes pd product 默认 true→thread-local poll;全局页模式信号侧 01-os/04(JDK11 x86 非默认)
- **第 3 轮**: ①轮询**双实现**——解释器/共享 stub=testb 位测试;**C1/C2 编译代码=deref**(c1_LIRAssembler_x86.cpp:558-575/x86_64.ad:1099-1102)——armed 值 deref PROT_NONE 页→**真 SIGSEGV**→is_poll_address(os.hpp:429)→get_poll_stub(os_linux_x86.cpp:431-432);**01-os/04 的轮询页 SIGSEGV 在 JDK11 x86 真实存在(编译代码路径)**;②全局模式: C1 deref 全局页,解释器 cmp32 state
- 实证: 18-safepoint-polling-demo.txt

### 6.38 20-01(VM_Operation 从提交到执行,20 域 1/2,大纲 7 处漂移含 0 处硬编造 + 深审 2 轮,2026-08-13)
- **模式 4 元组 ✓**(vmOperations.hpp:136-141);操作 ~84 种(VM_OPS_DO :48-132)
- **队列**: 双优先级(SafepointPriority/MediumPriority);queue_peek lock-free(:68 "may return the wrong answer but must not break");drain_at_safepoint_priority 排干;coalesced 执行链
- **execute 协议**(vmThread.cpp:663-723): check_for_valid_safepoint_state(:671)→doit_prologue(:676,取消机会)→入队 notify(:696-704)→**ticket 等待**(vm_operation_completed_count<ticket,:712-719)→doit_epilogue(:722);evaluate_operation(:403)完成登记 increment_vm_operation_completed_count(:427-429)
- **loop(:457)**: remove_next→空等 GuaranteedSafepointInterval 超时→no_op_safepoint;嵌套 allow_nested_vm_operations 默认 false fatal
- **VMThread 是 NamedThread** 非 JavaThread(thread.hpp:114)
- **第 3 轮**: ①doit_prologue=VM_RevokeBias 查对象 bias 标记(biasedLocking.cpp:520-534);②唤醒=loop 每轮末 VMOperationRequest_lock->notify_all()(:622-624),非登记即唤醒;③loop 末复查 no_op_safepoint_needed(true)(:625-631)
- 实证: 20-vmops-demo.txt

### 6.39 20-02(后台任务与启动序列,20 域收官,大纲 10+ 处漂移含 6 处机制编造 + 深审 2 轮,2026-08-14)
- **"WatcherThread 主循环 vmThread.cpp:500-550" 文件错(重要)**: WatcherThread 在 **thread.cpp**(run :1453/sleep :1395/start :1514/make_startable :1524),vmThread.cpp 是 VMThread;名字="VM Periodic Task Thread"(thread.hpp:930),NonJavaThread(:902)
- **"固定 50ms 睡眠" 错**: sleep() 算 `time_to_wait()`(task.cpp:80-92,min(interval-counter)),PeriodicTask_lock->wait(remaining) 睡到**最近任务到期点**;无任务睡到被 unpark;spurious 循环重算(:1435-1446)
- **"递减 counter" 反**: execute_if_pending(task.hpp:82-92)把 delay **累加**,>=interval 执行并清零
- **"_tasks 链表" 错**: 静态数组 max_tasks=10;enroll=尾加+unpark/start;disenroll=左移;real_time_tick 处理任务自 disenroll(index-- :72-75)
- **"JFR 是 PeriodicTask" 编造**: JfrThreadSampler 独立 NonJavaThread(自己 semaphore),不 enroll 到 WatcherThread;默认配置无此线程
- **"BiasedLocking::check_bulk_rebias 周期" 编造**: 真实 EnableBiasedLockingTask 一次性(interval=BiasedLockingStartupDelay 默认 0=立即);批量撤销=VM_BulkRevokeBias 由 update_heuristics 计数(20/40 阈值)被动触发
- **"NMTSweeper" 编造**: 无 NMT 周期任务
- **任务全清单(7 个)**: StatSamplerTask(50ms)/EnableBiasedLockingTask(一次性)/VMOperationTimeoutTask(delay/10)/ChunkPoolCleaner(5000ms,BlocksToKeep=5)/JniPeriodicCheckerTask(10ms,信号完整性)/RTMLockingCalculationTask(一次性)/MemProfilerTask(develop-only)
- **"VM init 23 步 init.cpp:80-250" 全错**: init.cpp 共 190 行;init_globals=:101-160(**30 函数**,顺序即依赖注释),vm_init_globals=:90-98(7 步);"jintArgumentProlog/10_initPhase2/30_runPhase2" 是 JDK8 旧版
- **"Threads::create_vm 是 init_globals 一步" 反**: Threads::create_vm(thread.cpp:3702)调 vm_init_globals(:3809)+init_globals(:3846);四段: 参数与 OS/全局初始化/VMThread 点亮/服务与后台
- **"VMThread::create 内部等 loop(VMOperationLock)" 错**: create(vmThread.cpp:242-275)只建对象;就绪握手=Notify_lock 等 active_handles(thread.cpp:3879-3887);"vm_during_initialization flag" 不存在
- **WatcherThread 晚启动原因**: make_startable 后才可 start;注释 "All PeriodicTasks should be registered by now"(thread.cpp:4072-4074)
- **停机**: before_exit 先 WatcherThread::stop(java.cpp:503)再 StatSampler::disengage(:507)
- **第 4 轮**: ①ServiceThread 行号与职责对齐(:84 entry,JVMTI/GCNotifier/DCmd);②Agent 启动时序(:3804 才初始化);③develop flag 在 PRODUCT 下是 const 常量(CleanChunkPoolAsync 恒 true)
- 实证: 20-background-init-demo.txt

### 6.40 27-jni/01(JNI Handle 系统,27 域 1/3,大纲 9 处漂移含 3 处机制编造 + 深审 2 轮,2026-08-14)
- **"Local handle 自动释放(Native 返回后 pop)" 半对**: 真实=**native 方法返回时 `_top` 清零**(templateInterpreterGenerator_x86.cpp:1163-1166 解释器 + sharedRuntime_x86_64.cpp:2652-2656 编译代码 "reset handle block",critical native 例外)——一次 movl 让整块本地引用失效
- **"resolve 伪代码(RawAccess/无锁解释)" 错**: 真实 resolve_impl(jniHandles.inline.hpp:52-66)用 **NativeAccess**;jweak 走 ON_PHANTOM_OOP_REF 通道;**assert(!current_thread_in_native())(:55)——resolve 必须在非 native 状态**,大纲"native 状态无锁"方向反
- **"OopStorage(域 25)" 归属错**: OopStorage 在 share/gc/shared/oopStorage.*;JNIHandles::initialize 建 **"JNI Global"/"JNI Weak" 两个实例**;allocate 锁分配+_active_array;release 无锁 CAS(:575-587);GC 弱清除=weakProcessor.cpp:37
- **jweak tag 细节**: weak_tag_size=1/alignment=**2**(非 8);实证 NewWeakGlobalRef 地址 lsb=1
- **参数=本地引用(重要)**: 传回 Java 再传回 native 的引用 GetObjectRefType=1(实证);实现=参数帧里 oop 槽的地址(编译 object_move sharedRuntime_x86_64.cpp:1157-1180;解释器 pass_object interpreterRT_x86_64.cpp:214-260);is_frame_handle(jniHandles.cpp:270-278);**把参数当 global handle 传 DeleteGlobalRef 会 SIGSEGV**(实测)
- **JNIHandleBlock 内部**: block_size_in_oops=32;allocate_handle 四段(_last 末槽→free list→_next→rebuild/追加);rebuild 启发式(空闲>一半才下次重建);free list 由 rebuild 扫描清空槽构建(:548-575)
- **第 3 轮**: 参数 handle 机制精确化(pass_object lea,null 参数传 NULL);**第 4 轮**: free list 成因/Release CAS+延迟清理
- 实证: 27-jni-handles-demo.txt

### 6.41 27-jni/02(JNI Fast Path,27 域 2/3,大纲 10 组漂移含 3 处机制编造 + 深审 2 轮,2026-08-14)
- **"jni.cpp:2146-2160 正常路径" 行号错**: 2146 起是 jni_GetXXXField_addr();普通实现=**DEFINE_GETFIELD 宏**(jni.cpp:2082-2106: JNI_QUICK_ENTRY+resolve_non_null+from_instance_jfieldID+probe+读字段)
- **"6 条指令" 少算**: 真实 ~16 条;**MP 上 XOR 数据依赖代替 lfence**(jniFastGetField_x86_64.cpp:38-39)
- **漏二次 counter 加载(重要)**: 第一次偶数门票→resolve→投机读(登记 pc)→**再读 counter 比较**,相等才 ret;慢路径=**尾跳**(jump ExternalAddress(jni_GetIntField_addr()))
- **"GetObjectField/GetStatic*Field" 编造**: 只有 **8 个实例字段 Get**(Boolean~Double);quicken_jni_functions(jni.cpp:3829-3873)+5 条件;copy_jni_function_table safepoint 原子替换
- **counter 协议**: safepoint.hpp:112-118 注释("incremented ONLY at the beginning and end of each safepoint...Threads_lock held throughout");begin :448-450/end :501-503;初值 0
- **fieldID 编码**: 低 2 位 checked/instance;偏移=BitsPerWord-2 位(**64 位 62 位**,注释 "30" 是 32 位遗留)
- **信号救场**: os_linux_x86.cpp:494-501——投机读期间 GC 收缩堆→SIGSEGV/SIGBUS→find_slowcase_pc→跳慢路径
- **try_resolve_jobject_in_native**(barrierSetAssembler_x86.cpp:213-217)=clear_jweak_tag+movptr 两行
- **第 4 轮**: ①安全论证补全(对象移动必然伴随 counter 变号,读错被丢弃);②wraparound(hpp:54-55);③GetObjectField 普通实现=HeapAccess+make_local(jni.cpp:2076)
- 实证: 27-jni-fastpath-demo.txt(快 1.4ns vs 慢 15ns,10 倍)

### 6.42 27-jni/03(JNI Check + 平台层,27 域收官,大纲 10 组漂移含 3 处机制编造 + 深审 2 轮,2026-08-14)
- **"宏替换,release 展开为空" 半对**: 机制=**整表替换**——jni_functions()(jni.cpp:3876-3881)在 CheckJNICalls 时返回 checked 表;jni_functions_check(jniCheck.cpp:2304-2323)保存原始表+断言结构一致("Mismatched JNINativeInterface tables")
- **JNI_ENTRY_CHECKED 与 JNI_ENTRY 的关键差异**: **不含 ThreadInVMfromNative**——不做整函数状态转换,校验点用 IN_VM(:63-68)局部转换
- **wrapper 四段**: ①入口(线程/env)②functionEnter(:222-228: in_critical+check_pending_exception :184-197)③IN_VM 参数校验(validate_handle :443/validate_object :469/validate_jmethod_id :453-466→Method::checked_resolve_jmethod_id method.cpp:2191-2202)④UNCHECKED() 回调+functionExit(:239-252 **本地引用泄漏**: live>planned 警告,add_planned_handle_capacity=capacity+live+32,PushLocalFrame/EnsureLocalCapacity 设置——01 篇 _planned_capacity 伏笔落地)
- **"方法签名匹配" 编造**: 实际=methodID 解析+类匹配,无签名匹配检查
- **"jniPeriodicChecker 检查全局引用泄漏" 编造**: 20-02 已证=10ms 信号检查
- **平台层**: 结构 JNINativeInterface_ 在 JDK 侧 jni.h:214;实例 jni_NativeInterface 在 jni.cpp:3528;jniExport.hpp 是 **JVMTI 接口导出器**(名字误导)
- **第 4 轮**: ①校验维度表补'字段 ID 类型'行(8 维度);②fatal 路径差异(宏内非 Java 线程=直接 print+abort)
- 实证: 27-jni-check-demo.txt(泄漏警告每 32 个;无 flag 对照 0 警告)

### 6.43 30-jvm-entry/01(JVM Entry Points,30 域 1/3,大纲 9 组漂移含 2 处机制编造 + 深审 2 轮,2026-08-14)
- **"dlsym 动态查找" 编造**: 真实=System.c:39 `(void *)&JVM_CurrentTimeMillis` **编译期取址**+libjava.so ELF 链接期 UND 符号(nm 实证 131 个 U JVM_*@SUNWprivate_1.1);**导出名单=jvm_sym.ver 版本脚本**(JNI_*/JVM_*/jio_*/AGCT)
- **"JVM_* 五大类" 编造**: 真实=jvm.h:38-55 头注释 "three parts";jvm.cpp 非分节
- **行号**: jvm.h 1342 行/182 个 JNIEXPORT/函数自 :59/JVM_INTERFACE_VERSION 6;libjvm.so 导出 174 个 JVM_*+5 个 jio_*(nm 实证)
- **运行时解析**: NativeLookup::lookup(nativeLookup.cpp:527-546): has_native_function→lookup_base;PrintJNIResolving=**-verbose:jni**(非 -Xlog)
- **JVM_ENTRY vs JVM_LEAF 判据=碰不碰堆**: ENTRY(interfaceSupport.inline.hpp:558-565)/LEAF(:588-592: block_if_vm_exited+NoHandleMark,CurrentTimeMillis 三行);JVM_ENTRY 与 JNI_ENTRY 差异=WeakPreserveExceptionMark
- **第 4 轮**: 注册表行号 System.c:38/174 个导出/UND 全为 U/PrintJNIResolving 来源(arguments.cpp:2413)
- 实证: 30-jvm-entry-demo.txt(Registering vs Dynamic-linking)

### 6.44 30-jvm-entry/02(JavaCalls + NativeLookup,30 域 2/3,大纲 9 组漂移含 3 处机制编造 + 深审 2 轮,2026-08-14)
- **"call_dynamic 四种调用模式" 编造**: JavaCalls 只有 call_special(:227)/call_virtual(:188)/call_static(:262)+construct_new_instance+低层 call(:268)→call_helper(javaCalls.cpp:346)
- **"method->invoke() 走解释器或编译入口" 编造**: 真实=call_helper 里 **StubRoutines::call_stub()**(:442)以 `from_interpreted_entry`(:390)为入口——该字段=缓存: **已编译=i2c_entry,未编译=i2i_entry**(method.hpp:113);编译触发=CompilationPolicy::compile_if_required(:385)
- **JavaCallArguments**: 只记 handle/jobject 地址不记裸 oop(注释 "delays the exposure of naked oops until it is GC-safe");parameters()(:505-517)调用前统一解析
- **call_helper 十步**: 四断言(:349-352 含 !is_at_safepoint)/args->verify/空方法/compile_if_required/from_interpreted_entry/栈守卫恢复(:399-413)/JavaCallWrapper(:420)/call_stub(:442)/结果回写/vm_result 跨 GC(:451-462)
- **"lookup 4 步" 简化**: 真实=lookup→lookup_base(:511): lookup_entry(:327 三种名字风格)→**lookup_style(:253)按类加载器分流**(系统类=特殊表 :263+libjava dll_lookup :265;**应用类=JavaCalls 调 ClassLoader.findNative :277-285 绕回 Java 侧,System.loadLibrary 链路**;agent 兜底 :293-297)→prefixed(:476)→UnsatisfiedLinkError
- **特殊表 7 条**(含 Perf→JVM_RegisterPerfMethods+JVMCI/JFR 条件)
- **第 4 轮**: ①查找流程重写(ClassLoader.findNative 应用类路径——与 30-02 主题闭环);②四断言;③Windows 表述删除
- 实证: 30-java-calls-demo.txt(nm 207 个 Java_ 符号)

### 6.45 30-jvm-entry/03(Reflection + StackWalk,30 域收官,大纲 10 组漂移含 3 处机制编造 + 深审 2 轮,2026-08-14)
- **"reflection.cpp:100-400" 目录错**: reflection.cpp 在 **share/runtime/**(非 prims/);invoke_method :1257-1280(镜像定位=clazz+**slot 编号** method_with_idnum+override+ptypes/rtype),共享 invoke :1072-1255 五段
- **"Reflection::field_get" JDK8 旧版**: JDK11 反射字段访问走 Unsafe
- **"getCallerClass 用 vframeStream 前两个 frame" 半对**: JVM_GetCallerClass(jvm.cpp:706-742): **security_next()** 跳过三类内部帧(Method::is_ignored_by_security_stack_walk method.cpp:1268-1276: _invoke intrinsic/MethodAccessorImpl 子类/MH 适配帧);frame0=invoke intrinsic 检查/frame0-1 @CallerSensitive
- **"StackWalk filter 反射帧" 错(重要)**: 反射帧过滤在 **Java 侧**(StackStreamFactory.java:249-268);hotspot 只过滤 **@LambdaForm.Hidden 帧**(is_hidden,stackwalk.cpp:123-137)——实证 -Xlog:stackwalk=debug: hotspot 把反射帧全 fill
- **invoke 五段**: 方法解析/参数个数/unbox+widen+push/JavaCalls::call(:1233)/ITE 包装(:1234-1249)+narrow+box;**override 标志 C++ 侧不用**
- **StackWalker 分页**: batchSize(StackStreamFactory.java:545-556): 首批=min(max(estimateDepth,8),256),后续翻倍至 32;JVM_MoreStackWalk→fetchNextBatch
- **第 4 轮**: 分页批大小机制(6=estimateDepth 估计值);JVMInvokeMethodSlack=develop_pd
- 实证: 30-reflection-stackwalk-demo.txt(SHOW_HIDDEN 反射链 6 帧)

### 6.46 32-jfr/01(Recorder Engine,32 域 1/6,大纲 9 组漂移含 4 处机制编造 + 深审 2 轮,2026-08-14)
- **"per-event-type buffer" 编造**: JDK11=每线程 **两个 buffer**(_java_buffer/_native_buffer,jfrThreadLocal.hpp:39-40);大事件 shelve+provision_large 临时租 transient(8×)
- **"-XX:JfrThreadLocalBufferSize" 编造**: 不存在;默认 thread-local **8KB**/global 512KB/池 20 块(jfrOptionSet.cpp:165/168;Options.java:44-46)
- **"JfrChunkWriter::write_chunk_loop" 编造**: JDK11=JFR Recorder Thread 消息循环(jfrRecorderThreadLoop.cpp:40-86,六消息);JfrChunkWriter 只是文件 IO(open :54-70 "FLR"+版本 2.0+reserve 6×8 头槽;write_header :95-107 关闭回填)
- **JfrBuffer 双指针**: _pos(下一写入,私有)/_top(下一未刷,volatile),_top<=_pos;可见性由消息同步补齐
- **flush 链**: flush(:480)→flush_regular(:489): 刷空→memmove 续写→shelve+provision_large;满 buffer post MSG_FULLBUFFER(:351)
- **生命周期**: JfrRecorder::create(:234)=create_components+create_recorder_thread(:399);on_create_vm_1/2/3(:84/:193/:223);启停 post MSG_START/STOP
- **chunk 轮转**: 阈值=Java 侧 setFileNotification(jfrJniMethod.cpp:116-118),JfrChunkRotation::evaluate(size_written>threshold);chunk 自包含可边录边读
- **第 4 轮**: "130+ 事件类型"实证=143 个 jdk.* 类型(jfr summary grep -c)
- 实证: 32-jfr-recorder-demo.txt(xxd 文件头+chunk_size 回填=文件大小)

### 6.47 32-jfr/02(Event Types + Metadata,32 域 2/6,大纲 10 组漂移含 3 处机制编造 + 深审 2 轮,2026-08-14)
- **"jfrMetadataEventClass.cpp code generation" 编造**: 生成工具=构建期 Java 工具 build.tools.jfr.GenerateJfrFiles(GensrcJfr.gmk),metadata.xml+xsd→gensrc/jfrfiles/**jfrEventClasses.hpp+jfrEventIds.hpp**(生成物不在源码树);入口 jfrEvents.hpp:28 "Declare your event in jfr/metadata/metadata.xml."
- **"TRACE_REQUEST_COMMIT" 编造**: 零命中;事件提交=生成类 set_xxx+commit()(jfrThreadSampler.cpp:264/:288-300)
- **分类错**: category 是层级值("Java Virtual Machine, GC, Detailed" 23/"Java Virtual Machine, Flag" 14/"Java Application" 9),非简单五组
- **metadata.xml 双端消费(重要)**: ①hotspot 构建期生成 C++ 类;②**复制进 jdk.jfr 资源 /jdk/jfr/internal/types/metadata.xml**(Copy-jdk.jfr.gmk),运行期 **MetadataHandler.java:218 解析**→Java 侧 jdk.* 类型
- **Java 侧**: MetadataRepository.initializeJVMEventTypes(MetadataRepository.java:66-86: @Threshold/@StackTrace/@Cutoff/@Period 注解→RequestHook+EventControl);动态事件=EventClassBuilder.java:45(ASM "jdk.jfr.DynamicEvent"+id);JfrMetadataEvent(jfrMetadataEvent.hpp:31-43 "Java stores a binary representation back to native")
- **事件数**: metadata.xml **124 个 Event**(1168 行);运行期 **143 个** jdk.* 类型
- **第 4 轮**: '全部事件类型'限定'内置事件类型';143 vs 124 关系
- 实证: 32-jfr-metadata-demo.txt(jfr print --events 按 schema 解析)

### 6.48 32-jfr/03(Periodic Sampling,32 域 3/6,大纲 9 组漂移含 4 处机制编造 + 深审 2 轮,2026-08-14)
- **"AsyncGetCallTrace 采样" 错(重要)**: 31-02 已证 JDK11 JFR 采样用 os::SuspendedThreadTask(jfrThreadSampler.cpp:114);采样循环 :452-500(semaphore+双间隔),每轮 5 个(:285)+next_thread 游标分摊
- **"-XX:JfrThreadSamplingInterval" 编造**: 不存在;间隔=Java 侧 ExecutionSample 事件周期注入 **jfr_set_method_sampling_interval**(jfrJniMethod.cpp:248-261,第 3 轮修正函数名);默认 20ms(default.jfc)/10ms(profile.jfc);传 0 停摆(next_j=max_jlong :467)
- **"JfrStackTrace::record" 名字差**: 真实=JfrStackTraceRepository::add(:173-198)→add_trace(:200 哈希查表,未命中 resolve_linenos 后再查);**trace_id=u8 8 字节**(jfrTypes.hpp:30,非大纲"4 bytes");栈数据 repository::write(JfrChunkWriter,:100)落 chunk 常量池
- **"~20 periodic events" 错**: 真实 **45 个 TRACE_REQUEST_FUNC**(jfrPeriodic.cpp:74)
- **"JfrRecorder 在 loop 中周期调用" 错**: 周期驱动在 **Java 侧 RequestEngine**(RequestEngine.java): RequestHook.execute(:66-85 native 事件 jvm.emitEvent→jfr_emit_event→requestEvent);doPeriodic(:184)→run_requests(:191 delta>=period);isEveryChunk 事件 doChunkBegin/End(:160-177);user 事件 executeSecure
- **ExecutionSample/NativeMethodSample/ThreadDump period="everyChunk"**(metadata.xml:709-724)
- **第 4 轮**: 悬念段遗留'4 字节'改 8 字节(跨段一致性问题)
- 实证: 32-jfr-sampling-demo.txt(jfr print ExecutionSample 实例)

### 6.49 32-jfr/04(Binary Writer + Chunk Format,32 域 4/6,大纲 9 组漂移含 4 处机制编造 + 深审 2 轮,2026-08-14)
- **"jfrBinaryWriter.cpp" 编造**: 写出=WriterHost 模板(jfrWriterHost.hpp/inline): BE 大端(BigEndianEncoderImpl jfrEncoders.hpp:52,be_write :118 浮点/布尔)+IE(Varint128EncoderImpl :159)+存储策略(JfrEventWriter/JfrCheckpointWriter/JfrChunkWriter)
- **"magic(0xCAFEBABE)" 编造**: 32-01 实证 FLR\0(464c5200);0xCAFEBABE 是 class 文件 magic
- **"jfrLeb128.hpp/cpp" 编造**: 真实=Varint128EncoderImpl(ext_bit=0x80,7 位数据+扩展位,LEB128 同族);**compressed_integers 恒 true**(jfrOptionSet.cpp:146-149 不可关);write 分派(:84-89);**负值最费字节**(s1(-1)→0xff 0x0f 2 字节,size_safety_cushion=1)
- **字符串五编码**: JfrStringEncoding(NULL_STRING=0/EMPTY/STRING_CONSTANT/UTF8/UTF16/LATIN1);write_utf8(:92-100)/write_utf16(:107-114);STRING_CONSTANT=线程/类/符号常量池条目
- **第 4 轮**: ①'长度头用 be_write'修正(长度走 write 变长编码,数据体 be_write 直拷);②事件格式补 **u4 大小槽**(begin_event_write reserve :56-60/end_event_write 回填 :62-76)
- 实证: 32-jfr-binary-demo.txt(jfr print --xml 还原 CPULoad)

### 6.50 32-jfr/05(Old Object Sampling,32 域 5/6,大纲 8 组漂移含 2 处机制编造 + 深审 2 轮,2026-08-14)
- **"每 N 字节采样" 错**: 粒度=**每次 TLAB 补充/大对象分配**(AllocTracer::send_allocation_outside_tlab/in_new_tlab allocTracer.cpp:35/:45 首行 JFR_ONLY JfrAllocationTracer→LeakProfiler::sample 排除隐藏线程 leakProfiler.cpp:112-122→ObjectSampler::sample objectSampler.cpp:138-153)
- **span 语义**: span=_total_allocated - priority_queue->total()(:167,**分配增量**,非"分配字节数");队满 quick reject(:171-175 peek->span()>span)+reuse(:176);样本队列默认 **256**(jfrOptionSet.cpp:173)
- **双锁**: sample 入口 **JfrTryLock 非阻塞**(:147,失败跳过);acquire/release(:94-104)是**自旋锁**(checkpoint 用)
- **启用**: LeakProfiler::start(:41-77: 0 禁用/ZGC+Shenandoah 不支持/StartOperation VM 操作 safepoint 安装 :68);jfrJniMethod.cpp:109;GC 集成 oops_do(:227-246)+scavenge(:201-225)
- **PathToGcRootsOperation::doit ✓**(本篇大纲较准): safepoint 断言 :82/BitSet :85-87/EdgeQueue 5%或 32M :59-63+commit 1:10 :65-69/BFS 优先 :112 满时 DFS 兜底 :117-124/失败降级 flat :95-98;DFS max_depth=5000(dfsClosure.cpp:41);rootType 两维
- **cutoff 机制(第 4 轮补)**: EventEmitter::emit(cutoff≤0 只发样本无链 :58-63;cutoff>0 才 PathToGcRootsOperation :66-68);**默认 memory-leak-detection-cutoff=0ns 无链**
- **chain 序列化**: ObjectSampleCheckpoint::write(:398-409 write_sample_blobs+edge_store->iterate ObjectSampleWriter);OldObjectSample 事件(metadata.xml:579-586);OldObjectGcRoot 复合类型(:1083-1095)
- **第 3 轮**: quick reject 表述修正(栈记录在 sample 入口已发生)
- 实证: 32-jfr-leakprofiler-demo.txt

### 6.51 32-jfr/06(JNI Interface + Instrumentation + DCmd,32 域收官,大纲 10 组漂移含 6 处机制编造 + 深审 2 轮,2026-08-14)
- **"JfrClassAdapter::transform" 编造**: 真实=JfrEventClassTransformer::on_klass_creation(jfrEventClassTransformer.cpp:1515);调用点 klassFactory.cpp:222 JFR_ONLY(ON_KLASS_CREATION)(jfrKlassExtension.hpp:41 宏,IS_EVENT_KLASS trace_id 标记)——**类文件解析层拦截 jdk.jfr.Event 子类首次加载**,重写字节→新 InstanceKlass 替换+tag_as;日志字符串 "JfrClassAdapter:"(:1522)是旧名唯一来源
- **"方法入口 ASM 插桩" 错**: 注入=**事件类 schema**(5 方法壳 commit/begin/end/isEnabled/shouldCommit,:120-145 空方法体字节+3 字段 EventHandler,:60-61);急切模式调 Java EventInstrumentation.java:60(ASM 生成方法体)经 JfrUpcalls::new_bytes_eager_instrumentation(jfrUpcalls.cpp:146;Jfr::is_recording()||force_instrumentation :1406-1428)
- **"~20 JFR-required 类" 无依据**(删除): 只动 Event 子类
- **"JfrJniMethod::start/dump 类方法" 半对**: jfrJniMethod.cpp=JVM_ENTRY_NO_ENV 函数表(jfr_set_output/jfr_set_method_sampling_interval/jfr_emit_event/jfr_end_recording...)
- **"JfrJavaSupport::thread_local_jfr_ref" 编造**: 不存在
- **"JfrDCmd" 编造**: JfrStartFlightRecordingDCmd 等 5 个(jfrDcmds.hpp:30-141);execute(jfrDcmds.cpp:376)=参数翻译→构造 jdk/jfr/internal/dcmd/DCmdStart→JavaCalls run()→Recording.start()→JVM 接口
- **第 4 轮**: 急切注入条件精确化(Jfr::is_recording() 或 force_instrumentation)
- 实证: 32-jfr-jni-instrumentation-demo.txt

### 6.52 34-nmt/01(NMT 追踪系统,34 域 1/2,大纲 9 组漂移含 3 处机制编造 + 深审 2 轮 + 第 3 轮,2026-08-14)
- **"MallocHeader {_size,_flags,_unused,_stack}" 错(重要)**: 真实=**位域打包的两个机器字**(mallocTracker.hpp:246-262,LP64 16 字节): `_size:64/_flags:8/_pos_idx:16/_bucket_idx:40`——**不存调用栈指针,只存 call-site 表索引**(detail 才写);**minimal 级别构造直接 return,header 纯占位连 size 都不写**,release 在 `<= NMT_minimal` 直接跳过(mallocTracker.cpp:68-70)
- **"~30 MEMFLAGS" 错**: `enum MemoryType`(allocation.hpp:114-141)**20 类**+哨兵 mtNone→"Unknown"(nmtCommon.cpp:31-51)
- **"三档 off/summary/detail" 错**: 真实**四档**(nmtCommon.hpp:35-41,off/minimal/summary/detail);minimal=shutdown 后残余态;**transition 只降不升**(memTracker.cpp:164-184 "Upgrading tracking level is not supported");shutdown 只能降到 minimal(:157-162)
- **"NativeCallStack ~4-10 frame" 错**: **固定 4 帧**(NMT_TrackingStackDepth=4,nmtCommon.hpp:45 构建期决策);os::get_native_stack 走帧指针链(os_posix.cpp:120-140)非 backtrace;CURRENT_PC/CALLER_PC 宏**只有 detail 且 NMT_stack_walkable 才真抓栈**(memTracker.hpp:88-91)
- **"VirtualMemoryTracker per-call-site 聚合" 错**: 虚拟内存**不用哈希**——按地址排序的 ReservedMemoryRegion 链表+CommittedMemoryRegion 子链表(每段自己的栈);add 合并相邻同栈(try_merge_with),release 从中间切割(:437-488);ThreadCritical 保护(memTracker.hpp:214)
- **缺机制(重要)**: ①开关经 **launcher 环境变量 NMT_LEVEL_<pid>** 传递(java.c:825-880 putenv;JVM 侧 init_tracking_level memTracker.cpp:58-96 读+unsetenv :84)——参数必须在任何 malloc 前就位;arguments.cpp:3685-3701 双保险;②MallocSiteTable 静态 511 桶(128*4-1),链尾 CAS 插入(:142-185),无删除;表入口分配用伪调用栈防递归(:75-113),最早 os::malloc 来自 C 运行时链接器;③AccessLock 共享/排他(计数器 CAS 成负 min_jint,排他后共享永拒);④**OOM 自动降级 summary**(mallocTracker.cpp:79-90);⑤header 自身记账 tracking overhead(:286);⑥线程栈借 mtThreadStack malloc 计数器记线程数(memTracker.hpp:256-263),committed 用 os::committed_in_range 快照时现测
- **追踪范围**: 只覆盖 os::malloc 通道——JNI 直接 libc malloc 不入账(第 3 轮补)
- **实证方法论**: PrintNMTStatistics 是 diagnostic flag 需 UnlockDiagnosticVMOptions;summary 退出报告直接可当素材;detail 输出 13281 行(截片段);NMT 无 -Xlog 标签;无周期任务(与 20-02 呼应,素材 jcmd-VM.native_memory.txt 的未启用失败输出是"运行期补不开"证据)
- 实证: 34-nmt-tracking-demo.txt

### 6.53 34-nmt/02(NMT 报告与对比,34 域收官,大纲 11 组漂移含 3 处机制编造 + 深审 2 轮,2026-08-14)
- **"MemBaseline::diff(current)" 编造(重要)**: MemBaseline **没有 diff 方法**——diff 在 **reporter 层**: MemSummaryDiffReporter::report_diff(memReporter.cpp:339-365," %+ld" 带符号增量 :367-388/:405-420);MemDetailDiffReporter::report_diff(:626-630)=summary diff+diff_malloc_sites+diff_virtual_memory_sites,**双链归并**(按 (site,type) 排序游标逐对比较 :632-661;MEMFLAGS 变=旧释放+新分配 :705-716)
- **"if (diff > threshold) → potential leak" 编造**: **无任何泄漏阈值判定**——diff 只报增量,人工看
- **"MemReporter::report_site()" 编造**: 真实=MemDetailReporter::report_malloc_sites(:228-249,by_size 降序,显示单位内 0 跳过)/report_virtual_memory_allocation_sites(:251-275)/report_virtual_memory_region(:289-337,整段 committed 标 "reserved and committed",子段与主栈相同不重复 :310-319);detail 报告=summary+虚拟内存地图("Virtual memory map:" :278-287)+Details(:219-226)(memReporter.hpp:136-140)
- **行号漂移**: memReporter.cpp **772 行**(大纲 50-300);memBaseline.cpp 328;nmtDCmd.cpp 216;memReporter.hpp:40-120 → :40-90/:95-120/:125-153/:160+
- **"~30 分类" 错**: 20 类(01 篇已回填);mtThreadStack 跳过并入 Thread 类(report :112-113/report_summary_of_type :127-137: Thread 并栈/NMT 并 tracking overhead)
- **缺机制(重要)**: ①报告=MemTracker::report(memTracker.cpp:209-225)→每次**临时 MemBaseline**(NMTDCmd::report :174-185,报告完即弃);**持久基线仅一份** MemTracker::_baseline(memTracker.hpp:312);②baseline 采集=三快照+类计数(:147-152/:186-187),detail 才 walk 分配点表+虚拟内存聚合 per-site(aggregate :210-231);排序 by_address/by_size/by_site/by_site_and_type(:270-302 惰性重排);③NMTDCmd 8 选项+默认 summary+至多一个(:94-114),off/minimal 检查(:79-85),query_lock 串行化(:117);注册 Management::init(management.cpp:143)三源,命令名 "VM.native_memory"(nmtDCmd.hpp:51);④**scale**: DCmd 默认 KB(nmtDCmd.cpp:58)vs PrintNMTStatistics final_report scale=1 字节(memTracker.cpp:195-207)——素材无后缀证据
- **悬念指向错**: "→ 域35 Diagnostic Commands"过期——writing-order 34→36,正确 36-attach/01(AttachListener+Socket IPC)
- **实证方法论**: jcmd attach 本容器不可用(10500ms 超时);**自 attach 被 JDK 禁止**("Can not attach to current VM",HotSpotVirtualMachine.java:75);diff 真实输出素材缺失→按格式代码布局推导(正文注明);summary/detail 报告结构与素材逐行对照(report_summary_of_type 每个分支对应素材一行)
- 实证: 34-nmt-tracking-demo.txt(补 (A) 段 committed 子段)+ jcmd-VM.native_memory.txt

### 6.54 36-attach/01(AttachListener + Socket IPC,36 域 1/2,大纲 10 组漂移含 4 处机制编造 + 深审 2 轮 + 第 3 轮,2026-08-15)
- **"JVM 启动时创建 socket" 错(重要)**: JDK9+ **attach-on-demand 懒启动**——init_at_startup 默认 false(唯一例外 ReduceSignalUsage,attachListener_linux.cpp:520-526),`-XX:+StartAttachListener`(globals.hpp:2467)强制;启动只 vm_start() 清残留 socket 文件(:460-476,thread.cpp:3936-3943)
- **"SIGQUIT 触发" 半对(机制错)**: 触发=**双条件**——客户端先写 `.attach_pid<pid>` 文件(cwd 优先 fallback /tmp,VirtualMachineImpl.java:76/:282-302)再发 SIGQUIT(:120-126);Signal 线程 SIGBREAK 处理(os.cpp:353-389): transit_state CAS + is_init_trigger 查文件(uid 防伪 :530-560),命中 init(),**未命中继续打印线程转储**——同一信号二义;已初始化短路
- **"COMMAND\narg1=val1\n\n" 协议格式错**: 真实=NUL 分隔 `<ver>0<cmd>0<arg>0<arg>0<arg>0`(:253-258;客户端 writeString UTF-8+NUL :308-321);版本 1,101=BADVERSION;AttachOperation name≤16/3 参/各≤1024(hpp:138-142)
- **"permission 400" 错**: chmod **0600**(S_IREAD|S_IWRITE,:222);bind **`.tmp` 再 rename** 正式路径(:195/:211-228);安全双重=0600+**SO_PEERCRED euid/egid**(:361-372)
- **"unlink 旧 file→create new" 半对**: vm_start() 启动时 stat+unlink 残留;atexit(listener_cleanup) 正常退出清理(:164-177)
- **缺机制(重要)**: ①操作函数表 10 个(attachListener.cpp:324-336: agentProperties/datadump/dumpheap/load/properties/threaddump/inspectheap/setflag/printflag/jcmd);②**jcmd 操作=DCmd::parse_and_execute(DCmd_Source_AttachAPI, op->arg(0), ' ')(:200-212)——34-nmt/02 的 AttachAPI 源就是这条通道**;③线程=JavaThread "Attach Listener"(daemon/system thread group,attachListener.cpp:423-475),入口 attach_listener_thread_entry(:344-406);④状态机 NOT_INITIALIZED/INITIALIZING/INITIALIZED+transit CAS;⑤EnableDynamicAgentLoading 门控 load(:371-374,JDK11u 默认 true globals.hpp:2470,后续版本收紧);⑥DisableAttachMechanism 全关(globals.hpp:2464);⑦客户端 attach 流程(NSpid 解析/findSocketFile/createAttachFile/SIGQUIT/轮询 attachTimeout 默认 10000ms HotSpotVirtualMachine.java:367/checkPermissions/connect);⑧check_socket_file 失效重启(:494-516);⑨complete "result\n"+data(:408-434);⑩每操作独占连接
- **环境事实(重要,修正旧结论)**: 容器常驻 **JMC+VisualVM 自动 attach 新 JVM**(~1.6s,hsperfdata)——"无信号也触发"假象+/tmp 堆积 .java_pid* 残留;os::get_temp_directory() Linux 写死 "/tmp"(os_linux.cpp:1707,不读 TMPDIR);**jcmd 10500ms 超时更可能是目标进程已退出**(34-nmt 的 NMTDemo 3 秒即结束)或 /proc 路径——"容器不支持 attach"旧结论作废
- **实证方法论**: -Xlog:attach=trace 看触发决策("Attach triggered"/"Failed to find attach file");touch 文件+SIGQUIT 对照实验(信号二义);strace -f -e trace=stat 看服务端文件访问;pgrep 会抓到 bash(命令行含同串)——用程序自打印 pid
- 实证: 36-attach-trigger-demo.txt

### 6.55 36-attach/02(JDK Attach API + loadAgent,36 域收官,大纲 9 组漂移含 3 处机制编造 + 深审 2 轮,2026-08-15)
- **"jdk.attach 是纯 C library / JVM_AttachCurrentThread" 编造(重要)**: `JVM_AttachCurrentThread` **零命中**;真实=jdk.attach 模块三层=公共 API com.sun.tools.attach(VirtualMachine 抽象/AttachProvider/异常)+内部 sun.tools.attach(HotSpotVirtualMachine 基类 :48-406+平台 VirtualMachineImpl)+native libattach(VirtualMachineImpl.c);src/jdk.attach/share/classes 等
- **"write 'COMMAND\narg1=val1\n\n'" 协议格式错**: JDK11=NUL 分隔(01 篇已回填);客户端 execute :145-231/:308-321,读回 completionStatus int,101 特判 "Protocol mismatch",load 特判 AgentLoadException(:203-227)
- **"loadAgent → cmd='load'" 半对(重要)**: 两条形态——**native .so** 走 loadAgentLibrary/loadAgentPath→execute("load", path, isAbsolute, options)(:86-129);**Java JAR** 的 loadAgent("jar", opts)(:135-172)拼 "jar=opts" 后 **loadAgentLibrary("instrument", ...)**——加载 JPLIS(instrument 库)再调 agentmain,错误码翻译 ATTACH_ERROR_BADJAR=100/NOTONCP=101/STARTFAIL=102(:177-180);**loadAgent 名字误导性——只接受 JAR**
- **"attachListener.cpp:200-400" 行号错**: load_agent 在 attachListener.cpp:**108-135**;JvmtiExport::load_agent_library(jvmtiExport.cpp:2638-2722)
- **"dlopen RTLD_LAZY" 半对**: os::dll_load(os_linux.cpp:1872+)=dlopen 封装,先查 noexecstack(禁栈守卫→VM_LinuxDllLoad VM 操作 safepoint 修复);dlsym=os::find_agent_function(os.cpp:574-610)按 AGENT_ONATTACH_SYMBOLS={"Agent_OnAttach"}(jvm_md.h:45)
- **"Agent_OnLoad 不作为" ✓**: attach 只调 Agent_OnAttach;启动 -agentpath/-agentlib 走 Agent_OnLoad(create_vm_init_agents thread.cpp:4209-4237,失败 vm_exit;attach 失败回错误码客户端);同库可同时导出两符号
- **缺机制(重要)**: ①VirtualMachine.attach 遍历 AttachProvider.providers(VirtualMachine.java:194-215),provider name="sun"/type="socket";②**自 attach 门控**: jdk.attach.allowAttachSelf 默认 false,pid==CURRENT_PID 抛 "Can not attach to current VM"(HotSpotVirtualMachine.java:56-57/:72-76)——34-nmt/02 的 AttachSelf 失败根因,本篇加属性成功;③**"return code: N" 协议**(jvmtiExport.cpp:2708)→客户端解析→非 0 抛 AgentInitializationException(:93-110)——注意 load 操作 completionStatus 恒 0(load_agent 返回 JNI_OK),agent 错误在输出流;④JNI_OK→Arguments::add_loaded_agent→退出 shutdown_vm_agents 调 Agent_OnUnload(thread.cpp:4230-4256);⑤第三通道 DCmd JVMTIAgentLoadDCmd "JVMTI.agent_load"(diagnosticCommand.cpp:315-353,.jar 分流)也调 load_agent_library——jcmd 工具即走此路;⑥API→操作名映射表(startManagementAgent→"ManagementAgent.start" DCmd :226-238)
- **实证方法论**: **自 attach 是可行实证路径**(-Djdk.attach.allowAttachSelf=true)——全链路验证(Java API→NUL 协议→socket→load 操作→dlopen→dlsym→Agent_OnAttach);自写 JVMTI agent(gcc -shared -fPIC);失败 agent(return -1)验证 AgentInitializationException;properties/DCmd 走 attach 通道一并验证
- 实证: 36-attach-loadagent-demo.txt

### 6.56 37-heap-dumper/01(HeapDumper + hprof,37 域 1/2,大纲 11 组漂移含 2 处机制编造 + 深审 2 轮,2026-08-15)
- **"ID 不是 address——递增序列号" 编造(重要)**: JDK11 `write_objectID` **直写 oop 地址**(heapDumper.cpp:526-533);class ID=java mirror 地址(:553-555);符号 ID=Symbol 指针(:535-542)——地址作 ID 正是必须 safepoint 的原因;大纲"跨 dump 追踪/ID 占 2GB"删除
- **sub-record 格式与标准 hprof spec 不同(重要,实证逐字节验证)**: ①CLASS_DUMP(0x20)=`id + u4 STACK_TRACE_ID + id×6 + u4` + 描述符(dump_class_and_array_classes :994-1033)——**无 u4 class serial**;②INSTANCE_DUMP(0x21)=`id object + u4 stid + id class + u4 size + 字段值`(dump_instance :969-987);③OBJ_ARRAY/PRIM_ARRAY 均带 u4 STACK_TRACE_ID(:1145-1159/:1179-1193);STACK_TRACE_ID=常量 1(:373);④sub-record 头 **9 字节**(u1 tag+u4 time+u4 len)非 5 字节
- **行号漂移**: heapDumper.hpp 仅 83 行(格式注释在 **heapDumper.cpp:52-130**);HeapDumper::dump **:1931-1984**(非 1931-2100);doit :1775-1806;work :1809-1894;文件总 2112 行
- **"VM_HeapDumper 是 VM_Operation" 半对**: 真实=**VM_GC_Operation+AbstractGangTask**(:1477);GC 在 **doit() 内 collect_as_vm_thread(GCCause::_heap_dump)**(:1786),GCLocker 活跃跳过+warning(:1781-1784);ensure_parsability 必须先于遍历(:1778);WorkGang 并行(VM 线程遍历,worker 线程 writer_loop 只写 :1813-1815/:1796-1801)
- **"DumperWriter" 名字错**: 真实=**DumpWriter**(:380)+AbstractWriter/CompressionBackend
- **缺机制(重要)**: ①段分割=start_sub_record(:575-603): 段头 1C+u4(0)+u4(len) **动态回填**,放不下/超大时 finish_dump_segment 开新段;HEAP_DUMP_SEGMENT=0x1C/END=0x2C(:307-342);②work() 顺序(UTF8→LOAD_CLASS→FRAME/TRACE→CLASS_DUMP→safe_object_iterate→THREAD_OBJ→MONITOR→JNI_GLOBAL→**STICKY_CLASS=null class loader 类** :1883-1887→END);③do_object 跳过 Class 对象(:1451-1457)+CDS dormant(:1459-1461);④压缩 GZipCompressor(:1940-1944);⑤"Heap dump file created [N bytes in X secs]"(:1969-1973);⑥OOME 路径(_oome 假帧)
- **实证方法论**: **HotSpotDiagnostic.dumpHeap 免 attach 触发**(com.sun.management.internal,jmm_DumpHeap0 management.cpp:1901-1920)——需 -Dcom.sun.management.jmxremote.port=0 加载 libmanagement 否则 UnsatisfiedLinkError;python 解析 hprof(顶层/段内记录均 9 字节头;CLASS_DUMP 64 字节头无 serial;live 对照验证 GC);**JDK 的 sub-record 与 hprof 标准 spec 有差异——以源码为准**
- 实证: 37-heap-dumper-demo.txt

### 6.57 37-heap-dumper/02(流式压缩 + 多触发入口,37 域收官,大纲 11 组漂移含 2 处机制编造 + 深审 2 轮,2026-08-15)
- **"deflater 在 safepoint 外异步压缩" 错(重要)**: 压缩在 **WorkGang worker 线程**(thread_loop :277-303)与遍历并行但**全程在 safepoint 内**(VM_Operation run_task STW);顺序=_finished.add_by_id 按块 id 写(finish_work :461-482);无线程时 VM 线程同步压(thread_loop(true) :259-261);无 temp 文件 ✓
- **"JFR: GC 事件 → JfrEmergencyDump → HeapDumper::dump" 编造(重要)**: JfrEmergencyDump 是 **JFR 录制数据**应急转储,与 heap dump 无关;JDK11 JFR 无 heap dump 集成
- **"GZipCompressor 是 DumpWriter 子类" 错**: 继承 **AbstractCompressor**(heapDumperCompression.hpp:81);DumpWriter 组合 **CompressionBackend**(块队列/worker);管线=DumpWriter(缓冲)→CompressionBackend(get_new_buffer :381-444)→FileWriter;flush=backend.get_new_buffer(heapDumper.cpp:496-498)
- **"jcmd → JMM_DumpHeap0" 错**: jcmd 的 GC.heap_dump 走 **HeapDumpDCmd**(diagnosticCommand.cpp:510-544,注册 :92;filename **位置参数**;-all/-gz 1-9 默认 1/-overwrite);JMM_DumpHeap0 是 **JMX** 入口(management.cpp:1901-1920)
- **"四路触发" 不全**: 真实**五路**——①attach dumpheap②DCmd GC.heap_dump(唯一压缩路)③JMX dumpHeap④OOM(HeapDumpOnOutOfMemoryError globals.hpp:660 默认 false→report_java_out_of_memory debug.cpp:322-337 **cmpxchg 只报一次**→dump_heap_from_oome :2023-2025→dump_heap(true) java_pid<pid>.hprof+HeapDumpPath+.<seq> :2032-2111,**不做 GC** :2108)⑤GC 前后(HeapDumpBeforeFullGC/AfterFullGC→full_gc_dump collectedHeap.cpp:514-528)
- **行号漂移**: heapDumperCompression.cpp **477 行**(大纲 70-140): load_gzip_func :77-91(dlsym libzip 的 ZIP_GZip_Fully/InitParams);init :93-119(+1024 注释空间 :116);compress :121-139
- **"找不到 libzip→fallback 无压缩" 半对**: dlsym 失败→init 错误消息→set_error→**dump 报错**(非静默降级);压缩器 NULL 才直写(finish_work :471-472)
- **缺机制(重要)**: ①gzip 第一块带 **"HPROF BLOCKSIZE=..." 注释**(:125-132;实证 1f8b 0810 FCOMMENT);②实测压缩比 ~12x(1318476 vs 15430735);③OOM dump 顺序=OOM 消息→dump→异常;④64MB 堆→34MB dump
- **悬念指向错**: "→ 域38 PerfData" 过期(38 域已完结);正确 **39-runtime-monitoring/01**(目录名 monitoring!)
- **实证方法论**: **自 attach+executeJCmd 是 jcmd 通道实证路径**(--add-exports jdk.attach/sun.tools.attach=ALL-UNNAMED+cast HotSpotVirtualMachine);GC.heap_dump filename=位置参数;executeJCmd 返回流需消费读输出
- 实证: 37-heap-dumper-gzip-oome-demo.txt

### 6.58 39-runtime-monitoring/01(ServiceThread,39 域 1/2,大纲 9 组漂移含 3 处机制编造 + 深审 2 轮,2026-08-15)
- **"低优先级——不会抢 GC worker CPU" 错(重要)**: initialize 里 **NearMaxPriority**(serviceThread.cpp:74)——prio=9 高优先级(实证 20-background-init-demo.txt "Service Thread" #5 daemon prio=9)
- **"~10 种 deferred tasks" 无依据**: 真实 **5 个条件/任务**(service_thread_entry :84-143): LowMemoryDetector 传感器/JVMTI deferred 事件/GC 通知/DCmd 通知/StringTable 清理
- **"JFR periodic tasks/OopStorage cleanup" 错**: ServiceThread 不做这两类(32 域已证 JFR=RequestEngine+SuspendedThreadTask;OopStorage 清理是 GC/Storage 自己的生命周期)
- **行号漂移**: serviceThread.cpp **179 行**(大纲 50-100/:100-200): initialize :45-82;service_thread_entry :84-143;enqueue_deferred_event :145-153;oops_do/nmethods_do :155-179
- **主循环 ✓ 半对**: ThreadBlockInVM(:102,注释 :94-100)+Service_lock 下 **5 条件一次性检测**(:105-109)→wait(:112)→锁外处理(:122-141);JVMTI 事件**锁内 dequeue(:117)锁外 post(:126-129)**;检测与 wait 同锁防丢失唤醒
- **缺机制(重要)**: ①StringTable::trigger_concurrent_work(stringTable.cpp:226-230);触发=check_concurrent_work(GC 后 dead/load 因子 :520-535)+try_rehash_table(:587/:594);concurrent_work(:539-549)load 高且未满 grow 否则 clean_dead_entries;②GC 通知=GCMemoryManager::gc_end pushNotification(memoryManager.cpp:295)→GCNotifier 链表(gcNotifier.hpp:33-60)→sendNotification 清异常防线程终止(gcNotifier.cpp:165-172);③DCmdFactory::send_notification 同清异常(diagnosticFramework.cpp:445-452);④LowMemoryDetector::has_pending_requests 遍历 MemoryPool usage_sensor(lowMemoryDetector.cpp:41-51);⑤启动=create_vm thread.cpp:3960;⑥oops_do 保持 deferred 事件存活(:155-167)
- **实证方法论**: 20-02 素材线程转储复用("Service Thread" prio=9 行);WatcherThread 对照("VM Periodic Task Thread")
- 实证: 20-background-init-demo.txt(复用)

### 6.59 39-runtime-monitoring/02(Timer + Monitoring Services,39 域收官,大纲 10 组漂移含 3 处机制编造 + 深审 2 轮,2026-08-15)
- **"timer.hpp/cpp 在 utilities/" 目录错**: 真实 **share/runtime/timer.hpp**(99 行)+timer.cpp(176 行)
- **"TraceTime 在 timer.cpp" 错(重要)**: TraceTime 在**独立文件 share/runtime/timerTrace.hpp**(80 行);**输出走统一日志框架**(TraceTimerLogPrintFunc+TRACETIME_LOG 宏,log_is_enabled 检查,:57-59),**非"tty->print"**;三构造,支持 accumulator 累计+suspend/resume
- **"GC phases 用 TraceTime" 错(重要)**: GC 用 **GCTraceTimeImpl**(gcTraceTime.hpp:46-65,基于 Ticks/utilities/ticks.hpp)+GCTraceCPUTime/GCTraceConcTimeImpl;实证 gc+phases "Phase 1: Mark live objects 3.412ms"
- **"os::elapsed_counter 在 timer.cpp" 错**: 在 **os_linux.cpp:1435-1437**(=javaTimeNanos()-initial_time_count,initial 设于 :5565);javaTimeNanos :1555-1569=**CLOCK_MONOTONIC clock_gettime**(dlsym 加载 :1489-1491 规避旧 glibc),fallback gettimeofday;elapsed_frequency=NANOSECS_PER_SEC
- **"三个 service 数据来自 ClassLoaderDataGraph/Safepoint/Thread-SMR" 半对(重要)**: 数据=**PerfData 计数器**(38 域): ClassLoadingService=PerfCounter 对,loaded_class_count=普通+共享(:62-65);**更新=类加载/卸载事件钩子**(notify_class_loaded classLoadingService.cpp:148-166,classFileParser.cpp:5772/systemDictionary.cpp:1370;unloaded instanceKlass.cpp:2428)——非"safepoint 数一遍";RuntimeService=PerfCounter+TimeStamp,record_safepoint_begin/end(runtimeService.cpp:87+),JMX 读口 management.cpp:916/919/925;ThreadService=PerfCounter/PerfVariable+**原子计数**(live/daemon 读 _atomic_*,hpp:98-101)
- **悬念指向错**: "→ 域40 Launcher" 过期(40 是第 7 批);正确 **46-sa-postmortem**(第 5 批收官域)
- **实证方法论(重要环境修正)**: **jstat 直接读 hsperf 文件无需 attach**(jstat -class Loaded 1841);**jcmd attach 在容器可用**——之前实验已触发 listener,socket 文件存在,jcmd GC.run 成功——36 域"jcmd 不可用"结论再次修正(listener 启动后即可用);gc+phases 日志=jcmd GC.run 触发
- 实证: 39-runtime-monitoring-timer-demo.txt

### 6.60 46-sa-postmortem/01(SA Postmortem,第 5 批收官域,大纲 9 组漂移含 2 处机制编造 + 深审 2 轮,2026-08-15)
- **"core_lookup 线性扫描 O(n)/linked list" 错(重要)**: 真实=**map_array 排序指针数组+二分**(core_lookup ps_core.c:153-175,注释 "We keep a sorted array of pointers in ph->map_array, so we can binary search";sort_map_array :382-421 链表→数组→qsort)——O(log n);completeness 问 6 的"链表 vs 红黑树"基于错误前提
- **"add_map_info linked list prepend O(1)" ✓**(:124-134),lookup 走 map_array 二分
- **"symtab 线性遍历" 错(重要)**: 构建时 **hcreate_r 哈希**(symtab.c:416-432,n*1.25),查找 **hsearch_r O(1)**(search_symbol :569-587,base+sym->offset :583);符号 section 默认 **SHT_DYNSYM** 发现 **SHT_SYMTAB 优先**(build_symtab_internal :329+)
- **"lookup_symbol 找 libjvm.so" 半对**: 真实=**忽略 object_name 全局搜所有库**(libproc_impl.c:215-238,注释原文)
- **"debuginfo-install" 半对**: 真实=**.gnu_debuglink 段**(build_symtab_from_debug_link :261)/**NT_GNU_BUILD_ID note**(build_symtab_from_build_id :305)
- **源码位置**: jdk.hotspot.agent/linux/native/libsaproc/(非 hotspot/agent/);ps_core.c 1134/ps_proc.c 527/symtab.c 607/LinuxDebuggerLocal.c 584
- **缺机制(重要)**: ①verifyBitness(LinuxDebuggerLocal.c:196-210,/proc/<pid>/exe,失败 "cannot open binary file");②core_read_data(ps_core.c:431-465): pread 段内偏移+分数页补零;③class_share_maps CDS 兜底(:189-200);④ps_prochandle 统一 core/live;⑤attach0(:251) Pgrab 在 **ps_proc.c:450**;⑥Pgrab=ptrace_attach(PTRACE_ATTACH+waitpid SIGSTOP :275-292)+maps 解析+fillThreadsAndLoadObjects
- **实证方法论**: **jhsdb 双模式实证**(活进程 ptrace + gcore 19GB core 离线)——容器 gcore 可用(core_pattern=core);**attach 失败排查**: 目标进程退出→/proc/<pid>/exe 消失→"cannot open binary file"(NMTDemo 3 秒退出教训,用 SleepDemo);jstack 解 Interpreted frame 证明 ptrace 读栈
- 实证: 46-sa-postmortem-demo.txt

### 6.61 14-c1-compiler/01(C1 管线 + HIR,第 6 批开篇,大纲 9 组漂移含 3 处机制编造 + 深审 2 轮,2026-08-15)
- **"c1_Compiler::compile_method 6 步管线" 错(重要)**: 入口 Compiler::compile_method(c1_Compiler.cpp:246)**只构造 Compilation 对象**;管线在 c1_Compilation.cpp: compile_method(:429)→compile_java_method(:370)=**三大步**——build_hir(:141-258: GraphBuilder→optimize_blocks(UseC1Optimizations :179)→split_critical_edges→compute_code→GVN→RangeCheckElimination(非 OSR)→eliminate_null_checks→compute_use_counts)/emit_lir(:252-278: LIRGenerator :256+LinearScan do_linear_scan :270-276)/emit_code_body+install_code(:410 register_method)
- **"Canonicalizer 独立 step" 错(重要)**: 在 **GraphBuilder::append_with_bci 内联即时调用**(c1_GraphBuilder.cpp:2299-2306);独立优化=optimize_blocks/GVN/RangeCheckElimination
- **"iload→创建 LoadLocal" 错**: load_local(:935-940)=**push(state()->local_at(index)) 直接取 Value**,零成本;Local 是占位(:697)
- **"BlockBegin 类头" 半对**: LEAF(BlockBegin, StateSplit)(c1_Instruction.hpp:1601),SSA 字段 _successors/_predecessors/_end(:1619-1625);类层次用 **LEAF/BRANCH 宏**(Phi :641/Local :697/Constant :724/ArithmeticOp :1060/Invoke :1243/NewInstance :1292/Goto :1859/If :1970/Return :2149/Throw :2171/Base :2190);Value=Instruction*(:117)
- **行号漂移**: c1_GraphBuilder.cpp **4428 行**(大纲 200-1000);c1_Instruction.hpp 2632
- **缺机制(重要)**: ①BlockListBuilder 预扫描(make_block_at :152+);②append_with_bci 的 LVN(vmap :2308-2319)+InstructionCountCutoff bailout(:2328)+StateSplit 状态拷贝/异常边(:2336-2351);③**Phi=ValueStack::setup_phi_for_stack/local**(c1_ValueStack.cpp:178-191,块合并,栈槽负索引);④If/Goto/Return/Throw 创建(:1227/:1208/:1599/:2275);⑤invoke(:1841);⑥bailout 家族
- **实证方法论**: **PrintIR/PrintLIR/PrintCFG 是 notproduct**(release 无);用 **PrintCompilation**(product)与 -Xlog:jit+compilation 看编译事件(compile_id/层级/OSR %/made not entrant);HIR 图只能源码推演
- 实证: 14-c1-pipeline-demo.txt

### 6.62 14-c1-compiler/02(C1 优化,14 域 2/4,大纲 10 组漂移含 4 处机制编造 + 深审 2 轮,2026-08-15)
- **"Canonicalizer 多趟/pass1→pass2" 错(重要)**: 真实=**单遍即时**——构造时 if (CanonicalizeNodes) x->visit(this)(c1_Canonicalizer.hpp:58-60)一次 visit;x+0+0 是两次 append 各即时化简,"两趟收敛"编造
- **"x*1→x, x/x→1" 错**: x==y 分支只有 isub/iand/ior/ixor(:78-91,无 x/x);imul 常量 1/2/4/8→**log2_scale 移位**(:960-977,LP64 仅 lmul),x*1=移位 0 在 LIR 阶段消
- **"if(true)→Goto" 半对**: do_If(:712+): If(a cond a)→Goto(:719-737)/双常量→Goto(:739-749)/CompareOp 化简(:750+)
- **"getter/setter 方法内联" 编造**: Canonicalizer 无内联;内联是 GraphBuilder/Compilation 的活
- **"C1 不做 escape analysis" 错(重要)**: C1 有**浅层 escape=bcEscapeAnalyzer**(12-02 已证);不做 loop unswitching/标量替换
- **ValueMap ✓ 半对**: find_insert(c1_ValueMap.cpp:109-149): hash=0 排除/链表 is_equal/**跨块 pin**(:130-136)/扩容(:139);hash=HASHING1/2/3 宏(c1_Instruction.hpp:243-271);使用=LVN(append)+GVN(全局)
- **Optimizer ✓**: eliminate_null_checks(c1_Optimizer.cpp:1155,NullCheckEliminator :553);RangeCheckElimination 独立文件(c1_RangeCheckElimination.cpp:46,**has_access_indexed 才做**)
- **flag 盘点(实证关键)**: RangeCheckElimination=product(globals.hpp:1369)/CanonicalizeNodes+UseLoopInvariantCodeMotion=product;**UseC1Optimizations/UseLocalValueNumbering/UseGlobalValueNumbering/EliminateNullChecks 全 develop**(c1_globals.hpp:90/:105/:108/:146)→release 关不掉
- **实证方法论**: PrintAssembly 无 hsdis 只输出 nmethod header(main code 尺寸可比较:C1 352>C2 224);flag 类型决定能否开关对照
- 实证: 14-c1-optimizations-demo.txt

### 6.63 14-c1-compiler/03(LinearScan + LIR → x86 码,14 域 3/4,大纲 10 组漂移含 2 处机制编造 + 深审 2 轮,2026-08-15)
- **"Interval: [start, end]" 半对(重要)**: 真实=Interval 由 **Range 链表**组成(c1_LinearScan.hpp:455-470,Range 的 _from/_to/_next;Interval :501+)——活跃段可不连续;Interval 挂 _assigned_reg/_register_hint(:563)/_current_split_child/_canonical_spill_slot
- **"spill 选择 end 最远的 Interval" 半对**: 真实=**find_locked_reg 选 _use_pos 最晚的寄存器**(c1_LinearScan.cpp:5504-5524)——占用者下次使用前空闲最长
- **"peephole: 相邻 move 消除" 编造(重要)**: x86 **peephole 空实现**(c1_LIRAssembler_x86.cpp:3994,注释 "sparc uses this for delay slot filling");真正 LIR 优化=**EdgeMoveOptimizer+ControlFlowOptimizer**(c1_LinearScan.cpp:3152-3155)
- **"x86 FpuStack ST0-ST7" 半对**: allocate_fpu_stack(c1_LinearScan_x86.cpp:35)仅 **x87 模式**(use_fpu_stack_allocation),x86_64 默认 SSE
- **行号漂移**: c1_LinearScan.cpp **6800 行**(大纲 400-800 严重低估);hpp 963;LIRAssembler.cpp 867
- **缺机制(重要)**: ①do_linear_scan(:3100-3130)全流程;②activate_current(:5792-5855): 栈槽起始 split+load(:5802-5812)/combine_spilled→alloc_free 或 alloc_locked(:5834-5840);③split_for_spilling(:5227);④resolve_data_flow 块边 move;⑤LIR_Assembler emit_code(:214)→emit_lir_list(:268)→emit_op0/1/2(:598/:504/:695)
- **实证方法论**: TraceLinearScanLevel 是 develop 不可用;PrintAssembly 无 hsdis 只给 nmethod 布局(C1 main code 352>C2 224,复用 02 篇)
- 实证: 14-c1-register-codegen-demo.txt

### 6.64 14-c1-compiler/04(Runtime1 + FrameMap,14 域收官,大纲 10 组漂移含 2 处机制编造 + 深审 2 轮,2026-08-15)
- **"new_instance(ciKlass*)" 半对(重要)**: 签名=(JavaThread*, **Klass***)(c1_Runtime1.cpp:346,非 ciKlass);**JRT_ENTRY 家族**(08-03 已证 IRT/JRT 之别);结果经 **set_vm_result TLS 返回**(:358,非 return oop);**慢路径语义**(_new_instance_slowcase_cnt,TLAB 快速路径编译代码内联)
- **"monitorenter→ObjectSynchronizer::fast_enter" 半对**: 真实=**SharedRuntime::monitor_enter_helper/monitor_exit_helper**(c1_Runtime1.cpp:693-716);monitorexit=JRT_LEAF
- **"OopMap 在 FrameMap" 错(重要)**: OopMap **在 LinearScan 构建**(init_compute_oop_maps c1_LinearScan.cpp:2415/compute_oop_map :2432);FrameMap 只给槽偏移
- **行号**: c1_Runtime1.cpp 1494;hpp 202;x86 1604;StubID=RUNTIME1_STUBS 宏(hpp:40-65+);generate_blob(:194) stub 进 CodeCache;patch_code(:834/:1271)懒链接
- **实证方法论**: 慢路径计数 NOT_PRODUCT release 不可观察;-XX:-UseTLAB 间接对照;nmethod header 的 stub code/oops/metadata 段(PrintAssembly 无 hsdis)
- 实证: 14-c1-runtime-frame-demo.txt

### 6.65 15-c2-compiler/01(C2 Ideal Graph,15 域开篇,大纲 13 处漂移含 3 处机制编造 + 深审 2 轮 + 第 3 轮,2026-08-15)
- **"Ideal() 返回 this(NOP=无优化)" 错(重要)**: 返回**NULL=无变化**(默认实现 node.cpp:1144-1146);**改了图必须返回新根**(原地改输入也返回 this);**禁止返回旧节点**(返回旧节点必须走 Identity,node.cpp:1100-1138 "treatise" 注释)——IGVN 对 Ideal 返回值继续循环理想化,对 Identity 返回值直接替换
- **"AddNode 无 in(0)" 错**: `Node(0,in1,in2)` 第一个参数是 **NULL 控制槽**(addnode.hpp:44,3 个 required 槽: in(0)=NULL/in(1)=a/in(2)=b)——控制无关节点 in(0) 恒 NULL 可浮动(loopopts.cpp:1379 "has no control edge (can float about)"),控制敏感节点(Region/If/Load/Store)in(0) 放控制边;**MemNode 内存边是专属槽**(memnode.hpp:52-58 enum Control/Memory/Address/ValueIn)
- **"igvn.cpp:100-200" 文件不存在**: JDK11 无 igvn.cpp;NodeHash::hash_find_insert 在 **phaseX.cpp:143-198**(req+Opcode+逐 in+cmp 全等才算命中)
- **"transform 三环(Ideal→Value→Identity)" 不全(重要)**: 真实 **transform_old 五步**(phaseX.cpp:1283-1402): ①Ideal 循环(返回 NULL 停,每次把旧节点用户入队)②Value 重算类型(变窄→set_type+raise_bottom_type+用户入队)③**singleton→makecon 换常量**④apply_identity ⑤**hash_find_insert 全局 CSE**;大纲漏③⑤
- **"IGVN 第一轮折叠 x+0/x*1" 错(重要)**: 折叠在 **Parse 期单遍 PhaseGVN::transform_no_reclaim 就发生**(phaseX.cpp:864-924 同款流程无 worklist;AddNode::Identity addnode.cpp:56-61/MulNode::Identity mulnode.cpp:52-61;parse2.cpp:2252 每字节码 _gvn.transform)——图中根本不会出现 AddI(x,0);IGVN 的价值=worklist 迭代到不动点+全局值编号+can_reshape 结构改写
- **"TypePtr(NULL).meet(NotNull)→Ptr 放弃 nullness" 错(重要)**: ptr_meet 表(type.cpp:2460-2468)**Null∩NotNull=BotPTR(空集=矛盾)**——C2 用类型矛盾判死路径;名字是 **NOTNULL**(type.hpp:919)非 NotNull
- **"子类覆写 meet_helper" 错**: 覆写的是 **xmeet**(type.hpp:241 虚函数);meet→meet_helper(type.cpp:848,处理 narrowoop/narrowklass+speculative)→xmeet 分派;同格指针 meet: 不同类退 NotNull+类 LCA(:3977-3986)、不同常量退 NotNull(:3963-3972)
- **行号漂移**: type.hpp Type 类 :74(大纲 48-230 旧范围)、TOP/BOTTOM :412-421、TypeInt :537、TypePtr :813;node.hpp Node :210 ✓ 对
- **缺机制(重要)**: ①节点内存=node_arena+**delete 是 NOP**(node.hpp:231-240);②`_cnt`=required 输入数/`_max`=数组长度(:291/:293);③身份=Opcode()(node.hpp:786,classes.hpp 宏表生成 opcodes.hpp:31-49)+class_id/_flags 位(node.hpp:736-760)+DEFINE_CLASS_QUERY 位掩码查询(:792-800);④TypeInt::make hash-cons(type.cpp:1429-1449+707-745)类型唯一不可变→比较=指针相等;TypeInt::xmeet "Expand covered set"(:1487-1489);xdual 翻转 hi/lo(:1494-1497);⑤PhiNode::Value 起点 TOP 逐路 meet(cfgnode.cpp:918-1009);⑥optimize 守卫: NodeLimitFudgeFactor(c2_globals.hpp:471)+**K=1024×live_nodes 死循环判定**(globalDefinitions.hpp:255,phaseX.cpp:1235);⑦worklist 初值=Parse 期 for_igvn(compile.cpp:757+phaseX.cpp:992-993);NodeHash 75% 扩容(phaseX.hpp:82-83);subsume_node 剪边重连(:1527);⑧**IGVN 在 Optimize 中 6 处运行**(compile.cpp:2247-2254 Parse 后/:2321 EA 后/:2332 宏消除后/:2388-2391 CCP 后/:2424 range-check cast 后/:2454 opaque4 后)
- **实证方法论(重要)**: ①PrintIdeal/PrintIdealGraph **notproduct** release 拒启(报错原文 "is notproduct and is available only in debug version of VM");②**PrintOptoAssembly diagnostic 但标志处理与 dump 全在 #ifndef PRODUCT**(compile.cpp:718-733/output.cpp:1554-1558)——release 接受但静默,别被"diagnostic"骗了;③可用: -Xlog:jit+compilation=debug(product)编译事件(level/b 标志/OSR %/made not entrant)、-XX:+CITime 阶段树(product)、PrintInlining(diagnostic);④常量折叠 javac 层就做(50 个 1+1+… → bipush 50 3 字节,实证第 7 段)——演示 C2 折叠要防 javac 先折
- **第 3 轮新增**: ①PhiNode::Value 的 meet 循环实际调 **meet_speculative**(cfgnode.cpp:1007,"meet()"表述不精确);②Parse 末尾先 **PhaseRemoveUseless**(compile.cpp:841-844)再 Optimize——"Parse 一结束立刻 IGVN"忽略中间步骤;③check_node_count 是 **live_nodes+margin > max_node_limit**(compile.hpp:907-914),optimize 传 NodeLimitFudgeFactor×2 余量,不是"总量超 NodeLimitFudgeFactor";④AddNode::Identity 是**对称双侧检查**(addnode.cpp:56-61 两个 if);⑤实证表述: jit+compilation 显示的是**编译事件**(含 C1),cfold 是"level 1 为止"非"就够"(推断词);⑥大纲 ⚠️ 块格式统一为 `> 块级引用+列表`(3 块 13 条,与 14-c1 域一致),HANDOFF 计数修正
- 实证: 15-c2-ideal-graph-demo.txt

---

### 6.66 15-c2-compiler/02(Parse + GraphKit,15 域 2/8,大纲 15 处漂移含 4 处机制编造 + 深审 2 轮,2026-08-15)
- **"iload→do_load→LocalNode" 编造(重要)**: 无 do_load/LocalNode;iload 系列直接 `push(local(n))`(parse2.cpp:2014-2033)——局部变量 Value 压栈零成本(与 14-c1/01 的 load_local 同构)
- **"do_arith()/do_inline()/add_node()" 全编造**: 算术在 do_one_bytecode switch 内联建节点(iadd :2250-2253);内联递归=**ParseGenerator::generate→`Parse parser(jvms, method(), _expected_uses)`**(callGenerator.cpp:84-111);GraphKit 无 add_node——建节点=`_gvn.transform(new XxxNode)`+record_for_igvn,连边=构造显式传参
- **文件归属错**: do_call 在 **doCall.cpp:423**(非 parse1.cpp:800-1200);do_field_access 在 **parse3.cpp:76**(非 parse2.cpp:200-500)
- **"MaxInlineDepth=9" 错**: 真实 **MaxInlineLevel=15**(globals.hpp:1692);深度检查 inline_level()>MaxInlineLevel→"inlining too deep"(bytecodeInfo.cpp:400-407);**计数=inline_level()=caller_jvms->depth()**(parse.hpp:96-97)——实证 16 层内联、第 17 层报错
- **"C1 只 inline tiny methods(size<35, depth≤2)" 错(重要)**: C1 同样用 MaxInlineSize/MaxInlineLevel/MaxRecursiveInlineLevel(c1_GraphBuilder.cpp:3801-3803)+**NestedInliningSizeRatio=90% 逐层衰减**(c1_globals.hpp:177,:700-705)——实证 C1 树 7 字节 d6 也 "callee is too large"(35 逐层乘 0.9 并 (intx) 截断,13 层后≈6<7)
- **"gvn() → PhaseIterGVN&" 错**: **PhaseGVN&**(graphKit.hpp:93)——Parse 期单遍 GVN,IGVN 在 Parse 后
- **"SafePointNode 记录 OopMap" 错位(重要)**: parse 期 safepoint 捕获 **JVMState**(locals/stack/monitors 作为节点,add_safepoint_edges graphKit.cpp:842);机器 OopMap 在**寄存器分配后** BuildOopMaps 构建(buildOopMap.cpp:566,注释 :39 "after all scheduling is done")
- **缺机制(重要)**: ①**块驱动非线性读**: do_all_blocks RPO(parse1.cpp:632-733)→do_one_block(:1465)→do_one_bytecode(:1529),ciTypeFlow 先行(parse1.cpp:427→ciMethod.cpp:352-359);②决策链=Compile::call_generator(doCall.cpp:65): intrinsic→MH→ok_to_inline(bytecodeInfo.cpp:547)→should_inline(:115)/should_not_inline+WarmCallInfo;③大小门槛 MaxInlineSize=35(globals.hpp:1710)+高频放宽 **FreqInlineSize=325**(c2_globals_x86.hpp:47,bump :170-182),"too big"/"hot method too big"(:191-198);④递归 MaxRecursiveInlineLevel=1(:436-439);⑤GraphKit 核心=SafePointNode* _map(graphKit.hpp:64)+JVMState 槽位布局 loc/stk/arg/mon/scl(callnode.hpp:230-238);⑥**MergeMem 多切片内存**(memnode.hpp:1403+,memory_at/set_memory_at :1423-1430,AliasIdxBot base/AliasIdxTop 哨兵 :1432-1436),memory(alias_idx)(graphKit.cpp:1477-1482);⑦add_safepoint(parse1.cpp:2234)四件事: Call/SafePoint 后去重(:2246-2251)/MergeMemNode 克隆内存(:2273-2275)/轮询地址 thread-local polling_page_offset 或全局页(:2286-2296)/add_safepoint_edges 挂 JVMState 链(:2299)+root prec 保活(:2305-2308);⑧异常双路 do_exceptions(:905-932)=throw_to_exit(无 handler)/catch_inline_exceptions(有 handler);⑨OSR: StartOSRNode(callnode.hpp:91-98)+load_interpreter_state(parse1.cpp:570-574)+OSR 专用 tf(:521)
- **实证方法论(重要)**: **PrintInlining(diagnostic)能直接看内联决策树**——三棵树的对照实验: C1 树(嵌套 90% 衰减)/C2 普通树(35 字节门槛)/C2 高频树(325 字节放宽+"inline (hot)" 标记);构造深度链(20 层)实证 MaxInlineLevel=15 的精确计数(16 层过、17 层拒,与 inline_level()=jvms depth 语义吻合);"callee is too large" 是 **C1 消息**、"too big" 是 **C2 消息**——用消息区分是哪代编译器在决策;OSR 事件 = "1 % 3 loop @ 5"(% 标记+bci)
- **第 3 轮修正**: ①OSR 段落补全——load_interpreter_state(parse1.cpp:186+)用 fetch_interpreter_state(:104)逐槽恢复 locals/monitors(BoxLockNode+伪 FastLockNode :221-250),**填充侧=SharedRuntime::OSR_migration_begin(sharedRuntime.cpp:3036,注释 "dependent on the memory layout of the interpreter local array and the monitors")**,删掉"与 24-frame 共享帧格式"的无据表述;②catch_inline_exceptions 补行号 doCall.cpp:836;③大纲 ⚠️ 计数修正(3 块 15 条非 19 条,HANDOFF 三处);④C1 衰减计算表述精确化(逐层 (intx) 截断,非直接幂乘);⑤6.65/6.66 章节结构修复(上一轮插入 6.66 时覆盖了 6.65 标题,条目混排)

**15-c2-compiler/03(IGVN + CCP + EA,15 域 3/8)**: 正文 c64fa9e(138 行,含大纲回填 ⚠️ 3 块 13 条)→ 深审 2 轮 0e51373(链接文本对齐 04 标题)→ README 3cdf71b(112/152,15 域 3/8,第 6 批 4/8)→ 素材 15-c2-optimizations-demo.txt→ 深审 2 轮(①**CCP 方向写反(重要)**: 大纲"从 StartNode type=BOTTOM 启动逆风传播"错——真实 analyze(phaseX.cpp:1847-1957)**全部 TOP 初始化(乐观**,"Initialize all types to TOP, optimistic analysis" :1848)+**C->root() 前向 worklist**;类型只增不减(assert "Not monotonic" :1830-1831);②transform_once(:2043-2113)只做常量替换+**不可达 Region 切割**(set_req(0,NULL) 切断自引用+死 Phi 替换 :2060-2082),代数化简留给 iterGVN2;③IfNode::Value(ifnode.cpp:51-67)ZERO→IFFALSE/ONE→IFTRUE;分支 TOP 传播=ProjNode::Value=proj_type(in(0))(multnode.cpp:158-161);④**"ArgEscape → field loads 转 register" 编造(重要)**: 无此机制,ArgEscape 对象仍在堆上(escape.hpp:157-159 注释);⑤**"compute_escape DFS 从 Allocate 出发" 简化错**: 真实五步=add_node_to_connection_graph(:367 遍历所有理想节点)+complete_connection_graph(:1220 传播)+adjust_scalar_replaceable_state(:1757)+**optimize_ideal_graph(:1980: EliminateLocks 锁标记/optimize_ptr_compare/MemBarStoreStore 降级 :2032-2044)**+split_unique_types(:3058,AliasLevel>=3 门控 :321);⑥LocalVar 映射=Phi/CheckCastPP/EncodeP/DecodeN/CastPP(escape.cpp:3223-3232);⑦标量替换落地链=eliminate_macro_nodes(macro.cpp:2567)→eliminate_allocate_node(:1091 四道门)→scalar_replacement(:759)→process_users_of_allocation(:946 store 删除+GC 屏障消除);⑧实证 EA 开关对照: **EADemo 2 亿次循环 new Point 不逃逸,EA 开=0 次 GC 70ms vs EA 关=6 次 GC(570M/次)459ms(6.5 倍)**——DoEscapeAnalysis/EliminateAllocations 是 product(c2_globals.hpp:527/:540)可对照;⑨javac 层已折叠常量条件(if(1==1)→bipush 10;static final 也折)——CCP 处理的是图中常量)→ **第 3 轮** 新修正(①compute_escape **四步→五步**: 补 optimize_ideal_graph(锁标记/指针比较 EQ-NEQ/MemBarStoreStore 降级 MemBarCPUOrder,escape.cpp:2032-2044);②正文/大纲回填/6.67/§6.4 四处同步;③素材第 1/2 段引用核对(EA 开关对照数字)

**15-c2-compiler/04(Loop + SuperWord,15 域 4/8)**: 正文 44a2843(140 行,含大纲回填 ⚠️ 3 块 17 条)→ README d3cbc0a(113/152,15 域 4/8,第 6 批 5/8)→ 素材 15-c2-loops-demo.txt→ 深审 2 轮(①**build_and_optimize 范围不全(重要)**: 真实流程 loopnode.cpp:3062-3431+: build_loop_tree(:3113)/beautify_loops(:3154)/Dominators(:3180)/counted_loop(:3220)/reassociate(:3302)/split_if(:3330)/loop_predication(:3344)/**iteration_split(:3361)**/cleanup_predicates(:3396)/SuperWord(:3405)——大纲"do_unroll/add_constraint 直接调"错,分发在 iteration_split_impl(loopTransform.cpp:3273);②**"add_constraint()" 编造**: 零命中;谓词=loop_predication(loopPredicate.cpp:1505→impl :1329)+insert_loop_limit_check(loopnode.cpp:327),Opaque1 保护非 goto;③**"Strip Mining=主向量+尾标量" 概念错位(重要)**: 那是 pre/main/post 三循环(insert_pre_post_loops :1396);JDK11 strip mining=OuterStripMinedLoopNode(loopnode.hpp:441)包 safepoint 且 **LoopStripMiningIter 默认 0 关**(c2_globals.hpp:755);④**指令映射实测**: loadV4→movd(:3034)/loadV16→**movdqu**(:3098 非 movdqa)/vadd2I→paddd-vpaddd(UseAVX 分派,:6325-6345);"5-10% penalty"无据删除;⑤is_counted_loop 判定(loopnode.cpp:372-500: Region 3 输入+IfTrue/IfFalse 回边+Bool(CmpI)+limit 不变量+stride 常量);⑥SLP 门控(vector_width_in_bytes :100/find_pre_loop_end :153-164/slp_max_unroll :125);⑦策略参数: LoopUnrollLimit x86_64=60(c2_globals_x86.hpp:55)/LoopMaxUnroll=16(factor=4 起步 policy_unroll :782);⑧**实证**: C1(level 3)比 C2 慢 **3.7 倍**(9649 vs 2613ms 素材第 2 段);flag 拆分(-Xbatch 超长运行): **-XX:-UseSuperWord +59%、-XX:LoopUnrollLimit=1 +70%**(素材第 3 段,短运行噪声大 ±20% 不可靠——容器测量教训);OSR 事件(素材第 1 段 1 % 3 run @ 6);CITime IdealLoop 0.006s 占 Optimize 全部(素材第 4 段);TraceSuperWord notproduct(:348)/TraceLoopOpts develop(:228) 不可用)→ **第 3 轮** 新修正(①**TraceLoopOpts 是 develop 非 notproduct**(c2_globals.hpp:228),正文/素材第 5 段/大纲回填/6.68/commit 清单五处同步;②C1 vs C2 倍数修正 3.9→**3.7**(素材 9649/2613=3.69,初稿凭记忆);③13-jit/02 前置依赖链接文本对齐完整标题;④05 链接文本对齐 "# 05. Chaitin — 图着色寄存器分配 O(n²)")

**15-c2-compiler/05(Chaitin,15 域 5/8)**: 正文 ccdcc91(143 行,含大纲回填 ⚠️ 3 块 15 条)→ README 0f97c8b(114/152,15 域 5/8,第 6 批 6/8)→ 素材 15-c2-register-alloc-demo.txt→ 深审 2 轮(①**"_hint_color" 编造(重要)**: 不存在;真实=**_copy_bias**(chaitin.hpp:67)+**bias_color**(:689)+_risk_bias(:66);②**行号全错**: Simplify 在 chaitin.cpp:**1199**(大纲 200-330)、Select **:1447**(大纲 400-600)、Split **reg_split.cpp:496**(大纲 chaitin.cpp:600-800)、coalesce_driver **coalesce.cpp:128**(大纲 50-200)、coalesce :447/:798;③**"LRG live range [first_use,last_use)" 简化错**: 真实=**单次逆向块扫描**(ifg.cpp:317 "single reverse pass"),Copy 不干涉(:350-352);④**"spill_cost 最低" 半对**: score()=raw_score(cost,area) 最小(:103-113 "Smaller cost/area wins" :1292);⑤**"Chaitin-Briggs 一定终止" 无据**: 工程上限 _trip_cnt 24/27(:523-529 "failed spill-split-recycle sanity check")+check_node_count;⑥**"split 后重新 Simplify" 半截**: spill-split-recycle 全循环(:522-570: Split→compact→重建 live+IFG→conservative coalesce→再 Simplify/Select);⑦build_ifg_physical 真职责=物理约束+**寄存器压力**(Pressure,INTPRESSURE x86_64=13 c2_globals_x86.hpp:51 非 16);⑧Select chunk 机制(:1538-1541)+split_Rematerialize(reg_split.cpp:318);⑨实证: CITime Regalloc 阶段树(RADemo.heavy 32 局部变量: Ctor Chaitin/Build IFG(virt+phys)/Compute Liveness/Regalloc Split/Coalesce 1-3/Simplify/Select,素材第 1 段;01 篇素材第 6 段同构);VerifyRegisterAllocator notproduct(:285)/OptoCoalesce develop(:244))→ **第 3 轮** 新修正(①build_ifg_physical 职责精确化——**寄存器压力计算**(Pressure int/float,INTPRESSURE x86_64=13 c2_globals_x86.hpp:51 非 16),删"caller-saved 处理"错位表述;②**删"C1 SSA→LIR 出局同构"无据表述**(14-c1/03 未讲出 SSA),改为 de_ssa 注释原话 "Come out of SSA world to the Named world"(:366-372);③INTPRESSURE 行号 :50→:51;④14-c1/03 前置依赖链接文本核对(标题即 "LinearScan + LIR → x86 码" 无副标题,链接文本匹配))

**15-c2-compiler/06(Matcher + CodeGen,15 域 6/8)**: 正文 ce8be4c(129 行,含大纲回填 ⚠️ 3 块 15 条)→ README ba5d16c(115/152,15 域 6/8,第 6 批 7/8)→ 素材 15-c2-codegen-demo.txt→ 深审 2 轮(①**"PhaseOutput::Output()" 类名错(重要)**: JDK11 无 PhaseOutput 类;发码=**Compile::Output()**(output.cpp:57),emit 循环 n->emit(*cb,_regalloc)(:1394)写 CodeBuffer,reloc 由 MachNode emit 时写入;②**"peephole NOP 消除/冗余 mov 消除" 编造(重要)**: **MachNode::peephole 默认返回 NULL**(machnode.cpp:415-417),x86 无重写——**C2 x86 peephole 也是空实现**(与 14-c1/03 的 C1 peephole 空实现呼应,两代编译器都是空壳);PhasePeephole 框架(phaseX.cpp:2140-2159)钩子空;OptoPeephole develop_pd(:150)/PrintOptoPeephole notproduct(:162);③**"GCM Anti-Dependency 插 spill" 编造**: 调度只重排顺序,spill 是 RA 的事;④**addI 行号错**: x86_64.ad:7473-7519(大纲 :1000);⑤**".ad 10 个文件"错**: x86 就 3 个(9834+13656+13325=36815 数字对);⑥**"mem_reg L1 cache hit ILP 折衷" 无据** 删——ins_cost 是人工近似("// XXX" 注释);⑦Code_Gen 编排(compile.cpp:2476-2580: Matcher→PhaseCFG/GCM→Chaitin→PhaseBlockLayout→Peephole→postalloc_expand→Output);⑧schedule_late 语义=下沉靠近使用点缩短 live range;⑨实证: CITime Matcher/Scheduler/Regalloc/Block Ordering/Peephole/Build OOP maps/Code Installation(素材第 1 段)→ 第 3 轮无新增

**15-c2-compiler/07(PhaseMacroExpand,15 域 7/8)**: 正文 08632d9(74 行,含大纲回填 ⚠️ 3 块 14 条)→ README d1336c5+**修正 1baaf23**(勿把"域完结"与"批完结"混淆——07 后 15 域仍剩 08,第 6 批 2/8 非 8/8)→ 素材 15-c2-macro-demo.txt→ 深审 2 轮(①**"eliminate_locking_nodes (macro.cpp:500-800)" 函数名错+行号错(重要)**: 真实 **eliminate_locking_node(单数)(macro.cpp:2182)**——is_eliminated 检查(EA non_esc_obj 标记,03 篇)+连 MemBarAcquireLock/ReleaseLock 删除(:2223-2236/:2240-2250)+FastLock 唯一用户删除;②**"CoarsenedLockNode→cmpxchg" 无据**: 展开产物=fast_lock_region+slow_path 分支(expand_lock_node :2259,:2266-2272 有偏锁检测快速路径),发码在运行时/23-stub;③**"嵌套 synchronized 合并为单锁" 偏**: 嵌套锁主要靠消除,coarsening=mark_eliminated_locking_nodes(:2577)标记再处理;④**"scalar_replacement (macro.cpp:100-400)" 行号错**: :759(03 篇已拆);SafePointScalarObjectNode(callnode.hpp:492)是 deopt 数据载体非字段替换机制;⑤**"expand_arraycopy_node (macroArrayCopy.cpp:50-300)" 行号错**: :1106+generate_arraycopy :278;⑥expand_macro_nodes 编排(:2645-2778: arraycopy 先行 :2723-2740 ReduceBulkZeroing 注释/节点预算 macro_count*300/Opaque-MaxL 清理/主循环/IGVN+BarrierSet 收尾);⑦expand_allocate_common(:1286): fast/slow Region+initial_slow_test(dtrace/!UseTLAB 强制慢 :1321-1326)——与 14-c1/04 Runtime1 同构;-XX:-UseTLAB 间接观察;⑧实证: PrintInlining arraycopy→intrinsic+lockElim 内联(素材第 1 段)+CITime Macro Expand(素材第 2 段);PrintEliminateLocks notproduct(c2_globals.hpp:508))→ **第 3 轮** 新修正(①"rep movsq 在 23-stub 域"与 23-stub/02 实际内容(向量拷贝循环,64 字节/次)不匹配——JDK11 x86_64 的 arraycopy 桩用向量循环非 rep movsq,正文/大纲回填同步修正;②23-stub/02 标题与内容核对("System.arraycopy 为什么能比手写循环快 3 倍?— Arraycopy 向量化")

**15-c2-compiler/08(library_call.cpp,15 域收官)**: 正文 4e53b4a(104 行,含大纲回填 ⚠️ 3 块 17 条)→ README ee988b7(117/152,15 域完结,第 6 批 2/8)→ 素材复用 15-c2-macro-demo.txt(PrintInlining arraycopy intrinsic)→ 深审 2 轮(①**"C2 在 IGVN 阶段检测" 错(重要)**: intrinsic 触发在 **Parse 期** call_generator→find_intrinsic(doCall.cpp:118)→Compile::find_intrinsic(compile.cpp:150 缓存+make_vm_intrinsic :350);ciMethod 加载时记 intrinsic_id;②**"MathIntrinsicNode→直接 FSIN" 编造(重要)**: 真实三档——sin/cos/log/exp/pow=runtime_math(StubRoutines::dsin 桩优先/SharedRuntime::dsin 兜底,:1876-1880),sqrt/abs/ceil=match_rule_supported 机器指令(:1913-1918),pow(x,2.0)→x*x(:1908-1914);③**"nanoTime→RDTSC" 编造(重要)**: os::javaTimeNanos 运行时调用(:772)=CLOCK_MONOTONIC(39-02 已证);④**"StrictMath → C2 跳过" 错**: intrinsic 只注册 java_lang_Math(vmSymbols.hpp:778),StrictMath 无 intrinsic 恒 JNI;⑤**"UseSSE42Intrinsics 默认 true" 错**: 默认 false(globals_x86.hpp:208)+CPU 探测 FLAG_SET_DEFAULT(vm_version_x86.cpp:1216-1217);⑥行号: inline_string_indexOf :1294(大纲 1000-1300)/inline_math_native :1873(大纲 2000-2200)/inline_unsafe_allocate :2870(声明在 hpp);⑦pcmpestri 实测(string_indexofC8 :6030+注释 :6038,pcmpestri :3852);"5 cycles/16 chars" 无据删;⑧currentThread=ThreadLocalNode→r15_thread(macroAssembler_x86.hpp:290 注释);⑨VM_INTRINSICS_DO 宏表 326 条(vmSymbols.hpp))→ **第 3 轮** 新修正(①"CLOCK_MONOTONIC 是 VDSO 时间"推断无据——39-02 篇只实证 clock_gettime(CLOCK_MONOTONIC)(dlsym 加载),VDSO 未提,正文删除该推断改为 "clock_gettime(CLOCK_MONOTONIC)";②23-stub/02 链接文本核对("System.arraycopy 为什么能比手写循环快 3 倍?— Arraycopy 向量化" 补全);③string_indexofC8 注释行号精确化 :6038)

**21-shared-runtime/01(Runtime Stubs,21 域 1/3)**: 正文 8aa51b6(96 行,含大纲回填 ⚠️ 3 块 14 条)→ README 4023db8(118/152,21 域 1/3,第 6 批 3/8)→ 素材 21-runtime-stubs-demo.txt→ 深审 2 轮(①**generate_stubs 行号与顺序错(重要)**: 真实 sharedRuntime.cpp:**99-123**——wrong_method/abstract/ic_miss(3 resolve_blob :100-102)→resolve_opt_virtual/virtual/static(:103-105)→**polling handler 3 变体**(RETURN/LOOP/VECTOR_LOOP COMPILER2_OR_JVMCI :108-116)→deopt(:118)→uncommon_trap(COMPILER2 :121),大纲"280-400 且 deopt 第一步"全错;②**handle_ic_miss_helper 实现 :1552**(大纲 1100-1300 错,声明 :335 对);③**"find_callee_method" 归属错**: 本函数用 find_callee_info(:1559);find_callee_method(:1213)是入口帧场景的另一函数;④**"IC 三态" 简化错(重要)**: 状态机在 16-04 的 CompiledIC;本函数只处理特例(can_be_statically_bound→reresolve :1571-1583/is_optimized :1625/is_icholder_call :1633)+CompiledIC_lock 下修补(:1617);⑤**set_vm_result_2 TLS 返回**(:1435-1438)+verified_code_entry——与 Runtime1 同族;⑥DeoptimizationBlob 4 个 unpack 变体(codeBlob.hpp:558-562)✓;generate_deopt_blob 在 x86 层 sharedRuntime_x86_64.cpp:2810 ✓;⑦"栈溢出边缘不调 C++"是推断(无注释直证)——正文明确标注;⑧实证: **双态调用点 TypeProfile 双内联 vs 三态 virtual call**(素材第 1/2 段)——IC miss 之后的两种命运;TraceCallFixup develop(globals.hpp:486)/ICMissHistogram notproduct(:1453))→ **第 3 轮** 新修正(①三态表述精确化——megamorphic 后走 **vtable/itable 桩**(16-04:175 set_to_megamorphic),接口调用在 itable 语义下;②**icholder 分支与 16-04 的 "FALSE IC miss converting to compiled call" 呼应**(TraceCallFixup 字符串 sharedRuntime.cpp:1644)——跨篇术语对齐;③16-04/24-03 跨篇引用验证(IC 状态机/evframeArray deopt 均实有)

**21-shared-runtime/03(异常处理,21 域收官)**: 正文 e6ec256(191 行,含大纲回填 ⚠️ 3 块)+ 21-02 悬念链接文本对齐(冒号→破折号)→ README e6ec256 同提交(120/152,21 域完结,第 6 批 5/8)→ 素材 21-exception-handling-demo.txt→ 深审 2 轮(①**"continuation_for_implicit_exception :1600-1750" 行号错**: 真实 :796-965;②**"SIGSEGV 读 cr2" 错**: Linux 用 info->si_addr;③**"查表失败 vm_abort" 错**: 返回 NULL 走正常崩溃报告;④**STACK_OVERFLOW 编译路径不查表**直接 throw_StackOverflowError_entry stub;⑤**reserved zone 3 页错**: 默认 1 页;@ReservedStackAccess 逃生窗方向修正(rsp≥activation 才 enable+delayed,初稿写反);⑥**raw_exception_handler 功能错**: 只做返回点寻路不查表;⑦编译入口链=emit_exception_handler→exception_blob→handle_exception_C(+deopt 复查);⑧ExceptionCache 三段查找;⑨虚拟帧展开非物理 pop;⑩math 归属错: dsin 在 sharedRuntimeTrig.cpp:760 非 Trans:50-400;fdlibm 拷贝非 Intel libm fork;⑪悬念指向 22-deopt 过期→25-gc-framework/01;⑫实证: -Xlog:exceptions=info 全链路(NPE/div0/SOE 24395 帧同 oop/编译→解释器逃逸)
- 实证: 15-c2-parse-graphkit-demo.txt

### 6.67 15-c2-compiler/03(IGVN + CCP + EA,15 域 3/8,大纲 13 处漂移含 2 处机制编造 + 深审 2 轮,2026-08-15)
- **"CCP 从 StartNode type=BOTTOM 启动逆风传播" 错(重要,方向写反)**: 真实 PhaseCCP::analyze(phaseX.cpp:1847-1957)=**全部类型 TOP 初始化(乐观**,"Initialize all types to TOP, optimistic analysis" :1848)+ **C->root() 入 worklist 前向传播**;类型只增不减(assert ccp_type_widens "Not monotonic" :1830-1831,"ccp type must widen" :1867)——与"BOTTOM 启动"完全相反
- **"ArgEscape → Field Load Elimination 转 register" 编造(重要)**: 无此机制;ArgEscape 对象仍在堆上(escape.hpp:157-159 注释 "passed as argument to call...does not escape during call");ArgEscape 的收益=锁消除/指针比较优化等次级;只有 **NoEscape+scalar_replaceable** 才消除堆分配
- **"compute_escape DFS/BFS 从每个 AllocateNode 出发" 简化错**: 真实**五步**图算法(escape.cpp:118-343): ①add_node_to_connection_graph(:367)遍历**所有**理想节点建 PointsTo 图(LocalVar→P→JavaObject/Field→P→JavaObject/JavaObject→F→Field,escape.hpp:100-107),延迟边 add_final_edges(:202-206)②complete_connection_graph(:1220)传播(find_non_escaped_objects :1235 "Propagate GlobalEscape and ArgEscape escape states"+add_java_object_edges 迭代 20 次上限 :1230)③adjust_scalar_replaceable_state(:1757)——**逃逸≠可标量替换**④optimize_ideal_graph(:1980: EliminateLocks 锁标记/optimize_ptr_compare 同一对象 EQ/分配 NEQ/MemBarStoreStore 降级 MemBarCPUOrder :2032-2044)⑤split_unique_types(:3058,AliasLevel>=3 && EliminateAllocations 门控 :321)
- **"escape.cpp:200-500 build_graph" 名字错**: 真实 add_node_to_connection_graph(:367)
- **"到达 static field→GlobalEscape/Return→ArgEscape" 半对**: 状态定义对(escape.hpp:153-161);**Return 值是 GlobalEscape**(escape.cpp:524-525),传参才可能 ArgEscape;传播沿图边("GlobalEscape 指向的一切标 GlobalEscape",escape.hpp:107-112)
- **行号漂移**: "PhaseCCP (phaseX.cpp:1994-2100)" 不全——analyze :1847-1957 才是核心;transform :1994-2039;transform_once :2043-2113;do_transform :1984-1989
- **缺机制(重要)**: ①transform_once 只做常量替换+**不可达 Region 切割**(:2060-2082 set_req(0,NULL) 切断自引用+死 Phi 全替换 top),代数化简留给 iterGVN2(compile.cpp:2388-2391);②IfNode::Value(ifnode.cpp:51-67)ZERO→TypeTuple::IFFALSE/ONE→IFTRUE;分支 TOP 传播=ProjNode::Value=proj_type(in(0))(multnode.cpp:158-161);③标量替换落地链=eliminate_macro_nodes(macro.cpp:2567 先锁后分配)→eliminate_allocate_node(:1091 **四道门**: EliminateAllocations/JVMTI pop frame/_is_non_escaping/can_eliminate_allocation)→scalar_replacement(:759,:1128)→process_users_of_allocation(:946 **Store 删除+memory 边直通** :959-961+eliminate_gc_barrier);循环优化后 expand_macro_nodes(:2645)展开剩余宏节点;④编排=compile.cpp:2307-2337;⑤LocalVar 映射=Phi/CheckCastPP/EncodeP/DecodeN/CastPP(escape.cpp:3223-3232);⑥IGVN 是"引擎中的引擎"——PhaseCCP 继承 PhaseIterGVN(phaseX.hpp:584),EA 接收 PhaseIterGVN*(escape.cpp:97),6 处调用(01 篇)
- **实证方法论(重要)**: **DoEscapeAnalysis/EliminateAllocations 是 product**(c2_globals.hpp:527/:540)可开关对照——EADemo 2 亿次循环 new Point 不逃逸: **EA 开=0 次 GC 70ms vs EA 关=6 次 GC Pause(570M/次)459ms(6.5 倍)**,GC 日志即证据(标量替换消灭分配的正面证明);PrintEliminateAllocations 是 notproduct(:543)release 不可打印;TracePhaseCCP notproduct(:632)——CCP 无 product 观察手段,用 CITime "Cond Const Prop" 阶段名+**javac 层折叠对照**(if(1==1)→bipush 10,static final 也折——CCP 处理的是图中才出现的常量: 内联恒定参数/类型窄化比较/Phi 单例)
- 实证: 15-c2-optimizations-demo.txt

### 6.68 15-c2-compiler/04(Loop + SuperWord,15 域 4/8,大纲 17 处漂移含 2 处机制编造 + 深审 2 轮,2026-08-15)
- **"build_and_optimize 直接调 do_unroll/add_constraint/do_range_check" 错(重要)**: 真实=总入口(loopnode.cpp:3062)内部十一段流程(build_loop_tree :3113→beautify_loops :3154→Dominators :3180→counted_loop :3220→reassociate :3302→split_if :3330→loop_predication :3344→iteration_split :3361→cleanup_predicates :3396→SuperWord :3405);**优化分发在 iteration_split(loopTransform.cpp:3420)→iteration_split_impl(:3273)**: 单迭代(:3283)/空循环(:3287)/非计数 partial_peel(:3296)+peeling(:3300-3302)/unswitching(:3303-3304)/计数 maximally_unroll(:3326)/policy_unroll(:3349)+policy_range_check(:3350)→insert_pre_post_loops(:3366-3371)
- **"add_constraint()" 编造**: 零命中;范围检查提升=**loop_predication(loopPredicate.cpp:1505)→loop_predication_impl(:1329)**,防溢出=insert_loop_limit_check(loopnode.cpp:327),均为 Opaque1 保护的理想图条件分支——非"goto 解释器"
- **"Loop Strip Mining=主向量+尾标量" 概念错位(重要)**: 主/尾模型=**pre/main/post 三循环拆分**(insert_pre_post_loops loopTransform.cpp:1396: pre 对齐与剥皮剩余/main 展开主体/post 零头);JDK11 **strip mining=OuterStripMinedLoopNode(loopnode.hpp:441)外层包 safepoint** 且 **LoopStripMiningIter 默认 0 关闭**(c2_globals.hpp:755)
- **指令映射实测**: loadV4→**movd**(x86.ad:3034)/loadV16→**movdqu**(:3098,大纲 movdqa 错)/vadd2I→**paddd(UseAVX==0)/vpaddd(UseAVX>0)**(:6325-6345);"base%16 不对齐 penalty 5-10%"机制对但数字无源码依据删除
- **策略参数**: policy_unroll factor=4 起步(:782);**LoopUnrollLimit x86_64=60**(c2_globals_x86.hpp:55)/**LoopMaxUnroll=16**(c2_globals.hpp:179);UseSuperWord product(:333);SuperWordLoopUnrollAnalysis x86_64 默认 true(:84)
- **缺机制(重要)**: ①is_counted_loop 判定(loopnode.cpp:372-500): Region 3 输入(Self/Entry/LoopBack)/IfTrue-IfFalse 回边/Bool(CmpI 禁指针浮点)/limit 循环不变量/incr 循环变量/Phi 结构/AddI 增量/**stride 常量**;②SLP 门控链(superword.cpp:100 架构宽度/:125 slp_max_unroll==0/:153-164 main loop 需 pre-loop end/:149-151 已向量化跳过);③SLP_extract 流水线(construct_bb :2793→dependence_graph→compute_max_depth→combine_packs :1552→output :2282+align_initial_loop_index :2298+insert_extracts);④do_unroll limit/init/stride 重算(:1942-1984)+update_main_loop_skeleton_predicates(:1972)+zero-trip guard opaq(:1957-1959);⑤循环后清理 remove_range_check_casts/remove_opaque4_nodes(compile.cpp:2421-2425/:2452-2455)
- **实证方法论(重要)**: ①**容器性能对照噪声 ±20%**——短运行不可靠,需 -Xbatch+超长运行(reps=2000000)才稳定;②C1 vs C2 对照最稳(C2 循环体系整体效果: level 3 慢 3.7 倍);③flag 拆分: -XX:-UseSuperWord +59%/-XX:LoopUnrollLimit=1 +70%(展开贡献>向量化,因 pack 依赖展开后的相邻指令);④OSR 事件(1 % 3 run @ 6)=回边触发编译的存在性证据;⑤CITime IdealLoop 阶段计时=循环优化耗时的直接读数;⑥TraceSuperWord notproduct(:348)/TraceLoopOpts develop(:228) 不可用——循环变换本身无法直接打印
- **章节维护教训(连续 9 次犯,6.74 时违反的具体细节已确认——new2 末尾带了旧节标题)**: 错误模式=`new=新节内容+"### 6.xx 旧节标题"` 替换 `old="### 6.xx 旧节标题"`——**new 末尾带旧节标题导致新节插到标题前**;已 9 次(6.65-6.74 每次,含 6.73 教训明示后的 6.74);**强制操作顺序(违反即事故,立即交换修复+更新教训)**: ①先把新节内容写成独立文本,插入点为 `## 七、` 前一行(文件末尾追加,不碰任何旧节内容);②**立即 `grep -n "### 6.6"` 校验连续递增**;③若顺序颠倒,交换块并记录本次违规细节。禁止"new 含旧节标题"模式
- 实证: 15-c2-loops-demo.txt

### 6.69 15-c2-compiler/05(Chaitin,15 域 5/8,大纲 15 处漂移含 2 处机制编造 + 深审 2 轮,2026-08-15)
- **"_hint_color" 编造(重要)**: 不存在;真实=**_copy_bias**(chaitin.hpp:67 "Index of LRG which we want to share color")+**bias_color**(:689 "Helper function which implements biasing heuristic")+_risk_bias(:66 想避免的颜色)——偏置着色=copy 两端尽量同色减 spill code
- **行号全错(05 篇最严重)**: **Simplify 在 chaitin.cpp:1199**(大纲 200-330)、**Select :1447**(大纲 400-600)、**Split 在 reg_split.cpp:496**(大纲 chaitin.cpp:600-800)、**coalesce_driver 在 coalesce.cpp:128**(大纲 50-200)——大纲把 chaitin.cpp 前 600 行当成了整个 RA
- **"LRG live range [first_use,last_use) 区间" 简化错(重要)**: 真实=**单次逆向块扫描**(ifg.cpp:317-319 注释 "single reverse pass over each basic block"): 从 live-out 倒走,定义值移出前与一切存活值干涉,输入加入;**Copy 不干涉**(:350-352)——区间法只是教学表述,源码是集合运算
- **"spill_cost 最低" 半对**: 真实=**score()=raw_score(_cost,_area) 最小**(chaitin.cpp:99/:103-113 注释 "Bigger area lowers score, encourages spilling...Bigger cost raise score, prevents spilling";Simplify :1292 "Smaller cost/area wins")——**cost/area 比值**,不是裸 cost;选"潜在 spill 候选"是乐观的(先入栈,Select 才定夺)
- **"Chaitin-Briggs 一定终止" 无据(重要)**: 源码无 Briggs 命名;终止=**工程上限** _trip_cnt 24/27(chaitin.cpp:523-529 "failed spill-split-recycle sanity check")+check_node_count——"证明"是编的
- **"split 后重新 Simplify" 只说半截**: 真实=**spill-split-recycle 全循环**(chaitin.cpp:522-570): Split(reg_split.cpp:496,split_DEF :148/split_USE :190 插 spill 拷贝;**split_Rematerialize :318 能重算的不 spill 直接重物化**)→compact(:542)→**重建 liveness+IFG**(:546-558)→conservative coalesce(:566)→再 Simplify/Select
- **build_ifg_physical 真职责**: 物理寄存器约束+**寄存器压力计算**(Pressure int/float,:830-836;**INTPRESSURE x86_64=13** c2_globals_x86.hpp:51 非 16——含保留寄存器),超压返回 must_spill;大纲"caller-saved 不可跨 call"的机制在 liveness/RegMask,不在 build_ifg_physical
- **缺机制**: Select 的**栈槽 chunk 机制**(RegMask::CHUNK_SIZE,:1538-1541 "Bump register mask up to next stack chunk"——AllStack LRG 无颜色滚动下一块);_must_spill LRG 已在低度列表(:1249);coalesce 两档(aggressive 虚拟 copy/conservative spill 后,OptoCoalesce develop c2_globals.hpp:244)
- **实证方法论**: CITime **Regalloc 子阶段树**是 RA 的唯一直接观察(素材第 1 段: Ctor Chaitin/Build IFG(virt+phys)/Compute Liveness/Regalloc Split/Postalloc Copy Rem/Fixup Spills/Coalesce 1-3/Simplify/Select;01 篇素材第 6 段同构);VerifyRegisterAllocator notproduct(:285)无法验证分配;RA 正确性只能靠运行结果间接确认
- 实证: 15-c2-register-alloc-demo.txt

### 6.70 15-c2-compiler/06(Matcher + CodeGen,15 域 6/8,大纲 15 处漂移含 3 处机制编造 + 深审 2 轮,2026-08-15)
- **"PhaseOutput::Output()" 类名错(重要)**: JDK11 无 PhaseOutput 类;发码=**Compile::Output()**(output.cpp:57,"Convert Nodes to instruction bits in a buffer" compile.cpp:2558 注释);emit 循环 n->emit(*cb,_regalloc)(:1394)写 CodeBuffer,reloc 由 MachNode emit 时写入(非独立 finalize 阶段)
- **"peephole NOP 消除/冗余 mov 消除" 编造(重要)**: **MachNode::peephole 默认返回 NULL**(machnode.cpp:415-417),x86 无重写——**C2 x86 peephole 也是空实现**(与 14-c1/03 的 C1 peephole 空实现呼应:"sparc uses this for delay slot filling"——**两代编译器的 x86 peephole 都是空壳**);PhasePeephole 框架(phaseX.cpp:2140-2159)钩子空;OptoPeephole develop_pd(c2_globals.hpp:150,x86_64 默认 true 但无实现)/PrintOptoPeephole notproduct(:162)
- **"GCM Anti-Dependency 插 spill" 编造**: 调度只重排顺序,spill 是 RA(05 篇)的事;GCM 三件套=build_dominator_tree+estimate_block_frequency(IfNode 概率,uncommon trap 压低 :1629-1636)+global_code_motion(schedule_early :308/schedule_late :1280 下沉靠近使用点缩短 live range)
- **"x86_64.ad:line ~1000 addI variants" 行号错**: 实际 **x86_64.ad:7473-7519**(addI_rReg/imm/mem(ins_cost(125))/mem_rReg/mem_imm);"x86.ad:5000-6000" 无据
- **".ad 约 37000 行" 数字对但"10 个文件"错**: x86 平台 **3 个文件**(x86.ad 9834+x86_32.ad 13656+x86_64.ad 13325=36815)
- **"mem_reg 在 L1 cache hit 时...ILP 折衷" 无据**: 删——ins_cost 是人工标的近似值(注释 "// XXX"),无 ILP 权衡逻辑;成本模型本身真实(match_tree :1386-1394 "The minimum cost match")
- **缺机制(重要)**: ①instruct 规则要素全清单=match/effect/opcode/format/ins_encode/ins_pipe/+ins_cost(x86_64.ad:7473-7495 实测);②adlc 机制(GensrcAdlc.gmk 构建期编译 .ad→ad_x86_64.cpp/hpp 生成物不在源码树;adlc 源码 share/adlc/dfa.cpp DFA_PRODUCTION;class State 由 adlc 生成);③Matcher::match 流程(find_shared :310 共享节点才能做匹配树内部/xform 递归 :343-345);④匹配失败=soft_match_failure→record_method_not_compilable(编译期错误非崩溃);⑤Code_Gen 总编排(compile.cpp:2476-2580: Matcher→PhaseCFG/GCM→Chaitin→PhaseBlockLayout→Peephole→postalloc_expand→Output);⑥块布局=PhaseBlockLayout(block.cpp Trace 高频后继连排)
- **实证方法论**: CITime Code_Gen 阶段树(Matcher/Scheduler/Regalloc/Block Ordering/Peephole/Build OOP maps/Code Installation,素材第 1 段);format %{} 文本用于 PrintOptoAssembly 但该 flag NOT_PRODUCT(01 篇已证)——发码细节 release 不可见;flag 边界 OptoPeephole develop_pd/PrintOptoPeephole notproduct
- 实证: 15-c2-codegen-demo.txt

### 6.71 15-c2-compiler/07(PhaseMacroExpand,15 域 7/8,大纲 14 处漂移含 3 处机制编造 + 深审 2 轮,2026-08-15)
- **"eliminate_locking_nodes (macro.cpp:500-800)" 函数名错+行号错(重要)**: 真实 **eliminate_locking_node(单数)(macro.cpp:2182)**——is_eliminated() 检查(EA non_esc_obj 标记,03 篇 optimize_ideal_graph 打的标)+**连 MemBarAcquireLock/MemBarReleaseLock 一起删**(:2223-2236/:2240-2250)+FastLock 唯一用户删除(:2232-2236);mark_eliminated_locking_nodes(:2577)
- **"CoarsenedLockNode→cmpxchg(biased)/CAS 直接发码" 无据(重要)**: 展开产物=**fast_lock_region+slow_path 分支结构**(expand_lock_node :2259,:2266-2272 有偏锁模式检测快速路径);真正发 cmpxchg 在运行时/汇编 stub(23-stub 域 SharedRuntime 锁助手)——"展开"接线不是发码
- **"嵌套 synchronized 合并为单锁" 偏(重要)**: 嵌套锁主要靠**消除**(对象不逃逸→is_eliminated 全消);"coarsening"=mark_eliminated_locking_nodes 对合并锁标记再处理,非"两个 FastLockNode 合并成一个 CoarsenedLockNode"
- **"scalar_replacement (macro.cpp:100-400)" 行号错**: 真实 **:759**(03 篇已详拆 eliminate_allocate_node 四道门→scalar_replacement→process_users_of_allocation);SafePointScalarObjectNode(callnode.hpp:492-503)是**安全点/deopt 数据载体**(_first_index/_n_fields "states of the scalarized object fields are collected"),非"field→value 映射"通用机制——字段替换=split_unique_types(03 篇)+IGVN
- **"expand_arraycopy_node (macroArrayCopy.cpp:50-300)" 行号错**: 真实 **:1106**;generate_arraycopy :278;文件 1308 行
- **缺机制(重要)**: ①**expand_macro_nodes 编排**(macro.cpp:2645-2778): 最后消除(:2647)→节点预算 macro_count*300(:2653 注释 "Worst case is a macro node gets expanded into about 200 nodes")→Opaque1-2/LoopLimit/MaxL-MinL→CMoveL/OuterStripMinedLoop 清理(:2656-2721)→**arraycopy 先行**(:2723-2740 注释 "For ReduceBulkZeroing, we must first process all arraycopy nodes before the allocate nodes are expanded")→主循环(:2744-2771 Allocate→expand_allocate(:1981)/AllocateArray→expand_allocate_array(:1987)/Lock→expand_lock_node(:2259)/Unlock→expand_unlock_node(:2497))→_igvn.optimize+BarrierSet(:2773-2777);②expand_allocate_common(:1286): slow_result_path/fast_result_path Region+Phi 合并+initial_slow_test(too-big 检查,dtrace/!UseTLAB 强制全慢 :1321-1326)——**TLAB 快速路径内联慢路径调用,与 14-c1/04 Runtime1 同构**,-XX:-UseTLAB 间接观察(14-c1/04 已用);③数组拷贝形态分派(clonebasic→clone_at_expansion/copyof-cloneoop 带屏障/arraycopy 编译期检查 :1154-1157 "Compile time checks...we do not make a fast path for this call")
- **实证方法论**: PrintInlining 显示 intrinsic 替换(System.arraycopy→"intrinsic",素材第 1 段)——宏节点消费的直接证据;lockElim(synchronized(new Object()))整体内联=锁消除候选;PrintEliminateLocks notproduct(c2_globals.hpp:508)不可打印,消除只能行为观察
- 实证: 15-c2-macro-demo.txt

### 6.72 15-c2-compiler/08(library_call.cpp intrinsic,15 域收官,大纲 17 处漂移含 3 处机制编造 + 深审 2 轮,2026-08-15)
- **"C2 在 IGVN 阶段检测到 call node→换 LibraryCallKit" 错(重要)**: intrinsic 触发在 **Parse 期**——do_call→call_generator→find_intrinsic(doCall.cpp:118)→Compile::find_intrinsic(compile.cpp:150: _intrinsics 缓存,首次命中 register_intrinsic/make_vm_intrinsic library_call.cpp:350);ciMethod 加载时从 VM_INTRINSICS_DO 宏表记 intrinsic_id(vmSymbols.hpp 326 条);intrinsic 失败退回普通调用(doCall.cpp:602-607 allow_intrinsics=false 重试)
- **"MathIntrinsicNode→直接 FSIN 指令" 编造(重要)**: 真实**三档**——①sin/cos/tan/log/exp/pow=**runtime_math**(StubRoutines::dsin() 桩优先,SharedRuntime::dsin C 实现兜底,:1876-1880)——消除的是 JNI 来回,产物仍是 call(23-stub 域的启动期桩);②sqrt/abs/ceil/floor/rint=inline_double_math/match_rule_supported 机器指令(:1913-1918);③pow(x,2.0)→x*x 特例(:1908-1914);"MathIntrinsicNode" grep 零命中;fast_sin 是 SIMD 多项式(macroAssembler_x86_sin.cpp:381),"Payne-Hanek"无注释依据删
- **"System.nanoTime→RDTSC" 编造(重要)**: _nanoTime→inline_native_time_funcs(os::javaTimeNanos)(:772)=**运行时调用 CLOCK_MONOTONIC**(39-02 域已实证);RDTSC 受跨核/频率漂移影响,JVM 不用它计时
- **"-XX:+StrictMath → C2 跳过 intrinsic" 错(重要)**: intrinsic 只注册在 **java_lang_Math**(vmSymbols.hpp:778 do_intrinsic(_dsin,...));StrictMath.sin 无 intrinsic 恒走 JNI——不存在"开关跳过"
- **"UseSSE42Intrinsics 默认 true" 错**: 默认 **false**(globals_x86.hpp:208),CPU 探测支持 SSE4.2 时 FLAG_SET_DEFAULT(true)(vm_version_x86.cpp:1216-1217)——ergonomics 决定默认;编译期门控=Matcher::match_rule_supported(Op_StrIndexOf)(:1296)
- **行号漂移**: inline_string_indexOf **:1294**(大纲 1000-1300)/inline_math_native **:1873**(大纲 2000-2200)/inline_unsafe_allocate **:2870**(大纲 254-260 声明在 library_call.hpp)/dispatch 在 try_to_inline switch(:536+,非 :773)
- **pcmpestri 实测**: string_indexofC8(macroAssembler_x86.cpp:6030,注释 "This method uses the pcmpestri instruction with bound registers" :6038)+pcmpestri :3852;"5 cycles/16 chars" 无据删
- **缺机制(重要)**: ①try_to_inline(:519)巨型 switch 分发 300+ ID;②String compact 双编码=StrIntrinsicNode::ArgEnc LL/UU/LU/UL(:592-598);③currentThread=ThreadLocalNode→机器层 r15_thread(macroAssembler_x86.hpp:290 注释 "thread in the default location (r15_thread on 64bit)");④allocateInstance=null_check+klass_needs_init_guard+new_instance 不调构造器(:2870-2895);⑤CAS→inline_unsafe_load_store(LS_cmp_swap,:703)→原子节点→x86 lock cmpxchg;⑥"绕过安全模型"表述过强——省的是类型/null/边界检查
- **实证方法论**: PrintInlining 的 "intrinsic" 标记=intrinsic 决策直接证据(07 篇素材复用);PrintIntrinsics diagnostic(c2_globals.hpp:657)可用;UseSSE42Intrinsics 默认值受 CPU 探测影响——实证前 -XX:+PrintFlagsFinal 确认
- 实证: 复用 15-c2-macro-demo.txt

### 6.73 21-shared-runtime/01(Runtime Stubs,21 域 1/3,大纲 14 处漂移含 2 处机制编造 + 深审 2 轮,2026-08-15)
- **"generate_stubs (sharedRuntime.cpp:280-400)" 行号与顺序全错(重要)**: 真实 **sharedRuntime.cpp:99-123**——先 3 个 wrong_method/abstract/ic_miss resolve_blob(:100-102)再 3 个 resolve_opt_virtual/virtual/static(:103-105)→**polling handler 3 变体**(POLL_AT_RETURN/LOOP/VECTOR_LOOP,COMPILER2_OR_JVMCI 门控 :108-116)→generate_deopt_blob(:118)→generate_uncommon_trap_blob(COMPILER2 :121);大纲"deopt 第一步"错
- **"handle_ic_miss_helper (sharedRuntime.cpp:1100-1300)" 行号错**: 声明 sharedRuntime.hpp:335 ✓,实现 **:1552**
- **"find_callee_method" 归属错**: handle_ic_miss_helper 用 **find_callee_info**(:1559,返回 receiver/bc/CallInfo);find_callee_method(:1213)是**入口帧(entry frame)场景**的函数(JavaCalls 调用者查找,vfst.at_end 时从 entry_frame call_wrapper 取)
- **"IC 状态 Clean→Monomorphic→Megamorphic 三步" 简化错(重要)**: 状态机在 **16-code-cache/04 的 CompiledIC**;本函数只处理特例分支——**can_be_statically_bound→reresolve_call_site**(:1571-1583,注释 "Compiler1 can produce virtual call sites that can actually be statically bound"——C1 产物特例)、is_optimized(:1625-1632)、is_icholder_call(:1633-1641);普通 miss 在 CompiledIC_lock 下修补(:1617)
- **"IC stub 保存寄存器→调 VM→resolve→patch→恢复→jmp"** ✓(JRT_BLOCK_ENTRY 模板);**结果经 set_vm_result_2 TLS 返回**(:1435-1438,与 Runtime1/解释器 vm_result 同族),返回 verified_code_entry()
- **"deopt_blob 手写汇编不调 C++(栈溢出边缘 nested SIGSEGV)" 是推断**: unpack 汇编属实(generate_deopt_blob x86 层 sharedRuntime_x86_64.cpp:2810 ✓),但"nested SIGSEGV"动机无注释直证——正文明确标注推断不展开;"safe read 触碰页"无据删
- **DeoptimizationBlob 4 个 unpack 变体** ✓(_unpack_offset/_with_exception/_with_reexecution/_with_exception_in_tls,codeBlob.hpp:558-562)
- **实证方法论(重要)**: IC miss 的直接日志 release 不可用(TraceCallFixup develop globals.hpp:486/ICMissHistogram notproduct :1453);**PrintInlining 的类型画像与 virtual call 标记是最近观察窗**——双态调用点(Circle/Square 各半)显示 TypeProfile (20650/41300 counts)+两路 inline (hot)=C2 类型测试+双路内联;三态显示 virtual call=不内联走 vtable(IC miss→megamorphic 的命运)
- 实证: 21-runtime-stubs-demo.txt

### 6.74 21-shared-runtime/02(c2i/i2c Adapter,21 域 2/3,大纲 15 处漂移含 2 处机制编造 + 深审 2 轮,2026-08-15)
- **"generate_c2i_adapter/generate_i2c_adapter (sharedRuntime_x86_64.cpp:500-1200)" 函数名错(重要)**: 真实 **gen_c2i_adapter(:585)/gen_i2c_adapter(:733)**,入口 **generate_i2c2i_adapters(:943)**一次生成三个入口——i2c_entry(:949)/c2i_unverified_entry(:962)/c2i_entry(:986),AdapterHandlerLibrary::new_entry(fingerprint,:991)让同签名方法共享 adapter
- **"push rbp; mov rbp,rsp 建新帧" 错(重要)**: adapter **frameless**——注释 :748-763 "An i2c adapter is frameless because the caller frame, which is interpreted, routinely repairs its own stack pointer...This is why c2i and i2c adapters cannot be indefinitely composed";**栈修复职责归解释器**(sender_sp/interpreter_frame_last_sp),adapter 不能无限组合,VerifyAdapterCalls(:768-793 "i2c adapter must return to an interpreter frame")防错配
- **"c2i adapter 需要 OopMap(GC root)" 编造(重要)**: OopMap 只在 save_live_registers(:157,桩)与 native wrapper(:1159);adapter 纯汇编 repack 无 GC 点——大纲把桩的 OopMap 张冠李戴
- **"c2i 200 条指令/i2c 40 条" 无据**: 删
- **漏(重要)**: ①**c2i_unverified_entry**(:962-984): holder 检查(load_klass+cmpptr holder_klass+IC miss 兜底 :970-975)+编译检查(Method::code_offset 非空→IC miss,注释 "Method might have been compiled since the call site was patched to interpreted" :978-983)——IC 语义的汇编落地点(21-01/16-04 衔接);②patch_callers_callsite(:596 注释 "Check for a compiled target. If there is one, we need to patch the caller's call");③c2i 尾部 movptr rcx, Method::interpreter_entry_offset()+jmp(:716-717);④i2c 跳 from_compiled_offset(:828,**from_compiled_entry=15-c2/02 篇 from_interpreted_entry 的姊妹字段** method.hpp:697/:709)
- **"reg 参数怎么对应 local" 场景简化错(第 2 轮抓)**: c2i 的输入是**栈上的编译布局**(:603 "Since all args are passed on the stack")——栈内重排非寄存器搬运;i2c 才是"解释器槽→寄存器"(c_rarg0-5+8 XMM+栈槽)
- **参数映射**: x86_64 c_rarg0-5(rdi-r9,:1011-1013)/c_farg0-7(8 XMM,:1014-1017)/超出走栈(2 VMReg 槽 :1040-1041);64-bit interpreter slot=8 字节(abstractInterpreter.hpp:236),long/double 占 1 槽;"32-bit 2 slots"无 x86_32 验证不展开
- **实证边界**: adapter 是手写汇编,release 无观察手段(VerifyAdapterCalls develop);**源码注释即设计文档**(frameless 注释 :748-763 是机制的一手说明)——本篇以注释为证
- 实证: 无新素材(源码注释直证)

### 6.75 21-shared-runtime/03(异常处理,21 域收官,大纲 15+ 处漂移含 5 处机制编造 + 深审 2 轮,2026-08-15)
- **"continuation_for_implicit_exception (sharedRuntime.cpp:1600-1750)" 行号错**: 真实 **:796-965**;enum 在 sharedRuntime.hpp:188-192 ✓;声明 :201-203 ✓
- **"SIGSEGV handler 读 cr2 寄存器" 错(重要)**: Linux 用 **info->si_addr**(os_linux_x86.cpp:359);三路分派=SIGSEGV 栈区(yellow/reserved+_thread_in_Java :364-387)→SOE/SIGFPE FPE_INTDIV|FLTDIV(:447-454)→div0/SIGSEGV !needs_explicit_null_check(:482-486)→NPE
- **"查 nul_chk_table[pc]→没有→vm_abort" 半对**: 查表=nmethod::continuation_for_implicit_exception(nmethod.cpp:1986-2012,ImplicitExceptionTable 偏移对表 exceptionHandlerTable.hpp:132-138);**查不到返回 NULL→走正常崩溃报告**(hs_err),非 vm_abort;表填充=C2 MachNullCheck(output.cpp:1658-1663)+C1 DivByZeroStub/ImplicitNullCheckStub(c1_CodeStubs_x86.cpp:148/:452)→nul_chk_table 段(nmethod.cpp:745-746)
- **STACK_OVERFLOW 编译路径不查表**: 直接 throw_StackOverflowError_entry stub(:816-830);解释器路径返回 Interpreter::throw_*_entry(:807-812,生成 templateInterpreterGenerator.cpp:175-182+generate_exception_handler_common x86:142-173);**解释器显式检查也跳这些入口**(arraylength null_check templateTable_x86.cpp:4164-4168/ldiv testq :1416-1427——解释器宁可显式检查不等信号)
- **"两阶段: 设 reserved zone 3 页=12KB" 错**: reserved 默认 **1 页**(globals_x86.hpp:57-69 red1/yellow2/reserved1/shadow20);真实机制=@ReservedStackAccess 逃生窗——信号 handler 找到 annotated 帧→disable reserved zone 守卫+设 reserved_stack_activation(os_linux_x86.cpp:366-381)→方法入口 reserved_stack_check(macroAssembler_x86.cpp:1094-1108)在 **rsp ≥ activation(回到逃生窗之上)时** enable+跳 delayed SOE 桩(方向初稿写反,第 2 轮抓);SOE 构造绕开 Java 栈(throw_StackOverflowError_common :768-785 "upcall to Java, and we're already out of stack space")
- **throw 桩统一骨架**: generate_throw_exception(stubGenerator_x86_64.cpp:5758-5832)→尾部 jump **forward_exception_entry**(:5830-5832,同文件 :494-550 调 exception_handler_for_return_address 寻路取回 pending exception 后 jmp handler);同骨架 AbstractMethodError/ICCE/NPE at call(:5977-5993)
- **"raw_exception_handler_for_return_address :1400-1550" 行号错+功能错(重要)**: 真实 **:454-515**;**不查异常表**——只按返回地址寻路(find_blob→is_deopt_pc→unpack_with_exception/exception_begin;returns_to_call_stub→catch_exception_entry;解释器→rethrow_exception_entry;查不到 ShouldNotReachHere);调用点=rethrow_C(opto/runtime.cpp:1447-1466)+vframeArray.cpp:268+forward_exception_entry
- **编译代码异常入口链(大纲漏)**: 方法异常入口 emit_exception_handler(x86.ad:1318-1333,offset 记 CodeOffsets::Exceptions output.cpp:1535)→jump exception_blob(sharedRuntime_x86_64.cpp:3900-4002,rax=oop rdx=pc,存 Thread.exception_oop/pc 因帧尺寸不定不能传参)→handle_exception_C(:1390-1423 无 JRT wrapper,出 VM 后复查 nmethod 是否刚被 deopt→unpack_with_exception :1412-1421)→helper(:1269-1381)
- **查表三段(大纲漏缓存)**: ①ExceptionCache(compiledMethod.cpp:137-150,16 槽/链,读不锁假阴性)②compute_compiled_exc_handler(:632-734)=ScopeDesc→Method::fast_exception_handler_bci_for(method.cpp:200-235 扫字节码四元组表+is_subtype_of)→ExceptionHandlerTable.entry_for(exceptionHandlerTable.cpp:110-120 按 catch_pco 子表+bci/scope_depth)→code_begin()+pco;③回填(add_handler_for_exception_and_pc :152-166 ExceptionCache_lock)
- **"栈展开逐帧 pop" 表述错**: 内联多层=**虚拟帧展开**(sd->sd->sender() 沿 ScopeDesc 链 :688-695);C1 无 handler→unwind_handler_begin(:714-718)+abbreviated catch tables(:703-711 同步内联合成 handler)
- **解释器接盘**: throw_exception_entry(templateInterpreterGenerator_x86.cpp:1519-1539)→InterpreterRuntime::exception_handler_for_exception(interpreterRuntime.cpp:470+)→handler/remove_activation_entry(:1541-1543 注释)
- **monitor**: helper 声明 hpp:340-341 ✓;实现 :2035-2064 顺序=quick_enter(:2040 非 safepoint 同步中)→fast_enter/slow_enter;**synchronizer.cpp 行号错**: fast_enter :264/slow_enter :339(大纲 80-240);调用方=C2 complete_monitor_locking_Java(macro.cpp:2465-2466)/C1 c1_Runtime1.cpp:702;exit :2071-2082
- **math 归属错(重要)**: dsin/dcos/dtan 在 **sharedRuntimeTrig.cpp:760/818/875**,dlog/dexp/dpow 在 sharedRuntimeTrans.cpp:165/233/369/658(大纲"Trans:50-400 dsin 泰勒级数"双错);**fdlibm 拷贝非 Intel libm fork**(Trans 头注释 :30-37: Intel CPU 不满足 Java sin/cos 规范+绕 libjava.so 间接调用快 ~15%);桩条件 supports_sse2&&UseLibmIntrinsic&&InlineIntrinsics(:5959-5967);montgomery_multiply sharedRuntime_x86_64.cpp:3811
- **悬念指向错**: "下一篇 域22 Deoptimization" 过期(deopt 重建已在 24-frame/03)——正确 **25-gc-framework/01**
- **实证方法论(重要,新发现)**: **-Xlog:exceptions=info 是 release 可用的异常全链路观察窗**——①"thrown [sharedRuntime.cpp, line 606]"=Exceptions::_throw 来源(throw_and_post_jvmti_exception);②"thrown in C1 compiled method"=c1_Runtime1.cpp:522-529 的 Exceptions::log_exception;③"continuing at PC ... for exception thrown at PC ..."=c1_Runtime1.cpp:608-611;C2 编译代码异常**不打任何 thrown in trace**(内联 catch+rethrow 路径);④**"N [Exception (...)" = OptoRuntime::trace_exception(opto/runtime.cpp:1672-1691)=handle_exception_C 的 trace,每条=异常穿过一个 C2 帧的 exception_blob**——SOE 素材 24395 条=C2 递归帧数(初稿解读"逐帧传播记录"错,第 3 轮修正);素材 ExceptionDemo(acbench)五场景+21-exception-handling-demo.txt
- **第 3 轮 REVIEW 重大修正(2026-08-15,commit 99f2cac,两代编译器异常出口设计——gdb 实证)**: ①**C2 编译代码异常主路径不是 exception_blob 单一路径**: 调用点有 handler→**编译代码内联 catch**(doCall.cpp:836 catch_inline_exceptions: gen_subtype_check+CheckCastPP+merge_exception :913-943,不进运行时);不匹配/无 handler→make_runtime_call(rethrow_stub :965-971)或 throw_to_exit(parse1.cpp:906-930)→**方法级 RethrowNode**(parse1.cpp:883-895)→jmp rethrow_stub(x86_64.ad:12941-12955,enc_rethrow :2810);②**逐帧逃逸链**: rethrow_C(opto/runtime.cpp:1447-1466,注释: callee 帧已移除/同步已解锁/callee-saved 已恢复)→raw_exception_handler→caller->exception_begin→**exception_blob**(rax=oop/rdx=pc 由 TailJump popq rdx 准备,x86_64.ad:12914-125;oop 经 TLS vm_result 回 rax,generateOptoStub pass_tls)→handle_exception_C(:1390-1423)→helper(:1269-1381);**gdb 实证 C2EscapeDemo(-XX:MaxInlineSize=0)**: rethrow_C 57 次/handle_exception_C 29 次(=29 次逃逸全命中)/compute 只 2 次(27 次 ExceptionCache 缓存命中);③**C1 异常出口**: exception_begin(c1_LIRAssembler_x86.cpp:388-414)=直接 call Runtime1::handle_exception_from_callee_id(非 jump exception_blob);无 handler→unwind_handler_begin(remove_frame+jump unwind_exception :415-478);④**素材 E 两类日志并存=C1/C2 帧混合**(-Xcomp 后仍 tiered 升级,-Xcomp 是首次调用即编译非停 tiered);⑤**栈 zone 顺序**: 栈顶往下 shadow/reserved/yellow/red(初稿反了);⑥表查找: 默认 handler 条目恒追加(doCall.cpp:759-761),无 handler 方法无 CatchNode 走 throw_to_exit;⑦遗留谜(未闭合): C2 无 handler 方法的 compute_compiled_exc_handler 实测不触发 guarantee(false),可能与该实验 C1/C2 混合/OSR 形态有关,正文未断言

### 6.76 25-gc-framework/01(BarrierSet + Access API,25 域开篇,大纲 10+ 处漂移含 3 处机制编造 + 深审 2 轮,2026-08-15)
- **文件位置错**: access.hpp/accessBackend.hpp/accessDecorators.hpp 在 **share/oops/**(非 share/gc/shared);barrierSetAssembler.hpp 是 CPU_HEADER 转发,x86 实现在 cpu/x86/gc/shared/barrierSetAssembler_x86.cpp
- **"编译期静态分派,零运行时开销" 错(重要)**: 真实=**5 步模板管线**(access.hpp:63-92 权威注释: ①默认装饰器+类型衰减 ②类型归约 ③Pre-runtime dispatch(能否避免 runtime 调用)④Runtime-dispatch ⑤a. Barrier resolution+函数指针 patch / b. Post-runtime dispatch)+**RuntimeDispatch 函数指针缓存**(accessBackend.hpp:452-459 注释+465-474 结构:`static func_t _store_func` 初始指向 store_init;首次调用 resolve 后 `_store_func = function`(access.inline.hpp:284-288),之后每次访问一次间接调用)——**运行时分派**(BarrierResolver switch(bs->kind()) access.inline.hpp:218-235),因 **GC 是启动时 flag 选的**,同一 libjvm.so 服务所有 GC;AS_RAW 旁路绕过(accessDecorators.hpp:139-145);**运行时分派三副面孔(第 3 轮修正)**: VM 内部 C++=函数指针缓存;解释器模板=BarrierSetAssembler **虚函数调用**(access_store_at macroAssembler_x86.cpp:5478: AS_RAW 显式调基类/否则 bs->store_at 虚调,:5466-5475——初稿"解释器/JIT 直插"错);C1/C2=编译期 barrier 机器码
- **"三层架构" 简化**: 真实骨架=BarrierSet(FakeRtti :58-71 + Name 枚举 FOR_EACH_BARRIER_SET_DO :50-55 + **三子组件 _barrier_set_assembler/_c1/_c2 :72-74** ✓ + AccessBarrier 嵌套模板 :166-299 默认委托 RawAccessBarrier);特化链 G1BarrierSet::AccessBarrier→ModRef→BarrierSet→RawAccessBarrier(g1BarrierSet.hpp:88-108);barrier_set_cast<T> :302-306(FakeRtti 断言+static_cast)
- **装饰器不是 12 种**: 6 组约 24 个(内部 3+build-time 2+rt 1 / MO 6 / AS 3 / ON 4 / IN 2 / IS 3 / ARRAYCOPY+PTR 若干,accessDecorators.hpp:51-255)
- **"BarrierSetC2::ideal_node()" 编造(重要)**: barrierSetC2.hpp 无 ideal_node;真实=BarrierSetC2 虚方法 store_at/load_at(barrierSetC2.hpp:166-188)→G1BarrierSetC2::pre_barrier/post_barrier(g1BarrierSetC2.cpp:175/:372)用 **IdealKit** 生成节点序列(与汇编版同构: marking 检查→load 旧值→非空?→index!=0?(减 8 写入 buffer)/=0?(make_leaf_call write_ref_field_pre_entry :267-268));**节点可优化**: g1_can_remove_pre/post_barrier(:86/:306)+ReduceInitialCardMarks 跳过"刚分配未发布对象"卡标记(:391-398,obj==just_allocated_object);young 卡快速路径(:418)
- **三视角注入(大纲漏,重要)**: 汇编层=BarrierSetAssembler(默认 load_at/store_at 裸存取+压缩 oop 编解码 barrierSetAssembler_x86.cpp:34-130;解释器 do_oop_store templateTable_x86.cpp:146-158→store_heap_oop macroAssembler_x86.cpp:5501→access_store_at 虚分派);C1=G1BarrierSetC1 pre/post LIR(g1BarrierSetC1.cpp:51/:110)+Runtime1 blob 慢路径("g1_pre_barrier_slow" :194-221);C2=graphKit.cpp:56 `_barrier_set`+store_at/load_at 分派 :1606
- **CardTable**: card_shift=9/card_size=512 在 **cardTable.hpp:231-232**(大纲 80-150 漂移);CardValues :95-102(clean=-1/dirty=0/precleaned=1/claimed=2/deferred=4);byte_for :153-158;store_check 汇编(cardTableBarrierSetAssembler_x86.cpp:88-132): shrptr :97 + byte_map_base 位移寻址(simm32 或 ArrayAddress :101-117)+ movb dirty :130;UseCondCardMark 先 cmpb 后 movb :120-128(默认关);G1 的 oop_store_at 仅 in_heap+val 非空做 post(:134-153)
- **"G1SATBCardTableLogging/CardTableExtension" 是 JDK8 名**: JDK11 G1 用 G1BarrierSet+DirtyCardQueue(share/gc/g1/dirtyCardQueue.hpp:46+,PtrQueue 线程本地 index/buf,满转 DirtyCardQueueSet),G1-only 构建无 Parallel 分支
- **悬念指向** ✓(02-collected-heap 正确);大纲标题与 21-03 悬念链接文本对齐(半角→全角问号)
- **实证方法论**: ①-gc+phases=debug 阶段树(Update RS/Scan RS/Evacuate)是卡标记工作量的 GC 侧观察窗——2 亿次老对象引用写后 Update RS 真实处理卡片;②PrintAssembly 无 hsdis 的 nmethod header 可比较 C1 vs C2 代码尺寸(C1 1248/1344 vs C2 576);③**ReduceInitialCardMarks 的机器码对照不敏感**(G1 young 卡快速路径+OSR 形态使然,不要用 nmethod 尺寸做 RICM 证据);④gc+barrier/gc+remset 标签存在但无日志点;gc+cardtable 无效;⑤flag: ReduceInitialCardMarks {C2 product}/UseCondCardMark {product} 可开关

## 七、用户偏好与纪律(重要,违背会被批评)

1. **严格按规划,不做多余选择**: 拓扑定了顺序就逐项推进——不要问"还是写 X?"(曾因制造选择被批评)
2. **每篇都做深度 REVIEW(2 轮)**: 用户会要求"按照方法论深度的 REVIEW",写完后**主动自查深审,不要等**;用户还会追加"再次深度的 REVIEW"(第 3/4 轮)——按同样方法重新质疑,重点抓上一轮没抓到的"顺理成章"错误
3. **一篇一篇写**: 不并行、不跳步
4. **数字/事实必须验证**: 任何带数字的陈述回源码/素材验证,禁止"凭记忆"
5. **命名混淆注意**: "域 07"与"07 域的第 01 篇"都带 07,表述时写清"域 XX 第 Y 篇";目录名以 outlines/ 实际为准(31-unsafe-whitebox、44-class-verification、33-jmx-management)
6. 中文交流,提交信息用中文
7. 用户会追问"下一步规划是否合理"——要有自己的判断
8. **用户会追问"发现的问题都修复了吗/有沉淀吗"**——修复要有 commit 可查,沉淀要即时写进本文件 §6
9. 链接文本必须与目标文章标题一致
10. 上下文将满时用户会要求"写详细的交接文档"——把进度/commit/经验/下一步全部写全
11. **用户会怀疑实证工具**(如"是不是因为用的不是 openjdk 而是 konajdk")——实证 JDK 与源码版本匹配是硬要求,Temurin 11 已备好;回答要有对照实验支撑

---

## 八、待办清单(按优先级)

- [x] 第 1 批 12 篇 + 第 2 批 26 篇 + 第 3 批 14 篇——✅ 完结
- [x] 第 4 批 21 篇(10/19/23/24/08/31/44 域)——✅ **第 4 批收官**
- [x] 11-cds/01-02——✅ 完结;**11 域完结,第 5 批 2/13**
- [x] 12-ci/01-03——✅ 完结;**12 域完结,第 5 批 5/13**
- [x] 13-jit-framework/01-02——✅ 完结;**13 域完结,第 5 批 7/13**
- [x] 18-safepoint/01-02——✅ 完结;**18 域完结,第 5 批 9/13**
- [x] 20-vm-operations/01-02——✅ 完结(正文 4e942c1/回填 ⚠️ 14 组/README 7aae8ba,commit 见 §二);**20 域完结,第 5 批 11/13**
- [x] 27-jni/01-03——✅ 完结(正文 f64d2af/1ec9012/9f523af,commit 见 §二);**27 域完结**
- [x] 30-jvm-entry/01-03——✅ 完结(正文 9ed479d/bf0d15f/cfd6484,commit 见 §二);**30 域完结**
- [x] 32-jfr/01-06——✅ 完结(正文 0856326/1f5d2d3/6daa7f1/328c92f/b595e6b/f2a2c2f,commit 见 §二);**32 域完结**
- [x] 34-nmt/01——✅ 完结(正文 cb24e2a/回填 ⚠️ 9 组/README 0f2abb7/第 3 轮 58866ce/第 4 轮 434708a);**34 域 1/2**
- [x] 34-nmt/02——✅ 完结(正文 3fba0d4 含回填 ⚠️ 11 组/README 62e48f4/第 4 轮 c255130);**34 域完结,第 5 批 9/13**
- [x] 36-attach/01——✅ 完结(正文 3cbbe22 含回填 ⚠️ 10 组/README eb9dbf4/第 3 轮 cc3a38b/第 4 轮 e19b9f3);**36 域 1/2**
- [x] 36-attach/02——✅ 完结(正文 80537ed 含回填 ⚠️ 9 组/README a2f0430);**36 域完结,第 5 批 10/13**
- [x] 37-heap-dumper/01——✅ 完结(正文 b4d58cd 含回填 ⚠️ 11 组/README 8800102/第 4 轮 da7f010);**37 域 1/2**
- [x] 37-heap-dumper/02——✅ 完结(正文 5150644 含回填 ⚠️ 11 组/README 5528a26);**37 域完结,第 5 批 11/13**
- [x] 39-runtime-monitoring/01——✅ 完结(正文 f70b0c5 含回填 ⚠️ 9 组/README de26701/第 4 轮 32fe697);**39 域 1/2**
- [x] 39-runtime-monitoring/02——✅ 完结(正文 6cfef46 含回填 ⚠️ 10 组/README d7dff18/第 4 轮 16a954e);**39 域完结,第 5 批 12/13**
- [x] 46-sa-postmortem/01——✅ 完结(正文 e8526bc 含回填 ⚠️ 9 组/README eff5880);**46 域完结,第 5 批 13/13 收官**
- [x] 14-c1-compiler/01——✅ 完结(正文 0bbb913 含回填 ⚠️ 9 组/README 35d344e/第 4 轮 a256662);**14 域 1/4,第 6 批开篇**
- [x] 14-c1-compiler/02——✅ 完结(正文 d7c79df 含回填 ⚠️ 10 组/README b4e6586/第 4 轮 94a2793);**14 域 2/4**
- [x] 14-c1-compiler/03——✅ 完结(正文 6ba2903 含回填 ⚠️ 10 组/README 9d2f7ed/第 4 轮 428f011);**14 域 3/4**
- [x] 14-c1-compiler/04——✅ 完结(正文 9693e17 含回填 ⚠️ 10 组/README 811f3ed);**14 域完结,第 6 批 1/8**
- [x] 15-c2-compiler/01——✅ 完结(正文 58e4a25 含回填 ⚠️ 3 块 13 条/README 1992d9f);**15 域 1/8,第 6 批 2/8**
- [x] 15-c2-compiler/02——✅ 完结(正文 5e82ad9 含回填 ⚠️ 3 块 15 条/README 5fe6151);**15 域 2/8,第 6 批 3/8**
- [x] 15-c2-compiler/03——✅ 完结(正文 c64fa9e 含回填 ⚠️ 3 块 13 条/深审 0e51373/README 3cdf71b);**15 域 3/8,第 6 批 4/8**
- [x] 15-c2-compiler/04——✅ 完结(正文 44a2843 含回填 ⚠️ 3 块 17 条/README d3cbc0a);**15 域 4/8,第 6 批 5/8**
- [x] 15-c2-compiler/05——✅ 完结(正文 ccdcc91 含回填 ⚠️ 3 块 15 条/README 0f97c8b);**15 域 5/8,第 6 批 6/8**
- [x] 15-c2-compiler/06——✅ 完结(正文 ce8be4c 含回填 ⚠️ 3 块 15 条/README ba5d16c);**15 域 6/8,第 6 批 7/8**
- [x] 15-c2-compiler/07——✅ 完结(正文 08632d9 含回填 ⚠️ 3 块 14 条/README d1336c5+修正 1baaf23);**15 域 7/8,第 6 批 8/8 未到(剩 08 才域完结)**
- [x] 15-c2-compiler/08——✅ 完结(正文 4e53b4a 含回填 ⚠️ 3 块 17 条/README ee988b7);**15 域完结,第 6 批 2/8**
- [x] 21-shared-runtime/01——✅ 完结(正文 8aa51b6 含回填 ⚠️ 3 块 14 条/README 4023db8);**21 域 1/3,第 6 批 3/8**
- [x] 21-shared-runtime/02——✅ 完结(正文 d9d2141 含回填 ⚠️ 3 块 15 条/README e6b5fbe);**21 域 2/3,第 6 批 4/8**
- [x] 21-shared-runtime/03——✅ 完结(正文 e6ec256 含回填 ⚠️ 3 块/README e6ec256 同提交);**21 域完结,第 6 批 5/8**
- [x] 25-gc-framework/01——✅ 完结(正文 27dc391 含回填 ⚠️ 3 块/README 640c033);**25 域 1/6,第 6 批 6/8**
- [ ] **25-gc-framework/02**——**下一篇**;大纲 `planning/outlines/25-gc-framework/02-collected-heap.md`(CollectedHeap+分配路径: TLAB/PLAB/全局分配);25 域共 6 篇;25-01 悬念已指向 02
- [ ] 用户 Ubuntu GUI 截图(8 项 14 张,手册 `planning/outlines/00-jvm-tools/GUI-manual.md`): 用户完成后补进对应文章
- [ ] Obsidian 知识图谱(`planning/IDEAS-OBSIDIAN.md`,远期)
- [ ] 每域完成后在 `vol-02/README.md` 勾选进度

---

## 九、关键路径速查

| 东西 | 路径 |
|---|---|
| 写作顺序权威依据 | `docs/openjdk/planning/knowledge-planning/00-domain-writing-order.md` |
| 48 域权威清单 | `docs/openjdk/planning/00-domain-discovery-v3.md` |
| 每域 KP | `docs/openjdk/planning/knowledge-planning/<NN>-<域>.md` |
| 每域大纲(含 ⚠️ 回填) | `docs/openjdk/planning/outlines/<NN>-<域>/` |
| 写作指南 | `docs/openjdk/WRITING-GUIDELINES.md` |
| 深审缺陷档案 | `/data/workspace/source-code/book/成长之路/tmp-question/training-camp/source-code/issue/源码分析深审缺陷档案.md`(15 类) |
| 卷 2 进度 | `docs/openjdk/vol-02/README.md` |
| 源码树(jdk11u) | `/data/workspace/jdk11u/src/hotspot/`(仅 x86+linux!) |
| C1 编译器源码 | `/data/workspace/jdk11u/src/hotspot/share/c1/`(c1_Compilation/GraphBuilder/Instruction/Canonicalizer/ValueMap/Optimizer/LinearScan/LIRAssembler/Runtime1/FrameMap;x86 特化在 cpu/x86/) |
| C2 编译器源码 | `/data/workspace/jdk11u/src/hotspot/share/opto/`(node/type/phaseX(IGVN+NodeHash)/compile/parse1-3/graphKit/cfgnode/memnode/addnode/opcodes/c2_globals 等,x86 特化在 cpu/x86/) |
| SharedRuntime/桩 | `/data/workspace/jdk11u/src/hotspot/share/runtime/sharedRuntime.cpp`(3216 行: generate_stubs :99/handle_ic_miss_helper :1552)+`sharedRuntime.hpp`+`cpu/x86/sharedRuntime_x86_64.cpp`(4003 行: gen_c2i_adapter :585/gen_i2c_adapter :733/generate_i2c2i_adapters :943/generate_deopt_blob :2810) |
| 异常处理源码(21-03 用) | 预判: `share/runtime/` 的 exceptions.hpp/cpp、`share/interpreter/` 的 bytecodeInterpreter 异常分派、`share/code/` 的 exceptionTable、`cpu/x86/` 的异常 stub——写作时按大纲实际定位 |
| JDK 侧源码 | `/data/workspace/jdk11u/src/java.base/`、`/data/workspace/jdk11u/src/jdk.jfr/` |
| 工具素材 | `docs/openjdk/planning/outlines/00-jvm-tools/materials/`(commands/ 150+ 文件) |
| **实证 JDK(首选,与源码同版本)** | **`/data/tmp/opencode/jdk11/bin`(Temurin OpenJDK 11.0.32)** |
| 对照 JDK | `/data/tmp/opencode/jdk17/bin`(Temurin 17,含 src.zip);`/opt/codev/TencentKona/bin/`(17.0.8.1) |
| 自查脚本 | `/data/tmp/opencode/check.py`(代码块/行号/星号/锚;新文件先加 MAPPINGS/HS_MAP/**EXTERNAL**;ART 改当前文章;forward-link 用 basename 匹配 outlines;反引号 span 剔除于锚检查) |
| 实证工作目录 | `/data/tmp/opencode/acbench/`(SleepDemo/ReflectionDemo/jniref/ 系列 demo) |

**自查脚本要点**(python,每篇跑):
- 代码块: `re.findall(r'```cpp\n// (file):(s)-(e)\(...\)\n(.*?)```')` → 逐行比对(遇 "..." 跳过,strip 后判)
- 行号范围: HS_MAP(hotspot)+ MAPPINGS(JDK 侧)+ **EXTERNAL**(jdk.unsupported/jdk.jfr 等 SRC 树外)→ 行号 ∈ [1, 行数]
- 星号: 剔除代码 span 与反引号 span 后 `count('*') % 2 == 0`(裸星号如 `Method*`/`2^k`/`Tier*`/`JVM_*`/`jdk.*` 必须加反引号;**反引号配对先修**)
- 文字锚: 文件名后无行号的引用 → 报错补行号(计数逻辑已修: 文件名后跟 `:数字` 或非冒号非单词字符才计数,`System.currentTimeMillis` 不再误报)
- 链接: 相对链接按文章目录解析;forward link 豁免=outlines 全扫描按 basename 匹配
- **代码块行号不匹配时**: 用 python 自动对齐脚本(从标注起点逐行匹配块内容,输出真实终点)

---

## 十、下一步(读完立即做)

```
【25-gc-framework/02 写作指引——25 域 2/6,CollectedHeap + 分配路径】
1. 读 planning/outlines/25-gc-framework/02-collected-heap.md(注意 ⚠️ 块;25-01 回填 3 块,02 大概率同样漂移)。
   25-02 主题=CollectedHeap+分配路径(TLAB/PLAB/全局分配),按大纲实际内容验证,预判要点(以实际 grep 为准):
   - CollectedHeap 基类(collectedHeap.hpp/cpp,share/gc/shared): universe 单例/initialize/allocate/collect/GC cause
   - 分配三层: TLAB(bump pointer,threadLocalAllocBuffer.* tlab.cpp)/PLAB(promotion,plab.*)/全局分配(memAllocator.cpp 慢路径)
   - G1 视角: g1CollectedHeap 的 mem_allocate/tlab_allocate;25-01 已铺垫 barrier 保证引用图完整,本篇讲"顶点从哪来"
   - 与 25-01 衔接: 分配本身也过 barrier(ReduceInitialCardMarks/on_slowpath_allocation_exit 已提);GC 阶段树(gc+phases)实证可复用
2. 验证大纲所有 file:line 与专有名词——高发漂移类型照旧: ①函数名错;②行号全错(规划期估算);③机制编造(三层分配的边界/TLAB 大小计算);④归属错;⑤数字无据(cycle 数删)。09-memory-core 已讲过 Universe/堆,注意区分"堆结构"与"分配路径"
3. 实证优先用 /data/tmp/opencode/jdk11:
   - TLAB 行为: -Xlog:gc+heap=debug(TLAB 大小)/-Xlog:gc+phases=debug;jstat -gcutil
   - -XX:+PrintTLAB(diagnostic?)验证;UseTLAB flag 开关对照(14-c1/04 用过 -XX:-UseTLAB)
   - 分配路径对照: 大量小对象(全 TLAB)vs 大对象(直接进 humongous/全局)——GC 日志 heap 区观察
   - flag 边界: TLABSize/MinTLABSize/MaxTLABSize 等默认值 PrintFlagsFinal
4. 按第三节流程写 → 自查(脚本 /data/tmp/opencode/check.py,新引用文件先加 HS_MAP;ART 改回当前文件)→ 深审 2 轮(第 2 轮逐机制回源码质疑;用户常追加第 3/4 轮,重点抓: 跨段遗留、隐含断言、跨篇引用只保留目标篇实证过的内容)→ 回填大纲 ⚠️ 块 → 提交 → 更新 README → 更新本文件 §二/§五/§6.6x
5. **HANDOFF §6 追加新节的强制操作顺序(教训 6.68/6.73/6.74/6.75/6.76)**: ①新节内容先写成独立文本;②插入点=## 七、前一行(文件末尾追加,不碰任何旧节内容);③**立即 `grep -n "### 6.6"` 校验连续递增**;④再做其他编辑。禁止"new 含旧节标题"的替换模式。**另注意: 6.75 插入时曾误删 "## 七" 标题行(e34b53c),本次已修复(6.76 处)——任何编辑后检查 ## 七/## 八 标题仍在**
6. 25 域后 → 28-jvmti → 29-mh → 33-jmx → 43-nio-net(25-gc 共 6 篇大纲,写完 25 域后按 writing-order 续)
```

**环境**: Linux 容器,无显示器(GUI 截图等用户在 Ubuntu 补);jdk11u 源码在本地;git 推送即部署(docsify 站点)。**上下文已满: 本文件写完后,新会话只读本文件即可继续,不要依赖旧会话的记忆。**
