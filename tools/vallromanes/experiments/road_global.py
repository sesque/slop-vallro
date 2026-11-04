"""Global alignment of a nadir screenshot on the street network by template matching of road masks, then refinement."""
import sys, json, os
import numpy as np, cv2
sys.path.insert(0, 'tools/vallromanes/experiments')
import road_register as RR

R = 1.0  # px per metre, coarse
def road_raster(roads):
    allp = np.concatenate([e['pts'] for e in roads]); x0, z0 = allp.min(0) - 30; x1, z1 = allp.max(0) + 30
    M = np.zeros((int((z1 - z0) * R), int((x1 - x0) * R)), np.float32)
    for e in roads:
        cv2.polylines(M, [((e['pts'] - [x0, z0]) * R).round().astype(np.int32)], False, 1.0, max(3, int(2 * e['half'] * R)))
    return cv2.GaussianBlur(M, (0, 0), 2), x0, z0

def global_fit(img, roads, M, x0, z0, scales=np.arange(3.1, 3.5, 0.05), top=6):
    Rd, V = RR.roadness(img)
    cands = []
    for s in scales:
        k = R / s; sz = (int(1600 * k), int(1000 * k))
        t = cv2.resize(Rd, sz, interpolation=cv2.INTER_AREA); mk = cv2.resize(V, sz, interpolation=cv2.INTER_NEAREST)
        r = cv2.matchTemplate(M, t, cv2.TM_CCOEFF_NORMED, mask=mk); r[~np.isfinite(r)] = -1
        for _ in range(top):
            j = np.unravel_index(np.argmax(r), r.shape)
            left, topz = x0 + j[1] / R, z0 + j[0] / R
            cands.append((float(r[j]), [s, 0.0, left + 800 / s, topz + 500 / s]))
            cv2.circle(r, (j[1], j[0]), 20, -1, -1)
    cands.sort(key=lambda c: -c[0])
    return cands[:12]

if __name__ == '__main__':
    roads = RR.load_roads(); M, x0, z0 = road_raster(roads)
    out = {}
    for img in sys.argv[2:]:
        c = global_fit(img, roads, M, x0, z0)
        best = None
        for sc, fit in c[:8]:
            st, b, cur = RR.refine(img, fit, roads, iters=1600)
            if best is None or b > best[0]: best = (b, cur, sc)
        out[os.path.basename(img)] = dict(contrast=best[0], fit=best[1], ncc=best[2])
        json.dump(out, open(sys.argv[1], 'w'), indent=1)
        print(os.path.basename(img), 'ncc', round(best[2], 3), 'road contrast', round(best[0], 3), [round(x, 3) for x in best[1]], flush=True)
    json.dump(out, open(sys.argv[1], 'w'), indent=1)
