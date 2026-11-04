import sys, math, numpy as np, cv2
sys.path.insert(0, 'tools/vallromanes/experiments')
from cam import load_scene
scene, img, out = sys.argv[1:4]; s, th, tx, tz = map(float, sys.argv[4:8])
c, sn = math.cos(math.radians(th)), math.sin(math.radians(th))
im = cv2.imread(img)
for b in load_scene(scene):
    r = np.array(b['ring']).reshape(-1, 2); d = (r - [tx, tz]) * s
    p = np.stack([800 + c * d[:, 0] - sn * d[:, 1], 500 + sn * d[:, 0] + c * d[:, 1]], 1).round().astype(np.int32)
    if p[:, 0].max() < 0 or p[:, 0].min() > 1600 or p[:, 1].max() < 0 or p[:, 1].min() > 1000: continue
    cv2.polylines(im, [p], True, (0, 255, 255) if b['kind'] == 0 else (255, 255, 0), 2)
cv2.imwrite(out, im)
