/**
 * Connectivity metrics for land mosaic.
 * Functional connectivity: flow-weighted connectivity based on actual water/sediment movement.
 */

/**
 * Compute connectivity index and per-cell drainage contribution.
 *
 * Returns:
 *   connectivity    — ratio of cells with significant flow to total active cells (scalar 0–1)
 *   drainageContrib — Float32Array of normalized flux per cell; each value is that cell's
 *                     share of total landscape flux. High values mark the drainage network.
 *
 * This replaces the old scalar-only return so callers can render a spatial heatmap
 * showing which patches sit on the main flow paths, not just whether the landscape
 * is "connected" in aggregate.
 */
export function computeConnectivity(depths, fluxes, cols, rows) {
  let flowingCells = 0;
  let totalActive = 0;
  let totalFlux = 0;
  const drainageContrib = new Float32Array(cols * rows);

  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const idx = i * cols + j;
      const h = depths[idx];
      const vx = fluxes[idx * 2];
      const vy = fluxes[idx * 2 + 1];
      const v = Math.sqrt(vx * vx + vy * vy);
      const flux = v * Math.max(h, 0);

      drainageContrib[idx] = flux;
      totalFlux += flux;

      if (h > 0.0001 || v > 0.0001) {
        totalActive++;
        if (v > 0.001) flowingCells++;
      }
    }
  }

  if (totalFlux > 0) {
    for (let k = 0; k < drainageContrib.length; k++) {
      drainageContrib[k] /= totalFlux;
    }
  }

  return {
    connectivity: totalActive === 0 ? 0 : flowingCells / totalActive,
    drainageContrib,
  };
}
