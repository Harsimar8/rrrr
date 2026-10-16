import * as Cesium from "cesium";
import { Radar } from "./Radar";
import {
    BeamScanResult,
    CesiumRadarCoverage,
    RadarCoverageHandle,
    RadarStyle
} from "./CesiumRadarCoverage";

// Keeps the beam of every radar on the map in step with the radar list:
// builds new radars, rebuilds a radar when its position or beam changes,
// applies look-only changes in place, and removes deleted radars.
export class RadarRenderer {

    // Live coverage handles, keyed by radar id.
    private readonly radarHandles = new Map<string, RadarCoverageHandle[]>();

    // Inputs (position + beam settings) the coverage on screen was built from.
    // Unchanged signature = no rebuild (look changes are applied in place).
    private readonly lastBuiltSignature = new Map<string, string>();

    // Guards against overlapping async rebuilds of the same radar.
    private readonly buildInFlight = new Set<string>();

    // Newest state that arrived while a build was running; built next.
    private readonly pendingRebuild = new Map<string, Radar>();

    // Look-only settings last applied to the live coverage.
    private readonly lastAppliedStyle = new Map<string, string>();

    // Newest radar state seen, so a finished build can catch up with it.
    private readonly latestRadar = new Map<string, Radar>();

    // Every coverage built for a radar and not yet removed. When a build is
    // put on screen all the others are removed, so no old beam is left behind.
    private readonly liveBuilds = new Map<string, Set<RadarCoverageHandle[]>>();

    constructor(
        private viewer: Cesium.Viewer,
        private terrainProvider: Cesium.TerrainProvider,
        // Called with what the beam reaches each time a radar is rebuilt.
        private onScan?: (radarId: string, scan: BeamScanResult) => void,
        // Called when a radar starts (true) and finishes (false) rebuilding.
        private onBuilding?: (radarId: string, building: boolean) => void
    ) { }

    render(radars: Radar[]): void {
        const seenIds = new Set<string>();
        for (const radar of radars) {
            seenIds.add(radar.id);
            this.syncRadarCoverage(radar);
        }

        // Remove the coverage of radars that were deleted.
        const trackedIds = new Set([
            ...this.radarHandles.keys(),
            ...this.buildInFlight,
            ...this.latestRadar.keys()
        ]);
        for (const id of trackedIds) {
            if (!seenIds.has(id)) this.removeRadarCoverage(id);
        }

        this.viewer.scene.requestRender();
    }

    /** Drops the cached signature so the next render() rebuilds this radar from scratch. */
    forceRebuild(radarId: string): void {
        this.lastBuiltSignature.delete(radarId);
    }

    private removeRadarCoverage(radarId: string): void {
        this.disposeRadarCoverage(radarId);
        this.pendingRebuild.delete(radarId);
        this.lastAppliedStyle.delete(radarId);
        this.latestRadar.delete(radarId);
        this.onBuilding?.(radarId, false);
    }

    private disposeBuild(radarId: string, handles: RadarCoverageHandle[]): void {
        // One piece failing to go must not leave the others on the map.
        for (const handle of handles) {
            try {
                handle.dispose();
            } catch (err) {
                console.error("Failed to remove part of a radar coverage:", err);
            }
        }
        this.liveBuilds.get(radarId)?.delete(handles);
        this.redrawFor();
    }

    // Keeps redrawing for a short while: new beams and draped ground shapes
    // finish setting up over the next frames, and the viewer only redraws
    // on request.
    private redrawFrame: number | null = null;
    private redrawUntil = 0;

    private redrawFor(ms = 1500): void {
        this.redrawUntil = Math.max(this.redrawUntil, performance.now() + ms);
        if (this.redrawFrame !== null) return;
        const tick = () => {
            this.viewer.scene.requestRender();
            this.redrawFrame = performance.now() < this.redrawUntil ? requestAnimationFrame(tick) : null;
        };
        tick();
    }

    /** Removes every build of this radar except `keep`. */
    private disposeBuildsExcept(radarId: string, keep?: RadarCoverageHandle[]): void {
        for (const handles of [...(this.liveBuilds.get(radarId) ?? [])]) {
            if (handles !== keep) this.disposeBuild(radarId, handles);
        }
    }

    private disposeRadarCoverage(radarId: string): void {
        this.disposeBuildsExcept(radarId);
        this.radarHandles.delete(radarId);
        this.lastBuiltSignature.delete(radarId);
    }

    private styleOf(radar: Radar): RadarStyle {
        return CesiumRadarCoverage.styleOf(radar.properties ?? {});
    }

    private applyStyle(radar: Radar): void {
        const style = this.styleOf(radar);
        const key = JSON.stringify(style);
        if (this.lastAppliedStyle.get(radar.id) === key) return;

        for (const handle of this.radarHandles.get(radar.id) ?? []) {
            handle.setStyle?.(style);
        }
        this.lastAppliedStyle.set(radar.id, key);
    }

    private buildSignature(radar: Radar): string {
        const props = radar.properties ?? {};
        return JSON.stringify({
            lon: radar.longitude,
            lat: radar.latitude,
            // Opacities / show toggles are not here: applyStyle handles them.
            beam: CesiumRadarCoverage.beamOf(props),
            azimuthStepDeg: props["azimuthStepDeg"]
        });
    }

    private async syncRadarCoverage(radar: Radar): Promise<void> {

        const signature = this.buildSignature(radar);
        this.latestRadar.set(radar.id, radar);

        if (this.lastBuiltSignature.get(radar.id) === signature) {
            // Geometry unchanged: at most the look changed, which is cheap.
            this.pendingRebuild.delete(radar.id);
            this.applyStyle(radar);
            return;
        }

        // The old coverage goes at once; the new one is drawn when ready.
        this.disposeRadarCoverage(radar.id);
        this.onBuilding?.(radar.id, true);

        if (this.buildInFlight.has(radar.id)) {
            // Park the newest state; the running build rebuilds from it.
            this.pendingRebuild.set(radar.id, radar);
            return;
        }

        this.buildInFlight.add(radar.id);

        try {
            const props = radar.properties ?? {};

            const newHandles = await CesiumRadarCoverage.create3DRadarZones(
                this.viewer,
                this.terrainProvider,
                {
                    entityId: radar.id,
                    longitude: radar.longitude,
                    latitude: radar.latitude,
                    beam: CesiumRadarCoverage.beamOf(props),
                    azimuthStepDeg: props["azimuthStepDeg"],
                    style: this.styleOf(radar)
                }
            );
            if (!this.liveBuilds.has(radar.id)) this.liveBuilds.set(radar.id, new Set());
            this.liveBuilds.get(radar.id)!.add(newHandles);

            const latest = this.latestRadar.get(radar.id);
            if (!latest || this.buildSignature(latest) !== signature) {
                // Deleted or changed while building: drop this build.
                this.disposeBuild(radar.id, newHandles);
                return;
            }

            // Put the new build on screen and remove every older one.
            this.disposeBuildsExcept(radar.id, newHandles);
            this.radarHandles.set(radar.id, newHandles);
            this.lastBuiltSignature.set(radar.id, signature);

            const scan = newHandles.find(h => h.scan)?.scan;
            if (scan) this.onScan?.(radar.id, scan);

            // Catch up with any look changes made while it was building.
            this.lastAppliedStyle.delete(radar.id);
            this.applyStyle(latest);

            this.redrawFor();

        } catch (err) {
            console.error("Failed to render 3D radar coverage:", err);
        } finally {
            this.buildInFlight.delete(radar.id);

            const pending = this.pendingRebuild.get(radar.id);
            if (pending) {
                this.pendingRebuild.delete(radar.id);
                const latest = this.latestRadar.get(radar.id);
                if (latest) this.syncRadarCoverage(latest);
            }
            this.onBuilding?.(radar.id, this.buildInFlight.has(radar.id));
        }
    }
}
