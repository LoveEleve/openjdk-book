# 内容审核与风控边界

> 对应目录：`vol-xhs/02-content-feed-interaction/`
> 目标问题：当前 `my-xhs` 的内容审核到底做到什么程度？为什么代码里同时存在 `status`、`auditStatus`、`rejectReason` 和 `DFAFilter`，但发布主链却又不是完整的人审平台？

## 一句话困惑

只要看到内容系统里出现：

- `status`
- `auditStatus`
- `rejectReason`
- `DFAFilter`
- “审核中 / 审核通过 / 审核拒绝” 这些枚举

读者几乎一定会自然联想到：这应该已经是一套完整的内容审核平台了。

但当你把发布链、草稿链、评论链和状态流转真正读完，又会发现另一件事：当前主链里，大部分内容其实是在 **DFA 通过后直接发布**，并没有进入一个真实独立的人审队列。于是问题就来了：**当前系统到底是“已经有审核平台，只是没讲清楚”，还是“模型上预留了审核语义，但实现上还停在规则前置阶段”？**

这篇就是要把这个边界说清楚。

## 一句话答案

当前 `my-xhs` 已经具备“审核语义模型”和“规则前置审核能力”，但还没有形成完整的人审流水线：`DFAFilter` 会在笔记发布和评论发表前做前置拦截，`NoteStatus` / `AuditStatus` 又为“草稿 → 审核中 → 发布/下架”这套状态机预留了模型空间；但在现阶段，发布主链实际走的是“规则审核通过即直接发布”，而不是“先进入审核池再由独立审核系统放行”。

## 先建立最小心智模型

先把当前内容审核链拆成两层：

```text
审核语义层
  内容理论上可以处于草稿 / 审核中 / 已发布 / 已下架
  审核结果理论上可以是待审 / 通过 / 拒绝

审核执行层
  当前真正落地的是 DFA 敏感词前置拦截
```

这两层看起来相近，但当前实现并不对称：

- 语义层已经准备得比较完整
- 执行层却还主要停留在自动规则过滤

这就是整篇最重要的边界：**当前系统更像“有审核模型、但审核执行仍以 DFA 前置为主”的状态。**

## 先推演第一个最直觉的失败方案：敏感词不过滤，先发出去再说

这是很多内容系统为了“发得快”会走上的路。

### 为什么这个方案很诱人

因为它非常顺：

- 用户一发就成功
- 内容立刻可见
- 审核逻辑可以异步慢慢补

看起来既提升发布体验，又不给主链加阻塞。

### 它会先坏在哪里

它会先坏在“内容一旦进入公开链路，回收代价会非常高”。

在当前系统里，一篇笔记一旦被视为“已发布”，后面很快就会继续进入：

- 详情查询
- 批量详情
- Feed 分发
- 推荐召回
- 搜索索引

也就是说，如果违规内容先放出去、再慢慢审核，它就可能进一步进入公开详情、Feed 分发、搜索索引或推荐候选这些下游链路。你面对的就不再是“挡住一次发布”，而是“从多个下游世界里回收一篇已经扩散出去的内容”。

所以当前实现没有采用“先发再说”的路径，而是选择让规则审核挡在内容入库前面。

## 再推演第二个失败方案：既然有 `auditStatus` 和 `AUDITING`，那当前一定已经是完整审核队列

这正是阅读代码时最容易误判的地方。

### 为什么这个误解很自然

因为模型层已经把审核状态准备得很完整。

`NoteStatus` 在 `my-xhs-content/src/main/java/com/myxhs/content/enums/NoteStatus.java:18` 到 `:23` 中定义了：

- 草稿
- 审核中
- 已发布
- 已下架

`AuditStatus` 在 `my-xhs-content/src/main/java/com/myxhs/content/enums/AuditStatus.java:11` 到 `:15` 中又定义了：

- 待审核
- 通过
- 拒绝

而 `Note` 实体本身也带：

- `status`
- `auditStatus`
- `rejectReason`

见 `my-xhs-content/src/main/java/com/myxhs/content/entity/Note.java:44` 到 `:54`。

仅从这些结构出发，完全可以脑补出一套完整审核平台：内容先进入审核中，再由审核结果推进状态。

### 它为什么在当前主链上并不成立

`NoteService.publishNote()` 的注释已经把当前主链真实行为写明了：

- 流程是“参数校验 → DFA 敏感词检测 → 入库(status=2)”
- 当前版本 DFA 通过即自动发布，不经过人工审核队列

见 `my-xhs-content/src/main/java/com/myxhs/content/service/NoteService.java:76` 到 `:81`。

具体代码里也是：

- 先 `checkSensitiveWords(...)`，见 `my-xhs-content/src/main/java/com/myxhs/content/service/NoteService.java:88` 到 `:90`
- 再直接 `note.setStatus(PUBLISHED)` 和 `note.setAuditStatus(APPROVED)`，见 `my-xhs-content/src/main/java/com/myxhs/content/service/NoteService.java:92` 到 `:96`

也就是说，当前实现里审核并不是：

```text
发布 → 审核池 → 审核通过 → 上线
```

而是：

```text
DFA 规则前置通过 → 直接视为审核通过并发布
```

这就是当前最需要诚实写清楚的边界。

## 第一步：DFA 过滤器到底在做什么

`DFAFilter` 的类注释在 `my-xhs-content/src/main/java/com/myxhs/content/filter/DFAFilter.java:20` 到 `:29` 中，已经把当前规则审核的核心思路讲透了：

- Trie 树（前缀树）
- 匹配复杂度 `O(n)`
- 预处理文本，去空格、特殊字符、全角转半角，防绕过

这说明当前审核并不是“查一张敏感词表”，而是一条明确优化过的高频文本拦截链。

### 规则词库还支持动态更新

`DFAFilter` 不只加载 classpath 文件里的静态词库，还会：

- 从 Redis 读取动态敏感词，见 `my-xhs-content/src/main/java/com/myxhs/content/filter/DFAFilter.java:128` 到 `:149`
- 通过 Redis Pub/Sub 广播重建 Trie，见 `my-xhs-content/src/main/java/com/myxhs/content/filter/DFAFilter.java:72` 到 `:95`

这说明当前系统虽然还没有完整审核平台，但并不意味着它只有一份写死词表。就规则层面看，它已经考虑了：

- 动态词库变更
- 多实例一致性
- 运行时重载

所以不能把当前实现写成“只有一个很原始的字符串过滤”。它已经是一条具备运行时维护能力的自动审核链。

## 第二步：发布主链里，审核是前置门禁，不是后置判决

`NoteController.publishNote()` 在 `my-xhs-content/src/main/java/com/myxhs/content/controller/NoteController.java:34` 到 `:49` 中，明确说“发布前自动进行 DFA 敏感词检测”。

服务层也完全遵守这个顺序：

1. 先 DFA 检测
2. 通过后构建 Note
3. 直接以已发布 + 审核通过状态入库

也就是说，当前发布链里的审核语义是：

```text
审核先于发布成立
```

而不是：

```text
发布先成立
审核结果后补
```

这个区别非常重要，因为它决定了内容是不是会先暴露给下游世界再去回收。

## 第三步：草稿、审核中、已发布在当前实现里并不是平均使用的三段状态

模型层预留了四种 `NoteStatus`，但当前主链的实际使用并不平均。

### 当前高频真实使用的是哪两段

- 草稿：`saveDraft()` 会把内容存成 `status=DRAFT`，见 `my-xhs-content/src/main/java/com/myxhs/content/service/NoteService.java:159` 到 `:178`
- 已发布：`publishNote()` 和 `publishDraft()` 在当前主链里都会直接推进到 `PUBLISHED + APPROVED`

### `AUDITING` 当前主要是模型预留位，而不是主链高频状态

`NoteStatus` 的流转图在 `my-xhs-content/src/main/java/com/myxhs/content/enums/NoteStatus.java:29` 到 `:42` 已经把“草稿 → 审核中 → 已发布/已下架”这套路径建好了。

而且它并不是完全没被识别：`publishDraft()` 在 `my-xhs-content/src/main/java/com/myxhs/content/service/NoteService.java:413` 到 `:417` 还会显式检查 `AUDITING` 状态，禁止草稿在审核中时被作者再次直接发布。

但当前真正走发布主链时，系统并没有先落 `AUDITING` 再等待异步审核，而是：

- 草稿可以直接发布
- 发布动作在规则通过后直接落为 `PUBLISHED`

这说明 `AUDITING` 在当前实现里主要还是模型层和状态流转层保留的中间态，而不是发布主链里高频被执行的真实状态。

## 第四步：评论审核链比笔记更“前置”

评论链可以帮助读者更清楚地看出当前审核的形态。

`CommentService.createComment()` 在 `my-xhs-content/src/main/java/com/myxhs/content/service/CommentService.java:67` 到 `:90` 中：

- 先校验笔记存在且已发布
- 再做 DFA 敏感词检测
- 命中敏感词直接抛业务异常
- 通过后才允许插入评论

评论这里没有：

- `审核中`
- `审核通过`
- `审核拒绝` 状态机

这意味着当前评论审核比笔记更明确：**它在审核相关部分主要体现为规则前置拦截，不存在“先发评论再等审核”的链。**

也就是说，当前系统的审核能力并不是统一一条流水线，而是：

- 笔记：模型层预留了审核语义，执行层主要靠 DFA 前置
- 评论：几乎完全是 DFA 前置拦截

## 第五步：`NoteEvent` 说明系统已经在为更细的审核归因留痕，但还没形成完整审核平台

`NoteEvent` 在 `my-xhs-content/src/main/java/com/myxhs/content/entity/NoteEvent.java:12` 到 `:16` 的注释里，明确写着它记录发布/审核时点，用于区分“发布少了”和“分发问题”。

这说明当前系统已经意识到一个非常重要的问题：**内容看不见，不一定是分发坏了，也可能是根本没发出来，或者审核前置拦住了。**

因此它会记录：

- 发布事件
- 审核状态相关事件（模型已预留）
- 下架等后续状态变化

但注意，这依然不等于“已经有完整审核平台”。它更像是在当前实现里先把审核相关的观测钩子预埋进去，为以后更复杂的审核流水线留出生长空间。

## 真实故障案例：为什么“有审核状态字段”比“真的有审核流程”更容易误导读代码的人

这篇最值得抓住的风险，不是敏感词没拦住，而是架构认知被模型字段误导。

### 现象

只看实体和枚举时，很容易得出一个结论：

- 有 `AUDITING`
- 有 `PENDING`
- 有 `REJECTED`
- 有 `rejectReason`

所以系统一定已经有完整审核流。

### 根因

根因不是代码写错，而是“模型预留能力”和“主链已落地能力”被混成了一层。

当前主链真正做的是：

- DFA 前置拦截
- 通过后直接 `APPROVED + PUBLISHED`

也就是说，模型里存在的中间态，并不自动代表它已经在主链里被真实走通。

### 修复

当前最重要的修复不是改代码，而是把边界写清楚：

- 审核语义模型已存在
- 主链执行仍以 DFA 前置为主
- 人工审核平台尚未真正成为内容发布主链的一部分

### 验证

验证这件事，不能只看枚举定义，而要看：

- 发布时是否真的先落 `AUDITING`
- 是否存在独立审核消费者/审核后台流程
- 评论是否也走同样的审核中状态

当前直接证据都指向：没有。

### 余波

这个案例说明，**内容审核最容易让人误判的，不是算法能力本身，而是模型层“看起来像有审核平台”，结果发布主链实际仍停在规则前置拦截阶段。**

## 这一篇先收束成一张总图

```text
当前审核主链
  发布/评论请求
    → DFA 敏感词检测
      → 通过：直接进入发布/写评论
      → 不通过：直接拒绝，不入公开链路

模型预留层
  NoteStatus: 草稿 / 审核中 / 已发布 / 已下架
  AuditStatus: 待审 / 通过 / 拒绝

当前边界
  有审核语义模型
  有动态规则词库
  但主链仍不是完整人工审核平台
```

这里最重要的不是背状态码，而是三条判断：

1. 当前系统已经有内容审核语义模型，但执行层仍以 DFA 前置拦截为主。
2. 对笔记来说，“审核通过后发布”和“DFA 通过即直接视为已审核发布”在当前实现里是同一件事。
3. 对评论来说，审核更明确地表现为“规则拦截前置”，而不是状态机后置处理。

## 证据清单

这篇的关键判断主要由以下证据托底：

- NoteStatus 流转模型：`my-xhs-content/src/main/java/com/myxhs/content/enums/NoteStatus.java:9`
- AuditStatus 枚举：`my-xhs-content/src/main/java/com/myxhs/content/enums/AuditStatus.java:7`
- Note 审核相关字段：`my-xhs-content/src/main/java/com/myxhs/content/entity/Note.java:44`
- DFA 过滤器与动态词库：`my-xhs-content/src/main/java/com/myxhs/content/filter/DFAFilter.java:20`、`my-xhs-content/src/main/java/com/myxhs/content/filter/DFAFilter.java:72`、`my-xhs-content/src/main/java/com/myxhs/content/filter/DFAFilter.java:128`
- 发布链当前 DFA 通过即发布：`my-xhs-content/src/main/java/com/myxhs/content/service/NoteService.java:76`
- 草稿链与发布草稿：`my-xhs-content/src/main/java/com/myxhs/content/service/NoteService.java:159`、`my-xhs-content/src/main/java/com/myxhs/content/service/NoteService.java:404`
- `AUDITING` 被状态流转逻辑识别：`my-xhs-content/src/main/java/com/myxhs/content/enums/NoteStatus.java:29`、`my-xhs-content/src/main/java/com/myxhs/content/service/NoteService.java:413`
- 评论链当前为规则前置拦截：`my-xhs-content/src/main/java/com/myxhs/content/service/CommentService.java:67`
- NoteEvent 记录发布/审核时点：`my-xhs-content/src/main/java/com/myxhs/content/entity/NoteEvent.java:12`

## 边界清单

- 本篇讨论的是当前实现下的内容审核边界，不把模型预留的审核状态误写成已落地的人审平台。
- 当前审核核心是 DFA 规则前置；是否接入更复杂的人工审核流、风控模型或机器审核平台，本文没有源码证据，不能外推。
- `rejectReason`、`AUDITING`、`REJECTED` 等字段和状态说明模型层已预留扩展空间，但不等于当前主链已使用它们。
- 本篇不展开敏感词词库来源、运营后台如何管理动态词库，这属于后续运维/平台专题。
- `ai-app`、`ai-mcp`、`ai-tools` 不进入本篇分析线。

## 这篇解决了什么，还留下什么问题

这篇先解决了三个问题：

- 为什么当前内容审核不能被简单理解成“已经有完整审核平台”。
- 为什么 `my-xhs` 的审核执行主链当前仍是 DFA 前置拦截，而不是先发后审。
- 为什么模型里存在的审核状态，比实际主链里已经用到的审核能力更宽。

到这里，`02-content-feed-interaction` 目录已经把发布、Feed、互动和审核边界这四条主线立住了。

下一步如果继续沿业务主链往前推，最自然的是回到 `06-search-recommendation-home` 之外的“用户入口”或“消息触达”；如果继续沿内容生态深挖，也可以转去 `07-im-notification-message`，因为互动和审核之后，通知与即时触达正好接上用户感知链。