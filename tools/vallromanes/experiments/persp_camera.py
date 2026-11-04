"""Perspective camera of a Google screenshot from its nadir twin: feature matches -> ground-plane homography (local metres) -> pinhole pose."""
import math, numpy as np, cv2

def top_to_local(px, fit):
    """top-view pixels -> local (x, z). fit = (s, theta_deg, tx, tz), pixel = centre + R(th) (P - T) s"""
    s, th, tx, tz = fit
    c, sn = math.cos(math.radians(th)), math.sin(math.radians(th))
    d = (np.asarray(px, float) - [800, 500]) / s
    return np.stack([tx + c * d[:, 0] + sn * d[:, 1], tz - sn * d[:, 0] + c * d[:, 1]], 1)

def match(top_path, persp_path):
    a = cv2.imread(top_path, 0); b = cv2.imread(persp_path, 0)
    def mask(g):
        m = np.full(g.shape, 255, np.uint8); m[:260, :400] = 0; m[:90] = 0; m[935:] = 0; m[730:, 1530:] = 0; return m
    sift = cv2.SIFT_create(nfeatures=8000)
    ka, da = sift.detectAndCompute(a, mask(a)); kb, db = sift.detectAndCompute(b, mask(b))
    m = cv2.BFMatcher().knnMatch(da, db, k=2)
    good = [x for x, y in m if x.distance < 0.8 * y.distance]
    pa = np.float32([ka[x.queryIdx].pt for x in good]); pb = np.float32([kb[x.trainIdx].pt for x in good])
    return pa, pb

def pose_from_ground(Pg, pb, size=(1600, 1000), f_fixed=None):
    """Pg: (n,2) local (x, z) of the matches on the plane, pb: (n,2) perspective pixels. Returns dict(R, t, f) with world axes (x east, y up, z south), y relative to the plane."""
    cx, cy = size[0] / 2, size[1] / 2
    H, inl = cv2.findHomography(Pg.astype(np.float32), pb, cv2.RANSAC, 5.0)
    a, b, c3 = H[:, 0], H[:, 1], H[:, 2]
    cc = np.array([cx, cy]); ap, bp = a[:2] - cc * a[2], b[:2] - cc * b[2]
    f2 = -(ap @ bp) / (a[2] * b[2])
    f = f_fixed or math.sqrt(abs(f2))
    Ki = np.array([[1 / f, 0, -cx / f], [0, 1 / f, -cy / f], [0, 0, 1]])
    h1, h2, h3 = Ki @ a, Ki @ b, Ki @ c3
    lam = 2 / (np.linalg.norm(h1) + np.linalg.norm(h2))
    if h3[2] < 0: lam = -lam
    rx, rz, t = h1 * lam, h2 * lam, h3 * lam
    ry = np.cross(rz, rx)
    R = np.stack([rx, ry, rz], 1)  # columns: world x, y, z in camera coords
    U, _, Vt = np.linalg.svd(R); R = U @ Vt
    return dict(R=R, t=t, f=f, inliers=int(inl.sum()), n=len(Pg), H=H)

def project(cam, P, size=(1600, 1000)):
    """P (n,3) with y already relative to the plane height."""
    Pc = P @ cam['R'].T + cam['t']
    z = Pc[:, 2]
    return np.stack([size[0] / 2 + cam['f'] * Pc[:, 0] / z, size[1] / 2 + cam['f'] * Pc[:, 1] / z], 1), z

def camera_position(cam):
    return -cam['R'].T @ cam['t']
