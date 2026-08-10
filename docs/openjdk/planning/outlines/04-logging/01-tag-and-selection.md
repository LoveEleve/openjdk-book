# 01. 60+ 标签，一个查询语法 — JVM 日志怎么知道该输出什么？

> 🔴 Deep | 13 KP 中的 3 个核心机制
> 读者处境: `-Xlog:gc*=debug` 一行命令能匹配 12 个 gc 子标签。不是 regex——是标签树。怎么做到的？

### 1. LogTag — 60+ 层次化标签的表亲树

场景: 你写了 `-Xlog:gc*=debug`。JVM 怎么从 12 个 gc 子标签 (gc+heap, gc+region, gc+task, ...) 中选出正确的？不是逐个字符串比较——是树形匹配。

**标签树** (`logTag.hpp:50-120`):
- 5 个顶层大类: gc, class, compilation, thread, vm
- gc 子树 (12 个子标签): gc+heap, gc+region, gc+task, gc+phases(retire/scan/...), gc+stringdedup, gc+ref (reference processing), gc+remset (remembered set), gc+plab (promotion LAB), gc+metaspace, gc+freelist
- [C++: LogTag 不是运行时字符串——是编译时 enum。`LOG_TAG(gc, region)` 预处理宏展开为 `static const LogTag _tags[] = {LogTag::_gc, LogTag::_region}`——TagSet 是固定大小的栈上对象，不需要堆分配]
- 每个 tag: 枚举值 + 字符串名 (用于日志输出) + 父 tag 指针 (`logTag.hpp:70`)
- [C++: 父 tag 指针——`gc+region` 的父 tag 是 `gc`。`gc*` 匹配不仅检查 tag 本身的字符串前缀——还通过父 tag 指针判断是否属于 gc 大类]

**为什么是标签而不是模块名？** — 同一个 GC event (Concurrent Mark) 同时属于 gc+task (调度) 和 gc+phases (时间统计)。按模块分类——一条日志只能匹配一个模块——按标签分类——一条日志有两个标签，被两个过滤条件同时命中。

### 2. LogTagSet — 每句日志的标签集合

场景: `G1ConcurrentMark` 想打日志——它该声明自己用哪些标签？

**`LOG_TAGS(gc, region, task)`** (`logTagSet.hpp:40-140`):
- 一次声明，编译时绑定——TagSet 是 5 个 LogTag 的固定数组
- 上限 5 个标签: `sizeof(LogTagSet)` = 5 * sizeof(LogTag) + bitmask header——必须在栈上 (`logTagSet.hpp:40`)
- [C++: C++ constexpr 不能动态分配——LogTagSet 的成员必须在编译期知道确切大小。上限 5 个标签覆盖 95% 的场景。选最重要的 5 个——如果真有第 6 个重要标签，必然放弃最不重要的那个]

**全局注册表** (`logTagSetDescriptions.cpp`):
- 所有 LogTagSet 注册到全局链表——`jcmd VM.log list` 遍历它
- [C++: 每个 LogTagSet 在 `__attribute__((constructor))` 或静态初始化时调用 `LogTagSet::describe()` 注册自己到全局 `LogTagSet::_list`]

**匹配逻辑**: 用户输入 tagset={gc, heap} → 遍历所有已注册 TagSet → 如果某个 TagSet 是 {gc, heap, region, task} 的子集 → 命中

### 3. LogSelection + LogLevel — "gc*=debug" 的完整解析

**解析语法** (`logSelection.cpp:45-128`):
- 格式: `[*]tag1[+tag2...][*]=level`
- tag*: 匹配所有以 tag 为前缀的标签——`gc*` = gc+heap, gc+region, gc+task, ...
- * (完整通配): 匹配所有标签——`*=info` = 所有子系统的 info 及以上
- [C++: 解析实现——逐字符扫描——`strchr(tag, '*')` 检测通配→`strncmp(prefix, tag, prefix_len)` 前缀匹配。不是 regex——逐字符串比较在 60 个标签上的开销 <1µs]

**LogLevel 六级** (`logLevel.cpp:38-95`):
- Trace / Debug / Info / Warning / Error / Off
- 比较: `level <= configured` = 输出。Debug(=2) ≤ Info(=3) → 不输出；Debug(=2) ≤ Debug(=2) → 输出
- [C++: `LogLevelType` enum——0=Trace...5=Off。`int(level) <= int(threshold)` ——较小的 enum 值=更详细的等级 (Trace < Debug < Info)]

**LogSelectionList**: 多个选择器链——第一个匹配决定输出，后续为备选
- 示例: `-Xlog:gc*=debug:gc.log,gc+heap=trace:stderr` → gc 事件→debug→gc.log；gc+heap→trace→stderr (两个输出目标)

---

### 核心悬念

**"60+ 标签——`gc*=debug` 怎么选掉 12 个 gc 子标签？"** — 不是逐个匹配——是前缀 tree walk。`gc*` 匹配 gc 标签的全部子节点——标签树的高度 < 3——一次 walk 找到所有 12 个 gc 子标签。每个日志声明自己的 2-3 个标签——5 个上限对绝大多数子系统不是限制。下一章: 过滤完——输出往哪投？stdout？文件？两个同时？

> → [02-output-and-configuration.md](02-output-and-configuration.md)
