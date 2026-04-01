/**
 * Main sketch: land mosaic grid, physics loop, visualization.
 */

import { stepFlow, getElevation, flowWeights } from './flow.js';
import { PATCH_TYPES, PATCH_PARAMS, DEFAULT_MATRIX } from './patches.js';
import { createUI } from './ui.js';
import { computeConnectivity } from './connectivity.js';
import { spawnParticles, advectParticles } from './particles.js';
import { createLBMState, stepLBM } from './lbm.js';
import { createFireState, resetFireState, igniteAt, stepFire, FIRE } from './fire.js';

const COLS = 64;
const ROWS = 64;

let patchGrid;
let depths;
let elevations;
let fluxes;
let sedimentDepth;
let particles = [];
let sedimentCount = 0;
let connectivity = 0;
let drainageContrib = null;
let contributingArea = null;   // Uint8Array mask for right-click upstream highlight
let interventionMarkers = [];  // { framesAgo, patchKey } logged when user paints while running
let lbmState = null;
let fireState = null;
let waterSources = []; // Array<{i, j}> — persistent point sources
let floodRect = null;  // {r0,c0,r1,c1} during shift-drag preview; null otherwise
let fireTickAccum = 0; // accumulator for fire's independent tick rate
// chartHistory: ring buffer of { runoffRatio, meanStorage, etFraction, concentration }
let chartHistory = [];
let cellPx = 8;
let canvasW = 0;
let canvasH = 0;

const patchKeys = Object.keys(PATCH_PARAMS);

/** Parse a 6-digit hex color string to [r, g, b]. */
function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

/** Lerp a color toward its luminance (desaturate). factor=1 full color, 0=grayscale. */
function desaturate(r, g, b, factor) {
  const lum = Math.round(r * 0.299 + g * 0.587 + b * 0.114);
  return [
    Math.round(lum + (r - lum) * factor),
    Math.round(lum + (g - lum) * factor),
    Math.round(lum + (b - lum) * factor),
  ];
}

/**
 * BFS upstream from (targetI, targetJ) through the elevation field.
 * Returns Uint8Array mask where 1 = cell drains to target.
 */
function computeContributingArea(targetI, targetJ) {
  const mask = new Uint8Array(COLS * ROWS);
  const queue = [[targetI, targetJ]];
  mask[targetI * COLS + targetJ] = 1;

  while (queue.length > 0) {
    const [ci, cj] = queue.shift();
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        if (di === 0 && dj === 0) continue;
        const ni = ci + di;
        const nj = cj + dj;
        if (ni < 0 || ni >= ROWS || nj < 0 || nj >= COLS) continue;
        if (mask[ni * COLS + nj]) continue;
        // Does (ni, nj) route any flow into (ci, cj)?
        const weights = flowWeights(ni, nj, elevations, COLS, ROWS);
        if (weights.some(w => w.ni === ci && w.nj === cj)) {
          mask[ni * COLS + nj] = 1;
          queue.push([ni, nj]);
        }
      }
    }
  }
  return mask;
}

function initGrid() {
  patchGrid = new Uint8Array(COLS * ROWS);
  depths = new Float32Array(COLS * ROWS);
  fluxes = new Float32Array(COLS * ROWS * 2);
  sedimentDepth = new Float32Array(COLS * ROWS);

  const typeIndex = Object.keys(PATCH_PARAMS).indexOf(DEFAULT_MATRIX);
  for (let i = 0; i < ROWS; i++) {
    for (let j = 0; j < COLS; j++) {
      patchGrid[i * COLS + j] = typeIndex;
    }
  }

  updateElevations();
}

function resizeCanvas(p) {
  const w = (p && typeof p.windowWidth === 'number' && p.windowWidth > 0) ? p.windowWidth : window.innerWidth;
  const h = (p && typeof p.windowHeight === 'number' && p.windowHeight > 0) ? p.windowHeight : window.innerHeight;
  cellPx = Math.max(4, Math.floor(Math.min(w, h) / COLS));
  canvasW = COLS * cellPx;
  canvasH = ROWS * cellPx;
}

function updateElevations() {
  const ctrl = window.mosaicControls;
  if (ctrl?.elevationMode === 'dem' && ctrl?.demElevations?.length === COLS * ROWS) {
    elevations = new Float32Array(ctrl.demElevations);
  } else {
    elevations = new Float32Array(COLS * ROWS);
    for (let i = 0; i < ROWS; i++) {
      for (let j = 0; j < COLS; j++) {
        elevations[i * COLS + j] = getElevation(
          i, j, COLS, ROWS,
          ctrl?.slopeAngle ?? 270,
          ctrl?.slopeMagnitude ?? 0.01
        );
      }
    }
  }
  contributingArea = null; // terrain changed, clear stale upstream mask
}

const sketch = (p) => {
  p.setup = () => {
    resizeCanvas(p);
    const canvas = p.createCanvas(canvasW, canvasH);
    canvas.parent('mosaic-container');
    // Prevent browser context menu so right-click can be used for contributing area
    canvas.elt.addEventListener('contextmenu', e => e.preventDefault());

    p.windowResized = () => {
      resizeCanvas(p);
      p.resizeCanvas(canvasW, canvasH);
    };

    initGrid();
    fireState = createFireState(COLS, ROWS);

    const { controls, updateMetrics } = createUI((msg, data) => {
      if (msg === 'reset') {
        depths.fill(0);
        sedimentDepth.fill(0);
        particles.length = 0;
        sedimentCount = 0;
        chartHistory = [];
        drainageContrib = null;
        interventionMarkers = [];
        lbmState = null;
        if (fireState) resetFireState(fireState);
        waterSources = [];
      } else if (msg === 'resetAll') {
        window.location.reload();
      } else if (msg === 'restore') {
        const wetlandIdx = patchKeys.indexOf('wetland');
        const forestIdx = patchKeys.indexOf('forest');
        for (let i = 0; i < ROWS * COLS; i++) {
          if (Math.random() < 0.15) patchGrid[i] = wetlandIdx;
          else if (Math.random() < 0.15) patchGrid[i] = forestIdx;
        }
      } else if (msg === 'randomize') {
        const numTypes = patchKeys.length;
        const matrixIdx = patchKeys.indexOf('grass');
        for (let i = 0; i < ROWS * COLS; i++) {
          patchGrid[i] = matrixIdx;
        }
        const numBlobs = 15 + Math.floor(Math.random() * 35);
        for (let b = 0; b < numBlobs; b++) {
          const cx = Math.floor(Math.random() * COLS);
          const cy = Math.floor(Math.random() * ROWS);
          const typeIdx = Math.floor(Math.random() * numTypes);
          const radius = 2 + Math.floor(Math.random() * 10);
          const rr = radius * radius;
          for (let i = Math.max(0, cy - radius); i <= Math.min(ROWS - 1, cy + radius); i++) {
            for (let j = Math.max(0, cx - radius); j <= Math.min(COLS - 1, cx + radius); j++) {
              const di = i - cy, dj = j - cx;
              if (di * di + dj * dj <= rr) {
                patchGrid[i * COLS + j] = typeIdx;
              }
            }
          }
        }
      } else if (msg === 'export') {
        const ctrl = window.mosaicControls;
        const payload = {
          version: 1,
          cols: COLS,
          rows: ROWS,
          patchGrid: Array.from(patchGrid),
          elevations: ctrl?.demElevations ? Array.from(ctrl.demElevations) : undefined,
          exportedAt: new Date().toISOString(),
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `mosaic-scenario-${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
      } else if (msg === 'clear-fire') {
        if (fireState) resetFireState(fireState);
        fireTickAccum = 0;
      } else if (msg === 'clear-sources') {
        waterSources = [];
      } else if (msg === 'import' && data) {
        const grid = data.patchGrid;
        if (Array.isArray(grid) && grid.length === COLS * ROWS) {
          for (let i = 0; i < grid.length; i++) {
            const v = Math.floor(grid[i]);
            patchGrid[i] = Math.max(0, Math.min(v, patchKeys.length - 1));
          }
        }
        const ctrl = window.mosaicControls;
        if (ctrl) {
          ctrl.elevationMode = 'dem';
          if (Array.isArray(data.elevations) && data.elevations.length === COLS * ROWS) {
            ctrl.demElevations = new Float32Array(data.elevations);
          } else {
            ctrl.demElevations = null;
          }
        }
        if (Array.isArray(grid) && grid.length !== COLS * ROWS) {
          console.warn('Import: invalid grid dimensions');
        }
        updateElevations();
      } else {
        updateElevations();
      }
    });

    window.mosaicControls = controls;
    updateElevations(); // apply initial DEM from controls

    const runLoop = () => {
      if (controls.running) {
        const mult = Math.max(1, controls.speedMultiplier ?? 1);
        let stepET = 0;
        let stepTotalOutflow = 0;
        for (let s = 0; s < mult; s++) {
          const result = stepFlow(
            { depths, patchGrid, elevations, cols: COLS, rows: ROWS },
            controls.rainfall,
            1,
            { patchParams: PATCH_PARAMS, patchKeys },
            sedimentDepth
          );
          depths = result.depths;
          fluxes = result.fluxes;
          stepET += result.totalET ?? 0;
          stepTotalOutflow += result.totalOutflow ?? 0;

          const connResult = computeConnectivity(depths, fluxes, COLS, ROWS);
          connectivity = connResult.connectivity;
          drainageContrib = connResult.drainageContrib;

          spawnParticles(depths, fluxes, patchGrid, COLS, ROWS, particles, 1, controls.sedimentMultiplier ?? 1);
          advectParticles(particles, depths, fluxes, COLS, ROWS, 1, sedimentDepth);
        }

        // LBM density field step (runs after Manning to consume final fluxes/depths)
        if (controls.useLBM) {
          if (!lbmState) lbmState = createLBMState(COLS, ROWS);
          stepLBM(lbmState, fluxes, depths, sedimentDepth, COLS, ROWS);
        }

        // ── Compute 4 chart metrics ─────────────────────────────────────────
        const rainfallVol = (controls.rainfall / 1000 / 3600) * mult * COLS * ROWS;

        // 1. Runoff ratio: boundary outflow / rainfall input
        const runoffRatio = rainfallVol > 0.0001 ? Math.min(1, stepTotalOutflow / rainfallVol) : 0;

        // 2. Mean water storage (mean depth across all cells, m)
        let depthSum = 0;
        for (let k = 0; k < depths.length; k++) depthSum += depths[k];
        const meanStorage = depthSum / (COLS * ROWS);

        // 3. ET fraction: ET lost / rainfall input
        const etFraction = rainfallVol > 0.0001 ? Math.min(1, stepET / rainfallVol) : 0;

        // 4. Flow concentration: fraction of cells carrying 80% of flux
        let concentration = 0;
        if (drainageContrib) {
          const dc = Array.from(drainageContrib).sort((a, b) => b - a);
          let cum = 0, count = 0;
          for (let k = 0; k < dc.length; k++) {
            cum += dc[k]; count++;
            if (cum >= 0.8) break;
          }
          concentration = 1 - count / (COLS * ROWS);
        }

        chartHistory.push({ runoffRatio, meanStorage, etFraction, concentration });
        if (chartHistory.length > 300) chartHistory.shift();

        // Fire simulation — ticks on its own slower clock so the CA
        // front is visually legible regardless of the water-flow speed.
        // One fire tick every ~150 ms (every 1.5 run-loop calls on average).
        if (controls.simMode === 'fire' && fireState) {
          fireTickAccum += 1;
          if (fireTickAccum >= 1.5) {
            fireTickAccum -= 1.5;
            stepFire(
              fireState, patchGrid, patchKeys, PATCH_PARAMS,
              elevations,
              controls.windAngle ?? 225,
              controls.windSpeed ?? 2.5,
              depths, COLS, ROWS
            );
          }
        }

        // Persistent water sources — inject water each step
        for (const src of waterSources) {
          const rate = controls.waterSourceRate ?? 0.04;
          depths[src.i * COLS + src.j] += rate;
        }

        // Age out intervention markers
        for (const m of interventionMarkers) m.framesAgo++;
        interventionMarkers = interventionMarkers.filter(m => m.framesAgo <= 300);

        sedimentCount = particles.length;

        updateMetrics({ chartHistory, interventionMarkers, connectivity, sedimentCount });
      }
    };

    setInterval(runLoop, 100);
  };

  p.draw = () => {
    p.background(18, 18, 24);
    const viewMode = window.mosaicControls?.viewMode ?? 'design';

    // ── Layer 1: Patches + water overlay ────────────────────────────────────
    for (let i = 0; i < ROWS; i++) {
      for (let j = 0; j < COLS; j++) {
        const idx = i * COLS + j;
        const patchIdx = patchGrid[idx];
        const params = PATCH_PARAMS[patchKeys[patchIdx]] || PATCH_PARAMS.grass;
        const [pr, pg, pb] = hexToRgb(params.color);

        if (viewMode === 'design') {
          p.fill(pr, pg, pb);
        } else if (viewMode === 'flow') {
          // Heavily desaturate so streamlines dominate
          const [dr, dg, db] = desaturate(pr, pg, pb, 0.25);
          p.fill(dr, dg, db, 180);
        } else {
          // sediment mode: patches fade back
          const [dr, dg, db] = desaturate(pr, pg, pb, 0.5);
          p.fill(dr, dg, db, 120);
        }
        p.noStroke();
        p.rect(j * cellPx, i * cellPx, cellPx + 1, cellPx + 1);

        // Water: visible in design mode (tinted), faint in flow mode, hidden in sediment mode
        const h = depths[idx];
        if (h > 0.0005 && viewMode !== 'sediment') {
          const alpha = Math.min(255, 120 + Math.log1p(h * 3000) * 42);
          if (viewMode === 'design') {
            const wr = Math.round(80 * 0.7 + pr * 0.3);
            const wg = Math.round(130 * 0.7 + pg * 0.3);
            const wb = Math.round(200 * 0.7 + pb * 0.3);
            p.fill(wr, wg, wb, alpha);
          } else {
            p.fill(80, 130, 200, Math.round(alpha * 0.35));
          }
          p.rect(j * cellPx, i * cellPx, cellPx + 1, cellPx + 1);
        }
      }
    }

    // ── Layer 2: Sediment deposits ───────────────────────────────────────────
    if (viewMode !== 'flow') {
      p.noStroke();
      for (let i = 0; i < ROWS; i++) {
        for (let j = 0; j < COLS; j++) {
          const sd = sedimentDepth[i * COLS + j];
          if (sd > 0) {
            const alpha = viewMode === 'sediment'
              ? Math.min(240, Math.log1p(sd) * 55)
              : Math.min(220, Math.log1p(sd) * 47);
            p.fill(139, 90, 43, alpha);
            p.rect(j * cellPx, i * cellPx, cellPx + 1, cellPx + 1);
          }
        }
      }
    }

    // ── Layer 3: Drainage heatmap ────────────────────────────────────────────
    if (window.mosaicControls?.showDrainageHeatmap && drainageContrib) {
      let maxDC = 0;
      for (let k = 0; k < drainageContrib.length; k++) {
        if (drainageContrib[k] > maxDC) maxDC = drainageContrib[k];
      }
      if (maxDC > 0) {
        p.noStroke();
        for (let i = 0; i < ROWS; i++) {
          for (let j = 0; j < COLS; j++) {
            const idx = i * COLS + j;
            const t = drainageContrib[idx] / maxDC;
            if (t > 0.02) {
              const alpha = Math.min(190, t * 220);
              p.fill(255, Math.round(200 * (1 - t)), 0, alpha);
              p.rect(j * cellPx, i * cellPx, cellPx + 1, cellPx + 1);
            }
          }
        }
      }
    }

    // ── Layer 4: Streamlines (replaces per-cell arrows) ──────────────────────
    if (viewMode !== 'sediment') {
      drawStreamlines(p, viewMode);
    }

    // ── Layer 5: Contributing area highlight ─────────────────────────────────
    if (contributingArea) {
      p.noStroke();
      for (let i = 0; i < ROWS; i++) {
        for (let j = 0; j < COLS; j++) {
          if (contributingArea[i * COLS + j]) {
            p.fill(255, 230, 50, 65);
            p.rect(j * cellPx, i * cellPx, cellPx + 1, cellPx + 1);
          }
        }
      }
      // Highlight the clicked cell itself
      // (the target is the brightest cell — it will be included in the mask)
    }

    // ── Layer 6: Particles or LBM density field ──────────────────────────────
    if (window.mosaicControls?.useLBM && lbmState) {
      // LBM mode: render smooth density fields for water and sediment
      let maxW = 0, maxS = 0;
      for (let k = 0; k < lbmState.rhoWater.length; k++) {
        if (lbmState.rhoWater[k] > maxW) maxW = lbmState.rhoWater[k];
        if (lbmState.rhoSediment[k] > maxS) maxS = lbmState.rhoSediment[k];
      }
      p.noStroke();
      for (let i = 0; i < ROWS; i++) {
        for (let j = 0; j < COLS; j++) {
          const idx = i * COLS + j;
          if (maxW > 0) {
            const tw = lbmState.rhoWater[idx] / maxW;
            if (tw > 0.02) {
              p.fill(60, 140, 230, Math.min(200, Math.round(tw * 210)));
              p.rect(j * cellPx, i * cellPx, cellPx + 1, cellPx + 1);
            }
          }
          if (maxS > 0) {
            const ts = lbmState.rhoSediment[idx] / maxS;
            if (ts > 0.02) {
              p.fill(160, 90, 30, Math.min(200, Math.round(ts * 210)));
              p.rect(j * cellPx, i * cellPx, cellPx + 1, cellPx + 1);
            }
          }
        }
      }
    } else if (viewMode !== 'flow') {
      // Particle mode (default)
      for (const pt of particles) {
        if (pt.settled) continue;
        p.fill(pt.color[0], pt.color[1], pt.color[2], 255);
        p.noStroke();
        p.ellipse(pt.x * cellPx + cellPx / 2, pt.y * cellPx + cellPx / 2, 2, 2);
      }
    }

    // ── Layer 8: Fire visualization ──────────────────────────────────────────
    if (window.mosaicControls?.simMode === 'fire' && fireState) {
      p.noStroke();
      const fc = p.frameCount;
      for (let i = 0; i < ROWS; i++) {
        for (let j = 0; j < COLS; j++) {
          const idx = i * COLS + j;
          const state = fireState.cell[idx];
          if (state === FIRE.BURNED) {
            p.fill(38, 26, 20, 210);
            p.rect(j * cellPx, i * cellPx, cellPx + 1, cellPx + 1);
          } else if (state === FIRE.BURNING) {
            const intens = fireState.intensity[idx];
            const flicker = 0.6 + 0.4 * Math.sin(fc * 0.22 + idx * 0.051);
            const brightness = intens * flicker;
            // Outer orange layer
            p.fill(245, Math.floor(60 + brightness * 80), 5, Math.floor(150 + brightness * 85));
            p.rect(j * cellPx, i * cellPx, cellPx + 1, cellPx + 1);
            // Inner bright core
            const cx = (j + 0.5) * cellPx;
            const cy = (i + 0.5) * cellPx;
            const r = cellPx * 0.45 * brightness;
            p.fill(255, Math.floor(200 + brightness * 55), 40, Math.floor(brightness * 190));
            p.ellipse(cx, cy, r * 2, r * 2);
          }
        }
      }

      // Embers
      p.noStroke();
      for (const e of fireState.embers) {
        const alpha = Math.floor((1 - e.progress) * 230);
        p.fill(255, 140 + Math.floor(Math.random() * 50), 0, alpha);
        p.ellipse(e.x * cellPx, e.y * cellPx, 3.5, 3.5);
      }
    }

    // ── Layer 9: Water source markers ────────────────────────────────────────
    if (waterSources.length > 0) {
      const pulse = 0.5 + 0.5 * Math.sin(p.frameCount * 0.14);
      for (const src of waterSources) {
        const cx = (src.j + 0.5) * cellPx;
        const cy = (src.i + 0.5) * cellPx;
        p.fill(100, 180, 255, Math.floor(160 + pulse * 80));
        p.noStroke();
        p.ellipse(cx, cy, cellPx * 0.7, cellPx * 0.7);
        p.noFill();
        p.stroke(100, 180, 255, Math.floor(80 + pulse * 120));
        p.strokeWeight(1.5);
        p.ellipse(cx, cy, cellPx * (1.4 + pulse * 0.6), cellPx * (1.4 + pulse * 0.6));
      }
      p.noStroke();
    }

    // ── Layer 10: Flood-area preview (shift+drag) ─────────────────────────────
    if (floodRect) {
      const { r0, c0, r1, c1 } = floodRect;
      const x0 = Math.min(c0, c1) * cellPx;
      const y0 = Math.min(r0, r1) * cellPx;
      const w  = (Math.abs(c1 - c0) + 1) * cellPx;
      const h  = (Math.abs(r1 - r0) + 1) * cellPx;
      p.fill(80, 160, 255, 55);
      p.stroke(100, 200, 255, 200);
      p.strokeWeight(1.5);
      p.rect(x0, y0, w, h);
      p.noStroke();
    }

    // ── Layer 7: Elevation contours ──────────────────────────────────────────
    if (window.mosaicControls?.showElevationLines && elevations) {
      drawElevationContours(p);
    }

    // ── Brush cursor ─────────────────────────────────────────────────────────
    const brushRadius = (window.mosaicControls?.brushSize ?? 3) * cellPx;
    if (p.mouseX >= 0 && p.mouseX < canvasW && p.mouseY >= 0 && p.mouseY < canvasH) {
      p.noFill();
      p.stroke(255, 255, 255, 120);
      p.strokeWeight(1);
      p.ellipse(p.mouseX, p.mouseY, brushRadius * 2, brushRadius * 2);
    }

    // ── Help text ─────────────────────────────────────────────────────────────
    p.fill(140, 140, 140);
    p.textSize(Math.max(9, cellPx * 0.55));
    p.textAlign(p.LEFT, p.BOTTOM);
    p.noStroke();
    const toolHints = {
      paint: 'Left: paint \u00B7 Right: upstream \u00B7 Shift+drag: flood area',
      ignite: 'Click to ignite · Right: upstream',
      'water-source': 'Click to toggle water source · Right: upstream',
    };
    const hint = toolHints[window.mosaicControls?.activeTool ?? 'paint'] ?? '';
    p.text(hint, 8, canvasH - 8);
  };

  // ── Streamlines: seed-and-trace through flux field ────────────────────────
  function drawStreamlines(p, viewMode) {
    if (!fluxes) return;

    // Seeds: grid every 12 cells — gives ~25 starting points
    const seeds = [];
    for (let i = 6; i < ROWS; i += 12) {
      for (let j = 6; j < COLS; j += 12) {
        seeds.push([i + 0.5, j + 0.5]);
      }
    }

    const isFlow = viewMode === 'flow';
    // Animated dash parameters: phase shifts each frame so dashes appear to move downstream
    const dashLen = 8;
    const gapLen = 6;
    const period = dashLen + gapLen;
    const frameOffset = Math.floor(p.frameCount * 0.3) % period;

    p.noFill();

    for (const [sy, sx] of seeds) {
      let x = sx;
      let y = sy;
      const maxSteps = 350;
      const stepSize = 0.4;

      // Collect segments with per-point discharge for width encoding
      const pts = [{ x, y, discharge: 0 }];

      for (let step = 0; step < maxSteps; step++) {
        const j = Math.floor(x);
        const i = Math.floor(y);
        if (i < 0 || i >= ROWS || j < 0 || j >= COLS) break;

        const idx = i * COLS + j;
        const vx = fluxes[idx * 2];
        const vy = fluxes[idx * 2 + 1];
        const v = Math.sqrt(vx * vx + vy * vy);
        if (v < 0.0006) break;

        const h = depths ? depths[idx] : 0;
        pts[pts.length - 1].discharge = v * h;

        x += (vx / v) * stepSize;
        y += (vy / v) * stepSize;
        pts.push({ x, y, discharge: 0 });
      }

      if (pts.length < 2) continue;

      // Draw each segment as an animated dash — phase advances each frame so
      // dashes appear to travel downstream, making direction immediately readable
      for (let k = 1; k < pts.length; k++) {
        const prev = pts[k - 1];
        const curr = pts[k];
        const d = prev.discharge;
        // Log scale so thin=diffuse sheet, thick=concentrated channel
        const w = Math.min(7, 0.5 + Math.log1p(d * 25000) * 1.8);
        const alpha = isFlow ? Math.min(220, 80 + w * 20) : Math.min(90, 30 + w * 10);

        const phase = (k + frameOffset) % period;
        if (phase < dashLen) {
          p.stroke(100, 180, 255, alpha);
          p.strokeWeight(w);
          p.line(prev.x * cellPx, prev.y * cellPx, curr.x * cellPx, curr.y * cellPx);
        }
      }

      // Chevron arrowheads every 50 steps and at the streamline end
      const arrowInterval = 50;
      const arrowPositions = [];
      for (let k = arrowInterval; k < pts.length - 1; k += arrowInterval) arrowPositions.push(k);
      if (pts.length >= 3) arrowPositions.push(pts.length - 1);

      for (const k of arrowPositions) {
        if (k < 2) continue;
        const tip = pts[k];
        const ref = pts[k - 2]; // 2 steps back for a stable direction vector
        const d = pts[k - 1].discharge;
        const w = Math.min(5, 0.8 + Math.log1p(d * 25000) * 1.2);
        const alpha = isFlow ? 200 : 90;

        const dx = tip.x - ref.x;
        const dy = tip.y - ref.y;
        const len = Math.sqrt(dx * dx + dy * dy) || 1;
        const nx = dx / len;
        const ny = dy / len;
        const px2 = -ny; // perpendicular
        const py2 = nx;

        const aLen = Math.max(5, w * 3);   // arrowhead length in px
        const aWid = Math.max(3, w * 1.5); // arrowhead half-width in px

        const tipX = tip.x * cellPx;
        const tipY = tip.y * cellPx;
        const bx = tipX - nx * aLen;
        const by = tipY - ny * aLen;

        p.stroke(160, 210, 255, alpha);
        p.strokeWeight(Math.max(0.8, w * 0.55));
        p.line(bx + px2 * aWid, by + py2 * aWid, tipX, tipY);
        p.line(bx - px2 * aWid, by - py2 * aWid, tipX, tipY);
      }
    }
  }

  function drawElevationContours(p) {
    if (!elevations) return;
    let minE = Infinity, maxE = -Infinity;
    for (let k = 0; k < elevations.length; k++) {
      const v = elevations[k];
      if (v < minE) minE = v;
      if (v > maxE) maxE = v;
    }
    const range = maxE - minE || 1;
    const numContours = 10;
    p.stroke(255, 255, 200, 100);
    p.strokeWeight(1);
    p.noFill();
    for (let c = 1; c < numContours; c++) {
      const level = minE + (range * c) / numContours;
      for (let i = 0; i < ROWS - 1; i++) {
        for (let j = 0; j < COLS - 1; j++) {
          const e00 = elevations[i * COLS + j];
          const e10 = elevations[(i + 1) * COLS + j];
          const e01 = elevations[i * COLS + (j + 1)];
          const e11 = elevations[(i + 1) * COLS + (j + 1)];
          const pts = [];
          if (e00 !== e10 && (e00 - level) * (e10 - level) <= 0) {
            const t = (level - e00) / (e10 - e00);
            pts.push([j * cellPx + cellPx / 2, (i + t) * cellPx]);
          }
          if (e00 !== e01 && (e00 - level) * (e01 - level) <= 0) {
            const t = (level - e00) / (e01 - e00);
            pts.push([(j + t) * cellPx, i * cellPx + cellPx / 2]);
          }
          if (e01 !== e11 && (e01 - level) * (e11 - level) <= 0) {
            const t = (level - e01) / (e11 - e01);
            pts.push([(j + 1) * cellPx, (i + t) * cellPx]);
          }
          if (e10 !== e11 && (e10 - level) * (e11 - level) <= 0) {
            const t = (level - e10) / (e11 - e10);
            pts.push([(j + t) * cellPx, (i + 1) * cellPx]);
          }
          if (pts.length >= 2) {
            p.line(pts[0][0], pts[0][1], pts[1][0], pts[1][1]);
          }
        }
      }
    }
  }

  p.mousePressed = () => {
    if (p.mouseX < 0 || p.mouseX >= canvasW || p.mouseY < 0 || p.mouseY >= canvasH) return;
    if (p.mouseButton === p.RIGHT) {
      // Right-click: toggle contributing area for clicked cell
      const j = Math.floor(p.mouseX / cellPx);
      const i = Math.floor(p.mouseY / cellPx);
      if (contributingArea) {
        contributingArea = null;
      } else {
        contributingArea = computeContributingArea(i, j);
      }
      return false;
    }
    const activeTool = window.mosaicControls?.activeTool ?? 'paint';
    const j = Math.floor(p.mouseX / cellPx);
    const i = Math.floor(p.mouseY / cellPx);
    if (activeTool === 'ignite') {
      if (fireState) igniteAt(fireState, i, j, COLS, ROWS);
    } else if (activeTool === 'water-source') {
      const existing = waterSources.findIndex(s => s.i === i && s.j === j);
      if (existing >= 0) {
        waterSources.splice(existing, 1);
      } else {
        waterSources.push({ i, j });
      }
    } else if (activeTool === 'paint' && p.keyIsDown(p.SHIFT)) {
      floodRect = { r0: i, c0: j, r1: i, c1: j };
    } else {
      paintAt(p.mouseX, p.mouseY);
    }
  };

  p.mouseDragged = () => {
    if (p.mouseX < 0 || p.mouseX >= canvasW || p.mouseY < 0 || p.mouseY >= canvasH) return;
    if (p.mouseButton === p.RIGHT) return; // don't paint on right-drag
    const activeTool = window.mosaicControls?.activeTool ?? 'paint';
    const j = Math.floor(p.mouseX / cellPx);
    const i = Math.floor(p.mouseY / cellPx);
    if (activeTool === 'ignite') {
      if (fireState) igniteAt(fireState, i, j, COLS, ROWS);
    } else if (floodRect) {
      floodRect.r1 = i;
      floodRect.c1 = j;
    } else {
      paintAt(p.mouseX, p.mouseY);
    }
  };

  p.mouseReleased = () => {
    if (floodRect) {
      const rMin = Math.min(floodRect.r0, floodRect.r1);
      const rMax = Math.max(floodRect.r0, floodRect.r1);
      const cMin = Math.min(floodRect.c0, floodRect.c1);
      const cMax = Math.max(floodRect.c0, floodRect.c1);
      for (let ri = rMin; ri <= rMax; ri++) {
        for (let ci = cMin; ci <= cMax; ci++) {
          if (ri >= 0 && ri < ROWS && ci >= 0 && ci < COLS) {
            depths[ri * COLS + ci] += 0.5;
          }
        }
      }
      floodRect = null;
    }
  };
};

function paintAt(x, y) {
  const j = Math.floor(x / cellPx);
  const i = Math.floor(y / cellPx);
  const radius = window.mosaicControls?.brushSize ?? 3;
  const ctrl = window.mosaicControls;

  if (i >= 0 && i < ROWS && j >= 0 && j < COLS) {
    const key = ctrl?.activePatch ?? PATCH_TYPES.GRASS;
    const idx = Object.keys(PATCH_PARAMS).indexOf(key);
    if (idx >= 0) {
      for (let di = -radius; di <= radius; di++) {
        for (let dj = -radius; dj <= radius; dj++) {
          const ni = i + di;
          const nj = j + dj;
          if (ni >= 0 && ni < ROWS && nj >= 0 && nj < COLS) {
            if (Math.sqrt(di * di + dj * dj) <= radius) {
              patchGrid[ni * COLS + nj] = idx;
            }
          }
        }
      }

      // Record intervention marker when simulation is running.
      // Debounce: only one marker per 3-frame window per patch type.
      if (ctrl?.running) {
        const recentSame = interventionMarkers.some(m => m.framesAgo < 3 && m.patchKey === key);
        if (!recentSame) {
          interventionMarkers.push({ framesAgo: 0, patchKey: key });
        }
      }
    }
  }
}

// ── Parcel Analysis integration ───────────────────────────────────────────────

/**
 * Load a real-world patch grid from the Site Analysis module.
 * Replaces patchGrid in-place and resets water/sediment state.
 * Called by parcel-analysis.js via window.loadParcelGrid.
 */
window.loadParcelGrid = function (grid) {
  if (!(grid instanceof Uint8Array) || grid.length !== COLS * ROWS) return;
  patchGrid.set(grid);
  depths.fill(0);
  sedimentDepth.fill(0);
  particles.length = 0;
  chartHistory = [];
  drainageContrib = null;
  contributingArea = null;
  interventionMarkers = [];
  lbmState = null;
  sedimentCount = 0;
  updateElevations();
};

/**
 * Render the current simulation state onto an external canvas.
 * Used by parcel-analysis.js to create a live Leaflet image overlay.
 * The canvas is small (64×64) and stretched by Leaflet to fit the parcel bbox.
 */
window.renderSimToCanvas = function (canvas) {
  if (!patchGrid || !depths) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  const cw = W / COLS;
  const ch = H / ROWS;
  ctx.clearRect(0, 0, W, H);

  for (let i = 0; i < ROWS; i++) {
    for (let j = 0; j < COLS; j++) {
      const idx = i * COLS + j;
      const params = PATCH_PARAMS[patchKeys[patchGrid[idx]]] || PATCH_PARAMS.grass;

      ctx.globalAlpha = 0.78;
      ctx.fillStyle = params.color;
      ctx.fillRect(j * cw, i * ch, cw + 0.5, ch + 0.5);

      const h = depths[idx];
      if (h > 0.0005) {
        ctx.globalAlpha = Math.min(0.88, 0.38 + Math.log1p(h * 3000) * 0.17);
        ctx.fillStyle = '#4e7ec4';
        ctx.fillRect(j * cw, i * ch, cw + 0.5, ch + 0.5);
      }

      const sd = sedimentDepth[idx];
      if (sd > 0.2) {
        ctx.globalAlpha = Math.min(0.7, Math.log1p(sd) * 0.22);
        ctx.fillStyle = '#8b5a2b';
        ctx.fillRect(j * cw, i * ch, cw + 0.5, ch + 0.5);
      }
    }
  }
  ctx.globalAlpha = 1;
};

new p5(sketch);
