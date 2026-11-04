import sys, math, numpy as np, cv2
sys.path.insert(0, 'tools/vallromanes/experiments')
import road_register as RR
img, out = sys.argv[1:3]; s, th, tx, tz = map(float, sys.argv[3:7])
c, sn = math.cos(math.radians(th)), math.sin(math.radians(th))
im = cv2.imread(img); done = set()
for e in RR.load_roads():
    d = (e['pts'] - [tx, tz]) * s
    p = np.stack([800 + c * d[:, 0] - sn * d[:, 1], 500 + sn * d[:, 0] + c * d[:, 1]], 1).round().astype(np.int32)
    cv2.polylines(im, [p], False, (0, 0, 255), 2)
    if e['name'] and e['name'] not in done:
        for q in p:
            if 120 < q[0] < 1480 and 120 < q[1] < 880:
                cv2.putText(im, e['name'][:22], tuple(int(v) for v in q), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 255), 1); done.add(e['name']); break
cv2.imwrite(out, im)
