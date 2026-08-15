# SESSION-HANDOFF — 主交接文档(唯一入口,非常详细版)

> **状态**: 2026-08-15 | 卷 2 写作中: **99/152 篇完成**(第 1 批 12 + 第 2 批 26 + 第 3 批 14 + 第 4 批 21 + 第 5 批 26) | 第 1-4 批**全部完结**(12 个域);第 5 批(VM 核心)进行中 26 篇(11/12/13/18/20/27/30/32/34 九域完结,**本会话 16 篇: 20-02 + 27-jni(3) + 30-jvm-entry(3) + 32-jfr(6) + 34-nmt(2) + 36-attach(1),36 域 1/2**),下一篇 36-attach/02 | **上下文已满,本文件为非常详细交接版**——新 AI 只读本文件即可继续,不要依赖旧会话记忆
> **接收者: 新 AI —— 只读本文件,按"十、下一步"执行**

---

## 〇、三十秒总览(先读这个)

**项目**: 写一本 OpenJDK 源码分析书("格物致知"),源码树 = jdk11u(`/data/workspace/jdk11u/src/hotspot/`)。

**当前正在做**: 卷 2 按 48 域依赖拓扑写源码文章,每篇严格按方法论: 读大纲 → **所有行号重新 grep 验证** → 写 → 代码块与源码逐字核对 → **深审 2 轮(用户常追加第 3/4 轮 REVIEW)** → 回填大纲 ⚠️ 块 → 提交 → README → HANDOFF。

**下一步(唯一,无选择)**: 36-attach/02(JDK Attach API + loadAgent,大纲 `planning/outlines/36-attach/02-jdk-attach.md`;36 域两篇,01 已完结)。

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
第 5 批(VM 核心): **11 ✅ → 12 ✅ → 13 ✅ → 18 ✅ → 20 ✅(2/2) → 27 ✅(3/3) → 30 ✅(3/3) → 32 ✅(6/6) → 34 ✅(2/2) → 36 ✅(1/2)** → 37 → 39 → 46   🚧 进行中
第 6 批(JIT/GC): 14 → 15 → 21 → 25 → 28 → 29 → 33 → 43
第 7 批(上层): 22 → 26 → 35 → 40 → 47
```

**已完成 99 篇**(全部在 `docs/openjdk/vol-02/`):

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
| **36-attach** | 1-2 | `36-attach/01-attach-listener.md`(157) | ✅ 01 完结(本会话),**36 域 1/2** |

### 本会话 16 篇的 commit 清单(按 git log 为准,2026-08-14/15)

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

**34-nmt/02(NMT 报告与对比,34 域收官)**: 正文 3fba0d4(150 行,含大纲回填 ⚠️ 11 组)→ README 62e48f4(98/152,34 域完结)→ 深审 2 轮(①MemBaseline 无 diff 方法——diff 在 reporter 层(MemSummaryDiffReporter 带符号增量/MemDetailDiffReporter 双链归并),大纲 diff+threshold 全编造;②report_site 编造(真实 report_malloc_sites/report_virtual_memory_allocation_sites/report_virtual_memory_region);③NMTDCmd 注册在 Management::init 非 initialize_optional_support;④36-attach 链接标题对齐;⑤素材缺 committed 子段(正文引用超出素材→补素材 (A) 段 G1PageBasedVirtualSpace 栈);⑥scale: DCmd 默认 KB vs PrintNMTStatistics scale=1 字节(素材无后缀证据);⑦悬念指 35 过期→36-attach)

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

**本会话新增素材 15 个**(全部 gitignore 不入库,在 materials/commands/):
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
- `36-attach-trigger-demo.txt`(attach 触发链实证: touch .attach_pid+SIGQUIT→"Attach triggered" 日志+socket srw------- 0600 出现;无文件 kill -3=线程转储(信号二义);已初始化短路;转储含 "Attach Listener" #23 与 "Signal Dispatcher" #4;strace stat 证据;环境事实: 容器常驻 JMC/VisualVM 自动 attach 新 JVM(~1.6s)致"无信号也触发"假象,/tmp 堆积 .java_pid* 残留,os::get_temp_directory() Linux 写死 /tmp;jcmd 10500ms 超时更可能是目标进程已退出)
- `34-nmt-tracking-demo.txt`(NMTDemo summary 退出报告 82 行: Total reserved=18058807559/committed=1165695239,20 类,thread #18,"malloc=343389 #3287",tracking overhead=263488;detail 段: 虚拟内存区域+4 帧栈/malloc callsite 段 4 帧(PerfStringConstant 等)/线程栈 reserved 1048576+committed 8192 守卫页)备注: -XX:+PrintNMTStatistics 需先 -XX:+UnlockDiagnosticVMOptions(diagnostic flag)

**旧素材 19 个**(前会话): 08-bytecodes-javap / 08-interpreter-templates / 08-interpreter-counterdemo / 08-linkresolve-javap / 08-unsafe-demo / 08-whitebox-demo / 08-verifier-demo / 08-verificationtype-javap / 08-cds-demo / 08-cds-dump-full / 11-cds-load-demo / 12-ci-inlining-demo / 12-ci-typeflow-escape-demo / 12-ci-replay-demo / 13-jit-broker-demo / 13-jit-tiered-demo / 18-safepoint-demo / 18-safepoint-polling-demo / 20-vmops-demo

**引用纪律**: 工具实证必须真实存在——引用前 grep materials/ 验证;素材缺失的实证不要引用,改为布局推导。

---

## 六、本会话实战经验(最重要,新 AI 必读)

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

### 6.5 实证方法论新增(本会话沉淀)
- **JNI 系列**: 自写 JNI demo(gcc -shared -fPIC -I$JAVA_HOME/include);printf 要 fflush(stdout)(重定向全缓冲丢输出);GetObjectRefType 常量 1/2/3;jobject 参数是 local ref(传回 Java 再传回变 refType=1)
- **性能对照**: -XX:-UseFastJNIAccessors 开关,2000 万次 GetIntField 快 1.4ns vs 慢 15ns(10 倍)
- **-Xcheck:jni**: 泄漏警告每 32 个(33/66/99);挂起异常警告;无 flag 对照 0 警告
- **-verbose:jni**: [Dynamic-linking] vs [Registering] 对照(注册链实证)
- **nm 实证**: libjava.so/libjvm.so 的导出/UND 符号(JVM_* 174/jio_* 5/Java_ 207/U 131)
- **StackWalker**: SHOW_HIDDEN_FRAMES 亮反射帧;-Xlog:stackwalk=debug 证明过滤位置
- **JFR**: -XX:StartFlightRecording=filename=...,settings=profile;xxd 文件头;bin/jfr summary/print(--events 需 filter 参数;--xml);-Xlog:jfr+system=info(注意 -Xlog 尾逗号语法错误)
- **jcmd 不可用**: 容器 attach 超时——SIGQUIT(kill -3)线程转储替代

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

### 6.51 32-jfr/06(JNI Interface + Instrumentation + DCmd,32 域收官,大纲 10 组漂移含 6 处机制编造 + 深审 2 轮,2026-08-14)
- **"JfrClassAdapter::transform" 编造**: 真实=JfrEventClassTransformer::on_klass_creation(jfrEventClassTransformer.cpp:1515);调用点 klassFactory.cpp:222 JFR_ONLY(ON_KLASS_CREATION)(jfrKlassExtension.hpp:41 宏,IS_EVENT_KLASS trace_id 标记)——**类文件解析层拦截 jdk.jfr.Event 子类首次加载**,重写字节→新 InstanceKlass 替换+tag_as;日志字符串 "JfrClassAdapter:"(:1522)是旧名唯一来源
- **"方法入口 ASM 插桩" 错**: 注入=**事件类 schema**(5 方法壳 commit/begin/end/isEnabled/shouldCommit,:120-145 空方法体字节+3 字段 EventHandler,:60-61);急切模式调 Java EventInstrumentation.java:60(ASM 生成方法体)经 JfrUpcalls::new_bytes_eager_instrumentation(jfrUpcalls.cpp:146;Jfr::is_recording()||force_instrumentation :1406-1428)
- **"~20 JFR-required 类" 无依据**(删除): 只动 Event 子类
- **"JfrJniMethod::start/dump 类方法" 半对**: jfrJniMethod.cpp=JVM_ENTRY_NO_ENV 函数表(jfr_set_output/jfr_set_method_sampling_interval/jfr_emit_event/jfr_end_recording...)
- **"JfrJavaSupport::thread_local_jfr_ref" 编造**: 不存在
- **"JfrDCmd" 编造**: JfrStartFlightRecordingDCmd 等 5 个(jfrDcmds.hpp:30-141);execute(jfrDcmds.cpp:376)=参数翻译→构造 jdk/jfr/internal/dcmd/DCmdStart→JavaCalls run()→Recording.start()→JVM 接口
- **第 4 轮**: 急切注入条件精确化(Jfr::is_recording() 或 force_instrumentation)
- 实证: 32-jfr-jni-instrumentation-demo.txt

---

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
- [x] 34-nmt/02——✅ 完结(正文 3fba0d4 含回填 ⚠️ 11 组/README 62e48f4);**34 域完结,第 5 批 9/13**
- [x] 36-attach/01——✅ 完结(正文 3cbbe22 含回填 ⚠️ 10 组/README eb9dbf4/第 3 轮 cc3a38b);**36 域 1/2**
- [ ] **36-attach/02**(JDK Attach API + loadAgent,客户端 VirtualMachine 封装/loadAgent 流程)——**下一篇**;大纲 `planning/outlines/36-attach/02-jdk-attach.md`;36-attach/01 悬念已指向 02
- [ ] 36-attach 后 → 37-heapdump → 39-runtime-mon → 46-sa(第 5 批剩余 4 域)
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
1. 读 planning/outlines/36-attach/01-*.md(注意 ⚠️ 块——34 域两篇各回填 9/11 组,36 域大概率同样漂移;36-attach 重点: share/services/attachListener.cpp(AttachListener/AttachOperation/attach list 机制)、os_linux.cpp 的 attach socket/命名管道、attachListener_linux.cpp;与 34-nmt/02 衔接: DCmd 经 attach 通道进来,34 域实证里"jcmd attach 本容器不可用(10500ms 超时)"与"自 attach 被 JDK 禁止"是现成素材背景;17-03 SMR 与 attach listener 线程生命周期相关)
2. 验证大纲所有 file:line 与专有名词(按 §6.1 的规律与 6.52/6.53 的 34 域经验)
3. 实证优先用 /data/tmp/opencode/jdk11(Temurin 11,与 jdk11u 同版本);素材引用前 grep materials/ 验证;jcmd attach 不可用,实证可用 kill -3(SIGQUIT)线程转储或命令行 -Xlog/-verbose:jni;NMT 实证直接跑 NMTDemo+PrintNMTStatistics;36 域注意: attach 相关实证可能同样受限,先试 SIGQUIT 线程转储里 Attach Listener 线程
4. 按第三节流程写 → 自查(脚本 /data/tmp/opencode/check.py,新引用文件先加 HS_MAP/MAPPINGS/EXTERNAL;ART 变量改回当前文件)→ 深审 2 轮(用户会追加第 3/4 轮)→ 回填大纲 → 提交 → 更新 README
5. 36-attach 后 → 37-heapdump → 39-runtime-mon → 46-sa(第 5 批剩余 4 域)
```

**环境**: Linux 容器,无显示器(GUI 截图等用户在 Ubuntu 补);jdk11u 源码在本地;git 推送即部署(docsify 站点)。**上下文已满: 本文件写完后,新会话只读本文件即可继续,不要依赖旧会话的记忆。**
