/**
 * D2Q9 Lattice Boltzmann passive scalar transport.
 *
 * Two coupled scalar fields:
 *   rhoWater    — tracks where water accumulates and flows
 *   rhoSediment — tracks where sediment concentrates
 *
 * The Manning solver provides the macroscopic velocity field each step.
 * LBM collision (BGK) + streaming diffuses these fields smoothly across
 * the grid, producing a continuous density-field view instead of particles.
 */

const Q = 9;

// D2Q9 discrete velocities: cx = column direction, cy = row direction (down = positive)
const CX  = [ 0,  1,  0, -1,  0,  1, -1, -1,  1];
const CY  = [ 0,  0,  1,  0, -1,  1,  1, -1, -1];
const W   = [4/9, 1/9, 1/9, 1/9, 1/9, 1/36, 1/36, 1/36, 1/36];
const OPP = [  0,   3,   4,   1,   2,    7,    8,    5,    6];

/** BGK equilibrium distribution for scalar density rho at velocity (ux, uy). */
function feq(rho, ux, uy, q) {
  const cu = CX[q] * ux + CY[q] * uy;
  return W[q] * rho * (1 + 3 * cu + 4.5 * cu * cu - 1.5 * (ux * ux + uy * uy));
}

/**
 * Allocate LBM state with pre-allocated scratch buffers to avoid per-step GC.
 */
export function createLBMState(cols, rows) {
  const n = cols * rows;
  return {
    f:           new Float32Array(n * Q),  // water distribution functions
    g:           new Float32Array(n * Q),  // sediment distribution functions
    fTmp:        new Float32Array(n * Q),  // post-collision scratch
    gTmp:        new Float32Array(n * Q),
    rhoWater:    new Float32Array(n),      // macroscopic water density
    rhoSediment: new Float32Array(n),      // macroscopic sediment density
  };
}

/**
 * One LBM timestep: collision + streaming for water and sediment fields.
 *
 * Source terms couple the LBM fields back to the Manning state each step:
 *   rhoWater    relaxes toward depths[idx] * 60
 *   rhoSediment relaxes toward sedimentDepth[idx] * 12
 * This means the density fields track the physics but with spatial diffusion
 * added by the LBM streaming, producing smooth continuous-field visuals.
 *
 * Open (outflow) boundary conditions: density streaming off the edge is
 * absorbed rather than bounced back, preventing wall accumulation.
 *
 * @param {Object}       state         - from createLBMState()
 * @param {Float32Array} fluxes        - [vx, vy] per cell (Manning output, after flux fix)
 * @param {Float32Array} depths        - water depth per cell (m)
 * @param {Float32Array} sedimentDepth - accumulated sediment per cell
 * @param {number}       cols
 * @param {number}       rows
 */
export function stepLBM(state, fluxes, depths, sedimentDepth, cols, rows) {
  const { f, g, fTmp, gTmp } = state;
  const n = cols * rows;
  const tau = 0.75; // relaxation time: >0.5 = stable; larger = more advective, less diffusive

  // ── Collision ─────────────────────────────────────────────────────────────
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const idx = i * cols + j;

      // Velocity from Manning solver — scale to LBM Mach number < 0.25
      const vx = fluxes[idx * 2];
      const vy = fluxes[idx * 2 + 1];
      const speed = Math.sqrt(vx * vx + vy * vy);
      const scale = speed > 2.5 ? 0.25 / speed : 0.1;
      const ux = vx * scale;
      const uy = vy * scale;

      // Current macroscopic densities
      let rW = 0, rS = 0;
      for (let q = 0; q < Q; q++) {
        rW += f[idx * Q + q];
        rS += g[idx * Q + q];
      }

      // Source: relax toward Manning state so the LBM field tracks physics
      const h  = Math.max(0, depths[idx]);
      const sd = sedimentDepth ? Math.max(0, sedimentDepth[idx]) : 0;
      rW = Math.max(0, rW + (h * 60 - rW) * 0.25);
      rS = Math.max(0, rS + (sd * 12 - rS) * 0.15);

      // BGK collision toward equilibrium
      for (let q = 0; q < Q; q++) {
        fTmp[idx * Q + q] = Math.max(0, f[idx * Q + q] + (feq(rW, ux, uy, q) - f[idx * Q + q]) / tau);
        gTmp[idx * Q + q] = Math.max(0, g[idx * Q + q] + (feq(rS, ux, uy, q) - g[idx * Q + q]) / tau);
      }
    }
  }

  // ── Streaming ─────────────────────────────────────────────────────────────
  f.fill(0);
  g.fill(0);

  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const idx = i * cols + j;
      for (let q = 0; q < Q; q++) {
        const ni = i + CY[q];
        const nj = j + CX[q];
        if (ni >= 0 && ni < rows && nj >= 0 && nj < cols) {
          const nidx = ni * cols + nj;
          f[nidx * Q + q] += fTmp[idx * Q + q];
          g[nidx * Q + q] += gTmp[idx * Q + q];
        }
        // Open BC: distributions streaming off the edge are simply absorbed
      }
    }
  }

  // ── Macroscopic densities ─────────────────────────────────────────────────
  for (let k = 0; k < n; k++) {
    let rW = 0, rS = 0;
    for (let q = 0; q < Q; q++) {
      rW += f[k * Q + q];
      rS += g[k * Q + q];
    }
    state.rhoWater[k]    = Math.max(0, rW);
    state.rhoSediment[k] = Math.max(0, rS);
  }
}
