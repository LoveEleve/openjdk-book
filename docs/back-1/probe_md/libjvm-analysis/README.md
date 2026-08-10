# libjvm.so 深度分析文档目录

> 方法论：程序 = 数据结构 + 算法
> 数据源：源码插桩日志（132个 .cpp 文件，~580 探针）
> 目标：成为世界第一懂 JVM 的人

---

## 目录结构

```
probe_md/
├── 01-jvm-startup/        JVM 启动与初始化
├── 02-class-loading/      类加载子系统
├── 03-object-model/       对象模型 (OOP)
├── 04-interpreter/        解释器执行引擎
├── 05-jit-compiler/       JIT 编译器 (C1/C2)
├── 06-gc-memory/          GC 内存管理
├── 07-thread-lock/        线程与锁
├── 08-safepoint/          Safepoint 机制
├── 09-native-interface/   JNI/JVMTI/Reflection
├── 10-services-diag/      服务与诊断
├── 11-os-layer/           操作系统层
├── 12-cpu-layer/          CPU 平台层
└── tmp-file/              GDB 脚本/临时文件
```

---

## 写作顺序（按依赖关系）

| 顺序 | 章节 | 预计文档数 | 状态 |
|------|------|-----------|------|
| 1 | 01-jvm-startup | 3-5 篇 | ⬜ |
| 2 | 02-class-loading | 5-8 篇 | ⬜ |
| 3 | 03-object-model | 5-8 篇 | ⬜ |
| 4 | 06-gc-memory | 10-15 篇 | ⬜ |
| 5 | 07-thread-lock | 5-8 篇 | ⬜ |
| 6 | 08-safepoint | 3-5 篇 | ⬜ |
| 7 | 04-interpreter | 3-5 篇 | ⬜ |
| 8 | 05-jit-compiler | 5-8 篇 | ⬜ |
| 9 | 09-native-interface | 3-5 篇 | ⬜ |
| 10 | 10-services-diag | 3-5 篇 | ⬜ |
| 11 | 11-os-layer | 2-3 篇 | ⬜ |
| 12 | 12-cpu-layer | 2-3 篇 | ⬜ |

**总计预计：50-80 篇深度分析文档**

---

## 标准测试环境

```bash
JVM: build/linux-x86_64-normal-server-slowdebug/jdk/bin/java

# 快速测试（默认）- 512MB 堆，1MB Region
export JVM_QUICK="-Xms512m -Xmx512m -XX:+UseG1GC -Xint"

# 深度分析 - 1GB 堆，2MB Region（可观察 Mixed GC）
export JVM_DEEP="-Xms1g -Xmx1g -XX:+UseG1GC -Xint"

# 插桩日志
export PROBE_GC="-Xlog:probe_gc=debug"
export PROBE_RUNTIME="-Xlog:probe_runtime=debug"
export PROBE_ALL="-Xlog:probe_gc=debug,probe_runtime=debug,probe_oop=debug,probe_class=debug,probe_interp=debug,probe_jit=debug,probe_jni=debug"

# 文件日志（早期启动阶段）
export PROBE_FILE="/tmp/jvm_instrument_\$(pidof java).log"

# 典型用法
$JAVA $JVM_QUICK $PROBE_GC -cp demo.jar com.example.Main 2>&1 | tee gc.log
```

## Region 大小速查

| 堆大小 | Region 大小 | Region 数 | Humongous 阈值 |
|--------|-----------|----------|---------------|
| 512MB | 1MB | 512 | 512KB |
| 1GB   | 2MB | 512 | 1MB |
| 4GB   | 2MB | 2048 | 1MB |
| 8GB   | 4MB | 2048 | 2MB |

