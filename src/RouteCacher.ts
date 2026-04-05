/**
 * RouteCacher.ts
 *
 * Identifies all slippy-map tile coordinates that intersect a GeoJSON
 * LineString (plus an optional buffer) and downloads them to the
 * Cache Storage API.
 *
 * Exported surface:
 *   • `TileCoord`      – { z, x, y } coordinate triple
 *   • `BBox`           – [minLon, minLat, maxLon, maxLat]
 *   • `getTilesForBBox` – enumerate tile coordinates covering a BBOX
 *   • `cacheRoute`     – high-level function: LineString → tiles downloaded
 */

import type { LineString } from 'geojson';
import { calcLineBBox } from './OfflineManager.js';
import { secureFetch }   from './secureFetch.js';

/* ── Types ──────────────────────────────────────────────────── */

/** Slippy-map tile coordinate. */
export interface TileCoord {
  z: number;
  x: number;
  y: number;
}

/**
 * Bounding box in WGS-84 degrees: [minLon, minLat, maxLon, maxLat].
 * Follows the GeoJSON convention (longitude first).
 */
export type BBox = [number, number, number, number];

export interface RouteCacheOptions {
  /**
   * MapLibre tile URL template with `{z}`, `{x}`, `{y}` placeholders.
   * Must use HTTPS.
   */
  tileUrlTemplate: string;

  /** Name of the Cache Storage bucket to use. Defaults to 'accessnyc-tiles-v1'. */
  cacheName?: string;

  /** Zoom levels to cache.  Defaults to [12, 13, 14, 15, 16]. */
  zoomLevels?: number[];

  /**
   * Buffer in metres to expand outward from each vertex of the LineString.
   * Defaults to 500 m.
   */
  bufferMetres?: number;

  /** Progress callback invoked with a fraction [0, 1] as tiles are cached. */
  onProgress?: (fraction: number) => void;
}

export interface RouteCacheResult {
  /** Total number of tile slots (z/x/y) that intersect the buffered route. */
  tilesTotal: number;
  /** Tiles actually written to cache (may be less if already cached). */
  tilesDownloaded: number;
  /** Any URLs that failed to fetch. */
  errors: string[];
}

/* ── Slippy-map maths ───────────────────────────────────────── */

/**
 * Convert a longitude (degrees) to a tile X index at the given zoom.
 * Formula: https://wiki.openstreetmap.org/wiki/Slippy_map_tilenames
 */
export function lonToTileX(lon: number, zoom: number): number {
  return Math.floor(((lon + 180) / 360) * Math.pow(2, zoom));
}

/**
 * Convert a latitude (degrees) to a tile Y index at the given zoom.
 * Uses the Mercator projection formula.
 */
export function latToTileY(lat: number, zoom: number): number {
  const latRad = (lat * Math.PI) / 180;
  return Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) *
      Math.pow(2, zoom),
  );
}

/**
 * Return all unique tile coordinates that cover the given bounding box at
 * every specified zoom level.
 *
 * @param bbox       – [minLon, minLat, maxLon, maxLat]
 * @param zoomLevels – zoom levels to enumerate (e.g. [12, 13, 14, 15, 16])
 */
export function getTilesForBBox(
  bbox: BBox,
  zoomLevels: readonly number[],
): TileCoord[] {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const tiles: TileCoord[] = [];

  for (const z of zoomLevels) {
    const xMin = lonToTileX(minLon, z);
    const xMax = lonToTileX(maxLon, z);

    // Note: Y increases southward in slippy-map tiles, so minLat → larger Y.
    const yMin = latToTileY(maxLat, z);  // northern edge → smaller y index
    const yMax = latToTileY(minLat, z);  // southern edge → larger  y index

    for (let x = xMin; x <= xMax; x++) {
      for (let y = yMin; y <= yMax; y++) {
        tiles.push({ z, x, y });
      }
    }
  }

  return tiles;
}

/* ── URL builder ────────────────────────────────────────────── */

function buildTileUrl(template: string, tile: TileCoord): string {
  return template
    .replace('{z}', String(tile.z))
    .replace('{x}', String(tile.x))
    .replace('{y}', String(tile.y));
}

/* ── Main exported function ─────────────────────────────────── */

/**
 * `cacheRoute` – Option A offline strategy.
 *
 * Given a GeoJSON LineString (e.g. the user's current navigation route),
 * this function:
 *   1. Expands each vertex outward by `bufferMetres` (default 500 m) to form
 *      a bounding box that covers the whole corridor.
 *   2. Enumerates every slippy-map tile that intersects that bounding box for
 *      the requested zoom levels.
 *   3. Downloads any tiles not already in Cache Storage using the HTTPS-only
 *      `secureFetch` wrapper.
 *
 * @param lineString – GeoJSON LineString representing the route to cache
 * @param options    – configuration (tile template, zoom levels, buffer…)
 * @returns          – summary of tiles downloaded / errors
 */
export async function cacheRoute(
  lineString: LineString,
  options: RouteCacheOptions,
): Promise<RouteCacheResult> {
  if (!options.tileUrlTemplate.startsWith('https://')) {
    throw new Error('cacheRoute: tileUrlTemplate must be an HTTPS URL.');
  }

  const bufferMetres = options.bufferMetres ?? 500;
  const zoomLevels   = options.zoomLevels   ?? [12, 13, 14, 15, 16];
  const cacheName    = options.cacheName     ?? 'accessnyc-tiles-v1';
  const onProgress   = options.onProgress    ?? (() => undefined);

  /* ── 1. Compute the buffered BBOX ─────────────────────────── */
  const bbox  = calcLineBBox(lineString, bufferMetres);
  const tiles = getTilesForBBox(bbox, zoomLevels);

  const result: RouteCacheResult = {
    tilesTotal:      tiles.length,
    tilesDownloaded: 0,
    errors:          [],
  };

  /* ── 2. Open cache bucket ─────────────────────────────────── */
  const cache = await caches.open(cacheName);
  let   done  = 0;

  /* ── 3. Download tiles ────────────────────────────────────── */
  for (const tile of tiles) {
    const url = buildTileUrl(options.tileUrlTemplate, tile);

    try {
      // Skip tiles already present in cache (avoid redundant network calls)
      const cached = await cache.match(url);
      if (!cached) {
        const response = await secureFetch(url, { timeoutMs: 20_000 });
        if (response.ok) {
          await cache.put(url, response);
          result.tilesDownloaded++;
        } else {
          result.errors.push(`HTTP ${response.status} for ${url}`);
        }
      }
    } catch (err) {
      result.errors.push(`Fetch error for ${url}: ${String(err)}`);
    }

    done++;
    onProgress(done / tiles.length);
  }

  return result;
}
