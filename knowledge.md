# Knowledge base — Slop Vallromanes

Findings collected while analysing `mrdoob/slop-newyork` and the data available for Vallromanes
(October 2026).

---

## 1. The upstream repository: mrdoob/slop-newyork

### 1.1 Overview
- A Manhattan city simulation using three.js **WebGPURenderer + TSL** node materials. You can play as a person,
  car (taxi), cyclist or helicopter.
- **No bundler.** `index.html` has an import map that loads `three/webgpu`, `three/tsl` and the addons from
  jsDelivr at `three.js@dev`, then loads `js/main.js`.
- About 35k lines of JS in `js/`, Node data scripts in `tools/`, and Node tests in `tests/`.

### 1.2 Layers
1. **Offline data** (`tools/*.mjs` → `js/nyc-geodata.js`, about 1.1 MB). This reads NYC Open Data (CSCL street
   centrelines, DCP borough boundaries, NYC Parks) and OpenStreetMap extracts fetched through Overpass
   (`tools/overpass.sh` plus the `q_*.overpassql` query files). Raw inputs are committed in `tools/data/`
   (about 15 MB). The output is a single `export const GEO = {…}` object. Its frame is metres with the origin at
   5th Ave & 42nd St, and the axes are rotated 29.02° so the avenues run along Z. North is −z.
2. **Shared foundations**
   - `city-config.js` derives constants from `GEO`: `AVENUES`, `STREETS`, `ROADS`, `BLOCKS`, landmarks, teleport
     points and signal timing (`signalPhase`, `walkSignal`).
   - `tsl-materials.js` is a library of material factories (`createCurtainWallMaterial`,
     `createRoadSurfaceMaterial`, …). It also defines the global `cityUniforms` (sun, sky, wetness, interior
     glow), which the lighting system writes.
3. **Static world builders.** These run once and each returns a handle:
   - `buildCityGrid(scene)` → `{ group, sidewalks, footprints, highwayLanes, colliders }`
   - `buildCityBlocks(scene)` → `{ group, colliders, quadtree, allBlocks, update(x,z), updateLights(camera) }`.
     Buildings are **procedurally generated per lot** using seeded RNGs. No real building data is used.
   - `buildLandmarks`, `buildBoroughs`, `buildStreetDetails` (`{ group, footprints, signalClock, audioSignals,
     update }`), `buildRoadPaint(scene, network)`.
4. **Per-frame systems**
   - `ThirdPersonControllerManager` has four entities (`person`, `car`, `cyclist`, `helicopter`). It provides
     `setMode`, `getActiveEntity`, `teleportActiveTo`, `getGroundHeight`, `resolveHorizontalCollision` and input
     injection. Colliders are axis-aligned boxes (`pushCollider(x0,x1,z0,z1,maxY)`).
   - `createTrafficSystem(scene, sidewalks, obstacles)` → `{ group, update, setCollisionListener, cars, buses,
     peds, network }`. It runs a car-following model on `buildRoadNetwork()` from `road-network.js`, which is
     built around the Manhattan grid. `createHighwayTraffic` handles the FDR and West Side lanes.
   - `CameraSystem` (presets, orbit), `LightingSystem` (four fixed time-of-day presets), `CityAudioSystem`
     (all sound synthesised with Web Audio), `NYCMapSystem` (2D map and teleport), `scene-culling.js` (re-chunks
     instanced meshes into spatial cells and adds shadow-only proxies on layer 3).
5. **Rendering.** The scene pass renders to multiple targets (colour, normals, metal/rough). It then applies
   half-resolution SSR, bloom and a filmic grade through `THREE.RenderPipeline`, with `ClusteredLighting(256, 32,
   28, 48)`. `precompileShaders()` runs behind the loading screen.

### 1.3 Frame order in `renderer.setAnimationLoop`
gamepad → controllers → camera → traffic → highway traffic → state save (every 5 s) → boroughs →
city block LOD / lights → street details → lighting → map → audio → culling → render.

### 1.4 Runtime network and data
- **Precompiled:** all geography, in `nyc-geodata.js`.
- **Generated in the browser:** buildings, canvas textures, all geometry and all audio. No model, texture or
  sound files are loaded.
- **Fetched at load:** three.js from jsDelivr (`@dev`, so not reproducible) and Google Fonts (Inter, Overpass).
- **Real-time online data:** none. Traffic is simulated and time of day uses presets, not the clock.
- **localStorage:** `nyc-player-state` and `nyc-sound`. There is no service worker or offline cache.
- **Tests:** `tests/helpers/module.cjs` rewrites ES imports to stubs so modules can run under Node's `vm`.

### 1.5 What is Manhattan-specific (must change for Vallromanes)
- The rotated grid frame and the street/avenue model (`GEO.streets[n].z`, `GEO.avenues[].x`).
- Procedural block and lot generation, and `road-network.js`, which assume a grid.
- The flat ground assumption. Vallromanes is hilly: roughly 100–450 m elevation across the municipality, with
  steep streets.
- AABB colliders (fine for Manhattan, poor for irregular buildings and walls).
- Boroughs, bridges, highways, landmarks and the NYC map UI.

---

## 2. Data sources for Vallromanes

| Source | What | Coverage | Format / access | Licence | Status |
|---|---|---|---|---|---|
| **Diputació de Barcelona — BUE 1:1000** (Base Urbana Escala 1:1000), municipality 08296 | 3D urban topographic map: buildings, kerbs, centrelines, contours, spot heights, props, names | Urban areas, bbox about 3.9 × 2.7 km | **Delivered as SHP** (`DIBA_35B7D48A_16428.zip`); also DGN v8 (`DIBA_0E83D905_16427.zip`, MicroStation CONNECT v24, not readable by open-source GDAL) | Check the Diputació download terms | ✅ In hand |
| **Catastro INSPIRE Buildings** (DG Catastro) | Building footprints split into BuildingParts with `numberOfFloorsAboveGround` | All of Spain except the Basque Country and Navarre; Vallromanes listed as **08297-VALLROMANES** under Territorial office 08 Barcelona | ATOM: `http://www.catastro.hacienda.gob.es/INSPIRE/buildings/08/ES.SDGC.bu.atom_08.xml` (per-municipality ZIP of GML); WFS: `https://ovc.catastro.meh.es/INSPIRE/wfsBU.aspx` | CC BY 4.0 | ✅ Confirmed available (feed updated 2026-08-21) |
| **ICGC Territorial LiDAR** (3rd coverage, 2021–2023) | Classified point cloud, min 8 pts/m² (65% of sheets >10 pts/m²), plus a 15 cm orthoimage | All of Catalonia, 1×1 km sheets | LAS/LAZ download from icgc.cat | CC BY 4.0 | ✅ Covers Vallromanes |
| **ICGC elevation models** | DTM/DSM at 0.5 m (Catalonia-wide), from LiDAR | All of Catalonia | GeoTIFF | CC BY 4.0 | ✅ |
| **ICGC Referència Topogràfica Territorial (RTT)** | 1:5000 topographic base, 2023 data | All of Catalonia | GeoPackage 2D/3D, DWG/DGN, IFC | CC BY 4.0 | ✅ For areas outside the BUE |
| **OpenStreetMap** (Overpass) | Road attributes (oneway, lanes, maxspeed), POIs | Global | Overpass API (see upstream `tools/overpass.sh`) | ODbL | ⚠️ Not checked; small-town tagging may be sparse |
| **POUM Vallromanes, sheet O.9 "Ordenació"** (2008) | Zoning map with zone codes (5a, 20, 22b, 32, …) over an old topographic base | Whole municipality | Single A1 vector PDF from DGN, text outlined (no fonts), not georeferenced | — | ⚠️ Reference only: use zone types to choose building styles. Prefer a georeferenced POUM from the Generalitat MUC/RPUC open data if available. |
| **Diputació street guide** | Web viewer of the street guide built on BUE + SITMUN | Municipality | `https://sitmun.diba.cat/sitmun_gca/?mun_ine=08296` | — | Viewer only; useful for visual checking |

Contacts: Diputació de Barcelona, Oficina Tècnica de Cartografia i SIG Local, ot.cartosig@diba.cat,
tel. 934 022 036.

---

## 3. The BUE 1:1000 shapefile delivery (in hand)

### 3.1 Files and format
- Four layers: `BUE1M08296l` (lines), `…p` (points), `…s` (polygons), `…t` (text points). Each comes with
  `.shp/.shx/.dbf/.prj/.cpg/.qml`.
- **CRS: ETRS89 / UTM zone 31N (EPSG:25831), metres.** The encoding is UTF-8.
- All geometries are **3D** (PolylineZ, PolygonZ, PointZ).
- Bbox approximately E 439 509 → 443 384, N 4 596 673 → 4 599 326.
- The DBF header date is 2026-08-04. That is the **export date**, not the survey date, which is still unknown.

### 3.2 Attributes
- `CAS`: feature code, e.g. `CON_01pol_PL`. `DESCRIPCIO`: Catalan description.
- Points also have `ANGLE` (degrees) and `ALTITUD`. **`ALTITUD` is a string with a comma decimal separator**
  (`"169,43"`), so it must be parsed.
- Text points also have `ANGLE` and `TEXT`.
- Code suffixes:
  - `_C` means field revision ("revisió de camp" or "recull de camp").
  - `LS` / `LN` / `ES` mean "LTP" / "no LTP" / elevated ("elevat"). LTP is assumed to mark elements that also
    act as terrain breaklines. **Verify against the DIBA/ICGC CT-1M v2.2 dictionary.**
  - `_PL` is a polygon, `_CN` a polygon centroid, `_PT` a point, `_LN` a line, `_TX` a text.

### 3.3 Inventory (counts)
**Polygons (`s`, 4 512 in total):** building `CON_01pol_PL` 2 908 · shed `CON_07pol_PL` 836 ·
porch `CON_08pol_PL` 316 · canopy `CON_09pol_PL` 81 · construction (elevated/LTP/no-LTP) 98 ·
covered tank `CON_21pol_PL` 31 · ruins 14 · greenhouse 15 · under construction 7 · monument 5 ·
cemetery 3 · tower 1 · **urban block `CON_13_PL` 127** · sand `VEG_08_PL` 69.

**Lines (`l`, 70 412 in total), grouped:**
- Terrain: contour `ORO_01_LN` 18 291 · index contour `ORO_02_LN` 5 146 · form line `MED_06LF_LN` 6 115 ·
  non-representable contour 641 · slope breaks 29.
- Streets:
  - Centrelines: paved urban `COM_18_LN` 125 · unpaved urban `COM_19_LN` 28 · other paved roads
    `COM_23_LN` 39 · tracks `COM_24_LN` 363.
  - Edges: kerb `COM_17*` 1 402 · pavement limit `COM_03*` 1 472 · road edge `COM_02*` 92 · track edge
    `COM_04*` 1 411 · footpath 118 · hard shoulder 38.
  - Other: bridge `COM_13ES_LN` 12 · crash barrier 34 · drains and ditches 57.
- Buildings: facade `CON_01*` 1 245 · party wall 54 · volumetric line 1 831 · overhang 51 ·
  **roof ridge `CON_29_LN` 953** · protruding bay 26 · shed and porch outlines.
- Walls and stairs: retaining walls `CON_14*` 4 295 · walls `CON_15*` 3 551 · garden wall 76 · fence 74 ·
  wire fence 531 · railing 110 · **stairs `CON_23*` 11 243**.
- Water: streams `HID_03_LN` 75 · flood channels 8 · irrigation ditch 6 · ponds 182 ·
  **swimming pools (outer/inner) 616/612** · wells 24 · grates 166.
- Vegetation: field limit 1 134 · woodland 280 · hedges 1 555 · scrub 22 · gardens 1 320 · flowerbeds 356 ·
  firebreaks 38.
- Energy: power lines 32 · tower 1.

**Points (`p`, 34 657 in total):** isolated tree `VEG_03_PT` 11 852 · spot height `ORO_03_PT` 8 402 ·
**building top height `ORO_05_PT` 2 908** · ridge slope symbol `CON_29_PT` 2 966 (with `ANGLE`) ·
street lamp `ENE_06_PT*` 1 555 · pole `ENE_05_PT*` 664 · pylon `ENE_04_PT*` 415 · gully 553 · manhole 802 ·
tree pit 208 · fountain 6 · geodetic vertex 1 · a centroid for each polygon.

**Text (`t`, 2 760 in total):** 104 distinct street names (`TOP_05AV/CR`, e.g. "Avinguda de Can Corbera",
"Carrer de Barcelona") · house numbers `TOP_07*` 846 · buildings/farmhouses `TOP_06*` 86 (e.g. "Can Corbera",
"Can Galvany", "Can Ginesta") · facilities `TOP_09EQ*` 44 (e.g. "Ajuntament", "C.E.I.P Tres Pins",
"CAP Vallromanes") · settlements 12 · places/orography 19 · hydrography 10 · generic labels (shed, porch, …) ·
index contour labels 331.

### 3.4 Measured facts
- **Each building polygon's Z is constant and equals its `ORO_05_PT` "cota d'edifici"**, i.e. the absolute
  elevation of the building top.
- Estimated heights (building top minus the minimum of the 4 nearest spot heights, n = 2 904):
  P10 3.8 m · P25 5.3 m · **median 7.4 m** · P75 9.6 m · P90 11.6 m. This fits a town of mostly two- and
  three-storey houses. Heights are approximate until a proper DTM is used.
- Building polygons have a median of 8 vertices.
- Centreline features carry **no name, width, lane or direction attributes**. Names exist only as text points.
- A preview render was made: buildings, kerbs, centrelines, index contours and streams
  (`vallromanes_bue1m_preview.png`).

---

## 4. Decisions so far
- Primary geometry comes from **BUE 1:1000 SHP**. Building floor counts come from **Catastro**. Terrain comes
  from **ICGC 0.5 m DTM** (BUE contours and spot heights used for validation and fill). Road attributes come
  from **OSM** plus manual overrides. Zoning character comes from **POUM** (manual or georeferenced).
- Use real buildings, not procedural lots. Procedural detail (facades, windows, roofs) is driven by real
  attributes.
- Develop with **Claude Code** in a fork of slop-newyork.

## 5. Open questions
1. Survey or flight date of the BUE (ask the Diputació or check the metadata).
2. Diputació licence and redistribution terms, especially whether derived data can be published on GitHub
   Pages.
3. Whether to model areas outside the BUE (forest, Serralada de Marina) using the ICGC DTM and RTT.
4. The local origin point (proposal: near the Ajuntament; see `spec.md` §2).
5. Exact meaning of the LTP, ES and LN suffixes (from the CT-1M v2.2 dictionary).
