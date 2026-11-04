"""Find the camera of one screenshot: maximise the fraction of building roof samples that land on roof-coloured pixels."""
import sys, json, math, random
import numpy as np
from PIL import Image, ImageFilter
sys.path.insert(0, 'tools/vallromanes/experiments')
from cam import Camera, local, load_scene

def roof_mask(im):
    a = np.asarray(im.convert('RGB')).astype(float)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    m = (r > g + 22) & (r > b + 38) & (r > 90)      # terracotta / red-brown tile
    m[:260, :400] = False; m[:80, :] = False; m[930:, :] = False; m[760:1000, 1540:] = False  # Maps UI
    return Image.fromarray((m * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(5)), m

def samples(B, cx, cz, rad):
    S = []
    for b in B:
        if b['kind'] != 0 or b['roof'] == 0 and False: continue
        r = np.array(b['ring']).reshape(-1, 2)
        c = r.mean(0)
        if abs(c[0] - cx) > rad or abs(c[1] - cz) > rad: continue
        S.append((c[0], b['top'] + (b['rise'] or 0) * 0.3, c[1], b['roof']))
    return np.array(S)

def score(S, mask, cam):
    p, z = cam.project(S[:, :3])
    ok = (z > 20) & (p[:, 0] > 5) & (p[:, 0] < 1595) & (p[:, 1] > 5) & (p[:, 1] < 995)
    if ok.sum() < 8: return -1, 0
    q = p[ok].astype(int)
    hit = mask[q[:, 1], q[:, 0]] > 0
    w = S[ok, 3] > 0  # pitched roofs are the ones the tile mask can see
    return (hit[w].sum() - 0.3 * (~hit[w]).sum()) / max(w.sum(), 1) * math.sqrt(w.sum()), ok.sum()

if __name__ == '__main__':
    scene, img = sys.argv[1], sys.argv[2]
    lat, lon, d0, h0, t0, f0 = [float(v) for v in sys.argv[3:9]]
    B = load_scene(scene)
    pm, _ = roof_mask(Image.open(img)); mask = np.asarray(pm)
    x0, z0 = local(lat, lon)
    S = samples(B, x0 + int(sys.argv[10]), z0 + int(sys.argv[11]), 500)
    def cam_of(P):
        dx, dz, d, h, t, f = P
        return Camera((x0 + dx, 85.0, z0 + dz), d=d, h=h, t=t, fov=f)
    best, bp = -9, None
    cx, cz, rg = [int(v) for v in sys.argv[10:13]]  # search window around an offset from the URL point
    for dx in range(cx - rg, cx + rg + 1, 10):
        for dz in range(cz - rg, cz + rg + 1, 10):
            s, n = score(S, mask, cam_of((dx, dz, d0, h0, t0, f0)))
            if s > best: best, bp = s, (dx, dz, d0, h0, t0, f0)
    print('coarse', round(best, 2), bp)
    P = list(bp); step = [30, 30, 25, 3, 3, 3]
    random.seed(1)
    for it in range(6000):
        Q = [p + random.gauss(0, s * (0.3 if it > 3000 else 1)) for p, s in zip(P, step)]
        Q[4] = min(max(Q[4], 20), 80); Q[5] = min(max(Q[5], 20), 50)
        s, n = score(S, mask, cam_of(Q))
        if s > best: best, P = s, Q
    print('fit', round(best, 2), [round(v, 2) for v in P])
    json.dump({'x0': x0, 'z0': z0, 'P': P, 'score': best}, open(sys.argv[9], 'w'))
