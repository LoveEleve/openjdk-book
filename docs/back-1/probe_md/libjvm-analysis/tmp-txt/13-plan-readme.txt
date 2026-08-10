Plan and write README.md for phase 13-launcher (libjli.so). Two-step process: FIRST verify source code, THEN write README with verified content.

## Phase context
This is the PREQUEL to 01-jvm-startup. The reader knows Threads::create_vm() from 01. Now they learn what happens BEFORE: how a shell command (`java -jar app.jar`) becomes a JVM process calling JNI_CreateJavaVM().

## Step 1: Verify source code (MANDATORY — must complete before Step 2)

### Read and report on these files

**Core entry** (`java.base/share/native/libjli/java.c`):
1. Find `JLI_Launch()` — this is the main() of libjli. Report: line number, function signature, parameters. What is the FIRST thing it does? What is the LAST thing before the JVM starts?
2. Find `LoadJavaVM()` — line number, what `dlopen()` call does it make? What happens if `dlopen()` fails?
3. Find `LoadMainClass()` — how does it call FindClass? After JNI_CreateJavaVM succeeds, what's the next step?

**Argument parsing** (`java.base/share/native/libjli/args.c`):
4. Find `ParseArguments()` — how does it separate JVM options (-Xms, -Dkey=value) from application arguments?
5. How does `-jar` flag change the execution path vs `-cp`?
6. How does wildcard expansion work? (Classpath with `*.jar` → expand to individual JARs)

**JVM loading** (`java.base/unix/native/libjli/java_md_solinux.c`):
7. Find `SetJREPath()` or `SetPaths()` — how does libjli find the jre/lib/ directory? Does it use `/proc/self/exe` or `JAVA_HOME`?
8. Find the `dlopen()` call that loads libjvm.so — exact file path pattern, what suffix (`.so` on Linux)?
9. Find the `dlsym()` call that resolves `JNI_CreateJavaVM` — what function pointer type?
10. What error messages are returned when libjvm.so is not found?

**JAR manifest** (`java.base/share/native/libjli/manifest_info.h`):
11. How does libjli parse META-INF/MANIFEST.MF? What does it extract? (Main-Class attribute, Class-Path attribute)

### Report format for each finding
```
Function: JLI_Launch() at java.c:XXX
Signature: int JLI_Launch(int argc, char **argv, ...)
First action: ParseArguments at line XXX
Last action before JVM: LoadJavaVM at line XXX
Path after JVM: LoadMainClass at line XXX → CallStaticVoidMethod at line XXX
```

### Verify these production scenarios with actual error messages from source
- "Could not find libjvm.so" → grep source for exact error string format
- "Could not find or load main class" → grep source for exact error string format
- "Too many arguments" / wildcard overflow → check limits in source

---

## Step 2: Write README.md (after Step 1 reports are complete)

Write to: probe_md/13-launcher/README.md. Target: 500+ lines.

### Quality mandate
- **Depth**: Every claim backed by Step 1 verified source line numbers. No hand-waving.
- **Breadth**: Cover ALL aspects of the launcher: parsing→JVM loading→main class loading→error handling.
- **Interview**: Every interview question must have a concrete answer with 1-2 source lines as evidence.
- **Continuity**: Explicit § connection to 01-jvm-startup §一 (JNI_CreateJavaVM). Show where libjli HANDS OFF to libjvm.
- **First principles**: For each design decision, start from "if you designed this from scratch..." and derive the libjli approach.
- **Beginner**: Define dlopen, dlsym, /proc/self/exe the first time they appear. Explain WHY libjli exists as a separate .so.

### Required sections

#### §〇 上手指南
- 3-tier reading paths (入门/进阶/专家)
- Prerequisite: 01-jvm-startup §一 (JNI_CreateJavaVM entry)
- 3-sentence essence: "bash$ java Main → libjli.so's JLI_Launch() → parse args → find libjvm.so → dlopen → call JNI_CreateJavaVM → load Main.class → call main(). This 0.05s is the gateway to everything you learned in 01-12."
- Core terminology table: JLI, dlopen, dlsym, /proc/self/exe, JavaVMInitArgs, manifest, classpath wildcard
- Environment prep: compile libjli from source, GDB attach to `java` process

#### §一 The `java` Command Lifecycle (verified ASCII diagram)
Based on Step 1 source reading. Must show:
- `bash$ java -Xms8g -jar app.jar`
- → `JLI_Launch()` at java.c:XXX
- → `ParseArguments()` at args.c:XXX (separates JVM opts from app args)
- → `SetJREPath()` at java_md_solinux.c:XXX (finds jre/lib/<arch>/server/)
- → `LoadJavaVM()` at java.c:XXX → `dlopen("libjvm.so")` at java_md_solinux.c:XXX
- → `dlsym("JNI_CreateJavaVM")` at java_md_solinux.c:XXX
- → `JNI_CreateJavaVM()` call → NOW inside 01-jvm-startup territory
- → `LoadMainClass()` at java.c:XXX → `FindClass(mainClassName)` (first Java class loaded!)
- → `GetStaticMethodID(main, "main", "([Ljava/lang/String;)V")`
- → `CallStaticVoidMethod(mainClass, mainMethod, args)` → ENTERS JAVA

Every step has source file:line from Step 1 verification.

#### §二 First-Principles Design Decisions (≥5)
Derive from Step 1 findings:

1. **Why dlopen() instead of static linking?** "libjvm.so is ~20MB. Static linking: every `java` invocation = 20MB executable. Dynamic: 30KB libjli + 20MB shared lib → OS shares libjvm.so across all JVM processes → ~90% memory savings for multi-JVM deployments."

2. **Why /proc/self/exe instead of JAVA_HOME?** "JAVA_HOME requires explicit env setup. /proc/self/exe is a Linux kernel-provided symlink to the ACTUAL binary — zero configuration, always correct even with symlinks."

3. **Why separate JLI_Launch() from main()?** "main() in the `java` binary is a 5-line wrapper. JLI_Launch() in libjli.so is the real entry. This separation allows the same `java` binary to support different JRE versions (select server vs client at dlopen time)."

4. **Why parse -Xms/-Xmx in BOTH libjli and libjvm?** "libjli: early validation (exit immediately if flag is garbage, don't waste time loading libjvm). libjvm: actual heap sizing. Two-pass parsing = fail fast + correct execution."

5. **Why find libjvm.so by searching JRE directory tree?** "JDK layout varies by platform. Linux: jre/lib/<arch>/server/libjvm.so. macOS: ../lib/server/libjvm.dylib. Searching abstracts platform differences behind libjli."

#### §三 Source Files Table
Verified file paths from Step 1:
| File | Full Path | Lines | Role |
|------|-----------|:---:|------|
| java.c | java.base/share/native/libjli/ | ~1400 | JLI_Launch, LoadJavaVM, LoadMainClass |
| args.c | ... | ~600 | ParseArguments, JVM/App arg separation |
| java_md_solinux.c | ... | ~1100 | dlopen, dlsym, /proc/self/exe |
| etc. | | | |

#### §四 Document Plan (3-4 docs)
Based on Step 1 analysis:
1. **00-Libjli-Overview.md** — Full JLI_Launch() trace with all source line numbers. The "from bash to JNI_CreateJavaVM" document.
2. **01-Argument-Parsing.md** — ParseArguments() deep-dive. How -X/-D/-jar/-cp are separated. Wildcard expansion.
3. **02-JVM-Loading.md** — Finding and loading libjvm.so. dlopen, dlsym, JRE discovery, platform-specific paths.
4. **03-Main-Class-Loading.md** — JAR manifest parsing. FindClass → GetStaticMethodID → CallStaticVoidMethod. Error diagnosis.

Each doc spec: core ❓ question, production scenario, source files, prerequisites, scope boundaries.

#### §五 Interview Questions (≥6)
Every question with verified source line evidence from Step 1:

| Question | Doc | Verified Answer |
|----------|-----|-----------------|
| "What happens between `java MyClass` and main()?" | 00 | JLI_Launch at java.c:XXX → ParseArguments at args.c:XXX → SetJREPath at java_md_solinux.c:XXX → LoadJavaVM at java.c:XXX → dlopen at java_md_solinux.c:XXX → JNI_CreateJavaVM → LoadMainClass at java.c:XXX → FindClass → CallStaticVoidMethod at java.c:XXX |
| "How does java find libjvm.so?" | 02 | /proc/self/exe at java_md_solinux.c:XXX → walk up directories → jre/lib/<arch>/server/libjvm.so → dlopen at java_md_solinux.c:XXX |
... (4 more) |

#### §六 Production Scenarios (≥4)
With real error message strings from Step 1:

| Scenario | Symptom (exact string from source) | Doc | Diagnostic |
|----------|-------------------------------------|-----|-----------|
| "libjvm.so not found" | Exact error from java_md_solinux.c | 02 | Check JAVA_HOME, check /etc/alternatives |
... (3 more) |

#### §七 Quality Audit Matrix
3-4 planned docs, honest pre-ratings (they haven't been written yet — mark as planned)

#### §八 Deep Questions (≥12, first-principles, 5 tiers)
1. "If you designed the java launcher, would you use dlopen or static linking? How does your choice affect multi-JVM deployments?"
2. "Why does libjli parse -Xms BEFORE JNI_CreateJavaVM is called? The JVM parses it again anyway — what was the original design reason?"
3. "How would you debug 'Error: Could not find or load main class'? Trace from JLI_Launch to the exact FindClass call that returns null — what could go wrong at each step?"
4. "The `java` binary on Linux is often a shell script. How does libjli handle this indirection? Would /proc/self/exe point to the shell script or the actual binary?"
5. "If you wanted to implement a custom JVM (e.g., GraalVM's launcher replacing libjvm.so with libgraalvm.so), what would you need to change in libjli?"
...

#### §九 Cross-Phase Connections
| Phase | Connection |
|-------|-----------|
| 01-jvm-startup §一 | libjli's JNI_CreateJavaVM call is the EXACT entry point of 01's §一 |
| 02-class-loading | libjli's LoadMainClass → FindClass is the FIRST class loading in the JVM's life |
| 14-zip-jimage | libjli parses -jar → 14 handles actual JAR/ZIP file reading |

## Step 3: Verify README against source
After writing: run rg to re-verify every line number and error message string. Report any discrepancies.

## Output
probe_md/13-launcher/README.md (500+ lines, all source claims verified)
