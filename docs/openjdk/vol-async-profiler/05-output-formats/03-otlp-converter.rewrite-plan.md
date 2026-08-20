# 03-otlp-converter 重写规划

> 状态：现稿待回炉；本文件先做理解路径设计，不直接改正文
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 目标：把当前“OTLP/protobuf/converter 说明文”重写成一篇围绕“同一份 `CallTraceSample` 为什么不能再继续用 flamegraph/JFR 的表示，而必须被重组成 OTLP Profiles 的 dictionary + sample 关系；以及为什么仓库里还要同时保留 native 直出与 JFR→OTLP 离线转换两条链”的机制文章

## 1. 读者困惑

- flamegraph 已经能给人看，JFR 已经能给 reader 读，为什么还要再导出 OTLP？
- 为什么 OTLP 不能直接上传 collapsed 栈文本，或者简单复用 JFR 作为唯一中间格式？
- native 直出 OTLP 时，为什么不是先写 sample，而是先写 dictionary？
- `stack_table`、`function_table`、`location_table`、`attribute_table`、`string_table` 分别在补哪一层重复与关系？
- 当前 `mapping_table`、`link_table`、`attribute_table` 为什么会出现 dummy/最小实现，意味着什么边界？
- 仓库里既有 native `otlp.cpp`，又有 `JfrToOtlp.java`，它们到底是互补还是重复？

## 2. 一句话顿悟

**async-profiler 把 OTLP 看成一种“机器消费的 profile 协议”，而不是另一种展示格式：native 路径直接从 `CallTraceSample` 先建立 dictionary（stack/function/location/string/attribute universe），再让 sample body 只引用索引和值；需要离线或跨机器工作流时，再由 `JfrToOtlp.java` 从 JFR 走第二条转换链。**

## 3. 总图

```text
直接导出路径
  CallTraceStorage.collectSamples()
    → FrameName
      → Otlp::Recorder.recordStacks()
        → dictionary: stack/function/location/attribute/string
          → _samples_info
            → recordOtlpProfile()
              → ProtoBuffer
                → Writer

离线转换路径
  JFR file
    → JfrReader / JfrToOtlp.java
      → 从 JFR 事件重建 profile model
        → OTLP protobuf
```

## 4. 版本与边界

- 本篇聚焦当前 async-profiler 的 OTLP Profiles 风格 protobuf 输出，不把它写成 OTLP 全量规范实现总论。
- native `dumpOtlp()` 直接消费 `CallTraceStorage`，不是先生成 JFR 再回读。
- `ProtoBuffer` 是当前所需 protobuf wire-format 子集的手写编码器，不是通用 protobuf runtime，也没有 `.proto` 代码生成。
- `otlp.h` 中的字段编号常量是协议的一部分，不是可随便重排的“内部枚举”。
- 当前 `mapping_table`、`link_table`、`attribute_table` 明确是最小兼容实现；不能夸写成完整 mapping/link/resource/exporter。
- 当前 `recordStacks()` 以函数名索引承担 location 语义，没有像 JFR 那样在 writer 阶段恢复 line/bci/type 的完整细粒度元数据。
- `recordStacks()` 过滤的是 `cts->samples == 0`，不是最终被选中的 `counter == 0`；因此切换 total/counter 后，0 值 counter 样本并不会自动从 dictionary 中消失。
- `JfrToOtlp.java` 是独立的离线路径，不是 native `otlp.cpp` 的包装层。

## 5. 现稿方法论差距审计

- 现稿事实覆盖已较完整，但主冲突还可以更集中：为什么 OTLP 不能继续沿用 flamegraph 的可视化前缀树，也不能继续沿用 JFR 的 chunk+cpool 语义，而必须重组为 dictionary + sample indirection。
- `ProtoBuffer`、`otlp.h`、dictionary、sample body、converter 现在更像并列说明块，还需要压成“机器消费协议”一条主线。
- 当前字典里的 dummy mapping / zero link / thread-only attributes 已经写到，但还可以更硬地强调这是“最小兼容字典”，不是完整 OTel resource/mapping 建模。
- `recordStacks()` 两阶段设计写到了 `_samples_info`，但“为什么不能第一次遍历 trace 时就把 sample body 顺手写完”这个失败方案还可以更厚。
- direct OTLP 与 JFR→OTLP converter 的区别已覆盖，但还可以更明确地区分“共享目标协议，不共享中间表示”。
- 测试里的外部压力还没被充分拉进正文，例如 `test/test/otlp/OtlpTests.java` 明确在校验 sample_type、period_type、thread.name、collapsed 可逆性和 JFR→OTLP 对照，这些都能帮助文章从抽象格式回到真实消费者要求。

## 6. 重写策略

1. 用“火焰图是给人看的，JFR 是给 JFR reader 看的，平台要的是另一种机器协议”开场。
2. 推演并否定至少四个直觉：
   - 直接上传 collapsed 栈文本；
   - 总是先生成 JFR 再转 OTLP；
   - 每条 sample 都把完整字符串和函数名原样写进去；
   - native `otlp.cpp` 与 `JfrToOtlp.java` 只是同一实现的在线/离线包装。
3. 给出总图：native 直出 = dictionary first + sample indirection；离线转换 = JFR 重建后再编码 OTLP。
4. 分层讲：
   - `dumpOtlp()` 为什么仍从 `Profiler::dump()` 和 `CallTraceStorage` 直接进入；
   - `ProtoBuffer` 与 `Writer` 如何分离“写到哪里”和“按什么 wire format 写”；
   - `otlp.h` 字段号为什么就是当前协议字典；
   - `recordProfilesDictionary()` 为什么先建 stack/function/location/string/attribute universe；
   - `recordStacks()` 怎样拆线程帧、函数索引和 `_samples_info`；
   - `recordOtlpProfile()` 怎样决定 sample_type、period_type、values；
   - `JfrToOtlp.java` 为什么仍然需要存在，以及它与 native path 的物理分工。
5. 收网时强调：OTLP 不是 flamegraph/JFR 的“另一张皮”，而是另一类消费者要求下的协议重排。

## 7. 结构大纲

### 第一节：事故开场——为什么给平台吃的数据，不能继续沿用 flamegraph/JFR 的表示

回答：人类视图、JFR reader 和 OTel 平台需要的不是同一类中间表示。

预估字数：900-1200

### 第二节：先排除四个错误直觉——上传 collapsed、统一先走 JFR、每条 sample 写全字符串、native 与 converter 只是包装关系

预估字数：1700-2300

### 第三节：第一层——`dumpOtlp()` 为什么仍然直接从 `CallTraceStorage` 起步

证据：`src/profiler.cpp:1439-1445`、`src/api/one/profiler/AsyncProfiler.java:241-252`。

回答：OTLP 仍然是 dump 分派格式，返回 `byte[]`，强调“机器读的二进制载荷”定位。

### 第四节：第二层——`ProtoBuffer` 与 `otlp.h` 如何共同组成手写 protobuf 协议

证据：`src/protobuf.h:12-57`、`src/otlp.h:20-145`。

回答：Writer vs wire-format 的职责分离，字段号常量为什么就是协议字典。

### 第五节：第三层——为什么 native OTLP 要先写 dictionary，而不是先写 sample body

证据：`src/otlp.cpp:11-70`。

回答：stack/function/location/attribute/string 的对象池角色，dummy mapping/zero link/thread-only attributes 的边界。

### 第六节：第四层——`recordStacks()` 怎样把 trace 变成 stack/location/function universe 与 `_samples_info`

证据：`src/otlp.cpp:72-99`。

回答：线程帧分流、函数名索引承担 location 语义、两阶段构造 sample body 的理由，以及 `samples == 0` 过滤边界。

### 第七节：第五层——`recordOtlpProfile()` 怎样决定 sample_type、period_type、period 和 values

证据：`src/otlp.cpp:102-145`、`src/otlp.h:99-145`。

回答：sample value 单位 vs 采样周期语义的区分，为什么 sample body 只引用 stack/attribute 索引和值。

### 第八节：第六层——为什么仓库里还要保留 `JfrToOtlp.java`

证据：`test/test/otlp/OtlpTests.java:53-167`，必要时补 converter 源码。

回答：在线直出与离线转换的部署差异，二者共享目标协议但不共享中间表示。

### 第九节：收网——OTLP 真正做的是“把采样重排成平台能索引的 profile 协议”

桥接 AP-6：Java API 如何把 `dumpOtlp()` / `execute1()` 暴露出去。

## 8. 必须展开的失败方案

1. collapsed 文本已经够通用，直接上传字符串栈就行。
2. OTLP 没必要 native 直出，所有场景统一先生成 JFR 再离线转。
3. 每条 sample 直接写完整函数名/线程名/栈字符串，最直观也最简单。
4. dummy mapping / zero link / thread-only attributes 说明实现已经完整覆盖 OTLP 语义。
5. `recordStacks()` 第一次遍历 trace 时顺手把 sample body 写完就够，不必多维护 `_samples_info`。
6. `JfrToOtlp.java` 和 `otlp.cpp` 只是同一套 writer 的两层包装。

## 9. 证据清单

- `src/profiler.cpp:1439-1445`
- `src/api/one/profiler/AsyncProfiler.java:241-252`
- `src/protobuf.h:12-57`
- `src/otlp.h:20-145`
- `src/otlp.cpp:11-145`
- `test/test/otlp/OtlpTests.java:23-235`
- 必要时补 `converter/one/convert/JfrToOtlp.java` 作为离线路径边界证据

## 10. 完成后检查

1. 删除代码块后，读者仍能复述“dictionary first → sample indirection → native 直出 / JFR 离线转换双路径”。
2. 至少展开 4 个失败方案，而不是把 protobuf 字段和表结构平铺成清单。
3. 明确区分 Writer、ProtoBuffer、`otlp.h` 字段号三层职责。
4. 明确区分 function/location/stack/attribute/string 表分别承担的关系。
5. 不把 dummy mapping / zero link / thread-only attributes 写成完整 OTel exporter 语义。
6. 明确区分 native OTLP 直出与 `JfrToOtlp.java` 离线路径。
7. 每个 `file:line` 重新核对，链接、结构标记和禁用词通过。
