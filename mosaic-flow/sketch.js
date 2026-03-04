/**
 * Main sketch: land mosaic grid, physics loop, visualization.
 */

import { stepFlow, getElevation, flowWeights } from './flow.js';
import { PATCH_TYPES, PATCH_PARAMS, DEFAULT_MATRIX } from './patches.js';
import { createUI } from './ui.js';
import { computeConnectivity } from './connectivity.js';
import { spawnParticles, advectParticles } from './particles.js';

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
let flowHistory = [];
let drainageContrib = null;
let baselineSnapshot = null;
let contributingArea = null;   // Uint8Array mask for right-click upstream highlight
let interventionMarkers = [];  // { framesAgo, patchKey } logged when user paints while running
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

    const { controls, updateMetrics } = createUI((msg, data) => {
      if (msg === 'reset') {
        depths.fill(0);
        sedimentDepth.fill(0);
        particles.length = 0;
        sedimentCount = 0;
        flowHistory = [];
        drainageContrib = null;
        baselineSnapshot = null;
        interventionMarkers = [];
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
          elevationMode: ctrl?.elevationMode ?? 'slope',
          slopeAngle: ctrl?.slopeAngle ?? 270,
          slopeMagnitude: ctrl?.slopeMagnitude ?? 0.01,
          elevations: ctrl?.elevationMode === 'dem' && ctrl?.demElevations
            ? Array.from(ctrl.demElevations)
            : undefined,
          exportedAt: new Date().toISOString(),
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `mosaic-scenario-${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
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
          ctrl.elevationMode = data.elevationMode ?? 'slope';
          ctrl.slopeAngle = data.slopeAngle ?? 270;
          ctrl.slopeMagnitude = data.slopeMagnitude ?? 0.01;
          if (data.elevationMode === 'dem' && Array.isArray(data.elevations) && data.elevations.length === COLS * ROWS) {
            ctrl.demElevations = new Float32Array(data.elevations);
            const nameEl = document.getElementById('dem-file-name');
            if (nameEl) nameEl.textContent = '(from import)';
          } else {
            ctrl.demElevations = null;
          }
          const slopeRadio = document.querySelector('input[name="topo-mode"][value="slope"]');
          const demRadio = document.querySelector('input[name="topo-mode"][value="dem"]');
          const topoSlopeDivEl = document.getElementById('topo-slope-div');
          const topoDemDivEl = document.getElementById('topo-dem-div');
          if (slopeRadio && demRadio) {
            slopeRadio.checked = ctrl.elevationMode === 'slope';
            demRadio.checked = ctrl.elevationMode === 'dem';
          }
          if (topoSlopeDivEl) topoSlopeDivEl.style.display = ctrl.elevationMode === 'slope' ? 'block' : 'none';
          if (topoDemDivEl) topoDemDivEl.style.display = ctrl.elevationMode === 'dem' ? 'block' : 'none';
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

    const runLoop = () => {
      if (controls.running) {
        const mult = Math.max(1, controls.speedMultiplier ?? 1);
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

          const connResult = computeConnectivity(depths, fluxes, COLS, ROWS);
          connectivity = connResult.connectivity;
          drainageContrib = connResult.drainageContrib;

          spawnParticles(depths, fluxes, patchGrid, COLS, ROWS, particles, 1, controls.sedimentMultiplier ?? 1);
          advectParticles(particles, depths, fluxes, COLS, ROWS, 1, sedimentDepth);
        }

        // Total outflow across entire grid boundary for sparkline
        let totalOutflow = 0;
        for (let i = 0; i < ROWS; i++) {
          for (let j = 0; j < COLS; j++) {
            const idx = i * COLS + j;
            const vx = fluxes[idx * 2];
            const vy = fluxes[idx * 2 + 1];
            const v = Math.sqrt(vx * vx + vy * vy);
            totalOutflow += v * depths[idx];
          }
        }
        flowHistory.push(totalOutflow * 0.001);
        if (flowHistory.length > 200) flowHistory.shift();

        // Age out intervention markers
        for (const m of interventionMarkers) m.framesAgo++;
        interventionMarkers = interventionMarkers.filter(m => m.framesAgo <= 200);

        sedimentCount = particles.length;

        // Snapshot toggle
        if (controls.requestSnapshot) {
          if (baselineSnapshot) {
            baselineSnapshot = null;
          } else {
            let peakVal = 0;
            for (const v of flowHistory) { if (v > peakVal) peakVal = v; }
            baselineSnapshot = { flowHistory: [...flowHistory], peakFlow: peakVal, connectivity };
          }
          controls.requestSnapshot = false;
        }

        updateMetrics({ flowHistory, sedimentCount, connectivity, baselineSnapshot, interventionMarkers });
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
          const alpha = Math.min(255, 160 + h * 3000);
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
              ? Math.min(240, 120 + sd * 20)
              : Math.min(220, 80 + sd * 12);
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

    // ── Layer 6: Particles ───────────────────────────────────────────────────
    if (viewMode !== 'flow') {
      for (const pt of particles) {
        if (pt.settled) continue;
        p.fill(pt.color[0], pt.color[1], pt.color[2], 255);
        p.noStroke();
        p.ellipse(pt.x * cellPx + cellPx / 2, pt.y * cellPx + cellPx / 2, 2, 2);
      }
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
    p.text('Left: paint · Right: upstream area', 8, canvasH - 8);
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

      // Draw each segment with width ∝ log(discharge)
      for (let k = 1; k < pts.length; k++) {
        const prev = pts[k - 1];
        const curr = pts[k];
        const d = prev.discharge;
        // Log scale so thin=diffuse sheet, thick=concentrated channel
        const w = Math.min(7, 0.5 + Math.log1p(d * 25000) * 1.8);
        const alpha = isFlow ? Math.min(220, 80 + w * 20) : Math.min(90, 30 + w * 10);

        p.stroke(100, 180, 255, alpha);
        p.strokeWeight(w);
        p.line(prev.x * cellPx, prev.y * cellPx, curr.x * cellPx, curr.y * cellPx);
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
    paintAt(p.mouseX, p.mouseY);
  };

  p.mouseDragged = () => {
    if (p.mouseX < 0 || p.mouseX >= canvasW || p.mouseY < 0 || p.mouseY >= canvasH) return;
    if (p.mouseButton === p.RIGHT) return; // don't paint on right-drag
    paintAt(p.mouseX, p.mouseY);
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

new p5(sketch);
