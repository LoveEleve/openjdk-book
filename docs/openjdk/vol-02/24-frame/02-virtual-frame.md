# 02. 编译代码内联了 3 层——怎么看到源级方法？— Virtual Frame

> **前置依赖**:[24-frame/01 — Physical Frame](01-physical-frame.md):frame 五字段与 sender 链是这一篇的地基,scopes_data 就存在 nmethod 里;[16-code-cache/02 — nmethod 结构](openjdk/vol-02/16-code-cache/02-nmethod-structure.md):PcDesc/作用域数据在 nmethod 里的位置
> → **后续**:[24-frame/03 — Deopt 重建 + GC 扫描](03-deopt-gc-scan.md):反优化要拿 vframe 的 locals 重建解释器帧
> 关联域: 16-code-cache(scopeDesc 生成)、22-deopt(vframeArray 消费)、32-jfr(栈采样消费)

## 一个物理帧,三层方法,怎么数?

[实证:] 同一个程序两种视图(24-inline-demo.txt,main→bar→baz→qux 三层调用): 编译日志里 `InlineDemo::baz inline` → `qux inline` → `bar inline` 层层嵌套——C2 把三层方法内联进了 main 的编译单元;而 `jcmd Thread.print` 的 main 线程只有一行 `at InlineDemo.main`(第 9 行的 sleep)——**内联的 bar/baz/qux 在物理栈上根本不存在**,它们只是 main 这个 nmethod 里的一段机器码。但 GC 反优化、JFR 采样、调试器都要"当前在哪个源级方法"——物理帧回答不了。这一篇拆 vframe: 怎么把 1 个物理帧展开成 N 个源级帧。

## 1. vframe: 物理帧的"源级切片"

### 类层次: 没有 nativeVFrame

vframe 是 ResourceObj(资源区分配,随 ResourceMark 释放),持有一个物理帧的副本和它的 RegisterMap(vframe.hpp:54-58)。子类家族(vframe.hpp:107-238): javaVFrame(:107,method/bci/locals/expressions/monitors 五个纯虚访问器 :110-115)→ interpretedVFrame(:160)与 compiledVFrame;另一支 externalVFrame(:204)→ entryVFrame(:217,Java 调 C 的桥帧)。

**大纲说的 nativeVFrame 不存在**(编造): JNI native 方法帧的 pc 也落在 nmethod 里(01 篇讲过 is_native_method),走 compiledVFrame,只是 scope 为 NULL、method/bci 直接从 nmethod 取(vframe_hp.cpp:267-276,注释 "native nmethods have no scope the method is implied")。

### 工厂: new_vframe 按帧类型造对象

vframe::new_vframe(vframe.cpp:70-94,截取核心,逐字):

```cpp
// vframe.cpp:70-94(截取核心,逐字)
vframe* vframe::new_vframe(const frame* f, const RegisterMap* reg_map, JavaThread* thread) {
  // Interpreter frame
  if (f->is_interpreted_frame()) {
    return new interpretedVFrame(f, reg_map, thread);
  }

  // Compiled frame
  CodeBlob* cb = f->cb();
  if (cb != NULL) {
    if (cb->is_compiled()) {
      CompiledMethod* nm = (CompiledMethod*)cb;
      return new compiledVFrame(f, reg_map, thread, nm);
    }

    if (f->is_runtime_frame()) {
      // Skip this frame and try again.
      RegisterMap temp_map = *reg_map;
      frame s = f->sender(&temp_map);
      return new_vframe(&s, &temp_map, thread);
    }
  }

  // External frame
  return new externalVFrame(f, reg_map, thread);
}
```

解释器帧 → interpretedVFrame(1 物理 = 1 虚拟);编译帧 → compiledVFrame(runtime stub 帧递归跳过);其余 → externalVFrame。

### compiledVFrame: scope 链 = 内联树

编译帧的虚拟化核心是 ScopeDesc。构造时按 pc 取作用域(vframe_hp.cpp:236-245,截取核心,逐字):

```cpp
// vframe_hp.cpp:236-245(截取核心,逐字)
compiledVFrame::compiledVFrame(const frame* fr, const RegisterMap* reg_map, JavaThread* thread, CompiledMethod* nm)
: javaVFrame(fr, reg_map, thread) {
  _scope  = NULL;
  _vframe_id = 0;
  // Compiled method (native stub or Java code)
  // native wrappers have no scope data, it is implied
  if (!nm->is_compiled() || !nm->as_compiled_method()->is_native_method()) {
      _scope  = nm->scope_desc_at(_fr.pc());
  }
}
```

scope_desc_at(compiledMethod.cpp:218-226)是 pc → 内联树入口: nmethod 里有一张 PcDesc 表(每个 pc 区间对应一段作用域数据),取 pc 对应的 scope_decode_offset,解码出第一个 ScopeDesc。ScopeDesc(method/bci + 指向 caller 的 sender_decode_offset,scopeDesc.hpp:60-108)是一个**单向链表**,每个节点 = 一层内联: scope_desc_at 拿到最内层,scope->sender()(scopeDesc.cpp:152)一层层向外直到 is_top(:148)。

**关键设计 (斜体)**: *内联树不额外存储,编译时就把"每段 pc 属于哪层作用域"压缩进 nmethod 的 scopes_data——pc 是运行时唯一的钥匙,ScopeDesc 是编译期写好的索引。所以编译帧的 locals/expressions 也不是直接读栈,而是 ScopeDesc 里的 ScopeValue 描述(location 编码: 栈槽/寄存器/常数值),要值时才按描述去取。*

### sender: 虚拟层与物理层接力

compiledVFrame::sender(vframe_hp.cpp:304-319,截取核心,逐字):

```cpp
// vframe_hp.cpp:304-319(截取核心,逐字)
vframe* compiledVFrame::sender() const {
  const frame f = fr();
  if (scope() == NULL) {
    // native nmethods have no scope the method/bci is implied
    nmethod* nm = code()->as_nmethod();
    assert(nm->is_native_method(), "must be native");
    return vframe::sender();
  } else {
    return scope()->is_top()
      ? vframe::sender()
      : new compiledVFrame(&f, register_map(), thread(), scope()->sender(), vframe_id() + 1);
  }
}
```

两段式: scope 不是最外层 → `new compiledVFrame(scope()->sender())`,同一物理帧内向上走一层内联;scope 是最外层(或 native)→ 交回 `vframe::sender()`(vframe.cpp:103-108)——`_fr.real_sender()` 沿**物理**帧链走到 caller,再 new_vframe 构造下一物理帧的虚拟层。interpretedVFrame 的 sender 直接就是物理帧的 sender(1:1)。

**关键设计 (斜体)**: *两个 sender 语义不同、串行接力: compiledVFrame::sender 走"虚拟链"(内联树),vframe::sender 走"物理链"(01 篇的 frame::sender)。顶层入口 vframe::top()(vframe.cpp:110-116)从任意层沿 sender 走到最内层——"这个物理帧当前在哪个方法"的答案。*

## 2. vframeStream: 一次遍历整条调用栈

### 状态机: mode + decode_offset

vframeStream 没有把全部 vframe 预先建好——它是个**惰性迭代器**: vframeStreamCommon(vframe.hpp:268-330)只存当前物理帧(_frame)、模式(_mode: interpreted/compiled/at_end, :274)和缓存的方法/bci(_method/_bci :279-280)。构造(vframe.inline.hpp:51-64)从 `_thread->last_frame()` 起步,fill_from_frame 失败就沿物理 sender 找第一个 Java 帧。

### next(): 先虚拟后物理

next(vframe.inline.hpp:41-49,截取核心,逐字):

```cpp
// vframe.inline.hpp:41-49(截取核心,逐字)
inline void vframeStreamCommon::next() {
  // handle frames with inlining
  if (_mode == compiled_mode    && fill_in_compiled_inlined_sender()) return;

  // handle general case
  do {
    _frame = _frame.sender(&_reg_map);
  } while (!fill_from_frame());
}
```

每步最多两次尝试: 编译模式下先试 `fill_in_compiled_inlined_sender()`(:66-72)——读缓存的 _sender_decode_offset,若非序列化空值就原地解码**上一层内联**(_method/_bci 换成 caller 的),next 直接返回;**同一物理帧内向上走,不移动 _frame**。走到内联树顶后,fall through 到物理分支: `_frame = _frame.sender()` 再 fill_from_frame 找下一个 Java 帧。整条链: 内联层×N → 物理帧 → 内联层×M → 物理帧……直到 at_end。

fill_from_frame(vframe.inline.hpp:125-201)的分派: 解释器帧 → fill_from_interpreter_frame(:204-222,method/bcp→bci);编译帧 → native 方法走 fill_from_compiled_native_frame(:118-123),否则 pc_desc_at 找作用域解码偏移进 fill_from_compiled_frame(:75-114,从 scopes_data 流里读 sender_decode_offset/method/bci 三个字段);first 帧或 entry 帧 → at_end。

**关键设计 (斜体)**: *惰性到什么程度?fill_from_compiled_frame 只解码三个字段(method/bci/sender 偏移)——locals 那些 ScopeValue 根本不碰。JFR 采样栈轨迹时,只有被输出的 scope 才做完整解码。代价是 _bci 是"缓存",locals/expressions 这类重数据要另走 javaVFrame 接口。*

### 与 JFR/Thread.print 的关系

JFR 的栈轨迹采样(jfrStackTrace.cpp)和 `jcmd Thread.print` 的 Java 帧列表都是 vframeStream 的消费者——**jstack 里能看到的"每行一个方法"正是这个迭代器吐出来的**。实证里 InlineDemo 的线程转储只有 main 一行,不是 jstack 丢帧,而是物理帧里只有 main 的机器码;内联的三层要等 JFR 这类按 vframeStream 展开的消费者才现身。

## 3. 一张图串起来

```
线程栈(物理)                      虚拟层展开
frame_k(compiled: bar/baz/qux 内联)  compiledVFrame(scope=qux, 最内)
                                     compiledVFrame(scope=baz)
                                     compiledVFrame(scope=bar, 最外)
  frame_k.sender() → frame_k-1(解释器)  interpretedVFrame(main)
  frame_k-1.sender() → frame_k-2(native) compiledVFrame(scope=NULL, JNI)
```

vframeStream::next 的游标: (frame_k, qux) → (frame_k, baz) → (frame_k, bar) → (frame_{k-1}, main) → (frame_{k-2}, native) → at_end。每个 (帧, 层) 给出一对 method/bci——StackTraceElement 的材料。

## 核心悬念

vframe 把物理帧切成了源级切片: compiledVFrame 靠 nmethod 里编译期写好的 ScopeDesc 链展开内联树,虚拟 sender 与物理 sender 接力;vframeStream 用 mode+decode_offset 状态机惰性遍历整条栈,同一物理帧内只动缓存不动帧。这些源级信息(尤其 locals/monitors)最重的消费者还没出场: **反优化(deopt)**——C2 帧要退回解释器,必须用 vframeArray 把内联树和 locals 全量导出,在 C 堆重建解释器帧。下一篇: Deopt 重建 + GC 扫描。

> → [24-frame/03 — Deopt 重建 + GC 扫描](03-deopt-gc-scan.md)
