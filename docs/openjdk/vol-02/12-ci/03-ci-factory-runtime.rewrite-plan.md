# 12-ci/03-ci-factory-runtime 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释 ci 域最后三个看似分散的问题——编译结束后镜像怎么清场、profile 数据怎么在编译期稳定可读、JIT bug 怎么做到事后原样重现——为什么其实是同一组约束下的三个面向

## 1. 选题判断

现稿已经覆盖了：
- `ciEnv`/`ciObjectFactory` 的 per-compilation 生命周期与 `remove_symbols`
- replay 文件如何导出、`ciReplay` 如何回放
- `ciMethodData` 如何在编译期从 `MethodData` 快照加载

但它更像三个尾声主题并列：生命周期、录制回放、`ciMethodData`。读者可能记住三个事实，却不一定看出它们为什么属于同一篇。

真正的共同困惑应该是：

**前面两篇一直强调 ci 是“一次编译一份快照、用完即弃”的短命世界。可 JIT 又必须同时满足三件互相拉扯的事：编译结束后快速清场、编译期间稳定读取仍在变化的 profile、以及事后还能把这次短命编译原样复活。HotSpot 是怎么同时做到这三件事的？**

这才是本篇应该打穿的问题。

## 2. 一句话顿悟

**ci 层之所以能“短命而不乱”，靠的是同一个设计：所有普通镜像都只活在一次编译的 Arena 里，编译期需要稳定读取的动态信息（`MethodData`）先快照成本地副本，而需要事后重现的输入（类状态、静态字段值、MDO/profile、内联树、计数器）则额外落到 replay 文件里。也就是说，ci 世界本身不追求长寿；它把“活多久”“怎么稳定看”“怎么死后复活”拆给 Arena、快照和 replay 三个机制分别负责。**

## 3. 总图

```text
ci 世界的基础前提：一次编译一份短命快照
  │
  ├─ 问题 1：编译结束后怎么清场？
  │    └─ Arena 整体回收 + 少量显式善后
  │
  ├─ 问题 2：编译期间 profile 还在变，怎么稳定读取？
  │    └─ ciMethodData 从 MDO 拷一份编译期快照
  │
  └─ 问题 3：编译已经死了，怎么事后重现？
       └─ replay 文件记录“那次编译看到的输入”
```

## 4. 结构大纲与字数预算

### 第一节：开场困惑——短命快照世界怎么还能稳定、还能回放

目标约 1300 字。

- 回收 01/02 两篇：ci 是 per-compilation 快照
- 抛出三难题：清场、稳定读 profile、死后复活
- 提前埋一句：三者其实都围绕“不要让 ci 世界自己变成长命状态系统”

### 第二节：三个直觉方案为什么都不对

目标约 1900 字。

必须推演：
1. 给每个 ci 对象做逐个释放/引用计数
2. 编译期间直接读活的 MDO
3. 回放时重建一个“假的 VM 世界”

结论：
- 逐个释放违背 Arena 模型，成本高、复杂度高
- 活读 MDO 会遇到并发更新，编译视图失去一致性
- 伪造整个 VM 世界太重，真正需要回放的是“编译输入”，不是整个运行时

### 第三节：生命周期——为什么 `ciEnv` 结束时只做两件事

目标约 1700 字。

- `ciEnv::~ciEnv`
- `remove_symbols`
- `current_thread->set_env(NULL)`
- 解释为什么没有逐个释放 ciObject
- 清楚交代：Arena 才是真正的释放者

### 第四节：为什么 replay 录的不是“ci 对象”，而是“那次编译看到的输入”

目标约 2000 字。

- `dump_compile_data`
- `dump_replay_data_unsafe`
- 录制触发途径：崩溃、CompileCommand、SA/core
- replay 文件包含：类状态、常量池 tag、static final、method counters、MDO、inline tree
- 主线：录的不是对象身份，而是编译所依赖的事实

### 第五节：为什么 replay 只能在 debug VM 里“复活编译”

目标约 1800 字。

- `ciReplay.hpp` 注释边界
- `ciReplay::replay` / `replay_impl`
- 回放时没有业务程序，VM 只排回放编译任务然后退出
- 说明 replay 不是用户功能，而是 HotSpot 工程师的确定性调试工具

### 第六节：回放到底复活了什么——不是 VM 世界，而是编译输入

目标约 2200 字。

- `ciReplay::initialize(ciMethod)`
- `ciReplay::initialize(ciMethodData)`
- 重新用当前 env/factory 解析类/方法，再把录制的计数与 profile 内容覆写进去
- 讲清“工厂照常建镜像，replay 只覆盖输入数据”

### 第七节：`ciMethodData`——为什么 profile 必须先快照再给编译器读

目标约 2400 字。

- `ciMethod::ensure_method_data`
- 没有 MDO 时编译期现场建
- `ciMethodData` 构造只是占位，`load_data()` 才真拷贝
- 两阶段复制：header/data/parameter data/extra data
- 并发线程仍在更新 MDO，所以只能拿“近似快照”
- 加载时把 oop/metadata 翻成 ci 等价物

### 第八节：Replay 与 `ciMethodData` 为什么其实是同一类动作

目标约 1400 字。

- `ciMethodData`：把“现在还在变化的数据”冻结成编译期快照
- replay：把“已经消失的那次编译输入”重新灌回当前编译
- 两者共同点：都在给短命 ci 世界提供稳定输入

### 第九节：误解清单与收网

目标约 1200 字。

至少回答：
1. ci 对象是不是一个个析构释放
2. replay 文件是不是一份“ci 对象 dump”
3. 回放是不是重建一个假的 VM
4. `ciMethodData` 是不是 `ciMethod` 构造时立刻就有
5. profile 快照要防的到底是 GC 还是并发更新

## 5. 失败方案必须写进正文

1. 为每个 ci 对象做长命引用计数和逐个析构
2. 编译期间直接读活的 `MethodData`
3. 回放时伪造整个 VM 对象世界

## 6. 证据清单

- `share/ci/ciEnv.cpp:215-223`：`ciEnv` 析构
- `share/ci/ciObjectFactory.cpp:223-229`：`remove_symbols`
- `share/ci/ciEnv.cpp:1203-1265`：dump compile/replay data
- `share/ci/ciReplay.hpp:33-79`：replay 的 debug-only 边界与用法
- `share/ci/ciReplay.cpp:1037-1113`：replay 入口
- `share/ci/ciReplay.cpp:1115-1165`：`initialize(ciMethodData)`
- `share/ci/ciReplay.cpp:1206-1233`：`initialize(ciMethod)`
- `share/ci/ciMethod.cpp:965-983` / `:1000-1015`：ensure/load method data
- `share/ci/ciMethodData.cpp:40-54`：构造只是占位
- `share/ci/ciMethodData.cpp:106-168`：extra data 准备与无 safepoint 复制
- `share/ci/ciMethodData.cpp:170-263`：`load_data()`
- `share/ci/ciInstanceKlass.cpp:728-743`：回放需要的类状态/static final 输出

## 7. 必须明确的边界

- 基于 JDK 11u HotSpot debug/release 行为差异
- replay 主要服务 HotSpot 调试，不把它写成普通用户功能
- 本篇聚焦 ci 域收尾，不深入 CompileBroker 调度
- MDO/MDO profile 的消费者只点到为止，不展开所有 profile 数据结构

## 8. 完成后 review

- 删除代码后，能否复述“短命 ci 世界靠 Arena、快照、replay 三件套站住”
- 是否把生命周期、`ciMethodData`、replay 三部分收回到同一个设计约束上
- 是否明确区分了：什么是 ci 对象本身，什么是编译输入，什么是运行时仍在变化的数据
- 是否完成删码测试、禁用词、file:line、链接、版本边界检查
