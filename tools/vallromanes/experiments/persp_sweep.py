import sys, numpy as np, cv2
sys.path.insert(0, 'tools/vallromanes/experiments')
import persp_camera as C, top_register2 as T
from cam import load_scene
scene, topimg, perimg = sys.argv[1:4]; fit = tuple(map(float, sys.argv[4:8]))
B = [b for b in load_scene(scene) if b['kind'] == 0]
pa, pb = C.match(topimg, perimg)
Pg = C.top_to_local(pa, fit)
Rm, V = T.roofiness(perimg)
def contrast(cam, y0):
    ins, ring = 0.0, 0.0; ni = nr = 0
    for b in B:
        r = np.array(b['ring']).reshape(-1, 2)
        c = r.mean(0)
        P3 = np.c_[r[:, 0], np.full(len(r), b['top'] - y0), r[:, 1]]
        p, z = C.project(cam, P3)
        if (z < 20).any() or p[:, 0].min() < 0 or p[:, 0].max() > 1600 or p[:, 1].min() < 0 or p[:, 1].max() > 1000: continue
        m = np.zeros((1000, 1600), np.uint8); cv2.fillPoly(m, [p.round().astype(np.int32)], 1)
        d = cv2.dilate(m, np.ones((17, 17))) - cv2.dilate(m, np.ones((5, 5)))
        inn = (m > 0) & (V > 0); rg = (d > 0) & (V > 0)
        if inn.sum() < 30 or rg.sum() < 30: continue
        ins += Rm[inn].mean(); ring += Rm[rg].mean(); ni += 1
    return (ins - ring) / max(ni, 1), ni
base = np.median([b['base'] for b in B if abs(b['ring'][0] - fit[2]) < 150 and abs(b['ring'][1] - fit[3]) < 150])
print('median base', round(base, 1))
for f in (900, 1200, 1587, 2000):
    cam = C.pose_from_ground(Pg, pb, f_fixed=f)
    for dy in (0, 4, 8, 12):
        print('f', f, 'plane above ground', dy, contrast(cam, base + dy), flush=True)
