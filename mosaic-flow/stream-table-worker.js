/**
 * stream-table-worker.js — Web Worker for stream table frame analysis.
 *
 * Multi-signal channel mask: dark particles, red fine particles, wet coarse particles.
 * Morphological closing + opening, 4-connectivity union-find, component map.
 */

// ═══════════════════════════════════════════════════════════════════════════
// Tunable constants (defaults — overridable via params)
// ═══════════════════════════════════════════════════════════════════════════

const TABLE_MARGIN = 0.05;

// Dark particle threshold (black 0.7mm sediment — strongest signal)
const DARK_R_MAX = 140;
const DARK_G_MAX = 140;
const DARK_B_MAX = 140;

// Red particle threshold (finest 0.4mm sediment in active flow paths)
const RED_R_MIN = 100;
const RED_R_MIN_RATIO_G = 1.25;
const RED_R_MIN_RATIO_B = 1.25;
const RED_R_MAX = 200;

// Wet coarse particle threshold (yellow 1.4mm and white 1.1mm darken when wet)
const WET_COARSE_V_MAX = 160;
const WET_COARSE_S_MAX = 40;

// Min blob size (px)
const MIN_BLOB_PX = 30;

const MORPH_KERNEL = 3;
const SPAN_ZONE = 0.10;

// Component visualization palette
const COMP_PALETTE = [
  [100,140,160],[140,120,160],[120,160,120],[160,140,100],[130,130,170],
  [160,120,130],[110,160,140],[150,150,110],[120,130,150],[150,120,150],
  [130,160,130],[160,130,120],[110,140,160],[140,150,120],[150,130,140],
  [120,150,150],[160,140,140],[130,140,130],[140,130,130],[130,130,140],
  [150,140,130],[130,150,140],[140,140,150],[140,150,150],[150,130,150],
  [130,150,130],[150,150,130],[140,130,160],[130,140,150],[150,140,150],
  [140,160,130],[130,160,150],
];

// ═══════════════════════════════════════════════════════════════════════════
// Union-Find (4-connectivity)
// ═══════════════════════════════════════════════════════════════════════════
class UnionFind {
  constructor(n) {
    this.parent = new Int32Array(n);
    this.rank = new Uint8Array(n);
    this.sz = new Int32Array(n);
    for (let i = 0; i < n; i++) { this.parent[i] = i; this.sz[i] = 1; }
  }
  find(x) {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]];
      x = this.parent[x];
    }
    return x;
  }
  union(a, b) {
    a = this.find(a); b = this.find(b);
    if (a === b) return;
    if (this.rank[a] < this.rank[b]) { const t = a; a = b; b = t; }
    this.parent[b] = a;
    this.sz[a] += this.sz[b];
    if (this.rank[a] === this.rank[b]) this.rank[a]++;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// RGB → HSV (V and S in 0–255 range for integer comparison)
// ═══════════════════════════════════════════════════════════════════════════
function rgbToSV(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const v = max; // 0–255
  const s = max === 0 ? 0 : Math.round(delta / max * 255); // 0–255
  return { s, v };
}

// ═══════════════════════════════════════════════════════════════════════════
// Multi-signal channel mask
// ═══════════════════════════════════════════════════════════════════════════
function buildChannelMask(data, w, h, params) {
  const darkMax = params.darkMax ?? DARK_R_MAX;
  const redRatioG = params.redRatioG ?? RED_R_MIN_RATIO_G;
  const redRatioB = params.redRatioB ?? RED_R_MIN_RATIO_B;
  const wetVMax = params.wetVMax ?? WET_COARSE_V_MAX;
  const margin = params.margin ?? TABLE_MARGIN;

  const mask = new Uint8Array(w * h);
  const mx = Math.floor(w * margin);
  const my = Math.floor(h * margin);
  const x1 = w - mx, y1 = h - my;

  // First pass: mark dark and red pixels, and build a "warm neighbor" flag
  // for the wet-coarse check. A warm pixel has R > 160 and R > G * 1.1 (yellowish/white dry)
  const isWarm = new Uint8Array(w * h);
  for (let y = my; y < y1; y++) {
    for (let x = mx; x < x1; x++) {
      const off = (y * w + x) * 4;
      const r = data[off], g = data[off + 1], b = data[off + 2];

      // Dark: all channels below threshold
      if (r < darkMax && g < darkMax && b < darkMax) {
        mask[y * w + x] = 1;
        continue;
      }

      // Red: R dominant, not too bright
      if (r > RED_R_MIN && r < RED_R_MAX && r > g * redRatioG && r > b * redRatioB) {
        mask[y * w + x] = 1;
        continue;
      }

      // Tag warm pixels for the wet-coarse neighborhood check
      if (r > 160 && r > g * 1.1) {
        isWarm[y * w + x] = 1;
      }
    }
  }

  // Second pass: wet coarse particles — low-sat, mid-value pixels near warm neighbors
  for (let y = my; y < y1; y++) {
    for (let x = mx; x < x1; x++) {
      if (mask[y * w + x]) continue; // already marked
      const off = (y * w + x) * 4;
      const r = data[off], g = data[off + 1], b = data[off + 2];
      const { s, v } = rgbToSV(r, g, b);
      if (v >= wetVMax || s >= WET_COARSE_S_MAX) continue;

      // Check 5px neighborhood for warm pixels
      let hasWarm = false;
      for (let dy = -2; dy <= 2 && !hasWarm; dy++) {
        for (let dx = -2; dx <= 2 && !hasWarm; dx++) {
          const ny = y + dy, nx = x + dx;
          if (ny >= my && ny < y1 && nx >= mx && nx < x1 && isWarm[ny * w + nx]) {
            hasWarm = true;
          }
        }
      }
      if (hasWarm) mask[y * w + x] = 1;
    }
  }

  return mask;
}

// ═══════════════════════════════════════════════════════════════════════════
// Morphological operations (3×3 kernel)
// ═══════════════════════════════════════════════════════════════════════════
function morphDilate(mask, w, h) {
  const r = Math.floor(MORPH_KERNEL / 2);
  const out = new Uint8Array(w * h);
  for (let y = r; y < h - r; y++)
    for (let x = r; x < w - r; x++) {
      let any = false;
      for (let dy = -r; dy <= r && !any; dy++)
        for (let dx = -r; dx <= r && !any; dx++)
          if (mask[(y + dy) * w + (x + dx)]) any = true;
      if (any) out[y * w + x] = 1;
    }
  return out;
}

function morphErode(mask, w, h) {
  const r = Math.floor(MORPH_KERNEL / 2);
  const out = new Uint8Array(w * h);
  for (let y = r; y < h - r; y++)
    for (let x = r; x < w - r; x++) {
      let all = true;
      for (let dy = -r; dy <= r && all; dy++)
        for (let dx = -r; dx <= r && all; dx++)
          if (!mask[(y + dy) * w + (x + dx)]) all = false;
      if (all) out[y * w + x] = 1;
    }
  return out;
}

function morphClose(mask, w, h) { return morphErode(morphDilate(mask, w, h), w, h); }
function morphOpen(mask, w, h) { return morphDilate(morphErode(mask, w, h), w, h); }

// ═══════════════════════════════════════════════════════════════════════════
// Analyze a single frame
// ═══════════════════════════════════════════════════════════════════════════
function analyzeFrame(data, w, h, params) {
  const minBlob = params.minBlob ?? MIN_BLOB_PX;
  const margin = params.margin ?? TABLE_MARGIN;

  const rawMask = buildChannelMask(data, w, h, params);
  // Closing first (connect broken channels), then opening (remove noise)
  const closed = morphClose(rawMask, w, h);
  const opened = morphOpen(closed, w, h);

  const mx = Math.floor(w * margin);
  const my = Math.floor(h * margin);
  const tableW = w - 2 * mx;
  const tableH = h - 2 * my;
  const totalPixels = tableW * tableH;

  let channelPixels = 0;
  for (let i = 0; i < w * h; i++) if (opened[i]) channelPixels++;

  // Union-Find
  const n = w * h;
  const uf = new UnionFind(n);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (!opened[idx]) continue;
      if (y > 0 && opened[(y - 1) * w + x]) uf.union(idx, (y - 1) * w + x);
      if (x > 0 && opened[y * w + x - 1]) uf.union(idx, y * w + x - 1);
    }

  const sizes = new Map();
  for (let i = 0; i < n; i++) {
    if (!opened[i]) continue;
    sizes.set(uf.find(i), uf.sz[uf.find(i)]);
  }

  let largestSize = 0, largestRoot = -1, nComponents = 0;
  for (const [root, sz] of sizes) {
    if (sz >= minBlob) nComponents++;
    if (sz > largestSize) { largestSize = sz; largestRoot = root; }
  }

  const channelFraction = totalPixels > 0 ? channelPixels / totalPixels : 0;
  const largestComponentFraction = totalPixels > 0 ? largestSize / totalPixels : 0;

  // Spanning check
  const topBound = my + Math.floor(tableH * SPAN_ZONE);
  const botBound = my + Math.floor(tableH * (1 - SPAN_ZONE));
  const touchesTop = new Set(), touchesBot = new Set();
  let spanning = false;
  for (let y = my; y < my + tableH; y++)
    for (let x = mx; x < mx + tableW; x++) {
      const idx = y * w + x;
      if (!opened[idx]) continue;
      const root = uf.find(idx);
      if (sizes.get(root) < minBlob) continue;
      if (y < topBound) touchesTop.add(root);
      if (y >= botBound) touchesBot.add(root);
    }
  for (const root of touchesTop) {
    if (touchesBot.has(root)) { spanning = true; break; }
  }

  // Colored component map
  const compMap = new Uint8ClampedArray(n * 4);
  const rootToIdx = new Map();
  let colorIdx = 0;
  for (let i = 0; i < n; i++) {
    const off = i * 4;
    if (!opened[i]) {
      compMap[off] = 30; compMap[off + 1] = 30; compMap[off + 2] = 35; compMap[off + 3] = 255;
      continue;
    }
    const root = uf.find(i);
    if (root === largestRoot) {
      compMap[off] = 240; compMap[off + 1] = 100; compMap[off + 2] = 60; compMap[off + 3] = 255;
    } else if (sizes.get(root) < minBlob) {
      compMap[off] = 50; compMap[off + 1] = 50; compMap[off + 2] = 55; compMap[off + 3] = 255;
    } else {
      if (!rootToIdx.has(root)) rootToIdx.set(root, colorIdx++);
      const c = COMP_PALETTE[rootToIdx.get(root) % COMP_PALETTE.length];
      compMap[off] = c[0]; compMap[off + 1] = c[1]; compMap[off + 2] = c[2]; compMap[off + 3] = 255;
    }
  }

  // Binary mask for temporal accumulation (1 byte per pixel, 1=channel)
  const binaryMask = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (opened[i]) binaryMask[i] = 1;

  return { channelFraction, largestComponentFraction, nComponents, spanning, compMap, binaryMask };
}

// ═══════════════════════════════════════════════════════════════════════════
// Build thumbnail from component map
// ═══════════════════════════════════════════════════════════════════════════
function buildThumb(compMap, srcW, srcH) {
  const thumbW = 80, thumbH = 60;
  const thumb = new Uint8ClampedArray(thumbW * thumbH * 4);
  for (let ty = 0; ty < thumbH; ty++)
    for (let tx = 0; tx < thumbW; tx++) {
      const sx = Math.floor(tx / thumbW * srcW);
      const sy = Math.floor(ty / thumbH * srcH);
      const si = (sy * srcW + sx) * 4;
      const ti = (ty * thumbW + tx) * 4;
      thumb[ti] = compMap[si]; thumb[ti+1] = compMap[si+1]; thumb[ti+2] = compMap[si+2]; thumb[ti+3] = 255;
    }
  return thumb;
}

// ═══════════════════════════════════════════════════════════════════════════
// Message handler
// ═══════════════════════════════════════════════════════════════════════════
self.onmessage = function(e) {
  const msg = e.data;

  if (msg.type === 'analyze') {
    const { imageData, width, height, frameIndex, timeS, params } = msg;
    const result = analyzeFrame(new Uint8ClampedArray(imageData), width, height, params || {});
    const thumb = buildThumb(result.compMap, width, height);

    self.postMessage({
      type: 'result',
      frameIndex, timeS,
      channelFraction: result.channelFraction,
      largestComponentFraction: result.largestComponentFraction,
      nComponents: result.nComponents,
      spanning: result.spanning,
      compMap: result.compMap,
      binaryMask: result.binaryMask,
      thumbData: thumb,
    }, [result.compMap.buffer, result.binaryMask.buffer, thumb.buffer]);
  }

  if (msg.type === 'preview') {
    const { imageData, width, height, params } = msg;
    const result = analyzeFrame(new Uint8ClampedArray(imageData), width, height, params || {});
    self.postMessage({
      type: 'preview-result',
      compMap: result.compMap,
      channelFraction: result.channelFraction,
      largestComponentFraction: result.largestComponentFraction,
      nComponents: result.nComponents,
      spanning: result.spanning,
    }, [result.compMap.buffer]);
  }
};
