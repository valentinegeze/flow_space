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
 */
export function stepFlow(state, rainfall, dt, opts, patchState) {
  const { depths, patchGrid, elevations, cols, rows } = state;
  const { patchParams, patchKeys } = typeof opts.patchKeys !== 'undefined'
    ? opts
    : { patchParams: opts, patchKeys: Object.keys(opts) };
  const cellSize = 1;
  const rainfallMs = (rainfall / 1000 / 3600) * dt;

  const newDepths = new Float32Array(depths.length);
  const fluxes = new Float32Array(depths.length * 2);

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

      // Sediment load progressively reduces infiltration capacity (Fix 5)
      const siltLoad = patchState ? patchState[idx] : 0;
      const effectiveInfil = params.infiltration / (1 + siltLoad * 0.1);

      const v = manningVelocity(h, Math.max(0.001, effectiveSlope), params.manningN);
      const infiltrationRate = effectiveInfil / 1000 / 3600;
      const infiltrated = Math.min(h, infiltrationRate * dt);

      const outflow = v * h * dt / cellSize;
      const actualOutflow = Math.min(Math.max(0, h - infiltrated), outflow);

      newDepths[idx] += h + rainfallMs - infiltrated - actualOutflow;

      if (actualOutflow > 0) {
        if (weights.length === 0) {
          // Flat cell or sink — water stays
          newDepths[idx] += actualOutflow;
        } else {
          for (const w of weights) {
            const nidx = w.ni * cols + w.nj;
            newDepths[nidx] += actualOutflow * w.weight;
            fluxes[idx * 2] += w.di * v * w.weight;
            fluxes[idx * 2 + 1] += w.dj * v * w.weight;
          }
        }
      }
    }
  }

  return { depths: newDepths, fluxes };
}
