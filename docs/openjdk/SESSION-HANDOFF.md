# SESSION-HANDOFF — 主交接文档(唯一入口,非常详细版)

> **状态**: 2026-08-13 | 卷 2 写作中: **67/152 篇完成**(第 1 批 12 + 第 2 批 26 + 第 3 批 14 + 第 4 批 15: 12/19 域完结,**23/24 域完结**) | **上下文已满,本文件为非常详细交接版**——新 AI 只读本文件即可继续,不要依赖旧会话记忆
> **接收者: 新 AI —— 只读本文件,按"十、下一步"执行**

---

## 〇、三十秒总览(先读这个)

**项目**: 写一本 OpenJDK 源码分析书("格物致知"),源码树 = jdk11u(`/data/workspace/jdk11u/src/hotspot/`)。

**当前正在做**: 卷 2(按 48 域规划写源码文章),每篇严格按方法论: 读大纲 → **所有行号重新 grep 验证** → 写 → 代码块与源码逐字核对 → **深审 2 轮(用户常追加要求再 REVIEW)** → 回填大纲 → 提交。

**下一步(唯一,无选择)**: 08-interpreter/03(InterpreterRuntime——解释器调 C++ 的入口,大纲 `planning/outlines/08-interpreter/03-interpreter-runtime.md`,08 域共 4 篇: 01 ✅/02 ✅/03-interpreter-runtime/04-linkresolver-rewriter)。

**铁律**: ① 一篇一篇写,写完自查+深审 2 轮合格再下一篇;② 大纲/KP 的行号与机制描述是"线索不是事实",写作时必须重 grep——**实测每篇大纲有 2-15 处机制错误或行号漂移,65 篇无一例外**;③ 代码块贴真实源码(截取可,编造不可)——凭记忆写值必错;④ 每篇写完整理后做深审,**必须 2 轮**(第 1 轮自查+通读,第 2 轮逐机制回源码质疑——第 2 轮才能抓到"顺理成章"的机制错误);⑤ 发现错误→修正文章→**回填大纲 ⚠️ 块**(防下次抄错)→提交;⑥ **REVIEW 时正文与大纲的行号要一起过**(07-04 REVIEW 时发现大纲 ⚠️ 块行号也带着同样的偏差);⑦ 脚本语法错误要立即发现——一次 commit 曾因 `;` 链把未应用的修改提交了(07-03 REVIEW 教训);⑧ **用户会追问"是不是 Kona 的问题"——实证 JDK 与源码版本要匹配,已下载 Temurin OpenJDK 11.0.32(见 §九)**

---

## 一、项目全貌

| 卷 | 位置 | 状态 |
|---|---|---|
| 卷 0 地基 | `docs/openjdk/vol-00/`(4 章) | ✅ 旧会话完成,不动 |
| 卷 T 工具观测 | `docs/openjdk/vol-tools/`(ch01.md~ch07.md 共 7 篇) | ✅ 旧会话完成,写作时引用其素材做实证 |
| 卷 1-bak 启动 | `docs/openjdk/vol-01-bak/`(14 章) | ✅ 归档,不沿用 |
| **卷 2 运行时深处** | `docs/openjdk/vol-02/` | 🚧 **当前任务**,按 48 域依赖拓扑写 |
| 域规划 | `docs/openjdk/planning/` | 48 域权威清单(00-domain-discovery-v3.md)+ 每域 KP(knowledge-planning/0X-*.md)+ 每域大纲(outlines/0X-*/) |
| 工具素材库 | `docs/openjdk/planning/outlines/00-jvm-tools/materials/` | ✅ 命令输出/截图/JFR 录制(gitignore,不入库) |
| 本交接文档 | `docs/openjdk/SESSION-HANDOFF.md` | 本文件 |

**git 仓库**: `/data/workspace/source-code/openjdk-book/`(remote: git@github.com:LoveEleve/openjdk-book.git,main 分支,每篇一提交一推送)
**JDK 工具**: `/opt/codev/TencentKona/bin/`(17.0.8.1,通用实证)与 **`/data/tmp/opencode/jdk11`(Temurin OpenJDK 11.0.32,与 jdk11u 源码同版本——实证首选!)**
**旧交接文档**(更早会话起点,可参考历史): `/data/workspace/source-code/book/成长之路/tmp-question/training-camp/source-code/analysis/source-analysis/HANDOFF.md`

---

## 二、卷 2 写作进度(精确到篇)

**写作顺序依据**: `docs/openjdk/planning/knowledge-planning/00-domain-writing-order.md`(48 域依赖拓扑 7 层,脚本验证自洽)

```
第 1 批(地基): 01(4 篇) → 05(2 篇) → 45(2 篇) → 48(4 篇)         ✅ 全部完成(12/12)
第 2 批(原语): 02(4 篇) → 03(2 篇) → 04(2 篇) → 06(6 篇) → 16(5 篇) → 38(2 篇) → 41(2 篇) → 42(3 篇)   ✅ 全部完成(26/26)
第 3 批(对象/类): 07(7/7) → 09(3/3) → 17(4/4)   ✅ 第 3 批完结(14 篇)
第 4 批(执行/帧): 10(3/3) → 19(4/4) → **23(3/3)** → **24(3/3)** → **08(2/4)** → 31 → 44   🚧 进行中
第 5 批(VM 核心): 11 → 12 → 13 → 18 → 20 → 27 → 30 → 32 → 34 → 36 → 37 → 39 → 46
第 6 批(JIT/GC): 14 → 15 → 21 → 25 → 28 → 29 → 33 → 43
第 7 批(上层): 22 → 26 → 35 → 40 → 47
```

**已完成 67 篇**(全部在 `docs/openjdk/vol-02/`,第 1 批 12 + 第 2 批 26 + 第 3 批 14 + 第 4 批 15):

| 域 | 篇 | 文件 | 状态 |
|---|---|---|---|
| 01-os | 1-4 | `01-os/` 4 篇 | ✅ 旧会话完成 |
| 05-cpu-primitives | 1-2 | `05-cpu-primitives/` 2 篇 | ✅ 旧会话完成 |
| 45-math-library | 1-2 | `45-math-library/` 2 篇 | ✅ 45 域完结 |
| 48-utilities | 1-4 | `48-utilities/` 4 篇 | ✅ 48 域完结 |
| 02-assembler | 1-4 | `02-assembler/` 4 篇 | ✅ 02 域完结 |
| 03-arguments-flags | 1-2 | `03-arguments-flags/` 2 篇 | ✅ 03 域完结 |
| 04-logging | 1-2 | `04-logging/` 2 篇 | ✅ 04 域完结 |
| 06-oops | 1-6 | `06-oops/01`~`06` | ✅ 06 域完结 |
| 16-codecache | 1-5 | `16-code-cache/` 5 篇 | ✅ 16 域完结 |
| 38-perfdata | 1-2 | `38-perfdata/` 2 篇 | ✅ 38 域完结 |
| 41-zip-jimage | 1-2 | `41-zip-jimage/` 2 篇 | ✅ 41 域完结 |
| 42-core-native | 1-3 | `42-core-native/01-jni-system.md`(129)/02-process.md(264)/03-class-io.md(228) | ✅ 42 域完结 |
| 07-classfile-classloader | 1-7 | `07-classfile-classloader/01`~`07` | ✅ 07 域完结 |
| 09-memory-core | 1-3 | `09-memory-core/01`(214)/02(237)/03(147) | ✅ 09 域完结 |
| 17-threads | 1-4 | `17-threads/01`(191)/02(192)/03(165)/04(188) | ✅ 17 域完结 |
| 10-metaspace | 1-3 | `10-metaspace/01`(101)/02(142)/03(104) | ✅ 10 域完结 |
| 19-sync | 1-4 | `19-sync/01`(157)/02(107)/03(179)/04(113) | ✅ 19 域完结 |
| **23-stub** | 1-3 | `23-stub/01-stub-entry.md`(128)/02-arraycopy.md(313)/03-crypto-math.md(306) | ✅ **23 域完结(本会话)** |
| **24-frame** | 1-3 | `24-frame/01-physical-frame.md`(238)/02-virtual-frame.md(151)/03-deopt-gc-scan.md(268) | ✅ **24 域完结(本会话)** |
| **08-interpreter** | 1-4 | `08-interpreter/01-bytecodes-definition.md`(308)/02-template-interpreter.md(330) | 🚧 08 域 2/4(本会话) |

### 本会话 6 篇的 commit 清单(23-stub/02 起,按 git log 为准)

**23-stub/02(arraycopy 向量化)**: 正文 10d3239 → 大纲回填 b70cd1a(⚠️ 11 条)→ README 2e1c7cc → HANDOFF 42877ad+d62dea1 → **第 3 轮 REVIEW** df53a53(oop 拷贝宽度 64B 修正/ignored 行号 1456/正文块头行号对齐/uninit if 守卫/窄宽入口/开篇软化/61 篇同步)→ 大纲回填 3b31e38
**23-stub/03(Crypto+Math)**: 正文 235140b → 大纲回填 6f584f3(⚠️ 10 条)→ README c1b8c07 → HANDOFF fda8aec(§6.17,62/152,23 域完结)→ 下一步 24-frame/01
**24-frame/01(Physical Frame)**: 正文 4fd580d → 大纲回填 0002994(⚠️ 10 条)→ README 894d505 → HANDOFF ea6afe5(§6.18,63/152)→ 下一步 24-frame/02
**24-frame/02(Virtual Frame)**: 正文 1632ba5 → 大纲回填 ba87c0e(⚠️ 6 条)→ README+HANDOFF a5eb4dd(64/152)→ §6.19 4e6296c → **第 3 轮 REVIEW** 2fb8f8e(实证 v2 升级 Temurin 11 三路径,消费者双路径修正)+大纲回填 79f5df2+HANDOFF 33031a2 → **第 4 轮 REVIEW** 1aed4ab(锚点 pc=轮询点机制闭环)+大纲回填 f1ce672
**24-frame/03(Deopt+GC)**: 正文 8850989 → 大纲回填 6ae67c0(⚠️ 9 条)→ README+HANDOFF 6faefe1(65/152,24 域完结)→ §6.20 32bebc8 → **第 3 轮 REVIEW** cb8dd16(帧失效=deopt_dependents safepoint 全量拆,非"走到栈顶")+大纲回填 52a1e4c+HANDOFF 32e9a39
**08-interpreter/01(Bytecodes 定义表)**: 正文 b34880a → 大纲回填 05d5c11(⚠️ 11 条)→ README 4ee15e1(66/152,08 域 1/4)→ 下一步 08-interpreter/02
**08-interpreter/02(Template Interpreter)**: 正文 9c80ab1(含 01 篇 0xCB-0xFF 修正)→ 大纲回填 e6c2f3e(⚠️ 11 条)→ README b6e7dbf(67/152,08 域 2/4)→ 下一步 08-interpreter/03

**本会话新增素材(全部 gitignore 不入库,在 materials/commands/)**:
- `23-arraycopy-bench.txt`(UseAVX 0/2/3 各档 arraycopy/fill 吞吐 + PrintFlagsFinal 附注: UseFastStosb=false/UseXMMForObjInit=true)
- `23-crypto-bench.txt`(SHA-256 5.9x/AES-CBC 3.0x/CRC32 14.4x/SHA-512 1.9x/exp 1.7x,开关对比)
- `24-frame-demo.txt`(jstack 两行 at/codelist 双版本 nmethod/三 CodeHeap 1098 blobs/PrintInterpreter 271 codelets)
- `24-inline-demo.txt` **v2**(Temurin 11: 编译日志 qux inline 7 次 + SIGQUIT 转储/jcmd/JFR 三路径都只有 main + 对照 NoInlineDemo 4 层)
- `24-deopt-demo.txt`(PrintCompilation: total C1+C2→传 Circle→made not entrant×2→OSR→重编译)
- `08-bytecodes-javap.txt`(BcDemo 六方法 javap -c: 76 条固定长指令与 def 表全对/lookupswitch 对齐 1→44/invokedynamic 5 字节)
- `08-interpreter-templates.txt`(PrintInterpreter: 271 codelets avg 404B/iload 192 vs iload_0 96/iconst 7×96B/iadd 64B/ldc 736B/invokevirtual 1280B)

**已回填的大纲 ⚠️ 块**(写作期修正,防下次抄错): 45/48/02/03/04/06/16/38/41/42/07/09/17/10/19 + 本会话 **23-01(6 条)/23-02(11 条+第 3 轮 4 条)/23-03(10 条)/24-01(10 条)/24-02(6 条+第 3 轮+第 4 轮)/24-03(9 条+第 3 轮)**。

---

## 三、每篇写作流程(严格执行,不可省略)

```
1. 读大纲: planning/outlines/<NN>-<域>/<NN>-<篇>.md(注意 ⚠️ 写作期修正块)
2. 读 KP: planning/knowledge-planning/<NN>-<域>.md(若大纲信息不足)
3. 【铁律】验证大纲里所有 file:line 与"专有名词存在性"——逐个 grep/sed 核对,发现漂移用真实行号
   —— 实测: 大纲几乎每篇都有 2-15 处错误/漂移,绝不可照抄;行号对了名字也可能是假的
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
- 代码块: 首行标注 `// file.cpp:start-end(截取核心,逐字)`;标注范围必须与内容精确对应(含闭合括号行)
- 跨篇引用用相对/`openjdk/vol-02/...` 路径;**链接文本必须与目标文章标题一致**(已抓过 3 处不一致)

### 4.3 书稿代码块纪律(血泪总结,每篇深审都靠它抓错)
1. **代码块 = 真实源码**: 截取可(省略模板/错误处理,用 "..." 占位),核心语句逐字,**禁止凭记忆写值/编码/常量/注释**
2. **行号写作时重新 grep**: 大纲/KP 是规划期产物,行号大量漂移——每篇实测都有 2-15 处漂移;07-04 教训: 写正文时 sed 目测的行号也可能偏 10 行;24-03 教训: **代码块范围必须与块体逐行对齐(用自动对齐脚本核对首末行),凭 sed 目测必错**(24-03 首轮 7 块错 5 块)
3. **自查脚本**(/data/tmp/opencode/check.py): 文章每个 file:line 逐个核对;代码块与源码逐行 diff("..." 跳过);新文件先加 MAPPINGS(JDK 侧)/HS_MAP(hotspot 侧,单行 dict,追加时注意逗号)
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
| 命令输出 | `materials/commands/` 130+ 文件 | jcmd/jstat/jmap 等真实输出 |
| 卷 T 文章 | `vol-tools/ch01.md`~`ch07.md` | 引用格式: "[卷 T ch02](openjdk/vol-tools/ch02.md)" |

**本会话新增素材**(全部现场跑,部分用 Temurin 11,详见 §二 commit 清单):
- `23-arraycopy-bench.txt` / `23-crypto-bench.txt` / `24-frame-demo.txt` / `24-inline-demo.txt`(v2,Temurin 11 三路径)/ `24-deopt-demo.txt` / `08-bytecodes-javap.txt` / `08-interpreter-templates.txt`

**引用纪律**: 工具实证必须真实存在——引用前 grep materials/ 验证;素材缺失的实证不要引用,改为布局推导。

---

## 六、本会话实战经验(最重要,新 AI 必读)

### 6.1 大纲漂移的规律(67 篇全部出现,2-15 处/篇;02/03/04/45/48 域案例为更早会话沉淀,06/16/38/41/42/07/09/17/10/19/23/24/08 域为本会话沉淀)
**任何机制描述/行号/值/专有名词,一律当"线索"而非"事实"**。高频漂移类型:
1. **机制编造**(最严重): 大纲把"想当然的实现"写成机制——实证全部是编造(案例见各域经验)
2. **版本漂移**: 大纲写的是 JDK 8/其他版本的机制
3. **行号漂移**: 大纲行号与实际差几十到几百行;07-04 教训: 写作时 sed 目测的行号也可能偏 10 行
4. **文件名漂移**: 目录/文件路径凭记忆必错
5. **"声明有、实现无"**: 入口表里挂名的 ≠ 有实现/汇编(23-02 zero_aligned_words=C++ 遗留;23-03 _dlibm_*_huge 仅 x86_32、montgomery=C++ 函数;24-02 nativeVFrame 不存在)

### 6.2 写作期"凭记忆"错误(自查 diff 抓出的真实案例,每篇深审必有)
- 07-01: "oops 在前"方向反了;07-03: 数组头"4+3 字节"错(16+3);07-05: "BuiltinClassLoader.java:54 防护注释"错(:54 是 import);07-06: "模块表全局注册"错(per-loader)
- 23-02: "引用数组一次只能拷 8 字节"错(压缩 oop 下同样 64B/迭代向量循环);"ignored 注释行号 1462-1463"错(1456/1563)
- 24-02: "jstack 是 vframeStream 消费者"断言错(线程转储走 vframe::sender 链);"停在最近转换点"不精确(=循环回边安全点轮询点)
- 24-03: T_CONFLICT 语义编造(真实="A dead local"死槽);"帧走到栈顶才 deopt"错(safepoint 全量拆)
- **教训**: 凡代码块里的值/编码/常量/注释,写完必须用 sed 逐行对照;数字先数后写;推导段("所以/为什么能")必须回源码找依据;REVIEW 时正文与大纲 ⚠️ 块行号一起过

### 6.3 平台/环境事实(写作时已确认)
- **jdk11u 源码树只含 x86 平台**(cpu/ 只有 x86,os/ 只有 linux/posix)——不要断言其他平台的实现细节
- 23 域关键位置: stubGenerator_x86_64.cpp(6138 行,generate_all :5971,arraycopy :2866,AES :3016+,SHA :3692+,CRC :5185+,BigInteger :5297+,Math :5497+);stubRoutines.hpp 入口表 :126-167;macroAssembler_x86_sha/exp/aes/*.cpp 是算法主体
- 24 域关键位置: frame.hpp:50-65(共享字段)/frame_x86.hpp:110-120(_fp/_unextended_sp)/frame_x86.cpp(sender 三路 :488-503)/vframe.hpp(:54 基类/:268 vframeStreamCommon)/vframe_hp.hpp(:30 compiledVFrame)/vframe.inline.hpp(next :41)/vframeArray.hpp(:121)/deoptimization.cpp(fetch_unroll_info :139/unpack_frames :623)
- 常用实证: **Temurin OpenJDK 11.0.32 在 /data/tmp/opencode/jdk11**(与 jdk11u 同版本,实证首选);Temurin 17 在 /data/tmp/opencode/jdk17;TencentKona 17/21 在 /opt/codev/(通用)

### 6.4 已完成的交叉引用关系(写作时保持一致性)
- 45→48;02→03→04;06 域链 → 07 域链 → 09 → 17 → 10 → 19 → **23 域链(23-01 桩骨架 → 23-02 arraycopy → 23-03 crypto/math)→ 24 域链(24-01 物理帧 → 24-02 虚拟帧 → 24-03 deopt/GC)→ 08-interpreter**
- 24 域跨篇: 24-01 的 frame 五字段/sender 链/unextended_sp 是 24-02/24-03 的地基;24-02 的 ScopeDesc/vframeStream 是 24-03 的原料;24-03 的 deopt 入口模板(deopt_reexecute_entry/continue_after_entry)是 08 域的解释器模板;19-sync 的 BasicLock 在 24-03 MonitorChunk 迁移
- 跨域: 17-02 的 safepoint_poll(循环回边轮询)解释 24-02 的锚点 pc;16-01 的 CodeHeap 是 24-01 find_blob 的载体

### 6.5 06-oops 域新增经验(2026-08-12)——略(已完结域,详见前版 HANDOFF git 历史)
### 6.6 错误根因(为什么"每篇 2-15 处"不可避免)
1. 大纲是规划期 AI 生成,"像真的"的编造是最危险形态——名字合理、机制自洽,唯独源码里不存在
2. 写作期大脑默认路径: 大纲说法"合理"→直接写,而不是"每个机制先 grep 再写"(铁律 ② 的对抗者)
3. 自查脚本只能抓"写错"(行号/代码块/数字),抓不了"写对但机制是编的"——机制正确性只能靠人工深审,且第 1 轮常被自己的叙述带着走,第 2 轮逐条质疑才有效
4. 结论: **深审必须 2 轮(用户常追加第 3/4 轮)**;沉淀要即时(本篇教训进 §6.1/6.2 后再写下一篇)

### 6.7-6.15 16-codecache/38-perfdata/41+42/07/09/17/10/19 域经验——略(已完结域,详见前版 HANDOFF git 历史)
(23-01 在第 6.15: 两阶段桩/atomic 8 桩/throw 帧布局/第 3 轮 REVIEW: should_not_reach_here/generate_all 内容/initialize1 时序注释)

### 6.16 23-02(Arraycopy 向量化,大纲 11 处漂移含 5 处机制编造,2026-08-13)
- **"14 种变体/16 入口" 错**: 入口=stubRoutines.hpp:126-167 三组: conjoint 6(:128-132)+disjoint 6(:133-137)+**arrayof 12 别名(大纲没提;aligned 参数 "ignored" stubGenerator_x86_64.cpp:1456,conjoint :1563;全部别名 :2945-2962)**+可选 3(checkcast×2/unsafe/generic :154-157);8 个生成函数=4 宽×2 向(:1473/:1576/:1676/:1792/:1884/:1980/:2081/:2177),入口 generate_arraycopy_stubs :2866
- **"generate_disjoint_copy/generate_conjoint_copy" 不存在**(编造): 按宽度拆 8 个;conjoint=array_overlap_test(:1173-1191,to<=from 或 to>=end 跳 disjoint)+跳入 disjoint 内部 entry(先生成 disjoint 存 entry :2875-2878),重叠走 copy_bytes_backward(:1354-1451 同套向量化)
- **"rep_movsb/ERMSB 分级" 全错**(编造): **jdk11u x86 无 rep_movsb**(grep 零命中);真实=生成期 UseAVX 定档(CPUID 探测+SEGV 测试 YMM/ZMM 恢复 vm_version_x86.cpp:363-368;UseAVX 默认 3 globals_x86.hpp:121): evmovdqul 512 位 64B→vmovdqu×2 64B→movdqu×4 64B→movq×4 32B;**唯一运行时分支=AVX3Threshold=4096**(globals_x86.hpp:224,copy_bytes_forward :1255-1283);负计数技巧 :1506-1509([end+count*8-56] 寻址);vzeroupper :1550/vpxor 清 YMM :1319-1323
- **"fill 用 rep_stosb" 错**: fill 桩(generate_fill :1756→MacroAssembler::generate_fill macroAssembler_x86.cpp:7447,广播 dword :7469-7482,<8B 逐元素 :7484)纯向量(vpbroadcastd+evmovdqul/vmovdqu,AVX3Threshold 门控 :7554-7576);**rep_stosb(UseFastStosb,ERMS 自动开 vm_version_x86.cpp:1471-1479)属 C2 ClearArray 对象清零**(x86_64.ad:11257→clear_mem macroAssembler_x86.cpp:6012-6020)
- **"_zero_aligned_words 是汇编桩" 错**: =C++ Copy::zero_to_words(stubRoutines.cpp:110),生成器从不覆盖,全树无调用者——**声明 ≠ 有实现**
- **"std; rep_movsb; cld 倒序" 错**(编造): 倒序=copy_bytes_backward 同套向量循环
- JIT 分派三路(大纲未提): C2=inline_arraycopy(library_call.cpp:4743)→ArrayCopyNode→宏展开 generate_arraycopy(macroArrayCopy.cpp:278)→basictype2arraycopy(:216-244,常量偏移 src_off>=dst_off 判 disjoint)→select_arraycopy_function(stubRoutines.cpp:522,映射 boolean→jbyte :536-543/char→jshort :544-550)→**make_leaf_call(:1100 叶子调用无 safepoint)**;C1=emit_arraycopy(c1_LIRAssembler_x86.cpp:3049 类型未知→generic);**解释器=JVM_ArrayCopy(jvm.cpp:324-340)→klass()->copy_array 不用桩**
- oop 变体: barrier 包夹——prologue=SATB 预屏障(satb_mark_queue_active 检查+整段运行时调用 write_ref_array_pre_oop_entry,g1BarrierSetAssembler_x86.cpp:44;uninit 整体 if 守卫跳过 :46-48),epilogue=卡表标记(:1950);checkcast 失败返 **-1^K**(K=已拷元素,:2430-2438)
- **实证方法论教训**: ①微基准 arraycopy 会被 C2 折叠(重复拷贝只有最终状态可观测→合并为一次)——必须循环内每次校验和(每 4096 字节采样读)防消除;②ping-pong 双数组也不够;③单位坑: MB/s 当 GB/s;④数组填全程 fill 的 32M 段致迭代爆炸
- 实证(AMD EPYC 9K65,TencentKona 17,UseAVX 0/2/3): 1K arraycopy 55.0→68.3 GB/s(SSE2→AVX2 +24%),手写循环 21.2=**3.2x**;64K 78.3 vs 40.1=2.0x;4M/32M 带宽瓶颈≈1.0x;64K fill AVX2/3 137-139 vs SSE2 85.8

### 6.17 23-03(Crypto + Math Intrinsics,23 域收官,大纲 10 处漂移含 4 处机制编造,2026-08-13)
- **行号全漂移**: AES :3016-4701/SHA :3692-3890/CRC :5185-5296/BigInteger :5297-5470/Math :5497-5700(stubGenerator_x86_64.cpp 共 6138 行);大纲 1300-1700/1700-2100/2200-2700/2700-3200 全错;CRC 表不在 stubRoutines_x86_64.cpp 而在 **stubRoutines_x86.cpp**(crc_table :132、k256 :324,64B 对齐)
- **"sha256rnds2 4 rounds in 1 instruction" 错**: 一条 rnds2=**2 rounds**;16 字节块=paddd(K)+rnds2×2=4 rounds(macroAssembler_x86_sha.cpp:271-300);**SHA-256 双路径**(supports_sha→SHA-NI fast_sha256,否则 AVX2 sha256_AVX2 :507)——开关只需 sse4_1 的原因(vm_version_x86.cpp:956-960);**SHA-512 无硬件指令**纯 AVX2(断言 avx2+bmi2 :3814-3815,sha512_AVX2 :1240);MB=ofs/limit 多块循环 state 驻寄存器
- **"CRC32 纯查表" 半对**: kernel_crc32(macroAssembler_x86.cpp:9076)=查表对齐+**pclmulqdq 折叠**(fold_128bit_crc32 :9138)+尾部查表,**无 crc32 指令**;crc32 SSE4.2 指令属 **CRC32C**(crc32c_ipl_alg2_alt2 :9889,指令 :9671-9677);AVX-512 版 kernel_crc32_avx512 :9390
- **"montgomery* 是汇编桩" 错(编造)**: =C++ SharedRuntime::montgomery_multiply(sharedRuntime_x86_64.cpp:3811,32 位字),CAST_FROM_FN_PTR 登记(stubGenerator_x86_64.cpp:6111-6118)——**入口表挂名≠汇编桩,须查生成处**;另有 vectorizedMismatch :5357、base64 :4933(大纲没提);开关是 C2 flag(c2_globals.hpp:718)
- **"_dlibm_sin_cos_huge 等" 仅 x86_32 生成**(stubGenerator_x86_32.cpp:3849-3862),x86_64 恒 NULL——"声明有、实现无"又一例
- **Math 桩=Intel LIBM 2016 移植**(macroAssembler_x86_exp.cpp 头注释 "Intel Math Library (LIBM) Source Code"),7 文件(fast_exp/sin/cos/tan/log/log10/pow)全 XMM 无 x87;fast_exp: 范围检查(32767/16527/15504)+ln2 倒数取整+多项式(0x3FC55555≈1/6、0x3FA55555≈1/24)
- **AES**: keylen {44,52,60}=展开密钥长度;密钥直接复用 Java 展开结果("the java expanded key ordering is just what we need" :3044)+pshufb 小端(load_key :2988);CBC 解密并行两版(VAES+AVX512 :4317/SSE :3400,按 supports_vaes+avx512vl+dq 二选一 :6024-6030);GHASH 4×pclmulqdq(掩码 0/16/1/17)交叉 XOR :4693-4703;AVX 版 avx_ghash(macroAssembler_x86_aes.cpp:614)
- **BigInteger**: multiply_to_len(macroAssembler_x86.cpp:8123)BMI2 分派(:8218-8236): mulx+adcx/adox 双进位链 :8030-8047(adcx 需 supports_adx);非 BMI2 回退 :7910
- **实证方法论**: 关闭 diagnostic flags 需先 -XX:+UnlockDiagnosticVMOptions;Math.exp 微基准会被 C2 消除(i 派生常量)→数据依赖数组
- 实证: SHA-256 1537→262 MB/s=**5.9x**;SHA-512(AVX2 软件)815→438=1.9x;AES-CBC 496→166=3.0x;CRC32 44704→3110=**14.4x**;Math.exp 4.0→7.0 ns/op=1.7x——"8x 加速"编造被实测取代

### 6.18 24-01(Physical Frame,第 4 批第 4 个域开篇,大纲 10 处漂移含 2 处编造,2026-08-13)
- **"frame 三字段" 错**: 共享 _sp/_pc/_cb+deopt 三态(frame.hpp:50-65),**x86 附加 _fp/_unextended_sp(frame_x86.hpp:110-120)**——注释解释了双 sp 的由来(interpreter/adapters 扩展 caller 帧,oopMap 按扩展前 sp 记录);别信"三字段 32 字节"
- **"compiled sender = *rbp/+(rbp+8)" 错**: sender_sp = unextended_sp + **_cb->frame_size()(编译期元数据)**,sender_pc=*(sender_sp-1),saved_fp=*(sender_sp-2)(frame_x86.cpp:451-483);非 rbp 链现场走
- **"interpreter sender = *[method_locals-2]" 半对**: interpreter_frame_sender_sp()=fp[-1](帧内保存 caller sp,frame_x86.cpp:431-446);偏移表 frame_x86.hpp:60-73(正偏移 fp 上方/负偏移 fp 下方)
- **"四种帧" 简化错**: sender 分派三路(entry/interpreter/compiled,frame_x86.cpp:488-503),JNI native 帧也是 nmethod;兜底纯 C 帧
- **"find_blob 二分搜索" 错(编造)**: CodeHeap segmap 段映射链式回跳(heap.cpp:456-483),x86 段 128B(CodeCacheSegmentSize=64 TIERED_ONLY(+64) globals_x86.hpp:40)
- **"Interpreter::oop_map_cache()" 不存在(编造)**: per-Klass(InstanceKlass::_oop_map_cache instanceKlass.hpp:247);Method::mask_for(method.cpp:237)/OopMapCache::compute_one_oop_map(oopMapCache.cpp:597)
- oops_do: oops_do_internal(frame.cpp:1115)分派;解释器帧=monitor→native temp oop→mirror→调用点参数→mask(:890-958);编译帧=OopMapSet::oops_do(compiler/oopMap.cpp:288,oop_map_for_return_address :302,**derived 先处理** :307-340);OopMapValue 四型 oopMap.hpp:69-73
- 栈顶: Thread::last_frame(thread.hpp:1879)=make_walkable+pd_last_frame(thread_linux_x86.cpp:30-34);deopt 构造判定=get_deopt_original_pc(frame_x86.inline.hpp:44-60)
- **实证方法论**: jcmd 输出走目标进程 stdout(重定向文件);attach 失败=进程已死/pgrep 误匹配(用 jps -l);PrintInterpreter 是 diagnostic flag 需先 UnlockDiagnosticVMOptions;适配器=AdapterBlob:BufferBlob→non-nmethods 段(codeBlob.cpp:262)
- 实证: 24-frame-demo.txt(jstack 两行 at/codelist hot 双版本 nmethod level4+3/三 CodeHeap 1098 blobs 653 nmethods 359 adapters/PrintInterpreter 271 codelets 358B)

### 6.19 24-02(Virtual Frame,大纲 5 处漂移含 1 处编造 + 第 3/4 轮 REVIEW,2026-08-13)
- **"nativeVFrame" 不存在(编造)**: 家族=vframe(vframe.hpp:54)→javaVFrame(:107 五纯虚)→interpretedVFrame(:160)/compiledVFrame(**vframe_hp.hpp:30**);另支 externalVFrame→entryVFrame(:204/:217);JNI 帧走 compiledVFrame scope=NULL(vframe_hp.cpp:236-245,method/bci 直接取 :267-292,"native nmethods have no scope")
- **vframeStream 位置错**: 类在 vframe.hpp:268-330(StackObj,_mode 三态 :274),**next() 在 vframe.inline.hpp:41-49**(非 vframe_hp.cpp)——同帧内联层 fill_in_compiled_inlined_sender(:66-72,serialized_null 判边界)不动 _frame,物理层 do-while sender;fill_from_frame :125-201(编译帧只解码 sender_decode_offset+method+bci 三字段 :75-114,locals 不碰=惰性)
- ScopeDesc: scope_desc_at(compiledMethod.cpp:218)=pc→PcDesc→offset;sender() 实现 scopeDesc.cpp:152/is_top :148
- 消费者: JFR vframeStreamSamples(jfrStackTrace.cpp:135)+Thread.print(thread.cpp:3417);**第 3 轮修正**: 线程转储走 vframe::sender 链(print_stack_on thread.cpp:3247、dumpThreads threadService.cpp:645-662),非 vframeStream
- **第 3 轮 REVIEW(用户追问 Kona 是否特改)**: 下载 **Temurin OpenJDK 11.0.32**(api.adoptium.net,与 jdk11u 同版本)验证: SIGQUIT 转储/jcmd Thread.print/JFR 三路径都只有 main 一行——**Kona 17/21 与 OpenJDK 行为一致,非 Kona 特改**;对照 NoInlineDemo(不内联)正常 4 层;机制=**锚点 pc**(线程转储起点=last_Java_pc)+**内联纯算术段无 PcDesc**
- **第 4 轮 REVIEW(锚点 pc 精确定位)**: 锚点 pc=最近 Java→VM 转换点=**C2 插在循环回边的安全点轮询点**(17-02 safepoint_poll 呼应);**显示哪层由轮询点所在方法决定**(InlineDemo2 轮询点在 main 循环→1 层;NoInlineDemo 轮询点在 big 循环→物理链 4 层,top/mid 均未内联 grep=0);内联纯算术无循环无轮询点→锚点永不落内联代码;JFR JDK11=suspend+ucontext 但 **pd_get_top_frame 优先锚点帧**(thread_linux_x86.cpp:55-58);ucontext 路径 pc_desc_at NULL 回退(vframe.inline.hpp:139-189)
- **实证方法论教训**: ①容器后台进程在 bash 工具调用结束被杀——用 wrapper 脚本单次调用内完成(start→sleep→采集→kill);②pgrep/pkill -f 模式匹配到 bash 自身命令行导致自杀/超时——用方括号技巧 [I]nlineDemo;③jcmd attach 在 Temurin 11 挂起——用 kill -3(SIGQUIT)转储,输出走进程 stdout,不需 attach;④JDK 版本匹配: Kona17 javac 编译的 class(61)不能跑 JDK 11(55)——实证 JDK 用哪个 javac 就用哪个 java;⑤echo 文本含中文括号会触发 bash 语法错误;⑥内联日志(-Xlog:jit+inlining=debug)比 PrintAssembly 轻量,证明"多层内联=1 物理帧"够用
- 实证: 24-inline-demo.txt v2(Temurin 11 三路径+对照)

### 6.20 24-03(Deopt 重建 + GC 扫描,24 域收官,大纲 9 处漂移含 2 处机制编造 + 第 3 轮 REVIEW,2026-08-13)
- **"StackValue 用 union" 错(编造)**: 三独立字段 _type/_integer_value/_handle_value(stackValue.hpp:31-53),非 union——scalar replaced oop 需同时记 Handle+标记(**_integer_value 兼作 scalar-replaced 标记**);T_CONFLICT=**死槽**(vframeArray.cpp:130 "A dead local. Will be initialized to null/zero."),非"保守扫描"
- **"MonitorChunk _monitors[0] 柔性数组" 错(编造)**: NEW_C_HEAP_ARRAY BasicObjectLock(monitorChunk.cpp:30-34);链挂 JavaThread::_monitor_chunks(thread.hpp:1023);oops_do :42-46(GC 覆盖 C 堆监视器)
- **行号全漂移**: vframeArrayElement :50/vframeArray :121 字段 :131-146;fill_in vframeArray.cpp:60-109;create_stack_value stackValue.cpp:37(取址 :48-55: 寄存器→reg_map->location,栈→unextended_sp+offset;窄化+解码 :60-110);unpack_on_stack :171-202;RegisterMap registerMap.hpp:52-66/x86 版仅 pd_location hook(registerMap_x86.hpp:28-36)
- **deopt 主链**: uncommon trap→fetch_unroll_info(deoptimization.cpp:139)→helper(:158)→create_vframeArray(:310/:1169,set_vframe_array_head :315)→unpack_frames(:623);unpack_on_stack 三态入口(SynchronizationEntryBCI→deopt_entry/reexecute→deopt_reexecute_entry/否则→deopt_continue_after_entry :187-220)
- **第 3 轮 REVIEW**: ①"已入栈旧帧走到栈顶才 deopt"错——uncommon trap 只拆当前帧;其它帧由 **deopt_dependents(deoptimization.cpp:800-803)→Threads::deoptimized_wrt_marked_nmethods(thread.cpp:4625)→逐帧 should_be_deoptimized 当场拆(:2847-2858)**,下次 safepoint 全量拆;②made not entrant=uncommon trap 的 action 直接标(:1794-1825 Action_make_not_entrant/reinterpret),非依赖系统;③C 堆原因=源码注释(deoptimization.cpp:1209-1211 "Since the Java thread being deoptimized will eventually adjust it's own stack...")
- **实证方法论**: PrintDeoptimizationDetails/TraceDeoptimization 是 develop flag(release 版没有);JDK11 JFR metadata 无 jdk.Deoptimization 事件;deopt 观测用 -XX:+PrintCompilation 的 made not entrant(类型漂移 demo: 接口先只传 A 后传 B);代码块范围用自动对齐脚本核对(凭 sed 目测必错)
- 实证: 24-deopt-demo.txt(total 268ms C1+C2→270ms Circle→made not entrant×2→OSR→重编译)

### 6.22 08-02(Template Interpreter,大纲 11 处漂移含 3 处机制编造 + 第 3 轮 REVIEW,2026-08-13)
- **"generate_all 三步" 错**: 真实十一段(templateInterpreterGenerator.cpp:57-263): 签名+错误出口→return 按长度 5 档(_return_entry[6] 0 空)→invoke return 按 TosState 10 档→earlyret→native 结果→safepoint 入口(InterpreterRuntime::at_safepoint)→异常 6 入口→方法入口 28 种(method_entry 宏,MethodKind 在 abstractInterpreter.hpp:59-61,zerolocals..abstract 7+math 11+refget 1+CRC 5+FD 4;MH 系列由 initialize_method_handle_entries 单独处理)→set_entry_points_for_all_bytes(遍历 256,is_defined→模板/否则 _unimplemented_bytecode stop)→safepoints_for_all_bytes→deopt 入口(_deopt_entry[7] 按长度)
- **寄存器错**: x86_64 下 rlocals=r14、rbcp=r13(templateTable_x86.cpp:46-47),r13 是 bcp 不是 dispatch 表;locals_index 取负 index(negptr);dispatch=lea rscratch1, ExternalAddress(table)+jmp [rscratch1+rbx*8](interp_masm_x86.cpp:826-846),表地址每次 lea 不在寄存器
- **"iload_0 模板 push(rax)+advance+dispatch_next" 错**: iload_0..3 生成器=**iload(int n)**(templateTable_x86.cpp:878-881)仅 3 行(transition+movl(rax,iaddress(n))),无 push 无 bcp 访问;**transition 只是断言**(templateTable.cpp:162-165);advance/dispatch 由 generate_and_dispatch 统一生成(:377-401,does_dispatch 模板自己跳走+should_not_reach_here)
- **实证尺寸**: iload_0=96B vs iload=192B(iload() 含 RewriteFrequentPairs 检查读 bcp[1],:621-637);iconst 7 个全 96B;iadd 64B;ldc 736B;invokevirtual 1280B;271 codelets avg 404B(08-interpreter-templates.txt,Temurin 11;24-01 素材的 358B 是 Kona 17,引用时注明版本)
- **"tosState 共享模板(iload/fload 同)" 错**: 共享按**生成函数+arg 参数化**(iconst(arg)/iop2(Operation)/if_0cmp(Condition)/float_cmp(±1)/fast_accessfield(tos),templateTable.cpp:357,410-419,480-487),非按 tosState
- **"TemplateTable::_itable[256]" 错**: 真实=_template_table/_template_table_wide 双表 239 槽(templateTable.cpp:172-173);def 用 iswd 选表,断言 "wide instructions have vtos entry point only";wide 入口单列 _wentry_point[256](templateInterpreter.hpp:134)
- **入口点家族(核心,大纲未提)**: DispatchTable::_table[10][256](templateInterpreter.hpp:65-83);set_short_entry_points(:345-362) tos_in!=vtos 时 vep=pop(state)(**pop=从栈装载到寄存器**,interp_masm_x86.cpp:678-704)+状态入口=本体;tos_in==vtos 走 set_vtos_entry_points(x86:1765-1794)=aep/fep/lep/iep 压栈序言+vep 共享本体;**tosca=栈顶值留寄存器不压栈**(templateInterpreter.hpp:40 注释);TosState 10 态 globalDefinitions.hpp:819-832
- **safepoint 轮询内联(大纲未提)**: dispatch_base 每字节码 testb [r15_thread+polling_page_offset],置位跳 safept_table(:826-834);notice_safepoints **整表拷贝**(copy_table safept→active,templateInterpreter.cpp:293-325,非指针换向;safepoint 内 disjoint_words/外 atomic :282-291)——17-02/24-02 轮询点呼应
- **0xCB-0xFF 修正(01 篇遗留)**: 未定义区是 **0xEF-0xFF 共 17 个**(239-255),0xCB-0xEE(203-238)是 36 条 fast 系列!01 篇第 3 轮 REVIEW 没抓到,本篇深审抓出,两篇正文+大纲已同步修正
- **第 3 轮 REVIEW 修正 4 处**: ①wide 链精确化: _wide 模板 jump ArrayAddress→_wentry_point(templateTable_x86.cpp:4504-4510,"rbcp increment step is part of the individual wide bytecode implementations"),宽模板出口仍走共享表;②iadd 消费=iop2 的 pop_i(rdx)+addl(rax,rdx)(:1337-1340),非"消费 rax 两个操作数";③deopt 三态: reexecute 走 deopt_reexecute_entry(method,bcp),_return_register_finalizer 特判才走 deopt_reexecute_return_entry(templateInterpreter.cpp:339-352)——24-03 unpack 三态对应,别把两者混成一个;④字节码表初始化=init_globals→bytecodes_init(init.cpp:104),早于模板表;TemplateInterpreter::initialize 只做 TemplateTable::initialize+StubQueue+生成

### 6.21 08-01(Bytecode 定义表,08 域开篇,大纲 11 处漂移含 3 处机制编造,2026-08-13)
- **"5 个静态数组 names/lengths/formats/flags/depths" 错**: 6 个数组(_name/_result_type/_depth/_lengths/_java_code/_flags,bytecodes.hpp:339-346),**没有 _format 数组**——format 字符串由 compute_flags(bytecodes.cpp:206-276)预编译成 _flags 位;两条压缩技巧: _lengths 一字节两用(低 4 位短长/高 4 位 wide 长,:397-398)、_flags 512 槽双页(低 256 普通/高 256 wide,:345,432-435)
- **"def(...) 宏展开" 错**: 是 C++ 静态函数非宏;7/8 参数 (code,name,format,wide_format,result_type,depth,can_trap[,java_code]);239 条 def 调用启动一次填充(数组在 .bss 非 .data,"编译时预计算"应说"启动时预填充")
- **"Format: b=1B signed byte/c=1B CP index/i=2B/j=4B branch offset" 全错**: 真实语义(cpp:188-204 注释)=**b 是 opcode 本身**、c=signed constant、i=local index、**j=2B CP cache index**、k=CP index、o=branch offset(ifeq "boo"/goto_w "boooo");大写=原生字节序(实际只有 J 出现,:244 注释);**指令长度=format 字符串字符数**;变长 format=""
- **"256 条(255=impdep2)" 错**: 枚举 203 个成员(0x00-0xCA,含规范保留 wide/breakpoint)+36 条私有(fast 29+return_register_finalizer+invokehandle+nofast 4+shouldnotreachhere)=number_of_codes 239;0xCB-0xFF 不定义;load/store 实数=5 类型×(1+4 short)=25+25=50 条(大纲 "~60/6 种×4" 错)
- **"opcode upper 4 bits 分组让 dispatch 用查表" 编造**: 段布局是 JVM 规范历史安排;HotSpot 分组=区间谓词函数(hpp:415-429 is_aload/is_const/is_return/is_invoke),真实消费者 verifier.cpp:754(异常区检查)/templateInterpreter.cpp:254(invoke 单独处理)/deoptimization.cpp:705-722(deopt 重建时 is_invoke 判调用点+falls_through)
- **"can_trap 用于 loop optimization" 编造**: 真实消费者=GenerateOopMap::do_exception_edge(generateOopMap.cpp:1178 第一行剪枝,决定"异常边"→解释器 OopMap 栈图——连接 24-01 的 oopMapCache 链: mask_for→compute_one_oop_map(oopMapCache.cpp:597)→OopMapForCacheEntry(:72))+ciTypeFlow.cpp:2171;C1 自建 _can_trap 表(c1_GraphBuilder.cpp:2976-3034,剔 return/monitorexit,"monitor pairing proved");def 末尾 ASSERT 保证重写指令 can_trap 是原指令子集(cpp:553-563)
- **"stack_effect(opc,bci)/_unknown_depth" 编造**: 不存在;depth 恒静态(invoke 系 -1=近似 pop receiver,invokestatic/indy=0);"栈顶类型由上下文决定"由 result_type=T_ILLEGAL 表达(cpp:289-291 Note 2)
- **变长只有三条**: wide(读第二字节查高 4 位)/tableswitch(align_up(bcp+1,4),长=(补齐)+(3+hi-lo+1)*4)/lookupswitch(长=(补齐)+(2+2*npairs)*4);**breakpoint 不在 special_length_at case(返 0)**,普通迭代器经 code_at 伪装成原指令(hpp:369-374),只有 raw_special_length_at 给 1(:151-158);迭代器先 length_for 固定长、0 才 length_at(bytecodeStream.hpp:205-207)
- **实证方法论**: javap 偏移差=def 表 format 长度,可脚本全量核对(76 条固定长全对;方法边界 return 行会算出负差需过滤);lookupswitch 对齐可用偏移链证明(1→4 对齐→44,43 字节);正则陷阱: def 表名字匹配写死 "bytecode" 前缀导致零命中
- 实证: 08-bytecodes-javap.txt(Temurin 11 javac/javap,BcDemo 六方法: 构造器+常量/局部变量/算术/if/lookupswitch/invoke/indy/new/数组;invokedynamic #11,0 5 字节、bipush 42 2 字节、iinc 2,1 3 字节)

---

## 七、用户偏好与纪律(重要,违背会被批评)

1. **严格按规划,不做多余选择**: 拓扑定了顺序就逐项推进——不要问"还是写 X?"(曾因制造选择被批评)
2. **每篇都做深度 REVIEW(2 轮)**: 用户会要求"按照方法论深度的 REVIEW",写完后**主动自查深审,不要等**;用户还会追加"再次深度的 REVIEW"(第 3/4 轮)——按同样方法重新质疑,重点抓上一轮没抓到的"顺理成章"错误
3. **一篇一篇写**: 不并行、不跳步
4. **数字/事实必须验证**: 任何带数字的陈述回源码/素材验证,禁止"凭记忆"
5. **命名混淆注意**: "域 07"与"07 域的第 01 篇"都带 07,表述时写清"域 XX 第 Y 篇"
6. 中文交流,提交信息用中文
7. 用户会追问"下一步规划是否合理"——要有自己的判断
8. **用户会追问"发现的问题都修复了吗/有沉淀吗"**——修复要有 commit 可查,沉淀要即时写进本文件 §6
9. 链接文本必须与目标文章标题一致
10. 上下文将满时用户会要求"写详细的交接文档"——把进度/commit/经验/下一步全部写全
11. **用户会怀疑实证工具**(如"是不是因为用的不是 openjdk 而是 konajdk")——实证 JDK 与源码版本匹配是硬要求,Temurin 11 已备好;回答要有对照实验支撑

---

## 八、待办清单(按优先级)

- [x] 第 1 批 12 篇 + 第 2 批 26 篇 + 第 3 批 14 篇(01/05/45/48/02/03/04/06/16/38/41/42/07/09/17 域)——✅ 完结
- [x] 第 4 批: 10-metaspace(3/3)/19-sync(4/4)/23-stub(3/3)/24-frame(3/3)——✅ 完结(commit 见 §二)
- [x] **08-interpreter/01**(bytecodes 定义表)——✅ 完结(正文 b34880a/回填 05d5c11/README 4ee15e1,commit 见 §二)
- [ ] **08-interpreter/02**(template interpreter)——**下一篇**;大纲 `planning/outlines/08-interpreter/02-template-interpreter.md`(08 域剩 3 篇: 02-template-interpreter/03-interpreter-runtime/04-linkresolver-rewriter);01 篇悬念指向它: 定义表怎么变成机器码
- [ ] 08 域完结后 → 31-unsafe → 44-verification(第 4 批收尾)
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
| 工具素材 | `docs/openjdk/planning/outlines/00-jvm-tools/materials/`(commands/ 130+ 文件) |
| **实证 JDK(首选,与源码同版本)** | **`/data/tmp/opencode/jdk11/bin`(Temurin OpenJDK 11.0.32,api.adoptium.net 下载)** |
| 通用 JDK | `/opt/codev/TencentKona/bin/`(17.0.8.1);`/opt/codev/TencentKona-21.0.12.b1/bin`(21);`/data/tmp/opencode/jdk17/bin`(Temurin 17) |
| 自查脚本 | `/data/tmp/opencode/check.py`(代码块/行号/星号/锚;新文件先加 MAPPINGS/HS_MAP;ART 改当前文章;相对链接豁免已泛化) |
| 实证工作目录 | `/data/tmp/opencode/acbench/`(bench 源码+wrapper 脚本 run_*.sh) |
| GUI 手册 | `docs/openjdk/planning/outlines/00-jvm-tools/GUI-manual.md` |

**自查脚本要点**(python,每篇跑):
- 代码块: `re.findall(r'```cpp\n// (file):(s)-(e)\(...\)\n(.*?)```')` → 逐行比对(遇 "..." 跳过,strip 后判)
- 行号范围: HS_MAP(hotspot: share/classfile/、share/runtime/、share/code/、share/opto/、share/compiler/、share/interpreter/、share/memory/、share/oops/、share/gc/*、cpu/x86/、os/linux/、os/posix/、os_cpu/linux_x86/ 等)+ MAPPINGS(JDK 侧)→ 行号 ∈ [1, 行数]
- 星号: 剔除代码 span 后 `count('*') % 2 == 0`(注意 `java.*` 类裸星号必须加反引号)
- 文字锚: 文件名后无行号的引用 → 报错补行号(注意 .cpp 后缀的锚检查天然失效,仍要手动补行号)
- 链接: 相对链接按文章目录解析;forward link 豁免=大纲目录里存在同名文件(已泛化为全 outlines 扫描)
- **代码块行号不匹配时**: 用 python 自动对齐脚本(取块体首行在源中的位置+逐行匹配末行,见 24-03 做法)

---

## 十、下一步(读完立即做)

```
1. 读 planning/outlines/08-interpreter/03-interpreter-runtime.md(注意 ⚠️ 块——01/02 大纲均已回填,03 大概率同样漂移;02 篇悬念指向它: calls_vm 指令怎么调 C++)
2. 验证大纲所有 file:line 与专有名词(按 §6.1 的规律;重点: interpreterRuntime.cpp 的各类入口(resolve_ldc/resolve_invoke/new/throw...)、模板侧 call_VM 的调用点(templateTable.cpp:71-116 断言 calls_vm)、interp_masm 的 call_VM 封装(macroAssembler 层 JavaFrameAnchor/safepoint 处理)、JavaCalls/SharedRuntime 桥、safepoint 入口(InterpreterRuntime::at_safepoint,02 篇第 6 段生成)、invoke 的 resolve 流程;与 02 篇的 dispatch/轮询点/calls_vm 位呼应要在文中体现;03 大纲标题 = InterpreterRuntime,正文标题按 v5 格式)
3. 实证优先用 /data/tmp/opencode/jdk11(Temurin 11,与 jdk11u 同版本);容器后台进程用 wrapper 脚本管理;pgrep 用方括号;转储用 kill -3;jcmd attach 挂起时换 kill -3;class 版本注意 javac/java 同版本;javap -c 偏移差可与 def 表脚本核对(见 08-bytecodes-javap.txt)
4. 按第三节流程写 → 自查(脚本 /data/tmp/opencode/check.py,新引用文件先加 HS_MAP/MAPPINGS;ART 变量改回当前文件)→ 深审 2 轮(用户会追加第 3 轮)→ 回填大纲 → 提交 → 更新 README
5. 08 域完结后 → 31-unsafe → 44-verification(第 4 批收尾)
```

**环境**: Linux 容器,无显示器(GUI 截图等用户在 Ubuntu 补);jdk11u 源码在本地;git 推送即部署(docsify 站点)。**上下文已满: 本文件写完后,新会话只读本文件即可继续,不要依赖旧会话的记忆。**
