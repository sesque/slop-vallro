"""Refine (s, left, top) of a nadir screenshot around a guess by maximising the edge strength under the footprint outlines."""
import sys, json, numpy as np, cv2, random
sys.path.insert(0, 'tools/vallromanes/experiments')
from cam import load_scene

def prep(path):
    g = cv2.GaussianBlur(cv2.imread(path, cv2.IMREAD_GRAYSCALE).astype(np.float32), (0, 0), 2.5)
    m = np.hypot(cv2.Sobel(g, cv2.CV_32F, 1, 0), cv2.Sobel(g, cv2.CV_32F, 0, 1))
    m[:260, :400] = 0; m[:90] = 0; m[935:] = 0; m[730:, 1530:] = 0
    return m / m.max()

def samples(B, step=1.5):
    P = []
    for b in B:
        r = np.array(b['ring']).reshape(-1, 2)
        for i in range(len(r)):
            a, q = r[i], r[(i + 1) % len(r)]
            n = max(1, int(np.hypot(*(q - a)) / step))
            P.append(a + (q - a) * (np.arange(n)[:, None] / n))
    return np.concatenate(P)

def score(P, E, s, left, top):
    p = np.round((P - [left, top]) * s).astype(int)
    ok = (p[:, 0] >= 0) & (p[:, 0] < 1600) & (p[:, 1] >= 0) & (p[:, 1] < 1000)
    if ok.sum() < 300: return -1
    return float(E[p[ok, 1], p[ok, 0]].mean())

def refine(path, P, s, left, top, rng=(40, 0.5)):
    E = prep(path)
    best = score(P, E, s, left, top); cur = [s, left, top]
    for dx in np.arange(-rng[0], rng[0] + 0.1, 2):
        for dz in np.arange(-rng[0], rng[0] + 0.1, 2):
            for ds in np.arange(-rng[1], rng[1] + 0.01, 0.1):
                c = score(P, E, s + ds, left + dx, top + dz)
                if c > best: best, cur = c, [s + ds, left + dx, top + dz]
    random.seed(1)
    for st in ([1, 0.04], [0.4, 0.015], [0.15, 0.006]):
        for _ in range(1200):
            q = [cur[0] + random.gauss(0, st[1]), cur[1] + random.gauss(0, st[0]), cur[2] + random.gauss(0, st[0])]
            c = score(P, E, *q)
            if c > best: best, cur = c, q
    return best, cur

if __name__ == '__main__':
    scene, img = sys.argv[1], sys.argv[2]
    s, left, top = map(float, sys.argv[3:6])
    P = samples(load_scene(scene))
    print('guess', round(score(P, prep(img), s, left, top), 4))
    b, c = refine(img, P, s, left, top)
    print('fit', round(b, 4), [round(v, 3) for v in c])
