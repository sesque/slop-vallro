"""Camera model for the Google Maps 3D screenshots (URL: @lat,lon,<a>a,<y>y,<h>h,<t>t) and the local frame (x east, y up, z south)."""
import math, json
import numpy as np

E0, N0, H0 = 441417.0, 4598030.0, 70.0

def utm31(lat, lon):
    a, f = 6378137.0, 1 / 298.257222101
    k0, lon0 = 0.9996, math.radians(3)
    e2 = f * (2 - f); ep2 = e2 / (1 - e2)
    phi, lam = math.radians(lat), math.radians(lon)
    N = a / math.sqrt(1 - e2 * math.sin(phi) ** 2)
    T = math.tan(phi) ** 2; C = ep2 * math.cos(phi) ** 2; A = math.cos(phi) * (lam - lon0)
    M = a * ((1 - e2/4 - 3*e2**2/64 - 5*e2**3/256) * phi - (3*e2/8 + 3*e2**2/32 + 45*e2**3/1024) * math.sin(2*phi)
             + (15*e2**2/256 + 45*e2**3/1024) * math.sin(4*phi) - (35*e2**3/3072) * math.sin(6*phi))
    E = k0 * N * (A + (1 - T + C) * A**3 / 6 + (5 - 18*T + T**2 + 72*C - 58*ep2) * A**5 / 120) + 500000
    Nn = k0 * (M + N * math.tan(phi) * (A**2 / 2 + (5 - T + 9*C + 4*C**2) * A**4 / 24 + (61 - 58*T + T**2 + 600*C - 330*ep2) * A**6 / 720))
    return E, Nn

def local(lat, lon):
    E, N = utm31(lat, lon)
    return E - E0, -(N - N0)  # x, z

class Camera:
    """target (x, y, z) in local metres; range d; heading h (deg, compass direction the camera looks), tilt t (deg from straight down), vertical fov."""
    def __init__(self, target, d=219.0, h=25.65, t=55.58, fov=35.0, size=(1600, 1000)):
        self.size = size
        hr, tr = math.radians(h), math.radians(t)
        # forward: horizontal compass direction (east = sin h, north = cos h), tilted down by (90 - t) below the horizon... t=0 looks straight down
        fe, fn, fu = math.sin(hr) * math.sin(tr), math.cos(hr) * math.sin(tr), -math.cos(tr)
        self.fwd = np.array([fe, fu, -fn])  # x east, y up, z = -north
        self.pos = np.array(target, float) - d * self.fwd
        up0 = np.array([0, 1.0, 0])
        r = np.cross(self.fwd, up0); r /= np.linalg.norm(r)
        u = np.cross(r, self.fwd)
        self.R = np.stack([r, u, self.fwd])  # rows: right, up, forward
        self.f = (size[1] / 2) / math.tan(math.radians(fov) / 2)

    def project(self, P):
        P = np.atleast_2d(P) - self.pos
        c = P @ self.R.T
        z = c[:, 2]
        px = self.size[0] / 2 + self.f * c[:, 0] / z
        py = self.size[1] / 2 - self.f * c[:, 1] / z
        return np.stack([px, py], 1), z

def load_scene(path):
    return json.load(open(path))['buildings']
