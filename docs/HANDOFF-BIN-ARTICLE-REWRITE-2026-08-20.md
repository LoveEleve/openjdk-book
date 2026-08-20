# HANDOFF — BIN 方法论重写交接文档

> 更新时间：2026-08-20
> 仓库：`/data/workspace/source-code/openjdk-book`
> 工作目录：`/data/workspace/source-code/openjdk-book`
> JDK 11 源码树：`/data/workspace/source-code/code/spring/jdk11/src`
> 用途：交给下一位 AI，继续按 BIN 技术作者方法论和项目写作规范，推进 `docs/openjdk/vol-java/` 正文系统性重写。

---

## 1. 当前总目标

本轮工作的核心目标不是"把源码讲对"，而是：

> **把旧的事实卡片式/源码平铺式文章，重写成删掉代码后仍然成立的技术文章。**

统一写法必须遵守：

- 先有读者困惑，再有源码证据
- 先有失败方案，再有顿悟与设计感
- 先用角色/动机/障碍组织主线，再让代码承担证明作用
- 正文结构必须是：**问题 → 失败方案 → 顿悟 → 机制拆解 → 收网**
- 代码是证据，不是骨架

---

## 2. 必读文件

开始任何新工作前，必须先读：

- `docs/openjdk/WRITING-GUIDELINES.md`（最高写作标准）
- `docs/HANDOFF-BIN-ARTICLE-REWRITE.md`（早期交接，记录方法论转向）
- `docs/HANDOFF-BIN-ARTICLE-REWRITE-2026-08-19.md`（上一版交接，含详细工作方法）
- 本文：`docs/HANDOFF-BIN-ARTICLE-REWRITE-2026-08-20.md`（最新交接，含本轮完整进度）

---

## 3. 当前真实进度

### 3.1 已完成闭环的域（正文 + plan + 轻量收束）

以下域已完成 BIN 化重写，并已补充 JDK 11 版本边界和"五个最容易混掉的边界"收束节：

#### `01-string`

- `01-storage-immutable.md`
- `02-equals-hashcode-compare.md`
- `03-build-concat.md`
- `04-encoding-unicode.md`

#### `02-number-math`

- `01-wrapper-cache-boxing.md`
- `02-bigdecimal.md`
- `03-ieee754-math.md`

#### `03-object-system`

- `01-object-contract-references.md`
- `02-system-runtime.md`
- `03-process-native.md`

#### `04-reflection-annotation`

- `01-class-member-access.md`
- `02-methodaccessor.md`
- `03-proxy-access.md`
- `04-annotation.md`

#### `07-classloader`

- `01-delegation-model.md`
- `02-builtin-classloaders.md`
- `03-resource-spi.md`

#### `08-collections`

- `01-arraylist.md`
- `02-linkedlist-vector.md`
- `03-deque-priorityqueue.md`
- `04-iterator-failfast.md`
- `05-arrays-sort.md`
- `06-collections.md`

#### `09-map-hash`

- `01-hashmap-storage-hash.md`
- `02-resize-treeify.md`
- `03-linkedhashmap-treemap.md`
- `04-map-family.md`

#### `14-threadpool`

- `01-ctl-worker.md`
- `02-execute-worker.md`
- `03-shutdown-reject.md`
- `04-futuretask-scheduled.md`
- `05-executors-selection.md`

#### `15-async`

- `01-cf-basics.md`
- `02-compose-exception.md`
- `03-forkjoinpool.md`
- `04-forkjointask.md`

#### `17-io-streams`

- `01-byte-streams.md`
- `02-reader-writer.md`
- `03-file-filesystem.md`

#### `18-serialization`

- `01-protocol-flow.md`
- `02-serialversion-custom.md`
- `03-security-filter.md`

#### `19-buffer-channel`

- `01-buffer-state-machine.md`
- `02-bytebuffer-family.md`
- `03-filechannel-mmap.md`

#### `21-selector-nio`

- `01-selector-mechanism.md`
- `02-epoll-platform.md`
- `03-socketchannel-blocking.md`

#### `24-time-date`

- `01-core-value-types.md`
- `02-duration-period.md`
- `03-zone-rules.md`
- `04-formatter-parse.md`
- `05-zoned-offset.md`
- `06-clock-best-practice.md`

#### `25-agent-diagnostic`

- `01-attach-mechanism.md`
- `02-instrumentation.md`
- `03-diagnostic-tools.md`

#### `32-unsafe`

- `01-unsafe-overview.md`
- `02-offheap-directbuffer.md`
- `03-cas-park.md`

#### `34-jmx`

- `01-jmx-architecture.md`
- `02-objectname-register.md`
- `03-mbean-types-mxbean.md`
- `04-notification.md`
- `05-remote-tools.md`
- `06-production-practice.md`

#### `39-jfr`

- `01-jfr-overview-event-model.md`
- `02-custom-event-annotation.md`
- `03-bytecode-instrumentation.md`
- `04-recording-config.md`
- `05-consumer-api.md`
- `06-production-practice.md`（深度重写，已收束）

---

### 3.2 本轮新增完成的轻量收束域

本轮已按统一轻量收束规则补齐版本边界与“五个最容易混掉的边界”节，并完成禁用词/占位锚点/格式检查的域如下：

#### `06-exceptions`

- `01-throwable-structure.md`
- `02-exception-hierarchy.md`

#### `10-concurrent-collections`

- `01-chm-storage-rw.md`
- `02-resize-count.md`
- `03-skiplist.md`
- `04-copyonwrite-concurrentqueue.md`
- `05-blocking-queues.md`
- `06-transfer-selection.md`

#### `11-thread-threadlocal`

- `01-thread-lifecycle.md`
- `02-threadlocal.md`
- `03-exception-random.md`

#### `12-lock-sync`

- `01-aqs-core.md`
- `02-await-wakeup.md`
- `03-reentrantlock-condition.md`
- `04-shared-tools.md`
- `05-stamped-readwrite.md`

#### `13-atomic`

- `01-atomicinteger-cas.md`
- `02-striped64-longadder.md`
- `03-reference-updater.md`

#### `16-stream`

- `01-stream-api-lambda.md`
- `02-pipeline-lazy.md`
- `03-intermediate-ops.md`
- `04-terminal-eval.md`
- `05-collectors.md`
- `06-spliterator-parallel.md`

#### `36-jdbc`

- `01-drivermanager-loading.md`
- `02-connection-transaction.md`
- `03-xa-2pc.md`

---

## 4. 统一工作方法

### 4.1 收束操作（当前主要任务）

当旧稿已经相当接近 BIN 成稿标准时，采用**轻量收束**：

1. **顶部元信息**：在 `> 基于 JDK 11 ...` 行补上版本边界描述，格式为：
   > 本文讨论的是 JDK 11 xxx 边界，不把这里的 xxx 外推成所有 JDK 版本或所有场景的统一规范。

2. **"五个最容易混掉的边界"节**：在收网段落之前插入，格式为：
   - 标题：`## N、五个最容易混掉的边界：xxx 不是 xxx，xxx 不是 xxx，xxx 不是 xxx，xxx 不是 xxx，xxx 不是 xxx`
   - 五条边界，每条一段，格式：`第 N，xxx 不是 xxx。……`
   - 最后一段总结：`把这五条边界记稳，……就不会重新塌回……它真正想讲的是：……`

3. **检查**：
   ```bash
   rg -n '后面会讲|展开\)|第 [2-9] 篇|域 \d+ 展开|此处不再赘述|不再展开|类似地|同理|依此类推|篇幅所限|显然|容易看出|细节读者自行阅读源码' <article>.md
   rg --pcre2 -n '\([^)]*\.java:(?!\d)' <article>.md
   rg -n '\(\d{3,4} 行\)' <article>.md
   ```
   三项均为 0 命中。

### 4.2 当旧稿需要较大改动时

不是所有文章都要推倒重写。如果旧稿已有 BIN 化结构但偏薄（<150 行），只需：

- 补强开头问题驱动
- 补上"最容易混掉的边界"节
- 做禁用词/占位锚点检查

如果旧稿仍是事实卡片/源码平铺结构，则需：

- 先建 `.rewrite-plan.md`（必须包含：读者困惑、一句话顿悟、旧稿问题、理解路径、失败方案清单、误解清单、证据清单、版本与边界、验收标准）
- 按"问题 → 失败方案 → 顿悟 → 机制拆解 → 收网"重写正文
- 代码是证据，不是骨架

### 4.3 检查规则

禁用词检查（必须 0 命中）：
```bash
rg -n '后面会讲|展开\)|第 [2-9] 篇|域 \d+ 展开|此处不再赘述|不再展开|类似地|同理|依此类推|篇幅所限|显然|容易看出|细节读者自行阅读源码' <article>.md
```

占位锚点检查（必须 0 命中）：
```bash
rg --pcre2 -n '\([^)]*\.java:(?!\d)' <article>.md
rg -n '\(\d{3,4} 行\)' <article>.md
```

质量自查：
- 删除代码块后，主线仍成立
- 小标题能还原"问题 → 失败 → 顿悟 → 机制 → 收网"
- 写清 JDK 11 版本边界
- 写清至少 3 个误解 / 失败方案
- 没有只靠代码堆出正文结构

---

## 5. 推荐执行顺序

按从易到难、从轻量收束到深度重写的顺序：

### 第一阶段：轻量收束（本轮已完成）

以下文章已按域顺序完成轻量收束，并补齐 JDK 11 版本边界与“五个最容易混掉的边界”节：

1. `02-number-math/02-bigdecimal.md`
2. `02-number-math/03-ieee754-math.md`
3. `03-object-system/01-object-contract-references.md`
4. `06-exceptions/01-throwable-structure.md`
5. `06-exceptions/02-exception-hierarchy.md`
6. `10-concurrent-collections/01-chm-storage-rw.md` ~ `06-transfer-selection.md`
7. `11-thread-threadlocal/01-thread-lifecycle.md` ~ `03-exception-random.md`
8. `12-lock-sync/01-aqs-core.md` ~ `05-stamped-readwrite.md`
9. `13-atomic/01-atomicinteger-cas.md` ~ `03-reference-updater.md`
10. `14-threadpool/01-ctl-worker.md`、`02-execute-worker.md`、`04-futuretask-scheduled.md`
11. `16-stream/01-stream-api-lambda.md` ~ `06-spliterator-parallel.md`
12. `36-jdbc/01-drivermanager-loading.md` ~ `03-xa-2pc.md`
13. `39-jfr/01-jfr-overview-event-model.md` ~ `05-consumer-api.md`

补充说明：`14-threadpool/05-executors-selection.md` 与 `39-jfr/06-production-practice.md` 原本已带收束节，本轮复查确认通过，无需追加改写。

### 第二阶段：全量复查与深度重写候选

如果某些文章经复查后发现仍需深度重写（不符合 BIN 结构），则：

1. 建 `.rewrite-plan.md`
2. 按"问题 → 失败方案 → 顿悟 → 机制 → 收网"重写
3. 做禁用词/占位锚点检查

当前复查结论：本轮轻量收束文章整体已通过禁用词/占位锚点/格式检查。随后已开始进入第二阶段的深度精修候选处理，目前已完成四篇加深：
- `14-threadpool/01-ctl-worker.md`：补强开头的问题驱动和失败方案层，使正文更像完整 BIN 主线，而不只是骨架说明。
- `14-threadpool/02-execute-worker.md`：补强 `execute` 开头的三种失败方案与资源决策动机，把提交决策链与 Worker 生命周期更明确地压回同一主线。
- `14-threadpool/04-futuretask-scheduled.md`：清理重复收束层，把结果状态机与时间排序主线收口成单一边界节，避免文章尾部出现两套并行总结。
- `36-jdbc/01-drivermanager-loading.md`：补强开头的问题驱动与三种典型失败方案，把驱动发现、注册和 URL 路由更明确地压回同一主线。

---

## 6. 版本边界说明

- 基于 JDK 11 `java.base`
- 每篇文章顶部必须有版本边界描述，说明本文讨论的是 JDK 11 的实现，不把这里的具体实现外推成所有 JDK 版本的统一规范
- JLS 规范最低保证与 JDK 实现扩展分开叙述
- 具体缓存/行为规则必须逐类核对，不能从一个类推导全部

---

## 7. 注意事项

- **不要跳过检查**：每次收束后必须跑禁用词和锚点检查，0 命中才算完成
- **不要破坏已有结构**：轻量收束只加"最容易混掉的边界"节和顶部边界描述，不改已有正文
- **保持编号一致**：插入新节后检查小标题编号是否连续（一、二、三、五、六 或 一~七）
- **"最容易混掉的边界"节有固定格式**：标题一行、五条边界各一段、总结一段
- **收网段落保持不动**：新节插在收网段落之前，不改收网内容

---

## 8. 质量验收标准

每篇文章完成后必须满足：

- [ ] 顶部有 JDK 11 版本边界描述
- [ ] 有"五个最容易混掉的边界"节（在收网之前）
- [ ] 禁用词检查 0 命中
- [ ] 占位锚点检查 0 命中
- [ ] 删除代码块后主线仍成立
- [ ] 小标题能还原"问题 → 失败 → 顿悟 → 机制 → 收网"
- [ ] 没有只靠代码堆出正文结构
