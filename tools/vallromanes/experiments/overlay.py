import sys, math, json
import numpy as np
from PIL import Image, ImageDraw
sys.path.insert(0, 'tools/vallromanes/experiments')
from cam import Camera, local, load_scene

scene, img_path, out = sys.argv[1], sys.argv[2], sys.argv[3]
lat, lon = float(sys.argv[4]), float(sys.argv[5])
kw = dict(d=float(sys.argv[6]), h=float(sys.argv[7]), t=float(sys.argv[8]), fov=float(sys.argv[9]))
dx, dz, dy = float(sys.argv[10]), float(sys.argv[11]), float(sys.argv[12])
B = load_scene(scene)
x, z = local(lat, lon); x += dx; z += dz
near = [b for b in B if abs(b['ring'][0] - x) < 60 and abs(b['ring'][1] - z) < 60]
gy = float(np.mean([b['base'] for b in near])) if near else 80.0
cam = Camera((x, gy + dy, z), **kw)
im = Image.open(img_path).convert('RGB'); dr = ImageDraw.Draw(im)
for b in B:
    r = np.array(b['ring']).reshape(-1, 2)
    if abs(r[:, 0].mean() - x) > 400 or abs(r[:, 1].mean() - z) > 400: continue
    for y, col in ((b['base'], (0, 255, 255)), (b['top'], (255, 255, 0))):
        P = np.stack([r[:, 0], np.full(len(r), y), r[:, 1]], 1)
        p, zc = cam.project(P)
        if (zc < 5).any(): continue
        dr.line([tuple(q) for q in p] + [tuple(p[0])], fill=col, width=1)
im.save(out); print('target', round(x, 1), round(z, 1), 'ground', round(gy, 1), 'near', len(near))
