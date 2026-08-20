# 01. 采样数据怎样变成一张 HTML？——FlameGraph、压缩帧流与浏览器交互

> **前置依赖**：[AP-4 —— 调用栈存储与去重](../04-stack-symbols/04-storage-alloc.md)、[FrameName —— Java 方法与类型后缀](../04-stack-symbols/03-frame-naming.md)
> → **后续**：AP-5 的 JFR recorder 与 OTLP converter
>
> 场景：采样已经变成 `CallTrace`，但用户还需要一张可搜索、可缩放、可切换 tree view 的 HTML 火焰图。
>
> 本篇基于当前 async-profiler 源码，重点讨论 flamegraph/tree 输出路径。它不是 JVM 标准格式，也不是把采样结果写成一棵 HTML `div` 树：当前实现由 native 侧生成一段嵌入模板的 HTML，模板中的 JavaScript 在浏览器里把压缩帧流绘制到 Canvas；切换 tree view 时，才按同一份帧数据构造 DOM 树。以下结论是当前实现事实，不外推为所有版本或所有输出格式的共同实现。

## 先把真正的困惑摆出来：为什么采样已经结束，HTML 还远没生成完

AP-4 结束时，async-profiler 手里已经有了两块看上去很像“足够生成火焰图”的材料。第一块是 `CallTraceStorage`：它保存了去重后的 `CallTrace`，也保存了每条 trace 对应的样本数或累计计数器。第二块是 `FrameName`：它已经知道怎么把 `jmethodID`、native 地址和特殊 `BCI_*` 帧变成人类能读懂的名称（`src/profiler.cpp:1297-1307`）。

很多人到这里会自然地产生一个直觉：既然“栈”和“名字”都齐了，那不就是把每条调用栈按深度画成一排矩形，再导出成 HTML 吗？但真正的问题恰恰在这里。浏览器并不认识 `ASGCT_CallFrame`，也不理解“哪几条栈其实共享一段公共前缀”，更不知道某个矩形在横轴上该从哪里开始、该占多宽、该染成什么颜色、被点击后又该把哪一段视为新的根。

换句话说，采样结束只意味着“原始证据齐了”，并不意味着“浏览器需要的布局输入已经齐了”。浏览器真正需要的是另一种东西：稳定的人类可读名字、已经累计好的宽度、可以推导坐标的顺序，以及一套足够紧凑的数据表示，好让一个 HTML 文件既能被保存到磁盘，又能被浏览器瞬间打开，而不是先在客户端重跑一遍分析器。

这就是 flamegraph 输出路径真正要解决的困惑：async-profiler 到底怎样把“分析器内部的调用栈样本”，变成“浏览器可直接消费的页面输入协议”。

先把几个最容易冒出来的朴素方案摆出来：

第一种方案，是每条采样栈直接吐成一组 HTML 节点。这样看起来最直观，但会立刻遇到两个问题。其一，大量重复前缀会被反复输出，结果文件体积会非常快地膨胀。其二，缩放、搜索、tree view 都需要一个稳定的坐标模型；如果输出只是“很多孤立的 div”，浏览器还得自己再把它们重新组织成树和横向布局。

第二种方案，是 native 侧只负责把原始帧名和计数吐出来，让 JavaScript 在页面加载时自己做去重、前缀合并、坐标计算和颜色归类。这会把本来已经在 native 侧知道的结构信息，重新延后到浏览器里再算一遍。结果不仅页面初始化更重，HTML 结果也会依赖一套更复杂的客户端算法，保存下来的就不再是“最终展示输入”，而更像“半成品原料”。

第三种方案，是把 flamegraph 和 tree 当成两种完全不同的输出算法：前者生成画图数据，后者生成一棵 DOM 树。这个直觉也很容易出现，因为用户看到的界面确实有两种完全不同的显示形态。但如果真这么做，native 侧就得维护两套聚合逻辑、两套输出格式、两套边界判断；同一份采样结果也更容易在两种视图下出现解释漂移。

第四种误解，是把 `minwidth`、`reverse`、`inverted` 都当成“出图时随便翻一下或裁一下”的小参数。事实上，这几个开关作用的层次完全不同：有的改变进入 Trie 的调用路径顺序，有的只改变浏览器默认朝向，有的只在输出阶段做可读性裁枝。如果把它们混在一起，后面就会把“数据组织方向”和“页面显示方向”误当成一件事。

async-profiler 的真实做法，是把这些问题拆成两层：native 侧先把原始采样栈整理成稳定、紧凑、已经聚合过的页面输入；浏览器再基于这份输入做绘制和交互。

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

*关键设计（斜体）：* *native 侧负责把调用栈整理成稳定、紧凑、可遍历的输入；浏览器只负责展示和交互，不再重新理解原始 `ASGCT_CallFrame`。*[模式: native 预聚合 + 压缩序列化 + 模板化客户端]

到这里先记住本文最重要的一句话：async-profiler 输出的并不是“一张现成的图”，而是一份已经足够接近最终图形的数据协议。后面所有实现细节，本质上都是在服务这个目标。

## 第一层：为什么 flamegraph 与 tree 要先共用一条 native 输出入口

真正的输出分派发生在 `Profiler::dump()`。这里先按 `Arguments::_output` 判断用户想要什么格式：`OUTPUT_COLLAPSED` 走 `dumpCollapsed()`，而 `OUTPUT_FLAMEGRAPH` 与 `OUTPUT_TREE` 都走 `dumpFlameGraph()`（`src/profiler.cpp:1176-1183`）。`collapsed` 在这里是一个很重要的对照物，因为它说明 async-profiler 明确把“文本中间格式”和“HTML 可视化输出”分成了两条线。

```text
Arguments::_output
  ├─ OUTPUT_COLLAPSED → dumpCollapsed → frame;frame count
  └─ OUTPUT_FLAMEGRAPH / OUTPUT_TREE → dumpFlameGraph → FlameGraph → HTML
```

`OUTPUT_FLAMEGRAPH` 和 `OUTPUT_TREE` 对应的枚举来自 `src/arguments.h:72-80`，命令行字符串则在 `src/arguments.cpp:87-94` 解析。这个分派表面上看只是枚举选择，真正值得注意的地方在于：tree 没有拥有自己的 dump 函数，而是被有意塞回同一个 `dumpFlameGraph()`。

这背后其实是在主动拒绝一个看似合理、实际上会制造复杂度的方案：不要因为用户界面有两种显示方式，就在 native 侧维护两套不同的数据管线。如果 flamegraph 和 tree 真从 native 阶段就分叉，那么 `FrameName` 的命名、trace 的过滤、宽度的累计、`minwidth` 的裁枝、类型统计的归并，都要各做一遍。更糟的是，两种输出最后很容易出现“同一份采样数据，两边宽度不一致、层级不一致、边界不一致”的问题。

async-profiler 选择的是更硬的约束：先认定 flamegraph 和 tree 在数据层其实是同一件事——它们都需要一棵已经做过前缀聚合的调用关系结构，只是浏览器端的呈现方式不同。于是 `dumpFlameGraph()` 先统一做标题、单位、布局方向和初始视图的准备，再交给同一个 `FlameGraph` 对象处理（`src/profiler.cpp:1280-1295`）。

这里的参数各自扮演不同角色。标题和单位决定页面头部以及 hover 信息里展示的解释文字；`minwidth` 决定哪些聚合后的细枝末节值得进入最终页面；`reverse` 决定 trace 进入 Trie 时的方向；`inverted` 则只决定浏览器默认是把根放在上面还是下面；`args._output == OUTPUT_TREE` 只是把模板里的 `treeview` 初始开关置为 true（`src/flameGraph.cpp:122-128`、`src/res/flame.html:114-115`）。

如果把这些参数混成一句“它们都影响火焰图样式”，读者会很容易丢掉主线。更准确的说法是：`dumpFlameGraph()` 一边在准备数据的解释元信息，一边也在把“哪些变化属于数据层，哪些变化只属于显示层”提前分开。

到这里先记住一个边界：`dumpFlameGraph()` 不重新采样，也不直接把每条栈写成 HTML 元素。它读的是已经存在的 `CallTraceStorage`，做的是“输出期重组”。这个边界必须守住，因为如果把这一步误读成“又做了一轮采样”，后面关于 Trie、`minwidth` 和 frame stream 的解释都会滑掉。

## 第二层：为什么 `FrameName` 必须在输出前再出场一次

既然 `CallTraceStorage` 已经保存了 trace，为什么输出前还要再创建一个 `FrameName`？原因是：`CallTrace` 保存的是分析器内部可识别的帧身份，但火焰图需要的是浏览器可直接显示、可归类、可过滤的帧语义。这两者不是一回事。

在 `dumpFlameGraph()` 里，代码先创建 `FrameName fn(args, args._style & ~STYLE_ANNOTATE, _epoch, _thread_names_lock, _thread_names)`，然后收集 `CallTraceSample*`，遍历每一条 trace，依次调用 `fn.excludeTrace(trace)`、`fn.name(trace->frames[j])` 和 `fn.type(trace->frames[j])`（`src/profiler.cpp:1297-1338`）。这一步至少解决了三件事。

第一，它把原始帧身份恢复成最终显示名称。Java 方法、native 符号、线程帧、CPU 帧、错误帧，看起来都叫“一个 frame”，但它们背后的身份来源不同。火焰图页面显然不能显示一堆 `jmethodID` 和地址值，它需要的是最终的人类可读标题。

第二，它给每个帧补上类型语义。浏览器后面要根据类型决定颜色、legend 和 hover 细节。如果这里不先做 `FrameTypeId` 的分类，浏览器就无法区分 compiled、C1、inlined、interpreted、native、kernel 这些世界。

第三，它把 include/exclude 过滤放在进入 Trie 之前完成。`fn.excludeTrace(trace)` 过滤的是整条调用栈，而不是已经聚合好之后再从树上抠节点。这一点很重要，因为一旦先聚合再过滤，祖先的累计宽度就已经被污染，后面即使删掉某些节点，宽度语义也不再干净。

这一步还藏着一个容易被忽略的小边界：`FrameName` 在这里刻意关闭了 `STYLE_ANNOTATE`。也就是说，输出到 flamegraph 时，名字里的类型后缀不应该再继续承担分类职责。分类信息改由独立的 `FrameTypeId` 托管，名字则尽量保持稳定的显示身份（`src/profiler.cpp:1298`）。`FlameGraph::addChild()` 里也会再次检查名字末尾形如 `_[x]` 的后缀，并在放入字符串池前裁掉这四个字符（`src/flameGraph.cpp:82-106`）。

这背后其实是在避免另一个朴素但会出错的方案：不要把“显示名字”和“类型编码”硬绑成一根字符串。如果字符串既负责显示，又负责归类，又负责颜色，那后面只要样式策略一变，整棵输出树的 key 就会跟着漂。async-profiler 选择的是把“人类读到什么”和“页面如何分类”拆开处理。

所以这里的 `FrameName` 不是多余的一层包装，而是输出协议真正成立前的最后一道身份恢复。它保证 FlameGraph 看到的不再是“采样器内部帧”，而是“输出层可用帧”。

## 第三层：为什么必须先在 native 侧做一棵 Trie，而不是一条栈写一排节点

当 `FrameName` 已经能给出名字和类型之后，下一个问题就是：这些帧到底该怎样组织，才能让横向宽度真正代表累计代价？答案就是 `FlameGraph::addChild()` 构造的 Trie。

`Trie` 节点本身很简单：它保存 `_children`、`_total`、`_self`，以及 `_inlined`、`_c1_compiled`、`_interpreted` 这几类 Java 执行状态统计（`src/flameGraph.h:17-24`）。真正的关键不在于字段多不多，而在于这棵树在表达什么：它表达的不是“采样器保存了哪些原始栈”，而是“哪些 trace 在显示层共享同一个前缀路径”。

`child()` 用 `name_index | type << 28` 作为 key（`src/flameGraph.h:45-55`）。这意味着同一个父节点下，名字相同但类型不同的帧，理论上可以成为不同的子节点；名字不同的帧当然也会分叉。这一点很重要，因为 flamegraph 最终画的不是“一个方法名单”，而是一条条调用路径。路径身份必须至少由“父节点 + 当前名称 + 当前类型”共同决定。

```text
Trie 节点 key = [高 4 位：FrameTypeId][低 28 位：name index]

root
 ├─ (Service, compiled)
 │    └─ (handle, inlined)
 └─ (Service, interpreted)
      └─ (handle, interpreted)
```

但这里还有一层更微妙的权衡。`addChild()` 遇到 `FRAME_INLINED`、`FRAME_C1_COMPILED`、`FRAME_INTERPRETED` 时，并不会机械地为每一种 Java 状态都创建完全不同的树路径，而是先把这些情况都挂到 `FRAME_JIT_COMPILED` 这条逻辑路径上，再分别增加 `_inlined`、`_c1_compiled`、`_interpreted` 计数（`src/flameGraph.cpp:94-105`）。

这背后其实是在拒绝另一个过度忠实于原始状态、却会伤害读图体验的方案：不要让同一个方法因为执行形态稍有变化，就在图上裂成一堆互不相连的小块。async-profiler 更关心的是“这是不是同一条逻辑调用路径”，而不是“是否必须为每种 Java 执行状态单独占一块路径身份”。类型差异会被保留，但优先被保留在统计和颜色层，而不是优先撕裂路径结构。

### 输出期 Trie 与存储期去重不是一回事

这里最容易混淆的，是 AP-4 的 `CallTraceStorage` 与 flamegraph 的 Trie。它们都在做某种“合并”，但合并的对象完全不同。

AP-4 的存储层，是按完整 trace 的身份做去重。也就是说，如果两次样本拥有同一条完整调用栈，它们可以复用一份 `CallTrace` 存储，并把样本数或计数器累到这份身份上。

而 flamegraph 这一层，不关心“完整 trace 身份是否相同”，而关心“不同 trace 在显示路径上是否共享同一个前缀”。因此它的输入是很多条已经存在的 trace，输出则是一棵把公共前缀收束起来的调用关系树。

```text
完整调用栈 A ─┐
完整调用栈 B ─┼→ CallTraceStorage：复用完整 trace 身份
完整调用栈 C ─┘

多个 trace 的 frame 前缀 ─→ FlameGraph Trie：共享可视化路径并累计宽度
```

这两层不能混成一句“都在去重”。前者的目标是节省存储并保存样本身份，后者的目标是恢复调用关系并让宽度真正代表累计代价。

### `_total` 与 `_self` 为什么要这样累计

`addChild()` 每走进一个节点，就先把当前值加到父节点的 `_total` 上（`src/flameGraph.cpp:92`）。等整条 trace 走完之后，`dumpFlameGraph()` 再对最终停下来的那个节点补一次 `f->_total += counter; f->_self += counter;`（`src/profiler.cpp:1340-1341`）。于是整条路径上的每一级祖先都能知道“有多少总代价经过了我”，而叶子或某条路径的结束节点还能额外知道“有多少代价在我这里终止”。

这一步如果做得不对，后面图上的宽度语义就会崩掉。火焰图的横向宽度从来不是“这一帧自身占了多少 CPU 时间”那么简单，而是“经过这条路径的累计值是多少”。`_self` 则是另一个更细的信号，用来告诉 tree view：“你的子节点总和之外，还剩多少值确实停在了这里。”模板在构造树节点标题时，正是用 `f.width - children width` 去显示 `self`（`src/res/flame.html:335-352`）。

到这里先记住一个结论：flamegraph 里最核心的结构，不是 HTML，也不是 Canvas，而是这棵在 native 侧已经把“共享前缀 + 累计宽度”算好的 Trie。没有它，浏览器根本拿不到一份足够稳定的布局输入。

## 第四层：为什么 `minwidth` 只能在输出期裁枝，而不能提前把样本扔掉

讲 flamegraph 时，`minwidth` 很容易被误读成“低频样本过滤器”。因为从用户视角看，它确实会让一些窄小节点从图上消失。但 current implementation 的关键点恰恰是：它裁掉的是可视化结果，不是采样事实。

`dumpFlameGraph()` 先根据 `args._counter` 决定这一轮输出要把什么数值当作宽度：如果是 `COUNTER_SAMPLES`，就用每条 trace 的样本次数；如果是 total 模式，就用累计计数器（`src/profiler.cpp:1307`）。所以 flamegraph 的宽度并不一定总是“样本数”，也可能是分配字节数、锁等待时间、native memory 总量等别的物理量。页面标题和 `units` 负责告诉浏览器“你现在看到的宽度单位到底是什么”（`src/profiler.cpp:1283-1294`）。

随后，`FlameGraph::dump()` 计算 `_mintotal = (u64)(_root._total * _minwidth / 100)`，再让 `Trie::depth()` 只统计总值不低于 cutoff 的节点（`src/flameGraph.cpp:109-113`、`src/flameGraph.h:57-67`）。这一步先决定页面深度需要多高。接着 `printFrame()` 真正遍历子节点时，又会再次检查 `trie->_total >= _mintotal`，只有满足阈值的节点才会进入最终 frame stream（`src/flameGraph.cpp:181-196`）。

也就是说，`minwidth` 的过滤分成两步：先决定“可见树大概有多深”，再决定“哪些节点真的值得编码进页面”。这不是重复劳动，而是在同时服务两个目标：一方面页面高度不能为那些最终根本不会显示的节点留白，另一方面 frame stream 也不该为它们付出体积成本。

更重要的是，async-profiler 故意没有在采样期或 `CallTraceStorage` 阶段去做这件事。为什么？因为那样会破坏火焰图最基本的真实性。假设一个祖先节点下面有很多很细的小枝条，它们单独看都不够宽，但合起来却构成这个祖先宽度的重要组成部分。如果在采样期就把这些细枝扔掉，祖先的累计宽度本身也会跟着缩水，结果图上看到的就不再是“真实总代价的简化视图”，而会变成“已经失真的删减版统计”。

这正是本文必须打透的一个失败方案：看起来更省事的办法，是越早裁掉低频分支越好；但真正正确的办法，是先把所有值老老实实聚合到祖先，再在最终出图时决定哪些枝条不值得画出来。前者省的是局部体积，代价是祖先宽度失真；后者保住的是统计语义，只把“细节是否显示”延后到可视化阶段。

因此 `minwidth` 更准确的身份，不是采样器的“冷热判断器”，而是输出端的“可读性裁枝器”。它让页面更清爽，但不改写采样事实。这也是为什么当前默认值其实是 `0`，参数由 `atof()` 解析，本文不能把它写成某个并不存在的固定默认百分比（`src/arguments.cpp:396-397`、`src/arguments.h:283`）。

这里先记住一句话：`minwidth` 可以裁掉节点的可见性，但不能裁掉祖先已经累计好的真实性。

## 第五层：为什么最终输出不是节点表，而是 `cpool + f/u/n` 压缩指令流

到这里，native 侧已经有了一棵聚合好的 Trie。下一个问题是：怎样把它写进一个 HTML 文件，既不浪费体积，又不让浏览器重新做一遍复杂推导？

最直接的办法，当然是每个节点都输出一份完整记录，例如 `(name, level, left, width, type)`。但这样做的问题很明显：名称会反复重复，坐标也会反复重复，越大的 profile 页面就越像一份冗长的节点清单。火焰图并不缺“描述能力”，它缺的是“紧凑表达能力”。

async-profiler 于是把压缩拆成两层：一层压缩名字，一层压缩布局指令。

### 第一层压缩：名字进入常量池，而不是每次都内联到节点里

`FlameGraph::addChild()` 在把节点挂进 Trie 之前，会先把 frame name 放进 `_cpool`，用一个整数 `name_index` 表示它（`src/flameGraph.cpp:82-90`）。等真正输出时，`printCpool()` 先写出 `'all'`，再按字符串排序输出各个名字（`src/flameGraph.cpp:199-225`）。

这里的压缩并不只是“用了常量池”这么简单。`printCpool()` 还会计算相邻字符串的公共 ASCII 前缀长度，只把差异部分写出来；模板里的 `unpack()` 再在浏览器端按前缀恢复完整字符串（`src/flameGraph.cpp:208-218`、`src/res/flame.html:400-404`）。

这意味着名字压缩发生了两次：先用整数索引避免节点里重复写全名，再用相邻前缀避免常量池本身重复写相似字符串。这和 Trie 的前缀聚合不是同一种压缩，千万不能混掉。Trie 压缩的是“调用路径结构前缀”，常量池压缩的是“字符串文本前缀”。

### 第二层压缩：布局不用完整坐标表，而用三种可推导指令

真正把 Trie 写成页面输入的，是 `printFrame()`。它不会老老实实输出一行一条完整节点，而是根据当前节点与上一节点之间的相对关系，选择三种形式之一（`src/flameGraph.cpp:149-175`）：

- `f(key, level, left, width, ...)`：通用形式；
- `u(key, width, ...)`：当前节点就是上一节点的子节点，层级和横向起点可继承；
- `n(key, width, ...)`：当前节点与上一节点同层相邻，起点可以由上一节点末尾推导。

```text
native printFrame()
  → f/u/n(key, level/width/left, type counters)
  → browser levels[level].push({left, width, title, color, details})
  → render()
  → canvas.fillRect(...)
```

这三种形式压缩的不是“语义”，而是“坐标冗余”。如果当前节点本来就站在上一节点下面，就没必要再把层级和横轴左边界完整重复一遍；如果它本来就紧挨着上一节点，也没必要重新报告完整坐标。浏览器模板里的 `f/u/n` 函数正是基于这些相对关系，把节点重新放进 `levels[level]`（`src/res/flame.html:160-175`）。

这一步背后对应的失败方案，其实就是“输出端为什么不干脆一行一个节点，简单明了”。答案是：简单是简单了，但会让页面文件膨胀得非常快，而这些膨胀大部分都只是把已经能从上下文推导出来的信息再写一遍。async-profiler 更愿意把推导规则固化在模板里，用三种短指令去表达节点间关系。

### 类型和颜色为什么不直接写成 CSS

`printFrame()` 还会把类型信息一并编码进去。`name_and_type = _name_order[f.nameIndex(key)] << 3 | f.type(key)` 把“名称索引”和“主类型”揉进一个整数；如果节点还混有多种 Java 执行状态，就再额外追加 `inln/c1/int` 计数（`src/flameGraph.cpp:149-167`）。浏览器收到之后，通过 `key >>> 3` 取名字、通过 `key & 7` 取类型，再映射到调色板（`src/res/flame.html:160-166`）。

这说明颜色也不是 native 侧直接写死的 CSS，而是 native 侧只负责提供“这个节点属于什么类型世界”，浏览器再决定该用哪套 palette 去显示。模板里的 legend 也明确把 Kernel、Native、C++ VM、Java compiled、C1、Inlined、Interpreted 等颜色约定写死在前端（`src/res/flame.html:69-89`）。

所以这里要守住另一个边界：不要把“名字里可能带后缀”和“浏览器最后看到的颜色”误认为同一层职责。名称是显示身份，类型是渲染分类，颜色只是分类的前端表现。

到这里为止，主线其实只做了一件事：native 侧把 Trie 压成了一份足够小、但仍然能恢复完整布局与分类语义的指令流。浏览器接下来的工作，就不再是“分析原始采样”，而只是“解码并呈现这份指令流”。

## 第六层：为什么模板必须编进二进制，而不是运行时再读一个 HTML 文件

如果把前面的 `cpool + f/u/n` 看成一份页面数据，那么还剩最后一个问题：这份数据到底塞进哪儿？最容易想到的做法，是运行时从磁盘读取一个 `flame.html` 模板，再把占位符替换进去。但 async-profiler 没这么做。

`src/flameGraph.cpp:17` 直接写了 `INCBIN(FLAMEGRAPH_TEMPLATE, "src/res/flame.html")`。`src/incbin.h:17-30` 里的宏通过汇编 `.incbin` 把模板文件嵌进只读段，同时导出起止符号，并在末尾补一个零字节。也就是说，`FlameGraph::dump()` 运行时看到的 `FLAMEGRAPH_TEMPLATE`，并不是某个需要再打开的外部资源文件，而是当前二进制里已经静态携带的一段内存。

这一点的真正意义，不只是“实现有点酷”，而是它解决了部署语义。async-profiler 输出 flamegraph 时，不需要再关心目标环境是否把 `src/res/flame.html` 带过去了，也不需要在安装目录、相对路径、工作目录之间继续猜模板在哪里。模板和 native 输出逻辑一起被编译、一起被分发、一起被版本化。

如果不用 `INCBIN`，而改成运行时去找模板文件，会立刻引入一串与火焰图本身无关、却会破坏可用性的麻烦：模板相对路径怎么定位，打包进 jar 或发行包后怎么提取，跨平台部署时资源文件是否会丢，版本升级后 native 代码与模板是否会错配。换句话说，读模板文件听起来更“灵活”，但实际上把“生成一张 HTML”这件事又拖回了资源管理问题。

async-profiler 在这里的取舍非常明确：我宁可付出“模板改了就要重新编译目标文件”的代价，也要把 flamegraph 输出做成真正的单工件能力。注意，这里的“单文件”指的是模板资源不依赖外部伴随文件，而不是说结果永远只能落成一个特定名字的文件。最终 `dump()` 仍然是通过 `Writer` 把内容写到用户指定的 HTML 文件或其他输出流里（`src/flameGraph.cpp:109-146`）。

### `dump()` 做的只是占位符替换，不是模板引擎

`FlameGraph::dump()` 拿到内嵌模板后，会按顺序调用 `printTill()`，找到各个占位符，把前半段原样写出，再把动态内容补进去（`src/flameGraph.cpp:109-146`）。它替换的槽位包括：

- `/*height:*/300`：根据可见深度生成 Canvas 高度，上限是 `MAX_CANVAS_HEIGHT = 32767`；
- `/*title:*/`：标题；
- `/*inverted:*/false`：初始绘制方向；
- `/*treeview:*/false`：初始视图模式；
- `/*units:*/`：单位；
- `/*depth:*/0`：层数；
- `/*cpool:*/`：名称常量池；
- `/*frames:*/`：压缩帧指令；
- `/*highlight:*/`：搜索初始化位置。

这些占位符都能在模板里找到对应位置，例如 `src/res/flame.html:31-32`、`src/res/flame.html:60`、`src/res/flame.html:114-119`、`src/res/flame.html:525-531`。但更重要的是要看清它没有做什么：它没有引入通用模板语言，也没有在运行时解析条件、循环或组件。`printTill()` 只是字符串查找和拼接（`src/flameGraph.cpp:227-231`）。

这背后的意思是：async-profiler 在这里并不想拥有一个“网页模板系统”，它只想拥有一个“稳定的火焰图页面骨架”，往里面灌入已经准备好的数据。模板引擎越重，就越会把输出路径从“简单数据注入”拖成“HTML 生成框架”。当前实现刻意停在更窄、更可控的一层。

所以前面那段“占位符清单”真正要表达的，不是模板里有哪些孔，而是 async-profiler 选择了一种非常克制的边界：模板负责页面骨架，native 负责填数据，双方都不过度侵入对方职责。

## 第七层：浏览器端真正负责什么，为什么 tree view 只是第二种视图而不是第二套结果

现在页面已经拿到了 `cpool` 和 `f/u/n` 指令流。浏览器端的第一件事，是先用 `unpack(cpool)` 恢复名称常量池，再调用模板里预定义的 `f/u/n`，把每个 frame 重新放进按层组织的 `levels[]` 数组（`src/res/flame.html:160-175`、`src/res/flame.html:400-404`、`src/res/flame.html:525-531`）。

这一步是整个前后端分工的核心交界线。浏览器拿到的已经不是“原始采样栈”，而是一份按层可遍历的页面输入：每个 frame 都带着 `left`、`width`、`title`、`color`、`type` 和详情文本。也就是说，浏览器不用再问“这些调用路径怎么聚合”，只需要问“如何把这些已经聚合好的 frame 画出来”。

`render()` 的逻辑很直接：选定当前 root，计算像素比例 `px = canvasWidth / root.width`，然后逐层遍历 `levels[h]`，把每个 frame 画成一块矩形（`src/res/flame.html:245-306`）。同一层共享同一条横轴，`left` 和 `width` 决定它在 root 视角下占据的区间，纵向位置则由层号决定。默认模式下，页面的真正显示面是 Canvas，而不是 DOM 树（`src/res/flame.html:102`、`src/res/flame.html:297-303`）。

点击某个 frame 时，浏览器并不会回去请求 native 侧再生成一张新图，而只是把这个 frame 设成新的 root 重新 `render()`；搜索则是用 JavaScript 正则表达式标记匹配节点，并维护匹配导航；Ctrl/Alt 点击时，还会执行 `removeStack()` 从当前 `levels` 数据里直接裁掉一段路径（`src/res/flame.html:212-243`、`src/res/flame.html:406-434`）。

这些行为共同说明了一件事：浏览器端处理的是一份可交互的数据模型，而不是一张死图片。可交互，并不意味着它重新理解了采样；只是意味着 native 已经把足够多的结构信息放进了页面。

### tree view 为什么不是另一套 native 聚合

切到 tree view 时，模板调用的是 `buildTree()`。它从当前 root 出发，沿着 `levels` 去搜下一层落在当前区间里的子节点，再动态构造 `ul/li` 结构（`src/res/flame.html:308-387`、`src/res/flame.html:453-458`）。也就是说，tree view 并没有请求另一份专门的 tree 数据，也没有重新跑一遍 FlameGraph 聚合器，它只是把同一份 `levels` 从“二维矩形画布”换成了“可展开树”。

这件事必须讲透，因为它背后正是 `OUTPUT_TREE` 不单独拥有一套 native 输出路径的根本原因。如果 tree view 真是另一套结果，native 侧就必须再维护一份独立的树结构、独立的序列化格式、独立的宽度和 self 语义，还得保证它和 Canvas 视图永远严格一致。现在的实现则把约束压得更强：页面上所有交互，都是围绕同一份 `levels` 数据展开，所以 flamegraph 和 tree 不会在数据语义上分家。

这也是为什么模板在切换 tree 按钮时，只是 `treeview = !treeview`，必要时调用 `buildTree()`，然后切换 Canvas 与 tree 容器的显隐（`src/res/flame.html:453-458`）。从 native 侧视角看，根本没有“第二种聚合结果”这回事，只有“第二种浏览器展示方式”。

### `reverse` 与 `inverted` 为什么不能混成一句“翻转图片”

这里还必须把另一个常见误解彻底打掉：`reverse` 和 `inverted` 看起来都会让图“翻过来”，但它们改的不是同一层。

`reverse` 在 native 侧生效。`dumpFlameGraph()` 遍历 trace 时，如果 `args._reverse` 为真，就按不同于默认路径的顺序把帧加入 Trie；还会先特殊处理线程帧、CPU 帧和调度帧，让这些帧在 reversed 语义下继续保持“总在最前面”的规则（`src/profiler.cpp:1312-1338`）。这一步改的是调用路径进入聚合器的方向，也就是数据组织方向。

`inverted` 则在模板里作为一个布尔开关，主要改变 `render()` 计算纵向坐标时是从上往下画，还是从下往上画（`src/flameGraph.cpp:122-125`、`src/res/flame.html:297-303`）。这一步改的是页面视觉朝向。

如果把两者都描述成“翻转图”，读者会误以为它们只是最终图片的不同摆放方式。实际上，一个改的是路径本身怎么进入树，一个改的是同一棵树怎样在 Canvas 上摆放。它们之所以都可能让用户看到“上下方向变了”，只是结果表象相似，不代表作用层次相同。

## 常见误解与实现边界

**误解一：async-profiler 先生成完整 HTML DOM，再交给浏览器。** 当前 native 侧生成的是 HTML 模板和 JavaScript 数据；默认绘制面是 Canvas，tree view 才动态生成 `ul/li`。

**误解二：`minwidth` 在采样时丢弃低频样本。** 当前它在 `FlameGraph::dump()` 与 `printFrame()` 阶段按聚合后的 `_total` 做可视化 cutoff，不改 `CallTraceStorage` 的样本计数。

**误解三：FlameGraph Trie、`CallTraceStorage` 去重结构、浏览器 tree DOM 是同一棵树。** 三者都在表达“某种结构”，但职责完全不同：一个管完整 trace 身份，一个管输出期前缀聚合，一个管浏览器展示。

**误解四：颜色是由 `FrameName` 直接写进 HTML 的。** 当前 `FrameName` 提供的是名称和 `FrameTypeId`，`FlameGraph` 负责把类型编码进节点，模板再通过 palette 决定颜色。

**误解五：`OUTPUT_TREE` 表示另一种采样或聚合算法。** `OUTPUT_TREE` 与 `OUTPUT_FLAMEGRAPH` 共用 `dumpFlameGraph()`；差异主要是模板初始视图模式。

**误解六：`reverse` 和 `inverted` 都只是把成品图片上下翻一下。** 前者改变 trace 进入 Trie 的路径方向，后者只改变浏览器默认绘制方向。

## 收网：async-profiler 实际上定义了一套“火焰图页面输入协议”

如果把整条链路压成一句话，它其实不是“采样结果直接生成 HTML”，而是“采样结果先被整理成浏览器可直接消费的数据协议，再被 HTML 模板展示出来”。

```text
CallTraceStorage 的 CallTraceSample
  → FrameName：过滤、命名、提供 FrameTypeId
    → FlameGraph::addChild：父节点 + name/type 复用 Trie 节点
      → _total/_self/type counters：累计宽度、self 与类型统计
        → minwidth：输出阶段 cutoff
          → printCpool：名称常量池与公共前缀压缩
          → printFrame：f/u/n 压缩指令
            → INCBIN 内嵌的 flame.html
              → JavaScript 解包与 levels
                → Canvas 默认视图 / DOM tree view / 搜索缩放
```

到这里，主线只发生了三件事。

第一，native 侧没有把原始采样栈直接倾倒给浏览器，而是先通过 `FrameName` 和 Trie 把名字、类型、宽度和共享前缀整理成稳定结构。

第二，这份结构没有被写成臃肿的节点表，而是被进一步压成“名称常量池 + 可推导坐标的 `f/u/n` 指令流”。

第三，浏览器既没有重新跑一遍分析器，也没有拿到另一套 tree 专用结果；它只是围绕同一份 `levels` 数据做 Canvas 绘制、缩放、搜索和 tree view 切换。

*关键设计（斜体）：* *async-profiler 把“采样结果是什么”和“浏览器怎样看它”强行拆开：native 侧负责确定身份、宽度、类型与布局输入，JavaScript 侧负责把这些输入变成可交互的页面。*[模式: 数据预聚合 + 紧凑序列化 + 客户端渲染]

**本篇的一句话困惑**：采样栈为什么能变成一张可搜索、可缩放、可切换 tree view 的 HTML 火焰图？

**本篇的一句话顿悟**：`CallTraceStorage` 的 trace 先经过 `FrameName` 命名和过滤，再被 `FlameGraph` 聚合成 Trie，随后压成常量池和 `f/u/n` 帧流，注入编译期嵌入的 HTML 模板，由浏览器解码成 Canvas 或 tree view。

下一篇继续看另一个消费者：JFR recorder 为什么不复用这套 Trie/HTML 页面输入协议，而要维护自己的 stack-trace pool、事件 chunk 和 JFR 二进制结构。

[跨层标注：C++ `Trie`/`std::map`/输出编码；`CallTraceStorage` trace 与 counter；FrameName/FrameTypeId；INCBIN 汇编资源嵌入；HTML/JavaScript Canvas；DOM tree view；flamegraph 交互协议]
