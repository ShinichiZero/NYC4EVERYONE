/**
 * OfflineManager.ts
 *
 * Manages incremental offline caching for AccessNYC.
 *
 * Two caching strategies are supported:
 *
 *   • Cache Area  (Option B): Downloads all vector tiles and curb/elevator
 *     data within a 5-mile radius of a user-selected map point.
 *
 *   • Cache Route (Option A): Downloads tiles and data within a 500 m buffer
 *     of a GeoJSON LineString (the current navigation route).
 *
 * Tile images are stored in the Cache Storage API (handled by the service
 * worker).  GeoJSON curb-cut and elevator-status records are stored in
 * IndexedDB via the helpers in `db.ts`.
 */

import type { LineString } from 'geojson';
import {
  type CurbCut,
  type ElevatorStatus,
  openDB,
  saveCurbCuts,
  saveElevatorStatus,
} from './db.js';
import { getTilesForBBox, type TileCoord, type BBox } from './RouteCacher.js';
import { secureFetch } from './secureFetch.js';

/* ── Constants ──────────────────────────────────────────────── */

/** 5 miles converted to metres (1 mile = 1 609.344 m). */
const FIVE_MILES_METRES = 5 * 1_609.344;   // 8 046.72 m

/** 500 m buffer on either side of a cached route. */
const ROUTE_BUFFER_METRES = 500;

/** Approximate metres per degree of latitude (Earth polar circumference / 360). */
const METRES_PER_DEG_LAT = 111_139;

/** Zoom levels to pre-cache.  Levels 12-16 balance detail and download size. */
const DEFAULT_ZOOM_LEVELS: readonly number[] = [12, 13, 14, 15, 16];

/** Cache Storage bucket name shared with the service worker. */
const TILE_CACHE_NAME = 'accessnyc-tiles-v1';

/**
 * NYC Open Data – curb cut (pedestrian ramp) features.
 * $where clause is supplied at query time with a bounding box filter.
 * https://data.cityofnewyork.us/Transportation/Sidewalk-Features/mz9f-kzab
 */
const CURB_API_BASE =
  'https://data.cityofnewyork.us/resource/mz9f-kzab.json';

/**
 * MTA Elevator & Escalator status API.
 * https://api.mta.info/#/elevatorAndEscalatorAvailability
 */
const ELEVATOR_API_URL =
  'https://api.mta.info/api/elevator/OUTAGES?Boro=ALL';

/* ── Types ──────────────────────────────────────────────────── */

export interface OfflineManagerOptions {
  /**
   * MapLibre tile URL template with `{z}`, `{x}`, `{y}` placeholders.
   * Must use HTTPS.
   * Example: 'https://api.maptiler.com/maps/streets/tiles/{z}/{x}/{y}.png?key=KEY'
   */
  tileUrlTemplate: string;

  /**
   * MTA API key for elevator-status requests.
   * If omitted, elevator caching is skipped.
   */
  mtaApiKey?: string;

  /** Override the default zoom levels to cache. */
  zoomLevels?: number[];

  /** Callback invoked with progress [0, 1] as tiles are downloaded. */
  onProgress?: (fraction: number) => void;
}

export interface CacheResult {
  tilesDownloaded: number;
  curbCutsCached: number;
  elevatorsCached: number;
  errors: string[];
}

/* ── Geometry helpers ───────────────────────────────────────── */

/**
 * Convert a distance in metres to degrees of longitude at the given latitude.
 */
function metresToDegreesLon(metres: number, latDeg: number): number {
  const latRad = (latDeg * Math.PI) / 180;
  return metres / (METRES_PER_DEG_LAT * Math.cos(latRad));
}

/**
 * Convert a distance in metres to degrees of latitude (independent of lon).
 */
function metresToDegreesLat(metres: number): number {
  return metres / METRES_PER_DEG_LAT;
}

/**
 * Compute a square bounding box centred on (lat, lon) with half-width
 * equal to `radiusMetres`.
 *
 * Returns [minLon, minLat, maxLon, maxLat] (GeoJSON / WGS-84 convention).
 */
export function calcBBox(
  lat: number,
  lon: number,
  radiusMetres: number,
): BBox {
  const dLat = metresToDegreesLat(radiusMetres);
  const dLon = metresToDegreesLon(radiusMetres, lat);
  return [
    lon - dLon,
    lat - dLat,
    lon + dLon,
    lat + dLat,
  ];
}

/* ── NYC Open Data response shape ───────────────────────────── */

interface NycCurbFeature {
  objectid?: string;
  feature_type?: string;
  ramp_type?: string;
  /* latitude / longitude may come as strings from Socrata */
  latitude?: string | number;
  longitude?: string | number;
  on_street?: string;
  /* Condition field used for colour-coding */
  physical_condition?: string;
}

function parseCurbStatus(
  feature: NycCurbFeature,
): CurbCut['status'] {
  const cond = (feature.physical_condition ?? '').toLowerCase();
  if (cond.includes('good') || cond === '') return 'compliant';
  if (cond.includes('fair') || cond.includes('slope')) return 'high_incline';
  return 'damaged';
}

function nycFeatureToCurbCut(f: NycCurbFeature): CurbCut | null {
  const lat = parseFloat(String(f.latitude ?? ''));
  const lon = parseFloat(String(f.longitude ?? ''));
  if (!isFinite(lat) || !isFinite(lon)) return null;

  return {
    id:        f.objectid ?? `${lat},${lon}`,
    lat,
    lon,
    status:    parseCurbStatus(f),
    location:  f.on_street ?? '',
    updatedAt: new Date().toISOString(),
  };
}

/* ── MTA response shape ─────────────────────────────────────── */

interface MtaOutageRecord {
  equipment?: string;
  station?: string;
  reason?: string;
  isUpdated?: string;
}

function mtaRecordToElevatorStatus(r: MtaOutageRecord): ElevatorStatus {
  return {
    equipmentId:    r.equipment ?? 'unknown',
    stationName:    r.station ?? 'Unknown Station',
    reason:         r.reason ?? '',
    lastKnownState: 'out_of_service',
    timestamp:      new Date().toISOString(),
  };
}

/* ── OfflineManager class ───────────────────────────────────── */

export class OfflineManager {
  private readonly tileUrlTemplate: string;
  private readonly zoomLevels: number[];
  private readonly mtaApiKey: string | undefined;
  private readonly onProgress: (fraction: number) => void;

  private db: IDBDatabase | null = null;

  constructor(options: OfflineManagerOptions) {
    // Validate that the tile template uses HTTPS
    if (!options.tileUrlTemplate.startsWith('https://')) {
      throw new Error(
        'OfflineManager: tileUrlTemplate must be an HTTPS URL.',
      );
    }

    this.tileUrlTemplate  = options.tileUrlTemplate;
    this.zoomLevels       = options.zoomLevels ?? [...DEFAULT_ZOOM_LEVELS];
    this.mtaApiKey        = options.mtaApiKey;
    this.onProgress       = options.onProgress ?? (() => undefined);
  }

  /** Open the IndexedDB connection.  Must be called before caching. */
  async init(): Promise<void> {
    this.db = await openDB();
  }

  /* ── Public API ─────────────────────────────────────────── */

  /**
   * Cache Area (Option B): download everything within a 5-mile radius
   * of the given geographic point.
   *
   * @param lat – WGS-84 latitude of the centre point
   * @param lon – WGS-84 longitude of the centre point
   */
  async cacheArea(lat: number, lon: number): Promise<CacheResult> {
    const bbox = calcBBox(lat, lon, FIVE_MILES_METRES);
    return this.downloadBBox(bbox);
  }

  /**
   * Cache Route (Option A): download everything within a 500 m buffer
   * of the provided GeoJSON LineString.
   *
   * @param lineString – GeoJSON LineString representing the route
   */
  async cacheRoute(lineString: LineString): Promise<CacheResult> {
    const bbox = calcLineBBox(lineString, ROUTE_BUFFER_METRES);
    return this.downloadBBox(bbox);
  }

  /* ── Private helpers ────────────────────────────────────── */

  private requireDb(): IDBDatabase {
    if (!this.db) {
      throw new Error('OfflineManager.init() must be called before caching.');
    }
    return this.db;
  }

  /**
   * Core download routine: given a BBOX, enumerate all tiles, fetch them
   * into Cache Storage, then fetch and store curb + elevator data.
   */
  private async downloadBBox(bbox: BBox): Promise<CacheResult> {
    const db      = this.requireDb();
    const result: CacheResult = {
      tilesDownloaded: 0,
      curbCutsCached:  0,
      elevatorsCached: 0,
      errors:          [],
    };

    /* ── 1. Tile download → Cache Storage ─────────────────── */
    const tiles     = getTilesForBBox(bbox, this.zoomLevels);
    const tileCache = await caches.open(TILE_CACHE_NAME);
    let   done      = 0;

    for (const tile of tiles) {
      const url = this.tileUrl(tile);
      try {
        // Skip tiles already cached
        const cached = await tileCache.match(url);
        if (!cached) {
          const response = await secureFetch(url, { timeoutMs: 20_000 });
          if (response.ok) {
            await tileCache.put(url, response);
            result.tilesDownloaded++;
          } else {
            result.errors.push(`Tile ${url} returned HTTP ${response.status}`);
          }
        }
      } catch (err) {
        result.errors.push(`Tile fetch failed: ${url} – ${String(err)}`);
      }
      done++;
      // Weight tiles at 80% of total progress; data fetches get remaining 20%
      this.onProgress((done / tiles.length) * 0.8);
    }

    /* ── 2. Curb-cut data → IndexedDB ─────────────────────── */
    try {
      const cuts = await this.fetchCurbCuts(bbox);
      await saveCurbCuts(db, cuts);
      result.curbCutsCached = cuts.length;
    } catch (err) {
      result.errors.push(`Curb-cut fetch failed: ${String(err)}`);
    }
    this.onProgress(0.9);

    /* ── 3. Elevator status → IndexedDB ───────────────────── */
    if (this.mtaApiKey !== undefined) {
      try {
        const elevators = await this.fetchElevatorStatus();
        for (const el of elevators) {
          await saveElevatorStatus(db, el);
        }
        result.elevatorsCached = elevators.length;
      } catch (err) {
        result.errors.push(`Elevator fetch failed: ${String(err)}`);
      }
    }
    this.onProgress(1);

    return result;
  }

  private tileUrl(tile: TileCoord): string {
    return this.tileUrlTemplate
      .replace('{z}', String(tile.z))
      .replace('{x}', String(tile.x))
      .replace('{y}', String(tile.y));
  }

  /**
   * Fetch curb-cut features from NYC Open Data, filtered by BBOX.
   */
  private async fetchCurbCuts(bbox: BBox): Promise<CurbCut[]> {
    const [minLon, minLat, maxLon, maxLat] = bbox;

    // Socrata SoQL spatial filter
    const where = encodeURIComponent(
      `within_box(the_geom, ${maxLat}, ${minLon}, ${minLat}, ${maxLon})`,
    );
    const url = `${CURB_API_BASE}?$limit=5000&$where=${where}`;

    const response = await secureFetch(url);
    if (!response.ok) {
      throw new Error(`NYC Open Data returned HTTP ${response.status}`);
    }

    const raw: unknown = await response.json();
    if (!Array.isArray(raw)) return [];

    return (raw as NycCurbFeature[])
      .map(nycFeatureToCurbCut)
      .filter((c): c is CurbCut => c !== null);
  }

  /**
   * Fetch current elevator outages from the MTA API.
   */
  private async fetchElevatorStatus(): Promise<ElevatorStatus[]> {
    const url      = this.mtaApiKey
      ? `${ELEVATOR_API_URL}&key=${encodeURIComponent(this.mtaApiKey)}`
      : ELEVATOR_API_URL;
    const response = await secureFetch(url);
    if (!response.ok) {
      throw new Error(`MTA API returned HTTP ${response.status}`);
    }

    const raw: unknown = await response.json();
    if (!Array.isArray(raw)) return [];

    return (raw as MtaOutageRecord[]).map(mtaRecordToElevatorStatus);
  }
}

/* ── calcLineBBox (exported for RouteCacher use) ────────────── */

/**
 * Compute a bounding box that covers every vertex of a LineString expanded
 * outward by `bufferMetres` on all sides.
 */
export function calcLineBBox(
  lineString: LineString,
  bufferMetres: number,
): BBox {
  if (lineString.coordinates.length === 0) {
    throw new Error('calcLineBBox: LineString has no coordinates.');
  }

  let minLon =  Infinity;
  let minLat =  Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;

  for (const coord of lineString.coordinates) {
    const lon = coord[0];
    const lat = coord[1];
    if (lon === undefined || lat === undefined) continue;
    if (lon < minLon) minLon = lon;
    if (lat < minLat) minLat = lat;
    if (lon > maxLon) maxLon = lon;
    if (lat > maxLat) maxLat = lat;
  }

  // Use the midpoint latitude for the longitudinal buffer approximation
  const midLat = (minLat + maxLat) / 2;
  const dLat   = metresToDegreesLat(bufferMetres);
  const dLon   = metresToDegreesLon(bufferMetres, midLat);

  return [
    minLon - dLon,
    minLat - dLat,
    maxLon + dLon,
    maxLat + dLat,
  ];
}
