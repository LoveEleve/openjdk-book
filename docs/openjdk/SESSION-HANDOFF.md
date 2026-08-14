# SESSION-HANDOFF — 主交接文档(唯一入口,非常详细版)

> **状态**: 2026-08-13 | 卷 2 写作中: **80/152 篇完成**(第 1 批 12 + 第 2 批 26 + 第 3 批 14 + 第 4 批 21 + 第 5 批 7) | 第 1-4 批**全部完结**(12 个域),第 5 批(VM 核心)进行中 7/13,**11-cds/12-ci/13-jit-framework 域完结** | **上下文已满,本文件为非常详细交接版**——新 AI 只读本文件即可继续,不要依赖旧会话记忆
> **接收者: 新 AI —— 只读本文件,按"十、下一步"执行**

---

## 〇、三十秒总览(先读这个)

**项目**: 写一本 OpenJDK 源码分析书("格物致知"),源码树 = jdk11u(`/data/workspace/jdk11u/src/hotspot/`)。

**当前正在做**: 卷 2 按 48 域依赖拓扑写源码文章,每篇严格按方法论: 读大纲 → **所有行号重新 grep 验证** → 写 → 代码块与源码逐字核对 → **深审 2 轮(用户常追加第 3 轮 REVIEW)** → 回填大纲 ⚠️ 块 → 提交 → README → HANDOFF。

**下一步(唯一,无选择)**: 13-jit-framework/02(TieredThresholdPolicy,大纲 `planning/outlines/13-jit-framework/02-tiered-compilation-policy.md`;"5 层编译策略";13-jit-framework/01 悬念指向它: 为什么 tier3→%tier4→tier4)。

**铁律**: ① 一篇一篇写,写完自查+深审 2 轮合格再下一篇;② 大纲/KP 的行号与机制描述是"线索不是事实",写作时必须重 grep——**实测每篇大纲有 2-15 处机制错误或行号漂移,74 篇无一例外**;③ 代码块贴真实源码(截取可,编造不可)——凭记忆写值必错,**"记忆中的代码"也要 grep 验证存在性**(本会话两次编造代码块: 44-02 的 check_end_stack、11-01 的 is_loading_success);④ 每篇写完整理后做深审,**必须 2 轮**(第 2 轮逐机制回源码质疑——第 2 轮才能抓到"顺理成章"的机制错误);⑤ 发现错误→修正文章→**回填大纲 ⚠️ 块**(防下次抄错)→提交;⑥ REVIEW 时正文与大纲的行号要一起过;⑦ 脚本语法错误要立即发现;⑧ 用户会追问"是不是 Kona 的问题"——实证 JDK 与源码版本要匹配,已下载 Temurin OpenJDK 11.0.32(见 §九)。

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
第 5 批(VM 核心): **11(1/2)** → 12 → 13 → 18 → 20 → 27 → 30 → 32 → 34 → 36 → 37 → 39 → 46   🚧 进行中
第 6 批(JIT/GC): 14 → 15 → 21 → 25 → 28 → 29 → 33 → 43
第 7 批(上层): 22 → 26 → 35 → 40 → 47
```

**已完成 74 篇**(全部在 `docs/openjdk/vol-02/`):

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
| **11-cds** | 1-2 | `11-cds/01-cds-overview-dump.md`(138)+`02-cds-load-shared.md`(322) | ✅ **11 域完结(本会话)** |
| **12-ci** | 1-3 | `12-ci/01-ci-overview-mirror.md`(176)+`02-ci-typeflow-escape.md`(164)+`03-ci-factory-runtime.md`(128) | ✅ **12 域完结(本会话)** |

### 本会话 9 篇的 commit 清单(按 git log 为准)

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

**本会话新增素材**(详见 §二 commit 清单,共 16 个): 08-bytecodes-javap.txt / 08-interpreter-templates.txt / 08-interpreter-counterdemo.txt / 08-linkresolve-javap.txt / 08-unsafe-demo.txt / 08-whitebox-demo.txt / 08-verifier-demo.txt / 08-verificationtype-javap.txt / 08-cds-demo.txt / 08-cds-dump-full.txt / 11-cds-load-demo.txt / 12-ci-inlining-demo.txt / 12-ci-typeflow-escape-demo.txt / 12-ci-replay-demo.txt / 13-jit-broker-demo.txt / 13-jit-tiered-demo.txt

**引用纪律**: 工具实证必须真实存在——引用前 grep materials/ 验证;素材缺失的实证不要引用,改为布局推导。

---

## 六、本会话实战经验(最重要,新 AI 必读)

### 6.1 大纲漂移的规律(74 篇全部出现,2-15 处/篇;旧会话沉淀 02/03/04/45/48/06/16/38/41/42/07/09/17/10/19/23/24 域,本会话沉淀 08/31/44/11 域)
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
- 本会话关键源码位置: templateInterpreter.cpp/hpp、templateTable.cpp、interpreterRuntime.cpp(:148-215 ldc/resolve_ldc、:217 _new、:749 monitorenter、:1176 at_safepoint、:1008 frequency_counter_overflow)、interfaceSupport.inline.hpp(:445 IRT_ENTRY、:468 JRT_ENTRY、:111-123 ThreadStateTransition)、unsafe.cpp(1122 行)、whitebox.cpp(2360 行)、forte.cpp(668 行)、verifier.cpp(2913 行)、verificationType.hpp/cpp、metaspaceShared.cpp(2184 行)、filemap.hpp/cpp(1515 行)、systemDictionaryShared.cpp(1071 行)、compactHashtable.cpp(529 行)、heapShared.cpp(862 行)

### 6.5 实证方法论新增(本会话沉淀)
- **javap 原始字节分析**: javap 显示是"解释过的",原始证据要 xxd/hexdump——44-02 的双槽证据是 `fd 00 05 04 04 04`(append 的 number_of_locals=4 vs 类型项 2 个),不是 javap 的 `[ long, long ]`
- **一字节修改构造坏 class**: 直接改 .class 字节(iload_0→aload_0)制造 VerifyError——注意类名不能改(文件与内部类名必须匹配);RunEvil 用 Class.forName 触发验证
- **WhiteBox 最小兼容类**: 自己写 sun.hotspot.WhiteBox(bootclasspath/a 加载),方法表注册对缺失方法只打 NoSuchMethodError Warning 不影响;native 方法签名必须与方法表 JNI 签名一致(getVMPageSize 是 ()I 非 ()J)
- **CDS 实证**: -Xshare:dump 生成 jsa;-Xlog:cds 看校验;-Xlog:class+load 看 "shared objects file" 来源
- **JDK 版本对比**: 用 Temurin 17 的 src.zip 验证 API 变迁(defineAnonymousClass 在 17 已移除)
- **JDK11 的 --illegal-access=permit**: 反射非导出包仅告警仍可用(实测无 --add-opens 通过);JDK16+ 才需 --add-opens
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
- [ ] **18-safepoint/01**——**下一篇**;大纲 `planning/outlines/18-safepoint/`(以实际文件名/⚠️ 块为准);13-jit-framework 域完结后按拓扑进入 18-safepoint(第 5 批下一域;14-c1 属第 6 批,别提前写)
- [ ] 18-safepoint 完结后 → 20-vmops → 27-jni → 30-jvm-entry → 32-jfr → 34-nmt → 36-attach → 37-heapdump → 39-runtime-mon → 46-sa(第 5 批剩余 8 域)
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
1. 读 planning/outlines/18-safepoint/ 的实际大纲文件(注意 ⚠️ 块——13-02 大纲已回填 8 条,18 域大纲大概率同样漂移;13 域完结,第 5 批下一域 18-safepoint)
2. 验证大纲所有 file:line 与专有名词(按 §6.1 的规律;18-safepoint 是 VM 同步机制,重点: safepoint 触发路径(VM_Operation/JVMTI/GC)、线程状态(ThreadSafepointState: _running/_blocked/_at_safepoint)、SafepointSynchronize::begin/end、spin 与阻塞、safepoint 计数(safepoint_counter)、与 17 域线程状态机和 04-signals-and-safepoint(01-os/04 已讲信号侧!)的衔接——查 01-os/04 讲了什么避免重复;实证: jdk11 -Xlog:safepoint 观察)
3. 实证优先用 /data/tmp/opencode/jdk11(Temurin 11,与 jdk11u 同版本);素材引用前 grep materials/ 验证
4. 按第三节流程写 → 自查(脚本 /data/tmp/opencode/check.py,新引用文件先加 HS_MAP/MAPPINGS/EXTERNAL;ART 变量改回当前文件)→ 深审 2 轮(用户会追加第 3 轮)→ 回填大纲 → 提交 → 更新 README
5. 18-safepoint 完结后 → 20-vmops → 27-jni → 30-jvm-entry → 32-jfr → 34-nmt → 36-attach → 37-heapdump → 39-runtime-mon → 46-sa(第 5 批剩余 8 域)
```

**环境**: Linux 容器,无显示器(GUI 截图等用户在 Ubuntu 补);jdk11u 源码在本地;git 推送即部署(docsify 站点)。**上下文已满: 本文件写完后,新会话只读本文件即可继续,不要依赖旧会话的记忆。**
