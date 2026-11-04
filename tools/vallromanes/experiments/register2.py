"""Register a screenshot by aligning projected roof edges with image edges (coarse to fine)."""
import sys, json, math, random
import numpy as np
from PIL import Image, ImageFilter
sys.path.insert(0, 'tools/vallromanes/experiments')
from cam import Camera, local, load_scene

def edge_images(path):
    g = Image.open(path).convert('L')
    out = []
    for blur in (10, 5, 2.5):
        a = np.asarray(g.filter(ImageFilter.GaussianBlur(blur))).astype(float)
        gy, gx = np.gradient(a); m = np.hypot(gx, gy)
        m[:260, :400] = 0; m[:80] = 0; m[930:] = 0; m[740:, 1530:] = 0
        out.append(m / (m.max() + 1e-9))
    return out

def edge_points(B, cx, cz, rad):
    pts = []
    for b in B:
        if b['kind'] != 0: continue
        r = np.array(b['ring']).reshape(-1, 2)
        c = r.mean(0)
        if abs(c[0] - cx) > rad or abs(c[1] - cz) > rad: continue
        y = b['top'] - 0.4
        for i in range(len(r)):
            a, q = r[i], r[(i + 1) % len(r)]
            n = max(1, int(np.hypot(*(q - a)) / 2))
            for k in range(n):
                t = k / n; pts.append((a[0] + (q[0] - a[0]) * t, y, a[1] + (q[1] - a[1]) * t))
    return np.array(pts)

def score(pts, E, cam):
    p, z = cam.project(pts)
    ok = (z > 20) & (p[:, 0] > 2) & (p[:, 0] < 1597) & (p[:, 1] > 2) & (p[:, 1] < 997)
    if ok.sum() < 100: return -1
    q = p[ok].astype(int)
    return float(E[q[:, 1], q[:, 0]].mean())

if __name__ == '__main__':
    scene, img, out = sys.argv[1:4]
    lat, lon, d0, h0, t0, f0 = [float(v) for v in sys.argv[4:10]]
    ox, oz, rg = [int(v) for v in sys.argv[10:13]]
    ground = float(sys.argv[13])
    B = load_scene(scene); Es = edge_images(img)
    x0, z0 = local(lat, lon)
    pts = edge_points(B, x0 + ox, z0 + oz, 450)
    def cam_of(P):
        dx, dz, d, h, t, f = P
        return Camera((x0 + dx, ground, z0 + dz), d=d, h=h, t=t, fov=f)
    best, P = -1, None
    for dx in range(ox - rg, ox + rg + 1, 6):
        for dz in range(oz - rg, oz + rg + 1, 6):
            for dh in (-6, -3, 0, 3, 6):
                Q = (dx, dz, d0, h0 + dh, t0, f0)
                s = score(pts, Es[0], cam_of(Q))
                if s > best: best, P = s, list(Q)
    print('coarse', round(best, 4), [round(v, 1) for v in P])
    random.seed(2)
    for lvl, (E, step, n) in enumerate(zip(Es, ([8, 8, 10, 1.5, 1.5, 1.0], [3, 3, 5, 0.6, 0.6, 0.5], [1, 1, 2, 0.25, 0.25, 0.2]), (1500, 1500, 1500))):
        best = score(pts, E, cam_of(P))
        for it in range(n):
            Q = [p + random.gauss(0, s) for p, s in zip(P, step)]
            s = score(pts, E, cam_of(Q))
            if s > best: best, P = s, Q
        print('level', lvl, round(best, 4), [round(v, 2) for v in P])
    json.dump({'x0': x0, 'z0': z0, 'ground': ground, 'P': P}, open(out, 'w'))
