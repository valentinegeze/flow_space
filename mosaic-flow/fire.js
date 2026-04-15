/**
 * fire.js — FireSweep-style phase-transition wildfire (8-neighbor site percolation, p_c ≈ 0.41).
 *
 * UNBURNED → BURNING → BURNED. Each tick, burning cells try to ignite unburned neighbors.
 *
 * P(ignite) = min(1, fuelLoad_target × continuity × wind × slope × crownSpreadOut_source)
 * - fuelLoad: base p for that land use (tuned near p_c so sparse cells often go out).
 * - continuity: 1 + weights×(#forest, #grass, #corridor neighbors of the *target* cell).
 *   Isolated fuel = low continuity; embedded clusters push p above threshold (supercritical runs).
 * - crownSpreadOut: stronger spread from crown fires (e.g. forest) vs weak from urban/wetland.
 */

export const FIRE = { UNBURNED: 0, BURNING: 1, BURNED: 2 };

// 8-directional neighbor offsets [drow, dcol]
const DIRS   = [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
const IS_DIAG = [true,  false, true,  false, false,true,  false,true ];

/** How much nearby same-landscape fuel raises P — models canopy / prairie continuity. */
const W_FOREST = 0.11;
const W_GRASS = 0.068;
const W_CORRIDOR = 0.048;
const CONTINUITY_CAP = 2.08;

/**
 * Count forest / grass / corridor neighbors (8-neighbor) of (r,c) for connectivity.
 * Isolated cells get ~1.0; embedded clusters get >1, pushing p past p_c.
 */
function neighborContinuity(patchGrid, patchKeys, r, c, cols, rows) {
  const kForest = patchKeys.indexOf('forest');
  const kGrass = patchKeys.indexOf('grass');
  const kCorridor = patchKeys.indexOf('corridor');
  return neighborContinuityFast(patchGrid, kForest, kGrass, kCorridor, r, c, cols, rows);
}

/** Same as neighborContinuity but takes pre-resolved key indices for hot-path use. */
function neighborContinuityFast(patchGrid, kForest, kGrass, kCorridor, r, c, cols, rows) {
  let nf = 0, ng = 0, nc = 0;
  for (let d = 0; d < 8; d++) {
    const ni = r + DIRS[d][0];
    const nj = c + DIRS[d][1];
    if (ni < 0 || ni >= rows || nj < 0 || nj >= cols) continue;
    const pi = patchGrid[ni * cols + nj];
    if (pi === kForest) nf++;
    else if (pi === kGrass) ng++;
    else if (pi === kCorridor) nc++;
  }
  const raw = 1 + W_FOREST * nf + W_GRASS * ng + W_CORRIDOR * nc;
  return Math.min(CONTINUITY_CAP, raw);
}

/**
 * Build a cached params array: one entry per grid cell containing
 * { fuelLoad, burnDuration, crownSpreadOut }. Build once per grid change,
 * pass into stepFire to avoid repeated hash lookups in the hot loop.
 */
export function buildParamsCache(patchGrid, patchKeys, patchParams, cols, rows) {
  const n = cols * rows;
  const cache = new Array(n);
  for (let i = 0; i < n; i++) {
    cache[i] = patchParams[patchKeys[patchGrid[i]]] || {};
  }
  return cache;
}

export function createFireState(cols, rows) {
  return {
    cell:         new Uint8Array(cols * rows),  // FIRE enum per cell
    age:          new Uint8Array(cols * rows),  // fire-ticks spent burning
    _nextCell:    new Uint8Array(cols * rows),  // double-buffer for cell
    _nextAge:     new Uint8Array(cols * rows),  // double-buffer for age
    _attempted:   new Uint8Array(cols * rows),  // reusable per-tick scratch
    burningCells: new Set(),                     // active set of burning cell indices
    embers: [],                                  // { x, y, tx, ty, age, life }
  };
}

export function resetFireState(fs) {
  fs.cell.fill(0);
  fs.age.fill(0);
  fs._nextCell.fill(0);
  fs._nextAge.fill(0);
  fs._attempted.fill(0);
  fs.burningCells.clear();
  fs.embers = [];
}

/**
 * Set a single cell alight. If patchParams is passed, cells with no fuel (e.g. open water) are skipped.
 */
export function igniteAt(fs, row, col, cols, rows, patchGrid, patchKeys, patchParams) {
  if (row < 0 || row >= rows || col < 0 || col >= cols) return;
  const idx = row * cols + col;
  if (fs.cell[idx] !== FIRE.UNBURNED) return;
  if (patchParams && patchKeys && patchGrid) {
    const pp = patchParams[patchKeys[patchGrid[idx]]] || {};
    if ((pp.fuelLoad ?? 0) <= 0) return;
  }
  fs.cell[idx] = FIRE.BURNING;
  fs.age[idx]  = 0;
  fs.burningCells.add(idx);
}

/** Returns true if any cell is still burning. */
export function hasActiveFire(fs) {
  return fs.burningCells.size > 0;
}

/**
 * Advance fire by one tick.
 *
 * Called from sketch.js on a slower clock (every FIRE_TICK_MS ms, independent
 * of the water-flow speed multiplier) so fire spread is visually legible.
 *
 * windAngleDeg : compass direction the wind blows FROM (0=N, 90=E, 180=S, 270=W)
 * windSpeed    : 0 – 5 (0 = calm, no directional bias)
 * cachedParams : optional pre-built params cache from buildParamsCache()
 */
export function stepFire(fs, patchGrid, patchKeys, patchParams,
                         elevations, windAngleDeg, windSpeed, depths,
                         cols, rows, cachedParams) {
  // Wind vector: direction fire is pushed TOWARD (opposite of "from" convention)
  const rad = (windAngleDeg * Math.PI) / 180;
  const wx =  Math.sin(rad);   // east  component of push direction
  const wy = -Math.cos(rad);   // south component (grid rows increase downward)

  // Spread into a copy so all cells in this tick see the same initial state.
  // `attempted` ensures each unburned cell gets AT MOST ONE ignition roll per tick
  // regardless of how many burning neighbors surround it. This makes fuelLoad
  // directly equivalent to the site-percolation density p — the core FireSweep property.
  const nextCell  = fs._nextCell;
  const nextAge   = fs._nextAge;
  const attempted = fs._attempted;
  nextCell.set(fs.cell);
  nextAge.set(fs.age);
  attempted.fill(0);

  // Cache patch-key indices once to avoid O(n) indexOf inside tight loop
  const kForestIdx    = patchKeys.indexOf('forest');
  const kGrassIdx     = patchKeys.indexOf('grass');
  const kCorridorIdx  = patchKeys.indexOf('corridor');

  // Use params cache if provided, otherwise fall back to hash lookup
  const getParams = cachedParams
    ? (idx) => cachedParams[idx]
    : (idx) => patchParams[patchKeys[patchGrid[idx]]] || {};

  // Track cells to add/remove from burningCells after the tick
  const newlyBurning = [];
  const newlyBurned = [];

  // Only iterate burning cells (active set), not the entire grid
  for (const idx of fs.burningCells) {
    const r = (idx / cols) | 0;
    const c = idx % cols;

    nextAge[idx]++;

    // How many ticks this patch type smolders before going dark
    const params   = getParams(idx);
    const burnLife = params.burnDuration ?? 3;

    if (nextAge[idx] >= burnLife) {
      nextCell[idx] = FIRE.BURNED;
      newlyBurned.push(idx);
      // (don't continue — still try to spread on the final tick)
    }

    const crownOut = params.crownSpreadOut ?? 1.0;
    if (crownOut <= 0) continue;

    // ── Attempt spread to all 8 neighbors ──────────────────────────────────
    for (let d = 0; d < 8; d++) {
      const ni = r + DIRS[d][0];
      const nj = c + DIRS[d][1];
      if (ni < 0 || ni >= rows || nj < 0 || nj >= cols) continue;
      const nidx = ni * cols + nj;
      // Use original state (fs.cell) so we don't spread into cells already
      // ignited by an earlier iteration in this same tick.
      if (fs.cell[nidx] !== FIRE.UNBURNED) continue;
      // One roll per cell per tick — prevents multi-neighbor probability inflation.
      if (attempted[nidx]) continue;
      attempted[nidx] = 1;

      const nParams = getParams(nidx);
      const fuel    = nParams.fuelLoad ?? 0;
      if (fuel <= 0) continue;
      if (depths[nidx] > 0.012) continue; // standing water suppresses ignition

      const continuity = neighborContinuityFast(patchGrid, kForestIdx, kGrassIdx, kCorridorIdx, ni, nj, cols, rows);

      // ── Wind factor ───────────────────────────────────────────────────────
      const scale  = IS_DIAG[d] ? 1.414 : 1.0;
      const sdx    = DIRS[d][1] / scale;
      const sdy    = DIRS[d][0] / scale;
      const dot    = sdx * wx + sdy * wy;
      const windF  = Math.max(0.06, 1 + dot * windSpeed * 0.45);

      // ── Slope factor ──────────────────────────────────────────────────────
      const dElev  = elevations[nidx] - elevations[idx];
      const slopeF = Math.max(0.2, 1 + dElev * 14);

      // P = p_target × continuity × wind × slope × crown from source cell
      const P = Math.min(1.0, fuel * continuity * windF * slopeF * crownOut);
      if (Math.random() < P) {
        nextCell[nidx] = FIRE.BURNING;
        nextAge[nidx]  = 0;
        newlyBurning.push(nidx);
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

  // ── Advance ember particles ───────────────────────────────────────────────
  // Skip ember processing entirely when wind is too low to create embers
  if (windSpeed < 1.0) {
    // Update active set and swap buffers
    for (const idx of newlyBurned) fs.burningCells.delete(idx);
    for (const idx of newlyBurning) fs.burningCells.add(idx);
    fs._nextCell = fs.cell;
    fs._nextAge  = fs.age;
    fs.cell = nextCell;
    fs.age  = nextAge;
    return fs;
  }
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
        const lp   = getParams(lidx);
        const fuel = lp.fuelLoad ?? 0;
        if (nextCell[lidx] === FIRE.UNBURNED && fuel > 0 && depths[lidx] < 0.01) {
          const cont = neighborContinuity(patchGrid, patchKeys, li, lj, cols, rows);
          const pEmber = Math.min(1.0, 0.42 * fuel * cont);
          if (Math.random() < pEmber) {
            nextCell[lidx] = FIRE.BURNING;
            nextAge[lidx]  = 0;
            newlyBurning.push(lidx);
          }
        }
      }
      // ember is consumed — don't push to alive
    } else {
      alive.push(e);
    }
  }
  fs.embers = alive;

  // Update active burning set
  for (const idx of newlyBurned) fs.burningCells.delete(idx);
  for (const idx of newlyBurning) fs.burningCells.add(idx);

  // Swap buffers: nextCell becomes current, old current becomes next scratch space
  fs._nextCell = fs.cell;
  fs._nextAge  = fs.age;
  fs.cell = nextCell;
  fs.age  = nextAge;
  return fs;
}
