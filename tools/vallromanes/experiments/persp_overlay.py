import sys, numpy as np, cv2
sys.path.insert(0, 'tools/vallromanes/experiments')
import persp_camera as C
from cam import load_scene
scene, topimg, perimg, out = sys.argv[1:5]; fit = tuple(map(float, sys.argv[5:9])); f = float(sys.argv[9]); dy = float(sys.argv[10])
B = [b for b in load_scene(scene) if b['kind'] == 0]
pa, pb = C.match(topimg, perimg)
cam = C.pose_from_ground(C.top_to_local(pa, fit), pb, f_fixed=f or None)
base = np.median([b['base'] for b in B if abs(b['ring'][0] - fit[2]) < 150 and abs(b['ring'][1] - fit[3]) < 150]); y0 = base + dy
im = cv2.imread(perimg)
for b in B:
    r = np.array(b['ring']).reshape(-1, 2)
    for y, col in ((b['base'], (0, 255, 255)), (b['top'], (0, 0, 255))):
        p, z = C.project(cam, np.c_[r[:, 0], np.full(len(r), y - y0), r[:, 1]])
        if (z < 20).any(): continue
        cv2.polylines(im, [p.round().astype(np.int32)], True, col, 2)
cv2.imwrite(out, im); print('f', round(cam['f']), 'inl', cam['inliers'], 'cam', C.camera_position(cam).round(0))
