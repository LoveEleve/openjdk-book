# 06-oops/04-constantpool-method 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释字节码里的编号如何一步步变成可直接执行的方法入口和字段偏移

## 1. 选题判断

现稿是四块事实卡片并列：ConstantPool / ConstantPoolCache / Method / MethodData。读者看完知道"有这些东西"，但不知道为什么热路径只需要读一个槽位就够。

真正的读者困惑：

**`invokevirtual #5` 第一次执行时要加载类、查方法、做访问检查、算 vtable index——这些代价如何只付一次？第二次执行时，解释器凭什么只读一个 `_f2` 就能直接拿到答案？ `_f1`/`_f2`/`_flags` 三个字段为什么能同时服务 getfield、invokevirtual、invokeinterface、invokedynamic 这些完全不同的字节码？**

## 2. 一句话顿悟

**解析把符号引用的痛苦一次性吃完，然后把结果固化成一个多义条目：`_f1` 存 Method* 或字段/接口持有者的 Klass*，`_f2` 存 vtable index、字段偏移或 final Method*，`_flags` 用一位区分 field/method 并编码类型。字节码在条目里的编号化身，第二次起只需读取已发布的条目并执行必要位测试，就能直达目标。**

## 3. 总图

```text
字节码 #5 (符号引用)
  │
  ├─ 第一次执行 → InterpreterRuntime::resolve_from_cache
  │    ├─ LinkResolver: 类加载 → 方法查找 → 访问检查 → vtable index
  │    └─ 结果写回 cpCache 条目 (_f1/_f2/_flags + bytecode 槽)
  │
  ├─ 第二次执行 → 读 _indices 检查 bytecode 槽
  │    ├─ bytecode 匹配 → 已解析
  │    │    ├─ field: _f1 = 持有者 Klass*, _f2 = 偏移, _flags 的 TosState 分派
  │    │    ├─ invokevirtual: _f2 = vtable index (或 is_vfinal → _f2 = Method*)
  │    │    ├─ invokespecial/static: _f1 = Method*
  │    │    ├─ invokeinterface: _f1 = 接口 Klass*, _f2 = 接口 Method*
  │    │    └─ invokedynamic/handle: _f1 = adapter Method*, appendix 在 resolved_references
  │    └─ 一条指令 → 一次读 + 一次位测试 → 直达目标

Method (方法的宿主)
  ├─ ConstMethod: 字节码 + 异常表 + 行号表 (不可变, CDS 只读)
  ├─ 运行时入口: _i2i / _from_interpreted / _from_compiled (可变, volatile)
  └─ 编译切换: set_code 在 Patching_lock 下原子换入口
```

## 4. 结构大纲与字数预算

### 第一节：事故开场——同一个 `invokevirtual #5`，第一次和第二次凭什么差这么多

目标约 1000 字。

- `invokevirtual #5` 的第一次：类加载、方法查找、访问检查、vtable index 计算
- 第二次：一次内存读拿到 vtable index，直接查表
- 提出核心问题：中间发生了什么让代价从 O(类加载) 降到 O(一次读)
- 回收上篇钩子：`InstanceKlass._constants` 指向的就是这座仓库

### 第二节：朴素方案为什么不行

目标约 1800 字。

至少展开三个失败方案：

1. 每次执行都重新解析符号引用 → 代价不可接受
2. 解析结果存回常量池条日本体 → tag 多义性冲突，且无法区分 get/put
3. 每种字节码给一个独立的缓存结构 → 条目数量翻倍，解释器要在调用点先判断走哪种结构

引出：需要一个多义、紧凑、按字节码类型自动选槽位的统一缓存条目。

### 第三节：ConstantPool——符号引用住在哪里

目标约 1500 字。

- `_tags` 一字节一锚：tag 先于内容被读
- `klass_at_impl` 的 "已解析快路径"：先查 `_resolved_klasses` 数组，未解析才走 `SystemDictionary`
- 解析成功后 `release_store` + `release_tag_at_put` 的发布顺序
- 符号引用和直接引用共用条目空间，靠 tag 区分
- CP 条目只存符号引用和部分直接量；直接引用结果不在 CP 本体，而在 cpCache

### 第四节：ConstantPoolCache——解析结果如何住进一个四字条目

目标约 2200 字（核心拆解层，必须充分展开）。

- 四字布局：`_indices` / `_f1` / `_f2` / `_flags`
- `_indices` 低 16 位是 CP 编号，高两个字节是 bytecode_1 / bytecode_2
  - 为什么 invokevirtual 用 bytecode_2，invokespecial 用 bytecode_1：一个条目可同时服务两种字节码
  - bytecode 槽是"已解析"标志：用 release_store 写入作为发布栅栏
- `_flags` 的 `is_field_entry` 位是全局分叉点
  - field 条目：`_f1` = holder, `_f2` = 偏移
  - method 条目：`_f1` 或 `_f2` 按 bytecode 分工
- method 条目的四种子形态：
  - 非虚直接调用：`_f1` = Method*
  - 虚调用带 vtable index：`_f2` = vtable index
  - final 虚调用：`_f2` = Method* (is_vfinal 位区分)
  - 接口调用：`_f1` = 接口 Klass*, `_f2` = 接口 Method*
- invokedynamic / invokehandle 的特殊性：adapter 在 _f1，appendix 在 resolved_references
- 关键设计：写顺序是 `_f1`/`_f2`/`_flags` 先写，bytecode 最后 release_store
  - 读者先 acquire-load bytecode，非零就保证其余字段可见

### 第五节：模板解释器的快路径——第二次执行到底发生了什么

目标约 1500 字。

- `resolve_cache_and_index`：一条 `cmpl` 判断是否已解析
- `load_invoke_cp_cache_entry`：bytecode 编号在编译期就决定了读 `_f1` 还是 `_f2`
- `invokevirtual_helper`：一位 `testl` 判断 is_vfinal
  - 是：`_f2` 就是 Method*，直接跳
  - 否：`_f2` 是 vtable index，`lookup_virtual_method` 一次查表
- getfield 快路径：`_f2` 是偏移，`_flags` 的 TosState 分发跳转梯
- bytecode rewriting：首次解析后把 getfield 改写成 `_fast_igetfield`，类型烤进 opcode

### 第六节：Method——方法入口为什么有三种，怎么无缝切换

目标约 1800 字（核心拆解层）。

- ConstMethod 为什么和 Method 分开：不可变数据 CDS 只读共享 vs 可变入口点
- `code_base() = (address)(this+1)`：字节码紧跟 ConstMethod 头，一次分配零指针
- 三个入口 + `_code` 的缓存公式：
  - `_from_interpreted_entry = _code ? i2c : _i2i_entry`
  - `_from_compiled_entry = _code ? nmethod VEP : c2i`
- `link_method` 初始化：设 `_i2i_entry` 和 `_from_interpreted_entry`，造 adapter
- `set_code` 的写顺序：`_code` → storestore → `_from_compiled_entry` → storestore → `_from_interpreted_entry`
  - 为什么不能反序：interpreter → i2c → _from_compiled_entry 如果还是旧的 c2i → 回环
- `clear_code` 的反序：先恢复入口，最后置 `_code = NULL`
- deopt 只在 safepoint 下发生，`_code` 的 NULL → non-NULL 随时可发生

### 第七节：计数器与画像——JIT 什么时候介入，凭什么

目标约 1200 字。

- MethodCounters 懒分配：冷方法零开销
- `_invocation_counter` / `_backedge_counter`
- 回边计数 → OSR：循环执行到一半换帧
- MethodData (MDO)：画像不是猜测，是证据
  - 分支概率、receiver 类型 → C2 投机内联 + CHA
  - 猜错 → deopt 兜底
- 计数决定何时编译，画像决定怎么编译

### 第八节：收网与误解澄清

目标约 1000 字。

总图回顾 + 至少 5 个误解澄清：

1. cpCache 条目不是普通哈希缓存，是按 CP 编号一一对应的定长数组
2. `_f2` 不是一个"多用途变量"，是按字节码类型在解析时固化的语义槽
3. Method 的入口切换不是"重新编译方法"，是替换入口指针
4. ConstMethod 和 Method 分开不是为了面向对象设计，是为了 CDS 只读共享
5. invokedynamic 的解析不经过 LinkResolver 的 invokevirtual 路径，走 bootstrap method
6. bytecode rewriting 不是必要机制，是锦上添花的优化

## 5. 失败方案必须写进正文

1. 每次执行都重新解析（代价不可接受）
2. 解析结果存回 CP 条日本体（tag 冲突，无法区分 get/put 同一字段）
3. 每种字节码一个独立缓存结构（解释器要先判断结构类型，条目翻倍）

## 6. 证据清单

- `constantPool.hpp:98-130`：ConstantPool 类布局
- `constantPool.cpp:447-517`：`klass_at_impl` 解析流程
- `constantPool.cpp:510-515`：release_store + release_tag_at_put 发布顺序
- `constantTag.hpp:34-48`：tag 编码（含 HotSpot 专用 tag）
- `cpCache.hpp:46-57`：ASCII 布局图
- `cpCache.hpp:139-142`：四个 volatile 字段声明
- `cpCache.hpp:176-196`：_flags 位域定义
- `cpCache.hpp:198-206`：_indices 位域定义
- `cpCache.hpp:312-327`：bytecode_number 映射
- `cpCache.cpp:51-57`：initialize_entry
- `cpCache.cpp:92-126`：set_bytecode 的 release_store 和顺序注释
- `cpCache.cpp:127-147`：set_field
- `cpCache.cpp:167-309`：set_direct_or_vtable_call
- `cpCache.cpp:325-339`：set_itable_call
- `cpCache.cpp:350-461`：set_method_handle_common
- `cpCache.cpp:113-116`：release_set_f1
- `cpCache.inline.hpp:32,56,78`：acquire-load 读者
- `templateTable_x86.cpp:2721-2749`：resolve_cache_and_index 快路径
- `templateTable_x86.cpp:2781-2817`：load_invoke_cp_cache_entry
- `templateTable_x86.cpp:3612-3697`：prepare_invoke
- `templateTable_x86.cpp:3699-3743`：invokevirtual_helper
- `templateTable_x86.cpp:2860-3006`：getfield 快路径
- `bytecodeInterpreter.cpp:2656-2693`：C++ 解释器 invokevirtual 快路径
- `linkResolver.cpp:723-793`：resolve_method
- `linkResolver.cpp:333-384`：lookup_method_in_klasses
- `linkResolver.cpp:1344-1409`：runtime_resolve_virtual_method
- `interpreterRuntime.cpp:833-928`：resolve_invoke 胶水层
- `interpreterRuntime.cpp:668-738`：resolve_get_put
- `method.hpp:70-113`：Method 类声明和入口字段
- `method.hpp:511-520`：set_interpreter_entry
- `method.cpp:1075-1124`：link_method
- `method.cpp:1195-1220`：set_code
- `method.cpp:961-975`：clear_code
- `constMethod.hpp:31-87`：ConstMethod 布局注释
- `constMethod.hpp:490`：code_base = this+1
- `constMethod.hpp:376-377`：is_read_only_by_default (CDS)
- `methodCounters.hpp:51-52`：两个计数器
- `methodCounters.hpp:74-113`：构造函数和阈值计算
- `methodData.hpp`：MDO 类定义
- `method.cpp:419-450`：build_interpreter_method_data (MDO 懒分配)

## 7. 必须明确的边界

- 基于 JDK 11u 的模板解释器 (x86) 和 C++ 解释器
- cpCache 条目布局和位域定义是 JDK 11u 特有的，不同版本可能调整
- 阈值 1500/10000 是分层编译下 x86 的默认值
- bytecode rewriting 是模板解释器特有优化，C++ 解释器没有
- invokedynamic / invokehandle 走 JSR-292 特殊路径，不展开 bootstrap method 语义
- Method/ConstMethod 分离与 CDS 密切相关，只讲对象模型动机，不展开 CDS dump 流程
- MethodData 的完整 profiling 策略属于 JIT 域，本篇只讲它和计数器的分工边界

## 8. 完成后 review

- 删除代码后能否复述"编号 → 解析 → 固化 → 多义条目 → 快路径一次读"的完整链条
- 是否解释了 `_f2` 为什么可以同时是 vtable index 和 Method*
- 是否解释了 Method 入口切换的写顺序为什么不能反
- 是否把 cpCache 多义设计和 mark word 多义设计建立了联系（同一设计哲学）
- 是否通过删码测试、禁用词、file:line 和边界检查
