Deep-review 16-nio-network/README.md (686 lines). I/O backbone of every production Java service.

## Benchmark
15-core-native/README.md (68/70 after review)

## Phase context
16 is the I/O layer. Netty/Tomcat/Kafka depend on it. The README corrected a critical assumption: Java NIO uses **level-triggered** epoll, not edge-triggered. This correction must be consistently reflected.

---

## 1. Doc Plan Quality — 15 pts

### Verify §四 has 5-6 docs, each with problem-framed ❓, production scenario, full source paths, prerequisites, scope boundaries.

### Per-doc checks:

**00-Epoll-Selector**: Core ❓ problem-framed? "Selector 100% CPU spin — why does select() return immediately?" Not "how does epoll work." Level-triggered correctly reflected? No EPOLLET mentions.

**01-SocketChannel-Native**: 5-step lifecycle (socket→bind→listen→accept→read/write) fully specified? Non-blocking connect with EINPROGRESS?

**02-DirectByteBuffer-IO**: DirectBuffer allocation via Unsafe.allocateMemory? Cleaner deallocation mechanism? Performance comparison DirectBuffer (zero-copy) vs HeapBuffer (copy to native temp)?

**03-FileChannel-sendfile**: sendfile64 signature verified? `sendfile64(dstFD, srcFD, &offset, count)`. Kafka use case? Retry logic?

**04-Selector-Thread-Model**: Reactor pattern Boss+Worker? Wakeup pipe mechanism? JDK epoll spin bug mentioned?

**05-Socket-Options**: SO_LINGER/TCP_NODELAY/SO_REUSEADDR via setsockopt? TIME_WAIT flood scenario?

### Scoring:
13-15: all 5+ docs problem-framed + source-correct + level-triggered reflected
10-12: docs present but 1-2 vague
7-9: thin or pre-correction assumptions remain
4-6: missing key docs

---

## 2. Interview Questions Quality — 10 pts

### Verify ≥10 Qs with source-backed answers:

Q1 "epoll vs select/poll": O(1) vs O(n), level-triggered correctly described?
Q2 "Direct vs Heap Buffer": stable address vs GC movement, zero-copy advantage?
Q3 "sendfile zero-copy": disk→kernel→socket→NIC, 2 copies vs 4 copies?
Q4 "Selector.wakeup": write 1 byte to pipe, epoll detects readable?
Q5 "non-blocking connect": EINPROGRESS → register OP_CONNECT → getsockopt(SO_ERROR)?
Q6 "dup2 trick": dup2(/dev/null, fd) → EBADF → wake up? Race condition prevention?
Q7 "Reactor Boss+Worker": Boss accepts, Worker processes?
Q8 "Level vs Edge triggered": Java uses level-triggered — this is the CORRECTION. Must be present and correct.
Q9 "maxDirectMemory": -XX:MaxDirectMemorySize, young GC doesn't free DirectBuffer?
Q10 "SO_LINGER=0": RST instead of FIN, skips TIME_WAIT, data loss risk?

### Scoring:
9-10: all 10 Qs present + source-correct + level-triggered correction reflected
7-8: 8-9 solid
5-6: 5-7 solid
3-4: thin or wrong on level-triggered

---

## 3. Production Scenarios — 10 pts

### Verify ≥5 scenarios with exact errors:

| Scenario | Error string | Doc | Diagnostic |
|---------|-------------|-----|-----------|
| Selector spin | select() returns 0 immediately | 00 | JDK epoll bug, switch to PollSelectorProvider |
| Too many open files | IOException: Too many open files | 01 | ulimit -n 65536 |
| DirectBuffer OOM | OutOfMemoryError: Direct buffer memory | 02 | -XX:MaxDirectMemorySize, check netty pool |
| sendfile fails | transferTo returns 0 | 03 | Linux kernel bug, mmap fallback |
| TIME_WAIT flood | 30000+ TIME_WAIT | 05 | SO_LINGER=0, SO_REUSEADDR |

### Scoring:
10: all 5 with exact errors + actionable diagnostics
8: 4/5 solid
6: 3/5 solid
4: thin
2: no production grounding

---

## 4. First-Principles Depth — 10 pts

### Verify §二 ≥8 design decisions — each counterfactual-driven?

1. "Why epoll not select/poll?" — O(n) vs O(1), quantified (100x for 10K fds)?
2. "Why level-triggered?" (CORRECTION) — "notifies until you drain data, simpler programming model" — correctly NOT edge-triggered?
3. "Why DirectBuffer?" — heap address unstable, GC moves → counterfactual quantified?
4. "Why sendfile?" — 4 copies vs 2, 2 context switches vs 1?
5. "Why dup2 trick?" — read doesn't return on Linux close → counterfactual?
6. "Why non-blocking connect?" — 1-3s per connection vs 3s total for 10K?
7. "Why 1 Selector thread?" — 10K threads × 1MB = 10GB vs 1 thread + epoll?
8. "Why wakeup pipe?" — signal-safety issues with alternative?

### Scoring:
10: 8+ decisions derived + quantified
8: 6-7 solid
6: 4-5
4: thin
2: no first-principles

---

## 5. Beginner-Friendliness — 10 pts

### Check terminology table and callouts:
epoll fd, level-triggered, EPOLLIN/EPOLLOUT, DirectByteBuffer native address, sendfile zero-copy, wakeup pipe, dup2, Reactor pattern, EINPROGRESS — all defined in §〇 before use?

### Concept leap: where would Java engineer with zero networking C knowledge get lost?

### Scoring:
10: all terms defined, no unexplained concepts
8: most defined, 1-2 unclear
6: several gaps
4: assumes networking C knowledge
2: no scaffolding

---

## 6. Cross-Phase Coherence — 10 pts

### Verify §九 connections to: 09-native-interface, 11-os-layer, 03-object-model, 05-jit-compiler, 15-core-native — all present and specific (not "relates to")?

### Scoring:
10: all 5+ connections specific + file:line references
8: 4 present
6: 3 present
4: vague
2: missing

---

## 7. Source Accuracy — 5 pts

### Spot-check:
- EPoll.c:61 epoll_create(256)?
- FileChannelImpl.c:135 sendfile64?
- linux_close.c:275 NET_Dup2?
- IOUtil.c: GetDirectBufferAddress usage?
- EPollSelectorImpl.java:53 NUM_EPOLLEVENTS?

### Scoring:
5: all 5 correct
4: 4/5
3: 3/5
2: ≤2/5

---

## Output
Score /70. Top gaps. Ready for prompts?
