#!/usr/bin/env python3
"""
Fix all 18 broken markdown links in vol-01 (excluding archived/).
Applies fixes according to categorized rules.
"""

import os
import re
import sys

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
VOL01 = os.path.join(BASE_DIR, 'docs/openjdk/vol-01')

# Each fix: (file_rel, line_start, old_substring, new_substring, fix_note)
# line_start is the 1-based approximate line number. We'll use content
# uniqueness instead. For our edit tool, we need the exact old_string.

fixes = [
    # === HASH ROUTE: missing .md extension ===
    # ch03/06-main-thread-create.md:15
    (   # Fix 1
        'ch03/06-main-thread-create.md',
        '#/openjdk/vol-01/ch03/02-threads-create-vm)',
        '#/openjdk/vol-01/ch03/02-threads-create-vm.md)',
        'hash_route_add_md',
        'ch03/02-threads-create-vm.md exists',
    ),
    # ch03/background/handles-all.md:39
    (   # Fix 2
        'ch03/background/handles-all.md',
        '#/openjdk/vol-01/ch03/06-main-thread-create?id=chunkpool_init)',
        '#/openjdk/vol-01/ch03/06-main-thread-create.md?id=chunkpool_init)',
        'hash_route_add_md',
        'ch03/06-main-thread-create.md exists',
    ),
    # ch04/01-overview.md:3
    (   # Fix 3
        'ch04/01-overview.md',
        '#/openjdk/vol-01/ch03/06-main-thread-create)',
        '#/openjdk/vol-01/ch03/06-main-thread-create.md)',
        'hash_route_add_md',
        'ch03/06-main-thread-create.md exists',
    ),
    # ch05/01-policy-selection.md:3
    (   # Fix 4
        'ch05/01-policy-selection.md',
        '#/openjdk/vol-01/ch04/05-trivial-merged)',
        '#/openjdk/vol-01/ch04/05-trivial-merged.md)',
        'hash_route_add_md',
        'ch04/05-trivial-merged.md exists',
    ),
    # ch06/01-heap-layout.md:675
    (   # Fix 5
        'ch06/01-heap-layout.md',
        '#/openjdk/vol-01/ch05/01-policy-selection)',
        '#/openjdk/vol-01/ch05/01-policy-selection.md)',
        'hash_route_add_md',
        'ch05/01-policy-selection.md exists',
    ),

    # === HASH ROUTE: target truly nonexistent (ch05/02-thresholds) ===
    # ch05/01-policy-selection.md:336
    (   # Fix 6
        'ch05/01-policy-selection.md',
        '[6.2](#/openjdk/vol-01/ch05/02-thresholds)',
        '[6.2](#/openjdk/vol-01/ch05/02-thresholds)<!-- 404: target not found, 请作者补正文 -->',
        'hash_route_404',
        'ch05/02-thresholds.md does not exist',
    ),

    # === RELATIVE: site root path without #/ (ch02.md) ===
    # ch02.md:286
    (   # Fix 7
        'ch02.md',
        '(openjdk/vol-01/ch03)',
        '(#/openjdk/vol-01/ch03.md)',
        'relative_site_root_add_hash',
        'ch03.md exists',
    ),

    # === RELATIVE: wrong ../ level (ch11.md references ch09) ===
    # ch11.md:11
    (   # Fix 8
        'ch11.md',
        '../ch09/07-metaspace.md',
        'ch09/07-metaspace.md',
        'relative_fix_level',
        'ch09/07-metaspace.md exists at correct path',
    ),

    # === RELATIVE: site root path without #/ (ch01/README.md) ===
    # ch01/README.md:1004
    (   # Fix 9
        'ch01/README.md',
        '(openjdk/vol-01/ch02.md)',
        '(#/openjdk/vol-01/ch02.md)',
        'relative_site_root_add_hash',
        'ch02.md exists',
    ),

    # === RELATIVE: missing .md extension (ch03/05-os-init2.md) ===
    # ch03/05-os-init2.md:858
    (   # Fix 10
        'ch03/05-os-init2.md',
        '../06-main-thread-create)',
        '../06-main-thread-create.md)',
        'relative_add_md',
        'ch03/06-main-thread-create.md exists',
    ),

    # === RELATIVE: target nonexistent (ch03/06-main-thread-create.md, image) ===
    # ch03/06-main-thread-create.md:1960
    (   # Fix 11
        'ch03/06-main-thread-create.md',
        '[线程栈守卫区域](../assets/线程栈守卫区域.png)',
        '[线程栈守卫区域](../assets/线程栈守卫区域.png)<!-- 404: target not found, 请作者补正文 -->',
        'relative_404',
        'N/A',
    ),

    # === RELATIVE: target nonexistent (ch04/02-management.md, image) ===
    # ch04/02-management.md:185
    (   # Fix 12
        'ch04/02-management.md',
        '[alt text](image.png)',
        '[alt text](image.png)<!-- 404: target not found, 请作者补正文 -->',
        'relative_404',
        'N/A',
    ),

    # === RELATIVE: wrong chapter + wrong path (ch12 references ch08/02-oopstorage) ===
    # ch12/02-string-table-create.md:108
    (   # Fix 13
        'ch12/02-string-table-create.md',
        '[ch08/02 OopStorage](../ch08/02-oopstorage.md)',
        '[ch09/02 OopStorage](../../ch09/02-oopstorage.md)',
        'relative_fix_level_and_chapter',
        'OopStorage is now in ch09 not ch08',
    ),

    # === RELATIVE: wrong ../ level (ch09/02-oopstorage.md references ch03, 2 occurrences) ===
    # ch09/02-oopstorage.md:7 and :41
    (   # Fix 14
        'ch09/02-oopstorage.md',
        '[ch03/background/handles-all.md](../../ch03/background/handles-all.md)',
        '[ch03/background/handles-all.md](../ch03/background/handles-all.md)',
        'relative_fix_level',
        'correct level from ch09/ is ../ch03/ (both occurrences)',
        True,  # replace_all
    ),

    # === RELATIVE: wrong ../ level (ch09/06-auxiliary-trivial.md references ch04) ===
    # ch09/06-auxiliary-trivial.md:5
    (   # Fix 16
        'ch09/06-auxiliary-trivial.md',
        '[ch04/02-management.md](../../ch04/02-management.md)',
        '[ch04/02-management.md](../ch04/02-management.md)',
        'relative_fix_level',
        'correct level from ch09/ is ../ch04/',
    ),

    # === RELATIVE: target nonexistent (ch14/01-interpreter-init.md, runtime_stubs.md) ===
    # ch14/01-interpreter-init.md:354
    (   # Fix 17
        'ch14/01-interpreter-init.md',
        '[ch17 SharedRuntime::generate_stubs](runtime_stubs.md)',
        '[ch17 SharedRuntime::generate_stubs](runtime_stubs.md)<!-- 404: target not found, 请作者补正文 -->',
        'relative_404',
        'N/A',
    ),

    # === RELATIVE: target nonexistent (ch14/PLAN.md, runtime_stubs.md) ===
    # ch14/PLAN.md:205
    (   # Fix 18
        'ch14/PLAN.md',
        '[ch17 SharedRuntime::generate_stubs](runtime_stubs.md)',
        '[ch17 SharedRuntime::generate_stubs](runtime_stubs.md)<!-- 404: target not found, 请作者补正文 -->',
        'relative_404',
        'N/A',
    ),
]

# Apply fixes — fixes can optionally specify replace_all via a 6th element
fixed_count = 0
four_o_four_count = 0
files_modified = set()

for item in fixes:
    file_rel = item[0]
    old_str = item[1]
    new_str = item[2]
    fix_type = item[3]
    note = item[4]
    replace_all = item[5] if len(item) > 5 else False

    file_path = os.path.join(VOL01, file_rel)
    if not os.path.isfile(file_path):
        print(f"SKIP: file not found: {file_path}")
        continue

    with open(file_path, 'r', encoding='utf-8') as f:
        content = f.read()

    if old_str not in content:
        print(f"SKIP: old_str not found in {file_rel}: {old_str[:60]}...")
        continue

    # Use replace_all for cases with multiple occurrences in same file
    if replace_all:
        count = content.count(old_str)
        content = content.replace(old_str, new_str)
        actual = count
    else:
        content = content.replace(old_str, new_str, 1)
        actual = 1

    with open(file_path, 'w', encoding='utf-8') as f:
        f.write(content)

    fixed_count += actual
    if '404' in fix_type:
        four_o_four_count += actual
    files_modified.add(file_rel)
    print(f"FIXED ({actual} occ): {file_rel} [{fix_type}] {note}")

print(f"\n{'='*60}")
print(f"Total fixes applied: {fixed_count}")
print(f"404 annotations added: {four_o_four_count}")
print(f"Files modified: {len(files_modified)}")
for f in sorted(files_modified):
    print(f"  {f}")
