# Technical specification — Slop Vallromanes (as built)

Status: v1.0, describes the application as it stands on `main` (commit `a5ee15f` and later). It replaces the design-time draft v0.1;
that draft's decisions are kept where they were followed and replaced where the build taught something else. Measured facts and
the findings are in `knowledge.md` and `report.md`; the history of the work is in `plan.md`.

## 1. What it is

A browser simulation of the municipality of Vallromanes (INE 08296, Vallès Oriental, Barcelona), forked from
[mrdoob/slop-newyork](https://github.com/mrdoob/slop-newyork). It is plain ES modules on three.js WebGPURenderer and TSL, with
**no build step**: everything about the town is baked offline by Node scripts into static files under `data/`, which the page loads.
The player walks, drives, cycles or flies over the real terrain, buildings, streets, walls, stairs, trees and street lamps of the
municipality, with cars and people going about, synthesised sound, a map and teleports, and the sun of 41.5° N on 15 September.

**Scope.** The world is the whole municipality, clipped to its official boundary. The boundary is a **hard edge**: the player,
vehicles and traffic cannot cross it (the 3 m margin in `js/town.js`), and the terrain just outside it is only a visual skirt.
The high-detail core is the Diputació's urban map (BUE 1:1000), which covers **4.90 km², 46.3 % of the municipality**; the rest is
terrain, tinted ground and woodland from the LiDAR (see §4 and `report.md` for what is, and is not, modelled outside the BUE).

**Non-goals.** Interiors, live data (weather, real traffic), photogrammetric textures, buses, buildings outside the BUE.

## 2. Coordinate frame

- Source CRS: **EPSG:25831** (ETRS89 / UTM zone 31N). Every source is converted to it first; degrees (OpenStreetMap, map sites) go
  through `tools/vallromanes/utm.mjs` (Krueger series, mm accuracy). The runtime never sees degrees.
- Local frame, metres, no rotation (there is no dominant street grid): `x = E − E0` (east +x), `z = N0 − N` (north is −z),
  `y = H − H0` (up). `E0 = 441417`, `N0 = 4598030` (the Ajuntament label point rounded to the metre), `H0 = 70` m (10 m below the
  lowest DTM height of the download window, 82.65 m). Constants live in `tools/vallromanes/frame.mjs` and in `data/manifest.json`.
- The frame spans about −2.6 … +3.0 km in x and −1.5 … +2.3 km in z, so float32 is accurate to better than a millimetre.
- Heading convention: a body with heading ψ faces `(sin ψ, cos ψ)`. Lateral side convention of the street data: `halfL`/`swL` is the
  side of positive lateral `(−dz, dx)` of the direction a → b, which in this z-south frame is the **right-hand** side.

## 3. Repository layout (as built)

```
slop-vallro/
├─ index.html            import map (three.js pinned to dev commit fae8734, r187dev), module preloads, HUD markup
├─ css/style.css         HUD, loader, map
├─ js/
│  ├─ main.js            starts js/town.js
│  ├─ town.js            the orchestrator: loads data, builds the world, wires systems, HUD, saved state, animation loop
│  ├─ town-map.js        minimap and atlas (canvas): hillshade, buildings, streets, labels, search, teleport
│  ├─ town-config.js     keyboard helper
│  ├─ controllers.js     person, car, bicycle, helicopter; collisions; world interface (setWorld)
│  ├─ cameras.js         chase / action / pov, four scenic cameras, drone
│  ├─ lighting.js        four time presets, sun from js/geo/sun.js, shadow cascades, sky
│  ├─ post-processing.js the colour grade applied to the scene pass
│  ├─ tsl-materials.js   shared TSL materials and the cityUniforms (sun colour, interior glow, wetness)
│  ├─ traffic-sim.js     car driving on the lane graph (no rendering, runs under Node)
│  ├─ traffic.js         draws cars (instanced), people (PersonCrowd), headlights; car colliders
│  ├─ walkers-sim.js     people on the pavement graph (no rendering)
│  ├─ audio.js           the sound orchestrator; audio-synthesis.js, audio-events.js, audio-acoustics.js: kept upstream synthesis
│  ├─ actor-models.js, pedestrians.js, vehicle-lights.js, trees.js: kept upstream models (cars, people, lamps, trees)
│  ├─ scene-culling.js, touch-controls.js, gamepad-controls.js, pedestrian-routes.js: kept upstream, not all used
│  ├─ geo/               pure data access (load-geodata, terrain-sampler, polygon, road-index, stair-index, lane-graph,
│  │                      pavement-graph, sun, map-math)
│  └─ world/             builders: terrain, buildings (+building-geometry), streets (+street-geometry), features
│                         (+feature-geometry), props, woodland, trunks, signs (+sign-geometry)
├─ data/                 GENERATED and committed (about 5.4 MB gzipped): see §6
├─ tools/vallromanes/    the pipeline: build-*.mjs, fetch-*.mjs, read-bue, catastro, lidar-roofs, utm, osm-match, ...
├─ tools/data/vallromanes/
│  ├─ raw/               NOT committed: BUE shapefiles, ICGC DTM/DSM windows, boundary, OSM, Catastro GML
│  └─ overrides/         committed: roads.json (manual street fixes), shops.json (the shop directory with places)
├─ tests/                34 files, 244 node:test tests (pipeline, runtime geometry, simulations)
└─ CLAUDE.md spec.md plan.md knowledge.md report.md README.md
```

The upstream New York modules (`city-grid`, `boroughs`, `landmarks`, `road-network`, `nyc-map`, `nyc-geodata`, `city-config`) are gone.
`npm run geodata` bakes everything; `npm test` runs the tests; `npx serve .` (or `python3 -m http.server`) serves the site.

## 4. Data sources and their roles

| Source | Where it enters | Gives |
|---|---|---|
| Diputació de Barcelona, BUE 1:1000 (SHP `l p s t`) | `read-bue.mjs` → every `build-*` stage | All urban geometry and names: 4 313 structures, 624 street edges, 11 243 stair lines, ~190 km of walls, retaining walls, hedges and fences, 16 032 props, 846 house numbers, 178 places |
| ICGC DTM, LiDAR 2021–2023, 1 m window (COG, HTTP range reads) | `build-terrain.mjs`, `build-buildings.mjs` | The ground everywhere; building base heights; validation of the BUE spot heights |
| ICGC DSM, same flight, 1 m | `lidar-roofs.mjs`, `build-canopy.mjs` | Roof level, roof shape and the church tower; vegetation height (the woods) |
| ICGC Divisions administratives v2r2 | `build-boundary.mjs` | The municipal polygon: hard edge, terrain clip, map frame |
| OpenStreetMap (Overpass, ODbL) | `fetch-osm.mjs`, `osm-match.mjs`, `fetch-osm-pois.mjs` | One-way, lanes, speed limits and some street names; named shops and restaurants with coordinates |
| Catastro INSPIRE Buildings 08297 (CC BY 4.0) | `catastro.mjs` | Real floors above ground, use and year of construction |
| Council business directory (image) + Google Maps markers | `overrides/shops.json`, `build-shops.mjs` | The 19 shop signs: names, sectors, positions |
| Photographs on Wikimedia Commons and the council site | `LANDMARKS` in `build-buildings.mjs`, `js/world/buildings.js` | The look of five landmarks (reference only, not copied) |
| Upstream slop-newyork | `js/` | The rendering engine, lighting, cameras, controllers, models, audio synthesis |

Stable ids: a structure's id is an FNV-1a hash of its CAS and its centimetre-rounded ring, so overrides survive re-runs.

## 5. Pipeline stages (as built)

All stages are Node ESM, deterministic, print an inventory, and throw on NaN, empty output or out-of-bounds results.
`build-geodata.mjs` runs them in this order and writes `data/manifest.json` (frame, counts, byte sizes and SHA-256 of every file, credits):
boundary → roads → stairs → terrain → buildings → features → props → canopy → labels → shops.

### 5.1 read-bue (`read-bue.mjs`)
A custom SHP/DBF reader (the `shapefile` package drops Z). Every feature becomes `{ cas, desc, kind: line|poly|point|text, coords [[x,y,z]], angle, altitud, text }`
in the local frame. `ALTITUD` is a string with a decimal comma. The suffix `_C` marks field revision.

### 5.2 boundary
The Vallromanes polygon (CODIMUNI 082969) from the ICGC GeoJSON, 1 104 vertices, 10.570 km², converted to the local frame
(`data/boundary.json`, 17 kB). Used for the hard edge, clipping, the terrain window and the map.

### 5.3 roads
Centrelines `COM_18/19/23/24` become a graph: endpoints snapped within 0.75 m, split at T-junctions, degree-2 chains merged, spurs under 3 m
removed (555 lines → 624 edges, 599 nodes). Width from perpendicular rays to the kerb lines (`COM_17`, `COM_03`, `COM_02`), median per side
(`halfL/halfR`, pavement `swL/swR`). Names from the street labels (direction within 30°, propagated along straight chains; 84 % of urban
edges), then OSM. OSM attributes (`oneway`, `lanes`, `speed`, `osm` class) come from `osm-match.mjs`: an edge takes the way that stays within
8 m of at least 80 % of it (392 of 624 edges matched). `overrides/roads.json` holds manual fixes. Each edge carries a smoothed 3D profile `pts [x, z, y]`
whose Z agrees with the DTM within 0.2 m. Output `data/roads.json`.

### 5.4 stairs
`CON_23` lines are single steps: 11 243 lines group (`stairs-group.mjs`) into 1 411 flights of two or more steps with tread heights, and 1 994 lone lines.
Output `data/stairs.json`; walls are cut around flights.

### 5.5 terrain
The 1 m DTM window (5 534 × 3 748 px) is box-averaged into two tiers: **2 m** over the BUE area and **4 m** over the whole window (`terrainBounds`
−2569…2963 × −1497…2251). Heights are quantised to 5 cm over `H0` and stored as int16 residuals of a planar predictor
(`q − (left + up − upLeft)`): `terrain.bin` is 8.4 MB raw and 3.05 MB gzipped (the server must gzip it). The road and stair corridors are **burned in**
(`burn-roads.mjs`): the terrain under a street is the street's profile minus `ROAD_DEPTH` 0.1 m, so it never pokes through the asphalt.
Validation gate: DTM against BUE spot heights, median |Δ| 0.14 m, P95 0.70 m (gate 0.3 / 1.0).

### 5.6 buildings
`CON_*pol_PL` polygons give 12 kinds (building, shed, porch, canopy, construction, tank, ruins, greenhouse, work in progress, monument, cemetery, tower);
`open` kinds are roof slabs without walls. Rings are simplified to 0.1 m, oriented (outer positive area, holes negative), stored as Int32 centimetres.
- **Heights.** `base` and `baseMax` are the lowest and highest ground at the footprint vertices and centroid; `top` is the polygon Z, the **mean roof level**
  (validated against the LiDAR: BUE top minus LiDAR median roof +0.37 m). Flags TALL / SHORT / BURIED / LOW_TOP mark outliers; `LIDAR_TOP` marks a corrected one.
- **LiDAR correction** (`lidar-roofs.mjs`, `refineWithLidar`): pixels well inside the walls (0.6 m inset) give roof level (median), eave (10th percentile) and ridge
  (95th). A top buried in the ground or more than 1.2 m from the roof level takes the roof level (413 buildings, median +0.69 m): flagged buildings fall from
  4.3 % to **0.55 %** (gate 1 %). A hip roof with under 0.9 m of relief is made flat (446 of 1 566). For the rest, the height at the ridge ends decides
  hip, **gable along the long axis** or **gable along the short axis** (`roofShape`, 209 gables).
- **Roofs.** Types FLAT 0, HIP 1, GABLE 2, GABLE_SHORT 3, with `rise` (eave to ridge). The eave sits 55 % of `rise` below `top`, the ridge 45 % above.
- **Catastro join** (`catastro.mjs`): the GML is read with patterns. Parts are matched to footprints by centroid; the footprint takes the most floors above
  ground of its parts and the use and year of their building. 1 948 structures joined, floors changed in 841. Fields `floors`, `cat`, `use` (0 unknown … 6 other), `year`.
- **Landmarks** (`LANDMARKS`, `LOOK`): five footprints get a `look` (1 town hall, 2 school, 3 masia, 4 church nave, 5 nursery); the church also gets `tower [x, z, size, top]`
  from the LiDAR spike beside its nave, the masia a `chimney`, the town hall a shallow tile roof override.
- Output `data/buildings.json` (610 kB; records with kind, base, baseMax, top, floors, roof, rise, flags, look, tower, use, year, ring offsets) and `buildings.bin` (rings).

### 5.7 features and props
`build-features.mjs`: walls (`CON_15`, Z is the top), retaining walls (`CON_14`, Z is the crest: base from the lower ground 1.5 m either side), hedges, fences, railings, wire fences,
streams, ditches, bridges, and swimming pools and ponds (outlines joined within 0.3 m: 465 pools, 58 ponds). `build-props.mjs`: trees (11 852 survey points), lamps, poles, pylons, manholes,
gullies, tree pits and fountains as x, z, angle triples (`props.bin`, 192 kB); heights come from the terrain at runtime.

### 5.8 canopy (`build-canopy.mjs`)
DSM − DTM with the building footprints removed, averaged into **4 m cells**, 0.5 m steps (uint8): `canopy.bin` 1.1 MB raw, 0.67 MB gzipped. Measured over the municipality:
10.6 % under 0.5 m, 9.7 % 0.5–2 m, 12.8 % 2–5 m, 27.8 % 5–10 m, 36.9 % 10–20 m, 2.3 % above 20 m: **two thirds is woodland**.

### 5.9 labels and shops
`build-labels.mjs`: 104 street names (with angle and length for the map), 846 house numbers (attached to buildings), 178 places, 29 teleports. `build-shops.mjs`: for each entry of
`overrides/shops.json` resolve a point (a survey place, degrees, or street + house number; a missing number is estimated between its neighbours on the same side), find the building (containing, else nearest within
20 m), pick the wall facing the street, put the sign 3.1 m above the pavement, centred on the anchor and spread when several share a wall → `data/shops.json` (19 signs).

## 6. Runtime data files

| File | Content | gzip |
|---|---|---|
| terrain.bin/json | two height tiers, int16 residuals | 3.05 MB |
| features.bin/json | wall, fence, hedge, retaining lines; water | 0.86 + 0.16 MB |
| canopy.bin/json | vegetation height grid | 0.67 MB |
| props.bin/json | tree, lamp, pole, manhole … positions | 0.13 MB |
| buildings.json/bin | structures and rings | 0.10 + 0.12 MB |
| stairs.json, roads.json, labels.json, boundary.json, shops.json, manifest.json | | 0.30 MB |
| **Total data** | | **5.4 MB** (code 0.19 MB, three.js 0.76 MB from jsDelivr) |

## 7. Runtime systems

**Loading** (`js/town.js`): nine data files are fetched in parallel (a determinate loading bar fills as each arrives), then the terrain, buildings, streets, features, props, woods, signs, traffic
and walkers are built, shaders are compiled (`compileAsync` against the scene pass's MRT layout), and the overlay hides after two frames. State (position, mode, time) is saved to localStorage every 5 s.

**World interface** (`controllers.setWorld`): `groundHeight(x, z, mode)` (terrain, plus `ROAD_DEPTH + LIFT` on streets, plus `CURB` on pavements for people, plus the stair tread height),
`normalAt`, `bounds`, and `confine(x, z)` (keeps everything 3 m inside the boundary). Vehicles tilt to the slope.

**Terrain** (`world/terrain.js`): 256 m chunks, three levels (vertex spacing 2 / 8 / 32 m, switched at 380 m and 1.4 km with hysteresis), skirts, one TSL ground material from
the world position and the normal (grass, dry grass, soil, rock by slope and height). Under woodland the canopy grid (an R8 texture) darkens the ground to forest floor and tints scrub and crops.

**Buildings** (`world/buildings.js`, `building-geometry.js`): merged per 256 m chunk (82 chunks), plinths below the lowest ground, walls with a window-row count from the Catastro floors (else from the height),
flat roofs (gravel), hip and gable roofs (tile courses along the contours, sheet metal for farm and industry), vertical gable ends, porches and canopies as slabs, ruins as low walls, bell tower and chimney.
One facade material reads per-vertex `info = (rows, surface, colour seed, kind + style/32)`: plaster palette, window grid (bays 3.4 m, 2.7 m for pre-1950 houses), plinth stone, era tint (pre-1950 warmer, 1990+ whiter),
use (plain concrete for farm and industry, light for shops and public), and the landmark looks (brick and pink stone, yellow and grey metal, rubble stone, whitewash, pale blue, ashlar). At night some windows are lit.

**Streets** (`world/streets.js`, `street-geometry.js`): ribbons along each edge from `halfL/halfR` and the smooth profile, kerbs, pavements (stopping 0.4 m beyond the half-width of the widest street at a junction),
centre lines, junction discs. **Features** (`world/features.js`): walls, hedges, fences, stairs (steps from the tread heights), water, bridges; wall colliders. **Props** (`world/props.js`): instanced lamps (night light pool),
poles, manholes, gullies, tree pits, fountains; trees through the upstream tree field with levels of detail.

**Woodland** (`world/woodland.js`): a tree site in about 30 % of the 4 m cells whose vegetation exceeds 4.5 m, not on a street and not in a cell with a surveyed tree, sized by the canopy height:
131 993 trees through the same tree field, hidden beyond 520 m, so about 10 000 are drawn. Only the full-detail level casts shadows (the other levels cost 30 % of the triangles for shadows nobody sees).
**Trunks** (`world/trunks.js`): a 16 m grid of the trunk positions hands out pooled circle colliders near a point; no collider object per tree.

**Signs** (`world/sign-geometry.js`, `signs.js`): one mesh, one draw call; a canvas text atlas (512 × 64 cells), colours by sector, emissive at dusk.

**Traffic** (`traffic-sim.js`, `geo/lane-graph.js`): a right-hand lane per direction from `roads.json` (652 lanes, 70 km), offset by half the carriageway, connected at nodes with turn weights by angle and street rank.
Junctions within 40 m of each other, and bends within 30 m of one, share a **gate**: one car at a time holds a gate, higher-ranked streets first, waiting cars get their turn after 15 s, the lane beyond must have room,
and nothing enters while a walker is on a crossing of the gate. Cars follow the Intelligent Driver Model (a 1.6 m/s², b 2.6, T 1.3 s, s0 2 m), slow for bends (v = √(aLat/curvature), 2.6 m/s²), the coming turn and slopes,
and steer by pure pursuit on a bicycle model (corners are rounded). A pool of 60 cars lives around the camera (one per 110 m of lane within 380 m, spawned out of sight, removed beyond 450 m); stuck cars are removed after 90 s.
Drawing (`traffic.js`): instanced sedan and SUV bodies (near and far level), spinning wheels, brake and turn lamps, contact shadows, 32 headlight spots at dusk. No buses (the data has no route).

**People** (`walkers-sim.js`, `geo/pavement-graph.js`): a link per pavement side between the trimmed street ends, short corner links, crossing links at junctions of three or more streets. 80 walkers around the camera
walk, turn corners, pause, and cross only when no car holds or is about to enter the gate; body position and heading are eased (2.6 m/s, 5 rad/s) so nothing jumps or spins. Skinned `PersonRig`s with planted feet.

**Controllers** (`controllers.js`): person (walk 4.4 m/s, run 8.2), car (23.5 m/s, boost 36), bicycle, helicopter; static colliders (building outlines, wall and prop circles) bucketed in 48 m cells, plus
`dynamicColliders` (woodland trunks and traffic cars) asked per frame; crashes slow the vehicle and fire a collision event.

**Cameras and light.** Chase, action and first person, four scenic cameras and a drone; four time presets (golden 18:45, midday 13:45, blue hour 20:10, night) from `geo/sun.js` (41.54° N, 2.3° E, 15 September, CEST).

**Map and HUD** (`town-map.js`, `geo/map-math.js`): hillshaded elevation, buildings, streets, names, search with accents ignored, teleport list by category, speed, altitude, place and street plates, mode and time buttons.

**Sound** (`audio.js`): Web Audio, started on the first gesture, `N` mutes (remembered). The player's engine (car, bicycle, helicopter) or footsteps, wind (speed, height, shelter by `CityAcoustics`), the four nearest traffic
engines (distance, stereo, Doppler, buildings in the way), crashes. About 0.2 s to build the sounds. Not tuned by ear yet.

## 8. Rendering and performance

- Render path: `pass(scene)` with the upstream MRT layout, colour grade, `WebGPURenderer` with `ClusteredLighting(256, 32, 28, 48)` and a reversed depth buffer; three shadow cascades.
- **three.js is pinned to the dev commit `fae8734` (r187dev)**: release 0.186.1 fails in Safari (private address space of the shaders over 8 192 bytes); that commit works.
- Budget: a village frame is about 3.0 M triangles over all passes (3.4 M in the thick of the woods), 120 fps on the development Mac, no GPU errors. First load 6.4 MB gzipped; ready in 1.3 s locally.
- Loading never blocks on a zero-size canvas: the loop skips frames when the window has no size.
- Switches: `?notraffic`, `?nowoods`, `?notrees`, `?lite` (smaller clustered-lighting grid).

## 9. Quality gates and results

| Gate | Target | Result |
|---|---|---|
| Terrain vs BUE spot heights | median < 0.3 m, P95 < 1 m | 0.14 m, 0.70 m |
| Buildings flagged for review | < 1 % | 0.55 % (16 of 2 906), after the LiDAR correction |
| Urban edges named | ≥ 90 % | 89 % (93 % of the length) |
| Largest road component | ≥ 95 % of urban length | 98.3 % |
| First load | < 10 MB gzipped | 6.4 MB |
| Frame rate | 60 fps | 120 fps (Chrome, M-series); Safari 60 fps |
| Traffic: cars stuck 90 s | none in a long run | ≤ 3 per 30 simulated minutes at three places |
| Walkers: step per 0.1 s / turn per 0.1 s | no jumps | 0.26 m / 0.5 rad |

## 10. Tests

244 `node:test` tests in 34 files: the pipeline stages with tiny fixtures (read, boundary, roads, OSM matching, stairs, terrain, buildings, canopy, LiDAR roofs, Catastro, features, props, labels, shops),
the runtime geometry (terrain mesh, building and street geometry, gable roofs, towers, signs), the samplers and indexes, the lane and pavement graphs, a 30-minute no-deadlock run of traffic at three places,
the walkers' step and turn limits, collisions of trunks, and the page's import graph against the preload list. `tests/helpers/module.cjs` runs upstream CommonJS-style modules under a `vm` with import stubs.

## 11. Known limits and open items

- **Outside the BUE (54 % of the municipality) there are no buildings**, and streets and tracks exist only where the survey drew them; 357 of the Catastro's 3 636 building parts do not fall inside a BUE structure and are not modelled; Catastro footprints are the obvious next source.
- Woodland uses the three upstream species (plane, locust, elm) for pines and oaks.
- Traffic cars are not pushed when hit; walkers do not avoid the player or each other; no buses.
- The sound has not been tuned by ear; no birds, bells or horns in the game.
- Landmarks beyond the five are generic buildings; the CAP, the Casal and most masies have no reference photos.
- Safari and Chrome were tested by hand on the final build; there are no automated browser tests.

## 12. Attribution and licensing

- Cartografia topogràfica urbana 1:1000 © Diputació de Barcelona (its terms allow publishing the derived data, with this credit);
  © Institut Cartogràfic i Geològic de Catalunya, CC BY 4.0; © Dirección General del Catastro, CC BY 4.0; © OpenStreetMap contributors, ODbL.
- Code: MIT, as upstream. `data/` carries the source licences. The reference photographs of the landmarks are not part of the repository.
