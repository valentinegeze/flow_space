/**
 * state.js — Shared simulation state.
 *
 * Single source of truth replacing window.mosaicControls, window.loadParcelGrid,
 * and window.renderSimToCanvas globals.  All modules import from here.
 */

/**
 * simState.controls is populated by createUI() in ui.js during sketch setup.
 * simState.loadParcelGrid and simState.renderSimToCanvas are set by sketch.js
 * once the grid arrays exist.
 */
export const simState = {
  /** UI controls object — set once by sketch.js after createUI(). */
  controls: null,

  /**
   * Load a real-world patch grid from the Site Analysis module.
   * @type {((grid: Uint8Array) => void) | null}
   */
  loadParcelGrid: null,

  /**
   * Render the current simulation state onto an external canvas (64x64).
   * Used by parcel-analysis.js to create a live Leaflet image overlay.
   * @type {((canvas: HTMLCanvasElement) => void) | null}
   */
  renderSimToCanvas: null,
};
