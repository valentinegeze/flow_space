/**
 * burn-perturbation.js — Bridge from burn severity to flow parameters.
 *
 * Produces per-cell scaling factors that modify infiltration and (lightly) Manning's n
 * inside stepFlow. The curves below are first-order and literature-grounded; they are
 * the place where stream-table-derived calibration would eventually replace constants.
 *
 * Source rationale (Path A, literature only — to be calibrated against stream-table data):
 *   - Post-fire hydrophobic layers and aggregate collapse routinely cut infiltration
 *     30–70% relative to unburned soils (Robichaud, 2000; DeBano, 2000; Larsen 2009).
 *     We model: factor = 1 − 0.70 · severity
 *   - Manning's n shifts are subtle and direction-ambiguous: ash sheet flow smooths,
 *     sediment armoring roughens. Net evidence supports a small smoothing under
 *     high severity (Moody & Martin, 2009).
 *     We model: factor = 1 − 0.15 · severity
 *
 * Stream-table calibration (future work) would replace these curves with empirical
 * fits from per-particle-size channel-coverage measurements at the table.
 */

/**
 * @param {number} severity — burn severity in [0, 1]
 * @returns {number} infiltration multiplier in [0.30, 1.00]
 */
export function severityToInfiltrationFactor(severity) {
  const s = Math.max(0, Math.min(1, severity));
  return 1 - 0.70 * s;
}

/**
 * @param {number} severity — burn severity in [0, 1]
 * @returns {number} Manning roughness multiplier in [0.85, 1.00]
 */
export function severityToRoughnessFactor(severity) {
  const s = Math.max(0, Math.min(1, severity));
  return 1 - 0.15 * s;
}

/**
 * Build per-cell perturbation factors from a burn severity grid.
 *
 * If a calibration curve is supplied, uses it instead of the literature
 * constants. Curve must be (severity)=>{infiltrationFactor, roughnessFactor}.
 * See stream-table-calibration.js for the calibration store + curve builder.
 *
 * @param {Float32Array} severityGrid — one severity value per cell, [0, 1]
 * @param {(s:number)=>{infiltrationFactor:number, roughnessFactor:number}} [curve]
 *   Optional perturbation curve. Defaults to the literature curve above.
 * @returns {{ infiltrationFactor: Float32Array, roughnessFactor: Float32Array }}
 */
export function buildBurnPerturbation(severityGrid, curve) {
  const n = severityGrid.length;
  const infiltrationFactor = new Float32Array(n);
  const roughnessFactor = new Float32Array(n);
  const f = curve || ((s) => ({
    infiltrationFactor: 1 - 0.70 * (s < 0 ? 0 : s > 1 ? 1 : s),
    roughnessFactor:    1 - 0.15 * (s < 0 ? 0 : s > 1 ? 1 : s),
  }));
  for (let i = 0; i < n; i++) {
    const out = f(severityGrid[i]);
    infiltrationFactor[i] = out.infiltrationFactor;
    roughnessFactor[i]    = out.roughnessFactor;
  }
  return { infiltrationFactor, roughnessFactor };
}
