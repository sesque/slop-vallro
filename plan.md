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
- [ ] Treat the boundary as a hard edge: add its segments to the colliders and keep traffic and pedestrians inside
      (runtime work lands in Phases 3 and 7; the data is prepared here).
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
- [ ] `build-buildings.mjs`: footprints for all building-like kinds; base and top from the DTM and polygon Z;
      height flags; stable ids.
- [ ] `js/world/buildings.js`: extruded prisms merged per chunk; plinths down to the lowest ground; simple
      flat or hip roofs; one generic facade TSL material with procedural windows by floor.
- [ ] Polygon colliders in a spatial grid; adapt `resolveHorizontalCollision`.
- [ ] Visual check against the street guide viewer and the orthophoto.

**Milestone B:** a recognisable town. You can walk the streets between real houses.

## Phase 4 — Streets (spec §5.4)
- [ ] Graph construction, snapping and splitting, with a connectivity report.
- [ ] Widths from kerbs; names from `TOP_05` labels; `fetch-osm.sh` and attribute matching; `overrides/roads.json`.
- [ ] Carriageway and pavement polygons draped on the terrain; burn the road profile into the terrain grid.
- [ ] `js/world/streets.js`: asphalt, kerbs, pavements, markings (reuse `road-paint` ideas).
- [ ] The car and cyclist drive on real slopes (pitch and roll from `normalAt`).

**Milestone C:** drive the taxi through Vallromanes.

## Phase 5 — Features and props (spec §5.5–5.6)
- [ ] Walls and retaining walls (height from terrain), fences, railings, hedges.
- [ ] Stairs: group step lines into flights and build the geometry.
- [ ] Pools, streams, ponds, bridges, crash barriers.
- [ ] Instanced trees (about 11.9k), lamps (about 1.6k, with night lights through the existing lighting
      system), poles, manholes, tree pits.
- [ ] Wall segments added to the colliders.

**Milestone D:** street-level detail comparable to upstream.

## Phase 6 — UI, labels and gameplay adaptation (spec §5.7, §6)
- [ ] `build-labels.mjs`: streets, house numbers, places; facilities become teleport points.
- [ ] `town-map.js`: hillshade minimap, teleport, location label (replace `getLocationLabel`).
- [ ] Update the HUD text, controls hints and spawn point (e.g. the Ajuntament square).
- [ ] Lighting: latitude and sun direction for 41.5°N; tune the presets for a Mediterranean light.
- [ ] Remove the remaining NYC modules and assets (boroughs, landmarks, highway traffic, NYC map).

## Phase 7 — Traffic and pedestrians (spec §6)
- [ ] `road-graph.js`: a lane graph from `roads.json`; yield and priority at intersections; roundabouts if any.
- [ ] Port `traffic.js` to the graph: spawning around the camera, low density, speed by curvature and slope.
      Buses only if there is a real route.
- [ ] A pavement graph for pedestrians; crossings at intersections.
- [ ] Tests: routing, no deadlocks over a long simulated run.

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
