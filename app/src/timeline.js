// timeline.js — playback over the 303 EGMS acquisition dates.
//
// The whole series is decoded once per component into a date-major typed array
// (see loadMatrix). A frame is then just a contiguous subarray handed to the
// deck.gl layer via updateTriggers — no refetch, no re-parse, no allocation.
//
// The static map keeps showing mean_velocity; this only takes over once the
// user plays or scrubs, and exit() puts it back.

import { loadMatrix, frameValues } from "./timeseries.js?v=7";
import { animRamp } from "./egms-layer.js?v=7";
import { ANIM } from "./config.js?v=7";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function createTimeline({ onFrame, onEnter, onExit, onProgress, onPlayState }) {
  let bundle = null;   // matrix for the active component
  let ramp = null;
  let key = null;
  let frame = 0;
  let active = false;
  let playing = false;
  let timerId = null;

  /** Load (once) and switch the map into cumulative-displacement mode. */
  async function enter(componentKey, points) {
    key = componentKey;
    bundle = await loadMatrix(componentKey, points.map((p) => p.pid), onProgress);
    ramp = animRamp(componentKey, bundle);
    active = true;
    if (frame >= bundle.nDates) frame = bundle.nDates - 1;
    onEnter?.(bundle, ramp);
    emit();
  }

  function emit() {
    if (!active) return;
    onFrame?.({
      values: frameValues(bundle, frame),
      frame,
      date: bundle.dates[frame],
      nDates: bundle.nDates,
      ramp,
    });
  }

  // Stepping runs on a self-scheduling setTimeout, NOT requestAnimationFrame.
  //
  // rAF is suspended whenever the page isn't being painted — a background tab,
  // a hidden panel, an occluded window. Playback driven by rAF then stops dead
  // with `playing` still true: the button reads "pause" and the date never
  // moves, with no error. Timers keep firing (throttled at worst), so playback
  // degrades to "slower" instead of "frozen".
  //
  // This is also the honest model: advancing the date is a data step. Changing
  // the layer props makes deck.gl and MapLibre schedule their own repaint, so
  // there is nothing here that needs to be frame-synced.
  //
  // Self-scheduling rather than setInterval so a slow frame delays the next one
  // instead of letting callbacks pile up behind it.
  function tick() {
    if (!playing) return;
    frame += 1;
    if (frame >= bundle.nDates - 1) {
      frame = bundle.nDates - 1;
      emit();
      pause();
      return;
    }
    emit();
    timerId = setTimeout(tick, 1000 / ANIM.fps);
  }

  function play() {
    if (!active || playing) return;
    // Replay from the start if we're parked on the last frame.
    if (frame >= bundle.nDates - 1) frame = 0;
    playing = true;
    onPlayState?.(true);
    timerId = setTimeout(tick, 1000 / ANIM.fps);
  }

  function pause() {
    playing = false;
    if (timerId !== null) clearTimeout(timerId);
    timerId = null;
    onPlayState?.(false);
  }

  function setFrame(i) {
    if (!active || !bundle) return;
    frame = Math.max(0, Math.min(bundle.nDates - 1, i | 0));
    emit();
  }

  /** Back to the static mean_velocity map. */
  function exit() {
    pause();
    active = false;
    onExit?.();
  }

  /** Advance exactly one frame without rAF — used by tests/verification. */
  function stepOnce() {
    if (!active) return false;
    if (frame >= bundle.nDates - 1) return false;
    frame += 1;
    emit();
    return true;
  }

  const fmtDate = (d) =>
    `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;

  return {
    enter, exit, play, pause, setFrame, stepOnce, fmtDate,
    isActive: () => active,
    isPlaying: () => playing,
    getFrame: () => frame,
    getBundle: () => bundle,
    getKey: () => key,
  };
}
