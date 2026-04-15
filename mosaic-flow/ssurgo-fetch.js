/**
 * ssurgo-fetch.js — Fetch real soil properties from the USDA Soil Data Access REST API.
 *
 * Queries the SDA tabular service with a bounding-box spatial query to retrieve
 * dominant soil map unit properties (texture, Kf, organic matter, hydrologic group,
 * infiltration, etc.) for a given parcel extent.
 */

const SDA_URL = 'https://SDMDataAccess.sc.egov.usda.gov/Tabular/SDMTabularService/post.rest';

// Cache by bounds key to avoid repeated fetches
const _cache = new Map();

function boundsKey(b) {
  return `${b.west.toFixed(5)},${b.south.toFixed(5)},${b.east.toFixed(5)},${b.north.toFixed(5)}`;
}

/**
 * Fetch SSURGO soil properties for a geographic bounding box.
 *
 * @param {{ west, south, east, north }} bounds
 * @returns {Promise<object>} — Aggregated soil properties:
 *   { muname, texdesc, kfact, om, hydgrp, ksat, awc, slope, components[] }
 */
export async function fetchSSURGOProperties(bounds) {
  const key = boundsKey(bounds);
  if (_cache.has(key)) return _cache.get(key);

  // Build a polygon WKT from the bounding box
  const { west, south, east, north } = bounds;
  const wkt = `POLYGON((${west} ${south}, ${east} ${south}, ${east} ${north}, ${west} ${north}, ${west} ${south}))`;

  // Query: find map units that intersect the bounding box, then pull
  // dominant component properties (texture, Kf, OM, hydrologic group, Ksat, AWC)
  const query = `
    SELECT
      mu.muname,
      mu.mukey,
      c.compname,
      c.comppct_r,
      c.hydgrp,
      c.slope_r,
      cht.texdesc,
      cht.kffact,
      cht.om_r,
      cht.ksat_r,
      cht.awc_r,
      cht.hzdept_r,
      cht.hzdepb_r
    FROM SDA_Get_Mukey_from_intersection_with_WktWgs84('${wkt}') AS mk
    INNER JOIN mapunit AS mu ON mu.mukey = mk.mukey
    INNER JOIN component AS c ON c.mukey = mu.mukey
    INNER JOIN chorizon AS ch ON ch.cokey = c.cokey
    LEFT JOIN chtexturegrp AS chtg ON chtg.chkey = ch.chkey AND chtg.rvindicator = 'Yes'
    LEFT JOIN (
      SELECT
        ch2.chkey,
        chtg2.texdesc,
        ch2.kffact,
        ch2.om_r,
        ch2.ksat_r,
        ch2.awc_r,
        ch2.hzdept_r,
        ch2.hzdepb_r
      FROM chorizon AS ch2
      LEFT JOIN chtexturegrp AS chtg2 ON chtg2.chkey = ch2.chkey AND chtg2.rvindicator = 'Yes'
    ) AS cht ON cht.chkey = ch.chkey
    WHERE c.comppct_r >= 10
      AND ch.hzdept_r = 0
    ORDER BY c.comppct_r DESC
  `;

  try {
    const resp = await fetch(SDA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, resultFormat: 'JSON' }),
    });

    if (!resp.ok) throw new Error(`SDA API error: ${resp.status}`);
    const json = await resp.json();

    const result = parseSSURGOResponse(json);
    _cache.set(key, result);
    return result;
  } catch (err) {
    console.warn('SSURGO fetch failed, using fallback:', err);
    return null;
  }
}

/**
 * Simpler query that's more reliable — queries just the dominant map unit properties.
 */
export async function fetchSSURGOSimple(bounds) {
  const key = boundsKey(bounds) + '_simple';
  if (_cache.has(key)) return _cache.get(key);

  const { west, south, east, north } = bounds;
  const wkt = `POLYGON((${west} ${south}, ${east} ${south}, ${east} ${north}, ${west} ${north}, ${west} ${south}))`;

  // Two queries: one for map unit + component info, one for top horizon properties
  const query = `
    SELECT TOP 5
      mu.muname,
      c.compname,
      c.comppct_r,
      c.hydgrp,
      c.slope_r,
      ch.hzdept_r,
      ch.hzdepb_r,
      ch.kffact,
      ch.om_r,
      ch.ksat_r,
      ch.awc_r,
      ch.sandtotal_r,
      ch.claytotal_r,
      ch.silttotal_r,
      ch.dbthirdbar_r
    FROM SDA_Get_Mukey_from_intersection_with_WktWgs84('${wkt}') AS mk
    INNER JOIN mapunit AS mu ON mu.mukey = mk.mukey
    INNER JOIN component AS c ON c.mukey = mu.mukey AND c.majcompflag = 'Yes'
    INNER JOIN chorizon AS ch ON ch.cokey = c.cokey AND ch.hzdept_r = 0
    ORDER BY c.comppct_r DESC
  `;

  try {
    const resp = await fetch(SDA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, resultFormat: 'JSON' }),
    });

    if (!resp.ok) throw new Error(`SDA API error: ${resp.status}`);
    const json = await resp.json();

    const result = parseSimpleResponse(json);
    _cache.set(key, result);
    return result;
  } catch (err) {
    console.warn('SSURGO simple fetch failed:', err);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Response parsing
// ═══════════════════════════════════════════════════════════════════════════

function parseSimpleResponse(json) {
  if (!json?.Table || json.Table.length === 0) return null;

  const rows = json.Table;
  const components = rows.map(r => ({
    muname:     r.muname || '',
    compname:   r.compname || '',
    comppct:    parseFloat(r.comppct_r) || 0,
    hydgrp:     r.hydgrp || 'B',
    slope:      parseFloat(r.slope_r) || 0,
    kfact:      parseFloat(r.kffact) || 0,
    om:         parseFloat(r.om_r) || 0,
    ksat:       parseFloat(r.ksat_r) || 0,    // micrometers/sec
    awc:        parseFloat(r.awc_r) || 0,      // cm/cm
    sand:       parseFloat(r.sandtotal_r) || 0,
    clay:       parseFloat(r.claytotal_r) || 0,
    silt:       parseFloat(r.silttotal_r) || 0,
    bulkDensity: parseFloat(r.dbthirdbar_r) || 0,
    hzTop:      parseFloat(r.hzdept_r) || 0,
    hzBottom:   parseFloat(r.hzdepb_r) || 0,
  }));

  // Weight-average by component percentage
  const totalPct = components.reduce((s, c) => s + c.comppct, 0) || 1;
  const weighted = (field) => components.reduce((s, c) => s + c[field] * c.comppct, 0) / totalPct;

  // Ksat: micrometers/sec → mm/hr
  const ksatMmHr = weighted('ksat') * 3.6;

  // Determine dominant texture from sand/clay/silt
  const sand = weighted('sand');
  const clay = weighted('clay');
  const silt = weighted('silt');
  const texdesc = classifyTexture(sand, clay, silt);

  // Dominant hydrologic group (most common weighted)
  const hydgrpCounts = {};
  for (const c of components) {
    const g = (c.hydgrp || 'B').charAt(0);
    hydgrpCounts[g] = (hydgrpCounts[g] || 0) + c.comppct;
  }
  const hydgrp = Object.entries(hydgrpCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'B';

  return {
    muname:           components[0]?.muname || 'Unknown',
    compname:         components[0]?.compname || 'Unknown',
    texdesc,
    kfact:            weighted('kfact'),
    organicMatter:    weighted('om'),
    hydgrp,
    infiltrationRate: ksatMmHr,          // mm/hr (from Ksat)
    awc:              weighted('awc'),    // cm/cm
    slope:            weighted('slope'),
    sand, clay, silt,
    bulkDensity:      weighted('bulkDensity'),
    components,
  };
}

function parseSSURGOResponse(json) {
  // Falls back to simple parser structure
  return parseSimpleResponse(json);
}

function classifyTexture(sand, clay, silt) {
  if (clay >= 40) return 'Clay';
  if (sand >= 85) return 'Sand';
  if (silt >= 80) return 'Silt';
  if (clay >= 27 && sand >= 20 && sand <= 45) return 'Clay loam';
  if (clay >= 27 && sand < 20) return 'Silty clay loam';
  if (clay >= 35 && sand >= 45) return 'Sandy clay';
  if (sand >= 52 && clay < 20) return 'Sandy loam';
  if (silt >= 50 && clay < 27) return 'Silt loam';
  return 'Loam';
}
