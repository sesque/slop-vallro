# Slop Vallromanes — findings and data report

Written 2026-10-25, after the last commit on `main` (`a5ee15f`). It says what was found while building the app, and how each source
contributed to the environment. `spec.md` describes how the app is built, `knowledge.md` holds the detailed measurements, `plan.md` the
phase-by-phase history.

## 1. The result in numbers

- A browser simulation of the whole municipality (10.57 km²): walk, drive, cycle or fly over its terrain, 4 313 structures (2 906 buildings), 38 km of drivable streets
  (70 km of lanes) and 55 km of pavements, 1 411 stair flights, about 190 km of walls, retaining walls, hedges and fences, 16 032 survey trees plus **131 993 woodland trees**, 60 cars and 80 people going about,
  synthesised sound, a map with search and 29 teleports, four times of day.
- Built in six days (2026-10-20 to 10-25, 65 commits), about 14 000 lines of runtime code, 3 500 of pipeline, 3 800 of tests (244 tests, all passing).
- The download is **6.4 MB gzipped** (data 5.4 MB, code 0.19 MB, three.js 0.76 MB), ready in 1.3 s locally; 120 fps in Chrome and 60 fps in Safari on the development Mac.
- Everything is baked offline from open data; the runtime fetches nothing from third parties except the pinned three.js and two fonts.

## 2. Main findings

### About the data

1. **The urban survey covers less than half of the municipality.** The BUE 1:1000 perimeter is 4.90 km², **46.3 %**. (Earlier in the work I told you the BUE already covered all 10.6 km²; that was
   a wrong estimate from road proximity, and `knowledge.md` §3.6 had the right figure. The report corrects it.) The other 54 % has terrain, woodland and ground tint but no buildings.
2. **The woods are two thirds of the municipality.** LiDAR surface minus terrain shows vegetation above 5 m on 67 % of the area, 36.9 % between 10 and 20 m; only 10.6 % is bare ground. Without
   this layer the hills would be empty.
3. **The BUE building heights are sound, and mean something specific.** The polygon Z is the *mean roof level*: against the LiDAR it is +0.37 m above the median roof (P90 +0.99 m); eaves are about 0.85 m
   below it, ridges about 1 m above. A typical house is 6.0 m to the mean roof.
4. **The survey's building tops are buried in 4.3 % of the buildings** (top within 0.3 m of the highest ground). The LiDAR roof level repairs almost all: flagged buildings fell from 126 to **16 (0.55 %)**,
   inside the 1 % gate. 413 tops were replaced (median +0.69 m).
5. **Roofs: 28 % of the "hip roofs" were terraces.** A footprint test alone made 1 566 hips; the LiDAR relief says 446 of them are flat, and the height at the ridge ends shows 209 real gables.
6. **The BUE `floors` field overcounts.** It is height / 3 m, roof included: it matches the Catastro in only 1 242 of 2 195 joined buildings (it says 2 where the Catastro says 1 in 413 cases).
7. **The village is modern and residential.** Catastro: 923 of 991 buildings residential, median year 1988, 249 built in the 2000s and only about 80 before 1960. An "old town" look applies to few buildings, so
   the era tint is subtle.
8. **The terrain agrees with the survey.** DTM against 5 909 BUE spot heights: median 0.14 m, P95 0.70 m. Street centrelines' Z agrees with the DTM within 0.2 m, so they serve as road profiles.
9. **The street network is fine-grained.** 358 drivable edges, edge length P10 15 m, median 80 m; 161 three-way junctions, 109 dead ends; junctions often sit within 30 m of each other, which drives how traffic must be built.
10. **OpenStreetMap is thin here but useful.** It matched 392 of 624 edges (250 of 289 urban ones) for one-way, lanes and speed, and added 11 street names; its named places (73) gave coordinates for five of the 19 shop signs.
11. **The survey's own points do not always mark what they name.** The "Ajuntament" label is the origin, on a plaza, not the town hall (which stands 12 m away); landmarks needed coordinates from Wikimedia Commons or Google Maps.
12. **The business directory is partly out of date.** Of the 20 shopfront businesses tried, one (Perruqueria Jordi) is marked permanently closed on Google and one is temporarily closed; most listings in the directory
    (lawyers, architects, trades) have no shopfront at all.

### About building it

13. **Compressing the terrain mattered.** Plain 1 cm quantisation was 7.4 MB gzipped; 5 cm steps and int16 residuals of a planar predictor give 3.05 MB for two tiers, which is what keeps the page under 10 MB.
14. **Traffic on a fine-grained network deadlocks unless junctions are clustered.** Four failure types showed up in simulation: a car holding one end of a short link while waiting for the other, a queue spilling back
    into a junction, a minor street starving behind a platoon, and cars spawned inside a junction. The fixes (shared gates for junctions within 40 m, room checks, waiting-time fairness, spawning out of junction zones) take
    stuck cars from hundreds to at most 3 per 30 simulated minutes.
15. **People jumped because of the graph, not the animation.** Pavement ends at a corner were joined as if adjacent, so a walker was moved up to 17.8 m in one step; corners are now walked links, and motion is eased
    (longest step 0.26 m per 0.1 s).
16. **Shadows are the hidden cost of trees.** Far trees cast shadows that nobody can see; switching them off cut a village frame from 5.0 M to 3.0 M triangles (−41 %).
17. **Safari needs a newer three.js than the release.** r186.1 exceeds Safari's 8 192-byte private-address-space limit in several shaders; the dev commit `fae8734` (r187dev) does not. Chrome did not show this.
18. **A per-tree collider was avoided.** 132 000 colliders would have cost memory and start-up time; a grid of trunk positions with a pooled few near the player does the same job.
19. **Practical traps.** The preview browser cached old modules across reloads (fixed by serving on a fresh port with no-store); a collapsed preview pane produces thousands of zero-size texture errors that are not real;
    the Catastro server sends an incomplete certificate chain (one download needed `curl -k`, with your agreement).

## 3. How each source contributed

| Source | Contribution to the environment | In numbers |
|---|---|---|
| **BUE 1:1000, Diputació de Barcelona** | The urban geometry and names: every footprint, street, kerb, wall, stair, pool, tree, lamp, house number and place name | 4 313 structures; 624 street edges; 11 243 stair lines → 1 411 flights; ~190 km of walls, hedges and fences; 465 pools; 16 032 props; 846 house numbers; 178 places. Covers 4.90 km² (46.3 %) |
| **ICGC terrain model (DTM)** | The ground everywhere, including the 54 % outside the survey; base heights of every building; the check on the survey's heights | 5 534 × 3 748 px at 1 m → two tiers (2 m and 4 m), 3.05 MB; median error vs survey 0.14 m |
| **ICGC surface model (DSM)** | Real roof levels, roof shapes, the church tower, and the vegetation height that makes the woods | 413 tops replaced, 446 flat roofs, 209 gables, flags 4.3 % → 0.55 %; canopy grid 0.67 MB → 131 993 trees; 67 % woodland |
| **ICGC administrative boundary** | The hard edge of the world; terrain clipping; the map frame | 1 104 vertices, 10.57 km² |
| **OpenStreetMap** | Street direction, lanes, speed limits, some names, and named places for shops | 392 of 624 edges matched; +11 names; 73 named places; positions for 5 of the 19 signs |
| **Catastro (INSPIRE buildings)** | Real floors, use and year per building, which drive window rows, facade palette and roof material | 991 buildings, 3 636 parts; 1 948 structures joined; floors corrected in 841; use and year for the same |
| **Council business directory + Google Maps** | Names, sectors and positions for the shop signs | 19 signs (names from the directory; positions from OSM and map markers, ±10 m) |
| **Wikimedia Commons and council photographs** | The look of five landmarks (colours, materials, tower) | town hall, Escola Tres Pins, Escola Bressol, Can Poal, Sant Vicenç; photos used as reference only |
| **Diputació heritage records, Catalunya Romànica** | Facts checked, not geometry: the church dates from 1908 (Pericas), its Romanesque apse | context for the church model |
| **Upstream slop-newyork** | The engine: rendering, lighting, cameras, controllers, car, person, lamp and tree models, audio synthesis | everything in `js/` marked "kept" in `spec.md` |

**What is not sourced, and so invented or generic:** the three tree species (plane, locust, elm) standing for pines and oaks; car colours and models; the walkers' clothes and builds;
window grids and plaster palettes (only their use and era vary with data); the sounds (synthesised); the traffic density and routes; the colours and fonts of the shop signs; everything inside buildings
(there are no interiors).

### Contribution by layer

| What you see | Made from |
|---|---|
| Hills, valleys, ground colour | DTM; slope and height rules; DSM canopy for forest floor; boundary for the edge |
| Houses, schools, church | BUE footprints; DTM base; DSM tops, roofs and tower; Catastro floors, use, year; photos for five looks |
| Streets, pavements, junctions | BUE centrelines, kerbs and pavement limits; DTM for profiles; OSM for direction and speed; BUE labels for names |
| Walls, hedges, stairs, pools | BUE only |
| Trees in gardens and streets | BUE survey points; upstream tree models |
| Woods | DSM − DTM, the upstream tree models |
| Cars and people | Lane and pavement graphs from the BUE streets and OSM attributes; upstream car and person models |
| Shop signs | Council directory, OSM, Google Maps, BUE footprints |
| Labels, map, teleports | BUE text points; OSM and Commons for landmark positions |
| Sound | Synthesis only (upstream code), shaped by BUE building bounds for shelter |

## 4. What is not done

- Buildings and streets outside the BUE (54 % of the municipality); the Catastro has 357 parts there that are not modelled yet.
- Cars react to being hit; walkers avoid the player; buses (no route in the data).
- The sound has not been tuned by ear; no birds, church bells or horns.
- Landmarks beyond five (the CAP, the Casal, most masies); the shops without an address (Vallromanes 2000, La Canina, Vallromanes Verd).
- Automated browser tests; the Safari and Chrome checks were by hand.
