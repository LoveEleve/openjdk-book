#!/usr/bin/env python3
"""Verify all links after fixes — correcting scanner to use docs/ prefix for hash routes."""

import os
import re

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
VOL01 = os.path.join(BASE_DIR, 'docs/openjdk/vol-01')

all_files = set()
for root, dirs, files in os.walk(VOL01):
    dirs[:] = [d for d in dirs if d != 'archived']
    for f in files:
        if f.endswith('.md'):
            all_files.add(os.path.relpath(os.path.join(root, f), VOL01))

link_re = re.compile(r'\[([^\]]*)\]\(([^)]+)\)')
results = []

for root, dirs, files in os.walk(VOL01):
    dirs[:] = [d for d in dirs if d != 'archived']
    for f in files:
        if not f.endswith('.md'):
            continue
        full_path = os.path.join(root, f)
        rel_file = os.path.relpath(full_path, VOL01)
        file_dir = os.path.dirname(full_path)

        with open(full_path, 'r', encoding='utf-8') as fh:
            lines = fh.readlines()

        for lineno, line in enumerate(lines, 1):
            for m in link_re.finditer(line):
                text = m.group(1)
                target = m.group(2)

                if target.startswith(('http://', 'https://', 'mailto:')):
                    continue

                if target.startswith('#/') and not target.startswith('#/'):
                    continue

                if target.startswith('#/'):
                    # Hash route: #/openjdk/vol-01/... → docs/openjdk/vol-01/...
                    site_path = target[2:]
                    # Strip anchor
                    path_only = site_path.split('?')[0].split('#')[0]
                    expected_path = os.path.join(BASE_DIR, 'docs', path_only)
                    if not os.path.isfile(expected_path):
                        results.append({
                            'file': rel_file, 'line': lineno, 'text': text,
                            'target': target, 'category': 'hash_route',
                            'detail': f'docs/{path_only}'
                        })
                elif target.startswith('#'):
                    continue  # same-page anchor
                else:
                    # Relative path
                    target_clean = target.split('#')[0].split('?')[0]
                    abs_target = os.path.normpath(os.path.join(file_dir, target_clean))
                    if not os.path.isfile(abs_target):
                        results.append({
                            'file': rel_file, 'line': lineno, 'text': text,
                            'target': target, 'category': 'relative',
                            'detail': os.path.relpath(abs_target, VOL01)
                        })

print(f"Total .md files: {len(all_files)}")
print(f"Total broken links (corrected scanner): {len(results)}")
print("=" * 80)

if results:
    by_cat = {}
    for r in results:
        by_cat.setdefault(r['category'], []).append(r)

    for cat, items in sorted(by_cat.items()):
        print(f"\n--- {cat.upper()} ({len(items)}) ---")
        for item in items:
            print(f"  {item['file']}:{item['line']}")
            print(f"    [{item['text']}]({item['target']})")
            print(f"    resolved: {item['detail']}")
            print()
else:
    print("All links OK!")
