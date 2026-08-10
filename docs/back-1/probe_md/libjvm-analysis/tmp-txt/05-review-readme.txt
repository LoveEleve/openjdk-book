Deep-review 05-jit-compiler/README.md (620 lines, from scratch). This is the MOST COMPLEX phase in the entire series. The README is the reader's ONLY map into C2, Sea of Nodes, Chaitin coloring, and deoptimization. If it fails, the entire phase fails — no amount of good documents can rescue a bad README.

## Benchmark READMEs
- 04-interpreter/README.md (528 lines, 49→55+/60 after review+fix)
- 03-object-model/README.md (58→60/60)
- These succeeded because: (a) beginner couldn't get lost, (b) every interview question had a real answer, (c) production scenarios were authentic, (d) first-principles reasoning was embedded in §十一

---

## 1. Beginner-friendliness — 15 pts

C2 is inherently intimidating. Sea of Nodes? Chaitin coloring? Escape analysis? These are compiler theory concepts that even experienced Java engineers find difficult. The README must be the GENTLEST introduction possible.

### Detailed checklist:

**A. §0.3 "三句话"** (3 pts)
- Does it actually explain the CORE idea — "bytecodes become a graph, graph gets optimized, graph becomes x86" — or is it hand-wavy?
- Does it use CONCRETE numbers? (100 bytecodes → 500 nodes → 200 after optimization → 10 x86 instructions)
- Compare to 04's §0.3: "JVM 第一次见到 bytecode → dispatch table → O(1) → execute." Is 05's equally crisp?
- Score: 3 if it's as clear as 04's; 2 if it's a bit vague; 1 if it's abstract; 0 if missing

**B. §0.4 术语速查表** (3 pts)
- 13 terms listed. Are ALL 13 used in §§七~十三? If a term is defined but NEVER used in the doc plan or questions → it's noise.
- Are definitions genuinely "一句话解释"? Or do they fall back to compiler jargon? 
  - Good: "Live Range = 一个值从'被定义'到'最后一次被使用'的区间——两个 Live Range 重叠 → 不能共享同一个寄存器"
  - Bad: "Live Range = 变量活跃区间（见编译原理教材第 8 章）"
- Are the "出现位置" columns accurate? If it says "01 §二" but 01 §二 doesn't define the term → misleading.
- Score: 3 if all 13 are clear + accurate + used; 2 if some vague; 1 if several misleading; 0 if mostly wrong

**C. §0.5 三条路径** (3 pts)
- 🟢 Beginner path (5 docs): can a reader who ONLY reads the listed sections finish without hitting undefined terms?
  - If 01-Pipeline §一 mentions "Ideal Graph" but the term was ONLY defined in §0.4 → fine (they're expected to read §0.4)
  - If 01-Pipeline §一 mentions "ADL file (x86_64.ad)" but this term is NOT in §0.4 → beginner lost
- 🟡 Intermediate path: does it add 5 docs that build on the beginner foundation without redundancy?
  - Check: does reading 01 §一~§三 (beginner) + 01 §四~§八 (intermediate) feel like a smooth progression?
- 🔴 Expert lookup table: are the queries genuinely useful? "Chaitin 着色算法在 x86_64 上的实现" → 03 §三 — is that section actually where Chaitin implementation is explained?
- Score: 3 if all 3 paths are practically walkable; 2 if intermediate path feels redundant; 1 if beginner path fails; 0 if all paths broken

**D. First "getting lost" point** (3 pts)
- Find the FIRST paragraph where a Java engineer with 04-interpreter knowledge but zero compiler knowledge would stop understanding.
- Quote it. Explain why they'd stop.
- This is the hardest diagnostic: the README author thinks it's clear because they already understand the material.
- Score: 3 if the first undefined concept is ≥300 lines in; 2 if 200-300; 1 if 100-200; 0 if <100 lines

**E. §0.6 环境准备** (3 pts)
- Are the GDB commands executable as-written? (Paths, flags, breakpoints)
- Does it include `-XX:+PrintCompilation` and `-XX:+PrintInlining` — the TWO most useful JIT diagnostic flags?
- If a reader copies these commands, will they see SOMETHING interesting? Or do they immediately need additional configuration?
- Score: 3 if copy-paste-runnable + shows useful output; 2 if runnable but output unexplained; 1 if needs adaptation; 0 if broken

---

## 2. First-principles depth — 15 pts

The difference between a GOOD README and a GREAT README: does it derive, or does it describe?

### Detailed checklist:

**A. §十一's 15 questions** (5 pts)
- For EACH question: does it start from a counterfactual ("if you designed a JIT compiler from scratch, would you...") and derive HotSpot's answer?
- Check 3 specific questions:
  - Q1: "Sea of Nodes 为什么没有控制流？" — does the answer explain that Sea of Nodes USES edges as data+control, making control flow implicit? Or does it just say "because it's a sea of nodes"?
  - Q9: "Live Range splitting 和 Coalesce 有什么不同？" — does the answer distinguish: splitting = INSERT moves to break long live ranges (reduce register pressure), coalesce = ELIMINATE moves by merging registers (reduce instruction count)? Or does it conflate both as "register optimization"?
  - Q14: "为什么不用 C2 编译所有代码？" — does the answer quantify: "100ms compile time × 10000 methods = 1000 seconds startup" vs "interpreter warmup = 2 seconds"? Or is it hand-wavy?
- Score: 5 if 12+ questions are genuine first-principles; 4 if 9-11; 3 if 5-8; 2 if mostly superficial; 1 if hand-wavy

**B. §八 per-doc specifications** (5 pts)
- For EACH doc: is the core question a "WHY" question ("C2 怎么决定内联还是不内联？") or a "WHAT" question ("C2 的内联机制")?
- Check: 01-Pipeline's question: "100 条字节码怎么变成 10 条 x86 指令？" — this is a WHAT framed as HOW LONG. Better: "C2 为什么用 8 个阶段而不是 1 个阶段？tradeoff 是什么？"
- Are the "文档覆盖" items concrete source walk-throughs or vague descriptions?
  - Good: "Parse: GraphKit 字节码 → Parse::do_one_bytecode() → Node 创建"
  - Bad: "Parse: 解析字节码生成中间表示"
- Score: 5 if 5+ docs have genuine WHY questions + concrete walkthroughs; 4 if 4 docs; 3 if 2-3; 2 if mostly vague; 1 if all superficial

**C. Design trade-offs exposed** (5 pts)
- Does the README expose the MAJOR trade-offs that shaped C2?
  - Sea of Nodes vs Linear IR: why graph not tree? (allows floating nodes, but graph matching is NP-hard)
  - Chaitin vs Linear Scan: why Chaitin for C2 but Linear Scan for C1? (Chaitin is higher quality but slower; C1 prioritizes compile speed)
  - Tiered compilation: why 4 levels not 2? (2 levels = C1 too slow or C2 too cold; 4 levels = smooth warmup curve)
- Are these trade-offs EXPLICITLY discussed, or buried?
- Score: 5 if 3+ trade-offs are explicitly discussed with quantification; 4 if 2; 3 if 1; 2 if buried; 1 if absent

---

## 3. Production grounding — 10 pts

### Detailed checklist:

**A. §十三's 6 production scenarios** (5 pts)
For EACH scenario, verify:
- Is the symptom specific? "hs_err 有 `V [libjvm.so+...] PhaseIdealLoop`" is specific. "C2 编译失败" is not.
- Is the diagnostic actionable? "检查 inline log" is vague. "`-XX:+PrintInlining | grep 'already compiled into a big method'`" is actionable.
- Is there a FIX? Not just "check this" but "change this flag" or "exclude this method."
- Score: 5 if 5+ scenarios have specific symptom + actionable diagnostic + fix; 4 if 4; 3 if 3; 2 if vague; 1 if useless

**B. 和真实生产场景的对标** (3 pts)
Do these 6 scenarios match what ACTUALLY happens in production?
Missing common production JIT issues:
- "C2 compilation taking too long" (not crashing, just slow → causes warmup latency)
- "C2 recompilation loop" (method compiled → deopt → recompiled → deopt → ... infinite loop)
- "C2 missing inlining opportunities" (method should be inlined but isn't → 10x slower)
- "NMethodSweeper too slow" (CodeCache fills faster than sweeper cleans)
Are any of these missing from §十三?
- Score: 3 if 5+ real-world scenarios covered; 2 if 3-4 covered; 1 if 1-2; 0 if theoretical

**C. Container/K8s awareness** (2 pts)
- 01 added container doc, 02 added container to CLD, 03 had production format. 05 MUST follow.
- Does §十三 mention cgroup CPU limits affecting CICompilerCount?
- Does it mention container memory limits affecting CodeCache size?
- Score: 2 if container-aware; 1 if briefly mentioned; 0 if absent

---

## 4. Interview readiness — 10 pts

### Detailed checklist:

**A. §十三's 8 interview questions** (5 pts)
- For EACH: could someone speak this answer in an interview WITHOUT sounding like they're reading documentation?
- Check 2 specific questions:
  - "C2 怎么把字节码编译成机器码？" — Is the answer a STORY? ("First, parse bytecodes into a Sea of Nodes graph. Each bytecode becomes nodes: iload → ParmNode, iadd → AddINode. Then 8 optimization passes progressively simplify the graph...") Or is it a fact dump?
  - "内联为什么是 JIT 最重要的优化？" — Is the answer QUANTIFIED? ("Without inline: 4 argument pushes + call instruction + return + frame setup = ~40 cycles overhead per method call. With 1000 calls = 40000 cycles wasted. Inline eliminates all this AND enables downstream optimizations: after inline, C2 can see that arg1 is constant → fold the entire callee away.")
- Missing classic JIT interview questions:
  - "C2 的 Escape Analysis 做了什么？不逃逸的对象怎么优化？" (not in current 8)
  - "为什么需要 OSR？和全方法编译的区别？" (not in current 8)
  - "C2 的 Macro Expansion 具体做了什么优化？" (not in current 8)
- Score: 5 if all 8 are story-format and cover the most-asked questions; 4 if 6-7 are good; 3 if some are fact-dumps; 2 if many missing

**B. 面试答案的实用性** (3 pts)
- Does each answer include CONCRETE NUMBERS? ("100ms compile time", "40 cycles per call overhead", "500 → 200 nodes")
- Could X (Twitter) screenshot one of these answers and go viral? (The "holy shit, THAT'S how it works" test)
- Score: 3 if multiple impressive numbers; 2 if some; 1 if none

**C. 面试答案的准确性** (2 pts)
- Quick spot-check: "Tiered compilation levels" — L0=interpreter, L1=C1 no profiling, L2=C1 limited profiling, L3=C1 full profiling, L4=C2. Accurate?
- "Chaitin coloring: IFG construction → coloring → spill if degree ≥ 16." Accurate? (Yes, for x86_64 with 16 GPRs. But is the algorithm sequence right? It's: build → coalesce → compute spill costs → select spill → insert spill code → rebuild — NOT just "build → color → spill")
- Score: 2 if technically accurate; 1 if minor errors; 0 if fundamental errors

---

## 5. Scope & coherence — 10 pts

### Detailed checklist:

**A. 6-doc plan completeness** (4 pts)
- Does the 6-doc set cover the FULL C2 pipeline without overlaps or gaps?
- Check for gaps:
  - Parse phase: covered in 01. Good.
  - Optimize (IGVN + loop + EA + macro): 01 covers all. Good. But EA is complex enough for its own doc — is 01 §七 sufficient?
  - Matching (instruction selection): covered in 01 §八. How is x86 instruction selection done? ADL files? If 01 doesn't explain ADL clearly, this is a gap.
  - RegAlloc: 03 is dedicated. Good.
  - Code generation: 01 covers output. Good.
  - Code installation (CodeCache allocation): 04 covers. Good.
  - Deopt: 05 covers. Good.
  - Potential gap: **Profile data flow** (from L2/L3 to C2) — how does C2 USE the profile data collected by C1? This is mentioned in §二 tiered levels but never expanded into a doc section.
  - Potential gap: **C2's debugging & diagnostic tools** (PrintCompilation, PrintInlining, PrintAssembly, LogCompilation) — no doc covers this. These are the FIRST tools a production engineer uses.
- Score: 4 if no gaps; 3 if 1 minor gap; 2 if 2 gaps; 1 if significant gaps

**B. Dependency diagram correctness** (3 pts)
- Diagram: 01→02, 01→03, 01→04, 01→05, 01→06. Correct?
  - 02 depends on 01: InlineTree is a Phase of C2's Optimize → correct
  - 03 depends on 01: RegAlloc receives Ideal graph from Matching → correct
  - 04 depends on 01: CodeCache holds the nmethod 01 produces → correct
  - 05 depends on 01: Deopt points are generated during compilation → correct
  - 06 depends on 01: OopMaps are generated during Output phase → correct
  - But: should 06 also depend on 05? (OopMaps are consumed by deopt to rebuild frames)
  - But: should 04 depend on 02? (CodeCache decisions affected by inline depth)
- Score: 3 if all dependencies correct + missing cross-dependencies identified; 2 if minor; 1 if wrong

**C. Writing priority rationality** (3 pts)
- P0: 01+Pipeline + 02-Inline. P1: 05-Deopt + 06-OopMap. P2: 03+RegAlloc + 04+CodeCache.
- Is this the RIGHT order? 
  - 01 MUST be first (foundation). ✅
  - 02 MUST be second (inline is phase 1/2 of C2). ✅
  - 03 (RegAlloc) should be BEFORE 04 (CodeCache) logically — nmethod can't be sized without knowing register allocation. But 04 is about LIFECYCLE, not creation. Reasonable.
  - 05 (Deopt) should be BEFORE 06 (OopMap) — OopMaps are consumed by deopt. ✅
- Score: 3 if priority order is rational + justified; 2 if minor ordering issue; 1 if wrong

---

## Output

### Per-dimension scores
| Dimension | Score | Key finding |
|-----------|:---:|-------------|
| 1. Beginner-friendliness | /15 | |
| 2. First-principles depth | /15 | |
| 3. Production grounding | /10 | |
| 4. Interview readiness | /10 | |
| 5. Scope & coherence | /10 | |
| **Total** | **/60** | |

### Top 3 gaps (with exact line numbers or section references)

### Ready to write prompts? Yes / Conditionally / No

### Best single paragraph in the README (quote it)

### Most dangerous assumption (what the README assumes the reader knows that they probably don't)
