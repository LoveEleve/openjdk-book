# 01. 标签与选择 — `-Xlog:gc*=debug` 是怎么工作的

> **前置依赖**:[03-arguments-flags/02 — flag 生命周期](openjdk/vol-02/03-arguments-flags/02-flag-processing-and-management.md):-Xlog 也是一个 flag
> → **后续**:[02 — 输出与配置](02-output-and-configuration.md)
> 关联域: 35-dcmd(VM.log 命令)、32-jfr、18-safepoint

## 一个查询语法,一套扁平枚举

`-Xlog:gc*=debug` 是 JDK 9+ 统一日志的典型写法。`gc*` 看起来像"gc 前缀的所有子标签"——但 jdk11u 的实现**没有标签树**:标签是一个扁平的编译期枚举,`gc*` 的真实语义是"包含 gc 标签的任意日志"。这篇拆:标签怎么定义、日志怎么声明、选择器怎么解析和匹配。

## 1. 标签:一个扁平的编译期枚举

### 1.1 场景:gc、heap、region 是什么关系

所有标签集中在 `LOG_TAG_LIST` 宏里(logTag.hpp:34-174),**140 个左右的平级标签**——gc、heap、region、task、phases 都是**同一层的枚举值**:

```cpp
// logTag.hpp:34-38、76-81、130-133、199-205(截取核心,逐字)
#define LOG_TAG_LIST \
  LOG_TAG(add) \
  LOG_TAG(age) \
  LOG_TAG(alloc) \
  LOG_TAG(aot) \
  ...
  LOG_TAG(gc) \
  LOG_TAG(handshake) \
  LOG_TAG(hashtables) \
  LOG_TAG(heap) \
  ...
  LOG_TAG(region) \
  LOG_TAG(reloc) \
  LOG_TAG(remset) \
  ...
  enum type {
    __NO_TAG,
#define LOG_TAG(name) _##name,
    LOG_TAG_LIST
#undef LOG_TAG
    Count
  };
```

`enum type` 直接由宏生成(199-205)——**没有父指针、没有层级**。`gc+heap` 是"一条日志同时带 gc 和 heap 两个标签",不是"heap 是 gc 的子节点"。

每条日志的标签声明用 `LOG_TAGS(...)` 宏(181-185):

```cpp
// logTag.hpp:176-185(截取核心,逐字)
#define PREFIX_LOG_TAG(T) (LogTag::_##T)

// Expand a set of log tags to their prefixed names.
// For error detection purposes, the macro passes one more tag than what is supported.
// If too many tags are given, a static assert in the log class will fail.
#define LOG_TAGS_EXPANDED(T0, T1, T2, T3, T4, T5, ...)  PREFIX_LOG_TAG(T0), PREFIX_LOG_TAG(T1), PREFIX_LOG_TAG(T2), \
                                                        PREFIX_LOG_TAG(T3), PREFIX_LOG_TAG(T4), PREFIX_LOG_TAG(T5)
// The EXPAND_VARARGS macro is required for MSVC, or it will resolve the LOG_TAGS_EXPANDED macro incorrectly.
#define EXPAND_VARARGS(x) x
#define LOG_TAGS(...) EXPAND_VARARGS(LOG_TAGS_EXPANDED(__VA_ARGS__, _NO_TAG, _NO_TAG, _NO_TAG, _NO_TAG, _NO_TAG, _NO_TAG))
```

**最多 5 个标签**(`MaxTags = 5`,197 行):宏展开 6 个参数,第 6 个必须是 `_NO_TAG`——给多了直接编译失败(注释:"For error detection purposes... a static assert will fail")。

- [C++: 标签的"类型安全"是编译期的:`log_error(gc, heap)("...")` 的标签参数在编译期就固定成枚举值数组,拼错标签名编译不过;`from_string`(211)是运行时的反向映射(字符串→枚举),fuzzy_match(212)在拼错时给"Did you mean?"建议(logSelection.cpp:121-123)]

**关键设计 (斜体)**: *为什么用扁平枚举而不是模块树?因为一条日志**可以属于多个分类**——同一子系统(G1 并发标记)的不同消息:workers 调度消息用 `gc+task`(g1ConcurrentMark.cpp:984),阶段计时用 `gc+phases`(genCollectedHeap.cpp:462 的 GCTraceTime)——标签可以叠加,树形分类只能选一个父节点。扁平 + 多标签 = "一个子系统从多个维度可被过滤"。5 个上限是"够用就好":绝大多数日志 1-3 个标签,第 6 个大概率是凑数。*

## 2. LogTagSet:日志的标签声明与全局注册

### 2.1 场景:每个日志点的标签集合去哪了

每句日志的标签组合是一个 `LogTagSet` 对象(logTagSet.cpp:37-55):

```cpp
// logTagSet.cpp:37-51(截取核心,逐字)
LogTagSet*  LogTagSet::_list      = NULL;
...
// This constructor is called only during static initialization.
LogTagSet::LogTagSet(PrefixWriter prefix_writer, LogTagType t0, LogTagType t1, LogTagType t2, LogTagType t3, LogTagType t4)
    : _next(_list), _write_prefix(prefix_writer) {
  ...
  _list = this;
}
```

**每个 LogTagSet 在静态初始化时把自己插进全局链表 `_list`**——所有日志点的标签集合在 JVM 启动前就全部登记完毕(静态初始化,单线程,无锁)。jcmd `VM.log list` 遍历这张表列出所有可配置的日志类别。

**关键设计 (斜体)**: *"静态初始化注册"把日志系统的配置工作从运行时挪到加载期:100+ 个 LogTagSet 在启动前就绪,配置变更(logConfiguration)只需遍历链表改每个 set 的输出级别——没有动态注册的锁竞争,也没有"日志点还没注册"的竞态窗口。*

## 3. LogSelection:解析与匹配

### 3.1 场景:`gc*=debug` 的解析与判定

选择器解析在 `LogSelection::parse`(logSelection.cpp:154)→ `parse_internal`(95-152):

```cpp
// logSelection.cpp:96-151(截取核心,逐字)
  // Parse special tags such as 'all'
  if (strcmp(str, "all") == 0) {
    return LogSelection(tags, true, level);
  }

  // Check for '*' suffix
  bool wildcard = false;
  char* asterisk_pos = strchr(str, '*');
  if (asterisk_pos != NULL && asterisk_pos[1] == '\0') {
    wildcard = true;
    *asterisk_pos = '\0';
  }

  // Parse the tag expression (t1+t2+...+tn)
  char* plus_pos;
  char* cur_tag = str;
  do {
    plus_pos = strchr(cur_tag, '+');
    if (plus_pos != NULL) {
      *plus_pos = '\0';
    }
    LogTagType tag = LogTag::from_string(cur_tag);
    if (tag == LogTag::__NO_TAG) {
      if (errstream != NULL) {
        errstream->print("Invalid tag '%s' in log selection.", cur_tag);
        LogTagType match =  LogTag::fuzzy_match(cur_tag);
        if (match != LogTag::__NO_TAG) {
          errstream->print(" Did you mean '%s'?", LogTag::name(match));
        }
        errstream->cr();
      }
      return LogSelection::Invalid;
    }
    ...
    tags[ntags++] = tag;
    cur_tag = plus_pos + 1;
  } while (plus_pos != NULL);
```

语法处理:`all` 特殊词(97-99)、`*` 后缀(wildcard,102-107)、`+` 切分标签组(110-138)、`from_string` 查枚举(117)、拼错给建议(121-123)、重复标签报错(140-149)。

匹配逻辑是**子集检查**(161-171):

```cpp
// logSelection.cpp:161-171(逐字)
bool LogSelection::selects(const LogTagSet& ts) const {
  if (!_wildcard && _ntags != ts.ntags()) {
    return false;
  }
  for (size_t i = 0; i < _ntags; i++) {
    if (!ts.contains(_tags[i])) {
      return false;
    }
  }
  return true;
}
```

**`gc*` 的真实语义**:wildcard 时跳过"标签数必须相等"的检查,只要求目标 TagSet **包含 gc**——所以 `gc*` 命中一切带 gc 标签的日志(gc、gc+heap、gc+region+task……);不带 `*` 的 `gc+heap` 则要求**恰好**两个标签。不是前缀匹配,是"包含 + 可选的数量豁免"。

**LogLevel 六级**(logLevel.hpp:54-66):

```cpp
// logLevel.hpp:54-66(截取核心,逐字)
  enum type {
    Off,
#define LOG_LEVEL(name, printname) name,
    LOG_LEVEL_LIST
#undef LOG_LEVEL
    Count,
    ...
    Default = Warning,
    Unspecified = Info
  };
```

注意顺序:**Off=0、Trace=1、Debug=2、Info=3、Warning=4、Error=5**(LOG_LEVEL_LIST 是 Trace/Debug/Info/Warning/Error,55-59)。`level <= 阈值` 才输出——`gc*=debug` 表示 debug 及以上(debug/info/warning/error)输出,off 排除。

- [C++: 多选择器:`-Xlog:gc*=debug:gc.log,gc+heap=trace:stderr`——LogSelectionList 按顺序尝试,第一个命中的选择器决定输出目标与级别(大纲的"首个匹配"语义成立,logConfiguration 里实现)]

**关键设计 (斜体)**: *`gc*` 的真实机制与直觉相反:它不"展开成 12 个子标签",而是"**包含 gc 即命中**"——匹配成本是与标签数线性(每个 LogTagSet 至多 5 个标签的 contains 检查),配置在启动时一次性求值。扁平枚举 + 子集匹配把"查询语法"降维成几十次枚举比较——这就是为什么 `-Xlog` 的配置解析毫秒级完成。*

## 核心悬念

"标签的声明(扁平枚举 + LOG_TAGS 宏)、登记(静态初始化链表)、选择(子集匹配 + wildcard)到齐。但选中的日志往哪写?stdout、stderr、文件、环形缓冲?`-Xlog:gc*=debug:file=gc.log,filesize=10m` 的输出目标怎么管理,日志文件的轮转怎么工作?下一篇:输出与配置。"

> → [02-output-and-configuration.md](02-output-and-configuration.md)
