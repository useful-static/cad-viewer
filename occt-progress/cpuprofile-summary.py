#!/usr/bin/env python3
"""Where a converter run spends its time, from a `node --cpu-prof` profile.

Profile a conversion with a build made by `build.sh --profiling` (function
names kept), e.g.

  node --cpu-prof --cpu-prof-dir=DIR --cpu-prof-interval 20000 \\
       stp2mesh.mjs --occt <out-prof> models/rack-260930.stp -o /tmp/x.cadmesh

then summarise it:

  cpuprofile-summary.py DIR/<file>.cpuprofile [--top N] [--match REGEX] [--callers NAME]

Prints, per function, its SELF time (samples where it is the leaf) and its
INCLUSIVE time (samples where it is anywhere on the stack, counted once per
sample however deep the recursion), in seconds and as a share of the run.
--match keeps the functions whose name matches; --callers NAME splits NAME's
inclusive time by its immediate caller. Exit 0; 2 on a file it cannot read.
"""
import argparse
import collections
import json
import re
import sys


def load(path):
    with open(path) as f:
        p = json.load(f)
    nodes = {n['id']: n for n in p['nodes']}
    parent = {}
    for n in p['nodes']:
        for c in n.get('children', []):
            parent[c] = n['id']
    return p, nodes, parent


def name_of(n):
    cf = n['callFrame']
    return cf.get('functionName') or f"(anonymous {cf.get('url', '').rsplit('/', 1)[-1]}:{cf.get('lineNumber', 0)})"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('profile')
    ap.add_argument('--top', type=int, default=40)
    ap.add_argument('--match', default=None, help='only functions whose name matches this regex')
    ap.add_argument('--callers', default=None, help="split this function's inclusive time by caller")
    args = ap.parse_args()
    try:
        p, nodes, parent = load(args.profile)
    except (OSError, ValueError, KeyError) as e:
        print(f'cannot read {args.profile}: {e}', file=sys.stderr)
        return 2
    samples, deltas = p.get('samples', []), p.get('timeDeltas', [])
    # each sample's time: the gap to the next one (the last gets the mean)
    total_us = sum(deltas[1:]) if len(deltas) > 1 else 0
    mean = total_us / max(1, len(deltas) - 1)
    times = [deltas[i + 1] if i + 1 < len(deltas) else mean for i in range(len(samples))]
    self_t = collections.Counter()
    incl_t = collections.Counter()
    callers = collections.Counter()
    for sid, t in zip(samples, times):
        n = nodes.get(sid)
        if not n:
            continue
        self_t[name_of(n)] += t
        seen = set()
        cur, child_name = sid, None
        while cur is not None:
            nm = name_of(nodes[cur])
            if nm not in seen:
                incl_t[nm] += t
                seen.add(nm)
            if args.callers and child_name == args.callers:
                callers[nm] += t
            child_name = nm
            cur = parent.get(cur)
    secs = lambda us: us / 1e6  # noqa: E731
    tot = sum(times) or 1
    print(f'profile {args.profile}: {len(samples)} samples, {secs(tot):.2f} s')
    rx = re.compile(args.match) if args.match else None
    rows = [(nm, incl_t[nm], self_t[nm]) for nm in incl_t if not rx or rx.search(nm)]
    rows.sort(key=lambda r: -r[1])
    print(f"{'inclusive s':>11} {'%':>5} {'self s':>8}  function")
    for nm, inc, slf in rows[:args.top]:
        print(f'{secs(inc):11.2f} {100 * inc / tot:5.1f} {secs(slf):8.2f}  {nm[:140]}')
    if args.callers:
        print(f'\ncallers of {args.callers} ({secs(incl_t[args.callers]):.2f} s inclusive):')
        for nm, t in callers.most_common(args.top):
            print(f'{secs(t):11.2f}  {nm[:140]}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
