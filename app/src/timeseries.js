// timeseries.js — click a point -> read that pid's displacement series from the
// component's Parquet and plot it.
//
// Reader: hyparquet (ESM, ~36 kB). The file is fetched once per component and
// kept in memory as an ArrayBuffer; hyparquet then reads straight out of that,
// so a click costs no network. 02_egms_prep.py writes 2048-row row groups, so
// pulling one row decodes ~1/10th of the file rather than all of it.

import { COMPONENTS } from "./config.js?v=7";

const HYPARQUET = "https://cdn.jsdelivr.net/npm/hyparquet@1.17.1/+esm";

let hy = null;
const stores = new Map(); // component key -> {file, dateCols, dates, pidRow}
const seriesCache = new Map(); // `${key}:${pid}` -> number[]

async function lib() {
  if (!hy) hy = await import(HYPARQUET);
  return hy;
}

/** Wrap an ArrayBuffer as the AsyncBuffer shape hyparquet expects. */
function bufferFile(ab) {
  return { byteLength: ab.byteLength, slice: (start, end) => ab.slice(start, end) };
}

const parseDate = (s) =>
  new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)));

/**
 * Fetch + index one component's parquet. Resolves to the store; concurrent
 * callers share the same in-flight promise.
 */
function ensureStore(key, onProgress) {
  if (stores.has(key)) return stores.get(key);

  const promise = (async () => {
    const { parquetMetadataAsync, parquetRead } = await lib();

    onProgress?.("downloading time series …");
    const url = COMPONENTS[key].timeseries;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`${url} → HTTP ${resp.status}`);
    const file = bufferFile(await resp.arrayBuffer());

    onProgress?.("indexing …");
    const meta = await parquetMetadataAsync(file);
    // schema[0] is the root node; the rest are the leaf columns in file order.
    const names = meta.schema.slice(1).map((e) => e.name);
    const dateCols = names.filter((n) => /^\d{8}$/.test(n));

    // Index pid -> row number. One column across all row groups is cheap.
    const pidRow = new Map();
    await parquetRead({
      file,
      columns: ["pid"],
      onComplete: (rows) => {
        for (let i = 0; i < rows.length; i++) pidRow.set(rows[i][0], i);
      },
    });

    return { file, dateCols, dates: dateCols.map(parseDate), pidRow };
  })();

  stores.set(key, promise);
  promise.catch(() => stores.delete(key)); // let a failed load be retried
  return promise;
}

/** Displacement series (mm) for one pid, aligned to store.dates. */
export async function getSeries(key, pid, onProgress) {
  const cacheKey = `${key}:${pid}`;
  if (seriesCache.has(cacheKey)) {
    return { ...(await ensureStore(key)), values: seriesCache.get(cacheKey) };
  }

  const store = await ensureStore(key, onProgress);
  const row = store.pidRow.get(pid);
  if (row === undefined) throw new Error(`pid ${pid} not in the time series`);

  const { parquetRead } = await lib();
  let values = null;
  await parquetRead({
    file: store.file,
    columns: store.dateCols,
    rowStart: row,
    rowEnd: row + 1,
    onComplete: (rows) => {
      values = rows[0];
    },
  });

  seriesCache.set(cacheKey, values);
  return { ...store, values };
}

/* ---------- full matrix (time animation) -------------------------------- */

const matrixCache = new Map(); // component key -> matrix bundle

/**
 * Decode the WHOLE series for a component into one typed array, once.
 *
 * Layout is DATE-MAJOR: value for point i at date t lives at [t * nPoints + i].
 * That makes a single animation frame a contiguous `subarray` — no gather, no
 * per-frame allocation. Point-major would have forced a strided read every
 * frame, which is exactly the wrong trade for playback.
 *
 * Decoded in row-group-sized chunks so the intermediate JS row arrays (19,306 x
 * 303 numbers if taken in one go) never all exist at once.
 *
 * `pids` fixes the output order: the matrix is indexed by the caller's point
 * order, not by parquet row order, so accessors can use deck's `index` directly.
 */
export async function loadMatrix(key, pids, onProgress) {
  if (matrixCache.has(key)) return matrixCache.get(key);

  const promise = (async () => {
    const store = await ensureStore(key, onProgress);
    const { parquetRead } = await lib();

    const nDates = store.dateCols.length;
    const nPoints = pids.length;
    const totalRows = store.pidRow.size;

    // parquet row -> index in the caller's points array
    const rowToPoint = new Int32Array(totalRows).fill(-1);
    for (let i = 0; i < nPoints; i++) {
      const r = store.pidRow.get(pids[i]);
      if (r !== undefined) rowToPoint[r] = i;
    }

    // Float32 is plenty: displacements are ~10^3 mm at 0.1 mm meaningful
    // precision, and Float64 would double this to ~47 MB for no benefit.
    const matrix = new Float32Array(nDates * nPoints);
    let min = Infinity;
    let max = -Infinity;

    const CHUNK = 2048; // matches the parquet row-group size
    for (let start = 0; start < totalRows; start += CHUNK) {
      const end = Math.min(start + CHUNK, totalRows);
      await parquetRead({
        file: store.file,
        columns: store.dateCols,
        rowStart: start,
        rowEnd: end,
        onComplete: (rows) => {
          for (let k = 0; k < rows.length; k++) {
            const pi = rowToPoint[start + k];
            if (pi < 0) continue;
            const row = rows[k];
            for (let t = 0; t < nDates; t++) {
              const raw = row[t];
              const v = raw === null || raw === undefined || Number.isNaN(raw) ? 0 : raw;
              matrix[t * nPoints + pi] = v;
              if (v < min) min = v;
              if (v > max) max = v;
            }
          }
        },
      });
      onProgress?.(`decoding ${Math.round((end / totalRows) * 100)}% …`);
    }

    return { matrix, nDates, nPoints, dates: store.dates, min, max };
  })();

  matrixCache.set(key, promise);
  promise.catch(() => matrixCache.delete(key));
  return promise;
}

/** One frame as a contiguous view — no copy. */
export function frameValues(bundle, t) {
  const { matrix, nPoints } = bundle;
  return matrix.subarray(t * nPoints, (t + 1) * nPoints);
}

/* ---------- chart ------------------------------------------------------- */

const W = 360;
const H = 150;
const PAD = { l: 38, r: 8, t: 10, b: 20 };

/**
 * Line chart of displacement over time, with the mean_velocity trend drawn as a
 * dashed straight line for comparison. mean_velocity is a single linear slope
 * over a signal that accelerates, so near the caldera the measured curve should
 * visibly bend ABOVE the dashed line — that divergence is the real physics, not
 * a fitting error, and the chart is drawn to make it legible rather than hide it.
 */
export function chartSVG(dates, values, meanVelocity) {
  const pts = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === null || v === undefined || Number.isNaN(v)) continue;
    pts.push([dates[i].getTime(), v]);
  }
  if (pts.length < 2) return `<div class="ts-empty">no series for this point</div>`;

  const t0 = pts[0][0];
  const t1 = pts[pts.length - 1][0];
  const YEAR = 365.25 * 24 * 3600 * 1000;

  // Trend line with the reported slope, anchored so it shares the data's mean.
  const meanT = pts.reduce((s, p) => s + (p[0] - t0) / YEAR, 0) / pts.length;
  const meanY = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const trend = (t) => meanY + meanVelocity * ((t - t0) / YEAR - meanT);

  let lo = Infinity;
  let hi = -Infinity;
  for (const [, y] of pts) {
    if (y < lo) lo = y;
    if (y > hi) hi = y;
  }
  for (const t of [t0, t1]) {
    const y = trend(t);
    if (y < lo) lo = y;
    if (y > hi) hi = y;
  }
  const span = hi - lo || 1;
  lo -= span * 0.1;
  hi += span * 0.1;

  const X = (t) => PAD.l + ((t - t0) / (t1 - t0)) * (W - PAD.l - PAD.r);
  const Y = (v) => PAD.t + (1 - (v - lo) / (hi - lo)) * (H - PAD.t - PAD.b);

  const path = pts.map(([t, v], i) => `${i ? "L" : "M"}${X(t).toFixed(1)},${Y(v).toFixed(1)}`).join("");

  // y gridlines at rounded values
  const step = niceStep((hi - lo) / 3);
  const grid = [];
  for (let g = Math.ceil(lo / step) * step; g <= hi; g += step) {
    const y = Y(g).toFixed(1);
    grid.push(
      `<line class="ts-grid" x1="${PAD.l}" x2="${W - PAD.r}" y1="${y}" y2="${y}"/>` +
        `<text class="ts-ylab" x="${PAD.l - 5}" y="${y}" dy="3">${Math.round(g)}</text>`
    );
  }

  // x labels: first and last year
  const yr = (t) => new Date(t).getUTCFullYear();
  const zeroY = lo <= 0 && hi >= 0 ? Y(0).toFixed(1) : null;

  return `<svg viewBox="0 0 ${W} ${H}" class="ts-svg" role="img"
    aria-label="displacement time series, ${pts.length} acquisitions">
    ${grid.join("")}
    ${zeroY ? `<line class="ts-zero" x1="${PAD.l}" x2="${W - PAD.r}" y1="${zeroY}" y2="${zeroY}"/>` : ""}
    <line class="ts-trend" x1="${X(t0)}" y1="${Y(trend(t0)).toFixed(1)}"
          x2="${X(t1)}" y2="${Y(trend(t1)).toFixed(1)}"/>
    <path class="ts-line" d="${path}"/>
    <text class="ts-xlab" x="${PAD.l}" y="${H - 6}">${yr(t0)}</text>
    <text class="ts-xlab" x="${W - PAD.r}" y="${H - 6}" text-anchor="end">${yr(t1)}</text>
  </svg>`;
}

function niceStep(raw) {
  const mag = Math.pow(10, Math.floor(Math.log10(Math.abs(raw) || 1)));
  const n = raw / mag;
  return (n >= 5 ? 5 : n >= 2 ? 2 : 1) * mag;
}
