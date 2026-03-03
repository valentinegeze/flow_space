/**
 * Connectivity metrics for land mosaic.
 * Functional connectivity: flow-weighted connectivity based on actual water/sediment movement.
 */

/**
 * Compute a simple connectivity index:
 * ratio of cells with significant flow to total cells that received rainfall.
 * Higher = more of the landscape is contributing to/conveying flow.
 */
export function computeConnectivity(depths, fluxes, patchGrid, cols, rows) {
  let flowingCells = 0;
  let totalActive = 0;

  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const idx = i * cols + j;
      const h = depths[idx];
      const vx = fluxes[idx * 2];
      const vy = fluxes[idx * 2 + 1];
      const v = Math.sqrt(vx * vx + vy * vy);

      if (h > 0.0001 || v > 0.0001) {
        totalActive++;
        if (v > 0.001) flowingCells++;
      }
    }
  }

  if (totalActive === 0) return 0;
  return flowingCells / totalActive;
}
