# 02. 编译代码内联了 3 层——怎么看到源级方法？— Virtual Frame

> 🔴 Deep | 3 KP 中的源级抽象
> 读者处境: JFR 采了一个 stack trace——PC 在 C2 代码中。C2 内联了 A.bar()→B.baz()→C.qux() → 3 层内联只对应 1 个物理帧。JFR 需要展开成 3 个源级 frame。
>
> ⚠️ 写作期修正(2026-08-13, vol-02/24-frame/02 已按真实源码成文 151 行,本大纲为规划期产物,机制描述以文章为准):
> - **"vframe 四子类含 nativeVFrame" 错(编造)**: **无 nativeVFrame**;真实家族=vframe(vframe.hpp:54,ResourceObj)→javaVFrame(:107,五纯虚 method/bci/locals/expressions/monitors :110-115)→interpretedVFrame(:160)/compiledVFrame(**vframe_hp.hpp:30**,非 vframe.hpp;scope=NULL 表示 native: vframe_hp.cpp:236-245);另支 externalVFrame(:204)→entryVFrame(:217);"vframe.hpp:40-120" 漂移
> - **sender 双模式** ✓(compiledVFrame::sender vframe_hp.cpp:304-319: scope 非顶→同帧 scope->sender() 内联上层;scope 顶/native→vframe::sender()(vframe.cpp:103-108)=_fr.real_sender() 物理链;vframe::top :110-116)
> - **vframeStream 位置错**: 类在 **vframe.hpp:268-330**(vframeStreamCommon,StackObj,_mode interpreted/compiled/at_end :274,_method/_bci 缓存 :279-280;vframeStream :332),**next() 在 vframe.inline.hpp:41-49**(非 vframe_hp.cpp:50-150);fill_from_frame :125-201(解释器→:204-222/编译 native→:118-123/编译→pc_desc_at→fill_from_compiled_frame :75-114 只解码 sender_decode_offset+method+bci 三字段/first+entry→at_end);fill_in_compiled_inlined_sender :66-72(serialized_null 判边界);构造 :51-64(last_frame 起)
> - **ScopeDesc 链**: CompiledMethod::scope_desc_at(compiledMethod.cpp:218)=pc→PcDesc→scope_decode_offset;ScopeDesc(scopeDesc.hpp:60-108,sender :83/is_top :89,sender() 实现 scopeDesc.cpp:152);内联树=编译期压缩进 nmethod scopes_data 的单向链表
> - **栈轨迹消费者**: JFR(jfrStackTrace.cpp:135 vframeStreamSamples : vframeStreamCommon)与 Thread.print(thread.cpp:3417 vframeStream vfst)都是 vframeStream 消费;jstack"每行一方法"=迭代器输出
> - 实证: materials/commands/24-inline-demo.txt(-Xlog:jit+inlining=debug 显示 baz/qux/bar 层层 inline @1/@19 偏移 vs jcmd Thread.print 只有 InlineDemo.main 一行——内联层不出现为物理帧)

### 1. "物理帧 vs 源级帧" — frame→vframe 双层

场景: 解释器: 1 个方法调用 = 1 个物理帧。JIT: 内联的 3 个方法调用 = 1 个物理帧。vframe 将内联拆开成独立的源级帧。

**vframe 四子类** (`vframe.hpp:40-120`):
```
compiledVFrame    — 内联树中的一层(vframe->top()返回最内层)
interpretedVFrame — 解释器的直接映射(1物理=1vframe)
javaVFrame        — 公共基类(bci/method/locals/expressions 获取)
nativeVFrame      — JNI native 方法的虚拟帧
```
- 源码: `vframe.hpp:40-120` 类层次
- 关键设计: compiledVFrame 内部存 scope_desc(scope 链)→递归展开内联树。`compiledVFrame::sender()` 返回上一层内联 caller(不是物理 caller!)——物理 caller 由 `frame::sender()` 处理。这两个 sender 是不同的层
- [C++: vframe 的 4 子类用 virtual method dispatch——`is_compiled_frame()`/`is_interpreted_frame()` 区分类型。vframe::top() 是最常调用的工厂方法——根据 frame type 构造对应子类(compiledVFrame/interpretedVFrame/nativeVFrame)并返回最内层 scope]

**vframe::sender() 的双模式** (`vframe.cpp:80-150`):
```
compiledVFrame:
  sender() 返回上一层 inline scope(同一物理帧内)
  如果是最外层(no more inline)→物理 frame::sender() →构造 interpretedVFrame/nativeVFrame

interpretedVFrame:
  sender() → 物理 frame::sender() → 构造下一个 frame →可能是 interpreted/compiled/native
```
- 关键设计: vframe 和 frame 的 sender() 语义不同但串行——vframe 先遍历"虚拟层级"(内联树)，到边界后 delegate 给 frame::sender()

### 2. "遍历整个调用栈" — vframeStream 流式 API

场景: JFR 每 100ms 采一次 stack——需要从当前线程最上层遍历到最底层——每个 frame 都要拿到 bci/method/编译信息。

**vframeStream 单次遍历** (`vframe_hp.hpp:30-80`):
```cpp
class vframeStream : public StackObj {
  frame _frame;         // 当前物理帧
  int   _index;         // 当前在该物理帧的 inline 层级(0=最外)
  bool at_end();
  void next();          // advance: next inline→next physical→end
  methodHandle method();
  int bci();
};
```
- 源码: `vframe_hp.hpp:30-80` + `vframe_hp.cpp:50-150` next() 逻辑
- 关键设计: fill_from_frame 从 JavaThread::last_frame() 开始→逐 frame 遍历→逐 scope 展开。每次 next: _index++(如果有更多 inner scope)→最后一个 scope→物理帧 sender→next frame→_index=0(新帧的最外 scope)。直到 frame 不是 Java frame(哨兵帧)
- [C++: vframeStream 是 StackObj——在栈上分配, O(1)内存(只存一个 frame+一个 int index)。不是把所有 vframe 预先构建好——惰性构建——每次 next() 才解析下一层 scope。JFR 采样时如果只采 64 frames→前面 63 frames 的 vframe 不需要构建完整——只有被输出的 scope 才被解析]

**stack trace 的完整路径**:
```
thread→ frame0 (compiled, 3个 scope)
  scope[2]=C.qux (最内, bci=42) → _index=2
  scope[1]=B.baz (内联1, bci=12) → _index=1
  scope[0]=A.bar (最外, bci=8)  → _index=0
→ frame0.sender() → frame1 (interpreted)
  scope[0]=D.main (bci=25) → _index=0
→ frame1.sender() → frame2 (native, Main thread run)
  → at_end=true
```
- 关键设计: 每个 scope 返回一个 methodHandle+bci——JFR agent 问 "当前在哪个 Java method 的哪个位置"时拿到这些信息→转成 StackTraceElement[]

---

### 核心悬念

**"vframe 用 compiledVFrame 展开内联树(scope chain)→把 1 个物理帧分解为 N 个源级帧。vframeStream 通过 fill_from_frame→逐 next() 遍历完整调用栈。"** — 但 deopt 怎么用 vframeArray 重建解释器帧？下一篇: Deopt 重建 + GC 扫描。

> → [03-deopt-gc-scan.md](03-deopt-gc-scan.md)
