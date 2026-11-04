"""For every screenshot pair: final top-view fit (road lock, else the 200 m grid guess refined on the roads), perspective camera, wall colours."""
import sys, json, os, math
import numpy as np, cv2
sys.path.insert(0, 'tools/vallromanes/experiments')
import road_register as RR, persp_camera as C, persp_walls as W
from cam import load_scene

scene, rfit, outdir = sys.argv[1:4]
fits = json.load(open(rfit)); center = fits['view_center.png']['fit']
roads = RR.load_roads(); B = [b for b in load_scene(scene) if b['kind'] == 0]
os.makedirs(outdir, exist_ok=True)
def grid(name):
    if name == 'center': return list(center)
    d, k = name[0], int(name[1:]); dx = dz = 0
    if d == 'E': dx = 200 * k
    if d == 'W': dx = -200 * k
    if d == 'N': dz = -200 * k
    if d == 'S': dz = 200 * k
    return [center[0], center[1], center[2] + dx, center[3] + dz]
summary = {}
for path in sorted(os.listdir('top_view')):
    name = path[5:-4]
    f = fits.get(path)
    if f and f['contrast'] > 0.2: fit, src = f['fit'], 'road lock'
    else:
        st, b, cur = RR.refine('top_view/' + path, grid(name), roads, iters=2000)
        fit, src = cur, f'grid guess refined (road contrast {b:.2f})'
    top, per = 'top_view/' + path, 'perspective/' + path
    pa, pb = C.match(top, per)
    Pg = C.top_to_local(pa, fit)
    try: cam = C.pose_from_ground(Pg, pb, f_fixed=1380)
    except Exception as e: print(name, 'pose failed', e); continue
    near = [b for b in B if abs(b['ring'][0] - fit[2]) < 150 and abs(b['ring'][1] - fit[3]) < 150]
    if not near: print(name, 'no buildings in view'); continue
    y0 = float(np.median([b['base'] for b in near])) + 6
    img = cv2.imread(per)
    res = W.sample(B, cam, y0, img)
    json.dump({B[k]['id']: v for k, v in res.items()}, open(f'{outdir}/{name}.json', 'w'))
    summary[name] = dict(fit=fit, src=src, inliers=cam['inliers'], matches=cam['n'], buildings=len(res))
    print(name, src, 'inliers', cam['inliers'], '/', cam['n'], 'buildings', len(res), flush=True)
json.dump(summary, open(f'{outdir}/summary.json', 'w'), indent=1)
