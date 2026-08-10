# 02. 参数解析 + 平台 JVM 加载

> 🟡 Working | 2 KP 中的参数+平台

### 1. "Wildcard + argfile"

场景: `java -cp "lib/*" MyMain` → wildcard.c 展开 lib/* → lib/a.jar, lib/b.jar...

**Wildcard + argfile** (`libjli/wildcard.c:40-200 + args.c:40-300`):
```
wildcard.c: expand "lib/*" → ls lib/ (directory) → append *.jar files
args.c:     @argfile support (read file→expand lines as args)
```
- 源码: `libjli/wildcard.c:40-200` + `libjli/args.c:40-300`

### 2. "JVM 变体选择"

场景: jvm.cfg → `-server` → server/libjvm.so → dlopen

**CreateExecutionEnvironment** (`unix/libjli/java_md_solinux.c:300-800`):
```
jvm.cfg: -server KNOWN → lib/server/libjvm.so → dlopen → dlsym(JNI_CreateJavaVM)
```
- 源码: `unix/libjli/java_md_solinux.c:300-800`

---

### 核心悬念

**"Wildcard 展开 classpath/* → jar files。jvm.cfg 选择 server/client 变体→dlopen。"** — 下一篇: 域41 ZIP & JIMAGE。

> → 域41 ZIP & JIMAGE
