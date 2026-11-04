"""Register nadir screenshots by roof-likeness: footprints should sit on pixels that are neither vegetation nor dark, and their surroundings should not.
Global search by template matching of filled footprints, then local refinement of the inside-minus-ring contrast."""
import sys, json, os, random
import numpy as np, cv2
sys.path.insert(0, 'tools/vallromanes/experiments')
from cam import load_scene

R = 1.25
def roofiness(path):
    a = cv2.imread(path).astype(np.float32); b, g, r = a[..., 0], a[..., 1], a[..., 2]
    veg = (g - np.maximum(r, b)) > 4
    dark = a.max(2) < 85
    blue = (b - np.maximum(r, g)) > 25  # pools
    m = (~veg & ~dark & ~blue).astype(np.float32)
    valid = np.ones_like(m)
    valid[:260, :400] = 0; valid[:90] = 0; valid[935:] = 0; valid[730:, 1530:] = 0
    # text labels are white; drop very bright, unsaturated pixels from both
    white = (a.min(2) > 215); valid[cv2.dilate(white.astype(np.uint8), np.ones((5, 5))) > 0] = 0
    return cv2.GaussianBlur(m, (0, 0), 1.5), valid

def build(B):
    xs = np.concatenate([np.array(b['ring'])[0::2] for b in B]); zs = np.concatenate([np.array(b['ring'])[1::2] for b in B])
    x0, z0 = xs.min() - 60, zs.min() - 60
    W, H = int((xs.max() - xs.min() + 120) * R), int((zs.max() - zs.min() + 120) * R)
    M = np.zeros((H, W), np.uint8)
    for b in B:
        r = np.array(b['ring']).reshape(-1, 2)
        cv2.fillPoly(M, [np.round((r - [x0, z0]) * R).astype(np.int32)], 255)
    return M, x0, z0

def points(B, rng):
    ins, ring = [], []
    for b in B:
        r = np.array(b['ring']).reshape(-1, 2)
        x0, z0 = r.min(0) - 6
        w, h = int((r[:, 0].max() + 6 - x0) * 2), int((r[:, 1].max() + 6 - z0) * 2)
        if w > 400 or h > 400: continue
        m = np.zeros((h + 1, w + 1), np.uint8); cv2.fillPoly(m, [np.round((r - [x0, z0]) * 2).astype(np.int32)], 1)
        inner = cv2.erode(m, np.ones((3, 3)))  # 0.5 m inside the edge
        d_in = cv2.dilate(m, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))); d_out = cv2.dilate(m, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (21, 21)))
        for src, dst, k in ((inner, ins, 6), ((d_out > 0) & (d_in == 0), ring, 4)):
            yy, xx = np.nonzero(src)
            if len(xx) == 0: continue
            sel = rng.choice(len(xx), min(len(xx), max(3, len(xx) // k)), replace=False)
            dst.append(np.stack([x0 + xx[sel] / 2, z0 + yy[sel] / 2], 1))
    return np.concatenate(ins), np.concatenate(ring)

def contrast(I, Rg, V, s, left, top):
    def samp(P):
        p = np.round((P - [left, top]) * s).astype(int)
        ok = (p[:, 0] >= 0) & (p[:, 0] < 1600) & (p[:, 1] >= 0) & (p[:, 1] < 1000)
        p = p[ok]; ok2 = V[p[:, 1], p[:, 0]] > 0
        return p[ok2]
    a, b = samp(I), samp(Rg)
    if len(a) < 2500 or len(b) < 5000: return -1
    return float(Rm[a[:, 1], a[:, 0]].mean() - Rm[b[:, 1], b[:, 0]].mean())

if __name__ == '__main__':
    scene, outp = sys.argv[1], sys.argv[2]
    B = load_scene(scene); M, mx0, mz0 = build(B)
    rng = np.random.default_rng(0); I, Rg = points(B, rng)
    print(len(I), len(Rg), 'sample points', flush=True)
    res = {}
    for path in sys.argv[3:]:
        Rm, V = roofiness(path)
        best = (-9, None)
        for s in np.arange(4.4, 5.5, 0.1):
            k = R / s; sz = (int(1600 * k), int(1000 * k))
            t = cv2.resize(Rm, sz, interpolation=cv2.INTER_AREA); mk = cv2.resize(V, sz, interpolation=cv2.INTER_NEAREST)
            r = cv2.matchTemplate(M.astype(np.float32) / 255, t, cv2.TM_CCOEFF_NORMED, mask=mk)
            r[~np.isfinite(r)] = -1
            for _ in range(8):  # top peaks per scale
                j = np.unravel_index(np.argmax(r), r.shape)
                cand = [s, mx0 + j[1] / R, mz0 + j[0] / R]
                c = contrast(I, Rg, V, *cand)
                if c > best[0]: best = (c, cand)
                cv2.circle(r, (j[1], j[0]), 25, -1, -1)
        c, cur = best
        random.seed(1)
        for st in ([2, 0.05], [0.6, 0.02], [0.2, 0.008]):
            for _ in range(700):
                q = [cur[0] + random.gauss(0, st[1]), cur[1] + random.gauss(0, st[0]), cur[2] + random.gauss(0, st[0])]
                cq = contrast(I, Rg, V, *q)
                if cq > c: c, cur = cq, q
        res[os.path.basename(path)] = {'contrast': c, 's': cur[0], 'left': cur[1], 'top': cur[2]}
        print(os.path.basename(path), round(c, 3), [round(v, 3) for v in cur], flush=True)
    json.dump(res, open(outp, 'w'), indent=1)
