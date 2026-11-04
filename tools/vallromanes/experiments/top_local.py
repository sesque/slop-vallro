"""Diagnostic: per-building best shift (metres) between the model footprint and the roof pixels of a nadir screenshot."""
import sys, math, numpy as np, cv2
sys.path.insert(0, 'tools/vallromanes/experiments')
import top_register2 as T
from cam import load_scene
scene, img = sys.argv[1], sys.argv[2]; s, th, tx, tz = map(float, sys.argv[3:7])
Rm, V = T.roofiness(img)
c, sn = math.cos(math.radians(th)), math.sin(math.radians(th))
def px(P): d = (P - [tx, tz]) * s; return np.stack([800 + c * d[:, 0] - sn * d[:, 1], 500 + sn * d[:, 0] + c * d[:, 1]], 1)
out = []
for b in load_scene(scene):
    if b['kind'] != 0: continue
    r = np.array(b['ring']).reshape(-1, 2); p = px(r)
    if p[:, 0].min() < 60 or p[:, 0].max() > 1540 or p[:, 1].min() < 100 or p[:, 1].max() > 930: continue
    area = cv2.contourArea(p.astype(np.float32)) / s / s
    if area < 50: continue
    best = None
    for dx in np.arange(-12, 12.1, 1):
        for dz in np.arange(-12, 12.1, 1):
            q = px(r + [dx, dz]).round().astype(np.int32)
            m = np.zeros((1000, 1600), np.uint8); cv2.fillPoly(m, [q], 1)
            d = cv2.dilate(m, np.ones((15, 15))) - cv2.dilate(m, np.ones((3, 3)))
            ii, rr = (m > 0) & (V > 0), (d > 0) & (V > 0)
            if ii.sum() < 40 or rr.sum() < 40: continue
            v = Rm[ii].mean() - Rm[rr].mean()
            if best is None or v > best[0]: best = (v, dx, dz)
    m0 = np.zeros((1000, 1600), np.uint8); cv2.fillPoly(m0, [p.round().astype(np.int32)], 1)
    d0 = cv2.dilate(m0, np.ones((15, 15))) - cv2.dilate(m0, np.ones((3, 3)))
    base = Rm[(m0 > 0) & (V > 0)].mean() - Rm[(d0 > 0) & (V > 0)].mean() if ((m0 > 0) & (V > 0)).sum() > 40 else 0
    if best: out.append((best[0], best[1], best[2], base, area))
o = np.array(out); print(len(o), 'buildings')
good = o[o[:, 0] > 0.35]; print('strong matches', len(good))
print('shift dx median', np.median(good[:, 1]), 'dz median', np.median(good[:, 2]))
print('shift dx quartiles', np.percentile(good[:, 1], [10, 25, 75, 90]), 'dz', np.percentile(good[:, 2], [10, 25, 75, 90]))
print('mean contrast at fit', o[:, 3].mean().round(3), 'after best shift', o[:, 0].mean().round(3))
