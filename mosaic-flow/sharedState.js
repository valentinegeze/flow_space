/**
 * sharedState.js — Cross-tab reactive simulation state.
 *
 * Single source of truth for derived grids (burn severity, soil properties,
 * hydrology) that multiple tabs read from and write to.  Includes a simple
 * pub/sub so tabs can subscribe to changes without tight coupling.
 */

import { FIRE } from './fire.js';

// ═══════════════════════════════════════════════════════════════════════════
// SSURGO lookup table — Cohasset gravelly loam anchor points
// ═══════════════════════════════════════════════════════════════════════════

export const SSURGO_ANCHORS = [
  { severity: 0.0,  infiltrationRate: 20.0, organicMatter: 3.1, kFactor: 0.24, hydrologicGroup: 'B', cohesion: 8.0, frictionAngle: 32 },
  { severity: 0.33, infiltrationRate: 12.0, organicMatter: 2.0, kFactor: 0.31, hydrologicGroup: 'C', cohesion: 5.0, frictionAngle: 30 },
  { severity: 0.66, infiltrationRate:  4.0, organicMatter: 1.2, kFactor: 0.42, hydrologicGroup: 'C', cohesion: 2.5, frictionAngle: 28 },
  { severity: 1.0,  infiltrationRate:  1.2, organicMatter: 0.6, kFactor: 0.55, hydrologicGroup: 'D', cohesion: 0.5, frictionAngle: 25 },
];

// Numeric fields that get linearly interpolated
const INTERP_FIELDS = ['infiltrationRate', 'organicMatter', 'kFactor', 'cohesion', 'frictionAngle'];

/**
 * Look up soil properties for a given burn severity (0–1).
 * Numeric fields interpolate linearly between anchor points.
 * hydrologicGroup snaps to the lower bracket's value.
 */
function lookupSoilProperties(severity) {
  const s = Math.max(0, Math.min(1, severity));

  // Find bracketing anchors
  let lo = SSURGO_ANCHORS[0];
  let hi = SSURGO_ANCHORS[SSURGO_ANCHORS.length - 1];
  for (let i = 0; i < SSURGO_ANCHORS.length - 1; i++) {
    if (s >= SSURGO_ANCHORS[i].severity && s <= SSURGO_ANCHORS[i + 1].severity) {
      lo = SSURGO_ANCHORS[i];
      hi = SSURGO_ANCHORS[i + 1];
      break;
    }
  }

  const range = hi.severity - lo.severity || 1;
  const t = (s - lo.severity) / range;

  const result = { hydrologicGroup: lo.hydrologicGroup };
  for (const f of INTERP_FIELDS) {
    result[f] = lo[f] + (hi[f] - lo[f]) * t;
  }
  // Snap hydrologicGroup to the higher bracket when past midpoint
  if (t > 0.5) result.hydrologicGroup = hi.hydrologicGroup;

  return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// Shared state object
// ═══════════════════════════════════════════════════════════════════════════

const _listeners = new Set();

export const sharedState = {
  /** One value per cell, 0.0–1.0 (0=unburned, 0.33=low, 0.66=moderate, 1.0=high). */
  burnSeverityGrid: null,

  /** Derived from burnSeverityGrid via SSURGO lookup. Array of { infiltrationRate, organicMatter, kFactor, hydrologicGroup, cohesion, frictionAngle }. */
  soilPropertyGrid: null,

  /** Precipitation rate in mm/hr, controlled by Hydro tab slider. */
  precipitationRate: 0,

  /** Excess rainfall per cell (mm/hr), computed by Hydro tab. */
  runoffGrid: null,

  /** Soil saturation fraction per cell (0–1), computed by Hydro tab. */
  saturationGrid: null,

  /** Factor of Safety per cell; values < 1.0 = slope failure / debris flow initiation. */
  fsSafetyGrid: null,

  /** Current scenario phase. */
  scenarioPhase: 'pre-fire',

  /** Grid dimensions (same as fire simulation grid). */
  cols: 64,
  rows: 64,

  /** Snapshot of completed fire cell states (Uint8Array copy). */
  fireCellSnapshot: null,

  /** Snapshot of completed fire age array (Uint8Array copy). */
  fireAgeSnapshot: null,

  /** Patch grid at time of fire (Uint8Array copy). */
  patchGridSnapshot: null,

  /** Elevation grid at time of fire (Float32Array copy). */
  elevationSnapshot: null,

  /** Geographic bounds of the simulation grid, if a parcel was drawn.
   *  { west, south, east, north } or null for synthetic grids. */
  geoBounds: null,

  /** Fire spread timeline: array of { tick, burningCells: Uint8Array } snapshots. */
  fireTimeline: null,

  /** Real SSURGO soil data fetched for the parcel, or null if not yet fetched.
   *  Shape: { muname, compname, texdesc, kfact, organicMatter, hydgrp,
   *           infiltrationRate, awc, slope, sand, clay, silt, bulkDensity, components[] } */
  ssurgoData: null,
};

// ═══════════════════════════════════════════════════════════════════════════
// Pub/sub
// ═══════════════════════════════════════════════════════════════════════════

/** Subscribe to state changes. fn receives no arguments — read sharedState directly. */
export function addListener(fn) {
  _listeners.add(fn);
}

/** Unsubscribe. */
export function removeListener(fn) {
  _listeners.delete(fn);
}

/** Notify all listeners that state has changed. */
export function emit() {
  for (const fn of _listeners) {
    try { fn(); } catch (e) { console.error('sharedState listener error:', e); }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Derivation: burnSeverityGrid → soilPropertyGrid
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Recompute soilPropertyGrid from the current burnSeverityGrid.
 * Called automatically by setBurnSeverityGrid.
 */
function deriveSoilProperties() {
  const bsg = sharedState.burnSeverityGrid;
  if (!bsg) {
    sharedState.soilPropertyGrid = null;
    return;
  }
  const n = bsg.length;
  const props = new Array(n);
  for (let i = 0; i < n; i++) {
    props[i] = lookupSoilProperties(bsg[i]);
  }
  sharedState.soilPropertyGrid = props;
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API: write burnSeverityGrid + trigger derivation + emit
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Set the burn severity grid, derive soil properties, and emit.
 * @param {Float32Array} grid — one severity value per cell (0–1)
 * @param {number} cols
 * @param {number} rows
 */
export function setBurnSeverityGrid(grid, cols, rows) {
  sharedState.burnSeverityGrid = grid;
  sharedState.cols = cols;
  sharedState.rows = rows;
  deriveSoilProperties();
  emit();
}

// ═══════════════════════════════════════════════════════════════════════════
// Fire completion: compute burn severity from fireState
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Compute a burnSeverityGrid from a completed fire simulation state.
 *
 * Mapping:
 *   UNBURNED → 0.0
 *   BURNED with age 1      → 0.33  (low — brief flame front)
 *   BURNED with age 2–3    → 0.66  (moderate)
 *   BURNED with age ≥ 4    → 1.0   (high — sustained crown fire)
 *   BURNING cells           → 0.66  (moderate — still active)
 *
 * Intermediate ages interpolate linearly between these anchors.
 *
 * @param {{ cell: Uint8Array, age: Uint8Array }} fireState
 * @param {number} cols
 * @param {number} rows
 */
export function computeBurnSeverityFromFire(fireState, cols, rows) {
  const n = cols * rows;
  const grid = new Float32Array(n);

  // Age anchors for severity mapping:
  //   age 0 (unburned)       → 0.0
  //   age 1 (brief)          → 0.33
  //   age 2 (short)          → 0.50
  //   age 3 (moderate)       → 0.66
  //   age 4 (sustained)      → 0.83
  //   age ≥ 5 (intense)      → 1.0
  const MAX_AGE = 5;

  for (let i = 0; i < n; i++) {
    const state = fireState.cell[i];
    if (state === FIRE.UNBURNED) {
      grid[i] = 0;
    } else if (state === FIRE.BURNING) {
      // Still burning — treat as moderate
      grid[i] = 0.66;
    } else {
      // BURNED — map age to severity
      const age = fireState.age[i];
      if (age <= 0) {
        grid[i] = 0.33; // burned but age 0 = minimum severity
      } else {
        // Linear interpolation: age 1→0.33, age MAX_AGE→1.0
        const t = Math.min(1, (age - 1) / (MAX_AGE - 1));
        grid[i] = 0.33 + t * 0.67;
      }
    }
  }

  return grid;
}

/**
 * Complete fire-to-shared-state export.
 * Call this when fire simulation ends (all cells stopped burning or user stops it).
 *
 * @param {{ cell: Uint8Array, age: Uint8Array }} fireState
 * @param {number} cols
 * @param {number} rows
 * @param {object} [context] — optional extra context
 * @param {Uint8Array}    [context.patchGrid]   — patch type grid
 * @param {Float32Array}  [context.elevations]  — elevation grid
 * @param {{ west, south, east, north }} [context.geoBounds] — geographic extent
 * @param {Array}         [context.timeline]    — fire spread timeline snapshots
 */
export function exportFireToSharedState(fireState, cols, rows, context) {
  const grid = computeBurnSeverityFromFire(fireState, cols, rows);
  sharedState.scenarioPhase = 'fire-complete';

  // Store fire snapshots for downstream tabs (soil study)
  sharedState.fireCellSnapshot = new Uint8Array(fireState.cell);
  sharedState.fireAgeSnapshot = new Uint8Array(fireState.age);

  if (context) {
    if (context.patchGrid) sharedState.patchGridSnapshot = new Uint8Array(context.patchGrid);
    if (context.elevations) sharedState.elevationSnapshot = new Float32Array(context.elevations);
    sharedState.geoBounds = context.geoBounds || null;
    sharedState.fireTimeline = context.timeline || null;
  }

  setBurnSeverityGrid(grid, cols, rows);
}
