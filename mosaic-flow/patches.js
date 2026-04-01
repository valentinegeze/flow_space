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
 * Fire parameters (FireSweep / site-percolation on 8-neighbors, p_c ≈ 0.41):
 * fuelLoad:     Base ignition probability p for an unburned neighbor (before continuity).
 *               Tuned near p_c so sparse / isolated cells are often subcritical (fire dies)
 *               and clusters with nearby forest/grass become supercritical.
 * crownSpreadOut: Multiplier for spread *from* this cell while it burns (crown / intensity).
 * burnDuration:  Fire-ticks the cell stays BURNING (longer = slower to go dark; reads as fuel depth).
 */
export const PATCH_PARAMS = {
  [PATCH_TYPES.GRASS]: {
    name: 'Grass',
    color: '#E2E2C1',
    manningN: 0.1,
    infiltration: 25,
    erodibility: 0.3,
    etRate: 2.5,
    connectivityThreshold: 0.5,
    fuelLoad: 0.37,       // alone: below p_c; needs grass/forest neighbors (continuity)
    crownSpreadOut: 1.0,
    burnDuration: 2,
  },
  [PATCH_TYPES.FOREST]: {
    name: 'Forest',
    color: '#68AB5F',
    manningN: 0.3,
    infiltration: 50,
    erodibility: 0.05,
    etRate: 6.0,
    connectivityThreshold: 1.5,
    fuelLoad: 0.28,       // lone trees: subcritical; dense canopy: neighbor boost pushes over p_c
    crownSpreadOut: 1.38, // strong outgoing crown fire
    burnDuration: 5,      // burns longer = slower advance through heavy fuel
  },
  [PATCH_TYPES.WETLAND]: {
    name: 'Wetland',
    color: '#BAD8EA',
    manningN: 0.15,
    infiltration: 80,
    erodibility: 0.1,
    etRate: 8.0,
    connectivityThreshold: 0.0,
    fuelLoad: 0.02,       // firebreak / moisture — almost never carries
    crownSpreadOut: 0.55,
    burnDuration: 1,
  },
  [PATCH_TYPES.BARE]: {
    name: 'Bare Soil',
    color: '#B3AC9F',
    manningN: 0.03,
    infiltration: 5,
    erodibility: 0.9,
    etRate: 0.5,
    connectivityThreshold: 0.2,
    fuelLoad: 0.11,
    crownSpreadOut: 0.74,
    burnDuration: 1,
  },
  [PATCH_TYPES.URBAN]: {
    name: 'Urban',
    color: '#EB0000',
    manningN: 0.015,
    infiltration: 2,
    erodibility: 0.2,
    etRate: 0.2,
    connectivityThreshold: 0.1,
    fuelLoad: 0.21,       // below p_c — built fabric blocks sustained spread
    crownSpreadOut: 0.66,
    burnDuration: 2,
  },
  [PATCH_TYPES.CORRIDOR]: {
    name: 'Corridor',
    color: '#CCBA7C',
    manningN: 0.03,
    infiltration: 15,
    erodibility: 0.4,
    etRate: 1.5,
    connectivityThreshold: 0.3,
    fuelLoad: 0.39,       // near p_c — linear strips need connectivity to run
    crownSpreadOut: 1.12,
    burnDuration: 2,
  },
  [PATCH_TYPES.WATER]: {
    name: 'River/Canal/Lake',
    color: '#466B9F',
    manningN: 0.02,
    infiltration: 0,
    erodibility: 0,
    etRate: 5.0,
    connectivityThreshold: 0.0,
    fuelLoad: 0.0,
    crownSpreadOut: 0.0,
    burnDuration: 0,
  },
};

/**
 * Default matrix (dominant patch) for new landscapes.
 */
export const DEFAULT_MATRIX = PATCH_TYPES.GRASS;
