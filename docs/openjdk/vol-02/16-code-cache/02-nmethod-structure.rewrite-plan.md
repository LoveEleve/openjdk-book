# 16-code-cache/02-nmethod-structure 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释 nmethod 为什么不是“机器码加一些附带表”，而是一段必须同时服务执行、GC、deopt、inline cache 与失效补丁的自描述代码对象

## 1. 选题判断

现稿已经有相当多的事实基础：
- 三个入口 `_entry_point / _verified_entry_point / _osr_entry_point`
- IC 与入口的配合
- nmethod 的整体布局注释
- offsets 逐段计算
- PcDesc / ScopeDesc
- 状态机、Patching_lock、nmethodLocker

但现在的问题是：事实虽然多，正文主线仍然偏“拆零件”。真正该打穿的读者困惑应该更集中：

**为什么一段编译后的 Java 方法不能只是“机器码 + 若干辅助表”？为什么 HotSpot 要把入口协议、常量、重定位、oop/metadata 索引、PcDesc/ScopeDesc、依赖、异常表、状态机都塞进同一个 `nmethod`，而且这些东西还要按特定顺序紧贴在一起？**

更直白一点：

**JIT 编出来的机器码为什么必须是“可执行、可回收、可反查、可反优化”的自描述对象？**

这才是本篇最该回答的问题。

## 2. 一句话顿悟

**nmethod 不是“机器码本体 + 配套材料”，而是一段带逆向导航能力的代码对象：线程要靠入口协议正确跳进去，GC 要靠 relocation/oop 表定位嵌入引用，deopt 要靠 `PcDesc + ScopeDesc` 把一个机器 PC 还原成一串 Java 帧，失效流程还要靠状态机与入口补丁阻止新调用继续闯入。HotSpot 把这些信息做成同一块连续内存，不是为了紧凑，而是为了让“给你一个 PC，就能恢复这段代码的全部语义身份”。**

## 3. 总图

```text
调用者进入 nmethod
  ├─ entry_point            : 带接收者类型检查
  ├─ verified_entry_point   : 已验证调用方直连
  └─ osr_entry_point        : 从解释器栈中途切入

nmethod 连续布局
  header
  relocations
  consts
  code body
  handlers / stubs
  oops / metadata
  scopes data
  pcs
  dependencies
  exception table
  implicit null table

运行时读取它
  ├─ IC / 调用协议：决定从哪扇门进
  ├─ GC：沿 relocation + oop/metadata 表更新嵌入引用
  ├─ Deopt：pc -> PcDesc -> ScopeDesc sender 链 -> Java 帧重建
  └─ 状态机：补丁 verified entry，禁止新调用继续进入
```

## 4. 结构大纲与字数预算

### 第一节：开场困惑——为什么编译方法不能只是裸机器码

目标约 1200 字。

- 从“机器码已经生成完了，为什么还要塞这么多表”切入
- 指出运行时真实需求：执行、GC、deopt、栈遍历、失效补丁
- 埋主线：nmethod 是一段“可逆”的代码对象

### 第二节：两个朴素理解为什么都不对

目标约 1800 字。

必须推演：
1. nmethod 只是“机器码 + 调试信息”
2. 这些辅助表完全可以散落在别处，没必要贴着代码放

结论：
- 表不是附加材料，而是运行时协议的一部分
- 分散存储会让按 PC 反查语义身份变得昂贵且脆弱

### 第三节：三扇门——为什么一段代码要有多个入口

目标约 2200 字。

- `_entry_point / _verified_entry_point / _osr_entry_point`
- x86 UEP 比较 `rax` 中期望 Klass 与接收者实际 Klass
- 动态调用点把缓存值放进 `mov rax, imm64`
- `CompiledIC::compute_monomorphic_entry` 说明何时走 verified / unverified
- 路标：先记住这是“进入协议”，不是“多一个地址字段”

### 第四节：连续布局——为什么所有东西要挤在同一块内存里

目标约 2100 字。

- 类注释总布局图
- `_consts_offset` 到 `_nmethod_end_offset` 的偏移链
- `consts` 在 code 之前、exception/deopt handlers 在 stub section
- `CodeCache::commit(this)` 之前后拷贝顺序的意义
- native wrapper 与普通 nmethod 的差别只点边界

### 第五节：GC 字典——为什么 relocation、oop 表、metadata 表必须在场

目标约 1800 字。

- 嵌入 oop/metadata 不是直接乱写指针
- index 0 保留给 null
- 这些表怎么让 GC 和补丁理解机器码里埋了什么
- 强调“代码也携带引用”，所以它不能被当成纯字节流

### 第六节：deopt 地图——为什么一个 PC 能还原出一串 Java 帧

目标约 2200 字。

- `PcDesc`：pc 偏移到 scope decode 偏移
- `ScopeDesc`：method / bci / locals / expressions / monitors
- sender 偏移链而不是指针链
- 解释内联后为什么一个机器 PC 对应多个 Java 帧
- 收回“可逆代码对象”主线

### 第七节：状态机与并发协议——为什么代码对象本身还要带生命体征

目标约 2200 字。

- `not_installed -> in_use -> not_entrant -> zombie -> unloaded`
- `Patching_lock` 下双重检查
- `patch_verified_entry` 把 verified entry 改道
- `nmethodLocker` 只是延迟回收，不改变状态
- 强调“结构”和“生命周期”在 nmethod 里并未完全分家

### 第八节：误解澄清与收网

目标约 1300 字。

至少回答：
1. nmethod 是否只是带调试信息的机器码
2. verified/unverified entry 是否只是性能优化
3. ScopeDesc 是否只是给 debugger 用
4. commit 之后再拷异常表是否说明它不重要
5. nmethodLocker 是否等于状态锁

## 5. 失败方案必须写进正文

1. 把 nmethod 理解成“机器码 + 调试附件”
2. 把各类表理解成可以独立散放的外围索引
3. 把 verified entry / 状态补丁理解成纯性能小技巧

## 6. 证据清单

- `share/code/nmethod.hpp:36`：nmethod 总布局注释
- `share/code/nmethod.hpp:90`：三个入口字段
- `share/code/nmethod.hpp:100`：主要段偏移字段
- `share/code/nmethod.hpp:316`：`entry_point / verified_entry_point`
- `share/code/nmethod.hpp:362`：`index 0 is reserved for null`
- `share/code/nmethod.hpp:438`：`is_locked_by_vm`
- `share/code/nmethod.cpp:685`：普通 nmethod 的偏移链计算
- `share/code/nmethod.cpp:718`：exception/deopt handlers 在 stub section
- `share/code/nmethod.cpp:756`：代码、values、debug info、dependencies 的拷贝顺序
- `share/code/nmethod.cpp:766`：`CodeCache::commit(this)`
- `share/code/nmethod.cpp:768`：异常表与 nul chk table 在 commit 后拷贝
- `share/code/nmethod.cpp:775`：静态方法 entry/verified entry 重合断言
- `share/code/nmethod.cpp:1144`：状态转换主逻辑
- `share/code/nmethod.cpp:1191`：`patch_verified_entry`
- `share/code/nmethod.cpp:1212`：`mark_as_seen_on_stack`
- `share/code/nmethod.cpp:2037`：`nmethodLocker`
- `share/code/compiledMethod.hpp:188`：状态枚举
- `share/code/compiledIC.cpp:373`：单态 IC 安装逻辑
- `share/code/compiledIC.cpp:463`：何时选择 verified / unverified entry
- `share/code/pcDesc.hpp:34`：`PcDesc` 三字段
- `share/code/scopeDesc.cpp:79`：`ScopeDesc` 解码头部
- `share/code/scopeDesc.cpp:148`：`is_top` / `sender`
- `share/compiler/compilerDefinitions.hpp:44`：`InvocationEntryBci = -1`
- `cpu/x86/x86_64.ad:1681`：UEP 上的 Klass 检查与对齐注释
- `cpu/x86/x86_64.ad:12834`：动态调用点的 `mov rax, imm64; call`
- `cpu/x86/nativeInst_x86.cpp:545`：verified entry 补丁
- `cpu/x86/nativeInst_x86.cpp:561`：8 字节原子写

## 7. 必须明确的边界

- 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
- 本篇聚焦“结构为什么这样组织”，不展开 sweeper 全流程和 deopt 执行细节
- 入口补丁与动态调用点示例以 x86_64 为例，其他平台只保留边界提醒
- `nmethod` 的 native wrapper 与普通 Java nmethod 有差异，正文只在必要处点边界
- JVMCI 分支存在若干例外，正文以主流 HotSpot C1/C2 路径为主

## 8. 完成后 review

- 删除代码后，能否复述“nmethod 是可逆的自描述代码对象”
- 是否把入口协议、连续布局、GC 字典、deopt 地图、状态补丁收回同一条主线
- 是否至少完整推演了两个失败方案，而不是直接列字段
- 是否清楚区分结构解释与生命周期细节，避免提前把下一篇抢写掉
- 是否完成删码测试、禁用词、链接、`file:line`、`git diff --check` 校验
