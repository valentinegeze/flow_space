/**
 * fire-worker.js — Web Worker for off-thread fire simulation stepping.
 *
 * Receives fire state + grid data via postMessage (with Transferable buffers),
 * runs stepFire, and posts back the result (transferring buffers back).
 *
 * The worker reconstructs the internal double-buffer and burning set each call
 * since Sets and extra typed arrays can't be transferred. This is still far
 * cheaper than running stepFire on the main thread.
 */

import { FIRE, stepFire, buildParamsCache } from './fire.js';

// Persistent scratch buffers — allocated once, reused across messages.
let _nextCell = null;
let _nextAge = null;
let _attempted = null;
let _cachedParams = null;
let _lastPatchGridHash = 0;

self.onmessage = function(e) {
  const { cell, age, embers, patchGrid, patchKeys, patchParams,
          elevations, windAngleDeg, windSpeed, depths,
          cols, rows } = e.data;

  const n = cols * rows;

  // Allocate scratch buffers if needed (first call or grid size change)
  if (!_nextCell || _nextCell.length !== n) {
    _nextCell = new Uint8Array(n);
    _nextAge = new Uint8Array(n);
    _attempted = new Uint8Array(n);
  }

  // Rebuild params cache if patch grid changed.
  // Use a simple hash: sum of all patch indices (cheap, catches any edit).
  let hash = 0;
  for (let i = 0; i < n; i++) hash += patchGrid[i] * (i + 1);
  if (hash !== _lastPatchGridHash || !_cachedParams) {
    _cachedParams = buildParamsCache(patchGrid, patchKeys, patchParams, cols, rows);
    _lastPatchGridHash = hash;
  }

  // Rebuild the burning set from the cell array
  const burningCells = new Set();
  for (let i = 0; i < n; i++) {
    if (cell[i] === FIRE.BURNING) burningCells.add(i);
  }

  // Construct a fire state object compatible with stepFire
  const fs = {
    cell,
    age,
    _nextCell,
    _nextAge,
    _attempted,
    burningCells,
    embers: embers || [],
  };

  stepFire(fs, patchGrid, patchKeys, patchParams,
           elevations, windAngleDeg, windSpeed, depths,
           cols, rows, _cachedParams);

  // Keep scratch buffers for next call (they were swapped into fs._next*)
  _nextCell = fs._nextCell;
  _nextAge = fs._nextAge;

  // Transfer cell and age buffers back to main thread (zero-copy)
  self.postMessage({
    cell: fs.cell,
    age: fs.age,
    embers: fs.embers,
    burningCount: fs.burningCells.size,
  }, [fs.cell.buffer, fs.age.buffer]);
};
