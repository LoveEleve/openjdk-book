Deep-review 14-zip-jimage/README.md (618 lines). Second extension phase. Source verification corrected 7 spec assumptions — the README must reflect the ACTUAL code, not the planned assumptions.

## Benchmark
13-launcher/README.md (170+/175 after all fixes)

## Phase context
14 is the PHYSICAL I/O bridge: 13 resolves classpath → JAR paths, 14 reads .class bytes from JAR/jimage, 02 parses bytes into InstanceKlass. The README must make this bridge EXPLICIT — not just imply it.

---

## 1. Doc Plan Quality — 15 pts

### Check §四 doc plan (4-5 docs):

Each doc spec must have: core ❓ question (problem-framed, not description), production scenario (specific, not generic), source files (full paths), prerequisites, scope boundaries.

**Key verification**: Does the doc plan reflect the 7 source corrections?
- Correction 1: No ZipEntry.c → ALL specs should reference `zip_util.c` as the primary source
- Correction 2: ZIP lookup is hash O(1), not binary search → all "binary search" language must be updated
- Correction 3: ClassLoader.defineClass1 receives PRE-READ bytes from Java ZipFile → the bridge doc must explain THIS architecture, not "defineClass1 calls ZIP_GetEntry"
- Corrections 4-7: zlib bundled, jimage perfect hashing, dlopen libzip, CRC32 in Java layer

### Per-doc checks:
**00-Zip-Class-Loading**: Core question updated to reflect correction #3? "ZipFile.getInputStream() → Inflater.c → zlib inflate → returns bytes → Java passes bytes to defineClass1." Not "defineClass1 → ZIP_GetEntry → reads bytes."
**01-Jimage-Format**: Perfect hashing mechanism explained? HASH_MULTIPLIER 0x01000193? magic 0xCAFEDADA?
**02-Compression-Zlib**: Zlib bundled (not system) mentioned? libzip.so dlopen'd by jimage decompressor?
**03-ClassLoader-Bridge**: This is the KEY doc — it MUST explain "Java → ZipFile → Inflater → defineClass1" architecture correctly per correction #3
**04-Jar-Nesting**: Exists?

### Scoring:
13-15: 4+ docs with problem-framed questions + source-correct specs + full paths
10-12: docs present but 1-2 vague or missing source corrections
7-9: doc plan thin, corrections not reflected
4-6: fundamental architectural errors from old spec
1-3: no doc plan or completely wrong

---

## 2. Interview Questions Quality — 10 pts

### Check ≥6 questions:

The 13-launcher review standard: "all Qs have verifiable answers in docs, all story-format." Same standard.

**Key source-awareness check**: Do Q answers reflect the 7 corrections?
- Q about ZIP lookup: should say "chained hash table O(1)" not "binary search O(log n)"
- Q about defineClass1: should say "receives pre-read bytes from Java ZipFile" not "calls ZIP_GetEntry"
- Q about CRC32: should note it's in Java ZipFile layer, not native class loading

### Per-Q check format:
Q1: "How does JVM read .class from JAR?" → Answer: ZipFile.getInputStream() → native Inflater.inflate() → zlib → bytes → Java → ClassLoader.defineClass1(bytes). Hash-based ZIP lookup at zip_util.c:1172.
Q2: "Why jimage instead of ZIP?" → Perfect hashing: HASH_MULTIPLIER * name_hash → location_table[index] → direct offset. O(1) guaranteed (no collisions by construction).
Q3: "How does DEFLATE work?" → zlib 1.2.11 bundled. inflateInit2/inflate/inflateEnd. Cached Inflater state.
Q4: "defineClass1 bridge?" → Receives BYTE[] from Java, not calls native ZIP. Architecture: Java controls I/O, native just stores bytes.
Q5: "Why many JARs slow startup?" → Each JAR = zip_util.c ZIP_Open = 0.2-0.5ms. 500 JARs = 250ms.
Q6: "Why not raw .class files?" → 3000 .class files × 4KB blocks = 12MB wasted + 3000 open syscalls vs 1 ZIP open.

### Scoring:
9-10: 6+ Qs with source-correct answers, story-format
7-8: 5 Qs solid, 1-2 minor issues
5-6: answers exist but pre-correction content still present
3-4: thin answers
1-2: missing or wrong

---

## 3. Production Scenarios Quality — 10 pts

### Check ≥4 scenarios:

Each must have: exact error string, which doc covers it, actionable diagnostic, root cause analysis.

Source-awareness: Error messages must match actual JVM behavior (e.g., CRC32 ZipException is Java-layer, not native).

| Scenario | Exact symptom | Doc | Diagnostic | Checks |
|---------|-------------|-----|-----------|--------|
| Corrupted JAR | `ZipException: invalid entry CRC` (Java, not native) | 00 | `jar tvf` validate | Error string accurate? |
| jimage mismatch | `FindException: Module java.base not found` | 01 | `jimage info` | Version MAJOR/MINOR checked? |
| Slow startup/JARs | 500+ openat from strace | 00 | Count JARs, AppCDS | Timing quantified? |
| Nested JAR failure | ZipException in Spring Boot | 04 | zipfs or LaunchedURLClassLoader | Specific? |

### Scoring:
9-10: 4+ scenarios with exact strings + actionable diagnostics + source-correct
7-8: 3 solid
5-6: scenarios exist but miss details or pre-correction
3-4: thin
1-2: no production grounding

---

## 4. First-Principles Depth — 10 pts

### Check §二 design decisions (≥5):

Each derived from counterfactual, quantified, source-backed.

**Key corrections to verify**:
- "Why ZIP O(1) hash not O(log n) binary?" NEW rationale based on correction #2. "Hash table with 75% load factor → 1-2 probes average. Binary search → 12 comparisons always. For 3000 entries → hash is ~10x faster per lookup. Cost: hash table uses ~20% more memory than sorted array → tradeoff: memory for speed."
- "Why Java ZipFile reads bytes, not defineClass1?" NEW rationale based on correction #3. "Separation of concerns: ZipFile handles I/O, zlib, CRC32 (Java's domain with exception handling). ClassLoader.defineClass1 handles class definition (JVM's domain with metaspace allocation). Native bridge receives clean bytes, doesn't do I/O."

### Scoring same pattern: ≥5 decisions derived from counterfactuals, quantified.

---

## 5. Beginner-Friendliness — 10 pts

Check: ZIP Central Directory defined? DEFLATE explained? zlib defined? jimage location table explained before use? hash-based lookup explained?

Concept leap: where would a Java engineer with zero knowledge of ZIP internals get lost?

---

## 6. Cross-Phase Coherence — 10 pts

Verify §九 connections: 13→14 explicit? 14→02 explicit? 14→15 core-native for ClassLoader.c?

Correction #3 awareness: the 14→02 handoff is "ZipFile returns bytes → defineClass1 receives bytes → 02's ClassFileParser parses bytes." This is different from the originally assumed "defineClass1 calls ZIP_GetEntry."

---

## 7. Line Number Accuracy — 5 pts

Spot-check against Step 1 findings: readCEN at zip_util.c:568, ZIP_GetEntry2 at zip_util.c:1172, JIMAGE_FindResource at jimage.cpp, HASH_MULTIPLIER 0x01000193.

---

## Output
Score /70. Top 3 gaps. Ready for prompts?
