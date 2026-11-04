import sys, random, numpy as np, cv2, math
sys.path.insert(0, 'tools/vallromanes/experiments')
import top_register2 as T
from cam import load_scene
scene, img = sys.argv[1], sys.argv[2]
s, left, top = map(float, sys.argv[3:6])
B = load_scene(scene); I, Rg = T.points(B, np.random.default_rng(0))
Rm, V = T.roofiness(img)
cx, cy = 800, 500
def sc(q):
    s, th, tx, tz = q  # image centre maps to model (tx, tz); rotation th (deg) clockwise
    c, sn = math.cos(math.radians(th)), math.sin(math.radians(th))
    def samp(P):
        d = (P - [tx, tz]) * s
        u = cx + c * d[:, 0] - sn * d[:, 1]; v = cy + sn * d[:, 0] + c * d[:, 1]
        p = np.stack([u, v], 1).round().astype(int)
        ok = (p[:, 0] >= 0) & (p[:, 0] < 1600) & (p[:, 1] >= 0) & (p[:, 1] < 1000)
        p = p[ok]; return p[V[p[:, 1], p[:, 0]] > 0]
    a, b = samp(I), samp(Rg)
    if len(a) < 2500 or len(b) < 5000: return -1
    return float(Rm[a[:, 1], a[:, 0]].mean() - Rm[b[:, 1], b[:, 0]].mean())
cur = [s, 0.0, left + cx / s, top + cy / s]; best = sc(cur); print('start', round(best, 4))
random.seed(5)
for st in ([0.15, 1.0, 12, 12], [0.06, 0.5, 5, 5], [0.03, 0.25, 2, 2], [0.01, 0.1, 1, 1]):
    for _ in range(1500):
        q = [c + random.gauss(0, x) for c, x in zip(cur, st)]
        v = sc(q)
        if v > best: best, cur = v, q
    print(round(best, 4), [round(x, 3) for x in cur])
