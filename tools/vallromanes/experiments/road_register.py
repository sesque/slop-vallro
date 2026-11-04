"""Align a nadir screenshot to the model on the street network: road centrelines must run over road-coloured pixels
(low saturation, mid brightness, not green), with the pixels beside them not road-coloured."""
import sys, json, math, random
import numpy as np, cv2

def load_roads(path='data/roads.json'):
    d = json.load(open(path))
    return [dict(name=e['name'], half=max(e['halfL'], e['halfR'], 2.5), pts=np.array([[p[0], p[1]] for p in e["pts"]])) for e in d['edges']]

def roadness(path):
    a = cv2.imread(path); hsv = cv2.cvtColor(a, cv2.COLOR_BGR2HSV).astype(np.float32)
    h, s, v = hsv[..., 0], hsv[..., 1] / 255, hsv[..., 2]
    b, g, r = [a[..., i].astype(np.float32) for i in range(3)]
    road = (s < 0.28) & (v > 95) & (v < 215) & ((g - np.maximum(r, b)) < 6)
    valid = np.ones(road.shape, np.float32)
    valid[:260, :400] = 0; valid[:90] = 0; valid[935:] = 0; valid[730:, 1530:] = 0
    white = (a.min(2) > 225); valid[cv2.dilate(white.astype(np.uint8), np.ones((7, 7))) > 0] = 0  # street names are white
    return cv2.GaussianBlur(road.astype(np.float32), (0, 0), 2), valid

def samples(roads, step=2.0):
    on, off = [], []
    for e in roads:
        p = e['pts']
        for i in range(len(p) - 1):
            a, b = p[i], p[i + 1]; L = np.hypot(*(b - a)); n = max(1, int(L / step))
            t = (b - a) / max(L, 1e-9); nrm = np.array([-t[1], t[0]])
            for k in range(n):
                c = a + (b - a) * (k / n)
                on.append(c)
                off.append(c + nrm * (e['half'] + 4)); off.append(c - nrm * (e['half'] + 4))
    return np.array(on), np.array(off)

def score(fit, on, off, Rd, V):
    s, th, tx, tz = fit
    c, sn = math.cos(math.radians(th)), math.sin(math.radians(th))
    def samp(P):
        d = (P - [tx, tz]) * s
        p = np.stack([800 + c * d[:, 0] - sn * d[:, 1], 500 + sn * d[:, 0] + c * d[:, 1]], 1).round().astype(int)
        ok = (p[:, 0] >= 0) & (p[:, 0] < 1600) & (p[:, 1] >= 0) & (p[:, 1] < 1000)
        p = p[ok]; return p[V[p[:, 1], p[:, 0]] > 0]
    a, b = samp(on), samp(off)
    if len(a) < 300 or len(b) < 600: return -1
    return float(Rd[a[:, 1], a[:, 0]].mean() - Rd[b[:, 1], b[:, 0]].mean())

def refine(img, fit0, roads, span=(25, 25, 4, 0.6), iters=2500):
    Rd, V = roadness(img); on, off = samples(roads)
    cur = list(fit0); best = score(cur, on, off, Rd, V); start = best
    random.seed(7)
    for st in ([0.12, 0.7, 8, 8], [0.05, 0.3, 3, 3], [0.02, 0.12, 1.2, 1.2], [0.008, 0.05, 0.5, 0.5]):
        for _ in range(iters // 2):
            q = [c + random.gauss(0, x) for c, x in zip(cur, st)]
            v = score(q, on, off, Rd, V)
            if v > best: best, cur = v, q
    return start, best, cur

if __name__ == '__main__':
    img = sys.argv[1]; fit0 = list(map(float, sys.argv[2:6]))
    roads = load_roads()
    st, b, cur = refine(img, fit0, roads)
    print('road contrast start', round(st, 4), 'fit', round(b, 4), [round(x, 3) for x in cur])
