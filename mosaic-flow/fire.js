/**
 * fire.js — Phase-transition wildfire model (FireSweep style).
 *
 * Cell states: UNBURNED → BURNING → BURNED
 *
 * Spread mechanic (percolation):
 *   Each fire tick, every BURNING cell attempts to ignite each of its 8
 *   unburned neighbors exactly once. Spread probability P = fuelLoad_neighbor
 *   multiplied by optional wind and slope factors. This makes fuelLoad
 *   directly equivalent to the density parameter p in site-percolation theory.
 *
 *   Site-percolation threshold on a 2D square lattice:
 *     4-neighbor: p_c ≈ 0.593
 *     8-neighbor: p_c ≈ 0.407
 *
 *   Below p_c: fire burns out locally (subcritical).
 *   Above p_c: fire percolates across the landscape (supercritical).
 *   Near p_c:  fractal fire-front boundary, characteristic of phase transitions.
 *
 * Patch fuelLoad values are tuned so the interesting threshold falls between
 * urban (~0.32, subcritical) and corridor (~0.62, supercritical). Grassland
 * (0.70) and forest (1.0) are firmly supercritical; bare soil and wetland
 * are subcritical.
 *
 * Wind adds directional bias without shifting the percolation threshold.
 * Ember spotting creates long-range jumps (realistic firebrand behavior).
 */

export const FIRE = { UNBURNED: 0, BURNING: 1, BURNED: 2 };

// 8-directional neighbor offsets [drow, dcol]
const DIRS   = [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
const IS_DIAG = [true,  false, true,  false, false,true,  false,true ];

export function createFireState(cols, rows) {
  return {
    cell:   new Uint8Array(cols * rows),  // FIRE enum per cell
    age:    new Uint8Array(cols * rows),  // fire-ticks spent burning
    embers: [],                            // { x, y, tx, ty, age, life }
  };
}

export function resetFireState(fs) {
  fs.cell.fill(0);
  fs.age.fill(0);
  fs.embers = [];
}

/** Set a single cell alight. Safe to call from mouse handlers. */
export function igniteAt(fs, row, col, cols, rows) {
  if (row < 0 || row >= rows || col < 0 || col >= cols) return;
  const idx = row * cols + col;
  if (fs.cell[idx] === FIRE.UNBURNED) {
    fs.cell[idx] = FIRE.BURNING;
    fs.age[idx]  = 0;
  }
}

/** Returns true if any cell is still burning. */
export function hasActiveFire(fs) {
  for (let i = 0; i < fs.cell.length; i++) {
    if (fs.cell[i] === FIRE.BURNING) return true;
  }
  return false;
}

/**
 * Advance fire by one tick.
 *
 * Called from sketch.js on a slower clock (every FIRE_TICK_MS ms, independent
 * of the water-flow speed multiplier) so fire spread is visually legible.
 *
 * windAngleDeg : compass direction the wind blows FROM (0=N, 90=E, 180=S, 270=W)
 * windSpeed    : 0 – 5 (0 = calm, no directional bias)
 */
export function stepFire(fs, patchGrid, patchKeys, patchParams,
                         elevations, windAngleDeg, windSpeed, depths,
                         cols, rows) {
  // Wind vector: direction fire is pushed TOWARD (opposite of "from" convention)
  const rad = (windAngleDeg * Math.PI) / 180;
  const wx =  Math.sin(rad);   // east  component of push direction
  const wy = -Math.cos(rad);   // south component (grid rows increase downward)

  // Spread into a copy so all cells in this tick see the same initial state
  const nextCell = new Uint8Array(fs.cell);
  const nextAge  = new Uint8Array(fs.age);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      if (fs.cell[idx] !== FIRE.BURNING) continue;

      nextAge[idx]++;

      // How many ticks this patch type smolders before going dark
      const params   = patchParams[patchKeys[patchGrid[idx]]] || {};
      const burnLife = params.burnDuration ?? 3;

      if (nextAge[idx] >= burnLife) {
        nextCell[idx] = FIRE.BURNED;
        // (don't continue — still try to spread on the final tick)
      }

      // ── Attempt spread to all 8 neighbors ──────────────────────────────────
      for (let d = 0; d < 8; d++) {
        const ni = r + DIRS[d][0];
        const nj = c + DIRS[d][1];
        if (ni < 0 || ni >= rows || nj < 0 || nj >= cols) continue;
        const nidx = ni * cols + nj;
        if (nextCell[nidx] !== FIRE.UNBURNED) continue;

        const nParams = patchParams[patchKeys[patchGrid[nidx]]] || {};
        const fuel    = nParams.fuelLoad ?? 0;
        if (fuel <= 0) continue;
        if (depths[nidx] > 0.012) continue; // standing water suppresses ignition

        // ── Wind factor ───────────────────────────────────────────────────────
        // Dot product of spread direction with wind push vector.
        // Downwind neighbors get a boost; upwind get a penalty.
        const scale  = IS_DIAG[d] ? 1.414 : 1.0;
        const sdx    = DIRS[d][1] / scale;  // east  component of spread dir
        const sdy    = DIRS[d][0] / scale;  // south component
        const dot    = sdx * wx + sdy * wy; // −1 … +1
        const windF  = Math.max(0.06, 1 + dot * windSpeed * 0.45);

        // ── Slope factor ──────────────────────────────────────────────────────
        // Fire climbs hills faster; slight penalty going downhill.
        const dElev  = elevations[nidx] - elevations[idx];
        const slopeF = Math.max(0.2, 1 + dElev * 14);

        // ── Core percolation step ─────────────────────────────────────────────
        // P = fuelLoad × windFactor × slopeFactor
        // fuelLoad IS the density parameter p — this is the FireSweep model.
        const P = Math.min(1.0, fuel * windF * slopeF);
        if (Math.random() < P) {
          nextCell[nidx] = FIRE.BURNING;
          nextAge[nidx]  = 0;
        }
      }

      // ── Ember spotting ────────────────────────────────────────────────────
      // Firebrands carried by wind that can ignite distant unburned cells.
      if (windSpeed > 1.0 && Math.random() < 0.006) {
        const dist    = (3 + Math.random() * 8) * windSpeed * 0.38;
        const scatter = (Math.random() - 0.5) * 3.2;
        // Target drifts in wind direction with lateral scatter
        fs.embers.push({
          x: c + 0.5, y: r + 0.5,
          tx: c + 0.5 + wx * dist - wy * scatter,
          ty: r + 0.5 + wy * dist + wx * scatter,
          age: 0, life: 7 + Math.floor(Math.random() * 5),
        });
      }
    }
  }

  // ── Advance ember particles ───────────────────────────────────────────────
  const alive = [];
  for (const e of fs.embers) {
    e.age++;
    // Lerp toward target (exponential approach)
    e.x += (e.tx - e.x) * 0.18;
    e.y += (e.ty - e.y) * 0.18;

    if (e.age >= e.life) {
      // Landing — attempt ignition
      const li = Math.floor(e.y), lj = Math.floor(e.x);
      if (li >= 0 && li < rows && lj >= 0 && lj < cols) {
        const lidx = li * cols + lj;
        const lp   = patchParams[patchKeys[patchGrid[lidx]]] || {};
        const fuel = lp.fuelLoad ?? 0;
        if (nextCell[lidx] === FIRE.UNBURNED && fuel > 0 && depths[lidx] < 0.01) {
          if (Math.random() < 0.4 * fuel) {
            nextCell[lidx] = FIRE.BURNING;
            nextAge[lidx]  = 0;
          }
        }
      }
      // ember is consumed — don't push to alive
    } else {
      alive.push(e);
    }
  }
  fs.embers = alive;

  fs.cell = nextCell;
  fs.age  = nextAge;
  return fs;
}
