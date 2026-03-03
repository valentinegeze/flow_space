/**
 * Manning-based overland flow solver for 2D grid.
 * Uses kinematic wave approximation: flow direction = steepest descent,
 * velocity from Manning's equation.
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
  const R = h; // approximate for wide shallow flow
  return (1 / n) * Math.pow(R, 2 / 3) * Math.pow(S, 1 / 2);
}

/**
 * Get elevation at cell (i, j). Supports simple slope or flat.
 * @param {number} i - row
 * @param {number} j - col
 * @param {number} cols - grid width
 * @param {number} rows - grid height
 * @param {number} slopeAngle - slope direction in degrees (0 = down, 90 = right)
 * @param {number} slopeMagnitude - elevation drop per cell
 */
export function getElevation(i, j, cols, rows, slopeAngle = 270, slopeMagnitude = 0.01) {
  const rad = (slopeAngle * Math.PI) / 180;
  const di = Math.cos(rad);
  const dj = Math.sin(rad);
  return (rows - i) * di * slopeMagnitude + j * dj * slopeMagnitude;
}

/**
 * Find steepest descent direction from cell (i, j).
 * Returns [di, dj] in {-1, 0, 1} for 8-neighbors.
 */
export function steepestDescent(i, j, elevations, cols, rows) {
  const e = elevations[i * cols + j];
  let maxDrop = 0;
  let bestDi = 0;
  let bestDj = 0;

  for (let di = -1; di <= 1; di++) {
    for (let dj = -1; dj <= 1; dj++) {
      if (di === 0 && dj === 0) continue;
      const ni = i + di;
      const nj = j + dj;
      if (ni < 0 || ni >= rows || nj < 0 || nj >= cols) continue;
      const ne = elevations[ni * cols + nj];
      const drop = e - ne;
      if (drop > maxDrop) {
        maxDrop = drop;
        bestDi = di;
        bestDj = dj;
      }
    }
  }

  return [bestDi, bestDj];
}

/**
 * Compute flow for one timestep.
 * @param {Object} state - { depths, patchGrid, elevations, cols, rows }
 * @param {number} rainfall - mm/hr
 * @param {number} dt - timestep (s)
 * @param {Object} opts - { patchParams, patchKeys } from patches.js
 */
export function stepFlow(state, rainfall, dt, opts) {
  const { depths, patchGrid, elevations, cols, rows } = state;
  const { patchParams, patchKeys } = typeof opts.patchKeys !== 'undefined'
    ? opts
    : { patchParams: opts, patchKeys: Object.keys(opts) };
  const cellSize = 1; // m (conceptual)
  const rainfallMs = (rainfall / 1000 / 3600) * dt; // m

  const newDepths = new Float32Array(depths.length);
  const fluxes = new Float32Array(depths.length * 2); // vx, vy

  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const idx = i * cols + j;
      const h = depths[idx];
      const patchIdx = patchGrid[idx];
      const key = patchKeys[patchIdx] || patchKeys[0];
      const params = patchParams[key] || patchParams[patchKeys[0]];

      const [di, dj] = steepestDescent(i, j, elevations, cols, rows);
      const ni = i + di;
      const nj = j + dj;

      let slope = 0;
      if (ni >= 0 && ni < rows && nj >= 0 && nj < cols) {
        const e = elevations[idx];
        const ne = elevations[ni * cols + nj];
        const dist = Math.sqrt(di * di + dj * dj);
        slope = Math.max(0, (e - ne) / (dist * cellSize));
      }

      const v = manningVelocity(h, Math.max(0.001, slope), params.manningN);
      const infiltrationRate = params.infiltration / 1000 / 3600; // m/s
      const infiltrated = Math.min(h, infiltrationRate * dt);

      const outflow = v * h * dt / cellSize;
      const actualOutflow = Math.min(Math.max(0, h - infiltrated), outflow);

      newDepths[idx] += h + rainfallMs - infiltrated - actualOutflow;

      if (actualOutflow > 0 && ni >= 0 && ni < rows && nj >= 0 && nj < cols) {
        const nidx = ni * cols + nj;
        newDepths[nidx] += actualOutflow;
        fluxes[idx * 2] = di * v;
        fluxes[idx * 2 + 1] = dj * v;
      }
    }
  }

  return { depths: newDepths, fluxes };
}
