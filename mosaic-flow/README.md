# Land Mosaic Flow Model

An interactive browser-based model that combines Richard T.T. Forman's patch-matrix-corridor framework with Manning's equation, overland flow physics, and particle-based sediment tracking.

**No installs required** — the app runs entirely in the browser as a static site. Works from GitHub Pages directly.

## Tabs

### Mosaic

The main simulation view. Draw patches on a 64x64 grid, adjust rainfall and topography, and watch overland flow with sediment particles.

**Cell selection and granular view**: Activate the Select Tool in the panel, then click to select a cell, shift-click to add to selection (max 16 cells), or click-drag to select a rectangle. Double-click to zoom into the tree-to-tree network view. If you've drawn a real parcel in Site Analysis, the network view automatically fetches trees and buildings from OpenStreetMap and displays a fire-spread graph with:
- Trees (green circles) sized by crown radius
- Buildings (tan squares) with border thickness proportional to vulnerability
- Edges weighted by spread probability (wind, slope, fuel continuity)
- Local φ indicator showing whether the neighborhood is above the percolation threshold

All data is fetched live from the Overpass API — no server or scripts needed. Wind changes reweight edges without re-fetching. Results are cached per bounding box.

The standalone percolation explorer (`percolation.html`) includes a **Load stream table data** button that overlays empirical data exported from the Stream Table tab onto the theoretical S-curve.

### Site Analysis

Geocode a location, draw a parcel on satellite imagery, and load real NLCD 2021 land cover data (or a synthetic fallback). Export data and optionally mirror the simulation on the map.

### Stream Table

Analyze EmRiver stream table videos directly in the browser. No server or Python needed.

1. **Load video** — drop a `.mov`, `.mp4`, or `.webm` file onto the tab
2. **Delineate table boundary** — click 4 corners to define the table edges. A perspective transform corrects for camera angle.
3. **Choose frame sampling** — set how many frames to analyze (10–200) and trim the time range
4. **Analyze** — a Web Worker processes each frame: perspective warp, channel mask, morphological opening, 4-connectivity union-find

The right column shows a channel formation timeline, metrics chart (coverage, largest channel, blob count), and a per-frame component map. Export as CSV or JSON for the Mosaic tab.

## Running

Serve the files with any static HTTP server:

```bash
cd mosaic-flow && python3 -m http.server 8000
```

Then open `http://localhost:8000`.

## Features

- **Patch brush**: Paint forest, wetland, urban, grassland, bare soil, corridor, or open water patches
- **Physics**: Manning's equation for overland flow, infiltration by patch type, steepest-descent routing
- **Sediment particles**: Colored particles spawn in erodible patches, advect with flow, settle when velocity drops
- **Topography**: Simple slope or DEM file upload
- **Granular view**: Use Select Tool to pick cells, double-click to zoom. Auto-fetches OSM trees and buildings for real parcels.
- **Stream table analysis**: In-browser video analysis with Web Worker, perspective correction, real-time channel metrics
- **Percolation explorer**: Standalone at `percolation.html` — order parameter φ, S-curve, fire/flood simulation

## Stack

- p5.js for rendering
- Vanilla ES modules (no build step for development; optional `build-standalone.js` for a single-file bundle)
- Leaflet + Leaflet.draw for Site Analysis
- Web Workers + Canvas API for stream table video analysis
- Overpass API for live tree/building data
