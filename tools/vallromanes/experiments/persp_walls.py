"""Wall colours of every building seen in a perspective screenshot: project each wall that faces the camera, drop pixels hidden by other
buildings or covered by vegetation, take the median colour."""
import sys, json, math, numpy as np, cv2
sys.path.insert(0, 'tools/vallromanes/experiments')
import persp_camera as C
from cam import load_scene

def faces(B, y0):
    """Wall quads and roof polygons in plane-relative coordinates. Returns list of dict(bid, kind, P (n,3), n (outward normal xz) for walls)."""
    out = []
    for bi, b in enumerate(B):
        r = np.array(b['ring']).reshape(-1, 2)
        area = 0.5 * np.sum(r[:, 0] * np.roll(r[:, 1], -1) - np.roll(r[:, 0], -1) * r[:, 1])
        eave = b['top'] - (b['rise'] or 0) * 0.55 - 0.3 if b['roof'] else b['top'] - 0.3
        lo = b['base'] + 0.4
        if eave - lo < 1.2: continue
        for i in range(len(r)):
            a, c = r[i], r[(i + 1) % len(r)]
            L = np.hypot(*(c - a))
            if L < 1.0: continue
            t = (c - a) / L; n = np.array([t[1], -t[0]]) * (1 if area > 0 else -1)
            out.append(dict(bid=bi, kind='wall', n=n, mid=(a + c) / 2, L=L, P=np.array([[a[0], lo - y0, a[1]], [c[0], lo - y0, c[1]], [c[0], eave - y0, c[1]], [a[0], eave - y0, a[1]]]), top=eave))
        out.append(dict(bid=bi, kind='roof', P=np.c_[r[:, 0], np.full(len(r), b['top'] - y0), r[:, 1]]))
    return out

def vegetation(a):
    b, g, r = [a[..., i].astype(np.float32) for i in range(3)]
    return ((g - np.maximum(r, b)) > 3) | (a.max(2) < 55)

def sample(B, cam, y0, img, size=(1600, 1000)):
    F = faces(B, y0); cpos = C.camera_position(cam) + [0, y0, 0]
    proj = []
    for f in F:
        p, z = C.project(cam, f['P'])
        if (z < 15).any(): continue
        if f['kind'] == 'wall':
            mid3 = np.array([f['mid'][0], f['top'] - 2, f['mid'][1]])
            if (f['n'] @ (cpos[[0, 2]] - f['mid'])) <= 0: continue  # faces away
        proj.append((float(z.mean()), f, p.round().astype(np.int32)))
    proj.sort(key=lambda q: -q[0])  # far to near
    ids = np.full((size[1], size[0]), -1, np.int32)
    for k, (_, f, p) in enumerate(proj):
        if f['kind'] == 'wall': cv2.fillConvexPoly(ids, p, k)
        else: cv2.fillPoly(ids, [p], -2 - f['bid'] * 0 - 1)  # roofs occlude but are never sampled (all -3)
    veg = vegetation(img)
    res = {}
    for k, (_, f, p) in enumerate(proj):
        if f['kind'] != 'wall': continue
        m = np.zeros((size[1], size[0]), np.uint8); cv2.fillConvexPoly(m, p, 1)
        m = cv2.erode(m, np.ones((3, 3), np.uint8)) > 0
        px = m & (ids == k) & ~veg
        px[:260, :420] = False; px[:90] = False; px[935:] = False; px[730:, 1530:] = False
        if px.sum() < 25: continue
        col = np.median(img[px].reshape(-1, 3), 0)
        pix = img[px].reshape(-1, 3)
        if len(pix) > 400: pix = pix[np.random.default_rng(k).choice(len(pix), 400, replace=False)]
        res.setdefault(f['bid'], []).append(dict(bgr=col.tolist(), n=int(px.sum()), L=float(f['L']), quad=p.tolist(), nx=float(f['n'][0]), nz=float(f['n'][1]), pix=pix.tolist(),
                                                 roof=float(f['top'])))
    return res

if __name__ == '__main__':
    scene, topimg, perimg, out = sys.argv[1:5]; fit = tuple(map(float, sys.argv[5:9])); f = float(sys.argv[9]); dy = float(sys.argv[10])
    B = [b for b in load_scene(scene) if b['kind'] == 0]
    pa, pb = C.match(topimg, perimg)
    cam = C.pose_from_ground(C.top_to_local(pa, fit), pb, f_fixed=f or None)
    base = np.median([b['base'] for b in B if abs(b['ring'][0] - fit[2]) < 150 and abs(b['ring'][1] - fit[3]) < 150]); y0 = base + dy
    img = cv2.imread(perimg)
    res = sample(B, cam, y0, img)
    print(len(res), 'buildings with a visible wall')
    json.dump({B[k]['id']: v for k, v in res.items()}, open(out + '.json', 'w'))
    # diagnostic: the walls painted with their sampled colour next to the photo
    render = img.copy() // 3
    for k, ws in res.items():
        tot = sum(w['n'] for w in ws)
        for w in ws: cv2.fillConvexPoly(render, np.array(w['quad'], np.int32), [int(v) for v in w['bgr']])
    cv2.imwrite(out + '.png', np.hstack([img, render]) if False else render)
