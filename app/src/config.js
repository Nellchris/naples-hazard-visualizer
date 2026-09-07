// config.js — shared constants for the app.
// Keep AOI_BBOX identical to pipeline/00_aoi.py.
//
// Data paths are relative to app/index.html. The site root is the repo root
// (see .github/workflows/deploy.yml, which uploads `path: .`), so app/ sits one
// level below it and reaches the processed data via `../data/processed/`.

export const AOI_BBOX = [14.05, 40.78, 14.30, 40.92]; // [minLon,minLat,maxLon,maxLat]
export const CAMPI_FLEGREI_CENTER = [14.139, 40.827]; // camera preset target

// Two EGMS Ortho components. Start on U; let the user toggle to E.
//
// `domain` is [min, mid, max] in mm/yr and `colors` the matching three stops.
// `exponent` warps each arm of the ramp: t -> t**e on the normalised 0..1
// distance from the midpoint. e = 1 is linear; e < 1 lifts small magnitudes so a
// long tail doesn't wash the field out. It changes only how values MAP to
// colour, never the domain itself — the caps stay where they are.
export const COMPONENTS = {
  U: {
    label:      "Vertical (up / down)",
    short:      "U",
    points:     "../data/processed/egms_points_U.geojson",
    timeseries: "../data/processed/egms_timeseries_U.parquet",
    // uplift is a positive bullseye at Pozzuoli -> asymmetric ramp
    domain:     [-15, 0, 145],                     // mm/yr, real range -12.2..+145.2
    colors:     ["#2166ac", "#f7f7f7", "#b2182b"], // subsidence — 0 — uplift
    // The caldera core (+90..+145) is a handful of points; the surrounding
    // deformation field sits at +2..+20. Linear against a +145 cap would render
    // that field as near-white. sqrt on the positive arm keeps the +145 cap
    // (the core stays saturated) while making the outer field legible.
    exponent:   { neg: 1.0, pos: 0.5 },
    unit:       "mm/yr",
    negLabel:   "subsidence",
    posLabel:   "uplift",
    // Columns suit a one-directional signal: taller = more uplift reads
    // immediately. Height is a VISUAL scale (see COLUMN), not a real distance.
    render:     "columns",
  },
  E: {
    label:      "East – West",
    short:      "E",
    points:     "../data/processed/egms_points_E.geojson",
    timeseries: "../data/processed/egms_timeseries_E.parquet",
    // radial expansion: sign flips E/W of centre, ~0 mean -> SYMMETRIC ramp
    domain:     [-60, 0, 60],                      // mm/yr, real range -59.1..+70.6
    colors:     ["#4575b4", "#f7f7f7", "#d73027"], // west — 0 — east
    // Symmetric signal with no long tail: linear on both arms.
    exponent:   { neg: 1.0, pos: 1.0 },
    unit:       "mm/yr",
    negLabel:   "moving west",
    posLabel:   "moving east",
    // Draped, NOT columns: E is bidirectional, and a column height can only
    // encode magnitude — it would read as "more" for both east and west motion
    // and quietly misrepresent the sign. Colour carries the direction instead.
    render:     "draped",
  },
};
export const DEFAULT_COMPONENT = "U";

// Two basemaps. Light is the default: 3D relief reads from shading and
// silhouette, and both are lost against a near-black ground.
//
// Each carries its own palette, because colours tuned for one base fail on the
// other. `rampMid` is the diverging ramp's ZERO colour — near-white works on
// dark, but on a pale base it makes every near-zero point vanish, and ~43% of
// the U points sit near zero.
export const BASEMAPS = {
  light: {
    label: "Light",
    url: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
    buildings: { tagged: "#4d5766", default: "#a7b0bb" },
    rampMid: "#efe7d8", // warm pale grey — holds against a cool near-white base
  },
  dark: {
    label: "Dark",
    url: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
    buildings: { tagged: "#d5dae1", default: "#333941" },
    rampMid: "#f7f7f7",
  },
};
export const DEFAULT_BASEMAP = "light";

export const INITIAL_VIEW = {
  center: CAMPI_FLEGREI_CENTER,
  zoom: 11.8,
  pitch: 55,      // tilted so the terrain reads
  bearing: -18,
};

// DEM tiles exist for z8-14 over the single Copernicus tile N40/E014, whose
// warped extent is lon 14-15 / lat 40-41. `bounds` stops MapLibre requesting
// tiles outside that, which would just 404.
export const TERRAIN = {
  minzoom: 8,
  maxzoom: 14,
  bounds: [14.0, 40.0, 15.0, 41.0],
  // NOTE: MapLibre scales the rendered terrain by `exaggeration`, but deck.gl
  // does not know about that. The EGMS point z is multiplied by the SAME factor
  // (see egms-layer.js) so points stay on the surface instead of sinking into
  // it. Change it here only — both sides read this one number.
  exaggeration: 1.2,
  enabledByDefault: true,
};

export const POINT_STYLE = {
  radiusMeters: 45,      // EGMS Ortho spacing is ~100 m
  radiusMinPixels: 1.5,
  radiusMaxPixels: 9,
  opacity: 0.85,
};

// Velocity-scaled columns (U only). Column height is a visual encoding of
// mm/yr, not a distance on the ground — at 3.5, the +145 mm/yr caldera core
// stands ~508 m, comparable to the ~450 m of real relief in the AOI, so the
// signal reads against the terrain without dwarfing it.
export const COLUMN = {
  metresPerMmPerYear: 3.5,
  radiusMeters: 42,
  diskResolution: 6, // hexagonal prisms; plenty at this point size
};

// Buildings are urban context. Two levers keep 88k extrusions cheap:
//   minzoom  — MapLibre skips the layer entirely when zoomed out
//   lazyZoom — the 29 MB GeoJSON isn't even FETCHED until you approach that
//              zoom, so it never costs anything on initial page load.
export const BUILDINGS = {
  minzoom: 14,
  lazyZoom: 13.3,
  fadeInEnd: 14.8, // fully opaque by here
  opacity: 0.92,
};

// Columns and buildings each own a zoom band and cross-dissolve between them.
// Without this the 500 m columns (100 m apart) become a solid wall at z14+ and
// bury the buildings entirely.
export const CROSSFADE = {
  columnsFullUntil: 13.2, // columns at full strength below this
  columnsGoneBy: 14.2,    // and fully faded out above this
  // Band ends just past BUILDINGS.minzoom (14) rather than overlapping it
  // broadly: the caldera-core columns are ~500 m tall, so even at 25% opacity
  // they still bury the streetscape. This is closer to a hand-off than a blend.
};

// Time animation over the 303 acquisition dates.
//
// During playback the map shows CUMULATIVE DISPLACEMENT in mm up to the chosen
// date — not mean_velocity. The colour domain is computed once from the whole
// series and then held FIXED across every frame: renormalising per frame would
// make the caldera look static, which is the exact opposite of the point.
export const ANIM = {
  fps: 24,
  metresPerMm: 0.7,   // U column height per mm of cumulative uplift (~525 m at +750)
  minRadiusFactor: 0.5, // E: radius at zero displacement, x POINT_STYLE.radiusMeters
  maxRadiusFactor: 1.4, // E: radius at the largest |displacement|
};

export const DATA = {
  buildings:   "../data/processed/buildings.geojson",
  demTiles:    "../data/processed/dem/{z}/{x}/{y}.png",
  demEncoding: "terrarium",   // MUST match 03_dem_prep.sh rgbify params
                              // (-b -32768 -i 0.00390625)
};
