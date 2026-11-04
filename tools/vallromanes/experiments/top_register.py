"""Register the nadir (2D) Google screenshots to the model: north up, similarity (scale + shift), by normalised cross-correlation of edges."""
import sys, json, glob, os
import numpy as np, cv2
sys.path.insert(0, 'tools/vallromanes/experiments')
from cam import load_scene

R = 1.25  # px per metre of the coarse model raster

def model_raster(B):
    xs = np.concatenate([np.array(b['ring'])[0::2] for b in B]); zs = np.concatenate([np.array(b['ring'])[1::2] for b in B])
    x0, z0 = xs.min() - 50, zs.min() - 50
    W, H = int((xs.max() - xs.min() + 100) * R), int((zs.max() - zs.min() + 100) * R)
    M = np.zeros((H, W), np.uint8)
    for b in B:
        r = np.array(b['ring']).reshape(-1, 2)
        p = np.round((r - [x0, z0]) * R).astype(np.int32)
        cv2.polylines(M, [p], True, 255, 1)
    return cv2.GaussianBlur(M, (0, 0), 1.2), x0, z0

def edge_template(path, scale):
    g = cv2.imread(path, cv2.IMREAD_GRAYSCALE).astype(np.float32)
    mask = np.ones_like(g)
    mask[:260, :400] = 0; mask[:90] = 0; mask[935:] = 0; mask[730:, 1530:] = 0
    mask = cv2.erode(mask, np.ones((9, 9)))
    g = cv2.GaussianBlur(g, (0, 0), 2)
    gx, gy = cv2.Sobel(g, cv2.CV_32F, 1, 0), cv2.Sobel(g, cv2.CV_32F, 0, 1)
    m = np.hypot(gx, gy)
    k = R / scale  # image pixels -> raster pixels
    sz = (int(1600 * k), int(1000 * k))
    return cv2.resize(m, sz, interpolation=cv2.INTER_AREA), cv2.resize(mask, sz, interpolation=cv2.INTER_NEAREST)

def register(path, M, scales):
    best = (-1, None)
    for s in scales:
        t, mk = edge_template(path, s)
        res = cv2.matchTemplate(M.astype(np.float32), t.astype(np.float32), cv2.TM_CCORR_NORMED, mask=mk.astype(np.float32))
        # CCORR rewards bright areas; subtract the global trend with CCOEFF
        res2 = cv2.matchTemplate(M.astype(np.float32), t.astype(np.float32), cv2.TM_CCOEFF_NORMED, mask=mk.astype(np.float32))
        res2[~np.isfinite(res2)] = -1
        j = np.unravel_index(np.argmax(res2), res2.shape)
        if res2[j] > best[0]: best = (float(res2[j]), (s, j[1], j[0]))
    return best

if __name__ == '__main__':
    scene, outp = sys.argv[1], sys.argv[2]
    names = sys.argv[3:]
    B = [b for b in load_scene(scene)]
    M, x0, z0 = model_raster(B)
    out = {}
    for n in names:
        sc, (s, cx, cy) = register(n, M, np.arange(3.8, 5.45, 0.15))
        # image px (u, v) -> local (x, z):  x = x0 + (cx/R) + u / s ... template origin at raster (cx, cy), template px = u * R / s
        out[os.path.basename(n)] = {'score': sc, 's': float(s), 'x_left': x0 + cx / R, 'z_top': z0 + cy / R}
        print(n, round(sc, 3), 's', round(s, 2), 'left', round(x0 + cx / R, 1), 'top', round(z0 + cy / R, 1), flush=True)
    json.dump(out, open(outp, 'w'), indent=1)
