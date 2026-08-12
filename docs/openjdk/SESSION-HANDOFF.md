# SESSION-HANDOFF — 主交接文档(唯一入口,非常详细版)

> **状态**: 2026-08-12 | 卷 2 写作中: **32/152 篇完成**(第 1 批 12 篇 ✅ 全部完结;第 2 批 20/26: 02/03/04/06/16 域完结,38 域 1/2) | 上下文已满,本文件为**非常详细交接版**——新 AI 只读本文件即可继续
> **接收者: 新 AI —— 只读本文件,按"十、下一步"执行**

---

## 〇、三十秒总览(先读这个)

**项目**: 写一本 OpenJDK 源码分析书("格物致知"),源码树 = jdk11u(`/data/workspace/jdk11u/src/hotspot/`)。

**当前正在做**: 卷 2(按 48 域规划写源码文章),每篇严格按方法论: 读大纲 → **所有行号重新 grep 验证** → 写 → 代码块与源码逐字核对 → **深审 2 轮** → 回填大纲 → 提交。

**下一步(唯一,无选择)**: 38-perfdata/02(StatSampler,周期性刷新与同步)。

**铁律**: ① 一篇一篇写,写完自查+深审 2 轮合格再下一篇;② 大纲/KP 的行号与机制描述是"线索不是事实",写作时必须重 grep——**实测每篇大纲有 2-8 处机制错误或行号漂移(27 篇无一例外)**;③ 代码块贴真实源码(截取可,编造不可)——凭记忆写值必错;④ 每篇写完整理后做深审,**必须 2 轮**(第 1 轮自查+通读,第 2 轮逐机制回源码质疑——第 2 轮才能抓到"顺理成章"的机制错误,见 §6.5-4);⑤ 发现错误→修正文章→**回填大纲 ⚠️ 块**(防下次抄错)→提交。

---

## 一、项目全貌

| 卷 | 位置 | 状态 |
|---|---|---|
| 卷 0 地基 | `docs/openjdk/vol-00/`(4 章) | ✅ 旧会话完成,不动 |
| 卷 T 工具观测 | `docs/openjdk/vol-tools/ch01-07.md` | ✅ 旧会话完成(7 篇),写作时引用其素材做实证 |
| 卷 1-bak 启动 | `docs/openjdk/vol-01-bak/`(14 章) | ✅ 归档,不沿用 |
| **卷 2 运行时深处** | `docs/openjdk/vol-02/` | 🚧 **当前任务**,按 48 域依赖拓扑写 |
| 域规划 | `docs/openjdk/planning/` | 48 域权威清单(00-domain-discovery-v3.md)+ 每域 KP(knowledge-planning/0X-*.md)+ 每域大纲(outlines/0X-*/) |
| 工具素材库 | `docs/openjdk/planning/outlines/00-jvm-tools/materials/` | ✅ 115 命令输出/21 截图/10 JFR 录制/2 日志(gitignore,不入库) |
| 本交接文档 | `docs/openjdk/SESSION-HANDOFF.md` | 本文件 |

**git 仓库**: `/data/workspace/source-code/openjdk-book/`(remote: git@github.com:LoveEleve/openjdk-book.git,main 分支,每篇一提交一推送)
**旧交接文档**(更早会话起点,可参考历史): `/data/workspace/source-code/book/成长之路/tmp-question/training-camp/source-code/analysis/source-analysis/HANDOFF.md`

---

## 二、卷 2 写作进度(精确到篇)

**写作顺序依据**: `docs/openjdk/planning/knowledge-planning/00-domain-writing-order.md`(48 域依赖拓扑 7 层,脚本验证自洽)

```
第 1 批(地基): 01(4 篇) → 05(2 篇) → 45(2 篇) → 48(4 篇)         ✅ 全部完成(12/12)
第 2 批(原语): 02(4 篇) → 03(2 篇) → 04(2 篇) → 06(6 篇) → 16(5 篇) → 38(2 篇) → 41(2 篇) → 42(3 篇)   🚧 进行中(20/26: 02/03/04/06/16 完结,38 域 1/2)
第 3 批(对象/类): 07 → 09 → 17
第 4 批(执行/帧): 10 → 19 → 23 → 24 → 08 → 31 → 44
第 5 批(VM 核心): 11 → 12 → 13 → 18 → 20 → 27 → 30 → 32 → 34 → 36 → 37 → 39 → 46
第 6 批(JIT/GC): 14 → 15 → 21 → 25 → 28 → 29 → 33 → 43
第 7 批(上层): 22 → 26 → 35 → 40 → 47
```

**已完成 27 篇**(全部在 `docs/openjdk/vol-02/`):

| 域 | 篇 | 文件 | 状态 |
|---|---|---|---|
| 01-os | 1-4 | `01-os/` 4 篇 | ✅ 旧会话完成,抽查修正 |
| 05-cpu-primitives | 1-2 | `05-cpu-primitives/` 2 篇 | ✅ 旧会话完成,抽查修正 |
| 45-math-library | 1-2 | `45-math-library/` 2 篇 | ✅ 本会话前完成 — 45 域完结 |
| 48-utilities | 1-4 | `48-utilities/` 4 篇 | ✅ 本会话前完成 — 48 域完结,第 1 批全部完成 |
| 02-assembler | 1-4 | `02-assembler/` 4 篇 | ✅ 完成 — 02 域完结 |
| 03-arguments-flags | 1-2 | `03-arguments-flags/` 2 篇 | ✅ 完成 — 03 域完结 |
| 04-logging | 1-2 | `04-logging/` 2 篇 | ✅ 完成 — 04 域完结(02 篇 d1fa856) |
| 06-oops | 1-6 | `06-oops/01-markoop-oopdesc.md`(207 行)/02(168 行)/03(166 行)/04(129 行)/05(116 行)/06(104 行) | ✅ 本会话完成 — **06 域完结**(六篇,大纲 60+ 处错误全部回填) |
| 16-codecache | 1-5 | `16-code-cache/` 5 篇(01 115 行/02 288 行/03 277 行/04 182 行/05 225 行) | ✅ 本会话完成 — **16 域完结** |
| 38-perfdata | 1 | `38-perfdata/01-perfdata.md`(117 行) | ✅ 本会话完成 — 38 域 1/2 |

**每篇 commit 号**: 以 git log 为准。本会话关键: 04域02=d1fa856(正文)+fbd6d14(深审2);06域01=cb28960+5f4d58b;06域02=f20797f+bd66244+2cada2f;06域03=0731946+f1dd337+c2bdeec;06域04=fa40087+b1600c8;06域05=6b736da+8f8476b;06域06=2ec7fa5+dbeab71;06 整体 REVIEW=5ad9741;16域01=be980da+db3f944;16域02=b8c35d8(正文+大纲回填)+a4e5d71(README);16域03=904eab3(正文+大纲回填)+6fa855b(README);16域04=ec7599c(正文+大纲回填)+d66674f(README);16域05=8a223d2(正文+大纲回填)+58b1aa9(README,16 域完结);38域01=2094349(正文+大纲回填)+2bd7af9(README);终检=aa93828(交接文档篇数修正)+b2c7a1c(2 处文字锚)。

**已回填的大纲**(写作中发现漂移即回填,防下次抄错): 45/48/02/03/04/06(六篇)/16(01、02)各域 outlines 均已按真实源码重写并标 ⚠️ 写作期修正;KP(45/48/04)同步修正。**写作 38-02 前先读 38-01 大纲 ⚠️ 块**(计数器模型/文件映射/无锁协议均已验证;02 篇 StatSampler 与 01 篇 sample()/create_sampled_perfdata 部分衔接)。

---

## 三、每篇写作流程(严格执行,不可省略)

```
1. 读大纲: planning/outlines/<NN>-<域>/<NN>-<篇>.md(注意 ⚠️ 写作期修正块)
2. 读 KP: planning/knowledge-planning/<NN>-<域>.md(若大纲信息不足)
3. 【铁律】验证大纲里所有 file:line 与"专有名词存在性"——逐个 grep/sed 核对,发现漂移用真实行号
   —— 实测: 大纲几乎每篇都有 2-8 处错误/漂移,绝不可照抄;行号对了名字也可能是假的(见 §6.5-1)
4. 写正文到 vol-02/<NN>-<域>/<NN>-<篇>.md
5. 自查:
   - 代码块与源码逐字核对(python 脚本: 提取块内行逐一比对源文件区间)
   - 所有 file:line 范围验证(脚本: 文件名→目录映射,行号在 [1, 文件行数] 内)
   - 星号配对(代码 span 剔除后)、文字锚(文件名后无行号)、TODO 残留
   - 工具实证引用必须真实存在(materials/ 里 grep 到才引用)
6. git add + commit + push(信息: 域/篇/深审修正清单;中文)
7. 更新 vol-02/README.md 勾选进度(单独 commit)
```

**深审流程(写完后主动做 2 轮,不要等用户要求)**:
```
第 1 轮: 通读全文 + 跑自查脚本(代码块/行号/星号/文字锚/TODO)
第 2 轮(最重要,专门抓"写对但机制是编的"):
   ① 写作时"凭记忆/凭直觉"补的机制描述——逐个回源码核对(识别信号: "所以/为什么能/自然"开头的推导段)
   ② 正文引用的 file:line 内容语义(不是存在性)
   ③ 数字自洽(全文 grep 关键数字,含默认值/枚举值)
   ④ #7 文字锚(文件名后无行号的引用)
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
- 每机制段落四要素: 场景 → 技术描述(file:line+函数名) → **关键设计 (斜体)**(why)→ 跨层标注([C++:] [x86:] [man N xxx] [实证:])
- 结尾: `## 核心悬念`(一段话总结本篇+桥到下一篇)+ `> → [下一篇](...)`
- 代码块: 首行标注 `// file.cpp:start-end(截取核心/注释/逐字)`;标注范围必须与内容精确对应(含闭合括号行)
- 跨篇引用用相对/`openjdk/vol-02/...` 路径;**链接文本必须与目标文章标题一致**(本会话抓过 3 处不一致)

### 4.3 书稿代码块纪律(血泪总结,每篇深审都靠它抓错)
1. **代码块 = 真实源码**: 截取可(省略模板/错误处理,用 "..." 占位),核心语句逐字,**禁止凭记忆写值/编码/常量/注释**(注释也不能编!抓过 itableOffsetEntry 的编造注释)
2. **行号写作时重新 grep**: 大纲/KP 是规划期产物,行号大量漂移——每篇实测都有 2-8 处漂移
3. **自查脚本**: 文章每个 file:line 逐个核对(范围+存在性);代码块与源码逐行 diff(提取块内行逐一 grep -qF)
4. **文件名必须 find 验证**: 目录/文件路径凭记忆必错(jdk11u 有重构: flags/ 子目录、share/asm/ 的 codeBuffer.hpp 等)
5. **大纲的"篇数/数字"也要重验**: 规划文档的篇数可能过时(第 2 批实际 26 篇: 06-oops=6、16-code-cache=5、42-core-native=3,规划印象中的 "7/10" 是错的)——进度表述以 outlines/ 实际文件数为准

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
| 命令输出 | `materials/commands/` 115 文件 | jcmd/jstat/jmap 等真实输出 |
| 卷 T 文章 | `vol-tools/ch01-07.md` | 引用格式: "[卷 T ch02](openjdk/vol-tools/ch02.md)" |

**引用纪律**: 工具实证必须真实存在——引用前 grep materials/ 验证;素材缺失的实证(如 JOL 对象头输出)不要引用,改为布局推导。

---

## 六、本会话实战经验(最重要,新 AI 必读)

### 6.1 大纲漂移的规律(27 篇全部出现,2-8 处/篇;02/03/04/45/48 域案例为更早会话沉淀,06/16 域为本会话新增)
**任何机制描述/行号/值/专有名词,一律当"线索"而非"事实"**。高频漂移类型:
1. **机制编造**(最严重): 大纲把"想当然的实现"写成机制——实证全部是编造:
   - 02-01: "delayed_nop" 编造(实际是 Label 长格式预发+add_patch_at 回填)
   - 02-02: "XMM 16 个" 实为 32 个(jdk11u 支持 AVX-512);"VMReg 负数=栈槽" 实为 stack0 正数
   - 03-01: "PRODUCT_FLAG 宏" 编造(实际 RUNTIME_FLAGS 14 参巨型宏);"Origin 5 级" 实为 9 级
   - 04-01: "标签树/父指针/前缀 walk" 编造(实际扁平枚举+子集匹配);"LogLevel Trace=0" 顺序反了(Off=0)
   - 48-02: "per-bucket mutex" 实为指针低 2 位嵌入 spinlock;"双重哈希" 不存在
   - 06-01: **markOop 五种状态位布局全错**(真实: 低 2 位 lock: 0=轻量/1=unlocked/2=monitor/3=marked,第 3 位 biased,biased_pattern=101=5;大纲"0/1/2-3/4-5/6-7"全错);"64 位 hash 25 位"实为 31 位
   - 06-02: **KlassLayoutHelper 类不存在**;"is_instance = lh<0"方向反(实为 lh>0);"~20 种 Klass 子类"实为 7 个;invokevirtual 汇编序列编造(真实 load_klass+lookup_virtual_method 一条 movptr)
   - 06-04: **MethodLinker 类不存在**(Method::link_method 直接设);"CompileThreshold 默认 10000→C1"错(C1=1500/C2=10000 x86);"_indy_bsm 字段"编造(实际 operands 数组)
   - 06-05: "OopHandle=OopStorage index"错(实为 oop* 封装);"WeakHandle=tag"错(实为独立弱处理存储);"零运行时 dispatch"不准确(resolve_barrier 运行时解析)
   - 06-06: "_hash 字段"编造(实为 _identity_hash 短字段+动态算);"AnnotationArray 扁平 int 数组"实为 Array<u1>;"_holder_method: Method*"编造(实为 Metadata*+_is_metadata_method)
   - 16-01: "CodeCache::allocate :181-210"实为 :482;"NonNMethod ~5MB"实为 32M(x86)
2. **版本漂移**: 大纲写的是 JDK 8/其他版本的机制:
   - safepoint_poll: 全局轮询页 → jdk11u 是 thread-local poll
   - "constantPoolOopDesc 继承 oopDesc" → jdk11u 是 ConstantPool : Metadata
3. **行号漂移**: 大纲行号与实际差几十到几百行(规划期 2026-08-08 的产物)
4. **文件名漂移**: jvmFlag 在 share/runtime/flags/;codeBuffer.hpp 在 **share/asm/** 不在 share/code/;symbolTable.hpp 在 **share/classfile/** 不在 share/oops/;CodeHeap 在 **share/memory/heap.hpp**;accessBackend.hpp 在 share/oops/

### 6.2 写作期"凭记忆"错误(自查 diff 抓出的真实案例,每篇深审必有)
- 02-02: REX_WRB 写成 0x4F(实际 0x4D,assembler_x86.hpp:537)
- 02-03: addsd 的 VEX 编码写成 66 前缀(实际 F2)
- 03-02: JAVA_OPTS(实际 _JAVA_OPTIONS,arguments.cpp:3317)
- 04-01: 标签数 "~100"(实际 143)
- 06-02: **vtable 构建机制凭直觉写成"长度继承+逐个归位"**(实际 initialize_vtable 先 initialize_from_super 把父表**整体复制**进子表再覆写/追加,klassVtable.cpp:138-155,注释 :205-206)——这是深审第 2 轮才抓到的
- 06-02: itableOffsetEntry 代码块里**编造了字段注释**(源码无注释)——#14 违规,自查 diff 抓出
- **教训**: 凡代码块里的值/编码/常量/注释,写完必须用 sed 逐行对照;数字先数后写;推导段("所以/为什么能")必须回源码找依据

### 6.3 平台/环境事实(写作时已确认)
- **jdk11u 源码树只含 x86 平台**(cpu/ 只有 x86,os/ 只有 linux/posix)——不要断言其他平台的实现细节(ARM 等无法验证,写了就是编造)
- jdk11u 关键位置: flags/ 在 share/runtime/flags/;vmreg.hpp 在 share/code/;os.hpp/os.cpp 在 share/runtime/;assembler 在 share/asm/ + cpu/x86/;codeBuffer.hpp 在 **share/asm/**;symbolTable.hpp/stringTable.hpp 在 **share/classfile/**;CodeHeap 在 **share/memory/heap.hpp**;accessBackend.hpp 在 share/oops/;markOop 在 share/oops/
- 常用实证: CodeEntryAlignment=32(globals_x86.hpp:49)、UseLibmIntrinsic 默认 true(globals_x86.hpp:217)、ErrorLogTimeout=2*60(globals.hpp:636)、CompileThreshold C1=1500(c1_globals_x86.hpp:43)/C2=10000(c2_globals_x86.hpp:43)、NonNMethodCodeHeapSize=32M(globals.hpp:92)、MaxTenuringThreshold=15(gc_globals.hpp:699)、ObjectAlignmentInBytes=8(globals.hpp:245)、LogMinObjAlignmentInBytes=exact_log2(ObjectAlignmentInBytes)(arguments.cpp:1605)、UnscaledOopHeapMax=4G/OopEncodingHeapMax=32G(globalDefinitions.hpp:517-520,值在 arguments.cpp:1609)、card_shift=9→card_size=512(cardTable.hpp:231-232)

### 6.4 已完成的交叉引用关系(写作时保持一致性)
- 45-01(fast_sin)→ 45-02(CodeBuffer/生成管道)→ 48-01(vmError)→ 48-02(并发表/位图)→ 48-03(输出流/异常)→ 48-04(三种格式)
- 02-01(CodeBuffer/Label)→ 02-02(编码)→ 02-03(指令)→ 02-04(MacroAssembler 运行时)→ 03-01(flag 定义)→ 03-02(flag 生命周期)→ 04-01(日志标签)→ 04-02(输出配置)
- **06 域链**: 06-01(对象头,union 高 4 字节"普通对象填充")→ 06-02(Klass/vtable/itable)→ 06-03(InstanceKlass 仓库+数组,**数组 length 占 union 高 4 字节**——与 01 篇呼应)→ 06-04(常量池解析/Method 四入口)→ 06-05(Access API/barrier)→ 06-06(Symbol/注解/FieldStream/CompiledICHolder)→ 07-classfile-classloader/01(第 3 批)
- **16 域链**: 16-01(CodeBuffer→CodeBlob/CodeHeap)→ 16-02(nmethod 结构)→ 16-03(生命周期)→ 16-04(relocation/IC)→ 16-05(dependencies/deopt)
- 跨域: 02-01 的 CodeBuffer 是 16-01 的起点(前置依赖已链);06-04 的 Method 四入口与 16 域 nmethod 强相关

### 6.5 06-oops 域新增经验(2026-08-12,6 篇 60+ 处,接 6.1/6.2)
1. **规划期"发明"专有名词**(最危险,识别=必 grep 存在性): KlassLayoutHelper、MethodLinker、constantPoolOopDesc、"~20 种 Klass 子类"(实际 7 个)、_indy_bsm/_indy_name/_indy_type、_hash 字段、_holder_method——AI 规划时编造"听起来合理"的类/函数/字段名,行号查不出问题,名字本身是假的
2. **流传说法与源码相反**(常见知识陷阱): SATB"增量更新"(实为 Snapshot-At-The-Beginning 开始时刻快照,05 初稿就写反了)、"OopHandle=OopStorage index"(实为 oop* 封装)、"WeakHandle=OopHandle+weak tag"(实为独立弱处理存储)、"invokevirtual 4 次 deref"(实为 load_klass+lookup_virtual_method 一条 movptr,macroAssembler_x86.cpp:4640-4652)、"is_oop 查 KlassID/Metaspace"(实为 heap 范围+mark 非空两查,oop.cpp:121-137)、"as_C_string 不加 \0"(实为 null-terminated,symbol.cpp:123-127)、"_refcount 非 atomic"(实为 volatile+Atomic::inc/add,symbol.cpp:277-289)、"SymbolTable 用 ConcurrentHashTable"(实为 RehashableHashtable+全局 SymbolTable_lock;StringTable 才是并发哈希)
3. **枚举/位布局是重灾区**: markOop 五种状态位布局全错(真实 locked=0/unlocked=1/monitor=2/marked=3/biased_pattern=101)、KlassID 顺序(InstanceRef=1/InstanceMirror=2)、FieldInfo 槽 4-5 低 2 位 tag(01 偏移/10 带类型/11 争用组,fieldInfo.hpp:55-62)、_init_state 6 态(漏 initialization_error,instanceKlass.hpp:131-138)——凡"枚举顺序/位分配/编号"逐字对照定义,不能凭印象
4. **深审第 2 轮才抓到的"顺理成章"机制错误**(第 1 轮自查过了还错): vtable"先复制父表再覆写/追加"(初稿"长度继承+归位")、SATB 入队路径(线程本地/共享队列,非"满转全局",g1BarrierSet.cpp:62-69)、FastHashCode CAS 失败=膨胀成 monitor 存 hash(非"重试",synchronizer.cpp:760-762)、biased_locking_enter 第一道位测试分流(非"CAS 永不成功",macroAssembler_x86.cpp:1142-1144)、ConstMethod 布局"结构之后"非"固定头之后"、find_blob 反查=段映射定位(非二分,heap.cpp:486)、FieldStream 不含父类字段(fieldStreams.hpp:102-109)
   - **识别信号**: 正文里"所以/为什么能这么做/自然"开头的推导段最可疑——那是写作时凭直觉补的,必须回源码找依据
5. **覆盖率缺口**: 03 篇初稿漏 InstanceKlass 仓库(02 篇悬念承诺 4 件事+KP 规划"InstanceKlass 体系+ArrayKlass 体系"只有数组)——**写完对照"上篇悬念承诺话题"逐条勾选**;跨篇悬念行是最可靠的大纲(它承诺了什么就该写什么)
6. **"语义方向反了"独立模式**(06 篇收官): 大纲常把源码行为写成恰好相反——带否定词的描述("不/没有/无需")重点核,先假设它是错的,再去源码找真相
7. **跨篇矛盾提前发现**: 06 大纲"FieldInfo 含 attributes_count"与 03 篇已写内容矛盾——以已有文章+源码为准;跨篇一致性从"写时对照"前移到"大纲验证时对照"
8. **同域两表对比必查实现**: SymbolTable(全局锁)vs StringTable(并发哈希)——写对比时两个实现都要验证,不能套一个模板

### 6.6 错误根因(为什么"每篇 2-8 处"不可避免)
1. 大纲是规划期 AI 生成,"像真的"的编造是最危险形态——名字合理、机制自洽,唯独源码里不存在
2. 写作期大脑默认路径: 大纲说法"合理"→直接写,而不是"每个机制先 grep 再写"(铁律 ② 的对抗者)
3. 自查脚本只能抓"写错"(行号/代码块/数字),抓不了"写对但机制是编的"——机制正确性只能靠人工深审,且第 1 轮常被自己的叙述带着走,第 2 轮逐条质疑才有效
4. 结论: **深审必须 2 轮**;沉淀要即时(本篇教训进 §6.5/6.7 后再写下一篇)

### 6.7 16-codecache 域经验(01-02 篇,2026-08-12)
- codeBuffer.hpp 在 **share/asm/**: section 枚举 :353-361(SECT_FIRST=0,CONSTS=0/INSTS/STUBS,顺序即最终布局,compute_final_layout codeBuffer.cpp:472 按枚举序紧凑排);Section 类字段 _start/_end/_limit/_locs_start/_locs_end 在 :86-92
- CodeBlobType :38-46(struct CodeBlobType{enum{...NumTypes=5}});层次: CodeBlob :86 → RuntimeBlob :340(BufferBlob :383/AdapterBlob :424/VtableBlob :437/RuntimeStub :468/SingletonBlob :517/Deopt :554/UncommonTrap :642/Exception :672/Safepoint :703)+ CompiledMethod→nmethod;AOT 在 C 堆(codeBlob.hpp:54-56 注释)
- CodeCache::allocate :482(降级路径注释 :510-512 "NonNMethod -> MethodNonProfiled -> MethodProfiled");commit :588;get_code_blob_type codeCache.hpp:260-273;SegmentedCodeCache 条件=分层+ReservedCodeCacheSize≥240MB(:61-66 注释)
- CodeHeap 在 share/memory/heap.hpp:81:allocate heap.cpp:285(search_freelist :291+顺序后备 _next_segment)+deallocate :369(add_to_freelist :617,merge_right 合并);find_start :486(地址右移段大小→segmap 定位,非二分);VirtualSpace 页对齐=ReservedSpace::page_align_size_up(virtualspace.cpp:256)
- **02 篇(nmethod 结构,大纲漂移 12+ 处,重点沉淀)**:
  - **入口/IC 机制**(大纲全错): 未验证入口 = C2 MachUEPNode(x86_64.ad:1685-1692)`cmp rax,[j_rarg0+8]; jne ic_miss_stub; nops 对齐`——期望 Klass 在 **rax**,来自调用方动态调用点 `movq rax,imm64; call`(10+5=15B = MachCallDynamicJavaNode::ret_addr_offset :574-578;CallDynamicJavaDirect :12834);IC 缓存值存 mov 立即数(CompiledIC::_value=get_load_instruction compiledIC.cpp:171-179;NativeMovConstReg::instruction_size=10 nativeInst_x86.hpp:264);非优化单态调用走 **entry_point(未验证)**,优化/静态绑定才直连 verified_entry(compiledIC.cpp:492-496);Megamorphic→VtableStubs 桩非"走解释器",缓存不可靠(compiledIC.cpp:275);Interpreted 态才走 c2i
  - **状态机**: 枚举 6 值含 not_used=1(compiledMethod.hpp:188-197)但 never 被赋值(make_not_used→make_not_entrant,nmethod.hpp:342);make_not_entrant_or_zombie 非 CAS——Patching_lock 双重检查(nmethod.cpp:1144+;早退 :1148-1153;锁内复查 :1182-1186)+patch verified entry 5B jmp→handle_wrong_method_stub(:1190-1193,8B Atomic::store nativeInst_x86.cpp:561);转 not_entrant 时 mark_as_seen_on_stack :1212-1214 在状态变更前
  - **布局**: 偏移链在 JIT ctor nmethod.cpp:685-746(_consts_offset=content_offset+total_offset_of(consts) :685,oops=:738 起,顺序 header→reloc→consts→code→stubs(exception/deopt handler 在 stubs 区 :718-722)→oops→metadata→scopes→pcs→deps→handler→nulchk);_scopes_data_offset 字段**声明未使用**(用 CompiledMethod::_scopes_data_begin compiledMethod.hpp:157);ScopeDesc 是 _sender_decode_offset 链非 _parent 指针(scopeDesc.cpp:79-86,sender :152-155,is_top :149);PcDesc 字段 pcDesc.hpp:37-39
  - **其他**: InvocationEntryBci=-1(compilerDefinitions.hpp:44);静态方法 entry==verified(nmethod.cpp:775-776 assert,仅 C2/JVMCI 生效);nmethodLocker 使用点: deoptimization.cpp:1546/jvmtiImpl.cpp:920/sharedRuntime.cpp:1078;can_convert_to_zombie nmethod.cpp:999-1007;实证: jcmd-Compiler.codelist.txt 755 个 nmethod=696 in_use+59 not_entrant(第三列是 state,print_codelist codeCache.cpp:1667-1681)
- **03 篇(nmethod 生命周期,sweeper,大纲漂移 15+ 处,重点沉淀)**:
  - NMethodSweeper 在 **share/runtime/sweeper.{hpp,cpp}**;sweeper.hpp:35-58 类注释=机制权威(标记在 safepoint/清扫不在且让位;'at least 3 sweeps');`_traversals` "Stack scan count, also sweep ID"(sweeper.hpp:67)
  - 标记: 挂 safepoint 收尾 ParallelSPCleanupTask(ParallelSPCleanupThreadClosure safepoint.cpp:613-631,do_cleanup_tasks :731);MarkActivationClosure(sweeper.cpp:163-174)= **set_hotness_counter(reset_val) 重置**(非 +=)+not_entrant 活跃→mark_as_seen_on_stack(nmethod.cpp:989-993);空间告急才 do_stack_scanning→VM_MarkActiveNMethods(sweeper.cpp:256-263)
  - 清扫: sweep_code_cache 增量(sweeper.cpp:429+),_current 游标;扫完才在下次标记时 _traversals++(:232-238);让位 safepoint handle_safepoint_request :313-324;process_compiled_method :595-686(zombie→flush/not_entrant→can_convert_to_zombie→make_zombie/alive→possibly_flush+清 IC)
  - hotness: reset_val=(ReservedCodeCacheSize<M)?1:(RC/M)*2(:188-193);dec_hotness_counter(possibly_flush :695,UseCodeCacheFlushing 默认 true globals.hpp:1976);淘汰 hotness<threshold(-reset+reverse_free_ratio*NmethodSweepActivity)且 time_since_reset>MinPassesBeforeFlush(10,globals.hpp:1260)(:698-716,make_not_entrant() :758);reverse_free_ratio=max_capacity/unallocated(codeCache.cpp:1042-1051)
  - 触发: possibly_sweep 注释三条件 :327-331;notify 有门槛 reverse_free_ratio>=MAX2(100/StartAggressiveSweepingAt,1.1)=10(约 10% 空闲,sweeper.cpp:283-291);non-profiled 堆 ≤10% 强制栈扫描(:373-380);状态变化>1%(:558-575);周期 RC/(16*M)(:359-368)
  - **依赖失效(反向索引非全量)**: SystemDictionary::add_to_hierarchy→flush_dependents_on(systemDictionary.cpp:1817-1819)→KlassDepChange→mark_for_deoptimization(codeCache.cpp:1148)用 DepChange::ContextStream(dependencies.cpp:2101-2131: 新类→父类链→传递接口)找受影响类→InstanceKlass::mark_dependent_nmethods(instanceKlass.cpp:2103)→DependencyContext::mark_dependent_nmethods(dependencyContext.cpp:62-81)查反向桶+check_dependency_on(spot_check dependencies.cpp:2047)→VM_Deoptimize(vmOperations.cpp:118-128)→make_marked_nmethods_not_entrant(codeCache.cpp:1259-1266);类重定义变体 flush_evol_dependents_on :1292
  - uncommon trap: UncommonTrapBlob(codeBlob.hpp:642)→Deoptimization::uncommon_trap(deoptimization.cpp:2095,blob 生成 sharedRuntime_x86_64.cpp:3182-3219)→uncommon_trap_inner :1526;action 编码决定生死(deoptimization.cpp:1794-1837: none/maybe_recompile 不失效/reinterpret/make_not_entrant/make_not_compilable)
  - GC 交接: gc_prologue() **空函数**(codeCache.cpp:919);gc_epilogue 只 prune_scavenge_root_nmethods(:921-923);年轻代 Serial/Parallel=scavenge_root_nmethods_do(genCollectedHeap.cpp:837,链 codeCache.hpp:98,register 条件 detect_scavenge_root_oops :772-777),G1=per-region strong code roots(register_nmethod g1CollectedHeap.cpp:5012);全堆=blobs_do(genCollectedHeap.cpp:845-848);类卸载 G1=G1CodeCacheUnloadingTask→do_unloading_parallel(compiledMethod.cpp:507-527)→do_unloading_oops(nmethod.cpp:1496)→make_unloaded(can_unload :1379-1390);**CodeCache::do_unloading(codeCache.cpp:698)无调用者**
  - 应急: 分配→notify→expand_by(:498)→降级堆(:510-517)→handle_full_code_cache(compileBroker.cpp:2292-2328:UseInterpreter=true+set_should_compile_new_jobs(stop)/disable_compilation_forever+report_codemem_full codeCache.cpp:1365 警告+JFR);恢复 freed_memory>0(sweeper.cpp:534-547);sweeper 线程 NearMaxPriority(compileBroker.cpp:803-815)
  - 实证: hotspot.log 64 个 <make_not_entrant>(59 level3)+49 个 <uncommon_trap action='make_not_entrant'>(range_check/class_check);CodeHeap_Analytics sweeper statistics 全 0(2.5min 无完整 sweep)
- **04 篇(relocation/IC,大纲漂移 10+ 处,重点沉淀)**:
  - **位布局**: "4 type+12 offset" 是通用注释(relocInfo.hpp:75-83);x86-64 format_width=2(relocInfo_x86.hpp:38-41)→实际 **4 type+2 format+10 offset**(offset_width=nontype_width-format_width relocInfo.hpp:432),单条最大 1024 字节(offset_limit :344);format 编码操作数形态 disp32=1/imm32=2/narrow_oop=3(assembler_x86.hpp:612-617)
  - **枚举 0-15 全用**(relocInfo.hpp:257-275): oop=1/virtual_call=2/opt_virtual_call=3/static_call=4/static_stub=5/runtime_call=6/external_word=7/internal_word=8/section_word=9/poll=10/poll_return=11/metadata=12/trampoline_stub=13/runtime_call_w_cp=14/data_prefix_tag=15
  - prefix(advance_over_prefix relocInfo.cpp:222-237,10 位内压前缀 immediate 注释 :373-375);filler(none+offset_limit-unit,relocInfo.hpp:458-460,三用途 :337-343);RelocIterator: 构造 :128-155,next 累积 delta(:569-590),set_limits 顺序推进(:196)
  - RelocIterator 三用途: oops_do immediate oop(nmethod.cpp:1578-1608,oop_index()==0 :941)、CompiledIC 定位(compiledIC.cpp:196-201)、sweeper 清 IC(cleanup_inline_caches_impl compiledMethod.cpp:556-589 遍历 virtual/opt_virtual/static_call);oops_reloc_begin 从 verified_entry_point 起(:234-245,not_entrant 前几字节被 jmp 覆盖)
  - **无 CMPXCHG16B**(大纲编造): 原地补丁=set_destination_mt_safe(nativeInst_x86.cpp:261,前提 Patching_lock/safepoint :265-266)写序三步(①前 2 字节改 jmp rel8 -2 自旋 ②写后 3 字节 ③覆盖前 2 字节;每步 ICache flush);NativeCall :156(size=5,disp_offset=1)/NativeMovConstReg :253(0xB8+REX.W,size=10,data_offset=1+rex)/NativeJump :494(0xe9,5)
  - **ICBuffer 两阶段**: create_transition_stub icBuffer.cpp:172-194(组装: ICStub::set_stub :71-79 写 lea rax,[cached];jmp entry,icBuffer_x86.cpp:52-62)→切换(只改 call 目标指向桩)→safepoint finalize(:50-58 写回两字段,链: update_inline_caches→remove_all stubs.cpp:200→remove_first→stub_finalize :175→ICStubInterface::finalize);桩队列=StubQueue(InlineCacheBufferSize=10K globals.hpp:412),满→VM_ICBufferFull(new_ic_stub :120-143)
  - IC miss: handle_wrong_method_ic_miss(sharedRuntime.cpp:1421-1434)→handle_ic_miss_helper(:1552,CompiledIC_lock :1617): 静态可绑定→reresolve/mono→compute+set_to_monomorphic/否则→set_to_megamorphic(失败 set_to_clean);immediate oop 更新: fix_oop_relocations→oop_Relocation::fix_oop_relocation→oop_addr=pd_address_in_code

### 6.8 38-perfdata 域经验(01 篇,2026-08-12)
- perfData.hpp 在 **share/runtime/**: 类层次 :97-107(PerfLongConstant alias PerfConstant/PerfLongVariable alias PerfVariable/PerfLongCounter alias PerfCounter/PerfString);Variability V_Constant=1/V_Monotonic=2/V_Variable=3 :255-262;Units 六种 :266-273;PerfData 对象 C 堆+值 _valuep 指向共享区(:289-291);create_entry 8 字节对齐 perfData.cpp:125-186(align=sizeof(jlong)-1 :151-153,共享区满退 C 堆 :159-161)
- PerfDataEntry 布局(perfMemory.hpp:78-98,公共契约,注释 :55-56 "known by the PerfDataBuffer Java class libraries");Prologue :62-74(magic 0xcafec0c0/版本 2.0/accessible/entry_offset/num_entries);accessible 在 VM 启动完成时置位(management.cpp:205-207);mark_updated→mod_time_stamp(perfMemory.cpp:235-240)
- **目录权限 0755 非 0700**(make_user_tmp_dir perfMemory_linux.cpp:852-853 注释 "create the directory with 0755 permissions");隔离靠**文件 0600**(create_sharedmem_file :909 S_IRUSR|S_IWUSR);防 symlink is_directory_secure :240/is_file_secure :417;容器 flock :938-942;路径 /tmp/hsperfdata_<user>/<pid>(PERFDATA_NAME perfMemory.cpp:43;容器 /proc/{vmid}/root/tmp :142-146);mmap_create_shared :1056(mmap :1091);attach mmap_attach_shared :1181;unlink delete_shared_memory :1133-1146;残留清理 cleanup_sharedmem_files
- 计数器注册: 各子系统 create(CollectorCounters collectorCounters.cpp:43-58 sun.gc.collector.<n>.time/invocations/lastEntryTime/lastExitTime;name_space perfData.cpp:373-377);PerfDataManager 挂列表 _all/_sampled/_constants(:40-42);StatSampler 建 sun.rt.javaCommand(:322-324)/sun.os.hrt.ticks(:356-359);UsePerfData 默认 true(globals.hpp:2419);PerfDataSaveToFile(globals.hpp:2423,save_memory_to_file :82,调用 :1345-1346)
- 无锁协议: 8 字节对齐 + x86-64 aligned store 原子 + 单调语义容忍旧值(inc/add perfData.hpp:416-419);sample() perfData.cpp:216-220(02 篇展开);实证 jstat-gc.txt 各列=计数器
- **05 篇(依赖/deopt,16 域收官,大纲漂移 15+ 处,重点沉淀)**:
  - **dep 类型 11 种赌注**(枚举 12 值含 end_marker,TYPE_LIMIT=12,dependencies.hpp:104-171): evol_method/leaf_type/abstract_with_unique_concrete_subtype/abstract_with_no_concrete_subtype/concrete_with_no_concrete_subtype/unique_concrete_method/abstract_with_exclusive_concrete_subtypes_2/exclusive_concrete_methods_2/unique_implementor/no_finalizable_subclasses/call_site_target_value;concrete_klass 编造不存在;assert_xxx 声明 dependencies.hpp:359-389,assert_common_2 实现 dependencies.cpp:236
  - 注册侧: new_nmethod nmethod.cpp:512-534(call_site→MethodHandles::add_dependent_nmethod;否则 InstanceKlass::cast(klass)->add_dependent_nmethod;注释 "The slow way is to check every nmethod");赌注本体 dependencies->copy_to(this) nmethod.cpp:760
  - 对账: spot_check_dependency_at dependencies.cpp:2047-2056(involves_context 筛选)→check_klass_dependency :1984-2026(10 个 case 分派,返回 witness)/check_call_site_dependency :2029
  - DeoptimizationBlob codeBlob.hpp:554-628: unpack/unpack_with_exception/unpack_with_reexecution :605-607 + C1 in_tls :618-621(注释 :613-617);**deopt 桩调 2 个 C 例程**(sharedRuntime_x86_64.cpp:2845-2858 注释): fetch_unroll_info deoptimization.cpp:139→helper :158(vframe 收集内联链,注释 :180-181)→UnrollBlock :514→汇编铺骨架帧→unpack_frames :623→vframeArray::unpack_to_stack vframeArray.cpp:567;Location location.hpp:45-60(register_number :108/stack_offset :107)
  - PcDesc 查找: 缓存+radix 二分(find_pc_desc_internal nmethod.cpp:1791-1872,"almost 100% hit rate")
  - VtableStubs: (is_vtable, vtable_index) 哈希(find_stub vtableStubs.cpp:208-260,VtableStubs_lock);x86-64 receiver=j_rarg0(rdi);load_klass(:83)→lookup_virtual_method(:113)→jmp [rbx+Method::from_compiled_offset](:132);CodeHeap Analytics: aggregate codeHeapState.hpp:106,实证 Reserved 245760/Committed 7488/Unallocated 243224 KB(3%)

---

## 七、用户偏好与纪律(重要,违背会被批评)

1. **严格按规划,不做多余选择**: 拓扑定了顺序就逐项推进——不要问"还是写 X?"(曾因制造选择被批评)
2. **每篇都做深度 REVIEW(2 轮)**: 用户会要求"按照方法论深度的 REVIEW",写完后**主动自查深审,不要等**
3. **一篇一篇写**: 不并行、不跳步
4. **数字/事实必须验证**: 任何带数字的陈述回源码/素材验证,禁止"凭记忆"
5. **命名混淆注意**: "域 01"与"05 域的第 01 篇"都带 01,表述时写清"域 XX 第 Y 篇"
6. 中文交流,提交信息用中文
7. 用户会追问"下一步规划是否合理"——要有自己的判断
8. **用户会追问"发现的问题都修复了吗/有沉淀吗"**——修复要有 commit 可查,沉淀要即时写进本文件 §6
9. 链接文本必须与目标文章标题一致(整体 REVIEW 抓过 3 处)

---

## 八、待办清单(按优先级)

- [x] **16-codecache/02**(nmethod-structure)——已完结,b8c35d8
- [x] **16-codecache/03**(nmethod-lifecycle)——已完结,904eab3
- [x] **16-codecache/04**(relocation-ic)——已完结,ec7599c
- [x] **16-codecache/05**(dependencies-deopt)——已完结,8a223d2,**16 域完结**
- [x] **38-perfdata/01**(perfdata)——已完结,2094349
- [ ] **38-perfdata/02**(stat-sampler)——大纲在 `planning/outlines/38-perfdata/02-stat-sampler.md`,38 域第 2 篇(38 域完结后 README 勾选)
- [ ] 第 2 批剩余 41-zipjimage → 42-core-native
- [ ] 第 2 批剩余域: 38-perfdata → 41-zipjimage → 42-core-native
- [ ] 第 3 批: 07-classfile-classloader(06 域悬念桥接指向它)
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
| 工具素材 | `docs/openjdk/planning/outlines/00-jvm-tools/materials/` |
| JDK 工具 | `/opt/codev/TencentKona/bin/`(17.0.8.1) |
| GUI 手册 | `docs/openjdk/planning/outlines/00-jvm-tools/GUI-manual.md` |
| 自查脚本(代码块/行号/星号/锚) | 见 §三 第 5 步;文件→目录映射表见本文件 §6.3 |

**自查脚本要点**(python,每篇跑):
- 代码块: `re.findall(r'```cpp\n// (file):(s)-(e)\(...\)\n(.*?)```')` → 逐行比对 `src[s-1:e]`
- 行号范围: 文件名→目录映射(share/oops/、share/code/、share/asm/、share/classfile/、share/memory/、share/runtime/、share/utilities/、share/gc/g1/、share/gc/shared/、cpu/x86/、make/autoconf/、os/linux/、os/posix/)→ 行号 ∈ [1, 行数]
- 星号: 剔除代码 span 后 `count('*') % 2 == 0`
- 文字锚: `(?!:)(file\.(?:cpp|hpp))(?!:\d)` 且文件存在 → 报错补行号

---

## 十、下一步(读完立即做)

```
1. 读 planning/outlines/38-perfdata/02-stat-sampler.md(大纲,注意 ⚠️ 块)
2. 验证大纲所有 file:line 与专有名词(按 §6.5-1 的规律,重点: StatSampler 线程/采样周期/同步协议/PerfSampleHelper 是否编造;statSampler.cpp 在 share/runtime/)
3. 按第三节流程写 → 自查(脚本)→ 深审 2 轮 → 回填大纲 → 提交 → 更新 README
4. 38 域完结后 → 41-zipjimage → 42-core-native(第 2 批收官)→ 第 3 批 07
```

**环境**: Linux 容器,无显示器(GUI 截图等用户在 Ubuntu 补);jdk11u 源码在本地;git 推送即部署(docsify 站点)。**上下文已满: 本文件写完后,新会话只读本文件即可继续,不要依赖旧会话的记忆。**
