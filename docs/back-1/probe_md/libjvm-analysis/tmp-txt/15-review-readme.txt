Deep-review 15-core-native/README.md (511 lines). This phase covers the most FREQUENTLY called native methods in Java — if the doc plan misidentifies what's important, the whole phase teaches the wrong things.

## Benchmark
14-zip-jimage/README.md (68/70 after review)

## Phase context
15 is about libjava.so — the native bridge for java.lang.* and java.io.*. Reader knows JNI from 09, object model from 03, class loading from 02. This phase teaches: HOW all the methods they call every day actually work beneath the Java surface.

---

## 1. Doc Plan Quality — 15 pts

### Check §四 doc plan (3-4 docs):

Each doc spec: problem-framed ❓, specific production scenario, source files with full paths, prerequisites, scope boundaries.

### Per-doc checks:

**00-System-Arraycopy-HashCode**: 
- Core question problem-framed? "Every HashMap.get calls Object.hashCode → what happens in native?" Not "this doc covers System.arraycopy."
- Production: ArrayStoreException specific? "Integer into String[] → runtime type mismatch." 
- System.arraycopy dispatch described? isPrimitive → memmove / isObject → type-check + copy loop?
- identityHashCode vs hashCode distinction clear?

**01-Class-String-Native**:
- Class.forName: "uses CALLER's classloader, not context classloader" — this distinction MUST be prominent. It's the #1 source of Class.forName bugs.
- String.intern: StringTable (ConcurrentHashTable in metaspace) explained?

**02-Runtime-Throwable**:
- availableProcessors: cgroup awareness since JDK 10 explained? `cpu.cfs_quota_us / cpu.cfs_period_us` formula?
- fillInStackTrace: works through C2 frames? nmethod metadata reads?
- Container scenario: "host has 64 cores, container has 2 → 64 GC threads → 10x STW" — specific?

**03-JNI-Utility-Layer**: Is this justified as a separate doc or should it be folded into 00-02? libjni_util.c has 1506 lines but is mostly boilerplate. If this doc is kept, what's its unique contribution?

### Scoring:
13-15: 3-4 docs all problem-framed + source-specific + correct frequency weighting
10-12: docs present but 1-2 vague
7-9: doc plan thin or misweighted
4-6: missing key methods or wrong doc grouping
1-3: no real plan

---

## 2. Interview Questions Quality — 10 pts

### Verify source backing for each Q:

Q1 "System.arraycopy" → answer: isPrimitive → memmove, isObject → type-check copy. Source: System.c:41 RegisterNatives. C2 intrinsic to REP MOVS. Correct?

Q2 "Object.hashCode vs identityHashCode" → answer: hashCode() is virtual → can be overridden. identityHashCode is native → JVM_IHashCode → reads markOop directly. Source: System.c:56. Correct?

Q3 "Float.floatToIntBits" → answer: C union {float f; int32_t i;}. Why native? Java has no union type. C2 intrinsic: pure register move. Source: Float.c:49-56. Correct?

Q4 "Class.forName classloader" → answer: forName0 → JVM_FindClassFromCaller → FindClass in CALLER's classloader. Source: Class.c:137. Correct?

Q5 "String.intern" → answer: JVM_InternString → StringTable::intern() → ConcurrentHashTable in metaspace. Source: String.c:32. Correct?

Q6 "availableProcessors in Docker" → answer: JDK 10+ reads cgroup limits. Formula: floor(cpu_quota / cpu_period). Source: Runtime.c:71 → JVM_ActiveProcessorCount. Correct?

Q7 "fillInStackTrace" → answer: native stack walk → reads through C2 frames (nmethod metadata) → builds StackTraceElement[]. Source: Throwable.c:49. Correct?

Q8: at least 8 questions total? What's the 8th?

### Scoring:
9-10: all 8 Qs with source-correct answers, story-format, verifiable from doc specs
7-8: 6-7 solid
5-6: 4-5 solid
3-4: answers vague or missing source backing
1-2: no interview content

---

## 3. Production Scenarios Quality — 10 pts

### Per-scenario check:

| Scenario | Exact error? | Which doc? | Actionable diagnostic? |
|---------|:---:|:---:|:---:|
| ArrayStoreException | "java.lang.ArrayStoreException: java.lang.Integer" | 00 | Check src element type vs dst declared type |
| ClassNotFoundException (OSGi) | Class.forName fails in OSGi | 01 | Check caller's classloader vs context classloader |
| Container CPU miscount | GC threads = 64 on 2-CPU container | 02 | PrintFlagsFinal → check ParallelGCThreads; verify cgroup limits |
| identityHashCode loop | HashMap infinite loop | 00 | Use System.identityHashCode for mutable keys |
| Additional scenarios? | | | |

### Scoring:
9-10: 4+ scenarios with exact errors + diagnostics + correct doc mapping
7-8: 3 solid
5-6: 2 solid
3-4: thin or generic
1-2: no production grounding

---

## 4. First-Principles Depth — 10 pts

### Verify §二 design decisions:

Each must start from counterfactual + quantified:

1. "Why arraycopy in native not Java?" → "Java loop: 1 bounds check per iteration × 1M = 1M checks (~10ms). Native memmove: 0 checks → 0.1ms. 100x faster."
2. "Why identity hashCode in markOop?" → "Java can't access raw object headers. markOop is 64-bit header word. Store hash in unused bits (25 bits for hash in 32-bit mode)."
3. "Why Float.floatToIntBits native?" → "C: union reinterpretation = 0 CPU cost. Java: no union type → must go through native or C2 intrinsic."
4. "Why String.intern native?" → "StringTable is in metaspace (ConcurrentHashTable). Java heap objects can't directly index native memory structures."
5. "Why nanoTime needs monotonic clock?" → "System.currentTimeMillis = wall clock, NTP adjusts, can go backwards. nanoTime = CLOCK_MONOTONIC, never decreases. Performance measurement requires monotonic."
6. "Why forName uses caller's classloader?" → security. Prevents a library from loading classes in a privileged classloader context without the caller's consent.
7. "Why arraycopy uses memmove not memcpy?" → memmove handles overlapping regions (src and dst overlap). memcpy undefined behavior on overlap. arraycopy spec says "copy behaves as though the elements were first copied to a temporary array" → must work with overlap.

### Scoring:
9-10: 6+ decisions derived + quantified with counterfactuals
7-8: 5 decisions but 2 lack quantification
5-6: mostly descriptions
3-4: thin
1-2: no first-principles

---

## 5. Beginner-Friendliness — 10 pts

### Check terminology table in §〇:
- JNI_ENTRY: defined? "enter native from Java — parameter marshalling overhead"
- JVM_ENTRY: defined? "JVM internal entry — no JNI marshalling, fast path"
- intrinsic: defined? "C2 replaces native call with direct CPU instruction at compile time"
- markOop: defined? "64-bit object header word — stores identity hash, GC age, lock state"
- memmove: defined? "raw memory copy — C standard library, handles overlapping regions"
- StringTable: defined? "JVM-internal hash table in metaspace for interned strings"

### Concept leap check:
Where would a Java engineer with zero C knowledge get stuck?
- "union { float f; int32_t i; }" → is union explained?
- "clock_gettime(CLOCK_MONOTONIC)" → is CLOCK_MONOTONIC explained?
- "C2 intrinsic" → is intrinsic vs JNI explained?

### Scoring:
9-10: all terms defined, no unexplained C concepts
7-8: all terms defined, 1-2 unclear
5-6: some terms missing
3-4: significant gaps
1-2: no scaffolding

---

## 6. Cross-Phase Coherence — 10 pts

### Verify §九 connections:

| Phase | Connection | Present? |
|-------|-----------|:---:|
| 01-jvm-startup | System.initProperties sets java.class.path | |
| 02-class-loading | Class.forName → FindClass in caller's classloader | |
| 03-object-model | Object.hashCode → markOop::hash() in object header | |
| 05-jit-compiler | C2 intrinsifies arraycopy, floatToIntBits to direct instructions | |
| 09-native-interface | JNI_ENTRY/JVM_ENTRY macros used by ALL libjava natives | |
| 14-zip-jimage | ClassLoader.defineClass1 native bridge (covered in 14 doc 03) | |

### Scoring:
9-10: all 6 connections present and accurate
7-8: 5 present
5-6: 3-4 present
3-4: only superficial connections
1-2: missing

---

## 7. Source Accuracy — 5 pts

Spot-check from Step 1 verification:
- arraycopy RegisterNatives at System.c:41 — correct?
- identityHashCode → JVM_IHashCode at System.c:56 — correct?
- forName0 → JVM_FindClassFromCaller at Class.c:137 — correct?
- Float union at Float.c:49-56 — correct?
- availableProcessors → JVM_ActiveProcessorCount at Runtime.c:71 — correct?

### Scoring:
5: all spot-checks match
4: 4/5
3: 3/5
2: ≤2/5
1: none verified

---

## Output
Score /70. Top 3 gaps. Ready for prompts?
