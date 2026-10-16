import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  ViewChild,
  computed,
  effect,
  signal
} from '@angular/core';
import { DecimalPipe } from '@angular/common';

import * as Cesium from 'cesium';
import { CESIUM_ION_TOKEN, START_VIEW } from '../config';
import { BeamScanResult, BeamSettings, BlockedSector, CesiumRadarCoverage, RadarStyle } from './CesiumRadarCoverage';
import { CesiumLosProbe, LosProbeResult } from './CesiumLosProbe';
import { Radar } from './Radar';
import { RadarRenderer } from './RadarRenderer';

Cesium.Ion.defaultAccessToken = CESIUM_ION_TOKEN;

// Radars are kept in the browser between visits under this key.
const STORAGE_KEY = 'radar2.radars';

@Component({
  selector: 'app-radar-map',
  standalone: true,
  imports: [DecimalPipe],
  templateUrl: './radar-map.html',
  styleUrl: './radar-map.css',
  host: { '(window:keydown.escape)': 'placing.set(false)' }
})
export class RadarMap implements AfterViewInit, OnDestroy {

  @ViewChild('cesiumContainer', { static: true })
  cesiumContainer!: ElementRef<HTMLDivElement>;

  private viewer!: Cesium.Viewer;
  private renderer?: RadarRenderer;
  private clickHandler?: Cesium.ScreenSpaceEventHandler;

  protected readonly tokenMissing = !CESIUM_ION_TOKEN || CESIUM_ION_TOKEN.startsWith('PASTE_');
  protected readonly loadError = signal<string | null>(null);

  // -------------------------------------------------------------------
  // Radars
  // -------------------------------------------------------------------
  protected readonly radars = signal<Radar[]>(RadarMap.loadRadars());
  protected readonly selectedId = signal<string | null>(null);
  protected readonly selectedRadar = computed(() =>
    this.radars().find(r => r.id === this.selectedId()) ?? null);

  // "Add radar": the next click on the map places a radar there.
  protected readonly placing = signal(false);
  protected readonly toolPanelOpen = signal(true);
  protected readonly radarPanelClosed = signal(false);
  private lastSelectedId: string | null = null;

  // Click-to-explain line of sight ("why is this spot not covered?").
  private losProbe!: CesiumLosProbe;
  protected readonly losProbeEnabled = signal(false);
  protected readonly losProbeResult = signal<LosProbeResult | null>(null);
  // Re-run the probe under the mouse as it moves. Only one probe runs at a
  // time; the newest mouse position waits and runs when it finishes.
  protected readonly losProbeHover = signal(false);
  private hoverProbeBusy = false;
  private hoverProbePending: Cesium.Cartesian2 | null = null;

  // What each radar's beam reaches at its current angle (from the last build).
  private readonly scans = signal<Record<string, BeamScanResult>>({});
  protected readonly scan = computed(() => {
    const id = this.selectedId();
    return id ? this.scans()[id] ?? null : null;
  });

  // Radars whose coverage is being rebuilt right now.
  private readonly buildingIds = signal<ReadonlySet<string>>(new Set());
  protected readonly building = computed(() => {
    const id = this.selectedId();
    return !!id && this.buildingIds().has(id);
  });
  protected readonly anyBuilding = computed(() => this.buildingIds().size > 0);

  // Auto scan: raise the beam angle a step at a time until every direction
  // is clear (or the top angle is reached).
  protected readonly scanRunning = signal(false);
  protected readonly scanStepDeg = signal(0.25);
  protected readonly scanIntervalMs = signal(600);
  protected readonly scanStopWhenClear = signal(true);
  protected readonly scanStepOptions = [0.1, 0.25, 0.5, 1];
  protected readonly scanSpeedOptions = [
    { label: 'Slow', ms: 1200 },
    { label: 'Normal', ms: 600 },
    { label: 'Fast', ms: 250 }
  ];
  private scanTimer?: ReturnType<typeof setInterval>;
  private scanRadarId: string | null = null;
  private static readonly SCAN_MAX_DEG = 45;

  constructor() {
    // Redraw the beams and save whenever the radar list changes.
    effect(() => {
      const radars = this.radars();
      this.renderer?.render(radars);
      RadarMap.saveRadars(radars);
    });

    // "Add radar" ended (placed, cancelled or Esc): drop the preview marker.
    effect(() => {
      if (!this.placing()) this.removePlacePreview();
    });

    // Re-open the radar panel whenever a different radar gets selected, but
    // respect an explicit close (X) for the current one.
    effect(() => {
      const id = this.selectedId();
      if (id !== this.lastSelectedId) {
        this.lastSelectedId = id;
        this.radarPanelClosed.set(false);
        if (this.scanRadarId && this.scanRadarId !== id) this.stopScan();
      }
    });
  }

  async ngAfterViewInit(): Promise<void> {
    let terrainProvider: Cesium.TerrainProvider;
    try {
      terrainProvider = await Cesium.createWorldTerrainAsync();
    } catch (err) {
      console.error('Failed to load terrain:', err);
      this.loadError.set('Could not load the 3D terrain. Check the Cesium ion token in src/app/config.ts and your internet connection.');
      return;
    }

    this.viewer = new Cesium.Viewer(this.cesiumContainer.nativeElement, {
      terrainProvider,
      animation: false,
      timeline: false,
      baseLayerPicker: false,
      geocoder: false,
      homeButton: true,
      sceneModePicker: true,
      navigationHelpButton: true,
      fullscreenButton: true,
      infoBox: false,
      selectionIndicator: false,
      requestRenderMode: true,
      maximumRenderTimeChange: Infinity,
      terrainShadows: Cesium.ShadowMode.RECEIVE_ONLY
    });

    this.viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(START_VIEW.longitude, START_VIEW.latitude, START_VIEW.height),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(START_VIEW.pitchDeg), roll: 0 }
    });

    this.viewer.scene.fog.enabled = false;
    this.viewer.scene.globe.enableLighting = false;
    this.viewer.scene.light = new Cesium.SunLight({ intensity: 1.6 });
    this.viewer.scene.globe.depthTestAgainstTerrain = true;
    // Finer terrain tiles when zoomed out (default 2), so the ground shown
    // stays closer to the detailed heights the coverage is built on.
    this.viewer.scene.globe.maximumScreenSpaceError = 1;
    // Lets pickPosition find the point on the see-through beam, so the LOS
    // probe can check a clicked point in the air.
    this.viewer.scene.pickTranslucentDepth = true;

    this.renderer = new RadarRenderer(
      this.viewer,
      terrainProvider,
      (id, scan) => this.scans.update(all => ({ ...all, [id]: scan })),
      (id, busy) => this.buildingIds.update(ids => {
        if (ids.has(id) === busy) return ids;
        const next = new Set(ids);
        if (busy) next.add(id); else next.delete(id);
        return next;
      })
    );
    this.renderer.render(this.radars());

    this.losProbe = new CesiumLosProbe(this.viewer, terrainProvider);

    this.clickHandler = new Cesium.ScreenSpaceEventHandler(this.viewer.scene.canvas);
    this.clickHandler.setInputAction(
      (click: Cesium.ScreenSpaceEventHandler.PositionedEvent) => this.handleLeftClick(click),
      Cesium.ScreenSpaceEventType.LEFT_CLICK
    );
    this.clickHandler.setInputAction(
      (move: Cesium.ScreenSpaceEventHandler.MotionEvent) => {
        if (this.placing()) this.movePlacePreview(move.endPosition);
        else this.hoverLosProbe(move.endPosition);
      },
      Cesium.ScreenSpaceEventType.MOUSE_MOVE
    );

    this.viewer.scene.requestRender();
  }

  ngOnDestroy(): void {
    this.stopScan();
    this.clickHandler?.destroy();
    this.viewer?.destroy();
  }

  // -------------------------------------------------------------------
  // Tool panel: add / select / delete radars
  // -------------------------------------------------------------------

  togglePlacing(): void {
    this.placing.update(v => !v);
  }

  selectRadar(id: string): void {
    this.selectedId.set(id);
    this.radarPanelClosed.set(false);
  }

  flyToRadar(radar: Radar): void {
    if (!this.viewer) return;
    const range = CesiumRadarCoverage.beamOf(radar.properties).range;
    this.viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(radar.longitude, radar.latitude - range / 111000 * 1.2, range * 0.9),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-45), roll: 0 },
      duration: 1
    });
  }

  deleteRadar(id: string): void {
    if (this.scanRadarId === id) this.stopScan();
    this.radars.update(list => list.filter(r => r.id !== id));
    this.scans.update(all => {
      const { [id]: _, ...rest } = all;
      return rest;
    });
    if (this.selectedId() === id) {
      this.selectedId.set(null);
      this.clearLosProbe();
    }
  }

  deleteAllRadars(): void {
    if (this.radars().length === 0) return;
    if (!confirm(`Delete all ${this.radars().length} radars?`)) return;
    this.stopScan();
    this.radars.set([]);
    this.scans.set({});
    this.selectedId.set(null);
    this.clearLosProbe();
  }

  private addRadarAt(longitude: number, latitude: number): void {
    const id = `radar-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    const used = new Set(this.radars().map(r => r.name));
    let n = this.radars().length + 1;
    while (used.has(`Radar ${n}`)) n++;
    const radar: Radar = { id, name: `Radar ${n}`, longitude, latitude, properties: {} };
    this.radars.update(list => [...list, radar]);
    this.selectRadar(id);
  }

  // -------------------------------------------------------------------
  // Radar panel: beam settings
  // -------------------------------------------------------------------

  private getRadarProps(): Record<string, any> {
    return this.selectedRadar()?.properties ?? {};
  }

  protected beam(): BeamSettings {
    return CesiumRadarCoverage.beamOf(this.getRadarProps());
  }

  protected radarStyle(): RadarStyle {
    return CesiumRadarCoverage.styleOf(this.getRadarProps());
  }

  protected readonly beamWidthPresets = [45, 90, 120, 180, 360];

  // Allowed range of every beam value typed in or slid.
  private static readonly BEAM_LIMITS: Record<string, [number, number]> = {
    beamAzimuthDeg: [0, 359.9],
    beamWidthDeg: [1, 360],
    beamElevationDeg: [0, RadarMap.SCAN_MAX_DEG],
    beamRange: [500, 100000]
  };

  onBeamChange(key: string, value: string): void {
    const v = +value;
    if (!Number.isFinite(v)) return;
    const [lo, hi] = RadarMap.BEAM_LIMITS[key] ?? [-Infinity, Infinity];
    this.updateRadarProperty({ [key]: Math.min(hi, Math.max(lo, v)) });
  }

  onStyleChange(patch: Partial<RadarStyle>): void {
    // Switching mode resets the footprint to that mode's default: on in
    // "0° up to this angle", off in "Only this angle". Entering "0° up to
    // this angle" also turns the shape's light and transparency back on.
    if (patch.showLowerBeams !== undefined && patch.showFootprint === undefined) {
      patch = { ...patch, showFootprint: patch.showLowerBeams };
    }
    if (patch.showLowerBeams) {
      patch = { volumeLit: true, volumeTransparent: true, ...patch };
    }
    this.updateRadarProperty(patch);
  }

  onMastHeightChange(value: string): void {
    const v = +value;
    if (!Number.isFinite(v)) return;
    this.updateRadarProperty({ antennaMastHeight: Math.max(0, v) });
  }

  // Spacing between the directions (rays) the terrain is checked along.
  // null = automatic (about 240 rays across the beam, 0.1° to 1° apart).
  protected readonly raySpacingOptions: (number | null)[] = [null, 1, 0.5, 0.25, 0.1];

  protected raySpacing(): number | null {
    return this.getRadarProps()['azimuthStepDeg'] ?? null;
  }

  /** Degrees between rays actually used, and how far apart they are at full range (m). */
  protected rayGap(): { deg: number; meters: number } {
    const beam = this.beam();
    const deg = this.raySpacing() ?? Math.min(1, Math.max(0.1, beam.widthDeg / 240));
    return { deg, meters: beam.range * Cesium.Math.toRadians(deg) };
  }

  protected static readonly MIN_RAY_SPACING_DEG = 0.05;
  protected static readonly MAX_RAY_SPACING_DEG = 5;
  protected readonly limits = {
    minRay: RadarMap.MIN_RAY_SPACING_DEG, maxRay: RadarMap.MAX_RAY_SPACING_DEG
  };

  /** A typed ray spacing (degrees); empty or 0 = automatic. */
  onRaySpacingInput(value: string): void {
    const v = +value;
    if (value.trim() === '' || v === 0) {
      this.onRaySpacingChange(null);
      return;
    }
    if (!Number.isFinite(v) || v < 0) return;
    this.onRaySpacingChange(Math.min(RadarMap.MAX_RAY_SPACING_DEG, Math.max(RadarMap.MIN_RAY_SPACING_DEG, v)));
  }

  onRaySpacingChange(deg: number | null): void {
    this.updateRadarProperty({ azimuthStepDeg: deg ?? undefined });
  }

  onRename(value: string): void {
    const name = value.trim();
    const id = this.selectedId();
    if (!name || !id) return;
    this.radars.update(list => list.map(r => r.id === id ? { ...r, name } : r));
  }

  private updateRadarProperty(patch: Record<string, unknown>, id = this.selectedId()): void {
    if (!id) return;
    this.radars.update(list => list.map(r =>
      r.id === id ? { ...r, properties: { ...r.properties, ...patch } } : r));
  }

  refreshRadarCoverage(): void {
    const id = this.selectedId();
    if (!id || !this.renderer) return;
    this.renderer.forceRebuild(id);
    this.renderer.render(this.radars());
  }

  closeRadarPanel(): void {
    this.radarPanelClosed.set(true);
  }

  // -------------------------------------------------------------------
  // Beam angle and auto scan
  // -------------------------------------------------------------------

  nudgeElevation(deltaDeg: number): void {
    this.onBeamChange('beamElevationDeg', '' + this.roundAngle(this.beam().elevationDeg + deltaDeg));
  }

  /** Lowest angle (rounded up to 0.1 deg) at which the whole beam width is clear. */
  protected clearAngle(scan: BeamScanResult): number {
    return Math.ceil((scan.allClearDeg + 0.01) * 10) / 10;
  }

  /** True once the beam has been raised to the all-clear angle (by Auto scan or by hand). */
  protected reachedClear(scan: BeamScanResult): boolean {
    return scan.sectors.length === 0 && this.beam().elevationDeg >= this.clearAngle(scan) - 0.05;
  }

  toggleScan(): void {
    if (this.scanRunning()) {
      this.stopScan();
      return;
    }
    const id = this.selectedId();
    if (!id) return;

    // Already at the top (or already all clear): start again from the ground.
    const scan = this.scan();
    const current = this.beam().elevationDeg;
    const top = this.scanStopWhenClear() && scan ? this.clearAngle(scan) : RadarMap.SCAN_MAX_DEG;
    if (current >= top) this.updateRadarProperty({ beamElevationDeg: 0 });

    this.scanRadarId = id;
    this.scanRunning.set(true);
    this.restartScanTimer();
  }

  setScanSpeed(ms: number): void {
    this.scanIntervalMs.set(ms);
    if (this.scanRunning()) this.restartScanTimer();
  }

  private restartScanTimer(): void {
    clearInterval(this.scanTimer);
    this.scanTimer = setInterval(() => this.scanTick(), this.scanIntervalMs());
  }

  private scanTick(): void {
    const id = this.scanRadarId;
    const radar = id ? this.radars().find(r => r.id === id) : undefined;
    if (!radar) {
      this.stopScan();
      return;
    }
    const current = CesiumRadarCoverage.beamOf(radar.properties).elevationDeg;
    const scan = this.scans()[radar.id];
    // The clear angle depends only on the terrain, so the scan knows where to
    // stop even while the newest angle is still being drawn.
    const top = this.scanStopWhenClear() && scan ? this.clearAngle(scan) : RadarMap.SCAN_MAX_DEG;
    const next = this.roundAngle(Math.min(top, current + this.scanStepDeg()));
    if (next !== current) this.updateRadarProperty({ beamElevationDeg: next }, radar.id);
    if (next >= top) this.stopScan();
  }

  stopScan(): void {
    clearInterval(this.scanTimer);
    this.scanTimer = undefined;
    this.scanRadarId = null;
    this.scanRunning.set(false);
  }

  private roundAngle(deg: number): number {
    return Math.round(deg * 100) / 100;
  }

  protected formatSector(sector: BlockedSector): string {
    return CesiumRadarCoverage.formatSector(sector);
  }

  // Horizon profile chart: lowest clear angle in every direction, with the
  // beam's angle across it. Bars above the beam line are blocked directions.
  protected readonly chart = computed(() => {
    const scan = this.scan();
    if (!scan || scan.horizon.length === 0) return null;
    const W = 300, H = 120, left = 30, right = 6, top = 8, bottom = 18;
    const plotW = W - left - right, plotH = H - top - bottom;
    const elevation = this.beam().elevationDeg;
    const values = scan.horizon.map(h => h.clearDeg);
    const yMin = Math.max(-10, Math.floor(Math.min(-1, elevation, ...values)));
    const yMax = Math.ceil(Math.max(1, elevation, scan.allClearDeg)) + 1;
    const y = (deg: number) => top + plotH * (1 - (Math.min(yMax, Math.max(yMin, deg)) - yMin) / (yMax - yMin));
    const barW = plotW / scan.horizon.length;
    const bars = scan.horizon.map((h, i) => {
      const bearing = ((h.azDeg % 360) + 360) % 360;
      return {
        x: left + i * barW,
        y: y(h.clearDeg),
        w: barW + 0.3,
        h: Math.max(0, y(yMin) - y(h.clearDeg)),
        blocked: h.clearDeg >= elevation,
        title: `Bearing ${bearing.toFixed(0)}° (${CesiumRadarCoverage.compassOf(bearing)}): ` +
          `clear above ${h.clearDeg.toFixed(1)}°`
      };
    });
    const xTicks: { x: number; label: string }[] = [];
    for (let a = Math.ceil(scan.startDeg / 90) * 90; a <= scan.startDeg + scan.widthDeg; a += 90) {
      xTicks.push({ x: left + (plotW * (a - scan.startDeg)) / scan.widthDeg, label: CesiumRadarCoverage.compassOf(a) });
    }
    if (scan.widthDeg >= 360) xTicks.pop();
    return {
      W, H, left, right: W - right, top, bottom: H - bottom, bars, xTicks,
      // Top, 0° and bottom, skipping any too close to another to read.
      yTicks: [yMax, 0, yMin].filter((v, i, all) => all.indexOf(v) === i)
        .map(v => ({ y: y(v), label: `${v}°` }))
        .filter((t, i, all) => all.slice(0, i).every(o => Math.abs(o.y - t.y) >= 14)),
      beamY: y(elevation)
    };
  });

  // -------------------------------------------------------------------
  // Line-of-sight probe
  // -------------------------------------------------------------------

  onLosProbeToggle(checked: boolean): void {
    this.losProbeEnabled.set(checked);
    if (!checked) this.clearLosProbe();
  }

  onLosProbeHoverToggle(checked: boolean): void {
    this.losProbeHover.set(checked);
  }

  clearLosProbe(): void {
    this.losProbe?.clear();
    this.losProbeResult.set(null);
  }

  // A see-through radar marker on the ground: where a radar being placed
  // will go.
  private addGhostMarker(position: Cesium.Cartesian3): Cesium.Entity {
    return this.viewer.entities.add({
      position,
      point: {
        pixelSize: 16,
        color: Cesium.Color.WHITE.withAlpha(0.6),
        outlineColor: Cesium.Color.fromCssColorString('#3b82f6'),
        outlineWidth: 3,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY
      }
    });
  }

  // -------------------------------------------------------------------
  // Placing a radar: a preview marker follows the mouse
  // -------------------------------------------------------------------

  private placePreview: Cesium.Entity | null = null;

  private movePlacePreview(position: Cesium.Cartesian2): void {
    const ground = this.groundAt(position);
    if (!ground) return;
    if (this.placePreview) this.placePreview.position = new Cesium.ConstantPositionProperty(ground);
    else this.placePreview = this.addGhostMarker(ground);
    this.viewer.scene.requestRender();
  }

  private removePlacePreview(): void {
    if (!this.placePreview || !this.viewer) return;
    this.viewer.entities.remove(this.placePreview);
    this.placePreview = null;
    this.viewer.scene.requestRender();
  }

  // -------------------------------------------------------------------
  // Map clicks
  // -------------------------------------------------------------------

  private handleLeftClick(click: Cesium.ScreenSpaceEventHandler.PositionedEvent): void {

    if (this.placing()) {
      const ground = this.groundAt(click.position);
      if (!ground) return;
      const c = Cesium.Cartographic.fromCartesian(ground);
      this.addRadarAt(Cesium.Math.toDegrees(c.longitude), Cesium.Math.toDegrees(c.latitude));
      this.placing.set(false);
      return;
    }

    // The radar symbol always selects its radar (and opens its panel).
    const picked = this.viewer.scene.pick(click.position) as any;
    const pickedEntity = picked?.id;
    if (pickedEntity?.isRadarMarker && pickedEntity.radarParentId) {
      this.selectRadar(pickedEntity.radarParentId);
      return;
    }

    // With the probe on, a click explains the line of sight to the point: in
    // the air when the beam was clicked, on the ground otherwise.
    if (this.losProbeEnabled()) {
      const spot = this.probeSpotAt(click.position);
      if (spot && this.runLosProbe(spot.target, spot.airHeight) !== null) return;
    }
  }

  /**
   * What a click / hover points at for the LOS probe: a point in the air on
   * the beam when the beam is under the mouse (airHeight = its height), else
   * the ground.
   */
  private probeSpotAt(position: Cesium.Cartesian2): { target: Cesium.Cartographic; airHeight?: number } | null {
    const scene = this.viewer.scene;
    const picked = scene.pick(position) as any;
    if (picked?.primitive?.isBeamMesh) {
      const onBeam = scene.pickPosition(position);
      if (onBeam) {
        const target = Cesium.Cartographic.fromCartesian(onBeam);
        const ground = scene.globe.getHeight(target);
        // A beam that touches the ground counts as a ground click.
        if (ground === undefined || target.height - ground > RadarMap.AIR_MIN_HEIGHT_M) {
          return { target, airHeight: target.height };
        }
      }
    }
    const ground = this.groundAt(position) ?? scene.pickPosition(position);
    return ground ? { target: Cesium.Cartographic.fromCartesian(ground) } : null;
  }

  // A beam point closer than this to the ground is checked as the ground.
  private static readonly AIR_MIN_HEIGHT_M = 10;

  private hoverLosProbe(position: Cesium.Cartesian2): void {
    if (!this.losProbeEnabled() || !this.losProbeHover() || this.placing()) {
      return;
    }
    if (this.hoverProbeBusy) {
      this.hoverProbePending = Cesium.Cartesian2.clone(position);
      return;
    }

    const spot = this.probeSpotAt(position);
    const run = spot ? this.runLosProbe(spot.target, spot.airHeight) : null;
    if (!run) return;

    this.hoverProbeBusy = true;
    run.finally(() => {
      this.hoverProbeBusy = false;
      const next = this.hoverProbePending;
      this.hoverProbePending = null;
      if (next) this.hoverLosProbe(next);
    });
  }

  /**
   * Probes the radar that covers this point (in the air at airHeight, or on
   * the ground); null (and clears) if none does.
   */
  private runLosProbe(target: Cesium.Cartographic, airHeight?: number): Promise<void> | null {
    const radarId = this.losProbe.findRadarFor(target, this.selectedId());

    if (!radarId) {
      this.clearLosProbe();
      return null;
    }

    return this.losProbe.probe(radarId, target).then(result => {
      if (result) this.losProbeResult.set(result);
    });
  }

  /** Terrain under a screen position, ignoring the beams drawn on top. */
  private groundAt(position: Cesium.Cartesian2): Cesium.Cartesian3 | undefined {
    const ray = this.viewer.camera.getPickRay(position);
    return ray ? this.viewer.scene.globe.pick(ray, this.viewer.scene) : undefined;
  }

  // -------------------------------------------------------------------
  // Saving radars in the browser
  // -------------------------------------------------------------------

  private static loadRadars(): Radar[] {
    try {
      const list = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
      return Array.isArray(list) ? list.filter(r => r && r.id && Number.isFinite(r.longitude) && Number.isFinite(r.latitude)) : [];
    } catch {
      return [];
    }
  }

  private static saveRadars(radars: Radar[]): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(radars));
    } catch { }
  }
}
