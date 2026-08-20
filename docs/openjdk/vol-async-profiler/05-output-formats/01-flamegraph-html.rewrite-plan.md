# 01-flamegraph-html 重写规划

> 状态：现稿待回炉；本文件先做理解路径设计，不直接改正文
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 目标：把当前“FlameGraph/模板/JavaScript 输出说明文”重写成一篇围绕“采样结果为什么不能直接吐成一堆 HTML 节点，而必须先在 native 侧聚合成 Trie、压成常量池和帧指令，再交给浏览器做 Canvas/tree 交互”的机制文章

## 1. 读者困惑

- `CallTraceStorage` 里已经有调用栈和计数了，为什么还不能直接输出一张火焰图？
- 为什么 flamegraph/tree 输出不是“每条调用栈一行 div”，而是 native 先构一棵 Trie？
- `minwidth`、`reverse`、`inverted`、tree view 分别改变的到底是哪一层？
- `FrameName` 为什么在输出期还要再参与一次，不能直接拿 `CallTrace` 里的帧身份？
- `f/u/n` 这三种指令压缩的是什么，浏览器又是怎么把它还原成可点击图的？
- tree view 为什么不是另一套采样结果，而只是同一份数据的第二种浏览器视图？

## 2. 一句话顿悟

**async-profiler 不会把原始采样栈直接倾倒给浏览器；它先在 native 侧把 `CallTrace` 经过命名、过滤和前缀聚合，压成“名字常量池 + 可推导坐标的帧指令流”，再把这份紧凑数据注入编译期嵌入的 HTML 模板，由浏览器负责解码、绘制和交互。**

## 3. 总图

```text
CallTraceStorage
  → collectSamples()
    → FrameName.name/type/excludeTrace
      → FlameGraph::addChild()
        → Trie：前缀聚合 + total/self/type counters
          → minwidth cutoff
            → printCpool()
            → printFrame() → f/u/n stream
              → INCBIN flame.html
                → JS unpack + levels[]
                  → Canvas render / search / zoom / tree view
```

## 4. 版本与边界

- 本篇聚焦当前 async-profiler 的 `OUTPUT_FLAMEGRAPH` / `OUTPUT_TREE` 路径，不泛化为所有 profiler 的通用做法。
- `OUTPUT_COLLAPSED` 是文本中间格式，不与 flamegraph/tree 混写成同一输出层。
- `tree` 不是另一套采样算法；`OUTPUT_TREE` 只是把同一 HTML 模板的初始 `treeview` 开关置为 true。
- `minwidth` 是输出阶段 cutoff，不回写采样阶段，也不修改 `CallTraceStorage` 里的样本计数。
- `reverse` 改变加入 Trie 的栈顺序；`inverted` 改变模板的初始绘制方向；两者不能都写成“翻转图”。
- 默认显示面是 Canvas；只有切到 tree view 时，浏览器才根据同一份 `levels` 数据构造 DOM 树。
- FlameGraph 的 Trie 是输出期前缀聚合，不是 `CallTraceStorage` 的去重表，也不是浏览器 tree DOM。

## 5. 现稿方法论差距审计

- 现稿事实覆盖已较完整，但开场仍偏“实现说明”，对“为什么不能直接输出 HTML/原始栈”的主困惑厚度还不够。
- `FrameName`、Trie、`cpool`、`f/u/n`、模板、Canvas/tree view 目前更像按实现层串起来的说明链，还需要压成“native 预聚合 vs 浏览器只展示”的单一主线。
- `reverse` 与 `inverted` 虽已区分，但还可以更明确地放进失败方案：调用路径方向和视觉朝向不是一回事。
- 需要更硬地打掉“三棵树混淆”：`CallTraceStorage` 去重结构、FlameGraph Trie、浏览器 tree view DOM。
- `minwidth` 的边界已写到，但还可以更明显地作为“输出可读性过滤器，而非采样器热度判断”来收束。
- 模板部分目前有点偏替换占位符清单，需要回到“为什么要编译期嵌入、为什么不是运行时读模板/起模板引擎”。

## 6. 重写策略

1. 用“采样已经结束，为什么还离可点击 HTML 很远”开场。
2. 推演并否定至少四个直觉：
   - 每条调用栈直接吐 HTML 节点；
   - 把原始帧名和地址全部交给浏览器现场聚合；
   - tree view 是另一套输出算法；
   - `minwidth`/`inverted`/`reverse` 都只是图形翻转或样本过滤。
3. 给出总图：命名过滤 → native 前缀聚合 → 输出压缩编码 → 模板注入 → 浏览器渲染交互。
4. 分层讲：
   - `dumpFlameGraph()` 为什么是 flamegraph/tree 的共同入口；
   - `FrameName` 为什么是输出前必须补的一层身份恢复；
   - `FlameGraph::addChild()` 怎样把路径宽度变成 Trie 的 `_total/_self`；
   - `minwidth` 怎样在输出期做 cutoff；
   - `printCpool()` 与 `printFrame()` 分别在压缩什么；
   - `INCBIN` + `flame.html` 怎样变成单文件 HTML；
   - 浏览器如何基于 `levels` 完成 Canvas、搜索、缩放与 tree view。
5. 收网时强调：这篇讲的是“可视化输出协议”，不是采样主链，也不是 JFR/OTLP 的序列化模型。

## 7. 结构大纲

### 第一节：事故开场——为什么采样结果还不能直接变成一张图

回答：`CallTrace` 不是浏览器可直接消费的布局结果；名字、深度、横坐标、宽度、颜色语义都还没定下来。

预估字数：900-1200

### 第二节：先排除四个错误直觉——直接吐 HTML、全交给浏览器聚合、tree 是另一套结果、翻转和过滤都只是视觉小开关

预估字数：1600-2200

### 第三节：第一层——`dumpFlameGraph()` 为什么把 flamegraph 与 tree 收到同一 native 入口

证据：`src/profiler.cpp:1280-1347`、`src/arguments.cpp:87-94`、`src/arguments.h:72-80`。

回答：输出格式分派、标题/单位决定、`OUTPUT_TREE` 只是初始视图开关。

### 第四节：第二层——`FrameName` 为什么是输出前最后一次身份恢复

证据：`src/profiler.cpp:1297-1338`。

回答：命名、类型、include/exclude 过滤、`STYLE_ANNOTATE` 关闭，以及为什么不能直接拿原始帧身份做显示键。

### 第五节：第三层——Trie 怎样把多条栈变成“宽度可累计的图形路径”

证据：`src/flameGraph.h:17-67`、`src/flameGraph.cpp:82-107`。

回答：同父节点下的 name/type key、`_total/_self`、inlined/C1/interpreted 计数、输出期 Trie 与存储期去重的区别。

### 第六节：第四层——`minwidth` 为什么只在输出阶段裁掉“不值得画”的节点

证据：`src/flameGraph.cpp:109-146`、`src/flameGraph.cpp:149-197`、`src/arguments.cpp:392-403`、`src/arguments.h:219-285`。

回答：`_mintotal` 的计算、`depth()` 标记、`printFrame()` 二次检查，以及“裁图不裁样本”的边界。

### 第七节：第五层——`printCpool()` 与 `printFrame()` 分别在压缩什么

证据：`src/flameGraph.cpp:149-225`、`src/res/flame.html:160-175`、`src/res/flame.html:400-404`。

回答：名字常量池前缀压缩、`f/u/n` 坐标推导压缩、类型编码与浏览器还原。

### 第八节：第六层——模板为什么要编译进二进制，而不是运行时再找资源文件

证据：`src/flameGraph.cpp:14-18`、`src/flameGraph.cpp:109-146`、`src/incbin.h`。

回答：`INCBIN` 的打包意义、占位符替换而非模板引擎、单文件交付事实与重新构建代价。

### 第九节：第七层——浏览器端到底负责什么：Canvas、搜索、缩放和 tree view

证据：`src/res/flame.html:124-175`、`src/res/flame.html:228-306`、`src/res/flame.html:308-387`、`src/res/flame.html:406-532`。

回答：`levels[]`、`render()`、`buildTree()`、搜索高亮、点击缩放、removeStack，以及 tree view 与 Canvas 的职责边界。

### 第十节：收网——async-profiler 实际上定义了一套“火焰图页面输入协议”

桥接下一篇 JFR：为什么另一种输出消费者不会复用这套 Trie/HTML 协议。

## 8. 必须展开的失败方案

1. `CallTraceStorage` 里已经有调用栈，直接一条栈生成一组 HTML 节点就够了。
2. 浏览器足够强，可以让 JavaScript 现场做所有去重、布局和颜色判断。
3. `OUTPUT_TREE` 代表另一种采样/聚合逻辑。
4. `minwidth` 会在采样期丢弃低频样本。
5. `reverse` 和 `inverted` 都只是把成品图片上下翻过来。
6. FlameGraph Trie、存储层去重结构、浏览器 tree view DOM 是同一棵树的三个名字。

## 9. 证据清单

- `src/profiler.cpp:1280-1347`
- `src/arguments.cpp:87-94`
- `src/arguments.cpp:392-403`
- `src/arguments.h:72-80`
- `src/arguments.h:219-285`
- `src/flameGraph.h:17-119`
- `src/flameGraph.cpp:14-18`
- `src/flameGraph.cpp:82-231`
- `src/res/flame.html:31-32`
- `src/res/flame.html:60-68`
- `src/res/flame.html:114-175`
- `src/res/flame.html:228-306`
- `src/res/flame.html:308-404`
- `src/res/flame.html:406-532`
- 必要时补 `src/incbin.h` 作为资源嵌入边界

## 10. 完成后检查

1. 删除代码块后，读者仍能复述“命名过滤 → Trie 聚合 → cpool/frame stream → 模板注入 → 浏览器渲染”。
2. 至少展开 4 个失败方案，而不是只罗列实现步骤。
3. 明确区分存储层去重、输出层 Trie、浏览器 tree DOM 三种结构。
4. 明确区分 `reverse`、`inverted`、`treeview`、`minwidth` 分别作用在哪一层。
5. 不把模板占位符清单写成无主线的实现目录。
6. 不把这篇写成 JFR/OTLP 输出总论；聚焦 flamegraph/tree HTML 路径。
7. 每个 `file:line` 重新核对，链接、结构标记和禁用词通过。
