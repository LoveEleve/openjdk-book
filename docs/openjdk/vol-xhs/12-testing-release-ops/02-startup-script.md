# 02 Startup Script：为什么这套启动脚本不是“把 java -jar 包一层”这么简单

如果说上一章测试策略关注的是“怎样证明系统真的按照你以为的方式在跑”，那启动脚本这一章要处理的，就是另一个更靠近工程底层、但同样经常被写轻的问题：**怎样把 15+ 个 JVM 以正确参数、正确 token、正确 profile、正确 agent、正确 PID 验证方式启动起来，并且让“看起来成功”的结果尽量接近真实成功。**

很多团队会把启动脚本看成一种很次要的运维胶水：把 `java -jar` 命令集中一下，加点端口和日志路径，脚本能跑就够了。`my-xhs` 的历史材料恰恰证明，这种看法在微服务系统里非常危险。因为脚本一旦掌握了统一重启、统一参数、统一健康检查、统一 pids 记录、统一 token 注入，它就不再是“胶水”，而是**系统如何被正确拉起、如何被错误误判、以及如何被运维与测试共同依赖的执行入口。**

前面的多轮复盘已经把这层复杂度暴露得非常清楚：`restart-service.sh` 的健康检查假阳性能把旧进程错认成新进程；历史 `start-all.sh` 里 `JAVA_OPTS_ANALYTICS` 的引号坏掉，会让 admin-token 根本没传进 JVM；`timeout` 过短又可能把启动中的 search 误杀；`pgrep -f` 自匹配、历史 pids 文件错误、setsid 包装 PID 与真实 Java PID 不一致，这些问题看起来都不像“业务 bug”，却会直接决定你后面所有验证和交付到底在对着哪个进程说话。`docs/review-1/02-findings/high/F-014-restart-script-health-check-false-positive.md:15` `docs/test-3/review/ANSWERS-DEPLOY-PACKAGE.md:164` `docs/test-3/HANDOFF-TASK11.md:152`

所以本篇真正要回答的，不是“脚本里配了哪些模块和端口”，而是：**为什么启动脚本在 `my-xhs` 里已经上升成一条真正的工程控制面；它到底在帮系统固化哪些易错前提；以及它本身为什么又会成为运行时假成功、参数缺失和错误 PID 传播的放大器。**

## 先给结论：`my-xhs` 的启动脚本不是命令集合，而是把“怎么启动才算正确”固化成一条工程协议

先别急着看 shell 细节，先把本篇最重要的人话答案钉住：`my-xhs` 的启动脚本，真正重要的不是能不能把 JVM 拉起来，而是它试图把“**模块名 → 端口 → JVM 参数 → profile → token → health 检查 → PID 记录**”这一整套运行前提固化成可重复执行的协议。

这条结论至少有三层含义。

第一，脚本不是在替代手工命令，而是在把一组很容易反复踩坑的前提条件收束起来。`gateway` 有特殊 JVM 参数，`analytics` 必须带 admin-token，`home` / `notification` 要 dev profile，`inventory` / `order` / `search` 属于 HEAVY 模块，启动参数都和普通模块不同。`scripts/restart-service.sh` 把这些差异直接编码进模块 → 端口 / OPTS 映射。`my-xhs/scripts/restart-service.sh:16`

第二，脚本不是只负责“起进程”，还负责“给出恢复证据”。它会等待 `/actuator/health`、回写 pids 文件、尝试统计环境变量里 token 是否存在。虽然这些证据链后来被证明还不够严，但脚本已经在承担一种“启动结果标准化”的角色。`my-xhs/scripts/restart-service.sh:52`

第三，脚本本身也是故障面。只要它对 PID、health、timeout、参数拼接或环境变量处理得不对，就会把原本局部的问题放大成系统性误判。也就是说，脚本既是恢复器，也是风险放大器。

## 直觉方案为什么不够：不是把 `java -jar` 抽出来就叫脚本化，也不是 health 200 就叫启动成功

### 失败方案一：每个模块手工 `java -jar`，按需临时加参数

这是最朴素的做法。服务起不来时，临时切到模块目录，手工拼一个 `java -jar`，加几个 `-D` 参数和 profile 进去，能起来就算修复了。

问题在于，`my-xhs` 的模块差异已经大到不适合这么做。只靠脑子记，很容易遗漏：

- `analytics` 需要 `-Dmanagement.admin-token`
- `home` / `notification` 某些测试控制器依赖 `dev` profile
- `gateway` 有自己独立的 JVM / Redis 参数
- `inventory` / `order` / `search` 内存配置更重
- 所有模块又都要带 SkyWalking agent

历史 handoff 里反复强调“重启一律用 `restart-service.sh`，禁止手搓”，本质上就是因为手工重启已经踩过太多次坑：自匹配、旧 PID、少 token、少 profile、少参数，最后不是服务没起，就是起了个不完整版本。`docs/test-3/HANDOFF-TASK11.md:150`

这说明脚本在这里真正替代的不是“敲命令的手”，而是“靠记忆拼前提条件”的高风险方式。

### 失败方案二：只要 `curl /actuator/health` 返回 200，就说明脚本成功

这类理解在 `my-xhs` 里已经被真实案例明确打脸。`F-014` 的复盘写得非常清楚：旧实例占着端口时，新进程因端口冲突 `APPLICATION FAILED TO START`，但脚本的 health 探测仍然会打到旧实例，返回 200，于是误报新服务已就绪。`docs/review-1/02-findings/high/F-014-restart-script-health-check-false-positive.md:15`

这说明健康检查在脚本里只是一个**弱证据**。它最多能说明“这个端口上有进程可响应”，但不能证明：

- 响应来自新 PID
- 新代码已经生效
- 正确的 token / profile / 参数都已进入进程
- 旧进程已经彻底退出

所以启动脚本这一章最关键的工程启示，不是“health 要不要查”，而是“**health 200 绝不能单独作为启动成功的最终证明。**”

### 失败方案三：脚本只是壳，真正的问题还是代码和配置

`my-xhs` 的历史材料已经证明这也不成立。`start-all.sh` 启动慢 / 卡死那轮复盘里，问题根因并不是业务代码逻辑，而是脚本层自己出了多处错误：

- `JAVA_OPTS_ANALYTICS` 引号坏掉，导致 token 丢失
- `JAVA_OPTS_HEAVY` 额外残留引号外内容，造成 command not found 噪音
- 末尾多余 `wait` 让脚本“永不返回”
- 健康检查 curl 没有 `--max-time`，导致空等
- `pgrep/pkill -f` 自匹配导致错误进程被杀

这些问题如果只从应用日志看，很多会被误解成配置缺失或启动慢；只有把脚本本身当作审查对象，才看得出来故障真正卡在哪。`docs/test-3/review/ANSWERS-DEPLOY-PACKAGE.md:164`

所以在 `my-xhs` 里，启动脚本不是中性的容器；它有自己独立的正确性。

## 先画总图：`restart-service.sh` 在这套系统里到底承担了哪些职责

先把脚本职责拆成一张文字图：

```text
模块输入
  -> 模块名 (gateway/user/content/.../search)

启动脚本职责
  1. 端口映射
     module -> port
  2. JVM 参数映射
     module -> SkyWalking / Xms/Xmx / token / 特殊系统属性
  3. Profile 注入
     home/notification -> dev
  4. 环境变量注入
     source .secrets/tokens.env -> ADMIN_TOKEN / INTERNAL_TOKEN
  5. 停旧进程
     ps/grep java command line -> kill old pid
  6. 拉起新进程
     setsid java ... -jar ...
  7. 弱就绪检查
     curl /actuator/health
  8. PID / 令牌记录
     写 pids 文件 + 校验 environ 中 token
```

这张图里最重要的，不是脚本做得多，而是它已经同时承担了三类责任：**参数编排、进程控制、结果验证。**

参数编排如果错，服务可能根本起不来；进程控制如果错，旧实例可能残留；结果验证如果错，就会出现最危险的假成功。也就是说，脚本已经是一个小型的运行控制器，而不是单纯命令封装。

## 参数编排这一层：模块差异已经大到必须编码进脚本，而不是留给人脑记忆

`restart-service.sh` 一开始就用两张映射表把模块和端口、模块和 JVM 参数绑死。`gateway`、`analytics`、`inventory`、`order`、`search` 都有特殊 `OPTS`；其中 `analytics` 明确拼入 `-Dmanagement.admin-token=${ADMIN_TOKEN}`，`inventory` / `order` / `search` 又把默认 `512m` 提升成更大的重型配置。`my-xhs/scripts/restart-service.sh:17`

这说明模块间差异已经不是“有时候多一个参数”的级别，而是**如果不按模块类型分层管理，就很难稳定启动**。脚本在这里扮演的是配置收敛器角色：把容易遗忘的 JVM 参数固化，而不是把它们散落给人去手工拼接。

这也是为什么历史材料里多次把 `#107 手搓启动必须 source .secrets/tokens.env` 和 `#79-1 手动操作带 INTERNAL_TOKEN/ADMIN_TOKEN` 写成纪律。因为一旦少了这层注入，很多模块不是降级运行，而是直接功能不可用甚至启动即报错。`docs/test-3/HANDOFF-TASK11.md:149`

## 进程控制这一层：为什么旧 PID、pgrep 自匹配和 setsid 会变成真实故障源

光把命令抽出来还不够，脚本还要负责停旧进程和拉起新进程。而 `my-xhs` 的复盘已经说明，这一层比想象中更脆弱。

`pitfalls.md` 里对 `#88` 的总结非常具体：

- `pgrep -f` 会自匹配，可能把 shell 自己识别成目标进程
- pids 文件会残留历史错误 PID，导致 kill 无效
- `setsid` 包装出的 PID 可能和真实 Java PID 混淆
- 旧进程没死净时，新进程会因端口冲突起不来

`docs/test-3/pitfalls.md:745`

这说明“停旧进程”在这里不是一句 `pkill` 能简单解决的事。因为脚本一旦拿错 PID，后面所有健康检查和 pids 更新都会跟着一起错。端口冲突篇已经把这条风险放大看过一次；放到启动脚本篇里看，它说明脚本的进程控制层本身就需要被当成一等公民审查。

## 结果验证这一层：为什么 `health`、`pid`、`token` 三条线必须交叉，且仍然不够

`restart-service.sh` 当前已经做了三类验证：

- `curl /actuator/health`
- 通过 `ps aux` 再抓一次 `JPID`
- 从 `/proc/$JPID/environ` 里 grep token 相关环境变量

`my-xhs/scripts/restart-service.sh:52`

这比完全不验证当然强很多，但 `F-014` 已经证明它仍然不够：health 可能打到旧实例，JPID 可能再次抓到旧进程，pids 文件也可能写错。换句话说，脚本已经在尝试用三条线交叉验证，但目前这三条线之间仍然没有强绑定关系。

这也是为什么 `F-014` 的修复建议会特别强调：

- 不是只杀一个 PID，而是全量清理匹配进程
- 不是只 curl 端口，而是要校验新 PID 真的监听该端口（`ss -lntp`）
- 不是只看 health，而是要看新日志里有没有 `APPLICATION FAILED TO START` / `Port already in use`

`docs/review-1/02-findings/high/F-014-restart-script-health-check-false-positive.md:37`

也就是说，**脚本当前已经是一套验证链，但这条验证链还不够强，尤其缺少端口监听 PID 与日志失败信号的刚性约束。**

## 真实故障案例：analytics admin-token 实际未传入，启动脚本“慢 / 卡死”背后其实是参数拼接错误

按照本卷方法论，每篇都要有一个能逼出设计问题的真实故障案例。对启动脚本篇来说，最适合的主案例不是端口冲突，而是 `start-all.sh` 启动慢 / 卡死那次复盘，因为它最能说明“脚本不是外壳，而是故障源”。

`ANSWERS-DEPLOY-PACKAGE.md` 已经把根因链写得非常细：历史 Python 修复时把 `JAVA_OPTS_ANALYTICS` 的引号吞掉，导致 shell 语法错误，变量为空，analytics 的 admin-token 没传进去，继而启动失败 / 空等 / 每次都要手动补救。与此同时，脚本末尾多余 `wait`、health curl 没有 `--max-time`、`pgrep` 自匹配等问题又进一步放大了“明明服务已经大多起来了，但脚本却迟迟不退出”的假象。`docs/test-3/review/ANSWERS-DEPLOY-PACKAGE.md:164`

用方法论五段式收它：

- 现象：全量启动“几十分钟”、脚本看起来卡死，analytics 甚至会起不来
- 根因：`JAVA_OPTS_ANALYTICS` 引号损坏导致 admin-token 未传入，再叠加 `wait`、无超时 curl、自匹配等脚本问题
- 修复：补齐引号、修正 HEAVY 参数、删多余 wait、给 curl 加 `--max-time`、避免自匹配
- 验证：文档已记录冷启动收敛到约 95 秒且 15 服务 UP
- 余波：以后启动慢 / 卡死不能先怀疑 JVM 本身，必须把脚本参数拼接链一起纳入排查

这个案例非常适合作为本篇主案例，因为它说明启动脚本出错时，表面症状往往会被误读成“应用启动慢”，实际上是参数层故障在制造连锁错觉。

## 为什么 `restart-service.sh` 既是解决方案，又仍然保留边界

从历史资料看，`restart-service.sh` 确实已经固化了大量踩坑教训：模块 → 端口映射、analytics token、dev profile、SkyWalking agent、setsid、pids 更新、health 等待，全都收进脚本了。`docs/test-3/pitfalls.md:753`

这说明它在 `my-xhs` 里确实已经从“脚本”升级成了工程协议的一部分。后续很多交接都要求：重启一律用这个脚本，禁止手搓。

但另一面也必须讲清楚：`F-014` 已经证明它仍然保留边界，尤其在旧进程残留和 health 假阳性路径上。也就是说，**脚本不是不该用，而是必须在使用它的同时继续审它。** 这是本篇最重要的工程态度：把启动脚本视作系统组件，而不是完美黑箱。

## 证据清单：本篇关键结论分别站在哪一层

L0 源码 / 脚本静态证据：

- `restart-service.sh` 明确维护了模块 → 端口 / 参数映射，并对 gateway、analytics、inventory、order、search 等做特殊 JVM 参数配置。`my-xhs/scripts/restart-service.sh:16`
- 脚本会 source `.secrets/tokens.env`，导出 `ADMIN_TOKEN` / `INTERNAL_TOKEN`，再做 health 等待、JPID 解析和 token 校验。`my-xhs/scripts/restart-service.sh:12`
- `F-014` 文档已精准指出脚本的三个关键弱点：只杀一个匹配 PID、只看 health、不校验新 PID 真正监听端口。`docs/review-1/02-findings/high/F-014-restart-script-health-check-false-positive.md:17`

L1 框架 / 语义证据：

- 启动脚本在 `my-xhs` 里已经承担参数编排、进程控制和结果验证三种职责，因此它本身就属于运行系统的一部分。
- health 200、PID 存在、token 存在这三类检查都只是弱证据，必须互相交叉且最好再叠日志校验，才更接近真实启动成功。
- 条件装配、Profile、系统属性和脚本参数拼接共同决定“代码能否以正确前提运行”，它们不是彼此独立的层。

L2 运行态证据：

- `docs/test-3/review/ANSWERS-DEPLOY-PACKAGE.md` 已记录 `start-all.sh` 从“几十分钟卡死”修到“冷启动约 95 秒且 15 服务 UP”的真实结果。`docs/test-3/review/ANSWERS-DEPLOY-PACKAGE.md:164`
- `F-014` 已记录 gateway 旧实例占端口时，脚本误报新实例 UP 的真实复现场景。`docs/review-1/02-findings/high/F-014-restart-script-health-check-false-positive.md:22`
- 当前本机 `19010/19016/19011/19012` 均实测 `OPEN`，说明相关模块现时监听已恢复；但这只说明现时状态，不等于脚本风险链永久消失。

## 边界清单：哪些话现在能说，哪些还不能写满

第一，当前可以明确写出 `restart-service.sh` 已经收敛了大量手工重启坑，但不能把它写成“启动脚本问题已经彻底解决”。`F-014` 已经说明 health/PID 绑定仍有边界。

第二，当前可以明确写出脚本在 `my-xhs` 里是运行协议的一部分，但不能把它写成“只要统一用脚本，启动成功就自动可信”。脚本本身也必须被持续审查和运行态验证。

第三，当前可以明确写出 analytics token、dev profile、HEAVY 配置等差异化参数已经被脚本固化，但不能把它写成“所有服务的所有特殊前提都已完全收口”。后续模块继续演进时，脚本仍可能滞后于真实依赖图。

第四，当前可以明确写出本机相关服务端口现在是 OPEN，但不能把这写成“由脚本拉起的新代码必然已在运行”。端口开放只是一层现时证据，不等于启动证据链闭环。

## 收网：这篇 Startup Script 真正建立了什么

到这里可以回收开头的问题了。`my-xhs` 的启动脚本不是“把 java -jar 包一层”的辅助文件，而是一条把模块端口、JVM 参数、token、profile、进程控制和健康验证收束起来的工程协议。它让这套 15+ 服务系统的拉起方式有了统一入口，也让参数差异、重启纪律和恢复证据链第一次被显性化。

从业务逻辑视角看，它守住的是“系统到底有没有以正确前提启动”这一切后续工作的起点；从工程视角看，它暴露的是脚本本身既是恢复器也是故障源；从分布式视角看，它说明多进程系统的“启动成功”必须是一个多证据交叉结论，而不是一个 curl 返回值；从微服务视角看，它让启动方式不再是口口相传的命令片段，而是可复盘、可交接、可持续修补的一层系统资产。

更重要的是，本篇把一个特别容易被低估的事实钉住了：**在 `my-xhs` 里，很多运行时问题不是发生在服务启动之后，而是发生在“我们以为服务已经正确启动”这一判断本身。**

这也正好和 `03-deploy-pipeline.md`、`04-monitoring-alert.md` 形成同一个主题：启动脚本、部署包和监控平台，其实都在回答同一个问题——**系统不能只是真的工作，还得能被正确地确认"它正在工作"。** 启动脚本篇讲的是"进程层面的假恢复"，部署篇讲的是"环境层面的假就绪"，监控篇讲的是"平台层面的假闭环"。三者共同构成 `my-xhs` 里"平台假成功"这一类故障的完整图景。

下一篇如果继续沿 `12-testing-release-ops/` 推进，最自然的顺序就是进入 `docs/openjdk/vol-xhs/12-testing-release-ops/03-deploy-pipeline.md`，把前面多次出现的部署包、配置导入、重启窗口和交付验证串成完整发布链。