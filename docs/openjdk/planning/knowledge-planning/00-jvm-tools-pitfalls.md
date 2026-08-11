# 域 00 实操踩坑档案(2026-08-11)

> 定位: 域 00 工具探索实操的环境/工具踩坑记录——换机器、换环境、后续阶段实操前必读
> 与深审缺陷档案(`issue/源码分析深审缺陷档案.md` 13 类)互补: 那边管"规划/写作缺陷",这边管"实操环境坑"
> 每坑含: 现象 / 根因 / 解法 / 预防

---

## 一、进程与 Shell 类(最易踩,已两次中招)

### 坑 1: pkill -f 匹配到自身,杀掉自己的 shell 🔴 最坑
- **现象**: `pkill -f "Demo.java"` 后整个命令"超时",新进程永远起不来,日志全是旧内容——排查假象的来源
- **根因**: `-f` 匹配完整命令行,**bash 工具的命令行本身包含 "Demo.java" 字样**,pkill 把 bash 自己杀了,后续命令全部没执行
- **解法**: 用 `ps -eo pid,cmd | grep xxx | grep -v grep | awk '{print $1}'` 取 PID 再 kill
- **预防**: 任何 pkill 前先确认模式不会匹配到当前 shell;**旧日志残留是排查大敌——先看时间戳**(`stat -c '%y' log`)

### 坑 2: bash 工具超时杀掉后台进程
- **现象**: `setsid nohup xxx &` 后 sleep 等待,命令超时被杀,后台进程(尤其 JMC/demo)连带死掉
- **根因**: 后台进程的 stdout/stderr 仍挂在 shell 管道上,工具等管道关闭而超时
- **解法**: `setsid bash -c 'exec cmd > log 2>&1' < /dev/null > /dev/null 2>&1 &`(完全脱离)
- **预防**: 长任务用 setsid + 全部重定向;验证进程用 `ps -p <pid>` 而不是 pgrep -f(防误匹配)

### 坑 3: Xvfb 僵尸进程 / 连不上
- **现象**: `pgrep -f "Xvfb :99"` 有进程但 Java Robot 报 "Can't connect to X11 window server";`/tmp/.X11-unix/` 目录是空的
- **根因**: 残留的僵尸 Xvfb 占用进程名但 socket 已失效
- **解法**: `pkill -f "Xvfb :99"` 后重启(用 setsid 托管),**验证标准是 `/tmp/.X11-unix/X99` socket 文件存在**,不是 pgrep

---

## 二、JMC/Java 类

### 坑 4: JMC 9.1.2 需要 JDK 21(JMC 一直闪退)
- **现象**: JMC 启动即报错对话框 "An error has occurred",日志 `UnsupportedClassVersionError: class file version 65.0`(Java 21 编译),本机 JDK 17(61.0)
- **根因**: JMC 9.1.2 插件要求 Java 21+;交接文档"JDK 17 + JMC ✅"是**假标注**(环境从未验证过)
- **解法**: 装 JDK 21,`jmc.ini` 加:
  ```
  --launcher.appendVmargs
  -vm
  /opt/codev/TencentKona-21.0.12.b1/bin/java
  -vmargs
  ```
- **预防**: 任何 GUI 工具先看插件 class 版本要求;错误日志在 `JMC_HOME/configuration/*.log`

### 坑 5: Eclipse workspace 锁导致启动挂起
- **现象**: JMC 启动后无窗口,无新错误日志
- **根因**: 上次非正常退出留下的 `.metadata/.lock`
- **解法**: 删锁或换新 workspace(`-data <新目录>`)

### 坑 6: jcmd attach 用错 PID
- **现象**: `jcmd <pid>` 报 "target process doesn't respond / HotSpot VM not loaded"
- **根因**: `pgrep -f "xxx.jar"` 拿到的是 nohup/bash 包装进程,不是 java 本身
- **解法**: 从应用日志里的 `ProcessHandle.current().pid()` 取真实 PID,或 `ps -eo pid,cmd | grep java`
- **预防**: attach 前 `jcmd <pid> VM.version` 验证

---

## 三、async-profiler 类

### 坑 7: jfrsync 值必须是 JFR 配置路径(排查 1 小时)
- **现象**: `jfrsync=true` 报 `NoSuchFileException: true`;`jfrsync=abc123` 也报同样错 → 误判为 .so 缺陷
- **根因**: 源码 `flightRecorder.cpp:1448` — `_jfr_sync` 是 **JFR settings 配置**(传给 JDK `Configuration.create`),不是布尔开关!传 "true" 就是让它打开名为 "true" 的文件
- **解法**: `jfrsync=/path/profile.jfc`(或 `default`/`profile` 内置名)→ **ap21-sync.jfr 实证成功**
- **预防**: 读源码确认参数语义,别猜;jfrsync 模式 = AP 启动 JDK recording,一个文件含 JDK 全量事件 + AP 采样

### 坑 8: agentpath 启动的"临时 JVM"假象
- **现象**: `java -agentpath:so=start,event=cpu -cp /data/tmp/opencode`(无主类)报 "Profiling started" 但 0 秒录制、无采样
- **根因**: 该临时 JVM 自身加载 AP 并立即退出;要采样目标进程需 **agentpath 直启目标应用**
- **解法**: `java -agentpath:so=start,event=cpu,file=x.jfr -cp . Demo` 直启目标,采样后 `kill -SIGTERM` 触发 flush

### 坑 9: jcmd JVMTI.agent_load 的 options 被拆坏
- **现象**: `jcmd <pid> JVMTI.agent_load <so> "start,event=cpu,file=x.jfr"` 返回 100,目标进程报 "event must not be empty"
- **根因**: jcmd 对 options 的传递方式与 AP 期望不符(逗号被处理)
- **解法**: 不用 jcmd,直接用 agentpath 直启;或 Java attach API 的 `loadAgentLibrary`(库名需无路径无后缀,且目标进程要能找到库)

### 坑 10: "jfr2flame ✅" 假标注
- **现象**: 交接文档称 "async-profiler jfr2flame ✅(Arthas 仓库 converter)",实际仓库只有 3 个 .so
- **根因**: 从未实测就写 ✅(深审 #6);jfr2flame 在官方 release 的 converter.jar 里,仓库嵌入版没有
- **解法**: 火焰图用 JMC 自带视图 / AP 直接输出;文档已修正
- **预防**: 交接文档的 "✅" 全部实测复核

---

## 四、下载/工具安装类

### 坑 11: Eclipse MAT 官网目录页需 UA
- **现象**: `curl https://download.eclipse.org/mat/...` 返回 HTML(20KB"zip")
- **根因**: 目录页重定向/反爬
- **解法**: 带 `-H "User-Agent: Mozilla/5.0"` 或用 download.php 分发 URL;文件名可从目录页 HTML 抓(如 `MemoryAnalyzer-1.16.1.20250109-linux.gtk.x86_64.zip`)
- **注意**: 架构要选 x86_64(镜像常默认给 aarch64)

### 坑 12: 下载中断的"完整"文件
- **现象**: 用户下载的 JDK 21(131MB)tar 解压报 "unexpected end of file";MAT.zip 只有 9MB
- **根因**: 下载中断但文件名完整
- **解法**: 解压/校验先行(`tar -tzf`/`unzip -t`),再部署;完整版 213MB 早已下载在 /opt/tools

### 坑 13: MAT 命令行挂起
- **现象**: `ParseHeapDump.sh --help` 挂住(报错却等待 GUI)
- **根因**: 参数语法不对 + 无 DISPLAY
- **解法**: 正确语法 `./ParseHeapDump.sh <dump> org.eclipse.mat.api:suspects`,且 `PATH` 含 JDK21 + `DISPLAY=:99`(无头环境)

---

## 五、其他

### 坑 14: 演示程序寿命太短反复重启
- **现象**: Demo.java 120s 就退出,实验中途全部失效
- **解法**: 改 600s;采样对象要"活过"整个实验周期

### 坑 15: MCP SDK 新版本要求 Zod
- **现象**: 自写 MCP server 报 "expected a Zod schema or ToolAnnotations"
- **根因**: @modelcontextprotocol/sdk 1.30 参数 schema 必须 Zod
- **解法**: `z.string().default(":99")` 等

### 坑 16: JFR 录制"内容少"的真相——配置 threshold
- **现象**: math-game 用默认配置录的 JFR 事件极少
- **根因**: default.jfc 的 threshold(SafepointBegin 10ms/锁 20ms)过滤掉短事件
- **解法**: 素材采集统一 `settings=profile`(threshold 0ms);写文章用 "default vs profile" 对比当素材

### 坑 17: ExecutionSample.state 是线程状态,不是执行模式
- **现象**: B1.3 计划预期 `jfr print` 出现 state=INTERPRETED
- **根因**: jdk.ExecutionSample 的 state 字段 = java.lang.Thread.State(RUNNABLE/WAITING),
  无解释/编译标记;解释器模式没有专门 JFR 事件字段
- **解法**: -Xint 实证改判——`jfr summary` 中 `jdk.Compilation == 0` 即为解释模式
  (jfr-xint-executionsample.txt 已按此修正)

### 坑 18: bash 工具超时会杀整个进程组
- **现象**: nohup java Demo & 后,shell 120s 超时 java 也被杀(Demo 反复"神秘退出")
- **根因**: 工具超时清理按进程组 SIGKILL,nohup 不脱离进程组
- **解法**: `setsid java Demo > log 2>&1 < /dev/null &` 脱离进程组;
  PID 提取用 `ps -eo pid,args | awk '$2 ~ /java$/ && $0 ~ /Demo/ && $0 !~ /bash/'`
  (grep 会匹配 wrapper shell 自身命令行——坑 2 变体)

### 坑 19: ps/grep 匹配到 wrapper shell 自身
- **现象**: `ps aux | grep "java Demo"` 返回多个 PID,attach 报 "No such process"
- **根因**: bash -c 包装命令行里含有同名字符串
- **解法**: awk 精确匹配 `$2 ~ /java$/` + 排除 `/bash/`;或直接 jcmd 输出验证存活

---

## 六、排查方法论(以上坑的共性教训)

1. **先验证"进程真的在跑/日志真的新"**: `stat -c '%y'` 看时间戳,ps -p 看进程——**旧日志残留是最大假象源**
2. **pkill -f 谨慎**: 模式别匹配自身命令行
3. **参数语义读源码**: jfrsync 案例——1 小时排查不如 5 分钟看 flightRecorder.cpp
4. **AP 有 log 参数**: `log=/path` 输出解析后状态,AP 自带诊断
5. **假标注是毒**: 交接文档 ✅ 必须实测(深审 #6 纪律)
