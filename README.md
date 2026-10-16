# Radar Coverage

A small 3D map (CesiumJS) for placing radars and seeing where terrain blocks
their beam.

## Run it

Needs [Node.js](https://nodejs.org) 20 or newer.

1. Put a Cesium ion token in `src/app/config.ts` (free at
   https://ion.cesium.com/tokens). The 3D terrain will not load without it.
2. In this folder run:

   ```
   npm install
   npm start
   ```

3. Open http://localhost:4200

To make a static build instead: `npm run build` (output in `dist/RadarApp/browser`).

## Use it

- **Radars panel (top left):** `+ Add radar`, then click on the map to place it
  (Esc cancels). Click a radar in the list to select it, 🎯 to fly to it,
  ✕ / 🗑 Delete to remove it.
- **Radar Beam panel (top right):** opens for the selected radar. Set the beam
  angle, width, direction, range and mast height; choose the view (only this
  angle / 0° up to this angle, red-green rays / green + stop points); run an
  auto scan up to the angle where every direction clears; and switch on
  "Explain Blocking" to click any spot and see the line of sight to it.
- Clicking the black radar symbol on the map also selects that radar.

Radars and their settings are kept in the browser, so they are still there
after a reload.

## Files

- `src/app/radar/CesiumRadarCoverage.ts`: beam / terrain calculation and drawing
- `src/app/radar/CesiumLosProbe.ts`: "Explain Blocking" line of sight
- `src/app/radar/RadarRenderer.ts`: keeps the drawn beams in step with the radars
- `src/app/radar/radar-map.*`: the map, the Radars panel and the Radar Beam panel
- `src/app/config.ts`: Cesium ion token and start view
