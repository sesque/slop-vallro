# Slop Vallromanes — Claude Code guide

A browser simulation of **Vallromanes** (Vallès Oriental, Barcelona, Catalonia), built by forking
[mrdoob/slop-newyork](https://github.com/mrdoob/slop-newyork). It uses three.js WebGPURenderer and TSL, has no
build step, and runs as plain ES modules. Everything about the town is **pre-baked offline** by Node scripts in
`tools/` into static data files that the browser loads.

Read these before working:

| File | Purpose |
|---|---|
| `knowledge.md` | Everything learned so far: how the New York repo works, which data sources exist for Vallromanes, what is in the delivered 1:1000 shapefiles, measured stats. |
| `spec.md` | Technical specification: coordinate frame, data model, pipeline stages, runtime module changes, libraries, conventions. |
| `plan.md` | Phased implementation plan with acceptance criteria. Work through it in order and tick items off. |

## Ground rules

- Keep the upstream architecture: static builders (`build*(scene)` returning a handle) and per-frame systems
  (`update(dt, …)`) wired in `js/main.js`. Change the city-specific modules; keep the generic ones
  (see `spec.md` §6).
- **Scope: the world is the whole municipality of Vallromanes** (INE 08296), not just the urban area covered by
  the BUE 1:1000. The BUE is the high-detail core; the rest (forest, farmland, Serralada de Marina slopes) comes
  from the ICGC DTM, RTT and OSM at lower detail. The municipal boundary polygon defines the playable extent and is a **hard edge** (player, vehicles and
  traffic cannot cross it; the terrain just beyond it is only a visual skirt).
- Raw source data lives in `tools/data/vallromanes/raw/` and is **not committed** (licence and size). Generated
  runtime data lives in `data/` and **is** committed.
- The world frame is metres in a local frame derived from EPSG:25831 (ETRS89 / UTM 31N). Never mix in
  lat/lon at runtime.
- Municipality codes: **INE 08296** (Diputació files, street guide), **Cadastre 08297** (Catastro INSPIRE
  feeds). Don't confuse them.
- Pin three.js to an exact release in the import map. Upstream uses `@dev`, which breaks unpredictably.
- Every pipeline stage prints an inventory or validation report and fails loudly on NaN, empty output or an
  out-of-bounds bbox.
- Credit the data sources in `README.md` (ICGC CC BY 4.0, Catastro CC BY 4.0, OSM ODbL, Diputació de
  Barcelona per its terms).

## Common commands

```bash
npm run inventory   # report on raw BUE shapefiles
npm run geodata     # bake boundary, roads, terrain and buildings → data/ (+ manifest.json); needs the raw data
node tools/vallromanes/fetch-osm.mjs   # optional: OSM highways for oneway/lanes/maxspeed (network)
npm test            # node tests (tests/*.test.*)
npx serve .         # open http://localhost:3000 in a WebGPU browser; add ?terrain for the Vallromanes terrain demo
```
