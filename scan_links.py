#!/usr/bin/env python3
"""Scan all markdown links in vol-01 (excluding archived/) and report broken ones."""

import os
import re
import sys

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
VOL01 = os.path.join(BASE_DIR, 'docs/openjdk/vol-01')

# Collect all existing .md files (excluding archived/)
all_files = set()
for root, dirs, files in os.walk(VOL01):
    # Skip archived directories
    dirs[:] = [d for d in dirs if d != 'archived']
    for f in files:
        if f.endswith('.md'):
            rel_path = os.path.relpath(os.path.join(root, f), VOL01)
            all_files.add(rel_path)

print(f"Total .md files (excluding archived): {len(all_files)}")

# Regex to find markdown links: [text](target)
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
                
                # Skip external URLs and anchors only
                if target.startswith(('http://', 'https://', 'mailto:')):
                    continue
                if target.startswith('#') and not target.startswith('#/'):
                    continue  # same-page anchors
                    
                # Classify the link
                category = None
                resolved = None
                
                if target.startswith('#/'):
                    # Hash route: #/openjdk/vol-01/...
                    category = 'hash_route'
                    # Remove #/ prefix and treat as site root relative
                    site_path = target[2:]  # e.g. openjdk/vol-01/ch05/01-xxx.md
                    # Check if this file exists under VOL01
                    # The hash route starts from the site root, which is the repo root
                    expected_path = os.path.join(BASE_DIR, site_path)
                    if not os.path.isfile(expected_path):
                        resolved = ('nonexistent_file', site_path)
                    else:
                        resolved = ('ok', site_path)
                        
                elif os.path.isabs(target):
                    category = 'absolute'
                    resolved = ('check', target)
                    
                else:
                    # Relative path
                    category = 'relative'
                    if not target.startswith('#'):
                        # Resolve relative to the file's directory
                        abs_target = os.path.normpath(os.path.join(file_dir, target))
                        # Strip anchor if present
                        target_clean = target.split('#')[0]
                        abs_target_clean = os.path.normpath(os.path.join(file_dir, target_clean))
                        
                        if os.path.isfile(abs_target_clean):
                            resolved = ('ok', os.path.relpath(abs_target_clean, VOL01))
                        else:
                            resolved = ('nonexistent_file', target)
                    else:
                        # Same-page anchor, skip
                        continue
                
                if resolved and resolved[0] == 'nonexistent_file':
                    results.append({
                        'file': rel_file,
                        'line': lineno,
                        'text': text,
                        'target': target,
                        'category': category,
                        'detail': resolved[1],
                    })

# Print results grouped by category
print(f"\nTotal broken links found: {len(results)}")
print("=" * 80)

by_category = {}
for r in results:
    by_category.setdefault(r['category'], []).append(r)

for cat, items in sorted(by_category.items()):
    print(f"\n--- {cat.upper()} ({len(items)} broken) ---")
    for item in items:
        print(f"  {item['file']}:{item['line']}")
        print(f"    [{item['text']}]({item['target']})")
        print()

sys.exit(0)
