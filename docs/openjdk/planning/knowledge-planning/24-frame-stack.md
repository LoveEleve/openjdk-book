# 域 24: Frame & Stack Walking — 知识规划

> 源码路径: hotspot/share/runtime/frame.* + vframe.* + stackValue.* + monitorChunk.* + cpu/x86/frame_x86* + registerMap_x86*
> 源码量: 24 文件 / ~7,000 行 | 🟡 大域（GC/Deopt/JVMTI/JFR 共用基础设施）

## 01 逐源提取

| Source File | Inferred Mechanism | Confidence |
|------------|-------------------|------------|
| frame.hpp:50-101 + frame.cpp | **frame — 物理栈帧表示**: _sp(栈指针, from Thread::last_Java_sp), _pc(下条指令地址), _cb(CodeBlob 拥有者), _deopt_state(not_deoptimized/is_deoptimized/unknown), sender()(遍历上一层帧), oops_do(GC 遍历栈上 oop), 3 种帧类型(interpreter/compiled/native), patch_pc(IC 补丁) | High |
| frame.inline.hpp + cpu/x86/frame_x86.inline.hpp | **Frame 平台操作**: sender() 按帧类型分别处理(compiled→读 rbp chain/nmethod→返回 sender frame; interpreted→读 bcp+locals→返回 caller frame), frame::frame(构造从 sp/pc 反解帧类型) | High |
| cpu/x86/frame_x86.cpp | **x86 Frame 布局**: compiled frame(rbp based, callee-saved regs), interpreter frame(method+bcp+locals+monitors), native frame(no Java locals), sender_sp/sender_pc 计算 | High |
| vframe.hpp + vframe.cpp | **vframe — 虚拟栈帧(源级)**: 掩盖 inlining——一个 compiled frame 对应多个 vframe(每层 inline), compiledVFrame/javaVFrame/nativeVFrame/interpretedVFrame 四子类, bci()+method() 返回 Java 层信息 | High |
| vframe_hp.hpp + vframe_hp.cpp | **vframeStream — 栈帧遍历流**: 一次性从 frame stream 提取 vframe 链, 用于 GC/Deopt/JFR, fill_from_frame(从帧填 stream buffer) | High |
| vframeArray.hpp + vframeArray.cpp | **vframeArray — 虚拟帧数组(deopt 用)**: 从 compiled frame 提取内联树→存为 C-heap array→deopt unpack 时重建解释器帧, apply/lock_monitors/unlock_monitors | High |
| stackValue.hpp + stackValue.cpp | **StackValue — 栈值表示**: _type(T_INT/FLOAT/LONG/DOUBLE/OBJECT/RETURNADDR), _integer_value/_handle_value, create_stack_value 从 frame 读值 | Medium |
| stackValueCollection.hpp + stackValueCollection.cpp | **StackValueCollection — 栈值集合**: 方法调用表达式栈的表示, add/iterator/print | Low |
| monitorChunk.hpp + monitorChunk.cpp | **MonitorChunk — 监控器块**: deopt unpack时分配的 off-stack monitor 块, 用于 synchronized 方法/块的监视器恢复 | Medium |
| rframe.hpp + rframe.cpp | **rframe — Resource Frame**: ResourceMark 帧, print 信息 | Low |
| extendedPC.hpp | **extendedPC**: PC+返回地址组合, 用于 deopt frame 匹配 | Low |
| cpu/x86/registerMap_x86.hpp + registerMap_x86.cpp | **RegisterMap — 寄存器映射**: 保存 callee-saved register 的快照, x86 下包含 rbp/rsp/rdi/rsi/rbx/r12-r15, GC 遍历用 | Medium |

*12 个知识点*

## 02 聚合

### P1 — 系统级共识
| KP | 出现文件 |
|----|---------|
| Frame 层次(frame→vframe) + sender 栈遍历 | frame.*, vframe.*, cpu/x86/frame_x86*, registerMap* |
| vframeArray deopt 重建管线 | vframeArray.*, vframe.*, deoptimization.hpp(消费方) |

### P2 — 局部重要
| KP | 出现文件 |
|----|---------|
| StackValue 栈值表示 | stackValue.*, stackValueCollection.*, vframe.cpp(create from frame) |
| MonitorChunk off-stack monitor | monitorChunk.*, synchronizer.*(消费方) |

### P3 — 孤立
| KP | 文件 |
|----|------|
| rframe (Resource Frame) | rframe.* |
| extendedPC | extendedPC.hpp |

## 03 深度分类

### 🔴 Deep — 核心设计决策 (3 KP)
| KP | 为什么 🔴 |
|----|---------|
| frame → vframe 双层抽象 | frame 代表物理栈帧(sp+pc)——不同编译器(C1/C2)生成不同的物理帧格式。vframe 代表源级帧——隐藏 inlining、编译版本差异、解释器 vs 编译。GC 用 frame(oops_do 遍历 oop)、deopt 用 vframe(需源级信息重建栈)、JFR 用 vframeStream(采样栈 trace) |
| sender() 栈帧遍历链 | 帧链是一个单向链表——frame::sender() 根据 pc 反查 CodeBlob→判断帧类型→读对应格式的 sender_sp/sender_pc→构造上一帧 frame。x86 编译帧用 rbp chain，解释器帧用 sender_sp offset，native 帧用 java_frame_anchor()。这是 GC/JVMTI/JFR 的公共基础设施 |
| vframeArray deopt 重建 | deopt 时从 compiled frame 提取内联树→存为 vframeArray→alloc frame+copy locals→pop monitor frame→切解释器。vframeArray 是 deopt 的核心数据结构——存编译帧的全部源级信息供解释帧重建 |

### 🟡 Working — 有设计但非核心 (3 KP)
| KP | 说明 | 为什么 🟡 非 🔴 |
|----|------|------|
| StackValue 栈值表示 | 5 种类型(T_INT/FLOAT/LONG/DOUBLE/OBJECT)——从 frame 提取值供 deopt monitor 恢复 | deopt 的辅助数据结构 |
| RegisterMap 寄存器快照 | 保存 callee-saved 寄存器值——GC 遍历栈时如果有 oop 在寄存器中→需要知道在哪 | GC 的辅助——了解 frame 不需要理解 RegisterMap |
| MonitorChunk off-stack monitor | deopt unpack时分配的 monitor 块——不在帧内→在 C-heap→通过 MonitorChunk 链表管理 | deopt 的辅助分配 |

### 🟢 Surface — 了解即可 (2 KP)
| KP | 说明 |
|----|------|
| rframe (Resource Frame) | ResourceMark 调试 |
| extendedPC | PC+return address 组合 |

## 04 聚类 — 文章拆分: 3篇

| 篇 | 标题 | 覆盖 KP | 核心问题 |
|:--:|------|:--:|------|
| 1 | Physical Frame — 物理栈帧 | frame 结构(sp/pc/cb), 4种帧类型(interp/compiled/native/C), sender() 遍历, x86 帧布局 | "JVM 怎么表示一个栈帧？怎么从当前帧找到 caller？" |
| 2 | Virtual Frame — 源级栈帧 | vframe 层次(四种虚拟帧), vframeStream 遍历, inlining 反掩, bci/method/oop 查询 | "编译代码内联了 3 层——怎么看到源级方法的栈？" |
| 3 | Deopt 重建 + GC 栈扫描 | vframeArray 提取内联树, StackValue 值提取, MonitorChunk off-stack 监视器, oops_do GC 扫描, RegisterMap 寄存器快照 | "deopt 怎么从编译帧重建解释器帧？GC 怎么扫描栈上的 oop？" |
