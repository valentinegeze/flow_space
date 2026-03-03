# Land Mosaic Flow Model

An interactive browser-based model that combines Richard T.T. Forman's patch-matrix-corridor framework with Manning's equation, overland flow physics, and particle-based sediment tracking.

## Running

A local HTTP server is required (CORS blocks file://):

```bash
cd mosaic-flow && python3 -m http.server 8000
```

Then open `http://localhost:8000`.

## Features

- **Patch brush**: Paint forest, wetland, urban, grassland, bare soil, or corridor patches
- **Physics**: Manning's equation for overland flow, infiltration by patch type, steepest-descent routing
- **Sediment particles**: Colored particles spawn in erodible patches, advect with flow, settle when velocity drops
- **Topography**: Choose **Simple slope** (user-defined direction and steepness) or **DEM file** (upload ASCII Grid, CSV, or JSON elevation data; resampled to 64×64)
- **Rainfall**: Adjust storm intensity (mm/hr)
- **Restore preset**: Replace ~30% of patches with wetland/forest to simulate restoration
- **Export/Import**: Save and share patch configurations as JSON

## Patch Types

| Type    | Manning n | Infiltration | Erodibility |
|---------|-----------|--------------|-------------|
| Grass   | 0.1       | 25 mm/hr     | 0.3         |
| Forest  | 0.3       | 50 mm/hr     | 0.05        |
| Wetland | 0.15      | 80 mm/hr     | 0.1         |
| Bare    | 0.03      | 5 mm/hr      | 0.9         |
| Urban   | 0.015     | 2 mm/hr      | 0.2         |
| Corridor| 0.03      | 15 mm/hr     | 0.4         |

## Stack

- p5.js for rendering
- Vanilla ES modules (no build step)
