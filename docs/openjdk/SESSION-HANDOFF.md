# SESSION-HANDOFF — 主交接文档(唯一入口,非常详细版)

> **状态**: 2026-08-12 | 卷 2 写作中: **44/152 篇完成**(第 1 批 12 ✅ + 第 2 批 26 ✅ 收官 + 第 3 批 6: 07 域 6/7) | **上下文已满,本文件为非常详细交接版**——新 AI 只读本文件即可继续,不要依赖旧会话记忆
> **接收者: 新 AI —— 只读本文件,按"十、下一步"执行**

---

## 〇、三十秒总览(先读这个)

**项目**: 写一本 OpenJDK 源码分析书("格物致知"),源码树 = jdk11u(`/data/workspace/jdk11u/src/hotspot/`)。

**当前正在做**: 卷 2(按 48 域规划写源码文章),每篇严格按方法论: 读大纲 → **所有行号重新 grep 验证** → 写 → 代码块与源码逐字核对 → **深审 2 轮** → 回填大纲 → 提交。

**下一步(唯一,无选择)**: 07-classfile-classloader/07(javaClasses 核心类镜像)——**07 域收官篇**,之后进入第 3 批 09-memory-core。

**铁律**: ① 一篇一篇写,写完自查+深审 2 轮合格再下一篇;② 大纲/KP 的行号与机制描述是"线索不是事实",写作时必须重 grep——**实测每篇大纲有 2-15 处机制错误或行号漂移,44 篇无一例外**;③ 代码块贴真实源码(截取可,编造不可)——凭记忆写值必错;④ 每篇写完整理后做深审,**必须 2 轮**(第 1 轮自查+通读,第 2 轮逐机制回源码质疑——第 2 轮才能抓到"顺理成章"的机制错误);⑤ 发现错误→修正文章→**回填大纲 ⚠️ 块**(防下次抄错)→提交;⑥ **REVIEW 时正文与大纲的行号要一起过**(07-04 REVIEW 时发现大纲 ⚠️ 块行号也带着同样的偏差);⑦ 脚本语法错误要立即发现——一次 commit 曾因 `;` 链把未应用的修改提交了(07-03 REVIEW 教训)。

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
第 3 批(对象/类): 07(6/7) → 09 → 17   🚧 进行中
第 4 批(执行/帧): 10 → 19 → 23 → 24 → 08 → 31 → 44
第 5 批(VM 核心): 11 → 12 → 13 → 18 → 20 → 27 → 30 → 32 → 34 → 36 → 37 → 39 → 46
第 6 批(JIT/GC): 14 → 15 → 21 → 25 → 28 → 29 → 33 → 43
第 7 批(上层): 22 → 26 → 35 → 40 → 47
```

**已完成 44 篇**(全部在 `docs/openjdk/vol-02/`,第 1 批 12 + 第 2 批 26 + 第 3 批 6):

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
| 07-classfile-classloader | 1-6 | `07-classfile-classloader/01-classfile-parser.md`(169 行)/02-verifier-stackmap.md(216 行)/03-symbol-string-table.md(212 行)/04-system-dictionary.md(134 行)/05-classloader-hierarchy.md(125 行)/06-jpms-modules.md(131 行) | ✅ 第 3 批进行中(6/7) |

**每篇 commit 号**(以 git log 为准;旧批次省略,列出 42/07 域): 42域01=d52e3a3(正文+大纲回填)+1245c25(README);42域02=476c3a9(正文+大纲回填)+ec7338f(README);42域03=c4d1b1f(正文+大纲回填,42 域完结)+e8789cc(README,第 2 批收官)+d474372(深度 REVIEW: findJniFunction builtin 限定、execstack 修复机制、VerifyFixClassname 语义、行号修正);07域01=8a24a30(正文+大纲回填)+fe93766(README)+7c199ba(深度 REVIEW: 字段排列顺序方向修正 oops 默认排最后、Module ACC_MODULE 拒绝、行号 8 处);07域02=f1684a0(正文+大纲回填)+5d486bd(README)+4a7bb70(深度 REVIEW: chop 数解读修正/block 范围/链接文本对齐);07域03=c65d49c(正文+大纲回填)+93e11a6(README)+eccd834(深度 REVIEW: 数组头 16+3/并发清理归属 serviceThread/'五个 ClassLoader' 删)+3d246fe(rehash 种子表述补丁);07域04=1ea098c(正文+大纲回填)+a84c8e4(README)+c0deb38(深度 REVIEW: 六步行号精确化/查字典四次/SystemDictionary 定位);07域05=3db4402(正文+大纲回填)+9d3502a(README)+d8a145e(深度 REVIEW: is_alive 判定/unload 动作/load_shared_class 行号);07域06=4a23fde(正文+大纲回填)+94a9f44(README)+2a185ec(深度 REVIEW: 模块表归属修正 per-loader ClassLoaderData._modules);各域 README/HANDOFF commit 见 git log。

**已回填的大纲**(写作中发现漂移即回填,防下次抄错): 45/48/02/03/04/06(六篇)/16(五篇)/38(两篇)/41(两篇)/42(三篇)/07(01-06)各域 outlines 均已按真实源码重写并标 ⚠️ 写作期修正;KP(45/48/04)同步修正。**写作 07-07(07 域收官)前先读 07-06 大纲 ⚠️ 块(10 处漂移含 3 处编造已回填: _exports/_uses/is_exported_to 不存在;导出在包级 PackageEntry;模块表 per-loader)。**

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

### 6.1 大纲漂移的规律(44 篇全部出现,2-15 处/篇;02/03/04/45/48 域案例为更早会话沉淀,06/16/38/41/42/07 域为本会话沉淀)
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
  - parse_fields :1541(FieldInfo 六槽 fieldInfo.hpp:69;injected fields=JavaClasses::get_injected :1575-1578,CLASS_INJECTED_FIELDS javaClasses.hpp:1562+——**07-07 的入口!**);parse_method :2344(<clinit> 51 起必须 static :2366-2379;Code 属性 :2467 起,max_stack 45.2 兼容 :2483-2492,code_start 不拷贝 :2502);parse_classfile_attributes :3440(BootstrapMethods :3596/NestMembers :3627/NestHost :3640)
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
  - **StringTable**: 表=ConcurrentHashTable<**WeakHandle**>(stringTable.hpp:42-43)+OopStorage _weak_handles(:71);intern 链=JVM_InternString(jvm.cpp:3501-3509)→StringTable::intern(:312-328,lookup_shared CDS→do_lookup→do_intern)→do_intern(:354-380:create_from_unicode(javaClasses.cpp:263-285,CompactStrings latin1→byte[]/char[])+deduplicate_string(:365-367,入表后禁 dedup)+get_insert_lazy+rehash 预警)
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
- [x] **07-classfile-classloader/01-06**(classfile-parser/verifier-stackmap/symbol-string-table/system-dictionary/classloader-hierarchy/jpms-modules)——已完结,见 §二 commit
- [ ] **07-classfile-classloader/07**(javaclasses-core-mirrors,07 域收官)——大纲在 `planning/outlines/07-classfile-classloader/07-javaclasses-core-mirrors.md`(标题 "07. javaClasses — String/Class/Thread 的 JVM 内建镜像")
- [ ] 07 域 7 篇完结后 → 第 3 批 09-memory-core → 17-threads
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
1. 读 planning/outlines/07-classfile-classloader/07-javaclasses-core-mirrors.md(大纲,注意 ⚠️ 块——06 篇 10 处漂移已回填;本篇是 07 域收官篇,06 域的悬念与 06-03 的 CLASS_INJECTED_FIELDS 都指向它)
2. 验证大纲所有 file:line 与专有名词(按 §6.5-1 的规律;重点: javaClasses.cpp(4586 行!)的 compute_offsets/静态偏移字段,06-03 已见过 java.lang.Class 的 injected fields(CLASS_INJECTED_FIELDS javaClasses.hpp:1562+,java_lang_Class 的 klass/array_klass/oop_size/static_oop_field_count/protection_domain/signers/source_file)——07-07 很可能要讲这些 injected fields 与镜像机制的完整版;String/Class/Thread/Module 的 JVM 内建表示;文件名先 find 验证——javaClasses.cpp/hpp/inline.hpp 在 share/classfile/)
3. 按第三节流程写 → 自查(脚本)→ 深审 2 轮 → 回填大纲 → 提交 → 更新 README
4. 07 域 7 篇完结后(第 3 批第一篇收官)→ 第 3 批 09-memory-core(大纲在 planning/outlines/09-memory-core/)
```

**环境**: Linux 容器,无显示器(GUI 截图等用户在 Ubuntu 补);jdk11u 源码在本地;git 推送即部署(docsify 站点)。**上下文已满: 本文件写完后,新会话只读本文件即可继续,不要依赖旧会话的记忆。**
