/**
 * Manning-based overland flow solver for 2D grid.
 * Uses kinematic wave approximation with proportional multi-direction routing (D8).
 */

/**
 * Compute flow velocity from Manning's equation.
 * v = (1/n) * R^(2/3) * S^(1/2)
 * For shallow overland flow, R ≈ h (hydraulic radius ≈ depth)
 * @param {number} h - water depth (m)
 * @param {number} S - slope (m/m)
 * @param {number} n - Manning's roughness
 * @returns {number} velocity (m/s)
 */
export function manningVelocity(h, S, n) {
  if (h <= 0 || S <= 0) return 0;
  const R = h;
  return (1 / n) * Math.pow(R, 2 / 3) * Math.pow(S, 1 / 2);
}

/**
 * Get elevation at cell (i, j). Supports simple slope or flat.
 */
export function getElevation(i, j, cols, rows, slopeAngle = 270, slopeMagnitude = 0.01) {
  const rad = (slopeAngle * Math.PI) / 180;
  const di = Math.cos(rad);
  const dj = Math.sin(rad);
  return (rows - i) * di * slopeMagnitude + j * dj * slopeMagnitude;
}

/**
 * Compute proportional flow weights to all downhill neighbors (D8 proportional routing).
 * Distributes flow to all downhill cells weighted by slope gradient, not just the steepest.
 * This allows corridors and wetlands to actually intercept and redirect flow.
 * @returns {Array<{di, dj, ni, nj, gradient, weight}>}
 */
export function flowWeights(i, j, elevations, cols, rows) {
  const e = elevations[i * cols + j];
  const neighbors = [];
  let totalGradient = 0;

  for (let di = -1; di <= 1; di++) {
    for (let dj = -1; dj <= 1; dj++) {
      if (di === 0 && dj === 0) continue;
      const ni = i + di;
      const nj = j + dj;
      if (ni < 0 || ni >= rows || nj < 0 || nj >= cols) continue;
      const ne = elevations[ni * cols + nj];
      const drop = e - ne;
      if (drop > 0) {
        const dist = Math.sqrt(di * di + dj * dj);
        const gradient = drop / dist;
        neighbors.push({ di, dj, ni, nj, gradient, weight: 0 });
        totalGradient += gradient;
      }
    }
  }

  if (totalGradient > 0) {
    for (const n of neighbors) n.weight = n.gradient / totalGradient;
  }
  return neighbors;
}

/**
 * Compute flow for one timestep using proportional multi-direction routing.
 * @param {Object} state - { depths, patchGrid, elevations, cols, rows }
 * @param {number} rainfall - mm/hr
 * @param {number} dt - timestep (s)
 * @param {Object} opts - { patchParams, patchKeys } from patches.js
 * @param {Float32Array} [patchState] - sediment accumulation per cell; reduces infiltration when nonzero
 * @param {{infiltrationFactor: Float32Array, roughnessFactor: Float32Array}} [perturbation]
 *   Optional per-cell scaling of infiltration and Manning's n (e.g. from burn severity).
 *   Both arrays length cols*rows; values 1.0 = no change.
 * @returns {{ depths, fluxes, totalET, totalOutflow }}
 */
export function stepFlow(state, rainfall, dt, opts, patchState, perturbation) {
  const { depths, patchGrid, elevations, cols, rows } = state;
  const { patchParams, patchKeys } = typeof opts.patchKeys !== 'undefined'
    ? opts
    : { patchParams: opts, patchKeys: Object.keys(opts) };
  const cellSize = 1;
  const rainfallMs = (rainfall / 1000 / 3600) * dt;

  const newDepths = new Float32Array(depths.length);
  const fluxes = new Float32Array(depths.length * 2);
  let totalET = 0;
  let totalOutflow = 0;

  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const idx = i * cols + j;
      const h = depths[idx];
      const patchIdx = patchGrid[idx];
      const key = patchKeys[patchIdx] || patchKeys[0];
      const params = patchParams[key] || patchParams[patchKeys[0]];

      const weights = flowWeights(i, j, elevations, cols, rows);

      // Effective slope: weighted average of downhill gradients
      let effectiveSlope = 0;
      for (const w of weights) effectiveSlope += w.weight * w.gradient;

      // Sediment load progressively reduces infiltration capacity
      const siltLoad = patchState ? patchState[idx] : 0;
      const infilPerturb = perturbation ? perturbation.infiltrationFactor[idx] : 1;
      const effectiveInfil = (params.infiltration / (1 + siltLoad * 0.1)) * infilPerturb;

      // T1-A: Evapotranspiration — subtract from standing water each step
      const etRateMs = (params.etRate ?? 0) / 1000 / 3600;
      const evapotranspired = Math.min(h, etRateMs * dt);
      totalET += evapotranspired;

      // T1-B: Connectivity threshold — water must pond above threshold before it mobilizes
      const threshold = params.connectivityThreshold ?? 0;
      const thresholdM = threshold / 1000; // threshold in mm → m
      const mobilizableH = Math.max(0, h - evapotranspired - thresholdM);

      // T1-C: Patch edge resistance — blend Manning's n with neighbors at patch boundaries
      let effectiveN = params.manningN;
      if (weights.length > 0) {
        let nSum = 0;
        let nCount = 0;
        for (const w of weights) {
          const nPatchIdx = patchGrid[w.ni * cols + w.nj];
          const nKey = patchKeys[nPatchIdx] || patchKeys[0];
          const nParams = patchParams[nKey] || patchParams[patchKeys[0]];
          if (nPatchIdx !== patchIdx) {
            // At a patch boundary: blend current and neighbor roughness
            // Geometric mean gives physically appropriate resistance at edges
            nSum += Math.sqrt(params.manningN * nParams.manningN) * w.weight;
            nCount += w.weight;
          }
        }
        if (nCount > 0) {
          // Weighted blend: (1 - edgeFraction)*own_n + edgeFraction*edge_blend
          effectiveN = params.manningN * (1 - nCount) + nSum;
        }
      }

      // Burn-severity perturbation on Manning's n (applied after edge-blend)
      if (perturbation) effectiveN *= perturbation.roughnessFactor[idx];

      const v = manningVelocity(mobilizableH, Math.max(0.001, effectiveSlope), effectiveN);
      const infiltrationRate = effectiveInfil / 1000 / 3600;
      const infiltrated = Math.min(mobilizableH, infiltrationRate * dt);

      const outflow = v * mobilizableH * dt / cellSize;
      const actualOutflow = Math.min(Math.max(0, mobilizableH - infiltrated), outflow);

      // Water that stays: original depth minus ET minus infiltration minus outflow, plus rain
      newDepths[idx] += h - evapotranspired - infiltrated - actualOutflow + rainfallMs;

      if (actualOutflow > 0) {
        if (weights.length === 0) {
          // Interior depressions pond; boundary cells drain off the domain.
          const atBoundary = i === 0 || i === rows - 1 || j === 0 || j === cols - 1;
          if (!atBoundary) newDepths[idx] += actualOutflow;
          else totalOutflow += actualOutflow;
        } else {
          for (const w of weights) {
            const nidx = w.ni * cols + w.nj;
            newDepths[nidx] += actualOutflow * w.weight;
            fluxes[idx * 2] += w.dj * v * w.weight;      // col (j) → vx (horizontal)
            fluxes[idx * 2 + 1] += w.di * v * w.weight;  // row (i) → vy (vertical)
          }
        }
      }
    }
  }

  return { depths: newDepths, fluxes, totalET, totalOutflow };
}
