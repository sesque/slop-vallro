#!/usr/bin/env python3
"""
Vallromanes façade pipeline (no Mapillary).

Stages (run in order; each can be rerun safely):

  python pipeline.py vectors   # streets (OSM) + buildings & addresses (Catastro INSPIRE)
  python pipeline.py photos    # Catastro façade photo for every parcel (resumable)
  python pipeline.py link      # join everything into output/vallromanes.gpkg + CSV
  python pipeline.py all       # the three stages in sequence

Useful options for the photos stage:
  --limit 200                  # process only the next 200 pending parcels (a batch)
  --street "CONSOL BALET"      # only parcels with an address on that street
  --retry-errors               # also retry parcels that failed in earlier runs

Requirements (Miniforge / conda):
  conda install -c conda-forge geopandas pyogrio requests

All projected data uses EPSG:25831 (ETRS89 / UTM zone 31N), the system used by
the Catastro and ICGC in Catalonia, so it can be aligned with your 3D model.
"""

import argparse
import re
import sqlite3
import sys
import time
import unicodedata
import xml.etree.ElementTree as ET
import zipfile
from datetime import datetime
from pathlib import Path

import geopandas as gpd
import pandas as pd
import requests
from shapely.geometry import LineString, Point

# ----------------------------------------------------------------- settings
MUNICIPALITY = "Vallromanes"
PROVINCE_CODE = "08"            # Catastro territorial office: Barcelona
CRS = "EPSG:25831"
PAUSE_S = 1.0                   # seconds between Catastro photo requests
MAX_ATTEMPTS = 3                # per parcel, across runs
ADDRESS_MATCH_MAX_M = 30        # nearest-building search radius for addresses

DATA = Path("data")
RAW = DATA / "raw"
PHOTOS = DATA / "photos"
STATE_DB = DATA / "state.sqlite"
VECTORS = DATA / "vectors.gpkg"
OUTPUT = Path("output")

HEADERS = {"User-Agent": "vallromanes-facade-pipeline/1.0 (personal 3D model project)"}

ATOM_FEEDS = {
    "BU": "https://www.catastro.hacienda.gob.es/INSPIRE/buildings/ES.SDGC.BU.atom.xml",
    "AD": "https://www.catastro.hacienda.gob.es/INSPIRE/Addresses/ES.SDGC.AD.atom.xml",
}
CAT_PHOTO_URL = ("https://ovc.catastro.meh.es/OVCServWeb/OVCWcfLibres/"
                 "OVCFotoFachada.svc/RecuperarFotoFachadaGet")
OVERPASS_MIRRORS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]

# Urban cadastral parcel reference: 7 digits + 2 letters + 4 digits + 1 letter
RC_URBAN = re.compile(r"\d{7}[A-Z]{2}\d{4}[A-Z]")


# ----------------------------------------------------------------- helpers
def log(msg):
    print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)


def normalise(text):
    text = unicodedata.normalize("NFKD", str(text or "")).encode("ascii", "ignore").decode()
    return text.upper().strip()


def http_get(url, retries=3, **kw):
    """GET with retries and increasing waits for transient errors."""
    kw.setdefault("headers", HEADERS)
    kw.setdefault("timeout", 60)
    for attempt in range(1, retries + 1):
        try:
            r = requests.get(url, **kw)
            if r.status_code in (429, 500, 502, 503, 504):
                raise requests.HTTPError(f"HTTP {r.status_code}")
            r.raise_for_status()
            return r
        except requests.RequestException as e:
            if attempt == retries:
                raise
            wait = 5 * attempt
            log(f"   {e} -> retry {attempt}/{retries - 1} in {wait}s")
            time.sleep(wait)


def strip_tag(tag):
    return tag.split("}", 1)[1] if "}" in tag else tag


def gml_id(el):
    for k, v in el.attrib.items():
        if strip_tag(k) == "id":
            return v
    return ""


def href(el):
    for k, v in el.attrib.items():
        if strip_tag(k) == "href":
            return v
    return None


# ================================================================= stage 1
# ----------------------------------------------------------------- streets
def download_streets():
    query = f"""
    [out:json][timeout:120];
    area["name"="{MUNICIPALITY}"]["boundary"="administrative"]["admin_level"="8"]->.a;
    way(area.a)["highway"];
    out geom;
    """
    for url in OVERPASS_MIRRORS:
        for attempt in range(1, 4):
            try:
                r = requests.post(url, data={"data": query}, headers=HEADERS, timeout=180)
                if r.status_code in (429, 502, 503, 504):
                    raise requests.HTTPError(f"HTTP {r.status_code}")
                r.raise_for_status()
                ways = r.json().get("elements", [])
                rows = []
                for w in ways:
                    coords = [(p["lon"], p["lat"]) for p in w.get("geometry", [])]
                    if len(coords) < 2:
                        continue
                    tags = w.get("tags", {})
                    rows.append({"osm_id": w["id"], "name": tags.get("name", ""),
                                 "highway": tags.get("highway", ""),
                                 "geometry": LineString(coords)})
                log(f"OSM ({url}): {len(rows)} street segments")
                return gpd.GeoDataFrame(rows, crs="EPSG:4326").to_crs(CRS)
            except (requests.RequestException, ValueError) as e:
                wait = 10 * attempt
                log(f"   Overpass {url} failed ({e}); retry in {wait}s")
                time.sleep(wait)
    log("WARNING: could not download streets from any Overpass server; "
        "continuing without the streets layer (rerun 'vectors' later).")
    return None


# ----------------------------------------------------------------- Catastro ATOM
def atom_entries(url):
    """Return [(title, [hrefs])] for every <entry> of an Atom feed."""
    root = ET.fromstring(http_get(url).content)
    out = []
    for e in root.iter():
        if strip_tag(e.tag) != "entry":
            continue
        title, hrefs = "", []
        for c in e:
            t = strip_tag(c.tag)
            if t == "title":
                title = c.text or ""
            elif t == "link" and c.get("href"):
                hrefs.append(c.get("href"))
            elif t == "id" and (c.text or "").startswith("http"):
                hrefs.append(c.text.strip())
        out.append((title, hrefs))
    return out


def download_catastro_dataset(kind):
    """Download and extract the INSPIRE zip of one dataset (BU or AD)."""
    target = RAW / kind
    if target.exists() and any(target.glob("*.gml")):
        log(f"Catastro {kind}: already downloaded ({target})")
        return target

    log(f"Catastro {kind}: reading national feed")
    prov_feed = None
    for title, hrefs in atom_entries(ATOM_FEEDS[kind]):
        for h in hrefs:
            if f"/{PROVINCE_CODE}/" in h and h.lower().endswith(".xml"):
                prov_feed = h
                break
        if prov_feed:
            break
    if not prov_feed:
        raise SystemExit(f"Province {PROVINCE_CODE} not found in {ATOM_FEEDS[kind]}")

    log(f"Catastro {kind}: reading province feed {prov_feed}")
    zip_url = None
    key = normalise(MUNICIPALITY)
    for title, hrefs in atom_entries(prov_feed):
        if key in normalise(title) or any(key in normalise(h) for h in hrefs):
            zip_url = next((h for h in hrefs if h.lower().endswith(".zip")), None)
            if zip_url:
                break
    if not zip_url:
        raise SystemExit(f"{MUNICIPALITY} not found in {prov_feed}")

    log(f"Catastro {kind}: downloading {zip_url}")
    target.mkdir(parents=True, exist_ok=True)
    zpath = target / Path(zip_url).name
    zpath.write_bytes(http_get(zip_url, timeout=300).content)
    with zipfile.ZipFile(zpath) as z:
        z.extractall(target)
    log(f"Catastro {kind}: extracted {len(list(target.glob('*.gml')))} GML file(s)")
    return target


def read_layer(path, layer):
    try:
        return gpd.read_file(path, layer=layer)
    except Exception:
        return gpd.read_file(path)


def rc_from_id(value):
    """Catastro building ids look like 'ES.SDGC.BU.2251824CS7425S' -> RC14."""
    last = str(value).split(".")[-1]
    m = RC_URBAN.search(last) or re.search(r"[0-9A-Z]{14}", last)
    return m.group(0) if m else last[:14]


def load_buildings(bu_dir):
    bpath = next(bu_dir.glob("*building.gml"), None)
    if bpath is None:
        raise SystemExit(f"No *building.gml in {bu_dir}")
    b = read_layer(bpath, "Building")
    if b.crs is None:
        b = b.set_crs(CRS)
    b = b.to_crs(CRS)
    id_col = "localId" if "localId" in b.columns else "gml_id"
    b["rc"] = b[id_col].map(rc_from_id)

    keep = ["rc", "currentUse", "conditionOfConstruction", "numberOfBuildingUnits",
            "numberOfDwellings", "value", "geometry"]
    b = b[[c for c in keep if c in b.columns]].rename(columns={"value": "area_m2"})

    # floors come from the building parts
    ppath = next(bu_dir.glob("*buildingpart.gml"), None)
    if ppath is not None:
        p = read_layer(ppath, "BuildingPart")
        pid = "localId" if "localId" in p.columns else "gml_id"
        p["rc"] = p[pid].map(rc_from_id)
        agg = {}
        for col, name in [("numberOfFloorsAboveGround", "floors_above"),
                          ("numberOfFloorsBelowGround", "floors_below")]:
            if col in p.columns:
                agg[name] = pd.to_numeric(p[col], errors="coerce").groupby(p["rc"]).max()
        if agg:
            b = b.merge(pd.DataFrame(agg), left_on="rc", right_index=True, how="left")
    log(f"Buildings: {len(b)} footprints, {b['rc'].nunique()} parcels")
    return b


def parse_addresses(ad_dir):
    """Parse the INSPIRE Addresses GML with plain XML (more robust than GDAL here)."""
    path = next((p for p in ad_dir.glob("*.gml") if ".MD." not in p.name), None)
    if path is None:
        raise SystemExit(f"No address GML in {ad_dir}")
    root = ET.parse(path).getroot()

    streets = {}
    for el in root.iter():
        if strip_tag(el.tag) == "ThoroughfareName":
            texts = [t.text for t in el.iter() if strip_tag(t.tag) == "text" and t.text]
            streets[gml_id(el)] = texts[0] if texts else ""

    rows = []
    for el in root.iter():
        if strip_tag(el.tag) != "Address":
            continue
        aid = gml_id(el)
        pos, srs = None, None
        for c in el.iter():
            t = strip_tag(c.tag)
            if t == "Point":
                srs = next((v for k, v in c.attrib.items() if strip_tag(k) == "srsName"), srs)
            elif t == "pos" and c.text and pos is None:
                pos = [float(v) for v in c.text.split()[:2]]
        if pos is None:
            continue
        if srs and ("4258" in srs or "4326" in srs):   # lat/lon order -> swap
            pos = [pos[1], pos[0]]
        numbers = [c.text.strip() for c in el.iter()
                   if strip_tag(c.tag) == "designator" and c.text and c.text.strip()
                   and len(c) == 0]
        hrefs = [h.lstrip("#") for h in (href(c) for c in el.iter()) if h]
        street = next((streets[h] for h in hrefs if h in streets), "")
        if not street:  # hrefs may be full ids with a prefix
            street = next((v for k, v in streets.items()
                           if any(h.endswith(k) for h in hrefs)), "")
        rc_match = RC_URBAN.search(" ".join([aid] + hrefs))
        rows.append({"address_id": aid, "street": street,
                     "number": " ".join(numbers),
                     "rc_from_id": rc_match.group(0) if rc_match else "",
                     "srs": srs or "", "x": pos[0], "y": pos[1]})

    if not rows:
        raise SystemExit("No addresses parsed: check the GML structure.")
    df = pd.DataFrame(rows)
    src_crs = CRS
    srs_vals = df["srs"].replace("", pd.NA).dropna()
    if not srs_vals.empty:
        m = re.search(r"(\d{4,5})\s*$", srs_vals.iloc[0])
        if m:
            src_crs = f"EPSG:{m.group(1)}"
    gdf = gpd.GeoDataFrame(df.drop(columns=["srs", "x", "y"]),
                           geometry=[Point(x, y) for x, y in zip(df.x, df.y)],
                           crs=src_crs).to_crs(CRS)
    log(f"Addresses: {len(gdf)} address points on {gdf['street'].nunique()} streets")
    return gdf


def stage_vectors(args):
    DATA.mkdir(exist_ok=True)
    streets = download_streets()
    buildings = load_buildings(download_catastro_dataset("BU"))
    addresses = parse_addresses(download_catastro_dataset("AD"))

    # Assign every address to a parcel: id first, then spatial match.
    missing = addresses["rc_from_id"] == ""
    addresses["rc"] = addresses["rc_from_id"]
    if missing.any():
        near = gpd.sjoin_nearest(addresses[missing], buildings[["rc", "geometry"]],
                                 how="left", max_distance=ADDRESS_MATCH_MAX_M,
                                 distance_col="dist_m")
        near = near[~near.index.duplicated()]
        addresses.loc[missing, "rc"] = near["rc_right"].fillna("")
    log(f"Addresses linked to a parcel: {(addresses['rc'] != '').sum()} / {len(addresses)}")

    if VECTORS.exists():
        VECTORS.unlink()
    buildings.to_file(VECTORS, layer="buildings", driver="GPKG")
    addresses.drop(columns=["rc_from_id"]).to_file(VECTORS, layer="addresses", driver="GPKG")
    if streets is not None and len(streets):
        streets.to_file(VECTORS, layer="streets", driver="GPKG")
    log(f"Saved {VECTORS}")


# ================================================================= stage 2
def open_state():
    con = sqlite3.connect(STATE_DB)
    con.execute("""CREATE TABLE IF NOT EXISTS photos (
                     rc TEXT PRIMARY KEY, status TEXT, attempts INTEGER DEFAULT 0,
                     file TEXT, bytes INTEGER, message TEXT, updated TEXT)""")
    return con


def fetch_photo(rc):
    """Return (status, file, bytes, message)."""
    path = PHOTOS / f"{rc}.jpg"
    if path.exists() and path.stat().st_size > 2000:
        return "done", str(path), path.stat().st_size, "already on disk"
    r = http_get(CAT_PHOTO_URL, params={"ReferenciaCatastral": rc}, timeout=30)
    ctype = r.headers.get("Content-Type", "")
    if "image" not in ctype or len(r.content) < 2000:
        return "no_photo", "", len(r.content), f"{ctype}, {len(r.content)} bytes"
    path.write_bytes(r.content)
    return "done", str(path), len(r.content), ""


def stage_photos(args):
    if not VECTORS.exists():
        raise SystemExit("Run 'python pipeline.py vectors' first.")
    PHOTOS.mkdir(parents=True, exist_ok=True)
    buildings = gpd.read_file(VECTORS, layer="buildings")
    rcs = sorted(set(buildings["rc"].dropna()))

    if args.street:
        addresses = gpd.read_file(VECTORS, layer="addresses")
        key = normalise(args.street)
        sel = addresses[addresses["street"].map(normalise).str.contains(key, regex=False)]
        rcs = sorted(set(sel["rc"]) & set(rcs))
        log(f"Street filter '{args.street}': {len(rcs)} parcels")

    con = open_state()
    con.executemany("INSERT OR IGNORE INTO photos (rc, status) VALUES (?, 'pending')",
                    [(rc,) for rc in rcs])
    con.commit()

    statuses = ("pending", "error") if args.retry_errors else ("pending",)
    marks = ",".join("?" * len(statuses))
    wanted = set(rcs)
    todo = [r[0] for r in con.execute(
        f"SELECT rc FROM photos WHERE status IN ({marks}) AND attempts < ? ORDER BY rc",
        (*statuses, MAX_ATTEMPTS)) if r[0] in wanted]
    if args.limit:
        todo = todo[:args.limit]
    log(f"Photos to process in this run: {len(todo)}")

    counts = {}
    try:
        for i, rc in enumerate(todo, 1):
            try:
                status, file, size, msg = fetch_photo(rc)
            except requests.RequestException as e:
                status, file, size, msg = "error", "", 0, str(e)[:200]
            con.execute("""UPDATE photos SET status=?, attempts=attempts+1, file=?,
                           bytes=?, message=?, updated=? WHERE rc=?""",
                        (status, file, size, msg, datetime.now().isoformat(), rc))
            con.commit()
            counts[status] = counts.get(status, 0) + 1
            if i % 25 == 0 or i == len(todo):
                log(f"   {i}/{len(todo)}  {counts}")
            time.sleep(PAUSE_S)
    except KeyboardInterrupt:
        log("Interrupted: progress is saved, rerun to continue.")
    finally:
        totals = dict(con.execute("SELECT status, COUNT(*) FROM photos GROUP BY status"))
        con.close()
    log(f"Overall status: {totals}")


# ================================================================= stage 3
def stage_link(args):
    if not VECTORS.exists():
        raise SystemExit("Run 'python pipeline.py vectors' first.")
    OUTPUT.mkdir(exist_ok=True)
    buildings = gpd.read_file(VECTORS, layer="buildings")
    addresses = gpd.read_file(VECTORS, layer="addresses")
    try:
        streets = gpd.read_file(VECTORS, layer="streets")
    except Exception:
        streets = None

    # addresses per parcel
    addresses["label"] = (addresses["street"].fillna("") + " " +
                          addresses["number"].fillna("")).str.strip()
    per_rc = (addresses[addresses["rc"] != ""]
              .groupby("rc")
              .agg(addresses=("label", lambda s: "; ".join(sorted(set(s)))),
                   street=("street", "first"),
                   number=("number", "first")))
    out = buildings.merge(per_rc, left_on="rc", right_index=True, how="left")

    # photo status
    if STATE_DB.exists():
        con = sqlite3.connect(STATE_DB)
        photos = pd.read_sql("SELECT rc, status AS photo_status, file AS photo_file FROM photos", con)
        con.close()
        out = out.merge(photos, on="rc", how="left")
    else:
        out["photo_status"], out["photo_file"] = "not run", ""

    # nearest OSM street (useful when a building has no address)
    if streets is not None and len(streets):
        cent = out[["rc", "geometry"]].copy()
        cent["geometry"] = cent.geometry.representative_point()
        near = gpd.sjoin_nearest(cent, streets[["name", "geometry"]], how="left",
                                 distance_col="dist_to_street_m")
        near = near[~near.index.duplicated()]
        out["osm_street"] = near["name"]
        out["dist_to_street_m"] = near["dist_to_street_m"].round(1)

    cent = out.geometry.representative_point()
    out["x_25831"], out["y_25831"] = cent.x.round(2), cent.y.round(2)

    gpkg = OUTPUT / "vallromanes.gpkg"
    if gpkg.exists():
        gpkg.unlink()
    out.to_file(gpkg, layer="buildings", driver="GPKG")
    addresses.drop(columns=["label"]).to_file(gpkg, layer="addresses", driver="GPKG")
    if streets is not None and len(streets):
        streets.to_file(gpkg, layer="streets", driver="GPKG")
    out.drop(columns="geometry").to_csv(OUTPUT / "buildings.csv", index=False, encoding="utf-8")

    with_photo = (out.get("photo_status") == "done").sum()
    log(f"Saved {gpkg} and buildings.csv: {len(out)} buildings, {with_photo} with a façade photo")


# ================================================================= CLI
def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="stage", required=True)
    sub.add_parser("vectors")
    ph = sub.add_parser("photos")
    sub.add_parser("link")
    al = sub.add_parser("all")
    for p in (ph, al):
        p.add_argument("--limit", type=int, default=0, help="max parcels this run")
        p.add_argument("--street", default="", help="only parcels on this street")
        p.add_argument("--retry-errors", action="store_true")
    args = ap.parse_args()

    if args.stage in ("vectors", "all"):
        stage_vectors(args)
    if args.stage in ("photos", "all"):
        stage_photos(args)
    if args.stage in ("link", "all"):
        stage_link(args)


if __name__ == "__main__":
    sys.exit(main())
