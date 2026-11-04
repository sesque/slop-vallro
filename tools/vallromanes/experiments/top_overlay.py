import sys, json, numpy as np, cv2
sys.path.insert(0, 'tools/vallromanes/experiments')
from cam import load_scene
scene, img, out, s, left, top = sys.argv[1], sys.argv[2], sys.argv[3], *map(float, sys.argv[4:7])
im = cv2.imread(img)
for b in load_scene(scene):
    r = np.array(b['ring']).reshape(-1, 2)
    p = np.round((r - [left, top]) * s).astype(np.int32)
    if p[:, 0].max() < 0 or p[:, 0].min() > 1600 or p[:, 1].max() < 0 or p[:, 1].min() > 1000: continue
    cv2.polylines(im, [p], True, (0, 255, 255) if b['kind'] == 0 else (255, 255, 0), 2)
cv2.imwrite(out, im)
