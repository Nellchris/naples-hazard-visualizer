// map.js — MapLibre init, DEM terrain, OSM buildings, deck.gl overlay, the U/E
// toggle, the basemap toggle, and the click -> time-series panel.
//
// maplibre-gl and deck.gl load as UMD globals (`maplibregl`, `deck`).

import {
  COMPONENTS,
  DEFAULT_COMPONENT,
  BASEMAPS,
  DEFAULT_BASEMAP,
  INITIAL_VIEW,
  AOI_BBOX,
  TERRAIN,
  BUILDINGS,
  COLUMN,
  ANIM,
  DATA,
} from "./config.js?v=7";

import {
  loadPoints,
  buildLayer,
  rampColor,
  rampGradient,
  stats,
  setRampTheme,
  columnOpacity,
} from "./egms-layer.js?v=7";
import { getSeries, chartSVG } from "./timeseries.js?v=7";
import { createTimeline } from "./timeline.js?v=7";

const el = (id) => document.getElementById(id);

let current = DEFAULT_COMPONENT;
let currentPoints = [];
let selected = null;
let overlay;

let basemap = DEFAULT_BASEMAP;
let terrainWanted = TERRAIN.enabledByDefault;

let buildingsState = "idle"; // idle -> loading -> ready | error
let buildingsWanted = true;
let buildingsData = null; // kept so a basemap switch never refetches

let lastColFade = null;

/* ---------- map --------------------------------------------------------- */

const map = new maplibregl.Map({
  container: "map",
  style: BASEMAPS[basemap].url,
  center: INITIAL_VIEW.center,
  zoom: INITIAL_VIEW.zoom,
  pitch: INITIAL_VIEW.pitch,
  bearing: INITIAL_VIEW.bearing,
  maxPitch: 80,
  attributionControl: false,
});

map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
map.addControl(
  new maplibregl.AttributionControl({
    compact: true,
    customAttribution:
      "EGMS © European Union, Copernicus Land Monitoring Service / EEA · " +
      "Copernicus DEM © DLR/Airbus, ESA",
  }),
  "bottom-right"
);

/* ---------- terrain ----------------------------------------------------- */

// Built by concatenation on purpose — putting {z}/{x}/{y} through `new URL()`
// would percent-encode the braces and MapLibre would stop recognising them.
const DEM_TILE_URL =
  new URL(DATA.demTiles.replace("{z}/{x}/{y}.png", ""), location.href).href +
  "{z}/{x}/{y}.png";

function addTerrain() {
  if (!map.getSource("dem")) {
    map.addSource("dem", {
      type: "raster-dem",
      tiles: [DEM_TILE_URL],
      tileSize: 256,
      encoding: DATA.demEncoding, // "terrarium" — matches 03_dem_prep.sh
      minzoom: TERRAIN.minzoom,
      maxzoom: TERRAIN.maxzoom,
      bounds: TERRAIN.bounds,
    });
  }
  map.setTerrain({ source: "dem", exaggeration: TERRAIN.exaggeration });
}

function setTerrainEnabled(on) {
  terrainWanted = on;
  if (on) addTerrain();
  else map.setTerrain(null);
  el("terrain-toggle").setAttribute("aria-pressed", String(on));
  el("terrain-toggle").classList.toggle("active", on);
}

/* ---------- buildings (lazy + zoom-gated + cross-dissolved) ------------- */

function addBuildingsLayer() {
  if (!buildingsData || map.getLayer("buildings-3d")) return;

  if (!map.getSource("buildings")) {
    map.addSource("buildings", { type: "geojson", data: buildingsData });
  }
  map.addLayer({
    id: "buildings-3d",
    type: "fill-extrusion",
    source: "buildings",
    minzoom: BUILDINGS.minzoom,
    paint: {
      "fill-extrusion-height": ["get", "height"],
      "fill-extrusion-base": 0,
      // Tagged buildings carry a real OSM height and read as solid landmarks.
      // The rest are the assumed 6 m default, muted so the map doesn't imply
      // height data it doesn't have. Both follow the active basemap.
      "fill-extrusion-color": [
        "case",
        ["==", ["get", "height_source"], "tagged"],
        BASEMAPS[basemap].buildings.tagged,
        BASEMAPS[basemap].buildings.default,
      ],
      // Fade in as the columns fade out.
      "fill-extrusion-opacity": [
        "interpolate",
        ["linear"],
        ["zoom"],
        BUILDINGS.minzoom,
        0,
        BUILDINGS.fadeInEnd,
        BUILDINGS.opacity,
      ],
      "fill-extrusion-vertical-gradient": true,
    },
  });
  map.setLayoutProperty(
    "buildings-3d",
    "visibility",
    buildingsWanted ? "visible" : "none"
  );
}

async function loadBuildings() {
  if (buildingsState !== "idle" || !buildingsWanted) return;
  buildingsState = "loading";
  el("buildings-toggle").classList.add("busy");

  try {
    const resp = await fetch(DATA.buildings);
    if (!resp.ok) throw new Error(`buildings → HTTP ${resp.status}`);
    buildingsData = await resp.json();
    addBuildingsLayer();
    buildingsState = "ready";
  } catch (err) {
    buildingsState = "error";
    console.error(err);
    el("status").hidden = false;
    el("status").textContent = err.message;
    el("status").classList.add("error");
  } finally {
    el("buildings-toggle").classList.remove("busy");
  }
}

function setBuildingsVisible(on) {
  buildingsWanted = on;
  el("buildings-toggle").classList.toggle("active", on);
  el("buildings-toggle").setAttribute("aria-pressed", String(on));
  if (buildingsState === "ready" && map.getLayer("buildings-3d")) {
    map.setLayoutProperty("buildings-3d", "visibility", on ? "visible" : "none");
  } else if (on) {
    maybeLoadBuildings();
  }
}

function maybeLoadBuildings() {
  if (buildingsWanted && buildingsState === "idle" && map.getZoom() >= BUILDINGS.lazyZoom) {
    loadBuildings();
  }
  const hint = el("buildings-hint");
  if (hint) {
    hint.hidden = !(
      buildingsWanted &&
      buildingsState !== "error" &&
      map.getZoom() < BUILDINGS.minzoom
    );
  }
}

/* ---------- deck overlay ------------------------------------------------ */

if (!deck.MapboxOverlay) {
  throw new Error("deck.MapboxOverlay missing — is @deck.gl/mapbox loaded?");
}

overlay = new deck.MapboxOverlay({
  interleaved: true,
  layers: [],
  getTooltip: ({ object }) =>
    object && {
      html:
        `<strong>${object.v >= 0 ? "+" : ""}${object.v.toFixed(1)} ` +
        `${COMPONENTS[current].unit}</strong><br/>` +
        `<span class="tt-sub">${
          object.v >= 0 ? COMPONENTS[current].posLabel : COMPONENTS[current].negLabel
        } · ${object.h.toFixed(0)} m · click for series</span>`,
      style: {
        background: "rgba(16,18,22,0.94)",
        color: "#e8eaed",
        fontSize: "12px",
        padding: "7px 9px",
        borderRadius: "5px",
        border: "1px solid rgba(255,255,255,0.16)",
        boxShadow: "0 3px 12px rgba(0,0,0,0.5)",
      },
    },
});
map.addControl(overlay);

let animState = null; // {values, frame, ramp} while the timeline is driving

function refreshLayers() {
  lastColFade = columnOpacity(map.getZoom());
  overlay.setProps({
    layers: buildLayer(current, currentPoints, {
      onClick: onPointClick,
      selected,
      zoom: map.getZoom(),
      anim: animState,
    }),
  });
}

/* ---------- basemap ----------------------------------------------------- */

function setBasemap(key) {
  if (key === basemap) return;
  basemap = key;
  setRampTheme(key);

  for (const b of document.querySelectorAll("#basemap-toggle button")) {
    const on = b.dataset.basemap === key;
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", String(on));
  }
  document.body.dataset.basemap = key;

  // setStyle drops every source and layer we added, so put them back once the
  // new style is in. buildingsData is already in memory — no refetch.
  map.setStyle(BASEMAPS[key].url);
  map.once("style.load", () => {
    if (terrainWanted) addTerrain();
    if (buildingsState === "ready") addBuildingsLayer();
    refreshLayers();
    if (currentPoints.length) renderLegend(current, stats(currentPoints));
  });
}

/* ---------- time-series panel ------------------------------------------- */

function onPointClick({ object }) {
  if (!object) return true;
  selected = object;
  refreshLayers();
  openPanel(object);
  return true;
}

async function openPanel(point) {
  const c = COMPONENTS[current];
  el("ts").hidden = false;
  el("ts-title").textContent = `pid ${point.pid}`;
  el("ts-meta").innerHTML =
    `<span>${point.v >= 0 ? "+" : ""}${point.v.toFixed(1)} ${c.unit}</span>` +
    `<span>${point.h.toFixed(0)} m elev.</span>` +
    `<span>${c.short} component</span>`;
  el("ts-chart").innerHTML = `<div class="ts-empty">loading …</div>`;
  el("ts-note").textContent = "";

  const token = `${current}:${point.pid}`;
  el("ts").dataset.token = token;

  try {
    const { dates, values } = await getSeries(current, point.pid, (msg) => {
      if (el("ts").dataset.token === token)
        el("ts-chart").innerHTML = `<div class="ts-empty">${msg}</div>`;
    });
    if (el("ts").dataset.token !== token) return;

    el("ts-chart").innerHTML = chartSVG(dates, values, point.v);

    const clean = values.filter((v) => v !== null && v !== undefined);
    const total = clean[clean.length - 1] - clean[0];
    el("ts-note").innerHTML =
      `<span class="ts-key"><i class="k-line"></i>measured</span>` +
      `<span class="ts-key"><i class="k-trend"></i>mean_velocity trend</span>` +
      `<span class="ts-total">${total >= 0 ? "+" : ""}${total.toFixed(0)} mm total</span>`;
  } catch (err) {
    if (el("ts").dataset.token !== token) return;
    el("ts-chart").innerHTML = `<div class="ts-empty err">${err.message}</div>`;
    console.error(err);
  }
}

function closePanel() {
  el("ts").hidden = true;
  selected = null;
  refreshLayers();
}

/* ---------- legend ------------------------------------------------------ */

/** Evenly spaced ticks across a domain, always including the zero stop. */
function autoTicks([lo, , hi]) {
  const out = new Set([lo, 0, hi]);
  for (let i = 1; i < 4; i++) {
    out.add(Math.round((lo + ((hi - lo) * i) / 4) / 50) * 50);
  }
  return [...out].filter((v) => v >= lo && v <= hi).sort((a, b) => a - b);
}

function renderLegend(key, s) {
  const c = COMPONENTS[key];
  // While the timeline drives the map the legend must describe what's on screen
  // — cumulative mm, not mm/yr — or the colours are simply mislabelled.
  const ramp = animState ? animState.ramp : c;
  const [lo, mid, hi] = ramp.domain;

  el("legend-bar").style.background = rampGradient(ramp);
  el("legend-title").textContent = animState
    ? `${c.label} — cumulative displacement (mm)`
    : `${c.label} — mean velocity (${c.unit})`;

  const ticks = animState
    ? autoTicks(ramp.domain)
    : key === "U"
      ? [-15, 0, 10, 30, 60, 100, 145]
      : [-60, -30, 0, 30, 60];
  el("legend-ticks").innerHTML = ticks
    .map((v) => {
      // Guard the degenerate arms: an animation domain can legitimately have
      // lo === 0 (a component that never goes negative), and dividing by a
      // zero-width arm would place every tick at NaN%.
      let f;
      if (v >= mid) {
        const t = hi === mid ? 0 : Math.pow((v - mid) / (hi - mid), ramp.exponent.pos);
        f = (mid - lo + t * (hi - mid)) / (hi - lo);
      } else {
        const t = mid === lo ? 0 : Math.pow((mid - v) / (mid - lo), ramp.exponent.neg);
        f = (mid - lo - t * (mid - lo)) / (hi - lo);
      }
      return `<span class="tick" style="left:${(f * 100).toFixed(2)}%">${
        v > 0 ? "+" : ""
      }${v}</span>`;
    })
    .join("");

  el("legend-ends").innerHTML = `<span>${c.negLabel}</span><span>${c.posLabel}</span>`;

  const nonLinear = ramp.exponent.pos !== 1 || ramp.exponent.neg !== 1;
  const scaleNote = nonLinear
    ? `positive arm on a √ scale (cap held at +${hi})`
    : "linear scale";

  if (animState) {
    el("legend-note").textContent =
      c.render === "columns"
        ? `${scaleNote} · columns ${ANIM.metresPerMm} m per mm displaced`
        : `${scaleNote} · point size grows with |displacement|`;
  } else {
    el("legend-note").textContent =
      c.render === "columns"
        ? `${scaleNote} · columns ${COLUMN.metresPerMmPerYear} m per mm/yr`
        : `${scaleNote} · draped on terrain`;
  }

  el("readout").innerHTML =
    `<b>${s.n.toLocaleString()}</b> points · ` +
    `min <b>${s.min.toFixed(1)}</b> · mean <b>${s.mean >= 0 ? "+" : ""}${s.mean.toFixed(1)}</b> · ` +
    `max <b>+${s.max.toFixed(1)}</b> ${c.unit} <span class="ro-sub">(mean velocity)</span>`;
}

/* ---------- component switching ----------------------------------------- */

async function show(key) {
  current = key;

  for (const b of document.querySelectorAll(".toggle button")) {
    b.classList.toggle("active", b.dataset.component === key);
    b.setAttribute("aria-pressed", String(b.dataset.component === key));
  }

  el("status").textContent = `loading ${COMPONENTS[key].short} …`;
  el("status").hidden = false;

  try {
    const points = await loadPoints(key);
    if (current !== key) return;

    currentPoints = points;
    if (selected) selected = points.find((p) => p.pid === selected.pid) || null;

    if (timeline.isActive()) {
      // Carry playback across the component switch, holding the same date.
      // The old component's frame values must be dropped first — they're the
      // right length but the wrong measurement.
      const wasPlaying = timeline.isPlaying();
      timeline.pause();
      animState = null;
      await timeline.enter(key, points); // emits a frame -> refresh + legend
      if (wasPlaying) timeline.play();
    } else {
      refreshLayers();
      renderLegend(key, stats(points));
    }
    setTimelineReady(true);
    el("status").hidden = true;

    if (selected) openPanel(selected);
  } catch (err) {
    el("status").hidden = false;
    el("status").textContent = err.message;
    el("status").classList.add("error");
    console.error(err);
  }
}

/* ---------- timeline ---------------------------------------------------- */

const timeline = createTimeline({
  onProgress: (msg) => {
    el("status").hidden = false;
    el("status").classList.remove("error");
    el("status").textContent = msg;
  },
  onEnter: (bundle) => {
    el("status").hidden = true;
    el("timeline").hidden = false;
    el("tl-range").max = String(bundle.nDates - 1);
    el("tl-open").classList.add("active");
  },
  onFrame: ({ values, frame, date, nDates, ramp }) => {
    animState = { values, frame, ramp };
    refreshLayers();
    el("tl-range").value = String(frame);
    el("tl-date").textContent = timeline.fmtDate(date);
    el("tl-cum").textContent = `${frame + 1} / ${nDates} acquisitions`;
    renderLegend(current, stats(currentPoints));
  },
  onExit: () => {
    animState = null;
    el("timeline").hidden = true;
    el("tl-open").classList.remove("active");
    refreshLayers();
    renderLegend(current, stats(currentPoints));
  },
  onPlayState: (playing) => {
    el("tl-play").textContent = playing ? "❚❚" : "▶";
    el("tl-play").setAttribute("aria-label", playing ? "Pause" : "Play");
  },
});

function setTimelineReady(ready) {
  el("tl-open").disabled = !ready;
  el("tl-open").title = ready
    ? "Animate 2020-2024"
    : "Loading points …";
}

async function openTimeline() {
  if (timeline.isActive()) {
    timeline.exit();
    return;
  }
  // Guarded by the disabled attribute too (see setTimelineReady); this is the
  // belt-and-braces half. It used to `return` silently, which made the button
  // look broken if it was clicked while the points were still downloading.
  if (!currentPoints.length) {
    el("status").hidden = false;
    el("status").classList.remove("error");
    el("status").textContent = "still loading points — try again in a moment";
    return;
  }
  try {
    await timeline.enter(current, currentPoints);
  } catch (err) {
    console.error(err);
    el("status").hidden = false;
    el("status").classList.add("error");
    el("status").textContent = err.message;
  }
}

el("tl-open").addEventListener("click", openTimeline);
el("tl-play").addEventListener("click", () =>
  timeline.isPlaying() ? timeline.pause() : timeline.play()
);
el("tl-exit").addEventListener("click", () => timeline.exit());
el("tl-range").addEventListener("input", (e) => {
  timeline.pause(); // scrubbing takes manual control
  timeline.setFrame(+e.target.value);
});

/* ---------- intro panel ------------------------------------------------- */

// Dismissal lives in this module variable and nowhere else. No localStorage or
// sessionStorage: storage is unavailable in some embeddings and throws on
// access, and this is a nicety that must never break the map. A reload shows it
// again, which is the honest consequence of in-memory state.
let introDismissed = false;
let introLastFocus = null;

function openIntro() {
  introLastFocus = document.activeElement;
  el("intro").hidden = false;
  el("intro-backdrop").hidden = false;
  el("intro-go").focus();
}

function closeIntro() {
  introDismissed = true;
  el("intro").hidden = true;
  el("intro-backdrop").hidden = true;

  // Never hand focus back to something inside the panel we just hid — fall back
  // to the "?" button, which is the control the dialog belongs to.
  // document.body is excluded too: it isn't focusable, so focusing it is a
  // no-op that would silently leave focus on the hidden panel's button.
  const prev = introLastFocus;
  const usable =
    prev &&
    prev !== document.body &&
    typeof prev.focus === "function" &&
    document.contains(prev) &&
    !el("intro").contains(prev);
  (usable ? prev : el("intro-open")).focus();
}

el("intro-open").addEventListener("click", openIntro);
el("intro-close").addEventListener("click", closeIntro);
el("intro-go").addEventListener("click", closeIntro);
el("intro-backdrop").addEventListener("click", closeIntro);

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !el("intro").hidden) closeIntro();
});

// Shown immediately, not on map "load" — there's reading to do while the
// basemap, DEM and points are still arriving.
if (!introDismissed) openIntro();

/* ---------- ui ---------------------------------------------------------- */

for (const b of document.querySelectorAll(".toggle button")) {
  b.addEventListener("click", () => {
    if (b.dataset.component !== current) show(b.dataset.component);
  });
}

for (const b of document.querySelectorAll("#basemap-toggle button")) {
  b.addEventListener("click", () => setBasemap(b.dataset.basemap));
}

el("terrain-toggle").addEventListener("click", () =>
  setTerrainEnabled(!map.getTerrain())
);
el("buildings-toggle").addEventListener("click", () =>
  setBuildingsVisible(!buildingsWanted)
);
el("ts-close").addEventListener("click", closePanel);

el("fit-aoi").addEventListener("click", () =>
  map.fitBounds(
    [
      [AOI_BBOX[0], AOI_BBOX[1]],
      [AOI_BBOX[2], AOI_BBOX[3]],
    ],
    { padding: 40, pitch: map.getPitch(), duration: 900 }
  )
);
el("fit-caldera").addEventListener("click", () =>
  map.flyTo({ center: INITIAL_VIEW.center, zoom: 13.2, pitch: 62, duration: 1100 })
);

// Cross-dissolve needs a layer rebuild as the zoom crosses the fade band, but
// only when the opacity actually moves — not on every zoom frame.
map.on("zoom", () => {
  const f = columnOpacity(map.getZoom());
  if (lastColFade === null || Math.abs(f - lastColFade) > 0.02) refreshLayers();
});
map.on("moveend", maybeLoadBuildings);
map.on("zoomend", maybeLoadBuildings);

map.on("load", () => {
  document.body.dataset.basemap = basemap;
  if (terrainWanted) setTerrainEnabled(true);
  setBuildingsVisible(true);
  maybeLoadBuildings();
  show(DEFAULT_COMPONENT);
});

// Debug handle: lets the map be poked from the console without a rebuild.
// Read-only conveniences plus the timeline controller — nothing here is part
// of the app's own control flow.
window._naples = {
  map,
  overlay,
  rampColor,
  COMPONENTS,
  getSeries,
  setBasemap,
  loadBuildings,
  buildingsState: () => buildingsState,
  columnOpacity,
  timeline,
  openTimeline,
  animState: () => animState,
};
