# Permission 与 SecretScope：Hermes 如何保护长期代理系统的边界

> 项目：Hermes（main 基线）
> 角色：主线机制正文 05
> 对应范围规划：`01-Hermes源码学习范围规划.md`
> 依据材料：
> - `Agent/analysis/hermes-agent/01-闭环笔记/pass2-hq31-authz.md`
> - `Agent/analysis/hermes-agent/01-闭环笔记/pass2-hq17-secret-scope.md`
> - `Agent/analysis/hermes-agent/01-闭环笔记/pass2-hq23-self-repo-guard.md`

---

## 零、阅读前提示

- 建议先读：
  1. `02-AIAgent主循环：Hermes 如何组织 turn、工具批与长期运行.md`
  2. `03-TurnRunner与GatewayRunner：Hermes 如何把多会话与多平台运行收进同一执行系统.md`
  3. `05-Memory与Skills：Hermes 为什么把学习闭环做成系统主线.md`
- 推荐源码阅读路径：
  1. `gateway/authz_mixin.py`
  2. `agent/secret_scope.py`
  3. `tools/self_repo_guard.py`
  4. `gateway/pairing.py`
  5. `tools/approval.py`

## 一、这一章真正的问题

到了 Hermes 这个规模，安全边界早就不只是：
- 某个命令要不要执行

真正的问题已经升级成：

> **谁被允许和 Agent 对话、哪个 profile 的密钥可以被当前回合看到、什么 git 操作会把运行中的仓库打穿、哪些边界必须 fail-closed。**

这一章真正要回答的是：

1. Hermes 如何同时处理入口授权、秘密作用域和自仓库保护？
2. 为什么这些问题不能散落在叶子工具里解决？
3. 为什么长期代理系统的边界控制必须进入运行主线，而不是作为“安全附加件”？

---

## 二、先给结论：Hermes 的边界控制不是一套权限判断，而是一组持续约束运行环境的控制面

最容易犯的错，是把这章理解成：
- 有个 authz mixin
- 有个 secret scope
- 有个 self repo guard
- 都属于安全杂项

这会把 Hermes 看浅。

更准确的理解应该是：

> **Hermes 在做的是“谁能进来、谁能读到什么、什么动作绝不能做”的三重边界控制。**

也就是说：
- `authz_mixin` 管入口
- `secret_scope` 管凭证隔离
- `self_repo_guard` 管运行仓库自保护

这三者合起来，才是长期代理系统真正的边界层。

---

## 三、为什么 GatewayAuthorizationMixin 不是平台外壳细节

`authz_mixin.py` 看起来像个 gateway 辅助模块，但它的地位比“适配器代码”高得多。

它在回答：
- 谁允许和这个 agent 对话？
- DM 和 group 的策略是不是一样？
- 平台自己已经有授权，还是 Hermes 还要做一层本地策略？
- 未授权时要静默、提示、拒绝还是要求配对？

这意味着它的本质是：
> **入口授权控制面。**

如果这层没有被统一收口，就会发生：
- 不同平台各自做一套授权逻辑
- 同一个用户在不同渠道得到不同边界
- pairing / allowlist / upstream 授权互相打架

Hermes 显然不接受这种状态，所以才有：
- adapter 解析链
- DM / group policy
- upstream vs local policy 区分
- pairing store 持久化

这已经不是“接平台时顺便写的认证代码”，而是系统运行入口的一部分。

---

## 四、为什么 SecretScope 在 Hermes 里不是配置加载器，而是多 profile 隔离机制

SecretScope 最值得学的地方，不是它能不能读 `.env`，而是它试图解决一个真实而危险的问题：

> **一个 gateway 进程服务多个 profile 时，不能把 profile A 的密钥泄露给 profile B。**

所以 Hermes 的做法不是：
- 全部 union 进 `os.environ`

而是：
- 使用 `contextvar`
- 每个 task / thread 有自己的 secret scope
- multiplex 开时 fail-closed
- multiplex 关时保持单 profile 向后兼容

这非常成熟，因为它明确区分了两种部署形态：

### 单 profile
- 透明兼容
- 不破坏旧行为

### multiplex 多 profile
- 未作用域读直接报 `UnscopedSecretError`
- 绝不冒险把别的 profile 凭证给当前回合

这说明 Hermes 的原则是：
> **只有真的存在隔离风险时，才付 fail-closed 的成本。**

这和“一律最严”不同，它更工程化。

---

## 五、为什么豁免名单和 round-trip 解析器都是边界主线的一部分

SecretScope 里还有两个很容易被低估的点：

### 1. 全局豁免名单
不是所有环境变量都该被 profile-scope 化。
Hermes 明确把：
- PATH
- HERMES_HOME
- API_SERVER_ENABLED / HOST / PORT 等部署配置
列为全局豁免

但像：
- API_SERVER_KEY
这样的凭证，刻意不豁免。

这说明它在做一个成熟的判断：
> **部署配置可以全局，凭证必须受 profile 约束。**

### 2. round-trip `.env` 解析器
它很在意：
- 引号
- 转义
- 内联注释
- BOM

为什么这不是小细节？
因为如果 scoped path 读到的密钥和交互式 shell 里看到的不一致：
- 你以为是 provider 问题
- 实际上是 secret parser 坏了

所以 Hermes 这里保护的是：
> **凭证值的字节级稳定性。**

这属于真正的工程边界问题，不是语法洁癖。

---

## 六、为什么 SelfRepoGuard 是长期代理系统才会有的自保护层

`self_repo_guard.py` 很容易被误解成：
- 一个防误操作小工具

但它其实在处理一个更危险的问题：

> **Agent 在自己的源码仓里运行时，某些 git 操作会直接重写支撑当前进程的 checkout。**

比如：
- checkout
- switch
- rebase
- merge
- pull
- restore
- clean
- worktree remove / move
- `gh pr checkout`

如果这些命令直接执行成功，结果会是：
- 进程内加载的代码版本
- 与磁盘上的代码版本
失去一致性

这就不是“用户改坏仓库”，而是：
> **运行中的代理失去了对自己支撑代码的语义稳定性。**

所以 SelfRepoGuard 的本质不是 git 命令黑名单，而是：
- 作用域追踪
- 别名递归解析
- heredoc / shell 混淆反解
- worktree / gh 桥覆盖
- 本地环境非绕过接入

这已经是一层：
> **Agent 自保护机制。**

---

## 七、这一章真正解决了哪些工程问题？

### 1. 如何控制谁可以和 agent 建立对话入口
Hermes 的解法：GatewayAuthorizationMixin + adapter/profile/pairing/policy

### 2. 如何在一个进程里隔离多个 profile 的凭证
Hermes 的解法：SecretScope + contextvar + multiplex fail-closed

### 3. 如何区分部署配置和真正凭证
Hermes 的解法：全局豁免名单 + profile-scoped secrets

### 4. 如何防止运行中的 agent 把自己的代码基座打穿
Hermes 的解法：SelfRepoGuard

### 5. 如何让边界控制不依赖“每个工具自己懂事”
Hermes 的解法：把这些逻辑抬到 gateway / runtime / secret / repo guard 这几层统一解决

所以这章真正要学的，不是“安全功能很多”，而是：

> **Hermes 如何把入口、凭证和自仓库保护统一成长期代理系统的边界控制面。**

---

## 八、读者最容易学错的地方

### 错觉 1：authz_mixin 只是平台适配器附属物
错。它是入口授权控制面。

### 错觉 2：secret_scope 只是配置加载器
错。它是在解决多 profile 进程内凭证隔离。

### 错觉 3：全局豁免名单只是实现细节
错。它在区分“部署配置”和“真正秘密”。

### 错觉 4：self_repo_guard 只是怕用户误操作 git
错。它在防运行时语义被自己打穿。

### 错觉 5：这些都是边角安全功能
错。对长期代理系统来说，它们直接决定系统能否安全运行。

---

## 九、分析边界

### 为什么这里不先展开具体 approval 交互 UI
因为这一章先讲控制边界本身，而不是人机界面的呈现方式。

### 为什么这里不先深挖每个 secret source 插件实现
因为第一轮重点是 SecretScope 的隔离哲学，而不是 Bitwarden / 1Password / command source 的细节。

### 为什么 self_repo_guard 要进主线
因为它不是一个小 lint，而是在保护“运行中的系统是否还能信任自己的支撑代码”。

---

## 十、读者分层路由

### beginner
先抓住：
1. Hermes 要同时控制入口、凭证和自仓库边界
2. secret_scope 不是为了方便读 `.env`，而是为了隔离 profile
3. self_repo_guard 是在保护运行系统本身

### intermediate
重点看：
- adapter 授权链
- DM / group 策略
- multiplex fail-closed
- global env 豁免
- self repo mutation 分类

### advanced
重点看：
- contextvar secret scope 与 per-task 隔离
- round-trip 解析器为什么重要
- self_repo_guard 的 shell 反混淆与 alias 递归
- 为什么这些边界要抬到运行时主线，而不是交给叶子工具

---

## 十一、迁移清单

### 可迁移思想 1：入口授权是平台级控制面
- 可迁移到：多平台、多渠道、多 profile 的 Agent 系统
- 前提：系统真的有多个对话入口
- 不适合直接照搬到：单一 CLI 工具

### 可迁移思想 2：凭证按 task/profile 作用域隔离
- 可迁移到：multiplex 网关、多人共用进程、代理型调度系统
- 前提：一个进程可能同时服务多个 profile
- 不适合直接照搬到：单用户单 profile 的简单本地工具

### 可迁移思想 3：部署配置与秘密分离
- 可迁移到：所有复杂 Agent 平台
- 前提：存在既全局又私有的环境变量
- 不适合直接照搬到：极小系统（但长期仍建议保留）

### 可迁移思想 4：自仓库保护
- 可迁移到：Agent 会修改、checkout、rebase 自己源码仓的系统
- 前提：运行时依赖当前 checkout 代码
- 不适合直接照搬到：远端沙箱完全隔离、不会触碰自身仓库的系统

---

## 十二、自测问题

1. 为什么 Hermes 的边界控制不能只靠 permission？
2. 为什么 SecretScope 必须在 multiplex 模式下 fail-closed？
3. 为什么部署配置可以豁免，但凭证不应豁免？
4. 为什么 SelfRepoGuard 不只是防误操作，而是保护运行时语义？
5. 为什么这些边界问题必须抬到运行时主线，而不是让每个 tool 自己处理？

---

## 十三、读完这一章，读者应该获得什么能力？

至少应该能做到：

1. 解释 Hermes 为什么要把入口授权、凭证隔离和自仓库保护统一纳入主线。
2. 说清 GatewayAuthorizationMixin、SecretScope、SelfRepoGuard 各自的系统角色。
3. 理解为什么多 profile 进程比单 profile CLI 对边界控制要求高得多。
4. 理解为什么“运行中的代理也要保护自己的代码基座”是一个真实问题。
5. 用自己的话说明：Hermes 为什么比很多 Agent 项目更接近一个长期运行的、安全敏感的代理系统。

如果还做不到这些，就说明这章还没真正学懂。
