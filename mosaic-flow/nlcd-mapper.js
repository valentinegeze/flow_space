/**
 * nlcd-mapper.js
 * Maps USGS National Land Cover Database (NLCD 2021) classes to mosaic-flow patch types.
 */

// NLCD class definitions: official RGB colors for WMS color-sampling, internal patch mapping.
// Colors are the canonical NLCD legend values used by the MRLC WMS renderer.
export const NLCD_CLASSES = {
  11: { name: 'Open Water',                     patchKey: 'water',    color: [70, 107, 159],  hex: '#466B9F' },
  12: { name: 'Perennial Ice/Snow',             patchKey: 'water',    color: [209, 222, 248], hex: '#D1DEF8' },
  21: { name: 'Developed, Open Space',          patchKey: 'urban',    color: [221, 201, 201], hex: '#DDC9C9' },
  22: { name: 'Developed, Low Intensity',       patchKey: 'urban',    color: [217, 146, 130], hex: '#D99282' },
  23: { name: 'Developed, Medium Intensity',    patchKey: 'urban',    color: [235,   0,   0], hex: '#EB0000' },
  24: { name: 'Developed, High Intensity',      patchKey: 'urban',    color: [171,   0,   0], hex: '#AB0000' },
  31: { name: 'Barren Land',                    patchKey: 'bare',     color: [179, 172, 159], hex: '#B3AC9F' },
  41: { name: 'Deciduous Forest',               patchKey: 'forest',   color: [104, 171,  95], hex: '#68AB5F' },
  42: { name: 'Evergreen Forest',               patchKey: 'forest',   color: [ 28,  95,  44], hex: '#1C5F2C' },
  43: { name: 'Mixed Forest',                   patchKey: 'forest',   color: [181, 197, 143], hex: '#B5C58F' },
  51: { name: 'Dwarf Scrub',                    patchKey: 'grass',    color: [175, 150,  60], hex: '#AF963C' },
  52: { name: 'Shrub/Scrub',                    patchKey: 'corridor', color: [204, 186, 124], hex: '#CCBA7C' },
  71: { name: 'Grassland/Herbaceous',           patchKey: 'grass',    color: [226, 226, 193], hex: '#E2E2C1' },
  72: { name: 'Sedge/Herbaceous',               patchKey: 'grass',    color: [169, 194, 120], hex: '#A9C278' },
  73: { name: 'Lichens',                        patchKey: 'bare',     color: [186, 186, 186], hex: '#BABABA' },
  74: { name: 'Moss',                           patchKey: 'wetland',  color: [115, 186, 218], hex: '#73BAD8' },
  81: { name: 'Pasture/Hay',                    patchKey: 'grass',    color: [219, 216,  61], hex: '#DBD83D' },
  82: { name: 'Cultivated Crops',               patchKey: 'bare',     color: [170, 112,  40], hex: '#AA7028' },
  90: { name: 'Woody Wetlands',                 patchKey: 'wetland',  color: [186, 216, 234], hex: '#BAD8EA' },
  95: { name: 'Emergent Herbaceous Wetlands',   patchKey: 'wetland',  color: [112, 163, 186], hex: '#70A3BA' },
};

// Must match the key order in patches.js PATCH_PARAMS exactly.
export const PATCH_KEYS = ['grass', 'forest', 'wetland', 'bare', 'urban', 'corridor', 'water'];

/**
 * Convert an NLCD integer class value to the internal patch index (0–6).
 */
export function nlcdToPatchIndex(nlcdValue) {
  const entry = NLCD_CLASSES[nlcdValue];
  if (!entry) return 0; // fallback: grass
  const idx = PATCH_KEYS.indexOf(entry.patchKey);
  return idx >= 0 ? idx : 0;
}

/**
 * Find the nearest NLCD class by Euclidean RGB distance.
 * Used to decode WMS color-sampled pixels back into class values.
 */
export function colorToNlcdClass(r, g, b) {
  let bestClass = 71; // Grassland default
  let bestDist = Infinity;
  for (const [cls, { color }] of Object.entries(NLCD_CLASSES)) {
    const d = (r - color[0]) ** 2 + (g - color[1]) ** 2 + (b - color[2]) ** 2;
    if (d < bestDist) {
      bestDist = d;
      bestClass = Number(cls);
    }
  }
  // Only trust match if color distance is within reasonable range (~80 units)
  return bestDist < 6400 ? bestClass : 71;
}

/**
 * Summarize land cover composition of an NLCD grid.
 * Returns array sorted by descending coverage, with name, hex, patchKey, and fraction.
 */
export function computeComposition(nlcdGrid) {
  const counts = {};
  let total = 0;
  for (const val of nlcdGrid) {
    if (val === 0) continue;
    counts[val] = (counts[val] || 0) + 1;
    total++;
  }
  if (total === 0) return [];
  return Object.entries(counts)
    .map(([cls, count]) => {
      const c = Number(cls);
      const entry = NLCD_CLASSES[c] || { name: `Class ${c}`, hex: '#888', patchKey: 'grass' };
      return { nlcdClass: c, name: entry.name, hex: entry.hex, patchKey: entry.patchKey, pct: count / total };
    })
    .sort((a, b) => b.pct - a.pct);
}

/**
 * Generate a synthetic NLCD-classified grid for testing / when live fetch is unavailable.
 * Uses seeded LCG noise to produce blob-based land cover patterns with a water channel.
 */
export function generateMockNLCDGrid(cols, rows, seed = 42) {
  const grid = new Uint8Array(cols * rows);

  // Seeded LCG pseudo-random
  let s = (seed >>> 0) || 1;
  const rng = () => { s = Math.imul(s, 1664525) + 1013904223; return (s >>> 0) / 4294967296; };

  // Class distribution weighted toward forested/agricultural typical US landscape
  const classes =  [41,  42,  52,  71,  81,  82,  21,  11,  90,  31];
  const weights =  [20,  15,  10,  15,  10,  10,   8,   5,   7,   4];
  const cumW = weights.reduce((acc, w, i) => { acc.push((acc[i - 1] || 0) + w); return acc; }, []);
  const totalW = cumW[cumW.length - 1];
  const pickClass = () => { const r = rng() * totalW; return classes[cumW.findIndex(w => w >= r)]; };

  const numBlobs = 22;
  const blobs = Array.from({ length: numBlobs }, () => ({
    cx: rng() * cols, cy: rng() * rows,
    rx: 4 + rng() * 14, ry: 3 + rng() * 10,
    cls: pickClass(),
  }));

  // Add a sinuous water channel
  const chanCol = cols * (0.3 + rng() * 0.4);
  const chanAmp = 3 + rng() * 4;

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      let cls = 71; // grassland default
      let bestD = 1; // blobs replace default only if d < 1 (inside blob)
      for (const b of blobs) {
        const d = Math.sqrt(((col - b.cx) / b.rx) ** 2 + ((row - b.cy) / b.ry) ** 2);
        if (d < 1 && d < bestD) { bestD = d; cls = b.cls; }
      }
      const chanX = chanCol + chanAmp * Math.sin((row / rows) * Math.PI * 3.5);
      const distChan = Math.abs(col - chanX);
      if (distChan < 1.5) cls = 11;       // open water
      else if (distChan < 3.5) cls = 90;  // woody wetlands buffer
      grid[row * cols + col] = cls;
    }
  }
  return grid;
}
