// egms-layer.js — deck.gl layer for the EGMS measurement points.
//
// Loads egms_points_<C>.geojson once per component (cached), and builds a
// ScatterplotLayer coloured by mean_velocity through that component's diverging
// ramp. deck.gl is consumed from the UMD bundle as the global `deck`.

import {
  COMPONENTS,
  POINT_STYLE,
  TERRAIN,
  COLUMN,
  BASEMAPS,
  DEFAULT_BASEMAP,
  CROSSFADE,
  ANIM,
} from "./config.js?v=7";

// The diverging ramp's zero colour follows the active basemap (see BASEMAPS).
let rampMid = BASEMAPS[DEFAULT_BASEMAP].rampMid;

export function setRampTheme(basemapKey) {
  rampMid = BASEMAPS[basemapKey].rampMid;
}

/** Column opacity for a zoom, cross-dissolving against the buildings layer. */
export function columnOpacity(zoom) {
  const { columnsFullUntil: a, columnsGoneBy: b } = CROSSFADE;
  if (zoom <= a) return 1;
  if (zoom >= b) return 0;
  return 1 - (zoom - a) / (b - a);
}

const cache = new Map(); // component -> parsed point array

/* ---------- colour ramp ------------------------------------------------- */

const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);

function hexToRgb(hex) {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

/**
 * Map a velocity to an [r,g,b] colour using a component's diverging ramp.
 * Values beyond the domain clamp to the end colours rather than wrapping.
 */
export function rampColor(value, component) {
  const [lo, mid, hi] = component.domain;
  // colours[1] is the zero stop; the active basemap overrides it.
  const [cLo, cMid, cHi] = [component.colors[0], rampMid, component.colors[2]].map(
    hexToRgb
  );
  const e = component.exponent || { neg: 1, pos: 1 };

  let t;
  let from = cMid;
  let to;
  if (value >= mid) {
    t = hi === mid ? 0 : clamp01((value - mid) / (hi - mid));
    t = Math.pow(t, e.pos);
    to = cHi;
  } else {
    t = mid === lo ? 0 : clamp01((mid - value) / (mid - lo));
    t = Math.pow(t, e.neg);
    to = cLo;
  }
  return [
    Math.round(from[0] + (to[0] - from[0]) * t),
    Math.round(from[1] + (to[1] - from[1]) * t),
    Math.round(from[2] + (to[2] - from[2]) * t),
  ];
}

/** CSS gradient string for the legend, sampled from the same ramp as the map. */
export function rampGradient(component, steps = 48) {
  const [lo, , hi] = component.domain;
  const stops = [];
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    const [r, g, b] = rampColor(lo + (hi - lo) * f, component);
    stops.push(`rgb(${r},${g},${b}) ${(f * 100).toFixed(1)}%`);
  }
  return `linear-gradient(to right, ${stops.join(", ")})`;
}

/* ---------- data -------------------------------------------------------- */

/**
 * Fetch and flatten a component's points GeoJSON into plain objects.
 * Flattening beats handing GeoJsonLayer 19k Point features — one array, no
 * per-feature geometry objects to walk on every redraw.
 */
export async function loadPoints(key) {
  if (cache.has(key)) return cache.get(key);

  const component = COMPONENTS[key];
  const resp = await fetch(component.points);
  if (!resp.ok) {
    throw new Error(
      `could not load ${component.points} (HTTP ${resp.status}). ` +
        `Serve the repo root, not app/ — see the run instructions.`
    );
  }
  const fc = await resp.json();

  const points = fc.features.map((f) => {
    const [lon, lat] = f.geometry.coordinates;
    const h = f.properties.height_ortho ?? 0;
    return {
      pid: f.properties.pid,
      v: f.properties.mean_velocity,
      h,
      // z is pre-multiplied by the terrain exaggeration so the points track the
      // rendered surface (MapLibre exaggerates terrain; deck.gl does not).
      position: [lon, lat, h * TERRAIN.exaggeration],
    };
  });

  cache.set(key, points);
  return points;
}

/** Summary stats for the readout panel. */
export function stats(points) {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const p of points) {
    if (p.v < min) min = p.v;
    if (p.v > max) max = p.v;
    sum += p.v;
  }
  return { n: points.length, min, max, mean: sum / points.length };
}

/* ---------- layer ------------------------------------------------------- */

/**
 * Build the ScatterplotLayer for one component.
 * The layer id carries the component key so switching components swaps the
 * layer outright — deck.gl then has no stale colour state to diff against.
 */
/**
 * Colour/scale descriptor for playback: a component-shaped object whose domain
 * is cumulative displacement (mm) rather than mm/yr, so rampColor can be reused
 * unchanged. Rounded outward to whole units so the legend reads cleanly.
 */
export function animRamp(key, bundle) {
  const component = COMPONENTS[key];
  const step = 50;
  const lo = Math.floor(bundle.min / step) * step;
  const hi = Math.ceil(bundle.max / step) * step;
  return {
    domain: [lo, 0, hi],
    colors: component.colors,
    exponent: component.exponent,
    maxAbs: Math.max(Math.abs(lo), Math.abs(hi)) || 1,
  };
}

export function buildLayer(
  key,
  points,
  { onClick, selected, zoom = 0, anim = null } = {}
) {
  const component = COMPONENTS[key];
  const { ScatterplotLayer, ColumnLayer } = deck;
  const colFade = columnOpacity(zoom);

  // During playback, colour/size come from the frame's cumulative displacement
  // (values[index]) instead of mean_velocity. `anim.frame` is the updateTrigger.
  const vals = anim && anim.values;
  const ramp = anim && anim.ramp;

  // d.position already carries z = height_ortho * TERRAIN.exaggeration, so both
  // render modes start from the same point on the exaggerated terrain surface.
  const base =
    component.render === "columns"
      ? new ColumnLayer({
          id: `egms-columns-${key}`,
          data: points,
          diskResolution: COLUMN.diskResolution,
          radius: COLUMN.radiusMeters,
          extruded: true,
          getPosition: (d) => d.position, // column BASE sits on the terrain
          getFillColor: vals
            ? (d, { index }) => rampColor(vals[index], ramp)
            : (d) => rampColor(d.v, component),
          // Column height encodes mm/yr (or cumulative mm during playback).
          // Negative (subsidence) columns extend downward into the hillside and
          // are largely hidden — deliberate: colour still carries the sign, and
          // this AOI's subsidence is small.
          getElevation: vals ? (d, { index }) => vals[index] : (d) => d.v,
          elevationScale: vals ? ANIM.metresPerMm : COLUMN.metresPerMmPerYear,
          updateTriggers: vals
            ? { getFillColor: anim.frame, getElevation: anim.frame }
            : undefined,
          material: { ambient: 0.6, diffuse: 0.5, shininess: 32 },
          // Cross-dissolve: hand the close-up zooms over to the buildings.
          opacity: colFade,
          visible: colFade > 0.01,
          pickable: colFade > 0.15,
          autoHighlight: true,
          highlightColor: [255, 255, 255, 160],
          onClick,
        })
      : new ScatterplotLayer({
          id: `egms-points-${key}`,
          data: points,
          getPosition: (d) => d.position,
          getFillColor: vals
            ? (d, { index }) => rampColor(vals[index], ramp)
            : (d) => rampColor(d.v, component),
          // Draped points can't grow upward, so magnitude shows as radius.
          getRadius: vals
            ? (d, { index }) => {
                const f =
                  ANIM.minRadiusFactor +
                  (ANIM.maxRadiusFactor - ANIM.minRadiusFactor) *
                    Math.min(Math.abs(vals[index]) / ramp.maxAbs, 1);
                return POINT_STYLE.radiusMeters * f;
              }
            : POINT_STYLE.radiusMeters,
          updateTriggers: vals
            ? { getFillColor: anim.frame, getRadius: anim.frame }
            : undefined,
          radiusUnits: "meters",
          radiusMinPixels: POINT_STYLE.radiusMinPixels,
          radiusMaxPixels: POINT_STYLE.radiusMaxPixels,
          opacity: POINT_STYLE.opacity,
          stroked: false,
          billboard: false, // lie flat on the terrain rather than face the camera
          pickable: true,
          autoHighlight: true,
          highlightColor: [255, 255, 255, 160],
          onClick,
        });

  const layers = [base];

  // Ring marking the point whose time series is open.
  if (selected) {
    layers.push(
      new ScatterplotLayer({
        id: `egms-selected-${key}`,
        data: [selected],
        getPosition: (d) => d.position,
        getRadius: POINT_STYLE.radiusMeters * 2.4,
        radiusUnits: "meters",
        radiusMinPixels: 6,
        radiusMaxPixels: 22,
        filled: false,
        stroked: true,
        billboard: false,
        getLineColor: [255, 255, 255, 230],
        getLineWidth: 2,
        lineWidthUnits: "pixels",
        pickable: false,
      })
    );
  }

  return layers;
}
