# SESSION-HANDOFF — 主交接文档(唯一入口,非常详细版)

> **状态**: 2026-08-12 | 卷 2 写作中: **19/152 篇完成**(第 1 批 12 篇 ✅ 全部完结;第 2 批 7 篇,04-logging/02 待写) | 上下文已满,本文件为**非常详细交接版**——新 AI 只读本文件即可继续
> **接收者: 新 AI —— 只读本文件,按"九、下一步"执行**

---

## 〇、三十秒总览(先读这个)

**项目**: 写一本 OpenJDK 源码分析书("格物致知"),源码树 = jdk11u(`/data/workspace/jdk11u/src/hotspot/`)。

**当前正在做**: 卷 2(按 48 域规划写源码文章),每篇严格按方法论: 读大纲 → **所有行号重新 grep 验证** → 写 → 代码块与源码逐字核对 → 深审 → 提交。

**下一步(唯一,无选择)**: 04-logging/02(output-and-configuration)→ 04 域完结 → 06-oops(第 2 批)。

**铁律**: ① 一篇一篇写,写完自查+深审合格再下一篇;② 大纲/KP 的行号是"线索不是事实",写作时必须重 grep——**实测每篇大纲有 2-8 处机制错误或行号漂移**;③ 代码块贴真实源码(截取可,编造不可)——**凭记忆写值必错**;④ 每篇写完整理后做深审。

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
**旧交接文档**(本次会话起点,可参考历史): `/data/workspace/source-code/book/成长之路/tmp-question/training-camp/source-code/analysis/source-analysis/HANDOFF.md`(会话最初读的那份)

---

## 二、卷 2 写作进度(精确到篇)

**写作顺序依据**: `docs/openjdk/planning/knowledge-planning/00-domain-writing-order.md`(48 域依赖拓扑 7 层,脚本验证自洽)

```
第 1 批(地基): 01(4 篇) → 05(2 篇) → 45(2 篇) → 48(4 篇)         ✅ 全部完成(12/12)
第 2 批(原语): 02(4 篇) → 03(2 篇) → 04(2 篇) → 06(6 篇) → 16(5 篇) → 38(2 篇) → 41(2 篇) → 42(3 篇)   🚧 进行中(7/26,04 域剩 1 篇)
第 3 批(对象/类): 07 → 09 → 17
第 4 批(执行/帧): 10 → 19 → 23 → 24 → 08 → 31 → 44
第 5 批(VM 核心): 11 → 12 → 13 → 18 → 20 → 27 → 30 → 32 → 34 → 36 → 37 → 39 → 46
第 6 批(JIT/GC): 14 → 15 → 21 → 25 → 28 → 29 → 33 → 43
第 7 批(上层): 22 → 26 → 35 → 40 → 47
```

**已完成 19 篇**(全部在 `docs/openjdk/vol-02/`):

| 域 | 篇 | 文件 | 状态 |
|---|---|---|---|
| 01-os | 1-4 | `01-os/01-platform-detection.md` 等 4 篇 | ✅ 旧会话完成,本会话抽查修正 2 处(见 §六) |
| 05-cpu-primitives | 1-2 | `05-cpu-primitives/01-atomic-and-memory-order.md` 等 2 篇 | ✅ 旧会话完成,本会话抽查修正 2 处(见 §六) |
| 45-math-library | 1 | `45-math-library/01-poly-approximation.md`(315 行) | ✅ 本会话完成+深审 2 轮 |
| 45-math-library | 2 | `45-math-library/02-stubroutine-native.md`(249 行) | ✅ 本会话完成+深审 2 轮 — **45 域完结** |
| 48-utilities | 1 | `48-utilities/01-vmerror.md`(146 行) | ✅ 本会话完成+深审 |
| 48-utilities | 2 | `48-utilities/02-concurrent-bitmap.md`(228 行) | ✅ 本会话完成+深审 |
| 48-utilities | 3 | `48-utilities/03-stream-exception.md`(150 行) | ✅ 本会话完成+深审 |
| 48-utilities | 4 | `48-utilities/04-utf8-json-decoder.md`(118 行) | ✅ 本会话完成 — **48 域完结,第 1 批全部完成** |
| 02-assembler | 1 | `02-assembler/01-codebuffer-abstract-assembler.md`(214 行) | ✅ 本会话完成+深审 |
| 02-assembler | 2 | `02-assembler/02-x86-register-operand-encoding.md`(219 行) | ✅ 本会话完成+深审 |
| 02-assembler | 3 | `02-assembler/03-x86-assembler-instruction-set.md`(185 行) | ✅ 本会话完成+深审 |
| 02-assembler | 4 | `02-assembler/04-x86-macroassembler-runtime.md`(164 行) | ✅ 本会话完成+深审 — **02 域完结** |
| 03-arguments-flags | 1 | `03-arguments-flags/01-flag-definition-system.md`(179 行) | ✅ 本会话完成+深审 |
| 03-arguments-flags | 2 | `03-arguments-flags/02-flag-processing-and-management.md`(159 行) | ✅ 本会话完成+深审 — **03 域完结** |
| 04-logging | 1 | `04-logging/01-tag-and-selection.md`(183 行) | ✅ 本会话完成+深审 |
| 04-logging | 2 | `04-logging/02-output-and-configuration.md` | 🚧 **下一步** |

**每篇 commit 号**: 以 git log 为准(最近: 04域01=56de984/9bf0811/a959b38;03域02=7468c41/d9d44fb/df9f3f8;02域04=a702145/70352ea/385e44f)

**已回填的大纲**(写作中发现漂移即回填,防下次抄错): 45/48/02/03/04 各域 outlines 均已按真实源码重写并标 ⚠️ 写作期修正;KP(45/48)同步修正。

---

## 三、每篇写作流程(严格执行,不可省略)

```
1. 读大纲: planning/outlines/<NN>-<域>/<NN>-<篇>.md
2. 读 KP: planning/knowledge-planning/<NN>-<域>.md(若大纲信息不足)
3. 【铁律】验证大纲里所有 file:line —— 逐个 grep/sed 核对,发现漂移用真实行号
   —— 实测: 大纲几乎每篇都有 2-8 处错误/漂移,绝不可照抄
4. 写正文到 vol-02/<NN>-<域>/<NN>-<篇>.md
5. 自查:
   - 代码块与源码逐字核对(脚本 diff,sed 对比;省略行必须用 "..." 占位)
   - 五维检查表(见 §四)
   - 工具实证引用必须真实存在(materials/ 里 grep 到才引用)
6. git add + commit + push(信息: 域/篇/深审修正清单;中文)
7. 更新 vol-02/README.md 勾选进度(单独 commit)
```

**深审流程**(用户每篇都会要求,写完后主动做,不要等):
```
1. 按深审缺陷档案 15 类逐类检查(见 §四)
2. 重点: ① 写作时"凭记忆"写的任何值/行号/机制描述——回源码核对
       ② 正文引用的 file:line 内容语义(不是存在性)
       ③ 数字自洽(全文 grep 关键数字)
       ④ #7 文字锚(文件名后无行号的引用)
       ⑤ **跨篇一致性**: 每篇末尾悬念 OUTBOUND 行的描述文字常残留旧大纲错误
          (实证: 48 域 3 篇的悬念行残留 per-bucket mutex/gclog/JSONWriter,正文深审后没同步)
          ——深审正文后必须回头核对悬念行
       ⑥ 交接文档/元文档也要自查(本次就发现 7/10→7/26 的篇数错误)
3. 发现错误 → 修正文章 → 回填大纲(#15 规则,防止下次抄错)→ 提交
```

---

## 四、方法论体系(写作规范全集)

### 4.1 WRITING-GUIDELINES.md(`docs/openjdk/WRITING-GUIDELINES.md`,10 条)
1. 去 AI 味(写的是书,不是文档;无模板标题/无✅❌符号——注意 README 可用 ✅,正文不可)
2. **依赖驱动排序(A 依赖 B,先写 B)** ← 48 域拓扑的依据
3. 从问题开始(先"为什么"再"是什么")
4. 禁止前向引用("后面会讲"=结构错了)
5. 构造/运行时严格分离
6. 一个概念改三轮讲不通 → 删除
7. 说人话(先人话再源码术语)
8. **每句陈述有源码依据** + 书稿代码块纪律(见 4.3)
9. 画流程图(时间线/数据流)

### 4.2 v5 文章格式(每篇固定结构)
- 头部: `# NN. 标题 — 问题句` + `> **前置依赖**`(链接前文)+ `> → **后续**`(链接下一篇)+ `> 关联域`
- 开篇: 场景句(为什么问这个问题)
- 每机制段落四要素: 场景 → 技术描述(file:line+函数名) → **关键设计 (斜体)**(why)→ 跨层标注([C++:] [x86:] [man N xxx])
- 结尾: `## 核心悬念`(一段话总结本篇+桥到下一篇)+ `> → [下一篇](...)`
- 代码块: 首行标注 `// file.cpp:start-end(截取核心/注释/逐字)`
- 跨篇引用用 `[域 NN 篇 X — 标题](openjdk/vol-02/NN-域/0X-*.md)` 相对路径

### 4.3 书稿代码块纪律(血泪总结,每篇深审都靠它抓错)
1. **代码块 = 真实源码**: 截取可(省略模板/错误处理,用 "..." 占位),核心语句逐字,**禁止凭记忆写值/编码/常量**
2. **行号写作时重新 grep**: 大纲/KP 是规划期产物,行号大量漂移——每篇实测都有 2-8 处漂移
3. **自查命令**: 文章每个 file:line 逐个 `sed -n`;代码块与源码 diff(脚本: 提取块内行逐一 grep -qF 文章)
4. **文件名必须 find 验证**: 目录/文件路径凭记忆必错(jdk11u 有重构: flags/ 子目录、share/code/ 等)
5. **大纲的"篇数"也要重验**: 规划文档的篇数可能过时(第 2 批实际 26 篇: 06-oops=6、16-code-cache=5、42-core-native=3,规划印象中的 "7/10" 是错的)——进度表述以 outlines/ 实际文件数为准

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
| 卷 T 文章 | `vol-tools/ch01-07.md` | 引用格式: "[卷 T ch05](openjdk/vol-tools/ch05.md)" |

**引用纪律**: 工具实证必须真实存在——引用前 grep materials/ 验证。

---

## 六、本次会话实战经验(最重要,新 AI 必读)

### 6.1 大纲漂移的规律(19 篇全部出现,2-8 处/篇)
**任何机制描述/行号/值,一律当"线索"而非"事实"**。高频漂移类型:
1. **机制编造**(最严重): 大纲把"想当然的实现"写成机制——实证全部是编造:
   - 02-01: "delayed_nop" 编造(实际是 Label 长格式预发+add_patch_at 回填;delayed 类机制是 DelayedConstant@assembler.cpp:205)
   - 02-02: "XMM 16 个" 实为 32 个(jdk11u 支持 AVX-512);"VMReg 负数=栈槽" 实为 stack0 正数
   - 03-01: "PRODUCT_FLAG 宏" 编造(实际 RUNTIME_FLAGS 14 参巨型宏);"Origin 5 级" 实为 9 级;"GLOBALS_EXTENSION" 实为三宏集合
   - 04-01: "标签树/父指针/前缀 walk" 编造(实际扁平枚举+子集匹配);"LogLevel Trace=0" 顺序反了(Off=0)
   - 48-02: "per-bucket mutex" 实为指针低 2 位嵌入 spinlock;"双重哈希" 不存在
   - 48-03: "gclog_or_tty" jdk11u 不存在;"debug_check_abort=消息框" 实为 AbortVMOnException 匹配
2. **版本漂移**: 大纲写的是 JDK 8/其他版本的机制:
   - safepoint_poll: 全局轮询页 → jdk11u 是 thread-local poll(testb thread 偏移的 poll 位)
   - Math intrinsic: "fsin/fcos" → 64 位是 SSE2 软件多项式(45-01 已证)
   - 堆自适应: RAMFraction → 已废弃,jdk11u 用 RAMPercentage(gc_globals.hpp)
3. **行号漂移**: 大纲行号与实际差几十到几百行(规划期 2026-08-08 的产物)
4. **文件名漂移**: jvmFlag 在 share/runtime/flags/(重构);writeableFlags 在 share/services/

### 6.2 写作期"凭记忆"错误(自查 diff 抓出的真实案例,每篇深审必有)
- 02-02: REX_WRB 写成 0x4F(实际 0x4D,assembler_x86.hpp:537)
- 02-03: addsd 的 VEX 编码写成 66 前缀(实际 F2,simd_prefix_and_encode(dst,dst,src,VEX_SIMD_F2,...))
- 03-02: JAVA_OPTS(实际 _JAVA_OPTIONS,arguments.cpp:3317);set_aggressive_opts_flags 语义(GC 互斥→实际是 AggressiveOpts 联动 EliminateAutoBox/DoEscapeAnalysis 等)
- 04-01: 标签数 "~100"(实际 143)
- **教训**: 凡代码块里的值/编码/常量,写完必须用 sed 逐行对照;数字先数后写

### 6.3 平台/环境事实(写作时已确认)
- **jdk11u 源码树只含 x86 平台**(cpu/ 只有 x86,os/ 只有 linux/posix)——不要断言其他平台的实现细节(ARM 等无法验证,写了就是编造)
- jdk11u 关键位置: flags/ 在 share/runtime/flags/;vmreg.hpp 在 share/code/;os.hpp/os.cpp 在 share/runtime/;assembler 在 share/asm/ + cpu/x86/
- 常用实证: CodeEntryAlignment=32(globals_x86.hpp:49)、UseLibmIntrinsic 默认 true(globals_x86.hpp:217)、ErrorLogTimeout=2*60(globals.hpp:636)

### 6.4 已完成的交叉引用关系(写作时保持一致性)
- 45-01(fast_sin)→ 45-02(CodeBuffer/生成管道)→ 48-01(vmError,含 StubCodeDesc 名字链)→ 48-02(并发表/位图)→ 48-03(输出流/异常)→ 48-04(三种格式)
- 02-01(CodeBuffer/Label)→ 02-02(编码)→ 02-03(指令)→ 02-04(MacroAssembler 运行时)→ 03-01(flag 定义)→ 03-02(flag 生命周期)→ 04-01(日志标签)→ 04-02(输出配置)→ 06-oops
- 前文引用: 05-cpu-01(原子/屏障)、05-cpu-02(JavaFrameAnchor)、01-os-04(信号/safepoint)

---

## 七、用户偏好与纪律(重要,违背会被批评)

1. **严格按规划,不做多余选择**: 拓扑定了顺序就逐项推进——不要问"还是写 X?"(曾因制造选择被批评)
2. **每篇都做深度 REVIEW**: 用户会要求"按照方法论深度的 REVIEW",写完后**主动自查深审**,不要等
3. **一篇一篇写**: 不并行、不跳步
4. **数字/事实必须验证**: 任何带数字的陈述回源码/素材验证,禁止"凭记忆"
5. **命名混淆注意**: "域 01"与"05 域的第 01 篇"都带 01,表述时写清"域 XX 第 Y 篇"
6. 中文交流,提交信息用中文
7. 用户会追问"下一步规划是否合理"——要有自己的判断(如: 先抽查旧会话 01/05 篇再进第 2 批,用户采纳了)

---

## 八、待办清单(按优先级)

- [ ] **04-logging/02**(output-and-configuration)——大纲在 `planning/outlines/04-logging/02-output-and-configuration.md`,04 域收尾
- [ ] **06-oops**(第 2 批第 4 域,对象模型——05-cpu/02 的悬念桥接指向它)
- [ ] 第 2 批剩余: 16-codecache → 38-perfdata → 41-zipjimage → 42-core-native
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
| 每域大纲 | `docs/openjdk/planning/outlines/<NN>-<域>/` |
| 写作指南 | `docs/openjdk/WRITING-GUIDELINES.md` |
| 深审缺陷档案 | `/data/workspace/source-code/book/成长之路/tmp-question/training-camp/source-code/issue/源码分析深审缺陷档案.md`(15 类) |
| 卷 2 进度 | `docs/openjdk/vol-02/README.md` |
| 源码树(jdk11u) | `/data/workspace/jdk11u/src/hotspot/`(仅 x86+linux!) |
| 工具素材 | `docs/openjdk/planning/outlines/00-jvm-tools/materials/` |
| JDK 工具 | `/opt/codev/TencentKona/bin/`(17.0.8.1) |
| GUI 手册 | `docs/openjdk/planning/outlines/00-jvm-tools/GUI-manual.md` |
| 常用验证命令 | `sed -n 'start,endp' 文件`;`grep -n "函数名" 文件`;`find /data/workspace/jdk11u/src/hotspot -name "文件"`;块 diff 脚本: `sed -n 's,ep' f \| sed 's/^[0-9]*: *//' \| while read l; do grep -qF "$l" 文章 \|\| echo MISS; done` |

---

## 十、下一步(读完立即做)

```
1. 读 planning/outlines/04-logging/02-output-and-configuration.md(大纲)
2. 验证大纲所有 file:line(按 §六 的漂移规律,重点: 输出目标/文件轮转机制是否编造)
3. 按第三节流程写第一篇 → 自查 → 深审 → 回填大纲 → 提交 → 更新 README
4. 04 域完结后 → 06-oops
```

**环境**: Linux 容器,无显示器(GUI 截图等用户在 Ubuntu 补);jdk11u 源码在本地;git 推送即部署(docsify 站点)。
