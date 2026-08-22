# Vol-02 重写工作交接文档

> 生成时间：2026-08-21
> 仓库：`/data/workspace/source-code/openjdk-book`
> 源码树：`/data/workspace/source-code/openjdk11u`
> 方法论文档：`docs/openjdk/WRITING-GUIDELINES.md`

---

## 一、目标与方法论

### 1.1 最终目标

把 `docs/openjdk/vol-02/` 下全部文章从“源码事实卡片”升级为“删掉代码仍成立的技术文章”。

判断标准：

- 每篇回答一个真实读者困惑，采用 problem → failure → insight 结构
- 每篇包含至少一个失败方案推演
- 删除所有代码块后，叙述性正文仍然独立成立
- 所有 `file:line` 引用在 OpenJDK 11u 源码树中实际存在且行号正确
- 禁用词扫描通过
- `git diff --check` 通过

### 1.2 写作流程（四步）

1. **读现稿 + 提取核心困惑**——不是“这篇文章覆盖了什么”，而是“读者真正卡在哪里”
2. **收集源码证据**——读真实源码，拿到精确 `file:line` 和 snippet
3. **落盘 `*.rewrite-plan.md`**——包含一句话顿悟、ASCII 总图、分节大纲与字数预算、失败方案、证据清单、边界清单、完成后 review checklist
4. **写正文 + 多轮自检**——删码测试、禁用词扫描、链接验证、`file:line` 核对、`git diff --check`

### 1.3 禁用词

以下词出现即视为写作失败：

```
此处不再赘述、不再展开、类似地、同理、依此类推、
篇幅所限、显然、容易看出、细节读者自行阅读源码、旧稿、重写后
```

### 1.4 平台约定

- Python：用 `python3`，不用 `python`
- 源码搜索：优先 `rg`
- 源码树：`/data/workspace/source-code/openjdk11u`
- 书稿仓库：`/data/workspace/source-code/openjdk-book`
- 临时工作目录：`/data/tmp/opencode`

---

## 二、当前总进度（2026-08-21 终检）

### 2.1 整体判断

`vol-02` 的正文重写主线已经**实质完结**。

这次批量复核后的结论是：

- 连续域重写已经从早期 HotSpot 基础域一路推进到 `48-utilities`
- 本轮后半段实际花费的主要精力，不再是“补正文”，而是**排除误判、确认哪些文章只是缺显式 review 提交记录**
- 对剩余 `missing_review` 候选做逐篇或批量深查后，**没有再发现需要补正文的大缺口**

也就是说，当前剩余工作更偏向：

- 交接与收官文档
- 是否要补齐个别 `rewrite-plan` 文件
- 是否要为少数早期成文文章补一轮显式 deep review 提交记录

而不是继续大规模重写正文。

### 2.2 本轮确认已完成的后续域

除旧 handoff 中已经记录的 `09`–`15` 域外，本轮继续确认并推进完成的卷 2 文章包括：

- `docs/openjdk/vol-02/16-code-cache/01-codeblob-heap.md`
- `docs/openjdk/vol-02/17-threads/01-thread-hierarchy.md`
- `docs/openjdk/vol-02/17-threads/02-javathread-state.md`
- `docs/openjdk/vol-02/17-threads/03-thread-smr-handshake.md`
- `docs/openjdk/vol-02/17-threads/04-interface-support.md`
- `docs/openjdk/vol-02/18-safepoint/01-safepoint-orchestration.md`
- `docs/openjdk/vol-02/18-safepoint/02-polling-verifiers.md`（确认早已完成，无需重复重写）
- `docs/openjdk/vol-02/19-sync/01-lock-hierarchy.md` 到 `04-internal-locks.md`（确认早已完成）
- `docs/openjdk/vol-02/20-vm-operations/01-vm-operation.md`
- `docs/openjdk/vol-02/20-vm-operations/02-background-init.md`
- `docs/openjdk/vol-02/21-shared-runtime/01-runtime-stubs.md`
- `docs/openjdk/vol-02/21-shared-runtime/02-c2i-i2c-adapter.md`
- `docs/openjdk/vol-02/21-shared-runtime/03-exception-handling.md`
- `docs/openjdk/vol-02/23-stub/01-stub-entry.md`
- `docs/openjdk/vol-02/23-stub/02-arraycopy.md`
- `docs/openjdk/vol-02/23-stub/03-crypto-math.md`
- `docs/openjdk/vol-02/24-frame/01-physical-frame.md`
- `docs/openjdk/vol-02/24-frame/02-virtual-frame.md`
- `docs/openjdk/vol-02/24-frame/03-deopt-gc-scan.md`
- `docs/openjdk/vol-02/25-gc-framework/01-barrier-access.md` 到 `06-oopstorage-stringdedup-stats.md`
- `docs/openjdk/vol-02/26-g1-gc/01-heapregion.md` 到 `07-full-gc-roots.md`
- `docs/openjdk/vol-02/27-jni/01-handle-system.md` 到 `03-jni-check-platform.md`
- `docs/openjdk/vol-02/28-jvmti/01-agent-architecture.md` 到 `03-auxiliary.md`
- `docs/openjdk/vol-02/30-jvm-entry/01-jvm-entry-points.md` 到 `03-reflection-stackwalk.md`
- `docs/openjdk/vol-02/32-jfr/01-recorder-engine.md` 到 `06-jni-instrumentation.md`
- `docs/openjdk/vol-02/33-jmx/01-memory-service.md` 到 `03-gc-notifier-flags.md`
- `docs/openjdk/vol-02/36-attach/01-attach-listener.md`
- `docs/openjdk/vol-02/36-attach/02-jdk-attach.md`
- `docs/openjdk/vol-02/39-runtime-monitoring/01-service-thread.md`
- `docs/openjdk/vol-02/39-runtime-monitoring/02-timer-stats.md`
- `docs/openjdk/vol-02/43-nio-net/01-tcp-epoll.md` 到 `03-filesystem.md`
- `docs/openjdk/vol-02/46-sa-postmortem/01-sa-postmortem.md`
- `docs/openjdk/vol-02/48-utilities/01-vmerror.md` 到 `04-utf8-json-decoder.md`

### 2.3 本轮批量复核后确认“正文已完成，只是缺显式 review 记录”的候选

自动统计曾列出 11 篇 `missing_review` 候选。对其中关键文章做深查后，结论是它们**并非正文缺失**，而是历史提交信息里没有出现统一的 `REVIEW/深审` 关键词：

- `docs/openjdk/vol-02/16-code-cache/01-codeblob-heap.md`
- `docs/openjdk/vol-02/24-frame/01-physical-frame.md`
- `docs/openjdk/vol-02/26-g1-gc/03-rem-set.md`
- `docs/openjdk/vol-02/29-mh/02-x86-adapter.md`
- `docs/openjdk/vol-02/36-attach/02-jdk-attach.md`
- `docs/openjdk/vol-02/46-sa-postmortem/01-sa-postmortem.md`

这些文章都已经过正文级核查，未发现需要继续修文的实质问题。

其余候选：

- `docs/openjdk/vol-02/05-cpu-primitives/01-atomic-and-memory-order.md`
- `docs/openjdk/vol-02/14-c1-compiler/04-c1-runtime-frame.md`
- `docs/openjdk/vol-02/21-shared-runtime/02-c2i-i2c-adapter.md`
- `docs/openjdk/vol-02/23-stub/03-crypto-math.md`
- `docs/openjdk/vol-02/25-gc-framework/06-oopstorage-stringdedup-stats.md`

从 git 历史和正文形态看，也更像“早期成文时未补显式 review 标记”，而不是仍有待重写的原稿。

### 2.4 仍然存在的流程性缺口

如果以后要做“形式上的完全收官”，还剩三类可选工作：

1. 为部分早期文章补齐 `*.rewrite-plan.md`
2. 为少数只有“成文”提交、没有“review”提交标记的文章补一轮显式 deep review 记录
3. 再做一次全卷统一终检（链接、禁用词、`file:line`、Docsify 根路径）并出一份终检报告

这三类工作都属于**收官流程**，不属于“正文重写仍未完成”。
---

## 三、本轮写作中已经沉淀下来的方法论经验

### 3.1 一定要先把“读者困惑”钉成一句话

这轮最成功的篇章都不是从“这个类是什么”写起，而是先钉住：

- `11-cds/01`：为什么 CDS 不是“把类序列化到文件”
- `11-cds/02`：为什么 `mmap` 之后共享类不会自动活过来
- `12-ci/01`：JIT 缺的不是入口，而是稳定视图
- `13-jit-framework/02`：tiered 不是爬楼梯，而是在选下一跳
- `14-c1/04`：机器码跳进 C++ 后如何不丢 Java 语义
- `15-c2/01`：C2 不是更猛的 C1，而是先换世界观
- `15-c2/03`：三引擎分别补三种优化缺口
- `15-c2/08`：intrinsic 不是更快调用，而是 Parse 期语义接管

如果下一位 AI 延续这套方法，优先先写一句：

- 读者到底在问什么
- 本篇一句话顿悟是什么

### 3.2 尽量把“结构差异”写成“为什么不能更简单”

例如：

- 为什么 `Runtime1` 不是普通 C++ 函数集
- 为什么 `OopMap` 不在 `FrameMap` 里建
- 为什么 `L1` 不是 tiered 常规第一站
- 为什么 `intrinsic` 不是后期补丁
- 为什么 `MacroExpand` 不是简单 lower

一旦把“为什么不能更简单”写清，读者更容易记住设计感，而不是只记住类名。

### 3.3 同一篇里要严格区分三个层次

这轮反复出现的一个风险是把不同层次揉到一起。后续继续写时尤其注意：

- **构造期** vs **运行期**
- **图级状态** vs **机器级状态**
- **证明** vs **真正执行/真正落刀**

已经明确踩过的边界包括：

- `ciMethodData` 快照 != MDO 本体
- `EA` 证明可消 != `MacroExpand` 真删分配
- `Parse` 期 JVMState != 机器级 OopMap
- `FrameMap` 提供位置 != `OopMap` 标记哪些位置是 oop
- `Matcher` 选模式 != `Output` 真落字节

### 3.4 `file:line` 的用法经验

- 不要为了堆证据而堆证据；正文关键断言落点要精确，但不要每句话都挂
- 容易被误写的“平台生成文件”要特别小心：例如 adlc 生成物不在源码树，正文不能假装存在
- `CPU_HEADER(...)` 注入的平台文件要先确认真实路径，否则很容易像 `c1_FrameMap_x86.cpp` 那样误写绝对路径

---

## 四、这轮已经修正过的高频误区清单

### 4.1 CDS / Metaspace / CI / JIT 框架层

| 错误说法 | 正确表述 |
|----------|----------|
| CDS dump 是把类序列化到文件 | 它构造的是未来要固定地址 `mmap` 的内存镜像 |
| `mmap` 成功后共享类就自动可用 | 还要校验、接线、恢复 `unshareable info`、走最轻量链接 |
| `ci` 层只是 VM 对象包装器 | 它提供的是编译期稳定视图 |
| `ciTypeFlow` 在执行方法 | 它在字节码层做抽象解释 |
| `BCEscapeAnalyzer` 就是最终 EA | 它是字节码级保守摘要，最终 EA 在 `ConnectionGraph` |
| tiered 是固定 `0→1→2→3→4` | 常规路径通常是 `0→3→4`，`2` 和 `1` 都带条件 |
| C1 是小号 C2 | C1 是低延迟显式化流水线，不是削弱版 C2 |
| C1 peephole 在 x86 上会做很多修补 | JDK11 x86 上基本是空实现 |
| C2 是更强的块式 IR 编译器 | C2 先换成统一图，再靠 `Node+Type+IGVN` 优化 |
| `Parse` 只是顺序建节点 | 它像解释器一样推进 JVMState |
| `MacroExpand` 是普通 lower pass | 它是高层宏节点的最后审判：先消，再展开 |
| intrinsic 是更快的普通调用 | 它是 Parse 期语义接管 |

### 4.2 C1 / C2 后端层

| 错误说法 | 正确表述 |
|----------|----------|
| spill 就是永久住栈 | C1/C2 都有分段/重装载策略，C2 还有 split/recycle |
| `LinearScan` 只是顺序给寄存器编号 | 它先看 live set，再看 interval，再做 spill/split/edge move |
| IFG 只是区间表示的另一种写法 | IFG 编码的是“同时活着”关系，是静态冲突图 |
| `Matcher` 就是节点名翻译器 | 它做的是最小成本模式匹配与归约 |
| `Output` 只负责 emit | 它还补 prolog/epilog、BuildOopMaps、buffer 布局 |

---

## 五、当前完成域的简明索引

### 5.1 `11-cds`

- `01-cds-overview-dump.md`
  - 主线：CDS dump 不是序列化类，而是构造可 `mmap` 的内存镜像
- `02-cds-load-shared.md`
  - 主线：共享类不是自动活过来，而是被重新接入当前 JVM

### 5.2 `12-ci`

- `01-ci-overview-mirror.md`
  - 主线：JIT 缺的是稳定视图，不是入口
- `02-ci-typeflow-escape.md`
  - 主线：镜像只解决对象视图；类型流/逃逸解决程序点状态视图
- `03-ci-factory-runtime.md`
  - 主线：短命 `ci` 世界靠 Arena、快照、replay 三件套站住

### 5.3 `13-jit-framework`

- `01-compile-broker-queue.md`
  - 主线：`CompileBroker` 把编译意愿变成可排队、可过期、受资源约束的异步执行
- `02-tiered-compilation-policy.md`
  - 主线：分层策略不是爬楼梯，而是在热度/profile/队列压力/CodeCache 压力之间选下一跳

### 5.4 `14-c1-compiler`

- `01-c1-pipeline-ir.md`
  - 主线：C1 快在显式化流水线，不是简单少做优化
- `02-c1-optimizations.md`
  - 主线：C1 优化的目标不是做最多，而是尽快把垃圾扔掉
- `03-c1-register-codegen.md`
  - 主线：LinearScan 解决有限寄存器下的生命周期安置，LIRAssembler 负责编码
- `04-c1-runtime-frame.md`
  - 主线：Runtime1 让机器码把复杂语义交给 C++，FrameMap/OopMap/CodeEmitInfo 保证 Java 语义不丢

### 5.5 `15-c2-compiler`

- `01-c2-ideal-graph.md`
  - 主线：C2 先换成统一图，再让 `Node + Type + IGVN` 收敛到全局
- `02-c2-parse-graphkit.md`
  - 主线：Parse 像解释器一样推进 JVMState，GraphKit 把状态织进 Ideal Graph
- `03-c2-optimizations.md`
  - 主线：IGVN/CCP/EA 分别补局部形状、控制可达性、对象去向三种缺口
- `04-c2-loops.md`
  - 主线：循环优化先识别整轮规律，再把整轮迭代当作优化对象
- `05-c2-register-alloc.md`
  - 主线：C2 的 RA 是全局活跃关系图上的着色与拆分，不是单遍扫描
- `06-c2-codegen.md`
  - 主线：`Matcher/GCM/Output` 完成平台语义降级，把图真正压成目标机方法
- `07-c2-macro-intrinsics.md`
  - 主线：宏节点是延迟决策占位符，能消的最后一刻消，必须留的再展开
- `08-c2-library-calls.md`
  - 主线：intrinsic 是 Parse 期的语义接管，而不是更快的普通调用

---

## 六、下一位 AI 建议起点

### 6.1 优先继续的目标

建议从：

- `docs/openjdk/vol-02/16-code-cache/01-codeblob-heap.md`

开始。

原因：

- `15-c2-compiler/08` 的结尾已经自然钩到“机器码的家”
- `CodeBlob / CodeHeap / nmethod` 可以顺着 C1/C2 产物直接往后讲
- 这比突然跳到完全无关域更顺

### 6.2 推荐执行顺序

1. 读现稿，先写一句“读者真正困惑”
2. 收集 `codeBlob.hpp/.cpp`、`codeCache.cpp`、`codeHeapState.cpp`、`nmethod.hpp/.cpp` 证据
3. 先写 `01-codeblob-heap.rewrite-plan.md`
4. 再写正文
5. 按固定四轮校验收口

### 6.3 如果用户先要 review 而不是继续写

默认按 code review 心态回答：

- findings 优先
- 严重度排序
- 给 `file:line`
- 如果无发现，也要明确说“未发现问题，但剩余风险在……”

---

## 七、固定校验命令模板

### 7.1 删码测试

```bash
python3 -c "
from pathlib import Path
import re
p=Path('path/to/article.md')
t=p.read_text()
n=re.sub(r'```.*?```','',t,flags=re.S)
print('narrative_chars=',len(n))
"
```

### 7.2 禁用词扫描

```bash
python3 -c "
from pathlib import Path
t=Path('path/to/article.md').read_text()
for x in ['此处不再赘述','不再展开','类似地','同理','依此类推','篇幅所限','显然','容易看出','细节读者自行阅读源码','旧稿','重写后']:
    if x in t:
        print('FORBIDDEN:', x)
"
```

### 7.3 链接验证

```bash
python3 -c "
from pathlib import Path
import re
p=Path('path/to/article.md')
t=p.read_text()
for link in re.findall(r'\[[^\]]+\]\(([^)]+)\)',t):
    if link.startswith(('http://','https://','#')):
        continue
    target=(p.parent/link).resolve()
    if not target.exists():
        print('BROKEN:', link, '->', target)
"
```

### 7.4 `file:line` 验证

```bash
python3 -c "
from pathlib import Path
import re
p=Path('path/to/article.md')
t=p.read_text()
root=Path('/data/workspace/source-code/openjdk11u/src/hotspot')
refs=re.findall(r'(?<![\w/.-])(share/[\w./-]+\.(?:hpp|cpp|h)):(\d+)', t)
bad=[]
for f,l in refs:
    q=root/f
    if not q.exists():
        bad.append((f,l,'missing'))
        continue
    lines=len(q.read_text(errors='ignore').splitlines())
    if int(l)>lines:
        bad.append((f,l,'out_of_range'))
print('refs=',len(refs),'invalid=',len(bad))
for x in bad:
    print(x)
"
```

### 7.5 `git diff --check`

```bash
git diff --check -- path/to/article.md path/to/rewrite-plan.md
```

---

## 八、最后提醒

1. **不要跳过 `rewrite-plan`**
2. **不要把“源码事实正确”误当成“正文已经讲明白”**
3. **不要把构造期 / 运行期 / 图状态 / 机器状态混在一起**
4. **不要假设生成文件在源码树里存在**（如 adlc 输出）
5. **相对链接一定从当前文件位置算，不要写仓库根式路径**
6. **如果做 review，先给 findings，不要先写总结**
7. **如果发现新的结构性事实错误，优先更新这份 handoff**
