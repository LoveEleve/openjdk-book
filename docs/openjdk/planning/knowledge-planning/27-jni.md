# 域 27: JNI — 知识规划

> 源码路径: hotspot/share/prims/jni.* + runtime/jniHandles.* + prims/jniFastGetField.* + prims/jniCheck.* + cpu/x86/jniFastGetField_x86*
> 源码量: 16 文件 / ~8,000 行 | 🟡 大域

## 01 逐源提取

| Source File | Inferred Mechanism | Confidence |
|------------|-------------------|------------|
| jniHandles.hpp/cpp/inline.hpp | **JNIHandles — Handle 存储与解析**: global/weak_global handles(OopStorage backed), local handles(per-thread JNIHandleBlock linked list), make_local/make_global/destroy_global, resolve(handle→oop), weak_tag(1-bit offset区分 jweak), is_same_object | High |
| jni.cpp (4463行) | **JNI 函数表 (~200函数)**: JNI_GetDefaultJavaVMInitArgs, JNI_CreateJavaVM, GetVersion, DefineClass, FindClass, GetStaticMethodID, Call<Type>Method系列, Get/Set<Type>Field系列, NewObject, New<Type>Array, MonitorEnter/Exit, 异常处理, 引用创建/删除, 反射支持 | High |
| jniFastGetField.hpp/cpp + cpu/x86/jniFastGetField_x86_64.cpp | **jniFastGetField — 快路径字段读取**: GetIntField/GetFloatField 等 bypass JNI call overhead(节省 ~100 cycles), safepoint counter check(偶=无safepoint→直接读, 奇=在safepoint→走慢路径), JNI_FastGetField 快路径 stub | High |
| jniCheck.hpp/cpp | **jniCheck — JNI 校验**: DEBUG模式检查 JNI 调用合法性(参数非null, 类型正确, JNIEnv 匹配线程), `check_jni_initialized/throwing_exception` | Medium |
| jniExport.hpp + jniPeriodicChecker.* | **JNI 导出 + 周期性检查**: jniExport(声明所有 JNI 函数 extern导出), jniPeriodicChecker(WatcherThread定期校验) | Low |
| cpu/x86/jniTypes_x86.hpp | **jniTypes — x86 JNI 类型映射**: jobject→oop 转换, 64-bit word layout | Low |

*6 知识点*

## 02 聚合 — P1/P2/P3

### P1 (≥5)
| KP | 出现文件 |
|----|---------|
| JNI Handle 系统 (global/local/weak + resolve) | jniHandles.*, jni.cpp(JNI 引用函数), OopStorage(域25) |

### P2 (2-4)
| KP | 出现文件 |
|----|---------|
| jniFastGetField 快路径 | jniFastGetField.*, cpu/x86/jniFastGetField_x86_64.cpp, safepoint.hpp(counter) |
| JNI 函数表 dispatch | jni.cpp, jniExport.hpp, jni.h(JDK侧接口定义) |

### P3 (1-2)
| KP | 文件 |
|----|------|
| jniCheck 调试 | jniCheck.* |
| jniPeriodicChecker | jniPeriodicChecker.* |

## 03 深度分类

### 🔴 Deep (2 KP)
| KP | 为什么 🔴 |
|----|---------|
| JNIHandles 三层存储(global/local/weak) + OopStorage | JNI 的核心——Java↔Native 的对象引用管理。global handle 存在 OopStorage(域25,无锁并发存储)中, GC 必须标记它们。local handle 在线程的 JNIHandleBlock 链表中(per-thread,无全局分配开销)。weak_global handle 用 1-bit tag 区分(weak_tag_value=1→地址+1→GC 可选清理)。resolve 是*解引用: jobject → oop → GC safe。三重存储解决不同生命周期: global=跨Native调用, local=仅当前Native调用, weak=GC可选清理 |
| jniFastGetField — safepoint counter优化 | JNI GetIntField 正常路径~200 cycles(查JNIEnv→check thread→call JNI function→find oop→read field)。Fast path 仅 ~30 cycles: check safepoint_counter 偶数→直接读 field→返回。counter 偶数=无safepoint→安全直接读。奇数=有safepoint→走慢路径(需要 GC safe handle resolve)。x86_64 stub: test safepoint_counter+mov from field+ret, ~6 instructions |

### 🟡 Working (2 KP)
| KP | 说明 | 为什么 🟡 |
|----|------|------|
| JNI 函数表 (~200函数) | GetVersion/FindClass/NewObject/CallMethod/GetField系列——标准 JNI API实现 | 是规范映射——每个函数实现相对简单 |
| jniCheck 校验 | DEBUG 参数校验 | 调试辅助——不影响正确行为 |

### 🟢 Surface (2 KP)
| KP | 说明 |
|----|------|
| jniExport | extern 函数声明 |
| jniPeriodicChecker | 周期性 JNI 检查 |

## 04 聚类 — 3篇

| 篇 | 标题 | 核心问题 | 预估 |
|:--:|------|------|:--:|
| 1 | JNI Handle 系统 | "jobject 在 JVM 内部怎么存的？global/local/weak 三层有什么区别？" | 核心 |
| 2 | JNI 函数调用 + Fast Path | "JNI GetIntField 正常 200 cycles→Fast path 怎么做到 30 cycles？" | 核心 |
| 3 | JNI 校验 + 平台层 | "JNI 调用参数错了——JVM 怎么检测？debug vs release 有什么区别？" | 深度 |
