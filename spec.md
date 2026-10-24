# Technical specification — Slop Vallromanes

Status: draft v0.1. Source facts are in `knowledge.md`.

## 1. Goals and non-goals

**Scope:** the world is the **whole municipality** (INE 08296), clipped to its official boundary polygon plus a
small terrain buffer beyond it. The boundary is a **hard edge**: the player, vehicles and pedestrians are
constrained inside the polygon (a collision wall along the boundary segments), and the buffer is only visual. The BUE 1:1000 (about 3.9 × 2.7 km, urban areas only) is the
high-detail core; everything else uses lower-detail sources (ICGC DTM, RTT, OSM, LiDAR-derived tree cover).

**Goals**
- A walkable, drivable, flyable simulation of Vallromanes (urban core in full detail, the rest of the
  municipality at lower detail) that is faithful to real geometry:
  terrain, buildings with real footprints and heights, streets, pavements, walls, stairs, trees and lamps.
- Same tech and spirit as upstream: three.js WebGPU + TSL, no bundler, data pre-baked offline, nothing fetched
  from third parties at runtime except the pinned three.js (which can optionally be vendored).
- A reproducible pipeline: the same raw inputs produce byte-identical outputs.

**Non-goals (for now)**
- Interiors, live data (traffic, weather), photogrammetric textures, the full municipality forest at
  high detail.

## 2. Coordinate frame

- Source CRS: **EPSG:25831** (ETRS89 / UTM 31N). All sources are converted to it first; Catastro GML is
  normally already in EPSG:25831, so check `srsName`.
- **Local frame** (runtime units are metres):
  - `x = E − E0` (east is +x)
  - `z = −(N − N0)` (north is −z, the three.js and upstream convention)
  - `y = H − H0` (up), where H is orthometric height in metres (ETRS89 / Alicante heights)
- Origin constants live in `tools/vallromanes/frame.mjs` and are copied into the generated manifest.
  - The frame covers the whole municipality, so the extent can be several times the ±2.5 km assumed below;
    float32 precision still holds (about 1 mm at 10 km) but check it once the boundary is known.
  - Proposal: `E0, N0` at the Ajuntament label point, rounded to the metre (find it in `t`, `TOP_09EQ`
    "Ajuntament"). Alternatively use the bbox centre, about (441 450, 4 598 000).
  - `H0` is the round-number 10 m floor below the minimum DTM height **over the whole municipality** (not the
    BUE area). Current value: 70 m, from the DTM window minimum of 82.65 m. This keeps `y ≥ 0`.
- **No rotation.** Unlike Manhattan, there is no dominant grid.
- Precision: a ±2.5 km extent in float32 gives about 0.25 mm resolution, which is fine.

## 3. Repository organisation

```
slop-vallro/                 (fork of mrdoob/slop-newyork)
├─ CLAUDE.md  knowledge.md  spec.md  plan.md  README.md (with attribution)
├─ index.html                     import map: three pinned to an exact version
├─ js/
│  ├─ main.js                     same orchestration; new builders wired in
│  ├─ geo/                        NEW runtime data access
│  │  ├─ load-geodata.js          fetch manifest + binaries → GEO object
│  │  ├─ terrain-sampler.js       heightAt(x,z), normalAt(x,z) (bilinear on the grid)
│  │  └─ spatial-index.js         uniform grid / quadtree for colliders & queries
│  ├─ world/                      NEW city-specific builders
│  │  ├─ terrain.js               chunked terrain mesh + LOD
│  │  ├─ buildings.js             extruded footprints, roofs, facade materials
│  │  ├─ streets.js               road surfaces, kerbs, pavements, markings
│  │  ├─ walls-stairs.js          walls, retaining walls, fences, railings, stairs
│  │  ├─ props.js                 trees, lamps, poles, manholes, pools (instanced)
│  │  └─ labels.js                street names, place names, teleport points
│  ├─ road-graph.js               replaces road-network.js (general graph)
│  ├─ traffic.js                  adapted to road-graph.js
│  ├─ controllers.js              adapted: terrain ground, polygon/segment colliders
│  ├─ town-map.js                 replaces nyc-map.js
│  └─ (kept) cameras, lighting, post-processing, tsl-materials, pedestrians,
│      actor-models, vehicle-lights, trees, audio-*, scene-culling, touch/gamepad
├─ data/                          GENERATED, committed
│  ├─ manifest.json               frame, bbox, counts, versions, attribution, file list
│  ├─ terrain.bin                 uint16 height grid (+ header in manifest)
│  ├─ buildings.bin / .json       footprints + heights + roof info
│  ├─ roads.json                  graph nodes/edges + surfaces
│  ├─ features.bin / .json        walls, stairs, kerbs, pools …
│  └─ props.bin                   instanced positions by type
├─ tools/
│  ├─ vallromanes/
│  │  ├─ frame.mjs                origin, transforms
│  │  ├─ read-bue.mjs             SHP reader + CAS filtering + ALTITUD parsing
│  │  ├─ inventory.mjs            prints/validates counts per CAS
│  │  ├─ fetch-catastro.sh        ATOM → ZIP for 08297
│  │  ├─ fetch-icgc-dtm.sh        DTM tiles covering the bbox
│  │  ├─ fetch-osm.sh             Overpass query for bbox (reuse upstream overpass.sh)
│  │  ├─ build-terrain.mjs
│  │  ├─ build-buildings.mjs
│  │  ├─ build-roads.mjs
│  │  ├─ build-features.mjs
│  │  ├─ build-props.mjs
│  │  ├─ build-labels.mjs
│  │  └─ build-geodata.mjs        runs all stages, writes data/ + manifest
│  └─ data/vallromanes/
│     ├─ raw/                     NOT committed (.gitignore): BUE SHP, Catastro, DTM, OSM
│     └─ overrides/               committed: manual fixes (oneway, widths, names, heights)
└─ tests/                         node tests for pipeline + runtime samplers
```

Upstream NYC modules (`city-grid`, `boroughs`, `landmarks`, `buildings`, `road-network`, `nyc-map`,
`nyc-geodata`, `city-config`) are deleted once their replacements work. Shared helpers worth keeping
(e.g. `batchStaticGroupMeshes`) move to `js/util/`.

## 4. Inputs and their roles

| Input | Raw path | Used for |
|---|---|---|
| BUE SHP (`l`, `p`, `s`, `t`) | `raw/bue/BUE1M08296*.shp` | Primary geometry for everything |
| ICGC DTM 0.5 m | `raw/icgc/dtm/*.tif` | Terrain grid (primary); building base heights |
| ICGC LiDAR (optional) | `raw/icgc/lidar/*.laz` | Roof shapes and heights (later phase) |
| Catastro BU GML (08297) | `raw/catastro/*.gml` | `numberOfFloorsAboveGround` per BuildingPart; use; year |
| OSM extract | `raw/osm/vallromanes.json` | oneway, lanes, maxspeed, highway class, POIs |
| POUM zoning | `overrides/zoning.geojson` (hand-digitised or official) | Facade and material style per zone |
| Municipal boundary (INE 08296) | `raw/boundary/*.geojson` | Playable extent, terrain clip, map frame. Source to be chosen (ICGC administrative divisions, Cadastre or Diputació) |
| Overrides | `overrides/*.json` | Manual corrections keyed by stable ids |

**Stable ids:** each output feature gets an id equal to a hash of its CAS plus its rounded geometry, so
overrides survive re-runs.

## 5. Pipeline stages

All stages are Node ≥ 20 ESM. They are deterministic, log an inventory, and throw on validation failure.

### 5.1 read-bue
- Read with the npm package `shapefile` (Mike Bostock; streams Z values), or a small custom reader.
- Normalise each feature to `{ cas, desc, kind: 'line'|'poly'|'point'|'text', coords: [[x,y,z]…], angle?,
  altitud?, text? }` in the local frame.
- Parse `ALTITUD` by replacing `,` with `.` and converting to a number.
- Strip `_C` suffixes into a flag `fieldRevised: true`. Keep `LS/LN/ES` as `ltp` or `elevated` flags.

### 5.2 build-terrain
- **Primary:** mosaic and clip the ICGC DTM to the **municipal boundary bbox plus a 200 m margin** (`geotiff`
  npm package). Two resolution tiers: the BUE core at 1–2 m, the rest of the municipality at 4–8 m (the
  coarse 8 m grid below doubles as the far tier).
- **Fallback/validation:** build a constrained TIN from contours (`ORO_01/02`), spot heights (`ORO_03/04`) and
  breaklines (`MED_06*`, `MED_05*`, LTP elements). Report RMS and max difference against the DTM.
- Output grid: **1 m** in the core urban area or **2 m** everywhere (decide in phase 2 based on size).
  - Encoding: heights quantised to 5 cm above `H0` (`y = q * 0.05`, max error 2.5 cm), stored as int16 residuals of
    a planar predictor (`q - (left + up - upLeft)`) so gzip reaches about 3 MB for both tiers. Plain 1 cm uint16 was
    7.4 MB gzipped. Two tiers: 2 m over the BUE bbox + 100 m, 4 m over the whole download window.
    The server must send `terrain.bin` gzip-compressed, otherwise it is 8.4 MB.
  - Size check: 4.3 × 3.1 km at 2 m is 3.3 M samples, about 6.7 MB raw and about 3 MB gzipped.
- Burn road surfaces into the grid. Within the road polygons, flatten the cross-slope to the centreline
  height profile, so vehicles don't tilt on terrain noise.
- Also output a coarse 8 m grid for far LOD and the minimap hillshade.

### 5.3 build-buildings
- Sources: `CON_01pol_PL` (buildings), plus shed, porch, canopy, greenhouse, ruins, covered tank and
  construction polygons as separate `kind`s.
- `top = polygon Z`; this is the **mean roof level** (validated against LiDAR, knowledge.md §3.5), not the eave or
  ridge. For pitched roofs set the eave about 0.85 m below `top` and take the ridge from `CON_29` or the LiDAR DSM.
  `base = min(DTM sampled at the footprint vertices and centroid)`. Also store
  `baseMax` so the plinth can be extruded down to the lowest ground on slopes.
- `height = top − base`, clamped to ≥ 2.2 m. Flag outliers above 30 m or below 2 m for review.
- `floors`: from Catastro, joining by largest-area overlap with BuildingParts. Otherwise use
  `round(height / 3.0)`.
- Roofs:
  - Phase 3 (done): hip roof when the footprint fills at least 80 % of its minimum oriented rectangle (no courtyard, at most
    16 vertices, at least 3 m wide), otherwise flat. The ridge runs along the long axis with 45° hips; the rise is
    0.35 × the half width (0.6–2.2 m), the eave 55 % of it below `top` and the ridge 45 % above.
  - Phase 8: use `CON_29_LN` ridge lines plus `CON_29_PT` slope arrows (`ANGLE`) to build gable/hip roofs.
    Optionally fit roof planes to the LiDAR points.
- Facade style comes from the POUM zone and the floor count. For example, the village core gets stuccoed
  masonry; detached-house zones get render with tile roofs.
- Geometry cleanup: remove duplicate vertices, enforce CCW orientation, simplify to 0.1 m.
- Output: rings (Int32, centimetres) + base/top/floors/kind/zone/roofIndex.

### 5.4 build-roads
- Centrelines: `COM_18_LN` (urban paved), `COM_19_LN` (urban unpaved), `COM_23_LN` (other paved roads),
  `COM_24_LN` (tracks, for the walk/bike network only).
- **Graph construction:**
  - Snap endpoints within 0.75 m.
  - Split at intersections and T-junctions.
  - Merge degree-2 chains.
  - Remove dangles under 3 m.
  - Report connected components.
- **Width:** cast rays perpendicular to the centreline every 5 m to the nearest kerb (`COM_17*`) or edge
  (`COM_03*`, `COM_02*`) on each side. Take the median per edge. Fallback by class: urban 6 m, road 7 m,
  track 3.5 m.
- **Names:** for each `TOP_05*` text, find the nearest edge within 25 m whose direction is within 30° of the
  text `ANGLE` (mod 180°). Propagate along same-name chains.
- **Traffic attributes:** match to OSM ways by Hausdorff distance under 8 m. Copy `oneway`, `lanes` and
  `maxspeed`. Defaults: two-way, one lane each way, 30 km/h urban.
- **Surfaces:** built at runtime as ribbons along each edge from `halfL/halfR` (the median kerb distance per side) and
  `swL/swR` (kerb to the first pavement limit, block outline or facade, 0.8 to 3 m, 1.5 m by default), at the smooth
  profile height. The terrain under a corridor is baked to the profile minus `ROAD_DEPTH` (10 cm) so it never pokes
  through; the asphalt rides 4 cm above the profile, pavements 14 cm above that. Pavements and the centre line stop
  at junctions (the other roads' half width + 0.4 m).
- Output: `nodes[] {id, x, y, z}`, `edges[] {id, a, b, polyline, width, class, name, oneway, lanes,
  speed}`, plus surface polygons.

### 5.5 build-features
- Walls: `CON_15*`, `CON_16`, garden walls. Default height 1.8 m. **Retaining walls** `CON_14*`: height from
  the terrain difference across the line (sampled ±1 m either side).
- Fences, railings and wire fences: thin geometry or alpha-tested, 1.1–1.5 m.
- Stairs `CON_23*`: lines are individual step edges. Group nearby parallel lines into flights and build step
  geometry between consecutive lines using their Z.
- Pools `HID_11EX/IN`: pair outer and inner rings to form the coping and water surface.
- Streams `HID_03`, ponds `HID_09/10`, bridges `COM_13ES`, crash barriers `COM_16`.
- Vegetation areas: gardens `VEG_06`, woodland `VEG_02`, hedges `VEG_04` (extruded hedge geometry),
  flowerbeds `VEG_07`.

### 5.6 build-props
- Instanced point sets with optional angle:
  - trees `VEG_03_PT` (species chosen by zone and random seed, reusing `trees.js`)
  - lamps `ENE_06_PT*` (reuse the street-lamp actors)
  - poles `ENE_05_PT*`, pylons `ENE_04_PT*`
  - manholes `REG_01_PT*`, gullies `HID_14_PT*`, tree pits `VEG_10_PT*`, fountains `HID_15_PT*`
- Y comes from the DTM, not the point's Z. The point Z is kept for validation.

### 5.7 build-labels
- Street names (per graph edge chain), house numbers (`TOP_07*`, attached to the nearest building), and
  building/farmhouse names (`TOP_06*`).
- Facilities (`TOP_09EQ*`) become **teleport locations**, replacing NYC `TELEPORT_LOCATIONS`.

### 5.8 build-geodata
- Runs all stages, writes `data/*` and a `manifest.json`. The manifest contains: frame constants, bbox,
  counts per layer, source file hashes, the pipeline git hash, and attribution strings.

## 6. Runtime changes

| Area | Upstream | Vallromanes |
|---|---|---|
| Data loading | `import { GEO } from './nyc-geodata.js'` | `await loadGeodata()` fetches `data/manifest.json` and the binaries before the builders run |
| Ground | Flat, plus special cases | `terrain-sampler.heightAt(x,z)` everywhere (controllers, traffic, peds, props, camera collision) |
| Terrain mesh | None | Chunks (e.g. 256 m) with 2–3 LODs, skirts, TSL material (grass/soil/rock by slope and height, darkened under trees) |
| Buildings | Procedural per lot | Real extrusions. Merged per chunk; facade TSL materials driven by attributes; windows procedural in the shader |
| Colliders | AABB `pushCollider` | Polygon footprints + wall segments in a uniform grid (10 m cells). Circle-vs-segment resolution for person and bike; OBB-vs-segment for the car |
| Road network | Manhattan grid model | `road-graph.js`: general directed lane graph from `roads.json`. Intersections as priority/yield nodes (few or no signals) |
| Traffic | Grid-based lanes, signals | Same car-following model (IDM-like `follow`/`brake`) on graph lanes. Lower density; speed limited by curvature and slope |
| Pedestrians | Sidewalk tracks, crosswalks | Pavement graph derived from the pavement polygons; crossing points at intersections |
| Helicopter | City-scale | Keep; ceiling about 600 m above `H0` |
| Map UI | `nyc-map.js` | `town-map.js`: hillshade + buildings + roads + labels, teleport to facilities |
| Lighting | Presets | Keep presets. Set the sun azimuth/latitude for 41.5°N |
| Audio | City ambience | Keep the engine; reduce traffic hum, add birds/wind (optional) |
| Culling | `scene-culling.js` | Keep, and feed it the new chunked meshes |
| three.js | `@dev` | Pin an exact version |

`GEO` runtime shape (in-memory, after loading):

```js
GEO = {
  version: 2, frame: { E0, N0, H0, crs: 'EPSG:25831' }, bbox: { minX, minZ, maxX, maxZ },
  terrain: { width, height, cell, originX, originZ, heights: Float32Array },
  buildings: [{ id, kind, ring: Float32Array /*x,z pairs*/, base, baseMax, top, floors, zone, roof }],
  roads: { nodes, edges }, surfaces: { carriageway: [], pavement: [] },
  features: { walls: [], retaining: [], fences: [], stairs: [], pools: [], water: [], hedges: [] },
  props: { tree: Float32Array, lamp: Float32Array, pole: Float32Array, /* x,z,angle triples */ },
  labels: { streets: [], places: [], numbers: [], teleports: [] }
}
```

## 7. Libraries

- **Pipeline (Node, devDependencies):**
  - `shapefile`: SHP/DBF reading
  - `geotiff`: DTM reading
  - `fast-xml-parser`: Catastro GML
  - `cdt2d` or `poly2tri`: constrained triangulation
  - `earcut`: polygon triangulation
  - `rbush`: spatial index
  - `@turf/*` (selected modules): geometry operations
  - `laz-perf` / `copc` (optional): LiDAR
- **Runtime:** none beyond three.js. Earcut comes via `THREE.ShapeUtils` if needed.
- No GDAL dependency, to keep the pipeline portable. The DGN v8 files are not used.

## 8. Quality gates

- **Inventory:** counts per CAS match `knowledge.md` §3.3 within the expected values.
- **Terrain:** DTM vs BUE spot heights. Median |Δ| < 0.3 m, P95 < 1 m (excluding points on buildings or walls).
- **Buildings:** 100% have finite base/top. Height distribution roughly P50 ≈ 7 m. Fewer than 1% flagged.
- **Roads:** one main connected component containing at least 95% of the urban edge length. Every urban edge
  has a width. At least 90% of urban edges are named.
- **Runtime:** 60 fps on a mid-range GPU at street level. First load under 10 MB gzipped (excluding
  three.js). No NaN positions (asserted in dev mode).
- **Tests:**
  - Pipeline unit tests with tiny fixture shapefiles.
  - Runtime tests for `heightAt`, collisions and graph routing (upstream `tests/helpers/module.cjs` style).

## 9. Attribution and licensing

- **README credits:**
  - "Cartografia topogràfica urbana 1:1000 © Diputació de Barcelona" (exact wording per their terms)
  - "© Institut Cartogràfic i Geològic de Catalunya (ICGC), CC BY 4.0"
  - "© Dirección General del Catastro, CC BY 4.0"
  - "© OpenStreetMap contributors, ODbL"
- Code: MIT (as upstream). Generated `data/` carries the source licences; check the Diputació terms before
  publishing.
