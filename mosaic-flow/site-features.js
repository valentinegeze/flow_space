/**
 * site-features.js — Browser-side tree and building data fetching from
 * OpenStreetMap Overpass API, graph construction, and connected components.
 *
 * No server, no Python — works entirely client-side using fetch().
 */

import { PATCH_PARAMS } from './patches.js';

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const MAX_EDGE_DISTANCE_M = 15;
const PHI_STAR = 0.593;

// ── Cache ─────────────────────────────────────────────────────────────────
const _cache = new Map(); // boundsKey → result

function boundsKey(b) {
  return `${b.west.toFixed(6)},${b.south.toFixed(6)},${b.east.toFixed(6)},${b.north.toFixed(6)}`;
}

// ── Haversine ─────────────────────────────────────────────────────────────
function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Seeded random ─────────────────────────────────────────────────────────
function seededRandom(seed) {
  let s = seed | 0;
  return () => { s = (s * 1664525 + 1013904223) & 0x7fffffff; return s / 0x7fffffff; };
}

// ── Union-Find ────────────────────────────────────────────────────────────
class UnionFind {
  constructor(n) {
    this.parent = new Array(n);
    this.sz = new Array(n);
    for (let i = 0; i < n; i++) { this.parent[i] = i; this.sz[i] = 1; }
  }
  find(x) {
    while (this.parent[x] !== x) { this.parent[x] = this.parent[this.parent[x]]; x = this.parent[x]; }
    return x;
  }
  union(a, b) {
    a = this.find(a); b = this.find(b);
    if (a === b) return;
    if (this.sz[a] < this.sz[b]) { const t = a; a = b; b = t; }
    this.parent[b] = a;
    this.sz[a] += this.sz[b];
  }
}

// ── Overpass fetch ────────────────────────────────────────────────────────

async function fetchOverpass(query) {
  const resp = await fetch(OVERPASS_URL, {
    method: 'POST',
    body: 'data=' + encodeURIComponent(query),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  if (!resp.ok) throw new Error(`Overpass ${resp.status}`);
  return resp.json();
}

async function fetchBuildings(bounds) {
  const { south, west, north, east } = bounds;
  const query = `
    [out:json][timeout:25];
    (
      way["building"](${south},${west},${north},${east});
      relation["building"](${south},${west},${north},${east});
    );
    out center tags;
  `;
  const data = await fetchOverpass(query);
  const buildings = [];
  for (const el of data.elements || []) {
    const c = el.center;
    if (!c) continue;
    const tags = el.tags || {};

    // Vulnerability scoring
    let vuln = 0.3;
    const startDate = parseInt(tags['start_date'] || tags['building:start_date'] || '2000');
    if (startDate < 1980) vuln += 0.2;
    const mat = (tags['building:material'] || tags['roof:material'] || '').toLowerCase();
    if (mat.includes('wood')) vuln += 0.2;
    const bType = (tags['building'] || '').toLowerCase();
    if (bType === 'house' || bType === 'residential' || bType === 'yes') vuln += 0.15;
    vuln = Math.min(1, vuln);

    buildings.push({ type: 'building', lat: c.lat, lon: c.lon, id: el.id, vulnerability: vuln });
  }
  return buildings;
}

async function fetchTrees(bounds) {
  const { south, west, north, east } = bounds;
  const query = `
    [out:json][timeout:25];
    (
      node["natural"="tree"](${south},${west},${north},${east});
      way["landuse"="forest"](${south},${west},${north},${east});
      way["natural"="wood"](${south},${west},${north},${east});
    );
    out center;
  `;
  const data = await fetchOverpass(query);
  const trees = [];

  for (const el of data.elements || []) {
    if (el.type === 'node') {
      const seed = Math.floor(el.lat * 1e5 + el.lon * 1e5);
      const rng = seededRandom(seed);
      trees.push({ type: 'tree', lat: el.lat, lon: el.lon, id: el.id, crownRadius: 2 + rng() * 4 });
    } else if (el.center) {
      // Forest/wood polygon — generate synthetic tree grid within bounds
      // Use the center and a ~50m spread
      const seed = Math.floor(el.center.lat * 1e5 + el.center.lon * 1e5);
      const rng = seededRandom(seed);
      const mPerDeg = 111320 * Math.cos(el.center.lat * Math.PI / 180);
      const spacing = 5 / mPerDeg; // ~5m spacing in degrees
      const spread = 25 / mPerDeg; // ~25m radius

      for (let dlat = -spread; dlat <= spread; dlat += spacing) {
        for (let dlon = -spread; dlon <= spread; dlon += spacing) {
          const lat = el.center.lat + dlat + (rng() - 0.5) * spacing * 0.5;
          const lon = el.center.lon + dlon + (rng() - 0.5) * spacing * 0.5;
          if (lat < south || lat > north || lon < west || lon > east) continue;
          trees.push({ type: 'tree', lat, lon, id: el.id * 1000 + trees.length, crownRadius: 2 + rng() * 4 });
        }
      }
    }
  }
  return trees;
}

// ── Synthetic fallback ────────────────────────────────────────────────────

function generateSyntheticTrees(bounds, patchGrid, patchKeys, elevations, cols, rows) {
  const trees = [];
  const { south, west, north, east } = bounds;
  const latStep = (north - south) / rows;
  const lonStep = (east - west) / cols;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const key = patchKeys[patchGrid[r * cols + c]];
      if (key !== 'forest' && key !== 'corridor') continue;
      const seed = r * cols + c;
      const rng = seededRandom(seed);
      // ~4 trees per cell
      const count = 2 + Math.floor(rng() * 4);
      for (let t = 0; t < count; t++) {
        const lat = south + (r + rng()) * latStep;
        const lon = west + (c + rng()) * lonStep;
        const elevNorm = elevations ? (elevations[r * cols + c] - 0.5) : 0;
        const height = 8 + Math.max(0, elevNorm) * 12;
        trees.push({
          type: 'tree', lat, lon, id: seed * 100 + t,
          crownRadius: 2 + rng() * 4,
          height,
        });
      }
    }
  }
  return trees;
}

// ── Graph construction ────────────────────────────────────────────────────

function buildGraph(nodes, maxEdgeM, windAngle, windSpeed, elevations, bounds, cols, rows) {
  const edges = [];
  const wRad = (windAngle * Math.PI) / 180;
  const wx = Math.sin(wRad), wy = -Math.cos(wRad);

  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const d = haversineM(nodes[i].lat, nodes[i].lon, nodes[j].lat, nodes[j].lon);
      if (d > maxEdgeM) continue;

      // Weight: base from distance, modified by wind and slope
      let weight = 1 - d / maxEdgeM; // closer = higher base weight

      // Wind factor
      const dlat = nodes[j].lat - nodes[i].lat;
      const dlon = nodes[j].lon - nodes[i].lon;
      const dist = Math.sqrt(dlat * dlat + dlon * dlon) || 1e-9;
      const dot = (dlon / dist) * wx + (dlat / dist) * wy;
      weight *= Math.max(0.1, 1 + dot * windSpeed * 0.3);

      // Slope factor if elevations available
      if (elevations && bounds) {
        const { south, west, north, east } = bounds;
        const r1 = Math.floor((nodes[i].lat - south) / (north - south) * rows);
        const c1 = Math.floor((nodes[i].lon - west) / (east - west) * cols);
        const r2 = Math.floor((nodes[j].lat - south) / (north - south) * rows);
        const c2 = Math.floor((nodes[j].lon - west) / (east - west) * cols);
        const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
        const e1 = elevations[clamp(r1, 0, rows - 1) * cols + clamp(c1, 0, cols - 1)];
        const e2 = elevations[clamp(r2, 0, rows - 1) * cols + clamp(c2, 0, cols - 1)];
        weight *= Math.max(0.2, 1 + (e2 - e1) * 10);
      }

      weight = Math.max(0, Math.min(1, weight));
      edges.push({ i, j, weight, distanceM: d });
    }
  }

  // Connected components
  const uf = new UnionFind(nodes.length);
  for (const e of edges) uf.union(e.i, e.j);

  const sizes = new Map();
  for (let i = 0; i < nodes.length; i++) {
    const root = uf.find(i);
    sizes.set(root, (sizes.get(root) || 0) + 1);
  }
  let giantSize = 0;
  for (const sz of sizes.values()) if (sz > giantSize) giantSize = sz;
  const phiLocal = nodes.length > 0 ? giantSize / nodes.length : 0;

  return { edges, phiLocal, giantSize };
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Fetch site features for a bounding box. Returns:
 * { nodes, edges, phiLocal, giantSize, status: 'real'|'synthetic'|'error' }
 *
 * Uses cached results if available for the same bounds.
 */
export async function fetchSiteFeatures({
  bounds, patchGrid, patchKeys, elevations, cols, rows,
  windAngle = 225, windSpeed = 2.5, maxEdgeM = MAX_EDGE_DISTANCE_M,
}) {
  const key = boundsKey(bounds);

  // Check cache for nodes (re-build graph since wind may have changed)
  let nodes = null;
  let status = 'real';

  if (_cache.has(key)) {
    nodes = _cache.get(key);
  } else {
    try {
      const [buildings, trees] = await Promise.all([
        fetchBuildings(bounds),
        fetchTrees(bounds),
      ]);

      // If sparse tree coverage, add synthetic trees
      const individualTrees = trees.filter(t => t.crownRadius != null);
      if (individualTrees.length < 5) {
        const synthetic = generateSyntheticTrees(bounds, patchGrid, patchKeys, elevations, cols, rows);
        nodes = [...buildings, ...trees, ...synthetic];
        status = nodes.length > buildings.length + trees.length ? 'synthetic' : 'real';
      } else {
        nodes = [...buildings, ...trees];
      }

      _cache.set(key, nodes);
    } catch {
      // Fetch failed — full synthetic fallback
      const synthetic = generateSyntheticTrees(bounds, patchGrid, patchKeys, elevations, cols, rows);
      nodes = synthetic;
      status = 'error';
      _cache.set(key, nodes);
    }
  }

  const { edges, phiLocal, giantSize } = buildGraph(
    nodes, maxEdgeM, windAngle, windSpeed, elevations, bounds, cols, rows
  );

  return { nodes, edges, phiLocal, giantSize, status };
}

/**
 * Recompute graph edges only (wind/speed changed, nodes stay the same).
 */
export function rebuildGraph(nodes, { windAngle, windSpeed, maxEdgeM, elevations, bounds, cols, rows }) {
  return buildGraph(nodes, maxEdgeM || MAX_EDGE_DISTANCE_M, windAngle, windSpeed, elevations, bounds, cols, rows);
}

export { MAX_EDGE_DISTANCE_M, PHI_STAR, haversineM };
