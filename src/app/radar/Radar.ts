// One radar on the map. Its beam settings and look (range, width, angle,
// opacities, ...) live in `properties`, under the keys CesiumRadarCoverage
// reads (see CesiumRadarCoverage.beamOf / styleOf).
export interface Radar {
    id: string;
    name: string;
    longitude: number;
    latitude: number;
    properties: Record<string, any>;
}
