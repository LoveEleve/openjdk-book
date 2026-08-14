# SESSION-HANDOFF — 主交接文档(唯一入口,非常详细版)

> **状态**: 2026-08-14 | 卷 2 写作中: **90/152 篇完成**(第 1 批 12 + 第 2 批 26 + 第 3 批 14 + 第 4 批 21 + 第 5 批 17) | 第 1-4 批**全部完结**(12 个域),第 5 批(VM 核心)进行中 17/17,**11-cds/12-ci/13-jit-framework/18-safepoint/20-vm-operations/27-jni/30-jvm-entry 域完结(本会话)**,下一篇 32-jfr | **上下文已满,本文件为非常详细交接版**——新 AI 只读本文件即可继续,不要依赖旧会话记忆
> **接收者: 新 AI —— 只读本文件,按"十、下一步"执行**

---

## 〇、三十秒总览(先读这个)

**项目**: 写一本 OpenJDK 源码分析书("格物致知"),源码树 = jdk11u(`/data/workspace/jdk11u/src/hotspot/`)。

**当前正在做**: 卷 2 按 48 域依赖拓扑写源码文章,每篇严格按方法论: 读大纲 → **所有行号重新 grep 验证** → 写 → 代码块与源码逐字核对 → **深审 2 轮(用户常追加第 3 轮 REVIEW)** → 回填大纲 ⚠️ 块 → 提交 → README → HANDOFF。

**下一步(唯一,无选择)**: 27-jni/03(JNI Check + 平台层,大纲 `planning/outlines/27-jni/03-jni-check-platform.md`;27-jni/02 悬念指向它: 参数错了谁来抓)。

**铁律**: ① 一篇一篇写,写完自查+深审 2 轮合格再下一篇;② 大纲/KP 的行号与机制描述是"线索不是事实",写作时必须重 grep——**实测每篇大纲有 2-15 处机制错误或行号漂移,83 篇无一例外**;③ 代码块贴真实源码(截取可,编造不可)——凭记忆写值必错,**"记忆中的代码"也要 grep 验证存在性**(本会话两次编造代码块: 44-02 的 check_end_stack、11-01 的 is_loading_success);④ 每篇写完整理后做深审,**必须 2 轮**(第 2 轮逐机制回源码质疑——第 2 轮才能抓到"顺理成章"的机制错误);⑤ 发现错误→修正文章→**回填大纲 ⚠️ 块**(防下次抄错)→提交;⑥ REVIEW 时正文与大纲的行号要一起过;⑦ 脚本语法错误要立即发现;⑧ 用户会追问"是不是 Kona 的问题"——实证 JDK 与源码版本要匹配,已下载 Temurin OpenJDK 11.0.32(见 §九)。

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
**旧交接文档**(更早会话起点,可参考历史): `/data/workspace/source-code/book/成长之路/tmp-question/training-camp/source-code/analysis/source-analysis/HANDOFF.md`

---

## 二、卷 2 写作进度(精确到篇)

**写作顺序依据**: `docs/openjdk/planning/knowledge-planning/00-domain-writing-order.md`(48 域依赖拓扑 7 层,脚本验证自洽)

```
第 1 批(地基): 01(4) → 05(2) → 45(2) → 48(4)                     ✅ 完结 12/12
第 2 批(原语): 02(4) → 03(2) → 04(2) → 06(6) → 16(5) → 38(2) → 41(2) → 42(3)   ✅ 完结 26/26
第 3 批(对象/类): 07(7) → 09(3) → 17(4)                          ✅ 完结 14/14
第 4 批(执行/帧): 10(3) → 19(4) → 23(3) → 24(3) → 08(4) → 31(2) → 44(2)   ✅ 完结 21/21
第 5 批(VM 核心): **11 ✅ → 12 ✅ → 13 ✅ → 18 ✅ → 20 ✅(2/2 完结) → 27 ✅(3/3 完结) → 30 ✅(3/3 完结)** → 32 → 34 → 36 → 37 → 39 → 46   🚧 进行中
第 6 批(JIT/GC): 14 → 15 → 21 → 25 → 28 → 29 → 33 → 43
第 7 批(上层): 22 → 26 → 35 → 40 → 47
```

**已完成 90 篇**(全部在 `docs/openjdk/vol-02/`):

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
| **08-interpreter** | 1-4 | `08-interpreter/01-bytecodes-definition.md`(308)/02-template-interpreter.md(330)/03-interpreter-runtime.md(244)/04-linkresolver-rewriter.md(269) | ✅ **08 域完结(本会话)** |
| **31-unsafe** | 1-2 | `31-unsafe-whitebox/01-unsafe-api.md`(151)/02-whitebox-forte.md(132) | ✅ **31 域完结(本会话)** |
| **44-class-verification** | 1-2 | `44-class-verification/01-verifier.md`(316)/02-verification-type.md(149) | ✅ **44 域完结,第 4 批收官(本会话)** |
| **11-cds** | 1-2 | `11-cds/01-cds-overview-dump.md`(138)+`02-cds-load-shared.md`(319) | ✅ **11 域完结(本会话)** |
| **12-ci** | 1-3 | `12-ci/01-ci-overview-mirror.md`(174)+`02-ci-typeflow-escape.md`(164)+`03-ci-factory-runtime.md`(128) | ✅ **12 域完结(本会话)** |
| **13-jit-framework** | 1-2 | `13-jit-framework/01-compile-broker-queue.md`(76)+`02-tiered-compilation-policy.md`(146) | ✅ **13 域完结(本会话)** |
| **18-safepoint** | 1-2 | `18-safepoint/01-safepoint-orchestration.md`(121)+`02-polling-verifiers.md`(97) | ✅ **18 域完结(本会话)** |
| **20-vm-operations** | 1-2 | `20-vm-operations/01-vm-operation.md`(103)+`02-background-init.md`(372) | ✅ **20 域完结,第 5 批 11/13(本会话)** |
| **27-jni** | 1-3 | `27-jni/01-handle-system.md`(171)+`02-jni-fast-path.md`(189)+`03-jni-check-platform.md`(78) | ✅ **27 域完结(本会话)** |
| **30-jvm-entry** | 1-3 | `30-jvm-entry/01-jvm-entry-points.md`(138)+`02-java-calls.md`(118)+`03-reflection-stackwalk.md`(111) | ✅ **30 域完结(本会话)** |

### 本会话 16 篇的 commit 清单(按 git log 为准)

**08-interpreter/01(Bytecodes 定义表)**: 正文 b34880a → 大纲回填 05d5c11(⚠️ 11 条)→ README 4ee15e1(66/152)→ HANDOFF 66ae707 → **第 3 轮 REVIEW** e4d5f42+24da2f2(is_aload 枚举不连续/快速化闭环 templateTable_x86.cpp:973/getfield patch :2929/verifier.cpp:754 语义/BcDemo 六方法)
**08-interpreter/02(Template Interpreter)**: 正文 9c80ab1(含 01 篇 0xCB-0xFF 修正: 真正未定义是 0xEF-0xFF 17 个,0xCB-0xEE 是 fast 系列)→ 回填 e6c2f3e(⚠️ 11 条)→ README b6e7dbf(67/152)→ HANDOFF 08ec0b4 → **第 3 轮** 2c55647(wide 链 jump _wentry_point :4504-4510/iadd=pop_i+addl iop2 :1337-1340/deopt 三态/deopt_reexecute_entry 特判/bytecodes_init init.cpp:104)
**08-interpreter/03(InterpreterRuntime)**: 正文 1d2807d → 回填 8523d0d(⚠️ 8 条)→ README 3c9e272(68/152)→ HANDOFF 3a4fde4 → **第 3 轮** db55e5d(safepoint 检查在 transition 两向 block_if_requested interfaceSupport.inline.hpp:111-123/get_vm_result 读回 :2572-2574/increment_mask_and_jump=andl+jcc :1956-1967/forward_exception :2556-2568/入口 46 个)
**08-interpreter/04(LinkResolver + Rewriter)**: 正文 050eb2d → 回填 61b4df7(⚠️ 10 条)→ README 587e62e(69/152,**08 域完结**)→ HANDOFF b9c1bfc → **第 3 轮** 9ae2af7(指令替换两类: lookupswitch+ldc→fast_aldc :355 修正自相矛盾/rewrite_class instanceKlass.cpp:851-857 时机/fast_* 只能由 Rewriter 产生/is_resolved b1/b2 半槽共享)
**31-unsafe/01(Unsafe 底层 API)**: 正文 f902593 → 回填 0ccf408(⚠️ 9 条)→ README 9780838(70/152)→ HANDOFF 82eb54f → **第 3 轮** edf1e48(反射绕 theUnsafe 补 JDK11 permit 条件实测/assert_field_offset_sane NULL 跳过 :105-118/defineAnonymousClass JDK17 已移除 实测 Temurin 17 src.zip)
**31-unsafe/02(WhiteBox + Forte)**: 正文 5b9a5d1 → 回填 e53a138(⚠️ 6 条)→ README 78063ea(71/152,**31 域完结**)→ HANDOFF c16990b → 目录修正 87aa89b → **第 3 轮** 735f67e(ThreadInAsgct 实际 forte.cpp:559/thread.hpp:777,gc 竞态注释 :588-590)
**44-class-verification/01(ClassVerifier)**: 正文 f510ced → 回填 8c22eb0(⚠️ 7 条,大纲行号全对,补充机制为主)→ README 471a9da(72/152)→ HANDOFF ac47702 → **第 3 轮** 943f66b(接口可赋值特例 数组只可赋 Cloneable/Serializable verificationType.cpp:47-77/<init> 必须 void :2725-2742)
**44-class-verification/02(VerificationType)**: 正文 97cceb3 → 回填 9ec3c4b(⚠️ 7 条)→ README 838b56d(73/152,**第 4 批收官**)→ HANDOFF bb16581 → **第 3 轮** 0bd8215(实证解读修正: [ long, long ] 是 2 个 long 变量,双槽证据=原始字节 number_of_locals=4 vs 类型项 2 个 fd 00 05 04 04 04)
**11-cds/01(CDS 全景与 Dump)**: 正文 171bf24 → 回填 a9dafe0(⚠️ 8 条)→ README a35de82(74/152,第 5 批开篇)→ HANDOFF ca5ccc8 → **第 3 轮** 5375e05(java_mirror 移除与 remove_unshareable 分列两函数 :501/:489/narrow_klass_base 重合=主动设计 set_narrow_klass_base(_shared_rs.base()) :305/classlist 行数断言删除)
**11-cds/02(CDS Load 端,11 域收官)**: 正文 e8f9905 → 回填 2e9bc6c(⚠️ 13 条)→ README 529c91d(75/152,11 域完结,第 5 批 2/13)→ 素材 11-cds-load-demo.txt(gitignore)→ **第 3 轮** ff00933(①SymbolTable lookup 顺序表述错——实际初始先查动态表,_lookup_shared_first 是"最近命中方优先"启发式,symbolTable.cpp:242-258,字符串表才固定先共享;②_adapter_trampoline 位置错——在 ConstMethod(constMethod.hpp:212),指向 RW 区槽初始 NULL,非"RW 区字段";③MAP_FIXED 不报错(占用时静默替换),兜底靠 map_region 的 base != requested_addr;顺带补 COW 细节: ro 纯共享、rw/mc 写脏后 COW;④01 篇承诺的"rw 区加载期 patch"明确化(方法入口 trampoline/adapter 槽,第 6 节);⑤lookup_from_stream 调用行号 :1074→:1072)
**12-ci/01(ciObject 镜像体系,12 域开篇)**: 正文 4fe2ebf → 回填 13bae76(⚠️ 9 条)→ README e7ee1d1(76/152,12 域 1/3)→ 素材 12-ci-inlining-demo.txt(gitignore)→ **第 3 轮** 3dc78e4(①"资源区"错——ciEnv 的 _ciEnv_arena 是 C 堆上的 mtCompiler Arena,非 ResourceMark 资源区;②is_interface 虚分派细节——ciKlass.hpp:97 基类仍 virtual,内联位测试仅当静态类型是 ciInstanceKlass 时才成立,大纲"零虚函数"只对了一半;③update_if_shared 是"快照值与查询目标不一致才现算"(ciInstanceKlass.hpp:109-113),非每次查询;④will_link 引用节号 6→5)
**12-ci/02(ciTypeFlow + bcEscapeAnalyzer,12 域 2/3)**: 正文 f06d6fa → 回填 63c7534(⚠️ 10 条)→ README b9aeac8(77/152,12 域 2/3)→ 素材 12-ci-typeflow-escape-demo.txt(gitignore)→ **第 3 轮** d4d2fe8(①is_recursive_call 语义错——_parent 链用于**递归检测**(callee 是否在调用链上,:206-207),非"借用父分析";②get_start_state 行号 :346→:363;③Parse 消费方式精确化——解析以 flow 块图为骨架(rpo_at/successors/exceptions,parse1.cpp:1250/1274-1275),OSR 场景才用块类型(:223/346);④do_analysis 入口跳过条件补全: abstract/native/持有者未初始化/深度超 MaxBCEAEstimateLevel/大小超 MaxBCEAEstimateSize→全保守(:1302-1316))
**12-ci/03(ciObjectFactory + ciReplay,12 域收官)**: 正文 aef0f86 → 回填 55ece51(⚠️ 9 条)→ README 524cb48(78/152,12 域完结,第 5 批 5/13)→ 素材 12-ci-replay-demo.txt(gitignore)→ **第 3 轮** c1353f2(①ciInstanceKlass 行解读错——真实=is_linked/is_initialized/cp_length+**常量池 tags**(ciInstanceKlass.cpp:713),不是"布局信息";②staticfield 行=**static final 字段**(is_initialized() 才打印,:740-744,注释 "in case the compilation relies on their value"),非所有静态字段;③orig 段措辞: 计数器"藏于头部字节"非"前两个值就是计数"(小端字节);④共享镜像长命 Arena 例外补注)
**13-jit-framework/01(CompileBroker 编译队列,13 域 1/2)**: 正文 934721b → 回填 1977a6b(⚠️ 7 条)→ README 888bfee(79/152,13 域 1/2,第 5 批 6/13)→ 素材 13-jit-broker-demo.txt(gitignore)→ **第 3 轮** de6faed(①"FIFO 无优先级"错——队列是 FIFO 链表但 **get 时策略 select_task 按 weight 重选热点**(compileBroker.cpp:464→tieredThresholdPolicy.cpp:285-312;weight=(rate+1)×(inv+1)×(backedge+1) :529-533;rate=每 ms 事件数 update_rate :471-500)——大纲 compute_priority 函数名编造但"热点优先"精神真实;②stale 精确化: is_unloaded 或排队超 TieredCompileTaskTimeout=50ms(globals.hpp:2337)且无事件(,is_stale :509-520);is_old(5万/50万)不移除 rate 清零(:523-527);③post_compile=mark_success+检查 task->code()!=NULL(:2174)——nmethod 注册是 ciEnv::register_method 干的;④code cache 满: UseCodeCacheFlushing 时暂停(可恢复)否则 disable_compilation_forever(:2319-2329))
**13-jit-framework/02(TieredThresholdPolicy,13 域收官)**: 正文 fe61eae → 回填 b5ff7e1(⚠️ 8 条)→ README c526e7d(80/152,13 域完结,第 5 批 7/13)→ 素材 13-jit-tiered-demo.txt(gitignore)→ **第 3 轮** fd742ad(①level 3→4 判定用 **MDO 计数增量**(invocation_count_delta/backedge_count_delta,common :802-803,非方法原始计数;would_profile false 直接升 4 :807-809);②should_create_mdo 语义: 计数达 C1 阈值的 **200%**(Tier0ProfilingStartPercentage)才在解释器建 MDO("足够老"),非"提前"——200% 是阈值翻倍)
**18-safepoint/01(Safepoint 编排,18 域 1/2)**: 正文 1b4b441 → 回填 b24f7fa(⚠️ 8 条)→ README b6ed56d(81/152,18 域 1/2,第 5 批 8/13)→ 素材 18-safepoint-demo.txt(gitignore)→ **第 3 轮** a10d2f5(①**x86_64 默认 thread-local poll**——THREAD_LOCAL_POLL 宏(globalDefinitions_x86.hpp:68),SafepointMechanism 构造 set_uses_thread_local_poll(safepointMechanism.cpp:37-39);编译代码/解释器轮询=testb 线程自己的 _polling_page 字段(macroAssembler_x86.cpp:3744-3756,interp_masm_x86.cpp:832-834 "Thread-local Safepoint poll"),**不触发 SIGSEGV**——01-os/04 的轮询页是全局页模式,JDK11 x86 非默认,别混;②os::serialize_thread_states 只在 !UseMembar(x86 默认 true)时执行(:256-258);③全局页模式解释器才切 dispatch 表+编译代码 SIGSEGV;**注: 18-02 第 3 轮(06086f2)修正本条②的表述——编译代码(C1/C2)轮询是 deref 方式,armed 时仍真 SIGSEGV(01-os/04 路径真实存在),'不触发 SIGSEGV'只对解释器/MacroAssembler 路径成立,以 18-02 为准**)
**18-safepoint/02(轮询与 NoSafepointVerifier,18 域收官)**: 正文 e2896a5 → 回填 a0a97bf(⚠️ 10 条)→ README 2e63aeb(82/152,18 域完结,第 5 批 9/13)→ 素材 18-safepoint-polling-demo.txt(gitignore)→ **第 3 轮** 06086f2(①轮询**双实现**——解释器/共享 stub=testb 位测试(MacroAssembler::safepoint_poll),**C1/C2 编译代码=deref 方式**(movptr 线程 poll 值+testl [poll_addr],c1_LIRAssembler_x86.cpp:558-575/x86_64.ad:1099-1102)——armed 值=8|bad_page 落在 PROT_NONE 页→**真 SIGSEGV**→is_poll_address(os.hpp:429)→get_poll_stub(os_linux_x86.cpp:431-432)→safepoint 阻塞;**01-os/04 的轮询页 SIGSEGV 在 JDK11 x86 真实存在(编译代码路径)**,thread-local 只是把被轮询地址从全局页变成线程自己的值;②全局页模式: 编译代码 deref 全局 polling_page(C1 :576-592),解释器退化 cmp32 state;③轮询点归属: 编译代码=C1 LIR/C2 SafePoint 节点,解释器=MacroAssembler)
**20-vm-operations/01(VM_Operation 从提交到执行,20 域 1/2)**: 正文 b30c2e8 → 回填 b2c8867(⚠️ 7 条)→ README f0ed423(83/152,20 域 1/2,第 5 批 10/13)→ 素材 20-vmops-demo.txt(gitignore)→ **第 3 轮** 7221a66(①doit_prologue 语义——VM_RevokeBias::doit_prologue 检查对象**是否还带 bias 标记**(biasedLocking.cpp:520-534,"avoid a safepoint"),非大纲的"检查线程栈";②唤醒机制——**登记≠唤醒**: evaluate_operation 只 increment_vm_operation_completed_count(:427-429),等待者由 **loop 每轮结束的 VMOperationRequest_lock->notify_all()**(vmThread.cpp:622-624)统一唤醒后自检 ticket;③loop 末尾复查 no_op_safepoint_needed(true)(:625-631,18-01 Cleanup 另一触发点))
**20-vm-operations/02(后台任务与启动序列,20 域收官)**: 正文 4e942c1(371 行)→ 回填 ⚠️ 14 组 → README 7aae8ba(84/152,20 域完结,第 5 批 11/13)→ 素材 20-background-init-demo.txt(gitignore)→ **第 3 轮** e1a7c49(01 篇后续链接文本与 02 实际标题对齐;02 关联域去 04-logging 改 39-runtime-mon;设计意图表述收窄到注释原意;VMThread 优先级表述精确化"必须低于 WatcherThread")→ **第 4 轮** 1bc3a42(①ServiceThread 行号与职责对齐——serviceThread.hpp:30 类注释+:84 entry 循环,:107-139 JVMTI/GCNotifier/DCmd 三事件;②Agent 启动时序——线程列表 :3804 才初始化,代理在调用者线程上;③sleep 重算循环 :1435-1446;④关键设计引注回 :1369-1371 原意;⑤stubGenerator 注释 :5974-5976;⑥AbortVMOnVMOperationTimeout 补默认 false globals.hpp:528;⑦静态数组块补 task.cpp:32-33 标注脚本覆盖 11 块;⑧ServiceThread 'GC 低内存通知'→'GC 通知(GCNotifier)';验证 develop flag 在 PRODUCT 下是 const 常量→CleanChunkPoolAsync 恒 true 注册成立,MemProfiling 恒 false)
**27-jni/03(JNI Check + 平台层,27 域收官)**: 正文 9f523af(78 行)→ 回填 ⚠️ 10 组 → README 9f523af 同提交(87/152,27 域完结)→ 素材 27-jni-check-demo.txt / 30-jvm-entry-demo.txt / 30-java-calls-demo.txt / 30-reflection-stackwalk-demo.txt(gitignore)→ 深审 2 轮(①JNI_ENTRY_CHECKED **不含 ThreadInVMfromNative**——不做整函数状态转换,校验点用 IN_VM 局部转换(与 JNI_ENTRY 的关键差异);②jniExport.hpp 不是 JNI 函数声明而是 JVMTI 接口导出器;jni_NativeInterface 实例在 jni.cpp:3528 非 3550;validate_handle :443/validate_object :469 非 :497)第 3 轮无新增→ **第 4 轮** 35f96a8(①校验维度表补'字段 ID 类型'行(checkStaticFieldID :256/checkInstanceFieldID :284)→ 7→8 维度与悬念一致;②尾部链接统一相对路径;③fatal 路径差异: 宏内非 Java 线程=直接 print+abort 无 JNI 栈,与 NativeReportJNIFatalError 不同)
**27-jni/02(JNI Fast Path,27 域 2/3)**: 正文 1ec9012(189 行)→ 回填 ⚠️ 10 组 → README 1ec9012 同提交(86/152,27 域 2/3)→ 素材 27-jni-fastpath-demo.txt(gitignore)→ 深审 2 轮(①quicken_jni_functions 在 create_vm **第三段**(thread.cpp:3916)非第四段;②fieldID 偏移=BitsPerWord-2(64 位 62 位),位布局注释 "30" 是 32 位遗留)第 3 轮无新增→ **第 4 轮** da75d76(①安全论证补全——对象移动必然伴随 counter 变号,投机读读到旧位置值也被二次校验丢弃;②补 counter wraparound(hpp:54-55);③"条件 5 选 1"歧义改"替换的 5 个条件";④验证 GetObjectField 普通实现=HeapAccess oop_load_at+make_local(jni.cpp:2076)支撑无快路径断言;⑤验证 jni_GetStaticIntField 仅函数表槽)
**27-jni/01(Handle 系统,27 域 1/3)**: 正文 f64d2af(171 行)→ 回填 ⚠️ 9 组 → README f64d2af 同提交(85/152,27 域 1/3)→ 素材 27-jni-handles-demo.txt(gitignore)→ **第 3 轮** 6d6b59f(参数 handle 机制精确化——编译代码 object_move sharedRuntime_x86_64.cpp:1157-1180+解释器 pass_object interpreterRT_x86_64.cpp:214-260 lea 取参数槽地址,null 参数传 NULL;06-oops/01 链接文本对齐;jweak 对齐=weak_tag_alignment=2)→ **第 4 轮** 786af8f(①free list 成因精确化——由 rebuild_free_list 扫描清空槽构建(:548-575,"cleared out by a delete call"),非 DeleteLocalRef 直接串链;取用 :519-524;②OopStorage release 细节——CAS 清位 :575-587+空块延迟清理 reduce_deferred_updates :416,区间 :675-682;③悬念"函数表查 env"→"经 JNIEnv 函数表间接调用";④SIGQUIT 摘要行措辞)

**本会话新增素材**(全部 gitignore 不入库,在 materials/commands/):
- `08-bytecodes-javap.txt`(BcDemo 六方法 javap -c: 76 条固定长指令与 def 表全对/lookupswitch 对齐 1→44/invokedynamic 5 字节)
- `08-interpreter-templates.txt`(PrintInterpreter: 271 codelets avg 404B/iload 192 vs iload_0 96/iconst 7×96B/iadd 64B/ldc 736B/invokevirtual 1280B)
- `08-interpreter-counterdemo.txt`(CounterDemo PrintCompilation 全链 tier3→`%`tier4@4→tier4→made not entrant + PrintFlagsFinal 阈值附注)
- `08-linkresolve-javap.txt`(javap -v Methodref/Fieldref/InvokeDynamic#0→BootstrapMethods)
- `08-unsafe-demo.txt`(getUnsafe SecurityException/反射取 theUnsafe/String.value offset 12/CAS/allocateInstance x=0/pageSize 4096)
- `08-whitebox-demo.txt`(最小 WhiteBox 兼容类: 不开 flag→UnsatisfiedLinkError/开 flag→heapOopSize 4/vmPageSize 4096/isGCSupported/g1IsHumongous/fullGC)
- `08-verifier-demo.txt`(iload_0→aload_0 一字节修改: VerifyError 详细转储 vs -Xverify:none 照跑 result=3)
- `08-verificationtype-javap.txt`(javap -v: loop 方法 StackMapTable locals=[ long, long ])
- `08-cds-demo.txt` + `08-cds-dump-full.txt`(cds dump 归档 1211 类含 1151 instance/11.9MB/6 空间区 mc-rw-ro-md-st0-oa0;启动 class+load 356 个 shared objects file)
- `11-cds-load-demo.txt`(Load 端实证: 默认归档落 lib/server/classes.jsa;加载 cds 日志(校验+relocation delta=0+Trying to map heap data region[4]/[6]);坏 magic 降级(mixed mode 无 sharing);-Xshare:on 缺归档退出(An error has occurred.../Unable to use shared archive);classpath mismatch+class+path 详情(Expecting -Djava.class.path=cpA.jar vs cpB.jar);-Xmx1g 触发 incompatible oop encoding 重定位 delta=-28991029248 照用;AppCDS 下应用类 T source: shared objects file)

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

**深审流程(写完后主动做 2 轮;用户常追加"再深度 REVIEW"=第 3 轮及以后,按同样方法再质疑)**:
```
第 1 轮: 通读全文 + 跑自查脚本(代码块/行号/星号/文字锚/TODO)
第 2 轮(最重要,专门抓"写对但机制是编的"):
    ① 写作时"凭记忆/凭直觉"补的机制描述——逐个回源码核对(识别信号: "所以/为什么能/自然"开头的推导段)
    ② 正文引用的 file:line 内容语义(不是存在性)
    ③ 数字自洽(全文 grep 关键数字,含默认值/枚举值)
    ④ 文字锚(文件名后无行号的引用)
    ⑤ 跨篇一致性: 本篇 OUTBOUND 悬念行描述、上篇悬念承诺的话题(逐条对照正文是否覆盖)
    ⑥ 元文档自查(HANDOFF/README 篇数)
发现错误 → 修正文章 → 回填大纲(#15 规则)→ 提交
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
- 跨篇引用用相对/`openjdk/vol-02/...` 路径;**链接文本必须与目标文章标题一致**(已抓过多次)

### 4.3 书稿代码块纪律(血泪总结,每篇深审都靠它抓错)
1. **代码块 = 真实源码**: 截取可(省略模板/错误处理,用 "..." 占位),核心语句逐字,**禁止凭记忆写值/编码/常量/注释**
2. **行号写作时重新 grep**: 大纲/KP 是规划期产物,行号大量漂移——每篇实测都有 2-15 处漂移
3. **自查脚本**(/data/tmp/opencode/check.py): 文章每个 file:line 逐个核对;代码块与源码逐行 diff("..." 跳过);新文件先加 MAPPINGS(JDK 侧)/HS_MAP(hotspot 侧,单行 dict,追加时注意逗号);**EXTERNAL 字典**处理不在 SRC/HS 树内的文件(如 sun.misc.Unsafe.java 在 jdk.unsupported 模块)
4. **文件名必须 find 验证**: 目录/文件路径凭记忆必错
5. **大纲的"篇数/数字"也要重验**: 进度表述以 outlines/ 实际文件数为准

### 4.4 深审缺陷档案(`/data/workspace/source-code/book/成长之路/tmp-question/training-camp/source-code/issue/源码分析深审缺陷档案.md`,15 类)
- A 内容层: #1 事实错误 / #2 API 编造 / #3 文件名推断 / #4 跨项目转移 / #5 覆盖率 / #6 跨层不一致
- B 结构层: #7 文字锚 / #8 篇节标注 / #9 表格格式 / #10 数字自洽
- C 过程层: #11 范围规划不可信 / #12 待确认清零 / #13 一次一域 / **#14 书稿代码块编造(写作期高发)** / **#15 大纲描述与源码漂移**

---

## 五、素材库(写作时引用实证)

| 素材 | 位置 | 用途 |
|---|---|---|
| 素材索引 | `planning/outlines/00-jvm-tools/materials/INDEX.md` | 按域查素材的入口 |
| JFR 录制 | `materials/jfr-recordings/rec-demo.jfr` 等 10 个 | 事件计数实证 |
| 命令输出 | `materials/commands/` 140+ 文件 | jcmd/jstat/jmap 等真实输出 |
| 卷 T 文章 | `vol-tools/ch01.md`~`ch07.md` | 引用格式: "[卷 T ch02](openjdk/vol-tools/ch02.md)" |

**本会话新增素材**(详见 §二 commit 清单,共 26 个): 08-bytecodes-javap.txt / 08-interpreter-templates.txt / 08-interpreter-counterdemo.txt / 08-linkresolve-javap.txt / 08-unsafe-demo.txt / 08-whitebox-demo.txt / 08-verifier-demo.txt / 08-verificationtype-javap.txt / 08-cds-demo.txt / 08-cds-dump-full.txt / 11-cds-load-demo.txt / 12-ci-inlining-demo.txt / 12-ci-typeflow-escape-demo.txt / 12-ci-replay-demo.txt / 13-jit-broker-demo.txt / 13-jit-tiered-demo.txt / 18-safepoint-demo.txt / 18-safepoint-polling-demo.txt / 20-vmops-demo.txt / 20-background-init-demo.txt / 27-jni-handles-demo.txt / 27-jni-fastpath-demo.txt / 27-jni-check-demo.txt / 30-jvm-entry-demo.txt / 30-java-calls-demo.txt / 30-reflection-stackwalk-demo.txt

**引用纪律**: 工具实证必须真实存在——引用前 grep materials/ 验证;素材缺失的实证不要引用,改为布局推导。

---

## 六、本会话实战经验(最重要,新 AI 必读)

### 6.1 大纲漂移的规律(83 篇全部出现,2-15 处/篇;旧会话沉淀 02/03/04/45/48/06/16/38/41/42/07/09/17/10/19/23/24 域,本会话沉淀 08/31/44/11/12/13/18/20 域)
**任何机制描述/行号/值/专有名词,一律当"线索"而非"事实"**。高频漂移类型:
1. **机制编造**(最严重): 大纲把"想当然的实现"写成机制——实证全部是编造
2. **版本漂移**: 大纲写的是 JDK 8/其他版本的机制(31-01 的 CAS 单路径是 JDK8 形态;11-01 的 od region 是旧版)
3. **行号漂移**: 大纲行号与实际差几十到几百行
4. **文件名漂移**: 目录/文件路径凭记忆必错(31 域目录是 31-unsafe-whitebox 不是 31-unsafe;44 域目录是 44-class-verification 不是 44-verification)
5. **"声明有、实现无"**: 入口表里挂名的 ≠ 有实现(11-01 的 "link_and_serialize" 不存在;44-02 的 is_assignable_from 伪代码是编造)
6. **悬念指向错**: 大纲的"下一篇"常常过期(44-02 大纲指向域 45 Math——45 域早已完结;正确指向 11-cds 第 5 批)

### 6.2 写作期"凭记忆"错误(自查 diff 抓出的真实案例,每篇深审必有)
- 08 域: "0xCB-0xFF 未分配区"错(实际 0xCB-0xEE 是 fast 系列,未定义只有 0xEF-0xFF);is_aload 点名原因错(枚举不连续非重写)
- 31 域: "JRT_ENTRY"错(解释器是 IRT_ENTRY 家族);"JFR 用 Forte"错(JDK11 JFR 用 SuspendedThreadTask)
- 44 域: "i2b 推 Byte 类型"错(推 integer,窄化类型来自方法签名);"pop 扣两槽"错(只弹一槽次槽出界)
- 11 域: "link_and_serialize"不存在;classlist 行数无依据
- **教训**: 凡代码块里的值/编码/常量/注释,写完必须用 sed 逐行对照;数字先数后写;推导段("所以/为什么能")必须回源码找依据;REVIEW 时正文与大纲 ⚠️ 块行号一起过

### 6.3 写作期血泪(本会话新增,最高优先级)
- **记忆代码编造×2(本会话)**: ①44-02 的 stackMapTable.cpp 块混入不存在的 `check_end_stack()`/"Let's just insert a bogus type"(grep 零命中);②11-01 的 preload_classes 块编了 `is_loading_success` 分支(真实是 `ClassLoaderExt::load_one_class`)。**自查脚本的逐行 diff 当场抓出**——写代码块时宁可多抄几行真实代码,绝不"凭记忆补全";深审时对每个函数名做存在性 grep
- **块标注范围反复错**: 44-02 的 verificationType.hpp 三个块连续 4 轮标注错(内容比标注多几行)——用 python 脚本"内容跨度自动对齐"(从标注起点逐行匹配到块末行,输出真实终点行号)一次解决
- **反引号/星号配对**: 44-01 一个漏掉的反引号让全篇 100+ 星号统计全乱;statistics 前先修反引号配对

### 6.4 平台/环境事实(写作时已确认)
- **jdk11u 源码树只含 x86 平台**(cpu/ 只有 x86,os/ 只有 linux/posix)——不要断言其他平台的实现细节
- 常用实证: **Temurin OpenJDK 11.0.32 在 /data/tmp/opencode/jdk11**(与 jdk11u 同版本,实证首选);Temurin 17 在 /data/tmp/opencode/jdk17(含 src.zip 可查 API 变迁);TencentKona 17/21 在 /opt/codev/
- 本会话关键源码位置: templateInterpreter.cpp/hpp、templateTable.cpp、interpreterRuntime.cpp(:148-215 ldc/resolve_ldc、:217 _new、:749 monitorenter、:1176 at_safepoint、:1008 frequency_counter_overflow)、interfaceSupport.inline.hpp(:445 IRT_ENTRY、:468 JRT_ENTRY、:111-123 ThreadStateTransition)、unsafe.cpp(1122 行)、whitebox.cpp(2360 行)、forte.cpp(668 行)、verifier.cpp(2913 行)、verificationType.hpp/cpp、metaspaceShared.cpp(2184 行)、filemap.hpp/cpp(1515 行)、systemDictionaryShared.cpp(1071 行)、compactHashtable.cpp(529 行)、heapShared.cpp(862 行);ci 系: ciObject.cpp(handle 双通道)/ciObjectFactory.cpp(728 行,工厂缓存 :305-334)/ciInstanceKlass.cpp(:599 implementor,:713 dump_replay_data)/ciMethod.cpp(:965 ensure_method_data)/ciField.cpp(:246 initialize_from,:257-291 is_constant)/ciMethodData.cpp(:170 load_data)/ciTypeFlow.cpp(3048 行,:272 type_meet,:2727 flow_types)/bcEscapeAnalyzer.cpp(:167 set_global_escape,:1201 do_analysis)/ciReplay.cpp(:1074 replay_impl,:1115/:1206 initialize)/ciEnv.cpp(:215 析构,:1231 dump_replay_data_unsafe,:947 register_method);编译器系: compileBroker.cpp(2841 行,:464 select_task 调用,:1479 assign_compile_id,:2062 invoke_compiler_on_method,:1532 create_compile_task)/compileTask.hpp(CompileReason :48-59)/tieredThresholdPolicy.cpp(980 行,:44/:65 predicate helper,:202 initialize 线程数,:285 select_task,:371 event,:715 common,:676-712 转换图注释,:884/:903 两事件)/compilerDefinitions.hpp(CompLevel :54-63);safepoint 系: safepoint.hpp(三态 :61-66,counter :112-119,ThreadSafepointState :228-277)/safepoint.cpp(1474 行,:155 begin,:499 end,:731 do_cleanup_tasks,:647 ParallelSPCleanupTask::work,:816 block,:1045 examine_state_of_thread,:440 no_op_safepoint_needed)/safepointMechanism.cpp(:36 default_initialize,armed/disarmed 值 :50-76)/safepointMechanism.inline.hpp(local_poll_armed :32-35,arm/disarm :50-57)/safepointVerifiers.hpp(NoSafepointVerifier :89-104 线程计数)/safepointVerifiers.cpp(NoGCVerifier :8-28 total_collections)/jniFastGetField.hpp(:29-49 双加载)/macroAssembler_x86.cpp(:3744-3761 safepoint_poll)/c1_LIRAssembler_x86.cpp(:558-593 C1 deref 轮询)/x86_64.ad(:1099-1102 C2 deref 轮询)/vmOperations.hpp(VM_OPS_DO :48-132 ~84 种,Mode :136-141)/vmThread.hpp(VMOperationQueue :39-85,queue_peek lock-free :68)/vmThread.cpp(:457 loop,:663 execute,:403 evaluate_operation,:622-624 每轮 notify_all,:494-505 超时空 safepoint,:242-275 create,:204-226 VMOperationTimeoutTask);后台任务系: task.hpp(PeriodicTask :39-108,常量 :45-48,execute_if_pending :82-92)/task.cpp(静态数组 :32-33,real_time_tick :49-78,time_to_wait :80-92,enroll :110-130,disenroll :133-154)/thread.cpp(WatcherThread 段 :1367-1562: 构造 :1377-1393 优先级 MaxPriority,run :1453,sleep :1395-1451,start :1514,make_startable :1524,stop :1529;Threads::create_vm :3702-4091: vm_init_globals :3809,init_globals :3846,VMThread 段 :3868-3888,周期任务注册 :4047-4055,WatcherThread 启动 :4066-4078)/init.cpp(vm_init_globals :90-98 7 步,init_globals :101-160 30 函数)/biasedLocking.cpp(EnableBiasedLockingTask :79-92,BiasedLocking::init :95-112,update_heuristics :321-372,VM_BulkRevokeBias :566)/statSampler.cpp(StatSamplerTask :42-46,engage :78-90)/arena.cpp(ChunkPoolCleaner :169-177,clean :141-147,free_all_but :99-120,start_chunk_pool_cleaner_task :237-246)/jniPeriodicChecker.cpp(JniPeriodicCheckerTask :33-37,engage :55-66)/rtmLocking.cpp(RTMLockingCalculationTask :38-47)/memprofiler.cpp(MemProfilerTask :47-52,整体 #ifndef PRODUCT)/jfrThreadSampler.cpp(JfrThreadSampler :311,start_thread :424-430,run :452-500,enroll=semaphore :439-446)/serviceThread.cpp(initialize :41-45)/sweeper.cpp(sweeper_loop :265-278)/java.cpp(before_exit :445-546,WatcherThread::stop :503,StatSampler::disengage :507)/os_linux.cpp(os::run_periodic_checks :5381)/jvmFlagConstraintsRuntime.cpp(PerfDataSamplingIntervalFunc :122-131,BiasedLockingStartupDelayFunc :78-87)/jni.cpp(JNI_CreateJavaVM :4098,Threads::create_vm 调用 :4012,DEFINE_GETFIELD :2082-2106,quicken_jni_functions :3829-3873,copy_jni_function_table :3820-3827);JNI 系: jniHandles.hpp(JNIHandles :35-126,weak tag :55-66,JNIHandleBlock :132-205)/jniHandles.cpp(664 行: make_local :52-87/make_global :101-122/make_weak_global :125-146/destroy_global :168-175/initialize :203-210/allocate_handle 四段 :481-546/rebuild_free_list :548-575/oops_do :453-478/is_frame_handle :270-278/handle_type :218-248/print_on :302-310)/jniHandles.inline.hpp(resolve_impl :52-66,resolve :68-74,jobject_ptr :40-43,jweak_ptr :45-49,is_jweak :34-38)/oopStorage.hpp(设计总纲注释 :37-73)/oopStorage.cpp(allocate :410-477,release :675-682,_allocated_bitmask :208,release_entries CAS :575-587)/weakProcessor.cpp(:37 JNIHandles::weak_oops_do)/interpreterRT_x86_64.cpp(pass_object :214-260)/sharedRuntime_x86_64.cpp(object_move :1158-1180,native wrapper 参数 :2282,native 返回 reset handle block :2652-2656);fast path 系: jniFastGetField.hpp(机制注释 :31-55,find_slowcase_pc :94-104)/jniFastGetField.cpp(28-39 两列表+find_slowcase_pc)/jniFastGetField_x86_64.cpp(243 行: generate_fast_get_int_field0 :56-138,float0 :164-235)/barrierSetAssembler_x86.cpp(try_resolve_jobject_in_native :213-217)/jfieldIDWorkaround.hpp(位布局注释 :28-60,raw_instance_offset :87-93)/os_linux_x86.cpp(信号救场 :494-501)/globals.hpp(UseFastJNIAccessors :916)

### 6.5 实证方法论新增(本会话沉淀)
- **javap 原始字节分析**: javap 显示是"解释过的",原始证据要 xxd/hexdump——44-02 的双槽证据是 `fd 00 05 04 04 04`(append 的 number_of_locals=4 vs 类型项 2 个),不是 javap 的 `[ long, long ]`
- **一字节修改构造坏 class**: 直接改 .class 字节(iload_0→aload_0)制造 VerifyError——注意类名不能改(文件与内部类名必须匹配);RunEvil 用 Class.forName 触发验证
- **WhiteBox 最小兼容类**: 自己写 sun.hotspot.WhiteBox(bootclasspath/a 加载),方法表注册对缺失方法只打 NoSuchMethodError Warning 不影响;native 方法签名必须与方法表 JNI 签名一致(getVMPageSize 是 ()I 非 ()J)
- **CDS 实证**: -Xshare:dump 生成 jsa;-Xlog:cds 看校验;-Xlog:class+load 看 "shared objects file" 来源
- **JDK 版本对比**: 用 Temurin 17 的 src.zip 验证 API 变迁(defineAnonymousClass 在 17 已移除)
- **JDK11 的 --illegal-access=permit**: 反射非导出包仅告警仍可用(实测无 --add-opens 通过);JDK16+ 才需 --add-opens
- **-Xlog 标签库(本会话高频)**: -Xlog:cds/class+load(CDS)、-Xlog:compilation 无(JDK11 用 PrintCompilation)、-Xlog:safepoint(Entering/Leaving/Total time stopped)、-Xlog:vmthread=debug(Adding→Evaluating 对)、-Xlog:os(轮询页地址);diagnostic 可用: CIPrintCompileQueue(globals.hpp:1110)、CIPrintRequests 是 develop 不可用
- **开关对照实验**: -XX:-EliminateAllocations/-XX:-DoEscapeAnalysis(标量替换证明,12-02);-XX:TieredStopAtLevel=1/3(分层阶梯实证,13-02);-XX:-ThreadLocalHandshakes(轮询模式对照,18-02)
- **develop/notproduct flag 清单(release 不可用,别在实证里用)**: CITraceTypeFlow/CIPrintTypeFlow(globals.hpp:1139/1142)、CIPrintRequests(:1114)、ReplayCompiles(globals.hpp:2048)、PrintEscapeAnalysis/PrintEliminateAllocations(c2_globals.hpp:537/543)、CICountOSR、CIStart/CIStop;PrintSafepointStatistics 是 product 但 JDK11 deprecated(可用)
- **DumpReplay 可在 release 用**(CompileCommand option),生成 replay_pid%p_compid%d.log;replay 文件行格式先读 dump_replay_data 源码再解读(ciMethod 行 5 数字/ciMethodData orig/data/oops 段/compile 行内联树)
- **jcmd 触发链实证**: GC.run→G1CollectFull 操作、Thread.print→PrintThreads+FindDeadlocks;每个 safepoint 原因=一个 VM_Operation 名
- **static final 陷阱**: 静态块里用限定名(ClassName.field)给 final 赋值,javac 报 "cannot assign a value to final variable"(非限定名 OK)

### 6.6-6.20 旧会话经验(06/16/38/41/42/07/09/17/10/19/23/24 域)——略,详见 git 历史

### 6.21 08-01(Bytecode 定义表,大纲 11 处漂移含 3 处机制编造,2026-08-13)
- **"5 个静态数组含 format 表" 错**: 6 个数组(_name/_result_type/_depth/_lengths/_java_code/_flags,bytecodes.hpp:339-346),**无 _format 数组**——format 由 compute_flags(:206-276)预编译成位掩码;_lengths 一字节两用(低 4 位短长/高 4 位 wide 长,:397-398);_flags 512 槽双页(:345,432-435)
- **"def 宏展开" 错**: C++ 静态函数 7/8 参数(code,name,format,wide_format,result_type,depth,can_trap[,java_code]);239 条 def 启动一次填充(.bss 非 .data)
- **"Format: b=1B signed/j=4B branch offset" 全错**: b=opcode 本身、c=signed constant、i=local index、**j=2B CP cache index**、k=CP index、o=branch offset;大写=原生字节序(实际只有 J 出现,:244);长度=format 字符数;变长 format=""
- **"256 条(255=impdep2)" 错**: 枚举 203 成员(0x00-0xCA,含保留 wide/breakpoint)+36 私有=239;0xEF-0xFF 17 个未定义;load/store 50 条非 ~60
- **"upper 4 bits 分组" 编造**: 段布局是规范历史安排;HotSpot 分组=区间谓词(is_aload 枚举不连续等),消费者 verifier.cpp:754/templateInterpreter.cpp:254/deoptimization.cpp:705-722
- **"can_trap 用于 loop optimization" 编造**: 真实=GenerateOopMap::do_exception_edge(generateOopMap.cpp:1178,异常边→解释器 OopMap,接通 24-01 oopMapCache 链);C1 自建 _can_trap 表(c1_GraphBuilder.cpp:2976-3034)
- **"stack_effect/_unknown_depth" 编造**: 不存在;depth 恒静态(invoke 系 -1);T_ILLEGAL 表达"栈顶类型由上下文决定"
- **变长仅三条**: wide/tableswitch/lookupswitch(special_length_at :90-137);breakpoint 走 raw_special_length_at(:151-158,普通迭代器经 code_at 伪装)
- 实证: 08-bytecodes-javap.txt(76 条固定长全对+lookupswitch 对齐 1→4→44)

### 6.22 08-02(Template Interpreter,大纲 11 处漂移含 3 处机制编造 + 第 3 轮 REVIEW,2026-08-13)
- **"generate_all 三步" 错**: 真实十一段(templateInterpreterGenerator.cpp:57-263): 签名+错误出口→return 按长度 5 档(_return_entry[6] 0 空)→invoke return 按 TosState 10 档→earlyret→native 结果→safepoint 入口→异常 6 入口→方法入口 28 种→set_entry_points_for_all_bytes→safepoints→deopt 入口(_deopt_entry[7])
- **寄存器错**: x86_64 下 rlocals=r14、rbcp=r13(templateTable_x86.cpp:46-47);locals_index 取负 index;dispatch=lea+jmp [table+rbx*8](interp_masm_x86.cpp:826-846)
- **"iload_0 模板 push(rax)+advance" 错**: 生成器=**iload(int n)**(templateTable_x86.cpp:878-881)仅 3 行;transition 只是断言(:162-165);advance/dispatch 由 generate_and_dispatch 统一(:377-401)
- **实证尺寸**: iload_0=96B vs iload=192B(RewriteFrequentPairs 检查);iconst 7 个全 96B;iadd 64B;ldc 736B;invokevirtual 1280B;271 codelets avg 404B
- **"tosState 共享模板" 错**: 共享按**生成函数+arg 参数化**(iconst/iop2/if_0cmp/fast_accessfield),非 tosState
- **"TemplateTable::_itable[256]" 错**: _template_table/_template_table_wide 双表 239 槽(:172-173);wide 入口单列 _wentry_point
- **入口点家族(核心)**: DispatchTable::_table[10][256];set_short_entry_points pop 序言(:345-362);set_vtos_entry_points 压栈序言(x86:1765-1794);tosca=栈顶留寄存器(globalDefinitions.hpp:819-832)
- **safepoint 轮询内联**: dispatch_base 每字节码 testb 轮询页(:826-834);notice_safepoints **整表拷贝**(copy_table,templateInterpreter.cpp:293-325,非指针换向)
- **0xCB-0xFF 修正(01 篇遗留)**: 未定义区是 0xEF-0xFF 17 个,0xCB-0xEE 是 36 条 fast 系列
- **第 3 轮**: wide 链=_wide 模板 jump ArrayAddress→_wentry_point(templateTable_x86.cpp:4504-4510);iadd=pop_i(rdx)+addl(rax,rdx)(iop2 :1337-1340);deopt 三态(reexecute 走 deopt_reexecute_entry,return_register_finalizer 特判 :339-352);字节码表初始化=init_globals→bytecodes_init(init.cpp:104)

### 6.23 08-03(InterpreterRuntime,大纲 8 处漂移含 3 处机制编造 + 第 3 轮 REVIEW,2026-08-13)
- **"JRT_ENTRY" 错**: 解释器 runtime 用 **IRT_ENTRY 家族**(interfaceSupport.inline.hpp:445-466),JRT 是 JNI 通道(:468);JRT/IRT 宏体几乎相同,禁用异步的是 IRT_ENTRY_NO_ASYNC;at_safepoint(:1176-1191)函数体近空
- **"OopMapCache LRU+OopMapCacheSize~1024" 编造**: 固定 32 槽哈希+3 步探测(oopMapCache.hpp:149-151 "Use fixed size for now"),无 LRU 无该 flag;每槽 2 位 oop/dead(:76-78)
- **"递减到 0" 错**: 递增到阈值(count_grain=8);InterpreterInvocationLimit=CompileThreshold<<3(invocationCounter.cpp:148);**"C1=5000" 错**: JDK11 默认 Tier3=2000/Tier4=15000/Tier2=0,CompileThreshold=10000,InterpreterProfilePercentage=33
- **计数器机械**: generate_counter_incr(templateInterpreterGenerator_x86.cpp:385-440) tiered 用 increment_mask_and_jump 掩码节流;回边仅向后分支(templateTable_x86.cpp:2191-2200);OSR 成功先 revoke 有偏锁(:1072-1094)
- **模板侧 call_VM 链**: interp_masm call_VM_base(interp_masm_x86.cpp:282-306)→macroAssembler(:2482-2550): c_rarg0=r15_thread、set_last_Java_frame(sp,fp,pc=NULL **不写 anchor pc**,:799-802)、check_exceptions→forward_exception_entry(:2556-2568)、尾部 get_vm_result 读回(:2572-2574);LastFrameAccessor(interpreterRuntime.cpp:76-113)
- **第 3 轮**: safepoint 检查在 ThreadStateTransition::transition 内(interfaceSupport.inline.hpp:111-123: 过渡态→serialize→block_if_requested→到态,构造析构两向);increment_mask_and_jump=+8 写回→andl(mask)→jcc(zero)(interp_masm_x86.cpp:1956-1967);入口 46 个 IRT 宏("60+" 虚高)
- 实证: Interpreter generation 0.65ms;CounterDemo tier3→`%`tier4@4→tier4→made not entrant

### 6.24 08-04(LinkResolver + Rewriter,08 域收官,大纲 10 处漂移含 3 处机制编造 + 第 3 轮 REVIEW,2026-08-13)
- **"getstatic→fast_agetfield" 编造**: getstatic/putstatic 无 fast 版本;fast_agetfield 来自 _getfield;Rewriter 对字段/方法指令只换 CP→cpCache 索引(rewrite_member_reference rewriter.cpp:168-183,put_native_u2=01 篇 bJJ 大写 J 的来源)
- **"newarray→fast_newarray" 编造**: 枚举里不存在;Rewriter 替换指令字节的只有两类=lookupswitch→fast_*switch(:394-402)与 ldc→fast_aldc((*bcp)=_fast_aldc :355);rewrite 时机=instanceKlass.cpp:851-857 rewrite_class(验证后首次执行前,is_rewritten 只一次)
- **行号全漂**: 五入口 linkResolver.cpp:1652-1690,resolve_static_call :1058/virtual :1291/interface :1411/field :948/resolve_method 六步 :723-800
- **invokedynamic**: 每调用点独占 cpCache 条目(注释 rewriter.cpp:263-272)→u4 索引→**bJJJJ 5 字节格式的根本原因**;rewrite_Object_init :136-164(return_register_finalizer 落地)
- **cpCache**: 四字段 _indices[b2|b1|index]/_f1/_f2/_flags(cpCache.hpp:49-54,132-142);is_resolved 查 b1/b2 半槽可共享;indy 写入=set_method_handle_common 锁协议(f1 发布点,:350-395);普通 invoke=set_direct_or_vtable_call 无锁(_indices 最后写,:128 注释);do_resolve 特例(invokespecial interface sender/invokestatic 未初始化类故意不标记)
- **resolve_invoke 写回分派**: 按 CallInfo::call_kind 三写(set_direct_call/vtable_call/itable_call,interpreterRuntime.cpp:904-921)
- **虚分派两段**: linktime(:1300-1355)/runtime(:1358-1405: nonvirtual_vtable_index 特例=private/final 静态绑定;否则 recv_klass->method_at_vtable)
- **第 3 轮**: 指令替换两类修正自相矛盾;实证逻辑修正(fast_* 只能由 Rewriter 产生,javac 不产 fast_*——模板存在是 generate_all 全量生成的产物,不能直接证明重写)
- 实证: fast_linearswitch 192B/fast_binaryswitch 256B/fast_aldc 352B/return_register_finalizer 1248B 模板;javap -v Methodref/Fieldref/InvokeDynamic#0→BootstrapMethods

### 6.25 31-01(Unsafe 底层 API,31 域开篇,大纲 9 处漂移含 2 处机制编造 + 第 3 轮 REVIEW,2026-08-13)
- **CAS 单路径错(JDK8 形态)**: 大纲的 `jint* addr=(jint*)(p+offset); Atomic::cmpxchg` 是 JDK8 旧版;JDK11 双路径=obj==NULL→RawAccess(堆外) / obj!=NULL→HeapAccess::atomic_cmpxchg_at(堆内带 GC barrier,06-05 access API);index_oop_from_field_offset_long(unsafe.cpp:122-135,p==NULL 返裸地址);assert_field_offset_sane(:105-118,p==NULL 时断言体整体跳过)
- **行号全漂**: unsafe.cpp 1122 行;CAS :876-938/Park :939-955/Unpark :960-984/AllocateInstance :365-368/defineAnonymousClass0 :830-862(impl :741)/方法表 :1035-1109(40 条)/JVM_RegisterJDKInternalMiscUnsafeMethods :1116-1121;UNSAFE_ENTRY=JVM_ENTRY(:64-70,ThreadInVMfromNative)
- **"getUnsafe 检查 caller" 半对**: jdk.internal.misc.getUnsafe() 无检查(模块封闭);sun.misc.getUnsafe() 才有(@CallerSensitive+Reflection.getCallerClass+VM.isSystemDomainLoader,抛 SecurityException("Unsafe"));名字检查非能力检查(反射拿 theUnsafe 可绕,JDK11 permit 模式实测无 --add-opens 可用)
- **allocateInstance=env->AllocObject**(JNI 分配不调构造器,字段初始化器也不执行,实证 x=0)
- **方法表 40 条**("~200 方法" 虚高);C2 intrinsic 接线注释 :1112-1115
- **park/unpark**: Parker 是 01-os/03 拆过的原语(19 域是 ParkEvent,两套);Unpark 走 ThreadsListHandle(17-03 SMR,线程死亡静默跳过);"幽灵 unpark"=类型稳定内存复用
- **defineAnonymousClass JDK11 无 deprecated 标记**;**JDK17 已移除**(实测 Temurin 17 src.zip 零命中,defineHiddenClass 取代)
- 实证: 08-unsafe-demo.txt(getUnsafe SecurityException/String.value offset 12=CAS 成功/allocateInstance x=0/pageSize 4096/addressSize 8)

### 6.26 31-02(WhiteBox + Forte,31 域收官,大纲 6 处漂移含 2 处机制编造 + 第 3 轮 REVIEW,2026-08-13)
- **"WB_ENTRY 简化版 JVM_ENTRY" 错**: WB_ENTRY=JNI_ENTRY+ClearPendingJniExcCheck(whitebox.inline.hpp:33-37);WhiteBoxAPI diagnostic flag(globals.hpp:2600);JVM_RegisterWhiteBoxMethods 双门控(flag+null loader,:2348-2361);方法表 178 条(:2114-2342);WB_FullGC :1321-1330(soft_ref 清+collect wb_full_gc+G1 复位)/WB_G1IsHumongous :422-429(非 G1 抛异常)
- **"Forte——JFR 用" 错(重要)**: JDK11 JFR 采样器(jfrThreadSampler.cpp)不用 AsyncGetCallTrace,用 **os::SuspendedThreadTask**(:114 OSThreadSampler extends os::SuspendedThreadTask)+ucontext;handshake 也零引用(后续版本才接入);AGCT 是外部 profiler 的导出符号(jvm_sym.ver:6)
- **AGCT 机制**: 错误码 ticks_*(forte.cpp:50-60:-1 无 CLASS_LOAD/-2 GC/-3..-6 不可得不可遍历/-7 未知/-8 退出/-9 deopt);入口检查 :523-556;三族两路分派 :570-628;find_initial_Java_frame :296-330;vframeStreamForte forte_next :116;ThreadInAsgct(:559,类定义 thread.hpp:777,重入注释 :784);jmethodID 类加载时预分配(信号处理器不能拿锁)
- **实证方法论**: 最小 WhiteBox 兼容类(bootclasspath/a 加载,方法表注册对缺失方法打 NoSuchMethodError Warning 不影响);不开 flag→UnsatisfiedLinkError(注册层门控);native 方法签名必须与方法表 JNI 签名一致(getVMPageSize 是 ()I 非 ()J)
- **第 3 轮**: ThreadInAsgct 实际 forte.cpp:559(非 :587);gc 竞态注释在 :588-590(非 :453-456)
- 实证: 08-whitebox-demo.txt(不开 flag→UnsatisfiedLinkError/开 flag→heapOopSize 4/vmPageSize 4096/isGCSupported true/g1IsHumongous 4MB true/fullGC done)

### 6.27 44-01(ClassVerifier 类型检查引擎,大纲行号全对(07-02 已验过 verifier.cpp),补充机制 7 条 + 第 3 轮 REVIEW,2026-08-13)
- **VerificationType 真 union**: Symbol* 指针或编码数据(verificationType.hpp:48-62);低 2 位 TypeMask 顶层类别+第二字节类别(Category1/2/2_2nd)+高字节 descriminator;BciMask=0xffff<<8(Uninitialized 存 new 的 bci),BciForThis=(u2)-1(UninitializedThis);Query 类型=pop_stack 的通配符
- **is_assignable_from 判定树**(verificationType.hpp:267-298): 相同/bogus 通过;Query 按类别;Boolean/Byte/Char/Short 接受 int;引用对引用→is_reference_assignable_from(verificationType.cpp:79-116: null→任何引用/同名/Object 全通过/数组组件递归/其余 resolve_and_check_assignability **会触发类解析**,CDS 下 add_verification_constraint 推迟;**接口特例: 数组只可赋 Cloneable/Serializable,其他接口按 Object**,:47-77)
- **Uninitialized 生命周期**: new→uninitialized_type(bci)(verifier.cpp:1652-1654);verify_invoke_init(:2371-2420: UninitializedThis 只能调本类/超类 <init>;普通 Uninitialized 校验 bci 处确为 new;initialize_object 全帧替换 stackMapFrame.cpp:57-70;try 块内先验证异常处理器路径)
- **invoke 四层检查**(verifier.cpp:2600-2655): invokedynamic 3/4 字节必须 0;<init> 只能 invokespecial;invokespecial 类可赋值(匿名类 host 特例)+protected 特例(:2681-2714);参数从后往前 pop_stack;返回类型 :2725-2742(<init> 必须 void)
- **VerifyError 路径**: verify_error 只记录(:1978-1993),Verifier::verify 尾部 THROW_MSG_(:239);failover(:184-192,版本<51);TypeOrigin :97/ErrorContext :147;aload 模拟=verify_aload(:2832-2837 get_local reference_check)
- 实证: 08-verifier-demo.txt(iload_0→aload_0: 默认 VerifyError "Bad local variable type"+Reason+Current Frame 转储; -Xverify:none 照跑 result=3)

### 6.28 44-02(VerificationType 类型系统,第 4 批收官,大纲 7 处漂移含 2 处机制编造 + 第 3 轮 REVIEW,2026-08-13)
- **"Top vs Bogus 不同" 错**: top_type()=bogus_type() 别名(verificationType.hpp:130-131 注释 "alias");from_tag ITEM_Top→bogus(:33-45);bogus 放行=is_assignable_from 的 equals||is_bogus;帧构造全槽 bogus(stackMapFrame.cpp:43,46)
- **"slot N+1=Top" 半对**: 文件规范如此,内存解析时 to_category2_2nd() 转 Long_2nd/Double_2nd(stackMapTable.cpp:300-307);内部 16 个类型=9 tag+4 签名窄化+2 次槽+Bogus
- **is_assignable_from 伪代码全错**(大纲): "Top→true" 编造;"is_subclass_of(actual)" 方向反;Uninitialized 靠 equals(同 bci)
- **"Byte/Char 来自 i2b" 错**: 窄化类型来自**方法签名**(change_sig_to_verification_type stackMapFrame.cpp:115-118);i2b/i2c/i2s 模拟推 integer_type(verifier.cpp:1481-1488)
- **pop 只弹一槽**(stackMapFrame.cpp:199),category2 次槽自然落 _stack_size 之外,非"扣两槽"
- **悬念指向错**: 大纲 "→域 45 Math" 错(45 已完结);44-02=第 4 批收官,下一域 11-cds
- **写作期血泪**: 块内代码凭记忆混入不存在的 check_end_stack/grep 零命中——必须逐行回源码
- **第 3 轮**: 实证解读修正([ long, long ] 是 2 个 long 变量(loop 的 sum+i),双槽证据=原始字节 number_of_locals=4 vs 类型项 2 个 `fd 00 05 04 04 04`)
- 实证: 08-verificationtype-javap.txt

### 6.39 20-02(后台任务与启动序列,20 域收官,大纲 10+ 处漂移含 6 处机制编造 + 深审 2 轮,2026-08-14)

- **"WatcherThread 主循环 vmThread.cpp:500-550" 文件错(重要)**: WatcherThread 在 **thread.cpp**(构造 :1377-1393/run :1453/start :1514/make_startable :1524/stop :1529),vmThread.cpp 是 VMThread!名字="VM Periodic Task Thread"(thread.hpp:930),NonJavaThread(:902),线程转储 waiting on condition
- **"固定 50ms 睡眠" 错**: sleep()(thread.cpp:1395-1451)先算 `PeriodicTask::time_to_wait()`(task.cpp:80-92,min(interval-counter)),在 PeriodicTask_lock 上 wait(remaining) 睡到**最近任务到期点**;无任务 remaining=0 睡到被 unpark;spurious/新任务循环重算(:1432-1447);真实时间源=run 报告 time_waited→real_time_tick
- **"递减 counter" 反**: execute_if_pending(task.hpp:82-92)把 delay **累加**进 _counter,>=interval 执行并清零;counter=距上次执行的毫秒;time_to_next_interval=interval-counter(:96-99)
- **"_tasks 链表" 错**: 静态数组 `_tasks[max_tasks=10]`(task.cpp:32-33,满 10 fatal);enroll=尾加+unpark/start(task.cpp:110-130);disenroll=左移(:133-154);real_time_tick 遍历时处理任务自 disenroll(index-- :72-75)——EnableBiasedLockingTask 的 delete this 就靠它
- **"JFR 是 PeriodicTask" 编造**: 文件=jfrThreadSampler.cpp(share/jfr/periodic/sampling,非 jfrThreadSampling.cpp);JfrThreadSampler 独立 NonJavaThread(:311,os::create_thread :425),run(:452)用自己的 semaphore _sample+os::naked_short_sleep;间隔由 Java 侧 ExecutionSample 事件阈值注入(jfrThreadSampler.hpp:50);默认配置无此线程(实证转储只有 JFR Recorder Thread)——enroll/disenroll 是**重名**,与 PeriodicTask 无关
- **"BiasedLocking::check_bulk_rebias 周期" 编造**: 真实 EnableBiasedLockingTask(biasedLocking.cpp:79-92)**一次性**任务——task() 提交 async VM_EnableBiasedLocking(:86,注释 "Use async VM operation to avoid blocking the Watcher thread")后 delete this;BiasedLocking::init(:95-112): delay>0→enroll,否则同步 VMThread::execute;JDK11 默认 BiasedLockingStartupDelay=**0**(globals.hpp:970,实证 20-vmops-demo [0.024s] 立即执行),AggressiveOpts 才 500(arguments.cpp:1986-1987);**批量撤销=VM_BulkRevokeBias(:566)由 update_heuristics 同类撤销计数驱动**(20=HR_BULK_REBIAS/40=HR_BULK_REVOKE,globals.hpp:978/984,:321-372,提交 :727),非周期任务
- **"NMTSweeper nmtCommon.cpp" 编造**: 无 NMT 周期任务;NMT_stack_walkable 只是 init_globals 一行(init.cpp:150)
- **任务全清单(7 个,别漏)**: StatSamplerTask(50ms,statSampler.cpp:42-46,38-02 已详)/EnableBiasedLockingTask(一次性)/VMOperationTimeoutTask(vmThread.cpp:92,204-226,AbortVMOnVMOperationTimeout=1000ms 时,interval=delay/10 夹 [10,10000],:246-256,arm/disarm 在 loop begin/end :544-546/:590-592)/ChunkPoolCleaner(arena.cpp:169-177,5000ms,BlocksToKeep=5 其余 os::free :99-120/:141-147,CleanChunkPoolAsync 默认 true)/JniPeriodicCheckerTask(10ms,CheckJNICalls,os::run_periodic_checks=DO_SIGNAL_CHECK 信号完整性检查 os_linux.cpp:5381-5394)/RTMLockingCalculationTask(一次性,UseRTMLocking)/MemProfilerTask(develop-only,memprofiler.cpp 整体 #ifndef PRODUCT)
- **"VM init 23 步 init.cpp:80-250" 全错**: init.cpp 共 190 行;init_globals=**:101-160(30 个函数**,顺序即头顶依赖注释),vm_init_globals=:90-98(7 步: check_ThreadShadow/basic_types_init/eventlog_init/mutex_init/chunkpool_init/perfMemory_init/SuspendibleThreadSet_init);"jintArgumentProlog/10_initPhase2/30_runPhase2" 是 JDK8 旧版;StubRoutines 顺序=codeCache_init(:107)→stubRoutines_init1(:110)→universe_init(:111,注释 dependent on codeCache_init and stubRoutines_init1)——大纲"StubRoutines 在 CodeCache 前"反了;两阶段=generate_initial/generate_all 内容差异(stubGenerator_x86_64.cpp:5869/:5974-5977 "fabricate a RuntimeStub internally"),非代码缓存依赖
- **"Threads::create_vm 是 init_globals 一步" 反**: Threads::create_vm(thread.cpp:3702,jni.cpp:4012 由 JNI_CreateJavaVM_inner :3952 调用)调 vm_init_globals(:3809)+init_globals(:3846);create_vm 四段: ①参数与 OS(:3702-3801,os::init/parse/ergo/SafepointMechanism::initialize :3784/agents)②全局初始化(:3803-3862,主线程对象+ObjectMonitor::Initialize+init_globals)③VMThread 点亮(:3868-3923,create+os::create_thread+**Notify_lock 等 active_handles 就绪**:3871-3887,VM_Verify :3891-3895 第一个 VM 操作,initialize_java_lang_classes :3914,StubCodeDesc::freeze :3919,set_init_completed :3923)④服务与后台(:3935-4078,信号/Attach/Chunk cleaner :3953-3955/ServiceThread :3960/编译器 :3980-3985/模块 initPhase2 :3996/JVMTI 阶段/JFR on_create_vm_1-3 :3853/:3998/:4034/Management :4037/**周期任务大登记 :4047-4055**/WatcherThread make_startable+start :4066-4078)
- **"VMThread::create 内部等 loop(VMOperationLock)" 错**: create(vmThread.cpp:242-275)只建对象(new VMThread/timeout task enroll/VMOperationQueue/_terminate_lock/sun.threads.vmOperationTime 计数器 :268-274);就绪握手=run 里 set_active_handles+Notify_lock->notify(vmThread.cpp:293-298)vs 主线程 wait(:3879-3887,"Monitors can have spurious returns");**"vm_during_initialization flag" 不存在(编造)**
- **"两阶段=数据/服务" 错**: init.hpp:38-39 注释是 main Java thread/VM thread 分工(历史语义),服务启动全在 create_vm 三/四段
- **WatcherThread 晚启动原因**: make_startable 后才可 start(thread.cpp:1514-1527);注释 "All PeriodicTasks should be registered by now. If they aren't, late joiners might appear to start slowly"(thread.cpp:4072-4074)——counter 从 0 起,晚注册者第一个 tick 要等满 interval
- **停机**: before_exit(java.cpp:445-546)**先 WatcherThread::stop(:503)再 StatSampler::disengage(:507)**——先停时钟再注销任务("Stop the WatcherThread. We do this before disenrolling various",:500-502)
- **悬念指向 21-shared-runtime 错**: 正确=27-jni(层 4,00-domain-writing-order.md:76)
- **实证方法论**: SIGQUIT(kill -3)线程转储在 attach 不可用的容器里可用(jcmd 超时 10500ms 失败);PrintFlagsFinal 验证默认值;20-vmops-demo.txt 的 [0.024s] EnableBiasedLocking 交叉引用
- **深审抓到的实质错误**: ①批量撤销触发机制(update_heuristics 计数,非"堆扩容");②ChunkPoolCleaner 真实语义(BlocksToKeep=5 其余 os::free);③StubRoutines 两阶段原因(RuntimeStub 可重定位,非代码缓存);④停机顺序(先停线程后注销任务,初稿写反);⑤VMThread 优先级注释("must be lower",初稿"不能高于"半对);⑥init.cpp:124 注释凭记忆多加 ", loads primordial classes"(真实在 :68 声明处)
- 实证: 20-background-init-demo.txt(素材清单见 §五)

### 6.45 30-jvm-entry/03(Reflection + StackWalk,30 域收官,大纲 10 组漂移含 3 处机制编造 + 深审 2 轮,2026-08-14)

- **"reflection.cpp:100-400" 目录错**: reflection.cpp/reflectionUtils.cpp 在 **share/runtime/**(非 prims/);invoke_method :1257-1280(镜像定位=clazz+**slot 编号** method_with_idnum+override+ptypes/rtype),共享 invoke :1072-1255,invoke_constructor :1282
- **"Reflection::field_get → obj_field_acquire" JDK8 旧版**: JDK11 反射字段访问走 Unsafe(Field.java);reflection.cpp 无 field_get
- **"getCallerClass 用 vframeStream 前两个 frame" 半对**: JVM_GetCallerClass(jvm.cpp:706-742): **security_next()** 跳过三类内部帧(Method::is_ignored_by_security_stack_walk method.cpp:1268-1276: _invoke intrinsic/MethodAccessorImpl 子类/MH 适配帧);frame0 必须 _getCallerClass intrinsic(:729-733)/frame0-1 @CallerSensitive(:736-739)/首个非 ignored 帧(:740-742);注解解析时收集(classFileParser.cpp:2172-2185)
- **"StackWalk filter 反射帧" 错(重要)**: 反射帧过滤在 **Java 侧**(StackStreamFactory.java:249-268 skipReflectionFrames/isReflectionFrame 按类判断);hotspot 只过滤 **@LambdaForm.Hidden 帧**(is_hidden,stackwalk.cpp:123-137,注解 classFileParser.cpp:2180)——实证 -Xlog:stackwalk=debug: hotspot 把 invoke0/invoke/Delegating/Method.invoke 全 fill,Java 输出隐藏
- **invoke 五段**: 方法解析(静态/私有/<init>/接口 resolve_interface_call/vtable :1088-1148)/参数个数(:1175-1178)/unbox_for_primitive+widen+push 打包(:1180-1225)/JavaCalls::call(:1233)/InvocationTargetException 包装(:1234-1249)+narrow+box(:1251-1254);**override 标志 C++ 侧不用**(传给 invoke 闲置,访问检查在 Java 侧 MethodAccessor/verifyAccess)
- **StackWalker 分页**: JVM_CallStackWalk(jvm.cpp:552)→StackWalk::walk(stackwalk.cpp:332,JavaFrameStream/LiveFrameStream)→fetchFirstBatch(:363,跳 StackWalker 自身帧 :378-384)→fill_in_frames(:108-145);JVM_MoreStackWalk(:580)→fetchNextBatch;batchSize 默认 6(实证日志);BaseFrameStream magic 跨批校验(:42-88)
- **实证方法论**: ReflectionDemo+StackWalker SHOW_HIDDEN_FRAMES 显示反射链 6 帧(Method.invoke→Delegating→NativeMethodAccessorImpl→invoke0);-Xlog:stackwalk=debug 证明 hotspot 不过滤反射帧——**实证纠错机制**(大纲机制 vs 实测)
- **悬念指向 31(已完结)错**: 正确=32-jfr
- 实证: 30-reflection-stackwalk-demo.txt(素材清单见 §五)

### 6.44 30-jvm-entry/02(JavaCalls + NativeLookup,30 域 2/3,大纲 9 组漂移含 3 处机制编造 + 深审 2 轮,2026-08-14)

- **"call_dynamic 四种调用模式" 编造**: JavaCalls(javaCalls.hpp:229-269)只有 call_special(:227)/call_virtual(:188)/call_static(:262)+construct_new_instance(:261)+低层 call(:268)→call_helper(javaCalls.cpp:346);每入口先 LinkResolver 解析(08 域)再 call
- **"method->invoke() 走解释器或编译入口" 编造**: 真实=call_helper 里 **StubRoutines::call_stub()**(javaCalls.cpp:442,23 域)以 `from_interpreted_entry`(:390)为入口——该字段=缓存: **已编译=i2c_entry,未编译=i2i_entry**(method.hpp:113 注释,深审验证);编译触发=CompilationPolicy::compile_if_required(:385,13 域)
- **"JavaCallWrapper 构造时 ThreadInVMfromJava" 半对**: 构造在 VM 状态,内部 transition(vm→Java)(javaCalls.cpp:74);职责=分配新 handle 块+保存/清空 last_Java_frame anchor+set_active_handles(:54-115,27-01 已详);析构反向(:119-154);必须回 _thread_in_Java 的原因=GC 栈扫描的根
- **"lookup 4 步" 简化**: 真实=lookup(:527)has_native_function 跳过→lookup_base(:330): lookup_entry(:255: 名字生成+**特殊表 lookup_special_native_methods :228-238 共 7 条**(Unsafe/MethodHandleNatives/Perf/WhiteBox registerNatives→JVM_Register*+JVMCI 2 条+JFR 1 条条件条目——JVM_* 挂 native 的另一通道,31/38 域呼应)+os::dll_lookup(libjava) :267)→lookup_entry_prefixed(:294 JVMTI)→UnsatisfiedLinkError(:337-344)
- **名字生成**: Java_+类(转义 map_escaped_name_on)+方法(pure_jni_name :165-180)/JavaCritical_(critical :182-197)/__+签名参数部分去括号去返回类型(long :199-222)/OS 前后缀(compute :304-313);实证 nm libjava.so 207 个 T Java_ 符号
- **JavaCallArguments(重要)**: 只记 handle/jobject 地址不记裸 oop(push_oop 注释 javaCalls.hpp:104-108 "delays the exposure of naked oops until it is GC-safe";value_state :158-164);parameters()(javaCalls.cpp:505-517)调用 stub 前统一解析为裸 oop(resolve_indirect_oop :486-503: handle→Handle::raw_resolve/jobject→JNIHandles::resolve)
- **call_helper 十步**: 三断言(:349-352,含 !is_at_safepoint "call to Java code during VM operation")/args->verify(:361)/空方法(:370)/compile_if_required(:385)/from_interpreted_entry(:390)/栈守卫恢复(:399-413)/JavaCallWrapper(:420)/call_stub(:442)/结果回写(:447)/vm_result 跨 GC 保 oop(:451-462)
- **实证方法论**: nm libjava.so 看 Java_ 名字格式;native 无实现触发 UnsatisfiedLinkError(消息=方法名+签名,'int NoImplDemo.notImplemented(int)')
- **第 3 轮** 7521406: 特殊表 3 条→7 条(补 Perf+JVMCI/JFR 条件条目)→ **第 4 轮** 69c5f2e(①**查找流程重写**: 核心=lookup_style :253 按类加载器分流——系统类=特殊表 :263+libjava dll_lookup :265;**应用类=JavaCalls::call_static 调 ClassLoader.findNative :277-285(绕回 Java 侧,System.loadLibrary 链路)**;lookup_entry :327 只做三种名字风格;agent 兜底 :293-297;prefixed :476;UnsatisfiedLinkError :522-527;②四断言补 :352 no_handle_mark;③Windows _64 表述删(无 windows 源码);素材同步)
- 实证: 30-java-calls-demo.txt / 30-reflection-stackwalk-demo.txt(素材清单见 §五)

### 6.43 30-jvm-entry/01(JVM Entry Points,30 域 1/3,大纲 9 组漂移含 2 处机制编造 + 深审 2 轮,2026-08-14)

- **"dlsym 动态查找" 编造**: 真实=System.c:39 `(void *)&JVM_CurrentTimeMillis` **编译期取址**(System.c:25-48 注册表,注释 "Only register the performance-critical methods",仅 3 个: currentTimeMillis/nanoTime/arraycopy)+libjava.so 以 **ELF 链接期 UND 符号**引用(nm 实证 131 个 `U JVM_*@SUNWprivate_1.1`)+运行时动态链接器解析;**导出名单=hotspot/jvm_sym.ver 版本脚本**(global: JNI_*; JVM_*; jio_*; AsyncGetCallTrace; local: *;——libjvm.so 对 JDK 的全部接口面,31-02 的 AGCT 出处)
- **"JVM_* 五大类(Thread/Class/Memory/System/IO)" 编造**: 真实=jvm.h:38-55 头注释 "three parts"(①标准 API 的 native 库需要的 VM 函数(如 Object wait/notify)②字节码验证器/类文件格式检查器函数 ③标准 I/O 与网络);jvm.cpp(3793 行)非分节
- **行号**: jvm.h 1342 行/182 个 JNIEXPORT/函数自 :59/JVM_INTERFACE_VERSION 6(:57);jvm.cpp 函数分布 :263-:3790(CurrentTimeMillis :271/IHashCode :605/GetCallerClass :706/DefineClass :949/FindLoadedClass :962 入口/StartThread :2857)
- **运行时解析**: NativeLookup::lookup(nativeLookup.cpp:527-546): has_native_function()→lookup_base 动态解析(PrintJNIResolving=**-verbose:jni** 非 -Xlog,JDK11 无 jni,resolve 标签)→set_native_function;注册的方法 has_native_function=true 不再动态解析(实证: [Registering JNI native method java.lang.System.currentTimeMillis] 后整次无 Dynamic-linking)
- **JVM_ENTRY vs JVM_LEAF 判据=碰不碰堆**: ENTRY(interfaceSupport.inline.hpp:558-565)=thread_from_jni_environment+ThreadInVMfromNative+VM_ENTRY_BASE(HandleMark);LEAF(:588-592)=VM_Exit::block_if_vm_exited+NoHandleMark,不转状态不碰堆不建引用不抛异常(CurrentTimeMillis/NanoTime/GetInterfaceVersion/SupportsCX8);JVM_ENTRY 与 JNI_ENTRY 差异=JNI_ENTRY 多 WeakPreserveExceptionMark(:515-517);JVMWrapper(jvm.cpp:254-256,CountJNICalls 计数)
- **实证方法论**: -verbose:jni 观察注册链;nm -D libjava.so 验证链接期符号(SUNWprivate_1.1 版本节点=jvm_sym.ver);javap -s 看 native 签名
- 实证: 30-jvm-entry-demo.txt / 30-java-calls-demo.txt / 30-reflection-stackwalk-demo.txt(素材清单见 §五)→ **第 4 轮** 328791b(①注册表行号 System.c:38;②JVM_ENTRY/JNI_ENTRY 差异只陈述事实;③libjvm.so 实际导出 **174 个 JVM_* + 5 个 jio_***,jvm.h 182 个 JNIEXPORT 含 jio_*;④JVM_MonitorWait :81 例证验证;⑤131 个 UND 全为 U;⑥PrintJNIResolving 由 -verbose:jni 设置 arguments.cpp:2413)

### 6.42 27-jni/03(JNI Check + 平台层,27 域收官,大纲 10 组漂移含 3 处机制编造 + 深审 2 轮,2026-08-14)

- **"宏替换,release 展开为空" 半对**: 真实=**整表替换**——jni_functions()(jni.cpp:3876-3881)在 CheckJNICalls 时返回 checked 表;jni_functions_check(jniCheck.cpp:2304-2323): 保存原始表到 unchecked_jni_NativeInterface(:2306,UNCHECKED() 回调)+断言两表结构一致(:2311-2314,"Mismatched JNINativeInterface tables")+返回 checked 表;CheckJNICalls product 默认 false(globals.hpp:913),-Xcheck:jni 置位(arguments.cpp:2868)
- **JNI_ENTRY_CHECKED 与 JNI_ENTRY 的关键差异(深审抓到)**: JNI_ENTRY_CHECKED(jniCheck.cpp:91-104)**不含 ThreadInVMfromNative**——不做整函数状态转换(线程还在 native),需要摸堆的校验点用 **IN_VM**(:63-68,ThreadInVMfromNative 局部包装)逐点转换;注释 :82-84: 用 CHECKED 而非 QUICK/LEAF 是为了出错时能创建 handle
- **wrapper 四段**: ①入口(线程存在性/Java 线程→abort "Using JNIEnv in non-Java thread";env 归属→fatal "Using JNIEnv in the wrong thread")②functionEnter(:222-228: in_critical 警告+check_pending_exception :184-197 两类警告)③IN_VM 参数校验(validate_handle :443/validate_object :469/validate_jmethod_id :453-466→Method::checked_resolve_jmethod_id method.cpp:2191-2202)④UNCHECKED() 回调+functionExit(:239-252 **本地引用泄漏**: live>planned 警告,add_planned_handle_capacity :202-207=capacity+live+32,CHECK_JNI_LOCAL_REF_CAP_WARN_THRESHOLD=32 :47;PushLocalFrame :720-731/EnsureLocalCapacity :823-835 设置 planned——01 篇 _planned_capacity 伏笔落地)
- **"方法签名匹配" 编造/过度**: 实际=methodID 解析+类匹配(validate_call_object/validate_call_class),无签名匹配检查
- **"jniPeriodicChecker 每 ~1 秒检查全局引用泄漏" 编造**: 20-02 已证=JniPeriodicCheckerTask 10ms+os::run_periodic_checks(信号完整性 DO_SIGNAL_CHECK,os_linux.cpp:5381-5394);泄漏检查在 functionExit
- **平台层**: 结构 JNINativeInterface_ 在 JDK 侧 **jni.h:214**;实例 jni_NativeInterface 在 **jni.cpp:3528**-3806;jniExport.hpp 是 **JVMTI 接口导出器**(JniExportedInterface::GetExportedInterface :28-38)非 JNI 声明(名字误导!);jni_functions_nocheck 绕过检查(:3884-3886)
- **fatal vs warning 两级**: ReportJNIFatalError(hpp:36-40,VM 态: JNI 栈+os::abort(true))/NativeReport 系(:146-156)IN_VM 包装
- **悬念指向 28-jvmti 错**: 正确=**30-jvm-entry**(第 5 批,00-domain-writing-order.md:76)
- **实证方法论**: 自写 JNI demo 触发两类检查(2000 个 NewLocalRef 泄漏→每 32 个警告 33/66/99;FindClass 失败不查异常→"JNI call made with exception pending");**无 -Xcheck:jni 对照 0 警告**;注意 .so 加载路径与 native 方法名匹配
- 实证: 27-jni-check-demo.txt / 30-jvm-entry-demo.txt / 30-java-calls-demo.txt / 30-reflection-stackwalk-demo.txt(素材清单见 §五)

### 6.41 27-jni/02(JNI Fast Path,27 域 2/3,大纲 10 组漂移含 3 处机制编造 + 深审 2 轮,2026-08-14)

- **"jni.cpp:2146-2160 正常路径" 行号错**: 2146 起是 jni_GetXXXField_addr() 系列;普通实现=**DEFINE_GETFIELD 宏**(jni.cpp:2082-2106): JNI_QUICK_ENTRY(interfaceSupport.inline.hpp:532-540,VM_QUICK_ENTRY_BASE debug NoHandleMark :434-439)+resolve_non_null+from_instance_jfieldID+should_post_field_access probe+读字段
- **"6 条指令" 少算(编造)**: 真实 ~16 条(mov32/testb/jcc/xor×2/mov/shr/clear_tag+mov/try_resolve/投机读/lea+xor×2+cmpl/jcc/ret);**MP 上 XOR 数据依赖代替 lfence**(jniFastGetField_x86_64.cpp:38-39 "Instead of issuing lfence for LoadLoad barrier, we create data dependency",:80-85 robj 依赖 counter、:107-112 二次校验 ca 依赖 rax)
- **漏二次 counter 加载(重要)**: hpp:31-55 注释完整逻辑=第一次偶数门票→resolve→投机读(登记 speculative_load_pclist :96)→**再读 counter 比较**(:107-116),相等才 ret,不等 jcc slow;慢路径=**尾跳**(jump ExternalAddress(jni_GetIntField_addr()),:120-133,不递归)
- **"GetObjectField/GetStatic*Field" 编造**: 只有 **8 个实例字段 Get**(Boolean/Byte/Char/Short/Int/Long/Float/Double,jni.cpp:3840-3870);无 Object(返回值要 make_local 无法标量 ret)/无 Static(fieldID=JNIid* 非偏移,jfieldIDWorkaround.hpp:30-37 instance 低位标记)
- **counter 协议**: safepoint.hpp:112-118 注释权威("incremented ONLY at the beginning and end of each safepoint...Threads_lock held throughout each pair of increments guarantees race freedom");begin() 内 :448-450(已持 Threads_lock),end() :501-503;初值 0(:145);奇数持续期=同步+操作+唤醒
- **接管机制(大纲缺)**: quicken_jni_functions(jni.cpp:3829-3873,create_vm **第三段** thread.cpp:3916)+5 条件(UseFastJNIAccessors globals.hpp:916 && !can_post_field_access && !VerifyJNIFields && !CountJNICalls && !CheckJNICalls);copy_jni_function_table safepoint 逐槽 Atomic::store(jni.cpp:3820-3827,jvmtiEnv.cpp:108)
- **fieldID 编码**: 低 2 位 checked(bit0)+instance(bit1);偏移=BitsPerWord-2 位(**64 位 62 位**,枚举 address_bits;位布局注释 "address:30" 是 32 位遗留);stub shrptr roffset,2 与 raw_instance_offset 同解释
- **信号救场**: os_linux_x86.cpp:494-501——投机读期间 GC 收缩堆→SIGSEGV/SIGBUS→find_slowcase_pc 查 speculative_load_pclist→跳 slowcase_entry_pclist(jniFastGetField.cpp:28-39;hpp:94-104 注释含调试坏值动机)
- **try_resolve_jobject_in_native**(barrierSetAssembler_x86.cpp:213-217)=clear_jweak_tag+movptr [obj] 两行,不区分引用类型;G1 无覆盖用基类
- **实证方法论**: 自写 JNI bench(gcc -shared): C 循环 GetIntField;快路径 2000 万次 ~28ms(1.4ns/次)vs -XX:-UseFastJNIAccessors ~301ms(15ns/次),**约 10 倍**;注意 C 里 printf 要 fflush;GetFieldID 用实例字段(static 字段会 NoSuchFieldError)
- **写作期血泪**: ①大纲把 create_vm 四段划分与 quicken_jni_functions 位置错配——跨篇引用段号前先核对目标文章段落边界;②"30 位"差点照抄注释——枚举 BitsPerWord-2 为准
- 实证: 27-jni-fastpath-demo.txt / 27-jni-check-demo.txt / 30-jvm-entry-demo.txt / 30-java-calls-demo.txt / 30-reflection-stackwalk-demo.txt(素材清单见 §五)

### 6.40 27-jni/01(JNI Handle 系统,27 域 1/3,大纲 9 处漂移含 3 处机制编造 + 深审 2 轮,2026-08-14)

- **"Local handle 自动释放(Native 返回后 pop)" 半对**: 真实=**native 方法返回时 `_top` 清零**(templateInterpreterGenerator_x86.cpp:1163-1166 解释器 + sharedRuntime_x86_64.cpp:2652-2656 编译代码 "reset handle block",critical native 例外)——一次 movl 让整块本地引用失效,GC 的 oops_do 只遍历 _top 以内(jniHandles.cpp:453-478);块内容留着,allocate_handle 的 _top==0 分支(:483-509)清理后续块
- **"resolve 伪代码(RawAccess/无锁解释)" 错**: 真实 resolve_impl(jniHandles.inline.hpp:52-66)用 **NativeAccess**;jweak 走 ON_PHANTOM_OOP_REF 通道返回可 null;普通槽永不 null(null 规范化注释 :61-62);**assert(!current_thread_in_native())(:55)——resolve 必须在非 native 状态**,大纲"thread in native 状态无锁"方向反(JNI 入口 ThreadInVMfromNative 已转 VM 状态)
- **"OopStorage(域 25)" 归属错**: OopStorage 在 share/gc/shared/oopStorage.*(gc/shared!),通用 off-heap 引用容器(头注释 :37-73 设计总纲);JNIHandles::initialize(jniHandles.cpp:203-210)建 **"JNI Global"/"JNI Weak" 两个实例**;allocate 持 _allocation_mutex+_allocation_list+_active_array(:410-477),release 无锁(:675-683);Block 含 oop[]+位图 _allocated_bitmask(oopStorage.cpp:208);GC 弱清除=weakProcessor.cpp:37(WeakProcessor 阶段 is_alive false→写 NULL)
- **jweak tag 细节**: weak_tag_size=1/alignment=**2**(jniHandles.hpp:63-66)——对齐要求是 2 字节不是 8;make_weak_global 返回前地址+1(jniHandles.cpp:137-138);is_jweak=位测试(:34-38);实证 NewWeakGlobalRef 地址 lsb=1(0x...bf81)
- **参数=本地引用(大纲缺失,重要)**: 传回 Java 再传回 native 的引用 GetObjectRefType=1(JNILocalRefType,实证);实现=把**参数帧里 oop 槽的地址**当 handle 传(编译代码 object_move sharedRuntime_x86_64.cpp:1157-1180 "An oop arg. Must pass a handle not the oop itself";解释器签名处理器 pass_object interpreterRT_x86_64.cpp:214-260 lea 取槽地址,null 参数传 NULL);is_frame_handle 识别栈上引用(jniHandles.cpp:270-278);**把参数当 global handle 传 DeleteGlobalRef 会 SIGSEGV**(实测)
- **JNIHandleBlock 内部**: block_size_in_oops=32;allocate_handle 四段(:481-546): _last 块末槽→free list(槽内嵌 next :521)→_last->_next→rebuild_free_list 或追加新块;rebuild 启发式(:548-575): 空闲>一半才下次重建,否则按缺额追加块;_block_free_list 全局池+线程本地 free_handle_block(allocate_block :364-405,deadlock 注释 :374-377);PushLocalFrame/PopLocalFrame 用 _pop_frame_link(jni.cpp:746-783)
- **实证方法论**: JNI demo(acbench/jniref/): gcc -shared -fPIC -I$JAVA_HOME/include 编译;printf 必须 fflush(stdout)(重定向时全缓冲丢输出);GetObjectRefType 常量 JNILocalRefType=1/JNIGlobalRefType=2/JNIWeakGlobalRefType=3;global/weak handle 值必须存 C 侧(返回 Java 后丢失);SIGQUIT 转储 "JNI global refs: 29, weak refs: 1"(基线 28/0,jniHandles.cpp:305-307)
- **写作期血泪**: 误判 check.py 文件损坏(HS_MAP 单行超长,实际完好)——插入映射先 grep 确认目标字符串再 replace
- 实证: 27-jni-handles-demo.txt / 27-jni-fastpath-demo.txt / 27-jni-check-demo.txt / 30-jvm-entry-demo.txt / 30-java-calls-demo.txt / 30-reflection-stackwalk-demo.txt(素材清单见 §五)

### 6.38 20-01(VM_Operation 从提交到执行,20 域 1/2,大纲 7 处漂移含 0 处硬编造 + 深审 2 轮,2026-08-13)
- **模式 4 元组 ✓**(vmOperations.hpp:136-141: _safepoint/_no_safepoint/_concurrent/_async_safepoint);evaluation_mode(:195)/evaluate_at_safepoint(:207-209)/evaluate_concurrently(:211-212)
- **操作 ~84 种**(VM_OPS_DO :48-132,86 行 template-2 个 shtemplate 定义)
- **队列**: 双优先级(SafepointPriority/MediumPriority,vmThread.hpp:41-45);queue_peek lock-free(:67-68 "may return the wrong answer but must not break");drain_at_safepoint_priority(:77)在 **loop 取到操作后排干**(vmThread.cpp:511-514);coalesced 执行链(:551-567,再排干 :568-576);_drain_list oops_do(:53)
- **execute 协议**(vmThread.cpp:663-723): check_for_valid_safepoint_state(:671)→doit_prologue(:676,取消机会)→入队 notify(:696-704)→**ticket 等待**(vm_operation_completed_count<ticket,wait VMOperationRequest_lock :712-719)→doit_epilogue(:722);evaluate_operation(:403)完成登记 increment_vm_operation_completed_count(:427-429,登记后禁访问 _cur_vm_operation :430-434);VMOperationTimeoutTask(:92)
- **loop(:457)**: remove_next→空等 GuaranteedSafepointInterval 超时→no_op_safepoint 强制 cleanup(:494-505,18-01 Cleanup 源头);safepoint 操作: set_drain_list→begin(:542)→evaluate 当前+coalesced→end
- **嵌套**: allow_nested_vm_operations 默认 false fatal(:724-736);嵌套走 VM 线程侧 begin/evaluate/end(:744-750)
- **VMThread 是 NamedThread**(vmThread.hpp:114 "primordial thread spawns all other threads")非 JavaThread
- **实证方法论**: -Xlog:vmthread=debug(Adding→Evaluating 对);-Xlog:safepoint 原因统计=VM_Operation 名集合(RevokeBias 最频繁,jcmd GC.run→G1CollectFull/Thread.print→PrintThreads+FindDeadlocks)
- **第 3 轮**: ①doit_prologue=VM_RevokeBias 查对象 bias 标记(biasedLocking.cpp:520-534,"avoid a safepoint"),非"查线程栈";②唤醒=loop 每轮末 notify_all(:622-624),非登记即唤醒;③loop 末复查 no_op_safepoint_needed(true)(:625-631)
- 实证: 20-vmops-demo.txt(素材清单见 §五)

### 6.37 18-02(轮询与 NoSafepointVerifier,18 域收官,大纲 10 处漂移含 4 处编造 + 深审 2 轮,2026-08-13)

- **"NoSafepointVerifier 伪代码(记录 counter+析构断言)" 编造**: JDK11=**线程计数**(safepointVerifiers.hpp:89-104: 构造 _allow_safepoint_count++/_allow_allocation_count++,析构减;thread.hpp:335 "If 0, thread allow a safepoint to happen");检查点 check_for_valid_safepoint_state(thread.cpp:995-1006)计数非零→fatal("Possible safepoint reached by thread that does not allow it");调用点=memAllocator.cpp:186(分配)/mutex.cpp:1370(阻塞)/vmThread.cpp:672(VM op);release 空实现;**NoGCVerifier 才是计数断言**(total_collections,safepointVerifiers.cpp:8-28);PauseNoSafepointVerifier 嵌套;JRTLeafVerifier(interfaceSupport.inline.hpp:372)
- **"ServiceThread::armed_value" 编造**: 不存在
- **"Thread::_polling_page 地址切换" 半对**: JDK11=值方案——armed=8|bad_page(受保护)、disarmed=good_page(safepointMechanism.cpp:50-76);arm/disarm=set_polling_page 一次写(safepointMechanism.inline.hpp:50-57);local_poll_armed=mask_bits_are_true(poll_word, poll_bit())(:32-35);非 Java 线程退化 global_poll(:38-46);block_if_requested 未 armed 直接 return(:55-60)
- **"polling page 两个偏移 8 字节" 错(旧版)**: JDK11=bad/good **两个连续页**(实证日志 "SafePoint Polling address, bad (protected) page:0x..., good (unprotected) page:0x...",safepointMechanism.cpp:69);值兼作地址兼容页方案
- **"local_poll 读 safepoint_state()->_thread_local_poll" 错**: 读 Thread::_polling_page 字段(thread.hpp:708)
- **x86 默认**: ThreadLocalHandshakes pd product 默认 true→thread-local poll(实证);轮询=testb 线程 poll 字段第 3 位(macroAssembler_x86.cpp:3744-3761),不 SIGSEGV;全局页模式信号侧 01-os/04(JDK11 x86 非默认)
- **critical native 归 27-jni 域**(check_for_lazy_critical_native 属 18-01 点名的一部分,safepoint.cpp:781)
- **悬念指向错**: 大纲 →19 域(已完结);正确 →20-vm-operations/01-vm-operation.md
- **实证方法论**: -Xlog:os 看轮询页地址;ThreadLocalHandshakes 开关对照(全局页模式 safepoint 照常);NoSafepointVerifier 是 ASSERT-only 无法 release 实证(讲机制即可)
- **第 3 轮**: ①轮询双实现——解释器/共享 stub=testb 位测试(macroAssembler_x86.cpp:3744-3761);**C1/C2 编译代码=deref**(movptr 线程 poll 值+testl deref,c1_LIRAssembler_x86.cpp:558-575/x86_64.ad:1099-1102)——armed 值 deref PROT_NONE 页→SIGSEGV→is_poll_address(os.hpp:429)→get_poll_stub(os_linux_x86.cpp:431-432);**01-os/04 的轮询页 SIGSEGV 在 JDK11 x86 真实存在(编译代码路径)**;②全局模式: C1 deref 全局页(:576-592),解释器 cmp32 state;③"值兼作地址"是设计意图(armed 值含 bad_page 地址供 deref 型轮询)
- 实证: 18-safepoint-polling-demo.txt(素材清单见 §五)

### 6.36 18-01(Safepoint 编排,18 域 1/2,大纲 8 处漂移含 2 处编造 + 深审 2 轮,2026-08-13)

- **"两阶段 spin→block" 简化**: 真实三档递进(safepoint.cpp:390-398): SpinPause→naked_yield(4000 次前,_defer_thr_suspend_loop_count=4000 :148)→naked_short_sleep(1)(OS 取整 10ms 注释 :338-339);然后 Safepoint_lock->wait(:423),最后线程 notify_all 唤醒 VM 线程(:866-867);:327-378 大注释讲自旋权衡
- **"safepoint_counter 快速路径=一条 testb+jnz" 简化**: JDK11=jniFastGetField 汇编(jniFastGetField.hpp:29-49): 偶数→投机读字段+**二次加载 counter 校验**(双加载防读取中 GC);counter 消费者还有 ciMethodData::has_safepointed(ciMethodData.cpp:59-81,编译期 safepoint 检测,12-ci 呼应)+dependencyContext 断言(dependencyContext.hpp:121-127)
- **"end 里 Safepoint_lock->notify_all 叫醒等待线程" 错**: 等待线程阻塞在 **Threads_lock**(block :882),end() unlock 放行(:590);Safepoint_lock 的 notify_all 只唤醒 VM 线程本人
- **"SerialSafepointCleanupTask 串行 7 项" 类名编造**: 真实=do_cleanup_tasks(safepoint.cpp:731)→**ParallelSPCleanupTask::work**(:647): 线程级(deflate monitors+mark nmethods :649)+7 子任务(is_task_claimed :651-…);GC WorkGang 并行或 VM 线程串行(:741-753);cleanup 在 begin() 内(:481,同步完成后)
- **no_op_safepoint**: vmThread.cpp:440 no_op_safepoint_needed——无待办 VM op 时发"空 safepoint"做 cleanup(或 GuaranteedSafepointInterval 兜底);实证 "Entering safepoint region: Cleanup"
- **begin/end 骨架**: Threads_lock(:169)防线程进出;waiting_to_block=nof_threads(:185);_state=_synchronizing(:242);thread-local poll(arm_local_poll :244-252)或全局 page(:260-268,01-os/04 信号侧);serialize_thread_states(:257);examine_state_of_thread(:1045: 挂起/安全→_at_safepoint(signal_thread_at_safepoint 减计数),vm→_call_back,其他保持);counter++(:450)→_synchronized(:453)→fence→cleanup;end: counter++ 偶数(:503)先于 state 复位(thread-local :544-553/全局 :554-583)→disarm page→Threads_lock->unlock(:590)
- **三态机**: _not_synchronized=0 省 test 指令(do_call_back :170-172,safepointMechanism.inline.hpp:38 仍用);_state volatile 直读不碰锁(:107)
- **交叉引用(重要)**: 本条'不触发 SIGSEGV'仅指解释器路径(testb);**编译代码(C1/C2)轮询是 deref 方式,armed 时 SIGSEGV 真实存在**——以 §6.37(18-02)为准;轮询双实现细节见 18-02 正文
- **实证方法论**: -Xlog:safepoint(info: Entering/Leaving/Total time stopped/Stopping threads took/Application time);PrintSafepointStatistics 是 product flag(globals.hpp:1199)JDK11 deprecated 但可用(统计表 vmop[threads][time] page_trap_count);jcmd GC.run 触发 GC_Collection safepoint
- **第 3 轮**: ①x86_64 默认 thread-local poll(THREAD_LOCAL_POLL,globalDefinitions_x86.hpp:68)——testb 线程 _polling_page(thread.hpp:708),非全局轮询页!01-os/04 的 SIGSEGV 轮询页对 JDK11 x86 是旧路径;②serialize_thread_states 在 !UseMembar 才调(x86 UseMembar=true);③全局页模式=Interpreter::notice_safepoints 切 dispatch 表+PageArmed+make_polling_page_unreadable(:260-268)
- 实证: 18-safepoint-demo.txt(素材清单见 §五)

### 6.35 13-02(TieredThresholdPolicy,13 域收官,大纲 8 处漂移含 2 处编造 + 深审 2 轮,2026-08-13)

- **"L0→L1→L2→L3→L4 阶梯" 错(重要)**: 权威转换图(tieredThresholdPolicy.cpp:676-712 注释): **a. 0→3→4 常规路径**;b. 0→2→3→4(C2 队列负载,full profile 比 limited 慢 30% 注释);c. 0→(3→2)→4;d. →1 仅 trivial(accessor/constant getter,is_trivial :84)/C2 不可编;e. 0→4(C1 失败)。**L1 是终点不是阶梯**
- **"5000/5000/15000" 编造**: 两档 predicate(call_predicate_helper :44-63): 解释器→C1=Tier3 200/100/2000;C1→C2=Tier4 5000/600/15000;回边 Tier3BackEdge=60000/Tier4BackEdge=40000;判定 i>=T || (i>=Min && i+b>=Compile);scale=CompileThresholdScaling+threshold_scale(:558-574 queue_size/(LoadFeedback×count)+1,code cache 压力指数)+Tier0ProfilingStartPercentage=200 解释器提前 profile(should_create_mdo :638-648)
- **事件机制**: event(:371)分派两路——method_invocation_event(:884: create_mdo→call_event→compile(InvocationEntryBci) :896);method_back_branch_event(:903: loop_event→**OSR compile(imh, bci, next_osr_level) 入口=回边 bci** :918+借机普通编译 :921-932);call_event OSR 均衡(:827-834,"avoid OSRs during each invocation");loop_event(:845);OSR 新 nmethod 直接返回跳转(:398-402);carry 防再触发(:266-269)
- **CompLevel 枚举**(compilerDefinitions.hpp:54-63): any/all=-2/aot=-1/none=0/simple=1/limited_profile=2/full_profile=3/full_optimization=4
- **TieredStopAtLevel 实证**: =1 只出 %1/1;=3 只出 %3/3;common 返回 MIN2(next, stop)(:815)
- **大纲 CompilerDirectives/CompileLog 未展开**: CompileCommand 散布(CompileThresholdScaling/ExcludeOption/DirectiveSet);CompileLog 属工具域
- **实证方法论**: 循环热点先 %3 后 3(OSR 先于普通入口);PrintFlagsFinal 阈值全表可作对照
- **第 3 轮**: ①level 3→4 判定=**MDO delta 计数**(mdo->invocation_count_delta(),common full_profile 分支 :802-803)——level 3 代码运行期间的新增;would_profile()=false 直接升 4(:807-809);②should_create_mdo(:638-648)的 Tier0ProfilingStartPercentage=200% 是"计数达 C1 阈值 2 倍(足够老)才建 MDO",不是"提前"——语义: 解释器里就开 profile 等 C1/C2 接手
- 实证: 13-jit-tiered-demo.txt(素材清单见 §五)

### 6.34 13-01(CompileBroker 编译队列,13 域 1/2,大纲 7 处漂移含 3 处编造 + 深审 2 轮,2026-08-13)

- **"compute_priority 优先级排序" 编造**: 双 FIFO 队列(_c1/_c2_compile_queue,compileBroker.hpp:179-180),compile_queue(comp_level) 按级别分流(C1 1-3/C2 4);add 队尾追加;NearMaxPriority(:803)=OS 线程优先级
- **"状态机 in_queue→assigned→compiling→compiled→failed" 编造**: 只有 _is_complete/_is_success/_is_blocking(compileTask.hpp:83-85);"进行中"=CompileTaskWrapper 存活期(构造 assign :250,析构收尾 :262: set_task(NULL)+set_code_handle(NULL)+set_env(NULL)+mark_complete+notify_all)
- **"超时 2min" 编造**: _time_queued 只用于日志(compileTask.cpp:317);无超时取消;JVMCI wait_for_jvmci_completion(:1573,10×1s)
- **"c1 1 线程/c2 2 线程" 半对**: CI_COMPILER_COUNT=2(C2 构建,globals.hpp:104),但 LP64 默认 CICompilerCountPerCPU 自适应(count=MAX2(log2cpu×log2log2cpu×3/2,2),tieredThresholdPolicy.cpp:214)+code cache 缓冲上限(:219-223);c1=MAX2(count/3,1)/c2=MAX2(count-c1,1)(:244-245);实证本机 15(ergonomic)
- **缺机制**: ①CompileReason 九种(compileTask.hpp:48-59)+can_become_stale(:124,非阻塞计数任务才可过期)+purge_stale_tasks("stale task" 原因,compileBroker.cpp:484-501);②compile_id=全局递增 Atomic::add(assign_compile_id :1479,OSR 在 develop CICountOSR 独立)+CIStart/CIStop;③拒绝链(compilation_is_in_queue :1080/complete :1062/is_old :1320/native 预查 :1307/C2 签名类解析 :1295);④执行段: push_jni_handle_block(:2110,ci local handle 容器)→ciEnv ci_env(task)(:2150)→comp->compile_method(:2180)→post_compile;⑤第一个编译线程 ciObjectFactory::initialize(:1802);⑥阻塞编译 should_wait_for_compilation(compileTask.hpp:135-147);⑦UseDynamicNumberOfCompilerThreads 线程退出(:1836-1851)
- **OopMap 不属于本篇**: 消费侧 24-03 已讲,生成侧属 C2 寄存器分配——大纲放错
- **实证方法论**: CIPrintCompileQueue 是 diagnostic flag(globals.hpp:1110)release 可用;CICompilerCountPerCPU 自适应;compile_id 与 DumpReplay compid 同源(PrintCompilation 76/77/78 ↔ replay compid76/77/78)
- **第 3 轮**: ①取任务非 FIFO——get(:464)内部调 policy->select_task,Tiered 按 weight=(rate+1)×(inv+1)×(backedge+1)(tieredThresholdPolicy.cpp:529-533)选 rate 最高的;rate=每 ms 事件数(update_rate :471-500,safepoint 后 1ms 内不更新/TieredRateUpdateMaxTime=25ms 无事件清零);②stale=is_unloaded 或排队超 TieredCompileTaskTimeout=50ms 且无事件(select_task :298-306,is_stale :509-520);is_old(>50000 inv/>500000 backedge)不移除 rate 清零;③post_compile(:2250 区域)只 mark_success+set_num_inlined_bytecodes+查 task->code()——nmethod 注册在 ciEnv::register_method(ciEnv.cpp:947);④code cache 满: UseCodeCacheFlushing→set_should_compile_new_jobs(stop,可恢复),否则 disable_compilation_forever(:2319-2329)
- 实证: 13-jit-broker-demo.txt(素材清单见 §五)

### 6.33 12-03(ciObjectFactory + ciReplay,12 域收官,大纲 9 处漂移含 4 处编造 + 深审 2 轮,2026-08-13)

- **"析构遍历释放" 编造**: ciEnv::~ciEnv(ciEnv.cpp:215)只有两件事=remove_symbols+set_env(NULL)(GUARDED_VM_ENTRY,注释 "RedefineClasses might be reading it");所有 ci 对象在 _ciEnv_arena,**Arena 随 ciEnv 析构一次释放**,无逐个 delete
- **"ciEnv::initialize_from_replay/create_from_replay_data" 编造**: 真实=主线程启动处 jni.cpp:4050 `if (ReplayCompiles) ciReplay::replay(thread)`(debug-only)→replay_impl(ciReplay.cpp:1074)CompileReplay 读文件 process→**编译照常走工厂**+ciReplay::initialize 钩子(ciMethodData* :1115: 录制类/方法指针经 env->get_metadata 在当前环境重解析 :1146/:1152 后回填 data;ciMethod* :1206: 回填解释器计数+MethodCounters 计数)覆盖录制值
- **"ciMethodData 在 ciMethod 构造时创建/一次性复制" 错**: 懒创建 ensure_method_data(ciMethod.cpp:965)——native/abstract/accessor 跳过(:967),无 MDO 当场 build_interpreter_method_data(:971),失败空 MDO(:980);load_data(ciMethodData.cpp:170)=原子拷贝(disjoint_words_atomic)MDO 头+data 进 ciEnv Arena(:205-215,注释 "Any concurrently executing threads may be changing the data as we copy it" :181)+oop 翻译(:224-229);构造仅占位(:40-54 全初值)
- **"防止 safepoint 中 MDO 被 GC 修改" 错**: MDO 在 Metaspace 不移动;真问题是解释器并发写 MDO→快照保自洽
- **"三表 lookup" 错**: lookup=_ci_metadata 排序数组二分(01 篇);_unloaded_* 只是未加载对象列表(ciObjectFactory.hpp:50-52)
- **replay 文件格式**(实证解读): ciMethod 行=invocation/backedge raw+解释器计数+throwout+instructions_size(ciMethod.cpp:1335-1347,**9 486889 1 0 -1 不是 code_size!**);ciMethodData 行=_state+mileage+orig 段+data 段+oops 段(偏移+类名,如 14 CiDemo$ShapeHolder 21 CiDemo$Square=TypeProfile 接收者)(ciMethodData.cpp:673);compile 行=entry_bci+comp_level+内联树(dump_compile_data ciEnv.cpp:1203)
- **录制三途径**: DumpReplayDataOnError(product 默认 true,globals.hpp:2071,崩溃自动)/CompileCommand DumpReplay(compile.cpp:899-900→ciEnv.cpp:1255)/SA core(ciReplay.hpp:41-57);**ReplayCompiles 是 develop**(globals.hpp:2048)+ciReplay.hpp:36 "only exist in debug version of VM"——release 能录不能放
- **实证方法论**: DumpReplay 在 release 可用(CompileCommand option),生成 replay_pid%p_compid%d.log;"# N ciObject found"+每行格式可对照 dump_replay_data 源码逐字段解读(先读源码再解读数字,别凭直觉猜)
- **第 3 轮**: ①ciInstanceKlass 行=is_linked/is_initialized/cp_length+**常量池 tags**(ciInstanceKlass.cpp:713)——回放时按 tag 校验/重新解析类,非"布局信息";②staticfield 行=**static final 字段**(is_initialized() 才打印,:740-744 StaticFinalFieldPrinter,"in case the compilation relies on their value");③orig 段=头部原始字节,计数/状态藏里面(别把字节当整值);④共享镜像活在长命 Arena,不随 ciEnv 析构
- 实证: 12-ci-replay-demo.txt(素材清单见 §五)

### 6.32 12-02(ciTypeFlow + bcEscapeAnalyzer,12 域 2/3,大纲 10 处漂移含 4 处编造 + 深审 2 轮,2026-08-13)

- **"common_type / ciType::top" 名字错**: 真实=StateVector::type_meet/type_meet_internal(ciTypeFlow.cpp:272);类型格=top(T_VOID 占位)/bottom(T_CONFLICT)/long2/double2/null(ciTypeFlow.hpp:175-187);meet 规则: top 吸收/null 恒等/原语→bottom/**接口与非接口→Object(注释 "This is what the verifier does",:299-303,44 域同源)**/数组递归元素(:310-330)/两实例类→least_common_ancestor(:334)
- **"ConnectionGraph 在 BCEscapeAnalyzer 里" 错(编造)**: ConnectionGraph=C2 opto/escape.cpp(:320);bcEscapeAnalyzer="fast, conservative analysis...at the bytecode level"(bcEscapeAnalyzer.hpp:38-40),输入=ciMethod+ciMethodBlocks(**与 ciTypeFlow 无关**,do_analysis bcEscapeAnalyzer.cpp:1201);输出=位图(_arg_local/_arg_stack/_arg_returned+_return_local/_return_allocated/_allocated_escapes,:54-64);访问器 is_arg_local/is_arg_stack/is_arg_returned/is_return_local/is_return_allocated(:124-147);三档术语 NoEscape/ArgEscape/GlobalEscape 属 ConnectionGraph(escape.hpp:155-160)
- **"ciMethod::scalar_replacement_possible()" 不存在(编造)**: 真实=ConnectionGraph::scalar_replaceable(escape.cpp:256/273)+find_scalar_replaceable_allocs(:268),替换本体 PhaseMacroExpand(macro.cpp)
- **"输入含 ciTypeFlow 结果" 错**: bcea 自扫字节码,不依赖 ciTypeFlow
- **算法**: 乐观初始化(initialize :1233,引用参数全标 local+stack :1242-1254)+降级——putfield/putstatic 被写值→set_global_escape、receiver→set_method_escape+set_modified(:876-888);aaload→set_method_escape+set_dirty(:488-492);invoke 单形态: 被调方"栈逃逸未返回"→set_method_escape+记依赖、否则 global(:336-339);非单形态→全 global+_unknown_modified(:355-363);递归 _parent/_level(is_recursive_call :90);保守 _conservative 全 false
- **流程**: flow_types(ciTypeFlow.cpp:2727): get_start_state(OSR 取非 OSR 分析 osr_bci 块状态)→DFS→clone_loop_heads(仅 >=full_optimization :2748)→work list fixpoint(:2770-2782);flow_block(:2326)can_trap 先流异常边(:2359-2362);flow_successors 对后继 meet 变化即入队(:2160-2166);meet_exception(:492): locals meet+栈重置 1+tos meet exc(:499-501/:527-535);compute_exceptions(:1790)按异常表建 handler 块,catch_all→Throwable
- **缺机制补录**: ①bcea 的 _dependencies(bcEscapeAnalyzer.hpp:66,invoke 时 append,与 01 篇 Dependencies 呼应);②can_trap 特例(ldc/aload_0/return/monitorexit 假设不抛,:2169-2197);③push_translate(boolean/char/byte/short→int,ciTypeFlow.cpp:540-552)、long/double 双槽;④OSR: ciTypeFlow 构造带 osr_bci(ciTypeFlow.hpp:57),ciMethod::get_osr_flow_analysis(ciMethod.cpp:369)
- **实证方法论**: CITraceTypeFlow/CIPrintTypeFlow 是 develop flag(globals.hpp:1139/1142)release 不可用——换宏观证据: 开关对照实验(EscDemo noEscape 400 万 new=1ms vs escape 40 万进 ArrayList=18ms;-XX:-EliminateAllocations 后 5ms/9ms 差异消失=标量替换钉死);PrintEscapeAnalysis/PrintEliminateAllocations 也是 notproduct(c2_globals.hpp:537/543)
- **第 3 轮**: ①is_recursive_call(bcEscapeAnalyzer.cpp:206)沿 _parent 链查 callee 是否在分析栈上=递归检测(:207),非"借用父分析";invoke :316 递归不套娃;②get_start_state 定义在 ciTypeFlow.cpp:366(注释 :363);③Parse 消费 flow: 块图骨架(rpo_at :1250/successors :1274/exceptions :1275)+OSR 块类型(:223 monitor_count/:346 local_type_at)+failing→record_method_not_compilable(:428-429);④do_analysis 跳过条件(:1302-1316): abstract/native/未初始化/_level>MaxBCEAEstimateLevel/code_size>MaxBCEAEstimateSize
- 实证: 12-ci-typeflow-escape-demo.txt(素材清单见 §五)

### 6.31 12-01(ciObject 镜像体系,12 域开篇,大纲 9 处漂移含 3 处编造 + 深审 2 轮,2026-08-13)

- **"JIT 编译运行在 safepoint 中" 错(重要)**: 编译在编译线程并发跑,GC 时只是阻塞,编译状态跨 GC 存活;GC 安全=双通道引用——oop→JNI local handle(ciObject.cpp:53-59,GC 重定位),Metadata(Metaspace 不移动)→裸指针;ciObject.hpp:40-44 注释 "GC and compilation can proceed independently";编译线程进出 VM 用 VM_ENTRY_MARK/GUARDED_VM_ENTRY(ciUtilities.inline.hpp:34-38,ThreadInVMfromNative,17 域呼应)
- **"多次编译同一个 Klass 返回同一个 ciKlass" 只对 well-known 类成立**: 工厂 per-编译(ciEnv.cpp:131 new ciObjectFactory);全局共享=vmSymbols 全部 ciSymbol(_shared_ci_symbols)+基本类型+WK_KLASSES_DO 的 well-known ciInstanceKlass(ciObjectFactory.cpp:123-206,ciEnv::_Object 等静态,ident 分段 _shared_ident_limit :204)
- **"unique_concrete_method / DFA / _implementors 列表" 编造**: 真实=①implementor() 三态指针(ciInstanceKlass.hpp:70-74: NULL/一个/自身=多个;懒+备忘 ciInstanceKlass.cpp:599;共享类假设无唯一实现者 :604——CDS 没归档全部子类,保守);②unique_concrete_subklass(:370)=up_cast_abstract(:376)
- **"is_c1_compilable 检查方法大小/MDO" 错**: =Method access_flags 位(is_not_c1_compilable,method.hpp:949),构造抄取(ciMethod.cpp:88-89);大小=_code_size 快照(:82)
- **"is_constant=final+static" 太粗**: 完整判定(ciField.cpp:257-291)=static final(排除 System.in/out/err 偏移,:261-270)/@Stable(FoldStableValues)/非 static final 信任名单(trust_final_non_static_fields :216: invoke 包/匿名类/装箱类/String/Atomic*FieldUpdater/flag)/CallSite.target 特例(:281-286)
- **"is_subtype_of 查缓存 subtype list" 错**: 转发 Klass::is_subtype_of(ciKlass.cpp:68-80,VM_ENTRY_MARK;VM 侧 super_check_offset O(1))
- **工厂双缓存**: _ci_metadata 排序数组(指针不移动,find_sorted 二分,:292-335)+_non_perm_bucket[61] 哈希(oop 移动不能排序,:67-68/:238-259);get_symbol 分档(vmSymbols SID→共享,:209)
- **快照+懒字段体系**: 标量(_flags/_init_state/_nonstatic_field_size...,ciInstanceKlass.hpp:50-61)+懒(_super/_java_mirror/_nonstatic_fields,compute_nonstatic_fields :105);is_interface=ciFlags 位测试(ciInstanceKlass.hpp:231→ciFlags.hpp:59)
- **缺机制补录**: ①共享类(CDS)update_if_shared(ciInstanceKlass.hpp:109-113,init_state 现算);②hotswap 检查 Dependencies::check_evol_method(ciMethod.cpp:102-110);③依赖登记 Dependencies(ciEnv.hpp:57/313,validate_compile_task_dependencies ciEnv.cpp:933)→nmethod 作废;④unloaded 镜像 is_loaded(ciObject.hpp:138);⑤解释器计数快照(ciMethod.cpp:137-148)
- **实证方法论**: PrintInlining 是 ci 层决策的可见产物(内联树+"inline (hot)"/"accessor"/"callee is too large");TypeProfile (87426/87426 counts)=CiDemo$Square 是 MDO 剖面驱动 devirtualize 的证据;made not entrant 三行(升级替换,非依赖失效——别混);CiDemo: 接口调用+String.length 组合,PrintCompilation+PrintInlining 并发编译输出会交错
- **第 3 轮**: ①ciEnv 的 Arena 是 C 堆 mtCompiler(_ciEnv_arena,ciEnv.cpp:98),不是资源区;②ciKlass::is_interface 基类仍 virtual(ciKlass.hpp:97),内联位测试仅限 ciInstanceKlass 静态类型——"零虚函数"只对一半;③update_if_shared 条件=_init_state != expected 才现算(ciInstanceKlass.hpp:109-113);④构造快照确认: _flags=ciFlags(access_flags)(ciInstanceKlass.cpp:58)/_has_subklass=ik->subklass()!=NULL(:60)/_init_state=ik->init_state()(:61)
- 实证: 12-ci-inlining-demo.txt(素材清单见 §五)

### 6.30 11-02(CDS Load 端,11 域收官,大纲 13 处漂移含 3 处编造 + 深审 2 轮,2026-08-13)

- **"MAP_SHARED" 错(重要)**: Linux 实现 os::pd_map_memory(os_linux.cpp:6129)**flags=MAP_PRIVATE**(:6133),addr 非空才 |= MAP_FIXED(:6145-6146);跨进程共享页来自 file-backed 页缓存,与 MAP_SHARED 语义无关;映射调用=os::map_memory→pd_map_memory,mmap 直接调用在 :6149
- **"map_regions()" 编造**: 不存在;真实=map_shared_spaces(metaspaceShared.cpp:2034): reserve_shared_memory(filemap.cpp:869,整块 ReservedSpace 防覆盖 code cache)→逐区 map_region(filemap.cpp:891)→validate_shared_path_table(:2058);布局断言 mc_top==rw_base==ro_base==md_top(:2069-2071)支撑 set_shared_metaspace_range 单区间判定
- **"initialize_shared_spaces :700-1000" 错**: 装配在 **:2100**(universe.cpp:729 调用);映射在 initialize_runtime_shared_and_meta_spaces(:216,metaspace.cpp:1305);UseSharedSpaces 是参数先定(默认 true=auto 行为,globals.hpp:2484/2491),失败统一走 fail_continue(filemap.cpp:102: 日志+UseSharedSpaces=false+close :124-126,RequireSharedSpaces 则 fail 退出 :114-115)——"成功后置 true"是方向反
- **"shared dictionary 在 CompactHashtable" 错**: 共享字典=SharedDictionary:Dictionary(systemDictionaryShared.hpp:162,链表桶,可挂验证约束/id/crc 等每类附加信息,SharedDictionaryEntry :113);CompactHashtable 只管符号/字符串(symbolTable.cpp:53/stringTable.cpp:68)
- **"lookup(Symbol* key)" 签名错**: 真实 lookup(const N* name, unsigned int hash, int len)(compactHashtable.inline.hpp:59-91);桶项 u4 位打包(高 2 位类型/低 30 位偏移,:140-147),VALUE_ONLY 单条目 4B/REGULAR (hash,offset) 8B;decode 双保险: 符号版 base+offset+equals+断言 refcount==-1(:36-46)
- **"mmap 后 _base_address 设实际地址" 错(把结果当原因)**: base_address=dump 时写死 shared_rs()->base()(compactHashtable.cpp:147),load serialize 原样读回;有效前提=同址映射
- **find_or_load_shared_class 在 :480**(大纲 50-250);AppCDS 拦截点=JVM_FindLoadedClass(jvm.cpp:999,由 BuiltinClassLoader.loadClassOrNull→findLoadedClass 触发,BuiltinClassLoader.java:593);引导路=SystemDictionary::load_shared_class(systemDictionary.cpp:1165/1270)
- **深审抓到的实质错误**: ①"init_state 直接 loaded"错——dump 时 remove_unshareable_info **重置为 allocated**(instanceKlass.cpp:2293-2297 注释),load 端 add_to_hierarchy 设回 loaded,restore 断言 !is_loaded()(:2349);②"java_mirror 是 NULL"半对——dump 剥离但镜像若可归档存 raw archived mirror(klass.cpp:545-554 恢复,否则 create_mirror :565-568);③cpCache 不空,是 resolved_references 要重建(constantPool.cpp:328,:352-359);④mc 区 trampoline 机制: unlink_method(method.cpp:977,:985-986)设 cds entry,load 时 method_entry 宏重写(templateInterpreterGenerator.cpp:186-189),link_method assert entry==_i2i_entry(:1082);adapter 走 _adapter_trampoline 运行期填(:1015-1031 注释,make_adapters :1142-1148);⑤C++ vtable 克隆: dump 清零(:751)load 现拷 libjvm.so(:667-681)
- **验证约束兑现**: 共享类 link_class 跳过 verify/rewrite 改 check_verification_constraints(instanceKlass.cpp:805-807→systemDictionaryShared.cpp:911-941);dump 端记录触发点 verificationType.cpp:97-103
- **实证方法论**: 默认归档路径实测=lib/server/classes.jsa(jvm_path 解析);坏 magic 用 dd 改前 4 字节(printf '\x00\x00\x00\x00'|dd of=... bs=1 seek=0 conv=notrunc);classpath mismatch 需先归档应用类(SharedClassListFile 加 T,jar 路径——非空目录 dump 直接拒绝 "Cannot have non-empty directory in paths");Xmx1g 触发 oop 编码不匹配但归档照用(delta=-28991029248)
- 实证: 11-cds-load-demo.txt(素材清单见 §五)
- **第 3 轮**: ①SymbolTable::lookup 顺序(symbolTable.cpp:242-258)初始 false=先动态后共享,共享命中置 true 后先共享,"最近命中方优先"启发式——字符串表才固定先共享(stringTable.cpp:240-249);②_adapter_trampoline 在 ConstMethod(constMethod.hpp:212)指向 RW 槽,非 RW 字段;③MAP_FIXED 占用即静默替换不报错,靠 base != requested_addr 兜底;ro 纯共享、rw/mc 写脏 COW;④rw 区加载期 patch=01 篇承诺的尾巴,文中明确(第 3 节关键设计+第 6 节);⑤lookup_from_stream 调用点 parse_stream=systemDictionary.cpp:1072(非 1074)

### 6.29 11-01(CDS 全景与 Dump,第 5 批开篇,大纲 8 处漂移含 2 处机制编造 + 第 3 轮 REVIEW,2026-08-13)

- **"magic 0xF00BAAA2" 错**: 真实 0xF00BABA2(filemap.hpp:37);validate_header(filemap.cpp:1397)=header->validate+check_shared_paths_misc_info;validate_shared_path_table(:480)在**映射后**(注释 "this is done later")
- **"5 个 space mc/rw/ro/md/od" 错**: od 是旧版;JDK11=**8 槽位**(metaspaceShared.hpp:66-85: mc/rw/ro/md+string×2+open archive×2),实证 dump 用 6 个(mc/rw/ro/md/st0/oa0);rw 33.4%+ro 60.3%=93.7%
- **"link_and_serialize" 编造**: 真实=link_and_cleanup_shared_classes(:1680)+VM_PopulateDumpSharedSpace::doit(:1333-1410): Metaspace::freeze(VM 线程不能 GC 故冻结)→CollectClassesClosure→rewrite_nofast_bytecodes_and_calculate_fingerprints(:550,08-04 nofast 落地)→combine_shared_dictionaries→**remove_java_mirror_in_classes(:501,"Removing java_mirror" 打印 :1300)与 remove_unshareable_in_classes(:489)两个独立函数**→**ArchiveCompactor::initialize+copy_and_compact**(压实+重定位,非逐个对象递归写)→dump_symbols/dump_java_heap_objects→relocate_well_known_klasses
- **行号漂**: preload_and_dump :1632(大纲 200-600);preload_classes :1699=ClassLoaderExt::load_one_class 逐类加载;ClassListParser :46/:78 只做行解析(# 注释/tab 归一),不碰 SymbolTable
- **默认归档路径**: SharedArchiveFile 缺省=jvm_path 推导的 JVM 同目录 classes.jsa(arguments.cpp:3510-3529)
- **指针重定位本质**: narrow_klass_base 与归档基址重合是**主动设计**(Universe::set_narrow_klass_base(_shared_rs.base()),:305)→dump 按假想地址摆对象,load 同址 mmap→ro 指针原样有效;堆配置不匹配归档作废
- **写作期血泪 2**: preload_classes 块又凭记忆编了 is_loading_success 分支(真实 ClassLoaderExt::load_one_class)——第二次犯
- **第 3 轮**: java_mirror 两函数分列;narrow_klass_base 主动设计;classlist 行数断言删除
- 实证: 08-cds-demo.txt+08-cds-dump-full.txt(dump 归档 1211 类含 1151 instance/11.9MB/6 空间区;启动 class+load 356 个 shared objects file)

---

## 七、用户偏好与纪律(重要,违背会被批评)

1. **严格按规划,不做多余选择**: 拓扑定了顺序就逐项推进——不要问"还是写 X?"(曾因制造选择被批评)
2. **每篇都做深度 REVIEW(2 轮)**: 用户会要求"按照方法论深度的 REVIEW",写完后**主动自查深审,不要等**;用户还会追加"再次深度的 REVIEW"(第 3/4 轮)——按同样方法重新质疑,重点抓上一轮没抓到的"顺理成章"错误
3. **一篇一篇写**: 不并行、不跳步
4. **数字/事实必须验证**: 任何带数字的陈述回源码/素材验证,禁止"凭记忆"
5. **命名混淆注意**: "域 07"与"07 域的第 01 篇"都带 07,表述时写清"域 XX 第 Y 篇";目录名以 outlines/ 实际为准(31-unsafe-whitebox、44-class-verification)
6. 中文交流,提交信息用中文
7. 用户会追问"下一步规划是否合理"——要有自己的判断
8. **用户会追问"发现的问题都修复了吗/有沉淀吗"**——修复要有 commit 可查,沉淀要即时写进本文件 §6
9. 链接文本必须与目标文章标题一致
10. 上下文将满时用户会要求"写详细的交接文档"——把进度/commit/经验/下一步全部写全
11. **用户会怀疑实证工具**(如"是不是因为用的不是 openjdk 而是 konajdk")——实证 JDK 与源码版本匹配是硬要求,Temurin 11 已备好;回答要有对照实验支撑

---

## 八、待办清单(按优先级)

- [x] 第 1 批 12 篇 + 第 2 批 26 篇 + 第 3 批 14 篇——✅ 完结
- [x] 第 4 批 21 篇(10/19/23/24/08/31/44 域)——✅ **第 4 批收官**(commit 见 §二)
- [x] **11-cds/01**(CDS 全景与 Dump)——✅ 完结(正文 171bf24/回填 a9dafe0/README a35de82,commit 见 §二)
- [x] **11-cds/02**(Load 端)——✅ 完结(正文 e8f9905/回填 2e9bc6c/README 529c91d,commit 见 §二);**11 域完结,第 5 批 2/13**
- [x] **12-ci/01**(ciObject 镜像体系)——✅ 完结(正文 4fe2ebf/回填 13bae76/README e7ee1d1,commit 见 §二);12 域 1/3
- [x] **12-ci/02**(ciTypeFlow + bcEscapeAnalyzer)——✅ 完结(正文 f06d6fa/回填 63c7534/README b9aeac8,commit 见 §二);12 域 2/3
- [x] **12-ci/03**(ciObjectFactory + ciReplay)——✅ 完结(正文 aef0f86/回填 55ece51/README 524cb48,commit 见 §二);**12 域完结,第 5 批 5/13**
- [x] **13-jit-framework/01**(CompileBroker 编译队列)——✅ 完结(正文 934721b/回填 1977a6b/README 888bfee,commit 见 §二);13 域 1/2
- [x] **13-jit-framework/02**(TieredThresholdPolicy)——✅ 完结(正文 fe61eae/回填 b5ff7e1/README c526e7d,commit 见 §二);**13 域完结,第 5 批 7/13**
- [x] **18-safepoint/01**(Safepoint 编排)——✅ 完结(正文 1b4b441/回填 b24f7fa/README b6ed56d,commit 见 §二);18 域 1/2
- [x] **18-safepoint/02**(轮询与 NoSafepointVerifier)——✅ 完结(正文 e2896a5/回填 a0a97bf/README 2e63aeb,commit 见 §二);**18 域完结,第 5 批 9/13**
- [x] **20-vm-operations/01**(VM_Operation 从提交到执行)——✅ 完结(正文 b30c2e8/回填 b2c8867/README f0ed423,commit 见 §二);20 域 1/2
- [x] **20-vm-operations/02**(后台任务与启动序列)——✅ 完结(正文 4e942c1/回填 ⚠️ 14 组/README 7aae8ba,commit 见 §二);**20 域完结,第 5 批 11/13**
- [x] **27-jni/01**(jobject 怎么在 JVM 内部存——Handle 系统)——✅ 完结(正文 f64d2af/回填 ⚠️ 9 组/README f64d2af 同提交,commit 见 §二);27 域 1/3
- [x] **27-jni/02**(JNI Fast Path)——✅ 完结(正文 1ec9012/回填 ⚠️ 10 组/README 1ec9012 同提交,commit 见 §二);27 域 2/3
- [x] **27-jni/03**(JNI Check + 平台层)——✅ 完结(正文 9f523af/回填 ⚠️ 10 组/README 9f523af 同提交,commit 见 §二);**27 域完结**
- [x] **30-jvm-entry/01**(System.currentTimeMillis() 怎么进入 JVM)——✅ 完结(正文 9ed479d/回填 ⚠️ 9 组/README 9ed479d 同提交,commit 见 §二);30 域 1/3
- [x] **30-jvm-entry/02**(JavaCalls + NativeLookup)——✅ 完结(正文 bf0d15f/回填 ⚠️ 9 组/README bf0d15f 同提交,commit 见 §二);30 域 2/3
- [x] **30-jvm-entry/03**(反射与栈遍历)——✅ 完结(正文 cfd6484/回填 ⚠️ 10 组/README cfd6484 同提交,commit 见 §二);**30 域完结**
- [ ] **32-jfr/01**(JFR Recorder Engine)——**下一篇**;大纲 `planning/outlines/32-jfr/01-recorder-engine.md`;30-03 悬念指向它
- [ ] 30-jvm-entry 完结后 → 32-jfr → 34-nmt → 36-attach → 37-heapdump → 39-runtime-mon → 46-sa(第 5 批剩余 5 域)
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
| JDK 侧源码 | `/data/workspace/jdk11u/src/java.base/` |
| 工具素材 | `docs/openjdk/planning/outlines/00-jvm-tools/materials/`(commands/ 140+ 文件) |
| **实证 JDK(首选,与源码同版本)** | **`/data/tmp/opencode/jdk11/bin`(Temurin OpenJDK 11.0.32)** |
| 对照 JDK | `/data/tmp/opencode/jdk17/bin`(Temurin 17,含 src.zip 验证 API 变迁);`/opt/codev/TencentKona/bin/`(17.0.8.1) |
| 自查脚本 | `/data/tmp/opencode/check.py`(代码块/行号/星号/锚;新文件先加 MAPPINGS/HS_MAP/**EXTERNAL**;ART 改当前文章;forward-link 用 basename 匹配 outlines) |
| 实证工作目录 | `/data/tmp/opencode/acbench/`(bench 源码+wrapper 脚本 run_*.sh;bc08/ 与 verify/ wb/ unsafe/ 等子目录) |

**自查脚本要点**(python,每篇跑):
- 代码块: `re.findall(r'```cpp\n// (file):(s)-(e)\(...\)\n(.*?)```')` → 逐行比对(遇 "..." 跳过,strip 后判)
- 行号范围: HS_MAP(hotspot)+ MAPPINGS(JDK 侧)+ **EXTERNAL**(jdk.unsupported 等 SRC 树外)→ 行号 ∈ [1, 行数]
- 星号: 剔除代码 span 后 `count('*') % 2 == 0`(裸星号如 `Method*`/`2^k`/`Tier*` 必须加反引号;**反引号配对先修**,一个漏闭会让全篇统计错乱)
- 文字锚: 文件名后无行号的引用 → 报错补行号
- 链接: 相对链接按文章目录解析;forward link 豁免=outlines 全扫描按 basename 匹配
- **代码块行号不匹配时**: 用 python 自动对齐脚本(从标注起点逐行匹配块内容,输出真实终点——44-02 三块连错 4 轮后用它一次解决)

---

## 十、下一步(读完立即做)

```
1. 读 planning/outlines/32-jfr/01-recorder-engine.md(注意 ⚠️ 块——30 域三篇各回填 9/9/10 组,32 域大概率同样漂移;30-03 悬念指向它: JFR 的采集引擎)
2. 验证大纲所有 file:line 与专有名词(按 §6.1 的规律;32 域 01 重点: jfr/recorder/ 的 JfrRecorder(创建/启动链,20-02 已见 on_create_vm_1-3)、JfrRecorderService、JfrChunkWriter/ChunkRepository、JfrBuffer 环形缓冲、JfrEvent(JFR_ONLY 宏在事件点埋桩)、与 31-02(AGCT/SuspendedThreadTask 采样)、38-perfdata(观测通道对照)、20-02(JFR Recorder Thread/采样线程)衔接;实证: -XX:StartFlightRecording + jcmd JFR.start(容器 jcmd 不可用则命令行)、jfr print 或 -Xlog:jfr*
3. 实证优先用 /data/tmp/opencode/jdk11(Temurin 11,与 jdk11u 同版本);素材引用前 grep materials/ 验证;jcmd 在当前容器 attach 不可用,实证可用 kill -3(SIGQUIT)线程转储或命令行 -Xlog,自写 JNI demo 用 gcc 编译(acbench/jniref/ 模式,printf 要 fflush)
4. 按第三节流程写 → 自查(脚本 /data/tmp/opencode/check.py,新引用文件先加 HS_MAP/MAPPINGS/EXTERNAL;ART 变量改回当前文件)→ 深审 2 轮(用户会追加第 3 轮)→ 回填大纲 → 提交 → 更新 README
5. 32-jfr 后 → 34-nmt → 36-attach → 37-heapdump → 39-runtime-mon → 46-sa(第 5 批剩余 5 域)
```

**环境**: Linux 容器,无显示器(GUI 截图等用户在 Ubuntu 补);jdk11u 源码在本地;git 推送即部署(docsify 站点)。**上下文已满: 本文件写完后,新会话只读本文件即可继续,不要依赖旧会话的记忆。**
