import * as Cesium from "cesium";

// =============================================================================
// Types
// =============================================================================

export interface RadarOptions {
    entityId: string;
    longitude: number;
    latitude: number;
    beam: BeamSettings;
    azimuthStepDeg?: number;
    style: RadarStyle;
}

// The one beam the radar sends out: a single sheet at one elevation angle,
// spread over the beam width (360 = every direction round the radar).
export interface BeamSettings {
    // Centre of the beam, degrees clockwise from north.
    azimuthDeg: number;
    // Horizontal width of the beam (360 = all round).
    widthDeg: number;
    range: number;
    // Elevation angle of the beam (0 = level with the antenna).
    elevationDeg: number;
    // Height above the terrain of the aircraft the LOS probe works out for.
    targetHeightAgl: number;
    // Antenna height above the ground it stands on.
    mastHeight: number;
}

// Settings that only change how the coverage looks. Applied in place through
// RadarCoverageHandle.setStyle, without re-sampling terrain or rebuilding.
export interface RadarStyle {
    // "Only this angle" mode: showReach shows the part of the beam that clears
    // the terrain (green), showBlocked the part stopped by it (red).
    // "0° up to this angle" mode: showReach shows the air and ground the
    // radar sees (green), showBlocked the air and ground hidden (red).
    beamOpacity: number;
    showReach: boolean;
    showBlocked: boolean;
    showLabels: boolean;
    // Also show every lower angle from 0° up to the beam (a solid fan).
    showLowerBeams: boolean;
    // "Only this angle" mode: draw the whole beam green and mark with red
    // points where each blocked ray meets the terrain.
    showStopPoints: boolean;
    // "Only this angle" mode: a thin line along every ray checked.
    showRays: boolean;
    // "0° up to this angle" mode: light shading and see-through drawing of
    // the solid figure, their strength (0-1) and opacity (0-1).
    volumeLit: boolean;
    volumeTransparent: boolean;
    volumeLight: number;
    volumeOpacity: number;
    // Ground footprint: green where the radar sees the ground, red where
    // terrain hides it (the same at every beam angle).
    showFootprint: boolean;
    footprintOpacity: number;
}

// One stretch of directions in which terrain stops the beam.
export interface BlockedSector {
    fromDeg: number;
    toDeg: number;
    widthDeg: number;
    // Closest point where the beam meets the terrain in this sector.
    nearestHitM: number;
    // Lowest beam angle that clears the terrain across the whole sector.
    clearDeg: number;
    // Every direction of the beam is blocked (no clear gap anywhere).
    allRound: boolean;
}

// What the beam at its current angle reaches, for the panel.
export interface BeamScanResult {
    elevationDeg: number;
    startDeg: number;
    widthDeg: number;
    range: number;
    // Share of directions where the beam runs the full range (0-100).
    clearPct: number;
    // Lowest beam angle at which every direction in the beam width is clear.
    allClearDeg: number;
    sectors: BlockedSector[];
    // Lowest clear angle per direction, binned across the beam width.
    horizon: { azDeg: number; clearDeg: number }[];
}

export interface RadarCoverageHandle {
    dispose(): void;
    setStyle?(style: RadarStyle): void;
    scan?: BeamScanResult;
}

type StyledHandle = RadarCoverageHandle & { setStyle(st: RadarStyle): void };

export interface ResolvedZone {
    name: string;
    color: Cesium.Color;
    range: number;
    minElevationDeg: number;
    maxElevationDeg: number;
    azimuthStartDeg: number;
    azimuthWidthDeg: number;
}

export interface RadarZoneConfig {
    name: string;
}

// What a built radar needs to answer "can it see this point, and if not, why?".
// Kept per radar entity for the click-to-explain probe (see CesiumLosProbe).
export interface RadarGeometry {
    radarPosition: Cesium.Cartesian3;
    radarHeight: number;
    enuMatrix: Cesium.Matrix4;
    zones: ResolvedZone[];
    targetHeightAgl: number;
}

interface TerrainProfile {
    horizontalDistances: number[];
    groundHeights: number[];
    groundPoints: Cesium.Cartographic[];
}

// Terrain seen from the antenna along one direction.
interface RayTrace {
    // Elevation angle (radians) from the antenna to the ground at each sample,
    // and the highest such angle up to and including that sample (-Infinity
    // next to the antenna, which never blocks). A ray at angle a meets the
    // terrain at the first sample where peakAngle >= a.
    groundAngle: Float32Array;
    peakAngle: Float32Array;
}

// An image draped on the terrain, and the area it covers.
interface ScoreImage {
    canvas: HTMLCanvasElement;
    rectangle: Cesium.Rectangle;
}

// Ground footprint: the seen (green) and hidden (red) ground as two images.
interface FootprintImages {
    seen: ScoreImage | null;
    hidden: ScoreImage | null;
}

// Every direction of the beam: row = direction, column = range sample.
interface RayGrid {
    zone: ResolvedZone;
    wrap: boolean;
    profiles: TerrainProfile[];
    rays: RayTrace[];
    // Azimuth of each row (degrees, unwrapped) and the spacing between rows.
    rowAz: number[];
    rowStepDeg: number;
    // Range samples (shared by every row), their spacing, and the last one
    // within the beam's range.
    dists: number[];
    spacing: number;
    lastCol: number;
    radarHeight: number;
}

// Where the beam ends in each direction.
interface BeamTips {
    dist: Float64Array;
    hit: Uint8Array;
    // Lowest clear angle (degrees) per direction.
    clearDeg: Float64Array;
}

// =============================================================================
// Defaults & tuning
// =============================================================================

const DEFAULT_TARGET_HEIGHT_AGL_M = 0;
// A radar with no mast set stands on a 10 m mast. With the antenna right on
// the terrain, every 2-3 m bump in the terrain data next to it tilts the
// horizon up by degrees and throws long false shadows.
const DEFAULT_MAST_HEIGHT_M = 10;

const DEFAULT_BEAM = { azimuthDeg: 0, widthDeg: 360, range: 20000, elevationDeg: 0 };

export const DEFAULT_RADAR_STYLE: RadarStyle = {
    beamOpacity: 0.25,
    showReach: true,
    showBlocked: true,
    showLabels: false,
    showLowerBeams: false,
    showStopPoints: false,
    showRays: false,
    volumeLit: true,
    volumeTransparent: true,
    volumeLight: 0.65,
    volumeOpacity: 0.45,
    showFootprint: false,
    footprintOpacity: 0.45
};

const CLEAR_RGB = [34, 197, 94];       // #22c55e  seen / beam runs the full range
const BLOCKED_RGB = [239, 68, 68];     // #ef4444  hidden / beam stopped by terrain
const CLEAR_COLOR = Cesium.Color.fromBytes(CLEAR_RGB[0], CLEAR_RGB[1], CLEAR_RGB[2]);
const BLOCKED_COLOR = Cesium.Color.fromBytes(BLOCKED_RGB[0], BLOCKED_RGB[1], BLOCKED_RGB[2]);

// World terrain is ~30 m detail in most mountain areas; sampling finer than
// this costs time without adding real accuracy.
const TERRAIN_SAMPLE_SPACING_M = 20;
// Directions across the beam when no azimuth step is set: about this many, but
// never closer than MIN_AZIMUTH_STEP_DEG or further apart than MAX_AZIMUTH_STEP_DEG.
const TARGET_RAYS_ACROSS_BEAM = 240;
const MIN_AZIMUTH_STEP_DEG = 0.1;
const MAX_AZIMUTH_STEP_DEG = 1;
// Terrain profiles kept from earlier builds (most recent last).
const PROFILE_CACHE_SIZE = 8;
// Standard radar "4/3 Earth" model: the atmosphere bends the beam slightly
// downward, so it reaches as if the Earth were 4/3 larger (flatter).
const EFFECTIVE_EARTH_RADIUS_M = 6371000 * 4 / 3;
// Ground closer than this to the antenna never blocks it (the antenna's own
// footing / cleared site; the terrain data is too coarse to trust here).
const NEAR_FIELD_IGNORE_M = 50;
// Terrain only blocks a point if it rises more than this above the straight
// line from the antenna to that point (smaller rises are terrain-data noise).
const RIDGE_TOLERANCE_M = 2;
// Beam sheet: at most this many directions, and points along each.
const BEAM_MESH_MAX_ROWS = 360;
const BEAM_RAY_POINTS = 40;
// Faint range rings on the beam, as fractions of the range.
const RANGE_RING_FRACTIONS = [0.25, 0.5, 0.75];
const RANGE_RING_COLOR = Cesium.Color.WHITE.withAlpha(0.35);
const RAY_LINE_COLOR = Cesium.Color.WHITE.withAlpha(0.5);
const STOP_POINT_PX = 6;
// "0° up to this angle" figures: points along each direction of the green
// (seen air) figure, and at most this many range samples along each
// direction of the red (hidden air) surface.
const VOLUME_POINTS = 160;
const SHADOW_VOLUME_POINTS = 400;
// Where the figure's bottom comes within this of the ground (the beam
// touching the terrain) it is left open, so the ground map shows.
const VOLUME_GROUND_CLEARANCE_M = 15;
// Step walls: drawn where a direction reaches further than its neighbour by
// more than STEP_MIN_M and STEP_FRACTION of its own length; their detail.
const STEP_MIN_M = 150;
const STEP_FRACTION = 0.1;
const STEP_WALL_POINTS = 24;
// Ground map of "0° up to this angle" mode: opacity of the green / red ground.
const GROUND_MAP_ALPHA = 0.85;
// Ground counts as seen when something this tall standing on it is seen. On
// flat land the ground lies right on the radar's horizon, and the terrain
// tiles there are off from each other by a few metres, which would otherwise
// paint whole tiles green or red (square patches) instead of following hills.
const GROUND_MAP_TARGET_HEIGHT_M = 3;
// Shading of the lit figure: how high above the horizon the light is.
const SHADE_LIGHT_UP = 0.5;
// Blocked sectors separated by a clear gap narrower than this are one sector
// in the panel list and map labels (the map shading keeps every gap).
const SECTOR_MERGE_GAP_DEG = 1;
// Map labels: the widest sectors only, none narrower than MIN_LABEL_WIDTH_DEG.
const MAX_SECTOR_LABELS = 6;
const MIN_LABEL_WIDTH_DEG = 3;
const LABEL_MIN_RANGE_FRACTION = 0.45;
// Bins of the horizon profile handed to the panel chart.
const HORIZON_BINS = 180;
// Footprint texture: largest side in pixels, and footprints kept from
// earlier builds (the angle slider and the scan reuse them).
const FOOTPRINT_TEXTURE_MAX_PX = 1024;
const FOOTPRINT_CACHE_SIZE = 4;
// Visibility scores are clamped to +-this (metres), so edges blend.
const SCORE_CLAMP_M = 25;

const norm360 = (deg: number) => ((deg % 360) + 360) % 360;

// Puts key last in the cache (most recently used), dropping the oldest
// entries beyond max.
function lruSet<K, V>(cache: Map<K, V>, key: K, value: V, max: number): void {
    cache.delete(key);
    cache.set(key, value);
    while (cache.size > max) cache.delete(cache.keys().next().value!);
}

// =============================================================================
// CesiumRadarCoverage: one beam at one angle, cut by terrain
// =============================================================================

export class CesiumRadarCoverage {
    // The radar's single beam, as a "zone" for the LOS probe.
    public static readonly DEFAULT_3D_ZONES: RadarZoneConfig[] = [{ name: "Beam" }];

    // Geometry of every built radar, keyed by entity id.
    private static readonly geometries = new Map<string, RadarGeometry>();
    private static readonly profileCache = new Map<string, { maxRange: number; profiles: TerrainProfile[] }>();
    private static readonly footprintCache = new Map<string, FootprintImages>();

    static getGeometry(entityId: string): RadarGeometry | undefined {
        return CesiumRadarCoverage.geometries.get(entityId);
    }

    static radarIds(): string[] {
        return Array.from(CesiumRadarCoverage.geometries.keys());
    }

    // Beam settings stored on a radar entity's properties. Older radars kept
    // the range per zone; that is used when no beam range is set.
    static beamOf(props: Record<string, any>): BeamSettings {
        return {
            azimuthDeg: props["beamAzimuthDeg"] ?? DEFAULT_BEAM.azimuthDeg,
            widthDeg: props["beamWidthDeg"] ?? DEFAULT_BEAM.widthDeg,
            range: props["beamRange"] ?? props["zoneRanges"]?.["Coverage Zone"] ?? DEFAULT_BEAM.range,
            // The beam angle runs from 0° (level) up; older radars may have a negative one saved.
            elevationDeg: Math.max(0, props["beamElevationDeg"] ?? DEFAULT_BEAM.elevationDeg),
            targetHeightAgl: props["targetHeightAgl"] ?? DEFAULT_TARGET_HEIGHT_AGL_M,
            mastHeight: props["antennaMastHeight"] ?? DEFAULT_MAST_HEIGHT_M
        };
    }

    // Look settings stored on a radar entity's properties (same key names).
    static styleOf(props: Record<string, any>): RadarStyle {
        const style: Record<string, unknown> = {};
        for (const [key, fallback] of Object.entries(DEFAULT_RADAR_STYLE)) style[key] = props[key] ?? fallback;
        // Footprint by default: on in "0° up to this angle", off in "Only this angle".
        style["showFootprint"] = props["showFootprint"] ?? style["showLowerBeams"];
        return style as unknown as RadarStyle;
    }

    // -------------------------------------------------------------------
    // 1. Main entry point
    // -------------------------------------------------------------------
    static async create3DRadarZones(
        viewer: Cesium.Viewer,
        terrainProvider: Cesium.TerrainProvider,
        options: RadarOptions
    ): Promise<RadarCoverageHandle[]> {
        // Anything already drawn is removed again if the build fails part way,
        // so a failed build never leaves pieces of itself on the map.
        const handles: RadarCoverageHandle[] = [];
        try {
            await CesiumRadarCoverage.buildInto(viewer, terrainProvider, options, handles);
            return handles;
        } catch (err) {
            for (const handle of handles) handle.dispose();
            throw err;
        }
    }

    private static async buildInto(
        viewer: Cesium.Viewer,
        terrainProvider: Cesium.TerrainProvider,
        options: RadarOptions,
        handles: RadarCoverageHandle[]
    ): Promise<void> {
        const { entityId, longitude, latitude, beam: beamSettings } = options;

        // Ground polylines are built synchronously, so the old coverage is only
        // swapped out once the new one is ready to draw (no flicker while scanning).
        await Cesium.GroundPolylinePrimitive.initializeTerrainHeights();

        const [sampled] = await Cesium.sampleTerrainMostDetailed(terrainProvider,
            [Cesium.Cartographic.fromDegrees(longitude, latitude)]);
        const radarHeight = (sampled.height ?? 0) + Math.max(0, beamSettings.mastHeight);
        const radarPosition = Cesium.Cartesian3.fromDegrees(longitude, latitude, radarHeight);
        const enuMatrix = Cesium.Transforms.eastNorthUpToFixedFrame(radarPosition);

        // Emitter marker. Clicking it always selects the radar, even with the LOS probe on.
        const marker = viewer.entities.add({
            position: radarPosition,
            point: {
                pixelSize: 16,
                color: Cesium.Color.BLACK,
                outlineColor: Cesium.Color.WHITE,
                outlineWidth: 3,
                disableDepthTestDistance: Number.POSITIVE_INFINITY
            }
        });
        Object.assign(marker, { radarParentId: entityId, isRadarMarker: true });
        handles.push({ dispose: () => viewer.entities.remove(marker) });

        // The beam
        const elevationDeg = beamSettings.elevationDeg;
        const widthDeg = Cesium.Math.clamp(beamSettings.widthDeg, 1, 360);
        const wrap = widthDeg >= 360;
        const zone: ResolvedZone = {
            name: "Beam",
            color: CLEAR_COLOR,
            range: Math.max(100, beamSettings.range),
            minElevationDeg: elevationDeg,
            maxElevationDeg: elevationDeg,
            azimuthStartDeg: wrap ? 0 : beamSettings.azimuthDeg - widthDeg / 2,
            azimuthWidthDeg: widthDeg
        };

        const geometry: RadarGeometry = {
            radarPosition, radarHeight, enuMatrix, zones: [zone],
            targetHeightAgl: Math.max(0, beamSettings.targetHeightAgl)
        };
        const geometries = CesiumRadarCoverage.geometries;
        geometries.set(entityId, geometry);
        handles.push({
            dispose: () => {
                // A newer build of the same radar may already have replaced it.
                if (geometries.get(entityId) === geometry) geometries.delete(entityId);
            }
        });

        // Terrain along every direction of the beam (cached: changing only the
        // angle reuses it, which is what keeps the angle slider and scan live).
        const azimuthStepDeg = options.azimuthStepDeg ?? Cesium.Math.clamp(
            widthDeg / TARGET_RAYS_ACROSS_BEAM, MIN_AZIMUTH_STEP_DEG, MAX_AZIMUTH_STEP_DEG);
        const profiles = await CesiumRadarCoverage.getTerrainProfiles(
            terrainProvider,
            `${longitude}|${latitude}|${zone.azimuthStartDeg}|${widthDeg}|${azimuthStepDeg}`,
            radarPosition,
            enuMatrix,
            CesiumRadarCoverage.buildAzimuthList(zone.azimuthStartDeg, widthDeg, azimuthStepDeg),
            zone.range
        );

        const rows = profiles.length;
        const rowStepDeg = wrap ? 360 / rows : widthDeg / Math.max(1, rows - 1);
        const dists = profiles[0].horizontalDistances;
        let lastCol = dists.length - 1;
        while (lastCol > 0 && dists[lastCol] > zone.range) lastCol--;
        const grid: RayGrid = {
            zone,
            wrap,
            profiles,
            rays: profiles.map(p => CesiumRadarCoverage.traceRay(p, radarHeight)),
            rowAz: profiles.map((_, r) => zone.azimuthStartDeg + rowStepDeg * r),
            rowStepDeg,
            dists,
            spacing: dists.length > 1 ? dists[1] - dists[0] : TERRAIN_SAMPLE_SPACING_M,
            lastCol,
            radarHeight
        };

        // Where the beam ends in every direction.
        const angle = Cesium.Math.toRadians(elevationDeg);
        const tips: BeamTips = {
            dist: new Float64Array(rows),
            hit: new Uint8Array(rows),
            clearDeg: new Float64Array(rows)
        };
        for (let r = 0; r < rows; r++) {
            const tip = CesiumRadarCoverage.rayTip(grid, r, angle);
            tips.dist[r] = tip.dist;
            tips.hit[r] = tip.hit ? 1 : 0;
            const peak = grid.rays[r].peakAngle[lastCol];
            tips.clearDeg[r] = Number.isFinite(peak) ? Cesium.Math.toDegrees(peak) : -90;
        }
        const scan = CesiumRadarCoverage.summarise(grid, tips, elevationDeg);

        const parts = [
            CesiumRadarCoverage.buildBeam(viewer, grid, tips, angle),
            CesiumRadarCoverage.buildLowerBeams(viewer, grid, tips, angle),
            CesiumRadarCoverage.buildGroundMap(viewer, grid, tips, longitude, latitude),
            CesiumRadarCoverage.buildFootprint(viewer, grid, tips, longitude, latitude,
                `${longitude}|${latitude}|${radarHeight}|${zone.azimuthStartDeg}|${widthDeg}|${zone.range}|${rows}|${elevationDeg}`),
            CesiumRadarCoverage.buildSectorLabels(viewer, grid, tips, scan.sectors),
            CesiumRadarCoverage.buildClearLabel(viewer, radarPosition, scan)
        ];
        handles.push(...parts);

        const applyStyle = (st: RadarStyle) => {
            for (const part of parts) part.setStyle(st);
            viewer.scene.requestRender();
        };
        applyStyle(options.style);
        handles.push({ dispose: () => { }, setStyle: applyStyle, scan });
    }

    // -------------------------------------------------------------------
    // 2. Terrain seen along one direction
    // -------------------------------------------------------------------
    // peakAngle is the steepest line from the antenna that still touches
    // terrain so far (less the small-rise tolerance), so a ray at angle a runs
    // the full range exactly when a > peakAngle at the last sample.
    private static traceRay(profile: TerrainProfile, radarHeight: number): RayTrace {
        const { horizontalDistances: dists, groundHeights } = profile;
        const n = dists.length;
        const groundAngle = new Float32Array(n).fill(-Math.PI / 2);
        const peakAngle = new Float32Array(n).fill(-Infinity);
        for (let i = 1; i < n; i++) {
            const d = dists[i];
            groundAngle[i] = CesiumRadarCoverage.elevationAngle(groundHeights[i], d, radarHeight);
            peakAngle[i] = d < NEAR_FIELD_IGNORE_M
                ? peakAngle[i - 1]
                : Math.max(peakAngle[i - 1], Math.atan(CesiumRadarCoverage.horizonTan(groundAngle[i], d)));
        }
        return { groundAngle, peakAngle };
    }

    // Where a ray at `angle` (radians) along grid row r first meets the
    // terrain: binary search on the running highest ground angle, then the
    // exact crossing between that sample and the one before. hit = false:
    // the ray stays above the terrain out to the full range.
    private static rayTip(grid: RayGrid, r: number, angle: number): { dist: number; hit: boolean } {
        const { peakAngle, groundAngle } = grid.rays[r];
        const { dists, lastCol } = grid;
        if (!(peakAngle[lastCol] >= angle)) return { dist: dists[lastCol], hit: false };
        let lo = 1, hi = lastCol;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (peakAngle[mid] >= angle) hi = mid;
            else lo = mid + 1;
        }
        const a0 = groundAngle[lo - 1], a1 = groundAngle[lo];
        const t = a1 > a0 ? Cesium.Math.clamp((angle - a0) / (a1 - a0), 0, 1) : 0;
        return { dist: dists[lo - 1] + (dists[lo] - dists[lo - 1]) * t, hit: true };
    }

    // Ground point (lon, lat in radians, terrain height) at a distance along grid row r.
    private static groundAt(grid: RayGrid, r: number, d: number) {
        const { groundHeights: heights, groundPoints: pts } = grid.profiles[r];
        const f = Math.min(Math.max(0, d) / grid.spacing, grid.lastCol);
        const i0 = Math.floor(f), i1 = Math.min(i0 + 1, grid.lastCol), u = f - i0;
        return {
            lon: pts[i0].longitude + (pts[i1].longitude - pts[i0].longitude) * u,
            lat: pts[i0].latitude + (pts[i1].latitude - pts[i0].latitude) * u,
            height: heights[i0] + (heights[i1] - heights[i0]) * u
        };
    }

    // Grid rows drawn as mesh directions (at most BEAM_MESH_MAX_ROWS).
    private static meshRows(grid: RayGrid): number[] {
        const rows = grid.profiles.length;
        const R = Math.min(rows, BEAM_MESH_MAX_ROWS);
        return Array.from({ length: R }, (_, k) => grid.wrap
            ? Math.floor((k * rows) / R)
            : Math.round((k * (rows - 1)) / Math.max(1, R - 1)));
    }

    // -------------------------------------------------------------------
    // 3. Blocked stretches of directions, and the panel summary
    // -------------------------------------------------------------------
    // Contiguous rows whose ray meets the terrain, as [first, last] row. On an
    // all-round beam a run may wrap past the last row (last < first), and a
    // beam blocked all round is one run [0, rows - 1].
    private static blockedRuns(hit: Uint8Array, wrap: boolean): [number, number][] {
        const rows = hit.length;
        const runs: [number, number][] = [];
        let r = 0;
        while (r < rows) {
            if (!hit[r]) { r++; continue; }
            const from = r;
            while (r < rows && hit[r]) r++;
            runs.push([from, r - 1]);
        }
        if (wrap && runs.length > 1 && runs[0][0] === 0 && runs[runs.length - 1][1] === rows - 1) {
            const last = runs.pop()!;
            runs[0] = [last[0], runs[0][1]];
        }
        return runs;
    }

    // Blocked sectors (small clear gaps merged), how much of the beam is
    // clear, and the lowest angle that clears every direction.
    private static summarise(grid: RayGrid, tips: BeamTips, elevationDeg: number): BeamScanResult {
        const rows = tips.hit.length;
        const { zone, rowAz, rowStepDeg } = grid;

        // Merge runs separated by a narrow clear gap.
        const maxGapRows = Math.max(0, Math.floor(SECTOR_MERGE_GAP_DEG / rowStepDeg));
        const merged: [number, number][] = [];
        for (const run of CesiumRadarCoverage.blockedRuns(tips.hit, grid.wrap)) {
            const prev = merged[merged.length - 1];
            if (prev && run[0] - prev[1] - 1 <= maxGapRows && run[0] > prev[1]) prev[1] = run[1];
            else merged.push([run[0], run[1]]);
        }
        if (grid.wrap && merged.length > 1) {
            const first = merged[0], last = merged[merged.length - 1];
            const gap = (first[0] - last[1] - 1 + rows) % rows;
            if (last[1] >= last[0] && gap <= maxGapRows) {
                merged.pop();
                merged[0] = [last[0], first[1]];
            }
        }

        const sectors: BlockedSector[] = merged.map(([from, to]) => {
            const count = to >= from ? to - from + 1 : rows - from + to + 1;
            const rs = Array.from({ length: count }, (_, k) => (from + k) % rows);
            let nearest = Infinity, clear = -90;
            for (const r of rs) {
                if (tips.hit[r]) nearest = Math.min(nearest, tips.dist[r]);
                clear = Math.max(clear, tips.clearDeg[r]);
            }
            return {
                fromDeg: norm360(rowAz[from] - rowStepDeg / 2),
                toDeg: norm360(rowAz[to] + rowStepDeg / 2),
                widthDeg: Math.min(zone.azimuthWidthDeg, rs.length * rowStepDeg),
                nearestHitM: nearest,
                clearDeg: clear,
                // Merging small gaps can make a sector wrap all the way round;
                // it is only "all round" when no direction in it is clear.
                allRound: grid.wrap && rs.length >= rows && rs.every(r => tips.hit[r])
            };
        });
        sectors.sort((a, b) => b.widthDeg - a.widthDeg);

        let blockedRows = 0, allClear = -90;
        for (let r = 0; r < rows; r++) {
            blockedRows += tips.hit[r];
            allClear = Math.max(allClear, tips.clearDeg[r]);
        }

        // Horizon profile, binned (highest clear angle in each bin).
        const bins = Math.min(HORIZON_BINS, rows);
        const horizon = Array.from({ length: bins }, (_, b) => {
            const r0 = Math.floor((b * rows) / bins), r1 = Math.floor(((b + 1) * rows) / bins);
            let c = -90;
            for (let r = r0; r < Math.max(r1, r0 + 1); r++) c = Math.max(c, tips.clearDeg[r]);
            return { azDeg: rowAz[Math.min(rows - 1, Math.floor((r0 + r1) / 2))], clearDeg: c };
        });

        return {
            elevationDeg,
            startDeg: zone.azimuthStartDeg,
            widthDeg: zone.azimuthWidthDeg,
            range: zone.range,
            clearPct: (100 * (rows - blockedRows)) / rows,
            allClearDeg: allClear,
            sectors,
            horizon
        };
    }

    // -------------------------------------------------------------------
    // 4. The beam sheet ("Only this angle")
    // -------------------------------------------------------------------
    // One surface at the beam's angle: every direction's ray runs out until
    // it meets the terrain or to the full range. Directions that run the full
    // range are green, directions stopped by terrain are red; red always
    // ends on the hill that stops it.
    private static buildBeam(
        viewer: Cesium.Viewer,
        grid: RayGrid,
        tips: BeamTips,
        angle: number
    ): StyledHandle {
        const { wrap } = grid;
        const rows = grid.profiles.length;
        const rowIdx = CesiumRadarCoverage.meshRows(grid);
        const R = rowIdx.length;
        const C = BEAM_RAY_POINTS;

        const heightAt = (row: number, d: number, groundH: number) =>
            tips.hit[row] && d >= tips.dist[row] ? groundH : CesiumRadarCoverage.beamHeightAt(angle, d, grid.radarHeight);
        const rayPoint = (row: number, d: number) => {
            const g = CesiumRadarCoverage.groundAt(grid, row, d);
            return Cesium.Cartesian3.fromRadians(g.lon, g.lat, heightAt(row, d, g.height));
        };
        const tipOf = (row: number) => rayPoint(row, tips.dist[row]);
        const alongRay = (row: number) => Array.from({ length: C }, (_, j) => rayPoint(row, (tips.dist[row] * j) / (C - 1)));

        // Each direction is its own slice, reaching half way to its
        // neighbours and ending exactly where its own ray ends. (Joining
        // neighbouring rays instead stretched a strip from a short, blocked
        // ray out to a long, clear one: red wedges running past the hill.)
        const prevOf = (k: number) => wrap ? (k - 1 + R) % R : k - 1;
        const nextOf = (k: number) => wrap ? (k + 1) % R : (k + 1 < R ? k + 1 : -1);
        // Point of slice k at distance d on its edge towards neighbour n, or
        // on the direction itself for an outer edge of the beam (n < 0).
        const edgePoint = (k: number, n: number, d: number) => {
            const row = rowIdx[k];
            const g = CesiumRadarCoverage.groundAt(grid, row, d);
            const h = heightAt(row, d, g.height);
            if (n < 0) return Cesium.Cartesian3.fromRadians(g.lon, g.lat, h);
            const o = CesiumRadarCoverage.groundAt(grid, rowIdx[n], d);
            return Cesium.Cartesian3.fromRadians((g.lon + o.lon) / 2, (g.lat + o.lat) / 2, h);
        };
        const edgeTip = (k: number, n: number) => edgePoint(k, n, tips.dist[rowIdx[k]]);

        // Slice k: left edge at vertices 2kC.., right edge at (2k + 1)C..
        const positions = new Float64Array(R * 2 * C * 3);
        const clearIndices: number[] = [];
        const blockedIndices: number[] = [];
        for (let k = 0; k < R; k++) {
            const dist = tips.dist[rowIdx[k]];
            [prevOf(k), nextOf(k)].forEach((n, side) => {
                for (let j = 0; j < C; j++) {
                    const p = edgePoint(k, n, (dist * j) / (C - 1));
                    positions.set([p.x, p.y, p.z], ((2 * k + side) * C + j) * 3);
                }
            });
            const target = tips.hit[rowIdx[k]] ? blockedIndices : clearIndices;
            const l = 2 * k * C, r = l + C;
            for (let j = 0; j < C - 1; j++) target.push(l + j, l + j + 1, r + j, l + j + 1, r + j + 1, r + j);
        }
        const boundingSphere = Cesium.BoundingSphere.fromVertices(Array.from(positions));

        const primitives = viewer.scene.primitives;
        const lineSet = () => primitives.add(new Cesium.PolylineCollection()) as Cesium.PolylineCollection;
        // Every polyline needs its own material: a PolylineCollection destroys
        // each line's material when it is removed, so a shared one would be
        // destroyed twice and throw, leaving the rest of the old beam behind.
        const addLine = (set: Cesium.PolylineCollection, pts: Cesium.Cartesian3[], width: number, color: Cesium.Color) =>
            set.add({ positions: pts, width, material: Cesium.Material.fromType("Color", { color }) });

        // Tip line along the end of each stretch of same-state slices: clear
        // (green, in the air) and blocked (red, on the terrain), plus the
        // blocked ones in green for the stop-points view. A red line never
        // joins a green one, so no line runs across from a hill to full range.
        const tipLines = lineSet();
        const hitTipLines = lineSet();
        const hitTipLinesGreen = lineSet();
        const state = (k: number) => tips.hit[rowIdx[k]];
        // On an all-round beam start at a change of state, so no stretch is split.
        let start = 0;
        if (wrap) {
            while (start < R && state(start) === state((start - 1 + R) % R)) start++;
            if (start === R) start = 0;
        }
        const allSame = wrap && rowIdx.every((_, k) => state(k) === state(0));
        for (let i = 0; i < R;) {
            const k0 = (start + i) % R, st = state(k0);
            const pts: Cesium.Cartesian3[] = [];
            while (i < R && state((start + i) % R) === st) {
                const k = (start + i) % R;
                pts.push(edgeTip(k, prevOf(k)), edgeTip(k, nextOf(k)));
                i++;
            }
            if (allSame) pts.push(pts[0]);
            if (st) {
                addLine(hitTipLines, pts, 2.5, BLOCKED_COLOR);
                addLine(hitTipLinesGreen, pts, 2.5, CLEAR_COLOR);
            } else {
                addLine(tipLines, pts, 2.5, CLEAR_COLOR);
            }
        }
        // Range rings: drawn only over directions the beam reaches that far.
        for (const fraction of RANGE_RING_FRACTIONS) {
            const d = grid.zone.range * fraction;
            let ring: Cesium.Cartesian3[] = [];
            const flush = () => {
                if (ring.length >= 2) addLine(tipLines, ring, 1, RANGE_RING_COLOR);
                ring = [];
            };
            for (let k = 0; k <= (wrap ? R : R - 1); k++) {
                const row = rowIdx[k % R];
                if (tips.dist[row] >= d) ring.push(rayPoint(row, d));
                else flush();
            }
            flush();
        }
        // Side edges (beam < 360°).
        if (!wrap) {
            for (const row of [rowIdx[0], rowIdx[R - 1]]) addLine(tipLines, alongRay(row), 1.5, CLEAR_COLOR);
        }

        // Every ray checked, from the antenna to where it ends. Rays that run
        // the full range go with the green, stopped ones with the red.
        const clearRays = lineSet();
        const blockedRays = lineSet();
        for (let row = 0; row < rows; row++) {
            addLine(tips.hit[row] ? blockedRays : clearRays, [rayPoint(row, 0), tipOf(row)], 1, RAY_LINE_COLOR);
        }

        // Stop points: where every blocked direction (all rows, not just the
        // mesh rows) meets the terrain. Drawn over the terrain so a point
        // on the hillside is never half buried in it.
        const stopPoints = primitives.add(new Cesium.PointPrimitiveCollection()) as Cesium.PointPrimitiveCollection;
        for (let row = 0; row < rows; row++) {
            if (!tips.hit[row]) continue;
            stopPoints.add({
                position: tipOf(row),
                pixelSize: STOP_POINT_PX,
                color: BLOCKED_COLOR,
                outlineColor: Cesium.Color.BLACK.withAlpha(0.6),
                outlineWidth: 1,
                disableDepthTestDistance: Number.POSITIVE_INFINITY
            });
        }

        const clearMesh = CesiumRadarCoverage.coloredMesh(viewer, positions, clearIndices, boundingSphere);
        const blockedMesh = CesiumRadarCoverage.coloredMesh(viewer, positions, blockedIndices, boundingSphere);
        const collections = [tipLines, hitTipLines, hitTipLinesGreen, stopPoints, clearRays, blockedRays];

        return {
            dispose: () => {
                clearMesh.dispose();
                blockedMesh.dispose();
                for (const c of collections) primitives.remove(c);
            },
            // Show green = the part of the beam that clears the terrain, Show
            // red = the part stopped by it. Stop-points view: Show green = the
            // whole beam (green), Show red = red points where blocked rays
            // meet the terrain.
            setStyle: (st: RadarStyle) => {
                const thisAngle = !st.showLowerBeams;
                const points = thisAngle && st.showStopPoints;
                const opacity = Cesium.Math.clamp(st.beamOpacity, 0, 1);
                clearMesh.draw(thisAngle && st.showReach ? opacity : 0, CLEAR_RGB);
                blockedMesh.draw(points
                    ? (st.showReach ? opacity : 0)
                    : (thisAngle && st.showBlocked ? opacity : 0), points ? CLEAR_RGB : BLOCKED_RGB);
                tipLines.show = thisAngle && st.showReach;
                hitTipLines.show = thisAngle && !points && st.showBlocked;
                hitTipLinesGreen.show = points && st.showReach;
                stopPoints.show = points && st.showBlocked;
                clearRays.show = thisAngle && st.showRays && st.showReach;
                blockedRays.show = thisAngle && st.showRays && (points ? st.showReach : st.showBlocked);
            }
        };
    }

    // A one-colour triangle mesh, rebuilt only when its opacity, colour or
    // shading changes.
    private static coloredMesh(
        viewer: Cesium.Viewer,
        positions: Float64Array,
        indices: number[],
        boundingSphere: Cesium.BoundingSphere
    ): { draw(opacity: number, rgb: number[], light?: number): void; dispose(): void } {
        const vertexCount = positions.length / 3;
        const indexArray = new Uint32Array(indices);
        let primitive: Cesium.Primitive | null = null;
        let builtKey = "";
        let disposed = false;
        const remove = () => {
            if (primitive) viewer.scene.primitives.remove(primitive);
            primitive = null;
        };
        return {
            dispose: () => {
                disposed = true;
                remove();
            },
            // opacity 1: fully opaque. light: strength of the shading, 0 = flat.
            draw: (opacity: number, rgb: number[], light = 0) => {
                const key = `${opacity}|${rgb}|${light}`;
                if (disposed || key === builtKey) return;
                builtKey = key;
                remove();
                if (indexArray.length === 0 || opacity <= 0) return;
                const solid = opacity >= 1;
                const alpha = solid ? 255 : Math.round(255 * opacity);
                const colors = new Uint8Array(vertexCount * 4);
                for (let v = 0; v < vertexCount; v++) colors.set([rgb[0], rgb[1], rgb[2], alpha], v * 4);
                const geometry = new Cesium.Geometry({
                    attributes: {
                        position: new Cesium.GeometryAttribute({
                            componentDatatype: Cesium.ComponentDatatype.DOUBLE,
                            componentsPerAttribute: 3,
                            values: positions
                        }),
                        // Per-vertex colour, read by PerInstanceColorAppearance's "color" input.
                        color: new Cesium.GeometryAttribute({
                            componentDatatype: Cesium.ComponentDatatype.UNSIGNED_BYTE,
                            componentsPerAttribute: 4,
                            normalize: true,
                            values: colors
                        })
                    } as any,
                    indices: indexArray,
                    primitiveType: Cesium.PrimitiveType.TRIANGLES,
                    boundingSphere
                });
                if (light > 0) CesiumRadarCoverage.shadeColors(geometry, colors, boundingSphere.center, light);
                primitive = viewer.scene.primitives.add(new Cesium.Primitive({
                    geometryInstances: new Cesium.GeometryInstance({ geometry }),
                    appearance: new Cesium.PerInstanceColorAppearance({ flat: true, translucent: !solid, closed: false }),
                    asynchronous: false
                })) as Cesium.Primitive;
            }
        };
    }

    // Darkens or brightens each vertex colour by how its face turns to a
    // fixed light (above the radar, a little to the south-east). Uses the
    // absolute angle, so both sides of a face are lit alike.
    private static shadeColors(geometry: Cesium.Geometry, colors: Uint8Array, center: Cesium.Cartesian3, strength: number): void {
        Cesium.GeometryPipeline.computeNormal(geometry);
        const normals = (geometry.attributes as any).normal.values as Float32Array;
        delete (geometry.attributes as any).normal;

        const C3 = Cesium.Cartesian3;
        const up = C3.normalize(center, new C3());
        const east = C3.normalize(C3.cross(C3.UNIT_Z, up, new C3()), new C3());
        const north = C3.cross(up, east, new C3());
        const light = new C3(
            SHADE_LIGHT_UP * up.x + 0.6 * east.x - 0.45 * north.x,
            SHADE_LIGHT_UP * up.y + 0.6 * east.y - 0.45 * north.y,
            SHADE_LIGHT_UP * up.z + 0.6 * east.z - 0.45 * north.z);
        C3.normalize(light, light);

        for (let v = 0; v < colors.length / 4; v++) {
            const dot = Math.abs(normals[v * 3] * light.x + normals[v * 3 + 1] * light.y + normals[v * 3 + 2] * light.z);
            // A face turned away keeps (1 - strength) of its colour.
            const f = 1 - strength + strength * (Number.isFinite(dot) ? dot : 1);
            for (let c = 0; c < 3; c++) colors[v * 4 + c] = Math.min(255, Math.round(colors[v * 4 + c] * f));
        }
    }

    // -------------------------------------------------------------------
    // 5. Every angle from the terrain up to the beam ("0° up to this angle")
    // -------------------------------------------------------------------
    // The airspace between the terrain and the beam's angle, as two solid
    // figures built one slice per direction (each slice spans half way to its
    // neighbours). At every distance the line of sight over the highest
    // terrain so far splits the air:
    //   green (seen):   from that line (or the ground) up to the ray at the
    //                   beam's angle. A slice ends where that ray meets the
    //                   terrain, or with an end wall at the full range; step
    //                   walls close steps between neighbours. Its bottom is
    //                   left open where it lies on the ground.
    //   red (hidden):   from the ground up to that line (see shadowSurface).
    private static buildLowerBeams(
        viewer: Cesium.Viewer,
        grid: RayGrid,
        tips: BeamTips,
        topAngle: number
    ): StyledHandle {
        const { wrap, rays, spacing, lastCol, radarHeight } = grid;
        const rowIdx = CesiumRadarCoverage.meshRows(grid);
        const R = rowIdx.length;
        // Where each green slice ends (the top ray), and whether on the terrain.
        const end = rowIdx.map(row => tips.dist[row]);
        const prevOf = (r: number) => wrap ? (r - 1 + R) % R : r - 1;
        const nextOf = (r: number) => wrap ? (r + 1) % R : (r + 1 < R ? r + 1 : -1);

        const groundH = (r: number, d: number) => CesiumRadarCoverage.groundAt(grid, rowIdx[r], d).height;
        const topAt = (d: number) => CesiumRadarCoverage.beamHeightAt(topAngle, d, radarHeight);
        // Line of sight over the highest terrain so far along slice r.
        const sightAt = (r: number, d: number) => {
            const peak = rays[rowIdx[r]].peakAngle[Math.min(lastCol, Math.round(d / spacing))];
            return Number.isFinite(peak) ? CesiumRadarCoverage.beamHeightAt(peak, d, radarHeight) : -Infinity;
        };
        // Bottom of the seen air: the line of sight, never below the ground nor above the top.
        const bottomAt = (r: number, d: number) => Math.min(topAt(d), Math.max(groundH(r, d), sightAt(r, d)));
        // Point of slice r at distance d and height h, on its edge towards
        // neighbour n (half way between the two), or on the direction itself (n < 0).
        const point = (r: number, n: number, d: number, h: number) => {
            const a = CesiumRadarCoverage.groundAt(grid, rowIdx[r], d);
            if (n < 0) return Cesium.Cartesian3.fromRadians(a.lon, a.lat, h);
            const b = CesiumRadarCoverage.groundAt(grid, rowIdx[n], d);
            return Cesium.Cartesian3.fromRadians((a.lon + b.lon) / 2, (a.lat + b.lat) / 2, h);
        };

        // Quads between two rows of points; keep(i) false leaves out the quad
        // between points i and i + 1.
        const positions: number[] = [];
        const indices: number[] = [];
        const vertex = (p: Cesium.Cartesian3) => {
            positions.push(p.x, p.y, p.z);
            return positions.length / 3 - 1;
        };
        const strip = (a: Cesium.Cartesian3[], b: Cesium.Cartesian3[], keep: (i: number) => boolean = () => true) => {
            const ia = a.map(vertex);
            const ib = b.map(vertex);
            for (let i = 0; i < a.length - 1; i++) {
                if (keep(i)) indices.push(ia[i], ia[i + 1], ib[i], ia[i + 1], ib[i + 1], ib[i]);
            }
        };

        for (let r = 0; r < R; r++) {
            const left = prevOf(r), right = nextOf(r);
            const ds = Array.from({ length: VOLUME_POINTS }, (_, j) => (end[r] * j) / (VOLUME_POINTS - 1));
            const tops = ds.map(topAt);
            const bottoms = ds.map(d => bottomAt(r, d));
            const nearGround = ds.map((d, j) => bottoms[j] - groundH(r, d) < VOLUME_GROUND_CLEARANCE_M);

            // Top, and bottom (open where it lies on the ground).
            strip(ds.map((d, j) => point(r, left, d, tops[j])), ds.map((d, j) => point(r, right, d, tops[j])));
            strip(ds.map((d, j) => point(r, left, d, bottoms[j])), ds.map((d, j) => point(r, right, d, bottoms[j])),
                j => !(nearGround[j] && nearGround[j + 1]));

            // End wall at the full range.
            if (!tips.hit[rowIdx[r]]) {
                const d = end[r], b = bottoms[bottoms.length - 1], t = tops[tops.length - 1];
                strip([point(r, left, d, b), point(r, left, d, t)], [point(r, right, d, b), point(r, right, d, t)]);
            }

            // Step walls on both sides (and the beam's outer edges): the
            // slice's cross-section beyond where its neighbour ends.
            for (const n of [left, right]) {
                const outer = n < 0;
                const from = outer ? 0 : Math.min(end[n], end[r]);
                if (!outer && end[r] - from <= Math.max(STEP_MIN_M, STEP_FRACTION * end[r])) continue;
                const ws = Array.from({ length: STEP_WALL_POINTS }, (_, j) =>
                    from + ((end[r] - from) * j) / (STEP_WALL_POINTS - 1));
                strip(ws.map(d => point(r, n, d, bottomAt(r, d))), ws.map(d => point(r, n, d, topAt(d))));
            }
        }

        const toMesh = (m: { positions: number[]; indices: number[] }) => CesiumRadarCoverage.coloredMesh(
            viewer, new Float64Array(m.positions), m.indices, Cesium.BoundingSphere.fromVertices(m.positions));
        const seenMesh = toMesh({ positions, indices });
        const hiddenMesh = toMesh(CesiumRadarCoverage.shadowSurface(grid, rowIdx, topAngle, end));

        return {
            dispose: () => {
                seenMesh.dispose();
                hiddenMesh.dispose();
            },
            // 100% opacity (or not see-through) draws both figures solid.
            setStyle: (st: RadarStyle) => {
                const show = st.showLowerBeams;
                const opacity = st.volumeTransparent ? Cesium.Math.clamp(st.volumeOpacity, 0.05, 1) : 1;
                const light = st.volumeLit ? Cesium.Math.clamp(st.volumeLight, 0, 1) : 0;
                seenMesh.draw(show && st.showReach ? opacity : 0, CLEAR_RGB, light);
                hiddenMesh.draw(show && st.showBlocked ? opacity : 0, BLOCKED_RGB, light);
            }
        };
    }

    // The top of the hidden (red) air as one surface over every direction
    // and range sample, by the ground map's rule: where the line of sight
    // over the nearer terrain passes more than GROUND_MAP_TARGET_HEIGHT_M
    // above the ground, the surface lies on that line (capped at the beam's
    // angle); elsewhere on the ground. Only triangles touching hidden air are
    // kept, so the figure slopes down to the ground at its edges. Walls close
    // it at the full range and at the beam's side edges. Only air out to
    // reach[k] (where the top ray meets the terrain) counts.
    private static shadowSurface(
        grid: RayGrid,
        rowIdx: number[],
        topAngle: number,
        reach: number[]
    ): { positions: number[]; indices: number[] } {
        const { dists, lastCol, radarHeight, wrap } = grid;
        const R = rowIdx.length;
        const stride = Math.max(1, Math.ceil(lastCol / SHADOW_VOLUME_POINTS));
        const cols: number[] = [];
        for (let c = 0; c < lastCol; c += stride) cols.push(c);
        cols.push(lastCol);
        const C = cols.length;

        const positions: number[] = [];
        const vertexAt = (k: number, j: number, h: number) => {
            const pt = grid.profiles[rowIdx[k]].groundPoints[cols[j]];
            const p = Cesium.Cartesian3.fromRadians(pt.longitude, pt.latitude, h);
            positions.push(p.x, p.y, p.z);
            return positions.length / 3 - 1;
        };
        const groundOf = (k: number, j: number) => grid.profiles[rowIdx[k]].groundHeights[cols[j]];

        // Surface vertex k * C + j: direction k, range sample cols[j].
        const hidden = new Uint8Array(R * C);
        for (let k = 0; k < R; k++) {
            const { peakAngle } = grid.rays[rowIdx[k]];
            for (let j = 0; j < C; j++) {
                const c = cols[j], d = dists[c], g = groundOf(k, j);
                let h = g;
                if (c > 0 && d >= NEAR_FIELD_IGNORE_M && d <= reach[k] && Number.isFinite(peakAngle[c - 1])) {
                    const cap = CesiumRadarCoverage.beamHeightAt(Math.min(topAngle, peakAngle[c - 1]), d, radarHeight);
                    if (cap - g > GROUND_MAP_TARGET_HEIGHT_M) {
                        h = cap;
                        hidden[k * C + j] = 1;
                    }
                }
                vertexAt(k, j, h);
            }
        }

        const indices: number[] = [];
        const v = (k: number, j: number) => k * C + j;
        const tri = (a: number, b: number, c: number) => {
            if (hidden[a] || hidden[b] || hidden[c]) indices.push(a, b, c);
        };
        for (let k = 0; k < (wrap ? R : R - 1); k++) {
            const k2 = (k + 1) % R;
            for (let j = 0; j < C - 1; j++) {
                tri(v(k, j), v(k2, j), v(k, j + 1));
                tri(v(k, j + 1), v(k2, j), v(k2, j + 1));
            }
        }

        // Wall from the surface down to the ground along the edge between
        // surface vertices (ka, ja) and (kb, jb), where either is hidden.
        const wall = (ka: number, ja: number, kb: number, jb: number) => {
            const a = v(ka, ja), b = v(kb, jb);
            if (!hidden[a] && !hidden[b]) return;
            const ga = vertexAt(ka, ja, groundOf(ka, ja));
            const gb = vertexAt(kb, jb, groundOf(kb, jb));
            indices.push(a, b, ga, b, gb, ga);
        };
        for (let k = 0; k < (wrap ? R : R - 1); k++) wall(k, C - 1, (k + 1) % R, C - 1);
        if (!wrap) {
            for (const k of [0, R - 1]) {
                for (let j = 0; j < C - 1; j++) wall(k, j, k, j + 1);
            }
        }
        return { positions, indices };
    }

    // -------------------------------------------------------------------
    // 6. Ground images draped on the terrain
    // -------------------------------------------------------------------
    // Ground map ("0° up to this angle"): green where the radar sees the
    // ground, red where nearer terrain hides it, only under the beams from
    // 0° up to the beam's angle. Separate images, so Show green / Show red
    // switch each on and off.
    private static buildGroundMap(
        viewer: Cesium.Viewer,
        grid: RayGrid,
        tips: BeamTips,
        longitude: number,
        latitude: number
    ): StyledHandle {
        const scores = [
            CesiumRadarCoverage.seenScores(grid, GROUND_MAP_TARGET_HEIGHT_M),
            CesiumRadarCoverage.reachScores(grid, tips)
        ];
        const layer = (seen: boolean) => CesiumRadarCoverage.drape(viewer,
            CesiumRadarCoverage.drawScoreImage(grid, longitude, latitude, scores,
                ([sc, reach]) => reach > 0 && (sc > 0) === seen ? [seen ? CLEAR_RGB : BLOCKED_RGB, GROUND_MAP_ALPHA] : null));
        const seenFill = layer(true);
        const hiddenFill = layer(false);
        return {
            dispose: () => {
                if (seenFill) viewer.entities.remove(seenFill);
                if (hiddenFill) viewer.entities.remove(hiddenFill);
            },
            setStyle: (st: RadarStyle) => {
                if (seenFill) seenFill.show = st.showLowerBeams && st.showReach;
                if (hiddenFill) hiddenFill.show = st.showLowerBeams && st.showBlocked;
            }
        };
    }

    // Ground footprint: green where the radar has a clear line of sight to
    // the ground, red where nearer terrain hides it, with soft edges. Covers
    // only the ground under the beams from 0° up to the beam's angle. Cached
    // per radar spot, mast, range, width and angle.
    private static buildFootprint(
        viewer: Cesium.Viewer,
        grid: RayGrid,
        tips: BeamTips,
        longitude: number,
        latitude: number,
        cacheKey: string
    ): StyledHandle {
        const cache = CesiumRadarCoverage.footprintCache;
        let images = cache.get(cacheKey);
        if (!images) {
            const scores = [CesiumRadarCoverage.seenScores(grid, 0), CesiumRadarCoverage.reachScores(grid, tips)];
            // Soft edge where seen meets hidden; nothing beyond the beam's reach.
            const alpha = (sc: number) => Math.min(1, 0.35 + Math.abs(sc) / 2);
            images = {
                seen: CesiumRadarCoverage.drawScoreImage(grid, longitude, latitude, scores,
                    ([sc, reach]) => reach > 0 && sc > 0 ? [CLEAR_RGB, alpha(sc)] : null),
                hidden: CesiumRadarCoverage.drawScoreImage(grid, longitude, latitude, scores,
                    ([sc, reach]) => reach > 0 && sc <= 0 ? [BLOCKED_RGB, alpha(sc)] : null)
            };
        }
        lruSet(cache, cacheKey, images, FOOTPRINT_CACHE_SIZE);

        let fillColor = Cesium.Color.WHITE.withAlpha(DEFAULT_RADAR_STYLE.footprintOpacity);
        const color = new Cesium.CallbackProperty(() => fillColor, false);
        const seenFill = CesiumRadarCoverage.drape(viewer, images.seen, color);
        const hiddenFill = CesiumRadarCoverage.drape(viewer, images.hidden, color);

        return {
            dispose: () => {
                if (seenFill) viewer.entities.remove(seenFill);
                if (hiddenFill) viewer.entities.remove(hiddenFill);
            },
            setStyle: (st: RadarStyle) => {
                const opacity = Cesium.Math.clamp(st.footprintOpacity, 0, 1);
                fillColor = Cesium.Color.WHITE.withAlpha(opacity);
                const show = st.showFootprint && opacity > 0;
                if (seenFill) seenFill.show = show && st.showReach;
                if (hiddenFill) hiddenFill.show = show && st.showBlocked;
            }
        };
    }

    // An image draped on the terrain, tinted by color (if given).
    private static drape(
        viewer: Cesium.Viewer,
        image: ScoreImage | null,
        color?: Cesium.Property
    ): Cesium.Entity | null {
        if (!image) return null;
        return viewer.entities.add({
            rectangle: {
                coordinates: image.rectangle,
                material: new Cesium.ImageMaterialProperty({ image: image.canvas, transparent: true, color }),
                classificationType: Cesium.ClassificationType.TERRAIN
            }
        });
    }

    // Per direction and sample: how far (metres) the ground, raised by
    // offsetM, rises above the line of sight over the nearer terrain
    // (> 0 seen, <= 0 hidden).
    private static seenScores(grid: RayGrid, offsetM: number): Float32Array[] {
        const { dists } = grid;
        return grid.rays.map(({ groundAngle, peakAngle }) => {
            const out = new Float32Array(dists.length).fill(SCORE_CLAMP_M);
            for (let i = 1; i < dists.length; i++) {
                const d = dists[i];
                if (d < NEAR_FIELD_IGNORE_M || !Number.isFinite(peakAngle[i - 1])) continue;
                out[i] = Cesium.Math.clamp(
                    (Math.tan(groundAngle[i]) - Math.tan(peakAngle[i - 1])) * d + offsetM, -SCORE_CLAMP_M, SCORE_CLAMP_M);
            }
            return out;
        });
    }

    // Per direction and sample: how far (metres) the sample lies before the
    // point where the ray at the beam's angle meets the terrain (> 0 under
    // the beams from 0° up to that angle).
    private static reachScores(grid: RayGrid, tips: BeamTips): Float32Array[] {
        const { dists } = grid;
        return grid.rays.map((_, r) => {
            const out = new Float32Array(dists.length).fill(SCORE_CLAMP_M);
            if (!tips.hit[r]) return out;
            for (let i = 0; i < dists.length; i++) out[i] = Cesium.Math.clamp(tips.dist[r] - dists[i], -SCORE_CLAMP_M, SCORE_CLAMP_M);
            return out;
        });
    }

    // An image over the beam's area: each pixel blends the scores of the
    // nearest directions and samples and is painted by paint (colour and
    // alpha 0-1), or left clear when paint gives null.
    private static drawScoreImage(
        grid: RayGrid,
        longitude: number,
        latitude: number,
        scoreSets: Float32Array[][],
        paint: (values: number[]) => [number[], number] | null
    ): ScoreImage | null {
        const { zone, wrap, rowStepDeg, spacing } = grid;
        const rows = scoreSets[0].length;
        const n = grid.dists.length;
        const range = zone.range;
        const scoreAt = (set: Float32Array[], row: number, col: number) => {
            const r0 = Math.floor(row), w = row - r0;
            const c0 = Math.min(Math.floor(col), n - 1), c1 = Math.min(c0 + 1, n - 1), u = col - Math.floor(col);
            const rowScore = (r: number) => {
                const sc = set[wrap ? ((r % rows) + rows) % rows : Cesium.Math.clamp(r, 0, rows - 1)];
                return sc[c0] * (1 - u) + sc[c1] * u;
            };
            return rowScore(r0) * (1 - w) + rowScore(r0 + 1) * w;
        };

        // Bounding box of the beam's area, in metres east / north of the radar.
        const azList: number[] = [];
        for (let k = 0; k <= 64; k++) azList.push(zone.azimuthStartDeg + (zone.azimuthWidthDeg * k) / 64);
        for (let a = 0; a < 360; a += 90) {
            if (wrap || norm360(a - zone.azimuthStartDeg) <= zone.azimuthWidthDeg) azList.push(a);
        }
        let minE = 0, maxE = 0, minN = 0, maxN = 0;
        for (const az of azList) {
            const rad = Cesium.Math.toRadians(az);
            minE = Math.min(minE, Math.sin(rad) * range);
            maxE = Math.max(maxE, Math.sin(rad) * range);
            minN = Math.min(minN, Math.cos(rad) * range);
            maxN = Math.max(maxN, Math.cos(rad) * range);
        }
        const widthM = Math.max(1, maxE - minE);
        const heightM = Math.max(1, maxN - minN);
        const mpp = Math.max(Math.max(widthM, heightM) / FOOTPRINT_TEXTURE_MAX_PX, spacing / 2);
        const texW = Math.max(1, Math.min(FOOTPRINT_TEXTURE_MAX_PX, Math.ceil(widthM / mpp)));
        const texH = Math.max(1, Math.min(FOOTPRINT_TEXTURE_MAX_PX, Math.ceil(heightM / mpp)));
        const mppX = widthM / texW, mppY = heightM / texH;

        const canvas = document.createElement("canvas");
        canvas.width = texW;
        canvas.height = texH;
        const ctx = canvas.getContext("2d");
        if (!ctx) return null;
        const img = ctx.createImageData(texW, texH);
        const data = img.data;
        for (let y = 0; y < texH; y++) {
            // Row 0 is the north edge.
            const north = maxN - (y + 0.5) * mppY;
            for (let x = 0; x < texW; x++) {
                const east = minE + (x + 0.5) * mppX;
                const dist = Math.hypot(east, north);
                if (dist > range || dist < NEAR_FIELD_IGNORE_M) continue;
                const rel = norm360(Cesium.Math.toDegrees(Math.atan2(east, north)) - zone.azimuthStartDeg);
                if (!wrap && rel > zone.azimuthWidthDeg) continue;
                const painted = paint(scoreSets.map(set => scoreAt(set, rel / rowStepDeg, dist / spacing)));
                if (!painted) continue;
                const [rgb, alpha] = painted;
                data.set([rgb[0], rgb[1], rgb[2], Math.round(255 * alpha)], (y * texW + x) * 4);
            }
        }
        ctx.putImageData(img, 0, 0);

        // WGS84 metres per degree at this latitude.
        const phi = Cesium.Math.toRadians(latitude);
        const metersPerDegLat = 111132.92 - 559.82 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi);
        const metersPerDegLon = 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi);
        const rectangle = Cesium.Rectangle.fromDegrees(
            longitude + minE / metersPerDegLon,
            latitude + minN / metersPerDegLat,
            longitude + maxE / metersPerDegLon,
            latitude + maxN / metersPerDegLat
        );
        return { canvas, rectangle };
    }

    // -------------------------------------------------------------------
    // 7. Labels on the widest blocked sectors
    // -------------------------------------------------------------------
    // Bearing range and compass direction, distance, and the angle that clears it.
    private static buildSectorLabels(
        viewer: Cesium.Viewer,
        grid: RayGrid,
        tips: BeamTips,
        sectors: BlockedSector[]
    ): StyledHandle {
        const labels = viewer.scene.primitives.add(new Cesium.LabelCollection()) as Cesium.LabelCollection;
        const rows = tips.hit.length;
        const range = grid.zone.range;
        for (const sector of sectors.filter(sc => sc.widthDeg >= MIN_LABEL_WIDTH_DEG).slice(0, MAX_SECTOR_LABELS)) {
            // The direction in this sector where the beam hits nearest.
            let best = -1;
            for (let r = 0; r < rows; r++) {
                if (!tips.hit[r] || tips.dist[r] !== sector.nearestHitM) continue;
                if (norm360(grid.rowAz[r] - sector.fromDeg) <= sector.widthDeg + grid.rowStepDeg) { best = r; break; }
            }
            if (best < 0) continue;
            // In the middle of the sector, out in its red area: past the hit,
            // and at least LABEL_MIN_RANGE_FRACTION of the range out, so
            // labels of sectors blocked close to the radar do not pile up on it.
            const midRow = sector.allRound ? best : CesiumRadarCoverage.rowNearest(grid, sector.fromDeg + sector.widthDeg / 2);
            const from = tips.hit[midRow] ? tips.dist[midRow] : sector.nearestHitM;
            const at = Math.min(range * 0.95, Math.max(from + (range - from) * 0.35, range * LABEL_MIN_RANGE_FRACTION));
            const g = CesiumRadarCoverage.groundAt(grid, midRow, at);
            labels.add({
                position: Cesium.Cartesian3.fromRadians(g.lon, g.lat, g.height + 30),
                text: `Blocked ${CesiumRadarCoverage.formatSector(sector)}\n` +
                    `${(sector.nearestHitM / 1000).toFixed(1)} km · clears at ${sector.clearDeg.toFixed(1)}°`,
                font: "12px sans-serif",
                fillColor: Cesium.Color.WHITE,
                showBackground: true,
                backgroundColor: Cesium.Color.fromCssColorString("#7f1d1d").withAlpha(0.85),
                backgroundPadding: new Cesium.Cartesian2(6, 4),
                horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
                verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                disableDepthTestDistance: Number.POSITIVE_INFINITY
            });
        }
        return {
            dispose: () => viewer.scene.primitives.remove(labels),
            setStyle: (st: RadarStyle) => { labels.show = st.showLabels && !st.showLowerBeams && !st.showStopPoints; }
        };
    }

    // "Only this angle" mode: a message over the radar while the beam is
    // clear in every direction. Each angle change rebuilds the coverage, so
    // it goes as soon as any direction is blocked again.
    private static buildClearLabel(viewer: Cesium.Viewer, radarPosition: Cesium.Cartesian3, scan: BeamScanResult): StyledHandle {
        const labels = viewer.scene.primitives.add(new Cesium.LabelCollection()) as Cesium.LabelCollection;
        if (scan.sectors.length === 0) {
            labels.add({
                position: radarPosition,
                text: `No obstruction can be detected above ${scan.elevationDeg.toFixed(1)}°\n` +
                    `up to ${+(scan.range / 1000).toFixed(1)} km range`,
                font: "bold 13px sans-serif",
                fillColor: Cesium.Color.WHITE,
                showBackground: true,
                backgroundColor: Cesium.Color.fromCssColorString("#14532d").withAlpha(0.9),
                backgroundPadding: new Cesium.Cartesian2(8, 5),
                horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
                verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                // Sits just above the radar marker.
                pixelOffset: new Cesium.Cartesian2(0, -16),
                disableDepthTestDistance: Number.POSITIVE_INFINITY
            });
        }
        return {
            dispose: () => viewer.scene.primitives.remove(labels),
            setStyle: (st: RadarStyle) => { labels.show = !st.showLowerBeams; }
        };
    }

    // Grid row whose direction is nearest this bearing.
    private static rowNearest(grid: RayGrid, bearingDeg: number): number {
        let best = 0, bestDiff = Infinity;
        grid.rowAz.forEach((az, r) => {
            const diff = Math.abs(norm360(az - bearingDeg + 180) - 180);
            if (diff < bestDiff) { bestDiff = diff; best = r; }
        });
        return best;
    }

    static compassOf(deg: number): string {
        const names = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
        return names[Math.round(norm360(deg) / 22.5) % 16];
    }

    // "42°–87° (NE)": the bearing range and the compass direction of its middle.
    static formatSector(sector: BlockedSector): string {
        if (sector.allRound) return "all round";
        const mid = sector.fromDeg + sector.widthDeg / 2;
        return `${Math.round(sector.fromDeg)}°–${Math.round(sector.toDeg)}° (${CesiumRadarCoverage.compassOf(mid)})`;
    }

    // -------------------------------------------------------------------
    // 8. Terrain profiles (cached)
    // -------------------------------------------------------------------
    private static buildAzimuthList(startDeg: number, sweepDeg: number, stepDeg: number): number[] {
        const sweep = Cesium.Math.clamp(sweepDeg, 1, 360);
        const full = sweep >= 360;
        const count = Math.max(2, Math.round(sweep / Math.max(0.05, stepDeg)) + (full ? 0 : 1));
        return Array.from({ length: count }, (_, i) => norm360(startDeg + (sweep * i) / (full ? count : count - 1)));
    }

    // Sampling terrain is by far the slowest step, and the ground does not
    // change when only the mast height, the beam's angle or a shorter range
    // change, so profiles are kept per radar spot + ray fan and reused when
    // they already reach far enough.
    private static async getTerrainProfiles(
        terrainProvider: Cesium.TerrainProvider,
        cacheKey: string,
        radarPosition: Cesium.Cartesian3,
        enuMatrix: Cesium.Matrix4,
        azimuthsDeg: number[],
        maxRange: number
    ): Promise<TerrainProfile[]> {
        const cache = CesiumRadarCoverage.profileCache;
        const cached = cache.get(cacheKey);
        if (cached && cached.maxRange >= maxRange) {
            lruSet(cache, cacheKey, cached, PROFILE_CACHE_SIZE);
            return cached.profiles;
        }

        const spacing = TERRAIN_SAMPLE_SPACING_M;
        const sampleCount = Math.max(2, Math.ceil(maxRange / spacing)) + 1;
        const horizontalDistances = Array.from({ length: sampleCount }, (_, i) => Math.min(i * spacing, maxRange));
        const flat: Cesium.Cartographic[] = [];
        const scratch = new Cesium.Cartesian3();
        for (const azimuthDeg of azimuthsDeg) {
            const groundRay = CesiumRadarCoverage.makeRay(radarPosition, enuMatrix, azimuthDeg);
            for (const distance of horizontalDistances) {
                flat.push(Cesium.Cartographic.fromCartesian(Cesium.Ray.getPoint(groundRay, distance, scratch)));
            }
        }
        const sampled = await Cesium.sampleTerrainMostDetailed(terrainProvider, flat);

        const profiles = azimuthsDeg.map((_, a) => {
            const groundPoints = sampled.slice(a * sampleCount, (a + 1) * sampleCount);
            const groundHeights = CesiumRadarCoverage.fillMissingHeights(groundPoints.map(p => p.height));
            return { horizontalDistances, groundHeights, groundPoints };
        });
        lruSet(cache, cacheKey, { maxRange, profiles }, PROFILE_CACHE_SIZE);
        return profiles;
    }

    // Heights the terrain gave no value for, taken from the nearest samples
    // either side (a missing height read as 0 m would be a deep false hole).
    private static fillMissingHeights(heights: (number | undefined)[]): number[] {
        const ok = (h: number | undefined): h is number => h !== undefined && Number.isFinite(h);
        const out = new Array<number>(heights.length);
        let prev = -1;
        for (let i = 0; i <= heights.length; i++) {
            if (i < heights.length && !ok(heights[i])) continue;
            const prevH = prev >= 0 ? heights[prev] as number : undefined;
            const nextH = i < heights.length ? heights[i] as number : undefined;
            for (let k = prev + 1; k < i; k++) {
                out[k] = prevH !== undefined && nextH !== undefined
                    ? prevH + (nextH - prevH) * (k - prev) / (i - prev)
                    : prevH ?? nextH ?? 0;
            }
            if (i < heights.length) out[i] = nextH as number;
            prev = i;
        }
        return out;
    }

    // Level ray from the radar towards this azimuth.
    private static makeRay(radarPosition: Cesium.Cartesian3, enuMatrix: Cesium.Matrix4, azimuthDeg: number): Cesium.Ray {
        const azimuth = Cesium.Math.toRadians(azimuthDeg);
        const local = new Cesium.Cartesian3(Math.sin(azimuth), Math.cos(azimuth), 0);
        const world = Cesium.Matrix4.multiplyByPointAsVector(enuMatrix, local, new Cesium.Cartesian3());
        return new Cesium.Ray(radarPosition, Cesium.Cartesian3.normalize(world, world));
    }

    // -------------------------------------------------------------------
    // 9. Shared line-of-sight maths (also used by CesiumLosProbe)
    // -------------------------------------------------------------------
    static readonly NEAR_FIELD_IGNORE_M = NEAR_FIELD_IGNORE_M;

    // Slope (tan of the elevation angle) of the lowest line from the antenna
    // that passes no more than RIDGE_TOLERANCE_M below the terrain seen at
    // `angle`, `dist` away. A point further out is hidden by that terrain
    // exactly when its own tan(angle) is below this value.
    static horizonTan(angle: number, dist: number): number {
        return Math.tan(angle) - RIDGE_TOLERANCE_M / dist;
    }

    // Elevation angle from the antenna to ground at this height and distance,
    // with the 4/3-Earth curvature drop applied.
    static elevationAngle(groundHeight: number, dist: number, radarHeight: number): number {
        const curvatureDrop = (dist * dist) / (2 * EFFECTIVE_EARTH_RADIUS_M);
        return Math.atan2(groundHeight - curvatureDrop - radarHeight, dist);
    }

    // Height above the ellipsoid of a straight beam leaving the antenna at this
    // elevation angle, after this horizontal distance (inverse of elevationAngle).
    static beamHeightAt(angle: number, dist: number, radarHeight: number): number {
        return radarHeight + dist * Math.tan(angle) + (dist * dist) / (2 * EFFECTIVE_EARTH_RADIUS_M);
    }

    // Ground point at this azimuth and horizontal distance from the radar.
    static groundPointAt(geometry: RadarGeometry, azimuthDeg: number, dist: number): Cesium.Cartographic {
        const ray = CesiumRadarCoverage.makeRay(geometry.radarPosition, geometry.enuMatrix, azimuthDeg);
        return Cesium.Cartographic.fromCartesian(Cesium.Ray.getPoint(ray, dist));
    }
}
