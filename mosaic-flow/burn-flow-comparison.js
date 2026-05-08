/**
 * burn-flow-comparison.js — Pre/post-fire flow comparison runner.
 *
 * Closes the loop: takes a burn severity grid (from a completed fire run) and
 * re-simulates overland flow under perturbed parameters (infiltration loss,
 * mild roughness change). Reports Δφ_water — the shift in the water-side
 * percolation order parameter — and Δstorage between the two runs.
 *
 * The vanilla and perturbed runs share patch types, elevations, rainfall, and
 * step count; only the per-cell perturbation differs. This isolates the
 * fire-driven hydrologic shift.
 */

import { stepFlow } from './flow.js';
import { computePhiFlow } from './connectivity.js';
import { buildBurnPerturbation } from './burn-perturbation.js';
import { buildCurve, provenance } from './stream-table-calibration.js';

const DEFAULT_RAINFALL_MMHR = 30;   // moderate storm
const DEFAULT_DT_SECONDS    = 1;
const DEFAULT_STEPS         = 240;  // 4 minutes at 1 s/step

/**
 * Run two identical-rainfall flow simulations and compare them.
 *
 * @param {Object} args
 * @param {Uint8Array}    args.patchGrid
 * @param {Float32Array}  args.elevations
 * @param {Float32Array}  args.severityGrid   per-cell burn severity (0-1)
 * @param {Object}        args.patchParams    PATCH_PARAMS from patches.js
 * @param {string[]}      args.patchKeys
 * @param {number}        args.cols
 * @param {number}        args.rows
 * @param {number}        [args.rainfall]     mm/hr (default 30)
 * @param {number}        [args.dt]           seconds per step (default 1)
 * @param {number}        [args.steps]        step count (default 240)
 * @returns {{
 *   vanillaDepths: Float32Array,
 *   perturbedDepths: Float32Array,
 *   phiVanilla: number,
 *   phiPerturbed: number,
 *   deltaPhi: number,
 *   meanDepthVanilla: number,
 *   meanDepthPerturbed: number,
 *   newWetCells: number,
 * }}
 */
export function runBurnFlowComparison(args) {
  const {
    patchGrid, elevations, severityGrid,
    patchParams, patchKeys, cols, rows,
    rainfall = DEFAULT_RAINFALL_MMHR,
    dt = DEFAULT_DT_SECONDS,
    steps = DEFAULT_STEPS,
  } = args;

  const n = cols * rows;
  const opts = { patchParams, patchKeys };
  const baseState = () => ({
    depths: new Float32Array(n),
    patchGrid, elevations, cols, rows,
  });

  // ── Vanilla (pre-fire) run ─────────────────────────────────────────────
  let stateA = baseState();
  for (let s = 0; s < steps; s++) {
    const r = stepFlow(stateA, rainfall, dt, opts, null, null);
    stateA = { ...stateA, depths: r.depths };
  }
  const vanillaDepths = stateA.depths;

  // ── Perturbed (post-fire) run ──────────────────────────────────────────
  const curve = buildCurve();
  const perturbation = buildBurnPerturbation(severityGrid, curve);
  let stateB = baseState();
  for (let s = 0; s < steps; s++) {
    const r = stepFlow(stateB, rainfall, dt, opts, null, perturbation);
    stateB = { ...stateB, depths: r.depths };
  }
  const perturbedDepths = stateB.depths;

  // ── Metrics ────────────────────────────────────────────────────────────
  const { phi: phiVanilla } = computePhiFlow(vanillaDepths, cols, rows);
  const { phi: phiPerturbed } = computePhiFlow(perturbedDepths, cols, rows);

  let sumA = 0, sumB = 0, newWet = 0;
  const eps = 1e-4;
  for (let i = 0; i < n; i++) {
    sumA += vanillaDepths[i];
    sumB += perturbedDepths[i];
    if (vanillaDepths[i] <= eps && perturbedDepths[i] > eps) newWet++;
  }

  return {
    vanillaDepths,
    perturbedDepths,
    phiVanilla,
    phiPerturbed,
    deltaPhi: phiPerturbed - phiVanilla,
    meanDepthVanilla: sumA / n,
    meanDepthPerturbed: sumB / n,
    newWetCells: newWet,
    curveProvenance: provenance(),
  };
}
