# 01. 标签与选择 — 一个查询语法,一套扁平枚举

> 🔴 Deep | 标签/选择/级别
> 读者处境: `-Xlog:gc*=debug` 怎么工作?——不是标签树,是扁平枚举 + 子集匹配。
>
> ⚠️ 写作期修正(2026-08-12, vol-02/04-logging/01 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **"标签树/父 tag 指针/前缀 tree walk"全部编造**: 标签是**扁平编译期枚举**(LOG_TAG_LIST,logTag.hpp:34-174,~100 个平级标签),无层级、无父指针;"5 个顶层大类"不存在
> - **`gc*` 的真实语义**: wildcard 时**跳过标签数相等检查,只要求 TagSet 包含 gc**(selects,logSelection.cpp:161-171)——不是"前缀匹配 12 个子标签"
> - **LogLevel 顺序反了**: Off=0/Trace=1/Debug=2/Info=3/Warning=4/Error=5(logLevel.hpp:55-59,LOG_LEVEL_LIST 55-59);Default=Warning/Unspecified=Info(64-65)
> - MaxTags=5 ✓(logTag.hpp:197);LOG_TAGS 宏 6 参检查(181-185)
> - 注册: LogTagSet 静态初始化插全局链表(logTagSet.cpp:37-51,注释 "called only during static initialization")
> - **多选择器语义修正**: level_for 逐个尝试、**后命中的覆盖先命中**(logSelectionList.cpp:92-103)——"首个命中决定输出"是错的;`gc*=info,safepoint*=off` 中 off 写在后面才生效

### 1. "标签 — 扁平编译期枚举"

**定义**(`logTag.hpp:34-174` + `199-205`):
```
LOG_TAG_LIST: ~100 个平级标签(gc/heap/region/task/phases 同层,无树)
enum type { __NO_TAG, _add, ..., _vmthread, Count }(199-205)——宏生成
MaxTags = 5(197);LOG_TAGS(...) 宏 6 参展开,第 6 个必须 _NO_TAG(181-185,超限编译失败)
from_string(211)/fuzzy_match(212,拼错给 "Did you mean?" 建议,logSelection.cpp:121-123)
```
- 关键设计: **扁平 + 多标签**——一条日志可属多个分类(并发标记同时是 gc+task 和 gc+phases);5 上限覆盖 95% 场景。

### 2. "LogTagSet — 静态注册"

**注册**(`logTagSet.cpp:37-51`):
```
LogTagSet 构造函数(静态初始化调用,注释 40): _next(_list); _list = this(43/51)——全局链表
contains(tag)(logTagSet.hpp:88)
jcmd VM.log list 遍历 _list
```
- 关键设计: **静态初始化登记**——100+ TagSet 启动前就绪,配置变更遍历链表即可,无动态注册竞态。

### 3. "LogSelection — 解析与匹配"

**解析与匹配**(`logSelection.cpp:95-171` + `logLevel.hpp:54-66`):
```
parse_internal(95-152): "all" 特殊(97-99)/'*' 后缀(strchr,102-107)/'+' 切分(110-138)/from_string(117)/
  fuzzy_match 建议(121-123)/MaxTags 检查(129-135)/重复检查(140-149)
selects(161-171): 非 wildcard → ntags 必须相等 + 全包含;wildcard → 只要求包含——gc* = "含 gc 即命中"
LogLevel(55-59): Off=0/Trace=1/Debug=2/Info=3/Warning=4/Error=5;选择器级别=最低可输出级别(消息级别 >= 选择器级别才输出)
多选择器: -Xlog:gc*=debug,gc+heap=trace:stderr——level_for 逐个尝试,后命中覆盖先命中(logSelectionList.cpp:92-103)
```
- 关键设计: **子集匹配 + wildcard 数量豁免**——查询语法降维成枚举比较,配置解析毫秒级;与直觉相反,gc* 不"展开子标签"。

---

### 核心悬念

**"标签(扁平枚举)/登记(静态链表)/选择(子集匹配)——过滤完,输出往哪投? stdout/stderr/文件/环形缓冲?file=gc.log,filesize=10m 的轮转怎么工作?"** — 下一篇: 输出与配置。

> → [02-output-and-configuration.md](02-output-and-configuration.md)
