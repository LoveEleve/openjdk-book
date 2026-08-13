# SESSION-HANDOFF — 主交接文档(唯一入口,非常详细版)

> **状态**: 2026-08-13 | 卷 2 写作中: **64/152 篇完成**(第 1 批 12 + 第 2 批 26 + 第 3 批 14 + 第 4 批 12: 11/19 域完结,**23 域完结**,24 域 2/3) | **上下文已满,本文件为非常详细交接版**——新 AI 只读本文件即可继续,不要依赖旧会话记忆
> **接收者: 新 AI —— 只读本文件,按"十、下一步"执行**

---

## 〇、三十秒总览(先读这个)

**项目**: 写一本 OpenJDK 源码分析书("格物致知"),源码树 = jdk11u(`/data/workspace/jdk11u/src/hotspot/`)。

**当前正在做**: 卷 2(按 48 域规划写源码文章),每篇严格按方法论: 读大纲 → **所有行号重新 grep 验证** → 写 → 代码块与源码逐字核对 → **深审 2 轮** → 回填大纲 → 提交。

**下一步(唯一,无选择)**: 24-frame/03(Deopt 重建 + GC 扫描——vframeArray 怎么重建解释器帧)。

**铁律**: ① 一篇一篇写,写完自查+深审 2 轮合格再下一篇;② 大纲/KP 的行号与机制描述是"线索不是事实",写作时必须重 grep——**实测每篇大纲有 2-15 处机制错误或行号漂移,61 篇无一例外**;③ 代码块贴真实源码(截取可,编造不可)——凭记忆写值必错;④ 每篇写完整理后做深审,**必须 2 轮**(第 1 轮自查+通读,第 2 轮逐机制回源码质疑——第 2 轮才能抓到"顺理成章"的机制错误);⑤ 发现错误→修正文章→**回填大纲 ⚠️ 块**(防下次抄错)→提交;⑥ **REVIEW 时正文与大纲的行号要一起过**(07-04 REVIEW 时发现大纲 ⚠️ 块行号也带着同样的偏差);⑦ 脚本语法错误要立即发现——一次 commit 曾因 `;` 链把未应用的修改提交了(07-03 REVIEW 教训)。

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
**JDK 工具**: `/opt/codev/TencentKona/bin/`(17.0.8.1,可现场跑实证)
**旧交接文档**(更早会话起点,可参考历史): `/data/workspace/source-code/book/成长之路/tmp-question/training-camp/source-code/analysis/source-analysis/HANDOFF.md`

---

## 二、卷 2 写作进度(精确到篇)

**写作顺序依据**: `docs/openjdk/planning/knowledge-planning/00-domain-writing-order.md`(48 域依赖拓扑 7 层,脚本验证自洽)

```
第 1 批(地基): 01(4 篇) → 05(2 篇) → 45(2 篇) → 48(4 篇)         ✅ 全部完成(12/12)
第 2 批(原语): 02(4 篇) → 03(2 篇) → 04(2 篇) → 06(6 篇) → 16(5 篇) → 38(2 篇) → 41(2 篇) → 42(3 篇)   ✅ 全部完成(26/26,第 2 批收官)
第 3 批(对象/类): 07(7/7) → 09(3/3) → 17(4/4)   ✅ **第 3 批完结(14 篇)**
第 4 批(执行/帧): 10(3/3) → 19(4/4) → **23(3/3)** → 24(2/3) → 08 → 31 → 44   🚧 进行中
第 5 批(VM 核心): 11 → 12 → 13 → 18 → 20 → 27 → 30 → 32 → 34 → 36 → 37 → 39 → 46
第 6 批(JIT/GC): 14 → 15 → 21 → 25 → 28 → 29 → 33 → 43
第 7 批(上层): 22 → 26 → 35 → 40 → 47
```

**已完成 64 篇**(全部在 `docs/openjdk/vol-02/`,第 1 批 12 + 第 2 批 26 + 第 3 批 14 + 第 4 批 12):

| 域 | 篇 | 文件 | 状态 |
|---|---|---|---|
| 01-os | 1-4 | `01-os/` 4 篇 | ✅ 旧会话完成,抽查修正 |
| 05-cpu-primitives | 1-2 | `05-cpu-primitives/` 2 篇 | ✅ 旧会话完成,抽查修正 |
| 45-math-library | 1-2 | `45-math-library/` 2 篇 | ✅ 45 域完结 |
| 48-utilities | 1-4 | `48-utilities/` 4 篇 | ✅ 48 域完结 |
| 02-assembler | 1-4 | `02-assembler/` 4 篇 | ✅ 02 域完结 |
| 03-arguments-flags | 1-2 | `03-arguments-flags/` 2 篇 | ✅ 03 域完结 |
| 04-logging | 1-2 | `04-logging/` 2 篇 | ✅ 04 域完结 |
| 06-oops | 1-6 | `06-oops/01`~`06` | ✅ 06 域完结(六篇,大纲 60+ 处错误全部回填) |
| 16-codecache | 1-5 | `16-code-cache/` 5 篇 | ✅ 16 域完结 |
| 38-perfdata | 1-2 | `38-perfdata/` 2 篇 | ✅ 38 域完结 |
| 41-zip-jimage | 1-2 | `41-zip-jimage/` 2 篇 | ✅ 41 域完结 |
| 42-core-native | 1-3 | `42-core-native/01-jni-system.md`(129 行)/02-process.md(264 行)/03-class-io.md(228 行) | ✅ **42 域完结,第 2 批收官** |
| 07-classfile-classloader | 1-7 | `07-classfile-classloader/01`~`07` | ✅ **07 域完结(7 篇,第 3 批第 1 个域收官)** |
| 09-memory-core | 1-3 | `09-memory-core/01`(214 行)/02(237 行)/03(147 行) | ✅ **09 域完结** |
| 17-threads | 1-4 | `17-threads/01`(191 行)/02(192 行)/03(165 行)/04(188 行) | ✅ **17 域完结** |
| 10-metaspace | 1-3 | `10-metaspace/01`(101 行)/02(142 行)/03(104 行) | ✅ **10 域完结** |
| 19-sync | 1-4 | `19-sync/01`(157 行)/02(107 行)/03(179 行)/04(113 行) | ✅ **19 域完结** |
| 23-stub | 1-3 | `23-stub/01-stub-entry.md`(128 行)/`02-arraycopy.md`(313 行)/`03-crypto-math.md`(306 行) | ✅ **23 域完结** |
| 24-frame | 1-2 | `24-frame/01-physical-frame.md`(238 行)/`02-virtual-frame.md`(151 行) | 🚧 24 域进行中(2/3) |

**每篇 commit 号**(以 git log 为准;旧批次省略,列出 42/07/09 域): 42域01=d52e3a3(正文+大纲回填)+1245c25(README);42域02=476c3a9(正文+大纲回填)+ec7338f(README);42域03=c4d1b1f(正文+大纲回填,42 域完结)+e8789cc(README,第 2 批收官)+d474372(深度 REVIEW: findJniFunction builtin 限定、execstack 修复机制、VerifyFixClassname 语义、行号修正);07域01=8a24a30(正文+大纲回填)+fe93766(README)+7c199ba(深度 REVIEW: 字段排列顺序方向修正 oops 默认排最后、Module ACC_MODULE 拒绝、行号 8 处);07域02=f1684a0(正文+大纲回填)+5d486bd(README)+4a7bb70(深度 REVIEW: chop 数解读修正/block 范围/链接文本对齐);07域03=c65d49c(正文+大纲回填)+93e11a6(README)+eccd834(深度 REVIEW: 数组头 16+3/并发清理归属 serviceThread/'五个 ClassLoader' 删)+3d246fe(rehash 种子表述补丁);07域04=1ea098c(正文+大纲回填)+a84c8e4(README)+c0deb38(深度 REVIEW: 六步行号精确化/查字典四次/SystemDictionary 定位);07域05=3db4402(正文+大纲回填)+9d3502a(README)+d8a145e(深度 REVIEW: is_alive 判定/unload 动作/load_shared_class 行号);07域06=4a23fde(正文+大纲回填)+94a9f44(README)+2a185ec(深度 REVIEW: 模块表归属修正 per-loader ClassLoaderData._modules);07域07=4965aa8(正文+大纲回填,07 域完结,405 行)+fe78586(README,第 3 批第 1 个域收官)+a487eac(第 3 轮深度 REVIEW 跨篇联动: String.value 永远 byte[] 修正 07-03、get_injected 行号 1563-1566 修正 07-01);**09域01=fb31f7b(正文+大纲回填)+791540e(README)+4b8b16c(第 3 轮 REVIEW)+f0b7b93(大纲同步);09域02=bf19c20(正文)+9eed025(大纲 ⚠️ 块 12 条)+81f8b56(README)+1727df9(第 3 轮 REVIEW);09域03=3593c9b(正文,09 域收官)+58c5e34(大纲 ⚠️ 块 10 条)+cb0dae2(README)+4cb5120(第 3 轮 REVIEW: GuardedMemory=jniCheck 客户)+d6a3ef7(大纲同步);17域01=bec47da(正文)+dc76829(大纲 ⚠️ 块 9 条)+bb94c20(README)+95b35a6(第 3 轮 REVIEW: ThreadShadow 定位/run 行号/PeriodicTask 断言);17域02=acb2a56(正文)+eee99a9(大纲 ⚠️ 块 7 条)+6f44acd(README)+28d805a(第 3 轮 REVIEW: native 安全条件/trans 死锁检测)+1497e84(大纲同步);17域03=5cf8686(正文)+ea83da0(大纲 ⚠️ 块 8 条)+ecc4ea2(README)+8973d1e(第 3 轮 REVIEW: xchg/is_a_protected/wake_up 实证);17域04=ede39e3(正文,17 域收官)+f552c23(大纲 ⚠️ 块 7 条)+a0c1128(README)+2c2836e(第 3 轮 REVIEW: 悬念批次标注/guard page 实证);10域01=2e39136(正文)+3085390(大纲 ⚠️ 块 8 条)+61e1635(README)+1d9a6e1(第 3 轮 REVIEW: satisfy_failed=VM_CollectForMetadataAllocation/narrow klass shift);10域02=86e977d(正文)+a0f87aa(大纲 ⚠️ 块 7 条)+7833fb7(README)+b821792(第 3 轮 REVIEW: ChunkOrigin 落点实证);10域03=fbf939c(正文,10 域收官)+32091d6(大纲 ⚠️ 块 7 条)+d291111(README)+141bfaf(第 3 轮 REVIEW: CDS 只读映射)+a025f46(大纲同步);19域01=7867d04(正文)+78c1b7a(大纲 ⚠️ 块 8 条)+c6fafae(README)+1529a52(第 3 轮 REVIEW: 汇编 biased 快路径/deflate safepoint 断言/epoch++ 实证);19域02=e009327(正文)+792e9c7(大纲 ⚠️ 块 7 条)+ebca669(README)+d7dd512(第 3 轮 REVIEW: lock bits=10 非 11)+c2048e6(大纲同步);19域03=84345bf(正文)+feb3803(大纲 ⚠️ 块 7 条)+60d5212(README)+3cbb278(第 3 轮 REVIEW: TATAS 实证/默认 QMode/ReenterI);19域04=ced36a2(正文,19 域收官)+fdcb458(大纲 ⚠️ 块 6 条)+316e712(README)+b234a82(第 3 轮 REVIEW: wait 行号/断言依据);23域01=88481ba(正文,128 行)+df084df(大纲 ⚠️ 块 6 条)+c7ffdd5(README)+a4b44b0(第 3 轮 REVIEW: throw 桩不返回实证/generate_all 内容修正)**。各域 README/HANDOFF commit 见 git log。

**已回填的大纲**(写作中发现漂移即回填,防下次抄错): 45/48/02/03/04/06(六篇)/16(五篇)/38(两篇)/41(两篇)/42(三篇)/07(01-07)/09(01)各域 outlines 均已按真实源码重写并标 ⚠️ 写作期修正;KP(45/48/04)同步修正。**写作 09-memory-core/02 前先读 09-01 大纲 ⚠️ 块(15 条,重点是时序/空数组语义/分配链)与 09-02 大纲;09-01 悬念承诺: G1CollectedHeap::initialize(:1533+)里 Reserve the maximum 的虚拟内存机制(ReservedSpace reserve + commit)是 09-02 的主角。**

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
- 代码块: 首行标注 `// file.cpp:start-end(截取核心/逐字)`;标注范围必须与内容精确对应(含闭合括号行)
- 跨篇引用用相对/`openjdk/vol-02/...` 路径;**链接文本必须与目标文章标题一致**(本会话抓过 3 处不一致: 42-02/07-03 链接文本对齐大纲标题)

### 4.3 书稿代码块纪律(血泪总结,每篇深审都靠它抓错)
1. **代码块 = 真实源码**: 截取可(省略模板/错误处理,用 "..." 占位),核心语句逐字,**禁止凭记忆写值/编码/常量/注释**(注释也不能编!抓过 itableOffsetEntry 的编造注释)
2. **行号写作时重新 grep**: 大纲/KP 是规划期产物,行号大量漂移——每篇实测都有 2-15 处漂移;07-04 教训: **写正文时 sed 目测的行号也可能偏 10 行**(六步流程全部重 grep 定位),正文与大纲 ⚠️ 块的行号要同时精确
3. **自查脚本**(/data/tmp/opencode/check.py): 文章每个 file:line 逐个核对(范围+存在性);代码块与源码逐行 diff("..." 跳过);新增文件要先加 MAPPINGS(share/classfile/、share/oops/、share/runtime/、share/utilities/、share/prims/、share/asm/、share/native/libjava/、java.base/share/classes/...、java.base/unix/native/libjava/ 等)
4. **文件名必须 find 验证**: 目录/文件路径凭记忆必错(jdk11u 有重构: flags/ 子目录、share/asm/ 的 codeBuffer.hpp、classFileStream 在 share/classfile/ 等)
5. **大纲的"篇数/数字"也要重验**: 规划文档的篇数可能过时(第 2 批实际 26 篇: 06-oops=6、16-code-cache=5、42-core-native=3)——进度表述以 outlines/ 实际文件数为准

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
| 卷 T 文章 | `vol-tools/ch01.md`~`ch07.md`(7 个独立文件) | 引用格式: "[卷 T ch02](openjdk/vol-tools/ch02.md)" |

**本会话新增素材**(42/07 域,全部现场跑 TencentKona 17 生成):
- `42-process-demo.txt`(子进程 pid/isAlive/info/exitValue=7/destroy→143=128+15)
- `42-process-reaper-thread.txt`(jstack "process reaper (pid N)" daemon prio=10 阻塞 waitForProcessExit0)
- `42-classio-tz.txt`(TencentOS 无 /etc/timezone、/etc/localtime→Asia/Shanghai、ZoneId=Asia/Shanghai)
- `42-classio-jnionload.txt`(JNI_OnLoad 调用 + "Dynamic-linking native method Hello.nativeGreet" 按需链接)
- `07-classfile-javap.txt`(javap -v 常量池/Code/BootstrapMethods/StringConcatFactory)
- `07-classfile-header-load.txt`(hexdump cafe babe 0000 003d 0040 + class+load 日志 CDS "shared objects file")
- `07-classfile-verification-log.txt`(-Xlog:verification=info "Verifying class ... with new format" 逐方法)
- `07-classfile-stackmap-javap.txt`(javap StackMapTable: 253 append/16 same/250 chop)
- `07-classfile-stringtable-log.txt`(Concurrent work triggered live 3.05/dead 1.53 + Grown to size:131072=65536×2 + intern 语义)
- `07-classfile-dictionary-log.txt`(双 URLClassLoader 同名 Shared 加载两次 + la==lb false)
- `07-classfile-loader-hierarchy.txt`(三层链 + custom.loadClass(String)==String.class true)
- `07-classfile-modules.txt`(java.lang 导出 true/sun.misc false/IllegalAccessException "module java.base does not export jdk.internal.misc to unnamed module"/--add-exports 后 addressSize()=8)

**引用纪律**: 工具实证必须真实存在——引用前 grep materials/ 验证;素材缺失的实证不要引用,改为布局推导。

---

## 六、本会话实战经验(最重要,新 AI 必读)

### 6.1 大纲漂移的规律(61 篇全部出现,2-15 处/篇;02/03/04/45/48 域案例为更早会话沉淀,06/16/38/41/42/07 域为本会话沉淀)
**任何机制描述/行号/值/专有名词,一律当"线索"而非"事实"**。高频漂移类型:
1. **机制编造**(最严重): 大纲把"想当然的实现"写成机制——实证全部是编造:
   - 06-01: markOop 五种状态位布局全错;06-02: KlassLayoutHelper 类不存在;06-04: MethodLinker 不存在;06-06: _hash 字段编造
   - 42-02: "Solaris 回退 fork"错(实际 Linux vfork/其他 posix_spawn);"closeDescriptors 用 F_CLOSEM/close_range"编造(实际 /proc/self/fd 遍历);isAlive0 用 kill(pid,0)错(实际 fopen /proc/pid/stat)
   - 42-03: "RTLD_LAZY|RTLD_GLOBAL"编造(实际只有 LAZY);"dlsym 批量绑定 Java_com_xxx"编造(实际按需动态链接);"JVM_DefineClass"错(实际 JVM_DefineClassWithSource);"io_util.c getFD/setFD 函数"编造(实际 GET_FD/SET_FD 宏)
   - 07-01: **parseClassFile 函数不存在**(实际 parse_stream :6074+构造内解析);**FieldLayoutBuilder 不存在**(实际 ClassFileParser::layout_fields);FieldAllocationType"六桶"错(实际五类)
   - 07-02: verify_code/OperationStack/common_super_type 三个名字都不存在;frame_type 247 标错(247=stack_item_extended,251=same_frame_extended);ITEM_NewObject 名错(实际 ITEM_Uninitialized=8)
   - 07-03: SymbolTable"ConcurrentHashTable"错(实际 RehashableHashtable+全局锁);"rehash_table 回收"错(实际 unlink 回收/rehash 换种子);"StringTable key=Symbol"错(实际内容+WeakHandle)
   - 07-04: "allocate KlassID"编造;"Dictionary: Hashtable<Symbol*,Klass*>"错(实际 Hashtable<InstanceKlass*>);PlaceholderTable 大纲完全没提
   - 07-05: "双亲委派在 C++ load_class"错(实际 Java 层 ClassLoader.loadClass);loadZipJar/rt.jar 不存在;"ClassLoaders::platformClassLoader()"C++ 名错;"_keep_alive=JNI 引用"错(实际匿名类专用)
   - 07-06: ModuleEntry._exports/_uses 编造(实际导出在包级 PackageEntry);is_exported_to 函数不存在;--add-exports→set_has_default_read_edges 张冠李戴
2. **版本漂移**: 大纲写的是 JDK 8/其他版本的机制(loadZipJar、rt.jar、C++ 侧双亲委派)
3. **行号漂移**: 大纲行号与实际差几十到几百行;07-04 教训: 写作时 sed 目测的行号也可能偏 10 行
4. **文件名漂移**: codeBuffer.hpp 在 share/asm/;classFileStream.hpp 在 share/classfile/ 非 utilities;symbolTable.hpp 在 share/classfile/

### 6.2 写作期"凭记忆"错误(自查 diff 抓出的真实案例,每篇深审必有)
- 07-01: "oops 在前"方向反了(默认 FieldsAllocationStyle=1 是 oops **排最后**,classFileParser.cpp:4072;style 0 才在前,硬编码类 :4038-4043)——6.5-6"语义方向反了"模式
- 07-03: 数组头"4+3 字节"错(实际 16+3,数组头 16 字节 06-03 讲过);"清理不在每次 GC 都全量做"错(GC 每次 weak_oops_do 清死项,grow/深清才按负载由 serviceThread 做);"15 万个死项"错(dead factor 1.52589×65536≈10 万)
- 07-05: "BuiltinClassLoader.java:54 的 java.* 防护注释"错(:54 是 import;真正防护是 preDefineClass ClassLoader.java:891-899,且豁免权在 **Platform** 非 bootstrap)
- 07-06: "模块表全局注册"错(per-loader ClassLoaderData._modules:252);"--add-exports 唯一途径"错(还有 --add-opens/--patch-module)
- **教训**: 凡代码块里的值/编码/常量/注释,写完必须用 sed 逐行对照;数字先数后写;推导段("所以/为什么能")必须回源码找依据;REVIEW 时正文与大纲 ⚠️ 块行号一起过

### 6.3 平台/环境事实(写作时已确认)
- **jdk11u 源码树只含 x86 平台**(cpu/ 只有 x86,os/ 只有 linux/posix)——不要断言其他平台的实现细节
- jdk11u 关键位置: 42 域 JDK 侧源码在 java.base(share/native/libjava/: jni_util.c 1512 行/ClassLoader.c 523 行/io_util.c 224 行/TimeZone.c;unix/native/libjava/: ProcessImpl_md.c 683 行/childproc.c 400 行/ProcessHandleImpl_unix.c 728 行/io_util_md.c 238 行/TimeZone_md.c 901 行/FileDescriptor_md.c;linux/native/libjava/: ProcessHandleImpl_linux.c 271 行;unix/native/jspawnhelper/: jspawnhelper.c 152 行)
- 07 域 hotspot 侧全在 share/classfile/: classFileParser.cpp(6463 行)/verifier.cpp(2913)/stackMapTable.cpp(442)/symbolTable.cpp(755)/stringTable.cpp(876)/systemDictionary.cpp(3058)/dictionary.cpp(626)/classLoader.cpp/classLoaderData.cpp/moduleEntry.cpp(538)/packageEntry.cpp(352)/modules.cpp(729)/javaClasses.cpp(4586 行!)
- 常用实证: CodeEntryAlignment=32(globals_x86.hpp:49)、CompileThreshold C1=1500/C2=10000、NonNMethodCodeHeapSize=32M、**StringTableSize 默认 65536(globalDefinitions.hpp:483,非 60013!)**、FailOverToOldVerifier 默认 true(globals.hpp:518)、BytecodeVerificationLocal=false/Remote=true(globals.hpp:561-564)、FieldsAllocationStyle 默认 1(globals.hpp:940)

### 6.4 已完成的交叉引用关系(写作时保持一致性)
- 45→48;02→03→04;06 域链(06-01 对象头→06-06 Symbol)→ **07 域链**:
  - 07-01(ClassFile 解析,parse_stream 顺序/SymbolTable 批量分配)→ 07-02(Verifier,StackMapFrame/match_stackmap 帧匹配/frame_type 7 种)→ 07-03(SymbolTable+StringTable 两表对比)→ 07-04(SystemDictionary,六步解析/PlaceholderTable/Dictionary/constraints)→ 07-05(ClassLoader,双亲委派在 Java 层/CLD)→ 07-06(JPMS Modules,模块表 per-loader/包级导出/can_read)→ **07-07(javaClasses 镜像,收官)** → 09-memory-core
- **42 域链**: 42-01(JNI 工具层/属性)→ 42-02(进程管理: forkAndExec/fail pipe/reaper/ProcessHandle)→ 42-03(ClassLoader.c dlopen/io_util fd/TimeZone)→ 第 3 批 07
- 跨域: 42-03 的 libverify(VerifyFixClassname/VerifyClassCodes)在 07-02 老验证器呼应;07-01 的 Utf8→SymbolTable 批量分配在 07-03 呼应;07-04 的 load_instance_class 模块可见性在 07-06 呼应;06-03 的 CLASS_INJECTED_FIELDS 是 07-07 的入口;41 域 jimage 是 07-05 bootstrap 加载的来源之一

### 6.5 06-oops 域新增经验(2026-08-12,6 篇 60+ 处,接 6.1/6.2)
1. **规划期"发明"专有名词**(最危险,识别=必 grep 存在性): KlassLayoutHelper、MethodLinker、constantPoolOopDesc、"~20 种 Klass 子类"(实际 7 个)、_indy_bsm、_hash 字段、_holder_method——AI 规划时编造"听起来合理"的类/函数/字段名,行号查不出问题,名字本身是假的
2. **流传说法与源码相反**: SATB"增量更新"(实为 Snapshot-At-The-Beginning)、"OopHandle=OopStorage index"(实为 oop* 封装)、"WeakHandle=OopHandle+weak tag"(实为独立弱处理存储)、"invokevirtual 4 次 deref"(实为一条 movptr)、"as_C_string 不加 \0"(实为 null-terminated)、"SymbolTable 用 ConcurrentHashTable"(实为 RehashableHashtable+全局锁;StringTable 才是并发哈希)
3. **枚举/位布局是重灾区**: markOop 五种状态位布局全错、KlassID 顺序、FieldInfo 槽 4-5 低 2 位 tag(fieldInfo.hpp:55-62)、_init_state 6 态——凡"枚举顺序/位分配/编号"逐字对照定义,不能凭印象
4. **深审第 2 轮才抓到的"顺理成章"机制错误**: vtable"先复制父表再覆写/追加"(初稿"长度继承+归位")、SATB 入队路径、FastHashCode CAS 失败=膨胀成 monitor、biased_locking_enter 第一道位测试分流、ConstMethod 布局"结构之后"非"固定头之后"、find_blob 反查=段映射定位、FieldStream 不含父类字段
   - **识别信号**: 正文里"所以/为什么能这么做/自然"开头的推导段最可疑——那是写作时凭直觉补的,必须回源码找依据
5. **覆盖率缺口**: 写完对照"上篇悬念承诺话题"逐条勾选;跨篇悬念行是最可靠的大纲
6. **"语义方向反了"独立模式**: 带否定词的描述("不/没有/无需")重点核,先假设它是错的,再去源码找真相
7. **跨篇矛盾提前发现**: 大纲与已有文章矛盾时,以已有文章+源码为准
8. **同域两表对比必查实现**: SymbolTable(全局锁)vs StringTable(并发哈希)——写对比时两个实现都要验证

### 6.6 错误根因(为什么"每篇 2-15 处"不可避免)
1. 大纲是规划期 AI 生成,"像真的"的编造是最危险形态——名字合理、机制自洽,唯独源码里不存在
2. 写作期大脑默认路径: 大纲说法"合理"→直接写,而不是"每个机制先 grep 再写"(铁律 ② 的对抗者)
3. 自查脚本只能抓"写错"(行号/代码块/数字),抓不了"写对但机制是编的"——机制正确性只能靠人工深审,且第 1 轮常被自己的叙述带着走,第 2 轮逐条质疑才有效
4. 结论: **深审必须 2 轮**;沉淀要即时(本篇教训进 §6.1/6.2 后再写下一篇)

### 6.7 16-codecache 域经验(01-05 篇,2026-08-12)——略(已完结域,详见前版 HANDOFF git 历史)
### 6.8 38-perfdata 域经验(2026-08-12)——略(已完结域)
### 6.9 41-zip-jimage + 42-core-native 域经验(2026-08-12)
- **41 域**: zip_util.c 在 java.base/share/native/libzip/(1658 行);jimage 在 java.base/share/native/libjimage/(imageFile.cpp 571 行,ImageHeader 28 字节/MPH 三态 redirect/get_resource 零拷贝);详情见 41-01/41-02 大纲 ⚠️ 块
- **42 域 01 篇(JNI 工具层/系统属性,大纲漂移 6 处)**: JNU_ThrowByName :51-57;JNU_NewStringPlatform 按 fastEncoding 分派(:860-876)非 NewStringUTF;JNU_GetDefaultEncoding 不存在;JNU_GetFieldByName 无 cache;user.home=getpwuid->pw_dir 非 getenv HOME(java_props_md.c:569-574);JVM_NativePath Unix no-op(jvm.cpp:697-701→os_posix.cpp:1486-1488);canonicalize_md.c 是 java.io.File 服务
- **42 域 02 篇(进程管理,大纲漂移 10 处)**:
  - **启动方式**: Linux 默认 VFORK、BSD/Solaris/AIX 默认 POSIX_SPAWN,FORk 仅属性覆写(ProcessImpl.java:90-98);mode=LaunchMechanism.ordinal()+1(:340);文件头 4 策略备忘录 ProcessImpl_md.c:51-99,"we cannot use posix_spawn ourselves because there's no reliable way to close all inherited fds" :69-71;forkAndExec :499+;管道建 :558-565;vforkChild :352-369(vfork :362,noinline :346-348,volatile resultPid);forkChild :382;spawnChild :391-476(posix_spawn :445,先清 FD_CLOEXEC :436-443)
  - **childProcess(childproc.c:316-400)**: 先关父端副本 :332-338→moveDescriptor stdin/stdout :342-346(:121-130=dup2+close,无临时 dup)→redirectErrorStream dup2(1,2) :348-351→fail 钉 fd3 :358-359+FD_CLOEXEC :377-378→closeDescriptors :80-119(/proc/self/fd 遍历关 ≥6,先关 4,5;fallback sysconf :365-371)→chdir :374-375→JDK_execvpe :234-308(按父进程 parentPathv 搜,注释 :252;vfork 模式逐目录 execve :215-219;ENOEXEC→/bin/sh :187-204)
  - **fail pipe 成败协议**: 成功=write 端 CLOEXEC 自动关=EOF;失败=errno 回传+_exit(-1)(WhyCantJohnnyExec :382-399);父侧 close(fail[1]) :608 后 readFully :634-643;posix_spawn 多 alivePing(65535,JDK-8223777,:579-589/611-632;child :322-327);exec 成功 fd 回写 :645-647→initStreams(ProcessImpl.java:373-407)+processExited 榨干残留(:657-700)
  - **ProcessHandle(Linux)**: isAlive0(ProcessHandleImpl_unix.c:387-394)=os_getParentPidAndTimings(ProcessHandleImpl_linux.c:74-132:fopen /proc/pid/stat,strchr '('+strrchr ')' :108-118,sscanf ppid(4)/utime(14)/stime(15)/starttime(22) :122;startTime=bootTime_ms+ticks :129);**kill(pid,0) 仅 Solaris/AIX**(unix.c:666);unix_getChildren :508-615(opendir :546/atoi :576;pid==0=全部 :583);destroy0 :312-327=kill+**startTime 比对防 pid 复用**;waitForProcessExit0 :231(waitpid :245;128+signum :254-260)
  - **reaper 线程**: ProcessHandleImpl.completion(ProcessHandleImpl.java:123-181);"process reaper (pid N)" daemon MAX_PRIORITY 128KB(:54,:84-107);ProcessImpl.waitFor 只是 monitor wait(:493-498);NOT_A_CHILD=-2 轮询 startTime 变化(:149-166);pid 复用防护体系: isAlive :388-391/children :413/Info.info :587-598
  - 实证: 42-process-demo.txt(exitValue=7;destroy→143)+42-process-reaper-thread.txt
- **42 域 03 篇(ClassLoader+I/O+TimeZone,大纲漂移 12 处含 5 处机制编造)**:
  - **dlopen 在 hotspot**: JVM_LoadLibrary=jvm.cpp:3448→os::dll_load os_linux.cpp:1872→dlopen_helper :2106-2125(::dlopen RTLD_LAZY :2108,**无 RTLD_GLOBAL**);ClassLoader.c:354 是 NativeLibrary_load0(:337-406)调用点;**execstack 库在 safepoint/VMThread 修复栈保护页**(os_linux.cpp:1883-1927,dll_load_in_vmthread :2126-2152)
  - **load0 流程**: isBuiltin?procHandle:JVM_LoadLibrary(:354)→findJniFunction :290-330(**JNI_OnLoad_<库名> 仅 builtin**,cname 只传 isBuiltin :357-359;buildJniFunctionName jni_util_md.c:53)→无入口 0x00010001(:365)→JVM_IsSupportedJNIVersion(:378-389)→handle :400/jniVersion :390(javadoc ClassLoader.java:2406-2412);**native 方法按需动态链接**(实证 jni+resolve)
  - **defineClass1**: JVM_DefineClassWithSource(:136)非 JVM_DefineClass;malloc+GetByteArrayRegion :106/:113;VerifyFixClassname :123(把 . 翻译成 /,check_format.c:256);defineClass2 ByteBuffer 版 :173
  - **fd 体系**: GET_FD/SET_FD 宏在 io_util_md.h:53-59;IO_fd_fdID 由 FileDescriptor.initIDs 缓存(FileDescriptor_md.c:51-57,"fd" "I" int;**Windows 版 GetLongField+IO_handle_fdID**);io_util.c 无 getFD/setFD;IO_Read/IO_Write=别名宏(:70-71),EINTR 重试在 handleRead/handleWrite(RESTARTABLE io_util_md.c:166-180);fileOpen 剥尾部斜杠 :101-106;handleOpen 目录→EISDIR :82-86;fileDescriptorClose 先置 -1 再关(:137-143)+0/1/2 重定向 /dev/null(:147-160)
  - **TimeZone**: getSystemTimeZoneID/getSystemGMTOffsetID=Java_java_util_TimeZone_xxx(TimeZone.c:40/67);TimeZone_md.c 实际函数 findJavaTZ_md :793-850/getPlatformTimeZoneID :251-354/getGMTOffsetID :855-901;链路: user.timezone 属性(TimeZone.java:660-697)→TZ 环境变量(:800-805)→/etc/timezone fgets(:269-285)→/etc/localtime lstat 三态(:288-353:symlink→readlink+getZoneName/普通文件→findZoneinfoFile :123-195 全目录比对 isFileIdentical :203-243 大小+memcmp,跳过 .开头/ROC/posixrules/localtime :154-176,UTC/GMT 快速路径 :132-147)→GMT;":" 前缀 :809-811+posix/ :814-816;getGMTOffsetID=localtime_r/gmtime_r 比较(:873-880)+strftime %z(:893-898)
  - 实证: 42-classio-tz.txt+42-classio-jnionload.txt

### 6.10 07-classfile-classloader 域经验(2026-08-12,01-06 篇,第 3 批,重点沉淀)
- **07-01(ClassFile 解析,大纲漂移 12 处含 2 处编造)**:
  - **parseClassFile 函数不存在**(编造): 入口链=KlassFactory::create_from_stream(klassFactory.cpp:166-226,JVMTI ClassFileLoadHook :184-188)→ClassFileParser 构造(:5879,**构造内 parse_stream :5995-5997+post_process_parsed_stream**)→create_instance_klass;parse_stream :6074-6308(magic :6084/版本 :6090-6091/verify_class_version :4881-4930/cp :6125/access_flags :6130/this_class :6162/super :6252/interfaces :6259/fields :6268/methods :6277/属性 :6293/at_eos :6314-6316)
  - **FieldLayoutBuilder 不存在**(编造): 布局在 ClassFileParser::layout_fields(:3934,:6411);**字段排列顺序默认 oops 排最后**(FieldsAllocationStyle 默认 1,globals.hpp:940;注释 :4072;style 0 才 oops 在前,硬编码类 :4038-4043)
  - FieldAllocationType **五类桶**(oop/byte/short/word/double,static+nonstatic,:1453-1466);常量池 15 种 tag(Long/Double 双槽 :256-266;Utf8→verify_legal_utf8 :298-301+SymbolTable 批量分配 :314/:323-329;版本门槛 51/55 verifier.hpp:40-42);unresolved_klass_at_put :490(**只登记不解析**)
  - parse_fields :1541(FieldInfo 六槽 fieldInfo.hpp:69;injected fields=JavaClasses::get_injected **:1563-1566**(07-07 REVIEW 行号修正,原 1575-1578 漂移 12 行),CLASS_INJECTED_FIELDS javaClasses.hpp:**216-223**——07-07 的入口!);parse_method :2344(<clinit> 51 起必须 static :2366-2379;Code 属性 :2467 起,max_stack 45.2 兼容 :2483-2492,code_start 不拷贝 :2502);parse_classfile_attributes :3440(BootstrapMethods :3596/NestMembers :3627/NestHost :3640)
  - post_process_parsed_stream :6321(传递接口 :6378/vtable 大小 :6394/itable :6405/layout_fields :6411);fill_instance_klass :5598(add_class :5609/apply_parsed_class_metadata :5632/断言 :5635/析构 :6015);classfile_parse_error=ClassFormatError(classFileError.cpp:36);classFileStream.hpp(get_u2/u4_fast :101-112 大端/guarantee_more :88/at_eos :141)
  - 实证: 07-classfile-javap.txt+07-classfile-header-load.txt(CDS shared objects file)
- **07-02(Verifier,大纲漂移 11 处含 3 处编造)**:
  - **验证在链接阶段非加载时**: InstanceKlass::verify_code(instanceKlass.cpp:686)→link_class_impl :790(rewrite_class :793 之前);入口 Verifier::verify(verifier.cpp:140)→ClassVerifier::verify_class(:603,跳 native/abstract/overpass)→verify_method(:630);**verify_code 函数不存在**(编造)
  - **OperationStack 不存在**(编造): 真实=StackMapFrame(stackMapFrame.hpp:43-61,_locals/_stack=VerificationType 数组);帧匹配=StackMapTable::match_stackmap(stackMapTable.cpp:71-123,注释四组合 :78-87: match=is_assignable_to/update=copy 替换——check 不 inference);is_assignable_to(stackMapFrame.cpp:158)/is_assignable_from(verificationType.hpp:267)
  - **老验证器仍在**: inference_verify(verifier.cpp:274)=dlsym libjava VerifyClassCodesForMajorVersion/VerifyClassCodes(:66-89);**<50 直接走老验证器**(:198-201),≥50 新验证器+<51 才可 failover(NOFAILOVER=51 :58)
  - **frame_type 7 种**(stackMapTableFormat.hpp:159-165): 0-63 same(:229)/64-127 same_locals_1_stack_item(:334)/**247=stack_item_extended(:407)非 same_frame_extended**/248-250 chop(251-tag,:484)/**251=same_frame_extended(:276)**/252-254 append(tag-251,:555)/255 full(:660);ITEM 0-8(verificationType.hpp:36-46,**Uninitialized=8 非 NewObject**,带 bci)
  - parse_verification_type(stackMapTable.cpp:184-218): Object 取名字不解析/Uninitialized 校验 NEW_OFFSET(generate_code_data verifier.cpp:1763-1784);invoke 统一 verify_invoke_instructions(:2491);verify_stackmap_table :1858;STACKMAP_ATTRIBUTE_MAJOR_VERSION=50
  - 实证: 07-classfile-verification-log.txt+07-classfile-stackmap-javap.txt(253 append/16 same/250 chop)
- **07-03(SymbolTable+StringTable,大纲漂移 10 处含 4 处机制错;06-06 已拆 Symbol 本体,本篇只补锁语义+StringTable 为主角)**:
  - **SymbolTable**: RehashableHashtable+全局 SymbolTable_lock;lookup(symbolTable.cpp:319-334)=先无锁查 miss 才 MutexLocker basic_add(:329-334);hash_symbol(:286-290)=java_lang_String::hash_code 或 AltHashing::halfsiphash_32;unlink(:147-155)buckets_unlink+bulk_free_entries 批量释放;**rehash_table(:184-203)是换种子重建表非回收**
  - **StringTable**: 表=ConcurrentHashTable<**WeakHandle**>(stringTable.hpp:42-43)+OopStorage _weak_handles(:71);intern 链=JVM_InternString(jvm.cpp:3501-3509)→StringTable::intern(:312-328,lookup_shared CDS→do_lookup→do_intern)→do_intern(:354-380:create_from_unicode(javaClasses.cpp:263-285,CompactStrings latin1→**value 永远 byte[]**,UTF-16 长度翻倍——07-07 REVIEW 修正"byte[]/char[] 两态"说法;basic_create :252-253)+deduplicate_string(:365-367,入表后禁 dedup)+get_insert_lazy+rehash 预警)
  - GC: unlink_or_oops_do(:402-417)=weak_oops_do 死项清除+活项修引用;oops_do(:419-422);possibly_parallel_unlink(:429);维护: check_concurrent_work(:520-537)三条件→concurrent_work(:538-550,**grow 优先**顺带清死项)→grow(:455);**StringTableSize 默认 65536(globalDefinitions.hpp:483,非 60013)**
  - 实证: 07-classfile-stringtable-log.txt(Concurrent work triggered live 3.05/dead 1.53+Grown 131072=65536×2+intern 语义)
- **07-04(SystemDictionary,大纲漂移 10 处含 2 处编造)**:
  - **六步解析**(resolve_instance_class_or_null :629-830,大纲"三步走"严重简化): ①dictionary->find 带 pd(:653)②非 parallelCapable 拿**类加载器对象锁** ObjectLocker(:678)③锁内 find_class 复查(:694)④placeholder super_load_in_progress→handle_parallel_super_load(:701-713)⑤LOAD_INSTANCE 占位(:792)+load_instance_class(:819)+check_constraints/record_dependency/update_dictionary(:826-836)⑥清理占位(:859)+protection domain 校验(:883-889);**查字典共 4 次**(:653/:694/:775/:800);入口 resolve_or_null :244(数组/对象剥壳/普通)
  - **PlaceholderTable(大纲未提,核心)**: Hashtable<Symbol*>(placeholders.hpp:37);LOAD_INSTANCE/LOAD_SUPER;bootstrap 在 SystemDictionary_lock wait(:768);check_seen_thread→ClassCircularityError(:759,:813);RedefineClasses 靠占位符(:734)
  - **load_instance_class :1403**: bootstrap→模块可见性检查(:1407-1445)→CDS load_shared_class(:1468)→ClassLoader::load_class→find_or_define_instance_class;用户 loader→JavaCalls::call_virtual 调 **Java 层 loadClass**(:1519-1530)
  - **define_instance_class :1555**: check_constraints(:1577)→loader_addClass(:1580-1587)→add_to_hierarchy(:1593-1599)→update_dictionary(:1600-1603)→eager_initialize(:1605);**"allocate KlassID" 编造**
  - **Dictionary : Hashtable<InstanceKlass*, mtClass>**(dictionary.hpp:42,非 Symbol-Klass);per-loader(ClassLoaderData 各一张,:50);find 带 pd 过滤(dictionary.cpp:334-345);check_constraints 两层(:2093-2155): ①同 loader 重复定义→LinkageError②LoaderConstraintTable 全局(check_or_update loaderConstraints.cpp:286-313);record_dependency(:836-840)
  - 实证: 07-classfile-dictionary-log.txt(双 URLClassLoader 同名加载两次/la==lb false)
- **07-05(ClassLoader,大纲漂移 9 处含 4 处机制错)**:
  - **三层在 Java 层非 C++**: ClassLoaders.java(PlatformClassLoader :126/AppClassLoader :151,继承 BuiltinClassLoader;platformClassLoader() :96/appClassLoader() :103);**bootstrap 不是 ClassLoader 实例**(getClassLoader()==null;platform.parent==null 约定,BuiltinClassLoader.java:157-158)
  - **双亲委派=Java 层 ClassLoader.loadClass**(ClassLoader.java:571-607): getClassLoadingLock 同步→findLoadedClass→parent.loadClass/findBootstrapClassOrNull→findClass→resolve;BuiltinClassLoader.loadClassOrNull(:590-634)模块化变体;**"load_class: find_loaded→parent->load_class→find_class" 是 JDK 8 C++ 旧流程**
  - C++ 侧 ClassLoader::load_class(classLoader.cpp:1406)=bootstrap 实现(patch-module→jimage→bootclasspath/a+classpath;**无 rt.jar/loadZipJar**);CDS 在 SystemDictionary::load_instance_class(:1468)先拦;安全模型=preDefineClass(ClassLoader.java:891-899: java. 前缀+**非 Platform**→SecurityException)
  - CLD: do_unloading(classLoaderData.cpp:1373): is_alive(:696-701,**keep_alive 计数||_holder 弱句柄,无 JNI 强引用检查**)→free_deallocate_list/死→unload()(:597,标记+清 deallocate+通知 JVMTI)+链表移除(:1394-1412);**_keep_alive 专属于匿名类**(classLoaderData.cpp:149,:285-300,inc/dec 只对 is_anonymous :295/:302)非"JNI 引用"
  - 实证: 07-classfile-loader-hierarchy.txt(三层链+custom.loadClass(String)==String.class true)
- **07-06(JPMS Modules,大纲漂移 10 处含 3 处编造)**:
  - **ModuleEntry : HashtableEntry<Symbol*, mtModule>**(moduleEntry.hpp:63);字段 :65-77(_module OopHandle=Java Module 弱句柄/_reads GrowableArray/_is_open/_has_default_read_edges JVMTI/_is_patched);**无 _exports/_uses**(编造)——导出在包级
  - **ModuleEntryTable : Hashtable<Symbol*>**(moduleEntry.hpp:208)+静态 _javabase_module(:216);**模块表 per-loader**(ClassLoaderData._modules,classLoaderData.hpp:252)非全局;java.base 条目启动早期预置(moduleEntry.hpp:198-206);can_read(moduleEntry.cpp:116-140): 无名读所有/所有读 java.base(:121-125)/JVMTI 默认读边(:130-136)/_reads 列表
  - **PackageEntry**(packageEntry.hpp:97): _module/_export_flags/_qualified_exports(:99-107);状态 is_exported(:134)/is_qual_exported/has_qual_exports_list(名单清空仍算导出防回退)/is_exported_allUnnamed/is_unqual_exported(:141-160);set_exported(packageEntry.cpp:91-110,unqual 不可转 qual :95-96)/set_is_exported_allUnnamed(:111-123,PKG_EXP_ALLUNNAMED);**is_exported_to 函数不存在**(编造)
  - **--add-exports 链路**(大纲误植 set_has_default_read_edges): ModuleBootstrap.java:646-730(处理 :652)→Modules.addExportsToAllUnnamed(:724)→JVM_AddModuleExportsToAllUnnamed(jvm.cpp:1024-1026)→set_is_exported_allUnnamed;检查在 Java 层(Reflection.verifyModuleAccess Reflection.java:203-212→Module.isExported :212,Module.java:453);字节码级=linkResolver.cpp:310-325(IllegalAccessError+verify_class_access_msg);加载侧=load_instance_class 模块可见性(07-04)
  - 实证: 07-classfile-modules.txt(IllegalAccessException "module java.base does not export jdk.internal.misc to unnamed module"↔--add-exports 后 addressSize()=8)
- **07-07(javaClasses 核心类镜像,07 域收官,大纲漂移 8 处含 4 处机制编造/错)**:
  - **镜像模式**: 每个核心 Java 类一个 AllStatic 镜像类(BASIC_JAVA_CLASSES_DO javaClasses.hpp:50-85 共 **31 个**: PART1 Class/String + PART2 29 个);偏移=启动时 find_local_field 一次(compute_offset javaClasses.cpp:121-144,找不到→vm_exit_during_initialization);两阶段: String/Class 在 resolve_well_known_classes(systemDictionary.cpp:2012-2015)先算,其余 29 个在 javaClasses_init→JavaClasses::compute_offsets(:4463-4482)+update_delayed_values(:4481,interpreter_init init.cpp:117 早于 javaClasses_init :125 的延迟常量补丁通道,jdk11u 模板表未实际使用)
  - **"eetop 存 pthread_t" 错(编造)**: eetop=**JavaThread\* 指针**(:1641-1648 address_field);声明在 Thread.java:158("Fields reserved for exclusive use by the JVM")非注入字段;绑定先于 Java 构造器(create_initial_thread thread.cpp:1088-1102,注释: Thread 构造器调 Thread.current() 必须先有 eetop);退出清 NULL→is_alive false(:1885-1890);**jstack 一行三 ID**: #1=Java 层 tid 字段(thread_id :1753-1760,非 eetop!)、tid=JavaThread 地址(thread.cpp:923)、nid=pthread_t(osThread.cpp:41-42)——实证 42-process-reaper-thread.txt:13
  - **isAlive 链路(无 Java 调用)**: Thread.java:1051 native→Thread.c:46→JVM_IsThreadAlive(jvm.cpp:2987-2992)→is_alive(:1687-1690 判 eetop 非空);threadStatus=JVMTI 状态位组合(javaClasses.hpp:407-434)
  - **String**: value(byte[])/coder(LATIN1=0/UTF16=1,:107-111)/hash;is_latin1/length 在 javaClasses.inline.hpp:67-87(UTF16 >>1);C2 load_String_length=数组长度>>coder(graphKit.cpp:3887-3893,value_offset 直接入地址 :3895),Java 层 String.length() 同逻辑(String.java:658);StringDedup(stringDedupTable.cpp:345-393): value()/is_latin1()/hash 字段缓存(:361-375 先查后写,与 String.java:156 共享)/set_value 替换数组(:390)
  - **"klass 字段存 compressed Klass* 再 decode" 错**: 存**全宽 Klass\***,as_Klass :1390-1396 用 metadata_field(oop.hpp:163,HeapAccess 直读,无窄指针编解码);getClass 链路=Object.java:72→jni_GetObjectClass(jni.cpp:1292-1300)→obj->klass()->java_mirror()(与 as_Klass 反方向;06-02 的 _java_mirror klass.hpp:139)
  - **CLASS_INJECTED_FIELDS 在 :216-223 非 1562+**(1562 是 ALL_INJECTED_FIELDS);注入字段共 **14 个**(Class 7+ClassLoader 1+ResolvedMethodName 2+MemberName 1+CallSiteContext 1+StackFrameInfo 1+Module 1);may_be_java=false→JVM_ACC_FIELD_INTERNAL(fieldInfo.hpp:240);偏移走 _injected_fields 表(:85-87)+InjectedField::compute_offset(:4558-4580,AllFieldStream);compute_offsets :1545-1561(CLASS_FIELDS_DO :1538-1544 + 注入;init_lock/component_mirror C union :1555-1558)
  - **mirror 可变大小**: create_mirror(:894+)=InstanceMirrorKlass::allocate_instance(instanceMirrorKlass.cpp:48-56,静态字段住镜像);oop_size/static_oop_field_count 自描述(:1279-1291 写/:58-60 读);initialize_static_field 写静态初始值(:744-789);fixup_mirror_list+Universe::fixup_mirrors(systemDictionary.cpp:2023)
  - 悬念→09-memory-core/01(Universe+CollectedHeap: 镜像分配在哪/堆怎么诞生)

### 6.11 09-memory-core 域经验(2026-08-13,01 篇,第 3 批,大纲 15 处漂移含 6 处机制编造/错)
- **时序(大纲全错)**: init_globals(init.cpp:101)里 **universe_init(:111)建堆**→universe2_init(:124)调 **Universe::genesis(universe.cpp:321-462)造第一批对象**→javaClasses_init(:125);genesis 不在 init_globals 直接调,`_verify_in_progress` 与 genesis 无关(:127 是 verify 开关 :1200-1264);**create_heap 在 universe_init 非 genesis**(initialize_heap :687/:766→Universe::create_heap :752-755→GCConfig::arguments()->create_heap(),gcConfig.cpp:237,gcArguments.hpp:41 纯虚→G1Arguments::create_heap g1Arguments.cpp:151-153);GC 选择=GCConfig::select_gc(gcConfig.cpp:146-183),ergonomics(:102-114)=**server-class→UseG1GC 否则 UseSerialGC**;new 只是 C++ 壳,**虚拟内存 reserve 在 G1CollectedHeap::initialize(g1CollectedHeap.cpp:1533+,"Reserve the maximum" :1556)**
- **genesis 依赖序(大纲未提)**: compute_base_vtable_size(:331,:1115-1117=ClassLoader::compute_Object_vtable)→**TypeArrayKlass::create_klass×8(:334-341 数组 Klass 先于一切,vtable 长度继承 Object)**→_typeArrayKlassObjs(:343-350)→Metaspace 空数组(MetadataFactory::new_array :354-358)→vmSymbols::initialize(:362)→SystemDictionary::initialize(:364)→initialize_basic_type_mirrors(:464-509,9 个基本类型镜像 create_basic_type_mirror :478-495,**int.class 是 C++ 造的**)+fixup_mirrors(:511-534,"Bootstrap problem" 注释 :512-515,消化 javaClasses 的 fixup_mirror_list)→initialize_basic_type_klass×8(:306-317/:387-394,super=Object 挂层次)→_objectArrayKlassObj(:414-415)=Object_klass()->array_klass(1);_the_null_string/_the_min_jint_string(:368-369,ciEnv 复用 ciEnv.cpp:322-330)
- **"new int[0] 返回预分配" 错(编造)**: genesis 的 _the_empty_*_array 是 **Metaspace 的 Array<T>**(C 数组)非堆对象;堆上预分配空数组只有 the_empty_class_klass_array(universe.cpp:1018,**用途=method.cpp:733 无 checked exception 的规范空 Class[]**);the_array_interfaces_array=数组类共享接口清单(填 Cloneable/Serializable :383-384)
- **"genesis_oop 函数" 不存在(编造)**
- **"oopFactory::new_instance/new_symbol" 不存在(编造)**: oopFactory.hpp:44-58 只有 8 个 type array 工厂(全部依赖 Universe::xxxArrayKlassObj)+new_objectArray/new_typeArray/new_objArray;oopFactory 客户=systemDictionary.cpp:1916 new_intArray(0) 系统类加载器锁对象
- **CollectedHeap 在 share/gc/shared/collectedHeap.hpp:104 非 share/memory/heap.hpp**(heap.hpp 是 **CodeHeap**!);家族注释 :94-102;mem_allocate(:159-160 纯虚单对象)/allocate_new_tlab(:145-149 **三参数** min/requested/actual)/collect(:398)/object_iterate(:443)/safe_object_iterate(:447)/gc_cause(:299)/total_collections(:419)
- **分配链(大纲"oopFactory→TLAB→G1Allocator"错)**: MemAllocator(share/gc/shared/memAllocator.cpp)allocate(:373-389)→mem_allocate(:362-369 TLAB 分派)→inside_tlab(:284-295 bump)→slow(:297+: **剩余>refill_waste_limit 放弃慢路径走 TLAB 外** :309-311,否则换新 TLAB :324)→outside_tlab(:270-281 heap->mem_allocate)→G1 attempt_allocation_humongous(:404)/attempt_allocation(:407);对象头=finish(:396-408 prototype_header mark+**release_set_klass**);System.gc 终点=JVM_GC(jvm.cpp:457-460)→heap()->collect(_java_lang_system_gc)
- **non_oop_word**(universe.cpp:656-672)=os::non_memory_address_word()|1,**用途=compiledIC 内联缓存空目标占位**(compiledIC.cpp:61-63/:120),非"narrow oop 最高位编码"(编造)
- **预分配 OOME(大纲未提)**: universe_post_init(universe.cpp:1002+)6 个(:1020-1029)+delayed SOE 消息(:1032-1034);gen_out_of_memory_error(:615-650)=**池机制**(PreallocatedOutOfMemoryErrorCount,取池+搬消息+填栈帧,池尽退回默认)
- iterator.hpp: OopClosure :52-56(do_oop oop*/narrowOop* 双纯虚)/ObjectClosure :161-165(do_object)
- 实证: 无新素材(纯源码推导,系统属性/JFR 已有素材未引用)
- **09-02(VirtualSpace,大纲 12 处漂移含 5 处机制编造/错)**:
  - **reserve 真相**: anon_mmap(os_linux.cpp:3838-3855)=MAP_PRIVATE|MAP_NORESERVE|MAP_ANONYMOUS+**PROT_NONE 整段**(防未提交页误触隐蔽泄漏);granularity=Linux **page_size(4K)**(:3126-3129)非 64KB;ReservedSpace::initialize(virtualspace.cpp:120-232): alignment=MAX2(alignment,page_size) :131,requested_address→attempt_reserve_memory_at :193
  - **"10 次重试" 编造**: 对齐=**超额保留+手动对齐+两侧释放**(os::reserve_memory_aligned os_posix.cpp:287-340: reserve size+alignment→align_up :315→释放 begin/end :327-334)一次搞定
  - **noaccess_prefix 只属 ReservedHeapSpace**(virtualspace.cpp:301-327): 触发=base+size>OopEncodingHeapMax(:305,=2^32<<LogMinObjAlignmentInBytes 默认 32GB,arguments.cpp:1609)→基址下 PROT_NONE lcm(page,alignment)(:297)→_base+=prefix(:324-325);动机=压缩 oops 隐式 null 检查;普通 ReservedSpace._noaccess_prefix 恒 0
  - **VirtualSpace 三段=三种提交粒度**(virtualspace.hpp:152-158 MPSS): lower/upper 普通页+middle 大页(:704-706);expand_by(**无 is_lower 参数**)=size+pre_touch,顺序 lower→middle→upper(:906-925,跳段割裂大页物理地址,注释 :833-842);shrink_by 从 high 先 upper(:980-1000);初始 commit=expand_by(committed_size)(:723-726)非"只有 lower";_special 只挪指针(:856-860/:939-943)
  - **"uncommit=madvise MADV_DONTNEED" 错**: =mmap(PROT_NONE,MAP_PRIVATE|MAP_FIXED|MAP_NORESERVE|MAP_ANONYMOUS)(os_linux.cpp:3641-3645);commit=mmap(MAP_FIXED|MAP_ANONYMOUS,PROT_READ|WRITE±EXEC)(commit_memory_impl :3209-3218)
  - **"CodeCache 用 VirtualSpace 三段" 错(张冠李戴)**: CodeCache=三个独立 CodeHeap(codeCache.hpp:89-92);VirtualSpace 用户=**Metaspace VirtualSpaceList**(metaspace/virtualSpaceList.hpp:39,metaspace.cpp:372);GC heap=ReservedHeapSpace+region 管理
  - **"HeapRegion 是 MemRegion 子类" 错**: HeapRegion : public G1ContiguousSpace(heapRegion.hpp:191);MemRegion=start+word_size 值类型(memRegion.hpp:48-49,:36-40 注释)
  - 悬念→03-arena-resourcearea-allocation(VirtualSpace 之上谁切小块/管理归还: Arena+ResourceArea)
- **09-03(Arena+ResourceArea,09 域收官,大纲 10 处漂移含 5 处机制编造/错)**:
  - **Chunk 四规格**(arena.hpp:55-70,**故意比 2^k 略小防 buddy 合并**): tiny=256-slack/init=1K-slack/medium=10K-slack/size=32K-slack;**首个 chunk 是 init_size 非 32K**(Arena 构造 :244-251);字段=_first/_chunk/_hwm/_max(:102-104);Amalloc(arena.hpp:144-159)=ARENA_ALIGN(16B)+overflow check+bump;grow(arena.cpp:360-383)=new Chunk→operator new 按长度匹配四池(:198-216);Afree 通常 NOP 仅最后一块回退(:202-210);析构=destruct_contents→chop 链还池(:309-323/:230-239)
  - **ChunkPool 四静态池**(arena.cpp:49-52 large/medium/small/tiny): allocate(:75-88,ThreadCritical)/free(:91-103);**take_chunk/give_chunk 不存在**;ChunkPoolCleaner 5 秒 free_all_but(5)(:140-146/:169-181)
  - **ResourceArea : Arena**(resourceArea.hpp:44)per-thread(thread.hpp:506,bias_to mtCompiler thread.cpp:3447);**ResourceMark 回滚含 next_chop 还块**(reset_to_mark :128-149,流传"只回指针"半对);allocate_bytes nesting 检查防泄漏(fatal "memory leak")(resourceArea.inline.hpp:31-43);**rollback(0) 不存在**
  - **NMT MallocHeader=16 字节非 64**(mallocTracker.hpp:246,assert sizeof==2 指针 :263);**调用栈不内嵌**,_pos_idx/_bucket_idx→MallocSiteTable 索引查回(get_stack mallocTracker.cpp:92-94);AllocateHeap(allocation.cpp:39-49)=os::malloc+EXIT_OOM
  - **GuardedMemory canary=badResourceValue 0xAB 非 0xBAADF00D/0xDEADBEEF**(globalDefinitions.hpp:1012,Guard::build/verify :96-112);GUARD_SIZE=16;**guarded_malloc 不存在**——wrap_copy/free_copy(guardedMemory.cpp:31-54)+verify_guards(:212)
  - **大纲"GC marking bitmap 用 Arena"不准**: G1 bitmap 是 G1CMBitMap(独立 mapper);GC 真实用户=并发标记任务 ResourceMark(g1ConcurrentMark.cpp:833/1548/1578/1835)
  - 悬念→10-metaspace/01(jdk11u **无 MetaspaceArena**(JDK15+ 术语),结构=VirtualSpaceNode→ChunkManager→Metablock)
- **17-01(Thread 层次体系,第 3 批第三个域开篇,大纲 9 处漂移含 3 处机制错)**:
  - **Thread 基类**(thread.hpp:115): TLS _thr_current(:122)/_gc_data(:129)/**SMR hazard ptr 字段(:157-182,ThreadsList* volatile 在基类)**/_polling_page(:346)/_tlab(:348)/omFreeList-omInUseList(:369-373)/_suspend_flags(:204-243 external suspend+async exception 合并)/_rcu_counter(:315,GlobalCounter=读侧 critical_section_begin 记全局 counter+写侧 write_synchronize,globalCounter.hpp:30-42);operator new→allocate(mtThread) C-Heap(:185-191)
  - **Thread::current() 三兄弟**(thread.hpp:794-817 inline): current=current_or_null+assert;current_or_null=compiler TLS;current_or_null_safe=**library TLS**(threadLocalStorage.hpp:41-48,信号 handler 全平台走它,:31-36 注释);定义 thread.cpp:171
  - **启动四段(大纲"thread.cpp:120-150"全错)**: ①JavaThread 构造 os::create_thread(thread.cpp:1758,pthread_create os_linux.cpp:1007,挂起)②Thread::start(:488-502)=**java_lang_Thread::set_thread_status(RUNNABLE)**(07-07 镜像)+os::start_thread③thread_native_entry(os_linux.cpp:770+): 栈边界 :772/initialize_thread_current :789/**set_thread_id 存 nid :794**/父子握手 :810-819(置 INITIALIZED+notify+wait,os::start_thread os.cpp:884-890 SR_lock 置 RUNNABLE 唤醒)④call_run(thread.cpp:370-401 虚 run,:389-390 run 后可能自删)→JavaThread::run(:1818+ transition_and_fence _thread_new→_thread_in_vm :1832)→thread_entry(jvm.cpp:2844 JavaCalls 虚调 Thread.run())
  - **JavaThread**(thread.hpp:952): _next :957(Threads 列表)/_threadObj :960/_anchor :984(JavaFrameAnchor)/_deopt_nmethod :995/_vframe_array_head :996/_vm_result+_2 :1015-1016/_monitor_chunks :1023/_pending_async_exception :1034/_thread_state :1038/_safepoint_state :1040;**CompilerThread : JavaThread(:2129)——编译器线程是 Java 线程!(流传"非 Java 线程"错)**
  - **NonJavaThread(:819)**: _next :822+Iterator :840;NamedThread(:857)子类=VMThread(vmThread.hpp:114)/ConcurrentGCThread(concurrentGCThread.hpp:31)/WorkerThread(:885);**WatcherThread : NonJavaThread(:902)非 NamedThread**,name="VM Periodic Task Thread"(:923);Thread::oops_do 只碰 JNI 活跃句柄/句柄区/异常(thread.cpp:876-884)
  - **OSThread(osThread.hpp:56)**: _start_proc/_start_parm(:58-59)/_state=ThreadState *hint*(:60)/_interrupted 必须 jint(:61,:63-67 注释)/_thread_id=pthread_t 可查 /proc(platform 段);**"OSThread._start_thread_lock" 不存在**
  - 悬念→02-javathread-state(状态机: 线程怎么告诉 JVM"我不能被 safepoint")
- **17-02(JavaThread 状态机,大纲 7 处漂移含 3 处机制错)**:
  - **JavaThreadState 枚举真相**(globalDefinitions.hpp:889-905): 五个真状态 **0/2/4/6/8/10**(uninitialized/new/in_native/in_vm/in_Java/blocked)+**每个 +1 的 trans 状态**(new_trans/in_Java_trans 未用);注释 "Given a state, the xxxx_trans state can always be found by adding 1";字段 thread.hpp:1038 volatile;PPC64/AARCH64 访问加 membars(:1262-1275)
  - **转换三拍(流传"set+fence"错)**: ThreadStateTransition::transition(interfaceSupport.inline.hpp:112-128)=写 **from+1 trans 状态**(:120)→serialize_thread_state(:122)=OrderAccess::fence 或 **write_memory_serialize_page 伪远程 membar**(:82-97 "Make sure new state is seen by VM thread")→**SafepointMechanism::block_if_requested(:124,检查点嵌转换)**→写 to(:125);transition_and_fence 差异=SEH 版 serialize(:136-148/:142);transition_from_java 不 block(:153-156)
  - **轮询=线程本地轮询(流传 mprotect 是 JDK11 前全局页机制)**: ThreadLocalHandshakes=true(globals_x86.hpp:100);SafepointMechanism(safepointMechanism.hpp:34-46)armed=poll_bit/disarmed=0;arm/disarm=set_polling_page(值)(inline:65-70);local_poll_armed=mask poll_bit(:32-35);JIT=safepoint_poll(macroAssembler_x86.cpp:3744-3756)=**testb [r15_thread+polling_page_offset],poll_bit+jcc,无 SIGSEGV**;**01-04 的轮询页信号分支=全局轮询路径(跨篇收敛,01-04 本身讲的是旧机制,建议后续 REVIEW 时修正 01-04 表述)**
  - **终止四态**(thread.hpp:1041-1058): _not_terminated=0xDEAD-2(:1045)/_thread_exiting/_thread_terminated/_vm_exited 仅 VM_Exit(:1050);退出=JavaThread::exit(thread.cpp:1902-2101,注释 :4334-4338)+ensure_join 在 exit 内部(:2015)+smr_delete(:208-213→ThreadsSMRSupport)
  - 悬念→03-thread-smr-handshake(hazard pointer 式回收)
- **17-03(Thread-SMR+Handshake,大纲 8 处漂移含 3 处机制错)**:
  - **ThreadsListHandle 在 threadSMR.hpp:272**(:37-84 是注释用法示例);SafeThreadsListPtr(:200 叶子 hazard ptr/嵌套引用计数);ThreadsList(:158 不可变快照,_next_list 串旧版);全局 _java_thread_list volatile(:108)+xchg_java_thread_list(:139);线程进出=造新版本换下旧的,旧版进 **_to_delete_list(:116,装快照非线程!)**
  - **无锁快路径**(SafeThreadsListPtr::acquire_stable_list_fast_path,threadSMR.cpp:384-427): 发布 tagged(:402-403)→重读校验(:408-411)→cmpxchg 去 tag(:416-421);**tagged 语义(大纲"tag=已扫描"错): tagged=未验证=扫描方可 CAS 置 NULL 作废(ScanHazardPtrGatherProtectedThreadsClosure :256-266),untagged=稳定=受保护(:270-271)**;tag 技巧 thread.hpp:162-170
  - **smr_delete**(threadSMR.cpp:944-1010): delete_lock+set_delete_notify(Atomic::inc :937-939)→is_a_protected_JavaThread(:966)→无人保护 break→delete thread(:1006);被保护→wait(:993-997)等 release_stable_list 唤醒;读者释放双检查(:471 起/:500-509 无锁读 delete_notify)
  - **Handshake**: HandshakeState(handshake.hpp:55-101);process_self_inner(handshake.cpp:417-434: trywait/wait_with_safepoint_check→load_acquire→**先 clear_handshake 再 do_handshake** :430→signal);try_process_by_vmThread(:481-516);**claim=_semaphore.trywait+复查(:470-479,大纲"CAS 独占"错)**;Handshake::execute(:381-389)=VM_HandshakeAllThreads(ThreadLocalHandshakes)
  - 悬念→04-interface-support(RAII 守卫: ThreadsListHandle/ThreadInVMForHandshake 这类状态转换守卫)
- **17-04(interfaceSupport,17 域收官,大纲 7 处漂移含 3 处机制编造/错)**:
  - **守卫家族**(interfaceSupport.inline.hpp): ThreadInVMfromJava(:224-237,构造 trans_from_java :227,析构 enable_stack_yellow_reserved_zone+trans 回+handle_special_runtime_exit_condition :235)/ThreadInVMfromNative(:266-274)/**ThreadToNativeFromVM(:277-294——大纲"ThreadInNativeFromVM"不存在方向反了**: make_walkable :283+trans_and_fence 出 :284)/ThreadBlockInVM(:297-309,make_walkable :302,注释 "Once we are blocked vm expects stack to be walkable",**无 cross_modify_fence(编造)**);变体=ThreadInVMForHandshake(:185-222,03 篇 Handshake 上下文,transition_back 恢复原状态 :188-204)+ThreadInVMfromJavaNoAsyncException(:315-337 不处理异步异常,注释 :325-330 处理就得 deopt)
  - **自挂起**: _suspend_flags 位值(thread.hpp:259-271: external 0x20000000/ext_suspended 0x40000000/deopt 0x10000000/async 0x1/critical 0x2/trace 0x4,避开符号位 CR 6398077);java_suspend_self(thread.cpp:2415-2461,大纲行号 1507-1536 错): walkable 断言 :2424-2426/SR_lock :2428/**双层 wait**(外层等请求清空 :2451,内层等 resume :2456-2457,注释 "change the stack out from under it" :2442-2450);java_suspend 只置位不等待(thread.hpp:223-225 注释)
  - **宏落点(大纲转换点示例编造)**: JNI_ENTRY 套 ThreadInVMfromNative(:515-522)/JRT_ENTRY 套 ThreadInVMfromJava(:468-474)/IRT_ENTRY 套 NoAsyncException(:460-466)
  - 悬念→域 18 Safepoint(第 4 批)
- **10-01(Metaspace 全景,第 4 批第一个域,大纲 8 处漂移含 3 处机制错)**:
  - **四层真实名字**: MetaspaceArena 是 JDK15+ 术语,jdk11u=**ClassLoaderMetaspace**(metaspace.hpp:237,per CLD,**两个 SpaceManager _vsm/_class_vsm :256-257**)+SpaceManager(spaceManager.hpp:43);链=L1 Metaspace::allocate(metaspace.cpp:1366-1414: mdtype 分流 :1378→metaspace_non_null :1386→satisfy_failed_metadata_allocation 触发 GC 重试 :1396→zero init :1413)/L2 ClassLoaderMetaspace(allocate :1572)/L3 SpaceManager::allocate_work(spaceManager.cpp:429-448: current_chunk bump :441→grow_and_allocate :173,humongous 不设当前 :204-210)/L4 ChunkManager(chunkManager.hpp:44)+VirtualSpaceList::get_new_chunk(virtualSpaceList.cpp:341→get_chunk_vs→expand)
  - **chunk 4 类**(metaspaceCommon.hpp:95-101): Specialized=128 words/Small=512(class 256)/Medium=8K(class 4K)/Humongous(:36-41)——大纲"8 种 1KB→4MB"错
  - **MetaspaceSize 默认≈5.2MB 非 20MB**(ScaleForWordSize(4*M)=4M*13/10,globals.hpp:41/:97);语义=**GC 触发阈值**非高水位(:1816-1819);MaxMetaspaceSize=max_uintx(:1821);CompressedClassSpaceSize=1G(:1825)
  - 阈值机制: _capacity_until_GC(metaspace.cpp:71)+inc_capacity_until_GC(:142)+compute_new_size(:235);Metaspace"GC"=借 Full GC 做 class unloading(07-05 的 do_unloading),归还 native memory 本身不需要 GC
  - class space: allocate_metaspace_compressed_klass_ptrs(metaspace.cpp:1074+),独立地址→narrowKlass decode=base+(index<<shift) shift=0 一次 add
  - 悬念→02-chunk-metablock-allocation(Metablock 空闲块复用)
- **10-02(Chunk+Metablock,大纲 7 处漂移含 4 处机制编造)**:
  - **chunk 4 类非 8 种**(metaspaceCommon.hpp:36-41/:95-101,10-01 已验证);Metachunk 字段真相(metachunk.hpp): _top :88/_sentinel MET :95/_chunk_type/_is_class :97-98/_is_tagged_free :100/_origin :102(ChunkOrigin normal/pad/leftover/merge/split :55-66)/_use_count;allocate=free_word_size>=word_size 才 bump(metachunk.cpp:72-80);overhead(:47-48)
  - **ChunkManager**: 三个固定粒度 ChunkList(chunkManager.hpp:50,NumberOfFreeLists=3)+Humongous ChunkTreeDictionary(:59-60);SpaceManager::get_new_chunk(spaceManager.cpp:383-399)=chunk_freelist_allocate(chunkManager.cpp:540)→空则 vs_list;split_chunk(:342,origin_split :372)
  - **BlockFreelist(大纲三档/merge_with_next 编造)**: SmallBlocks=按 word_size 分桶 FreeList 数组(smallBlocks.hpp:33-37,min=sizeof(Metablock)/max=sizeof(TreeChunk) :33-35)+BinaryTreeDictionary(blockFreelist.hpp:37/:43);return_block(blockFreelist.cpp:45-53): <max_size→桶否则字典;deallocate=SpaceManager::deallocate(spaceManager.cpp:322-331 懒建)
  - **空洞不触发 chunk 提前归还**: 归还=CLD unload 整组;Metablock 无 chunk 链接(metablock.hpp:36-41)
  - 悬念→03-virtualspace-arena-reclaim(expand/归还/退役)
- **10-03(VirtualSpace 与归还,10 域收官,大纲 7 处漂移含 2 处机制错位)**:
  - **归还链三步**(大纲"retire=uncommit+release"错位): **retire**(virtualSpaceNode.cpp:560-583)=把 Node 剩余空闲区从大到小切成标准 chunk 还 ChunkManager(:564-578,断言 free==0 :582),不碰虚拟内存;触发=**换新 Node 前 retire_current_virtual_space**(virtualSpaceList.cpp:141-147,:298-300)非"最后一个 chunk 归还后";**purge**(virtualSpaceList.cpp:74-125,safepoint :75,container_count==0 且非当前 :91→Node::purge 摘 chunk :75-88→delete vsl :109);**release**=~VirtualSpaceNode _rs.release()(:283)
  - **扳机**: ClassLoaderDataGraph::purge(classLoaderData.cpp:1455-1473,safepoint,delete 死 CLD :1466→Metaspace::purge() :1470→两空间 purge metaspace.cpp:1478-1487)
  - **expand_by**(virtualSpaceNode.cpp:467-493: uncommitted 检查 :472-474→commit→virtual_space()->expand_by :478);initialize(:500-526 对齐断言+initialize_with_granularity :516);take_from_committed(:369,padding :76)
  - **CDS 概要**: preload_and_dump(metaspaceShared.cpp:1632)/initialize_shared_spaces(:2100)/map_shared_spaces(:2034);"metaspaceShared.cpp:200-500/700-1000" 漂移(文件 2184 行)
  - 悬念→域 11 CDS(第 5 批)
- **19-01(synchronized 三级演化,第 4 批第 2 个域开篇,大纲 8 处漂移含 3 处机制错)**:
  - **承接 06-01**: markOop 锁位(locked=0/unlocked=1/monitor=2/biased=5)已讲,本篇补单向生命周期+deflate 唯一降级;fast_enter(synchronizer.cpp:264-280): revoke_and_rebias→BIAS_REVOKED_AND_REBIASED 返回否则 slow_enter,safepoint 时 revoke_at_safepoint
  - **revoke_and_rebias(biasedLocking.cpp:624,非 80-150)**: 三 CAS 快路径=匿名偏向(:633-642)/类原型残留(:647-660)/epoch 过期(:664+);update_heuristics(:321,Klass 级计数 :353-362);**BulkRebias=20/BulkRevoke=40**(globals.hpp:978/984);HR_SINGLE_REVOKE 偏自己走自己栈无 safepoint
  - **BasicLock**(basicLock.hpp:32-44): 单字段 _displaced_header,BasicObjectLock 嵌入解释器帧(:55);slow_enter(synchronizer.cpp:339-371): 中性→set_displaced_header+CAS(:345-346)/递归 dhw=NULL(:355)/否则 inflate(:363);fast_exit(:282-331 dhw==NULL 递归,cas_set_mark 恢复 :305-308)
  - 悬念→02-objectmonitor-structure(owner/EntryList/cxq/WaitSet)
- **19-02(ObjectMonitor 结构,大纲 7 处漂移含 0 处机制编造——结构类最实的一篇)**:
  - 字段全部核对: _header :143(offset 0,注释 :76-81 不能继承/虚函数)/_object :144/DEFINE_PAD :148/_owner :152/_previous_owner_tid :153/_recursions :154/_EntryList :155/_cxq :159/_succ :160/_Responsible :161/_Spinner :163/_count :166(:168 ≈|WaitSet|+|EntryList|)/_WaitSet :170/_WaitSetLock :173
  - **OM_OFFSET_NO_MONITOR_VALUE_TAG**(:232-233)=偏移-tag 2(注释 :221);伪共享 Futures notes :112-122(_recursions/_EntryList/_cxq/_succ 另一 cache line);_recursions 建议 int :124-128
  - **ObjectWaiter**(:42-50): TStates TS_UNDEF/READY/RUN/WAIT/ENTER/CXQ(:44)
  - **工具修复**: check.py 星号检查 bug——span 正则先跑会破坏代码块围栏(``` 被拆),导致代码块内星号误计;已改为先剔代码块再剔 span
  - 悬念→03-enter-exit-wait
- **19-03(enter/exit/wait 协议,大纲 7 处漂移含 2 处机制错)**:
  - **enter**(objectMonitor.cpp:265): 三快路径(空闲 CAS :270/重入 :279-283/is_lock_owned 栈锁转移 :285-291);慢路径 _count++ :316+EnterI 循环 :355;EnterI(:442): TryLock :448/TrySpin :464/封 node :485-493/CAS push cxq :494-497/Responsible 防 stranding(:503-516)
  - **exit**(:905): 重入退出 :925-930;掉锁 release_store :967+看 EntryList|cxq 与 _succ :968;复杂出口 reacquire :990-998;_succ Futile Wakeup Throttling(:978-997 Dice §3.3);QMode 2 cxq 优先/3-4 批量 drain(:1067-1115);ExitEpilog 四步(:1282-1314)
  - **wait**(:1426): AddWaiter :1483-1484/保存 _recursions :1490/exit :1493
  - **notify**(:1776)→INotify(:1659): **默认 Knob_MoveNotifyee=2 进 cxq 非 EntryList**(:1715-1726;policy 0/1 进 EntryList :1673-1714;policy 4 直接 unpark :1742-1747)——大纲"移到 EntryList"错
  - 悬念→04-internal-locks
- **19-04(VM 内部锁,19 域收官,大纲 6 处漂移含 3 处机制编造/反)**:
  - **rank=符号枚举 lock_types 非 0-25 数字**(mutex.hpp:106-120;注释 :82-105 special 最低/leaf 历史命名/safepoint 专属 Safepoint_lock);debug_only _rank(:141)
  - **Mutex : Monitor 非 Monitor 继承 Mutex**(mutex.hpp:297 degenerate Monitor)
  - **Monitor 自研锁**: SplitWord _LockWord(锁字节+cxq colocate :125)+ParkEvent 队列 _EntryList/_OnDeck/_WaitSet(:128-131);ILock(:436-500 TryFast→TrySpin→AcquireOrPush→_OnDeck→ParkCommon);**pthread_cond 只在 PlatformEvent 底层**(os_posix.hpp:170-190,permit -1/0/1,park 原子递减 :1996-2034,unpark :2098);notify(:663 WaitSet 头→cxq)/wait(:1064 rank 断言+ThreadBlockInVM)
  - MutexLocker(:183)/MutexLockerEx(:224 special 锁专用)/MonitorLockerEx(:251 wait :271-275)
  - 悬念→域 20 VM Operations(第 5 批)
- **23-01(StubRoutines 两阶段桩,第 4 批第 3 个域开篇,大纲 6 处漂移含 0 处机制编造——结构类较实)**:
  - **两阶段**: _code1/_code2(stubRoutines.hpp:123-124);initialize1(stubRoutines.cpp:188-202)/initialize2(:275-283);时序 stubRoutines_init1(init.cpp:110)先于 universe_init(:111),init2(:144)在 genesis 后;generate_initial(:5869: forward_exception/call_stub/catch_exception/**atomic 8 个** :5889-5897/throw 桩)/generate_all(:5971)
  - **throw 桩**(stubRoutines.hpp:97-101): generate_throw_exception(:5758,帧布局记账注释 :5762-5765);"rbp 链弄乱"流传说法收敛为源码注释表述
  - **atomic 桩**: generate_atomic_xchg(:560-577,自动 LOCK);参数注释 :569-572;解释器/VM 用 C++ 内联 Atomic::cmpxchg 不需要桩
  - StubCodeGenerator(stubCodeGenerator.hpp:97-110)+StubCodeMark(:113-126);"stubCodeGenerator.hpp:35-80" 漂移
  - 悬念→02-arraycopy(SSE/AVX 向量化)
  - **第 3 轮 REVIEW 补充**: throw 桩尾部 `__ should_not_reach_here()`(:5830)——"从不返回"坐实;generate_all 也含 throw 桩(AbstractMethodError/ICCE/NPE :5977-5984)+f2i/f2l fixup+arraycopy(:6017)+safefetch(:6095)——两阶段内容描述修正;initialize1 注释 "must happen before universe::genesis"(stubRoutines.hpp:234)确认时序依据
- **23-02(Arraycopy 向量化,大纲 11 处漂移含 5 处机制编造,2026-08-13)**:
  - **"14 种变体/16 入口" 错**: 入口=stubRoutines.hpp:126-167 三组: conjoint 6(:128-132)+disjoint 6(:133-137)+**arrayof 12 别名(大纲没提;aligned 参数 "ignored" stubGenerator_x86_64.cpp:1462-1463,全部别名 :2945-2962)**+可选 3(checkcast×2/unsafe/generic :154-157);8 个生成函数=4 宽×2 向(:1473/:1576/:1676/:1792/:1884/:1980/:2081/:2177),入口 generate_arraycopy_stubs :2866
  - **"generate_disjoint_copy/generate_conjoint_copy" 不存在**(编造): 按宽度拆 8 个;conjoint=array_overlap_test(:1173-1191,to<=from 或 to>=end 跳 disjoint)+跳入 disjoint 内部 entry(先生成 disjoint 存 entry :2875-2878),重叠走 copy_bytes_backward(:1354-1451 同套向量化)
  - **"rep_movsb/ERMSB 分级" 全错**(编造): **jdk11u x86 无 rep_movsb**(grep 零命中);真实=生成期 UseAVX 定档(CPUID 探测+SEGV 测试 YMM/ZMM 恢复 vm_version_x86.cpp:363-368;UseAVX 默认 3 globals_x86.hpp:121): evmovdqul 512B 64B→vmovdqu×2 64B→movdqu×4 64B→movq×4 32B;**唯一运行时分支=AVX3Threshold=4096**(globals_x86.hpp:224,copy_bytes_forward :1255-1282);负计数技巧 :1507-1509([end+count*8-56] 寻址省指针更新);vzeroupper :1550/vpxor 清 YMM :1319-1323
  - **"fill 用 rep_stosb" 错**: fill 桩(generate_fill :1756→MacroAssembler::generate_fill macroAssembler_x86.cpp:7447,广播 dword :7469-7482,<8B 逐元素 :7484)纯向量(vpbroadcastd+evmovdqul/vmovdqu,AVX3Threshold 门控 :7554-7576);**rep_stosb(UseFastStosb,ERMS 自动开 vm_version_x86.cpp:1471-1479)属 C2 ClearArray 对象清零**(x86_64.ad:11257→clear_mem macroAssembler_x86.cpp:6012-6020)
  - **"_zero_aligned_words 是汇编桩" 错**: =C++ Copy::zero_to_words(stubRoutines.cpp:110),生成器从不覆盖,全树无调用者——**声明 ≠ 有实现**
  - **"std; rep_movsb; cld 倒序" 错**(编造): 倒序=copy_bytes_backward 同套向量循环
  - JIT 分派三路(大纲未提): C2=inline_arraycopy(library_call.cpp:4743)→ArrayCopyNode→宏展开 generate_arraycopy(macroArrayCopy.cpp:278)→basictype2arraycopy(:216-244,常量偏移 src_off>=dst_off 判 disjoint)→select_arraycopy_function(stubRoutines.cpp:522,映射 boolean→jbyte :536-543/char→jshort :544-550)→**make_leaf_call(:1100 叶子调用无 safepoint)**;C1=emit_arraycopy(c1_LIRAssembler_x86.cpp:3049 类型未知→generic);**解释器=JVM_ArrayCopy(jvm.cpp:324-340)→klass()->copy_array 不用桩**
  - oop 变体: barrier 包夹——prologue=SATB 预屏障(satb_mark_queue_active 检查+整段运行时调用 write_ref_array_pre_oop_entry,g1BarrierSetAssembler_x86.cpp:44;uninit 整体跳过 :47-48),epilogue=卡表标记(:1950);checkcast 失败返 **-1^K**(K=已拷元素,:2430-2438,注释 "rdx = -1 * number of *remaining* oops")
  - **实证方法论教训**: ①微基准 arraycopy 会被 C2 折叠(重复拷贝只有最终状态可观测→合并为一次)——必须循环内每次校验和(每 4096 字节采样读)防消除;②ping-pong 双数组也不够(JIT 可证最终状态相同);③单位坑: MB/s 当 GB/s 打印;④数组填全程 fill 的 32M 段致 1M 次迭代爆炸
  - 实证结果(AMD EPYC 9K65,TencentKona 17,UseAVX 0/2/3): 1K arraycopy 55.0→68.3 GB/s(SSE2→AVX2 +24%),手写循环 21.2=**3.2x**;64K 78.3 vs 40.1=2.0x;4M/32M 带宽瓶颈≈1.0x;64K fill AVX2/3 137-139 vs SSE2 85.8
  - 悬念→03-crypto-math(AES-NI/SHA-NI 硬件指令)
- **23-03(Crypto + Math Intrinsics,23 域收官,大纲 10 处漂移含 4 处机制编造,2026-08-13)**:
  - **行号全漂移**: AES :3016-4701/SHA :3692-3890/CRC :5185-5296/BigInteger :5297-5470/Math :5497-5700(stubGenerator_x86_64.cpp 共 6138 行);大纲 1300-1700/1700-2100/2200-2700/2700-3200 全错;CRC 表不在 stubRoutines_x86_64.cpp 而在 **stubRoutines_x86.cpp**(crc_table :132、k256 :324,64B 对齐)
  - **"sha256rnds2 4 rounds in 1 instruction" 错**: 一条 rnds2=2 rounds;16 字节块=paddd(K)+rnds2×2=4 rounds(macroAssembler_x86_sha.cpp:271-300);**SHA-256 双路径**(supports_sha→SHA-NI fast_sha256,否则 AVX2 sha256_AVX2 :507)——开关只需 sse4_1 的原因(vm_version_x86.cpp:956-960);**SHA-512 无硬件指令**纯 AVX2(断言 avx2+bmi2 :3814-3815,sha512_AVX2 :1240)
  - **"CRC32 纯查表" 半对**: kernel_crc32(macroAssembler_x86.cpp:9076)=查表对齐+**pclmulqdq 折叠**(fold_128bit_crc32 :9138)+尾部查表,**无 crc32 指令**;crc32 SSE4.2 指令属 **CRC32C**(crc32c_ipl_alg2_alt2 :9889,指令 :9671-9677);AVX-512 版 kernel_crc32_avx512 :9390
  - **"montgomery* 是汇编桩" 错(编造)**: =C++ SharedRuntime::montgomery_multiply(sharedRuntime_x86_64.cpp:3811,32 位字),CAST_FROM_FN_PTR 登记(stubGenerator_x86_64.cpp:6111-6118)——**入口表挂名≠汇编桩,须查生成处**;另有大纲没提的 vectorizedMismatch :5357、base64 :4933
  - **"_dlibm_sin_cos_huge 等" 仅 x86_32 生成**(stubGenerator_x86_32.cpp:3849-3862),x86_64 恒 NULL——"声明有、实现无"第三例(与 02 篇 zero_aligned_words 同类)
  - **Math 桩=Intel LIBM 2016 移植**(macroAssembler_x86_exp.cpp 头注释 "Intel Math Library (LIBM) Source Code"),7 文件(fast_exp/sin/cos/tan/log/log10/pow)全 XMM 无 x87;fast_exp: 范围检查(32767/16527/15504)+ln2 倒数取整+多项式(0x3FC55555≈1/6、0x3FA55555≈1/24)
  - **AES**: keylen {44,52,60}=展开密钥长度;密钥直接复用 Java 展开结果("the java expanded key ordering is just what we need" :3044)+pshufb 小端(load_key :2988);CBC 解密并行两版(VAES+AVX512 :4317/SSE :3400);GHASH 4×pclmulqdq(掩码 0/16/1/17)交叉 XOR :4693-4703
  - **BigInteger**: multiply_to_len(macroAssembler_x86.cpp:8123)BMI2 分派(:8218-8236): mulx+adcx/adox 双进位链 :8030-8047(adcx 需 supports_adx);非 BMI2 回退 :7910;开关是 C2 flag(c2_globals.hpp:718,COMPILER2 才生成)
  - **实证方法论**: 关闭 diagnostic flags 需先 -XX:+UnlockDiagnosticVMOptions(否则 VM 拒绝启动);Math.exp 微基准会被 C2 消除(i 派生常量)→ 必须数据依赖数组;素材 materials/commands/23-crypto-bench.txt
  - 实证: SHA-256 1537→262 MB/s=**5.9x**;SHA-512(AVX2 软件)815→438=1.9x;AES-CBC 496→166=3.0x;CRC32 44704→3110=**14.4x**;Math.exp 4.0→7.0 ns/op=1.7x——"8x 加速"编造被实测取代
  - 悬念→24-frame/01(Physical Frame)
- **24-01(Physical Frame,第 4 批第 4 个域开篇,大纲 10 处漂移含 2 处编造,2026-08-13)**:
  - **"frame 三字段" 错**: 共享 _sp/_pc/_cb+deopt 三态(frame.hpp:50-65),**x86 附加 _fp/_unextended_sp(frame_x86.hpp:110-120)**——注释解释了双 sp 的由来(interpreter/adapters 扩展 caller 帧,oopMap 按扩展前 sp 记录);别信"三字段 32 字节"
  - **"compiled sender = *rbp/+(rbp+8)" 错**: sender_sp = unextended_sp + **_cb->frame_size()(编译期元数据)**,sender_pc=*(sender_sp-1),saved_fp=*(sender_sp-2)(frame_x86.cpp:451-483);非 rbp 链现场走
  - **"interpreter sender = *[method_locals-2]" 半对**: interpreter_frame_sender_sp()=fp[-1](帧内保存 caller sp,frame_x86.cpp:431-446);偏移表 frame_x86.hpp:60-73(正偏移 fp 上方/负偏移 fp 下方)
  - **"四种帧" 简化错**: sender 分派三路(entry/interpreter/compiled,frame_x86.cpp:488-503),JNI native 帧也是 nmethod;兜底纯 C 帧
  - **"find_blob 二分搜索" 错(编造)**: CodeHeap segmap 段映射链式回跳(heap.cpp:456-483),x86 段 128B(CodeCacheSegmentSize=64 TIERED_ONLY(+64) globals_x86.hpp:40)
  - **"Interpreter::oop_map_cache()" 不存在(编造)**: per-Klass(InstanceKlass::_oop_map_cache instanceKlass.hpp:247);Method::mask_for(method.cpp:237)/OopMapCache::compute_one_oop_map(oopMapCache.cpp:597)
  - oops_do: oops_do_internal(frame.cpp:1115)分派;解释器帧=monitor→native temp oop→mirror→调用点参数→mask(:890-958);编译帧=OopMapSet::oops_do(compiler/oopMap.cpp:288,oop_map_for_return_address :302,**derived 先处理** :307-340);OopMapValue 四型 oopMap.hpp:69-73
  - 栈顶: Thread::last_frame(thread.hpp:1879)=make_walkable+pd_last_frame(thread_linux_x86.cpp:30-34);deopt 构造判定=get_deopt_original_pc(frame_x86.inline.hpp:44-60)
  - **实证方法论**: jcmd 输出走目标进程 stdout(重定向文件);attach 失败=进程已死/pgrep 误匹配(用 jps -l);PrintInterpreter 是 diagnostic flag 需先 UnlockDiagnosticVMOptions;适配器=AdapterBlob:BufferBlob→non-nmethods 段(codeBlob.cpp:262)
  - 实证: materials/commands/24-frame-demo.txt(jstack 两行 at/codelist hot 双版本 nmethod level4+3/三 CodeHeap 1098 blobs 653 nmethods 359 adapters/PrintInterpreter 271 codelets 358B)
  - 悬念→24-frame/02(Virtual Frame)
- **24-02(Virtual Frame,大纲 5 处漂移含 1 处编造,2026-08-13)**:
  - **"nativeVFrame" 不存在(编造)**: 家族=vframe(vframe.hpp:54)→javaVFrame(:107 五纯虚)→interpretedVFrame(:160)/compiledVFrame(**vframe_hpp:30**);另支 externalVFrame→entryVFrame(:204/:217);JNI 帧走 compiledVFrame scope=NULL(vframe_hp.cpp:236-245,method/bci 直接取 :267-292,"native nmethods have no scope")
  - **vframeStream 位置错**: 类在 vframe.hpp:268-330(StackObj,_mode 三态 :274),**next() 在 vframe.inline.hpp:41-49**(非 vframe_hp.cpp)——同帧内联层 fill_in_compiled_inlined_sender(:66-72,serialized_null 判边界)不动 _frame,物理层 do-while sender;fill_from_frame :125-201(编译帧只解码 sender_decode_offset+method+bci 三字段 :75-114,locals 不碰=惰性)
  - ScopeDesc: scope_desc_at(compiledMethod.cpp:218)=pc→PcDesc→offset;sender() 实现 scopeDesc.cpp:152/is_top :148
  - 消费者: JFR vframeStreamSamples(jfrStackTrace.cpp:135)+Thread.print(thread.cpp:3417);jstack"每行一方法"=vframeStream 输出
  - 实证: materials/commands/24-inline-demo.txt(-Xlog:jit+inlining=debug 内联树 vs jstack 只有外层);实证手法: 内联日志比 PrintAssembly 轻量,证明"多层内联=1 物理帧"够用
  - **第 3 轮 REVIEW(用户追问 Kona 是否特改)**: 下载 **Temurin OpenJDK 11.0.32**(api.adoptium.net,与 jdk11u 同版本)验证: SIGQUIT 转储/jcmd Thread.print/JFR 三路径都只有 main 一行——**Kona 17/21 与 OpenJDK 行为一致,非 Kona 特改**;对照 NoInlineDemo(不内联)正常 4 层;机制=**锚点 pc**(线程转储起点=last_Java_pc,停在最近 Java→VM 转换点,scope=main)+**内联纯算术段无 PcDesc**(JFR 采样 pc 反查回退 nmethod 方法);**"jstack 是 vframeStream 消费者"断言是错的**——线程转储走 vframe::sender 链(print_stack_on thread.cpp:3247/dumpThreads threadService.cpp:645-662),JFR 走 vframeStreamSamples(jfrStackTrace.cpp:135);内联帧现身前提=PcDesc 命中(StringBuilder 内联帧)
  - **实证方法论教训**: ①容器后台进程在 bash 工具调用结束被杀——用 wrapper 脚本单次调用内完成(start→sleep→采集→kill);②pgrep/pkill -f 模式匹配到 bash 自身命令行导致自杀/超时——用方括号技巧 [I]nlineDemo;③jcmd attach 在 Temurin 11 挂起——用 kill -3(SIGQUIT)转储,输出走进程 stdout,不需 attach;④JDK 版本匹配: Kona17 javac 编译的 class(61)不能跑 JDK 11(55)——实证 JDK 用哪个 javac 就用哪个 java;⑤echo 文本含中文括号会触发 bash 语法错误
  - **第 4 轮 REVIEW(锚点 pc 精确定位)**: 机制闭环——①遍历起点=锚点帧(thread_linux_x86.cpp:55-58 pd_get_top_frame 优先 anchor;JFR JDK11=suspend+ucontext 但 anchor walkable 时不用 ucontext);②锚点 pc=最近 Java→VM 转换点=**C2 插在循环回边的安全点轮询点**;③**显示哪层由轮询点所在方法决定**: InlineDemo2 轮询点在 main 循环(main 段)→1 层;NoInlineDemo 轮询点在 big 循环(big 不内联,top/mid 也都不内联=grep 0)→物理链 4 层;内联的 bar/baz/qux 无循环无轮询点→锚点永不落内联代码;④JFR ucontext 路径(JDK14+ 信号采样)用真实 pc,但内联纯算术段无 PcDesc→pc_desc_at NULL→回退 nmethod 方法(main)(vframe.inline.hpp:139-189);⑤轮询点必有 PcDesc(GC 需要)→轮询点 scope 稳定可解析
  - 悬念→24-frame/03(Deopt 重建+GC 扫描)

---

## 七、用户偏好与纪律(重要,违背会被批评)

1. **严格按规划,不做多余选择**: 拓扑定了顺序就逐项推进——不要问"还是写 X?"(曾因制造选择被批评)
2. **每篇都做深度 REVIEW(2 轮)**: 用户会要求"按照方法论深度的 REVIEW",写完后**主动自查深审,不要等**
3. **一篇一篇写**: 不并行、不跳步
4. **数字/事实必须验证**: 任何带数字的陈述回源码/素材验证,禁止"凭记忆"
5. **命名混淆注意**: "域 07"与"07 域的第 01 篇"都带 07,表述时写清"域 XX 第 Y 篇"
6. 中文交流,提交信息用中文
7. 用户会追问"下一步规划是否合理"——要有自己的判断
8. **用户会追问"发现的问题都修复了吗/有沉淀吗"**——修复要有 commit 可查,沉淀要即时写进本文件 §6
9. 链接文本必须与目标文章标题一致(整体 REVIEW 抓过 3 处)
10. 上下文将满时用户会要求"写详细的交接文档"——把进度/commit/经验/下一步全部写全

---

## 八、待办清单(按优先级)

- [x] 第 1 批 12 篇 + 第 2 批 26 篇(02/03/04/06/16/38/41/42 域全完结)——✅ 收官
- [x] **07-classfile-classloader/01-07**(classfile-parser/verifier-stackmap/symbol-string-table/system-dictionary/classloader-hierarchy/jpms-modules/**javaclasses-core-mirrors**)——✅ 07 域完结,commit 见 §二
- [x] **09-memory-core/01-03**——✅ 09 域完结,commit 见 §二
- [x] **17-threads/01-04**——✅ 17 域完结(第 3 批收官),commit 见 §二
- [x] **10-metaspace/01-03**——✅ 10 域完结,commit 见 §二
- [x] **19-sync/01-04**——✅ 19 域完结,commit 见 §二
- [x] **23-stub/01**(stub-entry)——✅ 完成,commit 见 §二
- [x] **23-stub/02**(arraycopy,SSE/AVX 向量化)——✅ 完成,commit 见 §二(正文 10d3239+大纲回填 b70cd1a+README 2e1c7cc)
- [x] **23-stub/03**(crypto-math,AES/SHA 硬件指令)——✅ 完成,commit 见 §二(正文 235140b+大纲回填 6f584f3+README c1b8c07);**23 域 3/3 完结**
- [x] **24-frame/01**(physical-frame)——✅ 完成,commit 见 §二(正文 4fd580d+大纲回填 0002994+README 894d505)
- [x] **24-frame/02**(virtual-frame)——✅ 完成,commit 见 §二(正文 1632ba5+大纲回填 ba87c0e)
- [ ] **24-frame/03**(deopt-gc-scan)——**下一篇**;大纲在 `planning/outlines/24-frame-stack/03-deopt-gc-scan.md`;02 篇悬念指向它
- [ ] 24 域完结后 → 08-interpreter
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
| JDK 侧源码 | `/data/workspace/jdk11u/src/java.base/`(share/native/libjava、unix/native/libjava、share/classes/java/...) |
| 工具素材 | `docs/openjdk/planning/outlines/00-jvm-tools/materials/`(commands/ 130+ 文件) |
| JDK 工具 | `/opt/codev/TencentKona/bin/`(17.0.8.1,跑实证用) |
| 自查脚本 | `/data/tmp/opencode/check.py`(代码块/行号/星号/锚;新文件先加 MAPPINGS) |
| GUI 手册 | `docs/openjdk/planning/outlines/00-jvm-tools/GUI-manual.md` |

**自查脚本要点**(python,每篇跑):
- 代码块: `re.findall(r'```cpp\n// (file):(s)-(e)\(...\)\n(.*?)```')` → 逐行比对(遇 "..." 跳过,strip 后判;"..." 后从 src 当前位置起找下一锚行)
- 行号范围: 文件名→目录映射(hotspot: share/classfile/、share/oops/、share/code/、share/asm/、share/classfile/、share/memory/、share/runtime/、share/utilities/、share/gc/g1/、share/gc/shared/、share/opto/、share/ci/、share/compiler/、share/services/、share/prims/、share/asm/、cpu/x86/、os/linux/、os/posix/;JDK 侧: java.base/share/native/libzip、libjimage、libjava、java.base/share/classes/java/...、java.base/unix/native/libjava、java.base/linux/native/libjava)→ 行号 ∈ [1, 行数]
- 星号: 剔除代码 span 后 `count('*') % 2 == 0`(注意 `java.*` 类裸星号必须加反引号)
- 文字锚: 文件名后无行号的引用 → 报错补行号(注意 "ProcessHandleImpl.children(" 这类方法调用是误报)

---

## 十、下一步(读完立即做)

```
1. 读 planning/outlines/24-frame-stack/02-virtual-frame.md(大纲,注意 ⚠️ 块——24-01 已回填 10 条,02 大概率同样漂移;01 篇悬念指向它: 内联三层怎么看到源级方法)
2. 验证大纲所有 file:line 与专有名词(按 §6.5-1 的规律;重点: vframe.hpp/vframe.cpp 的 javaVFrame/compiledVFrame/interpretedVFrame/nativeVFrame 四子类、vframeStream(fill_from_frame)、scopeDesc(编译帧内联树,pc→scope 反查)、RegisterMap 寄存器映射;与 01 篇 frame 的呼应: compiledVFrame::sender 沿物理帧还是内联树走;实证可用 jcmd Thread.print 已抓的素材(24-frame-demo.txt)+ JFR 采样栈)
3. 按第三节流程写 → 自查(脚本 /data/tmp/opencode/check.py,新引用文件先加 MAPPINGS/HS_MAP;注意 ART 变量改回当前文件;星号检查已修复,正文裸转义星号须加反引号)→ 深审 2 轮 → 回填大纲 → 提交 → 更新 README
4. 24 域完结后 → 08-interpreter
```

**环境**: Linux 容器,无显示器(GUI 截图等用户在 Ubuntu 补);jdk11u 源码在本地;git 推送即部署(docsify 站点)。**上下文已满: 本文件写完后,新会话只读本文件即可继续,不要依赖旧会话的记忆。**
