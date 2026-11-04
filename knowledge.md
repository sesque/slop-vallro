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
| **ICGC elevation models** | DTM/DSM at 0.5 m (Catalonia-wide), from LiDAR 2021–2023 | All of Catalonia | One Cloud Optimized GeoTIFF per resolution (EPSG:25831, float32, nodata −9999, 512 px tiles, overviews 1/2/4/… m), not sheets: `https://datacloud.icgc.cat/datacloud/model-elevacions-terreny/tif_unzip/model-elevacions-terreny-lidar-catalunya-50cm-2021-2023.tif` (422 GB). HTTP range requests work, so only the municipality window is read. | CC BY 4.0 | ✅ Downloaded at 1 m: window 5534 × 3748 px, height 82.65 → 499.49 m (104.07 m minimum inside the boundary). Overview levels carry no georeferencing; use the level-0 origin. |
| **ICGC Referència Topogràfica Territorial (RTT)** | 1:5000 topographic base, 2023 data | All of Catalonia | GeoPackage 2D/3D, DWG/DGN, IFC | CC BY 4.0 | ✅ For areas outside the BUE |
| **OpenStreetMap** (Overpass) | Road attributes (oneway, lanes, maxspeed), POIs | Global | Overpass API (see upstream `tools/overpass.sh`) | ODbL | ⚠️ Not checked; small-town tagging may be sparse |
| **ICGC Administrative divisions** v2r2-20260120 | Municipal boundary polygons, 1:5000 official scale (generalised 1:50k to 1:1M also available) | All of Catalonia | GeoJSON/SHP/GPKG/DWG zip, WMS/WFS: `https://datacloud.icgc.cat/datacloud/divisions-administratives/json/divisions-administratives-v2r2-20260120.zip` | CC BY 4.0 | ✅ Downloaded. Vallromanes = `CODIMUNI 082969`, 1 polygon, 1 104 vertices, 10.570 km² (matches the declared `AREAM5000`). GeoJSON is lon/lat with 5 decimals (about 1 m). Bbox E 439 049 → 444 181, N 4 595 979 → 4 599 326 (5.1 × 3.3 km). |
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

### 3.5 DTM versus BUE (measured)
- BUE spot heights (`ORO_03`, 5 909 away from buildings) against the 1 m DTM: median |Δ| 0.14 m, P95 0.70 m, max 6.7 m, mean signed −0.07 m. Passes the spec §8 gate (median < 0.3, P95 < 1).
- Building top (`ORO_05`) minus DTM at the centroid: P10 2.6 m, median 5.1 m, P90 8.6 m (n = 2 908). That looked low against the 7.4 m of §3.4, so it was checked against the ICGC LiDAR surface model (DSM, 1 m, same 2021–2023 flight, `fetch-icgc-dtm.mjs --product dsm --level 0`).
- **Building height check** (1 807 of 2 908 footprints analysed: at least 6 DSM pixels more than 1 m inside the walls and 6 DTM pixels 1.5–3.5 m outside; smaller or tightly packed ones were skipped):
  - BUE top minus the **median LiDAR roof height** in the footprint: median +0.37 m, P90 +0.99 m. The BUE top is the **mean roof level**, not the eave and not the ridge.
  - BUE top minus the LiDAR ridge (98th percentile): median −0.21 m, P10 −3.1 m (pitched roofs have a ridge above the top). Eaves (2nd percentile) are a median 0.85 m below the top.
  - Height above surrounding ground (DTM ring 1.5–3.5 m outside the walls): BUE top P50 **6.0 m** (P10 2.9, P90 9.1); LiDAR median roof 5.8 m, ridge 6.9 m.
  - Ground relief around a footprint is a median 2.5 m (P90 4.7 m), so the choice of ground reference matters: top minus the uphill ground is 4.6 m, minus the downhill ground 7.2 m. The 7.4 m of §3.4 used the lowest nearby spot height (downhill bias); the 5.1 m used the DTM at the centroid (under the building).
  - **Conclusion:** the BUE tops are sound. Typical houses are about 6 m to the mean roof and about 7 m to the ridge. Use the DTM ring as ground reference, not the centroid.

### 3.6 What the building polygons contain (measured)
- **Survey coverage:** `MED_06LP_PL` (1 polygon, 3 912 vertices) is the perimeter of the surveyed area: **4.90 km², 46.3 % of the municipality's 10.57 km²**. The other 54 % has no BUE data (Catastro footprints, Phase 8).
- All outer rings are counter-clockwise in UTM (clockwise once z = −N). 89 buildings have extra parts, and all 103 of them are **courtyards (holes)** inside their building, never separate pieces. Z is constant per polygon for every structure kind.
- 4 313 structures are baked after removing 2 outside the boundary: 2 906 buildings, 836 sheds, 316 porches, 81 canopies, 98 construction, 31 tanks, 14 ruins, 15 greenhouses, 7 under construction, 5 monuments, 3 cemetery, 1 tower. Simplifying to 0.1 m cuts 35 892 vertices to 26 085.
- Heights above the lowest ground at the footprint: buildings P10 3.0, **P50 6.0**, P90 9.8 m; floors (3 m) 1: 1 190, 2: 1 162, 3: 463, 4+: 91. 1 566 buildings are nearly rectangular and get a hip roof.
- **Flags (before the LiDAR correction; now 16 of 2 906, 0.55 %, see plan.md Phase 8):** 126 of 2 906 buildings (4.3 %) are flagged for review, against the 1 % gate of spec §8, almost all as "buried" (BUE top within 0.3 m of the highest ground at the footprint; 41 even stay below the median ground). Sheds, tanks and construction are flagged far more often. The LiDAR surface model can replace these tops in Phase 8.

### 3.7 What the street data gives (measured)
- **Centrelines:** 125 paved urban lines (31.7 km), 28 unpaved urban (2.4 km), 39 other paved roads (4.2 km), 363 tracks (24.1 km). Their Z agrees with the DTM within 0.2 m (P10 to P90), so they are used as the road profile after smoothing. Grades: median 5.8 %, P90 14 %, max 34 %.
- **Graph:** 555 lines become 624 edges and 599 nodes (279 endpoint clusters and 242 T-junctions snapped at 0.75 m, 1 crossing, no spurs under 3 m). The largest component holds 98.3 % of the urban length; 51 components in all (isolated tracks).
- **Kerb (`COM_17`) is the carriageway edge**: found on 85 % of the samples on each side of an urban street, median 3.1 m from the centreline. Urban width P10/P50/P90 = 4.4 / 6.0 / 7.9 m (269 of 289 edges measured); tracks 3.1 m. `COM_03` (pavement limit) and the block outlines lie further out and give the pavement width: both sides on 243 of 289 urban edges, 1.5 m by default.
- **Names:** `ANGLE` of the street labels is counter-clockwise from east. 129 of 139 labels match an edge running their way within 25 m; propagating straight on at junctions names 243 of 289 urban edges (84 %, 90 % of the length) from the BUE alone. Letting names turn 90° would reach 96 % but names the wrong streets; the remaining 46 edges (3.2 km, median 51 m) are for `overrides/roads.json`.
- **OSM** (Overpass, 1 049 highways in the municipality box, 840 kB; ODbL, credit in the README): an edge takes the way that stays within 8 m of at least 80 % of it. 392 of 624 edges match (250 of 289 urban); 54 urban edges are one-way, most others default to two-way with one lane each way. Urban speeds: 30 km/h on 274 edges, 50 on 12, 20 on 3; the C-roads carry 50 to 90. OSM names fill 11 gaps, so 257 of 289 urban edges (89 %, 93 % of the length) are named.

### 3.8 What the feature and prop layers contain (measured)
- **Walls and fences:** the Z of `CON_15` walls, garden walls, fences, railings and hedges behaves like the **top** (median 1.6 m above the ground for walls, 2.2 m for hedges). `CON_19` wire fences have Z at ground level (median 0.3 m), so their height is a default 1.4 m. Retaining-wall lines (`CON_14`, 81 km) are the crest: the base is the lower ground 1.5 m either side. Line totals: walls 54 km, retaining 81 km, hedges 42 km, wire fences 16 km.
- **Stairs:** each `CON_23` line is one step edge (median 1.6 m long, 0.5 m between steps, 0.2 m rise per step). 11 243 lines group into 1 411 flights of 2 or more steps (median 5 steps, 0.9 m rise, 1.6 m wide) and 1 994 lone lines. A survey wall line sometimes crosses the foot of a flight; the baker cuts walls around flights.
- **Pools and ponds:** outlines come in pieces (about 1.3 per ring). Joining ends within 0.3 m gives 465 pools (all with an inner margin) and 58 ponds; a wider tolerance joins unrelated pieces. Pools sit about 0.14 m above the ground (flat Z), ponds can be 1 m below it.
- **Props:** `ANGLE` is 0 for trees, lamps, poles and manholes (no orientation information) but real for gullies, tree pits and fountains. Lamps point their bracket at the nearest street. Trees carry no species or height, so the three upstream species are used at random (plane, locust, elm), scaled 0.5 to 0.9.

### 3.9 What the drivable street graph looks like (measured)
- 358 drivable edges (urban, urbanUnpaved, road) = 38.3 km, which is 70 km of lanes. Node degree: 109 dead ends, 46 pass-through, 161 three-way, 8 four-way. 19 components, the largest 87.7 % of the length. 62 one-way edges, 358 edges have 2 lanes or fewer.
- Posted speed: 30 km/h on 274 edges, 20 on 38, 50 on 33, 40 on 4, 70 on 6, 90 on 3. Edge length P10 15 m, median 80 m, P90 241 m: junctions often sit within 30 m of each other, which is why traffic treats them as clusters (a car between two of them cannot hold one and wait for the other).
- Data convention to remember: `halfL`/`swL` is the side with positive lateral, (-dz, dx) of the direction a to b, which in the z-south map is the **right-hand** side when travelling a to b. Lanes and pavements use it that way.

### 3.10 What the Catastro building files hold (measured)
- Source: `https://www.catastro.hacienda.gob.es/INSPIRE/Buildings/08/08297-VALLROMANES/A.ES.SDGC.BU.08297.zip`, 0.69 MB (15 MB unpacked: `building`, `buildingpart` and `otherconstruction` GML, ISO-8859-1, EPSG:25831). The server's certificate chain is incomplete, so curl needs `-k` (done once, for this public file; the user agreed). The ATOM index is `.../Buildings/08/ES.SDGC.BU.atom_08.xml`. Catastro's code for Vallromanes is 08297; it lists 08296 as Vallirana.
- 991 `Building` and 3 636 `BuildingPart` features. `Building` has `currentUse` (923 residential, 21 agriculture, 17 industrial, 10 public services, 6 retail, 14 empty), `numberOfDwellings`, `conditionOfConstruction` (966 functional, 8 declined, 4 ruin) and `dateOfConstruction`. `BuildingPart` has `numberOfFloorsAboveGround` (0: 205, 1: 2 168, 2: 1 095, 3: 148, 4: 20) and below ground.
- **Year of construction:** present for 978 of 991 (36 are the placeholder 1900). Median 1988. By decade: 1960s 112, 1970s 168, 1980s 108, 1990s 149, 2000s 249, 2010s 35, 2020s 45, and only about 80 before 1960. So the village is overwhelmingly modern; a visible "old town" style would apply to few buildings.
- **Join to the BUE:** 3 279 of 3 636 parts (90 %) have their centroid inside a BUE structure, covering 2 195 of the 4 313 structures (the rest are sheds, porches, tanks and the like). BUE top minus base by Catastro floors: 0 floors 3.4 m, 1: 5.3 m, 2: 8.3 m, 3: 10.2 m, 4: 13.6 m, so heights and floors agree.
- **The BUE `floors` field overcounts:** it equals the Catastro maximum in 1 242 of 2 195 matches; in 413 BUE says 2 where Catastro says 1, and in 245 it says 3 where Catastro says 2. Catastro floors should replace it.
- **Flagged buildings:** only 86 of the 313 BURIED-flagged structures have Catastro floors, so Catastro does not fix the 4.3 % flag rate; the LiDAR roof level can.

### 3.11 Facade photos and aerial screenshots for wall colours (measured, 2026-11)
- **Catastro facade photos.** `tools/vallromanes/catastro-photos/pipeline.py` (run by the project owner, output in `walls-cadastro/`, 322 MB, not committed) fetched the Catastro INSPIRE Buildings and Addresses, the OSM streets and, from
  `OVCFotoFachada.svc/RecuperarFotoFachadaGet`, one photo per parcel: 991 parcels, **952 photos**, 39 without. The file name is the cadastral building reference (`rc`, 14 characters), the same as the `Building` gml id;
  `output/buildings.csv` has rc, use, floors, address, street, photo status, and the building's position in EPSG:25831. Coverage against the model: of 2 906 baked buildings, 1 800 join a Catastro building and 1 752 have a photo; the other
  1 154 are a median 6 m (P90 23 m) from a photographed building.
- **What the photos show.** Street-level views of the parcel frontage: sky, road, garden walls, vegetation; the house is often small or hidden. Classed by eye, **216 of 952 show a usable facade**: white 86, cream 38, terracotta 29,
  brick 19, ochre 15, grey 13, stone 9, dark cladding 4, pink 3. A naive automatic colour average mixed road, sky and plants and was dropped. Reuse terms of the photos are not known: the repository keeps only the class letters.
- **Aerial screenshots (tried and shelved).** 45 Google Maps screenshots (21 straight-down north-up views in `top_view/`, 21 oblique views in `perspective/`, 3 further) were tried as a source of wall colours. Not committed: Google's terms
  do not allow extracting data from Maps imagery, so this is a technical test only. Findings:
  - The Google URL parameters do not give the camera: the centre point was 219 m from where the image was centred. Matching roof colour or house outlines to the footprints did not converge either (many surveyed houses are hidden under trees).
  - **What worked:** the scale bar of the 2D views is 66 px for 20 m, i.e. 3.28 px/m, and the **street network** locked each 2D view onto the model (road centrelines on road-coloured pixels, rotation about -0.7 degrees, 13 of 21 views covered survey
    buildings; the others lie outside the 46 % surveyed area). SIFT matching of a 2D view to its oblique twin gave a ground-plane homography with 85 to 180 inliers; a pinhole camera from it (f about 1380 px for 1600 x 1000) projects the
    footprints and roof outlines onto the houses.
  - **What did not work:** the wall colours. 805 buildings got a colour, 582 were seen in two or more views, but two views of the same building agreed only a little better than two random buildings (ratio of typical colour differences 0.78;
    0.69 for walls of 150 px or more, 0.61 for 250 px or more, which is only about 110 to 260 buildings). Brightest-pixel sampling and per-view brightness correction hardly helped; the aerial colours did not relate to the street-photo classes.
    Walls are only 15 to 40 px tall, the shading is baked into the imagery and most walls here are pale. Not baked. Scripts: `tools/vallromanes/experiments/`.

## 4. Decisions so far
- Primary geometry comes from **BUE 1:1000 SHP**. Building floor counts come from **Catastro**. Terrain comes
  from **ICGC 0.5 m DTM** (BUE contours and spot heights used for validation and fill). Road attributes come
  from **OSM** plus manual overrides. Zoning character comes from **POUM** (manual or georeferenced).
- Use real buildings, not procedural lots. Procedural detail (facades, windows, roofs) is driven by real
  attributes.
- Wall colour: a class per building read by eye from the Catastro facade photos (palette, not textures), inherited from the nearest
  classed building within 40 m; aerial screenshots were evaluated and not used (§3.11).
- Develop with **Claude Code** in a fork of slop-newyork.

## 5. Open questions
1. Survey or flight date of the BUE (ask the Diputació or check the metadata).
2. ~~Diputació licence and redistribution terms, especially whether derived data can be published on GitHub
   Pages.~~ **Answered (2026-10-25, by the project owner after reading the Diputació's terms): publishing is allowed.** Keep the
   attribution line in README.md and the manifest; the exact licence wording is not copied into the repo yet.
3. ~~Whether to model areas outside the BUE~~ **Decided: the whole municipality is the world.** Open: the source of
   the boundary polygon, and which lower-detail sources fill the area outside the BUE (ICGC DTM and RTT, Catastro
   footprints, OSM, LiDAR tree cover).
4. The local origin point (proposal: near the Ajuntament; see `spec.md` §2).
5. Exact meaning of the LTP, ES and LN suffixes (from the CT-1M v2.2 dictionary).
