/**
 * stream-table-calibration.js — Empirical calibration store.
 *
 * Holds a list of calibration points derived from stream-table runs.
 * Each point pins the burn-perturbation curves to a measured pair:
 *
 *   { severity: number in [0, 1],          // burn-severity equivalent of the run
 *     infiltrationFactor: number in (0, 1], // observed runoff/coverage proxy → effective infiltration multiplier
 *     roughnessFactor: number in (0, 1],    // analogous Manning shift, if measurable
 *     d50_mm: number,                       // dominant grain size for the run
 *     channelCoverage: number in [0, 1],    // observed table-side channel fraction
 *     label: string,
 *     ts: number }
 *
 * When ≥2 points exist, the perturbation curves linearly interpolate (and
 * extrapolate to the [0, 1] severity bounds). With 0 or 1 points, the burn
 * perturbation falls back to literature constants.
 *
 * Persistence: localStorage under key 'mf-calib-runs'. Two pages (mosaic-flow
 * and stream-table) running in the same browser see the same calibration.
 */

const KEY = 'mf-calib-runs';

function safeRead() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function safeWrite(runs) {
  try { localStorage.setItem(KEY, JSON.stringify(runs)); } catch {}
}

export function getRuns() {
  return safeRead().slice().sort((a, b) => a.severity - b.severity);
}

export function addRun(entry) {
  const runs = safeRead();
  const e = {
    severity: clamp01(entry.severity),
    infiltrationFactor: clampPositive(entry.infiltrationFactor, 0.01, 1.5),
    roughnessFactor: clampPositive(entry.roughnessFactor ?? 1.0, 0.5, 1.5),
    d50_mm: entry.d50_mm ?? null,
    channelCoverage: entry.channelCoverage ?? null,
    label: entry.label || `run-${runs.length + 1}`,
    ts: Date.now(),
  };
  runs.push(e);
  safeWrite(runs);
  return e;
}

export function clearRuns() { safeWrite([]); }

export function removeRun(ts) {
  const runs = safeRead().filter(r => r.ts !== ts);
  safeWrite(runs);
}

/**
 * Build the active perturbation curves.
 * Returns a function (severity ∈ [0,1]) → { infiltrationFactor, roughnessFactor }.
 * - 0 points: literature defaults (1 − 0.70·s, 1 − 0.15·s).
 * - 1 point: anchors at that point and at severity 0 = (1.0, 1.0).
 * - ≥2 points: piecewise-linear over sorted severities, clamped to endpoint values.
 */
export function buildCurve() {
  const runs = getRuns();
  if (runs.length === 0) return literatureCurve();

  // Always anchor at severity 0 (no fire = no perturbation)
  const points = [
    { severity: 0, infiltrationFactor: 1.0, roughnessFactor: 1.0 },
    ...runs.filter(r => r.severity > 0),
  ].sort((a, b) => a.severity - b.severity);

  return (s) => {
    const x = clamp01(s);
    if (x <= points[0].severity) return pickFactors(points[0]);
    if (x >= points[points.length - 1].severity) return pickFactors(points[points.length - 1]);
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i], b = points[i + 1];
      if (x >= a.severity && x <= b.severity) {
        const t = (x - a.severity) / (b.severity - a.severity || 1);
        return {
          infiltrationFactor: a.infiltrationFactor + (b.infiltrationFactor - a.infiltrationFactor) * t,
          roughnessFactor:    a.roughnessFactor    + (b.roughnessFactor    - a.roughnessFactor)    * t,
        };
      }
    }
    return pickFactors(points[points.length - 1]);
  };
}

function pickFactors(p) {
  return { infiltrationFactor: p.infiltrationFactor, roughnessFactor: p.roughnessFactor };
}

function literatureCurve() {
  return (s) => {
    const x = clamp01(s);
    return {
      infiltrationFactor: 1 - 0.70 * x,
      roughnessFactor:    1 - 0.15 * x,
    };
  };
}

export function provenance() {
  const runs = getRuns();
  if (runs.length === 0) return { source: 'literature', n: 0 };
  return { source: 'stream-table', n: runs.length, labels: runs.map(r => r.label) };
}

function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function clampPositive(x, lo, hi) {
  const n = Number(x);
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}
