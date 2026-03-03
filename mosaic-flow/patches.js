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
 * manningN: roughness (higher = slower flow)
 * infiltration: mm/hr max infiltration rate
 * erodibility: 0-1, relative sediment contribution when eroded
 */
export const PATCH_PARAMS = {
  [PATCH_TYPES.GRASS]: {
    name: 'Grass',
    color: '#6B8E23',
    manningN: 0.1,
    infiltration: 25,
    erodibility: 0.3,
  },
  [PATCH_TYPES.FOREST]: {
    name: 'Forest',
    color: '#228B22',
    manningN: 0.3,
    infiltration: 50,
    erodibility: 0.05,
  },
  [PATCH_TYPES.WETLAND]: {
    name: 'Wetland',
    color: '#4169E1',
    manningN: 0.15,
    infiltration: 80,
    erodibility: 0.1,
  },
  [PATCH_TYPES.BARE]: {
    name: 'Bare Soil',
    color: '#8B7355',
    manningN: 0.03,
    infiltration: 5,
    erodibility: 0.9,
  },
  [PATCH_TYPES.URBAN]: {
    name: 'Urban',
    color: '#4a4a5a',
    manningN: 0.015,
    infiltration: 2,
    erodibility: 0.2,
  },
  [PATCH_TYPES.CORRIDOR]: {
    name: 'Corridor',
    color: '#c47a5a',
    manningN: 0.03,
    infiltration: 15,
    erodibility: 0.4,
  },
  [PATCH_TYPES.WATER]: {
    name: 'River/Canal/Lake',
    color: '#87CEEB',
    manningN: 0.02,
    infiltration: 0,
    erodibility: 0,
  },
};

/**
 * Default matrix (dominant patch) for new landscapes.
 */
export const DEFAULT_MATRIX = PATCH_TYPES.GRASS;
