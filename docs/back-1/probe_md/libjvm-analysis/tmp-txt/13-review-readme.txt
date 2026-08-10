Deep-review 13-launcher/README.md (~510 lines). This is the FIRST extension phase — the prequel to 01-jvm-startup. The quality standard is the same as 01-12 READMEs.

## Benchmark READMEs
- 01-jvm-startup/README.md (452 lines, retrofitted to ~56/55)
- 04-interpreter/README.md (528 lines, 55+/60)
- 05-jit-compiler/README.md (667 lines, ~56/60)

## Phase context (continuity check)
13 is the PREQUEL to 01. The reader finished all 12 phases starting at JNI_CreateJavaVM. Now they go BACK — to the `java` command itself. The README must explicitly answer: "Phase 01 starts at JNI_CreateJavaVM(). Phase 13 starts earlier — at `bash$ java`. Together they form the COMPLETE startup story."

---

## 1. Document Plan Quality — 15 pts

The §四 doc plan is the heart of the README — it defines WHAT will be written. A weak §四 = weak docs.

### Check each of 4 docs:

**00-Libjli-Overview.md** (currently in §四):
- Is the core question FRAMED as a problem the reader has? "`java MyClass` 到 `JNI_CreateJavaVM` 的完整调用链" — this is a DESCRIPTION, not a question. Better: "你在 shell 里敲了 `java -jar app.jar`，到 JVM 调用 `JNI_CreateJavaVM()` 之前——这 0.05 秒发生了什么？每一步的源码入口在哪？"
- Is the production scenario SPECIFIC? "排查 '不能启动 JVM' 的所有可能根因" — too vague. Better: "凌晨 3 点发布系统报 'Error: Could not create the Java Virtual Machine' → 你的 CI/CD pipeline 阻塞 → 你需要从 JLI_Launch 源码中定位到底是 dlopen 失败还是 JNI_CreateJavaVM 返回错误。"
- Are source files listed with FULL PATHS? "java.c、java_md_solinux.c" — no paths. Every other phase README has full paths.
- Are scope boundaries clear? "不包含：JNI_CreateJavaVM 内部（那是 01 的范畴）" — good. Also needs: "不包含：JAR/ZIP 文件格式解析（那是 14-zip-jimage 的范畴）"

**01-Argument-Parsing.md**:
- Same checks: core question → problem-framed? Production scenario specific? Source files with paths?
- Missing: How does `-jar` vs `-cp` vs `-m` (module) change the LaunchMode? This is a design decision with interview value.

**02-JVM-Loading.md**:
- Missing: The `stat()` call that VERIFIES libjvm.so exists before dlopen. This is a key reliability design decision.
- Missing: What happens if jvm.cfg has multiple entries (-server, -client, -minimal)? How does libjli choose?

**03-Main-Class-Loading.md**:
- Missing: Why does libjli use `sun.launcher.LauncherHelper.checkAndLoadMain()` instead of directly calling `FindClass()`? This is a design decision that avoids JNI complexity for error handling.

### Scoring:
13-15: all 4 docs have problem-framed questions, specific production scenarios, full file paths, clear scope boundaries
10-12: 3/4 docs meet standard
7-9: docs exist but are thin (descriptions not questions, vague scenarios)
4-6: incomplete doc plan
1-3: no real doc plan

---

## 2. Interview Questions Quality — 10 pts

### Check each of 6 questions:

**Q1: "`java MyClass` 和 `main()` 之间发生了什么？"**
- Is the answer a STORY or a list? Current format: long chain of file:line → file:line. This is a list, not a story. A story would be: "First, JLI_Launch at java.c:219 parses your command line — it separates `-Xms8g` (JVM flag) from `app.jar` (your application). Then it finds libjvm.so — hunting through /proc/self/exe to locate the JRE installation..."
- Is the 13 CONTEXT clearly separated from the 01 context? "libjli handles steps 1-6 (0.05s). Then 01 takes over from step 7 (JNI_CreateJavaVM, ~2s)."
- Missing: A mermaid diagram showing the split between 13 and 01 responsibilities.

**Q2: "java 是如何找到 libjvm.so 的？"**
- Current answer is dense with line numbers but reads like a source trace, not an interview answer.
- Missing: WHY this approach? "Because `java` might be a symlink — /proc/self/exe resolves to the actual binary, then walks up to find jre/lib/."

**Q3: "`-jar` 和 `-cp` 的执行路径有什么不同？"**
- Good: concrete differences mentioned (mode=LM_JAR, SetClassPath overwrites). But the answer is TOO LONG for an interview response. Needs a 2-sentence summary first, then "Would you like me to go deeper?"
- Missing: The LaunchMode enum values. LM_CLASS=1, LM_JAR=2, LM_MODULE=3, LM_SOURCE=4 — this is the KEY to understanding the difference.

**Q4: "classpath 通配符 `*` 是何时展开的？"**
- Good: specific line numbers, opendir/readdir mechanism.
- Missing: Performance implication — "opendir on a directory with 1000 JARs takes ~2ms. This is why large classpaths slow startup." Quantified impact.

**Q5: "为什么 libjli 要在新线程中启动 JVM？"**
- Good: 3 reasons with explanation.
- Missing: This is surprising to many engineers — "Wait, the JVM doesn't run in the main thread?" The answer should ACKNOWLEDGE the surprise, then explain.

**Q6: "LoadMainClass() 到底怎么加载主类的？"**
- Good: explains the LauncherHelper indirection.
- Missing: WHY through LauncherHelper? "Because FindClass('com/example/Main') returns null if the class isn't found — but JNI error handling for FindClass returning null is cumbersome. LauncherHelper wraps it in Java-side exception handling with proper error messages."

### Scoring:
9-10: 5+ answers are story-format, memorable, interview-deliverable
7-8: 3-4 good answers, rest too dense or list-like
5-6: answers exist but are source traces, not interview answers
3-4: thin answers
1-2: missing or useless

---

## 3. Production Scenarios Quality — 10 pts

### Check each of 5 scenarios:

**libjvm.so 找不到**: Does it show the EXACT error string? `Error: could not find libjava.so` — YES, from emessages.h:98. Does it give a REPRODUCIBLE diagnostic? `readlink -f /proc/self/exe` → check `lib/libjava.so` → check `lib/server/libjvm.so` — YES, 4-step. Good.

**主类找不到**: Shows exact string `Error: Could not find the main class %s.` from emessages.h:68. 5-step diagnostic. Good.

**JAR manifest 损坏**: Shows exact strings JAR_ERROR2/JAR_ERROR3. Even better: shows the PARSE FLOW with line numbers. Excellent.

**JNI_CreateJavaVM 失败**: Exact string from emessages.h:60. But the diagnostic is weak: "堆大小超出物理内存" / "本机库缺失" / "模块路径错误" — too vague. Need specific commands: `ulimit -v`, `ldd <java>/lib/jli/libjli.so`, `java -Xlog:modules=debug`.

**JVM 类型别名循环**: Good: shows emessages.h:81 string + code path in java.c:770-777. But this is rare — not a common 3am scenario. Could be replaced with: "Two JDK versions, java picks wrong libjvm.so" which is MUCH more common.

### Scoring:
9-10: 4+ scenarios with exact error strings + actionable diagnostics + cross-references to correct doc section
7-8: 3 scenarios meet standard
5-6: scenarios exist but diagnostics vague
3-4: thin scenarios
1-2: no production grounding

---

## 4. First-Principles Depth — 15 pts

### Check §八's 12 questions + §二's 5 design decisions:

**§二 design decisions** (are they derived, not described?):
1. dlopen vs static linking: "libjvm.so ~20MB" → "OS shares pages across processes" → "90% memory savings for multi-JVM" — DERIVED. Good.
2. /proc/self/exe vs JAVA_HOME: "zero config" → "even works with symlinks" — but MISSING the shell script counterexample. If `java` is a shell script, /proc/self/exe points to bash, not java. This is IMPORTANT — it's why libjli must be a C binary.
3. Separate JLI_Launch: "5-line wrapper" / "version selection" — good but could be deeper. "Without this separation, every `java` invocation reloads libjli.so even if it's already loaded."
4. -Xms parsed twice: "fail fast + correct execution" — good.
5. JRE directory search: "platform abstraction" — DERIVED. Good.

**§八 deep questions**:
- Q1: "dlopen vs static linking" — quantified (20MB vs 30KB). ✓
- Q2: "/proc/self/exe and shell scripts" — acknowledges the bash problem. ✓
- Q3: "-Xms double parsing" — but this is Q2 in §二. REDUNDANT. Replace with: "为什么 libjli 不直接把所有参数原样传给 JVM？"
- Q4: `-Dsun.java.command` — good, specific, not obvious.
- Q5: "debug main class error" — practical walkthrough. ✓
- Q6: "RTLD_NOW + RTLD_GLOBAL" — technical but relevant. ✓
- Q7: "custom JVM launcher" — opens up GraalVM discussion. ✓
- Q8-12: not listed in output, need to verify they exist.

### Check: Are there ≥3 questions that start from "if you designed this from scratch..."? 
Q1: YES. Q2: YES. Q7: YES (custom JVM). The rest are analytical.

### Scoring:
13-15: 5+ design decisions derived from counterfactuals + 8+ deep questions from first principles
10-12: 3-4 derived + 5-7 first-principles questions
7-9: mostly described, not derived
4-6: superficial design analysis
1-3: no first-principles content

---

## 5. Beginner-Friendliness — 10 pts

### Check §〇:
- 3-tier reading paths? YES — 入门/进阶/专家 with concise descriptions.
- Prerequisites stated? YES — "必须理解 01-jvm-startup §一"
- Core terminology table? YES — 10 terms with definitions and source line references. Good.
- Environment prep? YES — GDB + ldd + nm commands.
- 3-sentence essence? YES — clear and specific.

### Check for concept leaps:
- "dlopen" — defined in terminology table ✓
- "dlsym" — defined ✓
- "/proc/self/exe" — defined ✓
- "JNI" — assumed. The reader completed 09-native-interface, so this is reasonable.
- "wildcard" — defined in context of classpath ✓

### What would confuse a Java engineer who's never done C?
- The §一 ASCII diagram shows C function signatures (`JNIEXPORT int JNICALL`). No explanation of these macros.
- `pthread_create` — mentioned but not defined.
- `RTLD_NOW | RTLD_GLOBAL` — used in §二 without explanation. A Java engineer has never seen these flags.

### Scoring:
9-10: every concept defined before use, no undefined C macros, smooth for Java-only engineer
7-8: minor undefined concepts (2-3)
5-6: several undefined concepts, reader needs external references
3-4: assumes C/Unix knowledge not in prerequisites
1-2: unreadable for target audience

---

## 6. Cross-Phase Coherence — 10 pts

### Explicit connections to 01-12:
- §一: "libjli calls JNI_CreateJavaVM → THIS is where 01-jvm-startup takes over" — does this transition exist? Check.
- §四 doc specs: "不包含：JNI_CreateJavaVM 内部（那是 01 的范畴）" — clear boundary.
- §五 Q2: finding libjvm.so — does it reference 01's jvm.cfg or G1CollectedHeap init? (No — this is a NEW connection that should exist but doesn't.)
- §二: any reference to 14-zip-jimage? (libjli parses -jar → 14 handles JAR reading)

### Missing connections:
- To 02-class-loading: libjli's LoadMainClass calls FindClass → FIRST class loading in JVM lifecycle → should connect to 02's SystemDictionary.
- To 09-native-interface: libjli calls JNI_CreateJavaVM → should reference 09 for JNI function table.
- To 11-os-layer: dlopen is a POSIX call → should reference 11 for OS-layer details.

### Scoring:
9-10: 3+ explicit cross-phase references with correct section numbers
7-8: 2 references, some missing
5-6: 1 reference, major gaps
3-4: no cross-phase connections
1-2: incorrect or misleading

---

## Output

### Per-dimension scores
| Dimension | Score | Key finding |
|-----------|:---:|-------------|
| 1. Doc plan | /15 | |
| 2. Interview | /10 | |
| 3. Production | /10 | |
| 4. First-principles | /15 | |
| 5. Beginner | /10 | |
| 6. Coherence | /10 | |
| **Total** | **/70** | |

### Top 3 gaps (with exact line references)

### Ready for prompts? Yes / Conditionally / No

### Best paragraph in the README
