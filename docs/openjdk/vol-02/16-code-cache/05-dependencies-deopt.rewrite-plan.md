# 16-code-cache/05-dependencies-deopt 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释 JIT 为什么敢基于暂时成立的类层次和调用目标去做激进优化，以及这些赌注一旦失效，HotSpot 如何靠 Dependencies 和记账/对账协议把执行安全退回解释器

## 1. 选题判断

现稿已有较好的事实基础：
- `DepType` 枚举
- 编译期 `assert_xxx`
- `nmethod` 里记录依赖并登记反向索引
- `spot_check_dependency_at` / `check_klass_dependency`
- `DeoptimizationBlob`、`fetch_unroll_info`、`unpack_frames`
- `Location` / `vframeArray`

但正文现在更像“依赖篇 + deopt 篇”拼在一起。真正该打穿的读者困惑更集中：

**JIT 明明知道未来类加载、方法演化、CallSite 目标变化都可能把当前观察打破，它为什么还敢做去虚拟化、唯一实现者假设、finalizer 跳过这类激进优化？而一旦赌输了，为什么不是局部修一下调用点，而是常常整段代码失效、整串内联 Java 帧都得退回解释器？**

这才是本篇最该回答的问题。

## 2. 一句话顿悟

**Dependencies 是 JIT 写下的“下注契约”：我之所以敢把某段动态语义压扁成静态代码，是因为我赌当前世界满足某个具体陈述。Deoptimization 则是契约失效后的退场保险：一旦类层次、方法内容或 CallSite 目标打破这些陈述，HotSpot 不去现场修补所有受影响机器码，而是让整段 `nmethod` 退出入口资格，并用 `ScopeDesc + vframeArray + UnrollBlock` 把正在执行的编译帧整串还原成解释器帧，再重新观察、重新编译。**

## 3. 总图

```text
编译期
  C1/C2 观察当前世界
    └─ assert_xxx(...) 记下依赖契约
         ↓
  dependencies 段 + 反向索引
    ├─ nmethod 自带赌注清单
    └─ 被依赖类 / CallSite 反向记住“谁在赌我”

世界变化时
  类加载 / 方法演化 / CallSite 变化
    └─ spot_check_dependency_at / check_xxx
         ↓ witness != NULL
  标记 nmethod for deoptimization / not_entrant

执行线程仍在代码里时
  DeoptimizationBlob
    ├─ fetch_unroll_info -> 收集内联 vframes / 计算 UnrollBlock
    └─ unpack_frames -> 把编译帧还原成解释器帧
```

## 4. 结构大纲与字数预算

### 第一节：开场困惑——JIT 为什么敢下注未来不会变

目标约 1200 字。

- 从去虚拟化、唯一实现者、CallSite 目标稳定切入
- 点出矛盾：优化靠“当前观察”，运行时世界却会继续变化
- 埋主线：敢下注的前提不是“永远正确”，而是“有账可查、有路可退”

### 第二节：两个朴素理解为什么都不对

目标约 1800 字。

必须推演：
1. JIT 只有完全确定时才优化，绝不赌未来
2. 赌输了只修局部调用点，不必整段代码失效/退解释器

结论：
- 激进优化本质上就是基于可撤销假设压扁动态语义
- 一旦假设影响了整段内联与控制流，局部补丁不够，需要整体退场

### 第三节：依赖契约——JIT 到底把什么写成了赌注

目标约 2200 字。

- `DepType` 家族按“类层次 / 方法 / 其他”分组
- `call_site_target_value` 与 `no_finalizable_subclasses` 等反直觉例子
- 解释“具体陈述”而非“泛泛相信类层次”
- 路标：记住每条依赖都必须可被逐条验证

### 第四节：编译期记账——为什么还要登记反向索引

目标约 2100 字。

- `assert_common_2/3` 如何按类型分桶和去重
- `dependencies->copy_to(this)` 把赌注写进 nmethod
- `nmethod.cpp` 里把依赖登记到 context klass / CallSite 的反向索引
- 强调这是为了避免类加载时全量扫描 CodeCache

### 第五节：运行时对账——谁来证明契约被打破了

目标约 2200 字。

- `spot_check_dependency_at`
- `check_klass_dependency` / `check_call_site_dependency`
- witness 的语义：找到打脸证据
- 说明验证只在变化点触发，不在平时热路径上收费

### 第六节：为什么赌输后常常要整段 deopt，而不是局部修补

目标约 1800 字。

- 去虚拟化、内联、逃逸消除、finalizer 跳过这类优化已经改写整段代码含义
- 与上一章 IC 局部补丁对比：IC 只缓存调用目标；依赖假设改变的是代码整体世界观
- 收回主线：契约失效意味着编译期视角本身失效

### 第七节：退场保险——DeoptimizationBlob 怎么把机器帧还原回 Java 帧

目标约 2300 字。

- `DeoptimizationBlob` 的多个 unpack 入口
- `fetch_unroll_info` / `fetch_unroll_info_helper`
- 收集内联 `compiledVFrame` 链
- `UnrollBlock` 先算账，再铺解释器骨架帧
- `unpack_frames` / `vframeArray::unpack_to_stack`

### 第八节：值是怎么找回来的——Location 与 ScopeValue 地图

目标约 1800 字。

- `Location::Where / Type`
- 在寄存器还是栈上、是普通值还是 oop / narrowoop
- 为什么 deopt 不是“恢复调用栈地址”这么简单，而是恢复 locals/expressions/monitors
- 收回“整串 Java 语义重建”主线

### 第九节：误解澄清与收网

目标约 1300 字。

至少回答：
1. Dependencies 是否只是调试日志
2. witness 是否只是“发现了新类”这么粗糙
3. CallSite 目标变化是否也走同一套契约框架
4. deopt 是否等于简单跳回解释器入口
5. 局部调用点补丁和整体 deopt 的边界在哪里

## 5. 失败方案必须写进正文

1. JIT 只有在未来永远不会变时才做优化
2. 契约失效后只要修局部调用点即可
3. 把 deopt 理解成“简单回解释器继续跑”

## 6. 证据清单

- `share/code/dependencies.hpp:104`：`DepType` 枚举
- `share/code/dependencies.hpp:178`：non_klass / explicit_ctxk 分类
- `share/code/dependencies.cpp:236`：`assert_common_2`
- `share/code/nmethod.cpp:512`：依赖登记到 klass / CallSite 的反向索引
- `share/code/dependencies.cpp:1984`：`check_klass_dependency`
- `share/code/dependencies.cpp:2029`：`check_call_site_dependency`
- `share/code/dependencies.cpp:2047`：`spot_check_dependency_at`
- `share/code/codeBlob.hpp:554`：`DeoptimizationBlob`
- `share/code/codeBlob.hpp:605`：`unpack / unpack_with_exception / unpack_with_reexecution`
- `share/runtime/deoptimization.cpp:139`：`fetch_unroll_info`
- `share/runtime/deoptimization.cpp:158`：`fetch_unroll_info_helper`
- `share/runtime/deoptimization.cpp:184`：收集 inlined vframes
- `share/runtime/deoptimization.cpp:623`：`unpack_frames`
- `share/runtime/vframeArray.cpp:567`：`unpack_to_stack`
- `share/code/location.hpp:45`：`Location::Where / Type`
- `share/prims/methodHandles.cpp:1074`：CallSite 反向依赖登记
- `share/oops/instanceKlass.cpp:2107`：klass 侧依赖登记

## 7. 必须明确的边界

- 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
- 本篇聚焦“契约与退场保险”，不深挖每一种依赖验证算法的全部细节
- deopt 汇编桩只讲结构角色，不展开整段平台汇编
- `ScopeDesc` 结构已在 16-02 建立，这里只消费，不重复大段重讲
- 后续不再继续 16 域时，要把这篇写成真正收官，而不是半章笔记

## 8. 完成后 review

- 删除代码后，能否复述“Dependencies 是下注契约，Deopt 是退场保险”
- 是否把记账、对账、整段退场而非局部补丁这条线讲透
- 是否清楚区分 IC 局部补丁与 dependency 失效导致的整体去优化
- 是否清楚说明 deopt 恢复的是整串 Java 语义帧，不只是 PC
- 是否完成删码测试、禁用词、链接、`file:line`、`git diff --check` 校验
