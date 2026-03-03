/**
 * Particle-based sediment transport.
 * Particles spawn in erodible cells when shear stress exceeds threshold,
 * advect with flow, settle when velocity drops.
 */

import { PATCH_PARAMS } from './patches.js';

const patchKeys = Object.keys(PATCH_PARAMS);

/**
 * Spawn particles in erodible cells based on flow and patch erodibility.
 * @param {Float32Array} depths - water depth per cell
 * @param {Float32Array} fluxes - vx, vy per cell
 * @param {Uint8Array} patchGrid - patch index per cell
 * @param {number} cols
 * @param {number} rows
 * @param {Array} particles - existing particles (mutated)
 * @param {number} dt - timestep
 * @param {number} [sedimentMultiplier=1] - scale factor for spawn rate
 */
export function spawnParticles(depths, fluxes, patchGrid, cols, rows, particles, dt = 1, sedimentMultiplier = 1) {
  const spawnRate = 0.02 * sedimentMultiplier;
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const idx = i * cols + j;
      const patchIdx = patchGrid[idx];
      const params = PATCH_PARAMS[patchKeys[patchIdx]] || PATCH_PARAMS.grass;
      if (params.erodibility < 0.1) continue;

      const h = depths[idx];
      const vx = fluxes[idx * 2];
      const vy = fluxes[idx * 2 + 1];
      const v = Math.sqrt(vx * vx + vy * vy);

      if (h > 0.002 && v > 0.01 && Math.random() < spawnRate * params.erodibility * dt) {
        particles.push({
          x: j + Math.random(),
          y: i + Math.random(),
          vx: 0,
          vy: 0,
          settled: false,
          sourcePatch: patchIdx,
          color: getSedimentColor(patchIdx),
        });
      }
    }
  }
}

function getSedimentColor(patchIdx) {
  const colors = [
    [139, 115, 85],   // grass - brown
    [34, 139, 34],    // forest - dark green
    [65, 105, 225],   // wetland - blue
    [139, 90, 43],    // bare - sienna
    [74, 74, 90],     // urban - charcoal gray
    [196, 122, 90],   // corridor - muted warm reddish orange
    [135, 206, 235],  // water - sky blue (no sediment spawns, fallback)
  ];
  const c = colors[Math.min(patchIdx, colors.length - 1)];
  return c;
}

/**
 * Advect particles with flow field, settle when velocity is low.
 * When particles settle, they add to sedimentDepth (accumulation).
 * @param {Array} particles
 * @param {Float32Array} depths
 * @param {Float32Array} fluxes
 * @param {number} cols
 * @param {number} rows
 * @param {number} dt
 * @param {Float32Array} [sedimentDepth] - optional, accumulates when particles settle
 */
export function advectParticles(particles, depths, fluxes, cols, rows, dt = 1, sedimentDepth = null) {
  const settleThreshold = 0.005;
  const maxParticles = 2000;
  const depositAmount = 0.5;

  for (let k = particles.length - 1; k >= 0; k--) {
    const p = particles[k];
    if (p.settled) continue;

    const i = Math.floor(p.y);
    const j = Math.floor(p.x);
    if (i < 0 || i >= rows || j < 0 || j >= cols) {
      particles.splice(k, 1);
      continue;
    }

    const idx = i * cols + j;
    const vx = fluxes[idx * 2];
    const vy = fluxes[idx * 2 + 1];
    const v = Math.sqrt(vx * vx + vy * vy);

    if (v < settleThreshold) {
      p.settled = true;
      if (sedimentDepth && i >= 0 && i < rows && j >= 0 && j < cols) {
        sedimentDepth[idx] += depositAmount;
      }
      continue;
    }

    p.x += vx * dt * 0.5;
    p.y += vy * dt * 0.5;

    if (p.x < 0 || p.x >= cols || p.y < 0 || p.y >= rows) {
      particles.splice(k, 1);
    }
  }

  if (particles.length > maxParticles) {
    particles.splice(0, particles.length - maxParticles);
  }
}
