# THE GARBAGE COLLECTION HANDBOOK

The Art of Automatic Memory Management

Second edition

Richard Jones

Antony Hosking

Eliot Moss

<img src="https://aidata-public.oss-cn-hangzhou.aliyuncs.com/pdf_parse_jn%2Fa6da444f4698df922f013898efecef4d%2F1%2Fimages%2Fa6da444f4698df922f013898efecef4d_1_image_0.png?OSSAccessKeyId=LTAI5tLH9TMVBSnrtTGN4n4b&Expires=1811485120&Signature=tDofJMlXaK3RuigsZcij8cbGUQc%3D" width="71" height="49"/>

CRC Press

Taylor & Francis Group

A CHAPMAN & HALL BOOK

# THE GARBAGE COLLECTION HANDBOOK

The Art of Automatic Memory Management

<img src="https://aidata-public.oss-cn-hangzhou.aliyuncs.com/pdf_parse_jn%2Fa6da444f4698df922f013898efecef4d%2F2%2Fimages%2Fa6da444f4698df922f013898efecef4d_2_image_0.png?OSSAccessKeyId=LTAI5tLH9TMVBSnrtTGN4n4b&Expires=1811485119&Signature=GIngOb18JqKbPq70go9tXO%2F5kW8%3D" width="441" height="324"/>

Second edition

Richard Jones

Antony Hosking

Eliot Moss

<img src="https://aidata-public.oss-cn-hangzhou.aliyuncs.com/pdf_parse_jn%2Fa6da444f4698df922f013898efecef4d%2F2%2Fimages%2Fa6da444f4698df922f013898efecef4d_2_image_2.png?OSSAccessKeyId=LTAI5tLH9TMVBSnrtTGN4n4b&Expires=1811485120&Signature=%2Fo8PlzX58XMQFVWRLz9772pU5MM%3D" width="48" height="37"/>

CRC Press

Taylor & Francis Group

A CHAPMAN & HALL BOOK

# The Garbage Collection Handbook

Published in 1996, Richard Jones's Garbage Collection was a milestone in the area of automatic memory management. Its widely acclaimed successor, *The Garbage Collection Handbook: The Art of Automatic Memory Management*, captured the state of the field in 2012. Modern technology developments have made memory management more challenging, interesting and important than ever. This second edition updates the handbook, bringing together a wealth of knowledge gathered by automatic memory management researchers and developers over the past sixty years. The authors compare the most important approaches and state-of-the-art techniques in a single, accessible framework.

The book addresses new challenges to garbage collection made by recent advances in hardware and software. It explores the consequences of these changes for designers and implementers of high performance garbage collectors. Along with simple and traditional algorithms, the book covers state-of-the-art parallel, incremental, concurrent and real-time garbage collection. Algorithms and concepts are often described with pseudocode and illustrations.

OceanofPDF.com

# The Garbage Collection Handbook The Art of Automatic Memory Management

Richard Jones, Antony Hosking and Eliot Moss

CRC Press is an imprint of the

Taylor & Francis Group, an informa business

A CHAPMAN & HALL BOOK

OceanofPDF.com

The cover image logo concept was created by Richard Jones, and the rights to the logo belong solely to him.

Second edition published 2023

by CRC Press

6000 Broken Sound Parkway NW, Suite 300, Boca Raton, FL 33487-2742

and by CRC Press

4 Park Square, Milton Park, Abingdon, Oxon, OX14 4RN

CRC Press is an imprint of Taylor & Francis Group, LLC

© 2023 Richard Jones, Antony Hosking and Eliot Moss

© 2012 Richard Jones, Antony Hosking and Eliot Moss

Reasonable efforts have been made to publish reliable data and information, but the author and publisher cannot assume responsibility for the validity of all materials or the consequences of their use. The authors and publishers have attempted to trace the copyright holders of all material reproduced in this publication and apologize to copyright holders if permission to publish in this form has not been obtained. If any copyright material has not been acknowledged please write and let us know so we may rectify in any future reprint.

Except as permitted under U.S. Copyright Law, no part of this book may be reprinted, reproduced, transmitted, or utilized in any form by any electronic, mechanical, or other means, now known or hereafter invented, including photocopying, microfilming, and recording, or in any information storage or retrieval system, without written permission from the publishers.

For permission to photocopy or use material electronically from this work, access www.copyright.com or contact the Copyright Clearance Center, Inc. (CCC), 222 Rosewood Drive, Danvers, MA 01923, 978-750-8400. For works that are not available on CCC please contact mpkbookpermissions@tandf.co.uk

Trademark notice: Product or corporate names may be trademarks or registered trademarks and are used only for identification and explanation without intent to infringe.

<table><tr><td>Library of Congress Cataloging-in-Publication Data</td></tr><tr><td>Names: Jones, Richard, author. | Hosking, Antony, 1964- author. | Moss, J. Eliot B., author.</td></tr><tr><td>Title: The Garbage Collection handbook : the art of automatic memory management / Richard E. Jones, University of Kent, Antony Hosking, The Australian National University, J. Eliot B. Moss, University of Massachusetts Amherst.</td></tr><tr><td>Description: Second edition. | Boca Raton : CRC Press, 2023. | Includes bibliographical references and index.</td></tr><tr><td>Identifiers: LCCN 2022055284 (print) | LCCN 2022055285 (ebook) | ISBN 9781032218038 (hardback) | ISBN 9781032231785 (paperback) | ISBN 9781003276142 (ebook)</td></tr><tr><td>Subjects: LCSH: Memory management (Computer science)</td></tr><tr><td>Classification: LCC QA76.9.M45 J66 2023 (print) | LCC QA76.9.M45 (ebook) | DDC 005.4/3--dc23/eng/20221117</td></tr></table>

LC record available at https://lc.cn.loc.gov/2022055284

LC ebook record available at https://lc.cn.loc.gov/2022055285

ISBN: 978-1-032-21803-8 (hbk)

ISBN: 978-1-032-23178-5 (pbk)

ISBN: 978-1-003-27614-2 (ebk)

DOI: 10.1201/9781003276142

Typeset in URWPalladioL-Roma font by KnowledgeWorks Global Ltd.

Publisher's note: This book has been prepared from camera-ready copy provided by the authors.

# OceanofPDF.com

# To Robbie, Helen, Kate and William Mandi, Ben, Matt, Jory, Katja and Rowan Hannah, Natalie and Cas

OceanofPDF.com

# Contents

List of Algorithms

List of Figures

List of Tables

Preface

Acknowledgements

Authors

1 Introduction

1.1 Explicit deallocation

1.2 Automatic dynamic memory management

1.3 Comparing garbage collection algorithms Safety.

Throughput and cycles consumed

Completeness and promptness

Pause time and latency.

Space overhead

Energy use

Optimisations for specific languages

Scalability and portability.

1.4 A performance disadvantage?

1.5 Experimental methodology

1.6 Terminology and notation

The heap

The mutator and the collector

The mutator roots

References, fields and addresses

Liveness, correctness and reachability

Pseudocode

The allocator

Mutator read and write operations

Atomic operations

Sets, multisets, sequences and tuples

# 2 Mark-sweep garbage collection

2.1 The mark-sweep algorithm

2.2 The tricolour abstraction

2.3 Improving mark-sweep

2.4 Bitmap marking

2.5 Lazy sweeping

2.6 Cache misses in the marking loop

2.7 Issues to consider

Mutator overhead

Throughput

Space usage

To move or not to move?

# 3 Mark-compact garbage collection

3.1 Two-finger compaction

3.2 The Lisp 2 algorithm

3.3 Threaded compaction

3.4 One-pass algorithms

3.5 Issues to consider

Is compaction necessary?

Throughput costs of compaction

Long-lived data

Locality.

Limitations of mark-compact algorithms

# 4 Copying garbage collection

4.1 Semispace copying collection

Work-list implementations

An example

4.2 Traversal order and locality

4.3 Issues to consider

Allocation
Space and locality
Moving objects

5 Reference counting
5.1 Advantages and disadvantages of reference counting
5.2 Improving efficiency
5.3 Deferred reference counting
5.4 Coalesced reference counting
5.5 Cyclic reference counting
5.6 Limited-field reference counting
5.7 Issues to consider
The environment
Advanced solutions

6 Comparing garbage collectors
6.1 Throughput
6.2 Pause time and latency.
6.3 Space
6.4 Implementation
6.5 Adaptive systems
6.6 A unified theory of garbage collection
Abstract garbage collection
Tracing garbage collection
Reference counting.garbage collection

7 Allocation
7.1 Sequential allocation
7.2 Free-list allocation
First-fit allocation
Next-fit allocation
Best-fit allocation
Speeding free-list allocation
7.3 Fragmentation
7.4 Segregated-fits allocation
Fragmentation
Populating size classes

7.5 Combining segregated-fits with first-, best- and next-fit

7.6 Additional considerations

Alignment

Size constraints

Boundary tags

Heap parsability

Locality

Wilderness preservation

Crossing maps

7.7 Allocation in concurrent systems

7.8 Issues to consider

8 Partitioning the heap

8.1 Terminology.

8.2 Why to partition

Partitioning by mobility.

Partitioning by size

Partitioning for space

Partitioning by kind

Partitioning for yield

Partitioning for responsiveness

Partitioning for locality.

Partitioning by thread

Partitioning by availability.

Partitioning by mutability.

8.3 How to partition

8.4 When to partition

9 Generational garbage collection

9.1 Example

9.2 Measuring time

9.3 Generational hypotheses

9.4 Generations and heap layout

9.5 Multiple generations

9.6 Age recording

En masse promotion

Aging semispaces

Survivor spaces and flexibility

9.7 Adapting to program behaviour  
Appel-style garbage collection  
Feedback-controlled promotion

9.8 Inter-generational pointers  
Remembered sets  
Pointer direction

9.9 Space management

9.10 Older-first garbage collection

9.11 Beltway.

9.12 Analytic support for generational collection

9.13 Issues to consider

9.14 Abstract generational garbage collection

# 10 Other partitioned schemes

10.1 Large object spaces  
The Treadmill garbage collector  
Moving objects with operating system support  
Pointer-free objects

10.2 Topological collectors  
Mature Object Space garbage collection  
Connectivity-based garbage collection  
Thread-local garbage collection  
Stack allocation  
Region inferencing

10.3 Hybrid mark-sweep, copying collectors

10.4 Garbage-First: collecting young regions

10.5 Trading space and time

10.6 Mark-region collection: immix

10.7 Copying collection in a constrained memory space

10.8 Bookmarking garbage collection

10.9 Ulterior reference counting

10.10 Issues to consider

# 11 Run-time interface

11.1 Interface to allocation  
Speeding allocation

Zeroing

11.2 Finding pointers

Conservative pointer finding

Accurate pointer finding using tagged values

Accurate pointer finding in objects

Accurate pointer finding in global roots

Accurate pointer finding in stacks and registers

Accurate pointer finding in code

Handling interior pointers

Handling derived pointers

11.3 Object tables

11.4 References from external code

11.5 Stack barriers

11.6 GC safe-points and mutator suspension

11.7 Garbage collecting code

11.8 Read and write barriers

Engineering

Precision of write barriers

Hash tables

Sequential store buffers

Overflow action

Cards and card tables

Crossing maps

Summarising cards

Hardware and virtual memory techniques

Write barrier mechanisms: in summary.

Chunked lists

11.9 Managing address space

11.10 Applications of virtual memory page protection

Double mapping

Applications of no-access pages

11.11 Choosing heap size

11.12 Issues to consider

12 Language-specific concerns

12.1 Finalisation

When do finalisers run?

Which thread runs a finaliser?

Can finalisers run concurrently with each other?

Can finalisers access the object that became unreachable?

When are finalised objects reclaimed?

What happens if there is an error in a finaliser?

Is there any guaranteed order to finalisation?

The finalisation race problem

Finalisers and locks

Finalisation and weak references

Finalisation in particular languages

For further study

# 12.2 Weak references

Additional motivations

Weak references in Java: the short story

Weak references in Java: the full story.

Race in weak pointer clearing

Weak pointers in other languages

# 12.3 Changing object layout

# 12.4 Issues to consider

# 13 Concurrency preliminaries

# 13.1 Hardware

Processors and threads

Interconnect

Memory

Caches

Coherence

Cache coherence performance example: spin locks

# 13.2 Hardware memory consistency

Fences and happens-before

Consistency models

# 13.3 Hardware primitives

Compare-and-swap

Load-linked/store-conditionally

Atomic arithmetic primitives

Test then test-and-set

More powerful primitives

Overheads of atomic primitives

13.4 Progress guarantees

Progress guarantees and concurrent collection

13.5 Notation used for concurrent algorithms

13.6 Mutual exclusion

13.7 Work sharing and termination detection

Rendezvous barriers

13.8 Concurrent data structures

Concurrent stacks

Concurrent queue implemented with singly linked list

Concurrent queue implemented with array.

Concurrent deque for work stealing

13.9 Transactional memory

Using transactional memory to help implement collection

Supporting transactional memory in the presence of garbage collection

13.10 Issues to consider

14 Parallel garbage collection

14.1 Is there sufficient work to parallelise?

14.2 Load balancing

14.3 Synchronisation

14.4 Taxonomy.

14.5 Parallel marking

14.6 Parallel copying

Processor-centric techniques

Memory-centric techniques

14.7 Parallel sweeping

14.8 Parallel compaction

14.9 Garbage collection on the GPU?

GPU background

Heap reference graphs

Marking on the GPU

A problem not yet solved

14.10 Issues to consider

Terminology

Is parallel collection worthwhile?

Strategies for balancing loads  
Managing tracing  
Low-level synchronisation  
Sweeping and compaction  
Termination

# 15 Concurrent garbage collection

# 15.1 Correctness of concurrent collection

The tricolour abstraction, revisited

The lost object problem

The strong and weak tricolour invariants

Precision

Mutator colour

Allocation colour

Pointer tagging

Incremental update solutions

Snapshot-at-the-beginning solutions

# 15.2 Barrier techniques for concurrent collection

Grey mutator techniques

Black mutator techniques

Completeness of barrier techniques

Load barriers

Concurrent write barrier mechanisms

One-level card tables

Two-level card tables

Reducing work

Eliminating read barriers

# 15.3 Ragged phase changes

# 15.4 Issues to consider

# 16 Concurrent mark-sweep

# 16.1 Initialisation

# 16.2 Termination

# 16.3 Allocation

# 16.4 Concurrent marking and sweeping

# 16.5 Garbage-First: collecting young and old regions

# 16.6 On-the-fly marking

Write barriers for on-the-fly collection  
Doligez-Leroy-Gonthier  
Doligez-Leroy-Gonthier for Java  
Sliding views

16.7 Abstract concurrent collection  
The collector wavefront  
Adding origins  
Mutator barriers  
Precision  
Instantiating collectors

16.8 Issues to consider

17 Concurrent copying and compaction

17.1 Mostly-concurrent copying  
Baker's algorithm  
Mostly-concurrent, mostly-copying collection

17.2 Brooks's indirection barrier

17.3 Self-erasing read barriers

17.4 Replication copying  
Multi-version copying  
Extensions to avoid copy-on-write  
Sapphire  
Transactional Sapphire  
Platinum

17.5 Concurrent compaction  
Compressor  
Pauseless and C4  
Collie  
ZGC  
Shenandoah  
Reducing stop-the-world time in Shenandoah and ZGC

17.6 Issues to consider

18 Concurrent reference counting

18.1 LXR: Latency-critical ImmiX with Reference counting

18.2 Simple reference counting revisited

18.3 Biased reference counting

18.4 Buffered reference counting

18.5 Concurrent, cyclic reference counting

18.6 Taking a snapshot of the heap

18.7 Sliding views reference counting

Age-oriented collection

Sliding views cycle reclamation

Memory consistency

18.8 Issues to consider

Safe memory reclamation

# 19 Real-time garbage collection

19.1 Real-time systems

19.2 Scheduling real-time collection

19.3 Work-based real-time collection

Parallel, concurrent replication

Uneven work and its impact on work-based scheduling

19.4 Slack-based real-time collection

Scheduling the collector work

Execution overheads

Programmer input

19.5 Time-based real-time collection: Metronome

Mutator utilisation

Supporting predictability

Analysis

Robustness

19.6 Combining scheduling approaches: Tax-and-Spend

Tax-and-Spend scheduling

Tax-and-Spend prerequisites

19.7 Controlling fragmentation

Incremental compaction in Metronome

Incremental replication on uniprocessors

Stopless: lock-free garbage collection

Staccato: best-effort compaction with mutator wait-freedom

Chicken: best-effort compaction with mutator wait-freedom for x86

Clover: guaranteed compaction with probabilistic mutator lock-freedom

# Stopless versus Chicken versus Clover Fragmented allocation

# 19.8 Issues to consider

# 20 Energy-aware garbage collection

# 20.1 Issues to consider

# 21 Persistence and garbage collection

# 21.1 Persistence: concepts, issues and implementation Providing durability Issues raised by persistence

# 21.2 Impacts of persistence on garbage collection

# 21.3 Barriers in support of persistence Software barriers Hardware barriers Software versus hardware barriers

# 21.4 Implemented collectors for persistent heaps Persistent reference counting Persistent mark-sweep and mark-compact Persistent copying

# 21.5 Issues to consider

# Glossary.

# Bibliography.

# Index

OceanofPDF.com

