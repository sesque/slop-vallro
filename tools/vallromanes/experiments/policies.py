"""Score wall-colour sampling rules: how well do two views of the same building agree, against two random buildings."""
import sys, json, glob, os, numpy as np, cv2
D = sys.argv[1]
def lab(px): return cv2.cvtColor(np.uint8(px).reshape(-1, 1, 3), cv2.COLOR_BGR2LAB).reshape(-1, 3).astype(float)
views = {}
for f in glob.glob(D + '/*.json'):
    if f.endswith('summary.json'): continue
    views[os.path.basename(f)[:-5]] = json.load(open(f))
def wall_stat(w, q, minn):
    if w['n'] < minn: return None
    L = lab(w['pix']); keep = L[:, 0] >= np.percentile(L[:, 0], 100 - q)
    return np.median(L[keep], 0)
def run(q, minn, norm, weight, chroma_only=False):
    per = {}
    for v, d in views.items():
        stats = {}
        for bid, ws in d.items():
            ss = [(wall_stat(w, q, minn), w['n']) for w in ws]; ss = [(s, n) for s, n in ss if s is not None]
            if ss: stats[bid] = (np.average([s for s, _ in ss], 0, weights=[n if weight else 1 for _, n in ss]), sum(n for _, n in ss))
        if norm and stats: g = np.median([s[0][0] for s in stats.values()]); stats = {b: (s[0] - [g - 128 * 0.5, 0, 0] if False else s[0] * [128 / g, 1, 1] if norm == 'gain' else s[0] - [g - 128, 0, 0], s[1]) for b, s in stats.items()}
        for b, s in stats.items(): per.setdefault(b, []).append(s[0])
    multi = {b: v for b, v in per.items() if len(v) >= 2}
    sl = slice(1, 3) if chroma_only else slice(0, 3)
    d = [np.linalg.norm(a[sl] - c[sl]) for v in multi.values() for i, a in enumerate(v) for c in v[i + 1:]]
    ks = list(per); rng = np.random.default_rng(0)
    r = [np.linalg.norm(per[ks[a]][0][sl] - per[ks[b]][0][sl]) for a, b in (rng.choice(len(ks), 2, replace=False) for _ in range(5000))]
    return len(per), len(multi), np.median(d), np.median(r), np.median(d) / np.median(r)
print('policy                          bldgs multi  same  random  ratio (lower = better)')
for name, args in [('median all (baseline)', (100, 25, None, False)), ('brightest 40%', (40, 25, None, False)), ('brightest 25%', (25, 25, None, False)),
                   ('brightest 40%, n>=80', (40, 80, None, False)), ('+ weight by size', (40, 80, None, True)), ('+ per-view gain', (40, 80, 'gain', True)), ('+ per-view offset', (40, 80, 'off', True)),
                   ('chroma only, bright 40%', (40, 80, None, True, True)), ('chroma only, all pixels', (100, 80, None, True, True))]:
    n, m, s, r, q = run(*args); print(f'{name:30s} {n:5d} {m:5d} {s:6.1f} {r:6.1f} {q:6.2f}')
