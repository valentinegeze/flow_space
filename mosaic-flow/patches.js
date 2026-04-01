/**
 * Patch types and lookup tables for land mosaic flow model.
 * Each patch type maps to physical parameters: Manning's n, infiltration, erodibility.
 */

export const PATCH_TYPES = {
  GRASS: 'grass',
  FOREST: 'forest',
  WETLAND: 'wetland',
  BARE: 'bare',
  URBAN: 'urban',
  CORRIDOR: 'corridor',
  WATER: 'water',
};

/**
 * Physical parameters per patch type.
 * manningN:    roughness (higher = slower flow)
 * infiltration: mm/hr max infiltration rate
 * erodibility: 0-1, relative sediment contribution when eroded
 *
 * Fire parameters:
 * fuelLoad:    0-1; directly equivalent to density p in site-percolation theory.
 *              8-neighbor percolation threshold ≈ 0.41.
 *              Below threshold: fire burns out locally (subcritical).
 *              Above threshold: fire sweeps the landscape (supercritical).
 * burnDuration: how many fire-ticks a cell stays BURNING before going BURNED.
 *              Each fire-tick ≈ 150 ms at default speed.
 */
export const PATCH_PARAMS = {
  [PATCH_TYPES.GRASS]: {
    name: 'Grass',
    color: '#6B8E23',
    manningN: 0.1,
    infiltration: 25,
    erodibility: 0.3,
    etRate: 2.5,
    connectivityThreshold: 0.5,
    fuelLoad: 0.70,    // supercritical — fire spreads through grassland
    burnDuration: 2,
  },
  [PATCH_TYPES.FOREST]: {
    name: 'Forest',
    color: '#228B22',
    manningN: 0.3,
    infiltration: 50,
    erodibility: 0.05,
    etRate: 6.0,
    connectivityThreshold: 1.5,
    fuelLoad: 1.0,     // always ignites; guaranteed percolation
    burnDuration: 4,
  },
  [PATCH_TYPES.WETLAND]: {
    name: 'Wetland',
    color: '#4169E1',
    manningN: 0.15,
    infiltration: 80,
    erodibility: 0.1,
    etRate: 8.0,
    connectivityThreshold: 0.0,
    fuelLoad: 0.05,    // strongly subcritical; acts as firebreak
    burnDuration: 1,
  },
  [PATCH_TYPES.BARE]: {
    name: 'Bare Soil',
    color: '#8B7355',
    manningN: 0.03,
    infiltration: 5,
    erodibility: 0.9,
    etRate: 0.5,
    connectivityThreshold: 0.2,
    fuelLoad: 0.18,    // subcritical; fire does not carry through bare soil
    burnDuration: 1,
  },
  [PATCH_TYPES.URBAN]: {
    name: 'Urban',
    color: '#4a4a5a',
    manningN: 0.015,
    infiltration: 2,
    erodibility: 0.2,
    etRate: 0.2,
    connectivityThreshold: 0.1,
    fuelLoad: 0.32,    // subcritical; fire stops in built-up areas
    burnDuration: 2,
  },
  [PATCH_TYPES.CORRIDOR]: {
    name: 'Corridor',
    color: '#b8e04a',
    manningN: 0.03,
    infiltration: 15,
    erodibility: 0.4,
    etRate: 1.5,
    connectivityThreshold: 0.3,
    fuelLoad: 0.62,    // slightly supercritical; corridors can carry fire
    burnDuration: 2,
  },
  [PATCH_TYPES.WATER]: {
    name: 'River/Canal/Lake',
    color: '#87CEEB',
    manningN: 0.02,
    infiltration: 0,
    erodibility: 0,
    etRate: 5.0,
    connectivityThreshold: 0.0,
    fuelLoad: 0.0,     // no fuel
    burnDuration: 0,
  },
};

/**
 * Default matrix (dominant patch) for new landscapes.
 */
export const DEFAULT_MATRIX = PATCH_TYPES.GRASS;
