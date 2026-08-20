# HANDOFF — BIN 方法论重写交接文档

> 更新时间：2026-08-18
> 仓库：`/data/workspace/source-code/openjdk-book`
> 当前分支：`main`
> 用途：交给下一位 AI 继续按 BIN 技术作者风格和项目写作规范重写 Java 层源码正文。

## 1. 当前结论

本项目经历了两个阶段：

1. 第一阶段：按既有大纲快速覆盖 `docs/openjdk/vol-java/` 正文，并逐篇做源码锚点/逐字块检查。
2. 当前阶段：依据 `docs/openjdk/WRITING-GUIDELINES.md` 和 BIN 技术作者文章，开始系统性重写，不再满足于“事实卡片正确”。

当前真正的质量目标是：

> 写一篇删掉代码后仍然成立的技术文章，而不是源码译文、知识卡片或 AI 问答。

目前已完成的只是部分重写试点，不能把所有已有 `vol-java` 文章都视为 BIN 级质量。

## 2. 必读文件

开始任何新工作前必须阅读：

- `docs/openjdk/WRITING-GUIDELINES.md`
  - 三步分离：素材提取 → 理解路径设计 → 叙事写作
  - 主语必须是角色，不是变量
  - 问题 → 失败 → 顿悟 → 机制 → 收网
  - 代码是证据，不是文章骨架
  - 失败方案推演、误解清单、版本边界、删码测试
- `docs/HANDOFF-BIN-ARTICLE-REVIEW.md`
  - BIN 技术作者文章的逐篇评审背景与对照标准
- 本文
- 对应域的 `docs/openjdk/jdk11-planning/outlines/<domain>/...` 大纲
- 对应旧稿 `docs/openjdk/vol-java/<domain>/<article>.md`
- 对应源码树 `/data/workspace/source-code/code/spring/jdk11/src/`

BIN 参考文章目录：

`/data/workspace/source-code/book/成长之路/tmp-question/training-camp/source-code/BIN技术小屋/jvm`

当前已确认 JVM 参考文章 6 篇，Netty 参考文章 18 篇。参考文章特点：具体事故/困惑开场、源码时序、图、实验、版本边界、跨 Java/HotSpot/native 层、长篇但不靠空洞扩字。

## 3. 当前重写进度

### 3.1 已建立重写计划并完成正文重写/深审

#### 域 01 String

- 计划：`docs/openjdk/vol-java/01-string/01-storage-immutable.rewrite-plan.md`
- 正文：`docs/openjdk/vol-java/01-string/01-storage-immutable.md`
- 状态：已重写，多轮深审通过
- 新主线：String 作为 HashMap key 的共享风险 → 失败方案 → `byte[] + coder` → 四层不可变边界 → 外部输入隔离 → substring 新值 → 收网
- 计划：`02-equals-hashcode-compare.rewrite-plan.md`
- 正文：`02-equals-hashcode-compare.md`
- 状态：已重写，多轮深审通过
- 新主线：HashMap key 消失/TreeMap 顺序异常 → `equals/hashCode/compareTo/intern` 协作
- 计划：`03-build-concat.rewrite-plan.md`
- 正文：`03-build-concat.md`
- 状态：已重写，多轮深审通过
- 新主线：循环拼接复制浪费 → 可变缓冲/扩容 → StringBuffer 锁与快照 → JEP 280 indy → StringJoiner
- 计划：`04-encoding-unicode.rewrite-plan.md`
- 正文：`04-encoding-unicode.md`
- 状态：已重写，多轮深审通过
- 新主线：乱码事故 → charset 边界 → StringCoding → U+FFFD → Compact Strings → UTF-16 code unit/code point → CharacterData 查表 → 四步诊断

#### 域 02 Number/Math

- 计划：`docs/openjdk/vol-java/02-number-math/01-wrapper-cache-boxing.rewrite-plan.md`
- 正文：`01-wrapper-cache-boxing.md`
- 状态：已重写，多轮深审通过
- 主线：Integer 100/200 身份事故 → IntegerCache → `==/equals` → parseInt/toString → 其他包装类
- 计划：`02-bigdecimal.rewrite-plan.md`
- 正文：`02-bigdecimal.md`
- 状态：已重写，多轮深审通过
- 主线：金额/0.1 事故 → 构造入口 → scale/舍入 → equals/compareTo → BigInteger 边界
- 计划：`03-ieee754-math.rewrite-plan.md`
- 正文：`03-ieee754-math.md`
- 状态：已重写，多轮深审通过
- 主线：`0.1+0.2` 与 `Double.toString(0.1)` 的矛盾 → 位模式 → 打印 → Math/StrictMath → NaN/±0.0 → 业务规则

#### 域 03 Object/System

- 计划：`docs/openjdk/vol-java/03-object-system/01-object-contract-references.rewrite-plan.md`
- 正文：`01-object-contract-references.md`
- 状态：已重写，多轮深审通过
- 主线：HashSet key 消失 → Object 契约 → clone/hash → finalize 资源事故 → Cleaner → 四种引用
- 计划：`02-system-runtime.rewrite-plan.md`
- 正文：`02-system-runtime.md`
- 状态：已重写，已完成首轮源码自查；深审需由下一位继续确认
- 主线：时间回退/停机卡死 → System/Runtime 是进程门面 → 时钟 → arraycopy → Properties 私有快照 → exit/hook/halt

### 3.2 当前未完成

当前应继续深审：

`docs/openjdk/vol-java/03-object-system/02-system-runtime.md`

之后按写作顺序继续：

1. 为 `03-object-system/03-process-native.md` 建立 `.rewrite-plan.md`
2. 读取旧稿、大纲、源码
3. 按理解路径重写正文
4. 完成后做多轮深审
5. 再进入域 04

## 4. 正文重写标准

### 4.1 每篇必须先有计划

计划文件命名：

`<article>.rewrite-plan.md`

至少包括：

- 读者困惑
- 一句话顿悟
- 旧稿优点与问题
- 重写策略
- 按理解路径的新结构
- 失败方案清单（至少 3 个，重大篇建议 5 个以上）
- 误解清单
- 总图/角色/箭头/时序
- `file:line` 证据清单
- JDK/平台/版本边界
- 删除代码测试与最终验收标准

### 4.2 正文必须具备

- 具体事故、生产现象或面试困惑开场
- 先讲动机/障碍，再让代码作为证明出现
- 至少一张文字总图
- 失败方案推演：为什么直觉方案不行
- 源码证据必须落到真实 JDK 11 文件和行号
- 明确哪些是规范、哪些是 JDK 11 当前实现、哪些是平台实现、哪些是经验
- 收尾必须回到开场问题，并有自然下一篇钩子

### 4.3 不要重复旧模式

禁止把正文写成下面这种机械模板：

```text
## 1. 某类是什么
## 2. 某字段是什么
## 3. 某方法是什么
关键设计(斜体): ...
```

`关键设计`可以保留，但必须成为叙事中的真正设计结论，不是每节末尾的固定标签。

不要只做 70–150 行短卡片。质量优先于字数，但必须能独立闭环；重大机制应有足够展开量、失败推演和版本边界。

## 5. 检查命令

工作目录：

`/data/workspace/source-code/openjdk-book`

### 5.1 逐字块校验

脚本：

`/data/tmp/opencode/verify_blocks.py`

每次切换文章前，必须把脚本中的 Markdown 路径替换为目标文件。脚本只校验带锚点头的 `java` 块；用法示意块用：

```java
// 用法示意(API 形式,非源码片段)
```

如果同名源码文件导致脚本撞错文件，需要按模块路径修正脚本选择逻辑后再校验，不能把脚本误报当文章问题。

### 5.2 常规检查

```bash
grep -rncP '\([^)]*\.java:(?!\d)' <domain-dir>
grep -rnP '\([^)]*\.java\)' <domain-dir>
grep -nP '\(\d{3,4} 行\)' <article>.md
grep -nP '后面会讲|展开\)|第 [2-9] 篇|域 \d+ 展开' <article>.md
```

另外必须扫描指南禁用词：

```bash
grep -nE '此处不再赘述|不再展开|类似地|同理|依此类推|篇幅所限|显然|容易看出|细节读者自行阅读' <article>.md
```

### 5.3 文章质量检查

- 删掉代码块后，主线是否仍成立
- 小标题能否还原“问题 → 失败 → 顿悟 → 机制 → 收网”
- 是否至少回答：谁触发、做了什么、失败会怎样、为什么不选简单方案
- 是否存在没有证据的性能/时序/平台断言
- 是否写清 JDK 11 版本边界
- 是否有至少 3 个常见误解
- 是否有总图与收网

## 6. 工作区与提交规则

当前仓库路径：

`/data/workspace/source-code/openjdk-book`

当前已有大量无关工作区改动/未跟踪文件，尤其包括：

- `docs/openjdk/WRITING-GUIDELINES.md`
- `docs/openjdk/jdk11-planning/`
- `docs/openjdk/planning/outlines/48-utilities/pass1-notes.md`
- `docs/openjdk/vol-02/` 的其他重写改动
- `docs/openjdk/vol-arthas/`
- `docs/openjdk/vol-async-profiler/`

不要用 reset/checkout/clean 等破坏性命令。

提交时只暂存明确属于本次任务的文件。最近已推送提交：

- `31eb217 新增 Java 层源码卷入口`
- `1dbb241 修复 Java 源码卷文章导航`

当前用户已要求后续工作继续，但没有每次都要求立即提交。没有明确要求时不要主动提交；如果用户明确说“提交并推送”，必须先检查 status/diff/log，只提交目标文件，并推送 `origin main`。

## 7. 当前下一步

1. 完成 `03-object-system/02-system-runtime.md` 的多轮深审。
2. 读取 `03-object-system/03-process-native.md` 旧稿与大纲，提取素材。
3. 创建 `03-process-native.rewrite-plan.md`。
4. 按计划重写正文，质量优先，不强行凑字数。
5. 写完立刻自查并多轮 REVIEW，直到无问题。
6. 再进入域 04。

不要误以为旧 `vol-java` 所有篇目都已达到 BIN 质量；当前只是从域 01 开始逐篇重写。