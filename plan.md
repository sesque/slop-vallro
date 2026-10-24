# Implementation plan — Slop Vallromanes

Work top to bottom. Each phase ends with something visible or testable. Tick boxes as you go. The details
behind each step are in `spec.md` (section numbers in brackets).

---

## Phase 0 — Setup
- [ ] Fork `mrdoob/slop-newyork` → `slop-vallro`. Add `CLAUDE.md`, `knowledge.md`, `spec.md` and `plan.md`
      to the root.
- [ ] Pin three.js to an exact released version in `index.html` (both `three` and `three/webgpu`, plus `tsl`
      and `addons`). Confirm the NYC build still runs.
- [ ] Add `package.json` with scripts `inventory`, `geodata` and `test`, plus devDependencies (spec §7).
- [ ] Create `tools/vallromanes/` and `tools/data/vallromanes/{raw,overrides}`. Add `raw/` to `.gitignore`.
- [ ] Copy the BUE SHP delivery (`DIBA_35B7D48A_16428.zip`, extracted) into `raw/bue/`.
- [ ] Confirm the Diputació licence and redistribution terms. Record them in `knowledge.md` §5.

**Done when:** `npm test` passes the upstream tests and the raw data is in place.

## Phase 1 — Read and inventory the BUE (spec §5.1)
- [ ] `frame.mjs`: compute and fix `E0, N0` (Ajuntament label) and `H0`.
- [ ] `read-bue.mjs`: normalised features in the local frame; `ALTITUD` comma parsing; `_C`, `LTP` and
      `elevated` flags.
- [ ] `inventory.mjs`: counts per CAS and bbox, compared against `knowledge.md` §3.3. Also writes a quick
      SVG/PNG preview.
- [ ] Unit tests on a tiny fixture.

**Done when:** `npm run inventory` reproduces the known counts (2 908 buildings, 153 urban centrelines, …).

## Phase 2 — Terrain (spec §5.2)
- [x] Obtain the municipal boundary polygon (INE 08296) and store it in `raw/boundary/`. Source: ICGC administrative
      divisions v2r2-20260120, 1:5000, CC BY 4.0. `tools/vallromanes/build-boundary.mjs` writes it in EPSG:25831
      and in the local frame.
- [x] `fetch-icgc-dtm.mjs` (replaces the planned `.sh`): reads the municipality plus 200 m window of the ICGC
      Catalonia-wide COG over HTTP range requests. Downloaded level 1 (1 m, 5534 × 3748 px, 83 MB float32) to
      `raw/icgc/dtm/dtm-1m.f32` + `.json`; 0.5 m (level 0) was judged unnecessary.
- [x] Boundary as a hard edge: `data/boundary.json` + `confineToRing` keep the player, car, cyclist and helicopter inside
      the municipal polygon (3 m margin). Traffic and pedestrians stay inside in Phase 7.
- [x] Re-derived `H0` = 70 m from the DTM window (min 82.65 m). The frame extent is about ±3 km, fine for float32.
- [x] `build-terrain.mjs`: 2 m grid over the BUE core and 4 m over the whole window (box-averaged from the 1 m DTM),
      quantised to 5 cm, int16 planar-predictor residuals. `data/terrain.bin` is 8.4 MB raw, 3.07 MB gzipped.
- [x] Validated against the BUE spot heights: fine tier median 0.143 m, P95 0.696 m (gate 0.3 / 1.0). The build fails
      if the gate fails. The optional contour TIN fallback was not needed.
- [ ] Burn road profiles into the terrain grid (moved to Phase 4, needs the road graph).
- [x] Runtime `js/geo/load-geodata.js` (`loadTerrain`) and `js/geo/terrain-sampler.js` (`heightAt`, `normalAt`).
- [x] Runtime `js/world/terrain.js`: 345 chunks of 256 m, three levels (2 m / 8 m / 32 m vertex spacing, switched at
      380 m and 1.4 km with hysteresis), skirts, TSL ground material (grass, dry grass, soil, rock by slope and height).
- [x] `?terrain` flag: `main.js` loads `js/terrain-demo.js` instead of `initApp()`. It shows only the terrain with the
      four player modes; `controllers.js` got a `setWorld({ groundHeight, bounds })` hook (ground from `heightAt`, bounds
      as a hard edge). NYC builders are not touched.

**Milestone A:** walk and fly over the real Vallromanes landscape. *Reached (open `index.html?terrain`).*

## Phase 3 — Buildings, first pass (spec §5.3)
- [x] Building height check against LiDAR (DSM − DTM): done, see `knowledge.md` §3.5. BUE tops are mean roof level.
- [x] `build-buildings.mjs`: 4 313 structures of 12 kinds with courtyards, base/baseMax/top from the baked terrain and
      polygon Z, floors, hip/flat roof, review flags, stable ids -> `data/buildings.json` + `.bin` (0.77 MB raw).
      `npm run geodata` now runs boundary, terrain and buildings and writes `data/manifest.json`.
- [x] `js/world/buildings.js` + `building-geometry.js`: 82 merged chunks (78k triangles), plinths below the lowest
      ground, flat and hip roofs, porches/canopies as slabs, ruins as low walls, one facade TSL material (plaster palette
      by seed, window grid by floor, tile/gravel roofs, lit windows at night).
- [x] Polygon colliders (3 916, courtyards stay open): controllers get `pushOut` outlines in the existing 48 m collider
      cells; circle test for person/bike/helicopter, three circles for the car; teleports respect the real outline.
- [ ] Visual check against the street guide viewer and the orthophoto.

**Milestone B:** a recognisable town. You can walk the streets between real houses.

## Phase 4 — Streets (spec §5.4)
- [x] Graph construction (`road-graph.mjs`): snap at 0.75 m, split at T-junctions and crossings, merge chains, drop spurs,
      connectivity report (98.3 % of the urban length in one component).
- [x] Widths from kerbs, pavements from the limit/facade lines, names from `TOP_05` labels (84 % of urban edges, 90 % of
      the length), smooth height profile, `overrides/roads.json` -> `data/roads.json` (`build-roads.mjs`).
- [x] OSM attributes: `fetch-osm.mjs` downloaded 1 049 highways (840 kB, Overpass, ODbL) and `osm-match.mjs` copied oneway,
      lanes, maxspeed and highway class onto 392 of 624 edges (250 of 289 urban); pedestrian-only ways are ignored for roads.
- [x] Surfaces are built at runtime as ribbons along each edge (carriageway, kerb face, pavement, junction discs) at the
      profile height; `burn-roads.mjs` flattens the terrain under the roads and buries it 10 cm below the profile.
- [x] `js/world/streets.js` + `street-geometry.js`: asphalt, dirt, kerbs, jointed pavements cut back at junctions, centre
      line dashes; `js/geo/road-index.js` gives pavement height for walkers and street names for the HUD.
- [x] The car and cyclist tilt to the slope (`slopeTilt` in `controllers.js`, from `world.normalAt`, limited to 0.5 rad).

**Milestone C:** drive the taxi through Vallromanes. *Reached (open `index.html?terrain`, press 2).*

## Phase 5 — Features and props (spec §5.5–5.6)
- [x] Walls, retaining walls, hedges, fences, railings and crash barriers (`build-features.mjs`, `feature-geometry.js`,
      `features.js`): 10 599 polylines with a base and top per vertex (survey Z where plausible, kind default otherwise),
      cut around stair flights, 9 683 colliders (walls under 1 m are stepped over; segments on a carriageway are skipped).
- [x] Stairs (`stairs-group.mjs`, `build-stairs.mjs`): 1 411 flights of 9 249 steps with risers, treads and sides; the
      ground under them is lowered 25 cm; `stair-index.js` lifts a walker onto the treads.
- [x] 465 pools and 58 ponds as raised tanks (the terrain is not carved), streams and ditches as ribbons, 12 bridges as
      decks with parapets. Limits: bridges do not cut the road burn under them; the survey's power lines are not drawn.
- [x] `build-props.mjs` + `props.js`: 11 836 trees (the upstream instanced tree field, closer LOD distances, tier 2),
      1 553 lamps (bracket towards the road, glowing lens, 36 pooled point lights at night), 660 poles, 415 pillars,
      802 manholes, 552 gullies, 208 tree pits, 6 fountains.
- [x] Wall, trunk, pole and pillar colliders (14 470 prop colliders + 9 683 wall colliders + 3 916 buildings).

**Milestone D:** street-level detail comparable to upstream. *Reached for the data the survey has (no species, no
facade detail yet); about 2.5 M triangles in a typical view at 90 to 120 fps in the preview pane.*

## Phase 6 — UI, labels and gameplay adaptation (spec §5.7, §6)
- [x] `build-labels.mjs` -> `data/labels.json`: 178 places (12 settlements, 86 farmhouses, 41 facilities, hills, passes, water),
      131 street labels for 101 streets, 846 house numbers (771 attached to a building), and 29 curated teleport destinations
      in five categories (village, leisure, stay & eat, farmhouses, hills) with a nearby street as sub-title.
- [x] `town-map.js` + `geo/map-math.js`: a hillshaded relief (8 m per pixel) under the buildings, streets, tracks, pools and
      streams; a minimap that follows the player; a full atlas with pan, zoom, accent-blind search, destination pins, a
      waypoint, a scale bar and labels that appear by zoom level; click to teleport (inside the boundary only).
- [x] HUD and gameplay (`town.js`, now the entry point; `main.js` only starts it): Vallromanes text everywhere, km/h and
      metres above sea level, place + street name plates (white enamel, blue border), control hints, the teleport list built from
      the labels, the camera list built from `CAMERA_PRESETS`, saved player state, spawn at the Ajuntament. Four vantage-point
      cameras (village, el Pedró, the valley, the golf course) and the drone replace the New York ones. The taxi has a Spanish
      plate and "TAXI" lettering.
- [x] Lighting: `geo/sun.js` computes the sun for 41.54° N, 2.3° E on 15 September (CEST): midday 13:45 at 51°, golden hour
      18:45 at 13° in the west-south-west, blue hour 20:10 (light kept 4° up), night with a fixed moon.
- [x] NYC modules and assets removed: `boroughs`, `buildings` (NYC), `city-grid`, `city-config`, `landmarks`,
      `nyc-geodata`, `nyc-map`, `street-details`, `road-paint`, `road-network`, `traffic`, `audio-system`, `audio-sources`,
      their tests, the NYC data scripts and 15 MB of NYC raw data. `tsl-materials.js` went from 3 041 to 353 lines (what the car,
      trees and lighting still use) and `controllers.js` lost its Manhattan bounds and sidewalks. The generic audio synthesis,
      acoustics and events modules, `scene-culling`, `pedestrians`, `pedestrian-routes` and the bus model stay for phases 7 and 9.
      README rewritten with the data credits.

## Phase 7 — Traffic and pedestrians (spec §6)
- [x] `js/geo/lane-graph.js`: one right-hand lane per direction from `roads.json` (652 lanes, 70 km, one-way from OSM), connected at
      the street nodes with a turn weight by angle and street rank. Junctions closer than 40 m, and bends within 30 m of one,
      share one gate. No roundabouts exist in the data.
- [x] `js/traffic-sim.js` (no rendering, runs under Node): Intelligent Driver Model, speed from bends (v = sqrt(aLat / curvature)),
      the next turn and the grade, pure-pursuit steering on a bicycle model, one car at a time through a gate (higher-ranked streets
      first; waiting cars get their turn; a gate needs room in the lane beyond it), cars stop for walkers on a crossing and for the
      player. Cars live in a pool around the camera: one car per 110 m of lane within the ring, spawned out of sight. No buses: the
      data has no route.
- [x] `js/geo/pavement-graph.js` + `js/walkers-sim.js`: pavement links per street side, corners round each node, crossings at
      junctions; walkers cross only when no car holds or is about to enter the gate.
- [x] `js/traffic.js`: instanced sedans and SUVs (near and far LOD, spinning wheels, brake and turn lamps, contact shadows,
      32 night headlight spots) and `PersonCrowd` rigs, wired into `js/town.js`.
- [x] Tests (`tests/traffic.test.mjs`): lanes and routing, the gate, the crossing, pavement links, and on the real streets no car
      holding a gate during a crossing and no deadlock over 30 min at three places (at most 3 cars removed after 90 s stuck).
- [ ] Known limits: the player passes through traffic cars (they brake for the player but there is no collision); walkers do not
      avoid each other or the player; waits of 60+ s at a busy junction still happen in jams. Frame rate with traffic has not been
      measured in a focused browser (the preview pane ran at about 6 fps, also with traffic hidden).

**Milestone E:** a living town.

## Phase 8 — Enrichment
- [ ] `fetch-catastro.sh` (ATOM 08 → 08297 ZIP); join BuildingParts → floors, use, year; reconcile with heights.
- [ ] Roofs from `CON_29` ridges and slope arrows; optionally fit to LiDAR.
- [ ] Facade and material styles by POUM zone (hand-digitised `overrides/zoning.geojson`, or the official
      georeferenced POUM).
- [ ] Special buildings: a hand-modelled or parameterised church, Ajuntament, school and farmhouses ("Can …").
- [ ] Rest of the municipality outside the BUE (required, not optional): roads and tracks from RTT/OSM, buildings
      from Catastro footprints, forest and farmland from RTT/LiDAR with instanced woodland, at lower detail.

## Phase 9 — Performance, polish and release
- [ ] Chunk culling and shadow proxies through `scene-culling.js`; terrain LOD tuning; check draw call and
      triangle budgets.
- [ ] Load size under 10 MB gzipped; a loading progress bar for the data fetches.
- [ ] README with attribution (spec §9); screenshots; GitHub Pages deploy (if the licences allow).
- [ ] Final quality-gate pass (spec §8).

---

## Suggested first prompt for Claude Code

> Read CLAUDE.md, knowledge.md, spec.md and plan.md. Then do Phase 0 and Phase 1 of plan.md: pin three.js,
> add package.json, scaffold tools/vallromanes, implement frame.mjs, read-bue.mjs and inventory.mjs with
> tests, and run the inventory against tools/data/vallromanes/raw/bue. Report any count that differs from
> knowledge.md §3.3. Stop after Phase 1 for review.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Licence forbids publishing derived BUE data | Keep the repo private, or publish code only and have users run the pipeline locally with their own downloads |
| Unknown or old survey date | Check against the 2026 Catastro footprints; flag buildings missing from either source |
| Street graph topology errors | Snap tolerances, a connectivity report, manual `overrides/roads.json` |
| Sparse OSM attributes | Sensible defaults plus manual overrides (small town, a few dozen streets) |
| Steep slopes break vehicle physics | Burn road profiles into the terrain; clamp the slope response; test early (Milestone C) |
| WebGPU performance on many walls and stairs | Merge per chunk, instance repeated elements, cull aggressively |
