/**
 * DEM (Digital Elevation Model) parsing and resampling.
 * Supports ASCII Grid, CSV, and JSON array formats.
 */

/**
 * Parse ASCII Grid format (ESRI).
 * Header: ncols, nrows, xllcorner, yllcorner, cellsize, NODATA_value
 * @param {string} text
 * @returns {{ elevations: number[], cols: number, rows: number } | null}
 */
export function parseAscGrid(text) {
  const lines = text.trim().split(/\r?\n/);
  const header = {};
  let dataStart = 0;
  for (let i = 0; i < lines.length; i++) {
    const parts = lines[i].split(/\s+/);
    if (parts.length >= 2 && /^-?\d/.test(parts[1])) {
      header[parts[0].toLowerCase()] = parseFloat(parts[1]);
      dataStart = i + 1;
    } else if (parts.length >= 2) {
      header[parts[0].toLowerCase()] = parts[1];
      dataStart = i + 1;
    }
  }
  const cols = Math.floor(header.ncols || header.ncol || 0);
  const rows = Math.floor(header.nrows || header.nrow || 0);
  const nodata = header.nodata_value ?? header.nodata ?? -9999;

  if (cols <= 0 || rows <= 0) return null;

  const values = [];
  for (let i = dataStart; i < lines.length; i++) {
    const parts = lines[i].trim().split(/\s+/);
    for (const p of parts) {
      const v = parseFloat(p);
      values.push(isNaN(v) || v === nodata ? NaN : v);
    }
  }

  if (values.length !== cols * rows) return null;
  const elevations = values.map(v => (isNaN(v) ? 0 : v));
  return { elevations, cols, rows };
}

/**
 * Parse CSV: one value per cell, row by row.
 * @param {string} text
 * @param {number} targetCols
 * @param {number} targetRows
 * @returns {number[] | null}
 */
export function parseCsv(text, targetCols, targetRows) {
  const lines = text.trim().split(/\r?\n/).filter(l => l);
  const values = [];
  let srcCols = 0;
  for (const line of lines) {
    const parts = line.split(/[,\s]+/).filter(p => p);
    if (parts.length > 0) {
      if (srcCols === 0) srcCols = parts.length;
      for (const p of parts) {
        const v = parseFloat(p);
        values.push(isNaN(v) ? 0 : v);
      }
    }
  }
  if (values.length === 0) return null;
  const srcRows = Math.ceil(values.length / srcCols);
  return resampleToGrid(values, srcCols, srcRows, targetCols, targetRows);
}

/**
 * Parse JSON: array of rows [[v,v,...],[v,v,...]] or flat [v,v,v,...]
 * @param {any} data
 * @param {number} targetCols
 * @param {number} targetRows
 * @returns {number[] | null}
 */
export function parseJsonElevations(data, targetCols, targetRows) {
  let values = [];
  if (Array.isArray(data)) {
    if (Array.isArray(data[0])) {
      for (const row of data) values.push(...row.map(v => Number(v) || 0));
    } else {
      values = data.map(v => Number(v) || 0);
    }
  }
  if (values.length === 0) return null;
  const srcCols = Array.isArray(data[0]) ? data[0].length : Math.ceil(Math.sqrt(values.length));
  const srcRows = Math.ceil(values.length / srcCols);
  return resampleToGrid(values, srcCols, srcRows, targetCols, targetRows);
}

/**
 * Resample elevation grid to target dimensions using bilinear interpolation.
 */
function resampleToGrid(src, srcCols, srcRows, targetCols, targetRows) {
  const out = new Float32Array(targetCols * targetRows);
  const getSrc = (i, j) => {
    const ii = Math.max(0, Math.min(i, srcRows - 1));
    const jj = Math.max(0, Math.min(j, srcCols - 1));
    return src[ii * srcCols + jj] ?? 0;
  };

  for (let i = 0; i < targetRows; i++) {
    for (let j = 0; j < targetCols; j++) {
      const si = (i / (targetRows - 1 || 1)) * (srcRows - 1);
      const sj = (j / (targetCols - 1 || 1)) * (srcCols - 1);
      const i0 = Math.floor(si);
      const j0 = Math.floor(sj);
      const fi = si - i0;
      const fj = sj - j0;
      const v00 = getSrc(i0, j0);
      const v01 = getSrc(i0, j0 + 1);
      const v10 = getSrc(i0 + 1, j0);
      const v11 = getSrc(i0 + 1, j0 + 1);
      const v = (1 - fi) * (1 - fj) * v00 + (1 - fi) * fj * v01 + fi * (1 - fj) * v10 + fi * fj * v11;
      out[i * targetCols + j] = v;
    }
  }
  return Array.from(out);
}

/**
 * Load DEM from file. Detects format by extension/content.
 * @param {File} file
 * @param {number} targetCols
 * @param {number} targetRows
 * @returns {Promise<Float32Array | null>}
 */
export async function loadDemFile(file, targetCols, targetRows) {
  const text = await file.text();
  let elevations = null;

  if (file.name.endsWith('.json')) {
    elevations = parseJsonElevations(JSON.parse(text), targetCols, targetRows);
  } else if (file.name.endsWith('.csv') || file.name.endsWith('.txt')) {
    elevations = parseCsv(text, targetCols, targetRows);
  } else if (file.name.endsWith('.asc') || file.name.endsWith('.grd') || text.trim().toLowerCase().startsWith('ncols')) {
    const parsed = parseAscGrid(text);
    if (parsed) {
      elevations = resampleToGrid(
        parsed.elevations,
        parsed.cols,
        parsed.rows,
        targetCols,
        targetRows
      );
    }
  } else {
    const parsed = parseAscGrid(text);
    if (parsed) {
      elevations = resampleToGrid(parsed.elevations, parsed.cols, parsed.rows, targetCols, targetRows);
    } else {
      elevations = parseCsv(text, targetCols, targetRows);
    }
  }

  if (!elevations) return null;
  return new Float32Array(elevations);
}
